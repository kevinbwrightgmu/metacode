// @ts-check
// ── Spreadsheet functions ─────────────────────────────────────────────────────
// Each function gets its evaluated arguments (numbers, text, booleans, errors,
// null for empty, or RangeRef / ArrayValue for ranges) — or, when `lazy`,
// thunks, so IF and friends only evaluate the branch they need. Behaviour
// follows Excel: errors propagate, ranges skip text and booleans in
// statistics, criteria in COUNTIF & co. accept ">5", "<>x", "a*" and "".
//
// MetaCode's own: COHENKAPPA, WEIGHTEDKAPPA, KRIPPENDORFF and
// PERCENTAGREEMENT compute intercoder reliability with the same code as the
// website's Reliability page (public/js/reliability-stats.js, provided by the
// app as globalThis.ReliabilityStats).

import { FUNCTIONS, RangeRef, ArrayValue, isRangeLike, scalar } from './evaluate.js';
import { ERR, err, isError, isBlank, toNumber, toText, toBool, compareValues, textToNumber, numberToText,
  serialToParts, dateToSerial, timeToSerial, msToSerial, parseDateText, CellError } from './values.js';
import { formatValue } from './format.js';

/**
 * @typedef {import('./evaluate.js').EvalContext} Ctx
 * @typedef {{ fn: (args: any[], ctx: Ctx) => any, min: number, max: number, lazy?: boolean, volatile?: boolean, category: string, args?: string, summary?: string }} FnDef
 */

/** @param {string} name @param {Omit<FnDef, 'min' | 'max'> & { min?: number, max?: number }} def */
function define(name, def) {
  FUNCTIONS[name] = Object.assign({ min: 0, max: Infinity }, def);
}
const many = (/** @type {string[]} */ names, /** @type {any} */ def) => names.forEach(n => define(n, def));

/* ── Argument helpers ──────────────────────────── */

/** @param {any} v @param {Ctx} ctx */
const num = (v, ctx) => toNumber(scalar(v, ctx));
/** @param {any} v @param {Ctx} ctx */
const txt = (v, ctx) => toText(scalar(v, ctx));
/** @param {any} v @param {Ctx} ctx */
const bool = (v, ctx) => toBool(scalar(v, ctx));
/** @param {any} v @param {Ctx} ctx @param {number} [fallback] */
const optNum = (v, ctx, fallback) => (v === undefined || v === null ? (fallback === undefined ? 0 : fallback) : num(v, ctx));
/** throws the error (call() turns it into the result) @template T @param {T | CellError} v @returns {T} */
const ok = v => { if (v instanceof CellError) throw v; return v; };

/**
 * Numbers for statistics. From ranges: numbers only (text, booleans and
 * blanks are skipped); typed directly: numbers, booleans and numeric text.
 * Errors stop with the error.
 * @param {any[]} args @param {Ctx} ctx @param {{ textAsZero?: boolean }} [o]
 * @returns {number[]}
 */
function numbers(args, ctx, o) {
  /** @type {number[]} */
  const out = [];
  for (const a of args) {
    if (isRangeLike(a)) {
      a.each(v => {
        if (typeof v === 'number') out.push(v);
        else if (v instanceof CellError) throw v;
        else if (o && o.textAsZero) out.push(typeof v === 'boolean' ? (v ? 1 : 0) : 0);
      });
    } else if (a === null || a === undefined) {
      continue;
    } else {
      out.push(ok(toNumber(a)));
    }
  }
  return out;
}

/** Every value of the arguments (ranges flattened, blanks skipped) @param {any[]} args @returns {any[]} */
function flatValues(args) {
  const out = [];
  for (const a of args) {
    if (isRangeLike(a)) a.each(v => { out.push(v); });
    else out.push(a);
  }
  return out;
}

/** A 2-D matrix from a range, an array or a single value @param {any} v @returns {any[][]} */
function matrixOf(v) {
  if (v instanceof RangeRef) { const m = v.fullMatrix(); if (!m) throw err(ERR.NUM, 'The range is too large'); return m; }
  if (v instanceof ArrayValue) return v.data;
  return [[v]];
}

/** The positional values of a range (whole range, including blanks), as one list @param {any} v */
function vectorOf(v) {
  if (v instanceof RangeRef) {
    const rows = v.rows, cols = v.cols;
    const usedR = Math.min(rows, v.usedRows()), usedC = Math.min(cols, v.usedCols());
    if (rows === 1) { const out = []; for (let j = 0; j < usedC; j++) out.push(v.at(0, j)); return { values: out, length: cols }; }
    if (cols === 1) { const out = []; for (let i = 0; i < usedR; i++) out.push(v.at(i, 0)); return { values: out, length: rows }; }
    const m = matrixOf(v); return { values: m.flat(), length: m.flat().length };
  }
  if (v instanceof ArrayValue) { const f = v.data.flat(); return { values: f, length: f.length }; }
  return { values: [v], length: 1 };
}

/* ── Criteria (COUNTIF, SUMIF, …) ──────────────── */

/** Wildcards * ? (~ escapes) → RegExp, case-insensitive @param {string} pattern */
export function wildcardRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; }
    else if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

/**
 * A criterion → a test for cell values.
 * @param {any} crit
 * @returns {(v: any) => boolean}
 */
export function criterion(crit) {
  if (crit instanceof CellError) return v => v instanceof CellError && v.code === crit.code;
  if (typeof crit === 'number') return v => (typeof v === 'number' && v === crit) || (typeof v === 'string' && textToNumber(v) === crit);
  if (typeof crit === 'boolean') return v => v === crit;
  if (crit === null || crit === undefined) return v => typeof v === 'number' && v === 0;
  const s = String(crit);
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(s);
  const op = (m && m[1]) || '=';
  const operand = m ? m[2] : s;
  const n = textToNumber(operand);
  if (operand === '') {
    if (op === '=') return v => isBlank(v) || v === '';
    if (op === '<>') return v => !isBlank(v) && v !== '';
  }
  if (n !== null && operand.trim() !== '') {
    const cmp = (/** @type {number} */ x) => (op === '=' ? x === n : op === '<>' ? x !== n : op === '<' ? x < n : op === '>' ? x > n : op === '<=' ? x <= n : x >= n);
    return v => {
      if (typeof v === 'number') return cmp(v);
      if (op === '<>') return true;
      return false;
    };
  }
  const bu = operand.toUpperCase();
  if (bu === 'TRUE' || bu === 'FALSE') {
    const b = bu === 'TRUE';
    return v => (op === '<>' ? v !== b : op === '=' ? v === b : false);
  }
  if (op === '=' || op === '<>') {
    const re = wildcardRegex(operand);
    const hit = (/** @type {any} */ v) => typeof v === 'string' && re.test(v);
    return op === '=' ? hit : v => !hit(v);
  }
  return v => {
    if (typeof v !== 'string') return false;
    const c = compareValues(v, operand);
    return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  };
}

/**
 * Walks positions of one or more same-sized ranges where every criterion
 * holds; fn(i, j) for each.
 * @param {{ range: any, test: (v: any) => boolean }[]} pairs
 * @param {(i: number, j: number) => void} fn
 * @returns {number} positions not walked (beyond every range's filled area) that matched blanks
 */
function eachMatch(pairs, fn) {
  const first = pairs[0].range;
  const rows = first instanceof RangeRef || first instanceof ArrayValue ? first.rows : 1;
  const cols = first instanceof RangeRef || first instanceof ArrayValue ? first.cols : 1;
  for (const p of pairs) {
    const r = p.range instanceof RangeRef || p.range instanceof ArrayValue ? p.range.rows : 1;
    const c = p.range instanceof RangeRef || p.range instanceof ArrayValue ? p.range.cols : 1;
    if (r !== rows || c !== cols) throw err(ERR.VALUE, 'The ranges must be the same size');
  }
  let usedR = 0, usedC = 0;
  for (const p of pairs) {
    if (p.range instanceof RangeRef) { usedR = Math.max(usedR, Math.min(rows, p.range.usedRows())); usedC = Math.max(usedC, Math.min(cols, p.range.usedCols())); }
    else { usedR = rows; usedC = cols; }
  }
  const at = (/** @type {any} */ r, /** @type {number} */ i, /** @type {number} */ j) => (r instanceof RangeRef || r instanceof ArrayValue ? r.at(i, j) : r);
  for (let i = 0; i < usedR; i++) {
    for (let j = 0; j < usedC; j++) {
      if (pairs.every(p => p.test(at(p.range, i, j)))) fn(i, j);
    }
  }
  const outside = rows * cols - usedR * usedC;
  return outside > 0 && pairs.every(p => p.test(null)) ? outside : 0;
}

