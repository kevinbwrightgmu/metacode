// @ts-check
// ── .xlsx (Office Open XML spreadsheets) ──────────────────────────────────────
// Reading: sheets, values (shared strings, inline strings, numbers, booleans,
// errors, ISO dates), formulas (including shared formulas), styles (fonts,
// fills, borders, alignment, number formats, theme and indexed colours),
// column widths, row heights, hidden rows/columns, frozen panes, filters, tab
// colours and the 1904 date system. Not read: charts, pictures, comments,
// pivot tables, conditional formats and data validation; merged cells keep
// their top-left value. Macros (.xlsm) are never run — they're ignored.
//
// Writing: everything the app keeps in a workbook (values, formulas with
// their last results, styles, widths, heights, hidden, frozen panes, filter,
// tab colours), readable by Excel, LibreOffice and Google Sheets.
//
// Limits: at most 5,000,000 cells, 512 MB unpacked; past them the file is
// refused with a message rather than freezing the app.

import { openZip, makeZip, ZipError } from './zip.js';
import { saxParse, parseTree, find, kids, textOf, esc, XmlError } from './xml.js';
import { Workbook } from '../engine/workbook.js';
import { keyOf, colName, colIndex, parseA1, MAX_ROWS, MAX_COLS } from '../engine/address.js';
import { err, ERROR_CODES, CellError, msToSerial } from '../engine/values.js';
import { BUILTIN_FORMATS, isDateFormat } from '../engine/format.js';
import { shiftFormula } from '../engine/references.js';
import { tokenize, untokenize } from '../engine/formula.js';

export const MAX_XLSX_CELLS = 5000000;
export class XlsxError extends Error {}

const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];
const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

// Functions newer than the 2007 file format are stored with an "_xlfn." prefix
const FUTURE = new Set(['CEILING.MATH', 'CONCAT', 'COVARIANCE.P', 'COVARIANCE.S', 'DAYS', 'FLOOR.MATH', 'IFNA', 'IFS', 'MAXIFS', 'MINIFS',
  'MODE.SNGL', 'PERCENTILE.INC', 'QUARTILE.INC', 'RANK.AVG', 'RANK.EQ', 'STDEV.P', 'STDEV.S', 'SWITCH', 'TEXTAFTER', 'TEXTBEFORE',
  'TEXTJOIN', 'UNICHAR', 'VAR.P', 'VAR.S', 'XLOOKUP', 'XOR']);
/** MetaCode's own functions: other spreadsheet apps show #NAME? for them */
export const METACODE_ONLY = ['PERCENTAGREEMENT', 'COHENKAPPA', 'WEIGHTEDKAPPA', 'KRIPPENDORFF'];

/**
 * Rewrites function names in a formula's text (tokens keep everything else as is)
 * @param {string} f formula without "=" @param {(name: string) => string} fn
 */
function mapFunctionNames(f, fn) {
  let toks;
  try { toks = tokenize(f); } catch { return f; }
  let changed = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'name' || !toks[i + 1] || toks[i + 1].t !== 'lparen') continue;
    const s = fn(t.s);
    if (s !== t.s) { t.s = s; changed = true; }
  }
  return changed ? untokenize(toks) : f;
}
/** File formula → app formula ("_xlfn.IFS(" → "IFS(") @param {string} f */
const fromFileFormula = f => (/_xl(fn|ws)\./i.test(f) ? mapFunctionNames(f, n => n.replace(/^(_xlfn\.|_xlws\.)+/i, '')) : f);
/** App formula → file formula @param {string} f */
const toFileFormula = f => mapFunctionNames(f, n => (FUTURE.has(n.toUpperCase()) ? '_xlfn.' + n : n));

/**
 * Things an .xlsx copy of the workbook loses in other apps (for a note when exporting)
 * @param {Workbook} wb
 */
export function exportNotes(wb) {
  const used = new Set();
  const re = new RegExp('\\b(' + METACODE_ONLY.join('|') + ')\\s*\\(', 'gi');
  for (const s of wb.sheets) for (const c of s.cells.values()) {
    if (!c.f) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(c.f))) used.add(m[1].toUpperCase());
  }
  return used.size ? ['MetaCode\'s own functions (' + Array.from(used).join(', ') + ') show #NAME? in other spreadsheet apps when they recalculate; the last results are saved with the file.'] : [];
}

