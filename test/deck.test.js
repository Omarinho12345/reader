import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { slides } from '../src/slides.js';
import { app, globals, assertElement } from './dom.js';

// deck.js is the app's, for the browser: it's loaded here on the app's page.
const window = globals(app());
const read = (html) => new window.DOMParser().parseFromString(html, 'text/html').body;

const { deck, el, state } = await import('../static/app/state.js');
const { paging, steps, deckKey, go, revealed, showSlide, present, loadDeck, closeDeck, onSpeakerMessage } = await import('../static/app/deck.js');
const { openGoTo } = await import('../static/app/goto.js');
const { wireTheme } = await import('../static/app/theme.js');

/** Each thing a slide's steps show, by the step it shows with: [step, its text]. */
function stepped(body) {
  const out = steps(body);
  const shown = [...read(out.body).querySelectorAll('[data-step]')].map((e) => [Number(e.getAttribute('data-step')), e.textContent.trim().replace(/\s+/g, ' ')]);
  return { steps: out.steps, shown };
}

/** The body of each slide of `src`, as the server sends them. */
const bodies = (src) => slides(src).slides.map((s) => s.body);

test('the count reads as the front matter\'s paging says, or n / total', () => {
  deck.slides = [{}, {}, {}];
  deck.meta = {};
  assert.equal(paging(0), '1 / 3');
  assert.equal(paging(2), '3 / 3');
  deck.meta = { paging: 'Slide %d of %d' };
  assert.equal(paging(1), 'Slide 2 of 3');
  // One %d is the slide; any more after it are the total.
  deck.meta = { paging: '%d' };
  assert.equal(paging(1), '2');
  deck.meta = { paging: '%d/%d (%d)' };
  assert.equal(paging(0), '1/3 (3)');
  // Without a %d it isn't a count, and the usual one stands.
  deck.meta = { paging: 'page' };
  assert.equal(paging(1), '2 / 3');
});

test('? shows the deck\'s keys at its foot, and puts them away again', () => {
  const stage = window.document.getElementById('deck');
  assert.match(stage.querySelector('.deck-keys').textContent, /\? these keys/);
  assert.match(stage.querySelector('.deck-keys').textContent, /Tab the slide's boxes · ⌘\+ ⌘− text size · \? these keys/);
  assert.equal(deckKey({ key: '?' }), true);
  assert.ok(stage.classList.contains('keys-shown'));
  deckKey({ key: '?' });
  assert.ok(!stage.classList.contains('keys-shown'));
});

test('the deck\'s keys show for five seconds as presenting starts', async () => {
  // The clock moves when the test says, and the server has a deck of one slide.
  mock.timers.enable({ apis: ['setTimeout'] });
  Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage() {} }, configurable: true });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ css: '', meta: {}, slides: [{ body: '<h1>One</h1>', notes: '', notesHtml: '', line: 0 }] }) });
  state.current = { path: 'talk.md', type: 'md' };
  el.editor.value = '# One\n';
  await present();
  assert.ok(el.deck.classList.contains('keys-shown'));
  mock.timers.tick(4999);
  assert.ok(el.deck.classList.contains('keys-shown'));
  mock.timers.tick(1);
  assert.ok(!el.deck.classList.contains('keys-shown'));
  closeDeck();
  mock.timers.reset();
});

test('the slides\' text is at 100% each time the deck opens', async () => {
  // The keys shown as it opens would otherwise keep the test waiting five seconds.
  mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage: (m) => asked.push(m) }, configurable: true });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ css: '', meta: {}, slides: [{ body: '<h1>One</h1>', notes: '', notesHtml: '', line: 0 }] }) });
  state.current = { path: 'talk.md', type: 'md' };
  el.editor.value = '# One\n';
  deck.scale = 1.5;
  for (const time of ['first', 'again']) {
    asked.length = 0;
    await present();
    assert.equal(deck.scale, 1, time);
    assert.equal(asked.at(-1).scale, 1, `the slide is drawn at 100%, ${time}`);
    // Left bigger, it's back to 100% when the deck opens again.
    deckKey({ key: '=', metaKey: true });
    closeDeck();
  }
  mock.timers.reset();
});

