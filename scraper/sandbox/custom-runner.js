// ── Custom-code runner (parent side) ──────────────────────────────────────────
// Each custom scraper job gets a fresh sandbox process (sandbox-child.js);
// see that file for what the process can and can't do. This side:
//   • starts it with the permission model, an empty environment, a V8 heap
//     cap and a QuickJS memory cap;
//   • answers its host calls — every network request goes through the same
//     RedditHttpClient (destination checks, robots.txt, rate limiter,
//     retries) as the standard scraper, with the job's options;
//   • kills it (SIGKILL) on timeout, cancellation or misbehaviour.

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ScraperError, isScraperError, cancelledError, sanitize, httpError } = require('../errors');
const { sleep } = require('../network/rate-limiter');

const CHILD = path.join(__dirname, 'sandbox-child.js');
const PRELUDE_SOURCE = fs.readFileSync(path.join(__dirname, 'guest-prelude.js'), 'utf8');
const FORMAT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'reddit', 'format.js'), 'utf8');
const MAX_CODE_BYTES = 200 * 1024;
const MAX_SLEEP_MS = 60000;
const PASS_HEADERS = ['content-type', 'content-length', 'etag', 'last-modified', 'retry-after', 'location',
  'x-ratelimit-remaining', 'x-ratelimit-used', 'x-ratelimit-reset'];

// Directory of an installed package (walks up from its entry point).
function packageRoot(name) {
  let dir = path.dirname(require.resolve(name));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) return dir;
    } catch (e) { /* keep walking */ }
    dir = path.dirname(dir);
  }
  throw new Error('Package root not found for ' + name);
}

let readablePaths = null;
function sandboxReadablePaths() {
  if (!readablePaths) {
    const qjs = packageRoot('quickjs-emscripten');
    const core = packageRoot('quickjs-emscripten-core');
    const jitl = path.dirname(packageRoot('@jitl/quickjs-wasmfile-release-sync'));
    readablePaths = { entry: require.resolve('quickjs-emscripten'), dirs: [CHILD, qjs, core, jitl] };
  }
  return readablePaths;
}

function sandboxSupported() {
  const flags = process.allowedNodeEnvironmentFlags;
  if (!flags || !flags.has('--permission')) {
    return { ok: false, reason: 'The custom-code sandbox needs Node.js 22 or newer (Node\'s --permission model).' };
  }
  try { sandboxReadablePaths(); } catch (e) {
    return { ok: false, reason: 'The QuickJS sandbox engine isn\'t installed. Run "npm install" and restart MetaCode.' };
  }
  return { ok: true };
}

function validateCode(code, language) {
  if (typeof code !== 'string' || !code.trim()) throw new ScraperError('invalid_request', 'Write your scraper code first.', { status: 400 });
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new ScraperError('invalid_request', 'The scraper code is too long (200 KB at most).', { status: 400 });
  if (!['javascript', 'typescript'].includes(language)) throw new ScraperError('invalid_request', 'Language must be javascript or typescript.', { status: 400 });
}

