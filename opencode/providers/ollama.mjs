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
//   - the default models to offer are downloaded when Ollama doesn't have them
//     yet (POST /api/pull), unless OLLAMA_AUTO_PULL=off; with AI_MODE=local or
//     local-only, only with OLLAMA_AUTO_PULL=on (the AI Model Store asks first).
//
// Settings (.env):
//   OLLAMA_BACKUP      auto (default) | on (always listed; its problem shown when Ollama isn't running) | off
//   OLLAMA_BASE_URL    Ollama's address (default http://127.0.0.1:11434/v1; /v1 is added when missing)
//   METACODE_OLLAMA_MODELS  the models to offer, best first, comma-separated; "all": every chat model Ollama
//                      has. Unset: DEFAULT_MODELS, then every other chat model Ollama has (those installed in
//                      the AI Model Store). (OLLAMA_MODELS is read too when it's a list: it used to be the name,
//                      but it's Ollama's own setting for its models folder.) Cloud models are never offered.
//   OLLAMA_AUTO_PULL   on (default) | off
// A provider.ollama of the operator's own in OPENCODE_CONFIG isn't this: it stays an ordinary OpenAI-compatible
// provider (config.mjs), and there's no local backup then.

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
  let baseURL = String(opts.baseURL || e.OLLAMA_BASE_URL || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  if (!/\/v1$/.test(baseURL)) baseURL += '/v1';        // (http://127.0.0.1:11434, as Ollama's docs write it, is accepted)
  // METACODE_OLLAMA_MODELS: the models to offer, best first. (OLLAMA_MODELS is Ollama's own setting for its models
  // folder; MetaCode still reads a list there, as it used to, but never a folder)
  const legacy = String(e.OLLAMA_MODELS || '').trim();
  const rawModels = String(e.METACODE_OLLAMA_MODELS || '').trim() || (/^[\\/~.]|^[A-Za-z]:[\\/]/.test(legacy) ? '' : legacy);
  const modelsVar = String(e.METACODE_OLLAMA_MODELS || '').trim() ? 'METACODE_OLLAMA_MODELS' : rawModels ? 'OLLAMA_MODELS' : 'METACODE_OLLAMA_MODELS';
  const all = /^all$/i.test(rawModels);
  const models = all ? null : (rawModels ? rawModels.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_MODELS.slice());
  // Unset: the defaults first, then every other chat model Ollama has (those installed from
  // MetaCode's AI Model Store); a list names exactly the models to offer
  const extra = !all && !rawModels;
  // AI_MODE=local / local-only (config.mjs): Ollama's models are first-class (they may be the default) instead of
  // the last-resort backup, and nothing is downloaded unless OLLAMA_AUTO_PULL=on: the Model Store asks first
  const aiMode = String(e.AI_MODE || '').trim().toLowerCase();
  const backup = !(aiMode === 'local' || aiMode === 'local-only');
  const autoPull = backup ? !isOffText(e.OLLAMA_AUTO_PULL) : isOnText(e.OLLAMA_AUTO_PULL);
  // OLLAMA_PULL_IDLE_SECONDS: a download that makes no progress for this long is stopped (and tried again later)
  const idle = Number(String(e.OLLAMA_PULL_IDLE_SECONDS || '').trim());
  const pullIdleMs = Number.isFinite(idle) && idle >= 1 && idle <= 3600 ? idle * 1000 : PULL_IDLE_MS;
  return { mode, baseURL, models, all, extra, autoPull, backup, modelsVar, pullIdleMs };
}

// "gemma3:270m" and "gemma3:270m" are one model; a name without a tag is ":latest"
// An Ollama cloud model (its entry names a remote host or model, or its tag says cloud), or an embedding model
const isCloud = m => !!(m.remote_host || m.remote_model) || /(^|[:-])cloud$/i.test(String(m.name || m.model || ''));
const isEmbedding = m => /^(bert|nomic-bert)$/i.test(String((m.details && m.details.family) || '')) || /embed/i.test(String(m.name || m.model || ''));
const tagged = name => (String(name).includes(':') ? String(name) : String(name) + ':latest');
// localhost, 127.x.x.x, [::1]: Ollama on this machine
const loopbackHost = host => { const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h); };
export const ollamaOnThisMachine = url => { try { return loopbackHost(new URL(url).hostname); } catch (e) { return false; } };
const sameModel = (a, b) => tagged(a).toLowerCase() === tagged(b).toLowerCase();

