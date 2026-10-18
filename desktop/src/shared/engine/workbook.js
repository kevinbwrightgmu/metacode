// @ts-check
// ── Workbooks, sheets and cells ───────────────────────────────────────────────
// A workbook has sheets; a sheet keeps only the cells that hold something
// (a Map from key — row × MAX_COLS + col — to a cell), plus column widths,
// row heights, hidden and filtered rows/columns, frozen panes and a filter.
//
// A cell is { v, f?, s? }: v the value (for a formula: its last result), f the
// formula text ("=…"), s the id of its style in the workbook's style table.
// Cells are replaced, never edited in place (except a formula's computed v),
// so undo can keep the old ones.

import { keyOf, rcOf, MAX_ROWS, MAX_COLS } from './address.js';
import { textToNumber, parseDateText, err, ERR, CellError } from './values.js';
import { Calc } from './calc.js';
import { renameSheetRefs, deleteSheetRefs } from './references.js';
import { formatValue, isDateFormat } from './format.js';

export const DEFAULT_COL_WIDTH = 100;
export const DEFAULT_ROW_HEIGHT = 24;
export const MAX_SHEETS = 200;
export const MAX_TEXT = 32767;          // Excel's limit for a cell's text

/**
 * @typedef {{ v?: any, f?: string, s?: number }} Cell
 * @typedef {{ bold?: boolean, italic?: boolean, underline?: boolean, strike?: boolean, size?: number, color?: string, family?: string,
 *   fill?: string, h?: 'left' | 'center' | 'right', v?: 'top' | 'middle' | 'bottom', wrap?: boolean, numFmt?: string, indent?: number,
 *   border?: { top?: BorderSide, right?: BorderSide, bottom?: BorderSide, left?: BorderSide } }} Style
 * @typedef {{ style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double', color?: string }} BorderSide
 * @typedef {{ r1: number, c1: number, r2: number, c2: number }} Range
 */

let idSeq = 0;
/** A short random id @param {string} prefix */
export function newId(prefix) {
  idSeq = (idSeq + 1) % 1e6;
  const rnd = typeof crypto !== 'undefined' && crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, '0')).join('') : Math.random().toString(36).slice(2, 14);
  return prefix + rnd + idSeq.toString(36);
}

/** The style table: equal styles share one id (0 is the default style) */
export class StylePool {
  constructor() {
    /** @type {Style[]} */
    this.list = [{}];
    /** @type {Map<string, number>} */
    this.index = new Map([['{}', 0]]);
  }
  /** @param {Style} style */
  id(style) {
    const clean = normalizeStyle(style);
    const k = JSON.stringify(clean);
    let id = this.index.get(k);
    if (id === undefined) { id = this.list.length; this.list.push(clean); this.index.set(k, id); }
    return id;
  }
  /** @param {number | undefined} id @returns {Style} */
  get(id) { return (id !== undefined && this.list[id]) || this.list[0]; }
  /** The style with some properties changed (null removes one) @param {number | undefined} id @param {Partial<Style> & Record<string, any>} patch */
  patch(id, patch) {
    const s = Object.assign({}, this.get(id));
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === false || v === '') delete /** @type {any} */ (s)[k];
      else if (k === 'border') {
        const b = Object.assign({}, s.border || {});
        for (const [side, val] of Object.entries(v)) { if (val) /** @type {any} */ (b)[side] = val; else delete /** @type {any} */ (b)[side]; }
        if (Object.keys(b).length) s.border = b; else delete s.border;
      } else /** @type {any} */ (s)[k] = v;
    }
    return this.id(s);
  }
}

/** Sorted keys, no empty values @param {Style} s @returns {Style} */
function normalizeStyle(s) {
  /** @type {any} */
  const out = {};
  for (const k of Object.keys(s || {}).sort()) {
    const v = /** @type {any} */ (s)[k];
    if (v === undefined || v === null || v === false || v === '') continue;
    if (k === 'border') {
      const b = /** @type {any} */ ({});
      for (const side of ['bottom', 'left', 'right', 'top']) if (v[side] && v[side].style) b[side] = { style: v[side].style, color: v[side].color || '#000000' };
      if (Object.keys(b).length) out.border = b;
      continue;
    }
    if (k === 'numFmt' && v === 'General') continue;
    out[k] = v;
  }
  return out;
}

