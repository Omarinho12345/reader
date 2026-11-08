/**
 * A page for the tests of what runs in a browser: happy-dom's, enough of
 * one to click, type and post messages in, though it lays nothing out.
 * Nothing on it is fetched and none of its <script>s run; a test runs the
 * scripts it's after itself.
 *
 *   page(html)            a page of `html`, a whole document or what goes in its body
 *   file('static/x.html') a page of one of reader's own
 *   app()                 the app's page, with what its <head> runs (theme.js, frames.js, spoken.js, overview.js)
 *   frames(window)        runs frames.js, the frames' origin taken as known (FRAMES), so nothing is asked
 *   run(window, ...files) runs reader's scripts in the page, as its <script>s would
 *   frame(html)           a page in a frame: `posted` is what it sends the page
 *                         around it, `send` sends it something from there,
 *                         from the app's origin (`APP`) unless told another
 *   settle()              the end of the turn, when the edits a page holds go up
 *   preview()             the preview frame as the server serves it, every feature's
 *                         script in it: `show(body)` draws a render, as the app sends one
 *   assertElement(a, b)   that a and b are the same element, and
 *   assertNotElement      that they are not: both fail at once, naming each
 *                         element by its tag, id and classes, where a failing
 *                         assert.equal describes the whole of an element for
 *                         its message and can hang the run on doing so
 *   globals(window)       makes the page this test's own, for the app's modules
 */
import { AssertionError } from 'node:assert';
import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { FEATURES } from '../features/index.js';

const ROOT = new URL('../', import.meta.url);
// A feature names its preview script by its absolute path (features/index.js),
// which on Windows starts with a drive, not a /, and so isn't a URL's path.
const read = (path) => fs.readFileSync(isAbsolute(path) ? path : new URL(path, ROOT), 'utf8');

export function page(html = '', { url = 'http://localhost:8734/' } = {}) {
  const window = new Window({
    url,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
      navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
    },
  });
  if (/^\s*<!doctype/i.test(html)) window.document.write(html);
  else window.document.body.innerHTML = html;
  return window;
}

export const file = (path, opts) => page(read(path), opts);

export const app = (opts) => run(frames(run(file('static/index.html', opts), 'static/theme.js')), 'static/spoken.js', 'static/overview.js');

// Where the preview frames are, by name, for a page at APP.
export const FRAMES = 'http://frames.localhost:8734';

export function frames(window) {
  const meta = Object.assign(window.document.createElement('meta'), { name: 'frames' });
  Object.assign(meta.dataset, { name: FRAMES, port: 'http://localhost:8735' });
  window.document.head.prepend(meta);
  window.sessionStorage.setItem('reader:frames', 'name');
  return run(window, 'static/frames.js');
}

export function run(window, ...files) {
  for (const path of files) vm.runInContext(read(path), window, { filename: path });
  return window;
}

// Once Node's next turn comes, every microtask queued before it has run,
// the page's among them. Taken here, before a test can mock the timers.
const immediately = setImmediate;
export const settle = () => new Promise((resolve) => immediately(resolve));

// The app's origin, as a frame has it from the server (`<meta name="app">`).
export const APP = 'http://localhost:8734';

export function frame(html = '', opts) {
  const window = page(html, opts);
  const app = Object.assign(window.document.createElement('meta'), { name: 'app', content: APP });
  window.document.head.prepend(app);
  const posted = [];
  const parent = { postMessage: (data) => posted.push(structuredClone(data)) };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  const send = (data, { origin = APP } = {}) => window.dispatchEvent(new window.MessageEvent('message', { data, source: parent, origin }));
  return { window, document: window.document, posted, send };
}

export function preview(opts = {}) {
  const f = frame(read('static/preview.html'), { url: 'http://frames.localhost:8734/preview.html', ...opts });
  run(f.window, 'static/preview-api.js', 'static/spoken.js', 'static/tone.js', ...FEATURES.flatMap((x) => [x.preview ?? []].flat()), 'static/ink.js', 'static/preview.js');
  const show = (body, m = {}) => f.send({ type: 'render', css: '', body, ...m });
  return { ...f, show };
}

// What an element is called when an assert names it: its tag, id and
// classes, which is enough to know which element was meant and which was
// had, and quick to say, where describing the element itself is neither.
const describe = (el) => {
  if (!el || typeof el !== 'object' || !el.tagName) return String(el);
  const classes = Array.from(el.classList ?? [], (c) => `.${c}`).join('');
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes}`;
};

export function assertElement(actual, expected, message) {
  if (actual === expected) return;
  throw new AssertionError({
    message: `${message ? `${message}: ` : ''}expected ${describe(expected)}, got ${describe(actual)}`,
    actual: describe(actual),
    expected: describe(expected),
    operator: 'assertElement',
  });
}

export function assertNotElement(actual, expected, message) {
  if (actual !== expected) return;
  throw new AssertionError({
    message: `${message ? `${message}: ` : ''}expected anything but ${describe(expected)}, got it`,
    actual: describe(actual),
    expected: `not ${describe(expected)}`,
    operator: 'assertNotElement',
  });
}

// Node's own are kept: its timers, for one, are what `mock.timers` mocks.
// These are the page's, Node's own being of no use to it.
const PAGE = ['window', 'document', 'location', 'navigator', 'localStorage', 'sessionStorage', 'Event', 'CustomEvent', 'EventTarget', 'MessageEvent'];

export function globals(window) {
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name in globalThis && !PAGE.includes(name)) continue;
    Object.defineProperty(globalThis, name, { get: () => (name === 'window' ? window : window[name]), set: (v) => { window[name] = v; }, configurable: true });
  }
  return window;
}
