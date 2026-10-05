// ── Survey Studio storage ─────────────────────────────────────────────────────
// JSON files under SURVEY_DATA_DIR (default: survey-data/ next to server.js):
//
//   surveys/<id>.json           { id, owner, revision, createdAt, updatedAt, doc, publish }
//                               (owner: a hash of the browser that made it — see owner.js;
//                               records from older versions have none)
//   versions/<id>/<n>.json      { version, publishedAt, doc }   (immutable)
//   responses/<id>.json         { responses: [...] }
//   libraries/<owner>.json      { components, styles, templates }
//
// Writes go to a temporary file first and are renamed into place, and writes
// to the same file are serialized, so a crash never leaves half a file.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function randomId(prefix, bytes) {
  return prefix + crypto.randomBytes(bytes || 9).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
}

class SurveyStore {
  constructor(dir) {
    this.dir = dir;
    this.queues = new Map();     // file → promise chain
    this.index = null;           // id → summary
    this.publicIndex = new Map(); // publicId → survey id
  }

  file(...parts) { return path.join(this.dir, ...parts); }

  async ensureDirs() {
    for (const d of ['surveys', 'versions', 'responses']) await fsp.mkdir(this.file(d), { recursive: true });
  }

  // Serializes async work per key (one writer per file).
  serial(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next.catch(() => {}));
    return next;
  }

  async readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      if (e instanceof SyntaxError) {
        // Keep the damaged file for recovery instead of overwriting it.
        const bad = file + '.corrupt-' + Date.now();
        try { await fsp.copyFile(file, bad); } catch (e2) { /* ignore */ }
        console.warn('[surveys] ' + path.basename(file) + ' is not valid JSON; a copy was saved as ' + path.basename(bad));
        return fallback;
      }
      throw e;
    }
  }

  async writeJson(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsp.rename(tmp, file);
  }

  validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id); }

  async loadIndex() {
    if (this.index) return this.index;
    await this.ensureDirs();
    const index = new Map();
    const files = await fsp.readdir(this.file('surveys'));
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const rec = await this.readJson(this.file('surveys', f), null);
      if (!rec || !rec.id || !rec.doc) continue;
      const responses = await this.readJson(this.file('responses', rec.id + '.json'), { responses: [] });
      index.set(rec.id, this.summarize(rec, responses.responses || []));
      if (rec.publish && rec.publish.publicId) this.publicIndex.set(rec.publish.publicId, rec.id);
    }
    this.index = index;
    return index;
  }

  summarize(rec, responses) {
    const doc = rec.doc || {};
    const qCount = Object.values(doc.elements || {}).filter(e => e && ['single', 'multiple', 'dropdown', 'shorttext', 'longtext', 'number', 'slider', 'rating', 'ranking', 'date', 'time', 'matrix', 'yesno', 'likert'].includes(e.type)).length;
    return {
      id: rec.id, owner: rec.owner || null, title: doc.title || 'Untitled survey', description: doc.description || '',
      createdAt: rec.createdAt, updatedAt: rec.updatedAt, revision: rec.revision,
      pages: (doc.pages || []).length, questions: qCount,
      publish: rec.publish || null,
      responses: responses.length, completed: responses.filter(r => r.status === 'complete').length,
      lastResponseAt: responses.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), null)
    };
  }

  // owner: only that browser's surveys; null: those from older versions (no owner)
  async list(owner) {
    const index = await this.loadIndex();
    return Array.from(index.values()).filter(sum => (sum.owner || null) === (owner || null)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async get(id) {
    if (!this.validId(id)) return null;
    await this.loadIndex();
    return this.readJson(this.file('surveys', id + '.json'), null);
  }

  async create(doc, owner) {
    await this.loadIndex();
    const now = new Date().toISOString();
    const rec = { id: doc.id, owner: owner || null, revision: 1, createdAt: now, updatedAt: now, doc, publish: null };
    await this.serial('s:' + rec.id, () => this.writeJson(this.file('surveys', rec.id + '.json'), rec));
    this.index.set(rec.id, this.summarize(rec, []));
    return rec;
  }

  // Saves a new draft. baseRevision must match unless force is set.
  async save(id, doc, baseRevision, force) {
    return this.serial('s:' + id, async () => {
      const rec = await this.readJson(this.file('surveys', id + '.json'), null);
      if (!rec) return { notFound: true };
      if (!force && baseRevision !== undefined && baseRevision !== null && Number(baseRevision) !== rec.revision) return { conflict: true, revision: rec.revision, updatedAt: rec.updatedAt };
      rec.doc = doc;
      rec.revision += 1;
      rec.updatedAt = new Date().toISOString();
      await this.writeJson(this.file('surveys', id + '.json'), rec);
      const old = this.index.get(id);
      this.index.set(id, Object.assign(this.summarize(rec, []), old ? { responses: old.responses, completed: old.completed, lastResponseAt: old.lastResponseAt } : {}));
      return { record: rec };
    });
  }

  async remove(id) {
    await this.loadIndex();
    return this.serial('s:' + id, async () => {
      const rec = await this.readJson(this.file('surveys', id + '.json'), null);
      if (!rec) return false;
      // Deleted surveys are moved to a trash folder rather than destroyed.
      const trash = this.file('trash', id + '-' + Date.now());
      await fsp.mkdir(trash, { recursive: true });
      const move = async (from, to) => { try { await fsp.rename(from, to); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
      await move(this.file('surveys', id + '.json'), path.join(trash, 'survey.json'));
      await move(this.file('responses', id + '.json'), path.join(trash, 'responses.json'));
      await move(this.file('versions', id), path.join(trash, 'versions'));
      this.index.delete(id);
      if (rec.publish && rec.publish.publicId) this.publicIndex.delete(rec.publish.publicId);
      return true;
    });
  }

  async publish(id, doc) {
    return this.serial('s:' + id, async () => {
      const rec = await this.readJson(this.file('surveys', id + '.json'), null);
      if (!rec) return null;
      const now = new Date().toISOString();
      const version = (rec.publish && rec.publish.version ? rec.publish.version : 0) + 1;
      await this.writeJson(this.file('versions', id, version + '.json'), { version, publishedAt: now, doc });
      const publicId = rec.publish && rec.publish.publicId ? rec.publish.publicId : randomId('s', 12);
      rec.publish = { publicId, version, publishedAt: now, publishedRevision: rec.revision, open: true, firstPublishedAt: (rec.publish && rec.publish.firstPublishedAt) || now };
      await this.writeJson(this.file('surveys', id + '.json'), rec);
      this.publicIndex.set(publicId, id);
      const sum = this.index.get(id);
      if (sum) sum.publish = rec.publish;
      return rec.publish;
    });
  }

  async setPublishState(id, patch) {
    return this.serial('s:' + id, async () => {
      const rec = await this.readJson(this.file('surveys', id + '.json'), null);
      if (!rec || !rec.publish) return null;
      if (patch.unpublish) {
        this.publicIndex.delete(rec.publish.publicId);
        rec.publish = Object.assign({}, rec.publish, { open: false, unpublished: true });
      } else {
        rec.publish.open = !!patch.open;
        if (rec.publish.unpublished) { delete rec.publish.unpublished; this.publicIndex.set(rec.publish.publicId, id); }
      }
      await this.writeJson(this.file('surveys', id + '.json'), rec);
      const sum = this.index.get(id);
      if (sum) sum.publish = rec.publish;
      return rec.publish;
    });
  }

  async versions(id) {
    try {
      const files = await fsp.readdir(this.file('versions', id));
      const out = [];
      for (const f of files) {
        if (!/^\d+\.json$/.test(f)) continue;
        const v = await this.readJson(this.file('versions', id, f), null);
        if (v) out.push({ version: v.version, publishedAt: v.publishedAt, title: v.doc && v.doc.title });
      }
      return out.sort((a, b) => b.version - a.version);
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }

  async version(id, n) {
    if (!this.validId(id) || !/^\d{1,6}$/.test(String(n))) return null;
    return this.readJson(this.file('versions', id, Number(n) + '.json'), null);
  }

  async byPublicId(publicId) {
    await this.loadIndex();
    if (typeof publicId !== 'string' || !/^[A-Za-z0-9]{4,40}$/.test(publicId)) return null;
    const id = this.publicIndex.get(publicId);
    if (!id) return null;
    const rec = await this.get(id);
    if (!rec || !rec.publish || rec.publish.publicId !== publicId || rec.publish.unpublished) return null;
    return rec;
  }

  async responses(id) {
    const data = await this.readJson(this.file('responses', id + '.json'), { responses: [] });
    return Array.isArray(data.responses) ? data.responses : [];
  }

  // fn(list) mutates/returns the list; runs serialized per survey.
  async updateResponses(id, fn) {
    return this.serial('r:' + id, async () => {
      const list = await this.responses(id);
      const result = await fn(list);
      await this.writeJson(this.file('responses', id + '.json'), { responses: list });
      const sum = this.index && this.index.get(id);
      if (sum) {
        sum.responses = list.length;
        sum.completed = list.filter(r => r.status === 'complete').length;
        sum.lastResponseAt = list.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), null);
      }
      return result;
    });
  }

  // Gives a survey from an older version (no owner) to a browser.
  async claim(id, owner) {
    return this.serial('s:' + id, async () => {
      const rec = await this.readJson(this.file('surveys', id + '.json'), null);
      if (!rec || rec.owner) return null;
      rec.owner = owner;
      await this.writeJson(this.file('surveys', id + '.json'), rec);
      const sum = this.index && this.index.get(id);
      if (sum) sum.owner = owner;
      return rec;
    });
  }

  // The single shared library older versions kept (library.json)
  async legacyLibrary() {
    const lib = await this.readJson(this.file('library.json'), null);
    return lib ? Object.assign({ components: [], styles: [], templates: [] }, lib) : null;
  }

  async library(owner) {
    const lib = await this.readJson(this.file('libraries', owner + '.json'), null);
    return Object.assign({ components: [], styles: [], templates: [] }, lib || {});
  }

  async saveLibrary(owner, lib) {
    return this.serial('library:' + owner, () => this.writeJson(this.file('libraries', owner + '.json'), lib));
  }
}

module.exports = { SurveyStore, randomId };
