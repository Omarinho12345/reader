import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { render } from '../../src/render.js';
import { slides } from '../../src/slides.js';
import tasks from './index.js';

test('task items become checkboxes that know their line', () => {
  const { body } = render('# todo\n\n- [ ] take out the trash\n- [x] dishes\n\n1. [X] done\n');
  assert.match(body, /<li class="task"><input type="checkbox" class="task-box" data-line="2" [^>]*> take out the trash<\/li>/);
  assert.match(body, /<li class="task"><input type="checkbox" class="task-box" data-line="3" [^>]* checked> dishes<\/li>/);
  assert.match(body, /data-line="5" [^>]* checked> done/);
});

test('a task box knows its line checked and unchecked, as written', () => {
  const { body } = render('- [ ] trash\n- [X] dishes\n- ( ) red\n');
  assert.match(body, /data-line="0" data-done="false" data-on="- \[x\] trash" data-off="- \[ \] trash" aria-label="trash">/);
  assert.match(body, /data-line="1" data-done="true" data-on="- \[X\] dishes" data-off="- \[ \] dishes" aria-label="dishes" checked>/);
  assert.match(body, /data-line="2" data-on="- \(x\) red" data-off="- \( \) red" aria-label="red">/);
});

test('a long run of > and ~ before a line is read in a moment', () => {
  const start = performance.now();
  render(`${'~>\t'.repeat(40)}x\n`);
  assert.ok(performance.now() - start < 1000);
});

test('a box is named by the words beside it, for a screen reader', () => {
  const { body } = render('- [ ] call [mom](https://example.com) about `code`\n- ( ) Sat AM\n');
  assert.match(body, /class="task-box" [^>]*aria-label="call mom about code"/);
  assert.match(body, /class="choice-box" [^>]*aria-label="Sat AM"/);
});

test('a box is named by the date written in its line', () => {
  const { body } = render('- [ ] Call on date:2026-11-10[]\n- [ ] Kick off date:2026-11-03[the kickoff]\n');
  assert.match(body, /class="task-box" [^>]*aria-label="Call on November 10, 2026"/);
  assert.match(body, /class="task-box" [^>]*aria-label="Kick off the kickoff"/);
});

test('choice items become radio buttons, one group to a list', () => {
  const { body } = render('- ( ) red\n- (x) blue\n  - ( ) navy\n  - ( ) sky\n- ( ) green\n\ntext\n\n- ( ) yes\n- ( ) no\n');
  assert.match(body, /<li class="task"><input type="radio" class="choice-box" name="choice-1" data-line="0" [^>]*> red<\/li>/);
  assert.match(body, /name="choice-1" data-line="1" [^>]* checked> blue/);
  assert.match(body, /name="choice-2" data-line="2" [^>]*> navy/);
  assert.match(body, /name="choice-2" data-line="3" [^>]*> sky/);
  assert.match(body, /name="choice-1" data-line="4" [^>]*> green/);
  assert.match(body, /name="choice-3" data-line="8" [^>]*> yes/);
  assert.match(body, /name="choice-3" data-line="9" [^>]*> no/);
});

test('a list of choices is a question, and says whether one is picked', () => {
  const { body } = render('- ( ) red\n- (x) blue\n  - ( ) navy\n  - ( ) sky\n- ( ) green\n\ntext\n\n- [ ] trash\n');
  assert.match(body, /<ul data-answered="true">\n<li class="task"><input type="radio"[^>]*> red/);
  assert.match(body, /<ul data-answered="false">\n<li class="task"><input type="radio"[^>]*> navy/);
  assert.equal(body.match(/data-answered/g).length, 2, 'a list of boxes is no question');
  // A choice isn't a thing to be done, so a bar doesn't count it.
  assert.match(render('progress:[] done\n\n- (x) red\n- [ ] trash\n').body, /0 of 1/);
});

test('choice boxes not heading a list item are left as typed', () => {
  const { body } = render('```\n- ( ) fenced\n```\n\na ( ) b\n\n- ( )x\n');
  assert.doesNotMatch(body, /radio/);
  assert.match(body, /- \( \) fenced/);
  assert.match(body, /a \( \) b/);
});

test('task boxes in code, or not heading a list item, are left as typed', () => {
  const { body } = render('```\n- [ ] fenced\n```\n\nText\n\n    - [ ] indented\n\na [ ] b\n\n- [ ]x\n');
  assert.doesNotMatch(body, /checkbox/);
  assert.match(body, /- \[ \] fenced/);
  assert.match(body, /- \[ \] indented/);
  assert.match(body, /a \[ \] b/);
  assert.doesNotMatch(body, /[\uE000\uE001]/);
});

