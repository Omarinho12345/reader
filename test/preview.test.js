import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/render.js';
import { slides } from '../src/slides.js';
import { APP, preview, app, globals, frame, run, settle, assertElement } from './dom.js';

const BASE = 'http://localhost:8734/content/notes/';

/** The preview frame showing `markdown`, from a file in notes/. */
function showing(markdown, m = {}) {
  const p = preview();
  p.show(render(markdown).body, { base: BASE, ...m });
  p.posted.length = 0;
  const link = (text) => [...p.document.querySelectorAll('a')].find((a) => a.textContent === text);
  return { ...p, link };
}

test('the frame takes what the app sends, and nothing from another origin or another window (gh-206)', () => {
  const p = preview();
  p.send({ type: 'render', css: '', body: '<p>from elsewhere</p>' }, { origin: 'http://evil.example' });
  p.send({ type: 'render', css: '', body: '<p>from the frames themselves</p>' }, { origin: 'http://frames.localhost:8734' });
  p.window.dispatchEvent(new p.window.MessageEvent('message', { data: { type: 'render', css: '', body: '<p>from a child</p>' }, source: {}, origin: APP }));
  assert.doesNotMatch(p.document.body.innerHTML, /from/);
  p.show('<p>from the app</p>');
  assert.match(p.document.body.innerHTML, /from the app/);
});

test('a relative link or image is to the file in the content directory, and no further up than its top', () => {
  const { document, link } = showing([
    '[next](next.md) [up](../top.md?x#y) [past](../../../../etc/passwd.md) [here](#a) [abs](/api/files)',
    '[away](https://example.com/a.md) ![pic](img/pic.png)',
  ].join('\n'));
  assert.equal(link('next').href, 'http://localhost:8734/content/notes/next.md');
  assert.equal(link('up').href, 'http://localhost:8734/content/top.md?x#y');
  assert.equal(link('past').href, 'http://localhost:8734/content/etc/passwd.md');
  assert.equal(link('here').getAttribute('href'), '#a');
  assert.equal(link('abs').getAttribute('href'), '/api/files');
  assert.equal(link('away').href, 'https://example.com/a.md');
  assert.equal(document.querySelector('img').src, 'http://localhost:8734/content/notes/img/pic.png');
});

test('a page not from the content directory keeps its links as written', () => {
  const { link } = showing('[next](next.md)', { base: 'http://localhost:8734/export/' });
  assert.equal(link('next').getAttribute('href'), 'next.md');
});

/** Clicks `a`, with `keys` held: whether it was taken, and what the frame asked of the app. */
function click(p, a, keys = {}) {
  const e = new p.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...keys });
  a.dispatchEvent(e);
  const followed = p.posted.filter((m) => m.type === 'follow').map((m) => m.href);
  p.posted.length = 0;
  return { taken: e.defaultPrevented, followed };
}

test('a link to a markdown file being served is opened in the app', () => {
  const p = showing('[next](next.md) [notes](../Notes.MARKDOWN#part)');
  assert.deepEqual(click(p, p.link('next')), { taken: true, followed: ['http://localhost:8734/content/notes/next.md'] });
  assert.deepEqual(click(p, p.link('notes')), { taken: true, followed: ['http://localhost:8734/content/Notes.MARKDOWN#part'] });
});

test('a link to anything else, or clicked with a key held, is left to open its tab', () => {
  const p = showing('[pdf](paper.pdf) [away](https://example.com/a.md) [next](next.md)');
  const none = { taken: false, followed: [] };
  assert.deepEqual(click(p, p.link('pdf')), none);
  assert.deepEqual(click(p, p.link('away')), none);
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) assert.deepEqual(click(p, p.link('next'), { [key]: true }), none, key);
  assert.deepEqual(click(p, p.link('next'), { button: 1 }), none);
});

test('on a slide, a link isn\'t followed: the deck shouldn\'t give way to another file', () => {
  const p = showing('[next](next.md)', { deck: true });
  assert.deepEqual(click(p, p.link('next')).followed, []);
});

test('the document is the frame\'s main part, and its title the frame\'s', () => {
  const { document, show } = preview();
  assert.equal(document.title, 'Rendered document');
  const out = render('---\ntitle: Notes on things\n---\n\nHello\n');
  show(out.body, { title: out.title });
  assert.equal(document.title, 'Notes on things');
  assert.equal(document.querySelector('.gm-doc').getAttribute('role'), 'main');
  show(render('Hi\n').body);
  assert.equal(document.title, 'Rendered document');
});

