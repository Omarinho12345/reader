import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../src/render.js';
import { FEATURES } from '../index.js';

test('a mermaid fence is wrapped for the preview to draw, its text kept as code', () => {
  const { body } = render('```mermaid\nflowchart LR\n  a --> b\n```\n');
  assert.match(body, /<div class="mermaid" data-name="Diagram"><pre><code class="language-mermaid">flowchart LR\n {2}a --&gt; b\n<\/code><\/pre><\/div>/);
});

test('a fence the preview drew is written drawn, for a page with nothing to draw it', () => {
  const src = '```mermaid\nflowchart LR\n  a --> b\n```\n\n```mermaid\ngraph TD\n```\n';
  const { body } = render(src, { drawn: { mermaid: { 'flowchart LR\n  a --> b': '<svg id="m1"></svg>' } } });
  assert.match(body, /<div class="mermaid drawn" data-name="Diagram"><pre><code class="language-mermaid">flowchart LR\n {2}a --&gt; b\n<\/code><\/pre><div class="mermaid-figure" role="img" aria-label="Diagram"><svg id="m1"><\/svg><\/div><\/div>/);
  assert.match(body, /<div class="mermaid" data-name="Diagram"><pre><code class="language-mermaid">graph TD\n<\/code><\/pre><\/div>/);
});

test('other fences are left alone', () => {
  const { body } = render('```js\nx\n```\n\n```\nmermaid\n```\n');
  assert.doesNotMatch(body, /class="mermaid"/);
});

test('the wrapper takes the block\'s line, which stays on the page once the code is hidden', () => {
  const { body } = render('# Title\n\n```mermaid\ngraph TD\n```\n', { lines: true });
  assert.match(body, /<div class="mermaid" data-line="2" data-name="Diagram"><pre><code/);
});

test('Mermaid is served for the preview to load when a page has a diagram', () => {
  const feature = FEATURES.find((f) => f.name === 'mermaid');
  assert.match(feature.preview, /mermaid[\\/]preview\.js$/);
  assert.match(feature.lazy, /vendor\/mermaid\.min\.js$/);
});

test('a drawn diagram is an image named by its accTitle, or as a diagram', () => {
  const titled = 'flowchart LR\n  accTitle: How a post is published\n  a --> b';
  const src = `\`\`\`mermaid\n${titled}\n\`\`\`\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n`;
  const { body } = render(src, { drawn: { mermaid: { [titled]: '<svg></svg>', 'graph TD': '<svg></svg>' } } });
  assert.match(body, /<div class="mermaid-figure" role="img" aria-label="How a post is published"><svg>/);
  assert.match(body, /<div class="mermaid-figure" role="img" aria-label="Diagram"><svg>/);
});

test('the wrapper carries what the diagram is called, for the preview to name what it draws', () => {
  const titled = 'flowchart LR\n  accTitle: How a "post" & <draft> is published\n  a --> b';
  const src = `\`\`\`mermaid\n${titled}\n\`\`\`\n\n\`\`\`mermaid\ngraph TD\n\`\`\`\n`;
  const { body } = render(src);
  assert.match(body, /<div class="mermaid" data-name="How a &quot;post&quot; &amp; &lt;draft&gt; is published"><pre>/);
  assert.match(body, /<div class="mermaid" data-name="Diagram"><pre>/);
  // drawn, the image is named the same, whatever the text holds
  const drawn = render(src, { drawn: { mermaid: { [titled]: '<svg></svg>' } } }).body;
  assert.match(drawn, /<div class="mermaid drawn" data-name="How a &quot;post&quot; &amp; &lt;draft&gt; is published">[\s\S]*aria-label="How a &quot;post&quot; &amp; &lt;draft&gt; is published"><svg>/);
});
