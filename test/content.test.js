import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContent, PathError, ConflictError } from '../src/content.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-test-'));
  const root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'a.md'), '# a\n');
  fs.writeFileSync(path.join(root, 'sub', 'b.markdown'), 'b\n');
  fs.writeFileSync(path.join(root, 'doc.pdf'), '%PDF-1.4\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'skip me\n');
  fs.writeFileSync(path.join(root, '.hidden', 'c.md'), 'hidden\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'd.md'), 'dep\n');
  fs.writeFileSync(path.join(base, 'secret.md'), 'outside\n');
  fs.symlinkSync(path.join(base, 'secret.md'), path.join(root, 'link-out.md'));
  fs.symlinkSync(base, path.join(root, 'dir-out'));
  return { base, root, content: createContent(root) };
}

test('list shows markdown and pdf, skipping hidden, node_modules and escaping links', () => {
  const { content } = fixture();
  const paths = content.list().map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.md', 'doc.pdf', 'sub/b.markdown']);
  assert.equal(content.list().find((f) => f.path === 'doc.pdf').type, 'pdf');
});

test('resolve refuses paths that leave the root', () => {
  const { content } = fixture();
  for (const bad of ['../secret.md', 'sub/../../secret.md', '/etc/passwd', '', '.hidden/c.md',
    'link-out.md', 'dir-out/secret.md', 'a\0.md', '.reader/backups/a.md']) {
    assert.throws(() => content.resolve(bad), PathError, bad);
  }
  assert.ok(content.resolve('sub/b.markdown').endsWith(path.join('sub', 'b.markdown')));
  assert.ok(content.resolve('new/dir/x.md'));
});

test('read returns text and mtime; missing files are 404', () => {
  const { content } = fixture();
  const f = content.read('a.md');
  assert.equal(f.text, '# a\n');
  assert.equal(typeof f.mtime, 'number');
  assert.throws(() => content.read('nope.md'), (e) => e.status === 404);
});

test('write is atomic, checks mtime and refuses non-markdown', () => {
  const { root, content } = fixture();
  const { mtime } = content.read('a.md');
  const out = content.write('a.md', '# a\nmore\n', { baseMtime: mtime });
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# a\nmore\n');
  assert.ok(!fs.readdirSync(root).some((f) => f.endsWith('.tmp')));

  // someone else edits the file
  fs.writeFileSync(path.join(root, 'a.md'), 'theirs\n');
  fs.utimesSync(path.join(root, 'a.md'), new Date(), new Date(Date.now() + 5000));
  assert.throws(() => content.write('a.md', 'mine\n', { baseMtime: out.mtime }), ConflictError);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'theirs\n');

  content.write('a.md', 'mine\n', { baseMtime: out.mtime, force: true });
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'mine\n');

  assert.throws(() => content.write('doc.pdf', 'x'), PathError);
  assert.throws(() => content.write('../secret.md', 'x'), PathError);
});

test('backups: explicit saves always back up, autosaves are throttled, last 10 kept', () => {
  const { content } = fixture();
  const dir = path.join(content.backupRoot, 'a.md');
  content.write('a.md', 'v1');
  content.write('a.md', 'v2');           // autosave within 5 minutes: no second backup
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), '# a\n');

  for (let i = 0; i < 15; i++) content.write('a.md', `e${i}`, { explicit: true });
  assert.equal(fs.readdirSync(dir).length, 10);

  // saving identical text writes nothing
  const before = fs.readdirSync(dir).length;
  assert.ok(content.write('a.md', 'e14', { explicit: true }).unchanged);
  assert.equal(fs.readdirSync(dir).length, before);
});

