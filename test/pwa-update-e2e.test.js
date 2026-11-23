// The installed MetaCode while its server comes and goes, in a real browser (MetaCode runs as its own process
// here, so it can stop and start again on the same address):
// - the server back while a page is open: the top bar says so by itself, without a reload;
// - another program at MetaCode's address now (it has no /sw.js): the kept MetaCode steps aside, and that
//   program's pages show.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let browser, tmp, port, base;

function startMetaCode() {
  const env = Object.assign({}, process.env, testEnv({ METACODE_DATA_DIR: tmp, OPENCODE_SERVICE_URL: 'off', METACODE_ANALYTICS_ID: '', PORT: String(port), METACODE_HOST: '127.0.0.1', SUPABASE_URL: '' }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  child.exited = new Promise(r => child.once('exit', r));
  return child;
}
async function answers() {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return true; } catch (e) { /* not yet */ }
    await sleep(50);
  }
  return false;
}
async function stop(child) { child.kill(); await child.exited; }
const noTours = () => { try { localStorage.setItem('metacode_tour_app', 'done'); localStorage.setItem('metacode_tour_studio', 'done'); } catch (e) { /* ignore */ } };
// The service worker controls the page and has kept every file of this version
const precached = page => page.evaluate(async () => {
  await navigator.serviceWorker.ready;
  for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise(r => setTimeout(r, 100));
  const cfg = JSON.parse((await (await fetch('/sw.js')).text()).match(/const PWA = (\{.*\});/)[1]);
  for (let i = 0; i < 100; i++) {
    if ((await (await caches.open('metacode-' + cfg.version)).keys()).length === cfg.precache.length) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
});

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-pwa-update-'));
  port = await freePort();
  base = 'http://localhost:' + port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('the server back while a page is open: the top bar says so by itself; AI messages said the server couldn\'t be reached meanwhile', { skip, timeout: 120000 }, async () => {
  let mc = startMetaCode();
  assert.ok(await answers());
  const context = await browser.newContext();
  await context.addInitScript(noTours);
  const page = await context.newPage();
  await page.goto(base + '/app.html#dashboard');
  assert.ok(await precached(page));
  await stop(mc);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('status-label').textContent === 'Server unreachable');
  assert.match(await page.evaluate(() => App.aiUnavailable()), /^The MetaCode server can't be reached/);
  mc = startMetaCode();
  try {
    assert.ok(await answers());
    // (no reload, no navigation: the page looks again by itself)
    await page.waitForFunction(() => document.getElementById('status-label').textContent !== 'Server unreachable', null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => document.getElementById('status-label').textContent), 'AI not set up');
    assert.match(await page.evaluate(() => App.aiUnavailable()), /^AI isn't set up on this server/);
  } finally {
    await context.close();
    await stop(mc);
  }
});

test('another program at MetaCode\'s address now (no /sw.js there): the kept MetaCode steps aside, and that program\'s page shows', { skip, timeout: 120000 }, async () => {
  const mc = startMetaCode();
  assert.ok(await answers());
  const context = await browser.newContext();
  await context.addInitScript(noTours);
  const page = await context.newPage();
  await page.goto(base + '/');
  assert.ok(await precached(page));
  await stop(mc);
  const other = http.createServer((req, res) => {
    if (req.url === '/sw.js') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><title>Other</title><h1>OTHER APP</h1>');
  });
  await new Promise(r => other.listen(port, '127.0.0.1', r));
  try {
    // (this visit is MetaCode's kept page; the service worker learns meanwhile that MetaCode is gone here)
    await page.goto(base + '/');
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length === 0, null, { timeout: 30000 });
    await page.goto(base + '/');
    assert.match(await page.textContent('h1'), /OTHER APP/);
    await page.waitForFunction(async () => (await caches.keys()).filter(k => k.startsWith('metacode-')).length === 0, null, { timeout: 10000 });
  } finally {
    await context.close();
    other.closeAllConnections();
    await new Promise(r => other.close(r));
  }
});
