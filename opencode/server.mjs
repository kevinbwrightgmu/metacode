// ── MetaCode's OpenCode service ───────────────────────────────────────────────
// MetaCode's AI goes through this small service, which runs beside it (pm2
// app "metacode-opencode", or a child process MetaCode starts itself: see
// opencode/supervisor.js) and listens on 127.0.0.1:4097 by default. It is
// built on OpenCode's published @opencode/ai package and offers only what
// MetaCode needs: the model list and chat completions, in the OpenAI format,
// for the providers in its config (config.mjs):
//
//   opencode      OpenCode Zen (providers/zen.mjs): free models without a key, the rest with OPENCODE_API_KEY
//   emis          MetaCode's AI gateway, an OpenAI-compatible provider (providers/openai-compatible.mjs)
//
// HTTP API (docs/opencode-service.md):
//   GET  /health                 no token needed; says nothing secret
//   GET  /v1/models              the models of every provider that is ready, and the default model
//   POST /v1/chat/completions    OpenAI Chat Completions, streamed (SSE) or not
//   GET  /v1/status              providers, keys, quotas, catalog, warnings
//   POST /v1/reload              re-read .env, the config, the models files and the catalog cache
// Every /v1 route needs "Authorization: Bearer <token>": OPENCODE_SERVICE_TOKEN,
// else the token file in OPENCODE_SERVICE_DATA_DIR (opencode/shared.js), the
// same one MetaCode reads. Bodies up to 32 MB.
//
// Model ids are OpenCode refs, "provider/model", optionally "#variant"; a bare
// id (saved before providers existed) is looked up on the OpenAI-compatible
// providers first, then on Zen, also under another spelling (model-match.js).
// The service never retries a failed upstream call (MetaCode does), and it
// never runs tools, reads files or opens sessions: it only passes chats on.
//
// Run it with "node opencode/server.mjs" (it reads the same .env as MetaCode);
// tests start it in-process with startService().

/**
 * A model as a provider lists it (GET /v1/models shows it in snake_case).
 * @typedef {object} ModelEntry
 * @property {string} id               full id, "provider/model"
 * @property {string} provider         provider id ("opencode", "emis")
 * @property {string} providerName     its display name ("OpenCode Zen")
 * @property {string} model            the model's own id ("big-pickle")
 * @property {string} name             display name
 * @property {boolean} [free]          no charge (Zen's free models)
 * @property {boolean|null} available  offered right now (false: listed but not served; null: unknown)
 * @property {boolean} [default]       (set by the service)
 * @property {boolean} [toolCall]      @property {boolean} [reasoning]  @property {boolean} [attachment]
 * @property {boolean} [temperature]   false: the model takes no temperature
 * @property {number} [contextWindow]  @property {number} [maxOutput]
 * @property {string[]} [variants]     variant ids ("low", "high", …) for "provider/model#variant"
 * @property {string} [releaseDate]    "YYYY-MM-DD"
 * @property {string} [protocol]       'chat' | 'responses' | 'anthropic' | 'google' | 'mistral'
 */