test('on a slide, Tab goes round its tabs and back out to the deck, and Space on one is the tab\'s', () => {
  const { document, window, show, send, posted } = preview();
  show(render('::: tabs\n+++ A\none\n+++ B\ntwo\n:::\n\n::: tabs\n+++ C\nthree\n+++ D\nfour\n:::\n').body, { deck: true });
  // Each block's tab picked, as Tab reaches a group of radio buttons.
  const boxes = [...document.querySelectorAll('.tab-pick:checked')];
  const press = (key, keys = {}) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...keys });
    (document.activeElement ?? document.body).dispatchEvent(e);
    return e.defaultPrevented;
  };
  const sent = () => posted.splice(0).filter((m) => m.type === 'key' || m.type === 'untab').map((m) => m.key ?? m.type);
  send({ type: 'tab', back: false });
  assertElement(document.activeElement, boxes[0]);
  assert.equal(press('Tab'), true);
  assertElement(document.activeElement, boxes[1]);
  press(' ');
  assert.deepEqual(sent(), [], 'Space works the tab, and doesn\'t go up to the deck');
  press('n');
  assert.deepEqual(sent(), ['n']);
  press('Tab');
  assert.deepEqual(sent(), ['untab']);
  send({ type: 'tab', back: true });
  assertElement(document.activeElement, boxes[1]);
  press('Tab', { shiftKey: true });
  assertElement(document.activeElement, boxes[0]);
});

/** A slide of `markdown` being presented, and the keys it sends up to the deck. */
function presenting(markdown) {
  const p = preview();
  p.show(slides(`${markdown}\n---\n\n# Next\n`).slides[0].body, { deck: true });
  const press = (key) => {
    const e = new p.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (p.document.activeElement ?? p.document.body).dispatchEvent(e);
    return e.defaultPrevented;
  };
  const sent = () => p.posted.splice(0).filter((m) => m.type === 'key' || m.type === 'untab').map((m) => m.key ?? m.type);
  return { ...p, press, sent };
}

test('on a slide, Tab passes over a blank, a box, a choice and a card, which can\'t be worked there, and a checkbox keeps only Space from the deck', () => {
  const { document, send, press, sent } = presenting('# One\n\nFill in: [@ answer here:]\n\n- [ ] A box\n\n@ Session: ( ) Sat AM ( ) Sat PM\n\nGood: a card\n');
  // A checkbox Tab can still reach there, as a code block's "show all" is.
  const box = document.createElement('input');
  box.type = 'checkbox';
  document.querySelector('.gm-doc').append(box);
  send({ type: 'tab', back: false });
  assertElement(document.activeElement, box, 'Tab reaches the checkbox, and nothing that can\'t be worked');
  press(' ');
  assert.deepEqual(sent(), [], 'Space ticks the checkbox');
  assert.equal(press('ArrowRight'), true);
  press('Enter');
  assert.deepEqual(sent(), ['ArrowRight', 'Enter'], 'the box doesn\'t use them: they move the deck');
  press('Tab');
  assert.deepEqual(sent(), ['untab']);
});

test('on a slide, a tab keeps Space and the arrows from the deck, a link Enter, and anything else the keys it takes', () => {
  const { document, press, sent } = presenting('# One\n\n::: tabs\n+++ A\none\n+++ B\ntwo\n:::\n\n[a link](https://example.com)\n');
  document.querySelector('.tab-pick').focus();
  press(' ');
  press('ArrowDown');
  press('Enter');
  assert.deepEqual(sent(), ['Enter']);
  document.querySelector('a').focus();
  press('Enter');
  press('ArrowRight');
  assert.deepEqual(sent(), ['ArrowRight']);
  // Something else Tab reaches, as a puzzle is, that takes ← and not →.
  const mine = document.createElement('span');
  mine.tabIndex = 0;
  document.querySelector('.gm-doc').append(mine);
  mine.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') e.preventDefault(); });
  mine.focus();
  press('ArrowLeft');
  press('ArrowRight');
  assert.deepEqual(sent(), ['ArrowRight']);
});

