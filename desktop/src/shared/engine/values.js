// @ts-check
// ── Cell values ───────────────────────────────────────────────────────────────
// A value is a number, a string, a boolean, an error (CellError) or null
// (empty). Coercion follows Excel's rules, so formulas give the answers
// spreadsheet users expect: text that looks like a number counts as one in
// arithmetic, an empty cell is 0 (or "" in text), and errors pass through.
// Dates and times are serial numbers (days since 1899-12-30, as in Excel's
// 1900 date system — including its well-known phantom 29 February 1900).

export class CellError {
  /** @param {string} code e.g. "#DIV/0!" @param {string} [detail] why, in words (shown on hover) */
  constructor(code, detail) { this.code = code; this.detail = detail || null; }
  toString() { return this.code; }
}

export const ERR = {
  DIV0: '#DIV/0!', VALUE: '#VALUE!', REF: '#REF!', NAME: '#NAME?', NA: '#N/A', NUM: '#NUM!', NULL: '#NULL!'
};
export const ERROR_CODES = Object.values(ERR);

/** @param {string} code @param {string} [detail] */
export const err = (code, detail) => new CellError(code, detail);
/** @param {unknown} v @returns {v is CellError} */
export const isError = v => v instanceof CellError;
/** @param {unknown} v */
export const isBlank = v => v === null || v === undefined;

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A number for arithmetic: numbers as they are, booleans 1/0, blank 0, text
 * that reads as a number (also "12%", "1,234", dates) — else #VALUE!.
 * @param {unknown} v
 * @returns {number | CellError}
 */
export function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof CellError) return v;
  if (typeof v === 'string') {
    const n = textToNumber(v);
    return n === null ? err(ERR.VALUE, '"' + v.slice(0, 40) + '" isn\'t a number') : n;
  }
  return err(ERR.VALUE);
}

/** Text → number, or null @param {string} s */
export function textToNumber(s) {
  let t = s.trim();
  if (!t) return null;
  let pct = false;
  if (t.endsWith('%')) { pct = true; t = t.slice(0, -1).trim(); }
  t = t.replace(/^\$/, '').replace(/^([+-])\$/, '$1');
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(t)) t = t.replace(/,/g, '');
  if (NUMERIC.test(t)) { const n = Number(t); return pct ? n / 100 : n; }
  if (!pct) { const d = parseDateText(s.trim()); if (d !== null) return d; }
  return null;
}

/** Text for concatenation and text functions @param {unknown} v @returns {string | CellError} */
export function toText(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberToText(v);
  if (v instanceof CellError) return v;
  return String(v);
}

/** Excel's "General" text of a number (up to 15 significant digits) @param {number} n */
export function numberToText(n) {
  if (!Number.isFinite(n)) return err(ERR.NUM).code;
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const a = Math.abs(n);
  if (a !== 0 && (a >= 1e15 || a < 1e-9)) return n.toExponential(14).replace(/\.?0+e/, 'E').replace('E+', 'E+').replace(/E(-?)(\d)$/, 'E$10$2');
  return String(Number(n.toPrecision(15)));
}

/** @param {unknown} v @returns {boolean | CellError} */
export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === undefined) return false;
  if (v instanceof CellError) return v;
  if (typeof v === 'string') {
    const u = v.trim().toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    return err(ERR.VALUE, '"' + v.slice(0, 40) + '" isn\'t TRUE or FALSE');
  }
  return err(ERR.VALUE);
}

/**
 * Excel's ordering for comparisons and sorting: numbers < text < booleans;
 * text compares case-insensitively. Blank counts as 0 / "" / FALSE against
 * the other side's type. → -1, 0, 1
 * @param {unknown} a @param {unknown} b
 */
