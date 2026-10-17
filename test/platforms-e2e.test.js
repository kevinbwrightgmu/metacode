// The Scraper page's platform menu in a real browser, against the full server
// and stand-ins for the YouTube Data API and X API v2: Reddit stays the
// default; YouTube with the user's own key (kept in the browser) collects a
// channel with viral scores and comments; the results, Add to project and
// the job list are shared; X uses the server's token; LinkedIn explains why
// it isn't offered; the choice of platform is remembered.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { testEnv } = require('./helpers/harness');
const { createYouTubeMock, createXMock } = require('./helpers/platform-mocks');

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
const MY_KEY = 'users-own-youtube-key-123456';
let yt, xm, server, baseUrl, browser;

test.before(async () => {
  if (skip) return;
  yt = createYouTubeMock();
  xm = createXMock();
  const ytBase = await yt.listen();
  const xBase = await xm.listen();
  Object.assign(process.env, testEnv({ YOUTUBE_API_BASE_URL: ytBase, X_API_BASE_URL: xBase, X_BEARER_TOKEN: 'server-x-token-000000000000',
    YOUTUBE_MIN_DELAY_MS: '0', X_MIN_DELAY_MS: '0', EMIS_API_KEY: '' }));
  delete process.env.YOUTUBE_API_KEY;
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (yt) await yt.close();
  if (xm) await xm.close();
});

test('platform menu: Reddit by default; YouTube with your own key; X with the server token; LinkedIn explained; shared results and Add to project', { skip, timeout: 120000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addInitScript(() => { try { localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route => route.abort());
  await page.goto(baseUrl + '/app.html#scraper');

  // Reddit is the default platform, with its usual form
  await page.waitForSelector('.sc-platform-btn[data-platform="reddit"].active');
  assert.equal(await page.isVisible('#sc-target-type'), true);
  assert.equal(await page.textContent('#topbar-title'), 'Scraper');

  // YouTube: no key on the server → add your own (kept in this browser)
  await page.click('.sc-platform-btn[data-platform="youtube"]');
  await page.waitForSelector('#sc-platform:not([hidden]) .badge:has-text("No YouTube API key")');
  assert.equal(await page.isVisible('#sc-target-type'), false, 'the Reddit form is hidden');
  assert.equal(await page.isVisible('#sc-browser-toggle'), false, 'Browse Reddit is Reddit-only');
  await page.fill('#pf-yt-key', MY_KEY);
  await page.click('text=Save key');
  await page.waitForSelector('.badge:has-text("Your YouTube API key")');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('metacode.scraper.platformKeys')).youtube), MY_KEY);

  // A channel, 4 videos, viral scores, comments of the first 2
  await page.selectOption('#pf-youtube-type', 'channel');
  await page.fill('#pf-youtube-channel', '@testchan');
  await page.fill('#pf-youtube-maxVideos', '4');
  await page.check('#pf-youtube-viral');
  await page.check('#pf-youtube-includeComments');
  await page.fill('#pf-youtube-commentVideos', '2');
  assert.match(await page.textContent('#pf-yt-quota'), /About \d+ quota units/);
  await page.click('#pf-start');
  await page.waitForSelector('#sc-job .badge:has-text("completed")', { timeout: 30000 });
  assert.ok(yt.seen.keys.length > 0 && yt.seen.keys.every(k => k === MY_KEY), 'your key went with your job');
  await page.waitForSelector('.sc-table td:has-text("Video 0 about dogs")');
  assert.ok(await page.isVisible('.sc-table td:has-text("Test Channel")'), 'the Where column shows the channel');
  assert.ok(await page.isVisible('.sc-table .badge:has-text("channel")'));
  await page.click('.sc-table td:has-text("Video 0 about dogs")');
  await page.waitForSelector('#modal-body:has-text("viral_category")');
  assert.ok(await page.isVisible('.modal-foot a:has-text("Open on YouTube")'));
  assert.equal(await page.isVisible('text=Open in Reddit browser'), false);
  await page.click('.modal-foot button:has-text("Close")');

  // Add to project: videos become posts with their engagement
  await page.click('button:has-text("Add to project")');
  await page.click('#modal-foot button:has-text("Add")');
  const posts = await page.evaluate(() => App.getState().posts.filter(p => p.source && p.source.platform === 'youtube'));
  assert.equal(posts.length, 4);
  assert.equal(posts[0].id, 'youtube_vid00000000');
  assert.equal(posts[0].engagement.views, 20000);
  assert.equal(posts[0].source.channel, 'Test Channel');

  // X: the server's token; search Latest
  await page.click('.sc-platform-btn[data-platform="x"]');
  await page.waitForSelector('.badge:has-text("This server\'s X token")');
  await page.fill('#pf-x-query', 'research');
  await page.fill('#pf-x-maxPosts', '5');
  await page.click('#pf-start');
  await page.waitForSelector('.sc-table td:has-text("Post number 1")', { timeout: 30000 });
  assert.ok(await page.isVisible('.sc-table td:has-text("testuser")'));

  // LinkedIn: explained, nothing to start
  await page.click('.sc-platform-btn[data-platform="linkedin"]');
  await page.waitForSelector('#sc-platform:has-text("LinkedIn isn\'t available")');
  assert.equal(await page.isVisible('#pf-start'), false);

  // Jobs from every platform are in one list; the platform choice is remembered
  const list = await page.textContent('#sc-jobs-list');
  assert.match(list, /YouTube · channel @testchan/);
  assert.match(list, /X · search "research"/);
  await page.click('.sc-platform-btn[data-platform="youtube"]');
  await page.reload();
  await page.waitForSelector('.sc-platform-btn[data-platform="youtube"].active');
  assert.deepEqual(errors, []);
  await context.close();
});
