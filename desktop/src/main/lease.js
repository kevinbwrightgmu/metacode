// @ts-check
// ── Checking a lease from the server ──────────────────────────────────────────
// The server (desktop-api/lease.js) signs a short statement — account, plan,
// server, valid until — with its Ed25519 key when it has confirmed that the
// account's plan includes the desktop app. The app keeps the lease so it can
// open without a connection until the lease runs out. Changing any part of it
// (a later expiry, another plan) breaks the signature, so it's refused.
'use strict';
const crypto = require('crypto');

const AUDIENCE = 'metacode-sheets';

/**
 * @param {string} token
 * @param {string} publicKeyB64  SPKI DER, base64
 * @returns {Record<string, any> | null}
 */
function verifyLease(token, publicKeyB64) {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!m || typeof publicKeyB64 !== 'string' || !publicKeyB64) return null;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (pub.asymmetricKeyType !== 'ed25519') return null;
    if (!crypto.verify(null, Buffer.from(m[1]), pub, Buffer.from(m[2], 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (!payload || payload.v !== 1 || payload.aud !== AUDIENCE) return null;
    if (typeof payload.sub !== 'string' || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/** The key id the server uses for a public key @param {string} publicKeyB64 */
const keyId = publicKeyB64 => crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16);

module.exports = { verifyLease, keyId, AUDIENCE };