/* ── Math ──────────────────────────────────────── */

/** Excel's rounding: half away from zero, without float noise @param {number} n @param {number} places */
export function round(n, places) {
  const f = Math.pow(10, places);
  const v = Math.round(Number((Math.abs(n) * f).toPrecision(15))) / f;
  return n < 0 ? -v : v;
}
/** @param {number} n */
const finite = n => (Number.isFinite(n) ? n : err(ERR.NUM, 'The result isn\'t a finite number'));

/**
 * Sum and count of numbers in a large range of data-only columns, from the
 * running totals the recalculation keeps (calc.js) — or null to do it cell by cell.
 * @param {any} a @param {Ctx} c @returns {{ sum: number, count: number } | CellError | null}
 */
function fastSumCount(a, c) {
  const stats = /** @type {any} */ (c).colStats;
  if (!(a instanceof RangeRef) || !stats || a.rows < 256 || a.cols > 64) return null;
  let sum = 0, count = 0;
  for (let col = a.c1; col <= a.c2; col++) {
    const st = stats(a.sheet, col);
    if (!st) return null;
    const lo = Math.min(a.r1, st.rows), hi = Math.min(a.r2 + 1, st.rows);
    if (hi <= lo) continue;
    if (st.errs[hi] - st.errs[lo] > 0) { for (let r = lo; r < hi; r++) if (st.errAt.has(r)) return st.errAt.get(r); }
    sum += st.sum[hi] - st.sum[lo];
    count += st.count[hi] - st.count[lo];
  }
  return { sum, count };
}
/** Sum and count over all arguments, using fastSumCount where it can @param {any[]} args @param {Ctx} c */
function sumCount(args, c) {
  let sum = 0, count = 0;
  /** @type {any[]} */
  const rest = [];
  for (const a of args) {
    const f = fastSumCount(a, c);
    if (f instanceof CellError) throw f;
    if (f) { sum += f.sum; count += f.count; } else rest.push(a);
  }
  for (const x of numbers(rest, c)) { sum += x; count++; }
  return { sum, count };
}
define('SUM', { category: 'Math', args: 'number1, [number2], …', summary: 'Adds numbers', fn: (a, c) => finite(sumCount(a, c).sum) });
define('PRODUCT', { category: 'Math', args: 'number1, …', summary: 'Multiplies numbers', fn: (a, c) => { const n = numbers(a, c); return finite(n.length ? n.reduce((s, x) => s * x, 1) : 0); } });
define('SUMSQ', { category: 'Math', args: 'number1, …', summary: 'Sum of squares', fn: (a, c) => finite(numbers(a, c).reduce((s, x) => s + x * x, 0)) });
define('ABS', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => Math.abs(ok(num(a[0], c))) });
define('ROUND', { category: 'Math', min: 2, max: 2, args: 'number, digits', summary: 'Rounds half away from zero', fn: (a, c) => round(ok(num(a[0], c)), Math.trunc(ok(num(a[1], c)))) });
define('ROUNDUP', { category: 'Math', min: 2, max: 2, args: 'number, digits', fn: (a, c) => { const n = ok(num(a[0], c)), f = Math.pow(10, Math.trunc(ok(num(a[1], c)))); const v = Math.ceil(Number((Math.abs(n) * f).toPrecision(15))) / f; return n < 0 ? -v : v; } });
define('ROUNDDOWN', { category: 'Math', min: 2, max: 2, args: 'number, digits', fn: (a, c) => { const n = ok(num(a[0], c)), f = Math.pow(10, Math.trunc(ok(num(a[1], c)))); const v = Math.floor(Number((Math.abs(n) * f).toPrecision(15))) / f; return n < 0 ? -v : v; } });
define('TRUNC', { category: 'Math', min: 1, max: 2, args: 'number, [digits]', fn: (a, c) => { const n = ok(num(a[0], c)), f = Math.pow(10, Math.trunc(ok(optNum(a[1], c)))); const v = Math.floor(Number((Math.abs(n) * f).toPrecision(15))) / f; return n < 0 ? -v : v; } });
define('INT', { category: 'Math', min: 1, max: 1, args: 'number', summary: 'Rounds down to an integer', fn: (a, c) => Math.floor(ok(num(a[0], c))) });
define('MOD', { category: 'Math', min: 2, max: 2, args: 'number, divisor', fn: (a, c) => { const n = ok(num(a[0], c)), d = ok(num(a[1], c)); if (d === 0) return err(ERR.DIV0); return round(n - d * Math.floor(n / d), 12); } });
define('POWER', { category: 'Math', min: 2, max: 2, args: 'number, power', fn: (a, c) => { const x = ok(num(a[0], c)), y = ok(num(a[1], c)); if (x === 0 && y < 0) return err(ERR.DIV0); return finite(Math.pow(x, y)); } });
define('SQRT', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => { const x = ok(num(a[0], c)); return x < 0 ? err(ERR.NUM, 'Square root of a negative number') : Math.sqrt(x); } });
define('EXP', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => finite(Math.exp(ok(num(a[0], c)))) });
define('LN', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => { const x = ok(num(a[0], c)); return x <= 0 ? err(ERR.NUM) : Math.log(x); } });
define('LOG10', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => { const x = ok(num(a[0], c)); return x <= 0 ? err(ERR.NUM) : Math.log10(x); } });
define('LOG', { category: 'Math', min: 1, max: 2, args: 'number, [base]', fn: (a, c) => { const x = ok(num(a[0], c)), b = ok(optNum(a[1], c, 10)); if (x <= 0 || b <= 0 || b === 1) return err(ERR.NUM); return Math.log(x) / Math.log(b); } });
define('PI', { category: 'Math', min: 0, max: 0, fn: () => Math.PI });
define('SIGN', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => Math.sign(ok(num(a[0], c))) });
many(['CEILING', 'CEILING.MATH'], { category: 'Math', min: 1, max: 3, args: 'number, [significance]', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => { const x = ok(num(a[0], c)), s = Math.abs(ok(optNum(a[1], c, 1))); if (s === 0) return 0; return round(Math.ceil(Number((x / s).toPrecision(15))) * s, 12); } });
many(['FLOOR', 'FLOOR.MATH'], { category: 'Math', min: 1, max: 3, args: 'number, [significance]', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => { const x = ok(num(a[0], c)), s = Math.abs(ok(optNum(a[1], c, 1))); if (s === 0) return 0; return round(Math.floor(Number((x / s).toPrecision(15))) * s, 12); } });
define('MROUND', { category: 'Math', min: 2, max: 2, args: 'number, multiple', fn: (a, c) => { const x = ok(num(a[0], c)), m = ok(num(a[1], c)); if (m === 0) return 0; if (Math.sign(x) * Math.sign(m) < 0) return err(ERR.NUM); return round(round(x / m, 0) * m, 12); } });
define('FACT', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => { const n = Math.trunc(ok(num(a[0], c))); if (n < 0) return err(ERR.NUM); let r = 1; for (let i = 2; i <= n; i++) r *= i; return finite(r); } });
define('COMBIN', { category: 'Math', min: 2, max: 2, args: 'n, k', fn: (a, c) => { const n = Math.trunc(ok(num(a[0], c))), k = Math.trunc(ok(num(a[1], c))); if (n < 0 || k < 0 || k > n) return err(ERR.NUM); let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); } });
define('EVEN', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => { const x = ok(num(a[0], c)); const v = Math.ceil(Math.abs(x) / 2) * 2; return x < 0 ? -v : v; } });
define('ODD', { category: 'Math', min: 1, max: 1, args: 'number', fn: (a, c) => { const x = ok(num(a[0], c)); let v = Math.ceil(Math.abs(x)); if (v % 2 === 0) v += 1; return x < 0 ? -v : v; } });
define('RAND', { category: 'Math', min: 0, max: 0, volatile: true, summary: 'A random number between 0 and 1', fn: (a, c) => (c.random || Math.random)() });
define('RANDBETWEEN', { category: 'Math', min: 2, max: 2, volatile: true, args: 'bottom, top', fn: (a, c) => { const lo = Math.ceil(ok(num(a[0], c))), hi = Math.floor(ok(num(a[1], c))); if (lo > hi) return err(ERR.NUM); return lo + Math.floor((c.random || Math.random)() * (hi - lo + 1)); } });
define('SUMPRODUCT', { category: 'Math', min: 1, args: 'array1, [array2], …', summary: 'Multiplies matching items and adds them', fn: (a) => {
  const ms = a.map(matrixOf);
  const rows = ms[0].length, cols = ms[0][0] ? ms[0][0].length : 0;
  const dims = a.map(x => (x instanceof RangeRef || x instanceof ArrayValue ? [x.rows, x.cols] : [1, 1]));
  if (dims.some(d => d[0] !== dims[0][0] || d[1] !== dims[0][1])) return err(ERR.VALUE, 'The arrays must be the same size');
  let s = 0;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    let p = 1;
    for (const m of ms) { const v = m[i] ? m[i][j] : null; if (v instanceof CellError) return v; p *= typeof v === 'number' ? v : 0; }
    s += p;
  }
  return s;
} });

