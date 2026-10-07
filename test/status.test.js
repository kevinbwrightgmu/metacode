// The status page (status-page.js, public/status.html): the monitor's logic,
// host routing for status.metac0.de, the public JSON and the page itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createStatusMonitor } = require('../status-page');
const { testEnv } = require('./helpers/harness');

/* ── Monitor (unit) ───────────────────────── */
test('overall status, 30-minute history, uptime and incidents', async () => {
  let t = Date.UTC(2026, 0, 1, 12, 0);
  const results = { a: { status: 'operational' }, b: { status: 'operational' }, c: { status: 'off', note: 'not set up' } };
  const m = createStatusMonitor({ now: () => t, components: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), check: () => results[id] })) });
  await m.run();
  let s = m.snapshot();
  assert.equal(s.status, 'operational');
  assert.equal(s.label, 'All systems operational');
  assert.equal(s.components.length, 3);
  assert.equal(s.components[0].history.length, 48, '24 h of 30-minute bars');
  assert.equal(s.components[0].history[47], 'operational');
  assert.equal(s.components[0].history[0], 'none', 'no data before the server started');
  assert.equal(s.components[2].status, 'off');
  assert.deepEqual(s.incidents, []);

  t += 10 * 60000;
  results.b = { status: 'degraded', note: 'slow' };
  await m.run();
  s = m.snapshot();
  assert.equal(s.status, 'degraded');
  assert.equal(s.label, 'Some systems are degraded');
  assert.equal(s.incidents.length, 1);
  assert.deepEqual([s.incidents[0].component, s.incidents[0].status, s.incidents[0].resolvedAt], ['b', 'degraded', null]);

  t += 10 * 60000;
  results.b = { status: 'outage', note: 'down' };
  await m.run();
  s = m.snapshot();
  assert.equal(s.label, 'Partial outage', 'one of two live components is down ("off" doesn\'t count)');
  assert.equal(s.incidents.length, 1, 'still the same incident, now worse');
  assert.equal(s.incidents[0].status, 'outage');
  results.a = { status: 'outage' };
  await m.run();
  assert.equal(m.snapshot().label, 'Major outage');

  t += 40 * 60000;
  results.a = results.b = { status: 'operational' };
  await m.run();
  s = m.snapshot();
  assert.equal(s.status, 'operational');
  assert.ok(s.incidents.every(i => i.resolvedAt), 'both incidents resolved');
  const b = s.components.find(c => c.id === 'b');
  assert.ok(b.history.includes('outage'), 'the worst status of a 30-minute bar is kept');
  assert.equal(b.history[b.history.length - 1], 'operational');
  assert.equal(b.uptime, 50, '2 of its 4 samples were operational (a repeat check at the same moment counts once)');
});

test('a check that throws or hangs counts as an outage instead of breaking the page', async () => {
  const m = createStatusMonitor({ checkTimeoutMs: 100, components: [
    { id: 'x', name: 'X', check: () => { throw new Error('boom /secret/path'); } },
    { id: 'y', name: 'Y', check: () => new Promise(() => {}) }
  ] });
  await m.run();
  const s = m.snapshot();
  assert.deepEqual(s.components.map(c => c.status), ['outage', 'outage']);
  assert.ok(!JSON.stringify(s).includes('secret'), 'error details are never shown');
});

/* ── Server (integration) ─────────────────── */
let server, port, dataDir;
test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-status-'));
  Object.assign(process.env, testEnv({ SURVEY_DATA_DIR: dataDir, EMIS_API_KEY: '' }));
  const { start } = require('../server');
  server = await start(0);
  port = server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// A request with any Host header (fetch can't set it)