function createCustomRunner(opts) {
  const config = opts.config;

  return function runCustom(job, ctx) {
    return new Promise((resolve, reject) => {
      const support = sandboxSupported();
      if (!support.ok) return reject(new ScraperError('not_available', support.reason, { status: 503 }));

      const paths = sandboxReadablePaths();
      const memoryMb = config.customMemoryMb;
      const execArgv = [
        '--permission',
        ...paths.dirs.map(p => '--allow-fs-read=' + p),
        '--max-old-space-size=' + (memoryMb * 2 + 64),
        '--disallow-code-generation-from-strings',
        '--no-warnings'
      ];
      const env = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
      let child;
      try {
        child = fork(CHILD, [paths.entry], { execArgv, env, cwd: path.dirname(CHILD), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
      } catch (err) {
        return reject(new ScraperError('sandbox_error', 'The sandbox process couldn\'t be started.', { status: 500, detail: String(err && err.message) }));
      }

      let settled = false;
      let stderr = '';
      const started = Date.now();
      const timeoutMs = config.customTimeoutMs;
      const signal = ctx.signal;

      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (err) reject(err); else resolve(value);
      };

      const timer = setTimeout(() => {
        settle(new ScraperError('custom_code_timeout', 'Your scraper ran longer than the ' + Math.round(timeoutMs / 1000) +
          '-second limit (SCRAPER_CUSTOM_TIMEOUT_MS) and was stopped. Records emitted before that are kept.', { status: 504 }));
      }, timeoutMs + 2000);   // the sandbox's own interrupt fires first; this is the hard backstop

      const onAbort = () => settle(signal.reason || cancelledError());
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
      child.on('error', err => settle(new ScraperError('sandbox_error', 'The sandbox process failed.', { status: 500, detail: String(err && err.message) })));
      child.on('exit', (code, sig) => {
        if (settled) return;
        const detail = 'exit ' + code + (sig ? ' ' + sig : '') + (stderr ? ': ' + sanitize(stderr, 300) : '');
        if (/heap out of memory|Allocation failed/i.test(stderr)) {
          return settle(new ScraperError('custom_code_memory', 'Your scraper used too much memory and the sandbox was stopped.', { status: 500, detail }));
        }
        settle(new ScraperError('sandbox_error', 'The sandbox stopped unexpectedly before your scraper finished.', { status: 500, detail }));
      });

      const reply = (id, ok, payload) => {
        if (settled || !child.connected) return;
        child.send(ok ? { type: 'reply', id, ok: true, value: payload } : { type: 'reply', id, ok: false, error: payload });
      };

      const handleCall = async msg => {
        let args = null;
        try { args = JSON.parse(msg.args); } catch (e) { args = null; }
        try {
          if (msg.name === 'sleep') {
            const ms = Math.max(0, Math.min(MAX_SLEEP_MS, Number(args && args.ms) || 0));
            await sleep(ms, signal);
            return reply(msg.id, true, 'null');
          }
          if (msg.name === 'fetch') {
            const res = await ctx.http.request(String(args && args.url), Object.assign({}, ctx.requestOpts, {
              method: args && args.method, headers: args && args.headers
            }));
            const headers = {};
            PASS_HEADERS.forEach(h => { if (res.headers[h] !== undefined) headers[h] = res.headers[h]; });
            return reply(msg.id, true, JSON.stringify({ status: res.status, statusText: res.statusText, url: res.url, headers, body: res.body }));
          }
          if (msg.name === 'redditJson') {
            const url = ctx.http.buildApiUrl(String(args && args.path), args && args.query);
            const res = await ctx.http.request(url, ctx.requestOpts);
            if (res.status < 200 || res.status >= 300) throw httpError(res.status);
            return reply(msg.id, true, JSON.stringify({ url: res.url, body: res.body }));
          }
          throw new ScraperError('invalid_request', 'Unknown sandbox call.', { status: 400 });
        } catch (err) {
          const e = isScraperError(err) ? err : new ScraperError('internal_error', 'The host failed to complete the request.', { detail: String(err && err.message) });
          if (!isScraperError(err)) ctx.log('warn', 'Host error: ' + sanitize(err && err.message, 200));
          reply(msg.id, false, { name: 'ScraperError', type: e.type, message: e.message });
        }
      };

      child.on('message', msg => {
        if (settled || !msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'call': handleCall(msg); break;
          case 'emit': ctx.emit(Array.isArray(msg.records) ? msg.records : []); break;
          case 'log': ctx.log(msg.level, '[code] ' + String(msg.message || '')); break;
          case 'progress': ctx.progress(msg.patch || {}); break;
          case 'done': {
            const meta = msg.result && msg.result.meta;
            if (meta && typeof meta === 'object') ctx.setMeta('custom', meta);
            ctx.log('info', 'Sandbox finished in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.');
            settle(null);
            break;
          }
          case 'error': {
            const e = msg.error || {};
            const type = typeof e.type === 'string' ? e.type : 'custom_code_error';
            settle(new ScraperError(type, String(e.message || 'Your scraper failed.'), { status: 400 }));
            break;
          }
          default: break;
        }
      });

      try {
        child.send({
          type: 'start',
          code: job.code,
          language: job.language,
          formatSource: FORMAT_SOURCE,
          preludeSource: PRELUDE_SOURCE,
          limits: { memoryBytes: memoryMb * 1024 * 1024, timeoutMs },
          init: { target: job.target, options: job.options, params: job.params || {}, mode: ctx.http.mode }
        });
      } catch (err) {
        settle(new ScraperError('sandbox_error', 'The sandbox process couldn\'t be started.', { status: 500, detail: String(err && err.message) }));
      }
    });
  };
}

module.exports = { createCustomRunner, sandboxSupported, validateCode, MAX_CODE_BYTES };
