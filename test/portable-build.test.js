// The portable build (scripts/build-portable.js) for this computer, started from its folder with nothing else
// around it: the launcher's defaults (lite profile, AI on this computer only, data in the folder), no request
// to another site at start. Opt-in (it installs the production dependencies, a minute or two):
//   METACODE_TEST_PORTABLE=1 node --test test/portable-build.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const skip = process.env.METACODE_TEST_PORTABLE !== '1' ? 'set METACODE_TEST_PORTABLE=1 to run it'
  : process.platform !== 'linux' ? 'Linux only' : false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('portable build: the folder starts on its own, lite and local-only, with its data inside', { skip, timeout: 600000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-portable-'));
  try {
    const target = 'linux-' + (process.arch === 'arm' ? 'armv7l' : process.arch);
    // (--no-node: the Node.js running this test, rather than a download)
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-portable.js'), '--target', target, '--no-node', '--no-archive', '--out', out], { stdio: 'ignore' });
    const dir = path.join(out, 'MetaCode-' + require('../package.json').version + '-' + target);
    for (const f of ['metacode.sh', 'server.js', 'README-PORTABLE.txt', 'portable.json', 'node_modules/express/package.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    for (const f of ['.env', 'test', 'desktop', 'scripts', 'node_modules/.bin']) assert.ok(!fs.existsSync(path.join(dir, f)), f + ' isn\'t shipped');
    const port = await freePort();
    const child = spawn(path.join(dir, 'metacode.sh'), [], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin', HOME: out, PORT: String(port), METACODE_NO_BROWSER: '1', OPENCODE_SERVICE_URL: 'off', OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1' } });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    try {
      let health = null;
      for (let i = 0; i < 300 && !health; i++) {
        try { const r = await fetch('http://127.0.0.1:' + port + '/api/health'); if (r.ok) health = await r.json(); } catch (e) { await sleep(100); }
      }
      assert.ok(health, log);
      const status = await (await fetch('http://127.0.0.1:' + port + '/api/local-ai/status')).json();
      assert.equal(status.mode, 'local-only');
      assert.ok(fs.existsSync(path.join(dir, 'data')), 'data/ in the folder');
      assert.match(log, /Running at → http:\/\/localhost:\d+/);
    } finally {
      child.kill();
      await new Promise(r => child.once('exit', r));
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
