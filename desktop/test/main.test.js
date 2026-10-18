// The app's main process without Electron: leases (with the server's own
// signing code), configuration, the encrypted store, signing in (password,
// PKCE email link, refresh), the subscription check and its offline rules
// (Pro/Max/Ultra, Free, expired, revoked, tampered, clock turned back),
// files (atomic saves, conflicts, backups, access, recovery), the app://
// protocol's path checks and the IPC gate.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const serverLease = require('../../desktop-api/lease.js');
const { verifyLease, keyId } = require('../src/main/lease');
const { loadAppConfig, cleanServerUrl } = require('../src/main/config');
const { createHttp, NetError } = require('../src/main/http');
const { createSecureStore } = require('../src/main/secure-store');
const { createAuth } = require('../src/main/auth');
const { createEntitlement, compareVersions } = require('../src/main/entitlement');
const { createFiles } = require('../src/main/files');
const { fileFor, CSP } = require('../src/main/protocol');
const { registerIpc, errorOut } = require('../src/main/ipc');
const { menuTemplate } = require('../src/main/menu');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsheets-main-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let dirN = 0;
const freshDir = () => { const d = path.join(tmp, 'd' + (++dirN)); fs.mkdirSync(d, { recursive: true }); return d; };

const SERVER = 'https://metacode.test';
const SUPA = 'https://supa.test';
const newKey = () => serverLease.loadLeaseKey({ env: { DESKTOP_LEASE_PRIVATE_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) }, dataDir: freshDir() });

/** A fetch that answers from a function: (url, init) → { status, json } | 'offline' */
function fakeFetch(fn) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = await fn(url, init);
    if (r === 'offline') throw new TypeError('fetch failed');
    const text = r.json === undefined ? (r.text || '') : JSON.stringify(r.json);
    return { status: r.status || 200, ok: (r.status || 200) < 400, headers: new Map(), text: async () => text };
  };
  f.calls = calls;
  return f;
}
const fakeSafeStorage = (available = true, backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: s => Buffer.from(Buffer.from(s, 'utf8').map(b => b ^ 0x5A)),
  decryptString: b => Buffer.from(b.map(x => x ^ 0x5A)).toString('utf8')
});

/* ── Leases ──────────────────────────────────────── */

test('leases signed by the server verify in the app; any change, another key or a non-Ed25519 key fails', () => {
  const key = newKey();
  const { token, payload } = serverLease.signLease(key, { sub: 'u1', email: 'a@b.c', plan: 'pro', server: SERVER, ttlMs: 3600e3 });
  const ok = verifyLease(token, key.publicKeyB64);
  assert.equal(ok.sub, 'u1');
  assert.equal(ok.plan, 'pro');
  assert.equal(keyId(key.publicKeyB64), key.kid);
  // edit the payload (later expiry, better plan): the signature no longer matches
  const [body, sig] = token.split('.');
  for (const change of [{ exp: payload.exp + 86400 * 365 }, { plan: 'ultra' }, { sub: 'someone-else' }]) {
    const forged = Buffer.from(JSON.stringify(Object.assign({}, payload, change))).toString('base64url') + '.' + sig;
    assert.equal(verifyLease(forged, key.publicKeyB64), null, JSON.stringify(change));
  }
  assert.equal(verifyLease(body + '.' + Buffer.from('x'.repeat(64)).toString('base64url'), key.publicKeyB64), null);
  assert.equal(verifyLease(token, newKey().publicKeyB64), null, 'another server\'s key');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(verifyLease(token, rsa), null);
  assert.equal(verifyLease('garbage', key.publicKeyB64), null);
  assert.equal(verifyLease(token, ''), null);
});

/* ── Configuration ───────────────────────────────── */

