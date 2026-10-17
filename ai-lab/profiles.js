// @ts-check
// ── Coding profiles ───────────────────────────────────────────────────────────
// How a coding assistant should work, as structured fields rather than one
// long prompt. Every change makes a new, immutable version, so a conversation
// or an evaluation run can always say which instructions it used.
//
// A profile changes the *instructions* sent to a model. It never changes the
// model itself (that is fine-tuning, see finetune.js).

const { LabError, invalid } = require('./errors');

/** @typedef {import('../types/ai-lab').ProfileFields} ProfileFields */
/** @typedef {import('../types/ai-lab').ProfileVersion} ProfileVersion */
/** @typedef {import('../types/ai-lab').CodingProfile} CodingProfile */

/** Text fields, their labels, and the longest text each may hold. */
const TEXT_FIELDS = /** @type {const} */ ([
  ['description', 'Description', 2000],
  ['language', 'Preferred language', 80],
  ['conventions', 'Coding conventions', 6000],
  ['architecture', 'Architecture preferences', 6000],
  ['naming', 'Naming conventions', 3000],
  ['errorHandling', 'Error handling', 3000],
  ['testing', 'Testing requirements', 4000],
  ['documentation', 'Documentation standards', 3000],
  ['security', 'Security requirements', 4000],
  ['dependencies', 'Dependency policy', 3000],
  ['performance', 'Performance expectations', 3000],
  ['formatting', 'Formatting preferences', 3000],
  ['restrictions', 'Project-specific restrictions', 4000],
  ['extraInstructions', 'Other instructions', 8000]
]);
const LIST_FIELDS = /** @type {const} */ ([['frameworks', 'Frameworks', 30, 80], ['reviewSteps', 'Required review steps', 30, 400]]);
const VERBOSITY = ['concise', 'balanced', 'detailed'];
const DEPTH = ['none', 'brief', 'thorough'];
/** @type {string[]} */
const FIELD_NAMES = [];
TEXT_FIELDS.forEach(f => FIELD_NAMES.push(f[0]));
LIST_FIELDS.forEach(f => FIELD_NAMES.push(f[0]));
FIELD_NAMES.push('verbosity', 'explanationDepth', 'temperature', 'maxTokens');

/** @returns {ProfileFields} */
function emptyFields() {
  return {
    description: '', language: '', frameworks: [], conventions: '', architecture: '', naming: '', errorHandling: '',
    testing: '', documentation: '', security: '', dependencies: '', performance: '', verbosity: 'balanced',
    explanationDepth: 'brief', formatting: '', restrictions: '', reviewSteps: [], extraInstructions: '',
    temperature: null, maxTokens: null
  };
}

/** @param {unknown} v */
const text = v => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') : '');

/**
 * Validates and cleans the fields of a profile version (unknown fields are refused).
 * @param {unknown} input
 * @param {ProfileFields} [base]   fields not given keep these values
 * @returns {ProfileFields}
 */
