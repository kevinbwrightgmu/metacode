/* ══════════════════════════════════════════════
   app.js — Central router, state, UI framework
   ══════════════════════════════════════════════ */

const App = (() => {

  /* ── State ─────────────────────────────────── */
  let state = {
    project:  { name: 'Untitled Project', description: '' },
    posts:    [],   // [{id, text, author, timestamp, engagement:{}, humanCodes:{} (Coder 1), coder2Codes:{}, coderNotes:{}, aiCodes:{}, adjudicated:{}}]
    codebook: [],   // [{id, name, description, codes:[{id,label,description}]}]
    network:  { nodes: [], edges: [] },
    networkAnalysis: null, // last NetworkX result from Analyze CSV (see csv-analyzer.js)
    settings: { model: '', models: {}, delay: 500, parallel: 4, switchModels: true }   // AI models (Settings → AI models); keys live in the server's .env
  };

  const STORAGE_KEY = 'strata_v1'; // kept stable so existing users' saved data isn't orphaned by the rename

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    // Signed in: the open project is also saved to the account (cloud-sync.js)
    if (window.CloudSync) { try { CloudSync.noteWorkspace(); } catch (e) { /* never block saving */ } }
    // Autosave to the linked saved project (Projects page), if any
    if (typeof ProjectsView !== 'undefined') { try { ProjectsView.noteChange(); } catch (e) { /* never block saving */ } }
    // A shared project: send what changed to the server (collab.js)
    if (typeof Collab !== 'undefined') { try { Collab.noteChange(); } catch (e) { /* never block saving */ } }
  }
  // The AI service respelled these ids (2026-10-22): a model picked under the old id keeps being picked
  const RENAMED_MODELS = { 'claude-opus-5-5': 'claude-opus-5.5', 'claude-sonnet-5-5': 'claude-sonnet-5.5', 'claude-opus-4-6': 'claude-opus-4.6',
    'gpt-6-1-sol': 'gpt-6.1-sol', 'gpt-5-6': 'gpt-5.6-sol', 'gpt-5-5': 'gpt-5.5', 'gemini-3-8-flash': 'gemini-3.8-flash', 'kimi-k2-6': 'kimi-k2.6',
    'grok-4-7': 'grok-4.7', 'qwen-3-7-max': 'qwen-3.7-max', 'glm-5-3': 'glm-5.3', 'glm-5-3-flash': 'glm-5.3-flash' };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch(e) {}
    // AI runs through MetaCode's server and its AI service; any keys live in
    // the server's .env. Keys once typed into the old Settings key box are no
    // longer used, so they aren't kept; old default model ids (Groq/Anthropic)
    // are cleared so the server's default model is used until one is picked in
    // Settings → AI models.
    if (!state.settings || typeof state.settings !== 'object') state.settings = {};
    delete state.settings.apiKeys; delete state.settings.apiKey; delete state.settings.provider;
    if (['openai/gpt-oss-20b', 'claude-sonnet-4-6'].includes(state.settings.model)) state.settings.model = '';
    if (typeof state.settings.model !== 'string') state.settings.model = '';
    if (!state.settings.models || typeof state.settings.models !== 'object') state.settings.models = {};
    if (RENAMED_MODELS[state.settings.model]) state.settings.model = RENAMED_MODELS[state.settings.model];
    Object.keys(state.settings.models).forEach(f => { if (RENAMED_MODELS[state.settings.models[f]]) state.settings.models[f] = RENAMED_MODELS[state.settings.models[f]]; });
    if (!Number.isFinite(Number(state.settings.delay))) state.settings.delay = 500;
    if (!Number.isFinite(Number(state.settings.parallel)) || Number(state.settings.parallel) < 1) state.settings.parallel = 4;
    if (typeof state.settings.switchModels !== 'boolean') state.settings.switchModels = true;
  }
  function getState()  { return state; }
  // The open project was replaced (another device's newer version, cloud-sync.js): show it
  function reloadState() {
    load();
    if (currentView) navigate(location.hash.slice(1) || currentView);
    else updateSidebarStats();
  }
  function setState(patch) { Object.assign(state, patch); save(); }

  /* ── Routing ─────────────────────────────────*/
  const VIEWS = {
    'dashboard':    renderDashboard,
    'projects':     () => ProjectsView.render(),
    'settings':     renderSettings,
    'import':       () => DataManager.render(),
    'scraper':      () => RedditScraper.render(),
    'scraper-beta': () => CollectorView.render(),        // AI Scraper (beta): the collector/ app, an AI agent collects
    'codebook':     param => Codebook.render(param),             // #codebook/lab/<submissionId>: a coding rule from the AI Coding Lab
    'ai-coding':    () => AICoder.render(),
    'human-coding': param => HumanCoder.render(param),           // tabs: coder1, coder2, ai, reliability
    'reliability':  () => ReliabilityAnalyzer.render(),           // the Reliability Analysis tab
    'csv-analyzer': () => CSVAnalyzer.render(),
    'network':      () => NetworkViz.render(),
    'metrics':      () => EngagementViz.render(),
    'export':       renderExport,
    'account':      param => Account.renderPage(document.getElementById('view-container'), param),
    'invite':       param => Collab.renderInvite(document.getElementById('view-container'), param),   // an invitation to a shared project
    // Survey Studio has its own page now; old #surveys links go there.
    'surveys':      param => { location.replace('studio.html' + (param ? '#' + param : '')); }
  };

  const TITLES = {
    'dashboard':'Dashboard','projects':'Projects','settings':'Settings','import':'Import Data','scraper':'Scraper','scraper-beta':'AI Scraper (beta)',
    'codebook':'Codebook','ai-coding':'AI Coding','human-coding':'Human Coding',
    'reliability':'Reliability Analysis','csv-analyzer':'Analyze CSV (NetworkX)',
    'network':'Network Graph',
    'metrics':'Metrics','export':'Export Data','surveys':'Survey Studio','account':'Account & plan','invite':'Invitation'
  };

  // Former route ids that must keep working (bookmarks, browser history).
  // The Metrics section used to live at #engagement; the Reddit scraper was
  // briefly at #scraper-api.
  const ROUTE_ALIASES = { 'engagement': 'metrics', 'scraper-api': 'scraper' };

  let currentView = '';
  let viewCleanup = null;
  // A view can register a function to run when the user leaves it
  // (e.g. to stop timers or remove document-level listeners).
  function setViewCleanup(fn) { viewCleanup = fn; }

  function navigate(view) {
    // Sub-routes: "#view/<param>" → view "view", param "<param>"
    const slash = String(view || '').indexOf('/');
    const param = slash === -1 ? '' : String(view).slice(slash + 1);
    if (slash !== -1) view = String(view).slice(0, slash);
    if (viewCleanup) { const fn = viewCleanup; viewCleanup = null; try { fn(); } catch (e) { console.error(e); } }
    if (ROUTE_ALIASES[view]) {
      const oldId = view;
      view = ROUTE_ALIASES[view];
      // Show the current id in the address bar, without adding a history entry
      if (location.hash === '#' + oldId) history.replaceState(null, '', '#' + view);
    }
    if (!VIEWS[view]) view = 'dashboard';
    currentView = view;

    // Sidebar active state
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.view === view);
    });

    // Topbar title
    document.getElementById('topbar-title').textContent = TITLES[view] || view;
    document.getElementById('topbar-project').textContent = state.project.name;

    // Render
    const container = document.getElementById('view-container');
    container.className = 'view-container';
    container.innerHTML = '';
    // Pages that need a plan show what it takes instead (account.js; the server enforces it too)
    if (window.Account && Account.gate(view, container)) { updateSidebarStats(); return; }
    VIEWS[view](param);

    // Update sidebar stats
    updateSidebarStats();
  }

  function updateSidebarStats() {
    const posts = state.posts;
    const coded = posts.filter(p =>
      Object.keys(p.humanCodes || {}).length > 0 ||
      Object.keys(p.aiCodes || {}).length > 0
    ).length;
    document.getElementById('stat-posts').textContent = posts.length;
    document.getElementById('stat-coded').textContent = coded;
  }

  /* ── Dashboard ───────────────────────────────*/
  function renderDashboard() {
    const { posts, codebook } = state;
    const aiCoded    = posts.filter(p => Object.keys(p.aiCodes || {}).length > 0).length;
    const humanCoded = posts.filter(p => Object.keys(p.humanCodes || {}).length > 0).length;
    const bothCoded  = posts.filter(p =>
      Object.keys(p.aiCodes || {}).length > 0 && Object.keys(p.humanCodes || {}).length > 0
    ).length;

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Dashboard</div>
          <div class="view-subtitle">Project: <strong>${esc(state.project.name)}</strong></div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="stat-card">
          <div class="dash-stat-icon" style="background:linear-gradient(135deg,#2563EB,#3B82F6)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div class="stat-num">${posts.length}</div>
          <div class="stat-label">Total Posts</div>
          <div class="stat-sub">${codebook.length} coding dimension${codebook.length!==1?'s':''}</div>
        </div>
        <div class="stat-card">
          <div class="dash-stat-icon" style="background:linear-gradient(135deg,#7C3AED,#8B5CF6)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </div>
          <div class="stat-num">${aiCoded}</div>
          <div class="stat-label">AI Coded</div>
          <div class="stat-sub">${posts.length ? Math.round(aiCoded/posts.length*100) : 0}% complete</div>
        </div>
        <div class="stat-card">
          <div class="dash-stat-icon" style="background:linear-gradient(135deg,#0D9488,#14B8A6)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="stat-num">${humanCoded}</div>
          <div class="stat-label">Human Coded</div>
          <div class="stat-sub">${posts.length ? Math.round(humanCoded/posts.length*100) : 0}% complete</div>
        </div>
        <div class="stat-card">
          <div class="dash-stat-icon" style="background:linear-gradient(135deg,#F59E0B,#FCD34D)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div class="stat-num">${bothCoded}</div>
          <div class="stat-label">Dual-Coded</div>
          <div class="stat-sub">Ready for reliability check</div>
        </div>
      </div>

      <div class="dash-lower">
        <div class="card">
          <div class="card-title">Quick Start</div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${quickStartItem('1', 'Import your social media data as CSV', '#import', posts.length > 0)}
            ${quickStartItem('2', 'Build your codebook — define dimensions and codes', '#codebook', codebook.length > 0)}
            ${quickStartItem('3', 'Run AI Auto-Coding on your posts', '#ai-coding', aiCoded > 0)}
            ${quickStartItem('4', 'Code posts manually for intercoder reliability', '#human-coding', humanCoded > 0)}
            ${quickStartItem('5', 'Compare AI vs Human coding — view reliability metrics', '#reliability', bothCoded > 0)}
          </div>
        </div>
        <div class="card">
          <div class="card-title">Codebook Summary</div>
          ${codebook.length === 0
            ? `<div class="empty-state" style="padding:24px">
                <div class="empty-sub">No codebook yet. <a href="#codebook" class="text-ai fw-600" onclick="App.navigate('codebook');return false">Create dimensions →</a></div>
               </div>`
            : `<div style="display:flex;flex-direction:column;gap:8px">
                ${codebook.map(dim => `
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
                    <div>
                      <div style="font-weight:600;font-size:13.5px">${esc(dim.name)}</div>
                      <div style="font-size:12px;color:var(--tx-muted)">${dim.codes.length} codes</div>
                    </div>
                    <div class="flex gap-2">
                      ${dim.codes.slice(0,3).map(c=>`<span class="badge badge-gray">${esc(c.label)}</span>`).join('')}
                      ${dim.codes.length>3?`<span class="badge badge-gray">+${dim.codes.length-3}</span>`:''}
                    </div>
                  </div>
                `).join('')}
              </div>`
          }
        </div>
      </div>
    `;
  }

  function quickStartItem(n, text, href, done) {
    return `
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
          font-size:12px;font-weight:700;flex-shrink:0;
          background:${done?'var(--success)':'var(--border)'};
          color:${done?'#fff':'var(--tx-muted)'}">
          ${done ? '✓' : n}
        </div>
        <div style="font-size:13.5px;color:${done?'var(--tx-muted)':'var(--tx-primary)'}">
          ${done ? `<del style="color:var(--tx-muted)">${text}</del>` : `<a href="${href}" style="color:var(--tx-primary)" onclick="App.navigate('${href.slice(1)}');return false">${text}</a>`}
        </div>
      </div>`;
  }

  /* ── Settings ────────────────────────────────*/
  function renderSettings() {
    const { project, settings } = state;
    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div class="view-header">
        <div><div class="view-title">Settings</div>
             <div class="view-subtitle">Configure your project and API connection</div></div>
      </div>
      <div class="card-grid card-grid-2">
        <div class="card">
          <div class="card-title">Project</div>
          <div style="display:flex;flex-direction:column;gap:16px">
            <div class="form-group">
              <label class="form-label">Project Name</label>
              <input class="form-input" id="s-name" value="${esc(project.name)}" placeholder="My Research Project">
            </div>
            <div class="form-group">
              <label class="form-label">Description <span>(optional)</span></label>
              <textarea class="form-textarea" id="s-desc" placeholder="Brief description of this coding project…">${esc(project.description)}</textarea>
            </div>
            <button class="btn btn-primary" onclick="App.saveProject()">Save Project</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            AI connection
            <span id="s-ai-badge"></span>
          </div>
          <div id="s-env-status" style="display:flex;flex-direction:column;gap:10px;font-size:13px">
            <div class="text-muted">Checking the server's .env file…</div>
          </div>
          <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
            <button class="btn btn-secondary" id="s-reload-env" onclick="App.reloadEnv()" title="Read the .env file again without restarting MetaCode">&#8635; Reload .env</button>
            <button class="btn btn-secondary" onclick="App.testApi()">Test connection</button>
          </div>
          <div id="api-test-result" style="margin-top:10px;font-size:13px"></div>
        </div>

        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
            AI models
            <button class="btn btn-ghost btn-sm" onclick="App.fetchModels()" style="font-size:11.5px;padding:2px 8px">&#8635; Refresh list</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="form-group">
              <label class="form-label" for="s-model">Default model <span>(used by everything below set to "Same as default")</span></label>
              <select class="form-select" id="s-model"><option value="">Loading models…</option></select>
              <div class="form-hint" id="s-model-hint"></div>
            </div>
            <div class="form-group">
              <label class="form-label">Model for each feature</label>
              <div class="s-feature-models" id="s-feature-models"></div>
            </div>
            <div class="form-group">
              <label class="s-check-row" for="s-switch"><input type="checkbox" id="s-switch" ${settings.switchModels !== false ? 'checked' : ''}> If a model is rate-limited or failing, use the closest similar model</label>
              <div class="form-hint">When the AI service throttles the model you picked, or can't run it right now, requests go to the most similar available model — the same model from another provider first, else the same family and line, nearest version and size (e.g. Claude Opus 5.5 → Claude Opus 5) — until it can be used again, and a note says which one answered. The same happens to every model of a provider whose usage limit is used up, until the limit resets. (AI Coding waits and tries your model again when the AI service can't run it, so every post is coded by the model you picked.) Turn off to wait for your model instead (with “Server default”, the server still uses a similar model when the AI service can't run its default).</div>
              <div class="form-hint" id="s-limited"></div>
            </div>
            <div class="form-group">
              <label class="form-label" for="s-parallel">AI Coding: copies of the model working at once</label>
              <input class="form-input" id="s-parallel" type="number" value="${getParallel()}" min="1" max="${maxParallel()}" step="1">
              <div class="form-hint">Posts are split between this many simultaneous requests to the same model, so coding finishes up to that many times faster. 1 codes one post at a time. Lower it if the AI service rate-limits you (MetaCode also slows down by itself when that happens). Up to ${maxParallel()} (the server's AI_MAX_PARALLEL).</div>
            </div>
            <div class="form-group">
              <label class="form-label" for="s-delay">Pause between each copy's requests <span>(ms)</span></label>
              <input class="form-input" id="s-delay" type="number" value="${settings.delay}" min="0" max="5000" step="100">
              <div class="form-hint">Increase if you hit rate limits (default: 500 ms)</div>
            </div>
            <div><button class="btn btn-primary" onclick="App.saveSettings()">Save model settings</button></div>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1" id="s-data-card">
          <div class="card-title">Your data</div>
          <p class="form-hint" style="margin:0 0 12px">Your projects, saved projects and Survey Studio surveys are kept <b>in this browser</b>, private to you — other people using this MetaCode server have their own. The server only holds what has to be public: surveys you publish and their responses (only this browser can see or manage them), and scrapes while they run. Clearing this browser's site data deletes your work, so download a backup now and then — or to move to another browser or computer. Keep backup files private: they also let whoever has them manage your published surveys.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="App.downloadBackup()">Download a backup</button>
            <button class="btn btn-secondary" onclick="App.restoreBackup()">Restore from a backup…</button>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
            AI providers
            <button class="btn btn-ghost btn-sm" onclick="App.fetchKeyStatus()" style="font-size:11.5px;padding:2px 8px">&#8635; Refresh</button>
          </div>
          <div style="font-size:12.5px;color:var(--tx-second);margin-bottom:12px">
            Where MetaCode's AI service (OpenCode) gets its models, as it reports them: whether each provider is set up, its free models,
            its keys and the quota they have left, and whether it's resting until a limit resets. Keys are set only in the server's .env
            file and never reach this page — only a masked form.
          </div>
          <div id="key-status-list" style="display:flex;flex-direction:column;gap:6px">
            <div class="text-muted" style="font-size:12.5px">Loading…</div>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <div class="card-title" style="color:var(--error)">Danger Zone</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap">
            <button class="btn btn-secondary" onclick="App.clearCodes()">Clear All Codes</button>
            <button class="btn btn-danger" onclick="App.resetAll()">Reset All Data</button>
          </div>
          <div class="form-hint mt-2">Resetting all data removes posts, codebook, and all coding results.</div>
        </div>
      </div>
    `;
    // (what the server knew when the app opened, then what it knows now: rate-limited models, resting providers)
    setTimeout(() => { renderEnvStatus(); refreshServerKeyInfo(); fetchModels(); fetchKeyStatus(); }, 0);
  }

  function saveProject() {
    const name = document.getElementById('s-name').value.trim() || 'Untitled Project';
    const desc = document.getElementById('s-desc').value.trim();
    setState({ project: Object.assign({}, state.project, { name, description: desc }) });   // (keeps a shared project's link, collab.js)
    document.getElementById('topbar-project').textContent = name;
    notify('Project saved', 'success');
  }

  // AI features that can each use their own model (Settings → AI models).
  const AI_FEATURES = [
    ['coding', 'AI Coding', 'codes posts with your codebook'],
    ['assistant', 'Ask MetaCode', 'the help assistant'],
    ['import', 'Import Data', 'works out the columns of a CSV'],
    ['csv', 'Analyze CSV', 'finds the source/target columns'],
    ['scraper', 'AI Scraper (beta)', 'plans searches and picks the relevant Reddit posts']
  ];

  /* ── Backup of everything kept in this browser (local-db.js) ── */
  async function downloadBackup() {
    try {
      const b = await LocalDB.exportAll();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(b)], { type: 'application/json' }));
      a.download = 'metacode-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      notify('Backup downloaded — ' + b.stores.projects.length + ' saved project(s), ' + b.stores.surveys.length + ' survey(s)', 'success');
    } catch (e) { notify('The backup couldn\'t be made: ' + e.message, 'error'); }
  }
  function restoreBackup() {
    openModal('Restore from a backup',
      '<p class="form-hint" style="margin-bottom:10px">Choose a <code>metacode-backup-….json</code> file. Its saved projects and surveys are added to this browser (ones with the same id are replaced), its open project replaces the one open now, and this browser takes over its published surveys and responses.</p>' +
      '<input type="file" id="s-restore-file" accept=".json,application/json" class="form-input"><div class="form-error" id="s-restore-err"></div>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="s-restore-go">Restore</button>');
    document.getElementById('s-restore-go').onclick = async () => {
      const f = document.getElementById('s-restore-file').files[0];
      const err = document.getElementById('s-restore-err');
      if (!f) { err.textContent = 'Choose a file first.'; return; }
      try {
        const r = await LocalDB.importAll(JSON.parse(await f.text()));
        closeModal();
        notify('Restored ' + r.records + ' item(s) — reloading', 'success');
        setTimeout(() => location.reload(), 700);
      } catch (e) { err.textContent = e instanceof SyntaxError ? 'That file isn\'t valid JSON.' : e.message; }
    };
  }

  function saveSettings() {
    const model = document.getElementById('s-model').value;
    const models = {};
    document.querySelectorAll('#s-feature-models select[data-feature]').forEach(sel => { if (sel.value) models[sel.dataset.feature] = sel.value; });
    const delay = parseInt(document.getElementById('s-delay').value, 10);
    const parallel = clampParallel(document.getElementById('s-parallel').value);
    const sw = document.getElementById('s-switch');
    const switchModels = sw ? sw.checked : state.settings.switchModels !== false;
    setState({ settings: { ...state.settings, model, models, delay: Number.isFinite(delay) ? Math.max(0, delay) : 500, parallel, switchModels } });
    notify('Model settings saved', 'success');
  }

  async function testApi() {
    const el = document.getElementById('api-test-result');
    el.innerHTML = '<span style="color:var(--tx-muted)">Testing connection…</span>';
    try {
      const text = await callClaude([{ role: 'user', content: 'Reply with exactly one word: ok' }], '', 256, { feature: null });
      el.innerHTML = '<span style="color:var(--success)">✓ Connected — model ' + esc(modelName(lastModelUsed) || 'default') + ' replied: ' + esc(String(text).trim().slice(0, 60)) + '</span>';
      updateApiStatus(true);
      fetchKeyStatus();
    } catch (e) {
      el.innerHTML = '<span style="color:var(--error)">✗ ' + esc(e.message) + '</span>';
      updateApiStatus(false);
    }
  }

  function clearCodes() {
    if (!confirm('Clear all AI and human coding data (Coder 1, Coder 2, AI, memos and adjudications)? Post text and codebook will remain.')) return;
    state.posts = state.posts.map(p => ({ ...p, aiCodes:{}, humanCodes:{}, coder2Codes:{}, coderNotes:{}, adjudicated:{} }));
    save();
    notify('All codes cleared', 'warning');
  }

  function resetAll() {
    if (!confirm('Reset ALL data? This cannot be undone.')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  }

  /* ── Export ──────────────────────────────────*/
  function renderExport() {
    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div class="view-header">
        <div><div class="view-title">Export Data</div>
             <div class="view-subtitle">Download your posts, codes, and analysis results</div></div>
      </div>
      <div class="export-grid">
        <div class="export-card">
          <div class="export-icon" style="background:linear-gradient(135deg,#2563EB,#3B82F6)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="export-name">Coded Posts (Full)</div>
          <div class="export-desc">All posts with both AI and human codes, engagement data, and AI reasoning notes.</div>
          <button class="btn btn-primary mt-3" onclick="App.exportCoded()">Download CSV</button>
        </div>
        <div class="export-card">
          <div class="export-icon" style="background:linear-gradient(135deg,#7C3AED,#8B5CF6)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div class="export-name">Reliability Report</div>
          <div class="export-desc">Cohen's Kappa and percent agreement per coding dimension, formatted for publication.</div>
          <button class="btn btn-violet mt-3" onclick="App.exportReliability()">Download CSV</button>
        </div>
        <div class="export-card">
          <div class="export-icon" style="background:linear-gradient(135deg,#0D9488,#14B8A6)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </div>
          <div class="export-name">Codebook</div>
          <div class="export-desc">Your coding scheme: all dimensions, codes, and descriptions as a CSV reference sheet.</div>
          <button class="btn btn-teal mt-3" onclick="App.exportCodebook()">Download CSV</button>
        </div>
        <div class="export-card">
          <div class="export-icon" style="background:linear-gradient(135deg,#F59E0B,#FCD34D)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </div>
          <div class="export-name">Network Data</div>
          <div class="export-desc">Nodes and edges as separate CSV files, ready for import into Gephi or other tools.</div>
          <button class="btn btn-secondary mt-3" onclick="App.exportNetwork()">Download CSVs</button>
        </div>
        <div class="export-card">
          <div class="export-icon" style="background:linear-gradient(135deg,#0891B2,#22D3EE)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </div>
          <div class="export-name">Network Analysis (NetworkX)</div>
          <div class="export-desc">Full per-node centrality scores (degree, betweenness, closeness, eigenvector), community assignments, and graph-level summary statistics from the Analyze CSV page.</div>
          <button class="btn btn-secondary mt-3" onclick="App.exportNetworkAnalysis()">Download CSVs</button>
        </div>
      </div>
    `;
  }

  function exportCoded() {
    const { posts, codebook } = state;
    if (!posts.length) { notify('No posts to export', 'warning'); return; }

    const aiDims    = codebook.map(d => `ai_${d.id}`);
    const humanDims = codebook.map(d => `human_${d.id}`);
    const coder2Dims = codebook.map(d => `coder2_${d.id}`);
    const finalDims = codebook.map(d => `final_${d.id}`);
    const confDims  = codebook.map(d => `ai_confidence_${d.id}`);

    const headers = ['id','text','author','timestamp',
      'eng_likes','eng_shares','eng_comments','eng_views',
      ...aiDims, ...humanDims, ...coder2Dims, ...finalDims, ...confDims, 'agree_all'];

    const rows = posts.map(p => {
      const agree = codebook.length > 0 && codebook.every(d => {
        const a = ((p.aiCodes || {})[d.id] || {}).code;
        const h = (p.humanCodes || {})[d.id];
        return a && h && a === h;
      });
      return [
        p.id, p.text, p.author || '', p.timestamp || '',
        p.engagement?.likes||'', p.engagement?.shares||'',
        p.engagement?.comments||'', p.engagement?.views||'',
        ...codebook.map(d => ((p.aiCodes || {})[d.id]||{}).code || ''),
        ...codebook.map(d => (p.humanCodes || {})[d.id] || ''),
        ...codebook.map(d => (p.coder2Codes || {})[d.id] || ''),
        ...codebook.map(d => HumanCoder.finalCode(p, d.id) || ''),
        ...codebook.map(d => ((p.aiCodes || {})[d.id]||{}).confidence || ''),
        agree ? '1' : '0'
      ];
    });
    downloadCSV('metacode_coded_posts.csv', headers, rows);
    notify('Exported coded posts', 'success');
  }

  function exportReliability() {
    const n3 = v => (v === null || v === undefined ? '' : v.toFixed(3));
    const rows = [];
    [['coder1', 'coder2'], ['coder1', 'ai'], ['coder2', 'ai']].forEach(pair => ReliabilityAnalyzer.computeAll(null, pair).forEach(s => {
      if (s.n) rows.push([pair[0], pair[1], s.name, s.n, s.pa === null ? '' : (s.pa * 100).toFixed(1) + '%', n3(s.kappa), n3(s.alpha), s.interp, s.kappaNote || '']);
    }));
    if (!rows.length) { notify('No posts coded by two sources yet', 'warning'); return; }
    const headers = ['source_a','source_b','dimension','n_paired','pct_agreement','cohens_kappa','krippendorff_alpha','interpretation','note'];
    downloadCSV('metacode_reliability.csv', headers, rows);
    notify('Exported reliability report', 'success');
  }

  function exportCodebook() {
    const { codebook } = state;
    if (!codebook.length) { notify('No codebook to export', 'warning'); return; }
    const headers = ['dimension_id','dimension_name','dimension_description','code_id','code_label','code_description','code_ai_notes'];
    const rows = [];
    codebook.forEach(d => d.codes.forEach(c => rows.push([d.id, d.name, d.description, c.id, c.label, c.description||'', c.aiNotes||''])));
    downloadCSV('metacode_codebook.csv', headers, rows);
    notify('Exported codebook', 'success');
  }

  function exportNetwork() {
    const { nodes, edges } = state.network;
    if (!nodes.length) { notify('No network data to export', 'warning'); return; }
    downloadCSV('metacode_network_nodes.csv', ['id','label','group','size'], nodes.map(n=>[n.id,n.label,n.group||'',n.size||'']));
    downloadCSV('metacode_network_edges.csv', ['source','target','weight','type'], edges.map(e=>[e.source,e.target,e.weight||'1',e.type||'']));
    notify('Exported network files', 'success');
  }

  function exportNetworkAnalysis() {
    const analysis = state.networkAnalysis;
    if (!analysis || !analysis.nodeTable || !analysis.nodeTable.length) {
      notify('No NetworkX analysis yet — run one on the Analyze CSV page first', 'warning');
      return;
    }

    const na = v => (v === null || v === undefined) ? '' : v;

    const summaryHeaders = ['metric', 'value'];
    const summaryRows = [
      ['node_count', na(analysis.nodeCount)],
      ['edge_count', na(analysis.edgeCount)],
      ['directed', analysis.directed ? 'yes' : 'no'],
      ['density', na(analysis.density)],
      ['avg_degree', na(analysis.avgDegree)],
      ['component_count', na(analysis.componentCount)],
      ['largest_component_size', na(analysis.largestComponentSize)],
      ['diameter', na(analysis.diameter)],
      ['avg_path_length', na(analysis.avgPathLength)],
      ['avg_clustering', na(analysis.avgClustering)],
      ['community_count', na(analysis.communityCount)],
      ['skipped_edges', na(analysis.skippedEdges)],
      ['note', na(analysis.note)]
    ];
    downloadCSV('metacode_network_analysis_summary.csv', summaryHeaders, summaryRows);

    const nodeHeaders = ['node_id','label','community','degree_centrality','betweenness_centrality','closeness_centrality','eigenvector_centrality'];
    const nodeRows = analysis.nodeTable.map(n => [
      n.id, n.label, na(n.community), na(n.degree), na(n.betweenness), na(n.closeness), na(n.eigenvector)
    ]);
    downloadCSV('metacode_network_analysis_nodes.csv', nodeHeaders, nodeRows);

    notify('Exported NetworkX analysis (2 files)', 'success');
  }

  /* ── AI settings (server .env status, the AI service, models, providers) ─────*/
  let serverStatus = null;      // /api/settings/status: what the server read from .env, and how its AI service is

  // "14:05" today, "Mon 09:00" within a day or so, else the date
  function whenText(t) {
    const d = new Date(t);
    if (t - Date.now() >= 86400 * 1000) return d.toLocaleDateString();
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // A provider's name as the AI service reports it ("OpenCode Zen"), not its id
  function providerTitle(id) {
    const ai = serverStatus && serverStatus.ai;
    const p = (ai && Array.isArray(ai.providers) ? ai.providers : []).concat(modelProviders).find(x => x && x.id === id);
    return (p && p.name) || 'an AI provider';
  }

  // Settings → AI models: which models the AI service is rate-limiting right
  // now, and which providers rest until a usage limit resets
  function renderLimited(st) {
    const el = document.getElementById('s-limited');
    if (!el) return;
    const ai = (st && st.ai) || {};
    const sw = document.getElementById('s-switch');
    if (sw && ai.modelSwitch === false) { sw.checked = false; sw.disabled = true; sw.title = 'Turned off for this server (AI_MODEL_SWITCH=off in .env)'; }
    const until = list => (Array.isArray(list) ? list : []).filter(x => x && Number.isFinite(Date.parse(x.until)));
    const parts = [];
    const limited = until(ai.rateLimitedModels);
    if (limited.length) parts.push('<b>Rate-limited right now:</b> ' + limited.map(x => esc(modelName(x.model)) + ' (until ' + esc(whenText(Date.parse(x.until))) + ')').join(', '));
    const resting = until(ai.restingProviders);
    if (resting.length) parts.push('<b>Resting until a limit resets:</b> ' + resting.map(x => esc(providerTitle(x.provider)) + ' (until ' + esc(whenText(Date.parse(x.until))) + ')').join(', '));
    el.innerHTML = parts.join('<br>');
  }

  // "OpenCode service at 127.0.0.1:4097 (started by MetaCode) · 2 providers ready · default model Claude Opus 5.5"
  function aiSummary(ai) {
    const parts = [];
    const svc = ai.service && typeof ai.service === 'object' ? ai.service : null;
    if (svc) parts.push('OpenCode service' + (svc.host ? ' at ' + esc(svc.host) : '') + (svc.managed ? ' (started by MetaCode)' : svc.running ? ' (running separately)' : ''));
    const providers = Array.isArray(ai.providers) ? ai.providers.filter(p => p && typeof p === 'object') : [];
    if (providers.length) {
      const ready = providers.filter(p => p.ready).length;
      parts.push((ready === providers.length ? ready : ready + ' of ' + providers.length) + ' provider' + (providers.length === 1 ? '' : 's') + ' ready');
    }
    // (named as the pickers name it once the model list is here)
    const listed = ai.defaultModel && (modelCache || []).some(m => m.id === ai.defaultModel);
    const def = listed ? modelName(ai.defaultModel) : ai.defaultModelName || modelName(ai.defaultModel);
    if (def) parts.push('default model ' + esc(def));
    return parts.join(' · ') || 'MetaCode\'s AI service is answering.';
  }

  // Shows what the server read from .env and whether AI is ready — names of
  // settings only, never values.
  function renderEnvStatus(statusOverride) {
    renderLimited(statusOverride || serverStatus);
    const box = document.getElementById('s-env-status');
    const badge = document.getElementById('s-ai-badge');
    const st = statusOverride || serverStatus;
    if (!box) return;
    if (!st) { box.innerHTML = '<div style="color:var(--error)">Couldn\'t reach the MetaCode server to check its settings.</div>'; return; }
    const env = st.env || {}, ai = st.ai || {}, server = st.server || {};
    if (badge) badge.innerHTML = ai.ready ? '<span class="badge badge-green">Ready</span>' : '<span class="badge badge-red">Not set up</span>';
    const rows = [];
    const keys = Array.isArray(env.keys) ? env.keys : [];
    if (env.found && !env.error) {
      rows.push('<div>✓ Settings file <code>' + esc(env.name) + '</code> read from ' + esc(env.where) + (env.encoding && env.encoding !== 'UTF-8' ? ' (' + esc(env.encoding) + ')' : '') +
        ' — ' + keys.length + ' setting' + (keys.length === 1 ? '' : 's') + (keys.length ? ': ' + keys.map(k => '<code>' + esc(k) + '</code>').join(' ') : '') + '</div>');
    } else if (env.error) {
      rows.push('<div style="color:var(--error)">✗ Found <code>' + esc(env.name) + '</code> in ' + esc(env.where) + ' but couldn\'t read it: ' + esc(env.error) + '</div>');
    } else if (env.disabled || (Array.isArray(env.searched) && !env.searched.length)) {
      rows.push('<div class="text-muted">The .env file is switched off for this server (METACODE_ENV_FILE=none).</div>');
    } else {
      rows.push('<div style="color:var(--error)">✗ No <code>.env</code> file found (looked in ' + esc((env.searched || []).join(', ')) + ').</div>' +
        '<div class="form-hint">The free AI models work without one. For other settings (keys for more AI models, accounts, the scraper…), copy <code>.env.example</code> to a file named exactly <code>.env</code> next to <code>server.js</code>, fill in what you need, save, then click <b>Reload .env</b>.</div>');
    }
    (env.warnings || []).forEach(w => rows.push('<div style="color:#B45309">⚠ ' + esc(w) + '</div>'));
    if (env.overridden && env.overridden.length) rows.push('<div style="color:#B45309">⚠ .env replaced older values set in this computer\'s environment for: ' + env.overridden.map(k => '<code>' + esc(k) + '</code>').join(' ') + '</div>');
    if (ai.ready) rows.push('<div>✓ AI is ready: ' + aiSummary(ai) + '</div>');
    else rows.push('<div style="color:var(--error)">✗ AI isn\'t ready: ' + esc(ai.problem || 'MetaCode\'s AI service isn\'t answering.') + '</div>');
    const svc = ai.service && typeof ai.service === 'object' ? ai.service : {};
    if (svc.problem && svc.problem !== ai.problem) rows.push('<div style="color:#B45309">⚠ ' + esc(svc.problem) + '</div>');
    (ai.warnings || []).forEach(w => rows.push('<div style="color:#B45309">⚠ ' + esc(w) + '</div>'));
    rows.push('<div class="form-hint">Server ' + esc(server.version || '') + (server.startedAt ? ' started ' + esc(new Date(server.startedAt).toLocaleString()) : '') + (env.loadedAt ? ' · .env read ' + esc(new Date(env.loadedAt).toLocaleTimeString()) : '') +
      (svc.opencode || svc.startedAt ? ' · AI service' + (svc.opencode ? ' (OpenCode ' + esc(svc.opencode) + ')' : '') + (svc.startedAt ? ' started ' + esc(new Date(svc.startedAt).toLocaleString()) : '') : '') + '</div>');
    box.innerHTML = rows.join('');
  }

  async function reloadEnv() {
    const btn = document.getElementById('s-reload-env');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/settings/reload', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      serverStatus = await res.json();
      renderEnvStatus();
      updateApiStatus();
      fetchModels();
      fetchKeyStatus();
      notify(serverStatus.ai.ready ? '.env reloaded — AI is ready' : '.env reloaded — AI still isn\'t set up', serverStatus.ai.ready ? 'success' : 'warning');
    } catch (e) {
      notify('Couldn\'t reload .env: ' + e.message, 'error');
    } finally { if (btn) btn.disabled = false; }
  }

  /* ── The model list (/api/models) ── */
  // { models: [{ id, name, provider, providerName, free, available }], providers: [{ id, name, ready }], note }
  // Model ids are "provider/model" (opencode/big-pickle); pickers and notes
  // show names. Kept for the page's lifetime: the Settings page asks again.
  let modelCache = null;        // the last list's models
  let modelProviders = [];      // …and its providers, in the AI service's order
  let modelsPending = null;
  function requestModels() {
    if (!modelsPending) {
      modelsPending = fetch('/api/models').then(res => res.json()).then(data => {
        data = data && typeof data === 'object' ? data : {};
        const models = (Array.isArray(data.models) ? data.models : []).filter(m => m && typeof m.id === 'string' && m.id);
        modelCache = models;
        modelProviders = (Array.isArray(data.providers) ? data.providers : []).filter(p => p && typeof p.id === 'string');
        migrateSavedModels(models);
        // (the AI connection line names the default model)
        if (serverStatus) renderEnvStatus();
        return Object.assign({}, data, { models });
      }).finally(() => { modelsPending = null; });
    }
    return modelsPending;
  }

  const providerOf = id => { const s = String(id || ''), i = s.indexOf('/'); return i > 0 ? s.slice(0, i) : ''; };
  const modelPart = id => { const s = String(id || ''), i = s.indexOf('/'); return i > 0 ? s.slice(i + 1) : s; };
  // "-" or "_" between two digits reads as "." and case doesn't count (claude-opus-5-5 = claude-opus-5.5), as on the server (model-match.js)
  const canonicalPart = m => String(m || '').toLowerCase().replace(/(\d)[-_](?=\d)/g, '$1.');
  const isDefaultEntry = m => m.default === true || / \(default\)$/.test(String(m.name || ''));
  // A list entry's name without the "(default)" the server adds; an entry without a name shows its id without the provider
  function baseName(m) {
    const name = String(m.name || '').replace(/ \(default\)$/, '');
    return name && name !== m.id ? name : modelPart(m.id);
  }

  // A model's display name ("Claude Opus 5.5"), for notes and summaries; a
  // model the list doesn't have shows its id without the provider part
  function modelName(id) {
    if (!id) return '';
    const m = (modelCache || []).find(x => x.id === id);
    return m ? baseName(m) : modelPart(id);
  }

  // The list's id for a model saved under another id: saved before ids had a
  // provider ("claude-opus-5.5" → "<provider>/claude-opus-5.5"), or under an
  // older spelling. On several providers: the first in the AI service's
  // order that has it under any spelling, the one the server would use for
  // the old id too. Else null.
  function listedModel(wanted, models) {
    const provider = providerOf(wanted), part = modelPart(wanted);
    const rank = p => { const i = modelProviders.findIndex(x => x.id === p); return i < 0 ? modelProviders.length : i; };
    const pool = models.filter(m => m.id !== wanted && (!provider || providerOf(m.id) === provider));
    const renamed = RENAMED_MODELS[part];
    const find = group => {
      const hit = test => (group.find(m => test(modelPart(m.id))) || {}).id || null;
      return hit(p => p === part) || (renamed && hit(p => p === renamed)) || hit(p => canonicalPart(p) === canonicalPart(part));
    };
    if (provider) return find(pool);
    const providers = [...new Set(pool.map(m => providerOf(m.id)))].sort((a, b) => rank(a) - rank(b));
    for (const p of providers) {
      const id = find(pool.filter(m => providerOf(m.id) === p));
      if (id) return id;
    }
    return null;
  }
  // Saved model choices the list doesn't have become the list's id for that model (and are saved)
  function migrateSavedModels(models) {
    if (!models.length) return;
    const ids = new Set(models.map(m => m.id));
    let changed = false;
    const fix = id => {
      const to = id && !ids.has(id) ? listedModel(id, models) : null;
      if (to) changed = true;
      return to || id;
    };
    state.settings.model = fix(state.settings.model);
    const per = state.settings.models || {};
    Object.keys(per).forEach(f => { per[f] = fix(per[f]); });
    if (changed) save();
  }

  // One option: the model's name (with its provider's name when two providers
  // offer a model under the same name, so a closed picker still tells them
  // apart), " · free", "(default)", and "— not offered now" when the AI
  // service lists it but can't offer it right now
  function modelOption(m, cur) {
    return '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + (m.available === false ? ' title="Listed by the AI service, but not offered right now"' : '') + '>' +
      esc(baseName(m)) + (m.free === true ? ' · free' : '') + (isDefaultEntry(m) ? ' (default)' : '') + (m.available === false ? ' — not offered now' : '') + '</option>';
  }
  // A picker's options: a group per provider (in the AI service's order), then any models without a provider
  function modelOptions(models, cur) {
    const groups = new Map(), loose = [];
    models.forEach(m => {
      const p = m.provider || providerOf(m.id);
      if (!p) { loose.push(m); return; }
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(m);
    });
    const rank = p => { const i = modelProviders.findIndex(x => x.id === p); return i < 0 ? modelProviders.length : i; };
    return [...groups.keys()].sort((a, b) => rank(a) - rank(b)).map(p => {
      const list = groups.get(p);
      const known = modelProviders.find(x => x.id === p);
      const label = (list.find(m => m.providerName) || {}).providerName || (known && known.name) || 'Other models';
      return '<optgroup label="' + esc(label) + '">' + list.map(m => modelOption(m, cur)).join('') + '</optgroup>';
    }).join('') + loose.map(m => modelOption(m, cur)).join('');
  }
  const notListedOption = id => '<option value="' + esc(id) + '" selected>' + esc(modelPart(id)) + ' (not in the list)</option>';

  async function fetchModels() {
    const modelSel = document.getElementById('s-model');
    const hintEl   = document.getElementById('s-model-hint');
    const feats    = document.getElementById('s-feature-models');
    if (!modelSel) return;
    modelSel.innerHTML = '<option value="">Loading models…</option>';
    try {
      const data = await requestModels();
      const models = data.models;
      if (!models.length) {
        modelSel.innerHTML = '<option value="">No models available</option>';
        if (hintEl) hintEl.textContent = data.note || 'No models returned — check the AI connection above.';
      } else {
        const current = state.settings.model || '';
        const def = models.find(isDefaultEntry) || models[0];
        modelSel.innerHTML = '<option value="">Server default (' + esc(baseName(def)) + ')</option>' + modelOptions(models, current);
        if (current && !models.find(m => m.id === current)) modelSel.insertAdjacentHTML('beforeend', notListedOption(current));
        if (hintEl) {
          const free = models.filter(m => m.free === true).length;
          const notOffered = models.filter(m => m.available === false).length;
          hintEl.textContent = models.length + ' model' + (models.length !== 1 ? 's' : '') + ' from the AI service (OpenCode)' +
            (free ? (free === models.length ? ', all free' : ', ' + free + ' of them free') : '') +
            (notOffered ? '; ' + notOffered + ' not offered right now (marked)' : '') + '.' + (data.note ? ' ' + data.note : '');
        }
      }
      if (feats) {
        const per = state.settings.models || {};
        feats.innerHTML = AI_FEATURES.map(([id, label, what]) => {
          const cur = per[id] || '';
          let options = '<option value="">Same as default</option>' + modelOptions(models, cur);
          if (cur && !models.find(m => m.id === cur)) options += notListedOption(cur);
          return '<div class="s-feature-row"><label for="s-fm-' + id + '"><b>' + esc(label) + '</b><span>' + esc(what) + '</span></label>' +
            '<select class="form-select" id="s-fm-' + id + '" data-feature="' + id + '">' + options + '</select></div>';
        }).join('');
      }
      renderLimited(serverStatus);
    } catch (err) {
      modelSel.innerHTML = '<option value="">Couldn\'t load models</option>';
      if (hintEl) hintEl.textContent = 'Error: ' + err.message;
    }
  }

  // Settings → AI providers: what the AI service reports for each provider —
  // set up or not (and what's missing), its models, its keys as masked ids
  // with their state and the quota they have left, and whether it rests
  // until a usage limit resets.
  async function fetchKeyStatus() {
    const listEl = document.getElementById('key-status-list');
    if (!listEl) return;
    const muted = text => '<div class="text-muted" style="font-size:12.5px">' + text + '</div>';
    listEl.innerHTML = muted('Loading…');
    try {
      const res  = await fetch('/api/keys/status');
      const data = await res.json();
      if (!Array.isArray(data.providers)) {
        // (an older server: its keys only)
        const keys = Array.isArray(data.keys) ? data.keys : [];
        listEl.innerHTML = keys.length ? keys.map(keyRow).join('') : muted('No AI keys loaded.');
        return;
      }
      const providers = data.providers.filter(p => p && typeof p === 'object');
      listEl.innerHTML = providers.length ? providers.map(providerBlock).join('<div style="border-top:1px solid var(--border);margin:4px 0"></div>') : muted(esc(data.problem || 'The AI service didn\'t report any providers.'));
    } catch(e) {
      listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px;color:var(--error)">Could not load status: ' + esc(e.message) + '</div>';
    }
  }

  // "Its usage limit for this week is used up — it resets Mon 09:00"
  function restingText(r, until) {
    if (r.reason === 'quota') return 'Its usage limit' + (r.window ? ' for this ' + r.window : '') + ' is used up — it resets ' + whenText(until) + '.';
    if (r.reason === 'paused') return 'It asked MetaCode to pause until ' + whenText(until) + '.';
    return 'It can\'t be used until ' + whenText(until) + '.';
  }

  // One provider: its name and state, what it offers, what's missing, then its keys
  function providerBlock(p) {
    const until = p.resting ? Date.parse(p.resting.until) : NaN;
    const resting = !!p.ready && until > Date.now();
    const badge = !p.ready ? '<span class="badge badge-red">Not set up</span>'
      : resting ? '<span class="badge badge-amber" title="' + esc(new Date(until).toLocaleString()) + '">Resting until ' + esc(whenText(until)) + '</span>'
        : '<span class="badge badge-green">Ready</span>';
    const keys = Array.isArray(p.keys) ? p.keys.filter(k => k && typeof k === 'object') : [];
    const keyCount = Number.isInteger(p.keyCount) ? p.keyCount : keys.length;
    const m = p.models && typeof p.models === 'object' ? p.models : {};
    const facts = [];
    if (Number.isFinite(m.listed) && (m.listed || p.ready)) facts.push(m.listed.toLocaleString() + ' model' + (m.listed === 1 ? '' : 's') + (Number.isFinite(m.available) && m.available < m.listed ? ', ' + m.available.toLocaleString() + ' offered now' : ''));
    facts.push(keyCount ? keyCount + ' key' + (keyCount === 1 ? '' : 's') : p.free === true ? 'free models, no key needed' : 'no key');
    const lines = [];
    if (p.problem) lines.push('<div style="color:var(--error)">' + esc(p.problem) + '</div>');
    if (resting) lines.push('<div style="color:#B45309">' + esc(restingText(p.resting, until)) + '</div>');
    if (p.note) lines.push('<div style="color:var(--tx-second)">' + esc(p.note) + '</div>');
    (Array.isArray(p.warnings) ? p.warnings : []).forEach(w => lines.push('<div style="color:#B45309">⚠ ' + esc(w) + '</div>'));
    return '<div class="s-provider" style="display:flex;flex-direction:column;gap:6px;font-size:12.5px">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px"><b>' + esc(p.name || 'AI provider') + '</b>' + badge +
      '<span style="color:var(--tx-muted);font-size:12.5px">' + esc(facts.join(' · ')) + '</span></div>' +
      lines.join('') + keys.map(keyRow).join('') + '</div>';
  }

  // One key: its masked form, the quota left, requests, and Available / Resting / Rejected
  function keyRow(k) {
    const left = Number(k.cooldownSecondsLeft) || 0;
    // A used-up budget rests the key until its day, week or month rolls over
    const back = Date.now() + left * 1000;
    const statusBadge = k.status === 'available'
      ? '<span class="badge badge-green">Available</span>'
      : k.status === 'cooling_down'
        ? '<span class="badge badge-amber" title="' + esc(new Date(back).toLocaleString()) + '">Resting ' + (left < 120 ? left + 's' : 'until ' + esc(whenText(back))) + '</span>'
        : '<span class="badge badge-red">Rejected by the provider</span>';
    // The budget is prompts and/or tokens: show whichever the provider reports (0 of 0: the key has no budget of that kind)
    const q = k.quota && typeof k.quota === 'object' ? k.quota : {};
    const has = (v, limit) => v !== null && v !== undefined && !(v === 0 && limit === 0);
    const quotaLeft = [has(q.remainingPrompts, q.limitPrompts) ? Number(q.remainingPrompts).toLocaleString() + ' prompt' + (q.remainingPrompts === 1 ? '' : 's') : '',
      has(q.remainingTokens, q.limitTokens) ? Number(q.remainingTokens).toLocaleString() + ' tokens' : ''].filter(Boolean).join(' · ');
    const quota = quotaLeft ? '<span style="color:var(--tx-muted)">' + quotaLeft + ' left' + (q.window ? ' this ' + esc(q.window) : '') + '</span>' : '';
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-muted);border-radius:var(--r-sm);font-size:12.5px">' +
      '<span class="font-mono">' + esc(k.masked) + '</span><span class="badge badge-gray" style="font-size:10px">.env</span>' + quota +
      '<span style="margin-left:auto;color:var(--tx-muted)">' + (Number(k.requestCount) || 0) + ' req</span>' + statusBadge + '</div>';
  }

  /* ── API helpers ─────────────────────────────*/
  // The model for an AI feature: its own choice in Settings → AI models, else
  // the default model, else '' (the server picks its default).
  function modelFor(feature) {
    const per = state.settings.models || {};
    return (feature && per[feature]) || state.settings.model || '';
  }
  let lastModelUsed = '';

  // Sends a chat request to MetaCode's server, which passes it to its AI
  // service. opts.feature ('coding' | 'assistant' | 'import' | 'csv') picks
  // that feature's model.
  // A similar model answered because the one asked for is rate-limited (or failing,
  // or its provider is resting): say so once in a while, not on every request,
  // naming the models as the pickers do.
  const fallbackNoted = new Map();
  function noteFallback(requested, used, reason) {
    if (!requested || !used || requested === used) return;
    const k = requested + '>' + used, now = Date.now();
    if (now - (fallbackNoted.get(k) || 0) < 10 * 60 * 1000) return;
    fallbackNoted.set(k, now);
    const asked = modelName(requested), answered = modelName(used);
    notify(reason === 'rate_limited'
      ? 'The AI service is rate-limiting “' + asked + '”, so the closest similar model, “' + answered + '”, is answering until it\'s available again.'
      : '“' + asked + '” isn\'t working at the AI service right now, so the closest model, “' + answered + '”, answered.', 'warning', 7000);
  }
  const switchHeader = () => (state.settings.switchModels === false ? { 'X-MetaCode-Model-Switch': 'off' } : {});

  async function callClaude(messages, system='', max_tokens=1000, opts=null) {
    const feature = opts && typeof opts === 'object' ? opts.feature : null;
    const model = modelFor(feature);
    const allMsgs = system ? [{ role: 'system', content: system }, ...messages] : [...messages];
    const body = { messages: allMsgs, max_tokens, temperature: 0.1 };
    if (model) body.model = model;
    const res  = await fetch('/api/ai', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'x-provider': 'openai', 'X-MetaCode-Feature': feature || 'other' }, switchHeader()), body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : res.status === 413 ? TOO_LARGE : ('API error ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.type = data && data.error && data.error.type;
      throw err;
    }
    lastModelUsed = (data && data.model) || model;
    const fb = res.headers.get('X-MetaCode-Model-Fallback');
    if (fb) { lastModelUsed = fb; noteFallback(res.headers.get('X-MetaCode-Model-Requested'), fb, res.headers.get('X-MetaCode-Model-Fallback-Reason')); }
    const text = (data && data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '';
    return String(text || '').trim();
  }

  // How many copies of the model AI Coding runs at once (Settings / AI Coding page).
  function maxParallel() { return (serverStatus && serverStatus.ai && serverStatus.ai.maxParallel) || 16; }
  function clampParallel(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(1, Math.min(maxParallel(), n)) : 4; }
  function getParallel() { return clampParallel(state.settings.parallel); }
  function setParallel(v) { const parallel = clampParallel(v); setState({ settings: { ...state.settings, parallel } }); return parallel; }

  // Many chat requests at once: the server runs up to `parallel` of them side by
  // side with the same model and streams each answer back as it finishes.
  //   items: [{ id, messages, system, max_tokens }]
  //   opts:  { feature, parallel, delay, signal, onResult({ id, ok, text, error, status, model, requested, fallbackReason }) }
  //   (model: the model that answered — a similar one when the requested model was rate-limited)
  // Resolves to { parallel } (how many ran at the end; the server lowers it when rate-limited).
  // A web server in front of MetaCode (nginx's client_max_body_size) refused a
  // request body as too large: its answer is a web page, not MetaCode's JSON.
  const TOO_LARGE = 'The request is larger than the web server in front of MetaCode accepts (HTTP 413). Whoever runs this server can raise that limit (nginx: client_max_body_size — see docs/deploy-vps.md).';
  // Bytes a request body takes on the wire (UTF-8), not characters
  const bodyBytes = text => new Blob([text]).size;

  // A long AI Coding run goes to the server in batches of at most this many
  // requests / bytes, one after another: a web server in front of MetaCode may
  // accept little (nginx's default is 1 MB), and the server takes 2,000 at most.
  const BATCH_REQUESTS = 200, BATCH_BYTES = 512 * 1024;
  async function callClaudeBatch(items, opts) {
    opts = opts || {};
    const model = modelFor(opts.feature);
    // A system prompt every item shares (AI Coding's codebook) is sent once per batch, not once per post
    const shared = items.length && items.every(it => it.system === items[0].system) ? items[0].system || null : null;
    const requests = items.map(it => {
      const own = shared ? null : it.system;
      const body = { messages: own ? [{ role: 'system', content: own }].concat(it.messages) : it.messages.slice(), max_tokens: it.max_tokens || 1000, temperature: 0.1 };
      if (model) body.model = model;
      return { id: it.id, body, bytes: bodyBytes(JSON.stringify({ id: it.id, body })) + 1 };
    });
    const base = bodyBytes(JSON.stringify({ requests: [], parallel: 16, delayMs: 5000, switchModels: true, system: shared || undefined }));
    const chunks = [];
    let cur = [], size = base;
    for (const r of requests) {
      if (cur.length && (cur.length >= BATCH_REQUESTS || size + r.bytes > BATCH_BYTES)) { chunks.push(cur); cur = []; size = base; }
      cur.push(r); size += r.bytes;
    }
    if (cur.length) chunks.push(cur);
    let parallel = clampParallel(opts.parallel || getParallel());
    let stopped = null;          // { status, error, type }: the server gave up on this run (or the plan's posts ran out)
    // Every item gets one result, whichever way its batch ends
    const answered = new Set();
    const report = r => { if (answered.has(r.id)) return; answered.add(r.id); if (opts.onResult) opts.onResult(r); };
    const sendOpts = Object.assign({}, opts, { onResult: report });
    const failAll = (list, f) => list.forEach(r => report({ id: r.id, ok: false, status: f.status, error: f.error, type: f.type }));
    while (chunks.length) {
      const chunk = chunks.shift();
      if (stopped) { failAll(chunk, stopped); continue; }
      let out;
      for (let tries = 0; ; tries++) {
        try { out = await sendBatch(chunk, parallel, shared, model, sendOpts, f => { if (!stopped && (f.type === 'service_unavailable' || f.type === 'limit_reached')) stopped = f; }); break; }
        catch (e) {
          const aborted = e.name === 'AbortError' || (opts.signal && opts.signal.aborted);
          // (a plan runs one batch at a time: the server may still be closing the previous one)
          if (e.status === 429 && e.type === 'account_rate_limited' && tries < 5 && !aborted) { await new Promise(r => setTimeout(r, 1000 * (tries + 1))); continue; }
          if (aborted || (!answered.size && !(e.status === 429 && e.type === 'limit_reached'))) throw e;
          // Partway through a run (the connection dropped, a web server in front answered 502…) or the plan's
          // posts ran out: what's left fails item by item, like a failure inside a batch
          const f = { status: e.status || 0, error: e.message, type: e.type || (e.status ? 'api_error' : 'network') };
          if (f.type === 'service_unavailable' || f.type === 'limit_reached') stopped = f;
          failAll(chunk, f);
          chunks.splice(0).forEach(c => failAll(c, f));
          out = null;
          break;
        }
      }
      if (!out) continue;
      if (out.tooLarge) {
        // Even this batch was too large for the web server in front: halve it, down to single requests
        if (chunk.length > 1) { chunks.unshift(chunk.slice(0, Math.ceil(chunk.length / 2)), chunk.slice(Math.ceil(chunk.length / 2))); continue; }
        failAll(chunk, { status: 413, error: TOO_LARGE, type: 'too_large' });
        continue;
      }
      if (out.parallel) parallel = Math.min(parallel, out.parallel);
    }
    return { parallel };
  }
  // One batch: POST /api/ai/batch, answers streamed back as NDJSON → { parallel } or { tooLarge }
  async function sendBatch(chunk, parallel, system, model, opts, onFailure) {
    const res = await fetch('/api/ai/batch', { method: 'POST', signal: opts.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: chunk.map(r => ({ id: r.id, body: r.body })), parallel, delayMs: opts.delay || 0, switchModels: state.settings.switchModels !== false, system: system || undefined }) });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (res.status === 413) return { tooLarge: true };
      const err = new Error((data && data.error && data.error.message) || ('API error ' + res.status));
      err.status = res.status;
      err.type = data && data.error && data.error.type;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', finished = null;
    const handle = line => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { return; }
      if (msg.done) { finished = msg; return; }
      // The batch paused because the AI service had a server problem (see /api/ai/batch)
      if (msg.notice) { opts.onNotice && opts.onNotice(msg.notice); return; }
      if (msg.ok) {
        lastModelUsed = msg.fallback || (msg.data && msg.data.model) || model;
        if (msg.fallback) noteFallback(msg.requested, msg.fallback, msg.fallbackReason);
        const c = msg.data && msg.data.choices && msg.data.choices[0];
        opts.onResult && opts.onResult({ id: msg.id, ok: true, text: String((c && c.message && c.message.content) || '').trim(),
          model: msg.fallback || null, requested: msg.requested || null, fallbackReason: msg.fallbackReason || null });
      } else {
        const f = { status: msg.status, error: (msg.error && msg.error.message) || 'AI request failed', type: msg.error && msg.error.type };
        onFailure(f);
        opts.onResult && opts.onResult(Object.assign({ id: msg.id, ok: false }, f));
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    handle(buf + decoder.decode());
    if (!finished) throw new Error('The connection to MetaCode\'s server closed before the batch finished.');
    return { parallel: finished.parallel };
  }

  // Number of keys the AI service's providers have (0 when the server can't be reached).
  function getEnvKeyCount() {
    const ai = serverStatus && serverStatus.ai;
    if (!ai) return 0;
    if (Array.isArray(ai.providers)) return ai.providers.reduce((n, p) => n + (p && Number.isInteger(p.keyCount) ? p.keyCount : 0), 0);
    return Number(ai.keyCount) || 0;
  }

  // "Can AI features run?" — the server's AI service is answering with at least one provider set up.
  function hasApiKeys() { return !!(serverStatus && serverStatus.ai && serverStatus.ai.ready); }

  async function refreshServerKeyInfo() {
    try {
      const res = await fetch('/api/settings/status');
      if (!res.ok) return;
      serverStatus = await res.json();
      updateApiStatus();
      renderEnvStatus();
      // The model names for notes and the assistant (the Settings page asks for the list itself)
      if (hasApiKeys() && !modelCache) requestModels().catch(() => {});
    } catch (e) {
      // Server unreachable (e.g. app.html opened directly as a file)
    }
  }

  function updateApiStatus(connected=null) {
    if (connected === null) connected = hasApiKeys();
    const dot   = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    if (dot)   dot.className   = 'status-dot' + (connected ? ' connected' : '');
    if (label) label.textContent = connected ? 'AI ready' : 'AI not set up';
  }

  /* ── Modal ───────────────────────────────────*/
  function openModal(title, bodyHTML, footerHTML='') {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-foot').innerHTML = footerHTML;
    document.getElementById('modal-backdrop').classList.add('is-open');
  }
  function closeModal() {
    document.getElementById('modal-backdrop').classList.remove('is-open');
    document.getElementById('modal-body').innerHTML = '';
    document.getElementById('modal-foot').innerHTML = '';
  }

  /* ── Notifications ───────────────────────────*/
  function notify(message, type='info', duration=3200) {
    const stack = document.getElementById('notif-stack');
    const el = document.createElement('div');
    el.className = `notif ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity='0'; el.style.transform='translateY(8px)'; el.style.transition='all .3s'; setTimeout(()=>el.remove(), 320); }, duration);
  }

  /* ── Utilities ───────────────────────────────*/
  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Robustly pulls a JSON object out of a model response that may include
  // stray preamble text or markdown code fences around the actual JSON.
  function extractJSON(raw) {
    let src = String(raw || '').trim();
    src = src.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = src.indexOf('{');
    const end   = src.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('No JSON object found in the model response. Got: "' + String(raw||'').slice(0, 120) + '"');
    }
    return JSON.parse(src.slice(start, end + 1));
  }

  function downloadCSV(filename, headers, rows) {
    const csvEsc = v => {
      // (v||'') treats 0 as "no value" since 0 is falsy in JS — that would
      // silently blank out legitimate zero scores (e.g. betweenness 0.0,
      // community index 0). Only null/undefined mean "no value" here.
      const s = (v === null || v === undefined) ? '' : String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const lines = [headers.map(csvEsc).join(','), ...rows.map(r => r.map(csvEsc).join(','))];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  }

  /* ── Init ────────────────────────────────────*/
  function init() {
    load();

    // Sidebar nav clicks
    document.querySelectorAll('.nav-item[data-view]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        navigate(el.dataset.view);
        history.pushState(null, '', el.getAttribute('href'));
      });
    });

    // Modal close — X button, click-outside, and Escape key
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-backdrop').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('modal-backdrop').classList.contains('is-open')) {
        closeModal();
      }
    });

    // Hash routing
    function routeHash() {
      const hash = location.hash.slice(1) || 'dashboard';
      navigate(hash);
    }
    window.addEventListener('popstate', routeHash);
    routeHash();

    updateApiStatus();
    refreshServerKeyInfo();   // async; re-runs updateApiStatus once the server says whether AI is ready

    // Accounts (account.js): the chip in the top bar, the Account page in the sidebar
    if (window.Account) {
      const slot = document.getElementById('acct-slot');
      Account.mountChip(slot);
      let seen = 'unknown';
      Account.onChange(me => {
        const on = Account.enabled();
        slot.hidden = !on;
        document.getElementById('nav-account').hidden = !on;
        // Who is signed in or their plan changed (or just became known): redraw pages that show it
        const now = !on ? 'off' : !me ? 'unknown' : me.signedIn ? me.user.id + ':' + me.plan.id : 'out';
        if (now !== seen && now !== 'off' && now !== 'unknown' && ['account', 'ai-coding', 'scraper', 'scraper-beta', 'csv-analyzer', 'network', 'invite', 'projects'].includes(currentView)) navigate(location.hash.slice(1) || currentView);
        seen = now;
      });
    }
  }

  return {
    init, navigate: (v) => navigate(v), setViewCleanup, fetchModels, fetchKeyStatus, reloadEnv, modelFor, AI_FEATURES,
    getCurrentView: () => ({ id: currentView, title: TITLES[currentView] || currentView }),
    getState, setState, save, reloadState,
    callClaude, callClaudeBatch, tooLargeMessage: TOO_LARGE, getParallel, setParallel, maxParallel, updateApiStatus, hasApiKeys, getEnvKeyCount, getServerStatus: () => serverStatus, modelName,
    openModal, closeModal,
    notify, esc, extractJSON, downloadCSV, slugify, genId,
    saveProject, saveSettings, downloadBackup, restoreBackup, testApi, clearCodes, resetAll,
    exportCoded, exportReliability, exportCodebook, exportNetwork, exportNetworkAnalysis
  };
})();
