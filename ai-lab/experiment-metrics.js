// @ts-check
// ── Measured results of a coding rule ─────────────────────────────────────────
// Everything here is computed from validated results (one per record) and the
// sandbox's labels — nothing is estimated or asked of a model:
//
//   - coverage, error rate and the distribution of codes;
//   - against reference labels (human coding or a dataset): accuracy,
//     precision/recall/F1 per code, macro-F1, Cohen's κ and the confusion
//     matrix — separately for held-out (test) records, dev records and all;
//   - against MetaCode's current AI coding (baseline): agreement, κ and how
//     many records changed — agreement, never "accuracy";
//   - consistency: records with the same normalised text should get the same code.
//
// κ and the confusion matrix come from public/js/reliability-stats.js, the
// same code the Reliability Analysis tab uses. scoreRun() turns the user's
// success criteria into one objective score, compareRuns() lists what changed
// between two runs, and verifyNumbers() finds numbers in AI-written text that
// don't match anything measured.

const ReliabilityStats = require('../public/js/reliability-stats.js');
const { invalid } = require('./errors');

/** @typedef {import('../types/lab-experiments').RecordResult} RecordResult */
/** @typedef {import('../types/lab-experiments').SandboxRecord} SandboxRecord */
/** @typedef {import('../types/lab-experiments').SandboxVariable} SandboxVariable */
/** @typedef {import('../types/lab-experiments').ExecutionMetrics} ExecutionMetrics */
/** @typedef {import('../types/lab-experiments').ReferenceScores} ReferenceScores */
/** @typedef {import('../types/lab-experiments').ClassScores} ClassScores */
/** @typedef {import('../types/lab-experiments').MetricKey} MetricKey */
/** @typedef {import('../types/lab-experiments').SuccessCriterion} SuccessCriterion */
/** @typedef {import('../types/lab-experiments').ExecutionRun} ExecutionRun */
/** @typedef {{ metric: MetricKey, weight: number, value: number | null, used: boolean }} ScorePart */
/** @typedef {{ score: number | null, parts: ScorePart[], missing: MetricKey[] }} RunScore */
/** @typedef {{ id: string, a: string | null, b: string | null, reference: string | null }} ChangedRecord */
/** @typedef {{ sameSandbox: boolean, sameSplit: boolean, changed: ChangedRecord[], counts: { changed: number, fixed: number, broken: number } }} RunComparison */

/** The category used for "no code" (null, or an error) in κ and the confusion matrix. */
const NONE = '(none)';

/**
 * Plain-English definitions, shown in the Lab next to every number.
 * direction: whether higher or lower is better (null: neither).
 */
const metricDefinitions = Object.freeze({
  accuracy: { label: 'Accuracy', direction: 'higher', definition: 'Share of records with a reference label where the rule\'s code equals that label. A record with no code or an error counts as wrong. Held-out accuracy uses only test records, which the AI never saw.' },
  macroF1: { label: 'Macro-F1', direction: 'higher', definition: 'The F1 score of each code, averaged over the codes that appear in the reference labels, so rare codes count as much as common ones. A code that is never predicted scores 0.' },
  kappa: { label: 'Cohen\'s κ', direction: 'higher', definition: 'Agreement with the reference labels corrected for the agreement expected by chance: 1 is perfect, 0 is chance level, below 0 is worse than chance. "No code" counts as its own category.' },
  precision: { label: 'Precision', direction: 'higher', definition: 'Of the records the rule gave this code, the share whose reference label is this code. Not measured when the rule never used the code.' },
  recall: { label: 'Recall', direction: 'higher', definition: 'Of the records whose reference label is this code, the share the rule gave this code. Not measured when no reference label uses the code.' },
  f1: { label: 'F1', direction: 'higher', definition: 'The harmonic mean of precision and recall for one code (2·TP / (2·TP + FP + FN)); 0 when the code has reference labels but was never predicted correctly.' },
  coverage: { label: 'Coverage', direction: 'higher', definition: 'Share of processed records that got a code (not "no code" and not an error).' },
  errorRate: { label: 'Error rate', direction: 'lower', definition: 'Share of processed records where classify threw an error.' },
  baselineAgreement: { label: 'Agreement with current AI coding', direction: 'higher', definition: 'Share of records (with a current AI Coding label) where the rule gives the same code as MetaCode\'s current AI coding. This is agreement, not accuracy: the current AI coding can be wrong too.' },
  consistency: { label: 'Consistency', direction: 'higher', definition: 'Among groups of two or more records with the same text (ignoring case, links and punctuation), the share of groups where every record got the same code. Not measured when no text repeats.' },
  runtime: { label: 'Runtime', direction: 'lower', definition: 'Time the sandbox spent running the rule on all records, and the mean time per record when the engine reported it. Shown, not scored.' },
  confusion: { label: 'Confusion matrix', direction: null, definition: 'Rows are reference labels, columns are the rule\'s codes; each cell counts the records with that pair. The diagonal is agreement.' },
  objectiveScore: { label: 'Objective score', direction: 'higher', definition: 'The weighted mean of your success criteria, each scaled to 0–1 (κ as (κ+1)/2, error rate as 1 − error rate). Reference metrics use held-out records when there are any. Criteria that can\'t be measured are left out and listed.' },
  heldOut: { label: 'Held-out records', direction: null, definition: 'About 70% of the sandbox records (the test split) are never shown to the AI. Scores on them show how the rule does on records it wasn\'t written from.' }
});

