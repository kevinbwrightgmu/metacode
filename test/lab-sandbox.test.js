// AI Coding Lab: the code sandbox for experiment code (ai-lab/code-sandbox.js).
// Real runs go through the scraper's sandbox children (QuickJS / Pyodide) with
// the Lab's preludes; the parent's own caps are also tested against a fake
// child that misbehaves on purpose. Skipped where the platform lacks Node's
// permission model (or Pyodide's module hooks, for Python).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const {
  createCodeSandbox, executionSettings, probeIsolation, isolatedCommand, spawnSandboxChild,
  POLICY_VERSION, PYTHON_ALLOWED_MODULES
} = require('../ai-lab/code-sandbox');
const { LabError } = require('../ai-lab/errors');

const sandbox = (execution, extra) => createCodeSandbox(Object.assign({ getConfig: () => ({ execution: Object.assign({ timeoutMs: 4000 }, execution || {}) }) }, extra || {}));
const jsSupport = sandbox().supported('javascript');
const pySupport = sandbox().supported('python');
const skipJs = !jsSupport.ok && jsSupport.reason;
const skipPy = !pySupport.ok && pySupport.reason;

const VARIABLE = {
  id: 'tone', name: 'Tone', description: 'Overall tone of the post',
  codes: [{ id: 'pos', label: 'Positive', description: 'Supportive' }, { id: 'neg', label: 'Negative', description: 'Critical' }]
};
// Records as the server keeps them (with labels): the sandbox must drop the labels.
const records = (n, textChars) => Array.from({ length: n }, (_, i) => ({
  id: 'r' + i, text: (i % 2 ? 'good ' : 'bad ') + 'x'.repeat(textChars || 10), author: 'a' + i, timestamp: '2024-01-0' + (1 + (i % 9)),
  meta: { likes: i, platform: 'reddit' }, reference: 'pos', referenceSource: 'adjudicated', baseline: 'neg', split: 'test'
}));
const collector = () => {
  const out = { logs: [], progress: [], policy: null, pid: null };
  out.hooks = { onLog: l => out.logs.push(l), onProgress: p => out.progress.push(p), onPolicy: f => { out.policy = f; }, onSpawn: pid => { out.pid = pid; } };
  return out;
};
const gone = pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
// Watches the IPC traffic of real children (and can rewrite the start message).
const tap = rewriteStart => {
  const seen = { start: null, calls: [], replies: [] };
  const spawnChild = plan => {
    const child = spawnSandboxChild(plan);
    const send = child.send.bind(child);
    child.send = (msg, ...rest) => {
      if (msg.type === 'start') { if (rewriteStart) msg = rewriteStart(msg); seen.start = msg; }
      if (msg.type === 'reply') seen.replies.push(msg);
      return send(msg, ...rest);
    };
    child.on('message', m => { if (m && m.type === 'call') seen.calls.push(m); });
    return child;
  };
  return { seen, spawnChild };
};

test('shared constants and settings', () => {
  assert.equal(POLICY_VERSION, 'policy-1');
  assert.ok(Object.isFrozen(PYTHON_ALLOWED_MODULES));
  for (const m of ['re', 'math', 'collections', 'json', 'random', '__future__']) assert.ok(PYTHON_ALLOWED_MODULES.includes(m), m);
  for (const m of ['os', 'sys', 'socket', 'requests', 'time', 'importlib']) assert.ok(!PYTHON_ALLOWED_MODULES.includes(m), m);
  // config.js without `execution` yet: the spec defaults.
  assert.deepEqual(executionSettings({ codeExecution: 'off' }), { mode: 'sandbox', isolation: 'auto', timeoutMs: 15000, memoryMb: 64, pythonMemoryMb: 256, maxOutputKb: 8192, maxRunning: 2 });
  const s = executionSettings({ execution: { mode: 'yes', isolation: 'namespace', timeoutMs: 999999, memoryMb: 32, pythonMemoryMb: 64, maxOutputKb: 300, maxRunning: 4 } });
  assert.deepEqual(s, { mode: 'off', isolation: 'namespace', timeoutMs: 15000, memoryMb: 32, pythonMemoryMb: 256, maxOutputKb: 300, maxRunning: 4 });
  assert.equal(sandbox().supported('ruby').ok, false);
});

test('execution off and bad requests are refused before anything starts', async () => {
  const off = sandbox({ mode: 'off' });
  await assert.rejects(off.run({ language: 'javascript', code: 'function classify() {}', records: [], variable: VARIABLE }),
    err => err instanceof LabError && err.type === 'execution_disabled' && err.status === 503);
  const sb = sandbox();
  await assert.rejects(sb.run({ language: 'javascript', code: 'function classify() {}', records: [], variable: VARIABLE, mode: 'analyze' }), err => err.type === 'invalid_request');
  await assert.rejects(sb.run({ language: 'cobol', code: 'x', records: [], variable: VARIABLE }), err => err.type === 'invalid_request');
  await assert.rejects(sb.run({ language: 'javascript', code: '   ', records: [], variable: VARIABLE }), err => err.type === 'invalid_request');
  await assert.rejects(sb.run({ language: 'javascript', code: 'function classify() {}', records: [{ id: 'a' }, { id: 'a' }], variable: VARIABLE }), /unique/);
  await assert.rejects(sb.run({ language: 'javascript', code: 'function classify() {}', records: [{ text: 'no id' }], variable: VARIABLE }), /needs an id/);
});

