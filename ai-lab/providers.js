// @ts-check
// ── Model providers ───────────────────────────────────────────────────────────
// One interface over the AI services the Lab can use. What each can do is
// reported from the actual integration, never assumed:
//
//   metacode  MetaCode's own AI service (EMIS, server.js → labAi): chat and
//             streaming; tool calling per model (emis-models.json); no
//             embeddings, no fine-tuning. Token usage is taken from its answer
//             when it reports it, otherwise estimated (and labelled so).
//   openai    An OpenAI-compatible API the operator configured
//             (AI_LAB_OPENAI_API_KEY): chat and streaming; fine-tuning only
//             when AI_LAB_FINE_TUNING=on (it's paid — see finetune.js).
//
// Requests are never retried after part of an answer has been streamed; a
// non-streamed request is retried at most twice, only on 429 / 5xx /
// connection failures, honouring Retry-After.

const undici = require('undici');
const { LabError } = require('./errors');
const { dispatcherFor } = require('../accounts/http');
const { redact } = require('../lib/log');

/** @typedef {import('../types/ai-lab').MessageUsage} MessageUsage */

/**
 * @typedef {object} ModelInfo
 * @property {string} provider
 * @property {string} id
 * @property {string} name
 * @property {{ chat: boolean, streaming: boolean, toolCalling: boolean | null, structuredOutput: boolean | null, embeddings: boolean, fineTuning: boolean }} capabilities
 * @property {number | null} contextWindow   null: unknown (a conservative default budget is used)
 * @property {number | null} maxOutput
 * @property {boolean} isDefault
 * @property {boolean | null} available   true: the provider lists it now; false: it doesn't; null: not known
 */

/**
 * @typedef {object} ChatRequest
 * @property {string} model
 * @property {{ role: 'system' | 'user' | 'assistant', content: string }[]} messages
 * @property {number | null} [temperature]
 * @property {number} maxTokens
 * @property {AbortSignal} [signal]
 * @property {boolean} [json]   ask for a JSON object (when supported)
 */

/**
 * @typedef {object} ChatResult
 * @property {string} text
 * @property {string} model
 * @property {string | null} finishReason
 * @property {MessageUsage} usage
 * @property {number} latencyMs
 */

const estimateTokens = /** @param {string} text */ text => Math.ceil(String(text || '').length / 4);

/**
 * @param {ChatRequest} req
 * @param {string} text
 * @param {any} usage   the provider's usage object, if any
 * @returns {MessageUsage}
 */
function usageOf(req, text, usage) {
  const p = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const c = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
  if (p !== null && c !== null) return { promptTokens: p, completionTokens: c, measured: true };
  return { promptTokens: estimateTokens(req.messages.map(m => m.content).join('\n')) + 4 * req.messages.length, completionTokens: estimateTokens(text), measured: false };
}

/** @param {any} f  a failure from server.js's AI service */
function failureToError(f) {
  const status = f.status === 429 ? 429 : f.status >= 500 ? 502 : f.status === 400 ? 400 : 502;
  return new LabError(f.type || 'provider_error', 'MetaCode\'s AI service: ' + (f.message || 'the request failed.'), { status, retryAfterSeconds: f.retryAfterSeconds || null });
}

/** MetaCode's own AI service (EMIS), through server.js's labAi interface. */
class MetaCodeProvider {
  /** @param {any} ai */
  constructor(ai) {
    this.id = 'metacode';
    this.label = 'MetaCode AI service';
    this.ai = ai;
    this.capabilities = { chat: true, streaming: true, embeddings: false, fineTuning: false, usageReporting: 'when the service reports it' };
  }

  problem() { return this.ai ? this.ai.problem() : 'MetaCode\'s AI service isn\'t available.'; }

  /** @returns {Promise<{ models: ModelInfo[], problem: string | null }>} */
  async models() {
    if (!this.ai) return { models: [], problem: this.problem() };
    const r = await this.ai.models();
    if (!r.ok) return { models: [], problem: r.message };
    return {
      problem: null,
      models: r.models.map(/** @param {any} m */ m => ({
        provider: this.id, id: m.id, name: m.name, isDefault: m.id === r.default,
        capabilities: { chat: true, streaming: true, toolCalling: m.toolCall, structuredOutput: null, embeddings: false, fineTuning: false },
        contextWindow: m.contextWindow, maxOutput: m.maxOutput, available: m.available === undefined ? null : m.available
      }))
    };
  }

