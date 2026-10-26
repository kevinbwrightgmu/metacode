const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { spawn } = require('child_process');
// Read the settings file (.env): next to server.js, the folder the server was
// started from, or the folder above; UTF-16 files and ".env.txt" work too, and
// its values win over stale system variables. See env-file.js.
const { createEnvLoader } = require('./env-file');
const envLoader = createEnvLoader(__dirname);
envLoader.load();

const { createScraper } = require('./scraper');
const { ScraperError, cancelledError } = require('./scraper/errors');
const { createSurveys } = require('./surveys');
const { createAccounts } = require('./accounts');
const { createProjects } = require('./projects');
const { rankSimilar, renamedModel, sameModel, canonicalId, splitModel } = require('./model-match');
const { createStatusMonitor, statusRoutes } = require('./status-page');

const app = express();

// Behind a reverse proxy (nginx, Caddy, Cloudflare…) the visitor's address is in
// X-Forwarded-For, which anyone can also send directly. TRUST_PROXY says which
// proxy to believe, so req.ip is the real visitor (used for survey rate limits and,
// when a survey collects it, the respondent's IP address): a number of proxy hops
// (1 = one proxy in front), "loopback" (a proxy on this machine), or a list of
// proxy addresses/CIDR ranges. Unset: forwarded headers are ignored.
(function trustProxy(raw) {
  const v = String(raw || '').trim();
  if (!v) return;
  if (/^\d+$/.test(v)) app.set('trust proxy', Number(v));
  else if (/^(true|yes|on)$/i.test(v)) app.set('trust proxy', 1);
  else app.set('trust proxy', v.split(',').map(x => x.trim()).filter(Boolean));
})(process.env.TRUST_PROXY);

// status.metac0.de (any status.* host): only the status page and its data;
// anything else on that host goes to the main site. See status-page.js.
const statusSite = statusRoutes({ publicDir: path.join(__dirname, 'public') });
app.use(statusSite.hostRouter);

// The AI routes spend the AI providers' quota of the key(s) set up for this server,
// and the scraper routes make requests to Reddit on this server's behalf, so
// only MetaCode's own pages (same origin) may call them. The other routes
// keep the permissive CORS they always had.
const AI_ROUTE   = /^\/api\/(ai(\/batch)?|models|keys\/status|settings\/(status|reload)|projects(\/.*)?|scraper(\/.*)?|surveys(\/.*)?|public\/surveys(\/.*)?|account(\/.*)?|billing\/(checkout|portal|sync)|network\/analyze|lab(\/.*)?|desktop(\/.*)?|collab(\/.*)?)\/?$/i;
const corsForAll = cors();
app.use((req, res, next) => (AI_ROUTE.test(req.path) ? next() : corsForAll(req, res, next)));
// …and state-changing requests to them must say they come from this site:
// an Origin from another host, or a cross-site Sec-Fetch-Site, is refused
// (a body-less POST such as "Reload .env" wouldn't otherwise need CORS).
app.use((req, res, next) => {
  if (!AI_ROUTE.test(req.path) || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  let crossSite = false;
  if (req.headers.origin) { try { crossSite = new URL(req.headers.origin).host !== req.headers.host; } catch (e) { crossSite = true; } }
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) crossSite = true;
  if (crossSite) return res.status(403).json({ error: { type: 'forbidden_origin', message: 'Requests from other websites aren\'t allowed.' } });
  next();
});
// Accounts, plans and limits (accounts/; off unless SUPABASE_URL and
// SUPABASE_PUBLISHABLE_KEY are set). The Stripe webhook needs the raw body for
// its signature, so it comes before any JSON parser. Every other /api request
// learns who is signed in (a token verified with Supabase) before its route runs.
const accounts = createAccounts();
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => accounts.webhook(req, res));
app.use('/api', (req, res, next) => (/^\/(public\/|status|health)/.test(req.path) ? next() : accounts.attach(req, res, next)));
app.use('/api/account', accounts.router);
app.use('/api/billing', accounts.billingRouter);
// The browser's Supabase client (account.js), served from this site
app.get('/vendor/supabase.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('@supabase/supabase-js/dist/umd/supabase.js'));
});
// CodeMirror 6 for the AI Coding Lab's code editor (public/js/ai-lab/lab-editor.mjs).
// The packages are ES modules only; the import map in ai-lab.html points each
// bare specifier here. Only this fixed list of files is served, each from its
// installed package's folder (never a path from the request).
const CODEMIRROR_FILES = new Map([
  ['codemirror.js', ['codemirror', 'dist/index.js']],
  ['state.js', ['@codemirror/state', 'dist/index.js']],
  ['view.js', ['@codemirror/view', 'dist/index.js']],
  ['language.js', ['@codemirror/language', 'dist/index.js']],
  ['commands.js', ['@codemirror/commands', 'dist/index.js']],
  ['search.js', ['@codemirror/search', 'dist/index.js']],
  ['autocomplete.js', ['@codemirror/autocomplete', 'dist/index.js']],
  ['lint.js', ['@codemirror/lint', 'dist/index.js']],
  ['lang-javascript.js', ['@codemirror/lang-javascript', 'dist/index.js']],
  ['lang-python.js', ['@codemirror/lang-python', 'dist/index.js']],
  ['merge.js', ['@codemirror/merge', 'dist/index.js']],
  ['streamparser.js', ['@codemirror/streamparser', 'dist/index.js']],
  ['lezer-common.js', ['@lezer/common', 'dist/index.js']],
  ['lezer-highlight.js', ['@lezer/highlight', 'dist/index.js']],
  ['lezer-lr.js', ['@lezer/lr', 'dist/index.js']],
  ['lezer-javascript.js', ['@lezer/javascript', 'dist/index.js']],
  ['lezer-python.js', ['@lezer/python', 'dist/index.js']],
  ['style-mod.js', ['style-mod', 'src/style-mod.js']],
  ['w3c-keyname.js', ['w3c-keyname', 'index.js']],
  ['crelt.js', ['crelt', 'index.js']],
  ['find-cluster-break.js', ['@marijn/find-cluster-break', 'src/index.js']]
]);
const codemirrorPaths = new Map();   // file → absolute path (null: package not installed)
function codemirrorPath(file) {
  if (!codemirrorPaths.has(file)) {
    const [pkg, rel] = CODEMIRROR_FILES.get(file);
    // The package folder from node_modules' search paths (their "exports" maps don't expose package.json)
    const dir = (require.resolve.paths(pkg) || []).map(d => path.join(d, pkg)).find(d => {
      try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === pkg; } catch (e) { return false; }
    });
    codemirrorPaths.set(file, dir ? path.join(dir, rel) : null);
  }
  return codemirrorPaths.get(file);
}
app.get('/vendor/cm/:file', (req, res) => {
  const file = CODEMIRROR_FILES.has(req.params.file) ? codemirrorPath(req.params.file) : null;
  if (!file) return res.status(404).type('text/plain').send('Not found');
  res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(file, err => { if (err && !res.headersSent) { res.removeHeader('Cache-Control'); res.status(404).type('text/plain').send('Not found'); } });
});
// Survey Studio (surveys/): mounted before the shared JSON parser because
// survey documents (with embedded images) may be larger than its limit.
const surveys = createSurveys({ policy: accounts.surveysPolicy });
app.use('/api/surveys', surveys.router);
app.use('/api/public/surveys', surveys.publicRouter);
app.get('/s/:publicId', surveys.pageHandler);
// Saved projects (Projects page) — also before the shared JSON parser (large projects)
const projects = createProjects();
app.use('/api/projects', projects.router);
// Shared projects: members, roles, invitations, live updates and chat (collab/)
const { createCollab } = require('./collab');
const collab = createCollab({ accounts, publicUrl: () => accounts.config().publicUrl || null });
app.use('/api/collab', collab.router);
// The shared JSON parser — not for the AI Coding Lab, which reads its own bodies
// (25 MB for imports and documents, 10 MB otherwise: ai-lab/index.js)
const jsonBody = express.json({ limit: '10mb' });
app.use((req, res, next) => (/^\/api\/lab(\/|$)/.test(req.path) ? next() : jsonBody(req, res, next)));
app.get('/status', statusSite.page);   // the status page on the main site too
// Pages, scripts and styles are revalidated on every load, so an updated
// MetaCode is never run with yesterday's cached JavaScript.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) { if (/\.(html|js|css|mjs)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache'); }
}));

// AI Scraper (beta) (collector/): a React + Vite app that starts AI jobs
// (/api/scraper, mode "ai") and keeps what they collect in the browser. It's
// built into collector/dist (npm run collector:build) and served here.
const COLLECTOR_DIST = path.join(__dirname, 'collector', 'dist');
app.get('/collector', (req, res, next) => (req.path.endsWith('/') ? next() : res.redirect(301, '/collector/')));
app.use('/collector', express.static(COLLECTOR_DIST, {
  setHeaders(res, file) { res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'); }
}));
app.get('/collector/*', (req, res) => {
  res.status(503).type('text/plain').send('The AI Scraper isn\'t built yet. In the MetaCode folder run:\n\n  npm run collector:install\n  npm run collector:build\n\nthen reload this page.');
});

// ── AI service: MetaCode's OpenCode service ───────────────────────────────────
// Every AI feature (AI Coding, the MetaCode Assistant, column detection in
// Import Data and Analyze CSV, Test Connection, the AI Scraper, the AI Coding
// Lab, the desktop app) posts to /api/ai on this server or goes through
// scraperAi / labAi below. MetaCode forwards each request to its OpenCode
// service, a separate process beside it (opencode/server.mjs, see
// docs/opencode-service.md), which answers from the AI providers it is set up
// for (OpenCode Zen, the AI gateway):
//
//   browser → POST /api/ai → POST {OPENCODE_SERVICE_URL}/chat/completions → a provider
//
// The service owns everything provider-specific: keys, quotas, model catalogs,
// the protocol of each model. MetaCode keeps what is the same for any
// provider: checking requests, reading replies, streaming, choosing models and
// switching to the closest one, batches, metering and the status pages.
// MetaCode reaches the service directly (never through a proxy) with the
// service's access token (OPENCODE_SERVICE_TOKEN, or the token file both
// read: opencode/shared.js). The browser never sees the service, its token or
// any provider key, and nothing here logs them or puts them in an error.
//
// OPENCODE_SERVICE_URL=off switches MetaCode's AI off. MetaCode starts the
// service itself when nothing answers at the default address (see
// opencode/supervisor.js and OPENCODE_SERVICE_MANAGED).

const shared = require('./opencode/shared');
const { createSupervisor } = require('./opencode/supervisor');

const DEFAULT_TIMEOUT_MS    = 120 * 1000;
const MODEL_LIST_TTL_MS     = 30 * 1000;                 // the service keeps the providers' own lists; this only spares it repeated calls
const MODEL_LIST_TIMEOUT_MS = 20 * 1000;
const MODEL_LIST_RETRY_MS   = 5 * 1000;                  // after a failed fetch, wait this long before trying again
const STATUS_TIMEOUT_MS     = 3 * 1000;                  // GET /v1/status (readiness)
const DEFAULT_PAUSE_SEC     = 30;                        // a provider that asked to pause without saying for how long
const MAX_COOLDOWN_MS       = 400 * 24 * 3600 * 1000;    // reset times further out than this are ignored as bogus
const MODEL_COOLDOWN_MS     = 60 * 1000;                 // a rate-limited model rests this long (doubling while it keeps happening)
const MODEL_COOLDOWN_MAX_MS = 15 * 60 * 1000;
const MAX_RATE_LIMIT_SWITCHES = 4;                       // similar models tried for one request when models are rate-limited

// Model ids end up in the Settings dropdown, so only plain ids are accepted
// (letters, digits and . _ - : / @ + #), never markup. OpenCode ids are
// "provider/model", optionally "#variant".
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+#-]{0,199}$/;
function safeModelId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return MODEL_ID_PATTERN.test(id) ? id : null;
}

let AI = loadAiConfig(process.env);   // replaced when .env is reloaded (see /api/settings/reload)

// The first of these variables that is set (the EMIS_* ones are older names)
function firstSet(env, names) {
  return names.find(n => env[n] !== undefined && String(env[n]).trim() !== '') || null;
}

// → { off, url, baseHost, custom, managed, model, modelVar, timeoutMs, switching, freeFallback, settings, problem, warnings }
function loadAiConfig(env) {
  const settings = shared.serviceSettings(env);
  const config = { off: false, url: null, baseHost: null, custom: false, managed: 'auto', model: '', modelVar: null,
    timeoutMs: DEFAULT_TIMEOUT_MS, switching: true, freeFallback: false, settings, problem: null, warnings: [] };

  const managed = String(env.OPENCODE_SERVICE_MANAGED || '').trim().toLowerCase();
  if (managed === 'on' || managed === 'always' || shared.isOn(managed)) config.managed = 'on';
  else if (shared.isOff(managed)) config.managed = 'off';
  else if (managed && managed !== 'auto') config.warnings.push('OPENCODE_SERVICE_MANAGED must be auto, on or off; using auto.');

  const modelVar = firstSet(env, ['OPENCODE_MODEL', 'EMIS_MODEL']);
  const model = modelVar ? String(env[modelVar]).trim() : '';
  if (model && !safeModelId(model)) config.warnings.push(modelVar + ' is not a valid model id, so it was ignored.');
  config.model = safeModelId(model) || '';
  config.modelVar = config.model ? modelVar : null;

  const timeoutVar = firstSet(env, ['AI_TIMEOUT_MS', 'EMIS_TIMEOUT_MS']);
  if (timeoutVar) {
    const ms = Number(env[timeoutVar]);
    if (Number.isInteger(ms) && ms >= 1000 && ms <= 600000) config.timeoutMs = ms;
    else config.warnings.push(timeoutVar + ' must be a whole number of milliseconds between 1000 and 600000; using ' + DEFAULT_TIMEOUT_MS + '.');
  }
  const switchVar = firstSet(env, ['AI_MODEL_SWITCH', 'EMIS_MODEL_SWITCH']);
  config.switching = !(switchVar && shared.isOff(env[switchVar]));
  // AI_FALLBACK_TO_FREE_MODELS=on: a free model may answer for one that isn't free (see closestModel)
  const freeVar = firstSet(env, ['AI_FALLBACK_TO_FREE_MODELS']);
  config.freeFallback = !!(freeVar && shared.isOn(env[freeVar]));

  const rawUrl = String(env.OPENCODE_SERVICE_URL || '').trim();
  if (rawUrl && shared.isOff(rawUrl)) { config.off = true; return config; }
  settings.warnings.filter(w => /OPENCODE_SERVICE_TOKEN/.test(w)).forEach(w => config.warnings.push(w));
  if (!rawUrl) {
    // the default: where opencode/server.mjs listens with the same .env
    config.url = settings.url;
    if (settings.problems.length) config.problem = settings.problems[0];
    settings.warnings.filter(w => !/OPENCODE_SERVICE_TOKEN/.test(w)).forEach(w => config.warnings.push(w));
  } else {
    config.custom = true;
    let url = null;
    try { url = new URL(rawUrl); } catch (e) { url = null; }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      config.problem = 'OPENCODE_SERVICE_URL in the server\'s .env file is not a valid http(s) URL.';
    } else {
      config.url = (url.origin + url.pathname).replace(/\/+$/, '');
      // (the default address written out is still the default: MetaCode may start the service there)
      if (config.url === settings.url) config.custom = false;
      if (!/\/v1$/.test(config.url)) config.warnings.push('OPENCODE_SERVICE_URL normally ends in /v1 (default: ' + settings.url + ').');
      if (url.protocol === 'http:' && !shared.isLoopback(url.hostname)) {
        config.warnings.push('OPENCODE_SERVICE_URL uses plain http to another machine, so MetaCode\'s requests (and the service\'s access token) travel unencrypted. Use https, or run the service on this machine.');
      }
    }
  }
  if (config.url) { try { config.baseHost = new URL(config.url).host; } catch (e) { config.baseHost = null; } }
  return config;
}

// The service's access token: OPENCODE_SERVICE_TOKEN, else the token file in
// OPENCODE_SERVICE_DATA_DIR (created when it's missing). Read when first
// needed, and again when the service refuses it (it may have a new one).
let serviceTokenCache = null;
function serviceToken() {
  if (!serviceTokenCache) serviceTokenCache = shared.readOrCreateToken(AI.settings.dataDir, AI.settings.tokenFromEnv);
  return serviceTokenCache;
}
// → true when a fresh read gives a different token than the one refused
function tokenChanged() {
  const before = serviceTokenCache;
  serviceTokenCache = null;
  try { return serviceToken() !== before; } catch (e) { return false; }
}

// Strips anything secret-looking from text that came from the AI service, a
// stand-in for it or an exception before it's logged or shown: the service's
// token, bearer tokens, keys (emis-…, sk-…), and URLs (which could reveal
// internal infrastructure).
function redact(text, max) {
  let s = String(text === undefined || text === null ? '' : text);
  if (serviceTokenCache) s = s.split(serviceTokenCache).join('[redacted]');
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
       .replace(/\bemis-(?!models\b)[A-Za-z0-9._~+/=-]+/gi, '[redacted key]')
       .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted key]')
       .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]')
       .replace(/[\u0000-\u001F\u007F]+/g, ' ')
       .replace(/\s{2,}/g, ' ')
       .trim();
  const limit = max || 300;
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}
// The service's own texts (written for MetaCode's operator, host names only):
// shown as they are, short, without control characters
function plainText(value, max) {
  if (typeof value !== 'string') return null;
  let s = value;
  if (serviceTokenCache) s = s.split(serviceTokenCache).join('[redacted]');
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const limit = max || 400;
  return s ? (s.length > limit ? s.slice(0, limit - 1) + '…' : s) : null;
}

// ── Rate-limited models ───────────────────────────────────────────────────────
// A 429 from the service says what is limited. scope "model": the provider
// is throttling that one model, so the model rests and requests for it are
// answered by the closest similar model (closestModel, model-match.js) until
// it's back; a model that keeps getting limited rests longer each time (1, 2,
// 4… up to 15 minutes, or what Retry-After says). scope "provider": the whole
// provider can't be used for a while (see "Resting providers" below).
// AI_MODEL_SWITCH=off in .env turns switching off; each browser can also
// turn it off (Settings → AI models). A free model never answers for one that
// isn't free unless AI_FALLBACK_TO_FREE_MODELS=on (see closestModel).

// model -> { until, hits, lastAt }
const modelLimits = new Map();