test('each block is a step, and so is each list item and each column; the title isn\'t', () => {
  const [first, second] = bodies('# Title\n\nA paragraph.\n\n- one\n- two\n\n> a quote\n\n---\n\n::: columns\nleft\n+++\nright\n:::\n');
  assert.deepEqual(stepped(first), { steps: 4, shown: [[1, 'A paragraph.'], [2, 'one'], [3, 'two'], [4, 'a quote']] });
  assert.deepEqual(stepped(second), { steps: 2, shown: [[1, 'left'], [2, 'right']] });
});

test('a slide that\'s only a title has no steps', () => {
  assert.deepEqual(stepped(bodies('# Only a title\n')[0]), { steps: 0, shown: [] });
});

test('an opening heading the server left in place shows with the slide; a later one is a step', () => {
  const body = '<section class="gm-pair"><div class="gm-speaker"><h1>Title</h1><p>a</p><h2>Later</h2></div><div></div></section>';
  assert.deepEqual(stepped(body), { steps: 2, shown: [[1, 'a'], [2, 'Later']] });
  // Not at the opening, a heading is a step like any other block.
  assert.deepEqual(stepped(bodies('First\n\n## A heading\n')[0]).shown, [[1, 'First'], [2, 'A heading']]);
});

test('a fence written {1-3|5} takes a step more for each range after its first', () => {
  const [body] = bodies('# Code\n\n```js {1|2|3}\na\nb\nc\n```\n\nafter\n');
  assert.deepEqual(stepped(body), { steps: 4, shown: [[1, 'a b c'], [4, 'after']] });
});

test('of versions of a fence in tabs, the one that moves through the most sets the steps', () => {
  const [body] = bodies('# Code\n\n::: tabs\n+++ Java\n```java {1|2|3}\na\nb\nc\n```\n+++ Kotlin\n```kotlin {1|2}\na\nb\n```\n:::\n\nafter\n');
  const { steps: n, shown } = stepped(body);
  assert.equal(n, 4);
  assert.deepEqual(shown.map(([k]) => k), [1, 4]);
});

test('an aside appears with the last step of the passage it sits beside', () => {
  const [body] = bodies('# Title\n\nFirst.\n\n- one\n- two\n~ about two\n\nLast.\n');
  const { steps: n, shown } = stepped(body);
  assert.equal(n, 4);
  assert.deepEqual(shown.find(([, text]) => text.includes('about two')), [3, '~about two']);
});

test('an aside beside a passage with no steps of its own gets none', () => {
  const body = '<header class="slide-title"><h1>T</h1></header><section class="gm-pair"><div class="gm-speaker"></div><div class="gm-asides"><p>aside</p></div></section>';
  assert.deepEqual(stepped(body), { steps: 0, shown: [] });
});

test('the deck says what each step showed after where it is, and only where it is going back', async () => {
  // The stage is asked what to say, and says it back as `says` would.
  const asked = [];
  Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage: (m) => asked.push(m) }, configurable: true });
  state.current = { path: 'talk.md', type: 'md' };
  Object.assign(deck, { open: true, stageReady: null, meta: {}, css: '', index: 0, reveal: 0, notes: false, channel: null });
  deck.slides = [{ body: '', steps: 3, notesHtml: '' }, { body: '', steps: 0, notesHtml: '' }];
  const said = async (move, says) => {
    asked.length = 0;
    move();
    await deck.stageReady;
    await null;
    const { say } = asked.at(-1);
    if (say) revealed({ ...say, says: says(say) });
    return el.deckSays.textContent;
  };
  assert.equal(await said(() => go(0, 1), (s) => (s.from === 0 ? 'the first point' : '?')), 'Slide 1 of 2, step 1 of 3: the first point');
  assert.equal(await said(() => go(0, 3), (s) => (s.from === 1 ? 'the second point Thoughts: blank' : '?')), 'Slide 1 of 2, step 3 of 3: the second point Thoughts: blank');
  assert.equal(await said(() => go(1, 0), (s) => (s.title ? 'Two' : '?')), 'Slide 2 of 2: Two');
  assert.equal(await said(() => go(0, 3), (s) => (s.title ? 'One' : '?')), 'Slide 1 of 2, step 3 of 3: One');
  assert.equal(await said(() => go(0, 2), () => '?'), 'Slide 1 of 2, step 2 of 3');
  // What the stage says of a step the deck has since moved on from isn't said.
  revealed({ index: 0, reveal: 3, says: 'late' });
  assert.equal(el.deckSays.textContent, 'Slide 1 of 2, step 2 of 3');
  deck.open = false;
});

