/* ══════════════════════════════════════════════
   projects.js — Projects page: saved copies of projects

   The open project lives in this browser (localStorage). This page saves
   named copies in this browser too (LocalDB, js/local-db.js — nothing is
   stored on the MetaCode server, so other people using the same server
   never see them) and lists them, so earlier projects can be reopened,
   renamed, duplicated, exported or deleted. Projects saved on the server
   by older versions of MetaCode can be imported once (from this computer). When the open project is linked to a saved one, changes are
   saved to it automatically (Autosave), a few seconds after each change.
   Settings (models, delay) aren't part of a project.
   ══════════════════════════════════════════════ */
const ProjectsView = (() => {
  const LINK_KEY = 'metacode_saved_project_v1';   // { id, name, savedAt, autosave, dirty }
  const DATA_KEYS = ['project', 'posts', 'codebook', 'network', 'networkAnalysis'];
  const AUTOSAVE_MS = 3000;
  let timer = null;
  let saving = null;
  let changeSeq = 0;        // bumped on every change, so a save can tell if more changes came in while it ran

  const esc = s => App.esc(s);
  function readLink() { try { const l = JSON.parse(localStorage.getItem(LINK_KEY) || 'null'); return l && l.id ? l : null; } catch (e) { return null; } }
  function writeLink(l) { try { if (l) localStorage.setItem(LINK_KEY, JSON.stringify(l)); else localStorage.removeItem(LINK_KEY); } catch (e) { /* storage full or blocked */ } }

  // The saved-projects "API", answered from this browser's storage. Same
  // routes and answers as the old /api/projects server routes.
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  function cleanData(input) {
    if (!isObj(input)) throw new Error('Send the project as { name, data: { posts, codebook, … } }.');
    const d = {};
    d.project = isObj(input.project) ? { name: str(input.project.name, 300) || 'Untitled Project', description: str(input.project.description, 5000) } : { name: 'Untitled Project', description: '' };
    d.posts = Array.isArray(input.posts) ? input.posts.filter(isObj) : [];
    d.codebook = Array.isArray(input.codebook) ? input.codebook.filter(isObj) : [];
    d.network = isObj(input.network) ? { nodes: Array.isArray(input.network.nodes) ? input.network.nodes : [], edges: Array.isArray(input.network.edges) ? input.network.edges : [] } : { nodes: [], edges: [] };
    d.networkAnalysis = isObj(input.networkAnalysis) ? input.networkAnalysis : null;
    return d;
  }
  const summary = r => ({ id: r.id, name: r.name, description: r.description || '', createdAt: r.createdAt, savedAt: r.savedAt, revision: r.revision || 1, counts: Object.assign({ posts: 0, aiCoded: 0, humanCoded: 0, dimensions: 0 }, counts(r.data || {})) });
  const newId = () => 'pr_' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
  function build(prev, body) {
    const data = body.data !== undefined ? cleanData(body.data) : prev.data;
    const name = str(body.name, 300) || prev.name || (data.project && data.project.name) || 'Untitled Project';
    const description = body.description !== undefined ? str(body.description, 5000) : (prev.description || '');
    return { name, description, data };
  }
  const notFound = () => new Error('That saved project doesn\'t exist (it may have been deleted).');
  async function api(path, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    const body = opts.body || {};
    const m = path.match(/^\/([^/]+)(\/duplicate)?$/);
    const id = m ? decodeURIComponent(m[1]) : null;
    const now = new Date().toISOString();
    if (!id) {
      if (method === 'GET') return { projects: (await LocalDB.all('projects')).map(summary).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))) };
      const rec = Object.assign({ id: newId(), createdAt: now, savedAt: now, revision: 1 }, build({}, body));
      await LocalDB.put('projects', rec);
      return { project: summary(rec) };
    }
    const rec = await LocalDB.get('projects', id);
    if (!rec) throw notFound();
    if (m[2]) {
      const copy = Object.assign({}, rec, { id: newId(), name: (rec.name + ' (copy)').slice(0, 300), createdAt: now, savedAt: now, revision: 1 });
      await LocalDB.put('projects', copy);
      return { project: summary(copy) };
    }
    if (method === 'GET') return { project: Object.assign(summary(rec), { data: rec.data }) };
    if (method === 'PUT') {
      const next = Object.assign({}, rec, build(rec, body), { savedAt: now, revision: (rec.revision || 1) + 1 });
      await LocalDB.put('projects', next);
      return { project: summary(next) };
    }
    if (method === 'DELETE') { await LocalDB.del('projects', id); return { ok: true }; }
    throw new Error('Unsupported request');
  }

  // Projects an older MetaCode saved on the server (shared by everyone then).
  // Only offered when MetaCode is opened on this computer (the server checks).
  async function legacyList() {
    try {
      const res = await fetch('/api/projects/legacy');
      if (!res.ok) return [];
      const j = await res.json();
      return Array.isArray(j.projects) ? j.projects : [];
    } catch (e) { return []; }
  }
  async function importLegacy(ids) {
    let n = 0;
    for (const id of ids) {
      const res = await fetch('/api/projects/legacy/' + encodeURIComponent(id));
      if (!res.ok) continue;
      const p = (await res.json()).project;
      if (!p || !p.id) continue;
      await LocalDB.put('projects', { id: p.id, name: p.name, description: p.description || '', createdAt: p.createdAt, savedAt: p.savedAt, revision: p.revision || 1, data: cleanData(p.data || {}) });
      n++;
    }
    return n;
  }

  function snapshot() {
    const s = App.getState();
    const d = {};
    DATA_KEYS.forEach(k => { d[k] = s[k]; });
    return d;
  }
  function hasContent(s) {
    s = s || App.getState();
    return (s.posts && s.posts.length) || (s.codebook && s.codebook.length) || (s.network && s.network.nodes && s.network.nodes.length);
  }
  const counts = s => {
    const posts = s.posts || [];
    const coded = k => posts.filter(p => p[k] && Object.keys(p[k]).length).length;
    return { posts: posts.length, aiCoded: coded('aiCodes'), humanCoded: coded('humanCodes'), dimensions: (s.codebook || []).length };
  };
  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 50) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString() + ' ' + new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* ── Saving ─────────────────────────────── */
  // Called by app.js whenever the project in this browser changes.
  function noteChange() {
    changeSeq++;
    const link = readLink();
    if (!link) return;
    if (!link.dirty) { link.dirty = true; writeLink(link); }
    if (!link.autosave) { renderCurrent(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { saveNow(true).catch(() => {}); }, AUTOSAVE_MS);
    renderCurrent();
  }

  async function saveNow(quiet) {
    const link = readLink();
    if (!link) return saveAsNew();
    clearTimeout(timer);
    if (saving) await saving.catch(() => {});
    saving = (async () => {
      const s = App.getState();
      const seq = changeSeq;
      const r = await api('/' + encodeURIComponent(link.id), { method: 'PUT', body: { name: (s.project && s.project.name) || link.name, description: (s.project && s.project.description) || '', data: snapshot() } });
      afterSave(Object.assign({}, readLink() || link, { name: r.project.name, savedAt: r.project.savedAt }), seq);
      return r;
    })();
    try {
      await saving;
      if (!quiet) App.notify('Project saved', 'success', 1800);
    } catch (e) {
      // The saved copy may have been deleted elsewhere: keep working locally
      if (/doesn.t exist/.test(e.message)) { writeLink(null); App.notify('The saved copy of this project was deleted, so it was unlinked. Save it again from Projects.', 'warning', 6000); }
      else App.notify('Couldn\'t save the project: ' + e.message, 'error', 6000);
      throw e;
    } finally { saving = null; renderCurrent(); refreshListIfShown(); }
  }

  // Records a finished save; changes made while it was in flight are saved next.
  function afterSave(link, seq) {
    const more = changeSeq !== seq;
    writeLink(Object.assign(link, { dirty: more }));
    if (more && link.autosave) { clearTimeout(timer); timer = setTimeout(() => { saveNow(true).catch(() => {}); }, AUTOSAVE_MS); }
  }

  async function saveAsNew(name) {
    const s = App.getState();
    const seq = changeSeq;
    const r = await api('', { method: 'POST', body: { name: name || (s.project && s.project.name) || 'Untitled Project', description: (s.project && s.project.description) || '', data: snapshot() } });
    afterSave({ id: r.project.id, name: r.project.name, savedAt: r.project.savedAt, autosave: true }, seq);
    App.notify('Saved as “' + r.project.name + '”', 'success');
    render();
    return r;
  }

  /* ── Opening ────────────────────────────── */
  // Before replacing the open project: save it if it's linked, or ask.
  async function protectCurrent() {
    const link = readLink();
    if (link) {
      if (link.dirty) { try { await saveNow(true); } catch (e) { return confirm('The current project couldn\'t be saved. Continue anyway and lose its latest changes?'); } }
      return true;
    }
    if (!hasContent()) return true;
    return new Promise(resolve => {
      App.openModal('Save the current project first?',
        '<p>“' + esc(App.getState().project.name) + '” (' + counts(App.getState()).posts + ' posts) isn\'t saved in Projects yet. Opening another project replaces it in this browser.</p>',
        '<button class="btn btn-secondary" id="pj-cancel">Cancel</button><button class="btn btn-secondary" id="pj-discard">Don\'t save</button><button class="btn btn-primary" id="pj-save">Save it, then continue</button>');
      document.getElementById('pj-cancel').onclick = () => { App.closeModal(); resolve(false); };
      document.getElementById('pj-discard').onclick = () => { App.closeModal(); resolve(true); };
      document.getElementById('pj-save').onclick = async () => {
        try { await saveAsNew(); App.closeModal(); resolve(true); } catch (e) { App.notify(e.message, 'error'); }
      };
    });
  }

  function loadIntoBrowser(data, link) {
    const patch = {};
    DATA_KEYS.forEach(k => { patch[k] = data[k]; });
    if (!patch.project) patch.project = { name: 'Untitled Project', description: '' };
    if (!Array.isArray(patch.posts)) patch.posts = [];
    if (!Array.isArray(patch.codebook)) patch.codebook = [];
    if (!patch.network) patch.network = { nodes: [], edges: [] };
    if (patch.networkAnalysis === undefined) patch.networkAnalysis = null;
    clearTimeout(timer);
    writeLink(null);                 // don't autosave the old link with the new data
    App.setState(patch);
    writeLink(link);
    // Reload so every page starts from the opened project
    location.hash = '#dashboard';
    location.reload();
  }

  async function openProject(id) {
    if (!(await protectCurrent())) return;
    try {
      const r = await api('/' + encodeURIComponent(id));
      loadIntoBrowser(r.project.data, { id: r.project.id, name: r.project.name, savedAt: r.project.savedAt, autosave: true, dirty: false });
    } catch (e) { App.notify('Couldn\'t open the project: ' + e.message, 'error'); }
  }

  async function newProject() {
    if (!(await protectCurrent())) return;
    loadIntoBrowser({ project: { name: 'Untitled Project', description: '' }, posts: [], codebook: [], network: { nodes: [], edges: [] }, networkAnalysis: null }, null);
  }

  /* ── Page ───────────────────────────────── */
  let listCache = [];
  function render() {
    const c = document.getElementById('view-container');
    c.innerHTML = `
      <div class="view-header">
        <div><div class="view-title">Projects</div>
          <div class="view-subtitle">Your saved projects — kept in this browser, private to you. Open an earlier one, or keep several side by side.</div></div>
        <div class="view-actions" style="display:flex;gap:10px">
          <button class="btn btn-secondary" id="pj-import">Import JSON</button>
          <button class="btn btn-secondary" id="pj-new">New empty project</button>
        </div>
      </div>
      <div class="card" id="pj-current" style="margin-bottom:20px"></div>
      <div id="pj-legacy"></div>
      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:16px 20px 8px" class="card-title">Saved projects</div>
        <div id="pj-list"><div class="loading-state" style="padding:20px">Loading…</div></div>
      </div>`;
    document.getElementById('pj-new').onclick = newProject;
    document.getElementById('pj-import').onclick = importDialog;
    renderCurrent();
    refreshList();
    renderLegacy();
  }

  async function renderLegacy() {
    const box = document.getElementById('pj-legacy');
    if (!box) return;
    const list = await legacyList();
    const have = new Set((await LocalDB.all('projects')).map(p => p.id));
    const fresh = list.filter(p => !have.has(p.id));
    if (!fresh.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="card" style="margin-bottom:20px;border-color:var(--amber, #F59E0B)"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<div><div class="card-title" style="margin-bottom:4px">Projects saved on this server by an older MetaCode</div>' +
      '<div class="text-muted" style="font-size:13px">Saved projects now stay in your browser. ' + fresh.length + ' project' + (fresh.length === 1 ? ' was' : 's were') + ' saved on the server before: ' + fresh.slice(0, 4).map(p => '“' + esc(p.name) + '”').join(', ') + (fresh.length > 4 ? '…' : '') + '</div></div>' +
      '<button class="btn btn-primary" id="pj-legacy-go">Import ' + (fresh.length === 1 ? 'it' : 'all ' + fresh.length) + ' into this browser</button></div></div>';
    document.getElementById('pj-legacy-go').onclick = async () => {
      try { const n = await importLegacy(fresh.map(p => p.id)); App.notify(n + ' project' + (n === 1 ? '' : 's') + ' imported', 'success'); render(); }
      catch (e) { App.notify('Import failed: ' + e.message, 'error'); }
    };
  }

  function renderCurrent() {
    const box = document.getElementById('pj-current');
    if (!box) return;
    const s = App.getState();
    const n = counts(s);
    const link = readLink();
    const stats = n.posts + ' posts · ' + n.aiCoded + ' AI-coded · ' + n.humanCoded + ' human-coded · ' + n.dimensions + ' codebook dimension' + (n.dimensions === 1 ? '' : 's');
    let status;
    if (link) {
      status = saving ? '<span class="badge badge-blue">Saving…</span>'
        : link.dirty ? '<span class="badge badge-amber">Unsaved changes</span>'
        : '<span class="badge badge-green">Saved ' + esc(ago(link.savedAt)) + '</span>';
    } else status = '<span class="badge badge-gray">Not saved in Projects</span>';
    box.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div>
          <div style="font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--tx-muted)">Open now</div>
          <div style="font:700 18px var(--f-display);margin:4px 0">${esc(s.project.name)} ${status}</div>
          <div class="text-muted" style="font-size:13px">${esc(stats)}</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          ${link ? `<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" id="pj-autosave" ${link.autosave ? 'checked' : ''}> Autosave</label>
            <button class="btn btn-secondary" id="pj-saveas">Save as new copy</button>
            <button class="btn btn-primary" id="pj-savenow">Save now</button>`
          : `<button class="btn btn-primary" id="pj-saveas">Save this project</button>`}
        </div>
      </div>`;
    const sn = document.getElementById('pj-savenow');
    if (sn) sn.onclick = () => saveNow(false).catch(() => {});
    document.getElementById('pj-saveas').onclick = () => nameDialog(link ? 'Save as a new copy' : 'Save this project', link ? s.project.name + ' (copy)' : s.project.name, name => saveAsNew(name));
    const as = document.getElementById('pj-autosave');
    if (as) as.onchange = () => { const l = readLink(); if (l) { l.autosave = as.checked; writeLink(l); if (as.checked && l.dirty) saveNow(true).catch(() => {}); } };
  }

  function refreshListIfShown() { if (document.getElementById('pj-list')) refreshList(); }
  async function refreshList() {
    const box = document.getElementById('pj-list');
    if (!box) return;
    try { listCache = (await api('')).projects; } catch (e) {
      box.innerHTML = '<div class="empty-state" style="padding:24px"><div class="empty-sub" style="color:var(--error)">Couldn\'t load saved projects: ' + esc(e.message) + '</div></div>';
      return;
    }
    const link = readLink();
    if (!listCache.length) {
      box.innerHTML = '<div class="empty-state" style="padding:28px"><div class="empty-title">No saved projects yet</div><div class="empty-sub">Click <b>Save this project</b> above to keep a copy you can come back to.</div></div>';
      return;
    }
    box.innerHTML = '<table class="table"><thead><tr><th>Project</th><th>Last saved</th><th>Posts</th><th>Coded (AI / human)</th><th>Codebook</th><th></th></tr></thead><tbody>' +
      listCache.map(p => '<tr data-id="' + esc(p.id) + '">' +
        '<td><div style="font-weight:600">' + esc(p.name) + (link && link.id === p.id ? ' <span class="badge badge-blue">Open now</span>' : '') + '</div>' +
          (p.description ? '<div class="text-muted" style="font-size:12px;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.description) + '</div>' : '') + '</td>' +
        '<td title="' + esc(new Date(p.savedAt).toLocaleString()) + '">' + esc(ago(p.savedAt)) + '</td>' +
        '<td>' + p.counts.posts + '</td><td>' + p.counts.aiCoded + ' / ' + p.counts.humanCoded + '</td><td>' + p.counts.dimensions + ' dim.</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          (link && link.id === p.id ? '' : '<button class="btn btn-primary btn-sm" data-act="open">Open</button> ') +
          '<button class="btn btn-ghost btn-sm" data-act="rename">Rename</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="duplicate">Duplicate</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="export">Export</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="delete" style="color:var(--error)">Delete</button></td></tr>').join('') +
      '</tbody></table>';
    box.querySelector('tbody').onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.closest('tr').dataset.id;
      const p = listCache.find(x => x.id === id);
      ({ open: () => openProject(id), rename: () => renameProject(p), duplicate: () => duplicateProject(p), export: () => exportProject(p), delete: () => deleteProject(p) })[b.dataset.act]();
    };
  }

  function nameDialog(title, value, fn) {
    App.openModal(title, '<div class="form-group"><label class="form-label" for="pj-name">Name</label><input class="form-input" id="pj-name" value="' + esc(value) + '" maxlength="300"></div><div class="form-error" id="pj-err"></div>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="pj-ok">Save</button>');
    const input = document.getElementById('pj-name');
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const ok = async () => {
      const name = input.value.trim();
      if (!name) { document.getElementById('pj-err').textContent = 'Give it a name.'; return; }
      try { await fn(name); App.closeModal(); } catch (e) { document.getElementById('pj-err').textContent = e.message; }
    };
    document.getElementById('pj-ok').onclick = ok;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  }

  function renameProject(p) {
    nameDialog('Rename project', p.name, async name => {
      await api('/' + encodeURIComponent(p.id), { method: 'PUT', body: { name } });
      const link = readLink();
      if (link && link.id === p.id) {
        App.setState({ project: Object.assign({}, App.getState().project, { name }) });
        const top = document.getElementById('topbar-project'); if (top) top.textContent = name;
        writeLink(Object.assign(readLink() || link, { name }));
      }
      render();
    });
  }
  async function duplicateProject(p) {
    try { await api('/' + encodeURIComponent(p.id) + '/duplicate', { method: 'POST', body: {} }); App.notify('Duplicated “' + p.name + '”', 'success'); refreshList(); }
    catch (e) { App.notify(e.message, 'error'); }
  }
  async function exportProject(p) {
    try {
      const r = await api('/' + encodeURIComponent(p.id));
      const blob = new Blob([JSON.stringify({ kind: 'metacode-project', version: 1, name: r.project.name, description: r.project.description, savedAt: r.project.savedAt, data: r.project.data }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (p.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'project') + '.metacode.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { App.notify(e.message, 'error'); }
  }
  function deleteProject(p) {
    App.openModal('Delete “' + p.name + '”?', '<p>The saved copy is deleted from this browser. Export it first if you may want it back. ' +
      (readLink() && readLink().id === p.id ? 'The project open in this browser stays open, but is no longer saved anywhere.' : '') + '</p>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-danger" id="pj-del">Delete</button>');
    document.getElementById('pj-del').onclick = async () => {
      try {
        await api('/' + encodeURIComponent(p.id), { method: 'DELETE' });
        const link = readLink();
        if (link && link.id === p.id) writeLink(null);
        App.closeModal();
        render();
      } catch (e) { App.notify(e.message, 'error'); }
    };
  }
  function importDialog() {
    App.openModal('Import a project', '<p class="form-hint" style="margin-bottom:10px">Choose a <code>.metacode.json</code> file exported from Projects. It\'s added to the list; open it from there.</p>' +
      '<input type="file" id="pj-file" accept=".json,application/json" class="form-input"><div class="form-error" id="pj-imp-err"></div>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="pj-imp-go">Import</button>');
    document.getElementById('pj-imp-go').onclick = async () => {
      const f = document.getElementById('pj-file').files[0];
      const err = document.getElementById('pj-imp-err');
      if (!f) { err.textContent = 'Choose a file first.'; return; }
      let j;
      try { j = JSON.parse(await f.text()); } catch (e) { err.textContent = 'That file isn\'t valid JSON.'; return; }
      const data = j && j.data ? j.data : j;             // an export, or a raw app state
      if (!data || typeof data !== 'object' || (!Array.isArray(data.posts) && !Array.isArray(data.codebook))) { err.textContent = 'That doesn\'t look like a MetaCode project.'; return; }
      try {
        await api('', { method: 'POST', body: { name: j.name || (data.project && data.project.name) || f.name.replace(/\.json$/i, ''), description: j.description || '', data } });
        App.closeModal();
        App.notify('Project imported', 'success');
        refreshList();
      } catch (e) { err.textContent = e.message; }
    };
  }

  // Save pending changes when the tab closes (best effort; the open project
  // itself is always in localStorage, so nothing is lost if this doesn't finish).
  window.addEventListener('pagehide', () => {
    const link = readLink();
    if (!link || !link.autosave || !link.dirty) return;
    try {
      const s = App.getState();
      api('/' + encodeURIComponent(link.id), { method: 'PUT', body: { name: (s.project && s.project.name) || link.name, data: snapshot() } }).catch(() => {});
    } catch (e) { /* ignore */ }
  });

  return { render, noteChange, saveNow, link: readLink };
})();
