// ── OpenCode Zen ──────────────────────────────────────────────────────────────
// OpenCode's own AI gateway (provider id "opencode"), reached the way OpenCode
// 2.1.4 reaches it:
//
//   - models: the catalog (catalog.mjs). Without OPENCODE_API_KEY only the free
//     models are offered and requests carry the key "public"; with a key every
//     model is offered and the key is sent. OPENCODE_DISABLE_FREE_MODELS takes
//     the free ones away (without a key that leaves nothing).
//   - requests: per model, @opencode/ai's package for its protocol (chat,
//     responses, anthropic, google, mistral) at the model's address
//     (OPENCODE_INFERENCE_URL replaces https://opencode.ai/inference, for tests
//     and proxies), with the key always passed explicitly (a stray
//     OPENAI_API_KEY / ANTHROPIC_API_KEY in the environment must never reach
//     Zen), a new x-opencode-session per request, x-opencode-client: metacode
//     and the User-Agent of a custom OpenCode build (http.mjs).
//   - variants: "#high" in the model id, else reasoning_effort when the model
//     has a variant of that name (else it's ignored).
//   - limits: a 429 for the whole account (FreeUsageLimitError without a key,
//     BudgetLimitError, GoUsageLimitError, insufficient quota) rests the
//     provider until it resets (at most an hour): requests in the meantime are
//     answered at once with the same failure, without asking Zen. With a key,
//     FreeUsageLimitError rests only the free models (the paid ones still
//     answer), and a BudgetLimitError whose "coverage" is "models" is that
//     model's own spend limit (scope 'model', nothing rests). Any other 429
//     only concerns the model asked for (MetaCode rests that model).

import crypto from 'node:crypto';
import { LanguageModel } from '@opencode/ai';
import { createAI } from '../http.mjs';
import { toLLMInput } from '../openai.mjs';
import { ServiceError, fromAIError, describeWait, zenLimitOf } from '../errors.mjs';
import { createCatalog, normalize, orderModels, PROTOCOL_MODULES } from '../catalog.mjs';

const MAX_REST_SECONDS = 3600;
const DEFAULT_REST_SECONDS = 900;      // an account limit that didn't say when it resets
const PUBLIC_KEY = 'public';           // what OpenCode sends to Zen without a key
const MODEL_BUDGET_HINT = 'This model\'s spend limit is reached; pick another model.';
const FREE_LIMIT_HINT = 'The free models\' limit is reached; pick a paid model.';

const modules = new Map();
function protocolModule(protocol) {
  if (!modules.has(protocol)) modules.set(protocol, import(PROTOCOL_MODULES[protocol]));
  return modules.get(protocol);
}

// OpenCode's session ids: "ses_" + 12 hex (time, newest first) + 14 base62 (core's Identifier.descending)
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastTime = 0;
let sameTime = 0;
export function sessionId() {
  const now = Date.now();
  if (now !== lastTime) { lastTime = now; sameTime = 0; }
  sameTime++;
  const value = ~(BigInt(now) * 0x1000n + BigInt(sameTime));
  let time = '';
  for (let i = 0; i < 6; i++) time += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0');
  return 'ses_' + time + Array.from(crypto.randomBytes(14), b => BASE62[b % 62]).join('');
}

const PLACEHOLDER = /^(?:your[-_ ]?(?:api[-_ ]?)?key(?:[-_ ]?here)?|changeme|change[-_ ]me|x{3,}|\.\.\.|…|<[^>]*>|sk-\.\.\.|api[-_ ]?key)$/i;

function readKey(config, env) {
  const raw = String(config.options && config.options.apiKey || env.OPENCODE_API_KEY || '');
  const key = raw.replace(/[​-‍⁠﻿]/g, '').trim();
  if (!key || key === PUBLIC_KEY) return { key: null, warnings: [] };
  if (PLACEHOLDER.test(key)) return { key: null, warnings: ['OPENCODE_API_KEY looks like a placeholder (from .env.example), so it is ignored and only free OpenCode Zen models are offered.'] };
  if (!/^[\x21-\x7E]+$/.test(key)) return { key: null, warnings: ['OPENCODE_API_KEY has spaces or unusual characters in it, so it is ignored and only free OpenCode Zen models are offered. Copy the key again from opencode.ai.'] };
  return { key, warnings: [] };
}