  /** @param {ChatRequest} req */
  body(req) {
    /** @type {Record<string, unknown>} */
    const b = { model: req.model, messages: req.messages, max_tokens: req.maxTokens };
    if (req.temperature !== null && req.temperature !== undefined) b.temperature = req.temperature;
    return b;
  }

  /** @param {ChatRequest} req @returns {Promise<ChatResult>} */
  async chat(req) {
    const started = Date.now();
    const r = await this.ai.chat(this.body(req), { signal: req.signal });
    if (r.aborted) throw new LabError('cancelled', 'Stopped.', { status: 499 });
    if (r.failure) throw failureToError(r.failure);
    const c = r.completion && r.completion.choices && r.completion.choices[0];
    const text = String((c && c.message && c.message.content) || '');
    return { text, model: r.model, finishReason: c ? c.finish_reason || null : null, usage: usageOf(req, text, r.completion.usage), latencyMs: Date.now() - started };
  }

  /** @param {ChatRequest} req @param {(text: string) => void} onDelta @returns {Promise<ChatResult>} */
  async stream(req, onDelta) {
    const started = Date.now();
    let text = '', usage = null, finish = null;
    const r = await this.ai.stream(Object.assign(this.body(req), { stream_options: { include_usage: true } }), {
      signal: req.signal,
      onChunk: /** @param {any} chunk */ chunk => {
        const ch = chunk.choices && chunk.choices[0];
        const delta = ch && ch.delta && typeof ch.delta.content === 'string' ? ch.delta.content : '';
        if (delta) { text += delta; onDelta(delta); }
        if (ch && ch.finish_reason) finish = ch.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
    });
    if (r.aborted) { const e = new LabError('cancelled', 'Stopped.', { status: 499 }); /** @type {any} */ (e).partial = text; throw e; }
    if (r.failure) { const e = failureToError(r.failure); /** @type {any} */ (e).partial = text; throw e; }
    return { text, model: r.model || req.model, finishReason: finish, usage: usageOf(req, text, usage), latencyMs: Date.now() - started };
  }
}

/** An OpenAI-compatible API the operator configured. */
class OpenAICompatibleProvider {
  /** @param {ReturnType<typeof import('./config').labConfig>['openai']} cfg */
  constructor(cfg) {
    this.id = 'openai';
    this.cfg = cfg;
    this.label = cfg.isOfficial ? 'OpenAI' : 'OpenAI-compatible API';
    this.capabilities = { chat: true, streaming: true, embeddings: false, fineTuning: !!cfg.fineTuning, usageReporting: 'yes (usage field)' };
    /** @type {{ at: number, list: string[] } | null} */
    this.modelCache = null;
  }

  problem() { return this.cfg.configured ? null : 'Not configured (AI_LAB_OPENAI_API_KEY).'; }

  /**
   * @param {string} path
   * @param {{ method?: string, json?: unknown, body?: any, headers?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number }} [opts]
   */
  async call(path, opts) {
    const o = opts || {};
    const url = this.cfg.baseUrl + path;
    const timeout = AbortSignal.timeout(o.timeoutMs || 120000);
    /** @type {Record<string, string>} */
    const headers = Object.assign({ authorization: 'Bearer ' + this.cfg.key }, o.headers || {});
    let body = o.body;
    if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
    try {
      return await undici.fetch(url, { method: o.method || 'GET', headers, body, dispatcher: dispatcherFor(url), signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout, redirect: 'manual' });
    } catch (err) {
      if (o.signal && o.signal.aborted) throw new LabError('cancelled', 'Stopped.', { status: 499 });
      throw new LabError(timeout.aborted ? 'timeout' : 'provider_unreachable', this.label + (timeout.aborted ? ' didn\'t answer in time.' : ' couldn\'t be reached.'), { status: 502 });
    }
  }

