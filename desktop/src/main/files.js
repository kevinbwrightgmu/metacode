// @ts-check
// ── Workbooks on disk ─────────────────────────────────────────────────────────
//   library      Documents/MetaCode Sheets — where new workbooks go; the home
//                screen lists the .mcsheet files in it
//   save         written to a temporary file next to the target, flushed, then
//                renamed over it, so a crash mid-save never leaves half a file;
//                the version it replaces goes to the backups folder (last 5 per
//                workbook)
//   conflicts    before saving, the file is compared with what was opened: if
//                another program changed, moved or deleted it, the app asks
//                instead of overwriting
//   recovery     unsaved changes are copied to <userData>/recovery every few
//                seconds; after a crash the app offers them back
//   access       the window can only reach files the person picked in a
//                dialog, files in the library, and recent files — not
//                arbitrary paths
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const EXT = '.mcsheet';
const MAX_WORKBOOK_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_RECENT = 15;
const BACKUPS_PER_FILE = 5;

class FileError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** A file name the person typed: no folders, nothing the file system rejects @param {unknown} name */
function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) return null;
  return n;
}

/** @param {fs.Stats} st */
const stamp = st => ({ mtimeMs: Math.floor(st.mtimeMs), size: st.size });

/**
 * @param {{ libraryDir: string, userData: string, trash?: (p: string) => Promise<void>, now?: () => number }} o
 */
