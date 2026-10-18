// @ts-check
// ── MetaCode data ↔ sheets ────────────────────────────────────────────────────
// Projects (the website's saved projects: posts, codes, codebook), scraper
// results, and the AI Coding prompts — the same prompts the website uses
// (public/js/ai-coding.js), so codes from the app and the website agree.
import * as E from '../../shared/engine/index.js';

/** @typedef {{ id: string, name: string, description?: string, codes: { id: string, label: string, description?: string, aiNotes?: string }[] }} Dimension */

const ENG = ['likes', 'shares', 'comments', 'views'];

/** A cell value from anything @param {any} v */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, 32767);
  try { return JSON.stringify(v).slice(0, 32767); } catch (e) { return String(v); }
}

/**
 * A saved MetaCode project → a workbook: "Posts" (text, metadata, every
 * coder's codes per dimension) and "Codebook".
 * @param {any} rec the project record ({ id, name, data: { posts, codebook } })
 */
export function projectToWorkbook(rec) {
  const data = rec && rec.data ? rec.data : rec;
  const posts = Array.isArray(data.posts) ? data.posts : [];
  /** @type {Dimension[]} */
  const codebook = Array.isArray(data.codebook) ? data.codebook : [];
  const name = (rec && rec.name) || (data.project && data.project.name) || 'MetaCode project';
  const wb = new E.Workbook({ name });
  const ps = wb.addSheet('Posts');
  const header = ['id', 'text', 'author', 'timestamp', ...ENG, 'source'];
  for (const d of codebook) header.push(d.name + ' · Coder 1', d.name + ' · Coder 2', d.name + ' · AI', d.name + ' · AI confidence', d.name + ' · AI reasoning', d.name + ' · Adjudicated');
  /** @type {any[][]} */
  const rows = [header];
  for (const p of posts) {
    const row = [cellValue(p.id), cellValue(p.text), cellValue(p.author), cellValue(p.timestamp)];
    const e = p.engagement || {};
    for (const k of ENG) row.push(Number.isFinite(Number(e[k])) && e[k] !== null && e[k] !== '' ? Number(e[k]) : null);
    row.push(cellValue(p.source && typeof p.source === 'object' ? (p.source.platform || p.source.url || JSON.stringify(p.source)) : p.source));
    for (const d of codebook) {
      const ai = p.aiCodes && p.aiCodes[d.id];
      row.push(cellValue(p.humanCodes && p.humanCodes[d.id]), cellValue(p.coder2Codes && p.coder2Codes[d.id]),
        cellValue(ai ? ai.code : null), ai && Number.isFinite(Number(ai.confidence)) ? Number(ai.confidence) : null, cellValue(ai ? ai.reasoning : null),
        cellValue(p.adjudicated && (typeof p.adjudicated[d.id] === 'object' && p.adjudicated[d.id] ? p.adjudicated[d.id].code : p.adjudicated[d.id])));
    }
    rows.push(row);
  }
  writeRows(wb, ps, rows);
  const bold = wb.styles.id({ bold: true, fill: '#EFF6FF' });
  for (let c = 0; c < header.length; c++) { const cell = ps.get(0, c); if (cell) cell.s = bold; }
  ps.freeze = { rows: 1, cols: 0 };
  ps.colWidths.set(1, 420);
  const cs = wb.addSheet('Codebook');
  /** @type {any[][]} */
  const cb = [['Dimension ID', 'Dimension', 'Dimension description', 'Code ID', 'Label', 'Description', 'AI notes']];
  for (const d of codebook) for (const c of d.codes || []) cb.push([d.id, d.name, d.description || null, c.id, c.label, c.description || null, c.aiNotes || null].map(cellValue));
  writeRows(wb, cs, cb);
  for (let c = 0; c < cb[0].length; c++) { const cell = cs.get(0, c); if (cell) cell.s = bold; }
  cs.freeze = { rows: 1, cols: 0 };
  wb.meta.metacodeProject = { id: rec && rec.id ? rec.id : null, name, importedAt: new Date().toISOString() };
  wb.activeSheetId = ps.id;
  wb.calc.rebuild();
  wb.calc.recalcAll();
  return wb;
}

/** @param {E.Workbook} wb @param {any} sheet @param {any[][]} rows */
export function writeRows(wb, sheet, rows) {
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v === null || v === undefined || v === '') return;
    if (r >= E.MAX_ROWS || c >= E.MAX_COLS) return;
    sheet.cells.set(E.keyOf(r, c), { v });
  }));
  sheet._bounds = null;
}

