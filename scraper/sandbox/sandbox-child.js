// ── Custom-code sandbox process ───────────────────────────────────────────────
// Started by custom-runner.js with:
//   • Node's permission model (--permission): no file reads except the
//     QuickJS engine's own package files, no file writes, no child
//     processes, no worker threads, no native addons, no WASI;
//   • an empty environment (no .env secrets, no API keys);
//   • a capped V8 heap, and a hard wall-clock kill from the parent.
// Inside it, the user's code runs in QuickJS compiled to WebAssembly — a
// separate JavaScript engine with no Node, no require, no process, no
// network and no timers. Its only way out is the two JSON-string functions
// installed below, relayed to the parent over the IPC channel; the parent
// performs (and polices) every Reddit request.

'use strict';

const QUICKJS_ENTRY = process.argv[2];

const LIMITS = {
  maxMessageBytes: 1024 * 1024,        // one emit()/log() batch
  maxTotalEmitBytes: 64 * 1024 * 1024, // everything emitted by one run
  maxLogLines: 2000,
  maxPendingCalls: 16
};

let totalEmitBytes = 0;
let logLines = 0;
let callSeq = 0;
const pending = new Map();         // id → { resolve, reject }
let finished = false;

function send(msg) {
  if (finished && msg.type !== 'done' && msg.type !== 'error') return;
  if (process.connected) process.send(msg);
}

function finish(msg) {
  if (finished) return;
  send(msg);
  finished = true;
  // Give the IPC channel a moment to flush, then exit.
  setTimeout(() => process.exit(0), 50);
}

process.on('message', msg => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start') {
    run(msg).catch(err => finish({ type: 'error', error: { type: 'sandbox_error', message: 'The sandbox failed to start: ' + String(err && err.message).slice(0, 300) } }));
  } else if (msg.type === 'reply') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(msg.error || { message: 'Host call failed' });
  }
});

process.on('disconnect', () => process.exit(0));

function stripTypes(code) {
  let strip = null;
  try { strip = require('node:module').stripTypeScriptTypes; } catch (e) { strip = null; }
  if (typeof strip !== 'function') {
    throw Object.assign(new Error('TypeScript needs Node.js 22.13 or newer on the MetaCode server. Switch the language to JavaScript.'), { userFacing: true });
  }
  try {
    return strip(code, { mode: 'strip' });
  } catch (e) {
    throw Object.assign(new Error('TypeScript error: ' + String(e && e.message).split('\n')[0].slice(0, 300) +
      ' (only type annotations are supported — enums, namespaces and parameter properties are not)'), { userFacing: true });
  }
}

