import { test } from 'node:test';
import assert from 'node:assert/strict';
import { file, frames, run, assertElement } from './dom.js';

/**
 * The speaker view, loaded as speaker.html loads it, on a clock that reads
 * `now.seconds`: `say` sends it a message from the deck, as the
 * BroadcastChannel would, and `sent` is what it sends the deck.
 */
function speaker() {
  const now = { seconds: 0 };
  const sent = [];
  let heard = null;
  const window = file('static/speaker.html');
  Object.assign(window, {
    BroadcastChannel: class {
      addEventListener(type, fn) { heard = fn; }
      postMessage(m) { sent.push({ ...m }); }
    },
    Date: class {
      static now() { return now.seconds * 1000; }
      toLocaleTimeString() { return '9:00'; }
    },
    setInterval() {},
  });
  run(frames(run(window, 'static/theme.js')), 'static/overview.js', 'static/speaker.js');
  const $ = (id) => window.document.getElementById(id);
  const press = (key) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { now, $, sent, press, window, clock: window.clock, say: (data) => heard({ data }) };
}

test('the waiting message makes the speaker sections inert until a deck opens', () => {
  const { $, say } = speaker();
  const timerIsInert = () => $('timer').closest('[inert]') !== null;

  assert.equal(timerIsInert(), true);
  say({ type: 'deck', open: true, index: 0, reveal: 0, slides: [{}], meta: {} });
  assert.equal(timerIsInert(), false);
  say({ type: 'end' });
  assert.equal(timerIsInert(), true);
});

test('the timer reads minutes and seconds, and hours once there are some', () => {
  const { clock } = speaker();
  assert.equal(clock(0), '0:00');
  assert.equal(clock(5), '0:05');
  assert.equal(clock(59.6), '1:00');
  assert.equal(clock(754), '12:34');
  assert.equal(clock(3600), '1:00:00');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(36000 + 59), '10:00:59');
});

test('the timer starts when the deck opens on its first slide, and counts from there', () => {
  const { now, $, say } = speaker();
  now.seconds = 1000;
  say({ type: 'deck', open: true, index: 0, reveal: 0, slides: [{}, {}], meta: {} });
  now.seconds = 1075;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal($('timer').textContent, '1:15');
  // Picked up on a later slide, it's the same talk.
  say({ type: 'deck', open: false, index: 1, reveal: 0, slides: [{}, {}], meta: {} });
  say({ type: 'deck', open: true, index: 1, reveal: 0, slides: [{}, {}], meta: {} });
  now.seconds = 1080;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal($('timer').textContent, '1:20');
});

// Three slides planned to start at 0:00 (a checkpoint), 2:00 and 5:00,
// the talk to end at 6:00.
const PLANNED = [{ plan: 0, at: 0 }, { plan: 120 }, { plan: 300 }];

/** What the pace says on slide `index` at `seconds` into the talk. */
function paced(slides, index, seconds, end = null) {
  const { now, $, say } = speaker();
  say({ type: 'deck', open: true, index: 0, reveal: 0, slides, meta: {}, end });
  now.seconds = seconds;
  say({ type: 'go', index, reveal: 0 });
  const pace = $('pace');
  return pace.hidden ? null : { state: pace.className, says: pace.textContent };
}

test('on a slide between its start and the next one\'s, give or take half a minute, the talk is on plan', () => {
  assert.deepEqual(paced(PLANNED, 0, 10, 360), { state: 'pace on', says: 'on plan · checkpoint 0:00–2:00' });
  assert.deepEqual(paced(PLANNED, 1, 90, 360), { state: 'pace on', says: 'on plan · plan 2:00–5:00' });
  assert.deepEqual(paced(PLANNED, 1, 330, 360), { state: 'pace on', says: 'on plan · plan 2:00–5:00' });
});