test('a box in an aside knows its line in the file', () => {
  const { body } = render('text\n~ - [ ] in the aside\n', { line: 10 });
  assert.match(body, /<li class="task"><input type="checkbox" class="task-box" data-line="11" data-done="false" data-on="~ - \[x\] in the aside" data-off="~ - \[ \] in the aside" aria-label="in the aside"> in the aside<\/li>/);
});

test('a list of radio buttons split by an aside is still one choice', () => {
  const { body } = render('- ( ) red\n~ a thought\n- (x) blue\n');
  const names = [...body.matchAll(/class="choice-box" name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 2);
  assert.equal(names[0], names[1]);
});

test('boxes on a slide know their lines in the file', () => {
  const out = slides('# One\n\n---\n\n- [ ] here\n');
  assert.match(out.slides[1].body, /data-line="4" data-done="false" data-on="- \[x\] here"/);
});

test('on a slide, every box and choice is drawn as it stands and can\'t be changed, and there\'s no reset', () => {
  const md = '---\nmultibox:\n  stages: have, prepped, used\n---\n\n## [x] Prep\nreset:[]\n\n- [x] oil\n- [ ] salt\n\n- ( ) tea\n- (x) coffee\n\n* [x][ ][ ] onion\n';
  const { body } = slides(`${md}\n---\n\n# Next\n`).slides[0];
  const inputs = body.match(/<input [^>]*>|<button type="button" class="section-done"[^>]*>/g);
  assert.equal(inputs.length, 5);
  for (const input of inputs) assert.match(input, / disabled>$/);
  assert.match(body, /<span class="section-title">Prep<\/span><button type="button" class="section-done" data-line="5" data-done="true" [^>]* aria-pressed="true" disabled><\/button>/);
  assert.match(body, /<input type="radio" class="choice-box" name="choice-\d+" [^>]*aria-label="coffee" checked disabled>/);
  assert.match(body, /<span class="stage-box" role="img" aria-label="onion: have \(1 of 3\)" title="have" data-done="false">/);
  assert.doesNotMatch(body, /<button(?! type="button" class="section-done")|task-reset/);
  const page = render(md).body;
  assert.doesNotMatch(page, /disabled/, 'in the editor, every one can be changed');
  assert.match(page, /<button type="button" class="stage-box"/);
  assert.match(page, /class="task-reset"/);
});

test('the stylesheet comes with the feature', () => {
  assert.match(render('- [ ] x\n').css, /li\.task \{ list-style: none; \}/);
});

test('done tasks are in the done ink, at full opacity', () => {
  const rule = render('- [x] done\n').css.match(/li\.task-done \{[^}]+\}/)?.[0];
  assert.match(rule, /color: var\(--gm-ink-done\)/);
  assert.doesNotMatch(rule, /opacity/);
});

test('a Done pill takes a click 24px tall, past what it draws', () => {
  const { css } = render('# [ ] Gratitude\n');
  const rule = css.match(/\.section-done::before \{[^}]+\}/)?.[0];
  assert.match(rule, /position: absolute/);
  assert.match(rule, /height: max\(100%, 24px\)/);
  assert.match(css, /\.section-done \{ position: relative; \}/);
});

test('a box at the head of a heading is a Done button at the end of its line, and knows its line', () => {
  const { body } = render('# [ ] Gratitude\n\n# [x] Ways\n');
  assert.match(body, /<h1 class="task-heading"[^>]*><span class="section-title">Gratitude<\/span><button type="button" class="section-done" data-line="0" data-done="false" data-own="false" data-full="false" data-on="# \[x\] Gratitude" data-off="# \[ \] Gratitude" aria-label="Done: Gratitude" aria-pressed="false"><\/button><\/h1>/);
  assert.match(body, /<h1 class="task-heading"[^>]*><span class="section-title">Ways<\/span><button [^>]*data-line="2" data-done="true" data-own="true" [^>]*aria-pressed="true"><\/button><\/h1>/);
  assert.doesNotMatch(body, /<input/, 'no box before its title');
});

