// /api/desktop — MetaCode Sheets' access to the server (desktop-api/): who may
// use the desktop app (Pro, Max and Ultra — plans.js), the signed offline
// leases, and the app's AI routes, enforced on the server. Sign-in is checked
// with (mock) Supabase Auth and plans come from (mock) Stripe subscriptions,
// as for the website (test/accounts.test.js); nothing here reaches the real
// services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const Plans = require('../public/js/plans.js');
const { verifyLease, loadLeaseKey, signLease } = require('../desktop-api/lease');
const { mockSupabase, mockStripe, stripeSignature, jwtFor } = require('./helpers/account-mocks');
const { testEnv } = require('./helpers/harness');

const KEY = 'sb_publishable_test_0123456789abcdef';
const PROD = { pro: 'prod_VQeJh2lPqfmae9', max: 'prod_VQeK26tKchu1VI', ultra: 'prod_VQeKXAJtQQLKqm' };
let sb, stripe, stripeOpts, emis, server, base, tmp, mod;
const U = {}, T = {}, SUB = {};
const emisCalls = [];

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-desktop-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  stripeOpts = { key: 'sk_test_mock123', denied: [], products: {
    [PROD.pro]: { id: PROD.pro, object: 'product', active: true, default_price: 'price_pro' },
    [PROD.max]: { id: PROD.max, object: 'product', active: true, default_price: 'price_max' },
    [PROD.ultra]: { id: PROD.ultra, object: 'product', active: true, default_price: 'price_ultra' }
  } };
  stripe = mockStripe(stripeOpts);
  await stripe.start();
  emis = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'good-model' }] }));
      const j = JSON.parse(body || '{}');
      emisCalls.push(j);
      const last = j.messages[j.messages.length - 1].content;
      res.end(JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: /Code this/.test(last) ? '{"codings":{"tone":{"code":"pos","confidence":0.9,"reasoning":"x"}}}' : '=SUM(A1:A10)' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(r => emis.listen(0, '127.0.0.1', r));
  for (const p of ['free', 'pro', 'max', 'ultra', 'pastdue', 'canceled', 'downgraded', 'stripedown']) {
    U[p] = sb.addUser(p + '@example.org', 'pw-' + p);
    T[p] = sb.issue(U[p]).access_token;
  }
  SUB.pro = stripe.subscribe(U.pro.id, PROD.pro);
  SUB.max = stripe.subscribe(U.max.id, PROD.max);
  SUB.ultra = stripe.subscribe(U.ultra.id, PROD.ultra, 'trialing');
  SUB.pastdue = stripe.subscribe(U.pastdue.id, PROD.pro, 'past_due');
  SUB.canceled = stripe.subscribe(U.canceled.id, PROD.max, 'canceled');
  SUB.downgraded = stripe.subscribe(U.downgraded.id, PROD.ultra);
  SUB.stripedown = stripe.subscribe(U.stripedown.id, PROD.pro);
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY,
    STRIPE_SECRET_KEY: 'sk_test_mock123', STRIPE_API_BASE: stripe.url, STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    EMIS_BASE_URL: 'http://127.0.0.1:' + emis.address().port + '/v1', EMIS_API_KEY: 'emis-test-key-123456', EMIS_TRANSPORT: 'node',
    EMIS_MODEL: 'good-model', EMIS_MODELS_FILE: path.join(tmp, 'none.json'), PUBLIC_URL: '', DESKTOP_OFFLINE_HOURS: '48'
  }));
  delete process.env.DESKTOP_LEASE_PRIVATE_KEY;
  mod = require('../server');
  server = await mod.start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  for (const s of [sb, stripe]) if (s) await s.close();
  if (emis) { emis.closeAllConnections(); await new Promise(r => emis.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method, p, o) {
  o = o || {};
  const headers = Object.assign({}, o.headers || {});
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}
const entitlement = who => api('GET', '/api/desktop/entitlement', { token: T[who] });
const config = async () => (await api('GET', '/api/desktop/config')).json;

test('plans: the desktop app is part of Pro, Max and Ultra — not Free', () => {
  assert.deepEqual(Plans.ORDER.filter(id => Plans.has(id, 'desktop')), ['pro', 'max', 'ultra']);
  assert.equal(Plans.lowestWith('desktop').id, 'pro');
  assert.ok(Plans.highlights('pro').some(s => /desktop app/i.test(s)));
  assert.ok(!Plans.highlights('free').some(s => /desktop app/i.test(s)));
});

test('config: public settings only — the Supabase project, the lease public key and the upgrade page', async () => {
  const r = await api('GET', '/api/desktop/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.available, true);
  assert.deepEqual(r.json.accounts, { enabled: true, supabaseUrl: sb.url, publishableKey: KEY });
  assert.equal(r.json.lease.alg, 'Ed25519');
  assert.match(r.json.lease.publicKey, /^[A-Za-z0-9+/=]{40,}$/);
  assert.equal(r.json.offlineHours, 48);
  assert.deepEqual(r.json.plansWithDesktop, ['pro', 'max', 'ultra']);
  assert.equal(r.json.upgradeUrl, base + '/app.html#account', 'the website\'s own plans page');
  assert.ok(!/sk_test|whsec|PRIVATE KEY|emis-test-key/.test(r.text), 'no secret ever reaches the app');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  // The key is generated once and kept (owner-only) in the account data folder
  const file = path.join(tmp, 'accounts', 'desktop-lease-key.pem');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by the server\'s user only');
});

test('Pro, Max and Ultra (trialing) users get a lease signed by the server; past-due still counts, as on the website', async () => {
  const key = (await config()).lease.publicKey;
  for (const who of ['pro', 'max', 'ultra', 'pastdue']) {
    const r = await entitlement(who);
    assert.equal(r.status, 200, who + ': ' + r.text);
    assert.equal(r.json.entitled, true, who);
    const lease = verifyLease(r.json.lease.token, key);
    assert.ok(lease, who + ': the lease verifies with the server\'s public key');
    assert.equal(lease.sub, U[who].id);
    assert.equal(lease.plan, who === 'pastdue' ? 'pro' : who);
    assert.equal(lease.srv, base);
    assert.ok(Math.abs(lease.exp - lease.iat - 48 * 3600) <= 1, 'valid for DESKTOP_OFFLINE_HOURS');
    assert.equal(r.json.plan.id, lease.plan);
    assert.equal(r.json.features.desktop, true);
  }
  assert.equal((await entitlement('ultra')).json.plan.status, 'trialing');
});

test('Free users and ended subscriptions are refused, with the upgrade page — and get no lease', async () => {
  for (const who of ['free', 'canceled']) {
    const r = await entitlement(who);
    assert.equal(r.status, 200);
    assert.equal(r.json.entitled, false, who);
    assert.equal(r.json.reason, 'plan_required');
    assert.equal(r.json.lease, undefined, who + ' gets no lease');
    assert.equal(r.json.requiredPlan, 'pro');
    assert.deepEqual(r.json.plansWithDesktop, ['Pro', 'Max', 'Ultra']);
    assert.equal(r.json.upgradeUrl, base + '/app.html#account');
  }
});

test('a subscription that ends (or is downgraded to Free) stops new leases as soon as Stripe says so', async () => {
  assert.equal((await entitlement('downgraded')).json.entitled, true);
  SUB.downgraded.status = 'canceled';
  // Stripe tells MetaCode (signed webhook) → the cached plan is dropped
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.deleted', data: { object: { object: 'subscription', customer: SUB.downgraded.customer, metadata: { supabase_user_id: U.downgraded.id } } } });
  const hook = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSignature(body, 'whsec_test_secret') }, body });
  assert.equal(hook.status, 200);
  const r = await entitlement('downgraded');
  assert.equal(r.json.entitled, false);
  assert.equal(r.json.plan.id, 'free');
  assert.equal((await api('POST', '/api/desktop/ai', { token: T.downgraded, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 402, 'and the premium routes refuse at once');
});

test('no, forged or expired sign-ins are refused (401); Stripe being unreachable is 503, not a downgrade', async () => {
  assert.equal((await api('GET', '/api/desktop/entitlement')).status, 401);
  const forged = await api('GET', '/api/desktop/entitlement', { token: jwtFor(U.ultra.id, U.ultra.email) });
  assert.equal(forged.status, 401);
  assert.equal(forged.json.error.type, 'sign_in_required');
  const expired = await api('GET', '/api/desktop/entitlement', { token: jwtFor(U.pro.id, U.pro.email, -60) });
  assert.equal(expired.status, 401);
  assert.match(expired.json.error.message, /expired/);
  stripeOpts.denied.push('/v1/subscriptions');
  try {
    const r = await entitlement('stripedown');
    assert.equal(r.status, 503, 'the app keeps its lease instead of locking: ' + r.text);
    assert.equal(r.json.error.type, 'account_unavailable');
  } finally { stripeOpts.denied.length = 0; }
});

test('the AI routes are for desktop plans only, counted against the plan\'s AI limits, and refuse other websites', async () => {
  const chat = { messages: [{ role: 'system', content: 'Write a spreadsheet formula.' }, { role: 'user', content: 'sum of A1 to A10' }], max_tokens: 50 };
  const free = await api('POST', '/api/desktop/ai', { token: T.free, body: chat });
  assert.equal(free.status, 402);
  assert.equal(free.json.error.type, 'plan_required');
  assert.match(free.json.error.message, /Pro, Max and Ultra/);
  assert.equal((await api('POST', '/api/desktop/ai', { body: chat })).status, 401);
  const before = (await api('GET', '/api/account/me', { token: T.pro })).json.usage.aiRequests.used;
  const ok = await api('POST', '/api/desktop/ai', { token: T.pro, body: chat });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json, { text: '=SUM(A1:A10)', model: 'good-model' });
  assert.equal((await api('GET', '/api/account/me', { token: T.pro })).json.usage.aiRequests.used, before + 1, 'one "other AI request"');
  // Bad bodies
  assert.equal((await api('POST', '/api/desktop/ai', { token: T.pro, body: { messages: [] } })).status, 400);
  assert.equal((await api('POST', '/api/desktop/ai', { token: T.pro, body: Object.assign({ stream: true }, chat) })).status, 400);
  // A page on another website can't use someone's session here
  const cross = await api('POST', '/api/desktop/ai', { token: T.pro, body: chat, headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.type, 'forbidden_origin');
});

test('AI Coding batches from the desktop: desktop plans only, counted as coded posts', async () => {
  const req = n => ({ id: 'r' + n, body: { messages: [{ role: 'system', content: 'codebook' }, { role: 'user', content: 'Code this post: "' + n + '"' }], max_tokens: 100 } });
  const free = await api('POST', '/api/desktop/ai/batch', { token: T.free, body: { requests: [req(1)] } });
  assert.equal(free.status, 402);
  const before = (await api('GET', '/api/account/me', { token: T.max })).json.usage.aiPosts.used;
  const r = await api('POST', '/api/desktop/ai/batch', { token: T.max, body: { requests: [req(1), req(2), req(3)], parallel: 2 } });
  assert.equal(r.status, 200);
  const lines = r.text.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.filter(l => l.ok).length, 3);
  assert.deepEqual(lines[lines.length - 1].done, true);
  assert.equal((await api('GET', '/api/account/me', { token: T.max })).json.usage.aiPosts.used, before + 3);
});