test('create defaults to untitled, adds .md, and does not clobber', () => {
  const { root, content } = fixture();

  assert.deepEqual(
    { path: content.create().path, created: true },
    { path: 'untitled.md', created: true },
  );
  assert.equal(content.create().created, false);
  assert.equal(content.create('sub/idea').path, 'sub/idea.md');

  fs.writeFileSync(path.join(root, 'a.md'), 'keep\n');
  assert.equal(content.create('a.md').created, false);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'keep\n');
  assert.throws(() => content.create('x.pdf'), PathError);

  // A dot in a name is part of the name, unless what follows is a kind of file.
  assert.equal(content.create('release 1.2').path, 'release 1.2.md');
  assert.equal(content.create('sub/v2.0 notes').path, 'sub/v2.0 notes.md');
  assert.equal(content.create('Notes.MARKDOWN').path, 'Notes.MARKDOWN');
});

test('branch copies a document to a new name, never over another', () => {
  const { root, content } = fixture();
  assert.equal(content.branch('a.md', 'a.draft.md').path, 'a.draft.md');
  assert.equal(fs.readFileSync(path.join(root, 'a.draft.md'), 'utf8'), '# a\n');
  assert.throws(() => content.branch('a.md', 'a.draft.md'), ConflictError);
  assert.throws(() => content.branch('a.md', 'a.draft.txt'), PathError);
});

test('promote swaps a version in as the main one, and its backups go with it', () => {
  const { root, content } = fixture();
  content.branch('a.md', 'a.arc1.md');
  content.write('a.arc1.md', '# arc1\n', { explicit: true });
  content.write('a.md', '# a, changed\n', { explicit: true });
  const when = new Date(2026, 9, 2);
  fs.utimesSync(path.join(root, 'a.md'), when, when);

  const out = content.promote('a.arc1.md', 'a');
  assert.deepEqual(out, { path: 'a.md', moved: [{ from: 'a.md', to: 'a.oct2.md' }, { from: 'a.arc1.md', to: 'a.md' }] });
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# arc1\n');
  assert.equal(fs.readFileSync(path.join(root, 'a.oct2.md'), 'utf8'), '# a, changed\n');

  const backups = (rel) => fs.readdirSync(path.join(content.backupRoot, rel)).map((f) => fs.readFileSync(path.join(content.backupRoot, rel, f), 'utf8'));
  assert.deepEqual(backups('a.oct2.md'), ['# a\n']);
  assert.deepEqual(backups('a.md'), ['# a\n']);
  assert.equal(fs.existsSync(path.join(content.backupRoot, 'a.arc1.md')), false);
});

test('promote finds a free name for the old main version, and refuses what is not a version', () => {
  const { root, content } = fixture();
  const when = new Date(2026, 9, 2);
  content.branch('a.md', 'a.oct2.md');
  content.branch('a.md', 'a.b.md');
  fs.utimesSync(path.join(root, 'a.md'), when, when);
  assert.equal(content.promote('a.b.md', 'a').moved[0].to, 'a.oct2-2.md');
  assert.throws(() => content.promote('a.md', 'b'), PathError);
  assert.throws(() => content.promote('a.oct2.md', '../a'), PathError);
});

test('rename moves every file named, with its backups, or none of them', () => {
  const { root, content } = fixture();
  content.branch('a.md', 'a.arc1.md');
  content.write('a.md', '# a, changed\n', { explicit: true });
  const out = content.rename([{ from: 'a.md', to: 'talk.md' }, { from: 'a.arc1.md', to: 'talk.arc1.md' }]);
  assert.deepEqual(out.moved, [{ from: 'a.md', to: 'talk.md' }, { from: 'a.arc1.md', to: 'talk.arc1.md' }]);
  assert.equal(fs.readFileSync(path.join(root, 'talk.md'), 'utf8'), '# a, changed\n');
  assert.ok(fs.existsSync(path.join(content.backupRoot, 'talk.md')));

  // One that can't move stops them all.
  assert.throws(() => content.rename([{ from: 'talk.md', to: 'b.md' }, { from: 'talk.arc1.md', to: 'sub/b.markdown' }]), ConflictError);
  assert.ok(fs.existsSync(path.join(root, 'talk.md')));
  assert.throws(() => content.rename([{ from: 'talk.md', to: 'talk.pdf' }]), PathError);
  assert.throws(() => content.rename([{ from: 'talk.md', to: 'talk.txt' }]), PathError);
  assert.throws(() => content.rename([{ from: 'talk.md', to: '../talk.md' }]), PathError);

  // Into a folder that isn't there yet.
  content.rename([{ from: 'talk.md', to: 'archive/talk.md' }]);
  assert.ok(fs.existsSync(path.join(root, 'archive', 'talk.md')));
});

