// Reddit Collector (collector/), end to end in Chromium: the built app served
// by MetaCode at /collector/, Reddit pages loaded through real Scramjet (service
// worker + rewriter + epoxy-tls over MetaCode's Wisp endpoint), the bot reading
// them through the Scramjet plugin bridge, IndexedDB, the dashboard and exports.
//
// "Reddit" here is a local stand-in (helpers/collector-mock.js) that MetaCode's
// proxy is allowed to reach (REDDIT_BASE_URL). It proves the Scramjet
// integration and the bot; it does not prove that live reddit.com pages work —
// see collector/README.md "Manual live check".
//
// Skipped when the collector hasn't been built (npm run collector:build) or no
// Chromium is available.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createCollectorMock } = require('./helpers/collector-mock');
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
const built = fs.existsSync(path.join(__dirname, '..', 'collector', 'dist', 'index.html'));
const skip = !built ? 'collector not built (npm run collector:install && npm run collector:build)' : !chromiumPath ? 'no Chromium found (set CHROMIUM_PATH)' : false;

let mock, mirror, server, base, browser;

test.before(async () => {
  if (skip) return;
  mock = createCollectorMock();
  mirror = await mock.listen();
  Object.assign(process.env, testEnv({ REDDIT_BASE_URL: mirror, EMIS_API_KEY: '' }));
  const { start } = require('../server');
  server = await start(0);
  base = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (mock) await mock.close();
});

/** A fresh browser profile with the collector pointed at the mock Reddit. */
async function openCollector(settings) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/collector/#settings');
  await page.waitForSelector('#set-base');
  await page.selectOption('#set-base', 'other');
  await page.fill('#set-base-other', mirror);
  await page.fill('#set-pageDelayMs', String((settings && settings.pageDelayMs) || 1000));
  await page.fill('#set-scrollDelayMs', '500');
  if (settings && settings.robots === 'warn') await page.check('#set-robots-warn');
  await page.click('#settings-save');
  await page.waitForSelector('.notice-ok');
  return { context, page, errors };
}

async function runJob(page, { subreddits, mode, maxPosts, maxComments }) {
  await page.click('nav a[href="#new"]');
  await page.waitForFunction(() => !document.querySelector('#job-start').disabled, null, { timeout: 30000 });
  await page.fill('#job-subreddits', subreddits);
  if (mode) await page.click('label:has-text("' + mode + '")');
  await page.fill('#job-max-posts', String(maxPosts || 5));
  if (maxComments !== undefined) await page.fill('#job-max-comments', String(maxComments));
  await page.click('#job-start');
  await page.waitForSelector('#monitor-outcome', { timeout: 90000 });
  return page.textContent('#monitor-outcome');
}

const read = async download => fs.readFileSync(await download.path(), 'utf8');

