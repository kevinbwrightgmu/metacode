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
    settings: { provider: 'groq', apiKeys: [], model: 'openai/gpt-oss-20b', delay: 500 }
  };

  const STORAGE_KEY = 'strata_v1'; // kept stable so existing users' saved data isn't orphaned by the rename

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch(e) {}
    // Migrate the old single "apiKey" field (pre key-rotation) to the new
    // "apiKeys" array, so existing users don't need to re-enter their key.
    if (!state.settings) state.settings = { provider: 'groq', apiKeys: [], model: 'openai/gpt-oss-20b', delay: 500 };
    if (!Array.isArray(state.settings.apiKeys)) state.settings.apiKeys = [];
    if (!state.settings.apiKeys.length && state.settings.apiKey) {
      state.settings.apiKeys = [state.settings.apiKey];
    }
  }
  function getState()  { return state; }
  function setState(patch) { Object.assign(state, patch); save(); }

  /* ── Routing ─────────────────────────────────*/
  const VIEWS = {
    'dashboard':    renderDashboard,
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
    'surveys':      param => SurveyStudio.render(param)
  };

  const TITLES = {
    'dashboard':'Dashboard','settings':'Settings','import':'Import Data','scraper':'Reddit Scraper',
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
  // (Survey Studio flushes its autosave and removes its listeners).
  function setViewCleanup(fn) { viewCleanup = fn; }

  function navigate(view) {
    // Sub-routes: "#surveys/<id>/<mode>" → view "surveys", param "<id>/<mode>"
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
          <div class="card-title">AI Provider</div>
          <div style="display:flex;flex-direction:column;gap:16px">
            <div class="form-group">
              <label class="form-label">Provider</label>
              <select class="form-select" id="s-provider" onchange="App.onProviderChange()">
                <option value="groq"      ${settings.provider==='groq'||!settings.provider?'selected':''}>Groq (free — recommended)</option>
                <option value="anthropic" ${settings.provider==='anthropic'?'selected':''}>Anthropic (Claude)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">API Keys <span>(one per line — multiple keys enable automatic rotation)</span></label>
              <textarea class="form-textarea" id="s-keys" style="min-height:90px;font-family:var(--f-mono);font-size:12.5px"
                placeholder="${(settings.provider||'groq')==='groq'?'gsk_...':'sk-ant-...'}">${esc((settings.apiKeys||[]).join('\n'))}</textarea>
              <div class="form-hint" id="s-key-hint">${getProviderHint(settings.provider||'groq')}</div>
            </div>
            <div class="form-group">
              <label class="form-label" style="display:flex;align-items:center;justify-content:space-between">
                Model
                <button class="btn btn-ghost btn-sm" onclick="App.fetchModels()" style="font-size:11.5px;padding:2px 8px">&#8635; Fetch Models</button>
              </label>
              <select class="form-select" id="s-model">
                <option value="">Save keys then click Fetch Models</option>
              </select>
              <div class="form-hint" id="s-model-hint">Click Fetch Models to load models available to your keys.</div>
            </div>
            <div class="form-group">
              <label class="form-label">Delay between calls <span>(ms)</span></label>
              <input class="form-input" id="s-delay" type="number" value="${settings.delay}" min="0" max="5000" step="100">
              <div class="form-hint">Increase if you hit rate limits (default: 500 ms)</div>
            </div>
            <div style="display:flex;gap:10px">
              <button class="btn btn-primary" onclick="App.saveSettings()">Save Settings</button>
              <button class="btn btn-secondary" onclick="App.testApi()">Test Connection</button>
            </div>
            <div id="api-test-result"></div>
          </div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
            Key Rotation Status
            <button class="btn btn-ghost btn-sm" onclick="App.fetchKeyStatus()" style="font-size:11.5px;padding:2px 8px">&#8635; Refresh</button>
          </div>
          <div style="font-size:12.5px;color:var(--tx-second);margin-bottom:12px">
            Requests automatically retry on the next key when one hits a rate limit or fails. Note: Groq and Anthropic both rate-limit
            at the <em>account</em> level, so multiple keys from the same account share one limit — real benefit comes from keys on
            separate accounts, or from configuring both providers.
          </div>
          <div id="key-status-list" style="display:flex;flex-direction:column;gap:6px">
            <div class="text-muted" style="font-size:12.5px">Save your keys, then click Refresh to see rotation status.</div>
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
    setTimeout(() => { fetchModels(); fetchKeyStatus(); }, 0);
  }

  function saveProject() {
    const name = document.getElementById('s-name').value.trim() || 'Untitled Project';
    const desc = document.getElementById('s-desc').value.trim();
    setState({ project: { name, description: desc } });
    document.getElementById('topbar-project').textContent = name;
    notify('Project saved', 'success');
  }

  function saveSettings() {
    const apiKeys  = parseKeysTextarea(document.getElementById('s-keys').value);
    const provider = document.getElementById('s-provider').value;
    const model    = document.getElementById('s-model').value;
    const delay    = parseInt(document.getElementById('s-delay').value) || 500;
    setState({ settings: { ...state.settings, provider, apiKeys, model, delay } });
    updateApiStatus();
    notify('Settings saved', 'success');
  }

  // Splits a textarea's contents into a clean list of keys — one per line,
  // stripped of whitespace and invisible zero-width characters that can
  // sneak in from copy-paste and silently corrupt a key.
  function parseKeysTextarea(raw) {
    return String(raw || '').split('\n')
      .map(k => k.replace(/[\s\u200B-\u200D\uFEFF]/g, ''))
      .filter(Boolean);
  }

  async function testApi() {
    const el = document.getElementById('api-test-result');
    el.innerHTML = '<span style="color:var(--tx-muted)">Testing connection…</span>';

    const keysEl   = document.getElementById('s-keys');
    const keys     = keysEl ? parseKeysTextarea(keysEl.value) : (state.settings.apiKeys || []);
    const keyHeader = keys.length ? keys.join(',') : '';
    const provider = document.getElementById('s-provider') ? document.getElementById('s-provider').value : (state.settings.provider || 'groq');
    const model    = document.getElementById('s-model')    ? document.getElementById('s-model').value    : state.settings.model;

    try {
      let body;
      if (provider === 'groq') {
        body = { model: model || 'openai/gpt-oss-20b',
                 messages: [{role:'user', content:'Reply with exactly one word: ok'}],
                 max_tokens: 10, temperature: 0.1 };
      } else {
        body = { model: model || 'claude-sonnet-4-6',
                 max_tokens: 10,
                 messages: [{role:'user', content:'Reply with exactly one word: ok'}] };
      }
      const headers = { 'Content-Type': 'application/json', 'x-provider': provider };
      if (keyHeader) headers['x-api-key'] = keyHeader;

      const res  = await fetch('/api/ai', { method:'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error && data.error.message) || ('Error ' + res.status));

      const text = provider === 'groq'
        ? ((data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : '')
        : ((data.content || []).map(b => b.text || '').join(''));


      el.innerHTML = '<span style="color:var(--success)">✓ Connected! (' + keys.length + ' key' + (keys.length!==1?'s':'') + ' configured) Response: ' + esc(text.trim().slice(0,60)) + '</span>';
      updateApiStatus(true);
      fetchKeyStatus();
    } catch(e) {
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

  /* ── Provider helpers ───────────────────────*/
  function getProviderHint(provider) {
    if (provider === 'groq')
      return 'Free keys from <a href="https://console.groq.com" target="_blank" style="color:var(--blue)">console.groq.com</a> (no credit card). Groq rate-limits by account, so multiple keys from the same account share one limit — use separate accounts for real rotation benefit.';
    return 'Keys from <a href="https://console.anthropic.com" target="_blank" style="color:var(--blue)">console.anthropic.com</a>. Anthropic also rate-limits by account — multiple keys from the same account share one limit.';
  }

  async function fetchModels() {
    const provEl   = document.getElementById('s-provider');
    const modelSel = document.getElementById('s-model');
    const hintEl   = document.getElementById('s-model-hint');
    if (!modelSel) return;
    const provider = provEl ? provEl.value : (state.settings.provider || 'groq');
    const keysEl   = document.getElementById('s-keys');
    const keys     = keysEl ? parseKeysTextarea(keysEl.value) : (state.settings.apiKeys || []);
    const keyHeader = keys.length ? keys.join(',') : '';
    modelSel.innerHTML = '<option value="">Loading models...</option>';
    if (hintEl) hintEl.textContent = 'Contacting ' + provider + '...';
    try {
      const headers = { 'x-provider': provider };
      if (keyHeader) headers['x-api-key'] = keyHeader;
      const res  = await fetch('/api/models', { headers });
      const data = await res.json();
      const models  = data.models || [];
      const current = state.settings.model || (provider === 'groq' ? 'openai/gpt-oss-20b' : 'claude-sonnet-4-6');
      if (!models.length) {
        modelSel.innerHTML = '<option value="">No models found - check your API keys</option>';
        if (hintEl) hintEl.textContent = 'No models returned. Verify your keys and try again.';
        return;
      }
      modelSel.innerHTML = models.map(m =>
        '<option value="' + m.id + '"' + (m.id === current ? ' selected' : '') + '>' + (m.name || m.id) + '</option>'
      ).join('');
      if (models.length && !models.find(m => m.id === current)) modelSel.value = models[0].id;
      if (hintEl) hintEl.textContent = models.length + ' model' + (models.length !== 1 ? 's' : '') + ' available for your keys.';
    } catch (err) {
      modelSel.innerHTML = '<option value="">Error fetching models</option>';
      if (hintEl) hintEl.textContent = 'Error: ' + err.message;
    }
  }

  // Populates the "Key Rotation Status" list on the Settings page: each
  // configured key's masked value, whether it's available / cooling down /
  // invalid, its request count, and whether it came from .env or Settings.
  async function fetchKeyStatus() {
    const listEl = document.getElementById('key-status-list');
    if (!listEl) return;
    const provEl   = document.getElementById('s-provider');
    const provider = provEl ? provEl.value : (state.settings.provider || 'groq');
    const keysEl   = document.getElementById('s-keys');
    const keys     = keysEl ? parseKeysTextarea(keysEl.value) : (state.settings.apiKeys || []);

    if (!keys.length) {
      listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px">No keys configured yet.</div>';
      return;
    }

    listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px">Loading…</div>';
    try {
      const headers = { 'x-provider': provider, 'x-api-key': keys.join(',') };
      const res  = await fetch('/api/keys/status', { headers });
      const data = await res.json();
      const items = data.keys || [];
      if (!items.length) {
        listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px">No keys configured yet.</div>';
        return;
      }
      listEl.innerHTML = items.map(k => {
        const statusBadge = k.status === 'available'
          ? '<span class="badge badge-green">Available</span>'
          : k.status === 'cooling_down'
            ? '<span class="badge badge-amber">Cooling down ' + k.cooldownSecondsLeft + 's</span>'
            : '<span class="badge badge-red">Invalid</span>';
        const sourceTag = k.source === 'env' ? '<span class="badge badge-gray" style="font-size:10px">.env</span>' : '';
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--bg-muted);border-radius:var(--r-sm);font-size:12.5px">' +
          '<span class="font-mono">' + esc(k.masked) + '</span>' +
          sourceTag +
          '<span style="margin-left:auto;color:var(--tx-muted)">' + k.requestCount + ' req</span>' +
          statusBadge +
        '</div>';
      }).join('');
    } catch(e) {
      listEl.innerHTML = '<div class="text-muted" style="font-size:12.5px;color:var(--error)">Could not load status: ' + esc(e.message) + '</div>';
    }
  }

  function onProviderChange() {
    const p     = document.getElementById('s-provider').value;
    const hint  = document.getElementById('s-key-hint');
    const keysEl = document.getElementById('s-keys');
    if (hint)   hint.innerHTML     = getProviderHint(p);
    if (keysEl) keysEl.placeholder = p === 'groq' ? 'gsk_...' : 'sk-ant-...';
    fetchModels();
    fetchKeyStatus();
  }

  /* ── API helpers ─────────────────────────────*/
  async function callClaude(messages, system='', max_tokens=1000, keyOverride=null) {
    const provider = state.settings.provider || 'groq';
    const keys     = keyOverride ? [keyOverride] : (state.settings.apiKeys || []);
    const keyHeader = keys.map(k => String(k).replace(/[\s\u200B-\u200D\uFEFF]/g, '')).filter(Boolean).join(',');
    const defModel = provider === 'groq' ? 'openai/gpt-oss-20b' : 'claude-sonnet-4-6';
    const model    = state.settings.model || defModel;

    let body;
    if (provider === 'groq') {
      // Groq uses OpenAI-compatible format; system message goes in the messages array
      const allMsgs = system ? [{ role: 'system', content: system }, ...messages] : [...messages];
      body = { model, messages: allMsgs, max_tokens, temperature: 0.1 };
    } else {
      // Anthropic format
      body = { model, max_tokens, messages };
      if (system) body.system = system;
    }

    const headers = { 'Content-Type': 'application/json', 'x-provider': provider };
    if (keyHeader) headers['x-api-key'] = keyHeader;

    const res  = await fetch('/api/ai', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();

    if (!res.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('API error ' + res.status);
      throw new Error(msg);
    }

    // Parse response based on provider format
    let text;
    if (provider === 'groq') {
      text = (data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content : '';
    } else {
      text = (data.content || []).map(b => b.text || '').join('');
    }
    return text.trim();
  }

  // How many keys the server has in its .env file, per provider. Only the
  // count is reported (by /api/health) — the keys themselves never reach the
  // browser. Stays at zero when the server can't be reached.
  let serverEnvKeyCounts = { groq: 0, anthropic: 0 };

  function getEnvKeyCount(provider) {
    return serverEnvKeyCounts[provider || state.settings.provider || 'groq'] || 0;
  }

  // Single source of truth for "can AI features run?": a key saved in
  // Settings, or one in the server's .env for the selected provider.
  function hasApiKeys() {
    const settingsKeys = Array.isArray(state.settings.apiKeys) ? state.settings.apiKeys.length : 0;
    return settingsKeys > 0 || getEnvKeyCount() > 0;
  }

  async function refreshServerKeyInfo() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return;
      const data = await res.json();
      serverEnvKeyCounts = {
        groq:      Number(data.groqEnvKeyCount)      || 0,
        anthropic: Number(data.anthropicEnvKeyCount) || 0
      };
      updateApiStatus();
    } catch (e) {
      // Server unreachable (e.g. app.html opened directly as a file):
      // fall back to Settings keys only.
    }
  }

  function updateApiStatus(connected=null) {
    if (connected === null) connected = hasApiKeys();
    const dot   = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    if (dot)   dot.className   = 'status-dot' + (connected ? ' connected' : '');
    if (label) label.textContent = connected ? 'API connected' : 'Not connected';
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
    init, navigate: (v) => navigate(v), setViewCleanup, onProviderChange, fetchModels, fetchKeyStatus,
    getCurrentView: () => ({ id: currentView, title: TITLES[currentView] || currentView }),
    getState, setState, save,
    callClaude, updateApiStatus, hasApiKeys, getEnvKeyCount,
    openModal, closeModal,
    notify, esc, extractJSON, downloadCSV, slugify, genId,
    saveProject, saveSettings, testApi, clearCodes, resetAll,
    exportCoded, exportReliability, exportCodebook, exportNetwork, exportNetworkAnalysis
  };
})();
