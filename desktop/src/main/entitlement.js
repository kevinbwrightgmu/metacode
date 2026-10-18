// @ts-check
// ── May this account use the app right now? ───────────────────────────────────
// The server decides (GET /api/desktop/entitlement: the account's Supabase
// token, its Stripe plan). The app only ever unlocks on:
//   • the server's "yes" (Pro, Max or Ultra), which comes with a signed lease, or
//   • when the server can't be reached: a lease that is still valid — signed
//     with the server's key (pinned in app-config.json for release builds),
//     for this account and this server, not expired, and with the computer's
//     clock not turned back past the last time the app saw.
// Nothing stored on the computer can unlock it by itself: the lease is
// checked against the key each time, and a changed lease fails that check.
// Features that run on the server (AI) are checked there again on every call.
//
// States: starting · signed-out · checking · active · offline (on a lease) ·
// plan-required · unavailable (desktop access off on the server) ·
// update-required · error (no connection and no valid lease)
'use strict';
const { verifyLease } = require('./lease');
const { NetError, errorMessage } = require('./http');

const RECHECK_MS = 15 * 60 * 1000;          // while active
const OFFLINE_RECHECK_MS = 2 * 60 * 1000;   // while offline or erroring
const CLOCK_SKEW_MS = 10 * 60 * 1000;       // tolerated difference to the last time seen
const CONFIG_TTL_MS = 60 * 60 * 1000;

/** @param {string} a @param {string} b → -1, 0, 1 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/**
 * @param {{ http: ReturnType<typeof import('./http').createHttp>, auth: ReturnType<typeof import('./auth').createAuth>,
 *           store: ReturnType<typeof import('./secure-store').createSecureStore>, server: string, pinnedKeys: string[],
 *           appVersion: string, now?: () => number, onChange?: (state: any) => void, timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} o
 */
