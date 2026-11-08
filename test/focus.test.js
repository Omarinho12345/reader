import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { app, globals, assertElement } from './dom.js';

// A toast hides itself a few seconds on; here it waits to be told.
mock.timers.enable({ apis: ['setTimeout'] });

const window = globals(app());
const { document } = window;
// The server: a folder of three files, and whatever's asked of it done.
let files = ['a.md', 'b.md', 'c.md'];
globalThis.fetch = async (url, { body } = {}) => {
  const ask = String(url);
  const said = body && JSON.parse(body);
  if (ask.startsWith('/api/trash')) files = files.filter((p) => p !== said.path);
  for (const { from, to } of ask.startsWith('/api/rename') ? said.moves : []) files = files.map((p) => (p === from ? to : p));
  const out = ask.startsWith('/api/info') ? { name: 'notes', root: '/notes' }
    : ask.startsWith('/api/tree') ? { files: files.map((path) => ({ path, type: 'md', mtime: 1 })) }
    : ask.startsWith('/api/trash') ? { trash: 't1' }
    : ask.startsWith('/api/rename') ? { moved: said.moves }
    : { text: '# A\n', mtime: 1 };
  return { ok: true, json: async () => out };
};

const { el, state, deck } = await import('../static/app/state.js');
const { setPages } = await import('../static/app/pages.js');
const { deckKey } = await import('../static/app/deck.js');
const { applyEdit } = await import('../static/app/editing.js');
// The page and the stage keep what they're sent.
const framed = [];
Object.defineProperty(el.preview, 'contentWindow', { value: { postMessage: (m) => framed.push(m) } });
const staged = [];
Object.defineProperty(el.stage, 'contentWindow', { value: { postMessage: (m) => staged.push(m) } });
await import('../static/app/main.js');
const settled = () => new Promise(setImmediate);
await settled();

const row = (p) => el.files.querySelector(`.file[data-path="${p}"]`);
const press = (target, key, opts = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, ...opts }));

test('without a version to show, neither the files list nor the help shows one', () => {
  assert.equal(el.version.hidden, true);
  assert.equal(el.helpVersion.hidden, true);
});

test('Esc in the New form gives the keyboard back to New', () => {
  el.newBtn.click();
  assertElement(document.activeElement, el.newName);
  press(el.newName, 'Escape');
  assert.equal(el.newForm.hidden, true);
  assertElement(document.activeElement, el.newBtn);
});

test('a rename called off by Esc, or left as it was by Enter, gives the keyboard back to its row', async () => {
  for (const key of ['Escape', 'Enter']) {
    row('b.md').focus();
    press(row('b.md'), 'F2');
    const input = el.files.querySelector('.name-edit');
    assertElement(document.activeElement, input);
    press(input, key);
    await settled();
    assertElement(document.activeElement, row('b.md'), key);
  }
});

test('a file renamed gives the keyboard back to its row, under its new name', async () => {
  // And back again, so the files are as they were for the tests after.
  for (const [from, to] of [['b.md', 'z.md'], ['z.md', 'b.md']]) {
    row(from).focus();
    press(row(from), 'F2');
    const input = el.files.querySelector('.name-edit');
    input.value = to;
    press(input, 'Enter');
    await settled();
    await settled();
    await settled();
    assert.equal(row(from), null);
    assertElement(document.activeElement, row(to), `the row for ${to} has the keyboard`);
  }
});

test('a file trashed from the list leaves the keyboard on the file after it', async () => {
  row('b.md').focus();
  press(row('b.md'), 'Backspace', { metaKey: true });
  await settled();
  await settled();
  assert.equal(row('b.md'), null);
  assertElement(document.activeElement, row('c.md'));
  assert.equal(state.current.path, 'a.md');
});

test("one of a row's actions keeps the keyboard when the list is drawn again, as coming back to the window does", async () => {
  const action = (kind) => row('a.md').closest('li').querySelector(`.row-action.${kind}`);
  for (const kind of ['branch', 'export', 'trash', 'into']) {
    const was = action(kind);
    was.focus();
    window.dispatchEvent(new window.Event('focus'));
    await settled();
    assert.ok(action(kind) !== was, `${kind}: the list was drawn again`);
    assertElement(document.activeElement, action(kind), `${kind} has the keyboard`);
  }
});