  /** @param {any} res @param {string} what */
  async fail(res, what) {
    let msg = '';
    try { const j = await res.json(); msg = j && j.error && j.error.message ? String(j.error.message) : ''; } catch (e) { msg = ''; }
    const retryAfter = Number(res.headers.get('retry-after')) || null;
    const type = res.status === 401 ? 'provider_auth' : res.status === 429 ? 'provider_rate_limited' : res.status >= 500 ? 'provider_error' : 'provider_rejected';
    return new LabError(type, this.label + ' ' + what + ' failed (HTTP ' + res.status + ')' + (msg ? ': ' + redact(msg, 300) : '.'), { status: res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status === 401 ? 502 : 400, retryAfterSeconds: retryAfter });
  }

  /** @returns {Promise<{ models: ModelInfo[], problem: string | null }>} */
  async models() {
    if (!this.cfg.configured) return { models: [], problem: this.problem() };
    let ids = this.cfg.models;
    if (!ids.length) {
      if (this.modelCache && Date.now() - this.modelCache.at < 5 * 60000) ids = this.modelCache.list;
      else {
        try {
          const res = await this.call('/models', { timeoutMs: 15000 });
          if (!res.ok) return { models: [], problem: (await this.fail(res, 'model list')).message };
          const j = /** @type {any} */ (await res.json());
          ids = (Array.isArray(j && j.data) ? j.data : []).map(/** @param {any} m */ m => String(m && m.id || '')).filter(/** @param {string} id */ id => id && !/(embed|tts|whisper|dall-e|image|audio|moderation|realtime|transcri|search)/i.test(id)).sort();
          this.modelCache = { at: Date.now(), list: ids };
        } catch (e) { return { models: [], problem: /** @type {Error} */ (e).message }; }
      }
    }
    return {
      problem: null,
      models: ids.map(id => ({
        provider: this.id, id, name: id, isDefault: false,
        capabilities: { chat: true, streaming: true, toolCalling: null, structuredOutput: null, embeddings: false, fineTuning: this.capabilities.fineTuning && this.cfg.fineTuneModels.includes(id) },
        // listed by the provider's /models, or named by AI_LAB_OPENAI_MODELS (then not checked)
        contextWindow: null, maxOutput: null, available: this.cfg.models.length ? null : true
      }))
    };
  }

  /** @param {ChatRequest} req @param {boolean} stream */
  body(req, stream) {
    /** @type {Record<string, unknown>} */
    const b = { model: req.model, messages: req.messages, max_tokens: req.maxTokens, stream };
    if (req.temperature !== null && req.temperature !== undefined) b.temperature = req.temperature;
    if (stream) b.stream_options = { include_usage: true };
    if (req.json) b.response_format = { type: 'json_object' };
    return b;
  }

  /** @param {ChatRequest} req @returns {Promise<ChatResult>} */
  async chat(req) {
    if (!this.cfg.configured) throw new LabError('provider_unavailable', this.label + ' isn\'t configured on this server.', { status: 503 });
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const res = await this.call('/chat/completions', { method: 'POST', json: this.body(req, false), signal: req.signal });
      if (res.ok) {
        const j = /** @type {any} */ (await res.json());
        const c = j && j.choices && j.choices[0];
        const text = String((c && c.message && c.message.content) || '');
        return { text, model: String(j.model || req.model), finishReason: c ? c.finish_reason || null : null, usage: usageOf(req, text, j.usage), latencyMs: Date.now() - started };
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const wait = Math.min(30, Number(res.headers.get('retry-after')) || 2 * Math.pow(2, attempt)) * 1000 * (0.8 + Math.random() * 0.4);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw await this.fail(res, 'chat request');
    }
  }

