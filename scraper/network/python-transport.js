// ── Server-side HTTPS through Python ──────────────────────────────────────────
// The "Python" server engine: one long-running worker (python/reddit_fetch.py,
// standard library only) performs the HTTPS requests of server-side jobs.
// Everything that decides *whether* a request may be made stays in Node —
// destination checks, robots.txt, the shared rate limiter, retries — and the
// worker enforces the network rules again on its own side (allow-listed host
// names and ports, no private addresses, certificate verification, no
// redirects). Same interface as EpoxyWispTransport:
//   request({ url, method, headers, body, timeoutMs, signal })
//     → { status, statusText, headers, body, url }
//
// AutoTransport uses Python when a working Python 3.8+ is found and falls back
// to epoxy-tls over Wisp otherwise (SCRAPER_SERVER_TRANSPORT picks one).

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { ScraperError } = require('../errors');

const WORKER = path.join(__dirname, '..', '..', 'python', 'reddit_fetch.py');
const START_TIMEOUT_MS = 15000;

function pythonCandidates(env) {
  const configured = String((env || process.env).SCRAPER_PYTHON || '').trim();
  if (configured) return [{ cmd: configured, args: [] }];
  const list = [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  if (process.platform === 'win32') list.push({ cmd: 'py', args: ['-3'] });
  return list;
}

function toError(kind, message) {
  const detail = String(message || '').slice(0, 200);
  switch (kind) {
    case 'tls':
      return new ScraperError('tls', 'Couldn\'t verify the server\'s TLS certificate (' + detail + '). A firewall, antivirus or proxy that ' +
        'inspects HTTPS traffic may be intercepting the connection. On macOS with Python from python.org, run "Install Certificates.command" ' +
        'or "pip install certifi".', { status: 502, detail });
    case 'dns':
      return new ScraperError('network', 'Couldn\'t look up the server\'s address. Check this computer\'s internet connection.', { status: 502, retryable: true, detail });
    case 'timeout':
      return new ScraperError('timeout', 'Reddit didn\'t answer in time.', { status: 504, retryable: true, detail });
    case 'blocked':
      return new ScraperError('proxy_blocked', 'The Python engine refused the connection: ' + detail + '.', { status: 502, detail });
    case 'too_large':
      return new ScraperError('too_large', 'The response was larger than SCRAPER_MAX_RESPONSE_BYTES.', { status: 502, detail });
    case 'invalid':
      return new ScraperError('invalid_url', 'The Python engine refused the request: ' + detail + '.', { status: 400, detail });
    default:
      return new ScraperError('network', 'The connection to Reddit failed. Check the internet connection and try again.', { status: 502, retryable: true, detail });
  }
}

class PythonTransport {
  // config: the scraper config (wispHostPatterns, wispPorts, allowPrivateNetwork,
  // userAgent, maxResponseBytes); env: for SCRAPER_PYTHON.
  constructor(opts) {
    this.config = opts.config;
    this.env = opts.env || process.env;
    this.kind = 'python';
    this.child = null;
    this.starting = null;
    this.info = null;          // { python, ssl, command }
    this.lastError = null;
    this.seq = 0;
    this.pending = new Map();  // id → { resolve, reject }
    this.closed = false;
  }

  workerConfig() {
    const c = this.config;
    return JSON.stringify({
      hostPatterns: c.wispHostPatterns.map(re => [re.source, re.flags]),
      ports: c.wispPorts,
      allowPrivate: !!c.allowPrivateNetwork,
      userAgent: c.userAgent,
      maxBytes: c.maxResponseBytes
    });
  }

  // Starts the worker (once); resolves with its info or rejects with a ScraperError.
  start() {
    if (this.child && this.info) return Promise.resolve(this.info);
    if (this.starting) return this.starting;
    this.starting = this.tryCandidates(pythonCandidates(this.env)).then(info => {
      this.starting = null;
      return info;
    }, err => {
      this.starting = null;
      this.lastError = err;
      throw err;
    });
    return this.starting;
  }

  async tryCandidates(candidates) {
    let last = null;
    for (const c of candidates) {
      try { return await this.spawnWorker(c); } catch (err) { last = err; }
    }
    throw new ScraperError('not_available', 'Python 3.8+ wasn\'t found for the Python scraper engine (tried ' +
      candidates.map(c => [c.cmd].concat(c.args).join(' ')).join(', ') + '). Install Python 3 and make sure it is on PATH, or set SCRAPER_PYTHON.',
    { status: 503, detail: last && last.message });
  }

  spawnWorker(candidate) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(candidate.cmd, candidate.args.concat(['-u', WORKER, this.workerConfig()]), {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // No secrets: the worker needs PATH/SYSTEMROOT-style basics only.
          env: Object.assign({ PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
            pick(process.env, ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LANG']))
        });
      } catch (err) {
        return reject(err);
      }
      let ready = false;
      let stderr = '';
      const timer = setTimeout(() => {
        if (!ready) { child.kill(); reject(new Error('the Python worker didn\'t start in time')); }
      }, START_TIMEOUT_MS);
      child.on('error', err => { if (!ready) { clearTimeout(timer); reject(err); } });
      child.stderr.on('data', d => { if (stderr.length < 2000) stderr += d.toString(); });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (!ready) {
          clearTimeout(timer);
          if (!msg.ready) { child.kill(); return reject(new Error(msg.error || 'the Python worker failed to start')); }
          ready = true;
          this.child = child;
          this.info = { python: msg.python, ssl: msg.ssl, command: [candidate.cmd].concat(candidate.args).join(' ') };
          this.lastError = null;
          return resolve(this.info);
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(toError(msg.error.kind, msg.error.message));
        else p.resolve({ status: msg.status, statusText: msg.statusText || '', headers: msg.headers || {}, body: msg.body || '', url: msg.url });
      });
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        if (!ready) return reject(new Error('exit ' + code + (stderr ? ': ' + stderr.trim().split('\n').pop() : '')));
        if (this.child === child) { this.child = null; this.info = null; }
        const err = new ScraperError('network', 'The Python engine stopped unexpectedly; the request will be retried.', {
          status: 502, retryable: true, detail: 'exit ' + code + (sig ? ' ' + sig : '') + (stderr ? ': ' + stderr.slice(-300) : '') });
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      });
    });
  }

  async request(req) {
    const signal = req.signal || null;
    if (signal && signal.aborted) throw signal.reason || new ScraperError('cancelled', 'Cancelled.');
    if (this.closed) throw new ScraperError('not_available', 'The scraper is shutting down.', { status: 503 });
    await this.start();
    const timeoutMs = req.timeoutMs || 20000;
    const id = ++this.seq;
    let timer = null;
    let onAbort = null;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        // The worker has its own socket timeout; this is the backstop.
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new ScraperError('timeout', 'Reddit didn\'t answer within ' + Math.round(timeoutMs / 1000) + ' seconds.', { status: 504, retryable: true }));
        }, timeoutMs + 2000);
        if (signal) {
          onAbort = () => { this.pending.delete(id); reject(signal.reason || new ScraperError('cancelled', 'Cancelled.')); };
          signal.addEventListener('abort', onAbort, { once: true });
        }
        const line = JSON.stringify({ id, method: req.method || 'GET', url: req.url, headers: req.headers || {},
          body: req.body === undefined || req.body === null ? null : String(req.body), timeoutMs }) + '\n';
        this.child.stdin.write(line, err => {
          if (err && this.pending.has(id)) {
            this.pending.delete(id);
            reject(new ScraperError('network', 'Couldn\'t hand the request to the Python engine.', { status: 502, retryable: true, detail: err.message }));
          }
        });
      });
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  close() {
    this.closed = true;
    if (this.child) { try { this.child.stdin.end(); this.child.kill(); } catch (e) { /* gone */ } }
    this.child = null;
  }
}