/* ── Statistics ────────────────────────────────── */

define('AVERAGE', { category: 'Statistics', min: 1, args: 'number1, …', summary: 'The mean', fn: (a, c) => { const r = sumCount(a, c); return r.count ? r.sum / r.count : err(ERR.DIV0, 'No numbers to average'); } });
define('AVERAGEA', { category: 'Statistics', min: 1, args: 'value1, …', fn: (a, c) => { const n = numbers(a, c, { textAsZero: true }); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : err(ERR.DIV0); } });
define('COUNT', { category: 'Statistics', args: 'value1, …', summary: 'Counts numbers', fn: (a, c) => {
  let n = 0;
  for (const v of a) {
    const f = fastSumCount(v, c);
    if (f && !(f instanceof CellError)) { n += f.count; continue; }
    if (isRangeLike(v)) v.each(x => { if (typeof x === 'number') n++; });
    else if (typeof v === 'number' || (typeof v === 'string' && textToNumber(v) !== null) || typeof v === 'boolean') n++;
  }
  return n;
} });
define('COUNTA', { category: 'Statistics', args: 'value1, …', summary: 'Counts non-empty values', fn: (a) => { let n = 0; for (const v of a) { if (isRangeLike(v)) v.each(() => { n++; }); else if (v !== null && v !== undefined) n++; } return n; } });
define('COUNTBLANK', { category: 'Statistics', min: 1, max: 1, args: 'range', fn: (a) => {
  const r = a[0];
  if (!(r instanceof RangeRef)) return isBlank(r) || r === '' ? 1 : 0;
  let filled = 0;
  r.each(v => { if (v !== '') filled++; });
  return r.rows * r.cols - filled;
} });
define('MAX', { category: 'Statistics', args: 'number1, …', fn: (a, c) => { const n = numbers(a, c); return n.length ? n.reduce((m, x) => (x > m ? x : m), -Infinity) : 0; } });
define('MIN', { category: 'Statistics', args: 'number1, …', fn: (a, c) => { const n = numbers(a, c); return n.length ? n.reduce((m, x) => (x < m ? x : m), Infinity) : 0; } });
define('MEDIAN', { category: 'Statistics', min: 1, args: 'number1, …', fn: (a, c) => { const n = numbers(a, c).sort((x, y) => x - y); if (!n.length) return err(ERR.NUM); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; } });
many(['MODE', 'MODE.SNGL'], { category: 'Statistics', min: 1, args: 'number1, …', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => {
  const n = numbers(a, c); const counts = new Map(); let best = null, bestN = 1;
  for (const x of n) { const k = (counts.get(x) || 0) + 1; counts.set(x, k); if (k > bestN) { bestN = k; best = x; } }
  return best === null ? err(ERR.NA, 'No value repeats') : best;
} });
define('LARGE', { category: 'Statistics', min: 2, max: 2, args: 'array, k', fn: (a, c) => { const n = numbers([a[0]], c).sort((x, y) => y - x); const k = Math.ceil(ok(num(a[1], c))); return k < 1 || k > n.length ? err(ERR.NUM) : n[k - 1]; } });
define('SMALL', { category: 'Statistics', min: 2, max: 2, args: 'array, k', fn: (a, c) => { const n = numbers([a[0]], c).sort((x, y) => x - y); const k = Math.ceil(ok(num(a[1], c))); return k < 1 || k > n.length ? err(ERR.NUM) : n[k - 1]; } });
many(['RANK', 'RANK.EQ'], { category: 'Statistics', min: 2, max: 3, args: 'number, ref, [order]', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => {
  const x = ok(num(a[0], c)); const n = numbers([a[1]], c); const asc = ok(optNum(a[2], c)) !== 0;
  if (!n.includes(x)) return err(ERR.NA);
  return 1 + n.filter(v => (asc ? v < x : v > x)).length;
} });
define('RANK.AVG', { category: 'Statistics', min: 2, max: 3, args: 'number, ref, [order]', fn: (a, c) => {
  const x = ok(num(a[0], c)); const n = numbers([a[1]], c); const asc = ok(optNum(a[2], c)) !== 0;
  const ties = n.filter(v => v === x).length; if (!ties) return err(ERR.NA);
  return 1 + n.filter(v => (asc ? v < x : v > x)).length + (ties - 1) / 2;
} });
/** @param {number[]} n @param {number} k */
function percentileInc(n, k) {
  n.sort((x, y) => x - y);
  const pos = (n.length - 1) * k, lo = Math.floor(pos), hi = Math.ceil(pos);
  return n[lo] + (n[hi] - n[lo]) * (pos - lo);
}
many(['PERCENTILE', 'PERCENTILE.INC'], { category: 'Statistics', min: 2, max: 2, args: 'array, k', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => { const n = numbers([a[0]], c); const k = ok(num(a[1], c)); if (!n.length || k < 0 || k > 1) return err(ERR.NUM); return percentileInc(n, k); } });
many(['QUARTILE', 'QUARTILE.INC'], { category: 'Statistics', min: 2, max: 2, args: 'array, quart', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => { const n = numbers([a[0]], c); const q = Math.trunc(ok(num(a[1], c))); if (!n.length || q < 0 || q > 4) return err(ERR.NUM); return percentileInc(n, q / 4); } });
/** @param {number[]} n @param {boolean} sample */
function variance(n, sample) {
  if (n.length < (sample ? 2 : 1)) return err(ERR.DIV0, 'Not enough numbers');
  const m = n.reduce((s, x) => s + x, 0) / n.length;
  return n.reduce((s, x) => s + (x - m) * (x - m), 0) / (n.length - (sample ? 1 : 0));
}
many(['VAR', 'VAR.S'], { category: 'Statistics', min: 1, args: 'number1, …', summary: 'Sample variance', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => variance(numbers(a, c), true) });
many(['VARP', 'VAR.P'], { category: 'Statistics', min: 1, args: 'number1, …', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => variance(numbers(a, c), false) });
many(['STDEV', 'STDEV.S'], { category: 'Statistics', min: 1, args: 'number1, …', summary: 'Sample standard deviation', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => { const v = variance(numbers(a, c), true); return isError(v) ? v : Math.sqrt(v); } });
many(['STDEVP', 'STDEV.P'], { category: 'Statistics', min: 1, args: 'number1, …', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => { const v = variance(numbers(a, c), false); return isError(v) ? v : Math.sqrt(v); } });
/** Paired numbers of two same-sized ranges (pairs with a non-number are skipped) @param {any} x @param {any} y */
function pairs(x, y) {
  const a = vectorOf(x), b = vectorOf(y);
  if (a.length !== b.length) throw err(ERR.NA, 'The ranges must be the same size');
  const out = [];
  const len = Math.max(a.values.length, b.values.length);
  for (let i = 0; i < len; i++) {
    const p = a.values[i], q = b.values[i];
    if (p instanceof CellError) throw p;
    if (q instanceof CellError) throw q;
    if (typeof p === 'number' && typeof q === 'number') out.push([p, q]);
  }
  return out;
}
many(['CORREL', 'PEARSON'], { category: 'Statistics', min: 2, max: 2, args: 'array1, array2', summary: 'Pearson correlation', fn: (/** @type {any[]} */ a) => {
  const p = pairs(a[0], a[1]);
  if (p.length < 2) return err(ERR.DIV0);
  const mx = p.reduce((s, q) => s + q[0], 0) / p.length, my = p.reduce((s, q) => s + q[1], 0) / p.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx === 0 || syy === 0 ? err(ERR.DIV0) : sxy / Math.sqrt(sxx * syy);
} });
many(['COVARIANCE.S', 'COVARIANCE.P', 'COVAR'], { category: 'Statistics', min: 2, max: 2, args: 'array1, array2', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c, /** @type {string} */ name) => {
  const p = pairs(a[0], a[1]);
  if (!p.length) return err(ERR.DIV0);
  const mx = p.reduce((s, q) => s + q[0], 0) / p.length, my = p.reduce((s, q) => s + q[1], 0) / p.length;
  const s = p.reduce((t, q) => t + (q[0] - mx) * (q[1] - my), 0);
  return s / p.length;
} });
FUNCTIONS['COVARIANCE.S'] = Object.assign({}, FUNCTIONS['COVARIANCE.S'], { fn: (/** @type {any[]} */ a) => {
  const p = pairs(a[0], a[1]);
  if (p.length < 2) return err(ERR.DIV0);
  const mx = p.reduce((s, q) => s + q[0], 0) / p.length, my = p.reduce((s, q) => s + q[1], 0) / p.length;
  return p.reduce((t, q) => t + (q[0] - mx) * (q[1] - my), 0) / (p.length - 1);
} });
define('SLOPE', { category: 'Statistics', min: 2, max: 2, args: 'known_y, known_x', fn: (a) => {
  const p = pairs(a[1], a[0]);
  if (p.length < 2) return err(ERR.DIV0);
  const mx = p.reduce((s, q) => s + q[0], 0) / p.length, my = p.reduce((s, q) => s + q[1], 0) / p.length;
  let sxy = 0, sxx = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return sxx === 0 ? err(ERR.DIV0) : sxy / sxx;
} });
define('INTERCEPT', { category: 'Statistics', min: 2, max: 2, args: 'known_y, known_x', fn: (a) => {
  const p = pairs(a[1], a[0]);
  if (p.length < 2) return err(ERR.DIV0);
  const mx = p.reduce((s, q) => s + q[0], 0) / p.length, my = p.reduce((s, q) => s + q[1], 0) / p.length;
  let sxy = 0, sxx = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return sxx === 0 ? err(ERR.DIV0) : my - (sxy / sxx) * mx;
} });
define('GEOMEAN', { category: 'Statistics', min: 1, args: 'number1, …', fn: (a, c) => { const n = numbers(a, c); if (!n.length || n.some(x => x <= 0)) return err(ERR.NUM); return Math.exp(n.reduce((s, x) => s + Math.log(x), 0) / n.length); } });
define('AVEDEV', { category: 'Statistics', min: 1, args: 'number1, …', fn: (a, c) => { const n = numbers(a, c); if (!n.length) return err(ERR.NUM); const m = n.reduce((s, x) => s + x, 0) / n.length; return n.reduce((s, x) => s + Math.abs(x - m), 0) / n.length; } });

