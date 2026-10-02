/* ══════════════════════════════════════════════
   codebook.js — Coding dimensions & code management
   ══════════════════════════════════════════════ */

const Codebook = (() => {

  function render() {
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
    return `
      <div class="dim-card" id="dim-${dim.id}">
        <div class="dim-head">
          <div style="flex:1">
            <div class="dim-name">${App.esc(dim.name)}</div>
            <div class="dim-desc">${App.esc(dim.description || 'No description')}</div>
          </div>
          <div class="dim-actions">
            <button class="btn btn-ghost btn-sm" onclick="Codebook.addCode('${dim.id}')">+ Code</button>
            <button class="btn btn-ghost btn-sm" onclick="Codebook.editDimension('${dim.id}')">Edit</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--error)" onclick="Codebook.deleteDimension('${dim.id}')">Delete</button>
          </div>
        </div>
        <div class="dim-codes" id="codes-${dim.id}">
          ${dim.codes.length === 0
            ? `<span style="font-size:12.5px;color:var(--tx-muted)">No codes yet — click "+ Code" to add one</span>`
            : dim.codes.map(c => codeChip(dim.id, c)).join('')
          }
        </div>
      </div>`;
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
        <button onclick="Codebook.editCode('${dimId}','${code.id}')"
          style="background:none;border:none;cursor:pointer;margin-left:4px;color:var(--tx-muted);font-size:11px" title="Edit">✎</button>
        <button onclick="Codebook.deleteCode('${dimId}','${code.id}')"
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
      <button class="btn btn-primary" onclick="Codebook.saveDimension('${dimId}')">Save Changes</button>
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
      return { ...p, aiCodes, humanCodes };
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
      <button class="btn btn-primary" onclick="Codebook.saveCode('${dimId}')">Add Code</button>
    `);
    setTimeout(() => document.getElementById('code-id')?.focus(), 100);
  }

  function editCode(dimId, codeId) {
    const dim  = App.getState().codebook.find(d=>d.id===dimId);
    const code = dim?.codes.find(c=>c.id===codeId);
    if (!code) return;
    App.openModal(`Edit Code in "${dim.name}"`, codeFormHTML(code), `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="Codebook.saveCode('${dimId}','${codeId}')">Save Changes</button>
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
      if (idx !== -1) codes[idx] = { id:editId, label, description:desc||'', aiNotes:aiNotes||'' };
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
        // Merge with existing
        const existing = App.getState().codebook;
        const merged = [...existing];
        imported.forEach(dim => {
          const idx = merged.findIndex(d=>d.id===dim.id);
          if (idx>=0) merged[idx] = dim; else merged.push(dim);
        });
        App.setState({ codebook: merged });
        App.closeModal();
        App.notify(`Imported ${imported.length} dimensions`, 'success');
        render();
      }
    });
  }

  /* ── Example codebook ────────────────────────*/
  function loadExample() {
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
           addCode, saveCode, editCode, deleteCode, importModal, importCSV, loadExample };
})();