test('before a slide\'s start it\'s ahead, and after the next one\'s behind, then late two minutes on', () => {
  assert.deepEqual(paced(PLANNED, 1, 89, 360), { state: 'pace ahead', says: '0:31 ahead · plan 2:00–5:00' });
  assert.deepEqual(paced(PLANNED, 1, 331, 360), { state: 'pace behind', says: '0:31 behind · plan 2:00–5:00' });
  assert.deepEqual(paced(PLANNED, 1, 420, 360), { state: 'pace behind', says: '2:00 behind · plan 2:00–5:00' });
  assert.deepEqual(paced(PLANNED, 1, 421, 360), { state: 'pace late', says: '2:01 behind · plan 2:00–5:00' });
});

test('the last slide runs to the talk\'s end, or, with none, is never behind', () => {
  assert.deepEqual(paced(PLANNED, 2, 400, 360), { state: 'pace behind', says: '0:40 behind · plan 5:00–6:00' });
  assert.deepEqual(paced(PLANNED, 2, 4000), { state: 'pace on', says: 'on plan · plan 5:00' });
});

test('a slide with no plan has no pace, and one planned no later than the next shows only its start', () => {
  assert.equal(paced([{}, {}], 0, 10), null);
  assert.equal(paced([{ plan: 0 }, {}], 1, 10), null);
  assert.deepEqual(paced([{ plan: 60, at: 60 }, { plan: 60 }], 0, 70), { state: 'pace on', says: 'on plan · checkpoint 1:00' });
});

test('the timer restarts from the keyboard: R anywhere, or Enter on the timer itself', () => {
  const { now, $, say } = speaker();
  const window = $('timer').ownerDocument.defaultView;
  say({ type: 'deck', open: true, index: 0, reveal: 0, slides: [{}, {}], meta: {} });
  now.seconds = 75;
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'r' }));
  now.seconds = 80;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal($('timer').textContent, '0:05');
  assert.equal($('timer').tagName, 'BUTTON');
  // Enter on it is its own, and doesn't move the deck too.
  const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  $('timer').dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
});

test('the pace is said aloud when it changes, not as it counts', () => {
  const { now, $, say } = speaker();
  const heard = () => $('pace-heard').textContent;
  say({ type: 'deck', open: true, index: 0, reveal: 0, slides: PLANNED, meta: {}, end: 360 });
  now.seconds = 10;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal(heard(), '1:50 ahead of plan');
  now.seconds = 20;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal(heard(), '1:50 ahead of plan');
  now.seconds = 200;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal(heard(), 'On plan');
  now.seconds = 400;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal(heard(), '1:40 behind plan');
  now.seconds = 500;
  say({ type: 'go', index: 1, reveal: 0 });
  assert.equal(heard(), '3:20 behind plan');
  assert.equal($('pace-heard').getAttribute('role'), 'status');
});

test('the speaker view\'s Now and Next are at the room\'s text size', async () => {
  const { $, say } = speaker();
  const window = $('now').ownerDocument.defaultView;
  const sent = { now: [], next: [] };
  for (const name of ['now', 'next']) {
    const frame = { postMessage: (m) => sent[name].push(m) };
    Object.defineProperty($(name), 'contentWindow', { value: frame, configurable: true });
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'ready' }, source: frame }));
  }
  say({ type: 'deck', open: true, index: 0, reveal: 0, scale: 1.25, slides: [{ body: 'a' }, { body: 'b' }], meta: {} });
  await new Promise((done) => setTimeout(done));
  assert.deepEqual([sent.now.at(-1).type, sent.now.at(-1).scale], ['render', 1.25]);
  assert.deepEqual([sent.next.at(-1).type, sent.next.at(-1).scale], ['render', 1.25]);
  say({ type: 'scale', scale: 1.5 });
  await new Promise((done) => setTimeout(done));
  assert.deepEqual([sent.now.at(-1).type, sent.now.at(-1).scale], ['reveal', 1.5]);
  assert.deepEqual([sent.next.at(-1).type, sent.next.at(-1).scale], ['reveal', 1.5]);
});

