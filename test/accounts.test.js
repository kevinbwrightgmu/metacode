// Accounts, plans and limits (accounts/, public/js/plans.js): the plan table,
// settings checks, usage counting, Stripe webhook signatures, and the whole
// server enforcing each plan — sign-in verified with (mock) Supabase Auth, plans
// from (mock) Stripe subscriptions, AI quotas with a (mock) AI service, scraper
// limits against a (mock) Reddit, Survey Studio publishing and response quotas,
// the in-app browser's WebSocket, moving a browser's data to an account, and
// checkout / billing portal / webhooks. Nothing here reaches the real Supabase
// project or Stripe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const Plans = require('../public/js/plans.js');
const { accountConfig, keyProblem } = require('../accounts/config');
const { UsageStore } = require('../accounts/usage');
const { createRateLimiter } = require('../accounts/rate');
const { verifyWebhook, formEncode } = require('../accounts/billing');
const { mockSupabase, mockStripe, stripeSignature, jwtFor } = require('./helpers/account-mocks');
const { createMockReddit } = require('./helpers/mock-reddit');
const { testEnv } = require('./helpers/harness');

/* ── Unit ─────────────────────────────────── */

test('plans: what each plan includes, as asked for — and every limit grows with the plan', () => {
  const f = id => Plans.get(id).features, L = id => Plans.get(id).limits;
  // no plan: no surveys, no scraper, AI coding up to 850 posts
  assert.equal(f('free').surveys, false); assert.equal(f('free').scraper, false); assert.equal(f('free').network, false);
  assert.equal(L('free').aiPostsPerWeek, 850);
  // pro: basic surveys, a tightly limited scraper, 2,300 posts
  assert.equal(f('pro').surveys, 'basic'); assert.equal(f('pro').scraper, true); assert.equal(f('pro').network, false); assert.equal(f('pro').aiScraper, false);
  assert.equal(L('pro').aiPostsPerWeek, 2300);
  assert.ok(L('pro').scrapeItemsPerJob <= 100 && L('pro').scrapeJobsPerDay <= 5, 'pro scraping is tightly limited');
  // max: full surveys, near-unlimited scraping, network analysis, 4,000 posts
  assert.equal(f('max').surveys, 'full'); assert.equal(f('max').network, true); assert.equal(f('max').aiScraper, true);
  assert.equal(L('max').aiPostsPerWeek, 4000);
  assert.ok(L('max').scrapeItemsPerMonth >= 100 * L('pro').scrapeItemsPerMonth);
  // ultra: everything, with fair-use ceilings
  Object.keys(f('ultra')).forEach(k => assert.ok(f('ultra')[k], k));
  for (const k of Object.keys(L('free'))) {
    for (let i = 1; i < Plans.ORDER.length; i++) assert.ok(L(Plans.ORDER[i])[k] >= L(Plans.ORDER[i - 1])[k], k + ' grows from ' + Plans.ORDER[i - 1] + ' to ' + Plans.ORDER[i]);
  }
  assert.equal(Plans.lowestWith('surveys').id, 'pro');
  assert.equal(Plans.lowestWith('network').id, 'max');
  assert.equal(Plans.get('nonsense').id, 'free');
  assert.ok(Plans.highlights('max').some(s => /network analysis/i.test(s)));
});

