// ── Python custom-code sandbox process ────────────────────────────────────────
// Started by custom-runner.js for language "python", with the same outer
// walls as the JavaScript sandbox (sandbox-child.js):
//   • Node's permission model (--permission): no file reads except Pyodide's
//     own package files and reddit/format.js, no file writes, no child
//     processes, no worker threads, no native addons, no WASI;
//   • --disallow-code-generation-from-strings (no eval / new Function);
//   • an empty environment (no .env secrets, no API keys);
//   • a hard wall-clock kill from the parent.
// Inside it, the user's code runs in Pyodide — CPython compiled to
// WebAssembly. Pyodide can call into JavaScript, so this file also takes away
// everything network-shaped before any user code runs:
//   • the networking built-ins (net, tls, http, dns, …) can't be loaded
//     (module resolve hook), process.getBuiltinModule is removed;
//   • fetch, WebSocket and friends are deleted from the global scope;
//   • Pyodide's opt-in Node sockets, host-folder mounts and package
//     downloads are switched off;
//   • Python's `js` module is an empty object, not Node's global scope;
//   • WebAssembly memory can't grow past the configured limit.
// What's left is one bridge (_metacode_host) whose calls are relayed to the
// parent over IPC; the parent performs (and polices) every Reddit request.

'use strict';

const nodeModule = require('node:module');
const fsConstants = require('node:fs').constants;

const PYODIDE_ENTRY = process.argv[2];
const PYODIDE_DIR = process.argv[3];
const FORMAT_PATH = process.argv[4];

const LIMITS = {
  maxMessageBytes: 1024 * 1024,        // one emit()/log() batch
  maxTotalEmitBytes: 64 * 1024 * 1024, // everything emitted by one run
  maxLogLines: 2000,
  maxPendingCalls: 16
};

const BLOCKED_MODULES = /^(node:)?(net|tls|dgram|http|https|http2|dns|dns\/promises|child_process|cluster|worker_threads|inspector|inspector\/promises|repl|vm|wasi|undici|module|ws)$/;

// Refuses those modules from here on. Installed once Pyodide has loaded (it
// imports node:vm to run its own bundled files) and before any user code.
function blockNetworkModules() {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (BLOCKED_MODULES.test(specifier)) {
        const err = new Error('"' + specifier + '" is not available in the MetaCode sandbox');
        err.code = 'ERR_ACCESS_DENIED';
        throw err;
      }
      return next(specifier, context);
    }
  });
}

// ── Lock-down that doesn't depend on the job ─────────────────────────────────
// Emscripten's NODEFS asks process.binding('constants') for open() flags at
// start-up; the permission model blocks process.binding outright.
process.binding = name => {
  if (name === 'constants') return { fs: fsConstants };
  throw Object.assign(new Error('process.binding is not available in the MetaCode sandbox'), { code: 'ERR_ACCESS_DENIED' });
};
for (const name of ['getBuiltinModule', 'dlopen', '_linkedBinding', 'mainModule', 'kill', 'chdir', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups', 'loadEnvFile']) {
  try { delete process[name]; } catch (e) { /* not present */ }
  try { if (process[name] !== undefined) process[name] = undefined; } catch (e) { /* read-only */ }
}
for (const name of ['fetch', 'WebSocket', 'WebSocketStream', 'EventSource', 'XMLHttpRequest', 'navigator']) {
  try { delete globalThis[name]; } catch (e) { /* not configurable */ }
}
// Stack-trace hooks are the classic way to reach host objects from a call
// site; nothing here needs them.
Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });

let totalEmitBytes = 0;
let logLines = 0;
let callSeq = 0;
const pending = new Map();         // id → resolve
let finished = false;

const send = msg => {
  if (finished && msg.type !== 'done' && msg.type !== 'error') return;
  if (process.connected) process.send(msg);
};

function finish(msg) {
  if (finished) return;
  send(msg);
  finished = true;
  setTimeout(() => process.exit(0), 50);
}

process.on('message', msg => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start') {
    run(msg).catch(err => finish({ type: 'error', error: { type: 'sandbox_error', message: 'The Python sandbox failed to start: ' + String(err && err.message).slice(0, 300) } }));
  } else if (msg.type === 'reply') {
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    // Always resolves: Python gets { ok, value } / { ok: false, error } and
    // raises its own exception type.
    resolve(JSON.stringify(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error || { message: 'Host call failed' } }));
  }
});

process.on('disconnect', () => process.exit(0));

// Caps how far WebAssembly memory may grow. Emscripten treats a failed grow()
// as out-of-memory, which Python raises as MemoryError.
function capWasmMemory(maxBytes) {
  const grow = WebAssembly.Memory.prototype.grow;
  Object.defineProperty(WebAssembly.Memory.prototype, 'grow', {
    configurable: false,
    writable: false,
    value: function (delta) {
      if (this.buffer.byteLength + Number(delta) * 65536 > maxBytes) throw new RangeError('WebAssembly.Memory.grow(): sandbox memory limit reached');
      return grow.call(this, delta);
    }
  });
}

function makeFormat() {
  const F = require(FORMAT_PATH);
  const allowed = new Set(['normalizePost', 'normalizeComment', 'normalizeSubreddit', 'normalizeUser', 'normalizeThing', 'flattenComments', 'extractMedia', 'toIso']);
  return (name, argsJson) => {
    if (!allowed.has(name)) throw new Error('Unknown formatter ' + name);
    const out = F[name].apply(null, JSON.parse(argsJson));
    return out === undefined ? 'null' : JSON.stringify(out);
  };
}