test('config: packaged apps keep their server unless the build allows overrides; only https (or localhost http)', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ serverUrl: 'https://metac0.de', leasePublicKeys: ['A'.repeat(60)] }));
  const env = { METACODE_SHEETS_SERVER: 'http://localhost:3999' };
  assert.deepEqual(loadAppConfig({ appRoot: dir, env, isPackaged: true }), { serverUrl: 'https://metac0.de', leasePublicKeys: ['A'.repeat(60)], pinned: true, source: 'app-config.json' });
  const devCfg = loadAppConfig({ appRoot: dir, env, isPackaged: false });
  assert.equal(devCfg.serverUrl, 'http://localhost:3999');
  assert.equal(devCfg.pinned, false, 'pinned keys are for the configured server only');
  assert.equal(loadAppConfig({ appRoot: dir, env: {}, argv: ['--server=https://other.example/path'], isPackaged: false }).serverUrl, 'https://other.example');
  fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ serverUrl: 'https://metac0.de', allowServerOverride: true }));
  assert.equal(loadAppConfig({ appRoot: dir, env, isPackaged: true }).serverUrl, 'http://localhost:3999');
  assert.equal(cleanServerUrl('http://evil.example'), null, 'plain http only for this computer');
  assert.equal(cleanServerUrl('https://user:pw@x.example'), null);
  assert.equal(cleanServerUrl('javascript:alert(1)'), null);
  assert.equal(loadAppConfig({ appRoot: freshDir(), env: {}, isPackaged: true }).serverUrl, 'https://metac0.de', 'missing file → default');
});

/* ── The encrypted store ─────────────────────────── */

test('secure store: encrypted with the system, nothing written without real encryption, damaged files dropped', () => {
  const dir = freshDir();
  const file = path.join(dir, 'session.bin');
  const s1 = createSecureStore({ file, safeStorage: fakeSafeStorage(), platform: 'linux' });
  assert.equal(s1.kind(), 'os');
  s1.update({ session: { refreshToken: 'rt-secret' }, lastSeen: 5 });
  assert.ok(!fs.readFileSync(file).toString('utf8').includes('rt-secret'), 'not in plain text');
  assert.deepEqual(createSecureStore({ file, safeStorage: fakeSafeStorage(), platform: 'linux' }).get(), { session: { refreshToken: 'rt-secret' }, lastSeen: 5 });
  // Linux without a keyring ("basic_text") or no encryption at all: nothing is kept
  for (const ss of [fakeSafeStorage(true, 'basic_text'), fakeSafeStorage(false)]) {
    const f2 = path.join(freshDir(), 'session.bin');
    const s = createSecureStore({ file: f2, safeStorage: ss, platform: 'linux' });
    assert.equal(s.kind(), null);
    assert.equal(s.update({ x: 1 }), false);
    assert.equal(fs.existsSync(f2), false);
  }
  // a damaged or edited file is dropped, not trusted
  fs.writeFileSync(file, Buffer.concat([Buffer.from('MCSS1E'), Buffer.from('not encrypted json')]));
  assert.deepEqual(createSecureStore({ file, safeStorage: fakeSafeStorage(), platform: 'linux' }).get(), {});
  assert.equal(fs.existsSync(file), false);
  // the development test store isn't read by a normal (encrypted) store
  const s3 = createSecureStore({ file, safeStorage: fakeSafeStorage(false), platform: 'linux', insecureTestStore: true });
  s3.update({ lease: { token: 'x' } });
  assert.deepEqual(createSecureStore({ file, safeStorage: fakeSafeStorage(), platform: 'linux' }).get(), {});
});

/* ── Signing in ──────────────────────────────────── */

function authFixture(o = {}) {
  let n = 0;
  const state = { refreshOk: true, offline: false, issued: [] };
  const fetch = fakeFetch(async (url, init) => {
    if (state.offline) return 'offline';
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.startsWith(SUPA + '/auth/v1/token?grant_type=password')) {
      if (body.password !== 'right') return { status: 400, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
      const rt = 'rt' + (++n); state.issued.push(rt);
      return { json: { access_token: 'at' + n, refresh_token: rt, expires_in: o.expiresIn || 3600, user: { id: 'u1', email: body.email } } };
    }
    if (url.startsWith(SUPA + '/auth/v1/token?grant_type=refresh_token')) {
      if (!state.refreshOk || !state.issued.includes(body.refresh_token)) return { status: 400, json: { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } };
      const rt = 'rt' + (++n); state.issued = [rt];                                 // rotation: the old one stops working
      return { json: { access_token: 'at' + n, refresh_token: rt, expires_in: 3600, user: { id: 'u1', email: 'a@b.c' } } };
    }
    if (url.startsWith(SUPA + '/auth/v1/otp')) return { json: {} };
    if (url.startsWith(SUPA + '/auth/v1/token?grant_type=pkce')) {
      state.pkce = body;
      return { json: { access_token: 'atp', refresh_token: 'rtp', expires_in: 3600, user: { id: 'u2', email: 'link@b.c' } } };
    }
    if (url.startsWith(SUPA + '/auth/v1/logout')) { state.loggedOut = init.headers.Authorization; return { status: 204, text: '' }; }
    return { status: 404, json: {} };
  });
  const store = createSecureStore({ file: path.join(freshDir(), 's.bin'), safeStorage: fakeSafeStorage(), platform: 'linux' });
  let clock = 1_000_000;
  const http = createHttp({ fetch });
  const auth = createAuth({ http, store, server: SERVER, accounts: async () => ({ supabaseUrl: SUPA, publishableKey: 'sb_publishable_x' }), now: () => clock });
  return { auth, store, fetch, state, http, tick: ms => { clock += ms; }, now: () => clock };
}

