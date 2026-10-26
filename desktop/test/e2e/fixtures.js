// The world MetaCode Sheets talks to, for end-to-end tests: the real MetaCode
// server (server.js) with stand-ins for Supabase (accounts), Stripe (plans)
// and the AI service — the same stand-ins the server's own tests use
// (test/helpers/account-mocks.js). Nothing here reaches a real service.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..', '..');
const { mockSupabase, mockStripe, stripeSignature } = require(path.join(ROOT, 'test', 'helpers', 'account-mocks'));
const { testEnv } = require(path.join(ROOT, 'test', 'helpers', 'harness'));

const KEY = 'sb_publishable_test_0123456789abcdef';
const PROD = { pro: 'prod_VQeJh2lPqfmae9', max: 'prod_VQeK26tKchu1VI', ultra: 'prod_VQeKXAJtQQLKqm' };

/** A stand-in for MetaCode's AI service that answers formula, coding and transform requests */
function mockAi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'good-model' }] }));
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }      // (GET /v1/status: readiness unknown)
      const j = JSON.parse(body || '{}');
      calls.push(j);
      const sys = (j.messages[0] && j.messages[0].content) || '';
      const last = j.messages[j.messages.length - 1].content;
      let content = 'An answer.';
      if (/Code this post/.test(last)) content = '{"codings":{"sentiment":{"code":"' + (/love|great/i.test(last) ? 'pos' : 'neg') + '","confidence":0.9,"reasoning":"Tone of the post."}}}';
      else if (/write spreadsheet formulas/i.test(sys)) content = '{"formula":"=SUM(B2:B4)","explanation":"Adds the scores."}';
      else if (/transform spreadsheet cell values/i.test(sys)) { const m = /Values: (\[.*\])$/s.exec(last); const arr = m ? JSON.parse(m[1]) : []; content = JSON.stringify(arr.map(v => (typeof v === 'string' ? v.toUpperCase() : v))); }
      res.end(JSON.stringify({ model: j.model || 'good-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
  });
  return { server, calls, start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port))) };
}