/* ── Conditional aggregates ────────────────────── */

define('COUNTIF', { category: 'Statistics', min: 2, max: 2, args: 'range, criterion', summary: 'Counts cells that meet a condition', fn: (a, c) => {
  let n = 0; const extra = eachMatch([{ range: a[0], test: criterion(scalar(a[1], c)) }], () => { n++; }); return n + extra;
} });
define('COUNTIFS', { category: 'Statistics', min: 2, args: 'range1, criterion1, …', fn: (a, c) => {
  if (a.length % 2) return err(ERR.VALUE, 'Give ranges and criteria in pairs');
  const ps = []; for (let i = 0; i < a.length; i += 2) ps.push({ range: a[i], test: criterion(scalar(a[i + 1], c)) });
  let n = 0; const extra = eachMatch(ps, () => { n++; }); return n + extra;
} });
/** @param {any} range @param {number} i @param {number} j */
const cellAt = (range, i, j) => (range instanceof RangeRef || range instanceof ArrayValue ? range.at(i, j) : i === 0 && j === 0 ? range : null);
define('SUMIF', { category: 'Math', min: 2, max: 3, args: 'range, criterion, [sum_range]', summary: 'Adds cells that meet a condition', fn: (a, c) => {
  const target = a[2] === undefined || a[2] === null ? a[0] : a[2];
  let s = 0;
  eachMatch([{ range: a[0], test: criterion(scalar(a[1], c)) }], (i, j) => { const v = cellAt(target, i, j); if (v instanceof CellError) throw v; if (typeof v === 'number') s += v; });
  return s;
} });
define('SUMIFS', { category: 'Math', min: 3, args: 'sum_range, range1, criterion1, …', fn: (a, c) => {
  if ((a.length - 1) % 2) return err(ERR.VALUE, 'Give ranges and criteria in pairs');
  /** @type {{ range: any, test: (v: any) => boolean }[]} */
  const ps = [{ range: a[0], test: () => true }]; for (let i = 1; i < a.length; i += 2) ps.push({ range: a[i], test: criterion(scalar(a[i + 1], c)) });
  let s = 0;
  eachMatch(ps, (i, j) => { const v = cellAt(a[0], i, j); if (v instanceof CellError) throw v; if (typeof v === 'number') s += v; });
  return s;
} });
define('AVERAGEIF', { category: 'Statistics', min: 2, max: 3, args: 'range, criterion, [average_range]', fn: (a, c) => {
  const target = a[2] === undefined || a[2] === null ? a[0] : a[2];
  let s = 0, n = 0;
  eachMatch([{ range: a[0], test: criterion(scalar(a[1], c)) }], (i, j) => { const v = cellAt(target, i, j); if (v instanceof CellError) throw v; if (typeof v === 'number') { s += v; n++; } });
  return n ? s / n : err(ERR.DIV0, 'No cells meet the condition');
} });
define('AVERAGEIFS', { category: 'Statistics', min: 3, args: 'average_range, range1, criterion1, …', fn: (a, c) => {
  /** @type {{ range: any, test: (v: any) => boolean }[]} */
  const ps = [{ range: a[0], test: () => true }]; for (let i = 1; i < a.length; i += 2) ps.push({ range: a[i], test: criterion(scalar(a[i + 1], c)) });
  let s = 0, n = 0;
  eachMatch(ps, (i, j) => { const v = cellAt(a[0], i, j); if (v instanceof CellError) throw v; if (typeof v === 'number') { s += v; n++; } });
  return n ? s / n : err(ERR.DIV0, 'No cells meet the conditions');
} });
many(['MAXIFS', 'MINIFS'], { category: 'Statistics', min: 3, args: 'range, range1, criterion1, …', fn: (/** @type {any[]} */ a, /** @type {Ctx} */ c) => { throw err(ERR.VALUE); } });
for (const [name, pick] of /** @type {[string, (x: number, y: number) => boolean][]} */ ([['MAXIFS', (x, y) => x > y], ['MINIFS', (x, y) => x < y]])) {
  FUNCTIONS[name].fn = (/** @type {any[]} */ a, /** @type {Ctx} */ c) => {
    /** @type {{ range: any, test: (v: any) => boolean }[]} */
  const ps = [{ range: a[0], test: () => true }]; for (let i = 1; i < a.length; i += 2) ps.push({ range: a[i], test: criterion(scalar(a[i + 1], c)) });
    /** @type {number | null} */
    let best = null;
    eachMatch(ps, (i, j) => { const v = cellAt(a[0], i, j); if (v instanceof CellError) throw v; if (typeof v === 'number' && (best === null || pick(v, best))) best = v; });
    return best === null ? 0 : best;
  };
}

/* ── Logic ─────────────────────────────────────── */

