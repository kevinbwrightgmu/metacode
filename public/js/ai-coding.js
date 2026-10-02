/* ══════════════════════════════════════════════
   ai-coding.js — Batch AI coding via Claude API
   ══════════════════════════════════════════════ */

const AICoder = (() => {

  let running = false;
  let stopFlag = false;
  let currentFilter = 'all';
  let viewPage = 0;
  const PAGE_SIZE = 20;

  /* ── Render ─────────────────────────────────*/
  function render() {
    const { posts, codebook } = App.getState();
    const container = document.getElementById('view-container');

    const aiCoded = posts.filter(p => Object.keys(p.aiCodes || {}).length > 0).length;
    const pct     = posts.length ? Math.round(aiCoded / posts.length * 100) : 0;

    if (!codebook.length) {
      container.innerHTML = `
        <div class="view-header"><div>
          <div class="view-title">AI Auto-Coding</div>
          <div class="view-subtitle">Claude will apply your codebook to each post and explain its reasoning</div>
        </div></div>
        <div class="empty-state">
          <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
          <div class="empty-title">Codebook required</div>
          <div class="empty-sub">Create a codebook with at least one dimension before running AI coding.</div>
          <button class="btn btn-primary" onclick="App.navigate('codebook')">Go to Codebook</button>
        </div>`;
      return;
    }

    if (!posts.length) {
      container.innerHTML = `
        <div class="view-header"><div>
          <div class="view-title">AI Auto-Coding</div>
          <div class="view-subtitle">Claude will apply your codebook to each post and explain its reasoning</div>
        </div></div>
        <div class="empty-state">
          <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg></div>
          <div class="empty-title">No posts to code</div>
          <div class="empty-sub">Import posts first, then return here to run AI coding.</div>
          <button class="btn btn-primary" onclick="App.navigate('import')">Import Posts</button>
        </div>`;
      return;
    }

    const uncodedCount = posts.filter(p => !Object.keys(p.aiCodes || {}).length).length;

    container.innerHTML =
      '<div class="view-header"><div>' +
        '<div class="view-title">AI Auto-Coding</div>' +
        '<div class="view-subtitle">Claude will apply your codebook to each post and explain its reasoning</div>' +
      '</div></div>' +

      '<div class="coding-controls">' +
        '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px">' +
            '<div style="font-family:var(--f-display);font-weight:600;font-size:15px">' +
              posts.length + ' posts &nbsp;·&nbsp; ' + aiCoded + ' AI-coded (' + pct + '%)' +
            '</div>' +
            '<div style="font-size:13px;color:var(--tx-second);margin-top:2px">' +
              codebook.length + ' dimension' + (codebook.length !== 1 ? 's' : '') + ': ' +
              codebook.map(d => d.name).join(', ') +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn btn-secondary btn-sm" onclick="AICoder.setFilter(\'all\')">All (' + posts.length + ')</button>' +
            '<button class="btn btn-secondary btn-sm" onclick="AICoder.setFilter(\'uncoded\')">Uncoded (' + uncodedCount + ')</button>' +
            '<button class="btn btn-secondary btn-sm" onclick="AICoder.setFilter(\'coded\')">Coded (' + aiCoded + ')</button>' +
          '</div>' +
          '<div style="display:flex;gap:8px">' +
            '<button class="btn btn-violet" id="run-btn" onclick="AICoder.run()">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
              ' Run AI Coding' +
            '</button>' +
            '<button class="btn btn-secondary" id="stop-btn" style="display:none" onclick="AICoder.stop()">Stop</button>' +
            '<button class="btn btn-secondary" onclick="AICoder.clearAll()">Clear AI Codes</button>' +
          '</div>' +
        '</div>' +
        '<div class="coding-progress" id="coding-progress" style="display:none">' +
          '<div class="progress-label" id="progress-label">0 / 0</div>' +
          '<div class="progress-wrap" style="flex:1"><div class="progress-bar" id="progress-bar" style="width:0%;background:var(--violet)"></div></div>' +
          '<div id="progress-pct" class="text-muted" style="font-size:12px;min-width:38px">0%</div>' +
        '</div>' +
        '<div id="status-msg" style="margin-top:8px;font-size:13px;color:var(--tx-second)"></div>' +
      '</div>' +

      '<div class="post-table-wrap" id="post-table">' + renderTable() + '</div>';
  }

  function renderTable() {
    const { posts, codebook } = App.getState();
    const filtered = filterPosts(posts);
    const page = filtered.slice(viewPage * PAGE_SIZE, (viewPage + 1) * PAGE_SIZE);

    if (!filtered.length) {
      return '<div class="empty-state" style="padding:40px"><div class="empty-sub">No posts match this filter.</div></div>';
    }

    let pagerHTML = '';
    if (filtered.length > PAGE_SIZE) {
      pagerHTML =
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<button class="btn btn-ghost btn-sm" onclick="AICoder.prevPage()"' + (viewPage === 0 ? ' disabled' : '') + '>&#8592; Prev</button>' +
          '<span style="font-size:13px;color:var(--tx-second)">Page ' + (viewPage + 1) + ' / ' + Math.ceil(filtered.length / PAGE_SIZE) + '</span>' +
          '<button class="btn btn-ghost btn-sm" onclick="AICoder.nextPage()"' + ((viewPage + 1) * PAGE_SIZE >= filtered.length ? ' disabled' : '') + '>Next &#8594;</button>' +
        '</div>';
    }

    let dimHeaders = '';
    codebook.forEach(d => {
      dimHeaders += '<th style="min-width:130px"><span style="color:var(--violet);font-size:11.5px">AI &middot; ' + App.esc(d.name) + '</span></th>';
    });

    let rows = '';
    page.forEach(function(post, idx) {
      const globalIdx = viewPage * PAGE_SIZE + idx;
      const hasAI = Object.keys(post.aiCodes || {}).length > 0;

      let dimCells = '';
      codebook.forEach(function(dim) {
        const aiCode   = post.aiCodes ? post.aiCodes[dim.id] : null;
        const found    = aiCode ? dim.codes.find(c => c.id === aiCode.code) : null;
        const codeLabel = found ? found.label : (aiCode ? aiCode.code : null);

        if (aiCode && codeLabel) {
          const confHTML  = (aiCode.confidence != null)
            ? '<span class="code-chip conf">' + Math.round(aiCode.confidence * 100) + '%</span>'
            : '';
          const reasonBtn = aiCode.reasoning
            ? '<button class="reasoning-btn" onclick="AICoder.showReasoning(\'' + App.esc(post.id) + '\',\'' + App.esc(dim.id) + '\')" title="View reasoning">&#128172;</button>'
            : '';
          dimCells += '<td><div style="display:flex;flex-direction:column;gap:3px">' +
            '<span class="code-chip ai">' + App.esc(codeLabel) + '</span>' + confHTML + reasonBtn +
            '</div></td>';
        } else {
          dimCells += '<td><span class="text-muted" style="font-size:12px">&mdash;</span></td>';
        }
      });

      const clearBtn = hasAI
        ? '<button class="btn btn-ghost btn-sm" onclick="AICoder.clearOne(\'' + post.id + '\')" style="color:var(--tx-muted)">Clear</button>'
        : '';

      rows +=
        '<tr id="row-' + post.id + '">' +
          '<td class="text-muted" style="font-size:12px">' + (globalIdx + 1) + '</td>' +
          '<td><div style="font-size:13px;max-width:320px;line-height:1.5">' +
            App.esc(post.text.slice(0, 160)) + (post.text.length > 160 ? '&hellip;' : '') +
          '</div>' +
          (post.author ? '<div style="font-size:11.5px;color:var(--tx-muted);margin-top:3px">@' + App.esc(post.author) + '</div>' : '') +
          '</td>' +
          dimCells +
          '<td><span class="badge ' + (hasAI ? 'badge-violet' : 'badge-gray') + '">' + (hasAI ? 'Coded' : 'Uncoded') + '</span></td>' +
          '<td>' +
            '<button class="btn btn-ghost btn-sm" onclick="AICoder.codeOne(\'' + post.id + '\')" style="color:var(--violet);white-space:nowrap">Code this</button>' +
            clearBtn +
          '</td>' +
        '</tr>';
    });

    return (
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)">' +
        '<div style="font-size:13.5px;font-weight:600">' + filtered.length + ' posts</div>' +
        pagerHTML +
      '</div>' +
      '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th style="width:40px">#</th>' +
        '<th style="min-width:280px">Post</th>' +
        dimHeaders +
        '<th>Status</th><th>Action</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    );
  }

  function filterPosts(posts) {
    if (currentFilter === 'uncoded') return posts.filter(p => !Object.keys(p.aiCodes || {}).length);
    if (currentFilter === 'coded')   return posts.filter(p =>  Object.keys(p.aiCodes || {}).length > 0);
    return posts;
  }

  function setFilter(f) { currentFilter = f; viewPage = 0; refreshTable(); }
  function prevPage()   { if (viewPage > 0) { viewPage--; refreshTable(); } }
  function nextPage()   { viewPage++; refreshTable(); }

  function refreshTable() {
    const el = document.getElementById('post-table');
    if (el) el.innerHTML = renderTable();
  }

  /* ── Prompt builders ─────────────────────────*/
  function buildSystemPrompt() {
    const { codebook } = App.getState();

    // Build a plain-text codebook description
    var dimText = codebook.map(function(d) {
      var codeLines = d.codes.map(function(c) {
        var line = '  code "' + c.id + '" = ' + c.label + (c.description ? ' (' + c.description + ')' : '');
        if (c.aiNotes) {
          line += '\n    Additional guidance for applying this code: ' + c.aiNotes;
        }
        return line;
      }).join('\n');
      return 'Dimension "' + d.id + '" — ' + d.name + (d.description ? ': ' + d.description : '') + '\n' + codeLines;
    }).join('\n\n');

    // Build a concrete example using the real IDs so the model has no ambiguity
    var exampleParts = codebook.map(function(d) {
      var firstCode = d.codes.length ? d.codes[0].id : 'code_id';
      return '"' + d.id + '":{"code":"' + firstCode + '","confidence":0.9,"reasoning":"One sentence."}';
    }).join(',');

    return (
      'You are a content analyst coding social media posts for academic research.\n\n' +
      'CODEBOOK:\n' + dimText + '\n\n' +
      'INSTRUCTIONS:\n' +
      '1. Read the post the user sends.\n' +
      '2. Assign one code per dimension using only the code IDs listed above.\n' +
      '3. Your ENTIRE response must be a single raw JSON object — no explanation, no markdown, no code fences.\n' +
      '4. The JSON must start with { and end with } and be valid JSON.\n\n' +
      'EXACT OUTPUT FORMAT:\n' +
      '{"codings":{' + exampleParts + '}}\n\n' +
      'Required dimension IDs: ' + codebook.map(function(d){ return d.id; }).join(', ') + '\n' +
      'Do not add any text before or after the JSON object.'
    );
  }

  function buildUserMessage(post) {
    var msg = 'Code this post:\n\n"' + post.text + '"';
    if (post.author)    msg += '\nAuthor: @' + post.author;
    if (post.timestamp) msg += '\nDate: ' + post.timestamp;
    var e = post.engagement;
    if (e) {
      var parts = [];
      if (e.likes    != null) parts.push(e.likes    + ' likes');
      if (e.shares   != null) parts.push(e.shares   + ' shares');
      if (e.comments != null) parts.push(e.comments + ' comments');
      if (parts.length) msg += '\nEngagement: ' + parts.join(', ');
    }
    return msg;
  }

  /* ── Core coding function ────────────────────*/
  async function codePost(post) {
    const system = buildSystemPrompt();
    const user   = buildUserMessage(post);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await App.callClaude([{ role: 'user', content: user }], system, 1000);

        // ── Robust JSON extraction ──────────────
        // Claude may add a sentence before/after, or wrap in ``` fences,
        // even when told not to. We find the first { and last } and parse that.
        let src = raw.trim();

        // Strip markdown code fences if present
        src = src.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

        // Find outermost JSON object boundaries
        const start = src.indexOf('{');
        const end   = src.lastIndexOf('}');

        if (start === -1 || end === -1 || end <= start) {
          throw new Error('No JSON object found in model response. Got: "' + raw.slice(0, 120) + '"');
        }

        const jsonStr = src.slice(start, end + 1);
        const parsed  = JSON.parse(jsonStr);

        if (!parsed.codings || typeof parsed.codings !== 'object') {
          throw new Error('JSON is missing the required "codings" key. Got: ' + jsonStr.slice(0, 120));
        }

        return parsed.codings;

      } catch (err) {
        if (attempt === 2) throw err;   // rethrow after final attempt
        await delay(1000);              // wait longer between retries
      }
    }
  }

  /* ── Batch run ───────────────────────────────*/
  async function run() {
    const { posts } = App.getState();
    const toCode = filterPosts(posts).filter(p => !Object.keys(p.aiCodes || {}).length);

    if (!toCode.length) { App.notify('All visible posts are already coded', 'info'); return; }
    if (!App.hasApiKeys()) { App.notify('Enter your API key in Settings first', 'error'); return; }

    running = true; stopFlag = false;
    toggleRunButton(true);
    showProgress(true);

    let done = 0;
    for (const post of toCode) {
      if (stopFlag) break;

      updateStatus('Coding post ' + (done + 1) + ' of ' + toCode.length + ': "' + post.text.slice(0, 60) + '\u2026"');
      updateProgress(done, toCode.length);

      try {
        const codings = await codePost(post);
        const current = App.getState();
        const updated = current.posts.map(p => p.id === post.id ? Object.assign({}, p, { aiCodes: codings }) : p);
        App.setState({ posts: updated });
        refreshTable();
      } catch (err) {
        console.error('[AICoder] post', post.id, err);
        updateStatus('Error on post ' + (done + 1) + ': ' + err.message + ' — skipping', true);
      }

      done++;
      updateProgress(done, toCode.length);

      if (done < toCode.length && !stopFlag) {
        await delay(App.getState().settings.delay || 500);
      }
    }

    running = false;
    toggleRunButton(false);
    updateProgress(done, toCode.length);

    const doneMsg = stopFlag
      ? 'Stopped after ' + done + ' posts.'
      : '\u2713 Done \u2014 ' + done + ' posts coded.';
    updateStatus(doneMsg, false);
    App.notify(
      stopFlag ? 'Stopped (' + done + ' coded)' : 'AI coding complete \u2014 ' + done + ' posts coded',
      stopFlag ? 'warning' : 'success'
    );
  }

  /* ── Single-post coding ──────────────────────*/
  async function codeOne(postId) {
    if (!App.hasApiKeys()) { App.notify('Enter your API key in Settings first', 'error'); return; }
    const post = App.getState().posts.find(p => p.id === postId);
    if (!post) return;

    updateStatus('Coding\u2026', false);
    try {
      const codings = await codePost(post);
      const updated = App.getState().posts.map(p => p.id === postId ? Object.assign({}, p, { aiCodes: codings }) : p);
      App.setState({ posts: updated });
      refreshTable();
      App.notify('Post coded', 'success');
    } catch (err) {
      App.notify('Coding error: ' + err.message, 'error');
    }
    updateStatus('', false);
  }

  function stop()     { stopFlag = true; }

  function clearOne(postId) {
    const updated = App.getState().posts.map(p => p.id === postId ? Object.assign({}, p, { aiCodes: {} }) : p);
    App.setState({ posts: updated });
    refreshTable();
    App.notify('AI codes cleared for post', 'warning');
  }

  function clearAll() {
    if (!confirm('Clear all AI coding results?')) return;
    const updated = App.getState().posts.map(p => Object.assign({}, p, { aiCodes: {} }));
    App.setState({ posts: updated });
    render();
    App.notify('All AI codes cleared', 'warning');
  }

  /* ── Reasoning viewer ────────────────────────*/
  function showReasoning(postId, dimId) {
    const { posts, codebook } = App.getState();
    const post   = posts.find(p => p.id === postId);
    const dim    = codebook.find(d => d.id === dimId);
    const aiCode = post && post.aiCodes ? post.aiCodes[dimId] : null;
    if (!post || !aiCode) return;

    const found = dim ? dim.codes.find(c => c.id === aiCode.code) : null;
    const label = found ? found.label : aiCode.code;
    const confHTML = aiCode.confidence != null
      ? '<span class="code-chip conf" style="margin-left:6px">' + Math.round(aiCode.confidence * 100) + '% confident</span>'
      : '';
    const reasonHTML = aiCode.reasoning
      ? '<div><div style="font-size:12px;color:var(--tx-muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Reasoning</div>' +
        '<div style="font-size:14px;line-height:1.65">' + App.esc(aiCode.reasoning) + '</div></div>'
      : '';

    App.openModal(
      'AI Reasoning \u2014 ' + (dim ? dim.name : dimId),
      '<div style="display:flex;flex-direction:column;gap:16px">' +
        '<div style="background:var(--bg-muted);padding:14px 16px;border-radius:var(--r-md);font-size:13.5px;line-height:1.6">&ldquo;' + App.esc(post.text) + '&rdquo;</div>' +
        '<div><div style="font-size:12px;color:var(--tx-muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">AI Code</div>' +
          '<span class="code-chip ai" style="font-size:13.5px">' + App.esc(label) + '</span>' + confHTML +
        '</div>' +
        reasonHTML +
      '</div>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>'
    );
  }

  /* ── UI helpers ──────────────────────────────*/
  function toggleRunButton(isRunning) {
    const runBtn  = document.getElementById('run-btn');
    const stopBtn = document.getElementById('stop-btn');
    if (runBtn)  runBtn.style.display  = isRunning ? 'none' : '';
    if (stopBtn) stopBtn.style.display = isRunning ? '' : 'none';
  }

  function showProgress(show) {
    const el = document.getElementById('coding-progress');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  function updateProgress(done, total) {
    const pct = total ? Math.round(done / total * 100) : 0;
    const bar   = document.getElementById('progress-bar');
    const label = document.getElementById('progress-label');
    const pctEl = document.getElementById('progress-pct');
    if (bar)   bar.style.width    = pct + '%';
    if (label) label.textContent  = done + ' / ' + total;
    if (pctEl) pctEl.textContent  = pct + '%';
  }

  function updateStatus(msg, isError) {
    const el = document.getElementById('status-msg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--error)' : 'var(--tx-second)';
  }

  function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  /* ── Public API ──────────────────────────────*/
  return { render, run, stop, codeOne, clearOne, clearAll, showReasoning,
           setFilter, prevPage, nextPage };
})();
