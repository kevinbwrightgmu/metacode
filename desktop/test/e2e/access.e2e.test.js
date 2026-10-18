// End to end: who may use MetaCode Sheets. The real app (Electron) against
// the real MetaCode server, with Supabase and Stripe stand-ins:
//   Pro, Max and Ultra get in; Free and canceled plans see the upgrade screen;
//   a downgrade while the app is open locks it (unsaved work kept);
//   offline: a valid lease keeps the app usable, an edited one doesn't;
//   the window can't reach workbooks or AI while locked, whatever it calls.
// Run: npm run test:e2e (Linux needs a display: xvfb-run -a npm run test:e2e)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startWorld, launchApp, signIn, waitForStatus, accessState, newWorkbook, typeRows, cell } = require('./fixtures');

let world;
test.before(async () => { world = await startWorld(); });
test.after(async () => { if (world) await world.close(); });

/** Edits the lease kept by the (development) test store @param {string} userData @param {(payload: any) => any} change */
function editLease(userData, change) {
  const file = path.join(userData, 'session.bin');
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 6).toString('latin1'), 'MCSS1T', 'the development test store');
  const obj = JSON.parse(buf.subarray(6).toString('utf8'));
  const [body, sig] = obj.lease.token.split('.');
  const payload = change(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  obj.lease.token = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;
  fs.writeFileSync(file, Buffer.concat([Buffer.from('MCSS1T', 'latin1'), Buffer.from(JSON.stringify(obj), 'utf8')]));
}

for (const plan of ['pro', 'max', 'ultra']) {
  test(plan + ': signs in and can use the app', { timeout: 120000 }, async () => {
    const { app, page } = await launchApp(world);
    try {
      await signIn(page, world.users[plan]);
      const s = await waitForStatus(page, 'active');
      assert.equal(s.plan.id, plan);
      assert.ok(s.offlineUntil, 'a lease for offline use');
      await page.waitForSelector('#shell:not([hidden]) .home-head');
      assert.match(await page.textContent('.home-head .who'), new RegExp(plan, 'i'));
      assert.ok(Array.isArray(await page.evaluate(() => window.sheets.library())));
    } finally { await app.close(); }
  });
}