/** Excel's column width (characters) ↔ pixels, for the default font @param {number} w */
const widthToPx = w => Math.round(w * 7 + 5);
/** @param {number} px */
const pxToWidth = px => Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
/** @param {number} pt */
const ptToPx = pt => Math.round(pt * 4 / 3);
/** @param {number} px */
const pxToPt = px => Math.round(px * 0.75 * 100) / 100;

/** Applies an Office tint to a colour @param {string} hex @param {number} tint */
function tinted(hex, tint) {
  if (!tint) return hex;
  const n = parseInt(hex, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (/** @type {number} */ c) => Math.round(tint < 0 ? c * (1 + tint) : c + (255 - c) * tint);
  r = f(r); g = f(g); b = f(b);
  return ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

/** A colour element (rgb, theme+tint or indexed) → "#RRGGBB" or null @param {Record<string, string> | undefined} a @param {string[]} theme */
function colorOf(a, theme) {
  if (!a) return null;
  if (a.rgb && /^[0-9A-Fa-f]{6,8}$/.test(a.rgb)) return '#' + a.rgb.slice(-6).toUpperCase();
  if (a.theme !== undefined && theme[Number(a.theme)]) return '#' + tinted(theme[Number(a.theme)], Number(a.tint) || 0);
  if (a.indexed !== undefined) { const i = Number(a.indexed); if (i === 64 || i === 65) return null; return INDEXED[i] ? '#' + INDEXED[i] : null; }
  return null;
}

/** "word/../x" style paths inside the archive @param {string} base @param {string} target */
function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
}

/**
 * Reads an .xlsx file.
 * @param {Uint8Array} bytes
 * @param {{ inflate: import('./zip.js').Inflate, name?: string, onProgress?: (fraction: number, message: string) => void, maxCells?: number }} o
 * @returns {Promise<{ workbook: Workbook, notes: string[] }>}
 */
export async function readXlsx(bytes, o) {
  const notes = [];
  const progress = o.onProgress || (() => {});
  let zip;
  try { zip = openZip(bytes, { inflate: o.inflate, maxEntryBytes: 512 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 }); }
  catch (e) { throw new XlsxError(e instanceof ZipError ? e.message : 'The file can\'t be opened as an .xlsx.'); }
  const wbXml = await zip.text('xl/workbook.xml');
  if (!wbXml) throw new XlsxError(zip.has('word/document.xml') ? 'This is a Word document, not a spreadsheet.' : 'This isn\'t an Excel workbook (.xlsx).');
  if (zip.names().some(n => /vbaProject\.bin$/i.test(n))) notes.push('The workbook\'s macros were ignored (MetaCode Sheets never runs macros).');
  try {
    const wbTree = parseTree(wbXml);
    const date1904 = (find(wbTree, 'workbookPr') || { attrs: /** @type {Record<string, string>} */ ({}) }).attrs.date1904;
    const is1904 = date1904 === '1' || date1904 === 'true';
    const relsXml = await zip.text('xl/_rels/workbook.xml.rels');
    /** @type {Record<string, string>} */
    const rels = {};
    if (relsXml) for (const r of kids(find(parseTree(relsXml), 'Relationships'), 'Relationship')) rels[r.attrs.Id] = resolvePath('xl/workbook.xml', r.attrs.Target);
    const sheetsNode = find(wbTree, 'sheets');
    const sheetDefs = kids(sheetsNode, 'sheet').map(s => ({ name: s.attrs.name || 'Sheet', path: rels[s.attrs.id] || '', state: s.attrs.state || 'visible' }));
    if (!sheetDefs.length) throw new XlsxError('The workbook has no sheets.');
    const activeTab = Number((find(wbTree, 'workbookView') || { attrs: /** @type {Record<string, string>} */ ({}) }).attrs.activeTab || 0);

    // Theme colours
    const theme = DEFAULT_THEME.slice();
    const themeXml = await zip.text('xl/theme/theme1.xml');
    if (themeXml) {
      const scheme = find(parseTree(themeXml), 'clrScheme');
      if (scheme) {
        const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
        order.forEach((nm, i) => {
          const el = kids(scheme, nm)[0];
          if (!el || !el.children[0]) return;
          const c = el.children[0];
          const v = c.attrs.lastClr || c.attrs.val;
          if (v && /^[0-9A-Fa-f]{6}$/.test(v)) theme[i] = v.toUpperCase();
        });
      }
    }

    // Shared strings
    /** @type {string[]} */
    const strings = [];
    const sst = await zip.text('xl/sharedStrings.xml');
    if (sst) {
      /** @type {string | null} */
      let cur = null;
      let inT = false, inRph = 0;
      saxParse(sst, {
        open(name) { if (name === 'si') cur = ''; else if (name === 'rPh') inRph++; else if (name === 't' && !inRph) inT = true; },
        close(name) { if (name === 'si') { strings.push(cur || ''); cur = null; } else if (name === 'rPh') inRph--; else if (name === 't') inT = false; },
        text(t) { if (inT && cur !== null) cur += t; }
      });
    }

    const wb = new Workbook({ name: o.name || 'Imported' });
    // Styles → style ids in the workbook
    /** @type {number[]} */
    const xfStyle = [];
    /** @type {boolean[]} */
    const xfIsDate = [];
    const stylesXml = await zip.text('xl/styles.xml');
    if (stylesXml) {
      const st = parseTree(stylesXml);
      /** @type {Record<string, string>} */
      const numFmts = {};
      for (const nf of kids(find(st, 'numFmts'), 'numFmt')) numFmts[nf.attrs.numFmtId] = nf.attrs.formatCode;
      const fonts = kids(find(st, 'fonts'), 'font').map(f => {
        const get = (/** @type {string} */ n) => kids(f, n)[0];
        const u = get('u');
        return {
          bold: !!get('b') && get('b').attrs.val !== '0' && get('b').attrs.val !== 'false',
          italic: !!get('i') && get('i').attrs.val !== '0' && get('i').attrs.val !== 'false',
          underline: !!u && u.attrs.val !== 'none',
          strike: !!get('strike') && get('strike').attrs.val !== '0',
          size: get('sz') ? Number(get('sz').attrs.val) : undefined,
          color: get('color') ? colorOf(get('color').attrs, theme) : null,
          family: get('name') ? get('name').attrs.val : undefined
        };
      });
      const fills = kids(find(st, 'fills'), 'fill').map(f => {
        const pf = kids(f, 'patternFill')[0];
        if (!pf || !pf.attrs.patternType || pf.attrs.patternType === 'none') return null;
        const fg = kids(pf, 'fgColor')[0];
        return colorOf(fg ? fg.attrs : undefined, theme);
      });
      const borders = kids(find(st, 'borders'), 'border').map(b => {
        /** @type {any} */
        const out = {};
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const el = kids(b, side)[0];
          if (!el || !el.attrs.style || el.attrs.style === 'none') continue;
          const style = /thick/.test(el.attrs.style) ? 'thick' : /medium/.test(el.attrs.style) ? 'medium' : /dash/i.test(el.attrs.style) ? 'dashed' : /dot|hair/.test(el.attrs.style) ? 'dotted' : el.attrs.style === 'double' ? 'double' : 'thin';
          const col = kids(el, 'color')[0];
          out[side] = { style, color: (col && colorOf(col.attrs, theme)) || '#000000' };
        }
        return Object.keys(out).length ? out : null;
      });
      for (const xf of kids(find(st, 'cellXfs'), 'xf')) {
        const a = xf.attrs;
        /** @type {any} */
        const s = {};
        const fmtId = Number(a.numFmtId || 0);
        const code = numFmts[fmtId] || BUILTIN_FORMATS[fmtId];
        if (code && code !== 'General') s.numFmt = code;
        const font = fonts[Number(a.fontId || 0)];
        if (font) {
          if (font.bold) s.bold = true; if (font.italic) s.italic = true; if (font.underline) s.underline = true; if (font.strike) s.strike = true;
          if (font.size && font.size !== 11) s.size = font.size;
          if (font.color && font.color !== '#000000') s.color = font.color;
          if (font.family && !/^(Calibri|Aptos|Aptos Narrow|Arial)$/.test(font.family)) s.family = font.family;
        }
        const fill = fills[Number(a.fillId || 0)];
        if (fill) s.fill = fill;
        const border = borders[Number(a.borderId || 0)];
        if (border) s.border = border;
        const al = kids(xf, 'alignment')[0];
        if (al) {
          if (['left', 'center', 'right'].includes(al.attrs.horizontal)) s.h = al.attrs.horizontal;
          else if (al.attrs.horizontal === 'centerContinuous') s.h = 'center';
          if (al.attrs.vertical === 'center') s.v = 'middle'; else if (al.attrs.vertical === 'top') s.v = 'top';
          if (al.attrs.wrapText === '1' || al.attrs.wrapText === 'true') s.wrap = true;
          if (Number(al.attrs.indent) > 0) s.indent = Math.min(15, Number(al.attrs.indent));
        }
        xfStyle.push(wb.styles.id(s));
        xfIsDate.push(!!code && isDateFormat(code));
      }
    }

    // Sheets
    let total = 0;
    const maxCells = o.maxCells || MAX_XLSX_CELLS;
    for (let si = 0; si < sheetDefs.length; si++) {
      const def = sheetDefs[si];
      progress(si / sheetDefs.length, 'Reading "' + def.name + '"…');
      const xml = def.path && /worksheets\//.test(def.path) ? await zip.text(def.path) : null;
      if (!xml) { notes.push('"' + def.name + '" isn\'t a worksheet (a chart or dialog sheet) and was skipped.'); continue; }
      let name = def.name.slice(0, 31).replace(/[\\/?*[\]:]/g, '_').replace(/^'+|'+$/g, '').trim() || 'Sheet' + (si + 1);
      if (wb.sheetByName(name)) name = wb.freeSheetName(name);
      const sheet = wb.addSheet(name);
      if (def.state !== 'visible') notes.push('"' + def.name + '" was a hidden sheet in the file; it\'s shown here.');
      /** @type {Map<string, { f: string, r: number, c: number }>} */
      const shared = new Map();
      let cur = /** @type {any} */ (null), inV = false, inF = false, inIsT = false, row = -1, colHint = 0, merged = 0;
      saxParse(xml, {
        open(nm, a) {
          switch (nm) {
            case 'row':
              row = a.r ? Number(a.r) - 1 : row + 1; colHint = 0;
              if (row >= 0 && row < MAX_ROWS) {
                if (a.ht && (a.customHeight === '1' || a.customHeight === 'true')) sheet.rowHeights.set(row, ptToPx(Number(a.ht)));
                if (a.hidden === '1' || a.hidden === 'true') sheet.hiddenRows.add(row);
              }
              break;
            case 'c': {
              const p = a.r ? parseA1(a.r) : { r: row, c: colHint };
              cur = { r: p ? p.r : row, c: p ? p.c : colHint, t: a.t || 'n', s: Number(a.s || 0), v: '', f: null, ft: null, ref: null, si: null, is: '' };
              colHint = cur.c + 1;
              break;
            }
            case 'v': inV = true; break;
            case 'f': if (cur) { inF = true; cur.f = ''; cur.ft = a.t || null; cur.ref = a.ref || null; cur.si = a.si === undefined ? null : a.si; } break;
            case 't': if (cur && cur.t === 'inlineStr') inIsT = true; break;
            case 'col': {
              const lo = Number(a.min) - 1, hi = Math.min(Number(a.max) - 1, MAX_COLS - 1);
              if (!(lo >= 0) || hi < lo || hi - lo > 16384) break;
              for (let c = lo; c <= hi; c++) {
                if (a.width && (a.customWidth === '1' || a.customWidth === 'true' || Math.abs(Number(a.width) - 8.43) > 0.5)) sheet.colWidths.set(c, widthToPx(Number(a.width)));
                if (a.hidden === '1' || a.hidden === 'true') sheet.hiddenCols.add(c);
              }
              break;
            }
            case 'pane':
              if (a.state === 'frozen' || a.state === 'frozenSplit') sheet.freeze = { rows: Math.min(1000, Number(a.ySplit || 0)), cols: Math.min(100, Number(a.xSplit || 0)) };
              break;
            case 'tabColor': { const col = colorOf(a, theme); if (col) sheet.tabColor = col; break; }
            case 'autoFilter': {
              const m = /^([A-Z]+\d+):([A-Z]+\d+)$/i.exec(a.ref || '');
              if (m) { const p1 = parseA1(m[1]), p2 = parseA1(m[2]); if (p1 && p2) sheet.filter = { range: { r1: p1.r, c1: p1.c, r2: p2.r, c2: p2.c }, conditions: {} }; }
              break;
            }
            case 'mergeCell': merged++; break;
            default: break;
          }
        },
        text(t) { if (!cur) return; if (inV) cur.v += t; else if (inF) cur.f += t; else if (inIsT) cur.is += t; },
        close(nm) {
          if (nm === 'v') inV = false;
          else if (nm === 'f') inF = false;
          else if (nm === 't') inIsT = false;
          else if (nm === 'c' && cur) {
            const c = cur;
            cur = null;
            if (c.r < 0 || c.r >= MAX_ROWS || c.c < 0 || c.c >= MAX_COLS) return;
            if (++total > maxCells) throw new XlsxError('The workbook has more than ' + maxCells.toLocaleString('en-US') + ' cells — too many to open here.');
            /** @type {any} */
            let value = null;
            switch (c.t) {
              case 's': value = strings[Number(c.v)] === undefined ? '' : strings[Number(c.v)]; break;
              case 'str': value = c.v; break;
              case 'inlineStr': value = c.is; break;
              case 'b': value = c.v === '1' || c.v === 'true'; break;
              case 'e': value = ERROR_CODES.includes(c.v) ? err(c.v) : err('#VALUE!'); break;
              case 'd': { const t = Date.parse(c.v); value = Number.isFinite(t) ? msToSerial(t) : c.v; break; }
              default: value = c.v === '' ? null : Number(c.v); if (typeof value === 'number' && !Number.isFinite(value)) value = null;
            }
            if (typeof value === 'number' && is1904 && xfIsDate[c.s]) value += 1462;
            let formula = null;
            if (c.f !== null) {
              if (c.ft === 'shared' && c.si !== null) {
                if (c.f) { formula = '=' + fromFileFormula(c.f); shared.set(c.si, { f: formula, r: c.r, c: c.c }); }
                else { const base = shared.get(c.si); if (base) formula = shiftFormula(base.f, c.r - base.r, c.c - base.c); }
              } else if (c.f) formula = '=' + fromFileFormula(c.f);
            }
            const style = xfStyle[c.s] || undefined;
            if (value === null && !formula && !style) return;
            /** @type {any} */
            const cell = { v: value };
            if (formula && formula.length <= 8192) cell.f = formula;
            if (style) cell.s = style;
            sheet.cells.set(keyOf(c.r, c.c), cell);
          }
        }
      });
      sheet._bounds = null;
      if (merged) notes.push('"' + def.name + '" has ' + merged + ' merged cell range' + (merged === 1 ? '' : 's') + '; merged cells are shown unmerged, with the value in the top-left cell.');
    }
    if (!wb.sheets.length) throw new XlsxError('The workbook has no worksheets (only charts or dialogs).');
    const activeDef = sheetDefs[activeTab];
    wb.activeSheetId = ((activeDef && wb.sheets.find(x => x.name === activeDef.name)) || wb.sheets[0]).id;
    progress(0.95, 'Calculating…');
    wb.calc.rebuild();
    wb.calc.recalcAll();
    const unknown = new Set();
    for (const s of wb.sheets) for (const c of s.cells.values()) if (c.f && c.v instanceof CellError && c.v.code === '#NAME?' && /Unknown function/.test(c.v.detail || '')) unknown.add((c.v.detail || '').replace('Unknown function ', ''));
    if (unknown.size) notes.push('Functions MetaCode Sheets doesn\'t have yet show #NAME?: ' + Array.from(unknown).slice(0, 12).join(', ') + (unknown.size > 12 ? '…' : '') + '.');
    progress(1, 'Done');
    return { workbook: wb, notes };
  } catch (e) {
    if (e instanceof XlsxError) throw e;
    if (e instanceof XmlError || e instanceof ZipError) throw new XlsxError('The file is damaged: ' + e.message);
    throw e;
  }
}

