// MetaCode on one's own computer (the portable launchers and packages, docs/offline-first.md):
// METACODE_HOST=127.0.0.1 keeps it to this computer, METACODE_OPEN_BROWSER=1 opens it in the browser once it
// listens and, when it's started again while it runs, opens the one that runs. The AI Model Store answers only
// MetaCode's own pages: other websites can't use it from the browser (cross-site requests), nor by pointing a
// name of theirs at 127.0.0.1 (DNS rebinding). Linux only (a stand-in xdg-open records what was opened).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { testEnv } = require('./helpers/harness');

const skip = process.platform !== 'linux' && 'Linux only';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-local-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'xdg-open'), '#!/bin/sh\necho "$@" >> "$OPENED_FILE"\n', { mode: 0o755 });
  return dir;
}
function startServer(dir, port, extra) {
  const env = Object.assign({}, process.env, testEnv(Object.assign({ METACODE_PROFILE: 'lite', METACODE_DATA_DIR: path.join(dir, 'data'), PORT: String(port), SUPABASE_URL: '', METACODE_HOST: '127.0.0.1' }, extra)));
  env.PATH = path.join(dir, 'bin') + path.delimiter + env.PATH;
  env.OPENED_FILE = path.join(dir, 'opened.txt');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.output = () => out;
  child.exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return child;
}
async function answers(port) {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch('http://127.0.0.1:' + port + '/api/health')).ok) return true; } catch (e) { /* not yet */ }
    await sleep(50);
  }
  return false;
}
const opened = dir => { try { return fs.readFileSync(path.join(dir, 'opened.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; } };
// A request with any Host header (a page can't choose it; fetch doesn't let this test either)
function raw(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'content-type': 'application/json' }, headers) }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('METACODE_HOST=127.0.0.1: this computer only; METACODE_OPEN_BROWSER: opened once it listens, and a second start opens the one that runs', { skip, timeout: 90000 }, async () => {
  const dir = tempDir();
  const port = await freePort();
  const child = startServer(dir, port, { METACODE_OPEN_BROWSER: '1' });
  try {
    assert.ok(await answers(port), child.output());
    const url = 'http://localhost:' + port + '/app.html';
    for (let i = 0; i < 100 && !opened(dir).length; i++) await sleep(50);
    assert.deepEqual(opened(dir), [url]);
    // (another address of this computer: nothing listens there)
    const other = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
    if (other) await assert.rejects(fetch('http://' + other.address + ':' + port + '/api/health', { signal: AbortSignal.timeout(3000) }));
    const again = startServer(dir, port, { METACODE_OPEN_BROWSER: '1' });
    assert.equal(await again.exited, 0, again.output());
    assert.match(again.output(), /already running at http:\/\/localhost:\d+\/app\.html/);
    assert.deepEqual(opened(dir), [url, url]);
    // …and without METACODE_OPEN_BROWSER (METACODE_NO_BROWSER=1) it says so, and opens nothing
    const third = startServer(dir, port, {});
    assert.equal(await third.exited, 0, third.output());
    assert.match(third.output(), /already running at http:\/\/localhost:\d+\/app\.html\./);
    assert.equal(opened(dir).length, 2);
  } finally {
    child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy port that isn\'t MetaCode\'s (another program answering {"status":"ok"} too): the error says to set another PORT, and nothing opens', { skip, timeout: 60000 }, async () => {
  const dir = tempDir();
  const other = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok' })); });
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  try {
    const child = startServer(dir, other.address().port, { METACODE_OPEN_BROWSER: '1' });
    assert.equal(await child.exited, 1, child.output());
    assert.match(child.output(), /another program uses port \d+: set another PORT in \.env/);
    assert.deepEqual(opened(dir), []);
  } finally {
    await new Promise(r => other.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the AI Model Store answers MetaCode\'s own pages only: no CORS, cross-site requests refused, another site\'s name for 127.0.0.1 can\'t manage models', { skip, timeout: 90000 }, async () => {
  const dir = tempDir();
  const port = await freePort();
  const child = startServer(dir, port, {});
  try {
    assert.ok(await answers(port), child.output());
    const own = 'localhost:' + port;
    const status = await raw(port, 'GET', '/api/local-ai/status', { host: own, origin: 'https://evil.example' });
    assert.equal(status.status, 200);
    assert.equal(status.headers['access-control-allow-origin'], undefined, 'no CORS for other sites');
    assert.equal(status.json.manage.allowed, true);
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const r = await raw(port, 'POST', '/api/local-ai/installs', Object.assign({ host: own }, headers), { model: 'gemma3:270m' });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.equal(r.json.error.type, 'forbidden_origin');
    }
    // DNS rebinding: to the browser it's the other site's own origin, so it passes the same-origin check
    const evil = 'evil.example:' + port;
    const rebound = await raw(port, 'POST', '/api/local-ai/models/load', { host: evil, origin: 'http://' + evil, 'sec-fetch-site': 'same-origin' }, { model: 'gemma3:270m' });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.json.error.code, 'manage_locked');
    assert.equal((await raw(port, 'GET', '/api/local-ai/status', { host: evil })).json.manage.allowed, false);
    for (const host of ['127.0.0.1:' + port, '[::1]:' + port, 'metacode.localhost:' + port]) {
      assert.equal((await raw(port, 'GET', '/api/local-ai/status', { host })).json.manage.allowed, true, host);
    }
  } finally {
    child.kill();
    await child.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