export class Sheet {
  /** @param {string} id @param {string} name */
  constructor(id, name) {
    this.id = id;
    this.name = name;
    /** @type {Map<number, Cell>} */
    this.cells = new Map();
    /** @type {Map<number, number>} */
    this.colWidths = new Map();
    /** @type {Map<number, number>} */
    this.rowHeights = new Map();
    /** @type {Set<number>} */
    this.hiddenRows = new Set();
    /** @type {Set<number>} */
    this.hiddenCols = new Set();
    /** rows hidden by the filter (not by the user) @type {Set<number>} */
    this.filteredRows = new Set();
    this.freeze = { rows: 0, cols: 0 };
    /** @type {null | { range: Range, conditions: Record<number, any> }} */
    this.filter = null;
    /** @type {string | null} */
    this.tabColor = null;
    /** @type {{ maxRow: number, maxCol: number } | null} */
    this._bounds = null;
  }
  /** @param {number} r @param {number} c */
  get(r, c) { return this.cells.get(keyOf(r, c)); }
  /** The last filled row and column (-1 when empty) */
  bounds() {
    if (this._bounds) return this._bounds;
    let maxRow = -1, maxCol = -1;
    for (const key of this.cells.keys()) { const r = Math.floor(key / MAX_COLS), c = key % MAX_COLS; if (r > maxRow) maxRow = r; if (c > maxCol) maxCol = c; }
    return (this._bounds = { maxRow, maxCol });
  }
  /** @param {number} c */
  colWidth(c) { return this.hiddenCols.has(c) ? 0 : (this.colWidths.get(c) || DEFAULT_COL_WIDTH); }
  /** @param {number} r */
  rowHeight(r) { return this.hiddenRows.has(r) || this.filteredRows.has(r) ? 0 : (this.rowHeights.get(r) || DEFAULT_ROW_HEIGHT); }
  /** @param {number} r */
  isRowHidden(r) { return this.hiddenRows.has(r) || this.filteredRows.has(r); }
}

/**
 * What a typed entry means: a formula, a number (with the format it implies:
 * 12% → percent, $5 → currency, 2024-03-05 → date), TRUE/FALSE, text (a
 * leading ' keeps it as text) or nothing.
 * @param {string} input
 * @returns {{ kind: 'blank' } | { kind: 'formula', f: string } | { kind: 'value', v: any, numFmt?: string }}
 */
export function parseInput(input) {
  const s = String(input === null || input === undefined ? '' : input);
  if (s === '') return { kind: 'blank' };
  if (s.startsWith("'")) return { kind: 'value', v: s.slice(1).slice(0, MAX_TEXT) };
  if (s.startsWith('=') && s.length > 1) return { kind: 'formula', f: s.slice(0, 8192) };
  const t = s.trim();
  if (/^(TRUE|FALSE)$/i.test(t)) return { kind: 'value', v: t.toUpperCase() === 'TRUE' };
  const err0 = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#NULL!'].find(e => e === t.toUpperCase());
  if (err0) return { kind: 'value', v: err(err0) };
  if (/^[+-]?\$/.test(t) || /^[+-]?\d/.test(t) || /^[+-]?\.\d/.test(t) || /^\(\$?[\d.,]+\)$/.test(t)) {
    const paren = /^\((.*)\)$/.exec(t);
    const body = paren ? '-' + paren[1] : t;
    const n = textToNumber(body);
    if (n !== null && /^[+-]?\$?[\d,]*\.?\d*(e[+-]?\d+)?%?$/i.test(body.replace(/\s/g, ''))) {
      if (body.endsWith('%')) return { kind: 'value', v: n, numFmt: /\.\d/.test(body) ? '0.' + '0'.repeat((body.split('.')[1] || '').replace(/%$/, '').length) + '%' : '0%' };
      if (/\$/.test(body)) return { kind: 'value', v: n, numFmt: /\.\d/.test(body) ? '$#,##0.00' : '$#,##0' };
      if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(body.replace(/^[+-]/, ''))) return { kind: 'value', v: n, numFmt: /\./.test(body) ? '#,##0.00' : '#,##0' };
      return { kind: 'value', v: n };
    }
  }
  const d = parseDateText(t);
  if (d !== null) {
    const hasDate = d >= 1, hasTime = d !== Math.floor(d) || /:/.test(t);
    return { kind: 'value', v: d, numFmt: hasDate && hasTime ? 'yyyy-mm-dd hh:mm' : hasDate ? 'yyyy-mm-dd' : /[ap]\.?m?$/i.test(t) ? 'h:mm AM/PM' : 'h:mm' };
  }
  return { kind: 'value', v: s.slice(0, MAX_TEXT) };
}

