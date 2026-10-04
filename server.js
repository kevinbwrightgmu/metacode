const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');
// Read the settings file (.env): next to server.js, the folder the server was
// started from, or the folder above; UTF-16 files and ".env.txt" work too, and
// its values win over stale system variables. See env-file.js.
const { createEnvLoader } = require('./env-file');
const envLoader = createEnvLoader(__dirname);
envLoader.load();

const { createScraper } = require('./scraper');
const { createSurveys } = require('./surveys');
const { createProjects } = require('./projects');

const app = express();

// The AI routes spend the EMIS quota of the key(s) configured on this server,
// and the scraper routes make requests to Reddit on this server's behalf, so
// only MetaCode's own pages (same origin) may call them. The other routes
// keep the permissive CORS they always had.
const AI_ROUTE   = /^\/api\/(ai(\/batch)?|models|keys\/status|settings\/(status|reload)|projects(\/.*)?|scraper(\/.*)?|surveys(\/.*)?|public\/surveys(\/.*)?)\/?$/i;
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
// Survey Studio (surveys/): mounted before the shared JSON parser because
// survey documents (with embedded images) may be larger than its limit.
const surveys = createSurveys();
app.use('/api/surveys', surveys.router);
app.use('/api/public/surveys', surveys.publicRouter);
app.get('/s/:publicId', surveys.pageHandler);
// Saved projects (Projects page) — also before the shared JSON parser (large projects)
const projects = createProjects();
app.use('/api/projects', projects.router);
app.use(express.json({ limit: '10mb' }));
// Pages, scripts and styles are revalidated on every load, so an updated
// MetaCode is never run with yesterday's cached JavaScript.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) { if (/\.(html|js|css|mjs)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache'); }
}));

// ── AI provider: EMIS ─────────────────────────────────────────────────────────
// Every AI feature (AI Coding, the MetaCode Assistant, column detection in
// Import Data and Analyze CSV, Test Connection) posts to /api/ai on this
// server, which forwards the request to EMIS, an OpenAI-compatible gateway:
//
//   browser → POST /api/ai → POST {EMIS_BASE_URL}/chat/completions
//
// The EMIS base URL and key(s) come only from this server's environment
// (.env). The browser can't supply or override them, and they are never
// logged, returned by an endpoint or included in an error message.

const EMIS_DEFAULT_BASE_URL = 'https://emis.zxs-is-very.cool/v1';
const EMIS_EXAMPLE_MODEL    = 'gpt-oss-120b';            // the model EMIS's documentation uses as its example
const MODEL_LIST_TTL_MS     = 5 * 60 * 1000;             // how long a fetched model list is reused
const MODEL_LIST_TIMEOUT_MS = 20 * 1000;
const MODEL_LIST_RETRY_MS   = 15 * 1000;             // after a failed fetch, wait this long before trying again
const DEFAULT_TIMEOUT_MS    = 120 * 1000;
const DEFAULT_COOLDOWN_SEC  = 30;                        // a 429 that carries no reset information
const MAX_COOLDOWN_MS       = 400 * 24 * 3600 * 1000;    // reset times further out than this are ignored as bogus

// Model ids end up in the Settings dropdown, so only plain ids are accepted
// (letters, digits and . _ - : / @ +), never markup.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
function safeModelId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return MODEL_ID_PATTERN.test(id) ? id : null;
}

let EMIS = loadEmisConfig(process.env);   // replaced when .env is reloaded (see /api/settings/reload)

// The model list file (see "Model list" below)
const MODELS_FILE      = path.resolve(__dirname, String(process.env.EMIS_MODELS_FILE || '').trim() || 'emis-models.json');
const MODELS_FILE_NAME = path.basename(MODELS_FILE);

function loadEmisConfig(env) {
  const config = { baseUrl: null, keys: [], model: '', timeoutMs: DEFAULT_TIMEOUT_MS, problem: null, warnings: [] };

  const rawUrl = String(env.EMIS_BASE_URL || '').trim() || EMIS_DEFAULT_BASE_URL;
  let url = null;
  try { url = new URL(rawUrl); } catch (e) { url = null; }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    config.problem = 'EMIS_BASE_URL in the server\'s .env file is not a valid http(s) URL.';
  } else {
    config.baseUrl = (url.origin + url.pathname).replace(/\/+$/, '');
    if (!/\/v1$/.test(config.baseUrl)) {
      config.warnings.push('EMIS_BASE_URL normally ends in /v1 (default: ' + EMIS_DEFAULT_BASE_URL + ').');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      config.warnings.push('EMIS_BASE_URL uses plain http, so the API key would travel unencrypted. Use https.');
    }
  }

  // EMIS_API_KEY may list several keys, comma-separated (same convention as
  // the old GROQ_API_KEY); they're used in rotation.
  String(env.EMIS_API_KEY || '').split(',').forEach((raw, i) => {
    const key = raw.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    if (!key) return;
    if (/\.\.\.|…/.test(key)) {
      config.warnings.push('EMIS_API_KEY entry ' + (i + 1) + ' is still the placeholder from .env.example, so it was ignored.');
    } else if (!/^[\x21-\x7E]+$/.test(key)) {
      config.warnings.push('EMIS_API_KEY entry ' + (i + 1) + ' contains characters that cannot be sent in an HTTP header, so it was ignored.');
    } else if (!config.keys.includes(key)) {
      config.keys.push(key);
    }
  });

  const model = String(env.EMIS_MODEL || '').trim();
  if (model && !safeModelId(model)) config.warnings.push('EMIS_MODEL is not a valid model id, so it was ignored.');
  config.model = safeModelId(model) || '';

  if (env.EMIS_TIMEOUT_MS !== undefined && String(env.EMIS_TIMEOUT_MS).trim() !== '') {
    const ms = Number(env.EMIS_TIMEOUT_MS);
    if (Number.isInteger(ms) && ms >= 1000 && ms <= 600000) config.timeoutMs = ms;
    else config.warnings.push('EMIS_TIMEOUT_MS must be a whole number of milliseconds between 1000 and 600000; using ' + DEFAULT_TIMEOUT_MS + '.');
  }
  return config;
}

// Strips anything secret-looking from text that came from EMIS (or from an
// exception) before it's logged or shown: the configured keys, bearer
// tokens, emis- keys, and URLs (which could reveal internal infrastructure).
function redact(text, max) {
  let s = String(text === undefined || text === null ? '' : text);
  EMIS.keys.forEach(k => { s = s.split(k).join('[redacted]'); });
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
       .replace(/\bemis-[A-Za-z0-9._~+/=-]+/gi, 'emis-[redacted]')
       .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]')
       .replace(/[\u0000-\u001F\u007F]+/g, ' ')
       .replace(/\s{2,}/g, ' ')
       .trim();
  const limit = max || 300;
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

// "emis-…a1b2" for Settings → Key Rotation Status: at most the public
// "emis-" prefix and the last 4 characters. Short keys show nothing.
function maskKey(key) {
  if (!key || key.length < 16) return '••••';
  return (/^emis-/i.test(key) ? key.slice(0, 5) : '') + '…' + key.slice(-4);
}

// How keys are named in the server log: by position, never by value.
function keyLabel(key) {
  return 'key ' + (EMIS.keys.indexOf(key) + 1) + '/' + EMIS.keys.length;
}

// ── Key rotation & EMIS quota ─────────────────────────────────────────────────
// Keys are used round-robin, so load spreads across them. EMIS reports each
// key's quota in X-RateLimit-* headers and answers 429 once the budget is
// used up, until the window resets. A key in that state (or one EMIS asked
// to pause) rests until the reset time EMIS gave and isn't called before
// then; a key EMIS rejects (401/403) is tried after the working ones. Each
// key is tried at most once per request, so nothing retries in a loop.
// State lives in server memory: shared by every browser tab, reset on restart.

// key -> { cooldownUntil, cooldownReason, requestCount, lastUsed, invalid, lastError, quota }
const keyState = new Map();

// EMIS's live model list, cached, and the parsed model list file (see "Model list" below)
const modelList  = { ids: null, fetchedAt: 0, failure: null, failedAt: 0, pending: null };
const modelsFile = { result: null, mtimeMs: null, checkedAt: 0, loads: 0 };

function getKeyState(key) {
  if (!keyState.has(key)) {
    keyState.set(key, { cooldownUntil: null, cooldownReason: null, requestCount: 0, lastUsed: null, invalid: false, lastError: null, quota: null });
  }
  return keyState.get(key);
}

function isResting(state, now) {
  return !!(state.cooldownUntil && state.cooldownUntil > now);
}

let rotationCursor = 0;

