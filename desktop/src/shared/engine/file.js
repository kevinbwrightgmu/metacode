// @ts-check
// ── The .mcsheet file format ──────────────────────────────────────────────────
// MetaCode Sheets' own format: JSON, so nothing is lost (formulas, styles,
// widths, hidden rows, frozen panes, filters, sheet colors) and it stays
// readable by other tools.
//
//   { "format": "metacode-sheets", "version": 1, "savedAt": "…", "app": "…",
//     "workbook": { "id", "name", "activeSheet", "meta",
//       "styles": [ {}, { "bold": true }, … ],
//       "sheets": [ { "id", "name", "tabColor", "freeze": { "rows", "cols" },
//                     "colWidths": { "2": 140 }, "rowHeights": {}, "hiddenRows": [], "hiddenCols": [],
//                     "filter": null | { "range", "conditions" },
//                     "cells": [ [row, col, value, formula?, style?], … ] } ] } }
//
// A value is a number, text, true/false, null or { "e": "#N/A" }.
// Loading checks everything and refuses what doesn't fit (a damaged or
// hostile file can't put anything but plain data into the workbook).

import { Workbook, Sheet, MAX_SHEETS, MAX_TEXT } from './workbook.js';
import { keyOf, MAX_ROWS, MAX_COLS } from './address.js';
import { CellError, ERROR_CODES, err } from './values.js';
import { applyFilter } from './ops.js';

export const FORMAT = 'metacode-sheets';
export const VERSION = 1;
export const MAX_CELLS = 10000000;

const COLOR = /^#[0-9A-Fa-f]{6}$/;
const BORDER_STYLES = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'];

export class FileFormatError extends Error {}

/** @param {any} v */
function encodeValue(v) {
  if (v instanceof CellError) return { e: v.code };
  if (v === undefined) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return { e: '#NUM!' };
  return v;
}
/** @param {any} v */
function decodeValue(v) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : err('#NUM!');
  if (typeof v === 'string') return v.slice(0, MAX_TEXT);
  if (v && typeof v === 'object' && typeof v.e === 'string' && ERROR_CODES.includes(v.e)) return err(v.e);
  return null;
}

/** @param {Workbook} wb @param {{ app?: string }} [o] */
export function toFileObject(wb, o) {
  return {
    format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), app: (o && o.app) || 'MetaCode Sheets',
    workbook: {
      id: wb.id, name: wb.name, activeSheet: wb.activeSheetId, meta: wb.meta || {},
      styles: wb.styles.list,
      sheets: wb.sheets.map(s => {
        const cells = [];
        const keys = Array.from(s.cells.keys()).sort((a, b) => a - b);
        for (const k of keys) {
          const c = /** @type {any} */ (s.cells.get(k));
          const row = [Math.floor(k / MAX_COLS), k % MAX_COLS, encodeValue(c.v)];
          if (c.f || c.s) row.push(c.f || null);
          if (c.s) row.push(c.s);
          cells.push(row);
        }
        return {
          id: s.id, name: s.name, tabColor: s.tabColor, freeze: s.freeze,
          colWidths: Object.fromEntries(s.colWidths), rowHeights: Object.fromEntries(s.rowHeights),
          hiddenRows: Array.from(s.hiddenRows), hiddenCols: Array.from(s.hiddenCols),
          filter: s.filter ? { range: s.filter.range, conditions: s.filter.conditions } : null,
          cells
        };
      })
    }
  };
}

/** @param {Workbook} wb @param {{ app?: string, pretty?: boolean }} [o] */
export function serialize(wb, o) {
  return JSON.stringify(toFileObject(wb, o), (k, v) => (v instanceof CellError ? { e: v.code } : v), o && o.pretty ? 1 : undefined);
}

