// The guided tours (public/js/tour.js, app-tour.js, survey/studio-tour.js) in
// a real browser: every step finds what it points at, keyboard and buttons
// work, the page can't be clicked during a tour, the coding app's tour hands
// over to Survey Studio's, and the first-visit invite.
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

let server, base, browser, dataDir;
test.before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-tour-'));
  Object.assign(process.env, testEnv({ SURVEY_DATA_DIR: dataDir, EMIS_API_KEY: '' }));
  const { start } = require('../server');
  server = await start(0);
  base = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(url, viewport) {
  const context = await browser.newContext({ viewport: viewport || { width: 1400, height: 880 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto(base + url);
  return { page, context, errors };
}
// The card and spotlight slide to each step (0.3 s): measure once they've settled
const ready = async page => {
  await page.waitForFunction(() => document.querySelector('.tour-pop') && !document.querySelector('.tour-pop.is-busy'), null, { timeout: 15000 });
  await page.waitForTimeout(380);
};
const state = page => page.evaluate(() => {
  const spot = document.querySelector('.tour-spot');
  const r = spot && !spot.classList.contains('is-hidden') ? spot.getBoundingClientRect() : null;
  const pop = document.querySelector('.tour-pop').getBoundingClientRect();
  return { name: Tour.running && Tour.running.name, step: Tour.running && Tour.running.step, title: document.querySelector('.tour-title').textContent,
    spot: r ? { w: r.width, h: r.height } : null, popInView: pop.left >= 0 && pop.top >= 0 && pop.right <= innerWidth && pop.bottom <= innerHeight };
});

// Walks a tour with Next, checking each step; returns the titles seen
async function walk(page, name) {
  const steps = await page.evaluate(n => Tour.steps(n), name);
  const titles = [];
  for (let i = 0; i < steps.length; i++) {
    await ready(page);
    const s = await state(page);
    assert.equal(s.name, name);
    assert.equal(s.step, i);
    assert.equal(s.title, steps[i].title);
    if (steps[i].spotlight) assert.ok(s.spot && s.spot.w > 8 && s.spot.h > 8, name + ' step ' + i + ' (“' + s.title + '”) highlights something');
    assert.ok(s.popInView, 'the card is on screen at step ' + i);
    titles.push(s.title);
    if (i < steps.length - 1 || (await page.locator('.tour-pop [data-tour="next"]').count())) {
      if (i === steps.length - 1) break;
      await page.click('.tour-pop [data-tour="next"]');
    }
  }
  return titles;
}

test('the coding app tour: from the front page, through every page, then on to Survey Studio', { skip, timeout: 180000 }, async () => {
  const { page, context, errors } = await open('/index.html');
  assert.equal(await page.getAttribute('a.cta-tour', 'href'), 'app.html?tour=1');
  await page.click('a.cta-tour');
  await page.waitForURL(/app\.html/);
  const titles = await walk(page, 'app');
  assert.ok(titles.length >= 15);
  assert.equal(new URL(page.url()).search, '', 'the ?tour flag is removed from the address');
  // The last step offers the Survey Studio tour
  await page.click('.tour-pop [data-tour="custom"]');
  await page.waitForURL(/studio\.html/);
  await ready(page);
  assert.equal((await state(page)).name, 'studio');
  assert.equal(await page.evaluate(() => Tour.seen('app')), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('tour controls: keys, Back, Esc, the page is not clickable meanwhile, replay from the sidebar', { skip, timeout: 60000 }, async () => {
  const { page, context, errors } = await open('/app.html#dashboard');
  await page.waitForSelector('#sidebar-tour');
  await page.click('#sidebar-tour');
  await ready(page);
  assert.equal((await state(page)).step, 0);
  await page.keyboard.press('ArrowRight');
  await ready(page);
  await page.keyboard.press('ArrowRight');
  await ready(page);
  assert.equal((await state(page)).step, 2);
  await page.keyboard.press('ArrowLeft');
  await ready(page);
  assert.equal((await state(page)).step, 1);
  await page.click('.tour-pop [data-tour="back"]');
  await ready(page);
  assert.equal((await state(page)).step, 0);
  // Clicks outside the card don't reach the page
  await page.mouse.click(120, 158);      // where "Projects" is in the sidebar
  assert.equal(await page.evaluate(() => App.getCurrentView().id), 'dashboard');
  // Focus stays in the card
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('.tour-pop')));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.tour-pop, .tour-spot, .tour-shield').count(), 0, 'everything is removed');
  assert.equal(await page.evaluate(() => Tour.seen('app')), true, 'not offered again');
  // The page works normally afterwards
  await page.click('.nav-item[data-view="projects"]');
  await page.waitForSelector('#pj-current');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Survey Studio tours: the list, a practice survey, every editor tab; replay from the editor', { skip, timeout: 180000 }, async () => {
  const { page, context, errors } = await open('/studio.html?tour=1');
  const steps = await page.evaluate(() => Tour.steps('studio'));
  await walk(page, 'studio');
  assert.equal((await state(page)).step, steps.length - 1);
  await page.click('.tour-pop [data-tour="custom"]');     // Open a practice survey
  await page.waitForFunction(() => Tour.running && Tour.running.name === 'studio-editor', null, { timeout: 15000 });
  const surveys = await page.evaluate(() => LocalDB.all('surveys'));
  assert.equal(surveys.length, 1);
  assert.match(surveys[0].doc.title, /Practice survey/);
  await walk(page, 'studio-editor');
  await page.click('.tour-pop [data-tour="next"]');        // Finish
  assert.equal(await page.locator('.tour-pop').count(), 0);
  assert.deepEqual(await page.evaluate(() => [Tour.seen('studio'), Tour.seen('studio-editor')]), [true, true]);
  // The tour left the editor on the Design tab, and it can be replayed from the editor's top bar
  assert.equal(await page.getAttribute('.ss-mode[data-mode="design"]', 'aria-selected'), 'true');
  await page.click('#ss-tour');
  await ready(page);
  assert.equal((await state(page)).name, 'studio-editor');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await context.close();
});

test('first visit: a small invite (not for automated browsers); "No thanks" is remembered; phones get a docked card', { skip, timeout: 60000 }, async () => {
  const { page, context, errors } = await open('/app.html#dashboard');
  await page.waitForSelector('#sidebar-tour');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('.tour-invite').count(), 0, 'automated browsers (navigator.webdriver) are not invited');
  await page.evaluate(() => Tour.invite('app'));
  await page.waitForSelector('.tour-invite');
  // It doesn't block the page
  await page.click('.nav-item[data-view="codebook"]');
  assert.equal(await page.evaluate(() => App.getCurrentView().id), 'codebook');
  await page.click('.tour-invite [data-act="no"]');
  assert.equal(await page.locator('.tour-invite').count(), 0);
  assert.equal(await page.evaluate(() => Tour.seen('app')), true);
  await page.evaluate(() => Tour.invite('app'));
  await page.click('.tour-invite [data-act="go"]');
  await ready(page);
  assert.equal((await state(page)).name, 'app');
  await page.keyboard.press('Escape');
  await context.close();

  const phone = await open('/app.html#dashboard', { width: 390, height: 844 });
  await phone.page.waitForSelector('#sidebar-tour', { state: 'attached' });
  await phone.page.evaluate(() => Tour.start('app', { at: 4 }));
  await ready(phone.page);
  const s = await state(phone.page);
  assert.ok(s.popInView);
  assert.equal(await phone.page.evaluate(() => document.querySelector('.tour-pop').classList.contains('is-docked')), true);
  assert.deepEqual(errors.concat(phone.errors), []);
  await phone.context.close();
});
