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
// (A request from this machine under a name that is neither this machine's own nor PUBLIC_URL's is refused,
// reads too: see the router's first handler.)
// Managing models needs this machine itself (a request from 127.0.0.1 that no proxy forwarded, to this
// machine's own name: localhost, 127.x.x.x or [::1]), or the LOCAL_AI_ADMIN_TOKEN from .env (header
// X-MetaCode-Admin-Token). Visitors of a hosted MetaCode can browse the store, never download or delete:
//   POST /installs {model}   POST /installs/pause|resume|cancel {model}
//   POST /models/load|unload|delete|update {model}   PUT /models/settings {model, settings}
//   POST /runtimes/scan      look for OpenAI-compatible servers on this machine
// Downloads take a name from Ollama's library; loading, unloading, deleting and settings take any model Ollama
// lists (also one from another registry, such as hf.co/<user>/<repo>:<quantization>), whatever the case.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createOllama } = require('./ollama');
const { createCatalog } = require('./catalog');
const { createHardware } = require('./hardware');
const { createInstalls, keyOf } = require('./installs');
const { createRuntimes, MATRIX } = require('./runtimes');
const { recommend, fit } = require('./recommend');
const { defaultDataDir } = require('../lib/data-dir');

const SETTING_LIMITS = { temperature: [0, 2], maxTokens: [16, 32768], keepAliveMinutes: [0, 1440] };

