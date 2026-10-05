// ── Saved projects from older versions ───────────────────────────────────────
// Saved projects now live in each person's browser (public/js/projects.js,
// public/js/local-db.js), so people who share a MetaCode server never see
// each other's work. Older versions stored them here, on the server, shared by
// everyone. These routes only let the person running MetaCode on this
// computer copy those old projects into their browser:
//
//   GET /api/projects/legacy        list (name, dates, counts — no data)
//   GET /api/projects/legacy/:id    one project, with data
//
// Requests from other computers (or through a proxy) get 404. Files are read
// from PROJECT_DATA_DIR (default project-data/ next to server.js) and never
// changed.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { isLoopback } = require('../owner');

const DATA_KEYS = ['project', 'posts', 'codebook', 'network', 'networkAnalysis'];

class ApiError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}
function sendError(res, err) {
  if (res.headersSent) return;
  if (err instanceof ApiError) return res.status(err.status).json({ error: { type: err.type, message: err.message } });
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
  constructor(dir) { this.dir = dir; }
  file(id) { return path.join(this.dir, 'projects', id + '.json'); }
  async read(id) {
    if (!ID.test(id)) return null;
    try { return JSON.parse(await fsp.readFile(this.file(id), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (e instanceof SyntaxError) throw new ApiError(500, 'corrupt', 'This saved project\'s file is damaged and can\'t be opened.');
      throw e;
    }
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

  const localOnly = (req, res, next) => (isLoopback(req) ? next() : sendError(res, new ApiError(404, 'not_found', 'Not found.')));

  router.get('/legacy', localOnly, wrap(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ projects: await store.list() }); }));

  router.get('/legacy/:id', localOnly, wrap(async (req, res) => {
    const rec = await store.read(req.params.id);
    if (!rec) throw new ApiError(404, 'not_found', 'That saved project doesn\'t exist.');
    res.set('Cache-Control', 'no-store');
    res.json({ project: Object.assign(summary(rec), { data: rec.data }) });
  }));

  router.use((err, req, res, next) => sendError(res, err)); // eslint-disable-line no-unused-vars
  return { router, store };
}

module.exports = { createProjects, cleanData };
