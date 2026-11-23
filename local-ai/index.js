// The AI Model Store and local AI on this machine: /api/local-ai (see docs/offline-first.md).
//
// Read by anyone who can use MetaCode:
//   GET  /status            Ollama (running? version), who may manage models here, downloads in progress
//   GET  /hardware          memory, CPU, architecture, GPU, free disk, operating system
//   GET  /runtimes          the runtimes and which work here; the compatibility matrix
//   GET  /catalog           Ollama's library (live, cached or the snapshot), with categories
//   GET  /catalog/model?name=gemma3   one model with all its tags, each with how it fits this device
//   GET  /recommendations   what this device can run, by tier
//   GET  /models            installed models (size, details, loaded or not) and the space they use
//   GET  /installs          downloads; GET /installs/events: their progress as server-sent events
// Managing models needs this machine itself (a request from 127.0.0.1 that no proxy forwarded), or the
// LOCAL_AI_ADMIN_TOKEN from .env (header X-MetaCode-Admin-Token). Visitors of a hosted MetaCode can browse
// the store, never download or delete:
//   POST /installs {model}   POST /installs/pause|resume|cancel {model}
//   POST /models/load|unload|delete|update {model}   PUT /models/settings {model, settings}
//   POST /runtimes/scan      look for OpenAI-compatible servers on this machine
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createOllama } = require('./ollama');
const { createCatalog } = require('./catalog');
const { createHardware } = require('./hardware');
const { createInstalls, normalize } = require('./installs');
const { createRuntimes, MATRIX } = require('./runtimes');
const { recommend, fit } = require('./recommend');
const { defaultDataDir } = require('../lib/data-dir');

const SETTING_LIMITS = { temperature: [0, 2], maxTokens: [16, 32768], keepAliveMinutes: [0, 1440] };

