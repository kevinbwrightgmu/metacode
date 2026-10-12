/* ══════════════════════════════════════════════
   human-coding.js — Human Coding: Coder 1, Coder 2, AI Coder, Reliability

   Two independent human coders and the AI coder work on the same posts and
   the same codebook; their records are kept apart:
     post.humanCodes   { dimId: codeId }        Coder 1 (the original human coding)
     post.coder2Codes  { dimId: codeId }        Coder 2
     post.coderNotes   { coder1, coder2 }       each coder's memo for the post
     post.aiCodes      { dimId: { code, confidence, reasoning } }   AI (AI Coding page)
     post.adjudicated  { dimId: { code, basis, note, by, at } }     final research codes
   Adjudication never changes a coder's or the AI's codes.

   Blind coding (on by default): a coder's tab never shows the other coder's
   codes, and AI suggestions stay hidden unless turned on, so the comparison
   isn't contaminated. In one shared browser this is a safeguard, not access
   control; coders on their own computers can export their coding and the
   researcher imports it (Coder file).

   Reliability (reliability-stats.js): per dimension — percent agreement,
   Cohen's κ (nominal), weighted κ (ordinal dimensions), Krippendorff's α;
   code-level binary agreement; confusion matrices; disagreement review and
   adjudication. Units: posts both sources coded on that dimension; missing
   codes are left out pairwise (α uses every post with two or more codes).
   Routes: #human-coding[/coder1|coder2|ai|reliability] and #reliability.
   ══════════════════════════════════════════════ */

