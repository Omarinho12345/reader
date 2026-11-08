import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { slides, pages, split, lift, isDeck } from '../src/slides.js';

const DECK = `---
author: Josh
paging: "Slide %d of %d"
---

# One

<!-- say hello -->

---

## Two

\`\`\`yaml
---
key: value
---
<!-- not a note -->
\`\`\`

---

<!--
  only notes,
    indented
-->
`;

test('front matter is read, and --- lines split slides', () => {
  const { meta, slides: s } = split(DECK);
  assert.deepEqual(meta, { author: 'Josh', paging: 'Slide %d of %d' });
  assert.equal(s.length, 3);
  assert.match(s[0].text, /# One/);
  assert.equal(DECK.split('\n')[s[1].line], '');
  assert.match(s[1].text, /key: value/, 'a --- inside a code fence does not split');
});

test('a leading --- that is not front matter is not swallowed', () => {
  const { meta, slides: s } = split('---\n\n# Hello there\n\nSome prose.\n\n---\n\n# Two\n');
  assert.deepEqual(meta, {});
  assert.equal(s.length, 2);
  assert.match(s[0].text, /Hello there/);
});

test('HTML comments become notes, except in code', () => {
  const { body, notes } = lift('# Hi\n\n<!-- first -->\n\ntext\n\n<!--\n  second\n    deeper\n-->\n');
  assert.doesNotMatch(body, /<!--|first|second/);
  assert.match(body, /text/);
  assert.equal(notes, 'first\n\nsecond\n  deeper');

  const code = lift('```\n<!-- kept -->\n```\n');
  assert.match(code.body, /kept/);
  assert.equal(code.notes, '');
});

test('slides renders each slide without a masthead and keeps its notes', () => {
  const out = slides(DECK, { file: 'talk/slides.md' });
  assert.equal(out.title, 'slides');
  assert.equal(out.slides.length, 3);
  assert.doesNotMatch(out.slides[0].body, /gm-masthead|gm-title/);
  assert.match(out.slides[0].body, /<h1[^>]*>One<\/h1>/);
  assert.equal(out.slides[0].notes, 'say hello');
  assert.equal(out.slides[0].notesHtml, '<p>say hello</p>');
  // Still in the fence, as highlighted code.
  assert.match(out.slides[1].body.replace(/<\/?span[^>]*>/g, ''), /&lt;!-- not a note --&gt;/);
  assert.equal(out.slides[1].notes, '');
  assert.equal(out.slides[2].notes, 'only notes,\n  indented');
  assert.match(out.css, /--gm-base: calc\(clamp/);
});

test('a slide\'s text fills the window, times the deck\'s own text size', () => {
  const [min, vw, vh, max, scale] = /--gm-base: calc\(clamp\(([\d.]+)px, min\(([\d.]+)vw, ([\d.]+)vh\), ([\d.]+)px\) \* var\(--reader-text-scale, ([\d.]+)\)\)/
    .exec(slides('# One\n').css).slice(1).map(Number);
  // On a screen `w`×`h`, with the deck's text at `k`: how big it looks.
  const looks = (w, h, k = scale) => k * Math.min(Math.max(min, Math.min(vw * w, vh * h) / 100), max);
  // 40px on a 1920×1080 projector, and 2.1vw on the speaker view's 1280×720.
  assert.ok(Math.abs(looks(1920, 1080) - 40) < 0.1);
  assert.ok(Math.abs(looks(1280, 720) - 26.88) < 0.1);
  assert.ok(Math.abs(looks(1280, 900) - 26.88) < 0.1);
  assert.ok(Math.abs(looks(1600, 720) - 26.88) < 0.1);
  // ⌘+ to 125% makes it a quarter bigger again.
  assert.ok(Math.abs(looks(1920, 1080, 1.25) - 50) < 0.1);
});

test('a slide grown to fill the screen keeps its title and its code at their size', async () => {
  const css = await readFile(new URL('../static/preview.css', import.meta.url), 'utf8');
  assert.match(css, /\.deck \.gm-doc > \* \{ zoom: var\(--fit, 1\); \}/, 'what is on a slide grows with it');
  assert.match(css, /\.deck \.gm-doc > \.slide-title \{ zoom: min\(var\(--fit, 1\), 1\); \}/, 'its title shrinks with it, but doesn\'t grow');
  assert.match(css, /\.deck \.gm-doc pre \{ zoom: calc\(1 \/ max\(var\(--fit, 1\), 1\)\); \}/, 'its code is grown back to its size');
});

test('a slide\'s opening heading is set apart from the rest; one that\'s all headings is a cover, and one with none is all body', () => {
  const out = slides([
    '# Title\n\n> a quote\n',
    '# Talk\n## Subtitle\n',
    'No title here.\n',
    '## T\n\n~ about the title\n\n- a\n',
  ].join('\n---\n\n'));
  const [quote, cover, plain, noted] = out.slides;
  assert.match(quote.body, /^<div class="gm-doc">\s*<header class="slide-title">\n<h1>Title<\/h1>\n<\/header>\n<div class="slide-body">\n<section class="gm-pair">\n<div class="gm-speaker">\n<blockquote>/);
  assert.match(quote.body, /<\/section>\n<\/div>\n<\/div>$/);
  assert.equal(quote.body.match(/<h1>/g).length, 1);
  assert.doesNotMatch(cover.body, /slide-title|slide-body/);
  assert.match(cover.body, /^<div class="gm-doc slide-cover">/);
  assert.doesNotMatch(plain.body, /slide-title|slide-cover/);
  assert.match(plain.body, /^<div class="gm-doc">\n<div class="slide-body">\n<section class="gm-pair">\n<div class="gm-speaker">\n<p>No title here\.<\/p>/);
  assert.equal(plain.body.match(/<div\b/g).length, plain.body.match(/<\/div>/g).length);
  assert.doesNotMatch(quote.body, /slide-cover/);
  // An aside written against the title keeps its row.
  assert.match(noted.body, /<div class="slide-body">\n<section class="gm-pair">\n<div class="gm-speaker">\n<\/div>\n<div class="gm-asides">/);
});

test('a slide\'s body is centered across as a block, unless it holds a form, puzzle or columns, or asides; a cover\'s text is centered', () => {
  const { css } = slides('# One\n');
  const rule = /:root \.gm-doc:not\(:has\(\.gm-asides, \.field:not\(\.field-inline\)\)\) \.slide-body:not\(:has\(> \.gm-pair > \.gm-speaker > :not\(([^)]*)\)\)\) \{\s*align-self: center; width: fit-content; max-width: 100%;\s*\}/.exec(css);
  assert.ok(rule, 'the body is a block as wide as what\'s in it, in the middle');
  // What's laid out as text is; anything else, a field or a puzzle, keeps the slide's width.
  const text = rule[1].split(/,\s*/);
  for (const kind of ['p', 'ul', 'ol', 'blockquote', 'pre', 'table', 'figure', 'h2', '.headline', '.number']) assert.ok(text.includes(kind), kind);
  for (const kind of ['div', '.field', '.columns']) assert.ok(!text.includes(kind), kind);
  assert.match(css, /:root \.slide-cover \{ text-align: center; \}/);
});

test('a title alone in its row leaves no empty row behind', () => {
  const { body } = slides('# Title\n\n- a\n\n~ aside\n\n- b\n\n---\n\n# Two\n').slides[0];
  assert.match(body, /<div class="slide-body">\n<section class="gm-pair">\n<div class="gm-speaker">\n<ul>/);
  assert.equal(body.match(/<div class="gm-|<div class="slide-|<div>/g).length, body.match(/<\/div>/g).length);
});

test('isDeck goes by type:, not by --- or notes', () => {
  assert.equal(isDeck(DECK), false);
  assert.equal(isDeck(`---\ntype: slides\n${DECK.slice(4)}`), true);
  assert.equal(isDeck('---\ntype: Workbook\n---\n\n# One page\n'), true);
  assert.equal(isDeck('---\ntype: notes\n---\n\n# One\n\n---\n\n# Two\n'), false);
  assert.equal(isDeck('# a note\n\nwith prose\n'), false);
});

test('puzzles are numbered across the whole deck', () => {
  const out = slides('```sudoku\n.\n```\n\n---\n\n# Two\n\n```sudoku\n.\n```\n');
  assert.match(out.slides[0].body, /data-puzzle="0"/);
  assert.match(out.slides[1].body, /data-puzzle="1"/);
});

test("each page's tabs and choices have names of their own across the deck", () => {
  const page = '::: tabs\n```java\na\n```\n\n```kotlin\nb\n```\n:::\n\n- ( ) yes\n- ( ) no\n';
  const deck = `${page}\n---\n\n${page}`;
  const names = (body) => [...new Set([...body.matchAll(/type="radio" class="(?:tab-pick|choice-box)" name="([^"]+)"/g)].map((m) => m[1]))];
  for (const out of [slides(deck).slides, pages(deck).pages]) {
    const [one, two] = out.map((s) => names(s.body));
    assert.equal(one.length, 2);
    assert.equal(two.length, 2);
    assert.deepEqual(one.filter((n) => two.includes(n)), [], 'no name is used on two pages');
  }
});

test('notes leave their lines behind, so a slide knows its lines in the file', () => {
  const { body } = lift('# Hi\n\n<!--\n  a note\n-->\n\n- [ ] task\n');
  assert.equal(body.split('\n').length, 8);
  assert.equal(body.split('\n')[6], '- [ ] task');

  const out = slides('# One\n\n---\n\n# Two\n\n<!--\n  a note\n-->\n\n- [ ] task\n@ Name: x\n');
  assert.match(out.slides[1].body, /class="task-box" data-line="10"/);
  assert.match(out.slides[1].body, /class="field" data-line="11"/);
});

test('blank lines in a slide\'s code are kept', () => {
  const { body } = lift('```\na\n\n\n\nb\n```\n');
  assert.match(body, /a\n\n\n\nb/);
});

test('notes are rendered as markdown', () => {
  const out = slides('# One\n\n<!--\n1. Open `server.js:37`, *slowly*.\n2. Then the rest.\n-->\n');
  assert.equal(out.slides[0].notesHtml, '<ol>\n<li>Open <code>server.js:37</code>, <em>slowly</em>.</li>\n<li>Then the rest.</li>\n</ol>');
});

test('a deck worked through is a page to a slide, drawn as a document, without its notes', () => {
  const out = pages('---\ntitle: T\n---\n# One\n\n<!-- a note -->\n\n---\n\n<!-- only a note -->\n\n---\n\n# Two\n\n- [ ] task\n');
  assert.equal(out.pages.length, 2);
  assert.deepEqual(out.pages.map((p) => p.line), [3, 12]);
  assert.match(out.pages[1].body, /class="task-box" data-line="15"/);
  assert.match(out.pages[1].body, /<h1 data-line="13">Two<\/h1>/);
  assert.doesNotMatch(out.pages[0].body, /a note|gm-masthead|slide-title/);
  assert.doesNotMatch(out.css, /:root body \{ overflow: hidden; \}/);
});

test("a slide's transition is its notes', or the deck's, or none, and isn't shown with the notes", () => {
  const out = slides('---\ntransition: Fade\n---\n# One\n\n<!--\nsay hi\ntransition: up\n-->\n\n---\n\n# Two\n\n<!-- transition: now the demo -->\n\n---\n\n# Three\n');
  assert.deepEqual(out.slides.map((s) => s.transition), ['up', 'fade', 'fade']);
  assert.equal(out.slides[0].notes, 'say hi');
  assert.equal(out.slides[1].notes, 'transition: now the demo');
  assert.deepEqual(slides('# One\n\n---\n\n# Two\n').slides.map((s) => s.transition), ['none', 'none']);
});