test('settings: accounts need both values, a publishable (never a secret) key, and https', () => {
  assert.equal(accountConfig({}).enabled, false);
  const ok = accountConfig({ SUPABASE_URL: 'https://abc.supabase.co/', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TESTONLYabcdefghijklmn' });
  assert.equal(ok.enabled, true);
  assert.equal(ok.supabaseUrl, 'https://abc.supabase.co');
  assert.equal(ok.stripe.enabled, false);
  assert.deepEqual(ok.stripe.products, { pro: 'prod_VQeJh2lPqfmae9', max: 'prod_VQeK26tKchu1VI', ultra: 'prod_VQeKXAJtQQLKqm' });
  assert.match(keyProblem('sb_secret_abcdefghijklmnop'), /secret key/);
  const serviceRole = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.sig';
  assert.match(keyProblem(serviceRole), /service_role/);
  for (const bad of [{ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnop' },
    { SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijk' },
    { SUPABASE_URL: 'https://abc.supabase.co' }]) {
    const c = accountConfig(bad);
    assert.equal(c.enabled, false);
    assert.equal(c.publishableKey, null, 'a refused key is never handed out');
    assert.ok(c.problems.length);
  }
  const o = accountConfig({ ACCOUNT_PLAN_OVERRIDES: 'Staff@Example.org=ultra, 1234=max, junk', STRIPE_SECRET_KEY: 'sk_test_abc123', STRIPE_API_BASE: 'http://evil.example' });
  assert.deepEqual(o.overrides, { byId: { 1234: 'max' }, byEmail: { 'staff@example.org': 'ultra' } });
  assert.equal(o.stripe.enabled, true);
  assert.equal(o.stripe.apiBase, 'https://api.stripe.com', 'Stripe calls only go to Stripe (or a local test server)');
});

test('settings: copy-paste damage in the key is cleaned up, and anything else is named precisely', () => {
  const KEYV = 'sb_publishable_TESTONLYabc-def_ghijklmn';
  const url = 'https://abc.supabase.co';
  // curly quotes, a lookalike dash, invisible characters, odd spaces
  for (const pasted of ['“' + KEYV + '”', KEYV.replace('-', '\u2011'), '\u200B' + KEYV + '\uFEFF', '\u00A0' + KEYV + ' ', '"' + KEYV + '"', '<' + KEYV + '>']) {
    const c = accountConfig({ SUPABASE_URL: '“' + url + '”', SUPABASE_PUBLISHABLE_KEY: pasted });
    assert.equal(c.enabled, true, JSON.stringify(pasted) + ' ' + c.problems.join(' '));
    assert.equal(c.publishableKey, KEYV);
    assert.equal(c.supabaseUrl, url);
  }
  const typo = accountConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TESTONLY abc' });
  assert.equal(typo.enabled, false);
  assert.match(typo.problems[0], /character 24 is a space/);
  const other = accountConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TESTONLY€abcdef' });
  assert.match(other.problems[0], /character 24 is “€” \(U\+20AC\), which can't be in a key/);
  const wrong = accountConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: 'pk_live_1234567890abcdef' });
  assert.match(wrong.problems[0], /should start with sb_publishable_ but starts with “pk_liv…”/);
  assert.ok(!/1234567890/.test(wrong.problems[0]), 'the rest of the key isn\'t repeated');
  // A secret key is still refused, quotes or not
  assert.equal(accountConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: '“sb_secret_abcdefghijklmnop”' }).enabled, false);
});

test('usage counters: reserve up to the limit, give back failures, AI coding posts reset every Monday, others each month and day, survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-usage-'));
  let t = Date.parse('2026-10-31T23:00:00Z');            // a Saturday, the last day of October
  const u = new UsageStore(dir, { now: () => t, writeDelayMs: 0 });
  let r = u.reserve('u1', 'aiPosts', 600, 850);
  assert.equal(r.granted, 600);
  r = u.reserve('u1', 'aiPosts', 600, 850);
  assert.equal(r.granted, 250, 'only what is left');
  assert.equal(r.resetsAt, '2026-11-02T00:00:00.000Z', 'AI coding posts reset on Monday 00:00 UTC');
  u.release('u1', 'aiPosts', 100, r.period);
  assert.equal(u.used('u1', 'aiPosts'), 750);
  const items = u.reserve('u1', 'scrapeItems', 400, 1000);
  assert.equal(items.resetsAt, '2026-11-01T00:00:00.000Z', 'monthly limits still reset on the 1st');
  u.reserve('u1', 'scrapeJobs', 2, 3);
  u.setCustomer('u1', 'cus_1');
  u.linkOwner('owner-hash', 'u1');
  u.flush();
  const again = new UsageStore(dir, { now: () => t });
  assert.equal(again.used('u1', 'aiPosts'), 750);
  assert.equal(again.customerOf('u1'), 'cus_1');
  assert.equal(again.userOfCustomer('cus_1'), 'u1');
  assert.equal(again.userOfOwner('owner-hash'), 'u1');
  // Sunday 1 November: a new month and a new day, but the same week
  t = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(again.used('u1', 'aiPosts'), 750, 'the week isn\'t over on the 1st of the month');
  assert.equal(again.used('u1', 'scrapeItems'), 0, 'a new month starts at zero');
  assert.equal(again.used('u1', 'scrapeJobs'), 0, 'a new day starts at zero');
  // Sunday 23:59 UTC: still the same week; Monday 00:00 UTC: a new one
  t = Date.parse('2026-11-01T23:59:59Z');
  assert.equal(again.used('u1', 'aiPosts'), 750);
  t = Date.parse('2026-11-02T00:00:00Z');
  assert.equal(again.used('u1', 'aiPosts'), 0, 'a new week starts at zero');
  assert.equal(again.reserve('u1', 'aiPosts', 0, 850).resetsAt, '2026-11-09T00:00:00.000Z');
  again.release('u1', 'aiPosts', 50, r.period);
  assert.equal(again.used('u1', 'aiPosts'), 0, 'last week\'s refunds don\'t touch this week');
  assert.equal(fs.statSync(path.join(dir, 'usage.json')).mode & 0o077, 0, 'the file is private to the server user');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rate limiter: a sliding minute and a cap on things running at once', () => {
  let t = 0;
  const r = createRateLimiter({ now: () => t });
  assert.ok(r.take('k', 2).ok); assert.ok(r.take('k', 2).ok);
  const no = r.take('k', 2);
  assert.equal(no.ok, false); assert.equal(no.retryAfter, 60);
  t = 60001;
  assert.ok(r.take('k', 2).ok);
  const a = r.acquire('b', 1);
  assert.ok(a); assert.equal(r.acquire('b', 1), null);
  a(); a();
  assert.ok(r.acquire('b', 1), 'released once, even if called twice');
});

