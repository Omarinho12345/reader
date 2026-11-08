/**
 * The content directory: every read and write the server makes goes through
 * here, so this is the one place that decides what is inside the root.
 *
 *   list()                     files the UI can open, newest first
 *   dated()                    the same, each with its `date` (src/dates.js) or null
 *   read(rel)                  { text, mtime }
 *   write(rel, text, opts)     atomic, with a conflict check and backups
 *   create(name?)              a new file, `untitled.md` by default
 *   branch(from, to)           a copy of a document, as another version of it
 *   startable(day, files?)     the folders with a series of dated files, and where `day`'s is: of `files`, if they're dated() already
 *   startFrom(dir, day)        what it would be made from: { from, to, text, mtime }
 *   startDay(dir, day, opts)   and made, from that with its answers cleared, if it isn't there
 *   copyFrom(rel, day?)        what a copy of a document would be called: { from, to, text, mtime, date }
 *   copy(rel, opts)            and made, a file of its own, `day`'s if it's dated
 *   promote(rel, base)         make a version the main one, `base.ext`
 *   rename(moves)              [{ from, to }], all or none, backups and all
 *   trash(rel) / restore(id)   into `.reader/trash/`, and back out
 *   extract(rel, opts)         new files from parts of one, written with what's left
 *   unextract(rel, opts)       and put back, if neither has changed since
 *   resolve(rel)               absolute path, or a PathError
 *
 * Paths crossing this boundary are always root-relative with `/` separators.
 */

import fs from 'node:fs';
import path from 'node:path';
import { dateOf, startable, withDate, withDayInName, daysBetween } from './dates.js';
import { movedLine } from './page.js';
import { withEdits } from '../static/edits.js';

export const DOC_EXTS = new Set(['.md', '.markdown']);
export const LISTED_EXTS = new Set([...DOC_EXTS, '.pdf']);

const STATE_DIR = '.reader';
const BACKUPS_KEPT = 10;
const BACKUP_EVERY_MS = 5 * 60 * 1000;
// How much of a file is read for its front matter. One longer than this, far
// past any written, is read as having none; a library of whole books costs
// no more to list than a folder of notes.
const MATTER_BYTES = 16 * 1024;

export class PathError extends Error {
  status = 400;
}
export class NotFoundError extends Error {
  status = 404;
}
export class ConflictError extends Error {
  status = 409;
  constructor(message, mtime) {
    super(message);
    this.mtime = mtime;
  }
}

