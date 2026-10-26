// ── OpenAI-compatible providers (EMIS) ────────────────────────────────────────
// A provider of MetaCode's OpenCode service that speaks the OpenAI Chat
// Completions protocol to one gateway: EMIS (provider id "emis"), or any other
// "@ai-sdk/openai-compatible" provider in the OpenCode config. What MetaCode's
// server.js used to do for EMIS lives here now, with the same behaviour:
//
//   keys       the API key setting may list several keys, comma-separated; they're
//              used round-robin, each at most once per request. The gateway reports
//              a key's budget in X-RateLimit-* headers (read on every answer) and
//              answers 429 once it's used up (402: no credit left): that key rests
//              until the reset and the next key is tried. A 429 for one model while
//              the key has budget left is that model's (rate_limited, scope 'model':
//              MetaCode rests the model). A key the gateway refuses (401) is tried
//              after the others.
//   transport  non-streamed requests go through python/emis_fetch.py when Python
//              is available (EMIS_TRANSPORT auto | python | node); streams always
//              through Node.js
//   models     emis-models.json (OpenCode's config format), or the gateway's own
//              GET /models; that live list also says which of the file's models
//              are offered right now
//   /v1        a base URL without /v1 that gets the website instead of the API is
//              tried once more with /v1, which is kept when it works
//
// createProvider({id, config, env, dataDir, log, shared}) → {id, name, kind,
// status(), models(), chat(), reload(), close()}, the provider interface of
// opencode/server.mjs. Keys are never logged or put into a message (a key is
// named by its position, "key 2/3").

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LanguageModel } from '@opencode/ai';
import { OpenAICompatible } from '@opencode/ai/providers/openai-compatible';
import { fetch as undiciFetch } from 'undici';
import { toLLMInput } from '../openai.mjs';
import { ServiceError, SHIM_ERROR_TYPE, SHIM_HEADER, SHIM_STATUS_HEADER, describeWait, fromAIError, isServiceError, redact } from '../errors.mjs';
import { createAI, captureMiddleware, substituteMiddleware, chatShims, dispatcherFor, USER_AGENT } from '../http.mjs';

const require = createRequire(import.meta.url);
const { createEmisPython } = require('../emis-python.js');
const REPO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const EMIS_ID = 'emis';
export const EMIS_DEFAULT_BASE_URL = 'https://emis.zxs-is-very.cool/v1';
const EMIS_MODELS_FILE      = 'emis-models.json';
const DEFAULT_TIMEOUT_MS    = 115 * 1000;                // without MetaCode's X-Request-Timeout-Ms
const MODEL_LIST_TTL_MS     = 5 * 60 * 1000;             // how long a fetched model list is reused
const MODEL_LIST_TIMEOUT_MS = 20 * 1000;
const MODEL_LIST_RETRY_MS   = 15 * 1000;                 // after a failed fetch, wait this long before trying again
const AVAILABILITY_WAIT_MS  = 4000;                      // models() waits this long for the first live list
const DEFAULT_COOLDOWN_SEC  = 30;                        // a 429 that carries no reset information
const MAX_COOLDOWN_MS       = 400 * 24 * 3600 * 1000;    // reset times further out than this are ignored as bogus
const MODELS_FILE_RECHECK_MS = 2000;
const MODELS_FILE_MAX_BYTES  = 2 * 1024 * 1024;
const TRANSPORT_HEADER = 'x-oc-transport';               // marks a request for the Python worker (never sent upstream)
const TRANSPORTS = ['auto', 'python', 'node'];
// How the gateway is asked: max_tokens (as MetaCode always sent it), and an answer
// without a finish_reason (some gateways end with [DONE] only) is complete
const COMPATIBILITY = { maxTokensField: 'max_tokens', requireFinishReason: false };

// Model ids end up in MetaCode's model pickers, so only plain ids are accepted
// (letters, digits and . _ - : / @ +), never markup.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
export function safeModelId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return MODEL_ID_PATTERN.test(id) ? id : null;
}
// Display names go into the pickers' HTML, so only plain text is kept.
export function safeModelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[^\p{L}\p{N} ._()/+:,'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return name || null;
}
// Image, audio and embedding models aren't offered from a live list (a file's own entries are kept)
const NOT_A_CHAT_MODEL = /(image|video|dall-?e|sora|veo|imagen|flux|stable-?diffusion|sdxl|tts|whisper|transcri|speech|audio|embed|moderation|rerank|guard)/i;