function modelRestingUntil(model, now) {
  const st = modelLimits.get(model);
  return st && st.until > now ? st.until : 0;
}
function restingModels(now) {
  return Array.from(modelLimits.entries()).filter(([, st]) => st.until > now).map(([model, st]) => ({ model, until: st.until }));
}
// How messages name a model: its name and provider from the service's list ("Claude Opus 5.5 (AI gateway)"), else its id
function modelName(id) {
  const info = modelList.result && modelList.result.info.get(id);
  if (!info || !info.named) return id;
  return info.name + (info.providerName ? ' (' + info.providerName + ')' : '');
}
function modelLimitedFailure(model, until, now) {
  const f = fail(429, 'model_rate_limited', 'The AI service is rate-limiting the model "' + modelName(model) + '" right now. It can be used again ' + describeWhen(until, now) + '.');
  f.retryAfterSeconds = Math.max(1, Math.ceil((until - now) / 1000));
  f.model = model;
  return f;
}
// waitMs: how long the service said to wait (Retry-After), or null
function onModelLimited(model, waitMs, now) {
  const st = modelLimits.get(model) || { until: 0, hits: 0, lastAt: 0 };
  st.hits = now - st.lastAt < MODEL_COOLDOWN_MAX_MS * 2 ? st.hits + 1 : 1;
  st.lastAt = now;
  const backoff = Math.min(MODEL_COOLDOWN_MAX_MS, MODEL_COOLDOWN_MS * 2 ** Math.min(st.hits - 1, 6));
  st.until = Math.max(st.until, now + (waitMs !== null && waitMs !== undefined ? Math.min(MODEL_COOLDOWN_MAX_MS, Math.max(1000, waitMs)) : backoff));
  modelLimits.set(model, st);
  console.warn('[ai] The AI service rate-limited the model "' + model + '"; it rests until ' + new Date(st.until).toLocaleTimeString() +
    (switchingAllowed() ? ' and requests for it use the closest similar model.' : '.'));
  return modelLimitedFailure(model, st.until, now);
}
function switchingAllowed() { return AI.switching; }

// ── Resting providers ─────────────────────────────────────────────────────────
// The service also says when a whole provider can't be used for a while: its
// budget is used up (quota_exceeded: OpenCode Zen's free-model limit, every
// gateway key's quota) or it asked to pause (rate_limited with scope
// "provider"). Until the time the service gave, MetaCode doesn't send that
// provider's models: requests for them are answered at once, or — with
// switching on — by the closest model of another provider, like a
// rate-limited model. The provider of a model is the part of its id before
// the first "/" ('' for ids without one).
const providerRest = new Map();    // provider -> { until, reason: 'quota' | 'paused', window, failure }
const PAUSE_EXPLAINS_MS = 20 * 1000;   // the service pauses a gateway key after 429s for 3 models within 20 s

const providerOf = id => splitModel(id).provider || '';
function providerRestingUntil(provider, now) {
  const st = providerRest.get(provider || '');
  return st && st.until > now ? st.until : 0;
}
function restingProviders(now) {
  return Array.from(providerRest.entries()).filter(([, st]) => st.until > now).map(([provider, st]) => ({ provider, until: st.until, reason: st.reason, window: st.window }));
}
function plausibleResetTime(resetAt, now) {
  return resetAt && resetAt > now && resetAt - now <= MAX_COOLDOWN_MS ? resetAt : null;
}
// (a quota_exceeded with scope "model" — one model's spend limit, the free models' limit with a key — rests only that model)
function isProviderLimit(f) {
  return !!f && f.status === 429 && (f.scope === 'provider' || (f.type === 'quota_exceeded' && f.scope !== 'model'));
}
function onProviderLimited(failure, model, now) {
  const provider = failure.provider || providerOf(model);
  // A provider that asked to pause explains the 429s its models got just before (the gateway pausing
  // the key, not each model): those models don't go on resting on their own after the pause
  if (failure.type !== 'quota_exceeded') {
    for (const [m, st] of modelLimits) if (providerOf(m) === provider && now - st.lastAt < PAUSE_EXPLAINS_MS) modelLimits.delete(m);
  }
  const resetAt = plausibleResetTime(Date.parse(failure.resetAt || ''), now);
  const until = resetAt || now + Math.min(MAX_COOLDOWN_MS, failure.retryAfterSeconds ? Math.max(1000, failure.retryAfterSeconds * 1000) : DEFAULT_PAUSE_SEC * 1000);
  const before = providerRest.get(provider);
  providerRest.set(provider, { until, reason: failure.type === 'quota_exceeded' ? 'quota' : 'paused', window: failure.window || null, failure });
  if (!before || before.until !== until) {
    console.warn('[ai] The AI service says ' + (provider ? 'the provider "' + provider + '"' : 'its provider') + ' can\'t be used until ' + new Date(until).toLocaleString() +
      (failure.type === 'quota_exceeded' ? ' (usage quota used up)' : ' (asked to pause)') + (switchingAllowed() ? '; requests for its models use the closest model of another provider.' : '.'));
  }
  return providerRestFailure(provider, now);
}
// The failure a resting provider's requests get, without asking the service again
function providerRestFailure(provider, now) {
  const st = providerRest.get(provider || '');
  return Object.assign({}, st.failure, { retryAfterSeconds: Math.max(1, Math.ceil((st.until - now) / 1000)), scope: 'provider', provider: provider || undefined });
}
// A 429 from the service: only this model (it rests; answerChat picks the closest one) or its whole provider
function onLimited(failure, model, now) {
  if (isProviderLimit(failure)) return onProviderLimited(failure, model, now);
  return onModelLimited(model, failure.retryAfterSeconds ? failure.retryAfterSeconds * 1000 : null, now);
}

// Server errors (HTTP 5xx): the provider can't run a model right now, or is
// having problems overall. aiRequest has already retried by then. The model
// that still failed rests a little (30 s, doubling while it keeps failing, up
// to 5 minutes): requests for the server's default model go straight to the
// closest similar model meanwhile, and failing models aren't picked as
// substitutes. When 3 different models of one provider fail within a minute,
// it's that provider as a whole: its other models aren't tried as substitutes,
// requests switch to another provider's models, and when none is left MetaCode
// says so (and AI Coding batches pause; see /api/ai/batch). An answer from
// one of the provider's models clears this. (Ids without a provider, from an
// older service, count as one provider: the service.)
const MODEL_DOWN_MS = 30 * 1000;
const MODEL_DOWN_MAX_MS = 5 * 60 * 1000;
const SERVICE_TROUBLE_WINDOW_MS = 60 * 1000;
const SERVICE_TROUBLE_MODELS = 3;
const modelDown = new Map();       // model -> { until, hits, lastAt }
let serverErrors = [];             // [{ model, at, status }], one per model, last minute

function modelDownUntil(model, now) {
  const st = modelDown.get(model);
  return st && st.until > now ? st.until : 0;
}
function onModelServerError(model, status, now) {
  if (!model) return;
  const st = modelDown.get(model) || { until: 0, hits: 0, lastAt: 0 };
  st.hits = now - st.lastAt < MODEL_DOWN_MAX_MS * 2 ? st.hits + 1 : 1;
  st.lastAt = now;
  st.until = now + Math.min(MODEL_DOWN_MAX_MS, MODEL_DOWN_MS * 2 ** Math.min(st.hits - 1, 6));
  modelDown.set(model, st);
  // (two spellings of one model's id, claude-opus-4-8 / claude-opus-4.8, are one model failing, not two)
  serverErrors = serverErrors.filter(e => now - e.at < SERVICE_TROUBLE_WINDOW_MS && canonicalId(e.model) !== canonicalId(model));
  serverErrors.push({ model, at: now, status: status || 502 });
  if (st.hits === 1) console.warn('[ai] The AI service answered with a server error (HTTP ' + (status || 502) + ') for the model "' + model + '" after retries; it rests until ' + new Date(st.until).toLocaleTimeString() + '.');
}
// How a model that is resting after server errors failed (for when it's skipped rather than tried again)
function modelDownFailure(model) {
  const e = serverErrors.find(x => x.model === model);
  const status = e ? e.status : 502;
  return Object.assign(fail(502, 'upstream_error', 'The AI service had a temporary server problem (HTTP ' + status + '). Try again in a moment.'), { upstreamStatus: status });
}
function onModelAnswered(model) {
  modelDown.delete(model);
  const provider = providerOf(model);
  serverErrors = provider ? serverErrors.filter(e => providerOf(e.model) !== provider) : [];
}
// → { models, status } while several models (of `provider`, when given) are failing with server errors, else null
function serviceTrouble(now, provider) {
  const recent = serverErrors.filter(e => now - e.at < SERVICE_TROUBLE_WINDOW_MS && (provider === undefined || providerOf(e.model) === provider));
  return recent.length >= SERVICE_TROUBLE_MODELS ? { models: recent.map(e => e.model), status: recent[recent.length - 1].status } : null;
}

// The available model most like `target` that can take this request (not
// rate-limited or failing, its provider not resting or failing as a whole,
// not tried yet, offered right now, supports what the request needs), or
// null. The same model from another provider comes first (rankSimilar). A
// free model never answers for one that isn't free (free models' providers
// may use the prompts to improve their models), unless the operator allows it
// (AI_FALLBACK_TO_FREE_MODELS=on); free for free is fine.
async function closestModel(target, chatRequest, tried) {
  const list = await getModelList(false);
  if (!list.ok) return null;
  const now = Date.now();
  const infoOf = id => list.info.get(id) || null;
  const isFree = id => !!(infoOf(id) && infoOf(id).free === true);
  // (a model with a reasoning variant, "…#high", is that model here)
  const base = splitVariant(target).base;
  const done = new Set(Array.from(tried, t => splitVariant(t).base));
  const freeOk = AI.freeFallback || isFree(base);
  const candidates = list.ids.filter(id => !done.has(id) && (freeOk || !isFree(id)) && !NOT_A_CHAT_MODEL.test(splitModel(id).model) && !modelRestingUntil(id, now) && !modelDownUntil(id, now) &&
    !providerRestingUntil(providerOf(id), now) && !serviceTrouble(now, providerOf(id)) && !(infoOf(id) && infoOf(id).available === false) && !capabilityProblem(chatRequest, infoOf(id)));
  // The same model under another spelling of its id (claude-opus-4-8 / claude-opus-4.8) as one
  // already tried is most likely limited or failing too: a different model first, other spellings last
  const ranked = rankSimilar(base, candidates, list.info);
  const triedAlready = id => [base, ...done].some(t => sameModel(t, id, list.info));
  return ranked.find(id => !triedAlready(id)) || ranked[0] || null;
}

const switchesLogged = new Map();
function noteSwitch(from, to, why) {
  const k = from + '>' + to, now = Date.now();
  if (now - (switchesLogged.get(k) || 0) < 60000) return;
  switchesLogged.set(k, now);
  console.warn('[ai] "' + from + '" ' + (why === 'rate_limited' ? 'is rate-limited' : 'failed') + '; answered with the closest model, "' + to + '".');
}

// ── Talking to the service ────────────────────────────────────────────────────
const TIMED_OUT   = new Error('AI request timed out');
const CLIENT_GONE = new Error('Browser disconnected');
const CANCELLED   = new Error('Request cancelled');

// Straight to the service: HTTPS_PROXY and the like are for the service's own
// requests to the providers, and a proxy would also see the access token.
// undici's own response timeouts (300 s) are off: AI_TIMEOUT_MS (up to 600 s)
// limits every request and every gap in a stream (TIMED_OUT below).
const undici = require('undici');
let serviceAgent = null;
function serviceDispatcher() {
  if (!serviceAgent) serviceAgent = new undici.Agent({ connect: { timeout: 10000 }, headersTimeout: 0, bodyTimeout: 0 });
  return serviceAgent;
}

// X-Request-Timeout-Ms: how long MetaCode waits, so the service gives up on
// the provider a little earlier and can still say why.
function serviceHeaders(token, accept, hasBody, timeoutMs) {
  const headers = { 'Authorization': 'Bearer ' + token, 'Accept': accept, 'X-Request-Timeout-Ms': String(timeoutMs) };
  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
}

// An AbortController that also aborts when `parentSignal` does.
function linkedAbort(parentSignal) {
  const controller = new AbortController();
  if (!parentSignal) return { controller, unlink() {} };
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return { controller, unlink() {} };
  }
  const onAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', onAbort, { once: true });
  return { controller, unlink: () => parentSignal.removeEventListener('abort', onAbort) };
}

// Watches for the browser going away before the response is finished, so the
// AI request can be cancelled instead of spending quota for nobody.
function watchClient(res) {
  const controller = new AbortController();
  const onClose = () => { if (!res.writableFinished) controller.abort(CLIENT_GONE); };
  res.on('close', onClose);
  return { signal: controller.signal, release: () => res.off('close', onClose) };
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return undefined; }   // undefined = not JSON
}

function transportFailure(err, signal) {
  if (signal.aborted) return { failed: signal.reason === TIMED_OUT ? 'timeout' : 'aborted' };
  const cause = err && err.cause ? err.cause : err;
  return { failed: 'network', code: String((cause && cause.code) || '') };
}

// The error the service answered with, when it is one of its own (§ error
// types in docs/opencode-service.md); null for anything else (an older
// service, or a stand-in that answers like a provider would).
const SERVICE_ERROR_TYPES = new Set(['invalid_request', 'unsupported_feature', 'authentication_error', 'permission_error', 'blocked', 'model_not_found',
  'not_configured', 'request_too_large', 'rate_limited', 'quota_exceeded', 'cancelled', 'upstream_error', 'malformed_response', 'network', 'timeout', 'internal_error']);
function serviceError(r) {
  const e = r && r.json && typeof r.json === 'object' && r.json.error && typeof r.json.error === 'object' ? r.json.error : null;
  return e && SERVICE_ERROR_TYPES.has(e.type) ? e : null;
}
// A 401 about MetaCode's access token (not a provider refusing its key)
function tokenRefused(r) {
  if (r.status !== 401) return false;
  const e = serviceError(r);
  return !e || !e.provider;
}