async function startWorld(o = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsheets-e2e-'));
  const sb = mockSupabase({ apikey: KEY });
  await sb.start();
  const stripeOpts = { key: 'sk_test_mock123', denied: [], products: {
    [PROD.pro]: { id: PROD.pro, object: 'product', active: true, default_price: 'price_pro' },
    [PROD.max]: { id: PROD.max, object: 'product', active: true, default_price: 'price_max' },
    [PROD.ultra]: { id: PROD.ultra, object: 'product', active: true, default_price: 'price_ultra' } } };
  const stripe = mockStripe(stripeOpts);
  await stripe.start();
  const ai = mockAi();
  const aiUrl = await ai.start();
  const users = {};
  for (const p of ['free', 'pro', 'max', 'ultra', 'expired', 'revoked']) users[p] = Object.assign(sb.addUser(p + '@example.org', 'pw-' + p + '-123'), { password: 'pw-' + p + '-123' });
  const subs = {
    pro: stripe.subscribe(users.pro.id, PROD.pro), max: stripe.subscribe(users.max.id, PROD.max), ultra: stripe.subscribe(users.ultra.id, PROD.ultra),
    expired: stripe.subscribe(users.expired.id, PROD.pro, 'canceled'), revoked: stripe.subscribe(users.revoked.id, PROD.max)
  };
  Object.assign(process.env, testEnv(Object.assign({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY,
    STRIPE_SECRET_KEY: 'sk_test_mock123', STRIPE_API_BASE: stripe.url, STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    OPENCODE_SERVICE_URL: aiUrl + '/v1', OPENCODE_SERVICE_TOKEN: 'test-service-token-0123456789', OPENCODE_MODEL: 'good-model',
    PUBLIC_URL: '', DESKTOP_OFFLINE_HOURS: '48'
  }, o.env || {})));
  delete process.env.DESKTOP_LEASE_PRIVATE_KEY;
  const mod = require(path.join(ROOT, 'server'));
  let server = await mod.start(0);
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  return {
    tmp, sb, stripe, stripeOpts, ai, users, subs, base, mod,
    /** Ends a subscription in Stripe and tells MetaCode (signed webhook), as Stripe does */
    async cancel(who) {
      subs[who].status = 'canceled';
      const body = JSON.stringify({ id: 'evt_' + Date.now(), type: 'customer.subscription.deleted', data: { object: { object: 'subscription', customer: subs[who].customer, metadata: { supabase_user_id: users[who].id } } } });
      const r = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSignature(body, 'whsec_test_secret') }, body });
      if (r.status !== 200) throw new Error('webhook ' + r.status);
    },
    /** Takes the MetaCode server off the network (and back) */
    async serverDown() { server.closeAllConnections(); await new Promise(r => server.close(r)); },
    async serverUp() { server = await mod.start(port); },
    async close() {
      try { server.closeAllConnections(); await new Promise(r => server.close(r)); } catch (e) { /* already down */ }
      await sb.close(); await stripe.close();
      ai.server.closeAllConnections(); await new Promise(r => ai.server.close(r));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** Starts the app (development build) against a server, with its own data folders */
async function launchApp(world, o = {}) {
  // playwright-core from desktop/node_modules: it finds Electron there and
  // holds the app's "ready" until it's attached (no race with the first window)
  const { _electron } = require('playwright-core');
  const userData = o.userData || fs.mkdtempSync(path.join(world.tmp, 'ud-'));
  const library = o.library || path.join(userData, 'Library');
  const args = [path.join(__dirname, '..', '..'), '--server=' + world.base, '--user-data=' + userData, '--library=' + library, '--insecure-test-store'];
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');      // CI containers run as root
  const app = await _electron.launch({ args: args.concat(o.args || []), cwd: path.join(__dirname, '..', '..'), env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '0' }), timeout: 60000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  // closing never hangs a test run: a quit that waits for a person (an unsaved-
  // changes prompt) is ended after 15 s
  const close = app.close.bind(app);
  app.close = () => Promise.race([close(), new Promise(r => setTimeout(r, 15000)).then(() => { try { app.process().kill('SIGKILL'); } catch (e) { /* gone */ } })]);
  return { app, page, userData, library };
}

/* ── Things a person does in the app ───────────── */

async function signIn(page, user) {
  await page.waitForSelector('#access:not([hidden]) input[name=email]');
  await page.fill('input[name=email]', user.email);
  await page.fill('input[name=password]', user.password);
  await page.click('#access button[type=submit]');
}
/** The main process's access state, as the window sees it */
const accessState = page => page.evaluate(() => window.sheets.authState());
/** Waits until the access state is one of `statuses` */
async function waitForStatus(page, statuses, timeout = 20000) {
  const want = [].concat(statuses);
  const t0 = Date.now();
  for (;;) {
    const s = await accessState(page);
    if (want.includes(s.status)) return s;
    if (Date.now() - t0 > timeout) throw new Error('Status is ' + s.status + ' (' + (s.message || '') + '), not ' + want.join('/'));
    await page.waitForTimeout(150);
  }
}
async function newWorkbook(page) {
  await page.click('.start >> text=Blank workbook');
  await page.waitForSelector('#workbook:not([hidden]) .grid .scroller');
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('scroller'));
}
/** Types rows of entries from A1 (Tab between cells, Enter after each row) */
async function typeRows(page, rows) {
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) { await page.keyboard.type(String(row[i])); await page.keyboard.press(i === row.length - 1 ? 'Enter' : 'Tab'); }
  }
}
/** Value / formula / style of a cell in the open workbook ("B4") */
function cell(page, a1, sheetName) {
  return page.evaluate(([a, sn]) => {
    const app = window.__sheetsApp;
    const wb = app.current.wb;
    const s = sn ? wb.sheets.find(x => x.name === sn) : wb.activeSheet;
    const m = /^([A-Z]+)(\d+)$/.exec(a);
    let c = 0;
    for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
    const cl = s.get(Number(m[2]) - 1, c - 1);
    const v = cl ? cl.v : null;
    return { v: v && typeof v === 'object' && v.code ? v.code : v, f: cl && cl.f ? cl.f : null, style: wb.styles.get(cl ? cl.s : undefined) };
  }, [a1, sheetName || null]);
}
/** Selects a cell by typing its address in the name box */
async function goTo(page, a1) {
  await page.fill('.name-box', a1);
  await page.press('.name-box', 'Enter');
}
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

module.exports = { startWorld, launchApp, KEY, PROD, signIn, accessState, waitForStatus, newWorkbook, typeRows, cell, goTo, mod };