/** A style from a file: known properties with the right types only @param {any} s */
function cleanStyle(s) {
  /** @type {any} */
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const k of ['bold', 'italic', 'underline', 'strike', 'wrap']) if (s[k] === true) out[k] = true;
  if (Number.isFinite(s.size) && s.size >= 6 && s.size <= 96) out.size = Number(s.size);
  for (const k of ['color', 'fill']) if (typeof s[k] === 'string' && COLOR.test(s[k])) out[k] = s[k].toUpperCase();
  if (typeof s.family === 'string' && /^[\w \-,'"]{1,80}$/.test(s.family)) out.family = s.family;
  if (['left', 'center', 'right'].includes(s.h)) out.h = s.h;
  if (['top', 'middle', 'bottom'].includes(s.v)) out.v = s.v;
  if (Number.isInteger(s.indent) && s.indent > 0 && s.indent <= 15) out.indent = s.indent;
  if (typeof s.numFmt === 'string' && s.numFmt.length <= 200 && s.numFmt !== 'General') out.numFmt = s.numFmt;
  if (s.border && typeof s.border === 'object') {
    const b = /** @type {any} */ ({});
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const x = s.border[side];
      if (x && BORDER_STYLES.includes(x.style)) b[side] = { style: x.style, color: typeof x.color === 'string' && COLOR.test(x.color) ? x.color.toUpperCase() : '#000000' };
    }
    if (Object.keys(b).length) out.border = b;
  }
  return out;
}

/** @param {any} n @param {number} max */
const index = (n, max) => (Number.isInteger(n) && n >= 0 && n < max ? n : -1);

/**
 * A workbook from a parsed .mcsheet object.
 * @param {any} obj
 * @returns {Workbook}
 */