  /** @param {ChatRequest} req @param {(text: string) => void} onDelta @returns {Promise<ChatResult>} */
  async stream(req, onDelta) {
    if (!this.cfg.configured) throw new LabError('provider_unavailable', this.label + ' isn\'t configured on this server.', { status: 503 });
    const started = Date.now();
    const res = await this.call('/chat/completions', { method: 'POST', json: this.body(req, true), signal: req.signal, headers: { accept: 'text/event-stream' } });
    if (!res.ok) throw await this.fail(res, 'chat request');
    let text = '', usage = null, finish = null, buf = '', model = req.model;
    const decoder = new TextDecoder();
    try {
      for await (const part of /** @type {any} */ (res.body)) {
        buf += decoder.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          let chunk = null;
          try { chunk = JSON.parse(data); } catch (e) { chunk = null; }
          if (!chunk) continue;
          if (chunk.error) throw new LabError('provider_error', this.label + ': ' + redact(chunk.error.message || 'the stream failed', 300), { status: 502 });
          if (chunk.model) model = chunk.model;
          const ch = chunk.choices && chunk.choices[0];
          const delta = ch && ch.delta && typeof ch.delta.content === 'string' ? ch.delta.content : '';
          if (delta) { text += delta; onDelta(delta); }
          if (ch && ch.finish_reason) finish = ch.finish_reason;
          if (chunk.usage) usage = chunk.usage;
        }
      }
    } catch (err) {
      const e = err instanceof LabError ? err : new LabError(req.signal && req.signal.aborted ? 'cancelled' : 'stream_interrupted', req.signal && req.signal.aborted ? 'Stopped.' : 'The stream from ' + this.label + ' broke off.', { status: req.signal && req.signal.aborted ? 499 : 502 });
      /** @type {any} */ (e).partial = text;
      throw e;
    }
    return { text, model, finishReason: finish, usage: usageOf(req, text, usage), latencyMs: Date.now() - started };
  }
}

/**
 * The providers available on this server.
 * @param {{ ai: any, config: ReturnType<typeof import('./config').labConfig> }} deps
 */
function createRegistry(deps) {
  const metacode = new MetaCodeProvider(deps.ai);
  /** @type {OpenAICompatibleProvider | null} */
  let openai = null, openaiKey = '';
  function providers() {
    const cfg = deps.config.openai;
    const key = [cfg.key, cfg.baseUrl, cfg.models.join(','), cfg.fineTuning, cfg.fineTuneModels.join(',')].join('|');
    if (!cfg.configured) openai = null;
    else if (!openai || openaiKey !== key) { openai = new OpenAICompatibleProvider(cfg); openaiKey = key; }
    /** @type {(MetaCodeProvider | OpenAICompatibleProvider)[]} */
    const list = [metacode];
    if (openai) list.push(openai);
    return list;
  }
  /** @param {string} id */
  function get(id) {
    const p = providers().find(x => x.id === id);
    if (!p) throw new LabError('provider_unavailable', 'The model provider "' + String(id).slice(0, 40) + '" isn\'t available on this server.', { status: 400 });
    return p;
  }
  /** Every model of every provider (problems listed per provider). */
  async function catalog() {
    const out = [];
    for (const p of providers()) {
      const r = await p.models().catch(e => ({ models: [], problem: /** @type {Error} */ (e).message }));
      out.push({ provider: p.id, label: p.label, capabilities: p.capabilities, problem: r.problem, models: r.models });
    }
    return out;
  }
  /**
   * The model's metadata, checked against the provider's list (unknown models are refused).
   * @param {string} providerId
   * @param {string} modelId
   * @returns {Promise<ModelInfo>}
   */
  async function resolve(providerId, modelId) {
    const p = get(providerId);
    const r = await p.models();
    if (!r.models.length) throw new LabError('provider_unavailable', p.label + ': ' + (r.problem || 'no models are available.'), { status: 503 });
    const m = modelId ? r.models.find(x => x.id === modelId) : (r.models.find(x => x.isDefault) || r.models[0]);
    if (!m) throw new LabError('model_unavailable', 'The model "' + String(modelId).slice(0, 80) + '" isn\'t offered by ' + p.label + ' right now. Pick another under Models.', { status: 400 });
    return m;
  }
  return { providers, get, catalog, resolve, metacode };
}

module.exports = { createRegistry, MetaCodeProvider, OpenAICompatibleProvider, estimateTokens, usageOf };
