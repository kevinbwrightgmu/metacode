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
   Each page's root, and the Details modal's own wrapper, takes all their clicks with one listener: buttons that a
   download's progress repaints keep working. Model names are compared whatever their case: the catalog spells
   them as ollama.com does, Ollama as they were first pulled, and the server keys downloads in lowercase.
   ══════════════════════════════════════════════ */
const LocalAI = (() => {
  'use strict';
  const API = '/api/local-ai';
  const TOKEN_KEY = 'metacode_local_ai_token';
  const esc = s => App.esc(String(s == null ? '' : s));
  const st = { view: null, status: null, hw: null, runtimes: null, catalog: null, recs: null, installed: null, offered: undefined, offeredNote: '', offeredLooks: 0,
    jobs: new Map(), events: null, tab: 'recommended', query: '', category: '', capability: '', sort: 'pulls', shown: 30,
    chat: { messages: [], model: '', busy: null } };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } };
  const forgetToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ } };
  // What can't go in a header: beyond Latin-1 (a "–" or a curly quote), or a control character but a tab
  const UNSENDABLE = /[^\t\x20-\x7e\x80-\xff]/;
  // The admin token to send. One a browser can't put in a header (kept by an older version, say with a "–" copied
  // from a document) would fail every request as if the server were away, so it is forgotten instead.
  function adminToken() {
    const t = token();
    if (!t) return '';
    if (!UNSENDABLE.test(t)) return t;
    forgetToken();
    App.notify('The admin token kept in this browser had a character no browser can send in a request, so it was forgotten. Enter it again.', 'warning', 9000);
    return '';
  }
  // Why a typed token can't be the server's admin token ('' when it can): a browser sends a header's characters as
  // Latin-1 bytes (a space or an "ö" too, never a "–"), the server's HTTP parser refuses control characters but a
  // tab, and the server's token is at least 12 characters
  function tokenProblem(v) {
    if (!v) return 'Enter this server\'s admin token (LOCAL_AI_ADMIN_TOKEN) first.';
    if (UNSENDABLE.test(v)) return 'That token has a character a browser can\'t send (such as a “–” or a curly quote, often copied from a document): type it again.';
    if (v.length < 12) return 'That token is too short: this server\'s admin token (LOCAL_AI_ADMIN_TOKEN) is at least 12 characters.';
    return '';
  }
  const unreachable = () => (navigator.onLine === false ? 'This device is offline, and the MetaCode server can\'t be reached.' : 'The MetaCode server can\'t be reached.');
  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = adminToken();
    if (t) headers['X-MetaCode-Admin-Token'] = t;
    let res;
    try { res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new Error(unreachable()); }
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
  // "just now", "25 min ago", "5 h ago", else the day
  const ago = iso => {
    const t = Date.parse(iso);
    if (!t) return '';
    const min = Math.round((Date.now() - t) / 60000);
    return min < 2 ? 'just now' : min < 60 ? min + ' min ago' : min < 36 * 60 ? Math.round(min / 60) + ' h ago' : 'on ' + new Date(t).toLocaleDateString();
  };
  const lc = s => String(s == null ? '' : s).toLowerCase();
  const canManage = () => !!(st.status && st.status.manage && st.status.manage.allowed);
  const ollamaUp = () => !!(st.status && st.status.ollama && st.status.ollama.running);
  const installedNames = () => new Set(((st.installed && st.installed.models) || []).map(m => lc(m.name)));
  const tagged = n => (String(n).includes(':') ? String(n) : n + ':latest');
  // Ollama isn't answering: the server's word on it, as System shows it (some systems have none at all, and Termux
  // has its own), else where to get it
  function noOllama() {
    const r = ((st.runtimes && st.runtimes.runtimes) || []).find(x => x.id === 'ollama');
    if (r && r.status === 'unsupported') return { none: true, detail: r.detail };
    return { none: false, detail: r && r.status === 'not-running' && r.detail ? r.detail : 'Install it from ollama.com on the computer MetaCode runs on (a separate download), and start it.' };
  }
  // A model's size badge as a parameter count: "270m" → 2.7e8, "1.5b" → 1.5e9, "8x7b" → 5.6e10, "e2b" → 2e9
  const paramsOf = s => { const m = /^(?:(\d+)x)?e?([\d.]+)([mbt])$/i.exec(String(s || '').trim()); return m ? (m[1] ? Number(m[1]) : 1) * Number(m[2]) * { m: 1e6, b: 1e9, t: 1e12 }[m[3].toLowerCase()] : null; };
  // A model's smallest download: its tags' sizes when known, else from its smallest size at about 0.6 bytes per
  // parameter (the library's usual 4-bit default); null when neither is known
  function smallest(m) {
    const sizes = (m.tags || []).map(t => t.size).filter(n => n > 0);
    if (sizes.length) return Math.min(...sizes);
    const p = (m.sizes || []).map(paramsOf).filter(n => n > 0);
    return p.length ? Math.min(...p) * 0.6 : null;
  }
  function loadCss() {
    if (document.getElementById('local-ai-css')) return;
    const l = document.createElement('link');
    l.id = 'local-ai-css'; l.rel = 'stylesheet'; l.href = 'css/local-ai.css';
    document.head.appendChild(l);
  }
  const fromHTML = html => { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstElementChild; };
  const CATEGORIES = [['general', 'General'], ['coding', 'Coding'], ['reasoning', 'Reasoning'], ['vision', 'Vision'], ['embedding', 'Embeddings'], ['small', 'Small'], ['multilingual', 'Multilingual']];
  const CAPS = { vision: 'vision', tools: 'tools', thinking: 'reasoning', embedding: 'embeddings', audio: 'audio' };
  const RUNNING = ['queued', 'checking', 'downloading', 'verifying'];

  // ── Live install progress (server-sent events, while a Local AI page is open) ──
  const jobMap = list => new Map((list || []).map(j => [lc(j.model), j]));
  function openEvents() {
    if (st.events || typeof EventSource === 'undefined') return;
    const es = new EventSource(API + '/installs/events');
    st.events = es;
    es.addEventListener('snapshot', e => {
      const before = st.jobs;
      st.jobs = jobMap(JSON.parse(e.data).installs);
      paintJobs();
      // (a download that ended while the stream was away says so now)
      st.jobs.forEach((j, k) => ended(j, before.get(k)));
    });
    es.addEventListener('job', e => {
      const j = JSON.parse(e.data);
      const k = lc(j.model);
      const before = st.jobs.get(k);
      if (j.state === 'cancelled') st.jobs.delete(k); else st.jobs.set(k, j);
      paintJobs();
      ended(j, before);
    });
    // The browser reconnects by itself after a network error, but not after an HTTP error (a proxy's 502 while
    // MetaCode restarts): then the stream is opened again a little later, and its snapshot catches up
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED || st.events !== es) return;
      st.events = null;
      setTimeout(() => { if (st.view === 'store' || st.view === 'installed') openEvents(); }, 5000);
    };
  }
  function closeEvents() { if (st.events) { st.events.close(); st.events = null; } }
  function ended(j, before) {
    if (j.state === 'done' && (!before || before.state !== 'done')) {
      App.notify(j.verified === false ? j.model + ' installed, but its digest doesn\'t match Ollama\'s library.' : j.model + ' is installed' + (j.verified ? ' and verified.' : '.'), j.verified === false ? 'warning' : 'success', 5000);
      refreshInstalled(j.model);
    }
    if (j.state === 'failed' && (!before || before.state !== 'failed')) App.notify(j.error || ('Couldn\'t install ' + j.model + '.'), 'error', 9000);
  }
  // (fresh: a model just installed, which MetaCode's AI service may list only a moment later)
  async function refreshInstalled(fresh) {
    try { st.installed = await api('GET', '/models'); } catch (e) { st.installed = null; }
    if (st.view === 'store') { paintBody(); paintJobs(); }      // (the Details modal's buttons too)
    if (st.view !== 'installed') return;
    // (Ollama's list at once; which of them MetaCode's AI service offers once it answers, which may take a while)
    const offered = loadOffered();
    paintInstalled();
    await offered;
    if (st.view === 'installed') paintInstalled();
    const m = fresh && st.view === 'installed' && st.offered && ((st.installed && st.installed.models) || []).find(x => lc(x.name) === lc(fresh));
    if (m && !embedding(m) && !chatId(m)) setTimeout(async () => { if (st.view !== 'installed') return; await loadOffered(); if (st.view === 'installed') paintInstalled(); }, 3000);
  }

  // ── Entry ──────────────────────────────────────────────────────────────────
  function render(view, container) {
    loadCss();
    st.view = view;
    // (leaving stops the live progress, and an answer AI Chat is still streaming: nobody would read it, and it would
    // keep this machine's model busy)
    App.setViewCleanup(() => { closeEvents(); if (st.chat.busy) st.chat.busy.abort(); st.view = null; });
    container.innerHTML = '<div class="lai"><div class="loading-state">Loading…</div></div>';
    const done = () => {};
    if (view === 'store') return renderStore(container).then(done);
    if (view === 'installed') return renderInstalled(container).then(done);
    if (view === 'chat') return renderChat(container).then(done);
    if (view === 'system') return renderSystem(container).then(done);
  }
  // A page's content: its root, new on each render, takes the page's clicks, edits and choices
  function show(container, html) {
    container.innerHTML = html;
    const root = container.querySelector('.lai');
    if (root) delegate(root);
  }
  async function loadStatus() {
    try {
      // (the runtimes too: the server's word on Ollama when it isn't running)
      const [status, hw, runtimes] = await Promise.all([api('GET', '/status'), api('GET', '/hardware').catch(() => null), api('GET', '/runtimes').catch(() => null)]);
      st.status = status; st.hw = hw; st.runtimes = runtimes;
      st.jobs = jobMap(status.installs);
    } catch (e) {
      // (nothing from an earlier visit is shown as if it were current)
      st.status = null; st.hw = null; st.runtimes = null;
      throw e;
    }
  }
  function failed(container, err) {
    show(container, '<div class="lai"><div class="card lai-problem"><h3>The AI Model Store can\'t be shown</h3><p>' + esc(err.message) + '</p>' +
      '<p class="form-hint">The store and the models live on the MetaCode server. Your projects are still here and work offline.</p>' +
      (token() ? '<p class="form-hint">This browser keeps an admin token for the store. <button class="btn btn-ghost btn-sm" data-act="forget-token">Forget token</button></p>' : '') + '</div></div>');
  }

  // ── Header: this device, Ollama, who may manage ─────────────────────────────
  function deviceLine() {
    const h = st.hw;
    if (!h) return '';
    const gpu = (h.gpus || []).filter(g => g.usable)[0];
    // (the memory free now isn't always known, as on a Mac whose vm_stat didn't answer)
    return '<span class="lai-chip" title="Memory on the MetaCode server">' + size(h.memory.total) + ' RAM' + (h.memory.available != null ? ' (' + size(h.memory.available) + ' free)' : '') + '</span>' +
      '<span class="lai-chip">' + esc(h.cpu.threads + ' CPU threads, ' + h.arch) + '</span>' +
      '<span class="lai-chip">' + (gpu ? esc(gpu.name) + (gpu.memory && !gpu.shared ? ' · ' + size(gpu.memory) : '') : 'No GPU: models run on the CPU') + '</span>' +
      (h.disk && h.disk.free != null ? '<span class="lai-chip" title="' + esc(h.disk.path || '') + '">' + size(h.disk.free) + ' disk free</span>' : '');
  }
  function ollamaLine() {
    const o = st.status && st.status.ollama;
    if (o && o.running) return '<span class="badge badge-green">Ollama ' + esc(o.version || '') + ' running</span>';
    const n = noOllama();
    if (n.none) return '<span class="badge badge-gray">No Ollama for this system</span> <span class="form-hint">' + esc(n.detail) + ' <a href="#system">System</a> shows where each runtime works. You can browse meanwhile.</span>';
    return '<span class="badge badge-amber">Ollama isn\'t running</span> <span class="form-hint">' + esc(n.detail) + ' Then reload this page. You can browse meanwhile.</span>';
  }
  function manageLine() {
    const m = st.status && st.status.manage;
    if (!m) return '';
    const forget = '<button class="btn btn-ghost btn-sm" data-act="forget-token">Forget token</button>';
    if (m.allowed) return m.how === 'token' && token() ? '<div class="form-hint lai-tokenline">Models are managed from here with the admin token kept in this browser. ' + forget + '</div>' : '';
    const kept = token() ? '<p class="lai-warn">' + (m.tokenSet ? 'The server refused the admin token kept in this browser: enter the right one, or forget it.' : 'This browser keeps an admin token, but the server has none set.') + ' ' + forget + '</p>' : '';
    return '<div class="lai-locked card"><strong>Browsing only on this device.</strong> ' + esc(m.reason) + kept +
      (m.tokenSet ? '<div class="lai-token"><input type="password" class="form-input" id="lai-token" placeholder="Admin token" autocomplete="off">' +
        '<button class="btn btn-secondary btn-sm" data-act="token">Use token</button></div>' : '') + '</div>';
  }
  const shownJobs = () => [...st.jobs.values()].filter(j => !['done', 'cancelled'].includes(j.state));
  function jobsHTML() {
    const jobs = shownJobs();
    if (!jobs.length) return '';
    return '<div class="card lai-downloads"><h3>Downloads</h3>' + jobs.map(jobRow).join('') + '</div>';
  }
  // A download's row is built again only when its buttons change (sig); its progress is updated in place, so a
  // press on Pause or Cancel isn't lost when the next progress event repaints the card
  const jobSig = j => (canManage() ? 'm' : '') + (RUNNING.includes(j.state) ? 'p' : '') + (j.state === 'paused' || j.state === 'failed' ? 'r' : '');
  const jobState = j => (j.state === 'failed' ? 'Failed' : j.status || j.state);
  const jobFacts = j => (j.state === 'failed' ? j.error || '' : [j.total ? size(j.completed) + ' of ' + size(j.total) : '', speed(j.speed), eta(j.eta), j.resumed ? 'continued where it stopped' : ''].filter(Boolean).join(' · '));
  function jobRow(j) {
    const pct = j.percent == null ? 0 : j.percent;
    const b = (what, cls, label) => '<button class="btn ' + cls + ' btn-sm" data-act="' + what + '" data-model="' + esc(j.model) + '">' + label + '</button>';
    return '<div class="lai-job" data-model="' + esc(j.model) + '" data-sig="' + jobSig(j) + '">' +
      '<div class="lai-job-top"><strong>' + esc(j.model) + '</strong><span class="lai-job-state">' + esc(jobState(j)) + '</span></div>' +
      '<div class="lai-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
      '<div class="lai-job-foot"><span class="form-hint lai-job-facts">' + esc(jobFacts(j)) + '</span><span>' +
      (canManage() ? (RUNNING.includes(j.state) ? b('pause', 'btn-ghost', 'Pause') : '') + (j.state === 'paused' || j.state === 'failed' ? b('resume', 'btn-secondary', 'Resume') : '') +
        b('cancel', 'btn-ghost', 'Cancel') : '') + '</span></div></div>';
  }
  function fillJob(row, j) {
    const pct = j.percent == null ? 0 : j.percent;
    row.querySelector('.lai-job-state').textContent = jobState(j);
    const bar = row.querySelector('.lai-bar');
    bar.setAttribute('aria-valuenow', pct);
    bar.firstElementChild.style.width = pct + '%';
    row.querySelector('.lai-job-facts').textContent = jobFacts(j);
  }
  function paintJobs() {
    const box = document.getElementById('lai-jobs');
    if (box) {
      const jobs = shownJobs();
      if (!jobs.length) box.innerHTML = '';
      else {
        if (!box.querySelector('.lai-downloads')) box.innerHTML = '<div class="card lai-downloads"><h3>Downloads</h3></div>';
        const card = box.querySelector('.lai-downloads');
        const rows = new Map([...card.querySelectorAll('.lai-job')].map(r => [lc(r.dataset.model), r]));
        let prev = card.querySelector('h3');
        for (const j of jobs) {
          let row = rows.get(lc(j.model));
          rows.delete(lc(j.model));
          if (row && row.dataset.sig === jobSig(j)) fillJob(row, j);
          else { const fresh = fromHTML(jobRow(j)); if (row) row.replaceWith(fresh); row = fresh; }
          if (prev.nextElementSibling !== row) prev.after(row);
          prev = row;
        }
        rows.forEach(r => r.remove());
      }
    }
    // The cards' buttons follow, each rebuilt only when what it shows changed (so a press on one isn't lost)
    document.querySelectorAll('[data-install-for]').forEach(el => {
      const tag = el.getAttribute('data-install-for');
      if (el.getAttribute('data-sig') !== installSig(tag)) el.outerHTML = installButton(tag);
    });
  }
  // What a model's Install button shows depends on this
  function installSig(tag) {
    const k = lc(tagged(tag));
    const j = st.jobs.get(k);
    return [installedNames().has(k) ? 'i' : '', j ? j.state + ' ' + (j.percent == null ? '' : j.percent) : '', canManage() && ollamaUp() ? 'm' : ''].join('|');
  }
  function installButton(tag) {
    const t = tagged(tag);
    const j = st.jobs.get(lc(t));
    const attr = ' data-install-for="' + esc(t) + '" data-sig="' + esc(installSig(t)) + '"';
    if (installedNames().has(lc(t)) && !(j && !['done', 'failed', 'cancelled'].includes(j.state))) return '<span class="badge badge-green"' + attr + '>Installed</span>';
    if (j && RUNNING.includes(j.state)) return '<span class="lai-mini"' + attr + '><span class="lai-bar"><span style="width:' + (j.percent || 0) + '%"></span></span>' + (j.percent != null ? j.percent + '%' : '…') + '</span>';
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
      if (ollamaUp()) await refreshInstalled(); else st.installed = null;
    } catch (e) { return failed(container, e); }
    if (st.view !== 'store') return;
    const c = st.catalog;
    // (the library is read again after a day, or with Refresh: when it was read is said)
    const src = c.source === 'live' ? ('from ollama.com ' + ago(c.fetchedAt)).trim() : c.source === 'cache' ? 'saved on ' + when(c.fetchedAt) : 'the copy that came with MetaCode (' + when(c.fetchedAt) + ')';
    show(container, '<div class="lai">' +
      '<div class="card lai-head"><div class="lai-head-row"><div><h2 class="lai-title">AI Model Store</h2>' +
        '<p class="form-hint">Models from Ollama\'s library that run on your own hardware: your prompts and data stay here. Big models need lots of memory; the recommendations below fit this computer.</p></div>' +
        '<div class="lai-head-side">' + ollamaLine() + '</div></div>' +
        '<div class="lai-chips">' + deviceLine() + '</div>' +
        '<div class="form-hint lai-source">Catalog: ' + esc(src) + ' · ' + c.models.length + ' models' +
          (c.problem ? ' · <span class="lai-warn">' + esc(c.problem) + '</span>' : '') +
          ' <button class="btn btn-ghost btn-sm" data-act="refresh">Refresh</button></div></div>' +
      manageLine() + '<div id="lai-jobs">' + jobsHTML() + '</div>' +
      '<div class="lai-tabs" role="tablist"><button role="tab" class="lai-tab" data-tab="recommended">Recommended for this computer</button><button role="tab" class="lai-tab" data-tab="all">All models</button></div>' +
      '<div id="lai-body"></div></div>');
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
          (m.context ? '<span>' + Math.round(m.context / 1024) + 'K context</span>' : '') + '<span>' + (m.runsOn === 'gpu' ? 'runs on the GPU' : m.runsOn === 'mixed' ? 'runs partly on the CPU' : 'runs on the CPU') + '</span></div>' +
        '<div class="lai-badges">' + badges(m) + ' <button class="btn btn-ghost btn-sm" data-act="details" data-name="' + esc(m.name) + '">Details</button></div></article>').join('') + '</div></section>').join('');
  }
  function filtered() {
    const q = st.query.trim().toLowerCase();
    let list = (st.catalog ? st.catalog.models : []).filter(m => (!q || lc(m.name).includes(q) || lc(m.description).includes(q)) &&
      (!st.category || (m.categories || []).includes(st.category)) && (!st.capability || (m.capabilities || []).includes(st.capability)));
    if (st.sort === 'name') list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
    else if (st.sort === 'updated') list = list.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    else if (st.sort === 'size') {
      // (the smallest download first; a model whose sizes aren't known last)
      const key = new Map(list.map(m => [m, smallest(m)]));
      list = list.slice().sort((a, b) => { const x = key.get(a), y = key.get(b); return ((x == null) - (y == null)) || (x - y) || ((b.pulls || 0) - (a.pulls || 0)); });
    } else list = list.slice().sort((a, b) => (b.pulls || 0) - (a.pulls || 0));
    return list;
  }
  function allHTML() {
    const list = filtered();
    const chips = (items, key) => items.map(([v, label]) => '<button class="lai-filter' + (st[key] === v ? ' on' : '') + '" data-filter="' + key + '" data-value="' + esc(v) + '">' + esc(label) + '</button>').join('');
    const sorts = [['pulls', 'Most used'], ['updated', 'Recently updated'], ['size', 'Smallest first'], ['name', 'Name']];
    return '<div class="lai-search"><input type="search" class="form-input" id="lai-q" placeholder="Search models by name or description" value="' + esc(st.query) + '" aria-label="Search models">' +
      '<select class="form-select" id="lai-sort" aria-label="Sort">' + sorts.map(([v, label]) => '<option value="' + v + '"' + (st.sort === v ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div>' +
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
    // (its content sits in a wrapper of LocalAI's own, which takes its clicks: #modal-body is every page's)
    App.openModal(name, '<div class="lai-details"><div class="loading-state">Loading its sizes…</div></div>');
    const box = document.querySelector('#modal-body .lai-details');
    delegate(box);
    let m;
    try { m = await api('GET', '/catalog/model?name=' + encodeURIComponent(name)); } catch (e) { if (box.isConnected) box.innerHTML = '<p>' + esc(e.message) + '</p>'; return; }
    // (an answer that comes after this modal was closed, or another one opened, is too late for it)
    if (!box.isConnected) return;
    const fitLabel = f => (f.level === 'good' ? '<span class="badge badge-green">fits</span>' : f.level === 'tight' ? '<span class="badge badge-amber">fits, tight</span>' : '<span class="badge badge-red">too big here</span>');
    const rows = m.tags.slice().sort((a, b) => (b.main - a.main) || (a.size - b.size)).map(t =>
      '<tr><td><code>' + esc(t.tag) + '</code></td><td>' + size(t.size) + '</td><td>≈ ' + size(t.fit.need) + '</td><td>' + (t.context ? Math.round(t.context / 1024) + 'K' : '') + '</td><td>' + esc((t.inputs || []).join(', ')) + '</td><td>' + fitLabel(t.fit) + '</td>' +
      '<td>' + (t.fit.level === 'too-big' ? '' : installButton(t.tag)) + '</td></tr>').join('');
    box.innerHTML = '<p>' + esc(m.description) + '</p>' +
      (m.tagsOffline ? '<p class="form-hint lai-warn">Offline: the sizes known from before are shown.</p>' : '') +
      '<div class="lai-table-wrap"><table class="lai-table"><thead><tr><th>Tag</th><th>Download</th><th>Memory</th><th>Context</th><th>Input</th><th>Here</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="form-hint">Memory is an estimate for Ollama\'s default context; Ollama checks the download\'s sha256, and MetaCode checks the installed model against Ollama\'s library.</p>';
  }

  // ── Installed Models ───────────────────────────────────────────────────────
  async function renderInstalled(container) {
    try { await loadStatus(); } catch (e) { return failed(container, e); }
    if (st.view !== 'installed') return;
    show(container, '<div class="lai"><div class="card lai-head"><div class="lai-head-row"><div><h2 class="lai-title">Installed Models</h2>' +
      '<p class="form-hint">The models on this computer. Pick which one each AI feature uses, keep one in memory for quick answers, or remove those you don\'t need.</p></div>' +
      '<div class="lai-head-side">' + ollamaLine() + '</div></div><div class="lai-chips">' + deviceLine() + '</div></div>' + manageLine() +
      '<div id="lai-jobs">' + jobsHTML() + '</div><div id="lai-installed"></div></div>');
    openEvents();
    if (ollamaUp()) await refreshInstalled(); else { st.installed = null; paintInstalled(); }
  }
  // Which of this device's models MetaCode's AI service offers: only those can be the default or a feature's model
  // (it never offers an embedding model, and METACODE_OLLAMA_MODELS can leave others out).
  // st.offered: lowercase id → the service's id; null when its list can't be read; undefined before it first
  // answers. st.offeredLooks: looks under way (the last answer holds meanwhile, for the models it has).
  async function loadOffered() {
    st.offeredLooks++;
    let offered = null, note = '';
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        offered = new Map((data.models || []).filter(m => /^ollama\//i.test(m.id)).map(m => [lc(m.id), m.id]));
        if (!(data.models || []).length) note = data.note || '';
      }
    } catch (e) { offered = null; }
    st.offered = offered; st.offeredNote = note; st.offeredLooks--;
  }
  // (not known yet whether it offers this one: no answer so far, or one that didn't have it and a new look under way)
  const offerUnknown = m => st.offered === undefined || (st.offeredLooks > 0 && !(st.offered && st.offered.has(lc('ollama/' + m.name))));
  const embedding = m => (m.capabilities || []).includes('embedding') || /embed/i.test(m.name);
  // The AI service's id for an installed model, or null when it doesn't offer it (when its list can't be read, any
  // model but an embedding one, as it can't be checked)
  function chatId(m) {
    if (embedding(m) || offerUnknown(m)) return null;
    return st.offered ? st.offered.get(lc('ollama/' + m.name)) || null : 'ollama/' + m.name;
  }
  const notOffered = m => (embedding(m) ? 'Not offered for AI features: an embedding model, which can\'t chat.'
    : offerUnknown(m) ? 'Checking whether MetaCode\'s AI service offers it…'
    : 'Not offered for AI features' + (st.offeredNote ? ' right now: ' + st.offeredNote : ': MetaCode\'s AI service doesn\'t list it (METACODE_OLLAMA_MODELS may leave it out).'));
  // The other names Ollama lists for a model's files (one digest): deleting one of them frees nothing while another stays
  const sameFiles = m => ((st.installed && st.installed.models) || []).filter(o => o !== m && m.digest && o.digest === m.digest).map(o => o.name);
  function paintInstalled() {
    const box = document.getElementById('lai-installed');
    if (!box) return;
    // ("checking" while MetaCode's AI service hasn't said which models it offers)
    box.dataset.offered = st.offered === undefined || st.offeredLooks > 0 ? 'checking' : 'known';
    if (!ollamaUp()) {
      const n = noOllama();
      box.innerHTML = '<div class="card"><p>' + (n.none ? esc(n.detail) : 'Ollama isn\'t running on the MetaCode server, so no installed model can be shown.') + '</p></div>';
      return;
    }
    const ms = (st.installed && st.installed.models) || [];
    if (!ms.length) { box.innerHTML = '<div class="card"><p>No model is installed yet.</p><a class="btn btn-primary" href="#model-store">Open the AI Model Store</a></div>'; return; }
    const s = App.getState().settings || {};
    const def = lc(s.model);
    const chat = ms.map(m => ({ m, id: chatId(m) })).filter(x => x.id);
    box.innerHTML = '<div class="card"><h3>' + ms.length + ' model' + (ms.length === 1 ? '' : 's') + ', ' + size(st.installed.totalSize) + ' on disk</h3>' +
      '<div class="lai-table-wrap"><table class="lai-table"><thead><tr><th>Model</th><th>Size</th><th>Details</th><th>In memory</th><th></th></tr></thead><tbody>' +
      ms.map(m => {
        const id = chatId(m);
        const same = sameFiles(m);
        return '<tr><td><strong>' + esc(m.name) + '</strong>' + (def && def === lc('ollama/' + m.name) ? ' <span class="badge badge-blue">default</span>' : '') + '</td><td>' + size(m.size) + '</td>' +
          '<td class="form-hint">' + esc([m.parameterSize, m.quantization, m.contextLength ? Math.round(m.contextLength / 1024) + 'K context' : '', (m.capabilities || []).filter(c => c !== 'completion').join(', '),
            same.length ? 'the same files as ' + same.join(', ') : ''].filter(Boolean).join(' · ')) + '</td>' +
          '<td>' + (m.loaded ? '<span class="badge badge-green">loaded</span> <span class="form-hint">' + size(m.loaded.size) + (m.loaded.sizeVram ? ' (GPU)' : '') + '</span>' : '<span class="form-hint">no</span>') + '</td>' +
          '<td class="lai-actions">' + (id ? '<button class="btn btn-secondary btn-sm" data-act="default" data-model="' + esc(m.name) + '" data-id="' + esc(id) + '"' + (def === lc(id) ? ' disabled' : '') + '>Use as default</button>'
            // (while MetaCode's AI service hasn't answered: the button's place, so the buttons after it don't move when it does)
            : !embedding(m) && offerUnknown(m) ? '<button class="btn btn-secondary btn-sm" disabled title="' + esc(notOffered(m)) + '" aria-label="' + esc(notOffered(m)) + '">Use as default</button>'
            : '<span class="form-hint">' + esc(notOffered(m)) + '</span>') +
          (canManage() ? (m.loaded ? '<button class="btn btn-ghost btn-sm" data-act="unload" data-model="' + esc(m.name) + '">Stop</button>' : '<button class="btn btn-ghost btn-sm" data-act="load" data-model="' + esc(m.name) + '">Load</button>') +
            '<button class="btn btn-ghost btn-sm" data-act="settings" data-model="' + esc(m.name) + '">Settings</button>' +
            // (Update downloads it again from Ollama's library: the server says which names that takes)
            (m.updatable !== false ? '<button class="btn btn-ghost btn-sm" data-act="update" data-model="' + esc(m.name) + '">Update</button>' : '') +
            '<button class="btn btn-ghost btn-sm lai-danger" data-act="delete" data-model="' + esc(m.name) + '">Delete</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="card"><h3>Which model each AI feature uses</h3><p class="form-hint">A feature without its own model uses the default. These are this browser\'s settings, like Settings → AI models.</p>' +
      '<div class="lai-features">' + App.AI_FEATURES.map(([fid, name, what]) => {
        const saved = (s.models || {})[fid] || '';
        return '<label class="form-group"><span class="form-label">' + esc(name) + ' <span class="form-hint">' + esc(what) + '</span></span>' +
          '<select class="form-select" data-feature="' + esc(fid) + '"><option value="">The default model</option>' +
          chat.map(x => '<option value="' + esc(x.id) + '"' + (saved && lc(saved) === lc(x.id) ? ' selected' : '') + '>' + esc(x.m.name) + '</option>').join('') +
          (saved && !chat.some(x => lc(x.id) === lc(saved)) ? '<option value="' + esc(saved) + '" selected>' + esc(App.modelName(saved)) + '</option>' : '') + '</select></label>';
      }).join('') + '</div></div>';
  }
  function featureModel(sel) {
    const models = Object.assign({}, (App.getState().settings || {}).models || {});
    if (sel.value) models[sel.dataset.feature] = sel.value; else delete models[sel.dataset.feature];
    App.setState({ settings: Object.assign({}, App.getState().settings, { models }) });
    App.notify('Saved: ' + (sel.value ? App.modelName(sel.value) : 'the default model') + ' for ' + sel.closest('label').querySelector('.form-label').firstChild.textContent.trim() + '.', 'success');
  }
  function modelSettings(name) {
    const m = ((st.installed && st.installed.models) || []).find(x => lc(x.name) === lc(name)) || {};
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
    let models = [], why = '';
    try {
      const res = await fetch('/api/models');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      models = (data.models || []).filter(m => m.local || m.backup);
      if (!models.length) why = await whyNoModel(data);
    } catch (e) { why = esc(unreachable()); }
    if (st.view !== 'chat') return;
    const c = st.chat;
    const kept = models.find(m => lc(m.id) === lc(c.model));
    c.model = kept ? kept.id : (models[0] && models[0].id) || '';
    show(container, '<div class="lai lai-chat"><div class="card lai-chat-head">' +
      (models.length ? '<label class="lai-chat-model"><span class="form-label">Model on this device</span><select class="form-select" id="lai-chat-model">' +
        models.map(m => '<option value="' + esc(m.id) + '"' + (m.id === c.model ? ' selected' : '') + '>' + esc(String(m.name || m.id).replace(/ \((on this device|local backup)\)/, '')) + '</option>').join('') + '</select></label>' +
        '<button class="btn btn-ghost btn-sm" data-act="new-chat">New chat</button>'
        : '<p>' + why + '</p>') +
      '<p class="form-hint">Answers come from a model on the MetaCode server\'s own hardware: nothing you write here leaves it.</p></div>' +
      '<div class="lai-chat-log" id="lai-log" role="log" aria-live="polite"></div>' +
      '<form class="lai-chat-form" id="lai-chat-form"><textarea class="form-input" id="lai-chat-input" rows="2" placeholder="Message the model…" aria-label="Message"' + (models.length ? '' : ' disabled') + '></textarea>' +
      '<button class="btn btn-primary" type="submit" id="lai-send"' + (models.length && !c.busy ? '' : ' disabled') + '>Send</button><button class="btn btn-ghost" type="button" id="lai-stop"' + (c.busy ? '' : ' hidden') + '>Stop</button></form></div>');
    paintChat();
    const sel = document.getElementById('lai-chat-model');
    if (sel) sel.addEventListener('change', () => { c.model = sel.value; });
    const input = document.getElementById('lai-chat-input');
    // (an Enter that picks an input method's candidate, as in Japanese, Chinese or Korean, doesn't send: Safari marks
    // it only with keyCode 229)
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); document.getElementById('lai-chat-form').requestSubmit(); } });
    document.getElementById('lai-chat-form').addEventListener('submit', e => { e.preventDefault(); send(input.value); });
    document.getElementById('lai-stop').addEventListener('click', () => { if (c.busy) c.busy.abort(); });
  }
  // Why no model on this device can answer: Ollama isn't running (or there is none for this system), the AI service's
  // own reason, or none is installed yet
  async function whyNoModel(data) {
    try { await loadStatus(); } catch (e) { /* the AI service's word, then */ }
    if (st.status && !ollamaUp()) {
      const n = noOllama();
      return n.none ? esc(n.detail) : 'Ollama isn\'t running on the MetaCode server, so no model on this device can answer. ' + esc(n.detail) + ' Then reload this page.';
    }
    if (!(data.models || []).length && data.note) return esc(data.note);
    return 'No model on this device can answer yet. <a href="#model-store">Install one in the AI Model Store</a>.';
  }
  function paintChat() {
    const log = document.getElementById('lai-log');
    if (!log) return;
    const c = st.chat;
    // (a note of MetaCode's, such as "(stopped)", shows under the model's words)
    const shown = m => esc(m.content).replace(/\n/g, '<br>') + (m.note ? (m.content ? '<br>' : '') + '<span class="lai-note">' + esc(m.note) + '</span>' : '');
    log.innerHTML = c.messages.length ? c.messages.map(m => '<div class="lai-msg lai-' + m.role + '">' + (m.content || m.note ? shown(m) : m.role === 'assistant' ? '…' : '') + '</div>').join('')
      : '<div class="lai-chat-empty">Ask anything. Small models are quick but make mistakes: check what matters.</div>';
    log.scrollTop = log.scrollHeight;
  }
  // The conversation as the model said it, sent with the next question: no notes ("(stopped)", errors), and no
  // question that got no answer
  const spoken = ms => ms.filter((m, i) => (m.role === 'assistant' ? !!m.content : !(ms[i + 1] && ms[i + 1].role === 'assistant' && !ms[i + 1].content)))
    .map(m => ({ role: m.role, content: m.content }));
  async function send(text) {
    const c = st.chat;
    text = String(text || '').trim();
    if (!text || c.busy || !c.model) return;
    document.getElementById('lai-chat-input').value = '';
    c.messages.push({ role: 'user', content: text });
    const messages = spoken(c.messages).slice(-20);
    const answer = { role: 'assistant', content: '', note: '' };
    c.messages.push(answer);
    paintChat();
    const ac = new AbortController();
    c.busy = ac;
    document.getElementById('lai-stop').hidden = false;
    document.getElementById('lai-send').disabled = true;
    let finish = null, thinking = false;
    try {
      const res = await fetch('/api/ai', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', 'x-provider': 'openai', 'X-MetaCode-Feature': 'chat', 'X-MetaCode-Model-Switch': 'off' },
        body: JSON.stringify({ model: c.model, stream: true, max_tokens: 1024, messages }) });
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
            const ch = j.choices && j.choices[0];
            const d = ch && ch.delta;
            if (d && d.content) { answer.content += d.content; paintChat(); }
            else if (d && (d.reasoning_content || d.reasoning)) thinking = true;
            if (ch && ch.finish_reason) finish = ch.finish_reason;
          } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) answer.note = '⚠ ' + e.message;
    } finally {
      c.busy = null;
      if (!answer.note) {
        answer.note = ac.signal.aborted ? '(stopped)'
          : finish === 'length' ? (answer.content ? '(cut off at the length limit)' : thinking ? '(no answer: the model was still thinking when it reached the length limit)' : '(no answer within the length limit)')
            : answer.content ? '' : '(no answer)';
      }
      paintChat();
      const stop = document.getElementById('lai-stop'); if (stop) stop.hidden = true;
      const sendBtn = document.getElementById('lai-send'); if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ── System ─────────────────────────────────────────────────────────────────
  async function renderSystem(container) {
    try { await loadStatus(); } catch (e) { /* the browser half still shows, and the server's says it can't be reached */ }
    const rt = st.runtimes;
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
      row('Memory', size(h.memory.total) + (h.memory.available != null ? ' (' + size(h.memory.available) + ' available)' : '')) +
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
    show(container, '<div class="lai"><div class="lai-sys">' + browser + server + '</div>' + runtimes + '</div>');
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  // One listener for each kind of event on a page's root, and on the Details modal's wrapper: an element that a
  // repaint replaced still answers, and each press is handled once
  function delegate(root) {
    root.addEventListener('click', e => {
      const hit = sel => { const el = e.target.closest(sel); return el && root.contains(el) ? el : null; };
      const tab = hit('.lai-tab');
      if (tab) { st.tab = tab.dataset.tab; return paintBody(); }
      const f = hit('[data-filter]');
      if (f) { st[f.dataset.filter] = f.dataset.value; st.shown = 30; return paintBody(); }
      const a = hit('[data-act]');
      if (a) { e.preventDefault(); act(a.dataset.act, a.dataset.model || a.dataset.name, a); }
    });
    root.addEventListener('input', e => {
      if (e.target.id !== 'lai-q') return;
      st.query = e.target.value; st.shown = 30;
      const pos = e.target.selectionStart;
      paintBody();
      const q = document.getElementById('lai-q');
      if (q) { q.focus(); q.setSelectionRange(pos, pos); }
    });
    root.addEventListener('change', e => {
      if (e.target.id === 'lai-sort') { st.sort = e.target.value; return paintBody(); }
      if (e.target.matches('select[data-feature]')) featureModel(e.target);
    });
  }
  async function act(what, model, el) {
    try {
      if (what === 'install') { await api('POST', '/installs', { model }); App.notify('Installing ' + model + '…', 'info'); return; }
      if (what === 'pause' || what === 'resume' || what === 'cancel') { await api('POST', '/installs/' + what, { model }); return; }
      if (what === 'details') return showDetails(model);
      if (what === 'more') { st.shown += 30; return paintBody(); }
      if (what === 'refresh') { const c = await api('GET', '/catalog?refresh=1'); st.catalog = c; st.recs = await api('GET', '/recommendations'); App.notify(c.problem || 'The catalog is up to date.', c.problem ? 'warning' : 'success', 6000); return App.navigate('model-store'); }
      if (what === 'token') {
        const v = ((document.getElementById('lai-token') || {}).value || '').trim();
        const bad = tokenProblem(v);
        if (bad) return App.notify(bad, 'error', 9000);
        try { localStorage.setItem(TOKEN_KEY, v); } catch (e) { return App.notify('This browser won\'t keep the token (private browsing?).', 'error', 7000); }
        return App.navigate(location.hash.slice(1));
      }
      if (what === 'forget-token') { forgetToken(); App.notify('The admin token was removed from this browser.', 'info'); return App.navigate(location.hash.slice(1)); }
      if (what === 'default') {
        App.setState({ settings: Object.assign({}, App.getState().settings, { model: el.dataset.id || 'ollama/' + model }) });
        App.notify(model + ' is now the default model in this browser.', 'success');
        return paintInstalled();
      }
      if (what === 'load' || what === 'unload') { el.disabled = true; st.installed = await api('POST', '/models/' + what, { model }); return paintInstalled(); }
      if (what === 'update') { await api('POST', '/models/update', { model }); App.notify('Checking ' + model + ' for an update…', 'info'); return; }
      if (what === 'settings') return modelSettings(model);
      if (what === 'delete') {
        const m = ((st.installed && st.installed.models) || []).find(x => lc(x.name) === lc(model)) || {};
        const same = sameFiles(m);
        App.openModal('Delete ' + model + '?', '<p>' + (same.length
          ? esc(model) + ' has the same files as ' + esc(same.join(', ')) + ' (one model under ' + (same.length === 1 ? 'two names' : 'several names') + '). Deleting it removes only this name, and frees no disk space while ' + esc(same.join(', ')) + (same.length === 1 ? ' stays.' : ' stay.')
          : 'It is removed from this computer (' + size(m.size) + ').') + ' You can install it again from the AI Model Store.</p>',
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