export function fromFileObject(obj) {
  if (!obj || typeof obj !== 'object' || obj.format !== FORMAT) throw new FileFormatError('This isn\'t a MetaCode Sheets file.');
  if (!Number.isInteger(obj.version) || obj.version < 1) throw new FileFormatError('This file\'s format version isn\'t recognised.');
  if (obj.version > VERSION) throw new FileFormatError('This file was saved by a newer version of MetaCode Sheets. Update the app to open it.');
  const w = obj.workbook;
  if (!w || typeof w !== 'object' || !Array.isArray(w.sheets) || !w.sheets.length) throw new FileFormatError('The file has no sheets.');
  if (w.sheets.length > MAX_SHEETS) throw new FileFormatError('The file has more than ' + MAX_SHEETS + ' sheets.');
  const wb = new Workbook({ id: typeof w.id === 'string' && /^[\w-]{1,64}$/.test(w.id) ? w.id : undefined, name: typeof w.name === 'string' ? w.name.slice(0, 200) : 'Untitled' });
  wb.meta = w.meta && typeof w.meta === 'object' && !Array.isArray(w.meta) ? JSON.parse(JSON.stringify(w.meta)) : {};
  // Styles: ids in the file → ids in the pool
  const styleIds = (Array.isArray(w.styles) ? w.styles.slice(0, 100000) : [{}]).map((/** @type {any} */ s) => wb.styles.id(cleanStyle(s)));
  let total = 0;
  const usedIds = new Set();
  for (const sd of w.sheets) {
    if (!sd || typeof sd !== 'object') throw new FileFormatError('A sheet in the file is damaged.');
    let name = typeof sd.name === 'string' && sd.name.trim() ? sd.name.trim().slice(0, 31).replace(/[\\/?*[\]:]/g, '_') : wb.freeSheetName();
    if (wb.sheetByName(name)) name = wb.freeSheetName(name);
    const s = wb.addSheet(name);
    if (typeof sd.id === 'string' && /^[\w-]{1,64}$/.test(sd.id) && !usedIds.has(sd.id)) { s.id = sd.id; usedIds.add(sd.id); }
    if (typeof sd.tabColor === 'string' && COLOR.test(sd.tabColor)) s.tabColor = sd.tabColor;
    if (sd.freeze && typeof sd.freeze === 'object') s.freeze = { rows: Math.max(0, Math.min(1000, index(sd.freeze.rows, 1001))), cols: Math.max(0, Math.min(100, index(sd.freeze.cols, 101))) };
    for (const [k, v] of Object.entries(sd.colWidths || {})) { const c = index(Number(k), MAX_COLS); if (c >= 0 && Number.isFinite(v) && v > 0 && v <= 2000) s.colWidths.set(c, Number(v)); }
    for (const [k, v] of Object.entries(sd.rowHeights || {})) { const r = index(Number(k), MAX_ROWS); if (r >= 0 && Number.isFinite(v) && v > 0 && v <= 1000) s.rowHeights.set(r, Number(v)); }
    for (const r of Array.isArray(sd.hiddenRows) ? sd.hiddenRows : []) if (index(r, MAX_ROWS) >= 0) s.hiddenRows.add(r);
    for (const c of Array.isArray(sd.hiddenCols) ? sd.hiddenCols : []) if (index(c, MAX_COLS) >= 0) s.hiddenCols.add(c);
    if (sd.filter && sd.filter.range && typeof sd.filter.range === 'object') {
      const g = sd.filter.range;
      if ([g.r1, g.r2].every(x => index(x, MAX_ROWS) >= 0) && [g.c1, g.c2].every(x => index(x, MAX_COLS) >= 0)) {
        const conditions = /** @type {Record<number, any>} */ ({});
        for (const [k, v] of Object.entries(sd.filter.conditions || {})) {
          const c = index(Number(k), MAX_COLS);
          if (c < 0 || !v || typeof v !== 'object') continue;
          if (v.type === 'values' && Array.isArray(v.values)) conditions[c] = { type: 'values', values: v.values.filter((/** @type {any} */ x) => typeof x === 'string').slice(0, 100000) };
          else if (v.type === 'condition' && typeof v.op === 'string' && /^(contains|notcontains|blank|notblank|=|<>|<|>|<=|>=)$/.test(v.op)) conditions[c] = { type: 'condition', op: v.op, value: typeof v.value === 'string' || typeof v.value === 'number' ? v.value : '' };
        }
        s.filter = { range: { r1: g.r1, c1: g.c1, r2: g.r2, c2: g.c2 }, conditions };
      }
    }
    const cells = Array.isArray(sd.cells) ? sd.cells : [];
    total += cells.length;
    if (total > MAX_CELLS) throw new FileFormatError('The file has more than ' + MAX_CELLS.toLocaleString('en-US') + ' cells.');
    for (const row of cells) {
      if (!Array.isArray(row)) continue;
      const r = index(row[0], MAX_ROWS), c = index(row[1], MAX_COLS);
      if (r < 0 || c < 0) continue;
      /** @type {any} */
      const cell = { v: decodeValue(row[2]) };
      if (typeof row[3] === 'string' && row[3].startsWith('=') && row[3].length > 1 && row[3].length <= 8192) cell.f = row[3];
      const sid = Number.isInteger(row[4]) ? styleIds[row[4]] : undefined;
      if (sid) cell.s = sid;
      if (cell.v === null && !cell.f && !cell.s) continue;
      s.cells.set(keyOf(r, c), cell);
    }
    s._bounds = null;
  }
  const active = wb.sheets.find(s => s.id === w.activeSheet);
  wb.activeSheetId = active ? active.id : wb.sheets[0].id;
  wb.calc.rebuild();
  wb.calc.recalcAll();
  for (const s of wb.sheets) if (s.filter) applyFilter(wb, s);
  return wb;
}

/** @param {string} text */
export function parseFile(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new FileFormatError('The file is damaged (it isn\'t valid JSON).'); }
  return fromFileObject(obj);
}

/** A new, empty workbook with one sheet @param {string} [name] */
export function newWorkbook(name) {
  const wb = new Workbook({ name: name || 'Untitled' });
  wb.addSheet('Sheet1');
  return wb;
}

export { Sheet };