function createEntitlement(o) {
  const now = o.now || Date.now;
  const timers = o.timers || { setTimeout, clearTimeout };
  /** @type {any} */
  let state = { status: 'starting' };
  /** @type {{ at: number, value: any } | null} */
  let config = null;
  /** @type {any} */
  let timer = null;
  /** @type {Promise<any> | null} */
  let inFlight = null;

  function set(/** @type {any} */ next) {
    state = Object.assign({ checkedAt: new Date(now()).toISOString() }, next);
    if (o.onChange) o.onChange(publicState());
    schedule();
    return publicState();
  }
  /** What the window may know (no tokens, no lease) */
  function publicState() {
    const c = config && config.value;
    return {
      status: state.status, message: state.message || null, user: state.user || (o.auth.user() || null), plan: state.plan || null,
      offlineUntil: state.offlineUntil || null, checkedAt: state.checkedAt || null, server: o.server,
      upgradeUrl: state.upgradeUrl || (c && c.upgradeUrl) || o.server + '/app.html#account',
      accountUrl: (c && c.accountUrl) || o.server + '/app.html#account',
      signUpUrl: (c && c.signUpUrl) || o.server + '/app.html#account',
      downloadUrl: (c && c.downloadUrl) || null,
      plansWithDesktop: state.plansWithDesktop || ['Pro', 'Max', 'Ultra'],
      emailLink: !!(c && c.accounts && c.accounts.emailLink),
      persisted: !!o.store.kind(),
      limits: state.limits || null
    };
  }
  function schedule() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    const s = state.status;
    const ms = s === 'active' ? RECHECK_MS : (s === 'offline' || s === 'error') ? OFFLINE_RECHECK_MS : 0;
    if (ms) timer = timers.setTimeout(() => { api.check('timer').catch(() => {}); }, ms);
  }

  /** A private server without accounts (remembered for offline starts) */
  const localMode = () => o.store.get().localServer === o.server;
  /** Who a lease must be for: the signed-in account, or "local" on a server without accounts */
  const currentUser = () => o.auth.user() || (localMode() ? { id: 'local', email: null } : null);

  /** The time the app last saw, never going back */
  function touchClock() {
    const seen = Number(o.store.get().lastSeen) || 0;
    const t = now();
    if (t > seen) o.store.update({ lastSeen: t });
    return seen;
  }

  async function getConfig(force = false) {
    if (!force && config && now() - config.at < CONFIG_TTL_MS) return config.value;
    const r = await o.http.request(o.server + '/api/desktop/config', { timeoutMs: 15000 });
    if (!r.ok || !r.json || r.json.app !== 'metacode-sheets') {
      if (config) return config.value;
      throw new NetError('bad_response', 'The server at ' + o.server + ' isn\'t a MetaCode server (or is having trouble).');
    }
    config = { at: now(), value: r.json };
    return r.json;
  }

  /** The keys a lease may be signed with */
  function trustedKeys() {
    if (o.pinnedKeys.length) return o.pinnedKeys;
    const kept = o.store.get().leaseKey;
    return kept && kept.server === o.server && typeof kept.publicKey === 'string' ? [kept.publicKey] : [];
  }

  /**
   * The kept lease, if it still unlocks the app offline
   * @returns {{ payload: any } | { problem: string }}
   */
  function offlineLease() {
    const kept = o.store.get().lease;
    const u = currentUser();
    if (!kept || typeof kept.token !== 'string') return { problem: 'none' };
    if (!u) return { problem: 'signed-out' };
    let payload = null;
    for (const k of trustedKeys()) { payload = verifyLease(kept.token, k); if (payload) break; }
    if (!payload) return { problem: 'invalid' };
    if (payload.sub !== u.id || payload.srv !== o.server) return { problem: 'other-account' };
    const t = now();
    const lastSeen = Number(o.store.get().lastSeen) || 0;
    if (t + CLOCK_SKEW_MS < lastSeen) return { problem: 'clock' };
    if (payload.iat * 1000 > t + CLOCK_SKEW_MS) return { problem: 'clock' };
    if (payload.exp * 1000 <= t) return { problem: 'expired' };
    return { payload };
  }

  /** No answer from the server: use the lease, if there's a valid one @param {string} why */
  function goOffline(why) {
    const l = offlineLease();
    if ('payload' in l) {
      touchClock();
      return set({ status: 'offline', user: currentUser(), plan: { id: l.payload.plan, name: (state.plan && state.plan.name) || l.payload.plan }, offlineUntil: new Date(l.payload.exp * 1000).toISOString(),
        message: why + ' You can keep working offline until ' + new Date(l.payload.exp * 1000).toLocaleString() + '; the app checks again when it can.' });
    }
    const reason = l.problem === 'expired' ? ' Your offline access has run out — connect to the internet so MetaCode can confirm your subscription.'
      : l.problem === 'clock' ? ' The computer\'s clock seems to have been turned back, so offline access can\'t be confirmed. Connect to the internet to continue.'
      : l.problem === 'invalid' || l.problem === 'other-account' ? ' The offline access kept on this computer isn\'t valid. Connect to the internet to continue.'
      : o.store.kind() ? ' Connect to the internet once so MetaCode can confirm your subscription.' : ' This computer has no secure place to keep offline access (no system keychain), so the app needs a connection.';
    return set({ status: 'error', user: o.auth.user(), message: why + reason });
  }

  async function run() {
    let c;
    try { c = await getConfig(); }
    catch (e) {
      // a signed-out app shows the sign-in screen (which says if signing in fails)
      if (!o.auth.signedIn() && !localMode()) return set({ status: 'signed-out' });
      return goOffline(e instanceof NetError && e.kind === 'bad_response' ? e.message : 'Can\'t reach MetaCode right now.');
    }
    if (!c.available) return set({ status: 'unavailable', message: c.reason || 'The desktop app isn\'t available on this server.' });
    if (c.minVersion && compareVersions(o.appVersion, c.minVersion) < 0) {
      return set({ status: 'update-required', message: 'This version of MetaCode Sheets (' + o.appVersion + ') is too old for the server. Install version ' + c.minVersion + ' or later.' });
    }
    // a private server without accounts (DESKTOP_WITHOUT_ACCOUNTS): no sign-in, the server still decides
    const local = !!(c.accounts && c.accounts.enabled === false);
    if (local !== localMode()) o.store.update({ localServer: local ? o.server : undefined });
    if (!local && !o.auth.signedIn()) return set({ status: 'signed-out' });
    if (!o.pinnedKeys.length && c.lease && typeof c.lease.publicKey === 'string') {
      // fetched over HTTPS from the configured server (no pinned keys in this build)
      const kept = o.store.get().leaseKey;
      if (!kept || kept.publicKey !== c.lease.publicKey || kept.server !== o.server) o.store.update({ leaseKey: { server: o.server, publicKey: c.lease.publicKey } });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      let token = null;
      if (!local) {
        try { token = await o.auth.accessToken({ force: attempt > 0 }); }
        catch (e) { return goOffline('Can\'t reach MetaCode\'s sign-in service right now.'); }
        if (!token) { clearLease(); return set({ status: 'signed-out', message: 'Your session ended. Sign in again.' }); }
      }
      let r;
      try { r = await o.http.request(o.server + '/api/desktop/entitlement', { headers: token ? { Authorization: 'Bearer ' + token } : {}, timeoutMs: 20000 }); }
      catch (e) { return goOffline('Can\'t reach MetaCode right now.'); }
      if (r.status === 401) continue;                           // token refused: refresh once, then ask again
      if (r.status === 403 && r.json && r.json.error && r.json.error.type === 'desktop_unavailable') { clearLease(); return set({ status: 'unavailable', message: errorMessage(r, 'The desktop app isn\'t available on this server.') }); }
      if (r.status === 429 && (state.status === 'active' || state.status === 'offline')) return set(Object.assign({}, state));
      if (!r.ok || !r.json) return goOffline(r.status === 503 ? errorMessage(r, 'MetaCode couldn\'t check your subscription just now.') : 'MetaCode had trouble checking your subscription (' + r.status + ').');
      const j = r.json;
      if (j.entitled === true) {
        const lease = j.lease && typeof j.lease.token === 'string' ? j.lease.token : null;
        let payload = null;
        if (lease) for (const k of trustedKeys()) { payload = verifyLease(lease, k); if (payload) break; }
        const u = currentUser();
        if (payload && u && payload.sub === u.id && payload.srv === o.server) o.store.update({ lease: { token: lease, receivedAt: now() } });
        else clearLease();                                         // works online; no offline access from a lease we can't check
        touchClock();
        return set({ status: 'active', user: j.user || u, plan: j.plan || null, limits: j.limits || null, upgradeUrl: j.upgradeUrl, offlineUntil: payload ? new Date(payload.exp * 1000).toISOString() : null,
          message: payload ? null : 'Offline access isn\'t available: the server\'s lease couldn\'t be checked with the key this app trusts.' });
      }
      clearLease();
      if (j.reason === 'plan_required') {
        return set({ status: 'plan-required', user: j.user || o.auth.user(), plan: j.plan || null, upgradeUrl: j.upgradeUrl, plansWithDesktop: j.plansWithDesktop,
          message: 'MetaCode Sheets is part of the ' + (j.plansWithDesktop || ['Pro', 'Max', 'Ultra']).join(', ').replace(/, ([^,]*)$/, ' and $1') + ' plans.' + (j.plan && j.plan.name ? ' Your plan: ' + j.plan.name + '.' : '') });
      }
      return set({ status: 'error', message: 'The server\'s answer wasn\'t understood.' });
    }
    // refused twice, even with a fresh token
    await o.auth.signOut();
    clearLease();
    return set({ status: 'signed-out', message: 'Your session ended. Sign in again.' });
  }

  function clearLease() { if (o.store.get().lease) o.store.update({ lease: undefined }); }

  const api = {
    state: publicState,
    config: () => getConfig(),
    /** Asks the server (one check at a time) @param {string} [reason] */
    check(reason) {
      if (inFlight) return inFlight;
      if (state.status === 'starting' || reason === 'sign-in') state = Object.assign({}, state, { status: state.status === 'starting' ? 'checking' : state.status });
      inFlight = run().finally(() => { inFlight = null; });
      return inFlight;
    },
    /** May the app be used (and its local features)? */
    unlocked: () => state.status === 'active' || state.status === 'offline',
    /** May server features be called? (the server checks again) */
    online: () => state.status === 'active',
    async signedOut() { clearLease(); if (localMode()) return run(); return set({ status: 'signed-out' }); },
    stop() { if (timer) timers.clearTimeout(timer); timer = null; }
  };
  return api;
}

module.exports = { createEntitlement, compareVersions, RECHECK_MS, OFFLINE_RECHECK_MS, CLOCK_SKEW_MS };