test('JavaScript: classify over > 100 records with multi-KB texts, pulled in batches; console → stdout/stderr', { skip: skipJs }, async () => {
  const t = tap();
  const sb = sandbox({}, { spawnChild: t.spawnChild });
  const c = collector();
  const input = records(250, 5000);
  const out = await sb.run({ language: 'javascript', variable: VARIABLE, records: input, code: `
    console.log('loaded', 1 + 1);
    function classify(record, variable) {
      if (record.id === 'r1') console.warn('warned', record.text.length);
      if (record.id === 'r2') console.error('failed?', { id: record.id });
      if (record.id === 'r3') throw new Error('boom');
      if (record.id === 'r4') return { code: null, reason: Object.keys(record).sort().join(',') + '|' + Object.isFrozen(record) + Object.isFrozen(variable.codes[0]) + '|' + variable.codes.length };
      return record.text.startsWith('good') ? { code: 'pos', confidence: 0.75, reason: 'good word' } : 'neg';
    }` }, c.hooks);
  assert.equal(out.ok, true, JSON.stringify(out.failure));
  assert.equal(out.failure, null);
  assert.equal(out.outputs.length, 250);
  assert.deepEqual(out.outputs.map(o => o.id), input.map(r => r.id));
  assert.equal(out.outputs[0].out, 'neg');
  assert.deepEqual(out.outputs[1].out, { code: 'pos', confidence: 0.75, reason: 'good word' });
  assert.match(out.outputs[3].error, /^Error: boom\n.*rule\.js:6/);
  assert.ok(!/sdk\.js/.test(out.outputs[3].error));
  // No labels, no split; records and the variable are frozen.
  assert.equal(out.outputs[4].out.reason, 'author,id,meta,text,timestamp|truetrue|2');
  assert.ok(out.outputs.every(o => typeof o.ms === 'number'));
  assert.deepEqual(c.logs, [
    { stream: 'stdout', level: 'info', text: 'loaded 2' },
    { stream: 'stderr', level: 'warn', text: 'warned 5005' },
    { stream: 'stderr', level: 'error', text: 'failed? {"id":"r2"}' }
  ]);
  assert.deepEqual(c.progress.at(-1), { done: 250, total: 250 });
  assert.equal(out.policy, null);
  assert.equal(out.engine.name, 'QuickJS (quickjs-emscripten)');
  assert.ok(out.bootMs >= 0 && out.durationMs >= 0);
  assert.ok(out.resources.rssBytes > 0 && out.resources.engineMemoryBytes > 0 && out.resources.outputBytes > 0 && out.resources.logBytes > 0);
  // Records never travel in the start message; batches are ≤ 100 records and ≤ 256 KB.
  assert.equal(t.seen.start.init.records, undefined);
  assert.deepEqual(Object.keys(t.seen.start.init).sort(), ['mode', 'total', 'variable']);
  assert.ok(t.seen.calls.length >= 5 && t.seen.calls.every(m => m.name === 'input.next'), t.seen.calls.length + ' calls');
  const batches = t.seen.replies.map(r => JSON.parse(r.value));
  assert.equal(batches.reduce((n, b) => n + b.records.length, 0), 250);
  assert.ok(batches.every(b => b.records.length <= 100));
  assert.ok(t.seen.replies.every(r => Buffer.byteLength(r.value) <= 256 * 1024 + 100));
  assert.equal(batches.at(-1).done, true);
  assert.equal(sb.stats().running, 0);
});

test('TypeScript: types are stripped, lines are kept', { skip: skipJs }, async () => {
  const out = await sandbox().run({ language: 'typescript', variable: VARIABLE, records: records(3), code: [
    'interface Rec { id: string; text: string }',
    'const classify = (record: Rec, variable: any): string | null => {',
    '  if (record.id === "r2") throw new TypeError("bad " + (record.text as string).length);',
    '  return record.text.startsWith("good") ? "pos" : null;',
    '};'
  ].join('\n') });
  assert.equal(out.ok, true, JSON.stringify(out.failure));
  assert.deepEqual(out.outputs.map(o => o.out === undefined ? o.error.split('\n')[0] : o.out), [null, 'pos', 'TypeError: bad 14']);
  assert.match(out.outputs[2].error, /rule\.ts:3/);
});