// Retries a call to the service that failed for a temporary reason (a dropped
// connection, a provider's server error 500/502/503/504, 408): up to 2 more
// tries, 0.6 s then 1.8 s apart. This is the only place AI requests are
// retried (the service never retries a provider itself). The service
// refusing the connection or shutting down is retried too: it's restarting
// (pm2 restart, after a crash, Reload .env), which takes a moment.
// Configuration problems, a timeout that already took the whole AI_TIMEOUT_MS
// and unreadable answers aren't retried.
const RETRY_STATUS = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const PERMANENT_NETWORK = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_INVALID_URL)$|CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i;
function isTransient(r) {
  if (r.failed === 'network') return r.code === 'ECONNREFUSED' || !PERMANENT_NETWORK.test(String(r.code || ''));
  if (r.failed) return false;
  const e = serviceError(r);
  if (e) {
    if (e.code === 'shutting_down') return true;
    if (e.type === 'upstream_error') return !e.upstream_status || RETRY_STATUS.has(Number(e.upstream_status));
    // (a provider's address refusing the service's connection is a setting to fix)
    if (e.type === 'network') return !PERMANENT_NETWORK.test(String(e.code || ''));
    return false;
  }
  return RETRY_STATUS.has(r.status);   // a 200 is an answer, never retried
}
// One request to the service, retried as above. Never throws: resolves to
// { status, ok, headers, text, json } or { failed: 'timeout' | 'network' | 'aborted' | 'token' }.
async function aiRequest(method, pathname, body, opts) {
  const delays = opts.retry === false ? [] : [600, 1800];
  let r = await aiRequestOnce(method, pathname, body, opts);
  for (const ms of delays) {
    if (!isTransient(r) || (opts.signal && opts.signal.aborted)) break;
    console.warn('[ai] ' + method + ' ' + pathname + ' failed (' + (r.failed ? r.failed + ' ' + (r.code || '') : 'HTTP ' + r.status) + '); retrying in ' + (ms / 1000) + ' s');
    await new Promise(resolve => setTimeout(resolve, ms));
    if (opts.signal && opts.signal.aborted) break;
    r = await aiRequestOnce(method, pathname, body, opts);
  }
  return r;
}
async function aiRequestOnce(method, pathname, body, opts) {
  const r = await serviceFetch(method, pathname, body, opts);
  // The service has another token now (its token file was made again, or .env changed): read it again, once
  if (!r.failed && tokenRefused(r) && tokenChanged()) return serviceFetch(method, pathname, body, opts);
  return r;
}
// Redirects are not followed, so the token is only ever sent to the configured address.
async function serviceFetch(method, pathname, body, opts) {
  let token;
  try { token = serviceToken(); } catch (e) { return { failed: 'token', code: e.code || '' }; }
  const { controller, unlink } = linkedAbort(opts.signal);
  const timer = setTimeout(() => controller.abort(TIMED_OUT), opts.timeoutMs);
  try {
    const response = await undici.fetch(AI.url + pathname, {
      method,
      headers: serviceHeaders(token, body && body.stream ? 'text/event-stream' : 'application/json', !!body, opts.timeoutMs),
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
      dispatcher: serviceDispatcher()
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, headers: response.headers, text, json: parseJson(text), pathname };
  } catch (err) {
    return transportFailure(err, controller.signal);
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

// The provider's own explanation from an error response that isn't one of
// the service's own (a stand-in answering like a provider), made safe to log or show.
function providerMessage(r) {
  const j = r.json;
  let message = '';
  if (j && typeof j === 'object') {
    if (j.error && typeof j.error === 'object' && typeof j.error.message === 'string') message = j.error.message;
    else if (typeof j.error === 'string') message = j.error;
    else if (typeof j.message === 'string') message = j.message;
    else if (typeof j.detail === 'string') message = j.detail;
  } else if (j === undefined && r.text && !/^\s*</.test(r.text)) {
    message = r.text;                                 // plain text (never an HTML error page)
  }
  return message ? redact(message, 200) : '';
}

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
function retryAfterSecondsOf(r) {
  const ms = r.headers && r.headers.get ? retryAfterMs(r.headers.get('retry-after'), Date.now()) : null;
  return ms !== null ? Math.max(1, Math.ceil(ms / 1000)) : null;
}

// ── Errors ────────────────────────────────────────────────────────────────────
// Every failure keeps MetaCode's existing error contract — an HTTP status
// plus { error: { message } } — and adds a machine-readable `type`. Messages
// say what to do, never echo keys, tokens, headers, URLs or stack traces.
function timeoutSeconds() {
  return String(AI.timeoutMs / 1000);
}

function fail(status, type, message, log) {
  return { ok: false, status, type, message, log: log || null };
}

function notConfigured() {
  if (AI.off) return fail(503, 'not_configured', 'MetaCode\'s AI is switched off on this server (OPENCODE_SERVICE_URL=off).');
  if (AI.problem) return fail(500, 'not_configured', 'MetaCode\'s AI isn\'t set up correctly: ' + AI.problem);
  return null;
}

// "isn't running at 127.0.0.1:4097" and what to do about it (startingNow: MetaCode has just started it)
function notRunningMessage(startingNow) {
  const sup = supervisor.state();
  const where = AI.baseHost || 'its address';
  if (sup.managed && sup.problem) return 'MetaCode\'s AI service (OpenCode) isn\'t running at ' + where + '. ' + sup.problem;
  if (sup.managed || startingNow) return 'MetaCode\'s AI service (OpenCode) isn\'t running at ' + where + ' yet: MetaCode is starting it. Try again in a few seconds.';
  // (pm2 has most likely started it already: then it keeps stopping, and its log says why)
  if (AI.managed === 'off') {
    return 'MetaCode\'s AI service (OpenCode) isn\'t running at ' + where + '. If pm2 runs it, "pm2 status" shows whether metacode-opencode is online and ' +
      '"pm2 logs metacode-opencode --lines 50" says why not (after an update: run "npm install", then "pm2 restart metacode-opencode"); if it isn\'t listed, ' +
      'run "pm2 start ecosystem.config.cjs". Otherwise check OPENCODE_SERVICE_URL in the server\'s .env file.';
  }
  return 'MetaCode\'s AI service (OpenCode) isn\'t running at ' + where + '. Start it ("node opencode/server.mjs", or with pm2: "pm2 start ecosystem.config.cjs"), or check OPENCODE_SERVICE_URL in the server\'s .env file.';
}

// What answers at the service's address isn't this copy's service: another
// program, or another MetaCode's service (opencode/supervisor.js asks GET
// /health when MetaCode may start the service); what to do, else null
function serviceForeign() {
  const sup = supervisor.state();
  return adoptedService() && sup.problem ? sup.problem : null;
}
// MetaCode found a service already answering at the address it would start one at
function adoptedService() {
  return AI.managed !== 'off' && !AI.off && supervisor.state().external;
}
// Something at the default address that answers "not found" like a web server would
function anotherProgramMessage() {
  return 'Another program, not MetaCode\'s AI service, answers at ' + (AI.baseHost || 'its address') + '. Set OPENCODE_SERVICE_PORT in .env to a free port and ' +
    'restart MetaCode (under pm2: both apps).';
}
// The service refused MetaCode's access token: the two don't share it, or it's another MetaCode's service on the same port
function tokenRefusedMessage() {
  const foreign = serviceForeign();
  if (foreign) return foreign;
  const head = 'MetaCode\'s AI service (OpenCode) at ' + (AI.baseHost || 'its address') + ' didn\'t accept MetaCode\'s access token. ';
  const share = 'If the service runs separately (pm2), give both the same OPENCODE_SERVICE_TOKEN (or the same OPENCODE_SERVICE_DATA_DIR) in .env, restart the service and click Reload .env in Settings.';
  const port = 'If it\'s another MetaCode\'s (a second copy on this computer), give this copy its own OPENCODE_SERVICE_PORT (a free port) in .env and restart it.';
  return head + (adoptedService() ? port + ' ' + share : share + ' ' + port);
}

function networkMessage(code) {
  const where = AI.baseHost || 'its address';
  if (code === 'ECONNREFUSED') return notRunningMessage(maybeStartService());
  if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return 'Couldn\'t find MetaCode\'s AI service at ' + where + ' (address lookup failed). Check OPENCODE_SERVICE_URL in the server\'s .env file.';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'Couldn\'t make a secure connection to MetaCode\'s AI service at ' + where + ' (certificate problem).';
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/.test(code)) return 'The connection to MetaCode\'s AI service dropped before it answered. Try again.';
  if (/TIMEOUT|ETIMEDOUT/.test(code)) return 'Couldn\'t connect to MetaCode\'s AI service at ' + where + ' in time. Try again.';
  return 'Couldn\'t reach MetaCode\'s AI service at ' + where + (code ? ' (' + code + ')' : '') + '. Check OPENCODE_SERVICE_URL in the server\'s .env file.';
}

const MODEL_MISSING = /model[^.]{0,80}(not\s+found|does\s*n[o']?t\s+exist|unknown|is\s+not\s+available|no\s+such)|(unknown|invalid|no\s+such)\s+model/i;
const SERVICE_STATUS = { invalid_request: 400, unsupported_feature: 400, authentication_error: 401, permission_error: 403, blocked: 403, model_not_found: 404,
  not_configured: 503, request_too_large: 413, rate_limited: 429, quota_exceeded: 429, cancelled: 499, upstream_error: 502, malformed_response: 502,
  network: 502, timeout: 504, internal_error: 500 };

// One of the service's own errors: its status, type and message (already
// written for MetaCode's operator) as they are.
function fromServiceError(r, e) {
  const status = r.status >= 400 && r.status < 600 ? r.status : SERVICE_STATUS[e.type];
  let message = plainText(e.message, 600) || 'The AI service couldn\'t answer (' + e.type + ').';
  if (e.type === 'authentication_error' && !e.provider) message = tokenRefusedMessage();
  const f = fail(status, e.type, message, 'HTTP ' + r.status + (e.provider ? ' from ' + plainText(e.provider, 40) : '') + ': ' + message);
  const seconds = Number(e.retry_after_seconds);
  f.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : (retryAfterSecondsOf(r) || undefined);
  if (typeof e.reset_at === 'string' && Number.isFinite(Date.parse(e.reset_at))) f.resetAt = new Date(Date.parse(e.reset_at)).toISOString();
  if (['day', 'week', 'month'].includes(e.window)) f.window = e.window;
  if (e.scope === 'model' || e.scope === 'provider') f.scope = e.scope;
  if (safeModelId(e.provider)) f.provider = e.provider;
  if (safeModelId(e.model)) f.model = e.model;
  if (Number.isInteger(e.upstream_status)) f.upstreamStatus = e.upstream_status;
  else if (e.type === 'upstream_error') f.upstreamStatus = 502;
  if (typeof e.code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(e.code)) f.code = e.code;
  if (e.type === 'network') f.transient = !PERMANENT_NETWORK.test(String(e.code || ''));
  if (e.code === 'shutting_down') f.transient = true;          // the service is restarting
  if (e.type === 'model_not_found') modelList.fetchedAt = 0;      // the list may have changed: fetch it again next time
  return f;
}

// Turns a failed exchange with the service into MetaCode's error format.
// ctx: { model, verified } — the model sent, and whether the service's list had it.
function describeFailure(r, ctx) {
  ctx = ctx || {};
  if (r.failed === 'token') {
    return fail(500, 'not_configured', 'MetaCode couldn\'t read or create the AI service\'s access token in ' + AI.settings.dataDir + (r.code ? ' (' + r.code + ')' : '') +
      '. Set OPENCODE_SERVICE_TOKEN in the server\'s .env file (at least 16 characters, the same for the service), or make that folder writable.');
  }
  if (r.failed === 'timeout') {
    return fail(504, 'timeout', 'The AI service didn\'t answer within ' + timeoutSeconds() + ' seconds. Try again; if this keeps ' +
      'happening, raise AI_TIMEOUT_MS in the server\'s .env file.');
  }
  if (r.failed === 'network') {
    return Object.assign(fail(502, 'network', networkMessage(r.code), 'network error ' + (r.code || '(no code)') + ' reaching the AI service at ' + (AI.baseHost || '?')),
      { transient: isTransient(r), code: r.code || undefined });
  }
  const e = serviceError(r);
  if (e) return fromServiceError(r, e);

  // Not one of the service's own errors: judged by the status, like a provider's answer
  const status = r.status;
  const detail = providerMessage(r);
  const log = 'HTTP ' + status + (detail ? ': ' + detail : '');
  if (status >= 300 && status < 400) {
    return fail(502, 'bad_base_url', 'MetaCode\'s AI service answered with a redirect instead of a result. Check OPENCODE_SERVICE_URL in the server\'s .env file.', log);
  }
  if (status === 401) {
    if (serviceForeign()) return fail(401, 'authentication_error', serviceForeign(), log);
    return fail(401, 'authentication_error', 'The AI service didn\'t accept the request' + (detail ? ' ("' + detail + '")' : '') + '. Check the AI provider\'s key ' +
      '(Settings → AI providers); if the service runs separately, give MetaCode and the service the same OPENCODE_SERVICE_TOKEN. A second MetaCode copy on ' +
      'this computer needs its own OPENCODE_SERVICE_PORT.', log);
  }
  if (status === 403) {
    if (/^\s*</.test(r.text || '')) {
      return fail(403, 'blocked', 'A web page answered (HTTP 403) instead of MetaCode\'s AI service. Check that OPENCODE_SERVICE_URL in the server\'s .env file is the ' +
        'service\'s address, ending in /v1 (default ' + AI.settings.url + '), then click Reload .env in Settings.', log);
    }
    return fail(403, 'permission_error', 'The AI service refused this request' + (detail ? ': "' + detail + '"' : '') +
      (ctx.model ? ' (model "' + modelName(ctx.model) + '")' : '') + '. Pick another model in Settings → AI models, or check the AI provider\'s key.', log);
  }
  if (ctx.model && (status === 404 || ((status === 400 || status === 422) && MODEL_MISSING.test(detail)))) {
    modelList.fetchedAt = 0;                       // the list may have changed: fetch it again next time
    if (status !== 404 || /model/i.test(detail) || ctx.verified) {
      return fail(404, 'model_not_found', 'The AI service doesn\'t offer the model "' + modelName(ctx.model) + '". Pick a model in Settings → AI models, ' +
        'or set OPENCODE_MODEL in the server\'s .env file.', log);
    }
    return fail(404, 'not_found', 'The AI service answered "not found" for the model "' + modelName(ctx.model) + '". Check the model (Settings → AI models) and ' +
      (AI.custom ? 'that OPENCODE_SERVICE_URL in the server\'s .env file ends in /v1.' : 'that it\'s MetaCode\'s AI service that answers at ' + AI.baseHost + ' (OPENCODE_SERVICE_PORT in .env).'), log);
  }
  // (at the default address the service always has its endpoints: another program answers there)
  if (status === 404) {
    return fail(502, 'bad_base_url', AI.custom ? 'MetaCode\'s AI service couldn\'t find the requested endpoint. Check that OPENCODE_SERVICE_URL in the server\'s .env file ends in /v1.'
      : anotherProgramMessage(), log);
  }
  if (status === 408) return fail(504, 'timeout', 'The AI service took too long to answer. Try again.', log);
  if (status === 413) return fail(413, 'request_too_large', 'The request was too large for the AI service. Try a shorter text or a smaller sample.', log);
  if (status === 429) {
    const f = fail(429, 'rate_limited', 'The AI service answered "too many requests". Try again later.', log);
    const wait = retryAfterSecondsOf(r);
    if (wait) f.retryAfterSeconds = wait;
    return f;
  }
  if (status >= 500) return Object.assign(fail(502, 'upstream_error', 'The AI service had a temporary server problem (HTTP ' + status + '). Try again in a moment.', log), { upstreamStatus: status });
  if (status >= 400) {
    return fail(400, 'invalid_request', 'The AI service couldn\'t process the request' + (detail ? ': ' + detail : ' (HTTP ' + status + ').'), log);
  }
  return fail(502, 'malformed_response', 'The AI service sent a response MetaCode couldn\'t read.', log);
}

function describeWhen(until, now) {
  const ms = until - now;
  const plural = (n, unit) => n + ' ' + unit + (n === 1 ? '' : 's');
  let rel;
  if (ms < 90 * 1000) rel = 'in ' + plural(Math.max(1, Math.round(ms / 1000)), 'second');
  else if (ms < 90 * 60 * 1000) rel = 'in ' + plural(Math.round(ms / 60000), 'minute');
  else if (ms < 36 * 3600 * 1000) rel = 'in about ' + plural(Math.round(ms / 3600000), 'hour');
  else rel = 'in about ' + plural(Math.round(ms / 86400000), 'day');
  return rel + ' (' + new Date(until).toLocaleString() + ')';
}

// Identical failures can repeat many times a second (AI Coding retries each
// post); the log gets one line per kind of failure per minute.
const recentLogLines = new Map();
function logFailure(f) {
  const line = '[ai] ' + f.status + ' ' + f.type + ' — ' + (f.log || f.message);
  const now = Date.now();
  if (recentLogLines.has(line) && now - recentLogLines.get(line) < 60 * 1000) return;
  recentLogLines.set(line, now);
  if (recentLogLines.size > 200) recentLogLines.clear();
  console.error(line);
}

function sendFailure(res, f) {
  logFailure(f);
  if (res.headersSent) return;
  if (f.retryAfterSeconds) res.setHeader('Retry-After', String(f.retryAfterSeconds));
  const error = { message: f.message, type: f.type };
  if (f.resetAt) error.resetAt = f.resetAt;
  if (f.retryAfterSeconds) error.retryAfterSeconds = f.retryAfterSeconds;
  if (f.window) error.window = f.window;
  if (f.scope) error.scope = f.scope;
  res.status(f.status).json({ error });
}

// ── The service: readiness ────────────────────────────────────────────────────
// AI counts as ready when it's configured (not switched off) and the service,
// when last asked (GET /v1/status), was answering with at least one provider
// set up. Before the first answer — and while MetaCode is starting the
// service, or waiting at start for one it doesn't run — it counts as ready,
// so pages don't flash "AI not set up". The answer is kept, and asked again
// at start, after Reload .env, when the Settings page reads it and it's older
// than 10 s (a failure: 3 s), by the status page, and every few seconds while
// the service isn't answering.
const serviceState = { ok: null, at: 0, status: null, failure: null, pending: null, generation: 0, downSince: 0 };

function probeService() {
  if (notConfigured()) return Promise.resolve(serviceState);
  if (serviceState.pending) return serviceState.pending;
  const gen = serviceState.generation;
  const wasDown = serviceState.ok === false;
  const settled = () => {
    if (serviceState.ok !== false) return serviceState;
    if (!wasDown) serviceState.downSince = serviceState.at;
    scheduleReprobe();
    return serviceState;
  };
  const pending = aiRequest('GET', '/status', null, { timeoutMs: STATUS_TIMEOUT_MS, retry: false })
    .then(r => {
      if (gen !== serviceState.generation) return serviceState;
      serviceState.at = Date.now();
      if (!r.failed && r.ok && r.json && typeof r.json === 'object' && !Array.isArray(r.json)) Object.assign(serviceState, { ok: true, status: r.json, failure: null });
      // (an older service, or a stand-in at an OPENCODE_SERVICE_URL, without /v1/status: it answers, so it
      // counts as up; at the default address the service always has it, so another program answers there)
      else if (!r.failed && r.status === 404 && !serviceError(r)) {
        Object.assign(serviceState, AI.custom ? { ok: true, status: null, failure: null } : { ok: false, status: null, failure: fail(502, 'bad_base_url', anotherProgramMessage()) });
      } else Object.assign(serviceState, { ok: false, status: null, failure: describeFailure(r) });
      return settled();
    })
    .catch(err => {
      Object.assign(serviceState, { ok: false, at: Date.now(), status: null, failure: fail(500, 'internal_error', 'Couldn\'t ask the AI service how it is.', redact(err && err.message)) });
      return settled();
    })
    .finally(() => { if (serviceState.pending === pending) serviceState.pending = null; });
  serviceState.pending = pending;
  return pending;
}
async function freshServiceState(maxAgeMs) {
  // (a failure is asked about again sooner: the service may have been starting or restarting)
  const maxAge = serviceState.ok === false ? Math.min(maxAgeMs, 3000) : maxAgeMs;
  if (!notConfigured() && !serviceStarting() && (serviceState.ok === null || Date.now() - serviceState.at > maxAge)) await probeService();
  return serviceState;
}

// While the service isn't answering (not running yet, restarting), it's asked
// again every 3 s (every 30 s once that has lasted a minute), so readiness —
// the AI Scraper, the desktop app, /api/health — comes back without waiting
// for someone to open Settings.
let reprobeTimer = null;
function scheduleReprobe() {
  const f = serviceState.failure;
  if (reprobeTimer || serviceState.ok !== false || !f || (f.type !== 'network' && f.type !== 'timeout')) return;
  reprobeTimer = setTimeout(() => {
    reprobeTimer = null;
    if (serviceState.ok === false && !serviceStarting()) probeService();
  }, Date.now() - serviceState.downSince < 60000 ? 3000 : 30000);
  reprobeTimer.unref();
}

// When MetaCode doesn't run the service itself (pm2 starts both apps at once,
// and the service takes a moment longer to listen), a refused connection at
// start is asked about again every 0.5 s for up to 15 s before it counts:
// meanwhile AI counts as starting, and the banner and the status page wait.
const STARTUP_WAIT_MS = 15 * 1000;
let startupWait = null;
function startupProbe() {
  const until = Date.now() + STARTUP_WAIT_MS;
  const refused = st => st.ok === false && !!st.failure && st.failure.type === 'network' && st.failure.code === 'ECONNREFUSED';
  startupWait = (async () => {
    for (;;) {
      const st = await probeService();
      if (!refused(st) || supervisor.state().managed || Date.now() > until) return st;
      await new Promise(resolve => setTimeout(resolve, 500).unref());
    }
  })().finally(() => { startupWait = null; });
  return startupWait;
}

// MetaCode started the service and is waiting for its first answer
function serviceStarting() {
  const sup = supervisor.state();
  return sup.starting && !sup.problem;
}
// MetaCode's own copy of the service keeps stopping (sup.problem says why)
function serviceFailing() {
  const sup = supervisor.state();
  return sup.managed && !sup.ready && !!sup.problem;
}
function aiReady() {
  if (notConfigured() || serviceFailing() || serviceForeign()) return false;
  if (serviceState.ok === null || serviceStarting() || startupWait) return true;
  if (!serviceState.ok) return false;
  return !serviceState.status || serviceState.status.ready !== false;
}
// Why AI isn't ready, for the AI Coding Lab and the AI Scraper (null: it is)
function aiProblem() {
  const f = notConfigured();
  if (f) return f.message;
  if (aiReady()) return null;
  if (serviceFailing()) return notRunningMessage();
  if (serviceForeign()) return serviceForeign();
  if (!serviceState.ok) return serviceState.failure ? serviceState.failure.message : notRunningMessage();
  return 'MetaCode\'s AI service is running, but no AI provider is set up yet. Settings → AI providers shows what each one needs.';
}
// What's wrong with the service itself (Settings → AI connection), or null
function serviceProblem() {
  if (notConfigured()) return null;
  const sup = supervisor.state();
  if (sup.managed && sup.problem) return sup.problem;
  if (serviceForeign()) return serviceForeign();
  if (serviceState.ok === false) return serviceState.failure ? serviceState.failure.message : notRunningMessage();
  return null;
}

// MetaCode's own copy of the service (opencode/supervisor.js)
const supervisor = createSupervisor({
  onReady() {
    // a model-list failure from while the service was starting no longer applies
    if (modelList.failure || modelList.pending) {
      modelList.generation++;
      Object.assign(modelList, { failure: null, failedAt: 0, pending: null });
    }
    probeService().then(st => { if (st.ok) console.log('[ai] ' + serviceSummary(st.status)); });
  }
});
// What the service MetaCode may run depends on; Reload .env starts it again
// when this changes. The token counts by its value (a hash of it, never the
// token itself), so a new OPENCODE_SERVICE_TOKEN or token file reaches it.
function serviceTarget() {
  let token = null;
  if (!(AI.off || AI.problem || AI.managed === 'off' || (AI.custom && AI.managed !== 'on'))) {
    try { token = crypto.createHash('sha256').update(serviceToken()).digest('hex').slice(0, 16); } catch (e) { token = 'unreadable'; }
  }
  return { mode: AI.managed, url: AI.url, custom: AI.custom, dataDir: AI.settings.dataDir, token };
}
let serviceTargetKey = null;
// Starts (or finds) the service for the current settings
async function startService() {
  const target = serviceTarget();
  serviceTargetKey = JSON.stringify(target);
  if (AI.off || AI.problem || AI.managed === 'off') return supervisor.stop();
  let token = null;
  try { token = serviceToken(); } catch (e) { console.warn('[ai] ' + describeFailure({ failed: 'token', code: e.code }).message); }
  return supervisor.start({ mode: target.mode, url: target.url, custom: target.custom, dataDir: target.dataDir, token });
}
// A service that stopped answering while MetaCode doesn't run it: start it (at most every 30 s)
let lastStartAttempt = 0;
function maybeStartService() {
  if (AI.off || AI.problem || AI.managed === 'off' || (AI.custom && AI.managed !== 'on')) return false;
  if (supervisor.state().managed) return true;
  const now = Date.now();
  if (now - lastStartAttempt < 30000) return false;
  lastStartAttempt = now;
  startService().catch(e => console.error('[ai] Couldn\'t start the AI service: ' + redact(e && e.message)));
  return true;
}

// "OpenCode Zen: ready (4 models, free only); AI gateway: not set up — …; default model: …"
function serviceSummary(status) {
  if (!status || typeof status !== 'object') return 'The AI service is answering.';
  const providers = Array.isArray(status.providers) ? status.providers.filter(p => p && typeof p === 'object') : [];
  const parts = providers.map(p => {
    const name = plainText(p.name, 60) || plainText(p.id, 40) || 'a provider';
    if (!p.ready) return name + ': not set up' + (p.problem ? ' — ' + plainText(p.problem, 200) : '');
    const listed = p.models && Number.isFinite(p.models.listed) ? p.models.listed : null;
    const resting = p.resting && p.resting.until && Date.parse(p.resting.until) > Date.now();
    return name + ': ready' + (listed !== null ? ' (' + listed + ' model' + (listed === 1 ? '' : 's') + (p.free === true && p.keyCount === 0 ? ', free only' : '') + ')' : '') + (resting ? ', resting until ' + new Date(Date.parse(p.resting.until)).toLocaleString() : '');
  });
  const ready = providers.filter(p => p.ready).length;
  return (parts.length ? parts.join('; ') : 'no providers') + (ready ? '' : ' — no provider is set up yet') +
    (safeModelId(status.default) ? '; default model: ' + status.default : '');
}

// ── Model list ────────────────────────────────────────────────────────────────
// The models MetaCode offers (Settings → AI models) and checks each request's
// model against come from the service: GET {OPENCODE_SERVICE_URL}/models lists
// the models of every provider that is set up, as "provider/model" ids with
// their names, capabilities and limits, plus the service's default model.
// Cached for 30 s; concurrent callers share one fetch, and a failure is
// reused for a few seconds. A request for a model that isn't listed (e.g. an
// id saved in someone's browser long ago) gets the model's current id when
// it's one model under another spelling or without its provider
// (renamedModel), else the default model.
const modelList = { result: null, fetchedAt: 0, failure: null, failedAt: 0, pending: null, generation: 0 };

// Display names go into the Settings dropdown's HTML, so only plain text is kept.
function safeModelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[^\p{L}\p{N} ._()/+:,'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return name || null;
}

function capability(value) {
  return typeof value === 'boolean' ? value : null;
}
const tokenCount = v => (Number.isInteger(v) && v > 0 && v < 1e9 ? v : null);

// → { ids, info: Map(id → { id, name, named, provider, providerName, model, free, available, toolCall, reasoning, attachment, context, output, variants }), providers, default } or null
function parseModelList(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) return null;
  const ids = [];
  const info = new Map();
  let skipped = 0;
  json.data.forEach(entry => {
    const id = entry && typeof entry === 'object' ? safeModelId(entry.id) : null;
    if (!id) { skipped++; return; }
    if (info.has(id)) return;
    const split = splitModel(id);
    const name = safeModelName(entry.name);
    ids.push(id);
    info.set(id, {
      id, name: name || id, named: !!name,
      provider: safeModelId(entry.provider) || split.provider, providerName: safeModelName(entry.provider_name),
      model: typeof entry.model === 'string' && safeModelId(entry.model) ? entry.model : split.model,
      free: capability(entry.free),
      // (a list without this field is a stand-in's: listed = offered)
      available: entry.available === undefined ? true : capability(entry.available),
      toolCall: capability(entry.tool_call), reasoning: capability(entry.reasoning), attachment: capability(entry.attachment),
      context: tokenCount(entry.context_window), output: tokenCount(entry.max_output),
      variants: Array.isArray(entry.variants) ? entry.variants.filter(v => typeof v === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(v)).slice(0, 20) : []
    });
  });
  if (skipped) console.warn('[ai] Skipped ' + skipped + ' model list entr' + (skipped === 1 ? 'y' : 'ies') + ' without a usable id.');
  const providers = Array.isArray(json.providers)
    ? json.providers.filter(p => p && typeof p === 'object' && safeModelId(p.id)).map(p => ({ id: p.id, name: safeModelName(p.name) || p.id, ready: p.ready !== false }))
    : [];
  const listedDefault = safeModelId(json.default);
  const flagged = json.data.find(entry => entry && entry.default === true && info.has(entry.id));
  return { ids, info, providers, default: listedDefault && info.has(listedDefault) ? listedDefault : (flagged ? flagged.id : null) };
}

async function fetchModelList() {
  const r = await aiRequest('GET', '/models', null, { timeoutMs: Math.min(AI.timeoutMs, MODEL_LIST_TIMEOUT_MS) });
  if (r.failed || !r.ok) return describeFailure(r);
  const list = parseModelList(r.json);
  if (!list) {
    const what = describeReply(r);
    return fail(502, 'malformed_response', 'MetaCode\'s AI service sent its model list in a format MetaCode couldn\'t read (it sent ' + what + ').' +
      (/web page/.test(what) ? ' Check that OPENCODE_SERVICE_URL is the service\'s address ending in /v1 (default ' + AI.settings.url + ').' : ''), 'HTTP ' + r.status + ': ' + what);
  }
  return Object.assign({ ok: true, source: 'opencode' }, list);
}

// Resolves to { ok: true, ids, info, providers, default, source: 'opencode' } or to a failure.
function getModelList(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh) {
    if (modelList.result && now - modelList.fetchedAt < MODEL_LIST_TTL_MS) return Promise.resolve(modelList.result);
    if (modelList.failure && now - modelList.failedAt < MODEL_LIST_RETRY_MS) return Promise.resolve(modelList.failure);
  }
  if (!modelList.pending) {
    const gen = modelList.generation;
    const pending = fetchModelList()
      .catch(err => fail(500, 'internal_error', 'Couldn\'t load the model list.', 'model list: ' + redact(err && err.message)))
      .then(result => {
        if (gen === modelList.generation) {
          if (result.ok) {
            modelList.result = result;
            modelList.fetchedAt = Date.now();
            modelList.failure = null;
          } else {
            modelList.failure = result;
            modelList.failedAt = Date.now();
          }
        }
        if (modelList.pending === pending) modelList.pending = null;
        return result;
      });
    modelList.pending = pending;
  }
  return modelList.pending;
}

// Default model: OPENCODE_MODEL (or the older EMIS_MODEL) if the service
// offers it, also under another spelling or without its provider; otherwise
// the service's own default (it reads OPENCODE_MODEL too, and skips models it
// can't use), else the first listed model that isn't obviously an image,
// audio or embedding model. → { model, warning? } or { error }
const NOT_A_CHAT_MODEL = /(image|video|dall-?e|sora|veo|imagen|flux|stable-?diffusion|sdxl|tts|whisper|transcri|speech|audio|embed|moderation|rerank|guard)/i;

// "opencode/big-pickle#high" → { base: 'opencode/big-pickle', variant: 'high' }. The service lists each
// model once, with the reasoning variants it has ("#variant", see docs/ai-models.md): the base id is
// what's looked up in the list, and the variant goes along when the request is sent ("default": none).
function splitVariant(id) {
  const s = String(id || '');
  const i = s.lastIndexOf('#');
  const variant = i > 0 ? s.slice(i + 1) : '';
  return { base: i > 0 ? s.slice(0, i) : s, variant: variant && variant !== 'default' ? variant : null };
}
// A variant the listed model doesn't have (a model listed without variants: the service decides)
function unknownVariant(info, variant) {
  return !!variant && !!info && info.variants.length > 0 && !info.variants.includes(variant);
}

function noModelsFailure() {
  return fail(503, 'not_configured', 'MetaCode\'s AI service has no AI provider set up yet, so there are no models to use. Settings → AI providers shows what each one needs.');
}

// (model is always a listed id; a variant set with it, "…#high", comes as variant)
function chooseDefaultModel(list) {
  const ids = list.ids;
  let warning = null;
  if (AI.model) {
    const { base, variant } = splitVariant(AI.model);
    const found = ids.includes(base) ? base : renamedModel(base, ids);
    if (found) {
      if (found !== base) noteRename(base, found, AI.modelVar);
      const info = list.info.get(found);
      if (!unknownVariant(info, variant)) return variant ? { model: found, variant } : { model: found };
      warning = 'The model set in ' + AI.modelVar + ' ("' + AI.model + '") has no variant "' + variant + '" (it has ' + info.variants.join(', ') + '), so it is used without one. ' +
        'Change ' + AI.modelVar + ' in the server\'s .env file.';
      noteOnce('variant:' + AI.model, '[ai] ' + warning);
      return { model: found, warning };
    }
    warning = 'The model set in ' + AI.modelVar + ' ("' + AI.model + '") isn\'t offered by the AI service right now, so its default model is used. ' +
      'Change ' + AI.modelVar + ' in the server\'s .env file, or remove it to let the service choose.';
  }
  const usable = id => { const i = list.info.get(id); return !i || i.available !== false; };
  const model = (list.default && ids.includes(list.default) ? list.default : null) ||
    ids.find(id => usable(id) && !NOT_A_CHAT_MODEL.test(splitModel(id).model)) || ids[0];
  if (!model) return { error: noModelsFailure() };
  if (warning) noteOnce('default:' + AI.model, '[ai] The model set in ' + AI.modelVar + ' ("' + AI.model + '") isn\'t offered by the AI service right now; using its default, "' + model + '".');
  return warning ? { model, warning } : { model };
}

const substitutionsLogged = new Set();
function noteOnce(key, line) {
  if (substitutionsLogged.has(key)) return;
  substitutionsLogged.add(key);
  console.warn(line);
}
function noteSubstitution(from, to) {
  noteOnce(from, '[ai] "' + from + '" isn\'t offered by the AI service, so "' + to + '" is used instead. Choose a model in ' +
    'Settings → AI models, or set OPENCODE_MODEL in .env.');
}
// A model asked for under an older spelling of its id (claude-opus-5-5 → emis/claude-opus-5.5)
function noteRename(from, to, where) {
  noteOnce('rename:' + from, '[ai] "' + from + '" is called "' + to + '" by the AI service now; "' + to + '" is used.' +
    (where ? ' Update ' + where + ' in .env.' : ''));
}

// When the model list itself can't be loaded for these reasons, a chat
// request would fail the same way, so the request stops here.
const FATAL_LIST_FAILURES = new Set(['timeout', 'network', 'authentication_error', 'permission_error', 'not_configured', 'bad_base_url']);

// → { ok: true, model, verified, source, info } (info: the model's entry in the list) or a failure.
// A model's reasoning variant ("…#high") is sent along; one the model doesn't have is refused here.
async function resolveModel(requested) {
  const wanted = safeModelId(requested) || '';
  const list = await getModelList(false);
  if (!list.ok) {
    if (FATAL_LIST_FAILURES.has(list.type)) return list;
    // The list is unavailable for another reason (a hiccup): send the
    // configured or requested model unverified and let the service decide.
    const model = AI.model || wanted;
    return model ? { ok: true, model, verified: false, source: 'opencode', info: null } : list;
  }
  const pick = (model, variant) => ({ ok: true, model: model + (variant ? '#' + variant : ''), verified: true, source: list.source, info: list.info.get(model) || null });
  const { base, variant } = splitVariant(wanted);
  // The listed id, or the same model under the id the list spells it with now (or with its provider)
  const found = base && list.ids.includes(base) ? base : renamedModel(base, list.ids);
  if (found) {
    const info = list.info.get(found);
    if (unknownVariant(info, variant)) {
      return fail(400, 'invalid_request', 'The model "' + found + '" has no variant "' + variant + '" (it has ' + info.variants.join(', ') + ').');
    }
    if (found === base) return pick(found, variant);
    noteRename(base, found);
    return Object.assign(pick(found, variant), { renamedFrom: wanted });
  }
  // Anything else gets the default — the same model Settings shows as selected
  // when the saved one isn't listed, so what's shown is what's used.
  const choice = chooseDefaultModel(list);
  if (choice.error) return choice.error;
  if (wanted) noteSubstitution(wanted, choice.model);
  return pick(choice.model, choice.variant);
}

// Capability flags from the service's model list: a request that needs
// something the model doesn't support is refused with a clear message before
// it's sent.
function capabilityProblem(chatRequest, info) {
  if (!info) return null;
  const per = ' (according to the AI service\'s model list)';
  if (info.toolCall === false && Array.isArray(chatRequest.tools) && chatRequest.tools.length) {
    return fail(400, 'unsupported_feature', 'The model "' + modelName(info.id) + '" doesn\'t support tool calling' + per + '. Pick a model that does.');
  }
  const hasAttachment = chatRequest.messages.some(m => Array.isArray(m.content) && m.content.some(part => part && part.type && part.type !== 'text'));
  if (info.attachment === false && hasAttachment) {
    return fail(400, 'unsupported_feature', 'The model "' + modelName(info.id) + '" doesn\'t accept images or files' + per + '. Pick a model that does, or send text only.');
  }
  return null;
}

// ── Request formats ───────────────────────────────────────────────────────────
// The frontend still names the request format it speaks in the x-provider
// header: "openai" (or the older "groq" / "emis") = OpenAI chat format, the
// default; "anthropic" = Messages format. Both are answered by the AI service
// in the matching format; the header doesn't select a provider (the model id
// does).
const FORMATS = { groq: 'openai', openai: 'openai', emis: 'openai', anthropic: 'anthropic' };

class RequestError extends Error {}

const MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

function copyNumber(out, body, field, rule) {
  const value = body[field];
  if (value === undefined || value === null) return;
  const ok = typeof value === 'number' && Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    (rule.min === undefined || value >= rule.min) &&
    (rule.max === undefined || value <= rule.max);
  if (!ok) {
    const kind = rule.integer ? 'a whole number' : 'a number';
    const range = rule.max !== undefined ? ' from ' + rule.min + ' to ' + rule.max : (rule.min !== undefined ? ' of at least ' + rule.min : '');
    throw new RequestError('"' + field + '" must be ' + kind + range + '.');
  }
  out[field] = value;
}

function copyStop(out, value) {
  if (value === undefined || value === null) return;
  const ok = typeof value === 'string' || (Array.isArray(value) && value.every(s => typeof s === 'string'));
  if (!ok) throw new RequestError('"stop" must be a string or a list of strings.');
  out.stop = value;
}

function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('The request body must be a JSON object.');
}

// OpenAI chat format → the request sent to the AI service. Only known
// chat-completion fields are forwarded; everything else in the body is dropped.
function fromOpenAIRequest(body) {
  requireObject(body);
  if (!Array.isArray(body.messages) || !body.messages.length) throw new RequestError('"messages" must be a non-empty list.');
  const messages = body.messages.map((m, i) => {
    if (!m || typeof m !== 'object') throw new RequestError('messages[' + i + '] must be an object.');
    if (!MESSAGE_ROLES.has(m.role)) throw new RequestError('messages[' + i + '].role must be system, developer, user, assistant or tool.');
    const out = { role: m.role };
    const hasToolCalls = m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (typeof m.content === 'string' || Array.isArray(m.content)) out.content = m.content;
    else if ((m.content === null || m.content === undefined) && hasToolCalls) out.content = null;
    else throw new RequestError('messages[' + i + '].content must be text or a list of content parts.');
    if (typeof m.name === 'string') out.name = m.name;
    if (hasToolCalls) out.tool_calls = m.tool_calls;
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string') throw new RequestError('messages[' + i + '].tool_call_id is required for tool messages.');
      out.tool_call_id = m.tool_call_id;
    }
    return out;
  });

  const out = { model: body.model, messages };
  copyNumber(out, body, 'max_tokens', { integer: true, min: 1 });
  copyNumber(out, body, 'max_completion_tokens', { integer: true, min: 1 });
  copyNumber(out, body, 'temperature', { min: 0, max: 2 });
  copyNumber(out, body, 'top_p', { min: 0, max: 1 });
  copyNumber(out, body, 'presence_penalty', { min: -2, max: 2 });
  copyNumber(out, body, 'frequency_penalty', { min: -2, max: 2 });
  copyNumber(out, body, 'seed', { integer: true });
  copyStop(out, body.stop);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new RequestError('"tools" must be a list.');
    out.tools = body.tools;
  }
  ['tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort'].forEach(field => {
    if (body[field] !== undefined) out[field] = body[field];
  });
  out.stream = false;   // said explicitly: some gateways stream unless told not to
  if (body.stream !== undefined) {
    if (typeof body.stream !== 'boolean') throw new RequestError('"stream" must be true or false.');
    out.stream = body.stream;
    if (body.stream && body.stream_options !== undefined) out.stream_options = body.stream_options;
  }
  return out;
}