test('Stripe webhooks: the signature must match and be recent', () => {
  const body = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } });
  const ev = verifyWebhook(Buffer.from(body), stripeSignature(body, 'whsec_x'), 'whsec_x');
  assert.equal(ev.type, 'customer.subscription.updated');
  assert.throws(() => verifyWebhook(Buffer.from(body), stripeSignature(body, 'whsec_other'), 'whsec_x'), /doesn't match/);
  assert.throws(() => verifyWebhook(Buffer.from(body + ' '), stripeSignature(body, 'whsec_x'), 'whsec_x'), /doesn't match/);
  assert.throws(() => verifyWebhook(Buffer.from(body), stripeSignature(body, 'whsec_x', Math.floor(Date.now() / 1000) - 3600), 'whsec_x'), /too old/);
  assert.throws(() => verifyWebhook(Buffer.from(body), '', 'whsec_x'), /Missing/);
  assert.equal(formEncode({ a: 1, line_items: { 0: { price: 'p', quantity: 1 } }, m: { k: 'v w' } }), 'a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&m%5Bk%5D=v%20w');
});

/* ── The server, enforcing plans ────────────── */

let sb, stripe, emis, reddit, server, base, tmp, accounts;
const OLD_BROWSER = 'c'.repeat(40);
const draft = (id, extra) => Object.assign({ id, title: 'Survey ' + id, pages: [{ id: 'p1', name: 'Page 1', elements: ['q1'] }], elements: { q1: { id: 'q1', type: 'shorttext', props: { title: 'Q?' } } } }, extra || {});
const KEY = 'sb_publishable_test_0123456789abcdef';
const T = {};       // tokens by plan
const U = {};       // users by plan

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-accounts-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  stripe = mockStripe({ key: 'sk_test_mock123', products: {
    prod_VQeJh2lPqfmae9: { id: 'prod_VQeJh2lPqfmae9', object: 'product', active: true, default_price: 'price_pro' },
    prod_VQeK26tKchu1VI: { id: 'prod_VQeK26tKchu1VI', object: 'product', active: true, default_price: 'price_max' },
    prod_VQeKXAJtQQLKqm: { id: 'prod_VQeKXAJtQQLKqm', object: 'product', active: true, default_price: { id: 'price_ultra' } }
  } });
  await stripe.start();
  emis = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'good-model' }, { id: 'broken-model' }] }));
      const j = JSON.parse(body || '{}');
      if (j.model === 'broken-model') { res.statusCode = 400; return res.end('{"error":{"message":"bad request"}}'); }
      res.end(JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: '{"codings":{}}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(r => emis.listen(0, '127.0.0.1', r));
  reddit = createMockReddit();
  const redditBase = await reddit.listen();
  for (const p of ['free', 'pro', 'max', 'ultra']) {
    U[p] = sb.addUser(p + '@example.org', 'pw-' + p);
    T[p] = sb.issue(U[p]).access_token;
  }
  U.staff = sb.addUser('staff@example.org', 'pw-staff');
  T.staff = sb.issue(U.staff).access_token;
  stripe.subscribe(U.pro.id, 'prod_VQeJh2lPqfmae9');
  stripe.subscribe(U.max.id, 'prod_VQeK26tKchu1VI');
  stripe.subscribe(U.max.id, 'prod_VQeJh2lPqfmae9', 'canceled');      // an old, ended subscription doesn't count
  stripe.subscribe(U.ultra.id, 'prod_VQeKXAJtQQLKqm', 'trialing');
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY,
    STRIPE_SECRET_KEY: 'sk_test_mock123', STRIPE_API_BASE: stripe.url, STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    ACCOUNT_PLAN_OVERRIDES: 'staff@example.org=max',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    EMIS_BASE_URL: 'http://127.0.0.1:' + emis.address().port + '/v1', EMIS_API_KEY: 'emis-test-key-123456', EMIS_TRANSPORT: 'node',
    EMIS_MODEL: 'good-model', EMIS_MODELS_FILE: path.join(tmp, 'none.json'),
    REDDIT_BASE_URL: redditBase, SCRAPER_RESPECT_ROBOTS_TXT: 'false', SCRAPER_TRANSPORT: 'epoxy'
  }));
  // A survey this browser published before accounts existed (owned by the browser, not an account)
  const { browserOwnerOf } = require('../owner');
  const owner = browserOwnerOf({ headers: { cookie: 'mc_owner=' + OLD_BROWSER } });
  fs.mkdirSync(path.join(tmp, 'surveys', 'surveys'), { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(tmp, 'surveys', 'surveys', 'svOld.json'), JSON.stringify({ id: 'svOld', owner, revision: 1, createdAt: at, updatedAt: at, doc: draft('svOld'), publish: null }));
  const mod = require('../server');
  accounts = mod.accounts;
  server = await mod.start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  for (const s of [sb, stripe, reddit]) if (s) await s.close();
  if (emis) { emis.closeAllConnections(); await new Promise(r => emis.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method, p, o) {
  o = o || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.token) headers.Cookie = 'mc_session=' + o.token + (o.browser ? '; mc_owner=' + o.browser : '');
  else if (o.browser) headers.Cookie = 'mc_owner=' + o.browser;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: o.body === undefined ? undefined : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}
const chat = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 };
const me = async who => (await api('GET', '/api/account/me', { token: T[who] })).json;

