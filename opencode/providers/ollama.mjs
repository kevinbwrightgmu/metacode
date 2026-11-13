// ── Local models through Ollama: MetaCode's last-resort backup ────────────────
// Ollama (ollama.com) runs small open models on this server and speaks the
// OpenAI chat format at http://127.0.0.1:11434/v1, so this provider is the
// OpenAI-compatible provider (openai-compatible.mjs) with Ollama's defaults and
// three additions:
//
//   - its models are marked backup (and local): MetaCode answers with them only
//     when no other provider's model can answer — never as the default, never
//     as the "closest model" while another provider's model is free
//     (server.js), and one request at a time with a longer time limit, since
//     they run on this machine's CPU;
//   - auto-detection: with OLLAMA_BACKUP=auto (the default) it is offered when
//     Ollama answers, and stays out of every list while it doesn't, so a server
//     without Ollama shows nothing about it;
//   - the models to offer (OLLAMA_MODELS) are downloaded when Ollama doesn't
//     have them yet (POST /api/pull), unless OLLAMA_AUTO_PULL=off.
//
// Settings (.env):
//   OLLAMA_BACKUP      auto (default) | on (always listed; its problem shown when Ollama isn't running) | off
//   OLLAMA_BASE_URL    Ollama's OpenAI-compatible address (default http://127.0.0.1:11434/v1)
//   OLLAMA_MODELS      the models to offer, comma-separated (default DEFAULT_MODELS); "all": every chat
//                      model Ollama has
//   OLLAMA_AUTO_PULL   on (default) | off
// The config file's provider.ollama entry (options.baseURL, models, whitelist…) works as for any provider.

import { ServiceError } from '../errors.mjs';
import { createProvider as createOpenAICompatible } from './openai-compatible.mjs';

// Small enough for a CPU-only VPS, and neither "thinks" before answering (a waste of a slow CPU's time):
//   gemma3:1b    815 MB download — the best at following a prompt under a gigabyte (tried first)
//   gemma3:270m  292 MB download — the smallest that still follows a prompt; for when the other fails
export const DEFAULT_MODELS = ['gemma3:1b', 'gemma3:270m'];
export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const PROBE_TIMEOUT_MS = 2500;
const PROBE_EVERY_MS = 30 * 1000;            // how often Ollama is looked at again (is it there, which models it has)
const PULL_RETRY_MS = 10 * 60 * 1000;        // a failed download is tried again after this
const PULL_IDLE_MS = 2 * 60 * 1000;          // a download that sends no progress for this long is given up (and tried again later)
const NOT_A_CHAT_MODEL = /(embed|rerank|whisper|tts|vision-only|guard)/i;
const PLACEHOLDER_KEY = 'ollama';             // Ollama takes no key; the OpenAI-compatible provider needs one

const isOffText = v => /^(off|false|no|0|disabled|none)$/i.test(String(v || '').trim());
const isOnText = v => /^(on|true|yes|1|enabled)$/i.test(String(v || '').trim());