function anthropicText(value, where) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(b => b && b.type === 'text' && typeof b.text === 'string')) {
    return value.map(b => b.text).join('\n\n');
  }
  throw new RequestError(where + ' must be text (images and tool blocks are only supported in OpenAI-format requests).');
}

// Anthropic Messages format → the (OpenAI-format) request: `system` becomes the
// first message, text blocks become text. Streaming and tools are only
// offered in the OpenAI format, and say so instead of failing obscurely.
function fromAnthropicRequest(body) {
  requireObject(body);
  if (body.stream === true) throw new RequestError('Streaming is only available for OpenAI-format requests.');
  if (body.tools !== undefined || body.tool_choice !== undefined) throw new RequestError('Tool calling is only available for OpenAI-format requests.');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new RequestError('"messages" must be a non-empty list.');
  const messages = [];
  if (body.system !== undefined && body.system !== null && body.system !== '') {
    messages.push({ role: 'system', content: anthropicText(body.system, '"system"') });
  }
  body.messages.forEach((m, i) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw new RequestError('messages[' + i + '].role must be user or assistant.');
    messages.push({ role: m.role, content: anthropicText(m.content, 'messages[' + i + '].content') });
  });
  const out = { model: body.model, messages };
  copyNumber(out, body, 'max_tokens', { integer: true, min: 1 });
  copyNumber(out, body, 'temperature', { min: 0, max: 1 });
  copyNumber(out, body, 'top_p', { min: 0, max: 1 });
  copyStop(out, body.stop_sequences);
  return out;
}

