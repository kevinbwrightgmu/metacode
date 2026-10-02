// ── Reddit API credentials saved from the Scraper page ────────────────────────
// So nobody has to edit .env: the Scraper page's "Reddit API access" form
// saves a Reddit app's client ID/secret (and the username for the
// User-Agent Reddit asks for) to a local file next to server.js, readable only
// by this user (mode 600) and git-ignored. Values in .env always take
// precedence. The secret is never sent back to the browser, logged, or given
// to custom scraper code.

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

function save(file, creds) {
  const data = JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret, username: creds.username || null,
    savedAt: new Date().toISOString() }, null, 2) + '\n';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* e.g. Windows */ }
}

function remove(file) {
  try { fs.unlinkSync(file); return true; } catch (e) { return false; }
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

function saveRedditApisKey(file, key) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ key, savedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* e.g. Windows */ }
}

function validateRedditApisKey(raw) {
  const key = String(raw || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/^Bearer/i, '');
  if (!RAPI_KEY_RE.test(key)) throw new Error('Paste the API key from redditapis.com → Dashboard → API keys.');
  return key;
}

function userAgentFor(username) {
  return 'nodejs:metacode-reddit-scraper:1.0' + (username ? ' (by /u/' + username + ')' : ' (self-hosted research tool)');
}

module.exports = { credentialsFile, loadSaved, save, remove, validate, userAgentFor,
  redditApisKeyFile, loadRedditApisKey, saveRedditApisKey, validateRedditApisKey };