test('JavaScript contract problems: no classify, async classify, values that are not JSON', { skip: skipJs }, async () => {
  const sb = sandbox();
  const none = await sb.run({ language: 'javascript', code: 'function scrape() {}', records: records(2), variable: VARIABLE });
  assert.equal(none.ok, false);
  assert.equal(none.failure.type, 'contract_error');
  assert.match(none.failure.message, /Define a function classify\(record, variable\)/);
  const odd = await sb.run({ language: 'javascript', records: records(3), variable: VARIABLE,
    code: 'async function classify(r) { return "pos" }\nconst wrap = classify;\nglobalThis.x = 1;' });
  assert.equal(odd.ok, true);
  assert.ok(odd.outputs.every(o => /not a Promise/.test(o.error)));
  const bad = await sb.run({ language: 'javascript', records: records(2), variable: VARIABLE,
    code: 'function classify(r) { if (r.id === "r0") { const a = {}; a.self = a; return a; } return 10n; }' });
  assert.deepEqual(bad.outputs.map(o => /isn't JSON/.test(o.error)), [true, true]);
});

test('JavaScript escape attempts (static check bypassed, runner called directly) find no Node, host functions or timers', { skip: skipJs }, async () => {
  const out = await sandbox().run({ language: 'javascript', records: records(1), variable: VARIABLE, code: `
    function classify(record) {
      const p = {};
      p.process = typeof process; p.require = typeof require; p.module = typeof module;
      p.hostCall = typeof __host_call; p.hostSend = typeof __host_send;
      p.fetch = typeof fetch; p.setTimeout = typeof setTimeout; p.WebSocket = typeof WebSocket;
      p.constructorChain = (function () { try { return [].constructor.constructor('return typeof process')(); } catch (e) { return 'error'; } })();
      p.viaRecord = (function () { try { return record.constructor.constructor('return typeof require')(); } catch (e) { return 'error'; } })();
      p.globalThisProcess = (function () { try { return typeof Function('return this')().process; } catch (e) { return 'error'; } })();
      p.hostGlobals = Object.getOwnPropertyNames(globalThis).filter(n => /^(process|require|module|__host_call|__host_send|fetch|setTimeout|RedditFormat)$/.test(n)).join(',');
      return { code: null, reason: JSON.stringify(p) };
    }` });
  assert.equal(out.ok, true, JSON.stringify(out.failure));
  assert.deepEqual(JSON.parse(out.outputs[0].out.reason), {
    process: 'undefined', require: 'undefined', module: 'undefined', hostCall: 'undefined', hostSend: 'undefined',
    fetch: 'undefined', setTimeout: 'undefined', WebSocket: 'undefined',
    constructorChain: 'undefined', viaRecord: 'undefined', globalThisProcess: 'undefined', hostGlobals: ''
  });
});

test('the constructor-chain escape is also blocked by the JavaScript policy (when code-policy.js is present)', { skip: skipJs }, t => {
  let policy;
  try { policy = require('../ai-lab/code-policy'); } catch (e) { return t.skip('ai-lab/code-policy.js is not in this checkout yet'); }
  const report = policy.analyzeJavaScript('function classify(r) { return [].constructor.constructor("return process")(); }', 'javascript');
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(f => f.rule === 'forbidden_property' && f.line === 1), JSON.stringify(report.findings));
  // One list of Python modules and one policy version for both modules.
  assert.equal(policy.POLICY_VERSION, POLICY_VERSION);
  assert.deepEqual([...policy.PYTHON_ALLOWED_MODULES], [...PYTHON_ALLOWED_MODULES]);
});

test('host calls other than input.next are refused by the parent', { skip: skipJs }, async () => {
  // A test-only prelude edit keeps a reference to the host function the
  // real prelude deletes, so the code can try another service.
  const t = tap(start => Object.assign({}, start, { preludeSource: 'globalThis.__probe_call = globalThis.__host_call;\n' + start.preludeSource }));
  const out = await sandbox({}, { spawnChild: t.spawnChild }).run({ language: 'javascript', records: records(1), variable: VARIABLE, code: `
    let answer = 'pending';
    __probe_call('fetch', JSON.stringify({ url: 'https://example.com/' })).then(v => { answer = 'ANSWERED ' + v; }, e => { answer = e.type + ' | ' + e.message; });
    function classify() { return { code: null, reason: answer }; }` });
  assert.equal(out.ok, true, JSON.stringify(out.failure));
  assert.equal(out.outputs[0].out.reason, 'not_available | Coding rules have no host services (no network, files or programs).');
  assert.deepEqual(t.seen.calls.map(c => c.name), ['fetch', 'input.next']);
});

test('an infinite loop is stopped at the time limit and the process is gone', { skip: skipJs }, async () => {
  const sb = sandbox({ timeoutMs: 1000 });
  const c = collector();
  const t0 = Date.now();
  const out = await sb.run({ language: 'javascript', code: 'function classify(r) { while (true) {} }', records: records(5), variable: VARIABLE }, c.hooks);
  assert.equal(out.ok, false);
  assert.equal(out.failure.type, 'timeout');
  assert.match(out.failure.message, /1-second limit/);
  assert.ok(Date.now() - t0 < 6000);
  assert.ok(c.pid && gone(c.pid), 'the sandbox process is still running');
  assert.equal(sb.stats().running, 0);
});

test('memory bombs end with memory_limit and the process is gone', { skip: skipJs }, async () => {
  const sb = sandbox({ memoryMb: 16, timeoutMs: 15000 });
  for (const code of [
    'function classify(r) { const a = []; while (true) a.push({ r, s: "v" + a.length }); }',          // QuickJS's own limit
    'const keep = []; function classify(r) { while (true) keep.push(new Array(100000).fill(1)); }'     // the parent's memory watch
  ]) {
    const c = collector();
    const out = await sb.run({ language: 'javascript', code, records: records(3), variable: VARIABLE }, c.hooks);
    assert.equal(out.ok, false);
    assert.equal(out.failure.type, 'memory_limit', code + ' → ' + JSON.stringify(out.failure));
    assert.ok(c.pid && gone(c.pid));
  }
});

test('results over the output limit stop the run (output_too_large)', { skip: skipJs }, async () => {
  const c = collector();
  const out = await sandbox({ maxOutputKb: 256 }).run({ language: 'javascript', records: records(120), variable: VARIABLE,
    code: 'function classify(r) { return { code: "pos", reason: "x".repeat(30000) }; }' }, c.hooks);
  assert.equal(out.ok, false);
  assert.equal(out.failure.type, 'output_too_large');
  assert.ok(out.resources.outputBytes > 256 * 1024);
  assert.ok(out.outputs.length < 120);
  assert.ok(gone(c.pid));
});

test('cancellation kills the sandbox; a run cancelled before it starts never spawns', { skip: skipJs }, async () => {
  const sb = sandbox({ timeoutMs: 20000 });
  const ac = new AbortController();
  const c = collector();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 400);
  const out = await sb.run({ language: 'javascript', code: 'function classify(r) { while (true) {} }', records: records(5), variable: VARIABLE }, Object.assign({ signal: ac.signal }, c.hooks));
  assert.equal(out.failure.type, 'cancelled');
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(c.pid && gone(c.pid));
  const early = collector();
  const before = await sb.run({ language: 'javascript', code: 'function classify() {}', records: records(1), variable: VARIABLE }, Object.assign({ signal: AbortSignal.abort() }, early.hooks));
  assert.equal(before.failure.type, 'cancelled');
  assert.equal(early.pid, null);
});