// ── Response formats ──────────────────────────────────────────────────────────
// (The AI service makes images and videos inside a chat completion when asked;
// MetaCode's features use the text, so a picture is marked rather than dropped
// without a trace — an answer that is only a picture isn't "empty".)
const MEDIA_PART = /^(input_|output_)?(image|video|audio|file)(_url)?$/;
function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : !p ? '' : typeof p.text === 'string' ? p.text
      : MEDIA_PART.test(String(p.type || '')) ? '[' + String(p.type).replace(/^(input|output)_/, '').replace(/_url$/, '') + ' omitted]' : '')).join('');
  }
  return '';
}

// Reads the AI service's reply whatever shape it comes in, as an OpenAI chat completion:
//   • OpenAI chat JSON (choices[].message) — the normal case;
//   • a server-sent-event stream ("data: {…}" chunks), which some gateways send
//     even when no stream was asked for — the chunks are joined;
//   • the Responses API (output[].content[].text / output_text), Anthropic
//     Messages (content[].text), Ollama-style ({ message } / { response }),
//     plain { text } / { content } / { output }, or any of these inside { data }.
// → completion, or null.
function readReply(r) {
  let json = r.json;
  const text = typeof r.text === 'string' ? r.text : '';
  if (json === undefined && /(^|\n)\s*(data|event):/.test(text)) return fromSse(text);
  if (!json || typeof json !== 'object') return null;
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data) && !json.choices) json = json.data;
  const direct = normalizeCompletion(json);
  if (direct) return direct;
  const wrap = (content, extra) => ({ id: json.id || 'chatcmpl-' + Date.now().toString(36), object: 'chat.completion', model: json.model || null,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: (extra && extra.finish) || 'stop' }], usage: json.usage || undefined });
  if (typeof json.output_text === 'string') return wrap(json.output_text);
  if (Array.isArray(json.output)) {
    const t = json.output.map(o => (o && Array.isArray(o.content) ? textContent(o.content.map(c => (c && (c.text || c.output_text)) || '')) : (o && typeof o.text === 'string' ? o.text : ''))).join('');
    if (t || json.output.length) return wrap(t);
  }
  if (Array.isArray(json.content) && json.content.some(c => c && typeof c.text === 'string')) return wrap(textContent(json.content), { finish: json.stop_reason === 'max_tokens' ? 'length' : 'stop' });
  if (json.message && typeof json.message === 'object' && json.message.content !== undefined) return wrap(textContent(json.message.content));
  for (const k of ['response', 'text', 'content', 'output', 'answer', 'result', 'completion']) if (typeof json[k] === 'string') return wrap(json[k]);
  return null;
}
function fromSse(text) {
  let content = '', model = null, id = null, finish = null, usage;
  let any = false;
  let finalText = null;
  text.split(/\r?\n/).forEach(line => {
    const m = /^\s*data:\s?(.*)$/.exec(line);
    if (!m || m[1].trim() === '[DONE]') return;
    let j; try { j = JSON.parse(m[1]); } catch (e) { return; }
    if (!j || typeof j !== 'object') return;
    any = true;
    // Responses-API style events
    if (typeof j.delta === 'string' && /output_text|text\.delta|content/.test(String(j.type || 'output_text'))) content += j.delta;
    if (j.type === 'response.completed' && j.response) { const done = readReply({ json: j.response, text: '' }); if (done) finalText = done.choices[0].message.content; }
    if (j.error && !content) finish = finish || 'error';
    model = model || j.model || null; id = id || j.id || null;
    if (j.usage) usage = j.usage;
    (Array.isArray(j.choices) ? j.choices : []).forEach(c => {
      if (!c) return;
      const piece = (c.delta && c.delta.content) || (c.message && c.message.content) || c.text || '';
      content += textContent(piece);
      if (c.finish_reason) finish = c.finish_reason;
    });
    if (typeof j.delta === 'object' && j.delta && typeof j.delta.text === 'string') content += j.delta.text;   // Anthropic stream
  });
  if (!any) return null;
  if (!content && finalText) content = finalText;
  return { id: id || 'chatcmpl-' + Date.now().toString(36), object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish || 'stop' }], usage };
}
function replyHeaders(r) {
  if (!r || !r.headers || !r.headers.get) return '';
  const h = ['content-type', 'content-length', 'transfer-encoding', 'content-encoding'].map(k => r.headers.get(k) ? k + '=' + r.headers.get(k) : '').filter(Boolean).join(', ');
  return h ? '; headers: ' + h : '';
}
// What an unreadable reply looked like, for the error message (no secrets: redacted, short).
function describeReply(r) {
  const type = r.headers && r.headers.get ? String(r.headers.get('content-type') || '').split(';')[0] : '';
  const text = typeof r.text === 'string' ? r.text : '';
  if (!text.trim()) return 'an empty reply';
  if (/^\s*</.test(text)) return 'a web page (' + (type || 'HTML') + ') instead of an API answer';
  if (r.json && typeof r.json === 'object' && r.json.error) {
    const e = r.json.error;
    return 'an error: "' + redact(String(typeof e === 'string' ? e : (e.message || JSON.stringify(e))).slice(0, 200), 200) + '"';
  }
  if (r.json && typeof r.json === 'object') return 'JSON with ' + (Object.keys(r.json).slice(0, 8).join(', ') || 'no fields');
  return (type || 'text') + ' starting "' + redact(text.replace(/\s+/g, ' ').slice(0, 200), 200) + '"';
}

// Checks the completion and makes every choice's message.content a string
// (the frontend calls .trim() on it), keeping all other fields. null =
// malformed.
function normalizeCompletion(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.choices) || !json.choices.length) return null;
  const choices = [];
  for (const raw of json.choices) {
    if (!raw || typeof raw !== 'object') return null;
    // Some gateways answer in the older "text" shape, or put the message in "delta"
    let choice = raw;
    if (!choice.message || typeof choice.message !== 'object') {
      if (typeof raw.text === 'string') choice = Object.assign({}, raw, { message: { role: 'assistant', content: raw.text } });
      else if (raw.delta && typeof raw.delta === 'object') choice = Object.assign({}, raw, { message: Object.assign({ role: 'assistant' }, raw.delta) });
      else return null;
    }
    let content = textContent(choice.message.content);
    if (!content && Array.isArray(choice.message.images) && choice.message.images.length) content = '[image omitted]';     // (OpenRouter-style images)
    choices.push(Object.assign({}, choice, { message: Object.assign({}, choice.message, { content }) }));
  }
  return Object.assign({}, json, { choices });
}

const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' };

function toAnthropicResponse(completion) {
  const choice = completion.choices[0];
  const usage = completion.usage && typeof completion.usage === 'object' ? completion.usage : {};
  const count = n => (Number.isFinite(n) ? n : 0);
  return {
    id: typeof completion.id === 'string' ? completion.id : 'msg_' + Date.now().toString(36),
    type: 'message',
    role: 'assistant',
    model: typeof completion.model === 'string' ? completion.model : null,
    content: [{ type: 'text', text: choice.message.content }],
    stop_reason: STOP_REASONS[choice.finish_reason] || (choice.finish_reason ? 'end_turn' : null),
    stop_sequence: null,
    usage: { input_tokens: count(usage.prompt_tokens), output_tokens: count(usage.completion_tokens) }
  };
}

function noteEmptyAnswer(completion, model) {
  const choice = completion.choices[0];
  const toolCalls = Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0;
  if (choice.message.content.trim() || toolCalls) return;
  console.warn('[ai] ' + model + ' returned an empty answer (finish_reason: ' + (choice.finish_reason || 'none') + ')' +
    (choice.finish_reason === 'length' ? ' — it used its whole max_tokens budget, probably on reasoning.' : '.'));
}

// ── Chat completion (normal JSON response) ───────────────────────────────────
async function completeChat(chatRequest, ctx, signal, retriedLength) {
  const r = await aiRequest('POST', '/chat/completions', chatRequest, { timeoutMs: AI.timeoutMs, signal });
  if (r.failed === 'aborted') return { aborted: true };
  if (r.failed) return describeFailure(r, ctx);
  // Rate limits: the model rests (answerChat picks the closest one), or its whole provider does
  if (r.status === 429) return onLimited(describeFailure(r, ctx), chatRequest.model, Date.now());
  if (!r.ok) return describeFailure(r, ctx);
  const completion = readReply(r);
  if (!completion) {
    const what = describeReply(r);
    console.error('[ai] Unreadable reply to chat/completions (model ' + chatRequest.model + ', HTTP ' + r.status + '): ' + what + replyHeaders(r));
    return fail(502, 'malformed_response', 'The AI service answered, but not with a chat reply MetaCode can read — it sent ' + what + '.' +
      (/web page/.test(what) ? ' Check that OPENCODE_SERVICE_URL in .env is the AI service\'s address ending in /v1 (default ' + AI.settings.url + ').' : ''),
      'HTTP ' + r.status + ': ' + what);
  }
  // A reasoning model can use its whole token budget thinking and return no
  // text: ask once more with a bigger budget.
  const c0 = completion.choices[0];
  if (!String(c0.message.content || '').trim() && c0.finish_reason === 'length' && !retriedLength) {
    const bigger = Math.min(8192, Math.max(1024, (Number(chatRequest.max_tokens) || 256) * 4));
    console.warn('[ai] ' + chatRequest.model + ' used all ' + (chatRequest.max_tokens || '?') + ' tokens without answering; retrying with ' + bigger + '.');
    return completeChat(Object.assign({}, chatRequest, { max_tokens: bigger }), ctx, signal, true);
  }
  noteEmptyAnswer(completion, chatRequest.model);
  return { ok: true, completion };
}

// ── Chat completion (streaming) ───────────────────────────────────────────────
// With "stream": true (OpenAI format), the AI service's server-sent events
// are relayed to the browser as they arrive: each chat.completion.chunk once,
// in order, ending with "data: [DONE]". A failure before the stream starts is
// a normal JSON error; a failure after it starts is sent as a final
// `data: {"error": {...}}` event and the stream ends without [DONE]. If the
// browser disconnects, the AI request is cancelled.
const STREAM_DONE = { done: true };

// Minimal Server-Sent Events parser (WHATWG rules): an event ends at a blank
// line, "data:" lines join with "\n", lines starting with ":" are comments.
// Handles \n, \r\n and \r line endings and events split across network reads.
function createSseParser() {
  let buffer = '';
  let dataLines = [];
  let eventName = '';
  const events = [];

  function processLine(line) {
    if (line === '') {
      if (dataLines.length) events.push({ event: eventName || 'message', data: dataLines.join('\n') });
      dataLines = [];
      eventName = '';
      return;
    }
    if (line[0] === ':') return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
  }

  function drain(final) {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      if (ch === '\r' && i === buffer.length - 1 && !final) break;   // may be the first half of \r\n
      processLine(buffer.slice(start, i));
      if (ch === '\r' && buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (final) {
      if (buffer) processLine(buffer);
      buffer = '';
      processLine('');            // lenient: a last event without its blank line still counts
    }
    return events.splice(0);
  }

  return {
    push(text) { buffer += text; return drain(false); },
    end(text) { buffer += text || ''; return drain(true); }
  };
}

function writeSse(res, text) {
  if (res.writableEnded || res.destroyed) return Promise.resolve(false);
  return new Promise(resolve => {
    if (res.write(text)) { resolve(true); return; }
    const settle = () => { res.off('drain', settle); res.off('close', settle); resolve(!res.destroyed); };
    res.on('drain', settle);
    res.on('close', settle);
  });
}

// Opens a streaming request to the AI service. Resolves to an attempt
// { response, ... } or { failed }. The attempt's timer covers the wait for the
// response headers (the service sends them with the first part of the answer)
// and, once restarted per chunk, silence between chunks.
async function openStream(chatRequest, clientSignal) {
  let token;
  try { token = serviceToken(); } catch (e) { return { failed: 'token', code: e.code || '' }; }
  const { controller, unlink } = linkedAbort(clientSignal);
  let timer = setTimeout(() => controller.abort(TIMED_OUT), AI.timeoutMs);
  const attempt = {
    controller,
    restartTimer() { clearTimeout(timer); timer = setTimeout(() => controller.abort(TIMED_OUT), AI.timeoutMs); },
    cancel() { if (!controller.signal.aborted) controller.abort(CANCELLED); },
    finish() { clearTimeout(timer); unlink(); }
  };
  try {
    attempt.response = await undici.fetch(AI.url + '/chat/completions', {
      method: 'POST',
      headers: serviceHeaders(token, 'text/event-stream', true, AI.timeoutMs),
      body: JSON.stringify(Object.assign({}, chatRequest, { stream: true })),
      redirect: 'manual',
      signal: controller.signal,
      dispatcher: serviceDispatcher()
    });
    return attempt;
  } catch (err) {
    attempt.finish();
    return transportFailure(err, controller.signal);
  }
}

// Reads the body of a non-success streaming response (an error JSON).
async function readErrorBody(attempt) {
  try {
    attempt.restartTimer();
    const text = await attempt.response.text();
    return { status: attempt.response.status, ok: false, headers: attempt.response.headers, text, json: parseJson(text) };
  } catch (err) {
    return transportFailure(err, attempt.controller.signal);
  } finally {
    attempt.finish();
  }
}

async function relayStream(res, attempt, model) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.on('error', () => {});      // a browser that vanished mid-write must not crash the server

  const reader = attempt.response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let outcome = null;
  let finishSeen = false;
  let forwarded = 0;

  const handleEvent = async event => {
    const payload = event.data;
    if (payload.trim() === '[DONE]') return STREAM_DONE;
    const chunk = parseJson(payload);
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      return { type: 'malformed_response', message: 'The AI service sent part of the answer in a format MetaCode couldn\'t read.',
               log: 'unreadable stream event (' + payload.length + ' characters)' };
    }
    if (event.event === 'error' || chunk.error) {
      // The service's own errors keep their type and message (a rate limit is noted for the next requests)
      const own = serviceError({ json: chunk });
      if (own) {
        const f = fromServiceError({ status: SERVICE_STATUS[own.type] || 502 }, own);
        if (f.status === 429) onLimited(f, model, Date.now());
        return { type: f.type, message: f.message };
      }
      const raw = chunk.error && typeof chunk.error === 'object' ? chunk.error.message : chunk.error;
      const detail = redact(raw, 200);
      return { type: 'upstream_error', message: 'The AI service reported a problem while answering' + (detail ? ': ' + detail : '.') };
    }
    if (Array.isArray(chunk.choices) && chunk.choices.some(c => c && c.finish_reason)) finishSeen = true;
    const written = await writeSse(res, 'data: ' + JSON.stringify(chunk) + '\n\n');
    forwarded++;
    return written ? null : { gone: true };
  };

  try {
    attempt.restartTimer();
    while (!outcome) {
      const { value, done } = await reader.read();
      if (done) break;
      attempt.restartTimer();
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        outcome = await handleEvent(event);
        if (outcome) break;
      }
    }
    if (!outcome) {
      for (const event of parser.end(decoder.decode())) {
        outcome = await handleEvent(event);
        if (outcome) break;
      }
    }
  } catch (err) {
    const reason = attempt.controller.signal.reason;
    if (reason === CLIENT_GONE || res.destroyed) outcome = { gone: true };
    else if (reason === TIMED_OUT) {
      outcome = { type: 'timeout', message: 'The AI service stopped sending the answer for ' + timeoutSeconds() + ' seconds, so the stream was ended.' };
    } else {
      outcome = { type: 'network', message: 'The connection to the AI service dropped in the middle of the answer.' };
    }
  } finally {
    attempt.finish();
  }

  if (outcome && outcome.gone) {
    attempt.cancel();
    reader.cancel().catch(() => {});
    console.warn('[ai] The browser disconnected mid-stream; the AI request was cancelled.');
    return;
  }
  if (outcome === STREAM_DONE || (!outcome && finishSeen)) {
    reader.cancel().catch(() => {});
    await writeSse(res, 'data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
    return;
  }
  const problem = outcome || { type: 'stream_interrupted', message: 'The AI stream ended before the answer was complete.' };
  attempt.cancel();
  reader.cancel().catch(() => {});
  logFailure(fail(502, problem.type, problem.message, (problem.log || problem.message).replace(/\.$/, '') + ' (after ' + forwarded +
    ' chunk' + (forwarded === 1 ? '' : 's') + '; model ' + model + ')'));
  await writeSse(res, 'data: ' + JSON.stringify({ error: { message: problem.message, type: problem.type } }) + '\n\n');
  if (!res.writableEnded) res.end();
}

// One model's attempt: relays the stream, or sends the failure; → { modelLimited }
// when the model (or its provider) is rate-limited and nothing has been sent yet.
async function streamWith(res, chatRequest, ctx, signal, tokenRetried) {
  const now0 = Date.now();
  const resting = modelRestingUntil(chatRequest.model, now0);
  if (resting) return { modelLimited: modelLimitedFailure(chatRequest.model, resting, now0) };
  const provider = providerOf(chatRequest.model);
  if (providerRestingUntil(provider, now0)) return { modelLimited: providerRestFailure(provider, now0) };
  const attempt = await openStream(chatRequest, signal);
  if (attempt.failed === 'aborted') return;
  if (attempt.failed) return sendFailure(res, describeFailure(attempt, ctx));
  const upstream = attempt.response;
  if (!upstream.ok) {
    const r = await readErrorBody(attempt);
    if (r.failed === 'aborted') return;
    if (r.failed) return sendFailure(res, describeFailure(r, ctx));
    if (!tokenRetried && tokenRefused(r) && tokenChanged()) return streamWith(res, chatRequest, ctx, signal, true);
    if (r.status === 429) return { modelLimited: onLimited(describeFailure(r, ctx), chatRequest.model, Date.now()) };
    return sendFailure(res, describeFailure(r, ctx));
  }
  if (!/^text\/event-stream/i.test(upstream.headers.get('content-type') || '')) {
    attempt.cancel();
    attempt.finish();
    return sendFailure(res, fail(502, 'malformed_response', 'The AI service didn\'t send a stream for a streaming request.',
      'content-type ' + redact(upstream.headers.get('content-type') || 'missing', 60)));
  }
  return await relayStream(res, attempt, chatRequest.model);
}

