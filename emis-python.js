// ── EMIS requests through Python ──────────────────────────────────────────────
// Starts python/emis_fetch.py once and sends it EMIS requests (see that file).
// Python is tried as EMIS_PYTHON, SCRAPER_PYTHON, then python3 / python / py -3.
// request() resolves to the same shape server.js's own fetch path returns:
//   { status, ok, headers (Headers), text } or { failed: 'network'|'timeout', code }.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const WORKER = path.join(__dirname, 'python', 'emis_fetch.py');

function candidates() {
  const out = [];
  const configured = String(process.env.EMIS_PYTHON || process.env.SCRAPER_PYTHON || '').trim();
  if (configured) { const parts = configured.split(/\s+/); out.push({ cmd: parts[0], args: parts.slice(1) }); }
  out.push({ cmd: 'python3', args: [] }, { cmd: 'python', args: [] });
  if (process.platform === 'win32') out.push({ cmd: 'py', args: ['-3'] });
  return out;
}

function createEmisPython() {
  let child = null, ready = null, info = null, nextId = 1, failedAt = 0, failure = null;
  const pending = new Map();

  function start() {
    if (ready) return ready;
    ready = (async () => {
      let last = null;
      for (const c of candidates()) {
        try { return await spawnOne(c); } catch (e) { last = e; }
      }
      throw last || new Error('Python wasn\'t found');
    })();
    ready.catch(e => { failure = e.message; failedAt = Date.now(); ready = null; });
    return ready;
  }

  function spawnOne(c) {
    return new Promise((resolve, reject) => {
      let p;
      try {
        p = spawn(c.cmd, c.args.concat(['-u', WORKER]), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
      } catch (e) { reject(e); return; }
      let started = false, stderr = '';
      const timer = setTimeout(() => { if (!started) { try { p.kill(); } catch (e) { /* gone */ } reject(new Error(c.cmd + ' didn\'t start')); } }, 15000);
      p.on('error', e => { clearTimeout(timer); if (!started) reject(e); });
      p.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
      p.on('exit', code => {
        clearTimeout(timer);
        if (!started) { reject(new Error(c.cmd + ' exited (' + code + '): ' + stderr.trim().slice(-300))); return; }
        if (child === p) { child = null; ready = null; }
        pending.forEach(entry => entry.resolve({ failed: 'network', code: 'ECONNRESET', message: 'The Python worker stopped.' }));
        pending.clear();
      });
      const rl = readline.createInterface({ input: p.stdout });
      rl.on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (msg.ready) { started = true; clearTimeout(timer); child = p; info = { python: msg.python, client: msg.client, cmd: c.cmd }; resolve(info); return; }
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.resolve({ failed: msg.error.kind === 'timeout' ? 'timeout' : 'network', code: msg.error.code, message: msg.error.message });
          return;
        }
        entry.resolve({ status: msg.status, ok: msg.status >= 200 && msg.status < 300, headers: new Headers(Object.entries(msg.headers || {}).filter(([k]) => !/^(content-encoding|transfer-encoding|content-length)$/i.test(k))), text: msg.body || '' });
      });
    });
  }

  // → response shape, or null when Python can't be used (caller falls back to Node).
  async function request(opts) {
    if (!child && failure && Date.now() - failedAt < 60000) return null;   // don't retry a missing Python on every call
    try { await start(); } catch (e) { return null; }
    if (!child) return null;
    const id = nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ failed: 'timeout', code: 'ETIMEDOUT' }); }, (opts.timeoutMs || 120000) + 5000);
      pending.set(id, { resolve, timer });
      if (opts.signal) opts.signal.addEventListener('abort', () => { if (pending.delete(id)) { clearTimeout(timer); resolve({ failed: 'aborted' }); } }, { once: true });
      child.stdin.write(JSON.stringify({ id, method: opts.method, url: opts.url, key: opts.key, body: opts.body === undefined ? null : opts.body, timeoutMs: opts.timeoutMs, proxy: opts.proxy || '' }) + '\n');
    });
  }

  return {
    request,
    status: () => (info ? Object.assign({ ok: true }, info) : { ok: false, problem: failure }),
    warm: () => start().catch(() => null),
    stop() { if (child) { try { child.kill(); } catch (e) { /* gone */ } child = null; ready = null; } }
  };
}

module.exports = { createEmisPython };