test('a slide come to whole says its title and what shows, and one gone back onto only its title', async () => {
  const asked = [];
  Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage: (m) => asked.push(m) }, configurable: true });
  state.current = { path: 'talk.md', type: 'md' };
  Object.assign(deck, { open: true, stageReady: null, meta: {}, css: '', index: 0, reveal: 0, notes: false, channel: null });
  deck.slides = [{ body: '', steps: 1, notesHtml: '' }, { body: '', steps: 2, notesHtml: '' }, { body: '', steps: 0, notesHtml: '' }];
  const asks = async (move) => {
    asked.length = 0;
    move();
    await deck.stageReady;
    await null;
    const { title, from } = asked.at(-1).say;
    return from == null ? { title } : { title, from };
  };
  // N onto the next slide, or End.
  assert.deepEqual(await asks(() => go(1, Infinity)), { title: true, from: 0 });
  revealed({ ...asked.at(-1).say, says: 'Two. the first point the second point' });
  assert.equal(el.deckSays.textContent, 'Slide 2 of 3, step 2 of 2: Two. the first point the second point');
  // p back onto a slide, as before.
  assert.deepEqual(await asks(() => go(0, Infinity)), { title: true });
  // N onto a slide with no steps: nothing shows but its title.
  assert.deepEqual(await asks(() => go(2, Infinity)), { title: true });
  // n onto a slide: none of it showing yet.
  deck.index = 0;
  assert.deepEqual(await asks(() => go(1, 0)), { title: true });
  deck.open = false;
});

test('⌘+ and ⌘− step the slides\' text through the browser\'s steps, ⌘0 puts it back, and each says only the size', async () => {
  const asked = [];
  const told = [];
  Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage: (m) => asked.push(m) }, configurable: true });
  state.current = { path: 'talk.md', type: 'md' };
  Object.assign(deck, { open: true, stageReady: null, meta: {}, css: '', index: 0, reveal: 1, scale: 1, notes: false, channel: { postMessage: (m) => told.push(m) } });
  deck.slides = [{ body: '', steps: 3, notesHtml: '' }];
  const press = (key, keys = { metaKey: true }) => {
    asked.length = told.length = 0;
    assert.equal(deckKey({ key, ...keys }), true, `${key} is the deck's`);
    return el.deckSays.textContent;
  };
  assert.equal(press('='), 'Text 110%');
  assert.equal(press('+', { metaKey: true, shiftKey: true }), 'Text 125%');
  assert.equal(press('=', { ctrlKey: true }), 'Text 150%');
  // The stage and the speaker view are told, and the slide stays at its step.
  assert.deepEqual(asked, [{ type: 'reveal', reveal: 1, scale: 1.5 }]);
  assert.deepEqual(told, [{ type: 'scale', scale: 1.5 }]);
  press('=');
  press('=');
  assert.equal(press('='), 'Text 200%', 'no bigger than 200%');
  assert.equal(press('0'), 'Text 100%');
  for (let i = 0; i < 4; i++) press('-');
  assert.equal(press('-'), 'Text 50%');
  assert.equal(press('-'), 'Text 50%', 'no smaller than 50%');
  // A slide drawn afresh is drawn at the size it came to.
  await showSlide();
  assert.equal(asked.at(-1).type, 'render');
  assert.equal(asked.at(-1).scale, 0.5);
  // Without ⌘, - and 0 aren't the deck's; with ⌥, nor is ⌘=.
  assert.equal(deckKey({ key: '-' }), false);
  assert.equal(deckKey({ key: '=', metaKey: true, altKey: true }), false);
  assert.equal(deck.scale, 0.5);
  deck.open = false;
  deck.channel = null;
});

/** A deck of `n` slides open on slide `index`, the stage's messages in `asked`. */
function presenting(n, { index = 0, reveal = 0, meta = {} } = {}) {
  const asked = [];
  Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage: (m) => asked.push(m) }, configurable: true });
  state.current = { path: 'talk.md', type: 'md' };
  Object.assign(deck, { open: true, stageReady: null, meta, css: '', index, reveal, scale: 1, notes: false, channel: null });
  deck.slides = Array.from({ length: n }, (_, i) => ({ body: `<h1>S${i + 1}</h1>`, steps: 2, notesHtml: '', title: `Title ${i + 1}` }));
  el.deck.hidden = false;
  el.deck.focus();
  return asked;
}

const options = () => [...el.overview.querySelectorAll('[role="option"]')];