const BASE_METRICS = ['accuracy', 'macroF1', 'kappa', 'coverage', 'errorRate', 'baselineAgreement', 'consistency', 'runtime'];
/** The criteria a new experiment starts with. @type {SuccessCriterion[]} */
const DEFAULT_CRITERIA = [{ metric: 'macroF1', weight: 3 }, { metric: 'coverage', weight: 1 }, { metric: 'consistency', weight: 1 }];

/**
 * Validates success criteria: at most 5, weights 0–5, metrics known (per-code
 * metrics name one of the variable's codes). Throws a 400 LabError.
 * @param {unknown} criteria
 * @param {SandboxVariable} variable
 * @returns {SuccessCriterion[]}
 */
function cleanCriteria(criteria, variable) {
  if (criteria === undefined || criteria === null) return DEFAULT_CRITERIA.map(c => ({ ...c }));
  if (!Array.isArray(criteria)) throw invalid('criteria must be a list of {metric, weight}.');
  if (criteria.length > 5) throw invalid('At most 5 success criteria.');
  const codes = new Set(variable.codes.map(c => c.id));
  const seen = new Set();
  return criteria.map(c => {
    const metric = c && typeof c.metric === 'string' ? c.metric : '';
    const m = /^(precision|recall|f1):(.+)$/.exec(metric);
    if (!BASE_METRICS.includes(metric) && !(m && codes.has(m[2]))) throw invalid('Unknown metric ' + JSON.stringify(metric.slice(0, 80)) + '.');
    if (seen.has(metric)) throw invalid('The metric ' + metric + ' is listed twice.');
    seen.add(metric);
    const weight = Number(c.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 5) throw invalid('Weights must be numbers from 0 to 5.');
    return { metric: /** @type {MetricKey} */ (metric), weight };
  });
}

/** @param {number} a @param {number} b */
const ratio = (a, b) => (b > 0 ? a / b : null);

/** The predicted code of a record (null when there is no result, no code or an error). @param {RecordResult | undefined} r */
const predicted = r => (r && !r.error && typeof r.code === 'string' ? r.code : null);

/**
 * Scores against reference labels for one subset of records.
 * @param {SandboxRecord[]} subset     records that have a reference label
 * @param {Map<string, RecordResult>} results
 * @param {string[]} codes
 * @returns {ReferenceScores | null}
 */
