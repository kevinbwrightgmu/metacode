// ── Saved projects ────────────────────────────────────────────────────────────
// The coding app keeps the open project in the browser (localStorage). This
// stores named copies of projects on the MetaCode server so earlier work can
// be listed, reopened, duplicated, exported and deleted (Projects page):
//
//   GET    /api/projects            list (name, dates, counts — no data)
//   POST   /api/projects            save a new project       { name, description?, data }
//   GET    /api/projects/:id        one project, with data
//   PUT    /api/projects/:id        save over it             { name?, description?, data? }
//   POST   /api/projects/:id/duplicate
//   DELETE /api/projects/:id        moved to trash/, not erased
//
// data = { project, posts, codebook, network, networkAnalysis } — never the
// browser's settings. Files live under PROJECT_DATA_DIR (default
// project-data/ next to server.js); writes are atomic (temp file + rename)
// and serialized per project. State-changing requests must come from
// MetaCode's own pages.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 60 * 1024 * 1024;
const DATA_KEYS = ['project', 'posts', 'codebook', 'network', 'networkAnalysis'];

class ApiError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}
function sendError(res, err) {
  if (res.headersSent) return;
  if (err instanceof ApiError) return res.status(err.status).json({ error: { type: err.type, message: err.message } });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: { type: 'too_large', message: 'The project is too large to save on the server (60 MB at most).' } });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: { type: 'invalid_request', message: 'The request body isn\'t valid JSON.' } });
  console.error('[projects] ' + (err && (err.stack || err.message)));
  res.status(500).json({ error: { type: 'internal_error', message: 'Something went wrong while saving or loading the project.' } });
}
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => sendError(res, err));

function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (e) { host = null; }
    if (host !== req.headers.host) return sendError(res, new ApiError(403, 'forbidden_origin', 'Requests from other websites aren\'t allowed.'));
  }
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    return sendError(res, new ApiError(403, 'forbidden_origin', 'Requests from other websites aren\'t allowed.'));
  }
  next();
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ID = /^pr_[A-Za-z0-9]{6,32}$/;
const newId = () => 'pr_' + crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);

// Keeps only the project parts of the app state, with the right shapes.
function cleanData(input) {
  if (!isObj(input)) throw new ApiError(400, 'invalid_request', 'Send the project as { name, data: { posts, codebook, … } }.');
  const d = {};
  d.project = isObj(input.project) ? { name: str(input.project.name, 300) || 'Untitled Project', description: str(input.project.description, 5000) } : { name: 'Untitled Project', description: '' };
  d.posts = Array.isArray(input.posts) ? input.posts.filter(isObj) : [];
  d.codebook = Array.isArray(input.codebook) ? input.codebook.filter(isObj) : [];
  d.network = isObj(input.network) ? { nodes: Array.isArray(input.network.nodes) ? input.network.nodes : [], edges: Array.isArray(input.network.edges) ? input.network.edges : [] } : { nodes: [], edges: [] };
  d.networkAnalysis = isObj(input.networkAnalysis) ? input.networkAnalysis : null;
  return d;
}
function countsOf(d) {
  const posts = d.posts || [];
  const coded = key => posts.filter(p => isObj(p[key]) && Object.keys(p[key]).length).length;
  return {
    posts: posts.length, aiCoded: coded('aiCodes'), humanCoded: coded('humanCodes'),
    dimensions: (d.codebook || []).length, nodes: d.network ? d.network.nodes.length : 0, edges: d.network ? d.network.edges.length : 0
  };
}

