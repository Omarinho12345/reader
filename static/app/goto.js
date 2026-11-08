/**
 * Going to a place in the file: from the outline, or by Ctrl+G, which asks
 * where. `12` is page 12 (slide 12 of a talk, or while presenting), `:340`
 * is line 340, and anything else finds a heading by its title.
 *
 * Wherever it's asked from, the place is shown the way the file is being
 * looked at: in the editor, with the page beside it following; on its page
 * in Work; on its slide while presenting.
 */

import { el, state, deck } from './state.js';
import { measure, lead } from './sync.js';
import { scheduleGutter } from './lines.js';
import { updateCursor } from './status.js';
import { paged, turnTo, turnToLine } from './pages.js';
import { go as goToSlide, closeOverview } from './deck.js';
import { current, setAt } from './outline.js';
import { find, flatten } from './sections.js';

/** Shows line `line` (from 0) at the top, the caret at its start. */
export function goToLine(line, { focus = true } = {}) {
  if (deck.open) return goToSlide(Math.max(0, deck.slides.findLastIndex((s) => s.line <= line)));
  if (paged()) return turnToLine(line);
  const t = el.editor;
  const lines = t.value.split('\n');
  const n = Math.max(0, Math.min(line, lines.length - 1));
  const start = lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
  t.setSelectionRange(start, start);
  setAt(n, { goto: true });
  if (state.working) {
    Frames.post(el.preview, { type: 'scroll', line: n });
    return;
  }
  if (focus) t.focus({ preventScroll: true });
  lead();
  t.scrollTop = Math.max(0, measure()[n] - 6);
  scheduleGutter();
  updateCursor();
}

/** Is this Ctrl+G? (⌘G stays the browser's find again.) */
export const isGoTo = (e) => e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g';

let choices = [];
let chosen = 0;
let back = null;     // what had the keyboard before

export function openGoTo() {
  if (state.current?.type !== 'md') return;
  closeOverview();
  back = document.activeElement;
  el.goto.hidden = false;
  el.gotoInput.value = '';
  el.gotoInput.placeholder = deck.open || current().talk ? 'Slide, :line, or a title' : 'Page, :line, or a heading';
  el.gotoInput.focus();
  list();
}

function close({ restore = true } = {}) {
  if (el.goto.hidden) return;
  el.goto.hidden = true;
  el.gotoInput.setAttribute('aria-expanded', 'false');
  el.gotoInput.removeAttribute('aria-activedescendant');
  if (!restore) return;
  if (deck.open) el.deck.focus();
  else back?.focus({ preventScroll: true });
}

/** The places that what's typed could mean. */
function places(q) {
  const { parts, entries, talk } = current();
  const all = flatten(entries);
  const titled = (line) => all.find((e) => e.line === line)?.title ?? '';
  const unit = deck.open || talk ? 'Slide' : 'Page';
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    if (deck.open) {
      const s = deck.slides[n - 1];
      return s ? [{ label: `Slide ${n}`, sub: titled(s.line), run: () => goToSlide(n - 1) }] : [];
    }
    const p = parts[n - 1];
    if (!p || parts.length < 2) return [];
    return [{ label: `${unit} ${n}`, sub: titled(p.line), run: () => (paged() ? turnTo(n - 1) : goToLine(all.find((e) => e.line === p.line)?.head ?? p.line)) }];
  }
  const line = /^:\s*(\d+)$/.exec(q);
  if (line) return [{ label: `Line ${line[1]}`, sub: '', run: () => goToLine(Number(line[1]) - 1) }];
  return find(entries, q).map((e) => ({
    label: e.title,
    sub: `${parts.findIndex((p) => p.line === e.line) >= 0 && parts.length > 1 ? `${unit.toLowerCase()} ${parts.findIndex((p) => p.line === e.line) + 1} · ` : ''}line ${e.head + 1}`,
    depth: q.trim() ? 0 : e.depth,
    run: () => goToLine(e.head),
  }));
}

function list() {
  choices = places(el.gotoInput.value.trim());
  chosen = 0;
  draw();
}

function draw() {
  el.gotoList.replaceChildren(...choices.map((c, i) => {
    const li = document.createElement('li');
    li.className = i === chosen ? 'on' : '';
    li.id = `goto-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === chosen));
    li.style.setProperty('--depth', c.depth || 0);
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = c.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = c.sub;
    li.append(label, sub);
    // Chosen with the mouse without taking the keyboard from the box.
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      choose(i);
    });
    return li;
  }));
  if (!choices.length && el.gotoInput.value.trim()) {
    const li = document.createElement('li');
    li.className = 'none';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-disabled', 'true');
    li.textContent = 'Nothing by that';
    el.gotoList.append(li);
  }
  // The box keeps the keyboard; the place chosen in the list is read from it.
  el.gotoInput.setAttribute('aria-expanded', String(el.gotoList.children.length > 0));
  if (choices[chosen]) el.gotoInput.setAttribute('aria-activedescendant', `goto-${chosen}`);
  else el.gotoInput.removeAttribute('aria-activedescendant');
  el.gotoList.children[chosen]?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const c = choices[i];
  if (!c) return;
  // The editor takes the keyboard, where it was in use; otherwise it goes back where it was.
  const editing = !deck.open && !state.working;
  close({ restore: !editing });
  c.run();
  if (editing) el.editor.focus({ preventScroll: true });
}

export function wireGoTo() {
  el.gotoInput.addEventListener('input', list);
  el.gotoInput.addEventListener('keydown', (e) => {
    // The box's keys are its own, not the editor's or the deck's.
    e.stopPropagation();
    if (e.key === 'Escape' || isGoTo(e)) {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(chosen);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      chosen = Math.max(0, Math.min(choices.length - 1, chosen + (e.key === 'ArrowDown' ? 1 : -1)));
      draw();
    }
  });
  el.gotoInput.addEventListener('blur', () => close({ restore: false }));
}
