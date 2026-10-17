/* ══════════════════════════════════════════════
   lab-training.js — Training Studio

   Datasets of coding tasks (draft + frozen versions), import/export, quality
   reports, splits, version comparison — and fine-tuning, only where a
   provider on this server really offers it.
   ══════════════════════════════════════════════ */

(() => {
  'use strict';
  const { esc, fmt, when, get, post, put, patch, del, act, notify, openModal, closeModal, confirmDanger, $ } = Lab;
  const field = (l, c) => Lab.field(l, c);
  const latest = d => (d.versions.length ? d.versions[d.versions.length - 1].version : null);

  /* ── Datasets list ───────────────────────── */
  Lab.view('training', async main => {
    const [list, cap] = await Promise.all([get('/datasets').then(r => r.datasets), get('/finetune/capabilities')]);
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>Training Studio</h2><p>Datasets of representative coding tasks with what a good answer does. They are used to <b>evaluate</b> profiles and models, and — only through a provider that supports it — to <b>fine-tune</b> a model. Building a dataset changes nothing in any model by itself.</p></div>' +
      '<button class="btn btn-primary" id="ds-new">New dataset</button></div>' +
      (list.length ? '<div class="table-wrap card"><table class="table"><thead><tr><th>Dataset</th><th>Draft examples</th><th>Committed versions</th><th>Updated</th></tr></thead><tbody>' +
        list.map(d => '<tr><td><a href="#dataset/' + esc(d.id) + '"><b>' + esc(d.name) + '</b></a><div class="lab-muted">' + esc((d.description || '').slice(0, 120)) + '</div></td><td>' + fmt(d.examples) + '</td>' +
          '<td>' + (d.versions.length ? 'v' + latest(d) + ' <span class="lab-muted">(' + fmt(d.versions[d.versions.length - 1].count) + ' examples)</span>' : '<span class="lab-muted">none yet</span>') + '</td><td>' + when(d.updatedAt) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<div class="lab-empty"><h3>No datasets yet</h3><p>Start with 10–30 tasks your team really asks for, each with expected output or checks. Commit a version, then build an evaluation suite from it.</p></div>') +
      '<div class="card lab-section mt-3"><div class="card-title">Fine-tuning</div>' +
        (cap.available ? '<p class="lab-second">Available through ' + esc(cap.provider) + ' for: ' + cap.baseModels.map(esc).join(', ') + '. ' + esc(cap.cost) + '</p><a class="btn btn-secondary btn-sm mt-3" href="#finetune">Open fine-tuning</a>'
          : '<p class="lab-second">' + esc(cap.reason) + '</p><p class="lab-muted mt-3">' + esc(cap.note) + '</p><a class="lab-muted" href="#finetune">Past jobs and details →</a>') + '</div>';
    $('ds-new').onclick = () => datasetForm(null);
  });

  function datasetForm(d) {
    openModal(d ? 'Edit dataset' : 'New dataset', field('Name', '<input class="form-input" name="name" maxlength="120" value="' + esc(d ? d.name : '') + '">') +
      field('Description <span>(what the tasks cover, where they came from)</span>', '<textarea class="form-textarea" name="description" rows="3">' + esc(d ? d.description : '') + '</textarea>'),
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="dsf-save">' + (d ? 'Save' : 'Create') + '</button>');
    $('dsf-save').onclick = e => act(e.target, async () => {
      const f = Lab.formValues($('modal-body'));
      const r = d ? await patch('/datasets/' + d.id, f) : await post('/datasets', Object.assign(f, { projectId: Lab.state.projectId }));
      closeModal();
      Lab.go('dataset/' + r.dataset.id);
    });
  }

  /* ── One dataset ─────────────────────────── */
  const T = { tab: 'examples', version: 'draft', q: '', split: '', quality: '', difficulty: '', offset: 0 };
  let currentId = null;

  Lab.view('dataset', async (main, [id]) => {
    if (currentId !== id) { Object.assign(T, { tab: 'examples', version: 'draft', q: '', split: '', quality: '', difficulty: '', offset: 0 }); currentId = id; }
    const d = (await get('/datasets/' + encodeURIComponent(id) + '?limit=1')).dataset;
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>' + esc(d.name) + '</h2><p>' + esc(d.description || '') + '</p></div>' +
      '<div class="lab-actions"><button class="btn btn-ghost btn-sm" id="dv-edit">Edit</button><button class="btn btn-ghost btn-sm" id="dv-exp">Export…</button><button class="btn btn-ghost btn-sm" id="dv-del">Delete</button></div></div>' +
      '<div class="lab-tabs" role="tablist">' + [['examples', 'Examples'], ['quality', 'Quality and splits'], ['versions', 'Versions']].map(([k, l]) => '<button type="button" class="lab-tab" role="tab" data-tab="' + k + '" aria-selected="' + (T.tab === k) + '">' + l + '</button>').join('') + '</div>' +
      '<div id="dv-body"></div>';
    main.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => { T.tab = b.dataset.tab; main.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b))); renderTab(d); }; });
    $('dv-edit').onclick = () => datasetForm(d);
    $('dv-exp').onclick = () => exportForm(d);
    $('dv-del').onclick = async () => {
      if (!(await confirmDanger('Delete dataset?', 'The draft and all committed versions of "' + d.name + '" are deleted.'))) return;
      try { await del('/datasets/' + d.id); Lab.go('training'); }
      catch (e) {
        if (e.status !== 409) { notify(e.message, 'error', 7000); return; }
        if (await confirmDanger('Dataset in use', e.message.replace(/ Delete with force=1.*$/, '') + ' Delete it anyway?', 'Delete anyway')) act(null, async () => { await del('/datasets/' + d.id + '?force=1'); Lab.go('training'); });
      }
    };
    renderTab(d);
  });

  function renderTab(d) {
    const box = $('dv-body');
    Lab.background(T.tab === 'quality' ? renderQuality(box, d) : T.tab === 'versions' ? renderVersions(box, d) : renderExamples(box, d));
  }

  const versionOptions = (d, selected, withDraft) => (withDraft ? '<option value="draft"' + (selected === 'draft' ? ' selected' : '') + '>Draft (editable)</option>' : '') +
    d.versions.slice().reverse().map(v => '<option value="' + v.version + '"' + (String(selected) === String(v.version) ? ' selected' : '') + '>v' + v.version + ' · ' + fmt(v.count) + ' examples</option>').join('');

  async function renderExamples(box, d) {
    const qs = new URLSearchParams({ offset: String(T.offset), limit: '50' });
    if (T.version !== 'draft') qs.set('version', T.version);
    ['q', 'split', 'quality', 'difficulty'].forEach(k => { if (T[k]) qs.set(k, T[k]); });
    const r = await get('/datasets/' + d.id + '?' + qs);
    if (!box.isConnected) return;
    const editable = T.version === 'draft';
    const sel = (name, opts, label) => '<label class="lab-visually-hidden" for="dx-' + name + '">' + label + '</label><select class="form-select" id="dx-' + name + '" style="width:auto"><option value="">' + label + ': any</option>' + opts.map(o => '<option' + (T[name] === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>';
    box.innerHTML = '<div class="lab-actions mb-3"><select class="form-select" id="dx-version" style="width:auto" aria-label="Version">' + versionOptions(d, T.version, true) + '</select>' +
        '<input class="form-input" id="dx-q" placeholder="Search tasks, inputs, tags…" value="' + esc(T.q) + '" style="flex:1;min-width:160px">' +
        sel('split', ['train', 'validation', 'test', 'none'], 'Split') + sel('quality', ['unreviewed', 'approved', 'needs_work', 'rejected'], 'Quality') + sel('difficulty', ['easy', 'medium', 'hard'], 'Difficulty') +
        (editable ? '<button class="btn btn-secondary btn-sm" id="dx-import">Import…</button><button class="btn btn-primary btn-sm" id="dx-add">Add example</button>' : '') + '</div>' +
      (editable ? '' : '<div class="lab-note mb-3">Version ' + esc(T.version) + ' is frozen: evaluation runs that used it stay reproducible. Edit the draft and commit a new version to change it.</div>') +
      (r.examples.length ? '<div class="table-wrap card"><table class="table"><thead><tr><th>Task</th><th>Language</th><th>Category</th><th>Difficulty</th><th>Split</th><th>Quality</th><th>Checks</th></tr></thead><tbody>' +
        r.examples.map(e => '<tr data-ex="' + esc(e.id) + '" style="cursor:pointer"><td><b>' + esc(e.task.slice(0, 140)) + '</b>' + (e.expected ? '' : ' <span class="badge badge-amber" title="No expected output">no expected</span>') + '</td><td>' + esc(e.language || '—') + '</td><td>' + esc(e.category || '—') + '</td>' +
          '<td>' + esc(e.difficulty || '—') + '</td><td>' + esc(e.split || '—') + '</td><td>' + esc(e.quality.replace('_', ' ')) + '</td><td>' + fmt(e.checks.length) + '</td></tr>').join('') + '</tbody></table></div>' +
        '<div class="lab-actions mt-3"><span class="lab-muted">' + fmt(r.offset + 1) + '–' + fmt(r.offset + r.examples.length) + ' of ' + fmt(r.total) + '</span>' +
          (r.offset > 0 ? '<button class="btn btn-ghost btn-sm" id="dx-prev">Previous</button>' : '') + (r.offset + r.examples.length < r.total ? '<button class="btn btn-ghost btn-sm" id="dx-next">Next</button>' : '') + '</div>'
        : '<div class="lab-empty"><h3>' + (r.total === 0 && !T.q && !T.split && !T.quality && !T.difficulty ? 'No examples' : 'Nothing matches') + '</h3><p>' + (editable ? 'Add examples one by one, or import JSONL, JSON or CSV.' : '') + '</p></div>');
    const refresh = () => Lab.background(renderExamples(box, d));
    $('dx-version').onchange = e => { T.version = e.target.value; T.offset = 0; refresh(); };
    let t = null;
    $('dx-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { T.q = e.target.value.trim(); T.offset = 0; refresh(); }, 300); };
    ['split', 'quality', 'difficulty'].forEach(k => { $('dx-' + k).onchange = e => { T[k] = e.target.value; T.offset = 0; refresh(); }; });
    if ($('dx-prev')) $('dx-prev').onclick = () => { T.offset = Math.max(0, T.offset - 50); refresh(); };
    if ($('dx-next')) $('dx-next').onclick = () => { T.offset += 50; refresh(); };
    if (editable) { $('dx-add').onclick = () => exampleEditor(d, null, refresh); $('dx-import').onclick = () => importForm(d, refresh); }
    box.querySelectorAll('[data-ex]').forEach(tr => { tr.onclick = () => exampleEditor(d, r.examples.find(e => e.id === tr.dataset.ex), refresh, !editable); });
  }

  const CHECK_HELP = 'A JSON array of checks, e.g. [{"type":"contains","values":["export function"]}, {"type":"syntax","language":"javascript"}]. ' +
    'Types: contains, not_contains, regex, exact, code_block, json_schema, syntax (parses only; never runs), required_symbols, max_length, unit_tests (always skipped: code is never run), ai_rubric (AI-graded, not ground truth).';

  function exampleEditor(d, e, done, readOnly) {
    const v = e || { task: '', input: '', expected: '', reference: '', language: '', framework: '', category: '', difficulty: '', tags: [], source: '', quality: 'unreviewed', split: null, weight: 1, notes: '', checks: [] };
    const ro = readOnly ? ' readonly' : '';
    const ta = (name, label, rows) => field(label, '<textarea class="form-textarea lab-mono" name="' + name + '" rows="' + rows + '"' + ro + '>' + esc(v[name]) + '</textarea>');
    const opt = (name, values) => '<select class="form-select" name="' + name + '"' + (readOnly ? ' disabled' : '') + '>' + values.map(([val, l]) => '<option value="' + val + '"' + (String(v[name] || '') === val ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
    openModal(readOnly ? 'Example (frozen version)' : e ? 'Edit example' : 'New example',
      ta('task', 'Task <span>(what is asked)</span>', 3) + ta('input', 'Input / context <span>(code, error, files)</span>', 4) + ta('expected', 'Expected output or acceptance criteria', 4) +
      '<div class="lab-row">' + field('Language', '<input class="form-input" name="language" value="' + esc(v.language) + '"' + ro + '>') + field('Framework', '<input class="form-input" name="framework" value="' + esc(v.framework) + '"' + ro + '>') +
        field('Category', '<input class="form-input" name="category" placeholder="e.g. debugging" value="' + esc(v.category) + '"' + ro + '>') + '</div>' +
      '<div class="lab-row">' + field('Difficulty', opt('difficulty', [['', '—'], ['easy', 'easy'], ['medium', 'medium'], ['hard', 'hard']])) +
        field('Quality', opt('quality', [['unreviewed', 'unreviewed'], ['approved', 'approved'], ['needs_work', 'needs work'], ['rejected', 'rejected']])) +
        field('Split', opt('split', [['', 'none'], ['train', 'train'], ['validation', 'validation'], ['test', 'test']])) +
        field('Weight', '<input class="form-input" type="number" name="weight" min="0.1" max="100" step="0.1" value="' + esc(v.weight) + '"' + ro + '>') + '</div>' +
      '<div class="lab-row">' + field('Tags <span>(comma-separated)</span>', '<input class="form-input" name="tags" value="' + esc(v.tags.join(', ')) + '"' + ro + '>') +
        field('Source <span>(where it came from, license)</span>', '<input class="form-input" name="source" value="' + esc(v.source) + '"' + ro + '>') + '</div>' +
      field('Checks <span>(JSON)</span>', '<textarea class="form-textarea lab-mono" name="checks" rows="4"' + ro + '>' + esc(v.checks.length ? JSON.stringify(v.checks, null, 2) : '') + '</textarea><p class="form-hint">' + esc(CHECK_HELP) + '</p>') +
      '<details class="lab-more"><summary>Reference solution and notes</summary>' + ta('reference', 'Reference solution', 4) + ta('notes', 'Notes', 2) + '</details>',
      readOnly ? '<button class="btn btn-secondary" onclick="Lab.closeModal()">Close</button>'
        : (e ? '<button class="btn btn-danger" id="ex-del">Delete</button>' : '') + '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="ex-save">Save</button>');
    if (readOnly) return;
    $('ex-save').onclick = ev => act(ev.target, async () => {
      const f = Lab.formValues($('modal-body'));
      let checks = [];
      if (f.checks.trim()) { try { checks = JSON.parse(f.checks); } catch (err) { throw new Error('The checks aren\'t valid JSON: ' + err.message); } if (!Array.isArray(checks)) throw new Error('Checks must be a JSON array.'); }
      const example = Object.assign({}, f, { checks, split: f.split || null });
      if (e) await put('/datasets/' + d.id + '/examples/' + e.id, { example }); else await post('/datasets/' + d.id + '/examples', { example });
      closeModal();
      notify('Example saved to the draft', 'success');
      done();
    });
    if (e) $('ex-del').onclick = ev => act(ev.target, async () => { await del('/datasets/' + d.id + '/examples/' + e.id); closeModal(); done(); });
  }

  function importForm(d, done) {
    openModal('Import examples', '<p class="lab-second">Adds to the draft. Nothing is overwritten; duplicates (same task and input) are skipped, and every rejected row is listed. Fields: task (required), input, expected, reference, language, framework, category, difficulty, tags, source, quality, notes, split, weight, checks.</p>' +
      field('File <span>(.jsonl, .json or .csv)</span>', '<input type="file" class="form-input" id="im-file" accept=".jsonl,.ndjson,.json,.csv">') +
      field('Format', '<select class="form-select" name="format" id="im-format"><option value="jsonl">JSONL (one example per line)</option><option value="json">JSON (an array)</option><option value="csv">CSV (header row with a "task" column)</option></select>') +
      field('…or paste', '<textarea class="form-textarea lab-mono" id="im-text" rows="6"></textarea>') + '<div id="im-res"></div>',
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Close</button><button class="btn btn-primary" id="im-go">Import</button>');
    $('im-file').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      $('im-format').value = ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : 'jsonl';
      try { $('im-text').value = await Lab.readText(f); } catch (err) { notify(err.message, 'error'); }
    };
    $('im-go').onclick = e => act(e.target, async () => {
      const r = await post('/datasets/' + d.id + '/import', { format: $('im-format').value, content: $('im-text').value });
      $('im-res').innerHTML = '<div class="lab-note">' + fmt(r.added) + ' added · ' + fmt(r.duplicates) + ' duplicate(s) skipped · ' + fmt(r.problems.length) + ' problem(s) · ' + fmt(r.total) + ' examples in the draft</div>' +
        (r.problems.length ? '<ul class="lab-list mt-3">' + r.problems.map(p => '<li><span>' + (p.row ? 'Row ' + p.row : 'Import') + '</span><span class="lab-fail">' + esc(p.message) + '</span></li>').join('') + '</ul>' : '');
      done();
    });
  }

  function exportForm(d) {
    openModal('Export dataset', field('Version', '<select class="form-select" id="xp-v">' + versionOptions(d, latest(d) || 'draft', true) + '</select>') +
      field('Format', '<select class="form-select" id="xp-f"><option value="jsonl">JSONL (MetaCode format)</option><option value="json">JSON</option><option value="csv">CSV</option><option value="chat">Chat training format (JSONL, examples with expected output)</option></select>') +
      '<div id="xp-prof-box" hidden>' + field('System prompt from profile <span>(optional)</span>', '<select class="form-select" id="xp-p"><option value="">None</option></select>') + '</div>',
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="xp-go">Download</button>');
    $('xp-f').onchange = e => Lab.background((async () => {
      const chat = e.target.value === 'chat';
      $('xp-prof-box').hidden = !chat;
      if (chat && $('xp-p').options.length === 1) { const ps = (await get('/profiles')).profiles; $('xp-p').innerHTML += ps.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (v' + p.currentVersion + ')</option>').join(''); }
    })());
    $('xp-go').onclick = () => {
      const v = $('xp-v').value, f = $('xp-f').value, p = $('xp-p').value;
      const qs = new URLSearchParams({ format: f });
      if (v !== 'draft') qs.set('version', v);
      if (f === 'chat' && p) qs.set('profileId', p);
      closeModal();
      Lab.download('/datasets/' + d.id + '/export?' + qs, 'dataset.' + (f === 'chat' ? 'jsonl' : f));
    };
  }

  /* ── Quality and splits ──────────────────── */
  async function renderQuality(box, d) {
    const purpose = T.purpose || 'both';
    const qs = new URLSearchParams({ purpose });
    if (T.version !== 'draft') qs.set('version', T.version);
    const r = await get('/datasets/' + d.id + '/quality?' + qs);
    if (!box.isConnected) return;
    const lvl = { error: 'badge-red', warning: 'badge-amber', info: 'badge-gray' };
    box.innerHTML = '<div class="lab-actions mb-3"><select class="form-select" id="dq-v" style="width:auto" aria-label="Version">' + versionOptions(d, T.version, true) + '</select>' +
        '<select class="form-select" id="dq-p" style="width:auto" aria-label="Purpose">' + [['both', 'For evaluation and training'], ['evaluation', 'For evaluation'], ['training', 'For training']].map(([k, l]) => '<option value="' + k + '"' + (purpose === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
        '<button class="btn btn-ghost btn-sm" id="dq-dl">Download report</button></div>' +
      '<div class="lab-metrics lab-section"><div class="lab-metric"><b>' + fmt(r.examples) + '</b><span>examples</span></div><div class="lab-metric"><b class="' + (r.errors ? 'lab-fail' : '') + '">' + fmt(r.errors) + '</b><span>errors</span></div>' +
        '<div class="lab-metric"><b>' + fmt(r.warnings) + '</b><span>warnings</span></div><div class="lab-metric"><b>' + fmt(r.splits.train) + ' / ' + fmt(r.splits.validation) + ' / ' + fmt(r.splits.test) + '</b><span>train / validation / test</span><small>' + fmt(r.splits.none) + ' without a split</small></div></div>' +
      '<div class="lab-grid-2"><div class="card"><div class="card-title">Issues</div>' + (r.issues.length ? '<ul class="lab-list">' + r.issues.slice(0, 300).map(i => '<li><span><span class="badge ' + lvl[i.level] + '">' + esc(i.level) + '</span> ' + esc(i.message) + '</span>' +
          (i.exampleId ? '<span class="lab-mono lab-muted">' + esc(i.exampleId) + '</span>' : '') + '</li>').join('') + '</ul>' : '<p class="lab-muted">No issues found.</p>') + '<p class="lab-muted mt-3">' + esc(r.note) + '</p></div>' +
      '<div class="card"><div class="card-title">Assign splits (draft)</div><p class="lab-second">Deterministic: the same seed gives the same assignment. Examples that already have a split keep it unless you overwrite.</p>' +
        '<div class="lab-row mt-3" id="sp-form">' + field('Train %', '<input class="form-input" type="number" name="train" min="0" max="100" value="70">') + field('Validation %', '<input class="form-input" type="number" name="validation" min="0" max="100" value="15">') +
          field('Test %', '<input class="form-input" type="number" name="test" min="0" max="100" value="15">') + field('Seed', '<input class="form-input" name="seed" placeholder="optional">') + '</div>' +
        '<label class="lab-muted"><input type="checkbox" id="sp-over"> Overwrite existing splits</label><div class="lab-actions mt-3"><button class="btn btn-secondary btn-sm" id="sp-go">Assign splits</button></div>' +
        '<p class="lab-muted mt-3">The test split measures; training on it would overstate results. The quality report flags the same task in test and train.</p></div></div>';
    $('dq-v').onchange = e => { T.version = e.target.value; Lab.background(renderQuality(box, d)); };
    $('dq-p').onchange = e => { T.purpose = e.target.value; Lab.background(renderQuality(box, d)); };
    $('dq-dl').onclick = () => Lab.download('/datasets/' + d.id + '/quality?' + qs + '&download=1', 'quality-report.json');
    $('sp-go').onclick = e => act(e.target, async () => {
      const f = Lab.formValues($('sp-form'));
      const r2 = await post('/datasets/' + d.id + '/splits', { train: Number(f.train), validation: Number(f.validation), test: Number(f.test), seed: f.seed, overwrite: $('sp-over').checked });
      notify(fmt(r2.changed) + ' example(s) assigned. Commit a version to use the splits in a suite.', 'success', 5000);
      T.version = 'draft';
      await renderQuality(box, d);
    });
  }

  /* ── Versions ────────────────────────────── */
  async function renderVersions(box, d) {
    const fresh = (await get('/datasets/' + d.id + '?limit=1')).dataset;
    if (!box.isConnected) return;
    Object.assign(d, fresh);
    box.innerHTML = '<div class="lab-grid-2"><div class="card"><div class="card-title">Commit the draft as a new version</div><p class="lab-second">A version is frozen. Suites name the version they use, so later edits to the draft never change past results.</p>' +
        '<div class="form-group mt-3"><label class="form-label" for="cv-note">What changed</label><input class="form-input" id="cv-note" maxlength="500"></div>' +
        '<label class="lab-muted"><input type="checkbox" id="cv-err"> Commit even if the quality report has errors</label><div class="lab-actions mt-3"><button class="btn btn-primary btn-sm" id="cv-go">Commit version ' + ((latest(d) || 0) + 1) + ' (' + fmt(d.examples) + ' examples)</button></div></div>' +
      '<div class="card"><div class="card-title">Compare</div><div class="lab-actions"><select class="form-select" id="cmp-a" style="width:auto" aria-label="From">' + versionOptions(d, d.versions.length > 1 ? d.versions[d.versions.length - 2].version : latest(d) || 'draft', true) + '</select> → ' +
        '<select class="form-select" id="cmp-b" style="width:auto" aria-label="To">' + versionOptions(d, 'draft', true) + '</select><button class="btn btn-secondary btn-sm" id="cmp-go">Compare</button></div><div id="cmp-res"></div></div></div>' +
      '<div class="card mt-3"><div class="card-title">Versions</div>' + (d.versions.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Version</th><th>Examples</th><th>Note</th><th>Committed</th><th>Content hash</th></tr></thead><tbody>' +
        d.versions.slice().reverse().map(v => '<tr><td>v' + v.version + '</td><td>' + fmt(v.count) + '</td><td>' + esc(v.note || '') + '</td><td>' + when(v.createdAt) + '</td><td class="lab-mono lab-muted">' + esc(v.sha256.slice(0, 12)) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="lab-muted">No versions yet. Suites and fine-tuning need a committed version.</p>') + '</div>';
    $('cv-go').onclick = e => act(e.target, async () => {
      const r = await post('/datasets/' + d.id + '/versions', { note: $('cv-note').value, acceptErrors: $('cv-err').checked });
      notify('Committed version ' + r.version, 'success');
      await renderVersions(box, d);
    });
    $('cmp-go').onclick = e => act(e.target, async () => {
      const r = await get('/datasets/' + d.id + '/compare?a=' + encodeURIComponent($('cmp-a').value) + '&b=' + encodeURIComponent($('cmp-b').value));
      const list = (title, xs, cls) => xs.length ? '<h4 class="lab-muted mt-3">' + title + ' (' + fmt(xs.length) + ')</h4><ul class="lab-list">' + xs.slice(0, 100).map(x => '<li><span class="' + cls + '">' + esc(x.task) + '</span></li>').join('') + '</ul>' : '';
      $('cmp-res').innerHTML = '<p class="lab-second mt-3">' + fmt(r.added.length) + ' added, ' + fmt(r.removed.length) + ' removed, ' + fmt(r.changed.length) + ' changed, ' + fmt(r.unchanged) + ' unchanged.</p>' +
        list('Added', r.added, 'lab-pass') + list('Removed', r.removed, 'lab-fail') + list('Changed', r.changed, '');
    });
  }

  /* ── Fine-tuning ─────────────────────────── */
  Lab.view('finetune', async main => {
    const [cap, jobs, datasets, profiles] = await Promise.all([get('/finetune/capabilities'), get('/finetunes').then(r => r.jobs), get('/datasets').then(r => r.datasets), get('/profiles').then(r => r.profiles)]);
    const usable = datasets.filter(d => d.versions.length);
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>Fine-tuning</h2><p>' + esc(cap.note) + '</p></div></div>' +
      (cap.available ? '<div class="card lab-section"><div class="card-title">New fine-tuning job · ' + esc(cap.provider) + '</div>' +
          '<p class="lab-second">' + esc(cap.requirements.format) + '. At least ' + fmt(cap.requirements.minExamples) + ' examples. ' + esc(cap.requirements.trainingSplit) + '</p>' +
          (usable.length ? '<div class="lab-row mt-3" id="ft-form">' + field('Dataset', '<select class="form-select" name="datasetId" id="ft-ds">' + usable.map(d => '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>').join('') + '</select>') +
            field('Version', '<select class="form-select" name="datasetVersion" id="ft-v"></select>') +
            field('Base model', '<select class="form-select" name="baseModel">' + cap.baseModels.map(m => '<option>' + esc(m) + '</option>').join('') + '</select>') +
            field('System prompt from profile', '<select class="form-select" name="profileId"><option value="">None</option>' + profiles.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (v' + p.currentVersion + ')</option>').join('') + '</select>') +
            field('Name suffix', '<input class="form-input" name="suffix" maxlength="18" placeholder="metacode">') + '</div>' +
            '<label class="lab-second"><input type="checkbox" id="ft-cost"> ' + esc(cap.cost) + ' I understand this job is billed by the provider.</label>' +
            '<div class="lab-actions mt-3"><button class="btn btn-primary btn-sm" id="ft-go">Start fine-tuning</button></div>'
            : '<p class="lab-muted mt-3">Commit a dataset version with a "train" split first (Training Studio).</p>') + '</div>'
        : '<div class="lab-warn lab-section">' + esc(cap.reason) + '</div>') +
      '<div class="card"><div class="card-title">Jobs</div>' + (jobs.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Job</th><th>Base model</th><th>Data</th><th>Status</th><th>Result</th><th></th></tr></thead><tbody>' +
        jobs.map(j => '<tr><td class="lab-mono">' + esc(j.id) + '<div class="lab-muted">' + when(j.createdAt) + '</div></td><td>' + esc(j.baseModel) + '</td><td>' + fmt(j.trainingExamples) + ' train · ' + fmt(j.validationExamples) + ' validation<div class="lab-muted">dataset v' + j.datasetVersion + '</div></td>' +
          '<td>' + Lab.badge(j.status) + (j.error ? '<div class="lab-fail lab-muted">' + esc(j.error.message) + '</div>' : '') + '</td>' +
          '<td>' + (j.fineTunedModel ? '<span class="lab-mono">' + esc(j.fineTunedModel) + '</span>' : '—') + (j.trainedTokens ? '<div class="lab-muted">' + fmt(j.trainedTokens) + ' trained tokens</div>' : '') + '</td>' +
          '<td style="text-align:right">' + (j.providerJobId ? '<button class="btn btn-ghost btn-sm" data-ft-refresh="' + esc(j.id) + '">Refresh</button>' : '') + (['validating_files', 'queued', 'running'].includes(j.status) ? '<button class="btn btn-ghost btn-sm" data-ft-cancel="' + esc(j.id) + '">Cancel</button>' : '') + '</td></tr>' +
          (j.events && j.events.length ? '<tr><td colspan="6"><details><summary class="lab-muted">Provider events (' + j.events.length + ')</summary><ul class="lab-list">' + j.events.map(ev => '<li><span>' + esc(ev.message) + '</span><span class="lab-muted">' + when(ev.at) + '</span></li>').join('') + '</ul></details></td></tr>' : '')).join('') + '</tbody></table></div>'
        : '<p class="lab-muted">No fine-tuning jobs.</p>') + '<p class="lab-muted mt-3">Statuses come from the provider. A fine-tuned model is used through that provider; evaluate it like any other model before relying on it.</p></div>';
    const fillVersions = () => { const d = usable.find(x => x.id === $('ft-ds').value); $('ft-v').innerHTML = d ? d.versions.slice().reverse().map(v => '<option value="' + v.version + '">v' + v.version + ' · ' + fmt(v.count) + ' examples</option>').join('') : ''; };
    if ($('ft-ds')) { fillVersions(); $('ft-ds').onchange = fillVersions; }
    if ($('ft-go')) $('ft-go').onclick = e => act(e.target, async () => {
      const f = Lab.formValues($('ft-form'));
      await post('/finetunes', { datasetId: f.datasetId, datasetVersion: Number(f.datasetVersion), baseModel: f.baseModel, profileId: f.profileId || null, suffix: f.suffix, confirmCost: $('ft-cost').checked });
      notify('Fine-tuning job created at the provider', 'success');
      Lab.route();
    });
    main.querySelectorAll('[data-ft-refresh]').forEach(b => { b.onclick = () => act(b, async () => { await get('/finetunes/' + b.dataset.ftRefresh); Lab.route(); }); });
    main.querySelectorAll('[data-ft-cancel]').forEach(b => { b.onclick = async () => { if (await confirmDanger('Cancel fine-tuning job?', 'The provider stops the job. Training already done may still be billed.', 'Cancel job')) act(b, async () => { await post('/finetunes/' + b.dataset.ftCancel + '/cancel'); Lab.route(); }); }; });
  });
})();
