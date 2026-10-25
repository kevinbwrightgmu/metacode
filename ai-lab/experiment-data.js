// @ts-check
// ── Sandbox data for code experiments ─────────────────────────────────────────
// A sandbox is a read-only, versioned snapshot of records for one variable (a
// Codebook dimension): the text the coding rule sees, plus the labels it must
// never see — the reference label (from human coding or a dataset) and the
// baseline label (MetaCode's current AI coding). Every version is immutable
// and hashed; the hash is checked again before every run.
//
// Records are split deterministically into 'dev' (may be shown to the AI as
// examples) and 'test' (held out: never shown to the AI, used to measure).
// The split depends only on the sandbox id and the record id, so a record
// keeps its split in every version of the same sandbox.
//
// Nothing here touches the store: callers persist what these functions build.

const crypto = require('crypto');
const { invalid } = require('./errors');

/** @typedef {import('../types/lab-experiments').SandboxVariable} SandboxVariable */
/** @typedef {import('../types/lab-experiments').VariableCode} VariableCode */
/** @typedef {import('../types/lab-experiments').SandboxRecord} SandboxRecord */
/** @typedef {import('../types/lab-experiments').SandboxInputRecord} SandboxInputRecord */
/** @typedef {import('../types/lab-experiments').SandboxVersionInfo} SandboxVersionInfo */
/** @typedef {import('../types/lab-experiments').SandboxVersionFile} SandboxVersionFile */
/** @typedef {import('../types/ai-lab').DatasetExample} DatasetExample */
/** @typedef {{ accepted: number, rejected: number, truncated: number, problems: { id: string | null, problem: string }[] }} ImportReport */

const RECORD_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const CODE_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const META_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const DATA_LIMITS = Object.freeze({
  records: 5000, text: 20000, author: 200, timestamp: 40, metaKeys: 12, metaValue: 200,
  variableName: 120, variableDescription: 2000, codes: 50, codeLabel: 120, codeDescription: 1000,
  problemsKept: 50, note: 500
});
/** Share of records in the dev split (shown to the AI); the rest is held out. */
const DEV_SHARE = 0.3;
const REFERENCE_SOURCES = ['adjudicated', 'agreed', 'coder1', 'coder2', 'dataset'];

/** Text: control characters removed (tabs and newlines kept), cut to `max`. @param {unknown} v @param {number} max */
const text = (v, max) => {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
};
/** Whether `text` had to cut the value. @param {unknown} v @param {number} max */
const tooLong = (v, max) => typeof v === 'string' && v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').length > max;

/**
 * Validates a variable (a Codebook dimension and its codes). Throws a 400 LabError.
 * @param {unknown} v
 * @returns {SandboxVariable}
 */
function validateVariable(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('The variable must be an object with an id, a name and its codes.');
  const o = /** @type {Record<string, unknown>} */ (v);
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!CODE_ID_RE.test(id)) throw invalid('The variable id must be 1–64 letters, digits, _ or - (got ' + JSON.stringify(String(o.id === undefined ? '' : o.id).slice(0, 70)) + ').');
  const name = text(o.name, DATA_LIMITS.variableName).trim() || id;
  const description = text(o.description, DATA_LIMITS.variableDescription).trim();
  if (!Array.isArray(o.codes) || !o.codes.length) throw invalid('The variable “' + name + '” has no codes: add at least one code in the Codebook.');
  if (o.codes.length > DATA_LIMITS.codes) throw invalid('The variable “' + name + '” has ' + o.codes.length + ' codes; at most ' + DATA_LIMITS.codes + ' are supported.');
  /** @type {VariableCode[]} */
  const codes = [];
  const ids = new Set();
  for (const c of o.codes) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw invalid('Every code of “' + name + '” must be an object with an id and a label.');
    const cc = /** @type {Record<string, unknown>} */ (c);
    const cid = typeof cc.id === 'string' ? cc.id.trim() : '';
    if (!CODE_ID_RE.test(cid)) throw invalid('Code id ' + JSON.stringify(String(cc.id === undefined ? '' : cc.id).slice(0, 70)) + ' of “' + name + '” must be 1–64 letters, digits, _ or -. Rename it in the Codebook.');
    if (ids.has(cid)) throw invalid('The code id “' + cid + '” appears twice in “' + name + '”. Code ids must be unique.');
    ids.add(cid);
    codes.push({ id: cid, label: text(cc.label, DATA_LIMITS.codeLabel).trim() || cid, description: text(cc.description, DATA_LIMITS.codeDescription).trim() });
  }
  return { id, name, description, codes };
}