async function run(start) {
  const { newQuickJSWASMModule, RELEASE_SYNC, shouldInterruptAfterDeadline } = require(QUICKJS_ENTRY);
  const QuickJS = await newQuickJSWASMModule(RELEASE_SYNC);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(start.limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + start.limits.timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm = runtime.newContext();

  const errorText = handle => {
    const e = vm.dump(handle);
    let hostType = null;
    if (vm.typeof(handle) === 'object') {
      const t = vm.getProp(handle, 'type');
      if (vm.typeof(t) === 'string') hostType = vm.getString(t);
      t.dispose();
    }
    handle.dispose();
    if (e && typeof e === 'object') {
      const name = e.name || 'Error';
      const stack = typeof e.stack === 'string' ? '\n' + e.stack.split('\n').slice(0, 8).join('\n') : '';
      return { name, message: String(e.message || ''), text: name + ': ' + String(e.message || '') + stack, hostType };
    }
    return { name: 'Error', message: String(e), text: String(e), hostType };
  };

  const pump = () => {
    const r = runtime.executePendingJobs();
    if (r.error) {
      const e = errorText(r.error);
      finish({ type: 'error', error: classifyGuestError(e) });
    }
  };

  // __host_send(name, json): log / emit / progress, synchronously queued to the parent.
  const hostSend = vm.newFunction('__host_send', (nameH, jsonH) => {
    const name = vm.getString(nameH);
    const json = vm.getString(jsonH);
    if (json.length > LIMITS.maxMessageBytes) {
      return { error: vm.newError('Message too large (over ' + Math.round(LIMITS.maxMessageBytes / 1024) + ' KB); emit records in smaller batches') };
    }
    let value;
    try { value = JSON.parse(json); } catch (e) { return { error: vm.newError('Value is not JSON-serializable') }; }
    if (name === 'emit') {
      totalEmitBytes += json.length;
      if (totalEmitBytes > LIMITS.maxTotalEmitBytes) return { error: vm.newError('Total emitted data exceeds the sandbox limit (64 MB)') };
      send({ type: 'emit', records: value });
    } else if (name === 'log') {
      if (++logLines > LIMITS.maxLogLines) return undefined;
      if (logLines === LIMITS.maxLogLines) value = { level: 'warn', message: 'Log limit reached; further log lines are dropped.' };
      send({ type: 'log', level: value && value.level, message: value && String(value.message).slice(0, 2000) });
    } else if (name === 'progress') {
      send({ type: 'progress', patch: value });
    }
    return undefined;
  });
  vm.setProp(vm.global, '__host_send', hostSend);
  hostSend.dispose();

  // __host_call(name, json) → Promise<json>: answered by the parent.
  const hostCall = vm.newFunction('__host_call', (nameH, jsonH) => {
    const name = vm.getString(nameH);
    const args = vm.getString(jsonH);
    const deferred = vm.newPromise();
    if (pending.size >= LIMITS.maxPendingCalls) {
      const err = vm.newError('Too many concurrent requests from the sandbox (max ' + LIMITS.maxPendingCalls + ')');
      deferred.reject(err);
      err.dispose();
      return deferred.handle;
    }
    const id = ++callSeq;
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: 'call', id, name, args });
    }).then(value => {
      if (!deferred.alive) return;
      const h = vm.newString(value === undefined || value === null ? '' : String(value));
      deferred.resolve(h);
      h.dispose();
    }, error => {
      if (!deferred.alive) return;
      const h = vm.newError({ name: error.name || 'ScraperError', message: String(error.message || 'Host call failed') });
      if (error.type) {
        const t = vm.newString(String(error.type));
        vm.setProp(h, 'type', t);
        t.dispose();
      }
      deferred.reject(h);
      h.dispose();
    }).finally(() => {
      deferred.dispose();
      pump();
    });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__host_call', hostCall);
  hostCall.dispose();

  const evalOrFail = (source, filename, userCode) => {
    const r = vm.evalCode(source, filename, { type: 'global' });
    if (r.error) {
      const e = errorText(r.error);
      const err = new Error(e.text);
      err.guest = e;
      err.userCode = userCode;
      throw err;
    }
    r.value.dispose();
  };

  try {
    evalOrFail(start.formatSource, 'reddit-format.js', false);
    evalOrFail(start.preludeSource, 'sdk.js', false);
    const code = start.language === 'typescript' ? stripTypes(start.code) : start.code;
    evalOrFail(code, 'scraper.js', true);
    // Lexical declarations (const scrape = …) aren't properties of globalThis.
    evalOrFail('if (typeof scrape === "function") globalThis.scrape = scrape;', 'bind.js', false);
  } catch (err) {
    if (err.userFacing) return finish({ type: 'error', error: { type: 'custom_code_error', message: err.message } });
    if (err.guest) {
      const classified = classifyGuestError(err.guest);
      if (!err.userCode && classified.type === 'custom_code_error') classified.type = 'sandbox_error';
      return finish({ type: 'error', error: classified });
    }
    throw err;
  }

  const runFn = vm.getProp(vm.global, '__metacode_run');
  const initH = vm.newString(JSON.stringify(start.init));
  const callResult = vm.callFunction(runFn, vm.undefined, initH);
  runFn.dispose();
  initH.dispose();
  if (callResult.error) return finish({ type: 'error', error: classifyGuestError(errorText(callResult.error)) });

  const promiseH = callResult.value;
  const settled = vm.resolvePromise(promiseH);
  promiseH.dispose();
  pump();
  const outcome = await settled;
  if (finished) return;
  if (outcome.error) return finish({ type: 'error', error: classifyGuestError(errorText(outcome.error)) });
  const text = vm.getString(outcome.value);
  outcome.value.dispose();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  finish({ type: 'done', result: parsed });
}

// Host errors the user's code didn't catch (e.g. robots.txt refusal, rate
// limit, cancelled) keep their own type and message.
const HOST_TYPES = /^(cancelled|not_available|payment_required|browser_unavailable|reddit_blocked|forbidden_private|forbidden_quarantined|forbidden_premium|timeout|network|tls|proxy_blocked|proxy_error|http_error|not_found|forbidden|rate_limited|robots_disallowed|robots_unavailable|auth_error|invalid_url|host_not_allowed|invalid_request|too_large|parse_error)$/;

function classifyGuestError(e) {
  if (e.hostType && HOST_TYPES.test(e.hostType)) return { type: e.hostType, message: e.message, fromHost: true };
  if (e.name === 'InternalError' && /interrupted/i.test(e.message)) {
    return { type: 'custom_code_timeout', message: 'Your scraper ran past the time limit and was stopped.' };
  }
  if (e.name === 'InternalError' && /out of memory/i.test(e.message)) {
    return { type: 'custom_code_memory', message: 'Your scraper ran out of memory (sandbox limit) and was stopped.' };
  }
  if (e.name === 'InternalError' && /stack overflow/i.test(e.message)) {
    return { type: 'custom_code_error', message: 'Your scraper exceeded the maximum call stack size (infinite recursion?).' };
  }
  return { type: 'custom_code_error', message: 'Your scraper threw an error: ' + e.text.slice(0, 1500) };
}
