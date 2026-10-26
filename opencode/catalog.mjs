// ── The OpenCode Zen model catalog ────────────────────────────────────────────
// Which models OpenCode Zen offers, how each one is reached (protocol and
// address), what it can do and what it costs come from models.dev's catalog,
// the same one OpenCode itself uses (https://models.opencode.ai/api.json, its
// "opencode" provider entry). The service keeps one copy in memory:
//
//   1. OPENCODE_MODELS_PATH   a local models.dev JSON file; wins over everything (OpenCode's variable)
//   2. <dataDir>/models-catalog.json   the copy last fetched (the cache)
//   3. opencode/zen-models.json        the copy bundled with MetaCode (scripts/update-zen-models.mjs)
//
// Unless OPENCODE_DISABLE_MODELS_FETCH is set, a fresh copy is fetched in the
// background at start and every hour from OPENCODE_MODELS_URL (default
// https://models.opencode.ai) + /api.json, with the ETag of the cached copy
// (304 = unchanged) and a 10 s timeout. A good answer is written to the cache
// and replaces the copy in memory; a failure keeps the current copy.
//
// normalize() turns the provider entry into the models the Zen provider offers.
// It is a port of what OpenCode 2.1.4's core does for the "opencode" provider
// (models-dev.ts, variant.ts, plugin/models-dev.ts, plugin/provider/opencode.ts
// and model.ts), which can't be loaded on Node 22 itself: deprecated models,
// models without text in and out and realtime/embedding/reranking models are
// dropped; the model's npm package picks the protocol; its reasoning_options
// become variants spelled the way each protocol takes them; a model is free
// when every price tier's input costs 0. OPENCODE_API_KEY goes to a model's
// address, so one from a fetched or cached catalog must be Zen's own (under
// https://opencode.ai/inference/), or the model is left out; the operator's
// own file (OPENCODE_MODELS_PATH) is used as it is.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fetch as undiciFetch } from 'undici';
import { USER_AGENT, dispatcherFor } from './http.mjs';

const require = createRequire(import.meta.url);
const shared = require('./shared.js');

export const DEFAULT_MODELS_URL = 'https://models.opencode.ai';
/** The prefix of Zen's model addresses that OPENCODE_INFERENCE_URL replaces. */
export const ZEN_INFERENCE_PREFIX = 'https://opencode.ai/inference';
export const BUNDLED_PATH = fileURLToPath(new URL('./zen-models.json', import.meta.url));
export const CACHE_FILE = 'models-catalog.json';

const REFRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;     // api.json is about 6 MB today

// npm package of a models.dev model → the @opencode/ai protocol the service speaks to it
const PROTOCOL_OF = {
  '@ai-sdk/openai-compatible': 'chat',
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google',
  '@ai-sdk/mistral': 'mistral'
};

/** protocol → the @opencode/ai module whose model(id, settings) makes the model object */
export const PROTOCOL_MODULES = Object.freeze({
  chat: '@opencode/ai/providers/openai-compatible',
  responses: '@opencode/ai/providers/openai',
  anthropic: '@opencode/ai/providers/anthropic',
  google: '@opencode/ai/providers/google',
  mistral: '@opencode/ai/providers/mistral'
});

// Signed out, OpenCode lists these free models first (core/src/model.ts PREFERRED_FREE)
export const PREFERRED_FREE = Object.freeze(['big-pickle', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'muse-spark-1.3-contributor-free']);

const NON_CHAT_TYPES = new Set(['realtime', 'embedding', 'reranking']);

// ── Variants (core/src/variant.ts, for the five protocols Zen uses) ───────────

const EFFORTS = ['low', 'medium', 'high'];
const ADAPTIVE = { type: 'adaptive', display: 'summarized' };
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32000;

const variant = (id, overlay) => Object.assign({ id }, overlay);
const efforts = (values, spell) => values.map(e => variant(e, spell(e)));
const toggle = (off, on) => [variant('none', off), variant('thinking', on)];

