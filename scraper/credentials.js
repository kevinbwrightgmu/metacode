// ── Reddit API keys ───────────────────────────────────────────────────────────
// Two kinds:
//  • The server's own keys, shared by everyone using this MetaCode server:
//    REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (and REDDITAPIS_KEY) in .env, or
//    a file saved by an earlier MetaCode version (reddit-credentials.json,
//    redditapis-key.json), which is still read but can't be changed from the
//    web: on a public server any visitor could have replaced or removed it.
//  • Each user's own keys: the Reddit API scraper page keeps them in that
//    browser and sends them with that browser's jobs, which then run on that
//    user's own Reddit API limit. The server checks them (POST
//    /credentials/check) but never stores them.
// Secrets are never sent back to the browser, logged, or given to custom
// scraper code.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'reddit-credentials.json');
const ID_RE = /^[\x21-\x7E]{4,128}$/;
const SECRET_RE = /^[\x21-\x7E]{4,256}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

function credentialsFile(env) {
  const custom = String((env || process.env).SCRAPER_CREDENTIALS_FILE || '').trim();
  return custom ? path.resolve(custom) : DEFAULT_FILE;
}

// → { clientId, clientSecret, username } or null (missing or unreadable file)
function loadSaved(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  try {
    const j = JSON.parse(raw);
    if (!j || !ID_RE.test(j.clientId || '') || !SECRET_RE.test(j.clientSecret || '')) return null;
    return { clientId: j.clientId, clientSecret: j.clientSecret, username: USERNAME_RE.test(j.username || '') ? j.username : null };
  } catch (e) {
    return null;
  }
}

// Validates form input; throws Error with a user-facing message.
function validate(input) {
  const clientId = String((input && input.clientId) || '').replace(/[\s​-‍﻿]/g, '');
  const clientSecret = String((input && input.clientSecret) || '').replace(/[\s​-‍﻿]/g, '');
  const username = String((input && input.username) || '').trim().replace(/^\/?u\//i, '');
  if (!ID_RE.test(clientId)) throw new Error('Paste the app\'s client ID (the code under the app name at reddit.com/prefs/apps).');
  if (!SECRET_RE.test(clientSecret)) throw new Error('Paste the app\'s secret.');
  if (username && !USERNAME_RE.test(username)) throw new Error('That isn\'t a valid Reddit username.');
  return { clientId, clientSecret, username: username || null };
}

// ── RedditAPIs.com key (third-party engine) ──
const RAPI_FILE = path.join(__dirname, '..', 'redditapis-key.json');
const RAPI_KEY_RE = /^[\x21-\x7E]{8,512}$/;

function redditApisKeyFile(env) {
  const custom = String((env || process.env).SCRAPER_REDDITAPIS_KEY_FILE || '').trim();
  return custom ? path.resolve(custom) : RAPI_FILE;
}

function loadRedditApisKey(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && RAPI_KEY_RE.test(j.key || '') ? j.key : null;
  } catch (e) {
    return null;
  }
}

function validateRedditApisKey(raw) {
  const key = String(raw || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/^Bearer/i, '');
  if (!RAPI_KEY_RE.test(key)) throw new Error('Paste the API key from redditapis.com → Dashboard → API keys.');
  return key;
}

// A short, non-reversible name for a set of keys: what jobs using them share
// (one token, one rate limit), without keeping the secret as a map key.
function keyId(...parts) {
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function userAgentFor(username) {
  return 'nodejs:metacode-reddit-scraper:1.0' + (username ? ' (by /u/' + username + ')' : ' (self-hosted research tool)');
}

module.exports = { credentialsFile, loadSaved, validate, userAgentFor, keyId,
  redditApisKeyFile, loadRedditApisKey, validateRedditApisKey };
