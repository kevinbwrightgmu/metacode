// Accounts in a real browser: the pages with accounts on, signing up with
// (mock) Supabase Auth, this browser's work moving into the account, the plan
// gates and dialogs, Stripe checkout, a second device getting the same work,
// an upgrade arriving by webhook, Survey Studio on Free, and signing out.
// Supabase and Stripe are local mocks (test/helpers/account-mocks.js) — this
// proves MetaCode's pages and server, not the live services' configuration.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testEnv } = require('./helpers/harness');
const { mockSupabase, mockStripe, stripeSignature } = require('./helpers/account-mocks');

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
const KEY = 'sb_publishable_e2e_0123456789abcdef';
let sb, stripe, server, baseUrl, browser, tmp;

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-accounts-e2e-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  stripe = mockStripe({ key: 'sk_test_e2e123', products: {
    prod_VQeJh2lPqfmae9: { id: 'prod_VQeJh2lPqfmae9', active: true, default_price: 'price_pro' },
    prod_VQeK26tKchu1VI: { id: 'prod_VQeK26tKchu1VI', active: true, default_price: 'price_max' },
    prod_VQeKXAJtQQLKqm: { id: 'prod_VQeKXAJtQQLKqm', active: true, default_price: 'price_ultra' }
  } });
  await stripe.start();
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY,
    STRIPE_SECRET_KEY: 'sk_test_e2e123', STRIPE_API_BASE: stripe.url, STRIPE_WEBHOOK_SECRET: 'whsec_e2e',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    EMIS_API_KEY: ''
  }));
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (sb) await sb.close();
  if (stripe) await stripe.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const noTours = () => { try { localStorage.setItem('metacode_tour_app', 'done'); localStorage.setItem('metacode_tour_studio', 'done'); localStorage.setItem('metacode_tour_offer_studio-tutorial', '1'); } catch (e) { /* ignore */ } };
async function newPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // only this machine (MetaCode and the mock services) — no internet
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route => route.abort());
  return { page, errors };
}
async function context(seed) {
  const c = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await c.addInitScript(noTours);
  if (seed) await c.addInitScript(seed.fn, seed.arg);
  return c;
}