const HumanCoder = (() => {
  const S = window.ReliabilityStats;
  const TABS = [['coder1', 'Coder 1'], ['coder2', 'Coder 2'], ['ai', 'AI Coder'], ['reliability', 'Reliability Analysis']];
  const FIELD = { coder1: 'humanCodes', coder2: 'coder2Codes' };
  const esc = s => App.esc(s === undefined || s === null ? '' : String(s));
  let tab = 'coder1';
  const view = { coder1: { idx: 0, filter: 'all' }, coder2: { idx: 0, filter: 'all' }, ai: { filter: 'all' } };
  let rel = { pair: 'c1c2', dim: null, disFilter: 'unresolved', disDim: 'all', open: null };
  let unlocked = false;        // comparisons revealed for this page session (blind mode)
  let keyHandler = null;

  /* ── State ──────────────────────────────── */
  function cfg() {
    const st = App.getState();
    const c = st.coding && typeof st.coding === 'object' ? st.coding : {};
    return {
      coders: { coder1: { name: (c.coders && c.coders.coder1 && c.coders.coder1.name) || '' }, coder2: { name: (c.coders && c.coders.coder2 && c.coders.coder2.name) || '' } },
      blind: c.blind !== false,
      showAI: !!c.showAI,
      measures: c.measures && typeof c.measures === 'object' ? c.measures : {},
      adjudicator: c.adjudicator || ''
    };
  }
  function setCfg(patch) { App.setState({ coding: Object.assign(cfg(), patch) }); }
  const coderLabel = k => { const n = cfg().coders[k] && cfg().coders[k].name; return (k === 'coder1' ? 'Coder 1' : 'Coder 2') + (n ? ' (' + n + ')' : ''); };
  const codesOf = (p, k) => (p && p[FIELD[k]] && typeof p[FIELD[k]] === 'object' ? p[FIELD[k]] : {});
  const aiOf = (p, dimId) => { const a = p && p.aiCodes && p.aiCodes[dimId]; return a && a.code ? a : null; };
  // Who coded what, for any source ('coder1', 'coder2', 'ai', 'final')
  function valueOf(p, src, dimId) {
    if (src === 'ai') { const a = aiOf(p, dimId); return a ? a.code : null; }
    if (src === 'final') return finalCode(p, dimId);
    return codesOf(p, src)[dimId] || null;
  }
  function finalCode(p, dimId) {
    const adj = p.adjudicated && p.adjudicated[dimId];
    if (adj && adj.code) return adj.code;
    const a = codesOf(p, 'coder1')[dimId], b = codesOf(p, 'coder2')[dimId];
    return a && b && a === b ? a : null;
  }
  function statusOf(p, k, codebook) {
    const c = codesOf(p, k);
    const n = codebook.filter(d => c[d.id]).length;
    return n === 0 ? 'none' : n === codebook.length ? 'done' : 'partial';
  }
  function updatePost(id, fn) {
    const posts = App.getState().posts.map(p => (p.id === id ? fn(Object.assign({}, p)) : p));
    App.setState({ posts });
    return posts.find(p => p.id === id);
  }
  const codeLabel = (dim, codeId) => { const c = dim.codes.find(x => x.id === codeId); return c ? c.label : (codeId ? codeId + ' (not in codebook)' : '—'); };

  /* ── Frame ──────────────────────────────── */
  function render(param) {
    const t = param === 'reliability' ? 'reliability' : (TABS.some(x => x[0] === param) ? param : null);
    if (t) tab = t;
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    App.setViewCleanup(() => { if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; } });
    const { posts, codebook } = App.getState();
    const container = document.getElementById('view-container');
    const tb = document.getElementById('topbar-title');
    if (tb) tb.textContent = tab === 'reliability' ? 'Reliability Analysis' : 'Human Coding';
    if (!codebook.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-title">Codebook required</div><div class="empty-sub">Build your codebook before coding — Coder 1, Coder 2 and the AI all code with the same one.</div><button class="btn btn-primary" onclick="App.navigate(\'codebook\')">Go to Codebook</button></div>';
      return;
    }
    if (!posts.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-title">No posts to code</div><div class="empty-sub">Import posts, collect them with the Reddit Scraper, or add survey answers first.</div><button class="btn btn-primary" onclick="App.navigate(\'import\')">Import Posts</button></div>';
      return;
    }
    const c = cfg();
    const counts = { coder1: posts.filter(p => statusOf(p, 'coder1', codebook) !== 'none').length, coder2: posts.filter(p => statusOf(p, 'coder2', codebook) !== 'none').length, ai: posts.filter(p => Object.keys(p.aiCodes || {}).length).length };
    container.innerHTML = '<div class="view-header"><div><div class="view-title">' + (tab === 'reliability' ? 'Reliability Analysis' : 'Human Coding') + '</div>' +
        '<div class="view-subtitle">Two independent human coders and the AI code the same ' + posts.length + ' posts with the same ' + codebook.length + '-dimension codebook.' + (c.blind ? ' Blind coding is on.' : '') + '</div></div>' +
        '<div class="view-actions"><button class="btn btn-secondary btn-sm" id="hc-coderfile">Coder files…</button><label class="hc-switch" title="Hide each coder\'s decisions from the other coder"><input type="checkbox" id="hc-blind"' + (c.blind ? ' checked' : '') + '> Blind coding</label></div></div>' +
      '<div class="hc-tabs" role="tablist" aria-label="Coders">' + TABS.map(([k, l]) => '<button type="button" role="tab" class="hc-tab' + (tab === k ? ' is-on' : '') + '" aria-selected="' + (tab === k) + '" data-tab="' + k + '">' + esc(k === 'coder1' || k === 'coder2' ? l : l) +
        (k !== 'reliability' ? '<span class="hc-tab-n">' + counts[k] + '</span>' : '') + '</button>').join('') + '</div>' +
      '<div id="hc-body"></div>';
    container.querySelector('.hc-tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#human-coding/' + b.dataset.tab; };
    container.querySelector('#hc-blind').onchange = e => {
      setCfg({ blind: e.target.checked });
      if (e.target.checked) unlocked = false;
      App.notify(e.target.checked ? 'Blind coding on — coders don\'t see each other\'s codes' : 'Blind coding off', 'info');
      render(tab);
    };
    container.querySelector('#hc-coderfile').onclick = coderFileDialog;
    const body = container.querySelector('#hc-body');
    if (tab === 'coder1' || tab === 'coder2') renderCoder(body, tab);
    else if (tab === 'ai') renderAI(body);
    else renderReliability(body);
  }

  /* ══ Coder tabs ══════════════════════════ */
  function filteredFor(k) {
    const { posts, codebook } = App.getState();
    const f = view[k].filter;
    return posts.filter(p => f === 'all' || statusOf(p, k, codebook) === f);
  }
  function renderCoder(body, k) {
    const { posts, codebook } = App.getState();
    const c = cfg();
    const list = filteredFor(k);
    const v = view[k];
    if (v.idx >= list.length) v.idx = Math.max(0, list.length - 1);
    const other = k === 'coder1' ? 'coder2' : 'coder1';
    body.innerHTML =
      '<div class="hc-coderbar">' +
        '<label class="hc-coder-id"><span class="hc-coder-badge hc-' + k + '">' + (k === 'coder1' ? 'Coder 1' : 'Coder 2') + '</span><input class="form-input" id="hc-name" placeholder="Name or initials" value="' + esc(c.coders[k].name) + '" aria-label="' + (k === 'coder1' ? 'Coder 1' : 'Coder 2') + ' name"></label>' +
        '<div class="hc-progress" id="hc-progress">' + progressHTML(k) + '</div>' +
        '<div class="hc-coder-tools"><select class="form-select" id="hc-filter" aria-label="Show posts">' + [['all', 'All posts'], ['none', 'Not started'], ['partial', 'In progress'], ['done', 'Coded']].map(([x, l]) => '<option value="' + x + '"' + (v.filter === x ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
          '<label class="hc-switch"><input type="checkbox" id="hc-showai"' + (c.showAI ? ' checked' : '') + '> Show AI suggestions</label>' +
          '<button class="btn btn-ghost btn-sm" id="hc-clear">Clear ' + (k === 'coder1' ? 'Coder 1' : 'Coder 2') + '\'s codes</button></div>' +
      '</div>' +
      (c.blind ? '<div class="hc-blind-note">Blind coding: ' + esc(coderLabel(other)) + '\'s decisions are hidden here' + (c.showAI ? '' : ', and so are the AI\'s') + '. Compare them in Reliability Analysis once both coders are done.</div>' : '') +
      (list.length ? '<div class="hc-layout"><div><div class="card hc-listcard"><div class="hc-listhead"><b>' + list.length + ' post' + (list.length === 1 ? '' : 's') + '</b><div class="hc-nav"><button class="btn btn-ghost btn-sm" data-nav="-1">← Prev</button><span id="hc-counter">' + (v.idx + 1) + ' / ' + list.length + '</span><button class="btn btn-ghost btn-sm" data-nav="1">Next →</button></div></div>' +
          '<div class="hc-list" id="hc-list" role="listbox" aria-label="Posts">' + list.map((p, i) => listItem(p, i, k, codebook)).join('') + '</div></div>' +
          '<div id="post-display"></div></div><div><div class="coding-panel" id="coding-panel"></div></div></div>'
        : '<div class="card"><div class="empty-state"><div class="empty-sub">No posts match this filter.</div></div></div>');
    body.querySelector('#hc-name').onchange = e => { const cs = cfg().coders; cs[k] = { name: e.target.value.trim().slice(0, 80) }; setCfg({ coders: cs }); };
    body.querySelector('#hc-filter').onchange = e => { v.filter = e.target.value; v.idx = 0; renderCoder(body, k); };
    body.querySelector('#hc-showai').onchange = e => { setCfg({ showAI: e.target.checked }); renderCoder(body, k); };
    body.querySelector('#hc-clear').onclick = () => {
      if (!confirm('Clear all of ' + coderLabel(k) + '\'s codes and notes? The other coder, the AI and adjudications are not affected.')) return;
      const posts2 = App.getState().posts.map(p => { const n = Object.assign({}, p, { [FIELD[k]]: {} }); n.coderNotes = Object.assign({}, p.coderNotes || {}); delete n.coderNotes[k]; return n; });
      App.setState({ posts: posts2 });
      App.notify(coderLabel(k) + '\'s codes cleared', 'warning');
      render(k);
    };
    if (!list.length) return;
    body.querySelector('#hc-list').onclick = e => { const it = e.target.closest('[data-i]'); if (it) jump(k, Number(it.dataset.i)); };
    body.querySelectorAll('[data-nav]').forEach(b => { b.onclick = () => jump(k, v.idx + Number(b.dataset.nav)); });
    drawPost(k);
    keyHandler = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); jump(k, v.idx + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); jump(k, v.idx - 1); }
    };
    document.addEventListener('keydown', keyHandler);
  }
  function progressHTML(k) {
    const { posts, codebook } = App.getState();
    const done = posts.filter(p => statusOf(p, k, codebook) === 'done').length;
    const partial = posts.filter(p => statusOf(p, k, codebook) === 'partial').length;
    const pct = posts.length ? Math.round(done / posts.length * 100) : 0;
    return '<div class="hc-progress-top"><span><b>' + done + '</b> of ' + posts.length + ' coded' + (partial ? ' · ' + partial + ' in progress' : '') + '</span><span>' + pct + '%</span></div><div class="progress-wrap"><div class="progress-bar" style="width:' + pct + '%;background:' + (k === 'coder1' ? 'var(--teal)' : '#0369A1') + '"></div></div>';
  }
  function listItem(p, i, k, codebook) {
    const st = statusOf(p, k, codebook);
    const badge = st === 'done' ? '<span class="badge badge-teal">✓</span>' : st === 'partial' ? '<span class="badge badge-amber">' + codebook.filter(d => codesOf(p, k)[d.id]).length + '/' + codebook.length + '</span>' : '<span class="badge badge-gray">—</span>';
    return '<div class="post-list-item' + (i === view[k].idx ? ' active' : '') + '" role="option" aria-selected="' + (i === view[k].idx) + '" data-i="' + i + '" id="pli-' + i + '"><span class="pli-id">' + (i + 1) + '</span><span class="pli-text">' + esc(p.text) + '</span><span class="pli-status">' + badge + '</span></div>';
  }
  function jump(k, i) {
    const list = filteredFor(k);
    if (!list.length) return;
    if (i >= list.length) { App.notify('You\'ve reached the last post in this view', 'info'); i = list.length - 1; }
    view[k].idx = Math.max(0, i);
    document.querySelectorAll('#hc-list .post-list-item').forEach(el => { const on = Number(el.dataset.i) === view[k].idx; el.classList.toggle('active', on); el.setAttribute('aria-selected', String(on)); });
    const pli = document.getElementById('pli-' + view[k].idx);
    if (pli) pli.scrollIntoView({ block: 'nearest' });
    const ctr = document.getElementById('hc-counter');
    if (ctr) ctr.textContent = (view[k].idx + 1) + ' / ' + list.length;
    drawPost(k);
  }
  function engagementRow(post) {
    const e = post.engagement;
    if (!e) return '';
    const items = [['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['views', 'Views']].filter(([key]) => e[key] !== undefined && e[key] !== null && e[key] !== '').map(([key, l]) => '<span class="eng-item">' + l + ' ' + esc(e[key]) + '</span>');
    return items.length ? '<div class="post-engagement">' + items.join('') + '</div>' : '';
  }
  function drawPost(k) {
    const list = filteredFor(k);
    const post = list[view[k].idx];
    const disp = document.getElementById('post-display'), panel = document.getElementById('coding-panel');
    if (!post || !disp || !panel) return;
    const { codebook } = App.getState();
    const c = cfg();
    const mine = codesOf(post, k);
    disp.innerHTML = '<div class="post-card"><div class="post-meta">' + (post.author ? '<span class="post-author">@' + esc(post.author) + '</span>' : '') + (post.timestamp ? '<span class="post-time">' + esc(post.timestamp) + '</span>' : '') +
      '<span class="badge badge-gray" style="margin-left:auto;font-size:11px">#' + (view[k].idx + 1) + '</span></div><div class="post-text">' + esc(post.text) + '</div>' + engagementRow(post) + '</div>';
    panel.innerHTML = '<div class="cp-head"><span>' + esc(coderLabel(k)) + '</span><label class="hc-switch hc-switch-sm"><input type="checkbox" id="auto-advance"' + (view.autoAdvance ? ' checked' : '') + '> Auto-advance</label></div>' +
      '<div class="cp-body">' + codebook.map(dim => '<div class="cp-dim" role="radiogroup" aria-label="' + esc(dim.name) + '"><div class="cp-dim-label">' + esc(dim.name) + '</div>' + (dim.description ? '<div class="cp-dim-desc">' + esc(dim.description) + '</div>' : '') +
        '<div class="cp-codes">' + dim.codes.map(code => '<button type="button" class="cp-code-btn' + (mine[dim.id] === code.id ? ' selected' : '') + '" role="radio" aria-checked="' + (mine[dim.id] === code.id) + '" data-dim="' + esc(dim.id) + '" data-code="' + esc(code.id) + '" title="' + esc(code.description || code.label) + '">' + esc(code.label) +
          (code.description ? '<span class="cp-code-desc">' + esc(code.description.slice(0, 70)) + (code.description.length > 70 ? '…' : '') + '</span>' : '') + '</button>').join('') + '</div>' +
        (c.showAI ? aiHint(post, dim) : '') + '</div>').join('') +
        '<div class="cp-dim"><label class="cp-dim-label" for="hc-memo">Memo</label><textarea class="form-textarea hc-memo" id="hc-memo" rows="3" placeholder="Notes on this post (only you see them while coding)">' + esc((post.coderNotes || {})[k] || '') + '</textarea></div></div>' +
      '<div class="cp-foot"><button class="btn btn-secondary" style="flex:1" data-nav2="-1">← Prev</button><button class="btn btn-teal" style="flex:1" id="hc-next">Save &amp; Next →</button></div>';
    panel.onclick = e => {
      const b = e.target.closest('.cp-code-btn');
      if (b) { selectCode(k, post.id, b.dataset.dim, b.dataset.code); return; }
      const ad = e.target.closest('[data-adopt]');
      if (ad) { const a = aiOf(post, ad.dataset.adopt); if (a) { selectCode(k, post.id, ad.dataset.adopt, a.code); App.notify('Adopted the AI suggestion', 'info'); } return; }
      const n = e.target.closest('[data-nav2]');
      if (n) jump(k, view[k].idx - 1);
    };
    panel.querySelector('#auto-advance').onchange = e => { view.autoAdvance = e.target.checked; };
    panel.querySelector('#hc-memo').onchange = e => { const note = e.target.value.slice(0, 5000); updatePost(post.id, p => { p.coderNotes = Object.assign({}, p.coderNotes || {}, { [k]: note }); return p; }); };
    panel.querySelector('#hc-next').onclick = () => {
      const p = App.getState().posts.find(x => x.id === post.id);
      const n = codebook.filter(d => codesOf(p, k)[d.id]).length;
      if (!n) { App.notify('Assign at least one code before moving on', 'warning'); return; }
      App.notify('Saved ' + n + ' code' + (n === 1 ? '' : 's') + ' for post ' + (view[k].idx + 1), 'success');
      jump(k, view[k].idx + 1);
    };
  }
  function aiHint(post, dim) {
    const a = aiOf(post, dim.id);
    if (!a) return '<div class="cp-ai-hint is-none">AI: unavailable for this post</div>';
    return '<div class="cp-ai-hint">AI suggests: <strong>' + esc(codeLabel(dim, a.code)) + '</strong>' + (a.confidence != null ? ' <span class="text-muted">(' + Math.round(a.confidence * 100) + '%)</span>' : '') + ' <button type="button" class="hc-link" data-adopt="' + esc(dim.id) + '">Adopt</button></div>';
  }
  function selectCode(k, postId, dimId, codeId) {
    const updated = updatePost(postId, p => { p[FIELD[k]] = Object.assign({}, codesOf(p, k), { [dimId]: codeId }); return p; });
    document.querySelectorAll('.cp-code-btn[data-dim="' + CSS.escape(dimId) + '"]').forEach(b => { const on = b.dataset.code === codeId; b.classList.toggle('selected', on); b.setAttribute('aria-checked', String(on)); });
    const { codebook } = App.getState();
    const li = document.getElementById('pli-' + view[k].idx);
    if (li) { const st = statusOf(updated, k, codebook); li.querySelector('.pli-status').innerHTML = st === 'done' ? '<span class="badge badge-teal">✓</span>' : '<span class="badge badge-amber">' + codebook.filter(d => codesOf(updated, k)[d.id]).length + '/' + codebook.length + '</span>'; }
    const prog = document.getElementById('hc-progress');
    if (prog) prog.innerHTML = progressHTML(k);
    const tabN = document.querySelector('.hc-tab[data-tab="' + k + '"] .hc-tab-n');
    if (tabN) tabN.textContent = App.getState().posts.filter(p => statusOf(p, k, codebook) !== 'none').length;
    if (view.autoAdvance && codebook.every(d => codesOf(updated, k)[d.id])) setTimeout(() => jump(k, view[k].idx + 1), 250);
  }

  /* ══ AI Coder tab ════════════════════════ */
  function renderAI(body) {
    const { posts, codebook } = App.getState();
    const f = view.ai.filter;
    const aiPosts = posts.filter(p => Object.keys(p.aiCodes || {}).length);
    const confs = posts.flatMap(p => codebook.map(d => aiOf(p, d.id)).filter(Boolean).map(a => a.confidence)).filter(x => typeof x === 'number');
    const low = posts.filter(p => codebook.some(d => { const a = aiOf(p, d.id); return a && typeof a.confidence === 'number' && a.confidence < 0.6; }));
    const list = posts.filter(p => f === 'all' || (f === 'coded' ? Object.keys(p.aiCodes || {}).length : f === 'missing' ? !Object.keys(p.aiCodes || {}).length : low.includes(p)));
    body.innerHTML = '<div class="hc-ai">' +
      '<div class="hc-stats">' + [[aiPosts.length + ' / ' + posts.length, 'Posts coded by AI'], [confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length * 100) + '%' : '—', 'Average confidence'], [low.length, 'Posts with a code under 60% confidence']].map(([v, l]) => '<div><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>').join('') + '</div>' +
      '<div class="hc-ai-bar"><select class="form-select" id="hc-ai-filter" aria-label="Show posts">' + [['all', 'All posts'], ['coded', 'Coded by AI'], ['missing', 'Not coded by AI'], ['low', 'Low confidence']].map(([x, l]) => '<option value="' + x + '"' + (f === x ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
        '<span class="text-muted">AI results are kept separate from human coding and never overwrite it. Run or redo them on the AI Coding page.</span><button class="btn btn-violet btn-sm" onclick="App.navigate(\'ai-coding\')">Open AI Coding</button></div>' +
      '<div class="table-wrap card hc-ai-table"><table class="table"><thead><tr><th>Post</th>' + codebook.map(d => '<th>' + esc(d.name) + '</th>').join('') + '</tr></thead><tbody>' +
        list.slice(0, 300).map(p => '<tr><td class="hc-ai-post">' + esc(String(p.text).slice(0, 180)) + (String(p.text).length > 180 ? '…' : '') + '</td>' + codebook.map(d => {
          const a = aiOf(p, d.id);
          if (!a) return '<td><span class="text-muted hc-unavail">Unavailable</span></td>';
          return '<td><span class="code-chip ai">' + esc(codeLabel(d, a.code)) + '</span>' + (a.confidence != null ? '<div class="hc-conf"><span style="width:' + Math.round(a.confidence * 100) + '%"></span></div><span class="hc-conf-n">' + Math.round(a.confidence * 100) + '%</span>' : '') +
            (a.reasoning ? '<details class="hc-why"><summary>Why</summary>' + esc(a.reasoning) + '</details>' : '') + '</td>';
        }).join('') + '</tr>').join('') + '</tbody></table>' + (list.length > 300 ? '<p class="text-muted" style="padding:10px 14px;font-size:12.5px">Showing the first 300 of ' + list.length + '.</p>' : '') + (!list.length ? '<p class="text-muted" style="padding:14px">No posts match.</p>' : '') + '</div></div>';
    body.querySelector('#hc-ai-filter').onchange = e => { view.ai.filter = e.target.value; renderAI(body); };
  }

  /* ══ Reliability ═════════════════════════ */
  const PAIRS = { c1c2: ['coder1', 'coder2'], c1ai: ['coder1', 'ai'], c2ai: ['coder2', 'ai'] };
  const srcLabel = s => (s === 'ai' ? 'AI' : coderLabel(s));
  const fmt = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d === undefined ? 3 : d));
  const pctf = v => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');
  // Colours follow Krippendorff's guidance: ≥ .800 reliable, ≥ .667 tentative conclusions only.
  const ratingClass = v => (v === null || v === undefined ? 'na' : v >= 0.8 - 1e-9 ? 'good' : v >= 2 / 3 - 1e-9 ? 'fair' : 'poor');
  const measureOf = dim => (cfg().measures[dim.id] === 'ordinal' ? 'ordinal' : 'nominal');

  // Everything the Reliability tab shows, from the stored codes.
  function compute(pairKey) {
    const { posts, codebook } = App.getState();
    const [A, B] = PAIRS[pairKey];
    const dims = codebook.map(dim => {
      const pairs = posts.map(p => ({ a: valueOf(p, A, dim.id), b: valueOf(p, B, dim.id), post: p }));
      const both = pairs.filter(x => x.a && x.b);
      const cats = dim.codes.map(c => c.id);
      const level = measureOf(dim);
      const units = posts.map(p => [valueOf(p, A, dim.id), valueOf(p, B, dim.id)]);
      const allThree = posts.map(p => [valueOf(p, 'coder1', dim.id), valueOf(p, 'coder2', dim.id), valueOf(p, 'ai', dim.id)]);
      return {
        dim, level, n: both.length, codedA: pairs.filter(x => x.a).length, codedB: pairs.filter(x => x.b).length,
        pa: S.percentAgreement(pairs), kappa: S.cohenKappa(pairs, cats),
        wLinear: level === 'ordinal' ? S.weightedKappa(pairs, cats, 'linear') : null, wQuad: level === 'ordinal' ? S.weightedKappa(pairs, cats, 'quadratic') : null,
        alpha: S.krippendorffAlpha(units, level, cats), alpha3: S.krippendorffAlpha(allThree, level, cats),
        confusion: S.confusion(pairs, cats), byCode: dim.codes.map(code => Object.assign({ code }, S.binaryAgreement(pairs, code.id))),
        disagreements: both.filter(x => x.a !== x.b)
      };
    });
    const decisions = dims.reduce((s, d) => s + d.n, 0);
    const agreeing = dims.reduce((s, d) => s + (d.pa.agree || 0), 0);
    const kappas = dims.map(d => d.kappa.value).filter(v => v !== null);
    const unitsBoth = posts.filter(p => codebook.some(d => valueOf(p, A, d.id) && valueOf(p, B, d.id))).length;
    const disagreeUnits = posts.filter(p => codebook.some(d => { const a = valueOf(p, A, d.id), b = valueOf(p, B, d.id); return a && b && a !== b; }));
    const resolved = disagreeUnits.filter(p => codebook.every(d => { const a = valueOf(p, A, d.id), b = valueOf(p, B, d.id); return !(a && b && a !== b) || (p.adjudicated && p.adjudicated[d.id] && p.adjudicated[d.id].code); }));
    return { A, B, dims, decisions, overall: decisions ? agreeing / decisions : null, meanKappa: kappas.length ? kappas.reduce((a, b) => a + b, 0) / kappas.length : null, kappaCount: kappas.length,
      units: posts.length, unitsBoth, disagreeUnits, resolved: resolved.length,
      codedA: posts.filter(p => codebook.some(d => valueOf(p, A, d.id))).length, codedB: posts.filter(p => codebook.some(d => valueOf(p, B, d.id))).length };
  }

  function renderReliability(body) {
    const { posts, codebook } = App.getState();
    const c = cfg();
    if (!rel.dim || !codebook.some(d => d.id === rel.dim)) rel.dim = codebook[0].id;
    const cov = k => posts.filter(p => statusOf(p, k, codebook) !== 'none').length;
    if (c.blind && !unlocked) {
      body.innerHTML = '<div class="card hc-gate"><div class="hc-gate-h">Comparisons are hidden while coders work</div>' +
        '<p>Blind coding is on, so neither coder sees the other\'s decisions. Reveal the comparison when both coders have finished their independent coding — after that, coders who use this browser could see each other\'s codes here.</p>' +
        '<div class="hc-stats">' + [[cov('coder1') + ' / ' + posts.length, coderLabel('coder1') + ' coded'], [cov('coder2') + ' / ' + posts.length, coderLabel('coder2') + ' coded'], [posts.filter(p => Object.keys(p.aiCodes || {}).length).length + ' / ' + posts.length, 'AI coded']].map(([v, l]) => '<div><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>').join('') + '</div>' +
        '<button class="btn btn-primary" id="hc-unlock">Both coders are done — show the comparison</button></div>';
      body.querySelector('#hc-unlock').onclick = () => { unlocked = true; renderReliability(body); };
      return;
    }
    const r = compute(rel.pair);
    const sel = r.dims.find(d => d.dim.id === rel.dim) || r.dims[0];
    const A = srcLabel(r.A), B = srcLabel(r.B);
    body.innerHTML = '<div class="hc-rel">' +
      '<div class="hc-rel-top"><div class="ss-seg-like" role="radiogroup" aria-label="Compare">' + [['c1c2', 'Coder 1 vs Coder 2'], ['c1ai', 'Coder 1 vs AI'], ['c2ai', 'Coder 2 vs AI']].map(([k, l]) => '<button type="button" role="radio" aria-checked="' + (rel.pair === k) + '" class="hc-seg' + (rel.pair === k ? ' is-on' : '') + '" data-pair="' + k + '">' + l + '</button>').join('') + '</div>' +
        '<div class="hc-rel-actions"><button class="btn btn-secondary btn-sm" id="hc-report">Download report (CSV)</button><button class="btn btn-secondary btn-sm" id="hc-final">Download final codes (CSV)</button></div></div>' +
      '<div class="hc-stats hc-stats-5">' + [
        [r.units, 'Posts'], [r.codedA, A + ' coded'], [r.codedB, B + ' coded'], [r.unitsBoth, 'Coded by both'], [r.units - r.unitsBoth, 'Missing one or both']
      ].map(([v, l]) => '<div><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>').join('') + '</div>' +
      '<div class="rel-header-cards">' +
        '<div class="rel-metric"><div class="rel-metric-val ' + ratingClass(r.overall) + '">' + pctf(r.overall) + '</div><div class="rel-metric-name">Overall agreement</div><div class="rel-metric-desc">' + r.decisions + ' coding decisions both made (post × dimension)</div></div>' +
        '<div class="rel-metric"><div class="rel-metric-val ' + ratingClass(r.meanKappa) + '">' + fmt(r.meanKappa) + '</div><div class="rel-metric-name">Mean Cohen\'s κ</div><div class="rel-metric-desc">' + (r.kappaCount ? 'Average over ' + r.kappaCount + ' dimension' + (r.kappaCount === 1 ? '' : 's') + ' where κ is defined · ' + S.interpret(r.meanKappa) : 'Not defined for any dimension yet') + '</div></div>' +
        '<div class="rel-metric"><div class="rel-metric-val ' + (r.disagreeUnits.length ? 'fair' : 'good') + '">' + r.disagreeUnits.length + '</div><div class="rel-metric-name">Posts with disagreements</div><div class="rel-metric-desc">' + r.resolved + ' resolved by adjudication</div></div>' +
      '</div>' +
      '<div class="card hc-card"><div class="card-title">By dimension</div><div class="table-wrap"><table class="table hc-dimtable"><thead><tr><th>Dimension</th><th>Measure</th><th>N</th><th>Agreement</th><th>Cohen\'s κ</th><th>Weighted κ <small>lin. / quad.</small></th><th>Krippendorff\'s α</th><th>α (all three)</th><th>Interpretation</th><th></th></tr></thead><tbody>' +
        r.dims.map(d => '<tr' + (d.dim.id === rel.dim ? ' class="is-on"' : '') + '><td><b>' + esc(d.dim.name) + '</b></td>' +
          '<td><select class="form-select hc-measure" data-measure="' + esc(d.dim.id) + '" aria-label="Measurement level of ' + esc(d.dim.name) + '"><option value="nominal"' + (d.level === 'nominal' ? ' selected' : '') + '>Nominal</option><option value="ordinal"' + (d.level === 'ordinal' ? ' selected' : '') + ' title="Codes are in order (codebook order)">Ordinal</option></select></td>' +
          '<td>' + d.n + '</td><td>' + pctf(d.pa.value) + '</td>' +
          '<td>' + stat(d.kappa) + '</td><td>' + (d.level === 'ordinal' ? stat(d.wLinear) + ' / ' + stat(d.wQuad) : '<span class="text-muted" title="Weighted κ needs ordered codes — set the measure to Ordinal">nominal</span>') + '</td>' +
          '<td>' + stat(d.alpha) + '</td><td>' + stat(d.alpha3) + '</td><td>' + (d.kappa.value === null ? '<span class="text-muted">n/a</span>' : '<span class="badge badge-gray" title="Landis & Koch label for κ">' + S.interpret(d.kappa.value) + '</span>') + '</td>' +
          '<td><button class="btn btn-ghost btn-sm" data-seldim="' + esc(d.dim.id) + '" aria-label="Details for ' + esc(d.dim.name) + '">Details</button></td></tr>').join('') +
      '</tbody></table></div><p class="hc-method">Colours: green ≥ .800, amber ≥ .667 (Krippendorff\'s thresholds for reliable / tentative conclusions), red below. Units are posts. Each statistic for a dimension uses the posts that both ' + esc(A) + ' and ' + esc(B) + ' coded on it (N); posts missing either code are left out. Cohen\'s κ treats codes as unordered categories; weighted κ (for dimensions you mark Ordinal) gives partial credit for nearby codes in codebook order. Krippendorff\'s α uses every post with at least two codes; “all three” adds the other human coder or the AI. A dash means the statistic isn\'t defined — hover it to see why. Interpretation labels follow Landis & Koch (1977).</p></div>' +
      (sel ? dimDetail(sel, A, B) : '') +
      disagreementsHTML(r) +
    '</div>';
    body.querySelector('.ss-seg-like').onclick = e => { const b = e.target.closest('[data-pair]'); if (b) { rel.pair = b.dataset.pair; rel.open = null; renderReliability(body); } };
    body.onchange = e => {
      const m = e.target.closest('[data-measure]');
      if (m) { const ms = Object.assign({}, cfg().measures, { [m.dataset.measure]: m.value }); setCfg({ measures: ms }); renderReliability(body); return; }
      if (e.target.id === 'hc-dis-filter') { rel.disFilter = e.target.value; renderReliability(body); }
      if (e.target.id === 'hc-dis-dim') { rel.disDim = e.target.value; renderReliability(body); }
    };
    // Keep the adjudicator's name as it's typed, so opening a post (which redraws) doesn't lose it
    body.oninput = e => { if (e.target.id === 'hc-adjudicator') setCfg({ adjudicator: e.target.value.trim().slice(0, 80) }); };
    body.onclick = e => {
      const sd = e.target.closest('[data-seldim]'); if (sd) { rel.dim = sd.dataset.seldim; renderReliability(body); const el = document.getElementById('hc-dimdetail'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      const op = e.target.closest('[data-open]'); if (op) { rel.open = rel.open === op.dataset.open ? null : op.dataset.open; renderReliability(body); const el = document.getElementById('hc-adj-' + rel.open); if (el) el.scrollIntoView({ block: 'nearest' }); return; }
      const pick = e.target.closest('[data-pick]');
      if (pick) { const sel2 = document.getElementById('hc-adj-sel-' + pick.dataset.dim); if (sel2) { sel2.value = pick.dataset.pick; sel2.dataset.basis = pick.dataset.basis; } return; }
      const save = e.target.closest('[data-adjsave]'); if (save) { saveAdjudication(save.dataset.adjsave); renderReliability(body); return; }
      const undo = e.target.closest('[data-adjundo]'); if (undo) { const [pid, did] = JSON.parse(undo.dataset.adjundo); updatePost(pid, p => { const a = Object.assign({}, p.adjudicated || {}); delete a[did]; p.adjudicated = a; return p; }); App.notify('Adjudication removed — the coders\' codes are unchanged', 'info'); renderReliability(body); }
    };
    body.querySelector('#hc-report').onclick = () => exportReport(r);
    body.querySelector('#hc-final').onclick = exportFinal;
  }
  function stat(s) {
    if (!s) return '—';
    if (s.value === null) return '<span class="text-muted" title="' + esc(s.reason || 'Not defined') + '">—</span>';
    return '<span class="hc-stat ' + ratingClass(s.value) + '">' + s.value.toFixed(3) + '</span>';
  }
  function dimDetail(d, A, B) {
    const cats = d.confusion.categories;
    const label = id => codeLabel(d.dim, id);
    const max = Math.max(1, ...d.confusion.matrix.flat());
    const patterns = {};
    d.disagreements.forEach(x => { const k = x.a + '→' + x.b; patterns[k] = patterns[k] || { a: x.a, b: x.b, n: 0 }; patterns[k].n++; });
    const top = Object.values(patterns).sort((x, y) => y.n - x.n).slice(0, 6);
    return '<div class="card hc-card" id="hc-dimdetail"><div class="card-title">' + esc(d.dim.name) + ' — ' + d.n + ' post' + (d.n === 1 ? '' : 's') + ' coded by both</div>' +
      '<div class="hc-detail-grid"><div><div class="hc-sub">Confusion matrix <small>rows: ' + esc(A) + ' · columns: ' + esc(B) + '</small></div><div class="table-wrap"><table class="conf-matrix"><thead><tr><th></th>' + cats.map(c => '<th class="col-label">' + esc(label(c)) + '</th>').join('') + '<th>Total</th></tr></thead><tbody>' +
        cats.map((c, i) => '<tr><td class="row-label">' + esc(label(c)) + '</td>' + cats.map((c2, j) => { const v = d.confusion.matrix[i][j]; const bg = i === j ? 'rgba(13,148,136,' + (0.1 + v / max * 0.5) + ')' : (v ? 'rgba(239,68,68,' + (0.08 + v / max * 0.4) + ')' : 'transparent'); return '<td style="background:' + bg + '">' + (v || '·') + '</td>'; }).join('') + '<td><b>' + d.confusion.matrix[i].reduce((a, b) => a + b, 0) + '</b></td></tr>').join('') +
        '<tr><th>Total</th>' + cats.map((c, j) => '<td><b>' + d.confusion.matrix.reduce((s, row) => s + row[j], 0) + '</b></td>').join('') + '<td><b>' + d.confusion.n + '</b></td></tr></tbody></table></div></div>' +
      '<div><div class="hc-sub">Where they disagree</div>' + (top.length ? '<ul class="hc-patterns">' + top.map(t => '<li><span>' + esc(A) + ': <b>' + esc(label(t.a)) + '</b> · ' + esc(B) + ': <b>' + esc(label(t.b)) + '</b></span><span class="badge badge-red">' + t.n + '</span></li>').join('') + '</ul>' : '<p class="text-muted">No disagreements on this dimension.</p>') + '</div></div>' +
      '<div class="hc-sub" style="margin-top:14px">Code by code <small>did each source assign this code? (binary agreement on the same posts)</small></div><div class="table-wrap"><table class="table hc-codetable"><thead><tr><th>Code</th><th>Both</th><th>' + esc(A) + ' only</th><th>' + esc(B) + ' only</th><th>Neither</th><th>Agreement</th><th>κ</th><th>Specific agreement</th></tr></thead><tbody>' +
        d.byCode.map(x => '<tr><td>' + esc(x.code.label) + '</td><td>' + x.a + '</td><td>' + x.b + '</td><td>' + x.c + '</td><td>' + x.d + '</td><td>' + pctf(x.po) + '</td><td>' + (x.kappa === null ? '<span class="text-muted" title="' + esc(x.kappaReason || '') + '">—</span>' : x.kappa.toFixed(3)) + '</td><td>' + pctf(x.positive) + '</td></tr>').join('') +
      '</tbody></table></div><p class="hc-method">Specific (positive) agreement = 2 × both ÷ (2 × both + ' + esc(A) + ' only + ' + esc(B) + ' only): how often a code one source used was also used by the other.</p></div>';
  }
  function disagreementsHTML(r) {
    const { codebook } = App.getState();
    const c = cfg();
    const A = srcLabel(r.A), B = srcLabel(r.B);
    const isResolved = p => codebook.every(d => { const a = valueOf(p, r.A, d.id), b = valueOf(p, r.B, d.id); return !(a && b && a !== b) || (p.adjudicated && p.adjudicated[d.id] && p.adjudicated[d.id].code); });
    const items = r.disagreeUnits.filter(p => (rel.disFilter === 'all' || (rel.disFilter === 'resolved') === isResolved(p)) &&
      (rel.disDim === 'all' || (valueOf(p, r.A, rel.disDim) && valueOf(p, r.B, rel.disDim) && valueOf(p, r.A, rel.disDim) !== valueOf(p, r.B, rel.disDim))));
    return '<div class="card hc-card" id="hc-dis"><div class="hc-dis-head"><div class="card-title" style="margin:0">Disagreements &amp; adjudication</div>' +
      '<div class="hc-dis-filters"><select class="form-select" id="hc-dis-filter" aria-label="Status">' + [['unresolved', 'Unresolved'], ['resolved', 'Resolved'], ['all', 'All']].map(([v, l]) => '<option value="' + v + '"' + (rel.disFilter === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
        '<select class="form-select" id="hc-dis-dim" aria-label="Dimension"><option value="all">All dimensions</option>' + codebook.map(d => '<option value="' + esc(d.id) + '"' + (rel.disDim === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('') + '</select>' +
        '<label class="hc-adjname">Adjudicator <input class="form-input" id="hc-adjudicator" value="' + esc(c.adjudicator) + '" placeholder="Your name"></label></div></div>' +
      '<p class="hc-method">Posts where ' + esc(A) + ' and ' + esc(B) + ' chose different codes. Open one to read it, see both decisions, their memos and the AI\'s code, and record the final research code. Final codes are stored separately — the original codes don\'t change.</p>' +
      (items.length ? '<ul class="hc-dislist">' + items.slice(0, 200).map(p => disItem(p, r, isResolved(p))).join('') + '</ul>' + (items.length > 200 ? '<p class="text-muted">Showing 200 of ' + items.length + '.</p>' : '') : '<p class="text-muted" style="padding:6px 0">' + (r.disagreeUnits.length ? 'Nothing matches these filters.' : 'No disagreements between ' + esc(A) + ' and ' + esc(B) + ' yet.') + '</p>') +
      '</div>';
  }
  function disItem(p, r, resolved) {
    const { codebook } = App.getState();
    const key = String(App.getState().posts.indexOf(p));
    const dis = codebook.filter(d => { const a = valueOf(p, r.A, d.id), b = valueOf(p, r.B, d.id); return a && b && a !== b; });
    const open = rel.open === key;
    const A = srcLabel(r.A), B = srcLabel(r.B);
    let html = '<li class="hc-dis' + (open ? ' is-open' : '') + '" id="hc-adj-' + key + '"><button type="button" class="hc-dis-row" data-open="' + key + '" aria-expanded="' + open + '"><span class="hc-dis-text">' + esc(String(p.text).slice(0, 140)) + (String(p.text).length > 140 ? '…' : '') + '</span>' +
      '<span class="hc-dis-dims">' + dis.map(d => esc(d.name)).join(', ') + '</span>' + (resolved ? '<span class="badge badge-green">Resolved</span>' : '<span class="badge badge-amber">Unresolved</span>') + '</button>';
    if (open) {
      const notes = p.coderNotes || {};
      html += '<div class="hc-adj"><div class="post-text hc-adj-text">' + esc(p.text) + '</div>' +
        (r.A !== 'ai' && notes[r.A] ? '<div class="hc-memo-view"><b>' + esc(A) + '\'s memo:</b> ' + esc(notes[r.A]) + '</div>' : '') + (r.B !== 'ai' && notes[r.B] ? '<div class="hc-memo-view"><b>' + esc(B) + '\'s memo:</b> ' + esc(notes[r.B]) + '</div>' : '') +
        dis.map(d => {
          const a = valueOf(p, r.A, d.id), b = valueOf(p, r.B, d.id), ai = aiOf(p, d.id);
          const adj = p.adjudicated && p.adjudicated[d.id];
          const choice = (basis, code, label) => '<button type="button" class="hc-pick" data-dim="' + esc(d.id) + '" data-pick="' + esc(code) + '" data-basis="' + basis + '">' + esc(label) + ': <b>' + esc(codeLabel(d, code)) + '</b></button>';
          return '<div class="hc-adj-dim"><div class="hc-adj-dimname">' + esc(d.name) + '</div><div class="hc-adj-opts">' +
            choice(r.A, a, A) + choice(r.B, b, B) + (r.A !== 'ai' && r.B !== 'ai' ? (ai ? choice('ai', ai.code, 'AI' + (ai.confidence != null ? ' (' + Math.round(ai.confidence * 100) + '%)' : '')) : '<span class="hc-unavail">AI: unavailable</span>') : '') + '</div>' +
            (ai && ai.reasoning && (r.A !== 'ai' && r.B !== 'ai') ? '<details class="hc-why"><summary>AI\'s reason</summary>' + esc(ai.reasoning) + '</details>' : '') +
            '<div class="hc-adj-row"><label>Final code <select class="form-select" id="hc-adj-sel-' + esc(d.id) + '" data-basis="' + (adj ? esc(adj.basis) : '') + '"><option value="">— choose —</option>' + d.codes.map(cd => '<option value="' + esc(cd.id) + '"' + (adj && adj.code === cd.id ? ' selected' : '') + '>' + esc(cd.label) + '</option>').join('') + '</select></label>' +
            '<input class="form-input" id="hc-adj-note-' + esc(d.id) + '" placeholder="Reason (optional)" value="' + esc(adj ? adj.note : '') + '">' +
            '<button type="button" class="btn btn-primary btn-sm" data-adjsave="' + esc(JSON.stringify([p.id, d.id])) + '">Save final code</button>' +
            (adj ? '<button type="button" class="btn btn-ghost btn-sm" data-adjundo="' + esc(JSON.stringify([p.id, d.id])) + '">Remove</button><span class="hc-adj-done">Final: <b>' + esc(codeLabel(d, adj.code)) + '</b>' + (adj.by ? ' · by ' + esc(adj.by) : '') + ' · ' + esc(new Date(adj.at).toLocaleString()) + '</span>' : '') + '</div></div>';
        }).join('') + '</div>';
    }
    return html + '</li>';
  }
  function saveAdjudication(raw) {
    const [pid, did] = JSON.parse(raw);
    const sel = document.getElementById('hc-adj-sel-' + did);
    const note = document.getElementById('hc-adj-note-' + did);
    if (!sel || !sel.value) { App.notify('Choose the final code first', 'warning'); return; }
    const by = (document.getElementById('hc-adjudicator') || {}).value || cfg().adjudicator || '';
    if (by !== cfg().adjudicator) setCfg({ adjudicator: by.trim().slice(0, 80) });
    const post = App.getState().posts.find(p => p.id === pid);
    const basis = sel.dataset.basis && ['coder1', 'coder2', 'ai'].includes(sel.dataset.basis) && valueOf(post, sel.dataset.basis, did) === sel.value ? sel.dataset.basis : 'other';
    updatePost(pid, p => { p.adjudicated = Object.assign({}, p.adjudicated || {}, { [did]: { code: sel.value, basis, note: (note ? note.value : '').slice(0, 1000), by: by.trim().slice(0, 80), at: new Date().toISOString() } }); return p; });
    App.notify('Final code saved — the coders\' original codes are unchanged', 'success');
  }

  /* ── Exports ────────────────────────────── */
  function exportReport(r) {
    const A = srcLabel(r.A), B = srcLabel(r.B);
    const rows = r.dims.map(d => [d.dim.name, A, B, d.level, d.n, d.pa.value === null ? '' : d.pa.value.toFixed(4), d.kappa.value === null ? '' : d.kappa.value.toFixed(4), d.kappa.reason || '',
      d.wLinear && d.wLinear.value !== null ? d.wLinear.value.toFixed(4) : '', d.wQuad && d.wQuad.value !== null ? d.wQuad.value.toFixed(4) : '',
      d.alpha.value === null ? '' : d.alpha.value.toFixed(4), d.alpha.reason || '', d.alpha3.value === null ? '' : d.alpha3.value.toFixed(4), S.interpret(d.kappa.value)]);
    App.downloadCSV('metacode_reliability_' + r.A + '_vs_' + r.B + '.csv',
      ['dimension', 'source_a', 'source_b', 'measure', 'n_units_both_coded', 'percent_agreement', 'cohens_kappa', 'kappa_note', 'weighted_kappa_linear', 'weighted_kappa_quadratic', 'krippendorff_alpha', 'alpha_note', 'krippendorff_alpha_all_three', 'interpretation_landis_koch'], rows);
    App.notify('Reliability report downloaded', 'success');
  }
  function exportFinal() {
    const { posts, codebook } = App.getState();
    const headers = ['post_id', 'text'];
    codebook.forEach(d => headers.push('coder1_' + d.id, 'coder2_' + d.id, 'ai_' + d.id, 'final_' + d.id, 'final_source_' + d.id));
    const rows = posts.map(p => {
      const row = [p.id, p.text];
      codebook.forEach(d => {
        const adj = p.adjudicated && p.adjudicated[d.id];
        const fin = finalCode(p, d.id);
        row.push(codesOf(p, 'coder1')[d.id] || '', codesOf(p, 'coder2')[d.id] || '', (aiOf(p, d.id) || {}).code || '', fin || '', adj && adj.code ? 'adjudicated:' + adj.basis : (fin ? 'coders_agreed' : ''));
      });
      return row;
    });
    App.downloadCSV('metacode_final_codes.csv', headers, rows);
    App.notify('Final codes downloaded (adjudicated, or agreed by both coders)', 'success');
  }

  /* ── Coder files (coders on their own computers) ── */
  function coderFileDialog() {
    App.openModal('Coder files',
      '<p class="form-hint" style="margin-bottom:12px">Coders can work in their own browser with a copy of this project, then send their coding as a file. Importing it fills that coder\'s slot here — nothing else changes.</p>' +
      '<div class="hc-cf"><div class="hc-cf-row"><b>Export</b><button class="btn btn-secondary btn-sm" data-cfx="coder1">' + esc(coderLabel('coder1')) + '</button><button class="btn btn-secondary btn-sm" data-cfx="coder2">' + esc(coderLabel('coder2')) + '</button></div>' +
      '<div class="hc-cf-row"><b>Import into</b><select class="form-select" id="hc-cf-slot" style="width:auto"><option value="">the slot named in the file</option><option value="coder1">Coder 1</option><option value="coder2">Coder 2</option></select><input type="file" id="hc-cf-file" accept=".json,application/json" class="form-input"></div>' +
      '<div class="form-error" id="hc-cf-err"></div></div>', '<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>');
    const bodyEl = document.getElementById('modal-body');
    bodyEl.onclick = e => {
      const b = e.target.closest('[data-cfx]'); if (!b) return;
      const k = b.dataset.cfx;
      const { posts, codebook, project } = App.getState();
      const codes = {}, notes = {};
      posts.forEach(p => { const c = codesOf(p, k); if (Object.keys(c).length) codes[p.id] = c; if (p.coderNotes && p.coderNotes[k]) notes[p.id] = p.coderNotes[k]; });
      const file = { format: 'metacode-coder-file', version: 1, coder: k, name: cfg().coders[k].name, project: project && project.name, exportedAt: new Date().toISOString(),
        codebook: codebook.map(d => ({ id: d.id, name: d.name, codes: d.codes.map(c => ({ id: c.id, label: c.label })) })), codes, notes };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'metacode-' + k + (file.name ? '-' + file.name.replace(/[^A-Za-z0-9_-]+/g, '_') : '') + '.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      App.notify(Object.keys(codes).length + ' coded posts exported', 'success');
    };
    document.getElementById('hc-cf-file').onchange = async e => {
      const err = document.getElementById('hc-cf-err');
      err.textContent = '';
      const f = e.target.files[0]; if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch (x) { err.textContent = 'That isn\'t a JSON file.'; return; }
      if (!data || data.format !== 'metacode-coder-file' || !data.codes || typeof data.codes !== 'object') { err.textContent = 'That isn\'t a MetaCode coder file.'; return; }
      const slot = document.getElementById('hc-cf-slot').value || (data.coder === 'coder2' ? 'coder2' : 'coder1');
      const { posts, codebook } = App.getState();
      const dims = new Map(codebook.map(d => [d.id, new Set(d.codes.map(c => c.id))]));
      let matched = 0, skippedCodes = 0;
      const byId = new Map(posts.map(p => [p.id, p]));
      const unknownPosts = Object.keys(data.codes).filter(id => !byId.has(id)).length;
      const existing = posts.filter(p => Object.keys(codesOf(p, slot)).length).length;
      if (existing && !confirm(coderLabel(slot) + ' already has codes on ' + existing + ' posts. Replace them with the file?')) return;
      const next = posts.map(p => {
        const fc = data.codes[p.id];
        const n = Object.assign({}, p, { [FIELD[slot]]: {} });
        if (fc && typeof fc === 'object') {
          Object.keys(fc).forEach(did => { if (dims.has(did) && dims.get(did).has(fc[did])) n[FIELD[slot]][did] = fc[did]; else skippedCodes++; });
          if (Object.keys(n[FIELD[slot]]).length) matched++;
        }
        const note = data.notes && typeof data.notes[p.id] === 'string' ? data.notes[p.id].slice(0, 5000) : null;
        n.coderNotes = Object.assign({}, p.coderNotes || {});
        if (note) n.coderNotes[slot] = note; else delete n.coderNotes[slot];
        return n;
      });
      App.setState({ posts: next });
      if (data.name) { const cs = cfg().coders; cs[slot] = { name: String(data.name).slice(0, 80) }; setCfg({ coders: cs }); }
      App.closeModal();
      App.notify('Imported ' + matched + ' coded posts into ' + coderLabel(slot) + (unknownPosts ? ' · ' + unknownPosts + ' posts not in this project' : '') + (skippedCodes ? ' · ' + skippedCodes + ' codes not in this codebook skipped' : ''), unknownPosts || skippedCodes ? 'warning' : 'success', 6000);
      render(slot);
    };
  }

  // Compatibility: older entry points (sidebar shortcuts, tour) still work.
  function setFilter(v) { view.coder1.filter = v === 'uncoded' ? 'none' : v === 'human' ? 'done' : 'all'; render('coder1'); }
  return { render, setFilter, compute, finalCode, valueOf, _cfg: cfg };
})();
