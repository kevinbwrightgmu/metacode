// The installable, offline MetaCode in a real browser:
// - nothing loads from another site (no CDN, no Google Fonts, no analytics by default);
// - the service worker keeps the app, Survey Studio and their files, so they open and work with the device
//   offline and even with the MetaCode server stopped, with the data still there;
// - the top bar says "Offline" / "Server unreachable" instead of "AI not set up";
// - pages this device hasn't kept show a clear offline page, and /api is never cached;
// - phones get a ☰ menu for the sidebar.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testEnv } = require('./helpers/harness');

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
const chromiumPath = findChromium();
const skip = !chromiumPath && 'no Chromium found (set CHROMIUM_PATH)';
let server, baseUrl, browser, tmp;

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-pwa-e2e-'));
  Object.assign(process.env, testEnv({ METACODE_DATA_DIR: tmp, OPENCODE_SERVICE_URL: 'off', METACODE_ANALYTICS_ID: '' }));
  server = await require('../server').start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server && server.listening) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const noTours = () => { try { localStorage.setItem('metacode_tour_app', 'done'); localStorage.setItem('metacode_tour_studio', 'done'); localStorage.setItem('metacode_tour_offer_studio-tutorial', '1'); } catch (e) { /* ignore */ } };
async function open(context, url) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(baseUrl + url);
  return { page, errors };
}
// The service worker controls the page and has kept every file of this version
async function precached(page) {
  return page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100));
    const sw = await (await fetch('/sw.js')).text();
    const cfg = JSON.parse(sw.match(/const PWA = (\{.*\});/)[1]);
    for (let i = 0; i < 100; i++) {
      const cache = await caches.open('metacode-' + cfg.version);
      if ((await cache.keys()).length === cfg.precache.length) return cfg;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  });
}

test('nothing loads from another site: no CDN, no Google Fonts, no analytics unless METACODE_ANALYTICS_ID is set', { skip, timeout: 60000 }, async () => {
  const context = await browser.newContext();
  await context.addInitScript(noTours);
  const outside = [];
  context.on('request', r => { if (!r.url().startsWith(baseUrl) && !/^(data|blob):/.test(r.url())) outside.push(r.url()); });
  for (const url of ['/index.html', '/app.html#dashboard', '/app.html#metrics', '/app.html#network', '/studio.html']) {
    const { page, errors } = await open(context, url);
    await page.waitForLoadState('networkidle');
    assert.deepEqual(errors, [], url);
    await page.close();
  }
  assert.deepEqual(outside, []);
  // The libraries and fonts come from this server
  const { page } = await open(context, '/app.html#dashboard');
  assert.deepEqual(await page.evaluate(() => [typeof Papa, typeof Chart, typeof d3]), ['object', 'function', 'object']);
  assert.ok(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('600 16px "Space Grotesk"') && document.fonts.check('16px Inter'); }));
  // Analytics: an empty script by default; Google's tag only when the operator sets METACODE_ANALYTICS_ID
  assert.match(await (await fetch(baseUrl + '/analytics.js')).text(), /^\/\* Analytics is off/);
  process.env.METACODE_ANALYTICS_ID = 'G-TEST12345';
  try { assert.match(await (await fetch(baseUrl + '/analytics.js')).text(), /"G-TEST12345"[\s\S]*googletagmanager\.com\/gtag\/js\?id=/); }
  finally { process.env.METACODE_ANALYTICS_ID = ''; }
  await context.close();
});

