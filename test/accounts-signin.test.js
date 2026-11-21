// Signing in when something goes wrong, in a real browser: every refusal from
// Supabase Auth (which the browser console shows only as "400") is explained in
// the sign-in dialog with what to do next — a wrong password, an email that
// isn't confirmed yet (with "send the confirmation email again"), a sign-in
// link for an email without an account — and links from MetaCode's emails that
// can't sign you in (opened in another browser, already used, expired) open the
// sign-in dialog saying why, instead of silently showing "Sign in". Supabase is
// a local stand-in (test/helpers/account-mocks.js) that answers like the real
// Auth API (error codes, PKCE link exchange); it doesn't prove the live
// project's settings. Skipped when no Chromium is available.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testEnv } = require('./helpers/harness');
const { mockSupabase } = require('./helpers/account-mocks');

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
const KEY = 'sb_publishable_signin_0123456789abc';
let sb, server, baseUrl, browser, tmp;
const sbOpts = { apikey: KEY, confirmEmail: true };          // new accounts confirm their email, as on the live site

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-signin-'));
  sb = mockSupabase(sbOpts);
  await sb.start();
  sb.addUser('ready@example.org', 'correct horse 1');
  sb.addUser('pending@example.org', 'correct horse 2', { unconfirmed: true });
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY, STRIPE_SECRET_KEY: '',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    COLLAB_DATA_DIR: path.join(tmp, 'collab'), EMIS_API_KEY: '', PUBLIC_URL: '', DESKTOP_RELEASES_REPO: 'off'
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
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } });
  const page = await ctx.newPage();
  const errors = [], warnings = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  return { ctx, page, errors, warnings };
}
async function openSignIn(page) {
  await page.goto(baseUrl + '/app.html#dashboard');
  await page.click('#acct-slot .acct-signin');
  await page.waitForSelector('.acct-form [name=email]');
}
async function submit(page, email, password) {
  await page.fill('.acct-form [name=email]', email);
  if (password !== undefined) await page.fill('.acct-form [name=password]', password);
  await page.click('.acct-form .acct-primary');
}

test('a wrong password says so, suggests what to do, and names the reason in the console', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors, warnings } = await fresh();
  await openSignIn(page);
  await submit(page, 'ready@example.org', 'wrong password');
  await page.waitForSelector('.acct-err:not(:empty)');
  assert.match(await page.textContent('.acct-err'), /don't match an account\. Check them, or use “Forgot password\?”/);
  assert.ok(warnings.some(w => /Supabase Auth refused the request: invalid_credentials/.test(w)), 'the console says why, next to its "400"');
  await submit(page, 'ready@example.org', 'correct horse 1');
  await page.waitForSelector('#acct-slot .acct-plan-badge');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an email that isn\'t confirmed: the dialog offers to send the confirmation again; its link signs you in', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await fresh();
  await openSignIn(page);
  await submit(page, 'pending@example.org', 'correct horse 2');
  await page.waitForSelector('.acct-err:not(:empty)');
  assert.match(await page.textContent('.acct-err'), /Confirm your email first/);
  await page.click('button.acct-resend');
  await page.waitForSelector('p.acct-resend');
  assert.match(await page.textContent('p.acct-resend'), /Sent to pending@example\.org/);
  assert.deepEqual(sb.mails[sb.mails.length - 1], { type: 'signup', email: 'pending@example.org' });
  // The link in that email, opened in this browser
  await page.goto(baseUrl + '/app.html?code=' + sb.clickEmailLink('pending@example.org'));
  await page.waitForSelector('#acct-slot .acct-plan-badge');
  assert.ok(!page.url().includes('code='), 'the code is taken out of the address');
  assert.equal(await page.$('.acct-dialog'), null, 'no error dialog');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a confirmation link opened in another browser: that browser explains, and the password works there', { skip, timeout: 60000 }, async () => {
  // Create the account in one browser…
  const A = await fresh();
  await openSignIn(A.page);
  await A.page.click('.acct-tabs [data-mode="signup"]');
  await submit(A.page, 'newcomer@example.org', 'correct horse 3');
  await A.page.waitForSelector('.acct-ok');
  assert.match(await A.page.textContent('.acct-ok'), /Opened somewhere else, it still confirms your email/);
  // …and open the email's link in another (a phone's mail app, another browser)
  const code = sb.clickEmailLink('newcomer@example.org');
  const B = await fresh();
  await B.page.goto(baseUrl + '/app.html?code=' + code);
  await B.page.waitForSelector('.acct-dialog .acct-reason');
  assert.match(await B.page.textContent('.acct-reason'), /opened in a different browser or app.*your email is confirmed now: sign in below/s);
  assert.ok(!B.page.url().includes('code='));
  assert.ok(B.warnings.some(w => /opened in a different browser than the one that asked for it/.test(w)), 'the console says why');
  await submit(B.page, 'newcomer@example.org', 'correct horse 3');
  await B.page.waitForSelector('#acct-slot .acct-plan-badge');
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.ctx.close(); await B.ctx.close();
});