test('config and /me: public settings only, sign-in verified with Supabase, plans from Stripe and overrides', async () => {
  const cfg = await api('GET', '/api/account/config');
  assert.deepEqual(cfg.json, { enabled: true, supabaseUrl: sb.url, publishableKey: KEY, billing: true });
  assert.ok(!/sk_test|whsec/.test(cfg.text), 'no secret ever reaches the browser');
  const prices = await api('GET', '/api/account/prices');
  assert.deepEqual(prices.json.prices, { pro: { amount: 900, currency: 'usd', interval: 'month' }, max: { amount: 2900, currency: 'usd', interval: 'month' }, ultra: { amount: 7900, currency: 'usd', interval: 'month' } });

  assert.equal((await api('GET', '/api/account/me')).json.signedIn, false);
  const forged = jwtFor(U.ultra.id, U.ultra.email);    // looks right, but Supabase never issued it
  const bad = await api('GET', '/api/account/me', { token: forged });
  assert.equal(bad.json.signedIn, false);
  assert.equal(bad.json.reason, 'invalid');
  const byHeader = await api('GET', '/api/account/me', { headers: { Authorization: 'Bearer ' + T.pro } });
  assert.equal(byHeader.json.plan.id, 'pro');

  const free = await me('free');
  assert.equal(free.signedIn, true);
  assert.equal(free.user.email, 'free@example.org');
  assert.equal(free.plan.id, 'free');
  assert.equal(free.limits.aiPostsPerWeek, 850);
  assert.equal(free.usage.aiPosts.period, 'week');
  assert.equal(free.usage.aiPosts.limit, 850);
  assert.equal((await me('pro')).plan.id, 'pro');
  const max = await me('max');
  assert.equal(max.plan.id, 'max', 'the canceled Pro subscription is ignored; the active Max one counts');
  assert.equal(max.plan.status, 'active');
  assert.ok(max.plan.renewsAt);
  assert.equal((await me('ultra')).plan.id, 'ultra', 'a trial counts');
  const staff = await me('staff');
  assert.equal(staff.plan.id, 'max');
  assert.equal(staff.plan.source, 'override');
  assert.ok(sb.calls.filter(c => c.path === '/auth/v1/user').every(c => c.apikey === KEY));
  // Each token is checked with Supabase once a minute at most
  const before = sb.calls.filter(c => c.path === '/auth/v1/user').length;
  await me('free'); await me('free');
  assert.equal(sb.calls.filter(c => c.path === '/auth/v1/user').length, before);
});

