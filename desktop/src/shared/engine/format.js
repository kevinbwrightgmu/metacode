// @ts-check
// ── Number formats ────────────────────────────────────────────────────────────
// Excel's format codes, as found in .xlsx files and typed by spreadsheet
// users: 0 # ? placeholders, thousands separators, %, scientific E+00,
// "text" and \c literals, colors ([Red]), up to four sections
// (positive;negative;zero;text), dates and times (yyyy mm dd hh:mm:ss AM/PM,
// elapsed [h]:mm), fractions (# ?/?) and @ for text.

import { numberToText, serialToParts, CellError } from './values.js';

export const GENERAL = 'General';

/** Excel's built-in format ids (as used in .xlsx styles) */
export const BUILTIN_FORMATS = /** @type {Record<number, string>} */ ({
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@'
});

const COLORS = /** @type {Record<string, string>} */ ({ black: '#000000', blue: '#0000FF', cyan: '#00FFFF', green: '#008000', magenta: '#FF00FF', red: '#FF0000', white: '#FFFFFF', yellow: '#FFFF00' });
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Splits a format code into sections at ";" outside quotes, brackets and escapes @param {string} code */
function splitSections(code) {
  const out = [];
  let cur = '', q = false, b = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\' && !q) { cur += ch + (code[i + 1] || ''); i++; continue; }
    if (ch === '"') q = !q;
    else if (!q && ch === '[') b = true;
    else if (!q && ch === ']') b = false;
    if (ch === ';' && !q && !b) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** A date or time format? (date tokens outside quotes and brackets) @param {string} code */
export function isDateFormat(code) {
  if (!code || code === GENERAL) return false;
  const s = splitSections(code)[0].replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(h+|m+|s+)\]/gi, 'h').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(s) && !/^[#0?,.%E+\- ]*$/i.test(s);
}

/** @param {number} n @param {number} places */
function roundHalfAway(n, places) {
  const f = Math.pow(10, places);
  const v = Math.round(Number((Math.abs(n) * f).toPrecision(15))) / f;
  return n < 0 ? -v : v;
}

/** Fixed decimals without float noise @param {number} n @param {number} places */
function fixed(n, places) {
  const r = roundHalfAway(n, places);
  return Math.abs(r) < 1e21 ? r.toFixed(places) : String(r);
}

/** Excel's General display of a number (fits about 11 characters) @param {number} n */
export function formatGeneral(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (Number.isInteger(n) && a < 1e11) return String(n);
  if (a >= 1e11 || a < 1e-5) {
    const [m, e] = n.toExponential(5).split('e');
    const mant = m.replace(/\.?0+$/, '');
    const ex = Number(e);
    return mant + 'E' + (ex < 0 ? '-' : '+') + String(Math.abs(ex)).padStart(2, '0');
  }
  // As many decimals as fit in 11 characters (Excel's General in a default-width column)
  const digitsBefore = Math.max(1, Math.floor(Math.log10(a)) + 1);
  const places = Math.max(0, 11 - digitsBefore - 1);
  const s = fixed(n, places);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** @typedef {{ text: string, color: string | null }} Formatted */

/**
 * A value as text, under a format code.
 * @param {any} value @param {string} [code]
 * @returns {Formatted}
 */
export function formatValue(value, code) {
  if (value === null || value === undefined) return { text: '', color: null };
  if (value instanceof CellError) return { text: value.code, color: null };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', color: null };
  const fmt = code || GENERAL;
  if (typeof value === 'string') {
    if (fmt === GENERAL) return { text: value, color: null };
    const sections = splitSections(fmt);
    const textSection = sections.length >= 4 ? sections[3] : sections.find(s => s.includes('@'));
    if (!textSection) return { text: value, color: null };
    const { body, color } = stripBrackets(textSection);
    return { text: literalize(body, value), color };
  }
  if (typeof value !== 'number') return { text: String(value), color: null };
  if (fmt === GENERAL || /^general$/i.test(fmt)) return { text: formatGeneral(value), color: null };
  try {
    return formatNumber(value, fmt);
  } catch (e) {
    return { text: formatGeneral(value), color: null };
  }
}

/** [Red], [Color5], [$-409] and conditions out of a section @param {string} s */
function stripBrackets(s) {
  let color = null;
  let elapsed = false;
  const body = s.replace(/\[([^\]]*)\]/g, (m, inner) => {
    const k = String(inner).toLowerCase();
    if (COLORS[k]) { color = COLORS[k]; return ''; }
    if (/^(h+|m+|s+)$/i.test(inner)) { elapsed = true; return m; }
    if (/^\$/.test(inner)) { const sym = String(inner).slice(1).split('-')[0]; return sym ? '"' + sym + '"' : ''; }
    return '';
  });
  return { body, color, elapsed };
}

