/* ══════════════════════════════════════════════
   codebook.js — Coding dimensions & code management
   ══════════════════════════════════════════════ */

const Codebook = (() => {

  // Ids inside inline handlers: a plain id (letters, digits, _ and -) is written into the
  // handler (escaped as well); any other id goes through a data attribute, never into JavaScript.
  const SAFE_ID = /^[a-z0-9_-]+$/i;
  function act(fn, ...ids) {
    if (ids.every(id => typeof id === 'string' && SAFE_ID.test(id))) return `onclick="Codebook.${fn}(${ids.map(id => `'${App.esc(id)}'`).join(',')})"`;
    return `onclick="Codebook.${fn}(${ids.map((_, i) => `this.dataset.cbArg${i}`).join(',')})" ${ids.map((id, i) => `data-cb-arg${i}="${App.esc(String(id))}"`).join(' ')}`;
  }

  // param: the route after "#codebook/" — "lab/<submissionId>" is a coding rule sent from the AI Coding Lab (lab-handoff.js)
  function render(param) {
    const container = document.getElementById('view-container');
    const { codebook } = App.getState();

    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Codebook</div>
          <div class="view-subtitle">Define your coding dimensions and the codes within each dimension</div>
        </div>
        <div class="view-actions">
          <button class="btn btn-secondary" onclick="Codebook.importModal()">Import CSV</button>
          <button class="btn btn-primary" onclick="Codebook.addDimension()">+ Add Dimension</button>
        </div>
      </div>

      ${codebook.length === 0 ? emptyState() : `
        <div class="codebook-list" id="codebook-list">
          ${codebook.map(dim => dimensionCard(dim)).join('')}
        </div>
      `}
    `;
    const m = /^lab\/(.+)$/.exec(String(param || ''));
    if (m && typeof LabHandoff !== 'undefined') LabHandoff.open(m[1], { via: 'hash' });
  }

  function emptyState() {
    return `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </div>
        <div class="empty-title">No coding dimensions yet</div>
        <div class="empty-sub">Create your first dimension to define what properties you want to code. For example: "Sentiment", "Topic", "Stance", or "Incivility".</div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
          <button class="btn btn-primary" onclick="Codebook.addDimension()">+ Add Dimension</button>
          <button class="btn btn-secondary" onclick="Codebook.loadExample()">Load example codebook</button>
        </div>
      </div>`;
  }

  function dimensionCard(dim) {
    const improve = typeof CodingRule !== 'undefined' ? CodingRule.improveUrl(dim.id) : null;
    return `
      <div class="dim-card" id="dim-${App.esc(dim.id)}">
        <div class="dim-head">
          <div style="flex:1">
            <div class="dim-name">${App.esc(dim.name)}</div>
            <div class="dim-desc">${App.esc(dim.description || 'No description')}</div>
          </div>
          <div class="dim-actions">
            ${improve ? `<a class="btn btn-ghost btn-sm cr-improve" href="${App.esc(improve)}" title="Write and test a coding rule for this variable in the AI Coding Lab (Ultra)">Improve in AI Coding Lab</a>` : ''}
            <button class="btn btn-ghost btn-sm" ${act('addCode', dim.id)}>+ Code</button>
            <button class="btn btn-ghost btn-sm" ${act('editDimension', dim.id)}>Edit</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--error)" ${act('deleteDimension', dim.id)}>Delete</button>
          </div>
        </div>
        <div class="dim-codes" id="codes-${App.esc(dim.id)}">
          ${dim.codes.length === 0
            ? `<span style="font-size:12.5px;color:var(--tx-muted)">No codes yet — click "+ Code" to add one</span>`
            : dim.codes.map(c => codeChip(dim.id, c)).join('')
          }
        </div>
        ${rulePanel(dim)}
      </div>`;
  }

  /* ── Coding rule (from the AI Coding Lab; coding-rule.js) ── */
  // The measured results of a rule; compact = the panel's short list
  function ruleMetricsHTML(rule, compact) {
    if (typeof CodingRule === 'undefined') return '';
    let items = CodingRule.metricItems(rule);
    if (compact) {
      items = items.filter(m => ['accuracy', 'macroF1', 'coverage', 'baselineAgreement'].includes(m.key));
      // Without reference labels, one line says so instead of two
      if (!items[0].measured && !items[1].measured) items = [{ key: 'reference', label: 'Accuracy', text: 'not measured — no reference labels', measured: false, n: null }].concat(items.slice(2));
    }
    return `<ul class="cr-metrics${compact ? ' cr-metrics-compact' : ''}">${items.map(m => m.measured
      ? `<li class="cr-metric" data-metric="${App.esc(m.key)}"><span class="cr-metric-v">${App.esc(m.text)}</span> <span class="cr-metric-l">${App.esc(m.label)}</span>${m.n !== null ? ` <span class="cr-n">n = ${App.esc(String(m.n))}</span>` : ''}</li>`
      : `<li class="cr-metric cr-muted" data-metric="${App.esc(m.key)}"><span class="cr-metric-l">${App.esc(m.label)}</span> <span class="cr-metric-v">${App.esc(m.text)}</span></li>`).join('')}</ul>`;
  }

  // The variable's codes changed since the rule was tested (a CSV import, a deleted or added code):
  // a warning when the rule can return codes the variable no longer has, a note when it never returns some
  function ruleDriftHTML(dim) {
    const d = CodingRule.codeDrift(dim);
    if (!d || (!d.notInDimension.length && !d.notInRule.length)) return '';
    const never = d.notInRule.length ? `It never returns ${CodingRule.codeList(d.notInRule)}.` : '';
    return d.notInDimension.length
      ? `<div class="cr-warn cr-drift" role="note">Codes changed since this rule was tested: it can return ${App.esc(CodingRule.codeList(d.notInDimension))}, which “${App.esc(dim.name || dim.id)}” no longer has. ${App.esc(never)} Its measured results are for its own codes.</div>`
      : `<div class="cr-drift cr-drift-note" role="note">Codes changed since this rule was tested: ${App.esc(never.replace(/^It/, 'it'))}</div>`;
  }

  function rulePanel(dim) {
    const rule = dim.codingRule;
    if (!rule || typeof rule !== 'object' || typeof CodingRule === 'undefined') return '';
    const exp = rule.experiment && typeof rule.experiment === 'object' ? rule.experiment : {};
    const url = CodingRule.experimentUrl(rule);
    const sent = CodingRule.formatDate(rule.sentAt);
    const history = Array.isArray(dim.codingRuleHistory) ? dim.codingRuleHistory.filter(h => h && typeof h === 'object') : [];
    return `
      <div class="cr-panel" data-dim="${App.esc(dim.id)}">
        <div class="cr-head">${App.esc(CodingRule.headline(rule))}</div>
        ${ruleDriftHTML(dim)}
        ${ruleMetricsHTML(rule, true)}
        <div class="cr-foot">
          <span class="cr-sent">${sent ? 'Sent ' + App.esc(sent) : 'Sent'}${typeof exp.name === 'string' && exp.name ? ' from “' + App.esc(exp.name) + '”' : ''}</span>
          <span class="cr-buttons">
            <button class="btn btn-ghost btn-sm cr-view" ${act('viewRule', dim.id)}>View code</button>
            ${url ? `<a class="btn btn-ghost btn-sm cr-open" href="${App.esc(url)}">Open experiment</a>` : ''}
            <button class="btn btn-ghost btn-sm cr-remove" style="color:var(--error)" ${act('removeRule', dim.id)}>Remove rule</button>
          </span>
        </div>
        ${history.length ? `<details class="cr-history"><summary>History (${history.length} earlier version${history.length === 1 ? '' : 's'})</summary>
          <ol>${history.map(h => `<li>${App.esc(CodingRule.historyLine(h))}</li>`).join('')}</ol></details>` : ''}
      </div>`;
  }

  function viewRule(dimId) {
    const dim = App.getState().codebook.find(d => d.id === dimId);
    const rule = dim && dim.codingRule;
    if (!rule || typeof rule !== 'object' || typeof CodingRule === 'undefined') return;
    const str = v => (typeof v === 'string' ? v : '');
    const exp = rule.experiment && typeof rule.experiment === 'object' ? rule.experiment : {};
    const sbx = rule.sandbox && typeof rule.sandbox === 'object' ? rule.sandbox : {};
    const sec = rule.security && typeof rule.security === 'object' ? rule.security : {};
    const ev = rule.evaluation && typeof rule.evaluation === 'object' ? rule.evaluation : {};
    const prompts = rule.prompts && typeof rule.prompts === 'object' ? rule.prompts : {};
    const url = CodingRule.experimentUrl(rule);
    const code = str(rule.code);
    const history = Array.isArray(dim.codingRuleHistory) ? dim.codingRuleHistory.filter(h => h && typeof h === 'object') : [];
    const row = (k, v) => v ? `<dt>${App.esc(k)}</dt><dd>${App.esc(v)}</dd>` : '';
    const short = h => (typeof h === 'string' ? h.replace(/^sha256:/, '').slice(0, 12) : '');
    App.openModal('Coding rule — ' + (dim.name || dim.id), `
      <div class="cr-view-modal" id="cr-view">
        <p class="cr-lead">${App.esc(CodingRule.headline(rule))}</p>
        <p class="cr-note">MetaCode keeps this rule with the variable for reference. It never runs the code, and AI Coding doesn't use it.</p>
        ${ruleDriftHTML(dim)}
        <dl class="cr-facts">
          ${row('Experiment', str(exp.name))}
          ${row('Codes', (CodingRule.ruleCodes(rule) || []).join(', '))}
          ${row('Version', Number.isInteger(rule.version) ? 'v' + rule.version : '')}
          ${row('Language', CodingRule.languageLabel(rule.language))}
          ${row('Code hash', short(rule.codeHash))}
          ${row('Sandbox', [str(sbx.name), Number.isInteger(sbx.version) ? 'data v' + sbx.version : '', short(sbx.sha256)].filter(Boolean).join(' · '))}
          ${row('Run', [Number.isInteger(ev.records) ? ev.records + ' records' : '', ev.split === 'test' ? 'held-out split' : ev.split ? str(ev.split) + ' split' : '', CodingRule.formatDate(ev.finishedAt)].filter(Boolean).join(' · '))}
          ${row('Security', sec.policy === 'passed' ? 'Policy checks passed · AI review: ' + str(sec.review).replace('_', ' ') : '')}
          ${row('AI recommendation', str(ev.recommendation))}
          ${row('Selected', CodingRule.formatDate(rule.selectedAt))}
          ${row('Sent', CodingRule.formatDate(rule.sentAt))}
          ${row('Saved here', CodingRule.formatDate(rule.appliedAt))}
        </dl>
        <div class="cr-label">Measured in the sandbox</div>
        ${ruleMetricsHTML(rule, false)}
        ${str(rule.rationale) ? `<div class="cr-label">Why this version</div><div class="cr-text">${App.esc(rule.rationale)}</div>` : ''}
        ${str(prompts.original) || str(prompts.final) ? `<details class="cr-prompts"><summary>Prompts</summary>
          ${str(prompts.original) ? `<div class="cr-label">First prompt</div><div class="cr-text">${App.esc(prompts.original)}</div>` : ''}
          ${str(prompts.final) ? `<div class="cr-label">Last prompt</div><div class="cr-text">${App.esc(prompts.final)}</div>` : ''}</details>` : ''}
        <div class="cr-label">Code <span>${App.esc(CodingRule.formatBytes(CodingRule.utf8Bytes(code)))}</span></div>
        <pre class="cr-code" id="cr-view-code" tabindex="0">${App.esc(code)}</pre>
        ${history.length ? `<div class="cr-label">History</div><ol class="cr-history-list">${history.map(h => `<li>${App.esc(CodingRule.historyLine(h))}
          ${typeof h.code === 'string' && h.code ? `<details><summary>Code</summary><pre class="cr-code" tabindex="0">${App.esc(h.code)}</pre></details>` : '<span class="form-hint"> · code not kept</span>'}</li>`).join('')}</ol>` : ''}
      </div>
    `, `
      ${url ? `<a class="btn btn-secondary" href="${App.esc(url)}">Open experiment</a>` : ''}
      <button class="btn btn-primary" onclick="App.closeModal()">Close</button>
    `);
  }

  function removeRule(dimId) {
    const dim = App.getState().codebook.find(d => d.id === dimId);
    if (!dim || !dim.codingRule) return;
    const n = Array.isArray(dim.codingRuleHistory) ? dim.codingRuleHistory.length : 0;
    const v = Number.isInteger(dim.codingRule.version) ? 'v' + dim.codingRule.version : 'the coding rule';
    App.openModal('Remove the coding rule?', `
      <div class="cr-view-modal" id="cr-remove">
        <p class="cr-lead">This removes ${App.esc(v)}${n ? ` and its history (${n} earlier version${n === 1 ? '' : 's'})` : ''} from “${App.esc(dim.name || dim.id)}”. The codes, coding results and AI Coding don't change.</p>
        <p class="form-hint">The experiment stays in the AI Coding Lab, so you can send it to the Codebook again.</p>
      </div>
    `, `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-danger" id="cr-remove-confirm" ${act('confirmRemoveRule', dimId)}>Remove rule</button>
    `);
  }

  function confirmRemoveRule(dimId) {
    const r = CodingRule.removeCodingRule(App.getState().codebook, dimId);
    if (r.changed) App.setState({ codebook: r.codebook });
    App.closeModal();
    if (r.changed) App.notify('Coding rule removed', 'warning');
    render();
  }

  function codeChip(dimId, code) {
    const tooltipParts = [];
    if (code.description) tooltipParts.push(code.description);
    if (code.aiNotes) tooltipParts.push('AI fine-tuning notes: ' + code.aiNotes);
    const tooltip = tooltipParts.join(' — ');
    const aiDot = code.aiNotes
      ? `<span title="Has AI fine-tuning notes" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--violet);margin-left:5px;vertical-align:middle"></span>`
      : '';
    return `
      <div class="dim-code" title="${App.esc(tooltip)}" style="cursor:default">
        <span class="code-id">${App.esc(code.id)}</span>
        ${App.esc(code.label)}${aiDot}
        <button ${act('editCode', dimId, code.id)}
          style="background:none;border:none;cursor:pointer;margin-left:4px;color:var(--tx-muted);font-size:11px" title="Edit">✎</button>
        <button ${act('deleteCode', dimId, code.id)}
          style="background:none;border:none;cursor:pointer;color:var(--tx-muted);font-size:11px" title="Remove">✕</button>
      </div>`;
  }

  /* ── Dimension CRUD ──────────────────────────*/
  function addDimension() {
    App.openModal('Add Coding Dimension', `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="form-group">
          <label class="form-label">Dimension Name</label>
          <input class="form-input" id="dim-name" placeholder="e.g., Sentiment, Topic, Stance, Incivility" autofocus>
        </div>
        <div class="form-group">
          <label class="form-label">Description <span>(optional)</span></label>
          <textarea class="form-textarea" id="dim-desc" placeholder="Explain what this dimension measures and how coders should apply it…" style="min-height:70px"></textarea>
        </div>
      </div>
    `, `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="Codebook.saveDimension()">Add Dimension</button>
    `);
    setTimeout(() => document.getElementById('dim-name')?.focus(), 100);
  }

  function saveDimension(editId=null) {
    const name = document.getElementById('dim-name')?.value.trim();
    const desc = document.getElementById('dim-desc')?.value.trim();
    if (!name) { App.notify('Dimension name is required', 'error'); return; }

    const state = App.getState();
    let codebook = [...state.codebook];

    if (editId) {
      codebook = codebook.map(d => d.id === editId ? { ...d, name, description: desc } : d);
      App.notify('Dimension updated', 'success');
    } else {
      const id = App.slugify(name) || App.genId();
      const safeId = codebook.some(d=>d.id===id) ? id+'_'+Date.now().toString(36).slice(-3) : id;
      codebook.push({ id: safeId, name, description: desc||'', codes: [] });
      App.notify('Dimension added', 'success');
    }

    App.setState({ codebook });
    App.closeModal();
    render();
  }

  function editDimension(dimId) {
    const dim = App.getState().codebook.find(d=>d.id===dimId);
    if (!dim) return;
    App.openModal('Edit Dimension', `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="form-group">
          <label class="form-label">Dimension Name</label>
          <input class="form-input" id="dim-name" value="${App.esc(dim.name)}" autofocus>
        </div>
        <div class="form-group">
          <label class="form-label">Description <span>(optional)</span></label>
          <textarea class="form-textarea" id="dim-desc" style="min-height:70px">${App.esc(dim.description||'')}</textarea>
        </div>
      </div>
    `, `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" ${act('saveDimension', dimId)}>Save Changes</button>
    `);
  }

  function deleteDimension(dimId) {
    const dim = App.getState().codebook.find(d=>d.id===dimId);
    if (!confirm(`Delete dimension "${dim?.name}"? This removes all associated codes and coding results.`)) return;

    const codebook = App.getState().codebook.filter(d=>d.id!==dimId);
    // Remove this dimension from all posts
    const posts = App.getState().posts.map(p => {
      const aiCodes    = {...p.aiCodes};    delete aiCodes[dimId];
      const humanCodes = {...p.humanCodes}; delete humanCodes[dimId];
      const coder2Codes = {...p.coder2Codes}; delete coder2Codes[dimId];
      const adjudicated = {...p.adjudicated}; delete adjudicated[dimId];
      return { ...p, aiCodes, humanCodes, coder2Codes, adjudicated };
    });
    App.setState({ codebook, posts });
    App.notify('Dimension deleted', 'warning');
    render();
  }

  /* ── Code CRUD ───────────────────────────────*/
  function addCode(dimId) {
    const dim = App.getState().codebook.find(d=>d.id===dimId);
    if (!dim) return;
    App.openModal(`Add Code to "${dim.name}"`, codeFormHTML(), `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" ${act('saveCode', dimId)}>Add Code</button>
    `);
    setTimeout(() => document.getElementById('code-id')?.focus(), 100);
  }

  function editCode(dimId, codeId) {
    const dim  = App.getState().codebook.find(d=>d.id===dimId);
    const code = dim?.codes.find(c=>c.id===codeId);
    if (!code) return;
    App.openModal(`Edit Code in "${dim.name}"`, codeFormHTML(code), `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" ${act('saveCode', dimId, codeId)}>Save Changes</button>
    `);
  }

  function codeFormHTML(code=null) {
    return `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Code ID <span>(short unique key)</span></label>
          <input class="form-input" id="code-id" value="${App.esc(code?.id||'')}"
            placeholder="e.g., pos, neg, neutral or 1, 2, 3" style="font-family:var(--f-mono)"
            ${code?'readonly':''}>
          <div class="form-hint">Short identifier used in exports. Cannot be changed after creation.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Label</label>
          <input class="form-input" id="code-label" value="${App.esc(code?.label||'')}"
            placeholder="e.g., Positive, Negative, Neutral">
        </div>
        <div class="form-group">
          <label class="form-label">Description <span>(optional — shown to coders)</span></label>
          <textarea class="form-textarea" id="code-desc" style="min-height:70px"
            placeholder="When to apply this code: specific examples, inclusion/exclusion criteria…">${App.esc(code?.description||'')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:6px">
            AI Fine-Tuning Notes <span>(optional)</span>
            <span class="badge badge-violet" style="font-size:10px">AI reads this</span>
          </label>
          <textarea class="form-textarea" id="code-ai-notes" style="min-height:70px"
            placeholder="Extra guidance just for the AI: edge cases, examples, common mistakes to correct, how to tell this code apart from a similar one…">${App.esc(code?.aiNotes||'')}</textarea>
          <div class="form-hint">Included in the AI's instructions during Auto-Coding — use this to correct recurring mistakes or clarify ambiguous cases, without changing what coders see in Description.</div>
        </div>
      </div>`;
  }

  function saveCode(dimId, editId=null) {
    const codeId   = document.getElementById('code-id')?.value.trim();
    const label    = document.getElementById('code-label')?.value.trim();
    const desc     = document.getElementById('code-desc')?.value.trim();
    const aiNotes  = document.getElementById('code-ai-notes')?.value.trim();

    if (!codeId)  { App.notify('Code ID is required', 'error'); return; }
    if (!label)   { App.notify('Label is required', 'error'); return; }
    if (!/^[a-z0-9_\-]+$/i.test(codeId)) { App.notify('Code ID: only letters, numbers, _ and -', 'error'); return; }

    let codebook = App.getState().codebook;
    const dimIdx = codebook.findIndex(d=>d.id===dimId);
    if (dimIdx === -1) return;

    const dim   = { ...codebook[dimIdx] };
    let codes   = [...dim.codes];

    if (editId) {
      const idx = codes.findIndex(c=>c.id===editId);
      // Other fields of the code (added by other features) are kept
      if (idx !== -1) codes[idx] = { ...codes[idx], id:editId, label, description:desc||'', aiNotes:aiNotes||'' };
      App.notify('Code updated', 'success');
    } else {
      if (codes.some(c=>c.id===codeId)) { App.notify('Code ID already exists in this dimension', 'error'); return; }
      codes.push({ id:codeId, label, description:desc||'', aiNotes:aiNotes||'' });
      App.notify('Code added', 'success');
    }

    dim.codes = codes;
    codebook = [...codebook.slice(0,dimIdx), dim, ...codebook.slice(dimIdx+1)];
    App.setState({ codebook });
    App.closeModal();
    render();
  }

  function deleteCode(dimId, codeId) {
    if (!confirm('Delete this code?')) return;
    let codebook = App.getState().codebook;
    const dimIdx = codebook.findIndex(d=>d.id===dimId);
    const dim    = { ...codebook[dimIdx], codes: codebook[dimIdx].codes.filter(c=>c.id!==codeId) };
    codebook = [...codebook.slice(0,dimIdx), dim, ...codebook.slice(dimIdx+1)];
    App.setState({ codebook });
    App.notify('Code removed', 'warning');
    render();
  }

  /* ── Import from CSV ─────────────────────────*/
  function importModal() {
    App.openModal('Import Codebook from CSV', `
      <div style="font-size:13.5px;color:var(--tx-second);margin-bottom:16px">
        CSV must have columns: <code style="font-family:var(--f-mono)">dimension_name, code_id, code_label</code>
        <br>Optional: <code style="font-family:var(--f-mono)">dimension_description, code_description, code_ai_notes</code>
      </div>
      <p class="form-hint" id="cb-import-rules" style="margin:-6px 0 14px">Coding rules from the AI Coding Lab aren't in codebook CSVs (Export Data → Codebook leaves them out). Importing a dimension you already have updates its description and codes and keeps its coding rule.</p>
      <div class="upload-zone" onclick="document.getElementById('cb-file').click()">
        <input type="file" id="cb-file" accept=".csv" onchange="Codebook.importCSV(this)">
        <div class="upload-title">Click to choose codebook CSV</div>
      </div>
    `, `<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>`);
  }

  function importCSV(input) {
    const f = input?.files?.[0];
    if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: results => {
        const rows = results.data;
        const dimMap = {};
        rows.forEach(row => {
          const get = k => { const key=Object.keys(row).find(r=>r.toLowerCase().replace(/\s/g,'_')===k); return key?row[key]?.trim():''; };
          const dimName = get('dimension_name');
          const codeId  = get('code_id');
          const codeLbl = get('code_label');
          if (!dimName || !codeId || !codeLbl) return;
          const dimId = App.slugify(dimName);
          if (!dimMap[dimId]) {
            dimMap[dimId] = { id:dimId, name:dimName, description:get('dimension_description')||'', codes:[] };
          }
          dimMap[dimId].codes.push({ id:codeId, label:codeLbl, description:get('code_description')||'', aiNotes:get('code_ai_notes')||'' });
        });
        const imported = Object.values(dimMap);
        if (!imported.length) { App.notify('No valid rows found in CSV', 'error'); return; }
        // Merge with existing: the CSV's fields win, and what a CSV can't hold stays (a dimension's
        // coding rule and its history from the AI Coding Lab, other fields of the dimension and of its codes)
        const existing = App.getState().codebook;
        const merged = [...existing];
        const drifted = [];
        imported.forEach(dim => {
          const idx = merged.findIndex(d=>d.id===dim.id);
          if (idx < 0) { merged.push(dim); return; }
          const old = merged[idx];
          const oldCodes = Array.isArray(old.codes) ? old.codes : [];
          merged[idx] = { ...old, ...dim, codes: dim.codes.map(c => ({ ...(oldCodes.find(o => o && o.id === c.id) || {}), ...c })) };
          // The rule stays, marked in its panel, when the CSV dropped codes it can return
          const drift = typeof CodingRule !== 'undefined' ? CodingRule.codeDrift(merged[idx]) : null;
          if (drift && drift.notInDimension.length) drifted.push(`“${dim.name}” (${CodingRule.codeList(drift.notInDimension)})`);
        });
        App.setState({ codebook: merged });
        App.closeModal();
        if (drifted.length) App.notify(`Imported ${imported.length} dimensions. The coding rule of ${drifted.join(', ')} can return codes the CSV no longer has — marked “codes changed since this rule was tested”.`, 'warning', 9000);
        else App.notify(`Imported ${imported.length} dimensions`, 'success');
        render();
      }
    });
  }

  /* ── Example codebook ────────────────────────*/
  function loadExample() {
    // It replaces the whole codebook: a coding rule from the AI Coding Lab (and its history) would go with it
    const withRule = App.getState().codebook.filter(d => d && d.codingRule && typeof d.codingRule === 'object');
    if (withRule.length && !confirm(`Replace the codebook with the example? The coding rule${withRule.length === 1 ? '' : 's'} from the AI Coding Lab on ${withRule.map(d => `"${d.name || d.id}"`).join(', ')} and ${withRule.length === 1 ? 'its' : 'their'} history will be removed (the experiments stay in the Lab).`)) return;
    const example = [
      {
        id: 'sentiment', name: 'Sentiment', description: 'The overall emotional valence of the post.',
        codes: [
          { id:'pos', label:'Positive', description:'Expresses optimism, support, enthusiasm, or positive emotions about the topic.' },
          { id:'neg', label:'Negative', description:'Expresses pessimism, opposition, frustration, or negative emotions.' },
          { id:'neutral', label:'Neutral/Mixed', description:'Factual, balanced, or unclear emotional valence.' }
        ]
      },
      {
        id: 'stance', name: 'Policy Stance', description: 'The author\'s position toward the discussed policy or issue.',
        codes: [
          { id:'support', label:'Support', description:'Clearly favors the policy or advocates for action.' },
          { id:'oppose', label:'Oppose', description:'Clearly opposes the policy or advocates against action.' },
          { id:'neutral', label:'Neutral', description:'Does not clearly support or oppose; questioning, deliberative, or informational.' }
        ]
      },
      {
        id: 'incivility', name: 'Incivility', description: 'Presence of uncivil discourse elements.',
        codes: [
          { id:'none', label:'None', description:'No incivility present; polite and constructive.' },
          { id:'mild', label:'Mild', description:'Some negativity toward others but not overtly hostile.' },
          { id:'high', label:'High', description:'Clearly hostile, ad hominem, or derogatory language.' }
        ]
      },
      {
        id: 'topic', name: 'Primary Topic', description: 'The main subject matter of the post.',
        codes: [
          { id:'policy', label:'Policy Details', description:'Discusses specific provisions, legislation, or regulatory details.' },
          { id:'econ', label:'Economic Impact', description:'Focuses on jobs, costs, GDP, or economic consequences.' },
          { id:'science', label:'Science/Evidence', description:'References scientific findings, data, or expert opinion.' },
          { id:'social', label:'Social/Human Impact', description:'Focuses on communities, workers, or lived experiences.' },
          { id:'other', label:'Other', description:'Does not fit the categories above.' }
        ]
      }
    ];
    App.setState({ codebook: example });
    App.notify('Example codebook loaded (4 dimensions)', 'success');
    render();
  }

  return { render, addDimension, saveDimension, editDimension, deleteDimension,
           addCode, saveCode, editCode, deleteCode, importModal, importCSV, loadExample,
           viewRule, removeRule, confirmRemoveRule, ruleMetricsHTML };
})();