define('IF', { category: 'Logical', lazy: true, min: 1, max: 3, args: 'condition, [if_true], [if_false]', summary: 'Picks a value by a condition', fn: (t, c) => {
  const cond = bool(t[0](), c);
  if (isError(cond)) return cond;
  if (cond) return t.length > 1 ? scalarOrRange(t[1]()) : true;
  return t.length > 2 ? scalarOrRange(t[2]()) : false;
} });
/** @param {any} v */
const scalarOrRange = v => (v === null ? 0 : v);
define('IFS', { category: 'Logical', lazy: true, min: 2, args: 'condition1, value1, …', fn: (t, c) => {
  if (t.length % 2) return err(ERR.VALUE, 'Give conditions and values in pairs');
  for (let i = 0; i < t.length; i += 2) { const cond = bool(t[i](), c); if (isError(cond)) return cond; if (cond) return scalarOrRange(t[i + 1]()); }
  return err(ERR.NA, 'No condition was true');
} });
define('IFERROR', { category: 'Logical', lazy: true, min: 2, max: 2, args: 'value, value_if_error', fn: (t, c) => { const v = scalar(t[0](), c); return isError(v) ? scalarOrRange(t[1]()) : scalarOrRange(v); } });
define('IFNA', { category: 'Logical', lazy: true, min: 2, max: 2, args: 'value, value_if_na', fn: (t, c) => { const v = scalar(t[0](), c); return isError(v) && v.code === ERR.NA ? scalarOrRange(t[1]()) : scalarOrRange(v); } });
/** Booleans of the arguments for AND / OR / XOR @param {any[]} a @param {Ctx} c */
function bools(a, c) {
  const out = [];
  for (const v of a) {
    if (isRangeLike(v)) v.each(x => { if (x instanceof CellError) throw x; if (typeof x === 'boolean') out.push(x); else if (typeof x === 'number') out.push(x !== 0); });
    else if (v !== null && v !== undefined) out.push(ok(toBool(v)));
  }
  if (!out.length) throw err(ERR.VALUE, 'No TRUE/FALSE values');
  return out;
}
define('AND', { category: 'Logical', min: 1, args: 'logical1, …', fn: (a, c) => bools(a, c).every(Boolean) });
define('OR', { category: 'Logical', min: 1, args: 'logical1, …', fn: (a, c) => bools(a, c).some(Boolean) });
define('XOR', { category: 'Logical', min: 1, args: 'logical1, …', fn: (a, c) => bools(a, c).filter(Boolean).length % 2 === 1 });
define('NOT', { category: 'Logical', min: 1, max: 1, args: 'logical', fn: (a, c) => { const b = bool(a[0], c); return isError(b) ? b : !b; } });
define('TRUE', { category: 'Logical', min: 0, max: 0, fn: () => true });
define('FALSE', { category: 'Logical', min: 0, max: 0, fn: () => false });
define('SWITCH', { category: 'Logical', lazy: true, min: 3, args: 'expression, value1, result1, …, [default]', fn: (t, c) => {
  const x = scalar(t[0](), c);
  if (isError(x)) return x;
  for (let i = 1; i + 1 < t.length; i += 2) { const v = scalar(t[i](), c); if (compareValues(x, v) === 0 && typeof x === typeof v) return scalarOrRange(t[i + 1]()); }
  return t.length % 2 === 0 ? scalarOrRange(t[t.length - 1]()) : err(ERR.NA, 'No value matched');
} });

/* ── Text ──────────────────────────────────────── */

define('CONCATENATE', { category: 'Text', min: 1, args: 'text1, …', fn: (a, c) => a.map(v => ok(txt(v, c))).join('') });
define('CONCAT', { category: 'Text', min: 1, args: 'text1, …', fn: (a) => flatValues(a).map(v => ok(toText(v))).join('') });
define('TEXTJOIN', { category: 'Text', min: 3, args: 'delimiter, ignore_empty, text1, …', summary: 'Joins text with a delimiter', fn: (a, c) => {
  const d = ok(txt(a[0], c)), skip = ok(bool(a[1], c));
  const parts = [];
  for (const v of a.slice(2)) {
    if (isRangeLike(v)) {
      const m = matrixOf(v);
      for (const row of m) for (const x of row) { const s = ok(toText(x)); if (!(skip && s === '')) parts.push(s); }
    } else { const s = ok(toText(v)); if (!(skip && s === '')) parts.push(s); }
  }
  return parts.join(d);
} });
define('LEFT', { category: 'Text', min: 1, max: 2, args: 'text, [count]', fn: (a, c) => { const s = ok(txt(a[0], c)), n = Math.trunc(ok(optNum(a[1], c, 1))); return n < 0 ? err(ERR.VALUE) : Array.from(s).slice(0, n).join(''); } });
define('RIGHT', { category: 'Text', min: 1, max: 2, args: 'text, [count]', fn: (a, c) => { const s = Array.from(ok(txt(a[0], c))), n = Math.trunc(ok(optNum(a[1], c, 1))); return n < 0 ? err(ERR.VALUE) : n === 0 ? '' : s.slice(-n).join(''); } });
define('MID', { category: 'Text', min: 3, max: 3, args: 'text, start, count', fn: (a, c) => { const s = Array.from(ok(txt(a[0], c))), st = Math.trunc(ok(num(a[1], c))), n = Math.trunc(ok(num(a[2], c))); if (st < 1 || n < 0) return err(ERR.VALUE); return s.slice(st - 1, st - 1 + n).join(''); } });
define('LEN', { category: 'Text', min: 1, max: 1, args: 'text', fn: (a, c) => Array.from(ok(txt(a[0], c))).length });
define('UPPER', { category: 'Text', min: 1, max: 1, args: 'text', fn: (a, c) => ok(txt(a[0], c)).toUpperCase() });
define('LOWER', { category: 'Text', min: 1, max: 1, args: 'text', fn: (a, c) => ok(txt(a[0], c)).toLowerCase() });
define('PROPER', { category: 'Text', min: 1, max: 1, args: 'text', fn: (a, c) => ok(txt(a[0], c)).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, p, l) => p + l.toUpperCase()) });
define('TRIM', { category: 'Text', min: 1, max: 1, args: 'text', summary: 'Removes extra spaces', fn: (a, c) => ok(txt(a[0], c)).replace(/ +/g, ' ').trim() });
define('CLEAN', { category: 'Text', min: 1, max: 1, args: 'text', fn: (a, c) => ok(txt(a[0], c)).replace(/[\u0000-\u001F]/g, '') });
define('SUBSTITUTE', { category: 'Text', min: 3, max: 4, args: 'text, old, new, [instance]', fn: (a, c) => {
  const s = ok(txt(a[0], c)), o = ok(txt(a[1], c)), n = ok(txt(a[2], c));
  if (!o) return s;
  if (a[3] === undefined) return s.split(o).join(n);
  const k = Math.trunc(ok(num(a[3], c))); if (k < 1) return err(ERR.VALUE);
  let idx = -1; for (let i = 0; i < k; i++) { idx = s.indexOf(o, idx + 1); if (idx < 0) return s; }
  return s.slice(0, idx) + n + s.slice(idx + o.length);
} });
define('REPLACE', { category: 'Text', min: 4, max: 4, args: 'text, start, count, new_text', fn: (a, c) => { const s = Array.from(ok(txt(a[0], c))), st = Math.trunc(ok(num(a[1], c))), n = Math.trunc(ok(num(a[2], c))); if (st < 1 || n < 0) return err(ERR.VALUE); return s.slice(0, st - 1).join('') + ok(txt(a[3], c)) + s.slice(st - 1 + n).join(''); } });
define('FIND', { category: 'Text', min: 2, max: 3, args: 'find, within, [start]', summary: 'Position of text (case-sensitive)', fn: (a, c) => { const f = ok(txt(a[0], c)), s = ok(txt(a[1], c)), st = Math.trunc(ok(optNum(a[2], c, 1))); if (st < 1 || st > s.length + 1) return err(ERR.VALUE); const i = s.indexOf(f, st - 1); return i < 0 ? err(ERR.VALUE, '"' + f + '" wasn\'t found') : i + 1; } });
define('SEARCH', { category: 'Text', min: 2, max: 3, args: 'find, within, [start]', summary: 'Position of text (any case, wildcards)', fn: (a, c) => {
  const f = ok(txt(a[0], c)), s = ok(txt(a[1], c)), st = Math.trunc(ok(optNum(a[2], c, 1)));
  if (st < 1 || st > s.length + 1) return err(ERR.VALUE);
  const re = new RegExp(wildcardRegex(f).source.slice(1, -1), 'i');
  const m = re.exec(s.slice(st - 1));
  return m ? m.index + st : err(ERR.VALUE, '"' + f + '" wasn\'t found');
} });
define('TEXT', { category: 'Text', min: 2, max: 2, args: 'value, format', summary: 'Formats a number as text', fn: (a, c) => { const v = scalar(a[0], c); if (isError(v)) return v; const f = ok(txt(a[1], c)); const n = typeof v === 'string' ? (textToNumber(v) === null ? v : textToNumber(v)) : v; return formatValue(n, f).text; } });
define('VALUE', { category: 'Text', min: 1, max: 1, args: 'text', fn: (a, c) => { const v = scalar(a[0], c); if (typeof v === 'number') return v; if (isError(v)) return v; const n = textToNumber(ok(toText(v))); return n === null ? err(ERR.VALUE) : n; } });
define('REPT', { category: 'Text', min: 2, max: 2, args: 'text, times', fn: (a, c) => { const s = ok(txt(a[0], c)), n = Math.trunc(ok(num(a[1], c))); if (n < 0 || s.length * n > 32767) return err(ERR.VALUE); return s.repeat(n); } });
define('EXACT', { category: 'Text', min: 2, max: 2, args: 'text1, text2', fn: (a, c) => ok(txt(a[0], c)) === ok(txt(a[1], c)) });
define('CHAR', { category: 'Text', min: 1, max: 1, args: 'number', fn: (a, c) => { const n = Math.trunc(ok(num(a[0], c))); return n < 1 || n > 255 ? err(ERR.VALUE) : String.fromCharCode(n); } });
define('UNICHAR', { category: 'Text', min: 1, max: 1, args: 'number', fn: (a, c) => { const n = Math.trunc(ok(num(a[0], c))); return n < 1 || n > 0x10FFFF ? err(ERR.VALUE) : String.fromCodePoint(n); } });
define('CODE', { category: 'Text', min: 1, max: 1, args: 'text', fn: (a, c) => { const s = ok(txt(a[0], c)); return s ? /** @type {number} */ (s.codePointAt(0)) : err(ERR.VALUE); } });
define('T', { category: 'Text', min: 1, max: 1, args: 'value', fn: (a, c) => { const v = scalar(a[0], c); return typeof v === 'string' ? v : isError(v) ? v : ''; } });
define('N', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => { const v = scalar(a[0], c); return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : isError(v) ? v : 0; } });
define('TEXTBEFORE', { category: 'Text', min: 2, max: 3, args: 'text, delimiter, [instance]', fn: (a, c) => { const s = ok(txt(a[0], c)), d = ok(txt(a[1], c)), k = Math.trunc(ok(optNum(a[2], c, 1))); const parts = s.split(d); if (parts.length - 1 < Math.abs(k) || k === 0) return err(ERR.NA); return k > 0 ? parts.slice(0, k).join(d) : parts.slice(0, parts.length + k).join(d); } });
define('TEXTAFTER', { category: 'Text', min: 2, max: 3, args: 'text, delimiter, [instance]', fn: (a, c) => { const s = ok(txt(a[0], c)), d = ok(txt(a[1], c)), k = Math.trunc(ok(optNum(a[2], c, 1))); const parts = s.split(d); if (parts.length - 1 < Math.abs(k) || k === 0) return err(ERR.NA); return k > 0 ? parts.slice(k).join(d) : parts.slice(parts.length + k).join(d); } });