/** A text section with "@" replaced by the text @param {string} body @param {string} text */
function literalize(body, text) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') { const j = body.indexOf('"', i + 1); out += body.slice(i + 1, j < 0 ? body.length : j); i = j < 0 ? body.length : j; }
    else if (ch === '\\') { out += body[i + 1] || ''; i++; }
    else if (ch === '_') { out += ' '; i++; }
    else if (ch === '*') { i++; }
    else if (ch === '@') out += text;
    else out += ch;
  }
  return out;
}

/** @param {number} value @param {string} code @returns {Formatted} */
function formatNumber(value, code) {
  const sections = splitSections(code);
  let section = sections[0];
  let neg = value < 0;
  let signHandled = false;
  if (sections.length >= 2 && value < 0) { section = sections[1]; signHandled = true; }
  else if (sections.length >= 3 && value === 0) section = sections[2];
  const { body, color, elapsed } = stripBrackets(section);
  if (isDateFormat(section) || elapsed) return { text: (neg && !signHandled ? '-' : '') + formatDate(Math.abs(value), body), color };
  if (!/[0#?]/.test(body.replace(/"[^"]*"/g, '').replace(/\\./g, ''))) {
    // A section with no digits at all (e.g. "-" or "Zero")
    return { text: literalize(body.replace(/@/g, ''), ''), color };
  }
  const v = signHandled ? Math.abs(value) : value;
  const text = formatNumberSection(v, body);
  return { text, color };
}

/**
 * One number section (no colors, no date tokens).
 * @param {number} value @param {string} body
 */
function formatNumberSection(value, body) {
  // Tokens: literals vs. the numeric picture
  /** @type {{ t: 'd' | 'dot' | 'comma' | 'pct' | 'exp' | 'lit' | 'slash', v: string }[]} */
  const toks = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') { const j = body.indexOf('"', i + 1); toks.push({ t: 'lit', v: body.slice(i + 1, j < 0 ? body.length : j) }); i = j < 0 ? body.length : j; continue; }
    if (ch === '\\') { toks.push({ t: 'lit', v: body[i + 1] || '' }); i++; continue; }
    if (ch === '_') { toks.push({ t: 'lit', v: ' ' }); i++; continue; }
    if (ch === '*') { i++; continue; }
    if (ch === '0' || ch === '#' || ch === '?') { toks.push({ t: 'd', v: ch }); continue; }
    if (ch === '.') { toks.push({ t: 'dot', v: ch }); continue; }
    if (ch === ',') { toks.push({ t: 'comma', v: ch }); continue; }
    if (ch === '%') { toks.push({ t: 'pct', v: ch }); continue; }
    if (ch === '/') { toks.push({ t: 'slash', v: ch }); continue; }
    if ((ch === 'E' || ch === 'e') && (body[i + 1] === '+' || body[i + 1] === '-')) { toks.push({ t: 'exp', v: body[i + 1] }); i++; continue; }
    if (ch === '@') continue;
    toks.push({ t: 'lit', v: ch });
  }
  const neg = value < 0;
  let v = Math.abs(value);
  const pct = toks.filter(t => t.t === 'pct').length;
  v *= Math.pow(100, pct);
  if (toks.some(t => t.t === 'slash')) return (neg ? '-' : '') + formatFraction(v, toks);

  const firstD = toks.findIndex(t => t.t === 'd');
  let lastD = -1;
  toks.forEach((t, i) => { if (t.t === 'd') lastD = i; });
  const expAt = toks.findIndex(t => t.t === 'exp');
  const dotAt = toks.findIndex((t, i) => t.t === 'dot' && i > firstD - 1 && (expAt < 0 || i < expAt));
  const intEnd = dotAt >= 0 ? dotAt : expAt >= 0 ? expAt : lastD + 1;
  // Commas right after the integer digits divide by 1,000 each; between digits they group thousands
  // (commas after the last digit, and commas just before the decimal point)
  let scale = 0, beforeDot = 0;
  for (let i = lastD + 1; i < toks.length && toks[i].t === 'comma'; i++) scale++;
  if (dotAt >= 0) for (let i = dotAt - 1; i >= 0 && toks[i].t === 'comma'; i--) beforeDot++;
  scale += beforeDot;
  const intToks = toks.slice(0, intEnd).map((t, i) => ({ t, i })).filter(x => x.t.t === 'd');
  const lastIntD = intToks.length ? intToks[intToks.length - 1].i : -1;
  const grouping = toks.some((t, i) => t.t === 'comma' && i > firstD && i < lastIntD);
  v /= Math.pow(1000, scale);
  const fracToks = dotAt >= 0 ? toks.slice(dotAt + 1, expAt >= 0 ? expAt : toks.length).filter(t => t.t === 'd') : [];
  const places = fracToks.length;

  let exponent = 0;
  let expDigits = 0;
  if (expAt >= 0) {
    expDigits = toks.slice(expAt + 1).filter(t => t.t === 'd').length;
    if (v !== 0) {
      exponent = Math.floor(Math.log10(v));
      const ints = Math.max(1, intToks.length);
      if (ints > 1 && toks.slice(0, intEnd).some(t => t.v === '#')) exponent -= ((exponent % ints) + ints) % ints;
      else exponent -= ints - 1;
      v /= Math.pow(10, exponent);
      if (Number(fixed(v, places)) >= Math.pow(10, Math.max(1, intToks.length))) { v /= 10; exponent += 1; }
    }
  }
  const rounded = fixed(v, places);
  let [intPart, fracPart = ''] = rounded.split('.');
  if (intPart === '0') intPart = '';

  // Integer digits, right to left into the placeholders
  const minInt = intToks.filter(x => x.t.v === '0').length;
  let intStr = intPart.padStart(minInt, '0');
  if (grouping) intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Placeholders "?" pad with spaces
  const qInt = intToks.filter(x => x.t.v === '?').length;
  if (intStr.length < minInt + qInt) intStr = intStr.padStart(minInt + qInt, ' ');

  // Fraction: "0" always shown, "#" trimmed, "?" spaces
  let fracStr = '';
  for (let k = 0; k < fracToks.length; k++) fracStr += fracPart[k] || '0';
  for (let k = fracToks.length - 1; k >= 0; k--) {
    if (fracStr[k] !== '0') break;
    if (fracToks[k].v === '#') fracStr = fracStr.slice(0, k);
    else if (fracToks[k].v === '?') fracStr = fracStr.slice(0, k) + ' ' + fracStr.slice(k + 1);
    else break;
  }

  // Rebuild in the picture's order: literals stay where they were
  let out = '';
  let intPlaced = false, dotPlaced = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (expAt >= 0 && i === expAt) {
      const es = String(Math.abs(exponent)).padStart(expDigits, '0');
      out += 'E' + (exponent < 0 ? '-' : t.v === '+' ? '+' : '') + es;
      // skip the exponent's digit placeholders
      while (i + 1 < toks.length && toks[i + 1].t === 'd') i++;
      continue;
    }
    if (t.t === 'lit') { out += t.v; continue; }
    if (t.t === 'pct') { out += '%'; continue; }
    if (i < intEnd) {
      if ((t.t === 'd' || t.t === 'comma') && !intPlaced) { out += intStr; intPlaced = true; }
      continue;
    }
    if (t.t === 'dot' && i === dotAt) { if (!dotPlaced) { out += '.' + fracStr; dotPlaced = true; } continue; }
  }
  if (!intPlaced && intStr) out = intStr + out;
  const hasDigits = /[1-9]/.test(out);
  return (neg && hasDigits ? '-' : '') + out;
}

