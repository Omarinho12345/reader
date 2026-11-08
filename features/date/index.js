/**
 * `date:2026-11-10[]` is a date, read as "November 10, 2026"; words in the
 * brackets are shown instead, and `date:[]` is a blank to pick one into.
 *
 *   Due date:2026-11-10[], a week after date:2026-11-03[the kickoff].
 *
 * A date is a year, a month and a day, with no time or zone. One that isn't
 * a date (`date:2026-02-30[]`) stays as typed, as does one in code.
 *
 * Each carries its line, the line as written and where on it the directive
 * starts, so the preview can show a calendar and write the day picked back
 * in its place. Other features change a line before this one reads it (a
 * task's box, say), so the lines are remembered first, as written, and a
 * date is placed on its line by its count among the dates there.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeExtract, keepWritten, readLines, placeholder, MARKS, splitText, escapeHtml, escapeAttr } from '../source.js';
import { workable } from '../blank.js';

const DATE = /(?<![\w\\])date:(\d{4}-\d{2}-\d{2})?\[([^\]\n]*)\]/g;
const [OPEN, CLOSE] = MARKS.date;
const PLACED = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-11-10` as { year, month, day }, or null if there's no such day. */
export function parseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [year, month, day] = m.slice(1).map(Number);
  // UTC, so the day is the one written whatever zone this runs in.
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCFullYear(year);
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
}

/** `2026-11-10` as "November 10, 2026". */
export function readable(iso) {
  const d = parseDate(iso);
  return d && `${MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
}

/** A date as it's said: the words in its brackets, or else the day it names. */
function spoken(iso, label) {
  return label || readable(iso) || 'pick a date';
}

export function dates(md) {
  keepWritten(md);

  beforeExtract(md, 'date_lines', (state) => {
    const found = [];
    readLines(state, (line, n, lines, i) => {
      const text = state.env.written?.[i] ?? line;
      // Where each date is on the line as written, if they're all still here.
      const cols = [...text.matchAll(DATE)].filter((m) => !m[1] || parseDate(m[1])).map((m) => m.index);
      let k = 0;
      const placed = [];
      const out = line.replace(DATE, (m, iso = '', label) => {
        if (iso && !parseDate(iso)) return m;
        const said = label.trim();
        placed.push({ typed: m, date: iso, label: said, words: spoken(iso, said), line: n, text, col: cols[k++] });
        return placeholder(OPEN, CLOSE, found.length + placed.length - 1);
      });
      // Not all of them: there's no telling which is which, so none is edited.
      if (placed.length !== cols.length) for (const d of placed) d.col = null;
      found.push(...placed);
      return out;
    });
    if (found.length) state.env.dates = found;
  });

  md.core.ruler.push('date_tokens', (state) => {
    const found = state.env.dates;
    if (!found) return;
    splitText(state, PLACED, (k) => {
      if (!found[k]) return null;
      const t = new state.Token('date', 'time', 0);
      t.meta = found[k];
      // The words it's read as, for a line that names something by them.
      t.content = found[k].words;
      return t;
    });
    // Anywhere else (code, the front matter), a date goes back to what was typed.
    const typed = (s) => s.replace(PLACED, (m, k) => found[k]?.typed ?? m);
    const walk = (tokens) => {
      for (const t of tokens) {
        if (t.content) t.content = typed(t.content);
        if (t.children) walk(t.children);
      }
    };
    walk(state.tokens);
    const meta = state.env.frontMatter;
    const all = (o) => {
      for (const key of Object.keys(o)) o[key] = typeof o[key] === 'object' ? all(o[key]) : typed(o[key]);
      return o;
    };
    if (meta && !state.env.nested) all(meta);
  });

  md.renderer.rules.date = (tokens, i, opts, env) => {
    const { date, line, text, col } = tokens[i].meta;
    const shown = escapeHtml(tokens[i].meta.words);
    // What the preview needs to change it, and to be reached by keyboard.
    // Not on a slide, where the deck shows no calendar, nor on an exported
    // page, which has no script to show one with: there it's only read.
    const reached = workable(env) ? ' tabindex="0" role="button" aria-haspopup="dialog"' : '';
    const editable = col == null ? ''
      : ` data-line="${line}" data-col="${col}" data-text="${escapeAttr(text)}"${reached}`;
    return date
      ? `<time class="date" datetime="${date}"${editable}>${shown}</time>`
      : `<span class="date date-blank"${editable}>${shown}</span>`;
  };
}

export default {
  name: 'date',
  plugin: dates,
  css: fs.readFileSync(new URL('./date.css', import.meta.url), 'utf8'),
  // Drawn into the preview frame, for the calendar.
  preview: fileURLToPath(new URL('./preview.js', import.meta.url)),
  // Reads the file as written, before the features that don't.
  raw: true,
};