const masked = key => (key.length >= 12 ? '…' + key.slice(-4) : '…');

/**
 * The OpenCode Zen provider (see the interface in server.mjs).
 *
 * @param {object} opts  {id, config, env, dataDir, log, shared}; `config` is the merged provider entry from config.mjs
 */
export function createProvider(opts) {
  const { id, dataDir, log } = opts;
  let config = opts.config || { options: {} };
  let env = opts.env || {};
  let settings;                 // from config + env: key, disableFree, inferenceUrl, baseURL, headers, warnings
  let generation = 0;           // bumped by reload(): the model list is recomputed
  let memo = null;
  let resting = null;           // {until, reason, type, window, freeOnly} while the account limit (freeOnly: the free models' limit) is used up
  let requestCount = 0;
  let current = null;           // {ai, inflight}
  const retired = new Set();

  const catalog = createCatalog({ env, dataDir, log });

  function readSettings() {
    const warnings = [];
    const k = readKey(config, env);
    warnings.push(...k.warnings);
    let inferenceUrl = String(env.OPENCODE_INFERENCE_URL || '').trim().replace(/\/+$/, '');
    if (inferenceUrl && !/^https?:\/\/[^/\s]+/i.test(inferenceUrl)) {
      warnings.push('OPENCODE_INFERENCE_URL isn\'t an http(s) address, so it is ignored.');
      inferenceUrl = '';
    }
    let baseURL = String(config.options && config.options.baseURL || '').trim().replace(/\/+$/, '');
    if (baseURL && !/^https?:\/\/[^/\s]+/i.test(baseURL)) {
      warnings.push('provider.' + id + '.options.baseURL isn\'t an http(s) address, so it is ignored.');
      baseURL = '';
    }
    return {
      key: k.key,
      disableFree: opts.shared && typeof opts.shared.isOn === 'function' ? opts.shared.isOn(env.OPENCODE_DISABLE_FREE_MODELS) : /^(1|true)$/i.test(String(env.OPENCODE_DISABLE_FREE_MODELS || '').trim()),
      inferenceUrl,
      baseURL,                  // a provider-wide address replaces every model's own (as in OpenCode)
      headers: config.options && config.options.headers || null,
      warnings
    };
  }

  function newAI() {
    current = { ai: createAI({ proxy: 'env', env }), inflight: 0 };
  }

  function retire(slot) {
    if (!slot) return;
    if (slot.inflight > 0) { retired.add(slot); return; }
    slot.ai.dispose().catch(() => {});
  }

  function name() {
    return config.name || 'OpenCode Zen';
  }

  // The catalog's models with the config applied → {visible (by id), offered (in order), warnings}
  function catalogModels() {
    const cat = catalog.current();
    if (memo && memo.version === cat.version && memo.generation === generation) return memo;
    const warnings = [];
    const overrides = config.models || {};
    // (the operator's own file, OPENCODE_MODELS_PATH, may send models anywhere; a fetched or cached catalog only to Zen)
    const normalized = cat.entry ? normalize(cat.entry, { inferenceUrl: settings.inferenceUrl, trusted: cat.source === 'file' }) : null;
    const all = normalized ? normalized.models : [];
    if (normalized && normalized.dropped.address.length) {
      const ids = normalized.dropped.address;
      warnings.push('The OpenCode Zen catalog gives ' + ids.length + ' model' + (ids.length === 1 ? '' : 's') + ' (' + ids.slice(0, 5).join(', ') + (ids.length > 5 ? ', …' : '') +
        ') an address outside https://opencode.ai/inference/, so ' + (ids.length === 1 ? 'it is' : 'they are') + ' left out.');
    }
    const known = new Set(all.map(m => m.id));
    for (const mid of Object.keys(overrides)) {
      if (!known.has(mid)) warnings.push('provider.' + id + '.models.' + mid + ' isn\'t in the OpenCode Zen catalog (or is retired); it is ignored.');
    }
    let visible = all.map(m => {
      const o = overrides[m.id];
      if (!o) return m;
      const out = Object.assign({}, m);
      if (o.name) out.name = o.name;
      if (typeof o.tool_call === 'boolean') out.toolCall = o.tool_call;
      if (typeof o.reasoning === 'boolean') out.reasoning = o.reasoning;
      if (typeof o.attachment === 'boolean') out.attachment = o.attachment;
      if (typeof o.temperature === 'boolean') out.temperature = o.temperature;
      if (o.limit && o.limit.context) out.contextWindow = o.limit.context;
      if (o.limit && o.limit.output) out.maxOutput = o.limit.output;
      if (o.status) out.status = o.status;
      return out;
    }).filter(m => m.status !== 'deprecated');
    if (config.whitelist) visible = visible.filter(m => config.whitelist.includes(m.id));
    if (config.blacklist) visible = visible.filter(m => !config.blacklist.includes(m.id));
    let offered = settings.key ? visible : visible.filter(m => m.free);
    if (settings.disableFree) offered = offered.filter(m => !m.free);
    offered = orderModels(offered);
    memo = {
      version: cat.version, generation, warnings,
      visible: new Map(visible.map(m => [m.id, m])),
      offered,
      byId: new Map(offered.map(m => [m.id, m]))
    };
    return memo;
  }

  function entryOf(m) {
    const e = {
      id: id + '/' + m.id, provider: id, providerName: name(), model: m.id, name: m.name,
      free: m.free, available: true,
      toolCall: m.toolCall, reasoning: m.reasoning, attachment: m.attachment, temperature: m.temperature,
      contextWindow: m.contextWindow, maxOutput: m.maxOutput,
      variants: m.variants.map(v => v.id), releaseDate: m.releaseDate, protocol: m.protocol
    };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return e;
  }

  function problem() {
    const cat = catalog.current();
    if (cat.problem) return cat.problem;
    if (!settings.key && settings.disableFree) return 'Add OPENCODE_API_KEY to use OpenCode Zen (free models are switched off by OPENCODE_DISABLE_FREE_MODELS).';
    if (!catalogModels().offered.length) return 'No OpenCode Zen model is left with the current settings (whitelist / blacklist in the service\'s config, OPENCODE_DISABLE_FREE_MODELS).';
    return null;
  }

  function restingNow() {
    if (resting && resting.until <= Date.now()) resting = null;
    return resting;
  }

  // What to check, per failure type (fromAIError appends it)
  function hints() {
    return {
      authentication_error: settings.key ? 'Check OPENCODE_API_KEY in the server\'s .env file.' : 'Free models need no key; if this keeps happening, add OPENCODE_API_KEY to the server\'s .env file.',
      quota_exceeded: settings.key ? 'Check the OpenCode Zen account\'s balance and limits at opencode.ai.' : 'Free models have a usage limit; with OPENCODE_API_KEY the paid models can be used.'
    };
  }

  // The failure while the provider (or, freeOnly, its free models) rests (no request is sent)
  function restingError(entry) {
    const left = Math.max(1, Math.ceil((resting.until - Date.now()) / 1000));
    const what = resting.reason === 'quota'
      ? name() + '\'s usage limit' + (settings.key && !resting.freeOnly ? '' : ' for free models') + ' is used up. It resets ' + describeWait(left) + '.'
      : name() + ' asked MetaCode to pause. It can be used again ' + describeWait(left) + '.';
    const h = resting.freeOnly ? 'Pick a paid model.' : hints()[resting.type];
    return new ServiceError(429, resting.type, what + (h ? ' ' + h : ''), {
      provider: id, model: entry && entry.id, scope: resting.freeOnly ? 'model' : 'provider', retryAfterSeconds: left, resetAt: new Date(resting.until).toISOString(), window: resting.window
    });
  }

  // Keys and the config's header values (a gateway may quote them back in an error) are never shown
  function secrets() {
    const headers = settings.headers ? Object.values(settings.headers).filter(v => typeof v === 'string' && v.length >= 8) : [];
    return (settings.key ? [settings.key] : []).concat(headers);
  }

  function fail(err, entry, signal) {
    // Zen's limit: a spend limit for this model only, or (with a key) the free models' limit, which the paid ones don't share
    const limit = zenLimitOf(err && err.reason && err.reason.body);
    const m = catalogModels().byId.get(entry.model);
    const freeOnly = limit === 'free' && !!settings.key && !!(m && m.free);
    const hint = Object.assign(hints(), limit === 'model' ? { quota_exceeded: MODEL_BUDGET_HINT } : freeOnly ? { quota_exceeded: FREE_LIMIT_HINT } : {});
    const e = fromAIError(err, { provider: id, providerName: name(), model: entry.id, secrets: secrets(), signal, hint });
    if (e.status === 429 && e.type === 'quota_exceeded' && freeOnly) e.scope = 'model';
    if (e.status === 429 && (e.scope === 'provider' || freeOnly)) {
      const seconds = Math.min(Math.max(1, e.retryAfterSeconds !== undefined ? e.retryAfterSeconds : DEFAULT_REST_SECONDS), MAX_REST_SECONDS);
      if (e.retryAfterSeconds === undefined) e.retryAfterSeconds = seconds;
      if (!e.resetAt) e.resetAt = new Date(Date.now() + seconds * 1000).toISOString();
      resting = { until: Date.now() + seconds * 1000, reason: e.type === 'quota_exceeded' ? 'quota' : 'paused', type: e.type, window: e.window, freeOnly };
      log.warn(name() + (freeOnly ? '\'s free models are' : ' is') + ' resting until ' + new Date(resting.until).toISOString() + ' (' + e.type + ').');
    }
    return e;
  }

  // Why a model of the catalog isn't offered (needs a key, free models off, retired), or null
  function unlisted(modelId) {
    const m = catalogModels().visible.get(modelId);
    const all = catalog.current().entry;
    if (m && m.free && settings.disableFree) {
      return new ServiceError(503, 'not_configured', 'The free model "' + id + '/' + modelId + '" is switched off (OPENCODE_DISABLE_FREE_MODELS). Pick another model.', { provider: id, model: id + '/' + modelId });
    }
    if (m && !m.free && !settings.key) {
      return new ServiceError(503, 'not_configured', 'The model "' + id + '/' + modelId + '" isn\'t free: it needs OPENCODE_API_KEY in the server\'s .env file. Pick a free model or add the key.', { provider: id, model: id + '/' + modelId });
    }
    if (!m && all && all.models && all.models[modelId]) {
      return new ServiceError(404, 'model_not_found', name() + ' doesn\'t offer the model "' + id + '/' + modelId + '" any more. Pick another model.', { provider: id, model: id + '/' + modelId });
    }
    return null;
  }

  settings = readSettings();
  catalog.load();
  catalog.start();
  newAI();

  return {
    id,
    get name() { return name(); },
    kind: 'zen',

    status() {
      const m = catalogModels();
      const p = problem();
      const rest = restingNow() && !resting.freeOnly ? resting : null;     // (the free models alone resting: Zen isn't)
      const left = rest ? Math.max(1, Math.ceil((rest.until - Date.now()) / 1000)) : 0;
      return {
        id, name: name(), kind: 'zen', ready: !p, problem: p,
        warnings: settings.warnings.concat(catalog.warnings, m.warnings),
        keyCount: settings.key ? 1 : 0,
        free: !settings.key && !settings.disableFree,
        note: !settings.key && !settings.disableFree ? 'Free models only — add OPENCODE_API_KEY for the others.'
          : settings.key && settings.disableFree ? 'Free models are switched off (OPENCODE_DISABLE_FREE_MODELS).' : null,
        models: { listed: m.offered.length, available: m.offered.length },
        catalog: catalog.status(),
        resting: rest ? { until: new Date(rest.until).toISOString(), reason: rest.reason, window: rest.window || null } : null,
        keys: settings.key ? [{ masked: masked(settings.key), status: rest ? 'cooling_down' : 'available', cooldownSecondsLeft: left, requestCount }] : []
      };
    },

    async models() {
      if (problem()) return [];
      return catalogModels().offered.map(entryOf);
    },

    unlisted,

    async *chat(body, entry, run) {
      const { signal, timeoutMs, stream, variant } = run || {};
      const m = catalogModels().byId.get(entry.model);
      if (!m) throw unlisted(entry.model) || new ServiceError(404, 'model_not_found', name() + ' doesn\'t offer the model "' + entry.id + '". Pick another model.', { provider: id, model: entry.id });
      if (restingNow() && (!resting.freeOnly || m.free)) throw restingError(entry);
      let chosen = null;
      if (variant && variant !== 'default') {
        chosen = m.variants.find(v => v.id === variant);
        if (!chosen) throw new ServiceError(400, 'invalid_request', 'The model "' + entry.id + '" has no variant "' + variant + '"' + (m.variants.length ? ' (it has ' + m.variants.map(v => v.id).join(', ') + ')' : '') + '.', { provider: id, model: entry.id });
      } else if (!variant && body.reasoning_effort) chosen = m.variants.find(v => v.id === body.reasoning_effort) || null;
      const variantSettings = chosen ? chosen.settings : undefined;

      const slot = current;
      slot.inflight++;
      try {
        let events;
        try {
          const mod = await protocolModule(m.protocol);
          const modelSettings = Object.assign({ apiKey: settings.key || PUBLIC_KEY, baseURL: settings.baseURL || m.baseURL },
            m.protocol === 'chat' ? { provider: id } : {}, settings.headers ? { headers: settings.headers } : {}, variantSettings);
          let model = mod.model(m.id, modelSettings);
          if (m.reasoningField) model = LanguageModel.update(model, { compatibility: Object.assign({}, model.compatibility, { reasoningField: m.reasoningField }) });
          const input = toLLMInput(body, { protocol: m.protocol, model: entry, settings: variantSettings });
          const http = Object.assign({}, input.http, {
            headers: Object.assign({}, input.http && input.http.headers, { 'x-opencode-session': sessionId(), 'x-opencode-client': 'metacode' })
          });
          if (Number.isFinite(timeoutMs)) {
            http.headerTimeout = timeoutMs;
            http.chunkTimeout = timeoutMs;
            if (!stream) http.timeout = timeoutMs;
          }
          requestCount++;
          events = slot.ai.llm.stream(Object.assign({ model }, input, { http }), { signal });
        } catch (err) {
          throw fail(err, entry, signal);
        }
        try {
          for await (const e of events) yield e;
        } catch (err) {
          throw fail(err, entry, signal);
        }
      } finally {
        slot.inflight--;
        if (retired.has(slot) && slot.inflight === 0) { retired.delete(slot); slot.ai.dispose().catch(() => {}); }
      }
    },

    async reload(nextEnv, nextConfig) {
      env = nextEnv || env;
      config = nextConfig || config;
      settings = readSettings();
      generation++;
      resting = null;
      requestCount = 0;
      catalog.reload(env);
      const old = current;
      newAI();
      retire(old);
    },

    async close() {
      catalog.stop();
      const slots = [current, ...retired];
      retired.clear();
      await Promise.all(slots.filter(Boolean).map(s => s.ai.dispose().catch(() => {})));
    }
  };
}
