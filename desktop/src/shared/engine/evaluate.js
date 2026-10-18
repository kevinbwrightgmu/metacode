// @ts-check
// ── Evaluating a formula's syntax tree ────────────────────────────────────────
// No eval, no access to anything outside the workbook: a formula can only read
// cells and call the functions in functions.js. References become RangeRef
// objects that functions read lazily (SUM(A:A) touches only filled cells);
// used as a single value, a range gives the cell in the formula's own row or
// column (Excel's implicit intersection), else #VALUE!.

import { CellError, ERR, err, isError, toNumber, toText, toBool, compareValues } from './values.js';
import { MAX_ROWS, MAX_COLS } from './address.js';

/**
 * @typedef {{ name: string, cells: Map<number, any>, bounds: () => { maxRow: number, maxCol: number } }} SheetLike
 * @typedef {{ sheet: SheetLike, r: number, c: number, sheetByName: (name: string) => SheetLike | null,
 *             valueAt: (sheet: SheetLike, r: number, c: number) => any, now?: () => number, random?: () => number }} EvalContext
 */

/** A rectangle of cells in a sheet, read on demand */
export class RangeRef {
  /** @param {SheetLike} sheet @param {number} r1 @param {number} c1 @param {number} r2 @param {number} c2 @param {EvalContext} ctx */
  constructor(sheet, r1, c1, r2, c2, ctx) {
    this.sheet = sheet; this.r1 = r1; this.c1 = c1; this.r2 = r2; this.c2 = c2; this.ctx = ctx;
  }
  get rows() { return this.r2 - this.r1 + 1; }
  get cols() { return this.c2 - this.c1 + 1; }
  /** Value at (i, j) inside the range (0-based) @param {number} i @param {number} j */
  at(i, j) { return this.ctx.valueAt(this.sheet, this.r1 + i, this.c1 + j); }
  /** The part of the range that can hold anything (clamped to the sheet's filled area) */
  usedRows() { const b = this.sheet.bounds(); return Math.max(0, Math.min(this.r2, b.maxRow) - this.r1 + 1); }
  usedCols() { const b = this.sheet.bounds(); return Math.max(0, Math.min(this.c2, b.maxCol) - this.c1 + 1); }
  /**
   * Every filled cell, row by row (fn(value, i, j)). Large ranges over a
   * small sheet only look at the cells that exist.
   * @param {(v: any, i: number, j: number) => void | boolean} fn  return false to stop
   */
  each(fn) {
    const rows = this.usedRows(), cols = this.usedCols();
    if (rows * cols > this.sheet.cells.size * 2) {
      /** @type {[number, number, any][]} */
      const hits = [];
      for (const [key] of this.sheet.cells) {
        const r = Math.floor(key / MAX_COLS), c = key % MAX_COLS;
        if (r >= this.r1 && r <= this.r2 && c >= this.c1 && c <= this.c2) hits.push([r, c, null]);
      }
      hits.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      for (const h of hits) {
        const v = this.ctx.valueAt(this.sheet, h[0], h[1]);
        if (v !== null && v !== undefined && fn(v, h[0] - this.r1, h[1] - this.c1) === false) return;
      }
      return;
    }
    const cells = this.sheet.cells;
    for (let i = 0; i < rows; i++) {
      let k = (this.r1 + i) * MAX_COLS + this.c1;
      for (let j = 0; j < cols; j++, k++) {
        const cell = cells.get(k);
        const v = cell ? cell.v : null;
        if (v !== null && v !== undefined && fn(v, i, j) === false) return;
      }
    }
  }
  /** Dense 2-D values of the used part (blank = null) */
  matrix() {
    const rows = this.usedRows(), cols = this.usedCols();
    const out = [];
    for (let i = 0; i < rows; i++) { const row = []; for (let j = 0; j < cols; j++) row.push(this.at(i, j)); out.push(row); }
    return out;
  }
  /** Dense 2-D values of the whole range (for positional functions; capped) */
  fullMatrix(limit = 2000000) {
    const rows = Math.min(this.rows, this.usedRows() || 0), cols = Math.min(this.cols, this.usedCols() || 0);
    if (rows * cols > limit) return null;
    return this.matrix().slice(0, rows).map(r => r.slice(0, cols));
  }
}

/** An in-formula array ({1,2;3,4} or a function's array result) */
export class ArrayValue {
  /** @param {any[][]} rows */
  constructor(rows) { this.data = rows; }
  get rows() { return this.data.length; }
  get cols() { return this.data[0] ? this.data[0].length : 0; }
  /** @param {number} i @param {number} j */
  at(i, j) { return this.data[i] && this.data[i][j] !== undefined ? this.data[i][j] : null; }
  /** @param {(v: any, i: number, j: number) => void | boolean} fn */
  each(fn) { for (let i = 0; i < this.rows; i++) for (let j = 0; j < this.cols; j++) { const v = this.data[i][j]; if (v !== null && v !== undefined && fn(v, i, j) === false) return; } }
  matrix() { return this.data; }
  fullMatrix() { return this.data; }
}

/** @param {unknown} v @returns {v is RangeRef | ArrayValue} */
export const isRangeLike = v => v instanceof RangeRef || v instanceof ArrayValue;

/**
 * A single value from anything (implicit intersection for ranges).
 * @param {any} v @param {EvalContext} ctx
 */