test('trash sets a file aside, and restore brings it back, but not over another', () => {
  const { root, content } = fixture();
  const { trash } = content.trash('sub/b.markdown');
  assert.equal(fs.existsSync(path.join(root, 'sub', 'b.markdown')), false);
  assert.ok(fs.existsSync(path.join(content.trashRoot, trash)));
  assert.ok(!content.list().some((f) => f.path === 'sub/b.markdown'));

  fs.writeFileSync(path.join(root, 'sub', 'b.markdown'), 'another\n');
  assert.throws(() => content.restore(trash), ConflictError);
  fs.rmSync(path.join(root, 'sub', 'b.markdown'));
  assert.deepEqual(content.restore(trash), { path: 'sub/b.markdown' });
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.markdown'), 'utf8'), 'b\n');
  assert.deepEqual(fs.readdirSync(content.trashRoot), []);
  assert.throws(() => content.restore('20260101-000000-000/../../secret.md'), PathError);
  assert.throws(() => content.restore('nope'), PathError);
});

test('list walks a folder once, however many links lead back into it', () => {
  const { root, content } = fixture();
  fs.symlinkSync('..', path.join(root, 'sub', 'up'));
  fs.symlinkSync('.', path.join(root, 'self1'));
  fs.symlinkSync('.', path.join(root, 'self2'));
  const paths = content.list().map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.md', 'doc.pdf', 'sub/b.markdown']);
});

test('backups and the trash refuse a link in .reader, and touch nothing it points at', () => {
  const { base, root, content } = fixture();
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(outside, `file${String(i).padStart(2, '0')}.txt`), 'keep\n');
  fs.mkdirSync(path.join(root, '.reader', 'backups'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.reader', 'backups', 'a.md'));
  assert.throws(() => content.write('a.md', '# edited\n', { explicit: true }), PathError);
  assert.equal(fs.readdirSync(outside).length, 15);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# a\n');
  assert.throws(() => content.rename([{ from: 'a.md', to: 'z.md' }]), PathError);
  assert.ok(fs.existsSync(path.join(root, 'a.md')));

  fs.mkdirSync(path.join(outside, '20260101-000000-000'));
  fs.writeFileSync(path.join(outside, '20260101-000000-000', 'id_rsa.md'), 'key\n');
  fs.symlinkSync(outside, path.join(root, '.reader', 'trash'));
  assert.throws(() => content.trash('sub/b.markdown'), PathError);
  assert.ok(fs.existsSync(path.join(root, 'sub', 'b.markdown')));
  assert.throws(() => content.restore('20260101-000000-000/id_rsa.md'), PathError);
  assert.equal(fs.existsSync(path.join(root, 'id_rsa.md')), false);
});

test('extract writes the new files and what is left, or none of it', () => {
  const { root, content } = fixture();
  fs.writeFileSync(path.join(root, 'sub', 'taken.md'), 'here already\n');
  const { mtime } = content.read('a.md');
  const taken = { text: '→ [x](x.md)\n', baseMtime: mtime, files: [{ path: 'sub/one.md', text: '# one\n' }, { path: 'sub/taken.md', text: '# two\n' }] };
  assert.throws(() => content.extract('a.md', taken), ConflictError);
  assert.equal(fs.existsSync(path.join(root, 'sub', 'one.md')), false);
  assert.throws(() => content.extract('a.md', { text: '', baseMtime: mtime, files: [{ path: 'sub/one.txt', text: '' }] }), PathError);
  assert.throws(() => content.extract('a.md', { text: '', baseMtime: mtime - 1, files: [{ path: 'sub/one.md', text: '' }] }), ConflictError);

  const out = content.extract('a.md', { text: '→ [one](sub/one.md)\n', baseMtime: mtime, files: [{ path: 'sub/one.md', text: '# one\n' }] });
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '→ [one](sub/one.md)\n');
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'one.md'), 'utf8'), '# one\n');
  assert.deepEqual(out.files.map((f) => f.path), ['sub/one.md']);
});