function pick(obj, keys) {
  const out = {};
  keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

// "auto": Python when it starts, otherwise epoxy-tls (decided on first use,
// then fixed for the process lifetime). "python" / "epoxy": that one only.
class AutoTransport {
  constructor(opts) {
    this.mode = opts.mode || 'auto';
    this.python = opts.python;
    this.epoxy = opts.epoxy;
    this.chosen = this.mode === 'epoxy' ? this.epoxy : null;
    this.choosing = null;
    this.onChoose = opts.onChoose || (() => {});
  }

  get kind() { return this.chosen ? this.chosen.kind : (this.mode === 'epoxy' ? 'epoxy' : 'pending'); }
  get info() { return this.epoxy.info; }

  choose() {
    if (this.chosen) return Promise.resolve(this.chosen);
    if (!this.choosing) {
      this.choosing = this.python.start().then(() => {
        this.chosen = this.python;
        this.onChoose(this.python, null);
        return this.python;
      }, err => {
        this.choosing = null;
        if (this.mode === 'python') throw err;
        this.chosen = this.epoxy;
        this.onChoose(this.epoxy, err);
        return this.epoxy;
      });
    }
    return this.choosing;
  }

  async request(req) {
    const t = await this.choose();
    return t.request(req);
  }

  status() {
    const py = this.python;
    return {
      setting: this.mode,
      engine: this.chosen ? this.chosen.kind : null,
      python: py.info ? { version: py.info.python, ssl: py.info.ssl, command: py.info.command } : null,
      pythonError: py.lastError ? py.lastError.message : null
    };
  }

  close() {
    this.python.close();
    if (typeof this.epoxy.close === 'function') this.epoxy.close();
  }
}

module.exports = { PythonTransport, AutoTransport, pythonCandidates };
