/* ══════════════════════════════════════════════
   lab-handoff.js — "Send to Codebook" from the AI Coding Lab

   The Lab page never writes this app's storage. When the user sends a
   coding rule to the Codebook (docs/ai-lab.md, spec §10), the Lab:
     1. creates a submission on the server (POST /api/lab/experiments/:id/codebook);
     2. posts { type:'apply-coding-rule', submissionId } on
        BroadcastChannel('metacode-lab'). An app tab answers
        { type:'coding-rule-ack', submissionId } at once and handles it;
        without an answer the Lab opens /app.html#codebook/lab/<submissionId>
        (Codebook.render passes that id to LabHandoff.open).
   This module then loads the submission (GET /api/lab/codebook-submissions/<id>),
   validates it (coding-rule.js) against the OPEN project's codebook and asks
   the user to confirm. Saving goes through App.setState({ codebook }), so
   localStorage, account sync, saved-project autosave and shared-project sync
   happen as for any codebook edit. The outcome goes back to the server
   (POST …/<id>/result) and to the Lab tab ({ type:'coding-rule-result', … }).

   The rule's code is shown as text only (escaped, in a <pre>): it is never
   run, here or anywhere in the app, and AI Coding doesn't use it.
   ══════════════════════════════════════════════ */

const LabHandoff = (() => {
  const CHANNEL = 'metacode-lab';
  const API = '/api/lab/codebook-submissions/';
  const ROOT_ID = 'lh-root';
  const esc = s => App.esc(s);

  let channel = null;
  let queue = Promise.resolve();       // one submission at a time
  const pending = new Set();           // submission ids this tab is handling (or about to)
  let titleBefore = null;

  /* ── The channel with the Lab tab ───────────── */
  function broadcast(msg) { try { if (channel) channel.postMessage(msg); } catch (e) { /* closed */ } }
  function listen() {
    if (channel || typeof BroadcastChannel !== 'function') return;
    try { channel = new BroadcastChannel(CHANNEL); } catch (e) { channel = null; return; }
    channel.onmessage = e => {
      const m = e && e.data;
      if (!m || typeof m !== 'object' || m.type !== 'apply-coding-rule' || !CodingRule.isSubmissionId(m.submissionId)) return;
      const go = () => open(m.submissionId, { via: 'channel' });
      // The app initialises at the end of the page: wait for it
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
    };
  }
  const ack = id => broadcast({ type: 'coding-rule-ack', submissionId: id });
  function focusTab() { try { window.focus(); } catch (e) { /* not allowed */ } }
  // A background tab can't always bring itself forward: its title says it is waiting
  function attention(on) {
    if (on && titleBefore === null) { titleBefore = document.title; document.title = 'Confirm coding rule · ' + titleBefore; }
    else if (!on && titleBefore !== null) { document.title = titleBefore; titleBefore = null; }
  }

  // Several app tabs may hear the Lab: the first one to take the lock handles it
  function withLock(id, fn) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks || typeof locks.request !== 'function') return Promise.resolve().then(() => fn(true));
    return locks.request('metacode-lab-handoff:' + id, { ifAvailable: true }, lock => fn(!!lock));
  }

  /**
   * Handles a submission: from the hash route (#codebook/lab/<id>) or the channel.
   * @param {string} id  cbs_… submission id
   * @param {{ via?: 'hash'|'channel'|'link' }} [opts]
   * @returns {Promise<boolean>} true when the rule is in the Codebook afterwards
   */
  function open(id, opts) {
    const via = (opts && opts.via) || 'link';
    id = String(id || '');
    if (!CodingRule.isSubmissionId(id)) {
      App.notify('This link doesn\'t point to a coding rule from the AI Coding Lab.', 'error', 6000);
      cleanHash();
      return Promise.resolve(false);
    }
    if (pending.has(id)) {            // already being handled here (a reload of the view, or the Lab sending again)
      if (via === 'channel') { ack(id); focusTab(); }
      return Promise.resolve(false);
    }
    pending.add(id);
    return withLock(id, held => {
      if (!held) {
        pending.delete(id);
        if (via !== 'channel') { App.notify('This coding rule is being confirmed in another MetaCode tab.', 'info', 6000); cleanHash(id); }
        return false;
      }
      if (via === 'channel') { ack(id); focusTab(); }
      return enqueue(id);
    }).catch(err => { pending.delete(id); console.error(err); return false; });
  }
  function enqueue(id) {
    const run = () => handle(id)
      .catch(err => { console.error(err); return false; })
      .finally(() => { pending.delete(id); cleanHash(id); });
    const p = queue.then(run);
    queue = p.then(() => {}, () => {});
    return p;
  }
  function cleanHash(id) {
    const h = location.hash;
    if (h.indexOf('#codebook/lab/') === 0 && (!id || h === '#codebook/lab/' + id)) history.replaceState(null, '', '#codebook');
  }

  /* ── The modal ──────────────────────────────── */
  const backdrop = () => document.getElementById('modal-backdrop');
  const modalOpen = () => backdrop().classList.contains('is-open');
  const ours = () => !!document.getElementById(ROOT_ID);
  function show(title, bodyHTML, footHTML) {
    App.openModal(title, '<div id="' + ROOT_ID + '" class="cr-handoff">' + bodyHTML + '</div>', footHTML);
  }
  function closeOurs() { if (ours()) App.closeModal(); }
  // Someone is typing in another dialog: wait until it's closed
  function whenModalFree() {
    if (!modalOpen() || ours()) return Promise.resolve();
    App.notify('A coding rule from the AI Coding Lab is waiting — close this dialog to review it.', 'info', 8000);
    return new Promise(resolve => {
      const obs = new MutationObserver(() => { if (!modalOpen()) { obs.disconnect(); resolve(); } });
      obs.observe(backdrop(), { attributes: true, attributeFilter: ['class'] });
    });
  }
  // Save / Cancel; closing the dialog any other way (✕, Escape, outside click, another dialog) is Cancel
  function decide() {
    return new Promise(resolve => {
      let done = false;
      const obs = new MutationObserver(() => { if (!modalOpen() || !ours()) finish('cancel'); });
      function finish(v) { if (done) return; done = true; obs.disconnect(); resolve(v); }
      obs.observe(backdrop(), { attributes: true, attributeFilter: ['class'] });
      obs.observe(document.getElementById('modal-body'), { childList: true });
      document.getElementById('lh-save').addEventListener('click', () => finish('save'));
      document.getElementById('lh-cancel').addEventListener('click', () => finish('cancel'));
    });
  }
  function showMessage(title, message, detail, extraHTML) {
    show(title,
      '<p class="cr-lead" id="lh-message">' + esc(message) + '</p>' +
      (detail ? '<p class="form-hint" id="lh-detail">' + esc(detail) + '</p>' : '') + (extraHTML || ''),
      '<button class="btn btn-primary" id="lh-close">Close</button>');
    document.getElementById('lh-close').addEventListener('click', () => App.closeModal());
  }

  /* ── Server ─────────────────────────────────── */
  function loadError(status, err) {
    const server = err && typeof err.message === 'string' ? err.message.slice(0, 400) : '';
    let title = 'Couldn\'t load the coding rule', message;
    if (status === 0) message = 'MetaCode\'s server couldn\'t be reached. Check your connection, then send the rule again from the AI Coding Lab.';
    else if (status === 401) { title = 'Sign in to save this coding rule'; message = 'Sign in to MetaCode with the account you use in the AI Coding Lab, then send the rule again.'; }
    else if (status === 402) { title = 'The AI Coding Lab needs the Ultra plan'; message = 'Coding rules come from the AI Coding Lab, which is part of the Ultra plan. With the plan this account has now, MetaCode can\'t load this one.'; }
    else if (status === 403) message = server || 'This browser isn\'t allowed to load that coding rule.';
    else if (status === 404) message = 'This coding rule wasn\'t found. It may have been sent from another account, or its experiment was deleted.';
    else if (status === 503) message = server || 'The AI Coding Lab is turned off on this server.';
    else if (status === -1) message = 'The AI Coding Lab sent an answer MetaCode doesn\'t understand.';
    else message = 'The AI Coding Lab answered with an error (HTTP ' + status + ').';
    const e = new Error(message);
    e.title = title; e.status = status; e.detail = server && server !== message ? server : '';
    return e;
  }
  async function fetchSubmission(id) {
    let res;
    try { res = await fetch(API + id, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }); }
    catch (e) { throw loadError(0, null); }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) throw loadError(res.status, body && body.error);
    if (!body || typeof body !== 'object' || !body.submission || typeof body.submission !== 'object') throw loadError(-1, null);
    return body;
  }
  // Tells the server (when asked) and then the Lab tab how it ended
  async function report(id, ok, info) {
    const error = ok ? null : String(info.error || 'Not saved in MetaCode').slice(0, 500);
    if (info.post !== false) {
      const body = ok ? { status: 'applied', dimensionId: info.dimensionId } : { status: 'failed', error };
      try {
        const res = await fetch(API + id + '/result', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok && ok) App.notify('Saved in the Codebook, but the AI Coding Lab couldn\'t be told (HTTP ' + res.status + '). It shows the result when you send again.', 'warning', 8000);
      } catch (e) {
        if (ok) App.notify('Saved in the Codebook, but the AI Coding Lab couldn\'t be reached to be told.', 'warning', 8000);
      }
    }
    broadcast(ok ? { type: 'coding-rule-result', submissionId: id, ok: true, dimensionId: info.dimensionId }
                 : { type: 'coding-rule-result', submissionId: id, ok: false, error });
  }

  /* ── Guards ─────────────────────────────────── */
  const collabOn = () => typeof Collab !== 'undefined' && Collab.active();
  const viewerOnly = () => collabOn() && !Collab.canEdit();
  const codebookConflict = () => collabOn() && (((Collab.link() || {}).conflicts) || []).some(c => c && c.key === 'codebook');
  const CONFLICT_ERROR = 'The shared project\'s Codebook has a conflict to resolve in MetaCode first. Resolve it, then send again.';
  function showConflict(id) {
    showMessage('Resolve the Codebook conflict first',
      'In this shared project the Codebook changed here and for someone else at the same time. Choose which version to keep (the “to resolve” button in the shared-project bar), then send the coding rule again from the AI Coding Lab.');
    return report(id, false, { error: CONFLICT_ERROR });
  }

  /* ── One submission ─────────────────────────── */
  function variableName(data, dimensionId) {
    const cands = [data && data.variable, data && data.experiment && data.experiment.variable, data && data.submission && data.submission.variable];
    for (const v of cands) if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim() && (!v.id || v.id === dimensionId)) return v.name.trim().slice(0, 120);
    return '';
  }
  function rerender(dimId) {
    if (App.getCurrentView().id !== 'codebook') return;
    Codebook.render();
    const card = document.getElementById('dim-' + dimId);
    if (card) { card.classList.add('cr-flash'); try { card.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old browser */ } }
  }
  function fileName(lang) { return 'rule.' + (lang === 'python' ? 'py' : lang === 'typescript' ? 'ts' : 'js'); }
  const openProjectName = () => App.getState().project.name || 'Untitled Project';

  // Where the rule was measured: the Lab's variable, its sandbox, and the project the sandbox's
  // records came from when the Lab says so (sandbox.source.projectName, in the payload or the answer)
  function sourceOf(data, payload) {
    const t = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : '');
    const inVar = payload.contract && payload.contract.input && payload.contract.input.variable;
    let project = '';
    for (const sb of [payload.sandbox, data && data.sandbox]) {
      const src = sb && typeof sb === 'object' && sb.source && typeof sb.source === 'object' ? sb.source : null;
      if (!project && src && src.kind !== 'dataset') project = t(src.projectName, 200);
    }
    return {
      variable: variableName(data, payload.dimensionId) || t(inVar && typeof inVar === 'object' ? inVar.name : '', 120),
      sandbox: t(payload.sandbox && payload.sandbox.name, 200),
      project
    };
  }
  /** "the variable “Policy Stance” from the project “A” (sandbox “A · Policy Stance”)" */
  function sourceText(src) {
    const where = src.project ? 'the project “' + src.project + '”' + (src.sandbox ? ' (sandbox “' + src.sandbox + '”)' : '') : src.sandbox ? 'the sandbox “' + src.sandbox + '”' : 'the AI Coding Lab';
    return (src.variable ? 'the variable “' + src.variable + '” from ' : '') + where;
  }
  const upperFirst = s => s.charAt(0).toUpperCase() + s.slice(1);

  function confirmBody(rule, dim, viewer, src) {
    const change = CodingRule.changeSummary(dim, rule);
    const ev = rule.evaluation;
    const review = { approved: 'approved', needs_review: 'asked for a human check — you allowed the run after reading it', unavailable: 'unavailable — you allowed the run after reading the warning' }[rule.security.review] || '';
    const ran = ev.split === 'test' ? ev.records + ' held-out records' : ev.split === 'dev' ? ev.records + ' dev records' : 'all ' + ev.records + ' records';
    const dimName = dim.name || dim.id;
    const project = openProjectName();
    const codes = CodingRule.compareCodes(rule, dim);
    return '' +
      '<p class="cr-lead">The AI Coding Lab sent a coding rule for the variable <b>' + esc(dimName) + '</b>. Check it, then save it to the Codebook.</p>' +
      (viewer ? '<div class="cr-warn" id="lh-viewer">You can view this shared project but not edit it, so the rule is saved in this browser only — it won\'t reach the shared project.</div>' : '') +
      (src.project && src.project !== project ? '<div class="cr-warn" id="lh-other-project">This rule was measured on posts from the project “' + esc(src.project) + '”, not the open project “' + esc(project) + '”. Its results are for those posts.</div>' : '') +
      (codes && codes.notInRule.length ? '<div class="cr-warn" id="lh-codes">“' + esc(dimName) + '” has codes this rule never returns: ' + esc(CodingRule.codeList(codes.notInRule)) +
        '. The rule was measured with the codes ' + esc(CodingRule.codeList(codes.rule)) + ', so its results say nothing about ' + esc(CodingRule.codeList(codes.notInRule)) + '. You can still save it.</div>' : '') +
      '<dl class="cr-facts">' +
        '<dt>Saving into</dt><dd id="lh-target">' + esc(dimName) + ' <code>' + esc(dim.id) + '</code> in “' + esc(project) + '” (the open project)</dd>' +
        '<dt>Measured on</dt><dd id="lh-source">' + esc(upperFirst(sourceText(src))) + '</dd>' +
        (codes ? '<dt>Codes</dt><dd id="lh-rule-codes">' + esc(CodingRule.codeList(codes.rule)) + '</dd>' : '') +
        '<dt>Version</dt><dd id="lh-version">v' + esc(String(rule.version)) + ' of “' + esc(rule.experiment.name) + '”</dd>' +
        '<dt>Language</dt><dd id="lh-language">' + esc(CodingRule.languageLabel(rule.language)) + '</dd>' +
        '<dt>Sandbox</dt><dd>' + esc(rule.sandbox.name || 'Sandbox') + ' · data v' + esc(String(rule.sandbox.version)) + ' · run on ' + esc(ran) + '</dd>' +
        '<dt>Security</dt><dd>Policy checks passed · AI review ' + esc(review) + '</dd>' +
        '<dt>What changes</dt><dd id="lh-change" class="cr-change cr-change-' + esc(change.kind) + '">' + esc(change.text) + '</dd>' +
      '</dl>' +
      '<div class="cr-label">Measured in the sandbox</div>' +
      Codebook.ruleMetricsHTML(rule, false) +
      '<p class="cr-note">Experimental: MetaCode keeps the rule with the variable for reference. It never runs the code, and AI Coding doesn\'t use it.</p>' +
      (rule.rationale ? '<div class="cr-label">Why this version</div><div class="cr-text" id="lh-rationale">' + esc(rule.rationale) + '</div>' : '') +
      '<div class="cr-label">Code <span>' + esc(fileName(rule.language)) + ' · ' + esc(CodingRule.formatBytes(CodingRule.utf8Bytes(rule.code))) + '</span></div>' +
      '<pre class="cr-code" id="lh-code" tabindex="0">' + esc(rule.code) + '</pre>';
  }

  // Signing in on a fresh tab can ask "Add this browser's work to your account?"
  // (cloud-sync.js) just as this tab opens. That answer decides which project stays
  // open, so it comes first: the rule is then checked against, and saved into, the
  // project that is open afterwards, and the two dialogs never stack.
  function accountSettled() {
    return typeof CloudSync !== 'undefined' && typeof CloudSync.settled === 'function' ? CloudSync.settled().catch(() => {}) : Promise.resolve();
  }

  async function handle(id) {
    attention(true);
    try {
      await accountSettled();
      await whenModalFree();
      show('Coding rule from the AI Coding Lab', '<p class="cr-lead" id="lh-loading">Loading the coding rule…</p>',
        '<button class="btn btn-secondary" id="lh-close">Close</button>');
      document.getElementById('lh-close').addEventListener('click', () => App.closeModal());

      let data;
      try { data = await fetchSubmission(id); }
      catch (err) {
        await whenModalFree();
        showMessage(err.title || 'Couldn\'t load the coding rule', err.message, err.detail);
        await report(id, false, { error: err.message, post: false });   // the server refused us: nothing to record there
        return false;
      }

      await whenModalFree();
      const sub = data.submission;
      const payload = sub.payload;
      if (sub.id !== id || !payload || typeof payload !== 'object' || payload.submissionId !== id) {
        showMessage('This coding rule can\'t be saved', 'The AI Coding Lab sent a coding rule that doesn\'t match this link. Send it again from the Lab.');
        await report(id, false, { error: 'The submission didn\'t match its id.' });
        return false;
      }

      const v = CodingRule.validateCodingRule(payload, App.getState().codebook);
      const src = sourceOf(data, payload);
      const dimId = payload.dimensionId;
      // Already there (the Lab sending it again): nothing to change — also when the variable's codes
      // changed since it was saved (its panel marks that)
      if (v.dimension && v.dimension.codingRule && v.dimension.codingRule.submissionId === id && (v.ok || v.codesMismatch)) {
        closeOurs();
        rerender(dimId);
        App.notify('This coding rule is already in the Codebook (“' + (v.dimension.name || dimId) + '”).', 'info', 5000);
        await report(id, true, { dimensionId: dimId });
        return true;
      }
      if (v.missingDimension) {
        const name = variableName(data, payload.dimensionId);
        const exp = payload.experiment && typeof payload.experiment.name === 'string' ? payload.experiment.name : '';
        const sbx = payload.sandbox && typeof payload.sandbox.name === 'string' ? payload.sandbox.name : '';
        showMessage('This variable isn\'t in the open project',
          'This rule is for the variable ' + (name ? '“' + name + '” (id ' + payload.dimensionId + ')' : 'with the id “' + payload.dimensionId + '”') +
          ', and the open project “' + (App.getState().project.name || 'Untitled Project') + '” doesn\'t have it. Open the project that has it, then send again.',
          (exp ? 'From the experiment “' + exp + '”' : '') + (sbx ? (exp ? ', sandbox “' : 'From the sandbox “') + sbx + '”' : '') + (exp || sbx ? '.' : ''));
        await report(id, false, { error: 'The open MetaCode project has no variable with the id “' + payload.dimensionId + '”. Open the project that has it, then send again.' });
        return false;
      }
      // The variable has the id but not every code the rule can return (another project's variable
      // with the same name, or codes renamed since): saving would attach results for other codes
      if (v.codesMismatch) {
        const c = v.codes;
        showMessage('The variable\'s codes don\'t match this rule',
          'This rule can return ' + CodingRule.codeList(c.notInDimension) + ', which the variable “' + (v.dimension.name || dimId) + '” (' + dimId + ') in the open project “' + openProjectName() + '” doesn\'t have. ' +
          'The rule\'s codes: ' + CodingRule.codeList(c.rule) + '; the variable\'s codes: ' + CodingRule.codeList(c.dimension) + '.',
          'Measured on ' + sourceText(src) + '. Add the missing codes to the variable, or open the project the rule was made for, then send again.');
        await report(id, false, { error: v.problems[0] + ' Add the missing codes or open the project the rule was made for, then send again.' });
        return false;
      }
      if (!v.ok) {
        showMessage('This coding rule can\'t be saved', 'MetaCode checked the rule the AI Coding Lab sent and found problems:', '',
          '<ul class="cr-problems" id="lh-problems">' + v.problems.slice(0, 12).map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>');
        await report(id, false, { error: 'The coding rule isn\'t valid: ' + v.problems.slice(0, 3).join(' ') });
        return false;
      }

      if (codebookConflict()) { await showConflict(id); return false; }

      show('Save coding rule to the Codebook', confirmBody(v.rule, v.dimension, viewerOnly(), src),
        '<button class="btn btn-secondary" id="lh-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="lh-save">Save to Codebook</button>');
      focusTab();
      const choice = await decide();
      if (choice !== 'save') {
        closeOurs();
        App.notify('The coding rule wasn\'t saved.', 'info');
        await report(id, false, { error: 'Cancelled in MetaCode' });
        return false;
      }

      // Save, against the codebook as it is now (it may have changed while the dialog was open)
      if (codebookConflict()) { await showConflict(id); return false; }
      let r;
      try { r = CodingRule.applyCodingRule(App.getState().codebook, payload, new Date()); }
      catch (err) {
        showMessage('This coding rule can\'t be saved', err.missingDimension ? 'The variable was deleted while this dialog was open.' : err.codesMismatch ? 'The variable\'s codes changed while this dialog was open. ' + err.problems[0] : err.message);
        await report(id, false, { error: err.missingDimension ? 'The variable was deleted in MetaCode before saving.' : err.codesMismatch ? 'The variable\'s codes changed in MetaCode before saving. ' + err.problems[0] : err.message });
        return false;
      }
      if (r.changed) App.setState({ codebook: r.codebook });
      closeOurs();
      rerender(dimId);
      App.notify('Saved to the Codebook: “' + (v.dimension.name || dimId) + '” has coding rule v' + v.rule.version + '.' + (viewerOnly() ? ' (In this browser only.)' : ''), 'success', 5000);
      await report(id, true, { dimensionId: dimId });
      return true;
    } finally {
      attention(false);
    }
  }

  listen();
  return { open };
})();