test('unextract puts it back while neither file has changed, the new one in the trash', () => {
  const { root, content } = fixture();
  const { mtime } = content.read('a.md');
  const out = content.extract('a.md', { text: 'left\n', baseMtime: mtime, files: [{ path: 'one.md', text: 'one\n' }] });
  const stale = { text: '# a\n', mtime: out.mtime, files: [{ ...out.files[0], mtime: out.files[0].mtime - 1 }] };
  assert.throws(() => content.unextract('a.md', stale), ConflictError);
  content.unextract('a.md', { text: '# a\n', mtime: out.mtime, files: out.files });
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# a\n');
  assert.equal(fs.existsSync(path.join(root, 'one.md')), false);
  assert.equal(fs.readdirSync(content.trashRoot).length, 1);
});

test('rename changes only the case of a name, backups and all', () => {
  const { root, content } = fixture();
  content.write('a.md', '# a, changed\n', { explicit: true });
  const out = content.rename([{ from: 'a.md', to: 'A.md' }]);
  assert.deepEqual(out.moved, [{ from: 'a.md', to: 'A.md' }]);
  assert.ok(fs.readdirSync(root).includes('A.md'));
  assert.ok(!fs.readdirSync(root).includes('a.md'));
  assert.ok(fs.readdirSync(content.backupRoot).includes('A.md'));
  assert.equal(fs.readdirSync(path.join(content.backupRoot, 'A.md')).length, 1);
});

test('rename refuses, moving nothing, a file named twice or a name under another', () => {
  const { root, content } = fixture();
  content.branch('a.md', 'a.arc1.md');
  const before = () => fs.readdirSync(root).sort();
  const was = before();
  assert.throws(() => content.rename([{ from: 'a.md', to: 'x.md' }, { from: 'a.md', to: 'y.md' }]), PathError);
  assert.throws(() => content.rename([{ from: 'a.md', to: 'x.md' }, { from: 'a.arc1.md', to: 'x.md/a.md' }]), PathError);
  assert.throws(() => content.rename([{ from: 'a.md', to: 'x.md' }, { from: 'a.arc1.md', to: 'X.md' }]), ConflictError);
  assert.throws(() => content.rename([{ from: 'a.md', to: 'x.md' }, { from: 'a.arc1.md', to: 'doc.pdf/a.md' }]), PathError);
  assert.deepEqual(before(), was);
});

test('extract takes away the folders it made, when it can\'t finish', () => {
  const { root, content } = fixture();
  const { mtime } = content.read('a.md');
  const files = [{ path: 'new/deep/one.md', text: '# one\n' }, { path: 'sub/two.md', text: '# two\n' }];
  assert.throws(() => content.extract('a.md', { text: 42, baseMtime: mtime, files }), PathError);
  assert.equal(fs.existsSync(path.join(root, 'new')), false, 'the folders it made are gone');
  assert.equal(fs.existsSync(path.join(root, 'sub', 'two.md')), false, 'the files it made are gone');
  assert.ok(fs.existsSync(path.join(root, 'sub', 'b.markdown')));
});