test('AI: sign-in required; coded posts and other requests counted separately; failures aren\'t charged; the weekly limit holds', async () => {
  const anon = await api('POST', '/api/ai', { body: chat });
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error.type, 'sign_in_required');

  let r = await api('POST', '/api/ai', { token: T.free, body: chat });
  assert.equal(r.status, 200);
  r = await api('POST', '/api/ai', { token: T.free, body: chat, headers: { 'X-MetaCode-Feature': 'coding' } });
  assert.equal(r.status, 200);
  r = await api('POST', '/api/ai', { token: T.free, body: Object.assign({}, chat, { model: 'broken-model' }), headers: { 'X-MetaCode-Feature': 'coding' } });
  assert.ok(r.status >= 400);
  let u = (await me('free')).usage;
  assert.equal(u.aiRequests.used, 1);
  assert.equal(u.aiPosts.used, 1, 'the failed request was given back');

  // A batch near the limit: what's left is coded, the rest is refused per post
  accounts.usage.reserve(U.free.id, 'aiPosts', 846, 850);        // 847 used, 3 left
  const requests = Array.from({ length: 5 }, (_, i) => ({ id: 'p' + i, body: chat }));
  r = await api('POST', '/api/ai/batch', { token: T.free, body: { requests, parallel: 2 } });
  assert.equal(r.status, 200);
  const lines = r.text.trim().split('\n').map(l => JSON.parse(l));
  const results = lines.filter(l => l.id);
  assert.equal(results.filter(l => l.ok).length, 3);
  const refused = results.filter(l => !l.ok);
  assert.equal(refused.length, 2);
  assert.ok(refused.every(l => l.status === 429 && l.error.type === 'limit_reached' && /850 posts this week on the Free plan/.test(l.error.message) && /resets on Monday/.test(l.error.message) && /upgrade to Pro for 2,300 a week/.test(l.error.message)));
  assert.ok(lines[lines.length - 1].done);
  u = (await me('free')).usage;
  assert.equal(u.aiPosts.used, 850);
  r = await api('POST', '/api/ai/batch', { token: T.free, body: { requests: requests.slice(0, 1) } });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.type, 'limit_reached');
  assert.equal(r.json.error.meter, 'aiPosts');
  assert.equal(r.json.error.upgradeTo, 'pro');
  r = await api('POST', '/api/ai', { token: T.free, body: chat, headers: { 'X-MetaCode-Feature': 'coding' } });
  assert.equal(r.status, 429);
  // Batches whose answers fail are given back in full
  const before = (await me('pro')).usage.aiPosts.used;
  r = await api('POST', '/api/ai/batch', { token: T.pro, body: { requests: [{ id: 'x', body: Object.assign({}, chat, { model: 'broken-model' }) }], switchModels: false } });
  assert.equal(r.status, 200);
  assert.equal((await me('pro')).usage.aiPosts.used, before);
  // Requests per minute
  for (let i = 0; i < 25; i++) accounts.usage.release(U.free.id, 'aiRequests', 0);
  let last;
  for (let i = 0; i < 25; i++) { last = await api('POST', '/api/ai', { token: T.free, body: chat }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
  assert.equal(last.json.error.type, 'account_rate_limited');
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});

test('network analysis: Max and Ultra only', async () => {
  const edges = [{ source: 'a', target: 'b' }];
  assert.equal((await api('POST', '/api/network/analyze', { body: { edges } })).status, 401);
  const free = await api('POST', '/api/network/analyze', { token: T.free, body: { edges } });
  assert.equal(free.status, 402);
  assert.equal(free.json.error.type, 'plan_required');
  assert.equal(free.json.error.requiredPlan, 'max');
  assert.match(free.json.error.message, /Social network analysis is part of the Max and Ultra plans/);
  assert.equal((await api('POST', '/api/network/analyze', { token: T.pro, body: { edges } })).status, 402);
  const max = await api('POST', '/api/network/analyze', { token: T.max, body: { edges } });
  assert.notEqual(max.status, 402);
  assert.notEqual(max.status, 401);
  assert.equal((await api('GET', '/api/network/status')).status, 200, 'the status check stays open');
});