function budgets(model, support, spell, ceiling = model.output) {
  const max = Math.min(support.max !== undefined ? support.max : ceiling - 1, model.output - 1, ceiling - 1);
  if (!(max > 0)) return [];
  const high = Math.min(Math.max(support.min || 0, Math.floor((max + 1) / 2)), max);
  return [variant('high', spell(high)), variant('max', spell(max))];
}

function claudeInfo(id) {
  const a = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(id);
  const b = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(id);
  const family = ((a && a[1]) || (b && b[3]) || '').toLowerCase() || undefined;
  const major = Number((a && a[2]) || (b && b[1]));
  const minor = Number((a && a[3]) || (b && b[2]) || 0);
  return {
    family, major, minor,
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    always: family === 'fable' || family === 'mythos' || id.toLowerCase().includes('mythos-preview')
  };
}

function manualThinking(model) {
  const tokens = Math.min(16000, model.output - 1);
  return tokens < 1024 ? undefined : { settings: { thinking: { type: 'enabled', budgetTokens: tokens } } };
}

const responsesEffort = e => ({ settings: { reasoningEffort: e, reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] } });

const VARIANTS = {
  chat: (m, s) => (s.type !== 'effort' ? [] : efforts(s.values || EFFORTS, e => ({ settings: { reasoningEffort: e } }))),
  mistral: (m, s) => VARIANTS.chat(m, s),
  responses: (m, s) => (s.type !== 'effort' ? [] : efforts(s.values || ['none', 'minimal', ...EFFORTS, 'xhigh'], responsesEffort)),
  anthropic: function anthropic(m, s) {
    const info = claudeInfo(m.id);
    const opus45 = info.family === 'opus' && info.major === 4 && info.minor === 5;
    if (s.type === 'effort') {
      if (info.manual && !opus45) return anthropic(m, { type: 'budget_tokens', min: 1024 });
      const thinking = opus45 ? manualThinking(m) : { settings: { thinking: ADAPTIVE } };
      if (!thinking) return [];
      const defaults = info.major === 4 && info.minor === 6 ? [...EFFORTS, 'max'] : [...EFFORTS, 'xhigh', 'max'];
      return efforts((s.values || defaults).filter(e => !info.always || e !== 'none'),
        e => (e === 'none' ? { settings: { thinking: { type: 'disabled' } } } : { settings: Object.assign({}, thinking.settings, { effort: e }) }));
    }
    if (s.type === 'toggle') {
      if (info.always) return [];
      const thinking = info.manual ? manualThinking(m) : { settings: { thinking: ADAPTIVE } };
      return thinking ? toggle({ settings: { thinking: { type: 'disabled' } } }, thinking) : [];
    }
    return budgets(m, s, t => ({ settings: { thinking: { type: 'enabled', budgetTokens: t } } }), ANTHROPIC_OUTPUT_TOKEN_MAX);
  },
  google: (m, s) => {
    if (s.type === 'effort') return efforts(s.values || EFFORTS, e => ({ settings: { thinkingConfig: { includeThoughts: true, thinkingLevel: e } } }));
    if (s.type === 'toggle') {
      return toggle({ settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } },
        { settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } } });
    }
    return budgets(m, s, t => ({ settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: t } } }));
  }
};

// Variant.resolve(): the "none" of a toggle, then the effort variants (else budget, else toggle), no duplicates
function resolveVariants(protocol, model, supports) {
  const spell = VARIANTS[protocol];
  if (!spell) return [];
  const tg = supports.some(s => s.type === 'toggle') ? spell(model, { type: 'toggle' }) : [];
  const effort = supports.find(s => s.type === 'effort');
  const budget = supports.find(s => s.type === 'budget_tokens');
  const main = effort ? spell(model, effort) : budget ? spell(model, budget) : tg;
  const all = [...tg.filter(v => v.id === 'none'), ...main];
  return all.filter((v, i) => all.findIndex(o => o.id === v.id) === i);
}

function supportsOf(m) {
  return (Array.isArray(m.reasoning_options) ? m.reasoning_options : []).filter(o => o && typeof o === 'object').map(o =>
    (o.type === 'effort' ? { type: 'effort', values: Array.isArray(o.values) ? o.values.filter(v => typeof v === 'string' && v !== 'null') : undefined } : o));
}

