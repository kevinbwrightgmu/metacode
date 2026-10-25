// Survey Studio's Logic tab with REAL scrollbars — the "shaking" Logic screen.
// The block workspace sized its scrollable area from its own visible size,
// which the browser rounds to whole pixels (up, at 125 % display scaling or
// browser zoom): the content overflowed by a fraction of a pixel, scrollbars
// appeared, the workspace shrank, the content shrank, the scrollbars went…
// every frame. Playwright hides scrollbars by default (--hide-scrollbars) and
// its deviceScaleFactor keeps CSS sizes whole, which is why the stillness
// test in survey-e2e.test.js never saw it; this one launches Chromium with
// scrollbars and lays the page out in fractional pixels (zoom 125 %, the
// same arithmetic as browser zoom and Windows display scaling).
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
let server, baseUrl, browser, dataDir;

test.before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-logic-sb-'));
  Object.assign(process.env, testEnv({ SURVEY_DATA_DIR: dataDir, EMIS_API_KEY: '', SUPABASE_URL: '', DESKTOP_RELEASES_REPO: 'off' }));
  server = await require('../server').start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath, ignoreDefaultArgs: ['--hide-scrollbars'] });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// Over 30 frames: how many different layouts (scrollbars present or not, where the empty-state
// card or the first script is), and how many "ResizeObserver loop" errors the page reported
const watch = page => page.evaluate(() => new Promise(done => {
  const ws = document.querySelector('.bk-ws');
  const anchor = document.querySelector('.bk-empty-card') || document.querySelector('.bk-canvas > .bk-script') || document.querySelector('.bk-canvas');
  const seen = new Set();
  let frames = 0, roErrors = 0;
  const onError = e => { if (/ResizeObserver loop/.test(String(e.message))) roErrors++; };
  window.addEventListener('error', onError);
  const tick = () => {
    const b = anchor.getBoundingClientRect();
    seen.add([ws.offsetWidth - ws.clientWidth, ws.offsetHeight - ws.clientHeight, ws.scrollWidth, ws.scrollHeight, b.left.toFixed(2), b.top.toFixed(2)].join());
    if (++frames < 30) requestAnimationFrame(tick);
    else { window.removeEventListener('error', onError); done({ layouts: seen.size, roErrors }); }
  };
  requestAnimationFrame(tick);
}));

async function openLogic(template, viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => { try { localStorage.setItem('metacode_tour_studio', 'done'); localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto(baseUrl + '/studio.html');
  await page.click('.ss-tpl[data-tpl="' + template + '"]');
  await page.click('.ss-mode[data-mode="logic"]');
  await page.waitForSelector(template === 'blank' ? '.bk-ws .bk-empty-card' : '.bk-canvas > .bk-script');
  return { context, page, errors };
}
// Window sizes → those where something keeps moving
async function sweep(page, sizes) {
  const moving = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const r = await watch(page);
    if (r.layouts !== 1 || r.roErrors) moving.push(w + 'x' + h + ': ' + r.layouts + ' layouts, ' + r.roErrors + ' ResizeObserver loop errors');
  }
  return moving;
}

test('the empty Logic workspace stays still with real scrollbars at 125 % zoom, whatever the window size', { skip, timeout: 120000 }, async () => {
  const { context, page, errors } = await openLogic('blank', { width: 1280, height: 762 });
  // The test means something only if scrollbars take space here
  assert.ok(await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;width:100px;height:100px;overflow:scroll'; document.body.appendChild(d); const w = d.offsetWidth - d.clientWidth; d.remove(); return w; }) > 0, 'scrollbars take space');
  await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
  const moving = await sweep(page, [[1280, 758], [1280, 759], [1280, 760], [1280, 761], [1280, 762], [1280, 763], [1281, 762], [1282, 762], [1283, 762], [1284, 762], [1500, 860], [1501, 861], [1502, 862]]);
  assert.deepEqual(moving, [], 'one layout over 30 frames at every size (no scrollbars blinking, the empty-state card stays put)');
  assert.deepEqual(errors, []);
  await context.close();
});

test('with scripts in it, on a wide window, after zooming the blocks in and out: still', { skip, timeout: 120000 }, async () => {
  const { context, page, errors } = await openLogic('feedback', { width: 1920, height: 780 });
  await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
  const sizes = [[1920, 776], [1920, 777], [1920, 778], [1920, 779], [1920, 780], [1920, 781], [1921, 780], [1922, 780], [1923, 780]];
  const moving = await sweep(page, sizes);
  for (const z of ['out', 'out', 'in', 'in', 'in']) {
    await page.click('.bk-zoom [data-z="' + z + '"]');
    moving.push(...(await sweep(page, sizes.slice(0, 4))).map(m => 'zoom ' + z + ': ' + m));
  }
  assert.deepEqual(moving, []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('…and at a real 125 % display scale (the device scale factor, as on Windows at 125 %), window size by window size', { skip, timeout: 120000 }, async () => {
  // Playwright's deviceScaleFactor keeps CSS sizes whole; a scaled browser window doesn't
  const scaled = await require('playwright-core').chromium.launch({ executablePath: chromiumPath, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1.25', '--window-size=1280,900'] });
  try {
    const context = await scaled.newContext({ viewport: null });
    await context.addInitScript(() => { try { localStorage.setItem('metacode_tour_studio', 'done'); localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } });
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    await page.goto(baseUrl + '/studio.html');
    await page.click('.ss-tpl[data-tpl="blank"]');
    await page.click('.ss-mode[data-mode="logic"]');
    await page.waitForSelector('.bk-ws .bk-empty-card');
    assert.equal(await page.evaluate(() => devicePixelRatio), 1.25);
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const moving = [];
    for (let dw = 0; dw < 3; dw++) {
      for (let dh = 0; dh < 5; dh++) {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1500 + dw, height: 860 + dh } });
        await page.waitForTimeout(150);
        const r = await watch(page);
        if (r.layouts !== 1 || r.roErrors) moving.push((1500 + dw) + 'x' + (860 + dh) + ': ' + r.layouts + ' layouts, ' + r.roErrors + ' ResizeObserver loop errors');
      }
    }
    assert.deepEqual(moving, []);
    await context.close();
  } finally { await scaled.close(); }
});
