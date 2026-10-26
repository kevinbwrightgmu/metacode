// @ts-check
// ── Code experiments (AI Coding Lab) ──────────────────────────────────────────
// A user picks a variable (a Codebook dimension), snapshots its records into a
// read-only, versioned sandbox (sandboxes/<id>/v<n>.json: records + reference
// and baseline labels), and creates an experiment. The AI (or the user) writes
// coding rules — classify(record, variable) — and every save is a new,
// immutable version (its code is hashed; the hash is what runs, is selected
// and is sent). Running a version is a background job in five stages:
//
//   1. input      ownership, the code hash, the language, the sandbox's own
//                 hash (re-verified), the records of the chosen split
//   2. review     the AI security review (stored per code hash; needs_review
//                 or unavailable need the user's acknowledgement, rejected blocks)
//   3. policy     the deterministic policy (code-policy.js for JavaScript /
//                 TypeScript; Python is checked inside the sandbox before any
//                 of its code runs); errors always block
//   4. execution  the labExecutions meter, then the isolated sandbox
//                 (code-sandbox.js); the code's output streams to the terminal
//   5. output     every result checked against the classify/1 contract; only
//                 a run with zero problems has its results stored
//      metrics    measured against the labels (experiment-metrics.js), results
//                 kept in xruns/<id>/results.json
//
// Terminal lines carry ids and counts only, never record text (the code's own
// stdout/stderr is printed as it comes). They are kept in memory while a run
// is active and saved with it to xruns/<id>/log.json; the run object itself
// keeps only the last few lines and the count. Comparisons, AI evaluations (numbers
// in the AI's text checked against the measurements), the final selection and
// the Codebook submission (applied by the MetaCode app, not here) build on
// the stored runs. Nothing here runs code: the sandbox does.

const { LabError, isLabError, notFound, invalid } = require('./errors');
const { newId } = require('./store');
const { estimateTokens } = require('./providers');
const { executionSettings } = require('./code-sandbox');
const CP = require('./code-policy');
const X = require('./experiment-data');
const M = require('./experiment-metrics');
const A = require('./experiment-ai');
const { logger, redact, userRef } = require('../lib/log');

/** @typedef {import('../types/ai-lab').LabPrincipal} LabPrincipal */
/** @typedef {import('../types/ai-lab').MessageUsage} MessageUsage */
/** @typedef {import('../types/lab-experiments').CodeLanguage} CodeLanguage */
/** @typedef {import('../types/lab-experiments').Sandbox} Sandbox */
/** @typedef {import('../types/lab-experiments').SandboxVersionFile} SandboxVersionFile */
/** @typedef {import('../types/lab-experiments').SandboxRecord} SandboxRecord */
/** @typedef {import('../types/lab-experiments').SandboxVariable} SandboxVariable */
/** @typedef {import('../types/lab-experiments').Experiment} Experiment */
/** @typedef {import('../types/lab-experiments').ExperimentVersion} ExperimentVersion */
/** @typedef {import('../types/lab-experiments').ExecutionRun} ExecutionRun */
/** @typedef {import('../types/lab-experiments').ExecutionStatus} ExecutionStatus */
/** @typedef {import('../types/lab-experiments').ExecutionStage} ExecutionStage */
/** @typedef {import('../types/lab-experiments').TerminalLine} TerminalLine */
/** @typedef {import('../types/lab-experiments').PolicyFinding} PolicyFinding */
/** @typedef {import('../types/lab-experiments').PolicyReport} PolicyReport */
/** @typedef {import('../types/lab-experiments').SecurityReview} SecurityReview */
/** @typedef {import('../types/lab-experiments').ThreadMessage} ThreadMessage */
/** @typedef {import('../types/lab-experiments').CodebookSubmission} CodebookSubmission */
/** @typedef {import('../types/lab-experiments').CodingRule} CodingRule */
/** @typedef {import('../types/lab-experiments').AiEvaluation} AiEvaluation */
/** @typedef {import('../types/lab-experiments').ExecutionMetrics} ExecutionMetrics */
/** @typedef {import('../types/lab-experiments').RecordResult} RecordResult */
/** @typedef {import('./store').UserStore} UserStore */
/** @typedef {{ key: string, runId: string, principal: LabPrincipal }} Job */
/** @typedef {{ temperature: number, maxTokens: number, json: boolean }} ChatSettings */
/** A stored run: `log` holds its last LIMITS.logTail lines, `logTotal` counts them all (runs stored before log.json kept every line in `log`). */
/** @typedef {ExecutionRun & { logTotal?: number }} StoredRun */
/** @typedef {CodebookSubmission & { resentAt?: string | null }} Submission */

const log = logger('ai-lab');

/** @type {CodeLanguage[]} */
const LANGUAGES = ['javascript', 'typescript', 'python'];
const LANGUAGE_NAMES = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python' };
const SPLITS = ['all', 'test', 'dev'];
const SPLIT_NAMES = { all: 'all records', test: 'held-out split', dev: 'dev split' };
const MODES = ['new', 'alternative', 'refine'];
const EDIT_ORIGINS = ['edited', 'duplicated', 'reverted'];
const ACTIVE = ['queued', 'running'];
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'];
const CODE_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const SUBMISSION_ID_RE = /^cbs_[A-Za-z0-9_-]{16}$/;
const LIMITS = Object.freeze({
  sandboxes: 100, sandboxVersions: 100, experiments: 200, versions: 300, thread: 400, submissions: 50, runIdsKept: 200,
  prompt: 4000, rationale: 4000, notes: 20000, objective: 4000, label: 80, annotation: 2000,
  /** Stored code (the policy itself blocks more than 100 KB). */
  codeBytes: 200 * 1024,
  /** Code the Codebook keeps. */
  codebookBytes: 64 * 1024,
  /** Lines a run's terminal keeps (the sandbox caps the code's own output first); the run object keeps the last logTail of them. */
  logLines: 3000, lineChars: 2000, logTail: 20,
  /** Idempotency keys (the Lab's "<experiment>:<version>:<code hash>:<run>:<selectedAt>" is about 135 characters). */
  idempotencyKey: 160,
  page: 100, changedShown: 1000
});
/** A running run is saved at most this often (and always on a stage change and at the end). */
const SAVE_EVERY_MS = 300;
/** How long a cancel request waits for the run to stop. */
const CANCEL_WAIT_MS = 5000;
/** Parsed sandbox versions kept in memory (small ones only; runs always re-read and re-verify). */
const FILE_CACHE = Object.freeze({ entries: 6, maxChars: 4 * 1024 * 1024 });

const now = () => new Date().toISOString();
/** @param {string} h */
const short = h => String(h || '').slice(0, 8) + '…';
/** @param {number | null | undefined} v */
const pct = v => (typeof v === 'number' && Number.isFinite(v) ? (Math.round(v * 1000) / 10).toFixed(1) + '%' : 'not measured');
/** @param {number | null | undefined} v */
const dec = v => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'not measured');
/** @param {number} ms */
const secs = ms => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');
/** @param {number | null} b */
const mb = b => (typeof b === 'number' && b > 0 ? (b / 1048576).toFixed(1) + ' MB' : 'not reported');
/** @param {string} s @param {number} max */
const cut = (s, max) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
/** @param {{ createdAt: string }} a @param {{ createdAt: string }} b */
const newestFirst = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
/** @param {unknown} v */
const plain = v => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') : '');

/**
 * @param {object} deps
 * @param {import('./store').LabStore} deps.store
 * @param {ReturnType<typeof import('./providers').createRegistry>} deps.registry
 * @param {ReturnType<typeof import('./usage').createLabUsage>} deps.usage
 * @param {() => ReturnType<typeof import('./config').labConfig>} deps.getConfig
 * @param {ReturnType<typeof import('./code-sandbox').createCodeSandbox>} deps.sandbox
 * @param {(event: string, fields: Record<string, string | number | boolean | null>) => void} [deps.metric]
 */