// ── Normalisation ─────────────────────────────────────────────────────────────

const count = v => (Number.isInteger(v) && v > 0 ? v : undefined);
const price = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function swapPrefix(url, inferenceUrl) {
  if (!inferenceUrl || typeof url !== 'string') return url;
  return url.toLowerCase().startsWith(ZEN_INFERENCE_PREFIX) ? inferenceUrl.replace(/\/+$/, '') + url.slice(ZEN_INFERENCE_PREFIX.length) : url;
}

// A model's address from a fetched or cached catalog, as a URL, only when it is Zen's own
// (https://opencode.ai/inference/…): OPENCODE_API_KEY goes there, so nowhere else; else null
function zenAddress(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'opencode.ai' || u.port || u.username || u.password || !u.pathname.startsWith('/inference/')) return null;
  return u.href;
}

/** The "opencode" provider entry of a models.dev api.json (or of zen-models.json), or null. */
export function zenEntry(json) {
  const entry = json && typeof json === 'object' ? json.opencode : null;
  return entry && typeof entry === 'object' && !Array.isArray(entry) && entry.models && typeof entry.models === 'object' && !Array.isArray(entry.models) ? entry : null;
}

/**
 * The models of a Zen provider entry, the way OpenCode 2.1.4 builds them.
 *
 * @param {object} entry                  the "opencode" provider entry of a models.dev api.json
 * @param {object} [opts]
 * @param {string} [opts.inferenceUrl]    replaces the https://opencode.ai/inference prefix of model addresses
 * @param {boolean} [opts.trusted]        the operator's own file (OPENCODE_MODELS_PATH): model addresses are used as
 *                                        they are; otherwise a model whose address isn't under
 *                                        https://opencode.ai/inference/ is left out (dropped.address)
 * @returns {{models: object[], dropped: {deprecated: number, notText: number, unsupported: string[], address: string[]}}}
 *   models (catalog order): {id, name, family, protocol, baseURL, toolCall, reasoning, attachment, temperature,
 *   input[], output[], contextWindow, inputLimit, maxOutput, cost: [{input, output}], free,
 *   variants: [{id, settings}], releaseDate, released (ms, 0 if unknown), reasoningField, status}
 */
export function normalize(entry, opts) {
  const inferenceUrl = opts && opts.inferenceUrl;
  const trusted = !!(opts && opts.trusted);
  const models = [];
  const dropped = { deprecated: 0, notText: 0, unsupported: [], address: [] };
  if (!zenEntry({ opencode: entry })) return { models, dropped };
  for (const [key, m] of Object.entries(entry.models)) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' && m.id ? m.id : key;
    if (m.status === 'deprecated') { dropped.deprecated++; continue; }
    const input = Array.isArray(m.modalities && m.modalities.input) ? m.modalities.input.filter(x => typeof x === 'string') : [];
    const output = Array.isArray(m.modalities && m.modalities.output) ? m.modalities.output.filter(x => typeof x === 'string') : [];
    const text = list => list.length === 0 || list.some(x => x.startsWith('text'));
    if (!text(input) || !text(output) || NON_CHAT_TYPES.has(m.type)) { dropped.notText++; continue; }
    const npm = (m.provider && m.provider.npm) || entry.npm;
    const protocol = PROTOCOL_OF[npm];
    if (!protocol) { dropped.unsupported.push(id); continue; }
    const raw = (m.provider && m.provider.api) || entry.api;
    const address = trusted ? raw : zenAddress(raw);
    if (!address) { dropped.address.push(id); continue; }

    const limit = m.limit && typeof m.limit === 'object' ? m.limit : {};
    const cost = [{ input: price(m.cost && m.cost.input), output: price(m.cost && m.cost.output) }]
      .concat((m.cost && Array.isArray(m.cost.tiers) ? m.cost.tiers : []).map(t => ({ input: price(t && t.input), output: price(t && t.output) })));
    const interleaved = m.interleaved;
    const reasoningField = typeof interleaved === 'string' ? interleaved
      : interleaved && typeof interleaved === 'object' && typeof interleaved.field === 'string' ? interleaved.field : undefined;
    const maxOutput = count(limit.output);
    const released = Date.parse(m.release_date);
    models.push({
      id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : id,
      family: typeof m.family === 'string' ? m.family : undefined,
      protocol,
      baseURL: swapPrefix(address, inferenceUrl),
      toolCall: m.tool_call === true,
      reasoning: m.reasoning === true,
      attachment: typeof m.attachment === 'boolean' ? m.attachment : input.some(x => !x.startsWith('text')),
      temperature: m.temperature !== false,
      input, output,
      contextWindow: count(limit.context),
      inputLimit: count(limit.input),
      maxOutput,
      cost,
      free: !cost.some(c => c.input > 0),
      variants: resolveVariants(protocol, { id, output: maxOutput || 32000 }, supportsOf(m)),
      releaseDate: typeof m.release_date === 'string' && m.release_date ? m.release_date : undefined,
      released: Number.isFinite(released) ? released : 0,
      reasoningField: protocol === 'chat' ? reasoningField : undefined,
      status: m.status || 'active'
    });
  }
  return { models, dropped };
}

