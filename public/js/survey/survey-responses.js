/* ══════════════════════════════════════════════
   survey-responses.js — Survey Studio's Responses page

   Built for inspecting what respondents actually submitted:
     • an overview (total, completed, partial/abandoned, completion rate,
       median time) and filters (search by respondent or answer text,
       status, date range, sort);
     • a split view: the response list on the left, the selected response
       on the right with previous/next — Answers (in the order the pages
       were shown, formatted by question type, skipped questions marked,
       answer times from the timeline), Timeline (the recorded session
       events, a page-by-page progress bar and a step-through replay) and
       Details (respondent information with its source, session metadata);
     • Summary (per-question charts of completed responses);
     • exports (CSV / JSON / session events CSV; identifying fields only
       when asked for) and privacy actions (erase IP addresses, location,
       identity fields or timelines from every response).

   The timeline only shows events that were recorded (Settings → Session
   timeline). Nothing is reconstructed or invented for responses without it.

   SurveyResponses.mount(host, { doc, api, publish, download, toProject, onOpenPage, isActive })
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore, Logic = root.SurveyLogic;
  const esc = s => App.esc(s === undefined || s === null ? '' : String(s));
  const ABANDON_AFTER = 30 * 60 * 1000;

  /* ── Formatting helpers ─────────────────── */
  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + String(r).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }
  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
  }
  function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function ago(iso) {
    if (!iso) return '—';
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    if (d < 86400 * 30) return Math.round(d / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString();
  }
  // ISO 3166 country code → flag emoji (regional indicator symbols) and name.
  function flagOf(cc) {
    if (!/^[A-Z]{2}$/.test(cc || '')) return '';
    return String.fromCodePoint(...cc.split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
  }
  let regionNames = null;
  function countryName(cc) {
    if (!/^[A-Z]{2}$/.test(cc || '')) return '';
    try { regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' }); return regionNames.of(cc) || cc; } catch (e) { return cc; }
  }
  // "🇺🇸 127.0.0.1 · California" style summary of what is known about the respondent
  function respondentLine(r) {
    const who = r.respondent || {};
    const d = who.derived || {};
    const parts = [];
    const flag = d.country ? '<span class="sr-flag" title="' + esc(countryName(d.country)) + ' (approximate, from IP address)">' + flagOf(d.country) + '</span> ' : '';
    if (d.ip) parts.push('<span class="sr-mono">' + esc(d.ip) + '</span>');
    if (d.region) parts.push(esc(d.region));
    else if (d.country && !d.ip) parts.push(esc(countryName(d.country)));
    if (who.participantId) parts.push('<span title="Participant code">' + esc(who.participantId) + '</span>');
    if (who.name) parts.push(esc(who.name));
    return parts.length ? flag + parts.join(' · ') : flag.trim();
  }
  function statusOf(r) {
    if (r.status === 'complete') return 'complete';
    const ev = r.session && Array.isArray(r.session.events) ? r.session.events : [];
    const last = ev.length ? ev[ev.length - 1] : null;
    if (last && last.type === 'abandon') return 'abandoned';
    return Date.now() - Date.parse(r.updatedAt || r.startedAt) > ABANDON_AFTER ? 'abandoned' : 'in_progress';
  }
  const STATUS = { complete: ['Complete', 'badge-green'], in_progress: ['In progress', 'badge-blue'], abandoned: ['Abandoned', 'badge-amber'] };
  const statusBadge = r => { const [l, c] = STATUS[statusOf(r)]; return '<span class="badge ' + c + '">' + l + '</span>'; };
  const durationOf = r => (r.completedAt ? Date.parse(r.completedAt) - Date.parse(r.startedAt) : Date.parse(r.updatedAt) - Date.parse(r.startedAt));

  /* ── Answers ────────────────────────────── */
  const TYPE_NAMES = { single: 'Single choice', multiple: 'Multiple choice', yesno: 'Yes / No', rating: 'Rating', likert: 'Likert scale', dropdown: 'Dropdown', shorttext: 'Short text',
    longtext: 'Long text', number: 'Number', slider: 'Slider', date: 'Date', time: 'Time', ranking: 'Ranking', matrix: 'Matrix' };
  const same = (a, b) => String(a) === String(b);
  function labelOfValue(vdoc, q, v) {
    const c = Logic.choicesOf(vdoc, q).find(x => same(x.value, v));
    return c ? (c.label || String(c.value)) : String(v);
  }
  // A short plain-text rendering, for the timeline and exports.
  function plainAnswer(vdoc, q, v) {
    if (v === undefined || v === null || v === '') return '';
    const kind = Logic.valueKind(q);
    if (kind === 'multi' || kind === 'ranking') return (Array.isArray(v) ? v : [v]).map(x => labelOfValue(vdoc, q, x)).join(kind === 'ranking' ? ' > ' : ', ');
    if (kind === 'choice') return labelOfValue(vdoc, q, v);
    if (kind === 'matrix' && v && typeof v === 'object') { const m = Logic.matrixOf(vdoc, q); return Object.keys(v).map(rk => { const row = m.rows.find(x => same(x.value, rk)); const col = m.cols.find(x => same(x.value, v[rk])); return (row ? row.label : rk) + ': ' + (col ? col.label : v[rk]); }).join('; '); }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  // Rich rendering for the Answers tab.
  function answerHTML(vdoc, q, v) {
    const kind = Logic.valueKind(q);
    if (kind === 'choice') {
      const choices = Logic.choicesOf(vdoc, q);
      const i = choices.findIndex(x => same(x.value, v));
      const chip = '<span class="sr-chip">' + esc(labelOfValue(vdoc, q, v)) + '</span>';
      if (q.type === 'rating') return '<span class="sr-rating" aria-label="' + esc(v) + ' of ' + choices.length + '">' + choices.map((c, j) => '<span class="' + (j <= i ? 'on' : '') + '">★</span>').join('') + '</span> <span class="sr-muted">' + esc(v) + ' of ' + choices.length + '</span>';
      if (q.type === 'likert') return chip + ' <span class="sr-muted">' + (i + 1) + ' of ' + choices.length + ' on the scale</span>';
      return chip;
    }
    if (kind === 'multi') return '<span class="sr-chips">' + (Array.isArray(v) ? v : [v]).map(x => '<span class="sr-chip">' + esc(labelOfValue(vdoc, q, x)) + '</span>').join('') + '</span>';
    if (kind === 'ranking') return '<ol class="sr-rank">' + (Array.isArray(v) ? v : [v]).map(x => '<li>' + esc(labelOfValue(vdoc, q, x)) + '</li>').join('') + '</ol>';
    if (kind === 'matrix' && v && typeof v === 'object') {
      const m = Logic.matrixOf(vdoc, q);
      return '<table class="sr-matrix"><thead><tr><th></th>' + m.cols.map(c => '<th>' + esc(c.label) + '</th>').join('') + '</tr></thead><tbody>' +
        m.rows.map(row => '<tr><th>' + esc(row.label) + '</th>' + m.cols.map(c => '<td>' + (same(v[String(row.value)], c.value) ? '<span class="sr-dot" aria-label="selected">●</span>' : '') + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    }
    if (q.type === 'slider') {
      const f = Core.questionParts(vdoc, q.id, 'field')[0];
      const p = f ? f.props : {};
      return '<b class="sr-num">' + esc(v) + '</b> <span class="sr-muted">on a scale from ' + esc(p.min === undefined ? 0 : p.min) + (p.minLabel ? ' (' + esc(p.minLabel) + ')' : '') + ' to ' + esc(p.max === undefined ? 10 : p.max) + (p.maxLabel ? ' (' + esc(p.maxLabel) + ')' : '') + '</span>';
    }
    if (q.type === 'longtext' || q.type === 'shorttext') return '<div class="sr-text">' + esc(v) + '</div>';
    return '<b class="sr-num">' + esc(typeof v === 'object' ? JSON.stringify(v) : v) + '</b>';
  }
  // A question's full title (Core.displayName shortens it for lists).
  function titleOf(vdoc, q) {
    const t = Core.questionParts(vdoc, q.id, 'qtitle')[0];
    const text = t ? Core.plainText(String(t.props.text || '')) : '';
    return text || Core.displayName(vdoc, q);
  }
  // Questions in the order the respondent was shown them: the pages they visited (in order), then the rest.
  function presented(vdoc, r) {
    const all = Core.questionsInOrder(vdoc);
    const pageOf = q => { const p = Core.pageOf(vdoc, q.id); return p ? p.id : null; };
    const path = Array.isArray(r.path) && r.path.length ? Array.from(new Set(r.path)) : null;
    if (!path) return { shown: all.map(q => ({ q, page: pageOf(q) })), notShown: [], known: false };
    const shown = [];
    path.forEach(pid => all.filter(q => pageOf(q) === pid).forEach(q => shown.push({ q, page: pid })));
    const seen = new Set(shown.map(x => x.q.id));
    return { shown, notShown: all.filter(q => !seen.has(q.id)).map(q => ({ q, page: pageOf(q) })), known: true };
  }

  /* ── Timeline ───────────────────────────── */
  function eventsOf(r) { return r.session && Array.isArray(r.session.events) ? r.session.events.slice().sort((a, b) => a.t - b.t) : []; }
  function pageVisits(events) {
    const visits = [];
    events.forEach(e => {
      if ((e.type === 'start' || e.type === 'page') && e.page) {
        if (visits.length) visits[visits.length - 1].end = e.t;
        visits.push({ page: e.page, start: e.t, end: null, dir: e.type === 'start' ? 'start' : e.dir });
      }
    });
    const lastT = events.length ? events[events.length - 1].t : 0;
    if (visits.length && visits[visits.length - 1].end === null) visits[visits.length - 1].end = lastT;
    return visits;
  }
  function awayTime(events) {
    let total = 0, since = null;
    events.forEach(e => { if (e.type === 'away' && since === null) since = e.t; if ((e.type === 'back' || e.type === 'resume') && since !== null) { total += e.t - since; since = null; } });
    return total;
  }
  // Answers as they stood after event i (choices show their value; typed text only its length).
  function stateAt(events, i) {
    const answers = {};
    let page = null;
    for (let j = 0; j <= i && j < events.length; j++) {
      const e = events[j];
      if ((e.type === 'start' || e.type === 'page') && e.page) page = e.page;
      if (e.type === 'answer' && e.q) {
        if (e.cleared) delete answers[e.q];
        else answers[e.q] = e.len !== undefined ? { len: e.len } : { value: e.value };
      }
    }
    return { answers, page };
  }

  function mount(host, opts) {
    const doc = () => opts.doc();
    let list = [];
    let loaded = false;
    let view = 'responses';          // responses | summary
    let tab = 'answers';             // answers | timeline | details
    let selectedId = null;
    let replay = null;               // { i, timer }
    const filters = { q: '', status: 'all', from: '', to: '', sort: 'newest' };
    const versionDocs = new Map();
    let destroyed = false;

    async function versionDoc(r) {
      const n = r.version;
      if (versionDocs.has(n)) return versionDocs.get(n);
      let d = null;
      try { d = Core.normalizeDoc((await opts.api('/' + doc().id + '/versions/' + n)).version.doc).doc; } catch (e) { d = null; }
      versionDocs.set(n, d);
      return d;
    }
    const qName = (vdoc, qid) => { const q = vdoc && vdoc.elements[qid]; return q ? titleOf(vdoc, q) : 'a question no longer in this version'; };
    const pageName = (vdoc, pid) => { const p = vdoc && Core.getPage(vdoc, pid); return p ? p.name : 'a page'; };

    async function load() {
      host.innerHTML = '<div class="sr"><div class="loading-state">Loading responses…</div></div>';
      try { list = (await opts.api('/' + doc().id + '/responses')).responses || []; } catch (e) {
        host.innerHTML = '<div class="sr"><div class="empty-state"><div class="empty-title">Couldn\'t load responses</div><div class="empty-sub">' + esc(e.message) + '</div><button type="button" class="btn btn-secondary" data-act="refresh">Try again</button></div></div>';
        host.querySelector('[data-act="refresh"]').onclick = load;
        return;
      }
      if (destroyed || !opts.isActive()) return;
      loaded = true;
      if (selectedId && !list.some(r => r.id === selectedId)) selectedId = null;
      render();
    }

    function filtered() {
      const q = filters.q.trim().toLowerCase();
      const from = filters.from ? Date.parse(filters.from + 'T00:00:00') : null;
      const to = filters.to ? Date.parse(filters.to + 'T23:59:59') : null;
      const out = list.filter(r => {
        if (filters.status !== 'all' && statusOf(r) !== filters.status) return false;
        const at = Date.parse(r.completedAt || r.updatedAt || r.startedAt);
        if (from !== null && at < from) return false;
        if (to !== null && at > to) return false;
        if (!q) return true;
        const who = r.respondent || {};
        const hay = [r.id, who.participantId, who.name, (who.derived || {}).ip, (who.derived || {}).region, countryName((who.derived || {}).country)]
          .concat(Object.values(r.byKey || {}).map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v)))).filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
      const by = {
        newest: (a, b) => String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt)),
        oldest: (a, b) => String(a.completedAt || a.updatedAt).localeCompare(String(b.completedAt || b.updatedAt)),
        longest: (a, b) => durationOf(b) - durationOf(a),
        shortest: (a, b) => durationOf(a) - durationOf(b)
      };
      return out.sort(by[filters.sort] || by.newest);
    }

    /* ── Page frame ─────────────────────────── */
    function render() {
      stopReplay();
      const p = opts.publish();
      const done = list.filter(r => r.status === 'complete');
      const partial = list.length - done.length;
      const abandoned = list.filter(r => statusOf(r) === 'abandoned').length;
      const durs = done.map(durationOf).filter(x => x >= 0 && x < 86400000 * 3).sort((a, b) => a - b);
      const med = durs.length ? durs[Math.floor(durs.length / 2)] : null;
      const live = p && !p.unpublished;
      host.innerHTML = '<div class="sr">' +
        '<header class="sr-head"><div><h2 class="ss-logic-h">Responses</h2><p class="ss-logic-sub">' + (live ? 'Collecting at <a href="/s/' + esc(p.publicId) + '" target="_blank" rel="noopener">' + esc(location.origin + '/s/' + p.publicId) + '</a>' + (p.open ? '' : ' · <b>paused</b>') : 'Publish the survey to start collecting responses.') + '</p></div>' +
          '<div class="ss-btn-row"><button type="button" class="btn btn-secondary btn-sm" data-act="refresh">↻ Refresh</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-act="export"' + (list.length ? '' : ' disabled') + '>Export…</button>' +
          '<button type="button" class="btn btn-teal btn-sm" data-act="to-project"' + (done.length ? '' : ' disabled') + ' title="Turn text answers into project posts for coding">Add text answers to project</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="privacy"' + (list.length ? '' : ' disabled') + '>Privacy & retention…</button></div></header>' +
        '<div class="sr-stats" role="group" aria-label="Response overview">' +
          [[list.length, 'Total'], [done.length, 'Completed'], [partial, 'Partial' + (abandoned ? ' (' + abandoned + ' abandoned)' : '')], [list.length ? Math.round(done.length / list.length * 100) + '%' : '—', 'Completion rate'], [med === null ? '—' : fmtDur(med), 'Median time to complete']]
            .map(([v, l]) => '<div class="sr-stat"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>').join('') + '</div>' +
        '<div class="sr-tabs" role="tablist" aria-label="Responses view">' + [['responses', 'Individual responses'], ['summary', 'Summary']].map(([v, l]) => '<button type="button" role="tab" class="sr-tab' + (view === v ? ' is-on' : '') + '" aria-selected="' + (view === v) + '" data-view="' + v + '">' + l + '</button>').join('') + '</div>' +
        '<div class="sr-body"></div></div>';
      host.querySelector('.sr-head').onclick = onHeadClick;
      host.querySelector('.sr-tabs').onclick = e => { const b = e.target.closest('[data-view]'); if (b) { view = b.dataset.view; render(); } };
      const body = host.querySelector('.sr-body');
      if (!list.length) {
        body.innerHTML = '<div class="card"><div class="empty-state"><div class="empty-title">No responses yet</div><div class="empty-sub">' + (live ? 'Responses appear here as soon as people start the published survey.' : 'Publish the survey (top right), share its link, and responses appear here.') + '</div></div></div>';
        return;
      }
      if (view === 'summary') renderSummary(body, done);
      else renderSplit(body);
    }

    function onHeadClick(e) {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      if (b.dataset.act === 'refresh') load();
      if (b.dataset.act === 'export') exportDialog();
      if (b.dataset.act === 'privacy') privacyDialog();
      if (b.dataset.act === 'to-project') opts.toProject(list.filter(r => r.status === 'complete'), Core.questionsInOrder(doc()));
    }

    /* ── Split view ─────────────────────────── */
    function renderSplit(body) {
      body.innerHTML = '<div class="sr-split">' +
        '<aside class="sr-listpane" aria-label="Responses">' +
          '<div class="sr-filters">' +
            '<label class="sr-search"><span class="sr-only">Search responses</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input type="search" id="sr-q" placeholder="Participant code, name, answer text…" value="' + esc(filters.q) + '"></label>' +
            '<div class="sr-filter-row"><label><span>Status</span><select id="sr-status">' + [['all', 'All'], ['complete', 'Complete'], ['in_progress', 'In progress'], ['abandoned', 'Abandoned']].map(([v, l]) => '<option value="' + v + '"' + (filters.status === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
              '<label><span>Sort</span><select id="sr-sort">' + [['newest', 'Newest'], ['oldest', 'Oldest'], ['longest', 'Longest'], ['shortest', 'Shortest']].map(([v, l]) => '<option value="' + v + '"' + (filters.sort === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label></div>' +
            '<div class="sr-filter-row"><label><span>From</span><input type="date" id="sr-from" value="' + esc(filters.from) + '"></label><label><span>To</span><input type="date" id="sr-to" value="' + esc(filters.to) + '"></label></div>' +
          '</div>' +
          '<div class="sr-count" id="sr-count" role="status" aria-live="polite"></div>' +
          '<ul class="sr-list" id="sr-list" role="listbox" aria-label="Responses" tabindex="0"></ul>' +
        '</aside>' +
        '<section class="sr-detail" id="sr-detail" aria-live="polite"></section></div>';
      const q = body.querySelector('#sr-q');
      let t = null;
      q.oninput = () => { clearTimeout(t); t = setTimeout(() => { filters.q = q.value; drawList(); }, 120); };
      body.querySelector('#sr-status').onchange = e => { filters.status = e.target.value; drawList(); };
      body.querySelector('#sr-sort').onchange = e => { filters.sort = e.target.value; drawList(); };
      body.querySelector('#sr-from').onchange = e => { filters.from = e.target.value; drawList(); };
      body.querySelector('#sr-to').onchange = e => { filters.to = e.target.value; drawList(); };
      const ul = body.querySelector('#sr-list');
      ul.onclick = e => { const li = e.target.closest('[data-rid]'); if (li) select(li.dataset.rid); };
      ul.onkeydown = e => {
        if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
        if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
      };
      drawList();
    }
    function drawList() {
      const ul = host.querySelector('#sr-list');
      if (!ul) return;
      const rows = filtered();
      const count = host.querySelector('#sr-count');
      count.textContent = rows.length === list.length ? list.length + ' response' + (list.length === 1 ? '' : 's') : rows.length + ' of ' + list.length + ' match';
      if (!rows.some(r => r.id === selectedId)) selectedId = rows.length ? rows[0].id : null;
      ul.innerHTML = rows.length ? rows.slice(0, 1000).map(r => {
        const who = respondentLine(r);
        const answered = Object.keys(r.answers || {}).length;
        return '<li class="sr-item' + (r.id === selectedId ? ' is-on' : '') + '" role="option" aria-selected="' + (r.id === selectedId) + '" data-rid="' + esc(r.id) + '" id="sr-opt-' + esc(r.id) + '">' +
          '<span class="sr-item-top"><span class="sr-status-dot is-' + statusOf(r) + '" aria-hidden="true"></span><span class="sr-item-who">' + (who || '<span class="sr-mono">' + esc(r.id) + '</span>') + '</span><span class="sr-item-when">' + esc(ago(r.completedAt || r.updatedAt)) + '</span></span>' +
          '<span class="sr-item-sub">' + STATUS[statusOf(r)][0] + ' · ' + answered + ' answer' + (answered === 1 ? '' : 's') + ' · ' + fmtDur(durationOf(r)) + (r.session && (r.session.events || []).length ? ' · timeline' : '') + '</span></li>';
      }).join('') + (rows.length > 1000 ? '<li class="sr-more">Showing the first 1,000 — narrow the filters to see others.</li>' : '')
        : '<li class="sr-more">No responses match these filters. <button type="button" class="ss-chip-btn" id="sr-clear">Clear filters</button></li>';
      const clear = host.querySelector('#sr-clear');
      if (clear) clear.onclick = () => { Object.assign(filters, { q: '', status: 'all', from: '', to: '' }); renderSplit(host.querySelector('.sr-body')); };
      if (selectedId) ul.setAttribute('aria-activedescendant', 'sr-opt-' + selectedId); else ul.removeAttribute('aria-activedescendant');
      drawDetail();
    }
    function select(id) {
      selectedId = id;
      host.querySelectorAll('.sr-item').forEach(li => { const on = li.dataset.rid === id; li.classList.toggle('is-on', on); li.setAttribute('aria-selected', String(on)); });
      const ul = host.querySelector('#sr-list');
      if (ul) ul.setAttribute('aria-activedescendant', 'sr-opt-' + id);
      const li = host.querySelector('.sr-item.is-on');
      if (li) li.scrollIntoView({ block: 'nearest' });
      drawDetail();
    }
    function step(d) {
      const rows = filtered();
      const i = rows.findIndex(r => r.id === selectedId);
      const n = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i + d)))];
      if (n) select(n.id);
    }

    /* ── Detail ─────────────────────────────── */
    async function drawDetail() {
      stopReplay();
      const box = host.querySelector('#sr-detail');
      if (!box) return;
      const r = list.find(x => x.id === selectedId);
      if (!r) { box.innerHTML = '<div class="empty-state"><div class="empty-sub">Select a response.</div></div>'; return; }
      const rows = filtered();
      const i = rows.findIndex(x => x.id === r.id);
      box.innerHTML = '<div class="loading-state">Loading…</div>';
      const vdoc = (await versionDoc(r)) || doc();
      if (selectedId !== r.id) return;
      const who = respondentLine(r);
      const events = eventsOf(r);
      box.innerHTML = '<div class="sr-dhead"><div class="sr-dtitle"><div class="sr-dline">' + statusBadge(r) + '<span class="sr-mono sr-rid">' + esc(r.id) + '</span><span class="sr-muted">v' + esc(r.version) + '</span></div>' +
          (who ? '<div class="sr-who">' + who + '</div>' : '') +
          '<div class="sr-muted sr-dmeta">' + (r.completedAt ? 'Submitted ' + esc(when(r.completedAt)) : 'Last activity ' + esc(when(r.updatedAt))) + ' · ' + fmtDur(durationOf(r)) + '</div></div>' +
          '<div class="sr-nav"><button type="button" class="btn btn-ghost btn-sm" data-step="-1"' + (i <= 0 ? ' disabled' : '') + ' aria-label="Previous response">← Prev</button><span class="sr-muted">' + (i + 1) + ' / ' + rows.length + '</span><button type="button" class="btn btn-ghost btn-sm" data-step="1"' + (i >= rows.length - 1 ? ' disabled' : '') + ' aria-label="Next response">Next →</button>' +
          '<button type="button" class="ss-icon-btn" data-del="' + esc(r.id) + '" title="Delete this response" aria-label="Delete response ' + esc(r.id) + '">✕</button></div></div>' +
        '<div class="sr-dtabs" role="tablist" aria-label="Response details">' + [['answers', 'Answers'], ['timeline', 'Timeline' + (events.length ? ' (' + events.length + ')' : '')], ['details', 'Details']].map(([v, l]) => '<button type="button" role="tab" class="sr-dtab' + (tab === v ? ' is-on' : '') + '" aria-selected="' + (tab === v) + '" data-tab="' + v + '">' + esc(l) + '</button>').join('') + '</div>' +
        '<div class="sr-dbody" role="tabpanel"></div>';
      box.onclick = async e => {
        const st = e.target.closest('[data-step]'); if (st && !st.disabled) { step(Number(st.dataset.step)); return; }
        const tb = e.target.closest('[data-tab]'); if (tb) { tab = tb.dataset.tab; drawDetail(); return; }
        const del = e.target.closest('[data-del]');
        if (del) {
          if (!confirm('Delete this response? This can\'t be undone.')) return;
          try { await opts.api('/' + doc().id + '/responses/' + encodeURIComponent(del.dataset.del), { method: 'DELETE' }); list = list.filter(x => x.id !== del.dataset.del); App.notify('Response deleted', 'success'); render(); } catch (err) { App.notify(err.message, 'error'); }
        }
      };
      const dbody = box.querySelector('.sr-dbody');
      if (tab === 'timeline') drawTimeline(dbody, r, vdoc, events);
      else if (tab === 'details') drawDetails(dbody, r, vdoc);
      else drawAnswers(dbody, r, vdoc, events);
    }

    function drawAnswers(el, r, vdoc, events, focusQ) {
      const pres = presented(vdoc, r);
      const lastAnswer = {}, changes = {}, skipped = new Set();
      events.forEach(e => {
        if (e.type === 'answer' && e.q) { lastAnswer[e.q] = e.t; changes[e.q] = (changes[e.q] || 0) + 1; }
        if (e.type === 'skip' && e.q) skipped.add(e.q);
      });
      let n = 0, curPage = null;
      const item = ({ q, page }, shown) => {
        const v = r.answers ? r.answers[q.id] : undefined;
        const has = v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
        const head = (shown && page !== curPage ? (curPage = page, '<div class="sr-page">' + esc(pageName(vdoc, page)) + '</div>') : '');
        const meta = [];
        if (lastAnswer[q.id] !== undefined) meta.push('answered at ' + clock(lastAnswer[q.id]));
        if (changes[q.id] > 1) meta.push('changed ' + (changes[q.id] - 1) + '×');
        return head + '<article class="sr-q' + (has ? '' : ' is-empty') + (focusQ === q.id ? ' is-focus' : '') + '" id="sr-q-' + esc(q.id) + '">' +
          '<div class="sr-q-head"><span class="sr-q-n">' + (shown ? (++n) : '–') + '</span><div class="sr-q-title">' + esc(titleOf(vdoc, q)) + '</div><span class="sr-q-type">' + esc(TYPE_NAMES[q.type] || Core.typeLabel(q.type)) + '</span></div>' +
          '<div class="sr-q-answer">' + (has ? answerHTML(vdoc, q, v) : '<span class="sr-skip">' + (shown ? (skipped.has(q.id) ? 'Skipped' : 'Not answered') : 'Not shown to this respondent') + '</span>') + '</div>' +
          (meta.length ? '<div class="sr-q-meta">' + esc(meta.join(' · ')) + '</div>' : '') + '</article>';
      };
      el.innerHTML = '<div class="sr-answers">' +
        (pres.known ? '' : '<p class="sr-note">This response doesn\'t record which pages were shown, so every question is listed in survey order.</p>') +
        pres.shown.map(x => item(x, true)).join('') +
        (pres.notShown.length ? '<details class="sr-notshown"><summary>' + pres.notShown.length + ' question' + (pres.notShown.length === 1 ? '' : 's') + ' not shown to this respondent (skipped by logic or not reached)</summary>' + pres.notShown.map(x => item(x, false)).join('') + '</details>' : '') +
        (r.outcome ? '<p class="sr-note">Outcome message: ' + esc(r.outcome) + '</p>' : '') + '</div>';
      if (focusQ) { const f = el.querySelector('#sr-q-' + CSS.escape(focusQ)); if (f) { const d = f.closest('details'); if (d) d.open = true; f.scrollIntoView({ block: 'center' }); } }
    }

    function eventLabel(vdoc, e, prevAnswered) {
      const q = e.q ? '“' + qName(vdoc, e.q) + '”' : '';
      switch (e.type) {
        case 'start': return ['Started the survey on ' + pageName(vdoc, e.page), 'start'];
        case 'page': return [(e.dir === 'back' ? 'Went back to ' : e.dir === 'jump' ? 'Jumped to ' : 'Went to ') + pageName(vdoc, e.page), 'page'];
        case 'focus': return ['Entered ' + q, 'focus'];
        case 'answer': {
          if (e.cleared) return ['Cleared the answer to ' + q, 'answer'];
          const verb = prevAnswered ? 'Changed the answer to ' : 'Answered ';
          if (e.len !== undefined) return [verb + q + ' (typed ' + e.len + ' character' + (e.len === 1 ? '' : 's') + ')', 'answer'];
          const qq = vdoc && vdoc.elements[e.q];
          return [verb + q + ': ' + (qq ? plainAnswer(vdoc, qq, e.value) : JSON.stringify(e.value)), 'answer'];
        }
        case 'skip': return ['Left ' + q + ' unanswered', 'skip'];
        case 'invalid': return [e.respondent ? 'Respondent information was incomplete' : (e.qs && e.qs.length ? e.qs.length + ' question' + (e.qs.length === 1 ? '' : 's') + ' needed attention: ' + e.qs.map(x => '“' + qName(vdoc, x) + '”').join(', ') : 'Validation messages were shown'), 'invalid'];
        case 'away': return ['Left the survey tab', 'away'];
        case 'back': return ['Came back to the survey tab', 'away'];
        case 'resume': return ['Reopened the survey page', 'away'];
        case 'submit': return ['Submitted the survey', 'submit'];
        case 'abandon': return ['Left before finishing' + (e.page ? ' (on ' + pageName(vdoc, e.page) + ')' : ''), 'abandon'];
        default: return [e.type, 'other'];
      }
    }

    function drawTimeline(el, r, vdoc, events) {
      const s = r.session;
      if (!events.length) {
        const why = !s ? 'No session timeline was recorded for this response. Timelines are recorded only while Settings → Session timeline is on (responses collected before it was turned on have none), and with “Ask respondents first” only when the respondent allowed it. Nothing is reconstructed for responses without one.'
          : s.recording === 'declined' ? 'The respondent chose “Start without the timeline”, so no timeline was recorded.'
          : s.erased ? 'This response\'s timeline was erased (Privacy & retention).' : 'The timeline for this response has no events yet.';
        el.innerHTML = '<div class="sr-empty-tl"><div class="empty-title">No timeline</div><p>' + esc(why) + '</p></div>';
        return;
      }
      const visits = pageVisits(events);
      const total = events[events.length - 1].t;
      const away = awayTime(events);
      const answerEvents = events.filter(e => e.type === 'answer');
      const changed = answerEvents.length - new Set(answerEvents.map(e => e.q)).size;
      const invalid = events.filter(e => e.type === 'invalid').length;
      const PAGE_COLORS = ['#2563EB', '#7C3AED', '#0D9488', '#D97706', '#DB2777', '#4F46E5', '#059669', '#B45309'];
      const order = Array.from(new Set(visits.map(v => v.page)));
      const colorOf = pid => PAGE_COLORS[order.indexOf(pid) % PAGE_COLORS.length];
      const seenAnswer = new Set();
      const rowsHtml = events.map((e, i) => {
        const prev = e.type === 'answer' && e.q && seenAnswer.has(e.q);
        if (e.type === 'answer' && e.q) seenAnswer.add(e.q);
        const [label, kind] = eventLabel(vdoc, e, prev);
        const gap = i ? e.t - events[i - 1].t : 0;
        return '<li class="sr-ev is-' + kind + '" data-i="' + i + '" tabindex="-1"><span class="sr-ev-t">' + clock(e.t) + '</span><span class="sr-ev-dot" aria-hidden="true"></span><span class="sr-ev-label">' + esc(label) + '</span>' +
          (gap >= 1000 ? '<span class="sr-ev-gap">+' + fmtDur(gap) + '</span>' : '') + '</li>';
      }).join('');
      el.innerHTML = '<div class="sr-tl">' +
        '<div class="sr-tl-stats">' + [['Session length', fmtDur(total)], ['Pages viewed', visits.length], ['Answer changes', Math.max(0, changed)], ['Validation messages', invalid], ['Away from tab', fmtDur(away)]].map(([l, v]) => '<div><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>').join('') + '</div>' +
        '<div class="sr-tl-bar" role="img" aria-label="Time spent on each page">' + visits.map(v => { const w = total ? Math.max(1.5, (v.end - v.start) / total * 100) : 100 / visits.length; return '<span style="width:' + w + '%;background:' + colorOf(v.page) + '" title="' + esc(pageName(vdoc, v.page)) + ': ' + fmtDur(v.end - v.start) + '"></span>'; }).join('') + '</div>' +
        '<ul class="sr-tl-legend">' + visits.map(v => '<li><i style="background:' + colorOf(v.page) + '"></i>' + esc(pageName(vdoc, v.page)) + ' <span class="sr-muted">' + fmtDur(v.end - v.start) + (v.dir === 'back' ? ' · went back' : '') + '</span></li>').join('') + '</ul>' +
        '<div class="sr-tl-main"><div class="sr-tl-events"><div class="sr-tl-h"><span>Events</span><span class="sr-muted">' + events.length + (s.truncated ? ' (limit reached; later events weren\'t kept)' : '') + ' · recorded with ' + (s.recording === 'consent' ? 'consent' : 'notice') + '</span></div><ol class="sr-evlist" role="listbox" aria-label="Session events" tabindex="0">' + rowsHtml + '</ol></div>' +
        '<aside class="sr-replay" aria-label="Step-through replay"><div class="sr-tl-h"><span>Step-through replay</span><span class="sr-replay-ctl"><button type="button" class="btn btn-ghost btn-sm" data-rp="-1" aria-label="Previous event">◀</button><button type="button" class="btn btn-secondary btn-sm" data-rp="play">▶ Play</button><button type="button" class="btn btn-ghost btn-sm" data-rp="1" aria-label="Next event">▶</button></span></div><div class="sr-replay-body"><p class="sr-muted">Select an event to see where the respondent was and what they had answered at that moment. This replays the recorded events in order — it is not a video of the screen.</p></div></aside></div>' +
      '</div>';
      const evl = el.querySelector('.sr-evlist');
      const show = i => {
        i = Math.max(0, Math.min(events.length - 1, i));
        if (replay) replay.i = i; else replay = { i, timer: null };
        el.querySelectorAll('.sr-ev').forEach(li => li.classList.toggle('is-on', Number(li.dataset.i) === i));
        const li = el.querySelector('.sr-ev[data-i="' + i + '"]');
        if (li) li.scrollIntoView({ block: 'nearest' });
        drawReplay(el.querySelector('.sr-replay-body'), r, vdoc, events, i);
      };
      evl.onclick = e => { const li = e.target.closest('.sr-ev'); if (li) { pausePlay(el); show(Number(li.dataset.i)); } };
      evl.onkeydown = e => { if (e.key === 'ArrowDown') { e.preventDefault(); show((replay ? replay.i : -1) + 1); } if (e.key === 'ArrowUp') { e.preventDefault(); show((replay ? replay.i : 1) - 1); } };
      el.querySelector('.sr-replay-ctl').onclick = e => {
        const b = e.target.closest('[data-rp]'); if (!b) return;
        if (b.dataset.rp === 'play') {
          if (replay && replay.timer) { pausePlay(el); return; }
          const start = !replay || replay.i >= events.length - 1 ? 0 : replay.i + 1;
          show(start);
          b.textContent = '❚❚ Pause';
          replay.timer = setInterval(() => { if (!replay || replay.i >= events.length - 1) { pausePlay(el); return; } show(replay.i + 1); }, 700);
          return;
        }
        pausePlay(el);
        show((replay ? replay.i : -1) + Number(b.dataset.rp));
      };
      el.onclick = e => {
        const go = e.target.closest('[data-goq]');
        if (go) { pausePlay(el); tab = 'answers'; const box = host.querySelector('#sr-detail'); box.querySelectorAll('[data-tab]').forEach(t => { const on = t.dataset.tab === 'answers'; t.classList.toggle('is-on', on); t.setAttribute('aria-selected', String(on)); }); drawAnswers(box.querySelector('.sr-dbody'), r, vdoc, events, go.dataset.goq); return; }
        const pg = e.target.closest('[data-gopage]');
        if (pg && opts.onOpenPage) opts.onOpenPage(pg.dataset.gopage);
      };
    }
    function pausePlay(el) {
      if (replay && replay.timer) { clearInterval(replay.timer); replay.timer = null; }
      const b = el && el.querySelector('[data-rp="play"]');
      if (b) b.textContent = '▶ Play';
    }
    function stopReplay() { if (replay && replay.timer) clearInterval(replay.timer); replay = null; }

    function drawReplay(box, r, vdoc, events, i) {
      const e = events[i];
      const st = stateAt(events, i);
      const p = st.page && Core.getPage(vdoc, st.page);
      const qs = p ? Core.questionsInOrder(vdoc).filter(q => { const pg = Core.pageOf(vdoc, q.id); return pg && pg.id === p.id; }) : [];
      const visited = [];
      events.slice(0, i + 1).forEach(x => { if ((x.type === 'start' || x.type === 'page') && x.page && !visited.includes(x.page)) visited.push(x.page); });
      const [label] = eventLabel(vdoc, e, events.slice(0, i).some(x => x.type === 'answer' && x.q === e.q));
      box.innerHTML = '<div class="sr-rp-now"><span class="sr-ev-t">' + clock(e.t) + '</span> ' + esc(label) + '</div>' +
        '<div class="sr-rp-pages" aria-label="Pages">' + vdoc.pages.filter(pg => !(pg.props && pg.props.ending)).map(pg => '<span class="' + (p && pg.id === p.id ? 'is-now' : visited.includes(pg.id) ? 'is-seen' : '') + '">' + esc(pg.name) + '</span>').join('') + '</div>' +
        (p ? '<div class="sr-rp-page"><div class="sr-rp-ptitle"><b>' + esc(p.name) + '</b>' + (opts.onOpenPage ? '<button type="button" class="ss-chip-btn" data-gopage="' + esc(p.id) + '">Open page in editor</button>' : '') + '</div>' +
          (qs.length ? '<ul class="sr-rp-qs">' + qs.map(q => {
            const a = st.answers[q.id];
            const val = !a ? '<span class="sr-skip">No answer yet</span>' : a.len !== undefined ? '<span class="sr-chip">typed ' + a.len + ' character' + (a.len === 1 ? '' : 's') + '</span>' : '<span class="sr-chip">' + esc(plainAnswer(vdoc, q, a.value)) + '</span>';
            return '<li class="' + (e.q === q.id ? 'is-now' : '') + '"><span class="sr-rp-q">' + esc(titleOf(vdoc, q)) + '</span>' + val + '<button type="button" class="sr-link" data-goq="' + esc(q.id) + '">Show in answers</button></li>';
          }).join('') + '</ul>' : '<p class="sr-muted">No questions on this page.</p>') + '</div>' : '') +
        '<p class="sr-muted sr-rp-foot">Typed text is shown by length only — its content is in the final answers.</p>';
    }

    function drawDetails(el, r, vdoc) {
      const who = r.respondent || {};
      const d = who.derived || {};
      const row = (k, v, src) => '<tr><th>' + esc(k) + '</th><td>' + v + (src ? '<div class="sr-src">' + esc(src) + '</div>' : '') + '</td></tr>';
      const priv = Core.privacyOf(vdoc);
      const notCollected = '<span class="sr-muted">Not collected</span>';
      const geoSrc = d.geoSource === 'cloudflare' ? 'Approximate — from the IP address, by Cloudflare' : d.geoSource === 'header' ? 'Approximate — from the IP address, by the reverse proxy' : 'Approximate — from the IP address';
      const idRows = [];
      if (priv.entered.name || who.name) idRows.push(row('Name', who.name ? esc(who.name) : (who.identityErased ? '<span class="sr-muted">Erased</span>' : notCollected), 'Entered by the participant'));
      if (priv.entered.participantId || priv.link || who.participantId) idRows.push(row('Participant code', who.participantId ? '<span class="sr-mono">' + esc(who.participantId) + '</span>' : (who.identityErased ? '<span class="sr-muted">Erased</span>' : notCollected), who.participantIdSource === 'link' ? 'From the survey link' : 'Entered by the participant'));
      if (priv.derived.country || d.country !== undefined) idRows.push(row('Country', d.country ? flagOf(d.country) + ' ' + esc(countryName(d.country)) + ' <span class="sr-muted">(' + esc(d.country) + ')</span>' : (d.locationErased ? '<span class="sr-muted">Erased</span>' : d.geoNote === 'not_configured' ? '<span class="sr-muted">Unavailable — the server has no location source (SURVEY_GEO_HEADERS)</span>' : '<span class="sr-muted">Unknown</span>'), geoSrc));
      if (priv.derived.region || d.region !== undefined) idRows.push(row('State / region', d.region ? esc(d.region) : (d.locationErased ? '<span class="sr-muted">Erased</span>' : '<span class="sr-muted">Unknown</span>'), geoSrc));
      if (priv.derived.ip || d.ip !== undefined || d.ipNote || d.ipErased) idRows.push(row('IP address', d.ip ? '<span class="sr-mono">' + esc(d.ip) + '</span>' : (d.ipErased ? '<span class="sr-muted">Erased</span>' : d.ipNote === 'behind_proxy' ? '<span class="sr-muted">Unavailable — the server is behind a proxy it doesn\'t trust (set TRUST_PROXY)</span>' : '<span class="sr-muted">Unknown</span>'), 'Seen by the server when the response was first saved'));
      const vars = Object.keys(r.vars || {}).filter(k => !/^__/.test(k));
      el.innerHTML = '<div class="sr-details">' +
        '<section><h3>Respondent</h3>' + (idRows.length ? '<table class="sr-kv">' + idRows.join('') + '</table><p class="sr-note">Visible only to this survey\'s owner. Location is an estimate from the IP address, not verified information.</p>' : '<p class="sr-muted">Anonymous — this survey version doesn\'t collect respondent information.</p>') + '</section>' +
        '<section><h3>Session</h3><table class="sr-kv">' +
          row('Response ID', '<span class="sr-mono">' + esc(r.id) + '</span>') + row('Status', statusBadge(r)) + row('Survey version', 'v' + esc(r.version)) +
          row('Started', esc(when(r.startedAt))) + row('Last activity', esc(when(r.updatedAt))) + row('Submitted', r.completedAt ? esc(when(r.completedAt)) : '<span class="sr-muted">Not submitted</span>') +
          row('Duration', esc(fmtDur(durationOf(r)))) + row('Pages seen', Array.isArray(r.path) && r.path.length ? esc(Array.from(new Set(r.path)).map(pid => pageName(vdoc, pid)).join(' → ')) : '<span class="sr-muted">Not recorded</span>') +
          row('Device', esc((r.meta && r.meta.device) || 'unknown')) + row('Browser language', esc((r.meta && r.meta.language) || '—')) +
          row('Score', esc(r.score === undefined || r.score === null ? '—' : r.score)) +
          row('Session timeline', r.session ? (r.session.recording === 'declined' ? 'Declined by the respondent' : ((r.session.events || []).length + ' events · recorded with ' + r.session.recording)) : '<span class="sr-muted">Not recorded</span>') +
        '</table></section>' +
        (vars.length ? '<section><h3>Variables</h3><table class="sr-kv">' + vars.map(k => row(k, '<span class="sr-mono">' + esc(typeof r.vars[k] === 'object' ? JSON.stringify(r.vars[k]) : r.vars[k]) + '</span>')).join('') + '</table></section>' : '') +
      '</div>';
    }

    /* ── Summary ────────────────────────────── */
    function renderSummary(body, done) {
      const qs = Core.questionsInOrder(doc());
      body.innerHTML = done.length ? '<p class="sr-note">Summaries of the ' + done.length + ' completed response' + (done.length === 1 ? '' : 's') + ', using the current version\'s questions.</p><div class="ss-resp-summary">' + qs.map(q => summaryCard(q, done)).join('') + '</div>'
        : '<div class="card"><div class="empty-state"><div class="empty-sub">No completed responses yet — summaries count completed responses only.</div></div></div>';
    }
    function summaryCard(q, done) {
      const kind = Logic.valueKind(q);
      const answered = done.filter(r => r.answers && r.answers[q.id] !== undefined);
      let b = '';
      if (kind === 'choice' || kind === 'multi') {
        const ch = Logic.choicesOf(doc(), q);
        const counts = ch.map(c => answered.filter(r => { const v = r.answers[q.id]; return Array.isArray(v) ? v.some(x => same(x, c.value)) : same(v, c.value); }).length);
        const max = Math.max(1, ...counts);
        b = '<ul class="ss-bars">' + ch.map((c, i) => '<li><span class="ss-bar-label">' + esc(c.label || c.value) + '</span><span class="ss-hbar"><span style="width:' + (counts[i] / max * 100) + '%"></span></span><span class="ss-bar-n">' + counts[i] + '</span></li>').join('') + '</ul>';
      } else if (kind === 'number') {
        const nums = answered.map(r => Number(r.answers[q.id])).filter(Number.isFinite);
        b = nums.length ? '<div class="ss-tp-kv"><span>Average</span><b>' + (Math.round(nums.reduce((a, c) => a + c, 0) / nums.length * 100) / 100) + '</b></div><div class="ss-tp-kv"><span>Range</span><b>' + Math.min(...nums) + ' – ' + Math.max(...nums) + '</b></div>' : '';
      } else if (kind === 'text') {
        b = '<ul class="ss-quotes">' + answered.slice(-3).reverse().map(r => '<li>' + esc(String(r.answers[q.id]).slice(0, 160)) + '</li>').join('') + '</ul>';
      }
      return '<div class="ss-sum-card"><div class="ss-sum-title">' + esc(Core.displayName(doc(), q)) + '</div><div class="ss-sum-sub">' + answered.length + ' of ' + done.length + ' answered</div>' + b + '</div>';
    }

    /* ── Export ─────────────────────────────── */
    const cell = v => { if (v === undefined || v === null) return ''; if (Array.isArray(v)) return v.join('; '); if (typeof v === 'object') return Object.keys(v).map(k => k + '=' + v[k]).join('; '); return String(v); };
    function exportDialog() {
      App.openModal('Export responses',
        '<div class="sr-export"><fieldset><legend>Format</legend>' +
          [['csv', 'CSV — one row per response'], ['json', 'JSON — responses with question details'], ['events', 'Session events CSV — one row per timeline event']].map(([v, l], i) => '<label class="ss-check-row"><input type="radio" name="sr-fmt" value="' + v + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(l) + '</label>').join('') + '</fieldset>' +
        '<fieldset><legend>Include</legend>' +
          '<label class="ss-check-row"><input type="checkbox" id="sr-x-id"> Participant code and name</label>' +
          '<label class="ss-check-row"><input type="checkbox" id="sr-x-ip"> IP address and approximate location</label>' +
          '<label class="ss-check-row"><input type="checkbox" id="sr-x-tl"> Session timelines (JSON)</label>' +
          '<label class="ss-check-row"><input type="checkbox" id="sr-x-filter"> Only the responses matching the current filters</label></fieldset>' +
        '<p class="form-hint">Identifying fields are left out unless you include them. Each row and event keeps its response ID, so files can be joined.</p></div>',
        '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="sr-x-go">Download</button>');
      document.getElementById('sr-x-go').onclick = () => {
        const fmt = (document.querySelector('input[name="sr-fmt"]:checked') || {}).value || 'csv';
        const withId = document.getElementById('sr-x-id').checked, withIp = document.getElementById('sr-x-ip').checked, withTl = document.getElementById('sr-x-tl').checked;
        const rows = document.getElementById('sr-x-filter').checked ? filtered() : list;
        App.closeModal();
        doExport(fmt, rows, { withId, withIp, withTl });
      };
    }
    function doExport(fmt, rows, o) {
      const d = doc();
      const name = Core.slug(d.title, 'survey');
      const qs = Core.questionsInOrder(d);
      const keys = qs.map(q => Core.dataKeyOf(d, q));
      const extra = Array.from(new Set(rows.flatMap(r => Object.keys(r.byKey || {})))).filter(k => !keys.includes(k));
      const cols = keys.concat(extra);
      const varCols = Array.from(new Set(rows.flatMap(r => Object.keys(r.vars || {})))).filter(k => !/^__/.test(k) && !cols.includes(k));
      const who = r => r.respondent || {};
      const der = r => (r.respondent && r.respondent.derived) || {};
      if (fmt === 'csv') {
        const header = ['response_id', 'status', 'version', 'started_at', 'completed_at', 'duration_seconds', 'score']
          .concat(o.withId ? ['participant_id', 'participant_id_source', 'name'] : [], o.withIp ? ['ip_address', 'country', 'region', 'location_source'] : [], cols, varCols);
        App.downloadCSV(name + '-responses.csv', header, rows.map(r => [r.id, statusOf(r), r.version, r.startedAt, r.completedAt || '', Math.round(durationOf(r) / 1000), r.score]
          .concat(o.withId ? [who(r).participantId || '', who(r).participantIdSource || '', who(r).name || ''] : [], o.withIp ? [der(r).ip || '', der(r).country || '', der(r).region || '', der(r).geoSource || ''] : [],
            cols.map(c => cell(r.byKey ? r.byKey[c] : undefined)), varCols.map(c => cell(r.vars ? r.vars[c] : undefined)))));
      } else if (fmt === 'events') {
        const qKey = id => { const q = d.elements[id]; return q ? Core.dataKeyOf(d, q) : id; };
        const out = [];
        rows.forEach(r => eventsOf(r).forEach(e => out.push([r.id, e.t, e.type, e.page || '', e.from || '', e.q ? qKey(e.q) : '', e.dir || '', e.value !== undefined ? cell(e.value) : '', e.len !== undefined ? e.len : '', e.cleared ? 'yes' : '', e.qs ? e.qs.map(qKey).join('; ') : ''])));
        if (!out.length) { App.notify('None of these responses has a session timeline.', 'info'); return; }
        App.downloadCSV(name + '-session-events.csv', ['response_id', 't_ms', 'event', 'page_id', 'from_page_id', 'question_key', 'direction', 'value', 'text_length', 'cleared', 'questions'], out);
      } else {
        const questions = qs.map(q => ({ id: q.id, key: Core.dataKeyOf(d, q), type: q.type, title: Core.displayName(d, q), choices: ['choice', 'multi', 'ranking'].includes(Logic.valueKind(q)) ? Logic.choicesOf(d, q).map(c => ({ value: c.value, label: c.label })) : undefined }));
        const out = rows.map(r => {
          const x = { id: r.id, status: statusOf(r), version: r.version, startedAt: r.startedAt, completedAt: r.completedAt, updatedAt: r.updatedAt, score: r.score, answers: r.byKey, vars: r.vars, path: r.path, outcome: r.outcome, meta: r.meta };
          if (o.withId || o.withIp) {
            const resp = {};
            if (o.withId) ['participantId', 'participantIdSource', 'name'].forEach(k => { if (who(r)[k] !== undefined) resp[k] = who(r)[k]; });
            if (o.withIp && r.respondent && r.respondent.derived) resp.derived = r.respondent.derived;
            x.respondent = resp;
          }
          if (o.withTl && r.session) x.session = r.session;
          return x;
        });
        opts.download(name + '-responses.json', JSON.stringify({ survey: { id: d.id, title: d.title }, exportedAt: new Date().toISOString(), questions, responses: out }, null, 2), 'application/json');
      }
    }

    /* ── Privacy & retention ────────────────── */
    function privacyDialog() {
      const has = f => list.some(f);
      const c = {
        ip: list.filter(r => r.respondent && r.respondent.derived && r.respondent.derived.ip).length,
        location: list.filter(r => r.respondent && r.respondent.derived && (r.respondent.derived.country || r.respondent.derived.region)).length,
        identity: list.filter(r => r.respondent && (r.respondent.name || r.respondent.participantId)).length,
        timeline: list.filter(r => r.session && (r.session.events || []).length).length
      };
      void has;
      App.openModal('Privacy & retention',
        '<p class="form-hint" style="margin-bottom:12px">Remove data you no longer need from every response of this survey. Answers stay; this can\'t be undone. Deleting a response (✕) removes all of it.</p>' +
        '<div class="sr-privacy">' + [['ip', 'IP addresses', c.ip], ['location', 'Country and region', c.location], ['identity', 'Names and participant codes', c.identity], ['timeline', 'Session timelines', c.timeline]]
          .map(([k, l, n]) => '<div class="sr-priv-row"><div><b>' + esc(l) + '</b><span class="sr-muted"> · in ' + n + ' response' + (n === 1 ? '' : 's') + '</span></div><button type="button" class="btn btn-secondary btn-sm" data-erase="' + k + '"' + (n ? '' : ' disabled') + '>Erase</button></div>').join('') +
          '<div class="sr-priv-row"><div><b>All responses</b><span class="sr-muted"> · ' + list.length + '</span></div><button type="button" class="btn btn-ghost btn-sm" data-erase="all">Delete all</button></div></div>',
        '<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>');
      document.getElementById('modal-body').onclick = async e => {
        const b = e.target.closest('[data-erase]');
        if (!b || b.disabled) return;
        const what = b.dataset.erase;
        if (what === 'all') {
          if (!confirm('Delete all ' + list.length + ' responses? This can\'t be undone.')) return;
          try { await opts.api('/' + doc().id + '/responses', { method: 'DELETE' }); App.closeModal(); App.notify('All responses deleted', 'success'); load(); } catch (err) { App.notify(err.message, 'error'); }
          return;
        }
        if (!confirm('Erase ' + b.closest('.sr-priv-row').querySelector('b').textContent.toLowerCase() + ' from every response? This can\'t be undone.')) return;
        try { const out = await opts.api('/' + doc().id + '/responses/erase', { method: 'POST', body: { what } }); App.closeModal(); App.notify('Erased from ' + out.updated + ' response' + (out.updated === 1 ? '' : 's'), 'success'); load(); } catch (err) { App.notify(err.message, 'error'); }
      };
    }

    load();
    return {
      refresh: load,
      destroy() { destroyed = true; stopReplay(); },
      _test: { statusOf, presented, pageVisits, stateAt, flagOf, loaded: () => loaded }
    };
  }

  root.SurveyResponses = { mount, flagOf, countryName, statusOf, pageVisits, stateAt, fmtDur };
})(typeof window !== 'undefined' ? window : globalThis);