/* ── Dates and times ───────────────────────────── */

/** A date argument: a serial, or text that reads as a date @param {any} v @param {Ctx} c */
function dateArg(v, c) {
  const x = scalar(v, c);
  if (typeof x === 'string') { const d = parseDateText(x); if (d === null) throw err(ERR.VALUE, '"' + x + '" isn\'t a date'); return d; }
  const n = ok(toNumber(x));
  if (n < 0) throw err(ERR.NUM);
  return n;
}
/** The local date/time now, as a serial @param {Ctx} c */
function nowSerial(c) {
  const d = new Date(c.now ? c.now() : Date.now());
  return dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()) + timeToSerial(d.getHours(), d.getMinutes(), d.getSeconds());
}
define('DATE', { category: 'Date', min: 3, max: 3, args: 'year, month, day', fn: (a, c) => { const y = Math.trunc(ok(num(a[0], c))), m = Math.trunc(ok(num(a[1], c))), d = Math.trunc(ok(num(a[2], c))); if (y < 0 || y > 9999) return err(ERR.NUM); const s = dateToSerial(y, m, d); return s < 0 ? err(ERR.NUM) : s; } });
define('TIME', { category: 'Date', min: 3, max: 3, args: 'hour, minute, second', fn: (a, c) => { const t = timeToSerial(ok(num(a[0], c)), ok(num(a[1], c)), ok(num(a[2], c))); return t < 0 ? err(ERR.NUM) : t - Math.floor(t); } });
define('TODAY', { category: 'Date', min: 0, max: 0, volatile: true, summary: 'Today\'s date', fn: (a, c) => Math.floor(nowSerial(c)) });
define('NOW', { category: 'Date', min: 0, max: 0, volatile: true, summary: 'The date and time now', fn: (a, c) => nowSerial(c) });
define('YEAR', { category: 'Date', min: 1, max: 1, args: 'date', fn: (a, c) => serialToParts(dateArg(a[0], c)).y });
define('MONTH', { category: 'Date', min: 1, max: 1, args: 'date', fn: (a, c) => serialToParts(dateArg(a[0], c)).m });
define('DAY', { category: 'Date', min: 1, max: 1, args: 'date', fn: (a, c) => serialToParts(dateArg(a[0], c)).d });
define('HOUR', { category: 'Date', min: 1, max: 1, args: 'time', fn: (a, c) => serialToParts(dateArg(a[0], c)).h });
define('MINUTE', { category: 'Date', min: 1, max: 1, args: 'time', fn: (a, c) => serialToParts(dateArg(a[0], c)).mi });
define('SECOND', { category: 'Date', min: 1, max: 1, args: 'time', fn: (a, c) => serialToParts(dateArg(a[0], c)).s });
define('WEEKDAY', { category: 'Date', min: 1, max: 2, args: 'date, [type]', fn: (a, c) => {
  const wd = serialToParts(dateArg(a[0], c)).wd, t = Math.trunc(ok(optNum(a[1], c, 1)));
  if (t === 1 || t === 17) return wd + 1;
  if (t === 2 || t === 11) return ((wd + 6) % 7) + 1;
  if (t === 3) return (wd + 6) % 7;
  if (t >= 12 && t <= 16) return ((wd - (t - 10) + 7) % 7) + 1;
  return err(ERR.NUM);
} });
define('WEEKNUM', { category: 'Date', min: 1, max: 2, args: 'date, [type]', fn: (a, c) => {
  const s = Math.floor(dateArg(a[0], c)), t = Math.trunc(ok(optNum(a[1], c, 1)));
  const p = serialToParts(s);
  const jan1 = dateToSerial(p.y, 1, 1);
  const startDay = t === 2 ? 1 : 0;              // week starts Sunday (1) or Monday (2)
  const offset = (serialToParts(jan1).wd - startDay + 7) % 7;
  return Math.floor((s - jan1 + offset) / 7) + 1;
} });
define('EDATE', { category: 'Date', min: 2, max: 2, args: 'start, months', fn: (a, c) => { const p = serialToParts(dateArg(a[0], c)), m = Math.trunc(ok(num(a[1], c))); const last = new Date(Date.UTC(p.y, p.m - 1 + m + 1, 0)).getUTCDate(); return dateToSerial(p.y, p.m + m, Math.min(p.d, last)); } });
define('EOMONTH', { category: 'Date', min: 2, max: 2, args: 'start, months', fn: (a, c) => { const p = serialToParts(dateArg(a[0], c)), m = Math.trunc(ok(num(a[1], c))); return dateToSerial(p.y, p.m + m + 1, 0); } });
define('DAYS', { category: 'Date', min: 2, max: 2, args: 'end, start', fn: (a, c) => Math.floor(dateArg(a[0], c)) - Math.floor(dateArg(a[1], c)) });
define('DATEDIF', { category: 'Date', min: 3, max: 3, args: 'start, end, unit', summary: 'Difference in years, months or days', fn: (a, c) => {
  const s = Math.floor(dateArg(a[0], c)), e = Math.floor(dateArg(a[1], c)), u = ok(txt(a[2], c)).toUpperCase();
  if (s > e) return err(ERR.NUM);
  const p = serialToParts(s), q = serialToParts(e);
  let months = (q.y - p.y) * 12 + (q.m - p.m); if (q.d < p.d) months--;
  if (u === 'D') return e - s;
  if (u === 'M') return months;
  if (u === 'Y') return Math.floor(months / 12);
  if (u === 'YM') return months % 12;
  if (u === 'MD') { let d = q.d - p.d; if (d < 0) d += new Date(Date.UTC(q.y, q.m - 1, 0)).getUTCDate(); return d; }
  if (u === 'YD') { const anniv = dateToSerial(q.y, p.m, p.d); return anniv <= e ? e - anniv : e - dateToSerial(q.y - 1, p.m, p.d); }
  return err(ERR.NUM);
} });
define('DATEVALUE', { category: 'Date', min: 1, max: 1, args: 'text', fn: (a, c) => { const s = ok(txt(a[0], c)); const d = parseDateText(s); return d === null ? err(ERR.VALUE) : Math.floor(d); } });
define('TIMEVALUE', { category: 'Date', min: 1, max: 1, args: 'text', fn: (a, c) => { const s = ok(txt(a[0], c)); const d = parseDateText(s); return d === null ? err(ERR.VALUE) : d - Math.floor(d); } });
define('NETWORKDAYS', { category: 'Date', min: 2, max: 3, args: 'start, end, [holidays]', fn: (a, c) => {
  let s = Math.floor(dateArg(a[0], c)), e = Math.floor(dateArg(a[1], c)), sign = 1;
  if (s > e) { [s, e] = [e, s]; sign = -1; }
  const hol = new Set(a[2] === undefined ? [] : numbers([a[2]], c).map(Math.floor));
  if (e - s > 400000) return err(ERR.NUM);
  let n = 0;
  for (let d = s; d <= e; d++) { const wd = serialToParts(d).wd; if (wd !== 0 && wd !== 6 && !hol.has(d)) n++; }
  return sign * n;
} });
define('WORKDAY', { category: 'Date', min: 2, max: 3, args: 'start, days, [holidays]', fn: (a, c) => {
  let d = Math.floor(dateArg(a[0], c)); let k = Math.trunc(ok(num(a[1], c)));
  const hol = new Set(a[2] === undefined ? [] : numbers([a[2]], c).map(Math.floor));
  const step = k < 0 ? -1 : 1; k = Math.abs(k);
  if (k > 100000) return err(ERR.NUM);
  while (k > 0) { d += step; const wd = serialToParts(d).wd; if (wd !== 0 && wd !== 6 && !hol.has(d)) k--; }
  return d;
} });

