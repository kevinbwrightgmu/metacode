// ── Reddit scraper: wiring + HTTP API ─────────────────────────────────────────
// Mounted by server.js at /api/scraper (same-origin only, like the AI routes)
// plus the Wisp WebSocket endpoint (/wisp/) and the Scramjet browser files
// (/scramjet/*). Errors follow MetaCode's API convention: an HTTP status and
// { error: { message, type } }.
//
//   GET    /api/scraper/status                 capabilities, limits, mode
//   POST   /api/scraper/resolve                validate a target → normalized target
//   GET    /api/scraper/jobs                   recent jobs (summaries)
//   POST   /api/scraper/jobs                   start a job → 202 { job }
//   GET    /api/scraper/jobs/:id               job detail (status, progress, logs, code)
//   GET    /api/scraper/jobs/:id/events        server-sent events: snapshot, status, progress, log, records, meta
//   GET    /api/scraper/jobs/:id/results       records (?offset, limit, type, search)
//   GET    /api/scraper/jobs/:id/logs          log lines
//   GET    /api/scraper/jobs/:id/export        download (?format=csv|json|ndjson, type, nested=1)
//   POST   /api/scraper/jobs/:id/cancel        cancel a queued or running job
//   DELETE /api/scraper/jobs/:id               cancel if needed, then forget the job

const express = require('express');
const path = require('path');
const { loadScraperConfig } = require('./config');
const { ScraperError, isScraperError, sanitize } = require('./errors');
const { createUpgradeHandler, WISP_PATH } = require('./network/wisp-server');
const { EpoxyWispTransport, transportAvailable } = require('./network/epoxy-transport');
const { PythonTransport, AutoTransport } = require('./network/python-transport');
const { HostRateLimiter } = require('./network/rate-limiter');
const { RedditHttpClient } = require('./network/reddit-http');
const { RelayHub } = require('./network/browser-relay');
const credentials = require('./credentials');
const { RedditApisClient, balanceOf, DASHBOARD_URL } = require('./network/redditapis-client');
const { DEFAULT_USER_AGENT } = require('./config');
const { normalizeTarget, normalizeOptions } = require('./reddit/targets');
const { runStandardScrape } = require('./reddit/standard-scraper');
const { JobManager, FINISHED } = require('./jobs/job-manager');
const { createCustomRunner, sandboxSupported, validateCode } = require('./sandbox/custom-runner');
const PYODIDE_VERSION = (() => { try { return require('pyodide/package.json').version; } catch (e) { return 'not installed'; } })();
const exporter = require('./export');

const SCRAMJET_FILES = {
  'scramjet.js':          ['@mercuryworkshop/scramjet', 'dist/scramjet.js'],
  'scramjet.wasm':        ['@mercuryworkshop/scramjet', 'dist/scramjet.wasm'],
  'controller.api.js':    ['@mercuryworkshop/scramjet-controller', 'dist/controller.api.js'],
  'controller.inject.js': ['@mercuryworkshop/scramjet-controller', 'dist/controller.inject.js'],
  'controller.sw.js':     ['@mercuryworkshop/scramjet-controller', 'dist/controller.sw.js'],
  'epoxy-transport.js':   ['@mercuryworkshop/epoxy-transport', 'dist/index.js']
};

function packageDir(name) {
  // These packages are ESM-only with "exports" maps; resolve through a file
  // their exports expose, then walk up to the package directory.
  const fs = require('fs');
  const entry = require.resolve(name);
  let dir = path.dirname(entry);
  for (let i = 0; i < 6; i++) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === name) return dir;
    } catch (e) { /* keep walking */ }
    dir = path.dirname(dir);
  }
  return null;
}

function sendError(res, err) {
  if (res.headersSent) return;
  const e = isScraperError(err) ? err : new ScraperError('internal_error', 'Something went wrong in the scraper.', { status: 500 });
  if (!isScraperError(err)) console.error('[scraper] ' + sanitize(err && (err.stack || err.message), 600));
  res.status(e.status || 500).json({ error: { message: e.message, type: e.type } });
}

