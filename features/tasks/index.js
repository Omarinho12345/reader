/**
 * `- [ ]` and `- [x]` at the head of a list item are a checkbox; `- ( )` and
 * `- (x)` a radio button, one choice to a list. They work wherever a list
 * does: in a quote, in an aside. `# [ ]` at the head of a heading is a
 * Done button at the end of its line, for the section under it, or the page
 * of a workbook, being done: by the button, or by everything in the section
 * being done (sectionsDone, below); there's no radio button there.
 *
 * Boxes in a row, `- [x][ ][ ]`, are one box with stages: each click fills
 * the next, and once they're all filled the item is done. The front matter
 * names the stages, for every staged box in the document:
 *
 *   multibox:
 *     stages: have, prepped, used
 *
 *   - [x][x][ ] 1 small yellow onion, diced
 *
 * `reset:[]` is a button that clears every box and field in its section, and
 * puts its puzzles back to their start (`preview:start-over`) -- the
 * heading it's under, to the next at that level or above, and no further than
 * the `---` either side of it, as a page in Work shows no more -- as one edit:
 * `reset:[Start over]` names it. When the section has a heading `Log` in
 * it, a second button adds a heading for today to the end of the log,
 * with the multiple the section's multiplier is at (features/count).
 *
 * Each box carries its line, and that line as it reads checked and
 * unchecked (a staged box, at each stage), so the preview can rewrite it
 * when the box is clicked. A box that doesn't head a list item (say, in an
 * indented code block) stays as typed.
 *
 * Where the page can't be worked (features/blank.js), as on a slide, the
 * boxes are drawn as they stand and can't be changed, and there's no reset.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeExtract, keepWritten, readLines, placeholder, MARKS, unplaced, splitText, sections, multipliers, escapeHtml, escapeAttr, addClass } from '../source.js';
import { schemeRule } from '../scheme.js';
import { workable, shut } from '../blank.js';

const TASK = /^([ \t]*(?:>[ \t]*|~(?![^\s~])[ \t]*|~[^\s~]+[ \t]+)*(?:[-*+]|\d{1,9}[.)])[ \t]+)(?:((?:\[[ xX]\]){1,9})|\(([ xX])\))(?=[ \t]|$)/;
const NAMED = new Set(['field_inline', 'count', 'ingredient_key', 'ingredient_use', 'pitch', 'timer', 'scheme_shown']);
const HEADING = /^( {0,3}#{1,6}[ \t]+)\[([ xX])\](?=[ \t]|$)/;
const [OPEN, CLOSE] = MARKS.tasks;
const PLACED = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');
const DATES = new RegExp(`${MARKS.date[0]}(\\d+)${MARKS.date[1]}`, 'g');
const AT_HEAD = new RegExp(`^${OPEN}(\\d+)${CLOSE}[ \\t]?`);

export function tasks(md) {
  beforeExtract(md, 'task_lines', (state) => {
    const boxes = [];
    readLines(state, (line, n, lines, i) => {
      const written = HEADING.test(line) ? HEADING : TASK;
      // What's written back is the line as it's written, not as another
      // feature has marked it (a blank in it, a field's placeholder).
      const raw = written.test(state.env.written?.[i] ?? '') ? state.env.written[i] : line;
      return line.replace(written, (m, lead, box, radio) => {
        const radioButton = box === undefined;
        // A heading's one box is its mark alone.
        const marks = radioButton ? [radio] : box.length === 1 ? [box] : [...box.matchAll(/\[([ xX])\]/g)].map((b) => b[1]);
        if (marks.length > 1) {
          // At stage k, the first k boxes are filled.
          const at = (k) => raw.replace(written, (t, l) => `${l}${marks.map((_, j) => `[${j < k ? 'x' : ' '}]`).join('')}`);
          const stage = marks.filter((x) => x !== ' ').length;
          const lines = marks.map((_, k) => at(k)).concat(at(marks.length));
          // The line as it's written, whatever order or case its marks are in.
          lines[stage] = raw;
          boxes.push({ line: n, staged: true, stage, checked: stage === marks.length, lines });
        } else {
          const mark = marks[0];
          const checked = mark !== ' ';
          const as = (on) => (checked && on ? raw : raw.replace(written, (t, l, b) => `${l}${b ? '[' : '('}${on ? 'x' : ' '}${b ? ']' : ')'}`));
          boxes.push({ line: n, radio: radioButton, mark, checked, on: as(true), off: as(false) });
        }
        return `${lead}${placeholder(OPEN, CLOSE, boxes.length - 1)}`;
      });
    });
    // Shared with the asides' own parses.
    if (boxes.length) state.env.tasks = { boxes };
  });

  md.core.ruler.push('task_tokens', (state) => {
    const tasks = state.env.tasks;
    if (!tasks) return;
    const tokens = state.tokens;
    // Lists are counted through the whole document, a deck's slides and
    // the asides' own parses, so each list's choices are a group of their own.
    const count = state.env.shared ?? tasks;
    const lists = [];
    const opens = [];
    // A list of choices is a question, answered once one's picked.
    const questions = new Map();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
        lists.push(count.taskLists = (count.taskLists ?? 0) + 1);
        opens.push(t);
      } else if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') {
        lists.pop();
        opens.pop();
      }
      else if (t.type === 'list_item_open' || t.type === 'heading_open') {
        const heading = t.type === 'heading_open';
        const inline = tokens[i + 1]?.type === 'paragraph_open' ? tokens[i + 2] : tokens[i + 1];
        const first = inline?.type === 'inline' ? inline.children?.[0] : null;
        const m = first?.type === 'text' && AT_HEAD.exec(first.content);
        const box = m && tasks.boxes[Number(m[1])];
        if (!box) continue;
        addClass(t, heading ? 'task-heading' : 'task');
        if (box.staged && !heading) addClass(t, box.checked ? 'staged task-done' : 'staged');
        first.content = first.content.slice(m[0].length);
        const input = new state.Token('task_box', 'input', 0);
        input.meta = { ...box, group: lists.at(-1), name: nameOf(inline.children, state.env.dates), heading };
        // A box is a thing to be done; a choice isn't (see source.js's tags).
        if (!box.radio) input.meta.done = box.checked;
        else if (opens.length) questions.set(opens.at(-1), Boolean(questions.get(opens.at(-1)) || box.checked));
        inline.children.unshift(input);
      }
    }
    for (const [list, answered] of questions) {
      list.meta = { ...list.meta, answered };
      list.attrSet('data-answered', String(answered));
    }
    // Anywhere else, a box goes back to what was typed.
    const typed = (k) => {
      const box = tasks.boxes[k];
      if (box.staged) return box.lines[box.stage].match(/(?:\[[ xX]\])+/)[0];
      return box.radio ? `(${box.mark})` : `[${box.mark}]`;
    };
    splitText(state, PLACED, (k) => {
      if (!tasks.boxes[k]) return null;
      const t = new state.Token('text', '', 0);
      t.content = typed(k);
      return t;
    });
    for (const t of tokens) {
      if (t.type === 'code_block' || t.type === 'fence') t.content = t.content.replace(PLACED, (m, k) => typed(Number(k)));
    }
  });

  schemeRule(md, {
    name: 'reset',
    scheme: 'reset',
    path: /(?:)/,
    make: (state, where, label) => {
      if (state) state.push('task_reset', 'button', 0).meta = { label: label.trim() || 'Start over' };
      return true;
    },
  });
  // A reset clears the answers of its section, by their lines in the file;
  // with a log in the section, it can add to it, and say the multiple.
  keepWritten(md);
  md.core.ruler.push('task_reset_sections', (state) => {
    if (state.inlineMode) return;
    const { list, of, lineOf } = sections(state);
    const { bySection, nearest } = multipliers(state, of);
    const breaks = state.tokens.filter((t) => t.type === 'hr' && t.level === 0 && t.map).map(lineOf);
    state.tokens.forEach((block, i) => {
      for (const t of block.children ?? []) {
        if (t.type !== 'task_reset') continue;
        const section = of[i];
        const at = lineOf(block);
        t.meta.from = Math.max(section.line, ...breaks.filter((b) => b < at));
        t.meta.to = Math.min(section.end, ...breaks.filter((b) => b > at));
        t.meta.multiplier = bySection.get(nearest(section));
        const log = list.find((s) => LOG.test(s.title) && s !== section && under(s, section));
        if (log) t.meta.log = { at: logEnd(state, log), level: Math.min(6, log.level + 1) };
      }
    });
  });

  md.renderer.rules.task_reset = (tokens, i, options, env) => {
    // Not where the page can't be worked: an exported page has no script
    // to press it with, and a slide is only shown.
    if (!workable(env)) return '';
    const { label, from, to, log, multiplier } = tokens[i].meta;
    const until = to !== Infinity ? ` data-to="${to}"` : '';
    const reset = `<button type="button" class="task-reset" data-from="${from}"${until}>${escapeHtml(label)}</button>`;
    if (!log) return reset;
    const by = multiplier?.id ? ` data-multiplier="${multiplier.id}"` : '';
    return `${reset} <button type="button" class="task-log" data-at="${log.at}" data-level="${log.level}"${by}>Log today</button>`;
  };

  md.renderer.rules.task_box = (tokens, i, options, env) => {
    if (tokens[i].meta.heading) return doneButton(tokens[i].meta, env);
    if (tokens[i].meta.staged) return stageBox({ ...tokens[i].meta, stages: stagesOf(env), pictured: !workable(env) });
    const { line, radio, checked, on, off, group, name, notExported } = tokens[i].meta;
    // A box another feature shows in its own way (see source.js's tags).
    if (notExported && env.exported) return '';
    const lines = ` data-on="${escapeAttr(on)}" data-off="${escapeAttr(off)}"${name ? ` aria-label="${escapeAttr(name)}"` : ''}${checked ? ' checked' : ''}${shut(env)}`;
    return radio
      ? `<input type="radio" class="choice-box" name="choice-${group}" data-line="${line}"${lines}> `
      : `<input type="checkbox" class="task-box" data-line="${line}" data-done="${checked}"${lines}> `;
  };
}

/**
 * A heading's box, drawn as a Done button at the end of its line: pressed
 * when its section is done (`data-done`), by its own `[x]` (`data-own`) or
 * by its parts all being done (`data-full`). Done by its parts, pressing it
 * changes nothing, so it says so (`aria-disabled`); to undo that, a part is
 * undone. Its words are its style's, so the heading's own text is its title
 * alone, for whatever reads it (the outline, a page's name in Work).
 */
