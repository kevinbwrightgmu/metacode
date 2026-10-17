// The AI Coding Lab in a real browser: the Ultra gate for signed-out and Pro
// users, then an Ultra user's whole journey through the page — project,
// knowledge document, coding profile, a streamed Workbench answer (and Stop),
// a dataset version, an evaluation suite, a baseline run, a suggested
// candidate profile version, a second run, the comparison and accepting the
// candidate. Supabase, Stripe and the AI service are local mocks
// (test/helpers): this proves MetaCode's pages and server, not a provider.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testEnv } = require('./helpers/harness');
const { mockSupabase, mockStripe } = require('./helpers/account-mocks');
const { startEmis } = require('./helpers/lab-mocks');

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
const KEY = 'sb_publishable_lab_e2e_0123456789';
const emisState = { requests: [], streamDelayMs: 0, fail: false };
let sb, stripe, emis, server, baseUrl, browser, tmp;

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-lab-e2e-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  stripe = mockStripe({ key: 'sk_test_labe2e', products: {
    prod_VQeJh2lPqfmae9: { id: 'prod_VQeJh2lPqfmae9', active: true, default_price: 'price_pro' },
    prod_VQeK26tKchu1VI: { id: 'prod_VQeK26tKchu1VI', active: true, default_price: 'price_max' },
    prod_VQeKXAJtQQLKqm: { id: 'prod_VQeKXAJtQQLKqm', active: true, default_price: 'price_ultra' }
  } });
  await stripe.start();
  emis = await startEmis(emisState);
  stripe.subscribe(sb.addUser('ultra@example.org', 'ultra password 1').id, 'prod_VQeKXAJtQQLKqm');
  stripe.subscribe(sb.addUser('pro@example.org', 'pro password 1').id, 'prod_VQeJh2lPqfmae9');
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY,
    STRIPE_SECRET_KEY: 'sk_test_labe2e', STRIPE_API_BASE: stripe.url,
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    AI_LAB_DATA_DIR: path.join(tmp, 'lab'), AI_LAB_PRICING_FILE: path.join(tmp, 'none.json'),
    EMIS_BASE_URL: 'http://127.0.0.1:' + emis.address().port + '/v1', EMIS_API_KEY: 'emis-test-key-123456', EMIS_TRANSPORT: 'node',
    EMIS_MODEL: 'lab-model', EMIS_MODELS_FILE: path.join(tmp, 'none.json'), EMIS_MODEL_SWITCH: 'off'
  }));
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (emis) { emis.closeAllConnections(); await new Promise(r => emis.close(r)); }
  if (sb) await sb.close();
  if (stripe) await stripe.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // only this machine (MetaCode and the mocks) — no internet, so no CDN highlighter either
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route => route.abort());
  return { page, errors, context };
}
async function signIn(page, email, pw) {
  await page.waitForSelector('[data-account-chip] .acct-signin');
  await page.click('[data-account-chip] .acct-signin');
  await page.fill('.acct-form [name=email]', email);
  await page.fill('.acct-form [name=password]', pw);
  await page.click('.acct-form .acct-primary');
}
// Fills a modal field by name
const fill = (page, name, value) => page.fill('#modal-body [name="' + name + '"]', value);

test('the Lab page is gated on the server: signed out, then Pro', { skip, timeout: 60000 }, async () => {
  const { page, errors, context } = await newPage();
  await page.goto(baseUrl + '/ultra/ai-lab');
  await page.waitForSelector('.lab-gate h2:has-text("Sign in to use the AI Coding Lab")');
  assert.equal(await page.isVisible('#lab-nav'), false);
  await signIn(page, 'pro@example.org', 'pro password 1');
  await page.waitForSelector('.lab-gate h2:has-text("The AI Coding Lab is part of Ultra")');
  assert.equal(await page.isVisible('#lab-nav'), false);
  // Showing the navigation by hand changes nothing: the API refuses
  const status = await page.evaluate(async () => (await fetch('/api/lab/projects', { credentials: 'same-origin' })).status);
  assert.equal(status, 402);
  assert.deepEqual(errors, []);
  await context.close();
});

