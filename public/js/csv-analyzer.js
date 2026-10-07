/* ══════════════════════════════════════════════
   csv-analyzer.js — AI-assisted edge detection +
   Python NetworkX analysis for arbitrary CSVs
   ══════════════════════════════════════════════ */

const CSVAnalyzer = (() => {

  let lastParsed     = null;  // { headers, rows, sample }
  let lastMapping     = null; // detected/edited column mapping
  let lastEdgesBuilt  = null; // [{source,target,weight}] actually sent to Python
  let lastLabelsMap   = null; // {nodeId: label} sent alongside edges
  let lastAnalysis    = null; // result JSON from /api/network/analyze

  /* ── Render ─────────────────────────────────*/
  function render() {
    const container = document.getElementById('view-container');
    container.innerHTML =
      '<div class="view-header"><div>' +
        '<div class="view-title">Analyze CSV (NetworkX)</div>' +
        '<div class="view-subtitle">Upload any CSV — AI detects the edge structure, then Python NetworkX computes network statistics</div>' +
      '</div></div>' +

      '<div id="py-status-banner" class="card" style="margin-bottom:16px;padding:12px 18px">' +
        '<span class="text-muted" style="font-size:13px">Checking Python / NetworkX availability…</span>' +
      '</div>' +

      '<div class="card" style="margin-bottom:20px">' +
        '<div class="card-title">Upload CSV</div>' +
        '<div class="upload-zone" id="csvan-drop" onclick="document.getElementById(\'csvan-file\').click()">' +
          '<input type="file" id="csvan-file" accept=".csv" onchange="CSVAnalyzer.handleFile(this)">' +
          '<svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          '<div class="upload-title">Drop any CSV here or click to browse</div>' +
          '<div class="upload-sub">Works with any column names — the edge structure is auto-detected</div>' +
        '</div>' +
        '<button class="btn btn-secondary btn-sm mt-2" onclick="CSVAnalyzer.loadSample()">Load sample edge list</button>' +
      '</div>' +

      '<div id="csvan-results"></div>';

    setupDrop();
    checkPythonStatus();
  }

  function setupDrop() {
    const zone = document.getElementById('csvan-drop');
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) parseFile(file);
    });
  }

  async function checkPythonStatus() {
    const el = document.getElementById('py-status-banner');
    if (!el) return;
    try {
      const res  = await fetch('/api/network/status');
      const data = await res.json();
      if (data.ok) {
        el.innerHTML = '<span style="color:var(--success);font-size:13px">&#10003; Python + NetworkX ' +
          App.esc(data.version || '') + ' ready</span>';
      } else {
        el.innerHTML = '<span style="color:var(--error);font-size:13px">&#10007; NetworkX not available: ' +
          App.esc(data.error || 'unknown error') +
          ' — run <code style="font-family:var(--f-mono)">pip install -r requirements.txt</code> in the project folder</span>';
      }
    } catch (e) {
      el.innerHTML = '<span style="color:var(--error);font-size:13px">&#10007; Could not reach the analysis server.</span>';
    }
  }

  /* ── File handling ───────────────────────────*/
  function handleFile(input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    parseFile(f);
  }

  function parseFile(file) {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: results => {
        const rows = results.data;
        if (!rows.length) { App.notify('CSV appears empty', 'error'); return; }
        const headers = Object.keys(rows[0]);
        lastParsed = { headers, rows, sample: rows.slice(0, 5) };
        runDetection();
      },
      error: err => App.notify('CSV parse error: ' + err.message, 'error')
    });
  }

  function loadSample() {
    const csvText =
      'source,target,weight,type\n' +
      'u1,u5,5,follows\nu1,u9,4,follows\nu1,u10,6,follows\nu2,u6,3,follows\nu2,u8,4,follows\n' +
      'u2,u13,5,follows\nu3,u7,4,follows\nu3,u11,6,follows\nu3,u15,3,follows\nu4,u18,7,follows\n' +
      'u4,u12,5,follows\nu4,u20,4,follows\nu16,u3,8,follows\nu16,u11,6,follows\nu16,u4,5,follows\n' +
      'u1,u2,2,mention\nu3,u2,3,mention\nu11,u2,2,mention\nu5,u14,4,follows\nu9,u19,3,follows\n' +
      'u17,u2,5,follows\nu17,u13,4,follows\nu18,u20,6,retweet\nu7,u14,3,follows';
    const parsed  = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    const rows    = parsed.data;
    const headers = Object.keys(rows[0]);
    lastParsed = { headers, rows, sample: rows.slice(0, 5) };
    App.notify('Loaded sample edge list (24 edges)', 'success');
    runDetection();
  }

  /* ── Structure detection ─────────────────────*/
  async function runDetection() {
    const resultsEl = document.getElementById('csvan-results');
    resultsEl.innerHTML = '<div class="loading-state">Detecting file structure…</div>';

    const heuristic = detectHeuristic(lastParsed.headers);
    if (heuristic) {
      lastMapping = heuristic;
      renderMappingConfirm(heuristic, 'heuristic');
      return;
    }

    if (!App.hasApiKeys()) {
      lastMapping = blankMapping('AI isn\'t set up — pick the source/target columns manually below, or add your AI key (EMIS_API_KEY) to the server\'s .env file (see Settings) for AI-assisted detection.');
      renderMappingConfirm(lastMapping, 'manual');
      return;
    }

    try {
      const mapping = await analyzeWithAI(lastParsed.headers, lastParsed.sample);
      lastMapping = mapping;
      renderMappingConfirm(mapping, 'ai');
    } catch (e) {
      App.notify('AI detection failed: ' + e.message, 'error');
      lastMapping = blankMapping('AI detection failed — pick the columns manually below.');
      renderMappingConfirm(lastMapping, 'manual');
    }
  }

  function blankMapping(note) {
    return { fileType: 'unclear', source: null, target: null, weight: null,
             id: null, label: null, group: null, directed: false, note };
  }

  function detectHeuristic(headers) {
    const norm  = headers.map(h => h.toLowerCase().trim());
    const pairs = [
      ['source','target'], ['from','to'], ['follower','followee'],
      ['src','dst'], ['user','target_user'], ['node1','node2'],
      ['sender','receiver'], ['user_id','target_id']
    ];
    for (const pair of pairs) {
      const a = pair[0], b = pair[1];
      const ai = norm.indexOf(a), bi = norm.indexOf(b);
      if (ai !== -1 && bi !== -1) {
        const wi = norm.findIndex(h => ['weight','count','strength','n'].includes(h));
        const li = norm.findIndex(h => ['label','name'].includes(h));
        return {
          fileType: 'edges',
          source: headers[ai], target: headers[bi],
          weight: wi !== -1 ? headers[wi] : null,
          id: null, label: li !== -1 ? headers[li] : null, group: null,
          directed: false, confidence: 'high',
          note: 'Detected "' + headers[ai] + '" / "' + headers[bi] + '" as a standard edge pair.'
        };
      }
    }
    return null;
  }

  async function analyzeWithAI(headers, sample) {
    const system =
      'You are a data analyst identifying graph/network structure in a CSV for social network analysis.\n' +
      'Given a CSV header row and sample rows, determine which columns represent an edge\'s source and ' +
      'target (e.g. follower/followee, sender/receiver, user/mentioned_user, replies_to), an optional ' +
      'weight/count column, or whether this is instead a node attribute table (id/label/group columns) ' +
      'rather than a list of relationships.\n' +
      'Respond with ONLY a JSON object, no other text:\n' +
      '{"fileType":"edges"|"nodes"|"unclear","source":"<column or null>","target":"<column or null>",' +
      '"weight":"<column or null>","id":"<column or null>","label":"<column or null>","group":"<column or null>",' +
      '"directed":true|false,"confidence":"high"|"medium"|"low","note":"<one short sentence>"}\n' +
      'Use exact column names from the header. Infer directed=true if the relationship implies direction ' +
      '(e.g. follows, replies_to, mentions), false if symmetric or unclear. Output must start with { and end with }.';

    const user = 'Header: ' + JSON.stringify(headers) + '\nSample rows:\n' +
      sample.map((r, i) => (i + 1) + '. ' + JSON.stringify(r)).join('\n');

    const raw = await App.callClaude([{ role: 'user', content: user }], system, 500, { feature: 'csv' });
    return App.extractJSON(raw);
  }

  /* ── Mapping confirmation UI ─────────────────*/
  function renderMappingConfirm(mapping, detectedBy) {
    const resultsEl = document.getElementById('csvan-results');
    const headers   = lastParsed.headers;

    const opt = (val) => headers.map(h =>
      '<option value="' + App.esc(h) + '"' + (h === val ? ' selected' : '') + '>' + App.esc(h) + '</option>'
    ).join('');
    const optWithNone = (val) => '<option value="">(none)</option>' + opt(val);

    const badge = detectedBy === 'ai'
      ? '<span class="badge badge-violet">AI-detected</span>'
      : detectedBy === 'heuristic'
        ? '<span class="badge badge-teal">Auto-detected</span>'
        : '<span class="badge badge-gray">Manual</span>';

    const typeNote = mapping.fileType === 'nodes'
      ? '<div style="font-size:12.5px;color:var(--warning);margin-bottom:10px">This looks like a node attribute table, not an edge list — network analysis needs source/target pairs. Override the columns below if this file does represent relationships.</div>'
      : '';

    resultsEl.innerHTML =
      '<div class="card" style="margin-bottom:20px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
          '<div class="card-title" style="margin-bottom:0">Detected Structure</div>' + badge +
        '</div>' +
        '<div style="font-size:13px;color:var(--tx-second);margin-bottom:14px">' +
          App.esc(mapping.note || 'Review and adjust the column mapping below, then run the analysis.') +
        '</div>' +
        typeNote +
        '<div class="card-grid card-grid-2" style="margin-bottom:14px">' +
          '<div class="form-group">' +
            '<label class="form-label">Source column</label>' +
            '<select class="form-select" id="map-source">' + optWithNone(mapping.source) + '</select>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Target column</label>' +
            '<select class="form-select" id="map-target">' + optWithNone(mapping.target) + '</select>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Weight column <span>(optional)</span></label>' +
            '<select class="form-select" id="map-weight">' + optWithNone(mapping.weight) + '</select>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Node label column <span>(optional)</span></label>' +
            '<select class="form-select" id="map-label">' + optWithNone(mapping.label) + '</select>' +
          '</div>' +
        '</div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin-bottom:16px;cursor:pointer">' +
          '<input type="checkbox" id="map-directed"' + (mapping.directed ? ' checked' : '') + '> ' +
          'Directed graph (relationship has a direction, e.g. &ldquo;follows&rdquo;)' +
        '</label>' +
        '<button class="btn btn-violet" onclick="CSVAnalyzer.runAnalysis()">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="5" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
          ' Run NetworkX Analysis' +
        '</button>' +
      '</div>';
  }

  /* ── Run Python analysis ─────────────────────*/
  async function runAnalysis() {
    if (!lastParsed) return;

    const sourceEl = document.getElementById('map-source');
    const targetEl = document.getElementById('map-target');
    const weightEl = document.getElementById('map-weight');
    const labelEl  = document.getElementById('map-label');
    const dirEl    = document.getElementById('map-directed');

    const sourceCol = sourceEl ? sourceEl.value : (lastMapping && lastMapping.source);
    const targetCol = targetEl ? targetEl.value : (lastMapping && lastMapping.target);
    const weightCol = weightEl ? weightEl.value : ((lastMapping && lastMapping.weight) || '');
    const labelCol  = labelEl  ? labelEl.value  : ((lastMapping && lastMapping.label)  || '');
    const directed  = dirEl ? dirEl.checked : !!(lastMapping && lastMapping.directed);

    if (!sourceCol || !targetCol) {
      App.notify('Select both a source and target column before running analysis', 'error');
      return;
    }

    const edges = [];
    const labels = {};
    lastParsed.rows.forEach(row => {
      const s = row[sourceCol], t = row[targetCol];
      if (s == null || t == null || String(s).trim() === '' || String(t).trim() === '') return;
      const sVal = String(s).trim(), tVal = String(t).trim();
      let w = weightCol ? parseFloat(row[weightCol]) : 1;
      if (isNaN(w)) w = 1;
      edges.push({ source: sVal, target: tVal, weight: w });
      if (labelCol && row[labelCol]) labels[sVal] = String(row[labelCol]).trim();
    });

    if (!edges.length) {
      App.notify('No valid edges found using the selected columns', 'error');
      return;
    }

    lastEdgesBuilt = edges;
    lastLabelsMap  = labels;

    const resultsEl = document.getElementById('csvan-results');
    resultsEl.innerHTML = '<div class="loading-state">Running NetworkX analysis on ' + edges.length + ' edges…</div>';

    try {
      const res = await fetch('/api/network/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edges, labels, directed: !!directed })
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error((data.error && data.error.message) || 'Analysis failed');
      }
      lastAnalysis = data;
      renderResults(data);
      // Persist to app state so the Export Data page can offer this
      // analysis for download even after navigating away from this view.
      App.setState({ networkAnalysis: data });
    } catch (e) {
      resultsEl.innerHTML = '<div class="empty-state"><div class="empty-sub" style="color:var(--error)">Analysis failed: ' + App.esc(e.message) + '</div></div>';
      App.notify('NetworkX analysis failed: ' + e.message, 'error');
    }
  }

  /* ── Results rendering ───────────────────────*/
  function renderResults(data) {
    const resultsEl = document.getElementById('csvan-results');
    const c = data.centrality || {};

    const stats = [
      ['Nodes', data.nodeCount],
      ['Edges', data.edgeCount],
      ['Density', data.density],
      ['Avg Degree', data.avgDegree],
      ['Components', data.componentCount],
      ['Avg Clustering', data.avgClustering != null ? data.avgClustering : '\u2014'],
      ['Diameter', data.diameter != null ? data.diameter : '\u2014'],
      ['Communities', data.communityCount != null ? data.communityCount : '\u2014']
    ];

    const statCards = stats.map(pair =>
      '<div class="stat-card">' +
        '<div class="stat-num" style="font-size:24px">' + pair[1] + '</div>' +
        '<div class="stat-label">' + pair[0] + '</div>' +
      '</div>'
    ).join('');

    const centralityTabs = ['degree','betweenness','closeness','eigenvector'].filter(k => (c[k] || []).length);
    const tabsHTML = centralityTabs.map((k, i) =>
      '<button class="tab-btn' + (i === 0 ? ' active' : '') + '" data-ckey="' + k + '" onclick="CSVAnalyzer.switchCentralityTab(\'' + k + '\')" ' +
        'style="padding:7px 16px;border:none;background:none;font-size:13px;font-weight:500;cursor:pointer;' +
        'border-bottom:2px solid ' + (i === 0 ? 'var(--blue)' : 'transparent') + ';' +
        'color:' + (i === 0 ? 'var(--blue)' : 'var(--tx-second)') + ';margin-bottom:-1px">' +
        k.charAt(0).toUpperCase() + k.slice(1) +
      '</button>'
    ).join('');

    const noteHTML = data.note
      ? '<div class="card" style="margin-bottom:16px;padding:12px 16px"><span class="text-muted" style="font-size:12.5px">&#8505;&#65039; ' + App.esc(data.note) + '</span></div>'
      : '';

    const communityHTML = data.communityCount
      ? '<div class="card"><div class="card-title">Detected Communities</div><div style="display:flex;flex-wrap:wrap;gap:8px">' +
          (data.communitySizes || []).map((size, i) =>
            '<span class="badge badge-gray">Community ' + (i + 1) + ': ' + size + ' nodes</span>'
          ).join('') +
        '</div></div>'
      : '';

    resultsEl.innerHTML =
      '<div class="card-grid card-grid-4" style="margin-bottom:20px">' + statCards + '</div>' +
      noteHTML +
      '<div class="card" style="margin-bottom:20px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">' +
          '<div class="card-title" style="margin-bottom:0">Most Central Nodes</div>' +
          '<button class="btn btn-primary btn-sm" onclick="CSVAnalyzer.sendToNetworkGraph()">Send to Network Graph &#8594;</button>' +
        '</div>' +
        '<div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid var(--border)">' + tabsHTML + '</div>' +
        '<div id="centrality-table-wrap">' + centralityTableHTML(c[centralityTabs[0]] || []) + '</div>' +
      '</div>' +
      communityHTML;

    window._csvAnalysisCentrality = c;
  }

  function centralityTableHTML(list) {
    if (!list.length) return '<div class="text-muted" style="font-size:13px">No data for this measure.</div>';
    const rows = list.map((n, i) =>
      '<tr><td class="text-muted">' + (i + 1) + '</td><td style="font-weight:500">' +
      App.esc(n.label || n.id) + '</td><td class="font-mono">' + n.value + '</td></tr>'
    ).join('');
    return '<div class="table-wrap"><table class="table"><thead><tr><th>Rank</th><th>Node</th><th>Score</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function switchCentralityTab(key) {
    document.querySelectorAll('[data-ckey]').forEach(btn => {
      const active = btn.dataset.ckey === key;
      btn.style.borderBottomColor = active ? 'var(--blue)' : 'transparent';
      btn.style.color = active ? 'var(--blue)' : 'var(--tx-second)';
    });
    const wrap = document.getElementById('centrality-table-wrap');
    const c = window._csvAnalysisCentrality || {};
    if (wrap) wrap.innerHTML = centralityTableHTML(c[key] || []);
  }

  /* ── Handoff to Network Graph view ───────────*/
  function sendToNetworkGraph() {
    if (!lastAnalysis || !lastEdgesBuilt) { App.notify('Run the analysis first', 'warning'); return; }

    const commMap   = lastAnalysis.nodeCommunities || {};
    const degreeMap = {};
    (lastAnalysis.centrality && lastAnalysis.centrality.degree || []).forEach(d => { degreeMap[d.id] = d.value; });

    const nodeIds = new Set();
    lastEdgesBuilt.forEach(e => { nodeIds.add(e.source); nodeIds.add(e.target); });

    const nodes = Array.from(nodeIds).map(id => ({
      id: id,
      label: (lastLabelsMap && lastLabelsMap[id]) || id,
      group: commMap[id] != null ? String(commMap[id]) : '0',
      size: 8 + Math.round((degreeMap[id] || 0) * 20)
    }));

    const edges = lastEdgesBuilt.map(e => ({ source: e.source, target: e.target, weight: e.weight || 1, type: '' }));

    App.setState({ network: { nodes: nodes, edges: edges } });
    App.notify('Loaded ' + nodes.length + ' nodes and ' + edges.length + ' edges into Network Graph', 'success');
    App.navigate('network');
  }

  return { render, handleFile, loadSample, runAnalysis, switchCentralityTab, sendToNetworkGraph };
})();
