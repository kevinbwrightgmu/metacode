// @ts-check
// ── AI Coding Lab storage ─────────────────────────────────────────────────────
// Every user has a folder of their own under AI_LAB_DATA_DIR/users/<key>/
// (key: a one-way hash of the account id), with one JSON file per object:
//
//   projects/<id>.json  profiles/<id>.json  conversations/<id>.json
//   documents/<id>.json datasets/<id>.json   suites/<id>.json
//   runs/<id>.json      finetunes/<id>.json
//   datasets/<id>/v<n>.json        a dataset version (immutable)
//   runs/<id>/results.ndjson       an evaluation run's task results
//   audit.ndjson                   configuration changes (no content)
//
// Isolation is structural: a request only ever opens the folder of the user
// the server authenticated (policy.js), so another user's ids simply don't
// exist for it. Writes go to a temporary file and are renamed into place.
// The same convention as the rest of MetaCode's server data (survey-data/,
// account-data/); see docs/ai-lab.md for moving to a database later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['projects', 'profiles', 'conversations', 'documents', 'datasets', 'suites', 'runs', 'finetunes'];
const PREFIX = { projects: 'prj', profiles: 'prf', conversations: 'cnv', documents: 'doc', datasets: 'dst', suites: 'ste', runs: 'run', finetunes: 'ftj', messages: 'msg', examples: 'exm' };
const ID_RE = /^[a-z]{3}_[A-Za-z0-9_-]{16}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/;