/* ── Lookup ────────────────────────────────────── */

/** @param {any} lookup @param {any} v */
function sameValue(lookup, v) {
  if (typeof lookup === 'string' && typeof v === 'string') return /[*?~]/.test(lookup) ? wildcardRegex(lookup).test(v) : lookup.toLowerCase() === v.toLowerCase();
  return compareValues(lookup, v) === 0 && typeof lookup === typeof v;
}
/**
 * Position of a value in a list (0-based) or -1.
 * mode 0 exact, 1 largest ≤ (ascending), -1 smallest ≥ (descending)
 * @param {any} x @param {any[]} list @param {number} mode
 */
function findIndex(x, list, mode) {
  if (mode === 0) return list.findIndex(v => v !== null && v !== undefined && sameValue(x, v));
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v === null || v === undefined || typeof v !== typeof x) continue;
    const c = compareValues(v, x);
    if (mode === 1) { if (c <= 0) best = i; else break; }
    else { if (c >= 0) best = i; else break; }
  }
  return best;
}
define('VLOOKUP', { category: 'Lookup', min: 3, max: 4, args: 'value, table, column, [approximate]', summary: 'Looks a value up in the first column', fn: (a, c) => {
  const x = scalar(a[0], c); if (isError(x)) return x;
  const t = a[1]; if (!isRangeLike(t)) return err(ERR.VALUE);
  const col = Math.trunc(ok(num(a[2], c)));
  if (col < 1) return err(ERR.VALUE); if (col > t.cols) return err(ERR.REF);
  const approx = a[3] === undefined ? true : ok(bool(a[3], c));
  const first = []; const rows = t instanceof RangeRef ? Math.min(t.rows, t.usedRows()) : t.rows;
  for (let i = 0; i < rows; i++) first.push(t.at(i, 0));
  const i = findIndex(x, first, approx ? 1 : 0);
  return i < 0 ? err(ERR.NA, 'Not found') : scalarOrBlank(t.at(i, col - 1));
} });
define('HLOOKUP', { category: 'Lookup', min: 3, max: 4, args: 'value, table, row, [approximate]', fn: (a, c) => {
  const x = scalar(a[0], c); if (isError(x)) return x;
  const t = a[1]; if (!isRangeLike(t)) return err(ERR.VALUE);
  const row = Math.trunc(ok(num(a[2], c)));
  if (row < 1) return err(ERR.VALUE); if (row > t.rows) return err(ERR.REF);
  const approx = a[3] === undefined ? true : ok(bool(a[3], c));
  const first = []; const cols = t instanceof RangeRef ? Math.min(t.cols, t.usedCols()) : t.cols;
  for (let j = 0; j < cols; j++) first.push(t.at(0, j));
  const j = findIndex(x, first, approx ? 1 : 0);
  return j < 0 ? err(ERR.NA, 'Not found') : scalarOrBlank(t.at(row - 1, j));
} });
/** A blank cell read by a lookup is 0, as in Excel @param {any} v */
const scalarOrBlank = v => (v === null || v === undefined ? 0 : v);
define('MATCH', { category: 'Lookup', min: 2, max: 3, args: 'value, range, [type]', summary: 'Position of a value in a range', fn: (a, c) => {
  const x = scalar(a[0], c); if (isError(x)) return x;
  const { values } = vectorOf(a[1]);
  const t = Math.trunc(ok(optNum(a[2], c, 1)));
  const i = findIndex(x, values, t === 0 ? 0 : t > 0 ? 1 : -1);
  return i < 0 ? err(ERR.NA, 'Not found') : i + 1;
} });
define('XLOOKUP', { category: 'Lookup', min: 3, max: 6, args: 'value, lookup_range, return_range, [if_not_found], [match_mode], [search_mode]', fn: (a, c) => {
  const x = scalar(a[0], c); if (isError(x)) return x;
  const look = vectorOf(a[1]).values, ret = a[2];
  const mm = Math.trunc(ok(optNum(a[4], c, 0))), sm = Math.trunc(ok(optNum(a[5], c, 1)));
  const order = look.map((/** @type {any} */ v, /** @type {number} */ i) => i); if (sm < 0) order.reverse();
  let hit = -1;
  if (mm === 0 || mm === 2) hit = order.find((/** @type {number} */ i) => look[i] !== null && look[i] !== undefined && (mm === 2 ? sameValue(x, look[i]) : (typeof x === 'string' && typeof look[i] === 'string' ? x.toLowerCase() === look[i].toLowerCase() : compareValues(x, look[i]) === 0 && typeof x === typeof look[i]))) ?? -1;
  else {
    let best = -1;
    for (const i of order) {
      const v = look[i]; if (v === null || v === undefined || typeof v !== typeof x) continue;
      const cmp = compareValues(v, x);
      if (cmp === 0) { best = i; break; }
      if (mm === -1 && cmp < 0 && (best < 0 || compareValues(v, look[best]) > 0)) best = i;
      if (mm === 1 && cmp > 0 && (best < 0 || compareValues(v, look[best]) < 0)) best = i;
    }
    hit = best;
  }
  if (hit < 0) return a[3] === undefined || a[3] === null ? err(ERR.NA, 'Not found') : scalar(a[3], c);
  if (ret instanceof RangeRef || ret instanceof ArrayValue) {
    if (ret.cols === 1 || ret.rows === 1) return scalarOrBlank(ret.cols === 1 ? ret.at(hit, 0) : ret.at(0, hit));
    return scalarOrBlank(ret.at(hit, 0));
  }
  return ret;
} });
define('INDEX', { category: 'Lookup', min: 2, max: 3, args: 'range, row, [column]', summary: 'The value at a row and column of a range', fn: (a, c) => {
  const r = a[0];
  const row = Math.trunc(ok(num(a[1], c))), col = a[2] === undefined ? (isRangeLike(r) && r.rows === 1 ? row : 1) : Math.trunc(ok(num(a[2], c)));
  if (!isRangeLike(r)) return row <= 1 && col <= 1 ? r : err(ERR.REF);
  const rr = a[2] === undefined && r.rows === 1 ? 1 : row;
  if (rr < 0 || col < 0 || rr > r.rows || col > r.cols) return err(ERR.REF, 'Outside the range');
  if (rr === 0 || col === 0) return err(ERR.VALUE, 'Whole rows or columns can\'t be returned here');
  return scalarOrBlank(r.at(rr - 1, col - 1));
} });
define('CHOOSE', { category: 'Lookup', lazy: true, min: 2, args: 'index, value1, …', fn: (t, c) => { const i = Math.trunc(ok(num(t[0](), c))); if (i < 1 || i >= t.length) return err(ERR.VALUE); return scalarOrRange(t[i]()); } });
define('ROW', { category: 'Lookup', min: 0, max: 1, args: '[reference]', fn: (a, c) => (a.length && a[0] instanceof RangeRef ? a[0].r1 + 1 : c.r + 1) });
define('COLUMN', { category: 'Lookup', min: 0, max: 1, args: '[reference]', fn: (a, c) => (a.length && a[0] instanceof RangeRef ? a[0].c1 + 1 : c.c + 1) });
define('ROWS', { category: 'Lookup', min: 1, max: 1, args: 'range', fn: (a) => (isRangeLike(a[0]) ? a[0].rows : 1) });
define('COLUMNS', { category: 'Lookup', min: 1, max: 1, args: 'range', fn: (a) => (isRangeLike(a[0]) ? a[0].cols : 1) });