function cleanFields(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('The profile\'s fields must be an object.');
  const src = /** @type {Record<string, unknown>} */ (input);
  const unknown = Object.keys(src).filter(k => !FIELD_NAMES.includes(k));
  if (unknown.length) throw invalid('Unknown profile field' + (unknown.length > 1 ? 's' : '') + ': ' + unknown.slice(0, 5).join(', ') + '.');
  const out = Object.assign(emptyFields(), base ? JSON.parse(JSON.stringify(base)) : {});
  const o = /** @type {Record<string, any>} */ (out);
  for (const [name, label, max] of TEXT_FIELDS) {
    if (src[name] === undefined) continue;
    if (typeof src[name] !== 'string') throw invalid(label + ' must be text.');
    const v = text(src[name]).trim();
    if (v.length > max) throw invalid(label + ' is too long (' + max + ' characters at most).');
    o[name] = v;
  }
  for (const [name, label, maxItems, maxLen] of LIST_FIELDS) {
    if (src[name] === undefined) continue;
    const arr = Array.isArray(src[name]) ? /** @type {unknown[]} */ (src[name]) : typeof src[name] === 'string' ? String(src[name]).split(/\n|,/) : null;
    if (!arr) throw invalid(label + ' must be a list.');
    const clean = arr.map(text).map(s => s.trim()).filter(Boolean);
    if (clean.length > maxItems) throw invalid(label + ': ' + maxItems + ' entries at most.');
    if (clean.some(s => s.length > maxLen)) throw invalid(label + ': each entry must be shorter than ' + maxLen + ' characters.');
    o[name] = Array.from(new Set(clean));
  }
  if (src.verbosity !== undefined) { if (!VERBOSITY.includes(String(src.verbosity))) throw invalid('Verbosity must be concise, balanced or detailed.'); o.verbosity = src.verbosity; }
  if (src.explanationDepth !== undefined) { if (!DEPTH.includes(String(src.explanationDepth))) throw invalid('Explanation depth must be none, brief or thorough.'); o.explanationDepth = src.explanationDepth; }
  if (src.temperature !== undefined) {
    if (src.temperature === null || src.temperature === '') o.temperature = null;
    else { const t = Number(src.temperature); if (!Number.isFinite(t) || t < 0 || t > 2) throw invalid('Temperature must be between 0 and 2.'); o.temperature = Math.round(t * 100) / 100; }
  }
  if (src.maxTokens !== undefined) {
    if (src.maxTokens === null || src.maxTokens === '') o.maxTokens = null;
    else { const n = Number(src.maxTokens); if (!Number.isInteger(n) || n < 64 || n > 64000) throw invalid('Maximum answer length must be a whole number of tokens from 64 to 64000.'); o.maxTokens = n; }
  }
  return out;
}

/** @param {unknown} name */
function cleanName(name) {
  const n = text(name).trim().replace(/\s+/g, ' ');
  if (!n) throw invalid('Give the profile a name.');
  if (n.length > 120) throw invalid('The name is too long (120 characters at most).');
  return n;
}

/**
 * The instructions a version stands for, as sent to a model (system message).
 * @param {ProfileFields} f
 */
function render(f) {
  /** @type {string[]} */
  const parts = [];
  const add = /** @param {string} title @param {string | string[]} v */ (title, v) => {
    const s = Array.isArray(v) ? v.map(x => '- ' + x).join('\n') : v;
    if (s && s.trim()) parts.push('## ' + title + '\n' + s.trim());
  };
  if (f.description) parts.push(f.description.trim());
  if (f.language || (f.frameworks && f.frameworks.length)) add('Stack', [f.language ? 'Language: ' + f.language : '', f.frameworks.length ? 'Frameworks: ' + f.frameworks.join(', ') : ''].filter(Boolean));
  add('Coding conventions', f.conventions);
  add('Architecture', f.architecture);
  add('Naming', f.naming);
  add('Error handling', f.errorHandling);
  add('Testing', f.testing);
  add('Documentation', f.documentation);
  add('Security', f.security);
  add('Dependencies', f.dependencies);
  add('Performance', f.performance);
  add('Formatting', f.formatting);
  add('Restrictions', f.restrictions);
  add('Before answering, check', f.reviewSteps);
  const verbosity = { concise: 'Keep answers short: code first, minimal prose.', balanced: 'Balance code and explanation.', detailed: 'Explain thoroughly, with reasoning and alternatives where useful.' }[f.verbosity];
  const depth = { none: 'Don\'t explain the code unless asked.', brief: 'Explain briefly what the code does and why.', thorough: 'Explain the code step by step.' }[f.explanationDepth];
  add('Response style', [verbosity, depth].filter(Boolean).join(' '));
  add('Other instructions', f.extraInstructions);
  return parts.join('\n\n');
}

/**
 * Field-by-field differences between two versions.
 * @param {ProfileFields} a
 * @param {ProfileFields} b
 */
