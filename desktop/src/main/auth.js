// @ts-check
// ── Signing in with the MetaCode account ──────────────────────────────────────
// The same Supabase accounts as the website (accounts/ on the server). The
// main process talks to Supabase's Auth API directly; the window never sees a
// token. Supported:
//   • email and password (POST /auth/v1/token?grant_type=password)
//   • an emailed sign-in link that opens the app (PKCE: the link only works
//     with the secret this app made, so someone else's link can't sign you in
//     to their account). Only offered when the server says it's set up
//     (DESKTOP_EMAIL_LINK=true, with metacode-sheets://auth-callback in
//     Supabase's redirect URLs).
// Creating an account and resetting a password happen on the website.
//
// The access token lives in memory and is refreshed shortly before it
// expires; the refresh token is kept in the encrypted store (secure-store.js)
// when the system has one, so the app stays signed in between launches.
'use strict';
const crypto = require('crypto');
const { NetError, errorMessage } = require('./http');

const CALLBACK = 'metacode-sheets://auth-callback';

class AuthError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {any} r */
function authProblem(r) {
  const j = r.json || {};
  const code = String(j.error_code || j.error || '').toLowerCase();
  const text = String(j.error_description || j.msg || j.message || '');
  if (r.status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return new AuthError('rate_limited', 'Too many attempts. Wait a minute, then try again.');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(text)) return new AuthError('invalid_credentials', 'That email and password don\'t match a MetaCode account.');
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(text)) return new AuthError('email_not_confirmed', 'Confirm your email address first — open the link MetaCode emailed you, then sign in.');
  if (code === 'otp_disabled' || /signups not allowed for otp|user not found/i.test(text)) return new AuthError('no_account', 'There\'s no MetaCode account with that email address.');
  if (code === 'flow_state_expired' || code === 'flow_state_not_found' || /expired/i.test(text)) return new AuthError('link_expired', 'That sign-in link has expired or was already used. Ask for a new one.');
  if (r.status >= 500) return new AuthError('auth_unavailable', 'MetaCode\'s sign-in service isn\'t answering right now. Try again in a minute.');
  return new AuthError('auth_failed', errorMessage(r, 'Signing in didn\'t work.'));
}

const b64u = (/** @type {Buffer} */ b) => b.toString('base64url');

/**
 * @param {{ http: ReturnType<typeof import('./http').createHttp>, store: ReturnType<typeof import('./secure-store').createSecureStore>,
 *           accounts: () => Promise<{ supabaseUrl: string, publishableKey: string } | null>, server: string, now?: () => number,
 *           onChange?: () => void }} o
 */
