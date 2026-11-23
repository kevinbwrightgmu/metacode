/* ══════════════════════════════════════════════
   local-ai.js — AI on this device: the AI Model Store, Installed Models, AI Chat and System pages
   (loaded when one of them opens; the server side is local-ai/, under /api/local-ai)

   - AI Model Store: Ollama's library, what this device can really run (by tier), search and filters;
     installs with progress, speed and time left; pause, resume, cancel.
   - Installed Models: load into memory, stop, update, delete; each model's settings; the model for each AI task.
   - AI Chat: a conversation with a model on this device, streamed; nothing leaves the machine.
   - System: this browser and the MetaCode server, the AI runtimes that work here, and where each works.
   Browsing works for everyone. Installing and removing models works on the computer MetaCode runs on, or with
   the server's admin token (kept in this browser).
   ══════════════════════════════════════════════ */
const LocalAI = (() => {
  'use strict';
  const API = '/api/local-ai';
  const TOKEN_KEY = 'metacode_local_ai_token';
  const esc = s => App.esc(String(s == null ? '' : s));
  const st = { view: null, status: null, hw: null, catalog: null, recs: null, installed: null, jobs: new Map(), events: null,
    tab: 'recommended', query: '', category: '', capability: '', sort: 'pulls', shown: 30, chat: { messages: [], model: '', busy: null } };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } };
  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token()) headers['X-MetaCode-Admin-Token'] = token();
    let res;
    try { res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new Error(navigator.onLine === false ? 'This device is offline, and the MetaCode server can\'t be reached.' : 'The MetaCode server can\'t be reached.'); }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) throw Object.assign(new Error((json && json.error && json.error.message) || ('HTTP ' + res.status)), { status: res.status, code: json && json.error && json.error.code });
    return json;
  }
  const GB = 1e9;
  const size = n => (n == null ? '?' : n >= GB ? (n / GB).toFixed(n >= 10 * GB ? 0 : 1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB');
  const speed = n => (n ? (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB/s' : Math.round(n / 1e3) + ' KB/s') : '');
  const eta = s => (s == null ? '' : s < 60 ? s + ' s left' : s < 3600 ? Math.round(s / 60) + ' min left' : (s / 3600).toFixed(1) + ' h left');
  const count = n => (n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
  const when = iso => { const t = Date.parse(iso); return t ? new Date(t).toLocaleDateString() : ''; };
  const canManage = () => !!(st.status && st.status.manage && st.status.manage.allowed);
  const ollamaUp = () => !!(st.status && st.status.ollama && st.status.ollama.running);
  const installedNames = () => new Set(((st.installed && st.installed.models) || []).map(m => m.name));
  const tagged = n => (String(n).includes(':') ? String(n) : n + ':latest');
  function loadCss() {
    if (document.getElementById('local-ai-css')) return;
    const l = document.createElement('link');
    l.id = 'local-ai-css'; l.rel = 'stylesheet'; l.href = 'css/local-ai.css';
    document.head.appendChild(l);
  }
  const CATEGORIES = [['general', 'General'], ['coding', 'Coding'], ['reasoning', 'Reasoning'], ['vision', 'Vision'], ['embedding', 'Embeddings'], ['small', 'Small'], ['multilingual', 'Multilingual']];
  const CAPS = { vision: 'vision', tools: 'tools', thinking: 'reasoning', embedding: 'embeddings', audio: 'audio' };

  // ── Live install progress (server-sent events, while a Local AI page is open) ──
  function openEvents() {
    if (st.events || typeof EventSource === 'undefined') return;
    const es = new EventSource(API + '/installs/events');
    st.events = es;
    es.addEventListener('snapshot', e => { const d = JSON.parse(e.data); st.jobs = new Map(d.installs.map(j => [j.model, j])); paintJobs(); });
    es.addEventListener('job', e => {
      const j = JSON.parse(e.data);
      const before = st.jobs.get(j.model);
      if (j.state === 'cancelled') st.jobs.delete(j.model); else st.jobs.set(j.model, j);
      paintJobs();
      if (j.state === 'done' && (!before || before.state !== 'done')) {
        App.notify(j.verified === false ? j.model + ' installed, but its digest doesn\'t match Ollama\'s library.' : j.model + ' is installed' + (j.verified ? ' and verified.' : '.'), j.verified === false ? 'warning' : 'success', 5000);
        refreshInstalled();
      }
      if (j.state === 'failed' && (!before || before.state !== 'failed')) App.notify(j.error || ('Couldn\'t install ' + j.model + '.'), 'error', 9000);
    });
    es.onerror = () => { /* the browser reconnects by itself */ };
  }
  function closeEvents() { if (st.events) { st.events.close(); st.events = null; } }
  async function refreshInstalled() {
    try { st.installed = await api('GET', '/models'); } catch (e) { st.installed = null; }
    if (st.view === 'store') paintBody();
    if (st.view === 'installed') paintInstalled();
  }

  // ── Entry ──────────────────────────────────────────────────────────────────
  function render(view, container) {
    loadCss();
    st.view = view;
    App.setViewCleanup(() => { closeEvents(); st.view = null; });
    container.innerHTML = '<div class="lai"><div class="loading-state">Loading…</div></div>';
    const done = () => {};
    if (view === 'store') return renderStore(container).then(done);
    if (view === 'installed') return renderInstalled(container).then(done);
    if (view === 'chat') return renderChat(container).then(done);
    if (view === 'system') return renderSystem(container).then(done);
  }
  async function loadStatus() {
    const [status, hw] = await Promise.all([api('GET', '/status'), api('GET', '/hardware').catch(() => null)]);
    st.status = status; st.hw = hw;
    st.jobs = new Map((status.installs || []).map(j => [j.model, j]));
  }
  function failed(container, err) {
    container.innerHTML = '<div class="lai"><div class="card lai-problem"><h3>The AI Model Store can\'t be shown</h3><p>' + esc(err.message) + '</p>' +
      '<p class="form-hint">The store and the models live on the MetaCode server. Your projects are still here and work offline.</p></div></div>';
  }

  // ── Header: this device, Ollama, who may manage ─────────────────────────────
  function deviceLine() {
    const h = st.hw;
    if (!h) return '';
    const gpu = (h.gpus || []).filter(g => g.usable)[0];
    return '<span class="lai-chip" title="Memory on the MetaCode server">' + size(h.memory.total) + ' RAM (' + size(h.memory.available) + ' free)</span>' +
      '<span class="lai-chip">' + esc(h.cpu.threads + ' CPU threads, ' + h.arch) + '</span>' +
      '<span class="lai-chip">' + (gpu ? esc(gpu.name) + (gpu.memory && !gpu.shared ? ' · ' + size(gpu.memory) : '') : 'No GPU: models run on the CPU') + '</span>' +
      (h.disk && h.disk.free != null ? '<span class="lai-chip" title="' + esc(h.disk.path || '') + '">' + size(h.disk.free) + ' disk free</span>' : '');
  }
  function ollamaLine() {
    const o = st.status && st.status.ollama;
    if (o && o.running) return '<span class="badge badge-green">Ollama ' + esc(o.version || '') + ' running</span>';
    return '<span class="badge badge-amber">Ollama isn\'t running</span> <span class="form-hint">Install it from <strong>ollama.com</strong> on the computer MetaCode runs on (a separate download), then reload this page. You can browse meanwhile.</span>';
  }
  function manageLine() {
    const m = st.status && st.status.manage;
    if (!m || m.allowed) return '';
    return '<div class="lai-locked card"><strong>Browsing only on this device.</strong> ' + esc(m.reason) +
      (m.tokenSet ? '<div class="lai-token"><input type="password" class="form-input" id="lai-token" placeholder="Admin token" autocomplete="off">' +
        '<button class="btn btn-secondary btn-sm" data-act="token">Use token</button></div>' : '') + '</div>';
  }
  function jobsHTML() {
    const jobs = [...st.jobs.values()].filter(j => !['done', 'cancelled'].includes(j.state));
    if (!jobs.length) return '';
    return '<div class="card lai-downloads"><h3>Downloads</h3>' + jobs.map(jobRow).join('') + '</div>';
  }
  function jobRow(j) {
    const pct = j.percent == null ? 0 : j.percent;
    const busy = ['queued', 'checking', 'downloading', 'verifying'].includes(j.state);
    const facts = [j.total ? size(j.completed) + ' of ' + size(j.total) : '', speed(j.speed), eta(j.eta), j.resumed ? 'continued where it stopped' : ''].filter(Boolean).join(' · ');
    return '<div class="lai-job" data-model="' + esc(j.model) + '">' +
      '<div class="lai-job-top"><strong>' + esc(j.model) + '</strong><span class="lai-job-state">' + esc(j.state === 'failed' ? 'Failed' : j.status || j.state) + '</span></div>' +
      '<div class="lai-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
      '<div class="lai-job-foot"><span class="form-hint">' + esc(j.state === 'failed' ? j.error : facts) + '</span><span>' +
      (canManage() ? (busy ? '<button class="btn btn-ghost btn-sm" data-act="pause" data-model="' + esc(j.model) + '">Pause</button>' : '') +
        (j.state === 'paused' || j.state === 'failed' ? '<button class="btn btn-secondary btn-sm" data-act="resume" data-model="' + esc(j.model) + '">Resume</button>' : '') +
        '<button class="btn btn-ghost btn-sm" data-act="cancel" data-model="' + esc(j.model) + '">Cancel</button>' : '') + '</span></div></div>';
  }
  function paintJobs() {
    const box = document.getElementById('lai-jobs');
    if (box) box.innerHTML = jobsHTML();
    // the cards' buttons follow
    document.querySelectorAll('[data-install-for]').forEach(el => { el.outerHTML = installButton(el.getAttribute('data-install-for')); });
  }
  function installButton(tag) {
    const t = tagged(tag);
    const j = st.jobs.get(t);
    const attr = ' data-install-for="' + esc(t) + '"';
    if (installedNames().has(t) && !(j && !['done', 'failed', 'cancelled'].includes(j.state))) return '<span class="badge badge-green"' + attr + '>Installed</span>';
    if (j && ['queued', 'checking', 'downloading', 'verifying'].includes(j.state)) return '<span class="lai-mini"' + attr + '><span class="lai-bar"><span style="width:' + (j.percent || 0) + '%"></span></span>' + (j.percent != null ? j.percent + '%' : '…') + '</span>';
    if (j && j.state === 'paused') return '<span class="badge badge-amber"' + attr + '>Paused</span>';
    if (!canManage() || !ollamaUp()) return '<span' + attr + '></span>';
    return '<button class="btn btn-primary btn-sm"' + attr + ' data-act="install" data-model="' + esc(t) + '">Install</button>';
  }

  // ── AI Model Store ─────────────────────────────────────────────────────────
  async function renderStore(container) {
    try {
      await loadStatus();
      const [catalog, recs] = await Promise.all([api('GET', '/catalog'), api('GET', '/recommendations')]);
      st.catalog = catalog; st.recs = recs;
      if (ollamaUp()) await refreshInstalled();
    } catch (e) { return failed(container, e); }
    if (st.view !== 'store') return;
    const src = st.catalog.source === 'live' ? 'from ollama.com just now' : st.catalog.source === 'cache' ? 'saved on ' + when(st.catalog.fetchedAt) : 'the copy that came with MetaCode (' + when(st.catalog.fetchedAt) + ')';
    container.innerHTML = '<div class="lai">' +
      '<div class="card lai-head"><div class="lai-head-row"><div><h2 class="lai-title">AI Model Store</h2>' +
        '<p class="form-hint">Models from Ollama\'s library that run on your own hardware: your prompts and data stay here. Big models need lots of memory; the recommendations below fit this computer.</p></div>' +
        '<div class="lai-head-side">' + ollamaLine() + '</div></div>' +
        '<div class="lai-chips">' + deviceLine() + '</div>' +
        '<div class="form-hint lai-source">Catalog: ' + esc(src) + ' · ' + st.catalog.models.length + ' models' +
          (st.catalog.problem ? ' · <span class="lai-warn">' + esc(st.catalog.problem) + '</span>' : '') +
          ' <button class="btn btn-ghost btn-sm" data-act="refresh">Refresh</button></div></div>' +
      manageLine() + '<div id="lai-jobs">' + jobsHTML() + '</div>' +
      '<div class="lai-tabs" role="tablist"><button role="tab" class="lai-tab" data-tab="recommended">Recommended for this computer</button><button role="tab" class="lai-tab" data-tab="all">All models</button></div>' +
      '<div id="lai-body"></div></div>';
    wire(container);
    paintBody();
    openEvents();
  }
  function paintBody() {
    const body = document.getElementById('lai-body');
    if (!body) return;
    document.querySelectorAll('.lai-tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === st.tab ? 'true' : 'false'));
    body.innerHTML = st.tab === 'recommended' ? recommendedHTML() : allHTML();
  }
  function badges(m) {
    return (m.capabilities || []).filter(c => CAPS[c]).map(c => '<span class="badge badge-violet">' + esc(CAPS[c]) + '</span>').join(' ') +
      (m.categories || []).filter(c => c === 'coding' || c === 'multilingual').map(c => ' <span class="badge badge-teal">' + esc(c) + '</span>').join('');
  }
  function recommendedHTML() {
    const r = st.recs;
    if (!r) return '';
    const dev = '<p class="form-hint">For ' + size(r.device.totalMemory) + ' of memory (' + size(r.device.budget) + ' for models, after the system and MetaCode)' +
      (r.device.gpu ? ' and ' + esc(r.device.gpu.name) : '') + '. ' + (r.tooBig ? r.tooBig + ' models in the catalog are too big for this computer and aren\'t shown.' : '') + '</p>';
    const tiers = r.tiers.filter(t => t.models.length);
    if (!tiers.length) return dev + '<div class="card"><p>No model in the catalog fits in this computer\'s memory. AI features can still use a MetaCode server with more memory, or a cloud provider.</p></div>';
    return dev + tiers.map(t => '<section class="lai-tier"><h3>' + esc(t.name) + ' <span class="form-hint">' + esc(t.note) + (t.total > t.models.length ? ' Showing ' + t.models.length + ' of ' + t.total + '.' : '') + '</span></h3>' +
      '<div class="lai-grid">' + t.models.map(m => '<article class="lai-card">' +
        '<div class="lai-card-top"><h4>' + esc(m.name) + '</h4>' + installButton(m.tag) + '</div>' +
        '<p class="lai-desc">' + esc(m.description) + '</p>' +
        '<div class="lai-facts"><span>' + esc(m.tag) + '</span><span>' + size(m.size) + ' download' + (m.estimated ? ' (estimated)' : '') + '</span><span>needs ≈ ' + size(m.need) + ' memory</span>' +
          (m.context ? '<span>' + Math.round(m.context / 1024) + 'K context</span>' : '') + '<span>' + (m.runsOn === 'gpu' ? 'runs on the GPU' : 'runs on the CPU') + '</span></div>' +
        '<div class="lai-badges">' + badges(m) + ' <button class="btn btn-ghost btn-sm" data-act="details" data-name="' + esc(m.name) + '">Details</button></div></article>').join('') + '</div></section>').join('');
  }
  function filtered() {
    const q = st.query.trim().toLowerCase();
    let list = (st.catalog ? st.catalog.models : []).filter(m => (!q || m.name.includes(q) || (m.description || '').toLowerCase().includes(q)) &&
      (!st.category || (m.categories || []).includes(st.category)) && (!st.capability || (m.capabilities || []).includes(st.capability)));
    if (st.sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    else if (st.sort === 'updated') list = list.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    else list = list.slice().sort((a, b) => (b.pulls || 0) - (a.pulls || 0));
    return list;
  }
  function allHTML() {
    const list = filtered();
    const chips = (items, key) => items.map(([v, label]) => '<button class="lai-filter' + (st[key] === v ? ' on' : '') + '" data-filter="' + key + '" data-value="' + esc(v) + '">' + esc(label) + '</button>').join('');
    return '<div class="lai-search"><input type="search" class="form-input" id="lai-q" placeholder="Search models by name or description" value="' + esc(st.query) + '" aria-label="Search models">' +
      '<select class="form-select" id="lai-sort" aria-label="Sort"><option value="pulls"' + (st.sort === 'pulls' ? ' selected' : '') + '>Most used</option><option value="updated"' + (st.sort === 'updated' ? ' selected' : '') + '>Recently updated</option><option value="name"' + (st.sort === 'name' ? ' selected' : '') + '>Name</option></select></div>' +
      '<div class="lai-filters">' + chips([['', 'All']].concat(CATEGORIES), 'category') + '</div>' +
      '<div class="lai-filters">' + chips([['', 'Any capability'], ['vision', 'Vision'], ['tools', 'Tools'], ['thinking', 'Reasoning'], ['embedding', 'Embeddings']], 'capability') + '</div>' +
      '<p class="form-hint">' + list.length + ' model' + (list.length === 1 ? '' : 's') + '</p>' +
      '<div class="lai-grid">' + list.slice(0, st.shown).map(m => '<article class="lai-card">' +
        '<div class="lai-card-top"><h4>' + esc(m.name) + '</h4><button class="btn btn-secondary btn-sm" data-act="details" data-name="' + esc(m.name) + '">Sizes &amp; install</button></div>' +
        '<p class="lai-desc">' + esc(m.description) + '</p>' +
        '<div class="lai-facts">' + (m.sizes || []).map(s => '<span>' + esc(s) + '</span>').join('') + (m.pulls ? '<span>' + count(m.pulls) + ' pulls</span>' : '') + (m.updated ? '<span>updated ' + when(m.updated) + '</span>' : '') + '</div>' +
        '<div class="lai-badges">' + badges(m) + '</div></article>').join('') + '</div>' +
      (list.length > st.shown ? '<div class="lai-more"><button class="btn btn-secondary" data-act="more">Show more</button></div>' : '');
  }
  async function showDetails(name) {
    App.openModal(name, '<div class="loading-state">Loading its sizes…</div>');
    let m;
    try { m = await api('GET', '/catalog/model?name=' + encodeURIComponent(name)); } catch (e) { document.getElementById('modal-body').innerHTML = '<p>' + esc(e.message) + '</p>'; return; }
    const fitLabel = f => (f.level === 'good' ? '<span class="badge badge-green">fits</span>' : f.level === 'tight' ? '<span class="badge badge-amber">fits, tight</span>' : '<span class="badge badge-red">too big here</span>');
    const rows = m.tags.slice().sort((a, b) => (b.main - a.main) || (a.size - b.size)).map(t =>
      '<tr><td><code>' + esc(t.tag) + '</code></td><td>' + size(t.size) + '</td><td>≈ ' + size(t.fit.need) + '</td><td>' + (t.context ? Math.round(t.context / 1024) + 'K' : '') + '</td><td>' + esc((t.inputs || []).join(', ')) + '</td><td>' + fitLabel(t.fit) + '</td>' +
      '<td>' + (t.fit.level === 'too-big' ? '' : installButton(t.tag)) + '</td></tr>').join('');
    document.getElementById('modal-body').innerHTML = '<p>' + esc(m.description) + '</p>' +
      (m.tagsOffline ? '<p class="form-hint lai-warn">Offline: the sizes known from before are shown.</p>' : '') +
      '<div class="lai-table-wrap"><table class="lai-table"><thead><tr><th>Tag</th><th>Download</th><th>Memory</th><th>Context</th><th>Input</th><th>Here</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="form-hint">Memory is an estimate for Ollama\'s default context; Ollama checks the download\'s sha256, and MetaCode checks the installed model against Ollama\'s library.</p>';
    wire(document.getElementById('modal-body'));
  }

  // ── Installed Models ───────────────────────────────────────────────────────
  async function renderInstalled(container) {
    try { await loadStatus(); if (ollamaUp()) await refreshInstalled(); } catch (e) { return failed(container, e); }
    if (st.view !== 'installed') return;
    container.innerHTML = '<div class="lai"><div class="card lai-head"><div class="lai-head-row"><div><h2 class="lai-title">Installed Models</h2>' +
      '<p class="form-hint">The models on this computer. Pick which one each AI feature uses, keep one in memory for quick answers, or remove those you don\'t need.</p></div>' +
      '<div class="lai-head-side">' + ollamaLine() + '</div></div><div class="lai-chips">' + deviceLine() + '</div></div>' + manageLine() +
      '<div id="lai-jobs">' + jobsHTML() + '</div><div id="lai-installed"></div></div>';
    wire(container);
    paintInstalled();
    openEvents();
  }
  function paintInstalled() {
    const box = document.getElementById('lai-installed');
    if (!box) return;
    if (!ollamaUp()) { box.innerHTML = '<div class="card"><p>Ollama isn\'t running on the MetaCode server, so no installed model can be shown.</p></div>'; return; }
    const ms = (st.installed && st.installed.models) || [];
    if (!ms.length) { box.innerHTML = '<div class="card"><p>No model is installed yet.</p><a class="btn btn-primary" href="#model-store">Open the AI Model Store</a></div>'; return; }
    const s = App.getState().settings || {};
    const def = s.model || '';
    const id = m => 'ollama/' + m.name;
    box.innerHTML = '<div class="card"><h3>' + ms.length + ' model' + (ms.length === 1 ? '' : 's') + ', ' + size(st.installed.totalSize) + ' on disk</h3>' +
      '<div class="lai-table-wrap"><table class="lai-table"><thead><tr><th>Model</th><th>Size</th><th>Details</th><th>In memory</th><th></th></tr></thead><tbody>' +
      ms.map(m => '<tr><td><strong>' + esc(m.name) + '</strong>' + (def === id(m) ? ' <span class="badge badge-blue">default</span>' : '') + '</td><td>' + size(m.size) + '</td>' +
        '<td class="form-hint">' + esc([m.parameterSize, m.quantization, m.contextLength ? Math.round(m.contextLength / 1024) + 'K context' : '', (m.capabilities || []).filter(c => c !== 'completion').join(', ')].filter(Boolean).join(' · ')) + '</td>' +
        '<td>' + (m.loaded ? '<span class="badge badge-green">loaded</span> <span class="form-hint">' + size(m.loaded.size) + (m.loaded.sizeVram ? ' (GPU)' : '') + '</span>' : '<span class="form-hint">no</span>') + '</td>' +
        '<td class="lai-actions"><button class="btn btn-secondary btn-sm" data-act="default" data-model="' + esc(m.name) + '"' + (def === id(m) ? ' disabled' : '') + '>Use as default</button>' +
        (canManage() ? (m.loaded ? '<button class="btn btn-ghost btn-sm" data-act="unload" data-model="' + esc(m.name) + '">Stop</button>' : '<button class="btn btn-ghost btn-sm" data-act="load" data-model="' + esc(m.name) + '">Load</button>') +
          '<button class="btn btn-ghost btn-sm" data-act="settings" data-model="' + esc(m.name) + '">Settings</button><button class="btn btn-ghost btn-sm" data-act="update" data-model="' + esc(m.name) + '">Update</button>' +
          '<button class="btn btn-ghost btn-sm lai-danger" data-act="delete" data-model="' + esc(m.name) + '">Delete</button>' : '') + '</td></tr>').join('') + '</tbody></table></div></div>' +
      '<div class="card"><h3>Which model each AI feature uses</h3><p class="form-hint">A feature without its own model uses the default. These are this browser\'s settings, like Settings → AI models.</p>' +
      '<div class="lai-features">' + App.AI_FEATURES.map(([fid, name, what]) => '<label class="form-group"><span class="form-label">' + esc(name) + ' <span class="form-hint">' + esc(what) + '</span></span>' +
        '<select class="form-select" data-feature="' + esc(fid) + '"><option value="">The default model</option>' + ms.map(m => '<option value="' + esc(id(m)) + '"' + ((s.models || {})[fid] === id(m) ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') +
        ((s.models || {})[fid] && !ms.some(m => id(m) === (s.models || {})[fid]) ? '<option value="' + esc(s.models[fid]) + '" selected>' + esc(App.modelName(s.models[fid])) + '</option>' : '') + '</select></label>').join('') + '</div></div>';
    box.querySelectorAll('select[data-feature]').forEach(sel => sel.addEventListener('change', () => {
      const models = Object.assign({}, (App.getState().settings || {}).models || {});
      if (sel.value) models[sel.dataset.feature] = sel.value; else delete models[sel.dataset.feature];
      App.setState({ settings: Object.assign({}, App.getState().settings, { models }) });
      App.notify('Saved: ' + (sel.value ? App.modelName(sel.value) : 'the default model') + ' for ' + sel.closest('label').querySelector('.form-label').firstChild.textContent.trim() + '.', 'success');
    }));
    wire(box);
  }
  function modelSettings(name) {
    const m = ((st.installed && st.installed.models) || []).find(x => x.name === name) || {};
    const s = m.settings || {};
    App.openModal('Settings for ' + name,
      '<p class="form-hint">Used for this model\'s requests. A feature that sets its own temperature (AI Coding uses 0.1) keeps it; the answer length is a cap.</p>' +
      '<label class="form-group"><span class="form-label">Temperature (0–2, empty: the request\'s)</span><input class="form-input" id="lai-s-temp" type="number" min="0" max="2" step="0.05" value="' + esc(s.temperature == null ? '' : s.temperature) + '"></label>' +
      '<label class="form-group"><span class="form-label">Longest answer, in tokens (16–32768, empty: no cap)</span><input class="form-input" id="lai-s-max" type="number" min="16" max="32768" step="1" value="' + esc(s.maxTokens == null ? '' : s.maxTokens) + '"></label>' +
      '<label class="form-group"><span class="form-label">Keep in memory after Load, in minutes (0 = until stopped)</span><input class="form-input" id="lai-s-keep" type="number" min="0" max="1440" step="1" value="' + esc(s.keepAliveMinutes == null ? '' : s.keepAliveMinutes) + '"></label>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="lai-s-save">Save</button>');
    document.getElementById('lai-s-save').addEventListener('click', async () => {
      const v = id => document.getElementById(id).value.trim();
      try {
        await api('PUT', '/models/settings', { model: name, settings: { temperature: v('lai-s-temp'), maxTokens: v('lai-s-max'), keepAliveMinutes: v('lai-s-keep') } });
        App.closeModal(); App.notify('Settings saved for ' + name + '.', 'success'); refreshInstalled();
      } catch (e) { App.notify(e.message, 'error', 7000); }
    });
  }

  // ── AI Chat ────────────────────────────────────────────────────────────────
  async function renderChat(container) {
    let models = [];
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      models = (data.models || []).filter(m => m.local || m.backup);
    } catch (e) { models = []; }
    if (st.view !== 'chat') return;
    const c = st.chat;
    if (!c.model || !models.some(m => m.id === c.model)) c.model = (models[0] && models[0].id) || '';
    container.innerHTML = '<div class="lai lai-chat"><div class="card lai-chat-head">' +
      (models.length ? '<label class="lai-chat-model"><span class="form-label">Model on this device</span><select class="form-select" id="lai-chat-model">' +
        models.map(m => '<option value="' + esc(m.id) + '"' + (m.id === c.model ? ' selected' : '') + '>' + esc(String(m.name || m.id).replace(/ \((on this device|local backup)\)/, '')) + '</option>').join('') + '</select></label>' +
        '<button class="btn btn-ghost btn-sm" data-act="new-chat">New chat</button>'
        : '<p>No model on this device can answer yet. <a href="#model-store">Install one in the AI Model Store</a>.</p>') +
      '<p class="form-hint">Answers come from a model on the MetaCode server\'s own hardware: nothing you write here leaves it.</p></div>' +
      '<div class="lai-chat-log" id="lai-log" role="log" aria-live="polite"></div>' +
      '<form class="lai-chat-form" id="lai-chat-form"><textarea class="form-input" id="lai-chat-input" rows="2" placeholder="Message the model…" aria-label="Message"' + (models.length ? '' : ' disabled') + '></textarea>' +
      '<button class="btn btn-primary" type="submit" id="lai-send"' + (models.length ? '' : ' disabled') + '>Send</button><button class="btn btn-ghost" type="button" id="lai-stop" hidden>Stop</button></form></div>';
    paintChat();
    const sel = document.getElementById('lai-chat-model');
    if (sel) sel.addEventListener('change', () => { c.model = sel.value; });
    const input = document.getElementById('lai-chat-input');
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('lai-chat-form').requestSubmit(); } });
    document.getElementById('lai-chat-form').addEventListener('submit', e => { e.preventDefault(); send(input.value); });
    document.getElementById('lai-stop').addEventListener('click', () => { if (c.busy) c.busy.abort(); });
    wire(container);
  }
  function paintChat() {
    const log = document.getElementById('lai-log');
    if (!log) return;
    const c = st.chat;
    log.innerHTML = c.messages.length ? c.messages.map(m => '<div class="lai-msg lai-' + m.role + '">' + esc(m.content || (m.role === 'assistant' ? '…' : '')).replace(/\n/g, '<br>') + '</div>').join('')
      : '<div class="lai-chat-empty">Ask anything. Small models are quick but make mistakes: check what matters.</div>';
    log.scrollTop = log.scrollHeight;
  }
  async function send(text) {
    const c = st.chat;
    text = String(text || '').trim();
    if (!text || c.busy || !c.model) return;
    document.getElementById('lai-chat-input').value = '';
    c.messages.push({ role: 'user', content: text });
    const answer = { role: 'assistant', content: '' };
    c.messages.push(answer);
    paintChat();
    const ac = new AbortController();
    c.busy = ac;
    document.getElementById('lai-stop').hidden = false;
    document.getElementById('lai-send').disabled = true;
    try {
      const res = await fetch('/api/ai', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-provider': 'openai', 'X-MetaCode-Feature': 'chat', 'X-MetaCode-Model-Switch': 'off' },
        body: JSON.stringify({ model: c.model, stream: true, max_tokens: 1024, messages: c.messages.filter(m => m !== answer).slice(-20).map(m => ({ role: m.role, content: m.content })) }) });
      if (!res.ok || !res.body) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (e) { /* not JSON */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.error) throw new Error(j.error.message || 'The model failed.');
            const d = j.choices && j.choices[0] && j.choices[0].delta;
            if (d && d.content) { answer.content += d.content; paintChat(); }
          } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') answer.content = (answer.content ? answer.content + '\n\n' : '') + '⚠ ' + e.message;
    } finally {
      c.busy = null;
      if (!answer.content) answer.content = '(stopped)';
      paintChat();
      const stop = document.getElementById('lai-stop'); if (stop) stop.hidden = true;
      const sendBtn = document.getElementById('lai-send'); if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ── System ─────────────────────────────────────────────────────────────────
  async function renderSystem(container) {
    let rt = null;
    try { await loadStatus(); rt = await api('GET', '/runtimes'); } catch (e) { /* the browser half still shows */ }
    if (st.view !== 'system') return;
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate().catch(() => null) : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => null) : null;
    const pwa = window.MetaPWA || {};
    const row = (k, v) => '<tr><th>' + esc(k) + '</th><td>' + v + '</td></tr>';
    const h = st.hw;
    const browser = '<div class="card"><h3>This browser</h3><table class="lai-kv">' +
      row('Device', esc((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '?') + (navigator.hardwareConcurrency ? ' · ' + navigator.hardwareConcurrency + ' CPU threads' : '') + (navigator.deviceMemory ? ' · about ' + navigator.deviceMemory + ' GB memory' : '')) +
      row('Network', navigator.onLine === false ? 'offline' : 'online') +
      row('Installed as an app', pwa.installed && pwa.installed() ? 'yes' : 'no: your browser\'s menu offers "Install" or "Add to Home Screen"') +
      row('Works offline', pwa.supported ? (pwa.version ? 'yes (offline copy ' + esc(pwa.version.slice(0, 8)) + ')' : 'setting up…') : 'no: this address isn\'t https or localhost') +
      row('Data kept here', est ? size(est.usage) + ' of ' + size(est.quota) + ' allowed' + (persisted ? ' · kept even when space runs low' : persisted === false ? ' · the browser may clear it when space runs low (install the app to keep it)' : '') : '?') +
      row('Performance', esc((window.MetaPerf && MetaPerf.describe()) || 'Balanced')) +
      '</table></div>';
    const server = h ? '<div class="card"><h3>The MetaCode server</h3><table class="lai-kv">' +
      row('System', esc([h.os.name || h.os.platform, h.os.device].filter(Boolean).join(' · ') + ' (' + h.arch + ')')) +
      row('CPU', esc((h.cpu.model || '?') + ', ' + h.cpu.threads + ' threads')) +
      row('Memory', size(h.memory.total) + ' (' + size(h.memory.available) + ' available)') +
      row('GPU', (h.gpus || []).length ? h.gpus.map(g => esc(g.name) + (g.memory && !g.shared ? ' · ' + size(g.memory) : '') + (g.usable ? '' : ' (not used by Ollama)')).join('<br>') : 'none found: models run on the CPU') +
      row('Disk for models', h.disk && h.disk.free != null ? size(h.disk.free) + ' free of ' + size(h.disk.total) + (h.disk.path ? ' <span class="form-hint">' + esc(h.disk.path) + '</span>' : '') : '?') +
      row('AI', esc({ cloud: 'cloud providers first, models here as the backup', local: 'models on this computer first', 'local-only': 'only models on this computer: no prompt leaves it' }[st.status && st.status.mode] || 'cloud')) +
      row('Node.js', esc(h.node)) + '</table></div>' : '<div class="card"><h3>The MetaCode server</h3><p>It can\'t be reached right now.</p></div>';
    const runtimes = rt ? '<div class="card"><h3>AI runtimes here</h3>' + rt.runtimes.map(r => '<div class="lai-runtime"><div><strong>' + esc(r.name) + '</strong> ' +
        (r.status === 'running' ? '<span class="badge badge-green">running</span>' : r.status === 'unsupported' ? '<span class="badge badge-gray">not for this system</span>' : '<span class="badge badge-amber">not running</span>') +
        '</div><p class="form-hint">' + esc(r.detail) + '</p>' + (r.models ? '<p class="form-hint">Models: ' + esc(r.models.join(', ')) + '</p>' : '') + (r.howTo ? '<p class="form-hint"><code>' + esc(r.howTo) + '</code></p>' : '') + '</div>').join('') +
      (canManage() ? '<button class="btn btn-secondary btn-sm" data-act="scan">Look for other AI servers on this computer</button> <span class="form-hint">llama.cpp, LM Studio, Jan, vLLM, LocalAI (only their usual ports)</span>' : '') + '</div>' +
      '<div class="card"><h3>Where each runtime works</h3><div class="lai-table-wrap"><table class="lai-table"><thead><tr><th>System</th><th>Ollama</th><th>OpenAI-compatible server</th><th>Another MetaCode server</th></tr></thead><tbody>' +
        rt.matrix.map(m => '<tr' + (rt.platform && rt.platform.id === m.id ? ' class="lai-here"' : '') + '><td>' + esc(m.name) + (rt.platform && rt.platform.id === m.id ? ' <span class="badge badge-blue">this server</span>' : '') + '</td><td>' + esc(m.ollama) + '</td><td>' + esc(m.openai) + '</td><td>' + esc(m.server) + '</td></tr>').join('') +
      '</tbody></table></div><p class="form-hint">Phones and tablets use the AI of a MetaCode server on your network or online: open it in the browser and install it as an app.</p></div>' : '';
    container.innerHTML = '<div class="lai"><div class="lai-sys">' + browser + server + '</div>' + runtimes + '</div>';
    wire(container);
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function wire(root) {
    root.querySelectorAll('[data-act]').forEach(el => {
      if (el.dataset.wired) return;
      el.dataset.wired = '1';
      el.addEventListener('click', e => { e.preventDefault(); act(el.dataset.act, el.dataset.model || el.dataset.name, el); });
    });
    root.querySelectorAll('.lai-tab').forEach(el => el.addEventListener('click', () => { st.tab = el.dataset.tab; paintBody(); }));
    const body = root.querySelector('#lai-body') || (root.id === 'lai-body' ? root : null);
    if (body && !body.dataset.wired) {
      body.dataset.wired = '1';
      body.addEventListener('input', e => { if (e.target.id === 'lai-q') { st.query = e.target.value; st.shown = 30; const pos = e.target.selectionStart; paintBody(); const q = document.getElementById('lai-q'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } } });
      body.addEventListener('change', e => { if (e.target.id === 'lai-sort') { st.sort = e.target.value; paintBody(); } });
      body.addEventListener('click', e => {
        const f = e.target.closest('[data-filter]');
        if (f) { st[f.dataset.filter] = f.dataset.value; st.shown = 30; paintBody(); return; }
        const a = e.target.closest('[data-act]');
        if (a && !a.dataset.wired) { e.preventDefault(); act(a.dataset.act, a.dataset.model || a.dataset.name, a); }
      });
    }
  }
  async function act(what, model, el) {
    try {
      if (what === 'install') { await api('POST', '/installs', { model }); App.notify('Installing ' + model + '…', 'info'); return; }
      if (what === 'pause' || what === 'resume' || what === 'cancel') { await api('POST', '/installs/' + what, { model }); return; }
      if (what === 'details') return showDetails(model);
      if (what === 'more') { st.shown += 30; return paintBody(); }
      if (what === 'refresh') { const c = await api('GET', '/catalog?refresh=1'); st.catalog = c; st.recs = await api('GET', '/recommendations'); App.notify(c.problem || 'The catalog is up to date.', c.problem ? 'warning' : 'success', 6000); return App.navigate('model-store'); }
      if (what === 'token') { const v = document.getElementById('lai-token').value.trim(); try { localStorage.setItem(TOKEN_KEY, v); } catch (e) { /* private mode */ } return App.navigate(location.hash.slice(1)); }
      if (what === 'default') {
        App.setState({ settings: Object.assign({}, App.getState().settings, { model: 'ollama/' + model }) });
        App.notify(model + ' is now the default model in this browser.', 'success');
        return paintInstalled();
      }
      if (what === 'load' || what === 'unload') { el.disabled = true; st.installed = await api('POST', '/models/' + what, { model }); return paintInstalled(); }
      if (what === 'update') { await api('POST', '/models/update', { model }); App.notify('Checking ' + model + ' for an update…', 'info'); return; }
      if (what === 'settings') return modelSettings(model);
      if (what === 'delete') {
        App.openModal('Delete ' + model + '?', '<p>It is removed from this computer (' + size((((st.installed && st.installed.models) || []).find(m => m.name === model) || {}).size) + '). You can install it again from the AI Model Store.</p>',
          '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-danger" id="lai-del-ok">Delete</button>');
        document.getElementById('lai-del-ok').addEventListener('click', async () => {
          try { st.installed = await api('POST', '/models/delete', { model }); App.closeModal(); App.notify(model + ' was deleted.', 'success'); paintInstalled(); }
          catch (e) { App.notify(e.message, 'error', 7000); }
        });
        return;
      }
      if (what === 'scan') { el.disabled = true; await api('POST', '/runtimes/scan'); return App.navigate('system'); }
      if (what === 'new-chat') { if (st.chat.busy) st.chat.busy.abort(); st.chat.messages = []; return paintChat(); }
    } catch (e) {
      if (el) el.disabled = false;
      App.notify(e.message, 'error', 8000);
    }
  }

  return { render };
})();