// The gateway answers 429 when the key's budget runs out; its message can say so before the headers do
// ("Token budget exceeded for this window"). Only wording about the budget counts: a model's own
// limit passed on from its provider often says "quota" or "exhausted" ("Resource has been
// exhausted (e.g. check quota)") while the key has plenty left, and resting the key for that
// would stop every model until the window resets (days, for a weekly one).
export const BUDGET_MESSAGE = /\bbudget\b[^.]{0,40}\b(exceeded|used up|exhausted|spent|reached|run out|depleted)\b|\b(exceeded|used up|exhausted|spent|out of)\b[^.]{0,40}\bbudget\b/i;
const MODEL_MISSING = /model[^.]{0,80}(not\s+found|does\s*n[o']?t\s+exist|unknown|is\s+not\s+available|no\s+such)|(unknown|invalid|no\s+such)\s+model/i;
const QUOTA_WINDOWS = new Set(['day', 'week', 'month']);

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' ? v.trim() : '');
const isOff = v => /^(off|none|false|0|no|disabled)$/i.test(String(v == null ? '' : v).trim());
const isHtml = s => /^\s*</.test(String(s || ''));
const capability = v => (typeof v === 'boolean' ? v : undefined);
const tokens = v => (Number.isInteger(v) && v > 0 && v < 1e8 ? v : undefined);
const parseJson = s => { if (!s) return null; try { return JSON.parse(s); } catch (e) { return undefined; } };   // undefined = not JSON
const NOOP_LOG = { info() {}, warn() {}, error() {} };

// ── Settings ──────────────────────────────────────────────────────────────────

// How messages name this provider's settings: EMIS's .env variables, or the
// OpenCode config's keys for any other OpenAI-compatible provider.
function settingNames(id) {
  if (id === EMIS_ID) {
    return { base: 'EMIS_BASE_URL', key: 'EMIS_API_KEY', proxy: 'EMIS_PROXY / HTTPS_PROXY', transport: 'EMIS_TRANSPORT', where: 'in the server\'s .env file' };
  }
  const at = 'provider.' + id + '.options.';
  return { base: at + 'baseURL', key: at + 'apiKey', proxy: 'HTTPS_PROXY', transport: at + 'transport', where: 'in the OpenCode config' };
}

/**
 * Reads one provider's settings from its (already substituted) config entry,
 * with EMIS's defaults for the provider "emis". Same checks and warnings as
 * MetaCode's loadEmisConfig had.
 *
 * @returns {{baseUrl: string|null, keys: string[], headers: object, transport: 'auto'|'python'|'node',
 *   proxy: string, pythonProxy: string, proxyHost: string|null, modelsFile: string|null,
 *   problem: string|null, warnings: string[]}}
 */
export function loadSettings(id, config, env, repoDir) {
  const isEmis = id === EMIS_ID;
  const names = settingNames(id);
  const options = isObject(config && config.options) ? config.options : {};
  env = env || {};
  const s = { baseUrl: null, keys: [], headers: {}, transport: 'node', proxy: 'env', pythonProxy: '', proxyHost: null, modelsFile: null, problem: null, warnings: [] };

  const rawUrl = text(options.baseURL !== undefined ? options.baseURL : (isEmis ? env.EMIS_BASE_URL : '')) || (isEmis ? EMIS_DEFAULT_BASE_URL : '');
  let url = null;
  try { url = rawUrl ? new URL(rawUrl) : null; } catch (e) { url = null; }
  if (!rawUrl) {
    s.problem = names.base + ' isn\'t set: add the provider\'s API address (usually ending in /v1) ' + names.where + '.';
  } else if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    s.problem = names.base + ' ' + names.where + ' is not a valid http(s) URL.';
  } else {
    s.baseUrl = (url.origin + url.pathname).replace(/\/+$/, '');
    if (isEmis && !/\/v1$/.test(s.baseUrl)) s.warnings.push('EMIS_BASE_URL normally ends in /v1 (default: ' + EMIS_DEFAULT_BASE_URL + ').');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      s.warnings.push(names.base + ' uses plain http, so the API key would travel unencrypted. Use https.');
    }
  }

  // The key setting may list several keys, comma-separated; they're used in rotation.
  const rawKeys = options.apiKey !== undefined ? options.apiKey : (isEmis ? env.EMIS_API_KEY : '');
  String(rawKeys || '').split(',').forEach((raw, i) => {
    const key = raw.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    if (!key) return;
    if (/\.\.\.|…/.test(key) || /^(your[-_]?(api[-_]?)?key|emis[-_]?key|changeme|<[^>]*>)$/i.test(key)) {
      s.warnings.push(names.key + ' entry ' + (i + 1) + ' is still the placeholder from .env.example, so it was ignored.');
    } else if (!/^[\x21-\x7E]+$/.test(key)) {
      s.warnings.push(names.key + ' entry ' + (i + 1) + ' contains characters that cannot be sent in an HTTP header, so it was ignored.');
    } else if (!s.keys.includes(key)) {
      // The gateway's keys start with "emis-" (another OpenAI-compatible EMIS_BASE_URL may differ)
      if (isEmis && !/^emis-/i.test(key) && s.baseUrl === EMIS_DEFAULT_BASE_URL) {
        s.warnings.push('EMIS_API_KEY entry ' + (i + 1) + ' doesn\'t start with "emis-" like the AI gateway\'s keys. It\'s used anyway; check it if AI requests are refused.');
      }
      s.keys.push(key);
    }
  });

  if (isObject(options.headers)) {
    for (const [name, value] of Object.entries(options.headers)) {
      if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/^(authorization|content-type|content-length|host)$/i.test(name) && typeof value === 'string' && /^[\t\x20-\x7E]*$/.test(value)) {
        s.headers[name.toLowerCase()] = value;
      } else {
        s.warnings.push('The header "' + redact(name, [], 40) + '" in provider.' + id + '.options.headers can\'t be sent, so it was ignored (the key goes in ' + names.key + ').');
      }
    }
  }

  const rawTransport = (text(options.transport) || (isEmis ? text(env.EMIS_TRANSPORT) : '')).toLowerCase();
  const fallback = isEmis ? 'auto' : 'node';
  s.transport = TRANSPORTS.includes(rawTransport) ? rawTransport : fallback;
  if (rawTransport && !TRANSPORTS.includes(rawTransport)) s.warnings.push(names.transport + ' must be auto, python or node; ' + fallback + ' is used.');

  // Outbound proxy: EMIS_PROXY (the gateway only), else HTTPS_PROXY / HTTP_PROXY with NO_PROXY
  const own = isEmis ? text(env.EMIS_PROXY) : '';
  if (own) {
    let p = null;
    try { p = new URL(own); } catch (e) { p = null; }
    if (!p || (p.protocol !== 'http:' && p.protocol !== 'https:')) {
      s.problem = s.problem || 'EMIS_PROXY in the server\'s .env file isn\'t an http(s) URL (for example http://proxy.example:3128).';
    } else {
      s.proxy = own;
      s.pythonProxy = own;
      s.proxyHost = p.host;
    }
  } else {
    const envProxy = text(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
    if (envProxy) { try { s.proxyHost = new URL(envProxy).host || 'set'; } catch (e) { s.proxyHost = 'set'; } }
  }

  const rawFile = text(options.models_file) || (isEmis ? text(env.EMIS_MODELS_FILE) || EMIS_MODELS_FILE : '');
  if (rawFile && !isOff(rawFile)) s.modelsFile = path.resolve(repoDir || REPO_DIR, rawFile.replace(/^~(?=$|[\\/])/, os.homedir()));

  if (!s.problem && !s.keys.length) {
    s.problem = isEmis ? 'Add the gateway key to EMIS_API_KEY in .env, then Reload .env.'
      : 'Add an API key for this provider (' + names.key + ' in the OpenCode config), then Reload .env.';
  }
  return s;
}

// ── Quota headers ─────────────────────────────────────────────────────────────

const headerOf = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const v = headers[name];
  return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
};

/**
 * Reads the gateway's quota headers (X-RateLimit-Window, -Limit-Prompts,
 * -Limit-Tokens, -Remaining-Prompts, -Remaining-Tokens, -Reset in Unix seconds;
 * milliseconds tolerated) from a Headers object or a plain lower-case object.
 * @returns {{window, limitPrompts, limitTokens, remainingPrompts, remainingTokens, resetAt}|null} null when there are none
 */