/** "# ?/?" and friends @param {number} v @param {{ t: string, v: string }[]} toks */
function formatFraction(v, toks) {
  const slash = toks.findIndex(t => t.t === 'slash');
  const denToks = toks.slice(slash + 1).filter(t => t.t === 'd');
  const fixedDen = toks.slice(slash + 1).filter(t => t.t === 'lit' && /^\d+$/.test(t.v)).map(t => Number(t.v))[0];
  const before = toks.slice(0, slash);
  // A whole part when the picture has digits, a gap, then the numerator
  const gap = before.findIndex((t, i) => t.t === 'lit' && t.v.trim() === '' && i > 0 && before.slice(0, i).some(x => x.t === 'd'));
  const whole = gap >= 0 ? Math.floor(v) : 0;
  const frac = v - whole;
  const maxDen = fixedDen || Math.pow(10, Math.max(1, denToks.length)) - 1;
  let num = 0, den = 1;
  if (fixedDen) { den = fixedDen; num = Math.round(frac * den); }
  else {
    let best = Infinity;
    for (let d = 1; d <= maxDen; d++) { const n = Math.round(frac * d); const e = Math.abs(frac - n / d); if (e < best - 1e-12) { best = e; num = n; den = d; } if (e === 0) break; }
  }
  let w = whole;
  if (num === den) { w += 1; num = 0; }
  if (gap >= 0) {
    if (num === 0) return String(w);
    return (w ? w + ' ' : '') + num + '/' + den;
  }
  return (w * den + num) + '/' + den;
}