/**
 * Writes a workbook as .xlsx.
 * @param {Workbook} wb
 * @param {{ deflate: import('./zip.js').Deflate, creator?: string }} o
 * @returns {Promise<Uint8Array>}
 */
export async function writeXlsx(wb, o) {
  // Styles: our style ids → cellXfs index
  /** @type {Map<string, number>} */ const fontIdx = new Map(), fillIdx = new Map(), borderIdx = new Map(), fmtIdx = new Map(), xfIdx = new Map();
  /** @type {string[]} */ const fontsX = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  const fillsX = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const bordersX = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  /** @type {string[]} */ const fmtsX = [];
  const xfsX = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  fontIdx.set('{}', 0); fillIdx.set('', 0); borderIdx.set('', 0); xfIdx.set('0', 0);
  const builtinByCode = new Map(Object.entries(BUILTIN_FORMATS).map(([id, code]) => [code, Number(id)]));
  /** @type {Map<number, number>} */
  const styleToXf = new Map([[0, 0]]);
  /** @param {number | undefined} id */
  const xfOf = id => {
    if (!id) return 0;
    const hit = styleToXf.get(id);
    if (hit !== undefined) return hit;
    const s = wb.styles.get(id);
    const fontKey = JSON.stringify({ b: s.bold, i: s.italic, u: s.underline, st: s.strike, sz: s.size, c: s.color, f: s.family });
    let font = fontIdx.get(fontKey);
    if (font === undefined) {
      font = fontsX.length; fontIdx.set(fontKey, font);
      fontsX.push('<font>' + (s.bold ? '<b/>' : '') + (s.italic ? '<i/>' : '') + (s.strike ? '<strike/>' : '') + (s.underline ? '<u/>' : '') +
        '<sz val="' + (s.size || 11) + '"/>' + (s.color ? '<color rgb="FF' + s.color.slice(1) + '"/>' : '') + '<name val="' + esc(s.family || 'Calibri') + '"/><family val="2"/></font>');
    }
    let fill = fillIdx.get(s.fill || '');
    if (fill === undefined) { fill = fillsX.length; fillIdx.set(/** @type {string} */ (s.fill), fill); fillsX.push('<fill><patternFill patternType="solid"><fgColor rgb="FF' + /** @type {string} */ (s.fill).slice(1) + '"/><bgColor indexed="64"/></patternFill></fill>'); }
    const bKey = s.border ? JSON.stringify(s.border) : '';
    let border = borderIdx.get(bKey);
    if (border === undefined) {
      border = bordersX.length; borderIdx.set(bKey, border);
      const side = (/** @type {string} */ nm) => { const b = s.border && /** @type {any} */ (s.border)[nm]; return b ? '<' + nm + ' style="' + b.style + '"><color rgb="FF' + String(b.color || '#000000').slice(1) + '"/></' + nm + '>' : '<' + nm + '/>'; };
      bordersX.push('<border>' + side('left') + side('right') + side('top') + side('bottom') + '<diagonal/></border>');
    }
    let fmt = 0;
    if (s.numFmt) {
      const b = builtinByCode.get(s.numFmt);
      if (b !== undefined) fmt = b;
      else { let f = fmtIdx.get(s.numFmt); if (f === undefined) { f = 164 + fmtsX.length; fmtIdx.set(s.numFmt, f); fmtsX.push('<numFmt numFmtId="' + f + '" formatCode="' + esc(s.numFmt) + '"/>'); } fmt = f; }
    }
    const align = s.h || s.v || s.wrap || s.indent ? '<alignment' + (s.h ? ' horizontal="' + s.h + '"' : '') + (s.v ? ' vertical="' + (s.v === 'middle' ? 'center' : s.v) + '"' : '') + (s.wrap ? ' wrapText="1"' : '') + (s.indent ? ' indent="' + s.indent + '"' : '') + '/>' : '';
    const xfKey = [fmt, font, fill, border, align].join('|');
    let xf = xfIdx.get(xfKey);
    if (xf === undefined) {
      xf = xfsX.length; xfIdx.set(xfKey, xf);
      xfsX.push('<xf numFmtId="' + fmt + '" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '" xfId="0"' + (fmt ? ' applyNumberFormat="1"' : '') + (font ? ' applyFont="1"' : '') + (fill ? ' applyFill="1"' : '') + (border ? ' applyBorder="1"' : '') + (align ? ' applyAlignment="1">' + align + '</xf>' : '/>'));
    }
    styleToXf.set(id, xf);
    return xf;
  };

  /** @type {Map<string, number>} */
  const sstIdx = new Map();
  /** @type {string[]} */
  const sst = [];
  let sstCount = 0;
  /** @param {string} s */
  const sIndex = s => { sstCount++; let i = sstIdx.get(s); if (i === undefined) { i = sst.length; sstIdx.set(s, i); sst.push(s); } return i; };

  const sheetFiles = [];
  for (let si = 0; si < wb.sheets.length; si++) {
    const s = wb.sheets[si];
    const b = s.bounds();
    const keys = Array.from(s.cells.keys()).sort((x, y) => x - y);
    const parts = [];
    let curRow = -1, rowCells = '';
    const rowAttrs = (/** @type {number} */ r) => {
      const h = s.rowHeights.get(r);
      return '<row r="' + (r + 1) + '"' + (h ? ' ht="' + pxToPt(h) + '" customHeight="1"' : '') + (s.hiddenRows.has(r) ? ' hidden="1"' : '') + '>';
    };
    const flushRow = () => { if (curRow >= 0) parts.push(rowAttrs(curRow) + rowCells + '</row>'); rowCells = ''; };
    // rows with only a height or hidden flag (no cells) still need a <row>
    const extraRows = new Set([...s.rowHeights.keys(), ...s.hiddenRows]);
    const rowsWithCells = new Set(keys.map(k => Math.floor(k / MAX_COLS)));
    const lonely = Array.from(extraRows).filter(r => !rowsWithCells.has(r));
    let li = 0;
    lonely.sort((x, y) => x - y);
    for (const k of keys) {
      const r = Math.floor(k / MAX_COLS), c = k % MAX_COLS;
      if (r !== curRow) {
        flushRow();
        while (li < lonely.length && lonely[li] < r) { parts.push(rowAttrs(lonely[li]) + '</row>'); li++; }
        curRow = r;
      }
      const cell = /** @type {any} */ (s.cells.get(k));
      const ref = colName(c) + (r + 1);
      const xf = xfOf(cell.s);
      const sAttr = xf ? ' s="' + xf + '"' : '';
      const v = cell.v;
      if (cell.f) {
        const f = '<f>' + esc(toFileFormula(cell.f.slice(1))) + '</f>';
        if (v instanceof CellError) rowCells += '<c r="' + ref + '"' + sAttr + ' t="e">' + f + '<v>' + esc(v.code) + '</v></c>';
        else if (typeof v === 'string') rowCells += '<c r="' + ref + '"' + sAttr + ' t="str">' + f + '<v>' + esc(v) + '</v></c>';
        else if (typeof v === 'boolean') rowCells += '<c r="' + ref + '"' + sAttr + ' t="b">' + f + '<v>' + (v ? 1 : 0) + '</v></c>';
        else rowCells += '<c r="' + ref + '"' + sAttr + '>' + f + (typeof v === 'number' ? '<v>' + v + '</v>' : '') + '</c>';
        continue;
      }
      if (v === null || v === undefined) rowCells += '<c r="' + ref + '"' + sAttr + '/>';
      else if (typeof v === 'number') rowCells += '<c r="' + ref + '"' + sAttr + '><v>' + v + '</v></c>';
      else if (typeof v === 'boolean') rowCells += '<c r="' + ref + '"' + sAttr + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
      else if (v instanceof CellError) rowCells += '<c r="' + ref + '"' + sAttr + ' t="e"><v>' + esc(v.code) + '</v></c>';
      else rowCells += '<c r="' + ref + '"' + sAttr + ' t="s"><v>' + sIndex(String(v)) + '</v></c>';
    }
    flushRow();
    while (li < lonely.length) { parts.push(rowAttrs(lonely[li]) + '</row>'); li++; }
    // Columns: widths and hidden, grouped into runs
    const colKeys = Array.from(new Set([...s.colWidths.keys(), ...s.hiddenCols])).sort((x, y) => x - y);
    let cols = '';
    for (let i = 0; i < colKeys.length;) {
      const c0 = colKeys[i];
      const w = s.colWidths.get(c0), h = s.hiddenCols.has(c0);
      let j = i;
      while (j + 1 < colKeys.length && colKeys[j + 1] === colKeys[j] + 1 && s.colWidths.get(colKeys[j + 1]) === w && s.hiddenCols.has(colKeys[j + 1]) === h) j++;
      cols += '<col min="' + (c0 + 1) + '" max="' + (colKeys[j] + 1) + '" width="' + pxToWidth(w || 100) + '"' + (w ? ' customWidth="1"' : '') + (h ? ' hidden="1"' : '') + '/>';
      i = j + 1;
    }
    const fz = s.freeze;
    const pane = fz.rows || fz.cols
      ? '<pane' + (fz.cols ? ' xSplit="' + fz.cols + '"' : '') + (fz.rows ? ' ySplit="' + fz.rows + '"' : '') + ' topLeftCell="' + colName(fz.cols) + (fz.rows + 1) + '" activePane="' + (fz.rows && fz.cols ? 'bottomRight' : fz.rows ? 'bottomLeft' : 'topRight') + '" state="frozen"/>'
      : '';
    const dim = b.maxRow >= 0 ? 'A1:' + colName(Math.max(0, b.maxCol)) + (b.maxRow + 1) : 'A1';
    const filter = s.filter ? '<autoFilter ref="' + colName(s.filter.range.c1) + (s.filter.range.r1 + 1) + ':' + colName(s.filter.range.c2) + (s.filter.range.r2 + 1) + '"/>' : '';
    sheetFiles.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      (s.tabColor ? '<sheetPr><tabColor rgb="FF' + s.tabColor.slice(1) + '"/></sheetPr>' : '') +
      '<dimension ref="' + dim + '"/><sheetViews><sheetView workbookViewId="0"' + (wb.activeSheetId === s.id ? ' tabSelected="1"' : '') + '>' + pane + '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' + (cols ? '<cols>' + cols + '</cols>' : '') +
      '<sheetData>' + parts.join('') + '</sheetData>' + filter + '</worksheet>');
  }

  const nSheets = wb.sheets.length;
  const activeTab = Math.max(0, wb.sheets.findIndex(s => s.id === wb.activeSheetId));
  const definedNames = wb.sheets.map((s, i) => (s.filter ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">' + esc(sheetRefForName(s.name)) + '!$' + colName(s.filter.range.c1) + '$' + (s.filter.range.r1 + 1) + ':$' + colName(s.filter.range.c2) + '$' + (s.filter.range.r2 + 1) + '</definedName>' : '')).join('');
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      wb.sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
    { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>' + esc(o.creator || 'MetaCode Sheets') + '</Application></Properties>' },
    { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + esc(wb.name) + '</dc:title><dc:creator>' + esc(o.creator || 'MetaCode Sheets') + '</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</dcterms:created></cp:coreProperties>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="' + activeTab + '"/></bookViews><sheets>' +
      wb.sheets.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' + (definedNames ? '<definedNames>' + definedNames + '</definedNames>' : '') + '<calcPr calcId="191029"/></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      wb.sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (nSheets + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId' + (nSheets + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>' },
    ...sheetFiles.map((data, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data }))
  ];
  // Styles and shared strings last: the sheets above filled their tables
  files.push({ name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (fmtsX.length ? '<numFmts count="' + fmtsX.length + '">' + fmtsX.join('') + '</numFmts>' : '') +
    '<fonts count="' + fontsX.length + '">' + fontsX.join('') + '</fonts><fills count="' + fillsX.length + '">' + fillsX.join('') + '</fills><borders count="' + bordersX.length + '">' + bordersX.join('') + '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="' + xfsX.length + '">' + xfsX.join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });
  files.push({ name: 'xl/sharedStrings.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + sstCount + '" uniqueCount="' + sst.length + '">' +
    sst.map(t => '<si><t' + (/^\s|\s$|\n/.test(t) ? ' xml:space="preserve"' : '') + '>' + esc(t) + '</t></si>').join('') + '</sst>' });
  return makeZip(files, { deflate: o.deflate });
}

/** @param {string} name */
function sheetRefForName(name) { return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : "'" + name.replace(/'/g, "''") + "'"; }

export { colIndex };