test('a section is done when everything in it to be done is, a section under it with a box counting as one', () => {
  const doneOf = (md) => [...render(md).body.matchAll(/class="section-done" data-line="(\d+)" data-done="(\w+)" data-own="\w+" data-full="(\w+)"[^>]*>/g)]
    .map(([, line, done, full]) => [Number(line), done === 'true', full === 'true']);
  const day = (a, b, pick) => `# [ ] Today\n\n- ${pick} Navy Day\n- ( ) Heritage\n\n## [ ] Ways\n\n- [${a}] Read\n- [${b}] Watch\n`;
  assert.deepEqual(doneOf(day(' ', 'x', '( )')), [[0, false, false], [5, false, false]]);
  assert.deepEqual(doneOf(day('x', 'x', '( )')), [[0, false, false], [5, true, true]], 'its tasks done, Ways is; no celebration picked, Today isn\'t');
  assert.deepEqual(doneOf(day('x', 'x', '(x)')), [[0, true, true], [5, true, true]]);
  // A section under it ticked itself counts as done, whatever's in it.
  assert.deepEqual(doneOf('# [ ] Today\n\n## [x] Ways\n\n- [ ] Read\n'), [[0, true, true], [2, true, false]]);
  // A heading with no box is only a part of the section it's in.
  assert.deepEqual(doneOf('# [ ] Today\n\n## Notes\n\n- [x] Read\n\n# Next\n\n- [ ] Later\n'), [[0, true, true]]);
  // With nothing in it to be done, a section is done only by its own box.
  assert.deepEqual(doneOf('# [ ] Empty\n\nWords.\n\n# [x] Ticked\n'), [[0, false, false], [4, true, false]]);
  // Done by what's in it, its button says pressing it would change nothing.
  assert.match(render(day('x', 'x', '( )')).body, /data-line="5"[^>]* aria-pressed="true" aria-disabled="true">/);
});

test('a heading has no radio button, and an escaped box stays as typed', () => {
  const { body } = render('# ( ) one\n\n# \\[ ] two\n');
  assert.doesNotMatch(body, /<input/);
  assert.match(body, /<h1[^>]*>\( \) one<\/h1>/);
  assert.match(body, /<h1[^>]*>\[ \] two<\/h1>/);
});

const lines = (body) => [...body.matchAll(/data-lines="([^"]*)"/g)].map((m) => JSON.parse(m[1].replace(/&quot;/g, '"')));

test('boxes in a row are one box with stages, knowing its line at each', () => {
  const { body } = render('- [x][ ][ ] onion\n- [X][x] garlic\n');
  assert.match(body, /<li class="task staged"><button type="button" class="stage-box" role="checkbox" aria-checked="mixed" aria-label="onion: 1 of 3" title="1 of 3; next, 2 of 3" data-line="0" data-stage="1" [^>]*><i class="on"><\/i><i><\/i><i><\/i><\/button> onion<\/li>/);
  assert.deepEqual(lines(body)[0], ['- [ ][ ][ ] onion', '- [x][ ][ ] onion', '- [x][x][ ] onion', '- [x][x][x] onion']);
  // Full, the item is done; its own line is kept as written.
  assert.match(body, /<li class="task staged task-done"><button [^>]*aria-checked="true"/);
  assert.deepEqual(lines(body)[1], ['- [ ][ ] garlic', '- [x][ ] garlic', '- [X][x] garlic']);
});

test('the front matter names the stages of every staged box', () => {
  const { body } = render('---\nmultibox:\n  stages: have, prepped, used\n---\n\n- [x][x][ ] onion\n- [ ][ ][ ] salt\n\n## Next\n- [x][ ][ ] other\n- [x][ ] two\n');
  assert.match(body, /aria-label="onion: prepped \(2 of 3\)" title="prepped; next, used"/);
  assert.match(body, /<\/button> <span class="stage-name">prepped<\/span> onion/);
  assert.match(body, /aria-label="salt: not started" title="not started; next, have"/);
  assert.match(body, /aria-label="other: have \(1 of 3\)"/);
  // A setting, not something said in the byline.
  assert.doesNotMatch(body, /multibox/);
});

test('a line starting Phases: is prose', () => {
  const { body } = render('The project has three parts.\nPhases: discovery, design, delivery\n\n- [x][ ][ ] discovery\n');
  assert.match(body, /Phases: discovery, design, delivery/);
  assert.match(body, /aria-label="discovery: 1 of 3"/);
});

test('a slide takes its stages from the deck', () => {
  const out = slides('---\ntype: slides\nmultibox:\n  stages: have, used\n---\n\n# One\n\n- [x][ ] onion\n');
  assert.match(out.slides[0].body, /aria-label="onion: have \(1 of 2\)"/);
});

test('a staged box in code stays as typed', () => {
  const { body } = render('```\n- [x][ ] fenced\n```\n');
  assert.match(body, /- \[x\]\[ \] fenced/);
});

test('reset:[] is a button for the boxes of its section', () => {
  const { body } = render('## Beans\nreset:[]\n\n- [x] oil\n\n## Yam\nreset:[Again]\n- [ ] water\n');
  assert.match(body, /<button type="button" class="task-reset" data-from="0" data-to="5">Start over<\/button>/);
  assert.match(body, /<button type="button" class="task-reset" data-from="5">Again<\/button>/);
});

