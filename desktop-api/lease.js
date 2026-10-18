// @ts-check
// ── Desktop leases: signed proof of a desktop entitlement ─────────────────────
// When the server confirms that an account may use the desktop app (Pro, Max
// or Ultra — plans.js, feature "desktop"), it hands the app a lease: a short
// statement — who, which plan, which server, until when — signed with this
// server's Ed25519 key. The app keeps it so it can open while offline, until
// the lease runs out (DESKTOP_OFFLINE_HOURS, default 72). It can't be edited
// or extended on the computer: the app checks the signature with the server's
// public key, and a changed lease no longer matches.
//
// The key: DESKTOP_LEASE_PRIVATE_KEY (an Ed25519 private key, PEM), or — when
// that isn't set — one generated on first use and kept in
// <ACCOUNT_DATA_DIR>/desktop-lease-key.pem (readable by this server's user
// only). Release builds of the app can pin the public key (desktop/app-config.json).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUDIENCE = 'metacode-sheets';
const b64u = (/** @type {Buffer | string} */ b) => Buffer.from(b).toString('base64url');

/** @param {string} raw */
function pemFromEnv(raw) {
  const s = String(raw || '').trim().replace(/\\n/g, '\n');
  return s && /-----BEGIN PRIVATE KEY-----/.test(s) ? s : null;
}

/**
 * The server's lease key (loaded or generated once).
 * @param {{ env?: Record<string, string | undefined>, dataDir: string }} o
 */
function loadLeaseKey(o) {
  const env = o.env || process.env;
  /** @type {crypto.KeyObject | null} */
  let privateKey = null;
  let source = 'env';
  const fromEnv = pemFromEnv(env.DESKTOP_LEASE_PRIVATE_KEY || '');
  if (fromEnv) {
    privateKey = crypto.createPrivateKey(fromEnv);
  } else {
    source = 'file';
    const file = path.join(o.dataDir, 'desktop-lease-key.pem');
    if (fs.existsSync(file)) privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    else {
      const pair = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(o.dataDir, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      privateKey = pair.privateKey;
      source = 'generated';
    }
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('DESKTOP_LEASE_PRIVATE_KEY must be an Ed25519 private key (openssl genpkey -algorithm ed25519).');
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = /** @type {Buffer} */ (publicKey.export({ type: 'spki', format: 'der' }));
  const kid = crypto.createHash('sha256').update(spki).digest('hex').slice(0, 16);
  return { privateKey, publicKey, publicKeyB64: spki.toString('base64'), kid, source };
}

/**
 * @param {ReturnType<typeof loadLeaseKey>} key
 * @param {{ sub: string, email?: string | null, plan: string, server: string, ttlMs: number, now?: number }} c
 * @returns {{ token: string, payload: Record<string, unknown> }}
 */
function signLease(key, c) {
  const iat = Math.floor((c.now || Date.now()) / 1000);
  const payload = { v: 1, aud: AUDIENCE, kid: key.kid, sub: c.sub, email: c.email || null, plan: c.plan, srv: c.server, iat, exp: iat + Math.floor(c.ttlMs / 1000) };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(body), key.privateKey);
  return { token: body + '.' + b64u(sig), payload };
}

/**
 * Checks a lease with a public key (SPKI DER, base64). Used by tests here and,
 * in the same way, by the desktop app (desktop/src/main/lease.js).
 * @param {string} token @param {string} publicKeyB64
 * @returns {Record<string, any> | null}
 */
function verifyLease(token, publicKeyB64) {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!m) return null;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, Buffer.from(m[1]), pub, Buffer.from(m[2], 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return payload && payload.aud === AUDIENCE ? payload : null;
  } catch (e) {
    return null;
  }
}

module.exports = { loadLeaseKey, signLease, verifyLease, AUDIENCE };
