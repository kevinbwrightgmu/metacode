/* ══════════════════════════════════════════════
   local-db.js — your data, kept in this browser

   MetaCode keeps each person's work in their own browser, so people who use
   the same MetaCode server never see each other's projects or surveys:

   • LocalDB.get / put / del / all — records in the browser's IndexedDB
     (the browser storage meant for larger data; localStorage is used
     instead when IndexedDB isn't available, e.g. some private windows).
     Stores: 'projects' (saved projects), 'surveys' (Survey Studio drafts),
     'meta' (the Survey Studio library and other small things).
   • LocalDB.owner() — a random secret that identifies this browser. It is
     kept in localStorage and copied into the mc_owner cookie, so the server
     can tell which published surveys, responses and scraper jobs are yours
     (only what has to live on the server is there: a published survey's
     public copy and its responses, and running scraper jobs).
   • LocalDB.exportAll() / importAll() — a backup file of everything, to move
     your work to another browser or computer.
   ══════════════════════════════════════════════ */
const LocalDB = (() => {
  'use strict';
  const DB_NAME = 'metacode';
  const STORES = ['projects', 'surveys', 'meta'];
  const OWNER_KEY = 'metacode_owner';
  const COOKIE = 'mc_owner';
  const VALID = /^[A-Za-z0-9_-]{32,128}$/;

  /* ── This browser's identity ─────────────── */
  function readCookie() {
    const m = document.cookie.match(/(?:^|;\s*)mc_owner=([^;]+)/);
    return m && VALID.test(m[1]) ? m[1] : null;
  }
  function randomKey() {
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  function writeCookie(key) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = COOKIE + '=' + key + '; Path=/; Max-Age=315360000; SameSite=Strict' + secure;
  }
  let ownerKey = null;
  function owner() {
    if (ownerKey) return ownerKey;
    let key = null;
    try { key = localStorage.getItem(OWNER_KEY); } catch (e) { key = null; }
    if (!key || !VALID.test(key)) key = readCookie() || randomKey();   // a cleared localStorage keeps the cookie's identity
    try { localStorage.setItem(OWNER_KEY, key); } catch (e) { /* blocked: the cookie still works */ }
    if (readCookie() !== key) writeCookie(key);
    ownerKey = key;
    return key;
  }
  // Switches this browser to another identity (restoring a backup made elsewhere).
  function setOwner(key) {
    if (!VALID.test(String(key || ''))) return false;
    ownerKey = key;
    try { localStorage.setItem(OWNER_KEY, key); } catch (e) { /* ignore */ }
    writeCookie(key);
    return true;
  }

  /* ── Storage ──────────────────────────────── */
  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(resolve => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }
  function checkStore(store) { if (!STORES.includes(store)) throw new Error('Unknown store ' + store); }

  // localStorage fallback: one JSON map per store
  const lsKey = store => 'metacode_db_' + store;
  function lsRead(store) { try { return JSON.parse(localStorage.getItem(lsKey(store)) || '{}') || {}; } catch (e) { return {}; } }
  function lsWrite(store, map) {
    try { localStorage.setItem(lsKey(store), JSON.stringify(map)); }
    catch (e) { throw new Error('This browser\'s storage is full. Delete some saved projects or surveys, or download a backup and free up space.'); }
  }

  function run(store, mode, fn) {
    checkStore(store);
    return openDb().then(db => {
      if (!db) return fn(null);
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(store, mode); } catch (e) { reject(e); return; }
        let result;
        const r = fn(tx.objectStore(store));
        if (r) r.onsuccess = () => { result = r.result; };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => {
          const err = tx.error || (r && r.error);
          reject(err && err.name === 'QuotaExceededError'
            ? new Error('This browser\'s storage is full. Delete some saved projects or surveys, or download a backup and free up space.')
            : (err || new Error('The browser couldn\'t save the data.')));
        };
      });
    });
  }
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function get(store, id) {
    return run(store, 'readonly', os => (os ? os.get(id) : (lsRead(store)[id] || null))).then(v => v || null);
  }
  function put(store, rec) {
    if (!rec || typeof rec.id !== 'string') return Promise.reject(new Error('A record needs an id.'));
    const value = clone(rec);
    return run(store, 'readwrite', os => {
      if (os) return os.put(value);
      const m = lsRead(store); m[value.id] = value; lsWrite(store, m); return null;
    }).then(() => value);
  }
  function del(store, id) {
    return run(store, 'readwrite', os => {
      if (os) return os.delete(id);
      const m = lsRead(store); delete m[id]; lsWrite(store, m); return null;
    }).then(() => true);
  }
  function all(store) {
    return run(store, 'readonly', os => (os ? os.getAll() : Object.values(lsRead(store)))).then(v => (Array.isArray(v) ? v : []));
  }
  // Whether IndexedDB is in use (false = localStorage fallback)
  let dbAvailableSync = null;
  openDb().then(db => { dbAvailableSync = !!db; });

  /* ── Backup ───────────────────────────────── */
  const APP_KEYS = ['strata_v1'];
  async function exportAll() {
    const out = { format: 'metacode-backup', version: 1, exportedAt: new Date().toISOString(), owner: owner(), stores: {}, localStorage: {} };
    for (const s of STORES) out.stores[s] = await all(s);
    APP_KEYS.forEach(k => { try { const v = localStorage.getItem(k); if (v !== null) out.localStorage[k] = v; } catch (e) { /* ignore */ } });
    return out;
  }
  // Adds the backup's records to this browser (same ids are replaced) and takes
  // over its identity, so its published surveys and responses stay reachable.
  async function importAll(backup, opts) {
    opts = opts || {};
    if (!backup || backup.format !== 'metacode-backup' || typeof backup.stores !== 'object') throw new Error('That file isn\'t a MetaCode backup.');
    let n = 0;
    for (const s of STORES) {
      const list = Array.isArray(backup.stores[s]) ? backup.stores[s] : [];
      for (const rec of list) { if (rec && typeof rec.id === 'string') { await put(s, rec); n++; } }
    }
    if (opts.openProject !== false && backup.localStorage) {
      APP_KEYS.forEach(k => { if (typeof backup.localStorage[k] === 'string') { try { localStorage.setItem(k, backup.localStorage[k]); } catch (e) { /* too big */ } } });
    }
    if (backup.owner) setOwner(backup.owner);
    return { records: n };
  }

  // Browsers may clear site storage under disk pressure unless asked to keep it.
  function persist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* ignore */ } }

  owner();
  persist();
  return { owner, setOwner, get, put, del, all, exportAll, importAll, usesIndexedDB: () => dbAvailableSync };
})();

window.LocalDB = LocalDB;   // for scripts that look it up on window (survey-store.js)
