/**
 * Presenting: a deck of slides, a step at a time, with a speaker view.
 */

import { el, state, deck, dirty, remember, RENDER_DELAY } from './state.js';
import { api } from './api.js';
import { baseFor } from './render.js';
import { save } from './saving.js';
import { setWorking } from './modes.js';
import { toast } from './status.js';
import * as moves from './moves.js';
import { treatAsDeck } from './fit.js';
import { findScreens, roomScreen, speakerFeatures, placeSpeaker } from './screens.js';
import { mark, drawDone } from './done.js';

//
// A file in the format of https://github.com/maaslalani/slides -- slides
// split by a `---` line, `<!-- -->` comments as speaker notes -- can be shown
// one slide at a time, full window. The speaker view is a second window
// (speaker.html) that follows along over a BroadcastChannel and can drive.
//
// A slide shows one step at a time: each block (paragraph, quote, code,
// table, ...), each list item and each column is a step, in reading order, and a fence
// written `{1-3|5}` takes a step more for each range after its first. A
// slide's opening heading is not a step; it shows with the slide. `n` and
// `p` undo each other exactly, a step at a time, crossing slides at either
// end. `N` shows the rest of the slide, or the next one whole; `P` goes
// back to the start of the slide, or to the start of the previous one. See
// moves.js.
//
// A slide can say how it leaves for the next (`transition`, see
// src/transition.js). Going on from it plays that, and coming back to it
// plays it the other way round; a jump to any other slide is a cut.

/** Present is offered for a file the server says is a deck when it renders it. */
export function updatePresentable(isDeck = false) {
  el.presentBtn.hidden = !(state.current?.type === 'md' && isDeck);
}

export async function present() {
  if (state.current?.type !== 'md' || deck.open) return;
  treatAsDeck();
  if (dirty()) save();
  const line = el.editor.value.slice(0, el.editor.selectionStart).split('\n').length - 1;
  const screens = findScreens();
  if (!(await loadDeck())) return;
  // Start on the slide being edited, so ⌘⇧. shows the one under the cursor.
  deck.index = Math.max(0, deck.slides.findLastIndex((s) => s.line <= line));
  deck.reveal = 0;
  deck.scale = 1;
  deck.open = true;
  el.editor.readOnly = true;
  deck.returnTo = document.activeElement;
  if (document.activeElement === el.editor) el.editor.blur();
  // Out of reach under the slides, for the keyboard and for a screen reader.
  el.bar.inert = el.split.inert = true;
  el.deck.hidden = false;
  el.deck.focus();
  flashKeys();
  // On two screens: the slides full screen on the room's, the speaker view
  // on the laptop's, both from the one press of Present.
  if (await screens) {
    toggleFullscreen();
    openSpeaker();
  }
  announce();
  await showSlide({ say: { title: true } });
}

export async function loadDeck() {
  let out;
  try {
    out = await api('POST', '/api/slides', { text: el.editor.value, path: state.current.path });
  } catch (err) {
    toast(`slides: ${err.message}`, true);
    return false;
  }
  if (!out.slides.length) {
    toast('Nothing to present yet');
    return false;
  }
  deck.slides = out.slides.map((s) => ({ ...s, ...steps(s.body) }));
  deck.css = out.css;
  deck.title = out.title || '';
  deck.meta = out.meta || {};
  deck.end = out.end ?? null;
  deck.index = Math.min(deck.index, deck.slides.length - 1);
  deck.reveal = Math.min(deck.reveal, deck.slides[deck.index].steps);
  overview?.refresh(deck.slides, deck.index);
  el.deckBy.textContent = [deck.meta.author, deck.meta.date].filter(Boolean).join(' · ');
  // Beside it, how many slides are done, as the file has them.
  drawDone(el.deckDone, deck.slides.map((s, i) => mark(s.body, i)));
  if (deck.open) announce();
  return true;
}

// What counts as a step, among the blocks of a slide.
const LIST = 'ul, ol';
const HEADING = /^H[1-6]$/;
const FOCUS = 'pre[data-focus-steps]';

/**
 * Numbers a slide's steps: `data-step="k"` on everything that appears with
 * the k-th press. An aside appears with the last step of the passage it sits
 * beside. Done here, once per deck, so the stage and the speaker view agree.
 * Also the slide's title, heard as the stage says it (spoken.js), for the
 * overview.
 */