test('an Ultra user\'s journey: project → knowledge → profile → Workbench → dataset → suite → runs → suggestion → comparison → accept', { skip, timeout: 240000 }, async () => {
  const { page, errors, context } = await newPage();
  await page.goto(baseUrl + '/ultra/ai-lab');
  await signIn(page, 'ultra@example.org', 'ultra password 1');
  await page.waitForSelector('#lab-nav:not([hidden])');
  await page.waitForSelector('text=Get started');

  // Project
  await page.click('#lab-nav [data-view=projects]');
  await page.click('#p-new');
  await fill(page, 'name', 'Calculator');
  await fill(page, 'languages', 'JavaScript');
  await page.click('#pf-save');
  await page.waitForSelector('.lab-head h2:has-text("Calculator")');
  assert.equal(await page.inputValue('#lab-project'), await page.evaluate(() => Lab.state.projectId));

  // Knowledge document (pasted), processed in the background
  await page.click('#kb-paste');
  await fill(page, 'name', 'style.md');
  await fill(page, 'content', '# Style\nPublic helpers live in src/math.js and are covered by tests.');
  await page.click('#kb-add');
  await page.waitForSelector('#pj-docs td:has-text("style.md")');
  await page.waitForSelector('#pj-docs .badge:has-text("ready")', { timeout: 15000 });
  await page.fill('#kb-q', 'helpers tests');
  await page.click('#kb-go');
  await page.waitForSelector('#kb-res b:has-text("style.md")');

  // Coding profile
  await page.click('#lab-nav [data-view=profiles]');
  await page.click('#pr-new');
  await fill(page, 'name', 'House style');
  await fill(page, 'conventions', 'Plain functions, two-space indentation.');
  await page.click('#pe-save');
  await page.waitForSelector('.lab-head h2:has-text("House style")');
  const profileId = await page.evaluate(() => location.hash.split('/')[1]);

  // Workbench: a streamed answer with code, the context report, then Stop
  await page.click('#lab-nav [data-view=workbench]');
  await page.click('#wb-start');
  await page.waitForSelector('#wb-input');
  await page.selectOption('#wb-prof', profileId);
  await page.waitForSelector('#wb-pver');
  await page.fill('#wb-input', 'Write an add function');
  await page.click('#wb-send');
  await page.waitForSelector('.lab-msg-assistant .lab-code code:has-text("function add")');
  await page.waitForSelector('.lab-msg-assistant .lab-msg-meta:has-text("111 + 22 tokens")');
  await page.waitForSelector('#wb-ctx dd:has-text("v1")');
  assert.match(await page.textContent('#wb-ctx'), /style\.md/, 'the knowledge passage that was sent is listed');
  assert.match(await page.textContent('#wb-title'), /Write an add function/);
  emisState.streamDelayMs = 60;
  await page.fill('#wb-input', 'slow: explain it in detail');
  await page.click('#wb-send');
  await page.waitForSelector('#wb-stop:not([hidden])');
  await page.waitForSelector('.lab-msg-assistant:last-child .lab-md');
  await page.click('#wb-stop');
  await page.waitForSelector('.lab-msg-assistant .badge:has-text("stopped")', { timeout: 15000 });
  emisState.streamDelayMs = 0;
  await page.waitForSelector('#wb-send:not([disabled])');

  // Dataset with one checked example, committed as version 1
  await page.click('#lab-nav [data-view=training]');
  await page.click('#ds-new');
  await fill(page, 'name', 'Adds');
  await page.click('#dsf-save');
  await page.waitForSelector('#dx-add');
  await page.click('#dx-add');
  await fill(page, 'task', 'Write add(a, b) for our ES module code base');
  await fill(page, 'expected', 'An exported add function');
  await fill(page, 'source', 'written by the team');
  await page.selectOption('#modal-body [name=split]', 'test');
  await fill(page, 'checks', '[{"type":"contains","values":["export function add"]}, {"type":"syntax","language":"javascript"}]');
  await page.click('#ex-save');
  await page.waitForSelector('#dv-body td:has-text("Write add(a, b)")');
  await page.click('[data-tab=versions]');
  await page.click('#cv-go');
  await page.waitForSelector('#dv-body td:has-text("v1")');

  // Suite pinned to that version
  await page.click('#lab-nav [data-view=evaluations]');
  await page.click('#ev-new');
  await fill(page, 'name', 'Adds suite');
  await page.click('#sf-save');
  await page.waitForSelector('.lab-head h2:has-text("Adds suite")');

  // Baseline run with profile v1: the plain function fails the export check
  await page.selectOption('#su-prof', profileId);
  await page.click('#su-run');
  await page.waitForSelector('.lab-head .badge:has-text("completed")', { timeout: 30000 });
  await page.waitForSelector('.lab-metric:has-text("Pass rate") b:has-text("0%")');
  const baseline = await page.evaluate(() => location.hash.split('/')[1]);
  await page.click('[data-rf=failed]');
  await page.waitForSelector('details.lab-result .lab-check:has-text("fail")');
  await page.waitForSelector('details.lab-result .lab-check:has-text("javascript parses") .lab-pass');

  // Suggest an improvement → candidate v2 → run the suite with it
  await page.click('#rn-suggest');
  await page.click('#sg-go');
  await page.waitForSelector('#modal-title:has-text("Candidate version 2")');
  assert.match(await page.textContent('#modal-body'), /ES module/);
  await page.click('#sg-run');
  await page.waitForFunction(b => location.hash.startsWith('#run/') && location.hash !== '#run/' + b, baseline);
  await page.waitForSelector('.lab-head .badge:has-text("completed")', { timeout: 30000 });
  await page.waitForSelector('.lab-metric:has-text("Pass rate") b:has-text("100%")');

  // Compare: one improvement, then accept the candidate
  await page.click('#rn-cmp');
  await page.click('#cw-go');
  await page.waitForSelector('.lab-head p:has-text("1 improved")');
  await page.waitForSelector('.lab-warn:has-text("one attempt per task")');
  await page.click('#cp-accept');
  await page.waitForSelector('text=v2 is now the current version');
  const prof = await page.evaluate(async id => (await (await fetch('/api/lab/profiles/' + id)).json()).profile, profileId);
  assert.equal(prof.currentVersion, 2);
  assert.equal(prof.versions.find(v => v.version === 2).status, 'active');

  // Overview reflects the work
  await page.click('#lab-nav [data-view=overview]');
  await page.waitForSelector('.stat-card:has-text("Evaluation runs") .stat-num:has-text("2")');
  assert.deepEqual(errors, []);
  await context.close();
});
