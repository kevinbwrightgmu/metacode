// @ts-check
// ── Structured log lines ──────────────────────────────────────────────────────
// One line per event, written to the console (pm2 keeps it):
//
//   [scraper] request.failed job=1a2b3c4d req=r_8f… provider=direct outcome=timeout ms=20004 retry=1
//
// or, with LOG_FORMAT=json, one JSON object per line for a log collector.
// Values are redacted before they are written: API keys, bearer and basic
// credentials, passwords in URLs, and anything that looks like a secret never
// reach a log. User ids are logged as a short one-way hash (userRef()), never
// as emails. Document contents and prompts are never passed to these helpers.

const crypto = require('crypto');

/** Patterns of secrets that must never be written to a log or sent to a browser. */
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,           // Stripe
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g,                  // OpenAI / Anthropic style
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g,          // Supabase
  /\bwhsec_[A-Za-z0-9]{8,}/g,                                 // Stripe webhook secrets
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,                            // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g,                                    // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,  // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
];

/**
 * Removes credentials from a piece of text.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function redact(value, max) {
  let s = String(value === undefined || value === null ? '' : value);
  s = s.replace(/(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
       .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')   // user:pass@ in URLs
       .replace(/\b(api[_-]?key|apikey|password|passwd|secret|token|access_token|client_secret|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1$2[redacted]');
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]+/g, ' ');
  const limit = max || 500;
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

/**
 * A short, stable, one-way reference to a user id for logs.
 * @param {string | null | undefined} id
 * @returns {string | null}
 */
function userRef(id) {
  if (!id) return null;
  return 'u_' + crypto.createHash('sha256').update('metacode-log:' + id).digest('hex').slice(0, 10);
}

/** @typedef {Record<string, string | number | boolean | null | undefined>} LogFields */

/**
 * @param {string} area      e.g. 'scraper', 'ai-lab'
 * @param {'info' | 'warn' | 'error'} level
 * @param {string} event     e.g. 'request.failed'
 * @param {LogFields} [fields]
 */
function write(area, level, event, fields) {
  if (process.env.METACODE_LOG === 'off') return;
  const clean = /** @type {Record<string, string | number | boolean>} */ ({});
  Object.entries(fields || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    clean[k] = typeof v === 'string' ? redact(v, 300) : v;
  });
  let line;
  if (String(process.env.LOG_FORMAT || '').toLowerCase() === 'json') {
    line = JSON.stringify(Object.assign({ t: new Date().toISOString(), area, level, event }, clean));
  } else {
    const kv = Object.entries(clean).map(([k, v]) => k + '=' + (typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : String(v))).join(' ');
    line = '[' + area + '] ' + event + (kv ? ' ' + kv : '');
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * A logger bound to one area.
 * @param {string} area
 */
function logger(area) {
  return {
    /** @param {string} event @param {LogFields} [fields] */
    info: (event, fields) => write(area, 'info', event, fields),
    /** @param {string} event @param {LogFields} [fields] */
    warn: (event, fields) => write(area, 'warn', event, fields),
    /** @param {string} event @param {LogFields} [fields] */
    error: (event, fields) => write(area, 'error', event, fields)
  };
}

module.exports = { logger, redact, userRef, SECRET_PATTERNS };
