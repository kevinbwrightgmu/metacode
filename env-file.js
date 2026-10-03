// ── .env loading ──────────────────────────────────────────────────────────────
// Reads MetaCode's settings file (.env) into process.env, robustly:
//   • found next to server.js, in the folder the server was started from, or
//     in the folder above (in that order);
//   • ".env.txt" (Windows often adds .txt) and "env" are accepted too;
//   • files saved as UTF-16 (Windows Notepad "Unicode") or with a byte-order
//     mark are decoded correctly — plain dotenv would read nothing from them;
//   • values in .env win over variables of the same name already set in the
//     system environment (a stale, empty or old system variable is the most
//     common reason a key "doesn't load"); each such case is reported;
//   • it can be reloaded while the server runs.
// It reports what it did (file, encoding, the NAMES of the settings it set,
// warnings) but never the values.
//
// METACODE_ENV_FILE=<path> reads that file instead; METACODE_ENV_FILE=none
// reads no file (used by the tests so a developer's own .env isn't used).

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const NAMES = ['.env', '.env.txt', 'env'];

function candidates(appDir) {
  const dirs = [
    { dir: appDir, where: 'the MetaCode folder' },
    { dir: process.cwd(), where: 'the folder MetaCode was started from' },
    { dir: path.dirname(appDir), where: 'the folder above MetaCode' }
  ];
  const seen = new Set();
  const out = [];
  dirs.forEach(d => {
    const key = path.resolve(d.dir);
    if (seen.has(key)) return;
    seen.add(key);
    NAMES.forEach(name => out.push({ file: path.join(key, name), name, where: d.where }));
  });
  return out;
}

// → { text, encoding }
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: buf.slice(2).toString('utf16le'), encoding: 'UTF-16 LE' };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'UTF-16 BE' };
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { text: buf.slice(3).toString('utf8'), encoding: 'UTF-8 with BOM' };
  // UTF-16 without a byte-order mark: every other byte is 0 for ASCII text
  let zerosOdd = 0, zerosEven = 0;
  const n = Math.min(buf.length, 400);
  for (let i = 0; i < n; i++) if (buf[i] === 0) { if (i % 2) zerosOdd++; else zerosEven++; }
  if (n > 8 && zerosOdd > n / 4) return { text: buf.toString('utf16le'), encoding: 'UTF-16 LE' };
  if (n > 8 && zerosEven > n / 4) { const s = Buffer.from(buf.slice(0, buf.length - (buf.length % 2))); s.swap16(); return { text: s.toString('utf16le'), encoding: 'UTF-16 BE' }; }
  return { text: buf.toString('utf8'), encoding: 'UTF-8' };
}

function createEnvLoader(appDir) {
  let lastKeys = [];           // names this loader put into process.env last time
  let info = null;

  function load() {
    const warnings = [];
    let pick = null;
    const explicit = process.env.METACODE_ENV_FILE;
    if (explicit !== undefined && explicit !== '') {
      if (explicit === 'none') pick = null;
      else pick = { file: path.resolve(explicit), name: path.basename(explicit), where: 'METACODE_ENV_FILE' };
    } else {
      pick = candidates(appDir).find(c => { try { return fs.statSync(c.file).isFile(); } catch (e) { return false; } }) || null;
    }
    // Forget what the previous load set (a key removed from .env stops applying)
    lastKeys.forEach(k => { delete process.env[k]; });
    lastKeys = [];
    if (!pick || (explicit === 'none')) {
      info = { found: false, disabled: explicit === 'none', searched: explicit === 'none' ? [] : candidates(appDir).filter(c => c.name === '.env').map(c => c.where), keys: [], overridden: [], warnings, loadedAt: new Date().toISOString() };
      return info;
    }
    let parsed = {};
    let encoding = null;
    try {
      const d = decode(fs.readFileSync(pick.file));
      encoding = d.encoding;
      parsed = dotenv.parse(d.text);
    } catch (e) {
      info = { found: true, file: pick.file, name: pick.name, where: pick.where, error: 'Couldn\'t read the file (' + (e.code || e.message) + ').', keys: [], overridden: [], warnings, loadedAt: new Date().toISOString() };
      return info;
    }
    if (pick.name !== '.env' && pick.where !== 'METACODE_ENV_FILE') warnings.push('The settings file is named "' + pick.name + '". It was read anyway; renaming it to ".env" is recommended.');
    if (pick.where !== 'the MetaCode folder' && pick.where !== 'METACODE_ENV_FILE') warnings.push('The settings file was found in ' + pick.where + ', not next to server.js. It was read anyway.');
    if (/UTF-16/.test(encoding)) warnings.push('The file is saved as ' + encoding + ' (Notepad "Unicode"). It was read anyway; saving it as UTF-8 is recommended.');
    const overridden = [];
    const keys = [];
    Object.keys(parsed).forEach(rawKey => {
      const key = rawKey.replace(/^﻿/, '').trim();
      if (!key) return;
      const value = String(parsed[rawKey]).replace(/^﻿/, '').trim();
      const before = process.env[key];
      if (before !== undefined && before !== '' && before !== value) overridden.push(key);
      process.env[key] = value;
      keys.push(key);
    });
    lastKeys = keys.slice();
    if (!keys.length) warnings.push('The file was found but no settings could be read from it. Each line should look like EMIS_API_KEY=your-key.');
    info = { found: true, file: pick.file, name: pick.name, where: pick.where, encoding, keys, overridden, warnings, loadedAt: new Date().toISOString() };
    return info;
  }

  return { load, get info() { return info; } };
}

module.exports = { createEnvLoader, decode };