test('unextract checks every file before it changes any', () => {
  const { root, content } = fixture();
  const { mtime } = content.read('a.md');
  const out = content.extract('a.md', { text: 'left\n', baseMtime: mtime, files: [{ path: 'one.md', text: 'one\n' }] });
  const twice = { text: '# a\n', mtime: out.mtime, files: [out.files[0], out.files[0]] };
  assert.throws(() => content.unextract('a.md', twice), PathError);
  const itself = { text: '# a\n', mtime: out.mtime, files: [{ path: 'a.md', mtime: out.mtime }] };
  assert.throws(() => content.unextract('a.md', itself), PathError);
  assert.throws(() => content.unextract('a.md', { text: '# a\n', mtime: out.mtime, files: 'one.md' }), PathError);
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), content.trashRoot);
  assert.throws(() => content.unextract('a.md', { text: '# a\n', mtime: out.mtime, files: out.files }), PathError);
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'left\n');
  assert.ok(fs.existsSync(path.join(root, 'one.md')));
});

test('dated lists what list does, each file with its date', () => {
  const { root, content } = fixture();
  fs.writeFileSync(path.join(root, 'sub', '2026-10-31.md'), '# a\n');
  fs.writeFileSync(path.join(root, 'sub', '2026-10-30.pdf'), '%PDF-1.4\n');
  fs.writeFileSync(path.join(root, '.hidden', '2026-10-31.md'), '# hidden\n');
  fs.writeFileSync(path.join(root, 'node_modules', '2026-10-31.md'), '# dep\n');
  fs.writeFileSync(path.join(root, 'a.md'), '---\ndate: 2026-10-29\n---\n');
  assert.deepEqual(content.dated().map((f) => f.path), content.list().map((f) => f.path));
  const dates = Object.fromEntries(content.dated().map((f) => [f.path, f.date]));
  assert.deepEqual(dates, {
    'a.md': '2026-10-29', 'doc.pdf': null, 'sub/b.markdown': null, 'sub/2026-10-31.md': '2026-10-31', 'sub/2026-10-30.pdf': '2026-10-30',
  });
});

test('dated reads only the start of a file', () => {
  const { root, content } = fixture();
  fs.writeFileSync(path.join(root, 'long.md'), `---\n${'key: value\n'.repeat(5000)}date: 2026-10-31\n---\n`);
  fs.writeFileSync(path.join(root, 'book.md'), `---\ndate: 2026-10-31\n---\n\n${'A long book.\n'.repeat(100000)}`);
  const dates = Object.fromEntries(content.dated().map((f) => [f.path, f.date]));
  assert.equal(dates['long.md'], null);
  assert.equal(dates['book.md'], '2026-10-31');
});

test('startable goes by the files it\'s given, dated already, and reads none of them again', () => {
  const { root, content } = fixture();
  fs.mkdirSync(path.join(root, 'journal'));
  fs.writeFileSync(path.join(root, 'journal', '2026-10-30.md'), '# a\n');
  const files = content.dated();
  assert.deepEqual(content.startable('2026-11-01', files), content.startable('2026-11-01'));
  fs.rmSync(path.join(root, 'journal'), { recursive: true });
  assert.equal(content.startable('2026-11-01', files)[0].from, 'journal/2026-10-30.md');
  assert.deepEqual(content.startable('2026-11-01'), []);
});

function journal(text = '---\ndate: 2026-10-30\n---\n\n@ A: a\n') {
  const f = fixture();
  fs.mkdirSync(path.join(f.root, 'journal'));
  fs.writeFileSync(path.join(f.root, 'journal', '2026-10-30.md'), text);
  const day = '2026-11-02';
  const edit = { from: 4, to: 5, before: ['@ A: a'], after: ['@ A:'] };
  const asked = (over = {}) => ({ from: 'journal/2026-10-30.md', mtime: f.content.startFrom('journal', day).mtime, edits: [edit], ...over });
  return { ...f, day, edit, asked, today: path.join(f.root, 'journal', `${day}.md`) };
}