function createLocalAi(opts) {
  const env = opts.env || process.env;
  const dataDir = path.resolve(String(env.LOCAL_AI_DATA_DIR || '').trim() || defaultDataDir('local-ai-data', env));
  const isLocal = opts.isLoopback || (() => false);
  const onModelsChanged = opts.onModelsChanged || (() => {});
  const ollama = createOllama({ env, fetch: opts.fetch });
  // (LOCAL_AI_LIBRARY_URL / LOCAL_AI_REGISTRY_URL: a mirror of ollama.com's library and of Ollama's registry)
  const catalog = createCatalog({ dataDir, fetch: opts.fetch, libraryUrl: opts.libraryUrl || String(env.LOCAL_AI_LIBRARY_URL || '').trim() || undefined,
    registry: opts.registry || String(env.LOCAL_AI_REGISTRY_URL || '').trim() || undefined, minModels: opts.minLibraryModels });
  const hardware = opts.hardware || createHardware({ env, dataDir });
  const runtimes = createRuntimes({ ollama, fetch: opts.fetch });
  const installs = createInstalls({ ollama, catalog, hardware, onInstalled: model => onModelsChanged('installed', model) });
  const settingsFile = path.join(dataDir, 'settings.json');
  let settings = null;

  function loadSettings() {
    if (settings) return settings;
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { settings = {}; }
    if (!settings.models || typeof settings.models !== 'object') settings.models = {};
    return settings;
  }
  function saveSettings() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = settingsFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settingsFile);
  }
  // A model's settings, as MetaCode uses them for its requests (server.js): { temperature?, maxTokens?, keepAliveMinutes? }
  function modelSettings(model) {
    const name = normalize(String(model || '').replace(/^ollama\//, ''));      // MetaCode's ids are "ollama/<model>"
    return (name && loadSettings().models[name]) || null;
  }

  function manageCheck(req) {
    const token = String(env.LOCAL_AI_ADMIN_TOKEN || '').trim();
    const given = String(req.get('x-metacode-admin-token') || '');
    if (token.length >= 12 && given) {
      const a = crypto.createHash('sha256').update(token).digest();
      const b = crypto.createHash('sha256').update(given).digest();
      if (crypto.timingSafeEqual(a, b)) return { allowed: true, how: 'token' };
    }
    if (isLocal(req)) return { allowed: true, how: 'this-machine' };
    return {
      allowed: false, how: null, tokenSet: token.length >= 12,
      reason: token.length >= 12 ? 'Enter this server\'s admin token (LOCAL_AI_ADMIN_TOKEN) to install or remove models.'
        : 'Installing and removing models works on the computer MetaCode runs on. To manage them from another device, set LOCAL_AI_ADMIN_TOKEN (at least 12 characters) in the server\'s .env and click Reload .env.',
    };
  }
  const manage = (req, res, next) => {
    const m = manageCheck(req);
    if (m.allowed) return next();
    res.status(403).json({ error: { type: 'forbidden', code: 'manage_locked', message: m.reason } });
  };
  const fail = (res, status, code, message) => res.status(status).json({ error: { type: status >= 500 ? 'service_unavailable' : 'invalid_request', code, message } });
  const ollamaFail = (res, e) => fail(res, e.status === 404 ? 404 : e.status === 503 ? 503 : 502, e.code || 'ollama_error', e.message);
  const modelOf = req => normalize(req.body && req.body.model);

  async function installed() {
    const [list, running] = await Promise.all([ollama.tags(), ollama.ps().catch(() => [])]);
    const s = loadSettings();
    const models = list.map(m => {
      const r = running.find(x => x.name === m.name);
      const d = m.details || {};
      return {
        name: m.name, size: m.size, digest: m.digest, modifiedAt: m.modified_at,
        family: d.family || null, parameterSize: d.parameter_size || null, quantization: d.quantization_level || null,
        contextLength: d.context_length || null, capabilities: Array.isArray(m.capabilities) ? m.capabilities : null,
        loaded: r ? { size: r.size, sizeVram: r.size_vram || 0, expiresAt: r.expires_at || null, contextLength: r.context_length || null } : null,
        settings: s.models[m.name] || null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { models, totalSize: models.reduce((n, m) => n + (m.size || 0), 0) };
  }

  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/status', async (req, res) => {
    let version = null;
    try { version = await ollama.version(); } catch (e) { version = null; }
    res.json({
      ollama: { running: !!version, version, address: ollama.base() },
      manage: manageCheck(req),
      mode: String(env.AI_MODE || 'cloud').toLowerCase(),
      installs: installs.list(),
    });
  });
  router.get('/hardware', async (req, res) => res.json(await hardware.detect(req.query.refresh === '1')));
  router.get('/runtimes', async (req, res) => res.json(Object.assign(await runtimes.list(await hardware.detect()), { matrix: MATRIX })));
  router.post('/runtimes/scan', manage, async (req, res) => {
    await runtimes.scan();
    res.json(Object.assign(await runtimes.list(await hardware.detect()), { matrix: MATRIX }));
  });

  router.get('/catalog', async (req, res) => {
    const r = await catalog.refresh(req.query.refresh === '1');
    res.json(Object.assign(catalog.list(), { problem: r.ok ? null : r.problem }));
  });
  router.get('/catalog/model', async (req, res) => {
    const name = String(req.query.name || '').trim().toLowerCase();
    const model = catalog.find(name);
    if (!model) return fail(res, 404, 'not_found', 'The catalog has no model called "' + name.slice(0, 80) + '".');
    const t = await catalog.tagsOf(name, req.query.refresh === '1');
    const hw = await hardware.detect();
    const tags = t.tags.map(x => Object.assign({}, x, { fit: fit(x.tag, x.size, hw), main: catalog.mainTags(model, t.tags).includes(x) }));
    res.json(Object.assign({}, model, { tags, tagsFetchedAt: t.fetchedAt, tagsOffline: !!t.offline || !!t.stale }));
  });
  router.get('/recommendations', async (req, res) => {
    await catalog.refresh(false);
    const hw = await hardware.detect();
    res.json(Object.assign(recommend(catalog.list().models, hw), { catalog: { source: catalog.list().source, fetchedAt: catalog.list().fetchedAt } }));
  });

  router.get('/models', async (req, res) => {
    try { res.json(await installed()); } catch (e) { ollamaFail(res, e); }
  });
  router.post('/models/load', manage, async (req, res) => {
    const model = modelOf(req);
    if (!model) return fail(res, 400, 'invalid_model', 'Name a model.');
    const s = loadSettings().models[model] || {};
    const minutes = Number.isFinite(s.keepAliveMinutes) ? s.keepAliveMinutes : 10;
    try { await ollama.load(model, minutes ? minutes + 'm' : -1); res.json(await installed()); } catch (e) { ollamaFail(res, e); }
  });
  router.post('/models/unload', manage, async (req, res) => {
    const model = modelOf(req);
    if (!model) return fail(res, 400, 'invalid_model', 'Name a model.');
    try { await ollama.unload(model); res.json(await installed()); } catch (e) { ollamaFail(res, e); }
  });
  router.post('/models/delete', manage, async (req, res) => {
    const model = modelOf(req);
    if (!model) return fail(res, 400, 'invalid_model', 'Name a model.');
    if (installs.busy(model)) return fail(res, 409, 'busy', model + ' is downloading: cancel the download first.');
    try {
      await ollama.remove(model);
      const s = loadSettings();
      if (s.models[model]) { delete s.models[model]; saveSettings(); }
      onModelsChanged('deleted', model);
      res.json(await installed());
    } catch (e) { ollamaFail(res, e); }
  });
  // Pulling an installed model again downloads only what changed in Ollama's library
  router.post('/models/update', manage, (req, res) => {
    const r = installs.start(req.body && req.body.model, { update: true });
    if (r.error) return fail(res, r.status, r.code, r.error);
    res.status(202).json(r);
  });
  router.put('/models/settings', manage, (req, res) => {
    const model = modelOf(req);
    if (!model) return fail(res, 400, 'invalid_model', 'Name a model.');
    const given = (req.body && req.body.settings) || {};
    const clean = {};
    for (const [k, [lo, hi]] of Object.entries(SETTING_LIMITS)) {
      if (given[k] === undefined || given[k] === null || given[k] === '') continue;
      const n = Number(given[k]);
      if (!Number.isFinite(n) || n < lo || n > hi) return fail(res, 400, 'invalid_setting', k + ' must be between ' + lo + ' and ' + hi + '.');
      clean[k] = k === 'temperature' ? Math.round(n * 100) / 100 : Math.round(n);
    }
    const s = loadSettings();
    if (Object.keys(clean).length) s.models[model] = clean; else delete s.models[model];
    try { saveSettings(); } catch (e) { return fail(res, 500, 'not_saved', 'The settings couldn\'t be saved (' + e.code + ').'); }
    res.json({ model, settings: s.models[model] || null });
  });

  router.get('/installs', (req, res) => res.json({ installs: installs.list() }));
  router.get('/installs/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
    send('snapshot', { installs: installs.list() });
    const onJob = job => send('job', job);
    installs.events.on('job', onJob);
    const beat = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(beat); installs.events.off('job', onJob); });
  });
  router.post('/installs', manage, (req, res) => {
    const r = installs.start(req.body && req.body.model);
    if (r.error) return fail(res, r.status, r.code, r.error);
    res.status(r.already ? 200 : 202).json(r);
  });
  for (const action of ['pause', 'resume', 'cancel']) {
    router.post('/installs/' + action, manage, (req, res) => {
      const r = installs[action](req.body && req.body.model);
      if (r.error) return fail(res, r.status, r.code, r.error);
      res.json(r);
    });
  }

  return { router, modelSettings, installs, catalog, hardware, ollama, close: () => installs.close() };
}

module.exports = { createLocalAi };
