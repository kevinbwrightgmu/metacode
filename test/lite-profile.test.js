// METACODE_PROFILE=lite (portable installs, small devices): nothing runs until a feature needs it. The server
// starts with no child process (the scraper's Python worker waits for the first scrape), and the status page
// still answers, checking when it's asked. Linux only (it looks at the server's child processes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { testEnv } = require('./helpers/harness');
const { loadScraperConfig } = require('../scraper/config');

const skip = process.platform !== 'linux' && 'Linux only';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('the scraper\'s worker waits for the first scrape in lite (warmed up at start otherwise)', () => {
  assert.equal(loadScraperConfig(testEnv({ METACODE_PROFILE: 'lite' })).lazyWorker, true);
  assert.equal(loadScraperConfig(testEnv({})).lazyWorker, false);
});

test('lite: the server starts with no child process; the status page answers, checking on demand', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-lite-'));
  const port = 39000 + Math.floor(Math.random() * 1000);
  const env = Object.assign({}, process.env, testEnv({ METACODE_PROFILE: 'lite', METACODE_DATA_DIR: dir, PORT: String(port), SUPABASE_URL: '', OPENCODE_SERVICE_URL: 'off' }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    let ok = false;
    for (let i = 0; i < 200 && !ok; i++) {
      try { ok = (await fetch('http://127.0.0.1:' + port + '/api/health')).ok; } catch (e) { await sleep(50); }
    }
    assert.ok(ok, 'the server answers');
    await sleep(1500);
    let kids = '';
    try { kids = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim(); } catch (e) { kids = ''; }       // (pgrep exits 1 when none)
    assert.equal(kids, '', 'no child process at start');
    const status = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json();
    assert.ok(Array.isArray(status.components) && status.components.length >= 4, JSON.stringify(status).slice(0, 300));
    assert.ok(status.components.some(c => c.checkedAt), 'checked when asked');
  } finally {
    child.kill();
    await new Promise(r => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
