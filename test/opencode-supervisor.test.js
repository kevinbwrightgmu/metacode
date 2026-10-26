// MetaCode starting its OpenCode service itself (opencode/supervisor.js):
// started when nothing answers at the address, left alone when something
// does, started again with a growing pause after it stops, a readable
// problem when its packages are missing, and stopped with MetaCode. The
// service here is a tiny stand-in script that answers GET /health, not the
// real opencode/server.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSupervisor, checkHealth, PACKAGES_MISSING } = require('../opencode/supervisor');

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