/** A date/time section @param {number} serial @param {string} body */
function formatDate(serial, body) {
  const p = serialToParts(serial);
  const ampm = /AM\/PM|A\/P/i.test(body);
  let out = '';
  // Tokens, with "m" read as minutes after h or before s
  /** @type {{ k: string, s: string }[]} */
  const toks = [];
  for (let i = 0; i < body.length;) {
    const rest = body.slice(i);
    let m;
    if (rest[0] === '"') { const j = body.indexOf('"', i + 1); toks.push({ k: 'lit', s: body.slice(i + 1, j < 0 ? body.length : j) }); i = (j < 0 ? body.length : j) + 1; continue; }
    if (rest[0] === '\\') { toks.push({ k: 'lit', s: rest[1] || '' }); i += 2; continue; }
    if (rest[0] === '_') { toks.push({ k: 'lit', s: ' ' }); i += 2; continue; }
    if (rest[0] === '*') { i += 2; continue; }
    if ((m = /^\[(h+|m+|s+)\]/i.exec(rest))) { toks.push({ k: 'elapsed-' + m[1][0].toLowerCase(), s: m[1] }); i += m[0].length; continue; }
    if ((m = /^(AM\/PM|am\/pm|A\/P|a\/p)/.exec(rest))) { toks.push({ k: 'ampm', s: m[1] }); i += m[0].length; continue; }
    if ((m = /^(y+|m+|d+|h+|s+)/i.exec(rest))) { toks.push({ k: m[1][0].toLowerCase(), s: m[1] }); i += m[0].length; continue; }
    if ((m = /^\.(0+)/.exec(rest)) && toks.length && toks[toks.length - 1].k === 's') { toks.push({ k: 'frac', s: m[1] }); i += m[0].length; continue; }
    toks.push({ k: 'lit', s: rest[0] }); i++;
  }
  // "m" after an hour or before a second means minutes
  toks.forEach((t, i) => {
    if (t.k !== 'm' || t.s.length > 2) return;
    const prev = toks.slice(0, i).reverse().find(x => x.k !== 'lit');
    const next = toks.slice(i + 1).find(x => x.k !== 'lit');
    if ((prev && (prev.k === 'h' || prev.k === 'elapsed-h')) || (next && (next.k === 's' || next.k === 'elapsed-s'))) t.k = 'min';
  });
  const totalSeconds = Math.round(serial * 86400 * 1000) / 1000;
  for (const t of toks) {
    const n = t.s.length;
    switch (t.k) {
      case 'lit': out += t.s; break;
      case 'y': out += n <= 2 ? String(p.y % 100).padStart(2, '0') : String(p.y).padStart(4, '0'); break;
      case 'm': out += n === 1 ? String(p.m) : n === 2 ? String(p.m).padStart(2, '0') : n === 3 ? MONTH_NAMES[p.m - 1].slice(0, 3) : n === 5 ? MONTH_NAMES[p.m - 1][0] : MONTH_NAMES[p.m - 1]; break;
      case 'min': out += n === 1 ? String(p.mi) : String(p.mi).padStart(2, '0'); break;
      case 'd': out += n === 1 ? String(p.d) : n === 2 ? String(p.d).padStart(2, '0') : n === 3 ? DAY_NAMES[p.wd].slice(0, 3) : DAY_NAMES[p.wd]; break;
      case 'h': { const h = ampm ? ((p.h % 12) || 12) : p.h; out += n === 1 ? String(h) : String(h).padStart(2, '0'); break; }
      case 's': out += n === 1 ? String(p.s) : String(p.s).padStart(2, '0'); break;
      case 'frac': out += (p.ms / 1000).toFixed(n).slice(1); break;
      case 'ampm': out += t.s.length > 3 ? (p.h < 12 ? 'AM' : 'PM') : (p.h < 12 ? 'A' : 'P'); break;
      case 'elapsed-h': out += String(Math.floor(totalSeconds / 3600)).padStart(n, '0'); break;
      case 'elapsed-m': out += String(Math.floor(totalSeconds / 60)).padStart(n, '0'); break;
      case 'elapsed-s': out += String(Math.floor(totalSeconds)).padStart(n, '0'); break;
      default: break;
    }
  }
  return out;
}