test('a reload refreshes the open overview, preserving its highlight separately from the current slide', async () => {
  presenting(4, { index: 1 });
  deckKey({ key: 'O' });
  deckKey({ key: 'ArrowRight' });
  assert.equal(window.document.activeElement, options()[2]);

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      css: '',
      meta: {},
      slides: Array.from({ length: 5 }, (_, i) => ({
        body: `<h1>Reloaded ${i + 1}</h1>`,
        notes: '',
        notesHtml: '',
        line: i,
      })),
    }),
  });

  assert.equal(await loadDeck(), true);
  assert.equal(options().length, 5);
  assert.equal(options()[1].classList.contains('now'), true);
  assert.equal(options()[1].getAttribute('aria-current'), 'true');
  assert.equal(options()[2].getAttribute('aria-selected'), 'true');
  assert.equal(window.document.activeElement, options()[2]);
  assert.equal(options()[2].classList.contains('now'), false);
  deckKey({ key: 'Escape' });
  deck.open = false;
});

test('a reload clamps an overview highlight when its slide is removed', async () => {
  presenting(5, { index: 1 });
  deckKey({ key: 'O' });
  deckKey({ key: 'End' });
  assert.equal(window.document.activeElement, options()[4]);

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      css: '',
      meta: {},
      slides: Array.from({ length: 3 }, (_, i) => ({
        body: `<h1>Shortened ${i + 1}</h1>`,
        notes: '',
        notesHtml: '',
        line: i,
      })),
    }),
  });

  assert.equal(await loadDeck(), true);
  assert.equal(options().length, 3);
  assert.equal(window.document.activeElement, options()[2]);
  assert.equal(options()[2].getAttribute('aria-selected'), 'true');
  assert.equal(options()[1].classList.contains('now'), true);
  deckKey({ key: 'Escape' });
  deck.open = false;
});


test('Ctrl+G closes the overview before opening Go To', () => {
  state.current = { path: 'talk.md', type: 'md' };
  el.editor.value = '# A talk\\n';
  presenting(3, { index: 1 });
  deckKey({ key: 'O' });
  assert.equal(el.overview.hidden, false);

  openGoTo();

  assert.equal(el.overview.hidden, true);
  assert.equal(el.goto.hidden, false);
  assert.equal(window.document.activeElement, el.gotoInput);
  el.goto.hidden = true;
  deck.open = false;
});

test('a theme change redraws the slide with the new theme', async () => {
  const originalTheme = window.Theme;
  let listener;
  let chosen = 'light';
  let dark = false;
  window.Theme = {
    chosen: () => chosen,
    dark: () => dark,
    onChange: (fn) => { listener = fn; },
  };
  const radios = [...el.theme.querySelectorAll('input[type=radio]')];
  wireTheme();
  assert.equal(radios.find((radio) => radio.value === 'light').checked, true);

  const asked = presenting(1);
  state.current = { path: 'talk.md', type: 'other' };
  chosen = 'dark';
  dark = true;
  listener(true, 'dark');
  await deck.stageReady;
  await null;

  assert.equal(radios.find((radio) => radio.value === 'dark').checked, true);
  assert.equal(asked.at(-1).dark, true);
  deck.open = false;
  window.Theme = originalTheme;
});

test('the overview\'s keys are among the deck\'s at its foot', () => {
  assert.match(el.deck.querySelector('.deck-keys').textContent, /P slide start · O overview · T notes/);
});

test('O lays out every slide, numbered as paging says, the one showing highlighted, and says so', () => {
  presenting(12, { index: 2, meta: { paging: 'Slide %d / %d' } });
  assert.equal(deckKey({ key: 'O' }), true);
  assert.ok(!el.overview.hidden);
  assert.equal(options().length, 12);
  // Its keys are heard with it.
  const list = el.overview.querySelector('[role="listbox"]');
  assert.equal(window.document.getElementById(list.getAttribute('aria-describedby'))?.textContent, 'Arrows move · Enter goes to the slide, from its start · Esc back');
  assert.deepEqual(options().slice(0, 2).map((o) => o.querySelector('.overview-number').textContent), ['Slide 1 / 12', 'Slide 2 / 12']);
  // Its title on hover, and as its name.
  assert.equal(options()[0].title, 'Title 1');
  assert.equal(options()[0].getAttribute('aria-label'), 'Slide 1 of 12: Title 1');
  const now = options()[2];
  assert.ok(now.classList.contains('now'));
  assert.equal(now.getAttribute('aria-current'), 'true');
  assert.equal(now.getAttribute('aria-label'), 'Slide 3 of 12: Title 3 (now)');
  // The keyboard is on it, the only one in reach (a roving tabindex).
  assertElement(window.document.activeElement, now, 'the slide showing has the keyboard');
  assert.deepEqual(options().map((o) => o.tabIndex).filter((t) => t === 0), [0]);
  assert.equal(now.getAttribute('aria-selected'), 'true');
  // It says it's out; the slide with the keyboard says itself, by its name.
  assert.equal(el.deckSays.textContent, 'Overview');
  // The rest of the deck is out of reach under it; what it says isn't.
  assert.ok(el.stage.inert && el.deckNotes.inert && el.deckFoot.inert);
  assert.equal(el.deckSays.closest('[inert]'), null);
  deckKey({ key: 'Escape' });
  deck.open = false;
});