export function steps(body) {
  const doc = new DOMParser().parseFromString(`<body>${body}</body>`, 'text/html');
  let n = 0;
  // A title the server set apart (`.slide-title`) is already out of the way.
  let opening = !doc.querySelector('.slide-title');
  for (const pair of doc.querySelectorAll('.gm-pair')) {
    const before = n;
    for (const block of pair.querySelector(':scope > .gm-speaker')?.children || []) {
      if (opening && HEADING.test(block.tagName)) { opening = false; continue; }
      opening = false;
      if (block.matches(LIST)) for (const li of block.querySelectorAll('li')) n = step(li, n);
      else if (block.matches('.columns')) for (const column of block.querySelectorAll(':scope > .column')) n = step(column, n);
      else n = step(block, n);
    }
    if (n === before) continue;
    for (const aside of pair.querySelectorAll(':scope > .gm-asides > *')) aside.dataset.step = n;
  }
  return { body: doc.body.innerHTML, steps: n, title: Spoken.title(doc) };
}

/**
 * Gives `node` the step after `n`, and returns the last step it takes: one,
 * plus one for each further range a fence in it moves through
 * (`data-focus-steps`, from a fence written `{1-3|5}`); of versions of a
 * fence (`::: tabs`), the one that moves through the most.
 */
function step(node, n) {
  node.dataset.step = ++n;
  const fences = node.matches(FOCUS) ? [node] : [...node.querySelectorAll(FOCUS)];
  return n + Math.max(0, ...fences.map((fence) => Number(fence.dataset.focusSteps) - 1));
}

/**
 * Puts the current slide on the stage; with `render: false`, only its reveal.
 * With `say`, the stage says back what it showed: `{ title: true }` for a
 * slide just come to, `{ from }` for the steps after `from`.
 */
export async function showSlide({ render = true, transition, say } = {}) {
  const i = deck.index;
  const slide = deck.slides[i];
  await deck.stageReady;
  if (!deck.open || deck.index !== i) return;
  if (say) say = { ...say, index: i, reveal: deck.reveal };
  Frames.post(el.stage, render
    ? drawing(slide.body, deck.reveal, { title: deck.title, transition, say })
    : { type: 'reveal', reveal: deck.reveal, scale: deck.scale, say });
  el.deckCount.textContent = paging(i);
  // Said aloud as it changes, the slide's number and how far into it; and
  // what showed, once the stage says (revealed).
  el.stage.title = `Slide ${i + 1} of ${deck.slides.length}`;
  if (!say && !overview?.isOpen) el.deckSays.textContent = where();
  // The overview, out while the speaker view moves the deck, rings where it went.
  overview?.mark(i);
  el.deckNotes.innerHTML = slide.notesHtml;
  el.deckNotes.hidden = !deck.notes || !slide.notes;
  deck.channel?.postMessage({ type: 'go', index: i, reveal: deck.reveal });
}

/** The message that draws a slide of this deck (Frames.slide). */
function drawing(body, reveal, more) {
  return Frames.slide({ css: deck.css, base: baseFor(state.current.path), scale: deck.scale }, body, reveal, more);
}

/** Where the deck is: `Slide 2 of 5, step 1 of 4`. */
function where() {
  const slide = deck.slides[deck.index];
  const at = `Slide ${deck.index + 1} of ${deck.slides.length}`;
  return deck.reveal ? `${at}, step ${Math.min(deck.reveal, slide.steps)} of ${slide.steps}` : at;
}

/**
 * The stage showed what it was asked to say: said after where the deck is,
 * unless the deck has moved on, or the overview is out and has the say.
 */
export function revealed({ index, reveal, says }) {
  if (!deck.open || overview?.isOpen || index !== deck.index || reveal !== deck.reveal) return;
  el.deckSays.textContent = says ? `${where()}: ${says}` : where();
}

/** `paging: Slide %d / %d` from the front matter, as `slides` reads it. */
export function paging(i) {
  return Overview.number(deck.meta.paging, i, deck.slides.length);
}