test("a version's Promote, a version group's › and an outline entry's Extract keep the keyboard when the list is drawn again", async () => {
  const redrawn = async (find, what) => {
    const was = find();
    was.focus();
    window.dispatchEvent(new window.Event('focus'));
    await settled();
    assert.ok(find() !== was, `${what}: the list was drawn again`);
    assertElement(document.activeElement, find(), `${what} has the keyboard`);
  };
  const before = files;
  files = [...files, 'd.md', 'd.v2.md'];
  window.dispatchEvent(new window.Event('focus'));
  await settled();
  const into = () => el.files.querySelector('.group[data-group="d"]').closest('li').querySelector(':scope > .row-action.into');
  await redrawn(into, "a version group's ›");
  into().click();
  await settled();
  await redrawn(() => row('d.v2.md').closest('li').querySelector('.row-action.promote'), 'Promote');
  files = before;
  state.group = null;
  window.dispatchEvent(new window.Event('focus'));
  await settled();
  row('a.md').closest('li').querySelector('.row-action.into').click();
  await settled();
  await redrawn(() => el.files.querySelector('.entry').closest('li').querySelector('.row-action.extract'), 'Extract');
});

test('a page dot clicked gives the keyboard to the dot of the page turned to, and Back or Next to the other at an end', () => {
  const pages = ['One', 'Two', 'Three'].map((t, line) => ({ body: `<h1>${t}</h1>`, line }));
  setPages(pages, 'a.md');
  const dot = (n) => el.pageDots.querySelectorAll('.page-dot')[n];
  dot(1).focus();
  dot(1).click();
  assertElement(document.activeElement, dot(1));
  assert.equal(dot(1).getAttribute('aria-current'), 'page');
  el.pageNext.focus();
  el.pageNext.click();
  assertElement(document.activeElement, el.pageBack);
});

test('a box ticked on the page gets the keyboard back after its edit', () => {
  // happy-dom has no execCommand, so the edit is made by setRangeText.
  document.execCommand = () => false;
  el.preview.focus();
  applyEdit({ edits: [{ from: 0, to: 1, before: ['# A'], after: ['# B'] }], undo: true });
  assert.equal(el.editor.value, '# B\n');
  assertElement(document.activeElement, el.preview, 'the page has the keyboard back');
  assert.deepEqual(framed.at(-1), { type: 'refocus' });
});

test('Tab in a deck takes the keyboard into the slide, and the slide gives it back to the deck', () => {
  deck.open = true;
  deckKey({ key: 'Tab', shiftKey: false });
  assertElement(document.activeElement, el.stage, 'the stage has the keyboard');
  assert.deepEqual(staged.at(-1), { type: 'tab', back: false });
  deckKey({ key: 'Tab', shiftKey: true });
  assert.deepEqual(staged.at(-1), { type: 'tab', back: true });
  // Past its last box, the slide says so.
  window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'untab' }, source: el.stage.contentWindow }));
  assertElement(document.activeElement, el.deck, 'the deck has the keyboard back');
  deck.open = false;
});

test('the ‹ and › at a slide\'s foot step back and on, by name', () => {
  Object.assign(deck, { open: true, index: 0, reveal: 0, stageReady: null, meta: {}, slides: [{ body: '<h1>One</h1>', steps: 0, notesHtml: '' }, { body: '<h1>Two</h1>', steps: 0, notesHtml: '' }] });
  state.current = { path: 'a.md', type: 'md' };
  el.deck.hidden = false;
  assert.equal(el.deckBack.getAttribute('aria-label'), 'Back');
  assert.equal(el.deckNext.getAttribute('aria-label'), 'Next');
  el.deckNext.click();
  assert.equal(deck.index, 1);
  el.deckBack.click();
  assert.equal(deck.index, 0);
  deck.open = false;
  el.deck.hidden = true;
});

test('the ✕ at a slide\'s foot leaves the deck, by a name, and the foot doesn\'t move it', () => {
  Object.assign(deck, { open: true, index: 1, reveal: 0, stageReady: null, meta: {}, slides: [{ body: '<h1>One</h1>', steps: 1, notesHtml: '' }, { body: '<h1>Two</h1>', steps: 1, notesHtml: '' }] });
  state.current = { path: 'a.md', type: 'md' };
  el.deck.hidden = false;
  el.bar.inert = el.split.inert = true;
  assert.equal(el.deckLeave.getAttribute('aria-label'), 'Stop presenting');
  // At the left of the screen, where a click on the slide would go back.
  el.deckFoot.click();
  assert.equal(deck.index, 1);
  el.deckLeave.click();
  assert.equal(deck.open, false);
  assert.ok(el.deck.hidden);
  assert.ok(!el.bar.inert && !el.split.inert);
  assert.equal(deck.index, 1);
  // The editor would bring up the screen's keyboard, over the file.
  assertElement(document.activeElement, el.presentBtn, 'the keyboard goes back to Present');
});
