import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READER = fileURLToPath(new URL('../bin/reader.js', import.meta.url));

function dir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-cli-'));
  fs.writeFileSync(path.join(root, 'a.md'), '# a\n');
  return root;
}

/** Start reader, and give back the address it printed, to be stopped with `stop`, which waits till it has. */
function start(...args) {
  return startWith(process.env, ...args);
}

/** The same, with `env` for its environment. */
function startWith(env, ...args) {
  const child = spawn(process.execPath, [READER, dir(), '--no-browser', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const url = /^ {2}(http:\/\/\S+)$/m.exec(out)?.[1];
      if (url) resolve({ url, stop: () => new Promise((done) => child.once('exit', done).kill()) });
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
}

// The stand-in for tailscale is a shell script, which Windows can't run as a command.
const FAKE_TAILSCALE = process.platform === 'win32' && 'the stand-in tailscale is a shell script';

test('the address printed is the one listened on', async () => {
  const { url, stop } = await start('--host', '::1', '--port', '0');
  try {
    assert.match(url, /^http:\/\/\[::1\]:\d+\/$/);
    // Sent on to a name a policy can name, which is ::1 too.
    const port = new URL(url).port;
    const res = await fetch(url + 'api/tree?x=1', { redirect: 'manual' });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), `http://localhost:${port}/api/tree?x=1`);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '::1', port, path: '/api/tree', headers: { Host: `localhost:${port}` } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 200);
  } finally {
    await stop();
  }
});

test('a --port with nothing after it is refused, not taken as any free port', () => {
  for (const args of [['--port='], ['--port', ''], ['--port', ' ']]) {
    const out = spawnSync(process.execPath, [READER, dir(), '--no-browser', ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(out.status, 1, args.join(' '));
    assert.match(out.stderr, /--port must be a number/);
  }
});

/** Run reader to its end, as it is when it refuses what it's given. */
function run(...args) {
  return spawnSync(process.execPath, [READER, ...args], { encoding: 'utf8', timeout: 5000 });
}

/** Listen on `port` here, so reader finds it busy; null if something else already has it. */
function hold(port) {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('--help says how to use it, and that is all', () => {
  const out = run('--help');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^usage: reader <dir>/);
  assert.equal(run('-h').stdout, out.stdout);
});

test('--version says the version the app shows', async () => {
  const out = run('--version');
  assert.equal(out.status, 0);
  const { version } = await import('../src/version.js');
  assert.equal(out.stdout, `${(await version()).label}\n`);
});

test('a slow git holds up only the version, not the files', { skip: process.platform === 'win32' && 'the slow git is a shell script' }, async () => {
  // A git that takes its time, as on a cold disk, ahead of the real one.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-git-'));
  const git = `#!/bin/sh\nsleep 1\nPATH=${JSON.stringify(process.env.PATH)} exec git "$@"\n`;
  fs.writeFileSync(path.join(bin, 'git'), git, { mode: 0o755 });
  const { url, stop } = await startWith({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, '--port', '0');
  try {
    const info = fetch(url + 'api/info').then((r) => r.json());
    const asked = Date.now();
    const { files } = await (await fetch(url + 'api/tree')).json();
    assert.deepEqual(files.map((f) => f.path), ['a.md']);
    assert.ok(Date.now() - asked < 500, 'the files list waited on git');
    assert.match((await info).version.label, /^v\d+\.\d+\.\d+(\+[0-9a-f]{7})?$/);
  } finally {
    await stop();
  }
});

test('an argument it doesn\'t know is refused, saying which', () => {
  const root = dir();
  const cases = [
    [['--nope'], /unknown option --nope\n\nusage:/],
    [[root, 'other'], /unexpected argument other\n\nusage:/],
    [['--host'], /--host needs a value/],
    [['--host', '--no-browser'], /--host needs a value/],
    [['--allow-host'], /--allow-host needs a value/],
    [['--port', '70000'], /--port must be a number/],
    [['--port', '-1'], /--port must be a number/],
    [['-p', '80a'], /--port must be a number/],
    [['--port=1.5'], /--port must be a number/],
    [['--frame-port', 'x'], /--frame-port must be a number/],
    [['--frame-port'], /--frame-port must be a number/],
    [['--day-starts', 'soon'], /--day-starts must be a time like 04:00/],
    [['--day-starts'], /--day-starts must be a time like 04:00/],
    [['--day-starts=25:00'], /--day-starts must be a time like 04:00/],
    [['--port', '9000', '--frame-port=9000'], /--port and --frame-port must differ/],
    [[path.join(root, 'a.md')], /not a directory: .*a\.md/],
    [[path.join(root, 'missing')], /not a directory: .*missing/],
  ];
  for (const [args, message] of cases) {
    const out = run(...(args[0]?.startsWith('-') ? [root, ...args] : args), '--no-browser');
    assert.equal(out.status, 1, args.join(' '));
    assert.match(out.stderr, message, args.join(' '));
  }
});

test('--open puts the file in the address', async () => {
  const { url, stop } = await start('--port', '0', '--open', 'notes/a b.md');
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#notes%2Fa%20b\.md$/);
  } finally {
    await stop();
  }
});

test('without --port, a busy 8734 moves it on to the next port free', async () => {
  const held = await hold(8734);
  const { url, stop } = await start();
  try {
    const port = Number(new URL(url).port);
    assert.ok(port > 8734 && port < 8734 + 50, url);
    assert.equal((await fetch(url + 'api/tree')).status, 200);
  } finally {
    await stop();
    held?.close();
  }
});

test('without --port, it gives up after fifty busy ports, saying which', async () => {
  const held = await Promise.all(Array.from({ length: 50 }, (_, i) => hold(8734 + i)));
  try {
    const out = run(dir(), '--no-browser');
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ports 8734-8783 are all busy; pick one with --port\./);
  } finally {
    for (const server of held) server?.close();
  }
});

test('a --port given that is busy is refused, not moved on from', async () => {
  const held = await hold(0);
  const { port } = held.address();
  try {
    const out = run(dir(), '--no-browser', '--port', String(port));
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`port ${port} is busy; pick another with --port`));
  } finally {
    held.close();
  }
});

