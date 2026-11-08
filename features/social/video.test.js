import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { render } from '../../src/render.js';
import { slides } from '../../src/slides.js';
import { frame, preview, run, settle, assertElement, assertNotElement } from '../../test/dom.js';
import { FEATURES } from '../index.js';

const card = (body) => body.match(/<span class="video[" ][^]*?<\/span><\/span>|<span class="video[" ][^>]*><button[^]*?<\/button><\/span>/)?.[0];

test('![alt](yt:v/<id>) is a card: the thumbnail, a button to play it named for the alt, and the alt as its caption', () => {
  const { body } = render('![Body scan · 5 minutes](yt:v/FcWl8WgKP8E)\n');
  assert.equal(card(body), '<span class="video video-alone" data-video="FcWl8WgKP8E" data-title="Body scan · 5 minutes">'
    + '<button type="button" class="video-screen video-play" aria-label="Play Body scan · 5 minutes">'
    + '<img class="video-thumb" src="https://img.youtube.com/vi/FcWl8WgKP8E/hqdefault.jpg" alt=""></button>'
    + '<span class="video-caption">Body scan · 5 minutes</span></span>');
  assert.doesNotMatch(body, /youtube-nocookie|<iframe/, 'nothing of the player until it\'s pressed');
  assert.doesNotMatch(body, /<figure/);
});