/**
 * The interface every provider module implements (providers/zen.mjs,
 * providers/openai-compatible.mjs). The module exports
 *
 *   createProvider({ id, config, env, dataDir, log, shared }) → Provider
 *
 *   id       the provider id from the config ("opencode", "emis", …)
 *   config   its merged, cleaned config entry (config.mjs): {npm?, name?, options: {baseURL?, apiKey?,
 *            headers?, transport?, models_file?}, models?, whitelist?, blacklist?} — for "emis" with
 *            baseURL and transport filled in (EMIS defaults) and models_file from EMIS_MODELS_FILE
 *   env      the service's environment (process env + .env), a plain object
 *   dataDir  OPENCODE_SERVICE_DATA_DIR (catalog cache, anything a provider keeps)
 *   log      log.info / .warn / .error, each with a line of text or lib/log.js's (event, fields)
 *            ("[emis] key.resting key=…6789 …"); never pass keys or prompts to it
 *   shared   opencode/shared.js (isOff, isOn, …)
 *
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} name                       display name
 * @property {string} kind                       'zen' | 'openai-compatible'
 * @property {() => object} status               the provider object of GET /v1/status (spec §4.3):
 *   {id, name, kind, ready, problem, warnings[], keyCount, models: {listed, available, …}, resting, keys[], …}
 * @property {(opts?: {waitMs?: number}) => Promise<ModelEntry[]>} models   what it offers now, in its own order
 *   ([] when not ready); waitMs: how long to wait for live data (e.g. which models the gateway runs now)
 *   before answering with what is known. Throws a ServiceError when it can't say (the gateway refused
 *   the key, can't be reached…): the provider isn't ready, its message is the problem, and chats for
 *   its models get that error. The routes don't wait for a slow list forever (/v1/status: 2 s).
 * @property {(body: object, entry: ModelEntry, run: {signal: AbortSignal, timeoutMs: number, stream: boolean,
 *   variant: string|null}) => AsyncIterable<object>} chat
 *   async generator of @opencode/ai LLM events for one validated OpenAI body (openai.mjs
 *   validateChatBody); throws a ServiceError (errors.mjs) — before its first event for request-level
 *   failures. `timeoutMs` is the upstream limit for header wait, chunk silence and (not streamed) the
 *   whole exchange; `stream` says whether the client asked for SSE; `variant` comes from "#variant".
 * @property {(env: object, config: object) => Promise<void>} reload   new settings (Reload .env): re-read
 *   files, reset key state and caches; requests already running finish as they are
 * @property {() => Promise<void>} close         stop timers and workers
 * @property {(model: string) => (Error|null)} [unlisted]   optional: why a model it knows isn't offered
 *   (e.g. needs a key) as a ServiceError, else null
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ServiceError, isServiceError, fromAIError, redact } from './errors.mjs';
import { validateChatBody, toChatCompletion, toChunks } from './openai.mjs';
import { OPENCODE_AI_VERSION } from './http.mjs';
import { loadConfig } from './config.mjs';

const require = createRequire(import.meta.url);
const shared = require('./shared.js');
const { createEnvLoader, decode } = require('../env-file.js');
const dotenv = require('dotenv');
const libLog = require('../lib/log.js');

// model-match.js decides when two ids are one model under two spellings
let modelMatch = null;
try { modelMatch = require('../model-match.js'); } catch (e) { modelMatch = null; }
const canonical = id => (modelMatch && typeof modelMatch.canonicalId === 'function' ? modelMatch.canonicalId(id)
  : String(id || '').toLowerCase().replace(/(\d)[-_](?=\d)/g, '$1.'));

const SERVICE_NAME = 'metacode-opencode';
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(shared.REPO_DIR, 'package.json'), 'utf8')).version || 'unknown'; }
  catch (e) { return 'unknown'; }
})();
const MAX_BODY = 32 * 1024 * 1024;
const MAX_DRAIN = 128 * 1024 * 1024;          // past this, an oversized request is cut off instead of read to the end
const DEFAULT_UPSTREAM_TIMEOUT_MS = 115000;   // without X-Request-Timeout-Ms (MetaCode's default 120 s − 5 s)
const MAX_UPSTREAM_TIMEOUT_MS = 600000;
const PROVIDER_MODULES = { zen: './providers/zen.mjs', 'openai-compatible': './providers/openai-compatible.mjs' };
const LEGACY_DEFAULT = 'claude-opus-5.5';     // the gateway's default model before the service
// How long the routes wait for a provider's model list (MetaCode waits 3 s for /v1/status, 20 s for /v1/models)
const STATUS_DEADLINE_MS = 2000;
const STATUS_WAIT_MS = 1500;                  // (a provider with a models file answers by then, live availability or not)
const LIST_DEADLINE_MS = 15000;               // /v1/models, chats, reload (the startup line: as /v1/status)
const LATE = Symbol('late');
// Why close() cancels the chats still running (they get a failure that says so, not "cancelled")
const SHUTTING_DOWN = Object.assign(new Error('MetaCode\'s OpenCode service is shutting down.'), { name: 'AbortError' });
const MAX_LOGGED_WARNINGS = 500;

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const seconds = ms => (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s');

// The service's log: log('…'), .info, .warn, .error, each taking one line
function makeLog(target) {
  const t = target || console;
  const pick = (...names) => { for (const n of names) if (typeof t[n] === 'function') return t[n].bind(t); return () => {}; };
  const info = pick('info', 'log');
  const out = (...a) => info(...a);
  return Object.assign(out, { log: info, info, warn: pick('warn', 'log'), error: pick('error', 'warn', 'log'), debug: () => {} });
}

// The log a provider gets: a line of text, or lib/log.js's (event, fields) —
// "[emis] key.resting key=…6789 until=…" (values redacted, LOG_FORMAT=json honoured)
function providerLog(log, area) {
  const line = (level, event, fields) => {
    if (!isObject(fields)) return String(event);
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '') continue;
      clean[k] = typeof v === 'string' ? libLog.redact(v, 300) : typeof v === 'object' ? libLog.redact(JSON.stringify(v), 300) : v;
    }
    if (String(process.env.LOG_FORMAT || '').toLowerCase() === 'json') return JSON.stringify(Object.assign({ t: new Date().toISOString(), area, level, event }, clean));
    const kv = Object.entries(clean).map(([k, v]) => k + '=' + (typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : String(v))).join(' ');
    return '[' + area + '] ' + event + (kv ? ' ' + kv : '');
  };
  const at = level => (event, fields) => log[level](line(level, event, fields));
  return Object.assign(at('info'), { log: at('info'), info: at('info'), warn: at('warn'), error: at('error'), debug: () => {} });
}

// The environment: process.env after MetaCode's .env (env-file.js) — or, when a
// caller passes its own env (tests), that, plus the file METACODE_ENV_FILE names
function readEnv(base, loader) {
  if (base === process.env) {
    const info = loader.load();
    return { env: Object.assign({}, process.env), info };
  }
  const env = Object.assign({}, base);
  const file = String(env.METACODE_ENV_FILE || '').trim();
  if (!file || file === 'none') return { env, info: { found: false, disabled: file === 'none', keys: [], warnings: [] } };
  try {
    const parsed = dotenv.parse(decode(fs.readFileSync(path.resolve(file))).text);
    const keys = [];
    for (const [k, v] of Object.entries(parsed)) {
      const key = k.replace(/^﻿/, '').trim();
      if (!key) continue;
      env[key] = String(v).replace(/^﻿/, '').trim();
      keys.push(key);
    }
    return { env, info: { found: true, file: path.resolve(file), keys, warnings: [] } };
  } catch (e) {
    return { env, info: { found: true, file: path.resolve(file), error: 'Couldn\'t read the file (' + (e.code || e.message) + ').', keys: [], warnings: [] } };
  }
}

function urlHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  if (h === '0.0.0.0') return '127.0.0.1';
  if (h === '::') return '[::1]';
  return h.includes(':') ? '[' + h + ']' : h;
}

// X-Request-Timeout-Ms (how long MetaCode waits) → the upstream limits: a little shorter, so the service answers first
function upstreamTimeout(header) {
  const n = Number(header);
  if (!header || !Number.isFinite(n) || n <= 0) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(MAX_UPSTREAM_TIMEOUT_MS, Math.max(1000, Math.round(n) - 3000));
}

function sameToken(given, token) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(token)).digest();
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body, headers) {
  if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' }, headers));
  res.end(text);
}

function sendError(res, err, headers) {
  sendJson(res, err.status, err.toBody(), Object.assign({}, err.toHeaders(), headers));
}

// The JSON body, at most 32 MB. An oversized body is read to its end (up to
// MAX_DRAIN) before the 413 goes out, so the sender gets the answer, not a reset.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new ServiceError(413, 'request_too_large', 'The request is larger than MetaCode\'s OpenCode service accepts (32 MB). Send a shorter text or a smaller sample.');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_DRAIN) { reject(Object.assign(tooLarge(), { cutOff: true })); return; }
    const parts = [];
    let size = 0;
    let over = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) over = true;
      if (!over) parts.push(chunk);
      else if (size > MAX_DRAIN) { req.removeAllListeners('data'); reject(Object.assign(tooLarge(), { cutOff: true })); }
    });
    req.on('end', () => {
      if (over) { reject(tooLarge()); return; }
      const text = Buffer.concat(parts).toString('utf8');
      if (!text.trim()) { resolve(undefined); return; }
      try { resolve(JSON.parse(text)); }
      catch (e) { reject(new ServiceError(400, 'invalid_request', 'The request body isn\'t valid JSON.')); }
    });
    // the client went away before it sent the whole body: nothing to answer (not a failure of the service)
    const gone = () => reject(new ServiceError(499, 'cancelled', 'The request was cancelled before its body arrived.'));
    req.on('error', gone);
    req.on('close', () => { if (!req.complete) gone(); });
  });
}

// Writes one piece of a stream; waits while the client is slow to read (both
// listeners go once either fires: a long stream to a slow reader adds none)
async function write(res, text) {
  if (res.destroyed) throw Object.assign(new Error('The client went away.'), { name: 'AbortError' });
  if (res.write(text)) return;
  await new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Starts the service.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]         the environment (default process.env, after MetaCode's .env is read into it)
 * @param {number} [opts.port]        default OPENCODE_SERVICE_PORT (4097); 0 = any free port
 * @param {string} [opts.host]        default OPENCODE_SERVICE_HOST (127.0.0.1)
 * @param {string} [opts.dataDir]     default OPENCODE_SERVICE_DATA_DIR (<repo>/opencode-data)
 * @param {string} [opts.configPath]  default opencode/opencode.json
 * @param {object} [opts.log]         console-like (default console)
 * @returns {Promise<{server: http.Server, url: string, port: number, token: string, reload: () => Promise<object>, close: (opts?: {graceMs?: number}) => Promise<void>}>}
 *   url is the API base (http://host:port/v1); reload() does what POST /v1/reload does and returns the status
 * @throws {Error} code 'EADDRINUSE' (with a message saying what to do) when the port is taken
 */