test('the arrows, Home and End move the highlight, each slide come to heard by its name and only so; nothing else moves', () => {
  const asked = presenting(12, { index: 2 });
  deckKey({ key: 'o' });
  // Laid out four to a row.
  options().forEach((o, i) => Object.defineProperty(o, 'offsetTop', { value: Math.floor(i / 4) * 100, configurable: true }));
  const at = () => options().findIndex((o) => o === window.document.activeElement);
  deckKey({ key: 'ArrowRight' });
  assert.equal(at(), 3);
  assert.equal(window.document.activeElement.getAttribute('aria-label'), 'Slide 4 of 12: Title 4');
  // Not said again in the live region.
  assert.equal(el.deckSays.textContent, 'Overview');
  deckKey({ key: 'ArrowDown' });
  assert.equal(at(), 7);
  deckKey({ key: 'ArrowLeft' });
  deckKey({ key: 'ArrowUp' });
  assert.equal(at(), 2);
  deckKey({ key: 'ArrowUp' });
  assert.equal(at(), 2, 'no row above the first');
  deckKey({ key: 'End' });
  assert.equal(at(), 11);
  assert.equal(el.deckSays.textContent, 'Overview');
  deckKey({ key: 'Home' });
  assert.equal(at(), 0);
  assert.equal(options()[0].tabIndex, 0);
  assert.equal(options()[2].tabIndex, -1);
  assert.equal(options()[0].getAttribute('aria-selected'), 'true');
  assert.ok(options()[2].classList.contains('now'), 'the slide showing stays marked');
  // The deck stays where it was underneath.
  deckKey({ key: 'n' });
  assert.deepEqual([deck.index, deck.reveal, asked.length], [2, 0, 0]);
  deckKey({ key: 'Escape' });
  deck.open = false;
});

test('Enter goes to the highlighted slide from its start, and gives the keyboard back to the deck', async () => {
  const asked = presenting(12, { index: 2, reveal: 1 });
  deckKey({ key: 'O' });
  deckKey({ key: 'ArrowRight' });
  deckKey({ key: 'ArrowRight' });
  assert.equal(deckKey({ key: 'Enter' }), true);
  assert.ok(el.overview.hidden);
  assert.deepEqual([deck.index, deck.reveal], [4, 0]);
  await deck.stageReady;
  await null;
  assert.equal(asked.at(-1).type, 'render');
  assert.equal(asked.at(-1).body, '<h1>S5</h1>');
  assert.equal(asked.at(-1).reveal, 0);
  assertElement(window.document.activeElement, el.deck, 'the deck has the keyboard');
  assert.ok(!el.stage.inert && !el.deckNotes.inert && !el.deckFoot.inert);
  // Only where it went is said, once the stage says what showed; not where it was.
  assert.notEqual(el.deckSays.textContent, 'Slide 3 of 12, step 1 of 2');
  assert.deepEqual(asked.at(-1).say, { title: true, index: 4, reveal: 0 });
  revealed({ ...asked.at(-1).say, says: 'Title 5' });
  assert.equal(el.deckSays.textContent, 'Slide 5 of 12: Title 5');
  // The slide showing, picked, starts over.
  deckKey({ key: 'n' });
  deckKey({ key: 'O' });
  deckKey({ key: 'Enter' });
  assert.deepEqual([deck.index, deck.reveal], [4, 0]);
  // Picked at its start, it goes nowhere, and says so as a slide come to.
  deckKey({ key: 'O' });
  asked.length = 0;
  deckKey({ key: 'Enter' });
  await deck.stageReady;
  await null;
  assert.deepEqual([asked.at(-1).type, asked.at(-1).say], ['reveal', { title: true, index: 4, reveal: 0 }]);
  revealed({ ...asked.at(-1).say, says: 'Title 5' });
  assert.equal(el.deckSays.textContent, 'Slide 5 of 12: Title 5');
  deck.open = false;
});