// The name the browser used for this server is this machine's own. (Another website whose name is made to point
// at 127.0.0.1, "DNS rebinding", reaches this server from this machine too, but under its own name; the raw Host
// header is read, as a page can't change it, unlike X-Forwarded-Host.)
const hostOf = req => String((req.headers && req.headers.host) || '').trim().toLowerCase().replace(/:\d+$/, '');
function loopbackHost(req) {
  const host = hostOf(req);
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
// The name of the site in PUBLIC_URL (comma-separated, e.g. https://metac0.de)
function publicHost(req, env) {
  const host = hostOf(req);
  return !!host && String(env.PUBLIC_URL || '').split(',').some(u => {
    try { return new URL(u.trim()).hostname.toLowerCase() === host; } catch (e) { return false; }
  });
}
// A name Ollama may list a model under: a host, a namespace, the model and its tag
const LISTED_NAME = /^[a-z0-9_][a-z0-9._:/-]{0,400}$/i;

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
  // (OLLAMA_PULL_IDLE_SECONDS, as for the AI service's own downloads: a download that makes no progress for this
  // long is stopped, and counts as interrupted; default 120)
  const idle = Number(String(env.OLLAMA_PULL_IDLE_SECONDS || '').trim());
  const installs = createInstalls({ ollama, catalog, hardware, idleMs: Number.isFinite(idle) && idle >= 1 && idle <= 3600 ? idle * 1000 : undefined,
    onInstalled: model => onModelsChanged('installed', model) });
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
  // A model's settings: { temperature?, maxTokens?, keepAliveMinutes? }, kept under keyOf(name) (Ollama's names
  // don't depend on case)
  function settingsOf(model) {
    const all = loadSettings().models, key = keyOf(model);
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  }
  // …as MetaCode uses them for its requests (server.js; its ids are "ollama/<model>")
  const modelSettings = model => settingsOf(String(model || '').replace(/^ollama\//, ''));

  function manageCheck(req) {
    const token = String(env.LOCAL_AI_ADMIN_TOKEN || '').trim();
    const given = String(req.get('x-metacode-admin-token') || '');
    if (token.length >= 12 && given) {
      const a = crypto.createHash('sha256').update(token).digest();
      const b = crypto.createHash('sha256').update(given).digest();
      if (crypto.timingSafeEqual(a, b)) return { allowed: true, how: 'token' };
    }
    if (isLocal(req) && loopbackHost(req)) return { allowed: true, how: 'this-machine' };
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
  // The installed model a request names, as Ollama lists it: → its name, or null once the request is answered
  async function installedModel(req, res) {
    const name = String((req.body && req.body.model) || '').trim();
    if (!LISTED_NAME.test(name)) { fail(res, 400, 'invalid_model', 'Name a model.'); return null; }
    let list;
    try { list = await ollama.tags(); } catch (e) { ollamaFail(res, e); return null; }
    const m = list.find(x => keyOf(x.name) === keyOf(name) || (x.model && keyOf(x.model) === keyOf(name)));
    if (!m) { fail(res, 404, 'not_found', 'Ollama has no model called "' + name.slice(0, 120) + '".'); return null; }
    return m.name;
  }

  async function installed() {
    const [list, running] = await Promise.all([ollama.tags(), ollama.ps().catch(() => [])]);
    const models = list.map(m => {
      const r = running.find(x => x.name === m.name);
      const d = m.details || {};
      return {
        name: m.name, size: m.size, digest: m.digest, modifiedAt: m.modified_at,
        family: d.family || null, parameterSize: d.parameter_size || null, quantization: d.quantization_level || null,
        contextLength: d.context_length || null, capabilities: Array.isArray(m.capabilities) ? m.capabilities : null,
        loaded: r ? { size: r.size, sizeVram: r.size_vram || 0, expiresAt: r.expires_at || null, contextLength: r.context_length || null } : null,
        settings: settingsOf(m.name),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    // (names with the same digest are one model under several names, e.g. gemma3:latest and gemma3:4b: its files
    // are counted once, and deleting one of the names frees nothing while another uses them)
    const names = new Map();              // digest → names
    for (const m of models) if (m.digest) names.set(m.digest, (names.get(m.digest) || []).concat(m.name));
    for (const m of models) m.aliases = m.digest ? names.get(m.digest).filter(n => n !== m.name) : [];
    const sizes = new Map(models.map(m => [m.digest || 'name ' + m.name, m.size || 0]));
    return { models, totalSize: [...sizes.values()].reduce((n, size) => n + size, 0) };
  }

  const router = express.Router();
  // MetaCode's own pages only: a request from this machine (from 127.0.0.1, through no proxy) under a name that
  // isn't this machine's comes from another website whose name was made to point at 127.0.0.1 ("DNS rebinding"),
  // and reads nothing either (the hardware and the home folder's path, the models). A reverse proxy on this
  // machine that forwards no client address looks the same: its site's name, in PUBLIC_URL, may read (managing
  // still needs the admin token).
  router.use((req, res, next) => {
    if (!isLocal(req) || loopbackHost(req) || publicHost(req, env)) return next();
    res.status(403).json({ error: { type: 'forbidden', code: 'foreign_host', message: 'The AI Model Store answers MetaCode\'s own pages only, and "' + hostOf(req).slice(0, 100) +
      '" isn\'t a name of this computer. Open MetaCode at localhost (or 127.0.0.1); behind a reverse proxy on this computer, set PUBLIC_URL in .env to the site\'s address.' } });
  });
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
    const model = await installedModel(req, res);
    if (!model) return;
    const s = settingsOf(model) || {};
    const minutes = Number.isFinite(s.keepAliveMinutes) ? s.keepAliveMinutes : 10;
    try { await ollama.load(model, minutes ? minutes + 'm' : -1); res.json(await installed()); } catch (e) { ollamaFail(res, e); }
  });
  router.post('/models/unload', manage, async (req, res) => {
    const model = await installedModel(req, res);
    if (!model) return;
    try { await ollama.unload(model); res.json(await installed()); } catch (e) { ollamaFail(res, e); }
  });
  router.post('/models/delete', manage, async (req, res) => {
    // (not while it downloads: also the first time, when Ollama doesn't list it yet)
    const busy = name => installs.busy(name) && (fail(res, 409, 'busy', name + ' is downloading: cancel the download first.'), true);
    if (busy(String((req.body && req.body.model) || '').trim())) return;
    const model = await installedModel(req, res);
    if (!model || busy(model)) return;
    try {
      await ollama.remove(model);
      const s = loadSettings();
      if (settingsOf(model)) { delete s.models[keyOf(model)]; saveSettings(); }
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
  router.put('/models/settings', manage, async (req, res) => {
    const model = await installedModel(req, res);
    if (!model) return;
    const given = (req.body && req.body.settings) || {};
    const clean = {};
    for (const [k, [lo, hi]] of Object.entries(SETTING_LIMITS)) {
      if (given[k] === undefined || given[k] === null || given[k] === '') continue;
      const n = Number(given[k]);
      if (!Number.isFinite(n) || n < lo || n > hi) return fail(res, 400, 'invalid_setting', k + ' must be between ' + lo + ' and ' + hi + '.');
      clean[k] = k === 'temperature' ? Math.round(n * 100) / 100 : Math.round(n);
    }
    const s = loadSettings();
    if (Object.keys(clean).length) s.models[keyOf(model)] = clean; else delete s.models[keyOf(model)];
    try { saveSettings(); } catch (e) { return fail(res, 500, 'not_saved', 'The settings couldn\'t be saved (' + e.code + ').'); }
    res.json({ model, settings: settingsOf(model) });
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