/** Where the page at `url` is told its frames are, by name and by port. */
async function framesAt(url) {
  const html = await (await fetch(url)).text();
  const meta = /<meta name="frames"(?: data-name="([^"]+)")? data-port="([^"]+)">/.exec(html);
  return { name: meta[1], port: meta[2] };
}

test('the frames\' port is up by the time the address is printed: the one after the app\'s, or the one asked for (gh-206)', async () => {
  const held = await hold(0);
  const { port: free } = held.address();
  held.close();
  for (const [args, want] of [[['--port', '0'], (p) => p + 1], [['--port', '0', '--frame-port', String(free)], () => free]]) {
    const { url, stop } = await start(...args);
    try {
      const at = Number(new URL(url).port);
      const { name, port } = await framesAt(url);
      assert.equal(name, `http://frames.localhost:${at}`);
      assert.equal(port, `http://127.0.0.1:${want(at)}`);
      assert.equal((await fetch(`${port}/preview.html`)).status, 200, args.join(' '));
    } finally {
      await stop();
    }
  }
});

test('a --frame-port given that is busy is refused; the one after the app\'s, when busy, moves to one free', async () => {
  const held = await hold(0);
  const { port } = held.address();
  try {
    const out = run(dir(), '--no-browser', '--port', '0', '--frame-port', String(port));
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp(`port ${port} is busy; pick another with --frame-port`));
    if (port > 1) {
      const app = await hold(port - 1);
      if (app) {
        app.close();
        const { url, stop } = await start('--port', String(port - 1));
        try {
          const frames = (await framesAt(url)).port;
          assert.notEqual(Number(new URL(frames).port), port);
          assert.equal((await fetch(`${frames}/preview.html`)).status, 200);
        } finally {
          await stop();
        }
      }
    }
  } finally {
    held.close();
  }
});