// The keys to try for one request, in order: rotated start, resting keys
// left out, rejected keys last.
function keysForRequest(now) {
  const pool = EMIS.keys;
  if (!pool.length) return [];
  const start = rotationCursor % pool.length;
  rotationCursor = (rotationCursor + 1) % pool.length;
  const ready = pool.slice(start).concat(pool.slice(0, start)).filter(k => !isResting(getKeyState(k), now));
  return ready.filter(k => !getKeyState(k).invalid).concat(ready.filter(k => getKeyState(k).invalid));
}

const QUOTA_WINDOWS = new Set(['day', 'week', 'month']);

// Reads EMIS's quota headers. Returns null when a response carries none.
function readQuotaHeaders(headers) {
  const num = name => {
    const value = headers.get(name);
    if (value === null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let reset = num('x-ratelimit-reset');                     // Unix timestamp (seconds)
  if (reset !== null && reset > 1e11) reset = reset / 1000;  // tolerate milliseconds
  const windowName = String(headers.get('x-ratelimit-window') || '').trim().toLowerCase();
  const quota = {
    window:           QUOTA_WINDOWS.has(windowName) ? windowName : null,
    limitPrompts:     num('x-ratelimit-limit-prompts'),
    limitTokens:      num('x-ratelimit-limit-tokens'),
    remainingPrompts: num('x-ratelimit-remaining-prompts'),
    remainingTokens:  num('x-ratelimit-remaining-tokens'),
    resetAt:          reset ? Math.round(reset * 1000) : null
  };
  return Object.values(quota).some(v => v !== null) ? quota : null;
}

function plausibleResetTime(resetAt, now) {
  return resetAt && resetAt > now && resetAt - now <= MAX_COOLDOWN_MS ? resetAt : null;
}

function isLow(quota) {
  if (!quota) return false;
  const low = (left, limit) => left !== null && limit > 0 && left / limit <= 0.1;
  return low(quota.remainingPrompts, quota.limitPrompts) || low(quota.remainingTokens, quota.limitTokens);
}

function describeRemaining(quota) {
  const parts = [];
  if (quota.remainingPrompts !== null) parts.push(quota.remainingPrompts + ' prompt' + (quota.remainingPrompts === 1 ? '' : 's'));
  if (quota.remainingTokens !== null) parts.push(quota.remainingTokens.toLocaleString() + ' tokens');
  return parts.join(' and ') || 'little';
}

// Keeps the latest quota snapshot for a key; a key whose budget is used up
// rests until the window resets.
function recordQuota(key, quota, now) {
  if (!quota) return;
  const state = getKeyState(key);
  const previous = state.quota;
  state.quota = Object.assign({ updatedAt: now }, quota);
  const usedUp = quota.remainingPrompts === 0 || quota.remainingTokens === 0;
  const resetAt = plausibleResetTime(quota.resetAt, now);
  if (usedUp && resetAt) {
    if (!isResting(state, now)) {
      console.warn('[emis] ' + keyLabel(key) + ' has used up its ' + (quota.window ? quota.window + ' ' : '') +
        'quota; it rests until ' + new Date(resetAt).toLocaleString() + '.');
    }
    state.cooldownUntil = resetAt;
    state.cooldownReason = 'quota';
  } else if (isLow(quota) && !isLow(previous)) {
    console.warn('[emis] ' + keyLabel(key) + ' is running low: ' + describeRemaining(quota) + ' left' +
      (quota.window ? ' this ' + quota.window : '') + '.');
  }
}

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

// A 429 from EMIS: the key's budget is used up (or EMIS asked us to pause).
// It rests until X-RateLimit-Reset, else Retry-After, else a short default.
function onQuotaExhausted(key, quota, headers, now) {
  const state = getKeyState(key);
  const resetAt = plausibleResetTime(quota && quota.resetAt, now);
  const waitMs = retryAfterMs(headers.get('retry-after'), now);
  const until = resetAt || now + Math.min(MAX_COOLDOWN_MS, waitMs !== null ? Math.max(1000, waitMs) : DEFAULT_COOLDOWN_SEC * 1000);
  const alreadyLogged = state.cooldownUntil === until;
  state.cooldownUntil = until;
  state.cooldownReason = resetAt ? 'quota' : 'paused';
  state.lastError = 'HTTP 429';
  if (!alreadyLogged) console.warn('[emis] ' + keyLabel(key) + ' got 429 from EMIS; it rests until ' + new Date(until).toLocaleString() + '.');
}

function markKeyRejected(key, r) {
  const state = getKeyState(key);
  state.invalid = true;
  state.lastError = 'HTTP ' + r.status;
  const detail = providerMessage(r);
  console.error('[emis] EMIS rejected ' + keyLabel(key) + ' (HTTP ' + r.status + ')' + (detail ? ': ' + detail.replace(/\.$/, '') : '') + '.');
}

function markKeyUsed(key) {
  const state = getKeyState(key);
  state.requestCount++;
  state.lastUsed = Date.now();
  state.invalid = false;
  state.lastError = null;
}

// ── Talking to EMIS ───────────────────────────────────────────────────────────
const TIMED_OUT   = new Error('EMIS request timed out');
const CLIENT_GONE = new Error('Browser disconnected');
const CANCELLED   = new Error('Request cancelled');

function emisHeaders(key, accept, hasBody) {
  const headers = { 'Authorization': 'Bearer ' + key, 'Accept': accept };
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
// EMIS request can be cancelled instead of spending quota for nobody.
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

// One complete (non-streaming) HTTP exchange with EMIS. Never throws:
// resolves to { status, ok, headers, text, json } or { failed: 'timeout' |
// 'network' | 'aborted' }. Redirects are not followed, so the key is only
// ever sent to the configured EMIS address.
// Outbound proxy: Node's built-in fetch ignores HTTPS_PROXY, so on networks
// that only allow traffic through a proxy (many school and office networks)
// every EMIS request failed with a network error (HTTP 502). EMIS_PROXY, or
// else HTTPS_PROXY / HTTP_PROXY (with NO_PROXY), is used when set.
let proxyAgent = null;
function proxyUrl() {
  return String(process.env.EMIS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
}
function emisFetch(url, init) {
  if (!proxyUrl()) return fetch(url, init);
  const undici = require('undici');
  if (!proxyAgent) proxyAgent = process.env.EMIS_PROXY ? new undici.ProxyAgent(process.env.EMIS_PROXY.trim()) : new undici.EnvHttpProxyAgent();
  return undici.fetch(url, Object.assign({}, init, { dispatcher: proxyAgent }));
}

// Retries an EMIS call that failed for a temporary reason (connection reset,
// EMIS/gateway error 500/502/503/504, timeout status 408, unreadable body):
// up to 2 more tries, 0.6 s then 1.8 s apart. Configuration problems (bad
// address, wrong key, unknown model) aren't retried.
const RETRY_STATUS = new Set([408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const PERMANENT_NETWORK = /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_INVALID_URL)$|CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i;
function isTransient(r) {
  if (r.failed === 'network') return !PERMANENT_NETWORK.test(String(r.code || ''));
  if (r.failed) return false;
  return RETRY_STATUS.has(r.status);   // a 200 is an answer: an empty or odd one is handled by switching to streaming, not by retrying
}
async function emisRequest(method, pathname, key, body, opts) {
  const delays = opts.retry === false ? [] : [600, 1800];
  let r = await emisRequestOnce(method, pathname, key, body, opts);
  for (const ms of delays) {
    if (!isTransient(r) || (opts.signal && opts.signal.aborted)) break;
    console.warn('[emis] ' + method + ' ' + pathname + ' failed (' + (r.failed ? r.failed + ' ' + (r.code || '') : 'HTTP ' + r.status) + '); retrying in ' + (ms / 1000) + ' s');
    await new Promise(resolve => setTimeout(resolve, ms));
    if (opts.signal && opts.signal.aborted) break;
    r = await emisRequestOnce(method, pathname, key, body, opts);
  }
  return r;
}
// EMIS's documentation is written for Python's OpenAI SDK, and Node's own HTTP
// client can be treated differently by the gateway's checks (HTTP 403 or a
// web page instead of an answer). So requests go through a Python worker
// (python/emis_fetch.py: the openai package if installed, else httpx/urllib)
// when Python is available. EMIS_TRANSPORT: auto (default) | python | node.
const { createEmisPython } = require('./emis-python');
const emisPython = createEmisPython();
function emisTransport() { const t = String(process.env.EMIS_TRANSPORT || 'auto').trim().toLowerCase(); return ['python', 'node'].includes(t) ? t : 'auto'; }

async function emisRequestOnce(method, pathname, key, body, opts) {
  const transport = emisTransport();
  if (transport !== 'node' && (!(body && body.stream) || opts.buffered)) {
    const r = await emisPython.request({ method, url: EMIS.baseUrl + pathname, key, body, timeoutMs: opts.timeoutMs, signal: opts.signal, proxy: String(process.env.EMIS_PROXY || '').trim() });
    if (r && !r.failed) return { status: r.status, ok: r.ok, headers: r.headers, text: r.text, json: parseJson(r.text), pathname, via: 'python' };
    if (r && r.failed === 'aborted') return { failed: 'aborted' };
    if (r) console.warn('[emis] Python request to ' + pathname + ' failed (' + r.failed + ' ' + (r.code || '') + '): ' + redact(String(r.message || ''), 300));
    if (transport === 'python') return r ? { failed: r.failed === 'client' ? 'network' : r.failed, code: r.code, detail: r.message } : { failed: 'network', code: 'NO_PYTHON', detail: 'Python wasn\'t found' };
    // auto: try the same request from Node.js before giving up
    const n = await emisRequestNode(method, pathname, key, body, opts);
    if (n.failed && r) n.detail = 'Python: ' + (r.message || r.code) + (n.code ? '; Node.js: ' + n.code : '');
    return n;
  }
  return emisRequestNode(method, pathname, key, body, opts);
}
async function emisRequestNode(method, pathname, key, body, opts) {
  const { controller, unlink } = linkedAbort(opts.signal);
  const timer = setTimeout(() => controller.abort(TIMED_OUT), opts.timeoutMs);
  try {
    const response = await emisFetch(EMIS.baseUrl + pathname, {
      method,
      headers: emisHeaders(key, body && body.stream ? 'text/event-stream' : 'application/json', !!body),
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: controller.signal
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

// EMIS's own explanation from an error response, made safe to log or show.
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

// ── Errors ────────────────────────────────────────────────────────────────────
// Every failure keeps MetaCode's existing error contract — an HTTP status
// plus { error: { message } } — and adds a machine-readable `type`. Messages
// say what to do, never echo keys, headers, URLs or stack traces, and avoid
// pointing at the Settings key box, which EMIS doesn't use.
function timeoutSeconds() {
  return String(EMIS.timeoutMs / 1000);
}

function fail(status, type, message, log) {
  return { ok: false, status, type, message, log: log || null };
}

function notConfigured() {
  if (EMIS.problem) return fail(500, 'not_configured', 'MetaCode\'s AI isn\'t set up correctly: ' + EMIS.problem);
  if (!EMIS.keys.length) {
    return fail(401, 'not_configured', 'MetaCode\'s AI isn\'t set up yet: add your EMIS key to the server\'s .env file ' +
      '(EMIS_API_KEY=…), then click "Reload .env" in Settings (or restart MetaCode).');
  }
  return null;
}

function networkMessage(code) {
  if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return 'Couldn\'t find the EMIS server (address lookup failed). Check your internet connection and EMIS_BASE_URL in the server\'s .env file.';
  if (code === 'ECONNREFUSED') return 'The EMIS server refused the connection. Check EMIS_BASE_URL in the server\'s .env file.';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'Couldn\'t make a secure connection to EMIS (certificate problem).';
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/.test(code)) return 'The connection to EMIS dropped before it answered. Try again.';
  if (/TIMEOUT|ETIMEDOUT/.test(code)) return 'Couldn\'t connect to EMIS in time. Check your internet connection and try again.';
  return 'Couldn\'t reach EMIS. Check your internet connection and try again. If your network only allows the internet through a proxy, add HTTPS_PROXY=http://proxy:port (or EMIS_PROXY) to .env and click Reload .env in Settings.';
}

const MODEL_MISSING = /model[^.]{0,80}(not\s+found|does\s*n[o']?t\s+exist|unknown|is\s+not\s+available|no\s+such)|(unknown|invalid|no\s+such)\s+model/i;

// Turns a failed exchange with EMIS into MetaCode's error format.
// ctx: { model, verified } — the model sent, and whether EMIS's list had it.
function describeFailure(r, ctx) {
  ctx = ctx || {};
  if (r.failed === 'timeout') {
    return fail(504, 'timeout', 'EMIS didn\'t answer within ' + timeoutSeconds() + ' seconds. Try again; if this keeps ' +
      'happening, raise EMIS_TIMEOUT_MS in the server\'s .env file.');
  }
  if (r.failed === 'network') return fail(502, 'network', networkMessage(r.code) + (r.detail ? ' (details: ' + redact(String(r.detail), 300) + ')' : ''), 'network error ' + (r.code || '(no code)') + (r.detail ? ' — ' + r.detail : ''));

  const status = r.status;
  const detail = providerMessage(r);
  const log = 'HTTP ' + status + (detail ? ': ' + detail : '');
  if (status >= 300 && status < 400) {
    return fail(502, 'bad_base_url', 'EMIS answered with a redirect instead of a result. Check EMIS_BASE_URL in the server\'s .env file.', log);
  }
  if (status === 401) {
    return fail(401, 'authentication_error', 'EMIS didn\'t accept the configured key' + (detail ? ' ("' + detail + '")' : '') + '. Check EMIS_API_KEY in the server\'s .env file, then click Reload .env in Settings.', log);
  }
  if (status === 403) {
    if (/^\s*</.test(r.text || '')) {
      return fail(403, 'blocked', 'EMIS\'s website check answered instead of the API (a web page with HTTP 403). MetaCode sends EMIS requests ' +
        'through Python to avoid this — make sure Python 3 is installed (and ideally run "pip install openai"), then restart MetaCode. ' +
        'Also check that EMIS_BASE_URL is ' + EMIS_DEFAULT_BASE_URL + '.', log);
    }
    return fail(403, 'permission_error', 'EMIS refused this request' + (detail ? ': "' + detail + '"' : ' for the configured key') +
      (ctx.model ? ' (model "' + ctx.model + '")' : '') + '. Check EMIS_API_KEY in the server\'s .env file, or pick another model in Settings → AI models.', log);
  }
  if (ctx.model && (status === 404 || ((status === 400 || status === 422) && MODEL_MISSING.test(detail)))) {
    modelList.fetchedAt = 0;                       // EMIS's list may have changed: fetch it again next time
    if (status !== 404 || /model/i.test(detail) || ctx.verified) {
      if (ctx.source === 'file') {
        return fail(404, 'model_not_found', 'EMIS doesn\'t offer the model "' + ctx.model + '", although it\'s listed in ' + MODELS_FILE_NAME + '. ' +
          'Pick another model in Settings → Fetch Models, or update ' + MODELS_FILE_NAME + '.', log);
      }
      return fail(404, 'model_not_found', 'EMIS doesn\'t offer the model "' + ctx.model + '". Pick a model in Settings → Fetch Models, ' +
        'or set EMIS_MODEL in the server\'s .env file.', log);
    }
    return fail(404, 'not_found', 'EMIS answered "not found" for the model "' + ctx.model + '". Check the model (Settings → Fetch Models) ' +
      'and that EMIS_BASE_URL in the server\'s .env file ends in /v1.', log);
  }
  if (status === 404) {
    return fail(502, 'bad_base_url', 'EMIS couldn\'t find the requested endpoint. Check that EMIS_BASE_URL in the server\'s .env file ends in /v1.', log);
  }
  if (status === 408) return fail(504, 'timeout', 'EMIS took too long to answer. Try again.', log);
  if (status === 413) return fail(413, 'request_too_large', 'The request was too large for EMIS. Try a shorter text or a smaller sample.', log);
  if (status === 429) return fail(429, 'rate_limited', 'EMIS asked MetaCode to pause. Try again in a moment.', log);
  if (status >= 500) return fail(502, 'upstream_error', 'EMIS had a temporary server problem (HTTP ' + status + '). Try again in a moment.', log);
  if (status >= 400) {
    return fail(400, 'invalid_request', 'EMIS couldn\'t process the request' + (detail ? ': ' + detail : ' (HTTP ' + status + ').'), log);
  }
  return fail(502, 'malformed_response', 'EMIS sent a response MetaCode couldn\'t read.', log);
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

function allKeysResting(now) {
  return EMIS.keys.length > 0 && EMIS.keys.every(key => isResting(getKeyState(key), now));
}

// Every usable key is resting: answer 429 right away, without calling EMIS,
// saying when the first key becomes available again.
function quotaFailure(now) {
  const resting = EMIS.keys.map(getKeyState).filter(state => isResting(state, now));
  if (!resting.length) return fail(503, 'unavailable', 'No EMIS key is available right now. Try again in a moment.');
  const next = resting.reduce((a, b) => (b.cooldownUntil < a.cooldownUntil ? b : a));
  const until = next.cooldownUntil;
  const when = describeWhen(until, now);
  const windowName = next.quota && next.quota.window;
  const usedUp = next.cooldownReason === 'quota';
  let message;
  if (!usedUp) message = 'EMIS asked MetaCode to pause. Try again ' + when + '.';
  else if (EMIS.keys.length > 1) message = 'Every configured EMIS key has used up its usage quota. The first one resets ' + when + '.';
  else message = 'Your EMIS usage quota' + (windowName ? ' for this ' + windowName : '') + ' is used up. It resets ' + when + '.';
  const failure = fail(429, usedUp ? 'quota_exceeded' : 'rate_limited', message);
  failure.retryAfterSeconds = Math.max(1, Math.ceil((until - now) / 1000));
  failure.resetAt = new Date(until).toISOString();
  if (windowName) failure.window = windowName;
  return failure;
}

// Identical failures can repeat many times a second (AI Coding retries each
// post); the log gets one line per kind of failure per minute.
const recentLogLines = new Map();
function logFailure(f) {
  const line = '[emis] ' + f.status + ' ' + f.type + ' — ' + (f.log || f.message);
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
  res.status(f.status).json({ error });
}

// ── Model list ────────────────────────────────────────────────────────────────
// Where MetaCode gets the models it offers (Settings → Fetch Models) and
// checks each request's model against:
//  1. emis-models.json in this folder (or the file EMIS_MODELS_FILE names):
//     EMIS's model list in OpenCode's config format, i.e. provider.emis.models =
//     { "<model id>": { name, tool_call, reasoning, attachment } }. Edits are
//     picked up without a restart. Only model ids, names and capability flags
//     are read from it; the EMIS address and key always come from .env.
//  2. If that file is missing or unusable: EMIS's live list,
//     GET {EMIS_BASE_URL}/models, cached for a few minutes.
// A request for a model that isn't listed (e.g. a Groq or Claude id still
// saved in someone's browser) gets the default model instead.
const MODELS_FILE_RECHECK_MS = 2000;
const MODELS_FILE_MAX_BYTES  = 2 * 1024 * 1024;

// Display names go into the Settings dropdown's HTML, so only plain text is kept.
function safeModelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[^\p{L}\p{N} ._()/+:,'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return name || null;
}

function capability(value) {
  return typeof value === 'boolean' ? value : null;
}

function parseModelsFile(json) {
  const providers = json && typeof json === 'object' && json.provider && typeof json.provider === 'object' ? json.provider : null;
  const providerNames = providers ? Object.keys(providers) : [];
  const entry = providers ? (providers.emis || (providerNames.length === 1 ? providers[providerNames[0]] : null)) : null;
  if (!entry || !entry.models || typeof entry.models !== 'object' || Array.isArray(entry.models)) {
    return { ok: false, problem: MODELS_FILE_NAME + ' has no provider.emis.models section.' };
  }
  const models = [];
  let skipped = 0;
  Object.keys(entry.models).forEach(rawId => {
    const id = safeModelId(rawId);
    if (!id || models.some(m => m.id === id)) { skipped++; return; }
    const meta = entry.models[rawId] && typeof entry.models[rawId] === 'object' ? entry.models[rawId] : {};
    models.push({ id, name: safeModelName(meta.name) || id, toolCall: capability(meta.tool_call),
                  reasoning: capability(meta.reasoning), attachment: capability(meta.attachment) });
  });
  if (!models.length) return { ok: false, problem: MODELS_FILE_NAME + ' lists no usable models.' };
  const options = entry.options && typeof entry.options === 'object' ? entry.options : {};
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  return {
    ok: true, models, skipped,
    ids: models.map(m => m.id),
    info: new Map(models.map(m => [m.id, m])),
    baseURL: typeof options.baseURL === 'string' ? options.baseURL.trim().replace(/\/+$/, '') : null,
    hasLiteralKey: apiKey !== '' && !/^\{env:[A-Za-z0-9_]+\}$/.test(apiKey)
  };
}

function reportModelsFile(result) {
  if (!result.ok) {
    if (result.missing) {
      if (process.env.EMIS_MODELS_FILE) console.warn('[emis] EMIS_MODELS_FILE points to ' + MODELS_FILE + ', which doesn\'t exist; using EMIS\'s live model list.');
      else if (modelsFile.loads) console.warn('[emis] ' + MODELS_FILE_NAME + ' was removed; using EMIS\'s live model list.');
      return;
    }
    console.warn('[emis] ' + result.problem + ' Using EMIS\'s live model list instead.');
    return;
  }
  if (modelsFile.loads) console.log('[emis] ' + MODELS_FILE_NAME + ' changed: ' + result.models.length + ' models loaded.');
  if (result.skipped) console.warn('[emis] ' + MODELS_FILE_NAME + ': skipped ' + result.skipped + ' entr' + (result.skipped === 1 ? 'y' : 'ies') + ' without a usable model id.');
  if (result.baseURL && EMIS.baseUrl && result.baseURL !== EMIS.baseUrl) {
    console.warn('[emis] ' + MODELS_FILE_NAME + ' was written for ' + result.baseURL + ', but EMIS_BASE_URL is ' + EMIS.baseUrl + '. MetaCode uses EMIS_BASE_URL.');
  }
  if (result.hasLiteralKey) {
    console.warn('[emis] ' + MODELS_FILE_NAME + ' contains an API key. MetaCode never reads keys from this file; keep the key in .env ' +
      '(EMIS_API_KEY) and replace it in this file with {env:EMIS_API_KEY}.');
  }
}

// The file's model list, re-read when the file changes (checked at most
// every couple of seconds). { ok: true, ... } or { ok: false, missing | problem }.
function readModelsFile() {
  const now = Date.now();
  if (modelsFile.result && now - modelsFile.checkedAt < MODELS_FILE_RECHECK_MS) return modelsFile.result;
  modelsFile.checkedAt = now;
  let stat = null;
  try { stat = fs.statSync(MODELS_FILE); } catch (e) { stat = null; }
  if (!stat || !stat.isFile()) {
    if (!modelsFile.result || !modelsFile.result.missing) {
      modelsFile.result = { ok: false, missing: true };
      modelsFile.mtimeMs = null;
      reportModelsFile(modelsFile.result);
    }
    return modelsFile.result;
  }
  if (modelsFile.result && !modelsFile.result.missing && modelsFile.mtimeMs === stat.mtimeMs) return modelsFile.result;
  let result;
  if (stat.size > MODELS_FILE_MAX_BYTES) {
    result = { ok: false, problem: MODELS_FILE_NAME + ' is too large to be a model list.' };
  } else {
    try {
      // (a byte-order mark, as some Windows editors add, isn't valid JSON)
      result = parseModelsFile(JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8').replace(/^\uFEFF/, '')));
    } catch (e) {
      result = { ok: false, problem: MODELS_FILE_NAME + ' couldn\'t be read as JSON (' + redact(e.message, 120) + ').' };
    }
  }
  reportModelsFile(result);
  if (result.ok) modelsFile.loads++;
  modelsFile.result = result;
  modelsFile.mtimeMs = stat.mtimeMs;
  return result;
}

function listLabel(source) {
  return source === 'file' ? MODELS_FILE_NAME : 'EMIS\'s model list';
}

function parseModelList(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) return null;
  const ids = [];
  let skipped = 0;
  json.data.forEach(entry => {
    const id = entry && typeof entry === 'object' ? safeModelId(entry.id) : null;
    if (!id) skipped++;
    else if (!ids.includes(id)) ids.push(id);
  });
  if (skipped) console.warn('[emis] Skipped ' + skipped + ' model list entr' + (skipped === 1 ? 'y' : 'ies') + ' without a usable id.');
  return ids;
}

async function fetchModelList() {
  const keys = EMIS.keys.slice().sort((a, b) => Number(getKeyState(a).invalid) - Number(getKeyState(b).invalid));
  let failure = null;
  for (const key of keys) {
    const r = await emisRequest('GET', '/models', key, null, { timeoutMs: Math.min(EMIS.timeoutMs, MODEL_LIST_TIMEOUT_MS) });
    if (r.failed) return describeFailure(r);
    if (r.status === 401 || r.status === 403) { markKeyRejected(key, r); failure = describeFailure(r); continue; }
    if (r.status === 429) { failure = describeFailure(r); continue; }
    if (!r.ok) return describeFailure(r);
    const ids = parseModelList(r.json);
    if (!ids) return fail(502, 'malformed_response', 'EMIS sent its model list in a format MetaCode couldn\'t read.', 'HTTP ' + r.status + ' without a data array');
    getKeyState(key).invalid = false;
    return { ok: true, ids };
  }
  return failure || notConfigured() || fail(503, 'unavailable', 'No EMIS key is available right now.');
}

// Resolves to { ok: true, ids, info, source } — info is a Map of id → { name,
// toolCall, reasoning, attachment } for the file, null for EMIS's live list —
// or to a failure. For the live list, concurrent callers share one fetch and
// a failure is reused for a few seconds, so a burst of AI requests doesn't
// refetch the list once per request.
function getModelList(forceRefresh) {
  const file = readModelsFile();
  if (file.ok) return Promise.resolve({ ok: true, ids: file.ids, info: file.info, source: 'file' });

  const now = Date.now();
  if (!forceRefresh) {
    if (modelList.ids && now - modelList.fetchedAt < MODEL_LIST_TTL_MS) return Promise.resolve({ ok: true, ids: modelList.ids, info: null, source: 'emis' });
    if (modelList.failure && now - modelList.failedAt < MODEL_LIST_RETRY_MS) return Promise.resolve(modelList.failure);
  }
  if (!modelList.pending) {
    modelList.pending = fetchModelList()
      .catch(err => fail(500, 'internal_error', 'Couldn\'t load EMIS\'s model list.', 'model list: ' + redact(err && err.message)))
      .then(result => {
        if (result.ok) {
          modelList.ids = result.ids;
          modelList.fetchedAt = Date.now();
          modelList.failure = null;
        } else {
          modelList.failure = result;
          modelList.failedAt = Date.now();
        }
        modelList.pending = null;
        return result.ok ? { ok: true, ids: result.ids, info: null, source: 'emis' } : result;
      });
  }
  return modelList.pending;
}

// Default model: EMIS_MODEL if set; otherwise the first model in
// emis-models.json. With EMIS's live list (no file): EMIS's documented example
// model when it's listed, otherwise the first listed model that isn't
// obviously an image, audio or embedding model.
const NOT_A_CHAT_MODEL = /(image|video|dall-?e|sora|veo|imagen|flux|stable-?diffusion|sdxl|tts|whisper|transcri|speech|audio|embed|moderation|rerank|guard)/i;

function chooseDefaultModel(ids, source) {
  if (EMIS.model) {
    if (ids.includes(EMIS.model)) return { model: EMIS.model };
    return { error: fail(500, 'model_not_found', 'The model set in EMIS_MODEL ("' + EMIS.model + '") isn\'t in ' + listLabel(source) + '. ' +
      'Change EMIS_MODEL in the server\'s .env file, or remove it to let MetaCode choose.') };
  }
  if (source === 'file') return ids.length ? { model: ids[0] } : { error: fail(500, 'no_models', MODELS_FILE_NAME + ' lists no models.') };
  if (ids.includes(EMIS_EXAMPLE_MODEL)) return { model: EMIS_EXAMPLE_MODEL };
  const model = ids.find(id => !NOT_A_CHAT_MODEL.test(id)) || ids[0];
  return model ? { model } : { error: fail(502, 'no_models', 'EMIS returned an empty model list.') };
}

const substitutionsLogged = new Set();
function noteSubstitution(from, to, source) {
  if (substitutionsLogged.has(from)) return;
  substitutionsLogged.add(from);
  console.warn('[emis] "' + from + '" isn\'t in ' + listLabel(source) + ', so "' + to + '" is used instead. Choose a model in ' +
    'Settings → Fetch Models, or set EMIS_MODEL in .env.');
}

// When the model list itself can't be loaded for these reasons, a chat
// request would fail the same way, so the request stops here.
const FATAL_LIST_FAILURES = new Set(['timeout', 'network', 'authentication_error', 'permission_error', 'not_configured', 'bad_base_url']);

// → { ok: true, model, verified, source, info } (info: the model's entry
// from emis-models.json, if that's the source) or a failure.
async function resolveModel(requested) {
  const wanted = safeModelId(requested) || '';
  const list = await getModelList(false);
  if (!list.ok) {
    if (FATAL_LIST_FAILURES.has(list.type)) return list;
    // The list is unavailable for another reason (EMIS hiccup): send the
    // configured or requested model unverified and let EMIS decide.
    const model = EMIS.model || wanted;
    return model ? { ok: true, model, verified: false, source: 'emis', info: null } : list;
  }
  const pick = model => ({ ok: true, model, verified: true, source: list.source, info: list.info ? list.info.get(model) || null : null });
  if (wanted && list.ids.includes(wanted)) return pick(wanted);
  // Anything else gets the default — the same model Settings shows as selected
  // when the saved one isn't listed, so what's shown is what's used.
  const choice = chooseDefaultModel(list.ids, list.source);
  if (choice.error) return choice.error;
  if (wanted) noteSubstitution(wanted, choice.model, list.source);
  return pick(choice.model);
}

// Capability flags from emis-models.json: a request that needs something the
// model doesn't support is refused with a clear message before calling EMIS.
function capabilityProblem(chatRequest, info) {
  if (!info) return null;
  const per = ' (according to ' + MODELS_FILE_NAME + ')';
  if (info.toolCall === false && Array.isArray(chatRequest.tools) && chatRequest.tools.length) {
    return fail(400, 'unsupported_feature', 'The model "' + info.id + '" doesn\'t support tool calling' + per + '. Pick a model that does.');
  }
  const hasAttachment = chatRequest.messages.some(m => Array.isArray(m.content) && m.content.some(part => part && part.type && part.type !== 'text'));
  if (info.attachment === false && hasAttachment) {
    return fail(400, 'unsupported_feature', 'The model "' + info.id + '" doesn\'t accept images or files' + per + '. Pick a model that does, or send text only.');
  }
  return null;
}

// ── Request formats ───────────────────────────────────────────────────────────
// The frontend still names the request format it speaks in the x-provider
// header: "groq" = OpenAI chat format (the default), "anthropic" = Messages
// format (if Anthropic was picked in Settings). Both are answered by EMIS in
// the matching format; the header no longer selects a provider.
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

// OpenAI chat format → the EMIS request. Only known chat-completion fields
// are forwarded; everything else in the body is dropped.
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

// Anthropic Messages format → the EMIS (OpenAI) request: `system` becomes the
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
function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('');
  }
  return '';
}

// Reads EMIS's reply whatever shape it comes in, as an OpenAI chat completion:
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
// Per model: does EMIS answer it properly when streamed, or plainly? Learned from replies.
const streamPref = new Map();
function streamPreferred(model) { return streamPref.has(model) ? streamPref.get(model) : !!streamPref.get('*'); }
function setStreamPreferred(model, v) {
  if (streamPref.get(model) !== v) console.log('[emis] ' + model + ': using ' + (v ? 'streamed' : 'plain') + ' replies from now on.');
  streamPref.set(model, v);
  if (v) streamPref.set('*', true);   // new models start with what worked
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

// Checks EMIS's completion and makes every choice's message.content a string
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
    choices.push(Object.assign({}, choice, { message: Object.assign({}, choice.message, { content: textContent(choice.message.content) }) }));
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
  console.warn('[emis] ' + model + ' returned an empty answer (finish_reason: ' + (choice.finish_reason || 'none') + ')' +
    (choice.finish_reason === 'length' ? ' — it used its whole max_tokens budget, probably on reasoning.' : '.'));
}

// ── Chat completion (normal JSON response) ───────────────────────────────────
async function completeChat(chatRequest, ctx, signal, retriedLength) {
  const keys = keysForRequest(Date.now());
  if (!keys.length) return quotaFailure(Date.now());
  let rejection = null;
  let limited = false;
  for (const key of keys) {
    const streamFirst = streamPreferred(chatRequest.model);
    const r = await emisRequest('POST', '/chat/completions', key, streamFirst ? Object.assign({}, chatRequest, { stream: true }) : chatRequest, { timeoutMs: EMIS.timeoutMs, signal, buffered: streamFirst });
    if (r.failed === 'aborted') return { aborted: true };
    if (r.failed) return describeFailure(r, ctx);                 // network/timeout: another key won't help
    const now = Date.now();
    const quota = readQuotaHeaders(r.headers);
    recordQuota(key, quota, now);
    if (r.status === 429) { onQuotaExhausted(key, quota, r.headers, now); limited = true; continue; }
    if (r.status === 401 || (r.status === 403 && !/^\s*</.test(r.text || '') && !/model/i.test(providerMessage(r)))) { markKeyRejected(key, r); rejection = describeFailure(r, ctx); continue; }
    if (r.status === 403) return describeFailure(r, ctx);   // a website check or a model this key can't use: not the key's fault
    if (!r.ok) return describeFailure(r, ctx);
    let completion = readReply(r);
    if (!completion && /web page/.test(describeReply(r)) && !/\/v1$/.test(EMIS.baseUrl)) {
      // EMIS_BASE_URL is missing /v1, so the website answered instead of the API: try the API address
      const fixed = EMIS.baseUrl + '/v1';
      console.warn('[emis] ' + EMIS.baseUrl + ' answered with a web page; trying ' + fixed + ' (set EMIS_BASE_URL=' + fixed + ' in .env).');
      const prev = EMIS.baseUrl;
      EMIS.baseUrl = fixed;
      const r2 = await emisRequest('POST', '/chat/completions', key, chatRequest, { timeoutMs: EMIS.timeoutMs, signal });
      completion = r2.ok ? readReply(r2) : null;
      if (!completion) EMIS.baseUrl = prev;
      else EMIS.warnings.push('EMIS_BASE_URL should end in /v1; MetaCode is using ' + fixed + ' until you change .env.');
    }
    let other = null;
    if (!completion) {
      // Empty or unreadable: ask the other way — streamed (as in EMIS's own example) or plain —
      // straight away, and remember what works for this model.
      const asStream = !streamFirst;
      console.warn('[emis] ' + (streamFirst ? 'Streamed' : 'Non-streamed') + ' reply from ' + chatRequest.model + ' unreadable (' + describeReply(r) + replyHeaders(r) + '); asking again ' + (asStream ? 'with stream: true' : 'without streaming') + '.');
      other = await emisRequest('POST', '/chat/completions', key, Object.assign({}, chatRequest, { stream: asStream }), { timeoutMs: EMIS.timeoutMs, signal, buffered: asStream, retry: false });
      if (other.ok) completion = readReply(other);
      if (completion) {
        completion = Object.assign({}, completion, { model: completion.model || chatRequest.model });
        setStreamPreferred(chatRequest.model, asStream);
      }
    } else if (streamFirst === false && streamPref.get(chatRequest.model) === undefined) setStreamPreferred(chatRequest.model, false);
    if (!completion) {
      const what = describeReply(r) + (other ? '; asked ' + (streamFirst ? 'without streaming' : 'with stream: true') + ', it sent ' + (other.failed ? 'nothing (' + other.failed + ' ' + (other.code || '') + ')' : (other.ok ? describeReply(other) : 'HTTP ' + other.status)) : '');
      console.error('[emis] Details: ' + (r.via || 'node') + replyHeaders(r));
      console.error('[emis] Unreadable reply to chat/completions (model ' + chatRequest.model + ', HTTP ' + r.status + '): ' + what);
      return fail(502, 'malformed_response', 'EMIS answered, but not with a chat reply MetaCode can read — it sent ' + what + '.' +
        (/web page/.test(what) ? ' Check that EMIS_BASE_URL in .env is the API address ending in /v1 (default ' + EMIS_DEFAULT_BASE_URL + ').' : ''),
        'HTTP ' + r.status + ': ' + what);
    }
    // A reasoning model can use its whole token budget thinking and return no
    // text: ask once more with a bigger budget.
    const c0 = completion.choices[0];
    if (!String(c0.message.content || '').trim() && c0.finish_reason === 'length' && !retriedLength) {
      const bigger = Math.min(8192, Math.max(1024, (Number(chatRequest.max_tokens) || 256) * 4));
      console.warn('[emis] ' + chatRequest.model + ' used all ' + (chatRequest.max_tokens || '?') + ' tokens without answering; retrying with ' + bigger + '.');
      return completeChat(Object.assign({}, chatRequest, { max_tokens: bigger }), ctx, signal, true);
    }
    markKeyUsed(key);
    noteEmptyAnswer(completion, chatRequest.model);
    return { ok: true, completion };
  }
  return limited ? quotaFailure(Date.now()) : rejection;
}

// ── Chat completion (streaming) ───────────────────────────────────────────────
// With "stream": true (OpenAI format), EMIS's own server-sent events are
// relayed to the browser as they arrive: each chat.completion.chunk once, in
// order, ending with "data: [DONE]". A failure before the stream starts is a
// normal JSON error; a failure after it starts is sent as a final
// `data: {"error": {...}}` event and the stream ends without [DONE]. If the
// browser disconnects, the EMIS request is cancelled.
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

// Opens a streaming request to EMIS. Resolves to an attempt { response, ... }
// or { failed }. The attempt's timer covers the wait for EMIS's response
// headers and, once restarted per chunk, silence between chunks.
async function openStream(key, chatRequest, clientSignal) {
  const { controller, unlink } = linkedAbort(clientSignal);
  let timer = setTimeout(() => controller.abort(TIMED_OUT), EMIS.timeoutMs);
  const attempt = {
    controller,
    restartTimer() { clearTimeout(timer); timer = setTimeout(() => controller.abort(TIMED_OUT), EMIS.timeoutMs); },
    cancel() { if (!controller.signal.aborted) controller.abort(CANCELLED); },
    finish() { clearTimeout(timer); unlink(); }
  };
  try {
    attempt.response = await emisFetch(EMIS.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: emisHeaders(key, 'text/event-stream', true),
      body: JSON.stringify(Object.assign({}, chatRequest, { stream: true })),
      redirect: 'manual',
      signal: controller.signal
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

async function relayStream(res, attempt, key, model) {
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
      return { type: 'malformed_response', message: 'EMIS sent part of the answer in a format MetaCode couldn\'t read.',
               log: 'unreadable stream event (' + payload.length + ' characters)' };
    }
    if (event.event === 'error' || chunk.error) {
      const raw = chunk.error && typeof chunk.error === 'object' ? chunk.error.message : chunk.error;
      const detail = redact(raw, 200);
      return { type: 'upstream_error', message: 'EMIS reported a problem while answering' + (detail ? ': ' + detail : '.') };
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
      outcome = { type: 'timeout', message: 'EMIS stopped sending the answer for ' + timeoutSeconds() + ' seconds, so the stream was ended.' };
    } else {
      outcome = { type: 'network', message: 'The connection to EMIS dropped in the middle of the answer.' };
    }
  } finally {
    attempt.finish();
  }

  if (outcome && outcome.gone) {
    attempt.cancel();
    reader.cancel().catch(() => {});
    console.warn('[emis] The browser disconnected mid-stream; the EMIS request was cancelled.');
    return;
  }
  if (outcome === STREAM_DONE || (!outcome && finishSeen)) {
    reader.cancel().catch(() => {});
    markKeyUsed(key);
    await writeSse(res, 'data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
    return;
  }
  const problem = outcome || { type: 'stream_interrupted', message: 'The EMIS stream ended before the answer was complete.' };
  attempt.cancel();
  reader.cancel().catch(() => {});
  logFailure(fail(502, problem.type, problem.message, (problem.log || problem.message).replace(/\.$/, '') + ' (after ' + forwarded +
    ' chunk' + (forwarded === 1 ? '' : 's') + '; model ' + model + ', ' + keyLabel(key) + ')'));
  await writeSse(res, 'data: ' + JSON.stringify({ error: { message: problem.message, type: problem.type } }) + '\n\n');
  if (!res.writableEnded) res.end();
}

async function streamChat(res, chatRequest, ctx) {
  const client = watchClient(res);
  try {
    const keys = keysForRequest(Date.now());
    if (!keys.length) return sendFailure(res, quotaFailure(Date.now()));
    let rejection = null;
    let limited = false;
    for (const key of keys) {
      const attempt = await openStream(key, chatRequest, client.signal);
      if (attempt.failed === 'aborted') return;
      if (attempt.failed) return sendFailure(res, describeFailure(attempt, ctx));
      const upstream = attempt.response;
      const now = Date.now();
      const quota = readQuotaHeaders(upstream.headers);
      recordQuota(key, quota, now);
      if (!upstream.ok) {
        const r = await readErrorBody(attempt);
        if (r.failed === 'aborted') return;
        if (r.failed) return sendFailure(res, describeFailure(r, ctx));
        if (r.status === 429) { onQuotaExhausted(key, quota, r.headers, now); limited = true; continue; }
        if (r.status === 401 || r.status === 403) { markKeyRejected(key, r); rejection = describeFailure(r, ctx); continue; }
        return sendFailure(res, describeFailure(r, ctx));
      }
      if (!/^text\/event-stream/i.test(upstream.headers.get('content-type') || '')) {
        attempt.cancel();
        attempt.finish();
        return sendFailure(res, fail(502, 'malformed_response', 'EMIS didn\'t send a stream for a streaming request.',
          'content-type ' + redact(upstream.headers.get('content-type') || 'missing', 60)));
      }
      return await relayStream(res, attempt, key, chatRequest.model);
    }
    return sendFailure(res, limited ? quotaFailure(Date.now()) : rejection);
  } finally {
    client.release();
  }
}

// ── AI routes ─────────────────────────────────────────────────────────────────
// POST /api/ai — chat completion. The frontend's existing contract is kept:
// the body is an OpenAI-format request (x-provider: groq, the default) or an
// Anthropic-format one (x-provider: anthropic); the answer comes back in the
// same format; errors are { error: { message } } with an HTTP status. Any
// API key the browser sends (x-api-key, from the old Settings key box) is
// ignored: EMIS is only called with the server's own key.
// Checks and resolves one chat request (the body of POST /api/ai).
// → { failure } or { format, chatRequest, ctx, explicit }
async function prepareChat(body, formatName) {
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
  if (allKeysResting(Date.now())) return { failure: quotaFailure(Date.now()) };
  const resolved = await resolveModel(chatRequest.model);
  if (!resolved.ok) return { failure: resolved };
  chatRequest.model = resolved.model;
  const unsupported = capabilityProblem(chatRequest, resolved.info);
  if (unsupported) return { failure: unsupported };
  const askedFor = safeModelId(body && body.model);
  return {
    format, chatRequest,
    ctx: { model: resolved.model, verified: resolved.verified, source: resolved.source },
    explicit: !!askedFor && askedFor === resolved.model     // picked in Settings, not the server default
  };
}

// Runs a prepared, non-streaming chat request.
// → { aborted } or { failure } or { json, fallback? } (json in the request's format)
async function answerChat(prep, signal) {
  const { chatRequest, ctx, explicit } = prep;
  let result = await completeChat(chatRequest, ctx, signal);
  let fallback = null;
  // The server's default model is failing at EMIS right now: try other models
  // instead of failing the request (a model the user picked isn't swapped).
  if (!result.ok && !result.aborted && !explicit && MODEL_FALLBACK_TYPES.has(result.type)) {
    for (const alt of await fallbackModels(ctx.model)) {
      const altCtx = Object.assign({}, ctx, { model: alt, verified: true });
      const retry = await completeChat(Object.assign({}, chatRequest, { model: alt }), altCtx, signal);
      if (retry.aborted) { result = retry; break; }
      if (retry.ok) {
        console.warn('[emis] The default model "' + ctx.model + '" failed (' + result.type + '); answered with "' + alt + '" instead.');
        fallback = alt;
        result = retry;
        break;
      }
    }
  }
  if (result.aborted) return { aborted: true };
  if (!result.ok && explicit && MODEL_FALLBACK_TYPES.has(result.type) && result.type !== 'malformed_response') {
    result = Object.assign({}, result, { message: result.message.replace(/\.?$/, '.') + ' This happened with the model "' + ctx.model +
      '" you picked — choose another one in Settings → AI models (or "Server default").' });
  }
  if (!result.ok) return { failure: result };
  return { json: prep.format === 'anthropic' ? toAnthropicResponse(result.completion) : result.completion, fallback };
}

app.post('/api/ai', async (req, res) => {
  try {
    const prep = await prepareChat(req.body, String(req.headers['x-provider'] || 'groq').toLowerCase());
    if (prep.failure) return sendFailure(res, prep.failure);
    if (prep.chatRequest.stream) return await streamChat(res, prep.chatRequest, prep.ctx);
    const client = watchClient(res);
    let out;
    try { out = await answerChat(prep, client.signal); } finally { client.release(); }
    if (out.aborted) return;                          // the browser left; nobody to answer
    if (out.failure) return sendFailure(res, out.failure);
    if (out.fallback) res.set('X-MetaCode-Model-Fallback', out.fallback);
    res.json(out.json);
  } catch (err) {
    console.error('[emis] Unexpected error in /api/ai: ' + redact(err && err.message));
    if (!res.headersSent) res.status(500).json({ error: { message: 'Something went wrong in MetaCode\'s AI service.', type: 'internal_error' } });
    else if (!res.writableEnded) res.end();
  }
});

// POST /api/ai/batch — many chat requests answered by several copies of the
// same model in parallel (AI Coding). Body:
//   { requests: [{ id, body }], parallel: 1…AI_MAX_PARALLEL, delayMs: 0…5000 }
// (each body is what POST /api/ai takes, OpenAI format). The answer is NDJSON,
// one line per request as soon as it finishes, in any order:
//   { id, ok: true, data }  or  { id, ok: false, status, error: { message, type } }
// then { done: true, parallel } — parallel is how many ran at the end (it is
// lowered when EMIS rate-limits). Closing the connection stops the batch.
const AI_BATCH_MAX_REQUESTS = 2000;
function aiMaxParallel() {
  const n = parseInt(process.env.AI_MAX_PARALLEL, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : 16;
}
app.post('/api/ai/batch', async (req, res) => {
  const list = req.body && Array.isArray(req.body.requests) ? req.body.requests : null;
  if (!list || !list.length) return sendFailure(res, fail(400, 'invalid_request', 'Send a non-empty "requests" list.'));
  if (list.length > AI_BATCH_MAX_REQUESTS) return sendFailure(res, fail(400, 'invalid_request', 'At most ' + AI_BATCH_MAX_REQUESTS + ' requests per batch.'));
  if (list.some(r => !r || typeof r !== 'object' || !r.body || typeof r.body !== 'object' || r.body.stream)) {
    return sendFailure(res, fail(400, 'invalid_request', 'Each request needs an "id" and a non-streaming "body".'));
  }
  const notReady = notConfigured();
  if (notReady) return sendFailure(res, notReady);
  const max = aiMaxParallel();
  let parallel = Math.max(1, Math.min(max, parseInt(req.body.parallel, 10) || 1));
  const delayMs = Math.max(0, Math.min(5000, parseInt(req.body.delayMs, 10) || 0));

  res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const client = watchClient(res);
  const send = obj => { if (!res.writableEnded && !client.signal.aborted) res.write(JSON.stringify(obj) + '\n'); };
  const wait = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); client.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });

  const queue = list.map(r => ({ id: r.id === undefined ? null : r.id, body: r.body, tries: 0 }));
  let active = 0, pausedUntil = 0;
  async function one(item) {
    let out;
    try {
      const prep = await prepareChat(item.body, 'openai');
      out = prep.failure ? { failure: prep.failure } : await answerChat(prep, client.signal);
    } catch (err) {
      console.error('[emis] Unexpected error in /api/ai/batch: ' + redact(err && err.message));
      out = { failure: fail(500, 'internal_error', 'Something went wrong in MetaCode\'s AI service.') };
    }
    if (out.aborted) return;
    if (out.failure && out.failure.status === 429 && out.failure.type === 'rate_limited' && item.tries < 3) {
      // EMIS asked us to slow down: fewer copies at once, a short pause, then this one again
      item.tries++;
      if (parallel > 1) { parallel = Math.max(1, Math.floor(parallel / 2)); console.warn('[emis] Rate-limited during a batch; running ' + parallel + ' at once now.'); }
      pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(30, out.failure.retryAfterSeconds || 2 * item.tries) * 1000);
      queue.unshift(item);
      return;
    }
    if (out.failure) {
      logFailure(out.failure);
      const error = { message: out.failure.message, type: out.failure.type };
      if (out.failure.retryAfterSeconds) error.retryAfterSeconds = out.failure.retryAfterSeconds;
      send({ id: item.id, ok: false, status: out.failure.status, error });
      return;
    }
    send(Object.assign({ id: item.id, ok: true, data: out.json }, out.fallback ? { fallback: out.fallback } : {}));
  }
  async function worker(slot) {
    let first = true;
    while (!client.signal.aborted) {
      if (slot >= parallel) return;                    // the batch was scaled down
      if (!queue.length) { if (!active) return; await wait(100); continue; }
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
    send({ done: true, parallel });
  } finally {
    client.release();
    if (!res.writableEnded) res.end();
  }
});

// Failures that a different model may not have (EMIS can't run one model right now).
const MODEL_FALLBACK_TYPES = new Set(['upstream_error', 'malformed_response', 'model_not_found', 'not_found', 'permission_error']);
async function fallbackModels(failed) {
  const list = await getModelList(false);
  if (!list.ok) return [];
  return list.ids.filter(id => id !== failed && !NOT_A_CHAT_MODEL.test(id)).slice(0, 2);
}

// GET /api/models — the model list for the Settings dropdown (from
// emis-models.json, or EMIS's live list), default model first: the frontend
// selects the first entry when the saved model isn't listed. Same shape as
// before — { models: [{ id, name }], note? } — plus each model's capability
// flags when the file provides them.
app.get('/api/models', async (req, res) => {
  try {
    const notReady = notConfigured();
    if (notReady) return res.json({ models: [], note: notReady.message });
    const list = await getModelList(true);
    if (!list.ok) {
      logFailure(list);
      return res.json({ models: [], note: list.message });
    }
    const choice = chooseDefaultModel(list.ids, list.source);
    const others = list.ids.filter(id => id !== choice.model);
    if (list.source !== 'file') others.sort((a, b) => a.localeCompare(b));   // the file keeps its own order
    const ordered = (choice.model ? [choice.model] : []).concat(others);
    const infoOf = id => (list.info && list.info.get(id)) || null;
    const nameOf = id => (infoOf(id) ? infoOf(id).name : id);
    const nameCount = {};
    ordered.forEach(id => { nameCount[nameOf(id)] = (nameCount[nameOf(id)] || 0) + 1; });
    const models = ordered.map(id => {
      let name = nameOf(id);
      if (nameCount[name] > 1) name += ' (' + id + ')';          // e.g. two entries both called "GPT-5.5"
      if (id === choice.model) name += ' (default)';
      const entry = { id, name };
      const info = infoOf(id);
      if (info) {
        if (info.toolCall !== null) entry.toolCall = info.toolCall;
        if (info.reasoning !== null) entry.reasoning = info.reasoning;
        if (info.attachment !== null) entry.attachment = info.attachment;
      }
      return entry;
    });
    const body = { models, provider: 'emis', source: list.source === 'file' ? MODELS_FILE_NAME : 'emis' };
    if (choice.error) body.note = choice.error.message;
    res.json(body);
  } catch (err) {
    console.error('[emis] Unexpected error in /api/models: ' + redact(err && err.message));
    res.json({ models: [], note: 'Couldn\'t load EMIS\'s model list.' });
  }
});

// GET /api/keys/status — Settings → Key Rotation Status, for the EMIS keys
// configured on this server: masked id, availability, request count and the
// latest quota EMIS reported. Never the keys themselves.
app.get('/api/keys/status', (req, res) => {
  const now = Date.now();
  const keys = EMIS.keys.map(key => {
    const state = getKeyState(key);
    const resting = isResting(state, now);
    const entry = {
      masked: maskKey(key),
      status: state.invalid ? 'invalid' : (resting ? 'cooling_down' : 'available'),
      cooldownSecondsLeft: resting ? Math.ceil((state.cooldownUntil - now) / 1000) : 0,
      requestCount: state.requestCount,
      source: 'env'
    };
    if (state.quota) {
      const q = state.quota;
      entry.quota = {
        window: q.window, limitPrompts: q.limitPrompts, limitTokens: q.limitTokens,
        remainingPrompts: q.remainingPrompts, remainingTokens: q.remainingTokens,
        resetAt: q.resetAt ? new Date(q.resetAt).toISOString() : null,
        updatedAt: new Date(q.updatedAt).toISOString()
      };
    }
    return entry;
  });
  res.json({ keys, provider: 'emis' });
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

app.post('/api/network/analyze', async (req, res) => {
  const body  = req.body || {};
  const edges = body.edges;
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
const scraper = createScraper();
app.use('/api/scraper', scraper.router);
app.use('/scramjet', scraper.scramjetRouter);

// ── Health ────────────────────────────────────────────────────────────────────
// ── Settings status (Settings page) ───────────────────────────────────────────
// What MetaCode read from .env and whether AI is ready: file name and
// location, encoding, the NAMES of the settings found (never their values),
// warnings, and the EMIS setup. Same-origin only (AI_ROUTE).
const STARTED_AT = new Date().toISOString();
const VERSION = (() => {
  try {
    const head = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? (fs.existsSync(path.join(__dirname, '.git', ref)) ? fs.readFileSync(path.join(__dirname, '.git', ref), 'utf8').trim() : null) : head;
    return sha ? sha.slice(0, 7) : null;
  } catch (e) { return null; }
})();
function settingsStatus() {
  const env = envLoader.info || {};
  const ready = !notConfigured();
  return {
    env: {
      found: !!env.found, name: env.name || null, where: env.where || null, encoding: env.encoding || null,
      error: env.error || null, keys: env.keys || [], overridden: env.overridden || [], warnings: env.warnings || [],
      searched: env.searched || [], loadedAt: env.loadedAt || null
    },
    ai: {
      provider: 'emis', ready, keyCount: EMIS.keys.length, maxParallel: aiMaxParallel(), problem: EMIS.problem || (EMIS.keys.length ? null : 'EMIS_API_KEY isn\'t set in .env.'),
      warnings: EMIS.warnings, baseHost: (() => { try { return new URL(EMIS.baseUrl).host; } catch (e) { return null; } })(),
      defaultModel: EMIS.model || null,
      transport: emisTransport() === 'node' ? 'Node.js' : (emisPython.status().ok ? 'Python ' + emisPython.status().python + ' (' + emisPython.status().client + ')' : (emisTransport() === 'python' ? 'Python — not available: ' + (emisPython.status().problem || 'not started') : 'Node.js (Python not found)')),
      proxy: (() => { const u = proxyUrl(); if (!u) return null; try { return new URL(u).host; } catch (e) { return 'set'; } })()
    },
    server: { version: VERSION, startedAt: STARTED_AT, node: process.version }
  };
}
app.get('/api/settings/status', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(settingsStatus()); });
// Re-reads .env without restarting: the AI (EMIS) settings apply at once;
// scraper/port settings still need a restart.
app.post('/api/settings/reload', (req, res) => {
  envLoader.load();
  EMIS = loadEmisConfig(process.env);
  keyState.clear();
  streamPref.clear();
  proxyAgent = null;
  modelList.ids = null; modelList.fetchedAt = 0; modelList.failure = null; modelList.failedAt = 0;
  const env = envLoader.info;
  console.log('[settings] .env reloaded: ' + (env.found ? env.keys.length + ' value(s) from ' + env.file : 'no .env file found') + '; AI ' + (notConfigured() ? 'not ready' : 'ready (' + EMIS.keys.length + ' key(s))'));
  res.json(settingsStatus());
});

app.get('/api/health', (req, res) => {
  const ready = !notConfigured();
  const keyCount = ready ? EMIS.keys.length : 0;
  res.json({
    status:               'ok',
    provider:             'emis',
    emisConfigured:       ready,
    emisKeyCount:         keyCount,
    // Read by the frontend to tell whether AI is available. Every provider
    // choice in Settings is now answered by EMIS, so both report the number
    // of EMIS keys configured on this server.
    groqEnvKeyCount:      keyCount,
    anthropicEnvKeyCount: keyCount,
    node:                 process.version
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
    const server = app.listen(port, () => {
      scraper.setPort(server.address().port);
      if (emisTransport() !== 'node') emisPython.warm();   // start the Python EMIS worker early
      resolve(server);
    });
    server.on('error', reject);
    server.on('upgrade', scraper.onUpgrade);
    const close = server.close.bind(server);
    server.close = cb => {
      scraper.shutdown();
      scraper.onUpgrade.closeAll();
      emisPython.stop();
      return close(cb);
    };
  });
}

function printBanner(PORT) {
  const fileModels = readModelsFile();        // reports problems with the model list file first
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║   MetaCode — Social Media Coding Platform ║');
  console.log('  ╚══════════════════════════════════════════╝\n');
  console.log('  Running at → http://localhost:' + PORT);
  const env = envLoader.info;
  if (env.found && !env.error) console.log('  Settings   → ' + env.file + ' (' + env.keys.length + ' value' + (env.keys.length === 1 ? '' : 's') + (env.encoding && env.encoding !== 'UTF-8' ? ', ' + env.encoding : '') + ')');
  else if (env.error) console.warn('  ⚠ ' + env.file + ': ' + env.error);
  else if (!env.disabled) console.log('  Settings   → no .env file in ' + __dirname + ' (copy .env.example to .env to add keys)');
  env.warnings.forEach(w => console.warn('  ⚠ ' + w));
  if (env.overridden.length) console.warn('  ⚠ .env replaced system environment variables: ' + env.overridden.join(', '));
  const keyCount = EMIS.keys.length;
  console.log('  AI (EMIS)  → ' + (EMIS.problem ? 'NOT READY — ' + EMIS.problem
    : keyCount ? keyCount + ' key' + (keyCount === 1 ? '' : 's') + ' set via .env ✓'
    : 'Not set — add EMIS_API_KEY to .env to turn on AI features'));
  if (EMIS.baseUrl) console.log('  EMIS API   → ' + EMIS.baseUrl + (emisTransport() === 'node' ? ' (via Node.js)' : ' (via Python when available; EMIS_TRANSPORT=' + emisTransport() + ')'));
  if (fileModels.ok) {
    const choice = chooseDefaultModel(fileModels.ids, 'file');
    console.log('  Models     → ' + fileModels.models.length + ' from ' + MODELS_FILE_NAME + '; default: ' +
      (choice.model ? choice.model + (EMIS.model ? ' (EMIS_MODEL)' : '') : 'none — ' + choice.error.message));
  } else {
    console.log('  Models     → EMIS\'s live list (GET /models)' + (EMIS.model ? '; default: ' + EMIS.model + ' (EMIS_MODEL)' : ''));
  }
  EMIS.warnings.forEach(w => console.warn('  ⚠ ' + w));
  ['GROQ_API_KEY', 'ANTHROPIC_API_KEY'].forEach(name => {
    if (process.env[name]) console.warn('  ⚠ ' + name + ' is set but no longer used: MetaCode now uses EMIS (EMIS_API_KEY).');
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
  start(PORT).then(server => printBanner(server.address().port), err => {
    console.error('[server] Couldn\'t start: ' + redact(err && err.message));
    process.exit(1);
  });
}

module.exports = { app, start, scraper };
