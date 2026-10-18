// @ts-check
// ── Which MetaCode server the app talks to ────────────────────────────────────
// app-config.json, packaged with the app:
//   serverUrl            the MetaCode server (https://metac0.de)
//   leasePublicKeys      the server's lease public keys (SPKI DER, base64).
//                        Release builds pin them (scripts/build.js fills them in
//                        from DESKTOP_LEASE_PUBLIC_KEYS), so a lease can only come
//                        from that server. Empty: the key the server publishes
//                        at /api/desktop/config, fetched over HTTPS, is used.
//   allowServerOverride  whether METACODE_SHEETS_SERVER / --server=… may point
//                        a packaged app at another server (development builds
//                        always may).
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = { serverUrl: 'https://metac0.de', leasePublicKeys: [], allowServerOverride: false };

/** @param {string} host */
const isLocal = host => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

/**
 * A server address the app accepts: https, or http for this computer only.
 * @param {unknown} raw @returns {string | null} the origin
 */
function cleanServerUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let u;
  try { u = new URL(raw.trim()); } catch (e) { return null; }
  if (u.username || u.password) return null;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(u.host))) return u.origin;
  return null;
}

/**
 * @param {{ appRoot: string, env?: Record<string, string | undefined>, argv?: string[], isPackaged: boolean }} o
 */
function loadAppConfig(o) {
  const env = o.env || process.env;
  /** @type {any} */
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(o.appRoot, 'app-config.json'), 'utf8')) || {}; } catch (e) { file = {}; }
  const keys = Array.isArray(file.leasePublicKeys) ? file.leasePublicKeys.filter((/** @type {unknown} */ k) => typeof k === 'string' && /^[A-Za-z0-9+/=]{40,200}$/.test(k)) : [];
  let serverUrl = cleanServerUrl(file.serverUrl) || DEFAULTS.serverUrl;
  let source = 'app-config.json';
  const mayOverride = !o.isPackaged || file.allowServerOverride === true;
  const flag = (o.argv || []).map(a => /^--server=(.+)$/.exec(a)).find(Boolean);
  const wanted = flag ? flag[1] : env.METACODE_SHEETS_SERVER;
  if (wanted && mayOverride) {
    const s = cleanServerUrl(wanted);
    if (s) { serverUrl = s; source = flag ? '--server' : 'METACODE_SHEETS_SERVER'; }
  }
  return { serverUrl, leasePublicKeys: keys, pinned: keys.length > 0 && source === 'app-config.json', source };
}

module.exports = { loadAppConfig, cleanServerUrl, isLocal };
