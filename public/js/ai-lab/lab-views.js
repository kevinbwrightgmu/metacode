/* ══════════════════════════════════════════════
   lab-views.js — Overview, Projects (with their knowledge base),
   Coding Profiles, Models, Usage and Documentation
   ══════════════════════════════════════════════ */

(() => {
  'use strict';
  const { esc, fmt, pct, when, get, post, put, patch, del, act, notify, openModal, closeModal, confirmDanger, $ } = Lab;

  /* ── Overview ─────────────────────────────── */
  Lab.view('overview', async main => {
    const o = await get('/overview');
    const meter = (k, m) => {
      const p = m.limit ? Math.min(100, Math.round(m.used / m.limit * 100)) : 0;
      return '<div class="lab-meter"><div class="lab-meter-top"><span>' + esc(m.label) + '</span><span><b>' + fmt(m.used) + '</b> of ' + fmt(m.limit) + ' ' + esc(m.unit) + '</span></div>' +
        '<div class="lab-bar" role="progressbar" aria-label="' + esc(m.label) + '" aria-valuemin="0" aria-valuemax="' + m.limit + '" aria-valuenow="' + m.used + '"><span style="width:' + p + '%"></span></div></div>';
    };
    const empty = !o.counts.projects && !o.counts.profiles && !o.counts.conversations;
    if (!main.isConnected) return;
    main.innerHTML =
      '<div class="lab-head"><div><h2>Overview</h2><p>Configure coding assistants for your projects, give them your project\'s knowledge, and measure whether a change actually makes their answers better.</p></div></div>' +
      (o.next.length ? '<div class="card lab-section"><div class="card-title">' + (empty ? 'Get started' : 'Suggested next steps') + '</div><ol class="lab-steps">' +
        o.next.map(n => '<li><span>' + esc(n.text) + ' ' + nextLink(n.key) + '</span></li>').join('') + '</ol></div>' : '') +
      '<div class="lab-grid lab-section">' +
        stat(o.counts.projects, 'Projects', '#projects') + stat(o.counts.profiles, 'Coding profiles', '#profiles') + stat(o.counts.conversations, 'Conversations', '#workbench') +
        stat(o.counts.documents, 'Knowledge documents', '#knowledge') + stat(o.counts.datasets, 'Datasets', '#training') + stat(o.counts.runs, 'Evaluation runs', '#evaluations') +
      '</div>' +
      '<div class="lab-grid-2 lab-section">' +
        '<div class="card"><div class="card-title">Recent evaluation runs</div>' + (o.recentRuns.length ? '<ul class="lab-list">' + o.recentRuns.map(r => '<li><a href="#run/' + esc(r.id) + '">' + esc(r.model) + (r.profileVersion ? ' · profile v' + r.profileVersion : '') + '</a><span>' + badge(r.status) + ' ' + (r.passRate !== null ? pct(r.passRate) + ' passed' : '') + '</span></li>').join('') + '</ul>' : '<p class="lab-muted">No runs yet.</p>') + '</div>' +
        '<div class="card"><div class="card-title">Recent conversations</div>' + (o.recentConversations.length ? '<ul class="lab-list">' + o.recentConversations.map(c => '<li><a href="#workbench/' + esc(c.id) + '">' + esc(c.title) + '</a><span class="lab-muted">' + when(c.updatedAt) + '</span></li>').join('') + '</ul>' : '<p class="lab-muted">No conversations yet.</p>') + '</div>' +
        '<div class="card"><div class="card-title">Background jobs</div>' + (o.activeJobs.length ? '<ul class="lab-list">' + o.activeJobs.map(j => '<li><a href="#' + (j.id.startsWith('ftj_') ? 'training' : 'run/' + esc(j.id)) + '">' + esc(j.id) + '</a><span>' + badge(j.status) + (j.progress ? ' ' + fmt(j.progress.done) + ' / ' + fmt(j.progress.total) : '') + '</span></li>').join('') + '</ul>' : '<p class="lab-muted">Nothing running.</p>') + '</div>' +
        '<div class="card"><div class="card-title">Usage (fair-use allowance)</div>' + Object.keys(o.usage).map(k => meter(k, o.usage[k])).join('') + '<a href="#usage" class="lab-muted">Details →</a></div>' +
      '</div>' +
      '<div class="card lab-section"><div class="card-title">Recent changes</div>' + (o.recentChanges.length ? '<ul class="lab-list">' + o.recentChanges.map(e => '<li><span>' + esc(e.action.replace(/[._]/g, ' ')) + '</span><span class="lab-muted">' + when(e.ts) + '</span></li>').join('') + '</ul>' : '<p class="lab-muted">Nothing yet.</p>') + '</div>';
  });
  function nextLink(key) {
    const to = { project: '#projects', knowledge: '#knowledge', profile: '#profiles', workbench: '#workbench', dataset: '#training', suite: '#evaluations', run: '#evaluations', compare: '#evaluations', candidate: '#profiles' }[key];
    return to ? '<a href="' + to + '" class="lab-muted">Open →</a>' : '';
  }
  const stat = (n, label, href) => '<a class="stat-card card" href="' + href + '"><div class="stat-num">' + fmt(n) + '</div><div class="stat-label">' + esc(label) + '</div></a>';
  function badge(status) {
    const cls = { completed: 'badge-green', running: 'badge-blue', queued: 'badge-gray', failed: 'badge-red', cancelled: 'badge-amber', interrupted: 'badge-amber', succeeded: 'badge-green', ready: 'badge-green', pending: 'badge-gray', processing: 'badge-blue',
      active: 'badge-green', candidate: 'badge-violet', rejected: 'badge-red', superseded: 'badge-gray', validating_files: 'badge-blue', creating: 'badge-gray' }[status] || 'badge-gray';
    return '<span class="badge ' + cls + '">' + esc(String(status).replace(/_/g, ' ')) + '</span>';
  }
  Lab.badge = badge;

  /* ── Projects ─────────────────────────────── */
  Lab.view('projects', async main => {
    const showArchived = new URLSearchParams(location.hash.split('?')[1] || '').get('archived') === '1';
    const list = (await get('/projects' + (showArchived ? '?archived=1' : ''))).projects;
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>Projects</h2><p>A project holds a codebase\'s instructions, stack and knowledge base. Conversations and evaluations can use it as context.</p></div>' +
      '<div class="lab-actions"><button class="btn btn-ghost btn-sm" id="p-arch">' + (showArchived ? 'Active projects' : 'Archived') + '</button><button class="btn btn-primary" id="p-new">New project</button></div></div>' +
      (list.length ? '<div class="table-wrap card"><table class="table"><thead><tr><th>Name</th><th>Languages</th><th>Frameworks</th><th>Updated</th></tr></thead><tbody>' +
        list.map(p => '<tr><td><a href="#project/' + esc(p.id) + '"><b>' + esc(p.name) + '</b></a><div class="lab-muted">' + esc(p.description.slice(0, 120)) + '</div></td><td>' + esc(p.languages.join(', ')) + '</td><td>' + esc(p.frameworks.join(', ')) + '</td><td>' + when(p.updatedAt) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<div class="lab-empty"><h3>' + (showArchived ? 'No archived projects' : 'No projects yet') + '</h3><p>Create one for the codebase you\'re working on.</p></div>');
    $('p-new').onclick = () => Lab.background(projectForm(null));
    $('p-arch').onclick = () => { location.hash = showArchived ? 'projects' : 'projects?archived=1'; };
  });

  async function projectForm(p) {
    const profiles = (await get('/profiles')).profiles;
    const v = p || { name: '', description: '', languages: [], frameworks: [], instructions: '', repository: { url: '', branch: '', notes: '' }, defaultProfileId: null, defaultModel: null };
    const sel = v.defaultModel ? v.defaultModel.provider + '|' + v.defaultModel.model : '';
    openModal(p ? 'Edit project' : 'New project', '<div class="lab-row" id="pf">' +
      field('Name', '<input class="form-input" name="name" maxlength="120" required value="' + esc(v.name) + '">') +
      field('Programming languages <span>(comma-separated)</span>', '<input class="form-input" name="languages" value="' + esc(v.languages.join(', ')) + '">') +
      field('Frameworks', '<input class="form-input" name="frameworks" value="' + esc(v.frameworks.join(', ')) + '">') +
      '</div><div class="form-group mt-3"><label class="form-label">Description</label><textarea class="form-textarea" name="description" form="x">' + esc(v.description) + '</textarea></div>' +
      '<div class="form-group"><label class="form-label">Project instructions <span>(always sent with this project\'s conversations)</span></label><textarea class="form-textarea" name="instructions" rows="5">' + esc(v.instructions) + '</textarea></div>' +
      '<div class="lab-row">' + field('Default coding profile', '<select class="form-select" name="defaultProfileId"><option value="">None</option>' + profiles.map(x => '<option value="' + esc(x.id) + '"' + (x.id === v.defaultProfileId ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select>') +
      field('Default model', '<select class="form-select" name="model"><option value="">Server default</option>' + Lab.modelOptions(sel) + '</select>') + '</div>' +
      '<details class="lab-more"><summary>Repository (optional)</summary><div class="lab-row">' +
        field('Repository URL <span>(recorded only; MetaCode doesn\'t fetch it)</span>', '<input class="form-input" name="repoUrl" placeholder="https://github.com/…" value="' + esc(v.repository.url || '') + '">') +
        field('Branch', '<input class="form-input" name="repoBranch" value="' + esc(v.repository.branch || '') + '">') + '</div></details>',
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="pf-save">' + (p ? 'Save' : 'Create project') + '</button>');
    $('pf-save').onclick = e => act(e.target, async () => {
      const f = Lab.formValues($('modal-body'));
      const [provider, model] = (f.model || '').split('|');
      const body = { name: f.name, description: f.description, languages: f.languages, frameworks: f.frameworks, instructions: f.instructions,
        repository: { url: f.repoUrl, branch: f.repoBranch }, defaultProfileId: f.defaultProfileId || null, defaultModel: model ? { provider, model } : null };
      const r = p ? await patch('/projects/' + p.id, body) : await post('/projects', body);
      closeModal();
      await Lab.loadProjects();
      if (!p) Lab.setProject(r.project.id);
      notify(p ? 'Project saved' : 'Project created', 'success');
      Lab.go('project/' + r.project.id);
    });
  }
  const field = (label, control) => '<div class="form-group"><label class="form-label">' + label + '</label>' + control + '</div>';
  Lab.field = field;

  Lab.view('project', async (main, [id]) => {
    const p = (await get('/projects/' + encodeURIComponent(id))).project;
    if (Lab.state.projectId !== p.id) { Lab.state.projectId = p.id; try { localStorage.setItem('metacode.lab.project', p.id); } catch (e) { /* */ } }
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>' + esc(p.name) + (p.archived ? ' <span class="badge badge-gray">archived</span>' : '') + '</h2><p>' + esc(p.description) + '</p></div>' +
      '<div class="lab-actions"><button class="btn btn-secondary btn-sm" id="pj-edit">Edit</button><button class="btn btn-ghost btn-sm" id="pj-export">Export</button>' +
      '<button class="btn btn-ghost btn-sm" id="pj-arch">' + (p.archived ? 'Unarchive' : 'Archive') + '</button><button class="btn btn-ghost btn-sm" id="pj-del">Delete</button>' +
      '<a class="btn btn-primary btn-sm" href="#workbench">Open in Workbench</a></div></div>' +
      '<div class="lab-grid-2 lab-section"><div class="card"><div class="card-title">Stack and instructions</div><dl class="lab-kv">' +
        '<dt>Languages</dt><dd>' + esc(p.languages.join(', ') || '—') + '</dd><dt>Frameworks</dt><dd>' + esc(p.frameworks.join(', ') || '—') + '</dd>' +
        '<dt>Repository</dt><dd>' + (p.repository.url ? esc(p.repository.url) + (p.repository.branch ? ' (' + esc(p.repository.branch) + ')' : '') : '—') + '</dd>' +
        '<dt>Default model</dt><dd>' + (p.defaultModel ? esc(p.defaultModel.provider + ' · ' + p.defaultModel.model) : 'Server default') + '</dd></dl>' +
        (p.instructions ? '<div class="lab-pre mt-3">' + esc(p.instructions) + '</div>' : '<p class="lab-muted mt-3">No project instructions.</p>') + '</div>' +
      '<div class="card" id="pj-docs"></div></div>';
    $('pj-edit').onclick = () => Lab.background(projectForm(p));
    $('pj-export').onclick = () => Lab.download('/projects/' + p.id + '/export', 'project.json');
    $('pj-arch').onclick = e => act(e.target, async () => { await patch('/projects/' + p.id, { archived: !p.archived }); await Lab.loadProjects(); Lab.route(); });
    $('pj-del').onclick = async () => {
      if (!(await confirmDanger('Delete project?', 'This deletes "' + p.name + '", its knowledge documents and its conversations. Profiles, datasets and evaluations are kept.'))) return;
      await act(null, async () => { await del('/projects/' + p.id); await Lab.loadProjects(); notify('Project deleted', 'success'); Lab.go('projects'); });
    };
    Lab.background(renderDocs($('pj-docs'), p));
  });

  /* ── Knowledge base (a project's documents) ── */
  Lab.view('knowledge', async main => {
    const p = Lab.project();
    if (!p) { main.innerHTML = '<div class="lab-empty"><h3>Choose a project</h3><p>Knowledge documents belong to a project. Pick one in the top bar, or <a href="#projects">create a project</a>.</p></div>'; return; }
    main.innerHTML = '<div class="lab-head"><div><h2>Knowledge Base · ' + esc(p.name) + '</h2><p>Documentation, coding standards, API specs and source files for this project. Answers can quote them; they are always treated as reference data, never as instructions.</p></div></div><div class="card" id="kb"></div>';
    Lab.background(renderDocs($('kb'), p, true));
  });

  async function renderDocs(box, p, wide) {
    const docs = (await get('/projects/' + p.id + '/documents')).documents;
    if (!box.isConnected) return;
    box.innerHTML = '<div class="card-title">Knowledge documents</div>' +
      '<div class="lab-actions mb-3"><label class="btn btn-secondary btn-sm" for="kb-files">Add files…</label><input type="file" id="kb-files" multiple hidden accept=".md,.markdown,.mdx,.txt,.rst,.adoc,.html,.json,.yaml,.yml,.toml,.xml,.csv,.ini,.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cc,.cs,.php,.sql,.sh,.css,.scss,.vue,.svelte,.graphql,.proto,.r,.scala,.lua,.dart">' +
        '<button class="btn btn-ghost btn-sm" id="kb-paste">Paste text…</button></div>' +
      (docs.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Document</th><th>Status</th><th>Chunks</th><th>Notes</th><th></th></tr></thead><tbody>' +
        docs.map(d => '<tr><td>' + esc(d.name) + '<div class="lab-muted">' + esc(d.kind) + (d.language ? ' · ' + esc(d.language) : '') + ' · ' + fmt(Math.ceil(d.bytes / 1024)) + ' KB</div></td><td>' + badge(d.status) + (d.error ? '<div class="lab-fail lab-muted">' + esc(d.error) + '</div>' : '') + '</td><td>' + fmt(d.chunks) + '</td>' +
          '<td>' + d.warnings.map(w => /secret/.test(w) ? '<span class="badge badge-amber" title="Likely secrets were replaced with [redacted secret] before storing">secrets redacted</span>' : w === 'suspicious_instructions' ? '<span class="badge badge-amber" title="Contains text that reads like instructions to an AI. It is only ever used as reference data.">instructions inside</span>' : '').join(' ') + '</td>' +
          '<td style="text-align:right"><button class="btn btn-ghost btn-sm" data-view-doc="' + esc(d.id) + '">View</button><button class="btn btn-ghost btn-sm" data-del-doc="' + esc(d.id) + '" aria-label="Delete ' + esc(d.name) + '">Delete</button></td></tr>').join('') + '</tbody></table></div>'
        : '<p class="lab-muted">No documents yet. Supported: Markdown, text, source code and data files (up to the server\'s size limit each). Key and credential files are refused; likely secrets are redacted.</p>') +
      '<div class="form-group mt-3"><label class="form-label" for="kb-q">Search this project\'s knowledge</label><div class="lab-actions"><input class="form-input" id="kb-q" placeholder="e.g. how are tokens verified" style="flex:1"><button class="btn btn-secondary btn-sm" id="kb-go">Search</button></div>' +
      '<p class="form-hint">Keyword search (BM25): it matches words and identifiers, not meanings.</p></div><div id="kb-res"></div>';
    const refresh = () => Lab.background(renderDocs(box, p, wide));
    $('kb-files').onchange = async e => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        try { await post('/projects/' + p.id + '/documents', { name: f.name, content: await Lab.readText(f) }); notify('Added ' + f.name + ' — processing', 'info'); }
        catch (err) { notify(f.name + ': ' + err.message, 'error', 7000); }
      }
      refresh();
      if (docs.some(d => d.status === 'pending' || d.status === 'processing') || files.length) setTimeout(refresh, 1500);
    };
    $('kb-paste').onclick = () => {
      openModal('Add text', field('Name <span>(with an extension, e.g. notes.md)</span>', '<input class="form-input" name="name" value="notes.md">') + field('Content', '<textarea class="form-textarea" name="content" rows="12"></textarea>'),
        '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="kb-add">Add</button>');
      $('kb-add').onclick = ev => act(ev.target, async () => { const f = Lab.formValues($('modal-body')); await post('/projects/' + p.id + '/documents', f); closeModal(); refresh(); setTimeout(refresh, 1500); });
    };
    box.querySelectorAll('[data-del-doc]').forEach(b => { b.onclick = async () => { if (await confirmDanger('Delete document?', 'It is removed from this project\'s knowledge base.')) act(b, async () => { await del('/documents/' + b.dataset.delDoc); refresh(); }); }; });
    box.querySelectorAll('[data-view-doc]').forEach(b => { b.onclick = () => act(b, async () => {
      const d = (await get('/documents/' + b.dataset.viewDoc)).document;
      openModal(d.name, '<p class="lab-muted">' + fmt(d.chunkList.length) + ' chunk(s). This is the text that can be retrieved (after normalising and redaction).</p>' + d.chunkList.slice(0, 50).map(c => '<h4 class="lab-muted mt-3">Chunk ' + (c.index + 1) + ' · lines ' + c.startLine + '–' + c.endLine + (c.heading ? ' · ' + esc(c.heading) : '') + '</h4><div class="lab-pre">' + esc(c.text) + '</div>').join(''));
    }); });
    const search = () => act($('kb-go'), async () => {
      const q = $('kb-q').value.trim();
      if (!q) return;
      const r = await get('/projects/' + p.id + '/search?q=' + encodeURIComponent(q) + '&k=6');
      $('kb-res').innerHTML = r.results.length ? r.results.map(x => '<div class="card mt-3"><b>' + esc(x.name) + '</b> <span class="lab-muted">lines ' + x.startLine + '–' + x.endLine + (x.heading ? ' · ' + esc(x.heading) : '') + ' · score ' + x.score + '</span><div class="lab-pre mt-3">' + esc(x.text.slice(0, 1200)) + '</div></div>').join('') : '<p class="lab-muted mt-3">No matches.</p>';
    });
    $('kb-go').onclick = search;
    $('kb-q').onkeydown = e => { if (e.key === 'Enter') search(); };
    if (docs.some(d => d.status === 'pending' || d.status === 'processing')) { const t = setTimeout(refresh, 1500); Lab.onLeave(() => clearTimeout(t)); }
  }

  /* ── Coding profiles ──────────────────────── */
  const TEXT_FIELDS = [['description', 'Description'], ['language', 'Preferred language'], ['conventions', 'Coding conventions'], ['architecture', 'Architecture preferences'],
    ['naming', 'Naming conventions'], ['errorHandling', 'Error handling'], ['testing', 'Testing requirements'], ['documentation', 'Documentation standards'],
    ['security', 'Security requirements'], ['dependencies', 'Dependency policy'], ['performance', 'Performance expectations'], ['formatting', 'Formatting preferences'],
    ['restrictions', 'Project-specific restrictions'], ['extraInstructions', 'Other instructions']];
  const BASIC = ['description', 'language', 'conventions', 'testing', 'security'];

  Lab.view('profiles', async main => {
    const showArchived = /archived=1/.test(location.hash);
    const list = (await get('/profiles' + (showArchived ? '?archived=1' : ''))).profiles;
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>Coding Profiles</h2><p>How an assistant should write code: conventions, architecture, testing, security and style, as structured fields. Every change is a new version, so results stay reproducible. Profiles change instructions, not the model.</p></div>' +
      '<div class="lab-actions"><button class="btn btn-ghost btn-sm" id="pr-arch">' + (showArchived ? 'Active profiles' : 'Archived') + '</button><label class="btn btn-ghost btn-sm" for="pr-import">Import…</label><input type="file" id="pr-import" accept=".json" hidden><button class="btn btn-primary" id="pr-new">New profile</button></div></div>' +
      (list.length ? '<div class="table-wrap card"><table class="table"><thead><tr><th>Profile</th><th>Version</th><th>Candidates</th><th>Updated</th></tr></thead><tbody>' +
        list.map(p => '<tr><td><a href="#profile/' + esc(p.id) + '"><b>' + esc(p.name) + '</b></a><div class="lab-muted">' + esc((p.fields.description || '').slice(0, 120)) + '</div></td><td>v' + p.currentVersion + ' <span class="lab-muted">of ' + p.versionCount + '</span></td><td>' + (p.candidates.length ? p.candidates.map(v => '<span class="badge badge-violet">v' + v + '</span>').join(' ') : '—') + '</td><td>' + when(p.updatedAt) + '</td></tr>').join('') + '</tbody></table></div>'
        : '<div class="lab-empty"><h3>No profiles yet</h3><p>Write down how your team wants code written; the Workbench and evaluations will use it.</p></div>');
    $('pr-new').onclick = () => profileEditor(null);
    $('pr-arch').onclick = () => { location.hash = showArchived ? 'profiles' : 'profiles?archived=1'; };
    $('pr-import').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      await act(null, async () => { const data = JSON.parse(await Lab.readText(f)); const r = await post('/profiles/import', { data, projectId: Lab.state.projectId }); notify('Profile imported', 'success'); Lab.go('profile/' + r.profile.id); });
    };
  });

  function fieldsForm(f, all) {
    const ta = (k, label) => field(esc(label), '<textarea class="form-textarea" name="' + k + '" rows="3">' + esc(f[k] || '') + '</textarea>');
    return '<div class="lab-row">' + field('Preferred language', '<input class="form-input" name="language" value="' + esc(f.language || '') + '">') +
      field('Frameworks <span>(comma-separated)</span>', '<input class="form-input" name="frameworks" value="' + esc((f.frameworks || []).join(', ')) + '">') + '</div>' +
      ta('description', 'Description') + ta('conventions', 'Coding conventions') + ta('testing', 'Testing requirements') + ta('security', 'Security requirements') +
      '<details class="lab-more"' + (all ? ' open' : '') + '><summary>More fields: architecture, naming, errors, docs, dependencies, performance, style, review steps, inference</summary>' +
      TEXT_FIELDS.filter(([k]) => !BASIC.includes(k)).map(([k, l]) => ta(k, l)).join('') +
      field('Required review steps <span>(one per line)</span>', '<textarea class="form-textarea" name="reviewSteps" rows="3">' + esc((f.reviewSteps || []).join('\n')) + '</textarea>') +
      '<div class="lab-row">' + field('Verbosity', '<select class="form-select" name="verbosity">' + ['concise', 'balanced', 'detailed'].map(v => '<option' + (f.verbosity === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>') +
      field('Explanation depth', '<select class="form-select" name="explanationDepth">' + ['none', 'brief', 'thorough'].map(v => '<option' + (f.explanationDepth === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>') +
      field('Temperature <span>(blank = model default)</span>', '<input class="form-input" name="temperature" type="number" min="0" max="2" step="0.1" value="' + (f.temperature === null || f.temperature === undefined ? '' : f.temperature) + '">') +
      field('Max answer tokens', '<input class="form-input" name="maxTokens" type="number" min="64" max="64000" value="' + (f.maxTokens || '') + '">') + '</div></details>';
  }
  function readFields(root) {
    const v = Lab.formValues(root);
    const out = {};
    TEXT_FIELDS.forEach(([k]) => { if (k in v) out[k] = v[k]; });
    out.frameworks = v.frameworks; out.reviewSteps = String(v.reviewSteps || '').split('\n'); out.verbosity = v.verbosity; out.explanationDepth = v.explanationDepth;
    out.temperature = v.temperature === '' ? null : Number(v.temperature); out.maxTokens = v.maxTokens === '' ? null : Number(v.maxTokens);
    return out;
  }

  function profileEditor(p) {
    const f = p ? p.fields : { verbosity: 'balanced', explanationDepth: 'brief' };
    openModal(p ? 'New version of ' + p.name : 'New coding profile', (p ? '' : field('Name', '<input class="form-input" name="name" maxlength="120">')) + fieldsForm(f) +
      field('Note for this version <span>(what changed)</span>', '<input class="form-input" name="note" maxlength="500">'),
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="pe-save">' + (p ? 'Save as new version' : 'Create profile') + '</button>');
    $('pe-save').onclick = e => act(e.target, async () => {
      const body = { fields: readFields($('modal-body')), note: Lab.formValues($('modal-body')).note };
      let r;
      if (p) { r = await put('/profiles/' + p.id, body); notify(r.created ? 'Saved as version ' + r.created : 'Nothing changed — no new version', r.created ? 'success' : 'info'); }
      else { body.name = Lab.formValues($('modal-body')).name; body.projectId = Lab.state.projectId; r = await post('/profiles', body); notify('Profile created', 'success'); }
      closeModal();
      Lab.go('profile/' + r.profile.id);
    });
  }

  Lab.view('profile', async (main, [id]) => {
    const p = (await get('/profiles/' + encodeURIComponent(id))).profile;
    const cur = (await get('/profiles/' + p.id + '/versions/' + p.currentVersion));
    const vs = p.versions.slice().reverse();
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>' + esc(p.name) + ' <span class="badge badge-violet">v' + p.currentVersion + '</span>' + (p.archived ? ' <span class="badge badge-gray">archived</span>' : '') + '</h2><p>' + esc(p.fields.description || '') + '</p></div>' +
      '<div class="lab-actions"><button class="btn btn-primary btn-sm" id="pv-edit">Edit (new version)</button><button class="btn btn-ghost btn-sm" id="pv-rename">Rename</button><button class="btn btn-ghost btn-sm" id="pv-dup">Duplicate</button>' +
      '<button class="btn btn-ghost btn-sm" id="pv-json">Export JSON</button><button class="btn btn-ghost btn-sm" id="pv-md">Export instructions</button>' +
      '<button class="btn btn-ghost btn-sm" id="pv-arch">' + (p.archived ? 'Unarchive' : 'Archive') + '</button><button class="btn btn-ghost btn-sm" id="pv-del">Delete</button></div></div>' +
      (p.candidates.length ? '<div class="lab-warn lab-section">Candidate version' + (p.candidates.length > 1 ? 's' : '') + ' ' + p.candidates.map(v => 'v' + v).join(', ') + ' waiting. Run the same evaluation suite with ' + (p.candidates.length > 1 ? 'one' : 'it') + ', compare, then accept or reject — a candidate is never accepted automatically.</div>' : '') +
      '<div class="lab-grid-2 lab-section"><div class="card"><div class="card-title">Instructions sent to the model (v' + p.currentVersion + ')</div><div class="lab-pre">' + esc(cur.instructions || '(empty)') + '</div></div>' +
      '<div class="card"><div class="card-title">Versions</div><div class="lab-actions mb-3"><label class="lab-muted">Compare <select class="form-select" id="pv-a" style="width:auto">' + vs.map(v => '<option value="' + v.version + '">v' + v.version + '</option>').join('') + '</select> with <select class="form-select" id="pv-b" style="width:auto">' + vs.map((v, i) => '<option value="' + v.version + '"' + (i === 0 ? ' selected' : '') + '>v' + v.version + '</option>').join('') + '</select></label><button class="btn btn-secondary btn-sm" id="pv-cmp">Compare</button></div>' +
      '<ul class="lab-list">' + vs.map(v => '<li><span><b>v' + v.version + '</b> ' + badge(v.status) + ' <span class="lab-muted">' + esc(v.source) + ' · ' + when(v.createdAt) + (v.note ? ' · ' + esc(v.note) : '') + '</span>' +
        (v.rationale ? '<div class="lab-muted">Suggested from run ' + (v.rationale.fromRunId ? '<a href="#run/' + esc(v.rationale.fromRunId) + '">' + esc(v.rationale.fromRunId) + '</a>' : '') + ': ' + esc(v.rationale.summary) + '</div>' : '') + '</span><span class="lab-actions">' +
        (v.status === 'candidate' ? '<button class="btn btn-primary btn-sm" data-accept="' + v.version + '">Accept</button><button class="btn btn-ghost btn-sm" data-reject="' + v.version + '">Reject</button>' : '') +
        (v.version !== p.currentVersion && v.status !== 'candidate' ? '<button class="btn btn-ghost btn-sm" data-restore="' + v.version + '">Restore</button>' : '') + '</span></li>').join('') + '</ul></div></div>' +
      '<div class="card" id="pv-diff" hidden></div>';
    $('pv-edit').onclick = () => profileEditor(Object.assign({}, p, { fields: p.fields }));
    $('pv-rename').onclick = () => {
      openModal('Rename profile', field('Name', '<input class="form-input" name="name" value="' + esc(p.name) + '" maxlength="120">'), '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="rn">Rename</button>');
      $('rn').onclick = e => act(e.target, async () => { await patch('/profiles/' + p.id, { name: Lab.formValues($('modal-body')).name }); closeModal(); Lab.route(); });
    };
    $('pv-dup').onclick = e => act(e.target, async () => { const r = await post('/profiles/' + p.id + '/duplicate'); notify('Duplicated', 'success'); Lab.go('profile/' + r.profile.id); });
    $('pv-json').onclick = () => Lab.download('/profiles/' + p.id + '/export', 'profile.json');
    $('pv-md').onclick = () => Lab.download('/profiles/' + p.id + '/export?format=markdown', 'profile.md');
    $('pv-arch').onclick = e => act(e.target, async () => { await patch('/profiles/' + p.id, { archived: !p.archived }); Lab.route(); });
    $('pv-del').onclick = async () => { if (await confirmDanger('Delete profile?', 'All of its versions are deleted. Evaluation runs keep their results but can no longer show the instructions they used.')) act(null, async () => { await del('/profiles/' + p.id); Lab.go('profiles'); }); };
    $('pv-cmp').onclick = e => act(e.target, async () => {
      const r = await get('/profiles/' + p.id + '/compare?a=' + $('pv-a').value + '&b=' + $('pv-b').value);
      const box = $('pv-diff');
      box.hidden = false;
      const show = v => (Array.isArray(v) ? v.join('\n') : v === null || v === undefined ? '' : String(v));
      box.innerHTML = '<div class="card-title">v' + r.a + ' → v' + r.b + '</div>' + (r.changes.length ? r.changes.map(c => '<h4 class="lab-muted mt-3">' + esc(c.field) + '</h4>' + LabDiff.html(show(c.from), show(c.to))).join('') : '<p class="lab-muted">No differences.</p>');
    });
    main.querySelectorAll('[data-accept]').forEach(b => { b.onclick = () => act(b, async () => { await post('/profiles/' + p.id + '/versions/' + b.dataset.accept + '/accept'); notify('Version ' + b.dataset.accept + ' is now current', 'success'); Lab.route(); }); });
    main.querySelectorAll('[data-reject]').forEach(b => { b.onclick = () => act(b, async () => { await post('/profiles/' + p.id + '/versions/' + b.dataset.reject + '/reject'); Lab.route(); }); });
    main.querySelectorAll('[data-restore]').forEach(b => { b.onclick = () => act(b, async () => { const r = await post('/profiles/' + p.id + '/restore', { version: Number(b.dataset.restore) }); notify('Restored as version ' + r.profile.currentVersion, 'success'); Lab.route(); }); });
  });

  /* ── Models ───────────────────────────────── */
  Lab.view('models', async main => {
    const m = await Lab.loadModels(true);
    const cap = v => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>Models</h2><p>The model providers this server offers and what each can do — as reported by the integration, never assumed.</p></div><button class="btn btn-secondary btn-sm" id="md-refresh">Refresh</button></div>' +
      m.providers.map(p => '<div class="card lab-section"><div class="card-title">' + esc(p.label) + '</div>' +
        '<p class="lab-second">Chat: ' + cap(p.capabilities.chat) + ' · streaming: ' + cap(p.capabilities.streaming) + ' · embeddings: ' + cap(p.capabilities.embeddings) + ' · fine-tuning: ' + cap(p.capabilities.fineTuning) + ' · usage reporting: ' + esc(p.capabilities.usageReporting) + '</p>' +
        (p.problem ? '<div class="lab-warn mt-3">' + esc(p.problem) + '</div>' : '') +
        (p.models.length ? '<div class="table-wrap mt-3"><table class="table"><thead><tr><th>Model</th><th>Offered now</th><th>Tool calling</th><th>Context window</th><th>Price (per 1M tokens)</th></tr></thead><tbody>' +
          p.models.map(x => '<tr><td>' + esc(x.name) + (x.isDefault ? ' <span class="badge badge-blue">default</span>' : '') + '<div class="lab-mono lab-muted">' + esc(x.id) + '</div></td>' +
            '<td>' + (x.available === true ? 'yes' : x.available === false ? '<span class="badge badge-amber" title="Listed in this server\'s catalog, but not in the provider\'s own model list right now">not listed by the provider</span>' : 'unknown') + '</td>' +
            '<td>' + cap(x.capabilities.toolCalling) + '</td><td>' + (x.contextWindow ? fmt(x.contextWindow) : 'unknown') + '</td>' +
            '<td>' + (x.pricing ? esc(x.pricing.currency) + ' ' + x.pricing.input + ' in / ' + x.pricing.output + ' out <span class="lab-muted">(as of ' + esc(x.pricing.asOf || '?') + ')</span>' : '<span class="lab-muted">unknown</span>') + '</td></tr>').join('') + '</tbody></table></div>' : '') + '</div>').join('') +
      '<div class="lab-note">' + esc(m.notes.contextWindow || '') + ' Prices come from this server\'s price list' + (m.pricing.configured ? ' (as of ' + esc(m.pricing.asOf || '?') + ')' : ' — none is configured, so costs show as unknown') + '. Generated code is never run on this server (code execution: off).</div>';
    $('md-refresh').onclick = () => Lab.route();
  });

  /* ── Usage ────────────────────────────────── */
  Lab.view('usage', async main => {
    const u = await get('/usage');
    const rows = Object.keys(u.meters).map(k => { const m = u.meters[k]; const p = m.limit ? Math.min(100, Math.round(m.used / m.limit * 100)) : 0;
      return '<div class="lab-meter"><div class="lab-meter-top"><span>' + esc(m.label) + '</span><span><b>' + fmt(m.used) + '</b> of ' + fmt(m.limit) + ' ' + esc(m.unit) + ' · resets ' + when(m.resetsAt) + '</span></div><div class="lab-bar" role="progressbar" aria-label="' + esc(m.label) + '" aria-valuemin="0" aria-valuemax="' + m.limit + '" aria-valuenow="' + m.used + '"><span style="width:' + p + '%"></span></div></div>'; }).join('');
    const sp = u.storage.limitBytes ? Math.min(100, Math.round(u.storage.usedBytes / u.storage.limitBytes * 100)) : 0;
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>Usage</h2><p>Your Ultra plan\'s fair-use allowance for the Lab, and what your conversations and evaluations used.</p></div></div>' +
      '<div class="lab-grid-2"><div class="card"><div class="card-title">Allowance</div>' + rows +
        '<div class="lab-meter"><div class="lab-meter-top"><span>Storage</span><span><b>' + fmt(Math.round(u.storage.usedBytes / 1048576 * 10) / 10) + '</b> of ' + fmt(Math.round(u.storage.limitBytes / 1048576)) + ' MB</span></div><div class="lab-bar"><span style="width:' + sp + '%"></span></div></div></div>' +
      '<div class="card"><div class="card-title">Tokens and cost</div><dl class="lab-kv"><dt>Prompt tokens</dt><dd>' + fmt(u.tokens.prompt) + '</dd><dt>Answer tokens</dt><dd>' + fmt(u.tokens.completion) + '</dd>' +
        '<dt>Answers with provider-reported usage</dt><dd>' + fmt(u.tokens.answersWithMeasuredUsage) + '</dd><dt>Answers with estimated usage</dt><dd>' + fmt(u.tokens.answersWithEstimatedUsage) + '</dd>' +
        '<dt>Estimated cost</dt><dd>' + esc(Lab.money(u.cost)) + (u.cost.unknownParts ? ' <span class="lab-muted">(' + fmt(u.cost.unknownParts) + ' item(s) without a known price)</span>' : '') + '</dd></dl><p class="lab-muted mt-3">' + esc(u.notes) + '</p></div></div>' +
      '<div class="card mt-3"><div class="card-title">Your data</div><p class="lab-second">Download everything you have in the Lab, or delete it all.</p><div class="lab-actions mt-3"><button class="btn btn-secondary btn-sm" id="us-exp">Export all (JSON)</button><button class="btn btn-danger btn-sm" id="us-del">Delete all Lab data…</button></div></div>';
    $('us-exp').onclick = () => Lab.download('/export', 'metacode-ai-lab-export.json');
    $('us-del').onclick = async () => { if (await confirmDanger('Delete all AI Coding Lab data?', 'Projects, profiles, conversations, documents, datasets, suites, runs and fine-tuning records are deleted. This can\'t be undone.', 'Delete everything')) act(null, async () => { await del('/data', { confirm: 'DELETE' }); await Lab.loadProjects(); notify('All Lab data deleted', 'success'); Lab.go('overview'); }); };
  });

  /* ── Documentation ────────────────────────── */
  Lab.view('docs', async main => {
    main.innerHTML = '<div class="lab-head"><div><h2>How the AI Coding Lab works</h2><p>What each part does — and what it doesn\'t.</p></div></div><div class="lab-grid-2">' +
      card('Five different things', '<dl class="lab-kv"><dt>Prompt engineering</dt><dd>Changing the instructions sent to an existing model (coding profiles).</dd><dt>Context engineering</dt><dd>Choosing what information the model sees (project instructions, conversation window, summaries).</dd>' +
        '<dt>Retrieval</dt><dd>Finding relevant passages in your knowledge base at question time (keyword search) and sending them along.</dd><dt>Evaluation</dt><dd>Measuring answers against tasks and checks you defined.</dd><dt>Fine-tuning</dt><dd>Training a model so its parameters change. Only through a provider that offers it; the others change nothing in the model.</dd></dl>') +
      card('What a model is sent', '<ol class="lab-steps"><li>MetaCode\'s rules (reference text is data, no claims of running code, no secrets)</li><li>The coding profile version</li><li>The project\'s instructions and stack</li><li>Retrieved passages from this project only, marked as untrusted reference</li><li>A summary of older messages, if you made one</li><li>The recent messages that fit, and your new message</li></ol><p class="lab-muted mt-3">Each answer shows what was included. Token counts before sending are estimates.</p>') +
      card('Evaluation metrics', '<dl class="lab-kv"><dt>Graded</dt><dd>Answers with at least one check that ran.</dd><dt>Pass rate</dt><dd>Graded answers whose checks all passed ÷ graded answers. "Tests passed" isn\'t "correct and secure".</dd>' +
        '<dt>Syntax checks</dt><dd>The code parses (JavaScript, Python, JSON). It is never run.</dd><dt>Unit tests</dt><dd>Skipped: this server never executes generated code.</dd><dt>AI-graded</dt><dd>A model\'s score against your criteria — an opinion, not ground truth.</dd>' +
        '<dt>Consistency</dt><dd>With repeats: tasks whose attempts all passed or all failed. One attempt per task can\'t separate a real change from sampling noise.</dd><dt>Cost</dt><dd>Estimated from this server\'s price list, or unknown. Never an amount charged.</dd></dl>') +
      card('Improving a profile, honestly', '<ol class="lab-steps"><li>Run a suite with the current profile (the baseline).</li><li>"Suggest an improvement": a model proposes specific changes from the failures, with reasons.</li><li>The proposal becomes a candidate version — not used anywhere yet.</li><li>Run the same suite with the candidate and compare: regressions and improvements per task.</li><li>Accept or reject. Nothing is accepted because a model says it\'s better.</li></ol>') +
      card('Your data and security', '<ul class="lab-list"><li>Only you can see your projects, documents, conversations, datasets and runs.</li><li>Knowledge files that look like keys are refused; likely secrets are redacted before storage.</li><li>Text in documents that tries to instruct the AI is flagged and only ever used as data.</li><li>Model answers are untrusted: review code before using it. MetaCode doesn\'t write to your repository.</li><li>Export or delete all of your Lab data under Usage.</li></ul>') +
      '</div>';
  });
  const card = (title, html) => '<div class="card"><div class="card-title">' + esc(title) + '</div>' + html + '</div>';
})();