test('isolation report says what is in effect', { skip: skipJs }, async () => {
  const probe = await probeIsolation();
  const auto = await sandbox().isolation('javascript');
  for (const key of ['engine', 'process', 'network', 'filesystem', 'environment', 'limits']) assert.equal(typeof auto[key], 'string', key);
  assert.equal(auto.engine, 'QuickJS (WebAssembly) — no I/O APIs');
  assert.equal(auto.environment, 'empty — no secrets');
  assert.equal(auto.filesystem, 'no host files (engine files read-only)');
  assert.match(auto.process, /Node permission model/);
  assert.match(auto.limits, /^time 4 s, memory 64 MB, output 8 MB/);
  assert.equal(auto.networkNamespace, probe.available);
  if (probe.available) {
    assert.equal(auto.network, 'none — separate network namespace');
    if (probe.prlimit) assert.match(auto.limits, /CPU 14 s \(prlimit\)$/);
  }
  const plain = await sandbox({ isolation: 'process' }).isolation('python');
  assert.equal(plain.networkNamespace, false);
  assert.equal(plain.network, 'not isolated by the OS; the engine has no network APIs');
  assert.match(plain.engine, /^Pyodide \S+ \(CPython in WebAssembly\) — network modules blocked$/);
  assert.match(plain.limits, /^time 4 s after start-up, memory 256 MB, output 8 MB$/);
  const run = await sandbox({ isolation: 'process' }).run({ language: 'javascript', code: 'function classify() { return "pos"; }', records: records(2), variable: VARIABLE });
  assert.equal(run.ok, true);
  assert.deepEqual(run.isolation, await sandbox({ isolation: 'process' }).isolation('javascript'));
});

