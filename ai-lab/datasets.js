// @ts-check
// ── Datasets (Training Studio) ────────────────────────────────────────────────
// Collections of coding tasks: what to ask, the context, what a good answer
// does (expected output or acceptance criteria), and how to check it. A
// dataset has a working draft and committed versions; a version is frozen —
// evaluation runs name the version they used, so editing the draft never
// changes past results.
//
// Quality checks report problems (empty tasks, missing expectations,
// duplicates, train/test overlap, likely secrets or personal data, text that
// tries to instruct an AI). They are aids, not guarantees: passing them
// doesn't prove a dataset is free of sensitive data or licensed for use.

const crypto = require('crypto');
const { invalid } = require('./errors');
const { cleanCheck } = require('./checks');
const { newId } = require('./store');
const { SECRET_PATTERNS } = require('../lib/log');
const { INJECTION } = require('./knowledge');

/** @typedef {import('../types/ai-lab').DatasetExample} DatasetExample */
/** @typedef {import('../types/ai-lab').Dataset} Dataset */

const MAX_EXAMPLES = 5000;
const DIFFICULTY = ['easy', 'medium', 'hard', ''];
const QUALITY = ['unreviewed', 'approved', 'needs_work', 'rejected'];
const SPLITS = ['train', 'validation', 'test'];
const EXAMPLE_FIELDS = ['id', 'task', 'input', 'expected', 'reference', 'language', 'framework', 'category', 'difficulty', 'tags', 'source', 'quality', 'notes', 'split', 'weight', 'checks', 'createdAt', 'updatedAt'];

/** @param {unknown} v @param {number} max */
const text = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max));

/**
 * Validates one example (from the editor or an import). Unknown fields are reported, not kept.
 * @param {unknown} input
 * @param {{ keepId?: boolean, now?: string }} [o]
 * @returns {DatasetExample}
 */
function cleanExample(input, o) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('An example must be an object.');
  const e = /** @type {Record<string, any>} */ (input);
  const now = (o && o.now) || new Date().toISOString();
  const task = text(e.task, 20000).trim();
  if (!task) throw invalid('Every example needs a task.');
  const difficulty = text(e.difficulty, 10).toLowerCase();
  if (!DIFFICULTY.includes(difficulty)) throw invalid('Difficulty must be easy, medium or hard.');
  const quality = e.quality === undefined || e.quality === '' ? 'unreviewed' : text(e.quality, 20);
  if (!QUALITY.includes(quality)) throw invalid('Quality must be unreviewed, approved, needs_work or rejected.');
  const split = e.split === undefined || e.split === null || e.split === '' ? null : text(e.split, 20);
  if (split !== null && !SPLITS.includes(split)) throw invalid('Split must be train, validation or test.');
  const weight = e.weight === undefined || e.weight === '' ? 1 : Number(e.weight);
  if (!(weight > 0 && weight <= 100)) throw invalid('Weight must be a number from 0 (exclusive) to 100.');
  const tags = (Array.isArray(e.tags) ? e.tags : typeof e.tags === 'string' ? e.tags.split(/[,;]/) : []).map(t => text(t, 60).trim()).filter(Boolean).slice(0, 20);
  const checks = Array.isArray(e.checks) ? e.checks.slice(0, 20).map(cleanCheck) : [];
  const keep = o && o.keepId && typeof e.id === 'string' && /^exm_[A-Za-z0-9_-]{16}$/.test(e.id);
  return {
    id: keep ? e.id : newId('examples'),
    task, input: text(e.input, 100000), expected: text(e.expected, 100000), reference: text(e.reference, 100000),
    language: text(e.language, 40).trim(), framework: text(e.framework, 60).trim(), category: text(e.category, 60).trim(),
    difficulty: /** @type {DatasetExample['difficulty']} */ (difficulty), tags, source: text(e.source, 300).trim(),
    quality: /** @type {DatasetExample['quality']} */ (quality), notes: text(e.notes, 4000),
    split: /** @type {DatasetExample['split']} */ (split), weight, checks,
    createdAt: keep && typeof e.createdAt === 'string' ? e.createdAt.slice(0, 40) : now, updatedAt: now
  };
}

/** The content that makes two examples duplicates. @param {DatasetExample} e */
const contentHash = e => crypto.createHash('sha256').update(e.task.replace(/\s+/g, ' ').trim().toLowerCase() + '\u0000' + e.input.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 24);

const PII = [
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, what: 'an email address' },
  { re: /(?<![\d.])\+?\d{1,3}[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?![\d.])/, what: 'a phone number' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/, what: 'a US social security number' },
  { re: /\b(?:\d[ -]?){13,16}\b/, what: 'a card-like number' }
];

/**
 * Quality report for a set of examples.
 * @param {DatasetExample[]} examples
 * @param {{ purpose?: 'evaluation' | 'training' | 'both' }} [o]
 */
