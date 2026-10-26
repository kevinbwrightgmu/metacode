/* ══════════════════════════════════════════════
   lab-experiments.js — Code Experiments

   A user picks a variable — a Codebook dimension of the MetaCode project
   open in this browser (read-only, from localStorage['strata_v1']; this page
   never writes it) or a Training Studio dataset — and the server snapshots
   the records into a read-only sandbox. In the workspace an AI writes a
   coding rule, classify(record, variable); every save is an immutable
   version. Running a version happens on the server only: input checks, AI
   security review, deterministic policy, the isolated sandbox, output
   validation and metrics. This page shows what the server measured: the
   terminal polls the run's real log, the preview is built from the validated
   results endpoint (as text — never HTML from results), and no code ever
   runs in the browser. The final version goes to the Codebook through the
   main app (BroadcastChannel 'metacode-lab', else /app.html#codebook/lab/<id>),
   which asks the user to confirm before it saves anything.

   Views: experiments (list, #experiments/new[/<dimensionId>]),
   experiment (#experiment/<id>, #experiment/<id>/compare/<a>/<b>).
   ══════════════════════════════════════════════ */

(() => {
  'use strict';
  const { esc, fmt, pct, when, get, post, patch, del, notify, openModal, closeModal, confirmDanger, $ } = Lab;
  const field = (l, c) => Lab.field(l, c);

  /* ── Constants ──────────────────────────────── */
  const LANGS = ['javascript', 'python', 'typescript'];
  const LANG_LABEL = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python' };
  const ORIGIN = { generated: ['AI-generated', 'badge-violet'], edited: ['User-edited', 'badge-teal'], duplicated: ['Duplicated', 'badge-gray'], reverted: ['Reverted', 'badge-amber'], imported: ['Imported', 'badge-blue'] };
  const ACTIVE = ['queued', 'running'];
  // The status pill (#xp-state): exactly these texts
  const STATE = {
    empty: ['Empty workspace', 'gray'], generating: ['Generating code…', 'violet'], generated: ['Code generated', 'violet'], reviewing: ['Reviewing…', 'violet'],
    blocked: ['Blocked — see the review', 'red'], ready: ['Ready to run', 'blue'], dirty: ['Edited — save to run', 'amber'], running: ['Running…', 'blue'],
    succeeded: ['Run succeeded', 'green'], failed: ['Run failed', 'red'], cancelled: ['Run cancelled', 'amber'], interrupted: ['Run interrupted — run it again', 'amber'],
    results: ['Results ready', 'green'], comparing: ['Comparing versions', 'blue'],
    final: ['Final version selected', 'teal'], sending: ['Sending to Codebook…', 'blue'], saved: ['Saved to Codebook', 'green'], sendFailed: ['Saving to Codebook failed', 'red']
  };
  const ID_RE = /^[a-z0-9_-]{1,64}$/i;               // variable and code ids (as the Codebook handoff checks them)
  const RECORD_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
  const LIMITS = { records: 5000, text: 20000, author: 200, codes: 50, name: 120, description: 2000, label: 120, codeDescription: 1000, prompt: 4000 };
  const NONE = '(none)';
  const PAGE = 25;
  const POLL_MS = 600;
  const SEND_POLL_MS = 2000, SEND_WAIT_MS = 10 * 60 * 1000, ACK_MS = 1200;
  // Metric definitions (the server's ai-lab/experiment-metrics.js metricDefinitions, shown next to the numbers)
  const DEFS = {
    accuracy: ['Accuracy', 'higher', 'Share of records with a reference label where the rule\'s code equals that label. A record with no code or an error counts as wrong. Held-out accuracy uses only test records, which the AI never saw.'],
    macroF1: ['Macro-F1', 'higher', 'The F1 score of each code, averaged over the codes that appear in the reference labels, so rare codes count as much as common ones. A code that is never predicted scores 0.'],
    kappa: ['Cohen\'s κ', 'higher', 'Agreement with the reference labels corrected for the agreement expected by chance: 1 is perfect, 0 is chance level, below 0 is worse than chance. "No code" counts as its own category.'],
    coverage: ['Coverage', 'higher', 'Share of processed records that got a code (not "no code" and not an error).'],
    errorRate: ['Error rate', 'lower', 'Share of processed records where classify threw an error.'],
    baselineAgreement: ['Agreement with current AI coding', 'higher', 'Share of records (with a current AI Coding label) where the rule gives the same code as MetaCode\'s current AI coding. This is agreement, not accuracy: the current AI coding can be wrong too.'],
    consistency: ['Consistency', 'higher', 'Among groups of two or more records with the same text (ignoring case, links and punctuation), the share of groups where every record got the same code. Not measured when no text repeats.'],
    runtime: ['Runtime', 'lower', 'Time the sandbox spent running the rule on all records, and the mean time per record when the engine reported it. Shown, not scored.'],
    precision: ['Precision', 'higher', 'Of the records the rule gave this code, the share whose reference label is this code. Not measured when the rule never used the code.'],
    recall: ['Recall', 'higher', 'Of the records whose reference label is this code, the share the rule gave this code. Not measured when no reference label uses the code.'],
    f1: ['F1', 'higher', 'The harmonic mean of precision and recall for one code (2·TP / (2·TP + FP + FN)); 0 when the code has reference labels but was never predicted correctly.'],
    confusion: ['Confusion matrix', null, 'Rows are reference labels, columns are the rule\'s codes; each cell counts the records with that pair. The diagonal is agreement.'],
    objectiveScore: ['Objective score', 'higher', 'The weighted mean of your success criteria, each scaled to 0–1 (κ as (κ+1)/2, error rate as 1 − error rate). Reference metrics use held-out records when there are any. Criteria that can\'t be measured are left out and listed.'],
    heldOut: ['Held-out records', null, 'About 70% of the sandbox records (the test split) are never shown to the AI. Scores on them show how the rule does on records it wasn\'t written from.']
  };
  const BASE_METRICS = ['accuracy', 'macroF1', 'kappa', 'coverage', 'errorRate', 'baselineAgreement', 'consistency'];
  const DEFAULT_CRITERIA = [{ metric: 'macroF1', weight: 3 }, { metric: 'coverage', weight: 1 }, { metric: 'consistency', weight: 1 }];
  const CONSTRAINTS = 'The rule runs in an isolated sandbox: no network, files or programs, no timers, and it must be deterministic. JavaScript and TypeScript have no imports or require. Python can import only standard-library modules: re, math, statistics, string, collections, itertools, functools, operator, json, unicodedata, datetime, typing, dataclasses, enum, heapq, bisect, decimal, fractions, difflib, textwrap, html, copy, numbers, abc (random is allowed but makes results vary).';
  const PLACEHOLDER = 'Describe the rule, e.g.\n“Code a post as negative when it criticises the policy, including sarcasm.”\n“Treat posts that only share a link as no code.”\nor ask: “Why does v2 miss neutral posts?”';

  /* ── Small helpers ──────────────────────────── */
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const dec = (v, d) => (num(v) === null ? '—' : v.toFixed(d === undefined ? 2 : d));
  const str = v => (typeof v === 'string' ? v : '');
  const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const shortHash = h => esc(String(h || '').replace(/^sha256:/, '').slice(0, 10));
  const bytes = n => (num(n) === null ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : (many || one + 's'));
  const langLabel = l => LANG_LABEL[l] || String(l || '');
  const splitLabel = s => (s === 'test' ? 'held-out records' : s === 'dev' ? 'dev records' : 'all records');
  const runBadge = s => '<span class="badge ' + ({ succeeded: 'badge-green', running: 'badge-blue', queued: 'badge-gray', failed: 'badge-red', blocked: 'badge-red', cancelled: 'badge-amber', interrupted: 'badge-amber' }[s] || 'badge-gray') + '">' + esc(String(s || '—').replace(/_/g, ' ')) + '</span>';
  const originBadge = o => '<span class="badge ' + (ORIGIN[o] ? ORIGIN[o][1] : 'badge-gray') + '">' + esc(ORIGIN[o] ? ORIGIN[o][0] : o) + '</span>';
  const decisionBadge = d => '<span class="badge ' + ({ approved: 'badge-green', rejected: 'badge-red', needs_review: 'badge-amber', unavailable: 'badge-amber' }[d] || 'badge-gray') + '">' + esc({ approved: 'approved', rejected: 'rejected', needs_review: 'needs review', unavailable: 'unavailable' }[d] || 'not reviewed') + '</span>';
  const recBadge = r => '<span class="badge ' + ({ retain: 'badge-green', revise: 'badge-amber', reject: 'badge-red' }[r] || 'badge-gray') + '">' + esc(r || '—') + '</span>';
  const md = text => LabMarkdown.render(text || '');
  const sortRuns = runs => (Array.isArray(runs) ? runs.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)) : []);
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64); }
  // What this server can run (/models → execution): its mode, and language → reason for the languages it can't run
  function execution() {
    const ex = Lab.state.models && Lab.state.models.execution;
    const unavailable = {};
    (ex && Array.isArray(ex.unavailable) ? ex.unavailable : []).forEach(u => { if (u && LANGS.includes(u.language)) unavailable[u.language] = str(u.reason) || 'It can\'t run on this server.'; });
    return { off: !!(ex && ex.mode === 'off'), unavailable };
  }
  // <option>s of the languages; the ones this server can't run are disabled, with the reason
  function langOptions(unavailable, suffix) {
    return LANGS.map(l => '<option value="' + l + '"' + (unavailable[l] ? ' disabled title="' + esc(unavailable[l]) + '"' : '') + '>' + LANG_LABEL[l] + (unavailable[l] ? ' (can\'t run here)' : suffix ? suffix(l) : '') + '</option>').join('');
  }
  function storageGet(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
  function storageSet(store, key, value) { try { if (value === null) window[store].removeItem(key); else window[store].setItem(key, value); } catch (e) { /* private window */ } }

  // Code chips: one colour per code (by its index in the variable), grey for "no code"
  function codeIndex(variable, code) { return variable && Array.isArray(variable.codes) ? variable.codes.findIndex(c => c.id === code) : -1; }
  function codeName(variable, code) {
    if (code === null || code === undefined || code === NONE) return 'no code';
    const c = variable && variable.codes ? variable.codes.find(x => x.id === code) : null;
    return c ? c.label || c.id : String(code);
  }
  function chip(variable, code, prefix) {
    const none = code === null || code === undefined || code === NONE;
    const i = none ? -1 : codeIndex(variable, code);
    return '<span class="xp-chip ' + (none ? 'xp-c-none' : i < 0 ? 'xp-c-unknown' : 'xp-c' + (i % 10)) + '"' + (none ? '' : ' title="' + esc(code) + '"') + '>' + (prefix ? esc(prefix) : '') + esc(codeName(variable, code)) + '</span>';
  }

  // The reference scores used for headline numbers: held-out (test) when it has records, else all labelled ones
  function scoringRef(m) {
    if (!m || !m.reference) return null;
    const r = m.reference;
    if (r.test && r.test.n >= 1) return { s: r.test, split: 'test' };
    return r.all ? { s: r.all, split: 'all' } : null;
  }
  // The objective score: the same formula as the server's scoreRun (experiment-metrics.js), from measured metrics only
  function metricValue(m, metric) {
    if (!m) return null;
    const ref = scoringRef(m), s = ref ? ref.s : null;
    switch (metric) {
      case 'accuracy': return s ? num(s.accuracy) : null;
      case 'macroF1': return s ? num(s.macroF1) : null;
      case 'kappa': { const k = s ? num(s.kappa) : null; return k === null ? null : (k + 1) / 2; }
      case 'coverage': return num(m.coverage);
      case 'errorRate': { const e = num(m.errorRate); return e === null ? null : 1 - e; }
      case 'baselineAgreement': return m.baseline ? num(m.baseline.agreement) : null;
      case 'consistency': return m.consistency ? num(m.consistency.score) : null;
      case 'runtime': return null;
      default: {
        const x = /^(precision|recall|f1):(.+)$/.exec(metric);
        if (!x || !s || !s.perCode || !Object.prototype.hasOwnProperty.call(s.perCode, x[2])) return null;
        return num(s.perCode[x[2]][x[1]]);
      }
    }
  }
  function scoreRun(m, criteria) {
    const parts = [], missing = [];
    let sum = 0, weights = 0;
    (Array.isArray(criteria) ? criteria : []).forEach(c => {
      const weight = num(c.weight) !== null && c.weight > 0 ? c.weight : 0;
      const value = metricValue(m, c.metric);
      const used = value !== null && weight > 0;
      if (used) { sum += weight * value; weights += weight; }
      if (value === null && c.metric !== 'runtime') missing.push(c.metric);
      parts.push({ metric: c.metric, weight, value, used });
    });
    return { score: weights > 0 ? sum / weights : null, parts, missing };
  }
  function metricLabel(metric, variable) {
    const x = /^(precision|recall|f1):(.+)$/.exec(metric);
    if (x) return DEFS[x[1]][0] + ' of “' + codeName(variable, x[2]) + '”';
    return DEFS[metric] ? DEFS[metric][0] : metric;
  }

  // Waits for lab-editor.mjs (CodeMirror) up to 4 s; null → the plain textarea editor
  let editorGaveUp = false;
  function editorReady() {
    if (window.LabEditor) return Promise.resolve(window.LabEditor);
    if (editorGaveUp || window.LabEditorFailed) return Promise.resolve(null);
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(t); window.removeEventListener('lab-editor-ready', done); window.removeEventListener('lab-editor-failed', done);
        if (!window.LabEditor) editorGaveUp = true;
        resolve(window.LabEditor || null);
      };
      const t = setTimeout(done, 4000);
      window.addEventListener('lab-editor-ready', done);
      window.addEventListener('lab-editor-failed', done);
    });
  }
  // The fallback editor: a textarea with a line-number gutter (the exact text is what gets saved)
  function fallbackEditor(parent, opts) {
    parent.innerHTML = '<div class="xp-fb"><pre class="xp-fb-gutter" aria-hidden="true"></pre><textarea class="xp-fallback" spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off" aria-label="' + esc(opts.label || 'Code editor') + '"></textarea></div>';
    const ta = parent.querySelector('textarea'), gutter = parent.querySelector('.xp-fb-gutter');
    let marks = new Map(), lang = opts.language || 'javascript', escaped = false;
    ta.value = String(opts.doc || '');
    ta.readOnly = !!opts.readOnly;
    const lines = () => ta.value.split('\n').length;
    function paint() {
      const n = lines();
      let out = '';
      for (let i = 1; i <= n; i++) { const m = marks.get(i); out += (m ? '<span class="xp-fb-' + m.severity + '" title="' + esc(m.message) + '">' + i + '</span>' : i) + '\n'; }
      gutter.innerHTML = out;
      gutter.scrollTop = ta.scrollTop;
    }
    ta.addEventListener('input', () => { paint(); if (opts.onChange) opts.onChange(ta.value); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    // Tab indents; Escape then Tab leaves the editor (as in CodeMirror)
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { escaped = true; return; }
      if (e.key === 'Tab' && !escaped && !ta.readOnly && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const unit = lang === 'python' ? '    ' : '  ';
        const s = ta.selectionStart, en = ta.selectionEnd;
        if (!e.shiftKey) { ta.setRangeText(unit, s, en, 'end'); ta.dispatchEvent(new Event('input')); }
        else {
          const start = ta.value.lastIndexOf('\n', s - 1) + 1;
          const lead = ta.value.slice(start, start + unit.length).match(/^ */)[0].length;
          if (lead) { ta.setRangeText('', start, start + lead, 'preserve'); ta.dispatchEvent(new Event('input')); }
        }
        return;
      }
      escaped = false;
    });
    paint();
    return {
      getValue: () => ta.value,
      setValue(text) { ta.value = String(text === undefined || text === null ? '' : text); ta.scrollTop = 0; paint(); },
      setLanguage(l) { lang = l; },
      setReadOnly(b) { ta.readOnly = !!b; },
      focus() { ta.focus(); },
      gotoLine(n) {
        const all = ta.value.split('\n');
        const i = Math.min(Math.max(1, Math.floor(Number(n) || 1)), all.length);
        const pos = all.slice(0, i - 1).reduce((p, l) => p + l.length + 1, 0);
        ta.focus(); ta.setSelectionRange(pos, pos);
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
        ta.scrollTop = Math.max(0, (i - 3) * lh);
      },
      setFindings(list) {
        marks = new Map();
        (Array.isArray(list) ? list : []).forEach(f => { const l = Math.floor(Number(f.line)); if (l >= 1 && (!marks.has(l) || f.severity === 'error')) marks.set(l, { severity: f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info', message: String(f.message || '') }); });
        paint();
      },
      destroy() { parent.innerHTML = ''; }
    };
  }
  async function makeEditor(parent, opts) {
    const LE = await editorReady();
    if (!parent.isConnected) return null;
    if (LE) {
      parent.innerHTML = '';
      try { return LE.create(parent, opts); } catch (e) { /* fall through to the textarea */ }
    }
    return fallbackEditor(parent, opts);
  }
  async function makeMerge(parent, a, b, language, labels) {
    const LE = await editorReady();
    if (!parent.isConnected) return null;
    if (LE) {
      parent.innerHTML = '';
      try { return LE.merge(parent, { a, b, language, labelA: labels[0], labelB: labels[1] }); } catch (e) { /* fall back */ }
    }
    parent.innerHTML = LabDiff.html(a, b);
    return null;
  }

  /* ── The open MetaCode project (read-only) ──── */
  function readOpenProject() {
    const raw = storageGet('localStorage', 'strata_v1');
    if (!raw) return { problem: 'none' };
    let s;
    try { s = JSON.parse(raw); } catch (e) { return { problem: 'unreadable' }; }
    if (!s || typeof s !== 'object') return { problem: 'unreadable' };
    return {
      name: (s.project && str(s.project.name).trim()) || 'Untitled Project',
      posts: Array.isArray(s.posts) ? s.posts.filter(p => p && typeof p === 'object') : [],
      codebook: Array.isArray(s.codebook) ? s.codebook.filter(d => d && typeof d === 'object') : []
    };
  }
  // Why a Codebook dimension can't be used as a variable (null: it can)
  function variableProblem(dim) {
    if (!ID_RE.test(String(dim.id === undefined ? '' : dim.id))) return 'Its id has characters the Lab can\'t use (letters, digits, _ and - only, at most 64).';
    const codes = Array.isArray(dim.codes) ? dim.codes : [];
    if (!codes.length) return 'It has no codes yet: add codes in the Codebook first.';
    if (codes.length > LIMITS.codes) return 'It has more than ' + LIMITS.codes + ' codes.';
    const ids = new Set();
    for (const c of codes) {
      const id = c && c.id !== undefined ? String(c.id) : '';
      if (!ID_RE.test(id)) return 'The code id “' + id.slice(0, 40) + '” has characters the Lab can\'t use.';
      if (ids.has(id)) return 'Two of its codes share the id “' + id + '”.';
      ids.add(id);
    }
    return null;
  }
  function variableOf(dim) {
    return {
      id: String(dim.id), name: cut(str(dim.name).trim() || String(dim.id), LIMITS.name), description: cut(str(dim.description), LIMITS.description),
      codes: dim.codes.map(c => ({ id: String(c.id), label: cut(str(c.label).trim() || String(c.id), LIMITS.label), description: cut(str(c.description), LIMITS.codeDescription) }))
    };
  }
  // spec §9.1: reference = adjudicated, else agreed coder 1 = coder 2, else coder 1, else coder 2; baseline = AI Coding. Non-codes → null.
  function labelsOf(p, dimId, codes) {
    const ok = v => (typeof v === 'string' && codes.has(v) ? v : null);
    const adj = p.adjudicated && typeof p.adjudicated === 'object' ? p.adjudicated[dimId] : null;
    const a = ok(adj && typeof adj === 'object' ? adj.code : null);
    const h = ok(p.humanCodes && typeof p.humanCodes === 'object' ? p.humanCodes[dimId] : null);
    const c2 = ok(p.coder2Codes && typeof p.coder2Codes === 'object' ? p.coder2Codes[dimId] : null);
    const ai = p.aiCodes && typeof p.aiCodes === 'object' && p.aiCodes[dimId] && typeof p.aiCodes[dimId] === 'object' ? ok(p.aiCodes[dimId].code) : null;
    const ref = a ? [a, 'adjudicated'] : h && c2 && h === c2 ? [h, 'agreed'] : h ? [h, 'coder1'] : c2 ? [c2, 'coder2'] : [null, null];
    return { reference: ref[0], referenceSource: ref[1], baseline: ai };
  }
  function postId(p) { return typeof p.id === 'number' && Number.isFinite(p.id) ? String(p.id) : typeof p.id === 'string' ? p.id.trim() : ''; }
  function dimStats(project, dim) {
    const codes = new Set((dim.codes || []).map(c => String(c && c.id)));
    let records = 0, labelled = 0, ai = 0;
    project.posts.forEach(p => {
      if (!RECORD_ID_RE.test(postId(p))) return;
      records++;
      const l = labelsOf(p, String(dim.id), codes);
      if (l.reference) labelled++;
      if (l.baseline) ai++;
    });
    return { records, labelled, ai };
  }
  // The sandbox records of a dimension, built here (spec §9.1). At most 5,000; long texts cut as the server would.
  function recordsOf(project, dim) {
    const codes = new Set(dim.codes.map(c => String(c.id)));
    let cutTexts = 0;
    const records = project.posts.slice(0, LIMITS.records).map(p => {
      const meta = {};
      const platform = p.source && typeof p.source === 'object' && typeof p.source.platform === 'string' ? p.source.platform : typeof p.platform === 'string' ? p.platform : null;
      if (platform) meta.platform = platform.slice(0, 200);
      const eng = p.engagement && typeof p.engagement === 'object' ? p.engagement : {};
      ['likes', 'shares', 'comments'].forEach(k => { if (num(eng[k]) !== null) meta[k] = eng[k]; });
      const text = typeof p.text === 'string' ? p.text : p.text === undefined || p.text === null ? '' : String(p.text);
      if (text.length > LIMITS.text) cutTexts++;
      const r = { id: postId(p) || String(p.id === undefined ? '' : p.id), text: cut(text, LIMITS.text), author: cut(str(p.author), LIMITS.author),
        timestamp: typeof p.timestamp === 'string' ? p.timestamp.slice(0, 40) : num(p.timestamp) !== null ? String(p.timestamp) : '', meta };
      const l = labelsOf(p, String(dim.id), codes);
      r.reference = l.reference; r.referenceSource = l.referenceSource; r.baseline = l.baseline;
      return r;
    });
    return { records, cutTexts, skipped: Math.max(0, project.posts.length - LIMITS.records) };
  }
  // The Codebook's current rule on a dimension, when it can seed version 1
  function codebookRule(dim) {
    const r = dim && dim.codingRule;
    if (!r || typeof r !== 'object' || typeof r.code !== 'string' || !r.code.trim() || !LANGS.includes(r.language)) return null;
    return { code: r.code, language: r.language, version: Number.isInteger(r.version) ? r.version : null };
  }

  /* ── Success criteria editor ────────────────── */
  function metricOptions(selected, variable) {
    const opt = (v, l) => '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(l) + '</option>';
    const codes = variable && Array.isArray(variable.codes) ? variable.codes : [];
    return BASE_METRICS.map(m => opt(m, DEFS[m][0] + (m === 'accuracy' ? ' (held-out)' : m === 'errorRate' ? ' (lower is better)' : ''))).join('') +
      (codes.length ? '<optgroup label="Per code">' + codes.map(c => ['f1', 'precision', 'recall'].map(k => opt(k + ':' + c.id, DEFS[k][0] + ' of “' + (c.label || c.id) + '”')).join('')).join('') + '</optgroup>' : '');
  }
  let critSeq = 100;
  function criteriaRow(c, variable, i) {
    return '<div class="xp-crit-row"><select class="form-select" data-cm aria-label="Metric">' + metricOptions(c.metric, variable) + '</select>' +
      '<input class="form-input" type="number" min="0" max="5" step="0.5" data-cw value="' + esc(String(c.weight)) + '" aria-label="Weight (0–5)" title="Weight 0–5">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-cdel aria-label="Remove this metric">✕</button></div>';
  }
  function criteriaHTML(criteria, variable) {
    const list = Array.isArray(criteria) && criteria.length ? criteria : DEFAULT_CRITERIA;
    return '<div class="xp-crit" data-crit>' + list.map((c, i) => criteriaRow(c, variable, i)).join('') + '</div>' +
      '<div class="lab-actions mt-2"><button type="button" class="btn btn-ghost btn-sm" data-cadd>Add a metric</button><span class="lab-muted">Up to 5 metrics, weight 0–5.</span></div>';
  }
  function wireCriteria(root, variable) {
    const box = root.querySelector('[data-crit]');
    const sync = () => {
      const rows = box.querySelectorAll('.xp-crit-row');
      root.querySelector('[data-cadd]').disabled = rows.length >= 5;
      rows.forEach(r => { r.querySelector('[data-cdel]').disabled = rows.length <= 1; });
    };
    box.addEventListener('click', e => { const b = e.target.closest('[data-cdel]'); if (b) { b.closest('.xp-crit-row').remove(); sync(); } });
    root.querySelector('[data-cadd]').onclick = () => {
      const used = Array.from(box.querySelectorAll('[data-cm]')).map(s => s.value);
      const next = BASE_METRICS.find(m => !used.includes(m)) || 'accuracy';
      box.insertAdjacentHTML('beforeend', criteriaRow({ metric: next, weight: 1 }, variable, ++critSeq));
      sync();
    };
    sync();
  }
  // → { criteria } or { error }
  function readCriteria(root) {
    const criteria = Array.from(root.querySelectorAll('.xp-crit-row')).map(r => ({ metric: r.querySelector('[data-cm]').value, weight: Number(r.querySelector('[data-cw]').value) }));
    const seen = new Set();
    for (const c of criteria) {
      if (!Number.isFinite(c.weight) || c.weight < 0 || c.weight > 5) return { error: 'Weights must be numbers from 0 to 5.' };
      if (seen.has(c.metric)) return { error: 'Each metric can be listed only once.' };
      seen.add(c.metric);
    }
    return { criteria };
  }

  /* ══ Experiments list and the new-experiment form ══ */
  Lab.view('experiments', async (main, params) => {
    const [experiments, sandboxes] = await Promise.all([get('/experiments').then(r => r.experiments || []), get('/sandboxes').then(r => r.sandboxes || []), Lab.loadModels()]);
    if (!main.isConnected) return;
    const isNew = params[0] === 'new';
    const showArchived = storageGet('sessionStorage', 'xp-archived') === '1';
    const list = experiments.filter(x => showArchived || !x.archived);
    const archivedCount = experiments.filter(x => x.archived).length;
    const sbxName = id => { const s = sandboxes.find(x => x.id === id); return s ? s.name : '(deleted sandbox)'; };
    main.innerHTML = '<div class="lab-head"><div><h2>Code Experiments</h2><p>Ask an AI for a <b>coding rule</b> — a function <code>classify(record, variable)</code> that gives each post one of a variable\'s codes. Edit it, run it on a read-only snapshot of your posts in an isolated sandbox, measure it against your human coding, compare versions, and send the one you choose to the Codebook.</p></div>' +
        '<div class="lab-actions">' + (archivedCount ? '<button class="btn btn-ghost btn-sm" id="xp-arch">' + (showArchived ? 'Hide archived' : 'Show archived (' + archivedCount + ')') + '</button>' : '') + '<button class="btn btn-primary" id="xp-new"' + (isNew ? ' hidden' : '') + '>New experiment</button></div></div>' +
      (isNew ? '<div class="card lab-section xp-form" id="xp-new-form"></div>' : '') +
      '<div class="card lab-section"><div class="card-title">Experiments</div>' + (list.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Experiment</th><th>Variable</th><th>Versions</th><th>Final</th><th>Last run</th><th>Updated</th></tr></thead><tbody>' +
        list.map(x => '<tr><td><a href="#experiment/' + esc(x.id) + '"><b>' + esc(x.name) + '</b></a>' + (x.archived ? ' <span class="badge badge-gray">archived</span>' : '') +
          '<div class="lab-muted">' + esc(langLabel(x.language)) + ' · ' + esc(sbxName(x.sandboxId)) + ' v' + esc(String(x.sandboxVersion)) + (num(x.bestScore) !== null ? ' · best score ' + dec(x.bestScore) : '') + '</div></td>' +
          '<td>' + esc(x.variable ? x.variable.name : '') + '</td><td>' + fmt(x.versionCount) + '</td><td>' + (x.selected ? '<span class="badge badge-teal">v' + esc(String(x.selected.version !== undefined ? x.selected.version : x.selected)) + '</span>' : '—') + '</td>' +
          '<td>' + (x.lastRunStatus ? runBadge(x.lastRunStatus) : '<span class="lab-muted">not run</span>') + '</td><td>' + when(x.updatedAt) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<div class="lab-empty"><h3>No experiments yet</h3><p>Start one from a variable of your open MetaCode project: its posts and their human and AI codes become the sandbox the rule is measured on.</p></div>') + '</div>' +
      '<div class="card"><div class="card-title">Sandbox data</div><p class="lab-second mb-3">Read-only, versioned snapshots of records with their reference labels (human coding) and baseline labels (MetaCode\'s current AI coding). Code under test never sees the labels.</p>' +
        (sandboxes.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Sandbox</th><th>Variable</th><th>Version</th><th>Records</th><th>Labelled</th><th>Source</th><th>Created</th><th></th></tr></thead><tbody>' +
          sandboxes.map(s => { const v = s.versions && s.versions.length ? s.versions[s.versions.length - 1] : null; return '<tr><td><b>' + esc(s.name) + '</b></td><td>' + esc(s.variable ? s.variable.name : '') + '</td><td>' + (v ? 'v' + v.version : '—') + '</td>' +
            '<td>' + (v ? fmt(v.count) : '—') + '</td><td>' + (v ? fmt(v.referenceCount) : '—') + '</td><td>' + (s.source && s.source.kind === 'dataset' ? 'Training Studio dataset' + (s.source.datasetVersion ? ' v' + s.source.datasetVersion : '') : 'Project “' + esc(s.source && s.source.projectName || 'MetaCode') + '”') + '</td>' +
            '<td>' + when(s.createdAt) + '</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" data-sdel="' + esc(s.id) + '" aria-label="Delete sandbox ' + esc(s.name) + '">Delete</button></td></tr>'; }).join('') + '</tbody></table></div>'
          : '<p class="lab-muted">No sandboxes yet. Creating an experiment creates one.</p>') + '</div>';
    $('xp-new').onclick = () => Lab.go('experiments/new');
    if ($('xp-arch')) $('xp-arch').onclick = () => { storageSet('sessionStorage', 'xp-archived', showArchived ? null : '1'); Lab.route(); };
    main.querySelectorAll('[data-sdel]').forEach(b => { b.onclick = () => deleteSandbox(b, sandboxes.find(s => s.id === b.dataset.sdel)); });
    if (isNew) newExperimentForm($('xp-new-form'), params[1] || null);
  });

  async function deleteSandbox(btn, s) {
    if (!s || !(await confirmDanger('Delete sandbox?', 'The sandbox “' + s.name + '” and all of its versions are deleted from the Lab. Your MetaCode project isn\'t changed.'))) return;
    btn.disabled = true;
    try { await del('/sandboxes/' + encodeURIComponent(s.id)); notify('Sandbox deleted', 'success'); Lab.route(); }
    catch (e) {
      if (e.status !== 409) { notify(e.message, 'error', 7000); btn.disabled = false; return; }
      if (await confirmDanger('Sandbox in use', e.message + ' Delete the sandbox and those experiments?', 'Delete both')) {
        try { await del('/sandboxes/' + encodeURIComponent(s.id) + '?force=1'); notify('Sandbox and its experiments deleted', 'success'); Lab.route(); }
        catch (err) { notify(err.message, 'error', 7000); }
      }
      btn.disabled = false;
    }
  }

  // The form state survives a failed create (a created sandbox is reused instead of made twice)
  const F = { sandbox: null, sandboxKey: '' };

  function newExperimentForm(box, dimParam) {
    const project = readOpenProject();
    const dims = project.codebook || [];
    const want = dimParam ? dims.find(d => String(d.id) === dimParam) : null;
    let nameTouched = false, datasets = null;
    const projectPanel = () => {
      if (project.problem === 'none') return '<div class="lab-empty"><h3>No MetaCode project is open in this browser</h3><p>Open or create a project in <a href="/app.html">MetaCode</a>, code some posts, then come back. The Lab reads the open project from this browser (it never changes it).</p></div>';
      if (project.problem === 'unreadable') return '<div class="lab-error">The open MetaCode project in this browser couldn\'t be read.</div>';
      if (!dims.length) return '<div class="lab-empty"><h3>“' + esc(project.name) + '” has no Codebook variables yet</h3><p>Add a variable with its codes in the <a href="/app.html#codebook">Codebook</a>, code some posts, then come back.</p></div>';
      if (!project.posts.length) return '<div class="lab-empty"><h3>“' + esc(project.name) + '” has no posts yet</h3><p>Import or collect posts in <a href="/app.html">MetaCode</a> first: they become the sandbox records.</p></div>';
      return '<p class="lab-second">Project <b>' + esc(project.name) + '</b> (open in this browser) · ' + plural(project.posts.length, 'post') + (project.posts.length > LIMITS.records ? ' — the first ' + fmt(LIMITS.records) + ' are used' : '') + '</p>' +
        (dimParam && !want ? '<div class="lab-warn mt-2">The variable “' + esc(dimParam) + '” isn\'t in the open project “' + esc(project.name) + '”. Open the project that has it in MetaCode, or pick another variable.</div>' : '') +
        '<fieldset class="xp-vars mt-2"><legend class="form-label">Variable</legend>' + dims.map((d, i) => {
          const problem = variableProblem(d);
          const st = dimStats(project, d);
          const checked = want ? d === want : !problem && dims.findIndex(x => !variableProblem(x)) === i;
          return '<label class="xp-var' + (problem ? ' is-off' : '') + '"><input type="radio" name="xp-var" value="' + i + '"' + (checked ? ' checked' : '') + (problem ? ' disabled' : '') + '>' +
            '<span><b>' + esc(str(d.name) || String(d.id)) + '</b> <span class="lab-mono lab-muted">' + esc(String(d.id)) + '</span><br><span class="lab-muted">' + (problem ? esc(problem) : plural((d.codes || []).length, 'code') + ' · ' + plural(st.records, 'record') + ' · ' + fmt(st.labelled) + ' labelled by people · ' + fmt(st.ai) + ' AI-coded') + '</span></span></label>';
        }).join('') + '</fieldset>';
    };
    const ex = execution(), na = ex.unavailable;
    box.innerHTML = '<div class="card-title">New experiment</div>' +
      (ex.off ? '<div class="lab-warn mb-3" id="xp-f-off" role="status">Running code is switched off on this server. You can create the experiment, write, check and compare versions, but not run them.</div>' : '') +
      '<fieldset class="xp-src"><legend class="form-label">Records</legend><label><input type="radio" name="xp-src" value="project" id="xp-src-project" checked> Open MetaCode project</label><label><input type="radio" name="xp-src" value="dataset" id="xp-src-dataset"> Training Studio dataset</label></fieldset>' +
      '<div id="xp-src-p" class="mt-3">' + projectPanel() + '</div><div id="xp-src-d" class="mt-3" hidden></div>' +
      '<div id="xp-fromrule-wrap" class="mt-3" hidden><label class="xp-check"><input type="checkbox" id="xp-f-fromrule"> <span id="xp-f-fromrule-l">Start from the Codebook\'s current rule</span></label></div>' +
      '<div class="lab-row mt-3">' + field('Experiment name', '<input class="form-input" id="xp-f-name" maxlength="120">') +
        field('Language', '<select class="form-select" id="xp-f-lang">' + langOptions(na, l => (l === 'javascript' ? ' (starts instantly)' : '')) + '</select>') + '</div>' +
      '<div id="xp-f-lang-why" class="mt-2" role="status" aria-live="polite"></div>' +
      field('Objective <span>(what a good rule does — the AI and the evaluation read it)</span>', '<textarea class="form-textarea" id="xp-f-objective" rows="2" maxlength="2000" placeholder="e.g. Match the human coding on held-out posts; prefer “no code” to a wrong code."></textarea>') +
      '<div class="form-group"><span class="form-label">Success criteria <span>(the objective score is their weighted mean)</span></span><div id="xp-f-criteria"></div></div>' +
      '<div class="lab-actions mt-3"><button class="btn btn-primary" id="xp-create">Create experiment</button><a class="btn btn-secondary" href="#experiments">Cancel</a><span id="xp-f-status" class="lab-muted" role="status" aria-live="polite"></span></div>';
    const src = () => (box.querySelector('[name=xp-src]:checked') || {}).value;
    const pickedDim = () => { const r = box.querySelector('[name=xp-var]:checked'); return r ? dims[Number(r.value)] : null; };
    let ruleFor = null;   // the dimension whose rule the checkbox was last set for
    // Languages this server can't run: disabled, with the reason (and a warning when one is picked anyway, e.g. by a Codebook rule)
    function syncLang() {
      const l = $('xp-f-lang').value, why = $('xp-f-lang-why');
      const others = LANGS.filter(x => na[x] && x !== l);
      why.innerHTML = (na[l] ? '<div class="lab-warn" id="xp-f-lang-na">' + esc(LANG_LABEL[l]) + ' can\'t run on this server: ' + esc(na[l]) + ' You can still create the experiment and write code, but it can\'t run here.</div>' : '') +
        (others.length ? '<p class="form-hint">Can\'t run here: ' + others.map(x => esc(LANG_LABEL[x]) + ' — ' + esc(na[x])).join(' · ') + '</p>' : '');
    }
    if (na[$('xp-f-lang').value]) { const ok = LANGS.find(l => !na[l]); if (ok) $('xp-f-lang').value = ok; }
    $('xp-f-lang').addEventListener('change', syncLang);
    function setCriteria(variable) {
      const host = $('xp-f-criteria');
      const keep = host.querySelector('.xp-crit-row') ? readCriteria(host).criteria : DEFAULT_CRITERIA;
      host.innerHTML = criteriaHTML(keep.filter(c => !/:/.test(c.metric) || (variable && variable.codes.some(x => c.metric.endsWith(':' + x.id)))), variable);
      wireCriteria(host, variable);
    }
    function onVariable() {
      const d = src() === 'project' ? pickedDim() : datasetVariable();
      const variable = src() === 'project' ? (d && !variableProblem(d) ? variableOf(d) : null) : d;
      if (!nameTouched) $('xp-f-name').value = variable ? cut(variable.name + ' rule', 120) : '';
      // The Codebook's current rule (the existing implementation) can become version 1
      const rule = src() === 'project' && d ? codebookRule(d) : null;
      $('xp-fromrule-wrap').hidden = !rule;
      if (rule) {
        $('xp-f-fromrule-l').textContent = 'Start from the Codebook\'s current rule' + (rule.version ? ' (v' + rule.version + ', ' + langLabel(rule.language) + ')' : '') + ' as version 1';
        if (ruleFor !== d) { ruleFor = d; $('xp-f-fromrule').checked = true; $('xp-f-lang').value = rule.language; }
      } else { $('xp-f-fromrule').checked = false; ruleFor = null; }
      syncLang();
      setCriteria(variable);
    }
    $('xp-f-name').addEventListener('input', () => { nameTouched = true; });
    $('xp-f-fromrule').onchange = () => { const d = pickedDim(), rule = d && codebookRule(d); if ($('xp-f-fromrule').checked && rule) $('xp-f-lang').value = rule.language; syncLang(); };
    box.querySelectorAll('[name=xp-src]').forEach(r => { r.onchange = () => { const ds = src() === 'dataset'; $('xp-src-p').hidden = ds; $('xp-src-d').hidden = !ds; if (ds && !datasets) loadDatasets(); else onVariable(); }; });
    box.addEventListener('change', e => { if (e.target.name === 'xp-var') onVariable(); });

    // Training Studio dataset: a frozen version, and the variable from the open project or from the expected values
    let found = null;   // { key, codes, other }
    async function loadDatasets() {
      const d = $('xp-src-d');
      d.innerHTML = '<p class="lab-muted">Loading datasets…</p>';
      try { datasets = ((await get('/datasets')).datasets || []).filter(x => x.versions && x.versions.length); }
      catch (e) { d.innerHTML = '<div class="lab-error">' + esc(e.message) + '</div>'; datasets = null; return; }
      const usableDims = dims.filter(x => !variableProblem(x));
      if (!datasets.length) { d.innerHTML = '<div class="lab-empty"><h3>No committed dataset versions</h3><p>Commit a version of a dataset in the <a href="#training">Training Studio</a> first. Each example\'s input (or task) becomes a record\'s text and its expected output the reference label.</p></div>'; onVariable(); return; }
      d.innerHTML = '<div class="lab-row">' + field('Dataset', '<select class="form-select" id="xp-ds-id">' + datasets.map(x => '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>').join('') + '</select>') +
          field('Version', '<select class="form-select" id="xp-ds-ver"></select>') + '</div>' +
        '<fieldset class="xp-src mt-2"><legend class="form-label">Variable and codes</legend>' +
          '<label><input type="radio" name="xp-ds-vk" value="project"' + (usableDims.length ? ' checked' : ' disabled') + '> A variable of the open project</label>' +
          '<label><input type="radio" name="xp-ds-vk" value="expected"' + (usableDims.length ? '' : ' checked') + '> Codes from the dataset\'s expected values</label></fieldset>' +
        '<div id="xp-ds-vp" class="mt-2">' + (usableDims.length ? field('Variable', '<select class="form-select" id="xp-ds-var">' + usableDims.map(x => '<option value="' + dims.indexOf(x) + '">' + esc(str(x.name) || String(x.id)) + '</option>').join('') + '</select>') : '') + '</div>' +
        '<div id="xp-ds-ve" class="mt-2" hidden>' + field('Variable name', '<input class="form-input" id="xp-ds-varname" maxlength="120">') + '<p class="form-hint" id="xp-ds-codes" role="status" aria-live="polite"></p></div>' +
        '<p class="form-hint">Expected values that equal a code id become reference labels; the others are left unlabelled. There are no AI Coding labels for dataset records. A rule for a variable that isn\'t in your open project can\'t be sent to its Codebook.</p>';
      const fillVer = () => { const ds = datasets.find(x => x.id === $('xp-ds-id').value); $('xp-ds-ver').innerHTML = ds.versions.slice().reverse().map(v => '<option value="' + v.version + '">v' + v.version + ' · ' + fmt(v.count) + ' examples</option>').join(''); };
      const kind = () => (d.querySelector('[name=xp-ds-vk]:checked') || {}).value;
      const syncKind = () => { $('xp-ds-vp').hidden = kind() !== 'project'; $('xp-ds-ve').hidden = kind() !== 'expected'; if (kind() === 'expected') findCodes(); else onVariable(); };
      fillVer();
      $('xp-ds-varname').value = datasets[0].name;
      $('xp-ds-id').onchange = () => { fillVer(); if (!$('xp-ds-varname').dataset.touched) $('xp-ds-varname').value = datasets.find(x => x.id === $('xp-ds-id').value).name; syncKind(); };
      $('xp-ds-ver').onchange = syncKind;
      $('xp-ds-varname').oninput = () => { $('xp-ds-varname').dataset.touched = '1'; onVariable(); };
      if ($('xp-ds-var')) $('xp-ds-var').onchange = onVariable;
      d.querySelectorAll('[name=xp-ds-vk]').forEach(r => { r.onchange = syncKind; });
      syncKind();
    }
    // The distinct expected values of the dataset version that can be code ids
    async function findCodes() {
      const id = $('xp-ds-id').value, version = $('xp-ds-ver').value, key = id + ':' + version;
      const out = $('xp-ds-codes');
      if (found && found.key === key) { onVariable(); return; }
      out.textContent = 'Reading the expected values…';
      const counts = new Map();
      let other = 0, total = 0;
      try {
        for (let offset = 0; offset < LIMITS.records; offset += 500) {
          const r = await get('/datasets/' + encodeURIComponent(id) + '?version=' + encodeURIComponent(version) + '&offset=' + offset + '&limit=500');
          (r.examples || []).forEach(e => { const v = str(e.expected).trim(); total++; if (ID_RE.test(v)) counts.set(v, (counts.get(v) || 0) + 1); else other++; });
          if (offset + 500 >= (r.total || 0)) break;
        }
      } catch (e) { out.textContent = e.message; return; }
      if (!box.isConnected || $('xp-ds-id').value + ':' + $('xp-ds-ver').value !== key) return;
      const codes = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, LIMITS.codes).map(x => x[0]);
      found = { key, codes, other, total };
      out.textContent = codes.length ? plural(codes.length, 'code') + ' found: ' + codes.slice(0, 12).join(', ') + (codes.length > 12 ? ', …' : '') + '. ' + fmt(other) + ' of ' + fmt(total) + ' examples ' + (other === 1 ? 'has' : 'have') + ' other expected values (no reference label).'
        : 'None of the ' + fmt(total) + ' examples has an expected value that can be a code id (letters, digits, _ and -, at most 64). Pick a variable of the open project instead.';
      onVariable();
    }
    function datasetVariable() {
      if (!datasets || !$('xp-ds-id')) return null;
      const kind = (box.querySelector('[name=xp-ds-vk]:checked') || {}).value;
      if (kind === 'project') { const d = $('xp-ds-var') ? dims[Number($('xp-ds-var').value)] : null; return d ? variableOf(d) : null; }
      const key = $('xp-ds-id').value + ':' + $('xp-ds-ver').value;
      if (!found || found.key !== key || !found.codes.length) return null;
      const name = cut($('xp-ds-varname').value.trim() || 'Label', LIMITS.name);
      return { id: slug(name) || 'label', name, description: '', codes: found.codes.map(c => ({ id: c, label: c, description: '' })) };
    }
    onVariable();

    $('xp-create').onclick = async () => {
      const btn = $('xp-create'), status = $('xp-f-status');
      const crit = readCriteria($('xp-f-criteria'));
      const fail = msg => { status.textContent = ''; btn.disabled = false; notify(msg, 'error', 7000); };
      if (crit.error) { notify(crit.error, 'error'); return; }
      const name = $('xp-f-name').value.trim();
      if (!name) { notify('Give the experiment a name.', 'error'); $('xp-f-name').focus(); return; }
      btn.disabled = true;
      let body, path, key, dim = null;
      if (src() === 'project') {
        dim = pickedDim();
        if (project.problem || !dim) return fail(project.problem ? 'No MetaCode project is open in this browser.' : 'Pick a variable.');
        const problem = variableProblem(dim);
        if (problem) return fail(problem);
        const variable = variableOf(dim);
        const built = recordsOf(project, dim);
        if (!built.records.length) return fail('The open project has no posts.');
        body = { name: cut(project.name + ' · ' + variable.name, 120), source: { kind: 'project', projectName: project.name }, variable, records: built.records };
        path = '/sandboxes/import';
        key = 'p:' + project.name + ':' + variable.id + ':' + built.records.length + ':' + JSON.stringify(built.records).length;
        F.cutTexts = built.cutTexts; F.skipped = built.skipped;
      } else {
        const variable = datasetVariable();
        if (!variable) return fail('Choose the variable: a variable of the open project, or codes found in the dataset\'s expected values.');
        const ds = datasets.find(x => x.id === $('xp-ds-id').value);
        body = { datasetId: ds.id, version: Number($('xp-ds-ver').value), variable, name: cut(ds.name + ' v' + $('xp-ds-ver').value + ' · ' + variable.name, 120) };
        path = '/sandboxes/from-dataset';
        key = 'd:' + ds.id + ':' + body.version + ':' + JSON.stringify(variable);
        F.cutTexts = 0; F.skipped = 0;
      }
      try {
        let sandbox = F.sandboxKey === key ? F.sandbox : null, report = null;
        if (!sandbox) {
          status.textContent = 'Creating the sandbox…';
          const r = await post(path, body);
          sandbox = r.sandbox; report = r.report || null;
          F.sandbox = sandbox; F.sandboxKey = key; F.report = report;
        } else report = F.report || null;
        status.textContent = 'Creating the experiment…';
        const sv = sandbox.versions && sandbox.versions.length ? sandbox.versions[sandbox.versions.length - 1].version : undefined;
        const exp = { name, sandboxId: sandbox.id, sandboxVersion: sv, language: $('xp-f-lang').value, objective: { text: $('xp-f-objective').value.trim(), criteria: crit.criteria } };
        const rule = dim && $('xp-f-fromrule').checked ? codebookRule(dim) : null;
        if (rule) exp.initialCode = { code: rule.code, language: rule.language, label: 'Codebook rule' + (rule.version ? ' v' + rule.version : '') };
        const r = await post('/experiments', exp);
        F.sandbox = null; F.sandboxKey = '';
        IMPORT_NOTES[r.experiment.id] = { report, cutTexts: F.cutTexts, skipped: F.skipped };
        notify('Experiment created', 'success');
        Lab.go('experiment/' + r.experiment.id);
      } catch (e) {
        fail(e.message + (F.sandbox ? ' (The sandbox was created and is reused when you try again.)' : ''));
      }
    };
  }
  // Import reports to show once in the new workspace
  const IMPORT_NOTES = {};

  /* ══ Experiment workspace ══ */
  Lab.view('experiment', async (main, params) => {
    const id = params[0];
    if (params[1] === 'compare') return compareView(main, id, params[2], params[3]);
    return workspace(main, id);
  });

  // Kept while the user stays on one experiment (the view re-renders on navigation)
  const X = { id: null };
  function resetX(id) {
    Object.assign(X, { id, exp: null, runs: [], sandbox: null, current: null, tab: 'preview', shownRunId: null, split: 'all',
      preview: { filter: 'all', against: 'baseline', offset: 0 }, refSplit: 'auto', evalAgainst: 'baseline', model: '', send: null, dist: {} });
  }

  async function workspace(main, id) {
    const [data] = await Promise.all([get('/experiments/' + encodeURIComponent(id)), Lab.loadModels()]);
    if (!main.isConnected) return;
    if (X.id !== id) resetX(id);
    X.exp = data.experiment; X.runs = sortRuns(data.runs); X.sandbox = data.sandbox || null;
    // The server's own metric definitions, when it sends them
    if (data.definitions && typeof data.definitions === 'object') Object.keys(DEFS).forEach(k => { const d = data.definitions[k]; if (d && typeof d.definition === 'string') DEFS[k] = [d.label || DEFS[k][0], d.direction === undefined ? DEFS[k][1] : d.direction, d.definition]; });
    const exp = () => X.exp;
    const versions = () => exp().versions || [];
    const ver = n => versions().find(v => v.version === n) || null;
    const latest = () => (versions().length ? versions()[versions().length - 1] : null);
    if (X.current === null || !ver(X.current)) X.current = latest() ? latest().version : null;
    const cur = () => ver(X.current);
    const variable = () => exp().variable;
    const base = '/experiments/' + encodeURIComponent(exp().id);
    const draftKey = 'xp-draft:' + exp().id;
    // Per render: the editor, timers and what is in progress
    const W = { editor: null, lang: null, phase: null, asking: false, fresh: null, resultsFor: null, lastSeq: -1, pollTimer: null, pollFails: 0, polling: null, activeTimer: null, tabSeq: 0,
      template: '', draftTimer: null, sendTimer: null, channel: null, merge: null, left: false };
    Lab.onLeave(() => {
      W.left = true;
      clearTimeout(W.pollTimer); clearTimeout(W.activeTimer); clearTimeout(W.draftTimer); clearTimeout(W.sendTimer);
      if (W.editor) { saveDraft(); try { W.editor.destroy(); } catch (e) { /* */ } }
      if (W.channel) { try { W.channel.close(); } catch (e) { /* */ } }
      if (W.merge) { try { W.merge.destroy(); } catch (e) { /* */ } }
    });
    const sbx = X.sandbox;
    // Running code is off on this server: nothing can run (the server answers 503), everything else works
    const execOff = !!(data.execution && data.execution.mode === 'off');
    // Languages this server can't run (from /models): not offered in the editor, and Run says why
    const na = execution().unavailable;
    const v0 = exp().variable;
    X.model = X.model || (Lab.defaultModel() ? Lab.defaultModel().provider + '|' + Lab.defaultModel().model : '');

    main.innerHTML = '<div class="xp" aria-live="off">' +
      '<div id="xp-notice"></div>' +
      '<div class="xp-top">' +
        '<div class="xp-top-main"><label class="lab-visually-hidden" for="xp-name">Experiment name</label><input class="xp-name" id="xp-name" maxlength="120" value="' + esc(exp().name) + '">' +
          '<span class="xp-chip-info" title="' + esc(v0.description || '') + '">Variable <b>' + esc(v0.name) + '</b> · ' + plural(v0.codes.length, 'code') + '</span>' +
          '<span class="xp-chip-info" id="xp-sbx"' + (sbx && sbx.name ? ' title="' + esc('Sandbox “' + sbx.name + '”' + (sbx.source && sbx.source.kind === 'dataset' ? ' from a Training Studio dataset' : sbx.source && sbx.source.projectName ? ' from the project “' + sbx.source.projectName + '”' : '')) + '"' : '') + '>' +
            (sbx ? plural(sbx.count, 'record') + ' · ' + fmt(sbx.referenceCount) + ' labelled · data v' + sbx.version : 'Sandbox data v' + esc(String(exp().sandboxVersion))) + '</span></div>' +
        '<div class="xp-top-ctl"><span class="xp-pair"><label class="xp-inline" for="xp-version">Version</label><select class="form-select" id="xp-version"></select></span>' +
          '<span class="xp-state" id="xp-state" role="status" aria-live="polite"></span>' +
          '<button class="btn btn-secondary btn-sm" id="xp-compare">Compare</button><span id="xp-final-badge"></span>' +
          '<button class="btn btn-ghost btn-sm" id="xp-archive">' + (exp().archived ? 'Unarchive' : 'Archive') + '</button><button class="btn btn-ghost btn-sm" id="xp-delete">Delete</button></div>' +
      '</div>' +
      '<div class="xp-grid">' +
        '<details class="xp-panel xp-left" open><summary>Prompt</summary><div class="xp-prompt">' +
          '<div class="xp-thread" id="xp-thread" role="region" aria-label="Conversation about this experiment" tabindex="0"></div>' +
          '<div class="xp-compose"><label class="form-label" for="xp-input">Ask for a coding rule</label>' +
            '<textarea class="form-textarea" id="xp-input" rows="4" maxlength="4000" placeholder="' + esc(PLACEHOLDER) + '"></textarea>' +
            '<div class="xp-modes"><button class="btn btn-violet btn-sm" id="xp-generate">Generate code</button><button class="btn btn-secondary btn-sm" id="xp-alternative">Alternative</button>' +
              '<button class="btn btn-secondary btn-sm" id="xp-refine">Refine this version</button><button class="btn btn-ghost btn-sm" id="xp-ask">Ask</button></div>' +
            '<div class="xp-model"><label class="form-label" for="xp-model">Model</label><select class="form-select" id="xp-model">' + Lab.modelOptions(X.model) + '</select></div>' +
            '<p class="lab-muted">The AI sees the variable, your request and up to 24 dev records — never the held-out ones.</p></div>' +
          '<details class="xp-ctx" id="xp-context"><summary>Context: codes, record fields, criteria, constraints</summary>' +
            '<h4>Codes of “' + esc(v0.name) + '”</h4><div class="table-wrap"><table class="table xp-codes"><thead><tr><th>Code</th><th>Label</th><th>Description</th></tr></thead><tbody>' +
              v0.codes.map(c => '<tr><td>' + chip(v0, c.id) + '<div class="lab-mono lab-muted">' + esc(c.id) + '</div></td><td>' + esc(c.label) + '</td><td>' + esc(c.description || '') + '</td></tr>').join('') + '</tbody></table></div>' +
            '<h4>What classify(record, variable) receives</h4><dl class="lab-kv xp-schema"><dt>record.id</dt><dd>text, unique</dd><dt>record.text</dt><dd>the post\'s text</dd><dt>record.author</dt><dd>text (may be empty)</dd><dt>record.timestamp</dt><dd>text (may be empty)</dd>' +
              '<dt>record.meta</dt><dd>platform, likes, shares, comments when known</dd><dt>variable</dt><dd>{ id, name, description, codes: [{ id, label, description }] }</dd><dt>returns</dt><dd>a code id, null for “no code”, or { code, confidence 0–1, reason }</dd></dl>' +
            '<p class="lab-muted">Reference and AI labels are never passed to the rule.</p>' +
            '<h4>Objective and success criteria</h4><label class="form-label" for="xp-objective">Objective</label><textarea class="form-textarea" id="xp-objective" rows="2" maxlength="2000">' + esc(exp().objective ? exp().objective.text : '') + '</textarea>' +
            '<div id="xp-criteria" class="mt-2">' + criteriaHTML(exp().objective && exp().objective.criteria, v0) + '</div><div class="lab-actions mt-2"><button class="btn btn-secondary btn-sm" id="xp-criteria-save">Save criteria</button></div>' +
            '<h4>Constraints</h4><p class="lab-second">' + esc(CONSTRAINTS) + '</p>' +
          '</details></div></details>' +
        '<div class="xp-center">' +
          '<details class="xp-panel" open><summary>Code</summary><div class="xp-code">' +
            '<div class="xp-toolbar"><div class="xp-tb-info"><b id="xp-vlabel"></b> <span id="xp-origin"></span> <span class="xp-dirty" id="xp-dirty" hidden>Edited — not saved</span> <span class="xp-changed" id="xp-changed" hidden>Changed since last run</span></div>' +
              '<div class="xp-tb-actions"><label class="lab-visually-hidden" for="xp-lang">Language</label><select class="form-select" id="xp-lang">' + langOptions(na) + '</select>' +
                '<label class="lab-visually-hidden" for="xp-split">Records to run on</label><select class="form-select" id="xp-split"><option value="all">All records</option><option value="test">Held-out records</option><option value="dev">Dev records</option></select>' +
                '<button class="btn btn-primary btn-sm" id="xp-run">Run</button><button class="btn btn-danger btn-sm" id="xp-cancel" hidden>Cancel run</button>' +
                '<button class="btn btn-secondary btn-sm" id="xp-save">Save as new version</button><button class="btn btn-ghost btn-sm" id="xp-reset">Reset</button>' +
                '<button class="btn btn-ghost btn-sm" id="xp-check">Check</button><button class="btn btn-ghost btn-sm" id="xp-diff-parent">Diff vs parent</button>' +
                '<button class="btn btn-ghost btn-sm" id="xp-duplicate">Duplicate</button><button class="btn btn-ghost btn-sm" id="xp-restore" hidden>Restore as new version</button></div></div>' +
            '<div class="xp-editor" id="xp-editor"><p class="lab-muted xp-editor-wait">Loading the editor…</p></div>' +
            '<div class="xp-validation" id="xp-validation"></div></div></details>' +
          '<details class="xp-panel" open><summary>Terminal</summary><div class="xp-term" id="xp-terminal">' +
            '<div class="xp-term-head"><label class="lab-visually-hidden" for="xp-run-pick">Run to show</label><select class="form-select" id="xp-run-pick"></select>' +
              '<span class="xp-term-status" id="xp-term-status"></span><span class="xp-term-btns"><button class="btn btn-ghost btn-sm" id="xp-rerun">Rerun</button><button class="btn btn-ghost btn-sm" id="xp-term-clear">Clear</button></span></div>' +
            '<div class="xp-term-note" id="xp-term-note" role="alert" hidden></div>' +
            '<div class="xp-term-body" id="xp-term-body" role="log" aria-live="polite" aria-label="Run log" tabindex="0"></div></div></details>' +
        '</div>' +
        '<details class="xp-panel xp-right" open><summary>Results</summary><div class="xp-results">' +
          '<div class="lab-tabs" role="tablist" aria-label="Results">' + [['preview', 'Preview'], ['metrics', 'Metrics'], ['eval', 'AI evaluation'], ['final', 'Finalize']].map(([k, l]) =>
            '<button type="button" class="lab-tab" role="tab" id="xp-tab-' + k + '" data-xtab="' + k + '" aria-controls="xp-' + k + '" aria-selected="' + (X.tab === k) + '" tabindex="' + (X.tab === k ? '0' : '-1') + '">' + l + '</button>').join('') + '</div>' +
          ['preview', 'metrics', 'eval', 'final'].map(k => '<div class="xp-tabpanel" role="tabpanel" id="xp-' + k + '" aria-labelledby="xp-tab-' + k + '"' + (X.tab === k ? '' : ' hidden') + '></div>').join('') +
        '</div></details>' +
      '</div></div>';

    /* ── State: the pill and the buttons ── */
    const activeRun = () => X.runs.find(r => ACTIVE.includes(r.status)) || null;
    const shownRun = () => X.runs.find(r => r.id === X.shownRunId) || null;
    const isDirty = () => {
      if (!W.editor) return false;
      const v = cur();
      return v ? W.editor.getValue() !== v.code || W.lang !== v.language : W.editor.getValue() !== W.template;
    };
    function blocked(v) {
      if (!v) return null;
      if (v.policy && (v.policy.ok === false || (v.policy.findings || []).some(f => f.severity === 'error'))) return 'policy';
      if (v.review && v.review.decision === 'rejected') return 'rejected';
      if (v.review && (v.review.decision === 'needs_review' || v.review.decision === 'unavailable') && !(v.reviewAck && v.reviewAck.codeHash === v.codeHash)) return 'ack';
      return null;
    }
    const sendState = () => (X.send && X.send.expId === exp().id ? X.send.state : null);
    function stateKey() {
      const v = cur();
      if (W.phase === 'generating') return 'generating';
      if (W.phase === 'reviewing') return 'reviewing';
      const ar = activeRun();
      if (ar) return ar.stage === 'review' ? 'reviewing' : 'running';
      if (W.phase === 'starting' || W.phase === 'saving-run') return 'running';
      if (W.phase === 'sending' || sendState() === 'waiting') return 'sending';
      const selHere = exp().selected && v && exp().selected.version === v.version && !isDirty();
      if (selHere && sendState() === 'applied') return 'saved';
      if (selHere && sendState() === 'failed') return 'sendFailed';
      if (isDirty()) return 'dirty';
      if (!v) return 'empty';
      if (blocked(v)) return 'blocked';
      if (selHere) return 'final';
      const r = shownRun();
      if (r && r.version === v.version && r.codeHash === v.codeHash) {
        if (r.status === 'succeeded') return W.resultsFor === r.id ? 'results' : 'succeeded';
        // (a run blocked only because the review asked for a human check is no longer in the way once this exact code is allowed)
        if (r.status === 'blocked' && !(r.failure && r.failure.type === 'review_required' && v.reviewAck && v.reviewAck.codeHash === v.codeHash)) return 'blocked';
        if (r.status === 'cancelled' || r.status === 'interrupted') return r.status;
        if (r.status === 'failed') return 'failed';
      }
      if (W.fresh === v.version) return 'generated';
      return 'ready';
    }
    function refresh() {
      if (W.left) return;
      const k = stateKey(), pill = $('xp-state');
      if (pill.textContent !== STATE[k][0]) pill.textContent = STATE[k][0];
      pill.className = 'xp-state xp-state-' + STATE[k][1];
      const v = cur(), dirty = isDirty(), ar = activeRun();
      const gen = W.phase === 'generating', busy = !!W.phase || !!ar;
      const ed = !!W.editor;
      $('xp-dirty').hidden = !dirty;
      $('xp-changed').hidden = !changedSinceRun();
      $('xp-generate').disabled = gen || !!ar || W.phase === 'sending';
      $('xp-alternative').disabled = $('xp-refine').disabled = gen || !!ar || !v || W.phase === 'sending';
      $('xp-ask').disabled = W.asking || gen;
      $('xp-version').disabled = gen || !versions().length;
      $('xp-save').disabled = !ed || !dirty || gen || W.phase === 'saving' || W.phase === 'saving-run';
      $('xp-reset').disabled = !ed || !dirty;
      $('xp-reset').textContent = v ? 'Reset to v' + v.version : 'Reset';
      $('xp-check').disabled = !ed || !v || dirty || busy;
      $('xp-check').title = dirty ? 'Save your edits first: Check looks at a saved version' : '';
      const run = $('xp-run');
      run.textContent = dirty ? 'Save & run' : 'Run';
      const why = !dirty && v ? blocked(v) : null;
      const cantRun = na[dirty || !v ? W.lang : v.language];
      run.disabled = execOff || !!cantRun || !ed || busy || (!dirty && (!v || !!why));
      run.title = execOff ? 'Running code is switched off on this server' : cantRun ? cantRun : why === 'ack' ? 'Read the AI review and allow running first' : why ? 'Blocked: see the checks below' : '';
      $('xp-cancel').hidden = !ar;
      $('xp-diff-parent').disabled = !ed || (!dirty && !(v && v.parent && ver(v.parent)));
      $('xp-duplicate').disabled = !v || dirty || gen;
      $('xp-duplicate').title = dirty ? 'Save or reset your edits first' : '';
      const lt = latest();
      $('xp-restore').hidden = !v || !lt || lt.version === v.version;
      $('xp-restore').disabled = dirty || gen;
      if (v) $('xp-restore').textContent = 'Restore as v' + (lt.version + 1);
      $('xp-lang').disabled = !ed || gen;
      $('xp-rerun').disabled = execOff || !shownRun() || !!na[shownRun().language] || !!ar || busy;
      $('xp-compare').disabled = !versions().length;
      const sel = exp().selected;
      $('xp-final-badge').innerHTML = sel ? '<span class="badge badge-teal">Final: v' + sel.version + '</span>' : '<span class="badge badge-gray">No final version</span>';
      if ($('xp-select')) $('xp-select').disabled = busy || dirty || !v;
      if ($('xp-send')) $('xp-send').disabled = busy || !sel || sendState() === 'waiting';
      if ($('xp-unselect')) $('xp-unselect').disabled = busy || sendState() === 'waiting';
      if ($('xp-evaluate')) $('xp-evaluate').disabled = busy;
    }
    function changedSinceRun() {
      const v = cur();
      if (!v) return false;
      const runsOfV = X.runs.filter(r => r.version === v.version);
      if (isDirty()) return runsOfV.length > 0 || X.runs.length > 0;
      const r = shownRun();
      return !!(r && !ACTIVE.includes(r.status) && r.codeHash !== v.codeHash);
    }
    // Keeps the keyboard focus somewhere sensible when the focused button gets disabled or hidden
    function keepFocus(fallbackId, noScroll) {
      const a = document.activeElement;
      if (!a || a === document.body || a.disabled || a.hidden || !a.isConnected) { const f = $(fallbackId); if (f && !f.disabled && !f.hidden) f.focus({ preventScroll: !!noScroll }); }
    }
    function setPhase(p) { W.phase = p; refresh(); }

    /* ── Versions ── */
    function versionOptionLabel(v) {
      const lr = v.lastRun;
      const st = !lr ? 'not run' : lr.status === 'succeeded' ? '✓ ran' : lr.status === 'failed' ? '✗ failed' : ACTIVE.includes(lr.status) ? 'running…' : lr.status;
      return 'v' + v.version + ' · ' + (ORIGIN[v.origin] ? ORIGIN[v.origin][0] : v.origin) + ' · ' + st + (exp().selected && exp().selected.version === v.version ? ' · final' : '') + (v.label ? ' · ' + v.label : '');
    }
    function renderVersionSelect() {
      const sel = $('xp-version');
      sel.innerHTML = versions().length ? versions().slice().reverse().map(v => '<option value="' + v.version + '"' + (v.version === X.current ? ' selected' : '') + '>' + esc(versionOptionLabel(v)) + '</option>').join('') : '<option value="">No versions yet</option>';
    }
    function template(lang) {
      if (lang === 'python') return '# Returns a code id from variable["codes"],\n# or None for "no code".\n\ndef classify(record, variable):\n    text = record["text"].lower()\n    return None\n';
      const ts = lang === 'typescript';
      return '// Returns a code id from variable.codes,\n// or null for "no code".\n\nfunction classify(record' + (ts ? ': { id: string; text: string; author: string; timestamp: string; meta: Record<string, unknown> }' : '') + ', variable' + (ts ? ': { id: string; name: string; codes: { id: string; label: string }[] }' : '') + ')' + (ts ? ': string | null' : '') + ' {\n  const text = record.text.toLowerCase();\n  return null;\n}\n';
    }
    // Loads a stored version into the editor (or the empty workspace's template)
    // opts.keepText: the editor keeps its text and language (it was just saved, or the experiment reloaded under it);
    // opts.code / opts.lang: a restored draft; opts.keepRun: the terminal keeps its run; opts.noTab: the caller renders the tabs
    function loadVersion(n, opts) {
      opts = opts || {};
      X.current = n;
      const v = cur();
      if (!opts.keepText || !W.lang) {
        W.lang = opts.lang || (v ? v.language : (exp().language || 'javascript'));
        W.template = template(W.lang);
        if (W.editor) { W.editor.setValue(opts.code !== undefined ? opts.code : v ? v.code : W.template); W.editor.setLanguage(W.lang); }
      }
      $('xp-lang').value = W.lang;
      $('xp-vlabel').textContent = v ? 'v' + v.version + (v.label ? ' · ' + v.label : '') : 'No version yet';
      $('xp-origin').innerHTML = v ? originBadge(v.origin) + (v.parent ? ' <span class="lab-muted">from v' + v.parent + '</span>' : '') : '<span class="lab-muted">Generate code, or write classify() and save it</span>';
      renderVersionSelect();
      renderValidation();
      // The run shown: the latest one of this version, else the one already shown
      if (!opts.keepRun) {
        const mine = X.runs.filter(r => v && r.version === v.version);
        const pick = mine.find(r => ACTIVE.includes(r.status)) || mine.find(r => r.status === 'succeeded') || mine[0] || null;
        if (pick && pick.id !== X.shownRunId) { showRun(pick.id); refresh(); return; }   // showRun renders the tabs
      }
      renderRunPick();
      if (!opts.noTab) renderTab();
      refresh();
    }

    /* ── Thread ── */
    function renderThread() {
      const t = exp().thread || [];
      const box = $('xp-thread');
      box.innerHTML = t.length ? t.map(m => {
        if (m.role === 'user') return '<div class="xp-msg xp-msg-user"><div class="xp-msg-text">' + esc(m.text) + '</div><div class="xp-msg-meta">' + esc(m.kind === 'ask' ? 'Question' : 'Request') + ' · ' + when(m.createdAt) + '</div></div>';
        return '<div class="xp-msg xp-msg-assistant">' + (m.kind === 'note' ? '<p class="lab-muted">' + esc(m.text) + '</p>' : '<div class="xp-md">' + md(m.text) + '</div>') +
          '<div class="xp-msg-meta">' + (m.version ? '<button type="button" class="xp-link" data-goto="' + m.version + '">Created v' + m.version + '</button>' : '') + (m.model ? '<span>' + esc(m.model) + '</span>' : '') + '<span>' + when(m.createdAt) + '</span>' +
          (m.kind === 'ask' ? '<span>AI answer — not run; check it against the measured numbers</span>' : '') + '</div></div>';
      }).join('') : '<p class="lab-muted">Describe the rule you want — the codes, what counts as each, the edge cases — and click <b>Generate code</b>. Every answer becomes a new version you can read, edit and run.</p>';
      LabMarkdown.enhance(box, null);
      box.scrollTop = box.scrollHeight;
    }
    $('xp-thread').addEventListener('click', e => { const b = e.target.closest('[data-goto]'); if (b) switchVersion(Number(b.dataset.goto)); });

    /* ── Validation (policy + AI review) ── */
    function findingsOf(v) {
      if (!v) return [];
      const out = [];
      ((v.policy && v.policy.findings) || []).forEach(f => { if (f.line) out.push({ line: f.line, severity: f.severity, message: f.rule + ': ' + f.message }); });
      ((v.review && v.review.risks) || []).forEach(r => { if (r.line) out.push({ line: r.line, severity: r.severity === 'critical' || r.severity === 'high' ? 'error' : r.severity === 'medium' ? 'warning' : 'info', message: 'AI review (' + r.category + '): ' + r.explanation }); });
      return out;
    }
    function renderValidation() {
      const box = $('xp-validation'), v = cur();
      if (W.editor) W.editor.setFindings(isDirty() ? [] : findingsOf(v));
      if (!v) { box.innerHTML = ''; return; }
      const p = v.policy, r = v.review;
      const pf = p && Array.isArray(p.findings) ? p.findings : [];
      const errs = pf.filter(f => f.severity === 'error'), warns = pf.filter(f => f.severity !== 'error');
      const finding = f => '<li class="xp-find xp-find-' + (f.severity === 'error' ? 'error' : 'warning') + '">' + (f.line ? '<button type="button" class="xp-link" data-line="' + f.line + '">line ' + f.line + '</button> ' : '') +
        '<span class="lab-mono">' + esc(f.rule) + '</span> ' + esc(f.message) + (f.excerpt ? '<code class="xp-excerpt">' + esc(f.excerpt) + '</code>' : '') + '</li>';
      const acked = r && v.reviewAck && v.reviewAck.codeHash === v.codeHash;
      box.innerHTML = '<div class="xp-val-sec"><h4>Policy checks ' + (p ? (errs.length ? '<span class="badge badge-red">blocked</span>' : '<span class="badge badge-green">passed</span>') + (warns.length ? ' <span class="badge badge-amber">' + plural(warns.length, 'warning') + '</span>' : '') : '<span class="badge badge-gray">not checked yet</span>') + '</h4>' +
          (p ? (pf.length ? '<ul class="xp-findings">' + errs.concat(warns).map(finding).join('') + '</ul>' : '<p class="lab-muted">No findings (' + esc(p.policyVersion) + ', ' + esc(p.engine) + ').</p>')
            : '<p class="lab-muted">' + (v.language === 'python' ? 'Python is checked inside the sandbox before any of its code runs. Click Check to check it now.' : 'Click Check, or Run: the checks always run first.') + '</p>') + '</div>' +
        '<div class="xp-val-sec"><h4>AI security review ' + decisionBadge(r ? r.decision : null) + (acked ? ' <span class="badge badge-blue">you allowed running</span>' : '') + '</h4>' +
          (r ? (r.summary ? '<div class="xp-md">' + md(r.summary) + '</div>' : '') + (r.error ? '<p class="lab-warn">The review couldn\'t be made: ' + esc(r.error) + '</p>' : '') +
            (r.risks && r.risks.length ? '<ul class="xp-findings">' + r.risks.map(x => '<li class="xp-find xp-find-' + (x.severity === 'critical' || x.severity === 'high' ? 'error' : 'warning') + '"><span class="badge badge-gray">' + esc(x.severity) + '</span> ' + (x.line ? '<button type="button" class="xp-link" data-line="' + x.line + '">line ' + x.line + '</button> ' : '') + '<b>' + esc(x.category) + '</b>: ' + esc(x.explanation) + (x.excerpt ? '<code class="xp-excerpt">' + esc(x.excerpt) + '</code>' : '') + '</li>').join('') + '</ul>' : '') +
            (r.saferAlternative ? '<details class="lab-more"><summary>Safer alternative</summary><div class="xp-md">' + md(r.saferAlternative) + '</div></details>' : '') +
            '<p class="lab-muted">' + (r.model ? 'Reviewed by ' + esc(r.model) + ' · ' + when(r.reviewedAt) + '. ' : '') + 'The review is advisory: the policy checks and the sandbox enforce the limits.</p>' +
            ((r.decision === 'needs_review' || r.decision === 'unavailable') && !acked ? '<button class="btn btn-secondary btn-sm mt-2" id="xp-ack">I\'ve read this — allow running</button>' : '')
          : '<p class="lab-muted">Not reviewed yet: the review runs before the first run, or click Check.</p>') + '</div>';
      LabMarkdown.enhance(box, null);
      if ($('xp-ack')) $('xp-ack').onclick = acknowledge;
    }
    $('xp-validation').addEventListener('click', e => { const b = e.target.closest('[data-line]'); if (b && W.editor) W.editor.gotoLine(Number(b.dataset.line)); });

    /* ── Terminal ── */
    function runLabel(r) {
      return 'v' + r.version + ' · ' + when(r.createdAt) + ' · ' + String(r.status).replace(/_/g, ' ') + ' · ' + splitLabel(r.sandbox && r.sandbox.split);
    }
    function renderRunPick() {
      const v = cur(), sel = $('xp-run-pick');
      const mine = X.runs.filter(r => v && r.version === v.version), others = X.runs.filter(r => !v || r.version !== v.version);
      const opt = r => '<option value="' + esc(r.id) + '"' + (r.id === X.shownRunId ? ' selected' : '') + '>' + esc(runLabel(r)) + '</option>';
      sel.innerHTML = (X.runs.length ? '' : '<option value="">No runs yet</option>') + (mine.length ? '<optgroup label="Runs of v' + v.version + '">' + mine.map(opt).join('') + '</optgroup>' : '') +
        (others.length ? '<optgroup label="' + (v ? 'Other versions' : 'Runs') + '">' + others.map(opt).join('') + '</optgroup>' : '');
      if (X.shownRunId && !X.runs.some(r => r.id === X.shownRunId)) sel.insertAdjacentHTML('afterbegin', '<option value="" selected>—</option>');
      sel.disabled = !X.runs.length;
    }
    function termStatus(r) {
      const box = $('xp-term-status');
      if (!r) { box.textContent = X.runs.length ? '' : 'Run a version to see its log here.'; box.className = 'xp-term-status'; return; }
      const f = r.failure;
      const recs = r.sandbox ? plural(r.sandbox.recordCount, 'record') : '';
      const text = r.status === 'succeeded' ? 'Succeeded in ' + Lab.ms(r.timing && r.timing.durationMs) + ' · ' + recs
        : r.status === 'queued' ? 'Queued' : r.status === 'running' ? 'Running · ' + r.stage
        : r.status === 'blocked' ? 'Blocked at ' + (f ? f.stage : r.stage) + (f ? ': ' + f.message : '')
        : r.status === 'failed' ? 'Failed at ' + (f ? f.stage : r.stage) + (f ? ': ' + f.message : '')
        : r.status === 'cancelled' ? 'Cancelled' : r.status === 'interrupted' ? 'Interrupted: the server restarted during the run' : String(r.status);
      box.textContent = text;
      box.title = text;
      box.className = 'xp-term-status xp-ts-' + r.status;
    }
    const LEVELS = ['info', 'warn', 'error', 'success'];
    function lineEl(l) {
      const d = document.createElement('div');
      d.className = 'xp-line xp-l-' + (LEVELS.includes(l.level) ? l.level : 'info') + (l.stream === 'stdout' || l.stream === 'stderr' ? ' xp-io xp-' + l.stream : '');
      const t = document.createElement('span'); t.className = 'xp-lt'; t.textContent = '+' + ((num(l.t) || 0) / 1000).toFixed(1) + 's';
      const s = document.createElement('span'); s.className = 'xp-lstage'; s.textContent = '[' + String(l.stage || '') + ']';
      const x = document.createElement('span'); x.className = 'xp-ltext'; x.textContent = (l.stream === 'stderr' ? '! ' : l.stream === 'stdout' ? '> ' : '') + String(l.text === undefined ? '' : l.text);
      d.append(t, s, x);
      return d;
    }
    function appendLines(lines) {
      const body = $('xp-term-body');
      if (!body) return;
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      const frag = document.createDocumentFragment();
      (lines || []).forEach(l => { if (typeof l.seq === 'number' && l.seq <= W.lastSeq) return; if (typeof l.seq === 'number') W.lastSeq = l.seq; frag.appendChild(lineEl(l)); });
      body.appendChild(frag);
      while (body.childElementCount > 6000) body.firstElementChild.remove();
      if (atBottom) body.scrollTop = body.scrollHeight;
    }
    function termNote(text) { const n = $('xp-term-note'); n.hidden = !text; n.textContent = text || ''; }
    function upsertRun(r) {
      const i = X.runs.findIndex(x => x.id === r.id);
      const summary = Object.assign({}, r); delete summary.log;
      if (i >= 0) X.runs[i] = Object.assign(X.runs[i], summary); else X.runs.unshift(summary);
      X.runs = sortRuns(X.runs);
    }
    // Shows a run in the terminal (its whole log) and follows it while it's active
    async function showRun(runId) {
      clearTimeout(W.pollTimer); W.polling = null;
      X.shownRunId = runId || null;
      W.lastSeq = -1;
      $('xp-term-body').replaceChildren();
      termNote('');
      renderRunPick();
      termStatus(shownRun());
      refresh();
      if (!runId) { renderTab(); watchActive(); return; }
      if (ACTIVE.includes((shownRun() || {}).status)) renderTab();   // "Running…" in the tabs until it ends
      W.polling = runId;
      watchActive();
      await pollOnce(runId);
    }
    // The active run is followed even while the terminal shows another run (another version, or one picked in
    // the terminal): when it ends, the pill, the buttons and the version list follow it
    function watchActive() {
      clearTimeout(W.activeTimer);
      const a = activeRun();
      if (W.left || !a || W.polling === a.id) return;
      W.activeTimer = setTimeout(async () => {
        const ar = activeRun();
        if (W.left || !ar || W.polling === ar.id) return;
        try {
          const r = (await get('/xruns/' + encodeURIComponent(ar.id) + '?since=' + Number.MAX_SAFE_INTEGER)).run;   // its status, no log lines
          if (W.left || W.polling === ar.id) return;
          upsertRun(r);
          if (!ACTIVE.includes(r.status)) { renderRunPick(); await finished(r); return; }
          refresh();
        } catch (e) {
          if (W.left) return;
          if (e.status === 404) { X.runs = X.runs.filter(x => x.id !== ar.id); renderRunPick(); refresh(); }
        }
        watchActive();
      }, POLL_MS);
    }
    async function pollOnce(runId) {
      if (W.left || W.polling !== runId) return;
      let r;
      try {
        r = (await get('/xruns/' + encodeURIComponent(runId) + (W.lastSeq >= 0 ? '?since=' + W.lastSeq : ''))).run;
        W.pollFails = 0;
      } catch (e) {
        if (W.left || W.polling !== runId) return;
        if (e.status === 404) { termNote('This run no longer exists.'); W.polling = null; X.runs = X.runs.filter(x => x.id !== runId); renderRunPick(); refresh(); watchActive(); return; }
        W.pollFails++;
        if (W.pollFails >= 3) termNote('Lost contact with the server (' + e.message + '). Retrying…');
        W.pollTimer = setTimeout(() => pollOnce(runId), Math.min(5000, 600 * W.pollFails));
        return;
      }
      if (W.left || W.polling !== runId) return;
      termNote('');
      const wasActive = ACTIVE.includes((X.runs.find(x => x.id === runId) || {}).status);
      upsertRun(r);
      // The run's review and policy are shown as soon as their stage is done (the version on the server has them too)
      const v = cur();
      if (v && r.version === v.version && r.codeHash === v.codeHash && r.security) {
        let changed = false;
        if (!v.review && r.security.review) { v.review = r.security.review; changed = true; }
        if (!v.policy && r.security.policy) { v.policy = r.security.policy; changed = true; }
        if (changed) renderValidation();
      }
      appendLines(r.log);
      termStatus(r);
      renderRunPick();
      refresh();
      if (ACTIVE.includes(r.status)) { W.pollTimer = setTimeout(() => pollOnce(runId), POLL_MS); return; }
      W.polling = null;
      watchActive();   // (another run may still be active)
      if (wasActive) await finished(r);
      else renderTab();
    }
    // A run ended while we watched: reload the experiment (versions now carry its policy, review and lastRun)
    async function finished(r) {
      try { await reload(true, true); } catch (e) { if (!W.left) notify(e.message, 'error'); }
      if (W.left) return;
      if (r.status === 'succeeded' && cur() && r.version === cur().version) { X.preview.offset = 0; if (X.tab !== 'preview' && X.tab !== 'metrics') selectTab('preview'); }
      renderTab();
      refresh();
      keepFocus('xp-run');
      notify(r.status === 'succeeded' ? 'Run succeeded' : r.status === 'blocked' ? 'Run blocked — see the checks' : 'Run ' + r.status, r.status === 'succeeded' ? 'success' : 'error', 4000);
    }
    async function reload(keepRun, noTab) {
      const d = await get(base);
      if (W.left) return;
      X.exp = d.experiment; X.runs = sortRuns(d.runs); X.sandbox = d.sandbox || X.sandbox;
      renderThread();
      if (!ver(X.current)) X.current = latest() ? latest().version : null;
      loadVersion(X.current, { keepText: true, keepRun: !!keepRun, noTab: !!noTab });
      if (keepRun) termStatus(shownRun());
    }

    /* ── Actions ── */
    function inputHint(msg) { notify(msg, 'error', 6000); $('xp-input').focus(); }
    async function generate(mode) {
      const prompt = $('xp-input').value.trim();
      if (!prompt) { inputHint(mode === 'new' ? 'Describe the rule you want first.' : 'Describe what to change first.'); return; }
      if (isDirty() && !(await confirmDanger('Discard your edits?', 'The new version replaces what is in the editor. Your unsaved edits' + (cur() ? ' to v' + cur().version : '') + ' are discarded — save them first to keep them.', 'Discard and generate'))) return;
      const [provider, model] = ($('xp-model').value || '').split('|');
      const body = { prompt, mode };
      if (provider) { body.provider = provider; body.model = model; }
      if (mode !== 'new' && cur()) body.baseVersion = cur().version;
      setPhase('generating');
      try {
        const r = await post(base + '/generate', body);
        if (W.left) return;
        X.exp = r.experiment;
        $('xp-input').value = '';
        clearDraft();
        W.fresh = r.version.version;
        W.phase = null;
        renderThread();
        loadVersion(r.version.version);
        notify('Created v' + r.version.version, 'success');
      } catch (e) {
        if (W.left) return;
        W.phase = null;
        notify(e.message, 'error', 8000);
        get(base).then(d => { if (!W.left) { X.exp.thread = d.experiment.thread; renderThread(); } }).catch(() => {});
      } finally { if (!W.left) { refresh(); keepFocus('xp-input'); } }
    }
    async function ask() {
      const prompt = $('xp-input').value.trim();
      if (!prompt) { inputHint('Write your question first.'); return; }
      const [provider, model] = ($('xp-model').value || '').split('|');
      const body = { prompt };
      if (provider) { body.provider = provider; body.model = model; }
      if (cur()) body.version = cur().version;
      W.asking = true; refresh();
      $('xp-thread').insertAdjacentHTML('beforeend', '<div class="xp-msg xp-msg-user"><div class="xp-msg-text">' + esc(prompt) + '</div></div><p class="lab-muted" id="xp-waiting">Waiting for the model…</p>');
      $('xp-thread').scrollTop = $('xp-thread').scrollHeight;
      try {
        const r = await post(base + '/ask', body);
        if (W.left) return;
        X.exp = r.experiment;
        $('xp-input').value = '';
      } catch (e) { if (!W.left) notify(e.message, 'error', 8000); }
      finally { if (!W.left) { W.asking = false; renderThread(); refresh(); keepFocus('xp-input'); } }
    }
    // Saves the editor as a new version → the version, or null
    async function saveVersion(origin, extra) {
      if (!W.editor) return null;
      const v = cur();
      const body = Object.assign({ code: W.editor.getValue(), language: W.lang, parent: v ? v.version : null, origin }, extra || {});
      try {
        const r = await post(base + '/versions', body);
        if (W.left) return null;
        X.exp = r.experiment;
        clearDraft();
        W.fresh = null;
        loadVersion(r.version.version, { keepText: origin === 'edited' });
        notify('Saved as v' + r.version.version, 'success');
        // Code saved in another language: new AI versions are written in it too
        if (r.version.language !== exp().language) patch(base, { language: r.version.language }).then(x => { if (!W.left && x && x.experiment) X.exp = x.experiment; }).catch(() => {});
        return r.version;
      } catch (e) {
        if (W.left) return null;
        if (e.status === 409 && e.type === 'unchanged') notify('Nothing changed — no new version.', 'info');
        else notify(e.message, 'error', 8000);
        return null;
      }
    }
    async function save() { setPhase('saving'); try { await saveVersion('edited'); } finally { if (!W.left) { setPhase(null); keepFocus('xp-run'); } } }
    // Run: the stored version and its hash. Save & run: save first, then run exactly that new version.
    async function run() {
      if (activeRun() || !W.editor) return;
      let v = cur();
      if (isDirty()) {
        setPhase('saving-run');
        v = await saveVersion('edited');
        if (W.left) return;
        if (!v) { setPhase(null); return; }
      } else if (!v) return;
      await startRun(v.version, v.codeHash, $('xp-split').value);
    }
    async function startRun(version, codeHash, split) {
      setPhase('starting');
      termNote('');
      try {
        const r = await post(base + '/runs', { version, codeHash, split });
        if (W.left) return;
        W.fresh = null; W.resultsFor = null;
        upsertRun(r.run);
        W.phase = null;
        // The run shows in the terminal, below the editor: bring it into view when it is off-screen
        const term = $('xp-terminal').getBoundingClientRect();
        if (term.top > window.innerHeight - 120 || term.bottom < 0) $('xp-terminal').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        await showRun(r.run.id);
        keepFocus('xp-cancel', true);
      } catch (e) {
        if (W.left) return;
        W.phase = null;
        const other = e.body && e.body.error && (e.body.error.runId || e.body.error.run);
        if (e.status === 409 && e.type === 'run_in_progress') {
          termNote('Not started: ' + e.message);
          if (typeof other === 'string') { await reload(true); showRun(other); }
        } else if (e.status === 409 && e.type === 'stale_code') {
          termNote('Not started: ' + e.message + ' The workspace was reloaded; check the code and run again.');
          await reload();
        } else termNote('Not started: ' + e.message);
        refresh();
      }
    }
    async function cancelRun() {
      const r = activeRun();
      if (!r) return;
      $('xp-cancel').disabled = true;
      try { await post('/xruns/' + encodeURIComponent(r.id) + '/cancel'); }
      catch (e) { notify(e.message, 'error'); }
      // The run's end is picked up by polling it now (like any run that ends): the terminal, the
      // version's "last run" and the tabs follow the server
      finally { if (!W.left) { $('xp-cancel').disabled = false; if (W.polling !== r.id) showRun(r.id); else { clearTimeout(W.pollTimer); pollOnce(r.id); } } }
    }
    async function check() {
      const v = cur();
      if (!v) return;
      setPhase('reviewing');
      try {
        const r = await post(base + '/versions/' + v.version + '/check');
        if (W.left) return;
        if (r.policy) v.policy = r.policy;
        if (r.review) v.review = r.review;
        renderValidation();
        if (r.policyError) notify('The Python checks couldn\'t run: ' + r.policyError.message, 'error', 8000);
        else notify(blocked(v) ? 'Checked: blocked — see the findings' : 'Checked', blocked(v) ? 'warning' : 'success');
      } catch (e) { if (!W.left) notify(e.message, 'error', 8000); }
      finally { if (!W.left) { setPhase(null); keepFocus('xp-run'); } }
    }
    async function acknowledge() {
      const v = cur();
      if (!v) return;
      setPhase('reviewing');
      try { await post(base + '/versions/' + v.version + '/acknowledge', { codeHash: v.codeHash }); if (!W.left) { await reload(true); notify('Running v' + v.version + ' is allowed', 'success'); } }
      catch (e) { if (!W.left) notify(e.message, 'error', 8000); }
      finally { if (!W.left) { setPhase(null); keepFocus('xp-run'); } }
    }
    async function switchVersion(n) {
      if (n === X.current) return;
      if (isDirty() && !(await confirmDanger('Discard your edits?', 'Your unsaved edits' + (cur() ? ' to v' + cur().version : '') + ' are discarded.', 'Discard edits'))) { renderVersionSelect(); return; }
      clearDraft();
      W.fresh = null;
      loadVersion(n);
    }
    function reset() { const v = cur(); if (!W.editor) return; W.editor.setValue(v ? v.code : W.template); if (v) { W.lang = v.language; W.editor.setLanguage(v.language); $('xp-lang').value = v.language; } clearDraft(); renderValidation(); refresh(); W.editor.focus(); }
    async function diffParent() {
      const v = cur();
      const dirty = isDirty();
      const a = dirty ? (v ? v.code : W.template) : ver(v.parent).code;
      const b = dirty ? W.editor.getValue() : v.code;
      const labels = dirty ? [v ? 'v' + v.version + ' (saved)' : 'Template', 'Your edits'] : ['v' + v.parent, 'v' + v.version];
      openModal(labels[0] + ' → ' + labels[1], '<p class="lab-muted">Left: ' + esc(labels[0]) + ' · right: ' + esc(labels[1]) + '. Comparing doesn\'t run anything.</p><div class="xp-merge xp-merge-modal" id="xp-diff-host"></div>');
      if (W.merge) { try { W.merge.destroy(); } catch (e) { /* */ } }
      W.merge = await makeMerge($('xp-diff-host'), a, b, W.lang, labels);
    }
    async function duplicate() {
      const v = cur();
      if (!v) return;
      $('xp-duplicate').disabled = true;
      try { const r = await post(base + '/versions', { code: v.code, language: v.language, parent: v.version, origin: 'duplicated' }); if (!W.left) { X.exp = r.experiment; loadVersion(r.version.version); notify('Duplicated as v' + r.version.version, 'success'); } }
      catch (e) { if (!W.left) notify(e.message, 'error', 8000); }
      finally { if (!W.left) refresh(); }
    }
    async function restore() {
      const v = cur();
      if (!v) return;
      $('xp-restore').disabled = true;
      try { const r = await post(base + '/versions', { code: v.code, language: v.language, parent: v.version, origin: 'reverted', label: 'Restored v' + v.version }); if (!W.left) { X.exp = r.experiment; loadVersion(r.version.version); notify('Restored v' + v.version + ' as v' + r.version.version, 'success'); } }
      catch (e) { if (!W.left) notify(e.message, 'error', 8000); }
      finally { if (!W.left) refresh(); }
    }

    /* ── Unsaved drafts (sessionStorage) ── */
    function saveDraft() {
      if (!W.editor) return;
      if (!isDirty()) { storageSet('sessionStorage', draftKey, null); return; }
      storageSet('sessionStorage', draftKey, JSON.stringify({ version: X.current, language: W.lang, code: W.editor.getValue(), at: new Date().toISOString() }));
    }
    function clearDraft() { clearTimeout(W.draftTimer); storageSet('sessionStorage', draftKey, null); const n = $('xp-draft'); if (n) n.remove(); }
    function offerDraft() {
      let d = null;
      try { d = JSON.parse(storageGet('sessionStorage', draftKey) || 'null'); } catch (e) { d = null; }
      if (!d || typeof d.code !== 'string') return;
      const v = d.version === null ? null : ver(d.version);
      if (d.version !== null && !v) { clearDraft(); return; }
      if (v ? v.code === d.code && v.language === d.language : d.code === template(d.language)) { clearDraft(); return; }
      $('xp-notice').insertAdjacentHTML('beforeend', '<div class="lab-warn xp-notice" id="xp-draft" role="status">You have unsaved edits' + (v ? ' to v' + v.version : '') + ' from ' + when(d.at) + '. <button class="btn btn-secondary btn-sm" id="xp-draft-restore">Restore them</button> <button class="btn btn-ghost btn-sm" id="xp-draft-discard">Discard</button></div>');
      $('xp-draft-restore').onclick = () => { $('xp-draft').remove(); loadVersion(d.version, { code: d.code, lang: LANGS.includes(d.language) ? d.language : undefined }); $('xp-lang').value = W.lang; saveDraft(); renderValidation(); refresh(); W.editor.focus(); };
      $('xp-draft-discard').onclick = () => { clearDraft(); keepFocus('xp-input'); };
    }

    /* ── Right panel: tabs ── */
    function selectTab(k) {
      X.tab = k;
      main.querySelectorAll('[data-xtab]').forEach(b => { const on = b.dataset.xtab === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      ['preview', 'metrics', 'eval', 'final'].forEach(x => { $('xp-' + x).hidden = x !== k; });
    }
    main.querySelectorAll('[data-xtab]').forEach(b => {
      b.onclick = () => { selectTab(b.dataset.xtab); renderTab(); };
      b.onkeydown = e => {
        const tabs = Array.from(main.querySelectorAll('[data-xtab]'));
        const i = tabs.indexOf(b), n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (n === null) return;
        e.preventDefault();
        const t = tabs[(n + tabs.length) % tabs.length];
        t.focus(); selectTab(t.dataset.xtab); renderTab();
      };
    });
    function renderTab() {
      if (W.left) return;
      W.tabSeq++;
      const k = X.tab;
      Lab.background(k === 'preview' ? renderPreview() : k === 'metrics' ? renderMetrics() : k === 'eval' ? renderEval() : renderFinal());
    }
    // The run whose results the tabs show: the shown run when it succeeded
    function resultRun() { const r = shownRun(); return r && r.status === 'succeeded' ? r : null; }
    // The pill says "Results ready" once a tab shows the run's validated results or metrics
    function markResults(r) { if (r && W.resultsFor !== r.id) { W.resultsFor = r.id; refresh(); } }
    function runNote(r) {
      const v = cur();
      return r && v && (r.version !== v.version || r.codeHash !== v.codeHash) ? '<div class="lab-note mb-3">Showing a run of v' + r.version + ', not of the version in the editor.</div>' : '';
    }
    function noRun(box) {
      const r = shownRun();
      box.innerHTML = '<div class="lab-empty"><h3>' + (r && ACTIVE.includes(r.status) ? 'Running…' : r ? 'This run has no results' : 'No results yet') + '</h3><p>' +
        (r && ACTIVE.includes(r.status) ? 'Results appear when the run succeeds.' : r ? 'Only a run that succeeded, with output that passed validation, has results. See the terminal for what happened.' : 'Run a version to see how it codes the sandbox records.') + '</p></div>';
    }

    /* Preview: the coding interface, built only from the validated results endpoint */
    const FILTERS = [['all', 'All'], ['changed', 'Changed vs current AI coding'], ['wrong', 'Wrong vs reference'], ['errors', 'Errors'], ['nocode', 'No code']];
    async function renderPreview() {
      const box = $('xp-preview'), r = resultRun();
      if (!r) { noRun(box); if (W.resultsFor) { W.resultsFor = null; refresh(); } return; }
      const P = X.preview;
      const others = X.runs.filter(x => x.id !== r.id && x.status === 'succeeded' && x.sandbox && r.sandbox && x.sandbox.version === r.sandbox.version);
      if (P.against !== 'baseline' && !others.some(x => x.id === P.against)) P.against = 'baseline';
      const againstName = P.against === 'baseline' ? 'current AI coding' : 'v' + (others.find(x => x.id === P.against) || {}).version + ' run';
      const noRefs = X.sandbox && X.sandbox.referenceCount === 0;
      const qs = new URLSearchParams({ filter: P.filter, against: P.against, offset: String(P.offset), limit: String(PAGE) });
      const tok = ++W.tabSeq;
      const res = await get('/xruns/' + encodeURIComponent(r.id) + '/results?' + qs);
      if (W.left || !box.isConnected || tok !== W.tabSeq || (resultRun() || {}).id !== r.id || X.tab !== 'preview') return;
      const results = res.results || [], total = num(res.total) || 0;
      const refLabel = X.sandbox && X.sandbox.source && X.sandbox.source.kind === 'dataset' ? 'Reference: ' : 'Human: ';
      box.innerHTML = runNote(r) +
        '<div class="xp-pv-head"><div class="xp-filters" role="group" aria-label="Show">' + FILTERS.map(([k, l]) => '<button type="button" class="xp-filter" data-pf="' + k + '" aria-pressed="' + (P.filter === k) + '"' + (k === 'wrong' && noRefs ? ' disabled title="No reference labels in this sandbox"' : '') + '>' + esc(k === 'changed' ? 'Changed vs ' + againstName : l) + '</button>').join('') + '</div>' +
          '<label class="xp-inline">Compare with <select class="form-select" id="xp-against"><option value="baseline">Current AI coding</option>' + others.map(x => '<option value="' + esc(x.id) + '"' + (x.id === P.against ? ' selected' : '') + '>' + esc(runLabel(x)) + '</option>').join('') + '</select></label></div>' +
        '<div id="xp-dist" class="xp-dist"></div>' +
        (results.length ? '<div class="xp-recs">' + results.map(x => '<article class="xp-rec' + (x.changed ? ' is-changed' : '') + (x.error ? ' is-error' : '') + '">' +
            '<header>' + chip(variable(), x.error ? null : x.code) + (num(x.confidence) !== null ? '<span class="xp-conf" title="Confidence the rule reported">' + dec(x.confidence) + '</span>' : '') +
              (x.changed ? '<span class="xp-changed-from">changed from ' + chip(variable(), x.against) + '</span>' : '') +
              '<span class="xp-rec-id lab-mono">' + esc(x.id) + '</span>' + (x.split ? '<span class="badge badge-gray">' + (x.split === 'test' ? 'held-out' : 'dev') + '</span>' : '') + '</header>' +
            '<p class="xp-rec-text">' + esc(x.text) + '</p>' +
            (x.author ? '<p class="lab-muted">' + esc(x.author) + '</p>' : '') +
            (x.reason ? '<p class="xp-rec-reason"><span class="lab-muted">Reason:</span> ' + esc(x.reason) + '</p>' : '') +
            (x.error ? '<pre class="xp-rec-err">' + esc(x.error) + '</pre>' : '') +
            '<footer>' + (x.reference ? '<span class="xp-ref">' + chip(variable(), x.reference, refLabel) + (x.reference === (x.error ? null : x.code) ? ' <span class="lab-pass">✓ matches</span>' : ' <span class="lab-fail">✗ differs</span>') + '</span>' : '<span class="lab-muted">no reference label</span>') + '</footer>' +
          '</article>').join('') + '</div>' +
          '<div class="lab-actions mt-3"><span class="lab-muted">' + fmt(P.offset + 1) + '–' + fmt(P.offset + results.length) + ' of ' + fmt(total) + '</span>' +
            (P.offset > 0 ? '<button class="btn btn-ghost btn-sm" id="xp-prev">Previous</button>' : '') + (P.offset + results.length < total ? '<button class="btn btn-ghost btn-sm" id="xp-next">Next</button>' : '') + '</div>'
          : '<p class="lab-muted mt-3">No records in this view.</p>') +
        '<p class="lab-muted mt-3">Built from the run\'s validated results. The preview shows text only and runs nothing.</p>';
      box.querySelectorAll('[data-pf]').forEach(b => { b.onclick = () => { P.filter = b.dataset.pf; P.offset = 0; Lab.background(renderPreview()); }; });
      $('xp-against').onchange = e => { P.against = e.target.value; P.offset = 0; Lab.background(renderPreview()); };
      if ($('xp-prev')) $('xp-prev').onclick = () => { P.offset = Math.max(0, P.offset - PAGE); Lab.background(renderPreview()); };
      if ($('xp-next')) $('xp-next').onclick = () => { P.offset += PAGE; Lab.background(renderPreview()); };
      markResults(r);
      Lab.background(renderDistribution(r, P.against, againstName));
    }
    // Codes per code: this run vs the comparison (counted from the results, or from the other run's metrics)
    async function renderDistribution(r, against, againstName) {
      const box = $('xp-dist');
      const mine = (r.metrics && r.metrics.distribution) || null;
      if (!mine || !box) return;
      const key = r.id + '|' + against;
      let cmp = X.dist[key];
      if (cmp === undefined) {
        cmp = null;
        const total = r.sandbox ? r.sandbox.recordCount : 0;
        if (total && total <= 2000) {
          try {
            const counts = {};
            for (let offset = 0; offset < total; offset += 100) {
              const page = await get('/xruns/' + encodeURIComponent(r.id) + '/results?' + new URLSearchParams({ filter: 'all', against, offset: String(offset), limit: '100' }));
              (page.results || []).forEach(x => { const c = x.against === null || x.against === undefined ? NONE : x.against; counts[c] = (counts[c] || 0) + 1; });
              if (!page.results || page.results.length < 100) break;
            }
            cmp = counts;
          } catch (e) { cmp = null; }
        } else if (against !== 'baseline') {
          const o = X.runs.find(x => x.id === against);
          cmp = o && o.metrics ? o.metrics.distribution : null;
        }
        X.dist[key] = cmp;
      }
      if (!box.isConnected) return;
      const cats = variable().codes.map(c => c.id).concat([NONE]);
      const max = Math.max(1, ...cats.map(c => Math.max(mine[c] || 0, cmp ? cmp[c] || 0 : 0)));
      box.innerHTML = '<div class="xp-dist-legend"><span><i class="xp-sw xp-sw-run"></i>This run</span>' + (cmp ? '<span><i class="xp-sw xp-sw-cmp"></i>' + esc(againstName.charAt(0).toUpperCase() + againstName.slice(1)) + '</span>' : '<span class="lab-muted">Comparison counts aren\'t available for a sandbox this large.</span>') + '</div>' +
        cats.map(c => { const i = codeIndex(variable(), c); return '<div class="xp-dist-row"><span class="xp-dist-label">' + esc(codeName(variable(), c)) + '</span><span class="xp-dist-bars">' +
          '<span class="xp-bar ' + (i < 0 ? 'xp-c-none' : 'xp-c' + (i % 10)) + '" style="width:' + Math.round((mine[c] || 0) / max * 100) + '%"></span>' + (cmp ? '<span class="xp-bar xp-bar-cmp" style="width:' + Math.round((cmp[c] || 0) / max * 100) + '%"></span>' : '') + '</span>' +
          '<span class="xp-dist-n">' + fmt(mine[c] || 0) + (cmp ? ' · ' + fmt(cmp[c] || 0) : '') + '</span></div>'; }).join('');
    }

    /* Metrics: measured numbers with their n */
    async function renderMetrics() {
      const box = $('xp-metrics'), r = resultRun();
      if (!r || !r.metrics) { noRun(box); return; }
      const m = r.metrics;
      const refs = m.reference;
      const pick = X.refSplit === 'auto' ? scoringRef(m) : refs && refs[X.refSplit] ? { s: refs[X.refSplit], split: X.refSplit } : null;
      const s = pick ? pick.s : null;
      const splitName = pick ? (pick.split === 'test' ? 'held-out' : pick.split === 'dev' ? 'dev' : 'all labelled') : '';
      // Each card: the measured value and its n (definitions are below, under "Definitions")
      const card = (value, label, def, n, extra) => '<div class="lab-metric" title="' + esc(def) + '"><b>' + value + '</b><span>' + esc(label) + '</span><small>' + (value === '—' ? 'not measured' + (extra ? ': ' + esc(extra) : '') : esc(n) + ' · measured') + '</small></div>';
      // The headline and its parts from the same, current criteria (the run's score from the server is from the criteria saved when the runs were loaded)
      const score = scoreRun(m, exp().objective && exp().objective.criteria);
      const cats = s && s.confusion ? s.confusion.categories : null;
      box.innerHTML = runNote(r) +
        (refs ? '' : '<div class="lab-warn mb-3">This sandbox has no reference labels, so accuracy, F1 and κ can\'t be measured. Coverage, errors, consistency and agreement with the current AI coding still can.</div>') +
        (refs ? '<div class="lab-actions mb-3"><label class="xp-inline" for="xp-ref-split">Reference records</label><select class="form-select" id="xp-ref-split">' +
          [['auto', 'Held-out (test) when there are any'], ['test', 'Held-out (test)'], ['dev', 'Dev (shown to the AI)'], ['all', 'All labelled']].map(([k, l]) => '<option value="' + k + '"' + (X.refSplit === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>' : '') +
        '<div class="lab-metrics">' +
          card(s ? pct(s.accuracy) : '—', (pick && pick.split === 'test' ? 'Held-out accuracy' : 'Accuracy (' + (splitName || 'reference') + ')'), DEFS.accuracy[2], s ? 'n = ' + fmt(s.n) + ' ' + splitName + ' records' : '', refs ? 'no labelled records here' : 'no reference labels') +
          card(s ? dec(s.macroF1) : '—', 'Macro-F1', DEFS.macroF1[2], s ? 'n = ' + fmt(s.n) : '', refs ? '' : 'no reference labels') +
          card(s && num(s.kappa) !== null ? dec(s.kappa) : '—', 'Cohen\'s κ', DEFS.kappa[2], s ? 'n = ' + fmt(s.n) : '', s && s.kappaReason ? s.kappaReason : refs ? '' : 'no reference labels') +
          card(pct(m.coverage), 'Coverage', DEFS.coverage[2], 'n = ' + fmt(m.processed) + ' records') +
          card(pct(m.errorRate), 'Error rate', DEFS.errorRate[2], fmt(m.errors) + ' of ' + fmt(m.processed) + ' records') +
          card(m.baseline ? pct(m.baseline.agreement) : '—', 'Agreement with current AI coding', DEFS.baselineAgreement[2], m.baseline ? 'n = ' + fmt(m.baseline.n) + ' · ' + fmt(m.baseline.changed) + ' changed' : '', 'no current AI coding labels') +
          card(m.consistency && num(m.consistency.score) !== null ? pct(m.consistency.score) : '—', 'Consistency', DEFS.consistency[2], m.consistency ? plural(m.consistency.groups, 'group') + ' of repeated text · ' + fmt(m.consistency.inconsistent) + ' inconsistent' : '', 'no repeated texts') +
          card(Lab.ms(m.runtime && m.runtime.durationMs), 'Runtime', DEFS.runtime[2], m.runtime && num(m.runtime.perRecordMeanMs) !== null ? dec(m.runtime.perRecordMeanMs, 3) + ' ms per record' : fmt(m.processed) + ' records') +
        '</div>' +
        '<h4 class="xp-h4">Objective score</h4><div class="xp-score"><b>' + (score.score === null ? '—' : dec(score.score)) + '</b><span class="lab-muted">' + esc(DEFS.objectiveScore[2]) + '</span></div>' +
        '<div class="table-wrap"><table class="table"><thead><tr><th>Criterion</th><th>Weight</th><th>Value (0–1)</th><th></th></tr></thead><tbody>' +
          score.parts.map(p => '<tr><td>' + esc(metricLabel(p.metric, variable())) + '</td><td>' + esc(String(p.weight)) + '</td><td>' + (p.value === null ? '—' : dec(p.value)) + '</td><td>' + (p.used ? '<span class="lab-pass">used</span>' : p.metric === 'runtime' ? '<span class="lab-muted">shown, not scored</span>' : p.value === null ? '<span class="lab-muted">not measurable</span>' : '<span class="lab-muted">weight 0</span>') + '</td></tr>').join('') +
        '</tbody></table></div>' +
        (s ? '<h4 class="xp-h4">Per code (' + esc(splitName) + ', n = ' + fmt(s.n) + ')</h4><div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>Precision</th><th>Recall</th><th>F1</th><th>Support</th></tr></thead><tbody>' +
            variable().codes.map(c => { const x = (s.perCode || {})[c.id] || {}; return '<tr><td>' + chip(variable(), c.id) + '</td><td>' + dec(x.precision) + '</td><td>' + dec(x.recall) + '</td><td>' + dec(x.f1) + '</td><td>' + fmt(x.support || 0) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') +
        (cats ? '<h4 class="xp-h4">Confusion matrix (' + esc(splitName) + ')</h4><p class="lab-muted">' + esc(DEFS.confusion[2]) + '</p><div class="table-wrap"><table class="table xp-confusion"><thead><tr><th>Reference ↓ · Rule →</th>' + cats.map(c => '<th>' + esc(codeName(variable(), c)) + '</th>').join('') + '</tr></thead><tbody>' +
            cats.map((rc, i) => '<tr><th>' + esc(codeName(variable(), rc)) + '</th>' + cats.map((cc, j) => '<td class="' + (i === j ? 'xp-diag' : (s.confusion.matrix[i] || [])[j] ? 'xp-off' : '') + '">' + fmt((s.confusion.matrix[i] || [])[j] || 0) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '') +
        '<h4 class="xp-h4">Output and run</h4><dl class="lab-kv">' +
          '<dt>Output validation</dt><dd>' + (r.output ? (r.output.valid ? 'valid · ' : 'invalid · ') + fmt(r.output.checked) + ' checked' : '—') + '</dd>' +
          '<dt>Records</dt><dd>' + fmt(r.sandbox && r.sandbox.recordCount) + ' (' + esc(splitLabel(r.sandbox && r.sandbox.split)) + ') · sandbox v' + esc(String(r.sandbox && r.sandbox.version)) + ' sha256 ' + shortHash(r.sandbox && r.sandbox.sha256) + '…</dd>' +
          '<dt>Engine</dt><dd>' + esc(r.engine ? r.engine.name + ' ' + r.engine.version : '—') + '</dd>' +
          (r.isolation ? '<dt>Isolation</dt><dd>' + ['process', 'network', 'filesystem', 'environment', 'limits'].map(k => esc(r.isolation[k])).join('<br>') + '</dd>' : '') +
          '<dt>Time</dt><dd>' + Lab.ms(r.timing && r.timing.durationMs) + (r.timing && num(r.timing.bootMs) !== null ? ' (start-up ' + Lab.ms(r.timing.bootMs) + ')' : '') + '</dd>' +
          (r.resources ? '<dt>Memory</dt><dd>' + bytes(r.resources.rssBytes) + ' process · ' + bytes(r.resources.engineMemoryBytes) + ' engine</dd><dt>Output</dt><dd>' + bytes(r.resources.outputBytes) + ' results · ' + bytes(r.resources.logBytes) + ' log</dd>' : '') +
          '<dt>Code</dt><dd>v' + r.version + ' · ' + esc(langLabel(r.language)) + ' · sha256 ' + shortHash(r.codeHash) + '…</dd></dl>' +
        '<details class="lab-more"><summary>Definitions</summary><dl class="lab-kv xp-defs">' + ['heldOut', 'accuracy', 'macroF1', 'kappa', 'precision', 'recall', 'f1', 'coverage', 'errorRate', 'baselineAgreement', 'consistency', 'runtime', 'objectiveScore'].map(k => '<dt>' + esc(DEFS[k][0]) + '</dt><dd>' + esc(DEFS[k][2]) + '</dd>').join('') + '</dl></details>';
      if ($('xp-ref-split')) $('xp-ref-split').onchange = e => { X.refSplit = e.target.value; Lab.background(renderMetrics()); };
      markResults(r);
    }

    /* AI evaluation: an interpretation of the measured numbers, labelled as such */
    function evaluationHTML(ev) {
      const sec = (title, text) => '<h4 class="xp-h4">' + esc(title) + '</h4><div class="xp-md">' + (text ? md(text) : '<p class="lab-muted">—</p>') + '</div>';
      const ag = ev.against || {};
      return '<div class="xp-eval-head">' + recBadge(ev.recommendation) + ' <span class="lab-muted">against ' + esc(ag.kind === 'baseline' ? 'current AI coding' : ag.kind === 'version' ? 'v' + ag.version : 'nothing') + ' · ' + esc(ev.model || '') + ' · ' + when(ev.createdAt) + '</span></div>' +
        '<div class="lab-note mt-2">AI interpretation — check it against the measured numbers.</div>' +
        (ev.unverifiedNumbers && ev.unverifiedNumbers.length ? '<div class="lab-warn mt-2" role="alert"><b>Numbers that don\'t match a measured value:</b> ' + ev.unverifiedNumbers.map(esc).join(', ') + '. Trust the Metrics tab, not these.</div>' : '') +
        sec('Proposed improvement', ev.proposedImprovement) + sec('Reasoning', ev.reasoning) + sec('Observed results', ev.observedResults) + sec('Comparison', ev.comparison) +
        sec('Trade-offs', ev.tradeoffs) + sec('Limitations', ev.limitations) + '<h4 class="xp-h4">Recommendation</h4><p>' + recBadge(ev.recommendation) + '</p>';
    }
    async function renderEval() {
      const box = $('xp-eval'), r = resultRun();
      if (!r) { noRun(box); return; }
      const v = ver(r.version);
      const opts = [['baseline', 'Current AI coding']].concat(versions().filter(x => x.version !== r.version && x.lastRun && x.lastRun.status === 'succeeded').map(x => [String(x.version), 'v' + x.version])).concat([['none', 'Nothing (this run alone)']]);
      if (!opts.some(o => o[0] === X.evalAgainst)) X.evalAgainst = 'baseline';
      const ev = v && v.evaluation;
      box.innerHTML = runNote(r) + '<p class="lab-second">A model reads this run\'s measured metrics, the comparison counts and a few changed dev records, and writes an interpretation. It doesn\'t run anything and can be wrong.</p>' +
        '<div class="lab-actions mt-2"><label class="xp-inline" for="xp-eval-against">Against</label><select class="form-select" id="xp-eval-against">' + opts.map(([k, l]) => '<option value="' + esc(k) + '"' + (k === X.evalAgainst ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
          '<button class="btn btn-primary btn-sm" id="xp-evaluate">Evaluate this run</button></div><div id="xp-eval-out" class="mt-3" aria-live="polite">' +
        (ev ? (ev.runId !== r.id ? '<div class="lab-note mb-3">This evaluation is of another run of v' + r.version + '.</div>' : '') + evaluationHTML(ev) : '<p class="lab-muted">No evaluation of v' + r.version + ' yet.</p>') + '</div>';
      LabMarkdown.enhance(box, null);
      $('xp-eval-against').onchange = e => { X.evalAgainst = e.target.value; };
      $('xp-evaluate').onclick = async () => {
        const btn = $('xp-evaluate');
        const [provider, model] = ($('xp-model').value || '').split('|');
        const body = { against: X.evalAgainst === 'baseline' || X.evalAgainst === 'none' ? X.evalAgainst : Number(X.evalAgainst) };
        if (provider) { body.provider = provider; body.model = model; }
        btn.disabled = true; $('xp-eval-out').innerHTML = '<p class="lab-muted">Waiting for the model…</p>';
        try {
          const x = await post(base + '/versions/' + r.version + '/evaluate', body);
          if (W.left) return;
          if (v) v.evaluation = x.evaluation;
          $('xp-eval-out').innerHTML = evaluationHTML(x.evaluation);
          LabMarkdown.enhance($('xp-eval-out'), null);
        } catch (e) { if (!W.left) $('xp-eval-out').innerHTML = '<div class="lab-error" role="alert">' + esc(e.message) + '</div>'; }
        finally { if (!W.left && $('xp-evaluate')) { btn.disabled = false; refresh(); } }
      };
      refresh();
    }

    /* Finalize: select a version, then send it to the Codebook */
    function selectable(v) {
      const lr = v && v.lastRun;
      const runOk = lr && lr.status === 'succeeded' && X.runs.some(x => x.id === lr.id && x.sandbox && x.sandbox.version === exp().sandboxVersion && x.codeHash === v.codeHash && (!x.output || x.output.valid !== false));
      return [
        [!!runOk, 'Its last run succeeded with valid output on sandbox v' + exp().sandboxVersion],
        [!!(v && (v.policy ? v.policy.ok !== false && !(v.policy.findings || []).some(f => f.severity === 'error') : false)), 'Policy checks passed'],
        [!!(v && v.review && v.review.decision !== 'rejected'), 'The AI review didn\'t reject it']
      ];
    }
    async function renderFinal() {
      const box = $('xp-final'), v = cur(), sel = exp().selected;
      const sv = sel ? ver(sel.version) : null;
      const sr = sel ? X.runs.find(x => x.id === sel.runId) : null;
      const m = sr && sr.metrics, ref = scoringRef(m);
      const checks = v ? selectable(v) : [];
      box.innerHTML = (sel ? '<div class="card xp-final-card"><div class="card-title">Final version: v' + sel.version + '</div><dl class="lab-kv">' +
            '<dt>Language</dt><dd>' + esc(langLabel(sv ? sv.language : '')) + '</dd><dt>Code</dt><dd class="lab-mono">sha256 ' + shortHash(sel.codeHash) + '…</dd>' +
            '<dt>Run</dt><dd>' + (sr ? esc(runLabel(sr)) : esc(sel.runId)) + '</dd>' +
            (m ? '<dt>Measured</dt><dd>' + (ref ? (ref.split === 'test' ? 'held-out' : 'all labelled') + ' accuracy ' + pct(ref.s.accuracy) + ' (n = ' + fmt(ref.s.n) + ') · macro-F1 ' + dec(ref.s.macroF1) + ' · ' : '') + 'coverage ' + pct(m.coverage) + ' · errors ' + pct(m.errorRate) + (m.baseline ? ' · agreement with current AI coding ' + pct(m.baseline.agreement) : '') + '</dd>' : '') +
            '<dt>Security</dt><dd>' + (sv && sv.policy ? (sv.policy.ok !== false ? 'policy passed' : 'policy blocked') : 'policy —') + ' · review ' + decisionBadge(sv && sv.review ? sv.review.decision : null) + '</dd>' +
            '<dt>Why</dt><dd>' + esc(sel.rationale || '—') + '</dd><dt>Selected</dt><dd>' + when(sel.selectedAt) + '</dd></dl>' +
            '<div class="lab-actions mt-3"><button class="btn btn-primary btn-sm" id="xp-send">Send to Codebook</button><button class="btn btn-ghost btn-sm" id="xp-unselect">Clear selection</button></div>' +
            '<div class="xp-send-status" id="xp-send-status" role="status" aria-live="polite"></div>' +
            '<p class="lab-muted mt-2">MetaCode opens (or uses your open MetaCode tab) and asks you to confirm. The Codebook keeps the rule with the variable for reference; MetaCode never runs it and AI Coding doesn\'t use it.</p></div>'
          : '<p class="lab-second">No final version yet. Pick the version whose measured results you trust, say why, and select it. Then send it to the Codebook.</p>') +
        (v && !(sel && sel.version === v.version) ? '<div class="card mt-3"><div class="card-title">Select v' + v.version + ' as final</div><ul class="xp-checks">' + checks.map(([ok, t]) => '<li class="' + (ok ? 'lab-pass' : 'lab-fail') + '">' + (ok ? '✓ ' : '✗ ') + esc(t) + '</li>').join('') + '</ul>' +
            '<label class="form-label mt-2" for="xp-rationale">Why this version</label><textarea class="form-textarea" id="xp-rationale" rows="3" maxlength="2000" placeholder="e.g. Best held-out macro-F1 and no errors; fewer changes to the current AI coding than v2."></textarea>' +
            '<div class="lab-actions mt-2"><button class="btn btn-primary btn-sm" id="xp-select">Select v' + v.version + ' as final</button></div></div>' : '');
      if ($('xp-select')) $('xp-select').onclick = selectFinal;
      if ($('xp-unselect')) $('xp-unselect').onclick = unselect;
      if ($('xp-send')) $('xp-send').onclick = () => sendToCodebook();
      paintSend();
      refresh();
    }
    async function selectFinal() {
      const v = cur();
      if (!v) return;
      const rationale = $('xp-rationale').value.trim();
      if (!rationale) { notify('Say why you choose this version.', 'error'); $('xp-rationale').focus(); return; }
      $('xp-select').disabled = true;
      try {
        const r = await post(base + '/select', { version: v.version, rationale });
        if (W.left) return;
        X.exp = r.experiment;
        if (X.send && X.send.expId === exp().id) X.send = null;
        renderVersionSelect(); renderFinal();
        notify('v' + v.version + ' is the final version', 'success');
        keepFocus('xp-send');
      } catch (e) { if (!W.left) { notify(e.message, 'error', 8000); refresh(); } }
    }
    async function unselect() {
      if (!(await confirmDanger('Clear the final version?', 'The selection is removed. Rules already saved in the Codebook stay there.', 'Clear selection'))) return;
      try { const r = await del(base + '/select'); if (W.left) return; X.exp = r && r.experiment ? r.experiment : Object.assign(exp(), { selected: null }); X.send = null; renderVersionSelect(); renderFinal(); }
      catch (e) { if (!W.left) notify(e.message, 'error', 8000); }
    }

    /* ── Send to Codebook (spec §10) ── */
    function paintSend() {
      const box = $('xp-send-status');
      const s = X.send && X.send.expId === exp().id ? X.send : null;
      if (!box) { refresh(); return; }
      if (!s) { box.innerHTML = ''; refresh(); return; }
      const open = s.submissionId ? '/app.html#codebook/lab/' + encodeURIComponent(s.submissionId) : '';
      box.innerHTML = s.state === 'applied' ? '<div class="lab-note xp-send-ok">Saved to the Codebook' + (s.dimensionId ? ' (variable “' + esc(variable().id === s.dimensionId ? variable().name : s.dimensionId) + '”)' : '') + '. <a href="/app.html#codebook" target="metacode-app" id="xp-open-codebook">Open in Codebook</a></div>'
        : s.state === 'failed' ? '<div class="lab-error" role="alert">Not saved to the Codebook: ' + esc(s.error || 'MetaCode didn\'t save it.') + ' <button class="btn btn-secondary btn-sm" id="xp-send-retry">Retry</button></div>'
        : '<div class="lab-note">' + esc(s.message || 'Sending…') + (s.blocked && open ? ' <a href="' + esc(open) + '" target="metacode-app" id="xp-send-open">Open MetaCode to confirm</a>' : '') + '</div>';
      if ($('xp-send-retry')) $('xp-send-retry').onclick = () => sendToCodebook();
      refresh();
    }
    function setSend(patchObj) { X.send = Object.assign(X.send || { expId: exp().id }, patchObj); paintSend(); }
    function finishSend(ok, error, dimensionId) {
      clearTimeout(W.sendTimer);
      if (W.channel) { try { W.channel.close(); } catch (e) { /* */ } W.channel = null; }
      setSend({ state: ok ? 'applied' : 'failed', error: ok ? null : error, dimensionId: dimensionId || null });
      W.phase = W.phase === 'sending' ? null : W.phase;
      refresh();
      if (ok) notify('Saved to the Codebook', 'success'); else keepFocus('xp-send-retry');
    }
    function listenChannel(id, onAck) {
      if (W.channel) { try { W.channel.close(); } catch (e) { /* */ } }
      W.channel = null;
      if (typeof BroadcastChannel !== 'function') return null;
      try { W.channel = new BroadcastChannel('metacode-lab'); } catch (e) { return null; }
      W.channel.onmessage = e => {
        const m = e && e.data;
        if (!m || typeof m !== 'object' || m.submissionId !== id) return;
        if (m.type === 'coding-rule-ack' && onAck) onAck();
        if (m.type === 'coding-rule-result' && X.send && X.send.submissionId === id && X.send.state === 'waiting') finishSend(!!m.ok, typeof m.error === 'string' ? m.error : 'Not saved in MetaCode.', typeof m.dimensionId === 'string' ? m.dimensionId : null);
      };
      return W.channel;
    }
    // Polls the submission every 2 s for up to 10 minutes (the app also reports it on the channel)
    function pollSubmission() {
      clearTimeout(W.sendTimer);
      const s = X.send;
      if (W.left || !s || s.state !== 'waiting') return;
      if (Date.now() > s.deadline) { finishSend(false, 'No answer from MetaCode in 10 minutes. Make sure MetaCode is open with the project that has this variable, then retry.'); return; }
      W.sendTimer = setTimeout(async () => {
        if (W.left || !X.send || X.send.state !== 'waiting') return;
        try {
          const r = await get('/codebook-submissions/' + encodeURIComponent(s.submissionId));
          const sub = r.submission;
          if (W.left || !X.send || X.send.state !== 'waiting') return;
          if (sub.status === 'applied') { finishSend(true, null, sub.dimensionId); return; }
          // a failure recorded before this attempt doesn't end it
          if (sub.status === 'failed' && sub.resolvedAt !== s.prevResolvedAt) { finishSend(false, sub.error || 'MetaCode didn\'t save it.'); return; }
        } catch (e) { /* keep polling until the deadline */ }
        pollSubmission();
      }, SEND_POLL_MS);
    }
    // One send of one selection: the same key for its retries, a new one when the version is selected again
    const sendKey = sel => exp().id + ':' + sel.version + ':' + sel.codeHash + ':' + sel.runId + ':' + sel.selectedAt;
    // A click on Send (or Retry) always delivers the rule to the app again and waits for its answer: the server
    // puts the submission back to pending (resend), so an earlier "applied" — of a rule since removed in the
    // Codebook — never counts as saved. The app reports a rule it already has as saved, without asking.
    async function sendToCodebook() {
      const sel = exp().selected;
      if (!sel || W.phase) return;
      const key = sendKey(sel);
      setPhase('sending');
      setSend({ state: 'sending', message: 'Sending to the Codebook…', key, submissionId: null, error: null, blocked: false });
      let sub;
      try { sub = (await post(base + '/codebook', { idempotencyKey: key, resend: true })).submission; }
      catch (e) {
        if (W.left) return;
        W.phase = null;
        // The selection changed on the server (another tab, or it ran again): show the current one, then send again
        if (e.status === 409) { try { await reload(true); } catch (err) { /* the message below says what to do */ } if (W.left) return; }
        finishSend(false, e.message);
        if (!$('xp-send-status')) notify(e.message, 'error', 8000);   // (no selection any more: no status line to show it in)
        return;
      }
      if (W.left) return;
      setSend({ submissionId: sub.id, prevResolvedAt: sub.status === 'failed' ? sub.resolvedAt : null, message: 'Asking MetaCode to save the rule…' });
      let acked = false, ackDone;
      const ackWait = new Promise(res => { ackDone = res; });
      listenChannel(sub.id, () => { acked = true; ackDone(); });
      try { if (W.channel) W.channel.postMessage({ type: 'apply-coding-rule', submissionId: sub.id }); } catch (e) { /* closed */ }
      await Promise.race([ackWait, new Promise(res => setTimeout(res, ACK_MS))]);
      if (W.left) return;
      W.phase = null;
      if (acked) setSend({ state: 'waiting', message: 'Switch to your MetaCode tab to confirm.', deadline: Date.now() + SEND_WAIT_MS });
      else {
        let win = null;
        try { win = window.open('/app.html#codebook/lab/' + encodeURIComponent(sub.id), 'metacode-app'); } catch (e) { win = null; }
        setSend({ state: 'waiting', blocked: !win, message: win ? 'MetaCode opened in a new tab: confirm the rule there.' : 'The browser blocked the new tab.', deadline: Date.now() + SEND_WAIT_MS });
      }
      pollSubmission();
    }
    // Back in the workspace (no click): show how the send of the current selection stands — nothing is sent
    function resumeSend() {
      const sel = exp().selected;
      if (!sel) return;
      if (X.send && X.send.expId === exp().id && X.send.state === 'waiting') { if (X.send.submissionId) listenChannel(X.send.submissionId); pollSubmission(); return; }
      if (X.send && X.send.expId === exp().id && X.send.state === 'sending') X.send = null;   // left the page mid-send: ask the server
      if (X.send && X.send.expId === exp().id) return;
      // This selection's send: by its key, or (a send from before keys named the run) the submission made from this very selection
      const key = sendKey(sel);
      const sentAt = s => s.resentAt || s.createdAt;
      const subs = (exp().submissions || []).filter(s => s.idempotencyKey === key || (s.version === sel.version && s.codeHash === sel.codeHash && s.payload && s.payload.selectedAt === sel.selectedAt &&
        s.payload.evaluation && s.payload.evaluation.runId === sel.runId)).sort((a, b) => (sentAt(a) < sentAt(b) ? 1 : -1));
      const s = subs[0];
      if (!s) return;
      if (s.status === 'applied') X.send = { expId: exp().id, state: 'applied', submissionId: s.id, dimensionId: s.dimensionId };
      else if (s.status === 'failed') X.send = { expId: exp().id, state: 'failed', submissionId: s.id, error: s.error };
      else if (Date.now() - Date.parse(sentAt(s)) < SEND_WAIT_MS) {
        X.send = { expId: exp().id, state: 'waiting', submissionId: s.id, prevResolvedAt: null, message: 'Waiting for MetaCode to confirm the rule…', deadline: Date.parse(sentAt(s)) + SEND_WAIT_MS };
        listenChannel(s.id);
        pollSubmission();
      }
    }

    /* ── Wiring ── */
    $('xp-name').addEventListener('change', async e => {
      const name = e.target.value.trim();
      if (!name) { e.target.value = exp().name; return; }
      try { const r = await patch(base, { name }); if (!W.left) { X.exp = r.experiment || Object.assign(exp(), { name }); notify('Renamed', 'success'); } }
      catch (err) { notify(err.message, 'error'); e.target.value = exp().name; }
    });
    $('xp-version').onchange = e => switchVersion(Number(e.target.value));
    $('xp-compare').onclick = () => {
      const v = cur() || latest();
      if (!v) return;
      const a = v.parent && ver(v.parent) ? v.parent : versions().filter(x => x.version < v.version).map(x => x.version).pop() || 'baseline';
      Lab.go('experiment/' + exp().id + '/compare/' + a + '/' + v.version);
    };
    $('xp-archive').onclick = async () => { try { await patch(base, { archived: !exp().archived }); notify(exp().archived ? 'Unarchived' : 'Archived', 'success'); Lab.route(); } catch (e) { notify(e.message, 'error'); } };
    $('xp-delete').onclick = async () => {
      if (!(await confirmDanger('Delete experiment?', 'The experiment “' + exp().name + '”, its versions and its runs are deleted (a running run is cancelled). Its sandbox data and anything already saved in the Codebook stay.'))) return;
      try { await del(base); clearDraft(); notify('Experiment deleted', 'success'); Lab.go('experiments'); } catch (e) { notify(e.message, 'error'); }
    };
    $('xp-generate').onclick = () => generate('new');
    $('xp-alternative').onclick = () => generate('alternative');
    $('xp-refine').onclick = () => generate('refine');
    $('xp-ask').onclick = ask;
    $('xp-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!$('xp-generate').disabled) generate('new'); } });
    $('xp-model').onchange = e => { X.model = e.target.value; };
    $('xp-split').value = X.split;
    $('xp-split').onchange = e => { X.split = e.target.value; };
    $('xp-save').onclick = save;
    $('xp-reset').onclick = reset;
    $('xp-check').onclick = check;
    $('xp-run').onclick = run;
    $('xp-cancel').onclick = cancelRun;
    $('xp-diff-parent').onclick = () => Lab.background(diffParent());
    $('xp-duplicate').onclick = duplicate;
    $('xp-restore').onclick = restore;
    $('xp-lang').onchange = e => {
      const l = e.target.value, wasTemplate = !cur() && W.editor && W.editor.getValue() === W.template;
      W.lang = l;
      if (W.editor) { W.editor.setLanguage(l); if (wasTemplate) { W.template = template(l); W.editor.setValue(W.template); } }
      saveDraft(); refresh();
    };
    $('xp-run-pick').onchange = e => { if (e.target.value) { X.preview.offset = 0; showRun(e.target.value); } };
    $('xp-rerun').onclick = () => { const r = shownRun(); if (r) startRun(r.version, r.codeHash, (r.sandbox && r.sandbox.split) || 'all'); };
    $('xp-term-clear').onclick = () => { $('xp-term-body').replaceChildren(); };
    const critBox = $('xp-criteria');
    wireCriteria(critBox, v0);
    $('xp-criteria-save').onclick = async () => {
      const c = readCriteria(critBox);
      if (c.error) { notify(c.error, 'error'); return; }
      $('xp-criteria-save').disabled = true;
      try { const r = await patch(base, { objective: { text: $('xp-objective').value.trim(), criteria: c.criteria } }); if (!W.left) { X.exp = r.experiment || Object.assign(exp(), { objective: { text: $('xp-objective').value.trim(), criteria: c.criteria } }); notify('Criteria saved', 'success'); renderTab(); } }
      catch (e) { notify(e.message, 'error', 7000); }
      finally { if (!W.left) $('xp-criteria-save').disabled = false; }
    };

    if (execOff) $('xp-notice').insertAdjacentHTML('beforeend', '<div class="lab-warn xp-notice" id="xp-off" role="status">Running code is switched off on this server. You can still write, check, compare and evaluate versions, and send one that already ran to the Codebook.</div>');
    else if (na[exp().language]) $('xp-notice').insertAdjacentHTML('beforeend', '<div class="lab-warn xp-notice" id="xp-lang-na" role="status">' + esc(LANG_LABEL[exp().language]) + ' can\'t run on this server: ' + esc(na[exp().language]) + ' You can still write, check and compare versions.</div>');
    // An import report from creating this experiment
    const note = IMPORT_NOTES[exp().id];
    if (note) {
      delete IMPORT_NOTES[exp().id];
      const rep = note.report || {};
      const bits = [];
      if (rep.accepted !== undefined) bits.push(plural(rep.accepted, 'record') + ' in the sandbox');
      if (rep.rejected) bits.push(fmt(rep.rejected) + ' left out');
      if (rep.truncated || note.cutTexts) bits.push(fmt((rep.truncated || 0) + (note.cutTexts || 0)) + ' with text cut to the limits');
      if (note.skipped) bits.push(fmt(note.skipped) + ' posts beyond the first ' + fmt(LIMITS.records) + ' not included');
      const problems = Array.isArray(rep.problems) ? rep.problems : [];
      if (bits.length) $('xp-notice').insertAdjacentHTML('beforeend', '<div class="' + (rep.rejected || problems.length ? 'lab-warn' : 'lab-note') + ' xp-notice">Sandbox created: ' + esc(bits.join(' · ')) + '.' +
        (problems.length ? '<details class="lab-more"><summary>' + plural(problems.length, 'problem') + '</summary><ul class="lab-list">' + problems.map(p => '<li><span>' + (p.id ? '<span class="lab-mono">' + esc(p.id) + '</span> ' : '') + esc(p.problem) + '</span></li>').join('') + '</ul></details>' : '') + '</div>');
    }

    renderThread();
    // The run shown: the active one, the remembered one, or the latest of this version
    const active = activeRun();
    const keep = X.shownRunId && X.runs.some(r => r.id === X.shownRunId) ? X.shownRunId : null;
    const mine = X.runs.filter(r => cur() && r.version === cur().version);
    X.shownRunId = active ? active.id : keep || (mine.find(r => r.status === 'succeeded') || mine[0] || {}).id || null;
    loadVersion(X.current, { keepRun: true, noTab: true });
    showRun(X.shownRunId);
    resumeSend();
    refresh();


    // The editor (CodeMirror, else the textarea)
    try { await startEditor(); } catch (e) { if (!W.left) notify(e.message || 'The editor couldn\'t start.', 'error', 8000); }
    async function startEditor() {
      const v = cur();
      W.lang = v ? v.language : (exp().language || 'javascript');
      W.template = template(W.lang);
      const editor = await makeEditor($('xp-editor'), { doc: v ? v.code : W.template, language: W.lang, label: 'Code editor', onChange: () => {
        clearTimeout(W.draftTimer); W.draftTimer = setTimeout(saveDraft, 300);
        if (W.fresh) W.fresh = null;
        if (W.editor) W.editor.setFindings(isDirty() ? [] : findingsOf(cur()));
        refresh();
      } });
      if (W.left || !main.isConnected) { if (editor) editor.destroy(); return; }
      W.editor = editor;
      W.editor.setFindings(findingsOf(cur()));
      $('xp-lang').value = W.lang;
      offerDraft();
      refresh();
    }
  }

  /* ══ Compare two versions ══ */
  async function compareView(main, id, a, b) {
    const qa = a === 'baseline' ? 'baseline' : String(Number(a)), qb = String(Number(b));
    const [data, cmp] = await Promise.all([get('/experiments/' + encodeURIComponent(id)), get('/experiments/' + encodeURIComponent(id) + '/compare?a=' + encodeURIComponent(qa) + '&b=' + encodeURIComponent(qb)), Lab.loadModels()]);
    if (!main.isConnected) return;
    const exp = data.experiment, variable = exp.variable, sbx = data.sandbox || null;
    const versions = exp.versions || [];
    const ver = n => versions.find(v => v.version === n) || null;
    const C = { merge: null, filter: 'all', offset: 0, rows: null, left: false };
    Lab.onLeave(() => { C.left = true; if (C.merge) { try { C.merge.destroy(); } catch (e) { /* */ } } });
    const nameOf = x => (x === 'baseline' ? 'Current AI coding' : 'v' + x);
    const A = cmp.a || {}, B = cmp.b || {};
    const runA = A.run || null, runB = B.run || null;
    const mA = (runA && runA.metrics) || A.metrics || null, mB = (runB && runB.metrics) || B.metrics || null;
    const noRefs = sbx ? sbx.referenceCount === 0 : !((mB && mB.reference) || (mA && mA.reference));
    const opt = (sel, list) => list.map(([k, l]) => '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
    const verOpts = versions.slice().reverse().map(v => [String(v.version), 'v' + v.version + ' · ' + (ORIGIN[v.origin] ? ORIGIN[v.origin][0] : v.origin) + (v.lastRun ? ' · ' + v.lastRun.status : ' · not run')]);
    const ref = m => { const r = scoringRef(m); return r ? r.s : null; };
    const ROWS = [
      ['Held-out accuracy', m => (ref(m) ? ref(m).accuracy : null), 'higher', 'pct', m => { const r = scoringRef(m); return r ? 'n = ' + fmt(r.s.n) + (r.split === 'test' ? ' held-out' : ' (all labelled: no held-out labels)') : ''; }],
      ['Macro-F1', m => (ref(m) ? ref(m).macroF1 : null), 'higher', 'dec'],
      ['Cohen\'s κ', m => (ref(m) ? ref(m).kappa : null), 'higher', 'dec'],
      ['Coverage', m => m.coverage, 'higher', 'pct'],
      ['Error rate', m => m.errorRate, 'lower', 'pct'],
      ['Agreement with current AI coding', m => (m.baseline ? m.baseline.agreement : null), 'higher', 'pct', m => (m.baseline ? 'n = ' + fmt(m.baseline.n) : '')],
      ['Consistency', m => (m.consistency ? m.consistency.score : null), 'higher', 'pct'],
      ['Runtime', m => (m.runtime ? m.runtime.durationMs : null), 'lower', 'ms']
    ];
    const show = (v, kind) => (num(v) === null ? '—' : kind === 'pct' ? pct(v) : kind === 'ms' ? Lab.ms(v) : dec(v));
    const delta = (x, y, dir, kind) => {
      if (num(x) === null || num(y) === null) return '—';
      const d = y - x;
      const cls = Math.abs(d) < 1e-9 ? '' : (d > 0) === (dir === 'higher') ? 'lab-delta-pos' : 'lab-delta-neg';
      const t = kind === 'pct' ? (Math.round(d * 1000) / 10) + ' pts' : kind === 'ms' ? Lab.ms(Math.abs(d)) : d.toFixed(2);
      return '<span class="' + cls + '">' + (d > 0 ? '+' : d < 0 && kind === 'ms' ? '−' : '') + t + '</span>';
    };
    const scoreOf = (side, m) => (side.score && typeof side.score === 'object' ? num(side.score.score) : num(side.score) !== null ? side.score : m ? scoreRun(m, cmp.criteria || (exp.objective && exp.objective.criteria)).score : null);
    const security = (side, v) => {
      const sec = side.run && side.run.security ? side.run.security : null;
      const pol = (sec && sec.policy) || (v && v.policy);
      const rev = (sec && sec.review) || (v && v.review);
      if (!v && !sec) return '<span class="lab-muted">not code (labels)</span>';
      return (pol ? (pol.ok === false ? '<span class="badge badge-red">policy blocked</span>' : '<span class="badge badge-green">policy passed</span>') : '<span class="badge badge-gray">policy not checked</span>') + ' ' + decisionBadge(rev ? rev.decision : null) +
        (sec && sec.acknowledged ? ' <span class="badge badge-blue">run allowed after reading the review</span>' : '');
    };
    const vA = qa === 'baseline' ? null : ver(Number(qa)), vB = ver(Number(qb));
    main.innerHTML = '<div class="xp xp-compare-view" aria-live="off"><div class="xp-top"><div class="xp-top-main"><h2 class="xp-cmp-title">' + esc(exp.name) + ': ' + esc(nameOf(qa)) + ' → ' + esc(nameOf(qb)) + '</h2></div>' +
        '<div class="xp-top-ctl"><span class="xp-pair"><label class="xp-inline" for="xp-cmp-a">A</label><select class="form-select" id="xp-cmp-a">' + opt(qa, [['baseline', 'Current AI coding']].concat(verOpts)) + '</select></span>' +
          '<span class="xp-pair"><label class="xp-inline" for="xp-cmp-b">B</label><select class="form-select" id="xp-cmp-b">' + opt(qb, verOpts) + '</select></span>' +
          '<button class="btn btn-secondary btn-sm" id="xp-cmp-go">Compare</button><span class="xp-state xp-state-blue" id="xp-state" role="status" aria-live="polite">' + STATE.comparing[0] + '</span>' +
          '<a class="btn btn-ghost btn-sm" href="#experiment/' + esc(exp.id) + '">Back to the workspace</a></div></div>' +
      '<p class="lab-note lab-section"><b>Ran without errors ≠ better: compare the measured scores.</b> Both sides are measured on the same sandbox records; the AI explanation below is an interpretation of these numbers.</p>' +
      (noRefs ? '<div class="lab-warn lab-section">This sandbox has no reference labels (human coding), so accuracy, F1 and κ can\'t be measured. Compare agreement with the current AI coding, consistency, coverage and errors instead — agreement isn\'t correctness.</div>' : '') +
      ((cmp.warnings || []).length ? '<div class="lab-warn lab-section"><b>Read with care:</b><ul>' + cmp.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '') +
      '<div class="card lab-section"><div class="card-title">Code</div>' + (qa === 'baseline' ? '<p class="lab-muted mb-3">The current AI coding isn\'t code: it is the labels MetaCode\'s AI Coding gave these records. Showing B\'s code.</p>' : '') +
        '<div class="xp-merge" id="xp-merge"><p class="lab-muted">Loading the diff…</p></div></div>' +
      '<div class="lab-grid-2 lab-section"><div class="card"><div class="card-title">Measured</div><div class="table-wrap"><table class="table xp-cmp-table"><thead><tr><th>Metric</th><th>A · ' + esc(nameOf(qa)) + '</th><th>B · ' + esc(nameOf(qb)) + '</th><th>Δ (B − A)</th></tr></thead><tbody>' +
          ROWS.map(([label, f, dir, kind, n]) => { const x = mA ? f(mA) : null, y = mB ? f(mB) : null; return '<tr><td>' + esc(label) + '</td><td>' + show(x, kind) + (n && mA && n(mA) ? '<div class="lab-muted">' + esc(n(mA)) + '</div>' : '') + '</td><td>' + show(y, kind) + (n && mB && n(mB) ? '<div class="lab-muted">' + esc(n(mB)) + '</div>' : '') + '</td><td>' + delta(x, y, dir, kind) + '</td></tr>'; }).join('') +
          (() => { const x = scoreOf(A, mA), y = scoreOf(B, mB); return '<tr><td><b>Objective score</b></td><td>' + show(x, 'dec') + '</td><td>' + show(y, 'dec') + '</td><td>' + delta(x, y, 'higher', 'dec') + '</td></tr>'; })() +
        '</tbody></table></div>' + (!mA && qa !== 'baseline' ? '<p class="lab-muted mt-2">A has no successful run on this sandbox version.</p>' : '') + (!mB ? '<p class="lab-muted mt-2">B has no successful run on this sandbox version: run it first.</p>' : '') + '</div>' +
        '<div class="card"><div class="card-title">Runs, resources and security</div><dl class="lab-kv">' +
          [['A', A, runA, vA, qa], ['B', B, runB, vB, qb]].map(([k, side, r, v, q]) => '<dt>' + k + ' · ' + esc(nameOf(q)) + '</dt><dd>' + (r ? esc(langLabel(r.language)) + ' · ' + fmt(r.sandbox && r.sandbox.recordCount) + ' records (' + esc(splitLabel(r.sandbox && r.sandbox.split)) + ') · ' + Lab.ms(r.timing && r.timing.durationMs) +
            (r.resources ? ' · ' + bytes(r.resources.rssBytes) + ' memory · ' + bytes(r.resources.outputBytes) + ' output' : '') : q === 'baseline' ? 'MetaCode\'s AI Coding labels' : 'no successful run') + '<br>' + security(side, v) + '</dd>').join('') +
        '</dl></div></div>' +
      '<div class="card lab-section"><div class="card-title">Records that changed</div><div id="xp-cmp-changed"></div></div>' +
      '<div class="card"><div class="card-title">AI explanation</div><p class="lab-second">A model explains the difference between B and A from the measured numbers above and a few changed dev records. It doesn\'t run anything; check it against the numbers.</p>' +
        '<div class="lab-actions mt-2"><button class="btn btn-primary btn-sm" id="xp-cmp-explain"' + (!runB ? ' disabled' : '') + '>Explain B against A</button></div><div id="xp-cmp-eval" class="mt-3" aria-live="polite"></div></div></div>';
    $('xp-cmp-go').onclick = () => Lab.go('experiment/' + exp.id + '/compare/' + $('xp-cmp-a').value + '/' + $('xp-cmp-b').value);
    // The code diff
    if (qa === 'baseline' || typeof A.code !== 'string') {
      const host = $('xp-merge');
      if (typeof B.code === 'string') { const LE = await editorReady(); if (C.left) return; if (LE) { host.innerHTML = ''; C.merge = LE.create(host, { doc: B.code, language: B.language, readOnly: true, label: 'Code of ' + nameOf(qb) }); } else host.innerHTML = '<pre class="lab-pre">' + esc(B.code) + '</pre>'; }
      else host.innerHTML = '<p class="lab-muted">No code.</p>';
    } else C.merge = await makeMerge($('xp-merge'), A.code || '', B.code || '', B.language || A.language, ['Code of ' + nameOf(qa) + ' (A)', 'Code of ' + nameOf(qb) + ' (B)']);
    if (C.left) return;
    // Existing explanation
    const ev = vB && vB.evaluation;
    const evMatches = ev && ev.against && (qa === 'baseline' ? ev.against.kind === 'baseline' : ev.against.kind === 'version' && String(ev.against.version) === qa);
    if (evMatches) { $('xp-cmp-eval').innerHTML = compareEvalHTML(ev); LabMarkdown.enhance($('xp-cmp-eval'), null); }
    $('xp-cmp-explain').onclick = async () => {
      const btn = $('xp-cmp-explain');
      const [provider, model] = (Lab.defaultModel() ? [Lab.defaultModel().provider, Lab.defaultModel().model] : []);
      const body = { against: qa === 'baseline' ? 'baseline' : Number(qa) };
      if (provider) { body.provider = provider; body.model = model; }
      btn.disabled = true; $('xp-cmp-eval').innerHTML = '<p class="lab-muted">Waiting for the model…</p>';
      try { const x = await post('/experiments/' + encodeURIComponent(exp.id) + '/versions/' + qb + '/evaluate', body); if (!C.left) { $('xp-cmp-eval').innerHTML = compareEvalHTML(x.evaluation); LabMarkdown.enhance($('xp-cmp-eval'), null); } }
      catch (e) { if (!C.left) $('xp-cmp-eval').innerHTML = '<div class="lab-error" role="alert">' + esc(e.message) + '</div>'; }
      finally { if (!C.left) btn.disabled = false; }
    };
    // Changed records: from B's validated results against A (text), else the comparison's ids
    const changedBox = $('xp-cmp-changed');
    if (!cmp.comparison) { changedBox.innerHTML = '<p class="lab-muted">Not comparable: ' + esc((cmp.warnings || [])[0] || 'both sides need a successful run on the same sandbox version.') + '</p>'; return; }
    const counts = cmp.comparison.counts || {};
    let rows = null;
    if (runB) {
      try {
        rows = [];
        for (let offset = 0; offset < 1000; offset += 100) {
          const page = await get('/xruns/' + encodeURIComponent(runB.id) + '/results?' + new URLSearchParams({ filter: 'changed', against: runA ? runA.id : 'baseline', offset: String(offset), limit: '100' }));
          (page.results || []).forEach(x => rows.push({ id: x.id, text: x.text, a: x.against === undefined ? null : x.against, b: x.error ? null : x.code, reference: x.reference === undefined ? null : x.reference }));
          if (!page.results || page.results.length < 100) break;
        }
      } catch (e) { rows = null; }
    }
    if (C.left) return;
    if (!rows) rows = (cmp.comparison.changed || []).map(x => ({ id: x.id, text: typeof x.text === 'string' ? x.text : null, a: x.a, b: x.b, reference: x.reference }));
    const kindOf = r => (r.reference === null || r.reference === undefined ? 'other' : r.a !== r.reference && r.b === r.reference ? 'fixed' : r.a === r.reference && r.b !== r.reference ? 'broken' : 'other');
    rows.forEach(r => { r.kind = kindOf(r); });
    function paintChanged() {
      const list = rows.filter(r => C.filter === 'all' || r.kind === C.filter);
      const page = list.slice(C.offset, C.offset + PAGE);
      changedBox.innerHTML = '<p class="lab-second">' + plural(num(counts.changed) !== null ? counts.changed : rows.length, 'record') + ' coded differently · <b class="lab-pass">' + fmt(counts.fixed || 0) + ' fixed</b> (wrong in A, right in B) · <b class="lab-fail">' + fmt(counts.broken || 0) + ' broken</b> (right in A, wrong in B)' + (noRefs ? ' — without reference labels nothing can be called fixed or broken' : '') + '.</p>' +
        '<div class="xp-filters mt-2" role="group" aria-label="Show">' + [['all', 'All'], ['fixed', 'Fixed'], ['broken', 'Broken'], ['other', 'Other']].map(([k, l]) => '<button type="button" class="xp-filter" data-cf="' + k + '" aria-pressed="' + (C.filter === k) + '">' + l + ' (' + fmt(k === 'all' ? rows.length : rows.filter(r => r.kind === k).length) + ')</button>').join('') + '</div>' +
        (page.length ? '<div class="table-wrap mt-2"><table class="table"><thead><tr><th>Record</th><th>A · ' + esc(nameOf(qa)) + '</th><th>B · ' + esc(nameOf(qb)) + '</th><th>Reference</th></tr></thead><tbody>' +
          page.map(r => '<tr><td><span class="lab-mono lab-muted">' + esc(r.id) + '</span> ' + (r.kind === 'fixed' ? '<span class="badge badge-green">fixed</span>' : r.kind === 'broken' ? '<span class="badge badge-red">broken</span>' : '') + (r.text ? '<div class="xp-cmp-text">' + esc(String(r.text).slice(0, 200)) + (String(r.text).length > 200 ? '…' : '') + '</div>' : '') + '</td>' +
            '<td>' + chip(variable, r.a) + '</td><td>' + chip(variable, r.b) + '</td><td>' + (r.reference ? chip(variable, r.reference) : '<span class="lab-muted">—</span>') + '</td></tr>').join('') + '</tbody></table></div>' +
          '<div class="lab-actions mt-2"><span class="lab-muted">' + fmt(C.offset + 1) + '–' + fmt(C.offset + page.length) + ' of ' + fmt(list.length) + (rows.length >= 1000 ? ' (the first 1,000 changed records)' : '') + '</span>' + (C.offset > 0 ? '<button class="btn btn-ghost btn-sm" id="xp-cc-prev">Previous</button>' : '') + (C.offset + PAGE < list.length ? '<button class="btn btn-ghost btn-sm" id="xp-cc-next">Next</button>' : '') + '</div>'
          : '<p class="lab-muted mt-2">No records in this view.</p>');
      changedBox.querySelectorAll('[data-cf]').forEach(b => { b.onclick = () => { C.filter = b.dataset.cf; C.offset = 0; paintChanged(); }; });
      if ($('xp-cc-prev')) $('xp-cc-prev').onclick = () => { C.offset = Math.max(0, C.offset - PAGE); paintChanged(); };
      if ($('xp-cc-next')) $('xp-cc-next').onclick = () => { C.offset += PAGE; paintChanged(); };
    }
    paintChanged();
  }
  function compareEvalHTML(ev) {
    const sec = (title, text) => '<h4 class="xp-h4">' + esc(title) + '</h4><div class="xp-md">' + (text ? md(text) : '<p class="lab-muted">—</p>') + '</div>';
    return '<div class="xp-eval-head">' + recBadge(ev.recommendation) + ' <span class="lab-muted">' + esc(ev.model || '') + ' · ' + when(ev.createdAt) + '</span></div>' +
      '<div class="lab-note mt-2">AI interpretation — check it against the measured numbers.</div>' +
      (ev.unverifiedNumbers && ev.unverifiedNumbers.length ? '<div class="lab-warn mt-2" role="alert"><b>Numbers that don\'t match a measured value:</b> ' + ev.unverifiedNumbers.map(esc).join(', ') + '.</div>' : '') +
      sec('Proposed improvement', ev.proposedImprovement) + sec('Reasoning', ev.reasoning) + sec('Observed results', ev.observedResults) + sec('Comparison', ev.comparison) + sec('Trade-offs', ev.tradeoffs) + sec('Limitations', ev.limitations) +
      '<h4 class="xp-h4">Recommendation</h4><p>' + recBadge(ev.recommendation) + '</p>';
  }
})();
