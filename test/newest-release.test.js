import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Docker workflow's check of whether a release is the newest, which
// alone moves the image's :latest and writes its overview on Docker Hub.
const SCRIPT = fileURLToPath(new URL('../.github/scripts/newest-release.sh', import.meta.url));
const UNPUSHED = fileURLToPath(new URL('../.github/scripts/unpushed-release.sh', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/docker.yml', import.meta.url));

// A scratch repository with these tags, standing in for the remote. Its
// commit is made without the user's own git settings (signing, hooks).
function remote(tags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-releases-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=reader', '-c', 'user.email=reader@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'release');
  for (const tag of tags) git('tag', tag);
  return dir;
}

// What the script says of `version`, and what it writes to $GITHUB_OUTPUT.
function check(version, from) {
  const output = path.join(from, 'output');
  fs.writeFileSync(output, '');
  const log = execFileSync(SCRIPT, [version, from], { cwd: from, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
  return { log: log.trim(), output: fs.readFileSync(output, 'utf8') };
}

const TAGS = ['v0.0.1', 'v0.0.2', 'v0.0.9', 'v0.0.10', 'v0.1.0-rc.1', 'docs'];

// The scripts are bash, and run only in the release and Docker workflows, on Ubuntu.
const BASH = process.platform === 'win32' && 'the release scripts run on Ubuntu';

test('the newest release, by its numbers, is the latest', { skip: BASH }, (t) => {
  const from = remote(TAGS);
  t.after(() => fs.rmSync(from, { recursive: true, force: true }));
  assert.deepEqual(check('0.0.10', from), {
    log: 'v0.0.10 is the newest release: true (newest is v0.0.10)',
    output: 'latest=true\n',
  });
});

test('an older release is not, though it sorts last as text', { skip: BASH }, (t) => {
  const from = remote(TAGS);
  t.after(() => fs.rmSync(from, { recursive: true, force: true }));
  assert.equal(check('0.0.9', from).output, 'latest=false\n');
  assert.equal(check('0.0.2', from).output, 'latest=false\n');
});

test('a pre-release is not a release', { skip: BASH }, (t) => {
  const from = remote(TAGS);
  t.after(() => fs.rmSync(from, { recursive: true, force: true }));
  assert.equal(check('0.1.0-rc.1', from).output, 'latest=false\n');
});

test('the Docker workflow runs the script, from its own commit', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /sparse-checkout: \.github\/scripts/);
  assert.match(workflow, /run: workflow\/\.github\/scripts\/newest-release\.sh "\$VERSION"/);
});

// What the check before a push does when the registry, through a stand-in
// `docker`, answers with `said` and `status`.
function unpushed(t, said, status) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-docker-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >&2\necho '${said}' >&2\nexit ${status}\n`, { mode: 0o755 });
  const run = spawnSync(UNPUSHED, ['jzheaux/reader', '0.0.3'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { status: run.status, log: run.stdout };
}

test('a release not on Docker Hub can be pushed', { skip: BASH }, (t) => {
  // Word for word what buildx says of a tag that isn't there.
  const { status, log } = unpushed(t, 'ERROR: docker.io/jzheaux/reader:0.0.3: not found', 1);
  assert.equal(status, 0);
  assert.match(log, /jzheaux\/reader:0\.0\.3 isn't pushed yet/);
});

test('a release already on Docker Hub can\'t be pushed again', { skip: BASH }, (t) => {
  const { status, log } = unpushed(t, 'Name: docker.io/jzheaux/reader:0.0.3', 0);
  assert.equal(status, 1);
  assert.match(log, /already pushed, and is left as it is/);
});

test('a registry that can\'t say stops the push as well', { skip: BASH }, (t) => {
  const { status, log } = unpushed(t, 'ERROR: failed to do request: connection refused', 1);
  assert.equal(status, 1);
  assert.match(log, /connection refused/);
  assert.match(log, /Couldn't tell/);
});

test('the Docker workflow checks before it builds, once logged in', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const check = workflow.indexOf('run: workflow/.github/scripts/unpushed-release.sh "$IMAGE" "$VERSION"');
  assert.ok(check > workflow.indexOf('docker/login-action'));
  assert.ok(check < workflow.indexOf('docker/build-push-action'));
});