function qualityReport(examples, o) {
  const purpose = (o && o.purpose) || 'both';
  /** @type {{ level: 'error' | 'warning' | 'info', code: string, exampleId: string | null, message: string }[]} */
  const issues = [];
  /** @param {'error' | 'warning' | 'info'} level @param {string} code @param {string | null} id @param {string} message */
  const add = (level, code, id, message) => { if (issues.length < 2000) issues.push({ level, code, exampleId: id, message }); };
  /** @type {Map<string, DatasetExample[]>} */
  const byHash = new Map();
  const languages = new Set(), categories = new Set();
  examples.forEach(e => {
    const h = contentHash(e);
    byHash.set(h, (byHash.get(h) || []).concat([e]));
    if (e.language) languages.add(e.language.toLowerCase());
    if (e.category) categories.add(e.category.toLowerCase());
    if (!e.task.trim()) add('error', 'empty_task', e.id, 'The task is empty.');
    if (!e.expected.trim() && !e.checks.length) add(purpose === 'training' ? 'error' : 'warning', 'no_expectation', e.id, 'No expected output, acceptance criteria or checks: there is nothing to judge an answer against' + (purpose !== 'evaluation' ? ' or to train on' : '') + '.');
    if (!e.source) add('info', 'no_provenance', e.id, 'No source recorded (where the example came from, and under what license).');
    const all = [e.task, e.input, e.expected, e.reference].join('\n');
    if (SECRET_PATTERNS.some(re => { re.lastIndex = 0; const hit = re.test(all); re.lastIndex = 0; return hit; })) add('error', 'possible_secret', e.id, 'Contains something that looks like a credential or private key. Remove it before using the dataset.');
    PII.forEach(p => { if (p.re.test(all)) add('warning', 'possible_personal_data', e.id, 'May contain ' + p.what + '. Check that it is needed and that you may use it.'); });
    if (INJECTION.test(all)) add('warning', 'suspicious_instructions', e.id, 'Contains text that reads like instructions to an AI ("ignore previous instructions" …). It will be treated as data, but check it is intended.');
    if (e.quality === 'rejected') add('info', 'rejected', e.id, 'Marked rejected: left out of training exports.');
  });
  byHash.forEach(list => {
    if (list.length > 1) {
      list.slice(1).forEach(e => add('warning', 'duplicate', e.id, 'Duplicates example ' + list[0].id + ' (same task and input).'));
      const splits = new Set(list.map(e => e.split).filter(Boolean));
      if (splits.has('test') && (splits.has('train') || splits.has('validation'))) list.forEach(e => add('error', 'split_overlap', e.id, 'The same task is in the test split and in train/validation: test results would overstate quality.'));
    }
  });
  if (languages.size > 1 && examples.length > 3) add('info', 'mixed_languages', null, 'Examples use ' + languages.size + ' languages (' + Array.from(languages).slice(0, 6).join(', ') + ').');
  const splits = { train: 0, validation: 0, test: 0, none: 0 };
  examples.forEach(e => { splits[e.split || 'none']++; });
  return {
    examples: examples.length,
    errors: issues.filter(i => i.level === 'error').length,
    warnings: issues.filter(i => i.level === 'warning').length,
    splits, categories: Array.from(categories).slice(0, 50), issues,
    note: 'Automated checks can miss secrets and personal data, and say nothing about whether you may use the data. Review it yourself.'
  };
}

/**
 * Assigns splits deterministically (by example id and seed). Examples that already have a split keep it unless `overwrite`.
 * @param {DatasetExample[]} examples
 * @param {{ train: number, validation: number, test: number, seed: string, overwrite: boolean }} o
 */
function assignSplits(examples, o) {
  const total = o.train + o.validation + o.test;
  if (!(total > 0) || [o.train, o.validation, o.test].some(x => !(x >= 0))) throw invalid('Split ratios must be zero or more and add up to more than zero.');
  let changed = 0;
  examples.forEach(e => {
    if (e.split && !o.overwrite) return;
    const h = parseInt(crypto.createHash('sha256').update(o.seed + ':' + e.id).digest('hex').slice(0, 8), 16) / 0xffffffff;
    const split = h < o.train / total ? 'train' : h < (o.train + o.validation) / total ? 'validation' : 'test';
    if (e.split !== split) { e.split = /** @type {DatasetExample['split']} */ (split); changed++; }
  });
  return changed;
}

/* ── Import / export ──────────────────────────────── */

/**
 * RFC 4180 CSV → rows of strings.
 * @param {string} t
 */
function parseCsv(t) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '', i = 0, quoted = false;
  const s = t.replace(/^﻿/, '');
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\n' || ch === '\r') { row.push(field); rows.push(row); row = []; field = ''; i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/** @param {unknown} v */
const csvCell = v => { const s = Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };

/**
 * Reads an import (JSONL, a JSON array, or CSV with a header row). Each row is
 * validated; bad rows are reported, never silently dropped or used.
 * @param {string} content
 * @param {'jsonl' | 'json' | 'csv'} format
 */