/** The codebook in a workbook's "Codebook" sheet (as written by projectToWorkbook) @param {E.Workbook} wb @returns {Dimension[]} */
export function codebookFromWorkbook(wb) {
  const s = wb.sheetByName('Codebook');
  if (!s) return [];
  /** @type {Map<string, Dimension>} */
  const dims = new Map();
  const b = s.bounds();
  for (let r = 1; r <= b.maxRow; r++) {
    const v = (/** @type {number} */ c) => { const x = wb.valueAt(s, r, c); return x === null || x === undefined ? '' : String(x); };
    const did = v(0), cid = v(3);
    if (!did || !cid) continue;
    if (!dims.has(did)) dims.set(did, { id: did, name: v(1) || did, description: v(2), codes: [] });
    /** @type {Dimension} */ (dims.get(did)).codes.push({ id: cid, label: v(4) || cid, description: v(5), aiNotes: v(6) || undefined });
  }
  return Array.from(dims.values());
}

/**
 * Codebook text → dimensions. Format:
 *   # Sentiment
 *   pos = Positive — praise or approval
 *   neg = Negative
 * @param {string} text @returns {{ codebook: Dimension[], problems: string[] }}
 */
export function parseCodebookText(text) {
  /** @type {Dimension[]} */
  const out = [];
  const problems = [];
  /** @type {Dimension | null} */
  let cur = null;
  const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'dim';
  String(text).split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const head = /^#+\s*(?:dimension:\s*)?(.+)$/i.exec(t);
    if (head) { cur = { id: slug(head[1]), name: head[1].trim(), codes: [] }; if (out.some(d => d.id === /** @type {Dimension} */ (cur).id)) cur.id += '_' + (out.length + 1); out.push(cur); return; }
    if (!cur) { problems.push('Line ' + (i + 1) + ': start with a dimension line like "# Sentiment".'); return; }
    const m = /^([^=—–-]+?)\s*=\s*(.+?)(?:\s+[—–-]\s+(.+))?$/.exec(t);
    if (!m) { problems.push('Line ' + (i + 1) + ': write codes as "id = Label — description".'); return; }
    cur.codes.push({ id: m[1].trim(), label: m[2].trim(), description: m[3] ? m[3].trim() : '' });
  });
  for (const d of out) if (!d.codes.length) problems.push('"' + d.name + '" has no codes.');
  return { codebook: out, problems };
}
/** Dimensions → codebook text @param {Dimension[]} cb */
export const codebookText = cb => cb.map(d => '# ' + d.name + '\n' + d.codes.map(c => c.id + ' = ' + c.label + (c.description ? ' — ' + c.description : '')).join('\n')).join('\n\n');

/* ── AI Coding prompts (as public/js/ai-coding.js) ── */

/** @param {Dimension[]} codebook */
export function buildSystemPrompt(codebook) {
  const dimText = codebook.map(d => {
    const codeLines = d.codes.map(c => {
      let line = '  code "' + c.id + '" = ' + c.label + (c.description ? ' (' + c.description + ')' : '');
      if (c.aiNotes) line += '\n    Additional guidance for applying this code: ' + c.aiNotes;
      return line;
    }).join('\n');
    return 'Dimension "' + d.id + '" — ' + d.name + (d.description ? ': ' + d.description : '') + '\n' + codeLines;
  }).join('\n\n');
  const exampleParts = codebook.map(d => '"' + d.id + '":{"code":"' + (d.codes.length ? d.codes[0].id : 'code_id') + '","confidence":0.9,"reasoning":"One sentence."}').join(',');
  return 'You are a content analyst coding social media posts for academic research.\n\n' +
    'CODEBOOK:\n' + dimText + '\n\n' +
    'INSTRUCTIONS:\n' +
    '1. Read the post the user sends.\n' +
    '2. Assign one code per dimension using only the code IDs listed above.\n' +
    '3. Your ENTIRE response must be a single raw JSON object — no explanation, no markdown, no code fences.\n' +
    '4. The JSON must start with { and end with } and be valid JSON.\n\n' +
    'EXACT OUTPUT FORMAT:\n' +
    '{"codings":{' + exampleParts + '}}\n\n' +
    'Required dimension IDs: ' + codebook.map(d => d.id).join(', ') + '\n' +
    'Do not add any text before or after the JSON object.';
}
/** @param {{ text: string, author?: string, timestamp?: string }} post */
export function buildUserMessage(post) {
  let msg = 'Code this post:\n\n"' + post.text + '"';
  if (post.author) msg += '\nAuthor: @' + post.author;
  if (post.timestamp) msg += '\nDate: ' + post.timestamp;
  return msg;
}
/** The model's answer → { dimensionId: { code, confidence, reasoning } } @param {string} raw */
export function parseCodings(raw) {
  let src = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = src.indexOf('{'), end = src.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The answer had no JSON object.');
  const parsed = JSON.parse(src.slice(start, end + 1));
  if (!parsed.codings || typeof parsed.codings !== 'object') throw new Error('The answer was missing "codings".');
  return parsed.codings;
}
/** Only codes from the codebook count @param {any} codings @param {Dimension[]} codebook */
export function validCodings(codings, codebook) {
  /** @type {Record<string, { code: string | null, confidence: number | null, reasoning: string }>} */
  const out = {};
  for (const d of codebook) {
    const c = codings[d.id];
    const code = c && typeof c === 'object' ? String(c.code) : c !== undefined && c !== null ? String(c) : null;
    out[d.id] = {
      code: code !== null && d.codes.some(x => x.id === code) ? code : null,
      confidence: c && Number.isFinite(Number(c.confidence)) ? Math.max(0, Math.min(1, Number(c.confidence))) : null,
      reasoning: c && typeof c.reasoning === 'string' ? c.reasoning.slice(0, 2000) : ''
    };
  }
  return out;
}

