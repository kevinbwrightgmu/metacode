// @ts-check
// ── Project knowledge: ingestion and retrieval ────────────────────────────────
// Ingestion (one document at a time, in the background so a large file never
// holds up an interactive request):
//   1. validated on upload — supported file type, size limit, text not binary
//      or executable, document count and the account's storage allowance;
//   2. normalised (UTF-8, line endings, Unicode NFC);
//   3. scanned: likely secrets are redacted before anything is stored or sent
//      to a model; text that reads like instructions to an AI is flagged;
//   4. split into chunks (Markdown by headings, code by lines);
//   5. marked ready — only then is it searchable.
//
// Retrieval is keyword-based (BM25) over one project's ready documents: no
// embeddings, so it matches words and identifiers, not meanings. Retrieved
// text is always handed to models as untrusted reference material (see
// context.js), never as instructions. The search interface takes a query and
// returns scored chunks, so a vector or hybrid retriever can replace it.

const crypto = require('crypto');
const { invalid } = require('./errors');
const { SECRET_PATTERNS } = require('../lib/log');

/** @typedef {import('../types/ai-lab').KnowledgeDocument} KnowledgeDocument */
/** @typedef {import('../types/ai-lab').KnowledgeChunk} KnowledgeChunk */

const CODE_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp', php: 'php', sql: 'sql', sh: 'shell', bash: 'shell',
  css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', r: 'r', scala: 'scala', lua: 'lua', dart: 'dart' };
const TEXT_EXT = { md: 'markdown', markdown: 'markdown', mdx: 'markdown', txt: 'text', rst: 'text', adoc: 'text', html: 'text', htm: 'text' };
const DATA_EXT = { json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', csv: 'csv', ini: 'ini' };
const REFUSED_NAMES = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials(\.json)?|\.npmrc|\.netrc)$/i;

/** Text that tries to instruct an AI — flagged, kept as data, never obeyed. */
const INJECTION = /(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|messages)|you\s+are\s+now\s+(a|an|the)\b|reveal\s+(your|the)\s+(system\s+)?prompt|\bsystem\s*prompt\s*:|<\s*\/?\s*system\s*>|do\s+not\s+tell\s+the\s+user/i;

/**
 * What kind of file a name is. → { kind, language } or throws.
 * @param {string} name
 * @returns {{ kind: KnowledgeDocument['kind'], language: string | null }}
 */
function classify(name) {
  if (REFUSED_NAMES.test(name)) throw invalid('"' + name + '" looks like a credentials or key file. Those can\'t be added to a knowledge base.');
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  /** @type {Record<string, string>} */
  const code = CODE_EXT;
  /** @type {Record<string, string>} */
  const txt = TEXT_EXT;
  /** @type {Record<string, string>} */
  const data = DATA_EXT;
  if (ext in code) return { kind: 'code', language: code[ext] };
  if (ext in txt) return { kind: txt[ext] === 'markdown' ? 'markdown' : 'text', language: null };
  if (ext in data) return { kind: 'data', language: data[ext] };
  if (!ext) throw invalid('"' + name + '" has no file extension. Supported: Markdown, text, source code and data files (.md, .txt, .js, .py, .json, .yaml …).');
  throw invalid('".' + ext + '" files aren\'t supported. Supported: Markdown, plain text, source code and data files (.md, .txt, .js, .ts, .py, .go, .json, .yaml, .csv …).');
}

/**
 * Refuses binary or executable content.
 * @param {string} content
 */
function checkText(content) {
  if (/\u0000/.test(content)) throw invalid('The file contains binary data (NUL bytes). Only text files can be added.');
  const head = content.slice(0, 8);
  if (/^MZ/.test(head) || /^\u007fELF/.test(head) || /^%PDF/.test(head) || /^PK\u0003\u0004/.test(head) || /^Ïúíþ|^þíúÏ/.test(head)) {
    throw invalid('The file is an executable, archive or PDF, not text.');
  }
  const sample = content.slice(0, 20000);
  const odd = (sample.match(/[\u0001-\u0008\u000E-\u001F�]/g) || []).length;
  if (sample.length && odd / sample.length > 0.02) throw invalid('The file doesn\'t look like text (too many control or undecodable characters).');
}

/**
 * Normalises text and redacts likely secrets. → { text, warnings }
 * @param {string} content
 */
