// @ts-check
// ── Editing operations ────────────────────────────────────────────────────────
// Everything the app does to a workbook goes through these functions. Each
// one changes the workbook, recalculates what depends on the change, tells
// listeners (wb.changed) and returns an undo step for history.js.

import { keyOf, MAX_ROWS, MAX_COLS, normRange } from './address.js';
import { parseInput, MAX_TEXT, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from './workbook.js';
import { shiftFormula, adjustForStructure, adjustForMove } from './references.js';
import { snapshot, layoutOf } from './history.js';
import { compareValues, CellError, isError, textToNumber, toText } from './values.js';
import { formatValue } from './format.js';
import { fillSeries } from './fill.js';
import { criterion } from './functions.js';

/**
 * @typedef {import('./workbook.js').Workbook} Workbook
 * @typedef {import('./workbook.js').Sheet} Sheet
 * @typedef {import('./workbook.js').Cell} Cell
 * @typedef {import('./workbook.js').Range} Range
 * @typedef {import('./history.js').Step} Step
 */

/** Collects cell changes for one undo step */
class Changes {
  /** @param {Workbook} wb @param {Sheet} sheet */
  constructor(wb, sheet) {
    this.wb = wb;
    this.sheet = sheet;
    /** @type {Map<number, [any, any]>} */
    this.map = new Map();
    /** @type {{ sheet: Sheet, r: number, c: number }[]} */
    this.cells = [];
  }
  /** @param {number} r @param {number} c @param {Cell | null} next */
  set(r, c, next) {
    const key = keyOf(r, c);
    const before = this.sheet.cells.get(key) || null;
    if (sameCell(before, next)) return;
    if (!this.map.has(key)) this.map.set(key, [before ? Object.assign({}, before) : null, null]);
    this.wb.setCell(this.sheet, r, c, next);
    const after = this.sheet.cells.get(key) || null;
    /** @type {[any, any]} */ (this.map.get(key))[1] = after ? Object.assign({}, after) : null;
    this.cells.push({ sheet: this.sheet, r, c });
  }
  /** @param {string} label @param {any} [select] @returns {Step | null} */
  finish(label, select) {
    if (!this.cells.length) return null;
    this.wb.recalc(this.cells);
    this.wb.changed({ type: 'cells', sheet: this.sheet });
    return { type: 'cells', sheetId: this.sheet.id, changes: Array.from(this.map, ([k, [b, a]]) => /** @type {[number, any, any]} */ ([k, b, a])), label, select };
  }
}

/** @param {Cell | null | undefined} a @param {Cell | null | undefined} b */
function sameCell(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return !(a || b) || (!a && b && b.v === undefined && !b.f && !b.s) || (!b && a && (a.v === null || a.v === undefined) && !a.f && !a.s);
  if ((a.f || '') !== (b.f || '') || (a.s || 0) !== (b.s || 0)) return false;
  if (a.f) return true;
  if (a.v instanceof CellError && b.v instanceof CellError) return a.v.code === b.v.code;
  return a.v === b.v;
}

/** A cell from typed input, keeping the cell's style (and adding a number format it implies) @param {Workbook} wb @param {Cell | undefined} prev @param {string} input */
export function cellFromInput(wb, prev, input) {
  const p = parseInput(input);
  const s = prev && prev.s ? prev.s : undefined;
  if (p.kind === 'blank') return s ? { v: null, s } : null;
  if (p.kind === 'formula') return { f: p.f, v: null, s };
  let style = s;
  if (p.numFmt) {
    const cur = wb.styles.get(s).numFmt;
    if (!cur || cur === 'General' || (/%/.test(p.numFmt) !== /%/.test(cur)) || (/[ymdhs]/.test(p.numFmt) && !/[ymdhs]/i.test(cur))) style = wb.styles.patch(s, { numFmt: p.numFmt });
  }
  return { v: p.v, s: style };
}

/** Typed entries → cells @param {Workbook} wb @param {Sheet} sheet @param {{ r: number, c: number, input: string }[]} entries @param {string} [label] */
export function setInputs(wb, sheet, entries, label) {
  const ch = new Changes(wb, sheet);
  for (const e of entries) ch.set(e.r, e.c, cellFromInput(wb, sheet.get(e.r, e.c), e.input));
  return ch.finish(label || (entries.length === 1 ? 'Typing' : 'Edit cells'));
}

/** Raw values (from AI tools, imports, MetaCode data) into a block, starting at (r, c) @param {Workbook} wb @param {Sheet} sheet @param {number} r0 @param {number} c0 @param {any[][]} rows @param {string} label */
export function setValues(wb, sheet, r0, c0, rows, label) {
  const ch = new Changes(wb, sheet);
  rows.forEach((row, i) => row.forEach((v, j) => {
    const r = r0 + i, c = c0 + j;
    if (r >= MAX_ROWS || c >= MAX_COLS) return;
    const prev = sheet.get(r, c);
    if (typeof v === 'string' && v.startsWith('=')) ch.set(r, c, { f: v, v: null, s: prev && prev.s });
    else ch.set(r, c, v === null || v === undefined || v === '' ? (prev && prev.s ? { v: null, s: prev.s } : null) : { v: typeof v === 'string' ? v.slice(0, MAX_TEXT) : v, s: prev && prev.s });
  }));
  return ch.finish(label);
}

/** Every cell position of some ranges (only filled cells when sparse=true) @param {Sheet} sheet @param {Range[]} ranges @param {boolean} sparse @param {(r: number, c: number) => void} fn */
function eachCell(sheet, ranges, sparse, fn) {
  for (const g0 of ranges) {
    const b = sheet.bounds();
    const g = { r1: g0.r1, c1: g0.c1, r2: sparse ? Math.min(g0.r2, b.maxRow) : g0.r2, c2: sparse ? Math.min(g0.c2, b.maxCol) : g0.c2 };
    const area = (g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1);
    if (sparse && area > sheet.cells.size) {
      const keys = [];
      for (const k of sheet.cells.keys()) { const r = Math.floor(k / MAX_COLS), c = k % MAX_COLS; if (r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2) keys.push([r, c]); }
      keys.forEach(([r, c]) => fn(r, c));
    } else {
      for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) fn(r, c);
    }
  }
}