test('a lease can\'t be edited, extended or forged on the computer', () => {
  const key = loadLeaseKey({ env: {}, dataDir: path.join(tmp, 'accounts') });
  const { token } = signLease(key, { sub: U.pro.id, plan: 'pro', server: 'https://metac0.de', ttlMs: 3600e3 });
  assert.ok(verifyLease(token, key.publicKeyB64));
  const [body, sig] = token.split('.');
  const edit = obj => Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(body, 'base64url').toString()), obj))).toString('base64url') + '.' + sig;
  assert.equal(verifyLease(edit({ plan: 'ultra' }), key.publicKeyB64), null, 'another plan');
  assert.equal(verifyLease(edit({ exp: 9999999999 }), key.publicKeyB64), null, 'a later expiry');
  assert.equal(verifyLease(edit({ sub: U.free.id }), key.publicKeyB64), null, 'another account');
  // Signed with some other key
  const other = { privateKey: crypto.generateKeyPairSync('ed25519').privateKey, kid: 'x' };
  const forged = signLease(/** @type {any} */ (other), { sub: U.free.id, plan: 'ultra', server: 'https://metac0.de', ttlMs: 3600e3 });
  assert.equal(verifyLease(forged.token, key.publicKeyB64), null);
  assert.equal(verifyLease('garbage', key.publicKeyB64), null);
  // A configured key (DESKTOP_LEASE_PRIVATE_KEY) is used as given
  const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n');
  assert.equal(loadLeaseKey({ env: { DESKTOP_LEASE_PRIVATE_KEY: pem }, dataDir: tmp }).source, 'env');
  assert.throws(() => loadLeaseKey({ env: { DESKTOP_LEASE_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, dataDir: tmp }), /Ed25519/);
});

test('with accounts off the desktop app is unavailable — unless a private server opts in with DESKTOP_WITHOUT_ACCOUNTS', async () => {
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = '';
  try {
    const c = await config();
    assert.equal(c.available, false);
    assert.match(c.reason, /accounts turned on/);
    assert.equal((await api('GET', '/api/desktop/entitlement')).status, 403);
    assert.equal((await api('POST', '/api/desktop/ai', { body: { messages: [{ role: 'user', content: 'x' }] } })).status, 403);
    process.env.DESKTOP_WITHOUT_ACCOUNTS = 'true';
    const c2 = await config();
    assert.equal(c2.available, true);
    assert.deepEqual(c2.accounts, { enabled: false, withoutAccounts: true });
    const r = await api('GET', '/api/desktop/entitlement');
    assert.equal(r.json.entitled, true);
    assert.equal(verifyLease(r.json.lease.token, c2.lease.publicKey).sub, 'local');
  } finally {
    process.env.SUPABASE_URL = saved;
    delete process.env.DESKTOP_WITHOUT_ACCOUNTS;
  }
  process.env.DESKTOP_ENABLED = 'false';
  try { assert.equal((await config()).available, false); } finally { delete process.env.DESKTOP_ENABLED; }
});