test('whether the page can be worked is one answer, set by each render and marked on the page, that the features go by when it changes', async () => {
  const { window, document, show, posted } = preview();
  const html = document.documentElement;
  const md = '## Soup\n\n1) [ ] Chop.\n2) [ ] Fry.\n\n@ Notes: x\n\nOn date:2026-11-10[].\n\n- [ ] Salt\n\n@ Bowl: ( ) big ( ) small\n\nGood: a card\n';
  show(render(md).body);
  assert.equal(window.Preview.workable, true);
  assert.equal(html.classList.contains('unworkable'), false);
  show(slides(`${md}\n---\n\n# Next\n`).slides[0].body, { deck: true });
  assert.equal(window.Preview.workable, false);
  assert.equal(html.classList.contains('unworkable'), true);
  // A page shut while it's showing, as one past its time will be.
  show(render(md).body);
  window.Preview.workable = false;
  assert.equal(html.classList.contains('unworkable'), true);
  const press = (key, on = document.body) => on.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  document.querySelector('.field').click();
  assert.equal(document.querySelector('.field textarea'), null, 'the blank isn\'t opened');
  press('Enter', document.querySelector('.date[data-line]'));
  assert.equal(document.querySelector('.date-open'), null, 'nor the calendar');
  press('j');
  document.querySelectorAll('li.step')[1].click();
  assert.equal(document.querySelector('li.step-current'), null, 'nor a step lit');
  posted.length = 0;
  const box = document.querySelector('li.task:not(.step) .task-box');
  const badge = document.querySelector('li.step .task-box');
  const choice = document.querySelector('.field-choice > input');
  const card = document.querySelector('.qa-toggle');
  for (const control of [box, badge, choice]) control.click();
  card.click();
  press('Enter', card);
  await settle();
  assert.deepEqual(posted.filter((m) => m.type === 'edit'), [], 'nor a box ticked, a step\'s badge, a choice picked or a card marked done');
  assert.deepEqual([box.checked, badge.checked, choice.checked], [false, false, false]);
  window.Preview.workable = true;
  assert.equal(html.classList.contains('unworkable'), false);
  document.querySelectorAll('li.step')[1].click();
  assertElement(document.querySelector('li.step-current'), document.querySelectorAll('li.step')[1]);
  press('Enter', document.querySelector('.date[data-line]'));
  assert.ok(document.querySelector('.date-open'));
  document.querySelector('.field').click();
  assert.ok(document.querySelector('.field textarea'));
  for (const control of [box, badge, choice]) control.click();
  card.click();
  await settle();
  assert.deepEqual(posted.filter((m) => m.type === 'edit').flatMap((m) => m.edits.map((e) => e.after[0])),
    ['- [x] Salt', '1) [x] Chop.', '@ Bowl: (x) big ( ) small', 'Good [x]: a card']);
});

test('a slide with nothing to Tab to gives the keyboard straight back to the deck', () => {
  const { show, send, posted } = preview();
  show(render('Just words.\n').body, { deck: true });
  send({ type: 'tab', back: false });
  assert.deepEqual(posted.filter((m) => m.type === 'untab').length, 1);
});

test('the box that had the keyboard has it again once a render replaces it', () => {
  const { document, show } = preview();
  const md = '* [ ] one\n* [ ] two\n';
  show(render(md).body);
  document.querySelectorAll('.task-box')[1].focus();
  show(render(md.replace('[ ] two', '[x] two')).body);
  assertElement(document.activeElement, document.querySelectorAll('.task-box')[1]);
});

test('the keyboard comes back to the box it left, once the edit that took it is made', () => {
  const { window, document, show, send } = preview();
  const md = '* [ ] one\n* [ ] two\n';
  show(render(md).body);
  const box = document.querySelectorAll('.task-box')[1];
  box.focus();
  // Ticking it takes the keyboard out of the frame, to the editor.
  leave(window, box);
  show(render(md.replace('[ ] two', '[x] two')).body);
  assertElement(document.activeElement, document.body);
  send({ type: 'refocus' });
  assertElement(document.activeElement, document.querySelectorAll('.task-box')[1]);
});

/** Takes the keyboard from `node` out of the frame altogether, as to the editor. */
function leave(window, node) {
  node.blur();
  window.dispatchEvent(new window.Event('blur'));
}

