/* ══════════════════════════════════════════════
   lab-core.js — the AI Coding Lab's shell

   Access check, API client, hash router, project picker, modal and toasts.
   The server decides everything about access (GET /api/lab/access and every
   API call); this page only shows what it was told. Views live in
   lab-views.js, lab-experiments.js, lab-workbench.js, lab-training.js and
   lab-evals.js and register themselves with Lab.view(name, render).
   ══════════════════════════════════════════════ */

const Lab = (() => {
  'use strict';
  const API = '/api/lab';
  const VIEWS = {};
  const TITLES = { overview: 'Overview', projects: 'Projects', project: 'Project', workbench: 'AI Workbench', profiles: 'Coding Profiles', profile: 'Coding Profile',
    knowledge: 'Knowledge Base', training: 'Training Studio', dataset: 'Dataset', evaluations: 'Evaluations', suite: 'Evaluation Suite', run: 'Evaluation Run',
    compare: 'Comparison', models: 'Models', usage: 'Usage', docs: 'Documentation', finetune: 'Fine-tuning', experiments: 'Code Experiments', experiment: 'Code Experiment' };
  const NAV_OF = { project: 'projects', profile: 'profiles', dataset: 'training', finetune: 'training', suite: 'evaluations', run: 'evaluations', compare: 'evaluations', experiment: 'experiments' };
  const state = { access: null, projects: [], projectId: null, models: null, cleanup: [] };

  const $ = id => document.getElementById(id);
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = n => (n === null || n === undefined || !isFinite(n) ? '—' : Number(n).toLocaleString());
  const pct = x => (x === null || x === undefined ? '—' : (Math.round(x * 1000) / 10) + '%');
  const when = iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const ms = v => (v === null || v === undefined ? '—' : v < 1000 ? Math.round(v) + ' ms' : (v / 1000).toFixed(1) + ' s');
  const money = c => (!c || c.basis === 'unknown' || c.amount === null ? 'unknown' : '≈ ' + (c.currency || '') + ' ' + c.amount.toFixed(c.amount < 0.01 ? 4 : 2) + (c.pricingAsOf ? ' (prices as of ' + c.pricingAsOf + ')' : ''));

  /* ── API ─────────────────────────────────── */
  class ApiError extends Error { constructor(status, body) { super((body && body.error && body.error.message) || 'The server answered HTTP ' + status + '.'); this.status = status; this.type = body && body.error && body.error.type; this.body = body; } }
  async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(API + path, init);
    if (opts.raw) return res;
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const err = new ApiError(res.status, body);
      if (res.status === 401 || res.status === 402) { state.access = null; checkAccess(); }
      throw err;
    }
    return body;
  }
  const get = p => api(p);
  const post = (p, body) => api(p, { method: 'POST', body: body || {} });
  const put = (p, body) => api(p, { method: 'PUT', body: body || {} });
  const patch = (p, body) => api(p, { method: 'PATCH', body: body || {} });
  const del = (p, body) => api(p, { method: 'DELETE', body });
  // Downloads go through fetch too, so the session cookie (not a URL token) authorises them
  async function download(path, fallbackName) {
    try {
      const res = await api(path, { raw: true });
      if (!res.ok) { let b = null; try { b = await res.json(); } catch (e) { b = null; } throw new ApiError(res.status, b); }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName || 'download';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { notify(e.message, 'error'); }
  }

  /* ── Toasts and modal ────────────────────── */
  function notify(message, type, duration) {
    const stack = $('notif-stack');
    const el = document.createElement('div');
    el.className = 'notif ' + (type || 'info');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, duration || 3600);
  }
  let lastFocus = null;
  function openModal(title, bodyHTML, footerHTML) {
    lastFocus = document.activeElement;
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = bodyHTML;
    $('modal-foot').innerHTML = footerHTML || '';
    $('modal-backdrop').classList.add('is-open');
    const first = $('modal').querySelector('input, select, textarea, button:not(.modal-x)');
    setTimeout(() => (first || $('modal-close')).focus(), 0);
  }
  function closeModal() {
    $('modal-backdrop').classList.remove('is-open');
    $('modal-body').innerHTML = ''; $('modal-foot').innerHTML = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function confirmDanger(title, text, label) {
    return new Promise(resolve => {
      openModal(title, '<p class="lab-second">' + esc(text) + '</p>', '<button class="btn btn-secondary" id="lab-c-no">Cancel</button><button class="btn btn-danger" id="lab-c-yes">' + esc(label || 'Delete') + '</button>');
      $('lab-c-no').onclick = () => { closeModal(); resolve(false); };
      $('lab-c-yes').onclick = () => { closeModal(); resolve(true); };
    });
  }
  // Runs an action, showing errors; disables the button meanwhile
  async function act(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { notify(e.message, 'error', 6000); return undefined; } finally { if (btn) btn.disabled = false; }
  }

  /* ── Access ──────────────────────────────── */
  async function checkAccess() {
    try { state.access = await (await fetch(API + '/access', { credentials: 'same-origin' })).json(); }
    catch (e) { state.access = { allowed: false, reason: { type: 'offline', message: 'The MetaCode server couldn\'t be reached.' } }; }
    applyAccess();
  }
  function applyAccess() {
    const ok = !!(state.access && state.access.allowed);
    $('lab-nav').hidden = !ok;
    $('lab-project-pick').hidden = !ok;
    if (!ok) { renderGate(); return; }
    loadProjects().then(() => route());
    loadModels();
  }
  function renderGate() {
    const a = state.access || {};
    const r = a.reason || {};
    $('lab-title').textContent = 'AI Coding Lab';
    const signIn = r.type === 'sign_in_required' || r.type === 'no_identity';
    const upgrade = r.type === 'plan_required';
    $('lab-main').innerHTML = '<div class="lab-gate"><h2>' + (signIn ? 'Sign in to use the AI Coding Lab' : upgrade ? 'The AI Coding Lab is part of Ultra' : 'The AI Coding Lab isn\'t available') + '</h2>' +
      '<p>' + esc(r.message || '') + '</p>' +
      '<ul><li>Coding assistants configured with your project\'s conventions</li><li>Project knowledge bases with retrieval</li><li>Evaluation datasets, repeatable runs and comparisons</li><li>Measured, versioned prompt improvements — and fine-tuning where a provider supports it</li></ul>' +
      '<div class="lab-actions">' + (signIn ? '<button class="btn btn-primary" id="lab-g-signin">Sign in</button>' : '') +
      (upgrade || signIn ? '<button class="btn ' + (signIn ? 'btn-secondary' : 'btn-primary') + '" id="lab-g-plans">See plans</button>' : '') +
      '<a class="btn btn-secondary" href="/app.html">Back to MetaCode</a></div></div>';
    const s = $('lab-g-signin'), p = $('lab-g-plans');
    if (s) s.onclick = () => window.Account && Account.openSignIn({ reason: 'Sign in to use the AI Coding Lab.' });
    if (p) p.onclick = () => window.Account && Account.openPlans({ highlight: 'ultra' });
  }

  /* ── Projects and models ─────────────────── */
  async function loadProjects() {
    try { state.projects = (await get('/projects')).projects; } catch (e) { state.projects = []; }
    let saved = null;
    try { saved = localStorage.getItem('metacode.lab.project'); } catch (e) { saved = null; }
    if (!state.projects.some(p => p.id === state.projectId)) state.projectId = state.projects.some(p => p.id === saved) ? saved : (state.projects[0] ? state.projects[0].id : null);
    renderProjectPick();
  }
  function renderProjectPick() {
    const sel = $('lab-project');
    sel.innerHTML = '<option value="">No project</option>' + state.projects.map(p => '<option value="' + esc(p.id) + '"' + (p.id === state.projectId ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
  }
  function setProject(id) {
    state.projectId = id || null;
    try { localStorage.setItem('metacode.lab.project', state.projectId || ''); } catch (e) { /* private window */ }
    renderProjectPick();
    route();
  }
  const project = () => state.projects.find(p => p.id === state.projectId) || null;
  async function loadModels(force) {
    if (state.models && !force) return state.models;
    try { state.models = await get('/models'); } catch (e) { state.models = { providers: [], pricing: {}, notes: {} }; }
    const def = defaultModel();
    const chip = $('lab-model-chip');
    chip.hidden = !def;
    if (def) { chip.textContent = modelName(def.provider, def.model); chip.title = 'The model new conversations start with: ' + modelLabel(def.provider, def.model); }
    return state.models;
  }
  function defaultModel() {
    const p = project();
    if (p && p.defaultModel) return p.defaultModel;
    const provs = (state.models && state.models.providers) || [];
    for (const pr of provs) { const m = pr.models.find(x => x.isDefault) || pr.models[0]; if (m) return { provider: pr.provider, model: m.id }; }
    return null;
  }
  // A model's name from the model list ("Claude Opus 5.5"). One the list
  // doesn't have shows its id — for MetaCode's AI service, whose ids are
  // "provider/model", without the provider part.
  function modelName(provider, id) {
    const provs = (state.models && state.models.providers) || [];
    for (const p of provs.filter(x => x.provider === provider).concat(provs.filter(x => x.provider !== provider))) {
      const m = p.models.find(x => x.id === id);
      if (m && m.name && m.name !== id) return m.name;
    }
    return modelId(provider, id);
  }
  // A model's id as pages show it (MetaCode's AI service's without the provider part)
  function modelId(provider, id) {
    const s = String(id || ''), i = s.indexOf('/');
    return (!provider || provider === 'metacode') && i > 0 ? s.slice(i + 1) : s;
  }
  // "MetaCode AI service · Claude Opus 5.5"
  function modelLabel(provider, id) {
    const p = ((state.models && state.models.providers) || []).find(x => x.provider === provider);
    return (p && p.label ? p.label : provider) + ' · ' + modelName(provider, id);
  }
  // <option>s for every available model, "provider|model"
  function modelOptions(selected) {
    const provs = (state.models && state.models.providers) || [];
    return provs.filter(p => p.models.length).map(p => '<optgroup label="' + esc(p.label) + '">' + p.models.map(m => {
      const v = p.provider + '|' + m.id;
      return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(modelName(p.provider, m.id)) + (m.isDefault ? ' (default)' : '') + '</option>';
    }).join('') + '</optgroup>').join('') || '<option value="">No models available</option>';
  }

  /* ── Router ──────────────────────────────── */
  function view(name, render) { VIEWS[name] = render; }
  function go(hash) { if (location.hash === '#' + hash) route(); else location.hash = hash; }
  // Each render gets its own host element: a slower, older render (navigating
  // twice quickly) writes into a detached host and never over the newer view.
  // Views check main.isConnected after their requests.
  let routeSeq = 0;
  function route() {
    if (!state.access || !state.access.allowed) return;
    state.cleanup.splice(0).forEach(fn => { try { fn(); } catch (e) { /* */ } });
    const raw = location.hash.slice(1) || 'overview';
    const [name, ...params] = raw.split('/').map(decodeURIComponent);
    const v = VIEWS[name] ? name : 'overview';
    document.querySelectorAll('#lab-nav .nav-item').forEach(a => {
      const on = a.dataset.view === (NAV_OF[v] || v);
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('lab-title').textContent = TITLES[v] || 'AI Coding Lab';
    document.title = (TITLES[v] || 'AI Coding Lab') + ' — AI Coding Lab';
    $('lab-shell').classList.remove('nav-open');
    const seq = ++routeSeq;
    const host = document.createElement('div');
    host.className = 'lab-view';
    host.innerHTML = '<div class="loading-state">Loading…</div>';
    $('lab-main').replaceChildren(host);
    Promise.resolve().then(() => VIEWS[v](host, params)).catch(e => {
      if (seq !== routeSeq || (e && (e.status === 401 || e.status === 402))) return;
      host.innerHTML = '<div class="lab-error" role="alert">' + esc(e && e.message || 'Something went wrong.') + '</div>';
    });
  }
  // For renders that aren't awaited by the router (tabs, refreshes): errors become a notice
  function background(promise) {
    Promise.resolve(promise).catch(e => { if (!(e && (e.status === 401 || e.status === 402))) notify(e && e.message || 'Something went wrong.', 'error', 6000); });
  }
  // Runs fn when the user leaves the current view (timers, streams)
  function onLeave(fn) { state.cleanup.push(fn); }

  function start() {
    $('modal-close').onclick = closeModal;
    $('modal-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('modal-backdrop').classList.contains('is-open')) closeModal(); });
    $('lab-project').onchange = e => setProject(e.target.value);
    $('lab-menu').onclick = () => { const open = $('lab-shell').classList.toggle('nav-open'); $('lab-menu').setAttribute('aria-expanded', String(open)); };
    window.addEventListener('hashchange', route);
    if (window.Account) {
      Account.mountChip($('lab-account'));
      let seen = null;
      Account.onChange(me => { const k = me ? (me.signedIn ? me.user.id + ':' + me.plan.id : 'out') : 'none'; if (k !== seen) { seen = k; checkAccess(); } });
    } else checkAccess();
  }

  // A small form helper: values of [name] fields inside an element
  function formValues(root) {
    const out = {};
    root.querySelectorAll('[name]').forEach(el => {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    });
    return out;
  }
  // Reads a File as text (knowledge documents, dataset imports)
  const readText = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('Couldn\'t read ' + file.name)); r.readAsText(file); });

  return {
    start, view, go, route, onLeave, background, api, get, post, put, patch, del, download, notify, openModal, closeModal, confirmDanger, act,
    esc, fmt, pct, when, ms, money, formValues, readText, $, state, project, setProject, loadProjects, loadModels, modelOptions, modelName, modelId, modelLabel, defaultModel, ApiError
  };
})();
