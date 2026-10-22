// Shared projects in real browsers (public/js/collab.js + /api/collab): the
// owner shares the open project and invites an editor and a viewer by link;
// they sign in and accept; edits reach the others live; an edit to the same
// post from two people at once is shown as a conflict and resolved without
// losing either version silently; chat; a viewer's edits aren't shared;
// removing someone ends their access. Sign-in uses a stand-in Supabase
// (test/helpers/account-mocks.js) — this proves MetaCode's pages and server,
// not a live Supabase project. Skipped when no Chromium is available.
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
const KEY = 'sb_publishable_collab_e2e_0123456789';
let sb, server, baseUrl, browser, tmp, mod;

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-collab-e2e-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  for (const n of ['owner', 'alice', 'bob', 'dana', 'erin']) sb.addUser(n + '@example.org', 'password-' + n);
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY, STRIPE_SECRET_KEY: '',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    COLLAB_DATA_DIR: path.join(tmp, 'collab'), EMIS_API_KEY: '', PUBLIC_URL: '', DESKTOP_RELEASES_REPO: 'off'
  }));
  mod = require('../server');
  server = await mod.start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (sb) await sb.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const noTours = () => { try { localStorage.setItem('metacode_tour_app', 'done'); localStorage.setItem('metacode_tour_studio', 'done'); } catch (e) { /* ignore */ } };
async function person() {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.addInitScript(noTours);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, r => r.abort());
  return { ctx, page, errors };
}
async function signIn(page, email, opener) {
  await page.waitForSelector(opener || '#acct-slot .acct-signin');
  await page.click(opener || '#acct-slot .acct-signin');
  await page.fill('.acct-form [name=email]', email);
  await page.fill('.acct-form [name=password]', 'password-' + email.split('@')[0]);
  await page.click('.acct-form .acct-primary');
  await page.waitForSelector('#acct-slot .acct-plan-badge');
}
const post = (page, id) => page.evaluate(i => JSON.parse(JSON.stringify(App.getState().posts.find(p => p.id === i) || null)), id);