test('free and canceled plans see the upgrade screen, and the window can\'t open workbooks or use AI', { timeout: 120000 }, async () => {
  for (const who of ['free', 'expired']) {
    const { app, page } = await launchApp(world);
    try {
      await signIn(page, world.users[who]);
      const s = await waitForStatus(page, 'plan-required');
      assert.match(s.message, /Pro, Max and Ultra/);
      await page.waitForSelector('#access:not([hidden]) >> text=See plans and upgrade');
      assert.equal(await page.isHidden('#shell'), true);
      // even calling the bridge directly (as if the window were tampered with) is refused by the main process
      for (const call of ['library', 'createWorkbook', 'ai', 'projects']) {
        const r = await page.evaluate(async (c) => { try { await window.sheets[c]({ name: 'x', text: '{}', messages: [{ role: 'user', content: 'hi' }] }); return 'allowed'; } catch (e) { return e.code; } }, call);
        assert.equal(r, 'locked', call);
      }
      // and the server refuses the AI route for this account whatever the app does
      const token = world.sb.issue(world.users[who]).access_token;
      const ai = await fetch(world.base + '/api/desktop/ai', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
      assert.ok([402, 403].includes(ai.status), 'server: ' + ai.status);
    } finally { await app.close(); }
  }
});

test('a wrong password says so; nothing is unlocked', { timeout: 120000 }, async () => {
  const { app, page } = await launchApp(world);
  try {
    await signIn(page, { email: world.users.pro.email, password: 'not-the-password' });
    await page.waitForSelector('#access .error-text:has-text("don\'t match")');
    assert.equal((await accessState(page)).status, 'signed-out');
  } finally { await app.close(); }
});

test('a plan canceled while the app is open locks it on the next check; unsaved work goes to recovery', { timeout: 120000 }, async () => {
  const { app, page } = await launchApp(world);
  try {
    await signIn(page, world.users.revoked);
    await waitForStatus(page, 'active');
    await page.evaluate(() => window.sheets.setSettings({ autosave: false }));
    await page.evaluate(async () => window.__sheetsApp.applySettings(await window.sheets.getSettings()));
    await newWorkbook(page);
    await typeRows(page, [['kept', 42]]);
    await world.cancel('revoked');
    await page.evaluate(() => window.sheets.recheck());
    await waitForStatus(page, 'plan-required');
    await page.waitForSelector('#access:not([hidden]) >> text=See plans and upgrade');
    assert.equal(await page.isHidden('#shell'), true);
    const rec = await page.evaluate(() => window.sheets.listRecovery());
    assert.equal(rec.length, 1, 'the unsaved workbook was copied to the recovery folder');
    assert.equal(await page.evaluate(() => window.sheets.library().then(() => 'allowed', e => e.code)), 'locked');
  } finally { await app.close(); }
});

test('offline: a valid lease keeps the app open; an edited lease doesn\'t (pinned keys: test/main.test.js)', { timeout: 120000 }, async () => {
  const first = await launchApp(world);
  let userData = first.userData;
  try {
    await signIn(first.page, world.users.pro);
    await waitForStatus(first.page, 'active');
  } finally { await first.app.close(); }

  await world.serverDown();
  try {
    // the real lease: offline, still usable, with AI refused
    let l = await launchApp(world, { userData });
    try {
      const s = await waitForStatus(l.page, 'offline');
      assert.match(s.message, /offline until/);
      await l.page.waitForSelector('#shell:not([hidden]) .badge:has-text("Offline")');
      assert.ok(Array.isArray(await l.page.evaluate(() => window.sheets.library())), 'workbooks open offline');
      assert.equal(await l.page.evaluate(() => window.sheets.ai({ messages: [{ role: 'user', content: 'hi' }] }).then(() => 'ok', e => e.code)), 'offline');
    } finally { await l.app.close(); }

    // an extended lease (edited on disk) no longer matches its signature
    editLease(userData, p => Object.assign(p, { exp: p.exp + 365 * 86400, plan: 'ultra' }));
    l = await launchApp(world, { userData });
    try {
      const s = await waitForStatus(l.page, 'error');
      assert.match(s.message, /isn't valid/);
      await l.page.waitForSelector('#access:not([hidden]) >> text=Can\'t confirm your subscription');
      assert.equal(await l.page.evaluate(() => window.sheets.library().then(() => 'allowed', e => e.code)), 'locked');
    } finally { await l.app.close(); }
  } finally { await world.serverUp(); }

  // back online: the server confirms the plan again
  const l = await launchApp(world, { userData });
  try { await waitForStatus(l.page, 'active'); } finally { await l.app.close(); }
});

test('signing out locks the app and forgets the session', { timeout: 120000 }, async () => {
  const { app, page, userData } = await launchApp(world);
  try {
    await signIn(page, world.users.max);
    await waitForStatus(page, 'active');
    await page.click('.home-head button:has-text("Account")');
    await page.click('.menu-item:has-text("Sign out")');
    await waitForStatus(page, 'signed-out');
    await page.waitForSelector('#access:not([hidden]) input[name=email]');
  } finally { await app.close(); }
  const again = await launchApp(world, { userData });
  try { assert.equal((await waitForStatus(again.page, 'signed-out')).status, 'signed-out', 'not signed in at the next start'); }
  finally { await again.app.close(); }
});

test('the window is locked down: no Node.js, no network, no other origins', { timeout: 120000 }, async () => {
  const { app, page } = await launchApp(world);
  try {
    await page.waitForSelector('#access:not([hidden])');
    const probe = await page.evaluate(async () => {
      const out = {};
      out.require = typeof window.require;
      out.process = typeof window.process;
      out.bridge = Object.keys(window.sheets).includes('invoke') || Object.keys(window.sheets).includes('ipcRenderer');
      try { await fetch('http://127.0.0.1:1/'); out.fetch = 'allowed'; } catch (e) { out.fetch = 'blocked'; }
      try { const w = window.open('https://example.com'); out.open = w ? 'opened' : 'blocked'; } catch (e) { out.open = 'blocked'; }
      return out;
    });
    assert.deepEqual(probe, { require: 'undefined', process: 'undefined', bridge: false, fetch: 'blocked', open: 'blocked' });
    const prefs = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const p = w.webContents.getLastWebPreferences(); return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity }; });
    assert.deepEqual(prefs, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  } finally { await app.close(); }
});