test('a box left by a click on the page isn\'t given the keyboard back', async () => {
  const { window, document, show, send } = preview();
  show(render('* [ ] one\n\nSome text.\n').body);
  const box = document.querySelector('.task-box');
  box.focus();
  // A click on the text: the keyboard is on the page, still in the frame.
  box.blur();
  await new Promise((r) => window.setTimeout(r));
  // Then a step ticked with x takes it from the page to the editor, and back.
  window.dispatchEvent(new window.Event('blur'));
  send({ type: 'refocus' });
  // (Not assert.equal: a failure would print the whole box.)
  assertElement(document.activeElement, document.body, 'the keyboard stays on the page');
});

test('a box the keyboard left the frame from is forgotten once it\'s back in the frame', () => {
  const { window, document, show, send } = preview();
  show(render('* [ ] one\n* [ ] two\n').body);
  const [one, two] = document.querySelectorAll('.task-box');
  one.focus();
  leave(window, one);
  two.focus();
  two.blur();
  send({ type: 'refocus' });
  // (Not assert.equal: a failure would print the whole box.)
  assertElement(document.activeElement, document.body, 'the keyboard stays on the page');
});

test('a box left for the editor is forgotten once a click on the page\'s text brings the keyboard back', () => {
  const { window, document, show, send } = preview();
  show(render('* [ ] one\n\nSome text.\n').body);
  const box = document.querySelector('.task-box');
  box.focus();
  leave(window, box);
  // A click on the text: the frame has the keyboard again, on the page, with no focusin.
  document.querySelector('p').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  window.dispatchEvent(new window.Event('focus'));
  // Then a step ticked takes it from the page to the editor, and back.
  window.dispatchEvent(new window.Event('blur'));
  window.dispatchEvent(new window.Event('focus'));
  send({ type: 'refocus' });
  // (Not assert.equal: a failure would print the whole box.)
  assertElement(document.activeElement, document.body, 'the keyboard stays on the page');
});

test('a box left for the editor is forgotten once a key is pressed on the page', () => {
  const { window, document, show, send } = preview();
  show(render('* [ ] one\n\nSome text.\n').body);
  const box = document.querySelector('.task-box');
  box.focus();
  leave(window, box);
  // The app puts the keyboard on the frame some other way, and a key comes.
  window.dispatchEvent(new window.Event('focus'));
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  send({ type: 'refocus' });
  assertElement(document.activeElement, document.body, 'the keyboard stays on the page');
});

test('a blank written into a definition is gone, and Enter on it opens nothing after it', () => {
  const { window, document, show } = preview();
  const md = '# Words\n\n!Foo:\n!Bar:\n\n- [ ] A box\n';
  show(render(md).body);
  document.querySelector('.def-blank .field-value').focus();
  const input = document.activeElement;
  input.value = 'a thing';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  // The meaning is written, and the file's new text brings a render.
  show(render(md.replace('!Foo:', '!Foo: a thing')).body);
  assert.equal(document.querySelectorAll('textarea').length, 0, 'no blank is open');
  // (Not assert.equal: a failure would print the whole blank.)
  assertElement(document.activeElement, document.body, 'the keyboard stays on the page');
});

// The deck numbers a slide's steps before it sends it to the stage.
globals(app());
const { steps: numbered } = await import('../static/app/deck.js');

/** What the stage says back as each of `steps` shows, asked as the deck asks. */
function saying(markdown, ...steps) {
  const p = preview();
  p.show(numbered(slides(`${markdown}\n---\n\n# Next\n`).slides[0].body).body, { deck: true, reveal: 0, say: { title: true, index: 0, reveal: 0 } });
  const says = [];
  let at = 0;
  const heard = () => says.push(...p.posted.splice(0).filter((m) => m.type === 'revealed').map((m) => m.says));
  heard();
  for (const k of steps) {
    p.send({ type: 'reveal', reveal: k, say: { from: at, index: 0, reveal: k } });
    at = k;
    heard();
  }
  return says;
}

test('on a slide, a reveal says back what it showed: the title, then each step', () => {
  assert.deepEqual(saying('# One\n\n- the first point\n- the second point\n\n@ Thoughts:\n\n@ Name: Josh\n', 1, 2, 3, 4),
    ['One', 'the first point', 'the second point', 'Thoughts: blank', 'Name: Josh']);
});

test('on a slide, an empty field says its hint after it\'s blank', () => {
  assert.deepEqual(saying('# One\n\n@ Hours {e.g. 7.5}:\n\n@ Name {first}: Josh\n', 1, 2),
    ['One', 'Hours: blank, e.g. 7.5', 'Name: Josh']);
});