/** Number of decimal places a format shows (for the ±decimals buttons) @param {string} code */
export function decimalsOf(code) {
  if (!code || code === GENERAL) return null;
  const s = splitSections(code)[0].replace(/"[^"]*"/g, '');
  const m = /\.([0#?]+)/.exec(s);
  return m ? m[1].length : 0;
}

/** The format with one more / fewer decimal place @param {string} code @param {number} delta @param {number} [current] */
export function changeDecimals(code, delta, current) {
  if (!code || code === GENERAL) {
    const places = Math.max(0, (current || 0) + delta);
    return places ? '0.' + '0'.repeat(places) : '0';
  }
  return splitSections(code).map(sec => {
    if (isDateFormat(sec)) return sec;
    const m = /(\d|#|\?)(\.([0#?]*))?/.exec(sec.replace(/"[^"]*"/g, m0 => '\u0000'.repeat(m0.length)));
    if (!m) return sec;
    // find the last digit placeholder of the integer part and the decimals after it
    const re = /([0#?](?:[0#?,]*[0#?])?)(\.[0#?]*)?/;
    return sec.replace(re, (all, ints, dec) => {
      const places = dec ? dec.length - 1 : 0;
      const next = Math.max(0, places + delta);
      return ints + (next ? '.' + '0'.repeat(next) : '');
    });
  }).join(';');
}

export { numberToText };
