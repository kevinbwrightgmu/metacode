// MetaCode starting its OpenCode service itself (opencode/supervisor.js):
// started when nothing answers at the address, left alone when something
// does (with a problem when that isn't this copy's service), started again
// with a growing pause after it stops, a readable reason when it stops, and
// stopped with MetaCode. The service here is a tiny stand-in script that
// answers GET /health, not the real opencode/server.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSupervisor, checkHealth, describeExit, PACKAGES_MISSING } = require('../opencode/supervisor');
const { homeId, serviceSettings } = require('../opencode/shared');

const TOKEN = 'supervisor-test-token-0123456789';
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
let tmp;

// A stand-in service: GET /health on OPENCODE_SERVICE_HOST:PORT. `before` runs first (crash, ignore SIGTERM…).
function fakeService(name, before) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `
const http = require('http');
const fs = require('fs');
const path = require('path');
${before || ''}
const token = process.env.OPENCODE_SERVICE_TOKEN || '';
console.log('fake service starting with token ' + token);
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, service: 'metacode-opencode', pid: process.pid,
    tokenHash: require('crypto').createHash('sha256').update(token).digest('hex') }));
  res.statusCode = 404; res.end('{"error":{"type":"not_found"}}');
});
server.listen(Number(process.env.OPENCODE_SERVICE_PORT), process.env.OPENCODE_SERVICE_HOST);
if (!process.listenerCount('SIGTERM')) process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  return file;
}

function quietLog() {
  const lines = [];
  const add = (...a) => lines.push(a.join(' '));
  return { lines, log: add, warn: add, error: add };
}

async function freePort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
async function until(fn, ms, what) {
  const deadline = Date.now() + (ms || 10000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + (what || 'a condition'));
    await new Promise(r => setTimeout(r, 25));
  }
}
const health = port => new Promise(resolve => {
  http.get('http://127.0.0.1:' + port + '/health', res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b))); }).on('error', () => resolve(null));
});

test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-supervisor-')); });
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('nothing answers at the default address: the service is started, gets the token, and is stopped again', async () => {
  const port = await freePort();
  const out = quietLog();
  const exitListeners = process.listenerCount('exit');
  const sup = createSupervisor({ script: fakeService('ok.js'), log: out });
  const st = await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  assert.equal(st.managed, true);
  assert.equal(st.running, true);
  assert.equal(st.starting, true);
  assert.ok(st.pid > 0);
  assert.equal(await sup.whenReady(10000), true);
  const h = await health(port);
  assert.equal(h.service, 'metacode-opencode');
  assert.equal(h.pid, st.pid);
  assert.equal(h.tokenHash, sha(TOKEN), 'the child got MetaCode\'s token in OPENCODE_SERVICE_TOKEN');
  assert.deepEqual([sup.state().ready, sup.state().starting, sup.state().problem], [true, false, null]);
  await until(() => out.lines.some(l => l.startsWith('[opencode] fake service starting')), 5000, 'the child\'s log line');
  assert.ok(out.lines.some(l => l.startsWith('[opencode] ')), 'its output is prefixed');
  assert.ok(!out.lines.join('\n').includes(TOKEN), 'the token never reaches the log');
  assert.equal(process.listenerCount('exit'), exitListeners + 1, 'a child is killed if MetaCode exits without closing');
  await sup.stop();
  assert.equal(alive(st.pid), false, 'stopped with MetaCode');
  assert.equal(process.listenerCount('exit'), exitListeners);
  assert.equal(sup.state().running, false);
  assert.equal(await checkHealth('http://127.0.0.1:' + port, 500).then(x => x.answered), false);
});

test('something already answers, a custom address, or managing off: no child is started', async () => {
  const port = await freePort();
  const other = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, service: 'metacode-opencode', pid: 1 })); });
  await new Promise(r => other.listen(port, '127.0.0.1', r));
  try {
    const script = fakeService('never.js', 'fs.writeFileSync(path.join(__dirname, "never-started"), "1");');
    const sup = createSupervisor({ script, log: quietLog() });
    let st = await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
    assert.deepEqual([st.managed, st.external, st.running, st.pid], [false, true, false, null], 'pm2 (or an earlier MetaCode) runs it already');
    st = await sup.start({ mode: 'on', url: 'http://127.0.0.1:' + port + '/v1', custom: true, token: TOKEN });
    assert.deepEqual([st.managed, st.external], [false, true], '"on" doesn\'t start a second copy either');
    const free = await freePort();
    st = await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + free + '/v1', custom: true, token: TOKEN });
    assert.deepEqual([st.managed, st.external, st.running], [false, false, false], 'auto: only for the default address');
    st = await sup.start({ mode: 'off', url: 'http://127.0.0.1:' + free + '/v1', custom: false, token: TOKEN });
    assert.deepEqual([st.mode, st.managed, st.running], ['off', false, false]);
    st = await sup.start({ mode: 'on', url: 'http://192.0.2.10:' + free + '/v1', custom: true, token: TOKEN });
    assert.deepEqual([st.managed, st.running], [false, false], 'never for an address on another machine');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(tmp, 'never-started')), false);
    await sup.stop();
  } finally {
    await new Promise(r => other.close(r));
  }
});

test('"on" starts it at a custom address on this machine', async () => {
  const port = await freePort();
  const sup = createSupervisor({ script: fakeService('ok-on.js'), log: quietLog() });
  const st = await sup.start({ mode: 'on', url: 'http://localhost:' + port + '/v1', custom: true, token: TOKEN });
  assert.equal(st.managed, true);
  assert.equal(await sup.whenReady(10000), true);
  assert.equal((await health(port)).pid, st.pid);
  await sup.stop();
  assert.equal(alive(st.pid), false);
});

test('a service that stops is started again, waiting longer after each exit', async () => {
  const port = await freePort();
  const starts = path.join(tmp, 'crash-starts.log');
  const script = fakeService('crashes.js', `