export function createProvider(opts) {
  const { id, log } = opts;
  let env = opts.env || {};
  let config = opts.config || {};
  let s = ollamaSettings(env, config);
  let closed = false;
  // what is known about Ollama: reachable (null = not checked yet), the models it has, downloads;
  // gen: the settings' generation (a look started under older settings doesn't count)
  const state = { reachable: null, checkedAt: 0, probing: null, have: [], problem: null, pulls: new Map(), gen: 0 };
  // (an Ollama on another machine, OLLAMA_BASE_URL, isn't "on this device": its models aren't local, and
  // AI_MODE=local-only switches it off in config.mjs)
  const here = () => ollamaOnThisMachine(s.baseURL);
  const hostName = () => { try { return new URL(s.baseURL).host; } catch (e) { return 'another machine'; } };
  const providerName = () => (typeof config.name === 'string' && config.name.trim() && (s.backup || config.name.trim() !== 'Local backup (Ollama)') ? config.name.trim() : null) ||
    (s.backup ? 'Local backup (Ollama)' : here() ? 'On this device (Ollama)' : 'Ollama at ' + hostName());
  const suffix = () => (s.backup ? ' (local backup)' : here() ? ' (on this device)' : ' (Ollama at ' + hostName() + ')');

  const nativeBase = () => s.baseURL.replace(/\/v1$/, '');
  // (messages from the OpenAI-compatible provider behind this one name the settings in .env, not the OpenCode config)
  const SETTING_NAMES = { base: 'OLLAMA_BASE_URL', key: 'OLLAMA_BASE_URL', proxy: 'HTTPS_PROXY', transport: 'OLLAMA_BASE_URL', where: 'in the server\'s .env file' };
  const baseConfig = () => Object.assign({}, config, {
    options: Object.assign({}, config.options, { baseURL: s.baseURL, apiKey: PLACEHOLDER_KEY, transport: 'node' })
  });
  // (Ollama on this machine is reached directly: a proxy set for the internet must not get its requests)
  const baseEnv = () => {
    if (!here()) return env;
    const out = Object.assign({}, env);
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) delete out[k];
    return out;
  };
  // The OpenAI-compatible provider that talks to Ollama — made once Ollama has answered, so a server
  // without Ollama makes no requests and logs nothing for it (that provider fetches its model list at once)
  let base = null;
  const baseOf = () => {
    if (!base && !closed) base = createOpenAICompatible(Object.assign({}, opts, { env: baseEnv(), config: baseConfig(), settingNames: SETTING_NAMES }));
    return base;
  };

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
    const gen = state.gen;
    const run = (async () => {
      let r = null, failure = null;
      try {
        r = await getJson('/api/tags');
        if (!r.ok || !r.json || !Array.isArray(r.json.models)) throw new Error('HTTP ' + r.status + (r.text && !r.json ? ' (not Ollama?)' : ''));
      } catch (e) { failure = e; }
      if (gen !== state.gen || closed) return;          // (the settings changed meanwhile: a new look decides)
      const was = state.reachable;
      state.checkedAt = Date.now();
      if (!failure) {
        const before = state.have.join('\n');
        state.reachable = true;
        state.problem = null;
        // (Ollama's cloud models run on Ollama's servers, so the prompts would leave this one: never offered)
        state.have = r.json.models.filter(m => m && !isCloud(m) && !isEmbedding(m)).map(m => m.name || m.model).filter(n => typeof n === 'string');
        if (was !== true) log.info('ollama.found', { url: nativeBase(), models: state.have.length });
        // (downloads that failed while Ollama was away most likely failed because it was away)
        if (was === false) for (const [m, p] of state.pulls) if (p.state === 'failed') state.pulls.delete(m);
        // (a model pulled or removed by hand: the list of models to offer is fetched again at once)
        else if (state.have.join('\n') !== before && base) base.models({ refresh: true }).catch(() => {});
        pullMissing();
      } else {
        state.reachable = false;
        state.problem = 'Ollama isn\'t answering at ' + nativeBase() + ' (' + (failure.name === 'TimeoutError' ? 'no answer within ' + (PROBE_TIMEOUT_MS / 1000) + ' s' : String((failure.cause && failure.cause.code) || failure.message || 'unreachable')) +
          '). Install and start Ollama on this server (ollama.com), or set OLLAMA_BASE_URL.';
        if (was === true) log.warn('ollama.lost', { url: nativeBase() });
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
          const error = String(e && e.name === 'AbortError' ? 'stopped' : e && e.name === 'TimeoutError' ? 'no progress for ' + Math.round(s.pullIdleMs / 1000) + ' s' : (e && e.message) || e).slice(0, 200);
          pulls.set(model, { state: 'failed', at: Date.now(), error });
          log.warn('ollama.pull', { model, state: 'failed', detail: error });
        }
      }
      await probe().catch(() => {});
      if (base) await base.models({ refresh: true }).catch(() => {});      // (the new models are offered at once)
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
    const quiet = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(Object.assign(new Error('idle'), { name: 'TimeoutError' })), s.pullIdleMs); };
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
      let buffer = '', last = null, biggest = 0, mark = null;
      const take = line => {
        if (!line.trim()) return;
        let j = null;
        try { j = JSON.parse(line); } catch (e) { return; }
        if (j && j.error) throw new Error(String(j.error));
        // (while stalled, Ollama keeps sending the same line: only progress counts as not idle)
        const now = j && (j.status + '|' + (j.digest || '') + '|' + (j.completed || 0));
        if (now !== mark) { mark = now; quiet(); }
        last = j;
        if (j && j.total > 0 && j.total >= biggest) { biggest = j.total; p.percent = Math.min(100, Math.floor(100 * (j.completed || 0) / j.total)); }
      };
      for await (const chunk of res.body) {
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

  // Ollama's models as this provider offers them: the models named (in that order), or all of them
  async function models(o) {
    probeIfDue();
    if (state.reachable === null) await probe();
    if (s.mode === 'off' || state.reachable !== true) {
      if (s.mode === 'on') throw new ServiceError(503, 'not_configured', state.problem || 'Ollama isn\'t running.', { provider: id });
      return [];
    }
    const b = baseOf();
    if (!b) return [];
    // (only models Ollama has here: its /v1/models also lists its cloud models, which run on Ollama's servers,
    // and its embedding models; neither is ever offered)
    const list = (await b.models(o)).filter(e => !NOT_A_CHAT_MODEL.test(e.model) && state.have.some(h => sameModel(h, e.model)));
    const listed = s.all ? list : wanted().map(w => list.find(e => sameModel(e.model, w))).filter(Boolean);
    const chosen = s.extra ? listed.concat(list.filter(e => !listed.includes(e))) : listed;
    return chosen.map(e => Object.assign({}, e, {
      name: e.model + suffix(), free: false, local: here(), backup: s.backup,
      reasoning: false, toolCall: false
    }));
  }

  async function status() {
    // (the first look for Ollama is waited for — instant when nothing listens — so the first status is right)
    if (state.reachable === null && s.mode !== 'off') await probe();
    else probeIfDue();
    // (the OpenAI-compatible provider's own state only while Ollama answers: asked otherwise, it would try
    // to fetch its model list from an Ollama that isn't there)
    const b = state.reachable === true && baseOf() ? baseOf().status() : { warnings: [], transport: 'Node.js' };
    // (the backup stays out of sight while Ollama isn't there; with AI_MODE=local / local-only it is the AI, so
    // its problem shows: "Ollama isn't answering … Install and start Ollama")
    const hidden = s.mode === 'off' || (s.mode === 'auto' && s.backup && state.reachable !== true);
    const downloading = [...state.pulls.entries()].filter(([, p]) => p.state === 'downloading').map(([m, p]) => m + (p.percent ? ' (' + p.percent + '%)' : ''));
    const failed = [...state.pulls.entries()].filter(([, p]) => p.state === 'failed').map(([m, p]) => m + ' (' + p.error + ')');
    const chat = state.have.filter(m => !NOT_A_CHAT_MODEL.test(m));
    const named = s.all ? chat : wanted().filter(m => state.have.some(h => sameModel(h, m)));
    const offered = s.extra ? named.concat(chat.filter(h => !named.some(m => sameModel(h, m)))) : named;
    let problem = null;
    if (state.reachable === false) problem = state.problem;
    else if (state.reachable === true && !offered.length) {
      problem = downloading.length ? 'Downloading ' + downloading.join(', ') + ' — ' + (s.backup ? 'the local backup' : 'it') + ' is ready when that\'s done.'
        : s.extra && !s.autoPull ? 'Ollama has no chat model yet. Install one in the AI Model Store (sidebar → AI Model Store), or run "ollama pull ' + DEFAULT_MODELS[0] + '" on the server.'
        : 'Ollama has none of the models in ' + s.modelsVar + ' (' + wanted().join(', ') + ')' + (failed.length ? ': downloading failed — ' + failed.join('; ') : '') +
          '. Run "ollama pull ' + (wanted()[0] || DEFAULT_MODELS[0]) + '" on the server' + (s.autoPull ? '' : ' (OLLAMA_AUTO_PULL is off)') + ', or install a model in the AI Model Store.';
    }
    const notes = [s.backup ? 'Last-resort backup: answers only when no other provider\'s model can, one request at a time.'
      : here() ? 'Models on this device: prompts stay here. One request at a time.'
      : 'Models on the Ollama at ' + hostName() + ': prompts go to that machine.'];
    if (offered.length) notes.push('Models: ' + offered.join(', ') + (downloading.length ? '; downloading ' + downloading.join(', ') : '') + '.');
    return Object.assign({}, b, {
      id, name: providerName(), kind: 'ollama', ready: !problem && state.reachable === true, problem,
      hidden, backup: s.backup, local: here(), keyCount: 0, keys: [], resting: null, free: null,
      models: { listed: offered.length, available: state.reachable === true ? offered.length : null, source: 'live' },
      note: notes.join(' '), baseHost: (() => { try { return new URL(s.baseURL).host; } catch (e) { return null; } })(),
      warnings: (b.warnings || []).concat(failed.length && offered.length ? ['Couldn\'t download ' + failed.join('; ') + '.'] : [])
    });
  }

  function unlisted(model) {
    if (!s.all && !s.extra && state.have.some(h => sameModel(h, model)) && !wanted().some(w => sameModel(w, model))) {
      return new ServiceError(404, 'model_not_found', 'The local model "' + id + '/' + model + '" isn\'t one of the local models MetaCode offers (' + s.modelsVar + '). Add it there, or pick another model.', { provider: id, model: id + '/' + model });
    }
    return null;
  }

  // Reload .env: Ollama is looked at again; when its settings changed, what was known about it is
  // forgotten and a download under the old settings stops (the new ones decide what to download)
  async function reload(newEnv, newConfig) {
    if (newEnv) env = newEnv;
    if (newConfig) config = newConfig;
    const before = JSON.stringify(s);
    s = ollamaSettings(env, config);
    if (JSON.stringify(s) !== before) {
      state.gen++;
      state.reachable = null;
      state.checkedAt = 0;
      state.probing = null;
      state.have = [];
      state.pulls = new Map();
      if (pullAbort) pullAbort.abort();
    } else {
      // (Reload .env tries failed downloads again)
      for (const [m, p] of state.pulls) if (p.state === 'failed') state.pulls.delete(m);
    }
    if (base) await base.reload(baseEnv(), baseConfig());
    if (s.mode !== 'off') await probe();
  }

  // MetaCode's Model Store installed or deleted a model: look at Ollama now instead of within 30 s
  async function refresh() {
    if (s.mode === 'off' || closed) return;
    state.checkedAt = 0;
    await probe();
    // (and the list offered: probe() only starts that refresh, and the next /v1/models must have the new model)
    if (base && state.reachable === true) await base.models({ refresh: true }).catch(() => {});
  }

  async function close() {
    closed = true;
    if (pullAbort) pullAbort.abort();
    if (base) await base.close();
  }

  if (s.mode !== 'off') probe();

  return {
    id,
    get name() { return providerName(); },
    kind: 'ollama',
    status,
    models,
    chat(body, entry, run) {
      const b = baseOf();
      if (!b) throw new ServiceError(503, 'not_configured', providerName() + ' is shutting down.', { provider: id, model: entry && entry.id });
      return b.chat(body, entry, run);
    },
    unlisted,
    reload,
    refresh,
    // (server.mjs: the last-resort backup, or first-class with AI_MODE=local / local-only)
    isBackup: () => s.backup,
    close
  };
}