/* ── Information ───────────────────────────────── */

define('ISBLANK', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => isBlank(scalar(a[0], c)) });
define('ISNUMBER', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => typeof scalar(a[0], c) === 'number' });
define('ISTEXT', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => typeof scalar(a[0], c) === 'string' });
define('ISNONTEXT', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => typeof scalar(a[0], c) !== 'string' });
define('ISLOGICAL', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => typeof scalar(a[0], c) === 'boolean' });
define('ISERROR', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => isError(scalar(a[0], c)) });
define('ISERR', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => { const v = scalar(a[0], c); return isError(v) && v.code !== ERR.NA; } });
define('ISNA', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a, c) => { const v = scalar(a[0], c); return isError(v) && v.code === ERR.NA; } });
define('ISEVEN', { category: 'Info', min: 1, max: 1, args: 'number', fn: (a, c) => Math.trunc(ok(num(a[0], c))) % 2 === 0 });
define('ISODD', { category: 'Info', min: 1, max: 1, args: 'number', fn: (a, c) => Math.abs(Math.trunc(ok(num(a[0], c))) % 2) === 1 });
define('NA', { category: 'Info', min: 0, max: 0, fn: () => err(ERR.NA) });
define('ERROR.TYPE', { category: 'Info', min: 1, max: 1, args: 'error', fn: (a, c) => { const v = scalar(a[0], c); if (!isError(v)) return err(ERR.NA); return ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'].indexOf(v.code) + 1 || err(ERR.NA); } });
define('TYPE', { category: 'Info', min: 1, max: 1, args: 'value', fn: (a) => { const v = a[0]; if (isRangeLike(v) && !(v instanceof RangeRef && v.rows === 1 && v.cols === 1)) return 64; const s = v instanceof RangeRef ? v.at(0, 0) : v; return typeof s === 'number' || s === null ? 1 : typeof s === 'string' ? 2 : typeof s === 'boolean' ? 4 : isError(s) ? 16 : 1; } });

/* ── Intercoder reliability (MetaCode) ─────────── */

/** @returns {any} */
function reliability() {
  const R = /** @type {any} */ (globalThis).ReliabilityStats;
  if (!R) throw err(ERR.NAME, 'Reliability statistics aren\'t available here');
  return R;
}
/** Codes as text (blank = missing) @param {any} v */
const code = v => (v === null || v === undefined || v === '' ? null : v instanceof CellError ? (() => { throw v; })() : typeof v === 'number' ? numberToText(v) : String(v));
/** Two coders' columns → pairs @param {any} x @param {any} y */
function codePairs(x, y) {
  const a = vectorOf(x), b = vectorOf(y);
  if (a.length !== b.length) throw err(ERR.VALUE, 'Both coders\' ranges must be the same size');
  const out = [];
  const len = Math.max(a.values.length, b.values.length);
  for (let i = 0; i < len; i++) out.push({ a: code(a.values[i]), b: code(b.values[i]) });
  return out;
}
/** A statistic's value, or #N/A with the reason @param {{ value: number | null, reason?: string }} r */
const statValue = r => (r.value === null || r.value === undefined || !Number.isFinite(r.value) ? err(ERR.NA, r.reason || 'Can\'t be computed') : r.value);
define('PERCENTAGREEMENT', { category: 'Reliability', min: 2, max: 2, args: 'coder1_range, coder2_range', summary: 'Share of units both coders coded the same (MetaCode)', fn: (a) => statValue(reliability().percentAgreement(codePairs(a[0], a[1]))) });
define('COHENKAPPA', { category: 'Reliability', min: 2, max: 2, args: 'coder1_range, coder2_range', summary: 'Cohen\'s κ for two coders (MetaCode)', fn: (a) => statValue(reliability().cohenKappa(codePairs(a[0], a[1]))) });
define('WEIGHTEDKAPPA', { category: 'Reliability', min: 2, max: 4, args: 'coder1_range, coder2_range, [scheme], [ordered_categories]', summary: 'Weighted κ for ordered codes (MetaCode)', fn: (a, c) => {
  const p = codePairs(a[0], a[1]);
  const scheme = a[2] === undefined || a[2] === null ? 'linear' : ok(txt(a[2], c)).toLowerCase();
  let ordered;
  if (a[3] !== undefined && a[3] !== null) ordered = flatValues([a[3]]).map(code).filter(x => x !== null);
  else { const set = new Set(); p.forEach(q => { if (q.a !== null) set.add(q.a); if (q.b !== null) set.add(q.b); }); ordered = Array.from(set).sort((x, y) => { const nx = Number(x), ny = Number(y); return Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x).localeCompare(String(y)); }); }
  return statValue(reliability().weightedKappa(p, ordered, scheme === 'quadratic' ? 'quadratic' : 'linear'));
} });
define('KRIPPENDORFF', { category: 'Reliability', min: 1, max: 2, args: 'units_by_coders_range, [level]', summary: 'Krippendorff\'s α — rows are units, columns coders (MetaCode)', fn: (a, c) => {
  const m = matrixOf(a[0]);
  const level = a[1] === undefined || a[1] === null ? 'nominal' : ok(txt(a[1], c)).toLowerCase();
  if (!['nominal', 'ordinal', 'interval', 'ratio'].includes(level)) return err(ERR.VALUE, 'The level is nominal, ordinal, interval or ratio');
  const units = m.map((/** @type {any[]} */ row) => row.map(code).filter((/** @type {any} */ x) => x !== null));
  if (level === 'interval' || level === 'ratio') {
    const nums = units.map((/** @type {any[]} */ u) => u.map(Number));
    if (nums.some((/** @type {number[]} */ u) => u.some(x => !Number.isFinite(x)))) return err(ERR.VALUE, 'Interval and ratio levels need numeric codes');
    return statValue(reliability().krippendorffAlpha(nums, level));
  }
  let ordered;
  if (level === 'ordinal') { const set = new Set(units.flat()); ordered = Array.from(set).sort((x, y) => { const nx = Number(x), ny = Number(y); return Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x).localeCompare(String(y)); }); }
  return statValue(reliability().krippendorffAlpha(units, level, ordered));
} });

/** The volatile functions (recalculated on every change) */
export const VOLATILE = new Set(Object.keys(FUNCTIONS).filter(k => FUNCTIONS[k].volatile));
/** Every function name, sorted (for autocomplete) */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
export { FUNCTIONS, msToSerial };
