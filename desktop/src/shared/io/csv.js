// @ts-check
// ── CSV and other delimited text ──────────────────────────────────────────────
// Reading follows RFC 4180 (quoted fields, "" for a quote, line breaks inside
// quotes, CRLF/LF/CR) and guesses what it isn't told: the text encoding (BOM,
// else UTF-8, else Windows-1252) and the delimiter (comma, semicolon, tab or
// bar, whichever splits the first lines most consistently).
//
// Turning fields into cells: numbers, TRUE/FALSE and dates become values, as
// in Excel, with three exceptions for data that only looks numeric: numbers
// with leading zeros (00123), numbers with more than 15 digits (post and user
// IDs, which a spreadsheet number would round) and anything starting with "="
// stay text. Formulas in an imported file are never run unless the person
// asks for that when importing.
//
// Writing quotes fields that need it, ends lines with CRLF, and protects
// against "CSV injection": text that another app would read as a formula
// (starting with = + - @, a tab or a carriage return) gets a leading
// apostrophe, as OWASP recommends.

import { keyOf, MAX_COLS } from '../engine/address.js';
import { Workbook, parseInput, MAX_TEXT } from '../engine/workbook.js';
import { isError, numberToText } from '../engine/values.js';
import { formatValue, isDateFormat } from '../engine/format.js';

export const MAX_CSV_CELLS = 5000000;
export class CsvError extends Error {}

/**
 * Bytes → text, with the encoding detected
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: string }}
 */
export function decodeText(bytes) {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' };
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16 LE' };
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16 BE' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' }; }
}

const CANDIDATES = [',', ';', '\t', '|'];

/**
 * The delimiter that splits the first lines most consistently
 * @param {string} text
 */
export function detectDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  let best = ',', bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = [];
    let n = 0, q = false;
    for (let i = 0; i < sample.length && counts.length < 20; i++) {
      const ch = sample[i];
      if (ch === '"') q = !q;
      else if (!q && ch === d) n++;
      else if (!q && (ch === '\n' || ch === '\r')) {
        if (ch === '\r' && sample[i + 1] === '\n') i++;
        counts.push(n); n = 0;
      }
    }
    if (n) counts.push(n);
    if (!counts.length) continue;
    const first = counts[0];
    if (!first) continue;
    const same = counts.filter(c => c === first).length / counts.length;
    const score = same * 10 + Math.min(first, 50) / 50 + (d === ',' ? 0.01 : 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/**
 * Delimited text → rows of fields
 * @param {string} text
 * @param {{ delimiter?: string, maxCells?: number }} [o]
 * @returns {{ rows: string[][], delimiter: string, truncated: boolean }}
 */
export function parseCsv(text, o = {}) {
  const d = o.delimiter || detectDelimiter(text);
  if (d.length !== 1 || d === '"' || d === '\n' || d === '\r') throw new CsvError('The delimiter must be one character (not a quote or line break).');
  const maxCells = o.maxCells || MAX_CSV_CELLS;
  /** @type {string[][]} */
  const rows = [];
  let row = /** @type {string[]} */ ([]);
  let cells = 0, i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  let truncated = false;
  while (i < n) {
    let field;
    if (text[i] === '"') {
      // quoted: up to the closing quote; "" is a quote
      let j = i + 1, out = '';
      for (;;) {
        const k = text.indexOf('"', j);
        if (k < 0) { out += text.slice(j); j = n; break; }
        out += text.slice(j, k);
        if (text[k + 1] === '"') { out += '"'; j = k + 2; continue; }
        j = k + 1;
        break;
      }
      // anything between the closing quote and the delimiter is kept (lenient, like Excel)
      let e = j;
      while (e < n && text[e] !== d && text[e] !== '\n' && text[e] !== '\r') e++;
      field = out + text.slice(j, e);
      i = e;
    } else {
      let e = i;
      while (e < n && text[e] !== d && text[e] !== '\n' && text[e] !== '\r') e++;
      field = text.slice(i, e);
      i = e;
    }
    row.push(field.length > MAX_TEXT ? field.slice(0, MAX_TEXT) : field);
    if (++cells > maxCells) { truncated = true; rows.push(row); row = []; break; }
    if (i >= n) break;
    if (text[i] === d) { i++; if (i >= n) row.push(''); continue; }
    // line end
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2; else i++;
    rows.push(row);
    row = [];
  }
  if (row.length) rows.push(row);
  return { rows, delimiter: d, truncated };
}

/**
 * Fields → cell contents (see the top of the file for the rules)
 * @param {string} field
 * @param {{ formulas?: boolean, convert?: boolean }} [o]
 * @returns {{ v: any, f?: string, numFmt?: string } | null}
 */
export function fieldToCell(field, o = {}) {
  if (field === '') return null;
  if (o.convert === false) return { v: field };
  if (field[0] === '=') return o.formulas && field.length > 1 ? { v: null, f: field.slice(0, 8192) } : { v: field };
  if (field[0] === "'") return { v: field };
  const t = field.trim();
  if (/^[+-]?0\d+$/.test(t)) return { v: field };
  if (/^[+-]?\d{16,}$/.test(t)) return { v: field };
  const p = parseInput(field);
  if (p.kind === 'blank') return null;
  if (p.kind === 'formula') return { v: field };
  if (p.kind === 'value' && typeof p.v === 'number') return p.numFmt ? { v: p.v, numFmt: p.numFmt } : { v: p.v };
  if (p.kind === 'value' && (typeof p.v === 'boolean' || isError(p.v))) return { v: p.v };
  return { v: field };
}

/**
 * Puts rows of fields into a sheet (replacing what's there)
 * @param {import('../engine/workbook.js').Workbook} wb
 * @param {import('../engine/workbook.js').Sheet} sheet
 * @param {string[][]} rows
 * @param {{ formulas?: boolean, convert?: boolean }} [o]
 */
export function fillSheet(wb, sheet, rows, o = {}) {
  sheet.cells.clear();
  /** @type {Map<string, number>} */
  const fmtStyle = new Map();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length && c < MAX_COLS; c++) {
      const cell = fieldToCell(row[c], o);
      if (!cell) continue;
      /** @type {any} */
      const out = { v: cell.v };
      if (cell.f) out.f = cell.f;
      if (cell.numFmt) {
        let s = fmtStyle.get(cell.numFmt);
        if (s === undefined) { s = wb.styles.id({ numFmt: cell.numFmt }); fmtStyle.set(cell.numFmt, s); }
        out.s = s;
      }
      sheet.cells.set(keyOf(r, c), out);
    }
  }
  sheet._bounds = null;
  // a reasonable starting width for each column: its longest field (sampled)
  const sample = rows.slice(0, 200);
  const widths = new Map();
  for (const row of sample) row.forEach((f, c) => { if (c < 200) widths.set(c, Math.max(widths.get(c) || 0, Math.min(60, f.length))); });
  for (const [c, len] of widths) if (len > 12) sheet.colWidths.set(c, Math.min(420, Math.round(len * 7.5 + 16)));
}