async function run(start) {
  capWasmMemory(start.limits.memoryBytes);

  let stdoutBuf = '';
  const log = (level, message) => {
    if (++logLines > LIMITS.maxLogLines) return;
    if (logLines === LIMITS.maxLogLines) { level = 'warn'; message = 'Log limit reached; further log lines are dropped.'; }
    send({ type: 'log', level, message: String(message).slice(0, 2000) });
  };

  // Python's `js` module: nothing but timers (asyncio's event loop uses them).
  const jsGlobals = Object.create(null);
  jsGlobals.setTimeout = (fn, ms) => setTimeout(fn, ms);
  jsGlobals.clearTimeout = id => clearTimeout(id);
  Object.freeze(jsGlobals);

  const { loadPyodide } = require(PYODIDE_ENTRY);
  let py;
  try {
    py = await loadPyodide({
      indexURL: PYODIDE_DIR,
      jsglobals: jsGlobals,
      env: { HOME: '/home/pyodide' },
      packages: [],
      stdout: line => log('info', line),
      stderr: line => log('warn', line)
    });
  } catch (err) {
    if (err instanceof RangeError || /memory/i.test(String(err && err.message))) {
      return finish({ type: 'error', error: { type: 'custom_code_memory', message: 'Python needs more memory than SCRAPER_CUSTOM_PYTHON_MEMORY_MB allows to start.' } });
    }
    throw err;
  }

  const host = Object.freeze({
    call(name, argsJson) {
      if (pending.size >= LIMITS.maxPendingCalls) {
        return Promise.resolve(JSON.stringify({ ok: false, error: { type: 'custom_code_error', message: 'Too many concurrent requests from the sandbox (max ' + LIMITS.maxPendingCalls + ')' } }));
      }
      const id = ++callSeq;
      return new Promise(resolve => {
        pending.set(id, resolve);
        send({ type: 'call', id, name: String(name), args: String(argsJson) });
      });
    },
    // Returns an error message, or '' when sent.
    send(name, json) {
      json = String(json);
      if (json.length > LIMITS.maxMessageBytes) return 'Message too large (over ' + Math.round(LIMITS.maxMessageBytes / 1024) + ' KB); emit records in smaller batches';
      let value;
      try { value = JSON.parse(json); } catch (e) { return 'Value is not JSON-serializable'; }
      if (name === 'emit') {
        totalEmitBytes += json.length;
        if (totalEmitBytes > LIMITS.maxTotalEmitBytes) return 'Total emitted data exceeds the sandbox limit (64 MB)';
        send({ type: 'emit', records: value });
      } else if (name === 'log') {
        log(value && value.level, value && value.message);
      } else if (name === 'progress') {
        send({ type: 'progress', patch: value });
      }
      return '';
    },
    format: makeFormat()
  });

  // The SDK module gets the bridge; then the registry entry is dropped.
  py.registerJsModule('_metacode_host', host);
  const sdk = py.globals.get('dict')();
  py.runPython(start.preludeSource, { filename: 'metacode_sdk.py', globals: sdk });
  const runner = sdk.get('__metacode_run');
  sdk.destroy();
  py.unregisterJsModule('_metacode_host');
  py.runPython('import sys\nsys.modules.pop("_metacode_host", None)\ndel sys');

  blockNetworkModules();

  // Switch off what Pyodide could otherwise do from Python via pyodide_js.
  const denied = what => () => { throw new Error(what + ' is not available in the MetaCode sandbox'); };
  const lockDown = (obj, name, fn) => {
    try { Object.defineProperty(obj, name, { value: fn, writable: false, configurable: false }); } catch (e) { /* already locked */ }
  };
  const api = py._api;
  lockDown(api, 'initializeNodeSockFS', denied('Network sockets'));
  lockDown(api, '_nodeSock', Object.freeze({}));
  for (const name of ['useNodeSockFS', 'mountNodeFS', 'mountNativeFS', 'loadPackage', 'loadPackagesFromImports', 'registerJsModule', 'unregisterJsModule', 'setStdin', 'setStdout', 'setStderr']) {
    const label = /Package/.test(name) ? 'Installing packages (only the Python standard library is available)' : name;
    lockDown(py, name, denied(label));
  }
  // Host-disk file systems: Python could mount them through pyodide_js.FS.
  // (The permission model would refuse the reads anyway.)
  const filesystems = py.FS && py.FS.filesystems;
  if (filesystems) {
    for (const name of Object.keys(filesystems)) if (!['MEMFS', 'IDBFS', 'PROXYFS'].includes(name)) delete filesystems[name];
    Object.freeze(filesystems);
  }

  const resultJson = await runner(start.code, JSON.stringify(start.init));
  runner.destroy();
  let result = null;
  try { result = JSON.parse(resultJson); } catch (e) { result = null; }
  if (!result || typeof result !== 'object') return finish({ type: 'error', error: { type: 'sandbox_error', message: 'The Python sandbox returned no result.' } });
  if (result.ok) return finish({ type: 'done', result: { emitted: result.emitted, meta: result.meta || null } });
  return finish({ type: 'error', error: { type: result.error && result.error.type || 'custom_code_error', message: String(result.error && result.error.message || 'Your scraper failed.') } });
}
