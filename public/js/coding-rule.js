/* ══════════════════════════════════════════════
   coding-rule.js — a Codebook dimension's coding rule (from the AI Coding Lab)

   Pure functions (no DOM), used by the Codebook (codebook.js), the "Send to
   Codebook" handoff (lab-handoff.js) and tested in test/coding-rule.test.js.

   A coding rule is a CodingRule (types/lab-experiments.d.ts, schema
   'metacode.coding-rule/1'): a function classify(record, variable) written
   in the AI Coding Lab, with the measured results of its sandbox run. The
   app only STORES it on the dimension, for reference:

     dim.codingRule        = the rule (a cleaned copy of the payload + appliedAt)
     dim.codingRuleHistory = earlier rules, newest first, ≤ 20 entries; only the
                             5 newest keep their code (and prompts/contract),
                             each with replacedAt

   MetaCode never runs the code and AI Coding doesn't use it. Everything in
   a stored rule may come from another browser (shared projects, backups),
   so the display helpers below accept anything and never throw.
   ══════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodingRule = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 'metacode.coding-rule/1';
  /** A Codebook dimension (variable) or code id the Lab can work with. */
  const ID_RE = /^[a-z0-9_-]{1,64}$/i;
  /** Ids written into the Codebook's inline handlers (any length, same characters). */
  const SAFE_ID_RE = /^[a-z0-9_-]+$/i;
  const SUBMISSION_ID_RE = /^cbs_[A-Za-z0-9_-]{16}$/;
  /** AI Coding Lab object ids (experiments exp_…, runs xrn_…, sandboxes sbx_…). */
  const LAB_ID_RE = /^[a-z]{3}_[A-Za-z0-9_-]{16}$/;
  /** Code and sandbox hashes (hex sha256, possibly prefixed like "sha256:"). */
  const HASH_RE = /^[A-Za-z0-9:_-]{8,128}$/;
  const MAX_CODE_BYTES = 64 * 1024;
  const MAX_CONTRACT_BYTES = 16 * 1024;
  const HISTORY_MAX = 20;
  const HISTORY_CODE_KEEP = 5;
  const LANGUAGES = ['javascript', 'typescript', 'python'];
  const LANGUAGE_LABELS = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python' };
  const SPLITS = ['all', 'test', 'dev'];
  const REVIEWS = ['approved', 'needs_review', 'unavailable'];   // 'rejected' never reaches the Codebook
  const RECOMMENDATIONS = ['retain', 'revise', 'reject'];
  // Free text is capped (cut, never refused): the whole codebook is one shared-project part
  const CAPS = { name: 200, prompt: 4000, rationale: 4000, date: 40, historyRationale: 1000 };

  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const str = v => (typeof v === 'string' ? v : '');
  const cap = (s, n) => { s = str(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const posInt = v => Number.isInteger(v) && v >= 1 && v <= 1e6;
  const count = v => Number.isInteger(v) && v >= 0 && v <= 1e9;
  const isDate = v => typeof v === 'string' && v.length <= CAPS.date && !Number.isNaN(Date.parse(v));

  function utf8Bytes(s) {
    s = str(s);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
    let n = 0;
    for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
  }
  function toIso(now) {
    const d = now instanceof Date ? now : new Date(now === undefined || now === null ? Date.now() : now);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  function jsonCopy(v) {
    try { const t = JSON.stringify(v); return t === undefined ? null : { value: JSON.parse(t), bytes: utf8Bytes(t) }; } catch (e) { return null; }
  }

  /* ── Validation ─────────────────────────────── */

  /**
   * Checks a CodingRule payload sent by the AI Coding Lab against the open
   * project's codebook.
   * @returns {{ ok: boolean, problems: string[], dimension: object|null, rule: object|null, missingDimension: boolean }}
   *   rule: a cleaned copy holding only the known fields (free text capped), when ok.
   *   missingDimension: the payload is otherwise fine but the codebook has no dimension with its dimensionId.
   */
  function validateCodingRule(payload, codebook) {
    const problems = [];
    const bad = msg => { problems.push(msg); };
    if (!isObj(payload)) return { ok: false, problems: ['The coding rule is missing or isn\'t an object.'], dimension: null, rule: null, missingDimension: false };
    const p = payload;

    if (p.schema !== SCHEMA) bad('Unknown format "' + cap(String(p.schema), 60) + '" (expected ' + SCHEMA + ').');
    if (typeof p.submissionId !== 'string' || !SUBMISSION_ID_RE.test(p.submissionId)) bad('The submission id isn\'t valid.');
    if (p.status !== 'experimental') bad('The status must be "experimental".');
    if (typeof p.dimensionId !== 'string' || !ID_RE.test(p.dimensionId)) bad('The variable id isn\'t valid (letters, digits, _ and -, at most 64).');

    const exp = isObj(p.experiment) ? p.experiment : null;
    if (!exp) bad('The experiment is missing.');
    else {
      if (typeof exp.id !== 'string' || !LAB_ID_RE.test(exp.id)) bad('The experiment id isn\'t valid.');
      if (typeof exp.name !== 'string') bad('The experiment name must be text.');
    }
    if (!posInt(p.version)) bad('The version must be a whole number from 1.');
    if (typeof p.codeHash !== 'string' || !HASH_RE.test(p.codeHash)) bad('The code hash isn\'t valid.');
    if (!LANGUAGES.includes(p.language)) bad('The language must be JavaScript, TypeScript or Python.');
    if (typeof p.code !== 'string' || !p.code.trim()) bad('The code is missing.');
    else if (utf8Bytes(p.code) > MAX_CODE_BYTES) bad('The code is too large (' + Math.ceil(utf8Bytes(p.code) / 1024) + ' KB; the Codebook keeps at most 64 KB).');

    const contract = isObj(p.contract) ? p.contract : null;
    let input = null, output = null;
    if (!contract) bad('The contract is missing.');
    else {
      if (contract.name !== 'classify/1') bad('The contract must be classify/1.');
      for (const k of ['input', 'output']) {
        const v = contract[k] === undefined ? {} : contract[k];
        const c = isObj(v) ? jsonCopy(v) : null;
        if (!c) bad('The contract\'s ' + k + ' must be an object.');
        else if (c.bytes > MAX_CONTRACT_BYTES) bad('The contract\'s ' + k + ' is too large.');
        else if (k === 'input') input = c.value; else output = c.value;
      }
      // Code ids the contract lists must be plain ids too (they end up in the Codebook's pages)
      if (output && Array.isArray(output.codes)) {
        const wrong = output.codes.map(c => (isObj(c) ? c.id : c)).filter(id => typeof id !== 'string' || !ID_RE.test(id));
        if (wrong.length) bad('The contract lists code ids that aren\'t valid (letters, digits, _ and -, at most 64).');
      }
    }

    const prompts = p.prompts === undefined ? {} : p.prompts;
    if (!isObj(prompts) || (prompts.original !== undefined && typeof prompts.original !== 'string') || (prompts.final !== undefined && typeof prompts.final !== 'string')) bad('The prompts must be text.');
    if (p.rationale !== undefined && typeof p.rationale !== 'string') bad('The rationale must be text.');

    const ev = isObj(p.evaluation) ? p.evaluation : null;
    if (!ev) bad('The measured results are missing.');
    else {
      if (typeof ev.runId !== 'string' || !LAB_ID_RE.test(ev.runId)) bad('The run id isn\'t valid.');
      if (ev.finishedAt !== null && ev.finishedAt !== undefined && !isDate(ev.finishedAt)) bad('The run\'s finish time isn\'t a date.');
      if (!SPLITS.includes(ev.split)) bad('The split must be all, test or dev.');
      if (ev.referenceSplit !== undefined && !SPLITS.includes(ev.referenceSplit)) bad('The split of the reference scores must be all, test or dev.');
      if (!count(ev.records)) bad('The record count must be a whole number.');
      if (!count(ev.referenceN)) bad('The number of records with reference labels must be a whole number.');
      for (const k of ['accuracy', 'macroF1', 'coverage', 'errorRate', 'baselineAgreement']) {
        const v = ev[k];
        if (v !== null && v !== undefined && !(finite(v) && v >= 0 && v <= 1)) bad('The measured ' + k + ' must be a number from 0 to 1, or null.');
      }
      if (ev.kappa !== null && ev.kappa !== undefined && !(finite(ev.kappa) && ev.kappa >= -1 && ev.kappa <= 1)) bad('The measured kappa must be a number from -1 to 1, or null.');
      if (ev.recommendation !== null && ev.recommendation !== undefined && !RECOMMENDATIONS.includes(ev.recommendation)) bad('The AI recommendation isn\'t one of retain, revise or reject.');
    }

    const sec = isObj(p.security) ? p.security : null;
    if (!sec) bad('The security results are missing.');
    else {
      if (sec.policy !== 'passed') bad('Only code that passed the policy checks can be saved.');
      if (sec.review === 'rejected') bad('The AI security review rejected this code.');
      else if (!REVIEWS.includes(sec.review)) bad('The AI security review result isn\'t valid.');
      if (sec.reviewedAt !== null && sec.reviewedAt !== undefined && !isDate(sec.reviewedAt)) bad('The review time isn\'t a date.');
    }

    const sb = isObj(p.sandbox) ? p.sandbox : null;
    if (!sb) bad('The sandbox is missing.');
    else {
      if (typeof sb.id !== 'string' || !LAB_ID_RE.test(sb.id)) bad('The sandbox id isn\'t valid.');
      if (typeof sb.name !== 'string') bad('The sandbox name must be text.');
      if (!posInt(sb.version)) bad('The sandbox version must be a whole number from 1.');
      if (typeof sb.sha256 !== 'string' || !HASH_RE.test(sb.sha256)) bad('The sandbox hash isn\'t valid.');
    }
    if (!isDate(p.selectedAt)) bad('The selection time isn\'t a date.');
    if (!isDate(p.sentAt)) bad('The time it was sent isn\'t a date.');

    // The variable must be in the open project's codebook
    let dimension = null, missingDimension = false;
    if (typeof p.dimensionId === 'string' && ID_RE.test(p.dimensionId)) {
      dimension = (Array.isArray(codebook) ? codebook : []).find(d => isObj(d) && d.id === p.dimensionId) || null;
      if (!dimension) { missingDimension = true; bad('The open project\'s codebook has no variable with the id "' + p.dimensionId + '".'); }
    }

    const ok = problems.length === 0;
    const rule = ok ? {
      schema: SCHEMA,
      submissionId: p.submissionId,
      status: 'experimental',
      dimensionId: p.dimensionId,
      experiment: { id: exp.id, name: cap(exp.name, CAPS.name) },
      version: p.version,
      codeHash: p.codeHash,
      language: p.language,
      code: p.code,
      contract: { name: 'classify/1', input, output },
      prompts: { original: cap(prompts.original, CAPS.prompt), final: cap(prompts.final, CAPS.prompt) },
      rationale: cap(p.rationale, CAPS.rationale),
      evaluation: {
        runId: ev.runId,
        finishedAt: ev.finishedAt || null,
        split: ev.split,
        referenceSplit: ev.referenceSplit === undefined ? ev.split : ev.referenceSplit,
        records: ev.records,
        accuracy: finite(ev.accuracy) ? ev.accuracy : null,
        macroF1: finite(ev.macroF1) ? ev.macroF1 : null,
        kappa: finite(ev.kappa) ? ev.kappa : null,
        referenceN: ev.referenceN,
        coverage: finite(ev.coverage) ? ev.coverage : null,
        errorRate: finite(ev.errorRate) ? ev.errorRate : null,
        baselineAgreement: finite(ev.baselineAgreement) ? ev.baselineAgreement : null,
        recommendation: ev.recommendation || null
      },
      security: { policy: 'passed', review: sec.review, reviewedAt: sec.reviewedAt || null },
      sandbox: { id: sb.id, name: cap(sb.name, CAPS.name), version: sb.version, sha256: sb.sha256 },
      selectedAt: p.selectedAt,
      sentAt: p.sentAt
    } : null;
    return { ok, problems, dimension, rule, missingDimension: missingDimension && problems.length === 1 };
  }

  /* ── Changes to the codebook (new arrays; the input is never modified) ── */

  // A history entry past the newest HISTORY_CODE_KEEP: no code, prompts or contract
  function slim(entry) {
    const out = Object.assign({}, entry, { code: null });
    delete out.prompts;
    delete out.contract;
    if (typeof out.rationale === 'string') out.rationale = cap(out.rationale, CAPS.historyRationale);
    return out;
  }

  /**
   * Puts a coding rule on its dimension (after the user confirmed).
   * The current rule (if any) moves to the front of the history.
   * Applying the submission that is already the dimension's rule changes nothing.
   * @returns {{ codebook: object[], changed: boolean, replaced: object|null }}
   * @throws Error (with .problems) when the payload isn't valid for this codebook
   */
  function applyCodingRule(codebook, payload, now) {
    const v = validateCodingRule(payload, codebook);
    if (!v.ok) {
      const err = new Error('This coding rule can\'t be saved: ' + v.problems.join(' '));
      err.problems = v.problems;
      err.missingDimension = v.missingDimension;
      throw err;
    }
    const idx = codebook.findIndex(d => isObj(d) && d.id === v.rule.dimensionId);
    const dim = codebook[idx];
    const current = isObj(dim.codingRule) ? dim.codingRule : null;
    if (current && current.submissionId === v.rule.submissionId) return { codebook, changed: false, replaced: null };

    const at = toIso(now);
    const earlier = Array.isArray(dim.codingRuleHistory) ? dim.codingRuleHistory.filter(isObj) : [];
    const seen = new Set([v.rule.submissionId]);
    const history = (current ? [Object.assign({}, current, { replacedAt: at })] : []).concat(earlier)
      .filter(h => {
        const k = typeof h.submissionId === 'string' ? h.submissionId : null;
        if (k === null) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, HISTORY_MAX)
      .map((h, i) => (i < HISTORY_CODE_KEEP ? h : slim(h)));

    const next = codebook.slice();
    next[idx] = Object.assign({}, dim, { codingRule: Object.assign({}, v.rule, { appliedAt: at }), codingRuleHistory: history });
    return { codebook: next, changed: true, replaced: current };
  }

  /**
   * Takes the coding rule (and its history) off a dimension.
   * @returns {{ codebook: object[], changed: boolean, removed: object|null }}
   */
  function removeCodingRule(codebook, dimensionId) {
    const list = Array.isArray(codebook) ? codebook : [];
    const idx = list.findIndex(d => isObj(d) && d.id === dimensionId);
    if (idx === -1) return { codebook: list, changed: false, removed: null };
    const dim = list[idx];
    if (!('codingRule' in dim) && !('codingRuleHistory' in dim)) return { codebook: list, changed: false, removed: null };
    const copy = Object.assign({}, dim);
    delete copy.codingRule;
    delete copy.codingRuleHistory;
    const next = list.slice();
    next[idx] = copy;
    return { codebook: next, changed: true, removed: isObj(dim.codingRule) ? dim.codingRule : null };
  }

  /* ── Display helpers (accept anything, return plain text) ── */

  const languageLabel = l => LANGUAGE_LABELS[l] || 'Unknown language';
  function formatPercent(v) {
    if (!finite(v)) return null;
    return (Math.round(v * 1000) / 10) + '%';
  }
  function formatDecimal(v) { return finite(v) ? v.toFixed(2) : null; }
  function formatDate(v) {
    if (typeof v !== 'string' || !v) return '';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function formatBytes(n) {
    if (!finite(n)) return '';
    return n < 1024 ? n + ' B' : (Math.round(n / 102.4) / 10) + ' KB';
  }
  const splitWord = s => (s === 'test' ? 'held-out' : s === 'dev' ? 'dev' : 'all');

  /**
   * The measured results of a rule, for display.
   * @returns {{ key: string, label: string, text: string, measured: boolean, n: number|null }[]}
   */
  function metricItems(rule) {
    const ev = isObj(rule) && isObj(rule.evaluation) ? rule.evaluation : {};
    const refN = count(ev.referenceN) ? ev.referenceN : null;
    const recN = count(ev.records) ? ev.records : null;
    // accuracy, F1 and κ are measured on the reference split (rules saved before it existed: the run's split)
    const refSplit = SPLITS.includes(ev.referenceSplit) ? ev.referenceSplit : ev.split;
    const held = refSplit === 'test';
    const scope = held ? '' : ' (' + splitWord(refSplit) + ' records)';
    const noRef = 'not measured — no reference labels';
    const item = (key, label, text, n, fallback) => ({ key, label, text: text === null ? (fallback || 'not measured') : text, measured: text !== null, n: text === null ? null : n });
    return [
      item('accuracy', (held ? 'Held-out accuracy' : 'Accuracy') + scope, formatPercent(ev.accuracy), refN, noRef),
      item('macroF1', (held ? 'Held-out macro-F1' : 'Macro-F1') + scope, formatDecimal(ev.macroF1), refN, noRef),
      item('kappa', 'Cohen\'s κ vs reference' + scope, formatDecimal(ev.kappa), refN, noRef),
      item('coverage', 'Coverage', formatPercent(ev.coverage), recN),
      item('baselineAgreement', 'Agreement with AI coding', formatPercent(ev.baselineAgreement), null, 'not measured — no AI coding labels'),
      item('errorRate', 'Error rate', formatPercent(ev.errorRate), recN)
    ];
  }

  /** "Coding rule · v3 · JavaScript · experimental — not used by AI Coding" */
  function headline(rule) {
    const v = isObj(rule) && posInt(rule.version) ? 'v' + rule.version : 'v?';
    return 'Coding rule · ' + v + ' · ' + languageLabel(isObj(rule) ? rule.language : null) + ' · experimental — not used by AI Coding';
  }

  /** Link to the rule's experiment in the Lab, or null when its id isn't a Lab id. */
  function experimentUrl(rule) {
    const id = isObj(rule) && isObj(rule.experiment) ? rule.experiment.id : null;
    return typeof id === 'string' && LAB_ID_RE.test(id) ? '/ultra/ai-lab#experiment/' + id : null;
  }
  /** "Improve in AI Coding Lab" for a dimension, or null when the Lab can't use its id. */
  function improveUrl(dimensionId) {
    return typeof dimensionId === 'string' && ID_RE.test(dimensionId) ? '/ultra/ai-lab#experiments/new/' + dimensionId : null;
  }

  /**
   * What saving `rule` on `dimension` changes.
   * @returns {{ kind: 'new'|'replace'|'same', previous: object|null, text: string }}
   */
  function changeSummary(dimension, rule) {
    const cur = isObj(dimension) && isObj(dimension.codingRule) ? dimension.codingRule : null;
    const name = isObj(dimension) ? str(dimension.name) || str(dimension.id) : '';
    if (!cur) return { kind: 'new', previous: null, text: 'New rule — “' + name + '” has no coding rule yet.' };
    if (isObj(rule) && cur.submissionId === rule.submissionId) return { kind: 'same', previous: cur, text: 'Already saved — this is the variable\'s current rule.' };
    const v = posInt(cur.version) ? 'v' + cur.version : 'the current rule';
    const sameExp = isObj(rule) && isObj(rule.experiment) && isObj(cur.experiment) && cur.experiment.id === rule.experiment.id;
    const from = sameExp ? '' : ' from “' + cap(isObj(cur.experiment) ? cur.experiment.name : '', 80) + '”';
    const sent = formatDate(cur.sentAt);
    return { kind: 'replace', previous: cur, text: 'Replaces ' + v + from + (sent ? ' (sent ' + sent + ')' : '') + ', which moves to the rule\'s history.' };
  }

  /** One line about a history entry. */
  function historyLine(entry) {
    if (!isObj(entry)) return '';
    const parts = [(posInt(entry.version) ? 'v' + entry.version : 'v?') + ' · ' + languageLabel(entry.language)];
    if (isObj(entry.experiment) && entry.experiment.name) parts.push('“' + cap(entry.experiment.name, 80) + '”');
    const acc = metricItems(entry)[0];
    if (acc.measured) parts.push(acc.label.toLowerCase() + ' ' + acc.text + (acc.n !== null ? ' (n = ' + acc.n + ')' : ''));
    const sent = formatDate(entry.sentAt);
    if (sent) parts.push('sent ' + sent);
    const replaced = formatDate(entry.replacedAt);
    if (replaced) parts.push('replaced ' + replaced);
    return parts.join(' · ');
  }

  return {
    SCHEMA, ID_RE, SAFE_ID_RE, SUBMISSION_ID_RE, LAB_ID_RE, MAX_CODE_BYTES, HISTORY_MAX, HISTORY_CODE_KEEP, LANGUAGES, LANGUAGE_LABELS,
    validateCodingRule, applyCodingRule, removeCodingRule,
    isSafeId: id => typeof id === 'string' && SAFE_ID_RE.test(id),
    isVariableId: id => typeof id === 'string' && ID_RE.test(id),
    isSubmissionId: id => typeof id === 'string' && SUBMISSION_ID_RE.test(id),
    languageLabel, formatPercent, formatDecimal, formatDate, formatBytes, utf8Bytes,
    metricItems, headline, experimentUrl, improveUrl, changeSummary, historyLine
  };
});