/**
 * The deterministic split of a record: the first 8 hex digits of
 * sha256(sandboxId + ':' + recordId), as a fraction of 2^32, below 0.3 → 'dev'.
 * @param {string} sandboxId
 * @param {string} recordId
 * @returns {'dev' | 'test'}
 */
function assignSplit(sandboxId, recordId) {
  const h = crypto.createHash('sha256').update(sandboxId + ':' + recordId, 'utf8').digest('hex');
  return parseInt(h.slice(0, 8), 16) / 4294967296 < DEV_SHARE ? 'dev' : 'test';
}

/**
 * A label must be one of the variable's code ids, or null.
 * @param {unknown} v
 * @param {Set<string>} codes
 * @returns {{ label: string | null, ignored: boolean }}
 */
function labelOf(v, codes) {
  if (v === undefined || v === null || v === '') return { label: null, ignored: false };
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : null;
  if (s !== null && codes.has(s)) return { label: s, ignored: false };
  return { label: null, ignored: true };
}

/**
 * Validates and normalises records for a sandbox version. Bad records are
 * rejected and reported (not fatal); text over the limits is cut and counted.
 * Labels that aren't code ids of the variable become null (reported).
 * Throws a 400 LabError when nothing usable is left.
 * @param {unknown} records
 * @param {SandboxVariable} variable   a validated variable
 * @param {string} [sandboxId]        assigns each record's split; without it every record is 'test' (never shown to the AI)
 * @returns {{ records: SandboxRecord[], report: ImportReport }}
 */