// Streaming chat; a rate-limited model (or one whose provider is resting) is
// swapped for the closest similar one before anything is sent (see answerChat).
async function streamChat(res, prep) {
  const client = watchClient(res);
  try {
    const { chatRequest, ctx } = prep;
    const tried = new Set();
    let model = ctx.model, switches = 0;
    for (;;) {
      tried.add(model);
      const out = await streamWith(res, Object.assign({}, chatRequest, { model }), Object.assign({}, ctx, { model }), client.signal);
      if (!out || !out.modelLimited) return;
      const alt = prep.switchModels && switches < MAX_RATE_LIMIT_SWITCHES ? await closestModel(ctx.model, chatRequest, tried) : null;
      if (!alt) return sendFailure(res, out.modelLimited);
      switches++;
      noteSwitch(ctx.model, alt, 'rate_limited');
      model = alt;
      setFallbackHeaders(res, { fallback: alt, fallbackReason: 'rate_limited', requested: ctx.model });
    }
  } finally {
    client.release();
  }
}

// ── AI routes ─────────────────────────────────────────────────────────────────
// POST /api/ai — chat completion. The frontend's existing contract is kept:
// the body is an OpenAI-format request (x-provider: openai, the default) or an
// Anthropic-format one (x-provider: anthropic); the answer comes back in the
// same format; errors are { error: { message } } with an HTTP status. Any
// API key the browser sends (x-api-key, from the old Settings key box) is
// ignored: the providers' keys live only in the AI service.
// Checks and resolves one chat request (the body of POST /api/ai).
// → { failure } or { format, chatRequest, ctx, explicit }
// opts.switchModels: false = don't answer with a similar model when this one is rate-limited, or when a
//   model picked in Settings is failing (the server's default model still falls back when its provider can't run it)
// opts.pickedFallback: false = a model picked in Settings that its provider can't run right now isn't swapped
//   (AI Coding batches pause and try the same model again instead, so every post is coded by it)
async function prepareChat(body, formatName, opts) {
  const format = FORMATS[formatName];
  if (!format) return { failure: fail(400, 'invalid_request', 'Unknown provider: ' + redact(formatName, 40)) };
  const notReady = notConfigured();
  if (notReady) return { failure: notReady };
  let chatRequest;
  try {
    chatRequest = format === 'anthropic' ? fromAnthropicRequest(body) : fromOpenAIRequest(body);
  } catch (err) {
    if (err instanceof RequestError) return { failure: fail(400, 'invalid_request', 'Invalid AI request: ' + err.message) };
    throw err;
  }
  const resolved = await resolveModel(chatRequest.model);
  if (!resolved.ok) return { failure: resolved };
  chatRequest.model = resolved.model;
  const unsupported = capabilityProblem(chatRequest, resolved.info);
  if (unsupported) return { failure: unsupported };
  const askedFor = safeModelId(body && body.model);
  return {
    format, chatRequest,
    ctx: { model: resolved.model, verified: resolved.verified, source: resolved.source },
    explicit: !!askedFor && (askedFor === resolved.model || askedFor === resolved.renamedFrom),    // picked in Settings, not the server default
    switchModels: switchingAllowed() && !(opts && opts.switchModels === false),
    pickedFallback: !(opts && opts.pickedFallback === false)
  };
}

// Runs a prepared, non-streaming chat request.
// → { aborted } or { failure } or { json, fallback?, fallbackReason?, requested }
//   (json in the request's format; fallback = the model that answered instead
//   of the requested one, fallbackReason = 'rate_limited' | 'failed')
//
// When the model is rate-limited, or its provider is resting (now, or still
// from earlier), the closest similar model answers instead — even one picked
// in Settings, unless switching is turned off; the same model from another
// provider comes first. When the server's default model fails in other ways
// (its provider can't run it right now, or isn't set up), the closest models
// are tried too. A model the user picked is swapped only when its provider
// can't run it right now (server errors, after retries) and switching is on —
// not when it doesn't exist, the key may not use it or its answers can't be
// read (the user should pick another), and not in AI Coding batches
// (opts.pickedFallback, prepareChat).
async function answerChat(prep, signal) {
  const { chatRequest, ctx, explicit } = prep;
  const swapPicked = explicit && prep.switchModels && prep.pickedFallback;
  const tried = new Set();
  let model = ctx.model, fallback = null, fallbackReason = null;
  let rateSwitches = 0, otherSwitches = 0, result;
  let own = null;               // how the model asked for failed (or was failing, when it was skipped)
  for (;;) {
    tried.add(model);
    const now = Date.now();
    const resting = modelRestingUntil(model, now);
    const providerResting = !resting && providerRestingUntil(providerOf(model), now);
    // The model is failing at the moment: a similar model answers, without waiting on it (closestModel
    // leaves out providers failing as a whole: with none left, the model is tried after all)
    if (!resting && !providerResting && model === ctx.model && (!explicit || swapPicked) && modelDownUntil(model, now)) {
      const alt = await closestModel(ctx.model, chatRequest, tried);
      if (alt) { own = modelDownFailure(ctx.model); otherSwitches++; noteSwitch(ctx.model, alt, 'failed'); model = alt; fallback = alt; fallbackReason = 'failed'; continue; }
    }
    result = resting ? modelLimitedFailure(model, resting, now)
      : providerResting ? providerRestFailure(providerOf(model), now)
      : await completeChat(Object.assign({}, chatRequest, { model }), Object.assign({}, ctx, { model, verified: ctx.verified || model !== ctx.model }), signal);
    if (result.aborted) return { aborted: true };
    if (result.ok) { onModelAnswered(model); break; }
    if (result.type === 'upstream_error') onModelServerError(model, result.upstreamStatus, Date.now());
    if (model === ctx.model) own = result;
    let why = null;
    if ((result.type === 'model_rate_limited' || isProviderLimit(result)) && prep.switchModels && rateSwitches < MAX_RATE_LIMIT_SWITCHES) why = 'rate_limited';
    // (once switching, a similar model that fails in its own way — not offered, not allowed for the
    // key, unreadable answers — is skipped too; a provider failing as a whole isn't switched to: closestModel)
    else if ((((!explicit || fallbackReason) && fallbackType(result)) || (swapPicked && TEMPORARY_MODEL_FAILURES.has(result.type))) &&
      otherSwitches < 2) why = fallbackReason === 'rate_limited' ? 'rate_limited' : 'failed';
    if (!why) break;
    const alt = await closestModel(ctx.model, chatRequest, tried);     // closest to what was asked for
    if (!alt) break;
    if (why === 'rate_limited') rateSwitches++; else otherSwitches++;
    noteSwitch(ctx.model, alt, why);
    model = alt; fallback = alt; fallbackReason = why;
  }
  // The search ended on a similar model's own problem (not offered, not allowed for the key, rate-limited,
  // its provider resting…): what to report is what happened to the model asked for. Not when that
  // model's provider as a whole is the problem (failing for every model): that is what to say
  if (!result.ok && model !== ctx.model && own && (result.type === 'model_rate_limited' || isProviderLimit(result) || fallbackType(result)) &&
    !(result.type === 'upstream_error' && serviceTrouble(Date.now(), providerOf(model)))) result = own;
  if (!result.ok && result.type === 'model_rate_limited') {
    const others = Array.from(tried).filter(m => m !== ctx.model && modelRestingUntil(m, Date.now()));
    const soonest = Math.min(...Array.from(tried).map(m => modelRestingUntil(m, Date.now()) || Infinity));
    let message = 'The AI service is rate-limiting the model "' + modelName(ctx.model) + '"' + (others.length ? ' and the most similar models (' + others.map(m => '"' + modelName(m) + '"').join(', ') + ')' : '') + ' right now.';
    if (Number.isFinite(soonest)) message += ' The first one can be used again ' + describeWhen(soonest, Date.now()) + '.';
    if (!prep.switchModels) message += switchingAllowed() ? ' (Switching to a similar model is turned off in Settings → AI models.)' : ' (AI_MODEL_SWITCH=off in .env turns off switching to a similar model.)';
    result = Object.assign({}, result, { message, retryAfterSeconds: Number.isFinite(soonest) ? Math.max(1, Math.ceil((soonest - Date.now()) / 1000)) : result.retryAfterSeconds });
  }
  if (!result.ok && result.type === 'upstream_error') {
    // Say which models failed, and whether it's their provider (or the service) as a whole
    const failed = result === own ? ctx.model : model;
    const provider = providerOf(failed);
    const trouble = serviceTrouble(Date.now(), provider);
    const code = 'HTTP ' + (result.upstreamStatus || 502);
    const others = Array.from(tried).filter(m => m !== ctx.model && modelDownUntil(m, Date.now()));
    result = Object.assign({}, result, trouble ? {
      message: provider
        ? 'The AI provider of "' + modelName(failed) + '" is having server problems right now: ' + trouble.models.length + ' of its models answered with server errors (' + code + ') ' +
          'in the last minute. This is on the provider\'s side, not MetaCode\'s — try again in a few minutes, or pick a model of another provider in Settings → AI models.'
        : 'The AI service is having server problems right now: ' + trouble.models.length + ' different models answered with server errors (' + code + ') in the last minute. ' +
          'This is on the AI providers\' side, not MetaCode\'s — try again in a few minutes.',
      retryAfterSeconds: 30, serviceTrouble: true
    } : {
      message: 'The AI service couldn\'t run the model "' + modelName(ctx.model) + '"' + (others.length ? ' or the most similar model' + (others.length === 1 ? '' : 's') + ' (' + others.map(m => '"' + modelName(m) + '"').join(', ') + ')' : '') +
        ' right now: it answered with a server error (' + code + ') each time MetaCode tried. This is on the AI provider\'s side and usually passes; try again in a moment.'
    });
  }
  if (!result.ok && explicit && fallbackType(result) && result.type !== 'malformed_response' && !result.serviceTrouble) {
    result = Object.assign({}, result, { message: result.message.replace(/\.?$/, '.') + ' This happened with the model "' + modelName(ctx.model) +
      '" you picked — choose another one in Settings → AI models (or "Server default").' });
  }
  if (!result.ok) return { failure: result };
  return { json: prep.format === 'anthropic' ? toAnthropicResponse(result.completion) : result.completion, fallback, fallbackReason, requested: ctx.model };
}

// Tells the browser which model answered when it wasn't the one asked for
function setFallbackHeaders(res, out) {
  if (!out.fallback) return;
  res.set('X-MetaCode-Model-Fallback', out.fallback);
  res.set('X-MetaCode-Model-Fallback-Reason', out.fallbackReason || 'failed');
  res.set('X-MetaCode-Model-Requested', out.requested || '');
}

app.post('/api/ai', accounts.aiSingle, async (req, res) => {
  try {
    const switchModels = !/^(off|no|false|0)$/i.test(String(req.headers['x-metacode-model-switch'] || ''));
    const prep = await prepareChat(req.body, String(req.headers['x-provider'] || 'groq').toLowerCase(), { switchModels });
    if (prep.failure) return sendFailure(res, prep.failure);
    if (prep.chatRequest.stream) return await streamChat(res, prep);
    const client = watchClient(res);
    let out;
    try { out = await answerChat(prep, client.signal); } finally { client.release(); }
    if (out.aborted) return;                          // the browser left; nobody to answer
    if (out.failure) return sendFailure(res, out.failure);
    setFallbackHeaders(res, out);
    res.json(out.json);
  } catch (err) {
    console.error('[ai] Unexpected error in /api/ai: ' + redact(err && err.message));
    if (!res.headersSent) res.status(500).json({ error: { message: 'Something went wrong in MetaCode\'s AI service.', type: 'internal_error' } });
    else if (!res.writableEnded) res.end();
  }
});

// POST /api/ai/batch — many chat requests answered by several copies of the
// same model in parallel (AI Coding). Body:
//   { requests: [{ id, body }], parallel: 1…AI_MAX_PARALLEL, delayMs: 0…5000, switchModels?: false, system?: text }
// (each body is what POST /api/ai takes, OpenAI format; `system`, when given,
// is put before each request's messages as its system message, so a codebook
// prompt shared by every post is sent once — the browser also sends a long
// run as several batches, which keeps each request small enough for a web
// server's body limit in front of MetaCode). The answer is NDJSON,
// one line per request as soon as it finishes, in any order:
//   { id, ok: true, data, fallback?, fallbackReason?, requested? }  or  { id, ok: false, status, error: { message, type } }
// (fallback: the similar model that answered because the requested one was rate-limited or failing)
// then { done: true, parallel } — parallel is how many ran at the end (it is
// lowered when the AI service rate-limits). Closing the connection stops the batch.
// When the AI service answers with server errors (or the connection drops, or it's restarting), the batch pauses
// (5 s — AI_BATCH_PAUSE_SECONDS — doubling up to 60 s), runs fewer at once and tries the request
// again (up to 4 times); it goes back up as answers arrive. Each pause is
// announced with a line { notice: { type, message, waitSeconds, parallel } }.
// If the AI service keeps failing through 5 pauses (about 2 minutes) without a single
// answer, the rest of the batch fails with type 'service_unavailable'
// instead of being sent.
const AI_BATCH_MAX_REQUESTS = 2000;
// The first pause after a server error in a batch (AI_BATCH_PAUSE_SECONDS, default 5); it doubles up to 60 s.
function aiBatchPauseSeconds() {
  const n = parseFloat(process.env.AI_BATCH_PAUSE_SECONDS);
  return Number.isFinite(n) && n >= 0.05 ? Math.min(60, n) : 5;
}
function aiMaxParallel() {
  const n = parseInt(process.env.AI_MAX_PARALLEL, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : 16;
}
app.post('/api/ai/batch', accounts.aiBatch, (req, res) => aiBatchRoute(req, res));
// (also behind the desktop app's guard: /api/desktop/ai/batch, desktop-api/)
async function aiBatchRoute(req, res) {
  const list = req.body && Array.isArray(req.body.requests) ? req.body.requests : null;
  if (!list || !list.length) return sendFailure(res, fail(400, 'invalid_request', 'Send a non-empty "requests" list.'));
  if (list.length > AI_BATCH_MAX_REQUESTS) return sendFailure(res, fail(400, 'invalid_request', 'At most ' + AI_BATCH_MAX_REQUESTS + ' requests per batch.'));
  if (list.some(r => !r || typeof r !== 'object' || !r.body || typeof r.body !== 'object' || r.body.stream)) {
    return sendFailure(res, fail(400, 'invalid_request', 'Each request needs an "id" and a non-streaming "body".'));
  }
  const system = req.body.system;
  if (system !== undefined && system !== null && typeof system !== 'string') return sendFailure(res, fail(400, 'invalid_request', '"system" must be text.'));
  const withSystem = body => (system && Array.isArray(body.messages) ? Object.assign({}, body, { messages: [{ role: 'system', content: system }].concat(body.messages) }) : body);
  const notReady = notConfigured();
  if (notReady) return sendFailure(res, notReady);
  const max = aiMaxParallel();
  let parallel = Math.max(1, Math.min(max, parseInt(req.body.parallel, 10) || 1));
  const delayMs = Math.max(0, Math.min(5000, parseInt(req.body.delayMs, 10) || 0));
  const switchModels = req.body.switchModels !== false;

  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const client = watchClient(res);
  const send = obj => { if (!res.writableEnded && !client.signal.aborted) res.write(JSON.stringify(obj) + '\n'); };
  const wait = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); client.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });

  // The plan's posts left this week (accounts/): the rest of the batch isn't sent
  const allowance = Number.isFinite(req.aiAllowance) ? req.aiAllowance : list.length;
  list.slice(allowance).forEach(r => send({ id: r.id === undefined ? null : r.id, ok: false, status: 429, error: { message: req.aiLimitMessage || 'Your plan\'s AI coding limit is used up.', type: 'limit_reached' } }));
  const queue = list.slice(0, allowance).map(r => ({ id: r.id === undefined ? null : r.id, body: withSystem(r.body), tries: 0, serverTries: 0 }));
  let active = 0, pausedUntil = 0, successes = 0;
  let ceiling = parallel;          // how many may run at once (lowered for good only by rate limits)
  let serverStreak = 0, okStreak = 0, gaveUp = null;
  async function one(item) {
    if (gaveUp) return send({ id: item.id, ok: false, status: 503, error: { message: gaveUp, type: 'service_unavailable' } });
    let out;
    try {
      const prep = await prepareChat(item.body, 'openai', { switchModels, pickedFallback: false });
      out = prep.failure ? { failure: prep.failure } : await answerChat(prep, client.signal);
    } catch (err) {
      console.error('[ai] Unexpected error in /api/ai/batch: ' + redact(err && err.message));
      out = { failure: fail(500, 'internal_error', 'Something went wrong in MetaCode\'s AI service.') };
    }
    if (out.aborted) return;
    if (out.failure && out.failure.status === 429 && (out.failure.type === 'rate_limited' || out.failure.type === 'model_rate_limited') && item.tries < 3) {
      // The AI service asked us to slow down: fewer copies at once, a short pause, then this one again
      item.tries++;
      if (parallel > 1) { parallel = Math.max(1, Math.floor(parallel / 2)); console.warn('[ai] Rate-limited during a batch; running ' + parallel + ' at once now.'); }
      ceiling = Math.min(ceiling, parallel);
      pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(30, out.failure.retryAfterSeconds || 2 * item.tries) * 1000);
      queue.unshift(item);
      return;
    }
    if (out.failure && (BATCH_TRANSIENT.has(out.failure.type) || out.failure.transient)) {
      okStreak = 0;
      const now = Date.now();
      // Requests that were already running when the batch paused don't make the pause longer
      if (pausedUntil <= now) {
        if (serverStreak >= 5) {
          gaveUp = 'MetaCode stopped sending requests: the AI service kept failing for about 2 minutes (last: ' + out.failure.message.replace(/\.$/, '') + '). ' +
            'This is on the AI service\'s side. Try again later — what was already done is kept.';
          console.error('[ai] The AI service kept failing during a batch; the rest of it was not sent.');
        } else {
          serverStreak++;
          const waitSeconds = Math.round(10 * Math.min(60, Math.max(out.failure.retryAfterSeconds || 0, aiBatchPauseSeconds() * 2 ** (serverStreak - 1)))) / 10;
          if (parallel > 1) parallel = Math.max(1, Math.floor(parallel / 2));
          pausedUntil = now + waitSeconds * 1000;
          console.warn('[ai] ' + out.failure.type + ' during a batch; pausing ' + waitSeconds + ' s, then ' + parallel + ' at once.');
          send({ notice: { type: out.failure.type, message: out.failure.message, waitSeconds, parallel } });
        }
      }
      if (!gaveUp && item.serverTries < 4) { item.serverTries++; queue.unshift(item); return; }
    }
    if (out.failure) {
      logFailure(out.failure);
      const error = { message: out.failure.message, type: out.failure.type };
      if (out.failure.retryAfterSeconds) error.retryAfterSeconds = out.failure.retryAfterSeconds;
      send({ id: item.id, ok: false, status: out.failure.status, error });
      return;
    }
    serverStreak = 0;
    // Answers are coming again: back up to full speed, one more at a time
    if (++okStreak >= 3 && parallel < ceiling) { parallel++; okStreak = 0; }
    successes++;
    send(Object.assign({ id: item.id, ok: true, data: out.json }, out.fallback ? { fallback: out.fallback, fallbackReason: out.fallbackReason, requested: out.requested } : {}));
  }
  async function worker(slot) {
    let first = true;
    while (!client.signal.aborted) {
      if (slot >= parallel) {                          // the batch was scaled down: wait in case it goes back up
        if (slot >= ceiling || (!queue.length && !active)) return;
        await wait(250);
        continue;
      }
      if (!queue.length) { if (!active) return; await wait(100); continue; }
      if (gaveUp) { await one(queue.shift()); continue; }      // the rest fails at once, without calling the AI service
      const now = Date.now();
      if (pausedUntil > now) { await wait(pausedUntil - now); continue; }
      if (!first && delayMs) await wait(delayMs);
      first = false;
      if (client.signal.aborted || slot >= parallel || !queue.length) continue;
      const item = queue.shift();
      active++;
      try { await one(item); } finally { active--; }
    }
  }
  try {
    await Promise.all(Array.from({ length: parallel }, (_, i) => worker(i)));
    send({ done: true, parallel: ceiling });
  } finally {
    if (req.settleAi) req.settleAi(successes);     // only answered posts count against the plan
    client.release();
    if (!res.writableEnded) res.end();
  }
}

