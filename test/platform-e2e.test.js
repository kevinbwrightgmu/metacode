// End-to-end tests in a real browser for the multi-method platform pieces:
//   1. the front page: the four methods, working calls to action, phone/tablet layout;
//   2. the Survey Studio dashboard: search, status filter, quick links;
//   3. the Theme page: the searchable font library, a font that persists and reaches the published survey;
//   4. respondent information, the before-you-begin disclosure with consent, the session
//      timeline, and the Responses page (answers, timeline replay, details, empty states);
//   5. Human Coding: Coder 1 and Coder 2 code independently (blind), the AI coder stays
//      separate, reliability numbers, adjudication that keeps the original codes, coder files.
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
let server, baseUrl, browser, dataDir;

test.before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-platform-e2e-'));
  Object.assign(process.env, testEnv({ SURVEY_DATA_DIR: dataDir, EMIS_API_KEY: '', SURVEY_GEO_HEADERS: 'cloudflare' }));
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function open(url, opts) {
  opts = opts || {};
  const context = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }, opts.context || {}));
  if (opts.init) await context.addInitScript(opts.init.fn, opts.init.arg);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, route => route.abort());   // no internet in CI (Google Fonts, gtag…)
  await page.goto(baseUrl + url);
  return { page, context, errors };
}
const noTours = { fn: () => { try { localStorage.setItem('metacode_tour_studio', 'done'); localStorage.setItem('metacode_tour_offer_studio-tutorial', '1'); localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } }, arg: null };
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('front page: the four methods, a multi-method workflow, audiences, and calls to action that work', { skip, timeout: 60000 }, async () => {
  const { page, context, errors } = await open('/index.html');
  assert.match(await page.textContent('h1'), /One platform\.\s*Every method\.\s*Deeper social insights\./);
  assert.match(await page.textContent('.lede'), /data collection, AI-powered coding, network analysis, and survey research/);
  const methods = await page.$$eval('#methods .method', els => els.map(e => [e.querySelector('h3').textContent, e.querySelector('.method-link').getAttribute('href')]));
  assert.deepEqual(methods, [['Reddit Data Collection', 'app.html#scraper'], ['AI Coding', 'app.html#ai-coding'], ['Network Analysis', 'app.html#csv-analyzer'], ['Survey Studio', 'studio.html']]);
  assert.deepEqual(await page.$$eval('#workflow .flow h3', h => h.map(x => x.textContent.trim())), ['Collect', 'Code', 'Map', 'Survey', 'Synthesize']);
  assert.equal(await page.locator('#audiences .aud > div').count(), 6);
  // Explore the platform → the methods section
  await page.click('.hero >> text=Explore the platform');
  await page.waitForFunction(() => location.hash === '#methods');
  // Every method link leads to a real page
  for (const [, href] of methods) {
    const res = await page.request.get(baseUrl + '/' + href.split('#')[0]);
    assert.equal(res.status(), 200, href);
  }
  // Start a research project → the Projects page of the platform
  await page.click('.hero >> text=Start a research project');
  await page.waitForSelector('#pj-new');
  assert.equal(new URL(page.url()).hash, '#projects');
  assert.deepEqual(errors, []);
  // Phone and tablet: no sideways scrolling
  for (const width of [390, 820]) {
    const p = await context.newPage();
    await p.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    await p.setViewportSize({ width, height: 900 });
    await p.goto(baseUrl + '/index.html');
    assert.equal(await overflow(p), 0, 'no horizontal overflow at ' + width + 'px');
    await p.close();
  }
  await context.close();
});

