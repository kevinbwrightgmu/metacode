// Ollama's native API on this machine (the AI service talks to its OpenAI-compatible /v1 for chats; the
// Model Store needs the rest): version, installed and running models, details, downloads (streamed /api/pull),
// deleting, loading and unloading. Checked against a real Ollama 0.40:
// - /api/pull streams NDJSON lines: {"status":"pulling <digest>","digest","total","completed"} per layer, then
//   "verifying sha256 digest", "writing manifest", {"status":"success"}. A missing model is HTTP 200 with an
//   {"error":…} line in the stream. After "verifying sha256 digest" Ollama hashes every layer it downloaded and
//   sends nothing until that's done.
// - HEAD /api/blobs/<digest>: 200 when a layer is complete on disk, 404 when it isn't (a part-downloaded one
//   isn't).
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
  // Whether Ollama has a layer complete on disk. Anything but a clear yes counts as no, so the disk check
  // before a download stays on the safe side.
  async function hasBlob(digest) {
    if (!/^sha256:[0-9a-f]{64}$/i.test(String(digest || ''))) return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const res = await fetchImpl(base() + '/api/blobs/' + digest, { method: 'HEAD', signal: ac.signal });
      return res.status === 200;
    } catch (e) { return false; } finally { clearTimeout(timer); }
  }

  // A download: onLine(line) for every progress line; → resolves on {"status":"success"}, throws otherwise.
  // Aborting `signal` stops it; Ollama keeps what was downloaded, and pulling again continues.
  async function pull(model, onLine, signal, idleMs) {
    const ac = new AbortController();
    const quiet = idleMs || 120000;       // (how long Ollama may send nothing new)
    let idle = null, limit = quiet, verifying = false;
    const arm = ms => { clearTimeout(idle); limit = ms || quiet; idle = setTimeout(() => ac.abort(new Error('stalled')), limit); };
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
      const layers = new Map();             // digest → size
      const handle = line => {
        if (!line.trim()) return;
        let j;
        try { j = JSON.parse(line); } catch (e) { return; }
        if (j.error) throw new OllamaError(String(j.error), 502, /file does not exist|not found/i.test(j.error) ? 'not_in_library' : 'pull_failed');
        if (j.digest && j.total > 0) layers.set(j.digest, j.total);
        // (a stalled download keeps sending the same line: only progress counts as not idle. After "verifying
        // sha256 digest" Ollama hashes what arrived and sends nothing until that's done: it gets time for that
        // too, at about 20 MB a second)
        const now = j.status + '|' + (j.digest || '') + '|' + (j.completed || 0);
        if (now !== mark) {
          mark = now;
          verifying = /verifying/i.test(String(j.status || ''));
          let bytes = 0;
          if (verifying) layers.forEach(n => { bytes += n; });
          arm(Math.max(quiet, Math.ceil(bytes / 20e6) * 1000));
        }
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
        const secs = Math.round(limit / 1000);
        throw new OllamaError(!stalled ? 'The download was interrupted (' + (e && e.message || 'connection lost') + ').'
          : verifying ? 'Ollama\'s check of the download (sha256) took longer than ' + secs + ' s.' : 'The download stalled (nothing arrived for ' + secs + ' s).', 502, 'interrupted');
      }
      if (!ok) throw new OllamaError('The download ended before Ollama said it was complete.', 502, 'interrupted');
    } finally {
      clearTimeout(idle);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  return { base, version, tags, ps, show, remove, load, unload, hasBlob, pull };
}

module.exports = { createOllama, nativeUrl, OllamaError, DEFAULT_URL };