/** Clears contents, formats or both @param {Workbook} wb @param {Sheet} sheet @param {Range[]} ranges @param {'contents' | 'formats' | 'all'} what */
export function clearRanges(wb, sheet, ranges, what) {
  const ch = new Changes(wb, sheet);
  eachCell(sheet, ranges, true, (r, c) => {
    const cell = sheet.get(r, c);
    if (!cell) return;
    if (what === 'all') ch.set(r, c, null);
    else if (what === 'contents') ch.set(r, c, cell.s ? { v: null, s: cell.s } : null);
    else ch.set(r, c, cell.f ? { f: cell.f, v: cell.v } : (cell.v === null || cell.v === undefined ? null : { v: cell.v }));
  });
  return ch.finish(what === 'formats' ? 'Clear formatting' : 'Clear');
}

/**
 * Changes the style of every cell in the ranges (empty cells get a styled
 * empty cell, so formatting a column before typing works). Whole-column or
 * whole-row selections only touch the filled area.
 * @param {Workbook} wb @param {Sheet} sheet @param {Range[]} ranges @param {Record<string, any> | ((style: any, r: number, c: number) => Record<string, any>)} patch @param {string} [label]
 */
export function styleRanges(wb, sheet, ranges, patch, label) {
  const ch = new Changes(wb, sheet);
  const huge = ranges.some(g => (g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1) > 200000);
  eachCell(sheet, ranges, huge, (r, c) => {
    const cell = sheet.get(r, c);
    const p = typeof patch === 'function' ? patch(wb.styles.get(cell ? cell.s : undefined), r, c) : patch;
    const s = wb.styles.patch(cell ? cell.s : undefined, p);
    if (cell) ch.set(r, c, Object.assign({}, cell, { s: s || undefined }));
    else if (s) ch.set(r, c, { v: null, s });
  });
  return ch.finish(label || 'Format');
}

/** Borders around / inside ranges @param {Workbook} wb @param {Sheet} sheet @param {Range[]} ranges @param {'all' | 'outer' | 'none' | 'bottom' | 'top' | 'left' | 'right' | 'inner'} kind @param {{ style: string, color: string }} [side] */
export function setBorders(wb, sheet, ranges, kind, side) {
  const s = side || { style: 'thin', color: '#000000' };
  return styleRanges(wb, sheet, ranges, (st, r, c) => {
    const g = ranges.find(x => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2) || ranges[0];
    const b = /** @type {any} */ ({});
    if (kind === 'none') return { border: { top: null, right: null, bottom: null, left: null } };
    if (kind === 'all') return { border: { top: s, right: s, bottom: s, left: s } };
    if (kind === 'outer') { if (r === g.r1) b.top = s; if (r === g.r2) b.bottom = s; if (c === g.c1) b.left = s; if (c === g.c2) b.right = s; }
    if (kind === 'inner') { if (r < g.r2) b.bottom = s; if (c < g.c2) b.right = s; }
    if (kind === 'bottom' && r === g.r2) b.bottom = s;
    if (kind === 'top' && r === g.r1) b.top = s;
    if (kind === 'left' && c === g.c1) b.left = s;
    if (kind === 'right' && c === g.c2) b.right = s;
    return { border: b };
  }, 'Borders');
}

