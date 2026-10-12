// ── Who is signed in? ─────────────────────────────────────────────────────────
// The browser signs in with Supabase Auth (public/js/account.js) and sends its
// access token in the mc_session cookie (or an Authorization: Bearer header).
// The server never trusts what a token claims: it asks Supabase Auth
// (GET /auth/v1/user) whether the token is valid and whose it is, and keeps
// the answer for a minute (never past the token's expiry). The token itself
// isn't stored or logged.
const crypto = require('crypto');
const { request } = require('./http');
const { decodeJwtPayload } = require('./config');

const COOKIE = 'mc_session';
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CACHE_MS = 60 * 1000;
const BAD_CACHE_MS = 30 * 1000;
const MAX_CACHE = 5000;

function tokenOf(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (m) return TOKEN_RE.test(m[1]) && m[1].length <= 8192 ? m[1] : null;
  const c = String((req.headers && req.headers.cookie) || '').match(/(?:^|;\s*)mc_session=([^;]+)/);
  const t = c ? decodeURIComponent(c[1].trim()) : '';
  return TOKEN_RE.test(t) && t.length <= 8192 ? t : null;
}

function createAuth(getConfig, opts) {
  opts = opts || {};
  const now = opts.now || Date.now;
  const cache = new Map();
  const key = token => crypto.createHash('sha256').update(token).digest('hex');

  function remember(k, result, ms) {
    if (cache.size >= MAX_CACHE) { const t = now(); for (const [kk, v] of cache) if (v.until <= t) cache.delete(kk); if (cache.size >= MAX_CACHE) cache.clear(); }
    cache.set(k, { result, until: now() + ms });
  }

  // → { user: { id, email, emailConfirmed } } | { error: 'invalid' | 'expired' | 'unavailable' }
  async function verify(token) {
    const cfg = getConfig();
    if (!cfg.enabled) return { error: 'disabled' };
    if (!token || !TOKEN_RE.test(token)) return { error: 'invalid' };
    const k = key(token);
    const hit = cache.get(k);
    if (hit && hit.until > now()) return hit.result;
    const claims = decodeJwtPayload(token) || {};
    const expMs = Number(claims.exp) * 1000;
    if (Number.isFinite(expMs) && expMs <= now()) return { error: 'expired' };
    let out;
    try {
      out = await request(cfg.supabaseUrl + '/auth/v1/user', { headers: { apikey: cfg.publishableKey, Authorization: 'Bearer ' + token }, timeoutMs: 8000 });
    } catch (e) {
      return { error: 'unavailable' };
    }
    if (out.status === 401 || out.status === 403) { const r = { error: 'invalid' }; remember(k, r, BAD_CACHE_MS); return r; }
    if (!out.ok || !out.json || typeof out.json.id !== 'string') return { error: out.ok ? 'invalid' : 'unavailable' };
    const u = out.json;
    const result = { user: { id: u.id, email: typeof u.email === 'string' ? u.email.toLowerCase() : null, emailConfirmed: !!(u.email_confirmed_at || u.confirmed_at) } };
    remember(k, result, Number.isFinite(expMs) ? Math.max(1000, Math.min(CACHE_MS, expMs - now())) : CACHE_MS);
    return result;
  }

  return { verify, tokenOf, forget: token => cache.delete(key(token)) };
}

module.exports = { createAuth, tokenOf, COOKIE };