function normaliseRecords(records, variable, sandboxId) {
  if (!Array.isArray(records)) throw invalid('records must be a list.');
  const codes = new Set(variable.codes.map(c => c.id));
  /** @type {ImportReport} */
  const report = { accepted: 0, rejected: 0, truncated: 0, problems: [] };
  /** @param {string | null} id @param {string} problem */
  const problem = (id, problem) => { if (report.problems.length < DATA_LIMITS.problemsKept) report.problems.push({ id, problem }); };
  /** @type {SandboxRecord[]} */
  const out = [];
  const seen = new Set();
  let overflow = 0;
  records.forEach((raw, i) => {
    if (out.length >= DATA_LIMITS.records) { overflow++; return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { report.rejected++; problem(null, 'Record ' + (i + 1) + ' isn\'t an object.'); return; }
    const r = /** @type {Record<string, unknown>} */ (raw);
    const id = typeof r.id === 'number' && Number.isFinite(r.id) ? String(r.id) : typeof r.id === 'string' ? r.id.trim() : '';
    if (!RECORD_ID_RE.test(id)) {
      report.rejected++;
      problem(typeof r.id === 'string' ? r.id.slice(0, 120) : null, 'Record ' + (i + 1) + ': the id must be 1–120 letters, digits, _ . : or -.');
      return;
    }
    if (seen.has(id)) { report.rejected++; problem(id, 'Duplicate id: only the first record with this id was kept.'); return; }
    seen.add(id);
    let cut = tooLong(r.text, DATA_LIMITS.text) || tooLong(r.author, DATA_LIMITS.author) || tooLong(r.timestamp, DATA_LIMITS.timestamp);
    /** @type {Record<string, string | number | boolean | null>} */
    const meta = {};
    if (r.meta !== undefined && r.meta !== null) {
      if (typeof r.meta !== 'object' || Array.isArray(r.meta)) problem(id, 'meta must be an object of simple values; it was left out.');
      else {
        let n = 0;
        for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (r.meta))) {
          if (!META_KEY_RE.test(k)) { problem(id, 'meta key ' + JSON.stringify(k.slice(0, 40)) + ' isn\'t a simple name; it was left out.'); continue; }
          if (n >= DATA_LIMITS.metaKeys) { problem(id, 'meta can have at most ' + DATA_LIMITS.metaKeys + ' keys; the rest were left out.'); break; }
          if (v === null || typeof v === 'boolean') meta[k] = v;
          else if (typeof v === 'number') meta[k] = Number.isFinite(v) ? v : null;
          else if (typeof v === 'string') { if (tooLong(v, DATA_LIMITS.metaValue)) cut = true; meta[k] = text(v, DATA_LIMITS.metaValue); }
          else { problem(id, 'meta.' + k + ' isn\'t text, a number, true/false or null; it was left out.'); continue; }
          n++;
        }
      }
    }
    const ref = labelOf(r.reference, codes);
    if (ref.ignored) problem(id, 'The reference label ' + JSON.stringify(String(r.reference).slice(0, 64)) + ' isn\'t a code of “' + variable.name + '”; it was ignored.');
    const base = labelOf(r.baseline, codes);
    if (base.ignored) problem(id, 'The AI label ' + JSON.stringify(String(r.baseline).slice(0, 64)) + ' isn\'t a code of “' + variable.name + '”; it was ignored.');
    const source = ref.label !== null && typeof r.referenceSource === 'string' && REFERENCE_SOURCES.includes(r.referenceSource)
      ? /** @type {SandboxRecord['referenceSource']} */ (r.referenceSource) : null;
    if (cut) report.truncated++;
    out.push({
      id,
      text: text(r.text, DATA_LIMITS.text),
      author: text(r.author, DATA_LIMITS.author),
      timestamp: text(r.timestamp, DATA_LIMITS.timestamp),
      meta,
      reference: ref.label,
      referenceSource: source,
      baseline: base.label,
      split: sandboxId ? assignSplit(sandboxId, id) : 'test'
    });
  });
  if (overflow) {
    report.rejected += overflow;
    report.problems.unshift({ id: null, problem: 'A sandbox version holds at most 5,000 records: the last ' + overflow + ' were left out.' });
    report.problems.length = Math.min(report.problems.length, DATA_LIMITS.problemsKept);
  }
  report.accepted = out.length;
  if (!out.length) throw invalid('No usable records: every record was rejected' + (report.problems.length ? ' (' + report.problems[0].problem + ')' : '') + '.');
  return { records: out, report };
}

/** The variable with its keys in a fixed order. @param {SandboxVariable} v */
const canonicalVariable = v => ({
  id: v.id, name: v.name, description: v.description,
  codes: v.codes.map(c => ({ id: c.id, label: c.label, description: c.description }))
});

/** A record with its keys (and its meta's keys) in a fixed order. @param {SandboxRecord} r */
const canonicalRecord = r => {
  /** @type {Record<string, string | number | boolean | null>} */
  const meta = {};
  Object.keys(r.meta || {}).sort().forEach(k => { meta[k] = r.meta[k]; });
  return { id: r.id, text: r.text, author: r.author, timestamp: r.timestamp, meta, reference: r.reference, referenceSource: r.referenceSource, baseline: r.baseline, split: r.split };
};

/** Code-unit order (the same on every machine, unlike localeCompare). @param {string} a @param {string} b */
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * sha256 (hex) of JSON.stringify({variable, records}) with the records sorted
 * by id and every object's keys in a fixed order. The order records arrive in
 * doesn't change the hash; any change to a field does.
 * @param {SandboxVariable} variable
 * @param {SandboxRecord[]} records
 */
function versionHash(variable, records) {
  const sorted = records.slice().sort((a, b) => byId(a.id, b.id)).map(canonicalRecord);
  return crypto.createHash('sha256').update(JSON.stringify({ variable: canonicalVariable(variable), records: sorted }), 'utf8').digest('hex');
}

