/* ══════════════════════════════════════════════
   human-coding.js — Manual coding interface
   ══════════════════════════════════════════════ */

const HumanCoder = (() => {

  let currentIdx = 0;
  let filter = 'all';
  let filteredList = [];

  /* ── Render ─────────────────────────────────*/
  function render() {
    const { posts, codebook } = App.getState();
    const container = document.getElementById('view-container');

    if (!codebook.length) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
        <div class="empty-title">Codebook required</div>
        <div class="empty-sub">Build your codebook before starting human coding.</div>
        <button class="btn btn-primary" onclick="App.navigate('codebook')">Go to Codebook</button>
      </div>`;
      return;
    }
    if (!posts.length) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg></div>
        <div class="empty-title">No posts to code</div>
        <div class="empty-sub">Import posts first.</div>
        <button class="btn btn-primary" onclick="App.navigate('import')">Import Posts</button>
      </div>`;
      return;
    }

    refreshList();
    if (currentIdx >= filteredList.length) currentIdx = 0;

    const humanCoded = posts.filter(p => Object.keys(p.humanCodes||{}).length > 0).length;
    const pct = posts.length ? Math.round(humanCoded/posts.length*100) : 0;

    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Human Coding</div>
          <div class="view-subtitle">${humanCoded} of ${posts.length} posts coded (${pct}%)</div>
        </div>
        <div class="view-actions">
          <select class="form-select" id="filter-select" onchange="HumanCoder.setFilter(this.value)" style="width:auto;font-size:13px">
            <option value="all"     ${filter==='all'?'selected':''}>All posts</option>
            <option value="uncoded" ${filter==='uncoded'?'selected':''}>Uncoded only</option>
            <option value="human"   ${filter==='human'?'selected':''}>Human coded</option>
            <option value="both"    ${filter==='both'?'selected':''}>Dual-coded</option>
          </select>
          <button class="btn btn-secondary btn-sm" onclick="HumanCoder.clearAll()">Clear My Codes</button>
        </div>
      </div>

      <!-- Progress bar -->
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px 20px;margin-bottom:20px;box-shadow:var(--sh-sm)">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="flex:1">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--tx-second);margin-bottom:6px">
              <span>Human coding progress</span>
              <span style="font-weight:600">${pct}%</span>
            </div>
            <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%;background:var(--teal)"></div></div>
          </div>
          <div style="display:flex;gap:16px;font-size:13px;flex-shrink:0">
            <span><strong>${humanCoded}</strong> <span class="text-muted">human coded</span></span>
            <span><strong>${posts.filter(p=>Object.keys(p.aiCodes||{}).length>0).length}</strong> <span class="text-muted">AI coded</span></span>
          </div>
        </div>
      </div>

      <!-- Main layout -->
      <div class="hc-layout">
        <!-- Left: post list + post viewer -->
        <div>
          <!-- Post list (sidebar within content) -->
          <div class="card" style="margin-bottom:16px;padding:0;overflow:hidden">
            <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
              <div style="font-weight:600;font-size:13.5px">${filteredList.length} posts</div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-ghost btn-sm" onclick="HumanCoder.prev()">← Prev</button>
                <span id="hc-counter" style="font-size:13px;color:var(--tx-second);padding:4px 6px">${currentIdx+1} / ${filteredList.length}</span>
                <button class="btn btn-ghost btn-sm" onclick="HumanCoder.next()">Next →</button>
              </div>
            </div>
            <div style="max-height:220px;overflow-y:auto" id="post-list">
              ${filteredList.map((p,i) => postListItem(p,i)).join('')}
            </div>
          </div>

          <!-- Current post -->
          <div id="post-display"></div>
        </div>

        <!-- Right: coding panel -->
        <div>
          <div class="coding-panel" id="coding-panel"></div>
        </div>
      </div>
    `;

    renderPost();
    setupKeyboard();
  }

  function postListItem(post, idx) {
    const hasHuman = Object.keys(post.humanCodes||{}).length > 0;
    const hasAI    = Object.keys(post.aiCodes||{}).length > 0;
    return `
      <div class="post-list-item ${idx===currentIdx?'active':''}" onclick="HumanCoder.jumpTo(${idx})" id="pli-${idx}">
        <span class="pli-id">${idx+1}</span>
        <span class="pli-text">${App.esc(post.text)}</span>
        <span class="pli-status">
          ${hasHuman ? '<span class="badge badge-teal" style="font-size:10.5px;padding:2px 6px">✓</span>' :
            hasAI   ? '<span class="badge badge-violet" style="font-size:10.5px;padding:2px 6px">AI</span>' :
                      '<span class="badge badge-gray"   style="font-size:10.5px;padding:2px 6px">—</span>'}
        </span>
      </div>`;
  }

  function renderPost() {
    if (!filteredList.length) {
      document.getElementById('post-display').innerHTML = `
        <div class="empty-state"><div class="empty-sub">No posts match this filter.</div></div>`;
      document.getElementById('coding-panel').innerHTML = '';
      return;
    }

    const post = filteredList[currentIdx];
    const { codebook } = App.getState();

    // Post card
    document.getElementById('post-display').innerHTML = `
      <div class="post-card">
        <div class="post-meta">
          ${post.author ? `<span class="post-author">@${App.esc(post.author)}</span>` : ''}
          ${post.timestamp ? `<span class="post-time">${App.esc(post.timestamp)}</span>` : ''}
          <span class="badge badge-gray" style="margin-left:auto;font-size:11px">#${currentIdx+1}</span>
        </div>
        <div class="post-text">${App.esc(post.text)}</div>
        ${engagementRow(post)}
      </div>`;

    // Coding panel
    document.getElementById('coding-panel').innerHTML = `
      <div class="cp-head" style="display:flex;align-items:center;justify-content:space-between">
        <span>Assign Codes</span>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:400;cursor:pointer">
          <input type="checkbox" id="auto-advance" style="cursor:pointer"> Auto-advance
        </label>
      </div>
      <div class="cp-body" id="cp-body">
        ${codebook.map((dim, di) => dimensionPanel(dim, post, di)).join('')}
      </div>
      <div class="cp-foot">
        <button class="btn btn-secondary" style="flex:1" onclick="HumanCoder.prev()">← Prev</button>
        <button class="btn btn-teal"     style="flex:1" onclick="HumanCoder.saveAndNext()">Save & Next →</button>
      </div>
    `;

    // Scroll post list to current
    const pli = document.getElementById(`pli-${currentIdx}`);
    if (pli) pli.scrollIntoView({ block:'nearest', behavior:'smooth' });

    // Update counter
    const ctr = document.getElementById('hc-counter');
    if (ctr) ctr.textContent = `${currentIdx+1} / ${filteredList.length}`;
  }

  function dimensionPanel(dim, post, dimIndex) {
    const selected = post.humanCodes?.[dim.id] || null;
    const aiCode   = post.aiCodes?.[dim.id];
    const aiLabel  = aiCode ? (dim.codes.find(c=>c.id===aiCode.code)?.label || aiCode.code) : null;

    return `
      <div class="cp-dim" id="cpdim-${dim.id}">
        <div class="cp-dim-label">${App.esc(dim.name)}</div>
        ${dim.description ? `<div class="cp-dim-desc">${App.esc(dim.description)}</div>` : ''}
        <div class="cp-codes">
          ${dim.codes.map((code, ci) => `
            <button class="cp-code-btn ${selected===code.id?'selected':''}"
              id="cpbtn-${dim.id}-${code.id}"
              onclick="HumanCoder.selectCode('${dim.id}','${code.id}')"
              title="${App.esc(code.description||code.label)}"
              data-dim="${dim.id}" data-code="${code.id}">
              ${App.esc(code.label)}
              ${code.description ? `<span style="font-size:11px;opacity:.7;display:block;margin-top:1px">${App.esc(code.description.slice(0,55))}${code.description.length>55?'…':''}</span>` : ''}
            </button>`).join('')}
        </div>
        ${aiLabel ? `<div class="cp-ai-hint">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          AI suggests: <strong>${App.esc(aiLabel)}</strong>
          ${aiCode?.confidence!=null?`<span style="color:var(--tx-muted)">(${Math.round(aiCode.confidence*100)}%)</span>`:''}
          <button onclick="HumanCoder.adoptAI('${dim.id}')" style="background:none;border:none;cursor:pointer;color:var(--violet);font-size:11px;text-decoration:underline">Adopt</button>
        </div>` : ''}
      </div>`;
  }

  function engagementRow(post) {
    const e = post.engagement;
    if (!e) return '';
    const items = [];
    if (e.likes    != null) items.push(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> ${e.likes}`);
    if (e.shares   != null) items.push(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> ${e.shares}`);
    if (e.comments != null) items.push(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> ${e.comments}`);
    if (e.views    != null) items.push(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${e.views}`);
    if (!items.length) return '';
    return `<div class="post-engagement">${items.map(i=>`<span class="eng-item">${i}</span>`).join('')}</div>`;
  }

  /* ── Actions ─────────────────────────────────*/
  function selectCode(dimId, codeId) {
    const post = filteredList[currentIdx];
    if (!post) return;

    // Update state
    const posts = App.getState().posts.map(p => {
      if (p.id !== post.id) return p;
      const humanCodes = { ...p.humanCodes, [dimId]: codeId };
      return { ...p, humanCodes };
    });
    App.setState({ posts });
    // Sync filteredList reference
    const updated = App.getState().posts.find(p=>p.id===post.id);
    filteredList[currentIdx] = updated;

    // Update button styles
    const dim = App.getState().codebook.find(d=>d.id===dimId);
    dim?.codes.forEach(c => {
      const btn = document.getElementById(`cpbtn-${dimId}-${c.id}`);
      if (btn) btn.classList.toggle('selected', c.id === codeId);
    });

    // Update post list badge
    const pli = document.getElementById(`pli-${currentIdx}`);
    if (pli) {
      const statusEl = pli.querySelector('.pli-status');
      if (statusEl) statusEl.innerHTML = '<span class="badge badge-teal" style="font-size:10.5px;padding:2px 6px">✓</span>';
    }

    // Auto-advance if all dims coded
    const autoAdv = document.getElementById('auto-advance');
    if (autoAdv?.checked) {
      const { codebook } = App.getState();
      const allDone = codebook.every(d => updated.humanCodes?.[d.id]);
      if (allDone) setTimeout(() => next(), 300);
    }
  }

  function adoptAI(dimId) {
    const post  = filteredList[currentIdx];
    const aiCode = post?.aiCodes?.[dimId];
    if (!aiCode?.code) return;
    selectCode(dimId, aiCode.code);
    App.notify('Adopted AI suggestion', 'info');
  }

  function saveAndNext() {
    const post = filteredList[currentIdx];
    if (!post) return;
    const { codebook } = App.getState();
    const coded = codebook.filter(d => post.humanCodes?.[d.id]);
    if (!coded.length) { App.notify('Assign at least one code before advancing', 'warning'); return; }
    App.notify(`Saved ${coded.length} code${coded.length!==1?'s':''} for post ${currentIdx+1}`, 'success');
    next();
  }

  function next() {
    if (currentIdx < filteredList.length - 1) {
      jumpTo(currentIdx + 1);
    } else {
      App.notify('You\'ve reached the last post in this view', 'info');
    }
  }

  function prev() {
    if (currentIdx > 0) jumpTo(currentIdx - 1);
  }

  function jumpTo(idx) {
    currentIdx = idx;
    refreshList();
    renderPost();
  }

  function setFilter(val) {
    filter = val;
    currentIdx = 0;
    refreshList();
    renderPost();
    // Rebuild list
    const listEl = document.getElementById('post-list');
    if (listEl) listEl.innerHTML = filteredList.map((p,i) => postListItem(p,i)).join('');
    const ctr = document.getElementById('hc-counter');
    if (ctr) ctr.textContent = `${currentIdx+1} / ${filteredList.length}`;
  }

  function refreshList() {
    const { posts } = App.getState();
    if (filter === 'uncoded') filteredList = posts.filter(p => !Object.keys(p.humanCodes||{}).length);
    else if (filter === 'human') filteredList = posts.filter(p => Object.keys(p.humanCodes||{}).length > 0);
    else if (filter === 'both')  filteredList = posts.filter(p =>
      Object.keys(p.humanCodes||{}).length > 0 && Object.keys(p.aiCodes||{}).length > 0);
    else filteredList = [...posts];
  }

  function clearAll() {
    if (!confirm('Clear all human coding results?')) return;
    const posts = App.getState().posts.map(p => ({...p, humanCodes:{}}));
    App.setState({ posts });
    App.notify('Human codes cleared', 'warning');
    render();
  }

  /* ── Keyboard shortcuts ─────────────────────*/
  function setupKeyboard() {
    document.onkeydown = e => {
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'j') next();
      if (e.key === 'ArrowLeft'  || e.key === 'k') prev();
    };
  }

  return { render, selectCode, adoptAI, saveAndNext, next, prev, jumpTo, setFilter, clearAll };
})();