test('on a slide, a field of a kind says its value: a date, a number, or that it is blank', () => {
  assert.deepEqual(saying('# One\n\n@ Due: date:2026-11-10[]\n\n@ When: date:[]\n\n@ Age: number:12[]\n', 1, 2, 3),
    ['One', 'Due: November 10, 2026', 'When: blank', 'Age: 12']);
});

test('the overview names a slide by its title as the stage says it, an image in it by its alt', () => {
  const markdown = '# Why ![a rocket](r.png) *really* wins\n\nbody\n';
  assert.deepEqual(saying(markdown), ['Why a rocket really wins']);
  assert.equal(numbered(slides(markdown).slides[0].body).title, 'Why a rocket really wins');
});

test('a slide come to whole says its title, then what its steps showed', () => {
  const said = (markdown) => {
    const p = preview();
    p.show(numbered(slides(markdown).slides[0].body).body, { deck: true, reveal: Infinity, say: { title: true, from: 0, index: 0, reveal: 9 } });
    return p.posted.filter((m) => m.type === 'revealed').map((m) => m.says);
  };
  assert.deepEqual(said('# Three\n\n![A red square](red.png)\n'), ['Three. A red square']);
  assert.deepEqual(said('# Why?\n\n- this\n- that\n'), ['Why? this that']);
  assert.deepEqual(said('No title, just this.\n'), ['No title, just this.']);
  const [long] = said(`# Many\n\n${'This is a sentence of some length. '.repeat(10)}\n`);
  assert.ok(long.startsWith('Many. This') && long.length <= 'Many. '.length + 200, long);
});

test('an image says its alt, a blank in a sentence its hint, and a definition not looked up says so', () => {
  assert.deepEqual(saying('# Pictures\n\n![a cat on a mat](cat.png)\n\nFill in [@ a hint] here.\n\n!grace:\n', 1, 2, 3),
    ['Pictures', 'a cat on a mat', 'Fill in a hint: blank here.', 'grace not yet defined']);
});

test('a fence that moves its highlight says the lines it moves to; a later step hidden isn\'t said with its own', () => {
  assert.deepEqual(saying('# Code\n\n```js {1|2}\nlet a\nlet b\n```\n\n- outer\n  - inner\n', 1, 2, 3, 4),
    ['Code', 'let a', 'let b', 'outer', 'inner']);
});

test('what a step says leaves out what\'s hidden from a screen reader, as a callout\'s icon is', () => {
  assert.deepEqual(saying('# Callouts\n\n> [!NOTE]\n> Mind the step.\n', 1), ['Callouts', 'Note Mind the step.']);
});

test('a heading that is itself a step isn\'t said as the slide\'s title, but as the step it is', () => {
  assert.deepEqual(saying('- # Arrives later\n- then this\n', 1, 2), ['', 'Arrives later', 'then this']);
});

test('several steps shown at once are said together, and a long one is cut to a sentence or two', () => {
  const long = `${'This is a sentence of some length. '.repeat(10)}`;
  const [, both, cut] = saying(`# Many\n\nOne.\n\nTwo.\n\n${long}\n`, 2, 3);
  assert.equal(both, 'One. Two.');
  assert.ok(cut.length <= 200 && cut.endsWith('length.'), cut);
});

test('on a slide, ⌘+, ⌘− and ⌘0 go up to the deck and don\'t zoom the browser; off one, they\'re the browser\'s', () => {
  const { window, document, sent } = presenting('# One\n\n- [ ] A box\n');
  const zoom = (key, keys = {}) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, metaKey: true, ...keys });
    (document.activeElement ?? document.body).dispatchEvent(e);
    return e.defaultPrevented;
  };
  document.querySelector('.task-box').focus();
  assert.equal(zoom('='), true);
  assert.equal(zoom('+', { shiftKey: true }), true);
  assert.equal(zoom('-', { metaKey: false, ctrlKey: true }), true);
  assert.equal(zoom('0'), true);
  assert.deepEqual(sent(), ['=', '+', '-', '0']);
  const page = preview();
  page.show('<p>Not a slide.</p>');
  const e = new page.window.KeyboardEvent('keydown', { key: '=', metaKey: true, bubbles: true, cancelable: true });
  page.document.body.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false);
});