function referenceScores(subset, results, codes) {
  const n = subset.length;
  if (!n) return null;
  /** @type {{ pred: string | null, ref: string }[]} */
  const rows = subset.map(r => ({ pred: predicted(results.get(r.id)), ref: /** @type {string} */ (r.reference) }));
  const correct = rows.filter(x => x.pred === x.ref).length;
  /** @type {Record<string, ClassScores>} */
  const perCode = {};
  const f1s = [];
  for (const c of codes) {
    let tp = 0, fp = 0, fn = 0;
    for (const x of rows) {
      if (x.pred === c && x.ref === c) tp++;
      else if (x.pred === c) fp++;
      else if (x.ref === c) fn++;
    }
    const support = tp + fn;
    const f1 = support > 0 ? (2 * tp) / (2 * tp + fp + fn) : null;
    perCode[c] = { precision: ratio(tp, tp + fp), recall: ratio(tp, support), f1, support };
    if (support > 0 && f1 !== null) f1s.push(f1);
  }
  const categories = codes.concat([NONE]);
  const pairs = rows.map(x => ({ a: x.pred === null ? NONE : x.pred, b: x.ref }));
  const k = ReliabilityStats.cohenKappa(pairs, categories);
  // Rows: reference labels; columns: the rule's codes.
  const cm = ReliabilityStats.confusion(rows.map(x => ({ a: x.ref, b: x.pred === null ? NONE : x.pred })), categories);
  return {
    n,
    accuracy: correct / n,
    macroF1: f1s.length ? f1s.reduce((s, x) => s + x, 0) / f1s.length : null,
    kappa: typeof k.value === 'number' ? k.value : null,
    kappaReason: typeof k.value === 'number' ? null : (k.reason || 'Not measurable.'),
    perCode,
    confusion: { categories: cm.categories, matrix: cm.matrix }
  };
}

/**
 * Text as compared for consistency: lowercase, without links, punctuation runs
 * collapsed to single spaces.
 * @param {string} s
 */