fs.appendFileSync(${JSON.stringify(starts)}, Date.now() + '\\n');
const n = fs.readFileSync(${JSON.stringify(starts)}, 'utf8').trim().split('\\n').length;
if (n <= 3) { console.error('Error: fake failure number ' + n); process.exit(3); }`);
  const out = quietLog();
  const sup = createSupervisor({ script, log: out, minBackoffMs: 150, maxBackoffMs: 400 });
  await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  await until(async () => sup.state().ready, 15000, 'the fourth start to answer');
  const st = sup.state();
  assert.equal(st.restarts, 3);
  assert.deepEqual([st.lastExit.code, st.problem], [3, null], 'the last exit is remembered; the problem clears once it answers');
  const times = fs.readFileSync(starts, 'utf8').trim().split('\n').map(Number);
  assert.equal(times.length, 4);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.ok(gaps[0] >= 150, 'first pause ≥ 150 ms: ' + gaps);
  assert.ok(gaps[1] >= 300, 'then doubled: ' + gaps);
  assert.ok(gaps[2] >= 400 && gaps[2] < 400 + 3000, 'then capped at the maximum: ' + gaps);
  assert.ok(out.lines.some(l => /stopped unexpectedly \(exit code 3\): Error: fake failure number 1\. Starting it again in 150 ms/.test(l)), out.lines.join('\n'));
  await sup.stop();
  assert.equal(alive(st.pid), false);
});

test('missing packages: the problem says to run npm install, and it keeps trying', async () => {
  const port = await freePort();
  const script = path.join(tmp, 'needs-packages.mjs');
  fs.writeFileSync(script, 'import "@opencode/package-that-is-not-installed";\n');
  const out = quietLog();
  const sup = createSupervisor({ script, log: out, minBackoffMs: 100, maxBackoffMs: 200 });
  await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  await until(() => sup.state().problem, 10000, 'the problem');
  const st = sup.state();
  assert.equal(st.problem, PACKAGES_MISSING);
  assert.equal(st.problem, 'The AI service couldn\'t start: its packages aren\'t installed. Run "npm install" and restart MetaCode.');
  assert.deepEqual([st.managed, st.ready, st.starting], [true, false, true]);
  assert.ok(out.lines.some(l => /^\[opencode\] .*ERR_MODULE_NOT_FOUND/.test(l)), 'the child\'s own error is in the log');
  await until(() => sup.state().restarts >= 1, 5000, 'a second try');
  await sup.stop();
  const after = sup.state().restarts;
  await new Promise(r => setTimeout(r, 400));
  assert.equal(sup.state().restarts, after, 'no more tries after stop()');
});

test('a missing service file is named as such', async () => {
  const port = await freePort();
  const sup = createSupervisor({ script: path.join(__dirname, '..', 'opencode', 'no-such-service.mjs'), log: quietLog(), minBackoffMs: 5000 });
  await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  await until(() => sup.state().problem, 10000, 'the problem');
  assert.equal(sup.state().problem, 'The AI service couldn\'t start: opencode/no-such-service.mjs is missing. Update MetaCode (git pull) and restart it.');
  await sup.stop();
});

test('stop: SIGTERM, then SIGKILL for a service that doesn\'t exit', async () => {
  const port = await freePort();
  const script = fakeService('stubborn.js', 'process.on("SIGTERM", () => console.log("not stopping"));');
  const sup = createSupervisor({ script, log: quietLog(), killAfterMs: 300 });
  const st = await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  assert.equal(await sup.whenReady(10000), true);
  const t0 = Date.now();
  await sup.stop();
  assert.ok(Date.now() - t0 >= 250, 'it waited for the grace period');
  assert.equal(alive(st.pid), false);
  assert.equal(sup.state().managed, false);
});

test('stop() twice (server.close, then the shutdown handler): the second waits for the kill in progress too', async t => {
  const port = await freePort();
  const script = fakeService('stubborn-twice.js', 'process.on("SIGTERM", () => console.log("not stopping"));');
  const sup = createSupervisor({ script, log: quietLog(), killAfterMs: 600 });
  t.after(() => sup.stop());   // also when an assertion fails
  const st = await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  assert.equal(await sup.whenReady(10000), true);
  const t0 = Date.now();
  const first = sup.stop();
  await sup.stop();
  assert.ok(Date.now() - t0 >= 500, 'the second stop() waited for the SIGKILL: ' + (Date.now() - t0) + ' ms');
  assert.equal(alive(st.pid), false, 'nothing is left behind when MetaCode exits right after');
  await first;
});

test('a service that answers only after readyTimeoutMs: the problem is reported, then cleared once it answers', async t => {
  const port = await freePort();
  // listens 1.5 s after it starts (a slow machine at boot)
  const script = fakeService('slow-start.js', `
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...a) { setTimeout(() => listen.apply(this, a), 1500); return this; };`);
  const readyCalls = [];
  const sup = createSupervisor({ script, log: quietLog(), readyTimeoutMs: 300, onReady: s => readyCalls.push(s) });
  t.after(() => sup.stop());
  await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  assert.equal(await sup.whenReady(5000), false, 'waiters still hear about the deadline');
  assert.match(sup.state().problem, /started but hasn't answered/);
  await until(() => sup.state().ready, 8000, 'the late answer to be noticed');
  assert.deepEqual([sup.state().ready, sup.state().starting, sup.state().problem], [true, false, null]);
  assert.equal(readyCalls.length, 1);
  assert.equal(await sup.whenReady(100), true);
  await sup.stop();
});

test('a program that isn\'t the service answers at the address: no child, and the problem names the port setting', async t => {
  const port = await freePort();
  const other = http.createServer((req, res) => { res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('<h1>Not found</h1>'); });
  await new Promise(r => other.listen(port, '127.0.0.1', r));
  try {
    const script = fakeService('never-foreign.js', 'fs.writeFileSync(path.join(__dirname, "never-started-foreign"), "1");');
    const out = quietLog();
    const sup = createSupervisor({ script, log: out });
    t.after(() => sup.stop());
    const st = await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
    const problem = 'Another program, not MetaCode\'s AI service, answers at 127.0.0.1:' + port + '. Set OPENCODE_SERVICE_PORT in .env to a free port and restart MetaCode.';
    assert.deepEqual([st.managed, st.external, st.running, st.problem], [false, true, false, problem]);
    assert.ok(out.lines.includes('[opencode] ' + problem), out.lines.join('\n'));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(tmp, 'never-started-foreign')), false);
    await sup.stop();
  } finally {
    await new Promise(r => other.close(r));
  }
});

test('the service of another MetaCode folder answers at the address: not used as this copy\'s, and the problem says to pick a port', async t => {
  const port = await freePort();
  const dataDir = path.join(tmp, 'home-a');
  let home = 'feedfacefeedface';
  const other = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Object.assign({ ok: true, service: 'metacode-opencode', pid: 1 }, home ? { home } : {})));
  });
  await new Promise(r => other.listen(port, '127.0.0.1', r));
  try {
    const script = fakeService('never-home.js', 'fs.writeFileSync(path.join(__dirname, "never-started-home"), "1");');
    const out = quietLog();
    const sup = createSupervisor({ script, log: out });
    t.after(() => sup.stop());
    const url = 'http://127.0.0.1:' + port + '/v1';
    let st = await sup.start({ mode: 'auto', url, custom: false, token: TOKEN, dataDir });
    const problem = 'Another MetaCode\'s AI service (from a different folder) is using port ' + port + '. Set OPENCODE_SERVICE_PORT in .env to a free port and restart MetaCode.';
    assert.deepEqual([st.managed, st.external, st.running, st.problem], [false, true, false, problem], 'kept external: no second copy');
    assert.ok(out.lines.includes('[opencode] ' + problem), out.lines.join('\n'));

    home = homeId(dataDir);
    st = await sup.start({ mode: 'auto', url, custom: false, token: TOKEN, dataDir });
    assert.deepEqual([st.managed, st.external, st.problem], [false, true, null], 'its own folder: used as before');
    home = homeId(serviceSettings(process.env).dataDir);
    st = await sup.start({ mode: 'auto', url, custom: false, token: TOKEN });
    assert.deepEqual([st.external, st.problem], [true, null], 'without dataDir: the folder from OPENCODE_SERVICE_DATA_DIR, as the service reads it');
    home = null;
    st = await sup.start({ mode: 'auto', url, custom: false, token: TOKEN, dataDir });
    assert.deepEqual([st.managed, st.external, st.problem], [false, true, null], 'an older service without "home": accepted as before');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(tmp, 'never-started-home')), false);
    await sup.stop();
  } finally {
    await new Promise(r => other.close(r));
  }
});

test('another folder\'s service takes the port while this one is being restarted: not used as this copy\'s either', async t => {
  const port = await freePort();
  const script = fakeService('exits-once.js', 'console.error("Error: fake failure"); process.exit(3);');
  const out = quietLog();
  const sup = createSupervisor({ script, log: out, minBackoffMs: 500 });
  t.after(() => sup.stop());
  const other = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, service: 'metacode-opencode', pid: 1, home: 'feedfacefeedface' })); });
  t.after(() => new Promise(r => other.close(r)));
  await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN, dataDir: path.join(tmp, 'home-b') });
  await new Promise(r => other.listen(port, '127.0.0.1', r));
  await until(() => sup.state().external, 5000, 'the restart to find the other service');
  const st = sup.state();
  assert.deepEqual([st.managed, st.external, st.running, st.restarts], [false, true, false, 0]);
  assert.equal(st.problem, 'Another MetaCode\'s AI service (from a different folder) is using port ' + port + '. Set OPENCODE_SERVICE_PORT in .env to a free port and restart MetaCode.');
});

test('the child gets the data folder MetaCode compares its "home" with', async t => {
  const port = await freePort();
  const dataDir = path.join(tmp, 'home-child');
  const seen = path.join(tmp, 'child-data-dir');
  const script = fakeService('data-dir.js', `fs.writeFileSync(${JSON.stringify(seen)}, process.env.OPENCODE_SERVICE_DATA_DIR || '');`);
  const sup = createSupervisor({ script, log: quietLog() });
  t.after(() => sup.stop());
  await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN, dataDir });
  assert.equal(await sup.whenReady(10000), true);
  assert.equal(fs.readFileSync(seen, 'utf8'), dataDir);
  await sup.stop();
});

test('killed from outside (SIGKILL): the reason isn\'t the last ordinary line it printed', async t => {
  const port = await freePort();
  const script = fakeService('killed.js', 'setTimeout(() => console.log("chat emis/mini → 200 in 54 ms"), 50);');
  const out = quietLog();
  const sup = createSupervisor({ script, log: out, minBackoffMs: 5000 });
  t.after(() => sup.stop());
  const st = await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  assert.equal(await sup.whenReady(10000), true);
  await until(() => out.lines.some(l => l.includes('chat emis/mini')), 5000, 'the info line');
  process.kill(st.pid, 'SIGKILL');
  await until(() => sup.state().problem, 5000, 'the problem');
  assert.equal(sup.state().problem, 'The AI service was stopped by signal SIGKILL (killed from outside, for example by the system\'s out-of-memory killer).');
  await sup.stop();
});

test('an uncaught error: the error line is quoted, not Node\'s version line or the access log', async t => {
  const port = await freePort();
  const script = fakeService('throws.js', 'console.log("chat emis/mini → 200 in 54 ms"); setTimeout(() => { throw new TypeError("boom from the fake service"); }, 20);');
  const sup = createSupervisor({ script, log: quietLog(), minBackoffMs: 5000 });
  t.after(() => sup.stop());
  await sup.start({ mode: 'auto', url: 'http://127.0.0.1:' + port + '/v1', custom: false, token: TOKEN });
  await until(() => sup.state().problem, 10000, 'the problem');
  const problem = sup.state().problem;
  assert.equal(problem, 'The AI service stopped unexpectedly (exit code 1): TypeError: boom from the fake service.');
  assert.ok(!/Node\.js v|chat emis/.test(problem));
  await sup.stop();
});

test('describeExit: only what the service printed as an error is quoted', () => {
  const out = text => ({ text, err: false });
  const err = text => ({ text, err: true });
  // a V8 out-of-memory crash
  assert.equal(describeExit(null, 'SIGABRT', [out('chat emis/mini → 200 in 54 ms'), err('<--- Last few GCs --->'),
    err('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'), err('----- Native stack trace -----'),
    err(' 1: 0xb8ced1 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [/opt/node22/bin/node]'), err('16: 0x1dcb476  [/opt/node22/bin/node]')], 's', 1),
  'The AI service stopped unexpectedly (signal SIGABRT): FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory.');
  // an error with extra properties: Node prints them after the stack
  assert.equal(describeExit(1, null, [err('Error: no slot'), err('    at f (/x.js:1:1) {'), err('  code: \'X\''), err('}'), err(''), err('Node.js v22.22.0')], 's', 1),
    'The AI service stopped unexpectedly (exit code 1): Error: no slot.');
  // nothing on stderr: no quote at all
  assert.equal(describeExit(0, null, [out('MetaCode\'s OpenCode service is listening on 127.0.0.1:4097')], 's', 1), 'The AI service stopped unexpectedly (exit code 0).');
  assert.equal(describeExit(1, null, [err('listen EADDRINUSE: address already in use 127.0.0.1:4097')], 's', 4097).startsWith('The AI service couldn\'t start: port 4097 is in use'), true);
  // the service's own line for a package that isn't installed
  assert.equal(describeExit(1, null, [err('MetaCode\'s AI service can\'t start: the package @opencode/ai isn\'t installed. Run "npm install", then restart it.')], 's', 1), PACKAGES_MISSING);
});

test('shared.homeId: the first 16 hex of sha256 of the data folder\'s full path', () => {
  const dir = path.join(tmp, 'home-id');
  assert.equal(homeId(dir), sha(path.resolve(dir)).slice(0, 16));
  assert.match(homeId(dir), /^[0-9a-f]{16}$/);
  assert.equal(homeId(dir + path.sep), homeId(dir), 'the same folder written another way');
  assert.notEqual(homeId(path.join(tmp, 'other')), homeId(dir));
});