test('auth: password sign-in, refresh with rotation, revoked sessions sign out, offline keeps the session', async () => {
  const { auth, store, state, fetch, tick, http } = authFixture();
  await assert.rejects(auth.signInWithPassword('a@b.c', 'wrong'), /don't match a MetaCode account/);
  await assert.rejects(auth.signInWithPassword('not-an-email', 'x'), /valid email/);
  const r = await auth.signInWithPassword('a@b.c', 'right');
  assert.deepEqual(r.user, { id: 'u1', email: 'a@b.c' });
  assert.equal(r.persisted, true);
  assert.equal(store.get().session.refreshToken, 'rt1');
  assert.equal(fetch.calls[1].init.headers.apikey, 'sb_publishable_x');
  assert.equal(await auth.accessToken(), 'at1', 'still fresh: no refresh');
  tick(3600e3);
  assert.equal(await auth.accessToken(), 'at2', 'refreshed when expiring');
  assert.equal(store.get().session.refreshToken, 'rt2', 'the rotated refresh token is kept');
  // a later launch picks the session up from the store
  const again = createAuth({ http, store, server: SERVER, accounts: async () => ({ supabaseUrl: SUPA, publishableKey: 'k' }) });
  assert.equal(again.signedIn(), true);
  assert.equal(again.user().id, 'u1');
  const otherServer = createAuth({ http, store, server: 'https://elsewhere.test', accounts: async () => null });
  assert.equal(otherServer.signedIn(), false, 'a session belongs to its server');
  // offline: the refresh can't happen, the session stays
  tick(3600e3);
  state.offline = true;
  await assert.rejects(auth.accessToken(), NetError);
  assert.equal(auth.signedIn(), true);
  // revoked (e.g. password changed elsewhere): signed out, store cleared
  state.offline = false; state.refreshOk = false;
  assert.equal(await auth.accessToken(), null);
  assert.equal(auth.signedIn(), false);
  assert.equal(store.get().session, undefined);
});

test('auth: the email link uses PKCE — only this app\'s own request can complete it', async () => {
  const { auth, state, fetch } = authFixture();
  await assert.rejects(auth.completeEmailLink('metacode-sheets://auth-callback?code=abcdefgh123'), /didn't ask for that link/);
  await auth.sendEmailLink('link@b.c');
  const otp = fetch.calls.find(c => c.url.includes('/auth/v1/otp'));
  assert.match(otp.url, /redirect_to=metacode-sheets%3A%2F%2Fauth-callback/);
  assert.equal(otp.body.create_user, false);
  assert.equal(otp.body.code_challenge_method, 's256');
  await assert.rejects(auth.completeEmailLink('https://evil.example/auth-callback?code=abcdefgh'), /isn't a MetaCode sign-in link/);
  await assert.rejects(auth.completeEmailLink('metacode-sheets://auth-callback?error=access_denied&error_description=Email+link+is+invalid'), /Email link is invalid/);
  await auth.sendEmailLink('link@b.c');
  const challenge = fetch.calls.filter(c => c.url.includes('/auth/v1/otp')).pop().body.code_challenge;
  const r = await auth.completeEmailLink('metacode-sheets://auth-callback?code=abcdefgh123');
  assert.equal(r.user.id, 'u2');
  assert.equal(crypto.createHash('sha256').update(state.pkce.code_verifier).digest('base64url'), challenge, 'the verifier matches the challenge sent with the request');
  await assert.rejects(auth.completeEmailLink('metacode-sheets://auth-callback?code=abcdefgh123'), /didn't ask/, 'a link works once');
  await auth.signOut();
  assert.equal(state.loggedOut, 'Bearer atp');
  assert.equal(auth.signedIn(), false);
});

/* ── The subscription check ──────────────────────── */

function entitlementFixture(o = {}) {
  const key = o.key || newKey();
  const signer = o.signer || key;
  const s = { plan: o.plan || 'pro', down: false, status503: false, unauthorized: 0, available: true, minVersion: null, ttlMs: 72 * 3600e3, now: Date.parse('2026-10-18T12:00:00Z') };
  const fx = authFixture();
  const serverFetch = fakeFetch(async (url, init) => {
    if (url.startsWith(SUPA)) return fx.fetch(url, init).then(async r => ({ status: r.status, json: JSON.parse((await r.text()) || '{}') })).catch(() => 'offline');
    if (s.down) return 'offline';
    if (url === SERVER + '/api/desktop/config') return { json: { app: 'metacode-sheets', available: s.available, reason: s.available ? null : 'The desktop app is turned off on this MetaCode server.', accounts: { enabled: true, supabaseUrl: SUPA, publishableKey: 'k' }, lease: { alg: 'Ed25519', kid: key.kid, publicKey: key.publicKeyB64 }, minVersion: s.minVersion, upgradeUrl: SERVER + '/app.html#account' } };
    if (url === SERVER + '/api/desktop/entitlement') {
      if (s.status503) return { status: 503, json: { error: { type: 'account_unavailable', message: 'MetaCode couldn\'t check your subscription with Stripe just now.' } } };
      if (s.unauthorized > 0) { s.unauthorized--; return { status: 401, json: { error: { type: 'auth_required', message: 'Sign in' } } }; }
      if (!s.available) return { status: 403, json: { error: { type: 'desktop_unavailable', message: 'The desktop app is turned off on this MetaCode server.' } } };
      if (!/^Bearer at/.test(init.headers.Authorization || '')) return { status: 401, json: {} };
      if (['free', 'canceled'].includes(s.plan)) return { json: { entitled: false, reason: 'plan_required', user: { id: 'u1', email: 'a@b.c' }, plan: { id: 'free', name: 'Free' }, plansWithDesktop: ['Pro', 'Max', 'Ultra'], upgradeUrl: SERVER + '/app.html#account' } };
      const lease = serverLease.signLease(signer, { sub: o.leaseSub || 'u1', email: 'a@b.c', plan: s.plan, server: SERVER, ttlMs: s.ttlMs, now: s.now });
      return { json: { entitled: true, user: { id: 'u1', email: 'a@b.c' }, plan: { id: s.plan, name: s.plan[0].toUpperCase() + s.plan.slice(1) }, lease: { token: lease.token, expiresAt: new Date(Number(lease.payload.exp) * 1000).toISOString() } } };
    }
    return { status: 404, json: {} };
  });
  const http = createHttp({ fetch: serverFetch });
  const store = createSecureStore({ file: path.join(freshDir(), 's.bin'), safeStorage: fakeSafeStorage(), platform: 'linux' });
  const auth = createAuth({ http, store, server: SERVER, accounts: async () => ({ supabaseUrl: SUPA, publishableKey: 'k' }), now: () => s.now });
  const changes = [];
  const make = () => createEntitlement({ http, auth, store, server: SERVER, pinnedKeys: o.pinned || [], appVersion: '1.0.0', now: () => s.now, onChange: st => changes.push(st.status), timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  const ent = make();
  return { ent, make, s, auth, store, changes, key, fx };
}

test('entitlement: Pro, Max and Ultra unlock with a lease; Free is shown the upgrade; a later downgrade locks', async () => {
  for (const plan of ['pro', 'max', 'ultra']) {
    const { ent, auth, store } = entitlementFixture({ plan });
    assert.equal((await ent.check('launch')).status, 'signed-out');
    await auth.signInWithPassword('a@b.c', 'right');
    const st = await ent.check('sign-in');
    assert.equal(st.status, 'active', plan);
    assert.equal(st.plan.id, plan);
    assert.ok(st.offlineUntil);
    assert.ok(store.get().lease.token);
    assert.equal(ent.unlocked(), true);
    assert.equal(ent.online(), true);
  }
  const { ent, auth, s, store, changes } = entitlementFixture({ plan: 'free' });
  await auth.signInWithPassword('a@b.c', 'right');
  const free = await ent.check('sign-in');
  assert.equal(free.status, 'plan-required');
  assert.match(free.message, /Pro, Max and Ultra plans/);
  assert.equal(free.upgradeUrl, SERVER + '/app.html#account');
  assert.equal(ent.unlocked(), false);
  assert.equal(store.get().lease, undefined);
  // upgrades → unlocks; cancels → locks again on the next check, and the lease is gone
  s.plan = 'pro';
  assert.equal((await ent.check('manual')).status, 'active');
  s.plan = 'canceled';
  assert.equal((await ent.check('timer')).status, 'plan-required');
  assert.equal(store.get().lease, undefined, 'no offline access after a downgrade');
  s.down = true;
  assert.equal((await ent.check('timer')).status, 'error', 'offline after a downgrade stays locked');
  assert.deepEqual(changes.filter((c, i) => c !== changes[i - 1]), ['plan-required', 'active', 'plan-required', 'error']);
});

test('entitlement: offline on a valid lease; expired, tampered, another account\'s or clock-rollback leases don\'t unlock', async () => {
  const { ent, make, auth, s, store } = entitlementFixture({ plan: 'max' });
  await auth.signInWithPassword('a@b.c', 'right');
  await ent.check('sign-in');
  const good = store.get().lease;
  // offline (no network, or Stripe unreachable → 503): the lease keeps it open
  s.down = true;
  s.now += 3600e3;
  const off = await make().check('launch');
  assert.equal(off.status, 'offline');
  assert.match(off.message, /keep working offline until/);
  s.down = false; s.status503 = true;
  assert.equal((await make().check('launch')).status, 'offline');
  s.status503 = false; s.down = true;
  // the lease runs out
  s.now += 72 * 3600e3;
  const expired = await make().check('launch');
  assert.equal(expired.status, 'error');
  assert.match(expired.message, /offline access has run out/);
  s.now -= 72 * 3600e3;
  // edited lease: a later expiry or better plan breaks the signature
  const [body, sig] = good.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  store.update({ lease: { token: Buffer.from(JSON.stringify(Object.assign({}, payload, { exp: payload.exp + 365 * 86400 }))).toString('base64url') + '.' + sig } });
  assert.equal((await make().check('launch')).status, 'error');
  // a self-made lease signed with a key the app doesn't trust
  const attacker = newKey();
  const fake = serverLease.signLease(attacker, { sub: 'u1', plan: 'ultra', server: SERVER, ttlMs: 365 * 86400e3, now: s.now });
  store.update({ lease: { token: fake.token } });
  assert.equal((await make().check('launch')).status, 'error');
  // the clock turned back past the last time the app saw
  store.update({ lease: good, leaseKey: undefined });
  s.down = false;
  await make().check('online again');                       // re-learns the key and lastSeen
  s.down = true;
  const lastSeen = store.get().lastSeen;
  s.now = lastSeen - 24 * 3600e3;
  const rolled = await make().check('launch');
  assert.equal(rolled.status, 'error');
  assert.match(rolled.message, /clock/);
  s.now = lastSeen + 1000;
  assert.equal((await make().check('launch')).status, 'offline');
  // signed out → the lease no longer applies
  await auth.signOut();
  assert.equal((await make().check('launch')).status, 'signed-out');
});

test('entitlement: pinned keys — a lease from any other key never unlocks offline', async () => {
  const real = newKey();
  const attacker = newKey();
  // the server (or a fake one) signs with the attacker's key while the app pins the real one
  const { ent, make, auth, s, store } = entitlementFixture({ key: attacker, signer: attacker, pinned: [real.publicKeyB64] });
  await auth.signInWithPassword('a@b.c', 'right');
  const st = await ent.check('sign-in');
  assert.equal(st.status, 'active', 'the online answer comes from the configured server over HTTPS');
  assert.equal(store.get().lease, undefined, 'but a lease the pinned key can\'t verify isn\'t kept');
  assert.match(st.message, /Offline access isn't available/);
  s.down = true;
  assert.equal((await make().check('launch')).status, 'error');
  // with the right key pinned, the same flow keeps the lease
  const ok = entitlementFixture({ key: real, signer: real, pinned: [real.publicKeyB64] });
  await ok.auth.signInWithPassword('a@b.c', 'right');
  await ok.ent.check('sign-in');
  ok.s.down = true;
  assert.equal((await ok.make().check('launch')).status, 'offline');
});

test('entitlement: expired tokens refresh once; revoked sessions, servers without desktop access and old versions', async () => {
  const a = entitlementFixture();
  await a.auth.signInWithPassword('a@b.c', 'right');
  a.s.unauthorized = 1;
  assert.equal((await a.ent.check('x')).status, 'active', 'a 401 → one refresh → success');
  a.s.unauthorized = 5;
  const out = await a.ent.check('x');
  assert.equal(out.status, 'signed-out');
  assert.match(out.message, /session ended/);
  assert.equal(a.store.get().lease, undefined);

  const b = entitlementFixture();
  await b.auth.signInWithPassword('a@b.c', 'right');
  b.s.available = false;
  const un = await b.ent.check('x');
  assert.equal(un.status, 'unavailable');
  assert.match(un.message, /turned off/);

  const c = entitlementFixture();
  await c.auth.signInWithPassword('a@b.c', 'right');
  c.s.minVersion = '2.0.0';
  assert.equal((await c.ent.check('x')).status, 'update-required');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);

  // a lease for another account (e.g. a copied store file) doesn't unlock
  const d = entitlementFixture({ leaseSub: 'someone-else' });
  await d.auth.signInWithPassword('a@b.c', 'right');
  await d.ent.check('x');
  assert.equal(d.store.get().lease, undefined);
});

/* ── Files ───────────────────────────────────────── */

test('files: atomic saves with backups, conflicts when changed/moved, access limited to granted and library files', async () => {
  const lib = freshDir(), userData = freshDir();
  let t = 1000;
  const trashed = [];
  const files = createFiles({ libraryDir: lib, userData, trash: async p => { trashed.push(p); fs.unlinkSync(p); }, now: () => t++ });
  const made = await files.createInLibrary('Budget', '{"v":1}');
  assert.equal(path.dirname(made.path), lib);
  assert.equal((await files.createInLibrary('Budget', '{}')).name, 'Budget (2)');
  assert.deepEqual((await files.library()).map(f => f.name).sort(), ['Budget', 'Budget (2)']);
  const opened = await files.readWorkbook(made.path);
  assert.equal(opened.text, '{"v":1}');
  // save over it 7 times: one file, 5 backups
  let stamp = opened.stat;
  for (let i = 2; i <= 8; i++) { const r = await files.saveWorkbook(made.path, '{"v":' + i + '}', { expected: stamp }); stamp = r.stat; }
  assert.equal(fs.readFileSync(made.path, 'utf8'), '{"v":8}');
  const backupDirs = fs.readdirSync(path.join(userData, 'backups'));
  assert.equal(fs.readdirSync(path.join(userData, 'backups', backupDirs[0])).filter(f => f.endsWith('.mcsheet')).length, 5);
  assert.deepEqual(fs.readdirSync(lib).filter(f => f.endsWith('.tmp')), [], 'no temporary files left behind');
  // another program changes the file → conflict, nothing written
  await new Promise(r => setTimeout(r, 20));
  fs.writeFileSync(made.path, '{"v":"theirs"}');
  const conflict = await files.saveWorkbook(made.path, '{"v":"mine"}', { expected: stamp });
  assert.equal(conflict.conflict, 'changed');
  assert.equal(fs.readFileSync(made.path, 'utf8'), '{"v":"theirs"}');
  const forced = await files.saveWorkbook(made.path, '{"v":"mine"}', { expected: stamp, force: true });
  assert.equal(fs.readFileSync(made.path, 'utf8'), '{"v":"mine"}');
  assert.equal((await files.changedOnDisk(made.path, forced.stat)).state, 'same');
  // moved away → "missing" conflict; readWorkbook explains
  const moved = path.join(freshDir(), 'elsewhere.mcsheet');
  fs.renameSync(made.path, moved);
  assert.equal((await files.saveWorkbook(made.path, '{}', { expected: forced.stat })).conflict, 'missing');
  await assert.rejects(files.readWorkbook(made.path), /isn't there any more/);
  // access: a path the person never chose is refused; once chosen (dialog), it's allowed
  const outside = path.join(freshDir(), 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  await assert.rejects(files.readBytes(outside), /only open files you choose/);
  await assert.rejects(files.readBytes('relative/path.csv'), /isn't a file path/);
  await assert.rejects(files.readWorkbook(path.join(lib, '..', path.basename(outside))), /only open files you choose/);
  files.grant(outside);
  assert.equal(new TextDecoder().decode((await files.readBytes(outside)).bytes), 'secret');
  // rename, duplicate, delete (to the trash)
  const b2 = path.join(lib, 'Budget (2).mcsheet');
  const renamed = await files.rename(b2, 'Q3 forecast');
  assert.equal(path.basename(renamed.path), 'Q3 forecast.mcsheet');
  const sneaky = await files.rename(renamed.path, '../escape');          // folders are stripped from names
  assert.equal(sneaky.path, path.join(lib, 'escape.mcsheet'));
  assert.ok(!fs.existsSync(path.join(path.dirname(lib), 'escape.mcsheet')));
  await assert.rejects(files.rename(sneaky.path, '...'), /Enter a name/);
  const back = await files.rename(sneaky.path, 'Q3 forecast');
  const dup = await files.duplicate(back.path);
  assert.equal(dup.name, 'Q3 forecast (copy)');
  await files.remove(dup.path);
  assert.deepEqual(trashed, [dup.path]);
  assert.ok(!files.recent().some(r => r.path === dup.path), 'deleted files leave the recent list');
});

test('files: recovery snapshots and the crash marker', async () => {
  const userData = freshDir();
  const files = createFiles({ libraryDir: freshDir(), userData });
  assert.equal(files.startSession().crashed, false);
  await files.putRecovery('doc_1', { name: 'Unsaved work', path: null }, '{"cells":1}');
  await files.putRecovery('doc_2', { name: 'Budget', path: '/somewhere/Budget.mcsheet' }, '{"cells":2}');
  await assert.rejects(files.putRecovery('../evil', { name: 'x' }, '{}'), /Bad document id/);
  const list = await files.listRecovery();
  assert.deepEqual(list.map(r => r.docId).sort(), ['doc_1', 'doc_2']);
  assert.equal((await files.readRecovery('doc_2')).text, '{"cells":2}');
  // the file the snapshot belongs to may be saved to again
  assert.equal(files.allowed('/somewhere/Budget.mcsheet'), path.resolve('/somewhere/Budget.mcsheet'));
  await files.discardRecovery('doc_1');
  assert.deepEqual((await files.listRecovery()).map(r => r.docId), ['doc_2']);
  // a session that didn't end is noticed at the next start
  const again = createFiles({ libraryDir: freshDir(), userData });
  assert.equal(again.startSession().crashed, true);
  again.endSession();
  assert.equal(createFiles({ libraryDir: freshDir(), userData }).startSession().crashed, false);
});

/* ── app:// and the IPC gate ─────────────────────── */

test('app:// maps only to the window\'s and the engine\'s files; the CSP forbids network, inline scripts and frames', () => {
  const src = path.resolve('/app/src');
  const roots = { src };
  assert.equal(fileFor('app://sheets/', roots), path.join(src, 'renderer', 'index.html'));
  assert.equal(fileFor('app://sheets/renderer/js/app.js', roots), path.join(src, 'renderer', 'js', 'app.js'));
  assert.equal(fileFor('app://sheets/shared/engine/index.js', roots), path.join(src, 'shared', 'engine', 'index.js'));
  for (const bad of ['app://sheets/main/main.js', 'app://sheets/preload/preload.js', 'app://sheets/renderer/../main/main.js', 'app://sheets/renderer/%2e%2e/main/main.js',
    'app://sheets/renderer/..%2fmain%2fmain.js', 'app://sheets/shared/../../package.json', 'app://sheets/../app-config.json', 'app://other/renderer/index.html',
    'file:///etc/passwd', 'app://sheets/renderer/%00x', 'app://sheets/renderer/a\\..\\..\\main\\main.js']) {
    const f = fileFor(bad, roots);
    assert.ok(f === null || f.startsWith(path.join(src, 'renderer') + path.sep) || f.startsWith(path.join(src, 'shared') + path.sep), bad + ' → ' + f);
    assert.ok(f === null || !/[\\/](main|preload)[\\/]/.test(f.slice(src.length)), bad + ' reached ' + f);
  }
  assert.match(CSP, /connect-src 'none'/);
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.doesNotMatch(CSP, /unsafe-inline|unsafe-eval/);
  assert.match(CSP, /frame-src 'none'/);
});

test('ipc: only the app\'s page may call; locked apps refuse workbook access but keep recovery; errors are plain', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const webContents = { send() {}, isDestroyed: () => false };
  const win = { webContents };
  let unlocked = false;
  const put = [];
  registerIpc({
    ipcMain, dialog: {}, shell: {}, clipboard: { readText: async () => 'x', read: async () => [], writeText: async () => {} }, app: {}, getWindow: () => win,
    auth: {}, entitlement: { unlocked: () => unlocked, state: () => ({ status: unlocked ? 'active' : 'plan-required', server: SERVER }) },
    files: { library: async () => ['a'], putRecovery: async (id, meta, text) => { put.push(id); return { ok: true }; } },
    platform: { ai: async b => ({ text: 'ok', model: null }) },
    settings: { get: () => ({}), set: () => true }, info: () => ({ version: '1.0.0' }), quitReady() {}, quitAck() {}, quitCancel() {}
  });
  const ev = (url = 'app://sheets/index.html', sender = webContents) => ({ sender, senderFrame: { url } });
  assert.deepEqual(await handlers.get('files:library')(ev('https://evil.example/')), { ok: false, error: { code: 'forbidden', message: 'Not allowed.' } });
  assert.equal((await handlers.get('files:library')(ev('app://sheets/index.html', { other: true }))).error.code, 'forbidden');
  const locked = await handlers.get('files:library')(ev());
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, 'locked');
  assert.equal((await handlers.get('ai:run')(ev(), { messages: [{ role: 'user', content: 'hi' }] })).error.code, 'locked');
  assert.deepEqual(await handlers.get('recovery:put')(ev(), { docId: 'd1', meta: { name: 'x' }, text: '{}' }), { ok: true, value: { ok: true } });
  unlocked = true;
  assert.deepEqual(await handlers.get('files:library')(ev()), { ok: true, value: ['a'] });
  assert.equal((await handlers.get('ai:run')(ev(), { messages: [{ role: 'hacker', content: 'x' }] })).error.code, 'invalid_request');
  assert.deepEqual(await handlers.get('ai:run')(ev(), { messages: [{ role: 'user', content: 'hi' }] }), { ok: true, value: { text: 'ok', model: null } });
  assert.equal((await handlers.get('open:external')(ev(), { target: 'javascript:alert(1)' })).error.code, 'invalid_request');
  assert.equal((await handlers.get('files:save')(ev(), { path: '/x', text: 5 })).error.code, 'invalid_request');
  const fsErr = errorOut(Object.assign(new Error('EACCES: permission denied, open \'/home/me/secret\''), { code: 'EACCES' }));
  assert.deepEqual(fsErr, { ok: false, error: { code: 'file_error', message: 'The app doesn\'t have permission to use that file or folder.' } });
  assert.doesNotMatch(errorOut(new Error('failed with Bearer eyJhbGciOi.abc')).error.message, /eyJ/);
});

test('menu: every item has a label or role and sends a command', () => {
  const sent = [];
  for (const isMac of [true, false]) {
    const tpl = menuTemplate({ send: c => sent.push(c), isMac, dev: false, appName: 'MetaCode Sheets' });
    const walk = items => items.forEach(i => { if (i.type === 'separator') return; assert.ok(i.label || i.role, JSON.stringify(i)); if (i.submenu) walk(i.submenu); else if (i.click) i.click(); });
    walk(tpl);
  }
  assert.ok(sent.includes('save') && sent.includes('aiCoding') && sent.includes('exportXlsx'));
});