// Batch failures worth a pause and another try: provider server errors, and failures flagged `transient`
// (a dropped or refused connection, the service shutting down: it's restarting).
// Timeouts aren't: each one already took AI_TIMEOUT_MS.
const BATCH_TRANSIENT = new Set(['upstream_error']);
// Failures that a different model may not have (its provider can't run it right now, or isn't set up).
const MODEL_FALLBACK_TYPES = new Set(['upstream_error', 'malformed_response', 'model_not_found', 'not_found', 'permission_error', 'not_configured']);
// …of which this one passes (the provider can't run the model right now): a model picked in Settings is swapped only for it
const TEMPORARY_MODEL_FAILURES = new Set(['upstream_error']);
// (not_configured counts only for one provider: MetaCode's own setup problems apply to every model)
function fallbackType(f) {
  return MODEL_FALLBACK_TYPES.has(f.type) && !(f.type === 'not_configured' && !f.provider);
}

// GET /api/models — the model list for the Settings dropdown, from the AI
// service, default model first (the frontend selects the first entry when the
// saved model isn't listed), then in the service's order (by provider). Shape:
//   { models: [{ id, name, provider?, providerName?, free?, available?, toolCall?, reasoning?, attachment?, contextWindow?, maxOutput? }],
//     providers: [{ id, name, ready }], provider: 'opencode', source: 'opencode', note? }
// available: true = offered now; false = listed but not offered right now; absent = not known.
app.get('/api/models', async (req, res) => {
  const base = { provider: 'opencode', source: 'opencode' };
  try {
    const notReady = notConfigured();
    if (notReady) return res.json(Object.assign({ models: [], providers: [] }, base, { note: notReady.message }));
    const list = await getModelList(true);
    if (!list.ok) {
      logFailure(list);
      return res.json(Object.assign({ models: [], providers: [] }, base, { note: list.message }));
    }
    const choice = chooseDefaultModel(list);
    const ordered = (choice.model ? [choice.model] : []).concat(list.ids.filter(id => id !== choice.model));
    const labels = modelLabels(ordered, list.info);
    const models = ordered.map(id => {
      const info = list.info.get(id);
      const entry = { id, name: labels.get(id) + (id === choice.model ? ' (default)' : '') };
      if (info.provider) entry.provider = info.provider;
      if (info.providerName) entry.providerName = info.providerName;
      if (info.free !== null) entry.free = info.free;
      if (info.available !== null) entry.available = info.available;
      if (info.toolCall !== null) entry.toolCall = info.toolCall;
      if (info.reasoning !== null) entry.reasoning = info.reasoning;
      if (info.attachment !== null) entry.attachment = info.attachment;
      if (info.context) entry.contextWindow = info.context;
      if (info.output) entry.maxOutput = info.output;
      return entry;
    });
    const body = Object.assign({ models, providers: list.providers }, base);
    const note = choice.error ? choice.error.message : choice.warning;
    if (note) body.note = note;
    res.json(body);
  } catch (err) {
    console.error('[ai] Unexpected error in /api/models: ' + redact(err && err.message));
    res.json(Object.assign({ models: [], providers: [] }, base, { note: 'Couldn\'t load the model list.' }));
  }
});

// Display names for a list of models: two providers offering a model under the
// same name get " · <provider name>" ("Claude Opus 5.5 · OpenCode Zen"); two
// entries of one provider with the same name get their model id.
function modelLabels(ids, info) {
  const labels = new Map(ids.map(id => [id, (info.get(id) || {}).name || id]));
  const count = () => { const n = {}; labels.forEach(l => { n[l] = (n[l] || 0) + 1; }); return n; };
  let n = count();
  ids.forEach(id => { const i = info.get(id); if (n[labels.get(id)] > 1 && i && i.providerName) labels.set(id, labels.get(id) + ' · ' + i.providerName); });
  n = count();
  ids.forEach(id => { if (n[labels.get(id)] > 1) labels.set(id, labels.get(id) + ' (' + splitModel(id).model + ')'); });
  return labels;
}

// What the service reports about a provider, field by field (so nothing else
// it might add reaches the browser); keys only as their masked ids.
function publicProvider(p) {
  if (!p || typeof p !== 'object' || !safeModelId(p.id)) return null;
  const num = v => (Number.isFinite(v) ? v : null);
  const text = (v, max) => plainText(v, max);
  const quota = q => (q && typeof q === 'object' ? {
    window: ['day', 'week', 'month'].includes(q.window) ? q.window : null, limitPrompts: num(q.limitPrompts), limitTokens: num(q.limitTokens),
    remainingPrompts: num(q.remainingPrompts), remainingTokens: num(q.remainingTokens), resetAt: text(q.resetAt, 40), updatedAt: text(q.updatedAt, 40)
  } : null);
  const key = k => {
    if (!k || typeof k !== 'object') return null;
    const masked = typeof k.masked === 'string' && k.masked.length <= 8 ? k.masked : '••••';
    const entry = { masked, status: ['available', 'cooling_down', 'invalid'].includes(k.status) ? k.status : 'available',
      cooldownSecondsLeft: num(k.cooldownSecondsLeft) || 0, requestCount: num(k.requestCount) || 0 };
    if (quota(k.quota)) entry.quota = quota(k.quota);
    return entry;
  };
  const models = p.models && typeof p.models === 'object' ? p.models : null;
  const catalog = p.catalog && typeof p.catalog === 'object' ? p.catalog : null;
  const resting = p.resting && typeof p.resting === 'object' && text(p.resting.until, 40) ? p.resting : null;
  return {
    id: p.id, name: safeModelName(p.name) || p.id, kind: text(p.kind, 40), ready: p.ready === true, problem: text(p.problem),
    warnings: Array.isArray(p.warnings) ? p.warnings.map(w => text(w)).filter(Boolean).slice(0, 20) : [],
    keyCount: Number.isInteger(p.keyCount) ? p.keyCount : 0, free: typeof p.free === 'boolean' ? p.free : null, note: text(p.note),
    models: models ? { listed: num(models.listed), available: num(models.available), source: text(models.source, 80), checkedAt: text(models.checkedAt, 40) } : null,
    catalog: catalog ? { source: text(catalog.source, 20), updatedAt: text(catalog.updatedAt, 40), models: num(catalog.models) } : null,
    resting: resting ? { until: text(resting.until, 40), reason: text(resting.reason, 20), window: text(resting.window, 20) } : null,
    baseHost: text(p.baseHost, 200), proxy: text(p.proxy, 200), transport: text(p.transport, 120),
    keys: Array.isArray(p.keys) ? p.keys.map(key).filter(Boolean).slice(0, 100) : []
  };
}
function serviceProviders(st) {
  return st && st.ok && st.status && Array.isArray(st.status.providers) ? st.status.providers.map(publicProvider).filter(Boolean) : [];
}

// GET /api/keys/status — Settings → AI providers: each provider the service
// has (set up or not, its keys as masked ids with their state and latest
// quota), and the keys flattened for older pages. Never the keys themselves.
app.get('/api/keys/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = { provider: 'opencode', providers: [], keys: [] };
  const off = notConfigured();
  if (off) return res.json(Object.assign(body, { problem: off.message }));
  const st = await freshServiceState(2000);
  if (!st.ok) return res.json(Object.assign(body, { problem: st.failure ? st.failure.message : serviceStarting() ? notRunningMessage() : 'MetaCode\'s AI service didn\'t answer.' }));
  body.providers = serviceProviders(st);
  body.keys = [].concat(...body.providers.map(p => p.keys.map(k => Object.assign({ provider: p.id, source: 'env' }, k))));
  res.json(body);
});

// ── Python / NetworkX bridge ──────────────────────────────────────────────────
const PY_DIR            = path.join(__dirname, 'python');
const PY_ANALYZE_SCRIPT = path.join(PY_DIR, 'network_analysis.py');
const PY_CHECK_SCRIPT   = path.join(PY_DIR, 'check_env.py');

// Runs a python script, trying "python3" then falling back to "python".
// Optionally writes `stdinPayload` (a JS object) to the process's stdin as JSON.
// Always resolves (never rejects) with either the script's parsed JSON output,
// or an { error: "..." } object describing what went wrong.
function runPython(scriptPath, stdinPayload) {
  return new Promise((resolve) => {
    attempt('python3');

    function attempt(cmd) {
      let stdout = '';
      let stderr = '';
      let settled = false;

      function finish(triedCmd, output) {
        if (settled) return;
        if (output === null) {
          // spawn failed outright (e.g. command not found on this system)
          if (triedCmd === 'python3') {
            attempt('python');
          } else {
            settled = true;
            resolve({
              error: 'Python 3 was not found on this system. Install Python 3.9+ ' +
                '(make sure "python3" or "python" is on your PATH), then run: pip install -r requirements.txt'
            });
          }
          return;
        }
        settled = true;
        if (output.stderr) {
          console.error('[python:' + path.basename(scriptPath) + ']', output.stderr.slice(0, 500));
        }
        try {
          resolve(JSON.parse(output.stdout.trim()));
        } catch (e) {
          resolve({
            error: 'Could not parse output from the Python script. ' +
              (output.stderr
                ? ('Details: ' + output.stderr.slice(0, 300))
                : ('Raw output: ' + output.stdout.slice(0, 300)))
          });
        }
      }

      let proc;
      try {
        proc = spawn(cmd, [scriptPath]);
      } catch (e) {
        finish(cmd, null);
        return;
      }

      proc.on('error', () => finish(cmd, null));
      // A script that ends before reading all of its input (NetworkX missing) closes the pipe:
      // that must not take the whole server down (EPIPE); its output says what went wrong
      proc.stdin.on('error', () => {});
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', () => finish(cmd, { stdout: stdout, stderr: stderr }));

      if (stdinPayload !== undefined) {
        proc.stdin.write(JSON.stringify(stdinPayload));
      }
      proc.stdin.end();
    }
  });
}

app.get('/api/network/status', async (req, res) => {
  const status = await runPython(PY_CHECK_SCRIPT);
  res.json(status);
});

// Body: { edges: [{ source, target, weight }] } or, smaller, { edgeRows: [[source, target, weight]] }; labels; directed
app.post('/api/network/analyze', accounts.feature('network', { meter: 'networkRuns' }), async (req, res) => {
  const body  = req.body || {};
  const edges = Array.isArray(body.edgeRows) ? body.edgeRows.filter(Array.isArray).map(r => ({ source: r[0], target: r[1], weight: r[2] })) : body.edges;
  if (!Array.isArray(edges) || edges.length === 0) {
    return res.status(400).json({ error: { message: 'No edges provided for analysis.' } });
  }
  const result = await runPython(PY_ANALYZE_SCRIPT, {
    edges: edges,
    labels: body.labels || {},
    directed: !!body.directed
  });
  if (result && result.error) {
    return res.status(500).json({ error: { message: result.error } });
  }
  res.json(result);
});

// ── Reddit scraper ────────────────────────────────────────────────────────────
// Jobs, custom-code sandbox and the Wisp/epoxy-tls networking live in
// scraper/ (see docs/reddit-scraper.md). /api/scraper/* is the API;
// /scramjet/* serves the in-app Reddit browser's Scramjet files; the Wisp
// WebSocket endpoint (/wisp/) is attached to the HTTP server in start().
// The AI Scraper (beta) asks MetaCode's AI service like the other AI features
// (same models, fallbacks and quota handling). Its agent
// (python/ai_scraper.py) never sees a key.
const scraperAi = {
  problem() { return aiProblem(); },
  async chat(messages, opts) {
    const aiError = f => new ScraperError('ai_error', 'MetaCode\'s AI service: ' + f.message, { status: f.status || 502 });
    const prep = await prepareChat({ model: (opts && opts.model) || undefined, messages, temperature: 0.2, max_tokens: 1000 }, 'openai');
    if (prep.failure) throw aiError(prep.failure);
    const out = await answerChat(prep, opts && opts.signal);
    if (out.aborted) throw cancelledError();
    if (out.failure) throw aiError(out.failure);
    const c = out.json && out.json.choices && out.json.choices[0];
    return { text: String((c && c.message && c.message.content) || ''), model: out.fallback || out.requested };
  }
};
const scraper = createScraper({ ai: scraperAi, policy: accounts.scraperPolicy, adminGuard: accounts.admin() });

// ── AI Coding Lab (ai-lab/, Ultra) ────────────────────────────────────────────
// The Lab reaches MetaCode's AI service through this narrow interface, like the
// AI Scraper: the same providers, quotas and model list, never a key. It
// asks for exactly the model it names — no similar-model switching — so a
// conversation or an evaluation run records the model that really answered.
//
// A response object that collects what streamChat() writes (server-sent
// events, or a JSON error before the stream starts) and hands each chunk on,
// so the Lab can stream the AI service's answer without a second streaming client.
class CapturedResponse extends require('events').EventEmitter {
  constructor(onText) {
    super();
    this.onText = onText;
    this.statusCode = 200; this.headers = {}; this.headersSent = false;
    this.writableEnded = false; this.writableFinished = false; this.destroyed = false;
    this.jsonBody = null;
  }
  status(code) { this.statusCode = code; return this; }
  set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; }
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
  getHeader(k) { return this.headers[String(k).toLowerCase()]; }
  flushHeaders() { this.headersSent = true; }
  write(chunk) { if (this.destroyed) return false; this.headersSent = true; this.onText(String(chunk)); return true; }
  json(obj) { this.headersSent = true; this.jsonBody = obj; this.end(); return this; }
  end(chunk) { if (chunk) this.write(chunk); if (this.writableEnded) return; this.writableEnded = true; this.writableFinished = true; this.emit('finish'); this.emit('close'); }
  // The Lab's caller went away (Stop): watchClient() sees the close and cancels the AI request
  destroy() { if (this.destroyed || this.writableEnded) return; this.destroyed = true; this.emit('close'); }
}

const labAi = {
  name: 'MetaCode AI service',
  problem() { return aiProblem(); },
  // → { ok, models: [{ id, name, provider, providerName, free, toolCall, reasoning, contextWindow, maxOutput, available }], default } | { ok: false, message }
  // (ids that look like image or audio models are left out unless the service named them)
  async models() {
    const notReady = notConfigured();
    if (notReady) return { ok: false, message: notReady.message };
    const list = await getModelList(false);
    if (!list.ok) return { ok: false, message: list.message };
    const choice = chooseDefaultModel(list);
    return {
      ok: true, default: choice.model || null, source: list.source,
      models: list.ids.filter(id => list.info.get(id).named || !NOT_A_CHAT_MODEL.test(splitModel(id).model)).map(id => {
        const info = list.info.get(id);
        return { id, name: info.name, provider: info.provider || null, providerName: info.providerName || null, free: info.free,
          toolCall: info.toolCall, reasoning: info.reasoning, contextWindow: info.context || null, maxOutput: info.output || null, available: info.available };
      })
    };
  },
  // One chat request (OpenAI format) → { completion, model } | { failure } | { aborted }
  async chat(body, opts) {
    const prep = await prepareChat(body, 'openai', { switchModels: false });
    if (prep.failure) return { failure: prep.failure };
    const out = await answerChat(prep, opts && opts.signal);
    if (out.aborted) return { aborted: true };
    if (out.failure) return { failure: out.failure };
    return { completion: out.json, model: out.fallback || prep.ctx.model };
  },
  // Streamed: onChunk(chunk) for each chat.completion.chunk → { model } | { failure } | { aborted }
  async stream(body, opts) {
    const prep = await prepareChat(Object.assign({}, body, { stream: true }), 'openai', { switchModels: false });
    if (prep.failure) return { failure: prep.failure };
    const parser = createSseParser();
    let failure = null, done = false;
    const res = new CapturedResponse(text => {
      for (const ev of parser.push(text)) {
        if (ev.data.trim() === '[DONE]') { done = true; continue; }
        const chunk = parseJson(ev.data);
        if (chunk && chunk.error) failure = { status: 502, type: chunk.error.type || 'upstream_error', message: chunk.error.message || 'The AI stream failed.' };
        else if (chunk && opts && opts.onChunk) opts.onChunk(chunk);
      }
    });
    const signal = opts && opts.signal;
    const onAbort = () => res.destroy();
    if (signal) { if (signal.aborted) return { aborted: true }; signal.addEventListener('abort', onAbort, { once: true }); }
    try { await streamChat(res, prep); } finally { if (signal) signal.removeEventListener('abort', onAbort); }
    if (signal && signal.aborted) return { aborted: true };
    if (res.jsonBody && res.jsonBody.error) return { failure: { status: res.statusCode, type: res.jsonBody.error.type || 'error', message: res.jsonBody.error.message || 'The AI service failed.', retryAfterSeconds: res.jsonBody.error.retryAfterSeconds } };
    if (failure) return { failure };
    if (!done) return { failure: { status: 502, type: 'stream_interrupted', message: 'The AI stream ended before the answer was complete.' } };
    return { model: (res.headers['x-metacode-model-fallback'] || prep.ctx.model) };
  }
};
const { createAiLab } = require('./ai-lab');
const aiLab = createAiLab({ accounts, ai: labAi });
app.use('/api/lab', aiLab.router);
app.get(['/ultra/ai-lab', '/ultra/ai-lab/'], aiLab.page);
// MetaCode Sheets, the desktop app (desktop/): its entitlement, leases and AI routes
const { createDesktopApi } = require('./desktop-api');
const desktopApi = createDesktopApi({ accounts, ai: labAi, aiBatchRoute });
app.use('/api/desktop', desktopApi.router);
// …and downloading it: the download page and stable links to the installers
app.get('/download', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'download.html')); });
app.use('/download', desktopApi.downloads.files);
// Signing in moves what this browser made on the server to the account
accounts.onClaim(async (from, to) => ({ surveys: await surveys.store.reassignOwner(from, to), scraperJobs: scraper.reassignOwner(from, to) }));
app.use('/api/scraper', scraper.router);
app.use('/scramjet', scraper.scramjetRouter);
app.get('/wisp/', scraper.wispPlainHttp);         // only reached when a proxy dropped the WebSocket upgrade