test('Space goes to the highlighted slide from its start, as Enter does', async () => {
  const asked = presenting(12, { index: 2, reveal: 1 });
  deckKey({ key: 'O' });
  deckKey({ key: 'ArrowRight' });
  deckKey({ key: 'ArrowRight' });
  assert.equal(deckKey({ key: ' ' }), true);
  assert.ok(el.overview.hidden);
  assert.deepEqual([deck.index, deck.reveal], [4, 0]);
  await deck.stageReady;
  await null;
  assert.equal(asked.at(-1).type, 'render');
  assert.equal(asked.at(-1).body, '<h1>S5</h1>');
  assert.equal(asked.at(-1).reveal, 0);
  assertElement(window.document.activeElement, el.deck, 'the deck has the keyboard');
  assert.ok(!el.stage.inert && !el.deckNotes.inert && !el.deckFoot.inert);
  deck.open = false;
});

test('Tab is the overview\'s while it is out: the highlight keeps the keyboard and the deck stays where it was', () => {
  const asked = presenting(12, { index: 2, reveal: 1 });
  deckKey({ key: 'O' });
  deckKey({ key: 'ArrowRight' });
  const at = options()[3];
  assertElement(window.document.activeElement, at, 'the highlight has the keyboard');
  assert.equal(deckKey({ key: 'Tab' }), true);
  assert.equal(deckKey({ key: 'Tab', shiftKey: true }), true);
  assert.ok(!el.overview.hidden, 'the overview is still out');
  assertElement(window.document.activeElement, at, 'the highlight keeps the keyboard');
  assert.deepEqual([deck.index, deck.reveal, asked.length], [2, 1, 0]);
  deckKey({ key: 'Escape' });
  deck.open = false;
});

test('the speaker view moving the deck with the overview out rings the slide it went to, and the overview keeps the say', async () => {
  const asked = presenting(12, { index: 1, reveal: 1 });
  deckKey({ key: 'O' });
  deckKey({ key: 'ArrowRight' });
  onSpeakerMessage({ data: { type: 'go', index: 5, reveal: 0 } });
  await deck.stageReady;
  await null;
  const ringed = options().filter((o) => o.classList.contains('now'));
  assert.deepEqual(ringed.map((o) => o.dataset.index), ['5']);
  assert.equal(options()[5].getAttribute('aria-current'), 'true');
  assert.equal(options()[5].getAttribute('aria-label'), 'Slide 6 of 12: Title 6 (now)');
  assert.equal(options()[1].getAttribute('aria-label'), 'Slide 2 of 12: Title 2');
  // The highlight stays where it was, and the stage's word on the slide isn't said over the overview.
  assertElement(window.document.activeElement, options()[2], 'the highlight keeps the keyboard');
  revealed({ ...asked.at(-1).say, says: 'Title 6' });
  // Its keys move the deck too, not the room's highlight.
  onSpeakerMessage({ data: { type: 'key', key: 'ArrowRight' } });
  assert.deepEqual([deck.index, deck.reveal], [5, 1]);
  assertElement(window.document.activeElement, options()[2], 'the highlight stays put');
  revealed({ index: 5, reveal: 1, says: 'a point' });
  assert.equal(el.deckSays.textContent, 'Overview');
  deckKey({ key: 'Escape' });
  assert.equal(el.deckSays.textContent, 'Slide 6 of 12, step 1 of 2');
  deck.open = false;
});

test('a click on a thumbnail goes to that slide from its start', () => {
  presenting(12, { index: 0 });
  deckKey({ key: 'O' });
  options()[6].click();
  assert.ok(el.overview.hidden);
  assert.deepEqual([deck.index, deck.reveal], [6, 0]);
  deck.open = false;
});