test('Survey Studio dashboard: create, then search, filter by status and jump straight to a survey\'s Theme', { skip, timeout: 120000 }, async () => {
  const { page, context, errors } = await open('/studio.html', { init: noTours });
  await page.waitForSelector('#ss-empty-new');
  assert.match(await page.textContent('#ss-list'), /No surveys yet/);
  // Two surveys from templates; publish one
  await page.click('.ss-tpl[data-tpl="feedback"]');
  await page.waitForSelector('.ss-viewport .sv-artboard');
  await page.click('#ss-publish');
  await page.click('#ss-pub-go');
  await page.waitForSelector('#ss-pub-url');
  await page.click('#modal-close');
  await page.click('.ss-back');
  await page.waitForSelector('#ss-list tr[data-id]');
  await page.click('.ss-tpl[data-tpl="registration"]');
  await page.waitForSelector('.ss-viewport .sv-artboard');
  await page.click('.ss-back');
  await page.waitForFunction(() => document.querySelectorAll('#ss-list tr[data-id]').length === 2);
  assert.match(await page.textContent('#ss-stats'), /2\s*Surveys\s*1\s*Live\s*1\s*Drafts/);
  await page.fill('#ss-search', 'workshop');
  await page.waitForFunction(() => document.querySelectorAll('#ss-list tr[data-id]').length === 1);
  assert.match(await page.textContent('#ss-list'), /Register for the workshop/);
  assert.match(await page.textContent('#ss-count'), /1 of 2 shown/);
  await page.fill('#ss-search', 'nothing like this');
  await page.waitForSelector('#ss-clear-filters');
  await page.click('#ss-clear-filters');
  await page.selectOption('#ss-filter', 'live');
  await page.waitForFunction(() => document.querySelectorAll('#ss-list tr[data-id]').length === 1);
  assert.match(await page.textContent('#ss-list'), /How did we do\?/);
  assert.match(await page.textContent('#ss-list .badge-green'), /Live/);
  // The filter is remembered; quick links open the editor in that mode
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#ss-list tr[data-id]').length === 1);
  assert.equal(await page.inputValue('#ss-filter'), 'live');
  await page.click('#ss-list .ssd-quick:has-text("Theme")');
  await page.waitForSelector('.ss-th-panel');
  assert.match(page.url(), /\/theme$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Theme: search the font library, apply a font with a live preview; it persists and the published survey loads it', { skip, timeout: 120000 }, async () => {
  const { page, context, errors } = await open('/studio.html', { init: noTours });
  await page.waitForSelector('#ss-new');
  await page.click('#ss-new');
  await page.waitForSelector('.ss-viewport .sv-artboard');
  await page.click('.ss-mode[data-mode="theme"]');
  await page.waitForSelector('#ss-th-host .sv-artboard');
  for (const sec of ['Typography', 'Colours', 'Background', 'Layout & spacing', 'Question styling', 'Buttons & controls', 'Progress indicator', 'Advanced']) assert.match(await page.textContent('.ss-th-panel'), new RegExp(sec.replace('&', '&')));
  await page.click('[data-font-token="fontBody"]');
  await page.waitForSelector('.sf-picker');
  assert.match(await page.textContent('.sf-count'), /^2\d\d fonts$/);
  await page.fill('.sf-input', 'serif');
  await page.waitForTimeout(100);
  const serifs = await page.$$eval('.sf-item .sf-meta', m => m.map(x => x.textContent));
  assert.ok(serifs.length > 30 && serifs.every(t => /^Serif/.test(t)), 'style search: ' + serifs.slice(0, 3));
  await page.fill('.sf-input', 'lora');
  await page.waitForFunction(() => document.querySelectorAll('.sf-item').length === 1);
  assert.equal(await page.getAttribute('.sf-item .sf-name', 'style'), "font-family:'Lora', Georgia, serif");
  await page.keyboard.press('ArrowDown');      // preview
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#ss-th-host .sv-root')).getPropertyValue('--sv-fontBody').includes('Lora'));
  await page.keyboard.press('Enter');          // apply
  await page.waitForSelector('.sf-picker', { state: 'detached' });
  assert.equal(await page.textContent('[data-font-token="fontBody"]'), 'Lora');
  assert.ok(await page.evaluate(() => !!document.querySelector('link[data-survey-font="full:Lora"]')), 'the font is loaded for the editor');
  const id = await page.evaluate(() => SurveyStudio.current().store.doc.id);
  await page.evaluate(() => SurveyStudio.current().store.flush({ force: true }));
  await page.reload();
  await page.waitForSelector('.ss-th-panel');
  assert.equal(await page.textContent('[data-font-token="fontBody"]'), 'Lora', 'saved with the survey');
  await page.click('#ss-publish');
  await page.click('#ss-pub-go');
  await page.waitForSelector('#ss-pub-url');
  const url = await page.inputValue('#ss-pub-url');
  const pub = await context.newPage();
  await pub.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await pub.goto(url);
  await pub.waitForSelector('.sv-artboard');
  assert.ok(await pub.evaluate(() => !!document.querySelector('link[data-survey-font="full:Lora"][href*="family=Lora"]')), 'the published survey loads Lora');
  assert.match(await pub.evaluate(() => getComputedStyle(document.querySelector('.sv-root')).getPropertyValue('--sv-fontBody')), /Lora/);
  assert.ok(id);
  assert.deepEqual(errors, []);
  await context.close();
});

test('respondent information, disclosure with consent, the session timeline and the Responses page', { skip, timeout: 180000 }, async () => {
  const { page, context, errors } = await open('/studio.html', { init: noTours });
  await page.click('.ss-tpl[data-tpl="research"]');
  await page.waitForSelector('.ss-viewport .sv-artboard');
  // Settings: anonymous by default, then record the timeline with consent and add a Respondent information block
  await page.click('.ss-mode[data-mode="settings"]');
  assert.match(await page.textContent('#ss-set-identity'), /Anonymous/);
  await page.click('[data-rec="consent"]');
  await page.click('[data-act="add-resp"]');
  await page.waitForSelector('.ss-insp-head');
  await page.locator('.ss-field', { hasText: 'Code comes from' }).locator('select').selectOption('link');
  for (const label of ['Country (from IP)', 'State / region (from IP)', 'IP address']) { await page.locator('.ss-field', { hasText: label }).locator('input[type=checkbox]').first().check({ force: true }); await page.waitForTimeout(100); }
  await page.click('.ss-mode[data-mode="settings"]');
  const identity = await page.textContent('#ss-set-identity');
  assert.match(identity, /Identifying data collected/);
  assert.match(identity, /From the survey link \(\?pid=…\)/);
  assert.match(identity, /IP address/);
  await page.click('#ss-publish');
  await page.click('#ss-pub-go');
  await page.waitForSelector('#ss-pub-url');
  const url = await page.inputValue('#ss-pub-url');
  await page.click('#modal-close');

  // Respondent 1 allows the timeline
  const r1 = await browser.newContext({ extraHTTPHeaders: { 'cf-ipcountry': 'US', 'cf-region': 'California' } });
  const rp = await r1.newPage();
  const rErrors = [];
  rp.on('pageerror', e => rErrors.push(e.message));
  await rp.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await rp.goto(url + '?pid=P-0042');
  await rp.waitForSelector('.svp-notice');
  const notice = await rp.textContent('.svp-notice');
  assert.match(notice, /records how you move through it/);
  assert.match(notice, /your IP address and your approximate location/);
  assert.equal(await rp.locator('.sv-question').count(), 0, 'nothing starts before the respondent chooses');
  await rp.click('text=Allow and start');
  await rp.locator('.sv-option', { hasText: 'Yes' }).first().click();
  assert.match(await rp.textContent('.sv-resp'), /Participant code: P-0042/);
  await rp.waitForTimeout(800);
  await rp.locator('.sv-button:not(.sv-off)').last().click();
  await rp.waitForSelector('input[type=number]');
  await rp.locator('.sv-button:not(.sv-off)').last().click();       // age is required → validation
  await rp.fill('input[type=number]', '34');
  await rp.locator('.sv-option', { hasText: '1–3' }).click();
  await rp.waitForTimeout(800);
  await rp.locator('.sv-option', { hasText: '3–5' }).click();          // a changed answer
  await rp.waitForTimeout(800);
  await rp.locator('.sv-button:not(.sv-off)').last().click();
  await rp.waitForTimeout(400);
  await rp.locator('.sv-button:not(.sv-off)').last().click();          // leave page 3 unanswered
  await rp.waitForSelector('.sv-complete');
  await r1.close();
  // Respondent 2 declines the timeline
  const r2 = await browser.newContext();
  const rp2 = await r2.newPage();
  await rp2.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await rp2.goto(url + '?pid=P-0099');
  await rp2.click('text=Start without the timeline');
  await rp2.locator('.sv-option', { hasText: 'No' }).first().click();
  await rp2.waitForTimeout(300);
  await rp2.locator('.sv-button:not(.sv-off)').last().click();
  await rp2.waitForSelector('.sv-complete');
  await r2.close();
  assert.deepEqual(rErrors, []);

  // The Responses page
  await page.click('.ss-mode[data-mode="responses"]');
  await page.waitForFunction(() => document.querySelectorAll('.sr-item').length === 2);
  assert.match(await page.textContent('.sr-stats'), /2\s*Total\s*2\s*Completed\s*0\s*Partial\s*100%\s*Completion rate/);
  await page.fill('#sr-q', 'P-0042');
  await page.waitForFunction(() => document.querySelectorAll('.sr-item').length === 1);
  assert.match(await page.textContent('.sr-who'), /🇺🇸 127\.0\.0\.1 · California · P-0042/);
  const answers = await page.textContent('.sr-answers');
  assert.match(answers, /Do you agree to take part in this study\?\s*Yes \/ No\s*Yes/);
  assert.match(answers, /How old are you\?\s*Number\s*34/);
  assert.match(answers, /3–5[\s\S]*changed 1×/);
  assert.match(answers, /I trust the news I see on social media\.[\s\S]*?Skipped/);
  await page.click('.sr-dtab[data-tab="timeline"]');
  await page.waitForSelector('.sr-ev');
  const labels = await page.$$eval('.sr-ev-label', l => l.map(x => x.textContent));
  assert.equal(labels[0], 'Started the survey on Page 1');
  assert.ok(labels.includes('1 question needed attention: “How old are you?”'), labels.join(' | '));
  assert.ok(labels.some(l => /^Changed the answer to “How many hours a day do you spend on social media\?”: 3–5$/.test(l)), labels.join(' | '));
  assert.ok(labels.includes('Left “I trust the news I see on social media.” unanswered'));
  assert.equal(labels[labels.length - 1], 'Submitted the survey');
  // Step-through replay: select an event, see the page and answers at that moment, jump to the question
  const changed = labels.findIndex(l => /^Changed the answer/.test(l));
  await page.click('.sr-ev[data-i="' + changed + '"]');
  assert.match(await page.textContent('.sr-replay-body'), /About you[\s\S]*How old are you\?\s*34/);
  await page.click('.sr-rp-qs li.is-now [data-goq]');
  await page.waitForSelector('.sr-q.is-focus');
  // Details: sources are labelled
  await page.click('.sr-dtab[data-tab="details"]');
  const details = await page.textContent('.sr-details');
  assert.match(details, /Participant codeP-0042From the survey link/);
  assert.match(details, /United States \(US\)Approximate — from the IP address, by Cloudflare/);
  // The respondent who declined: an honest empty state, no invented events
  await page.fill('#sr-q', 'P-0099');
  await page.waitForFunction(() => document.querySelectorAll('.sr-item').length === 1);
  await page.click('.sr-dtab[data-tab="timeline"]');
  assert.match(await page.textContent('.sr-empty-tl'), /chose “Start without the timeline”/);
  // Exports leave identifying fields out unless asked
  await page.fill('#sr-q', '');
  await page.click('.sr-head [data-act="export"]');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#sr-x-go')]);
  const text = fs.readFileSync(await csv.path(), 'utf8');
  assert.doesNotMatch(text, /P-0042|127\.0\.0\.1/);
  assert.match(text.split('\n')[0], /^response_id,status,version/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Human Coding: Coder 1 and Coder 2 code blind, the AI stays separate, reliability is computed, and adjudication keeps the original codes', { skip, timeout: 120000 }, async () => {
  const state = {
    project: { name: 'Coding test', description: '' },
    codebook: [{ id: 'tone', name: 'Tone', codes: [{ id: 'pos', label: 'Positive' }, { id: 'neu', label: 'Neutral' }, { id: 'neg', label: 'Negative' }] }],
    posts: Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, text: 'Post ' + i, engagement: {}, humanCodes: {}, aiCodes: i < 5 ? { tone: { code: ['pos', 'neg', 'neu'][i % 3], confidence: 0.8, reasoning: 'Reason ' + i } } : {} })),
    network: { nodes: [], edges: [] }, settings: {}
  };
  const { page, context, errors } = await open('/app.html', { init: { fn: s => { if (!localStorage.getItem('seeded')) { localStorage.setItem('strata_v1', s); localStorage.setItem('seeded', '1'); localStorage.setItem('metacode_tour_app', 'done'); } }, arg: JSON.stringify(state) } });
  await page.goto(baseUrl + '/app.html#human-coding/coder1');
  await page.waitForSelector('.hc-coder-badge.hc-coder1');
  assert.deepEqual(await page.$$eval('.hc-tab', t => t.map(x => x.childNodes[0].textContent.trim())), ['Coder 1', 'Coder 2', 'AI Coder', 'Reliability Analysis']);
  assert.equal(await page.locator('.cp-ai-hint').count(), 0, 'AI suggestions are hidden while coding blind');
  const c1 = ['pos', 'neg', 'neu', 'pos', 'neg', 'neu'], c2 = ['pos', 'neu', 'neu', 'pos', 'neg', 'neg'];
  const code = async codes => { for (const c of codes) { await page.click('.cp-code-btn[data-code="' + c + '"]'); await page.click('#hc-next'); } };
  await code(c1);
  assert.match(await page.textContent('#hc-progress'), /6 of 6 coded/);
  await page.click('.hc-tab[data-tab="coder2"]');
  await page.waitForSelector('.hc-coder-badge.hc-coder2');
  assert.equal(await page.locator('.cp-code-btn.selected').count(), 0, 'Coder 2 doesn\'t see Coder 1\'s codes');
  await code(c2);
  // Records stay separate
  let st = await page.evaluate(() => JSON.parse(localStorage.getItem('strata_v1')).posts);
  assert.deepEqual(st.map(p => p.humanCodes.tone), c1);
  assert.deepEqual(st.map(p => p.coder2Codes.tone), c2);
  assert.equal(st[0].aiCodes.tone.code, 'pos');
  // AI Coder tab: results and unavailable units
  await page.click('.hc-tab[data-tab="ai"]');
  await page.waitForSelector('.hc-ai-table');
  assert.match(await page.textContent('.hc-stats'), /5 \/ 6\s*Posts coded by AI/);
  assert.equal(await page.locator('.hc-ai-table .hc-unavail').count(), 1);
  // Reliability: hidden until the researcher reveals it
  await page.click('.hc-tab[data-tab="reliability"]');
  await page.waitForSelector('#hc-unlock');
  assert.equal(await page.locator('.hc-dimtable').count(), 0);
  await page.click('#hc-unlock');
  await page.waitForSelector('.hc-dimtable');
  const row = await page.$$eval('.hc-dimtable tbody tr td', td => td.map(x => x.innerText.trim()));
  assert.equal(row[2], '6');                 // N
  assert.equal(row[3], '66.7%');             // percent agreement: 4 of 6
  assert.equal(row[4], '0.500');             // Cohen's κ: (2/3 − 1/3) / (1 − 1/3)
  assert.match(await page.textContent('.rel-header-cards'), /66\.7%[\s\S]*0\.500[\s\S]*2\s*Posts with disagreements/);
  // Coder 1 vs AI: 5 comparable posts (the AI didn't code one)
  await page.click('[data-pair="c1ai"]');
  await page.waitForSelector('.hc-dimtable');
  assert.equal((await page.$$eval('.hc-dimtable tbody tr td', td => td.map(x => x.innerText.trim())))[2], '5');
  await page.click('[data-pair="c1c2"]');
  await page.waitForSelector('.hc-dislist');
  // Adjudicate the first disagreement with Coder 2's code
  await page.fill('#hc-adjudicator', 'Researcher R');
  await page.locator('.hc-dis-row').first().click();
  await page.waitForSelector('.hc-adj');
  assert.match(await page.textContent('.hc-adj'), /AI \(80%\)/);
  await page.locator('.hc-pick[data-basis="coder2"]').first().click();
  await page.locator('[data-adjsave]').first().click();
  await page.waitForFunction(() => /1 resolved by adjudication/.test(document.querySelector('.rel-header-cards').textContent));
  st = await page.evaluate(() => JSON.parse(localStorage.getItem('strata_v1')).posts);
  const p1 = st.find(p => p.id === 'p1');
  assert.equal(p1.humanCodes.tone, 'neg', 'Coder 1\'s code is unchanged');
  assert.equal(p1.coder2Codes.tone, 'neu', 'Coder 2\'s code is unchanged');
  assert.equal(p1.adjudicated.tone.code, 'neu');
  assert.equal(p1.adjudicated.tone.basis, 'coder2');
  assert.equal(p1.adjudicated.tone.by, 'Researcher R');
  // Coder files: export Coder 1, clear, import back into Coder 2's slot of another project copy
  await page.click('#hc-coderfile');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-cfx="coder1"]')]);
  const file = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.equal(file.format, 'metacode-coder-file');
  assert.deepEqual(Object.keys(file.codes).length, 6);
  page.once('dialog', d => d.accept());
  await page.selectOption('#hc-cf-slot', 'coder2');
  const tmp = path.join(dataDir, 'coder1.json');
  fs.writeFileSync(tmp, JSON.stringify(file));
  await page.setInputFiles('#hc-cf-file', tmp);
  await page.waitForSelector('.hc-coder-badge.hc-coder2');
  st = await page.evaluate(() => JSON.parse(localStorage.getItem('strata_v1')).posts);
  assert.deepEqual(st.map(p => p.coder2Codes.tone), c1, 'Coder 1\'s file imported into Coder 2\'s slot');
  assert.deepEqual(errors, []);
  await context.close();
});