test('Reddit Scraper: none on Free; Pro is held to its per-job, at-once and per-day limits and charged only for what it collected', async () => {
  assert.equal((await api('GET', '/api/scraper/status')).status, 200, 'status stays open (the page uses it)');
  const job = { target: { type: 'subreddit', subreddit: 'test', sort: 'new' }, options: { maxItems: 5000, includeMetadata: false } };
  assert.equal((await api('POST', '/api/scraper/jobs', { body: job })).json.error.type, 'sign_in_required');
  const free = await api('POST', '/api/scraper/jobs', { token: T.free, body: job });
  assert.equal(free.status, 402);
  assert.equal(free.json.error.requiredPlan, 'pro');
  assert.equal((await api('GET', '/api/scraper/jobs', { token: T.free })).status, 402);
  // Pro: custom code and the AI Scraper are for Max and Ultra
  const custom = await api('POST', '/api/scraper/jobs', { token: T.pro, body: { mode: 'custom', code: 'ctx.log("x")' } });
  assert.equal(custom.status, 402);
  assert.equal(custom.json.error.feature, 'customCode');
  const ai = await api('POST', '/api/scraper/jobs', { token: T.pro, body: { mode: 'ai', goal: 'posts about cats' } });
  assert.ok([402, 503].includes(ai.status));
  // The job's item cap is lowered to 100
  const slow = { target: { type: 'subreddit', subreddit: 'slowsub', sort: 'new' }, options: { maxItems: 5000, maxPages: 5, delayMs: 1500, includeMetadata: false } };
  const one = await api('POST', '/api/scraper/jobs', { token: T.pro, body: slow });
  assert.equal(one.status, 202);
  assert.ok(one.json.job.options ? one.json.job.options.maxItems <= 100 : true);
  const two = await api('POST', '/api/scraper/jobs', { token: T.pro, body: job });
  assert.equal(two.status, 429, 'Pro runs one scrape at a time');
  assert.match(two.json.error.message, /1 scrape at a time/);
  await api('POST', '/api/scraper/jobs/' + one.json.job.id + '/cancel', { token: T.pro, body: {} });
  for (let i = 0; i < 100; i++) { const j = (await api('GET', '/api/scraper/jobs/' + one.json.job.id, { token: T.pro })).json.job; if (['completed', 'failed', 'cancelled'].includes(j.status)) break; await new Promise(r => setTimeout(r, 50)); }
  const done = await api('POST', '/api/scraper/jobs', { token: T.pro, body: job });
  assert.equal(done.status, 202);
  let j;
  for (let i = 0; i < 400; i++) { j = (await api('GET', '/api/scraper/jobs/' + done.json.job.id, { token: T.pro })).json.job; if (['completed', 'failed', 'cancelled'].includes(j.status)) break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(j.status, 'completed');
  assert.equal(j.itemCount, 100, 'capped at Pro\'s 100 items per job');
  const usage = (await me('pro')).usage;
  assert.equal(usage.scrapeJobs.used, 2);
  assert.equal(usage.scrapeItems.used, 100 + (await api('GET', '/api/scraper/jobs/' + one.json.job.id, { token: T.pro })).json.job.itemCount, 'charged for what was collected, not the 5,000 asked for');
  // Another browser of someone else can't see it
  assert.equal((await api('GET', '/api/scraper/jobs/' + done.json.job.id, { token: T.max })).status, 404);
  const third = await api('POST', '/api/scraper/jobs', { token: T.pro, body: job });
  assert.equal(third.status, 202);
  for (let i = 0; i < 400; i++) { j = (await api('GET', '/api/scraper/jobs/' + third.json.job.id, { token: T.pro })).json.job; if (['completed', 'failed', 'cancelled'].includes(j.status)) break; await new Promise(r => setTimeout(r, 50)); }
  const fourth = await api('POST', '/api/scraper/jobs', { token: T.pro, body: job });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.error.meter, 'scrapeJobs');
  assert.match(fourth.json.error.message, /3 jobs today on the Pro plan/);
});