function createExperiments(deps) {
  const { store, registry, usage, getConfig, sandbox } = deps;
  const metric = deps.metric || (() => {});
  const settings = () => executionSettings(getConfig());

  /* ── Background runs: queue, pump, cancel ───────── */

  /** @type {Job[]} */
  const queue = [];
  /** @type {Map<string, { key: string, ac: AbortController, promise: Promise<void> }>} runId → a running job */
  const running = new Map();
  /** @type {Map<string, string>} user key → the run that is queued or running (one per user) */
  const activeByUser = new Map();
  /** Finished runs since the server started, by status (admin metrics). */
  /** @type {Record<string, number>} */
  const runsByStatus = {};
  /** Python policy checks in flight, per user (one at a time). */
  const analyzing = new Set();
  /** @type {Map<string, TerminalLine[]>} runId → the terminal lines of a run that is going (saved to log.json as it goes) */
  const liveLogs = new Map();
  let stopping = false;

  /** @param {string} runId */
  const isActive = runId => running.has(runId) || queue.some(j => j.runId === runId);

  /** @param {Job} job */
  function enqueue(job) {
    activeByUser.set(job.key, job.runId);
    queue.push(job);
    pump();
  }

  function pump() {
    while (!stopping && running.size < settings().maxRunning && queue.length) {
      const job = /** @type {Job} */ (queue.shift());
      const ac = new AbortController();
      const promise = execute(job, ac.signal)
        .catch(err => log.error('experiment.run_crashed', { run: job.runId, detail: redact(String(err && /** @type {Error} */ (err).stack || err), 600) }))
        .finally(() => {
          running.delete(job.runId);
          liveLogs.delete(job.runId);
          if (activeByUser.get(job.key) === job.runId) activeByUser.delete(job.key);
          pump();
        });
      running.set(job.runId, { key: job.key, ac, promise });
    }
  }

  /**
   * Stops a run: a queued one is taken off the queue (→ { queued: true }), a
   * running one is aborted (its sandbox process is killed; → its job's promise).
   * @param {string} runId
   * @returns {{ queued: boolean, promise: Promise<void> | null } | null} null: not active
   */
  function cancel(runId) {
    const i = queue.findIndex(j => j.runId === runId);
    if (i >= 0) {
      const job = queue.splice(i, 1)[0];
      if (activeByUser.get(job.key) === runId) activeByUser.delete(job.key);
      return { queued: true, promise: null };
    }
    const r = running.get(runId);
    if (r) { r.ac.abort(); return { queued: false, promise: r.promise }; }
    return null;
  }

  /** Every queued or running run of a user (DELETE /data, before the folder goes). @param {string} key */
  function cancelUser(key) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].key === key) queue.splice(i, 1);
    running.forEach(r => { if (r.key === key) r.ac.abort(); });
    activeByUser.delete(key);
    analyzing.delete(key);
    forgetFiles(store.forUser(key).root);
  }

  /* ── Stored runs (read one at a time: never all of a user's runs kept in memory) ───────── */

  /** @param {UserStore} u @param {unknown} id @returns {StoredRun | null} */
  const runOf = (u, id) => u.read('xruns', id);
  /** @param {UserStore} u @param {unknown} id @param {string} what @returns {StoredRun} */
  function ownedRun(u, id, what) {
    const run = runOf(u, id);
    if (!run) throw notFound(what);
    return run;
  }

  /**
   * A run's terminal lines: in memory while it is going, otherwise
   * xruns/<id>/log.json (a run stored before logs moved there has them all inline).
   * @param {UserStore} u @param {StoredRun} run @returns {TerminalLine[]}
   */
  function logOf(u, run) {
    const live = liveLogs.get(run.id);
    if (live) return live;
    const raw = u.readSidecar('xruns', run.id, 'log.json');
    if (raw) { try { const lines = JSON.parse(raw); if (Array.isArray(lines)) return lines; } catch (e) { /* unreadable: the lines the run kept */ } }
    return Array.isArray(run.log) ? run.log : [];
  }

  /** Saves a run's lines to log.json; the run object keeps the last few and the count. @param {UserStore} u @param {StoredRun} run @param {TerminalLine[]} lines */
  function storeLog(u, run, lines) {
    u.writeSidecar('xruns', run.id, 'log.json', JSON.stringify(lines));
    run.log = lines.slice(-LIMITS.logTail);
    run.logTotal = lines.length;
  }

  /** A run that will never be picked up again: marked, saved, and its version updated. @param {UserStore} u @param {StoredRun} run @param {ExecutionStatus} status @param {string} type @param {string} message */
  function markEnded(u, run, status, type, message) {
    run.status = status;
    run.failure = { type, message, stage: run.stage };
    run.timing.finishedAt = now();
    const lines = logOf(u, run).slice();
    lines.push({ seq: lines.length ? lines[lines.length - 1].seq + 1 : 1, t: run.timing.startedAt ? Date.now() - Date.parse(run.timing.startedAt) : 0, stream: 'system', level: 'warn', stage: run.stage, text: message });
    storeLog(u, run, lines);
    u.put('xruns', run);
    noteLastRun(u, run);
    runsByStatus[status] = (runsByStatus[status] || 0) + 1;
  }

  /** The version's lastRun follows its newest run. @param {UserStore} u @param {ExecutionRun} run */
  function noteLastRun(u, run) {
    const e = /** @type {Experiment | null} */ (u.get('experiments', run.experimentId));
    if (!e) return;
    const v = e.versions.find(x => x.version === run.version);
    if (!v || v.codeHash !== run.codeHash || (v.lastRun && v.lastRun.id !== run.id)) return;
    v.lastRun = { id: run.id, status: run.status, finishedAt: run.timing.finishedAt };
    u.put('experiments', e);
  }

  // After a restart: runs that were queued or running are marked interrupted (run them again).
  // Only the start of each run file is read for the others (status comes before the log, the
  // review and the metrics), and nothing is kept in memory.
  function recover() {
    let n = 0;
    /** @param {string} head */
    const maybeActive = head => { const m = /"status":"([a-z]+)"/.exec(head); return !m || ACTIVE.includes(m[1]); };
    for (const key of store.userKeys()) {
      const u = store.forUser(key);
      const stuck = /** @type {StoredRun[]} */ (u.scan('xruns', r => ACTIVE.includes(r.status) && !isActive(r.id), maybeActive));
      for (const run of stuck) {
        markEnded(u, run, 'interrupted', 'interrupted', 'The server restarted while this run was ' + (run.status === 'queued' ? 'waiting' : 'going') + '. Run the version again.');
        n++;
      }
    }
    if (n) log.info('experiment.recovered', { interrupted: n });
    return n;
  }

  /* ── Sandbox files (immutable once written; a few kept parsed) ───────── */

  /** @type {Map<string, SandboxVersionFile>} */
  const files = new Map();
  /** @param {string} prefix */
  function forgetFiles(prefix) { for (const k of Array.from(files.keys())) if (k.startsWith(prefix + '|')) files.delete(k); }

  /**
   * A sandbox version's records and variable.
   * @param {UserStore} u @param {Sandbox} s @param {number} version
   * @returns {SandboxVersionFile}
   */
  function fileOf(u, s, version) {
    if (!s.versions.some(v => v.version === version)) throw notFound('Version ' + version + ' of this sandbox');
    const k = u.root + '|' + s.id + '|' + version;
    const hit = files.get(k);
    if (hit) return hit;
    const raw = u.readSidecar('sandboxes', s.id, 'v' + version + '.json');
    if (!raw) throw notFound('Version ' + version + ' of this sandbox');
    /** @type {SandboxVersionFile} */
    let file;
    try { file = JSON.parse(raw); } catch (e) { throw new LabError('sandbox_corrupted', 'Version ' + version + ' of this sandbox can\'t be read. Import the records again.', { status: 500 }); }
    if (raw.length <= FILE_CACHE.maxChars) {
      files.set(k, file);
      while (files.size > FILE_CACHE.entries) files.delete(/** @type {string} */ (files.keys().next().value));
    }
    return file;
  }

  /** @param {UserStore} u @param {ExecutionRun} run @returns {RecordResult[] | null} */
  function resultsOf(u, run) {
    const raw = run.status === 'succeeded' ? u.readSidecar('xruns', run.id, 'results.json') : null;
    if (!raw) return null;
    try { const j = JSON.parse(raw); return Array.isArray(j.results) ? j.results : null; } catch (e) { return null; }
  }

  /**
   * The newest successful run of an experiment's version on the experiment's
   * sandbox data (the version's run ids, newest first, read one at a time).
   * @param {UserStore} u @param {Experiment} e @param {number} version @returns {ExecutionRun | null}
   */
  function lastSucceeded(u, e, version) {
    const ver = e.versions.find(v => v.version === version);
    const ids = ver ? ver.runIds : [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const r = runOf(u, ids[i]);
      if (r && r.status === 'succeeded' && r.metrics && r.experimentId === e.id && r.version === version && r.sandbox.id === e.sandboxId && r.sandbox.version === e.sandboxVersion) return r;
    }
    return null;
  }

  /** An experiment's runs (those its versions list), newest first. @param {UserStore} u @param {Experiment} e @returns {StoredRun[]} */
  const experimentRuns = (u, e) => /** @type {StoredRun[]} */ (e.versions.flatMap(v => v.runIds).map(id => runOf(u, id)).filter(r => !!r && r.experimentId === e.id)).sort(newestFirst);

  /** A run without its terminal lines (they come from GET /xruns/:id). @param {StoredRun} run @param {Experiment | null} [e] */
  function runSummary(run, e) {
    const out = /** @type {any} */ (Object.assign({}, run));
    delete out.log;
    const live = liveLogs.get(run.id);
    out.logTotal = live ? live.length : typeof run.logTotal === 'number' ? run.logTotal : (Array.isArray(run.log) ? run.log.length : 0);
    out.active = isActive(run.id);
    if (e) out.score = run.metrics ? M.scoreRun(run.metrics, e.objective.criteria).score : null;
    return out;
  }

  /* ── Models (registry + usage tickets) ───────── */

  /**
   * One model call, metered like every Lab call (a ticket before, settled after).
   * @param {LabPrincipal} principal
   * @param {string} providerId
   * @param {string} modelId
   * @param {{ role: 'system' | 'user', content: string }[]} messages
   * @param {ChatSettings} s
   * @param {{ interactive: boolean, signal?: AbortSignal }} o
   */
  async function chat(principal, providerId, modelId, messages, s, o) {
    const provider = registry.get(providerId);
    const model = await registry.resolve(providerId, modelId);
    const maxTokens = Math.max(256, Math.min(s.maxTokens, model.maxOutput || s.maxTokens));
    const ticket = usage.begin(principal, { estimatedTokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0) + maxTokens, interactive: o.interactive });
    let r;
    try {
      r = await provider.chat({ model: model.id, messages, temperature: s.temperature, maxTokens, json: s.json, signal: o.signal });
      ticket.settle(r.usage);
    } catch (err) {
      ticket.settle(null);
      metric('experiment.ai', { provider: provider.id, model: model.id, ok: false, type: isLabError(err) ? err.type : 'provider_error' });
      throw err;
    }
    metric('experiment.ai', { provider: provider.id, model: r.model || model.id, ok: true, ms: r.latencyMs });
    return { text: r.text, finishReason: r.finishReason, provider: provider.id, model: r.model || model.id, usage: /** @type {MessageUsage} */ (r.usage) };
  }

  /**
   * The AI security review of a version's code. Never throws for model
   * problems (→ decision 'unavailable'); only an abort is rethrown.
   * @param {LabPrincipal} principal
   * @param {ExperimentVersion} ver
   * @param {SandboxVariable} variable
   * @param {{ provider: string, model: string, interactive: boolean, signal?: AbortSignal }} o
   * @returns {Promise<SecurityReview>}
   */
  async function reviewCode(principal, ver, variable, o) {
    try {
      const r = await chat(principal, o.provider, o.model, A.reviewMessages({ code: ver.code, language: ver.language, variable }), A.AI_SETTINGS.review, o);
      return A.parseReview(r.text, r.finishReason, ver.codeHash, r.provider, r.model);
    } catch (err) {
      if (o.signal && o.signal.aborted) throw err;
      return A.unavailableReview(ver.codeHash, o.provider, o.model || null, isLabError(err) ? err.message : 'the model request failed');
    }
  }

  /**
   * The Python policy (lab-prelude.py's analyzer, inside the sandbox; no user code runs).
   * @param {string} key @param {ExperimentVersion} ver @param {SandboxVariable} variable
   * @returns {Promise<PolicyReport>}
   */
  async function analyzePython(key, ver, variable) {
    if (analyzing.has(key)) throw new LabError('busy', 'A Python check is already running for you. Wait for it to finish.', { status: 429 });
    analyzing.add(key);
    try {
      const out = await sandbox.run({ language: 'python', code: ver.code, variable, mode: 'analyze' }, {});
      if (!out.policy) throw new LabError('policy_unavailable', 'The Python policy check couldn\'t be completed' + (out.failure ? ' (' + out.failure.message + ')' : '') + '.', { status: 502 });
      return pythonReport(ver.codeHash, out.policy);
    } finally { analyzing.delete(key); }
  }

  /** @param {string} hash @param {PolicyFinding[]} findings @returns {PolicyReport} */
  const pythonReport = (hash, findings) => ({ ok: !findings.some(f => f.severity === 'error'), policyVersion: CP.POLICY_VERSION, language: 'python', engine: 'python-ast', codeHash: hash, findings, checkedAt: now() });

  // (a report made while the checker wasn't installed is no verdict: it's checked again)
  /** @param {ExperimentVersion} ver @returns {PolicyReport | null} the stored policy report, if it is for this code */
  const policyOf = ver => (ver.policy && ver.policy.codeHash === ver.codeHash && ver.policy.policyVersion === CP.POLICY_VERSION
    && !ver.policy.findings.some(f => f.rule === 'checker_unavailable') ? ver.policy : null);
  /** @param {ExperimentVersion} ver @returns {SecurityReview | null} */
  const reviewOf = ver => (ver.review && ver.review.codeHash === ver.codeHash ? ver.review : null);

  /* ── Experiments, versions, thread ───────── */

  /** @param {Experiment} e @param {unknown} v @returns {ExperimentVersion} */
  function versionOf(e, v) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
    const ver = Number.isInteger(n) ? e.versions.find(x => x.version === n) : undefined;
    if (!ver) throw notFound('Version ' + String(v).slice(0, 12) + ' of this experiment');
    return ver;
  }

  /** @param {unknown} v */
  function cleanLanguage(v) {
    if (!LANGUAGES.includes(/** @type {CodeLanguage} */ (v))) throw invalid('The language must be javascript, typescript or python.');
    return /** @type {CodeLanguage} */ (v);
  }

  /** Line endings as the editor keeps them (\r\n and \r become \n), before the code is hashed. @param {string} code */
  const normaliseCode = code => code.replace(/\r\n?/g, '\n');

  /** @param {unknown} v */
  function cleanCode(v) {
    if (typeof v !== 'string' || !v.trim()) throw invalid('There is no code to save.');
    const code = normaliseCode(v);
    if (Buffer.byteLength(code, 'utf8') > LIMITS.codeBytes) throw invalid('The code is larger than ' + (LIMITS.codeBytes / 1024) + ' KB. Coding rules should be small (the policy allows 100 KB).');
    return code;
  }

  /** @param {unknown} v */
  function promptText(v) {
    const s = plain(v).trim();
    if (!s) throw invalid('Write what you want first.');
    if (s.length > LIMITS.prompt) throw invalid('A prompt can be at most ' + LIMITS.prompt.toLocaleString('en-US') + ' characters (this one has ' + s.length.toLocaleString('en-US') + ').');
    return s;
  }

  /**
   * A new immutable version (the JavaScript / TypeScript policy runs now; Python's in the sandbox later).
   * @param {Experiment} e
   * @param {{ code: string, language: CodeLanguage, origin: ExperimentVersion['origin'], parent: number | null, label?: string, prompt?: string | null, generation?: ExperimentVersion['generation'] }} o
   * @returns {ExperimentVersion}
   */
  function addVersion(e, o) {
    if (e.versions.length >= LIMITS.versions) throw invalid('An experiment keeps ' + LIMITS.versions + ' versions at most. Start a new experiment for further work.');
    const n = e.versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const code = normaliseCode(o.code);
    /** @type {ExperimentVersion} */
    const ver = {
      version: n, parent: o.parent, origin: o.origin, label: str(o.label, LIMITS.label).trim(), annotation: '', candidate: false,
      language: o.language, code, codeHash: CP.codeHash(code), createdAt: now(), prompt: o.prompt || null, generation: o.generation || null,
      policy: o.language === 'python' ? null : CP.analyzeJavaScript(code, o.language), review: null, reviewAck: null, runIds: [], lastRun: null, evaluation: null
    };
    e.versions.push(ver);
    e.updatedAt = now();
    return ver;
  }

  /** @param {Experiment} e @param {Omit<ThreadMessage, 'id' | 'createdAt'>[]} msgs @returns {ThreadMessage[]} */
  function pushThread(e, msgs) {
    const added = msgs.map(m => Object.assign({ id: newId('thread'), createdAt: now() }, m));
    e.thread.push(...added);
    if (e.thread.length > LIMITS.thread) e.thread.splice(0, e.thread.length - LIMITS.thread);
    return added;
  }

  /** @param {Experiment} e */
  const threadEntries = e => e.thread.map(m => ({ role: m.role, text: m.text }));

  /** Saves a change to one version of the stored experiment (if both still exist and the code is the same). @param {UserStore} u @param {string} expId @param {ExperimentVersion} ver @param {(v: ExperimentVersion) => void} change */
  function updateVersion(u, expId, ver, change) {
    const e = /** @type {Experiment | null} */ (u.get('experiments', expId));
    const v = e ? e.versions.find(x => x.version === ver.version && x.codeHash === ver.codeHash) : null;
    if (!e || !v) return null;
    change(v);
    e.updatedAt = now();
    u.put('experiments', e);
    return { e, v };
  }

  /** The sandbox record ids and the variable a version runs against. @param {UserStore} u @param {Experiment} e */
  function experimentData(u, e) {
    const s = /** @type {Sandbox | null} */ (u.get('sandboxes', e.sandboxId));
    if (!s) throw notFound('The experiment\'s sandbox data');
    return { sandbox: s, file: fileOf(u, s, e.sandboxVersion) };
  }

  /** Deletes an experiment with its runs (an active run is cancelled first). @param {UserStore} u @param {Experiment} e */
  function deleteExperiment(u, e) {
    // (every run of it, also those no longer listed by a version; other runs' files are only glanced at)
    const mine = '"experimentId":"' + e.id + '"';
    const runs = /** @type {ExecutionRun[]} */ (u.scan('xruns', r => r.experimentId === e.id, head => head.includes(mine) || !head.includes('"experimentId":')));
    runs.forEach(r => { cancel(r.id); u.remove('xruns', r.id); });
    u.remove('experiments', e.id);
    return runs.length;
  }

  /** @param {Experiment} e @param {ExecutionRun[]} runs the experiment's runs, newest first */
  function experimentSummary(e, runs) {
    let best = null;
    for (const r of runs) {
      if (r.status !== 'succeeded' || !r.metrics || r.sandbox.id !== e.sandboxId || r.sandbox.version !== e.sandboxVersion) continue;
      const s = M.scoreRun(r.metrics, e.objective.criteria).score;
      if (s !== null && (best === null || s > best)) best = s;
    }
    return {
      id: e.id, name: e.name, archived: e.archived, variable: { id: e.variable.id, name: e.variable.name }, sandboxId: e.sandboxId, sandboxVersion: e.sandboxVersion,
      language: e.language, versionCount: e.versions.length, selected: e.selected, bestScore: best, updatedAt: e.updatedAt, lastRunStatus: runs.length ? runs[0].status : null
    };
  }

  /* ── The run job ───────── */

  /** @param {Job} job @param {AbortSignal} signal */
  async function execute(job, signal) {
    const u = store.forUser(job.key);
    const run = runOf(u, job.runId);
    if (!run || run.status !== 'queued') return;
    const t0 = Date.now();
    let lastSave = 0;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    // The terminal: in memory while the run is going (GET /xruns/:id reads it here), saved to log.json with the run
    const lines = logOf(u, run).slice();
    liveLogs.set(run.id, lines);
    let linesSaved = -1;
    // Deleted (the experiment, the run, or all of the user's data) → nothing is written again
    const alive = () => u.has('xruns', run.id);
    const saveNow = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!alive()) return;
      lastSave = Date.now();
      if (lines.length !== linesSaved) { storeLog(u, run, lines); linesSaved = lines.length; }
      u.put('xruns', run);
    };
    const save = () => {
      const since = Date.now() - lastSave;
      if (since >= SAVE_EVERY_MS) return saveNow();
      if (!timer) { timer = setTimeout(saveNow, SAVE_EVERY_MS - since); timer.unref(); }
    };
    let seq = lines.reduce((m, l) => Math.max(m, l.seq), 0);
    /** @param {TerminalLine['stream']} stream @param {TerminalLine['level']} level @param {string} text */
    const line = (stream, level, text) => {
      if (lines.length >= LIMITS.logLines) {
        if (!run.logTruncated) {
          run.logTruncated = true;
          lines.push({ seq: ++seq, t: Date.now() - t0, stream: 'system', level: 'warn', stage: run.stage, text: 'The terminal keeps ' + LIMITS.logLines + ' lines per run; later lines were dropped.' });
        }
        return;
      }
      lines.push({ seq: ++seq, t: Date.now() - t0, stream, level, stage: run.stage, text: String(text).slice(0, LIMITS.lineChars) });
      save();
    };
    /** @param {TerminalLine['level']} level @param {string} text */
    const sys = (level, text) => line('system', level, text);
    /** @param {ExecutionStage} s */
    const stage = s => { run.stage = s; saveNow(); };
    /** @param {ExecutionStatus} status @param {ExecutionStage} at @param {string} type @param {string} message */
    const stop = (status, at, type, message) => {
      run.status = status;
      run.stage = at;
      run.failure = { type, message, stage: at };
      sys(status === 'cancelled' || status === 'interrupted' ? 'warn' : 'error', message);
    };
    // Whether a sandbox process was started for this run (a run cancelled before that isn't charged)
    let spawned = false;
    const cancelled = () => (stopping
      ? stop('interrupted', run.stage, 'interrupted', 'The server stopped while this run was going. Run the version again.')
      : stop('cancelled', run.stage, 'cancelled', spawned ? 'Cancelled: the sandbox process was stopped.' : 'Cancelled before the sandbox started.'));
    /** @param {PolicyFinding[]} findings */
    const printFindings = findings => findings.slice(0, 50).forEach(f => sys(f.severity === 'error' ? 'error' : 'warn',
      (f.line ? 'line ' + f.line + ': ' : '') + f.message + ' [' + f.rule + (f.severity === 'warning' ? ', warning' : '') + ']'));

    run.status = 'running';
    run.timing.startedAt = now();
    stage('input');
    /** @type {{ release: () => void } | null} */
    let unit = null;

    const pipeline = async () => {
      /* 1. input */
      const e = /** @type {Experiment | null} */ (u.get('experiments', run.experimentId));
      if (!e) return stop('cancelled', 'input', 'cancelled', 'The experiment was deleted.');
      const ver = e.versions.find(v => v.version === run.version);
      if (!ver) return stop('failed', 'input', 'version_missing', 'Version ' + run.version + ' doesn\'t exist any more.');
      if (ver.codeHash !== run.codeHash || CP.codeHash(ver.code) !== run.codeHash) return stop('failed', 'input', 'stale_code', 'The stored code of v' + ver.version + ' doesn\'t match the hash this run was started with, so it wasn\'t run.');
      sys('info', 'Code: v' + ver.version + ' · ' + LANGUAGE_NAMES[run.language] + ' · sha256 ' + short(run.codeHash));
      const support = sandbox.supported(run.language);
      if (!support.ok) return stop('failed', 'input', 'not_available', support.reason);
      const sbx = /** @type {Sandbox | null} */ (u.get('sandboxes', run.sandbox.id));
      if (!sbx) return stop('failed', 'input', 'sandbox_missing', 'The sandbox data was deleted.');
      const info = sbx.versions.find(v => v.version === run.sandbox.version);
      /** @type {SandboxVersionFile | null} */
      let file = null;
      try { file = JSON.parse(u.readSidecar('sandboxes', sbx.id, 'v' + run.sandbox.version + '.json') || 'null'); } catch (err) { file = null; }
      if (!info || !file || info.sha256 !== run.sandbox.sha256 || !X.verifyVersion(file, info.sha256)) {
        return stop('failed', 'input', 'sandbox_corrupted', 'The sandbox data (v' + run.sandbox.version + ') doesn\'t match its recorded sha256, so it wasn\'t used. Import the records again as a new version.');
      }
      const records = X.selectRecords(file.records, run.sandbox.split);
      if (!records.length) return stop('failed', 'input', 'no_records', 'There are no records in the ' + SPLIT_NAMES[run.sandbox.split] + ' of sandbox v' + run.sandbox.version + '. Choose another split.');
      run.sandbox.recordCount = records.length;
      run.sandbox.recordIdsHash = X.recordIdsHash(records);
      sys('info', 'Input: ' + records.length + ' records (' + SPLIT_NAMES[run.sandbox.split] + '), sandbox v' + run.sandbox.version + ' sha256 ' + short(info.sha256) + ' — verified');
      if (signal.aborted) return cancelled();

      /* 2. AI security review */
      stage('review');
      run.security.policy = policyOf(ver);
      const ack = ver.reviewAck && ver.reviewAck.codeHash === run.codeHash ? ver.reviewAck : null;
      const acked = !!ack;
      // A review that couldn't be made is asked again (unless the user already allowed the code without it)
      let review = reviewOf(ver);
      if (review && review.decision === 'unavailable' && !acked) review = null;
      // JavaScript/TypeScript: the deterministic policy is cheap and authoritative — code it blocks
      // isn't sent to the AI reviewer (no model call is spent on code that can't run anyway)
      const jsReport = run.language !== 'python' ? CP.analyzeJavaScript(ver.code, run.language) : null;
      if (!review && jsReport && !jsReport.ok) sys('info', 'AI security review: skipped — the deterministic policy already blocks this code (below).');
      else if (review) sys('info', 'AI security review: stored with v' + ver.version + ' (' + (review.model || 'no model') + ', ' + review.reviewedAt + ')');
      else {
        sys('info', 'AI security review: asking the reviewer…');
        const gen = ver.generation;
        review = await reviewCode(job.principal, ver, e.variable, { provider: gen ? gen.provider : 'metacode', model: gen ? gen.model : '', interactive: false, signal });
        if (signal.aborted) return cancelled();
        const r = review;
        updateVersion(u, e.id, ver, v => { v.review = r; });
      }
      run.security.review = review;
      if (review) {
        const said = { approved: 'approved', rejected: 'rejected', needs_review: 'needs a human check', unavailable: 'unavailable' }[review.decision];
        sys(review.decision === 'approved' ? 'success' : review.decision === 'rejected' ? 'error' : 'warn', 'AI review: ' + said + (review.summary ? ' — ' + cut(review.summary, 400) : ''));
        review.risks.slice(0, 20).forEach(r => sys(r.severity === 'high' || r.severity === 'critical' ? 'error' : 'warn',
          '  ' + (r.line ? 'line ' + r.line + ': ' : '') + r.category + ' (' + r.severity + ')' + (r.explanation ? ' — ' + cut(r.explanation, 300) : '')));
        if (review.decision === 'rejected') return stop('blocked', 'review', 'review_rejected', 'Blocked: the AI security review rejected this code. Change it and run the new version.');
        if (review.decision !== 'approved') {
          if (acked) {
            run.security.acknowledged = true;
            sys('warn', 'You read this review and allowed this exact code to run (' + (ack ? ack.at : '') + ').');
          } else {
            return stop('blocked', 'review', 'review_required', review.decision === 'unavailable'
              ? 'Blocked: the AI review couldn\'t be made. Read the code, then allow it to run (for this exact code).'
              : 'Blocked: the AI review asks for a human check. Read it, then allow this exact code to run.');
          }
        }
      }
      if (signal.aborted) return cancelled();

      /* 3. deterministic policy */
      stage('policy');
      if (jsReport) {
        const report = jsReport;
        run.security.policy = report;
        updateVersion(u, e.id, ver, v => { v.policy = report; });
        printFindings(report.findings);
        const errors = report.findings.filter(f => f.severity === 'error').length;
        if (!report.ok) return stop('blocked', 'policy', 'policy_blocked', 'Blocked by the policy (' + CP.POLICY_VERSION + '): ' + errors + ' error' + (errors === 1 ? '' : 's') + '. Fix ' + (errors === 1 ? 'it' : 'them') + ' and save a new version.');
        const warns = report.findings.length - errors;
        sys('success', 'Policy ' + CP.POLICY_VERSION + ': passed' + (warns ? ' with ' + warns + ' warning' + (warns === 1 ? '' : 's') : '') + '.');
      } else {
        sys('info', 'Policy ' + CP.POLICY_VERSION + ': Python is checked inside the sandbox, before any of your code runs.');
      }

      /* 4. isolated execution */
      stage('execution');
      try { unit = usage.take(job.principal, 'labExecutions'); } catch (err) {
        if (isLabError(err)) return stop('failed', 'execution', err.type, err.message);
        throw err;
      }
      const iso = await sandbox.isolation(run.language);
      if (signal.aborted) { if (unit) { unit.release(); unit = null; } return cancelled(); }
      run.isolation = iso;
      sys('info', 'Isolation — engine: ' + iso.engine);
      sys('info', 'Isolation — process: ' + iso.process);
      sys('info', 'Isolation — network: ' + iso.network);
      sys('info', 'Isolation — files: ' + iso.filesystem);
      sys('info', 'Isolation — environment: ' + iso.environment);
      sys('info', 'Isolation — limits: ' + iso.limits);
      let mark = 0;
      /** @type {PolicyReport | null} */
      let pyPolicy = null;
      /** @type {import('../types/lab-experiments').SandboxOutcome} */
      let out;
      try {
        out = await sandbox.run({ language: run.language, code: ver.code, records: X.sandboxInput(records), variable: file.variable, mode: 'run' }, {
          signal,
          onSpawn: () => { spawned = true; },
          onLog: l => line(l.stream, l.level, l.text),
          onProgress: p => {
            let next = mark;
            while (next < 100 && p.total > 0 && p.done * 100 >= (next + 25) * p.total) next += 25;
            if (next > mark) { mark = next; sys('info', 'Progress: ' + p.done + '/' + p.total + ' records (' + mark + '%)'); }
          },
          onPolicy: findings => {
            const report = pythonReport(run.codeHash, findings);
            pyPolicy = report;
            run.security.policy = report;
            run.stage = 'policy';
            printFindings(findings);
            if (report.ok) sys('success', 'Policy ' + CP.POLICY_VERSION + ': passed inside the sandbox before your code ran' + (findings.length ? ' (' + findings.length + ' warning' + (findings.length === 1 ? '' : 's') + ')' : '') + '.');
            run.stage = 'execution';
            saveNow();
          }
        });
      } catch (err) {
        if (!isLabError(err)) throw err;
        // A host fault before the code ran (execution switched off meanwhile, busy, …): the unit isn't charged
        if (unit) { unit.release(); unit = null; }
        if (signal.aborted) return cancelled();
        return stop('failed', 'execution', err.type, err.message);
      }
      if (!pyPolicy && run.language === 'python' && out.policy) pyPolicy = pythonReport(run.codeHash, out.policy);
      if (pyPolicy) { const p = pyPolicy; updateVersion(u, e.id, ver, v => { v.policy = p; }); }
      run.engine = out.engine;
      run.isolation = out.isolation;
      run.resources = out.resources;
      run.timing.durationMs = out.durationMs;
      run.timing.bootMs = out.bootMs;
      if (out.failure) {
        if (out.failure.type === 'cancelled' || signal.aborted) {
          // Cancelled while it waited for a sandbox slot: no process ever started, so the unit isn't charged
          if (!spawned && unit) { unit.release(); unit = null; }
          return cancelled();
        }
        if (out.failure.type === 'policy_blocked') return stop('blocked', 'policy', 'policy_blocked', 'Blocked by the policy (' + CP.POLICY_VERSION + '): ' + out.failure.message);
        return stop('failed', 'execution', out.failure.type, out.failure.message);
      }
      // Python's policy errors stop the code before it runs (lab-prelude.py); should a run ever finish
      // with one anyway, nothing from it is used
      const pyErrors = pyPolicy ? /** @type {PolicyReport} */ (pyPolicy).findings.filter(f => f.severity === 'error').length : 0;
      if (pyErrors) return stop('blocked', 'policy', 'policy_blocked', 'Blocked by the policy (' + CP.POLICY_VERSION + '): ' + pyErrors + ' error' + (pyErrors === 1 ? '' : 's') + '. Fix ' + (pyErrors === 1 ? 'it' : 'them') + ' and save a new version.');
      sys('info', 'Sandbox finished in ' + secs(out.durationMs) + (run.language === 'python' ? ' (+ ' + secs(out.bootMs) + ' Python start-up)' : '') +
        ' · memory ' + mb(out.resources.rssBytes) + ' · output ' + (out.resources.outputBytes / 1024).toFixed(1) + ' KB');
      if (signal.aborted) return cancelled();

      /* 5. output validation */
      stage('output');
      const { validation, results } = CP.validateOutputs(out.outputs, records, file.variable);
      run.output = validation;
      if (!validation.valid) {
        const total = validation.invalid + validation.missing + validation.unexpected;
        validation.problems.slice(0, 10).forEach(p => sys('error', '  ' + (p.id ? 'record ' + p.id + ': ' : '') + p.problem));
        return stop('failed', 'output', 'output_invalid', 'The output broke the classify/1 contract (' + total + ' record' + (total === 1 ? '' : 's') + ' with problems), so nothing from this run is used.');
      }
      const threw = results.filter(r => r.error).length;
      sys('success', 'Output: valid — ' + results.length + ' results' + (threw ? ' (' + threw + ' record' + (threw === 1 ? '' : 's') + ' where classify threw an error)' : '') + '.');

      /* 6. metrics */
      stage('metrics');
      const metrics = M.computeMetrics(results, records, file.variable, { durationMs: out.durationMs });
      if (!alive()) return stop('cancelled', 'metrics', 'cancelled', 'The run was deleted.');
      u.writeSidecar('xruns', run.id, 'results.json', JSON.stringify({ results }));
      run.metrics = metrics;
      sys('success', summaryLine(metrics));
      run.status = 'succeeded';
      return undefined;
    };

    try {
      await pipeline();
    } catch (err) {
      if (signal.aborted) cancelled();
      else {
        if (!isLabError(err)) log.error('experiment.run_error', { run: run.id, detail: redact(String(err && /** @type {Error} */ (err).stack || err), 600) });
        const e = isLabError(err) ? err : new LabError('internal_error', 'The run stopped because of an unexpected error. The server log has details.', { status: 500 });
        stop('failed', run.stage, e.type, e.message);
      }
    }
    // (the pipeline's closures changed run.status: read it afresh)
    if (/** @type {ExecutionStatus} */ (run.status) === 'running') stop('failed', run.stage, 'internal_error', 'The run ended without a result.');
    if (/** @type {ExecutionStatus} */ (run.status) === 'succeeded') run.stage = 'done';
    run.timing.finishedAt = now();
    saveNow();
    if (alive()) noteLastRun(u, run);
    runsByStatus[run.status] = (runsByStatus[run.status] || 0) + 1;
    metric('experiment.run', { user: userRef(job.principal.userId), status: run.status, language: run.language, records: run.sandbox.recordCount, ms: Date.now() - t0 });
  }

  /** The run's closing line: measured numbers only. @param {ExecutionMetrics} m */
  function summaryLine(m) {
    const coded = m.processed - (m.distribution[M.NONE] || 0);
    const parts = ['Coded ' + coded + '/' + m.processed, 'coverage ' + pct(m.coverage), 'errors ' + m.errors];
    const ref = m.reference ? (m.reference.test && m.reference.test.n ? { label: 'held-out', s: m.reference.test } : { label: 'labelled', s: m.reference.all }) : null;
    if (ref && ref.s) parts.push(ref.label + ' accuracy ' + pct(ref.s.accuracy) + ' (n=' + ref.s.n + ')', 'macro-F1 ' + dec(ref.s.macroF1), 'κ ' + dec(ref.s.kappa));
    else parts.push('no reference labels (accuracy not measured)');
    if (m.baseline) parts.push('agreement with current AI coding ' + pct(m.baseline.agreement) + ' (n=' + m.baseline.n + ')');
    if (m.consistency.score !== null) parts.push('consistency ' + pct(m.consistency.score) + ' (' + m.consistency.groups + ' group' + (m.consistency.groups === 1 ? '' : 's') + ')');
    parts.push(secs(m.runtime.durationMs));
    return parts.join(' · ');
  }

  /* ── The Codebook payload ───────── */

  /**
   * @param {Experiment} e @param {ExperimentVersion} ver @param {ExecutionRun} run @param {Sandbox | null} sbx
   * @param {SecurityReview} review @param {string} submissionId
   * @returns {CodingRule}
   */
  function codingRule(e, ver, run, sbx, review, submissionId) {
    const m = /** @type {ExecutionMetrics} */ (run.metrics);
    const ref = m.reference ? (m.reference.test && m.reference.test.n >= 1 ? m.reference.test : m.reference.all) : null;
    const codes = e.variable.codes.map(c => c.id);
    // The prompt that started this line of versions, and the one that produced this version
    let original = '';
    /** @type {ExperimentVersion | undefined} */
    let cur = ver;
    for (let hops = 0; cur && hops < LIMITS.versions; hops++) {
      if (cur.prompt) original = cur.prompt;
      /** @type {number | null} */
      const parent = cur.parent;
      cur = parent === null ? undefined : e.versions.find(v => v.version === parent);
    }
    const evaluation = ver.evaluation && ver.evaluation.runId === run.id ? ver.evaluation : null;
    /** @param {number | null | undefined} v */
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      schema: 'metacode.coding-rule/1',
      submissionId,
      status: 'experimental',
      dimensionId: e.variable.id,
      experiment: { id: e.id, name: e.name },
      version: ver.version,
      codeHash: ver.codeHash,
      language: ver.language,
      code: ver.code,
      contract: {
        name: 'classify/1',
        input: {
          record: { id: 'string', text: 'string', author: 'string', timestamp: 'string', meta: 'object of text, numbers, true/false or null' },
          variable: { id: e.variable.id, name: e.variable.name, codes }
        },
        output: { returns: 'a code id, null (no code), or { code, confidence?, reason? }', codes, confidence: 'optional number from 0 to 1', reason: 'optional text, at most 500 characters' }
      },
      prompts: { original: original.slice(0, LIMITS.prompt), final: (ver.prompt || '').slice(0, LIMITS.prompt) },
      rationale: e.selected ? e.selected.rationale : '',
      evaluation: {
        runId: run.id, finishedAt: run.timing.finishedAt, split: run.sandbox.split, records: m.processed,
        // the records the reference scores below are measured on (held-out when the run had any)
        referenceSplit: ref && m.reference && ref === m.reference.test ? 'test' : run.sandbox.split,
        accuracy: ref ? num(ref.accuracy) : null, macroF1: ref ? num(ref.macroF1) : null, kappa: ref ? num(ref.kappa) : null, referenceN: ref ? ref.n : 0,
        coverage: num(m.coverage), errorRate: num(m.errorRate), baselineAgreement: m.baseline ? num(m.baseline.agreement) : null,
        recommendation: evaluation ? evaluation.recommendation : null
      },
      security: { policy: 'passed', review: review.decision, reviewedAt: review.reviewedAt || null },
      sandbox: { id: run.sandbox.id, name: sbx ? sbx.name : '', version: run.sandbox.version, sha256: run.sandbox.sha256,
        source: sbx && sbx.source ? { kind: sbx.source.kind, projectName: sbx.source.projectName || null } : null },
      selectedAt: e.selected ? e.selected.selectedAt : now(),
      sentAt: now()
    };
  }

  /**
   * Why a version can't be final (null: it can): its last run succeeded with
   * valid output on the experiment's sandbox data, the policy passed for this
   * code, and the AI review didn't reject it.
   * @param {UserStore} u @param {Experiment} e @param {ExperimentVersion} ver
   * @returns {{ problem: string } | { run: ExecutionRun, review: SecurityReview }}
   */
  function finalCheck(u, e, ver) {
    const run = ver.lastRun ? runOf(u, ver.lastRun.id) : null;
    if (!run || run.status !== 'succeeded' || !run.output || !run.output.valid || !run.metrics) return { problem: 'v' + ver.version + '\'s last run didn\'t succeed with valid output. Run it, then select it.' };
    if (run.codeHash !== ver.codeHash || run.sandbox.id !== e.sandboxId || run.sandbox.version !== e.sandboxVersion) return { problem: 'v' + ver.version + '\'s last run used other sandbox data. Run it again, then select it.' };
    const policy = policyOf(ver) || (run.security.policy && run.security.policy.codeHash === ver.codeHash ? run.security.policy : null);
    if (!policy || !policy.ok) return { problem: 'v' + ver.version + ' hasn\'t passed the policy checks.' };
    const review = reviewOf(ver) || (run.security.review && run.security.review.codeHash === ver.codeHash ? run.security.review : null);
    if (!review) return { problem: 'v' + ver.version + ' has no AI security review.' };
    if (review.decision === 'rejected') return { problem: 'The AI security review rejected v' + ver.version + '.' };
    return { run, review };
  }

  /* ── Routes ───────── */

  /** Text without control characters, cut to `max`. @param {unknown} v @param {number} max */
  const str = (v, max) => plain(v).slice(0, max);

  /**
   * @param {any} router
   * @param {{ us: (req: any) => UserStore, owned: (u: UserStore, kind: string, id: unknown, what: string) => any, route: (fn: (req: any, res: any) => any) => any, str: (v: unknown, max: number) => string, checkStorage: (req: any, bytes: number) => void }} h
   */
  function routes(router, h) {
    const { us, owned, route, checkStorage } = h;
    /** @param {any} req @param {string} id @returns {Experiment} */
    const experiment = (req, id) => owned(us(req), 'experiments', id, 'That experiment');
    /** @param {any} q @param {number} dflt */
    const page = (q, dflt) => {
      const offset = Math.max(0, Math.floor(Number(q.offset)) || 0);
      const limit = Math.max(1, Math.min(LIMITS.page, Math.floor(Number(q.limit)) || dflt));
      return { offset, limit };
    };

    /* Sandboxes */

    /**
     * A new sandbox (version 1) from records.
     * @param {any} req @param {UserStore} u @param {{ name: string, source: Sandbox['source'], variable: unknown, records: unknown }} o
     */
    function createSandbox(req, u, o) {
      if (u.list('sandboxes').length >= LIMITS.sandboxes) throw invalid('You have ' + LIMITS.sandboxes + ' sandboxes, the most the Lab keeps. Delete some first.');
      const id = newId('sandboxes');
      const built = X.createSandboxVersion({ sandboxId: id, version: 1, variable: o.variable, records: o.records, note: 'Created' });
      const text = JSON.stringify(built.file);
      checkStorage(req, Buffer.byteLength(text) + 4096);
      const at = now();
      /** @type {Sandbox} */
      const s = { id, schemaVersion: 1, name: o.name || (built.file.variable.name + ' records').slice(0, 120), source: o.source, variable: built.file.variable, versions: [built.info], createdAt: at, updatedAt: at };
      u.writeSidecar('sandboxes', id, 'v1.json', text);
      u.put('sandboxes', s);
      u.audit('sandbox.created', { sandbox: id, source: o.source.kind, records: built.info.count, rejected: built.report.rejected, references: built.info.referenceCount, baselines: built.info.baselineCount });
      return { sandbox: s, report: built.report };
    }

    router.get('/sandboxes', route(req => {
      const u = us(req);
      const exps = /** @type {Experiment[]} */ (u.list('experiments'));
      return { sandboxes: /** @type {Sandbox[]} */ (u.list('sandboxes')).sort(newestFirst).map(s => Object.assign({}, s, { experiments: exps.filter(e => e.sandboxId === s.id).length })) };
    }));
    router.post('/sandboxes/import', route((req, res) => {
      const b = req.body || {};
      const src = b.source && typeof b.source === 'object' ? b.source : {};
      if (src.kind !== undefined && src.kind !== 'project') throw invalid('source.kind must be "project" here (datasets use /sandboxes/from-dataset).');
      const out = createSandbox(req, us(req), { name: str(b.name, 120).trim(), source: { kind: 'project', projectName: str(src.projectName, 200).trim() || null, datasetId: null, datasetVersion: null }, variable: b.variable, records: b.records });
      res.status(201);
      return out;
    }));
    router.post('/sandboxes/from-dataset', route((req, res) => {
      const u = us(req);
      const b = req.body || {};
      const d = owned(u, 'datasets', b.datasetId, 'That dataset');
      const n = Number(b.version);
      if (!Number.isInteger(n) || !d.versions.some(/** @param {any} v */ v => v.version === n)) throw notFound('That version of the dataset (only committed versions can be used)');
      const raw = u.readSidecar('datasets', d.id, 'v' + n + '.json');
      if (!raw) throw notFound('That version of the dataset');
      const variable = X.validateVariable(b.variable);
      const records = X.recordsFromDataset(JSON.parse(raw).examples, variable);
      const out = createSandbox(req, u, { name: str(b.name, 120).trim() || (d.name + ' v' + n).slice(0, 120), source: { kind: 'dataset', projectName: null, datasetId: d.id, datasetVersion: n }, variable, records });
      res.status(201);
      return out;
    }));
    router.post('/sandboxes/:id/import', route(req => {
      const u = us(req);
      const s = /** @type {Sandbox} */ (owned(u, 'sandboxes', req.params.id, 'That sandbox'));
      const b = req.body || {};
      if (s.versions.length >= LIMITS.sandboxVersions) throw invalid('A sandbox keeps ' + LIMITS.sandboxVersions + ' versions at most. Create a new sandbox.');
      const n = s.versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
      const built = X.createSandboxVersion({ sandboxId: s.id, version: n, variable: b.variable === undefined || b.variable === null ? s.variable : b.variable, records: b.records, note: str(b.note, 500) });
      const text = JSON.stringify(built.file);
      checkStorage(req, Buffer.byteLength(text) + 4096);
      u.writeSidecar('sandboxes', s.id, 'v' + n + '.json', text);
      s.versions.push(built.info);
      s.variable = built.file.variable;
      s.updatedAt = now();
      u.put('sandboxes', s);
      u.audit('sandbox.version', { sandbox: s.id, version: n, records: built.info.count, rejected: built.report.rejected });
      return { sandbox: s, report: built.report };
    }));
    router.get('/sandboxes/:id', route(req => {
      const u = us(req);
      const s = /** @type {Sandbox} */ (owned(u, 'sandboxes', req.params.id, 'That sandbox'));
      const latest = s.versions.reduce((m, v) => Math.max(m, v.version), 0);
      const n = req.query.version === undefined || req.query.version === '' ? latest : Number(req.query.version);
      const info = s.versions.find(v => v.version === n);
      if (!info) throw notFound('Version ' + String(req.query.version).slice(0, 10) + ' of this sandbox');
      const file = fileOf(u, s, n);
      const { offset, limit } = page(req.query, 50);
      return { sandbox: s, version: info, records: file.records.slice(offset, offset + limit), total: file.records.length, offset, limit };
    }));
    router.delete('/sandboxes/:id', route(req => {
      const u = us(req);
      const s = /** @type {Sandbox} */ (owned(u, 'sandboxes', req.params.id, 'That sandbox'));
      const using = /** @type {Experiment[]} */ (u.list('experiments')).filter(e => e.sandboxId === s.id);
      if (using.length && req.query.force !== '1') {
        throw new LabError('in_use', 'Experiment' + (using.length > 1 ? 's ' : ' ') + using.slice(0, 5).map(e => '“' + e.name + '”').join(', ') + (using.length > 5 ? ' and ' + (using.length - 5) + ' more' : '') +
          ' use' + (using.length > 1 ? '' : 's') + ' this sandbox. Delete with force=1 to delete ' + (using.length > 1 ? 'them' : 'it') + ' too.', { status: 409, extra: { experiments: using.length } });
      }
      using.forEach(e => deleteExperiment(u, e));
      u.remove('sandboxes', s.id);
      forgetFiles(u.root);
      u.audit('sandbox.deleted', { sandbox: s.id, experiments: using.length });
      return { ok: true, experimentsDeleted: using.length };
    }));

    /* Experiments */

    router.get('/experiments', route(req => {
      const u = us(req);
      // One pass over the user's runs (read, not kept in memory), grouped by experiment
      /** @type {Map<string, ExecutionRun[]>} */
      const byExperiment = new Map();
      for (const r of /** @type {ExecutionRun[]} */ (u.scan('xruns', () => true))) {
        const list = byExperiment.get(r.experimentId);
        if (list) list.push(r); else byExperiment.set(r.experimentId, [r]);
      }
      return { experiments: /** @type {Experiment[]} */ (u.list('experiments')).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map(e => experimentSummary(e, (byExperiment.get(e.id) || []).sort(newestFirst))) };
    }));
    router.post('/experiments', route((req, res) => {
      const u = us(req);
      if (u.list('experiments').length >= LIMITS.experiments) throw invalid('You have ' + LIMITS.experiments + ' experiments, the most the Lab keeps. Delete some first.');
      const b = req.body || {};
      const s = /** @type {Sandbox} */ (owned(u, 'sandboxes', b.sandboxId, 'That sandbox'));
      const latest = s.versions.reduce((m, v) => Math.max(m, v.version), 0);
      const sv = b.sandboxVersion === undefined || b.sandboxVersion === null || b.sandboxVersion === '' ? latest : Number(b.sandboxVersion);
      const file = fileOf(u, s, sv);
      const language = b.language === undefined || b.language === null || b.language === '' ? 'javascript' : cleanLanguage(b.language);
      const objective = b.objective && typeof b.objective === 'object' ? b.objective : {};
      const name = str(b.name, 120).trim() || (file.variable.name + ' rule').slice(0, 120);
      const at = now();
      /** @type {Experiment} */
      const e = {
        id: newId('experiments'), name, notes: '', archived: false, sandboxId: s.id, sandboxVersion: sv, variable: file.variable, language,
        objective: { text: str(objective.text, LIMITS.objective), criteria: M.cleanCriteria(objective.criteria, file.variable) },
        versions: [], thread: [], selected: null, submissions: [], createdAt: at, updatedAt: at
      };
      if (b.initialCode !== undefined && b.initialCode !== null) {
        const ic = b.initialCode;
        if (typeof ic !== 'object') throw invalid('initialCode must be {code, language, label}.');
        const code = cleanCode(ic.code);
        checkStorage(req, Buffer.byteLength(code) * 2);
        addVersion(e, { code, language: ic.language === undefined ? language : cleanLanguage(ic.language), origin: 'imported', parent: null, label: str(ic.label, LIMITS.label) || 'From the Codebook' });
      }
      u.put('experiments', e);
      u.audit('experiment.created', { experiment: e.id, sandbox: s.id, sandboxVersion: sv, language, versions: e.versions.length });
      res.status(201);
      return { experiment: e };
    }));
    router.get('/experiments/:id', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const s = /** @type {Sandbox | null} */ (u.get('sandboxes', e.sandboxId));
      const info = s ? s.versions.find(v => v.version === e.sandboxVersion) : null;
      const runs = experimentRuns(u, e);
      return {
        experiment: e, runs: runs.map(r => runSummary(r, e)),
        sandbox: info ? Object.assign({ id: e.sandboxId, name: s ? s.name : '', source: s ? s.source : null }, info) : null,
        execution: { mode: settings().mode }, definitions: M.metricDefinitions
      };
    }));
    router.patch('/experiments/:id', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const b = req.body || {};
      if (b.name !== undefined) { const n = str(b.name, 120).trim(); if (!n) throw invalid('Give the experiment a name.'); e.name = n; }
      if (b.notes !== undefined) e.notes = str(b.notes, LIMITS.notes);
      if (b.objective !== undefined) {
        const o = b.objective && typeof b.objective === 'object' ? b.objective : {};
        if (o.text !== undefined) e.objective.text = str(o.text, LIMITS.objective);
        if (o.criteria !== undefined) e.objective.criteria = M.cleanCriteria(o.criteria, e.variable);
      }
      if (b.language !== undefined) e.language = cleanLanguage(b.language);
      if (b.archived !== undefined) e.archived = !!b.archived;
      e.updatedAt = now();
      u.put('experiments', e);
      u.audit('experiment.updated', { experiment: e.id, archived: e.archived, criteria: e.objective.criteria.length });
      return { experiment: e };
    }));
    router.delete('/experiments/:id', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const runs = deleteExperiment(u, e);
      u.audit('experiment.deleted', { experiment: e.id, runs });
      return { ok: true };
    }));

    // The AI writes a new version
    router.post('/experiments/:id/generate', route(async (req, res) => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const b = req.body || {};
      const prompt = promptText(b.prompt);
      if (b.mode !== undefined && !MODES.includes(b.mode)) throw invalid('mode must be new, alternative or refine.');
      const mode = /** @type {'new' | 'alternative' | 'refine'} */ (b.mode || 'new');
      /** @type {ExperimentVersion | null} */
      let base = null;
      if (b.baseVersion !== undefined && b.baseVersion !== null && b.baseVersion !== '') base = versionOf(e, b.baseVersion);
      else if (mode !== 'new') {
        base = e.versions.reduce((/** @type {ExperimentVersion | null} */ m, v) => (!m || v.version > m.version ? v : m), null);
        if (!base) throw invalid('Alternative and Refine start from a version: generate or write one first.');
      }
      const { file } = experimentData(u, e);
      checkStorage(req, 128 * 1024);
      const baseRun = base ? lastSucceeded(u, e, base.version) : null;
      const providerId = str(b.provider, 40) || 'metacode';
      const language = e.language;
      const messages = A.generationMessages({
        variable: e.variable, language, objective: e.objective, mode, prompt,
        base: base ? { version: base.version, code: base.code, language: base.language, metrics: baseRun ? baseRun.metrics : null } : null,
        thread: threadEntries(e), records: file.records
      });
      const r = await chat(req.lab, providerId, str(b.model, 120), messages, A.AI_SETTINGS.generation, { interactive: true });
      const g = A.parseGeneration(r.text, r.finishReason, language);
      const fresh = experiment(req, e.id);
      const ver = addVersion(fresh, {
        code: g.code, language, origin: 'generated', parent: base ? base.version : null, prompt,
        generation: { provider: r.provider, model: r.model, prompt, mode, summary: g.summary, proposedImprovement: g.proposedImprovement, reasoning: g.reasoning, assumptions: g.assumptions, expectedTradeoffs: g.expectedTradeoffs, usage: r.usage }
      });
      pushThread(fresh, [
        { role: 'user', kind: 'generate', text: prompt, version: null, model: null },
        { role: 'assistant', kind: 'generate', text: g.summary || 'Created v' + ver.version + '.', version: ver.version, model: r.model }
      ]);
      u.put('experiments', fresh);
      // The AI security review, stored with the version (advisory; the policy above is authoritative)
      const review = await reviewCode(req.lab, ver, fresh.variable, { provider: r.provider, model: r.model, interactive: true });
      const saved = updateVersion(u, fresh.id, ver, v => { v.review = review; });
      const p = /** @type {PolicyReport | null} */ (ver.policy);
      // (deleted while the review ran: nothing is written back, not even the audit line)
      if (saved) u.audit('experiment.version', { experiment: e.id, version: ver.version, origin: 'generated', mode, policyOk: p ? p.ok : null, review: review.decision });
      res.status(201);
      return saved ? { experiment: saved.e, version: saved.v } : { experiment: fresh, version: Object.assign(ver, { review }) };
    }));

    // A question about the experiment (a text answer; no code is created)
    router.post('/experiments/:id/ask', route(async req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const b = req.body || {};
      const question = promptText(b.prompt);
      /** @type {ExperimentVersion | null} */
      let ver = null;
      if (b.version !== undefined && b.version !== null && b.version !== '') ver = versionOf(e, b.version);
      else if (e.selected) ver = e.versions.find(v => e.selected && v.version === e.selected.version) || null;
      if (!ver && e.versions.length) ver = e.versions[e.versions.length - 1];
      const { file } = experimentData(u, e);
      checkStorage(req, 32 * 1024);
      const run = ver ? lastSucceeded(u, e, ver.version) : null;
      const messages = A.questionMessages({ question, variable: e.variable, objective: e.objective, version: ver ? { version: ver.version, code: ver.code, language: ver.language } : null,
        metrics: run ? run.metrics : null, thread: threadEntries(e), records: file.records });
      const r = await chat(req.lab, str(b.provider, 40) || 'metacode', str(b.model, 120), messages, A.AI_SETTINGS.question, { interactive: true });
      const a = A.parseAnswer(r.text, r.finishReason);
      const fresh = experiment(req, e.id);
      const added = pushThread(fresh, [
        { role: 'user', kind: 'ask', text: question, version: ver ? ver.version : null, model: null },
        { role: 'assistant', kind: 'ask', text: a.text + (a.truncated ? '\n\n(The answer was cut off at its length limit.)' : ''), version: ver ? ver.version : null, model: r.model }
      ]);
      fresh.updatedAt = now();
      u.put('experiments', fresh);
      return { experiment: fresh, answer: added[1] };
    }));

    // Code saved from the editor: a new version (never an overwrite)
    router.post('/experiments/:id/versions', route((req, res) => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const b = req.body || {};
      if (!EDIT_ORIGINS.includes(b.origin)) throw invalid('origin must be edited, duplicated or reverted.');
      const parent = b.parent === undefined || b.parent === null || b.parent === '' ? null : versionOf(e, b.parent);
      const code = cleanCode(b.code);
      const language = b.language === undefined || b.language === null || b.language === '' ? (parent ? parent.language : e.language) : cleanLanguage(b.language);
      if (b.origin === 'edited' && parent && parent.code === code && parent.language === language) {
        throw new LabError('unchanged', 'The code is the same as v' + parent.version + '. Change it before saving a new version (or run v' + parent.version + ').', { status: 409, extra: { version: parent.version } });
      }
      checkStorage(req, Buffer.byteLength(code) * 2 + 4096);
      const ver = addVersion(e, { code, language, origin: b.origin, parent: parent ? parent.version : null, label: str(b.label, LIMITS.label) });
      u.put('experiments', e);
      u.audit('experiment.version', { experiment: e.id, version: ver.version, origin: ver.origin, parent: ver.parent, policyOk: ver.policy ? ver.policy.ok : null });
      res.status(201);
      return { experiment: e, version: ver };
    }));
    router.patch('/experiments/:id/versions/:v', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const ver = versionOf(e, req.params.v);
      const b = req.body || {};
      if (b.label !== undefined) ver.label = str(b.label, LIMITS.label).trim();
      if (b.annotation !== undefined) ver.annotation = str(b.annotation, LIMITS.annotation);
      if (b.candidate !== undefined) ver.candidate = !!b.candidate;
      e.updatedAt = now();
      u.put('experiments', e);
      return { experiment: e, version: ver };
    }));

    // Policy and AI review now, without running anything
    router.post('/experiments/:id/versions/:v/check', route(async req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const ver = versionOf(e, req.params.v);
      const b = req.body || {};
      let policy = policyOf(ver);
      /** @type {{ type: string, message: string } | null} */
      let policyError = null;
      if (ver.language !== 'python') policy = CP.analyzeJavaScript(ver.code, ver.language);
      else if (!policy) {
        try { policy = await analyzePython(req.lab.key, ver, e.variable); } catch (err) {
          if (!isLabError(err)) throw err;
          policyError = { type: err.type, message: err.message };
        }
      }
      let review = reviewOf(ver);
      if (!review || review.decision === 'unavailable') {   // (one that couldn't be made is asked again)
        const gen = ver.generation;
        review = await reviewCode(req.lab, ver, e.variable, { provider: str(b.provider, 40) || (gen ? gen.provider : 'metacode'), model: str(b.model, 120) || (gen ? gen.model : ''), interactive: true });
      }
      const pol = policy, rev = review;
      updateVersion(u, e.id, ver, v => { if (pol) v.policy = pol; v.review = rev; });
      return Object.assign({ policy, review }, policyError ? { policyError } : {});
    }));
    router.post('/experiments/:id/versions/:v/acknowledge', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const ver = versionOf(e, req.params.v);
      const b = req.body || {};
      if (typeof b.codeHash !== 'string' || b.codeHash !== ver.codeHash) throw new LabError('stale_code', 'That isn\'t the code of v' + ver.version + ' as stored. Reload the version and read its review again.', { status: 409, extra: { version: ver.version, codeHash: ver.codeHash } });
      const review = reviewOf(ver);
      if (!review) throw new LabError('review_missing', 'v' + ver.version + ' has no AI review yet. Check it first.', { status: 409 });
      if (review.decision === 'rejected') throw new LabError('review_rejected', 'The AI review rejected v' + ver.version + ', so it can\'t be allowed to run. Change the code and save a new version.', { status: 409 });
      if (review.decision === 'approved') throw invalid('The AI review approved v' + ver.version + ': there is nothing to acknowledge.');
      ver.reviewAck = { at: now(), codeHash: ver.codeHash };
      e.updatedAt = now();
      u.put('experiments', e);
      u.audit('experiment.review_acknowledged', { experiment: e.id, version: ver.version, decision: review.decision });
      return { experiment: e, version: ver };
    }));

    // Run a version (a background job; poll GET /xruns/:id)
    router.post('/experiments/:id/runs', route(async (req, res) => {
      const u = us(req);
      const b = req.body || {};
      let e = experiment(req, req.params.id);
      let ver = versionOf(e, b.version);
      /** @param {ExperimentVersion} v */
      const staleCheck = v => {
        if (typeof b.codeHash !== 'string' || b.codeHash !== v.codeHash) {
          throw new LabError('stale_code', 'The code you ran isn\'t v' + v.version + ' as stored (it changed, or another tab saved a new version). Save it as a new version, then run that.', { status: 409, extra: { version: v.version, codeHash: v.codeHash } });
        }
      };
      staleCheck(ver);
      if (b.split !== undefined && !SPLITS.includes(b.split)) throw invalid('split must be all, test or dev.');
      const split = /** @type {'all' | 'test' | 'dev'} */ (b.split || 'all');
      const s = settings();
      if (s.mode !== 'sandbox') throw new LabError('execution_disabled', 'Running code is switched off on this server (AI_LAB_CODE_EXECUTION isn\'t "sandbox").', { status: 503 });
      const support = sandbox.supported(ver.language);
      if (!support.ok) throw new LabError('not_available', support.reason, { status: 503 });
      if (s.isolation === 'namespace') {
        const iso = await sandbox.isolation(ver.language);
        if (!iso.networkNamespace) throw new LabError('isolation_unavailable', 'This server runs code only inside an OS network namespace (AI_LAB_SANDBOX_ISOLATION=namespace), and it can\'t create one now.', { status: 503 });
        e = experiment(req, req.params.id);
        ver = versionOf(e, b.version);
        staleCheck(ver);
      }
      const active = activeByUser.get(req.lab.key);
      if (active) throw new LabError('run_in_progress', 'One of your runs is still going. Wait for it to finish, or cancel it.', { status: 409, extra: { runId: active } });
      const sbx = /** @type {Sandbox} */ (owned(u, 'sandboxes', e.sandboxId, 'The experiment\'s sandbox data'));
      const info = sbx.versions.find(v => v.version === e.sandboxVersion);
      if (!info) throw notFound('The experiment\'s sandbox data');
      checkStorage(req, info.count * 300 + 64 * 1024);
      const python = ver.language === 'python';
      const at = now();
      /** @type {ExecutionRun} */
      const run = {
        id: newId('xruns'), experimentId: e.id, version: ver.version, codeHash: ver.codeHash, language: ver.language, status: 'queued', stage: 'input', failure: null,
        sandbox: { id: sbx.id, version: info.version, sha256: info.sha256, split, recordCount: 0, recordIdsHash: '' },
        config: { timeoutMs: s.timeoutMs, memoryMb: python ? s.pythonMemoryMb : s.memoryMb, maxOutputKb: s.maxOutputKb, policyVersion: CP.POLICY_VERSION, contract: 'classify/1', node: process.version },
        engine: null, isolation: null, security: { policy: null, review: null, acknowledged: false }, log: [], logTruncated: false,
        timing: { queuedAt: at, startedAt: null, finishedAt: null, durationMs: null, bootMs: null }, resources: null, output: null, metrics: null, createdAt: at
      };
      u.put('xruns', run);
      ver.runIds.push(run.id);
      if (ver.runIds.length > LIMITS.runIdsKept) ver.runIds.splice(0, ver.runIds.length - LIMITS.runIdsKept);
      ver.lastRun = { id: run.id, status: 'queued', finishedAt: null };
      e.updatedAt = at;
      u.put('experiments', e);
      u.audit('experiment.run', { experiment: e.id, version: ver.version, run: run.id, split, language: ver.language });
      const created = JSON.parse(JSON.stringify(runSummary(run, e)));   // as created: the job may start at once
      enqueue({ key: req.lab.key, runId: run.id, principal: req.lab });
      created.active = true;
      res.status(202);
      return { run: created };
    }));

    router.get('/xruns/:id', route(req => {
      const u = us(req);
      const run = ownedRun(u, req.params.id, 'That run');
      const since = Math.max(0, Math.floor(Number(req.query.since)) || 0);
      const lines = logOf(u, run);
      const out = runSummary(run);
      out.log = lines.filter(l => l.seq > since);
      out.logTotal = lines.length;
      return { run: out, logTotal: lines.length };
    }));
    router.post('/xruns/:id/cancel', route(async req => {
      const u = us(req);
      const run = ownedRun(u, req.params.id, 'That run');
      if (!ACTIVE.includes(run.status)) throw invalid('Only queued or running runs can be cancelled (this one is ' + run.status + ').');
      const c = cancel(run.id);
      if (!c || c.queued) {
        // Not started (or no longer known to this process): it ends here
        if (c && c.queued) run.stage = 'input';
        markEnded(u, run, 'cancelled', 'cancelled', 'Cancelled before it started.');
      } else if (c.promise) {
        await Promise.race([c.promise, new Promise(r => setTimeout(r, CANCEL_WAIT_MS).unref())]);
      }
      // (the run — or all of the user's data — deleted while this waited: nothing is written back, not even the audit line)
      const fresh = runOf(u, run.id);
      if (fresh) u.audit('experiment.run_cancelled', { run: run.id });
      return { run: runSummary(fresh || run) };
    }));
    router.get('/xruns/:id/results', route(req => {
      const u = us(req);
      const run = ownedRun(u, req.params.id, 'That run');
      const results = resultsOf(u, run);
      if (!results) throw new LabError('no_results', 'This run has no validated results: only a run that succeeded has them.', { status: 409, extra: { status: run.status } });
      const sbx = /** @type {Sandbox} */ (owned(u, 'sandboxes', run.sandbox.id, 'The run\'s sandbox data'));
      const file = fileOf(u, sbx, run.sandbox.version);
      const recs = new Map(file.records.map(r => [r.id, r]));
      const against = req.query.against === undefined || req.query.against === '' ? 'baseline' : String(req.query.against);
      /** @type {Map<string, string | null> | null} */
      let other = null;
      if (against !== 'baseline') {
        const o = ownedRun(u, against, 'The run to compare with');
        if (o.sandbox.id !== run.sandbox.id || o.sandbox.version !== run.sandbox.version || o.sandbox.sha256 !== run.sandbox.sha256) {
          throw new LabError('not_comparable', 'Those runs used different sandbox data, so their results can\'t be compared record by record.', { status: 409 });
        }
        const or = resultsOf(u, o);
        if (!or) throw new LabError('no_results', 'The run to compare with has no validated results.', { status: 409 });
        other = new Map(or.map(r => [r.id, r.error ? null : r.code]));
      }
      const f = String(req.query.filter || 'all');
      if (!['all', 'changed', 'wrong', 'errors', 'nocode'].includes(f)) throw invalid('filter must be all, changed, wrong, errors or nocode.');
      const rows = results.map(r => {
        const rec = recs.get(r.id);
        const code = r.error ? null : r.code;
        const known = other ? other.has(r.id) : !!rec && rec.baseline !== null;
        const a = !known ? null : other ? /** @type {string | null} */ (other.get(r.id)) : /** @type {SandboxRecord} */ (rec).baseline;
        return {
          id: r.id, text: rec ? rec.text.slice(0, 600) : '', author: rec ? rec.author : '', code: r.code, confidence: r.confidence, reason: r.reason, error: r.error,
          reference: rec ? rec.reference : null, baseline: rec ? rec.baseline : null, against: a, changed: known && a !== code, split: rec ? rec.split : null
        };
      }).filter(x => f === 'all' || (f === 'changed' && x.changed) || (f === 'wrong' && x.reference !== null && (x.error ? null : x.code) !== x.reference) ||
        (f === 'errors' && !!x.error) || (f === 'nocode' && !x.error && x.code === null));
      const { offset, limit } = page(req.query, 25);
      return { results: rows.slice(offset, offset + limit), total: rows.length, offset, limit, filter: f, against };
    }));

    // Two versions (or a version and MetaCode's current AI coding) side by side
    router.get('/experiments/:id/compare', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const { file } = experimentData(u, e);
      const criteria = e.objective.criteria;
      /** @type {string[]} */
      const warnings = [];
      for (const [q, name] of [[req.query.a, 'version A'], [req.query.b, 'version B']]) if (q === undefined || q === '') throw invalid('Choose ' + name + ': a version number or baseline.');
      /** The current AI coding, measured on `records` (those of the run it is set against). @param {SandboxRecord[]} records */
      const baselineSide = records => {
        const has = records.some(r => r.baseline !== null);
        if (!has) warnings.push('These records have no current AI Coding labels, so there is nothing to compare on the baseline side.');
        const metrics = has ? M.computeMetrics(M.baselineResults(records), records, file.variable) : null;
        return { out: { kind: 'baseline', version: null, code: null, language: null, codeHash: null, origin: null, label: 'Current AI coding', policy: null, review: null, run: null, metrics, score: metrics ? M.scoreRun(metrics, criteria) : null }, run: null, results: null, ok: has };
      };
      /** @param {unknown} q */
      const versionSide = q => {
        const ver = versionOf(e, q);
        const run = lastSucceeded(u, e, ver.version);
        const results = run ? resultsOf(u, run) : null;
        if (!run || !results) warnings.push('v' + ver.version + ' has no successful run on sandbox data v' + e.sandboxVersion + ': run it to compare measured results.');
        return {
          out: { kind: 'version', version: ver.version, code: ver.code, language: ver.language, codeHash: ver.codeHash, origin: ver.origin, label: ver.label, policy: policyOf(ver), review: reviewOf(ver),
            run: run ? runSummary(run, e) : null, metrics: run ? run.metrics : null, score: run ? M.scoreRun(run.metrics, criteria) : null },
          run, results, ok: !!(run && results)
        };
      };
      const va = req.query.a === 'baseline' ? null : versionSide(req.query.a);
      const vb = req.query.b === 'baseline' ? null : versionSide(req.query.b);
      // The baseline side covers the same records as the run it is compared with (that run's split), not all of them
      const against = (vb && vb.run) || (va && va.run) || null;
      const baseRecords = against ? X.selectRecords(file.records, against.sandbox.split) : file.records;
      const a = va || baselineSide(baseRecords), b = vb || baselineSide(baseRecords);
      let comparison = null;
      if (a.ok && b.ok && b.run && b.results) {
        const c = M.compareRuns(a.run, a.results, b.run, b.results, file.records);
        if (!c.sameSplit) warnings.push('The two runs used different records (splits): only records in both are compared.');
        const recs = new Map(file.records.map(r => [r.id, r]));
        comparison = Object.assign({}, c, {
          changed: c.changed.slice(0, LIMITS.changedShown).map(x => { const r = recs.get(x.id); return Object.assign({}, x, { text: r ? r.text.slice(0, 200) : '', split: r ? r.split : null }); }),
          changedTruncated: c.changed.length > LIMITS.changedShown
        });
      }
      if (!file.records.some(r => r.reference !== null)) warnings.push('These records have no reference labels, so accuracy, F1 and κ can\'t be measured. Compare coverage, consistency and agreement with the current AI coding instead.');
      return { a: a.out, b: b.out, comparison, criteria, warnings };
    }));

    // The AI explains a run's measured results (its numbers are checked)
    router.post('/experiments/:id/versions/:v/evaluate', route(async req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const ver = versionOf(e, req.params.v);
      const b = req.body || {};
      const run = lastSucceeded(u, e, ver.version);
      const results = run ? resultsOf(u, run) : null;
      if (!run || !results || !run.metrics) throw new LabError('no_run', 'Run v' + ver.version + ' successfully first: the evaluation explains measured results.', { status: 409 });
      const { file } = experimentData(u, e);
      const target = b.against === undefined || b.against === null || b.against === '' ? 'baseline' : String(b.against);
      /** @type {AiEvaluation['against']} */
      let against = { kind: 'none', version: null, runId: null };
      /** @type {ExecutionMetrics | null} */
      let targetMetrics = null;
      let comparison = null;
      if (target === 'baseline') {
        against = { kind: 'baseline', version: null, runId: null };
        // Measured on the records this run used (its split), so both sides cover the same records; without its
        // agreement with itself (always 100 %, κ 1), which says nothing and would "verify" invented 100 % / 1.00
        const recs = X.selectRecords(file.records, run.sandbox.split);
        if (recs.some(r => r.baseline !== null)) targetMetrics = Object.assign(M.computeMetrics(M.baselineResults(recs), recs, file.variable), { baseline: null });
        comparison = M.compareRuns(null, null, run, results, file.records);
      } else if (target !== 'none') {
        const w = versionOf(e, target);
        const wr = lastSucceeded(u, e, w.version);
        const wres = wr ? resultsOf(u, wr) : null;
        against = { kind: 'version', version: w.version, runId: wr ? wr.id : null };
        if (wr && wres) { targetMetrics = wr.metrics; comparison = M.compareRuns(wr, wres, run, results, file.records); }
      }
      const metrics = run.metrics;
      const messages = A.evaluationMessages({
        objective: e.objective, version: { version: ver.version, language: ver.language, generation: ver.generation }, metrics,
        against: { kind: against.kind, version: against.version, metrics: targetMetrics },
        comparison: comparison ? { counts: comparison.counts, changed: comparison.changed } : null, records: file.records
      });
      const gen = ver.generation;
      const r = await chat(req.lab, str(b.provider, 40) || (gen ? gen.provider : 'metacode'), str(b.model, 120) || (gen && !b.provider ? gen.model : ''), messages, A.AI_SETTINGS.evaluation, { interactive: true });
      const parsed = A.parseEvaluation(r.text, r.finishReason);
      const fields = [parsed.proposedImprovement, parsed.reasoning, parsed.observedResults, parsed.comparison, parsed.tradeoffs, parsed.limitations];
      /** @type {AiEvaluation} */
      const evaluation = Object.assign({ runId: run.id, against }, parsed, {
        unverifiedNumbers: M.verifyNumbers(fields, metrics, { against: targetMetrics, counts: comparison ? comparison.counts : null }),
        provider: r.provider, model: r.model, method: /** @type {'ai-eval-v1'} */ ('ai-eval-v1'), createdAt: now()
      });
      if (updateVersion(u, e.id, ver, v => { v.evaluation = evaluation; })) u.audit('experiment.evaluated', { experiment: e.id, version: ver.version, run: run.id, against: against.kind, unverified: evaluation.unverifiedNumbers.length });
      return { evaluation };
    }));

    // The final version
    router.post('/experiments/:id/select', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const b = req.body || {};
      const ver = versionOf(e, b.version);
      const c = finalCheck(u, e, ver);
      if ('problem' in c) throw new LabError('not_selectable', c.problem, { status: 409 });
      e.selected = { version: ver.version, codeHash: ver.codeHash, runId: c.run.id, rationale: str(b.rationale, LIMITS.rationale).trim(), selectedAt: now() };
      e.updatedAt = now();
      u.put('experiments', e);
      u.audit('experiment.selected', { experiment: e.id, version: ver.version, run: c.run.id });
      return { experiment: e };
    }));
    router.delete('/experiments/:id/select', route(req => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      e.selected = null;
      e.updatedAt = now();
      u.put('experiments', e);
      u.audit('experiment.unselected', { experiment: e.id });
      return { experiment: e };
    }));

    // Send to Codebook: a submission the MetaCode app applies after the user confirms
    router.post('/experiments/:id/codebook', route((req, res) => {
      const u = us(req);
      const e = experiment(req, req.params.id);
      const b = req.body || {};
      const key = typeof b.idempotencyKey === 'string' ? b.idempotencyKey.trim() : '';
      if (!key || key.length > LIMITS.idempotencyKey || /[\u0000-\u001F\u007F]/.test(key)) throw invalid('Send an idempotencyKey of 1–' + LIMITS.idempotencyKey + ' characters (retries reuse it).');
      // The current selection and its final checks come first, also for a key that was used before
      const sel = e.selected;
      if (!sel) throw new LabError('no_selection', 'Select the final version first.', { status: 409 });
      const ver = versionOf(e, sel.version);
      if (ver.codeHash !== sel.codeHash) throw new LabError('not_selectable', 'The selection doesn\'t match v' + ver.version + '\'s code. Select it again.', { status: 409 });
      const c = finalCheck(u, e, ver);
      if ('problem' in c) throw new LabError('not_selectable', c.problem + ' Select a version again.', { status: 409 });
      if (c.run.id !== sel.runId) throw new LabError('not_selectable', 'v' + ver.version + ' ran again after it was selected. Select it again to send its latest results.', { status: 409 });
      const existing = /** @type {Submission | undefined} */ (e.submissions.find(s => s.idempotencyKey === key));
      if (existing) {
        // A key is one send of one selection: it returns that submission only while it is exactly the current selection
        const p = existing.payload;
        if (existing.version !== sel.version || existing.codeHash !== sel.codeHash || !p || !p.evaluation || p.evaluation.runId !== sel.runId || p.rationale !== sel.rationale) {
          throw new LabError('key_mismatch', 'This send belongs to an earlier selection; send again.', { status: 409 });
        }
        // Send again (the user clicked Send or Retry): offered to the app again, even if it was applied before
        if (b.resend === true) {
          existing.status = 'pending';
          existing.error = null;
          existing.resolvedAt = null;
          existing.dimensionId = null;
          existing.resentAt = now();
          existing.payload.sentAt = now();
          e.updatedAt = now();
          u.put('experiments', e);
          u.audit('experiment.codebook', { experiment: e.id, version: existing.version, submission: existing.id, retry: true });
        }
        res.status(200);
        return { submission: existing };
      }
      if (Buffer.byteLength(ver.code, 'utf8') > LIMITS.codebookBytes) throw new LabError('too_large', 'The Codebook keeps coding rules up to ' + (LIMITS.codebookBytes / 1024) + ' KB; v' + ver.version + ' is larger.', { status: 413 });
      if (!CODE_ID_RE.test(e.variable.id)) throw invalid('The variable id can\'t be used in the Codebook.');
      const id = newId('submissions');
      /** @type {CodebookSubmission} */
      const sub = {
        id, idempotencyKey: key, version: ver.version, codeHash: ver.codeHash, status: 'pending', createdAt: now(), resolvedAt: null, dimensionId: null, error: null,
        payload: codingRule(e, ver, c.run, /** @type {Sandbox | null} */ (u.get('sandboxes', c.run.sandbox.id)), c.review, id)
      };
      e.submissions.push(sub);
      if (e.submissions.length > LIMITS.submissions) e.submissions.splice(0, e.submissions.length - LIMITS.submissions);
      e.updatedAt = now();
      u.put('experiments', e);
      u.audit('experiment.codebook', { experiment: e.id, version: ver.version, submission: id, retry: false });
      res.status(201);
      return { submission: sub };
    }));

    /** @param {UserStore} u @param {unknown} id */
    function submissionOf(u, id) {
      if (typeof id === 'string' && SUBMISSION_ID_RE.test(id)) {
        for (const e of /** @type {Experiment[]} */ (u.list('experiments'))) {
          const s = (e.submissions || []).find(x => x.id === id);
          if (s) return { e, s };
        }
      }
      throw notFound('That Codebook submission');
    }
    router.get('/codebook-submissions/:id', route(req => {
      const { e, s } = submissionOf(us(req), req.params.id);
      return { submission: s, experiment: { id: e.id, name: e.name }, variable: { id: e.variable.id, name: e.variable.name } };
    }));
    router.post('/codebook-submissions/:id/result', route(req => {
      const u = us(req);
      const { e, s } = submissionOf(u, req.params.id);
      const b = req.body || {};
      if (b.status !== 'applied' && b.status !== 'failed') throw invalid('status must be applied or failed.');
      if (s.status === 'applied') return { submission: s };   // applied stays applied
      if (b.status === 'applied') {
        const dim = b.dimensionId === undefined || b.dimensionId === null ? s.payload.dimensionId : b.dimensionId;
        if (typeof dim !== 'string' || !CODE_ID_RE.test(dim) || dim !== s.payload.dimensionId) throw invalid('dimensionId must be the rule\'s variable id (' + s.payload.dimensionId + ').');
        s.status = 'applied';
        s.dimensionId = dim;
        s.error = null;
      } else {
        s.status = 'failed';
        s.error = str(b.error, 500).trim() || 'Not saved in MetaCode.';
      }
      s.resolvedAt = now();
      e.updatedAt = now();
      u.put('experiments', e);
      u.audit('experiment.codebook_result', { experiment: e.id, submission: s.id, status: s.status });
      return { submission: s };
    }));
  }

  return {
    routes,
    start() {
      stopping = false;
      recover();
      // Probe the OS isolation once at start (cached), so the first run doesn't wait for it
      if (settings().mode === 'sandbox') sandbox.isolation('javascript').catch(() => null);
    },
    shutdown() {
      stopping = true;
      running.forEach(r => r.ac.abort());
      queue.length = 0;
      activeByUser.clear();
    },
    cancelUser,
    /** A user's runs for the data export, each with all of its terminal lines. @param {UserStore} u */
    exportRuns(u) { return /** @type {StoredRun[]} */ (u.scan('xruns', () => true)).map(r => Object.assign({}, r, { log: logOf(u, r) })); },
    stats() {
      return { running: running.size, queued: queue.length, runsByStatus: Object.assign(Object.fromEntries(STATUSES.filter(s => !ACTIVE.includes(s)).map(s => [s, 0])), runsByStatus), sandbox: sandbox.stats() };
    },
    isActive
  };
}

module.exports = { createExperiments, LIMITS };