export class Workbook {
  /** @param {{ name?: string, id?: string }} [o] */
  constructor(o) {
    this.id = (o && o.id) || newId('wb_');
    this.name = (o && o.name) || 'Untitled';
    /** @type {Sheet[]} */
    this.sheets = [];
    this.styles = new StylePool();
    this.calc = new Calc(this);
    this.activeSheetId = '';
    /** free-form properties kept with the file (e.g. where a sheet came from) */
    this.meta = /** @type {Record<string, any>} */ ({});
    /** bumped on every change (autosave watches it) */
    this.version = 0;
    /** @type {Set<(info: any) => void>} */
    this.listeners = new Set();
  }

  /** @param {(info: any) => void} fn */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** @param {any} info */
  changed(info) { this.version++; for (const fn of this.listeners) { try { fn(info); } catch (e) { /* a listener's problem */ } } }

  /** @param {string} id */
  sheet(id) { return this.sheets.find(s => s.id === id) || null; }
  /** Case-insensitive, as in formulas @param {string} name */
  sheetByName(name) { const n = String(name).toLowerCase(); return this.sheets.find(s => s.name.toLowerCase() === n) || null; }
  get activeSheet() { return this.sheet(this.activeSheetId) || this.sheets[0]; }

  /** A name that isn't taken: "Sheet3" @param {string} [base] */
  freeSheetName(base) {
    const b = base || 'Sheet';
    if (base && !this.sheetByName(base)) return base;
    for (let i = base ? 2 : this.sheets.length + 1; ; i++) { const n = base ? b + ' (' + i + ')' : b + i; if (!this.sheetByName(n)) return n; }
  }
  /** Why a sheet name can't be used, or null @param {string} name @param {Sheet} [except] */
  sheetNameProblem(name, except) {
    const n = String(name || '').trim();
    if (!n) return 'A sheet needs a name.';
    if (n.length > 31) return 'Sheet names have at most 31 characters.';
    if (/[\\/?*[\]:]/.test(n)) return 'Sheet names can\'t contain \\ / ? * [ ] or :';
    if (/^'|'$/.test(n)) return 'Sheet names can\'t start or end with an apostrophe.';
    const other = this.sheetByName(n);
    if (other && other !== except) return 'There is already a sheet called "' + other.name + '".';
    return null;
  }

  /** @param {string} [name] @param {number} [index] */
  addSheet(name, index) {
    if (this.sheets.length >= MAX_SHEETS) throw new Error('A workbook has at most ' + MAX_SHEETS + ' sheets.');
    const n = name ? name.trim() : this.freeSheetName();
    const problem = this.sheetNameProblem(n);
    if (problem) throw new Error(problem);
    const s = new Sheet(newId('sh_'), n);
    if (index === undefined || index < 0 || index > this.sheets.length) this.sheets.push(s); else this.sheets.splice(index, 0, s);
    if (!this.activeSheetId) this.activeSheetId = s.id;
    this.calc.sheetAdded(s);
    return s;
  }

  /** Renames a sheet and every formula that refers to it @param {Sheet} sheet @param {string} name */
  renameSheet(sheet, name) {
    const n = String(name).trim();
    const problem = this.sheetNameProblem(n, sheet);
    if (problem) throw new Error(problem);
    const old = sheet.name;
    if (old === n) return;
    this.rewriteFormulas(f => renameSheetRefs(f, old, n));
    sheet.name = n;
    this.calc.rebuild();
    this.calc.recalcAll();
  }

  /** Deletes a sheet; formulas that referred to it get #REF! @param {Sheet} sheet */
  deleteSheet(sheet) {
    if (this.sheets.length <= 1) throw new Error('A workbook needs at least one sheet.');
    const i = this.sheets.indexOf(sheet);
    this.sheets.splice(i, 1);
    this.rewriteFormulas(f => deleteSheetRefs(f, sheet.name));
    if (this.activeSheetId === sheet.id) this.activeSheetId = this.sheets[Math.max(0, i - 1)].id;
    this.calc.rebuild();
    this.calc.recalcAll();
  }

