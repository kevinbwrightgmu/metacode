// The Scraper page's platform menu in a real browser, against the full server
// and stand-ins for the YouTube Data API, X API v2 and LinkedIn's REST API:
// Reddit stays the default; YouTube with the user's own key (kept in the
// browser) collects a channel with viral scores and comments; the results,
// Add to project and the job list are shared; X uses the server's token;
// LinkedIn reads a Page's posts with the user's own token and imports a data
// archive (.zip, read in the browser: only the needed tables are sent); the
// choice of platform is remembered.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { testEnv } = require('./helpers/harness');
const zlib = require('zlib');
const { createYouTubeMock, createXMock, createLinkedInMock } = require('./helpers/platform-mocks');

// A .zip like LinkedIn's archive: deflated entries in a folder, with tables
// the import must not send (messages, connections)
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = Buffer.from(e.text), data = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

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
const MY_LI_TOKEN = 'li-users-own-token-e2e-000000000000';
let yt, xm, li, server, baseUrl, browser;

test.before(async () => {
  if (skip) return;
  yt = createYouTubeMock();
  xm = createXMock();
  li = createLinkedInMock();
  const ytBase = await yt.listen();
  const xBase = await xm.listen();
  const liBase = await li.listen();
  Object.assign(process.env, testEnv({ YOUTUBE_API_BASE_URL: ytBase, X_API_BASE_URL: xBase, LINKEDIN_API_BASE_URL: liBase, X_BEARER_TOKEN: 'server-x-token-000000000000',
    YOUTUBE_MIN_DELAY_MS: '0', X_MIN_DELAY_MS: '0', LINKEDIN_MIN_DELAY_MS: '0', EMIS_API_KEY: '' }));
  delete process.env.YOUTUBE_API_KEY;
  delete process.env.LINKEDIN_ACCESS_TOKEN;
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
  if (li) await li.close();
});

test('platform menu: Reddit by default; YouTube with your own key; X with the server token; LinkedIn posts and archive import; shared results and Add to project', { skip, timeout: 120000 }, async () => {
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

  // LinkedIn: no token on the server → add your own; a Page's posts with comments
  await page.click('.sc-platform-btn[data-platform="linkedin"]');
  await page.waitForSelector('#sc-platform:not([hidden]) .badge:has-text("No LinkedIn access token")');
  await page.fill('#pf-li-key', MY_LI_TOKEN);
  await page.click('text=Save token');
  await page.waitForSelector('.badge:has-text("Your LinkedIn access token")');
  await page.fill('#pf-linkedin-organization', 'https://www.linkedin.com/company/acme-research/');
  await page.fill('#pf-linkedin-maxPosts', '3');
  await page.check('#pf-linkedin-includeComments');
  await page.fill('#pf-linkedin-commentPosts', '1');
  await page.fill('#pf-linkedin-commentsPerPost', '2');
  await page.click('#pf-start');
  await page.waitForSelector('.sc-table td:has-text("Our #Research with @Acme Labs (new)")', { timeout: 30000 });
  assert.ok(li.seen.auth.length > 0 && li.seen.auth.every(a => a === 'Bearer ' + MY_LI_TOKEN), 'your token went with your job');
  assert.ok(await page.isVisible('.sc-table .badge:has-text("page")'));
  assert.ok(await page.isVisible('.sc-table td:has-text("Comment 2")'));
  await page.click('.sc-table td:has-text("Our #Research")');
  await page.waitForSelector('#modal-body:has-text("Like 2, Celebrate 1")');
  assert.ok(await page.isVisible('.modal-foot a:has-text("Open on LinkedIn")'));
  await page.click('.modal-foot button:has-text("Close")');

  // LinkedIn data archive: the .zip is read here and only the needed tables are sent
  await page.selectOption('#pf-linkedin-type', 'archive');
  assert.equal(await page.isVisible('#pf-li-key'), false, 'no token needed for an archive');
  const sent = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/scraper\/jobs$/.test(r.url())) sent.push(r.postData() || ''); });
  await page.setInputFiles('#pf-li-archive', { name: 'Basic_LinkedInDataExport_10-01-2026.zip', mimeType: 'application/zip', buffer: makeZip([
    { name: 'Basic_LinkedInDataExport_10-01-2026/Shares.csv', text: 'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n2024-03-05 14:22:31,https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7171/,"Archive post, line one\nline two",,,PUBLIC\n' },
    { name: 'Basic_LinkedInDataExport_10-01-2026/Comments.csv', text: 'Date,Link,Message\n2024-04-01 10:00:00,https://www.linkedin.com/feed/update/urn:li:activity:999/,"An archived comment"\n' },
    { name: 'Basic_LinkedInDataExport_10-01-2026/Profile.csv', text: 'First Name,Last Name,Address\nAda,Lovelace,"12 Private Road, London"\n' },
    { name: 'Basic_LinkedInDataExport_10-01-2026/messages.csv', text: 'FROM,TO,CONTENT\nsomeone,me,a private message\n' },
    { name: 'Basic_LinkedInDataExport_10-01-2026/Connections.csv', text: 'First Name,Last Name,Email Address\nBob,Smith,bob@example.org\n' }
  ]) });
  await page.waitForSelector('#pf-li-archive-summary .badge:has-text("Ready")');
  assert.match(await page.textContent('#pf-li-archive-summary'), /Shares\.csv.*Comments\.csv.*Profile\.csv/);
  await page.click('#pf-start');
  await page.waitForSelector('.sc-table td:has-text("Archive post, line one")', { timeout: 30000 });
  assert.ok(await page.isVisible('.sc-table td:has-text("An archived comment")'));
  assert.ok(await page.isVisible('.sc-table td:has-text("Ada Lovelace")'));
  assert.ok(await page.isVisible('.sc-table td:has-text("LinkedIn (archive)")'));
  assert.equal(sent.length, 1);
  assert.ok(!/private message|bob@example\.org/.test(sent[0]), 'messages and connections never left the browser');
  assert.ok(!sent[0].includes('Private Road') && sent[0].includes('Lovelace'), 'from Profile.csv, only the name was sent');

  // Jobs from every platform are in one list; the platform choice is remembered
  const list = await page.textContent('#sc-jobs-list');
  assert.match(list, /YouTube · channel @testchan/);
  assert.match(list, /X · search "research"/);
  assert.match(list, /LinkedIn · \/company\/acme-research/);
  assert.match(list, /LinkedIn · your data archive \(Ada Lovelace\)/);
  await page.click('.sc-platform-btn[data-platform="youtube"]');
  await page.reload();
  await page.waitForSelector('.sc-platform-btn[data-platform="youtube"].active');
  assert.deepEqual(errors, []);
  await context.close();
});