/** @param {keyof typeof PREFIX} kind */
function newId(kind) {
  return PREFIX[kind] + '_' + crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

/** @param {unknown} id */
const isId = id => typeof id === 'string' && ID_RE.test(id);

/**
 * @param {string} file
 * @param {string} text
 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** @param {string} p */
function sizeOf(p) {
  let total = 0;
  let st;
  try { st = fs.statSync(p); } catch (e) { return 0; }
  if (st.isFile()) return st.size;
  for (const name of fs.readdirSync(p)) total += sizeOf(path.join(p, name));
  return total;
}

class UserStore {
  /** @param {string} root */
  constructor(root) {
    this.root = root;
    /** @type {Map<string, Map<string, any>>} kind → id → object */
    this.cache = new Map();
    /** @type {number | null} */
    this.usedBytes = null;
  }

  /** @param {string} kind */
  checkKind(kind) { if (!KINDS.includes(kind)) throw new Error('Unknown kind ' + kind); }

  /** @param {string} kind @param {string} id */
  file(kind, id) {
    this.checkKind(kind);
    if (!isId(id)) throw new Error('Invalid id');
    return path.join(this.root, kind, id + '.json');
  }

  /** @param {string} kind */
  load(kind) {
    this.checkKind(kind);
    let map = this.cache.get(kind);
    if (map) return map;
    map = new Map();
    const dir = path.join(this.root, kind);
    /** @type {string[]} */
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!isId(id)) continue;
      try { map.set(id, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch (e) { /* unreadable: skipped */ }
    }
    this.cache.set(kind, map);
    return map;
  }

  /**
   * @param {string} kind
   * @returns {any[]}
   */
  list(kind) { return Array.from(this.load(kind).values()); }

  /**
   * @param {string} kind
   * @param {unknown} id
   * @returns {any | null}
   */
  get(kind, id) { return isId(id) ? this.load(kind).get(/** @type {string} */ (id)) || null : null; }

  /**
   * @param {string} kind
   * @param {{ id: string }} obj
   */
  put(kind, obj) {
    const file = this.file(kind, obj.id);
    const text = JSON.stringify(obj);
    const before = this.usedBytes !== null ? sizeOf(file) : 0;
    writeAtomic(file, text);
    this.load(kind).set(obj.id, obj);
    if (this.usedBytes !== null) this.usedBytes += Buffer.byteLength(text) - before;
    return obj;
  }

  /** @param {string} kind @param {string} id */
  remove(kind, id) {
    if (!isId(id)) return false;
    const existed = this.load(kind).delete(id);
    try { fs.rmSync(this.file(kind, id), { force: true }); } catch (e) { /* gone */ }
    try { fs.rmSync(path.join(this.root, kind, id), { recursive: true, force: true }); } catch (e) { /* none */ }
    this.usedBytes = null;
    return existed;
  }

  /** A file that belongs to one object: datasets/<id>/v3.json, runs/<id>/results.ndjson */
  /** @param {string} kind @param {string} id @param {string} name */
  sidecar(kind, id, name) {
    this.checkKind(kind);
    if (!isId(id) || !NAME_RE.test(name)) throw new Error('Invalid file name');
    return path.join(this.root, kind, id, name);
  }

  /** @param {string} kind @param {string} id @param {string} name @param {string} text */
  writeSidecar(kind, id, name, text) {
    writeAtomic(this.sidecar(kind, id, name), text);
    this.usedBytes = null;
  }

  /** @param {string} kind @param {string} id @param {string} name */
  readSidecar(kind, id, name) {
    try { return fs.readFileSync(this.sidecar(kind, id, name), 'utf8'); } catch (e) { return null; }
  }

  /** @param {string} kind @param {string} id @param {string} name @param {unknown} obj */
  appendLine(kind, id, name, obj) {
    const file = this.sidecar(kind, id, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify(obj) + '\n';
    fs.appendFileSync(file, line, { mode: 0o600 });
    if (this.usedBytes !== null) this.usedBytes += Buffer.byteLength(line);
  }

  /** @param {string} kind @param {string} id @param {string} name @returns {any[]} */
  readLines(kind, id, name) {
    const text = this.readSidecar(kind, id, name);
    if (!text) return [];
    /** @type {any[]} */
    const out = [];
    for (const line of text.split('\n')) { if (line) { try { out.push(JSON.parse(line)); } catch (e) { /* torn last line */ } } }
    return out;
  }

  /** Bytes this user's Lab data takes on disk. */
  bytes() {
    if (this.usedBytes === null) this.usedBytes = sizeOf(this.root);
    return this.usedBytes;
  }

  /**
   * A configuration change, for the audit trail (never content).
   * @param {string} action
   * @param {Record<string, string | number | boolean | null>} data
   */
  audit(action, data) {
    const file = path.join(this.root, 'audit.ndjson');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(Object.assign({ ts: new Date().toISOString(), action }, data)) + '\n', { mode: 0o600 });
  }

  /** @param {number} limit @returns {any[]} */
  auditTrail(limit) {
    let text = '';
    try { text = fs.readFileSync(path.join(this.root, 'audit.ndjson'), 'utf8'); } catch (e) { return []; }
    const lines = text.split('\n').filter(Boolean).slice(-limit);
    /** @type {any[]} */
    const out = [];
    lines.forEach(l => { try { out.push(JSON.parse(l)); } catch (e) { /* torn */ } });
    return out.reverse();
  }

  /** Deletes everything this user has in the Lab. */
  removeAll() {
    fs.rmSync(this.root, { recursive: true, force: true });
    this.cache.clear();
    this.usedBytes = null;
  }
}

class LabStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    /** @type {Map<string, UserStore>} */
    this.users = new Map();
  }

  /**
   * The store of one user (`key` comes from the authenticated principal only).
   * @param {string} key
   */
  forUser(key) {
    if (!/^[a-f0-9]{32,64}$/.test(key)) throw new Error('Invalid user key');
    let u = this.users.get(key);
    if (!u) { u = new UserStore(path.join(this.dir, 'users', key)); this.users.set(key, u); }
    return u;
  }

  /** Every user folder (for restart recovery of evaluation runs). */
  userKeys() {
    try { return fs.readdirSync(path.join(this.dir, 'users')).filter(k => /^[a-f0-9]{32,64}$/.test(k)); } catch (e) { return []; }
  }
}

module.exports = { LabStore, UserStore, newId, isId, KINDS, ID_RE };