  /** @param {Sheet} sheet @param {number} to */
  moveSheet(sheet, to) {
    const i = this.sheets.indexOf(sheet);
    if (i < 0) return;
    this.sheets.splice(i, 1);
    this.sheets.splice(Math.max(0, Math.min(this.sheets.length, to)), 0, sheet);
  }

  /** A copy of a sheet, placed after it @param {Sheet} sheet */
  duplicateSheet(sheet) {
    const copy = this.addSheet(this.freeSheetName(sheet.name.replace(/ \(\d+\)$/, '')), this.sheets.indexOf(sheet) + 1);
    for (const [k, c] of sheet.cells) copy.cells.set(k, Object.assign({}, c));
    sheet.colWidths.forEach((v, k) => copy.colWidths.set(k, v));
    sheet.rowHeights.forEach((v, k) => copy.rowHeights.set(k, v));
    sheet.hiddenRows.forEach(r => copy.hiddenRows.add(r));
    sheet.hiddenCols.forEach(c => copy.hiddenCols.add(c));
    copy.freeze = Object.assign({}, sheet.freeze);
    copy.tabColor = sheet.tabColor;
    copy._bounds = null;
    this.calc.rebuild();
    this.calc.recalcAll();
    return copy;
  }

  /** Applies fn to every formula's text (fn returns new text) @param {(f: string, sheet: Sheet, key: number) => string} fn */
  rewriteFormulas(fn) {
    for (const s of this.sheets) {
      for (const [k, c] of s.cells) {
        if (!c.f) continue;
        const f = fn(c.f, s, k);
        if (f !== c.f) s.cells.set(k, Object.assign({}, c, { f }));
      }
    }
  }

  /**
   * Puts a cell (null clears it). Doesn't recalculate — call recalc() with
   * the changed cells once a batch is done.
   * @param {Sheet} sheet @param {number} r @param {number} c @param {Cell | null} cell
   */
  setCell(sheet, r, c, cell) {
    const key = keyOf(r, c);
    const before = sheet.cells.get(key);
    if (before && before.f) this.calc.unregister(sheet, key);
    if (!cell || (cell.v === undefined && !cell.f && !cell.s)) sheet.cells.delete(key);
    else {
      const next = Object.assign({}, cell);
      if (next.v === undefined) next.v = null;
      if (!next.s) delete next.s;
      if (!next.f) delete next.f;
      sheet.cells.set(key, next);
      if (next.f) this.calc.register(sheet, key, next.f);
    }
    if (!before || !sheet.cells.has(key)) sheet._bounds = null;
    else if (sheet._bounds && (r > sheet._bounds.maxRow || c > sheet._bounds.maxCol)) sheet._bounds = null;
  }

  /** Recalculates what depends on these cells (and volatile formulas) @param {{ sheet: Sheet, r: number, c: number }[]} changed */
  recalc(changed) { return this.calc.recalc(changed); }

  /** The display value of a cell (computed for formulas) @param {Sheet} sheet @param {number} r @param {number} c */
  valueAt(sheet, r, c) {
    const cell = sheet.cells.get(keyOf(r, c));
    return cell ? (cell.v === undefined ? null : cell.v) : null;
  }

  /** The text to edit for a cell (its formula, or its value as typed) @param {Sheet} sheet @param {number} r @param {number} c */
  inputOf(sheet, r, c) {
    const cell = sheet.get(r, c);
    if (!cell) return '';
    if (cell.f) return cell.f;
    const v = cell.v;
    if (v === null || v === undefined) return '';
    if (v instanceof CellError) return v.code;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return editText(v, this.styles.get(cell.s).numFmt);
    const s = String(v);
    const parsed = parseInput(s);
    return parsed.kind === 'value' && parsed.v === s ? s : "'" + s;
  }
}

/** A number as it should appear when editing (dates as dates, percents as percents) @param {number} v @param {string} [fmt] */
export function editText(v, fmt) {
  if (fmt && isDateFormat(fmt)) {
    const whole = v === Math.floor(v);
    return formatValue(v, v < 1 ? (/AM\/PM/i.test(fmt) ? 'h:mm:ss AM/PM' : 'h:mm:ss') : whole ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss').text;
  }
  if (fmt && /%/.test(fmt) && !/"[^"]*%[^"]*"/.test(fmt)) return String(Number((v * 100).toPrecision(15))) + '%';
  return String(Number(v.toPrecision(15)));
}

export { keyOf, rcOf, MAX_ROWS, MAX_COLS, ERR };