test('startDay writes today\'s file from the latest, cleared and dated, and leaves the latest be', () => {
  const { content, day, asked, today, root } = journal();
  const was = fs.readFileSync(path.join(root, 'journal/2026-10-30.md'), 'utf8');
  assert.equal(content.startDay('journal', day, asked()).path, `journal/${day}.md`);
  assert.equal(fs.readFileSync(today, 'utf8'), `---\ndate: ${day}\n---\n\n@ A:\n`);
  assert.equal(fs.readFileSync(path.join(root, 'journal/2026-10-30.md'), 'utf8'), was);
});

test('startDay keeps a file\'s CRLF line endings', () => {
  const { content, day, asked, today } = journal('---\r\ntitle: A\r\ndate: 2026-10-30\r\n---\r\n\r\n@ A: a\r\n');
  const edits = [{ from: 5, to: 6, before: ['@ A: a'], after: ['@ A:'] }];
  content.startDay('journal', day, asked({ edits }));
  assert.equal(fs.readFileSync(today, 'utf8'), `---\r\ntitle: A\r\ndate: ${day}\r\n---\r\n\r\n@ A:\r\n`);
});

test('startDay never replaces a file that\'s there', () => {
  const { content, day, asked, today } = journal();
  const ask = asked();
  // Written after the folder was looked at: still refused by the write.
  fs.writeFileSync(today, 'mine\n');
  assert.throws(() => content.startDay('journal', day, ask), ConflictError);
  assert.equal(fs.readFileSync(today, 'utf8'), 'mine\n');
});

test('startDay writes nothing if the edits don\'t fit, or the latest has moved on or changed', () => {
  const { content, day, asked, today, edit, root } = journal();
  for (const bad of [
    { edits: [{ ...edit, before: ['@ A: other'] }] },
    { edits: 'all of it' },
    { edits: undefined },
    { from: 'journal/2020-01-01.md' },
    { mtime: 1 },
  ]) {
    assert.throws(() => content.startDay('journal', day, asked(bad)), ConflictError);
    assert.equal(fs.existsSync(today), false);
  }
  const ask = asked();
  fs.writeFileSync(path.join(root, 'journal/2026-11-01.md'), '# later\n');
  assert.throws(() => content.startDay('journal', day, ask), ConflictError);
  assert.equal(fs.existsSync(today), false);
});

test('startDay takes only a folder that\'s listed, whatever it\'s told', () => {
  const { content, day, asked, base } = journal();
  for (const dir of ['../..', '..', 'dir-out', '/etc', '.hidden', 'journal/', 'journal/../journal', 'nowhere']) {
    assert.throws(() => content.startFrom(dir, day), ConflictError, dir);
    assert.throws(() => content.startDay(dir, day, asked()), ConflictError, dir);
  }
  assert.equal(fs.readdirSync(base).filter((n) => n.endsWith(`${day}.md`)).length, 0);
});

test('startDay moves `open-until:` as far as the date moved, keeping its time', () => {
  const { content, day, asked, today } = journal('---\r\ndate: 2026-10-30\r\nopen-until: 2026-10-31 04:00\r\ntitle: 2026-10-30\r\n---\r\n\r\n@ A:\r\n');
  content.startDay('journal', day, asked({ edits: [] }));
  assert.equal(fs.readFileSync(today, 'utf8'), `---\r\ndate: ${day}\r\nopen-until: 2026-11-03 04:00\r\ntitle: 2026-10-30\r\n---\r\n\r\n@ A:\r\n`);
});

test('without a `date:`, `open-until:` keeps its distance from the date in the name', () => {
  const { content, day, asked, today } = journal('---\nopen-until: 2026-10-31\n---\n\n@ A:\n');
  content.startDay('journal', day, asked({ edits: [] }));
  assert.equal(fs.readFileSync(today, 'utf8'), '---\nopen-until: 2026-11-03\n---\n\n@ A:\n');
});

