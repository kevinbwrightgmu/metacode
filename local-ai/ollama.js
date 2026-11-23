// Ollama's native API on this machine (the AI service talks to its OpenAI-compatible /v1 for chats; the
// Model Store needs the rest): version, installed and running models, details, downloads (streamed /api/pull),
// deleting, loading and unloading. Checked against a real Ollama 0.40:
// - /api/pull streams NDJSON lines: {"status":"pulling <digest>","digest","total","completed"} per layer, then
//   "verifying sha256 digest", "writing manifest", {"status":"success"}. A missing model is HTTP 200 with an
//   {"error":…} line in the stream.
// - A download stopped half-way leaves its parts on disk: pulling again continues where it stopped.
// - /api/generate with keep_alive loads a model ("done_reason":"load"); keep_alive 0 unloads it ("unload").
// - DELETE /api/delete: 200 empty, then 404 {"error":"model '…' not found"}.
'use strict';

const DEFAULT_URL = 'http://127.0.0.1:11434';

// OLLAMA_BASE_URL is the OpenAI-compatible address (…/v1), as the AI service's provider uses it
function nativeUrl(env) {
  const raw = String((env || process.env).OLLAMA_BASE_URL || '').trim() || DEFAULT_URL;
  try {
    const u = new URL(raw);
    u.pathname = u.pathname.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    return u.toString().replace(/\/+$/, '');
  } catch (e) { return DEFAULT_URL; }
}

class OllamaError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code || 'ollama_error'; }
}

function createOllama(opts) {
  const fetchImpl = (opts && opts.fetch) || globalThis.fetch;
  const env = (opts && opts.env) || process.env;
  const base = () => nativeUrl(env);

  async function call(method, p, body, ms, signal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), ms || 10000);
    const onAbort = () => ac.abort(signal.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetchImpl(base() + p, { method, signal: ac.signal, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (signal && signal.aborted) throw new OllamaError('Cancelled.', 499, 'aborted');
      throw new OllamaError('Ollama isn\'t answering at ' + base() + '. Is it installed and running?', 503, 'unreachable');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
    if (!res.ok) throw new OllamaError((json && json.error) || ('Ollama answered HTTP ' + res.status + '.'), res.status, res.status === 404 ? 'not_found' : 'ollama_error');
    return json;
  }

  const version = () => call('GET', '/api/version', null, 2500).then(j => (j && j.version) || null);
  const tags = () => call('GET', '/api/tags', null, 8000).then(j => (j && Array.isArray(j.models) ? j.models : []));
  const ps = () => call('GET', '/api/ps', null, 8000).then(j => (j && Array.isArray(j.models) ? j.models : []));
  const show = model => call('POST', '/api/show', { model }, 10000);
  const remove = model => call('DELETE', '/api/delete', { model }, 30000);
  // (loading a big model from a slow disk takes a while)
  const load = (model, keepAlive) => call('POST', '/api/generate', { model, keep_alive: keepAlive === undefined ? '10m' : keepAlive }, 5 * 60 * 1000);
  const unload = model => call('POST', '/api/generate', { model, keep_alive: 0 }, 60000);

  // A download: onLine(line) for every progress line; → resolves on {"status":"success"}, throws otherwise.
  // Aborting `signal` stops it; Ollama keeps what was downloaded, and pulling again continues.
  async function pull(model, onLine, signal, idleMs) {
    const ac = new AbortController();
    let idle = null;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('stalled')), idleMs || 120000); };
    const onAbort = () => ac.abort(signal.reason);
    if (signal) { if (signal.aborted) throw new OllamaError('Cancelled.', 499, 'aborted'); signal.addEventListener('abort', onAbort, { once: true }); }
    let ok = false;
    try {
      arm();
      let res;
      try {
        res = await fetchImpl(base() + '/api/pull', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
      } catch (e) {
        if (signal && signal.aborted) throw new OllamaError('Cancelled.', 499, 'aborted');
        throw new OllamaError('Ollama isn\'t answering at ' + base() + '. Is it installed and running?', 503, 'unreachable');
      }
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        let msg = null;
        try { msg = JSON.parse(raw).error; } catch (e) { /* not JSON */ }
        throw new OllamaError(msg || 'Ollama answered HTTP ' + res.status + '.', res.status);
      }
      const decoder = new TextDecoder();
      let buf = '', mark = null;
      const handle = line => {
        if (!line.trim()) return;
        let j;
        try { j = JSON.parse(line); } catch (e) { return; }
        if (j.error) throw new OllamaError(String(j.error), 502, /file does not exist|not found/i.test(j.error) ? 'not_in_library' : 'pull_failed');
        // (a stalled download keeps sending the same line: only progress counts as not idle)
        const now = j.status + '|' + (j.digest || '') + '|' + (j.completed || 0);
        if (now !== mark) { mark = now; arm(); }
        if (j.status === 'success') ok = true;
        onLine(j);
      };
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); handle(line); }
        }
        handle(buf + decoder.decode());
      } catch (e) {
        if (e instanceof OllamaError) throw e;
        if (signal && signal.aborted) throw new OllamaError('Cancelled.', 499, 'aborted');
        const stalled = ac.signal.aborted && ac.signal.reason && ac.signal.reason.message === 'stalled';
        throw new OllamaError(stalled ? 'The download stalled (nothing arrived for ' + Math.round((idleMs || 120000) / 1000) + ' s).' : 'The download was interrupted (' + (e && e.message || 'connection lost') + ').', 502, 'interrupted');
      }
      if (!ok) throw new OllamaError('The download ended before Ollama said it was complete.', 502, 'interrupted');
    } finally {
      clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  return { base, version, tags, ps, show, remove, load, unload, pull };
}

module.exports = { createOllama, nativeUrl, OllamaError, DEFAULT_URL };
