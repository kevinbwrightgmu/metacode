// ── Settings shared by MetaCode and its OpenCode service ──────────────────────
// server.js (MetaCode) and opencode/server.mjs (the AI service beside it) both
// need to agree on where the service listens and on its access token. Both read
// them from here, from the same .env:
//
//   OPENCODE_SERVICE_HOST      default 127.0.0.1 (anything that isn't loopback gets a warning)
//   OPENCODE_SERVICE_PORT      default 4097 (OpenCode's own `opencode serve` uses 4096)
//   OPENCODE_SERVICE_DATA_DIR  default <repo>/opencode-data (token file, catalog cache)
//   OPENCODE_SERVICE_TOKEN     optional; without it a random token is kept in <dataDir>/token
//
// CommonJS on purpose: server.js require()s it, the service import()s it.
// Never logs or returns anything but the token itself (and only to the caller).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4097;            // OpenCode's own `opencode serve` default is 4096; one up avoids a clash on a dev machine
const TOKEN_FILE = 'token';

const isOff = value => /^(off|none|false|0|no|disabled)$/i.test(String(value == null ? '' : value).trim());
const isOn = value => /^(on|true|1|yes|enabled)$/i.test(String(value == null ? '' : value).trim());

// A usable token: at least 16 visible ASCII characters, no spaces
const validToken = t => typeof t === 'string' && t.length >= 16 && /^[\x21-\x7E]+$/.test(t);

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

// host as it goes into a URL: 0.0.0.0 / :: are reached on loopback; IPv6 in brackets
function urlHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  if (h === '0.0.0.0') return '127.0.0.1';
  if (h === '::') return '[::1]';
  return h.includes(':') ? '[' + h + ']' : h;
}

// → { host, port, url, origin, dataDir, tokenFromEnv, problems: [], warnings: [] }
//   url is the service's API base (…/v1); origin is the same without /v1 (GET /health lives there)
function serviceSettings(env) {
  env = env || process.env;
  const problems = [];
  const warnings = [];

  let host = String(env.OPENCODE_SERVICE_HOST || '').trim();
  if (!host) host = DEFAULT_HOST;
  else if (!/^(?:[A-Za-z0-9.-]+|\[?[0-9A-Fa-f:.]+\]?)$/.test(host)) {
    problems.push('OPENCODE_SERVICE_HOST "' + host.slice(0, 60) + '" isn\'t a host name or IP address. Remove it (the default is ' + DEFAULT_HOST + ').');
    host = DEFAULT_HOST;
  } else {
    host = host.replace(/^\[|\]$/g, '');
    if (!isLoopback(host)) warnings.push('OPENCODE_SERVICE_HOST is ' + host + ', so the AI service can be reached from other machines. Keep it on ' + DEFAULT_HOST + ' unless you really need that, and keep its port behind a firewall.');
  }

  let port = DEFAULT_PORT;
  const rawPort = String(env.OPENCODE_SERVICE_PORT || '').trim();
  if (rawPort) {
    const n = Number(rawPort);
    if (/^\d+$/.test(rawPort) && n >= 1 && n <= 65535) port = n;
    else warnings.push('OPENCODE_SERVICE_PORT "' + rawPort.slice(0, 20) + '" isn\'t a port number (1–65535); ' + DEFAULT_PORT + ' is used.');
  }

  const rawDir = String(env.OPENCODE_SERVICE_DATA_DIR || '').trim();
  const dataDir = rawDir ? path.resolve(REPO_DIR, rawDir) : path.join(REPO_DIR, 'opencode-data');

  let tokenFromEnv = null;
  const rawToken = String(env.OPENCODE_SERVICE_TOKEN || '').trim();
  if (rawToken) {
    if (validToken(rawToken)) tokenFromEnv = rawToken;
    else warnings.push('OPENCODE_SERVICE_TOKEN is ignored: it needs at least 16 characters, without spaces or unusual characters. The token in ' + path.join(dataDir, TOKEN_FILE) + ' is used instead.');
  }

  const origin = 'http://' + urlHost(host) + ':' + port;
  return { host, port, url: origin + '/v1', origin, dataDir, tokenFromEnv, problems, warnings };
}

const tokenPath = dataDir => path.join(dataDir, TOKEN_FILE);

// The token in the file, or null (missing, empty or not a usable token)
function readTokenFile(file) {
  try { const t = fs.readFileSync(file, 'utf8').trim(); return validToken(t) ? t : null; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait available: retry at once */ }
}

// The access token both sides use: the env token wins; else <dataDir>/token,
// created (32 random bytes, hex, readable by this user only) when it's missing.
// MetaCode and the service may start at the same moment: the file is created
// with 'wx' so only one of them writes it, and the other reads the winner's.
function readOrCreateToken(dataDir, tokenFromEnv) {
  if (tokenFromEnv) return tokenFromEnv;
  const file = tokenPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 40; attempt++) {
    const existing = readTokenFile(file);
    if (existing) return existing;
    let fd = null;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Being written by the other side right now — or left empty/broken long ago: replace that one
      let stale = false;
      try { stale = Date.now() - fs.statSync(file).mtimeMs > 2000; } catch (e2) { /* just removed: try again */ }
      if (stale) { try { fs.unlinkSync(file); } catch (e2) { /* someone else did */ } }
      else pause(50);
      continue;
    }
    const token = crypto.randomBytes(32).toString('hex');
    try { fs.writeSync(fd, token + '\n'); } finally { fs.closeSync(fd); }
    return token;
  }
  throw new Error('Couldn\'t read or create the AI service\'s token file (' + file + ').');
}

// Which MetaCode copy a service belongs to, without saying anything secret: the
// first 16 hex of sha256(the data folder's full path). GET /health answers it as
// "home", so a MetaCode can tell its own service from another copy's on the same port.
const homeId = dataDir => crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);

module.exports = { REPO_DIR, DEFAULT_HOST, DEFAULT_PORT, serviceSettings, readOrCreateToken, readTokenFile, tokenPath, validToken, homeId, isOff, isOn, isLoopback };