test('a slide\'s text is at the deck\'s size, from its render and from a reveal', () => {
  const { document, show, send, posted } = preview();
  const scale = () => document.documentElement.style.getPropertyValue('--reader-text-scale');
  const fitted = () => posted.splice(0).filter((m) => m.type === 'fit').length;
  show(slides('# One\n').slides[0].body, { deck: true, scale: 1.25 });
  assert.equal(scale(), '1.25');
  fitted();
  // Bigger text may not fit as it did: the slide is fitted again.
  send({ type: 'reveal', reveal: 0, scale: 1.5 });
  assert.equal(scale(), '1.5');
  assert.equal(fitted(), 1);
  send({ type: 'reveal', reveal: 0, scale: 1.5 });
  assert.equal(fitted(), 0, 'a step shown at the same size isn\'t fitted again');
  show('<p>Not a slide.</p>');
  assert.equal(scale(), '1');
});

test('a slide drawn for the speaker view is fitted as on stage, its later steps faint, and says nothing aloud', () => {
  const { document, show, posted } = preview();
  show(numbered(slides('# One\n\n- a\n- b\n').slides[0].body).body, { deck: true, reveal: 1, dim: true });
  assert.ok(document.documentElement.classList.contains('deck'));
  const steps = [...document.querySelectorAll('[data-step]')];
  assert.deepEqual(steps.map((n) => [n.classList.contains('step-dim'), n.classList.contains('step-hidden')]), [[false, false], [true, false]]);
  assert.equal(posted.filter((m) => m.type === 'fit').length, 1);
  assert.deepEqual(posted.filter((m) => m.type === 'revealed'), []);
});

test('a slide grows to fill the window, up to twice its size, sized at 100% for ⌘+ and ⌘− to size up or down', () => {
  /** The zoom a slide `tall` windows high at its written size comes to, with the deck's text at `scale`. */
  const zoom = (tall, scale = 1) => {
    const { window, show, posted } = preview();
    const style = window.document.documentElement.style;
    const value = (name) => Number(style.getPropertyValue(name) || 1);
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
      get() { return this.classList.contains('gm-doc') ? tall * window.innerHeight * value('--fit') * value('--reader-text-scale') : 0; },
    });
    show(slides('# One\n\n- a\n').slides[0].body, { deck: true, scale });
    return posted.filter((m) => m.type === 'fit').at(-1).zoom;
  };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.02, `${a} is about ${b}`);
  // A short slide grows to fill, no further than twice its size.
  near(zoom(1 / 1.5), 1.5);
  near(zoom(1 / 4), 2);
  // One too big shrinks, as before.
  near(zoom(1.25), 0.8);
  assert.equal(zoom(2), 0.6);
  // ⌘+ makes a slide bigger as far as it fits, and never smaller.
  near(zoom(1 / 4, 1.25) * 1.25, 2.5);
  near(zoom(1 / 1.5, 1.25) * 1.25, 1.5);
  near(zoom(1.25, 1.25) * 1.25, 0.8);
  // ⌘− always makes it smaller.
  near(zoom(1 / 1.5, 0.8) * 0.8, 1.2);
  near(zoom(1.25, 0.8) * 0.8, 0.64);
});

test('what the frame says is said in its one live region, outside the page a render replaces, out of sight, and the same again is heard again', () => {
  const p = preview();
  p.show(render('1) [ ] Chop.\n\ntimer:[1m]\n\n```maze\n+--+--+\n|S  E|\n+--+--+\n```\n').body);
  const regions = () => [...p.document.querySelectorAll('[aria-live]')];
  assert.equal(regions().length, 1, 'one for every feature that speaks');
  const [heard] = regions();
  assert.equal(heard.parentNode, p.document.documentElement);
  assert.equal(heard.className, 'vh');
  assert.equal(heard.getAttribute('aria-live'), 'polite');
  assert.equal(heard.textContent, '', 'there before anything is said, so the first is heard');
  p.window.Preview.say('Step 1 of 1: Chop.');
  p.show(render('1) [x] Chop.\n').body);
  assert.equal(regions()[0], heard, 'a render leaves it be');
  assert.equal(heard.textContent, 'Step 1 of 1: Chop.');
  p.window.Preview.say('Step 1 of 1: Chop.');
  assert.equal(heard.textContent, 'Step 1 of 1: Chop.\u00a0');
  assert.match(render('x\n').css, /\.vh \{[^}]*clip-path: inset\(50%\)/, 'the document hides it, as it does what any feature says unseen');
});