function createFiles(o) {
  const now = o.now || Date.now;
  const recoveryDir = path.join(o.userData, 'recovery');
  const backupsDir = path.join(o.userData, 'backups');
  const recentFile = path.join(o.userData, 'recent.json');
  const markerFile = path.join(o.userData, 'running.json');
  /** @type {Set<string>} */
  const granted = new Set();

  const norm = (/** @type {string} */ p) => path.resolve(p);
  function insideLibrary(/** @type {string} */ p) {
    const lib = norm(o.libraryDir) + path.sep;
    return norm(p).startsWith(lib) && !path.relative(o.libraryDir, p).includes('..');
  }
  /** @param {unknown} p @returns {string} */
  function allowed(p) {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) throw new FileError('invalid_path', 'That isn\'t a file path.');
    const n = norm(p);
    if (granted.has(n) || insideLibrary(n) || readRecent().some(r => norm(r.path) === n)) return n;
    throw new FileError('not_allowed', 'The app can only open files you choose (File › Open) or files in your library.');
  }
  const grant = (/** @type {string} */ p) => { granted.add(norm(p)); return norm(p); };

  async function atomicWrite(/** @type {string} */ file, /** @type {string | Uint8Array} */ data) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    const fh = await fsp.open(tmp, 'w', 0o644);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally { await fh.close(); }
    try { await fsp.rename(tmp, file); }
    catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
  }

  async function backup(/** @type {string} */ file) {
    let st;
    try { st = await fsp.stat(file); } catch (e) { return; }
    if (!st.isFile() || st.size > 64 * 1024 * 1024) return;
    const key = crypto.createHash('sha256').update(norm(file)).digest('hex').slice(0, 16);
    const dir = path.join(backupsDir, key);
    await fsp.mkdir(dir, { recursive: true });
    const name = new Date(now()).toISOString().replace(/[:.]/g, '-') + EXT;
    await fsp.copyFile(file, path.join(dir, name));
    await fsp.writeFile(path.join(dir, 'source.txt'), norm(file));
    const all = (await fsp.readdir(dir)).filter(f => f.endsWith(EXT)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_PER_FILE))) await fsp.rm(path.join(dir, old), { force: true });
  }

  /** @returns {{ path: string, name: string, openedAt: number }[]} */
  function readRecent() {
    try {
      const list = JSON.parse(fs.readFileSync(recentFile, 'utf8'));
      return Array.isArray(list) ? list.filter(r => r && typeof r.path === 'string' && path.isAbsolute(r.path)).slice(0, MAX_RECENT) : [];
    } catch (e) { return []; }
  }
  function writeRecent(/** @type {any[]} */ list) {
    try { fs.mkdirSync(o.userData, { recursive: true }); fs.writeFileSync(recentFile, JSON.stringify(list.slice(0, MAX_RECENT))); } catch (e) { /* not essential */ }
  }
  function touchRecent(/** @type {string} */ p) {
    const n = norm(p);
    writeRecent([{ path: n, name: path.basename(n), openedAt: now() }].concat(readRecent().filter(r => norm(r.path) !== n)));
  }

  /** A free file name in a folder: "Name.mcsheet", "Name (2).mcsheet", … @param {string} dir @param {string} base @param {string} [ext] */
  function freePath(dir, base, ext = EXT) {
    for (let i = 1; i < 1000; i++) {
      const p = path.join(dir, base + (i > 1 ? ' (' + i + ')' : '') + ext);
      if (!fs.existsSync(p)) return p;
    }
    throw new FileError('exists', 'Too many files with that name.');
  }

  const api = {
    EXT, grant, allowed, freePath, cleanName,
    libraryDir: () => o.libraryDir,

    async ensureLibrary() { await fsp.mkdir(o.libraryDir, { recursive: true }); return o.libraryDir; },

    /** The workbooks in the library, newest first */
    async library() {
      await api.ensureLibrary();
      const out = [];
      for (const f of await fsp.readdir(o.libraryDir)) {
        if (!f.toLowerCase().endsWith(EXT) || f.startsWith('.')) continue;
        const p = path.join(o.libraryDir, f);
        try { const st = await fsp.stat(p); if (st.isFile()) out.push({ path: p, name: f.slice(0, -EXT.length), modified: st.mtimeMs, size: st.size }); } catch (e) { /* vanished */ }
      }
      return out.sort((a, b) => b.modified - a.modified);
    },

    /** @returns {{ path: string, name: string, openedAt: number, missing: boolean }[]} */
    recent() { return readRecent().map(r => Object.assign({}, r, { missing: !fs.existsSync(r.path) })); },
    forgetRecent(/** @type {unknown} */ p) { if (typeof p === 'string') writeRecent(readRecent().filter(r => norm(r.path) !== norm(p))); },

    /** @param {unknown} p */
    async readWorkbook(p) {
      const file = allowed(p);
      let st;
      try { st = await fsp.stat(file); } catch (e) { throw new FileError('missing', 'The file "' + path.basename(file) + '" isn\'t there any more — it may have been moved, renamed or deleted.'); }
      if (!st.isFile()) throw new FileError('invalid_path', 'That isn\'t a file.');
      if (st.size > MAX_WORKBOOK_BYTES) throw new FileError('too_large', 'The file is larger than 512 MB.');
      const text = await fsp.readFile(file, 'utf8');
      touchRecent(file);
      return { path: file, name: path.basename(file).replace(/\.mcsheet$/i, ''), text, stat: stamp(st) };
    },

    /** Bytes of a file to import (.xlsx, .csv…) @param {unknown} p */
    async readBytes(p) {
      const file = allowed(p);
      const st = await fsp.stat(file).catch(() => null);
      if (!st || !st.isFile()) throw new FileError('missing', 'The file isn\'t there any more.');
      if (st.size > MAX_IMPORT_BYTES) throw new FileError('too_large', 'The file is larger than 256 MB, too large to import.');
      return { path: file, name: path.basename(file), bytes: new Uint8Array(await fsp.readFile(file)), size: st.size };
    },

    /**
     * Saves a workbook. `expected` is what the file looked like when it was
     * opened or last saved; if it changed since (or is gone), nothing is
     * written and the conflict is returned — unless `force`.
     * @param {unknown} p @param {string} text @param {{ expected?: { mtimeMs: number, size: number } | null, force?: boolean }} [opts]
     */
    async saveWorkbook(p, text, opts = {}) {
      const file = allowed(p);
      if (typeof text !== 'string' || text.length > MAX_WORKBOOK_BYTES) throw new FileError('invalid', 'Nothing to save.');
      let st = null;
      try { st = await fsp.stat(file); } catch (e) { st = null; }
      if (!opts.force && opts.expected) {
        if (!st) return { conflict: 'missing', message: '"' + path.basename(file) + '" was moved or deleted since you opened it.' };
        if (Math.abs(Math.floor(st.mtimeMs) - opts.expected.mtimeMs) > 1 || st.size !== opts.expected.size) return { conflict: 'changed', message: '"' + path.basename(file) + '" was changed by another program since you opened it.', stat: stamp(st) };
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (st) await backup(file).catch(() => {});
      await atomicWrite(file, text);
      touchRecent(file);
      return { path: file, stat: stamp(await fsp.stat(file)) };
    },

    /** A new file path chosen in the save dialog (granted) @param {string} p */
    async writeNew(p, /** @type {string | Uint8Array} */ data) {
      const file = grant(p);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWrite(file, data);
      if (file.toLowerCase().endsWith(EXT)) touchRecent(file);
      return { path: file, stat: stamp(await fsp.stat(file)) };
    },

    /** A new, empty-named workbook in the library @param {string} name @param {string} text */
    async createInLibrary(name, text) {
      await api.ensureLibrary();
      const base = cleanName(name) || 'Untitled';
      const file = grant(freePath(o.libraryDir, base));
      await atomicWrite(file, text);
      touchRecent(file);
      return { path: file, name: path.basename(file, EXT), stat: stamp(await fsp.stat(file)) };
    },

    /** @param {unknown} p @param {unknown} newName */
    async rename(p, newName) {
      const file = allowed(p);
      const n = cleanName(newName);
      if (!n) throw new FileError('invalid_name', 'Enter a name without / \\ : * ? " < > |');
      const target = path.join(path.dirname(file), n + EXT);
      if (norm(target) === file) return { path: file };
      if (fs.existsSync(target)) throw new FileError('exists', 'There\'s already a workbook called "' + n + '" in that folder.');
      await fsp.rename(file, target);
      grant(target);
      writeRecent(readRecent().map(r => (norm(r.path) === file ? { path: norm(target), name: path.basename(target), openedAt: r.openedAt } : r)));
      const st = await fsp.stat(target);
      return { path: norm(target), name: n, stat: stamp(st) };
    },

    /** @param {unknown} p */
    async duplicate(p) {
      const file = allowed(p);
      const base = path.basename(file, EXT).replace(/ \(copy( \d+)?\)$/, '') + ' (copy)';
      const target = grant(freePath(path.dirname(file), base));
      await fsp.copyFile(file, target, fs.constants.COPYFILE_EXCL);
      return { path: target, name: path.basename(target, EXT) };
    },

    /** Moves a workbook to the system trash (it can be restored from there) @param {unknown} p */
    async remove(p) {
      const file = allowed(p);
      if (!o.trash) throw new FileError('unsupported', 'Deleting isn\'t available.');
      await o.trash(file);
      granted.delete(file);
      writeRecent(readRecent().filter(r => norm(r.path) !== file));
      return { removed: true };
    },

    /** Has the file changed on disk since `expected`? @param {unknown} p @param {{ mtimeMs: number, size: number }} expected */
    async changedOnDisk(p, expected) {
      const file = allowed(p);
      let st;
      try { st = await fsp.stat(file); } catch (e) { return { state: 'missing' }; }
      if (!expected) return { state: 'same', stat: stamp(st) };
      return Math.abs(Math.floor(st.mtimeMs) - expected.mtimeMs) > 1 || st.size !== expected.size ? { state: 'changed', stat: stamp(st) } : { state: 'same', stat: stamp(st) };
    },

    /* ── Recovery ─────────────────────────────── */

    /** @param {unknown} docId @param {{ name: string, path?: string | null }} meta @param {string} text */
    async putRecovery(docId, meta, text) {
      if (typeof docId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) throw new FileError('invalid', 'Bad document id.');
      if (typeof text !== 'string' || text.length > MAX_WORKBOOK_BYTES) throw new FileError('invalid', 'Bad recovery data.');
      await fsp.mkdir(recoveryDir, { recursive: true });
      await atomicWrite(path.join(recoveryDir, docId + EXT), text);
      await atomicWrite(path.join(recoveryDir, docId + '.json'), JSON.stringify({ name: String(meta.name || 'Untitled').slice(0, 200), path: typeof meta.path === 'string' ? meta.path : null, savedAt: now() }));
      return { ok: true };
    },
    async listRecovery() {
      let names = [];
      try { names = await fsp.readdir(recoveryDir); } catch (e) { return []; }
      const out = [];
      for (const f of names) {
        const m = /^([A-Za-z0-9_-]{1,64})\.json$/.exec(f);
        if (!m) continue;
        try {
          const meta = JSON.parse(await fsp.readFile(path.join(recoveryDir, f), 'utf8'));
          const st = await fsp.stat(path.join(recoveryDir, m[1] + EXT));
          out.push({ docId: m[1], name: String(meta.name || 'Untitled'), path: typeof meta.path === 'string' ? meta.path : null, savedAt: Number(meta.savedAt) || st.mtimeMs, size: st.size });
        } catch (e) { /* half-written: skipped */ }
      }
      return out.sort((a, b) => b.savedAt - a.savedAt);
    },
    /** @param {unknown} docId */
    async readRecovery(docId) {
      if (typeof docId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) throw new FileError('invalid', 'Bad document id.');
      const text = await fsp.readFile(path.join(recoveryDir, docId + EXT), 'utf8');
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(recoveryDir, docId + '.json'), 'utf8')); } catch (e) { meta = {}; }
      const mp = /** @type {any} */ (meta).path;
      if (typeof mp === 'string' && path.isAbsolute(mp)) grant(mp);    // the file it belongs to may be saved to again
      return { text, meta };
    },
    /** @param {unknown} docId */
    async discardRecovery(docId) {
      if (typeof docId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) return { ok: false };
      await fsp.rm(path.join(recoveryDir, docId + EXT), { force: true });
      await fsp.rm(path.join(recoveryDir, docId + '.json'), { force: true });
      return { ok: true };
    },

    /* ── Did the last session end cleanly? ──── */
    startSession() {
      let crashed = false;
      try { crashed = fs.existsSync(markerFile); } catch (e) { crashed = false; }
      try { fs.mkdirSync(o.userData, { recursive: true }); fs.writeFileSync(markerFile, JSON.stringify({ pid: process.pid, startedAt: now() })); } catch (e) { /* not essential */ }
      return { crashed };
    },
    endSession() { try { fs.unlinkSync(markerFile); } catch (e) { /* gone */ } }
  };
  return api;
}

module.exports = { createFiles, FileError, cleanName, EXT, MAX_IMPORT_BYTES };