test('two people on one project: share, invite, accept, live edits, a conflict, chat, a viewer, removal', { skip, timeout: 180000 }, async () => {
  /* The owner shares the open project */
  const O = await person();
  await O.page.goto(baseUrl + '/app.html#dashboard');
  await signIn(O.page, 'owner@example.org');
  await O.page.evaluate(() => {
    App.setState({ project: { name: 'Field study', description: 'Two coders' }, posts: [{ id: 'p1', text: 'First post', humanCodes: {} }, { id: 'p2', text: 'Second post', humanCodes: {} }],
      codebook: [{ id: 'tone', name: 'Tone', codes: [{ id: 'pos', label: 'Positive' }, { id: 'neg', label: 'Negative' }] }] });
    App.navigate('projects');
  });
  await O.page.click('#cl-share-btn');
  await O.page.waitForSelector('#cl-go');
  assert.match(await O.page.textContent('#modal-body'), /Editors.*can change the project/s);
  await O.page.click('#cl-go');
  await O.page.waitForSelector('#cl-emails');
  const id = await O.page.evaluate(() => Collab.link().id);
  assert.match(id, /^cp_/);
  assert.equal((await mod.collab.store.get(id)).data.posts.length, 2, 'the shared copy is on the server');
  await O.page.waitForTimeout(1600);
  assert.equal((await mod.collab.store.get(id)).revision, 1, 'the browser\'s copy matches the server\'s: nothing is re-sent');
  assert.equal(await O.page.evaluate(() => Collab.status().pending), 0);

  // Invite an editor and a viewer: a link for each
  const inviteLink = async (email, role) => {
    await O.page.fill('#cl-emails', email);
    await O.page.selectOption('#cl-role', role);
    await O.page.click('#cl-invite-go');
    await O.page.waitForFunction(e => [...document.querySelectorAll('#cl-results .cl-result b')].some(b => b.textContent === e), email);
    return O.page.$eval('#cl-results .cl-copy input', i => i.value);
  };
  const aliceLink = await inviteLink('alice@example.org', 'editor');
  const bobLink = await inviteLink('bob@example.org', 'viewer');
  assert.match(aliceLink, /^http:\/\/localhost:\d+\/app\.html#invite\/[A-Za-z0-9_-]+$/);
  assert.equal(await O.page.$$eval('.cl-invites tbody tr', r => r.length), 2, 'two open invitations');
  await O.page.click('#modal-foot .btn-primary');
  await O.page.waitForSelector('#cl-slot .cl-live');

  /* alice opens her link signed out, signs in from it and accepts */
  const A = await person();
  await A.page.goto(aliceLink);
  await A.page.waitForSelector('.cl-invite-card');
  assert.match(await A.page.textContent('.cl-invite-card'), /owner@example\.org invited you to “Field study” as an editor/);
  assert.match(await A.page.textContent('.cl-invite-card'), /For a•••@example\.org/);
  await signIn(A.page, 'alice@example.org', '#cl-inv-signin');
  await A.page.waitForSelector('#cl-inv-accept');
  await A.page.click('#cl-inv-accept');
  await A.page.waitForSelector('#cl-slot .cl-live', { timeout: 15000 });
  assert.equal(await A.page.textContent('#topbar-project'), 'Field study');
  assert.equal(await A.page.evaluate(() => App.getState().posts.length), 2);
  assert.equal(await A.page.$('#cl-slot .cl-badge'), null, 'an editor isn\'t view-only');

  // Presence: the owner sees alice
  await O.page.waitForFunction(() => /alice@example\.org/.test(document.querySelector('#cl-slot .cl-avatars').title));
  assert.equal(await O.page.textContent('#cl-slot .cl-avatar'), 'A');

  /* alice codes p1: the owner gets it without reloading */
  await A.page.evaluate(() => { App.getState().posts.find(p => p.id === 'p1').humanCodes = { tone: 'pos' }; App.save(); });
  await O.page.waitForFunction(() => (App.getState().posts.find(p => p.id === 'p1').humanCodes || {}).tone === 'pos', null, { timeout: 10000 });
  await O.page.click('.nav-item[data-view="dashboard"]');

  /* Both change p2 at once: the owner's change can't be sent yet; alice's is */
  await O.page.route('**/api/collab/projects/*/changes', r => r.abort());
  await O.page.evaluate(() => { App.getState().posts.find(p => p.id === 'p2').humanCodes = { tone: 'neg' }; App.save(); });
  await O.page.waitForTimeout(1500);
  await A.page.evaluate(() => { App.getState().posts.find(p => p.id === 'p2').humanCodes = { tone: 'pos' }; App.save(); });
  // The owner is asked which version to keep — nothing was overwritten
  await O.page.waitForSelector('#cl-conflicts [data-key="post:p2"]', { timeout: 10000 });
  assert.match(await O.page.textContent('#cl-conflicts'), /Post p2 — “Second post”/);
  assert.deepEqual((await post(O.page, 'p2')).humanCodes, { tone: 'neg' }, 'the owner\'s own coding is still there');
  assert.deepEqual((await mod.collab.store.get(id)).data.posts.find(p => p.id === 'p2').humanCodes, { tone: 'pos' }, 'alice\'s is on the server');
  assert.match(await O.page.textContent('#cl-slot'), /1 to resolve/);
  await O.page.unroute('**/api/collab/projects/*/changes');
  await O.page.click('#cl-conflicts [data-key="post:p2"] [data-pick="mine"]');
  // Keeping mine sends it from alice's version: it reaches alice
  await A.page.waitForFunction(() => App.getState().posts.find(p => p.id === 'p2').humanCodes.tone === 'neg', null, { timeout: 10000 });
  assert.deepEqual((await mod.collab.store.get(id)).data.posts.find(p => p.id === 'p2').humanCodes, { tone: 'neg' });
  assert.equal(await O.page.$('#cl-slot .cl-warn'), null, 'nothing left to resolve');

  /* Chat: stored as text, delivered live, unread count for the other person */
  await A.page.click('#cl-chat-btn');
  await A.page.fill('#cl-chat-input', '<b>p1 done</b>, p2 is yours');
  await A.page.press('#cl-chat-input', 'Enter');
  await A.page.waitForFunction(() => [...document.querySelectorAll('#cl-chat-log .cl-msg:not(.cl-pending) .cl-msg-text')].some(n => n.textContent.includes('p1 done')));
  await O.page.waitForSelector('#cl-chat-btn .cl-unread');
  assert.equal(await O.page.textContent('#cl-chat-btn .cl-unread'), '1');
  await O.page.click('#cl-chat-btn');
  await O.page.waitForSelector('#cl-chat-log .cl-msg-text');
  assert.equal(await O.page.textContent('#cl-chat-log .cl-msg-text'), '<b>p1 done</b>, p2 is yours');
  assert.equal(await O.page.$('#cl-chat-log .cl-msg-text b'), null, 'never rendered as HTML');
  assert.equal(await O.page.$('#cl-chat-btn .cl-unread'), null, 'read');
  await O.page.click('#cl-chat-close');

  /* bob (viewer) reads but his edits aren't shared */
  const B = await person();
  await B.page.goto(bobLink);
  await signIn(B.page, 'bob@example.org', '#cl-inv-signin');
  await B.page.click('#cl-inv-accept');
  await B.page.waitForSelector('#cl-slot .cl-live', { timeout: 15000 });
  assert.equal(await B.page.textContent('#cl-slot .cl-badge'), 'View only');
  assert.deepEqual((await post(B.page, 'p2')).humanCodes, { tone: 'neg' });
  const before = (await mod.collab.store.get(id)).revision;
  await B.page.evaluate(() => { App.getState().posts.find(p => p.id === 'p1').humanCodes = { tone: 'neg' }; App.save(); });
  await B.page.waitForTimeout(2000);
  assert.equal((await mod.collab.store.get(id)).revision, before, 'nothing was sent');
  assert.deepEqual((await post(O.page, 'p1')).humanCodes, { tone: 'pos' });

  /* The owner removes alice: her access ends at once; her open copy stays */
  await O.page.click('#cl-share-btn');
  await O.page.waitForSelector('.cl-members');
  O.page.once('dialog', d => d.accept());
  await O.page.click('.cl-members tr:has-text("alice@example.org") [data-act="remove"]');
  await A.page.waitForSelector('text=You no longer have access', { timeout: 10000 });
  assert.equal(await A.page.evaluate(() => Collab.active()), false);
  assert.equal(await A.page.evaluate(() => App.getState().posts.length), 2, 'the copy in her browser stays');
  await O.page.waitForFunction(() => !/alice/.test(document.querySelector('.cl-members').textContent));

  // Nothing went wrong in any page
  assert.deepEqual([...O.errors, ...A.errors, ...B.errors], []);
  for (const p of [O, A, B]) await p.ctx.close();
});

test('every post is shared (repeated ids get new ones), earlier invitation links stay in the dialog, and an invitation opened before signing in comes back', { skip, timeout: 120000 }, async () => {
  const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timed out: ' + what); };
  const texts = list => list.map(p => p.text).sort();
  const D = await person();
  await D.page.goto(baseUrl + '/app.html#dashboard');
  await signIn(D.page, 'dana@example.org');
  // A comments export whose id column repeats
  await D.page.evaluate(() => {
    App.setState({ project: { name: 'Comments', description: '' }, codebook: [],
      posts: [{ id: 't3_a', text: 'first comment' }, { id: 't3_a', text: 'second comment' }, { id: 't3_a', text: 'third comment' }, { id: 't3_b', text: 'another' }] });
  });
  await D.page.click('#cl-share-btn');
  await D.page.click('#cl-go');
  await D.page.waitForSelector('#cl-emails');
  const id = await D.page.evaluate(() => Collab.link().id);
  const local = await D.page.evaluate(() => App.getState().posts.map(p => ({ id: p.id, text: p.text })));
  assert.deepEqual(texts(local), ['another', 'first comment', 'second comment', 'third comment'], 'no post left the open project');
  assert.equal(new Set(local.map(p => p.id)).size, 4, 'each post has its own id');
  assert.equal(local.find(p => p.text === 'first comment').id, 't3_a', 'the first keeps its id');
  assert.deepEqual(texts((await mod.collab.store.get(id)).data.posts), texts(local), 'and every one is shared');
  // Posts added later with a repeated id are shared too
  await D.page.evaluate(() => App.setState({ posts: App.getState().posts.concat([{ id: 'x1', text: 'late one' }, { id: 'x1', text: 'late two' }]) }));
  await until(async () => (await mod.collab.store.get(id)).data.posts.length === 6, 'six posts on the server');
  assert.equal(await D.page.evaluate(() => new Set(App.getState().posts.map(p => p.id)).size), 6);

  /* Invitation links: each stays until it's replaced or revoked */
  const rows = () => D.page.$$eval('#cl-results .cl-result', l => l.map(r => ({ email: r.dataset.email, link: r.querySelector('input') ? r.querySelector('input').value : null, text: r.textContent })));
  async function invite(email, role) {
    const old = ((await rows()).find(r => r.email === email) || {}).link || null;
    await D.page.fill('#cl-emails', email);
    await D.page.selectOption('#cl-role', role);
    await D.page.click('#cl-invite-go');
    await D.page.waitForFunction(([e, o]) => [...document.querySelectorAll('#cl-results .cl-result')].some(r => r.dataset.email === e && r.querySelector('input') && r.querySelector('input').value !== o), [email, old]);
    return rows();
  }
  await invite('erin@example.org', 'editor');
  let r = await invite('frank@example.org', 'viewer');
  assert.deepEqual(r.map(x => x.email), ['frank@example.org', 'erin@example.org'], 'the first link is still there (newest first)');
  const erinOld = r[1].link;
  r = await invite('erin@example.org', 'editor');
  assert.deepEqual(r.map(x => x.email), ['erin@example.org', 'frank@example.org'], 'a renewed invitation replaces its old link');
  assert.notEqual(r[0].link, erinOld);
  assert.match(r[0].text, /a new link; the old one stops working/);
  const erinLink = r[0].link;
  await D.page.click('.cl-invites tr:has-text("frank@example.org") [data-act="revoke"]');
  await D.page.waitForFunction(() => !document.querySelector('.cl-invites') || !/frank/.test(document.querySelector('.cl-invites').textContent));
  assert.deepEqual((await rows()).map(x => x.email), ['erin@example.org'], 'a revoked invitation\'s link goes');
  await D.page.click('#modal-foot .btn-primary');

  /* erin opens her link signed out; the link that confirms a new account (or an emailed
     sign-in link) opens the app, not the invitation: once signed in she's back on it */
  const E = await person();
  await E.page.goto(erinLink);
  await E.page.waitForSelector('#cl-inv-signin');
  await E.page.goto(baseUrl + '/app.html#dashboard');
  await E.page.reload();
  await signIn(E.page, 'erin@example.org');
  await E.page.waitForSelector('#cl-inv-accept', { timeout: 10000 });
  assert.match(E.page.url(), /#invite\//);
  await E.page.click('#cl-inv-accept');
  await E.page.waitForSelector('#cl-slot .cl-live', { timeout: 15000 });
  assert.deepEqual(texts(await E.page.evaluate(() => App.getState().posts)), texts((await mod.collab.store.get(id)).data.posts));
  assert.equal(await E.page.evaluate(() => localStorage.getItem('metacode_pending_invite_v1')), null, 'forgotten once used');

  assert.deepEqual([...D.errors, ...E.errors], []);
  for (const p of [D, E]) await p.ctx.close();
});
