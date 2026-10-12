/* ══════════════════════════════════════════════
   cloud-sync.js — your work, saved to your account

   When you're signed in (account.js), what MetaCode keeps in this browser is
   also kept in your account, in the Supabase table metacode_data
   (supabase/migrations/…_metacode_accounts.sql), so it's there on any device:

     kind 'workspace'  the open project (localStorage strata_v1)
     kind 'projects'   saved projects        (LocalDB store 'projects')
     kind 'surveys'    Survey Studio drafts  (LocalDB store 'surveys')
     kind 'meta'       the Survey Studio library and other small things

   The browser stays the working copy: every change is saved locally first,
   then sent to your account a few seconds later (and retried while offline).
   Changes made on other devices are fetched when the page opens, when you come
   back to it, and every minute. If the open project changed on both devices,
   yours stays open and the other version is kept as a saved project.

   Row Level Security in Supabase lets each account read and write only its
   own rows. API keys typed into MetaCode are never part of what's synced.
   ══════════════════════════════════════════════ */
const CloudSync = (() => {
  'use strict';
  const TABLE = 'metacode_data';
  const KINDS = ['projects', 'surveys', 'meta'];
  const WS_KEY = 'strata_v1';
  const STATE_KEY = 'metacode_sync';
  const MAX_BYTES = 24 * 1024 * 1024;
  const BATCH_BYTES = 4 * 1024 * 1024;

  let user = null;         // the account this browser syncs with right now
  let st = null;           // { user, lastPull, wsHash, pending: { 'kind/id': { kind, id, op, v } } }
  let busy = false, again = false, timer = null, pullTimer = null, backoff = 0;
  let status = { state: 'off', lastSync: null, error: null, pending: 0 };
  let seq = 0;

  const raw = { put: LocalDB.put, del: LocalDB.del };
  const client = () => (window.Account && Account.client()) || null;
  // app.js declares `const App` (not a window property); studio-shell.js sets window.App
  const app = () => (typeof App !== 'undefined' ? App : window.App) || null;

  /* ── Local bookkeeping ─────────────────────── */
  function load() { try { const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); return s && typeof s === 'object' ? s : null; } catch (e) { return null; } }
  function save() { try { localStorage.setItem(STATE_KEY, JSON.stringify(st)); } catch (e) { /* storage full: the queue lives on in memory */ } }
  function setStatus(state, extra) {
    status = Object.assign({}, status, { state, pending: st ? Object.keys(st.pending || {}).length : 0 }, extra || {});
    try { document.dispatchEvent(new CustomEvent('metacode:sync-status', { detail: status })); } catch (e) { /* old browser */ }
  }
  // FNV-1a — enough to tell whether the open project changed since it was last synced
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + ':' + str.length;
  }
  const wsString = () => { try { return localStorage.getItem(WS_KEY); } catch (e) { return null; } };
  // A workspace with nothing in it (a fresh browser's default project)
  function isEmptyWs(str) {
    if (!str) return true;
    try { const s = JSON.parse(str); return !(s && ((Array.isArray(s.posts) && s.posts.length) || (Array.isArray(s.codebook) && s.codebook.length) || (s.network && Array.isArray(s.network.edges) && s.network.edges.length))); } catch (e) { return true; }
  }

  function queue(kind, id, op) {
    if (!user || !st) return;
    st.pending[kind + '/' + id] = { kind, id, op, v: ++seq };
    save();
    schedule(3000);
  }

  // Every LocalDB write to a synced store is also queued for the account
  LocalDB.put = (store, rec) => raw.put(store, rec).then(v => { if (KINDS.includes(store) && rec && typeof rec.id === 'string') queue(store, rec.id, 'put'); return v; });
  LocalDB.del = (store, id) => raw.del(store, id).then(v => { if (KINDS.includes(store)) queue(store, id, 'del'); return v; });

  // A restored backup (Settings → Your data) is queued as a whole
  const rawImport = LocalDB.importAll;
  LocalDB.importAll = async (backup, opts) => {
    const r = await rawImport(backup, opts);
    if (user && st) { for (const k of KINDS) for (const rec of await LocalDB.all(k)) queue(k, rec.id, 'put'); checkWorkspace(); }
    return r;
  };

  // Is the open project different from what the account has? (hashing waits until edits pause)
  function checkWorkspace() {
    if (!user || !st) return;
    const s = wsString();
    if (s && hash(s) !== st.wsHash) queue('workspace', 'current', 'put');
  }
  let wsTimer = null;
  // app.js and studio-shell.js call this after saving the open project
  function noteWorkspace() {
    if (!user) return;
    clearTimeout(wsTimer);
    wsTimer = setTimeout(checkWorkspace, 2000);
  }

  function schedule(ms) {
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, ms);
  }

  /* ── Talking to Supabase ───────────────────── */
  async function push() {
    const sb = client();
    const items = Object.values(st.pending);
    let batch = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch.map(b => b.row);
      const { error } = await sb.from(TABLE).upsert(rows, { onConflict: 'user_id,kind,id' });
      if (error) throw new Error(error.message || 'Saving to your account failed');
      batch.forEach(b => {
        const k = b.item.kind + '/' + b.item.id;
        if (st.pending[k] && st.pending[k].v === b.item.v) delete st.pending[k];
        if (b.wsHash) st.wsHash = b.wsHash;
      });
      save();
      batch = []; bytes = 0;
    };
    for (const item of items) {
      let data = null, deleted = item.op === 'del', wsHashNow = null;
      if (!deleted) {
        if (item.kind === 'workspace') {
          const s = wsString();
          if (s) { try { data = JSON.parse(s); wsHashNow = hash(s); } catch (e) { data = null; } }
        } else data = await LocalDB.get(item.kind, item.id);
        if (!data) deleted = true;
      }
      const row = { user_id: user, kind: item.kind, id: item.id, data: deleted ? null : data, deleted };
      const size = deleted ? 100 : JSON.stringify(data).length;
      if (size > MAX_BYTES) {
        delete st.pending[item.kind + '/' + item.id];
        save();
        notify('“' + ((data && (data.name || data.title || (data.project && data.project.name))) || item.id) + '” is too large to save to your account (over 24 MB). It\'s kept in this browser.', 'warning', 8000);
        continue;
      }
      if (bytes + size > BATCH_BYTES) await flush();
      batch.push({ item, row, wsHash: wsHashNow });
      bytes += size;
    }
    await flush();
  }

  async function pull() {
    const sb = client();
    const changed = new Set();
    for (let round = 0; round < 50; round++) {
      let q = sb.from(TABLE).select('kind,id,deleted,updated_at').order('updated_at', { ascending: true }).limit(500);
      if (st.lastPull) q = q.gt('updated_at', st.lastPull);
      const { data: heads, error } = await q;
      if (error) throw new Error(error.message || 'Reading your account failed');
      if (!heads || !heads.length) break;
      const want = {};
      for (const h of heads) {
        const key = h.kind + '/' + h.id;
        if (st.pending[key]) continue;                      // changed here too: this browser's version is sent next
        if (h.kind === 'workspace') { if (!h.deleted) await pullWorkspace(); changed.add('workspace'); continue; }
        if (!KINDS.includes(h.kind)) continue;
        if (h.deleted) { await raw.del(h.kind, h.id); changed.add(h.kind); continue; }
        (want[h.kind] = want[h.kind] || []).push(h.id);
      }
      for (const kind of Object.keys(want)) {
        for (let i = 0; i < want[kind].length; i += 20) {
          const ids = want[kind].slice(i, i + 20);
          const { data, error: e2 } = await sb.from(TABLE).select('kind,id,data').eq('kind', kind).in('id', ids);
          if (e2) throw new Error(e2.message || 'Reading your account failed');
          for (const r of data || []) {
            if (r.data && typeof r.data === 'object' && !st.pending[kind + '/' + r.id]) { await raw.put(kind, Object.assign({}, r.data, { id: r.id })); changed.add(kind); }
          }
        }
      }
      st.lastPull = heads[heads.length - 1].updated_at;
      save();
      if (heads.length < 500) break;
    }
    if (changed.size) {
      try { document.dispatchEvent(new CustomEvent('metacode:synced', { detail: { kinds: Array.from(changed) } })); } catch (e) { /* old browser */ }
    }
  }

  async function pullWorkspace() {
    const { data, error } = await client().from(TABLE).select('data').eq('kind', 'workspace').eq('id', 'current').limit(1);
    if (error) throw new Error(error.message || 'Reading your account failed');
    const remote = data && data[0] && data[0].data;
    if (!remote || typeof remote !== 'object') return;
    const remoteStr = JSON.stringify(remote);
    const local = wsString();
    if (local && hash(local) === hash(remoteStr)) { st.wsHash = hash(local); return; }
    if (!local || isEmptyWs(local) || hash(local) === st.wsHash) {
      // Unchanged here since the last sync: take the other device's version
      try { localStorage.setItem(WS_KEY, remoteStr); } catch (e) { notify('Your open project changed on another device but is too large for this browser\'s storage.', 'warning', 8000); return; }
      st.wsHash = hash(remoteStr);
      save();
      if (app() && typeof app().reloadState === 'function') app().reloadState();
      return;
    }
    keepAsProject(remote, ' (from another device)', 'this version of the open project was changed on another device at the same time as this browser');
  }

  // Keeps another version of the open project as a saved project (Projects page)
  async function keepAsProject(remote, suffix, why) {
    if (isEmptyWs(JSON.stringify(remote))) return;
    const now = new Date().toISOString();
    const name = ((remote.project && remote.project.name) || 'Untitled Project') + suffix;
    const rec = { id: 'pr_sync' + Date.now().toString(36), name: name.slice(0, 300), description: 'Saved automatically: ' + why + '.', createdAt: now, savedAt: now, revision: 1, data: remote };
    await LocalDB.put('projects', rec);
    queue('workspace', 'current', 'put');
    notify('Another version of your open project is saved under Projects as “' + name + '”.', 'warning', 10000);
  }

  // First sync of a browser whose work was just added to an account that already
  // has an open project: keep the account's version as a saved project before
  // this browser's version replaces it.
  async function firstLink() {
    const { data, error } = await client().from(TABLE).select('data').eq('kind', 'workspace').eq('id', 'current').limit(1);
    if (error) throw new Error(error.message || 'Reading your account failed');
    const remote = data && data[0] && data[0].data;
    const local = wsString();
    if (remote && typeof remote === 'object' && local && hash(local) !== hash(JSON.stringify(remote))) {
      await keepAsProject(remote, ' (saved in your account)', 'this was the open project in your account when this browser\'s work was added to it');
    }
    st.firstLink = false;
    save();
  }

  async function syncNow() {
    if (!user || !client()) return;
    if (busy) { again = true; return; }
    busy = true;
    clearTimeout(timer);
    setStatus('syncing');
    try {
      if (st.firstLink) await firstLink();
      checkWorkspace();
      await push();
      await pull();
      if (Object.keys(st.pending).length) await push();
      backoff = 0;
      setStatus('idle', { lastSync: new Date().toISOString(), error: null });
    } catch (e) {
      backoff = Math.min(300000, backoff ? backoff * 2 : 5000);
      setStatus(navigator.onLine === false ? 'offline' : 'error', { error: String(e && e.message || e).slice(0, 200) });
      schedule(backoff);
    } finally {
      busy = false;
      if (again) { again = false; schedule(500); }
    }
  }

  /* ── Signing in and out ────────────────────── */
  async function localCounts() {
    const out = { projects: 0, surveys: 0, meta: 0, workspace: false };
    for (const k of KINDS) out[k] = (await LocalDB.all(k)).length;
    try { const s = JSON.parse(wsString() || 'null'); out.workspace = !!(s && ((s.posts && s.posts.length) || (s.codebook && s.codebook.length))); } catch (e) { out.workspace = false; }
    return out;
  }
  async function clearLocal() {
    for (const k of KINDS) for (const r of await LocalDB.all(k)) await raw.del(k, r.id);
    try { localStorage.removeItem(WS_KEY); } catch (e) { /* ignore */ }
  }
  function ask(title, html, buttons) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'acct-overlay';
      wrap.innerHTML = '<div class="acct-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cs-title"><div class="acct-d-head"><h2 id="cs-title">' + title + '</h2></div><div class="acct-d-body">' + html +
        '<div class="acct-row">' + buttons.map((b, i) => '<button type="button" class="' + (i === 0 ? 'acct-primary' : 'acct-secondary') + '" data-i="' + i + '">' + b.label + '</button>').join('') + '</div></div></div>';
      document.body.appendChild(wrap);
      wrap.querySelectorAll('[data-i]').forEach(b => { b.onclick = () => { wrap.remove(); resolve(buttons[Number(b.dataset.i)].value); }; });
      setTimeout(() => { const f = wrap.querySelector('[data-i="0"]'); if (f) f.focus(); }, 30);
    });
  }
  function notify(msg, type, ms) { if (app() && app().notify) app().notify(msg, type, ms); }

  async function onAccount(me) {
    const id = me && me.signedIn && me.user ? me.user.id : null;
    if (id === user) return;
    if (!id) { user = null; clearTimeout(timer); clearInterval(pullTimer); setStatus('off'); return; }
    if (!client()) return;
    st = load();
    if (st && st.user && st.user !== id) {
      // This browser still holds another account's work (it signed out without removing it)
      const choice = await ask('This browser has another account\'s work',
        '<p>The projects and surveys in this browser belong to a different MetaCode account. They\'re saved in that account' + (Object.keys(st.pending || {}).length ? ', except ' + Object.keys(st.pending).length + ' recent change(s) that didn\'t reach it yet' : '') + '.</p><p>Remove them from this browser to continue with ' + escHtml(me.user.email) + '?</p>',
        [{ label: 'Remove and continue', value: 'clear' }, { label: 'Sign out instead', value: 'out' }]);
      if (choice === 'out') { st = null; Account.signOut(); return; }
      await clearLocal();
      st = null;
    }
    if (!st || !st.user) {
      const n = await localCounts();
      const total = n.projects + n.surveys + (n.workspace ? 1 : 0);
      let add = true;
      if (total) {
        const parts = [];
        if (n.workspace) parts.push('the open project');
        if (n.projects) parts.push(n.projects + ' saved project' + (n.projects === 1 ? '' : 's'));
        if (n.surveys) parts.push(n.surveys + ' survey' + (n.surveys === 1 ? '' : 's'));
        add = await ask('Add this browser\'s work to your account?',
          '<p>This browser has ' + escHtml(parts.join(', ').replace(/, ([^,]*)$/, ' and $1')) + ' that aren\'t in your account yet. Add them, so they\'re saved to your account and on your other devices?</p>',
          [{ label: 'Add to my account', value: true }, { label: 'Remove from this browser', value: false }]);
        if (!add) await clearLocal();
      }
      st = { user: id, lastPull: null, wsHash: null, pending: {} };
      if (add) {
        for (const k of KINDS) for (const r of await LocalDB.all(k)) st.pending[k + '/' + r.id] = { kind: k, id: r.id, op: 'put', v: ++seq };
        if (n.workspace) { st.pending['workspace/current'] = { kind: 'workspace', id: 'current', op: 'put', v: ++seq }; st.firstLink = true; }
        // …and what this browser published (surveys, responses) moves to the account on the server
        try { await fetch('/api/account/claim', { method: 'POST' }); } catch (e) { /* tried again next sign-in */ }
      }
      save();
    }
    user = id;
    await syncNow();
    clearInterval(pullTimer);
    pullTimer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  }
  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Before signing out: send what's waiting, then (by default) remove this account's work from the browser.
  async function beforeSignOut() {
    if (!user) return true;
    checkWorkspace();
    await syncNow();
    const waiting = Object.keys((st && st.pending) || {}).length;
    const choice = await ask('Sign out',
      (waiting ? '<p class="acct-warn">' + waiting + ' change(s) couldn\'t be saved to your account yet (' + escHtml(status.error || 'offline') + '). If you remove them from this browser now, they\'ll be lost.</p>' : '<p>Everything is saved to your account.</p>') +
      '<p>Remove your projects and surveys from this browser? (Recommended on a shared computer — they stay in your account.)</p>',
      [{ label: waiting ? 'Keep them here and sign out' : 'Remove from this browser and sign out', value: waiting ? 'keep' : 'clear' },
        { label: waiting ? 'Remove anyway and sign out' : 'Keep them here and sign out', value: waiting ? 'clear' : 'keep' },
        { label: 'Cancel', value: 'cancel' }]);
    if (choice === 'cancel') return false;
    clearTimeout(timer); clearInterval(pullTimer);
    if (choice === 'clear') { await clearLocal(); try { localStorage.removeItem(STATE_KEY); } catch (e) { /* ignore */ } }
    user = null;
    return true;
  }

  if (window.Account) Account.onChange(me => { onAccount(me).catch(e => console.error('[sync]', e)); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); else if (user) { checkWorkspace(); if (st && Object.keys(st.pending).length) syncNow(); } });
  window.addEventListener('online', () => syncNow());

  return { syncNow, noteWorkspace, beforeSignOut, status: () => status, _hash: hash };
})();
window.CloudSync = CloudSync;