/** Shows slide `i` with `reveal` of its steps; `Infinity` for all of them. */
export function go(i, reveal = 0) {
  if (!deck.open) return;
  const index = Math.min(deck.slides.length - 1, Math.max(0, i));
  const shown = Math.min(deck.slides[index].steps, Math.max(0, reveal));
  if (index === deck.index && shown === deck.reveal) return;
  const render = index !== deck.index;
  const transition = between(deck.index, index);
  // A slide come to says its title, and one come to with steps showing (N,
  // End) what they show too; back onto a slide (p), only its title. A step
  // shown says what's in it. A step hidden shows nothing new, and only where
  // the deck is is said.
  const whole = index > deck.index && shown > 0;
  const say = render ? { title: true, ...(whole && { from: 0 }) } : shown > deck.reveal ? { from: deck.reveal } : undefined;
  deck.index = index;
  deck.reveal = shown;
  showSlide({ render, transition, say });
}

const BACKWARDS = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** The transition from slide `from` to slide `to`, if they're neighbours. */
function between(from, to) {
  if (to === from + 1) return deck.slides[from].transition;
  const leaving = to === from - 1 ? deck.slides[to].transition : null;
  return leaving && (BACKWARDS[leaving] ?? leaving);
}

const move = (to) => {
  const { index, reveal } = to(deck.slides.map((s) => s.steps), deck);
  go(index, reveal);
};

/** n: one more step, or on to the next slide with none of it showing. */
export const next = () => move(moves.next);

/** p: one step fewer, or back to the previous slide with all of it showing. */
export const back = () => move(moves.back);

/** N: the rest of this slide, or the next slide whole. */
export const nextWhole = () => move(moves.nextWhole);

/** P: back to the start of this slide, or to the start of the previous one. */
export const backWhole = () => move(moves.backWhole);

export function closeDeck() {
  if (!deck.open) return;
  overview?.close();
  deck.open = false;
  el.deck.hidden = true;
  el.bar.inert = el.split.inert = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  deck.channel?.postMessage({ type: 'end' });
  setWorking(state.working);
  if (document.activeElement === document.body) (deck.returnTo?.isConnected && deck.returnTo !== document.body ? deck.returnTo : el.presentBtn).focus();
}

// O lays every slide out as a thumbnail, over the stage, to pick one from
// (see static/overview.js): it goes to the slide picked, from its start.
// While it's out, the rest of the deck is out of reach, and the keys are its,
// but for the text size's.
let overview = null;

export function openOverview() {
  overview ??= Overview.create(el.overview, {
    draw: (i) => drawing(deck.slides[i].body, Infinity),
    number: paging,
    say: (text) => { el.deckSays.textContent = text; },
    pick(i) {
      // Where the deck goes is said, as for any slide come to; the slide
      // showing, picked at its start, goes nowhere, and says so too.
      if (i === deck.index && !deck.reveal) showSlide({ render: false, say: { title: true } });
      else go(i, 0);
    },
    closed({ picked }) {
      el.stage.inert = el.deckNotes.inert = el.deckFoot.inert = false;
      if (!deck.open) return;
      el.deck.focus();
      // Put away by Esc, it says where the deck still is; picked, only where it went.
      if (!picked) el.deckSays.textContent = where();
    },
  });
  if (overview.isOpen) return;
  el.stage.inert = el.deckNotes.inert = el.deckFoot.inert = true;
  overview.open(deck.slides, deck.index);
}

/** Closes the overview before another deck-level dialog takes focus. */
export function closeOverview() {
  if (overview?.isOpen) overview.close();
}

/** Redraws the open thumbnails when their rendering context changes. */
export function redrawOverview() {
  overview?.redraw();
}

// The keys in the foot show for a while as the deck opens, and from then
// on while ? keeps them.
const KEYS_FOR = 5000;
let keysTimer = 0;
function flashKeys() {
  el.deck.classList.add('keys-shown');
  clearTimeout(keysTimer);
  keysTimer = setTimeout(() => el.deck.classList.remove('keys-shown'), KEYS_FOR);
}

export function toggleKeys() {
  clearTimeout(keysTimer);
  el.deck.classList.toggle('keys-shown');
}

export function toggleNotes() {
  deck.notes = !deck.notes;
  el.deckNotes.hidden = !deck.notes || !deck.slides[deck.index]?.notes;
  remember('reader:notes', deck.notes ? 'shown' : 'hidden');
}