function parseImport(content, format) {
  if (typeof content !== 'string' || !content.trim()) throw invalid('The import is empty.');
  if (content.length > 50 * 1024 * 1024) throw invalid('Imports are limited to 50 MB.');
  /** @type {{ row: number, value: unknown }[]} */
  let rows = [];
  /** @type {{ row: number, message: string }[]} */
  const problems = [];
  if (format === 'json') {
    let data;
    try { data = JSON.parse(content); } catch (e) { throw invalid('The JSON couldn\'t be read: ' + /** @type {Error} */ (e).message); }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.examples) ? data.examples : null;
    if (!list) throw invalid('The JSON must be an array of examples (or { "examples": [...] }).');
    rows = /** @type {unknown[]} */ (list).map((value, i) => ({ row: i + 1, value }));
  } else if (format === 'jsonl') {
    content.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try { rows.push({ row: i + 1, value: JSON.parse(line) }); } catch (e) { problems.push({ row: i + 1, message: 'Not valid JSON.' }); }
    });
  } else if (format === 'csv') {
    const table = parseCsv(content);
    if (table.length < 2) throw invalid('The CSV needs a header row and at least one example.');
    const head = table[0].map(h => h.trim());
    if (!head.includes('task')) throw invalid('The CSV needs a "task" column.');
    table.slice(1).forEach((cells, i) => {
      /** @type {Record<string, unknown>} */
      const o = {};
      head.forEach((h, j) => { if (EXAMPLE_FIELDS.includes(h) && h !== 'checks') o[h] = cells[j] === undefined ? '' : cells[j]; });
      if (head.includes('checks') && cells[head.indexOf('checks')]) { try { o.checks = JSON.parse(cells[head.indexOf('checks')]); } catch (e) { problems.push({ row: i + 2, message: 'The checks column isn\'t valid JSON.' }); } }
      rows.push({ row: i + 2, value: o });
    });
  } else throw invalid('The import format must be jsonl, json or csv.');
  /** @type {DatasetExample[]} */
  const examples = [];
  for (const r of rows) {
    if (r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
      const unknown = Object.keys(/** @type {object} */ (r.value)).filter(k => !EXAMPLE_FIELDS.includes(k));
      if (unknown.length) problems.push({ row: r.row, message: 'Ignored unknown field' + (unknown.length > 1 ? 's' : '') + ': ' + unknown.slice(0, 5).join(', ') + '.' });
    }
    try { examples.push(cleanExample(r.value)); } catch (e) { problems.push({ row: r.row, message: /** @type {Error} */ (e).message }); }
  }
  return { examples, problems };
}

/**
 * @param {DatasetExample[]} examples
 * @param {'jsonl' | 'json' | 'csv'} format
 */
function exportExamples(examples, format) {
  if (format === 'jsonl') return examples.map(e => JSON.stringify(e)).join('\n') + '\n';
  if (format === 'json') return JSON.stringify({ format: 'metacode-dataset', formatVersion: 1, examples }, null, 2);
  const cols = EXAMPLE_FIELDS;
  return cols.join(',') + '\n' + examples.map(e => cols.map(c => csvCell(/** @type {any} */ (e)[c])).join(',')).join('\n') + '\n';
}

/**
 * Chat-format training data (OpenAI's fine-tuning format): one conversation per
 * example with an expected output that isn't rejected.
 * @param {DatasetExample[]} examples
 * @param {string} systemPrompt
 */
function chatTrainingFormat(examples, systemPrompt) {
  const used = examples.filter(e => e.expected.trim() && e.quality !== 'rejected');
  const lines = used.map(e => JSON.stringify({ messages: [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: e.task + (e.input ? '\n\n' + e.input : '') },
    { role: 'assistant', content: e.expected }
  ] }));
  return { jsonl: lines.join('\n') + (lines.length ? '\n' : ''), count: used.length, skipped: examples.length - used.length };
}

/**
 * Differences between two versions' examples (by id).
 * @param {DatasetExample[]} a
 * @param {DatasetExample[]} b
 */
function diffVersions(a, b) {
  const ma = new Map(a.map(e => [e.id, e])), mb = new Map(b.map(e => [e.id, e]));
  const strip = /** @param {DatasetExample} e */ e => JSON.stringify(Object.assign({}, e, { updatedAt: null }));
  return {
    added: b.filter(e => !ma.has(e.id)).map(e => ({ id: e.id, task: e.task.slice(0, 120) })),
    removed: a.filter(e => !mb.has(e.id)).map(e => ({ id: e.id, task: e.task.slice(0, 120) })),
    changed: b.filter(e => ma.has(e.id) && strip(/** @type {DatasetExample} */ (ma.get(e.id))) !== strip(e)).map(e => ({ id: e.id, task: e.task.slice(0, 120) })),
    unchanged: b.filter(e => ma.has(e.id) && strip(/** @type {DatasetExample} */ (ma.get(e.id))) === strip(e)).length
  };
}

/** @param {DatasetExample[]} examples */
const versionHash = examples => crypto.createHash('sha256').update(JSON.stringify(examples)).digest('hex');

module.exports = { cleanExample, qualityReport, assignSplits, parseImport, parseCsv, exportExamples, chatTrainingFormat, diffVersions, contentHash, versionHash, MAX_EXAMPLES, EXAMPLE_FIELDS };