/**
 * OpenCode's order: newest release first; when every model is free (no key),
 * PREFERRED_FREE comes first (so the default is the same as OpenCode's).
 */
export function orderModels(models) {
  const sorted = models.slice().sort((a, b) => b.released - a.released);
  if (!sorted.length || !sorted.every(m => m.free)) return sorted;
  const picks = PREFERRED_FREE.map(id => sorted.find(m => m.id === id)).filter(Boolean);
  return picks.concat(sorted.filter(m => !picks.includes(m)));
}

// ── Fetching ──────────────────────────────────────────────────────────────────

async function readLimited(res, max) {
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error('the catalog is larger than ' + Math.round(max / 1048576) + ' MB'); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

const hostOf = url => { try { return new URL(url).host; } catch (e) { return '?'; } };

/**
 * Fetches a models.dev api.json and returns its Zen entry.
 *
 * @param {string} url             the api.json address
 * @param {object} [opts]          {env (proxy variables), etag (If-None-Match), timeoutMs (default 10 s), signal}
 * @returns {Promise<{notModified: true} | {entry: object, etag: string|undefined, bytes: number}>}
 * @throws {Error} with a short reason (HTTP status, timeout, no Zen entry…); never contains the URL's query
 */
export async function fetchCatalog(url, opts) {
  const { env, etag, timeoutMs = FETCH_TIMEOUT_MS, signal } = opts || {};
  const dispatcher = dispatcherFor('env', env || {});      // direct, or HTTPS_PROXY / HTTP_PROXY with NO_PROXY, like the providers
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('no answer within ' + Math.round(timeoutMs / 1000) + ' s')), timeoutMs);
  const onAbort = () => ac.abort(new Error('stopped'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
    if (etag) headers['if-none-match'] = etag;
    let res;
    try { res = await undiciFetch(url, { headers, dispatcher, signal: ac.signal }); }
    catch (e) { throw new Error(ac.signal.aborted && ac.signal.reason ? ac.signal.reason.message : (e.cause && e.cause.code) || e.code || e.message); }
    if (res.status === 304) { await res.body?.cancel().catch(() => {}); return { notModified: true }; }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error('HTTP ' + res.status); }
    let text;
    try { text = await readLimited(res, MAX_CATALOG_BYTES); }
    catch (e) { throw new Error(ac.signal.aborted && ac.signal.reason ? ac.signal.reason.message : e.message); }
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('the answer isn\'t JSON'); }
    const entry = zenEntry(json);
    if (!entry) throw new Error('the catalog has no OpenCode Zen ("opencode") entry');
    return { entry, etag: res.headers.get('etag') || undefined, bytes: Buffer.byteLength(text) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    dispatcher.close().catch(() => {});
  }
}

// ── The catalog the service runs with ─────────────────────────────────────────