/** Full screen, on the room's screen when there are two. */
export function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  const room = roomScreen();
  el.deck.requestFullscreen(room ? { screen: room } : undefined).catch(() => {
    toast(room ? `Press F to show the slides full screen on ${room.label || 'the other screen'}` : 'Full screen was refused', true);
  });
}

export function openSpeaker() {
  const w = window.open('/speaker.html', 'reader-speaker', speakerFeatures());
  if (!w) return toast('The speaker view was blocked as a popup. Press S to open it.', true);
  placeSpeaker(w);
  // Where the screens aren't known, say what goes where.
  if (!roomScreen() && window.screen.isExtended !== false) {
    toast('Drag the speaker view to your screen, and this window to the projector (F for full screen)');
  }
}

/** Tell the speaker view everything; it may have just opened. */
export function announce() {
  deck.channel?.postMessage({
    type: 'deck', open: deck.open, css: deck.css, title: deck.title, meta: deck.meta, end: deck.end, index: deck.index, reveal: deck.reveal, scale: deck.scale,
    slides: deck.slides, base: baseFor(state.current.path), path: state.current.path,
  });
}

export function onSpeakerMessage(e) {
  const m = e.data || {};
  if (m.type === 'hello' && deck.open) announce();
  else if (m.type === 'go') go(m.index, m.reveal);
  // The speaker view's keys move the deck, the room's overview out or not.
  else if (m.type === 'key') deckKey(m, { overview: false });
}

// The slides' text size, a step at a time by ⌘+ and ⌘−, through the
// browser's own steps for its zoom; ⌘0 puts it back. It starts at 100% each
// time the deck opens.
const SCALES = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** ⌘+, ⌘− and ⌘0: the slides' text a step bigger, a step smaller, or 100%. True if the key was one of them. */
function sizeKey(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const at = SCALES.indexOf(deck.scale);
  if (e.key === '=' || e.key === '+') resize(SCALES[Math.min(SCALES.length - 1, at + 1)]);
  else if (e.key === '-') resize(SCALES[Math.max(0, at - 1)]);
  else if (e.key === '0') resize(1);
  else return false;
  return true;
}

/**
 * Sets the slides' text size, on the stage and in the speaker view, and says
 * it: only it, as the slide and its steps are where they were.
 */
function resize(scale) {
  deck.scale = scale;
  Frames.post(el.stage, { type: 'reveal', reveal: deck.reveal, scale });
  deck.channel?.postMessage({ type: 'scale', scale });
  overview?.redraw();
  el.deckSays.textContent = `Text ${Math.round(scale * 100)}%`;
}

/** Keys while presenting; with `overview: false`, none of them the overview's. True if the key was the deck's. */
export function deckKey(e, { overview: toOverview = true } = {}) {
  // The text size changes under the overview too, its thumbnails with it.
  if (sizeKey(e)) return true;
  if (overview?.isOpen && toOverview) return overview.key(e);
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  switch (e.key) {
    case 'n': case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'Enter':
      next(); break;
    case 'p': case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace':
      back(); break;
    case 'N': nextWhole(); break;
    case 'P': backWhole(); break;
    case 'o': case 'O': openOverview(); break;
    case 'Home': go(0, 0); break;
    case 'End': go(deck.slides.length - 1, Infinity); break;
    case 'Escape': closeDeck(); break;
    case 't': case 'T': toggleNotes(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 's': case 'S': openSpeaker(); break;
    case '?': toggleKeys(); break;
    // Into the slide, to its boxes, choices, fields and cards; past them, the
    // stage gives the keyboard back to the deck (untab). Nothing else is in
    // reach while presenting.
    case 'Tab':
      el.stage.focus();
      Frames.post(el.stage, { type: 'tab', back: e.shiftKey });
      break;
    default: return false;
  }
  return true;
}

let deckTimer = 0;
export function scheduleDeckReload() {
  clearTimeout(deckTimer);
  // The stage shows the edited slide, at its new step numbers, right away.
  deckTimer = setTimeout(async () => deck.open && (await loadDeck()) && showSlide(), RENDER_DELAY * 3);
}