test('the speaker view\'s Now and Next are slides as the stage draws them, and Now says how much the slide shrank', async () => {
  const { $, say } = speaker();
  const window = $('now').ownerDocument.defaultView;
  const sent = { now: [], next: [] };
  const frames = {};
  for (const name of ['now', 'next']) {
    frames[name] = { postMessage: (m) => sent[name].push(m) };
    Object.defineProperty($(name), 'contentWindow', { value: frames[name], configurable: true });
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'ready' }, source: frames[name] }));
  }
  say({ type: 'deck', open: true, index: 0, reveal: 1, slides: [{ body: 'a', steps: 2 }, { body: 'b' }], meta: {} });
  await new Promise((done) => setTimeout(done));
  const now = sent.now.at(-1);
  const next = sent.next.at(-1);
  // Fitted as the room's are, Now with its later steps faint, and neither
  // saying anything aloud: that's the stage's.
  assert.deepEqual([now.type, now.deck, now.reveal, now.dim, 'say' in now], ['render', true, 1, true, false]);
  assert.deepEqual([next.type, next.deck, next.reveal, next.dim, 'say' in next], ['render', true, Infinity, false, false]);
  const fit = (source, zoom, fits) => window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'fit', zoom, fits }, source }));
  assert.ok($('fit').hidden);
  fit(frames.now, 0.8, true);
  assert.deepEqual([$('fit').hidden, $('fit').textContent], [false, 'shrunk to 80%']);
  fit(frames.now, 0.6, false);
  assert.deepEqual([$('fit').hidden, $('fit').textContent, $('fit').classList.contains('over')], [false, "doesn't fit; scrolls", true]);
  fit(frames.now, 1.5, true);
  assert.ok($('fit').hidden, 'a slide grown to fill has nothing to say');
  // Next's own fit isn't the slide on stage.
  fit(frames.next, 0.7, true);
  assert.ok($('fit').hidden);
});

test('O lays out every slide here, those done apart from those to come, and Enter has the deck go to one from its start', () => {
  const { $, sent, press, window, say } = speaker();
  const slides = Array.from({ length: 6 }, (_, i) => ({ body: '', steps: 1, title: `Title ${i + 1}` }));
  say({ type: 'deck', open: true, index: 2, reveal: 1, slides, meta: { paging: '%d' } });
  $('timer').focus();
  press('O');
  const options = [...$('overview').querySelectorAll('[role="option"]')];
  assert.ok(!$('overview').hidden);
  assert.equal(options.length, 6);
  assert.equal(options[0].querySelector('.overview-number').textContent, '1');
  assert.deepEqual(options.map((o) => (o.classList.contains('done') ? 'done' : o.classList.contains('now') ? 'now' : '')), ['done', 'done', 'now', '', '', '']);
  assert.equal(options[0].getAttribute('aria-label'), 'Slide 1 of 6: Title 1 (done)');
  assert.equal(options[3].getAttribute('aria-label'), 'Slide 4 of 6: Title 4');
  assertElement(window.document.activeElement, options[2], 'the slide showing has the keyboard');
  assert.equal($('overview-heard').textContent, 'Overview');
  assert.ok($('speaker').inert, 'the rest is out of reach');
  // The keys are its: they don't move the deck.
  press('ArrowRight');
  assertElement(window.document.activeElement, options[3], 'the slide come to has the keyboard, heard by its name');
  assert.equal($('overview-heard').textContent, 'Overview');
  assert.deepEqual(sent.filter((m) => m.type === 'key'), []);
  // The deck moving on marks the slides afresh.
  say({ type: 'go', index: 3, reveal: 0 });
  assert.ok(options[2].classList.contains('done') && options[3].classList.contains('now'));
  press('ArrowRight');
  press('Enter');
  assert.ok($('overview').hidden);
  assert.deepEqual(sent.at(-1), { type: 'go', index: 4, reveal: 0 });
  assert.equal($('overview-heard').textContent, 'Slide 5 of 6: Title 5', 'where the deck went is said');
  assert.ok(!$('speaker').inert);
  assertElement(window.document.activeElement, $('timer'), 'the keyboard is back where it was');
});