function createAuth(o) {
  const now = o.now || Date.now;
  /** @type {{ accessToken: string, expiresAt: number } | null} */
  let access = null;
  /** @type {{ id: string, email: string | null } | null} */
  let user = null;
  /** @type {string | null} */
  let refreshToken = null;
  /** @type {Promise<string | null> | null} */
  let refreshing = null;
  /** @type {{ verifier: string, email: string, expires: number } | null} */
  let pendingLink = null;

  // what an earlier launch kept (only for this server)
  const saved = o.store.get().session;
  if (saved && saved.server === o.server && typeof saved.refreshToken === 'string' && saved.user && typeof saved.user.id === 'string') {
    refreshToken = saved.refreshToken;
    user = { id: saved.user.id, email: typeof saved.user.email === 'string' ? saved.user.email : null };
  }

  const changed = () => { if (o.onChange) o.onChange(); };

  async function supabase() {
    const a = await o.accounts();
    if (!a || !a.supabaseUrl || !a.publishableKey) throw new AuthError('accounts_off', 'This MetaCode server doesn\'t have accounts turned on.');
    return a;
  }

  /** @param {any} j */
  function accept(j) {
    if (!j || typeof j.access_token !== 'string' || typeof j.refresh_token !== 'string' || !j.user || typeof j.user.id !== 'string') {
      throw new AuthError('auth_failed', 'The sign-in service sent an answer the app doesn\'t understand.');
    }
    const ttl = Math.max(60, Math.min(24 * 3600, Number(j.expires_in) || 3600));
    access = { accessToken: j.access_token, expiresAt: now() + ttl * 1000 };
    refreshToken = j.refresh_token;
    const sameUser = user && user.id === j.user.id;
    user = { id: j.user.id, email: typeof j.user.email === 'string' ? j.user.email : null };
    const kept = o.store.update({ session: { server: o.server, refreshToken, user, savedAt: new Date(now()).toISOString() } });
    if (!sameUser) changed();
    return { user, persisted: kept };
  }

  /** @param {string} grant @param {any} body */
  async function token(grant, body) {
    const a = await supabase();
    const r = await o.http.request(a.supabaseUrl + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { apikey: a.publishableKey }, json: body, timeoutMs: 20000 });
    if (!r.ok) throw authProblem(r);
    return accept(r.json);
  }

  const api = {
    callbackUrl: CALLBACK,
    signedIn: () => !!refreshToken && !!user,
    user: () => user,

    /** @param {string} email @param {string} password */
    async signInWithPassword(email, password) {
      if (typeof email !== 'string' || !/^[^@\s]{1,200}@[^@\s]{1,200}\.[^@\s]{1,60}$/.test(email.trim())) throw new AuthError('invalid_email', 'Enter a valid email address.');
      if (typeof password !== 'string' || !password || password.length > 500) throw new AuthError('invalid_password', 'Enter your password.');
      return token('password', { email: email.trim(), password });
    },

    /** Sends a sign-in link that opens this app @param {string} email */
    async sendEmailLink(email) {
      if (typeof email !== 'string' || !/^[^@\s]{1,200}@[^@\s]{1,200}\.[^@\s]{1,60}$/.test(email.trim())) throw new AuthError('invalid_email', 'Enter a valid email address.');
      const a = await supabase();
      const verifier = b64u(crypto.randomBytes(48));
      const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
      const r = await o.http.request(a.supabaseUrl + '/auth/v1/otp?redirect_to=' + encodeURIComponent(CALLBACK), {
        method: 'POST', headers: { apikey: a.publishableKey }, timeoutMs: 20000,
        json: { email: email.trim(), create_user: false, code_challenge: challenge, code_challenge_method: 's256' }
      });
      if (!r.ok) throw authProblem(r);
      pendingLink = { verifier, email: email.trim(), expires: now() + 3600 * 1000 };
      return { sent: true };
    },

    /** The sign-in link opened the app @param {string} url */
    async completeEmailLink(url) {
      let u;
      try { u = new URL(url); } catch (e) { throw new AuthError('bad_link', 'That link isn\'t a MetaCode sign-in link.'); }
      if (u.protocol !== 'metacode-sheets:' || u.hostname !== 'auth-callback') throw new AuthError('bad_link', 'That link isn\'t a MetaCode sign-in link.');
      const params = new URLSearchParams(u.search || u.hash.replace(/^#/, ''));
      if (params.get('error') || params.get('error_description')) throw new AuthError('link_failed', String(params.get('error_description') || params.get('error')).slice(0, 200));
      const code = params.get('code');
      if (!code || !/^[A-Za-z0-9_-]{8,200}$/.test(code)) throw new AuthError('bad_link', 'The sign-in link is incomplete. Copy the whole link or ask for a new one.');
      if (!pendingLink || pendingLink.expires < now()) throw new AuthError('no_pending', 'This app didn\'t ask for that link (or it was over an hour ago). Ask for a new link from this app.');
      const verifier = pendingLink.verifier;
      pendingLink = null;
      return token('pkce', { auth_code: code, code_verifier: verifier });
    },

    /**
     * A current access token: refreshed when it's about to expire. null when
     * signed out. Throws NetError when the refresh can't reach Supabase.
     * @param {{ force?: boolean }} [opts]
     * @returns {Promise<string | null>}
     */
    async accessToken(opts = {}) {
      if (!refreshToken) return null;
      if (!opts.force && access && access.expiresAt - now() > 60000) return access.accessToken;
      if (refreshing) return refreshing;
      const rt = refreshToken;
      refreshing = (async () => {
        try {
          await token('refresh_token', { refresh_token: rt });
          return access ? access.accessToken : null;
        } catch (e) {
          if (e instanceof NetError) throw e;
          if (e instanceof AuthError && (e.code === 'auth_unavailable' || e.code === 'rate_limited')) throw new NetError('offline', e.message);
          // the session was revoked or expired: signed out
          api.forget();
          return null;
        } finally { refreshing = null; }
      })();
      return refreshing;
    },

    /** Signs out here (and tells Supabase, if it can be reached) */
    async signOut() {
      const tokenNow = access && access.accessToken;
      api.forget();
      if (!tokenNow) return;
      try {
        const a = await supabase();
        await o.http.request(a.supabaseUrl + '/auth/v1/logout?scope=local', { method: 'POST', headers: { apikey: a.publishableKey, Authorization: 'Bearer ' + tokenNow }, timeoutMs: 5000 });
      } catch (e) { /* offline: the session ends on its own */ }
    },

    /** Forgets the session on this computer */
    forget() {
      const had = !!refreshToken;
      access = null; refreshToken = null; user = null; pendingLink = null;
      o.store.update({ session: undefined });
      if (had) changed();
    }
  };
  return api;
}

module.exports = { createAuth, AuthError, CALLBACK };
