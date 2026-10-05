// ── Whose request is this? ────────────────────────────────────────────────────
// Each browser keeps its work locally and has a random secret (public/js/
// local-db.js) that it sends in the mc_owner cookie. The few things that have
// to live on the server — published surveys and their responses, scraper
// jobs — are tagged with a hash of that secret, so each browser only sees and
// manages its own. The secret itself is never stored on the server.

const crypto = require('crypto');

const VALID = /^[A-Za-z0-9_-]{32,128}$/;

function ownerKeyOf(req) {
  const raw = String((req.headers && req.headers.cookie) || '');
  const m = raw.match(/(?:^|;\s*)mc_owner=([^;]+)/);
  const key = m ? m[1].trim() : '';
  return VALID.test(key) ? key : null;
}

// → a stable id for this browser (a hash of its secret), or null
function ownerOf(req) {
  if (req._mcOwner !== undefined) return req._mcOwner;
  const key = ownerKeyOf(req);
  req._mcOwner = key ? crypto.createHash('sha256').update('metacode-owner:' + key).digest('hex').slice(0, 40) : null;
  return req._mcOwner;
}

// Requests from this computer (MetaCode opened as http://localhost): only
// these may import data saved by older versions, which wasn't per-browser.
// A request that came through a proxy (X-Forwarded-For) doesn't count.
function isLoopback(req) {
  if (req.headers && (req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip'])) return false;
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

module.exports = { ownerOf, isLoopback };