// The settings this provider reads (also used by config.mjs to leave it out with OLLAMA_BACKUP=off)
export function ollamaSettings(env, config) {
  const e = env || {};
  const opts = (config && config.options) || {};
  const rawMode = String(e.OLLAMA_BACKUP || '').trim().toLowerCase();
  const mode = isOffText(rawMode) ? 'off' : isOnText(rawMode) ? 'on' : 'auto';
  const baseURL = String(opts.baseURL || e.OLLAMA_BASE_URL || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  const rawModels = String(e.OLLAMA_MODELS || '').trim();
  const all = /^all$/i.test(rawModels);
  const models = all ? null : (rawModels ? rawModels.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODELS.slice());
  const autoPull = !isOffText(e.OLLAMA_AUTO_PULL);
  return { mode, baseURL, models, all, autoPull };
}

// "gemma3:270m" and "gemma3:270m" are one model; a name without a tag is ":latest"
const tagged = name => (String(name).includes(':') ? String(name) : String(name) + ':latest');
const sameModel = (a, b) => tagged(a).toLowerCase() === tagged(b).toLowerCase();

export function createProvider(opts) {
  const { id, log } = opts;
  let env = opts.env || {};
  let config = opts.config || {};
  let s = ollamaSettings(env, config);
  let closed = false;
  // what is known about Ollama: reachable (null = not checked yet), the models it has, downloads
  const state = { reachable: null, checkedAt: 0, probing: null, have: [], problem: null, pulls: new Map() };

  const nativeBase = () => s.baseURL.replace(/\/v1$/, '');
  const baseConfig = () => Object.assign({}, config, {
    options: Object.assign({}, config.options, { baseURL: s.baseURL, apiKey: PLACEHOLDER_KEY, transport: 'node' })
  });
  // (Ollama on this machine is reached directly: a proxy set for the internet must not get its requests)
  const baseEnv = () => {
    let host = '';
    try { host = new URL(s.baseURL).hostname; } catch (e) { host = ''; }
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return env;
    const out = Object.assign({}, env);
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) delete out[k];
    return out;
  };
  let base = createOpenAICompatible(Object.assign({}, opts, { env: baseEnv(), config: baseConfig() }));

  async function getJson(pathname, init, timeoutMs) {
    const res = await fetch(nativeBase() + pathname, Object.assign({ signal: AbortSignal.timeout(timeoutMs || PROBE_TIMEOUT_MS) }, init));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: res.status, ok: res.ok, json, text };
  }

  // Is Ollama there, and which models does it have? (GET /api/tags; never throws)
  function probe() {
    if (state.probing) return state.probing;
    const run = (async () => {
      try {
        const r = await getJson('/api/tags');
        if (!r.ok || !r.json || !Array.isArray(r.json.models)) throw new Error('HTTP ' + r.status + (r.text && !r.json ? ' (not Ollama?)' : ''));
        const was = state.reachable;
        const before = state.have.join('\n');
        state.reachable = true;
        state.problem = null;
        state.have = r.json.models.map(m => m && (m.name || m.model)).filter(n => typeof n === 'string');
        if (was !== true) log.info('ollama.found', { url: nativeBase(), models: state.have.length });
        // (a model pulled or removed by hand: the list of models to offer is fetched again at once)
        else if (state.have.join('\n') !== before) base.models({ refresh: true }).catch(() => {});
        pullMissing();
      } catch (e) {
        const was = state.reachable;
        state.reachable = false;
        state.problem = 'Ollama isn\'t answering at ' + nativeBase() + ' (' + (e && e.name === 'TimeoutError' ? 'no answer within ' + (PROBE_TIMEOUT_MS / 1000) + ' s' : String(e && (e.cause && e.cause.code || e.message) || 'unreachable')) +
          '). Install and start Ollama on this server (ollama.com), or set OLLAMA_BASE_URL.';
        if (was === true) log.warn('ollama.lost', { url: nativeBase() });
      } finally {
        state.checkedAt = Date.now();
      }
    })();
    state.probing = run;
    run.finally(() => { if (state.probing === run) state.probing = null; });
    return run;
  }
  const probeIfDue = () => { if (!closed && !state.probing && Date.now() - state.checkedAt > PROBE_EVERY_MS) probe(); };

  // The models to offer that Ollama doesn't have yet are downloaded one after the other
  function wanted() { return s.all ? [] : s.models; }
  function missing() { return wanted().filter(m => !state.have.some(h => sameModel(h, m))); }
  let pulling = null, pullAbort = null;
  function pullMissing() {
    if (closed || !s.autoPull || pulling || state.reachable !== true) return;
    const todo = missing().filter(m => {
      const p = state.pulls.get(m);
      return !p || (p.state === 'failed' && Date.now() - p.at > PULL_RETRY_MS);
    });
    if (!todo.length) return;
    const pulls = state.pulls;          // (a reload starts a new map: this run's results don't go into it)
    pulling = (async () => {
      for (const model of todo) {
        if (closed || pulls !== state.pulls) break;
        const p = { state: 'downloading', at: Date.now(), percent: null };
        pulls.set(model, p);
        log.info('ollama.pull', { model, state: 'started' });
        try {
          await pullModel(model, p);
          pulls.set(model, { state: 'done', at: Date.now() });
          log.info('ollama.pull', { model, state: 'done' });
        } catch (e) {
          const error = String(e && e.name === 'AbortError' ? 'stopped' : e && e.name === 'TimeoutError' ? 'no progress for ' + (PULL_IDLE_MS / 60000) + ' minutes' : (e && e.message) || e).slice(0, 200);
          pulls.set(model, { state: 'failed', at: Date.now(), error });
          log.warn('ollama.pull', { model, state: 'failed', detail: error });
        }
      }
      await probe().catch(() => {});
      await base.models({ refresh: true }).catch(() => {});      // (the new models are offered at once)
    })();
    // (models a reload asked for meanwhile are downloaded next)
    pulling.finally(() => { pulling = null; pullMissing(); });
  }
  // POST /api/pull, streamed: Ollama sends a line of progress every so often until {"status":"success"}
  // (asked for one answer instead, it sends nothing until the download is done — and a client gives up
  // waiting for the first byte after 5 minutes). p.percent: how far the biggest part (the weights) is.
  async function pullModel(model, p) {
    const controller = new AbortController();
    pullAbort = controller;
    let idle = null;
    const quiet = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(Object.assign(new Error('idle'), { name: 'TimeoutError' })), PULL_IDLE_MS); };
    quiet();
    try {
      const res = await fetch(nativeBase() + '/api/pull', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        throw new Error((json && json.error) || 'HTTP ' + res.status);
      }
      const decoder = new TextDecoder();
      let buffer = '', last = null, biggest = 0;
      const take = line => {
        if (!line.trim()) return;
        let j = null;
        try { j = JSON.parse(line); } catch (e) { return; }
        if (j && j.error) throw new Error(String(j.error));
        last = j;
        if (j && j.total > 0 && j.total >= biggest) { biggest = j.total; p.percent = Math.min(100, Math.floor(100 * (j.completed || 0) / j.total)); }
      };
      for await (const chunk of res.body) {
        quiet();
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) { take(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
      }
      take(buffer + decoder.decode());
      if (!last || last.status !== 'success') throw new Error('the download ended before it was complete');
    } catch (e) {
      throw controller.signal.aborted && controller.signal.reason ? controller.signal.reason : e;
    } finally {
      clearTimeout(idle);
      if (pullAbort === controller) pullAbort = null;
    }
  }

  // Ollama's models as this provider offers them: the OLLAMA_MODELS it has (in that order), or all of them
  async function models(o) {
    probeIfDue();
    if (state.reachable === null) await probe();
    if (s.mode === 'off' || state.reachable !== true) {
      if (s.mode === 'on') throw new ServiceError(503, 'not_configured', state.problem || 'Ollama isn\'t running.', { provider: id });
      return [];
    }
    const list = (await base.models(o)).filter(e => !NOT_A_CHAT_MODEL.test(e.model));
    const chosen = s.all ? list : wanted().map(w => list.find(e => sameModel(e.model, w))).filter(Boolean);
    return chosen.map(e => Object.assign({}, e, {
      name: e.model + ' (local backup)', free: false, local: true, backup: true,
      reasoning: false, toolCall: false
    }));
  }

  async function status() {
    // (the first look for Ollama is waited for — instant when nothing listens — so the first status is right)
    if (state.reachable === null && s.mode !== 'off') await probe();
    else probeIfDue();
    const b = base.status();
    const hidden = s.mode === 'off' || (s.mode === 'auto' && state.reachable !== true);
    const downloading = [...state.pulls.entries()].filter(([, p]) => p.state === 'downloading').map(([m, p]) => m + (p.percent ? ' (' + p.percent + '%)' : ''));
    const failed = [...state.pulls.entries()].filter(([, p]) => p.state === 'failed').map(([m, p]) => m + ' (' + p.error + ')');
    const offered = s.all ? state.have.filter(m => !NOT_A_CHAT_MODEL.test(m)) : wanted().filter(m => state.have.some(h => sameModel(h, m)));
    let problem = null;
    if (state.reachable === false) problem = state.problem;
    else if (state.reachable === true && !offered.length) {
      problem = downloading.length ? 'Downloading ' + downloading.join(', ') + ' — the local backup is ready when that\'s done.'
        : 'Ollama has none of the models in OLLAMA_MODELS (' + wanted().join(', ') + ')' + (failed.length ? ': downloading failed — ' + failed.join('; ') : '') +
          '. Run "ollama pull ' + (wanted()[0] || DEFAULT_MODELS[0]) + '" on the server' + (s.autoPull ? '' : ' (OLLAMA_AUTO_PULL is off)') + '.';
    }
    const notes = ['Last-resort backup: answers only when no other provider\'s model can, one request at a time.'];
    if (offered.length) notes.push('Models: ' + offered.join(', ') + (downloading.length ? '; downloading ' + downloading.join(', ') : '') + '.');
    return Object.assign({}, b, {
      id, name: base.name, kind: 'ollama', ready: !problem && state.reachable === true, problem,
      hidden, backup: true, local: true, keyCount: 0, keys: [], resting: null, free: null,
      note: notes.join(' '), baseHost: (() => { try { return new URL(s.baseURL).host; } catch (e) { return null; } })(),
      warnings: (b.warnings || []).concat(failed.length && offered.length ? ['Couldn\'t download ' + failed.join('; ') + '.'] : [])
    });
  }

  function unlisted(model) {
    if (!s.all && state.have.some(h => sameModel(h, model)) && !wanted().some(w => sameModel(w, model))) {
      return new ServiceError(404, 'model_not_found', 'The local model "' + id + '/' + model + '" isn\'t one of MetaCode\'s local backup models (OLLAMA_MODELS). Add it there, or pick another model.', { provider: id, model: id + '/' + model });
    }
    return null;
  }

  async function reload(newEnv, newConfig) {
    if (newEnv) env = newEnv;
    if (newConfig) config = newConfig;
    s = ollamaSettings(env, config);
    state.reachable = null;
    state.checkedAt = 0;
    state.pulls = new Map();
    if (pullAbort) pullAbort.abort();            // (a download under the old settings stops; the new ones decide)
    await base.reload(baseEnv(), baseConfig());
    probe();
  }

  async function close() {
    closed = true;
    if (pullAbort) pullAbort.abort();
    await base.close();
  }

  if (s.mode !== 'off') probe();

  return {
    id,
    get name() { return base.name; },
    kind: 'ollama',
    status,
    models,
    chat: (body, entry, run) => base.chat(body, entry, run),
    unlisted,
    reload,
    close
  };
}
