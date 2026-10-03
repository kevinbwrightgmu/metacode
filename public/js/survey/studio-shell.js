/* ══════════════════════════════════════════════
   studio-shell.js — the standalone Survey Studio page (studio.html)

   Survey Studio runs on its own page, opened from MetaCode's front page.
   This file gives it the few things it used to borrow from the main app
   (app.js): dialogs, notifications, CSV download, and access to the
   MetaCode project in this browser (for "Add text answers to project").
   Routes: studio.html# (list) · #<surveyId> · #<surveyId>/<mode>
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const STORAGE_KEY = 'strata_v1';   // the MetaCode project (same key as app.js)
  const DEFAULT_STATE = {
    project: { name: 'Untitled Project', description: '' }, posts: [], codebook: [], network: { nodes: [], edges: [] },
    networkAnalysis: null, settings: { provider: 'groq', apiKeys: [], model: 'openai/gpt-oss-20b', delay: 500 }
  };

  function readState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { s = null; }
    const out = Object.assign({}, DEFAULT_STATE, s && typeof s === 'object' ? s : {});
    if (!Array.isArray(out.posts)) out.posts = [];
    return out;
  }

  let viewCleanup = null;
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const App = {
    openModal(title, bodyHTML, footerHTML) {
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').innerHTML = bodyHTML;
      document.getElementById('modal-foot').innerHTML = footerHTML || '';
      document.getElementById('modal-backdrop').classList.add('is-open');
    },
    closeModal() {
      document.getElementById('modal-backdrop').classList.remove('is-open');
      document.getElementById('modal-body').innerHTML = '';
      document.getElementById('modal-foot').innerHTML = '';
    },
    notify(message, type, duration) {
      const stack = document.getElementById('notif-stack');
      const el = document.createElement('div');
      el.className = 'notif ' + (type || 'info');
      el.textContent = message;
      stack.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; el.style.transition = 'all .3s'; setTimeout(() => el.remove(), 320); }, duration || 3200);
    },
    esc,
    downloadCSV(filename, headers, rows) {
      const c = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const blob = new Blob([[headers.map(c).join(',')].concat(rows.map(r => r.map(c).join(','))).join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    // The MetaCode project lives in this browser's storage; read it fresh each time
    // so posts added in another tab aren't overwritten.
    getState: readState,
    setState(patch) {
      const s = Object.assign(readState(), patch);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { App.notify('The project couldn\'t be saved in this browser.', 'error'); }
    },
    setViewCleanup(fn) { viewCleanup = fn; }
  };
  root.App = App;

  let lastId = null;
  function route() {
    const param = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const id = param.split('/')[0];
    // Leaving a survey: flush its autosave and remove its listeners
    if (id !== lastId && viewCleanup) { const fn = viewCleanup; viewCleanup = null; try { fn(); } catch (e) { console.error(e); } }
    lastId = id;
    document.body.classList.toggle('is-editing', !!id);
    SurveyStudio.render(param);   // global from survey-studio.js
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('modal-close').addEventListener('click', App.closeModal);
    document.getElementById('modal-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) App.closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('modal-backdrop').classList.contains('is-open')) App.closeModal(); });
    window.addEventListener('hashchange', route);
    route();
  });
})(window);