test('namespace isolation: the sandbox child has no network (when the host supports it)', { skip: skipJs }, async t => {
  const probe = await probeIsolation();
  if (!probe.available) return t.skip('no network namespace on this host: ' + probe.reason);
  // 1. A process started with the same wrapper can't reach a server on this machine, nor the internet.
  let connections = 0;
  const server = net.createServer(sock => { connections++; sock.destroy(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const script = 'const net=require("net");const tryc=(h,p)=>new Promise(r=>{const s=net.connect({host:h,port:p});s.on("connect",()=>{s.destroy();r("connected")});s.on("error",e=>r(e.code));setTimeout(()=>r("timeout"),3000)});' +
    '(async()=>{process.send({local:await tryc("127.0.0.1",' + port + '),remote:await tryc("1.1.1.1",80)},()=>process.exit(0))})()';
  const { command, args } = isolatedCommand(probe, 5, ['-e', script]);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
    child.on('message', resolve);
    child.on('error', reject);
  });
  server.close();
  assert.equal(connections, 0);
  assert.ok(['ENETUNREACH', 'EACCES', 'EPERM'].includes(result.local), JSON.stringify(result));
  assert.ok(['ENETUNREACH', 'EACCES', 'EPERM'].includes(result.remote), JSON.stringify(result));
  // 2. A real run's child is in another network namespace than this process.
  const c = collector();
  let childNs = null;
  c.hooks.onLog = () => { try { childNs = fs.readlinkSync('/proc/' + c.pid + '/ns/net'); } catch (e) { childNs = 'unreadable ' + e.code; } };
  const out = await sandbox().run({ language: 'javascript', code: 'console.log("up");\nfunction classify() { return "pos"; }', records: records(1), variable: VARIABLE }, c.hooks);
  assert.equal(out.ok, true);
  assert.equal(out.isolation.networkNamespace, true);
  assert.match(String(childNs), /^net:\[\d+\]$/);
  assert.notEqual(childNs, fs.readlinkSync('/proc/self/ns/net'));
});

/* ── Python ─────────────────────────────────────────────────────── */

test('Python: classify over > 100 records; print → stdout, warnings → stderr; errors per record', { skip: skipPy }, async () => {
  const c = collector();
  const input = records(150, 4000);
  const out = await sandbox({ timeoutMs: 10000 }).run({ language: 'python', variable: VARIABLE, records: input, code: [
    'import re',
    'from collections import Counter',
    'PATTERN = re.compile("\\w+")          # an invalid escape: Python warns on stderr',
    'print("loaded", len(Counter("aab")))',
    '',
    'def classify(record, variable):',
    '    if record["id"] == "r1":',
    '        print("text", len(record["text"]))',
    '    if record["id"] == "r3":',
    '        raise ValueError("boom")',
    '    if record["id"] == "r4":',
    '        return {"code": None, "reason": ",".join(sorted(record)) + "|" + str(len(variable["codes"]))}',
    '    if record["id"] == "r5":',
    '        return {"code": "pos", "tags": {"a"}}',
    '    if record["id"] == "r6":',
    '        raise MemoryError()',
    '    record["text"] = "changed"   # a fresh copy each time',
    '    variable["codes"].clear()',
    '    return "pos" if PATTERN.match("good") and int(record["id"][1:]) % 2 else {"code": "neg", "confidence": 0.5, "reason": "default"}',
    ''
  ].join('\n') }, c.hooks);
  assert.equal(out.ok, true, JSON.stringify(out.failure));
  assert.equal(out.outputs.length, 150);
  assert.deepEqual(out.outputs.map(o => o.id), input.map(r => r.id));
  assert.deepEqual(out.outputs[0].out, { code: 'neg', confidence: 0.5, reason: 'default' });
  assert.equal(out.outputs[7].out, 'pos');
  assert.match(out.outputs[3].error, /^ValueError: boom\n {2}File "rule\.py", line 10, in classify/);
  assert.equal(out.outputs[4].out.reason, 'author,id,meta,text,timestamp|2');
  assert.match(out.outputs[5].error, /isn't JSON/);
  assert.match(out.outputs[6].error, /^MemoryError/);
  assert.deepEqual(out.policy, []);
  assert.deepEqual(c.policy, []);
  const stdout = c.logs.filter(l => l.stream === 'stdout').map(l => l.text);
  assert.deepEqual(stdout, ['loaded 2', 'text 4005']);
  assert.ok(c.logs.some(l => l.stream === 'stderr' && l.level === 'warn' && /SyntaxWarning/.test(l.text)), JSON.stringify(c.logs));
  assert.deepEqual(c.progress.at(-1), { done: 150, total: 150 });
  assert.equal(out.engine.name, 'Pyodide');
  assert.ok(out.bootMs > 0 && out.resources.engineMemoryBytes > 0);
});

test('Python policy (analyze mode): network, programs, files, escapes, dynamic code — nothing executes', { skip: skipPy }, async () => {
  const c = collector();
  const out = await sandbox({ timeoutMs: 10000 }).run({ language: 'python', mode: 'analyze', variable: VARIABLE, code: [
    'import os',
    'import requests, socket',
    'import random',
    'print("this must not run")',
    'def classify(record, variable):',
    '    os.system("id")',
    '    data = open("/etc/passwd").read()',
    '    subclasses = ().__class__.__base__.__subclasses__()',
    '    mod = __import__("os")',
    '    value = eval("1 + 1")',
    '    while True:',
    '        socket.create_connection(("example.com", 80))',
    ''
  ].join('\n') }, c.hooks);
  assert.equal(out.ok, true, JSON.stringify(out.failure));
  assert.deepEqual(out.outputs, []);
  assert.deepEqual(c.logs, []);
  const has = (rule, line, re) => out.policy.some(f => f.rule === rule && f.line === line && f.severity === 'error' && (!re || re.test(f.message)));
  assert.ok(has('forbidden_import', 1, /no files or programs/), JSON.stringify(out.policy));
  assert.ok(has('forbidden_import', 2, /'requests'.*no network/));
  assert.ok(has('forbidden_import', 2, /'socket'.*no network/));
  assert.ok(out.policy.some(f => f.rule === 'nondeterministic' && f.line === 3 && f.severity === 'warning'));
  assert.ok(has('forbidden_call', 7, /open\(\)/));
  assert.ok(has('forbidden_attribute', 8, /__subclasses__/));
  assert.ok(has('forbidden_call', 9, /__import__/));
  assert.ok(has('forbidden_call', 10, /eval\(\)/));
  assert.ok(has('infinite_loop', 11));
  assert.equal(out.policy.find(f => f.line === 7).excerpt, 'data = open("/etc/passwd").read()');
  assert.deepEqual(c.policy, out.policy);
});

test('Python policy blocks a network-flooding rule before any of it runs', { skip: skipPy }, async () => {
  const c = collector();
  const out = await sandbox({ timeoutMs: 10000 }).run({ language: 'python', variable: VARIABLE, records: records(3), code: [
    'import requests',
    'import socket',
    'print("starting the flood")',
    'def classify(record, variable):',
    '    while True:',
    '        requests.get("https://example.com/")',
    '        socket.socket().connect(("example.com", 80))',
    ''
  ].join('\n') }, c.hooks);
  assert.equal(out.ok, false);
  assert.equal(out.failure.type, 'policy_blocked');
  assert.match(out.failure.message, /'requests' isn't available: there is no network in the sandbox.*\(line 1\)/);
  assert.deepEqual(out.outputs, []);
  assert.deepEqual(c.logs, []);
  assert.deepEqual(out.policy.map(f => f.rule + ':' + f.line), ['forbidden_import:1', 'forbidden_import:2', 'infinite_loop:5']);
});

test('Python runtime guards hold without the static policy (test-only prelude edit)', { skip: skipPy }, async () => {
  const t = tap(start => {
    assert.ok(start.preludeSource.includes('_ENFORCE_POLICY = True'));
    return Object.assign({}, start, { preludeSource: start.preludeSource.replace('_ENFORCE_POLICY = True', '_ENFORCE_POLICY = False') });
  });
  const probes = {
    import_os: 'import os',
    dunder_import: '__import__("os")',
    builtins_import: '__builtins__["__import__"]("importlib")',
    import_socket: 'import socket',
    open_file: 'open("/etc/passwd").read()',
    eval_code: 'eval("1 + 1")',
    exec_code: 'exec("x = 1")',
    os_via_random: 'import random\n        random._os.system("id")',
    subclasses_os: 'w = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == "_wrap_close"][0]\n        w.__init__.__globals__["system"]("id")',
    subclasses_socket: 'imp = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == "BuiltinImporter"][0]\n        sock = imp.load_module("_socket")\n        s = sock.socket()\n        s.settimeout(2)\n        s.connect(("1.1.1.1", 80))',
    js_bridge: 'imp = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == "BuiltinImporter"][0]\n        imp.load_module("sys").modules["js"].process.exit(1)'
  };
  const code = ['PROBES = {}'];
  for (const [name, body] of Object.entries(probes)) code.push('def probe_' + name + '():', '        ' + body, 'PROBES["' + name + '"] = probe_' + name);
  code.push('def classify(record, variable):', '    try:', '        PROBES[record["id"]]()', '        return {"code": None, "reason": "OPEN"}',
    '    except BaseException as e:', '        return {"code": None, "reason": type(e).__name__ + ": " + str(e)[:200]}', '');
  const input = Object.keys(probes).map(id => ({ id, text: '', author: '', timestamp: '', meta: {} }));
  const out = await sandbox({ timeoutMs: 15000 }, { spawnChild: t.spawnChild }).run({ language: 'python', variable: VARIABLE, records: input, code: code.join('\n') });
  assert.equal(out.ok, true, JSON.stringify(out.failure));
  assert.ok(out.policy.some(f => f.severity === 'error'), 'the analyzer still reports');
  const reasons = Object.fromEntries(out.outputs.map(o => [o.id, o.out ? o.out.reason : o.error]));
  for (const name of Object.keys(probes)) assert.ok(!/^OPEN/.test(reasons[name]), name + ': ' + reasons[name]);
  assert.match(reasons.import_os, /^ImportError: Module 'os' isn't available in the MetaCode sandbox/);
  assert.match(reasons.dunder_import, /^ImportError: Module 'os' isn't available/);
  assert.match(reasons.builtins_import, /^ImportError: Module 'importlib' isn't available/);
  assert.match(reasons.open_file, /^NameError/);
  assert.match(reasons.eval_code, /^NameError/);
  assert.match(reasons.os_via_random, /^PermissionError: Running programs isn't available/);
  assert.match(reasons.subclasses_os, /^PermissionError: Running programs isn't available/);
});

test('Python: a busy loop the policy can\'t see is stopped at the time limit (counted after start-up)', { skip: skipPy }, async () => {
  const c = collector();
  const t0 = Date.now();
  const out = await sandbox({ timeoutMs: 1000 }).run({ language: 'python', variable: VARIABLE, records: records(2),
    code: 'def classify(record, variable):\n    n = 0\n    while n >= 0:\n        n += 1\n' }, c.hooks);
  assert.equal(out.failure.type, 'timeout');
  assert.ok(out.bootMs > 0 && out.durationMs >= 900 && out.durationMs < 4000, out.bootMs + ' / ' + out.durationMs);
  assert.ok(Date.now() - t0 < 30000);
  assert.ok(c.pid && gone(c.pid));
});

/* ── The parent's own caps, against a child that misbehaves ─────── */

// A stand-in for the child process: `script(child, start)` plays the child's part.
class FakeChild extends EventEmitter {
  constructor(script) {
    super();
    this.script = script;
    this.exitCode = null;
    this.signalCode = null;
    this.connected = true;
    this.stderr = new EventEmitter();
    this.sent = [];
  }
  send(msg) {
    this.sent.push(msg);
    if (msg.type === 'start') setImmediate(() => this.script(this, msg));
    return true;
  }
  kill(sig) {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = sig;
    this.connected = false;
    setImmediate(() => this.emit('exit', null, sig));
    return true;
  }
  msg(m) { this.emit('message', m); }
  exit(code, stderr) {
    if (stderr) this.stderr.emit('data', Buffer.from(stderr));
    this.exitCode = code;
    this.connected = false;
    this.emit('exit', code, null);
  }
}
const fake = (script, execution) => {
  const children = [];
  const sb = sandbox(Object.assign({ isolation: 'process' }, execution), { spawnChild: () => { const ch = new FakeChild(script); children.push(ch); return ch; } });
  return { sb, children };
};
const run = (sb, extra, hooks) => sb.run(Object.assign({ language: 'javascript', code: 'function classify() {}', records: records(3), variable: VARIABLE }, extra || {}), hooks);

test('parent caps: duplicate results, too many results, oversized final message', { skip: skipJs }, async () => {
  let r = await run(fake(ch => ch.msg({ type: 'emit', records: [{ id: 'r0', out: 'pos' }, { id: 'r0', out: 'neg' }] })).sb);
  assert.equal(r.failure.type, 'contract_error');
  assert.match(r.failure.message, /two results for record “r0”/);
  r = await run(fake(ch => ch.msg({ type: 'emit', records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] })).sb);
  assert.match(r.failure.message, /more results than there are records/);
  r = await run(fake(ch => ch.msg({ type: 'emit', records: [{ out: 'pos' }] })).sb);
  assert.match(r.failure.message, /without a record id/);
  r = await run(fake(ch => ch.msg({ type: 'done', result: { pad: 'x'.repeat(70000) } })).sb);
  assert.match(r.failure.message, /final message was too large/);
  const ok = await run(fake(ch => {
    ch.msg({ type: 'emit', records: [{ id: 'r0', out: { code: 'pos' }, ms: 1, extra: 'dropped' }, { id: 'r1', error: 'E: x' }] });
    ch.msg({ type: 'done', result: { processed: 2 }, stats: { rssBytes: 123, engineMemoryBytes: 'lots' } });
  }).sb);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.outputs, [{ id: 'r0', out: { code: 'pos' }, ms: 1 }, { id: 'r1', error: 'E: x' }]);
  assert.deepEqual([ok.resources.rssBytes, ok.resources.engineMemoryBytes], [123, null]);
});

test('parent caps: host calls, record batches, progress rate, log lines', { skip: skipJs }, async () => {
  const { sb, children } = fake(ch => {
    ch.msg({ type: 'call', id: 1, name: 'fetch', args: '{}' });
    ch.msg({ type: 'call', id: 2, name: 'input.next', args: '{}' });
    ch.msg({ type: 'call', id: 3, name: 'input.next', args: '{}' });
    ch.msg({ type: 'call', id: 4, name: 'input.next', args: '{}' });
    for (let i = 0; i < 100; i++) ch.msg({ type: 'progress', patch: { done: i, total: 250 } });
    for (let i = 0; i < 2100; i++) ch.msg({ type: 'log', level: i % 2 ? 'warn' : 'info', message: 'line ' + i + '\u0007' });
    ch.msg({ type: 'done', result: {} });
  });
  const c = collector();
  const r = await run(sb, { records: records(250) }, c.hooks);
  assert.equal(r.ok, true);
  const replies = children[0].sent.filter(m => m.type === 'reply');
  assert.deepEqual(replies[0], { type: 'reply', id: 1, ok: false, error: { name: 'SandboxError', type: 'not_available', message: 'Coding rules have no host services (no network, files or programs).' } });
  const batches = replies.slice(1).map(m => JSON.parse(m.value));
  assert.deepEqual(batches.map(b => b.records.length), [100, 100, 50]);
  assert.deepEqual(batches.map(b => b.done), [false, false, true]);
  assert.deepEqual(Object.keys(batches[0].records[0]).sort(), ['author', 'id', 'meta', 'text', 'timestamp']);
  // 20 a second; the latest dropped count is delivered when the run ends.
  assert.ok(c.progress.length <= 21, c.progress.length + ' progress callbacks');
  assert.deepEqual(c.progress.at(-1), { done: 99, total: 250 });
  assert.equal(c.logs.length, 2001);
  assert.deepEqual(c.logs[1], { stream: 'stderr', level: 'warn', text: 'line 1' });
  assert.match(c.logs[2000].text, /^Log limit reached/);
  const flood = await run(fake(ch => { for (let i = 1; i <= 60; i++) ch.msg({ type: 'call', id: i, name: 'nope', args: '{}' }); }).sb);
  assert.equal(flood.failure.type, 'contract_error');
});

test('parent: child errors and exits are classified', { skip: skipJs }, async () => {
  const cases = [
    [ch => ch.msg({ type: 'error', error: { type: 'custom_code_timeout', message: 'x' } }), 'timeout'],
    [ch => ch.msg({ type: 'error', error: { type: 'custom_code_memory', message: 'x' } }), 'memory_limit'],
    [ch => ch.msg({ type: 'error', error: { type: 'custom_code_error', message: 'Your coding rule threw an error: ReferenceError: y' } }), 'runtime_error'],
    [ch => ch.msg({ type: 'error', error: { type: 'not_available', message: 'x' } }), 'blocked_operation'],
    [ch => ch.exit(1, 'Error: "net" is not available in the MetaCode sandbox'), 'blocked_operation'],
    [ch => ch.exit(134, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'), 'memory_limit'],
    [ch => ch.exit(1, 'something else'), 'sandbox_error']
  ];
  for (const [script, type] of cases) {
    const r = await run(fake(script).sb);
    assert.equal(r.failure.type, type, JSON.stringify(r.failure));
  }
});

test('parent: only the Python analyzer\'s first report counts, and a Python run without one is discarded', { skip: skipPy }, async () => {
  const finding = { rule: 'forbidden_import', severity: 'error', message: 'no', line: 1, column: 1, excerpt: 'import os', extra: 'dropped' };
  const c = collector();
  const r = await run(fake(ch => {
    ch.msg({ type: 'started' });
    ch.msg({ type: 'progress', patch: { policy: [finding] } });
    ch.msg({ type: 'progress', patch: { policy: [] } });
    ch.msg({ type: 'error', error: { type: 'policy_blocked', message: 'no (line 1)' } });
  }).sb, { language: 'python' }, c.hooks);
  assert.equal(r.failure.type, 'policy_blocked');
  assert.deepEqual(r.policy, [{ rule: 'forbidden_import', severity: 'error', message: 'no', line: 1, column: 1, excerpt: 'import os' }]);
  assert.deepEqual(c.policy, r.policy);
  const silent = await run(fake(ch => { ch.msg({ type: 'started' }); ch.msg({ type: 'done', result: { emitted: 0 } }); }).sb, { language: 'python' });
  assert.equal(silent.failure.type, 'sandbox_error');
});

test('server-wide cap: runs beyond maxRunning wait for a free slot', { skip: skipJs }, async () => {
  let live = 0;
  let most = 0;
  const { sb, children } = fake(ch => {
    live++;
    most = Math.max(most, live);
    setTimeout(() => { live--; ch.msg({ type: 'done', result: {} }); }, 50);
  }, { maxRunning: 1 });
  const runs = [run(sb), run(sb), run(sb)];
  await new Promise(r => setImmediate(r));
  assert.deepEqual(sb.stats(), { running: 1, waiting: 2 });
  const results = await Promise.all(runs);
  assert.ok(results.every(r => r.ok));
  assert.equal(most, 1);
  assert.equal(children.length, 3);
  assert.deepEqual(sb.stats(), { running: 0, waiting: 0 });
});