function diff(a, b) {
  return FIELD_NAMES.filter(k => JSON.stringify(/** @type {any} */ (a)[k]) !== JSON.stringify(/** @type {any} */ (b)[k]))
    .map(k => ({ field: k, from: /** @type {any} */ (a)[k], to: /** @type {any} */ (b)[k] }));
}

/** @param {CodingProfile} p @param {number} n */
function versionOf(p, n) {
  const v = p.versions.find(x => x.version === n);
  if (!v) throw new LabError('not_found', 'Version ' + n + ' of this profile doesn\'t exist.', { status: 404 });
  return v;
}

/** @param {CodingProfile} p */
const current = p => versionOf(p, p.currentVersion);

/**
 * Adds a version. → the new version (or null when nothing changed and `force` isn't set).
 * @param {CodingProfile} p
 * @param {ProfileFields} fields
 * @param {{ note?: string, source: ProfileVersion['source'], status?: ProfileVersion['status'], parent?: number | null, rationale?: ProfileVersion['rationale'], force?: boolean }} o
 */
function addVersion(p, fields, o) {
  const cur = p.versions.length ? current(p) : null;
  if (cur && !o.force && JSON.stringify(cur.fields) === JSON.stringify(fields)) return null;
  if (p.versions.length >= 500) throw invalid('This profile has 500 versions, the most it can keep. Duplicate it to continue.');
  const n = p.versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
  /** @type {ProfileVersion} */
  const v = {
    version: n, createdAt: new Date().toISOString(), note: text(o.note || '').slice(0, 500), source: o.source,
    status: o.status || 'active', parentVersion: o.parent !== undefined ? o.parent : (cur ? cur.version : null), fields, rationale: o.rationale || null
  };
  p.versions.push(v);
  if (v.status === 'active') {
    if (cur && cur.status === 'active') cur.status = 'superseded';
    p.currentVersion = n;
  }
  p.updatedAt = v.createdAt;
  return v;
}

/** @param {CodingProfile} p @param {boolean} [withVersions] */
function summaryOf(p, withVersions) {
  const cur = current(p);
  /** @type {Record<string, unknown>} */
  const out = { id: p.id, name: p.name, projectId: p.projectId, archived: p.archived, currentVersion: p.currentVersion, versionCount: p.versions.length,
    candidates: p.versions.filter(v => v.status === 'candidate').map(v => v.version), fields: cur.fields, createdAt: p.createdAt, updatedAt: p.updatedAt };
  if (withVersions) out.versions = p.versions.map(v => ({ version: v.version, createdAt: v.createdAt, note: v.note, source: v.source, status: v.status, parentVersion: v.parentVersion, rationale: v.rationale || null }));
  return out;
}

/** A portable copy of a profile (current version). @param {CodingProfile} p */
function exportProfile(p) {
  return { format: 'metacode-coding-profile', formatVersion: 1, name: p.name, version: p.currentVersion, exportedAt: new Date().toISOString(), fields: current(p).fields };
}

/**
 * The fields of an exported profile (validated like any edit).
 * @param {unknown} data
 */
function importFields(data) {
  const d = /** @type {any} */ (data);
  if (!d || typeof d !== 'object' || d.format !== 'metacode-coding-profile' || d.formatVersion !== 1) throw invalid('That isn\'t a MetaCode coding profile export (format metacode-coding-profile, version 1).');
  return { name: cleanName(d.name), fields: cleanFields(d.fields) };
}

/** Instructions to reuse elsewhere, as Markdown. @param {CodingProfile} p */
function exportMarkdown(p) {
  const v = current(p);
  return '# ' + p.name + ' — coding assistant instructions (version ' + v.version + ')\n\n' + render(v.fields) + '\n';
}

module.exports = { emptyFields, cleanFields, cleanName, render, diff, versionOf, current, addVersion, summaryOf, exportProfile, importFields, exportMarkdown, FIELD_NAMES, TEXT_FIELDS };