// ── Status page (status.metac0.de, /status) ───────────────────────────────────
// Public: says whether each part works, never how it's configured.
// The AI part asks the service how it is (GET /v1/status, at most once a minute, no prompts spent).
async function aiStatusCheck() {
  if (notConfigured()) return { status: 'off', note: 'AI isn\'t set up on this server.' };
  // (at start, MetaCode may be waiting for a service it doesn't run: its answer first, for up to 10 s)
  if (startupWait) await Promise.race([startupWait, new Promise(resolve => setTimeout(resolve, 10000).unref())]);
  const st = await freshServiceState(60000);
  if (serviceStarting() || startupWait) return { status: 'degraded', note: 'The AI service is starting.' };
  if (!st.ok) return { status: 'outage', note: 'The AI service isn\'t answering.' };
  let now = Date.now();
  const providers = st.status && Array.isArray(st.status.providers) ? st.status.providers.filter(p => p && typeof p === 'object') : null;
  const ready = providers ? providers.filter(p => p.ready === true) : null;
  if (st.status && (st.status.ready === false || (ready && !ready.length))) return { status: 'off', note: 'AI isn\'t set up on this server.' };
  if (ready && ready.length) {
    // Every provider that is set up is resting (usage quota used up, or asked to pause)
    const rest = ready.map(p => {
      const own = providerRest.get(p.id);
      const until = Math.max(own && own.until > now ? own.until : 0, p.resting && Date.parse(p.resting.until) > now ? Date.parse(p.resting.until) : 0);
      return until ? { until, quota: (own && own.until > now && own.reason === 'quota') || (p.resting && p.resting.reason === 'quota') } : null;
    });
    if (rest.every(Boolean)) {
      const first = rest.reduce((a, b) => (b.until < a.until ? b : a));
      const when = describeWhen(first.until, now).replace(/ \(.*\)$/, '');
      return { status: 'degraded', note: rest.some(r => r.quota) ? 'The usage quota is used up; AI features resume ' + when + '.' : 'Paused briefly at the AI service\'s request; back ' + when + '.' };
    }
  }
  now = Date.now();
  // Server errors from several models of every provider that is set up (or of an older service's ids without
  // a provider): requests are failing; of some providers: their requests use other providers' models
  const troubled = ready ? ready.filter(p => serviceTrouble(now, p.id)) : [];
  if (serviceTrouble(now, ready ? '' : undefined) || (troubled.length && troubled.length === ready.length)) {
    return { status: 'outage', note: 'The AI service is answering with server errors for several models; AI requests are failing.' };
  }
  if (troubled.length) {
    return { status: 'degraded', note: 'One of the AI providers is answering with server errors for several models' + (switchingAllowed() ? '; requests use the closest model of another provider.' : '.') };
  }
  const failing = Array.from(modelDown.keys()).filter(m => modelDownUntil(m, now)).length;
  const limited = restingModels(now).length;
  const parts = [];
  if (failing) parts.push(failing + ' model' + (failing === 1 ? ' is' : 's are') + ' failing at the AI service');
  if (limited) parts.push(limited + ' model' + (limited === 1 ? ' is' : 's are') + ' rate-limited');
  if (parts.length) return { status: 'degraded', note: parts.join(' and ') + (switchingAllowed() ? '; requests for ' + (failing + limited === 1 ? 'it' : 'them') + ' use the closest similar model.' : '.') };
  return { status: 'operational', note: 'Responding normally.' };
}
let pyProbe = { at: 0, result: null };
async function analysisStatusCheck() {
  if (Date.now() - pyProbe.at > 5 * 60000) pyProbe = { at: Date.now(), result: await runPython(PY_CHECK_SCRIPT) };
  const r = pyProbe.result || {};
  if (r.ok) return { status: 'operational', note: 'Python and NetworkX are ready.' };
  if (/networkx/i.test(String(r.error || ''))) return { status: 'degraded', note: 'Python is available, but NetworkX isn\'t installed.' };
  return { status: 'outage', note: 'Python isn\'t available on this server.' };
}
async function surveyStatusCheck() {
  try {
    await fs.promises.mkdir(surveys.store.dir, { recursive: true });
    await fs.promises.access(surveys.store.dir, fs.constants.W_OK);
    return { status: 'operational', note: 'Published surveys are open and responses are being saved.' };
  } catch (e) { return { status: 'outage', note: 'Responses can\'t be saved right now.' }; }
}
function scraperStatusCheck() {
  const st = scraper.status();
  if (!st.enabled) return { status: 'off', note: 'The scraper is turned off on this server.' };
  if (!st.transport.available) return { status: 'degraded', note: 'Server-side scraping is unavailable; scraping through the browser still works.' };
  return { status: 'operational', note: 'Ready to collect posts.' };
}
const statusMonitor = createStatusMonitor({
  components: [
    { id: 'app', name: 'MetaCode app', description: 'The coding app, Survey Studio and the website', check: () => ({ status: 'operational', note: 'Pages are being served.' }) },
    { id: 'ai', name: 'AI service', description: 'AI Coding, the assistant and column detection', check: aiStatusCheck },
    { id: 'surveys', name: 'Survey publishing & responses', description: 'Published survey links and response collection', check: surveyStatusCheck },
    { id: 'analysis', name: 'Network analysis', description: 'Python / NetworkX for Analyze CSV and network metrics', check: analysisStatusCheck },
    { id: 'scraper', name: 'Reddit scraper', description: 'Collecting posts and comments from Reddit', check: scraperStatusCheck }
  ]
});
app.get('/api/status', statusMonitor.handler);

// ── Settings status (Settings page) ───────────────────────────────────────────
// What MetaCode read from .env and whether AI is ready: file name and
// location, encoding, the NAMES of the settings found (never their values),
// warnings, and the AI service with its providers. Same-origin only (AI_ROUTE).
const STARTED_AT = new Date().toISOString();
const VERSION = (() => {
  try {
    const head = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? (fs.existsSync(path.join(__dirname, '.git', ref)) ? fs.readFileSync(path.join(__dirname, '.git', ref), 'utf8').trim() : null) : head;
    return sha ? sha.slice(0, 7) : null;
  } catch (e) { return null; }
})();
// settings.ai: { provider: 'opencode', ready, problem, warnings,
//   service: { host, mode, managed, running, version, opencode, startedAt, problem },
//   providers: [{ id, name, ready, problem, keyCount, free, note, models: { listed, available }, resting }],
//   defaultModel, defaultModelName, modelSwitch, freeFallback, rateLimitedModels, restingProviders, maxParallel }
// (service.mode is OPENCODE_SERVICE_MANAGED; service.managed: MetaCode runs the service itself;
// service.running: null = not asked yet)
function aiSettings() {
  const now = Date.now();
  const off = notConfigured();
  const sup = supervisor.state();
  const st = serviceState;
  const status = !off && st.ok && st.status && typeof st.status === 'object' ? st.status : null;
  const svc = status && status.service && typeof status.service === 'object' ? status.service : {};
  const ready = aiReady();
  const list = modelList.result;
  const choice = list ? chooseDefaultModel(list) : null;
  const defaultModel = (choice && choice.model) || (status && safeModelId(status.default)) || AI.model || null;
  const defaultInfo = list && defaultModel ? list.info.get(defaultModel) : null;
  return {
    provider: 'opencode', ready,
    problem: off ? off.message : ready ? null : aiProblem(),
    warnings: AI.warnings.concat(status && Array.isArray(status.warnings) ? status.warnings.map(w => plainText(w)).filter(Boolean).slice(0, 30) : []),
    service: {
      host: AI.off ? null : AI.baseHost, mode: AI.managed, managed: sup.managed,
      running: off || serviceStarting() || serviceFailing() || serviceForeign() ? false : st.ok === null ? null : !!st.ok,
      version: plainText(svc.version, 40), opencode: plainText(svc.opencode, 40), startedAt: plainText(svc.startedAt, 40),
      problem: serviceProblem()
    },
    providers: serviceProviders(off ? null : st).map(p => ({ id: p.id, name: p.name, ready: p.ready, problem: p.problem, keyCount: p.keyCount, free: p.free, note: p.note,
      models: p.models ? { listed: p.models.listed, available: p.models.available } : null, resting: p.resting })),
    defaultModel, defaultModelName: defaultInfo && defaultInfo.named ? defaultInfo.name : null,
    modelSwitch: switchingAllowed(),
    freeFallback: AI.freeFallback,
    rateLimitedModels: restingModels(now).map(x => ({ model: x.model, until: new Date(x.until).toISOString() })),
    restingProviders: restingProviders(now).map(x => ({ provider: x.provider, until: new Date(x.until).toISOString(), reason: x.reason })),
    maxParallel: aiMaxParallel()
  };
}
function settingsStatus() {
  const env = envLoader.info || {};
  return {
    env: {
      found: !!env.found, name: env.name || null, where: env.where || null, encoding: env.encoding || null,
      error: env.error || null, keys: env.keys || [], overridden: env.overridden || [], warnings: env.warnings || [],
      searched: env.searched || [], loadedAt: env.loadedAt || null, disabled: !!env.disabled
    },
    ai: aiSettings(),
    server: { version: VERSION, startedAt: STARTED_AT, node: process.version },
    accounts: (() => { const a = accounts.config(); return { enabled: a.enabled, billing: a.stripe.enabled, webhook: !!a.stripe.webhookSecret, problems: a.problems }; })()
  };
}
app.get('/api/settings/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  await freshServiceState(10000);
  res.json(settingsStatus());
});

// Everything MetaCode learned about the service and its models starts over
function resetAiState() {
  modelList.generation++;
  Object.assign(modelList, { result: null, fetchedAt: 0, failure: null, failedAt: 0, pending: null });
  serviceState.generation++;
  Object.assign(serviceState, { ok: null, at: 0, status: null, failure: null, pending: null, downSince: 0 });
  clearTimeout(reprobeTimer);
  reprobeTimer = null;
  modelLimits.clear();
  modelDown.clear();
  serverErrors = [];
  providerRest.clear();
  substitutionsLogged.clear();
  serviceTokenCache = null;
  lastStartAttempt = 0;
}

// Re-reads .env without restarting: the AI settings apply at once, and the AI
// service re-reads it too (its providers' keys and models). A service MetaCode
// runs itself is started again when its address or token changed (and what
// answers at the address is looked at again when it wasn't this copy's service).
// Scraper/port settings still need a restart.
app.post('/api/settings/reload', async (req, res) => {
  envLoader.load();
  AI = loadAiConfig(process.env);
  resetAiState();
  try {
    if (JSON.stringify(serviceTarget()) !== serviceTargetKey || serviceForeign()) await startService();
    else if (!notConfigured()) {
      // (POST /v1/reload: the service re-reads .env, its config and catalogs; requests it's working on finish first)
      const r = await aiRequest('POST', '/reload', null, { timeoutMs: 30000, retry: false });
      if (r.failed === 'network' && r.code === 'ECONNREFUSED') {
        if (AI.managed !== 'off') await startService();
      } else if (r.failed || !r.ok) logFailure(describeFailure(r));
    }
  } catch (err) {
    console.error('[settings] Couldn\'t reload the AI service: ' + redact(err && err.message));
  }
  if (!serviceStarting()) await probeService();
  const env = envLoader.info;
  const ai = aiSettings();
  console.log('[settings] .env reloaded: ' + (env.found ? env.keys.length + ' value(s) from ' + env.file : 'no .env file found') + '; AI ' +
    (ai.ready ? 'ready' : 'not ready') + (AI.off ? ' (switched off)' : ' (' + ai.providers.filter(p => p.ready).length + ' provider(s) ready)'));
  res.json(settingsStatus());
});

// ── Health ────────────────────────────────────────────────────────────────────
// aiConfigured: AI isn't switched off or set up wrongly; aiReady: and the AI
// service answered (as last asked) with a provider set up.
app.get('/api/health', (req, res) => {
  res.json({
    status:       'ok',
    provider:     'opencode',
    aiConfigured: !notConfigured(),
    aiReady:      aiReady(),
    node:         process.version
  });
});

// API errors that escape a route (e.g. a malformed JSON body) are answered in
// the usual { error: { message } } format instead of Express's default HTML
// page, which can include a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent || !String(req.path).toLowerCase().startsWith('/api/')) return next(err);
  const status = Number(err && (err.status || err.statusCode));
  if (status >= 400 && status < 500) {
    const message = err.type === 'entity.parse.failed' ? 'The request body isn\'t valid JSON.'
      : status === 413 ? 'The request is too large.'
      : 'The request couldn\'t be read.';
    return res.status(status).json({ error: { message, type: 'invalid_request' } });
  }
  console.error('[server] ' + req.method + ' ' + req.path + ': ' + redact(err && err.message));
  res.status(500).json({ error: { message: 'Something went wrong on the MetaCode server.', type: 'internal_error' } });
});

// ── Start ─────────────────────────────────────────────────────────────────────
// start(port) is also used by the test suite (port 0 = any free port).
function start(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, async () => {
      scraper.setPort(server.address().port);
      aiLab.start();                                         // AI Coding Lab: reloads saved evaluation runs
      // MetaCode's AI service: started here when nothing answers at its address (opencode/supervisor.js)
      try { await startService(); } catch (err) { console.error('[ai] Couldn\'t start the AI service: ' + redact(err && err.message)); }
      if (!serviceStarting()) startupProbe();
      statusMonitor.start();
      resolve(server);
    });
    server.on('error', reject);
    server.on('upgrade', accounts.upgradeGuard(scraper.onUpgrade));
    const close = server.close.bind(server);
    server.close = cb => {
      accounts.flush();
      scraper.shutdown();
      aiLab.shutdown();
      collab.shutdown();
      statusMonitor.stop();
      clearTimeout(reprobeTimer);
      scraper.onUpgrade.closeAll();
      // the AI service MetaCode started goes too (closed is called once it has stopped)
      const stopped = supervisor.stop();
      return close(err => { stopped.then(() => { if (cb) cb(err); }); });
    };
  });
}

// "OpenCode service at 127.0.0.1:4097 (started by MetaCode) — OpenCode Zen: ready (4 models, free only); …"
function aiBanner() {
  const off = notConfigured();
  if (AI.off) return 'switched off (OPENCODE_SERVICE_URL=off)';
  if (off) return 'NOT READY — ' + AI.problem;
  const sup = supervisor.state();
  const how = sup.managed ? 'started by MetaCode' : 'external';
  const head = 'OpenCode service at ' + AI.baseHost + ' (' + how + ')';
  if (sup.managed && sup.problem) return head + ' — not running: ' + sup.problem;
  if (serviceForeign()) return head + ' — not used: ' + serviceForeign();
  if (serviceStarting()) return head + ' — starting…';
  if (serviceState.ok === false) return head + ' — not answering: ' + (serviceState.failure ? serviceState.failure.message : 'no answer');
  return head + ' — ' + serviceSummary(serviceState.status);
}

async function printBanner(PORT) {
  // so the banner can say how the service is (one MetaCode doesn't run: once it answers, or the wait at start is over)
  if (startupWait) await startupWait;
  else if (!notConfigured() && !serviceStarting() && serviceState.ok === null) await probeService();
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║   MetaCode — Social Media Coding Platform ║');
  console.log('  ╚══════════════════════════════════════════╝\n');
  console.log('  Running at → http://localhost:' + PORT);
  console.log('  Status     → http://localhost:' + PORT + '/status  (and ' + (process.env.STATUS_HOST || 'status.metac0.de') + ' when its DNS points here)');
  const env = envLoader.info;
  if (env.found && !env.error) console.log('  Settings   → ' + env.file + ' (' + env.keys.length + ' value' + (env.keys.length === 1 ? '' : 's') + (env.encoding && env.encoding !== 'UTF-8' ? ', ' + env.encoding : '') + ')');
  else if (env.error) console.warn('  ⚠ ' + env.file + ': ' + env.error);
  else if (!env.disabled) console.log('  Settings   → no .env file in ' + __dirname + ' (copy .env.example to .env to add keys)');
  env.warnings.forEach(w => console.warn('  ⚠ ' + w));
  if (env.overridden.length) console.warn('  ⚠ .env replaced system environment variables: ' + env.overridden.join(', '));
  console.log('  AI         → ' + aiBanner());
  AI.warnings.forEach(w => console.warn('  ⚠ ' + w));
  ['GROQ_API_KEY', 'ANTHROPIC_API_KEY'].forEach(name => {
    if (process.env[name]) console.warn('  ⚠ ' + name + ' is set but no longer used: MetaCode\'s AI goes through its OpenCode service.');
  });
  console.log('  Python     → child_process bridge ready (auto-detects python3/python)');
  const sc = scraper.status();
  console.log('  Scraper    → ' + (!sc.enabled ? 'off (SCRAPER_ENABLED=false)'
    : (sc.defaultEngine === 'browser' ? 'default: your browser via Scramjet (no setup); server: ' : 'server: ') +
      (sc.mode === 'oauth' ? 'Reddit Data API (OAuth app credentials)' : 'public Reddit pages' + (sc.respectRobotsTxt ? ', robots.txt respected' : '')) +
      ' — HTTPS via ' + (sc.transport.setting === 'epoxy' ? 'epoxy-tls over Wisp (' + sc.transport.wispPath + ')'
        : 'Python (python/reddit_fetch.py' + (sc.transport.setting === 'auto' ? '; epoxy-tls over Wisp if Python is missing' : '') + ')')));
  if (sc.enabled) {
    const cc = sc.customCode;
    console.log('  Sandbox    → ' + (!cc.available ? 'custom code unavailable — ' + cc.reason
      : (cc.python.available ? 'Python in ' + cc.python.runtime + ' (' + cc.python.memoryMb + ' MB)' : 'Python unavailable — ' + cc.python.reason) +
        (cc.languages.includes('javascript') ? '; JavaScript/TypeScript in QuickJS (' + cc.memoryMb + ' MB)' : '') +
        '; ' + Math.round(cc.timeoutMs / 1000) + ' s limit'));
    const viaEnv = [sc.credentials.source === 'env' && 'Reddit app (REDDIT_CLIENT_ID/SECRET)', sc.redditApis.source === 'env' && 'RedditAPIs.com (REDDITAPIS_KEY)'].filter(Boolean);
    if (viaEnv.length) console.log('  API keys   → from .env: ' + viaEnv.join(', '));
    scraper.config.warnings.forEach(w => console.warn('  ⚠ ' + w));
  }
  console.log('\n  Open http://localhost:' + PORT + ' in your browser.\n');
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  start(PORT).then(server => {
    printBanner(server.address().port);
    // Ctrl+C / pm2 stop: the AI service MetaCode started stops with it
    const shutdown = () => {
      server.close();
      supervisor.stop().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 7000).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }, err => {
    console.error('[server] Couldn\'t start: ' + redact(err && err.message));
    process.exit(1);
  });
}

module.exports = { app, start, scraper, accounts, aiLab, desktopApi, collab };