function readSettings(env) {
  const warnings = [];
  const rawFile = String(env.OPENCODE_MODELS_PATH || '').trim();
  let url = String(env.OPENCODE_MODELS_URL || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^/\s]+/i.test(url)) {
    warnings.push('OPENCODE_MODELS_URL isn\'t an http(s) address; the OpenCode Zen catalog comes from ' + DEFAULT_MODELS_URL + '.');
    url = '';
  } else if (url && /^http:/i.test(url)) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { host = ''; }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) warnings.push('OPENCODE_MODELS_URL uses plain http, so the OpenCode Zen catalog could be changed on its way here. Use https.');
  }
  return {
    file: rawFile ? path.resolve(shared.REPO_DIR, rawFile) : null,
    url: url || DEFAULT_MODELS_URL,
    fetch: !shared.isOn(env.OPENCODE_DISABLE_MODELS_FETCH),
    warnings
  };
}

// The date in zen-models.json's "_source" ("… (2026-10-26)"), as the time the bundled copy was made
function bundledDate(json) {
  const m = /\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(String(json && json._source || ''));
  return m ? new Date(m[1] + 'T00:00:00Z').toISOString() : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

const digest = entry => crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');

/**
 * The catalog the Zen provider reads.
 *
 * @param {object} opts
 * @param {object} opts.env           the service's environment (OPENCODE_MODELS_*, proxy variables)
 * @param {string} opts.dataDir       where models-catalog.json (the cache) is kept
 * @param {object} [opts.log]         {info, warn}
 * @param {string} [opts.bundledPath] default opencode/zen-models.json
 * @returns {{load, current, refresh, start, stop, reload, status, warnings}}
 *   current() → {entry, source: 'file'|'cache'|'bundled'|'remote'|'none', updatedAt, checkedAt, version, problem}
 *   (version changes whenever the entry is replaced)
 */
export function createCatalog(opts) {
  const { dataDir, bundledPath = BUNDLED_PATH } = opts;
  const log = opts.log || { info() {}, warn() {} };
  let env = opts.env || {};
  let settings = readSettings(env);
  let loadWarnings = [];
  let state = { entry: null, source: 'none', updatedAt: null, checkedAt: null, etag: undefined, digest: null, version: 0, problem: null };
  let timer = null;
  let running = false;
  let pending = null;
  let lastFailureLog = 0;
  let stopper = null;
  const cacheFile = () => path.join(dataDir, CACHE_FILE);

  function swap(next) {
    state = Object.assign({}, next, { version: state.version + 1 });
  }

  // Sync: file → cache → bundled
  function load() {
    loadWarnings = [];
    if (settings.file) {
      try {
        const entry = zenEntry(readJson(settings.file));
        if (!entry) throw new Error('it has no OpenCode Zen ("opencode") entry');
        swap({ entry, source: 'file', updatedAt: fs.statSync(settings.file).mtime.toISOString(), checkedAt: null, etag: undefined, digest: digest(entry), problem: null });
        return current();
      } catch (e) {
        loadWarnings.push('OPENCODE_MODELS_PATH (' + settings.file + ') couldn\'t be used (' + (e.code || e.message) + '); the cached or bundled OpenCode Zen catalog is used instead.');
      }
    }
    try {
      const cached = readJson(cacheFile());
      const entry = zenEntry(cached);
      if (entry && cached.url === settings.url) {
        swap({ entry, source: 'cache', updatedAt: cached.updatedAt || null, checkedAt: cached.checkedAt || null, etag: cached.etag || undefined, digest: digest(entry), problem: null });
        return current();
      }
    } catch (e) {
      if (e.code !== 'ENOENT') loadWarnings.push('The cached OpenCode Zen catalog (' + cacheFile() + ') couldn\'t be read (' + (e.code || 'not JSON') + '); the bundled one is used.');
    }
    try {
      const json = readJson(bundledPath);
      const entry = zenEntry(json);
      if (!entry) throw new Error('no OpenCode Zen entry');
      swap({ entry, source: 'bundled', updatedAt: bundledDate(json), checkedAt: null, etag: undefined, digest: digest(entry), problem: null });
    } catch (e) {
      swap({ entry: null, source: 'none', updatedAt: null, checkedAt: null, etag: undefined, digest: null,
        problem: 'MetaCode\'s copy of the OpenCode Zen model catalog (opencode/zen-models.json) is missing or damaged. Update MetaCode (git pull).' });
    }
    return current();
  }

  function current() {
    return { entry: state.entry, source: state.source, updatedAt: state.updatedAt, checkedAt: state.checkedAt, version: state.version, problem: state.problem };
  }

  function writeCache(record) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = cacheFile() + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(record) + '\n');
      fs.renameSync(tmp, cacheFile());
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* never written */ }
      throw e;
    }
  }

  function failed(reason) {
    if (Date.now() - lastFailureLog < REFRESH_MS) return;
    lastFailureLog = Date.now();
    log.warn('Couldn\'t refresh the OpenCode Zen model catalog from ' + hostOf(settings.url) + ' (' + reason + '); keeping the ' + state.source + ' copy.');
  }

  // One check against OPENCODE_MODELS_URL; → 'updated' | 'unchanged' | 'skipped' | 'failed'
  function refresh() {
    if (!settings.fetch || state.source === 'file') return Promise.resolve('skipped');
    if (pending) return pending;
    const ac = new AbortController();
    stopper = ac;
    const url = settings.url + '/api.json';
    const fromHere = state.source === 'cache' || state.source === 'remote';
    pending = fetchCatalog(url, { env, etag: fromHere ? state.etag : undefined, signal: ac.signal })
      .then(r => {
        const now = new Date().toISOString();
        if (r.notModified) {
          state.checkedAt = now;
          try { writeCache({ _source: 'models.dev catalog from ' + hostOf(settings.url), url: settings.url, etag: state.etag, updatedAt: state.updatedAt, checkedAt: now, opencode: state.entry }); }
          catch (e) { /* the copy in memory is still good */ }
          return 'unchanged';
        }
        const dig = digest(r.entry);
        if (!normalize(r.entry).models.length) throw new Error('the catalog lists no usable OpenCode Zen models');
        const same = dig === state.digest;
        const record = { _source: 'models.dev catalog from ' + hostOf(settings.url), url: settings.url, etag: r.etag, updatedAt: same && fromHere ? state.updatedAt : now, checkedAt: now, opencode: r.entry };
        try { writeCache(record); }
        catch (e) { log.warn('Couldn\'t save the OpenCode Zen catalog to ' + cacheFile() + ' (' + (e.code || e.message) + ').'); }
        if (same) {
          Object.assign(state, { etag: r.etag, checkedAt: now, source: fromHere ? state.source : 'remote', updatedAt: record.updatedAt });
          return 'unchanged';
        }
        swap({ entry: r.entry, source: 'remote', updatedAt: now, checkedAt: now, etag: r.etag, digest: dig, problem: null });
        log.info('OpenCode Zen model catalog updated from ' + hostOf(settings.url) + ' (' + Object.keys(r.entry.models).length + ' models).');
        return 'updated';
      })
      .catch(e => {
        if (ac.signal.aborted) return 'skipped';
        failed(e.message);
        return 'failed';
      })
      .finally(() => { pending = null; if (stopper === ac) stopper = null; });
    return pending;
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (!running || !settings.fetch || state.source === 'file') return;
    timer = setTimeout(() => {
      refresh().finally(() => schedule(REFRESH_MS));
    }, ms);
    if (timer.unref) timer.unref();
  }

  function start() {
    running = true;
    schedule(0);
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
    if (stopper) stopper.abort();
  }

  // New settings (Reload .env): re-read file/cache/bundled; check again at once when the source changed
  function reload(nextEnv) {
    const before = settings;
    env = nextEnv || env;
    settings = readSettings(env);
    load();
    const changed = before.url !== settings.url || before.file !== settings.file || before.fetch !== settings.fetch;
    if (running && (changed || !timer)) schedule(0);
    return current();
  }

  return {
    load, current, refresh, start, stop, reload,
    status: () => ({ source: state.source, updatedAt: state.updatedAt, checkedAt: state.checkedAt, models: state.entry ? Object.keys(state.entry.models).length : 0 }),
    get warnings() { return settings.warnings.concat(loadWarnings); }
  };
}