const normaliseText = s => String(s || '').toLowerCase().replace(/\bhttps?:\/\/\S+|\bwww\.\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Computes a run's metrics from its validated results.
 * @param {RecordResult[]} results       one per record (validated)
 * @param {SandboxRecord[]} records      the records the run used (with labels and splits)
 * @param {SandboxVariable} variable
 * @param {{ durationMs?: number }} [opts]
 * @returns {ExecutionMetrics}
 */
function computeMetrics(results, records, variable, opts) {
  const codes = variable.codes.map(c => c.id);
  /** @type {Map<string, RecordResult>} */
  const byId = new Map();
  for (const r of results) if (!byId.has(r.id)) byId.set(r.id, r);
  const processed = results.length;
  const errors = results.filter(r => r.error).length;
  const coded = results.filter(r => predicted(r) !== null).length;

  /** @type {Record<string, number>} */
  const distribution = {};
  codes.forEach(c => { distribution[c] = 0; });
  distribution[NONE] = 0;
  for (const r of results) {
    const p = predicted(r);
    if (p !== null && Object.prototype.hasOwnProperty.call(distribution, p)) distribution[p]++;
    else distribution[NONE]++;
  }

  // Reference labels, by split
  const labelled = records.filter(r => r.reference !== null && r.reference !== undefined);
  const reference = labelled.length ? {
    test: referenceScores(labelled.filter(r => r.split === 'test'), byId, codes),
    dev: referenceScores(labelled.filter(r => r.split === 'dev'), byId, codes),
    all: referenceScores(labelled, byId, codes)
  } : null;

  // MetaCode's current AI coding
  const withBaseline = records.filter(r => r.baseline !== null && r.baseline !== undefined);
  let baseline = null;
  if (withBaseline.length) {
    const rows = withBaseline.map(r => ({ pred: predicted(byId.get(r.id)), base: /** @type {string} */ (r.baseline) }));
    const same = rows.filter(x => x.pred === x.base).length;
    const k = ReliabilityStats.cohenKappa(rows.map(x => ({ a: x.pred === null ? NONE : x.pred, b: x.base })), codes.concat([NONE]));
    baseline = { n: rows.length, agreement: same / rows.length, kappa: typeof k.value === 'number' ? k.value : null, changed: rows.length - same };
  }

  // Consistency: same normalised text → same code
  /** @type {Map<string, Set<string>>} */
  const groups = new Map();
  /** @type {Map<string, number>} */
  const sizes = new Map();
  for (const rec of records) {
    const r = byId.get(rec.id);
    if (!r) continue;
    const key = normaliseText(rec.text);
    if (!key) continue;
    const p = predicted(r);
    if (!groups.has(key)) groups.set(key, new Set());
    /** @type {Set<string>} */ (groups.get(key)).add(p === null ? NONE : p);
    sizes.set(key, (sizes.get(key) || 0) + 1);
  }
  let groupCount = 0, inconsistent = 0;
  groups.forEach((set, key) => {
    if ((sizes.get(key) || 0) < 2) return;
    groupCount++;
    if (set.size > 1) inconsistent++;
  });

  const times = results.map(r => r.ms).filter(ms => typeof ms === 'number' && Number.isFinite(ms));
  const durationMs = opts && typeof opts.durationMs === 'number' && Number.isFinite(opts.durationMs) ? opts.durationMs : 0;
  return {
    records: records.length,
    processed,
    errors,
    errorRate: ratio(errors, processed),
    coverage: ratio(coded, processed),
    distribution,
    reference,
    baseline,
    consistency: { groups: groupCount, inconsistent, score: groupCount ? 1 - inconsistent / groupCount : null },
    runtime: { durationMs, perRecordMeanMs: times.length ? /** @type {number[]} */ (times).reduce((s, x) => s + x, 0) / times.length : null }
  };
}

/**
 * MetaCode's current AI coding as results (one per record; no baseline label
 * → no code), so computeMetrics can measure it against the reference labels
 * like any run. Never stored as a run's results.
 * @param {SandboxRecord[]} records
 * @returns {RecordResult[]}
 */
function baselineResults(records) {
  return records.map(r => ({ id: r.id, code: r.baseline === undefined ? null : r.baseline, confidence: null, reason: '', error: null, ms: null }));
}

/**
 * The reference scores used for scoring: held-out (test) records when there
 * are any, otherwise all labelled records.
 * @param {ExecutionMetrics | null | undefined} metrics
 */
function scoringReference(metrics) {
  if (!metrics || !metrics.reference) return null;
  const r = metrics.reference;
  return r.test && r.test.n >= 1 ? r.test : r.all;
}

/**
 * One criterion's value on a 0–1 scale (null: not measured; runtime is never scored).
 * @param {ExecutionMetrics | null | undefined} metrics
 * @param {string} metric
 * @returns {number | null}
 */
function metricValue(metrics, metric) {
  if (!metrics) return null;
  const ref = scoringReference(metrics);
  /** @param {unknown} v */
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (metric) {
    case 'accuracy': return ref ? num(ref.accuracy) : null;
    case 'macroF1': return ref ? num(ref.macroF1) : null;
    case 'kappa': { const k = ref ? num(ref.kappa) : null; return k === null ? null : (k + 1) / 2; }
    case 'coverage': return num(metrics.coverage);
    case 'errorRate': { const e = num(metrics.errorRate); return e === null ? null : 1 - e; }
    case 'baselineAgreement': return metrics.baseline ? num(metrics.baseline.agreement) : null;
    case 'consistency': return metrics.consistency ? num(metrics.consistency.score) : null;
    case 'runtime': return null;
    default: {
      const m = /^(precision|recall|f1):(.+)$/.exec(metric);
      if (!m || !ref) return null;
      const scores = Object.prototype.hasOwnProperty.call(ref.perCode, m[2]) ? ref.perCode[m[2]] : null;
      return scores ? num(scores[/** @type {'precision' | 'recall' | 'f1'} */ (m[1])]) : null;
    }
  }
}

/**
 * The objective score: Σ weight·value / Σ weight over the criteria that could
 * be measured (each value on 0–1). null when none could. `missing` lists the
 * criteria that couldn't be measured (runtime is shown, never scored, and not
 * listed as missing).
 * @param {ExecutionMetrics | null | undefined} metrics
 * @param {SuccessCriterion[]} criteria
 * @returns {RunScore}
 */
function scoreRun(metrics, criteria) {
  /** @type {ScorePart[]} */
  const parts = [];
  /** @type {MetricKey[]} */
  const missing = [];
  let sum = 0, weights = 0;
  for (const c of Array.isArray(criteria) ? criteria : []) {
    const weight = typeof c.weight === 'number' && Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0;
    const value = metricValue(metrics, c.metric);
    const used = value !== null && weight > 0;
    if (used) { sum += weight * /** @type {number} */ (value); weights += weight; }
    if (value === null && c.metric !== 'runtime') missing.push(c.metric);
    parts.push({ metric: c.metric, weight, value, used });
  }
  return { score: weights > 0 ? sum / weights : null, parts, missing };
}

/**
 * What changed between two runs on the same sandbox version. runA may be null
 * to compare against MetaCode's current AI coding (the records' baseline
 * labels; records without one are left out, as in metrics.baseline). Refuses (sameSandbox false, nothing listed) when the sandbox id,
 * version or hash differ. fixed: wrong in A, right in B (against the reference
 * label); broken: the reverse.
 * @param {Pick<ExecutionRun, 'sandbox'> | null} runA
 * @param {RecordResult[] | null} resultsA
 * @param {Pick<ExecutionRun, 'sandbox'>} runB
 * @param {RecordResult[]} resultsB
 * @param {SandboxRecord[]} records     the sandbox version's records
 * @returns {RunComparison}
 */
function compareRuns(runA, resultsA, runB, resultsB, records) {
  const empty = { changed: 0, fixed: 0, broken: 0 };
  const sa = runA ? runA.sandbox : null, sb = runB.sandbox;
  const sameSandbox = !runA || !!(sa && sb && sa.id === sb.id && sa.version === sb.version && sa.sha256 === sb.sha256);
  if (!sameSandbox) return { sameSandbox: false, sameSplit: false, changed: [], counts: empty };
  const sameSplit = !runA || !!(sa && sb && sa.recordIdsHash === sb.recordIdsHash);
  /** @type {Map<string, string | null>} */
  const a = new Map();
  if (runA) for (const r of resultsA || []) { if (!a.has(r.id)) a.set(r.id, predicted(r)); }
  else for (const rec of records) { if (rec.baseline !== null && rec.baseline !== undefined) a.set(rec.id, rec.baseline); }
  /** @type {Map<string, string | null>} */
  const b = new Map();
  for (const r of resultsB) if (!b.has(r.id)) b.set(r.id, predicted(r));
  /** @type {ChangedRecord[]} */
  const changed = [];
  let fixed = 0, broken = 0;
  for (const rec of records) {
    if (!a.has(rec.id) || !b.has(rec.id)) continue;
    const ca = /** @type {string | null} */ (a.get(rec.id)), cb = /** @type {string | null} */ (b.get(rec.id));
    if (ca === cb) continue;
    const reference = rec.reference === undefined ? null : rec.reference;
    changed.push({ id: rec.id, a: ca, b: cb, reference });
    if (reference !== null) {
      if (ca !== reference && cb === reference) fixed++;
      else if (ca === reference && cb !== reference) broken++;
    }
  }
  return { sameSandbox: true, sameSplit, changed, counts: { changed: changed.length, fixed, broken } };
}

/**
 * Every finite number in a value (objects and arrays, recursively). Durations
 * in milliseconds (keys ending in "Ms") are also added in seconds.
 * @param {unknown} v
 * @param {number[]} out
 * @param {string} [key]
 * @param {number} [depth]
 */
function collectNumbers(v, out, key, depth) {
  const d = depth || 0;
  if (d > 8 || out.length > 50000) return;
  if (typeof v === 'number' && Number.isFinite(v)) {
    out.push(v);
    if (key && /Ms$/.test(key)) out.push(v / 1000);
  } else if (Array.isArray(v)) v.forEach(x => collectNumbers(x, out, key, d + 1));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collectNumbers(x, out, k, d + 1);
}

/** How many digits after the decimal point a number was written with. @param {string} s */
const decimals = s => { const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };

const PERCENT_RE = /(?<![\w.])(-?\d+(?:\.\d+)?)\s?(?:%|percent\b|per cent\b|percentage points?\b)/gi;
const DECIMAL_RE = /(?<![\w.])(-?\d+\.\d+)(?!\.?\d)(?![\w%])/g;
const COUNT_RE = /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(?![\w.,]\d)(\s+(?:[A-Za-z-]+\s+)?(?:records?|posts?|errors?|items?|cases?|examples?|labels?|groups?|codes?|units?|texts?)\b)/gi;
const N_EQUALS_RE = /\bn\s?=\s?(\d{1,3}(?:,\d{3})+|\d+)\b/gi;

/**
 * Numbers in AI-written text that don't match any measured value: percentages
 * (within ±0.15 points of value·100, or half a unit of the last digit shown),
 * decimals (±0.006, or half a unit of the last digit shown) and counts of
 * records, posts, errors … ≥ 2 (exactly). Returns the numbers as written.
 * @param {string[]} texts
 * @param {ExecutionMetrics | null | undefined} metrics
 * @param {unknown} [extra]   other measured values the text may quote (another run's metrics, comparison counts …)
 * @returns {string[]}
 */
function verifyNumbers(texts, metrics, extra) {
  /** @type {number[]} */
  const values = [];
  collectNumbers(metrics, values);
  collectNumbers(extra, values);
  const counts = new Set(values.filter(v => Number.isInteger(v)));
  /** @param {number} p @param {number} tol */
  const percentOk = (p, tol) => values.some(v => Math.abs(v * 100 - p) <= tol + 1e-9);
  /** @param {number} x @param {number} tol */
  const decimalOk = (x, tol) => values.some(v => Math.abs(v - x) <= tol + 1e-9);
  /** @type {string[]} */
  const bad = [];
  /** @param {string} s */
  const flag = s => { const t = s.trim(); if (!bad.includes(t) && bad.length < 50) bad.push(t); };
  for (const raw of Array.isArray(texts) ? texts : []) {
    if (typeof raw !== 'string' || !raw) continue;
    // Remove what's been checked so a number is read once.
    let rest = raw.replace(PERCENT_RE, (m, num) => {
      const p = Number(num);
      if (!percentOk(p, Math.max(0.15, 0.5 * Math.pow(10, -decimals(num))))) flag(m);
      return ' ';
    });
    rest = rest.replace(N_EQUALS_RE, (m, num) => { if (!counts.has(Number(num.replace(/,/g, '')))) flag(m); return ' '; });
    rest = rest.replace(COUNT_RE, (m, num) => {
      const n = Number(num.replace(/,/g, ''));
      if (n >= 2 && !counts.has(n)) flag(m);
      return ' ';
    });
    rest.replace(DECIMAL_RE, (m, num) => {
      const x = Number(num);
      const tol = Math.max(0.006, 0.5 * Math.pow(10, -decimals(num)));
      // A decimal may also be a percentage written without the sign ("81.4 on held-out records").
      if (!decimalOk(x, tol) && !(Math.abs(x) > 1 && percentOk(x, Math.max(0.15, tol)))) flag(m);
      return m;
    });
  }
  return bad;
}

/**
 * The numbers of a run's metrics in a compact form for prompts and summaries
 * (no confusion matrices, values rounded to 4 decimals).
 * @param {ExecutionMetrics | null | undefined} metrics
 */
function summariseMetrics(metrics) {
  if (!metrics) return null;
  /** @param {number | null} v */
  const r = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
  /** @param {ReferenceScores | null} s */
  const ref = s => {
    if (!s) return null;
    /** @type {Record<string, { precision: number | null, recall: number | null, f1: number | null, support: number }>} */
    const perCode = {};
    for (const [c, x] of Object.entries(s.perCode)) perCode[c] = { precision: r(x.precision), recall: r(x.recall), f1: r(x.f1), support: x.support };
    return { n: s.n, accuracy: r(s.accuracy), macroF1: r(s.macroF1), kappa: r(s.kappa), perCode };
  };
  return {
    records: metrics.records, processed: metrics.processed, errors: metrics.errors,
    errorRate: r(metrics.errorRate), coverage: r(metrics.coverage), distribution: metrics.distribution,
    reference: metrics.reference ? { test: ref(metrics.reference.test), dev: ref(metrics.reference.dev), all: ref(metrics.reference.all) } : null,
    baseline: metrics.baseline ? { n: metrics.baseline.n, agreement: r(metrics.baseline.agreement), kappa: r(metrics.baseline.kappa), changed: metrics.baseline.changed } : null,
    consistency: { groups: metrics.consistency.groups, inconsistent: metrics.consistency.inconsistent, score: r(metrics.consistency.score) },
    runtime: { durationMs: metrics.runtime.durationMs, perRecordMeanMs: r(metrics.runtime.perRecordMeanMs) }
  };
}

module.exports = {
  computeMetrics, scoreRun, compareRuns, verifyNumbers, summariseMetrics, baselineResults, cleanCriteria, metricValue, normaliseText,
  metricDefinitions, DEFAULT_CRITERIA, NONE
};
