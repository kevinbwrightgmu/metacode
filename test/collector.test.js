// AI Scraper (beta), end to end in Chromium: the app (collector/, served by
// MetaCode at /collector/ and shown on the "AI Scraper" page) starts an AI job;
// MetaCode's server runs the agent (python/ai_scraper.py), which asks a stand-in
// for MetaCode's AI service what to do and calls Reddit through the server
// (a stand-in for Reddit here); the app follows the job live, copies the posts
// the AI kept into IndexedDB, shows them in Data and adds them to the project.
//
// This proves the pieces work together. It doesn't prove what a real AI model
// does with a real goal, or that live Reddit answers this server.
//
// Skipped when the app hasn't been built (npm run collector:build), or when
// Chromium or Python 3 isn't available.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMockReddit } = require('./helpers/mock-reddit');
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
const python = ['python3', 'python'].some(cmd => { try { return spawnSync(cmd, ['--version']).status === 0; } catch (e) { return false; } });
const skip = !built ? 'the AI Scraper app isn\'t built (npm run collector:install && npm run collector:build)'
  : !chromiumPath ? 'no Chromium found (set CHROMIUM_PATH)' : !python ? 'Python 3 not found' : false;

// A stand-in for MetaCode's AI service (OpenAI-style API). It plays a simple
// agent: search r/test, keep three of the posts found, finish.
const ai = { requests: [], delayMs: 0 };
function scriptedReply(messages) {
  const done = messages.filter(m => m.role === 'assistant').length;
  const last = String(messages[messages.length - 1].content);
  if (done === 0) return { thought: 'Look in r/test first.', tool: 'search_posts', args: { query: 'post', subreddit: 'test', limit: 4 } };
  if (done === 1) return { thought: 'These three fit.', tool: 'keep', args: { post_ids: Array.from(last.matchAll(/\[([a-z0-9]{3,12})\]/g), m => m[1]).slice(0, 3), reason: 'on topic' } };
  return { thought: 'Enough.', tool: 'finish', args: { summary: 'Three posts from r/test.' } };
}
const aiService = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'scraper-model' }, { id: 'other-model' }] }));
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
    const j = JSON.parse(body || '{}');
    ai.requests.push({ model: j.model, messages: j.messages });
    const content = JSON.stringify(scriptedReply(j.messages));
    setTimeout(() => res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })), ai.delayMs);
  });
});

let reddit, server, base, browser;

test.before(async () => {
  if (skip) return;
  reddit = createMockReddit();
  const redditBase = await reddit.listen();
  await new Promise(r => aiService.listen(0, '127.0.0.1', r));
  Object.assign(process.env, testEnv({ REDDIT_BASE_URL: redditBase,
    OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + aiService.address().port + '/v1', OPENCODE_SERVICE_TOKEN: 'test-service-token-0123456789' }));
  const { start } = require('../server');
  server = await start(0);
  base = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (reddit) await reddit.close();
  aiService.close();
});

async function openPage(url, init) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, route => route.abort());     // no CDN in tests
  await page.goto(base + url);
  return { context, page, errors };
}

// The tests reach the mock Reddit through the server (there is no RedditAPIs.com key here).
async function startJob(scope, goal, maxPosts) {
  await scope.locator('nav a[href="#new"]').click();
  await scope.locator('#job-access').selectOption('server');
  await scope.locator('#job-goal').fill(goal);
  if (maxPosts) await scope.locator('#job-max-posts').fill(String(maxPosts));
  await scope.locator('#job-start:not([disabled])').click();
  await scope.locator('#monitor-goal').waitFor();
}