test('the edits asked for in one turn go up at its end, as one for the same options, and a turn\'s apart from the next', async () => {
  const { window, posted } = frame('');
  run(window, 'static/preview-api.js');
  const edit = (n) => ({ from: n, to: n + 1, before: [`${n}`], after: [`${n}!`] });
  const sent = () => posted.splice(0).filter((m) => m.type === 'edit').map(({ edits, ...m }) => [edits.map((e) => e.from), m]);
  window.Preview.edit([edit(0)], { undo: true });
  window.Preview.edit([edit(1)]);
  window.Preview.edit([edit(2), edit(3)], { undo: true });
  assert.deepEqual(posted, [], 'held to the end of the turn');
  await settle();
  assert.deepEqual(sent(), [
    [[0, 2, 3], { type: 'edit', undo: true }],
    [[1], { type: 'edit' }],
  ]);
  window.Preview.edit([edit(4)], { undo: true });
  await settle();
  window.Preview.edit([edit(5)], { undo: true });
  await settle();
  assert.deepEqual(sent(), [[[4], { type: 'edit', undo: true }], [[5], { type: 'edit', undo: true }]]);
});

test('edits of the same line in a turn become one, with both changes where they change different parts, and the first ask\'s options', async () => {
  const { window, posted } = frame('');
  run(window, 'static/preview-api.js');
  const line = '- ( ) C · [@ Else]';
  const sent = () => posted.splice(0).filter((m) => m.type === 'edit').map(({ edits, ...m }) => [edits, m]);
  window.Preview.edit([{ from: 2, to: 3, before: [line], after: ['- ( ) C · [@ Else: run]'] }]);
  window.Preview.edit([{ from: 2, to: 3, before: [line], after: ['- (x) C · [@ Else]'] }, { from: 0, to: 1, before: ['a'], after: ['b'] }], { undo: true });
  await settle();
  assert.deepEqual(sent(), [[[
    { from: 2, to: 3, before: [line], after: ['- (x) C · [@ Else: run]'] },
    { from: 0, to: 1, before: ['a'], after: ['b'] },
  ], { type: 'edit' }]]);
  // Changing the same part, the later one is written.
  window.Preview.replace(window.document.body, () => {});
  window.Preview.edit([{ from: 0, to: 1, before: ['abc'], after: ['aXc'] }]);
  window.Preview.edit([{ from: 0, to: 1, before: ['abc'], after: ['aYc'] }]);
  await settle();
  assert.deepEqual(sent(), [[[{ from: 0, to: 1, before: ['abc'], after: ['aYc'] }], { type: 'edit' }]]);
});

test('an edit of a line an earlier turn wrote, made from the line as its feature knew it, is made on what was written, until the page is drawn again', async () => {
  const { window, posted } = frame('');
  run(window, 'static/preview-api.js');
  const sent = async (e) => {
    window.Preview.edit([{ from: 1, to: 2, before: [e[0]], after: [e[1]] }]);
    await settle();
    return posted.splice(0).flatMap((m) => m.edits).map((x) => [x.before[0], x.after[0]]);
  };
  // A choice picked as its blank is filled, then another picked.
  await sent(['- ( ) C [@ x]', '- (x) C [@ x: run]']);
  assert.deepEqual(await sent(['- (x) C [@ x]', '- ( ) C [@ x]']), [['- (x) C [@ x: run]', '- ( ) C [@ x: run]']]);
  // What's written as the line now reads is left as it is.
  assert.deepEqual(await sent(['- ( ) C [@ x: run]', '- ( ) C [@ x: ran]']), [['- ( ) C [@ x: run]', '- ( ) C [@ x: ran]']]);
  window.Preview.replace(window.document.body, () => {});
  assert.deepEqual(await sent(['- (x) C [@ x]', '- ( ) C [@ x]']), [['- (x) C [@ x]', '- ( ) C [@ x]']]);
});

test('Preview.flush sends the edits held so far, and the end of the turn sends nothing again', async () => {
  const { window, posted } = frame('');
  run(window, 'static/preview-api.js');
  window.Preview.edit([{ from: 0, to: 1, before: ['a'], after: ['b'] }], { undo: true });
  window.Preview.flush();
  assert.equal(posted.length, 1);
  await settle();
  assert.equal(posted.length, 1);
});