/* ── Clipboard ──────────────────────────────────── */

/**
 * @typedef {{ sheetId: string, range: Range, cells: (Cell | null)[][], styles: any[], cut: boolean, text: string, html: string }} Clip
 */

/** What's copied: cells (with formulas and styles), plus text and HTML for other apps @param {Workbook} wb @param {Sheet} sheet @param {Range} range @param {boolean} cut @returns {Clip} */
export function copyRange(wb, sheet, range, cut) {
  const b = sheet.bounds();
  const g = { r1: range.r1, c1: range.c1, r2: Math.min(range.r2, Math.max(b.maxRow, range.r1)), c2: Math.min(range.c2, Math.max(b.maxCol, range.c1)) };
  const cells = [], lines = [], htmlRows = [];
  for (let r = g.r1; r <= g.r2; r++) {
    if (sheet.isRowHidden(r) && !cut) continue;
    const row = [], texts = [], tds = [];
    for (let c = g.c1; c <= g.c2; c++) {
      const cell = sheet.get(r, c) || null;
      row.push(cell ? Object.assign({}, cell) : null);
      const st = wb.styles.get(cell ? cell.s : undefined);
      const shown = cell ? formatValue(cell.v, st.numFmt).text : '';
      texts.push(/[\t\n"]/.test(shown) ? '"' + shown.replace(/"/g, '""') + '"' : shown);
      tds.push('<td' + htmlStyle(st) + '>' + escapeHtml(shown) + '</td>');
    }
    cells.push(row); lines.push(texts.join('\t')); htmlRows.push('<tr>' + tds.join('') + '</tr>');
  }
  return { sheetId: sheet.id, range: g, cells, styles: wb.styles.list.slice(), cut, text: lines.join('\n'), html: '<table>' + htmlRows.join('') + '</table>' };
}
/** @param {any} st */
function htmlStyle(st) {
  const css = [];
  if (st.bold) css.push('font-weight:bold');
  if (st.italic) css.push('font-style:italic');
  if (st.color) css.push('color:' + st.color);
  if (st.fill) css.push('background:' + st.fill);
  if (st.h) css.push('text-align:' + st.h);
  return css.length ? ' style="' + css.join(';') + '"' : '';
}
/** @param {string} s */
const escapeHtml = s => String(s).replace(/[&<>"]/g, ch => (/** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }))[ch]);

/**
 * Pastes a clip copied in this app: formulas are adjusted to where they land;
 * a cut also moves references that pointed at the cut cells.
 * @param {Workbook} wb @param {Sheet} sheet @param {Range} target @param {Clip} clip @param {'all' | 'values' | 'formats' | 'formulas'} [mode]
 * @returns {{ step: Step | null, range: Range }}
 */
export function pasteClip(wb, sheet, target, clip, mode) {
  const m = mode || 'all';
  const rows = clip.cells.length, cols = rows ? clip.cells[0].length : 0;
  if (!rows || !cols) return { step: null, range: target };
  // Fill a larger selection with whole copies of the clip
  const tr = target.r2 - target.r1 + 1, tc = target.c2 - target.c1 + 1;
  const repR = tr % rows === 0 && tr > rows ? tr / rows : 1, repC = tc % cols === 0 && tc > cols ? tc / cols : 1;
  const range = { r1: target.r1, c1: target.c1, r2: Math.min(MAX_ROWS - 1, target.r1 + rows * repR - 1), c2: Math.min(MAX_COLS - 1, target.c1 + cols * repC - 1) };
  const fromSheet = wb.sheet(clip.sheetId);
  if (clip.cut && fromSheet) {
    const snapBefore = snapshot(wb);
    const dr = target.r1 - clip.range.r1, dc = target.c1 - clip.range.c1;
    // References to the moved cells follow them (everywhere in the workbook)
    wb.rewriteFormulas((f, s) => adjustForMove(f, { sheetName: fromSheet.name, home: s === fromSheet, from: clip.range, dr, dc, toSheetName: sheet.name }));
    // Read the source again (formulas there may have been rewritten), clear it, then write
    const moved = [];
    for (let r = clip.range.r1; r <= clip.range.r2; r++) { const row = []; for (let c = clip.range.c1; c <= clip.range.c2; c++) row.push(fromSheet.get(r, c) || null); moved.push(row); }
    for (let r = clip.range.r1; r <= clip.range.r2; r++) for (let c = clip.range.c1; c <= clip.range.c2; c++) wb.setCell(fromSheet, r, c, null);
    moved.forEach((row, i) => row.forEach((cell, j) => {
      const r = target.r1 + i, c = target.c1 + j;
      if (r >= MAX_ROWS || c >= MAX_COLS) return;
      wb.setCell(sheet, r, c, cell ? Object.assign({}, cell) : null);
    }));
    wb.calc.rebuild();
    wb.calc.recalcAll();
    wb.changed({ type: 'structure' });
    return { step: { type: 'snapshot', before: snapBefore, after: snapshot(wb), label: 'Move cells' }, range: { r1: target.r1, c1: target.c1, r2: target.r1 + rows - 1, c2: target.c1 + cols - 1 } };
  }
  const styleMap = new Map();
  const restyle = (/** @type {number | undefined} */ s) => {
    if (!s) return undefined;
    if (styleMap.has(s)) return styleMap.get(s);
    const id = wb.styles.id(clip.styles[s] || {});
    styleMap.set(s, id);
    return id || undefined;
  };
  const ch = new Changes(wb, sheet);
  for (let a = 0; a < repR; a++) for (let b = 0; b < repC; b++) {
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const r = target.r1 + a * rows + i, c = target.c1 + b * cols + j;
      if (r >= MAX_ROWS || c >= MAX_COLS) continue;
      const src = clip.cells[i][j];
      const prev = sheet.get(r, c);
      const srcR = clip.range.r1 + i, srcC = clip.range.c1 + j;
      if (m === 'formats') { ch.set(r, c, Object.assign({}, prev || { v: null }, { s: restyle(src ? src.s : undefined) })); continue; }
      if (!src) { ch.set(r, c, m === 'all' ? null : (prev && prev.s ? { v: null, s: prev.s } : null)); continue; }
      const s = m === 'all' ? restyle(src.s) : (prev ? prev.s : undefined);
      if (src.f && m !== 'values') ch.set(r, c, { f: shiftFormula(src.f, r - srcR, c - srcC), v: null, s });
      else ch.set(r, c, { v: src.v === undefined ? null : src.v, s });
    }
  }
  return { step: ch.finish('Paste'), range };
}

/** Text from another app (tab-separated, as spreadsheets copy) → rows of strings @param {string} text */
export function parseClipboardText(text) {
  const s = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (!s) return [];
  const rows = [];
  let row = [], field = '', q = false, start = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; continue; }
    if (ch === '"' && start) { q = true; start = false; continue; }
    if (ch === '\t') { row.push(field); field = ''; start = true; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; start = true; continue; }
    field += ch; start = false;
  }
  row.push(field); rows.push(row);
  return rows;
}

/** Pastes text from another app (each piece typed into its cell) @param {Workbook} wb @param {Sheet} sheet @param {Range} target @param {string} text */
export function pasteText(wb, sheet, target, text) {
  const rows = parseClipboardText(text).slice(0, 100000);
  /** @type {{ r: number, c: number, input: string }[]} */
  const entries = [];
  rows.forEach((row, i) => row.forEach((v, j) => { if (target.r1 + i < MAX_ROWS && target.c1 + j < MAX_COLS) entries.push({ r: target.r1 + i, c: target.c1 + j, input: v }); }));
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return { step: setInputs(wb, sheet, entries, 'Paste'), range: { r1: target.r1, c1: target.c1, r2: target.r1 + rows.length - 1, c2: target.c1 + Math.max(0, width - 1) } };
}

/* ── Fill ───────────────────────────────────────── */

/**
 * Drag-fill: extends the source block over the target (down, up, right or
 * left) as a series (1, 2 → 3, 4; Mon → Tue; Item 1 → Item 2; dates) or by
 * copying; formulas are adjusted like a copy.
 * @param {Workbook} wb @param {Sheet} sheet @param {Range} src @param {Range} dest the whole filled area (including src)
 */
export function fill(wb, sheet, src, dest) {
  const ch = new Changes(wb, sheet);
  const vertical = dest.c1 === src.c1 && dest.c2 === src.c2;
  const forward = vertical ? dest.r2 > src.r2 : dest.c2 > src.c2;
  const lines = vertical ? src.c2 - src.c1 + 1 : src.r2 - src.r1 + 1;
  const srcLen = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1;
  const count = vertical ? (dest.r2 - dest.r1 + 1) - srcLen : (dest.c2 - dest.c1 + 1) - srcLen;
  if (count <= 0) return null;
  const first = vertical ? src.r1 : src.c1, last = vertical ? src.r2 : src.c2;
  for (let l = 0; l < lines; l++) {
    const cells = [];
    for (let k = 0; k < srcLen; k++) cells.push((vertical ? sheet.get(src.r1 + k, src.c1 + l) : sheet.get(src.r1 + l, src.c1 + k)) || null);
    // Extending up or left continues the sequence backwards
    const seq = forward ? cells : cells.slice().reverse();
    const values = seq.map(cl => (cl && !cl.f ? cl.v : null));
    const dates = seq.map(cl => !!(cl && /[ymd]/i.test(String(wb.styles.get(cl.s).numFmt || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''))));
    const series = seq.some(cl => cl && cl.f) ? null : fillSeries(values, count, dates.every(Boolean));
    for (let n = 0; n < count; n++) {
      const srcIdx = n % srcLen;
      const from = seq[srcIdx];
      const pos = forward ? last + 1 + n : first - 1 - n;
      const fromPos = forward ? first + srcIdx : last - srcIdx;
      const r = vertical ? pos : src.r1 + l, c = vertical ? src.c1 + l : pos;
      const fr = vertical ? fromPos : src.r1 + l, fc = vertical ? src.c1 + l : fromPos;
      if (r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) continue;
      if (from && from.f) { ch.set(r, c, { f: shiftFormula(from.f, r - fr, c - fc), v: null, s: from.s }); continue; }
      const v = series ? series[n] : (from ? from.v : null);
      ch.set(r, c, v === null || v === undefined ? (from && from.s ? { v: null, s: from.s } : null) : { v, s: from ? from.s : undefined });
    }
  }
  return ch.finish('Fill');
}

/* ── Rows and columns ──────────────────────────── */

/**
 * Inserts (count > 0) or deletes (count < 0) rows or columns at `at`.
 * References everywhere in the workbook are adjusted; references into
 * deleted cells become #REF!.
 * @param {Workbook} wb @param {Sheet} sheet @param {'row' | 'col'} axis @param {number} at @param {number} count
 */
export function insertDelete(wb, sheet, axis, at, count) {
  if (!count) return null;
  const limit = axis === 'row' ? MAX_ROWS : MAX_COLS;
  if (count > 0 && sheet.bounds()[axis === 'row' ? 'maxRow' : 'maxCol'] + count >= limit) throw new Error('There\'s no room to insert: the sheet would go past its last ' + (axis === 'row' ? 'row' : 'column') + '.');
  const before = snapshot(wb);
  const isRow = axis === 'row';
  const del = count < 0 ? -count : 0;
  /** @param {number} i @returns {number | null} */
  const move = i => {
    if (count > 0) return i >= at ? i + count : i;
    if (i >= at && i < at + del) return null;
    return i >= at + del ? i - del : i;
  };
  // Formulas everywhere first (text), then move the cells
  wb.rewriteFormulas((f, s) => adjustForStructure(f, { sheetName: sheet.name, home: s === sheet, axis, at, count }));
  const cells = new Map();
  for (const [k, cell] of sheet.cells) {
    const r = Math.floor(k / MAX_COLS), c = k % MAX_COLS;
    const nr = isRow ? move(r) : r, nc = isRow ? c : move(c);
    if (nr === null || nc === null) continue;
    cells.set(keyOf(nr, nc), cell);
  }
  sheet.cells = cells;
  sheet._bounds = null;
  const remapMap = (/** @type {Map<number, number>} */ m) => { const out = new Map(); m.forEach((v, i) => { const n = move(i); if (n !== null) out.set(n, v); }); return out; };
  const remapSet = (/** @type {Set<number>} */ s) => { const out = new Set(); s.forEach(i => { const n = move(i); if (n !== null) out.add(n); }); return out; };
  if (isRow) { sheet.rowHeights = remapMap(sheet.rowHeights); sheet.hiddenRows = remapSet(sheet.hiddenRows); sheet.filteredRows = remapSet(sheet.filteredRows); }
  else { sheet.colWidths = remapMap(sheet.colWidths); sheet.hiddenCols = remapSet(sheet.hiddenCols); }
  if (sheet.filter) {
    const g = sheet.filter.range;
    const lo = isRow ? g.r1 : g.c1, hi = isRow ? g.r2 : g.c2;
    const nlo = move(lo), nhi = move(hi);
    if (nlo === null || nhi === null) { if (!(count < 0 && lo >= at && hi < at + del)) { /* keep the part that's left */ } sheet.filter = null; sheet.filteredRows.clear(); }
    else if (isRow) sheet.filter.range = { r1: nlo, c1: g.c1, r2: nhi, c2: g.c2 };
    else {
      sheet.filter.range = { r1: g.r1, c1: nlo, r2: g.r2, c2: nhi };
      const conds = /** @type {Record<number, any>} */ ({});
      for (const [c, v] of Object.entries(sheet.filter.conditions)) { const n = move(Number(c)); if (n !== null) conds[n] = v; }
      sheet.filter.conditions = conds;
    }
  }
  wb.calc.rebuild();
  wb.calc.recalcAll();
  wb.changed({ type: 'structure', sheet });
  const what = (count > 0 ? 'Insert ' : 'Delete ') + (isRow ? 'row' : 'column') + (Math.abs(count) > 1 ? 's' : '');
  return /** @type {Step} */ ({ type: 'snapshot', before, after: snapshot(wb), label: what });
}

/* ── Layout ─────────────────────────────────────── */

/** Changes some layout properties of a sheet as one undoable step @param {Workbook} wb @param {Sheet} sheet @param {string[]} props @param {() => void} fn @param {string} label */
export function layout(wb, sheet, props, fn, label) {
  const before = layoutOf(sheet, props);
  fn();
  const after = layoutOf(sheet, props);
  wb.changed({ type: 'layout', sheet });
  return /** @type {Step} */ ({ type: 'layout', sheetId: sheet.id, before, after, label });
}

/** @param {Workbook} wb @param {Sheet} sheet @param {'row' | 'col'} axis @param {number[]} indexes @param {number} size */
export function resize(wb, sheet, axis, indexes, size) {
  const prop = axis === 'row' ? 'rowHeights' : 'colWidths';
  const def = axis === 'row' ? DEFAULT_ROW_HEIGHT : DEFAULT_COL_WIDTH;
  return layout(wb, sheet, [prop], () => {
    const m = /** @type {Map<number, number>} */ (/** @type {any} */ (sheet)[prop]);
    const v = Math.max(axis === 'row' ? 8 : 12, Math.min(axis === 'row' ? 600 : 1500, Math.round(size)));
    indexes.forEach(i => { if (v === def) m.delete(i); else m.set(i, v); });
  }, axis === 'row' ? 'Row height' : 'Column width');
}

/** @param {Workbook} wb @param {Sheet} sheet @param {'row' | 'col'} axis @param {number[]} indexes @param {boolean} hidden */
export function setHidden(wb, sheet, axis, indexes, hidden) {
  const prop = axis === 'row' ? 'hiddenRows' : 'hiddenCols';
  return layout(wb, sheet, [prop], () => {
    const s = /** @type {Set<number>} */ (/** @type {any} */ (sheet)[prop]);
    indexes.forEach(i => { if (hidden) s.add(i); else s.delete(i); });
  }, (hidden ? 'Hide ' : 'Unhide ') + (axis === 'row' ? 'rows' : 'columns'));
}

/** @param {Workbook} wb @param {Sheet} sheet @param {number} rows @param {number} cols */
export function freeze(wb, sheet, rows, cols) {
  return layout(wb, sheet, ['freeze'], () => { sheet.freeze = { rows: Math.max(0, Math.min(rows, 1000)), cols: Math.max(0, Math.min(cols, 100)) }; }, rows || cols ? 'Freeze panes' : 'Unfreeze panes');
}

/** The width that fits a column's contents @param {Workbook} wb @param {Sheet} sheet @param {number} c @param {(text: string, style: any) => number} measure */
export function fitColumn(wb, sheet, c, measure) {
  let w = 0;
  for (const [k, cell] of sheet.cells) {
    if (k % MAX_COLS !== c) continue;
    const st = wb.styles.get(cell.s);
    w = Math.max(w, measure(formatValue(cell.v, st.numFmt).text, st));
  }
  return w ? w + 14 : DEFAULT_COL_WIDTH;
}

/* ── Sort ───────────────────────────────────────── */

/**
 * Sorts the rows of a range by one or more columns (blanks always last;
 * numbers before text before TRUE/FALSE, as in Excel). Formulas move with
 * their row and are adjusted like a copy.
 * @param {Workbook} wb @param {Sheet} sheet @param {Range} range @param {{ col: number, desc?: boolean }[]} keys @param {boolean} header
 */
export function sortRange(wb, sheet, range, keys, header) {
  const b = sheet.bounds();
  const g = { r1: range.r1 + (header ? 1 : 0), c1: range.c1, r2: Math.min(range.r2, b.maxRow), c2: Math.min(range.c2, b.maxCol) };
  if (g.r2 <= g.r1 || g.c2 < g.c1) return null;
  const before = snapshot(wb);
  const rows = [];
  for (let r = g.r1; r <= g.r2; r++) {
    const cells = [];
    for (let c = g.c1; c <= g.c2; c++) cells.push(sheet.get(r, c) || null);
    rows.push({ r, cells });
  }
  rows.sort((x, y) => {
    for (const k of keys) {
      const a = x.cells[k.col - g.c1], bcell = y.cells[k.col - g.c1];
      const va = a ? a.v : null, vb = bcell ? bcell.v : null;
      const ea = va === null || va === undefined || va === '', eb = vb === null || vb === undefined || vb === '';
      if (ea || eb) { if (ea && eb) continue; return ea ? 1 : -1; }
      const ca = va instanceof CellError, cb = vb instanceof CellError;
      if (ca || cb) { if (ca && cb) continue; return ca ? 1 : -1; }
      const c = compareValues(va, vb);
      if (c) return k.desc ? -c : c;
    }
    return x.r - y.r;
  });
  rows.forEach((row, i) => {
    const r = g.r1 + i;
    row.cells.forEach((cell, j) => {
      const c = g.c1 + j;
      wb.setCell(sheet, r, c, cell ? Object.assign({}, cell, cell.f ? { f: shiftFormula(cell.f, r - row.r, 0) } : {}) : null);
    });
  });
  wb.calc.rebuild();
  wb.calc.recalcAll();
  wb.changed({ type: 'structure', sheet });
  return /** @type {Step} */ ({ type: 'snapshot', before, after: snapshot(wb), label: 'Sort' });
}

/* ── Filter ─────────────────────────────────────── */

/** The text a filter shows for a value @param {Workbook} wb @param {import('./workbook.js').Cell | undefined} cell */
export function filterText(wb, cell) {
  if (!cell || cell.v === null || cell.v === undefined || cell.v === '') return '';
  return formatValue(cell.v, wb.styles.get(cell.s).numFmt).text;
}

/** Hides the rows of the filter's range that don't match its conditions @param {Workbook} wb @param {Sheet} sheet */
export function applyFilter(wb, sheet) {
  sheet.filteredRows = new Set();
  const f = sheet.filter;
  if (!f) return;
  const conds = Object.entries(f.conditions).filter(([, v]) => v);
  if (!conds.length) return;
  const last = Math.min(f.range.r2, sheet.bounds().maxRow);
  for (let r = f.range.r1 + 1; r <= last; r++) {
    for (const [c, cond] of conds) {
      const cell = sheet.get(r, Number(c));
      if (!matchesFilter(wb, cell, cond)) { sheet.filteredRows.add(r); break; }
    }
  }
}

/** @param {Workbook} wb @param {import('./workbook.js').Cell | undefined} cell @param {any} cond */
function matchesFilter(wb, cell, cond) {
  if (cond.type === 'values') return cond.values.includes(filterText(wb, cell));
  if (cond.type === 'condition') {
    const v = cell ? cell.v : null;
    if (cond.op === 'contains') return typeof v === 'string' ? v.toLowerCase().includes(String(cond.value).toLowerCase()) : String(toText(v)).toLowerCase().includes(String(cond.value).toLowerCase());
    if (cond.op === 'notcontains') return !String(toText(v)).toLowerCase().includes(String(cond.value).toLowerCase());
    if (cond.op === 'blank') return v === null || v === undefined || v === '';
    if (cond.op === 'notblank') return !(v === null || v === undefined || v === '');
    return criterion(cond.op + (cond.value === undefined ? '' : cond.value))(v);
  }
  return true;
}

/** Turns the filter on for a range (or off with null) @param {Workbook} wb @param {Sheet} sheet @param {Range | null} range */
export function setFilter(wb, sheet, range) {
  return layout(wb, sheet, ['filter', 'filteredRows'], () => {
    sheet.filter = range ? { range: normRange(range), conditions: {} } : null;
    applyFilter(wb, sheet);
  }, range ? 'Filter' : 'Remove filter');
}

/** A column's filter condition (null clears it) @param {Workbook} wb @param {Sheet} sheet @param {number} col @param {any} cond */
export function setFilterCondition(wb, sheet, col, cond) {
  return layout(wb, sheet, ['filter', 'filteredRows'], () => {
    if (!sheet.filter) return;
    if (cond) sheet.filter.conditions[col] = cond; else delete sheet.filter.conditions[col];
    applyFilter(wb, sheet);
  }, 'Filter');
}

/* ── Find and replace ──────────────────────────── */

/**
 * @typedef {{ query: string, matchCase?: boolean, wholeCell?: boolean, inFormulas?: boolean, allSheets?: boolean, regex?: boolean }} FindOptions
 */

/** @param {FindOptions} o */
function matcher(o) {
  const flags = o.matchCase ? 'g' : 'gi';
  const src = o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(o.wholeCell ? '^(?:' + src + ')$' : src, flags);
}

/** Cells that match, in reading order @param {Workbook} wb @param {Sheet} sheet @param {FindOptions} o @returns {{ sheet: Sheet, r: number, c: number }[]} */
export function findAll(wb, sheet, o) {
  if (!o.query) return [];
  let re;
  try { re = matcher(o); } catch (e) { return []; }
  const out = [];
  for (const s of o.allSheets ? wb.sheets : [sheet]) {
    const keys = Array.from(s.cells.keys()).sort((a, b) => a - b);
    for (const k of keys) {
      const cell = s.cells.get(k);
      if (!cell) continue;
      const text = o.inFormulas && cell.f ? cell.f : filterText(wb, cell);
      re.lastIndex = 0;
      if (text && re.test(text)) out.push({ sheet: s, r: Math.floor(k / MAX_COLS), c: k % MAX_COLS });
    }
  }
  return out;
}

/** Replaces matches (in formulas too when asked) @param {Workbook} wb @param {Sheet} sheet @param {FindOptions} o @param {string} replacement @param {{ sheet: Sheet, r: number, c: number }[]} [only] */
export function replaceAll(wb, sheet, o, replacement, only) {
  const hits = only || findAll(wb, sheet, o);
  let re;
  try { re = matcher(o); } catch (e) { return { steps: [], count: 0 }; }
  /** @type {Map<Sheet, { r: number, c: number, input: string }[]>} */
  const bySheet = new Map();
  for (const h of hits) {
    const cell = h.sheet.get(h.r, h.c);
    if (!cell) continue;
    const src = cell.f ? (o.inFormulas ? cell.f : null) : wb.inputOf(h.sheet, h.r, h.c);
    if (src === null) continue;
    re.lastIndex = 0;
    const next = o.regex ? src.replace(re, replacement) : src.replace(re, () => replacement);
    if (next === src) continue;
    const list = bySheet.get(h.sheet) || [];
    list.push({ r: h.r, c: h.c, input: next });
    bySheet.set(h.sheet, list);
  }
  const steps = [];
  let count = 0;
  for (const [s, entries] of bySheet) { const step = setInputs(wb, s, entries, 'Replace'); if (step) { steps.push(step); count += entries.length; } }
  return { steps, count };
}

/* ── Statistics of a selection (status bar) ───── */

/** Sum, average, count of a selection @param {Workbook} wb @param {Sheet} sheet @param {Range[]} ranges */
export function selectionStats(wb, sheet, ranges) {
  let sum = 0, count = 0, numbers = 0, min = Infinity, max = -Infinity;
  const seen = new Set();
  eachCell(sheet, ranges, true, (r, c) => {
    const k = keyOf(r, c);
    if (seen.has(k) || sheet.isRowHidden(r)) return;
    seen.add(k);
    const v = wb.valueAt(sheet, r, c);
    if (v === null || v === '') return;
    count++;
    if (typeof v === 'number') { numbers++; sum += v; if (v < min) min = v; if (v > max) max = v; }
  });
  return { sum, count, numbers, average: numbers ? sum / numbers : null, min: numbers ? min : null, max: numbers ? max : null };
}

export { textToNumber, isError };
