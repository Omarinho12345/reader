/**
 *   reader export <file>... [--out <file>] [--no-draw]
 *
 * Saves each document as one HTML file beside it, as the `↓` in the file
 * list does (export.js), with no one there to press it: in a GitHub Action,
 * say, so a deck's .html is never behind its .md.
 *
 * The directory it runs in is the content directory: the documents, and
 * the images they take in, are found in it.
 *
 * A diagram needs a browser to draw it, so the app is served for a moment
 * and a headless browser asked what it draws (browser.js). Without one, or
 * with --no-draw, diagrams are left as their text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createContent, DOC_EXTS } from './content.js';
import { exportHtml } from './export.js';
import { createServer, listenFrames } from './server.js';
import { findBrowser, openBrowser } from './browser.js';

const USAGE = `usage: reader export <file>... [--out <file>] [--no-draw]

  <file>         a document to save as HTML, beside it as <name>.html
  --out <file>   where to save it instead, when there's one document
  --no-draw      leave diagrams as their text, without starting a browser

  Documents and the images they use are read from the current directory.
  Diagrams are drawn by Chrome or Chromium, headless: the one at CHROME_PATH,
  or one installed where it usually is.
`;

export async function main(argv) {
  const opts = parseArgs(argv);
  const root = process.cwd();
  const content = createContent(root);
  const files = opts.files.map((f) => {
    // A new line or the like in a name is never one someone typed, and it
    // would break up a list of what was saved (the GitHub Action's).
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(f)) fail(`not a name to export: ${JSON.stringify(f)}`);
    const rel = path.relative(root, path.resolve(f)).split(path.sep).join('/');
    if (rel.startsWith('../') || path.isAbsolute(rel)) fail(`${f} isn't under ${root}`);
    if (!DOC_EXTS.has(path.extname(rel).toLowerCase())) fail(`not a document: ${f}`);
    if (!fs.existsSync(path.join(root, rel))) fail(`no such file: ${f}`);
    return rel;
  });

  let draw = null;
  let stop = async () => {};
  if (opts.draw) {
    const browser = findBrowser();
    if (!browser) {
      warn('no Chrome or Chromium found (set CHROME_PATH): diagrams are left as their text');
    } else {
      const made = createServer({ root });
      const { server } = made;
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        await listenFrames(made);
        const page = await openBrowser(browser, `http://127.0.0.1:${server.address().port}/`);
        draw = page.drawn;
        stop = async () => {
          await page.close();
          server.close();
        };
      } catch (err) {
        server.close();
        throw err;
      }
    }
  }

  try {
    for (const rel of files) {
      const drawn = draw ? await draw(rel) : undefined;
      // Links between the documents saved together go from page to page.
      const { name, html, missing } = exportHtml(content, rel, drawn, new Set(files));
      for (const image of missing) warn(`${rel}: no ${image}, so it's left as a link`);
      const out = opts.out ?? path.join(root, path.dirname(rel), name);
      save(out, html);
      console.log(`${rel} -> ${path.relative(root, path.resolve(out)).split(path.sep).join('/')}`);
    }
  } finally {
    await stop();
  }
}

/**
 * Writes `out` whole, by way of a new file beside it that takes its place:
 * a link already at `out` is replaced, not followed, so an export can't
 * write over a file outside the folder it was asked to export into.
 */
function save(out, html) {
  const tmp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.tmp`);
  // `wx` won't open a file, or a link, that's already there.
  fs.writeFileSync(tmp, html, { flag: 'wx' });
  try {
    fs.renameSync(tmp, out);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function parseArgs(argv) {
  const opts = { files: [], out: null, draw: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      // Everything after is a document, even one whose name starts with -.
      opts.files.push(...argv.slice(i + 1));
      break;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '--out' || a === '-o') {
      opts.out = argv[++i];
      if (!opts.out) fail('--out needs a file');
    } else if (a === '--no-draw') {
      opts.draw = false;
    } else if (a.startsWith('-')) {
      fail(`unknown option ${a}\n\n${USAGE}`);
    } else {
      opts.files.push(a);
    }
  }
  if (!opts.files.length) fail(`which document?\n\n${USAGE}`);
  if (opts.out && opts.files.length > 1) fail('--out is for one document; leave it off to save each beside its own');
  return opts;
}

function warn(msg) {
  process.stderr.write(`reader: ${msg}\n`);
}

function fail(msg) {
  warn(msg);
  process.exit(1);
}
