/* ══════════════════════════════════════════════
   collab.js — shared projects: invite people and work on a project together

   With accounts on (account.js), the open project can be shared with other
   MetaCode accounts. The MetaCode server keeps the shared copy and decides,
   for every request, who may do what (collab/ on the server):

     owner   edits; invites, removes people and changes roles; deletes it
     editor  edits
     viewer  reads
     (everyone with access can chat)

   • The open project stays the working copy in this browser (app.js). A
     shared project is split into parts — its name and description, each
     post (with its codes), the codebook, the network, the network analysis —
     and the server keeps the revision each part last changed at. About a
     second after a change, the parts that changed are sent with the revision
     they were made from. A part someone else changed in the meantime comes
     back as a conflict and you choose which version to keep: nothing is
     overwritten without you seeing it. Changes made while offline stay in
     this browser and are sent when the server can be reached.
   • Live events from the server (Server-Sent Events): who has the project
     open, changes made by others (fetched at once), chat messages, members
     and roles, and removal or deletion.
   • The Share dialog, the chat panel, "Shared projects" on the Projects page
     and the invitation page (app.html#invite/<token>).
   ══════════════════════════════════════════════ */
const Collab = (() => {
  'use strict';
  const LINK_KEY = 'metacode_shared_link_v1';   // the shared project open in this browser (see linkFrom)
  const INVITE_KEY = 'metacode_pending_invite_v1'; // an invitation opened before signing in (see renderInvite)
  const API = '/api/collab';
  const PUSH_MS = 1000;
  const DELETED = '-';                            // the "hash" of a deleted post
  // Changes go to the server in batches of at most this many bytes (and 1,000 parts); a web server
  // in front of MetaCode may accept little (nginx's default is 1 MB). Sharing a project sends this
  // much at first and the rest the same way.
  const BATCH_BYTES = 512 * 1024;
  const bodyBytes = text => new Blob([text]).size;         // UTF-8 bytes, not characters
  const POST_KEY = /^post:[^\x00-\x1f\x7f]{1,200}$/;
  const DATA_VIEWS = ['codebook', 'ai-coding', 'human-coding', 'reliability', 'network', 'metrics', 'export', 'import'];   // show others' changes on request
  const LIVE_VIEWS = ['dashboard', 'projects'];                                                                           // redrawn at once

  let link = null;           // { id, name, role, owner, revision, revs, hashes, conflicts, chatSeen }
  let me = null;             // { id, email } of the signed-in account (from the event stream)
  let es = null, esFails = 0, esTimer = null;
  let conn = 'off';          // off | connecting | live | reconnecting | offline | signin
  let users = [];            // who has the project open
  let members = [];
  let pushTimer = null, pushFails = 0, pending = 0, invalidKeys = 0;
  let chain = Promise.resolve();
  let applying = false, stale = 0, saving = false;
  const chat = { messages: [], latest: 0, loaded: false, open: false, sending: new Map(), more: true };
  let config = null;

  const esc = s => App.esc(s);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const serial = fn => (chain = chain.then(fn, fn));
  const initials = e => String(e || '?').split('@')[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('') || '?';
  const roleName = r => ({ owner: 'Owner', editor: 'Editor', viewer: 'Viewer' })[r] || r;

  /* ── Server ───────────────────────────────── */
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw Object.assign(new Error('MetaCode\'s server couldn\'t be reached. Check your connection.'), { offline: true }); }
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res.ok) {
      const err = (j && j.error) || {};
      // (a 413 without MetaCode's JSON: a web server in front of it refused the body)
      const text = err.message || (res.status === 413 ? App.tooLargeMessage : 'The server answered ' + res.status + '.');
      throw Object.assign(new Error(text), { status: res.status, type: err.type || (res.status === 413 ? 'too_large' : null), error: err });
    }
    return j;
  }
  async function getConfig() {
    if (config) return config;
    try { config = await call('GET', '/config'); } catch (e) { config = { enabled: false, signedIn: false }; }
    return config;
  }

  /* ── The open project, split into parts ───── */
  // Same normalisation as the server's (collab/store.js), so an unchanged
  // part hashes the same on both sides.
  function entities(s) {
    const m = new Map();
    m.set('meta', { name: str(s.project && s.project.name, 300) || 'Untitled Project', description: str(s.project && s.project.description, 5000) });
    for (const p of s.posts || []) {
      if (!isObj(p) || (typeof p.id !== 'string' && typeof p.id !== 'number')) continue;
      const k = 'post:' + String(p.id);
      if (m.has(k) || !POST_KEY.test(k)) continue;
      m.set(k, typeof p.id === 'string' ? p : Object.assign({}, p, { id: String(p.id) }));
    }
    m.set('codebook', Array.isArray(s.codebook) ? s.codebook.filter(isObj) : []);
    const n = isObj(s.network) ? s.network : {};
    m.set('network', { nodes: Array.isArray(n.nodes) ? n.nodes : [], edges: Array.isArray(n.edges) ? n.edges : [] });
    m.set('networkAnalysis', isObj(s.networkAnalysis) ? s.networkAnalysis : null);
    return m;
  }
  // Each post is shared on its own, under its id: a post without one, with
  // one an earlier post already has (e.g. a CSV whose id column repeats) or
  // with one that can't be a key gets a new id, so no post is left out.
  // → how many posts got one
  function giveIds(s) {
    const seen = new Set();
    let fixed = 0;
    for (const p of s.posts || []) {
      if (!isObj(p)) continue;
      const ok = (typeof p.id === 'string' || typeof p.id === 'number') && p.id !== '' && !seen.has(String(p.id)) && POST_KEY.test('post:' + String(p.id));
      if (!ok) { do { p.id = App.genId(); } while (seen.has(String(p.id))); fixed++; }
      seen.add(String(p.id));
    }
    return fixed;
  }
  function entityOf(data, key) {
    if (key === 'meta') return data.project;
    if (key.startsWith('post:')) { const id = key.slice(5); return (data.posts || []).find(p => String(p.id) === id) || null; }
    return data[key] === undefined ? null : data[key];
  }
  // A 53-bit hash of a part's JSON (cyrb53): enough to tell whether it changed
  function hashOf(v) {
    if (v === null || v === undefined) return DELETED;
    const s = JSON.stringify(v);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  // Puts one part's value into the open project (posts are updated in place,
  // so pages holding a post keep working with the current one)
  function setLocal(s, key, value) {
    if (key === 'meta') { s.project = Object.assign({}, s.project, { name: value.name, description: value.description }); return; }
    if (key.startsWith('post:')) {
      const id = key.slice(5);
      const i = s.posts.findIndex(p => p && String(p.id) === id);
      if (value === null) { if (i !== -1) s.posts.splice(i, 1); }
      else if (i === -1) s.posts.push(value);
      else { const p = s.posts[i]; Object.keys(p).forEach(k => { delete p[k]; }); Object.assign(p, value); }
      return;
    }
    s[key] = value;
  }
  const label = (key, value) => {
    if (key === 'meta') return 'Project name and description';
    if (key === 'codebook') return 'Codebook';
    if (key === 'network') return 'Network';
    if (key === 'networkAnalysis') return 'Network analysis';
    const t = value && (value.title || value.text || value.body || '');
    return 'Post ' + key.slice(5) + (t ? ' — “' + String(t).slice(0, 60) + (String(t).length > 60 ? '…' : '') + '”' : '');
  };

  /* ── The link between this browser and the shared copy ── */
  function readLink() { try { const l = JSON.parse(localStorage.getItem(LINK_KEY) || 'null'); return l && l.id && l.revs ? l : null; } catch (e) { return null; } }
  function saveLink() { try { if (link) localStorage.setItem(LINK_KEY, JSON.stringify(link)); else localStorage.removeItem(LINK_KEY); } catch (e) { /* storage full or blocked */ } }
  function linkFrom(r) {
    const hashes = {};
    Object.keys(r.revs).forEach(k => { hashes[k] = hashOf(entityOf(r.data, k)); });
    return { id: r.project.id, name: r.project.name, role: r.project.role, owner: r.project.owner, revision: r.revision, revs: Object.assign({}, r.revs), hashes, conflicts: [], chatSeen: 0 };
  }
  // The open project is the shared one (another device's workspace, a restored backup or a newly opened project isn't)
  const ownsWorkspace = () => { const s = App.getState(); return !!(link && s.project && s.project.sharedId === link.id); };
  const canEdit = () => !!link && (link.role === 'owner' || link.role === 'editor');
  const active = () => !!link;

  // The open project's data as the server expects it
  function snapshot() {
    const s = App.getState();
    return { project: { name: s.project.name, description: s.project.description || '' }, posts: s.posts, codebook: s.codebook, network: s.network, networkAnalysis: s.networkAnalysis };
  }
  // Links the open project to the shared one it was just shared as (its data stays as it is: what
  // didn't go with the first request is sent as changes)
  function adopt(project) {
    applying = true;
    try { App.setState({ project: Object.assign({}, App.getState().project, { name: project.name, description: project.description, sharedId: link.id }) }); } finally { applying = false; }
    const top = document.getElementById('topbar-project');
    if (top) top.textContent = project.name;
  }

  /* ── Sending changes ──────────────────────── */
  // Called by app.js after every change to the open project
  function noteChange() {
    if (!link || applying) return;
    if (!ownsWorkspace()) { unlinkMismatch(); return; }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(schedulePush, PUSH_MS);
  }
  function schedulePush() { clearTimeout(pushTimer); return serial(push); }
  function changes() {
    const ents = entities(App.getState());
    const blocked = new Set(link.conflicts.map(c => c.key));
    const out = [];
    for (const [k, v] of ents) {
      if (blocked.has(k)) continue;
      const h = hashOf(v);
      if (h !== link.hashes[k]) out.push({ key: k, baseRev: link.revs[k] || 0, value: v, hash: h });
    }
    for (const k of Object.keys(link.hashes)) {
      if (k.startsWith('post:') && !ents.has(k) && link.hashes[k] !== DELETED && !blocked.has(k)) out.push({ key: k, baseRev: link.revs[k] || 0, value: null, hash: DELETED });
    }
    return out;
  }
  async function push() {
    if (!link || !ownsWorkspace()) return;
    // Posts added since (an import, say) may need ids of their own too
    if (canEdit() && giveIds(App.getState())) { applying = true; try { App.save(); } finally { applying = false; } }
    const list = changes();
    pending = list.length;
    if (!list.length || !canEdit()) { renderBar(); return; }
    saving = true; renderBar();
    const conflictsBefore = link.conflicts.length;
    const tooBig = [];
    try {
      const send = async batch => {
        if (!batch.length || !link) return;
        const sent = new Map(batch.map(c => [c.key, c]));
        let r;
        try {
          r = await call('POST', '/projects/' + link.id + '/changes', { changes: batch.map(c => ({ key: c.key, baseRev: c.baseRev, value: c.value })) });
        } catch (e) {
          if (e.status !== 413) throw e;
          // More than the server (or a web server in front of it) accepts at once: halve it, down to single
          // parts; a part too large on its own stays in this browser until it changes again (not sent over and over)
          if (batch.length > 1) { const h = Math.ceil(batch.length / 2); await send(batch.slice(0, h)); await send(batch.slice(h)); return; }
          tooBig.push(batch[0]); link.hashes[batch[0].key] = batch[0].hash; saveLink();
          return;
        }
        if (!link) return;
        r.applied.forEach(k => { link.revs[k] = r.revision; link.hashes[k] = sent.get(k).hash; });
        // nothing else happened in between: no need to fetch our own change back
        if (r.applied.length && r.revision === link.revision + 1) link.revision = r.revision;
        r.conflicts.forEach(c => {
          const theirs = hashOf(c.value);
          if (theirs === sent.get(c.key).hash) { link.revs[c.key] = c.rev; link.hashes[c.key] = theirs; }      // the same change, already there
          else addConflict(c);
        });
        if (r.invalid.length) { invalidKeys += r.invalid.length; r.invalid.forEach(k => { const c = sent.get(k); if (c) link.hashes[k] = c.hash; }); }
        saveLink();
      };
      let batch = [], bytes = 0;
      for (const c of list) {
        const size = bodyBytes(JSON.stringify(c.value === undefined ? null : c.value)) + 64;
        if (batch.length && (bytes + size > BATCH_BYTES || batch.length >= 1000)) { await send(batch); batch = []; bytes = 0; }
        batch.push(c); bytes += size;
      }
      await send(batch);
      pushFails = 0;
      pending = 0;
      if (invalidKeys) { App.notify(invalidKeys + ' change' + (invalidKeys === 1 ? '' : 's') + ' couldn\'t be shared (the server didn\'t accept the data) and stay in this browser only.', 'warning', 7000); invalidKeys = 0; }
      if (tooBig.length) App.notify((tooBig.length === 1 ? label(tooBig[0].key, tooBig[0].value) + ' is' : tooBig.length + ' parts of the project are') +
        ' too large to send to the shared project at once (HTTP 413), so ' + (tooBig.length === 1 ? 'it stays' : 'they stay') + ' in this browser only.', 'warning', 9000);
    } catch (e) {
      if (!link) return;
      if (e.status === 404) { lostAccess('revoked'); return; }
      if (e.status === 403) { await refreshRole(); App.notify(e.message, 'warning', 6000); return; }
      // offline or the server is busy: try again later (changes stay in this browser)
      pushFails++;
      if (pushFails <= 8) { clearTimeout(pushTimer); pushTimer = setTimeout(schedulePush, Math.min(60000, 2000 * 2 ** (pushFails - 1))); }
      if (!e.offline && pushFails === 1 && e.status !== 429) App.notify('Couldn\'t send changes to the shared project: ' + e.message + ' They\'re kept in this browser.', 'warning', 6000);
    } finally {
      saving = false; renderBar();
      if (link && link.conflicts.length > conflictsBefore) { App.notify('Someone else changed the same part of the project. Choose which version to keep.', 'warning', 7000); openConflicts(); }
      else if (link && link.conflicts.length) renderConflictsIfOpen();
    }
  }
  function addConflict(c) {
    const theirsHash = hashOf(c.value);
    const i = link.conflicts.findIndex(x => x.key === c.key);
    const entry = { key: c.key, rev: c.rev, theirs: c.value, theirsHash };
    if (i === -1) link.conflicts.push(entry); else link.conflicts[i] = entry;
  }

  /* ── Getting others' changes ──────────────── */
  function schedulePull(revision) { return serial(async () => { if (!link || (revision !== undefined && revision <= link.revision)) return; await pull(); }); }
  async function pull() {
    if (!link) return;
    if (!ownsWorkspace()) { unlinkMismatch(); return; }
    let r;
    try { r = await call('GET', '/projects/' + link.id + '?since=' + link.revision); } catch (e) {
      if (e.status === 404) lostAccess('revoked');
      return;
    }
    if (!link) return;
    if (r.project) { link.role = r.project.role; link.name = r.project.name; }
    // A full answer (the server's revision went back, e.g. restored from a backup): compare every part
    const list = r.changes || Object.keys(r.revs).map(k => ({ key: k, rev: r.revs[k], value: entityOf(r.data, k) }));
    applyRemote(list, r.order || (r.data ? r.data.posts.map(p => p.id) : null));
    link.revision = r.revision;
    pending = changes().length;
    saveLink();
    renderBar();
  }
  function applyRemote(list, order) {
    const s = App.getState();
    const local = entities(s);
    let applied = 0, conflicted = 0;
    for (const c of list) {
      if (link.revs[c.key] === c.rev && link.hashes[c.key] !== undefined) continue;          // already have it
      const theirs = hashOf(c.value);
      const mine = local.has(c.key) ? hashOf(local.get(c.key)) : DELETED;
      const known = link.hashes[c.key];
      if (mine === theirs) { link.revs[c.key] = c.rev; link.hashes[c.key] = theirs; continue; }
      const changedHere = known === undefined ? mine !== DELETED : mine !== known;
      if (changedHere && canEdit()) { addConflict(c); conflicted++; continue; }
      setLocal(s, c.key, c.value);
      link.revs[c.key] = c.rev; link.hashes[c.key] = theirs;
      applied++;
    }
    if (order && applied) {
      const pos = new Map(order.map((id, i) => [String(id), i]));
      s.posts.sort((a, b) => (pos.has(String(a.id)) ? pos.get(String(a.id)) : 1e9) - (pos.has(String(b.id)) ? pos.get(String(b.id)) : 1e9));
    }
    if (applied) {
      applying = true;
      try { App.setState({}); } finally { applying = false; }
      const top = document.getElementById('topbar-project');
      if (top) top.textContent = s.project.name;
      refreshView();
    }
    if (conflicted) { App.notify(conflicted + ' part' + (conflicted === 1 ? '' : 's') + ' of the project changed here and for someone else. Choose which version to keep.', 'warning', 7000); openConflicts(); }
  }
  // Shows others' changes: at once on overview pages, on request elsewhere
  // (redrawing a page while someone codes or types would lose their place)
  function refreshView() {
    const v = App.getCurrentView().id;
    const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#view-container input, #view-container textarea, #view-container select, #view-container [contenteditable]');
    if (LIVE_VIEWS.includes(v) && !typing) { App.navigate(location.hash.slice(1) || v); stale = 0; }
    else if (DATA_VIEWS.includes(v) || LIVE_VIEWS.includes(v)) stale++;
    renderBar();
  }

  /* ── Conflicts ────────────────────────────── */
  function renderConflictsIfOpen() { if (document.getElementById('cl-conflicts')) openConflicts(); }
  function openConflicts() {
    if (!link || !link.conflicts.length) { if (document.getElementById('cl-conflicts')) App.closeModal(); renderBar(); return; }
    const s = App.getState();
    const local = entities(s);
    const preview = v => { if (v === null || v === undefined) return '<i>deleted</i>'; const j = JSON.stringify(v, null, 1); return esc(j.length > 600 ? j.slice(0, 600) + '…' : j); };
    App.openModal('Choose which version to keep',
      '<div id="cl-conflicts"><p class="form-hint" style="margin-bottom:12px">These parts changed in this browser and, at the same time, for someone else. Nothing has been overwritten. For each one, keep your version (it replaces theirs for everyone) or use theirs (it replaces yours).</p>' +
      link.conflicts.map(c => '<div class="cl-conflict" data-key="' + esc(c.key) + '"><div class="cl-conflict-title">' + esc(label(c.key, c.theirs || local.get(c.key))) + '</div>' +
        '<div class="cl-conflict-cols"><div><div class="cl-conflict-h">Yours</div><pre>' + preview(local.get(c.key)) + '</pre><button class="btn btn-secondary btn-sm" data-pick="mine">Keep mine</button></div>' +
        '<div><div class="cl-conflict-h">Theirs (current)</div><pre>' + preview(c.theirs) + '</pre><button class="btn btn-secondary btn-sm" data-pick="theirs">Use theirs</button></div></div></div>').join('') + '</div>',
      '<button class="btn btn-secondary" id="cl-all-theirs">Use theirs for all</button><button class="btn btn-primary" id="cl-all-mine">Keep mine for all</button>');
    document.getElementById('cl-conflicts').onclick = e => {
      const b = e.target.closest('[data-pick]');
      if (b) resolve([b.closest('[data-key]').dataset.key], b.dataset.pick);
    };
    document.getElementById('cl-all-mine').onclick = () => resolve(link.conflicts.map(c => c.key), 'mine');
    document.getElementById('cl-all-theirs').onclick = () => resolve(link.conflicts.map(c => c.key), 'theirs');
  }
  function resolve(keys, pick) {
    const s = App.getState();
    let changed = false;
    for (const key of keys) {
      const c = link.conflicts.find(x => x.key === key);
      if (!c) continue;
      if (pick === 'theirs') { setLocal(s, key, c.theirs); changed = true; }
      link.revs[key] = c.rev; link.hashes[key] = c.theirsHash;        // mine is then a change made from their version
      link.conflicts = link.conflicts.filter(x => x !== c);
    }
    saveLink();
    if (changed) { applying = true; try { App.setState({}); } finally { applying = false; } refreshView(); }
    schedulePush();
    openConflicts();
  }

  /* ── Live events ──────────────────────────── */
  function connect() {
    if (!link || es) return;
    conn = esFails ? 'reconnecting' : 'connecting';
    renderBar();
    es = new EventSource(API + '/projects/' + encodeURIComponent(link.id) + '/events');
    es.addEventListener('open', () => { esFails = 0; conn = 'live'; renderBar(); });
    es.addEventListener('hello', e => {
      const d = JSON.parse(e.data);
      me = d.you; users = d.users;
      if (link.role !== d.role) { link.role = d.role; saveLink(); }
      conn = 'live';
      if (d.revision > link.revision) schedulePull(d.revision);
      else if (d.revision < link.revision) schedulePull();
      chat.latest = d.chatLatest;
      if (chat.loaded && chat.messages.length && d.chatLatest > lastSeq()) loadChat('after');
      schedulePush();
      renderBar();
    });
    es.addEventListener('presence', e => { users = JSON.parse(e.data).users; renderBar(); });
    es.addEventListener('updated', e => {
      const d = JSON.parse(e.data);
      if (d.name && link) link.name = d.name;
      schedulePull(d.revision);
    });
    es.addEventListener('chat', e => { addMessages([JSON.parse(e.data).message]); });
    es.addEventListener('members', e => {
      members = JSON.parse(e.data).members;
      const mine = me && members.find(m => m.id === me.id);
      if (mine && link && mine.role !== link.role) { link.role = mine.role; saveLink(); App.notify('Your role in “' + link.name + '” is now ' + roleName(mine.role) + '.', 'info', 5000); if (canEdit()) schedulePush(); }
      renderBar();
      if (document.getElementById('cl-share')) openShare();
    });
    es.addEventListener('revoked', () => lostAccess('revoked'));
    es.addEventListener('deleted', () => lostAccess('deleted'));
    es.addEventListener('error', () => {
      if (!es) return;
      if (es.readyState === EventSource.CLOSED) { es.close(); es = null; retryConnect(); }
      else { conn = 'reconnecting'; renderBar(); }                // the browser reconnects by itself
    });
  }
  function disconnect() { clearTimeout(esTimer); if (es) { es.close(); es = null; } conn = 'off'; users = []; }
  // The stream was refused or ended: find out why before trying again
  async function retryConnect() {
    if (!link) return;
    esFails++;
    try { await call('GET', '/projects/' + link.id + '/members'); } catch (e) {
      if (e.status === 404) { lostAccess('revoked'); return; }
      if (e.status === 401) { conn = 'signin'; renderBar(); return; }
      if (e.status === 403 && e.type === 'sharing_unavailable') { conn = 'offline'; renderBar(); return; }
    }
    if (esFails > 12) { conn = 'offline'; renderBar(); return; }        // stop; the Reconnect button starts again
    conn = 'reconnecting'; renderBar();
    clearTimeout(esTimer);
    esTimer = setTimeout(connect, Math.min(60000, 1500 * 2 ** Math.min(esFails, 6)));
  }
  function reconnect() { esFails = 0; disconnect(); connect(); schedulePull(); }

  // Removed from the project, or it was deleted: the copy in this browser stays open, unshared
  function lostAccess(why) {
    if (!link) return;
    const name = link.name;
    disconnect();
    clearTimeout(pushTimer);
    link = null; saveLink();
    const s = App.getState();
    if (s.project && s.project.sharedId) { const p = Object.assign({}, s.project); delete p.sharedId; applying = true; try { App.setState({ project: p }); } finally { applying = false; } }
    closeChat();
    renderBar();
    App.openModal(why === 'deleted' ? 'The shared project was deleted' : 'You no longer have access',
      '<p>' + (why === 'deleted' ? 'The owner deleted the shared project “' + esc(name) + '”.' : 'You were removed from the shared project “' + esc(name) + '”, or it is no longer available.') +
      ' The copy open in this browser stays open, but it isn\'t shared any more. Save it in Projects to keep it.</p>',
      '<button class="btn btn-primary" onclick="App.closeModal()">OK</button>');
    if (App.getCurrentView().id === 'projects') ProjectsView.render();
  }
  function unlinkMismatch() {
    if (!link) return;
    const name = link.name;
    disconnect(); clearTimeout(pushTimer);
    link = null; saveLink(); renderBar();
    App.notify('The open project was replaced, so it\'s no longer connected to the shared project “' + name + '”. Open it again from Projects.', 'warning', 7000);
  }
  async function refreshRole() {
    if (!link) return;
    try { const r = await call('GET', '/projects/' + link.id + '/members'); link.role = r.you.role; members = r.members; saveLink(); } catch (e) { if (e.status === 404) lostAccess('revoked'); }
    renderBar();
  }

  /* ── The bar in the top bar ───────────────── */
  let slot = null;
  function renderBar() {
    if (!slot) return;
    document.body.classList.toggle('cl-shared', !!link);
    if (!link) {
      slot.hidden = !(config && config.enabled);
      slot.innerHTML = config && config.enabled ? '<button type="button" class="cl-btn" id="cl-share-btn" title="Share this project with other MetaCode accounts">' + icon('share') + '<span>Share</span></button>' : '';
      const b = document.getElementById('cl-share-btn');
      if (b) b.onclick = () => openShare();
      return;
    }
    slot.hidden = false;
    const others = users.filter(u => !me || u.id !== me.id);
    const status = saving ? ['saving', 'Saving…'] : conn === 'live' ? (pending && canEdit() ? ['saving', 'Sending…'] : ['live', 'Live']) : conn === 'connecting' ? ['wait', 'Connecting…']
      : conn === 'reconnecting' ? ['wait', 'Reconnecting…'] : conn === 'signin' ? ['off', 'Sign in again'] : ['off', 'Offline'];
    const unread = Math.max(0, chat.latest - (link.chatSeen || 0));
    slot.innerHTML =
      '<span class="cl-status cl-' + status[0] + '" title="' + esc(statusTitle()) + '"><span class="cl-dot"></span>' + esc(status[1]) + '</span>' +
      (conn === 'offline' || conn === 'signin' ? '<button type="button" class="cl-link" id="cl-reconnect">' + (conn === 'signin' ? 'Sign in' : 'Reconnect') + '</button>' : '') +
      '<span class="cl-avatars" title="' + esc(users.length ? 'Open now: ' + users.map(u => u.email).join(', ') : 'Nobody else has it open') + '">' +
        others.slice(0, 4).map(u => '<span class="cl-avatar">' + esc(initials(u.email)) + '</span>').join('') + (others.length > 4 ? '<span class="cl-avatar cl-more">+' + (others.length - 4) + '</span>' : '') + '</span>' +
      (!canEdit() ? '<span class="cl-badge" title="You can read this project and chat, but changes you make here aren\'t shared">View only</span>' : '') +
      (link.conflicts.length ? '<button type="button" class="cl-badge cl-warn" id="cl-conflicts-btn">' + link.conflicts.length + ' to resolve</button>' : '') +
      (stale ? '<button type="button" class="cl-link" id="cl-show">Show others\' changes</button>' : '') +
      '<button type="button" class="cl-btn" id="cl-chat-btn" aria-label="Project chat">' + icon('chat') + '<span>Chat</span>' + (unread ? '<span class="cl-unread">' + (unread > 99 ? '99+' : unread) + '</span>' : '') + '</button>' +
      '<button type="button" class="cl-btn" id="cl-share-btn" title="People with access">' + icon('share') + '<span>' + (link.role === 'owner' ? 'Share' : 'People') + '</span></button>';
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
    on('cl-reconnect', () => { if (conn === 'signin' && window.Account) Account.openSignIn({ reason: 'Sign in again to keep working on “' + link.name + '” with others.' }); else reconnect(); });
    on('cl-conflicts-btn', openConflicts);
    on('cl-show', () => { stale = 0; App.navigate(location.hash.slice(1) || App.getCurrentView().id); renderBar(); });
    on('cl-chat-btn', () => (chat.open ? closeChat() : openChat()));
    on('cl-share-btn', () => openShare());
  }
  function statusTitle() {
    if (!link) return '';
    if (!canEdit()) return 'Shared project — you\'re a viewer. ' + (pending ? pending + ' change' + (pending === 1 ? '' : 's') + ' made here aren\'t shared.' : '');
    if (conn === 'live') return pending ? pending + ' change' + (pending === 1 ? '' : 's') + ' waiting to be sent' : 'Every change is shared';
    return 'Changes are kept in this browser and sent when the server can be reached' + (pending ? ' (' + pending + ' waiting)' : '') + '.';
  }
  function icon(n) {
    return n === 'chat' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>';
  }

  /* ── Sharing a project ────────────────────── */
  async function share() {
    const s = App.getState();
    const fixed = giveIds(s);
    if (fixed) App.save();
    // The first request has the project with as many posts as fit in a batch (a web server in front of
    // MetaCode may accept little); the rest is sent like any change, in batches, right after
    const data = snapshot();
    const first = Object.assign({}, data, { posts: [] });
    let bytes = bodyBytes(JSON.stringify(first));
    if (bytes > BATCH_BYTES) { first.network = { nodes: [], edges: [] }; first.networkAnalysis = null; bytes = bodyBytes(JSON.stringify(first)); }   // (a large network goes on its own)
    for (const p of data.posts || []) {
      const b = bodyBytes(JSON.stringify(p)) + 1;
      if (bytes + b > BATCH_BYTES) break;
      first.posts.push(p); bytes += b;
    }
    const r = await call('POST', '/projects', { name: s.project.name, data: first });
    link = linkFrom(r);
    saveLink();
    if (typeof ProjectsView !== 'undefined') ProjectsView.unlink();   // changes go to the shared project now, not a saved copy
    adopt(r.data.project);
    if (fixed) App.notify(fixed + ' post' + (fixed === 1 ? '' : 's') + ' had no id of its own (missing or repeated) and got a new one, so every post is shared.', 'info', 7000);
    if (r.skipped) App.notify(r.skipped + ' entr' + (r.skipped === 1 ? 'y' : 'ies') + ' in the post list couldn\'t be read and were left out.', 'warning', 8000);
    connect();
    renderBar();
    await schedulePush();                 // what didn't fit in the first request
    return r;
  }
  // Opens a shared project in this browser
  async function open(id) {
    if (link && link.id === id && ownsWorkspace()) { location.hash = '#dashboard'; return; }
    if (!(await ProjectsView.protectCurrent())) return;
    let r;
    try { r = await call('GET', '/projects/' + encodeURIComponent(id)); } catch (e) { App.notify('Couldn\'t open the shared project: ' + e.message, 'error', 6000); return; }
    const data = Object.assign({}, r.data, { project: Object.assign({}, r.data.project, { sharedId: r.project.id }) });
    ProjectsView.loadIntoBrowser(data, null, linkFrom(r));
  }
  // Sends what's waiting before the open project is replaced → true when nothing is left
  async function flush() {
    if (!link || !ownsWorkspace()) return true;
    await schedulePush();
    return !canEdit() || changes().length === 0;
  }
  // ProjectsView.loadIntoBrowser: the open project is being replaced
  function setLink(l) {
    disconnect(); clearTimeout(pushTimer);
    link = l || null;
    saveLink();
  }

  /* ── The Share dialog ─────────────────────── */
  async function openShare() {
    const cfg = await getConfig();
    if (!cfg.enabled) { App.notify('Sharing needs accounts, which aren\'t turned on for this MetaCode server.', 'info', 5000); return; }
    if (window.Account) await Account.ready;          // (clicked just after the page opened: is anyone signed in?)
    if (window.Account && !Account.signedIn()) { Account.openSignIn({ reason: 'Sign in to share projects with other people.' }); return; }
    if (!link) {
      const s = App.getState();
      App.openModal('Share “' + s.project.name + '”',
        '<div id="cl-share"><p>Sharing keeps a copy of this project on the MetaCode server, so the people you invite can open it, work on it with you and chat about it. Changes are shared as they happen.</p>' +
        '<ul class="cl-roles"><li><b>Editors</b> can change the project.</li><li><b>Viewers</b> can read it.</li><li>Everyone can chat. Only you (the owner) can invite people, change roles or delete the shared project.</li></ul>' +
        '<p class="form-hint">' + (s.posts || []).length + ' posts, the codebook and the network are shared. Your AI settings aren\'t.</p><div class="form-error" id="cl-err"></div></div>',
        '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="cl-go">Share this project</button>');
      document.getElementById('cl-go').onclick = async e => {
        e.target.disabled = true; e.target.textContent = 'Sharing…';
        try { await share(); openShare(); if (App.getCurrentView().id === 'projects') ProjectsView.render(); }
        catch (err) { e.target.disabled = false; e.target.textContent = 'Share this project'; document.getElementById('cl-err').textContent = err.message; }
      };
      return;
    }
    let r;
    try { r = await call('GET', '/projects/' + link.id + '/members'); } catch (e) { if (e.status === 404) lostAccess('revoked'); else App.notify(e.message, 'error'); return; }
    members = r.members;
    if (link.role !== r.you.role) { link.role = r.you.role; saveLink(); renderBar(); }
    const owner = r.you.role === 'owner';
    const online = new Set((r.online || []).map(u => u.id));
    const keepResults = document.getElementById('cl-results') ? document.getElementById('cl-results').innerHTML : '';
    App.openModal((owner ? 'Share “' : 'People in “') + link.name + '”',
      '<div id="cl-share">' +
      (owner ? '<div class="cl-invite"><label class="form-label" for="cl-emails">Invite people by email</label>' +
        '<textarea class="form-input" id="cl-emails" rows="2" placeholder="name@example.org, other@example.org"></textarea>' +
        '<div class="cl-invite-row"><select class="form-input" id="cl-role" aria-label="Role"><option value="editor">Editor — can change the project</option><option value="viewer">Viewer — can read it</option></select>' +
        '<button class="btn btn-primary" id="cl-invite-go">Invite</button></div>' +
        '<p class="form-hint">MetaCode doesn\'t send email: you get a link for each person to send them yourself. A link works for 14 days, once, and only for that email address (people without an account create one with that address).</p>' +
        '<div class="form-error" id="cl-err"></div><div id="cl-results">' + keepResults + '</div></div>' : '') +
      '<div class="cl-h">People with access</div><table class="table cl-members"><tbody>' +
      r.members.map(m => '<tr data-id="' + esc(m.id) + '"><td><span class="cl-avatar' + (online.has(m.id) ? ' cl-on' : '') + '" title="' + (online.has(m.id) ? 'Open now' : '') + '">' + esc(initials(m.email)) + '</span> ' + esc(m.email || 'unknown') + (m.id === r.you.id ? ' <span class="text-muted">(you)</span>' : '') + '</td>' +
        '<td>' + (owner && m.role !== 'owner' ? '<select class="form-input cl-role-sel" aria-label="Role of ' + esc(m.email) + '"><option value="editor"' + (m.role === 'editor' ? ' selected' : '') + '>Editor</option><option value="viewer"' + (m.role === 'viewer' ? ' selected' : '') + '>Viewer</option></select>' : esc(roleName(m.role))) + '</td>' +
        '<td style="text-align:right">' + (owner && m.role !== 'owner' ? '<button class="btn btn-ghost btn-sm" data-act="remove" style="color:var(--error)">Remove</button>' : '') + '</td></tr>').join('') +
      '</tbody></table>' +
      (owner && r.invites && r.invites.length ? '<div class="cl-h">Invitations</div><table class="table cl-invites"><tbody>' +
        r.invites.map(i => '<tr data-inv="' + esc(i.id) + '"><td>' + esc(i.email) + '</td><td>' + esc(roleName(i.role)) + '</td><td class="text-muted">' + (i.status === 'expired' ? 'expired' : 'until ' + esc(new Date(i.expiresAt).toLocaleDateString())) + '</td>' +
          '<td style="text-align:right"><button class="btn btn-ghost btn-sm" data-act="revoke">Revoke</button></td></tr>').join('') + '</tbody></table>' : '') +
      '</div>',
      (owner ? '<button class="btn btn-danger" id="cl-delete">Delete shared project…</button>' : '<button class="btn btn-secondary" id="cl-leave">Leave project</button>') +
      '<button class="btn btn-primary" onclick="App.closeModal()">Done</button>');
    const box = document.getElementById('cl-share');
    const go = document.getElementById('cl-invite-go');
    if (go) go.onclick = invite;
    box.addEventListener('change', async e => {
      const sel = e.target.closest('.cl-role-sel');
      if (!sel) return;
      try { await call('PATCH', '/projects/' + link.id + '/members/' + encodeURIComponent(sel.closest('tr').dataset.id), { role: sel.value }); App.notify('Role changed', 'success', 1800); }
      catch (err) { App.notify(err.message, 'error'); openShare(); }
    });
    box.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (b && b.dataset.act === 'remove') {
        const tr = b.closest('tr');
        if (!confirm('Remove ' + tr.querySelector('td').textContent.trim() + ' from the project? They lose access at once.')) return;
        try { await call('DELETE', '/projects/' + link.id + '/members/' + encodeURIComponent(tr.dataset.id)); openShare(); } catch (err) { App.notify(err.message, 'error'); }
      }
      if (b && b.dataset.act === 'revoke') {
        const inv = b.closest('tr').dataset.inv;
        try {
          await call('DELETE', '/projects/' + link.id + '/invites/' + encodeURIComponent(inv));
          document.querySelectorAll('#cl-results [data-inv]').forEach(n => { if (n.dataset.inv === inv) n.remove(); });     // its link no longer works
          openShare();
        } catch (err) { App.notify(err.message, 'error'); }
      }
      const cp = e.target.closest('[data-copy]');
      if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = 'Copied'; } catch (err) { const i = cp.parentElement.querySelector('input'); if (i) { i.select(); } } }
    });
    const del = document.getElementById('cl-delete');
    if (del) del.onclick = () => {
      if (!confirm('Delete the shared project “' + link.name + '” for everyone? People with access lose it at once. The copy open in this browser stays.')) return;
      call('DELETE', '/projects/' + link.id).then(() => { lostAccessQuiet(); App.closeModal(); App.notify('The shared project was deleted. The copy in this browser stays open.', 'success', 5000); }).catch(err => App.notify(err.message, 'error'));
    };
    const leave = document.getElementById('cl-leave');
    if (leave) leave.onclick = () => {
      if (!confirm('Leave “' + link.name + '”? You lose access until the owner invites you again. The copy open in this browser stays.')) return;
      call('DELETE', '/projects/' + link.id + '/members/' + encodeURIComponent(r.you.id)).then(() => { lostAccessQuiet(); App.closeModal(); }).catch(err => App.notify(err.message, 'error'));
    };
  }
  // We ended it ourselves (deleted or left): unlink without the "you were removed" message
  function lostAccessQuiet() {
    disconnect(); clearTimeout(pushTimer);
    link = null; saveLink();
    const s = App.getState();
    if (s.project && s.project.sharedId) { const p = Object.assign({}, s.project); delete p.sharedId; applying = true; try { App.setState({ project: p }); } finally { applying = false; } }
    closeChat(); renderBar();
    if (App.getCurrentView().id === 'projects') ProjectsView.render();
  }
  async function invite() {
    const emails = document.getElementById('cl-emails').value;
    const role = document.getElementById('cl-role').value;
    const err = document.getElementById('cl-err');
    err.textContent = '';
    if (!emails.trim()) { err.textContent = 'Enter at least one email address.'; return; }
    try {
      const r = await call('POST', '/projects/' + link.id + '/invites', { emails, role });
      await openShare();
      const box = document.getElementById('cl-results');
      if (!box) return;
      // The links of earlier invitations stay (newest first), except one a renewed invitation replaces
      box.querySelectorAll('[data-email]').forEach(n => { if (r.results.some(x => x.email === n.dataset.email)) n.remove(); });
      box.insertAdjacentHTML('afterbegin', r.results.map(x => x.link
        ? '<div class="cl-result" data-email="' + esc(x.email) + '" data-inv="' + esc(x.inviteId) + '"><div><b>' + esc(x.email) + '</b> — ' + esc(roleName(x.role)) + (x.status === 'renewed' ? ' (a new link; the old one stops working)' : '') + '</div>' +
          '<div class="cl-copy"><input class="form-input" readonly value="' + esc(x.link) + '" aria-label="Invitation link for ' + esc(x.email) + '"><button class="btn btn-secondary btn-sm" data-copy="' + esc(x.link) + '">Copy link</button></div></div>'
        : '<div class="cl-result cl-result-no" data-email="' + esc(x.email) + '"><b>' + esc(x.email) + '</b> — ' + esc(x.message) + '</div>').join(''));
    } catch (e) { err.textContent = e.message; }
  }

  /* ── Chat ─────────────────────────────────── */
  let panel = null;
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('aside');
    panel.className = 'cl-chat';
    panel.id = 'cl-chat';
    panel.setAttribute('aria-label', 'Project chat');
    panel.innerHTML = '<header class="cl-chat-head"><div><div class="cl-chat-title">Project chat</div><div class="cl-chat-sub" id="cl-chat-sub"></div></div>' +
      '<button type="button" class="asst-icon-btn" id="cl-chat-close" aria-label="Close chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></header>' +
      '<div class="cl-chat-log" id="cl-chat-log" role="log" aria-live="polite"></div>' +
      '<form class="cl-chat-form" id="cl-chat-form"><label class="asst-sr-only" for="cl-chat-input">Message</label><textarea id="cl-chat-input" rows="2" maxlength="2000" placeholder="Message everyone on this project…"></textarea>' +
      '<button type="submit" class="btn btn-primary btn-sm">Send</button></form>';
    document.body.appendChild(panel);
    panel.querySelector('#cl-chat-close').onclick = closeChat;
    // One side panel at a time: the assistant's or this one
    const asst = document.getElementById('asst-launcher');
    if (asst) asst.addEventListener('click', closeChat);
    const input = panel.querySelector('#cl-chat-input');
    panel.querySelector('#cl-chat-form').onsubmit = e => { e.preventDefault(); const t = input.value.trim(); if (t) { send(t); input.value = ''; } };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); panel.querySelector('#cl-chat-form').requestSubmit(); } });
    panel.querySelector('#cl-chat-log').addEventListener('click', e => {
      const b = e.target.closest('[data-retry]');
      if (b) { const m = chat.sending.get(b.dataset.retry); if (m) { chat.sending.delete(m.clientId); send(m.text, m.clientId); } }
      if (e.target.closest('#cl-chat-more')) loadChat('before');
    });
    return panel;
  }
  async function openChat() {
    if (!link) return;
    if (document.body.classList.contains('asst-open')) { const c = document.getElementById('asst-close'); if (c) c.click(); }
    ensurePanel().classList.add('is-open');
    document.body.classList.add('cl-chat-open');
    chat.open = true;
    if (!chat.loaded) await loadChat();
    renderChat();
    markSeen();
    setTimeout(() => { const i = document.getElementById('cl-chat-input'); if (i) i.focus(); }, 50);
  }
  function closeChat() { chat.open = false; if (panel) panel.classList.remove('is-open'); document.body.classList.remove('cl-chat-open'); renderBar(); }
  const lastSeq = () => chat.messages.reduce((m, x) => Math.max(m, x.seq || 0), 0);
  async function loadChat(dir) {
    if (!link) return;
    try {
      const q = dir === 'after' ? '?after=' + lastSeq() + '&limit=200' : dir === 'before' ? '?before=' + (chat.messages[0] ? chat.messages[0].seq : 0) + '&limit=50' : '?limit=50';
      const r = await call('GET', '/projects/' + link.id + '/chat' + q);
      if (dir === 'before') chat.more = r.messages.length === 50;
      else if (!dir) chat.more = r.messages.length === 50;
      chat.latest = Math.max(chat.latest, r.latest);
      addMessages(r.messages, true);
      chat.loaded = true;
    } catch (e) { if (e.status === 404) lostAccess('revoked'); }
  }
  function addMessages(list, quiet) {
    let added = 0;
    for (const m of list) {
      if (m.clientId && chat.sending.has(m.clientId)) chat.sending.delete(m.clientId);
      if (chat.messages.some(x => x.seq === m.seq)) continue;
      chat.messages.push(m); added++;
      chat.latest = Math.max(chat.latest, m.seq);
    }
    chat.messages.sort((a, b) => a.seq - b.seq);
    if (chat.messages.length > 1000) chat.messages = chat.messages.slice(-1000);
    if (chat.open) { renderChat(); markSeen(); }
    else if (added && !quiet && list.some(m => !me || m.from.id !== me.id)) renderBar();
  }
  function markSeen() { if (link && chat.latest > (link.chatSeen || 0)) { link.chatSeen = chat.latest; saveLink(); } renderBar(); }
  function renderChat() {
    if (!panel) return;
    const log = panel.querySelector('#cl-chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const sub = panel.querySelector('#cl-chat-sub');
    sub.textContent = link ? link.name + ' · ' + users.length + ' open now' : '';
    const day = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const row = (m, extra) => '<div class="cl-msg' + (me && m.from && m.from.id === me.id ? ' cl-mine' : '') + (extra || '') + '"><div class="cl-msg-meta"><b>' + esc(m.from ? m.from.email : 'you') + '</b> · ' + esc(m.at ? day(m.at) : 'sending') + '</div><div class="cl-msg-text"></div></div>';
    const pend = [...chat.sending.values()];
    log.innerHTML = (chat.more && chat.messages.length ? '<button type="button" class="cl-link" id="cl-chat-more">Earlier messages</button>' : '') +
      (!chat.messages.length && !pend.length ? '<p class="text-muted cl-chat-empty">No messages yet. Messages are seen by everyone with access to this project and kept with it.</p>' : '') +
      chat.messages.map(m => row(m)).join('') +
      pend.map(m => row({ from: me, text: m.text }, m.failed ? ' cl-failed' : ' cl-pending')).join('');
    // Messages are text, never HTML
    const nodes = log.querySelectorAll('.cl-msg-text');
    [...chat.messages, ...pend].forEach((m, i) => { if (nodes[i]) nodes[i].textContent = m.text; });
    pend.forEach((m, i) => { if (m.failed) { const n = nodes[chat.messages.length + i]; const b = document.createElement('button'); b.type = 'button'; b.className = 'cl-link'; b.dataset.retry = m.clientId; b.textContent = 'Not sent — retry'; n.after(b); } });
    if (atBottom || pend.length) log.scrollTop = log.scrollHeight;
  }
  async function send(text, clientId) {
    if (!link) return;
    clientId = clientId || 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const m = { clientId, text, failed: false };
    chat.sending.set(clientId, m);
    renderChat();
    try {
      const r = await call('POST', '/projects/' + link.id + '/chat', { text, clientId });
      chat.sending.delete(clientId);
      addMessages([r.message]);
    } catch (e) {
      if (e.status === 404) { lostAccess('revoked'); return; }
      m.failed = true;
      if (!e.offline) App.notify(e.message, 'error', 5000);
      renderChat();
    }
  }

  /* ── Projects page: shared projects ───────── */
  async function renderSharedList(box) {
    if (!box) return;
    const cfg = await getConfig();
    if (!cfg.enabled) { box.innerHTML = ''; return; }
    if (window.Account) await Account.ready;
    if (window.Account && !Account.signedIn()) {
      box.innerHTML = '<div class="card" style="margin-bottom:20px"><div class="card-title">Shared projects</div><p class="text-muted" style="font-size:13px">Sign in to share projects with other people and to open projects shared with you.</p>' +
        '<button class="btn btn-secondary btn-sm" id="cl-list-signin">Sign in</button></div>';
      document.getElementById('cl-list-signin').onclick = () => Account.openSignIn({ reason: 'Sign in to see projects shared with you.' });
      return;
    }
    let r;
    try { r = await call('GET', '/projects'); } catch (e) {
      box.innerHTML = '<div class="card" style="margin-bottom:20px"><div class="card-title">Shared projects</div><p style="color:var(--error);font-size:13px">Couldn\'t load shared projects: ' + esc(e.message) + '</p></div>';
      return;
    }
    if (!r.projects.length) {
      box.innerHTML = '<div class="card" style="margin-bottom:20px"><div class="card-title">Shared projects</div><p class="text-muted" style="font-size:13px">None yet. Use <b>Share</b> (top right) to work on the open project with other people; projects others share with you appear here.</p></div>';
      return;
    }
    box.innerHTML = '<div class="card" style="padding:0;overflow:hidden;margin-bottom:20px"><div style="padding:16px 20px 8px" class="card-title">Shared projects</div>' +
      '<table class="table" id="cl-list"><thead><tr><th>Project</th><th>Owner</th><th>Your role</th><th>People</th><th>Posts</th><th>Updated</th><th></th></tr></thead><tbody>' +
      r.projects.map(p => '<tr data-id="' + esc(p.id) + '"><td style="font-weight:600">' + esc(p.name) + (link && link.id === p.id ? ' <span class="badge badge-blue">Open now</span>' : '') + '</td>' +
        '<td>' + esc(p.owner.email || '') + '</td><td>' + esc(roleName(p.role)) + '</td><td>' + p.members + '</td><td>' + p.posts + '</td>' +
        '<td title="' + esc(new Date(p.updatedAt).toLocaleString()) + '">' + esc(new Date(p.updatedAt).toLocaleDateString()) + '</td>' +
        '<td style="text-align:right">' + (link && link.id === p.id ? '' : '<button class="btn btn-primary btn-sm" data-act="open">Open</button>') + '</td></tr>').join('') +
      '</tbody></table></div>';
    box.querySelector('tbody').onclick = e => { const b = e.target.closest('[data-act=open]'); if (b) open(b.closest('tr').dataset.id); };
  }
  // The "Open now" card on the Projects page, for a shared project
  function currentCardHTML() {
    if (!link) return '';
    return '<div class="cl-current"><span class="badge badge-violet">Shared</span> <span class="text-muted">You\'re ' + (link.role === 'owner' ? 'the owner' : link.role === 'editor' ? 'an editor' : 'a viewer') + '. ' +
      (canEdit() ? 'Changes are shared with everyone as you make them.' : 'You can read this project and chat; changes you make here aren\'t shared.') + '</span>' +
      (!canEdit() && pending ? ' <button class="btn btn-ghost btn-sm" id="cl-revert">Undo my changes here</button>' : '') + '</div>';
  }

  // A viewer's changes aren't shared: put the shared version back
  async function revertLocal() {
    if (!link) return;
    try {
      const full = await call('GET', '/projects/' + encodeURIComponent(link.id));
      ProjectsView.loadIntoBrowser(Object.assign({}, full.data, { project: Object.assign({}, full.data.project, { sharedId: full.project.id }) }), null, linkFrom(full));
    } catch (e) { App.notify(e.message, 'error'); }
  }
  function wireCurrentCard() { const b = document.getElementById('cl-revert'); if (b) b.onclick = revertLocal; }

  /* ── The invitation page (app.html#invite/<token>) ── */
  // Creating an account, confirming an email address or a sign-in link by
  // email lands on the dashboard: the invitation opened before is remembered
  // (for a day) and shown again once signed in.
  function rememberInvite(token) { try { localStorage.setItem(INVITE_KEY, JSON.stringify({ token, at: Date.now() })); } catch (e) { /* storage blocked */ } }
  function forgetInvite() { try { localStorage.removeItem(INVITE_KEY); } catch (e) { /* storage blocked */ } }
  function pendingInvite() {
    try { const p = JSON.parse(localStorage.getItem(INVITE_KEY) || 'null'); return p && typeof p.token === 'string' && Date.now() - p.at < 86400000 ? p.token : null; } catch (e) { return null; }
  }
  async function renderInvite(container, token) {
    container.innerHTML = '<div class="loading-state">Checking the invitation…</div>';
    let inv;
    try { inv = await call('GET', '/invites/' + encodeURIComponent(token || '')); } catch (e) {
      forgetInvite();
      container.innerHTML = '<div class="card cl-invite-card"><div class="card-title">Invitation</div><p>' + esc(e.message) + '</p><a class="btn btn-secondary" href="#projects">Go to Projects</a></div>';
      return;
    }
    if (window.Account) await Account.ready;
    const signedIn = window.Account && Account.signedIn();
    const who = signedIn ? Account.me().user.email : null;
    const ok = inv.status === 'pending';
    if (ok && !signedIn) rememberInvite(token); else forgetInvite();
    container.innerHTML = '<div class="card cl-invite-card">' +
      '<div class="card-title">You\'re invited to a shared project</div>' +
      '<p class="cl-invite-what"><b>' + esc(inv.invitedBy || 'Someone') + '</b> invited you to <b>“' + esc(inv.project.name) + '”</b> as ' + (inv.role === 'editor' ? 'an <b>editor</b> (you can change the project)' : 'a <b>viewer</b> (you can read it)') + '.</p>' +
      '<p class="text-muted" style="font-size:13px">For ' + esc(inv.email) + (ok ? ' · valid until ' + esc(new Date(inv.expiresAt).toLocaleDateString()) : '') + '</p>' +
      (!ok ? '<p class="cl-invite-msg">' + esc(inv.message || 'This invitation can\'t be used.') + '</p><a class="btn btn-secondary" href="#projects">Go to Projects</a>'
        : !signedIn ? '<p>Sign in with that email address to accept. No account yet? Create one with that address.</p><div class="cl-invite-actions"><button class="btn btn-primary" id="cl-inv-signin">Sign in</button><button class="btn btn-secondary" id="cl-inv-signup">Create an account</button></div>'
        : '<p class="text-muted" style="font-size:13px">Signed in as ' + esc(who) + '.</p><div class="cl-invite-actions"><button class="btn btn-primary" id="cl-inv-accept">Accept and open</button></div>') +
      '<div class="form-error" id="cl-inv-err"></div></div>';
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
    on('cl-inv-signin', () => Account.openSignIn({ reason: 'Sign in with ' + inv.email + ' to accept the invitation.' }));
    on('cl-inv-signup', () => Account.openSignIn({ mode: 'signup', reason: 'Create an account with ' + inv.email + ' to accept the invitation.' }));
    on('cl-inv-accept', async e => {
      e.target.disabled = true;
      const err = document.getElementById('cl-inv-err');
      try {
        const r = await call('POST', '/invites/' + encodeURIComponent(token) + '/accept');
        history.replaceState(null, '', '#projects');
        await open(r.project.id);
        if (!link || link.id !== r.project.id) { e.target.disabled = false; ProjectsView.render(); }
      } catch (x) {
        e.target.disabled = false;
        err.innerHTML = esc(x.message) + (x.type === 'invite_wrong_account' ? ' <button class="btn btn-secondary btn-sm" id="cl-inv-out">Sign out</button>' : '');
        const o = document.getElementById('cl-inv-out');
        if (o) o.onclick = () => Account.signOut();
      }
    });
  }

  /* ── Start ────────────────────────────────── */
  async function init() {
    slot = document.createElement('div');
    slot.className = 'cl-slot';
    slot.id = 'cl-slot';
    slot.hidden = true;
    const top = document.getElementById('topbar-project');
    if (top && top.parentNode) top.parentNode.insertBefore(slot, top);
    link = readLink();
    if (link && !ownsWorkspace()) { link = null; saveLink(); }
    if (!link) {
      // The open project came from a shared one (e.g. synced from another device) but isn't linked here
      const s = App.getState();
      if (s.project && s.project.sharedId) setTimeout(() => offerReconnect(s.project.sharedId), 800);
    }
    // The page drew before the link was read (App.init runs first)
    if (link && App.getCurrentView().id === 'projects') ProjectsView.render();
    if (window.Account) Account.onChange(m => {
      // Signed in after opening an invitation (e.g. from the link that confirmed a new account): back to it
      const invite = m && m.signedIn ? pendingInvite() : null;
      if (invite && App.getCurrentView().id !== 'invite') location.hash = '#invite/' + invite;
      config = null;
      getConfig().then(() => {
        if (link && m && m.signedIn && (conn === 'signin' || conn === 'offline')) reconnect();
        else if (link && m && m.signedIn === false && conn !== 'signin') { disconnect(); conn = 'signin'; }     // signed out: stop receiving
        renderBar();
      });
    });
    await getConfig();
    renderBar();
    if (link) {
      if (!config.enabled) { conn = 'offline'; renderBar(); return; }
      connect();
      schedulePull();
    }
    window.addEventListener('online', () => { if (link && conn !== 'live') reconnect(); });
  }
  async function offerReconnect(id) {
    let r;
    try { r = await call('GET', '/projects/' + encodeURIComponent(id) + '?since=999999999'); } catch (e) { return; }
    if (link) return;
    App.openModal('Open the shared version?', '<p>The project open here is a copy of the shared project “' + esc(r.project.name) + '”, but this browser isn\'t connected to it. Open the shared version to work on it with the others (changes made to this copy aren\'t carried over).</p>',
      '<button class="btn btn-secondary" id="cl-keep">Keep this copy</button><button class="btn btn-primary" id="cl-reopen">Open the shared version</button>');
    document.getElementById('cl-keep').onclick = () => {
      const s = App.getState(); const p = Object.assign({}, s.project); delete p.sharedId; App.setState({ project: p }); App.closeModal();
    };
    document.getElementById('cl-reopen').onclick = () => {
      App.closeModal();
      call('GET', '/projects/' + encodeURIComponent(id)).then(full => {
        ProjectsView.loadIntoBrowser(Object.assign({}, full.data, { project: Object.assign({}, full.data.project, { sharedId: full.project.id }) }), null, linkFrom(full));
      }).catch(e => App.notify(e.message, 'error'));
    };
  }

  return {
    init, noteChange, active, canEdit, flush, setLink, open, share, openShare, openChat, renderSharedList, renderInvite, currentCardHTML, wireCurrentCard,
    available: () => !!(config && config.enabled), link: () => link, status: () => ({ conn, pending, conflicts: link ? link.conflicts.length : 0, users: users.slice() }),
    _hashOf: hashOf, _entities: entities
  };
})();
