// @ts-check
// ── Evaluations ───────────────────────────────────────────────────────────────
// A suite pins a dataset *version* (so its tasks never change under it), a
// split, extra checks, repeats and retrieval settings; editing a suite makes a
// new suite version. A run asks one model, with one profile version, every
// task of one suite version, and records each answer and check result.
//
// Runs execute in the background, a few at a time server-wide
// (AI_LAB_MAX_RUNNING_EVALS), two tasks at a time per run. Each finished task
// is appended to the run's results file at once, so a cancelled, failed or
// interrupted run can be resumed: only the tasks without a result are asked
// again. Entitlement and limits are checked when a run starts or resumes;
// after a server restart, runs that were going wait for their owner to resume
// them (they aren't restarted in the background on their own).
//
// Metric definitions (also shown in the interface):
//   graded        tasks with an answer and at least one check that ran
//   pass rate     graded tasks whose checks all passed ÷ graded tasks
//   weighted      the same, weighting each task by its weight
//   per check     pass / fail / skipped / error counts per check type
//   AI-graded     mean rubric score — a model's opinion, not ground truth
//   consistency   (repeats > 1) tasks whose repeats all passed or all failed
//   latency       median and 95th percentile of answer times
//   tokens        prompt and answer tokens; measuredShare = share reported by
//                 the provider rather than estimated
//   cost          estimated from the operator's price list, or unknown

const { LabError, invalid, notFound } = require('./errors');
const { cleanCheck, runChecks, rubricMessages, parseRubric, GRADER_VERSION } = require('./checks');
const { buildMessages } = require('./context');
const { buildIndex } = require('./knowledge');
const { versionOf } = require('./profiles');
const { sumCosts } = require('./pricing');
const { newId } = require('./store');
const { logger, userRef } = require('../lib/log');

/** @typedef {import('../types/ai-lab').SuiteConfig} SuiteConfig */
/** @typedef {import('../types/ai-lab').EvaluationSuite} EvaluationSuite */
/** @typedef {import('../types/ai-lab').EvaluationRun} EvaluationRun */
/** @typedef {import('../types/ai-lab').TaskResult} TaskResult */
/** @typedef {import('../types/ai-lab').RunMetrics} RunMetrics */
/** @typedef {import('../types/ai-lab').DatasetExample} DatasetExample */
/** @typedef {import('../types/ai-lab').LabPrincipal} LabPrincipal */

const log = logger('ai-lab');
const MAX_TASKS = 500;
const TASK_CONCURRENCY = 2;
const OUTPUT_KEEP = 50000;

/**
 * Validates a suite configuration against the user's datasets.
 * @param {unknown} input
 * @param {import('./store').UserStore} us
 * @returns {SuiteConfig}
 */