/* ── Scraper results ───────────────────────────── */

const PREFERRED = ['record_type', 'id', 'name', 'title', 'body', 'selftext', 'full_text', 'text', 'author', 'subreddit', 'channel', 'created_utc', 'created_at', 'published_at', 'score', 'ups', 'num_comments', 'like_count', 'reply_count', 'view_count', 'url', 'permalink', 'parent_id', 'link_id'];

/** Scraper records → rows (a header row, then one row per record) @param {any[]} records */
export function recordsToRows(records) {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @param {any} rec @returns {Record<string, any>} */
  const flat = rec => {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(rec || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k2, v2] of Object.entries(v)) out[k + '.' + k2] = v2; }
      else out[k] = Array.isArray(v) ? v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : v;
    }
    return out;
  };
  const flats = records.map(flat);
  for (const f of flats.slice(0, 2000)) for (const k of Object.keys(f)) keys.add(k);
  const cols = PREFERRED.filter(k => keys.has(k)).concat(Array.from(keys).filter(k => !PREFERRED.includes(k)).sort()).slice(0, 120);
  /** @type {any[][]} */
  const rows = [cols];
  for (const f of flats) {
    rows.push(cols.map(k => {
      const v = f[k];
      if ((k === 'created_utc' || k.endsWith('_utc')) && Number.isFinite(Number(v)) && Number(v) > 1e8) return E.msToSerial(Number(v) * 1000);
      return cellValue(v);
    }));
  }
  return { rows, cols };
}

/**
 * Posts for a new MetaCode project from sheet columns
 * @param {E.Workbook} wb @param {any} sheet @param {{ r1: number, r2: number }} rows data rows
 * @param {{ text: number, id?: number, author?: number, timestamp?: number, likes?: number, shares?: number, comments?: number, views?: number }} map
 */
export function postsFromSheet(wb, sheet, rows, map) {
  const posts = [];
  const val = (/** @type {number} */ r, /** @type {number | undefined} */ c) => (c === undefined || c < 0 ? null : wb.valueAt(sheet, r, c));
  const fmt = (/** @type {number} */ r, /** @type {number | undefined} */ c) => {
    if (c === undefined || c < 0) return '';
    const cell = sheet.get(r, c);
    if (!cell || cell.v === null || cell.v === undefined) return '';
    return E.formatValue(cell.v, wb.styles.get(cell.s).numFmt).text;
  };
  for (let r = rows.r1; r <= rows.r2 && posts.length < 200000; r++) {
    const text = fmt(r, map.text);
    if (!text) continue;
    /** @type {Record<string, number>} */
    const engagement = {};
    for (const k of ENG) { const v = val(r, /** @type {any} */ (map)[k]); if (typeof v === 'number') engagement[k] = v; }
    posts.push({
      id: fmt(r, map.id) || 'row' + (r + 1), text, author: fmt(r, map.author), timestamp: fmt(r, map.timestamp), engagement,
      humanCodes: {}, coder2Codes: {}, coderNotes: {}, aiCodes: {}, adjudicated: {}, source: 'MetaCode Sheets'
    });
  }
  return posts;
}

/** A column whose header suggests a role (for pre-filling mappings) @param {string[]} headers @param {RegExp} re */
export const guessColumn = (headers, re) => headers.findIndex(h => re.test(String(h || '')));