test('the in-app browser\'s WebSocket needs a plan with the scraper (the server\'s own connection is exempt)', async () => {
  const upgrade = cookie => new Promise(resolve => {
    const s = net.connect(server.address().port, '127.0.0.1', () => {
      s.write('GET /wisp/ HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nX-Forwarded-For: 203.0.113.9\r\n' + (cookie ? 'Cookie: ' + cookie + '\r\n' : '') + '\r\n');
    });
    let buf = '';
    s.on('data', d => { buf += d; if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('error', () => resolve(buf.split('\r\n')[0] || 'error'));
    s.on('close', () => resolve(buf.split('\r\n')[0] || 'closed'));
  });
  assert.match(await upgrade(null), / 401 /);
  // A browser behind a proxy that doesn't add X-Forwarded-For still sends Origin: not exempt
  const direct = await new Promise(resolve => {
    const s = net.connect(server.address().port, '127.0.0.1', () => s.write('GET /wisp/ HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
    let buf = '';
    s.on('data', d => { buf += d; if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('close', () => resolve(buf.split('\r\n')[0] || 'closed'));
  });
  assert.match(direct, / 401 /);
  assert.match(await upgrade('mc_session=' + T.free), / 402 /);
  assert.doesNotMatch(await upgrade('mc_session=' + T.pro), / 40[12] /);
});

test('Survey Studio: none on Free; Pro is basic (3 live surveys, no IP / location / timelines); Max has it all; responses count against the owner\'s plan', async () => {
  const pub = (who, id, doc) => api('POST', '/api/surveys/' + id + '/publish', { token: T[who], body: { doc: doc || draft(id) } });
  assert.equal((await api('POST', '/api/surveys/svA/publish', { body: { doc: draft('svA') }, browser: 'b'.repeat(40) })).json.error.type, 'sign_in_required');
  const free = await pub('free', 'svFree');
  assert.equal(free.status, 402);
  assert.match(free.json.error.message, /Survey Studio is part of the Pro, Max and Ultra plans/);
  assert.equal((await api('GET', '/api/surveys', { token: T.free })).status, 200, 'listing (and exporting) your own data stays open');

  for (const id of ['svP1', 'svP2', 'svP3']) { const r = await pub('pro', id); assert.equal(r.status, 200, id + ' ' + r.text); }
  assert.equal((await pub('pro', 'svP1')).status, 200, 're-publishing a live survey is fine');
  const fourth = await pub('pro', 'svP4');
  assert.equal(fourth.status, 429);
  assert.match(fourth.json.error.message, /3 live surveys at a time/);
  // Closing one makes room
  await api('PATCH', '/api/surveys/svP3/publish', { token: T.pro, body: { open: false } });
  assert.equal((await pub('pro', 'svP4')).status, 200);
  assert.equal((await api('PATCH', '/api/surveys/svP3/publish', { token: T.pro, body: { open: true } })).status, 429, 'reopening counts too');
  // IP addresses / session timelines need Max
  const withIp = draft('svIp', { elements: { q1: { id: 'q1', type: 'shorttext', props: { title: 'Q?' } }, r1: { id: 'r1', type: 'respondent', props: { fields: { ip: { on: true } } } } }, pages: [{ id: 'p1', name: 'P', elements: ['r1', 'q1'] }] });
  await api('PATCH', '/api/surveys/svP4/publish', { token: T.pro, body: { open: false } });
  const adv = await pub('pro', 'svIp', withIp);
  assert.equal(adv.status, 402);
  assert.equal(adv.json.error.feature, 'surveyAdvanced');
  assert.equal((await pub('max', 'svIp', withIp)).status, 200);
  const withTimeline = draft('svTl', { settings: { sessionRecording: 'consent' } });
  assert.equal((await pub('pro', 'svTl', withTimeline)).status, 402);

  // Responses: counted against the owner's monthly allowance
  const live = await api('GET', '/api/surveys', { token: T.pro });
  const p1 = live.json.surveys.find(s => s.id === 'svP1');
  const respond = () => api('POST', '/api/public/surveys/' + p1.publish.publicId + '/responses', { body: { answers: { q1: 'hello' }, complete: true } });
  assert.equal((await respond()).status, 201);
  assert.equal((await me('pro')).usage.surveyResponses.used, 1);
  accounts.usage.reserve(U.pro.id, 'surveyResponses', 1000, 300);
  const closed = await respond();
  assert.equal(closed.status, 403);
  assert.equal(closed.json.error.type, 'closed');
  assert.equal(closed.json.error.message, 'This survey isn\'t accepting responses right now.', 'respondents see nothing about the owner\'s plan');
});

test('signing in moves this browser\'s surveys to the account', async () => {
  // Before: the browser sees it without signing in; the account doesn't
  assert.ok((await api('GET', '/api/surveys', { browser: OLD_BROWSER })).json.surveys.some(s => s.id === 'svOld'));
  assert.ok(!(await api('GET', '/api/surveys', { token: T.max, browser: OLD_BROWSER })).json.surveys.some(s => s.id === 'svOld'));
  assert.equal((await api('POST', '/api/account/claim', { browser: OLD_BROWSER })).status, 401);
  const claim = await api('POST', '/api/account/claim', { token: T.max, browser: OLD_BROWSER });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.moved.surveys, 1);
  // After: it belongs to the account, from any browser it signs in on
  assert.ok((await api('GET', '/api/surveys', { token: T.max, browser: 'd'.repeat(40) })).json.surveys.some(s => s.id === 'svOld'));
  assert.ok(!(await api('GET', '/api/surveys', { browser: OLD_BROWSER })).json.surveys.some(s => s.id === 'svOld'));
  assert.ok(!(await api('GET', '/api/surveys', { token: T.pro, browser: OLD_BROWSER })).json.surveys.some(s => s.id === 'svOld'), 'another account can\'t see it');
});

test('billing: checkout for a new subscriber, the portal for a subscriber, webhooks drop the cached plan at once', async () => {
  const anon = await api('POST', '/api/billing/checkout', { body: { plan: 'pro' } });
  assert.equal(anon.status, 401);
  assert.equal((await api('POST', '/api/billing/checkout', { token: T.free, body: { plan: 'gold' } })).status, 400);
  const co = await api('POST', '/api/billing/checkout', { token: T.free, body: { plan: 'max' }, headers: { Host: 'metacode.test' } });
  assert.equal(co.status, 200, co.text);
  assert.match(co.json.url, /^https:\/\/checkout\.stripe\.test\//);
  const session = stripe.sessions[stripe.sessions.length - 1];
  assert.equal(session['line_items[0][price]'], 'price_max', 'the product\'s default price');
  assert.equal(session.mode, 'subscription');
  assert.equal(session.client_reference_id, U.free.id);
  assert.equal(session['subscription_data[metadata][supabase_user_id]'], U.free.id);
  assert.match(session.success_url, /\/app\.html#account\/success$/);
  const created = stripe.calls.find(c => c.method === 'POST' && c.path === '/v1/customers');
  assert.equal(created.idempotency, 'metacode-customer-' + U.free.id);
  assert.ok(stripe.calls.every(c => c.auth === 'Bearer sk_test_mock123'));
  // A second checkout reuses the customer
  await api('POST', '/api/billing/checkout', { token: T.free, body: { plan: 'pro' } });
  assert.equal(stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/customers').length, 1);

  // Already subscribed → the billing portal (to switch or cancel)
  const sub = await api('POST', '/api/billing/checkout', { token: T.pro, body: { plan: 'max' } });
  assert.equal(sub.json.portal, true);
  assert.match(sub.json.url, /^https:\/\/billing\.stripe\.test\//);
  assert.equal((await api('POST', '/api/billing/portal', { token: T.max })).status, 200);
  assert.equal((await api('POST', '/api/billing/checkout', { token: T.staff, body: { plan: 'ultra' } })).status, 409, 'plans set by the administrators aren\'t sold');

  // The free user subscribes: until Stripe says so the cached plan stands; the webhook updates it at once
  stripe.subscribe(U.free.id, 'prod_VQeK26tKchu1VI');
  assert.equal((await me('free')).plan.id, 'free');
  const event = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.created', data: { object: { object: 'subscription', customer: Array.from(stripe.customers.values()).find(c => c.metadata.supabase_user_id === U.free.id).id } } });
  const forged = await api('POST', '/api/billing/webhook', { body: event, headers: { 'Stripe-Signature': stripeSignature(event, 'whsec_wrong') } });
  assert.equal(forged.status, 400);
  assert.equal((await me('free')).plan.id, 'free');
  const ok = await api('POST', '/api/billing/webhook', { body: event, headers: { 'Stripe-Signature': stripeSignature(event, 'whsec_test_secret') } });
  assert.equal(ok.status, 200);
  assert.equal((await me('free')).plan.id, 'max');
  // Returning from checkout can also ask for a refresh
  assert.equal((await api('POST', '/api/billing/sync', { token: T.free })).json.plan, 'max');
  assert.ok(!/sk_test|whsec/.test(JSON.stringify(await me('free'))));
});