/**
 * A stand-in for the tailscale command, first on PATH, that answers as a
 * connected machine with `served` already on its tailnet and writes down
 * what else it's asked. Gives back that PATH and the log it writes.
 */
function fakeTailscale(served = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tailscale-'));
  const log = path.join(bin, 'log');
  const status = { BackendState: 'Running', Self: { DNSName: 'box.tail1.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] } };
  const config = { TCP: {}, Web: {} };
  for (const [port, target] of Object.entries(served)) {
    config.TCP[port] = { HTTP: true };
    config.Web[`box.tail1.ts.net:${port}`] = { Handlers: { '/': { Proxy: target } } };
  }
  const script = path.join(bin, 'tailscale');
  fs.writeFileSync(script, `#!/bin/sh
case "$*" in
  "status --json") echo '${JSON.stringify(status)}' ;;
  "serve status --json") echo '${JSON.stringify(config)}' ;;
  *) echo "$*" >> '${log}' ;;
esac
`);
  fs.chmodSync(script, 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, log };
}

/** Start reader to its last line, giving back all it printed, to be stopped with `stop`. */
function startAll(env, ...args) {
  const child = spawn(process.execPath, [READER, dir(), '--no-browser', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('ctrl-c')) resolve({ out, stop: () => new Promise((done) => child.once('exit', done).kill()) });
    });
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
  });
}

test('--tailscale serves both ports on the tailnet, answers to its names, and takes them off when stopped', { skip: FAKE_TAILSCALE }, async () => {
  const { PATH, log } = fakeTailscale();
  const { out, stop } = await startAll({ ...process.env, PATH }, '--tailscale', '--port', '0', '--frame-port', '0');
  const port = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)[1];
  try {
    assert.match(out, new RegExp(`http://box\\.tail1\\.ts\\.net:${port}/`));
    for (const host of ['box.tail1.ts.net', 'box', '100.64.0.1', '[fd7a::1]']) {
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/tree', headers: { Host: `${host}:${port}` } }, (r) => {
          r.resume();
          resolve(r.statusCode);
        }).on('error', reject);
      });
      assert.equal(status, 200, host);
    }
  } finally {
    await stop();
  }
  const asked = fs.readFileSync(log, 'utf8').trim().split('\n');
  const frames = /^serve --bg --http=(\d+) /.exec(asked[1])?.[1];
  assert.notEqual(frames, port);
  assert.deepEqual(asked, [
    `serve --bg --http=${port} http://127.0.0.1:${port}`,
    `serve --bg --http=${frames} http://127.0.0.1:${frames}`,
    `serve --http=${port} off`,
    `serve --http=${frames} off`,
  ]);
});

test('--tailscale leaves a port the tailnet already serves to reader as it was', { skip: FAKE_TAILSCALE }, async () => {
  const held = await hold(0);
  const port = held.address().port;
  held.close();
  const { PATH, log } = fakeTailscale({ [port]: `http://127.0.0.1:${port}` });
  const { stop } = await startAll({ ...process.env, PATH }, '--tailscale', '--port', String(port), '--frame-port', '0');
  await stop();
  const asked = fs.readFileSync(log, 'utf8');
  assert.doesNotMatch(asked, new RegExp(`http=${port}\\b`));
  assert.match(asked, /serve --bg --http=\d+ /);
});

test('--tailscale is refused when the tailnet serves the port for something else, or tailscale is missing', { skip: FAKE_TAILSCALE }, async () => {
  const held = await hold(0);
  const port = held.address().port;
  held.close();
  const { PATH, log } = fakeTailscale({ [port]: 'http://127.0.0.1:9' });
  const taken = spawnSync(process.execPath, [READER, dir(), '--no-browser', '--tailscale', '--port', String(port)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH } });
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, new RegExp(`already serves port ${port} for something else`));
  assert.equal(fs.existsSync(log), false);
  const missing = spawnSync(process.execPath, [READER, dir(), '--no-browser', '--tailscale'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /needs the tailscale command/);
  assert.match(run(dir(), '--tailscale', '--host', '0.0.0.0').stderr, /goes without --host/);
});
