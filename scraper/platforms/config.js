// @ts-check
// ── Other platforms: settings ─────────────────────────────────────────────────
// YouTube and X (Twitter) are collected through their official APIs only:
//
//   YouTube  YouTube Data API v3 with an API key. The server's key
//            (YOUTUBE_API_KEY) or the user's own, sent per job from their
//            browser and never stored on the server.
//   X        X API v2 with a bearer token (X_BEARER_TOKEN, or the user's own).
//            Reading posts needs an X developer plan that includes search;
//            X bills for it.
//
// Their requests take the same network route as Reddit's (direct, the
// administrator's proxy or the VPN gateway — network/providers.js), so the
// circuit breaker, diagnostics and the VPN apply to them too. The hosts below
// are the only ones they may reach.

const DEFAULTS = {
  youtubeBaseUrl: 'https://www.googleapis.com/youtube/v3',
  youtubeDailyQuota: 10000,       // Google's default daily quota per project, in units
  youtubeMinDelayMs: 250,
  xBaseUrl: 'https://api.x.com/2',
  xMinDelayMs: 1000
};

const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{20,100}$/;
const X_TOKEN_RE = /^[A-Za-z0-9%._~+/=-]{20,400}$/;

/** @param {Record<string, string | undefined>} env @param {string} name @param {boolean} fallback */
function flag(env, name, fallback) {
  const v = String(env[name] || '').trim().toLowerCase();
  if (!v) return fallback;
  return /^(1|true|yes|on)$/.test(v);
}

/** @param {Record<string, string | undefined>} env @param {string} name @param {number} fallback @param {number} min @param {number} max */
function int(env, name, fallback, min, max) {
  const n = Number(String(env[name] || '').trim());
  return String(env[name] || '').trim() && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ allowPrivateNetwork?: boolean }} [o]
 */
function platformConfig(env, o) {
  /** @type {string[]} */
  const warnings = [];
  const allowPlain = !!(o && o.allowPrivateNetwork);
  /** @param {string} name @param {string} fallback */
  const baseUrl = (name, fallback) => {
    const raw = String(env[name] || '').trim().replace(/\/+$/, '');
    if (!raw) return fallback;
    let u = null;
    try { u = new URL(raw); } catch (e) { u = null; }
    if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && allowPlain))) {
      warnings.push(name + ' must be an https:// URL; using ' + fallback + '.');
      return fallback;
    }
    return raw;
  };
  const ytKey = String(env.YOUTUBE_API_KEY || '').trim();
  if (ytKey && !YOUTUBE_KEY_RE.test(ytKey)) warnings.push('YOUTUBE_API_KEY doesn\'t look like a Google API key; it is ignored.');
  const xToken = String(env.X_BEARER_TOKEN || '').trim();
  if (xToken && !X_TOKEN_RE.test(xToken)) warnings.push('X_BEARER_TOKEN doesn\'t look like an X API bearer token; it is ignored.');
  const youtube = {
    enabled: flag(env, 'YOUTUBE_ENABLED', true),
    apiKey: ytKey && YOUTUBE_KEY_RE.test(ytKey) ? ytKey : null,
    baseUrl: baseUrl('YOUTUBE_API_BASE_URL', DEFAULTS.youtubeBaseUrl),
    dailyQuota: int(env, 'YOUTUBE_DAILY_QUOTA', DEFAULTS.youtubeDailyQuota, 100, 100000000),
    minDelayMs: int(env, 'YOUTUBE_MIN_DELAY_MS', DEFAULTS.youtubeMinDelayMs, 0, 60000)
  };
  const x = {
    enabled: flag(env, 'X_ENABLED', true),
    bearerToken: xToken && X_TOKEN_RE.test(xToken) ? xToken : null,
    baseUrl: baseUrl('X_API_BASE_URL', DEFAULTS.xBaseUrl),
    minDelayMs: int(env, 'X_MIN_DELAY_MS', DEFAULTS.xMinDelayMs, 0, 60000)
  };
  /** @type {RegExp[]} */
  const hostPatterns = [];
  const ports = new Set();
  [youtube.baseUrl, x.baseUrl].forEach(b => {
    const u = new URL(b);
    hostPatterns.push(new RegExp('^' + u.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
    ports.add(u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80));
  });
  return { youtube, x, hostPatterns, ports: Array.from(ports), warnings };
}

module.exports = { platformConfig, YOUTUBE_KEY_RE, X_TOKEN_RE, DEFAULTS };
