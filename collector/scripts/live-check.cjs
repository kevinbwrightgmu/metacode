#!/usr/bin/env node
// ── Manual live check: the collector against real Reddit ─────────────────────
// Starts MetaCode, opens the built collector in Chromium, and runs one small
// job on live Reddit through Scramjet. Passes only if at least one real post
// is collected, shown in the Data view, and present in a JSON export.
//
//   npm run collector:live-check -- --subreddit=science --posts=3
//   options: --subreddit=NAME  --posts=N (≤10)  --base=https://old.reddit.com
//            --robots=obey|warn  --headed  --port=N
//
// Exit codes: 0 passed · 1 failed · 2 stopped by robots.txt (policy "obey") ·
// 3 Reddit refused or couldn't be reached. It never retries past a refusal.
// "--robots=warn" runs the job even where robots.txt disallows it: use it only
// for collection Reddit has permitted.
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const subreddit = String(args.subreddit || 'science');
const posts = Math.min(10, Math.max(1, Number(args.posts) || 3));
const redditBase = String(args.base || 'https://www.reddit.com');
const robots = args.robots === 'warn' ? 'warn' : 'obey';

function findChromium() {
  const candidates = [process.env.CHROMIUM_PATH].filter(Boolean);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require(path.join(ROOT, 'node_modules', 'playwright-core')).chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'collector', 'dist', 'index.html'))) {
    console.error('Build the collector first: npm run collector:install && npm run collector:build');
    return 1;
  }
  const chromium = findChromium();
  if (!chromium) { console.error('No Chromium found: set CHROMIUM_PATH, or run "npx playwright install chromium".'); return 1; }

  process.chdir(ROOT);
  const { start } = require(path.join(ROOT, 'server'));
  const server = await start(Number(args.port) || 0);
  const url = 'http://localhost:' + server.address().port + '/collector/';
  const browser = await require(path.join(ROOT, 'node_modules', 'playwright-core')).chromium.launch({ executablePath: chromium, headless: !args.headed });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const say = m => console.log('• ' + m);
  try {
    say('Collector: ' + url + ' · r/' + subreddit + ' · up to ' + posts + ' posts · ' + redditBase + ' · robots.txt policy "' + robots + '"');
    await page.goto(url + '#settings');
    await page.waitForSelector('#set-base');
    if (redditBase !== 'https://www.reddit.com') await page.selectOption('#set-base', redditBase);
    if (robots === 'warn') await page.check('#set-robots-warn');
    await page.click('#settings-save');
    await page.click('nav a[href="#new"]');
    await page.waitForFunction(() => !document.querySelector('#job-start').disabled || /error|turned off|can't/i.test(document.querySelector('.browser').textContent), null, { timeout: 60000 });
    say('Scramjet browser: ' + (await page.textContent('.browser-status')).trim());
    if (await page.isDisabled('#job-start')) { console.error('✗ The Scramjet browser didn\'t start.'); return 1; }

    await page.fill('#job-subreddits', subreddit);
    await page.fill('#job-max-posts', String(posts));
    await page.fill('#job-max-depth', '2');
    await page.click('#job-start');
    await page.waitForSelector('#monitor-outcome', { timeout: 5 * 60000 });
    const outcome = (await page.textContent('#monitor-outcome')).trim();
    const saved = Number(await page.textContent('#monitor-posts'));
    say('Outcome: ' + outcome);
    say('robots.txt: ' + ((await page.locator('.monitor .hint', { hasText: 'robots.txt:' }).textContent().catch(() => '')) || 'not recorded').replace(/^robots\.txt:\s*/, ''));
    console.log((await page.$$eval('.log li', l => l.map(x => '    ' + x.textContent))).join('\n'));
    if (/robots\.txt couldn't be read/.test(outcome)) {
      console.error('✗ Reddit couldn\'t be reached through the proxy (robots.txt couldn\'t be read), so no page was opened.');
      return 3;
    }
    if (/robots\.txt disallows/.test(outcome)) {
      console.error('✗ Stopped by robots.txt under the "obey" policy — no Reddit page was opened. See collector/README.md (robots.txt).');
      return 2;
    }
    if (!saved) {
      console.error('✗ No posts were collected. ' + (/blocked|CAPTCHA|too many|proxy|couldn't/i.test(outcome) ? 'Reddit refused or couldn\'t be reached.' : ''));
      return 3;
    }
    await page.click('nav a[href="#data"]');
    await page.waitForFunction(() => /^\d+ post/.test(document.querySelector('#explorer-count').textContent));
    const shown = await page.locator('#explorer-table tbody tr').count();
    await page.selectOption('select[aria-label="Export format"]', 'json');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-all')]);
    const doc = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    if (!shown || !doc.posts.length) { console.error('✗ Posts were collected but not shown/exported.'); return 1; }
    say('Data view shows ' + shown + ' post(s); the JSON export has ' + doc.posts.length + '. First: "' + doc.posts[0].title + '" ' + doc.posts[0].url);
    console.log('✓ Live check passed.');
    return 0;
  } catch (err) {
    console.error('✗ ' + err.message);
    return 1;
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
}

main().then(code => process.exit(code));
