import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Action's steps, run as GitHub runs them, against a repository of
// files named to trip them up.

const ACTION = path.join(import.meta.dirname, '..');

/** The `run:` of the step called `name` in action.yml. */
function step(name) {
  const yml = fs.readFileSync(path.join(ACTION, 'action.yml'), 'utf8');
  const found = yml.split(/^ {4}- /m).find((s) => s.startsWith(`name: ${name}\n`));
  const run = found.slice(found.indexOf('run: |\n') + 'run: |\n'.length);
  return run.split('\n').map((line) => line.replace(/^ {8}/, '')).join('\n');
}

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, env: ENV, encoding: 'utf8' });

/** A clone of a repository holding `files`, pushed to a bare one beside it. */
function repo(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-action-'));
  const work = path.join(base, 'work');
  const temp = path.join(base, 'temp');
  fs.mkdirSync(temp);
  git(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(base, 'init', '-q', '-b', 'main', 'work');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    fs.writeFileSync(path.join(work, name), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'start');
  git(work, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { work, temp };
}

function run({ work, temp }, name, env) {
  // No browser, so the test doesn't wait on one.
  const script = step(name).replace('/bin/reader.js" export ', '/bin/reader.js" export --no-draw ');
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...ENV,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      GITHUB_ACTION_PATH: ACTION,
      RUNNER_TEMP: temp,
      MESSAGE: 'Export HTML with reader',
      ...env,
    },
  });
}

const staged = (work) => git(work, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
const pushed = (work) => git(work, 'ls-tree', '-r', '--name-only', '-z', 'origin/main').split('\0').filter(Boolean);

// Windows has no file names with a * or a new line in them, so they can't be made to try.
const NAMES = process.platform === 'win32' && 'Windows file names can\'t hold * or a new line';

test('the Action exports the documents named and matched, and pushes only their HTML', () => {
  const r = repo({ 'a.md': '# A\n', 'deck/b.md': '# B\n', 'deck/c.md': '# C\n' });
  fs.writeFileSync(path.join(r.work, 'gha-creds-1a2b3c.json'), '{}');
  let out = run(r, 'Export', { FILES: 'a.md\n  deck/*.md ' });
  assert.equal(out.status, 0, out.stderr);
  out = run(r, 'Commit');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(pushed(r.work).sort(), ['a.html', 'a.md', 'deck/b.html', 'deck/b.md', 'deck/c.html', 'deck/c.md']);
});

test('the Action takes a name a pattern matched as itself, not as another pattern', { skip: NAMES }, () => {
  const r = repo({ 'x*.md': '# X\n', 'xy.html': 'before\n' });
  fs.writeFileSync(path.join(r.work, 'xy.html'), 'changed, and not by the Action\n');
  let out = run(r, 'Export', { FILES: '*.md' });
  assert.equal(out.status, 0, out.stderr);
  out = run(r, 'Commit');
  assert.equal(out.status, 0, out.stderr);
  assert.ok(pushed(r.work).includes('x*.html'));
  assert.equal(git(r.work, 'show', 'origin/main:xy.html'), 'before\n');
});

test('the Action won\'t export a name with a new line in it, so it can\'t stage another file', { skip: NAMES }, () => {
  const r = repo({ 'deck.md\ngha-creds-*\nz.md': '# Deck\n', 'z.html': 'z\n' });
  fs.writeFileSync(path.join(r.work, 'gha-creds-1a2b3c.json'), '{}');
  const out = run(r, 'Export', { FILES: '*.md' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /not a name to export: "deck\.md\\ngha-creds-\*\\nz\.md"/);
  assert.deepEqual(staged(r.work), []);
});

test('the Action adds each exported name whole, a new line and all', { skip: NAMES }, () => {
  const name = 'deck\ngha-creds-*\nz.html';
  const r = repo({ 'z.html': 'z\n' });
  fs.writeFileSync(path.join(r.work, name), 'deck\n');
  fs.writeFileSync(path.join(r.work, 'gha-creds-1a2b3c.json'), '{}');
  fs.writeFileSync(path.join(r.temp, 'reader-exported'), `${name}\0`);
  const out = run(r, 'Commit');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(pushed(r.work).sort(), [name, 'z.html']);
});

test('export takes a name after -- as a document, even one starting with -', () => {
  const r = repo({ '-a.md': '# A\n' });
  const out = spawnSync(process.execPath, [path.join(ACTION, 'bin', 'reader.js'), 'export', '--no-draw', '--', '-a.md'], { cwd: r.work, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(path.join(r.work, '-a.html')));
});
