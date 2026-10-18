// @ts-check
// ── What the app keeps between launches, encrypted by the operating system ────
// The account session (refresh token), the last lease from the server and the
// time the app last saw (for the clock check) are kept in one small file,
// encrypted with Electron's safeStorage: the macOS Keychain, Windows DPAPI or
// the Linux Secret Service (GNOME Keyring / KWallet). When the system has no
// such store (safeStorage unavailable, or Linux's "basic_text" fallback that
// isn't real encryption), nothing is written: the app works, but asks for the
// password at each launch and can't open while offline.
//
// Development builds can be started with --insecure-test-store to keep the
// file unencrypted (for automated tests on machines without a keyring). A
// packaged app ignores that switch.
'use strict';
const fs = require('fs');
const path = require('path');

const MAGIC = 'MCSS1';

/**
 * @param {{ file: string, safeStorage: { isEncryptionAvailable: () => boolean, encryptString: (s: string) => Buffer, decryptString: (b: Buffer) => string, getSelectedStorageBackend?: () => string },
 *           platform?: string, insecureTestStore?: boolean }} o
 */
function createSecureStore(o) {
  const platform = o.platform || process.platform;
  /** @type {Record<string, any>} */
  let cache = {};
  let loaded = false;

  function encryption() {
    if (o.insecureTestStore) return 'test';
    try {
      if (!o.safeStorage.isEncryptionAvailable()) return null;
      if (platform === 'linux' && o.safeStorage.getSelectedStorageBackend) {
        const b = o.safeStorage.getSelectedStorageBackend();
        if (b === 'basic_text' || b === 'unknown') return null;
      }
      return 'os';
    } catch (e) { return null; }
  }

  function load() {
    loaded = true;
    cache = {};
    const kind = encryption();
    if (!kind) return cache;
    let buf;
    try { buf = fs.readFileSync(o.file); } catch (e) { return cache; }
    try {
      const head = buf.subarray(0, MAGIC.length + 1).toString('latin1');
      let text;
      if (head === MAGIC + 'T') {
        if (kind !== 'test') throw new Error('test store');
        text = buf.subarray(MAGIC.length + 1).toString('utf8');
      } else if (head === MAGIC + 'E') {
        text = o.safeStorage.decryptString(buf.subarray(MAGIC.length + 1));
      } else throw new Error('unknown');
      const obj = JSON.parse(text);
      cache = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) {
      // unreadable (another user's keychain, damaged, edited): start over
      cache = {};
      try { fs.unlinkSync(o.file); } catch (x) { /* already gone */ }
    }
    return cache;
  }

  function persist() {
    const kind = encryption();
    if (!kind) return false;
    const text = JSON.stringify(cache);
    const body = kind === 'test' ? Buffer.concat([Buffer.from(MAGIC + 'T', 'latin1'), Buffer.from(text, 'utf8')])
      : Buffer.concat([Buffer.from(MAGIC + 'E', 'latin1'), o.safeStorage.encryptString(text)]);
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    const tmp = o.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, o.file);
    return true;
  }

  return {
    /** 'os' (encrypted by the system), 'test' (development switch) or null (nothing is kept) */
    kind: encryption,
    /** @returns {Record<string, any>} */
    get() { if (!loaded) load(); return cache; },
    /** Merges fields (undefined removes one) and writes the file @param {Record<string, any>} patch */
    update(patch) {
      if (!loaded) load();
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete cache[k]; else cache[k] = v; }
      try { return persist(); } catch (e) { return false; }
    },
    clear() { cache = {}; loaded = true; try { fs.unlinkSync(o.file); } catch (e) { /* none */ } }
  };
}

module.exports = { createSecureStore };