export function readQuotaHeaders(headers) {
  const num = name => {
    const value = headerOf(headers, name);
    if (value === null || String(value).trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let reset = num('x-ratelimit-reset');                     // Unix timestamp (seconds)
  if (reset !== null && reset > 1e11) reset = reset / 1000;  // tolerate milliseconds
  const windowName = String(headerOf(headers, 'x-ratelimit-window') || '').trim().toLowerCase();
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

// A key's budget is prompts and/or tokens per day, week or month (EMIS's
// documentation). One kind is spent when nothing of it is left — unless its
// limit is 0 too: a key without that kind of budget may report 0 of 0.
export function budgetUsedUp(quota) {
  const spent = (left, limit) => left === 0 && limit !== 0;
  return !!quota && (spent(quota.remainingPrompts, quota.limitPrompts) || spent(quota.remainingTokens, quota.limitTokens));
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

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
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

// ── Model list file ───────────────────────────────────────────────────────────

/**
 * Reads a model list in OpenCode's config format (emis-models.json):
 * provider.<id>.models, or the only provider's, as {"<model id>": {name,
 * tool_call, reasoning, attachment, temperature, limit: {context, output},
 * status}}. Deprecated models are left out.
 * @returns {{ok: true, models: object[], skipped: number, baseURL: string|null, hasLiteralKey: boolean}|{ok: false, problem: string}}
 */
export function parseModelsFile(json, id, fileName) {
  const providers = isObject(json) && isObject(json.provider) ? json.provider : null;
  const providerNames = providers ? Object.keys(providers) : [];
  const entry = providers ? (providers[id] || (providerNames.length === 1 ? providers[providerNames[0]] : null)) : null;
  if (!isObject(entry) || !isObject(entry.models)) {
    return { ok: false, problem: fileName + ' has no provider.' + id + '.models section.' };
  }
  const models = [];
  let skipped = 0;
  Object.keys(entry.models).forEach(rawId => {
    const modelId = safeModelId(rawId);
    if (!modelId || models.some(m => m.id === modelId)) { skipped++; return; }
    const meta = isObject(entry.models[rawId]) ? entry.models[rawId] : {};
    if (meta.status === 'deprecated') return;
    models.push(modelInfo(modelId, meta));
  });
  if (!models.length) return { ok: false, problem: fileName + ' lists no usable models.' };
  const options = isObject(entry.options) ? entry.options : {};
  const apiKey = text(options.apiKey);
  return {
    ok: true, models, skipped,
    baseURL: typeof options.baseURL === 'string' ? options.baseURL.trim().replace(/\/+$/, '') : null,
    hasLiteralKey: apiKey !== '' && !/^\{env:[A-Za-z0-9_]+\}$/.test(apiKey)
  };
}

// One model's facts from OpenCode's model format; limits only when stated, never guessed
function modelInfo(modelId, meta) {
  const limit = isObject(meta.limit) ? meta.limit : {};
  return {
    id: modelId, name: safeModelName(meta.name) || modelId,
    toolCall: capability(meta.tool_call), reasoning: capability(meta.reasoning), attachment: capability(meta.attachment), temperature: capability(meta.temperature),
    context: tokens(limit.context), output: tokens(limit.output),
    releaseDate: typeof meta.release_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.release_date) ? meta.release_date : undefined
  };
}

function parseModelList(json) {
  if (!isObject(json) || !Array.isArray(json.data)) return null;
  const ids = [];
  json.data.forEach(entry => {
    const modelId = isObject(entry) ? safeModelId(entry.id) : null;
    if (modelId && !ids.includes(modelId)) ids.push(modelId);
  });
  return ids;
}

// What an unreadable reply looked like, for a message (redacted, short).
function describeReply(r, secrets) {
  const type = String(headerOf(r.headers, 'content-type') || '').split(';')[0];
  const body = typeof r.text === 'string' ? r.text : '';
  if (!body.trim()) return 'an empty reply';
  if (isHtml(body)) return 'a web page (' + (type || 'HTML') + ') instead of an API answer';
  if (isObject(r.json) && r.json.error) {
    const e = r.json.error;
    return 'an error: "' + redact(String(typeof e === 'string' ? e : (e.message || JSON.stringify(e))), secrets, 200) + '"';
  }
  if (isObject(r.json)) return 'JSON with ' + (Object.keys(r.json).slice(0, 8).join(', ') || 'no fields');
  return (type || 'text') + ' starting "' + redact(body.replace(/\s+/g, ' ').slice(0, 200), secrets, 200) + '"';
}

// The gateway's own explanation from an error body, made safe to log or show:
// error.message, error (text), message, detail, or plain text (never a web page).
function providerMessage(body, secrets) {
  const j = typeof body === 'string' ? parseJson(body) : body;
  let message = '';
  if (isObject(j)) {
    if (isObject(j.error) && typeof j.error.message === 'string') message = j.error.message;
    else if (typeof j.error === 'string') message = j.error;
    else if (typeof j.message === 'string') message = j.message;
    else if (typeof j.detail === 'string') message = j.detail;
  } else if (j === undefined && typeof body === 'string' && !isHtml(body)) {
    message = body;
  }
  return message ? redact(message, secrets, 200) : '';
}

// ── The provider ──────────────────────────────────────────────────────────────

/**
 * An OpenAI-compatible provider (EMIS when id is "emis").
 *
 * @param {object} opts
 * @param {string} opts.id          provider id ('emis')
 * @param {object} opts.config      the merged config entry ({env:}/{file:} substituted):
 *   {npm, name, options: {baseURL, apiKey, headers, transport, models_file}, models: {}, whitelist: [], blacklist: []}
 * @param {object} [opts.env]       the service's environment (EMIS_*, proxies); default process.env
 * @param {object} [opts.log]       lib/log.js-style logger ({info, warn, error}(event, fields))
 * @param {object} [opts.shared]    opencode/shared.js (REPO_DIR: where a relative models file is)
 * @returns {{id: string, name: string, kind: 'openai-compatible', status: Function, models: Function,
 *   chat: Function, reload: Function, close: Function}}
 */
export function createProvider(opts) {
  const { id, shared } = opts;
  const repoDir = (shared && shared.REPO_DIR) || REPO_DIR;
  const isEmis = id === EMIS_ID;
  const log = opts.log || NOOP_LOG;
  let config = opts.config || {};
  let env = opts.env || process.env;
  let name = text(config.name) || (isEmis ? 'AI gateway' : id);
  let names = settingNames(id);
  let settings = loadSettings(id, config, env, repoDir);
  let closed = false;

  // key -> { cooldownUntil, cooldownReason, requestCount, lastUsed, invalid, lastError, quota, recentModelLimits }
  let keyState = new Map();
  let rotationCursor = 0;
  // The gateway's live model list, cached; the parsed model list file
  let modelList = { ids: null, fetchedAt: 0, failure: null, failedAt: 0, pending: null, logged: null };
  let modelsFile = { result: null, mtimeMs: null, checkedAt: 0, loads: 0, file: null };
  let python = makePython();
  let client = null;                       // { ai, capture, active, retired }
  let dispatcher = null;                   // { agent } for raw requests (the live model list)

  function makePython() {
    return settings.transport !== 'node' ? createEmisPython({ env }) : null;
  }
  // Starts the Python worker and fetches the live model list early, so the first request doesn't wait
  function warmUp() {
    if (settings.problem || closed) return;
    if (python) python.warm();
    liveList(false).catch(() => null);
  }
  const keyLabel = key => 'key ' + (settings.keys.indexOf(key) + 1) + '/' + settings.keys.length;
  // Keys and the config's header values (a gateway may quote them back in an error) are never shown
  const secrets = () => settings.keys.concat(Object.values(settings.headers).filter(v => v.length >= 8));

  // ── Keys: rotation, resting and quota ──
  function getKeyState(key) {
    if (!keyState.has(key)) {
      keyState.set(key, { cooldownUntil: null, cooldownReason: null, requestCount: 0, lastUsed: null, invalid: false, lastError: null, quota: null });
    }
    return keyState.get(key);
  }
  const isResting = (state, now) => !!(state.cooldownUntil && state.cooldownUntil > now);

  // The keys to try for one request, in order: rotated start, resting keys left out, rejected keys last.
  function keysForRequest(now) {
    const pool = settings.keys;
    if (!pool.length) return [];
    const start = rotationCursor % pool.length;
    rotationCursor = (rotationCursor + 1) % pool.length;
    const ready = pool.slice(start).concat(pool.slice(0, start)).filter(k => !isResting(getKeyState(k), now));
    return ready.filter(k => !getKeyState(k).invalid).concat(ready.filter(k => getKeyState(k).invalid));
  }
  const allKeysResting = now => settings.keys.length > 0 && settings.keys.every(key => isResting(getKeyState(key), now));

  // Keeps the latest quota snapshot for a key; a key whose budget is used up rests until the window resets.
  function recordQuota(key, quota, now) {
    if (!quota || !settings.keys.includes(key)) return;
    const state = getKeyState(key);
    const previous = state.quota;
    state.quota = Object.assign({ updatedAt: now }, quota);
    const resetAt = plausibleResetTime(quota.resetAt, now);
    if (budgetUsedUp(quota) && resetAt) {
      if (!isResting(state, now)) log.warn('key.quota_used_up', { provider: id, key: keyLabel(key), window: quota.window, until: new Date(resetAt).toISOString() });
      state.cooldownUntil = resetAt;
      state.cooldownReason = 'quota';
    } else if (isLow(quota) && !isLow(previous)) {
      log.warn('key.quota_low', { provider: id, key: keyLabel(key), left: describeRemaining(quota), window: quota.window });
    }
  }

  // A 429 for the key: its budget is used up (or the gateway asked to pause); a 402 (status 402):
  // no credit left. It rests until X-RateLimit-Reset, else Retry-After, else a short default.
  function onQuotaExhausted(key, quota, headers, now, status) {
    const state = getKeyState(key);
    const resetAt = plausibleResetTime(quota && quota.resetAt, now);
    const waitMs = retryAfterMs(headerOf(headers, 'retry-after'), now);
    const until = resetAt || now + Math.min(MAX_COOLDOWN_MS, waitMs !== null ? Math.max(1000, waitMs) : DEFAULT_COOLDOWN_SEC * 1000);
    const alreadyLogged = state.cooldownUntil === until;
    state.cooldownUntil = until;
    state.cooldownReason = resetAt || status === 402 ? 'quota' : 'paused';
    state.lastError = 'HTTP ' + (status || 429);
    if (!alreadyLogged) log.warn('key.resting', { provider: id, key: keyLabel(key), reason: state.cooldownReason, until: new Date(until).toISOString() });
  }

  // Several models refused on one key in a short time: the key is being paused.
  function keyWidePause(key, model, now) {
    const state = getKeyState(key);
    state.recentModelLimits = (state.recentModelLimits || []).filter(x => now - x.at < 20000 && x.model !== model);
    state.recentModelLimits.push({ model, at: now });
    if (state.recentModelLimits.length < 3) return false;
    state.recentModelLimits = [];
    return true;
  }

  // A 429 for this key and model: the key's (→ true: rest it, try the next key) or only the model's
  function keyWideLimit(key, model, quota, now, detail) {
    return budgetUsedUp(quota) || BUDGET_MESSAGE.test(detail || '') || (!quota && !!model && keyWidePause(key, model, now)) || !model;
  }

  function markKeyRejected(key, status, detail) {
    const state = getKeyState(key);
    state.invalid = true;
    state.lastError = 'HTTP ' + status;
    log.error('key.rejected', { provider: id, key: keyLabel(key), status, detail });
  }

  function markKeyUsed(key) {
    const state = getKeyState(key);
    state.requestCount++;
    state.lastUsed = Date.now();
    state.invalid = false;
    state.lastError = null;
  }

  // Every usable key is resting: the answer, at once and without calling the gateway, says
  // when the first key becomes available again.
  function quotaFailure(now, model) {
    const resting = settings.keys.map(getKeyState).filter(state => isResting(state, now));
    if (!resting.length) return new ServiceError(503, 'not_configured', 'No key for ' + name + ' is available right now. Try again in a moment.', { provider: id, model });
    const next = resting.reduce((a, b) => (b.cooldownUntil < a.cooldownUntil ? b : a));
    const until = next.cooldownUntil;
    const when = describeWhen(until, now);
    const windowName = next.quota && next.quota.window;
    const usedUp = next.cooldownReason === 'quota';
    let message;
    if (!usedUp) message = name + ' asked MetaCode to pause. Try again ' + when + '.';
    else if (settings.keys.length > 1) message = 'Every configured AI key has used up its usage quota. The first one resets ' + when + '.';
    else message = 'Your AI usage quota' + (windowName ? ' for this ' + windowName : '') + ' is used up. It resets ' + when + '.';
    return new ServiceError(429, usedUp ? 'quota_exceeded' : 'rate_limited', message, {
      provider: id, model, scope: 'provider',
      retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)),
      resetAt: new Date(until).toISOString(),
      window: windowName || undefined
    });
  }

  function notConfigured(model) {
    return new ServiceError(503, 'not_configured', name + ' isn\'t set up: ' + settings.problem, { provider: id, model });
  }

  // ── Errors, in the words MetaCode used for EMIS ──
  const isWebPage = se => se.type === 'malformed_response' && se.code === 'web_page';
  const urlHint = () => 'Check that ' + names.base + ' ' + names.where + ' is the API address ending in /v1' + (isEmis ? ' (default ' + EMIS_DEFAULT_BASE_URL + ').' : '.');

  function networkText(code) {
    if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return 'Couldn\'t find ' + name + ' (address lookup failed). Check this server\'s internet connection and ' + names.base + ' ' + names.where + '.';
    if (code === 'ECONNREFUSED') return name + ' refused the connection. Check ' + names.base + ' ' + names.where + '.';
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'Couldn\'t make a secure connection to ' + name + ' (certificate problem).';
    if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)) return 'The connection to ' + name + ' dropped before it answered. Try again.';
    if (/TIMEOUT|ETIMEDOUT/i.test(code)) return 'Couldn\'t connect to ' + name + ' in time. Check this server\'s internet connection and try again.';
    if (code === 'NO_PYTHON') return names.transport + ' is python, but Python wasn\'t found. Install Python 3, set EMIS_PYTHON, or set ' + names.transport + '=auto.';
    return 'Couldn\'t reach ' + name + '. Check this server\'s internet connection and try again. If this network only allows the internet through a proxy, add HTTPS_PROXY=http://proxy:port' +
      (isEmis ? ' (or EMIS_PROXY)' : '') + ' to .env and click Reload .env in Settings.';
  }

  // The same error with another message
  const reworded = (se, message) => new ServiceError(se.status, se.type, message, {
    code: se.code, provider: se.provider, model: se.model, scope: se.scope, upstreamStatus: se.upstreamStatus,
    retryAfterSeconds: se.retryAfterSeconds, resetAt: se.resetAt, window: se.window, log: se.log, cause: se.cause
  });

  // A ServiceError's message in the old EMIS wording, where that says more (which setting to check)
  function reword(se, detail, model, listed) {
    const quoted = detail ? ' ("' + detail + '")' : '';
    switch (se.type) {
      case 'authentication_error':
        return reworded(se, name + ' didn\'t accept the key' + (settings.keys.length > 1 ? 's' : '') + ' in ' + names.key + quoted + '. Check ' + names.key + ' ' + names.where + ', then click Reload .env in Settings.');
      case 'blocked':
        return reworded(se, 'A web page answered (HTTP 403) instead of ' + name + '\'s API. Its website check doesn\'t apply to API requests made with a key, so check that ' + names.base +
          ' is ' + (isEmis ? EMIS_DEFAULT_BASE_URL + ' (the API address, ending in /v1)' : 'the API address') + ' and that ' + names.key + ' holds your key, then click Reload .env in Settings. ' +
          'If both are right, a proxy or firewall may be answering instead (see ' + names.proxy + ').');
      case 'permission_error':
        return reworded(se, name + ' refused this request' + (detail ? ': "' + detail + '"' : ' for the configured key') + (model ? ' (model "' + model + '")' : '') +
          '. Check ' + names.key + ' ' + names.where + ', or pick another model in Settings → AI models.');
      case 'model_not_found':
        if (listed) {
          return reworded(se, name + ' doesn\'t offer the model "' + model + '", although it\'s listed in ' + listed + quoted + '. Pick another model in Settings → AI models, or update ' + listed + '.');
        }
        return reworded(se, name + ' doesn\'t offer the model "' + model + '"' + quoted + '. Pick another model in Settings → AI models.');
      case 'network':
        return reworded(se, networkText(se.code || ''));
      case 'malformed_response':
        if (isWebPage(se)) return reworded(se, name + ' answered, but not with a chat reply MetaCode can read: it sent a web page instead of an API answer. ' + urlHint());
        if (se.code === 'redirect') return reworded(se, name + ' answered with a redirect' + (se.upstreamStatus ? ' (HTTP ' + se.upstreamStatus + ')' : '') + ' instead of a result. Check ' + names.base + ' ' + names.where + '.');
        return se;
      default:
        return se;
    }
  }

  // The base URL without /v1 got the website, and the same with /v1 worked: that's kept (until Reload .env)
  function fixBaseUrl(baseURL) {
    if (settings.baseUrl !== baseURL) return;
    const fixed = baseURL + '/v1';
    settings.baseUrl = fixed;
    settings.warnings.push(names.base + ' should end in /v1; the AI service is using ' + fixed + ' until you change it ' + names.where + '.');
    log.warn('base_url.fixed', { provider: id, note: names.base + ' answered with the website; /v1 added' });
  }

  // A 429 for one model while the key has budget left (whatever words the gateway used,
  // "quota" included): rate_limited for that model, with the gateway's Retry-After
  function modelLimited(se, entry, detail) {
    if (se.type === 'rate_limited' && se.scope === 'model') return se;
    const wait = se.retryAfterSeconds;
    return new ServiceError(429, 'rate_limited', name + ' is rate-limiting the model "' + entry.id + '" right now' + (detail ? ' ("' + detail + '")' : '') + '.' +
      (wait !== undefined ? ' It can be used again ' + describeWait(wait) + '.' : ' Try again in a moment.'),
    { provider: id, model: entry.id, scope: 'model', upstreamStatus: 429, retryAfterSeconds: wait, log: se.log });
  }

  // Whatever a call threw → the ServiceError MetaCode gets
  function describe(err, entry, signal) {
    const reason = err && err._tag === 'AI.Error' ? err.reason : null;
    const se = fromAIError(err, { provider: id, providerName: name, model: entry && entry.id, secrets: secrets(), signal });
    if (isServiceError(err)) return se;
    const detail = reason ? providerMessage(reason.body, secrets()) : '';
    // python mode: what the Python worker said when it failed (auto sends the request from Node.js instead)
    const py = se.type === 'network' && reason ? /\bPython: .*/.exec(String(reason.message || '')) : null;
    if (py) return reworded(se, networkText(se.code || '') + ' (details: ' + redact(py[0], secrets(), 200) + ')');
    if (se.type === 'model_not_found') {
      modelList.fetchedAt = 0;                       // the gateway's list may have changed: fetch it again next time
      const file = modelsFile.result && modelsFile.result.ok && entry && modelsFile.result.models.some(m => m.id === entry.model) ? path.basename(settings.modelsFile) : null;
      return reword(se, detail, entry && entry.id, file);
    }
    return reword(se, detail, entry && entry.id);
  }

  // A failed exchange outside @opencode/ai (the live model list) → ServiceError
  function rawFailure(r) {
    const extra = more => Object.assign({ provider: id }, more);
    if (r.failed === 'timeout') return new ServiceError(504, 'timeout', name + ' didn\'t send its model list within ' + (MODEL_LIST_TIMEOUT_MS / 1000) + ' seconds. Try again in a moment.', extra({ code: 'Timeout' }));
    if (r.failed) {
      const code = String(r.code || '');
      return new ServiceError(502, 'network', networkText(code) + (r.detail ? ' (details: ' + redact(r.detail, secrets(), 200) + ')' : ''), extra({ code: code || undefined, log: 'network ' + (code || '(no code)') }));
    }
    const status = r.status;
    const detail = providerMessage(r.text, secrets());
    const quoted = detail ? ' ("' + detail + '")' : '';
    const log = 'HTTP ' + status + (detail ? ': ' + detail : '');
    if (status >= 300 && status < 400) {
      return new ServiceError(503, 'not_configured', name + ' answered with a redirect instead of a result. Check ' + names.base + ' ' + names.where + '.', extra({ code: 'bad_base_url', upstreamStatus: status, log }));
    }
    if (status === 401) return reword(new ServiceError(401, 'authentication_error', '', extra({ upstreamStatus: status, log })), detail);
    if (status === 403) return reword(new ServiceError(403, isHtml(r.text) ? 'blocked' : 'permission_error', '', extra({ upstreamStatus: status, code: isHtml(r.text) ? 'web_page' : undefined, log })), detail);
    if (status === 404) {
      return new ServiceError(503, 'not_configured', name + ' couldn\'t find the requested endpoint. Check that ' + names.base + ' ' + names.where + ' ends in /v1.', extra({ code: 'bad_base_url', upstreamStatus: status, log }));
    }
    if (status === 408) return new ServiceError(504, 'timeout', name + ' took too long to answer. Try again.', extra({ upstreamStatus: status, log }));
    if (status === 429) {
      const wait = retryAfterMs(headerOf(r.headers, 'retry-after'), Date.now());
      return new ServiceError(429, 'rate_limited', name + ' answered "too many requests"' + quoted + ' — the key\'s budget for the day, week or month may be used up (it lasts until the window rolls over). Try again later, or add another key to ' + names.key + '.',
        extra({ scope: 'provider', upstreamStatus: status, retryAfterSeconds: wait !== null ? Math.max(1, Math.ceil(wait / 1000)) : undefined, log }));
    }
    if (status >= 500) return new ServiceError(502, 'upstream_error', name + ' had a temporary server problem (HTTP ' + status + ')' + quoted + '. Try again in a moment.', extra({ upstreamStatus: status, log }));
    return new ServiceError(400, 'invalid_request', name + ' couldn\'t process the request' + (detail ? ': ' + detail : ' (HTTP ' + status + ').'), extra({ upstreamStatus: status, log }));
  }

  // ── Transport ──
  // The AI instance requests go through: capture (quota headers on success), the chat
  // shims (plain JSON, web pages, odd finish reasons, images), and the Python worker
  // for requests marked with TRANSPORT_HEADER.
  function currentClient() {
    if (!client) {
      const capture = captureMiddleware();
      const ai = createAI({ middleware: [capture.middleware, chatShims(), substituteMiddleware(TRANSPORT_HEADER, viaPython)], proxy: settings.proxy, env });
      client = { ai, capture, active: 0, retired: false };
    }
    return client;
  }
  // An AI instance replaced by Reload .env is closed once its requests have finished
  function retire(c) {
    if (!c) return;
    c.retired = true;
    if (!c.active) c.ai.dispose().catch(() => {});
  }
  function release(c) {
    c.active--;
    if (c.retired && !c.active) c.ai.dispose().catch(() => {});
  }

  // A request marked for Python (value "<auto|python> <timeout ms>"), sent by python/emis_fetch.py
  // with its buffered answer; null = send it from Node.js after all (auto: no Python, or it failed
  // before an answer — but not after a timeout: the gateway has the request, and the time is up)
  async function viaPython(req) {
    const [mode, ms] = String(req.marker).split(' ');
    const worker = python;
    if (!worker) return null;
    const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const r = await worker.request({ method: req.method, url: req.url, key, body: req.json === undefined ? null : req.json, headers: settings.headers, timeoutMs: Number(ms) || DEFAULT_TIMEOUT_MS, signal: req.signal, proxy: settings.pythonProxy });
    if (r && !r.failed && r.status >= 300 && r.status < 400) {
      // (a redirect isn't followed: marked the way http.mjs marks one that came to Node.js)
      return new Response(JSON.stringify({ error: { message: 'The provider answered with a redirect (HTTP ' + r.status + ') instead of an answer.', type: SHIM_ERROR_TYPE, code: 'redirect' } }),
        { status: 502, headers: { 'content-type': 'application/json', [SHIM_HEADER]: 'redirect', [SHIM_STATUS_HEADER]: String(r.status) } });
    }
    if (r && !r.failed && r.status >= 200 && r.status <= 599) {
      return new Response([204, 205].includes(r.status) ? null : r.text, { status: r.status, headers: r.headers });
    }
    if (r && r.failed === 'aborted') throw Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
    if (r) log.warn('python.failed', { provider: id, outcome: r.failed, code: r.code, detail: redact(r.message || '', secrets(), 300) });
    if (mode !== 'python' && !(r && r.failed === 'timeout')) return null;     // auto: the same request from Node.js
    if (!r) throw Object.assign(new Error('Python wasn\'t found'), { code: 'NO_PYTHON' });
    if (r.failed === 'timeout') throw Object.assign(new Error('Timed out waiting for the response to complete (Python)'), { code: 'Timeout' });
    throw Object.assign(new Error('Python: ' + redact(r.message || r.failed, secrets(), 200)), { code: r.code || 'ECONNRESET' });
  }

  const languageModel = (baseURL, apiKey, modelId) =>
    LanguageModel.update(OpenAICompatible.configure({ baseURL, apiKey, provider: id }).model(modelId), { compatibility: COMPATIBILITY });

  // One try with one key. Waits for the first event, so the upstream status and headers
  // are known: → {ok: true, it, first, headers} or {ok: false, err, status, headers}.
  async function attempt(c, key, baseURL, input, entry, o) {
    const tag = crypto.randomUUID();
    const headers = Object.assign({}, settings.headers, { accept: 'text/event-stream' }, c.capture.tag(tag));
    if (!o.stream && python) headers[TRANSPORT_HEADER] = settings.transport + ' ' + o.timeoutMs;
    const http = Object.assign({}, input.http, { headers, headerTimeout: o.timeoutMs, chunkTimeout: o.timeoutMs });
    if (!o.stream) http.timeout = o.timeoutMs;
    const it = c.ai.llm.stream(Object.assign({}, input, { model: languageModel(baseURL, key, entry.model), http }), { signal: o.signal })[Symbol.asyncIterator]();
    try {
      const first = await it.next();
      const seen = c.capture.take(tag);
      return { ok: true, it, first, headers: seen ? seen.headers : null };
    } catch (err) {
      const seen = c.capture.take(tag);
      const answer = err && err.reason && err.reason.http;
      return { ok: false, err, status: answer ? answer.status : (seen ? seen.status : undefined), headers: (answer && answer.headers) || (seen && seen.headers) || null };
    }
  }

  /**
   * One chat request: yields @opencode/ai LLMEvents. Each usable key is tried
   * once (the first event is awaited before a try counts as answered); failures
   * of the request as a whole are thrown as a ServiceError before any event.
   *
   * @param {object} body    a validateChatBody() result
   * @param {object} entry   this provider's ModelEntry (from models())
   * @param {{signal?: AbortSignal, timeoutMs?: number, stream?: boolean, variant?: string}} [o]
   */
  async function* chat(body, entry, o) {
    o = o || {};
    const signal = o.signal;
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? Math.round(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const stream = o.stream !== undefined ? !!o.stream : !!body.stream;
    const run = { signal, timeoutMs, stream };
    if (closed) throw new ServiceError(503, 'not_configured', name + ' is shutting down.', { provider: id, model: entry.id });
    if (settings.problem) throw notConfigured(entry.id);
    let input;
    try {
      // (no variants here: reasoning_effort goes to the gateway as it is)
      input = toLLMInput(body, { protocol: 'chat', model: Object.assign({}, entry, { variants: undefined }) });
    } catch (err) { throw describe(err, entry, signal); }
    // The client's messages exactly as they came (developer role, names, image detail):
    // the gateway takes them as they are
    input.http = Object.assign({}, input.http, { body: Object.assign({}, input.http && input.http.body, { messages: body.messages }) });

    const keys = keysForRequest(Date.now());
    if (!keys.length) throw quotaFailure(Date.now(), entry.id);
    let c;
    try { c = currentClient(); } catch (err) { throw describe(err, entry, signal); }
    c.active++;
    let opened = null, finished = false;
    try {
      let rejection = null, limited = false;
      for (const key of keys) {
        const baseURL = settings.baseUrl;
        const r = await attempt(c, key, baseURL, input, entry, run);
        const now = Date.now();
        const quota = readQuotaHeaders(r.headers);
        recordQuota(key, quota, now);
        if (r.ok) { markKeyUsed(key); opened = r; break; }
        if (signal && signal.aborted) throw describe(r.err, entry, signal);
        const se = describe(r.err, entry, signal);
        const detail = r.err && r.err.reason ? providerMessage(r.err.reason.body, secrets()) : '';
        // no credit left on this key (402): like a used-up budget, the next key is tried
        if (r.status === 402) { onQuotaExhausted(key, quota, r.headers, now, 402); limited = true; continue; }
        if (r.status === 429) {
          if (keyWideLimit(key, entry.model, quota, now, detail)) { onQuotaExhausted(key, quota, r.headers, now); limited = true; continue; }
          throw modelLimited(se, entry, detail);                 // this model only: MetaCode rests it
        }
        // a web page or a model this key can't use isn't the key's fault
        if (r.status === 401 || (r.status === 403 && se.type !== 'blocked' && !/model/i.test(detail))) {
          markKeyRejected(key, r.status, detail);
          rejection = se;
          continue;
        }
        if (isWebPage(se) && !/\/v1$/.test(baseURL)) {
          // The base URL is missing /v1, so the website answered instead of the API: try the API address
          const fixed = baseURL + '/v1';
          const r2 = await attempt(c, key, fixed, input, entry, run);
          recordQuota(key, readQuotaHeaders(r2.headers), Date.now());
          if (!r2.ok) throw se;
          fixBaseUrl(baseURL);
          markKeyUsed(key);
          opened = r2;
          break;
        }
        throw se;
      }
      if (!opened) throw limited ? quotaFailure(Date.now(), entry.id) : rejection;
      if (opened.first.done) { finished = true; return; }
      yield opened.first.value;
      for (;;) {
        let n;
        try { n = await opened.it.next(); } catch (err) { finished = true; throw describe(err, entry, signal); }
        if (n.done) break;
        yield n.value;
      }
      finished = true;
    } finally {
      // The caller stopped reading (it went away): cancel the upstream call
      if (opened && !finished && opened.it.return) await opened.it.return().catch(() => {});
      release(c);
    }
  }

  // ── Models ──
  function readModelsFile() {
    const file = settings.modelsFile;
    if (!file) return null;
    const fileName = path.basename(file);
    const now = Date.now();
    if (modelsFile.file === file && modelsFile.result && now - modelsFile.checkedAt < MODELS_FILE_RECHECK_MS) return modelsFile.result;
    if (modelsFile.file !== file) modelsFile = { result: null, mtimeMs: null, checkedAt: 0, loads: 0, file };
    modelsFile.checkedAt = now;
    let stat = null;
    try { stat = fs.statSync(file); } catch (e) { stat = null; }
    if (!stat || !stat.isFile()) {
      if (!modelsFile.result || !modelsFile.result.missing) {
        if (modelsFile.loads) log.warn('models_file.removed', { provider: id, file: fileName });
        else if (!isEmis || text(env.EMIS_MODELS_FILE) || text((config.options || {}).models_file)) log.warn('models_file.missing', { provider: id, file: fileName });
        modelsFile.result = { ok: false, missing: true };
        modelsFile.mtimeMs = null;
      }
      return modelsFile.result;
    }
    if (modelsFile.result && !modelsFile.result.missing && modelsFile.mtimeMs === stat.mtimeMs) return modelsFile.result;
    let result;
    if (stat.size > MODELS_FILE_MAX_BYTES) result = { ok: false, problem: fileName + ' is too large to be a model list.' };
    else {
      try {
        // (a byte-order mark, as some Windows editors add, isn't valid JSON)
        result = parseModelsFile(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), id, fileName);
      } catch (e) {
        result = { ok: false, problem: fileName + ' couldn\'t be read as JSON (' + redact(e.message, secrets(), 120) + ').' };
      }
    }
    if (!result.ok) log.warn('models_file.unusable', { provider: id, problem: result.problem, using: 'the live model list' });
    else {
      log.info('models_file.loaded', { provider: id, file: fileName, models: result.models.length, skipped: result.skipped || undefined });
      if (result.baseURL && settings.baseUrl && result.baseURL !== settings.baseUrl) {
        log.warn('models_file.base_url', { provider: id, file: fileName, note: 'written for another address; ' + names.base + ' is used' });
      }
      if (result.hasLiteralKey) {
        log.warn('models_file.literal_key', { provider: id, file: fileName, note: 'the file contains an API key, which is never read from it: keep the key in ' + names.key + ' and write {env:' + (isEmis ? 'EMIS_API_KEY' : 'NAME') + '} in the file' });
      }
      modelsFile.loads++;
    }
    modelsFile.result = result;
    modelsFile.mtimeMs = stat.mtimeMs;
    return result;
  }

  // The config's own models (provider.<id>.models), in OpenCode's model format
  function configModels() {
    const out = [];
    if (!isObject(config.models)) return out;
    for (const [rawId, meta] of Object.entries(config.models)) {
      const modelId = safeModelId(rawId);
      if (!modelId || out.some(m => m.id === modelId)) continue;
      out.push(Object.assign(modelInfo(modelId, isObject(meta) ? meta : {}), { deprecated: isObject(meta) && meta.status === 'deprecated', given: isObject(meta) ? meta : {} }));
    }
    return out;
  }

  // whitelist / blacklist (OpenCode's): only the listed ids / without the listed ids
  function filtered(list) {
    const white = Array.isArray(config.whitelist) ? config.whitelist.map(String) : null;
    const black = Array.isArray(config.blacklist) ? config.blacklist.map(String) : [];
    return list.filter(m => (!white || white.includes(m.id)) && !black.includes(m.id));
  }

  // The models file merged with the config's models → [{id, name, …}] and where they came
  // from, or null when neither lists any (then the live list is the catalog)
  function staticModels() {
    const file = readModelsFile();
    const list = file && file.ok ? file.models.map(m => Object.assign({}, m)) : [];
    const own = configModels();
    for (const m of own) {
      const at = list.findIndex(x => x.id === m.id);
      if (m.deprecated) { if (at >= 0) list.splice(at, 1); continue; }
      if (at < 0) { list.push(Object.assign({}, m, { deprecated: undefined, given: undefined })); continue; }
      // a config entry overrides what it states
      const g = m.given;
      const x = list[at];
      if (g.name !== undefined) x.name = m.name;
      for (const [field, key] of [['toolCall', 'tool_call'], ['reasoning', 'reasoning'], ['attachment', 'attachment'], ['temperature', 'temperature'], ['releaseDate', 'release_date']]) {
        if (g[key] !== undefined && m[field] !== undefined) x[field] = m[field];
      }
      if (m.context !== undefined) x.context = m.context;
      if (m.output !== undefined) x.output = m.output;
    }
    if (!list.length) return null;
    return { models: filtered(list), source: file && file.ok ? path.basename(settings.modelsFile) : 'config' };
  }

  async function fetchModelList() {
    const keys = settings.keys.slice().sort((a, b) => Number(getKeyState(a).invalid) - Number(getKeyState(b).invalid));
    let failure = null;
    for (const key of keys) {
      const r = await rawRequest('GET', '/models', key, { timeoutMs: MODEL_LIST_TIMEOUT_MS });
      if (r.failed) return { ok: false, error: rawFailure(r) };
      recordQuota(key, readQuotaHeaders(r.headers), Date.now());
      if (r.status === 403 && isHtml(r.text)) return { ok: false, error: rawFailure(r) };      // a web page: not the key's fault
      if (r.status === 401 || r.status === 403) { markKeyRejected(key, r.status, providerMessage(r.text, secrets())); failure = rawFailure(r); continue; }
      if (r.status === 429) { failure = rawFailure(r); continue; }
      if (!r.ok) return { ok: false, error: rawFailure(r) };
      let ids = parseModelList(r.json);
      if (!ids && isHtml(r.text) && !/\/v1$/.test(settings.baseUrl)) {
        // The base URL is missing /v1, so the website answered instead of the API: try the API address
        const baseURL = settings.baseUrl;
        const r2 = await rawRequest('GET', '/models', key, { timeoutMs: MODEL_LIST_TIMEOUT_MS, baseURL: baseURL + '/v1' });
        ids = r2.ok ? parseModelList(r2.json) : null;
        if (ids) fixBaseUrl(baseURL);
      }
      if (!ids) {
        const what = describeReply(r, secrets());
        const page = /web page/.test(what);
        return { ok: false, error: new ServiceError(502, 'malformed_response', name + ' sent its model list in a format MetaCode couldn\'t read (it sent ' + what + ').' +
          (page ? ' Check that ' + names.base + ' is the API address ending in /v1' + (isEmis ? ' (default ' + EMIS_DEFAULT_BASE_URL + ').' : '.') : ''),
        { provider: id, code: page ? 'web_page' : undefined, log: 'HTTP ' + r.status + ': ' + what }) };
      }
      getKeyState(key).invalid = false;
      return { ok: true, ids };
    }
    return { ok: false, error: failure || (settings.problem ? notConfigured() : quotaFailure(Date.now())) };
  }

  // The gateway's own list (GET /models): cached for a few minutes, a failure reused for a few
  // seconds, and concurrent callers share one fetch. → {ok: true, ids} or {ok: false, error}
  function liveList(force) {
    const now = Date.now();
    if (!force) {
      if (modelList.ids && now - modelList.fetchedAt < MODEL_LIST_TTL_MS) return Promise.resolve({ ok: true, ids: modelList.ids });
      if (modelList.failure && now - modelList.failedAt < MODEL_LIST_RETRY_MS) return Promise.resolve({ ok: false, error: modelList.failure });
    }
    if (settings.problem) return Promise.resolve({ ok: false, error: notConfigured() });
    const list = modelList;               // (a reload starts a new one; a late answer stays in the old)
    if (!list.pending) {
      list.pending = fetchModelList()
        .catch(err => ({ ok: false, error: new ServiceError(500, 'internal_error', 'Couldn\'t load ' + name + '\'s model list.', { provider: id, log: redact(err && (err.stack || err.message), secrets(), 1000) }) }))
        .then(result => {
          if (result.ok) {
            list.ids = result.ids;
            list.fetchedAt = Date.now();
            list.failure = null;
            list.logged = null;
          } else {
            list.failure = result.error;
            list.failedAt = Date.now();
            if (list.logged !== result.error.message) {
              list.logged = result.error.message;
              log.warn('models.list_failed', { provider: id, type: result.error.type, message: result.error.message, detail: result.error.log });
            }
          }
          list.pending = null;
          return result;
        });
    }
    return list.pending;
  }

  // Which models the gateway lists right now (a Set), waiting up to waitMs for a fetch;
  // null when that isn't known. A list older than the cache time still counts until a new one comes.
  async function availability(force, waitMs) {
    const fresh = modelList.ids && Date.now() - modelList.fetchedAt < MODEL_LIST_TTL_MS;
    if (!force && fresh) return new Set(modelList.ids);
    const pending = liveList(force).catch(() => null);
    const known = () => (modelList.ids ? new Set(modelList.ids) : null);
    if (!waitMs) return known();
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(resolve, waitMs, 'late'); });
    const live = await Promise.race([pending, late]);
    clearTimeout(timer);
    return live && live !== 'late' && live.ok ? new Set(live.ids) : known();
  }

  const toEntry = (m, available) => ({
    id: id + '/' + m.id, provider: id, providerName: name, model: m.id, name: m.name || m.id, free: false, available,
    toolCall: m.toolCall, reasoning: m.reasoning, attachment: m.attachment, temperature: m.temperature,
    contextWindow: m.context, maxOutput: m.output, variants: [], releaseDate: m.releaseDate, protocol: 'chat'
  });

  /**
   * The models this provider offers (ModelEntry[], in the file's or the gateway's order).
   * available: true/false = the gateway's live list has it / doesn't; null = not known.
   *
   * @param {{refresh?: boolean, waitMs?: number}} [o]  refresh: fetch the live list again now;
   *   waitMs: the longest to wait for the live list when the file is the catalog (it waits 4000 ms
   *   before the first fetch has finished, else 0: the cached one, refreshed in the background)
   * @returns {Promise<object[]>} [] when the provider isn't set up
   * @throws {ServiceError} without a file, when the live list can't be loaded (and none was before)
   */
  async function models(o) {
    o = o || {};
    if (settings.problem || closed) return [];
    const fixed = staticModels();
    if (fixed) {
      const wait = Math.min(o.waitMs !== undefined ? o.waitMs : Infinity, modelList.ids || modelList.failedAt ? 0 : AVAILABILITY_WAIT_MS);
      const live = await availability(!!o.refresh, wait);
      return fixed.models.map(m => toEntry(m, live ? live.has(m.id) : null));
    }
    // An old list is used while a new one is fetched in the background, so a slow or unreachable
    // gateway doesn't hold up every request to the service (other providers' included)
    let ids;
    if (!o.refresh && modelList.ids) {
      liveList(false).catch(() => null);
      ids = modelList.ids;
    } else {
      const live = await liveList(!!o.refresh);
      ids = live.ok ? live.ids : modelList.ids;       // (the last list the gateway sent, while it can't send one)
      if (!ids) throw live.error;
    }
    ids = ids.filter(m => !NOT_A_CHAT_MODEL.test(m));
    return filtered(ids.map(m => ({ id: m, name: m }))).map(m => toEntry(m, true));
  }

  // ── Status ──
  function transportText() {
    if (settings.transport === 'node' || !python) return 'Node.js';
    const st = python.status();
    if (st.ok) return 'Python ' + st.python + ' (' + st.client + ')';
    return settings.transport === 'python' ? 'Python — not available: ' + (st.problem || 'not started') : 'Node.js (Python not found)';
  }

  /** The provider object of GET /v1/status (spec §4.3); nothing secret in it. */
  function status() {
    const now = Date.now();
    let fixed = null;
    try { fixed = staticModels(); } catch (e) { fixed = null; }
    // (the live list is refreshed in the background when it's old)
    if (!settings.problem && !closed && !modelList.pending && !(modelList.ids && now - modelList.fetchedAt < MODEL_LIST_TTL_MS) &&
        !(modelList.failure && now - modelList.failedAt < MODEL_LIST_RETRY_MS)) liveList(false).catch(() => null);
    const live = modelList.ids ? new Set(modelList.ids) : null;
    let listed, available, source;
    if (fixed) {
      listed = fixed.models.length;
      available = live ? fixed.models.filter(m => live.has(m.id)).length : null;
      source = fixed.source;
    } else {
      listed = live ? filtered(modelList.ids.filter(m => !NOT_A_CHAT_MODEL.test(m)).map(m => ({ id: m }))).length : 0;
      available = live ? listed : null;
      source = 'live';
    }
    let resting = null;
    if (allKeysResting(now)) {
      const next = settings.keys.map(getKeyState).reduce((a, b) => (b.cooldownUntil < a.cooldownUntil ? b : a));
      resting = { until: new Date(next.cooldownUntil).toISOString(), reason: next.cooldownReason || 'paused' };
      if (next.quota && next.quota.window) resting.window = next.quota.window;
    }
    const keys = settings.keys.map(key => {
      const state = getKeyState(key);
      const isRest = isResting(state, now);
      const entry = {
        masked: key.length < 16 ? '••••' : '…' + key.slice(-4),
        status: state.invalid ? 'invalid' : (isRest ? 'cooling_down' : 'available'),
        cooldownSecondsLeft: isRest ? Math.ceil((state.cooldownUntil - now) / 1000) : 0,
        requestCount: state.requestCount,
        source: isEmis ? 'env' : 'config'
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
    let baseHost = null;
    try { baseHost = settings.baseUrl ? new URL(settings.baseUrl).host : null; } catch (e) { baseHost = null; }
    const file = modelsFile.result;
    const warnings = settings.warnings.slice();
    // (with a models file the provider is ready without the live list, so why it couldn't be had is said here)
    if (fixed && !modelList.ids && modelList.failure) warnings.push('Couldn\'t check which models ' + name + ' offers right now (' + modelList.failure.message.replace(/\.$/, '') + ').');
    return {
      id, name, kind: 'openai-compatible', ready: !settings.problem, problem: settings.problem, warnings,
      keyCount: settings.keys.length, baseHost, proxy: settings.proxyHost, transport: transportText(),
      models: Object.assign({ listed, available, source, checkedAt: modelList.fetchedAt ? new Date(modelList.fetchedAt).toISOString() : null },
        file && !file.ok && file.problem ? { problem: file.problem } : {}),
      resting, keys
    };
  }

  // A raw exchange with the gateway outside @opencode/ai (GET /models). Never throws:
  // → {status, ok, headers, text, json} or {failed: 'timeout'|'network'|'aborted', code}
  async function rawRequest(method, pathname, key, ro) {
    const url = (ro.baseURL || settings.baseUrl) + pathname;
    if (python) {
      const r = await python.request({ method, url, key, body: null, headers: settings.headers, timeoutMs: ro.timeoutMs, signal: ro.signal, proxy: settings.pythonProxy });
      if (r && !r.failed) return { status: r.status, ok: r.ok, headers: r.headers, text: r.text, json: parseJson(r.text), via: 'python' };
      if (r && r.failed === 'aborted') return { failed: 'aborted' };
      if (r) log.warn('python.failed', { provider: id, path: pathname, outcome: r.failed, code: r.code, detail: redact(r.message || '', secrets(), 300) });
      if (settings.transport === 'python' || (r && r.failed === 'timeout')) {
        return r ? { failed: r.failed === 'client' ? 'network' : r.failed, code: r.code, detail: r.message } : { failed: 'network', code: 'NO_PYTHON' };
      }
      // auto: the same request from Node.js
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), ro.timeoutMs);
    const onAbort = () => controller.abort(new Error('aborted'));
    if (ro.signal) ro.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await undiciFetch(url, {
        method,
        headers: Object.assign({ 'user-agent': USER_AGENT }, settings.headers, { authorization: 'Bearer ' + key, accept: 'application/json' }),
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: listDispatcher()
      });
      const body = await response.text();
      return { status: response.status, ok: response.ok, headers: response.headers, text: body, json: parseJson(body) };
    } catch (err) {
      if (controller.signal.aborted) return { failed: ro.signal && ro.signal.aborted ? 'aborted' : 'timeout' };
      const cause = err && err.cause ? err.cause : err;
      return { failed: 'network', code: String((cause && cause.code) || '') };
    } finally {
      clearTimeout(timer);
      if (ro.signal) ro.signal.removeEventListener('abort', onAbort);
    }
  }

  // The proxy for raw requests: EMIS_PROXY, else HTTPS_PROXY / HTTP_PROXY with NO_PROXY, else direct (as for chats)
  function listDispatcher() {
    if (!dispatcher) dispatcher = { agent: dispatcherFor(settings.proxy, env) };
    return dispatcher.agent;
  }
  function closeDispatcher() {
    if (dispatcher && dispatcher.agent) dispatcher.agent.close().catch(() => {});
    dispatcher = null;
  }

  // ── Reload and close ──
  /**
   * Reload .env: new settings from `newEnv` / `newConfig` (when given), key states,
   * caches and the models file forgotten; the Python worker starts again with the
   * new environment, after answering the requests it already has (they have reached
   * the gateway: sending them again would spend the key's budget twice).
   * @returns {Promise<object>} the new status()
   */
  async function reload(newEnv, newConfig) {
    if (newEnv) env = newEnv;
    if (newConfig) config = newConfig;
    name = text(config.name) || (isEmis ? 'AI gateway' : id);
    names = settingNames(id);
    settings = loadSettings(id, config, env, repoDir);
    for (const w of settings.warnings) log.warn('provider.warning', { provider: id, warning: w });
    keyState = new Map();
    rotationCursor = 0;
    modelList = { ids: null, fetchedAt: 0, failure: null, failedAt: 0, pending: null, logged: null };
    modelsFile = { result: null, mtimeMs: null, checkedAt: 0, loads: 0, file: null };
    retire(client);
    client = null;
    closeDispatcher();
    const old = python;
    python = makePython();
    if (old) old.stop({ finishRequests: true });
    if (python && !settings.problem) await python.warm();
    warmUp();
    return status();
  }

  /** Stops the Python worker and closes the connections (in-flight calls are the caller's to abort first). */
  async function close() {
    closed = true;
    if (python) python.stop();
    python = null;
    closeDispatcher();
    const c = client;
    client = null;
    if (c) await c.ai.dispose().catch(() => {});
  }

  for (const w of settings.warnings) log.warn('provider.warning', { provider: id, warning: w });
  warmUp();

  return {
    id,
    get name() { return name; },
    kind: 'openai-compatible',
    status,
    models,
    chat,
    reload,
    close
  };
}