test('phones: the ☰ button opens the sidebar as a drawer, and choosing a page closes it', { skip, timeout: 60000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(noTours);
  const { page, errors } = await open(context, '/app.html#dashboard');
  const sidebarX = async () => (await page.locator('#sidebar').boundingBox()).x;
  assert.ok(await page.locator('#nav-toggle').isVisible());
  assert.ok(await sidebarX() < 0, 'hidden off-screen');
  await page.click('#nav-toggle');
  await page.waitForFunction(() => document.body.classList.contains('nav-open'));
  await page.waitForTimeout(300);
  assert.ok(await sidebarX() >= 0, 'opened');
  await page.click('.nav-item[data-view="codebook"]');
  await page.waitForFunction(() => !document.body.classList.contains('nav-open') && location.hash === '#codebook');
  assert.equal(await page.textContent('#topbar-title'), 'Codebook');
  // the backdrop closes it too
  await page.click('#nav-toggle');
  await page.waitForFunction(() => document.body.classList.contains('nav-open'));
  await page.mouse.click(370, 400);
  await page.waitForFunction(() => !document.body.classList.contains('nav-open'));
  // (on a desktop-wide window there's no ☰)
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await page.locator('#nav-toggle').isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('offline: the app and Survey Studio open from the service worker with their data; the top bar says "Offline"; /api is never cached; other pages show an offline page', { skip, timeout: 90000 }, async () => {
  const context = await browser.newContext();
  await context.addInitScript(noTours);
  const { page, errors } = await open(context, '/app.html#dashboard');
  const cfg = await precached(page);
  assert.ok(cfg, 'every file kept');
  assert.ok(cfg.precache.includes('/app.html') && cfg.precache.includes('/studio.html') && cfg.precache.includes('/vendor/d3/d3.min.js'));
  assert.ok(!cfg.precache.some(u => u.startsWith('/api/') || u.startsWith('/js/ai-lab/')), 'no API answers, nor the AI Lab (it needs the server)');
  await page.evaluate(() => App.setState({ project: Object.assign({}, App.getState().project, { name: 'Field study, offline' }) }));

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => typeof App !== 'undefined' && document.getElementById('topbar-project').textContent === 'Field study, offline');
  assert.deepEqual(await page.evaluate(() => [typeof Papa, typeof Chart, typeof d3]), ['object', 'function', 'object']);
  await page.waitForFunction(() => document.getElementById('status-label').textContent === 'Offline');
  assert.ok(await page.locator('.offline-banner').isVisible());
  // The views that need no server work
  for (const view of ['codebook', 'import', 'human-coding', 'reliability', 'metrics', 'network', 'export', 'settings']) {
    await page.evaluate(v => { location.hash = '#' + v; }, view);
    await page.waitForFunction(v => document.getElementById('topbar-title').textContent && location.hash === '#' + v, view);
  }
  // /api isn't answered from a cache
  assert.equal(await page.evaluate(() => fetch('/api/settings/status').then(() => 'answered', () => 'failed')), 'failed');
  // Survey Studio opens too
  const studio = await context.newPage();
  const studioErrors = [];
  studio.on('pageerror', e => studioErrors.push(String(e && e.message)));
  await studio.goto(baseUrl + '/studio.html');
  await studio.waitForSelector('[data-account-chip], .studio-shell, body');
  assert.match(await studio.title(), /Survey Studio/);
  // A page this device didn't keep: the offline page, with a way back to the app
  const other = await context.newPage();
  const res = await other.goto(baseUrl + '/download.html');
  assert.equal(res.status(), 503);
  assert.match(await other.textContent('h1'), /needs the MetaCode server/);
  assert.equal(await other.getAttribute('a', 'href'), '/app.html');

  await context.setOffline(false);
  await page.reload();
  await page.waitForFunction(() => /AI/.test(document.getElementById('status-label').textContent));
  assert.equal(await page.locator('.offline-banner').isVisible(), false);
  assert.deepEqual(errors.filter(e => !/Failed to fetch|NetworkError|net::/i.test(e)), []);
  await context.close();
});

test('the MetaCode server stopped: the app still opens with its data (everything from the service worker); the top bar says "Server unreachable"', { skip, timeout: 90000 }, async () => {
  const context = await browser.newContext();
  await context.addInitScript(noTours);
  const { page } = await open(context, '/app.html#dashboard');
  assert.ok(await precached(page));
  await page.evaluate(() => App.setState({ project: Object.assign({}, App.getState().project, { name: 'Kept on this device' }) }));
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await page.reload();
  await page.waitForFunction(() => typeof App !== 'undefined' && document.getElementById('topbar-project').textContent === 'Kept on this device');
  await page.waitForFunction(() => document.getElementById('status-label').textContent === 'Server unreachable');
  assert.deepEqual(await page.evaluate(() => [typeof Papa, typeof Chart, typeof d3]), ['object', 'function', 'object']);
  await page.evaluate(() => { location.hash = '#codebook'; });
  await page.waitForFunction(() => document.getElementById('topbar-title').textContent === 'Codebook');
  await context.close();
});
