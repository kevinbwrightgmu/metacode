// @ts-check
// ── Shared projects: storage ──────────────────────────────────────────────────
// JSON files under COLLAB_DATA_DIR (default: collab-data/ next to server.js):
//
//   projects/<id>.json   { id, name, createdAt, updatedAt, revision, owner,
//                          members: [{ id, email, role, addedAt, addedBy }],
//                          invites: [{ id, email, role, tokenHash, createdAt,
//                                      expiresAt, invitedBy, status, … }],
//                          data: { project, posts, codebook, network, networkAnalysis },
//                          revs: { '<entity key>': revision it last changed at } }
//   chat/<id>.json       { seq, messages: [{ seq, id, at, from, text, clientId }] }
//   by-user/<userId>.json  [project ids] (an index, rebuilt from projects/ if lost)
//
// A project's data is split into entities so two people can work on the same
// project at once: 'meta' (name, description), 'post:<id>' (one post with its
// codes), 'codebook', 'network', 'networkAnalysis'. Each change says which
// revision of the entity it was made from; a change to an entity someone
// else changed since is a conflict and is not applied (see applyChanges).
// Writes go to a temporary file and are renamed into place; writes to one
// project are serialized.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const CHAT_KEEP = 5000;           // newest messages kept per project
const CACHE_MAX = 200;            // projects kept in memory (the least recently used are read again from disk)
const ENTITY_KEYS = ['meta', 'codebook', 'network', 'networkAnalysis'];
const POST_KEY = /^post:[^\x00-\x1f\x7f]{1,200}$/;     // any post id of 1–200 characters without control characters

/** @param {string} prefix */
const randomId = prefix => prefix + crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
const isObj = /** @param {any} v */ v => v && typeof v === 'object' && !Array.isArray(v);
const str = /** @param {any} v @param {number} max */ (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Posts that can be shared one by one: an id that makes a valid key, the first of any repeats @param {any} list */
function uniquePosts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!isObj(p) || (typeof p.id !== 'string' && typeof p.id !== 'number')) continue;
    const id = String(p.id);
    if (seen.has(id) || !POST_KEY.test('post:' + id)) continue;
    seen.add(id);
    out.push(Object.assign({}, p, { id }));
  }
  return out;
}

/** The project's data in canonical form @param {any} input */
function cleanData(input) {
  const d = isObj(input) ? input : {};
  return {
    project: { name: str(d.project && d.project.name, 300) || 'Untitled Project', description: str(d.project && d.project.description, 5000) },
    posts: uniquePosts(d.posts),
    codebook: Array.isArray(d.codebook) ? d.codebook.filter(isObj) : [],
    network: isObj(d.network) ? { nodes: Array.isArray(d.network.nodes) ? d.network.nodes : [], edges: Array.isArray(d.network.edges) ? d.network.edges : [] } : { nodes: [], edges: [] },
    networkAnalysis: isObj(d.networkAnalysis) ? d.networkAnalysis : null
  };
}

/** Entity key → value in a project's data @param {any} data @param {string} key */
function entityOf(data, key) {
  if (key === 'meta') return data.project;
  if (key.startsWith('post:')) { const id = key.slice(5); return data.posts.find(/** @param {any} p */ p => p.id === id) || null; }
  return data[key] === undefined ? null : data[key];
}

/** Is this an entity key a change may name? @param {any} key */
const validKey = key => typeof key === 'string' && (ENTITY_KEYS.includes(key) || POST_KEY.test(key));

/** Checks one entity's new value (null removes a post) @param {string} key @param {any} value */
function checkValue(key, value) {
  if (key === 'meta') return isObj(value) ? { name: str(value.name, 300) || 'Untitled Project', description: str(value.description, 5000) } : undefined;
  if (key.startsWith('post:')) {
    if (value === null) return null;
    if (!isObj(value) || String(value.id) !== key.slice(5)) return undefined;
    return Object.assign({}, value, { id: String(value.id) });
  }
  if (key === 'codebook') return Array.isArray(value) ? value.filter(isObj) : undefined;
  if (key === 'network') return isObj(value) && Array.isArray(value.nodes) && Array.isArray(value.edges) ? { nodes: value.nodes, edges: value.edges } : undefined;
  if (key === 'networkAnalysis') return value === null || isObj(value) ? value : undefined;
  return undefined;
}

class CollabStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    /** @type {Map<string, Promise<any>>} */
    this.queues = new Map();
    /** @type {Map<string, any>} */
    this.cache = new Map();
  }

  /** @param {...string} parts */
  file(...parts) { return path.join(this.dir, ...parts); }
  /** @param {any} id */
  validId(id) { return typeof id === 'string' && /^cp_[A-Za-z0-9]{8,32}$/.test(id); }

  /** Serializes async work per key @template T @param {string} key @param {() => Promise<T>} fn @returns {Promise<T>} */
  serial(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next.catch(() => {}));
    return next;
  }

  /** @param {string} file @param {any} fallback */
  async readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) {
      const err = /** @type {any} */ (e);
      if (err.code === 'ENOENT') return fallback;
      if (err instanceof SyntaxError) {
        const bad = file + '.corrupt-' + Date.now();
        try { await fsp.copyFile(file, bad); } catch (e2) { /* ignore */ }
        console.warn('[collab] ' + path.basename(file) + ' is not valid JSON; a copy was saved as ' + path.basename(bad));
        return fallback;
      }
      throw e;
    }
  }
  /** @param {string} file @param {any} data */
  async writeJson(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
  }

  /** @param {string} id @returns {Promise<any | null>} */
  async get(id) {
    if (!this.validId(id)) return null;
    const hit = this.cache.get(id);
    if (hit) { this.cache.delete(id); this.cache.set(id, hit); return hit; }
    const p = await this.readJson(this.file('projects', id + '.json'), null);
    if (p) this.remember(p);
    return p;
  }
  /** @param {any} p */
  remember(p) {
    this.cache.delete(p.id);
    this.cache.set(p.id, p);
    while (this.cache.size > CACHE_MAX) { const oldest = this.cache.keys().next().value; if (oldest === undefined) break; this.cache.delete(oldest); }
  }
  /** @param {any} p */
  async put(p) {
    p.updatedAt = new Date().toISOString();
    await this.writeJson(this.file('projects', p.id + '.json'), p);
    this.remember(p);
  }

  /** Runs fn(project) under the project's lock and saves what it returns true for @param {string} id @param {(p: any) => any} fn */
  update(id, fn) {
    return this.serial('p:' + id, async () => {
      const p = await this.get(id);
      if (!p) return { notFound: true };
      let out;
      try {
        out = await fn(p);
        if (out && out.save) await this.put(p);
      } catch (e) { this.cache.delete(id); throw e; }      // the file on disk stays the truth
      return out;
    });
  }

  /** @param {{ id: string, email: string | null }} owner @param {any} data @param {string} name */
  async create(owner, data, name) {
    const now = new Date().toISOString();
    const clean = cleanData(data);
    if (name) clean.project.name = str(name, 300) || clean.project.name;
    /** @type {Record<string, number>} */
    const revs = { meta: 1, codebook: 1, network: 1, networkAnalysis: 1 };
    clean.posts.forEach(/** @param {any} p */ p => { revs['post:' + p.id] = 1; });
    const p = { id: randomId('cp_'), name: clean.project.name, createdAt: now, updatedAt: now, revision: 1,
      owner: { id: owner.id, email: owner.email },
      members: [{ id: owner.id, email: owner.email, role: 'owner', addedAt: now, addedBy: owner.id }],
      invites: [], data: clean, revs };
    await this.put(p);
    await this.indexAdd(owner.id, p.id);
    return p;
  }

  async delete(/** @type {string} */ id) {
    return this.serial('p:' + id, async () => {
      const p = await this.get(id);
      if (!p) return false;
      for (const m of p.members) await this.indexRemove(m.id, id);
      for (const inv of p.invites) if (inv.tokenHash) await this.inviteRefRemove(inv.tokenHash);
      for (const f of [this.file('projects', id + '.json'), this.file('chat', id + '.json')]) { try { await fsp.unlink(f); } catch (e) { /* gone */ } }
      this.cache.delete(id);
      return true;
    });
  }

  /* ── Which projects each account belongs to ── */
  /** @param {string} userId */
  userFile(userId) { return this.file('by-user', crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 40) + '.json'); }
  /** @param {string} userId @returns {Promise<string[]>} */
  async projectsOf(userId) { const l = await this.readJson(this.userFile(userId), []); return Array.isArray(l) ? l.filter(id => this.validId(id)) : []; }
  /** @param {string} userId @param {string} id */
  indexAdd(userId, id) { return this.serial('u:' + userId, async () => { const l = await this.projectsOf(userId); if (!l.includes(id)) { l.push(id); await this.writeJson(this.userFile(userId), l); } }); }
  /** @param {string} userId @param {string} id */
  indexRemove(userId, id) { return this.serial('u:' + userId, async () => { const l = await this.projectsOf(userId); const n = l.filter(x => x !== id); if (n.length !== l.length) await this.writeJson(this.userFile(userId), n); }); }

  /* ── Invitation links: token hash → project ── */
  /** @param {string} hash */
  inviteFile(hash) { return this.file('invites', hash.slice(0, 64) + '.json'); }
  /** @param {string} hash @returns {Promise<{ projectId: string, inviteId: string } | null>} */
  async inviteRef(hash) { return /^[a-f0-9]{64}$/.test(hash) ? this.readJson(this.inviteFile(hash), null) : null; }
  /** @param {string} hash @param {string} projectId @param {string} inviteId */
  inviteRefPut(hash, projectId, inviteId) { return this.writeJson(this.inviteFile(hash), { projectId, inviteId }); }
  /** @param {string} hash */
  async inviteRefRemove(hash) { try { await fsp.unlink(this.inviteFile(hash)); } catch (e) { /* gone */ } }

  /* ── Chat ────────────────────────────────── */
  /** @param {string} id */
  async chat(id) { const c = await this.readJson(this.file('chat', id + '.json'), null); return c && Array.isArray(c.messages) ? c : { seq: 0, messages: [] }; }
  /**
   * Adds a message (idempotent per sender and clientId) → { message, duplicate }
   * @param {string} id @param {{ id: string, email: string | null }} from @param {string} text @param {string | null} clientId
   */
  addMessage(id, from, text, clientId) {
    return this.serial('c:' + id, async () => {
      const c = await this.chat(id);
      if (clientId) {
        const same = c.messages.slice(-500).find(/** @param {any} m */ m => m.clientId === clientId && m.from.id === from.id);
        if (same) return { message: same, duplicate: true };
      }
      const message = { seq: c.seq + 1, id: 'm' + (c.seq + 1), at: new Date().toISOString(), from: { id: from.id, email: from.email }, text, clientId: clientId || null };
      c.seq = message.seq;
      c.messages.push(message);
      if (c.messages.length > CHAT_KEEP) c.messages = c.messages.slice(-CHAT_KEEP);
      await this.writeJson(this.file('chat', id + '.json'), c);
      return { message, duplicate: false };
    });
  }
}