test('collects posts (infinite scroll) and comments through Scramjet, shows and exports them', { skip, timeout: 180000 }, async () => {
  const { context, page, errors } = await openCollector();
  const before = mock.state.requests.length;
  const outcome = await runJob(page, { subreddits: 'alpha', mode: 'Posts and comments', maxPosts: 7, maxComments: 2 });
  assert.equal(outcome, 'Reached the limit of 7 posts.');
  assert.equal(await page.textContent('#monitor-posts'), '7');
  const sent = mock.state.requests.slice(before).map(r => r.path);
  assert.ok(sent.includes('/robots.txt'), 'robots.txt was read first');
  assert.ok(sent.some(p => p.startsWith('/svc/more?sub=alpha')), 'scrolling made the page load more posts');
  assert.equal(sent.filter(p => /^\/r\/alpha\/comments\//.test(p)).length, 7, 'each post page opened once');
  assert.ok(mock.state.requests.slice(before).every(r => /Chrome/.test(r.ua)), 'requests came from the browser, through the proxy');

  // Explorer: posts, a post's details and its comment thread; text is shown as text
  await page.click('nav a[href="#data"]');
  await page.waitForFunction(() => /^7 posts/.test(document.querySelector('#explorer-count').textContent));
  assert.equal(await page.locator('#explorer-table tbody tr').count(), 7);
  assert.equal(await page.locator('#explorer-table b').count(), 0, 'markup in a title is not rendered');
  await page.click('#explorer-table tbody tr:has-text("Post 3 in r/alpha")');
  await page.waitForSelector('#record-detail');
  const detail = await page.textContent('#record-detail');
  assert.match(detail, /score 0/, 'a real zero score');
  assert.match(detail, /Full text of qal3\.\s*Second paragraph\./);
  assert.match(detail, /Collected comments \(2\)/);
  assert.match(detail, /Top comment on qal3/);
  assert.equal(await page.getAttribute('#record-detail a:has-text("Open on Reddit")', 'href'), 'https://www.reddit.com/r/alpha/comments/qal3/post_qal3/');
  await page.fill('#explorer-search', 'post 2');
  await page.waitForFunction(() => /^1 post/.test(document.querySelector('#explorer-count').textContent));
  await page.fill('#explorer-search', '');
  await page.click('label:has-text("Comments")');
  await page.waitForFunction(() => /^14 comments/.test(document.querySelector('#explorer-count').textContent));

  // Exports: JSON (everything), JSONL, CSV (two files)
  await page.selectOption('select[aria-label="Export format"]', 'json');
  const [json] = await Promise.all([page.waitForEvent('download'), page.click('#export-all')]);
  const doc = JSON.parse(await read(json));
  assert.equal(doc.schema_version, 1);
  assert.deepEqual([doc.posts.length, doc.comments.length], [7, 14]);
  const p2 = doc.posts.find(p => p.id === 'qal2');
  assert.equal(p2.title, 'Post 2 in r/alpha — <b>not bold</b> & "quoted"');
  assert.equal(p2.url, 'https://www.reddit.com/r/alpha/comments/qal2/post_qal2/');
  assert.equal(p2.details_collected, true);
  assert.equal(doc.posts.find(p => p.id === 'qal3').score, 0);
  const c = doc.comments.find(x => x.id === 'qal2b');
  assert.deepEqual([c.post_id, c.parent_comment_id, c.depth], ['qal2', 'qal2a', 1]);

  await page.selectOption('select[aria-label="Export format"]', 'jsonl');
  const [jsonl] = await Promise.all([page.waitForEvent('download'), page.click('#export-filtered')]);
  const lines = (await read(jsonl)).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 14, 'the filtered export holds only the comments shown');
  assert.ok(lines.every(l => l.record_type === 'comment'));

  await page.selectOption('select[aria-label="Export format"]', 'csv');
  const files = [];
  page.on('download', d => files.push(d));
  await page.click('#export-all');
  await page.waitForFunction(() => /Exported 7 posts and 14 comments/.test(document.body.textContent));
  for (let i = 0; i < 50 && files.length < 2; i++) await page.waitForTimeout(100);
  const names = files.map(f => f.suggestedFilename()).sort();
  assert.match(names[0], /^reddit-collector-\d{8}-\d{4}-comments\.csv$/);
  assert.match(names[1], /-posts\.csv$/);
  const postsCsv = await read(files.find(f => /posts\.csv$/.test(f.suggestedFilename())));
  assert.ok(postsCsv.startsWith('﻿record_type,id,fullname,url,subreddit,title,body,author,created_at,score,num_comments,'));
  assert.equal(postsCsv.trim().split('\r\n').length, 8);

  // Everything survives a reload (IndexedDB)
  await page.goto(base + '/collector/#overview');
  await page.waitForFunction(() => /7\s*Posts collected/.test(document.querySelector('#overview-stats').textContent));
  assert.match(await page.textContent('#overview-stats'), /14\s*Comments collected/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('robots.txt: "obey" stops a disallowed job before any page loads; "warn" runs it and records why', { skip, timeout: 120000 }, async () => {
  mock.state.robots = 'User-agent: *\nDisallow: /\n';
  try {
    let { context, page } = await openCollector();
    const before = mock.state.requests.length;
    const outcome = await runJob(page, { subreddits: 'beta', maxPosts: 3 });
    assert.match(outcome, /robots\.txt disallows automated access to \/r\/beta\/new\/ \(Disallow: \/\)/);
    assert.match(await page.textContent('.chip'), /Failed/);
    const sent = mock.state.requests.slice(before).map(r => r.path);
    assert.ok(sent.includes('/robots.txt'), 'robots.txt was read');
    // (the browser panel may still be loading the home page it opened when the settings were saved)
    assert.deepEqual(sent.filter(p => p !== '/robots.txt' && p !== '/'), [], 'the job opened no Reddit page');
    await context.close();

    ({ context, page } = await openCollector({ robots: 'warn' }));
    assert.match(await runJob(page, { subreddits: 'beta', maxPosts: 3 }), /Reached the limit of 3 posts/);
    assert.match(await page.textContent('.monitor'), /Continuing because Settings/);
    await context.close();
  } finally {
    mock.state.robots = 'User-agent: *\nAllow: /\n';
  }
});

test('Reddit refusing (block page) stops the job; a dropped connection is retried, then recorded', { skip, timeout: 180000 }, async () => {
  const { context, page } = await openCollector();
  await page.click('nav a[href="#settings"]');
  await page.fill('#set-maxRetries', '1');
  await page.click('#settings-save');
  await page.waitForSelector('.notice-ok');

  mock.state.brokenHits = 0;
  const outcome = await runJob(page, { subreddits: 'broken gamma', maxPosts: 3 });
  assert.match(outcome, /Reached the limit of 3 posts/, 'the job went on to the next subreddit');
  assert.equal(mock.state.brokenHits, 2, 'the dropped page was tried twice (1 retry)');
  assert.match(await page.textContent('.log'), /Couldn't load r\/broken after 2 tries/);
  assert.match(await page.textContent('.monitor'), /1\s*Retries/);

  assert.match(await runJob(page, { subreddits: 'blocked', maxPosts: 3 }), /Reddit blocked this browser's requests/);
  await page.click('nav a[href="#overview"]');
  await page.waitForSelector('.errors');
  assert.match(await page.textContent('.errors'), /blocked/);
  await context.close();
});

test('pause, resume and stop from the monitor; the browser panel only opens public Reddit pages', { skip, timeout: 180000 }, async () => {
  const prev = { total: mock.state.total, pageSize: mock.state.pageSize };
  Object.assign(mock.state, { total: 400, pageSize: 3 });
  const { context, page } = await openCollector();
  try {
    await page.click('nav a[href="#new"]');
    await page.waitForFunction(() => !document.querySelector('#job-start').disabled, null, { timeout: 30000 });
    await page.fill('#job-subreddits', 'delta');
    await page.fill('#job-max-posts', '300');
    await page.fill('#job-max-depth', '100');
    await page.click('#job-start');
    await page.waitForFunction(() => Number(document.querySelector('#monitor-posts').textContent) >= 3, null, { timeout: 60000 });
    await page.click('#job-pause');
    await page.waitForFunction(() => /Paused/.test(document.querySelector('.chip').textContent));
    await page.waitForTimeout(1500);                       // a step that was running finishes
    const paused = mock.state.requests.length;
    await page.waitForTimeout(2500);
    assert.equal(mock.state.requests.length, paused, 'nothing new is loaded while paused');
    await page.click('#job-resume');
    await page.waitForFunction(n => Number(document.querySelector('#monitor-posts').textContent) > n, Number(await page.textContent('#monitor-posts')), { timeout: 60000 });
    await page.click('#job-stop');
    await page.waitForSelector('#monitor-outcome', { timeout: 30000 });
    assert.equal(await page.textContent('#monitor-outcome'), 'Stopped by you.');
    const saved = Number(await page.textContent('#monitor-posts'));
    assert.ok(saved > 3 && saved < 300);

    // The browser panel: Reddit's public pages only
    await page.fill('input[aria-label="Reddit address"]', 'https://www.reddit.com/login/');
    await page.click('.browser-bar button[type=submit]');
    assert.match(await page.textContent('.field-error'), /Login, account, message and moderation pages aren't opened/);
    await page.fill('input[aria-label="Reddit address"]', 'https://example.com/');
    await page.click('.browser-bar button[type=submit]');
    assert.match(await page.textContent('.field-error'), /Only Reddit pages/);
    await page.fill('input[aria-label="Reddit address"]', 'r/epsilon');
    await page.click('.browser-bar button[type=submit]');
    await page.frameLocator('#collector-frame').locator('h1:has-text("r/epsilon")').waitFor({ timeout: 30000 });
  } finally {
    Object.assign(mock.state, prev);
    await context.close();
  }
});

test('the dashboard says what is wrong when Scramjet can\'t be used', { skip, timeout: 60000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/api/scraper/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowedHosts: [], browser: { enabled: false } }) }));
  await page.goto(base + '/collector/#new');
  await page.waitForSelector('#job-start');
  assert.equal(await page.isDisabled('#job-start'), true);
  assert.match(await page.textContent('.browser'), /Reddit browser is turned off \(SCRAPER_BROWSER_ENABLED=false\)/);
  await context.close();
});

test('a Reddit server that closes idle connections sooner than the pause between pages doesn\'t stall the next page', { skip, timeout: 120000 }, async () => {
  // After ~2 s idle, epoxy-tls reuses a keep-alive connection the server has closed and waits forever
  // (each page "didn't load within 30 s"). On Reddit the pause between pages is 6 s or more.
  const { context, page, errors } = await openCollector({ pageDelayMs: 3000 });
  mock.server.keepAliveTimeout = 300;
  try {
    const started = Date.now();
    assert.equal(await runJob(page, { subreddits: 'idle', mode: 'Posts and comments', maxPosts: 3, maxComments: 2 }), 'Reached the limit of 3 posts.');
    assert.ok(Date.now() - started < 40000, 'no page waited for a dead connection (took ' + (Date.now() - started) + ' ms)');
    assert.doesNotMatch(await page.textContent('ol.log'), /didn't load/);
    assert.equal(await page.textContent('#browser-connection'), 'Connected through Wisp (WebSocket, end-to-end TLS).');
  } finally { mock.server.keepAliveTimeout = 5000; }
  assert.deepEqual(errors, []);
  await context.close();
});

test('when the /wisp/ WebSocket can\'t open (e.g. a reverse proxy drops it), pages load through MetaCode\'s HTTP relay', { skip, timeout: 120000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.routeWebSocket(/\/wisp\//, ws => ws.close({ code: 1006 }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/collector/#settings');
  await page.waitForSelector('#set-base');
  await page.selectOption('#set-base', 'other');
  await page.fill('#set-base-other', mirror);
  await page.fill('#set-pageDelayMs', '1000');
  await page.click('#settings-save');
  await page.waitForSelector('.notice-ok');
  assert.match(await runJob(page, { subreddits: 'relayed', mode: 'Posts and comments', maxPosts: 6, maxComments: 2 }), /Reached the limit of 6 posts/);
  const conn = await page.textContent('#browser-connection');
  assert.match(conn, /HTTP relay/);
  assert.match(conn, /WebSocket to MetaCode's proxy \(\/wisp\/\) didn't open/);
  assert.ok(mock.state.requests.some(r => r.path.startsWith('/svc/more?sub=relayed')), 'the page\'s own scripts ran and fetched through the relay');
  assert.deepEqual(errors, []);

  // "Wisp only" says what is wrong instead of falling back
  await page.click('nav a[href="#settings"]');
  await page.selectOption('#set-connection', 'wisp');
  await page.click('#settings-save');
  await page.reload();
  await page.waitForFunction(() => /didn't open/.test(document.querySelector('.browser').textContent), null, { timeout: 30000 });
  assert.match(await page.textContent('.browser'), /set Settings → Connection to Automatic/);
  await context.close();
});

test('inside MetaCode: the Scraper page shows the collector, and "Add to project" puts posts and comments (with engagement) in the project', { skip, timeout: 180000 }, async () => {
  const { context, page, errors } = await openCollector();
  await page.route(/^https?:\/\/(?!localhost)/, route => route.abort());   // no CDN in tests
  await page.goto(base + '/app.html#scraper');
  await page.waitForSelector('#cv-frame');
  assert.equal(await page.textContent('#topbar-title'), 'Reddit Scraper');
  const frame = page.frameLocator('#cv-frame');
  await frame.locator('.app.is-embedded').waitFor();
  assert.equal(await frame.locator('.brand').isVisible(), false, 'MetaCode already shows its own header');

  await frame.locator('nav a[href="#new"]').click();
  await frame.locator('#job-start:not([disabled])').waitFor({ timeout: 30000 });
  await frame.locator('#job-subreddits').fill('embedded');
  await frame.locator('label:has-text("Posts and comments")').click();
  await frame.locator('#job-max-posts').fill('4');
  await frame.locator('#job-max-comments').fill('2');
  await frame.locator('#job-start').click();
  await frame.locator('#monitor-outcome').waitFor({ timeout: 90000 });
  assert.equal(await frame.locator('#monitor-outcome').textContent(), 'Reached the limit of 4 posts.');

  // Monitor → add this job's posts and comments
  await frame.locator('#job-add-to-project').click();
  await frame.locator('#job-added').waitFor();
  assert.match(await frame.locator('#job-added').textContent(), /^Added 12 to the project \(12 posts in the project\)\. Their engagement shows in Metrics\.$/);
  let posts = await page.evaluate(() => App.getState().posts);
  assert.equal(posts.length, 12);
  const post = posts.find(p => p.id === 'reddit_qem1');
  assert.equal(post.text, 'Post 1 in r/embedded\n\nFull text of qem1.\n\nSecond paragraph.', 'the whole post, not only its title');
  assert.deepEqual(post.engagement, { likes: 99, shares: null, comments: 3, views: null });
  assert.equal(post.source.permalink, 'https://www.reddit.com/r/embedded/comments/qem1/post_qem1/');
  const reply = posts.find(p => p.id === 'reddit_c_qem1b');
  assert.equal(reply.text, 'Reply to qem1a');
  assert.deepEqual([reply.engagement.likes, reply.source.type, reply.source.post_id, reply.source.parent_id], [2, 'comment', 'qem1', 't1_qem1a']);

  // Data → "Add these 4 to project": already there; a changed number is refreshed, codes and other numbers kept
  await frame.locator('nav a[href="#data"]').click();
  await frame.locator('#add-to-project:has-text("Add these 4 to project")').click();
  await frame.locator('.notice-ok:has-text("already in the project")').waitFor();
  await page.evaluate(() => App.setState({ posts: App.getState().posts.map(p => p.id === 'reddit_qem1'
    ? { ...p, engagement: { ...p.engagement, likes: 1, views: 50 }, humanCodes: { tone: 'pos' } } : p) }));
  await frame.locator('#add-to-project').click();
  await frame.locator('.notice-ok:has-text("updated the engagement numbers of 1")').waitFor();
  posts = await page.evaluate(() => App.getState().posts);
  assert.equal(posts.length, 12);
  const again = posts.find(p => p.id === 'reddit_qem1');
  assert.deepEqual(again.engagement, { likes: 99, shares: null, comments: 3, views: 50 });
  assert.deepEqual(again.humanCodes, { tone: 'pos' });

  // Metrics shows them
  await page.click('.nav-item[data-view="metrics"]');
  await page.waitForSelector('#eng-posts');
  assert.match(await page.textContent('#view-container'), /Avg Likes/);

  // Someone else's page can't add posts: only the collector frame, same origin
  const before = (await page.evaluate(() => App.getState().posts)).length;
  await page.evaluate(() => window.postMessage({ type: 'metacode-collector:add-to-project', id: 1, posts: [{ id: 'reddit_zzz', text: 'x', engagement: {} }] }, '*'));
  await page.waitForTimeout(200);
  assert.equal((await page.evaluate(() => App.getState().posts)).length, before);
  assert.deepEqual(errors.filter(e => !/is not defined/.test(e)), []);
  await context.close();
});