function doneButton({ line, on, off, checked, done = checked, full = false, name }, env) {
  const label = name ? `Done: ${name}` : 'Done';
  return `<button type="button" class="section-done" data-line="${line}" data-done="${done}" data-own="${checked}" data-full="${full}"`
    + ` data-on="${escapeAttr(on)}" data-off="${escapeAttr(off)}" aria-label="${escapeAttr(label)}" aria-pressed="${done}"`
    + `${full ? ' aria-disabled="true"' : ''}${shut(env)}></button>`;
}

/**
 * Once every feature has said what's to be done on the page (see
 * source.js's tags), each section with a box says whether it's done: by its
 * own `[x]`, or by everything in it that can be done being done, the things
 * to be done and the questions, and the sections with boxes under it, which
 * count as one part each. A section with nothing in it to be done is done
 * only by its own box. Its title is set apart from the button, which goes
 * at the end of its line.
 */
function sectionsDone(md) {
  md.core.ruler.push('task_sections', (state) => {
    if (state.inlineMode || state.env.nested || !state.env.tasks) return;
    const { of } = sections(state);
    // Each section with a box, by its box's token, and the parts it holds.
    const boxes = new Map();
    const parts = [];
    state.tokens.forEach((block, i) => {
      const heading = state.tokens[i - 1]?.type === 'heading_open';
      for (const t of [block, ...(block.children ?? [])]) {
        if (heading && t.type === 'task_box' && t.meta.heading) boxes.set(of[i], { box: t, inline: block, parts: [] });
        else if (typeof t.meta?.done === 'boolean') parts.push({ section: of[i], done: () => t.meta.done });
        else if (typeof t.meta?.answered === 'boolean') parts.push({ section: of[i], done: () => t.meta.answered });
      }
    });
    if (!boxes.size) return;
    // The nearest section with a box that `s` is in, itself first.
    const holder = (s) => {
      for (; s; s = s.parent) if (boxes.has(s)) return boxes.get(s);
      return null;
    };
    for (const p of parts) holder(p.section)?.parts.push(p);
    for (const [section, own] of boxes) holder(section.parent)?.parts.push({ done: () => isDone(own) });
    const isDone = (own) => {
      if (own.full === undefined) own.full = own.parts.length > 0 && own.parts.every((p) => p.done());
      return own.box.meta.checked || own.full;
    };
    for (const own of boxes.values()) {
      const { box, inline } = own;
      box.meta.done = isDone(own);
      box.meta.full = own.full;
      const title = inline.children.filter((t) => t !== box);
      const open = new state.Token('task_title_open', 'span', 1);
      open.attrSet('class', 'section-title');
      inline.children = [open, ...title, new state.Token('task_title_close', 'span', -1), box];
    }
  });
}