test('accounts in the pages: sign up, keep this browser\'s work, plan gates, checkout, a second device, an upgrade, sign out', { skip, timeout: 180000 }, async () => {
  // A browser that already has work in it (before accounts)
  const seed = { fn: () => {
    if (localStorage.getItem('seeded')) return;
    localStorage.setItem('seeded', '1');
    localStorage.setItem('strata_v1', JSON.stringify({ project: { name: 'Climate threads', description: '' }, posts: [{ id: 'p1', text: 'Heat waves are getting worse', humanCodes: {}, aiCodes: {} }, { id: 'p2', text: 'Solar is cheap now', humanCodes: {}, aiCodes: {} }], codebook: [{ id: 'tone', name: 'Tone', codes: [{ id: 'neg', label: 'Negative' }, { id: 'pos', label: 'Positive' }] }], network: { nodes: [], edges: [] }, settings: {} }));
  }, arg: null };
  const ctx = await context(seed);
  const { page, errors } = await newPage(ctx);
  await page.goto(baseUrl + '/app.html#dashboard');

  // Signed out: a Sign in button, the Account page in the sidebar, locks on paid pages
  await page.waitForSelector('#acct-slot .acct-signin');
  assert.equal(await page.isVisible('#nav-account'), true);
  assert.equal((await page.textContent('.nav-item[data-view="scraper"] .nav-lock')).trim(), 'Pro');
  assert.equal((await page.textContent('.nav-item[data-view="network"] .nav-lock')).trim(), 'Max');
  await page.click('.nav-item[data-view="scraper"]');
  await page.waitForSelector('.acct-gate');
  assert.match(await page.textContent('.acct-gate'), /Sign in to use the Reddit Scraper/);

  // An API answer that needs sign-in opens the sign-in dialog by itself
  await page.evaluate(() => fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"messages":[]}' }));
  await page.waitForSelector('.acct-dialog .acct-reason');
  assert.match(await page.textContent('.acct-dialog .acct-reason'), /Sign in to use MetaCode's AI features/);

  // Create an account
  await page.click('.acct-tabs [data-mode="signup"]');
  await page.fill('.acct-form [name=email]', 'researcher@example.org');
  await page.fill('.acct-form [name=password]', 'short');
  await page.click('.acct-form .acct-primary');
  assert.match(await page.textContent('.acct-err'), /at least 8 characters/);
  await page.fill('.acct-form [name=password]', 'correct horse battery');
  await page.click('.acct-form .acct-primary');

  // This browser's work → the account
  await page.waitForSelector('text=Add this browser\'s work to your account?');
  assert.match(await page.textContent('.acct-dialog'), /the open project/);
  await page.click('.acct-dialog .acct-primary');
  await page.waitForSelector('#acct-slot .acct-plan-badge.plan-free');
  const user = sb.users.get('researcher@example.org');
  for (let i = 0; i < 100 && !sb.rows.some(r => r.user_id === user.id && r.kind === 'workspace'); i++) await page.waitForTimeout(100);
  const ws = sb.rows.find(r => r.user_id === user.id && r.kind === 'workspace');
  assert.ok(ws, 'the open project was saved to the account');
  assert.equal(ws.data.posts.length, 2);
  assert.equal(ws.data.project.name, 'Climate threads');

  // Free plan: loading a page doesn't ask for things the plan doesn't have (no 402s in the console)
  const refused = [];
  const onResponse = r => { if (r.status() === 402) refused.push(r.url()); };
  page.on('response', onResponse);
  await page.reload();
  await page.waitForSelector('#acct-slot .acct-plan-badge.plan-free');
  await page.waitForTimeout(1500);
  page.off('response', onResponse);
  assert.deepEqual(refused, []);

  // Free plan: the scraper is a Pro feature; AI coding shows what's left
  await page.click('.nav-item[data-view="scraper"]');
  await page.waitForSelector('.acct-gate');
  assert.match(await page.textContent('.acct-gate'), /the Reddit Scraper is part of the Pro, Max and Ultra plans/i);
  await page.click('.nav-item[data-view="ai-coding"]');
  await page.waitForSelector('#ai-plan-note .acct-note');
  assert.match(await page.textContent('#ai-plan-note'), /Free plan: 850 of 850 posts left this week/);

  // The Account page: plan, usage, plans
  await page.click('#nav-account');
  await page.waitForSelector('.acct-meters');
  assert.match(await page.textContent('.acct-page'), /researcher@example\.org/);
  assert.match(await page.textContent('.acct-meters'), /Posts coded by the AI\s*0 of 850 posts this week/);
  assert.match(await page.textContent('.acct-meters'), /Scraper jobs\s*Not in your plan/);
  assert.match(await page.textContent('.acct-plans'), /\$29 \/ month/, 'prices come from Stripe');
  assert.match(await page.textContent('#acct-sync'), /Saved to your account/);

  // Choosing Max opens Stripe Checkout
  const checkout = page.waitForRequest(r => r.url().startsWith('https://checkout.stripe.test/'));
  await page.click('.acct-plans [data-choose="max"]');
  const req = await checkout;
  assert.match(req.url(), /cs_test_/);
  assert.equal(stripe.sessions[stripe.sessions.length - 1]['line_items[0][price]'], 'price_max');
  await page.goto(baseUrl + '/app.html#dashboard');
  await page.waitForSelector('#acct-slot .acct-plan-badge');

  // A second device: sign in, and the same project is there
  const ctx2 = await context();
  const { page: page2, errors: errors2 } = await newPage(ctx2);
  await page2.goto(baseUrl + '/app.html#account');
  await page2.waitForSelector('.acct-hero [data-a="signin"]');
  await page2.click('.acct-hero [data-a="signin"]');
  await page2.fill('.acct-form [name=email]', 'researcher@example.org');
  await page2.fill('.acct-form [name=password]', 'wrong password');
  await page2.click('.acct-form .acct-primary');
  await page2.waitForSelector('.acct-err:not(:empty)');
  assert.match(await page2.textContent('.acct-err'), /don't match an account/);
  await page2.fill('.acct-form [name=password]', 'correct horse battery');
  await page2.click('.acct-form .acct-primary');
  await page2.waitForSelector('.acct-meters');
  await page2.click('.nav-item[data-view="dashboard"]');
  await page2.waitForFunction(() => document.getElementById('stat-posts').textContent === '2', null, { timeout: 15000 });
  assert.equal(await page2.textContent('#topbar-project'), 'Climate threads');

  // The subscription arrives (Stripe webhook): Max unlocks network analysis
  stripe.subscribe(user.id, 'prod_VQeK26tKchu1VI');
  const cus = Array.from(stripe.customers.values()).find(c => c.metadata.supabase_user_id === user.id).id;
  const event = JSON.stringify({ type: 'customer.subscription.created', data: { object: { object: 'subscription', customer: cus } } });
  const hook = await fetch(baseUrl + '/api/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSignature(event, 'whsec_e2e') }, body: event });
  assert.equal(hook.status, 200);
  await page2.goto(baseUrl + '/app.html?after=upgrade#network');
  await page2.waitForSelector('#acct-slot .acct-plan-badge.plan-max');
  assert.equal(await page2.$('.nav-item[data-view="network"] .nav-lock'), null);
  assert.equal(await page2.$('.acct-gate'), null, 'the Network Graph opens on Max');

  // Survey Studio on Free (a new account): a banner, and Create asks for a plan
  sb.addUser('free@example.org', 'free password 1');
  const ctx3 = await context();
  const { page: page3, errors: errors3 } = await newPage(ctx3);
  await page3.goto(baseUrl + '/studio.html');
  await page3.waitForSelector('#st-account .acct-signin');
  await page3.click('#st-account .acct-signin');
  await page3.fill('.acct-form [name=email]', 'free@example.org');
  await page3.fill('.acct-form [name=password]', 'free password 1');
  await page3.click('.acct-form .acct-primary');
  await page3.waitForSelector('#ss-plan .acct-banner');
  assert.match(await page3.textContent('#ss-plan'), /Survey Studio is part of the Pro, Max and Ultra plans/);
  await page3.click('#ss-new');
  await page3.waitForSelector('.acct-dialog .acct-plans');
  assert.match(await page3.textContent('.acct-dialog .acct-reason'), /Survey Studio is part of the Pro, Max and Ultra plans/);
  assert.ok(await page3.$('.acct-dialog .acct-plan.is-highlight [data-choose="pro"]'));

  // Sign out on the first device, removing the work from that browser
  await page.click('#acct-slot .acct-chip');
  await page.click('.acct-menu [data-m="out"]');
  await page.waitForSelector('text=Remove your projects and surveys from this browser?');
  await page.click('.acct-dialog .acct-primary');
  await page.waitForSelector('#acct-slot .acct-signin', { timeout: 15000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('strata_v1') === null || JSON.parse(localStorage.getItem('strata_v1')).posts.length === 0), true);
  assert.equal(await page.evaluate(() => document.cookie.includes('mc_session=')), false);

  const ignorable = m => /Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(m);
  assert.deepEqual(errors.filter(m => !ignorable(m)), []);
  assert.deepEqual(errors2.filter(m => !ignorable(m)), []);
  assert.deepEqual(errors3.filter(m => !ignorable(m)), []);
  await ctx.close(); await ctx2.close(); await ctx3.close();
});

test('sync: editing in two tabs never makes "(from another device)" copies; a real conflict makes exactly one; old copies are cleaned up', { skip, timeout: 180000 }, async () => {
  const seedWs = { fn: () => {
    if (localStorage.getItem('seeded')) return;
    localStorage.setItem('seeded', '1');
    localStorage.setItem('strata_v1', JSON.stringify({ project: { name: 'Untitled Project', description: '' }, posts: [{ id: 'p1', text: 'Rent is too high', humanCodes: {}, aiCodes: {} }], codebook: [{ id: 'tone', name: 'Tone', codes: [{ id: 'neg', label: 'Negative' }] }], network: { nodes: [], edges: [] }, settings: { model: '', delay: 500 } }));
  }, arg: null };
  sb.addUser('sync@example.org', 'sync password 1');
  const signIn = async (page, email, pw) => {
    await page.waitForSelector('[data-account-chip] .acct-signin');
    await page.click('[data-account-chip] .acct-signin');
    await page.fill('.acct-form [name=email]', email);
    await page.fill('.acct-form [name=password]', pw);
    await page.click('.acct-form .acct-primary');
  };
  const copies = page => page.evaluate(async () => (await LocalDB.all('projects')).filter(p => / \(from another device\)$/.test(p.name)).map(p => p.name));
  const edit = (page, text) => page.evaluate(t => { App.setState({ project: Object.assign({}, App.getState().project, { description: t }) }); }, text);
  const sync = page => page.evaluate(() => CloudSync.syncNow());

  // Device A: the app and Survey Studio open side by side (two tabs, one browser)
  const ctxA = await context(seedWs);
  const { page: app, errors } = await newPage(ctxA);
  await app.goto(baseUrl + '/app.html#dashboard');
  await signIn(app, 'sync@example.org', 'sync password 1');
  await app.waitForSelector('text=Add this browser\'s work to your account?');
  await app.click('.acct-dialog .acct-primary');
  const user = sb.users.get('sync@example.org');
  for (let i = 0; i < 100 && !sb.rows.some(r => r.user_id === user.id && r.kind === 'workspace'); i++) await app.waitForTimeout(100);
  const { page: studio } = await newPage(ctxA);
  await studio.goto(baseUrl + '/studio.html');
  await studio.waitForSelector('[data-account-chip] .acct-plan-badge');
  for (let i = 0; i < 4; i++) {
    await edit(app, 'edit ' + i);
    await sync(app);
    await sync(studio);
    await edit(app, 'edit ' + i + 'b');        // changed again before the other tab syncs
    await sync(studio);
    await sync(app);
    // Edited while a sync is running — in the same tab, and while the other tab syncs
    await app.evaluate(async t => { const p = CloudSync.syncNow(); App.setState({ project: Object.assign({}, App.getState().project, { description: t }) }); await p; }, 'edit ' + i + 'c');
    const other = studio.evaluate(() => CloudSync.syncNow());
    await edit(app, 'edit ' + i + 'd');
    await other;
    await sync(app);
  }
  await studio.waitForTimeout(300);
  assert.deepEqual(await copies(app), [], 'no copies from editing on one device');
  assert.deepEqual(await copies(studio), []);
  const ws = () => sb.rows.find(r => r.user_id === user.id && r.kind === 'workspace').data;
  await sync(app);
  assert.equal(ws().project.description, 'edit 3d', 'the account has the latest edit');
  assert.ok(!sb.rows.some(r => r.user_id === user.id && r.kind === 'projects' && / \(from another device\)$/.test((r.data || {}).name || '')));

  // Device B: changes there arrive on A without a copy when A hasn't changed anything
  const ctxB = await context();
  const { page: b } = await newPage(ctxB);
  await b.goto(baseUrl + '/app.html#dashboard');
  await signIn(b, 'sync@example.org', 'sync password 1');
  await b.waitForFunction(() => document.getElementById('stat-posts').textContent === '1', null, { timeout: 15000 });
  await edit(b, 'from B');
  await sync(b);
  await sync(app);
  assert.equal(await app.evaluate(() => App.getState().project.description), 'from B');
  assert.deepEqual(await copies(app), []);

  // A real conflict (both changed before syncing): exactly one copy, however often it syncs
  await edit(b, 'B again');
  await sync(b);
  await edit(app, 'A meanwhile');
  await app.evaluate(() => { localStorage.setItem('metacode_sync_copies_asked', '1'); });
  await sync(app);
  for (let i = 0; i < 3; i++) { await sync(app); await sync(studio); await sync(b); }
  assert.deepEqual(await copies(app), ['Untitled Project (from another device)']);
  assert.equal(await app.evaluate(() => App.getState().project.description), 'A meanwhile', 'the open project stays as it is on this device');
  await ctxB.close();

  // Copies an earlier version made: exact duplicates go quietly; the rest only if the person agrees
  await app.evaluate(async () => {
    localStorage.removeItem('metacode_sync_copies_asked');
    const cur = JSON.parse(localStorage.getItem('strata_v1'));
    const older = Object.assign({}, cur, { project: Object.assign({}, cur.project, { description: 'an older version' }) });
    const mk = (id, data) => LocalDB.put('projects', { id, name: 'Untitled Project (from another device)', createdAt: '2026-10-13T00:00:0' + id.slice(-1) + 'Z', savedAt: '2026-10-13T00:00:00Z', revision: 1, data });
    await mk('pr_syncold1', cur); await mk('pr_syncold2', cur); await mk('pr_syncold3', older); await mk('pr_syncold4', older);
  });
  await app.reload();
  await app.waitForSelector('text=Remove automatic copies?', { timeout: 15000 });
  assert.match(await app.textContent('.acct-dialog'), /saved 2 copies/, 'two exact duplicates of the open project were removed without asking; one of each older version is left to ask about… plus the conflict copy');
  await app.click('.acct-dialog .acct-primary');
  await app.waitForTimeout(500);
  assert.deepEqual(await copies(app), []);
  const ignorable = m => /Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(m);
  assert.deepEqual(errors.filter(m => !ignorable(m)), []);
  await ctxA.close();
});

test('with accounts off, the pages work as before (no sign-in, no locks)', { skip, timeout: 60000 }, async () => {
  // A second server process isn't needed: the config endpoint is what the pages read
  const c = await context();
  const { page } = await newPage(c);
  await page.route('**/api/account/config', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' }));
  await page.goto(baseUrl + '/app.html#scraper');
  await page.waitForSelector('.view-title');
  assert.equal(await page.isVisible('#acct-slot'), false);
  assert.equal(await page.isVisible('#nav-account'), false);
  assert.equal(await page.$('.nav-lock'), null);
  assert.equal(await page.$('.acct-gate'), null);
  assert.match(await page.textContent('.view-title'), /Reddit Scraper/);
  await c.close();
});