function normalize(content) {
  /** @type {string[]} */
  const warnings = [];
  let t = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').normalize('NFC');
  let secrets = 0;
  for (const re of SECRET_PATTERNS) t = t.replace(re, () => { secrets++; return '[redacted secret]'; });
  t = t.replace(/\b(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)(\s*[:=]\s*)(["']?)(?!\[redacted)[^\s"']{8,}\3/gi, (m, k, sep) => { secrets++; return k + sep + '[redacted secret]'; });
  if (secrets) warnings.push('possible_secrets_redacted:' + secrets);
  if (INJECTION.test(t)) warnings.push('suspicious_instructions');
  return { text: t, warnings };
}

/**
 * Splits text into chunks of about `size` characters.
 * Markdown: by headings, then paragraphs. Everything else: by lines, with a small overlap.
 * @param {string} t
 * @param {'markdown' | 'text' | 'code' | 'data'} kind
 * @param {number} [size]
 * @returns {KnowledgeChunk[]}
 */
function chunk(t, kind, size) {
  const max = size || 1500;
  const lines = t.split('\n');
  /** @type {KnowledgeChunk[]} */
  const out = [];
  /** @param {string[]} buf @param {number} start @param {string | null} heading */
  const push = (buf, start, heading) => {
    const textOf = buf.join('\n').trim();
    if (textOf) out.push({ index: out.length, text: textOf, heading, startLine: start + 1, endLine: start + buf.length });
  };
  if (kind === 'markdown') {
    /** @type {string | null} */
    let heading = null;
    /** @type {string[]} */
    let buf = [];
    let start = 0, len = 0;
    lines.forEach((line, i) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const tooLong = len + line.length > max && buf.length;
      const breakHere = (h && buf.length) || (tooLong && (line.trim() === '' || len > max * 1.5));
      if (breakHere) { push(buf, start, heading); buf = []; start = i; len = 0; }
      if (h) heading = h[2].trim().slice(0, 200);
      buf.push(line); len += line.length + 1;
    });
    push(buf, start, heading);
    return out;
  }
  const overlap = kind === 'code' ? 5 : 2;
  let i = 0;
  while (i < lines.length) {
    let len = 0, j = i;
    while (j < lines.length && (len + lines[j].length + 1 <= max || j === i)) { len += lines[j].length + 1; j++; }
    push(lines.slice(i, j), i, null);
    if (j >= lines.length) break;
    i = Math.max(i + 1, j - overlap);
  }
  return out;
}

/**
 * Validates an upload. → the document's starting record (status pending).
 * @param {{ name: unknown, content: unknown }} input
 * @param {{ maxBytes: number }} limits
 */
function prepareUpload(input, limits) {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\\/g, '/').split('/').pop() || '' : '';
  if (!name || name.length > 200 || /[\u0000-\u001F]/.test(name)) throw invalid('Each document needs a file name (200 characters at most).');
  if (typeof input.content !== 'string') throw invalid('The document\'s content must be text.');
  const bytes = Buffer.byteLength(input.content);
  if (!bytes) throw invalid('"' + name + '" is empty.');
  if (bytes > limits.maxBytes) throw invalid('"' + name + '" is ' + Math.ceil(bytes / 1024) + ' KB; the limit is ' + Math.round(limits.maxBytes / 1024) + ' KB per document.');
  const { kind, language } = classify(name);
  checkText(input.content);
  return { name, kind, language, bytes, sha256: crypto.createHash('sha256').update(input.content).digest('hex') };
}

/**
 * The ingestion step itself (normalise, scan, chunk). Pure: the caller stores the result.
 * @param {string} content
 * @param {'markdown' | 'text' | 'code' | 'data'} kind
 */
function ingest(content, kind) {
  const { text, warnings } = normalize(content);
  const chunks = chunk(text, kind);
  if (!chunks.length) throw invalid('No text was left after normalising the document.');
  return { chunks, warnings };
}

/* ── BM25 ─────────────────────────────────────────── */

const STOP = new Set('a an and are as at be but by for from has have i if in into is it its of on or that the their then there these this to was were will with you your we our can should would could not no do does how what when where which who why'.split(' '));

/**
 * Words and identifiers: camelCase and snake_case are also split into their parts.
 * @param {string} t
 */
function tokenize(t) {
  /** @type {string[]} */
  const out = [];
  const words = String(t).match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) || [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (lower.length > 1 && !STOP.has(lower)) out.push(lower);
    const parts = w.split(/_+|(?<=[a-z0-9])(?=[A-Z])/).map(p => p.toLowerCase()).filter(p => p.length > 1 && p !== lower && !STOP.has(p));
    parts.forEach(p => out.push(p));
  }
  return out;
}

/**
 * An index over chunks. → search(query, k) → [{ docId, name, chunk, score, text, heading, startLine, endLine }]
 * @param {{ id: string, name: string, chunks: KnowledgeChunk[] }[]} docs
 */
function buildIndex(docs) {
  /** @type {{ docId: string, name: string, chunk: KnowledgeChunk, tf: Map<string, number>, len: number }[]} */
  const entries = [];
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const d of docs) {
    for (const c of d.chunks) {
      const toks = tokenize((c.heading || '') + ' ' + d.name + ' ' + c.text);
      /** @type {Map<string, number>} */
      const tf = new Map();
      toks.forEach(tk => tf.set(tk, (tf.get(tk) || 0) + 1));
      tf.forEach((_, tk) => df.set(tk, (df.get(tk) || 0) + 1));
      entries.push({ docId: d.id, name: d.name, chunk: c, tf, len: toks.length });
    }
  }
  const N = entries.length;
  const avg = N ? entries.reduce((s, e) => s + e.len, 0) / N : 0;
  const k1 = 1.2, b = 0.75;
  return {
    size: N,
    /**
     * @param {string} query
     * @param {number} k
     */
    search(query, k) {
      const q = Array.from(new Set(tokenize(query)));
      if (!q.length || !N) return [];
      return entries.map(e => {
        let score = 0;
        for (const t of q) {
          const f = e.tf.get(t);
          if (!f) continue;
          const n = df.get(t) || 0;
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
          score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * e.len / (avg || 1)));
        }
        return { e, score };
      }).filter(x => x.score > 0).sort((x, y) => y.score - x.score).slice(0, Math.max(1, k)).map(({ e, score }) => ({
        docId: e.docId, name: e.name, chunk: e.chunk.index, score: Math.round(score * 1000) / 1000,
        text: e.chunk.text, heading: e.chunk.heading, startLine: e.chunk.startLine, endLine: e.chunk.endLine
      }));
    }
  };
}

module.exports = { prepareUpload, ingest, chunk, normalize, classify, checkText, tokenize, buildIndex, INJECTION };
