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
  const MODES = [['design', 'Design'], ['logic', 'Logic'], ['theme', 'Theme'], ['settings', 'Settings'], ['preview', 'Preview'], ['responses', 'Responses']];
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
    tour: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
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

  /* ══ Survey list (the Survey Studio dashboard) ═══════════ */
  // Search, status filter and sort are remembered in this browser.
  const LIST_PREF_KEY = 'metacode_ss_list';
  const listPrefs = (() => { try { return Object.assign({ q: '', status: 'all', sort: 'updated' }, JSON.parse(localStorage.getItem(LIST_PREF_KEY) || '{}')); } catch (e) { return { q: '', status: 'all', sort: 'updated' }; } })();
  const saveListPrefs = () => { try { localStorage.setItem(LIST_PREF_KEY, JSON.stringify(listPrefs)); } catch (e) { /* private window */ } };
  let listCache = null;

  function statusOf(s) {
    const p = s.publish;
    if (!p) return 'draft';
    if (p.unpublished) return 'unpublished';
    return p.open ? 'live' : 'closed';
  }
  function statusBadge(s) {
    const p = s.publish, st = statusOf(s);
    const b = st === 'draft' ? '<span class="badge badge-gray">Draft</span>' : st === 'unpublished' ? '<span class="badge badge-gray">Unpublished</span>'
      : st === 'live' ? '<span class="badge badge-green">Live · v' + p.version + '</span>' : '<span class="badge badge-amber">Closed · v' + p.version + '</span>';
    const changed = p && !p.unpublished && s.revision > (p.publishedRevision || 0) ? ' <span class="badge badge-blue" title="Saved changes that aren\'t published yet">Edited</span>' : '';
    return b + changed;
  }

  async function renderList(container) {
    container.classList.remove('is-flush');
    container.innerHTML = '<div class="ssd">' +
      '<div class="view-header ssd-head"><div><h1 class="view-title">Surveys</h1><div class="view-subtitle">Design a survey, publish a link, then inspect every response. Drafts stay in this browser; published versions and their responses are kept on this MetaCode server.</div></div>' +
        '<div class="view-actions"><button class="btn btn-secondary" id="ss-import">Import JSON</button><button class="btn btn-primary" id="ss-new">' + icon(I.plus) + 'Create survey</button></div></div>' +
      '<div id="ss-legacy"></div>' +
      '<div class="ssd-stats" id="ss-stats" hidden></div>' +
      '<div class="card ss-list-card">' +
        '<div class="ssd-toolbar" id="ss-toolbar" hidden>' +
          '<label class="ssd-search"><span class="sr-only">Search surveys</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
            '<input type="search" id="ss-search" placeholder="Search by title or description" autocomplete="off" value="' + esc(listPrefs.q) + '"></label>' +
          '<label class="ssd-select"><span>Status</span><select id="ss-filter">' + [['all', 'All'], ['live', 'Live'], ['draft', 'Draft'], ['closed', 'Closed'], ['unpublished', 'Unpublished']].map(([v, l]) => '<option value="' + v + '"' + (listPrefs.status === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
          '<label class="ssd-select"><span>Sort</span><select id="ss-sort">' + [['updated', 'Last edited'], ['created', 'Newest'], ['title', 'Name (A–Z)'], ['responses', 'Most responses']].map(([v, l]) => '<option value="' + v + '"' + (listPrefs.sort === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
          '<span class="ssd-count" id="ss-count" role="status" aria-live="polite"></span>' +
        '</div>' +
        '<div id="ss-list"><div class="loading-state">Loading surveys…</div></div>' +
      '</div>' +
      '<section class="ssd-templates" aria-labelledby="ssd-tpl-h"><div class="ssd-sec-head"><h2 id="ssd-tpl-h">Start from a template</h2><p>Each template is a complete, editable survey — questions, pages, logic and theme.</p></div><div class="ss-templates" id="ss-templates" aria-label="Start from a template"></div></section>' +
    '</div>';
    document.getElementById('ss-new').onclick = () => createFrom('blank');
    document.getElementById('ss-import').onclick = importDialog;
    const search = document.getElementById('ss-search');
    let searchTimer = null;
    search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { listPrefs.q = search.value; saveListPrefs(); drawList(); }, 120); };
    document.getElementById('ss-filter').onchange = e => { listPrefs.status = e.target.value; saveListPrefs(); drawList(); };
    document.getElementById('ss-sort').onchange = e => { listPrefs.sort = e.target.value; saveListPrefs(); drawList(); };
    const lib = await loadLibrary();
    const tpl = document.getElementById('ss-templates');
    if (!tpl) return;
    const all = SurveyTemplates.list.map(t => ({ id: t.id, name: t.name, description: t.description, builtin: true })).concat((lib.templates || []).map(t => ({ id: t.id, name: t.name, description: t.description || 'Your template', builtin: false })));
    tpl.innerHTML = all.map(t => '<button type="button" class="ss-tpl" data-tpl="' + esc(t.id) + '"><span class="ss-tpl-name">' + esc(t.name) + (t.builtin ? '' : ' <span class="badge badge-violet">Yours</span>') + '</span><span class="ss-tpl-desc">' + esc(t.description) + '</span></button>').join('');
    tpl.onclick = e => { const b = e.target.closest('[data-tpl]'); if (b) createFrom(b.dataset.tpl); };
    await refreshList();
  }

  // Surveys saved on the server by an older MetaCode (shared by everyone then)
  async function renderLegacy() {
    const box = document.getElementById('ss-legacy');
    if (!box) return;
    const old = await window.SurveyStore.legacy();
    const list = old.surveys || [];
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="ss-legacy"><div><b>' + list.length + ' survey' + (list.length === 1 ? '' : 's') + ' saved on this server by an older MetaCode</b>' +
      '<div class="ss-list-sub">Surveys now stay in your browser. Import ' + (list.length === 1 ? 'it' : 'them') + ' to keep editing — published links and responses keep working: ' +
      list.slice(0, 3).map(x => '“' + esc(x.title) + '”').join(', ') + (list.length > 3 ? '…' : '') + '</div></div>' +
      '<button type="button" class="btn btn-primary btn-sm" id="ss-legacy-go">Import into this browser</button></div>';
    document.getElementById('ss-legacy-go').onclick = async () => {
      try {
        const n = await window.SurveyStore.importLegacy(list.map(x => x.id), old.library);
        App.notify(n + ' survey' + (n === 1 ? '' : 's') + ' imported', 'success');
        libraryLoaded = false;
        renderList(document.getElementById('view-container'));
      } catch (e) { App.notify('Import failed: ' + e.message, 'error'); }
    };
  }

  async function refreshList() {
    const box = document.getElementById('ss-list');
    if (!box) return;
    renderLegacy();
    try { listCache = (await api('')).surveys; } catch (e) {
      listCache = null;
      box.innerHTML = '<div class="empty-state"><div class="empty-title">Couldn\'t load surveys</div><div class="empty-sub">' + esc(e.message) + ' Survey Studio needs the MetaCode server (npm start).</div><button type="button" class="btn btn-secondary" id="ss-retry">Try again</button></div>';
      const r = document.getElementById('ss-retry'); if (r) r.onclick = refreshList;
      return;
    }
    drawList();
  }

  function drawList() {
    const box = document.getElementById('ss-list');
    if (!box || !listCache) return;
    const surveys = listCache;
    const stats = document.getElementById('ss-stats'), bar = document.getElementById('ss-toolbar');
    if (!surveys.length) {
      if (stats) stats.hidden = true;
      if (bar) bar.hidden = true;
      box.innerHTML = '<div class="empty-state ssd-empty"><div class="empty-title">No surveys yet</div><div class="empty-sub">Create a blank survey, start from a template below, or learn Survey Studio by building your first survey step by step.</div>' +
        '<div class="ssd-empty-actions"><button type="button" class="btn btn-primary" id="ss-empty-new">' + icon(I.plus) + 'Create survey</button><button type="button" class="btn btn-secondary" id="ss-empty-tutorial">Start the tutorial</button></div></div>';
      document.getElementById('ss-empty-new').onclick = () => createFrom('blank');
      const tut = document.getElementById('ss-empty-tutorial');
      if (tut) tut.onclick = () => { if (window.StudioTutorial) window.StudioTutorial.start(true); };
      return;
    }
    if (bar) bar.hidden = false;
    if (stats) {
      const n = st => surveys.filter(x => statusOf(x) === st).length;
      const resp = surveys.reduce((a, x) => a + (x.completed || 0), 0);
      stats.hidden = false;
      stats.innerHTML = [[surveys.length, 'Surveys'], [n('live'), 'Live'], [n('draft'), 'Drafts'], [resp, 'Completed responses']]
        .map(([v, l]) => '<div class="ssd-stat"><b>' + v.toLocaleString() + '</b><span>' + l + '</span></div>').join('');
    }
    const q = listPrefs.q.trim().toLowerCase();
    let rows = surveys.filter(x => (listPrefs.status === 'all' || statusOf(x) === listPrefs.status) &&
      (!q || (x.title + ' ' + (x.description || '')).toLowerCase().includes(q)));
    const by = { updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)), created: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
      title: (a, b) => a.title.localeCompare(b.title), responses: (a, b) => (b.responses || 0) - (a.responses || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)) };
    rows = rows.sort(by[listPrefs.sort] || by.updated);
    const count = document.getElementById('ss-count');
    if (count) count.textContent = rows.length === surveys.length ? surveys.length + ' survey' + (surveys.length === 1 ? '' : 's') : rows.length + ' of ' + surveys.length + ' shown';
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state ssd-empty"><div class="empty-title">No surveys match</div><div class="empty-sub">Nothing matches ' + (q ? '“' + esc(listPrefs.q.trim()) + '”' : 'this filter') + (listPrefs.status !== 'all' ? ' with status “' + esc(listPrefs.status) + '”' : '') + '.</div><button type="button" class="btn btn-secondary" id="ss-clear-filters">Clear search and filter</button></div>';
      document.getElementById('ss-clear-filters').onclick = () => { listPrefs.q = ''; listPrefs.status = 'all'; saveListPrefs(); document.getElementById('ss-search').value = ''; document.getElementById('ss-filter').value = 'all'; drawList(); };
      return;
    }
    const quick = (id, m, l) => '<a class="ssd-quick" href="#' + esc(id) + '/' + m + '">' + l + '</a>';
    box.innerHTML = '<div class="table-wrap"><table class="table ss-table"><thead><tr><th>Survey</th><th>Status</th><th>Responses</th><th>Last edited</th><th>Go to</th><th><span class="sr-only">More</span></th></tr></thead><tbody>' +
      rows.map(s => {
        const p = s.publish;
        const inProgress = (s.responses || 0) - (s.completed || 0);
        return '<tr data-id="' + esc(s.id) + '"><td class="ssd-title-cell"><a href="#' + esc(s.id) + '" class="ss-list-title">' + esc(s.title) + '</a><div class="ss-list-sub">' +
            (s.description ? esc(s.description.slice(0, 120)) + ' · ' : '') + s.pages + ' page' + (s.pages === 1 ? '' : 's') + ' · ' + s.questions + ' question' + (s.questions === 1 ? '' : 's') + '</div></td>' +
          '<td>' + statusBadge(s) + '</td>' +
          '<td><span class="ssd-resp"><b>' + (s.completed || 0).toLocaleString() + '</b> completed</span>' + (inProgress > 0 ? '<span class="ss-list-sub">' + inProgress + ' in progress</span>' : '') + '</td>' +
          '<td title="' + esc(s.updatedAt) + '">' + rel(s.updatedAt) + '</td>' +
          '<td class="ssd-quicks">' + quick(s.id, 'design', 'Design') + quick(s.id, 'theme', 'Theme') + quick(s.id, 'preview', 'Preview') + quick(s.id, 'responses', 'Responses') + '</td>' +
          '<td class="ss-row-actions">' + (p && !p.unpublished ? '<a class="btn btn-ghost btn-sm" href="/s/' + esc(p.publicId) + '" target="_blank" rel="noopener">Open link</a>' : '') +
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
          if (!confirm('Delete “' + s.title + '”' + (s.responses ? ' and its ' + s.responses + ' response' + (s.responses === 1 ? '' : 's') : '') + '? It is deleted from this browser' + (s.publish ? ', and its link and responses are removed from the server (kept in its survey-data/trash folder)' : '') + '.')) return;
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
        '<button type="button" class="ss-icon-btn" id="ss-tour" title="Tutorial & tour" aria-label="Learn Survey Studio: tutorial and tour">' + icon(I.tour) + '</button>' +
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
        '<div class="ss-view ss-view-settings" data-view="settings"></div>' +
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
    $('#ss-tour').addEventListener('click', () => { if (window.StudioTutorial) window.StudioTutorial.chooser(); else if (window.Tour) window.Tour.start('studio-editor'); });

    function renderPubState() {
      const p = store.publish;
      const el = $('#ss-pub-state');
      if (!p || p.unpublished) { el.innerHTML = '<span class="badge badge-gray">Draft</span>'; $('#ss-publish').textContent = 'Publish'; return; }
      const changed = store.revision > (p.publishedRevision || 0);
      el.innerHTML = (p.open ? '<span class="badge badge-green">Live · v' + p.version + '</span>' : '<span class="badge badge-amber">Closed · v' + p.version + '</span>') + (changed ? ' <span class="badge badge-blue" title="Changes since the last publish">Unpublished changes</span>' : '');
      $('#ss-publish').textContent = changed ? 'Publish changes' : 'Published';
    }

    // Web fonts the survey uses are loaded for the canvas, preview and theme pages.
    if (window.SurveyFonts) SurveyFonts.ensureDoc(doc());
    let fontScan = null;
    cleanup.push(store.on((type, info) => {
      if (type === 'save' || type === 'saved') { renderSave(); renderPubState(); }
      if (type === 'change' && window.SurveyFonts) { clearTimeout(fontScan); fontScan = setTimeout(() => SurveyFonts.ensureDoc(doc()), 200); }
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
      if (themeRT && m !== 'theme') { themeRT.destroy(); themeRT = null; }
      if (window.SurveyFonts) window.SurveyFonts.closePicker(true);
      if (m === 'design') ensureDesign();
      if (m === 'logic') { if (!logicUI) logicUI = SurveyBlocks.create($('.ss-view-logic'), store, { notify: App.notify }); else logicUI.render(); }
      if (m === 'theme') renderTheme();
      if (m === 'settings') renderSettings();
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
    // Appearance only, in groups (typography, colours, background, layout,
    // questions, buttons, progress, advanced), with a live preview of the
    // survey that updates as settings change. Behaviour and privacy are in Settings.
    const THEME_TYPES = [['qtitle', 'Question titles'], ['qdesc', 'Question descriptions'], ['option', 'Answer options'], ['indicator', 'Radio / checkbox indicators'], ['optlabel', 'Option labels'],
      ['field', 'Inputs'], ['button', 'Buttons'], ['heading', 'Headings'], ['paragraph', 'Paragraphs'], ['instructions', 'Instructions'], ['qerror', 'Validation messages'], ['rankitem', 'Ranking items'], ['matrixrow', 'Matrix rows'], ['container', 'Containers'], ['section', 'Sections'], ['progress', 'Progress bar'], ['respondent', 'Respondent information']];
    const QUESTION_PARTS = ['qtitle', 'qdesc', 'option', 'indicator', 'optlabel', 'field', 'matrixrow', 'rankitem', 'qerror'];
    const COLOR_GROUPS = [['Brand & accents', ['primary', 'primaryHover', 'primaryLight', 'primaryMid', 'accent', 'accentLight', 'teal', 'tealLight', 'amber']],
      ['Text', ['text', 'text2', 'text3', 'onPrimary']], ['Surfaces & lines', ['surface', 'surface2', 'border']], ['Feedback', ['error', 'success']]];
    const THEME_FONTS = [{ name: 'Body (theme)', value: Core.tokenVar('fontBody'), note: 'The theme\'s body font' }, { name: 'Display (theme)', value: Core.tokenVar('fontDisplay'), note: 'The theme\'s display font' }];
    let themeType = 'option';
    let themeOpen = { typography: true, colors: true };
    let themePreview = { device: 'desktop', page: '' };
    let themeRT = null, themeTimer = null;
    const tokenOf = k => doc().theme.tokens[k];
    const resolveVar = v => String(v === undefined || v === null ? '' : v).replace(/var\(--sv-(\w+)\)/g, (m, key) => tokenOf(key) || '');
    const typeStyle = (type, path) => { const own = Core.getPath(doc().theme.types[type] || {}, path); return own !== undefined ? own : Core.getPath(Core.builtinStyle(type), path); };
    const ownTypeStyle = (type, path) => Core.getPath(doc().theme.types[type] || {}, path);
    // WCAG contrast ratio between two colours
    function contrast(a, b) {
      const rgb = c => { const ctx = document.createElement('canvas').getContext('2d'); ctx.fillStyle = '#000'; ctx.fillStyle = c; const v = ctx.fillStyle; const m = /^#([0-9a-f]{6})$/i.exec(v); if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)); const r = /rgba?\(([^)]+)\)/.exec(v); return r ? r[1].split(',').slice(0, 3).map(Number) : [0, 0, 0]; };
      const lum = c => { const [r, g, bl] = rgb(c).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    function renderTheme() {
      const box = $('.ss-view-theme');
      const t = doc().theme.tokens;
      const s = doc().settings;
      const sec = (id, title, sub, body) => '<section class="ss-th-sec' + (themeOpen[id] ? ' is-open' : '') + '" data-sec="' + id + '"><button type="button" class="ss-th-head" aria-expanded="' + !!themeOpen[id] + '" data-toggle="' + id + '"><span><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button><div class="ss-th-body"' + (themeOpen[id] ? '' : ' hidden') + '>' + body + '</div></section>';
      const fontBtn = (attr, value, label, hint) => '<div class="ss-th-row"><span class="ss-th-label">' + esc(label) + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span><button type="button" class="ss-select ss-font-btn" ' + attr + ' style="font-family:' + esc(/^var\(/.test(value) ? resolveVar(value) : value) + '">' + esc(SurveyFonts.labelOf(value, THEME_FONTS) || 'Inherit') + '</button></div>';
      const num = (attr, value, label, unit, placeholder) => '<label class="ss-th-row"><span class="ss-th-label">' + esc(label) + '</span><span class="ss-inline"><input class="ss-input ss-th-num" type="number" ' + attr + ' value="' + esc(value === undefined ? '' : value) + '" placeholder="' + esc(placeholder === undefined ? '' : placeholder) + '">' + (unit ? '<span class="ss-unit">' + unit + '</span>' : '') + '</span></label>';
      const colorRow = (attr, value, label, inherited) => '<div class="ss-th-row"><span class="ss-th-label">' + esc(label) + '</span><span class="ss-inline"><button type="button" class="ss-swatch ss-swatch-sm" ' + attr.replace('data-', 'data-sw-') + ' style="--c:' + esc(resolveVar(value || inherited)) + '" aria-label="Choose ' + esc(label) + '"></button><input class="ss-input is-mono" ' + attr + ' value="' + esc(value || '') + '" placeholder="' + esc(inherited || '') + '" aria-label="' + esc(label) + '"></span></div>';
      const tokenFont = (k, label, hint) => fontBtn('data-font-token="' + k + '"', t[k], label, hint);
      const typeFont = (type, label, hint) => fontBtn('data-font-type="' + type + '"', ownTypeStyle(type, 'fontFamily') || typeStyle(type, 'fontFamily'), label, hint);
      const typeNum = (type, path, label, unit) => num('data-type-num="' + type + '|' + path + '"', ownTypeStyle(type, path), label, unit, typeStyle(type, path));
      const typeColor = (type, path, label) => colorRow('data-type-color="' + type + '|' + path + '"', ownTypeStyle(type, path), label, typeStyle(type, path));
      const tokenSwatch = k => { const x = Core.TOKENS.find(y => y.key === k); return '<label class="ss-token"><button type="button" class="ss-swatch" data-token="' + k + '" style="--c:' + esc(t[k]) + '" aria-label="' + esc(x.label) + '"></button><span>' + esc(x.label) + '</span><input class="ss-input is-mono" data-token-in="' + k + '" value="' + esc(t[k]) + '" aria-label="' + esc(x.label) + ' value"></label>'; };
      const pg = doc().theme.page || {};
      const ratio = (a, b) => { const r = contrast(resolveVar(a), resolveVar(b)); return '<span class="ss-contrast' + (r >= 4.5 ? ' is-ok' : ' is-bad') + '" title="WCAG AA needs 4.5:1 for body text">' + r.toFixed(1) + ':1 ' + (r >= 4.5 ? '✓' : 'low') + '</span>'; };
      box.innerHTML = '<div class="ss-th">' +
        '<div class="ss-th-panel" aria-label="Theme settings">' +
          '<div class="ss-th-top"><div><h2 class="ss-logic-h">Theme</h2><p class="ss-logic-sub">How the survey looks. Changes show in the preview right away.</p></div></div>' +
          sec('typography', 'Typography', 'Fonts and text sizes',
            tokenFont('fontBody', 'Body text', 'Paragraphs, answers, inputs') + tokenFont('fontDisplay', 'Headings', 'Headings and question titles') +
            typeFont('qtitle', 'Question titles', 'Overrides Headings') + typeFont('button', 'Buttons', 'Overrides Body text') + tokenFont('fontMono', 'Monospace') +
            '<div class="ss-th-grid">' + typeNum('heading', 'fontSize', 'Heading size', 'px') + typeNum('qtitle', 'fontSize', 'Question title size', 'px') + typeNum('paragraph', 'fontSize', 'Body text size', 'px') + typeNum('optlabel', 'fontSize', 'Answer text size', 'px') + '</div>' +
            '<p class="ss-th-note">' + SurveyFonts.FONTS.length + ' fonts — sans-serif, serif, monospace, display, humanist, geometric and handwriting — searchable by name or style. Web fonts load from Google Fonts on the published survey.</p>') +
          sec('colors', 'Colours', 'The palette every element uses',
            COLOR_GROUPS.map(([g, keys]) => '<div class="ss-th-sub">' + esc(g) + '</div><div class="ss-token-grid">' + keys.map(tokenSwatch).join('') + '</div>').join('') +
            '<div class="ss-th-sub">Contrast</div><div class="ss-contrasts"><span>Text on surface ' + ratio(t.text, t.surface) + '</span><span>Secondary text ' + ratio(t.text2, t.surface) + '</span><span>Button text ' + ratio(t.onPrimary, t.primary) + '</span></div>' +
            '<div class="ss-btn-row"><button type="button" class="ss-chip-btn" data-act="reset-tokens">Reset to MetaCode palette</button></div>') +
          sec('background', 'Background', 'Page and survey card',
            '<div class="ss-th-sub">Page</div><div class="ss-token-grid">' + tokenSwatch('background') + '</div>' +
            '<div class="ss-th-sub">Survey card</div>' + colorRow('data-page="fill"', pg.fill, 'Card fill', 'var(--sv-surface)') + colorRow('data-page="borderColor"', pg.borderColor, 'Card border', 'var(--sv-border)') +
            num('data-page-num="borderWidth"', pg.borderWidth, 'Border width', 'px', 1) +
            '<label class="ss-th-row ss-check-row"><input type="checkbox" data-page-shadow' + (Array.isArray(pg.shadows) && !pg.shadows.length ? '' : ' checked') + '> Soft shadow</label>') +
          sec('layout', 'Layout & spacing', 'Width, corners, small screens',
            '<div class="ss-th-grid">' + num('data-setting="settings.width"', s.width, 'Design width', 'px') + num('data-token-num="radius"', t.radius, 'Corner radius', 'px') + num('data-token-num="radiusLarge"', t.radiusLarge, 'Card radius', 'px') + num('data-setting="settings.reflowBelow"', s.reflowBelow, 'Stack below', 'px') + '</div>' +
            '<label class="ss-th-row"><span class="ss-th-label">On smaller screens</span><select class="ss-select" data-setting="settings.responsive"><option value="reflow"' + (s.responsive === 'reflow' ? ' selected' : '') + '>Scale, then stack elements on phones</option><option value="scale"' + (s.responsive === 'scale' ? ' selected' : '') + '>Scale the whole design down</option><option value="fixed"' + (s.responsive === 'fixed' ? ' selected' : '') + '>Keep the exact size (scroll)</option></select></label>' +
            num('data-setting="settings.grid"', s.grid, 'Editor grid', 'px')) +
          sec('questions', 'Question styling', 'Titles, options, inputs, matrices',
            '<label class="ss-th-row"><span class="ss-th-label">Part</span><select class="ss-select" id="ss-theme-qtype">' + THEME_TYPES.filter(([k]) => QUESTION_PARTS.includes(k)).map(([k, l]) => '<option value="' + k + '"' + (k === (QUESTION_PARTS.includes(themeType) ? themeType : 'option') ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>' +
            '<div id="ss-theme-fields" data-scope="questions"></div>') +
          sec('buttons', 'Buttons & controls', 'Navigation buttons and their labels',
            typeColor('button', 'fill', 'Button fill') + typeColor('button', 'color', 'Button text') + typeColor('button', 'states.hover.fill', 'Hover fill') +
            '<div class="ss-th-grid">' + typeNum('button', 'radius', 'Corner radius', 'px') + typeNum('button', 'fontSize', 'Text size', 'px') + '</div>' +
            '<div class="ss-th-sub">Labels</div><div class="ss-th-grid">' + ['nextLabel', 'backLabel', 'submitLabel'].map(k => '<label class="ss-th-row"><span class="ss-th-label">' + { nextLabel: 'Next', backLabel: 'Back', submitLabel: 'Submit' }[k] + '</span><input class="ss-input" data-setting="settings.' + k + '" value="' + esc(s[k]) + '"></label>').join('') + '</div>') +
          sec('progress', 'Progress indicator', 'The progress bar element',
            typeColor('progress', 'fill', 'Track') + typeColor('progress', 'markColor', 'Fill') + typeNum('progress', 'radius', 'Roundness', 'px') +
            '<p class="ss-th-note">Add a progress bar from Design → Add → Interactive. It shows how much of the survey (pages the respondent will see) is done.</p>') +
          sec('advanced', 'Advanced', 'Defaults for any element type, theme JSON',
            '<label class="ss-th-row"><span class="ss-th-label">Element type</span><select class="ss-select" id="ss-theme-type" aria-label="Element type">' + THEME_TYPES.map(([k, l]) => '<option value="' + k + '"' + (k === themeType ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>' +
            '<p class="ss-th-note">Applies to every element of this type that doesn\'t set the property itself. Properties set on an element always win.</p><div id="ss-theme-fields-adv" data-scope="advanced"></div>' +
            '<div class="ss-th-sub">Share this theme</div><div class="ss-btn-row"><button type="button" class="ss-chip-btn" data-act="export-theme">Copy theme JSON</button><button type="button" class="ss-chip-btn" data-act="import-theme">Import theme JSON…</button></div>') +
        '</div>' +
        '<div class="ss-th-preview" aria-label="Live preview">' +
          '<div class="ss-th-pvbar"><span class="ss-th-pvlabel">Live preview</span><select class="ss-select" id="ss-th-page" aria-label="Page to preview">' + doc().pages.map(p => '<option value="' + esc(p.id) + '"' + (p.id === themePreview.page ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>' +
            '<div class="ss-seg" role="radiogroup" aria-label="Preview width">' + [['desktop', 'Desktop'], ['mobile', 'Phone']].map(([d, l]) => '<button type="button" class="ss-seg-btn' + (d === themePreview.device ? ' is-on' : '') + '" data-th-device="' + d + '" role="radio" aria-checked="' + (d === themePreview.device) + '">' + l + '</button>').join('') + '</div></div>' +
          '<div class="ss-th-stage"><div class="ss-th-frame is-' + themePreview.device + '"><div class="ss-th-host" id="ss-th-host"></div></div></div>' +
        '</div>' +
      '</div>';
      renderThemeFields();
      mountThemePreview();
      box.onclick = e => {
        const tg = e.target.closest('[data-toggle]');
        if (tg) { const id = tg.dataset.toggle; themeOpen[id] = !themeOpen[id]; const secEl = tg.closest('.ss-th-sec'); secEl.classList.toggle('is-open', themeOpen[id]); tg.setAttribute('aria-expanded', String(themeOpen[id])); secEl.querySelector('.ss-th-body').hidden = !themeOpen[id]; return; }
        const dv = e.target.closest('[data-th-device]');
        if (dv) { themePreview.device = dv.dataset.thDevice; box.querySelectorAll('[data-th-device]').forEach(b => { const on = b === dv; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); }); $('.ss-th-frame').className = 'ss-th-frame is-' + themePreview.device; mountThemePreview(); return; }
        const ft = e.target.closest('[data-font-token]');
        if (ft) { const k = ft.dataset.fontToken; SurveyFonts.openPicker(ft, { value: t[k], title: ft.closest('.ss-th-row').querySelector('.ss-th-label').firstChild.textContent + ' font', onPick: v => { setToken(k, v); renderTheme(); }, onPreview: v => previewFont(k, v) }); return; }
        const fty = e.target.closest('[data-font-type]');
        if (fty) { const type = fty.dataset.fontType; SurveyFonts.openPicker(fty, { value: ownTypeStyle(type, 'fontFamily') || typeStyle(type, 'fontFamily'), title: fty.closest('.ss-th-row').querySelector('.ss-th-label').firstChild.textContent + ' font', extra: THEME_FONTS, onPick: v => { setTypeStyleOf(type, 'fontFamily', v); renderTheme(); } }); return; }
        const sw = e.target.closest('[data-token]');
        if (sw) { const k = sw.dataset.token; inspectorColor(sw, t[k], v => { setToken(k, resolveTokenValue(v)); scheduleThemePreview(); }); return; }
        const swt = e.target.closest('[data-sw-type-color]');
        if (swt) { const [type, path] = swt.dataset.swTypeColor.split('|'); inspectorColor(swt, '', v => { setTypeStyleOf(type, path, v); renderTheme(); }); return; }
        const swp = e.target.closest('[data-sw-page]');
        if (swp) { inspectorColor(swp, '', v => { setPageStyle(swp.dataset.swPage, v); renderTheme(); }); return; }
        const b = e.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'reset-tokens') { store.tx('Reset theme colours', tx => { const th = tx.part('theme'); const d = Core.defaultTokens(); Core.TOKENS.filter(x => x.kind === 'color').forEach(x => { th.tokens[x.key] = d[x.key]; }); }); renderTheme(); }
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
        if (el.dataset.tokenIn) { setToken(el.dataset.tokenIn, Core.cleanValue(el.value)); renderTheme(); }
        else if (el.dataset.tokenNum) { setToken(el.dataset.tokenNum, Math.max(0, Math.min(200, Number(el.value) || 0))); scheduleThemePreview(); }
        else if (el.dataset.typeNum) { const [type, path] = el.dataset.typeNum.split('|'); setTypeStyleOf(type, path, el.value === '' ? undefined : Math.max(0, Math.min(400, Number(el.value)))); }
        else if (el.dataset.typeColor) { const [type, path] = el.dataset.typeColor.split('|'); setTypeStyleOf(type, path, el.value === '' ? undefined : Core.cleanValue(el.value)); renderTheme(); }
        else if (el.dataset.page) { setPageStyle(el.dataset.page, el.value === '' ? undefined : Core.cleanValue(el.value)); renderTheme(); }
        else if (el.dataset.pageNum) { setPageStyle(el.dataset.pageNum, el.value === '' ? undefined : Math.max(0, Math.min(20, Number(el.value)))); }
        else if (el.hasAttribute('data-page-shadow')) { setPageStyle('shadows', el.checked ? undefined : []); }
        else if (el.id === 'ss-theme-type') { themeType = el.value; renderThemeFields(); }
        else if (el.id === 'ss-theme-qtype') { themeType = el.value; renderThemeFields(); }
        else if (el.id === 'ss-th-page') { themePreview.page = el.value; mountThemePreview(); }
        else if (el.dataset.setting) {
          const path = el.dataset.setting;
          let v = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
          if (path === 'settings.width') v = Math.max(240, Math.min(4000, Number(v) || 760));
          if (path === 'settings.reflowBelow') v = Math.max(0, Math.min(4000, Number(v) || 640));
          if (path === 'settings.grid') v = Math.max(1, Math.min(200, Number(v) || 8));
          store.tx('Survey settings', tx => { const st = tx.part('settings'); Core.setPath(st, path.slice(9), v); });
          scheduleThemePreview();
        }
      };
    }
    // Live preview: the real survey runtime, re-mounted shortly after each change.
    function mountThemePreview() {
      const host = $('#ss-th-host');
      if (!host) return;
      if (themeRT) { themeRT.destroy(); themeRT = null; }
      SurveyFonts.ensureDoc(doc());
      host.style.background = doc().theme.tokens.background;
      themeRT = SurveyRuntime.mount(host, Core.clone(doc()), { mode: 'preview', onSubmit: () => Promise.resolve({ test: true }) });
      const pid = themePreview.page && doc().pages.some(p => p.id === themePreview.page) ? themePreview.page : null;
      if (pid) themeRT.goTo(pid);
    }
    function scheduleThemePreview() { clearTimeout(themeTimer); themeTimer = setTimeout(() => { if (mode === 'theme') mountThemePreview(); }, 150); }
    // Hovering fonts in the picker previews them on a copy of the survey (nothing is saved).
    let fontPreviewTimer = null;
    function previewFont(tokenKey, v) {
      clearTimeout(fontPreviewTimer);
      fontPreviewTimer = setTimeout(() => {
        const host = $('#ss-th-host');
        if (!host || mode !== 'theme') return;
        if (v === null) { mountThemePreview(); return; }
        SurveyFonts.ensure(v);
        const copy = Core.clone(doc());
        copy.theme.tokens[tokenKey] = v;
        if (themeRT) themeRT.destroy();
        themeRT = SurveyRuntime.mount(host, copy, { mode: 'preview', onSubmit: () => Promise.resolve({ test: true }) });
        const pid = themePreview.page && copy.pages.some(p => p.id === themePreview.page) ? themePreview.page : null;
        if (pid) themeRT.goTo(pid);
      }, 60);
    }
    function setPageStyle(path, value) { store.tx('Theme: survey card', tx => { const th = tx.part('theme'); th.page = th.page || {}; Core.setPath(th.page, path, value); }); scheduleThemePreview(); }
    function setTypeStyleOf(type, path, value) { store.tx('Theme: ' + type + ' style', tx => { const th = tx.part('theme'); th.types[type] = th.types[type] || {}; Core.setPath(th.types[type], path, value); }); scheduleThemePreview(); }
    function resolveTokenValue(v) { const m = /^var\(--sv-(\w+)\)$/.exec(v); return m ? doc().theme.tokens[m[1]] : v; }
    function inspectorColor(anchor, v, cb) { ensureDesignQuiet(); inspector.openColor(anchor, v, cb); }
    function ensureDesignQuiet() { if (!inspector) { ensureDesign(); } }
    function setToken(k, v) { store.tx('Theme: ' + k, tx => { tx.part('theme').tokens[k] = v; }, { coalesce: 'token-' + k }); const sw = $('[data-token="' + k + '"]'); if (sw) sw.style.setProperty('--c', v); const inp = $('[data-token-in="' + k + '"]'); if (inp && document.activeElement !== inp) inp.value = v; scheduleThemePreview(); }
    function setting(path, label, kind, value) {
      if (kind === 'check') return '<label class="ss-setting ss-setting-check"><input type="checkbox" data-setting="' + path + '"' + (value ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
      return '<label class="ss-setting"><span>' + esc(label) + '</span><input class="ss-input" type="' + (kind === 'number' ? 'number' : 'text') + '" data-setting="' + path + '" value="' + esc(value) + '"></label>';
    }
    function renderThemeFields() {
      ['#ss-theme-fields', '#ss-theme-fields-adv'].forEach(sel => {
        const host = $(sel);
        if (!host) return;
        const type = sel === '#ss-theme-fields' ? (QUESTION_PARTS.includes(themeType) ? themeType : ($('#ss-theme-qtype') ? $('#ss-theme-qtype').value : 'option')) : themeType;
        const own = doc().theme.types[type] || {};
        const f = [['fill', 'Fill', 'color'], ['color', 'Text colour', 'color'], ['borderColor', 'Border colour', 'color'], ['borderWidth', 'Border width', 'number'], ['radius', 'Corner radius', 'number'],
          ['fontFamily', 'Font', 'font'], ['fontSize', 'Font size', 'number'], ['fontWeight', 'Font weight', 'text'], ['markColor', 'Mark / accent colour', 'color'],
          ['states.hover.fill', 'Hover fill', 'color'], ['states.hover.borderColor', 'Hover border', 'color'], ['states.checked.fill', 'Selected fill', 'color'], ['states.checked.borderColor', 'Selected border', 'color']];
        host.innerHTML = '<div class="ss-theme-fields">' + f.map(([p, l, k]) => {
          const v = Core.getPath(own, p), inh = Core.getPath(Core.builtinStyle(type), p);
          const shown = v !== undefined ? v : inh;
          const resolved = resolveVar(shown);
          return '<label class="ss-setting"><span>' + (v !== undefined ? '<button type="button" class="ss-dot is-set" data-reset="' + p + '" title="Reset to the built-in default" aria-label="Reset ' + esc(l) + '"></button>' : '<span class="ss-dot" title="Built-in default"></span>') + esc(l) + '</span>' +
            (k === 'color' ? '<span class="ss-inline"><button type="button" class="ss-swatch ss-swatch-sm" data-tcolor="' + p + '" style="--c:' + esc(resolved) + '" aria-label="Choose ' + esc(l) + '"></button><input class="ss-input" data-tpath="' + p + '" value="' + esc(v === undefined ? '' : v) + '" placeholder="' + esc(inh === undefined ? '' : inh) + '"></span>'
              : k === 'font' ? '<button type="button" class="ss-select ss-font-btn" data-tfont="' + p + '" style="font-family:' + esc(resolveVar(shown)) + '">' + esc(SurveyFonts.labelOf(shown, THEME_FONTS.concat([{ name: 'Monospace (theme)', value: Core.tokenVar('fontMono') }])) || 'Inherit') + '</button>'
                : '<input class="ss-input" data-tpath="' + p + '" ' + (k === 'number' ? 'type="number"' : '') + ' value="' + esc(v === undefined ? '' : v) + '" placeholder="' + esc(inh === undefined ? '' : inh) + '">') + '</label>';
        }).join('') + '</div>';
        host.onchange = e => { e.stopPropagation(); const p = e.target.dataset.tpath; if (!p) return; const raw = e.target.value; setTypeStyleOf(type, p, raw === '' ? undefined : (e.target.type === 'number' ? Number(raw) : Core.cleanValue(raw))); renderThemeFields(); };
        host.onclick = e => {
          e.stopPropagation();
          const r = e.target.closest('[data-reset]'); if (r) { e.preventDefault(); setTypeStyleOf(type, r.dataset.reset, undefined); renderThemeFields(); return; }
          const c = e.target.closest('[data-tcolor]'); if (c) { e.preventDefault(); inspectorColor(c, '', v => { setTypeStyleOf(type, c.dataset.tcolor, v); renderThemeFields(); }); return; }
          const fo = e.target.closest('[data-tfont]'); if (fo) { e.preventDefault(); SurveyFonts.openPicker(fo, { value: Core.getPath(own, 'fontFamily') || Core.getPath(Core.builtinStyle(type), 'fontFamily'), title: 'Font', extra: THEME_FONTS, onPick: v => { setTypeStyleOf(type, 'fontFamily', v); renderThemeFields(); } }); }
        };
      });
    }
    function setTypeStyle(path, value) { setTypeStyleOf(themeType, path, value); renderThemeFields(); }
    void setTypeStyle;

    /* ── Settings view ───────────────── */
    // How the survey behaves and what it records about respondents.
    function renderSettings() {
      const box = $('.ss-view-settings');
      const s = doc().settings;
      const priv = Core.privacyOf(doc());
      const blocks = Object.values(doc().elements).filter(el => el && el.type === 'respondent');
      const collected = [];
      if (priv.entered.name) collected.push(['Name', 'Entered by the participant']);
      if (priv.entered.participantId) collected.push(['Participant code', 'Entered by the participant']);
      if (priv.link) collected.push(['Participant code', 'From the survey link (?' + priv.link.param + '=…) · ' + (priv.link.show ? 'shown to the participant' : 'researchers only')]);
      if (priv.derived.country) collected.push(['Country', 'Derived from the IP address by your proxy · approximate · researchers only']);
      if (priv.derived.region) collected.push(['State / region', 'Derived from the IP address by your proxy · approximate · researchers only']);
      if (priv.derived.ip) collected.push(['IP address', 'Derived by the server · researchers only']);
      const mode = s.sessionRecording || 'off';
      box.innerHTML = '<div class="ss-set">' +
        '<div class="ss-set-head"><h2 class="ss-logic-h">Settings</h2><p class="ss-logic-sub">Survey details, navigation, and what is recorded about respondents.</p></div>' +
        '<section class="ss-card"><div class="ss-card-head"><span>Survey</span></div><div class="ss-settings">' +
          setting('title', 'Title', 'text', doc().title) + setting('description', 'Description (internal)', 'text', doc().description) +
          setting('settings.allowBack', 'Allow going back', 'check', s.allowBack !== false) +
          setting('settings.keepHiddenAnswers', 'Keep answers to questions hidden by logic', 'check', !!s.keepHiddenAnswers) +
        '</div></section>' +
        '<section class="ss-card"><div class="ss-card-head"><span>When respondents finish</span></div><div class="ss-settings">' +
          setting('settings.completionTitle', 'Completion title', 'text', s.completionTitle) + setting('settings.completionMessage', 'Completion message', 'text', s.completionMessage) +
        '</div></section>' +
        '<section class="ss-card" id="ss-set-identity"><div class="ss-card-head"><span>Respondent identification</span><span class="badge ' + (collected.length ? 'badge-amber' : 'badge-green') + '">' + (collected.length ? 'Identifying data collected' : 'Anonymous') + '</span></div>' +
          (collected.length ? '<table class="ss-set-table"><thead><tr><th>Field</th><th>Source and visibility</th></tr></thead><tbody>' + collected.map(([a, b]) => '<tr><td>' + esc(a) + '</td><td>' + esc(b) + '</td></tr>').join('') + '</tbody></table>'
            : '<p class="ss-th-note">Responses are anonymous: nothing about the person or their connection is stored with their answers (besides device type and browser language).</p>') +
          '<p class="ss-th-note">' + (blocks.length ? 'Configured in ' + blocks.length + ' Respondent information block' + (blocks.length === 1 ? '' : 's') + ' (Design → select the block).' : 'To collect a participant code or name — or, if lawful and disclosed, IP-based location — add a Respondent information block.') + '</p>' +
          '<div class="ss-btn-row">' + (blocks.length ? '<button type="button" class="ss-chip-btn" data-act="select-resp">Show the block</button>' : '<button type="button" class="ss-chip-btn" data-act="add-resp">Add a Respondent information block</button>') + '</div>' +
        '</section>' +
        '<section class="ss-card"><div class="ss-card-head"><span>Session timeline</span><span class="badge ' + (mode === 'off' ? 'badge-gray' : 'badge-blue') + '">' + ({ off: 'Off', notice: 'Recorded with notice', consent: 'Recorded with consent' })[mode] + '</span></div>' +
          '<p class="ss-th-note">Records how each respondent moves through the survey — pages viewed, questions entered, answers selected or changed (the length only for typed text), skipped questions, validation messages, leaving and returning to the tab, submission or abandonment — so you can review response quality in Responses → Timeline. No mouse movement, keystrokes or browsing outside the survey are recorded.</p>' +
          '<div class="ss-seg ss-set-seg" role="radiogroup" aria-label="Session timeline">' + [['off', 'Off'], ['notice', 'Record and tell respondents'], ['consent', 'Ask respondents first']].map(([v, l]) => '<button type="button" class="ss-seg-btn' + (v === mode ? ' is-on' : '') + '" data-rec="' + v + '" role="radio" aria-checked="' + (v === mode) + '">' + esc(l) + '</button>').join('') + '</div>' +
          (mode !== 'off' ? '<label class="ss-setting ss-set-notice"><span>What respondents are told before they begin</span><textarea class="ss-input" rows="4" data-setting="settings.sessionNotice" placeholder="' + esc(Core.SESSION_NOTICE) + '">' + esc(s.sessionNotice || '') + '</textarea><small>Leave empty to use the text shown. With “Ask respondents first”, they choose between “Allow and start” and “Start without the timeline”.</small></label>' : '') +
        '</section>' +
      '</div>';
      box.onchange = e => {
        const el = e.target;
        if (!el.dataset.setting) return;
        const path = el.dataset.setting;
        const v = el.type === 'checkbox' ? el.checked : el.value;
        if (path === 'title' || path === 'description') store.tx('Edit survey', tx => tx.set(path, String(v).slice(0, path === 'title' ? 300 : 5000)));
        else store.tx('Survey settings', tx => { const st = tx.part('settings'); Core.setPath(st, path.slice(9), path === 'settings.sessionNotice' ? String(v).slice(0, 2000) : v); });
        if (path === 'title') { titleInput.value = doc().title; setDocTitle(doc().title); }
      };
      box.onclick = e => {
        const r = e.target.closest('[data-rec]');
        if (r) { store.tx('Session timeline: ' + r.dataset.rec, tx => { tx.part('settings').sessionRecording = r.dataset.rec; }); renderSettings(); return; }
        const b = e.target.closest('[data-act]'); if (!b) return;
        if (b.dataset.act === 'select-resp' && blocks.length) { setMode('design', true); const pg = Core.pageOf(doc(), blocks[0].id); if (pg) store.setPage(pg.id); store.select([blocks[0].id]); }
        if (b.dataset.act === 'add-resp') { setMode('design', true); if (cmds) { cmds.addElement('respondent'); App.notify('Respondent information block added — set its fields on the right', 'success'); } }
      };
    }

    /* ── Preview view ────────────────── */
    let device = 'desktop', startPage = '', landscape = false;
    let lastPayload = null;
    // Real device frames: a phone/tablet with its true screen size (CSS px),
    // status bar, camera and home indicator, or a browser window for desktop;
    // the screen scrolls inside and the whole device is scaled to fit.
    const DEVICES = {
      desktop: { w: 1280, h: 800, label: 'Desktop browser' },
      tablet: { w: 820, h: 1180, label: 'iPad-size tablet (820 × 1180)' },
      mobile: { w: 390, h: 844, label: 'iPhone-size phone (390 × 844)' }
    };
    const STATUS_ICONS = '<span class="ss-sb-icons" aria-hidden="true"><svg viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>' +
      '<svg viewBox="0 0 16 12"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.2-1.3C13.3 1.5 10.8.4 8 .4S2.7 1.5.8 3.3L2 4.6c1.6-1.5 3.7-2.4 6-2.4zm0 3.6c1.3 0 2.5.5 3.4 1.3l1.2-1.3C11.4 4.7 9.8 4 8 4s-3.4.7-4.6 1.8l1.2 1.3C5.5 6.3 6.7 5.8 8 5.8zm0 3.6c-.5 0-1 .2-1.3.5L8 11.4l1.3-1.5c-.3-.3-.8-.5-1.3-.5z"/></svg>' +
      '<svg viewBox="0 0 27 12"><rect x=".5" y=".5" width="23" height="11" rx="3" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="18" height="8" rx="1.8"/><rect x="24.5" y="4" width="1.8" height="4" rx=".9" opacity=".45"/></svg></span>';
    function deviceHTML() {
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
      if (device === 'desktop') {
        return '<div class="ss-hw ss-hw-desktop"><div class="ss-browser-bar"><span class="ss-dots"><i></i><i></i><i></i></span>' +
          '<span class="ss-urlbar">🔒 ' + esc(location.host) + '/s/…</span></div><div class="ss-screen"><div class="ss-device-screen" id="ss-pv-host"></div></div></div>';
      }
      return '<div class="ss-hw ss-hw-' + device + (landscape ? ' is-landscape' : '') + '" aria-label="' + esc(DEVICES[device].label) + '">' +
        '<span class="ss-btn ss-btn-power"></span><span class="ss-btn ss-btn-vol1"></span><span class="ss-btn ss-btn-vol2"></span>' + (device === 'mobile' ? '<span class="ss-btn ss-btn-mute"></span>' : '') +
        '<div class="ss-screen"><div class="ss-statusbar"><span class="ss-sb-time">' + esc(time) + '</span>' + (device === 'mobile' ? '<span class="ss-island"></span>' : '<span class="ss-cam"></span>') + STATUS_ICONS + '</div>' +
        '<div class="ss-device-screen" id="ss-pv-host"></div><span class="ss-home" aria-hidden="true"></span></div></div>';
    }
    // Scales the device so all of it fits in the preview area.
    function fitDevice() {
      const area = $('.ss-device');
      const hw = area && area.querySelector('.ss-hw');
      if (!hw) return;
      const pad = 48;
      const aw = Math.max(200, area.clientWidth - pad), ah = Math.max(200, area.clientHeight - pad);
      if (device === 'desktop') {
        const w = Math.min(DEVICES.desktop.w, aw);
        hw.style.width = w + 'px'; hw.style.height = ah + 'px'; hw.style.transform = ''; hw.parentElement.style.width = ''; hw.parentElement.style.height = '';
        return;
      }
      const ow = hw.offsetWidth, oh = hw.offsetHeight;
      const s = Math.min(1, aw / ow, ah / oh);
      hw.style.transform = s < 1 ? 'scale(' + s + ')' : '';
      hw.parentElement.style.width = Math.ceil(ow * s) + 'px';
      hw.parentElement.style.height = Math.ceil(oh * s) + 'px';
    }
    let deviceObserver = null;
    function renderPreview() {
      const box = $('.ss-view-preview');
      box.innerHTML = '<div class="ss-preview"><div class="ss-preview-bar">' +
        '<div class="ss-seg" role="radiogroup" aria-label="Device">' + [['desktop', 'Desktop'], ['tablet', 'Tablet'], ['mobile', 'Mobile']].map(([d, l]) => '<button type="button" class="ss-seg-btn' + (d === device ? ' is-on' : '') + '" data-device="' + d + '" role="radio" aria-checked="' + (d === device) + '">' + l + '</button>').join('') + '</div>' +
        (device === 'desktop' ? '' : '<button type="button" class="btn btn-ghost btn-sm" id="ss-pv-rotate" title="Rotate the device" aria-pressed="' + landscape + '">⟳ ' + (landscape ? 'Landscape' : 'Portrait') + '</button>') +
        '<label class="ss-inline-label">Start on <select class="ss-select" id="ss-pv-start"><option value="">first page</option>' + doc().pages.map(p => '<option value="' + esc(p.id) + '"' + (p.id === startPage ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></label>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="ss-pv-reset">↺ Restart test</button>' +
        '<span class="ss-preview-note">Test mode — answers and submissions are not recorded.</span></div>' +
        '<div class="ss-preview-body"><div class="ss-device ss-device-' + device + '"><div class="ss-hw-box">' + deviceHTML() + '</div></div>' +
        '<aside class="ss-testpanel" id="ss-testpanel" aria-label="Test panel"></aside></div></div>';
      box.onclick = e => {
        const d = e.target.closest('[data-device]');
        if (d) { device = d.dataset.device; renderPreview(); return; }
        if (e.target.closest('#ss-pv-rotate')) { landscape = !landscape; renderPreview(); return; }
        if (e.target.id === 'ss-pv-reset') mountPreview();
      };
      $('#ss-pv-start').onchange = e => { startPage = e.target.value; mountPreview(); };
      fitDevice();
      if (deviceObserver) deviceObserver.disconnect();
      else cleanup.push(() => { if (deviceObserver) deviceObserver.disconnect(); });
      deviceObserver = new ResizeObserver(() => fitDevice());
      deviceObserver.observe($('.ss-device'));
      mountPreview();
    }
    function mountPreview() {
      if (previewRT) { previewRT.destroy(); previewRT = null; }
      lastPayload = null;
      const host = $('#ss-pv-host');
      if (!host) return;
      host.style.background = doc().theme.tokens.background;
      if (window.SurveyFonts) SurveyFonts.ensureDoc(doc());
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

    /* ── Responses view (survey-responses.js) ── */
    let responsesUI = null;
    function renderResponses() {
      if (responsesUI) responsesUI.destroy();
      responsesUI = SurveyResponses.mount($('.ss-view-responses'), {
        doc, api, publish: () => store.publish, download, isActive: () => mode === 'responses',
        toProject: (done, qs) => toProject(done, qs),
        onOpenPage: pid => { setMode('design', true); if (Core.getPage(doc(), pid)) store.setPage(pid); else App.notify('That page is no longer in the survey.', 'info'); }
      });
    }
    cleanup.push(() => { if (responsesUI) responsesUI.destroy(); });
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
