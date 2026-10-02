// End-to-end tests in a real browser (Playwright + Chromium) against the full
// MetaCode server (server.js) and a mock Reddit:
//   Open platform → Scraper → target → start → progress → results → export → add to project
//   Scraper → Custom code → write → run → sandbox → results
//   Browse Reddit (Scramjet) → use page as target
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createMockReddit } = require('./helpers/mock-reddit');
const { testEnv } = require('./helpers/harness');

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
      .forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome')));
  } catch (e) { /* no browser cache */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* not installed */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

const chromiumPath = findChromium();
const skip = !chromiumPath && 'no Chromium found (set CHROMIUM_PATH)';

let mock, server, baseUrl, browser;

test.before(async () => {
  if (skip) return;
  mock = createMockReddit();
  const redditBase = await mock.listen();
  Object.assign(process.env, testEnv({ REDDIT_BASE_URL: redditBase, SCRAPER_DEFAULT_DELAY_MS: '100', EMIS_API_KEY: '' }));
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (mock) await mock.close();
});

async function openApp(hash) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // No internet in CI: CDN assets (fonts, Chart.js, CodeMirror…) fail fast;
  // the scraper must still work (the editor falls back to a textarea).
  await page.route(/^https?:\/\/(?!localhost)/, route => route.abort());
  await page.goto(baseUrl + '/app.html' + (hash || ''));
  return { page, context, errors };
}

test('sidebar navigation opens the Scraper page', { skip }, async () => {
  const { page, context, errors } = await openApp('#dashboard');
  const nav = page.locator('.nav-item[data-view="scraper"]');
  await assert.doesNotReject(nav.waitFor());
  assert.equal((await nav.textContent()).trim(), 'Scraper');
  await nav.click();
  await page.waitForSelector('#sc-target-type');
  assert.equal(new URL(page.url()).hash, '#scraper');
  assert.equal(await page.textContent('#topbar-title'), 'Reddit Scraper');
  assert.ok(await nav.evaluate(el => el.classList.contains('active')));
  await page.waitForFunction(() => /Public pages|Reddit Data API/.test(document.querySelector('#sc-status').textContent));
  assert.deepEqual(await page.$$eval('#sc-target-type option', o => o.map(x => x.value)),
    ['subreddit', 'search', 'post', 'user', 'url', 'listing', 'subreddit_about', 'user_about']);
  assert.deepEqual(errors.filter(e => !/is not defined/.test(e)), []);
  await context.close();
});

test('target validation in the form', { skip }, async () => {
  const { page, context } = await openApp('#scraper');
  await page.waitForSelector('#sc-f-subreddit');
  await page.fill('#sc-f-subreddit', 'not valid!');
  await page.click('#sc-start');
  assert.match(await page.textContent('#sc-form-error'), /isn't a valid subreddit name/);
  assert.equal(await page.isVisible('#sc-job'), false);

  await page.selectOption('#sc-target-type', 'url');
  await page.fill('#sc-f-url', 'https://www.reddit.com/r/test/s/AbCdEf');
  await page.click('text=Check');
  await page.waitForFunction(() => /share links/.test(document.querySelector('#sc-form-error').textContent));
  await page.fill('#sc-f-url', 'https://www.reddit.com/r/AskScience/top/?t=week');
  await page.click('text=Check');
  await page.waitForSelector('.sc-resolved');
  assert.match(await page.textContent('.sc-resolved'), /r\/AskScience · top \(week\)/);
  await context.close();
});

test('standard scrape: start → progress → results → filter → export → add to project', { skip }, async () => {
  const { page, context } = await openApp('#scraper');
  await page.selectOption('#sc-target-type', 'subreddit');
  await page.fill('#sc-f-subreddit', 'test');
  await page.selectOption('#sc-f-sort', 'new');
  await page.fill('#sc-o-maxItems', '120');
  await page.click('#sc-start');
  await page.waitForSelector('#sc-job-status');
  await page.waitForFunction(() => document.querySelector('#sc-job-status').textContent === 'Completed', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.sc-table tbody tr').length === 120);
  assert.equal(await page.textContent('#sc-count-badge'), '120');
  assert.match(await page.textContent('#sc-stats'), /120\s*Items/);

  // Search / filter
  await page.fill('#sc-search', 'Post 7 in');
  await page.waitForFunction(() => document.querySelectorAll('.sc-table tbody tr').length === 1);

  // Record detail
  await page.click('.sc-table tbody tr');
  await page.waitForSelector('.modal-backdrop.is-open');
  assert.match(await page.textContent('#modal-body'), /permalink/);
  await page.click('#modal-close');
  await page.fill('#sc-search', '');
  await page.waitForFunction(() => document.querySelectorAll('.sc-table tbody tr').length === 120);

  // Logs and metadata tabs
  await page.click('.sc-tab[data-tab="logs"]');
  assert.match(await page.textContent('#sc-logs'), /Target: r\/test · new/);
  await page.click('.sc-tab[data-tab="meta"]');
  assert.match(await page.textContent('#sc-tab-body'), /subscribers/);
  await page.click('.sc-tab[data-tab="json"]');
  const parsed = JSON.parse(await page.textContent('#sc-json'));
  assert.equal(parsed.length, 120);
  await page.click('.sc-tab[data-tab="table"]');

  // Export CSV
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.selectOption('select[aria-label="Export"]', 'csv')
  ]);
  assert.match(download.suggestedFilename(), /^reddit_test_[0-9a-f]{8}\.csv$/);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  assert.ok(csv.includes('record_type,post_id'));
  assert.equal(csv.trim().split('\r\n').length, 121);

  // Add to project → posts appear in the project
  await page.click('text=Add to project');
  await page.waitForSelector('#sc-add-posts');
  await page.click('#modal-foot >> text=Add');
  await page.waitForFunction(() => document.getElementById('stat-posts').textContent === '120');
  const posts = await page.evaluate(() => App.getState().posts);
  assert.equal(posts.length, 120);
  assert.match(posts[0].id, /^reddit_/);
  assert.ok(posts[0].text.startsWith('Post '));
  assert.equal(typeof posts[0].engagement.likes, 'number');
  // Adding again adds nothing new.
  await page.click('text=Add to project');
  await page.click('#modal-foot >> text=Add');
  assert.equal(await page.evaluate(() => App.getState().posts.length), 120);

  // The job is listed and survives a reload (jobs live on the server).
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#sc-jobs-list tbody tr').length >= 1);
  await page.waitForFunction(() => document.querySelector('#sc-count-badge') && document.querySelector('#sc-count-badge').textContent === '120');
  await context.close();
});

