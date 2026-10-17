/* ══════════════════════════════════════════════
   lab-workbench.js — the AI Workbench

   Conversations with a coding assistant: streamed answers (Stop cancels the
   model request), regenerate, summaries of older messages, and a context
   panel showing exactly what was sent. Answers are rendered as untrusted
   Markdown; code is shown, copied or compared — never run.
   ══════════════════════════════════════════════ */

(() => {
  'use strict';
  const { esc, fmt, when, get, post, patch, del, act, notify, openModal, closeModal, confirmDanger, $ } = Lab;
  const S = { conv: null, docs: [], profiles: [], streaming: null, report: null, taskType: '', retrieval: { enabled: true, k: 5, docIds: null } };

  /* ── Server-sent events over fetch (POST bodies can't use EventSource) ── */
  async function stream(path, body, on, signal) {
    const res = await Lab.api(path, { method: 'POST', body, raw: true, signal });
    if (!res.ok) { let b = null; try { b = await res.json(); } catch (e) { b = null; } throw new Lab.ApiError(res.status, b); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', data = '';
        raw.split('\n').forEach(l => { if (l.startsWith('event: ')) ev = l.slice(7); else if (l.startsWith('data: ')) data += l.slice(6); });
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = null; }
        if (on[ev]) on[ev](parsed);
      }
    }
  }

  Lab.view('workbench', async (main, [convId]) => {
    const p = Lab.project();
    await Lab.loadModels();
    const [convs, profiles, docs] = await Promise.all([
      get('/conversations' + (p ? '?projectId=' + encodeURIComponent(p.id) : '')).then(r => r.conversations),
      get('/profiles').then(r => r.profiles),
      p ? get('/projects/' + p.id + '/documents').then(r => r.documents) : Promise.resolve([])
    ]);
    const id = convId || (convs[0] && convs[0].id);
    let conv = null;
    if (id) {
      try { conv = (await get('/conversations/' + encodeURIComponent(id))).conversation; }
      catch (e) { if (e.status !== 404) throw e; notify('That conversation no longer exists.', 'info'); }
    }
    if (!main.isConnected) return;
    if (S.streaming) S.streaming.abort();
    Object.assign(S, { profiles, docs: docs.filter(d => d.status === 'ready'), conv, report: null });
    main.innerHTML = '<div class="lab-wb">' +
      '<section class="lab-wb-col" aria-label="Conversations"><header><span>Conversations' + (p ? '' : ' (all)') + '</span><button class="btn btn-primary btn-sm" id="wb-new">New</button></header>' +
        '<div class="lab-wb-scroll">' + (convs.length ? '<ul class="lab-conv-list">' + convs.map(c => '<li><button type="button" data-conv="' + esc(c.id) + '"' + (S.conv && c.id === S.conv.id ? ' aria-current="true"' : '') + '>' + esc(c.title) +
          '<div class="lab-muted">' + fmt(c.messages) + ' message' + (c.messages === 1 ? '' : 's') + ' · ' + when(c.updatedAt) + '</div></button></li>').join('') + '</ul>'
          : '<p class="lab-muted">No conversations' + (p ? ' in ' + esc(p.name) : '') + ' yet.</p>') + '</div></section>' +
      '<section class="lab-wb-col" aria-label="Conversation" id="wb-center"></section>' +
      '<aside class="lab-wb-col lab-wb-ctx" aria-label="Context and settings" id="wb-ctx"></aside></div>';
    $('wb-new').onclick = e => act(e.target, newConversation);
    main.querySelectorAll('[data-conv]').forEach(b => { b.onclick = () => Lab.go('workbench/' + b.dataset.conv); });
    renderCenter();
    renderContext();
    Lab.onLeave(() => { if (S.streaming) S.streaming.abort(); });
  });

  async function newConversation() {
    const p = Lab.project();
    const m = Lab.defaultModel();
    const body = { projectId: p ? p.id : null, profileId: p && p.defaultProfileId ? p.defaultProfileId : null };
    if (m) { body.provider = m.provider; body.model = m.model; }
    const r = await post('/conversations', body);
    Lab.go('workbench/' + r.conversation.id);
  }

  /* ── Messages and composer ───────────────── */
  function renderCenter() {
    const box = $('wb-center');
    const c = S.conv;
    if (!c) {
      box.innerHTML = '<div class="lab-wb-scroll"><div class="lab-empty"><h3>Start a conversation</h3><p>Ask for code, a review, tests or an explanation. Answers use your coding profile and, when you allow it, passages from the project\'s knowledge base.</p>' +
        '<button class="btn btn-primary" id="wb-start">New conversation</button></div></div>';
      $('wb-start').onclick = e => act(e.target, newConversation);
      return;
    }
    const types = (Lab.state.models && Lab.state.models.notes && Lab.state.models.notes.taskTypes) || {};
    box.innerHTML = '<header><span id="wb-title">' + esc(c.title) + '</span><span class="lab-actions"><button class="btn btn-ghost btn-sm" id="wb-rename">Rename</button>' +
        '<button class="btn btn-ghost btn-sm" id="wb-md">Export</button><button class="btn btn-ghost btn-sm" id="wb-del">Delete</button></span></header>' +
      '<div class="lab-wb-scroll" id="wb-scroll"><div class="lab-msgs" id="wb-msgs"></div></div>' +
      '<form class="lab-compose" id="wb-form"><label class="lab-visually-hidden" for="wb-input">Message</label><textarea class="form-textarea" id="wb-input" placeholder="Ask for code, a fix, tests or a review… (Ctrl+Enter sends)" maxlength="60000"></textarea>' +
        '<div class="lab-compose-row"><span class="lab-actions"><label class="lab-visually-hidden" for="wb-type">Task type</label><select class="form-select" id="wb-type"><option value="">Any task</option>' +
          Object.keys(types).map(k => '<option value="' + esc(k) + '"' + (S.taskType === k ? ' selected' : '') + '>' + esc(types[k].label) + '</option>').join('') + '</select>' +
          '<label class="lab-muted"><input type="checkbox" id="wb-rag"' + (S.retrieval.enabled ? ' checked' : '') + (c.projectId ? '' : ' disabled') + '> Use project knowledge</label></span>' +
          '<span class="lab-actions"><button type="button" class="btn btn-secondary btn-sm" id="wb-stop" hidden>Stop</button><button type="submit" class="btn btn-primary btn-sm" id="wb-send">Send</button></span></div></form>';
    renderMessages();
    $('wb-type').onchange = e => { S.taskType = e.target.value; };
    $('wb-rag').onchange = e => { S.retrieval.enabled = e.target.checked; };
    $('wb-form').onsubmit = e => { e.preventDefault(); Lab.background(send()); };
    $('wb-input').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); Lab.background(send()); } };
    $('wb-stop').onclick = () => { if (S.streaming) S.streaming.abort(); };
    $('wb-rename').onclick = () => {
      openModal('Rename conversation', Lab.field('Title', '<input class="form-input" name="title" maxlength="200" value="' + esc(c.title) + '">'), '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="wb-rn">Rename</button>');
      $('wb-rn').onclick = ev => act(ev.target, async () => { S.conv = (await patch('/conversations/' + c.id, { title: Lab.formValues($('modal-body')).title })).conversation; closeModal(); Lab.route(); });
    };
    $('wb-md').onclick = () => {
      openModal('Export conversation', '<p class="lab-second">Markdown is easy to read and share; JSON keeps everything, including token usage and the context of each answer.</p>',
        '<button class="btn btn-secondary" id="wb-xj">JSON</button><button class="btn btn-primary" id="wb-xm">Markdown</button>');
      $('wb-xm').onclick = () => { closeModal(); Lab.download('/conversations/' + c.id + '/export?format=markdown', 'conversation.md'); };
      $('wb-xj').onclick = () => { closeModal(); Lab.download('/conversations/' + c.id + '/export', 'conversation.json'); };
    };
    $('wb-del').onclick = async () => { if (await confirmDanger('Delete conversation?', '"' + c.title + '" and its messages are deleted.')) act(null, async () => { await del('/conversations/' + c.id); S.conv = null; Lab.go('workbench'); }); };
  }

  function usageLine(m) {
    const bits = [];
    if (m.model) bits.push(esc(m.model));
    if (m.usage) bits.push(fmt(m.usage.promptTokens) + ' + ' + fmt(m.usage.completionTokens) + ' tokens' + (m.usage.measured ? '' : ' (estimated)'));
    if (m.latencyMs) bits.push(Lab.ms(m.latencyMs));
    if (m.cost) bits.push('cost ' + esc(Lab.money(m.cost)));
    return bits.map(b => '<span>' + b + '</span>').join('');
  }

  function messageHTML(m, isLastAnswer) {
    const types = (Lab.state.models && Lab.state.models.notes && Lab.state.models.notes.taskTypes) || {};
    if (m.role === 'user') {
      return '<div class="lab-msg lab-msg-user" data-mid="' + esc(m.id) + '">' + esc(m.content) +
        '<div class="lab-msg-meta">' + (m.taskType && types[m.taskType] ? '<span class="badge badge-gray">' + esc(types[m.taskType].label) + '</span>' : '') + '<span>' + when(m.createdAt) + '</span><button type="button" data-del-msg="' + esc(m.id) + '">Delete</button></div></div>';
    }
    return '<div class="lab-msg lab-msg-assistant" data-mid="' + esc(m.id) + '">' + (m.content ? LabMarkdown.render(m.content) : '') +
      (m.error ? '<div class="lab-error" role="alert">' + esc(m.error.message) + '</div>' : '') +
      '<div class="lab-msg-meta">' + (m.stopped ? '<span class="badge badge-amber">stopped</span>' : '') + usageLine(m) +
        (m.content ? '<button type="button" data-copy-msg="' + esc(m.id) + '">Copy</button>' : '') + (m.context ? '<button type="button" data-ctx="' + esc(m.id) + '">What was sent</button>' : '') +
        (isLastAnswer ? '<button type="button" id="wb-regen">Regenerate</button>' : '') + '<button type="button" data-del-msg="' + esc(m.id) + '">Delete</button></div></div>';
  }

  function renderMessages() {
    const c = S.conv;
    const box = $('wb-msgs');
    if (!box) return;
    const lastAnswer = [...c.messages].reverse().find(m => m.role === 'assistant');
    const lastIsAnswer = c.messages.length && c.messages[c.messages.length - 1].role === 'assistant';
    box.innerHTML = (c.summary ? '<div class="lab-note">Older messages are summarised (' + fmt(c.summary.coversMessages) + ' messages, ' + when(c.summary.createdAt) + '); the summary is sent instead of the ones that no longer fit.</div>' : '') +
      (c.messages.length ? c.messages.map(m => messageHTML(m, lastIsAnswer && lastAnswer && m.id === lastAnswer.id)).join('') : '<p class="lab-muted">No messages yet. Answers are generated text: review code before you use it. Nothing here is run.</p>');
    LabMarkdown.enhance(box, compareWithFile);
    box.querySelectorAll('[data-del-msg]').forEach(b => { b.onclick = () => act(b, async () => { S.conv = (await del('/conversations/' + c.id + '/messages/' + b.dataset.delMsg)).conversation; renderMessages(); }); });
    box.querySelectorAll('[data-copy-msg]').forEach(b => { b.onclick = async () => {
      const m = c.messages.find(x => x.id === b.dataset.copyMsg);
      try { await navigator.clipboard.writeText(m.content); notify('Answer copied', 'success'); } catch (e) { notify('Couldn\'t copy (the browser refused clipboard access).', 'error'); }
    }; });
    box.querySelectorAll('[data-ctx]').forEach(b => { b.onclick = () => { const m = c.messages.find(x => x.id === b.dataset.ctx); S.report = Object.assign({ provider: m.provider, model: m.model }, m.context); renderContext(); }; });
    const regen = $('wb-regen');
    if (regen) regen.onclick = () => Lab.background(send(true));
    const scroll = $('wb-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  function setBusy(on) {
    const sendBtn = $('wb-send'), stop = $('wb-stop'), input = $('wb-input');
    if (sendBtn) sendBtn.disabled = on;
    if (stop) stop.hidden = !on;
    if (input) input.disabled = on;
    const regen = $('wb-regen');
    if (regen) regen.disabled = on;
  }

  // Sends the composer's message, or (regenerate) asks for a new answer to the last question
  async function send(regenerate) {
    const c = S.conv;
    if (!c || S.streaming) return;
    const input = $('wb-input');
    const content = regenerate ? '' : input.value.trim();
    if (!regenerate && !content) { input.focus(); return; }
    const options = { taskType: S.taskType || null, retrieval: { enabled: !!(S.retrieval.enabled && c.projectId), k: S.retrieval.k, docIds: S.retrieval.docIds } };
    if (regenerate) { while (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop(); }
    else c.messages.push({ id: 'pending', role: 'user', content, taskType: options.taskType, createdAt: new Date().toISOString() });
    renderMessages();
    // The answer appears as it streams
    const box = $('wb-msgs');
    const live = document.createElement('div');
    live.className = 'lab-msg lab-msg-assistant';
    live.innerHTML = '<div class="lab-muted">Waiting for the model…</div>';
    box.appendChild(live);
    $('wb-scroll').scrollTop = $('wb-scroll').scrollHeight;
    const ac = new AbortController();
    S.streaming = ac;
    setBusy(true);
    let text = '', finished = false, frame = 0;
    const paint = () => { frame = 0; live.innerHTML = LabMarkdown.render(text) + '<div class="lab-msg-meta"><span>Answering…</span></div>'; const s = $('wb-scroll'); if (s && s.scrollHeight - s.scrollTop - s.clientHeight < 160) s.scrollTop = s.scrollHeight; };
    try {
      await stream('/conversations/' + c.id + (regenerate ? '/regenerate' : '/messages'), regenerate ? options : Object.assign({ content }, options), {
        context: r => { S.report = r; renderContext(); },
        delta: d => { text += d.text; if (!frame) frame = requestAnimationFrame(paint); },
        error: () => { /* shown with the saved message from "done" */ },
        done: d => { finished = true; if (d && d.title) c.title = d.title; }
      }, ac.signal);
      if (!regenerate) input.value = '';
    } catch (e) {
      if (e.name !== 'AbortError') notify(e.message, 'error', 7000);
      else if (!regenerate) input.value = '';
    } finally {
      if (frame) cancelAnimationFrame(frame);
      S.streaming = null;
      setBusy(false);
    }
    // The saved conversation is the record (a stopped answer is saved by the server once the model request ends)
    await reload(finished ? 0 : 3);
    if ($('wb-title')) $('wb-title').textContent = S.conv.title;
    const item = document.querySelector('[data-conv="' + c.id + '"]');
    if (!item) Lab.route();
  }

  async function reload(retries) {
    const id = S.conv.id;
    for (let i = 0; ; i++) {
      try { S.conv = (await get('/conversations/' + id)).conversation; } catch (e) { notify(e.message, 'error'); return; }
      const last = S.conv.messages[S.conv.messages.length - 1];
      if (i >= retries || !last || last.role === 'assistant') break;
      await new Promise(r => setTimeout(r, 600));
    }
    renderMessages();
    renderContext();
  }

  /* ── Compare a code block with a file (in the browser only) ── */
  function compareWithFile(code) {
    openModal('Compare with your file', '<p class="lab-second">Choose the file this code would replace, or paste it. The comparison happens in your browser; nothing is uploaded, written or run.</p>' +
      '<div class="form-group"><label class="form-label" for="wb-df">File</label><input type="file" id="wb-df" class="form-input"></div>' +
      '<div class="form-group"><label class="form-label" for="wb-dt">…or paste the current text</label><textarea class="form-textarea" id="wb-dt" rows="6"></textarea></div><div id="wb-dres"></div>',
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Close</button><button class="btn btn-primary" id="wb-dgo">Compare</button>');
    $('wb-df').onchange = async e => { const f = e.target.files[0]; if (f) { try { $('wb-dt').value = await Lab.readText(f); } catch (err) { notify(err.message, 'error'); } } };
    $('wb-dgo').onclick = () => { $('wb-dres').innerHTML = LabDiff.html($('wb-dt').value, code.replace(/\n$/, '')); };
  }

  /* ── Context panel ───────────────────────── */
  function renderContext() {
    const box = $('wb-ctx');
    if (!box) return;
    const c = S.conv;
    if (!c) { box.innerHTML = '<header>Context</header><div class="lab-wb-scroll lab-ctx"><p class="lab-muted">Settings for a conversation appear here.</p></div>'; return; }
    const prof = S.profiles.find(x => x.id === c.profileId);
    const sel = c.provider + '|' + (c.model || '');
    const r = S.report || (() => { const m = [...c.messages].reverse().find(x => x.role === 'assistant' && x.context); return m ? Object.assign({ provider: m.provider, model: m.model }, m.context) : null; })();
    const docName = id => { const d = S.docs.find(x => x.id === id); return d ? d.name : id; };
    box.innerHTML = '<header>Context</header><div class="lab-wb-scroll lab-ctx">' +
      '<h4>Coding profile</h4><select class="form-select" id="wb-prof" aria-label="Coding profile"><option value="">None</option>' + S.profiles.map(x => '<option value="' + esc(x.id) + '"' + (x.id === c.profileId ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select>' +
      (prof ? '<select class="form-select mt-3" id="wb-pver" aria-label="Profile version"><option value="">Always the current version (v' + prof.currentVersion + ')</option>' +
        Array.from({ length: prof.versionCount }, (_, i) => prof.versionCount - i).map(v => '<option value="' + v + '"' + (c.profileVersion === v ? ' selected' : '') + '>Pinned to v' + v + (prof.candidates.includes(v) ? ' (candidate)' : '') + '</option>').join('') + '</select>' : '') +
      '<h4>Model</h4><select class="form-select" id="wb-model" aria-label="Model">' + (c.model ? '' : '<option value="' + esc(c.provider + '|') + '" selected>Provider default</option>') + Lab.modelOptions(sel) + '</select>' +
      '<h4>Project knowledge</h4>' + (c.projectId ? (S.docs.length ? '<label class="lab-muted">Passages per answer <select class="form-select" id="wb-k" style="width:auto">' + [3, 5, 8, 12].map(k => '<option' + (S.retrieval.k === k ? ' selected' : '') + '>' + k + '</option>').join('') + '</select></label>' +
          '<ul class="lab-ctx-docs mt-3">' + S.docs.map(d => '<li><label><input type="checkbox" data-doc="' + esc(d.id) + '"' + (!S.retrieval.docIds || S.retrieval.docIds.includes(d.id) ? ' checked' : '') + '> ' + esc(d.name) + '</label></li>').join('') + '</ul>'
        : '<p class="lab-muted">No ready documents. <a href="#knowledge">Add some</a>.</p>') : '<p class="lab-muted">This conversation has no project, so no knowledge base.</p>') +
      '<h4>What was sent' + (r ? '' : '') + '</h4>' + (r ? '<dl class="lab-kv"><dt>Model</dt><dd>' + esc((r.provider || '') + ' · ' + (r.model || '')) + '</dd>' +
          '<dt>Profile</dt><dd>' + (r.profile ? 'v' + r.profile.version : 'none') + '</dd><dt>Project instructions</dt><dd>' + (r.projectInstructions ? 'yes' : 'no') + '</dd>' +
          '<dt>Messages</dt><dd>' + fmt(r.messagesIncluded) + ' included' + (r.messagesLeftOut ? ', ' + fmt(r.messagesLeftOut) + ' left out' : '') + '</dd><dt>Summary</dt><dd>' + (r.summaryUsed ? 'used' : 'no') + '</dd>' +
          '<dt>Input</dt><dd>≈ ' + fmt(r.estimatedInputTokens) + ' of ' + fmt(r.budgetTokens) + ' tokens (estimate)</dd></dl>' +
          (r.documents && r.documents.length ? '<ul class="lab-ctx-docs mt-3">' + r.documents.map(d => '<li>' + esc(d.name || docName(d.docId)) + ' · chunk ' + (d.chunk + 1) + ' <span class="lab-muted">score ' + d.score + '</span></li>').join('') + '</ul>' : '<p class="lab-muted mt-3">No knowledge passages.</p>')
        : '<p class="lab-muted">Shown after the first answer.</p>') +
      '<h4>Long conversations</h4>' + (c.summary ? '<div class="lab-pre">' + esc(c.summary.text) + '</div>' : '<p class="lab-muted">Older messages that don\'t fit the model\'s context are left out. A summary keeps their gist.</p>') +
      '<button class="btn btn-secondary btn-sm mt-3" id="wb-sum"' + (c.messages.length < 8 ? ' disabled title="Needs more messages"' : '') + '>' + (c.summary ? 'Summarise again' : 'Summarise older messages') + '</button>' +
      '</div>';
    $('wb-prof').onchange = e => act(e.target, async () => { S.conv = (await patch('/conversations/' + c.id, { profileId: e.target.value || null })).conversation; renderContext(); });
    const pv = $('wb-pver');
    if (pv) pv.onchange = e => act(e.target, async () => { S.conv = (await patch('/conversations/' + c.id, { profileId: c.profileId, profileVersion: e.target.value ? Number(e.target.value) : null })).conversation; renderContext(); });
    $('wb-model').onchange = e => act(e.target, async () => { const [provider, model] = e.target.value.split('|'); S.conv = (await patch('/conversations/' + c.id, { provider, model: model || null })).conversation; renderContext(); });
    const k = $('wb-k');
    if (k) k.onchange = e => { S.retrieval.k = Number(e.target.value); };
    box.querySelectorAll('[data-doc]').forEach(cb => { cb.onchange = () => {
      const on = Array.from(box.querySelectorAll('[data-doc]')).filter(x => x.checked).map(x => x.dataset.doc);
      S.retrieval.docIds = on.length === S.docs.length ? null : on;
    }; });
    $('wb-sum').onclick = e => act(e.target, async () => {
      const r2 = await post('/conversations/' + c.id + '/summarize', { keepRecent: 6 });
      S.conv.summary = r2.summary;
      notify('Summary saved — it is sent in place of the older messages that don\'t fit.', 'success');
      renderContext(); renderMessages();
    });
  }
})();