/**
 * Reads a delimited text file into a new workbook.
 * @param {Uint8Array | string} input
 * @param {{ name?: string, delimiter?: string, formulas?: boolean, convert?: boolean, maxCells?: number }} [o]
 */
export function readCsv(input, o = {}) {
  const decoded = typeof input === 'string' ? { text: input, encoding: 'text' } : decodeText(input);
  const parsed = parseCsv(decoded.text, { delimiter: o.delimiter, maxCells: o.maxCells });
  const wb = new Workbook({ name: o.name || 'Imported' });
  const base = (o.name || 'Sheet1').replace(/\.[^.]+$/, '').slice(0, 31).replace(/[\\/?*[\]:]/g, '_').trim() || 'Sheet1';
  const sheet = wb.addSheet(base);
  fillSheet(wb, sheet, parsed.rows, o);
  wb.calc.rebuild();
  wb.calc.recalcAll();
  const notes = [];
  if (parsed.truncated) notes.push('The file has more than ' + (o.maxCells || MAX_CSV_CELLS).toLocaleString('en-US') + ' fields; only the first ones were read.');
  return { workbook: wb, notes, delimiter: parsed.delimiter, encoding: decoded.encoding, rows: parsed.rows.length };
}

const NEEDS_GUARD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * One field for a CSV line
 * @param {string} s @param {string} d @param {boolean} protect
 */
function quoteField(s, d, protect) {
  let t = s;
  if (protect && NEEDS_GUARD.test(t) && !PLAIN_NUMBER.test(t)) t = "'" + t;
  if (t.includes(d) || t.includes('"') || t.includes('\n') || t.includes('\r') || /^\s|\s$/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}

/**
 * A sheet (or part of it) → CSV text.
 * Numbers are written in full precision, except dates and times, which are
 * written as shown (a serial number means nothing in another app). With
 * `formatted`, every value is written as shown in the grid.
 * @param {import('../engine/workbook.js').Workbook} wb
 * @param {import('../engine/workbook.js').Sheet} sheet
 * @param {{ delimiter?: string, range?: { r1: number, c1: number, r2: number, c2: number }, protect?: boolean, formatted?: boolean, bom?: boolean, skipHidden?: boolean }} [o]
 */
export function sheetToCsv(wb, sheet, o = {}) {
  const d = o.delimiter || ',';
  const protect = o.protect !== false;
  const b = sheet.bounds();
  const g = o.range || { r1: 0, c1: 0, r2: b.maxRow, c2: b.maxCol };
  const lines = [];
  for (let r = g.r1; r <= g.r2; r++) {
    if (o.skipHidden && sheet.isRowHidden(r)) continue;
    const fields = [];
    for (let c = g.c1; c <= g.c2; c++) {
      if (o.skipHidden && sheet.hiddenCols.has(c)) continue;
      const cell = sheet.cells.get(keyOf(r, c));
      const v = cell ? cell.v : null;
      let s = '';
      if (v === null || v === undefined) s = '';
      else if (isError(v)) s = v.code;
      else if (typeof v === 'boolean') s = v ? 'TRUE' : 'FALSE';
      else if (typeof v === 'number') {
        const fmt = cell && cell.s ? wb.styles.get(cell.s).numFmt : undefined;
        s = o.formatted || (fmt && isDateFormat(fmt)) ? formatValue(v, fmt || 'General').text : numberToText(v);
        // a formatted negative number is a number, not a formula
        fields.push(quoteField(s, d, false));
        continue;
      } else s = String(v);
      fields.push(quoteField(s, d, protect));
    }
    lines.push(fields.join(d));
  }
  // trailing empty lines add nothing
  while (lines.length && lines[lines.length - 1].split(d).every(f => f === '')) lines.pop();
  return (o.bom ? '﻿' : '') + lines.join('\r\n') + (lines.length ? '\r\n' : '');
}