const LOG = /^log$/i;
const BLANK = /^\s*(?:(?:[-*_][ \t]*){3,})?$/;

/** Whether section `s` is inside `around`. */
function under(s, around) {
  for (let p = s.parent; p; p = p.parent) if (p === around) return true;
  return false;
}

/** The line after a log's last entry: past it are only blank lines, or a rule before what's next. */
function logEnd(state, log) {
  const base = state.env.lineBase ?? 0;
  const lines = state.env.written ?? state.src.split('\n');
  let end = Math.min(log.end, base + lines.length);
  while (end - 1 > log.line && BLANK.test(lines[end - 1 - base] ?? '')) end--;
  return end;
}

/**
 * The stages' names the front matter gives, `multibox: stages:`, or a
 * slide's deck's; null when it gives none.
 */
function stagesOf(env) {
  const named = env.frontMatter?.multibox?.stages || env.matter?.multibox?.stages;
  return typeof named === 'string' && named.trim() ? named.split(',').map((p) => p.trim()) : null;
}

/**
 * A box with stages, drawn as a pip for each, those reached filled; its
 * stage named when the front matter names it. Where it can't be filled
 * (`pictured`), as on a slide or an exported page, only a picture of one.
 */
function stageBox({ line, stage, lines, stages, name, pictured }) {
  const n = lines.length - 1;
  const called = (k) => stages?.[k - 1] ?? `${k} of ${n}`;
  const now = stage ? called(stage) : 'not started';
  const label = `${name ? `${name}: ` : ''}${now}${stages?.[stage - 1] ? ` (${stage} of ${n})` : ''}`;
  const next = stage < n ? `; next, ${called(stage + 1)}` : '';
  const pips = lines.slice(1).map((_, k) => `<i${k < stage ? ' class="on"' : ''}></i>`).join('');
  const shown = stages?.[stage - 1] && stage < n ? ` <span class="stage-name">${escapeHtml(stages[stage - 1])}</span>` : '';
  // Where it can't be filled, it only says how far it's got.
  if (pictured) return `<span class="stage-box" role="img" aria-label="${escapeAttr(label)}" title="${escapeAttr(now)}" data-done="${stage === n}">${pips}</span>${shown} `;
  return `<button type="button" class="stage-box" role="checkbox" aria-checked="${stage === n ? 'true' : stage ? 'mixed' : 'false'}"`
    + ` aria-label="${escapeAttr(label)}" title="${escapeAttr(`${now}${next}`)}" data-line="${line}" data-stage="${stage}" data-done="${stage === n}"`
    + ` data-lines="${escapeAttr(JSON.stringify(lines))}">${pips}</button>${shown} `;
}

/**
 * What a box is for, as a screen reader says it: the words beside it. A
 * label around them would make every link among them tick the box too.
 */
function nameOf(children, dates) {
  // Words other features set apart (a count, an ingredient, a note, a timer)
  // carry theirs too, and a date the words it's read as: it's placed after
  // this, so its words come from what it found on the line.
  // A line break between them is a space, so two lines don't run together.
  const said = children.filter((t) => t.type === 'text' || t.type === 'code_inline' || t.type === 'softbreak' || t.type === 'hardbreak' || NAMED.has(t.type))
    .map((t) => (t.type.endsWith('break') ? ' ' : t.content))
    .join('')
    .replace(DATES, (m, k) => dates?.[k]?.words ?? m);
  return unplaced(said).replace(/\s+/g, ' ').trim();
}

export default {
  name: 'tasks',
  plugin: tasks,
  css: fs.readFileSync(new URL('./tasks.css', import.meta.url), 'utf8'),
  // Drawn into the preview frame, to make it clickable.
  preview: fileURLToPath(new URL('./preview.js', import.meta.url)),
  // Reads the file as written, before the features that don't.
  raw: true,
  // Says which sections are done once the rest have said what's done in them.
  late: sectionsDone,
};