// Making a copy (gh-236): a file of its own, today's if it's dated, never over one that's there.

const copied = (content, rel, over = {}) => content.copy(rel, { mtime: content.copyFrom(rel).mtime, ...over });

test('a copy keeps its text, under a name no file has: -copy, then -copy-2', () => {
  const { content, root } = fixture();
  assert.equal(copied(content, 'a.md').path, 'a-copy.md');
  assert.equal(fs.readFileSync(path.join(root, 'a-copy.md'), 'utf8'), '# a\n');
  assert.equal(content.copyFrom('a.md').to, 'a-copy-2.md');
  // A copy of a copy is another copy, not a-copy-copy.
  assert.equal(copied(content, 'a-copy.md').path, 'a-copy-2.md');
  assert.equal(copied(content, 'sub/b.markdown').path, 'sub/b-copy.markdown');
  assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), '# a\n');
});

test('a copy for today takes today\'s name and date, clears what it\'s told, and moves `open-until:`', () => {
  const { content, day, edit, root } = journal('---\ndate: 2026-10-30\nopen-until: 2026-10-31 04:00\n---\n\n@ A: a\n');
  const plan = content.copyFrom('journal/2026-10-30.md', day);
  assert.equal(plan.to, `journal/${day}.md`);
  assert.equal(plan.date, '2026-10-30');
  const edits = [{ ...edit, from: 5, to: 6 }];
  assert.equal(copied(content, 'journal/2026-10-30.md', { edits, day }).path, `journal/${day}.md`);
  assert.equal(fs.readFileSync(path.join(root, 'journal', `${day}.md`), 'utf8'), `---\ndate: ${day}\nopen-until: 2026-11-03 04:00\n---\n\n@ A:\n`);
});

test('a file dated only by its `date:` keeps its name for today, so it\'s a -copy', () => {
  const { content, root } = fixture();
  fs.writeFileSync(path.join(root, 'plan.md'), '---\ndate: 2026-10-30\n---\n');
  assert.equal(copied(content, 'plan.md', { day: '2026-11-02' }).path, 'plan-copy.md');
  assert.equal(fs.readFileSync(path.join(root, 'plan-copy.md'), 'utf8'), '---\ndate: 2026-11-02\n---\n');
});

test('with today\'s already there, a copy for today is a -copy of it, and today\'s is left be', () => {
  const { content, day, today, root } = journal();
  fs.writeFileSync(today, 'mine\n');
  assert.equal(copied(content, 'journal/2026-10-30.md', { day }).path, `journal/${day}-copy.md`);
  assert.equal(fs.readFileSync(today, 'utf8'), 'mine\n');
  assert.match(fs.readFileSync(path.join(root, 'journal', `${day}-copy.md`), 'utf8'), new RegExp(`date: ${day}`));
});

test('an undated file copied for today is copied as it is', () => {
  const { content, root } = fixture();
  assert.equal(copied(content, 'sub/b.markdown', { day: '2026-11-02' }).path, 'sub/b-copy.markdown');
  assert.equal(fs.readFileSync(path.join(root, 'sub/b-copy.markdown'), 'utf8'), 'b\n');
});

test('a copy writes nothing if the file has changed, or the edits don\'t fit, and copies only documents inside', () => {
  const { content, root } = fixture();
  assert.throws(() => content.copy('a.md', { mtime: 1 }), ConflictError);
  assert.throws(() => copied(content, 'a.md', { edits: [{ from: 0, to: 1, before: ['no'], after: [''] }] }), ConflictError);
  assert.throws(() => copied(content, 'a.md', { edits: 'all' }), ConflictError);
  assert.equal(fs.existsSync(path.join(root, 'a-copy.md')), false);
  for (const rel of ['doc.pdf', 'notes.txt', '../secret.md', 'link-out.md', '.hidden/c.md']) {
    assert.throws(() => content.copyFrom(rel), (err) => err instanceof PathError, rel);
  }
});