export function createContent(rootDir) {
  const root = fs.realpathSync(rootDir);
  const backupRoot = path.join(root, STATE_DIR, 'backups');
  const trashRoot = path.join(root, STATE_DIR, 'trash');

  const inside = (abs) => abs === root || abs.startsWith(root + path.sep);
  const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/');

  /** Root-relative path -> absolute path, refusing anything that escapes. */
  function resolve(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) {
      throw new PathError('missing or invalid path');
    }
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new PathError(`absolute paths are not allowed: ${rel}`);
    }
    const parts = rel.split(/[\\/]+/);
    if (parts.some((p) => p === '..' || p.startsWith('.'))) {
      throw new PathError(`not allowed: ${rel}`);
    }
    const abs = path.resolve(root, rel);
    if (!inside(abs) || abs === root) throw new PathError(`outside the content directory: ${rel}`);

    // Lexically inside is not enough: a symlink can still point out. Check the
    // real location of the file, or of its nearest existing ancestor.
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    if (!inside(fs.realpathSync(probe))) {
      throw new PathError(`outside the content directory: ${rel}`);
    }
    return abs;
  }

  /**
   * Whether `toAbs` is there already, as another file than `fromAbs`. On a
   * filesystem that ignores case, `A.md` is there when `a.md` is, but as
   * the same file, and renaming one to the other only changes its case.
   */
  function taken(fromAbs, toAbs) {
    const to = fs.statSync(toAbs, { throwIfNoEntry: false });
    if (!to) return false;
    if (fromAbs.toLowerCase() !== toAbs.toLowerCase()) return true;
    const from = fs.statSync(fromAbs, { throwIfNoEntry: false });
    return !from || from.dev !== to.dev || from.ino !== to.ino;
  }

  /**
   * A path in reader's own .reader folder, refusing a symlink anywhere along
   * it: a folder that came with the files could point backups and the trash
   * anywhere, to be written, pruned and taken from.
   */
  function own(abs) {
    for (let at = abs; at !== root; at = path.dirname(at)) {
      if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new PathError(`${toRel(at)} is a link; reader keeps its own files there`);
      }
    }
    return abs;
  }

  function list() {
    const out = [];
    // The real folders being walked into: a link back to one of them would
    // walk it again, and again.
    const within = new Set();
    const walk = (dir) => {
      const real = fs.realpathSync(dir);
      if (within.has(real)) return;
      within.add(real);
      try {
        visit(dir);
      } finally {
        within.delete(real);
      }
    };
    const visit = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        const abs = path.join(dir, ent.name);
        let stat;
        try {
          // Follow symlinks only when they stay inside the root.
          if (!inside(fs.realpathSync(abs))) continue;
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(abs);
        } else if (stat.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (!LISTED_EXTS.has(ext)) continue;
          out.push({
            path: toRel(abs),
            type: ext === '.pdf' ? 'pdf' : 'md',
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        }
      }
    };
    walk(root);
    return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  }

  /** Every listed file with its date, each document read only as far as its front matter can be. */
  function dated() {
    const head = Buffer.allocUnsafe(MATTER_BYTES);
    const start = (rel) => {
      let fd;
      try {
        fd = fs.openSync(path.join(root, rel), 'r');
        return head.toString('utf8', 0, fs.readSync(fd, head, 0, MATTER_BYTES, 0));
      } catch {
        // Listed but not readable, or gone since: its name can still say.
        return '';
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    };
    return list().map((f) => ({ ...f, date: dateOf(f.path, f.type === 'md' ? start(f.path) : '') }));
  }

  function statFile(rel) {
    const abs = resolve(rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new NotFoundError(`no such file: ${rel}`);
    }
    if (!stat.isFile()) throw new NotFoundError(`not a file: ${rel}`);
    return { abs, stat };
  }

  function read(rel) {
    const { abs, stat } = statFile(rel);
    return { path: rel, text: fs.readFileSync(abs, 'utf8'), mtime: stat.mtimeMs };
  }

  /**
   * Save `text` to `rel`.
   *
   * `baseMtime` is the mtime the editor loaded; if the file has changed on
   * disk since then the write is refused with a ConflictError rather than
   * clobbering someone else's edit. Omit it (or pass `force`) to overwrite.
   *
   * `explicit` marks a deliberate save (⌘S): it always takes a backup, where
   * autosave only takes one every few minutes.
   */
  function write(rel, text, { baseMtime, force = false, explicit = false } = {}) {
    const abs = resolve(rel);
    if (!DOC_EXTS.has(path.extname(abs).toLowerCase())) {
      throw new PathError(`only markdown files can be edited: ${rel}`);
    }
    if (typeof text !== 'string') throw new PathError('text must be a string');

    let current = null;
    try {
      current = fs.statSync(abs);
    } catch {
      /* new file */
    }

    if (current && !force && baseMtime != null && current.mtimeMs !== baseMtime) {
      throw new ConflictError(`${rel} changed on disk`, current.mtimeMs);
    }

    if (current) {
      const previous = fs.readFileSync(abs, 'utf8');
      if (previous === text) return { path: rel, mtime: current.mtimeMs, unchanged: true };
      backup(rel, previous, explicit);
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, text, 'utf8');
    if (current) fs.chmodSync(tmp, current.mode & 0o777);
    fs.renameSync(tmp, abs);
    return { path: rel, mtime: fs.statSync(abs).mtimeMs };
  }

  function backup(rel, previous, explicit) {
    const dir = own(path.join(backupRoot, rel));
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
    const newest = existing.at(-1);
    if (!explicit && newest) {
      const age = Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs;
      if (age < BACKUP_EVERY_MS) return;
    }
    const ext = path.extname(rel) || '.md';
    // Two saves can land in the same millisecond; a sequence number keeps
    // both copies and keeps them in order.
    const at = stamp();
    let seq = 0;
    let file;
    do file = path.join(dir, `${at}-${String(seq++).padStart(2, '0')}${ext}`);
    while (fs.existsSync(file));
    fs.writeFileSync(file, previous, 'utf8');
    const all = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
    for (const name of all.slice(0, -BACKUPS_KEPT)) fs.rmSync(path.join(dir, name));
  }

  /** Create a new markdown file. Dating one is for a name to say, or Start today's. */
  function create(name) {
    if (name != null && typeof name !== 'string') throw new PathError('name must be a string');
    let rel = (name || '').trim() || 'untitled.md';
    // `release 1.2` is a name with a dot in it, not a `.2` file.
    if (!LISTED_EXTS.has(path.extname(rel).toLowerCase())) rel += '.md';
    const abs = resolve(rel);
    if (!DOC_EXTS.has(path.extname(abs).toLowerCase())) {
      throw new PathError(`new files must be markdown: ${rel}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let created = true;
    try {
      fs.writeFileSync(abs, '', { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      created = false;
    }
    return { path: toRel(abs), created, mtime: fs.statSync(abs).mtimeMs };
  }

  /** Copy a document to a new name, to work on beside the original. */
  function branch(from, to) {
    const { abs: fromAbs } = statFile(from);
    const toAbs = resolve(to);
    if (!DOC_EXTS.has(path.extname(fromAbs).toLowerCase())) throw new PathError(`not a document: ${from}`);
    if (!DOC_EXTS.has(path.extname(toAbs).toLowerCase())) throw new PathError(`versions must be markdown: ${to}`);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    try {
      fs.copyFileSync(fromAbs, toAbs, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err.code === 'EEXIST') throw new ConflictError(`${to} already exists`);
      throw err;
    }
    return { path: toRel(toAbs), mtime: fs.statSync(toAbs).mtimeMs };
  }

  /** What `day`'s file in the folder `dir` (`''` being the top) would be made from, and called. */
  function startFrom(dir, day) {
    const start = startable(dated(), day).find((s) => s.dir === dir && s.from);
    if (!start) throw new ConflictError(`${dir || 'this folder'} has nothing to start ${day} from, or has it already`);
    const { text, mtime } = read(start.from);
    return { ...start, text, mtime };
  }

  /**
   * Make `day`'s file in the folder `dir`, in one step: the folder's latest
   * file, picked again here, with `edits` made to it (static/edits.js), which
   * clear its answers, its `date:` set, and what its front matter dates by that
   * one (`open-until:`) moved as far. All the edits can do is say what's
   * in the new file. What they were worked out from is `from`, as it was at
   * `mtime`, so if that's no longer the latest, or has changed, they're
   * refused and nothing is written. Nor is a file that's there replaced.
   */
  function startDay(dir, day, { from, mtime, edits }) {
    const start = startFrom(dir, day);
    if (start.from !== from || start.mtime !== mtime) throw new ConflictError(`${from} has changed since its answers were cleared`, start.mtime);
    return made(start, edits, day);
  }

  /**
   * What a copy of the document `rel` would be: `{ from, to, text, mtime,
   * date }`. For `day`, if it's dated (`dateOf`), the copy is that day's: its
   * name has `day` in place of the date in it, and `date` is the one it's
   * moved from. Otherwise it's null, and the name stays. Either name, if
   * it's taken, has `-copy` put on it, then `-copy-2`, and so on, so
   * `notes.md` is copied as `notes-copy.md`, and so is `notes-copy.md` itself.
   */
  function copyFrom(rel, day = null) {
    if (!DOC_EXTS.has(path.extname(String(rel)).toLowerCase())) throw new PathError(`not a document: ${rel}`);
    const { text, mtime } = read(rel);
    const date = (day && dateOf(rel, text)) || null;
    return { from: rel, to: unused(date ? withDayInName(rel, day) : rel), text, mtime, date };
  }

  /** `rel`, or the first of `rel-copy`, `rel-copy-2`, ... that no file has. */
  function unused(rel) {
    if (!fs.existsSync(resolve(rel))) return rel;
    const ext = path.extname(rel);
    const stem = rel.slice(0, rel.length - ext.length).replace(/-copy(?:-\d+)?$/, '');
    for (let n = 1; ; n++) {
      const to = `${stem}-copy${n > 1 ? `-${n}` : ''}${ext}`;
      if (!fs.existsSync(resolve(to))) return to;
    }
  }

  /**
   * Copy the document `rel` to a file of its own, as copyFrom names it, with
   * `edits` made to it (none keeps its text): `day`'s, if that's given and it's
   * dated, as startDay makes one. They were worked out from `rel` as it was at
   * `mtime`, so if it's changed since, nothing is written.
   */
  function copy(rel, { mtime, edits = [], day = null } = {}) {
    const plan = copyFrom(rel, day);
    if (plan.mtime !== mtime) throw new ConflictError(`${rel} has changed since it was copied`, plan.mtime);
    return made(plan, edits, day);
  }

  /**
   * Write the file `to`, `text` (from `from`) with `edits` made to it, never
   * over a file that's there. With a `date`, it's made `day`'s: its `date:`
   * set, and what its front matter dates by that one (`open-until:`) moved as far.
   */
  function made({ from, to, text, mtime, date }, edits, day) {
    const cleared = withEdits(text, edits);
    if (cleared == null) throw new ConflictError(`what was cleared doesn't fit ${from}`, mtime);
    const away = date ? daysBetween(date, day) : 0;
    const out = date ? withDate(cleared, day, (line) => movedLine(line, away)) : cleared;
    const abs = resolve(to);
    try {
      fs.writeFileSync(abs, out, { flag: 'wx', mode: statFile(from).stat.mode & 0o777 });
    } catch (err) {
      if (err.code === 'EEXIST') throw new ConflictError(`${to} already exists`);
      throw err;
    }
    return { path: to, from, mtime: fs.statSync(abs).mtimeMs };
  }

  /**
   * Make `rel` (`slides.arc1.md`) the main version of `base` (`slides`): it
   * takes the name `slides.md`, and the file that had it becomes a version
   * named after the day it was last changed (`slides.oct13.md`).
   */
  function promote(rel, base) {
    const { abs } = statFile(rel);
    const ext = path.extname(abs);
    const stem = path.basename(abs, ext);
    if (!DOC_EXTS.has(ext.toLowerCase())) throw new PathError(`not a document: ${rel}`);
    if (typeof base !== 'string' || !stem.startsWith(base + '.') || base.includes('/')) {
      throw new PathError(`${rel} is not a version of ${base}`);
    }
    const dir = path.dirname(abs);
    const mainAbs = path.join(dir, base + ext);
    const moved = [];
    if (fs.existsSync(mainAbs)) {
      const day = monthDay(new Date(fs.statSync(mainAbs).mtimeMs));
      let aside = path.join(dir, `${base}.${day}${ext}`);
      for (let n = 2; fs.existsSync(aside); n++) aside = path.join(dir, `${base}.${day}-${n}${ext}`);
      moved.push(move(mainAbs, aside));
    }
    moved.push(move(abs, mainAbs));
    return { path: toRel(mainAbs), moved };
  }

  /**
   * Rename files: one, or every version of a file together. Each keeps its
   * kind (a document stays a document), and nothing is moved unless all of
   * them can be.
   */
  function rename(moves) {
    if (!Array.isArray(moves) || !moves.length) throw new PathError('nothing to rename');
    const kind = (p) => (DOC_EXTS.has(path.extname(p).toLowerCase()) ? 'md' : path.extname(p).toLowerCase());
    // By lower case, so that two names one filesystem tells apart and
    // another doesn't are refused on both.
    const sources = new Set();
    const targets = new Set();
    const planned = moves.map((m) => {
      const { from, to } = m ?? {};
      const { abs: fromAbs } = statFile(from);
      const toAbs = resolve(to);
      if (sources.has(fromAbs)) throw new PathError(`${from} is named more than once`);
      sources.add(fromAbs);
      if (!LISTED_EXTS.has(path.extname(toAbs).toLowerCase()) || kind(fromAbs) !== kind(toAbs)) {
        throw new PathError(`${to} would be a different kind of file than ${from}`);
      }
      if (taken(fromAbs, toAbs) || targets.has(toAbs.toLowerCase())) throw new ConflictError(`${to} already exists`);
      targets.add(toAbs.toLowerCase());
      // Its folders must be folders: not a file that's there, nor another of the new names.
      let dir = path.dirname(toAbs);
      while (!fs.existsSync(dir)) dir = path.dirname(dir);
      if (!fs.statSync(dir).isDirectory()) throw new PathError(`${toRel(dir)} isn't a folder`);
      // Before anything moves, so that none does.
      own(path.join(backupRoot, toRel(fromAbs)));
      own(path.join(backupRoot, toRel(toAbs)));
      return [fromAbs, toAbs];
    });
    for (const [, toAbs] of planned) {
      for (let dir = path.dirname(toAbs); dir !== root; dir = path.dirname(dir)) {
        if (targets.has(dir.toLowerCase())) throw new PathError(`${toRel(dir)} can't be both a file and a folder`);
      }
    }
    return {
      moved: planned.map(([fromAbs, toAbs]) => {
        fs.mkdirSync(path.dirname(toAbs), { recursive: true });
        return move(fromAbs, toAbs);
      }),
    };
  }

  /** Set a file aside in `.reader/trash/`, where `restore` can find it. Its backups stay. */
  function trash(rel) {
    const { abs } = statFile(rel);
    const id = `${stamp()}/${toRel(abs)}`;
    const dest = own(path.join(trashRoot, id));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest);
    return { path: toRel(abs), trash: id };
  }

  function restore(id) {
    const m = typeof id === 'string' && /^(\d{8}-\d{6}-\d{3})\/(.+)$/.exec(id);
    if (!m) throw new PathError('not something in the trash');
    const rel = m[2];
    const toAbs = resolve(rel);
    const fromAbs = own(path.join(trashRoot, m[1], ...rel.split('/')));
    if (!fs.existsSync(fromAbs)) throw new NotFoundError(`${rel} isn't in the trash`);
    if (fs.existsSync(toAbs)) throw new ConflictError(`${rel} already exists`);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    // And the folders it was set aside in, now they're empty.
    for (let dir = path.dirname(fromAbs); dir !== trashRoot && !fs.readdirSync(dir).length; dir = path.dirname(dir)) fs.rmdirSync(dir);
    return { path: rel };
  }

  /**
   * Write `files` ([{ path, text }]), parts taken out of `rel`, and then
   * `text`, what `rel` is without them. None of the new files may be there
   * already, and `rel` must still be as it was at `baseMtime`; if anything
   * can't be written, nothing is.
   */
  function extract(rel, { text, baseMtime, files } = {}) {
    statFile(rel);
    if (!Array.isArray(files) || !files.length) throw new PathError('nothing to extract');
    const planned = new Set();
    const targets = files.map((f) => {
      const abs = resolve(f?.path);
      if (!DOC_EXTS.has(path.extname(abs).toLowerCase())) throw new PathError(`new files must be markdown: ${f.path}`);
      if (typeof f.text !== 'string') throw new PathError('text must be a string');
      if (fs.existsSync(abs) || planned.has(abs)) throw new ConflictError(`${toRel(abs)} already exists`);
      planned.add(abs);
      return { abs, text: f.text };
    });
    const current = fs.statSync(resolve(rel)).mtimeMs;
    if (baseMtime != null && current !== baseMtime) throw new ConflictError(`${rel} changed on disk`, current);
    const made = [];
    // Each folder made for them, from the outermost one that wasn't there.
    const folders = [];
    try {
      for (const t of targets) {
        // Found by walking up the path itself, rather than from what mkdirSync
        // returns, which on Windows needn't spell it as `root` does (RUNNER~1).
        const last = path.dirname(t.abs);
        let first = null;
        for (let dir = last; inside(dir) && dir !== root && !fs.existsSync(dir); dir = path.dirname(dir)) first = dir;
        fs.mkdirSync(last, { recursive: true });
        if (first) folders.push([first, last]);
        fs.writeFileSync(t.abs, t.text, { encoding: 'utf8', flag: 'wx' });
        made.push(t.abs);
      }
      const out = write(rel, text, { baseMtime, explicit: true });
      return { path: rel, mtime: out.mtime, files: made.map((abs) => ({ path: toRel(abs), mtime: fs.statSync(abs).mtimeMs })) };
    } catch (err) {
      for (const abs of made) fs.rmSync(abs, { force: true });
      for (const [first, last] of folders.reverse()) {
        for (let dir = last; ; dir = path.dirname(dir)) {
          if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
          if (dir === first) break;
        }
      }
      throw err;
    }
  }

  /**
   * Undo an extract: `rel` back to `text`, and the files it made set aside
   * in the trash. Only while `rel` and each file are as the extract left
   * them (`mtime`, and each file's); after that, it would be a merge.
   */
  function unextract(rel, { text, mtime, files } = {}) {
    const changed = (p, at) => statFile(p).stat.mtimeMs !== at;
    if (changed(rel, mtime)) throw new ConflictError(`${rel} has changed since, so it's left as it is`);
    if (files != null && !Array.isArray(files)) throw new PathError('files must be a list');
    // All of it before anything is written, so that it all goes back or none of it does.
    const seen = new Set([resolve(rel)]);
    for (const f of files || []) {
      const abs = resolve(f?.path);
      if (seen.has(abs)) throw new PathError(`${f.path} is named more than once`);
      seen.add(abs);
      if (changed(f.path, f.mtime)) throw new ConflictError(`${f.path} has changed since, so it's left as it is`);
    }
    if (files?.length) own(trashRoot);
    const out = write(rel, text, { baseMtime: mtime, explicit: true });
    for (const f of files || []) trash(f.path);
    return { path: rel, mtime: out.mtime };
  }

  /** Rename a file, and its backups with it, never over another file. */
  function move(fromAbs, toAbs) {
    const from = toRel(fromAbs);
    const to = toRel(toAbs);
    resolve(to);
    if (taken(fromAbs, toAbs)) throw new ConflictError(`${to} already exists`);
    const oldBackups = own(path.join(backupRoot, from));
    const newBackups = own(path.join(backupRoot, to));
    fs.renameSync(fromAbs, toAbs);
    if (fs.existsSync(oldBackups)) {
      if (!taken(oldBackups, newBackups)) {
        fs.mkdirSync(path.dirname(newBackups), { recursive: true });
        fs.renameSync(oldBackups, newBackups);
      } else {
        // Left from an earlier file by this name: they're named by time, so they mix.
        for (const name of fs.readdirSync(oldBackups)) {
          const dest = path.join(newBackups, name);
          if (!fs.existsSync(dest)) fs.renameSync(path.join(oldBackups, name), dest);
        }
        fs.rmSync(oldBackups, { recursive: true, force: true });
      }
    }
    return { from, to };
  }

  return { root, resolve, list, dated, read, write, create, branch,
    startable: (day, files = dated()) => startable(files, day),
    startFrom,
    startDay, copyFrom, copy, promote, rename, trash, restore, extract, unextract, statFile, backupRoot, trashRoot };
}

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthDay(d) {
  return `${MONTHS[d.getMonth()]}${d.getDate()}`;
}

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  );
}