test('custom code: write a scraper, run it in the sandbox, see results', { skip }, async () => {
  const { page, context } = await openApp('#scraper');
  await page.click('.sc-mode[data-mode="custom"]');
  await page.waitForSelector('#sc-code');
  assert.equal(await page.isVisible('#sc-custom'), true);
  await page.click('text=API reference');
  assert.match(await page.textContent('#modal-body'), /ctx\.reddit\.pages/);
  await page.click('#modal-close');
  await page.fill('#sc-code', [
    'async function scrape(ctx) {',
    '  const { items } = await ctx.reddit.listing("/r/" + ctx.params.sub + "/hot", { maxPages: 1, maxItems: 5 });',
    '  ctx.log.info("custom run", items.length);',
    '  return items.map(p => ({ record_type: "post", post_id: p.post_id, fullname: p.fullname, title: "[custom] " + p.title, score: p.score }));',
    '}'
  ].join('\n'));
  await page.fill('#sc-params', '{ "sub": "test" }');
  await page.selectOption('#sc-target-type', 'none');
  await page.click('#sc-start');
  await page.waitForFunction(() => document.querySelector('#sc-job-status') && document.querySelector('#sc-job-status').textContent === 'Completed', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.sc-table tbody tr').length === 5);
  assert.match(await page.textContent('.sc-table tbody tr'), /\[custom\] Post/);
  await page.click('.sc-tab[data-tab="logs"]');
  assert.match(await page.textContent('#sc-logs'), /\[code\] custom run 5/);

  // A failing script shows the sandbox's error.
  await page.fill('#sc-code', 'async function scrape(ctx) {\n  throw new Error("deliberate failure");\n}');
  await page.click('#sc-start');
  await page.waitForFunction(() => document.querySelector('#sc-job-status') && document.querySelector('#sc-job-status').textContent === 'Failed', null, { timeout: 30000 });
  assert.match(await page.textContent('.sc-error-box'), /deliberate failure/);
  await context.close();
});

test('cancel a running job from the UI', { skip }, async () => {
  const { page, context } = await openApp('#scraper');
  await page.click('.sc-mode[data-mode="standard"]');
  await page.selectOption('#sc-target-type', 'subreddit');
  await page.fill('#sc-f-subreddit', 'slowui');
  await page.fill('#sc-o-maxItems', '400');
  await page.fill('#sc-o-maxPages', '4');
  await page.fill('#sc-o-delay', '3');
  await page.click('#sc-start');
  await page.waitForFunction(() => document.querySelector('#sc-job-status') && document.querySelector('#sc-job-status').textContent === 'Running');
  await page.click('#sc-cancel');
  await page.waitForFunction(() => document.querySelector('#sc-job-status').textContent === 'Cancelled', null, { timeout: 15000 });
  await context.close();
});

test('in-app Reddit browser (Scramjet) loads pages through Wisp and sets the target', { skip }, async () => {
  const { page, context } = await openApp('#scraper');
  await page.waitForFunction(() => /Public pages|Reddit Data API/.test(document.querySelector('#sc-status').textContent));
  await page.click('#sc-browser-toggle');
  const redditBase = 'http://localhost:' + mock.server.address().port;
  await page.fill('#sc-browser-url', redditBase + '/r/test/');
  const frame = page.frameLocator('#sc-browser-frame');
  await frame.locator('#mock-title').waitFor({ timeout: 30000 });
  await page.click('.sc-browser-bar button[type=submit]');
  await frame.locator('#mock-link').click();
  await frame.locator('#mock-title:has-text("/comments/abc123/")').waitFor({ timeout: 15000 });
  await page.click('text=Use this page as target');
  await page.waitForSelector('.sc-resolved', { timeout: 10000 });
  assert.match(await page.textContent('.sc-resolved'), /Post abc123 in r\/test/);
  assert.equal(await page.inputValue('#sc-target-type'), 'url');
  // Requests from the browser reached the mock only through the Wisp proxy.
  assert.ok(mock.state.requests.some(r => r.path === '/r/test/comments/abc123/hello/'));
  await context.close();
});