class ProjectStore {
  constructor(dir) { this.dir = dir; this.queues = new Map(); }
  file(id) { return path.join(this.dir, 'projects', id + '.json'); }
  serial(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next.catch(() => {}));
    return next;
  }
  async read(id) {
    if (!ID.test(id)) return null;
    try { return JSON.parse(await fsp.readFile(this.file(id), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (e instanceof SyntaxError) throw new ApiError(500, 'corrupt', 'This saved project\'s file is damaged and can\'t be opened.');
      throw e;
    }
  }
  async write(rec) {
    const file = this.file(rec.id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(rec), 'utf8');
    await fsp.rename(tmp, file);
  }
  async list() {
    let names = [];
    try { names = await fsp.readdir(path.join(this.dir, 'projects')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      try { const r = await this.read(id); if (r) out.push(summary(r)); } catch (e) { /* skip damaged */ }
    }
    return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }
  async remove(id) {
    if (!ID.test(id)) return false;
    return this.serial(id, async () => {
      const file = this.file(id);
      if (!fs.existsSync(file)) return false;
      const trash = path.join(this.dir, 'trash');
      await fsp.mkdir(trash, { recursive: true });
      await fsp.rename(file, path.join(trash, id + '-' + Date.now() + '.json'));
      return true;
    });
  }
}
function summary(r) {
  return { id: r.id, name: r.name, description: r.description || '', createdAt: r.createdAt, savedAt: r.savedAt, revision: r.revision || 1, counts: r.counts || countsOf(r.data || {}), bytes: r.bytes || 0 };
}

function createProjects(opts) {
  opts = opts || {};
  const dir = path.resolve(opts.dataDir || process.env.PROJECT_DATA_DIR || path.join(__dirname, '..', 'project-data'));
  const store = new ProjectStore(dir);
  const router = express.Router();
  router.use(sameOriginOnly);
  router.use(express.json({ limit: '61mb' }));

  const build = (prev, body) => {
    const data = body.data !== undefined ? cleanData(body.data) : prev.data;
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > MAX_BYTES) throw new ApiError(413, 'too_large', 'The project is too large to save on the server (60 MB at most).');
    const name = str(body.name, 300) || prev.name || (data.project && data.project.name) || 'Untitled Project';
    const description = body.description !== undefined ? str(body.description, 5000) : (prev.description || '');
    return { name, description, data, counts: countsOf(data), bytes: Buffer.byteLength(json) };
  };

  router.get('/', wrap(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ projects: await store.list() }); }));

  router.post('/', wrap(async (req, res) => {
    const now = new Date().toISOString();
    const rec = Object.assign({ id: newId(), createdAt: now, savedAt: now, revision: 1 }, build({}, req.body || {}));
    await store.serial(rec.id, () => store.write(rec));
    res.status(201).json({ project: summary(rec) });
  }));

  router.get('/:id', wrap(async (req, res) => {
    const rec = await store.read(req.params.id);
    if (!rec) throw new ApiError(404, 'not_found', 'That saved project doesn\'t exist (it may have been deleted).');
    res.set('Cache-Control', 'no-store');
    res.json({ project: Object.assign(summary(rec), { data: rec.data }) });
  }));

  router.put('/:id', wrap(async (req, res) => {
    const out = await store.serial(req.params.id, async () => {
      const rec = await store.read(req.params.id);
      if (!rec) throw new ApiError(404, 'not_found', 'That saved project doesn\'t exist (it may have been deleted).');
      const next = Object.assign({}, rec, build(rec, req.body || {}), { savedAt: new Date().toISOString(), revision: (rec.revision || 1) + 1 });
      await store.write(next);
      return next;
    });
    res.json({ project: summary(out) });
  }));

  router.post('/:id/duplicate', wrap(async (req, res) => {
    const rec = await store.read(req.params.id);
    if (!rec) throw new ApiError(404, 'not_found', 'That saved project doesn\'t exist.');
    const now = new Date().toISOString();
    const copy = Object.assign({}, rec, { id: newId(), name: (rec.name + ' (copy)').slice(0, 300), createdAt: now, savedAt: now, revision: 1 });
    await store.serial(copy.id, () => store.write(copy));
    res.status(201).json({ project: summary(copy) });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    if (!(await store.remove(req.params.id))) throw new ApiError(404, 'not_found', 'That saved project doesn\'t exist.');
    res.json({ ok: true });
  }));

  router.use((err, req, res, next) => sendError(res, err)); // eslint-disable-line no-unused-vars
  return { router, store };
}

module.exports = { createProjects, cleanData };