export function compareValues(a, b) {
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const rank = (/** @type {unknown} */ v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return 0;
}

/* ── Dates ─────────────────────────────────────── */

const EPOCH = Date.UTC(1899, 11, 30);
const DAY = 86400000;

/** Serial → { y, m (1–12), d, h, mi, s, ms, wd (0 = Sunday) }; serial 60 is 29 Feb 1900 @param {number} serial */
export function serialToParts(serial) {
  const whole = Math.floor(serial);
  let frac = serial - whole;
  let ms = Math.round(frac * DAY);
  let dayAdd = 0;
  if (ms >= DAY) { ms -= DAY; dayAdd = 1; }
  const days = whole + dayAdd;
  let y, m, d;
  if (days === 60) { y = 1900; m = 2; d = 29; }
  else {
    const t = new Date(EPOCH + (days < 60 ? days + 1 : days) * DAY);
    y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
  }
  const wd = ((days % 7) + 7 + 6) % 7;      // serial 1 (1900-01-01) was a Sunday in Excel's calendar
  const h = Math.floor(ms / 3600000), mi = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return { y, m, d, h, mi, s, ms: ms % 1000, wd };
}

/** Year, month (1–12, may overflow), day (may overflow) → serial @param {number} y @param {number} m @param {number} d */
export function dateToSerial(y, m, d) {
  if (y >= 0 && y < 1900) y += 1900;
  const t = Date.UTC(y, m - 1, d);
  let serial = Math.round((t - EPOCH) / DAY);
  if (serial < 61 && serial >= 1) serial -= 1;              // before Excel's phantom 29 Feb 1900
  if (y === 1900 && m === 2 && d === 29) serial = 60;
  return serial;
}

/** @param {number} h @param {number} mi @param {number} s */
export const timeToSerial = (h, mi, s) => (h * 3600 + mi * 60 + s) / 86400;

/** A JS time (ms) → serial, in UTC @param {number} ms */
export const msToSerial = ms => { const s = (ms - EPOCH) / DAY; return s < 61 ? s - 1 : s; };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Dates and times people type: 2024-03-05, 2024/3/5, 3/5/2024 (month first),
 * 5-Mar-2024, Mar 5 2024, 14:30, 2:30 PM, 2024-03-05 14:30. → serial or null
 * @param {string} s
 */
export function parseDateText(s) {
  const t = s.trim();
  let m;
  let date = null, time = 0, rest = t;
  if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](.*))?$/.exec(t))) { date = [Number(m[1]), Number(m[2]), Number(m[3])]; rest = m[4] || ''; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?: (.*))?$/.exec(t))) { date = [twoDigitYear(m[3]), Number(m[1]), Number(m[2])]; rest = m[4] || ''; }
  else if ((m = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{2}|\d{4})(?: (.*))?$/.exec(t))) { const mo = monthOf(m[2]); if (mo) { date = [twoDigitYear(m[3]), mo, Number(m[1])]; rest = m[4] || ''; } }
  else if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})(?: (.*))?$/.exec(t))) { const mo = monthOf(m[1]); if (mo) { date = [Number(m[3]), mo, Number(m[2])]; rest = m[4] || ''; } }
  if (date) {
    const [y, mo, d] = date;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 9999) return null;
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1) return null;
    if (!rest) return dateToSerial(y, mo, d);
  }
  if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(AM|PM|am|pm|a|p)?$/.exec(rest))) {
    let h = Number(m[1]);
    const mi = Number(m[2]), sec = m[3] ? Number(m[3]) : 0;
    if (m[4]) { const pm = /^p/i.test(m[4]); if (h < 1 || h > 12) return null; h = (h % 12) + (pm ? 12 : 0); }
    if (h > 23 || mi > 59 || sec >= 60) return null;
    time = timeToSerial(h, mi, sec);
    return date ? dateToSerial(date[0], date[1], date[2]) + time : time;
  }
  return null;
}
/** @param {string} y */
const twoDigitYear = y => (y.length === 2 ? (Number(y) < 30 ? 2000 : 1900) + Number(y) : Number(y));
/** @param {string} name */
const monthOf = name => { const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase()); return i < 0 ? 0 : i + 1; };