test('a link that was already used (Supabase answers 400) or expired opens the sign-in dialog saying so', { skip, timeout: 60000 }, async () => {
  const A = await fresh();
  await openSignIn(A.page);
  await A.page.click('.acct-tabs [data-mode="signup"]');
  await submit(A.page, 'twice@example.org', 'correct horse 4');
  await A.page.waitForSelector('.acct-ok');
  const used = A.page.waitForResponse(r => /grant_type=pkce/.test(r.url()));
  await A.page.goto(baseUrl + '/app.html?code=00000000-0000-4000-8000-000000000000');
  assert.equal((await used).status(), 400, 'the "Failed to load resource: 400" in the console');
  await A.page.waitForSelector('.acct-dialog .acct-reason');
  assert.match(await A.page.textContent('.acct-reason'), /already used or isn't valid any more/);
  assert.ok(A.warnings.some(w => /flow_state_not_found/.test(w)));

  // Supabase refused the link itself (it sends the browser back with ?error=…)
  const B = await fresh();
  await B.page.goto(baseUrl + '/app.html?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired#dashboard');
  await B.page.waitForSelector('.acct-dialog .acct-reason');
  assert.match(await B.page.textContent('.acct-reason'), /has expired or was already used\. Sign in below, or ask for a new link/);
  assert.ok(!/error=/.test(B.page.url()));
  assert.deepEqual([...A.errors, ...B.errors], []);
  await A.ctx.close(); await B.ctx.close();
});

test('a sign-in link for an email without an account says to create one', { skip, timeout: 60000 }, async () => {
  const { ctx, page, errors } = await fresh();
  await openSignIn(page);
  await page.fill('.acct-form [name=email]', 'nobody@example.org');
  await page.click('[data-act="link"]');
  await page.waitForSelector('.acct-err:not(:empty)');
  assert.match(await page.textContent('.acct-err'), /no MetaCode account for that email yet\. Create one first/);
  // An existing account gets its link
  await page.fill('.acct-form [name=email]', 'ready@example.org');
  await page.click('[data-act="link"]');
  await page.waitForSelector('.acct-ok');
  assert.deepEqual(sb.mails[sb.mails.length - 1], { type: 'magiclink', email: 'ready@example.org' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('creating an account with Supabase\'s built-in email sender, for an address outside the team, says what the operator must set up', { skip, timeout: 60000 }, async () => {
  sbOpts.emailTeam = ['owner@example.org'];
  const { ctx, page, errors, warnings } = await fresh();
  try {
    await openSignIn(page);
    await page.click('.acct-tabs [data-mode="signup"]');
    await submit(page, 'outsider@example.org', 'correct horse 5');
    await page.waitForSelector('.acct-err:not(:empty)');
    assert.match(await page.textContent('.acct-err'), /can't send email to that address yet.*custom SMTP/s);
    assert.ok(warnings.some(w => /email_address_not_authorized/.test(w)));
    assert.deepEqual(errors, []);
  } finally { delete sbOpts.emailTeam; await ctx.close(); }
});