// State-changing requests from another site are refused even though no CORS
// headers are sent for these routes (defence against form-style CSRF).
function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (e) { host = null; }
    if (host !== req.headers.host) return sendError(res, new ScraperError('forbidden_origin', 'Requests from other websites aren\'t allowed.', { status: 403 }));
  }
  next();
}

function createScraper(opts) {
  opts = opts || {};
  const config = opts.config || loadScraperConfig(process.env);

  // Reddit API keys: .env wins; otherwise keys saved from the Scraper page.
  const credFile = opts.credentialsFile || credentials.credentialsFile(process.env);
  const uaFromEnv = !!String(process.env.SCRAPER_USER_AGENT || '').trim();
  config.oauthSource = config.oauth ? 'env' : null;
  config.oauthUsername = null;
  function applySaved(saved) {
    config.oauth = saved ? { clientId: saved.clientId, clientSecret: saved.clientSecret } : null;
    config.oauthSource = saved ? 'saved' : null;
    config.oauthUsername = saved ? saved.username : null;
    if (!uaFromEnv) config.userAgent = saved ? credentials.userAgentFor(saved.username) : DEFAULT_USER_AGENT;
  }
  if (!config.oauth) {
    const saved = credentials.loadSaved(credFile);
    if (saved) applySaved(saved);
  }

  // RedditAPIs.com key: REDDITAPIS_KEY in .env wins; otherwise the one saved
  // from the Scraper page. Never sent to the browser or to custom code.
  const rapiFile = opts.redditApisKeyFile || credentials.redditApisKeyFile(process.env);
  config.redditApisSource = config.redditApisKey ? 'env' : null;
  if (!config.redditApisKey) {
    const savedKey = credentials.loadRedditApisKey(rapiFile);
    if (savedKey) { config.redditApisKey = savedKey; config.redditApisSource = 'saved'; }
  }
  let redditApisBalance = null;
  let port = null;
  const getWispUrl = () => (port ? 'ws://127.0.0.1:' + port + WISP_PATH : null);

  // Server-side HTTPS: Python (python/reddit_fetch.py) when available, else
  // epoxy-tls over Wisp — see network/python-transport.js.
  const transport = opts.transport || new AutoTransport({
    mode: config.serverTransport,
    python: new PythonTransport({ config }),
    epoxy: new EpoxyWispTransport({ getWispUrl, userAgent: config.userAgent, maxResponseBytes: config.maxResponseBytes }),
    onChoose: (t, err) => {
      if (opts.logToConsole === false) return;
      if (t.kind === 'python') console.log('[scraper] Server engine: Python ' + t.info.python + ' (' + t.info.command + ')');
      else if (err) console.warn('[scraper] Python engine unavailable (' + err.message + '); using epoxy-tls over Wisp.');
    }
  });
  const limiter = new HostRateLimiter({ maxConcurrent: config.maxConcurrentRequests });
  const http = new RedditHttpClient({ config, transport, limiter });

  // "This browser (Scramjet)" engine: requests are fetched by an open MetaCode
  // tab (see network/browser-relay.js). They are the user's own browser
  // requests, sent with the browser's User-Agent and without API credentials,
  // so the server-side robots.txt gate and OAuth don't apply; the shared rate
  // limiter (public-mode minimum delay), retries, destination checks and caps do.
  const relay = new RelayHub({ maxResponseBytes: config.maxResponseBytes });
  const browserConfig = Object.assign({}, config, { oauth: null, respectRobotsTxt: false });
  // "RedditAPIs.com" engine: a third-party pay-per-call Reddit data API
  // (network/redditapis-client.js), through the same transport and limiter.
  const redditApis = new RedditApisClient({ config, transport, limiter, getKey: () => config.redditApisKey, baseUrl: config.redditApisBaseUrl });
  const redditApisOptionsConfig = Object.assign({}, config, { oauth: null, publicMinDelayMs: config.minDelayMs });

  const browserHttpFor = jobId => {
    const client = new RedditHttpClient({ config: browserConfig, transport: relay.transportFor(jobId), limiter });
    client.label = 'your browser (Scramjet) — keep MetaCode open until the job finishes';
    return client;
  };
  const runCustom = createCustomRunner({ config });
  const jobs = new JobManager({
    config, http,
    runners: {
      standard: (job, ctx) => runStandardScrape(job.target, job.options, ctx),
      custom: runCustom
    },
    logToConsole: opts.logToConsole
  });
  const onUpgrade = createUpgradeHandler(config);
  jobs.on('event', (job, type, payload) => {
    if (type === 'status' && FINISHED.has(payload.status)) relay.cancelJob(job.id);
  });
  jobs.on('removed', job => relay.cancelJob(job.id));

  function status() {
    const sandbox = sandboxSupported('javascript');
    const pySandbox = sandboxSupported('python');
    const floor = http.mode === 'oauth' ? config.minDelayMs : Math.max(config.minDelayMs, config.publicMinDelayMs);
    return {
      enabled: config.enabled,
      mode: http.mode,
      oauthConfigured: !!config.oauth,
      // Never the secret: where the keys come from and a hint to recognise them.
      credentials: {
        configured: !!config.oauth,
        source: config.oauthSource,
        clientIdHint: config.oauth ? '…' + config.oauth.clientId.slice(-4) : null,
        username: config.oauthUsername
      },
      respectRobotsTxt: config.respectRobotsTxt,
      userAgent: config.userAgent,
      userAgentIsDefault: config.userAgent === DEFAULT_USER_AGENT,
      transport: Object.assign({
        name: transport.kind === 'python' ? 'Python' : 'epoxy-tls over Wisp',
        kind: transport.kind,
        available: transport.kind === 'python' || transportAvailable(),
        epoxyVersion: transport.info ? transport.info.version : null,
        wispPath: WISP_PATH
      }, typeof transport.status === 'function' ? transport.status() : {}),
      allowedHosts: config.apiHosts,
      customCode: {
        enabled: config.customCodeEnabled,
        available: config.customCodeEnabled && (sandbox.ok || pySandbox.ok),
        reason: !config.customCodeEnabled ? 'Custom code is turned off (SCRAPER_CUSTOM_CODE_ENABLED=false).' : (sandbox.ok ? null : sandbox.reason),
        timeoutMs: config.customTimeoutMs,
        memoryMb: config.customMemoryMb,
        languages: (pySandbox.ok ? ['python'] : []).concat(sandbox.ok ? ['javascript', 'typescript'] : []),
        python: {
          available: config.customCodeEnabled && pySandbox.ok,
          reason: pySandbox.ok ? null : pySandbox.reason,
          memoryMb: config.customPythonMemoryMb,
          runtime: 'Pyodide ' + PYODIDE_VERSION + ' (CPython in WebAssembly)'
        }
      },
      browser: { enabled: config.enabled && config.browserEnabled },
      // Where a job's Reddit requests are made: "browser" = an open MetaCode tab
      // through Scramjet (no setup); "server" = this server (API credentials, or
      // public pages subject to robots.txt).
      engines: {
        browser: { available: config.enabled && config.browserEnabled, minDelayMs: Math.max(config.minDelayMs, config.publicMinDelayMs), connectedTabs: relay.subscribers },
        server: { available: config.enabled, mode: http.mode, minDelayMs: floor },
        redditapis: { available: config.enabled && !!config.redditApisKey, minDelayMs: config.minDelayMs }
      },
      defaultEngine: config.redditApisKey ? 'redditapis' : (config.oauth || !config.browserEnabled ? 'server' : 'browser'),
      // Never the key itself.
      redditApis: {
        configured: !!config.redditApisKey,
        source: config.redditApisSource,
        keyHint: config.redditApisKey ? '…' + config.redditApisKey.slice(-4) : null,
        balance: redditApisBalance,
        dashboardUrl: DASHBOARD_URL
      },
      limits: {
        maxItems: config.maxItems,
        maxPages: config.maxPages,
        minDelayMs: floor,
        defaultDelayMs: Math.max(floor, config.defaultDelayMs),
        requestTimeoutMs: config.requestTimeoutMs,
        maxConcurrentRequests: config.maxConcurrentRequests,
        maxConcurrentJobs: config.maxConcurrentJobs,
        jobRetentionMinutes: config.jobRetentionMinutes
      },
      node: process.version
    };
  }

  function findJob(req) {
    const job = jobs.get(String(req.params.id || ''));
    if (!job) throw new ScraperError('not_found', 'That scraper job doesn\'t exist (it may have expired or the server restarted).', { status: 404 });
    return job;
  }

  // Records a standard job may collect: the post plus its comments for a post
  // target; otherwise maxItems listing items, plus up to commentLimit comments
  // for each of the first commentPosts posts when comments are included.
  function capacityFor(target, options) {
    if (target.type === 'post') return 1 + options.commentLimit;
    if (options.includeComments && ['subreddit', 'listing', 'search', 'user'].includes(target.type)) {
      return options.maxItems + options.commentPosts * options.commentLimit;
    }
    return options.maxItems;
  }

  function parseSpec(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScraperError('invalid_request', 'The request body must be a JSON object.', { status: 400 });
    const mode = body.mode === 'custom' ? 'custom' : (body.mode === undefined || body.mode === 'standard' ? 'standard' : null);
    if (!mode) throw new ScraperError('invalid_request', 'mode must be "standard" or "custom".', { status: 400 });
    const engine = body.engine === undefined || body.engine === 'server' ? 'server' : (['browser', 'redditapis'].includes(body.engine) ? body.engine : null);
    if (!engine) throw new ScraperError('invalid_request', 'engine must be "browser", "server" or "redditapis".', { status: 400 });
    if (engine === 'redditapis' && !config.redditApisKey) {
      throw new ScraperError('not_available', 'Add your RedditAPIs.com API key first (Scraper page → Reddit API access).', { status: 400 });
    }
    if (engine === 'browser' && !config.browserEnabled) {
      throw new ScraperError('not_available', 'Browser mode needs the in-app browser, which is turned off (SCRAPER_BROWSER_ENABLED=false).', { status: 403 });
    }
    const options = normalizeOptions(body.options, engine === 'browser' ? browserConfig : (engine === 'redditapis' ? redditApisOptionsConfig : config));
    const engineSpec = engine === 'browser' ? { engine, httpFor: browserHttpFor }
      : engine === 'redditapis' ? { engine, httpFor: () => redditApis } : { engine };
    if (mode === 'standard') {
      const target = normalizeTarget(body.target);
      return Object.assign({ mode, target, options, capacity: capacityFor(target, options) }, engineSpec);
    }
    if (!config.customCodeEnabled) throw new ScraperError('not_available', 'Custom code is turned off on this server (SCRAPER_CUSTOM_CODE_ENABLED=false).', { status: 403 });
    const language = body.language === undefined || body.language === null || body.language === '' ? 'javascript' : body.language;
    validateCode(body.code, language);
    const support = sandboxSupported(language);
    if (!support.ok) throw new ScraperError('not_available', support.reason, { status: 503 });
    let target = null;
    const t = body.target;
    const hasTarget = t && typeof t === 'object' && Object.keys(t).some(k => k !== 'type' && t[k] !== '' && t[k] !== null && t[k] !== undefined);
    if (hasTarget) target = normalizeTarget(t);
    let params = {};
    if (body.params !== undefined && body.params !== null) {
      if (typeof body.params !== 'object' || Array.isArray(body.params)) throw new ScraperError('invalid_request', 'Parameters must be a JSON object.', { status: 400 });
      if (JSON.stringify(body.params).length > 32 * 1024) throw new ScraperError('invalid_request', 'Parameters are too large (32 KB at most).', { status: 400 });
      params = body.params;
    }
    return Object.assign({ mode, target, options, code: body.code, language, params, label: target ? 'Custom: ' + target.label : 'Custom scraper' }, engineSpec);
  }

  const router = express.Router();
  router.use(sameOriginOnly);
  router.use((req, res, next) => {
    if (!config.enabled && req.path !== '/status') return sendError(res, new ScraperError('not_available', 'The Reddit scraper is turned off (SCRAPER_ENABLED=false).', { status: 503 }));
    next();
  });

  router.get('/status', (req, res) => res.json(status()));

  router.post('/resolve', (req, res) => {
    try {
      res.json({ target: normalizeTarget(req.body && req.body.target) });
    } catch (err) { sendError(res, err); }
  });

  // ── Reddit API access (Scraper page form) ──
  // Saves a Reddit app's ID/secret after checking them with Reddit (a token
  // request through the normal epoxy-tls/Wisp path). Keys in .env can't be
  // changed here.
  router.post('/credentials', async (req, res) => {
    try {
      if (config.oauthSource === 'env') {
        throw new ScraperError('invalid_state', 'Reddit API keys are set in the server\'s .env file; change them there.', { status: 409 });
      }
      let creds;
      try { creds = credentials.validate(req.body); } catch (e) { throw new ScraperError('invalid_request', e.message, { status: 400 }); }
      const probeConfig = Object.assign({}, config, { oauth: { clientId: creds.clientId, clientSecret: creds.clientSecret },
        userAgent: uaFromEnv ? config.userAgent : credentials.userAgentFor(creds.username) });
      const probe = new RedditHttpClient({ config: probeConfig, transport, limiter });
      try {
        await probe.getToken({ retries: 1 });
      } catch (err) {
        const e = isScraperError(err) ? err : new ScraperError('network', 'Couldn\'t reach Reddit to check the keys.', { status: 502 });
        throw new ScraperError(e.type, 'The keys weren\'t saved: ' + e.message, { status: e.type === 'auth_error' ? 400 : 502 });
      }
      try {
        credentials.save(credFile, creds);
      } catch (err) {
        throw new ScraperError('internal_error', 'The keys work, but MetaCode couldn\'t save them next to server.js (check folder permissions).', { status: 500, detail: err.message });
      }
      applySaved(creds);
      http.token = probe.token;      // reuse the token just obtained
      res.json(status());
    } catch (err) { sendError(res, err); }
  });

  // RedditAPIs.com key: checked with the free GET /account/me before saving.
  router.post('/redditapis-key', async (req, res) => {
    try {
      if (config.redditApisSource === 'env') {
        throw new ScraperError('invalid_state', 'The RedditAPIs.com key is set in the server\'s .env file (REDDITAPIS_KEY); change it there.', { status: 409 });
      }
      let key;
      try { key = credentials.validateRedditApisKey(req.body && req.body.key); } catch (e) { throw new ScraperError('invalid_request', e.message, { status: 400 }); }
      const probe = new RedditApisClient({ config, transport, limiter, getKey: () => key, baseUrl: config.redditApisBaseUrl });
      let account;
      try {
        account = await probe.account();
      } catch (err) {
        const e = isScraperError(err) ? err : new ScraperError('network', 'Couldn\'t reach RedditAPIs.com to check the key.', { status: 502 });
        throw new ScraperError(e.type, 'The key wasn\'t saved: ' + e.message, { status: e.type === 'auth_error' ? 400 : 502 });
      }
      try {
        credentials.saveRedditApisKey(rapiFile, key);
      } catch (err) {
        throw new ScraperError('internal_error', 'The key works, but MetaCode couldn\'t save it next to server.js (check folder permissions).', { status: 500, detail: err.message });
      }
      config.redditApisKey = key;
      config.redditApisSource = 'saved';
      redditApisBalance = balanceOf(account);
      res.json(status());
    } catch (err) { sendError(res, err); }
  });

  router.delete('/redditapis-key', (req, res) => {
    try {
      if (config.redditApisSource === 'env') {
        throw new ScraperError('invalid_state', 'The RedditAPIs.com key is set in the server\'s .env file (REDDITAPIS_KEY); remove it there.', { status: 409 });
      }
      credentials.remove(rapiFile);
      config.redditApisKey = null;
      config.redditApisSource = null;
      redditApisBalance = null;
      res.json(status());
    } catch (err) { sendError(res, err); }
  });

  router.delete('/credentials', (req, res) => {
    try {
      if (config.oauthSource === 'env') {
        throw new ScraperError('invalid_state', 'Reddit API keys are set in the server\'s .env file; remove them there.', { status: 409 });
      }
      credentials.remove(credFile);
      applySaved(null);
      http.token = null;
      res.json(status());
    } catch (err) { sendError(res, err); }
  });

  router.get('/jobs', (req, res) => {
    res.json({ jobs: jobs.list().map(j => jobs.summary(j)) });
  });

  router.post('/jobs', (req, res) => {
    try {
      const spec = parseSpec(req.body);
      const job = jobs.create(spec);
      res.status(202).json({ job: jobs.summary(job) });
    } catch (err) { sendError(res, err); }
  });

  router.get('/jobs/:id', (req, res) => {
    try { res.json({ job: jobs.detail(findJob(req)) }); } catch (err) { sendError(res, err); }
  });

  router.get('/jobs/:id/logs', (req, res) => {
    try { const job = findJob(req); res.json({ logs: job.logs, dropped: job.logsDropped }); } catch (err) { sendError(res, err); }
  });

  router.get('/jobs/:id/results', (req, res) => {
    try {
      const job = findJob(req);
      res.json(Object.assign({ status: job.status }, jobs.query(job, req.query)));
    } catch (err) { sendError(res, err); }
  });

  router.get('/jobs/:id/export', (req, res) => {
    try {
      const job = findJob(req);
      const format = String(req.query.format || 'json').toLowerCase();
      const type = String(req.query.type || 'all');
      const records = type === 'all' ? job.records : job.records.filter(r => r.record_type === type);
      const base = 'reddit_' + (job.target && (job.target.subreddit || job.target.username || job.target.postId || job.target.type) || 'custom')
        .replace(/[^A-Za-z0-9_+-]+/g, '_').slice(0, 40) + '_' + job.id.slice(0, 8) + (type !== 'all' ? '_' + type.replace(/\W/g, '') : '');
      let body, mime, ext;
      if (format === 'csv') { body = exporter.toCSV(records); mime = 'text/csv; charset=utf-8'; ext = 'csv'; }
      else if (format === 'ndjson') { body = exporter.toNDJSON(records); mime = 'application/x-ndjson; charset=utf-8'; ext = 'ndjson'; }
      else if (format === 'json') { body = exporter.toJSON(job, records, req.query.nested === '1'); mime = 'application/json; charset=utf-8'; ext = 'json'; }
      else throw new ScraperError('invalid_request', 'format must be csv, json or ndjson.', { status: 400 });
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', 'attachment; filename="' + base + '.' + ext + '"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(body);
    } catch (err) { sendError(res, err); }
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    try {
      const job = findJob(req);
      if (FINISHED.has(job.status)) throw new ScraperError('invalid_state', 'This job has already ' + job.status + '.', { status: 409 });
      jobs.cancel(job.id);
      res.json({ job: jobs.summary(job) });
    } catch (err) { sendError(res, err); }
  });

  router.delete('/jobs/:id', (req, res) => {
    try { const job = findJob(req); jobs.remove(job.id); res.json({ ok: true }); } catch (err) { sendError(res, err); }
  });

  // Server-sent events for one job. Progress is coalesced to ≤ 4 per second;
  // the stream ends after the job reaches a final status.
  router.get('/jobs/:id/events', (req, res) => {
    let job;
    try { job = findJob(req); } catch (err) { return sendError(res, err); }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.on('error', () => {});

    const write = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    };
    let progressTimer = null;
    let pendingProgress = null;
    const flushProgress = () => {
      progressTimer = null;
      if (pendingProgress) { write('progress', pendingProgress); pendingProgress = null; }
    };
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearTimeout(progressTimer);
      jobs.off('event', onEvent);
      jobs.off('removed', onRemoved);
      if (!res.writableEnded) res.end();
    };
    const onEvent = (j, type, payload) => {
      if (j.id !== job.id) return;
      if (type === 'progress') {
        pendingProgress = Object.assign({}, payload);
        if (!progressTimer) progressTimer = setTimeout(flushProgress, 250);
        return;
      }
      if (type === 'status') {
        flushProgress();
        write('status', payload);
        if (FINISHED.has(payload.status)) end();
        return;
      }
      write(type, payload);
    };
    const onRemoved = j => { if (j.id === job.id) { write('removed', { id: j.id }); end(); } };
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

    write('snapshot', { job: jobs.detail(job) });
    if (FINISHED.has(job.status)) return end();
    jobs.on('event', onEvent);
    jobs.on('removed', onRemoved);
    req.on('close', end);
  });

  // ── Browser relay (see network/browser-relay.js) ──
  // A MetaCode tab listens here and fetches browser-mode requests for any job.
  router.get('/relay/events', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.on('error', () => {});
    const write = (event, data) => { if (!res.writableEnded && !res.destroyed) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
    const onRequest = r => write('relay', r);
    const onCancel = c => write('relay-cancel', c);
    relay.subscribers++;
    write('ready', { allowedHosts: config.apiHosts });
    relay.unclaimed().forEach(onRequest);
    relay.on('request', onRequest);
    relay.on('cancel', onCancel);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    let closed = false;
    req.on('close', () => {
      if (closed) return;
      closed = true;
      relay.subscribers--;
      clearInterval(heartbeat);
      relay.off('request', onRequest);
      relay.off('cancel', onCancel);
    });
  });

  router.post('/relay/:rid/claim', (req, res) => {
    const request = relay.claim(String(req.params.rid));
    if (!request) return sendError(res, new ScraperError('invalid_state', 'Another tab is already handling this request, or it has ended.', { status: 409 }));
    res.json({ request });
  });

  router.post('/relay/:rid', (req, res) => {
    if (!relay.respond(String(req.params.rid), req.body)) {
      return sendError(res, new ScraperError('invalid_state', 'This request has already ended.', { status: 409 }));
    }
    res.json({ ok: true });
  });

  router.use((req, res) => sendError(res, new ScraperError('not_found', 'Unknown scraper endpoint.', { status: 404 })));

  // Scramjet + epoxy-transport browser files for the in-app Reddit browser.
  const scramjetRouter = express.Router();
  scramjetRouter.get('/:file', (req, res, next) => {
    const entry = SCRAMJET_FILES[req.params.file];
    if (!entry || !config.enabled || !config.browserEnabled) return next();
    const dir = packageDir(entry[0]);
    if (!dir) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dir, entry[1]), { headers: { 'Content-Type': req.params.file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript; charset=utf-8' } });
  });

  return {
    config, http, jobs, relay, router, scramjetRouter, onUpgrade, status,
    setPort(p) {
      port = p;
      if (typeof transport.choose === 'function') transport.choose().catch(() => {});
    },
    shutdown() {
      jobs.shutdown();
      if (typeof transport.close === 'function') transport.close();
    }
  };
}

module.exports = { createScraper };