/**
 * Applies entity changes made from known revisions. A change whose entity
 * changed since its base revision is a conflict and is left out (nothing is
 * overwritten); the rest are applied together under one new revision.
 * @param {any} p the project (changed in place)
 * @param {{ key: string, baseRev: number, value: any }[]} changes
 * @returns {{ applied: string[], conflicts: { key: string, rev: number, value: any }[], invalid: string[] }}
 */
function applyChanges(p, changes) {
  const applied = [], conflicts = [], invalid = [];
  const next = p.revision + 1;
  /** @type {{ key: string, value: any }[]} */
  const ok = [];
  for (const c of changes) {
    if (!validKey(c.key)) { invalid.push(String(c.key).slice(0, 80)); continue; }
    const value = checkValue(c.key, c.value);
    if (value === undefined) { invalid.push(c.key); continue; }
    const current = p.revs[c.key] || 0;
    if (Number(c.baseRev) !== current) { conflicts.push({ key: c.key, rev: current, value: entityOf(p.data, c.key) }); continue; }
    ok.push({ key: c.key, value });
  }
  for (const { key, value } of ok) {
    if (key === 'meta') { p.data.project = value; p.name = value.name; }
    else if (key.startsWith('post:')) {
      const id = key.slice(5);
      const i = p.data.posts.findIndex(/** @param {any} x */ x => x.id === id);
      if (value === null) { if (i !== -1) p.data.posts.splice(i, 1); }
      else if (i === -1) p.data.posts.push(value);
      else p.data.posts[i] = value;
    } else p.data[key] = value;
    p.revs[key] = next;
    applied.push(key);
  }
  if (applied.length) p.revision = next;
  return { applied, conflicts, invalid };
}

/** Entities changed after a revision (deleted posts come back as null) @param {any} p @param {number} since */
function changesSince(p, since) {
  return Object.keys(p.revs).filter(k => p.revs[k] > since).map(k => ({ key: k, rev: p.revs[k], value: entityOf(p.data, k) }));
}

module.exports = { CollabStore, applyChanges, changesSince, cleanData, entityOf, validKey, randomId };