test('reset:[] in a recipe with a log can add to it, after its last entry', () => {
  const src = '## Akara\nmultiplier:[]\nreset:[]\n\n### Steps\n1) [ ] fry\n\n### Log\n#### date:2026-10-01[]\nGood (Ana): yum\n\n---\n\n## Yam\nreset:[]\n';
  const { body } = render(src);
  assert.match(body, /class="task-reset" data-from="0" data-to="11">Start over<\/button> <button type="button" class="task-log" data-at="10" data-level="4" data-multiplier="1">Log today<\/button>/);
  assert.match(body, /class="task-reset" data-from="13">Start over<\/button><\/p>/);
});

test('an empty log is added to under its heading', () => {
  const { body } = render('## Yam\nreset:[]\n\n## Log\n\n## Akara\n');
  assert.doesNotMatch(body, /task-log/);
  const nested = render('## Yam\nreset:[]\n\n### Log\n\n## Akara\n').body;
  assert.match(nested, /class="task-log" data-at="4" data-level="4">/);
});

test('an exported page\'s staged box is a picture of how far it\'s got, not a control', () => {
  const md = '---\nmultibox:\n  stages: have, prepped, used\n---\n\n* [x][ ][ ] onion\n* [ ] salt\n';
  const { body } = render(md, { exported: true });
  assert.match(body, /<span class="stage-box" role="img" aria-label="onion: have \(1 of 3\)" title="have" data-done="false"><i class="on"><\/i><i><\/i><i><\/i><\/span> <span class="stage-name">have<\/span>/);
  assert.doesNotMatch(body, /<button/);
  assert.match(body, /<input type="checkbox" class="task-box"[^>]*> salt/, 'a plain box can still be ticked, on paper or on screen');
  assert.doesNotMatch(body, /disabled/);
});

test('an exported page draws no box another feature has tagged notExported, whichever feature that is', () => {
  const md = new MarkdownIt().use(tasks.plugin);
  md.core.ruler.push('elsewhere', (state) => {
    for (const t of state.tokens) for (const c of t.children ?? []) if (c.type === 'task_box' && c.meta.checked) c.meta.notExported = true;
  });
  const exported = md.render('- [x] shown elsewhere\n- [ ] still a box\n', { exported: true });
  assert.equal(exported.match(/<input/g).length, 1);
  assert.match(exported, /<input type="checkbox" class="task-box"[^>]*> still a box/);
  assert.equal(md.render('- [x] shown elsewhere\n', {}).match(/<input/g).length, 1, 'only an export leaves it out');
});

test('a box says it\'s a thing to be done, and whether it is, for whatever counts them; a choice doesn\'t', () => {
  const md = new MarkdownIt().use(tasks.plugin);
  const tokens = md.parse('- [x] a\n- [ ] b\n- [x][ ] c\n- (x) d\n', {});
  const tagged = tokens.flatMap((t) => t.children ?? []).filter((t) => t.type === 'task_box').map((t) => t.meta.done);
  assert.deepEqual(tagged, [true, false, false, undefined]);
});

test('a box\'s name has a space where its words go onto another line', () => {
  const { body } = render('- ( ) **Navy Day**\n  Kept in the US.\n');
  assert.match(body, /aria-label="Navy Day Kept in the US\."/);
});

test('a choice or box with a blank in its line writes the line back as written, and names the blank', () => {
  const { body } = render('- ( ) **C** · [@ Something else]\n- [ ] Buy [@ what] today\n');
  assert.match(body, /data-on="- \(x\) \*\*C\*\* · \[@ Something else\]" data-off="- \( \) \*\*C\*\* · \[@ Something else\]" aria-label="C · Something else"/);
  assert.match(body, /data-on="- \[x\] Buy \[@ what\] today" data-off="- \[ \] Buy \[@ what\] today" aria-label="Buy what today"/);
});

test('a reset stops at the --- either side of it, as a page in Work shows no more', () => {
  const button = (md) => render(md).body.match(/class="task-reset"[^>]*>/)[0];
  // Under no heading, on the first page and on a later one, after front matter.
  assert.match(button('---\ntitle: T\n---\n\n- [x] a\n\nreset:[]\n\n---\n\n- [x] b\n'), /data-from="\d+" data-to="8"/);
  assert.match(button('- [x] a\n\n---\n\n- [x] b\n\nreset:[]\n\n---\n\n- [x] c\n'), /data-from="2" data-to="8"/);
  // Under a heading whose section would otherwise go on, or that's on the page before.
  assert.match(button('# A\n\nreset:[]\n\n---\n\n## B\n'), /data-from="0" data-to="4"/);
  assert.match(button('# A\n\n---\n\nreset:[]\n'), /data-from="2">/);
  // A rule inside a block isn't the page's.
  assert.match(button('# A\n\n> ---\n\nreset:[]\n\n# B\n'), /data-from="0" data-to="6"/);
});
