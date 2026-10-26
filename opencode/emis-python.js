// ── EMIS requests through Python ──────────────────────────────────────────────
// Starts python/emis_fetch.py once and sends it EMIS requests (see that file).
// Used by the OpenCode service's EMIS provider (providers/openai-compatible.mjs).
// Python is tried as EMIS_PYTHON, SCRAPER_PYTHON, then python3 / python / py -3.
// request({method, url, key, body, headers, timeoutMs, signal, proxy}) (headers: the provider's
// own extra headers, from its config) resolves to the same shape a plain fetch gives that provider:
//   { status, ok, headers (Headers), text } or { failed: 'network'|'timeout', code }.
// createEmisPython({ env }): env is where EMIS_PYTHON / SCRAPER_PYTHON and the
// worker's environment come from (default process.env).

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const WORKER = path.join(__dirname, '..', 'python', 'emis_fetch.py');

function candidates(env) {
  const out = [];
  const configured = String(env.EMIS_PYTHON || env.SCRAPER_PYTHON || '').trim();
  if (configured) { const parts = configured.split(/\s+/); out.push({ cmd: parts[0], args: parts.slice(1) }); }
  out.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
  if (process.platform === 'win32') out.push({ cmd: 'py', args: ['-3'] });
  return out;
}

// The worker's environment, without the OPENAI_* settings meant for other programs: the openai
// package would send OPENAI_ORG_ID / OPENAI_PROJECT_ID to the gateway as headers (its key and
// address always come with the request)
function workerEnv(env) {
  const out = Object.assign({}, process.env, env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
  for (const k of Object.keys(out)) if (/^OPENAI_/i.test(k)) delete out[k];
  return out;
}

// JSON with every non-ASCII character escaped, so the bytes are the same in any encoding
const asciiJson = v => JSON.stringify(v).replace(/[\u007f-\uffff]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

function createEmisPython(opts) {
  const env = (opts && opts.env) || process.env;
  // worker: { proc, pending: Map(id → { resolve, timer }) } — each worker answers only its own requests
  let worker = null, ready = null, info = null, nextId = 1, failedAt = 0, failure = null, generation = 0;

  function start() {
    if (ready) return ready;
    const gen = generation;
    const attempt = (async () => {
      let last = null;
      for (const c of candidates(env)) {
        if (gen !== generation) throw new Error('stopped');
        try { return await spawnOne(c, gen); } catch (e) { last = e; }
      }
      throw last || new Error('Python wasn\'t found');
    })();
    ready = attempt;
    attempt.catch(e => { if (gen !== generation) return; failure = e.message; failedAt = Date.now(); ready = null; });
    return attempt;
  }

  function spawnOne(c, gen) {
    return new Promise((resolve, reject) => {
      let p;
      try {
        p = spawn(c.cmd, c.args.concat(['-u', WORKER]), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: workerEnv(env) });
      } catch (e) { reject(e); return; }
      const w = { proc: p, pending: new Map() };
      let started = false, stderr = '';
      const timer = setTimeout(() => { if (!started) { try { p.kill(); } catch (e) { /* gone */ } reject(new Error(c.cmd + ' didn\'t start')); } }, 15000);
      p.on('error', e => { clearTimeout(timer); if (!started) reject(e); });
      p.stdin.on('error', () => {});             // (a worker that's gone: its requests fail on exit)
      p.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
      p.on('exit', code => {
        clearTimeout(timer);
        if (!started) { reject(new Error(c.cmd + ' exited (' + code + '): ' + stderr.trim().slice(-300))); return; }
        if (worker === w) { worker = null; ready = null; }
        w.pending.forEach(entry => { clearTimeout(entry.timer); entry.resolve({ failed: 'network', code: 'ECONNRESET', message: 'The Python worker stopped.' }); });
        w.pending.clear();
      });
      const rl = readline.createInterface({ input: p.stdout });
      rl.on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (msg.ready) {
          started = true; clearTimeout(timer);
          // stop() was called while it started (Reload .env): it was started with the old environment
          if (gen !== generation) { try { p.kill(); } catch (e) { /* gone */ } reject(new Error('stopped')); return; }
          worker = w; info = { python: msg.python, client: msg.client, cmd: c.cmd }; resolve(info); return;
        }
        const entry = w.pending.get(msg.id);
        if (!entry) return;
        w.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.resolve({ failed: msg.error.kind === 'timeout' ? 'timeout' : msg.error.kind === 'client' ? 'client' : 'network', code: msg.error.code, message: msg.error.message });
          return;
        }
        entry.resolve({ status: msg.status, ok: msg.status >= 200 && msg.status < 300, headers: new Headers(Object.entries(msg.headers || {}).filter(([k]) => !/^(content-encoding|transfer-encoding|content-length)$/i.test(k))), text: msg.body || '' });
      });
    });
  }

  // → response shape, or null when Python can't be used (caller falls back to Node).
  async function request(opts) {
    if (!worker && failure && Date.now() - failedAt < 60000) return null;   // don't retry a missing Python on every call
    try { await start(); } catch (e) {
      if (e.message !== 'stopped') return null;
      try { await start(); } catch (e2) { return null; }     // (Reload .env while it was starting: the new one)
    }
    const w = worker;
    if (!w) return null;
    const id = nextId++;
    return new Promise(done => {
      const signal = opts.signal;
      const onAbort = () => { if (w.pending.delete(id)) { clearTimeout(timer); resolve({ failed: 'aborted' }); } };
      // (the abort listener goes with the answer, whichever comes first)
      const resolve = value => { if (signal) signal.removeEventListener('abort', onAbort); done(value); };
      const timer = setTimeout(() => { w.pending.delete(id); resolve({ failed: 'timeout', code: 'ETIMEDOUT' }); }, (opts.timeoutMs || 120000) + 5000);
      w.pending.set(id, { resolve, timer });
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      w.proc.stdin.write(asciiJson({ id, method: opts.method, url: opts.url, key: opts.key, body: opts.body === undefined ? null : opts.body, headers: opts.headers || {}, timeoutMs: opts.timeoutMs, proxy: opts.proxy || '' }) + '\n');
    });
  }

  // The next request starts a new worker (with the environment as it is then). opts.finishRequests: the
  // old worker answers what it was already sent before it exits (Reload .env: those requests have
  // reached the AI service, and sending them again would spend the key's budget twice).
  function stop(opts) {
    generation++;
    ready = null; info = null; failure = null; failedAt = 0;
    const w = worker;
    worker = null;
    if (!w) return;
    if (opts && opts.finishRequests && w.pending.size) {
      const kill = setTimeout(() => { try { w.proc.kill(); } catch (e) { /* gone */ } }, 130000);
      kill.unref();
      w.proc.once('exit', () => clearTimeout(kill));
      try { w.proc.stdin.end(); } catch (e) { /* gone */ }       // its read loop ends; Python exits once they're answered
      return;
    }
    try { w.proc.kill(); } catch (e) { /* gone */ }
  }

  return {
    request,
    status: () => (info ? Object.assign({ ok: true }, info) : { ok: false, problem: failure }),
    warm: () => start().catch(() => null),
    stop
  };
}

module.exports = { createEmisPython };
