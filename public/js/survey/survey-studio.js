/* ══════════════════════════════════════════════
   survey-studio.js — Survey Studio (studio.html)

   The survey list and the editor application:
     Design     canvas + Add/Layers/Library panels + inspector
     Logic      Scratch-style block scripts and variables (survey-blocks.js)
     Theme      tokens, element defaults, survey settings
     Preview    the real runtime on desktop/tablet/mobile, with a test panel
     Responses  collected responses, summaries, exports, "add to project"
   plus publishing, autosave status, shortcuts and the context menu.
   Routes (studio.html): # (list) · #<id> · #<id>/<mode>
   ══════════════════════════════════════════════ */
const SurveyStudio = (() => {
  'use strict';
  const Core = window.SurveyCore, Logic = window.SurveyLogic, api = window.SurveyStore.api;
  const esc = s => App.esc(s === undefined || s === null ? '' : String(s));
  const icon = (inner, cls) => '<svg class="' + (cls || 'ss-ico') + '" viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
  const MODES = [['design', 'Design'], ['logic', 'Logic'], ['theme', 'Theme'], ['preview', 'Preview'], ['responses', 'Responses']];
  const I = {
    back: '<polyline points="15 18 9 12 15 6"/>', undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    redo: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    select: '<path d="M4 3l7 17 2.5-7.5L21 10z"/>', hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    scale: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    text: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    rect: '<rect x="3" y="5" width="18" height="14" rx="2"/>', frame: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="8" x2="21" y2="8"/>',
    question: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    image: Core.ICONS.image,
    alignL: '<line x1="4" y1="3" x2="4" y2="21"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="7" height="4" rx="1"/>',
    alignC: '<line x1="12" y1="3" x2="12" y2="21"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>',
    alignR: '<line x1="20" y1="3" x2="20" y2="21"/><rect x="5" y="6" width="12" height="4" rx="1"/><rect x="10" y="14" width="7" height="4" rx="1"/>',
    alignT: '<line x1="3" y1="4" x2="21" y2="4"/><rect x="6" y="7" width="4" height="12" rx="1"/><rect x="14" y="7" width="4" height="7" rx="1"/>',
    alignM: '<line x1="3" y1="12" x2="21" y2="12"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>',
    alignB: '<line x1="3" y1="20" x2="21" y2="20"/><rect x="6" y="5" width="4" height="12" rx="1"/><rect x="14" y="10" width="4" height="7" rx="1"/>',
    distH: '<rect x="3" y="6" width="4" height="12" rx="1"/><rect x="10" y="6" width="4" height="12" rx="1"/><rect x="17" y="6" width="4" height="12" rx="1"/>',
    distV: '<rect x="6" y="3" width="12" height="4" rx="1"/><rect x="6" y="10" width="12" height="4" rx="1"/><rect x="6" y="17" width="12" height="4" rx="1"/>',
    group: Core.ICONS.group, ungroup: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    front: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>', toBack: '<rect x="3" y="3" width="13" height="13" rx="2"/><path d="M20 8v11a1 1 0 0 1-1 1H8"/>',
    up: '<polyline points="18 15 12 9 6 15"/>', down: '<polyline points="6 9 12 15 18 9"/>',
    dup: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
    magnet: '<path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="14" y1="7" x2="18" y2="7"/>',
    tidy: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    kbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/><line x1="10" y1="10" x2="10.01" y2="10"/><line x1="14" y1="10" x2="14.01" y2="10"/><line x1="18" y1="10" x2="18.01" y2="10"/><line x1="7" y1="14" x2="17" y2="14"/>'
  };

  let current = null;          // the open editor
  let library = { components: [], styles: [], templates: [] };
  let libraryLoaded = false;

  function rel(iso) {
    if (!iso) return '—';
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    if (d < 86400 * 30) return Math.round(d / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString();
  }
  async function loadLibrary() {
    if (libraryLoaded) return library;
    try { library = (await api('/library')).library; libraryLoaded = true; } catch (e) { /* keep empty */ }
    return library;
  }
  async function saveLibrary() {
    try { library = (await api('/library', { method: 'PUT', body: { library } })).library; } catch (e) { App.notify('The library couldn\'t be saved: ' + e.message, 'error'); }
  }

  // Browser tab title (and the main app's top bar, if the studio runs inside it)
  function setDocTitle(t) {
    document.title = (t ? t + ' · ' : '') + 'Survey Studio · MetaCode';
    const el = document.getElementById('topbar-project');
    if (el) el.textContent = t;
  }

  /* ══ Router entry ════════════════════════════ */
  function render(param) {
    const parts = String(param || '').split('/').filter(Boolean);
    const container = document.getElementById('view-container');
    if (!parts.length) { closeEditor(); setDocTitle(''); renderList(container); return; }
    const id = parts[0], mode = MODES.some(m => m[0] === parts[1]) ? parts[1] : 'design';
    if (current && current.id === id && document.body.contains(current.root)) { current.setMode(mode); return; }
    closeEditor();
    openEditor(container, id, mode);
  }

  /* ══ Survey list ═════════════════════════════ */
  async function renderList(container) {
    container.classList.remove('is-flush');
    container.innerHTML = '<div class="view-header"><div><div class="view-title">Survey Studio</div><div class="view-subtitle">Design surveys visually — every element is yours to shape — then publish a link and collect responses.</div></div>' +
      '<div class="view-actions"><button class="btn btn-secondary" id="ss-import">Import JSON</button><button class="btn btn-primary" id="ss-new">' + icon(I.plus) + 'New survey</button></div></div>' +
      '<div class="ss-templates" id="ss-templates" aria-label="Start from a template"></div><div class="card ss-list-card" id="ss-list"><div class="loading-state">Loading surveys…</div></div>';
    const lib = await loadLibrary();
    const tpl = document.getElementById('ss-templates');
    if (!tpl) return;
    const all = SurveyTemplates.list.map(t => ({ id: t.id, name: t.name, description: t.description, builtin: true })).concat((lib.templates || []).map(t => ({ id: t.id, name: t.name, description: t.description || 'Your template', builtin: false })));
    tpl.innerHTML = all.map(t => '<button type="button" class="ss-tpl" data-tpl="' + esc(t.id) + '"><span class="ss-tpl-name">' + esc(t.name) + (t.builtin ? '' : ' <span class="badge badge-violet">Yours</span>') + '</span><span class="ss-tpl-desc">' + esc(t.description) + '</span></button>').join('');
    tpl.onclick = e => { const b = e.target.closest('[data-tpl]'); if (b) createFrom(b.dataset.tpl); };
    document.getElementById('ss-new').onclick = () => createFrom('blank');
    document.getElementById('ss-import').onclick = importDialog;
    await refreshList();
  }

  async function refreshList() {
    const box = document.getElementById('ss-list');
    if (!box) return;
    let surveys;
    try { surveys = (await api('')).surveys; } catch (e) {
      box.innerHTML = '<div class="empty-state"><div class="empty-title">Couldn\'t load surveys</div><div class="empty-sub">' + esc(e.message) + ' Survey Studio needs the MetaCode server (npm start).</div></div>';
      return;
    }
    if (!surveys.length) {
      box.innerHTML = '<div class="empty-state"><div class="empty-title">No surveys yet</div><div class="empty-sub">Pick a template above, or start with a blank survey.</div></div>';
      return;
    }
    box.innerHTML = '<div class="table-wrap"><table class="table ss-table"><thead><tr><th>Survey</th><th>Status</th><th>Responses</th><th>Questions</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
      surveys.map(s => {
        const p = s.publish;
        const status = !p ? '<span class="badge badge-gray">Draft</span>' : p.unpublished ? '<span class="badge badge-gray">Unpublished</span>' : p.open ? '<span class="badge badge-green">Live · v' + p.version + '</span>' : '<span class="badge badge-amber">Closed · v' + p.version + '</span>';
        const changed = p && !p.unpublished && s.revision > (p.publishedRevision || 0) ? ' <span class="badge badge-blue" title="Saved changes that aren\'t published yet">Edited</span>' : '';
        return '<tr data-id="' + esc(s.id) + '"><td><a href="#' + esc(s.id) + '" class="ss-list-title">' + esc(s.title) + '</a><div class="ss-list-sub">' + s.pages + ' page' + (s.pages === 1 ? '' : 's') + '</div></td>' +
          '<td>' + status + changed + '</td><td>' + s.completed + (s.responses > s.completed ? ' <span class="text-muted">(+' + (s.responses - s.completed) + ' in progress)</span>' : '') + '</td><td>' + s.questions + '</td><td title="' + esc(s.updatedAt) + '">' + rel(s.updatedAt) + '</td>' +
          '<td class="ss-row-actions"><a class="btn btn-secondary btn-sm" href="#' + esc(s.id) + '">Edit</a>' +
          (p && !p.unpublished ? '<a class="btn btn-ghost btn-sm" href="/s/' + esc(p.publicId) + '" target="_blank" rel="noopener">Open link</a>' : '') +
          '<button class="btn btn-ghost btn-sm" data-act="menu" aria-label="More actions for ' + esc(s.title) + '">⋯</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    box.onclick = e => {
      const b = e.target.closest('[data-act="menu"]');
      if (!b) return;
      const id = b.closest('tr').dataset.id;
      const s = surveys.find(x => x.id === id);
      menuAt(b, [
        ['Open in editor', () => { location.hash = '#' + id; }],
        ['Responses', () => { location.hash = '#' + id + '/responses'; }],
        s.publish && !s.publish.unpublished ? ['Copy survey link', () => copyText(location.origin + '/s/' + s.publish.publicId, 'Link copied')] : null,
        ['Duplicate', async () => { try { await api('/' + id + '/duplicate', { method: 'POST', body: {} }); App.notify('Survey duplicated', 'success'); refreshList(); } catch (err) { App.notify(err.message, 'error'); } }],
        ['Export JSON', async () => { try { const r = await api('/' + id); download(Core.slug(r.survey.doc.title, 'survey') + '.survey.json', JSON.stringify(r.survey.doc, null, 2), 'application/json'); } catch (err) { App.notify(err.message, 'error'); } }],
        ['Save as template', async () => { try { const r = await api('/' + id); await loadLibrary(); library.templates.push({ id: Core.uid('tpl'), name: r.survey.doc.title, description: 'Saved from “' + r.survey.doc.title + '”', doc: r.survey.doc }); await saveLibrary(); App.notify('Saved as a template', 'success'); renderList(document.getElementById('view-container')); } catch (err) { App.notify(err.message, 'error'); } }],
        null,
        ['Delete…', async () => {
          if (!confirm('Delete “' + s.title + '”' + (s.responses ? ' and its ' + s.responses + ' response' + (s.responses === 1 ? '' : 's') : '') + '? It is moved to the survey-data/trash folder on the server.')) return;
          try { await api('/' + id, { method: 'DELETE' }); App.notify('Survey deleted', 'success'); refreshList(); } catch (err) { App.notify(err.message, 'error'); }
        }, true]
      ]);
    };
  }

  async function createFrom(tplId) {
    let doc;
    const builtin = SurveyTemplates.list.find(t => t.id === tplId);
    if (builtin) doc = builtin.build();
    else { const t = (library.templates || []).find(x => x.id === tplId); if (!t) return; doc = Core.clone(t.doc); }
    try {
      const r = await api('', { method: 'POST', body: { doc } });
      location.hash = '#' + r.survey.id;
    } catch (e) { App.notify('The survey couldn\'t be created: ' + e.message, 'error'); }
  }

  function importDialog() {
    App.openModal('Import a survey', '<p class="form-hint" style="margin-bottom:10px">Choose a .survey.json file exported from Survey Studio, or paste its JSON.</p>' +
      '<input type="file" id="ss-imp-file" accept=".json,application/json" class="form-input" style="margin-bottom:10px"><textarea id="ss-imp-text" class="form-textarea" rows="8" placeholder="{ … }" style="font-family:var(--f-mono);font-size:12px"></textarea><div class="form-error" id="ss-imp-err"></div>',
    '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="ss-imp-go">Import</button>');
    document.getElementById('ss-imp-file').onchange = e => { const f = e.target.files[0]; if (f) f.text().then(t => { document.getElementById('ss-imp-text').value = t; }); };
    document.getElementById('ss-imp-go').onclick = async () => {
      const err = document.getElementById('ss-imp-err');
      let doc;
      try { doc = JSON.parse(document.getElementById('ss-imp-text').value); } catch (e) { err.textContent = 'That isn\'t valid JSON: ' + e.message; return; }
      try {
        const r = await api('', { method: 'POST', body: { doc } });
        App.closeModal();
        if (r.problems && r.problems.length) App.notify('Imported with ' + r.problems.length + ' repair(s): ' + r.problems[0], 'info', 6000);
        location.hash = '#' + r.survey.id;
      } catch (e) { err.textContent = e.message; }
    };
  }

  /* ══ Editor ══════════════════════════════════ */
  async function openEditor(container, id, mode) {
    container.classList.add('is-flush');
    container.innerHTML = '<div class="ss-loading"><div class="loading-state">Opening survey…</div></div>';
    let rec;
    try { rec = (await api('/' + encodeURIComponent(id))).survey; } catch (e) {
      container.classList.remove('is-flush');
      container.innerHTML = '<div class="empty-state"><div class="empty-title">' + (e.status === 404 ? 'Survey not found' : 'Couldn\'t open the survey') + '</div><div class="empty-sub">' + esc(e.message) + ' <a href="#" class="text-ai fw-600">Back to surveys</a></div></div>';
      return;
    }
    await loadLibrary();
    if (!document.body.contains(container) || (location.hash.indexOf('#' + id) !== 0)) return;
    current = Editor(container, rec, mode);
    App.setViewCleanup(closeEditor);
  }
  function closeEditor() {
    if (!current) return;
    const ed = current;
    current = null;
    ed.destroy();
  }

  function Editor(container, rec, initialMode) {
    const store = window.SurveyStore.create(rec);
    const doc = () => store.doc;
    let mode = null;
    let canvas = null, inspector = null, layers = null, palette = null, libPanel = null, logicUI = null, previewRT = null;
    let leftTab = 'layers';
    const cleanup = [];

    container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'ss-app';
    root.innerHTML =
      '<header class="ss-bar">' +
        '<div class="ss-bar-left"><a class="ss-brand-btn" href="index.html" title="MetaCode home" aria-label="MetaCode home"><img src="img/metacode-mark.png" alt=""></a><a class="ss-icon-btn ss-back" href="#" title="All surveys" aria-label="Back to all surveys">' + icon(I.back) + '</a>' +
        '<input class="ss-title" id="ss-title" aria-label="Survey title" maxlength="300">' +
        '<span class="ss-save" id="ss-save" role="status" aria-live="polite"></span></div>' +
        '<nav class="ss-modes" role="tablist" aria-label="Editor mode">' + MODES.map(([m, l]) => '<button type="button" role="tab" class="ss-mode" data-mode="' + m + '" aria-selected="false">' + l + '</button>').join('') + '</nav>' +
        '<div class="ss-bar-right"><button type="button" class="ss-icon-btn" id="ss-undo" title="Undo (Ctrl+Z)" aria-label="Undo">' + icon(I.undo) + '</button>' +
        '<button type="button" class="ss-icon-btn" id="ss-redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">' + icon(I.redo) + '</button>' +
        '<button type="button" class="ss-icon-btn" id="ss-keys" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">' + icon(I.kbd) + '</button>' +
        '<span class="ss-pub-state" id="ss-pub-state"></span><button type="button" class="btn btn-primary btn-sm" id="ss-publish">Publish</button></div>' +
      '</header>' +
      '<div class="ss-views">' +
        '<div class="ss-view ss-view-design" data-view="design">' +
          '<aside class="ss-left" aria-label="Elements and layers"><div class="ss-left-tabs" role="tablist"><button type="button" role="tab" data-left="add">Add</button><button type="button" role="tab" data-left="layers">Layers</button><button type="button" role="tab" data-left="library">Library</button></div>' +
            '<div class="ss-left-body" data-left-body="add"></div><div class="ss-left-body" data-left-body="layers"></div><div class="ss-left-body" data-left-body="library"></div></aside>' +
          '<section class="ss-center" aria-label="Canvas"><div class="ss-toolbar" role="toolbar" aria-label="Canvas tools"></div><div class="ss-canvas-host"></div>' +
            '<div class="ss-pagebar" role="tablist" aria-label="Pages"></div></section>' +
          '<aside class="ss-right" aria-label="Properties"></aside>' +
          '<button type="button" class="ss-drawer-btn ss-drawer-left" aria-label="Show elements and layers">☰</button><button type="button" class="ss-drawer-btn ss-drawer-right" aria-label="Show properties">⚙</button>' +
        '</div>' +
        '<div class="ss-view ss-view-logic" data-view="logic"></div>' +
        '<div class="ss-view ss-view-theme" data-view="theme"></div>' +
        '<div class="ss-view ss-view-preview" data-view="preview"></div>' +
        '<div class="ss-view ss-view-responses" data-view="responses"></div>' +
      '</div><div class="ss-live sr-only" aria-live="polite"></div>';
    container.appendChild(root);
    const $ = sel => root.querySelector(sel);
    const live = root.querySelector('.ss-live');
    const say = t => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 20); };

    /* ── Title, save status, undo ─────── */
    const titleInput = $('#ss-title');
    titleInput.value = doc().title;
    titleInput.addEventListener('change', () => { const v = titleInput.value.trim().slice(0, 300) || 'Untitled survey'; store.tx('Rename survey', t => t.set('title', v)); setDocTitle(v); });
    titleInput.addEventListener('keydown', e => { if (e.key === 'Enter') titleInput.blur(); });
    setDocTitle(doc().title);

    function renderSave() {
      const s = store.saveState;
      const el = $('#ss-save');
      const map = {
        saved: ['is-saved', 'All changes saved'], saving: ['is-saving', 'Saving…'], unsaved: ['is-unsaved', 'Unsaved changes'],
        offline: ['is-error', 'Offline — saved on this computer, retrying'], error: ['is-error', 'Couldn\'t save — ' + (s.error ? s.error.message : '') + ' (kept on this computer)'],
        conflict: ['is-error', 'Changed in another window — resolve']
      };
      const [cls, text] = map[s.status] || map.saved;
      el.className = 'ss-save ' + cls;
      el.innerHTML = '<span class="ss-save-dot"></span>' + esc(text);
      el.title = s.status === 'saved' ? 'Saved to the MetaCode server' : text;
      el.style.cursor = s.status === 'conflict' || s.status === 'error' || s.status === 'offline' ? 'pointer' : '';
    }
    $('#ss-save').addEventListener('click', () => {
      const s = store.saveState.status;
      if (s === 'conflict') conflictDialog();
      else if (s === 'error' || s === 'offline') store.flush().then(() => App.notify('Saved', 'success')).catch(e => App.notify(e.message, 'error'));
    });
    function renderUndo() {
      $('#ss-undo').disabled = !store.canUndo(); $('#ss-redo').disabled = !store.canRedo();
      $('#ss-undo').title = store.canUndo() ? 'Undo ' + store.undoLabel().toLowerCase() + ' (Ctrl+Z)' : 'Nothing to undo';
      $('#ss-redo').title = store.canRedo() ? 'Redo ' + store.redoLabel().toLowerCase() + ' (Ctrl+Shift+Z)' : 'Nothing to redo';
    }
    $('#ss-undo').addEventListener('click', () => doUndo());
    $('#ss-redo').addEventListener('click', () => doRedo());
    function doUndo() { const l = store.undo(); if (l) say('Undid ' + l.toLowerCase()); }
    function doRedo() { const l = store.redo(); if (l) say('Redid ' + l.toLowerCase()); }
    $('#ss-keys').addEventListener('click', shortcutsDialog);

    function renderPubState() {
      const p = store.publish;
      const el = $('#ss-pub-state');
      if (!p || p.unpublished) { el.innerHTML = '<span class="badge badge-gray">Draft</span>'; $('#ss-publish').textContent = 'Publish'; return; }
      const changed = store.revision > (p.publishedRevision || 0);
      el.innerHTML = (p.open ? '<span class="badge badge-green">Live · v' + p.version + '</span>' : '<span class="badge badge-amber">Closed · v' + p.version + '</span>') + (changed ? ' <span class="badge badge-blue" title="Changes since the last publish">Unpublished changes</span>' : '');
      $('#ss-publish').textContent = changed ? 'Publish changes' : 'Published';
    }

    cleanup.push(store.on((type, info) => {
      if (type === 'save' || type === 'saved') { renderSave(); renderPubState(); }
      if (type === 'change') {
        renderUndo();
        if (info.doc && document.activeElement !== titleInput) { titleInput.value = doc().title; }
        if (info.pages || info.structure) renderPageBar();
        updateToolbarState();
      }
      if (type === 'select') updateToolbarState();
      if (type === 'page') { renderPageBar(); updateToolbarState(); }
      if (type === 'publish') renderPubState();
    }));

    /* ── Mode switching ──────────────── */
    root.querySelector('.ss-modes').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode, true); });
    function setMode(m, push) {
      if (m === mode) return;
      if (canvas && canvas.editing) canvas.finishEdit(true);
      mode = m;
      root.dataset.mode = m;
      root.querySelectorAll('.ss-mode').forEach(b => { const on = b.dataset.mode === m; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
      root.querySelectorAll('.ss-view').forEach(v => { v.hidden = v.dataset.view !== m; });
      if (push !== false) history.replaceState(null, '', '#' + doc().id + (m === 'design' ? '' : '/' + m));
      if (previewRT && m !== 'preview') { previewRT.destroy(); previewRT = null; }
      if (m === 'design') ensureDesign();
      if (m === 'logic') { if (!logicUI) logicUI = SurveyBlocks.create($('.ss-view-logic'), store, { notify: App.notify }); else logicUI.render(); }
      if (m === 'theme') renderTheme();
      if (m === 'preview') renderPreview();
      if (m === 'responses') renderResponses();
    }

    /* ── Design view ─────────────────── */
    let cmds = null;
    function ensureDesign() {
      if (canvas) { requestAnimationFrame(() => canvas.redraw()); return; }
      cmds = SurveyCommands.create(store, { measure: id => canvas && canvas.measure(id), notify: App.notify, pageHeight: () => canvas ? canvas.pageHeight() : 800 });
      canvas = SurveyCanvas.create($('.ss-canvas-host'), store, cmds, {
        onContextMenu: (e, info) => contextMenu(e, info),
        onTool: () => updateToolbarState(),
        onZoom: () => { const z = $('#ss-zoom-label'); if (z) z.textContent = Math.round(canvas.zoom * 100) + '%'; },
        onDropComponent: (cid, at) => insertComponent(cid, at),
        onEditing: on => root.classList.toggle('is-text-editing', on),
        notify: App.notify
      });
      inspector = SurveyInspector.create($('.ss-right'), store, cmds, { canvas, measure: id => canvas.measure(id), notify: App.notify, openLogic: () => setMode('logic', true) });
      palette = SurveyPanels.createPalette(root.querySelector('[data-left-body="add"]'), store, cmds, { library: () => library, insertComponent: cid => insertComponent(cid), onAdded: () => {} });
      layers = SurveyPanels.createLayers(root.querySelector('[data-left-body="layers"]'), store, cmds, { pageMenu: pageMenu, onSelect: id => canvas.reveal(id) });
      libPanel = SurveyPanels.createLibrary(root.querySelector('[data-left-body="library"]'), store, cmds, { library: () => library, saveLibrary: async () => { await saveLibrary(); palette.render(); libPanel.render(); }, insertComponent: cid => insertComponent(cid) });
      root.querySelector('.ss-left-tabs').addEventListener('click', e => { const b = e.target.closest('[data-left]'); if (b) setLeft(b.dataset.left); });
      setLeft('add');
      buildToolbar();
      renderPageBar();
      root.querySelector('.ss-drawer-left').addEventListener('click', () => root.classList.toggle('show-left'));
      root.querySelector('.ss-drawer-right').addEventListener('click', () => root.classList.toggle('show-right'));
      cleanup.push(() => { canvas.destroy(); inspector.destroy(); layers.destroy(); libPanel.destroy(); });
    }
    function setLeft(tab) {
      leftTab = tab;
      root.querySelectorAll('[data-left]').forEach(b => { const on = b.dataset.left === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
      root.querySelectorAll('[data-left-body]').forEach(b => { b.hidden = b.dataset.leftBody !== tab; });
      if (tab === 'library') libPanel.render();
      if (tab === 'add') palette.render();
    }
    function insertComponent(cid, at) {
      const c = library.components.find(x => x.id === cid);
      if (!c) return;
      if (at) {
        const text = JSON.stringify(Object.assign({ kind: 'metacode-survey-elements', v: 1, from: 'library' }, c.snapshot));
        store.select([]);
        cmds.paste(text, at);
      } else cmds.insertSnapshot(c.snapshot);
      App.notify('Inserted “' + c.name + '”', 'success');
    }

    const QUESTION_TYPES = Object.values(Core.TYPES).filter(t => t.category === 'question');
    function buildToolbar() {
      const tb = $('.ss-toolbar');
      const tool = (t, ic, label, key) => '<button type="button" class="ss-tool" data-tool="' + t + '" title="' + label + ' (' + key + ')" aria-label="' + label + '" aria-pressed="false">' + icon(ic) + '</button>';
      const btn = (act, ic, label, extra) => '<button type="button" class="ss-tool" data-act="' + act + '" title="' + label + '" aria-label="' + label.replace(/\s*\(.*\)$/, '') + '"' + (extra || '') + '>' + icon(ic) + '</button>';
      tb.innerHTML =
        '<div class="ss-tool-group">' + tool('select', I.select, 'Select', 'V') + tool('hand', I.hand, 'Hand — pan the canvas', 'H') + tool('scale', I.scale, 'Scale — handles change scale, not size', 'K') +
          tool('rect', I.rect, 'Shape — drag to draw', 'R') + tool('frame', I.frame, 'Container — drag to draw', 'F') + '</div>' +
        '<div class="ss-tool-group"><button type="button" class="ss-tool ss-tool-wide" data-act="add-question" title="Add a question (Q)" aria-haspopup="menu">' + icon(I.question) + '<span>Question</span></button>' +
          '<button type="button" class="ss-tool ss-tool-wide" data-tool="text" title="Text — click or drag on the page (T)" aria-label="Text" aria-pressed="false">' + icon(I.text) + '<span>Text</span></button>' +
          '<button type="button" class="ss-tool ss-tool-wide" data-act="add-image" title="Add an image" aria-label="Add an image">' + icon(I.image) + '<span>Image</span></button></div>' +
        '<div class="ss-tool-hint" data-needs="none">Click to select · double-click to go inside</div>' +
        '<div class="ss-tool-group" data-needs="free">' + btn('align-left', I.alignL, 'Align left') + btn('align-center', I.alignC, 'Align centres') + btn('align-right', I.alignR, 'Align right') +
          btn('align-top', I.alignT, 'Align top') + btn('align-middle', I.alignM, 'Align middles') + btn('align-bottom', I.alignB, 'Align bottom') +
          btn('dist-h', I.distH, 'Distribute horizontally') + btn('dist-v', I.distV, 'Distribute vertically') + '</div>' +
        '<div class="ss-tool-group" data-needs="sel">' + btn('group', I.group, 'Group (Ctrl+G)') + btn('ungroup', I.ungroup, 'Ungroup (Ctrl+Shift+G)') +
          btn('front', I.front, 'Bring to front (Ctrl+Shift+])') + btn('forward', I.up, 'Bring forward (Ctrl+])') + btn('backward', I.down, 'Send backward (Ctrl+[)') + btn('back', I.toBack, 'Send to back (Ctrl+Shift+[)') +
          btn('duplicate', I.dup, 'Duplicate (Ctrl+D)') + btn('delete', I.trash, 'Delete (Del)') + '</div>' +
        '<div class="ss-tool-spacer"></div>' +
        '<div class="ss-tool-group">' + btn('tidy', I.tidy, 'Tidy page — stack elements without overlaps') + btn('grid', I.grid, 'Show grid', ' aria-pressed="false"') + btn('snap', I.magnet, 'Snap to guides', ' aria-pressed="true"') + '</div>' +
        '<div class="ss-tool-group">' + btn('zoom-out', I.minus, 'Zoom out (Ctrl+-)') + '<button type="button" class="ss-zoom" id="ss-zoom-label" data-act="zoom-menu" title="Zoom options" aria-haspopup="menu">100%</button>' + btn('zoom-in', I.plus, 'Zoom in (Ctrl+=)') + '</div>';
      tb.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.tool) { canvas.setTool(b.dataset.tool); return; }
        const sel = store.selection;
        switch (b.dataset.act) {
          case 'add-question': menuAt(b, QUESTION_TYPES.map(t => [t.label, () => cmds.addElement(t.type), false, t.icon])); break;
          case 'add-image': { const id = cmds.addElement('image'); if (id) setTimeout(() => { const f = root.querySelector('.ss-field-image input'); if (f) f.focus(); }, 60); break; }
          case 'align-left': cmds.align(sel, 'left'); break; case 'align-center': cmds.align(sel, 'center'); break; case 'align-right': cmds.align(sel, 'right'); break;
          case 'align-top': cmds.align(sel, 'top'); break; case 'align-middle': cmds.align(sel, 'middle'); break; case 'align-bottom': cmds.align(sel, 'bottom'); break;
          case 'dist-h': cmds.distribute(sel, 'h'); break; case 'dist-v': cmds.distribute(sel, 'v'); break;
          case 'group': cmds.group(); break; case 'ungroup': cmds.ungroup(); break;
          case 'front': cmds.reorder(sel, 'front'); break; case 'forward': cmds.reorder(sel, 'forward'); break; case 'backward': cmds.reorder(sel, 'backward'); break; case 'back': cmds.reorder(sel, 'back'); break;
          case 'duplicate': cmds.duplicate(); break; case 'delete': cmds.deleteSelection(); break;
          case 'tidy': tidyPage(); break;
          case 'grid': { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-on', on); canvas.setGrid(on); break; }
          case 'snap': { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-on', on); canvas.setSnap(on); break; }
          case 'zoom-in': canvas.zoomIn(); break; case 'zoom-out': canvas.zoomOut(); break;
          case 'zoom-menu': menuAt(b, [['Zoom to fit (Shift+1)', () => canvas.fit()], ['Fit width', () => canvas.fitWidth()], ['50%', () => canvas.zoomTo(0.5)], ['100% (Ctrl+0)', () => canvas.zoomTo(1)], ['150%', () => canvas.zoomTo(1.5)], ['200%', () => canvas.zoomTo(2)], ['400%', () => canvas.zoomTo(4)]]); break;
          default: break;
        }
      });
      tb.querySelector('[data-act="snap"]').classList.add('is-on');
      updateToolbarState();
    }
    function updateToolbarState() {
      if (!canvas) return;
      const tb = $('.ss-toolbar');
      tb.querySelectorAll('[data-tool]').forEach(b => { const on = b.dataset.tool === canvas.tool; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
      const sel = store.selection;
      const anyFree = sel.length && sel.every(id => doc().elements[id] && cmds.isFreeIn(id));
      // Arrange tools appear only when they apply, so the bar stays short and calm
      tb.querySelectorAll('[data-needs="free"]').forEach(g => { g.hidden = !anyFree; });
      tb.querySelectorAll('[data-needs="free"] [data-act^="dist"]').forEach(b => { b.hidden = sel.length < 3; });
      tb.querySelectorAll('[data-needs="sel"]').forEach(g => { g.hidden = !sel.length; });
      tb.querySelectorAll('[data-needs="none"]').forEach(g => { g.hidden = !!sel.length || canvas.tool !== 'select'; });
    }

    // Stacks the page's free elements top to bottom without overlaps.
    function tidyPage() {
      const page = store.page;
      const items = page.children.map(id => doc().elements[id]).filter(el => el && !el.hidden && el.frame.dock !== 'bottom' && !el.locked)
        .map(el => ({ el, box: cmds.boxOf(el.id) })).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
      if (!items.length) return;
      let y = Math.max(24, Math.min(...items.map(i => i.box.y)));
      store.tx('Tidy page', t => items.forEach(it => {
        const e = t.el(it.el.id);
        const offset = num(e.frame.y, 0) - it.box.y;
        e.frame.y = Math.round(y + offset);
        y += (it.box.b - it.box.y) + 24;
      }));
      App.notify('Page tidied — undo with Ctrl+Z if you prefer the old layout', 'info');
    }
    const num = Core.num;

    /* ── Page bar ────────────────────── */
    function renderPageBar() {
      const bar = $('.ss-pagebar');
      if (!bar) return;
      bar.innerHTML = doc().pages.map((p, i) => '<button type="button" role="tab" class="ss-pagetab' + (p.id === store.pageId ? ' is-on' : '') + '" data-page="' + esc(p.id) + '" aria-selected="' + (p.id === store.pageId) + '">' + (i + 1) + '. ' + esc(p.name) + (p.props && p.props.ending ? ' ⚑' : '') + '</button>').join('') +
        '<button type="button" class="ss-pagetab ss-pagetab-add" data-act="add-page" title="Add page" aria-label="Add page">+ Page</button>';
      bar.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.page) store.setPage(b.dataset.page); else if (b.dataset.act === 'add-page') cmds.addPage(store.pageId); };
      bar.oncontextmenu = e => { const b = e.target.closest('[data-page]'); if (!b) return; e.preventDefault(); pageMenu(b.dataset.page, b); };
    }
    function pageMenu(pid, anchor) {
      const p = Core.getPage(doc(), pid);
      const i = doc().pages.indexOf(p);
      menuAt(anchor, [
        ['Rename…', () => { const n = prompt('Page name', p.name); if (n && n.trim()) cmds.updatePage(pid, x => { x.name = n.trim().slice(0, 200); }, 'Rename page'); }],
        ['Duplicate page', () => cmds.duplicatePage(pid)],
        ['Add page after', () => cmds.addPage(pid)],
        i > 0 ? ['Move left / up', () => cmds.movePage(pid, -1)] : null,
        i < doc().pages.length - 1 ? ['Move right / down', () => cmds.movePage(pid, 1)] : null,
        [p.props && p.props.ending ? 'Make a normal page' : 'Make an ending page', () => cmds.updatePage(pid, x => { x.props.ending = !(x.props && x.props.ending); }, 'Ending page')],
        null,
        doc().pages.length > 1 ? ['Delete page…', () => { if (confirm('Delete “' + p.name + '” and everything on it?')) cmds.deletePage(pid); }, true] : null
      ]);
    }

    /* ── Context menu ────────────────── */
    function contextMenu(e, info) {
      const sel = store.selection;
      const has = sel.length > 0;
      const one = sel.length === 1 ? doc().elements[sel[0]] : null;
      const parent = one && doc().elements[one.parent];
      const fake = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) };
      menuAt(fake, [
        has ? ['Cut', () => cmds.copy(null, true), false, null, 'Ctrl+X'] : null,
        has ? ['Copy', () => cmds.copy(), false, null, 'Ctrl+C'] : null,
        ['Paste here', () => cmds.paste(null, info.at), false, null, 'Ctrl+V'],
        has ? ['Duplicate', () => cmds.duplicate(), false, null, 'Ctrl+D'] : null,
        has ? ['Delete', () => cmds.deleteSelection(), true, null, 'Del'] : null,
        null,
        one && canvas && canvas.startEdit && ['heading', 'paragraph', 'label', 'richtext', 'instructions', 'caption', 'qtitle', 'qdesc', 'optlabel', 'button', 'rankitem', 'matrixrow', 'qerror'].includes(one.type) ? ['Edit text', () => canvas.startEdit(one.id), false, null, 'Enter'] : null,
        parent ? ['Select parent', () => store.select([parent.id]), false, null, 'Esc'] : null,
        has ? ['Group', () => cmds.group(), false, null, 'Ctrl+G'] : null,
        one && Core.isContainerType(one.type) && !Core.isQuestionType(one.type) ? ['Ungroup', () => cmds.ungroup(), false, null, 'Ctrl+Shift+G'] : null,
        has ? ['Bring to front', () => cmds.reorder(sel, 'front'), false, null, 'Ctrl+Shift+]'] : null,
        has ? ['Send to back', () => cmds.reorder(sel, 'back'), false, null, 'Ctrl+Shift+['] : null,
        null,
        one ? ['Copy style', () => cmds.copyStyle(), false, null, 'Ctrl+Alt+C'] : null,
        has ? ['Paste style', () => cmds.pasteStyle(), false, null, 'Ctrl+Alt+V'] : null,
        one ? ['Reset style to theme', () => store.tx('Reset style', t => { t.el(one.id).style = {}; })] : null,
        has ? ['Save as component…', () => { setLeft('library'); root.querySelector('[data-act="save-comp"]') && root.querySelector('[data-act="save-comp"]').click(); }] : null,
        null,
        has ? [sel.every(id => doc().elements[id].locked) ? 'Unlock' : 'Lock', () => cmds.setFlag(sel, 'locked'), false, null, 'Ctrl+Shift+L'] : null,
        has ? ['Hide', () => cmds.setFlag(sel, 'hidden', true), false, null, 'Ctrl+Shift+H'] : null,
        one && (Core.isQuestionType(one.type) || one.type === 'button') ? ['Add logic for this…', () => setMode('logic', true)] : null
      ]);
    }

    /* ── Keyboard shortcuts ──────────── */
    const isTyping = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    function onKey(e) {
      if (!document.body.contains(root)) return;
      if (document.getElementById('modal-backdrop').classList.contains('is-open')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (mod && k.toLowerCase() === 's') { e.preventDefault(); store.flush({ force: true }).then(() => App.notify('Saved', 'success', 1500)).catch(err => App.notify(err.conflict ? 'This survey was changed elsewhere — click the save status to resolve.' : err.message, 'error')); return; }
      if (isTyping(e.target)) return;
      if (mod && !e.shiftKey && k.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
      if ((mod && e.shiftKey && k.toLowerCase() === 'z') || (mod && k.toLowerCase() === 'y')) { e.preventDefault(); doRedo(); return; }
      if (mode !== 'design' || !canvas) return;
      if (canvas.editing) return;
      const sel = store.selection;
      if (k === '?' ) { e.preventDefault(); shortcutsDialog(); return; }
      if (mod && e.altKey && k.toLowerCase() === 'c') { e.preventDefault(); cmds.copyStyle(); return; }
      if (mod && e.altKey && k.toLowerCase() === 'v') { e.preventDefault(); cmds.pasteStyle(); return; }
      if (mod && k.toLowerCase() === 'c') { if (sel.length) { e.preventDefault(); cmds.copy(); } return; }
      if (mod && k.toLowerCase() === 'x') { if (sel.length) { e.preventDefault(); cmds.copy(null, true); } return; }
      if (mod && k.toLowerCase() === 'd') { e.preventDefault(); cmds.duplicate(); return; }
      if (mod && k.toLowerCase() === 'a') { e.preventDefault(); const scope = sel.length ? doc().elements[sel[0]].parent : 'page:' + store.pageId; store.select(Core.childIds(doc(), scope).filter(id => !doc().elements[id].locked && !doc().elements[id].hidden)); return; }
      if (mod && k.toLowerCase() === 'g') { e.preventDefault(); if (e.shiftKey) cmds.ungroup(); else cmds.group(); return; }
      if (mod && (k === ']' || k === '}')) { e.preventDefault(); cmds.reorder(sel, e.shiftKey ? 'front' : 'forward'); return; }
      if (mod && (k === '[' || k === '{')) { e.preventDefault(); cmds.reorder(sel, e.shiftKey ? 'back' : 'backward'); return; }
      if (mod && e.shiftKey && k.toLowerCase() === 'h') { e.preventDefault(); cmds.setFlag(sel, 'hidden'); return; }
      if (mod && e.shiftKey && k.toLowerCase() === 'l') { e.preventDefault(); cmds.setFlag(sel, 'locked'); return; }
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); canvas.zoomIn(); return; }
      if (mod && k === '-') { e.preventDefault(); canvas.zoomOut(); return; }
      if (mod && k === '0') { e.preventDefault(); canvas.zoomTo(1); return; }
      if (e.shiftKey && (k === '!' || k === '1') && !mod) { e.preventDefault(); canvas.fit(); return; }
      if (k === 'Delete' || k === 'Backspace') { if (sel.length) { e.preventDefault(); cmds.deleteSelection(); } return; }
      if (k.startsWith('Arrow')) {
        if (!sel.length) return;
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        cmds.nudge(sel, k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0);
        return;
      }
      if (k === 'Escape') {
        e.preventDefault();
        if (canvas.tool !== 'select') { canvas.setTool('select'); return; }
        if (sel.length) { const p = doc().elements[sel[0]].parent; store.select(p && doc().elements[p] ? [p] : []); }
        return;
      }
      if (k === 'Enter' && sel.length === 1) {
        e.preventDefault();
        const el = doc().elements[sel[0]];
        if (el.children && el.children.length) store.select([el.children[0]]);
        else canvas.startEdit(el.id);
        return;
      }
      if (!mod && !e.altKey) {
        const tools = { v: 'select', h: 'hand', k: 'scale', t: 'text', r: 'rect', f: 'frame' };
        if (tools[k.toLowerCase()]) { e.preventDefault(); canvas.setTool(tools[k.toLowerCase()]); return; }
        if (k.toLowerCase() === 'q') { e.preventDefault(); root.querySelector('[data-act="add-question"]').click(); return; }
        if (k === ' ' && !e.repeat) { e.preventDefault(); canvas.setSpace(true); }
      }
    }
    function onKeyUp(e) { if (e.key === ' ' && canvas) canvas.setSpace(false); }
    function onPaste(e) {
      if (mode !== 'design' || !cmds || isTyping(e.target) || (canvas && canvas.editing)) return;
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      e.preventDefault();
      if (text && cmds.readClipboard(text)) cmds.paste(text);
      else if (text && text.trim() && !cmds.readClipboard(null)) {
        // plain text from elsewhere → a new paragraph
        const id = cmds.addElement('paragraph');
        if (id) store.tx('Paste text', t => { t.el(id).props.text = text.slice(0, 20000); });
      } else cmds.paste(null);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('paste', onPaste);
    cleanup.push(() => { document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp); document.removeEventListener('paste', onPaste); });

    const beforeUnload = e => { if (store.saveState.dirty) { store.writeBackup(); e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    cleanup.push(() => window.removeEventListener('beforeunload', beforeUnload));

    function shortcutsDialog() {
      const rows = [['V / H / K', 'Select · Hand · Scale tool'], ['T / R / F', 'Draw text · shape · container'], ['Q', 'Add a question'], ['Space + drag', 'Pan'], ['Ctrl + wheel / pinch', 'Zoom'],
        ['Ctrl+= / Ctrl+- / Ctrl+0 / Shift+1', 'Zoom in · out · 100% · fit'], ['Double-click', 'Go into a group/question · edit text'], ['Ctrl-click', 'Select the deepest element'],
        ['Enter / Esc', 'Select child or edit text · select parent'], ['Arrows (Shift)', 'Nudge 1px (10px); reorder in stacks'], ['Alt + drag', 'Duplicate while dragging'],
        ['Shift + drag handle', 'Keep proportions · rotate in 15° steps'], ['Alt + drag handle', 'Resize from the centre'],
        ['Ctrl+C / X / V / D', 'Copy · cut · paste · duplicate'], ['Ctrl+Alt+C / V', 'Copy · paste style'], ['Ctrl+G / Ctrl+Shift+G', 'Group · ungroup'],
        ['Ctrl+] / [ (Shift)', 'Forward · backward (front · back)'], ['Ctrl+Shift+H / L', 'Hide · lock'], ['Ctrl+A', 'Select all at this level'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo · redo'], ['Ctrl+S', 'Save now']];
      App.openModal('Keyboard shortcuts', '<table class="table ss-keys-table"><tbody>' + rows.map(([k, d]) => '<tr><td><kbd>' + esc(k) + '</kbd></td><td>' + esc(d) + '</td></tr>').join('') + '</tbody></table>', '<button class="btn btn-primary" onclick="App.closeModal()">Close</button>');
    }

    /* ── Conflict / backup ───────────── */
    function conflictDialog() {
      App.openModal('This survey changed somewhere else', '<p class="form-hint">It was saved from another tab or window after you opened it. Choose which version to keep — the other is not merged.</p>',
        '<button class="btn btn-secondary" id="ss-c-reload">Load the other version</button><button class="btn btn-danger" id="ss-c-keep">Keep mine (overwrite)</button>');
      document.getElementById('ss-c-reload').onclick = async () => {
        try { const r = (await api('/' + doc().id)).survey; store.revision = r.revision; store.publish = r.publish; store.replaceDoc(r.doc, { label: 'Load other version' }); await store.flush({ overwrite: true }); App.closeModal(); App.notify('Loaded the other version (Ctrl+Z restores yours)', 'info'); } catch (e) { App.notify(e.message, 'error'); }
      };
      document.getElementById('ss-c-keep').onclick = () => { store.flush({ overwrite: true }).then(() => { App.closeModal(); App.notify('Your version was saved', 'success'); }).catch(e => App.notify(e.message, 'error')); };
    }
    const backup = store.readBackup();
    if (backup && backup.baseRevision === store.revision && JSON.stringify(backup.doc) !== JSON.stringify(doc())) {
      setTimeout(() => {
        App.openModal('Restore unsaved changes?', '<p class="form-hint">This computer has changes to this survey from ' + esc(new Date(backup.savedAt).toLocaleString()) + ' that never reached the server (for example because the connection dropped).</p>',
          '<button class="btn btn-secondary" id="ss-b-discard">Discard them</button><button class="btn btn-primary" id="ss-b-restore">Restore</button>');
        document.getElementById('ss-b-restore').onclick = () => { store.replaceDoc(backup.doc, { label: 'Restore unsaved changes' }); App.closeModal(); App.notify('Changes restored', 'success'); };
        document.getElementById('ss-b-discard').onclick = () => { store.clearBackup(); App.closeModal(); };
      }, 50);
    } else if (backup) store.clearBackup();

    /* ── Theme view ──────────────────── */
    const THEME_TYPES = [['qtitle', 'Question titles'], ['qdesc', 'Question descriptions'], ['option', 'Answer options'], ['indicator', 'Radio / checkbox indicators'], ['optlabel', 'Option labels'],
      ['field', 'Inputs'], ['button', 'Buttons'], ['heading', 'Headings'], ['paragraph', 'Paragraphs'], ['instructions', 'Instructions'], ['qerror', 'Validation messages'], ['rankitem', 'Ranking items'], ['matrixrow', 'Matrix rows'], ['container', 'Containers'], ['section', 'Sections']];
    let themeType = 'option';
    function renderTheme() {
      const box = $('.ss-view-theme');
      const t = doc().theme.tokens;
      const s = doc().settings;
      const colorTokens = Core.TOKENS.filter(x => x.kind === 'color');
      box.innerHTML = '<div class="ss-theme">' +
        '<section class="ss-card"><div class="ss-card-head"><span>Colours</span><button type="button" class="ss-chip-btn" data-act="reset-tokens">Reset to MetaCode palette</button></div><div class="ss-token-grid">' +
          colorTokens.map(x => '<label class="ss-token"><button type="button" class="ss-swatch" data-token="' + x.key + '" style="--c:' + esc(t[x.key]) + '" aria-label="' + esc(x.label) + '"></button><span>' + esc(x.label) + '</span><input class="ss-input is-mono" data-token-in="' + x.key + '" value="' + esc(t[x.key]) + '" aria-label="' + esc(x.label) + ' value"></label>').join('') +
        '</div></section>' +
        '<section class="ss-card"><div class="ss-card-head"><span>Fonts & shape</span></div><div class="ss-token-grid">' +
          Core.TOKENS.filter(x => x.kind !== 'color').map(x => '<label class="ss-token ss-token-wide"><span>' + esc(x.label) + '</span>' + (x.kind === 'font'
            ? '<select class="ss-select" data-token-in="' + x.key + '">' + Core.FONTS.filter(f => !/^var/.test(f.value)).map(f => '<option value="' + esc(f.value) + '"' + (f.value === t[x.key] ? ' selected' : '') + '>' + esc(f.label) + '</option>').join('') + (Core.FONTS.some(f => f.value === t[x.key]) ? '' : '<option selected value="' + esc(t[x.key]) + '">' + esc(t[x.key]) + '</option>') + '</select>'
            : '<input class="ss-input" type="number" min="0" data-token-in="' + x.key + '" value="' + esc(t[x.key]) + '">') + '</label>').join('') +
        '</div></section>' +
        '<section class="ss-card ss-theme-types"><div class="ss-card-head"><span>Element defaults</span><select class="ss-select" id="ss-theme-type" aria-label="Element type">' + THEME_TYPES.map(([k, l]) => '<option value="' + k + '"' + (k === themeType ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>' +
          '<p class="ss-empty-note">Changes here apply to every element of this type that doesn\'t override the property itself. Properties set on an element always win.</p><div id="ss-theme-fields"></div></section>' +
        '<section class="ss-card"><div class="ss-card-head"><span>Survey settings</span></div><div class="ss-settings">' +
          setting('title', 'Title', 'text', doc().title) + setting('description', 'Description (internal)', 'text', doc().description) +
          setting('settings.width', 'Design width (px)', 'number', s.width) +
          '<label class="ss-setting"><span>On smaller screens</span><select class="ss-select" data-setting="settings.responsive"><option value="reflow"' + (s.responsive === 'reflow' ? ' selected' : '') + '>Scale, then stack elements on phones</option><option value="scale"' + (s.responsive === 'scale' ? ' selected' : '') + '>Scale the whole design down</option><option value="fixed"' + (s.responsive === 'fixed' ? ' selected' : '') + '>Keep the exact size (scroll)</option></select></label>' +
          setting('settings.reflowBelow', 'Stack below width (px)', 'number', s.reflowBelow) +
          setting('settings.nextLabel', 'Next button label', 'text', s.nextLabel) + setting('settings.backLabel', 'Back button label', 'text', s.backLabel) + setting('settings.submitLabel', 'Submit button label', 'text', s.submitLabel) +
          setting('settings.allowBack', 'Allow going back', 'check', s.allowBack !== false) +
          setting('settings.completionTitle', 'Completion title', 'text', s.completionTitle) + setting('settings.completionMessage', 'Completion message', 'text', s.completionMessage) +
          setting('settings.keepHiddenAnswers', 'Keep answers to questions hidden by logic', 'check', !!s.keepHiddenAnswers) +
          setting('settings.grid', 'Editor grid size (px)', 'number', s.grid) +
        '</div></section>' +
        '<section class="ss-card"><div class="ss-card-head"><span>Share this theme</span></div><p class="ss-empty-note">Copy the theme to another survey: export here, then import there.</p><div class="ss-btn-row"><button type="button" class="ss-chip-btn" data-act="export-theme">Copy theme JSON</button><button type="button" class="ss-chip-btn" data-act="import-theme">Import theme JSON…</button></div></section>' +
      '</div>';
      renderThemeFields();
      box.onclick = e => {
        const sw = e.target.closest('[data-token]');
        if (sw) { const k = sw.dataset.token; inspectorColor(sw, t[k], v => setToken(k, resolveTokenValue(v))); return; }
        const b = e.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'reset-tokens') store.tx('Reset theme colours', tx => { tx.part('theme').tokens = Core.defaultTokens(); }), renderTheme();
        if (b.dataset.act === 'export-theme') copyText(JSON.stringify(doc().theme, null, 2), 'Theme JSON copied');
        if (b.dataset.act === 'import-theme') {
          const raw = prompt('Paste theme JSON');
          if (!raw) return;
          try { const th = JSON.parse(raw); if (!th || typeof th !== 'object' || !th.tokens) throw new Error('Not a Survey Studio theme'); store.tx('Import theme', tx => { const theme = tx.part('theme'); theme.tokens = Object.assign(Core.defaultTokens(), th.tokens); theme.types = th.types || {}; theme.page = th.page || {}; }); renderTheme(); App.notify('Theme imported', 'success'); }
          catch (err) { App.notify('Couldn\'t import: ' + err.message, 'error'); }
        }
      };
      box.onchange = e => {
        const el = e.target;
        if (el.dataset.tokenIn) setToken(el.dataset.tokenIn, el.type === 'number' ? Number(el.value) : Core.cleanValue(el.value));
        else if (el.id === 'ss-theme-type') { themeType = el.value; renderThemeFields(); }
        else if (el.dataset.setting) {
          const path = el.dataset.setting;
          let v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
          if (path === 'settings.width') v = Math.max(240, Math.min(4000, Number(v) || 760));
          if (path === 'title' || path === 'description') store.tx('Edit survey', tx => tx.set(path, String(v).slice(0, 300)));
          else store.tx('Survey settings', tx => { const st = tx.part('settings'); Core.setPath(st, path.slice(9), v); });
          if (path === 'title') { titleInput.value = doc().title; setDocTitle(doc().title); }
        }
      };
    }
    function resolveTokenValue(v) { const m = /^var\(--sv-(\w+)\)$/.exec(v); return m ? doc().theme.tokens[m[1]] : v; }
    function inspectorColor(anchor, v, cb) { ensureDesignQuiet(); inspector.openColor(anchor, v, cb); }
    function ensureDesignQuiet() { if (!inspector) { ensureDesign(); } }
    function setToken(k, v) { store.tx('Theme: ' + k, tx => { tx.part('theme').tokens[k] = v; }, { coalesce: 'token-' + k }); const sw = $('[data-token="' + k + '"]'); if (sw) sw.style.setProperty('--c', v); const inp = $('[data-token-in="' + k + '"]'); if (inp && document.activeElement !== inp) inp.value = v; }
    function setting(path, label, kind, value) {
      if (kind === 'check') return '<label class="ss-setting ss-setting-check"><input type="checkbox" data-setting="' + path + '"' + (value ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
      return '<label class="ss-setting"><span>' + esc(label) + '</span><input class="ss-input" type="' + (kind === 'number' ? 'number' : 'text') + '" data-setting="' + path + '" value="' + esc(value) + '"></label>';
    }
    function renderThemeFields() {
      const host = $('#ss-theme-fields');
      if (!host) return;
      const cur = Core.deepMerge(Core.builtinStyle(themeType), doc().theme.types[themeType] || {});
      const own = doc().theme.types[themeType] || {};
      const f = [['fill', 'Fill', 'color'], ['color', 'Text colour', 'color'], ['borderColor', 'Border colour', 'color'], ['borderWidth', 'Border width', 'number'], ['radius', 'Corner radius', 'number'],
        ['fontFamily', 'Font', 'font'], ['fontSize', 'Font size', 'number'], ['fontWeight', 'Font weight', 'text'], ['markColor', 'Mark / accent colour', 'color'],
        ['states.hover.fill', 'Hover fill', 'color'], ['states.hover.borderColor', 'Hover border', 'color'], ['states.checked.fill', 'Selected fill', 'color'], ['states.checked.borderColor', 'Selected border', 'color']];
      host.innerHTML = '<div class="ss-theme-fields">' + f.map(([p, l, k]) => {
        const v = Core.getPath(own, p), inh = Core.getPath(Core.builtinStyle(themeType), p);
        const shown = v !== undefined ? v : inh;
        const resolved = String(shown === undefined ? '' : shown).replace(/var\(--sv-(\w+)\)/g, (m, key) => doc().theme.tokens[key] || '');
        return '<label class="ss-setting"><span>' + (v !== undefined ? '<button type="button" class="ss-dot is-set" data-reset="' + p + '" title="Reset to the built-in default" aria-label="Reset ' + esc(l) + '"></button>' : '<span class="ss-dot" title="Built-in default"></span>') + esc(l) + '</span>' +
          (k === 'color' ? '<span class="ss-inline"><button type="button" class="ss-swatch ss-swatch-sm" data-tcolor="' + p + '" style="--c:' + esc(resolved) + '" aria-label="Choose ' + esc(l) + '"></button><input class="ss-input" data-tpath="' + p + '" value="' + esc(v === undefined ? '' : v) + '" placeholder="' + esc(inh === undefined ? '' : inh) + '"></span>'
            : k === 'font' ? '<select class="ss-select" data-tpath="' + p + '">' + Core.FONTS.map(fo => '<option value="' + esc(fo.value) + '"' + (fo.value === shown ? ' selected' : '') + '>' + esc(fo.label) + '</option>').join('') + '</select>'
              : '<input class="ss-input" data-tpath="' + p + '" ' + (k === 'number' ? 'type="number"' : '') + ' value="' + esc(v === undefined ? '' : v) + '" placeholder="' + esc(inh === undefined ? '' : inh) + '">') + '</label>';
      }).join('') + '</div>';
      void cur;
      host.onchange = e => { const p = e.target.dataset.tpath; if (!p) return; const raw = e.target.value; setTypeStyle(p, raw === '' ? undefined : (e.target.type === 'number' ? Number(raw) : Core.cleanValue(raw))); };
      host.onclick = e => {
        const r = e.target.closest('[data-reset]'); if (r) { e.preventDefault(); setTypeStyle(r.dataset.reset, undefined); return; }
        const c = e.target.closest('[data-tcolor]'); if (c) { e.preventDefault(); inspectorColor(c, '', v => setTypeStyle(c.dataset.tcolor, v)); }
      };
    }
    function setTypeStyle(path, value) {
      store.tx('Theme: ' + themeType + ' style', tx => { const th = tx.part('theme'); th.types[themeType] = th.types[themeType] || {}; Core.setPath(th.types[themeType], path, value); });
      renderThemeFields();
    }

    /* ── Preview view ────────────────── */
    let device = 'desktop', startPage = '';
    let lastPayload = null;
    function renderPreview() {
      const box = $('.ss-view-preview');
      box.innerHTML = '<div class="ss-preview"><div class="ss-preview-bar">' +
        '<div class="ss-seg" role="radiogroup" aria-label="Device">' + [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Mobile']].map(([d, l]) => '<button type="button" class="ss-seg-btn' + (d === device ? ' is-on' : '') + '" data-device="' + d + '" role="radio" aria-checked="' + (d === device) + '">' + l + '</button>').join('') + '</div>' +
        '<label class="ss-inline-label">Start on <select class="ss-select" id="ss-pv-start"><option value="">first page</option>' + doc().pages.map(p => '<option value="' + esc(p.id) + '"' + (p.id === startPage ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></label>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="ss-pv-reset">↺ Restart test</button>' +
        '<span class="ss-preview-note">Test mode — answers and submissions are not recorded.</span></div>' +
        '<div class="ss-preview-body"><div class="ss-device ss-device-' + device + '"><div class="ss-device-screen" id="ss-pv-host"></div></div>' +
        '<aside class="ss-testpanel" id="ss-testpanel" aria-label="Test panel"></aside></div></div>';
      box.onclick = e => {
        const d = e.target.closest('[data-device]');
        if (d) { device = d.dataset.device; renderPreview(); return; }
        if (e.target.id === 'ss-pv-reset') mountPreview();
      };
      $('#ss-pv-start').onchange = e => { startPage = e.target.value; mountPreview(); };
      mountPreview();
    }
    function mountPreview() {
      if (previewRT) { previewRT.destroy(); previewRT = null; }
      lastPayload = null;
      const host = $('#ss-pv-host');
      if (!host) return;
      host.style.background = doc().theme.tokens.background;
      previewRT = SurveyRuntime.mount(host, Core.clone(doc()), {
        mode: 'preview',
        onSubmit: payload => { lastPayload = payload; return Promise.resolve({ test: true }); },
        onDebug: info => renderTestPanel(info)
      });
      if (startPage) previewRT.goTo(startPage);
    }
    function renderTestPanel(info) {
      const p = $('#ss-testpanel');
      if (!p) return;
      const fmt = v => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
      p.innerHTML = '<div class="ss-tp-sec"><div class="ss-tp-h">Now</div><div class="ss-tp-kv"><span>Page</span><b>' + esc(info.page.name) + '</b></div><div class="ss-tp-kv"><span>Path</span><b>' + esc(info.path.join(' → ')) + '</b></div>' +
        '<div class="ss-tp-kv"><span>Score</span><b>' + esc(info.score) + '</b></div>' + (info.finished ? '<div class="ss-tp-done">✓ Submitted (test — not recorded)</div>' : '') + '</div>' +
        '<div class="ss-tp-sec"><div class="ss-tp-h">Answers</div>' + (info.answers.length ? '<table class="ss-tp-table">' + info.answers.map(a => '<tr' + (a.visible ? '' : ' class="is-hidden" title="Hidden by logic — not submitted"') + '><td><code>' + esc(a.key) + '</code></td><td>' + esc(fmt(a.value)) + '</td></tr>').join('') + '</table>' : '<p class="ss-empty-note">No answers yet.</p>') + '</div>' +
        '<div class="ss-tp-sec"><div class="ss-tp-h">Variables</div>' + (Object.keys(info.vars).length ? '<table class="ss-tp-table">' + Object.keys(info.vars).map(k => '<tr><td><code>' + esc(k) + '</code></td><td>' + esc(fmt(info.vars[k])) + '</td></tr>').join('') + '</table>' : '<p class="ss-empty-note">No variables.</p>') + '</div>' +
        '<div class="ss-tp-sec"><div class="ss-tp-h">Rules active now</div>' + (info.fired.length ? '<ul class="ss-tp-list">' + info.fired.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '<p class="ss-empty-note">None.</p>') + '</div>' +
        (info.errors.length ? '<div class="ss-tp-sec"><div class="ss-tp-h">Validation</div><ul class="ss-tp-list is-err">' + info.errors.map(e => '<li><b>' + esc(e.label) + ':</b> ' + esc(e.message) + '</li>').join('') + '</ul></div>' : '') +
        '<div class="ss-tp-sec"><div class="ss-tp-h">Event log</div><ul class="ss-tp-log">' + info.log.slice().reverse().map(l => '<li><span>' + esc(l.t) + '</span>' + esc(l.text) + '</li>').join('') + '</ul></div>' +
        (lastPayload ? '<div class="ss-tp-sec"><div class="ss-tp-h">Submitted data</div><pre class="ss-tp-pre">' + esc(JSON.stringify({ answers: lastPayload.answers, score: lastPayload.score, path: lastPayload.path, outcome: lastPayload.outcome }, null, 2)) + '</pre></div>' : '');
    }

    /* ── Responses view ──────────────── */
    async function renderResponses() {
      const box = $('.ss-view-responses');
      box.innerHTML = '<div class="ss-responses"><div class="loading-state">Loading responses…</div></div>';
      let list;
      try { list = (await api('/' + doc().id + '/responses')).responses; } catch (e) { box.innerHTML = '<div class="empty-state"><div class="empty-title">Couldn\'t load responses</div><div class="empty-sub">' + esc(e.message) + '</div></div>'; return; }
      if (mode !== 'responses') return;
      const qs = Core.questionsInOrder(doc());
      const keys = qs.map(q => Core.dataKeyOf(doc(), q));
      const extra = Array.from(new Set(list.flatMap(r => Object.keys(r.byKey || {})))).filter(k => !keys.includes(k));
      const cols = keys.concat(extra);
      const done = list.filter(r => r.status === 'complete');
      const durs = done.map(r => (Date.parse(r.completedAt) - Date.parse(r.startedAt)) / 1000).filter(x => x >= 0 && x < 86400 * 3);
      const med = durs.length ? durs.sort((a, b) => a - b)[Math.floor(durs.length / 2)] : null;
      const p = store.publish;
      let html = '<div class="ss-responses"><div class="ss-resp-head"><div><h2 class="ss-logic-h">Responses</h2><p class="ss-logic-sub">' + (p && !p.unpublished ? 'Collecting at <a href="/s/' + esc(p.publicId) + '" target="_blank" rel="noopener">' + esc(location.origin + '/s/' + p.publicId) + '</a>' : 'Publish the survey to start collecting responses.') + '</p></div>' +
        '<div class="ss-btn-row"><button type="button" class="btn btn-secondary btn-sm" data-act="refresh">↻ Refresh</button><button type="button" class="btn btn-secondary btn-sm" data-act="csv"' + (list.length ? '' : ' disabled') + '>Export CSV</button><button type="button" class="btn btn-secondary btn-sm" data-act="json"' + (list.length ? '' : ' disabled') + '>Export JSON</button>' +
        '<button type="button" class="btn btn-teal btn-sm" data-act="to-project"' + (done.length ? '' : ' disabled') + ' title="Turn text answers into project posts for coding">Add text answers to project</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="clear"' + (list.length ? '' : ' disabled') + '>Delete all</button></div></div>' +
        '<div class="ss-resp-stats"><div class="stat-card"><div class="stat-num">' + done.length + '</div><div class="stat-label">Completed</div></div>' +
        '<div class="stat-card"><div class="stat-num">' + (list.length - done.length) + '</div><div class="stat-label">In progress / abandoned</div></div>' +
        '<div class="stat-card"><div class="stat-num">' + (list.length ? Math.round(done.length / list.length * 100) : 0) + '%</div><div class="stat-label">Completion rate</div></div>' +
        '<div class="stat-card"><div class="stat-num">' + (med === null ? '—' : (med < 60 ? Math.round(med) + 's' : Math.round(med / 60) + 'm')) + '</div><div class="stat-label">Median time</div></div></div>';
      if (!list.length) html += '<div class="card"><div class="empty-state"><div class="empty-title">No responses yet</div><div class="empty-sub">Responses appear here as soon as people submit the published survey.</div></div></div>';
      else {
        html += '<div class="ss-resp-summary">' + qs.map(q => summaryCard(q, done)).join('') + '</div>';
        html += '<div class="card"><div class="card-title">All responses</div><div class="table-wrap"><table class="table ss-resp-table"><thead><tr><th>Response</th><th>Status</th><th>Version</th><th>Submitted</th><th>Score</th>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '<th></th></tr></thead><tbody>' +
          list.slice().reverse().map(r => '<tr><td><code>' + esc(r.id) + '</code></td><td>' + (r.status === 'complete' ? '<span class="badge badge-green">Complete</span>' : '<span class="badge badge-amber">In progress</span>') + '</td><td>v' + r.version + '</td><td title="' + esc(r.completedAt || r.updatedAt) + '">' + rel(r.completedAt || r.updatedAt) + '</td><td>' + esc(r.score) + '</td>' +
            cols.map(c => '<td class="ss-resp-cell">' + esc(cell(r.byKey ? r.byKey[c] : undefined)) + '</td>').join('') + '<td><button type="button" class="ss-icon-btn" data-del="' + esc(r.id) + '" aria-label="Delete response ' + esc(r.id) + '">✕</button></td></tr>').join('') +
          '</tbody></table></div></div>';
      }
      box.innerHTML = html + '</div>';
      box.onclick = async e => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        if (b.dataset.act === 'refresh') renderResponses();
        if (b.dataset.act === 'csv') {
          const header = ['response_id', 'status', 'version', 'started_at', 'completed_at', 'score'].concat(cols);
          App.downloadCSV(Core.slug(doc().title, 'survey') + '-responses.csv', header, list.map(r => [r.id, r.status, r.version, r.startedAt, r.completedAt || '', r.score].concat(cols.map(c => cell(r.byKey ? r.byKey[c] : undefined)))));
        }
        if (b.dataset.act === 'json') download(Core.slug(doc().title, 'survey') + '-responses.json', JSON.stringify({ survey: { id: doc().id, title: doc().title }, responses: list }, null, 2), 'application/json');
        if (b.dataset.act === 'clear') { if (!confirm('Delete all ' + list.length + ' responses? This can\'t be undone.')) return; try { await api('/' + doc().id + '/responses', { method: 'DELETE' }); renderResponses(); } catch (err) { App.notify(err.message, 'error'); } }
        if (b.dataset.del) { if (!confirm('Delete this response?')) return; try { await api('/' + doc().id + '/responses/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); renderResponses(); } catch (err) { App.notify(err.message, 'error'); } }
        if (b.dataset.act === 'to-project') toProject(done, qs);
      };
    }
    function cell(v) { if (v === undefined || v === null) return ''; if (Array.isArray(v)) return v.join('; '); if (typeof v === 'object') return Object.keys(v).map(k => k + '=' + v[k]).join('; '); return String(v); }
    function summaryCard(q, done) {
      const kind = Logic.valueKind(q);
      const answered = done.filter(r => r.answers && r.answers[q.id] !== undefined);
      let body = '';
      if (kind === 'choice' || kind === 'multi') {
        const ch = Logic.choicesOf(doc(), q);
        const counts = ch.map(c => answered.filter(r => { const v = r.answers[q.id]; return Array.isArray(v) ? v.some(x => String(x) === String(c.value)) : String(v) === String(c.value); }).length);
        const max = Math.max(1, ...counts);
        body = '<ul class="ss-bars">' + ch.map((c, i) => '<li><span class="ss-bar-label">' + esc(c.label || c.value) + '</span><span class="ss-hbar"><span style="width:' + (counts[i] / max * 100) + '%"></span></span><span class="ss-bar-n">' + counts[i] + '</span></li>').join('') + '</ul>';
      } else if (kind === 'number') {
        const nums = answered.map(r => Number(r.answers[q.id])).filter(Number.isFinite);
        body = nums.length ? '<div class="ss-tp-kv"><span>Average</span><b>' + (Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 100) / 100) + '</b></div><div class="ss-tp-kv"><span>Range</span><b>' + Math.min(...nums) + ' – ' + Math.max(...nums) + '</b></div>' : '';
      } else if (kind === 'text') {
        body = '<ul class="ss-quotes">' + answered.slice(-3).reverse().map(r => '<li>' + esc(String(r.answers[q.id]).slice(0, 160)) + '</li>').join('') + '</ul>';
      }
      return '<div class="ss-sum-card"><div class="ss-sum-title">' + esc(Core.displayName(doc(), q)) + '</div><div class="ss-sum-sub">' + answered.length + ' of ' + done.length + ' answered</div>' + body + '</div>';
    }
    function toProject(done, qs) {
      const textQs = qs.filter(q => Logic.valueKind(q) === 'text');
      if (!textQs.length) { App.notify('This survey has no text questions.', 'info'); return; }
      App.openModal('Add answers to the project', '<p class="form-hint" style="margin-bottom:10px">Each non-empty answer becomes a post you can code in AI Coding and Human Coding.</p><div class="form-group"><label class="form-label" for="ss-tp-q">Question</label><select class="form-select" id="ss-tp-q">' +
        textQs.map(q => '<option value="' + esc(q.id) + '">' + esc(Core.displayName(doc(), q)) + '</option>').join('') + '</select></div>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-teal" id="ss-tp-go">Add posts</button>');
      document.getElementById('ss-tp-go').onclick = () => {
        const qid = document.getElementById('ss-tp-q').value;
        const state = App.getState();
        const existing = new Set(state.posts.map(p => p.id));
        const posts = done.filter(r => r.answers && typeof r.answers[qid] === 'string' && r.answers[qid].trim()).map(r => ({
          id: 'survey_' + r.id + '_' + qid, text: r.answers[qid], author: 'response ' + r.id, timestamp: (r.completedAt || r.updatedAt || '').slice(0, 16).replace('T', ' '),
          engagement: {}, humanCodes: {}, aiCodes: {}, source: 'survey:' + doc().id
        })).filter(p => !existing.has(p.id));
        App.setState({ posts: state.posts.concat(posts) });
        App.closeModal();
        App.notify(posts.length ? posts.length + ' post' + (posts.length === 1 ? '' : 's') + ' added to the project' : 'Those answers are already in the project', posts.length ? 'success' : 'info');
        const stat = document.getElementById('stat-posts'); if (stat) stat.textContent = App.getState().posts.length;
      };
    }

    /* ── Publishing ──────────────────── */
    $('#ss-publish').addEventListener('click', publishDialog);
    async function publishDialog() {
      if (canvas && canvas.editing) canvas.finishEdit(true);
      const problems = Logic.ruleProblems(doc());
      const errs = problems.filter(p => p.level !== 'warning');
      const qs = Core.questionsInOrder(doc());
      const p = store.publish;
      const live = p && !p.unpublished;
      const changed = live && store.revision > (p.publishedRevision || 0) || (live && store.saveState.dirty);
      const url = live ? location.origin + '/s/' + p.publicId : '';
      const checks = [
        [qs.length > 0, qs.length + ' question' + (qs.length === 1 ? '' : 's') + ' on ' + doc().pages.length + ' page' + (doc().pages.length === 1 ? '' : 's')],
        [errs.length === 0, errs.length ? errs.length + ' logic problem' + (errs.length === 1 ? '' : 's') + ' (open Logic to fix)' : 'Logic checked — no problems'],
        [qs.every(q => ['choice', 'multi'].indexOf(Logic.valueKind(q)) === -1 || Logic.choicesOf(doc(), q).length > 0), 'Every choice question has options']
      ];
      App.openModal(live ? 'Your survey is published' : 'Publish this survey',
        (live ? '<div class="ss-pub-link"><input class="form-input" readonly value="' + esc(url) + '" id="ss-pub-url" aria-label="Survey link"><button class="btn btn-secondary btn-sm" id="ss-pub-copy">Copy</button><a class="btn btn-secondary btn-sm" href="' + esc(url) + '" target="_blank" rel="noopener">Open</a></div>' +
          '<p class="form-hint" style="margin:8px 0 14px">Version ' + p.version + ', published ' + esc(rel(p.publishedAt)) + '. ' + (changed ? '<b>You have changes that respondents don\'t see yet.</b>' : 'Respondents see the latest version.') + ' Respondents need to reach this MetaCode server — share it on a network they can access.</p>' +
          '<label class="ss-check-row"><input type="checkbox" id="ss-pub-open"' + (p.open ? ' checked' : '') + '> Accepting responses</label>'
          : '<p class="form-hint" style="margin-bottom:12px">Publishing creates a snapshot of the survey as it is now (version 1) and a link for respondents. You can keep editing afterwards; publish again to update the link\'s version. Responses record which version they answered.</p>') +
        '<ul class="ss-checks">' + checks.map(([ok, t]) => '<li class="' + (ok ? 'is-ok' : 'is-bad') + '">' + (ok ? '✓' : '!') + ' ' + esc(t) + '</li>').join('') + '</ul>' +
        (errs.length ? '<ul class="ss-tp-list is-err">' + errs.slice(0, 6).map(x => '<li>' + esc(x.message) + '</li>').join('') + '</ul>' : '') + '<div class="form-error" id="ss-pub-err"></div>',
        (live ? '<button class="btn btn-ghost" id="ss-pub-unpub">Unpublish</button>' : '') + (errs.length ? '<button class="btn btn-secondary" id="ss-pub-logic">Open Logic</button>' : '') +
        '<button class="btn btn-secondary" onclick="App.closeModal()">' + (live ? 'Close' : 'Cancel') + '</button>' +
        '<button class="btn btn-primary" id="ss-pub-go"' + (errs.length ? ' disabled' : '') + '>' + (live ? (changed ? 'Publish changes (v' + (p.version + 1) + ')' : 'Republish') : 'Publish') + '</button>');
      const go = document.getElementById('ss-pub-go');
      if (go) go.onclick = async () => {
        go.disabled = true; go.textContent = 'Publishing…';
        const err = document.getElementById('ss-pub-err');
        try {
          await store.flush({ force: false });
          const r = await api('/' + doc().id + '/publish', { method: 'POST', body: {} });
          store.revision = r.revision;
          store.publish = r.publish;
          App.notify('Published version ' + r.publish.version, 'success');
          publishDialog();
        } catch (e) {
          go.disabled = false; go.textContent = 'Publish';
          err.textContent = e.data && e.data.problems ? e.message + ' ' + e.data.problems.map(x => x.message).join(' ') : (e.conflict ? 'This survey was changed elsewhere — resolve that first (click the save status).' : e.message);
        }
      };
      const copy = document.getElementById('ss-pub-copy');
      if (copy) copy.onclick = () => copyText(url, 'Link copied');
      const open = document.getElementById('ss-pub-open');
      if (open) open.onchange = async () => { try { store.publish = (await api('/' + doc().id + '/publish', { method: 'PATCH', body: { open: open.checked } })).publish; App.notify(open.checked ? 'Accepting responses' : 'Responses paused', 'info'); } catch (e) { App.notify(e.message, 'error'); open.checked = !open.checked; } };
      const unpub = document.getElementById('ss-pub-unpub');
      if (unpub) unpub.onclick = async () => { if (!confirm('Unpublish? The link stops working until you publish again. Responses are kept.')) return; try { store.publish = (await api('/' + doc().id + '/publish', { method: 'DELETE' })).publish; App.closeModal(); App.notify('Unpublished', 'info'); } catch (e) { App.notify(e.message, 'error'); } };
      const lg = document.getElementById('ss-pub-logic');
      if (lg) lg.onclick = () => { App.closeModal(); setMode('logic', true); };
    }

    /* ── Start ───────────────────────── */
    renderSave(); renderUndo(); renderPubState();
    setMode(initialMode || 'design', false);

    return {
      id: doc().id, root, store,
      setMode: m => setMode(m, false),
      destroy() {
        if (store.saveState.dirty) store.flush().catch(() => {});
        if (previewRT) previewRT.destroy();
        if (logicUI) logicUI.destroy();
        cleanup.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
        store.destroy();
        container.classList.remove('is-flush');
      }
    };
  }

  /* ══ Small UI helpers ════════════════════════ */
  let openMenu = null;
  function menuAt(anchor, items) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'ss-menu ss-menu-float';
    m.setAttribute('role', 'menu');
    items.forEach(it => {
      if (it === null) { if (m.lastChild && !m.lastChild.classList.contains('ss-menu-sep')) { const s = document.createElement('div'); s.className = 'ss-menu-sep'; m.appendChild(s); } return; }
      if (!it) return;
      const [label, fn, danger, ic, key] = it;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ss-menu-item' + (danger ? ' is-danger' : ''); b.setAttribute('role', 'menuitem');
      b.innerHTML = (ic ? icon(ic) : '') + '<span>' + esc(label) + '</span>' + (key ? '<kbd>' + esc(key) + '</kbd>' : '');
      b.addEventListener('click', () => { closeMenu(); fn(); });
      m.appendChild(b);
    });
    if (m.lastChild && m.lastChild.classList.contains('ss-menu-sep')) m.lastChild.remove();
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left)) + 'px';
    m.style.top = (r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
    openMenu = m;
    const first = m.querySelector('button'); if (first) first.focus();
    m.addEventListener('keydown', e => {
      const btns = Array.from(m.querySelectorAll('button'));
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    });
    setTimeout(() => document.addEventListener('pointerdown', outsideMenu, true), 0);
  }
  function outsideMenu(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; document.removeEventListener('pointerdown', outsideMenu, true); } }
  function copyText(text, msg) {
    const done = () => App.notify(msg || 'Copied', 'success', 1800);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallback());
    else fallback();
    function fallback() { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { prompt('Copy:', text); } ta.remove(); }
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { render, current: () => current };
})();