export async function startService(opts) {
  opts = opts || {};
  const log = makeLog(opts.log);
  const baseEnv = opts.env || process.env;
  const loader = createEnvLoader(shared.REPO_DIR);
  const startedAt = new Date().toISOString();

  let env, envInfo, settings, dataDir, token, config;
  let slots = new Map();               // provider id → {id, kind, name, config, disabled, impl, problem, inflight, closing}
  const inflight = new Set();          // AbortControllers of running chats
  const loggedWarnings = new Set();
  const moduleCache = new Map();
  let closing = false;
  let reloading = Promise.resolve();

  function readSettings() {
    ({ env, info: envInfo } = readEnv(baseEnv, loader));
    settings = shared.serviceSettings(env);
    dataDir = opts.dataDir ? path.resolve(opts.dataDir) : settings.dataDir;
    token = shared.readOrCreateToken(dataDir, settings.tokenFromEnv);
    config = loadConfig({ env, configPath: opts.configPath });
  }

  function warnOnce(text) {
    if (loggedWarnings.has(text)) return;
    if (loggedWarnings.size >= MAX_LOGGED_WARNINGS) loggedWarnings.clear();     // (warnings that change, e.g. with a time in them)
    loggedWarnings.add(text);
    log.warn(text);
  }

  function providerModule(kind) {
    if (!moduleCache.has(kind)) {
      const p = import(PROVIDER_MODULES[kind]);
      moduleCache.set(kind, p);
      p.catch(() => moduleCache.delete(kind));            // missing now, maybe there after an update
    }
    return moduleCache.get(kind);
  }

  async function createSlot(p) {
    const slot = { id: p.id, kind: p.kind, name: p.name, config: p.config, disabled: p.disabled, impl: null, problem: p.disabled, inflight: 0, closing: false };
    if (p.disabled) return slot;
    let mod;
    try { mod = await providerModule(p.kind); }
    catch (e) {
      const file = 'opencode/' + PROVIDER_MODULES[p.kind].slice(2);
      const missing = e && e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(PROVIDER_MODULES[p.kind].slice(2));
      slot.problem = missing
        ? 'This copy of MetaCode is missing ' + file + ', so ' + p.name + ' can\'t be used. Update MetaCode (git pull) and restart the AI service.'
        : p.name + ' couldn\'t be loaded (' + file + '). The details are in the AI service\'s log.';
      if (missing) log.warn(slot.problem);
      else log.error(p.name + ': ' + file + ' couldn\'t be loaded: ' + redact(e && (e.stack || e.message), [], 1500));
      return slot;
    }
    try {
      slot.impl = await mod.createProvider({ id: p.id, config: p.config, env, dataDir, log: providerLog(log, p.id), shared });
      if (slot.impl && slot.impl.name) slot.name = slot.impl.name;
    } catch (e) {
      slot.problem = p.name + ' couldn\'t be set up: ' + redact(e && e.message, [], 200);
      log.error(p.name + ' couldn\'t be set up: ' + redact(e && (e.stack || e.message), [], 1500));
    }
    return slot;
  }

  function retireSlot(slot) {
    if (!slot.impl) return;
    slot.closing = true;
    if (slot.inflight === 0) Promise.resolve().then(() => slot.impl.close()).catch(() => {});
  }

  // (Re)builds the providers from the config: same id and kind → reload() it, else make a new one
  async function applyConfig() {
    const next = new Map();
    for (const p of config.providers) {
      const old = slots.get(p.id);
      if (old && old.impl && !old.closing && old.kind === p.kind && !p.disabled) {
        try {
          await old.impl.reload(env, p.config);
          Object.assign(old, { config: p.config, name: old.impl.name || p.name, disabled: null, problem: null });
        } catch (e) {
          old.problem = p.name + ' couldn\'t be reloaded: ' + redact(e && e.message, [], 200);
          log.error(p.name + ' couldn\'t be reloaded: ' + redact(e && (e.stack || e.message), [], 1500));
        }
        next.set(p.id, old);
        continue;
      }
      if (old) retireSlot(old);
      next.set(p.id, await createSlot(p));
    }
    for (const [id, old] of slots) if (!next.has(id)) retireSlot(old);
    slots = next;
  }

  // ── Providers' state ────────────────────────────────────────────────────────

  async function statusOf(slot) {
    const stub = { id: slot.id, name: slot.name, kind: slot.kind, ready: false, problem: slot.problem || null, warnings: [], keyCount: 0, models: { listed: 0, available: 0 }, resting: null, keys: [] };
    if (!slot.impl) return stub;
    try {
      const s = await slot.impl.status();
      if (!isObject(s)) return Object.assign(stub, { problem: slot.name + ' couldn\'t report its state.' });
      const out = Object.assign({}, s, { id: slot.id, name: s.name || slot.name, kind: s.kind || slot.kind });
      out.problem = slot.problem || s.problem || null;
      out.ready = !out.problem && s.ready !== false;
      out.warnings = Array.isArray(s.warnings) ? s.warnings : [];
      return out;
    } catch (e) {
      log.error(slot.name + ': status failed: ' + redact(e && (e.stack || e.message), [], 1500));
      return Object.assign(stub, { problem: slot.name + ' couldn\'t report its state. The details are in the AI service\'s log.' });
    }
  }

  function cleanEntry(slot, e) {
    if (!isObject(e)) return null;
    const model = typeof e.model === 'string' && e.model ? e.model : typeof e.id === 'string' ? e.id.replace(new RegExp('^' + slot.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), '') : '';
    if (!model) return null;
    return Object.assign({}, e, {
      id: slot.id + '/' + model, provider: slot.id, providerName: e.providerName || slot.name, model,
      name: typeof e.name === 'string' && e.name ? e.name : model,
      available: e.available === undefined ? null : e.available
    });
  }

  // Every ready provider's models, in config order → {slots, statuses, ready: Set, byProvider: Map, failures: Map, late: Set, entries}
  //   lo.only        list just this provider (a chat for "provider/model": another provider's slow list doesn't hold it up)
  //   lo.deadlineMs  answer without the providers whose list takes longer (MetaCode waits 3 s for GET /v1/status)
  //   lo.waitMs      passed to models(): how long to wait for live data before answering with what is known
  // A provider whose models() throws a ServiceError (the gateway refused the key, can't be reached…) isn't
  // ready: its message is the problem, and chats for its models get that error (failures).
  async function listModels(lo) {
    lo = lo || {};
    const current = [...slots.values()];
    const statuses = await Promise.all(current.map(statusOf));
    const byProvider = new Map();
    const ready = new Set();
    const failures = new Map();
    const late = new Set();
    await Promise.all(current.map(async (slot, i) => {
      if (!statuses[i].ready || !slot.impl || (lo.only && slot.id !== lo.only)) return;
      let timer = null;
      try {
        const listing = Promise.resolve().then(() => slot.impl.models(lo.waitMs !== undefined ? { waitMs: lo.waitMs } : undefined));
        const deadline = lo.deadlineMs ? new Promise(resolve => { timer = setTimeout(resolve, lo.deadlineMs, LATE); }) : null;
        const list = deadline ? await Promise.race([listing, deadline]) : await listing;
        if (list === LATE) {
          listing.catch(() => {});                       // (it's still cached by the provider when it comes)
          late.add(slot.id);
          statuses[i] = Object.assign({}, statuses[i], { ready: false, problem: slot.name + ' is still loading its model list. Try again in a moment.' });
          return;
        }
        const entries = (Array.isArray(list) ? list : []).map(e => cleanEntry(slot, e)).filter(Boolean);
        byProvider.set(slot.id, entries);
        ready.add(slot.id);
      } catch (e) {
        if (isServiceError(e)) failures.set(slot.id, e);   // (the provider logs its own list failures, once)
        else log.error(slot.name + ': listing models failed: ' + redact(e && (e.stack || e.message), [], 1500));
        statuses[i] = Object.assign({}, statuses[i], { ready: false,
          problem: isServiceError(e) && e.message ? e.message : slot.name + ' couldn\'t list its models. The details are in the AI service\'s log.' });
      } finally {
        clearTimeout(timer);
      }
    }));
    const entries = current.flatMap(slot => byProvider.get(slot.id) || []);
    return { slots: current, statuses, ready, byProvider, failures, late, entries };
  }

  // A provider's stored failure, for one request (the stored error is shared, so it's copied, never changed)
  function failureFor(se, provider, model) {
    return new ServiceError(se.status, se.type, se.message, {
      code: se.code, provider: se.provider || provider, model, scope: se.scope, upstreamStatus: se.upstreamStatus,
      retryAfterSeconds: se.retryAfterSeconds, resetAt: se.resetAt, window: se.window, log: se.log
    });
  }

  // ── Model resolution (spec §4.4) ────────────────────────────────────────────

  // The entry `ids` lists for a model part, exactly or under another spelling
  function findIn(entries, model) {
    const exact = entries.find(e => e.model === model);
    if (exact) return exact;
    if (modelMatch && typeof modelMatch.renamedModel === 'function') {
      const other = modelMatch.renamedModel(model, entries.map(e => e.model));
      if (other) return entries.find(e => e.model === other) || null;
    }
    const c = canonical(model);
    return entries.find(e => canonical(e.model) === c) || null;
  }

  // A bare id (saved before providers): the OpenAI-compatible providers first (config order), then Zen;
  // the first provider that has the model under any spelling wins (its exact spelling before others)
  function findBare(list, model) {
    const order = list.slots.filter(s => s.kind !== 'zen').concat(list.slots.filter(s => s.kind === 'zen')).filter(s => list.ready.has(s.id));
    for (const s of order) {
      const entries = list.byProvider.get(s.id);
      const e = entries.find(x => x.model === model) || findIn(entries, model);
      if (e) return { slot: s, entry: e };
    }
    return null;
  }

  function withVariant(found, variant, requested) {
    if (variant && variant !== 'default') {
      const variants = Array.isArray(found.entry.variants) ? found.entry.variants : [];
      if (!variants.includes(variant)) {
        throw new ServiceError(400, 'invalid_request', 'The model "' + found.entry.id + '" has no variant "' + variant.slice(0, 40) + '"' +
          (variants.length ? ' (it has ' + variants.join(', ') + ')' : ' (it has none)') + '.', { provider: found.slot.id, model: requested });
      }
    } else variant = null;
    return { slot: found.slot, entry: found.entry, variant, fullId: found.entry.id + (variant ? '#' + variant : '') };
  }

  // "provider/model#variant" or a bare id → {slot, entry, variant, fullId}; throws a ServiceError
  function resolve(requested, list) {
    let ref = String(requested).trim();
    let variant = null;
    const hash = ref.lastIndexOf('#');
    if (hash > 0) { variant = ref.slice(hash + 1).trim() || null; ref = ref.slice(0, hash).trim(); }
    if (!ref) throw new ServiceError(400, 'invalid_request', '"model" must be a model id such as "opencode/big-pickle".');
    const slash = ref.indexOf('/');
    if (slash > 0) {
      const pid = ref.slice(0, slash);
      const model = ref.slice(slash + 1);
      const slot = list.slots.find(s => s.id === pid);
      if (slot) {
        if (!list.ready.has(pid)) {
          if (list.failures.has(pid)) throw failureFor(list.failures.get(pid), pid, ref);
          const st = list.statuses[list.slots.indexOf(slot)];
          throw new ServiceError(503, 'not_configured', slot.name + ' isn\'t available' + (st && st.problem ? ': ' + st.problem : '.'), { provider: pid, model: ref });
        }
        const entry = findIn(list.byProvider.get(pid), model);
        if (!entry) {
          const why = slot.impl && typeof slot.impl.unlisted === 'function' ? slot.impl.unlisted(model) : null;
          throw why || new ServiceError(404, 'model_not_found', slot.name + ' doesn\'t offer the model "' + ref + '". Pick another model.', { provider: pid, model: ref });
        }
        return withVariant({ slot, entry }, variant, requested);
      }
      // (no such provider: maybe a bare id with a "/" in it)
      const bare = findBare(list, ref);
      if (bare) return withVariant(bare, variant, requested);
      throw new ServiceError(503, 'not_configured', 'MetaCode\'s OpenCode service has no AI provider "' + pid.slice(0, 40) + '" (see opencode/opencode.json and OPENCODE_CONFIG).', { model: ref });
    }
    const found = findBare(list, ref);
    if (found) return withVariant(found, variant, requested);
    for (const s of list.slots) {
      const why = list.ready.has(s.id) && s.impl && typeof s.impl.unlisted === 'function' ? s.impl.unlisted(ref) : null;
      if (why) throw why;
    }
    // (a provider that couldn't list its models may have it: say so)
    const failed = list.slots.find(s => list.failures.has(s.id));
    const slow = list.slots.find(s => list.late.has(s.id));
    const note = failed ? ' (' + failed.name + ' couldn\'t be asked: ' + list.failures.get(failed.id).message.replace(/\.$/, '') + '.)'
      : slow ? ' (' + slow.name + ' is still loading its model list.)' : '';
    throw new ServiceError(404, 'model_not_found', 'No AI provider of MetaCode\'s OpenCode service offers the model "' + ref.slice(0, 120) + '". Pick another model.' + note, { model: ref });
  }

  // The default model (spec §4.4) → {target, id (as listed), warnings}
  function chooseDefault(list) {
    const warnings = [];
    const candidates = [];
    const fromEnv = String(env.OPENCODE_MODEL || '').trim();
    if (fromEnv) candidates.push({ id: fromEnv, from: 'OPENCODE_MODEL' });
    if (config.model) candidates.push({ id: config.model, from: '"model" in the service\'s config' });
    const legacy = String(env.EMIS_MODEL || '').trim();
    if (!fromEnv && !config.model && legacy) candidates.push({ id: legacy.includes('/') ? legacy : 'emis/' + legacy, from: 'EMIS_MODEL' });
    for (const c of candidates) {
      try {
        const target = resolve(c.id, list);
        if (target.entry.available !== false) return { target, id: target.entry.id, warnings };
        warnings.push(c.from + ' is "' + c.id + '", which ' + target.slot.name + ' doesn\'t offer right now; the next default model is used.');
      } catch (e) {
        warnings.push(c.from + ' is "' + c.id.slice(0, 120) + '", which can\'t be used (' + e.message.replace(/\.$/, '') + '); the next default model is used.');
      }
    }
    const usable = entries => (entries || []).find(e => e.available !== false);
    const pick = (slot, entry) => ({ target: { slot, entry, variant: null, fullId: entry.id }, id: entry.id, warnings });
    const emis = list.slots.find(s => s.id === 'emis');
    const legacyEntry = emis && list.ready.has('emis') ? (list.byProvider.get('emis') || []).find(e => e.model === LEGACY_DEFAULT && e.available !== false) : null;
    if (legacyEntry) return pick(emis, legacyEntry);
    for (const s of list.slots.filter(x => x.kind === 'zen' && list.ready.has(x.id))) {
      const e = usable(list.byProvider.get(s.id));
      if (e) return pick(s, e);
    }
    for (const s of list.slots.filter(x => list.ready.has(x.id))) {
      const e = usable(list.byProvider.get(s.id));
      if (e) return pick(s, e);
    }
    return { target: null, id: null, warnings };
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  function modelJson(e, isDefault) {
    const released = e.releaseDate ? Date.parse(e.releaseDate) : NaN;
    const out = {
      id: e.id, object: 'model', created: Number.isFinite(released) ? Math.floor(released / 1000) : 0, owned_by: e.provider,
      provider: e.provider, provider_name: e.providerName, model: e.model, name: e.name, free: e.free,
      available: e.available === true || e.available === false ? e.available : null
    };
    if (isDefault) out.default = true;
    Object.assign(out, {
      tool_call: e.toolCall, reasoning: e.reasoning, attachment: e.attachment, temperature: e.temperature,
      context_window: e.contextWindow, max_output: e.maxOutput, variants: e.variants, release_date: e.releaseDate
    });
    for (const k of Object.keys(out)) if (out[k] === undefined || (out[k] === null && k !== 'available')) delete out[k];
    return out;
  }

  async function modelsRoute(req, res) {
    const list = await listModels({ deadlineMs: LIST_DEADLINE_MS });
    const def = chooseDefault(list);
    def.warnings.forEach(warnOnce);
    sendJson(res, 200, {
      object: 'list',
      default: def.id,
      providers: list.slots.map((s, i) => ({ id: s.id, name: list.statuses[i].name || s.name, ready: list.ready.has(s.id) })),
      data: list.entries.map(e => modelJson(e, e.id === def.id))
    });
  }

  // GET /v1/status (lo: listModels' options; by default it answers within STATUS_DEADLINE_MS)
  async function status(lo) {
    const list = await listModels(lo || { deadlineMs: STATUS_DEADLINE_MS, waitMs: STATUS_WAIT_MS });
    const def = chooseDefault(list);
    def.warnings.forEach(warnOnce);
    const warnings = [].concat(
      settings.problems, settings.warnings,
      envInfo && envInfo.error ? ['The settings file ' + (envInfo.file || '.env') + ' couldn\'t be read: ' + envInfo.error] : [],
      envInfo && envInfo.warnings || [],
      config.warnings, def.warnings
    );
    return {
      service: { name: SERVICE_NAME, version: VERSION, opencode: OPENCODE_AI_VERSION, startedAt, pid: process.pid, host: boundHost, port: boundPort },
      ready: list.entries.length > 0,
      default: def.id,
      warnings: [...new Set(warnings)],
      providers: list.slots.map((s, i) => Object.assign({}, list.statuses[i], { ready: list.ready.has(s.id) }))
    };
  }

  async function reload() {
    const run = reloading.then(async () => {
      const before = settings;
      readSettings();
      if (before && (before.port !== settings.port || before.host !== settings.host) && !opts.port && !opts.host) {
        log.warn('OPENCODE_SERVICE_HOST / OPENCODE_SERVICE_PORT changed; restart the AI service to use the new address.');
      }
      config.warnings.forEach(warnOnce);
      await applyConfig();
      return status({ deadlineMs: LIST_DEADLINE_MS });
    });
    reloading = run.catch(() => {});
    return run;
  }

  async function chatRoute(req, res, body) {
    const started = Date.now();
    const ac = new AbortController();
    inflight.add(ac);
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    if (res.destroyed || (req.socket && req.socket.destroyed)) ac.abort();      // gone while its body was read
    let target = null;
    let label = 'chat';
    let slot = null;
    const done = (status, extra) => log.info(label + ' → ' + status + (extra ? ' ' + extra : '') + ' in ' + seconds(Date.now() - started));
    try {
      const clean = validateChatBody(body);
      // "provider/model": only that provider's list is needed; a bare id or the default needs them all
      const named = clean.model ? /^([^/#]+)\//.exec(clean.model) : null;
      const list = await listModels({ only: named && slots.has(named[1]) ? named[1] : undefined, deadlineMs: LIST_DEADLINE_MS });
      if (clean.model) target = resolve(clean.model, list);
      else {
        const def = chooseDefault(list);
        def.warnings.forEach(warnOnce);
        target = def.target;
        if (!target) throw new ServiceError(503, 'not_configured', 'No AI provider of MetaCode\'s OpenCode service is ready, so there is no model to answer with. Check the AI providers in Settings.');
      }
      // (gone while the model lists were read: nothing is sent)
      if (ac.signal.aborted) throw new ServiceError(499, 'cancelled', 'The request was cancelled before it was sent to ' + target.slot.name + '.', { provider: target.slot.id, model: target.fullId });
      slot = target.slot;
      slot.inflight++;
      label = 'chat ' + target.fullId + (clean.stream ? ' (stream)' : '');
      const timeoutMs = upstreamTimeout(req.headers['x-request-timeout-ms']);
      const events = slot.impl.chat(clean, target.entry, { signal: ac.signal, timeoutMs, stream: clean.stream, variant: target.variant });
      const headers = { 'X-OpenCode-Provider': slot.id, 'X-OpenCode-Model': target.fullId };

      if (!clean.stream) {
        const completion = await toChatCompletion(events, { model: target.fullId });
        sendJson(res, 200, completion, headers);
        done(200);
        return;
      }
      const includeUsage = !!(clean.stream_options && clean.stream_options.include_usage);
      const it = toChunks(events, { model: target.fullId, includeUsage })[Symbol.asyncIterator]();
      let step = await it.next();               // the status line waits for the first upstream event
      res.writeHead(200, Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive'
      }, headers));
      try {
        for (; !step.done; step = await it.next()) await write(res, 'data: ' + JSON.stringify(step.value) + '\n\n');
        await write(res, 'data: [DONE]\n\n');
        res.end();
        done(200);
      } catch (err) {
        const e = asServiceError(err, slot, target, ac.signal);
        if (!res.destroyed) { res.write('data: ' + JSON.stringify(e.toBody()) + '\n\n'); res.end(); }
        it.return().catch(() => {});
        done(200, 'then ' + e.status + ' ' + e.type + describeLog(e));
      }
    } catch (err) {
      const e = asServiceError(err, target && target.slot, target, ac.signal);
      sendError(res, e);
      done(e.status, e.type + describeLog(e));
    } finally {
      inflight.delete(ac);
      if (slot) {
        slot.inflight--;
        if (slot.closing && slot.inflight === 0) Promise.resolve().then(() => slot.impl.close()).catch(() => {});
      }
    }
  }

  function describeLog(e) {
    const text = e.log || (e.type === 'cancelled' ? '' : e.message);
    return text ? ': ' + redact(text, [], 300) : '';
  }

  function asServiceError(err, slot, target, signal) {
    if (signal && signal.aborted && signal.reason === SHUTTING_DOWN) {
      return new ServiceError(500, 'internal_error', 'MetaCode\'s OpenCode service stopped (it is being restarted or shut down) before ' + (slot ? slot.name : 'the AI provider') +
        ' finished answering. Try again in a moment.', { code: 'shutting_down', provider: slot ? slot.id : undefined, model: target ? target.fullId : undefined, log: 'stopped by the shutdown' });
    }
    if (isServiceError(err)) return err;
    const e = fromAIError(err, { provider: slot ? slot.id : undefined, providerName: slot ? slot.name : undefined, model: target ? target.fullId : undefined, signal });
    if (e.type === 'internal_error') log.error('Unexpected failure: ' + (e.log || ''));
    return e;
  }

  async function handle(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://service').pathname.replace(/\/+$/, '') || '/'; } catch (e) { pathname = '/'; }
    if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { ok: true, service: SERVICE_NAME, version: VERSION, opencode: OPENCODE_AI_VERSION, startedAt, pid: process.pid });
      return;
    }
    if (pathname === '/v1' || pathname.startsWith('/v1/')) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || ''));
      if (!m || !sameToken(m[1], token)) {
        req.resume();
        sendError(res, new ServiceError(401, 'authentication_error', 'MetaCode\'s OpenCode service needs its access token (Authorization: Bearer …). MetaCode and the service read it from ' +
          'OPENCODE_SERVICE_TOKEN, else from the token file in OPENCODE_SERVICE_DATA_DIR: give both the same one.'), { 'WWW-Authenticate': 'Bearer' });
        return;
      }
      if (closing) {
        req.resume();
        sendError(res, new ServiceError(500, 'internal_error', 'MetaCode\'s OpenCode service is shutting down. Try again in a moment.', { code: 'shutting_down' }), { Connection: 'close' });
        return;
      }
      const route = req.method + ' ' + pathname;
      if (route === 'GET /v1/models') { req.resume(); await modelsRoute(req, res); return; }
      if (route === 'GET /v1/status') { req.resume(); sendJson(res, 200, await status()); return; }
      if (route === 'POST /v1/reload') { req.resume(); sendJson(res, 200, await reload()); return; }
      if (route === 'POST /v1/chat/completions') {
        let body;
        try { body = await readBody(req); }
        catch (e) {
          if (!isServiceError(e)) throw e;
          sendError(res, e, { Connection: 'close' });
          if (e.cutOff) res.once('finish', () => req.socket && req.socket.destroy());
          return;
        }
        await chatRoute(req, res, body);
        return;
      }
    }
    req.resume();
    sendJson(res, 404, { error: { message: 'MetaCode\'s OpenCode service has no ' + req.method + ' ' + pathname.slice(0, 100) + '.', type: 'not_found' } });
  }

  // ── Start ───────────────────────────────────────────────────────────────────

  readSettings();
  await applyConfig();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      log.error('Unexpected failure: ' + redact(err && (err.stack || err.message), [token], 2000));
      if (!res.headersSent) sendError(res, new ServiceError(500, 'internal_error', 'MetaCode\'s OpenCode service ran into an unexpected problem. The details are in the service\'s log.'));
      else res.end();
    });
  });
  server.keepAliveTimeout = 65000;
  server.requestTimeout = 0;                    // chats can take minutes; the upstream limits apply instead
  server.headersTimeout = 60000;

  const host = opts.host || settings.host;
  const port = opts.port !== undefined && opts.port !== null ? opts.port : settings.port;
  let boundPort = port;
  const boundHost = host;
  try {
    await new Promise((resolve, reject) => {
      const onError = e => { server.removeListener('listening', onListening); reject(e); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    await Promise.all([...slots.values()].map(s => (s.impl ? Promise.resolve().then(() => s.impl.close()).catch(() => {}) : null)));
    if (e && e.code === 'EADDRINUSE') {
      throw Object.assign(new Error('Port ' + port + ' is in use — another MetaCode OpenCode service is probably running (for example one started by MetaCode itself; ' +
        'set OPENCODE_SERVICE_MANAGED=off for MetaCode when pm2 runs the service). Or set OPENCODE_SERVICE_PORT to a free port.'), { code: 'EADDRINUSE' });
    }
    throw e;
  }
  boundPort = server.address().port;
  server.on('error', e => log.error('AI service: ' + redact(e && e.message, [token], 500)));
  const url = 'http://' + urlHost(host) + ':' + boundPort + '/v1';

  [].concat(settings.problems, settings.warnings, envInfo && envInfo.warnings || [], config.warnings).forEach(warnOnce);
  if (envInfo && envInfo.error) warnOnce('The settings file ' + (envInfo.file || '.env') + ' couldn\'t be read: ' + envInfo.error);
  const first = await listModels({ deadlineMs: STATUS_DEADLINE_MS, waitMs: STATUS_WAIT_MS });
  const summary = first.slots.map((s, i) => {
    if (first.ready.has(s.id)) return s.name + ': ' + first.byProvider.get(s.id).length + ' model' + (first.byProvider.get(s.id).length === 1 ? '' : 's');
    return s.name + ': ' + (s.disabled ? 'switched off' : 'not ready' + (first.statuses[i].problem ? ' (' + first.statuses[i].problem.replace(/\.$/, '') + ')' : ''));
  }).join('; ');
  log.info('MetaCode\'s OpenCode service (OpenCode ' + OPENCODE_AI_VERSION + ') is listening on ' + url.replace(/\/v1$/, '') + ' — ' + (summary || 'no AI providers') + '.');

  // Stops taking requests; running chats get graceMs to finish, then are cancelled with a failure that
  // says the service stopped (code shutting_down: an error event in a stream, else a 500) and get a
  // moment to send it before the connections close. Requests arriving meanwhile get the same 500.
  let closed = null;
  function close(closeOpts) {
    if (!closed) closed = shutDown(closeOpts && closeOpts.graceMs > 0 ? closeOpts.graceMs : 0);
    return closed;
  }
  async function shutDown(graceMs) {
    closing = true;
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const serverClosed = new Promise(r => server.close(() => r()));
    const deadline = Date.now() + graceMs;
    while (inflight.size && Date.now() < deadline) await pause(25);
    for (const ac of inflight) ac.abort(SHUTTING_DOWN);
    const answered = Date.now() + 1000;
    while (inflight.size && Date.now() < answered) await pause(10);
    server.closeIdleConnections();
    await Promise.race([serverClosed, pause(500)]);
    server.closeAllConnections();
    await Promise.all([...slots.values()].map(s => (s.impl ? Promise.resolve().then(() => s.impl.close()).catch(() => {}) : null)));
  }

  return { server, url, port: boundPort, token, reload, close, status };
}

// ── node opencode/server.mjs ──────────────────────────────────────────────────
// (pm2 runs a loader that import()s the file named by pm_exec_path, so there
// process.argv[1] is pm2's loader. A service started by a MetaCode that pm2
// runs inherits pm_exec_path=server.js, which isn't this file.)

const isMain = (() => {
  const self = fs.realpathSync(fileURLToPath(import.meta.url));
  const isThis = file => { try { return !!file && fs.realpathSync(file) === self; } catch (e) { return false; } };
  return isThis(process.argv[1]) || isThis(process.env.pm_exec_path);
})();

if (isMain) {
  process.on('unhandledRejection', err => console.error('AI service: unexpected failure: ' + redact(err && (err.stack || err.message), [], 2000)));
  startService().then(svc => {
    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(1);
      stopping = true;
      svc.close({ graceMs: 1000 }).finally(() => { console.log('MetaCode\'s OpenCode service stopped.'); process.exit(0); });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }, err => {
    console.error(err && err.code === 'EADDRINUSE' ? err.message : 'MetaCode\'s OpenCode service couldn\'t start: ' + redact(err && (err.stack || err.message), [], 2000));
    process.exit(1);
  });
}