function get(p, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: host || 'localhost:' + port } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/status: every component, public, nothing secret', async () => {
  const r = await get('/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.match(r.headers['cache-control'], /no-store/);
  const j = JSON.parse(r.body);
  assert.deepEqual(j.components.map(c => c.id), ['app', 'ai', 'surveys', 'analysis', 'scraper']);
  assert.ok(['operational', 'degraded', 'outage'].includes(j.status));
  const ai = j.components.find(c => c.id === 'ai');
  assert.equal(ai.status, 'off', 'no AI key in this test');
  assert.match(ai.note, /isn't set up/);
  assert.equal(j.components.find(c => c.id === 'surveys').status, 'operational');
  assert.equal(j.components.find(c => c.id === 'app').status, 'operational');
  assert.ok(!/emis|\.env|api_key|\/home\/|\/tmp\//i.test(r.body), 'no provider name, settings or paths');
});

test('status.metac0.de (and any status.* host) serves the status page; other pages go to the main site', async () => {
  for (const host of ['status.metac0.de', 'status.localhost:' + port]) {
    const page = await get('/', host);
    assert.equal(page.status, 200, host);
    assert.match(page.body, /<title>MetaCode Status<\/title>/);
    assert.equal((await get('/api/status', host)).status, 200);
    assert.equal((await get('/css/status.css', host)).status, 200);
    assert.equal((await get('/js/status.js', host)).status, 200);
  }
  const app = await get('/app.html?x=1', 'status.metac0.de');
  assert.equal(app.status, 302);
  assert.equal(app.headers.location, 'http://metac0.de/app.html?x=1');
  assert.equal((await get('/api/ai', 'status.metac0.de')).status, 302, 'the app\'s APIs aren\'t served on the status host');
  // The main site is unchanged, and has the page at /status
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.body, /MetaCode Status<\/title>/);
  assert.match((await get('/status')).body, /<title>MetaCode Status<\/title>/);
  assert.equal((await get('/app.html')).status, 200);
  // STATUS_HOST names another host
  process.env.STATUS_HOST = 'health.example.org';
  try { assert.match((await get('/', 'health.example.org')).body, /MetaCode Status/); } finally { delete process.env.STATUS_HOST; }
  assert.doesNotMatch((await get('/', 'health.example.org')).body, /MetaCode Status<\/title>/);
});

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
const chromiumPath = findChromium();

test('the status page renders on desktop and phones; on status.* links point at the main site', { skip: !chromiumPath && 'no Chromium', timeout: 60000 }, async () => {
  const browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
  try {
    for (const [url, viewport] of [['http://status.localhost:' + port + '/', { width: 1280, height: 900 }], ['http://localhost:' + port + '/status', { width: 375, height: 740 }]]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route(/^https?:\/\/(?!localhost|status\.localhost)/, r => r.abort());
      await page.goto(url);
      await page.waitForFunction(() => document.querySelectorAll('.st-comp').length === 5);
      assert.match(await page.textContent('#st-overall-title'), /operational|degraded|outage/i);
      assert.equal(await page.locator('.st-comp .st-bars span').count(), 5 * 48);
      assert.equal(await page.getAttribute('#st-overall', 'aria-busy'), 'false');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling');
      const app = await page.getAttribute('#st-app', 'href');
      if (url.includes('status.localhost')) assert.equal(app, 'http://localhost:' + port + '/app.html');
      else assert.equal(app, '/app.html');
      await page.click('#st-refresh');
      await page.waitForFunction(() => !document.getElementById('st-refresh').disabled);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('a server without the status checks (not restarted) gets a clear message; status.* pages fall back to the main site\'s data', { skip: !chromiumPath && 'no Chromium', timeout: 60000 }, async () => {
  const browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
  try {
    // An older server answers /api/status with 404
    let page = await browser.newPage();
    await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    await page.route('**/api/status', r => r.fulfill({ status: 404, body: 'Cannot GET /api/status' }));
    await page.goto('http://localhost:' + port + '/status.html');
    await page.waitForFunction(() => document.getElementById('st-overall').classList.contains('is-unreachable'));
    assert.match(await page.textContent('#st-overall-title'), /status checks aren't running on this server/);
    assert.match(await page.textContent('#st-overall-sub'), /older version.*npm start/);
    await page.close();
    // status.* host that can't answer itself: the main site's /api/status is used
    page = await browser.newPage();
    await page.route(/^https?:\/\/(?!localhost|status\.localhost)/, r => r.abort());
    await page.route('http://status.localhost:' + port + '/api/status', r => r.fulfill({ status: 404, body: '' }));
    await page.goto('http://status.localhost:' + port + '/');
    await page.waitForFunction(() => document.querySelectorAll('.st-comp').length === 5);
    assert.doesNotMatch(await page.textContent('#st-overall-title'), /can't|aren't/);
    await page.close();
  } finally { await browser.close(); }
});
