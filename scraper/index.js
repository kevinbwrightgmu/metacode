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
const { HostRateLimiter } = require('./network/rate-limiter');
const { RedditHttpClient } = require('./network/reddit-http');
const { normalizeTarget, normalizeOptions } = require('./reddit/targets');
const { runStandardScrape } = require('./reddit/standard-scraper');
const { JobManager, FINISHED } = require('./jobs/job-manager');
const { createCustomRunner, sandboxSupported, validateCode } = require('./sandbox/custom-runner');
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
  let port = null;
  const getWispUrl = () => (port ? 'ws://127.0.0.1:' + port + WISP_PATH : null);

  const transport = opts.transport || new EpoxyWispTransport({ getWispUrl, userAgent: config.userAgent, maxResponseBytes: config.maxResponseBytes });
  const limiter = new HostRateLimiter({ maxConcurrent: config.maxConcurrentRequests });
  const http = new RedditHttpClient({ config, transport, limiter });
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

  function status() {
    const sandbox = sandboxSupported();
    const floor = http.mode === 'oauth' ? config.minDelayMs : Math.max(config.minDelayMs, config.publicMinDelayMs);
    return {
      enabled: config.enabled,
      mode: http.mode,
      oauthConfigured: !!config.oauth,
      respectRobotsTxt: config.respectRobotsTxt,
      userAgent: config.userAgent,
      userAgentIsDefault: !process.env.SCRAPER_USER_AGENT,
      transport: {
        name: 'epoxy-tls over Wisp',
        available: transportAvailable(),
        epoxyVersion: transport.info ? transport.info.version : null,
        wispPath: WISP_PATH
      },
      allowedHosts: config.apiHosts,
      customCode: {
        enabled: config.customCodeEnabled,
        available: config.customCodeEnabled && sandbox.ok,
        reason: !config.customCodeEnabled ? 'Custom code is turned off (SCRAPER_CUSTOM_CODE_ENABLED=false).' : (sandbox.ok ? null : sandbox.reason),
        timeoutMs: config.customTimeoutMs,
        memoryMb: config.customMemoryMb,
        languages: ['javascript', 'typescript']
      },
      browser: { enabled: config.enabled && config.browserEnabled },
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
    const options = normalizeOptions(body.options, config);
    if (mode === 'standard') {
      const target = normalizeTarget(body.target);
      return { mode, target, options, capacity: capacityFor(target, options) };
    }
    if (!config.customCodeEnabled) throw new ScraperError('not_available', 'Custom code is turned off on this server (SCRAPER_CUSTOM_CODE_ENABLED=false).', { status: 403 });
    const support = sandboxSupported();
    if (!support.ok) throw new ScraperError('not_available', support.reason, { status: 503 });
    const language = body.language === 'typescript' ? 'typescript' : (body.language === undefined || body.language === 'javascript' ? 'javascript' : body.language);
    validateCode(body.code, language);
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
    return { mode, target, options, code: body.code, language, params, label: target ? 'Custom: ' + target.label : 'Custom scraper' };
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
    config, http, jobs, router, scramjetRouter, onUpgrade, status,
    setPort(p) { port = p; },
    shutdown() { jobs.shutdown(); }
  };
}

module.exports = { createScraper };
