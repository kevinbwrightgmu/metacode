/* ══════════════════════════════════════════════
   lab-evals.js — Evaluations

   Suites (a frozen dataset version + checks), runs (one profile version and
   one model over every task, with real progress from the server), per-task
   results, comparisons with regressions and improvements, and the
   "suggest an improvement" loop that produces a candidate profile version —
   never an automatically accepted one.
   ══════════════════════════════════════════════ */

(() => {
  'use strict';
  const { esc, fmt, pct, when, get, post, put, patch, del, act, notify, openModal, closeModal, confirmDanger, $ } = Lab;
  const field = (l, c) => Lab.field(l, c);
  const badge = s => Lab.badge(s);
  const ACTIVE = ['queued', 'running'];

  /* ── Suites and recent runs ──────────────── */
  Lab.view('evaluations', async main => {
    const [suites, runs, datasets] = await Promise.all([get('/suites').then(r => r.suites), get('/runs').then(r => r.runs), get('/datasets').then(r => r.datasets)]);
    const dsName = id => (datasets.find(d => d.id === id) || { name: '(deleted dataset)' }).name;
    const suiteName = id => (suites.find(s => s.id === id) || { name: '(deleted suite)' }).name;
    const cfgOf = s => s.versions.find(v => v.version === s.currentVersion).config;
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>Evaluations</h2><p>Measure whether a profile, a model or a setting change makes answers better on <b>your</b> tasks. A suite pins a dataset version, so runs of the same suite are comparable.</p></div>' +
      '<button class="btn btn-primary" id="ev-new">New suite</button></div>' +
      '<div class="card lab-section"><div class="card-title">Suites</div>' + (suites.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Suite</th><th>Dataset</th><th>Split</th><th>Repeats</th><th>Extra checks</th><th>Updated</th></tr></thead><tbody>' +
        suites.map(s => { const c = cfgOf(s); return '<tr><td><a href="#suite/' + esc(s.id) + '"><b>' + esc(s.name) + '</b></a> <span class="lab-muted">v' + s.currentVersion + '</span></td><td>' + esc(dsName(c.datasetId)) + ' <span class="lab-muted">v' + c.datasetVersion + '</span></td>' +
          '<td>' + esc(c.split) + '</td><td>' + c.repeats + '</td><td>' + fmt(c.checks.length) + '</td><td>' + when(s.updatedAt) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<p class="lab-muted">' + (datasets.some(d => d.versions.length) ? 'No suites yet.' : 'A suite needs a committed dataset version. <a href="#training">Build a dataset</a> first.') + '</p>') + '</div>' +
      '<div class="card"><div class="card-title">Recent runs</div>' + runsTable(runs.slice(0, 30), r => suiteName(r.suiteId)) + '</div>';
    $('ev-new').onclick = () => Lab.background(suiteForm(null, datasets));
    wireRunsTable(main);
  });

  // nameOf(run) → the link text of each run
  function runsTable(runs, nameOf) {
    if (!runs.length) return '<p class="lab-muted">No runs yet.</p>';
    return '<div class="table-wrap"><table class="table"><thead><tr><th><span class="lab-visually-hidden">Select</span></th><th>Run</th><th>Profile</th><th>Model</th><th>Status</th><th>Pass rate</th><th>Started</th></tr></thead><tbody>' +
      runs.map(r => '<tr><td><input type="checkbox" data-pick="' + esc(r.id) + '" data-created="' + esc(r.createdAt) + '"' + (r.metrics ? '' : ' disabled') + ' aria-label="Select run for comparison"></td>' +
        '<td><a href="#run/' + esc(r.id) + '">' + esc(nameOf(r)) + '</a>' + (r.note ? '<div class="lab-muted">' + esc(r.note) + '</div>' : '') + '</td>' +
        '<td>' + (r.profileId ? '<a href="#profile/' + esc(r.profileId) + '">v' + r.profileVersion + '</a>' : '<span class="lab-muted">none</span>') + '</td><td>' + esc(r.model) + '</td>' +
        '<td>' + badge(r.status) + (ACTIVE.includes(r.status) ? ' <span class="lab-muted">' + fmt(r.progress.done) + ' / ' + fmt(r.progress.total) + '</span>' : '') + '</td>' +
        '<td>' + (r.metrics ? pct(r.metrics.passRate) + ' <span class="lab-muted">of ' + fmt(r.metrics.graded) + ' graded</span>' : '—') + '</td><td>' + when(r.createdAt) + '</td></tr>').join('') +
      '</tbody></table></div><div class="lab-actions mt-3"><button class="btn btn-secondary btn-sm" id="rt-cmp" disabled>Compare selected (2)</button><span class="lab-muted">Pick two runs with results: the older one is the baseline.</span></div>';
  }
  function wireRunsTable(root) {
    const btn = root.querySelector('#rt-cmp');
    if (!btn) return;
    const picks = () => Array.from(root.querySelectorAll('[data-pick]')).filter(x => x.checked);
    root.querySelectorAll('[data-pick]').forEach(cb => { cb.onchange = () => { btn.disabled = picks().length !== 2; }; });
    btn.onclick = () => { const p = picks().sort((a, b) => (a.dataset.created < b.dataset.created ? -1 : 1)); Lab.go('compare/' + p[0].dataset.pick + '/' + p[1].dataset.pick); };
  }

  const CHECK_HELP = 'Checks applied to every task, in addition to each example\'s own. JSON array, e.g. [{"type":"code_block"}, {"type":"not_contains","values":["eval("]}, {"type":"ai_rubric","criteria":"Handles errors explicitly"}]. ' +
    'syntax only parses code; unit_tests is always skipped (generated code is never run); ai_rubric is graded by a model and labelled AI-graded.';

  // Grading models are named by id; they run through the run's provider
  function judgeOptions(selected) {
    const ids = [];
    ((Lab.state.models && Lab.state.models.providers) || []).forEach(p => p.models.forEach(m => { if (!ids.includes(m.id)) ids.push(m.id); }));
    if (selected && !ids.includes(selected)) ids.push(selected);
    return ids.map(id => '<option value="' + esc(id) + '"' + (id === selected ? ' selected' : '') + '>' + esc(id) + '</option>').join('');
  }

  async function suiteForm(s, datasets) {
    datasets = datasets || (await get('/datasets')).datasets;
    const usable = datasets.filter(d => d.versions.length);
    if (!usable.length) { notify('Commit a dataset version first (Training Studio).', 'info', 5000); return; }
    const c = s ? s.versions.find(v => v.version === s.currentVersion).config : { datasetId: usable[0].id, datasetVersion: null, split: 'test', repeats: 1, retrieval: { enabled: false, k: 4 }, checks: [], judgeModel: null };
    await Lab.loadModels();
    openModal(s ? 'Edit suite (new version)' : 'New evaluation suite',
      (s ? '' : field('Name', '<input class="form-input" name="name" maxlength="120">')) +
      '<div class="lab-row">' + field('Dataset', '<select class="form-select" name="datasetId" id="sf-ds">' + usable.map(d => '<option value="' + esc(d.id) + '"' + (d.id === c.datasetId ? ' selected' : '') + '>' + esc(d.name) + '</option>').join('') + '</select>') +
        field('Version', '<select class="form-select" name="datasetVersion" id="sf-v"></select>') +
        field('Split', '<select class="form-select" name="split">' + ['test', 'validation', 'train', 'all'].map(x => '<option' + (c.split === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select>') +
        field('Repeats <span>(1–5)</span>', '<input class="form-input" type="number" name="repeats" min="1" max="5" value="' + c.repeats + '">') + '</div>' +
      '<p class="form-hint">Repeats ask each task several times, so you can tell a real change from sampling randomness.</p>' +
      '<div class="lab-row">' + field('Use project knowledge', '<select class="form-select" name="retrieval"><option value="no">No</option><option value="yes"' + (c.retrieval.enabled ? ' selected' : '') + '>Yes (the suite\'s project)</option></select>') +
        field('Passages per task', '<input class="form-input" type="number" name="k" min="1" max="12" value="' + c.retrieval.k + '">') +
        field('Grading model <span>(AI rubric checks, same provider as the run)</span>', '<select class="form-select" name="judge"><option value="">The run\'s model</option>' + judgeOptions(c.judgeModel) + '</select>') + '</div>' +
      field('Extra checks <span>(JSON)</span>', '<textarea class="form-textarea lab-mono" name="checks" rows="4">' + esc(c.checks.length ? JSON.stringify(c.checks, null, 2) : '') + '</textarea><p class="form-hint">' + esc(CHECK_HELP) + '</p>') +
      (s ? field('What changed', '<input class="form-input" name="note" maxlength="500">') : ''),
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="sf-save">' + (s ? 'Save new version' : 'Create suite') + '</button>');
    const fill = () => { const d = usable.find(x => x.id === $('sf-ds').value); $('sf-v').innerHTML = d.versions.slice().reverse().map(v => '<option value="' + v.version + '"' + (v.version === c.datasetVersion ? ' selected' : '') + '>v' + v.version + ' · ' + fmt(v.count) + ' examples</option>').join(''); };
    fill();
    $('sf-ds').onchange = fill;
    $('sf-save').onclick = e => act(e.target, async () => {
      const f = Lab.formValues($('modal-body'));
      let checks = [];
      if (f.checks.trim()) { try { checks = JSON.parse(f.checks); } catch (err) { throw new Error('The checks aren\'t valid JSON: ' + err.message); } if (!Array.isArray(checks)) throw new Error('Checks must be a JSON array.'); }
      const config = { datasetId: f.datasetId, datasetVersion: Number(f.datasetVersion), split: f.split, repeats: Number(f.repeats), retrieval: { enabled: f.retrieval === 'yes', k: Number(f.k) }, checks, judgeModel: f.judge || null };
      if (s) {
        const r = await put('/suites/' + s.id, { config, note: f.note });
        notify(r.created ? 'Saved as suite version ' + r.created : 'Nothing changed — no new version', r.created ? 'success' : 'info');
        closeModal(); Lab.route();
      } else {
        const r = await post('/suites', { name: f.name, projectId: Lab.state.projectId, config });
        closeModal();
        notify('Suite created with ' + fmt(r.tasks) + ' task(s)', 'success');
        Lab.go('suite/' + r.suite.id);
      }
    });
  }

  /* ── One suite ───────────────────────────── */
  Lab.view('suite', async (main, [id]) => {
    const { suite: s, tasks } = await get('/suites/' + encodeURIComponent(id));
    const [runs, profiles, datasets] = await Promise.all([get('/runs?suiteId=' + s.id).then(r => r.runs), get('/profiles').then(r => r.profiles), get('/datasets').then(r => r.datasets), Lab.loadModels()]);
    const c = s.versions.find(v => v.version === s.currentVersion).config;
    const ds = datasets.find(d => d.id === c.datasetId);
    const def = Lab.defaultModel();
    const proj = Lab.state.projects.find(p => p.id === s.projectId);
    const defProfile = proj && proj.defaultProfileId ? proj.defaultProfileId : (profiles[0] && profiles[0].id);
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>' + esc(s.name) + ' <span class="badge badge-violet">v' + s.currentVersion + '</span></h2><p>' + fmt(tasks) + ' task(s) × ' + c.repeats + ' repeat(s) from ' + esc(ds ? ds.name : '(deleted dataset)') + ' v' + c.datasetVersion + ', split "' + esc(c.split) + '".</p></div>' +
      '<div class="lab-actions"><button class="btn btn-secondary btn-sm" id="su-edit">Edit (new version)</button><button class="btn btn-ghost btn-sm" id="su-rename">Rename</button><button class="btn btn-ghost btn-sm" id="su-del">Delete</button></div></div>' +
      '<div class="lab-grid-2 lab-section"><div class="card"><div class="card-title">Run this suite</div><div id="su-form">' +
        field('Coding profile', '<select class="form-select" name="profileId" id="su-prof"><option value="">None (the model\'s defaults)</option>' + profiles.map(p => '<option value="' + esc(p.id) + '"' + (p.id === defProfile ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select>') +
        field('Profile version', '<select class="form-select" name="profileVersion" id="su-pv"></select>') +
        field('Model', '<select class="form-select" name="model">' + Lab.modelOptions(def ? def.provider + '|' + def.model : '') + '</select>') +
        '<div class="lab-row">' + field('Temperature <span>(blank: profile, else 0)</span>', '<input class="form-input" type="number" name="temperature" min="0" max="2" step="0.1">') +
          field('Max answer tokens <span>(blank: profile, else 2048)</span>', '<input class="form-input" type="number" name="maxTokens" min="64" max="32000">') + '</div>' +
        field('Note', '<input class="form-input" name="note" maxlength="500" placeholder="e.g. baseline, or what you changed">') + '</div>' +
        '<div class="lab-actions mt-3"><button class="btn btn-primary btn-sm" id="su-run">Start run</button><span class="lab-muted">Uses ' + fmt(tasks * c.repeats) + ' model request(s) from your allowance' + (c.checks.some(x => x.type === 'ai_rubric') ? ', plus grading requests' : '') + '.</span></div></div>' +
      '<div class="card"><div class="card-title">Configuration (v' + s.currentVersion + ')</div><dl class="lab-kv"><dt>Dataset</dt><dd>' + (ds ? '<a href="#dataset/' + esc(ds.id) + '">' + esc(ds.name) + '</a>' : '(deleted)') + ' v' + c.datasetVersion + '</dd>' +
        '<dt>Split</dt><dd>' + esc(c.split) + '</dd><dt>Repeats</dt><dd>' + c.repeats + '</dd><dt>Knowledge</dt><dd>' + (c.retrieval.enabled ? c.retrieval.k + ' passages per task' : 'not used') + '</dd>' +
        '<dt>Grading model</dt><dd>' + esc(c.judgeModel || 'the run\'s model') + '</dd><dt>Extra checks</dt><dd>' + (c.checks.length ? c.checks.map(x => esc(x.label || x.type)).join(', ') : 'none (each example\'s own checks apply)') + '</dd></dl>' +
        (s.versions.length > 1 ? '<h4 class="lab-muted mt-3">Versions</h4><ul class="lab-list">' + s.versions.slice().reverse().map(v => '<li><span>v' + v.version + ' ' + esc(v.note || '') + '</span><span class="lab-muted">' + when(v.createdAt) + '</span></li>').join('') + '</ul>' : '') + '</div></div>' +
      '<div class="card"><div class="card-title">Runs of this suite</div>' + runsTable(runs, r => r.model + ' · ' + when(r.createdAt)) + '</div>';
    wireRunsTable(main);
    const fillPv = () => {
      const p = profiles.find(x => x.id === $('su-prof').value);
      $('su-pv').disabled = !p;
      $('su-pv').innerHTML = p ? '<option value="">Current (v' + p.currentVersion + ')</option>' + Array.from({ length: p.versionCount }, (_, i) => p.versionCount - i).map(v => '<option value="' + v + '">v' + v + (p.candidates.includes(v) ? ' (candidate)' : '') + '</option>').join('') : '<option value="">—</option>';
    };
    fillPv();
    $('su-prof').onchange = fillPv;
    $('su-run').onclick = e => act(e.target, async () => {
      const f = Lab.formValues($('su-form'));
      const [provider, model] = (f.model || '').split('|');
      const r = await post('/runs', { suiteId: s.id, profileId: f.profileId || null, profileVersion: f.profileVersion ? Number(f.profileVersion) : null, provider, model,
        temperature: f.temperature === '' ? null : Number(f.temperature), maxTokens: f.maxTokens === '' ? null : Number(f.maxTokens), note: f.note });
      Lab.go('run/' + r.run.id);
    });
    $('su-edit').onclick = () => Lab.background(suiteForm(s, datasets));
    $('su-rename').onclick = () => {
      openModal('Rename suite', field('Name', '<input class="form-input" name="name" maxlength="120" value="' + esc(s.name) + '">'), '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="su-rn">Rename</button>');
      $('su-rn').onclick = ev => act(ev.target, async () => { await patch('/suites/' + s.id, { name: Lab.formValues($('modal-body')).name }); closeModal(); Lab.route(); });
    };
    $('su-del').onclick = async () => { if (await confirmDanger('Delete suite?', 'The suite is deleted. Its runs keep their results.')) act(null, async () => { await del('/suites/' + s.id); Lab.go('evaluations'); }); };
  });

  /* ── One run ─────────────────────────────── */
  const R = { filter: 'all', offset: 0, runId: null };

  function metricCards(m) {
    const card = (value, label, def) => '<div class="lab-metric"><b>' + value + '</b><span>' + esc(label) + '</span><small>' + esc(def) + '</small></div>';
    return '<div class="lab-metrics">' +
      card(pct(m.passRate), 'Pass rate', 'Graded tasks whose checks all passed ÷ graded tasks (' + fmt(m.passed) + ' of ' + fmt(m.graded) + ').') +
      card(pct(m.weightedPassRate), 'Weighted pass rate', 'The same, weighting each task by its weight.') +
      card(fmt(m.graded) + ' / ' + fmt(m.attempts), 'Graded', 'Answers with at least one check that ran. Others have no checks, or only skipped ones.') +
      card(fmt(m.errored), 'Errors', 'Requests that failed (no answer to check).') +
      (m.aiGraded ? card((Math.round(m.aiGraded.meanScore * 100) / 100).toString(), 'AI-graded score', 'Mean rubric score from a model over ' + fmt(m.aiGraded.graded) + ' answer(s): an opinion, not ground truth.') : '') +
      (m.consistency ? card(fmt(m.consistency.consistent) + ' / ' + fmt(m.consistency.tasks), 'Consistent tasks', 'Tasks whose repeats all passed or all failed.') : '') +
      card(Lab.ms(m.latency.p50Ms) + ' · ' + Lab.ms(m.latency.p95Ms), 'Latency p50 · p95', 'Time per answer.') +
      card(fmt(m.tokens.prompt + m.tokens.completion), 'Tokens', fmt(m.tokens.prompt) + ' prompt + ' + fmt(m.tokens.completion) + ' answer; ' + pct(m.tokens.measuredShare) + ' reported by the provider, the rest estimated.') +
      card(esc(Lab.money(m.cost)), 'Estimated cost', 'From this server\'s price list; never an amount charged.') +
      '</div>';
  }

  Lab.view('run', async (main, [id]) => {
    if (R.runId !== id) Object.assign(R, { filter: 'all', offset: 0, runId: id });
    const run = (await get('/runs/' + encodeURIComponent(id))).run;
    let suite = null, tasks = new Map(), profile = null;
    try { suite = (await get('/suites/' + run.suiteId)).suite; } catch (e) { suite = null; }
    if (run.profileId) { try { profile = (await get('/profiles/' + run.profileId)).profile; } catch (e) { profile = null; } }
    try {
      const sv = suite && suite.versions.find(v => v.version === run.suiteVersion);
      const qs = new URLSearchParams({ version: String(run.datasetVersion), limit: '500' });
      if (sv && sv.config.split !== 'all') qs.set('split', sv.config.split);
      (await get('/datasets/' + run.datasetId + '?' + qs)).examples.forEach(e => tasks.set(e.id, e));
    } catch (e) { tasks = new Map(); }
    const active = ACTIVE.includes(run.status);
    const canResume = ['interrupted', 'cancelled', 'failed'].includes(run.status) && !run.active;
    const share = run.progress.total ? Math.round(run.progress.done / run.progress.total * 100) : 0;
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>' + (suite ? '<a href="#suite/' + esc(suite.id) + '">' + esc(suite.name) + '</a>' : 'Evaluation run') + ' · ' + esc(run.model) + ' ' + badge(run.status) + '</h2>' +
        '<p>' + (run.profileId ? 'Profile ' + (profile ? '<a href="#profile/' + esc(profile.id) + '">' + esc(profile.name) + '</a>' : '(deleted)') + ' v' + run.profileVersion : 'No profile') + ' · ' + esc(run.provider) + ' · temperature ' + (run.settings.temperature === null ? 'default' : run.settings.temperature) +
        ' · ' + fmt(run.settings.maxTokens) + ' max tokens · dataset v' + run.datasetVersion + ' · suite v' + run.suiteVersion + (run.note ? ' · ' + esc(run.note) : '') + '</p></div>' +
      '<div class="lab-actions">' + (active ? '<button class="btn btn-secondary btn-sm" id="rn-cancel">Cancel</button>' : '') + (canResume ? '<button class="btn btn-primary btn-sm" id="rn-resume">Resume</button>' : '') +
        (run.status === 'completed' && run.profileId ? '<button class="btn btn-primary btn-sm" id="rn-suggest">Suggest an improvement</button>' : '') +
        (run.metrics ? '<button class="btn btn-ghost btn-sm" id="rn-cmp">Compare with…</button>' : '') + '<button class="btn btn-ghost btn-sm" id="rn-del">Delete</button></div></div>' +
      (run.error ? '<div class="lab-error lab-section" role="alert">' + esc(run.error.message) + '</div>' : '') +
      '<div class="card lab-section"><div class="lab-meter-top"><span>Progress</span><span><b>' + fmt(run.progress.done) + '</b> of ' + fmt(run.progress.total) + ' answers' + (run.finishedAt ? ' · finished ' + when(run.finishedAt) : run.startedAt ? ' · started ' + when(run.startedAt) : ' · waiting to start') + '</span></div>' +
        '<div class="lab-bar" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax="' + run.progress.total + '" aria-valuenow="' + run.progress.done + '"><span style="width:' + share + '%"></span></div>' +
        (active ? '<p class="lab-muted mt-3">Updates every few seconds. Finished answers are saved as they arrive; a cancelled or interrupted run can be resumed.</p>' : '') + '</div>' +
      (run.metrics ? '<div class="lab-section">' + metricCards(run.metrics) + '</div>' +
        '<div class="lab-grid-2 lab-section"><div class="card"><div class="card-title">By check</div>' + (Object.keys(run.metrics.byCheck).length ? '<div class="table-wrap"><table class="table"><thead><tr><th>Check</th><th>Pass</th><th>Fail</th><th>Skipped</th><th>Error</th></tr></thead><tbody>' +
          Object.keys(run.metrics.byCheck).map(k => { const b = run.metrics.byCheck[k]; return '<tr><td>' + esc(k) + (k === 'ai_rubric' ? ' <span class="badge badge-violet">AI-graded</span>' : '') + '</td><td class="lab-pass">' + fmt(b.pass) + '</td><td class="lab-fail">' + fmt(b.fail) + '</td><td>' + fmt(b.skipped) + '</td><td>' + fmt(b.error) + '</td></tr>'; }).join('') + '</tbody></table></div>'
          : '<p class="lab-muted">No checks ran. Add checks or expected outputs to the examples, or extra checks to the suite.</p>') + '</div>' +
        '<div class="card"><div class="card-title">Where it failed</div>' + (Object.keys(run.metrics.failureCategories).length ? '<ul class="lab-list">' + Object.entries(run.metrics.failureCategories).sort((a, b) => b[1] - a[1]).map(([k, n]) => '<li><span>' + esc(k.replace(/^error:/, 'request error: ')) + '</span><span>' + fmt(n) + '</span></li>').join('') + '</ul>' : '<p class="lab-muted">No failures.</p>') + '</div></div>' : '') +
      '<div class="card"><div class="card-title">Answers</div><div class="lab-tabs" role="tablist">' + [['all', 'All'], ['failed', 'Failed'], ['passed', 'Passed'], ['errors', 'Errors'], ['ungraded', 'Ungraded']].map(([k, l]) => '<button type="button" class="lab-tab" role="tab" data-rf="' + k + '" aria-selected="' + (R.filter === k) + '">' + l + '</button>').join('') + '</div><div id="rn-results"></div></div>';
    main.querySelectorAll('[data-rf]').forEach(b => { b.onclick = () => { R.filter = b.dataset.rf; R.offset = 0; main.querySelectorAll('[data-rf]').forEach(x => x.setAttribute('aria-selected', String(x === b))); Lab.background(renderResults(run, tasks)); }; });
    Lab.background(renderResults(run, tasks));
    if ($('rn-cancel')) $('rn-cancel').onclick = e => act(e.target, async () => { await post('/runs/' + run.id + '/cancel'); Lab.route(); });
    if ($('rn-resume')) $('rn-resume').onclick = e => act(e.target, async () => { await post('/runs/' + run.id + '/resume'); notify('Resumed: only the tasks without a result are asked again', 'success'); Lab.route(); });
    if ($('rn-suggest')) $('rn-suggest').onclick = e => Lab.background(suggest(e.target, run, profile));
    if ($('rn-cmp')) $('rn-cmp').onclick = () => Lab.background(compareWith(run));
    $('rn-del').onclick = async () => { if (await confirmDanger('Delete run?', 'Its results are deleted.')) act(null, async () => { await del('/runs/' + run.id); Lab.go(suite ? 'suite/' + suite.id : 'evaluations'); }); };
    if (active) {
      const t = setTimeout(() => { if (location.hash === '#run/' + run.id) Lab.route(); }, 2500);
      Lab.onLeave(() => clearTimeout(t));
    }
  });

  async function renderResults(run, tasks) {
    const box = $('rn-results');
    const r = await get('/runs/' + run.id + '/results?filter=' + R.filter + '&offset=' + R.offset + '&limit=25');
    if (!box.isConnected) return;
    const stateOf = x => x.error ? '<span class="badge badge-red">error</span>' : x.passed ? '<span class="badge badge-green">passed</span>' : x.checks.some(c => c.status === 'pass' || c.status === 'fail') ? '<span class="badge badge-amber">failed</span>' : '<span class="badge badge-gray">ungraded</span>';
    box.innerHTML = r.results.length ? r.results.map((x, i) => {
      const t = tasks.get(x.taskId);
      return '<details class="lab-result"' + (i === 0 && R.filter === 'failed' ? ' open' : '') + '><summary>' + stateOf(x) + ' <b>' + esc(t ? t.task.slice(0, 160) : x.taskId) + '</b>' + (x.repeat > 1 ? ' <span class="lab-muted">repeat ' + x.repeat + '</span>' : '') +
          ' <span class="lab-muted">' + (x.latencyMs !== null ? Lab.ms(x.latencyMs) : '') + '</span></summary>' +
        '<div class="lab-grid-2 mt-3"><div>' + (x.error ? '<div class="lab-error">' + esc(x.error.message) + '</div>' : '<h4 class="lab-muted">Answer</h4><div class="lab-result-out" data-out="' + i + '"></div>') + '</div>' +
          '<div><h4 class="lab-muted">Checks</h4>' + (x.checks.length ? x.checks.map(c => '<div class="lab-check"><b class="' + (c.status === 'pass' ? 'lab-pass' : c.status === 'fail' || c.status === 'error' ? 'lab-fail' : 'lab-skip-t') + '">' + esc(c.status) + '</b><span><b>' + esc(c.label) + '</b>' +
              (c.method === 'ai_graded' ? ' <span class="badge badge-violet">AI-graded</span>' : '') + (typeof c.score === 'number' ? ' score ' + c.score : '') + '<br><span class="lab-muted">' + esc(c.detail) + '</span></span></div>').join('') : '<p class="lab-muted">No checks for this task.</p>') +
            (t && t.expected ? '<h4 class="lab-muted mt-3">Expected</h4><div class="lab-pre">' + esc(t.expected.slice(0, 4000)) + '</div>' : '') +
            (x.retrieved && x.retrieved.length ? '<p class="lab-muted mt-3">Knowledge passages sent: ' + fmt(x.retrieved.length) + '</p>' : '') + '</div></div></details>';
    }).join('') + '<div class="lab-actions mt-3"><span class="lab-muted">' + fmt(r.offset + 1) + '–' + fmt(r.offset + r.results.length) + ' of ' + fmt(r.total) + '</span>' +
        (r.offset > 0 ? '<button class="btn btn-ghost btn-sm" id="rr-prev">Previous</button>' : '') + (r.offset + r.results.length < r.total ? '<button class="btn btn-ghost btn-sm" id="rr-next">Next</button>' : '') + '</div>'
      : '<p class="lab-muted">' + (ACTIVE.includes(run.status) && R.filter === 'all' ? 'Answers appear here as they finish.' : 'Nothing in this view.') + '</p>';
    // Answers are rendered when opened (they can be long)
    box.querySelectorAll('details.lab-result').forEach(dt => {
      const fill = () => { const out = dt.querySelector('[data-out]'); if (out && !out.dataset.done) { out.dataset.done = '1'; out.innerHTML = LabMarkdown.render(r.results[Number(out.dataset.out)].output); LabMarkdown.enhance(out, null); } };
      if (dt.open) fill();
      dt.addEventListener('toggle', fill);
    });
    if ($('rr-prev')) $('rr-prev').onclick = () => { R.offset = Math.max(0, R.offset - 25); Lab.background(renderResults(run, tasks)); };
    if ($('rr-next')) $('rr-next').onclick = () => { R.offset += 25; Lab.background(renderResults(run, tasks)); };
  }

  async function compareWith(run) {
    const runs = (await get('/runs?suiteId=' + run.suiteId)).runs.filter(r => r.id !== run.id && r.metrics);
    if (!runs.length) { notify('No other run of this suite has results yet.', 'info'); return; }
    openModal('Compare with another run', field('Other run', '<select class="form-select" id="cw-r">' + runs.map(r => '<option value="' + esc(r.id) + '" data-created="' + esc(r.createdAt) + '">' + esc(r.model) + (r.profileVersion ? ' · profile v' + r.profileVersion : '') + ' · ' + when(r.createdAt) + ' · ' + pct(r.metrics.passRate) + '</option>').join('') + '</select>'),
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="cw-go">Compare</button>');
    $('cw-go').onclick = () => {
      const other = runs.find(r => r.id === $('cw-r').value);
      closeModal();
      const [a, b] = other.createdAt < run.createdAt ? [other, run] : [run, other];
      Lab.go('compare/' + a.id + '/' + b.id);
    };
  }

  // Prompt optimisation: a candidate profile version from the run's failures
  async function suggest(btn, run, profile) {
    if (!profile) { notify('The run\'s profile was deleted.', 'error'); return; }
    await Lab.loadModels();
    openModal('Suggest an improvement', '<p class="lab-second">A model reads this run\'s failed checks and proposes specific changes to profile "' + esc(profile.name) + '" v' + run.profileVersion + '. The proposal becomes a <b>candidate</b> version: it is not used anywhere until you run the suite with it, compare, and accept it. It changes instructions, not the model\'s weights.</p>' +
      field('Model that writes the proposal', '<select class="form-select" id="sg-m">' + Lab.modelOptions(run.provider + '|' + run.model) + '</select>'),
      '<button class="btn btn-secondary" onclick="Lab.closeModal()">Cancel</button><button class="btn btn-primary" id="sg-go">Propose changes</button>');
    $('sg-go').onclick = e => act(e.target, async () => {
      const [provider, model] = $('sg-m').value.split('|');
      const r = await post('/runs/' + run.id + '/suggest', { provider, model });
      if (!r.candidate) { closeModal(); notify('The proposal didn\'t change anything — no candidate was created.', 'info', 6000); return; }
      const show = v => (Array.isArray(v) ? v.join('\n') : v === null || v === undefined ? '' : String(v));
      openModal('Candidate version ' + r.candidate, '<div class="lab-note">' + esc(r.note) + '</div>' +
        (r.rationale.summary ? '<h4 class="lab-muted mt-3">Why</h4><p class="lab-second">' + esc(r.rationale.summary) + '</p>' : '') +
        (r.rationale.changes && r.rationale.changes.length ? '<ul class="lab-list mt-3">' + r.rationale.changes.map(c => '<li><span><b>' + esc(c.field) + '</b>: ' + esc(c.reason || '') + '</span></li>').join('') + '</ul>' : '') +
        r.changes.map(c => '<h4 class="lab-muted mt-3">' + esc(c.field) + '</h4>' + LabDiff.html(show(c.from), show(c.to))).join(''),
        '<a class="btn btn-secondary" href="#profile/' + esc(profile.id) + '" onclick="Lab.closeModal()">Open profile</a><button class="btn btn-primary" id="sg-run">Run the suite with v' + r.candidate + '</button>');
      $('sg-run').onclick = ev => act(ev.target, async () => {
        const nr = await post('/runs', { suiteId: run.suiteId, profileId: profile.id, profileVersion: r.candidate, provider: run.provider, model: run.model, temperature: run.settings.temperature, maxTokens: run.settings.maxTokens, note: 'Candidate v' + r.candidate + ' (from run ' + run.id + ')' });
        closeModal();
        Lab.go('run/' + nr.run.id);
      });
    });
  }

  /* ── Comparison ──────────────────────────── */
  Lab.view('compare', async (main, [a, b]) => {
    const r = await get('/runs/compare?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b));
    if (!main.isConnected) return;
    if (!r.comparable) { main.innerHTML = '<div class="lab-head"><div><h2>These runs can\'t be compared</h2><p>' + esc(r.reason) + '</p></div></div><a class="btn btn-secondary" href="#run/' + esc(a) + '">Back to the run</a>'; return; }
    const [ra, rb] = await Promise.all([get('/runs/' + a).then(x => x.run), get('/runs/' + b).then(x => x.run)]);
    let profile = null;
    if (rb.profileId) { try { profile = (await get('/profiles/' + rb.profileId)).profile; } catch (e) { profile = null; } }
    const vB = profile && profile.versions.find(v => v.version === rb.profileVersion);
    const label = x => (x.profileVersion ? 'profile v' + x.profileVersion : 'no profile') + ' · ' + x.model;
    const delta = (x, fmtFn, goodWhenUp) => {
      if (x === null || x === undefined) return '—';
      const cls = x === 0 ? '' : (x > 0) === goodWhenUp ? 'lab-delta-pos' : 'lab-delta-neg';
      return '<span class="' + cls + '">' + (x > 0 ? '+' : '') + fmtFn(x) + '</span>';
    };
    const pp = x => (Math.round(x * 1000) / 10) + ' pts';
    const verdict = { better: 'B improved more tasks than it regressed', worse: 'B regressed more tasks than it improved', mixed: 'As many regressions as improvements', no_change: 'No task changed between pass and fail' }[r.verdict];
    const entry = (e, i, kind) => '<details class="lab-result"><summary><span class="badge ' + (kind === 'reg' ? 'badge-red' : 'badge-green') + '">' + (kind === 'reg' ? 'regressed' : 'improved') + '</span> <b>' + esc(e.task) + '</b>' + (e.category ? ' <span class="lab-muted">' + esc(e.category) + '</span>' : '') +
        ' <span class="lab-muted">passed ' + pct(e.passShareA) + ' → ' + pct(e.passShareB) + '</span></summary>' +
      (e.changedChecks.length ? '<div class="mt-3">' + e.changedChecks.map(c => '<div class="lab-check"><b>' + esc(c.from) + '→' + esc(c.to) + '</b><span><b>' + esc(c.label) + '</b><br><span class="lab-muted">' + esc(c.detail) + '</span></span></div>').join('') + '</div>' : '') +
      '<div class="lab-grid-2 mt-3"><div><h4 class="lab-muted">A · ' + esc(label(r.a)) + '</h4><div data-o="' + kind + i + 'a"></div></div><div><h4 class="lab-muted">B · ' + esc(label(r.b)) + '</h4><div data-o="' + kind + i + 'b"></div></div></div>' +
      '<button type="button" class="btn btn-ghost btn-sm mt-3" data-d="' + kind + i + '">Line diff of the answers</button><div data-dd="' + kind + i + '"></div></details>';
    if (!main.isConnected) return;
    main.innerHTML = '<div class="lab-head"><div><h2>A: ' + esc(label(r.a)) + ' → B: ' + esc(label(r.b)) + '</h2><p>' + esc(verdict) + ': <b>' + fmt(r.improvements.length) + '</b> improved, <b>' + fmt(r.regressions.length) + '</b> regressed, ' + fmt(r.unchanged) + ' unchanged' + (r.missing ? ', ' + fmt(r.missing) + ' without results in both' : '') + '.</p></div>' +
        '<div class="lab-actions"><a class="btn btn-ghost btn-sm" href="#run/' + esc(a) + '">Run A</a><a class="btn btn-ghost btn-sm" href="#run/' + esc(b) + '">Run B</a></div></div>' +
      (r.warnings.length ? '<div class="lab-warn lab-section"><b>Read with care:</b><ul>' + r.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul></div>' : '') +
      (vB && vB.status === 'candidate' ? '<div class="card lab-section"><div class="card-title">Decide on candidate v' + vB.version + ' of "' + esc(profile.name) + '"</div><p class="lab-second">Nothing is accepted automatically. Look at the regressions below before accepting.</p>' +
          '<div class="lab-actions mt-3"><button class="btn btn-primary btn-sm" id="cp-accept">Accept v' + vB.version + ' as current</button><button class="btn btn-ghost btn-sm" id="cp-reject">Reject</button></div></div>'
        : vB && profile.currentVersion !== vB.version && vB.status !== 'rejected' ? '<div class="card lab-section"><div class="card-title">Profile "' + esc(profile.name) + '"</div><p class="lab-second">B used v' + vB.version + '; the current version is v' + profile.currentVersion + '.</p><div class="lab-actions mt-3"><button class="btn btn-secondary btn-sm" id="cp-restore">Restore v' + vB.version + ' as current</button></div></div>' : '') +
      '<div class="table-wrap card lab-section"><table class="table"><thead><tr><th>Metric</th><th>A</th><th>B</th><th>Change</th></tr></thead><tbody>' +
        '<tr><td>Pass rate</td><td>' + pct(ra.metrics.passRate) + '</td><td>' + pct(rb.metrics.passRate) + '</td><td>' + delta(r.deltas.passRate, pp, true) + '</td></tr>' +
        '<tr><td>Weighted pass rate</td><td>' + pct(ra.metrics.weightedPassRate) + '</td><td>' + pct(rb.metrics.weightedPassRate) + '</td><td>' + delta(r.deltas.weightedPassRate, pp, true) + '</td></tr>' +
        '<tr><td>Graded answers</td><td>' + fmt(ra.metrics.graded) + '</td><td>' + fmt(rb.metrics.graded) + '</td><td></td></tr>' +
        '<tr><td>Errors</td><td>' + fmt(ra.metrics.errored) + '</td><td>' + fmt(rb.metrics.errored) + '</td><td></td></tr>' +
        '<tr><td>Median latency</td><td>' + Lab.ms(ra.metrics.latency.p50Ms) + '</td><td>' + Lab.ms(rb.metrics.latency.p50Ms) + '</td><td>' + delta(r.deltas.p50Ms, Lab.ms, false) + '</td></tr>' +
        '<tr><td>Tokens</td><td>' + fmt(ra.metrics.tokens.prompt + ra.metrics.tokens.completion) + '</td><td>' + fmt(rb.metrics.tokens.prompt + rb.metrics.tokens.completion) + '</td><td>' + delta(r.deltas.tokens, fmt, false) + '</td></tr>' +
        '<tr><td>Estimated cost</td><td>' + esc(Lab.money(ra.metrics.cost)) + '</td><td>' + esc(Lab.money(rb.metrics.cost)) + '</td><td>' + delta(r.deltas.cost, x => x.toFixed(4), false) + '</td></tr>' +
      '</tbody></table></div>' +
      '<div class="card lab-section"><div class="card-title">Regressions (' + fmt(r.regressions.length) + ')</div>' + (r.regressions.length ? r.regressions.map((e, i) => entry(e, i, 'reg')).join('') : '<p class="lab-muted">None.</p>') + '</div>' +
      '<div class="card"><div class="card-title">Improvements (' + fmt(r.improvements.length) + ')</div>' + (r.improvements.length ? r.improvements.map((e, i) => entry(e, i, 'imp')).join('') : '<p class="lab-muted">None.</p>') + '</div>';
    const find = key => { const kind = key.slice(0, 3), i = Number(key.slice(3)); return (kind === 'reg' ? r.regressions : r.improvements)[i]; };
    main.querySelectorAll('details.lab-result').forEach(dt => dt.addEventListener('toggle', () => {
      dt.querySelectorAll('[data-o]').forEach(o => { if (o.dataset.done) return; o.dataset.done = '1'; const k = o.dataset.o; const e = find(k.slice(0, -1)); o.innerHTML = LabMarkdown.render(k.endsWith('a') ? e.outputA : e.outputB); LabMarkdown.enhance(o, null); });
    }));
    main.querySelectorAll('[data-d]').forEach(btn => { btn.onclick = () => { const e = find(btn.dataset.d); main.querySelector('[data-dd="' + btn.dataset.d + '"]').innerHTML = LabDiff.html(e.outputA, e.outputB); }; });
    if ($('cp-accept')) $('cp-accept').onclick = e => act(e.target, async () => { await post('/profiles/' + profile.id + '/versions/' + vB.version + '/accept'); notify('v' + vB.version + ' is now the current version', 'success'); Lab.route(); });
    if ($('cp-reject')) $('cp-reject').onclick = e => act(e.target, async () => { await post('/profiles/' + profile.id + '/versions/' + vB.version + '/reject'); notify('Candidate rejected', 'info'); Lab.route(); });
    if ($('cp-restore')) $('cp-restore').onclick = e => act(e.target, async () => { const x = await post('/profiles/' + profile.id + '/restore', { version: vB.version }); notify('Restored as version ' + x.profile.currentVersion, 'success'); Lab.route(); });
  });
})();