/**
 * Whether a stored version file still matches its recorded hash (checked before every run).
 * @param {SandboxVersionFile | null | undefined} file
 * @param {string} sha256
 */
function verifyVersion(file, sha256) {
  if (!file || !file.variable || !Array.isArray(file.records)) return false;
  try { return versionHash(file.variable, file.records) === sha256; } catch (e) { return false; }
}

/**
 * Records from a frozen Training Studio dataset version, for normaliseRecords:
 * the text is the example's input (or its task), the reference its expected
 * value when that is exactly one of the variable's code ids.
 * @param {DatasetExample[]} examples
 * @param {SandboxVariable} variable
 * @returns {{ id: string, text: string, author: string, timestamp: string, meta: Record<string, never>, reference: string | null, referenceSource: 'dataset' | null, baseline: null }[]}
 */
function recordsFromDataset(examples, variable) {
  const codes = new Set(variable.codes.map(c => c.id));
  return (Array.isArray(examples) ? examples : []).map(e => {
    const expected = typeof e.expected === 'string' ? e.expected.trim() : '';
    const reference = codes.has(expected) ? expected : null;
    return {
      id: e.id, text: (typeof e.input === 'string' && e.input) || (typeof e.task === 'string' ? e.task : ''),
      author: '', timestamp: '', meta: {},
      reference, referenceSource: reference !== null ? /** @type {'dataset'} */ ('dataset') : null, baseline: null
    };
  });
}

/**
 * What the code under test receives: no labels, no split (fresh copies).
 * @param {SandboxRecord[]} records
 * @returns {SandboxInputRecord[]}
 */
function sandboxInput(records) {
  return records.map(r => ({ id: r.id, text: r.text, author: r.author, timestamp: r.timestamp, meta: Object.assign({}, r.meta) }));
}

/**
 * The records a run uses.
 * @param {SandboxRecord[]} records
 * @param {'all' | 'test' | 'dev'} split
 */
function selectRecords(records, split) {
  return split === 'all' ? records.slice() : records.filter(r => r.split === split);
}

/**
 * sha256 (hex) of the sorted record ids: two runs with the same value ran on the same records.
 * @param {{ id: string }[]} records
 */
function recordIdsHash(records) {
  return crypto.createHash('sha256').update(records.map(r => r.id).sort(byId).join('\n'), 'utf8').digest('hex');
}

/**
 * Builds one sandbox version from a variable and raw records: validated,
 * normalised, split and hashed. Doesn't store anything.
 * @param {{ sandboxId: string, version: number, variable: unknown, records: unknown, note?: string, now?: string }} o
 * @returns {{ info: SandboxVersionInfo, file: SandboxVersionFile, report: ImportReport }}
 */
function createSandboxVersion(o) {
  if (!o || typeof o.sandboxId !== 'string' || !o.sandboxId) throw invalid('A sandbox id is needed.');
  if (!Number.isInteger(o.version) || o.version < 1) throw invalid('The sandbox version must be a whole number from 1.');
  const variable = validateVariable(o.variable);
  const { records, report } = normaliseRecords(o.records, variable, o.sandboxId);
  const devCount = records.filter(r => r.split === 'dev').length;
  /** @type {SandboxVersionInfo} */
  const info = {
    version: o.version,
    createdAt: o.now || new Date().toISOString(),
    sha256: versionHash(variable, records),
    count: records.length,
    referenceCount: records.filter(r => r.reference !== null).length,
    baselineCount: records.filter(r => r.baseline !== null).length,
    devCount,
    testCount: records.length - devCount,
    note: text(o.note, DATA_LIMITS.note).trim()
  };
  return { info, file: { version: o.version, variable, records }, report };
}

module.exports = {
  validateVariable, normaliseRecords, assignSplit, versionHash, verifyVersion, recordsFromDataset, sandboxInput,
  selectRecords, recordIdsHash, createSandboxVersion, RECORD_ID_RE, CODE_ID_RE, DATA_LIMITS, DEV_SHARE
};