test('alone in its paragraph, it\'s the paragraph\'s width; in words, a list or beside another, the card\'s', () => {
  const alone = (src, opts) => (render(src, opts).body.match(/class="video[ "][^"]*/g) ?? []).map((c) => c.includes('video-alone'));
  assert.deepEqual(alone('![Body scan](yt:v/FcWl8WgKP8E)\n'), [true]);
  assert.deepEqual(alone('::: tabs\n+++ Meditate\n![Body scan](yt:v/FcWl8WgKP8E)\n:::\n'), [true]);
  assert.deepEqual(alone('![Body scan](yt:v/FcWl8WgKP8E)\n', { exported: true }), [true]);
  assert.deepEqual(alone('Watch ![Body scan](yt:v/FcWl8WgKP8E) now.\n'), [false]);
  assert.deepEqual(alone('![Body scan](yt:v/FcWl8WgKP8E) then.\n'), [false]);
  assert.deepEqual(alone('![a](yt:v/FcWl8WgKP8E) ![b](yt:v/w6iG0mNHK28)\n'), [false, false]);
  assert.deepEqual(alone('- ( ) ![Body scan](yt:v/FcWl8WgKP8E)\n'), [false]);
});

test('without alt text it\'s still a video to play, with no caption', () => {
  const { body } = render('![](yt:v/FcWl8WgKP8E)\n');
  assert.match(body, /aria-label="Play video"/);
  assert.doesNotMatch(body, /video-caption/);
});

test('a channel, and a link to a video, are links as they were', () => {
  const { body } = render('![me](yt:jzheaux) [Body scan](yt:v/FcWl8WgKP8E) yt:v/FcWl8WgKP8E[]\n');
  assert.doesNotMatch(body, /class="video"/);
  assert.match(body, /<a class="social social-yt" href="https:\/\/www\.youtube\.com\/@jzheaux">me<span class="social-site vh"> on YouTube<\/span><\/a>/);
  assert.equal(body.match(/href="https:\/\/www\.youtube\.com\/watch\?v=FcWl8WgKP8E"/g).length, 2);
});

test('as a choice, the box is named for the video and records the choice; the card is its own', () => {
  const { body } = render('- ( ) ![Body Scan · Michelle Motta](yt:v/FcWl8WgKP8E)\n- ( ) ![Morning Stretch · AARP](yt:v/w6iG0mNHK28)\n');
  assert.match(body, /<input type="radio" class="choice-box" name="choice-1" data-line="0" data-on="- \(x\) !\[Body Scan · Michelle Motta\]\(yt:v\/FcWl8WgKP8E\)"[^>]* aria-label="Body Scan · Michelle Motta">/);
  assert.match(body, /aria-label="Morning Stretch · AARP"> <span class="video" data-video="w6iG0mNHK28"/);
});

test('it plays on a slide and in a record, which can\'t be worked', () => {
  const deck = slides('# Breathe\n\n- ( ) ![Body scan](yt:v/FcWl8WgKP8E)\n\n---\n\n# Next\n').slides[0].body;
  assert.match(deck, /<button type="button" class="video-screen video-play" aria-label="Play Body scan">/);
  assert.match(deck, /choice-box[^>]* disabled/, 'the box can\'t be ticked on a slide');
  const record = render('---\nopen-until: 2026-10-28 04:00\n---\n\n- ( ) ![Body scan](yt:v/FcWl8WgKP8E)\n', { now: new Date(2026, 9, 29).getTime() }).body;
  assert.match(record, /choice-box[^>]* disabled/);
  assert.match(record, /<button type="button" class="video-screen video-play" aria-label="Play Body scan">/);
});

test('exported, it\'s the thumbnail as a link to the video, which plays it on YouTube', () => {
  const { body } = render('- ( ) ![Body scan](yt:v/FcWl8WgKP8E)\n\n![](yt:v/w6iG0mNHK28)\n', { exported: true });
  assert.match(body, /<a class="video" href="https:\/\/www\.youtube\.com\/watch\?v=FcWl8WgKP8E"><span class="video-screen"><img class="video-thumb" src="https:\/\/img\.youtube\.com\/vi\/FcWl8WgKP8E\/hqdefault\.jpg" alt=""><\/span><span class="video-caption">Body scan<\/span><span class="video-site vh"> on YouTube<\/span><\/a>/);
  assert.match(body, /<span class="video-site vh">A video on YouTube<\/span>/);
  assert.doesNotMatch(body, /<button[^>]*video|youtube-nocookie/);
});

const players = (p) => [...p.document.querySelectorAll('iframe.video-player')];

test('in the preview, pressing it swaps in the player, which takes the keyboard; nothing goes into the file', async () => {
  const p = preview();
  p.show(render('- ( ) ![Body scan](yt:v/FcWl8WgKP8E)\n- ( ) ![Stretch](yt:v/w6iG0mNHK28)\n').body);
  assert.equal(players(p).length, 0);
  p.document.querySelector('.video-play').click();
  const [player] = players(p);
  assert.equal(player.getAttribute('src'), 'https://www.youtube-nocookie.com/embed/FcWl8WgKP8E?autoplay=1');
  assert.equal(player.getAttribute('title'), 'Body scan');
  assert.match(player.getAttribute('allow'), /autoplay/);
  assert.equal(player.parentNode.className, 'video-screen', 'where the thumbnail was, the same size');
  assertElement(p.document.activeElement, player, 'the keyboard isn\'t left on a button that\'s gone');
  assert.equal(p.document.querySelectorAll('.video-play').length, 1, 'the other is still a thumbnail');
  assert.equal(p.document.querySelector('.choice-box').checked, false, 'the box is the box\'s business');
  await settle();
  assert.deepEqual(p.posted.filter((m) => m.type === 'edit'), []);
});

test('in Safari it starts muted, since Safari won\'t start it with sound from a press on the card', () => {
  const ua = (p, agent) => Object.defineProperty(p.window.navigator, 'userAgent', { value: agent, configurable: true });
  const src = (agent) => {
    const p = preview();
    ua(p, agent);
    p.show(render('![Body scan](yt:v/FcWl8WgKP8E)\n').body);
    p.document.querySelector('.video-play').click();
    return players(p)[0].getAttribute('src');
  };
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
  assert.equal(src(safari), 'https://www.youtube-nocookie.com/embed/FcWl8WgKP8E?autoplay=1&mute=1');
  assert.equal(src(chrome), 'https://www.youtube-nocookie.com/embed/FcWl8WgKP8E?autoplay=1', 'with sound elsewhere');
});

test('on a slide, it\'s the player from the start, stopped, for a press on its own play button', () => {
  const p = preview();
  p.show(slides('# Breathe\n\n![Body scan](yt:v/FcWl8WgKP8E)\n\n---\n\n# Next\n').slides[0].body, { deck: true });
  const [player] = players(p);
  assert.equal(player.getAttribute('src'), 'https://www.youtube-nocookie.com/embed/FcWl8WgKP8E', 'not asked to start');
  assert.equal(p.document.querySelector('.video-play'), null);
  assertNotElement(p.document.activeElement, player, 'the keyboard stays with the deck');
});

test('in Work too, and the same player through the renders after, but in Edit the card', () => {
  const p = preview();
  const body = render('# Breathe\n\n![Body scan](yt:v/FcWl8WgKP8E)\n').body;
  p.show(body);
  assert.equal(players(p).length, 0, 'Edit: drawn again at each keystroke, so the card');
  p.show(body, { working: true });
  const [player] = players(p);
  assert.ok(player, 'Work: the player');
  p.show(body, { working: true });
  assert.equal(players(p).length, 1);
});

test('in Work, a card narrower than YouTube\'s smallest player stays the card until pressed, which then starts it', () => {
  for (const [width, expected] of [[130, 0], [216, 1]]) {
    const p = preview();
    Object.defineProperty(p.window.HTMLElement.prototype, 'offsetWidth', { get: () => width, configurable: true });
    const body = render('::: grid 3\n- ![Body scan](yt:v/FcWl8WgKP8E)\n- ![Stretch](yt:v/st6YgM4pgrM)\n:::\n').body;
    p.show(body, { working: true });
    assert.equal(players(p).length, expected * 2, `${width}px wide`);
    if (expected) continue;
    p.document.querySelector('.video-play').click();
    const [player] = players(p);
    assert.equal(player.getAttribute('src'), 'https://www.youtube-nocookie.com/embed/FcWl8WgKP8E?autoplay=1', 'pressed, it starts');
  }
});

test('in a frame with no origin of its own (the overview, the speaker view, measuring), the card, asking nothing of YouTube', () => {
  const p = preview();
  Object.defineProperty(p.window, 'origin', { value: 'null', configurable: true });
  p.show(slides('# Breathe\n\n![Body scan](yt:v/FcWl8WgKP8E)\n').slides[0].body, { deck: true });
  assert.equal(players(p).length, 0);
  assert.ok(p.document.querySelector('.video-play'));
});

/**
 * The preview frame, in a browser that can move a frame without loading it
 * again, until test `t` is over: happy-dom's pages share their Element.
 */
function moving(t) {
  const f = frame(fs.readFileSync(new URL('../../static/preview.html', import.meta.url), 'utf8'), { url: 'http://localhost:8734/preview.html' });
  const { prototype } = f.window.Element;
  prototype.moveBefore = function moveBefore(node, child) {
    node.moved = (node.moved ?? 0) + 1;
    this.insertBefore(node, child);
  };
  t.after(() => delete prototype.moveBefore);
  const scripts = FEATURES.flatMap((x) => [x.preview ?? []].flat());
  run(f.window, 'static/preview-api.js', 'static/spoken.js', 'static/tone.js', ...scripts, 'static/ink.js', 'static/preview.js');
  return { ...f, show: (body, m = {}) => f.send({ type: 'render', css: '', body, ...m }) };
}

test('a render moves the player into the page drawn anew, still playing; a card gone takes its player', (t) => {
  const p = moving(t);
  const page = (above) => render(`${above}\n\n![Body scan](yt:v/FcWl8WgKP8E)\n\n![Body scan, again](yt:v/FcWl8WgKP8E)\n`).body;
  p.show(page('One'));
  p.document.querySelectorAll('.video-play')[1].click();
  const [player] = players(p);
  p.show(page('One, typed into'));
  assert.deepEqual(players(p), [player], 'the same frame, not loaded again');
  assert.equal(player.moved, 2, 'out of the page, and into the new one');
  assert.equal(player.closest('.video').dataset.title, 'Body scan, again', 'into the card it was in');
  assert.equal(p.document.querySelectorAll('.video-play').length, 1);
  p.show(render('Another page\n').body);
  assert.equal(players(p).length, 0);
  p.show(page('One'));
  assert.equal(players(p).length, 0, 'back as a thumbnail');
});

test('where a frame can\'t be moved, the player is still there after a render, loaded again without starting', () => {
  const p = preview();
  const page = (above) => render(`${above}\n\n![Body scan](yt:v/FcWl8WgKP8E)\n`).body;
  p.show(page('One'));
  p.document.querySelector('.video-play').click();
  p.show(page('One, typed into'));
  const [player] = players(p);
  assert.equal(player.getAttribute('src'), 'https://www.youtube-nocookie.com/embed/FcWl8WgKP8E');
  assert.equal(p.document.querySelectorAll('.video-play').length, 0);
});