test('the AI Scraper on its own: describe the goal, watch the AI\'s steps, find the posts in Data', { skip, timeout: 120000 }, async () => {
  const { context, page, errors } = await openPage('/collector/#overview');
  try {
    await page.waitForSelector('#overview-stats');
    await page.click('nav a[href="#new"]');
    // RedditAPIs.com is the default; without a key, Start waits for one (or another choice)
    assert.equal(await page.inputValue('#job-access'), 'redditapis');
    assert.match(await page.textContent('#job-access option[value="redditapis"]'), /RedditAPIs\.com \(add your API key\)/);
    assert.match(await page.textContent('#job-access-note'), /Add your key on MetaCode's Reddit Scraper page/);
    await page.fill('#job-goal', 'Posts about testing in r/test');
    assert.equal(await page.isDisabled('#job-start'), true);
    await page.selectOption('#job-access', 'server');
    assert.match(await page.textContent('#job-access-note'), /Reddit often blocks servers/);
    assert.equal(await page.isDisabled('#job-start'), false);
    const before = ai.requests.length;
    await startJob(page, 'Posts about testing in r/test', 5);
    await page.waitForSelector('#monitor-outcome', { timeout: 60000 });
    assert.equal(await page.textContent('#monitor-outcome'), 'The AI finished: 3 posts kept.');
    assert.equal(await page.textContent('#monitor-summary'), 'The AI\'s summary: Three posts from r/test.');
    assert.equal(await page.textContent('#monitor-posts'), '3');
    const steps = await page.$$eval('#monitor-steps li', li => li.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
    assert.equal(steps.length, 3);
    assert.match(steps[0], /^1 Search "post" · r\/test · relevance all Look in r\/test first\. → search_posts "post" in r\/test \(relevance, all\) → 4 posts$/);
    assert.match(steps[1], /^2 Keep posts 3 posts These three fit\. → keep → 3 new$/);
    assert.match(steps[2], /^3 Finish/);
    // The AI service got the goal; MetaCode's access token for it never reached the page
    const first = ai.requests[before];
    assert.match(first.messages[1].content, /^Goal: Posts about testing in r\/test/);
    assert.ok(!(await page.content()).includes('test-service-token'));

    await page.click('nav a[href="#data"]');
    await page.waitForFunction(() => /^3 posts/.test(document.querySelector('#explorer-count').textContent));
    await page.click('#explorer-table tbody tr');
    await page.waitForSelector('#record-detail');
    assert.match(await page.getAttribute('#record-detail a:has-text("Open on Reddit")', 'href'), /^https:\/\/www\.reddit\.com\/r\/test\/comments\/[a-z0-9]+\/post_\d+\/$/);
    await page.click('nav a[href="#overview"]');
    await page.waitForFunction(() => /3\s*Posts collected/.test(document.querySelector('#overview-stats').textContent));
    assert.match(await page.textContent('table'), /Posts about testing in r\/test/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('inside MetaCode: the AI Scraper (beta) page runs a job with the AI Scraper\'s model and adds the posts to the project', { skip, timeout: 120000 }, async () => {
  const { context, page, errors } = await openPage('/app.html#dashboard');
  try {
    await page.waitForFunction(() => typeof App !== 'undefined' && App.getState);
    await page.evaluate(() => { const s = App.getState(); App.setState({ settings: Object.assign({}, s.settings, { models: { scraper: 'other-model' } }) }); });
    await page.click('.nav-item[data-view="scraper-beta"]');
    const frame = page.frameLocator('#cv-frame');
    await frame.locator('.app.is-embedded').waitFor();
    await frame.locator('nav a[href="#new"]').click();
    assert.match(await frame.locator('form').textContent(), /AI model: other-model/);
    const before = ai.requests.length;
    await startJob(frame, 'Posts about testing in r/test', 5);
    await frame.locator('#monitor-outcome').waitFor({ timeout: 60000 });
    assert.ok(ai.requests.slice(before).every(r => r.model === 'other-model'), 'the model picked for the AI Scraper was used');

    await frame.locator('#job-add-to-project').click();
    await frame.locator('#job-added').waitFor();
    assert.match(await frame.locator('#job-added').textContent(), /^Added 3 to the project/);
    const posts = await page.evaluate(() => App.getState().posts);
    assert.equal(posts.length, 3);
    assert.ok(posts.every(p => /^reddit_[a-z0-9]+$/.test(p.id) && typeof p.engagement.likes === 'number' && p.source.subreddit === 'test'));
    assert.deepEqual(errors.filter(e => !/is not defined/.test(e)), []);
  } finally {
    await context.close();
  }
});

test('a job keeps running on the server when the page reloads, and the page picks it up again', { skip, timeout: 120000 }, async () => {
  ai.delayMs = 1500;
  const { context, page, errors } = await openPage('/collector/#overview');
  try {
    await page.waitForSelector('#overview-stats');
    await startJob(page, 'Posts about testing in r/test, again', 5);
    await page.reload();
    await page.click('nav a[href="#monitor"]');
    await page.waitForSelector('#monitor-outcome', { timeout: 60000 });
    assert.equal(await page.textContent('#monitor-outcome'), 'The AI finished: 3 posts kept.');
    assert.equal(await page.textContent('#monitor-posts'), '3');
    assert.deepEqual(errors, []);
  } finally {
    ai.delayMs = 0;
    await context.close();
  }
});

test('jobs saved by the earlier in-browser bot still open in the Monitor', { skip, timeout: 60000 }, async () => {
  const { context, page, errors } = await openPage('/collector/#overview');
  try {
    await page.waitForSelector('#overview-stats');
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('metacode-reddit-collector');
      open.onsuccess = () => {
        const tx = open.result.transaction('jobs', 'readwrite');
        tx.objectStore('jobs').put({ id: 'old-bot-job', config: { targetType: 'subreddit', subreddits: ['alpha', 'beta'], maxPosts: 5 }, state: 'completed',
          outcome: 'Reached the limit of 5 posts.', startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:05:00.000Z',
          stats: { postsCollected: 5, commentsCollected: 0, postsSkipped: 0, pagesVisited: 3, errors: 0, retries: 0 }, robots: null });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    }));
    await page.reload();
    await page.click('tr:has-text("r/alpha, r/beta")');
    await page.waitForSelector('#monitor-goal');
    assert.equal(await page.textContent('#monitor-goal'), 'r/alpha, r/beta');
    assert.equal(await page.textContent('#monitor-outcome'), 'Reached the limit of 5 posts.');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('RedditAPIs.com first; your own Reddit API keys (from the Reddit Scraper page) are offered; the choice is remembered', { skip, timeout: 60000 }, async () => {
  const keys = { reddit: { clientId: 'cid-1234', clientSecret: 'sec', username: 'me', hint: '…1234' } };
  const { context, page } = await openPage('/collector/#new', `localStorage.setItem('metacode.scraper.ownKeys', ${JSON.stringify(JSON.stringify(keys))})`);
  try {
    await page.waitForSelector('#job-access');
    assert.deepEqual(await page.$$eval('#job-access option', o => o.map(x => x.value)), ['redditapis', 'own', 'server']);
    assert.equal(await page.inputValue('#job-access'), 'redditapis');
    await page.selectOption('#job-access', 'own');
    assert.match(await page.textContent('#job-access option[value="own"]'), /Your Reddit API keys \(…1234\)/);
    assert.match(await page.textContent('#job-access-note'), /Works even when Reddit blocks the server's address/);
    await page.reload();
    await page.waitForSelector('#job-access');
    assert.equal(await page.inputValue('#job-access'), 'own');
  } finally {
    await context.close();
  }
});