test('the overview\'s thumbnails here are drawn again at the room\'s new text size', () => {
  const { $, press, window, say } = speaker();
  say({ type: 'deck', open: true, index: 0, reveal: 0, scale: 1, slides: [{ body: 'a' }, { body: 'b' }], meta: {} });
  // Every thumbnail in view.
  window.IntersectionObserver = class {
    constructor(fn) { this.fn = fn; }
    observe(target) { this.fn([{ target, isIntersecting: true }]); }
    unobserve() {}
    disconnect() {}
  };
  press('O');
  const frame = $('overview').querySelector('iframe');
  const drawn = [];
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (m) => drawn.push(m) }, configurable: true });
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'ready' }, source: frame.contentWindow }));
  say({ type: 'scale', scale: 1.5 });
  assert.deepEqual([drawn.length, drawn.at(-1).body, drawn.at(-1).scale], [2, 'a', 1.5]);
});

test('Esc puts the overview away here, the deck where it was, and says so', () => {
  const { $, sent, press, say } = speaker();
  say({ type: 'deck', open: true, index: 0, reveal: 1, slides: [{ body: '', steps: 2 }, { body: '' }], meta: {} });
  press('o');
  press('ArrowRight');
  press('Escape');
  assert.ok($('overview').hidden);
  assert.deepEqual(sent.filter((m) => m.type === 'go'), []);
  assert.equal($('overview-heard').textContent, 'Slide 1 of 2, step 1 of 2', 'where the deck still is is said');
  // With no deck open, there's nothing to lay out.
  say({ type: 'end' });
  press('o');
  assert.ok($('overview').hidden);
});

test('a deck sent afresh puts the overview here away, as its slides may not be the ones laid out', () => {
  const { $, press, say } = speaker();
  const slides = [{ body: '' }, { body: '' }, { body: '' }];
  say({ type: 'deck', open: true, index: 1, reveal: 0, slides, meta: {} });
  press('O');
  assert.ok(!$('overview').hidden);
  say({ type: 'deck', open: true, index: 0, reveal: 0, slides: slides.slice(1), meta: {} });
  assert.ok($('overview').hidden);
  assert.ok(!$('speaker').inert, 'the rest is in reach again');
});

test("both frames are sent the deck's title", async () => {
  const window = file('static/speaker.html');
  let heard = null;
  window.BroadcastChannel = class {
    addEventListener(type, fn) { heard = fn; }
    postMessage() {}
  };
  window.setInterval = () => {};
  // happy-dom leaves an iframe's contentWindow null, so each frame is stood
  // in for: what's posted to it lands in `sent`.
  const sent = { now: [], next: [] };
  for (const name of ['now', 'next']) {
    const contentWindow = { postMessage: (m) => sent[name].push(m) };
    Object.defineProperty(window.document.getElementById(name), 'contentWindow', { value: contentWindow, configurable: true });
  }
  run(frames(run(window, 'static/theme.js')), 'static/overview.js', 'static/speaker.js');
  // Each frame says it's ready, as preview.html does.
  for (const name of ['now', 'next']) {
    const source = window.document.getElementById(name).contentWindow;
    window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'ready' }, source }));
  }
  heard({ data: { type: 'deck', open: true, index: 0, reveal: 0, slides: [{ body: 'one' }, { body: 'two' }], meta: {}, title: 'talk' } });
  await new Promise((resolve) => setTimeout(resolve));
  const render = (name) => sent[name].find((m) => m.type === 'render');
  assert.equal(render('now').title, 'talk');
  assert.equal(render('next').title, 'talk');
});
