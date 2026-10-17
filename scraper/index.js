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
//   POST   /api/scraper/jobs/:id/cancel        cancel a queued, running, waiting or paused job
//   POST   /api/scraper/jobs/:id/pause         pause (standard scrapes; continue later from the checkpoint)
//   POST   /api/scraper/jobs/:id/resume        resume a paused or waiting job (own keys are sent again)
//   PATCH  /api/scraper/jobs/:id               change a paused job's delay / limits (only lower limits)
//   GET    /api/scraper/jobs/:id/summary       collection summary (counts, time range, requests, checkpoint)
//   GET    /api/scraper/jobs/:id/history       the job's recorded events (?offset, limit)
//   DELETE /api/scraper/jobs/:id               cancel if needed, then forget the job (and its files)
//   GET    /api/scraper/network                the network route's status (no addresses or credentials)
//   GET    /api/scraper/admin/network          administrators: providers, circuits, metrics, queue health
//   POST   /api/scraper/admin/network/:id/check | /reset   administrators: run a health check / close a circuit
//
// Jobs are kept on disk (SCRAPER_DATA_DIR, jobs/job-store.js) and survive a
// restart; requests go through the administrator's network providers
// (network/providers.js) behind a circuit breaker (network/network-manager.js).

const express = require('express');
const path = require('path');
const { loadScraperConfig } = require('./config');
const { ScraperError, isScraperError, sanitize } = require('./errors');
const { createUpgradeHandler, plainHttpHandler, WISP_PATH } = require('./network/wisp-server');
const { EpoxyWispTransport, transportAvailable } = require('./network/epoxy-transport');
const { PythonTransport, AutoTransport } = require('./network/python-transport');
const { HostRateLimiter } = require('./network/rate-limiter');
const { providersFromEnv } = require('./network/providers');
const { NetworkManager } = require('./network/network-manager');
const { JobStore } = require('./jobs/job-store');
const { RedditHttpClient } = require('./network/reddit-http');
const { RelayHub } = require('./network/browser-relay');
const credentials = require('./credentials');
const { RedditApisClient, balanceOf, DASHBOARD_URL } = require('./network/redditapis-client');
const { DEFAULT_USER_AGENT } = require('./config');
const { normalizeTarget, normalizeOptions } = require('./reddit/targets');
const { runStandardScrape } = require('./reddit/standard-scraper');
const { JobManager, FINISHED, ACTIVE } = require('./jobs/job-manager');
const crypto = require('crypto');
const { createCustomRunner, sandboxSupported, validateCode } = require('./sandbox/custom-runner');
const PYODIDE_VERSION = (() => { try { return require('pyodide/package.json').version; } catch (e) { return 'not installed'; } })();
const exporter = require('./export');
const { ownerOf } = require('../owner');
const { createAiRunner, normalizeAiOptions, normalizeGoal } = require('./ai/agent-runner');
const { createPlatforms } = require('./platforms');

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
  if (e.retryAfterMs) res.set('Retry-After', String(Math.ceil(e.retryAfterMs / 1000)));
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

  // The server's own Reddit API keys (shared by everyone on this server): .env,
  // or a file saved by an earlier version (read only; see credentials.js).
  // Each user's own keys come with their jobs instead (ownRedditClient below).
  const credFile = opts.credentialsFile || credentials.credentialsFile(process.env);
  const uaFromEnv = !!String(process.env.SCRAPER_USER_AGENT || '').trim();
  config.oauthSource = config.oauth ? 'env' : null;
  config.oauthUsername = null;
  if (!config.oauth) {
    const saved = credentials.loadSaved(credFile);
    if (saved) {
      config.oauth = { clientId: saved.clientId, clientSecret: saved.clientSecret };
      config.oauthSource = 'saved';
      config.oauthUsername = saved.username;
      if (!uaFromEnv) config.userAgent = credentials.userAgentFor(saved.username);
    }
  }

  // The server's RedditAPIs.com key: REDDITAPIS_KEY in .env, or a file saved by
  // an earlier version (read only). Never sent to the browser or to custom code.
  const rapiFile = opts.redditApisKeyFile || credentials.redditApisKeyFile(process.env);
  config.redditApisSource = config.redditApisKey ? 'env' : null;
  if (!config.redditApisKey) {
    const savedKey = credentials.loadRedditApisKey(rapiFile);
    if (savedKey) { config.redditApisKey = savedKey; config.redditApisSource = 'saved'; }
  }
  let port = null;
  const getWispUrl = () => (port ? 'ws://127.0.0.1:' + port + WISP_PATH : null);

  // Server-side HTTPS: Python (python/reddit_fetch.py) when available, else
  // epoxy-tls over Wisp — see network/python-transport.js.
  const baseTransport = opts.transport || new AutoTransport({
    mode: config.serverTransport,
    python: new PythonTransport({ config }),
    epoxy: new EpoxyWispTransport({ getWispUrl, userAgent: config.userAgent, maxResponseBytes: config.maxResponseBytes }),
    onChoose: (t, err) => {
      if (opts.logToConsole === false) return;
      if (t.kind === 'python') console.log('[scraper] Server engine: Python ' + t.info.python + ' (' + t.info.command + ')');
      else if (err) console.warn('[scraper] Python engine unavailable (' + err.message + '); using epoxy-tls over Wisp.');
    }
  });
  // The routes requests may take (direct, an administrator's proxy, a VPN
  // gateway) behind a circuit breaker each. Everything below calls `transport`.
  const net = providersFromEnv(config.network || {}, {
    transport: baseTransport,
    rules: { hostPatterns: config.egressHostPatterns, ports: config.egressPorts, allowPlainHttp: !!config.allowPrivateNetwork },
    transportHosts: config.wispHostPatterns,
    maxResponseBytes: config.maxResponseBytes
  });
  net.warnings.forEach(w => { if (!config.warnings.includes(w)) config.warnings.push(w); });
  if (net.order[0] !== 'direct' && opts.logToConsole !== false) {
    const first = net.providers[0];
    console.log('[scraper] Network route: ' + first.label + (first.problems.length ? ' — NOT USABLE: ' + first.problems.join(' ') : '') + (net.failover ? ' (failover: ' + net.order.slice(1).join(', ') + ')' : ''));
  }
  const transport = new NetworkManager({
    providers: net.providers, failover: net.failover,
    breaker: { failureThreshold: config.circuitFailures, cooldownMs: config.circuitCooldownMs, maxCooldownMs: config.circuitMaxCooldownMs }
  });
  const limiter = new HostRateLimiter({ maxConcurrent: config.maxConcurrentRequests });
  const http = new RedditHttpClient({ config, transport, limiter });
  // YouTube and X (official APIs), through the same route and limiter
  const platforms = createPlatforms({ config, transport, limiter });

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

  // ── A user's own keys ──
  // Sent by their browser with each job, never stored. One client per set of
  // keys, so that user's jobs share one token and one rate limit (separate
  // from everyone else's: limitScope); unused clients are dropped after an hour.
  const ownClients = new Map();     // keyId → { client, usedAt }
  const OWN_CLIENT_IDLE_MS = 60 * 60 * 1000;
  function ownClient(id, make) {
    const now = Date.now();
    for (const [k, v] of ownClients) if (now - v.usedAt > OWN_CLIENT_IDLE_MS) ownClients.delete(k);
    let entry = ownClients.get(id);
    if (!entry) {
      if (ownClients.size >= 1000) ownClients.delete(ownClients.keys().next().value);
      entry = { client: make() };
      ownClients.set(id, entry);
    }
    entry.usedAt = now;
    return entry.client;
  }
  function ownRedditClient(creds) {
    const id = credentials.keyId('reddit', creds.clientId, creds.clientSecret, creds.username || '');
    return ownClient(id, () => {
      const own = Object.assign({}, config, { oauth: { clientId: creds.clientId, clientSecret: creds.clientSecret },
        userAgent: uaFromEnv ? config.userAgent : credentials.userAgentFor(creds.username) });
      const client = new RedditHttpClient({ config: own, transport, limiter, limitScope: id });
      client.label = 'Reddit Data API with your own keys' + (creds.username ? ' (u/' + creds.username + ')' : '');
      return client;
    });
  }
  function ownRedditApisClient(key) {
    const id = credentials.keyId('redditapis', key);
    return ownClient(id, () => {
      const client = new RedditApisClient({ config, transport, limiter, getKey: () => key, baseUrl: config.redditApisBaseUrl, limitScope: id });
      client.label = 'RedditAPIs.com with your own key (billed per request)';
      return client;
    });
  }

  const browserHttpFor = jobId => {
    const client = new RedditHttpClient({ config: browserConfig, transport: relay.transportFor(jobId), limiter });
    client.label = 'your browser (Scramjet) — keep MetaCode open until the job finishes';
    return client;
  };
  const runCustom = createCustomRunner({ config });
  // AI Scraper (beta): python/ai_scraper.py plans with MetaCode's AI service (opts.ai)
  const ai = opts.ai || null;
  const aiProblem = () => (!ai ? 'The AI Scraper isn\'t available on this server.' : ai.problem());
  const runAi = createAiRunner({ ai, env: process.env });
  // Jobs on disk (SCRAPER_DATA_DIR) unless SCRAPER_PERSIST_JOBS=false
  const store = config.persistJobs ? new JobStore({ dir: config.dataDir, instanceId: crypto.randomUUID() }) : null;
  const jobs = new JobManager({
    config, http, store,
    runners: {
      standard: (job, ctx) => runStandardScrape(job.target, job.options, ctx),
      custom: runCustom,
      ai: runAi,
      platform: (job, ctx) => platforms.run(job, ctx)
    },
    // After a restart: a job's HTTP client again. Users' own keys and browser
    // tabs aren't kept on the server, so those jobs wait for their owner.
    reattach(job) {
      if (job.keySource === 'own') return { needs: 'keys' };
      if (job.keySource === 'browser' || job.engine === 'browser') return { needs: 'browser' };
      if (job.engine === 'redditapis') return config.redditApisKey ? { http: redditApis } : { needs: 'keys' };
      return { http: null };
    },
    logToConsole: opts.logToConsole
  });
  let recovered = null;
  const onUpgrade = createUpgradeHandler(config);
  // Plans and limits (accounts/): who may scrape, and how much. Without a policy nothing is limited.
  const policy = opts.policy || null;
  jobs.on('event', (job, type, payload) => {
    if (type === 'status' && FINISHED.has(payload.status)) {
      relay.cancelJob(job.id);
      if (policy && policy.jobFinished) policy.jobFinished(job);
    }
  });
  jobs.on('removed', job => relay.cancelJob(job.id));
  // Who may see network diagnostics (accounts.admin(): ADMIN_EMAILS). Without it nobody may.
  const adminGuard = opts.adminGuard || ((req, res) => sendError(res, new ScraperError('forbidden', 'Only this server\'s administrators can see this.', { status: 403 })));
  relay.ownerOfJob = jobId => { const j = jobs.get(jobId); return j ? j.owner || null : null; };

  function status(req) {
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
      // The route requests take (no addresses or credentials), and the job store
      network: transport.publicStatus(),
      jobStore: { persistent: !!store, maxQueuedJobs: config.maxQueuedJobs, queueDepth: jobs.queue.length },
      transport: Object.assign({
        name: transport.kind === 'python' ? 'Python' : transport.kind === 'vpn-gateway' ? 'VPN gateway' : transport.kind === 'http-proxy' ? 'Proxy' : 'epoxy-tls over Wisp',
        kind: transport.kind,
        available: transport.kind !== 'epoxy' && transport.kind !== 'pending' ? true : transportAvailable(),
        epoxyVersion: transport.info ? transport.info.version : null,
        wispPath: WISP_PATH
      }, typeof transport.status === 'function' ? transport.status() : {}),
      allowedHosts: config.apiHosts,
      platforms: platforms.status(),
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
        browser: { available: config.enabled && config.browserEnabled, minDelayMs: Math.max(config.minDelayMs, config.publicMinDelayMs), connectedTabs: req ? relay.tabsFor(ownerOf(req)) : relay.subscribers },
        server: { available: config.enabled, mode: http.mode, minDelayMs: floor },
        // Offered to everyone: with this server's key, or with the user's own (kept in their browser).
        redditapis: { available: config.enabled, serverKey: !!config.redditApisKey, minDelayMs: config.minDelayMs }
      },
      // The engine the pages pick until the user chooses another (SCRAPER_DEFAULT_ENGINE).
      defaultEngine: config.defaultEngine === 'browser' && !config.browserEnabled ? 'server' : config.defaultEngine,
      // AI Scraper (beta): AI jobs (mode "ai"), run by the server or RedditAPIs.com engine
      aiScraper: { available: config.enabled && !aiProblem(), reason: aiProblem() },
      // Users can add their own keys (kept in their browser, sent with their jobs).
      ownKeys: { reddit: true, redditapis: true, apiMinDelayMs: config.minDelayMs },
      // Never the key itself.
      redditApis: {
        configured: !!config.redditApisKey,
        source: config.redditApisSource,
        keyHint: config.redditApisKey ? '…' + config.redditApisKey.slice(-4) : null,
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
    // Another browser's job answers like a missing one
    if (!job || (job.owner || null) !== ownerOf(req)) throw new ScraperError('not_found', 'That scraper job doesn\'t exist (it may have expired or the server restarted).', { status: 404 });
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
    if (body.mode === 'platform') return platforms.parseSpec(body);
    const mode = ['custom', 'ai'].includes(body.mode) ? body.mode : (body.mode === undefined || body.mode === 'standard' ? 'standard' : null);
    if (!mode) throw new ScraperError('invalid_request', 'mode must be "standard", "custom", "ai" or "platform".', { status: 400 });
    const engine = body.engine === undefined || body.engine === 'server' ? 'server' : (['browser', 'redditapis'].includes(body.engine) ? body.engine : null);
    if (!engine) throw new ScraperError('invalid_request', 'engine must be "browser", "server" or "redditapis".', { status: 400 });
    // The user's own keys, when sent: the job runs on their own API limit.
    let own = null;
    if (engine === 'server' && body.credentials !== undefined && body.credentials !== null) {
      let creds;
      try { creds = credentials.validate(body.credentials); } catch (e) { throw new ScraperError('invalid_request', 'Your Reddit API keys: ' + e.message, { status: 400 }); }
      own = ownRedditClient(creds);
    }
    if (engine === 'redditapis' && body.redditApisKey !== undefined && body.redditApisKey !== null) {
      let key;
      try { key = credentials.validateRedditApisKey(body.redditApisKey); } catch (e) { throw new ScraperError('invalid_request', 'Your RedditAPIs.com key: ' + e.message, { status: 400 }); }
      own = ownRedditApisClient(key);
    }
    if (engine === 'redditapis' && !own && !config.redditApisKey) {
      throw new ScraperError('not_available', 'Add your RedditAPIs.com API key first (Reddit Scraper → RedditAPIs.com key), or choose another way under "Fetch Reddit through".', { status: 400 });
    }
    if (engine === 'browser' && !config.browserEnabled) {
      throw new ScraperError('not_available', 'Browser mode needs the in-app browser, which is turned off (SCRAPER_BROWSER_ENABLED=false).', { status: 403 });
    }
    const options = normalizeOptions(body.options, engine === 'browser' ? browserConfig
      : (engine === 'redditapis' ? redditApisOptionsConfig : (own ? own.config : config)));
    const keySource = own ? 'own' : engine === 'browser' ? 'browser' : 'server';
    const engineSpec = engine === 'browser' ? { engine, keySource, httpFor: browserHttpFor }
      : own ? { engine, keySource, httpFor: () => own }
      : engine === 'redditapis' ? { engine, keySource, httpFor: () => redditApis } : { engine, keySource };
    if (mode === 'ai') {
      const problem = aiProblem();
      if (problem) throw new ScraperError('not_available', problem, { status: 503 });
      if (engine === 'browser') throw new ScraperError('invalid_request', 'The AI Scraper fetches Reddit on the server (API keys or public pages) or through RedditAPIs.com, not through a browser tab.', { status: 400 });
      const goal = normalizeGoal(body.goal);
      options.ai = Object.assign(normalizeAiOptions(body.ai), { goal });
      const capacity = Math.min(config.maxItems, options.ai.maxPosts * (1 + options.ai.commentsPerPost));
      return Object.assign({ mode, target: null, options, capacity, label: 'AI: ' + (goal.length > 70 ? goal.slice(0, 69) + '…' : goal) }, engineSpec);
    }
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

  router.get('/status', (req, res) => res.json(status(req)));
  router.get('/network', (req, res) => res.json({ providers: transport.publicStatus() }));

  // ── Administrators: network diagnostics and queue health ──
  // Still no credentials: proxies are shown as scheme://host:port.
  const admin = express.Router();
  admin.use(adminGuard);
  admin.get('/network', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(Object.assign(transport.adminStatus(), { jobs: jobs.stats(), warnings: config.warnings.filter(w => /SCRAPER_(PROXY|VPN|NETWORK)/.test(w)) }));
  });
  admin.post('/network/:id/check', async (req, res) => {
    try {
      const r = await transport.checkHealth(String(req.params.id));
      if (r === null) throw new ScraperError('invalid_request', 'That provider has no health check (only a VPN gateway with SCRAPER_VPN_GATEWAY_HEALTH_URL or _IP_URL has one). Use "Test route" instead.', { status: 400 });
      res.json({ health: r, providers: transport.publicStatus() });
    } catch (err) { sendError(res, err); }
  });
  // A real request through one route, to a small allow-listed page: does the route work end to end?
  admin.post('/network/:id/test', async (req, res) => {
    try {
      const r = await transport.test(String(req.params.id), { url: 'https://www.reddit.com/robots.txt', headers: { 'user-agent': config.userAgent, accept: 'text/plain' } });
      if (r === null) throw new ScraperError('not_found', 'No such network provider.', { status: 404 });
      res.json({ test: r, providers: transport.publicStatus() });
    } catch (err) { sendError(res, err); }
  });
  admin.post('/network/:id/reset', (req, res) => {
    if (!transport.reset(String(req.params.id))) return sendError(res, new ScraperError('not_found', 'No such network provider.', { status: 404 }));
    res.json({ providers: transport.publicStatus() });
  });
  router.use('/admin', admin);

  if (policy) {
    router.use((req, res, next) => {
      Promise.resolve(policy.use(req)).then(e => {
        if (!e) return next();
        res.status(e.status).json({ error: Object.assign({ message: e.message, type: e.type }, e.extra || {}) });
      }, err => sendError(res, err));
    });
  }


  router.post('/resolve', (req, res) => {
    try {
      res.json({ target: normalizeTarget(req.body && req.body.target) });
    } catch (err) { sendError(res, err); }
  });

  // ── Reddit API access: checking a user's own keys ──
  // The page keeps keys in the user's browser and sends them with that
  // browser's jobs; these routes only ask Reddit (or RedditAPIs.com) whether
  // they work. Nothing is saved on the server, and the server's own keys can
  // only be set in .env.
  // Each check reaches out to Reddit / RedditAPIs.com, so they're capped: this
  // server shouldn't be usable to try out lots of keys, or to hammer Reddit's
  // sign-in endpoint from its address. Per browser and for the whole server.
  const CHECKS_PER_BROWSER = 5, CHECKS_PER_SERVER = 30, CHECK_WINDOW_MS = 60000;
  let recentChecks = [];
  const checksByBrowser = new Map();
  function allowCheck(req) {
    const now = Date.now();
    const recent = list => list.filter(t => now - t < CHECK_WINDOW_MS);
    recentChecks = recent(recentChecks);
    const who = ownerOf(req) || 'no-cookie';
    const mine = recent(checksByBrowser.get(who) || []);
    if (recentChecks.length >= CHECKS_PER_SERVER || mine.length >= CHECKS_PER_BROWSER) {
      throw new ScraperError('rate_limited', 'Too many key checks in the last minute. Wait a minute and try again.', { status: 429 });
    }
    recentChecks.push(now);
    mine.push(now);
    if (checksByBrowser.size > 5000) checksByBrowser.clear();
    checksByBrowser.set(who, mine);
  }

  router.post('/credentials/check', async (req, res) => {
    try {
      let creds;
      try { creds = credentials.validate(req.body); } catch (e) { throw new ScraperError('invalid_request', e.message, { status: 400 }); }
      allowCheck(req);
      try {
        await ownRedditClient(creds).getToken({ retries: 1 });   // the token is reused by this user's jobs
      } catch (err) {
        const e = isScraperError(err) ? err : new ScraperError('network', 'Couldn\'t reach Reddit to check the keys.', { status: 502 });
        throw new ScraperError(e.type, 'Reddit didn\'t accept these keys: ' + e.message, { status: e.type === 'auth_error' ? 400 : 502 });
      }
      res.json({ ok: true, clientIdHint: '…' + creds.clientId.slice(-4), username: creds.username });
    } catch (err) { sendError(res, err); }
  });

  router.post('/redditapis-key/check', async (req, res) => {
    try {
      let key;
      try { key = credentials.validateRedditApisKey(req.body && req.body.key); } catch (e) { throw new ScraperError('invalid_request', e.message, { status: 400 }); }
      allowCheck(req);
      let account;
      try {
        account = await ownRedditApisClient(key).account();
      } catch (err) {
        const e = isScraperError(err) ? err : new ScraperError('network', 'Couldn\'t reach RedditAPIs.com to check the key.', { status: 502 });
        throw new ScraperError(e.type, 'The key didn\'t work: ' + e.message, { status: e.type === 'auth_error' ? 400 : 502 });
      }
      res.json({ ok: true, keyHint: '…' + key.slice(-4), balance: balanceOf(account) });
    } catch (err) { sendError(res, err); }
  });

  // Earlier versions saved keys on the server from the page, where on a public
  // server any visitor could replace or remove them. A page from before the
  // update gets told to reload.
  const keysMoved = (req, res) => sendError(res, new ScraperError('invalid_state',
    'Reddit API keys are now kept in each browser, not on the server. Reload the page and add them under Reddit API access.', { status: 410 }));
  router.post('/credentials', keysMoved);
  router.delete('/credentials', keysMoved);
  router.post('/redditapis-key', keysMoved);
  router.delete('/redditapis-key', keysMoved);

  // Newest first; ?limit (default 100) and ?before=<createdAt of the last one> page through the rest
  router.get('/jobs', (req, res) => {
    const owner = ownerOf(req);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const mine = jobs.list().filter(j => (j.owner || null) === owner && (!before || j.createdAt < before));
    const page = mine.slice(0, limit);
    res.json({ jobs: page.map(j => jobs.summary(j)), next: mine.length > limit ? page[page.length - 1].createdAt : null });
  });

  router.post('/jobs', async (req, res) => {
    try {
      const spec = parseSpec(req.body);
      spec.owner = ownerOf(req);
      if (policy) {
        const running = jobs.list().filter(j => (j.owner || null) === spec.owner && ACTIVE.has(j.status)).length;
        const e = await policy.job(req, spec, { running });
        if (e) return res.status(e.status).json({ error: Object.assign({ message: e.message, type: e.type }, e.extra || {}) });
      }
      const job = jobs.create(spec);
      res.status(202).json({ job: jobs.summary(job) });
    } catch (err) { sendError(res, err); }
  });

  router.get('/jobs/:id', (req, res) => {
    try { res.json({ job: jobs.detail(findJob(req)) }); } catch (err) { sendError(res, err); }
  });

  // ?offset & ?limit page through the log lines (all of them without)
  router.get('/jobs/:id/logs', (req, res) => {
    try {
      const job = findJob(req);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const limit = req.query.limit === undefined ? job.logs.length : Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
      res.json({ logs: job.logs.slice(offset, offset + limit), dropped: job.logsDropped, total: job.logs.length, offset });
    } catch (err) { sendError(res, err); }
  });

  router.get('/jobs/:id/summary', (req, res) => {
    try { res.json({ summary: jobs.collectionSummary(findJob(req)) }); } catch (err) { sendError(res, err); }
  });

  router.get('/jobs/:id/history', (req, res) => {
    try {
      const job = findJob(req);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      res.json(Object.assign({ offset, limit }, jobs.events(job, offset, limit)));
    } catch (err) { sendError(res, err); }
  });

  router.post('/jobs/:id/pause', (req, res) => {
    try { const job = findJob(req); jobs.pause(job.id); res.json({ job: jobs.summary(job) }); } catch (err) { sendError(res, err); }
  });

  // Resume: the plan must still include the scraper and allow another job at
  // once; a job on the user's own keys needs them sent again.
  router.post('/jobs/:id/resume', async (req, res) => {
    try {
      const job = findJob(req);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      let httpFor;
      if (job.mode === 'platform') {
        const cred = platforms.resumeCredential(job, body);
        if (cred) httpFor = () => cred;
        else if (job.keySource === 'own' && (job.pausedReason === 'needs_keys' || !job.http)) {
          throw new ScraperError('invalid_request', 'This job used your own ' + (job.target.platform === 'x' ? 'X bearer token' : 'YouTube API key') + ', which isn\'t kept on the server. Add it again on the Scraper page and press Resume there.', { status: 400 });
        }
      } else if (job.keySource === 'own' || (job.engine === 'redditapis' && !config.redditApisKey)) {
        if (job.engine === 'redditapis' && body.redditApisKey) {
          let key;
          try { key = credentials.validateRedditApisKey(body.redditApisKey); } catch (e) { throw new ScraperError('invalid_request', 'Your RedditAPIs.com key: ' + e.message, { status: 400 }); }
          const c = ownRedditApisClient(key); httpFor = () => c;
        } else if (job.engine === 'server' && body.credentials) {
          let creds;
          try { creds = credentials.validate(body.credentials); } catch (e) { throw new ScraperError('invalid_request', 'Your Reddit API keys: ' + e.message, { status: 400 }); }
          const c = ownRedditClient(creds); httpFor = () => c;
        } else if (job.pausedReason === 'needs_keys') {
          throw new ScraperError('invalid_request', 'This job used your own API keys, which aren\'t kept on the server. Add them under Reddit API access on the Scraper page and press Resume there.', { status: 400 });
        }
      } else if (job.engine === 'browser') {
        httpFor = browserHttpFor;
      }
      if (policy && policy.resume) {
        const running = jobs.list().filter(j => (j.owner || null) === job.owner && ACTIVE.has(j.status) && j !== job).length;
        const e = await policy.resume(req, job, { running });
        if (e) return res.status(e.status).json({ error: Object.assign({ message: e.message, type: e.type }, e.extra || {}) });
      }
      jobs.resume(job.id, { httpFor });
      res.json({ job: jobs.summary(job) });
    } catch (err) { sendError(res, err); }
  });

  router.patch('/jobs/:id', (req, res) => {
    try {
      const job = findJob(req);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const floor = job.engine === 'redditapis' || job.keySource === 'own' || http.mode === 'oauth' ? config.minDelayMs : Math.max(config.minDelayMs, config.publicMinDelayMs);
      jobs.reconfigure(job.id, { delayMs: body.delayMs, maxItems: body.maxItems, maxPages: body.maxPages }, { minDelayMs: floor, maxPages: config.maxPages });
      res.json({ job: jobs.summary(job) });
    } catch (err) { sendError(res, err); }
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
      const all = jobs.recordsOf(job);
      const records = type === 'all' ? all : all.filter(r => r.record_type === type);
      const base = (job.mode === 'platform' ? job.target.platform : 'reddit') + '_' + (job.target && (job.target.subreddit || job.target.username || job.target.postId || job.target.query || job.target.type) || 'custom')
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
    const owner = ownerOf(req);
    const onRequest = r => { if (relay.allowed(r, owner)) write('relay', r); };
    const onCancel = c => write('relay-cancel', c);
    relay.subscribe(owner);
    write('ready', { allowedHosts: config.apiHosts });
    relay.unclaimed(owner).forEach(onRequest);
    relay.on('request', onRequest);
    relay.on('cancel', onCancel);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    let closed = false;
    req.on('close', () => {
      if (closed) return;
      closed = true;
      relay.unsubscribe(owner);
      clearInterval(heartbeat);
      relay.off('request', onRequest);
      relay.off('cancel', onCancel);
    });
  });

  router.post('/relay/:rid/claim', (req, res) => {
    const jobOwner = relay.ownerOfRequest(String(req.params.rid));
    if (jobOwner && jobOwner !== ownerOf(req)) return sendError(res, new ScraperError('invalid_state', 'Another tab is already handling this request, or it has ended.', { status: 409 }));
    const request = relay.claim(String(req.params.rid));
    if (!request) return sendError(res, new ScraperError('invalid_state', 'Another tab is already handling this request, or it has ended.', { status: 409 }));
    res.json({ request });
  });

  router.post('/relay/:rid', (req, res) => {
    const jobOwner = relay.ownerOfRequest(String(req.params.rid));
    if (jobOwner && jobOwner !== ownerOf(req)) return sendError(res, new ScraperError('invalid_state', 'This request has already ended.', { status: 409 }));
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
    config, http, jobs, relay, router, scramjetRouter, onUpgrade, status, wispPlainHttp: plainHttpHandler,
    // Signing in: a browser's running and finished jobs move to the account
    reassignOwner(from, to) {
      let n = 0;
      if (from && to && from !== to) jobs.list().forEach(j => { if (j.owner === from) { j.owner = to; n++; } });
      return n;
    },
    setPort(p) {
      port = p;
      transport.choose().catch(() => {});
      transport.startHealthChecks();
      // Jobs saved before a restart continue once the server can make requests
      if (!recovered) {
        try { recovered = jobs.recover(); } catch (e) { console.error('[scraper] Couldn\'t load saved jobs: ' + sanitize(e && e.message, 200)); recovered = { error: true }; }
      }
    },
    network: transport,
    shutdown() {
      jobs.shutdown();
      transport.close();
    }
  };
}

module.exports = { createScraper };