export function scalar(v, ctx) {
  if (v instanceof RangeRef) {
    if (v.rows === 1 && v.cols === 1) return v.at(0, 0);
    if (v.cols === 1 && ctx.r >= v.r1 && ctx.r <= v.r2 && v.sheet === ctx.sheet) return v.at(ctx.r - v.r1, 0);
    if (v.rows === 1 && ctx.c >= v.c1 && ctx.c <= v.c2 && v.sheet === ctx.sheet) return v.at(0, ctx.c - v.c1);
    if (v.cols === 1 && ctx.r >= v.r1 && ctx.r <= v.r2) return v.at(ctx.r - v.r1, 0);
    if (v.rows === 1 && ctx.c >= v.c1 && ctx.c <= v.c2) return v.at(0, ctx.c - v.c1);
    return err(ERR.VALUE, 'A range can\'t be used as a single value here');
  }
  if (v instanceof ArrayValue) return v.at(0, 0);
  return v;
}

/** @type {Record<string, any>} filled in by functions.js (avoids a circular import) */
export const FUNCTIONS = {};

/**
 * @param {import('./formula.js').Node} node
 * @param {EvalContext} ctx
 * @returns {any}
 */
export function evaluate(node, ctx) {
  switch (node.type) {
    case 'num': case 'str': case 'bool': return node.v;
    case 'err': return err(node.v);
    case 'empty': return null;
    case 'name': return err(ERR.NAME, 'Unknown name "' + node.name + '"');
    case 'array': return new ArrayValue(node.rows.map(r => r.map(v => (v && typeof v === 'object' && v.error ? err(v.error) : v))));
    case 'ref': {
      const ref = node.ref;
      const sheet = ref.sheet === null ? ctx.sheet : ctx.sheetByName(ref.sheet);
      if (!sheet) return err(ERR.REF, 'There is no sheet "' + ref.sheet + '"');
      if (ref.kind === 'cell') return new RangeRef(sheet, ref.a.r, ref.a.c, ref.a.r, ref.a.c, ctx);
      return new RangeRef(sheet, Math.min(ref.a.r, ref.b.r), Math.min(ref.a.c, ref.b.c), Math.max(ref.a.r, ref.b.r), Math.max(ref.a.c, ref.b.c), ctx);
    }
    case 'unary': {
      const v = toNumber(scalar(evaluate(node.arg, ctx), ctx));
      if (isError(v)) return v;
      return node.op === '-' ? -v : v;
    }
    case 'percent': {
      const v = toNumber(scalar(evaluate(node.arg, ctx), ctx));
      return isError(v) ? v : v / 100;
    }
    case 'binary': return binary(node.op, scalar(evaluate(node.left, ctx), ctx), scalar(evaluate(node.right, ctx), ctx));
    case 'fn': return call(node, ctx);
    default: return err(ERR.VALUE);
  }
}

/** @param {string} op @param {any} a @param {any} b */
export function binary(op, a, b) {
  if (isError(a)) return a;
  if (isError(b)) return b;
  switch (op) {
    case '&': { const x = toText(a), y = toText(b); return isError(x) ? x : isError(y) ? y : x + y; }
    case '=': return compareValues(a, b) === 0;
    case '<>': return compareValues(a, b) !== 0;
    case '<': return compareValues(a, b) < 0;
    case '>': return compareValues(a, b) > 0;
    case '<=': return compareValues(a, b) <= 0;
    case '>=': return compareValues(a, b) >= 0;
    default: break;
  }
  const x = toNumber(a), y = toNumber(b);
  if (isError(x)) return x;
  if (isError(y)) return y;
  let r;
  switch (op) {
    case '+': r = x + y; break;
    case '-': r = x - y; break;
    case '*': r = x * y; break;
    case '/': if (y === 0) return err(ERR.DIV0, 'Division by zero'); r = x / y; break;
    case '^':
      if (x === 0 && y === 0) return err(ERR.NUM, '0^0 is undefined');
      if (x === 0 && y < 0) return err(ERR.DIV0);
      r = Math.pow(x, y);
      break;
    default: return err(ERR.VALUE);
  }
  return Number.isFinite(r) ? r : err(ERR.NUM, 'The result is too large or not a number');
}

/** @param {{ name: string, args: import('./formula.js').Node[] }} node @param {EvalContext} ctx */
function call(node, ctx) {
  const name = node.name.replace(/^_XLFN\./, '').replace(/^_XLWS\./, '');
  const def = FUNCTIONS[name];
  if (!def) return err(ERR.NAME, 'Unknown function ' + name);
  const n = node.args.length;
  if (n < def.min || n > def.max) {
    return err(ERR.VALUE, name + ' takes ' + (def.min === def.max ? def.min : def.max === Infinity ? 'at least ' + def.min : def.min + '–' + def.max) + ' argument' + ((def.max === 1 && def.min === 1) ? '' : 's'));
  }
  try {
    if (def.lazy) return def.fn(node.args.map(a => () => evaluate(a, ctx)), ctx);
    const args = node.args.map(a => evaluate(a, ctx));
    return def.fn(args, ctx);
  } catch (e) {
    if (e instanceof CellError) return e;
    return err(ERR.VALUE, e && /** @type {any} */ (e).message ? String(/** @type {any} */ (e).message).slice(0, 120) : undefined);
  }
}

export { toNumber, toText, toBool, MAX_ROWS };