function cleanSuiteConfig(input, us) {
  const c = /** @type {Record<string, any>} */ (input && typeof input === 'object' ? input : {});
  const ds = us.get('datasets', c.datasetId);
  if (!ds) throw invalid('Choose one of your datasets for the suite.');
  const version = Number(c.datasetVersion);
  if (!ds.versions.some(/** @param {any} v */ v => v.version === version)) throw invalid('Choose a committed version of the dataset (commit the draft first).');
  const split = c.split === undefined ? 'test' : String(c.split);
  if (!['all', 'train', 'validation', 'test'].includes(split)) throw invalid('Split must be all, train, validation or test.');
  const repeats = c.repeats === undefined ? 1 : Number(c.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw invalid('Repeats must be 1–5.');
  const k = c.retrieval && c.retrieval.k !== undefined ? Number(c.retrieval.k) : 4;
  if (!Number.isInteger(k) || k < 1 || k > 12) throw invalid('Retrieved chunks must be 1–12.');
  const checks = Array.isArray(c.checks) ? c.checks.slice(0, 20).map(cleanCheck) : [];
  const judgeModel = c.judgeModel ? String(c.judgeModel).slice(0, 120) : null;
  return { datasetId: ds.id, datasetVersion: version, split: /** @type {SuiteConfig['split']} */ (split), checks, repeats, retrieval: { enabled: !!(c.retrieval && c.retrieval.enabled), k }, judgeModel };
}

/**
 * The tasks of a suite version (frozen examples of the pinned dataset version).
 * @param {import('./store').UserStore} us
 * @param {SuiteConfig} cfg
 * @returns {DatasetExample[]}
 */
function suiteTasks(us, cfg) {
  const raw = us.readSidecar('datasets', cfg.datasetId, 'v' + cfg.datasetVersion + '.json');
  if (!raw) throw notFound('The dataset version this suite uses');
  /** @type {DatasetExample[]} */
  const all = JSON.parse(raw).examples || [];
  const tasks = all.filter(e => e.quality !== 'rejected' && (cfg.split === 'all' || e.split === cfg.split));
  return tasks;
}

/** @param {number[]} xs @param {number} q */
const pct = (xs, q) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/**
 * @param {TaskResult[]} results
 * @param {Map<string, DatasetExample>} tasks
 * @param {(r: TaskResult) => import('../types/ai-lab').CostEstimate} costOf
 * @returns {RunMetrics}
 */
function computeMetrics(results, tasks, costOf) {
  /** @type {RunMetrics['byCheck']} */
  const byCheck = {};
  /** @type {Record<string, number>} */
  const failureCategories = {};
  let completed = 0, errored = 0, passed = 0, graded = 0, wPass = 0, wGraded = 0, judged = 0, judgeSum = 0, prompt = 0, completion = 0, measured = 0, withUsage = 0;
  /** @type {number[]} */
  const latencies = [];
  /** @type {Map<string, boolean[]>} */
  const perTask = new Map();
  for (const r of results) {
    if (r.error) { errored++; failureCategories['error:' + r.error.type] = (failureCategories['error:' + r.error.type] || 0) + 1; continue; }
    completed++;
    if (r.latencyMs !== null) latencies.push(r.latencyMs);
    if (r.usage) { prompt += r.usage.promptTokens; completion += r.usage.completionTokens; withUsage++; if (r.usage.measured) measured++; }
    const ran = r.checks.filter(c => c.status === 'pass' || c.status === 'fail');
    r.checks.forEach(c => {
      const b = byCheck[c.type] || (byCheck[c.type] = { pass: 0, fail: 0, skipped: 0, error: 0 });
      b[c.status]++;
      if (c.method === 'ai_graded' && typeof c.score === 'number') { judged++; judgeSum += c.score; }
    });
    if (!ran.length) continue;
    graded++;
    const t = tasks.get(r.taskId);
    const w = t ? t.weight : 1;
    wGraded += w;
    const ok = r.passed;
    if (ok) { passed++; wPass += w; }
    else {
      const first = r.checks.find(c => c.status === 'fail' || c.status === 'error');
      if (first) failureCategories[first.type] = (failureCategories[first.type] || 0) + 1;
    }
    perTask.set(r.taskId, (perTask.get(r.taskId) || []).concat([ok]));
  }
  const multi = Array.from(perTask.values()).filter(v => v.length > 1);
  return {
    tasks: tasks.size, attempts: results.length, completed, errored, graded, passed,
    passRate: graded ? passed / graded : null,
    weightedPassRate: wGraded ? wPass / wGraded : null,
    byCheck,
    aiGraded: judged ? { graded: judged, meanScore: judgeSum / judged } : null,
    consistency: multi.length ? { tasks: multi.length, consistent: multi.filter(v => v.every(x => x === v[0])).length } : null,
    failureCategories,
    latency: { p50Ms: pct(latencies, 0.5), p95Ms: pct(latencies, 0.95) },
    tokens: { prompt, completion, measuredShare: withUsage ? measured / withUsage : 0 },
    cost: sumCosts(results.filter(r => !r.error).map(costOf))
  };
}

/**
 * Compares two runs on the same tasks. Regressions: tasks that passed in A
 * (most repeats) and don't in B; improvements the other way.
 * @param {EvaluationRun} a
 * @param {TaskResult[]} ra
 * @param {EvaluationRun} b
 * @param {TaskResult[]} rb
 * @param {Map<string, DatasetExample>} tasks
 */
function compareRuns(a, ra, b, rb, tasks) {
  if (a.datasetId !== b.datasetId || a.datasetVersion !== b.datasetVersion) {
    return { comparable: false, reason: 'These runs used different task sets (dataset ' + a.datasetVersion + ' vs ' + b.datasetVersion + ', or different datasets). Compare runs of the same suite version.' };
  }
  /** @type {string[]} */
  const warnings = [];
  if (a.suiteId !== b.suiteId || a.suiteVersion !== b.suiteVersion) warnings.push('The runs used different suite versions (checks or settings may differ).');
  const sa = a.settings, sb = b.settings;
  if (sa.temperature !== sb.temperature) warnings.push('Temperature differs (' + sa.temperature + ' vs ' + sb.temperature + ').');
  if (sa.maxTokens !== sb.maxTokens) warnings.push('Maximum answer length differs.');
  if (sa.retrieval.enabled !== sb.retrieval.enabled || sa.retrieval.k !== sb.retrieval.k) warnings.push('Retrieval settings differ.');
  if (sa.repeats === 1 || sb.repeats === 1) warnings.push('With one attempt per task, differences can come from sampling randomness alone. Use repeats to measure it.');
  /** @param {TaskResult[]} rs */
  const byTask = rs => {
    /** @type {Map<string, TaskResult[]>} */
    const m = new Map();
    rs.forEach(r => m.set(r.taskId, (m.get(r.taskId) || []).concat([r])));
    return m;
  };
  const ma = byTask(ra), mb = byTask(rb);
  /** @param {TaskResult[] | undefined} list */
  const passShare = list => { const g = (list || []).filter(r => !r.error && r.checks.some(c => c.status === 'pass' || c.status === 'fail')); return g.length ? g.filter(r => r.passed).length / g.length : null; };
  const regressions = [], improvements = [];
  let unchanged = 0, missing = 0;
  for (const [taskId, t] of tasks) {
    const pa = passShare(ma.get(taskId)), pb = passShare(mb.get(taskId));
    if (pa === null || pb === null) { missing++; continue; }
    const wasOk = pa >= 0.5, isOk = pb >= 0.5;
    const first = /** @param {TaskResult[] | undefined} l */ l => (l && l[0]) || null;
    const ca = first(ma.get(taskId)), cb = first(mb.get(taskId));
    const changedChecks = ca && cb ? cb.checks.filter(c => { const old = ca.checks.find(x => x.label === c.label); return old && old.status !== c.status; }).map(c => ({ label: c.label, from: /** @type {any} */ (ca.checks.find(x => x.label === c.label)).status, to: c.status, detail: c.detail })) : [];
    const entry = { taskId, task: t.task.slice(0, 200), category: t.category, passShareA: pa, passShareB: pb, changedChecks,
      outputA: ca ? ca.output.slice(0, 4000) : '', outputB: cb ? cb.output.slice(0, 4000) : '' };
    if (wasOk && !isOk) regressions.push(entry);
    else if (!wasOk && isOk) improvements.push(entry);
    else unchanged++;
  }
  const d = /** @param {number | null} x @param {number | null} y */ (x, y) => (x === null || y === null ? null : y - x);
  const A = /** @type {RunMetrics} */ (a.metrics), B = /** @type {RunMetrics} */ (b.metrics);
  return {
    comparable: true, warnings,
    a: { id: a.id, profileId: a.profileId, profileVersion: a.profileVersion, model: a.model, provider: a.provider, createdAt: a.createdAt },
    b: { id: b.id, profileId: b.profileId, profileVersion: b.profileVersion, model: b.model, provider: b.provider, createdAt: b.createdAt },
    deltas: A && B ? {
      passRate: d(A.passRate, B.passRate), weightedPassRate: d(A.weightedPassRate, B.weightedPassRate),
      p50Ms: d(A.latency.p50Ms, B.latency.p50Ms), tokens: (B.tokens.prompt + B.tokens.completion) - (A.tokens.prompt + A.tokens.completion),
      cost: A.cost.amount !== null && B.cost.amount !== null ? B.cost.amount - A.cost.amount : null
    } : null,
    regressions, improvements, unchanged, missing,
    verdict: !regressions.length && !improvements.length ? 'no_change' : regressions.length > improvements.length ? 'worse' : improvements.length > regressions.length ? 'better' : 'mixed'
  };
}

/**
 * The background runner.
 * @param {object} deps
 * @param {import('./store').LabStore} deps.store
 * @param {ReturnType<typeof import('./providers').createRegistry>} deps.registry
 * @param {ReturnType<typeof import('./usage').createLabUsage>} deps.usage
 * @param {ReturnType<typeof import('./pricing').createPricing>} deps.pricing
 * @param {() => ReturnType<typeof import('./config').labConfig>} deps.getConfig
 * @param {(event: string, fields: Record<string, string | number | boolean | null>) => void} [deps.metric]
 */
function createRunner(deps) {
  /** @type {{ key: string, runId: string, principal: LabPrincipal }[]} */
  const queue = [];
  /** @type {Map<string, AbortController>} runId → controller of a running run */
  const running = new Map();
  const metric = deps.metric || (() => {});

  /** @param {string} key @param {string} runId */
  function enqueue(key, runId, /** @type {LabPrincipal} */ principal) {
    queue.push({ key, runId, principal });
    pump();
  }

  function pump() {
    while (running.size < deps.getConfig().maxRunningEvals && queue.length) {
      const job = /** @type {{ key: string, runId: string, principal: LabPrincipal }} */ (queue.shift());
      const ac = new AbortController();
      running.set(job.runId, ac);
      execute(job, ac.signal).catch(err => log.error('eval.crashed', { run: job.runId, detail: String(err && err.message) }))
        .finally(() => { running.delete(job.runId); pump(); });
    }
  }

  /** @param {string} runId */
  function cancel(runId) {
    const ac = running.get(runId);
    if (ac) { ac.abort(); return true; }
    const i = queue.findIndex(q => q.runId === runId);
    if (i >= 0) { queue.splice(i, 1); return true; }
    return false;
  }

  /** @param {string} runId */
  const isActive = runId => running.has(runId) || queue.some(q => q.runId === runId);

  /**
   * @param {{ key: string, runId: string, principal: LabPrincipal }} job
   * @param {AbortSignal} signal
   */
  async function execute(job, signal) {
    const us = deps.store.forUser(job.key);
    /** @type {EvaluationRun | null} */
    const run = us.get('runs', job.runId);
    if (!run || !['queued', 'interrupted', 'cancelled', 'failed'].includes(run.status)) return;
    const save = () => us.put('runs', run);
    const started = Date.now();
    run.status = 'running';
    run.error = null;
    run.startedAt = run.startedAt || new Date().toISOString();
    save();
    try {
      const suite = /** @type {EvaluationSuite} */ (us.get('suites', run.suiteId));
      if (!suite) throw notFound('The suite');
      const sv = suite.versions.find(v => v.version === run.suiteVersion);
      if (!sv) throw notFound('The suite version');
      const tasks = suiteTasks(us, sv.config);
      const byId = new Map(tasks.map(t => [t.id, t]));
      const profile = run.profileId ? us.get('profiles', run.profileId) : null;
      const fields = profile && run.profileVersion ? versionOf(profile, run.profileVersion).fields : null;
      const project = run.projectId ? us.get('projects', run.projectId) : null;
      const provider = deps.registry.get(run.provider);
      const model = await deps.registry.resolve(run.provider, run.model);
      const index = sv.config.retrieval.enabled && run.projectId
        ? buildIndex(us.list('documents').filter(d => d.projectId === run.projectId && d.status === 'ready')) : null;
      const done = new Set(us.readLines('runs', run.id, 'results.ndjson').map(r => r.key));
      /** @type {{ task: DatasetExample, repeat: number, key: string }[]} */
      const todo = [];
      tasks.forEach(t => { for (let r = 1; r <= sv.config.repeats; r++) { const key = t.id + '#' + r; if (!done.has(key)) todo.push({ task: t, repeat: r, key }); } });
      run.progress = { done: done.size, total: tasks.length * sv.config.repeats };
      save();
      let consecutiveFailures = 0;
      /** @type {LabError | null} */
      let fatal = null;
      const judgeModel = sv.config.judgeModel || run.model;

      /** @param {{ task: DatasetExample, repeat: number, key: string }} item */
      const one = async item => {
        const t = item.task;
        const retrieved = index ? index.search(t.task + '\n' + t.input, sv.config.retrieval.k) : [];
        const built = buildMessages({ profile: fields, profileRef: run.profileId && run.profileVersion ? { id: run.profileId, version: run.profileVersion } : null, project, retrieved,
          history: [], summary: null, message: t.task + (t.input ? '\n\n' + t.input : ''), taskType: null,
          contextWindow: model.contextWindow || deps.getConfig().defaultContextTokens, maxTokens: run.settings.maxTokens });
        /** @type {TaskResult} */
        const result = { key: item.key, taskId: t.id, repeat: item.repeat, output: '', checks: [], passed: false, latencyMs: null, usage: null, error: null, retrieved: built.report.documents.map(x => ({ docId: x.docId, chunk: x.chunk })) };
        const ticket = deps.usage.begin(job.principal, { estimatedTokens: built.report.estimatedInputTokens + run.settings.maxTokens, interactive: false });
        try {
          const r = await provider.chat({ model: run.model, messages: built.messages, temperature: run.settings.temperature, maxTokens: run.settings.maxTokens, signal });
          ticket.settle(r.usage);
          result.output = r.text.slice(0, OUTPUT_KEEP);
          result.latencyMs = r.latencyMs;
          result.usage = r.usage;
          consecutiveFailures = 0;
          metric('eval.task', { provider: run.provider, model: run.model, ok: true, ms: r.latencyMs });
        } catch (err) {
          ticket.settle(null);
          if (signal.aborted) throw err;
          const e = err instanceof LabError ? err : new LabError('provider_error', 'The model request failed.', { status: 502 });
          if (e.type === 'limit_reached') { fatal = e; throw e; }
          result.error = { type: e.type, message: e.message };
          consecutiveFailures++;
          metric('eval.task', { provider: run.provider, model: run.model, ok: false, type: e.type });
          if (consecutiveFailures >= 5) { fatal = new LabError('provider_outage', 'The model failed 5 times in a row (last: ' + e.message + '). The run stopped; resume it when the provider works again.', { status: 502 }); throw fatal; }
        }
        if (!result.error) {
          // A task without checks stays ungraded: no check is invented for it
          const checks = sv.config.checks.concat(t.checks);
          const judge = checks.some(c => c.type === 'ai_rubric') ? async (/** @type {string} */ criteria) => {
            const jm = await deps.registry.resolve(run.provider, judgeModel);
            const messages = rubricMessages(criteria, t.task + (t.input ? '\n\n' + t.input : ''), t.expected || t.reference, result.output);
            const jt = deps.usage.begin(job.principal, { estimatedTokens: messages.reduce((n, m) => n + m.content.length / 4, 0) + 300, interactive: false });
            try {
              const g = await provider.chat({ model: jm.id, messages, temperature: 0, maxTokens: 300, signal, json: true });
              jt.settle(g.usage);
              return Object.assign(parseRubric(g.text), { model: jm.id });
            } catch (err) { jt.settle(null); throw err; }
          } : null;
          result.checks = await runChecks(result.output, checks, { expected: t.expected, task: t.task, judge });
          const ran = result.checks.filter(c => c.status === 'pass' || c.status === 'fail' || c.status === 'error');
          result.passed = ran.length > 0 && ran.every(c => c.status === 'pass');
        }
        us.appendLine('runs', run.id, 'results.ndjson', result);
        run.progress.done++;
        save();
      };

      // A small pool: TASK_CONCURRENCY tasks at a time
      let next = 0;
      const worker = async () => { while (next < todo.length && !signal.aborted && !fatal) { const item = todo[next++]; await one(item); } };
      try { await Promise.all(Array.from({ length: Math.min(TASK_CONCURRENCY, todo.length) }, worker)); }
      catch (err) { if (!signal.aborted && !fatal) throw err; }
      if (signal.aborted) {
        run.status = 'cancelled';
      } else if (fatal) {
        const f = /** @type {LabError} */ (fatal);
        run.status = 'failed';
        run.error = { type: f.type, message: f.message };
      } else {
        run.status = 'completed';
      }
      const results = us.readLines('runs', run.id, 'results.ndjson');
      run.metrics = computeMetrics(results, byId, r => deps.pricing.costOf(run.provider, run.model, r.usage));
      run.finishedAt = new Date().toISOString();
      save();
      metric('eval.run', { user: userRef(job.principal.userId), status: run.status, tasks: run.progress.total, ms: Date.now() - started, passRate: run.metrics.passRate });
    } catch (err) {
      const e = err instanceof LabError ? err : new LabError('internal_error', 'The evaluation stopped because of an unexpected error. The server log has details.', { status: 500 });
      if (!(err instanceof LabError)) log.error('eval.error', { run: run.id, detail: String(err && /** @type {Error} */ (err).message) });
      run.status = signal.aborted ? 'cancelled' : 'failed';
      run.error = signal.aborted ? null : { type: e.type, message: e.message };
      run.finishedAt = new Date().toISOString();
      save();
    }
  }

  // After a restart: runs that were queued or running are marked interrupted; their owners resume them.
  function recover() {
    let n = 0;
    for (const key of deps.store.userKeys()) {
      const us = deps.store.forUser(key);
      for (const run of us.list('runs')) {
        if (run.status === 'queued' || run.status === 'running') {
          run.status = 'interrupted';
          run.error = { type: 'interrupted', message: 'The server restarted while this run was going. Resume it to finish the remaining tasks (finished tasks are kept).' };
          us.put('runs', run);
          n++;
        }
      }
    }
    if (n) log.info('eval.recovered', { interrupted: n });
    return n;
  }

  function shutdown() { running.forEach(ac => ac.abort()); queue.length = 0; }

  function stats() { return { running: running.size, queued: queue.length }; }

  return { enqueue, cancel, isActive, recover, shutdown, stats, pump };
}

/**
 * A new run record (not started).
 * @param {object} o
 * @param {EvaluationSuite} o.suite
 * @param {{ id: string, version: number } | null} o.profile
 * @param {{ provider: string, model: string }} o.model
 * @param {{ temperature: number | null, maxTokens: number }} o.settings
 * @param {string} [o.note]
 * @param {import('./store').UserStore} o.us
 * @returns {EvaluationRun}
 */
function newRun(o) {
  const sv = o.suite.versions.find(v => v.version === o.suite.currentVersion);
  if (!sv) throw notFound('The suite version');
  const tasks = suiteTasks(o.us, sv.config);
  if (!tasks.length) throw invalid('The suite has no tasks: its dataset version has no examples in the "' + sv.config.split + '" split. Assign splits and commit a new version, or choose "all".');
  if (tasks.length * sv.config.repeats > MAX_TASKS) throw invalid('A run can ask at most ' + MAX_TASKS + ' tasks (tasks × repeats); this suite has ' + tasks.length * sv.config.repeats + '.');
  return {
    id: newId('runs'), suiteId: o.suite.id, suiteVersion: sv.version, datasetId: sv.config.datasetId, datasetVersion: sv.config.datasetVersion,
    profileId: o.profile ? o.profile.id : null, profileVersion: o.profile ? o.profile.version : null, projectId: o.suite.projectId,
    provider: o.model.provider, model: o.model.model,
    settings: { temperature: o.settings.temperature, maxTokens: o.settings.maxTokens, repeats: sv.config.repeats, retrieval: sv.config.retrieval, judgeModel: sv.config.judgeModel, checks: sv.config.checks.length },
    status: 'queued', error: null, progress: { done: 0, total: tasks.length * sv.config.repeats }, metrics: null,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, note: String(o.note || '').slice(0, 500)
  };
}

module.exports = { cleanSuiteConfig, suiteTasks, computeMetrics, compareRuns, createRunner, newRun, MAX_TASKS, GRADER_VERSION };