test('Esc puts the overview away and the deck is where it was, and says so', () => {
  const asked = presenting(12, { index: 3, reveal: 1 });
  deckKey({ key: 'O' });
  deckKey({ key: 'ArrowRight' });
  assert.equal(deckKey({ key: 'Escape' }), true);
  assert.ok(el.overview.hidden);
  assert.equal(options().length, 0);
  assert.deepEqual([deck.index, deck.reveal, asked.length], [3, 1, 0]);
  assertElement(window.document.activeElement, el.deck, 'the deck has the keyboard');
  assert.equal(el.deckSays.textContent, 'Slide 4 of 12, step 1 of 2');
  // Esc again is the deck's own: done presenting.
  deckKey({ key: 'Escape' });
  assert.equal(deck.open, false);
});

test('a thumbnail is drawn as it comes into view, the slide whole, at the deck\'s text size and fit', () => {
  // What comes into view is what the test says.
  let seen = null;
  const IO = window.IntersectionObserver;
  window.IntersectionObserver = class {
    constructor(fn) { seen = (targets) => fn(targets.map((target) => ({ target, isIntersecting: true }))); }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  presenting(30, { index: 0 });
  deck.scale = 1.25;
  deckKey({ key: 'O' });
  assert.equal(el.overview.querySelectorAll('iframe').length, 0, 'none drawn till they\'re seen');
  seen(options().slice(0, 2));
  assert.equal(el.overview.querySelectorAll('iframe').length, 2);
  const frame = options()[1].querySelector('iframe');
  assert.equal(frame.getAttribute('aria-hidden'), 'true');
  assert.equal(frame.tabIndex, -1);
  const drawn = [];
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (m) => drawn.push(m) }, configurable: true });
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'ready' }, source: frame.contentWindow }));
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].body, '<h1>S2</h1>');
  assert.equal(drawn[0].reveal, Infinity);
  assert.equal(drawn[0].scale, 1.25);
  assert.equal(drawn[0].deck, true);
  deckKey({ key: 'Escape' });
  deck.open = false;
  window.IntersectionObserver = IO;
});

test('⌘+, ⌘− and ⌘0 size the slides\' text with the overview out, and its thumbnails are drawn again at the new size', () => {
  const IO = window.IntersectionObserver;
  let seen = null;
  window.IntersectionObserver = class {
    constructor(fn) { seen = (targets) => fn(targets.map((target) => ({ target, isIntersecting: true }))); }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const asked = presenting(4, { index: 1 });
  deckKey({ key: 'O' });
  seen(options().slice(0, 2));
  const drawn = [];
  const frame = options()[0].querySelector('iframe');
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (m) => drawn.push(m) }, configurable: true });
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'ready' }, source: frame.contentWindow }));
  // One drawn, one still loading.
  Object.defineProperty(options()[1].querySelector('iframe'), 'contentWindow', { value: { postMessage: () => assert.fail('not ready') }, configurable: true });
  assert.equal(deckKey({ key: '=', metaKey: true }), true, '⌘= is the deck\'s');
  assert.equal(deck.scale, 1.1);
  assert.equal(el.deckSays.textContent, 'Text 110%');
  assert.deepEqual(asked.at(-1), { type: 'reveal', reveal: 0, scale: 1.1 });
  assert.deepEqual([drawn.length, drawn.at(-1).body, drawn.at(-1).scale], [2, '<h1>S1</h1>', 1.1]);
  deckKey({ key: '0', ctrlKey: true });
  assert.equal(drawn.at(-1).scale, 1);
  // The overview is still out, with the keyboard where it was.
  assert.ok(!el.overview.hidden);
  assertElement(window.document.activeElement, options()[1], 'the highlight keeps the keyboard');
  deckKey({ key: 'Escape' });
  deck.open = false;
  window.IntersectionObserver = IO;
});

test('a slide\'s title is its opening heading, as the stage says it', () => {
  const [one, two, three] = bodies('# One *more*\n\nhi\n\n---\n\nno heading\n\n---\n\n## Two\n');
  assert.equal(steps(one).title, 'One more');
  assert.equal(steps(two).title, '');
  assert.equal(steps(three).title, 'Two');
});

test("the stage is sent the deck's title, so the frame is titled with it", async () => {
  const sent = [];
  Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage: (m) => sent.push(m) }, configurable: true });
  state.current = { path: 'talk.md', type: 'md' };
  Object.assign(deck, { open: true, stageReady: null, meta: {}, css: '', index: 0, reveal: 0, notes: false, channel: null, title: 'talk' });
  deck.slides = [{ body: '<p>one</p>', steps: 0, notesHtml: '' }];
  await showSlide();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'talk');
  deck.open = false;
});
