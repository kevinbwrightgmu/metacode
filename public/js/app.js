/* ══════════════════════════════════════════════
   app.js — Central router, state, UI framework
   ══════════════════════════════════════════════ */

const App = (() => {

  /* ── State ─────────────────────────────────── */
  let state = {
    project:  { name: 'Untitled Project', description: '' },
    posts:    [],   // [{id, text, author, timestamp, engagement:{}, humanCodes:{}, aiCodes:{}}]
    codebook: [],   // [{id, name, description, codes:[{id,label,description}]}]
    network:  { nodes: [], edges: [] },
    networkAnalysis: null, // last NetworkX result from Analyze CSV (see csv-analyzer.js)
    settings: { model: '', models: {}, delay: 500 }   // AI models (Settings → AI models); keys live in the server's .env
  };

  const STORAGE_KEY = 'strata_v1'; // kept stable so existing users' saved data isn't orphaned by the rename

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    // Autosave to the linked saved project (Projects page), if any
    if (typeof ProjectsView !== 'undefined') { try { ProjectsView.noteChange(); } catch (e) { /* never block saving */ } }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch(e) {}
    // AI runs through the server's EMIS key (.env). Keys once typed into the
    // old Settings key box are no longer used, so they aren't kept; old
    // default model ids (Groq/Anthropic) are cleared so the server's default
    // model is used until one is picked in Settings → AI models.
    if (!state.settings || typeof state.settings !== 'object') state.settings = {};
    delete state.settings.apiKeys; delete state.settings.apiKey; delete state.settings.provider;
    if (['openai/gpt-oss-20b', 'claude-sonnet-4-6'].includes(state.settings.model)) state.settings.model = '';
    if (typeof state.settings.model !== 'string') state.settings.model = '';
    if (!state.settings.models || typeof state.settings.models !== 'object') state.settings.models = {};
    if (!Number.isFinite(Number(state.settings.delay))) state.settings.delay = 500;
  }
  function getState()  { return state; }
  function setState(patch) { Object.assign(state, patch); save(); }

  /* ── Routing ─────────────────────────────────*/
  const VIEWS = {
    'dashboard':    renderDashboard,
    'projects':     () => ProjectsView.render(),
    'settings':     renderSettings,
    'import':       () => DataManager.render(),
    'scraper':      () => RedditScraper.render(),
    'codebook':     () => Codebook.render(),
    'ai-coding':    () => AICoder.render(),
    'human-coding': () => HumanCoder.render(),
    'reliability':  () => ReliabilityAnalyzer.render(),
    'csv-analyzer': () => CSVAnalyzer.render(),
    'network':      () => NetworkViz.render(),
    'metrics':      () => EngagementViz.render(),
    'export':       renderExport,
    // Survey Studio has its own page now; old #surveys links go there.
    'surveys':      param => { location.replace('studio.html' + (param ? '#' + param : '')); }
  };

  const TITLES = {
    'dashboard':'Dashboard','projects':'Projects','settings':'Settings','import':'Import Data','scraper':'Reddit Scraper',
    'codebook':'Codebook','ai-coding':'AI Coding','human-coding':'Human Coding',
    'reliability':'Reliability Analysis','csv-analyzer':'Analyze CSV (NetworkX)',
    'network':'Network Graph',
    'metrics':'Metrics','export':'Export Data','surveys':'Survey Studio'
  };

  // Former route ids that must keep working (bookmarks, browser history).
  // The Metrics section used to live at #engagement.
  const ROUTE_ALIASES = { 'engagement': 'metrics' };

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
            AI connection (EMIS)
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
              <label class="form-label" for="s-delay">Delay between AI Coding calls <span>(ms)</span></label>
              <input class="form-input" id="s-delay" type="number" value="${settings.delay}" min="0" max="5000" step="100">
              <div class="form-hint">Increase if you hit rate limits (default: 500 ms)</div>
            </div>
            <div><button class="btn btn-primary" onclick="App.saveSettings()">Save model settings</button></div>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
            EMIS keys
            <button class="btn btn-ghost btn-sm" onclick="App.fetchKeyStatus()" style="font-size:11.5px;padding:2px 8px">&#8635; Refresh</button>
          </div>
          <div style="font-size:12.5px;color:var(--tx-second);margin-bottom:12px">
            Keys come only from <code>EMIS_API_KEY</code> in the server's .env file (several keys can be comma-separated; MetaCode rotates
            between them and rests a key whose quota is used up). The keys never reach this page — only a masked form.
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
    setTimeout(() => { renderEnvStatus(); fetchModels(); fetchKeyStatus(); }, 0);
  }

  function saveProject() {
    const name = document.getElementById('s-name').value.trim() || 'Untitled Project';
    const desc = document.getElementById('s-desc').value.trim();
    setState({ project: { name, description: desc } });
    document.getElementById('topbar-project').textContent = name;
    notify('Project saved', 'success');
  }

  // AI features that can each use their own model (Settings → AI models).
  const AI_FEATURES = [
    ['coding', 'AI Coding', 'codes posts with your codebook'],
    ['assistant', 'Ask MetaCode', 'the help assistant'],
    ['import', 'Import Data', 'works out the columns of a CSV'],
    ['csv', 'Analyze CSV', 'finds the source/target columns']
  ];

  function saveSettings() {
    const model = document.getElementById('s-model').value;
    const models = {};
    document.querySelectorAll('#s-feature-models select[data-feature]').forEach(sel => { if (sel.value) models[sel.dataset.feature] = sel.value; });
    const delay = parseInt(document.getElementById('s-delay').value, 10);
    setState({ settings: { ...state.settings, model, models, delay: Number.isFinite(delay) ? Math.max(0, delay) : 500 } });
    notify('Model settings saved', 'success');
  }

  async function testApi() {
    const el = document.getElementById('api-test-result');
    el.innerHTML = '<span style="color:var(--tx-muted)">Testing connection…</span>';
    try {
      const text = await callClaude([{ role: 'user', content: 'Reply with exactly one word: ok' }], '', 256, { feature: null });
      el.innerHTML = '<span style="color:var(--success)">✓ Connected — model ' + esc(lastModelUsed || 'default') + ' replied: ' + esc(String(text).trim().slice(0, 60)) + '</span>';
      updateApiStatus(true);
      fetchKeyStatus();
    } catch (e) {
      el.innerHTML = '<span style="color:var(--error)">✗ ' + esc(e.message) + '</span>';
      updateApiStatus(false);
    }
  }

  function clearCodes() {
    if (!confirm('Clear all AI and human coding data? Post text and codebook will remain.')) return;
    state.posts = state.posts.map(p => ({ ...p, aiCodes:{}, humanCodes:{} }));
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
    const confDims  = codebook.map(d => `ai_confidence_${d.id}`);

    const headers = ['id','text','author','timestamp',
      'eng_likes','eng_shares','eng_comments','eng_views',
      ...aiDims, ...humanDims, ...confDims, 'agree_all'];

    const rows = posts.map(p => {
      const agree = codebook.length > 0 && codebook.every(d => {
        const a = (p.aiCodes[d.id] || {}).code;
        const h = p.humanCodes[d.id];
        return a && h && a === h;
      });
      return [
        p.id, p.text, p.author || '', p.timestamp || '',
        p.engagement?.likes||'', p.engagement?.shares||'',
        p.engagement?.comments||'', p.engagement?.views||'',
        ...codebook.map(d => (p.aiCodes[d.id]||{}).code || ''),
        ...codebook.map(d => p.humanCodes[d.id] || ''),
        ...codebook.map(d => (p.aiCodes[d.id]||{}).confidence || ''),
        agree ? '1' : '0'
      ];
    });
    downloadCSV('metacode_coded_posts.csv', headers, rows);
    notify('Exported coded posts', 'success');
  }

  function exportReliability() {
    const stats = ReliabilityAnalyzer.computeAll();
    if (!stats.length) { notify('No dual-coded posts yet', 'warning'); return; }
    const headers = ['dimension','n_paired','pct_agreement','cohens_kappa','krippendorff_alpha','interpretation'];
    const rows = stats.map(s => [s.name, s.n, (s.pa*100).toFixed(1)+'%', s.kappa.toFixed(3), s.alpha.toFixed(3), s.interp]);
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

  /* ── AI settings (server .env status, models, keys) ─────*/
  let serverStatus = null;      // /api/settings/status: what the server read from .env

  // Shows what the server read from .env and whether AI is ready — names of
  // settings only, never values.
  function renderEnvStatus(statusOverride) {
    const box = document.getElementById('s-env-status');
    const badge = document.getElementById('s-ai-badge');
    const st = statusOverride || serverStatus;
    if (!box) return;
    if (!st) { box.innerHTML = '<div style="color:var(--error)">Couldn\'t reach the MetaCode server to check its settings.</div>'; return; }
    const env = st.env, ai = st.ai;
    if (badge) badge.innerHTML = ai.ready ? '<span class="badge badge-green">Ready</span>' : '<span class="badge badge-red">Not set up</span>';
    const rows = [];
    if (env.found && !env.error) {
      rows.push('<div>✓ Settings file <code>' + esc(env.name) + '</code> read from ' + esc(env.where) + (env.encoding && env.encoding !== 'UTF-8' ? ' (' + esc(env.encoding) + ')' : '') +
        ' — ' + env.keys.length + ' setting' + (env.keys.length === 1 ? '' : 's') + (env.keys.length ? ': ' + env.keys.map(k => '<code>' + esc(k) + '</code>').join(' ') : '') + '</div>');
    } else if (env.error) {
      rows.push('<div style="color:var(--error)">✗ Found <code>' + esc(env.name) + '</code> in ' + esc(env.where) + ' but couldn\'t read it: ' + esc(env.error) + '</div>');
    } else if (env.disabled) {
      rows.push('<div class="text-muted">The .env file is switched off for this server (METACODE_ENV_FILE=none).</div>');
    } else {
      rows.push('<div style="color:var(--error)">✗ No <code>.env</code> file found (looked in ' + esc((env.searched || []).join(', ')) + ').</div>' +
        '<div class="form-hint">Copy <code>.env.example</code> to a file named exactly <code>.env</code> next to <code>server.js</code>, put <code>EMIS_API_KEY=your-key</code> in it, save, then click <b>Reload .env</b>.</div>');
    }
    (env.warnings || []).forEach(w => rows.push('<div style="color:#B45309">⚠ ' + esc(w) + '</div>'));
    if (env.overridden && env.overridden.length) rows.push('<div style="color:#B45309">⚠ .env replaced older values set in this computer\'s environment for: ' + env.overridden.map(k => '<code>' + esc(k) + '</code>').join(' ') + '</div>');
    if (ai.ready) rows.push('<div>✓ AI is ready: ' + ai.keyCount + ' EMIS key' + (ai.keyCount === 1 ? '' : 's') + (ai.baseHost ? ' · ' + esc(ai.baseHost) : '') + (ai.defaultModel ? ' · EMIS_MODEL=' + esc(ai.defaultModel) : '') + (ai.proxy ? ' · via proxy ' + esc(ai.proxy) : '') + '</div>');
    else rows.push('<div style="color:var(--error)">✗ AI isn\'t ready: ' + esc(ai.problem || 'EMIS_API_KEY isn\'t set.') + '</div>');
    (ai.warnings || []).forEach(w => rows.push('<div style="color:#B45309">⚠ ' + esc(w) + '</div>'));
    rows.push('<div class="form-hint">Server ' + esc(st.server.version || '') + ' started ' + esc(new Date(st.server.startedAt).toLocaleString()) + (env.loadedAt ? ' · .env read ' + esc(new Date(env.loadedAt).toLocaleTimeString()) : '') + '</div>');
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

  let modelCache = null;
  async function fetchModels() {
    const modelSel = document.getElementById('s-model');
    const hintEl   = document.getElementById('s-model-hint');
    const feats    = document.getElementById('s-feature-models');
    if (!modelSel) return;
    modelSel.innerHTML = '<option value="">Loading models…</option>';
    try {
      const res  = await fetch('/api/models');
      const data = await res.json();
      const models = data.models || [];
      modelCache = models;
      const opt = (m, cur) => '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.name || m.id) + '</option>';
      if (!models.length) {
        modelSel.innerHTML = '<option value="">No models available</option>';
        if (hintEl) hintEl.textContent = data.note || 'No models returned — check the AI connection above.';
      } else {
        const current = state.settings.model || '';
        modelSel.innerHTML = '<option value="">Server default (' + esc(models[0].id) + ')</option>' + models.map(m => opt(m, current)).join('');
        if (current && !models.find(m => m.id === current)) {
          modelSel.insertAdjacentHTML('beforeend', '<option value="' + esc(current) + '" selected>' + esc(current) + ' (not in the list)</option>');
        }
        if (hintEl) hintEl.textContent = models.length + ' model' + (models.length !== 1 ? 's' : '') + ' available' + (data.source ? ' (from ' + data.source + ')' : '') + '.';
      }
      if (feats) {
        const per = state.settings.models || {};
        feats.innerHTML = AI_FEATURES.map(([id, label, what]) => {
          const cur = per[id] || '';
          let options = '<option value="">Same as default</option>' + models.map(m => opt(m, cur)).join('');
          if (cur && !models.find(m => m.id === cur)) options += '<option value="' + esc(cur) + '" selected>' + esc(cur) + ' (not in the list)</option>';
          return '<div class="s-feature-row"><label for="s-fm-' + id + '"><b>' + esc(label) + '</b><span>' + esc(what) + '</span></label>' +
            '<select class="form-select" id="s-fm-' + id + '" data-feature="' + id + '">' + options + '</select></div>';
        }).join('');
      }
    } catch (err) {
      modelSel.innerHTML = '<option value="">Couldn\'t load models</option>';
      if (hintEl) hintEl.textContent = 'Error: ' + err.message;
    }
  }

  // Settings → EMIS keys: each configured key's masked form, availability,
  // request count and quota.
  async function fetchKeyStatus() {
    const listEl = document.getElementById('key-status-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px">Loading…</div>';
    try {
      const res  = await fetch('/api/keys/status');
      const data = await res.json();
      const items = data.keys || [];
      if (!items.length) {
        listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px">No EMIS keys loaded — add <code>EMIS_API_KEY=…</code> to .env and click Reload .env above.</div>';
        return;
      }
      listEl.innerHTML = items.map(k => {
        const statusBadge = k.status === 'available'
          ? '<span class="badge badge-green">Available</span>'
          : k.status === 'cooling_down'
            ? '<span class="badge badge-amber">Resting ' + k.cooldownSecondsLeft + 's</span>'
            : '<span class="badge badge-red">Rejected by EMIS</span>';
        const quota = k.quota && k.quota.remainingPrompts !== null && k.quota.remainingPrompts !== undefined ? '<span style="color:var(--tx-muted)">' + k.quota.remainingPrompts + ' prompts left</span>' : '';
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-muted);border-radius:var(--r-sm);font-size:12.5px">' +
          '<span class="font-mono">' + esc(k.masked) + '</span><span class="badge badge-gray" style="font-size:10px">.env</span>' + quota +
          '<span style="margin-left:auto;color:var(--tx-muted)">' + k.requestCount + ' req</span>' + statusBadge + '</div>';
      }).join('');
    } catch(e) {
      listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px;color:var(--error)">Could not load status: ' + esc(e.message) + '</div>';
    }
  }

  /* ── API helpers ─────────────────────────────*/
  // The model for an AI feature: its own choice in Settings → AI models, else
  // the default model, else '' (the server picks its default).
  function modelFor(feature) {
    const per = state.settings.models || {};
    return (feature && per[feature]) || state.settings.model || '';
  }
  let lastModelUsed = '';

  // Sends a chat request to MetaCode's server, which calls EMIS with the key
  // from .env. opts.feature ('coding' | 'assistant' | 'import' | 'csv') picks
  // that feature's model.
  async function callClaude(messages, system='', max_tokens=1000, opts=null) {
    const feature = opts && typeof opts === 'object' ? opts.feature : null;
    const model = modelFor(feature);
    const allMsgs = system ? [{ role: 'system', content: system }, ...messages] : [...messages];
    const body = { messages: allMsgs, max_tokens, temperature: 0.1 };
    if (model) body.model = model;
    const res  = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-provider': 'openai' }, body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('API error ' + res.status);
      throw new Error(msg);
    }
    lastModelUsed = (data && data.model) || model;
    const text = (data && data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '';
    return String(text || '').trim();
  }

  // Number of EMIS keys the server loaded from .env (0 when it can't be reached).
  function getEnvKeyCount() { return serverStatus && serverStatus.ai ? serverStatus.ai.keyCount : 0; }

  // "Can AI features run?" — the server has a working EMIS setup from .env.
  function hasApiKeys() { return !!(serverStatus && serverStatus.ai && serverStatus.ai.ready); }

  async function refreshServerKeyInfo() {
    try {
      const res = await fetch('/api/settings/status');
      if (!res.ok) return;
      serverStatus = await res.json();
      updateApiStatus();
      renderEnvStatus();
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
    refreshServerKeyInfo();   // async; re-runs updateApiStatus once .env key counts arrive
  }

  return {
    init, navigate: (v) => navigate(v), setViewCleanup, fetchModels, fetchKeyStatus, reloadEnv, modelFor, AI_FEATURES,
    getCurrentView: () => ({ id: currentView, title: TITLES[currentView] || currentView }),
    getState, setState, save,
    callClaude, updateApiStatus, hasApiKeys, getEnvKeyCount, getServerStatus: () => serverStatus,
    openModal, closeModal,
    notify, esc, extractJSON, downloadCSV, slugify, genId,
    saveProject, saveSettings, testApi, clearCodes, resetAll,
    exportCoded, exportReliability, exportCodebook, exportNetwork, exportNetworkAnalysis
  };
})();
