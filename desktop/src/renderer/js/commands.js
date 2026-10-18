// @ts-check
// ── Commands: menu items, toolbar buttons, shortcuts and context menus ────────
// One table, so the menu, the toolbar and the keyboard always do the same thing.
import * as E from '../../shared/engine/index.js';
import { showMenu, toast, errText, prompt } from './ui.js';
import * as D from './dialogs.js';

const { ops } = E;
const sheets = /** @type {any} */ (window).sheets;

/** @typedef {import('./workspace.js').Workspace} Workspace */

/** The block of filled cells around (r, c), like Excel's "current region" @param {any} sheet @param {number} r @param {number} c */
export function currentRegion(sheet, r, c) {
  const filled = (/** @type {number} */ rr, /** @type {number} */ cc) => { if (rr < 0 || cc < 0) return false; const cell = sheet.cells.get(E.keyOf(rr, cc)); return !!cell && cell.v !== null && cell.v !== undefined && cell.v !== ''; };
  let g = { r1: r, c1: c, r2: r, c2: c };
  for (let iter = 0; iter < 50; iter++) {
    let grew = false;
    const rowHas = (/** @type {number} */ rr) => { for (let cc = g.c1 - 1; cc <= g.c2 + 1; cc++) if (filled(rr, cc)) return true; return false; };
    const colHas = (/** @type {number} */ cc) => { for (let rr = g.r1 - 1; rr <= g.r2 + 1; rr++) if (filled(rr, cc)) return true; return false; };
    while (g.r1 > 0 && rowHas(g.r1 - 1)) { g.r1--; grew = true; }
    while (g.r2 < E.MAX_ROWS - 1 && rowHas(g.r2 + 1)) { g.r2++; grew = true; if (g.r2 - g.r1 > 2000000) break; }
    while (g.c1 > 0 && colHas(g.c1 - 1)) { g.c1--; grew = true; }
    while (g.c2 < E.MAX_COLS - 1 && colHas(g.c2 + 1)) { g.c2++; grew = true; if (g.c2 - g.c1 > 16000) break; }
    if (!grew) break;
  }
  return g;
}

/** Whether the first row of a range looks like a header: all text, over data @param {any} wb @param {any} sheet @param {any} g */
export function looksLikeHeader(wb, sheet, g) {
  if (g.r2 <= g.r1) return false;
  if (sheet.filter && sheet.filter.range.r1 === g.r1) return true;
  let filled = 0, text = 0, typeChange = 0, cols = 0;
  for (let c = g.c1; c <= Math.min(g.c2, g.c1 + 50); c++) {
    cols++;
    const top = wb.valueAt(sheet, g.r1, c), next = wb.valueAt(sheet, g.r1 + 1, c);
    if (top === null || top === '') continue;
    filled++;
    if (typeof top === 'string') { text++; if (typeof next === 'number' || typeof next === 'boolean') typeChange++; }
  }
  return filled > 0 && text === filled && (typeChange > 0 || filled === cols);
}

/** The range to sort or filter: the selection if it's a block, else the region around the active cell @param {Workspace} ws */
function dataRange(ws) {
  const g = ws.oneRange('This');
  if (!g) return null;
  if (g.r1 !== g.r2 || g.c1 !== g.c2) {
    const b = ws.sheet.bounds();
    return { r1: g.r1, c1: g.c1, r2: Math.min(g.r2, Math.max(b.maxRow, g.r1)), c2: Math.min(g.c2, Math.max(b.maxCol, g.c1)) };
  }
  if (ws.sheet.filter && E.inRange(ws.sheet.filter.range, g.r1, g.c1)) return Object.assign({}, ws.sheet.filter.range, { r2: Math.max(ws.sheet.filter.range.r2, ws.sheet.bounds().maxRow) });
  return ws.region();
}

/** @param {Workspace} ws @param {boolean} desc */
function quickSort(ws, desc) {
  const g = dataRange(ws);
  if (!g) return;
  const header = looksLikeHeader(ws.wb, ws.sheet, g);
  const col = Math.max(g.c1, Math.min(g.c2, ws.sel.active.c));
  ws.exec(ops.sortRange(ws.wb, ws.sheet, g, [{ col, desc }], header));
  if (ws.sheet.filter) ops.applyFilter(ws.wb, ws.sheet);
  toast('Sorted ' + (g.r2 - g.r1 + (header ? 0 : 1)) + ' rows by column ' + E.colName(col) + (header ? ' (the header row stayed on top)' : '') + '.');
}

/** @param {Workspace} ws @param {'row' | 'col'} axis @param {boolean} after @param {boolean} [del] */
function insertDelete(ws, axis, after, del) {
  const g = ws.oneRange(del ? 'Deleting' : 'Inserting');
  if (!g) return;
  const lo = axis === 'row' ? g.r1 : g.c1, hi = axis === 'row' ? Math.min(g.r2, E.MAX_ROWS - 1) : Math.min(g.c2, E.MAX_COLS - 1);
  const count = Math.min(hi - lo + 1, axis === 'row' ? 100000 : 1000);
  try {
    if (del) ws.exec(ops.insertDelete(ws.wb, ws.sheet, axis, lo, -count));
    else ws.exec(ops.insertDelete(ws.wb, ws.sheet, axis, after ? hi + 1 : lo, count));
    ws.grid.axisCache.key = '';
    ws.grid.layout();
  } catch (e) { toast(errText(e), { kind: 'error' }); }
}

/** Indexes of the rows/columns the selection covers @param {Workspace} ws @param {'row' | 'col'} axis */
function selectedIndexes(ws, axis) {
  const out = new Set();
  for (const g of ws.ranges()) {
    const lo = axis === 'row' ? g.r1 : g.c1, hi = Math.min(axis === 'row' ? g.r2 : g.c2, lo + (axis === 'row' ? 100000 : 16384));
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return Array.from(out);
}

/** @param {Workspace} ws @param {string} prop */
function toggleStyle(ws, prop) { ws.styleSel({ [prop]: ws.activeStyle()[prop] ? null : true }); }
/** @param {Workspace} ws @param {string} h */
function align(ws, h) { ws.styleSel({ h: ws.activeStyle().h === h ? null : h }); }
/** @param {Workspace} ws @param {string | null} fmt */
const numFmt = (ws, fmt) => ws.styleSel({ numFmt: fmt });

/** @param {Workspace} ws @param {number} delta */
function decimals(ws, delta) {
  const a = ws.sel.active;
  const cell = ws.sheet.get(a.r, a.c);
  const cur = ws.activeStyle().numFmt || 'General';
  const v = cell ? cell.v : null;
  ws.styleSel({ numFmt: E.changeDecimals(cur, delta, typeof v === 'number' ? v : undefined) });
}

/** @param {Workspace} ws */
function freezeMenu(ws) {
  const b = /** @type {HTMLElement} */ (ws.toolbar.querySelector('[data-cmd="freezeMenu"]'));
  const r = b ? b.getBoundingClientRect() : { left: 200, bottom: 100 };
  const a = ws.sel.active;
  showMenu([
    { label: 'Freeze top row', run: () => COMMANDS.freezeTop(ws) },
    { label: 'Freeze first column', run: () => ws.exec(ops.freeze(ws.wb, ws.sheet, ws.sheet.freeze.rows, 1)) },
    { label: 'Freeze up to row ' + (a.r) + (a.r ? '' : ' (select a lower cell)'), disabled: !a.r, run: () => COMMANDS.freezeRows(ws) },
    { label: 'Freeze up to column ' + (a.c ? E.colName(a.c - 1) : '— (select a cell further right)'), disabled: !a.c, run: () => COMMANDS.freezeCols(ws) },
    '-', { label: 'Unfreeze', disabled: !ws.sheet.freeze.rows && !ws.sheet.freeze.cols, run: () => COMMANDS.unfreeze(ws) }
  ], { x: r.left, y: r.bottom + 4 });
}

/** Removes rows whose values in the chosen columns repeat an earlier row @param {Workspace} ws @param {any} g @param {number[]} cols @param {boolean} header */
export function removeDuplicates(ws, g, cols, header) {
  const wb = ws.wb, sheet = ws.sheet;
  const before = E.snapshot(wb);
  const first = g.r1 + (header ? 1 : 0);
  const seen = new Set();
  const keep = [];
  let removed = 0;
  for (let r = first; r <= g.r2; r++) {
    const key = JSON.stringify(cols.map(c => { const v = wb.valueAt(sheet, r, c); return v instanceof E.CellError ? '#' + v.code : typeof v === 'string' ? v.trim().toLowerCase() : v; }));
    if (seen.has(key)) { removed++; continue; }
    seen.add(key);
    const row = [];
    for (let c = g.c1; c <= g.c2; c++) row.push(sheet.get(r, c) || null);
    keep.push({ r, row });
  }
  if (!removed) return 0;
  keep.forEach((k, i) => {
    const r = first + i;
    k.row.forEach((cell, j) => wb.setCell(sheet, r, g.c1 + j, cell ? Object.assign({}, cell, cell.f ? { f: E.shiftFormula(cell.f, r - k.r, 0) } : {}) : null));
  });
  for (let r = first + keep.length; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) wb.setCell(sheet, r, c, null);
  wb.calc.rebuild();
  wb.calc.recalcAll();
  wb.changed({ type: 'structure', sheet });
  ws.exec({ type: 'snapshot', before, after: E.snapshot(wb), label: 'Remove duplicates' });
  return removed;
}

/** @type {Record<string, (ws: Workspace, arg?: any) => any>} */
export const COMMANDS = {
  // workbook (handled by the app: tabs, files)
  new: ws => ws.app.newWorkbook(),
  open: ws => ws.app.openDialog(),
  home: ws => ws.app.showHome(),
  import: ws => ws.app.importDialog(),
  save: ws => ws.app.saveDoc(ws.doc),
  saveAs: async ws => { const r = await ws.doc.saveAs(); if (r === 'saved') toast('Saved as "' + ws.doc.name + '".'); ws.app.renderTabs(); },
  renameWorkbook: ws => ws.app.renameDoc(ws.doc),
  duplicateWorkbook: ws => ws.app.duplicateDoc(ws.doc),
  exportXlsx: ws => ws.app.exportXlsx(ws.doc),
  exportCsv: ws => ws.app.exportDelimited(ws.doc, 'csv'),
  exportTsv: ws => ws.app.exportDelimited(ws.doc, 'tsv'),
  closeTab: ws => ws.app.closeDoc(ws.doc),
  settings: ws => D.settingsDialog(ws.app),
  about: ws => D.aboutDialog(ws.app),
  account: ws => ws.app.accountMenu(null),
  upgrade: () => sheets.openExternal({ target: 'upgrade' }),
  website: () => sheets.openExternal({ target: 'website' }),
  shortcuts: () => D.shortcutsDialog(),
  functionsHelp: ws => D.insertFunctionDialog(ws, false),

  // edit
  undo: ws => {
    if (ws.grid.editing) { document.execCommand('undo'); return; }
    const step = ws.doc.history.undo(ws.wb);
    if (!step) return;
    ws.grid.sheetChanged();
    if (step.select) ws.grid.setSelection(step.select, { r: step.select[0].r1, c: step.select[0].c1 });
    ws.renderSheetTabs(); ws.updateToolbar(); ws.updateFormulaBar();
    toast('Undid ' + step.label.toLowerCase(), { ms: 1500 });
  },
  redo: ws => {
    if (ws.grid.editing) { document.execCommand('redo'); return; }
    const step = ws.doc.history.redo(ws.wb);
    if (!step) return;
    ws.grid.sheetChanged();
    ws.renderSheetTabs(); ws.updateToolbar(); ws.updateFormulaBar();
    toast('Redid ' + step.label.toLowerCase(), { ms: 1500 });
  },
  copy: ws => ws.copy(null, false),
  cut: ws => ws.copy(null, true),
  paste: async ws => { const c = await sheets.readClipboard(); ws.paste(c.text, 'all'); },
  pasteValues: async ws => { const c = await sheets.readClipboard(); ws.paste(c.text, 'values'); },
  clear: ws => ws.exec(ops.clearRanges(ws.wb, ws.sheet, ws.ranges(), 'contents')),
  clearAll: ws => ws.exec(ops.clearRanges(ws.wb, ws.sheet, ws.ranges(), 'all')),
  selectAll: ws => {
    const a = ws.sel.active;
    const region = currentRegion(ws.sheet, a.r, a.c);
    const g = ws.ranges()[0];
    const isRegion = g.r1 === region.r1 && g.c1 === region.c1 && g.r2 === region.r2 && g.c2 === region.c2;
    if (!isRegion && (region.r1 !== region.r2 || region.c1 !== region.c2)) ws.grid.setSelection([region], a, a);
    else ws.grid.setSelection([{ r1: 0, c1: 0, r2: E.MAX_ROWS - 1, c2: E.MAX_COLS - 1 }], a, a);
  },
  fillDown: ws => { const g = ws.oneRange('Fill down'); if (!g || g.r2 === g.r1) return; ws.exec(ops.fill(ws.wb, ws.sheet, { r1: g.r1, c1: g.c1, r2: g.r1, c2: g.c2 }, g)); },
  fillRight: ws => { const g = ws.oneRange('Fill right'); if (!g || g.c2 === g.c1) return; ws.exec(ops.fill(ws.wb, ws.sheet, { r1: g.r1, c1: g.c1, r2: g.r2, c2: g.c1 }, g)); },
  fillDownToData: ws => {
    // double-click on the fill handle: down as far as the column next to it has data
    const g = ws.ranges()[0];
    const s = ws.sheet;
    const side = g.c1 > 0 ? g.c1 - 1 : g.c2 + 1;
    let r = g.r2;
    while (r + 1 < E.MAX_ROWS && ws.wb.valueAt(s, r + 1, side) !== null && ws.wb.valueAt(s, r + 1, side) !== '') r++;
    if (r === g.r2) return;
    const dest = { r1: g.r1, c1: g.c1, r2: r, c2: g.c2 };
    ws.exec(ops.fill(ws.wb, s, g, dest));
    ws.grid.setSelection([dest], ws.sel.active);
  },
  find: ws => D.findPanel(ws, false),
  replace: ws => D.findPanel(ws, true),

  // view
  toggleSidebar: ws => { ws.sidebarEl.hidden = !ws.sidebarEl.hidden; sheets.setSettings({ sidebar: !ws.sidebarEl.hidden }); ws.grid.layout(); ws.updateToolbar(); },
  toggleFormulaBar: ws => { ws.formulaBar.hidden = !ws.formulaBar.hidden; sheets.setSettings({ formulaBar: !ws.formulaBar.hidden }); },
  toggleGridlines: ws => { ws.grid.gridlines = !ws.grid.gridlines; sheets.setSettings({ gridlines: ws.grid.gridlines }); ws.grid.invalidate(); },
  toggleFormulas: ws => { ws.grid.showFormulas = !ws.grid.showFormulas; ws.grid.invalidate(); },
  freezeMenu: ws => freezeMenu(ws),
  freezeTop: ws => ws.exec(ops.freeze(ws.wb, ws.sheet, 1, ws.sheet.freeze.cols)),
  freezeRows: ws => ws.exec(ops.freeze(ws.wb, ws.sheet, ws.sel.active.r, ws.sheet.freeze.cols)),
  freezeCols: ws => ws.exec(ops.freeze(ws.wb, ws.sheet, ws.sheet.freeze.rows, ws.sel.active.c)),
  unfreeze: ws => ws.exec(ops.freeze(ws.wb, ws.sheet, 0, 0)),
  zoomIn: ws => { ws.grid.setZoom(Math.round((ws.grid.zoom + 0.1) * 10) / 10); ws.updateStatus(); },
  zoomOut: ws => { ws.grid.setZoom(Math.round((ws.grid.zoom - 0.1) * 10) / 10); ws.updateStatus(); },
  zoomReset: ws => { ws.grid.setZoom(1); ws.updateStatus(); },
  themeSystem: ws => ws.app.setTheme('system'),
  themeLight: ws => ws.app.setTheme('light'),
  themeDark: ws => ws.app.setTheme('dark'),
  nextSheet: ws => { const i = ws.wb.sheets.indexOf(ws.sheet); ws.activateSheet(ws.wb.sheets[(i + 1) % ws.wb.sheets.length].id); },
  prevSheet: ws => { const i = ws.wb.sheets.indexOf(ws.sheet); ws.activateSheet(ws.wb.sheets[(i - 1 + ws.wb.sheets.length) % ws.wb.sheets.length].id); },

  // insert
  insertRowAbove: ws => insertDelete(ws, 'row', false),
  insertRowBelow: ws => insertDelete(ws, 'row', true),
  insertColLeft: ws => insertDelete(ws, 'col', false),
  insertColRight: ws => insertDelete(ws, 'col', true),
  deleteRows: ws => insertDelete(ws, 'row', false, true),
  deleteCols: ws => insertDelete(ws, 'col', false, true),
  hideRows: ws => ws.exec(ops.setHidden(ws.wb, ws.sheet, 'row', selectedIndexes(ws, 'row'), true)),
  hideCols: ws => ws.exec(ops.setHidden(ws.wb, ws.sheet, 'col', selectedIndexes(ws, 'col'), true)),
  unhideRows: ws => { const g = ws.ranges()[0]; const idx = Array.from(ws.sheet.hiddenRows).filter(r => r >= g.r1 - 1 && r <= g.r2 + 1); ws.exec(ops.setHidden(ws.wb, ws.sheet, 'row', idx.length ? idx : Array.from(ws.sheet.hiddenRows), false)); },
  unhideCols: ws => { const g = ws.ranges()[0]; const idx = Array.from(ws.sheet.hiddenCols).filter(c => c >= g.c1 - 1 && c <= g.c2 + 1); ws.exec(ops.setHidden(ws.wb, ws.sheet, 'col', idx.length ? idx : Array.from(ws.sheet.hiddenCols), false)); },
  insertSheet: ws => {
    if (ws.wb.sheets.length >= E.MAX_SHEETS) { toast('A workbook can have at most ' + E.MAX_SHEETS + ' sheets.', { kind: 'error' }); return; }
    ws.structural('Insert sheet', () => { const s = ws.wb.addSheet(ws.wb.freeSheetName(), ws.wb.sheets.indexOf(ws.sheet) + 1); ws.wb.activeSheetId = s.id; });
  },
  insertFunction: ws => D.insertFunctionDialog(ws, true),
  insertDate: ws => { const d = new Date(); ws.exec(ops.setInputs(ws.wb, ws.sheet, [{ r: ws.sel.active.r, c: ws.sel.active.c, input: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }], 'Insert date')); },
  insertTime: ws => { const d = new Date(); ws.exec(ops.setInputs(ws.wb, ws.sheet, [{ r: ws.sel.active.r, c: ws.sel.active.c, input: d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') }], 'Insert time')); },

  // format
  bold: ws => toggleStyle(ws, 'bold'),
  italic: ws => toggleStyle(ws, 'italic'),
  underline: ws => toggleStyle(ws, 'underline'),
  strike: ws => toggleStyle(ws, 'strike'),
  wrap: ws => toggleStyle(ws, 'wrap'),
  alignLeft: ws => align(ws, 'left'),
  alignCenter: ws => align(ws, 'center'),
  alignRight: ws => align(ws, 'right'),
  alignTop: ws => ws.styleSel({ v: 'top' }),
  alignMiddle: ws => ws.styleSel({ v: 'middle' }),
  alignBottom: ws => ws.styleSel({ v: null }),
  fmtGeneral: ws => numFmt(ws, null),
  fmtNumber: ws => numFmt(ws, '#,##0.00'),
  fmtPercent: ws => numFmt(ws, '0.00%'),
  fmtCurrency: ws => numFmt(ws, '$#,##0.00'),
  fmtDate: ws => numFmt(ws, 'yyyy-mm-dd'),
  fmtTime: ws => numFmt(ws, 'h:mm'),
  fmtDateTime: ws => numFmt(ws, 'yyyy-mm-dd hh:mm'),
  fmtScientific: ws => numFmt(ws, '0.00E+00'),
  fmtText: ws => numFmt(ws, '@'),
  decimalsUp: ws => decimals(ws, 1),
  decimalsDown: ws => decimals(ws, -1),
  formatCells: (ws, tab) => D.formatCellsDialog(ws, tab),
  clearFormat: ws => ws.exec(ops.clearRanges(ws.wb, ws.sheet, ws.ranges(), 'formats')),
  fitColumns: (ws, arg) => {
    const axis = arg && arg.axis === 'row' ? 'row' : 'col';
    if (axis === 'row') { ws.exec(ops.resize(ws.wb, ws.sheet, 'row', arg.indexes, E.DEFAULT_ROW_HEIGHT)); return; }
    const cols = arg && arg.indexes ? arg.indexes : selectedIndexes(ws, 'col').slice(0, 200);
    const measure = (/** @type {string} */ text, /** @type {any} */ st) => ws.grid.measure(text, ws.grid.font(st));
    const steps = [];
    for (const c of cols) steps.push(ops.resize(ws.wb, ws.sheet, 'col', [c], ops.fitColumn(ws.wb, ws.sheet, c, measure)));
    // one undo step for all of them
    if (steps.length === 1) ws.exec(steps[0]);
    else if (steps.length) {
      const first = /** @type {any} */ (steps[0]), last = /** @type {any} */ (steps[steps.length - 1]);
      ws.exec({ type: 'layout', sheetId: ws.sheet.id, before: first.before, after: last.after, label: 'Fit columns' });
    }
  },

  // data
  sortAsc: ws => quickSort(ws, false),
  sortDesc: ws => quickSort(ws, true),
  sortDialog: ws => { const g = dataRange(ws); if (g) D.sortDialog(ws, g); },
  toggleFilter: ws => {
    if (ws.sheet.filter) { ws.exec(ops.setFilter(ws.wb, ws.sheet, null)); toast('Filter removed.'); return; }
    const g = dataRange(ws);
    if (!g) return;
    if (g.r2 <= g.r1) { toast('Select a table with a header row and some data to filter.', { kind: 'error' }); return; }
    ws.exec(ops.setFilter(ws.wb, ws.sheet, g));
    ws.updateToolbar();
  },
  clearFilters: ws => { const f = ws.sheet.filter; if (!f) return; for (const c of Object.keys(f.conditions)) ws.exec(ops.setFilterCondition(ws.wb, ws.sheet, Number(c), null)); },
  removeDuplicates: ws => { const g = dataRange(ws); if (g) D.removeDuplicatesDialog(ws, g); },
  trimWhitespace: ws => {
    const rows = [];
    let n = 0;
    for (const g of ws.ranges()) {
      const b = ws.sheet.bounds();
      for (let r = g.r1; r <= Math.min(g.r2, b.maxRow); r++) for (let c = g.c1; c <= Math.min(g.c2, b.maxCol); c++) {
        const cell = ws.sheet.get(r, c);
        if (!cell || cell.f || typeof cell.v !== 'string') continue;
        const t = cell.v.replace(/[ \s]+/g, ' ').trim();
        if (t !== cell.v) { rows.push({ r, c, input: "'" + t }); n++; }
      }
    }
    if (!n) { toast('No extra spaces found.'); return; }
    ws.exec(ops.setInputs(ws.wb, ws.sheet, rows, 'Trim whitespace'));
    toast('Trimmed ' + n + ' cell' + (n === 1 ? '' : 's') + '.');
  },

  // MetaCode
  aiAssistant: ws => ws.sidebar.open('assistant'),
  aiCoding: ws => ws.sidebar.open('coding'),
  reliability: ws => ws.sidebar.open('reliability'),
  openProject: ws => ws.app.openProjectPicker(),
  saveProject: ws => ws.sidebar.open('projects'),
  scraperImport: ws => ws.app.scraperPicker()
};

/**
 * Keyboard shortcuts handled by the window (the menu shows the same keys).
 * "mod" is Ctrl (⌘ on macOS). In text fields only the `inText` ones apply.
 * @type {{ key: string, mod?: boolean, shift?: boolean, alt?: boolean, cmd: string, inText?: boolean, mac?: boolean }[]}
 */
export const KEYMAP = [
  { key: 'n', mod: true, cmd: 'new', inText: true }, { key: 'o', mod: true, cmd: 'open', inText: true }, { key: 's', mod: true, cmd: 'save', inText: true },
  { key: 's', mod: true, shift: true, cmd: 'saveAs', inText: true }, { key: 'i', mod: true, shift: true, cmd: 'import', inText: true }, { key: 'e', mod: true, shift: true, cmd: 'exportXlsx', inText: true },
  { key: 'w', mod: true, cmd: 'closeTab', inText: true }, { key: 'h', mod: true, shift: true, cmd: 'home', inText: true }, { key: ',', mod: true, cmd: 'settings', inText: true },
  { key: 'z', mod: true, cmd: 'undo' }, { key: 'y', mod: true, cmd: 'redo' }, { key: 'z', mod: true, shift: true, cmd: 'redo' },
  { key: 'v', mod: true, shift: true, cmd: 'pasteValues' }, { key: 'd', mod: true, cmd: 'fillDown' }, { key: 'r', mod: true, cmd: 'fillRight' },
  { key: 'a', mod: true, cmd: 'selectAll' },
  { key: 'f', mod: true, cmd: 'find', inText: true }, { key: 'h', mod: true, cmd: 'replace', inText: true, mac: false }, { key: 'f', mod: true, alt: true, cmd: 'replace', inText: true },
  { key: 'b', mod: true, cmd: 'bold' }, { key: 'i', mod: true, cmd: 'italic' }, { key: 'u', mod: true, cmd: 'underline' }, { key: 'x', mod: true, shift: true, cmd: 'strike' },
  { key: '1', mod: true, cmd: 'formatCells' }, { key: '\\', mod: true, cmd: 'clearFormat' },
  { key: 'l', mod: true, shift: true, cmd: 'alignLeft' }, { key: 'c', mod: true, shift: true, cmd: 'alignCenter' }, { key: 'r', mod: true, shift: true, cmd: 'alignRight' },
  { key: '=', mod: true, cmd: 'zoomIn', inText: true }, { key: '+', mod: true, cmd: 'zoomIn', inText: true }, { key: '-', mod: true, cmd: 'zoomOut', inText: true }, { key: '0', mod: true, cmd: 'zoomReset', inText: true },
  { key: '`', mod: true, cmd: 'toggleFormulas' }, { key: 'b', mod: true, alt: true, cmd: 'toggleSidebar', inText: true },
  { key: 'f', mod: true, shift: true, cmd: 'toggleFilter' }, { key: 'a', mod: true, shift: true, cmd: 'aiAssistant', inText: true },
  { key: '/', mod: true, cmd: 'shortcuts', inText: true }, { key: ';', mod: true, cmd: 'insertDate' }, { key: ':', mod: true, shift: true, cmd: 'insertTime' }, { key: ';', mod: true, shift: true, cmd: 'insertTime' },
  { key: 'F11', shift: true, cmd: 'insertSheet', inText: true }, { key: 'F3', shift: true, cmd: 'insertFunction' },
  { key: 'PageDown', mod: true, cmd: 'nextSheet', inText: true }, { key: 'PageUp', mod: true, cmd: 'prevSheet', inText: true }
];

/** @param {KeyboardEvent} e @param {boolean} isMac */
export function commandFor(e, isMac) {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const t = /** @type {HTMLElement} */ (e.target);
  const inText = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const k of KEYMAP) {
    if (k.mac === false && isMac) continue;
    if (!!k.mod !== mod || !!k.alt !== e.altKey) continue;
    // keys that need Shift to type (+, :) match with or without it
    if (!!k.shift !== e.shiftKey && !(k.key === '+' || k.key === ':')) continue;
    if (k.key.toLowerCase() !== key) continue;
    if (inText && !k.inText) return null;
    return k.cmd;
  }
  return null;
}

/** @param {Workspace} ws @param {{ x: number, y: number }} at */
export function cellContextMenu(ws, at) {
  const online = ws.app.state.status === 'active';
  showMenu([
    { label: 'Cut', key: 'CmdOrCtrl+X', run: () => ws.copy(null, true) },
    { label: 'Copy', key: 'CmdOrCtrl+C', run: () => ws.copy(null, false) },
    { label: 'Paste', key: 'CmdOrCtrl+V', run: () => COMMANDS.paste(ws) },
    { label: 'Paste values only', key: 'CmdOrCtrl+Shift+V', run: () => COMMANDS.pasteValues(ws) },
    '-',
    { label: 'Insert', sub: [{ label: 'Rows above', run: () => COMMANDS.insertRowAbove(ws) }, { label: 'Rows below', run: () => COMMANDS.insertRowBelow(ws) }, { label: 'Columns left', run: () => COMMANDS.insertColLeft(ws) }, { label: 'Columns right', run: () => COMMANDS.insertColRight(ws) }] },
    { label: 'Delete', sub: [{ label: 'Rows', run: () => COMMANDS.deleteRows(ws) }, { label: 'Columns', run: () => COMMANDS.deleteCols(ws) }] },
    { label: 'Clear contents', key: 'Delete', run: () => COMMANDS.clear(ws) },
    { label: 'Clear formatting', run: () => COMMANDS.clearFormat(ws) },
    '-',
    { label: 'Sort A → Z', icon: 'sortAsc', run: () => COMMANDS.sortAsc(ws) },
    { label: 'Sort Z → A', icon: 'sortDesc', run: () => COMMANDS.sortDesc(ws) },
    { label: ws.sheet.filter ? 'Remove filter' : 'Filter', icon: 'filter', run: () => COMMANDS.toggleFilter(ws) },
    '-',
    { label: 'Format cells…', key: 'CmdOrCtrl+1', run: () => COMMANDS.formatCells(ws) },
    '-',
    { heading: 'MetaCode AI' },
    { label: 'Explain these cells', icon: 'sparkles', disabled: !online, run: () => ws.sidebar.open('assistant', { action: 'explain' }) },
    { label: 'Clean or transform with AI…', icon: 'sparkles', disabled: !online, run: () => ws.sidebar.open('assistant', { action: 'transform' }) },
    { label: 'AI Coding of this column…', icon: 'sparkles', disabled: !online, run: () => ws.sidebar.open('coding') }
  ], at);
}

/** @param {Workspace} ws @param {{ x: number, y: number, area: string }} at */
export function headerContextMenu(ws, at) {
  const col = at.area === 'col';
  showMenu(col ? [
    { label: 'Cut', run: () => ws.copy(null, true) }, { label: 'Copy', run: () => ws.copy(null, false) }, { label: 'Paste', run: () => COMMANDS.paste(ws) },
    '-',
    { label: 'Insert column left', run: () => COMMANDS.insertColLeft(ws) }, { label: 'Insert column right', run: () => COMMANDS.insertColRight(ws) },
    { label: 'Delete columns', run: () => COMMANDS.deleteCols(ws) }, { label: 'Clear columns', run: () => COMMANDS.clear(ws) },
    '-',
    { label: 'Hide columns', run: () => COMMANDS.hideCols(ws) }, { label: 'Unhide columns', disabled: !ws.sheet.hiddenCols.size, run: () => COMMANDS.unhideCols(ws) },
    { label: 'Column width…', run: async () => {
      const cur = ws.sheet.colWidths.get(ws.sel.active.c) || E.DEFAULT_COL_WIDTH;
      const v = await prompt('Column width', 'Width in pixels', String(cur), { validate: s => (Number(s) >= 12 && Number(s) <= 1500 ? null : 'Enter a number from 12 to 1500.') });
      if (v) ws.exec(ops.resize(ws.wb, ws.sheet, 'col', selectedIndexes(ws, 'col'), Number(v)));
    } },
    { label: 'Fit to contents', run: () => COMMANDS.fitColumns(ws) },
    '-',
    { label: 'Sort sheet A → Z by this column', run: () => COMMANDS.sortAsc(ws) }, { label: 'Sort sheet Z → A by this column', run: () => COMMANDS.sortDesc(ws) },
    { label: 'Freeze up to this column', run: () => ws.exec(ops.freeze(ws.wb, ws.sheet, ws.sheet.freeze.rows, ws.sel.ranges[0].c2 + 1)) }
  ] : [
    { label: 'Cut', run: () => ws.copy(null, true) }, { label: 'Copy', run: () => ws.copy(null, false) }, { label: 'Paste', run: () => COMMANDS.paste(ws) },
    '-',
    { label: 'Insert row above', run: () => COMMANDS.insertRowAbove(ws) }, { label: 'Insert row below', run: () => COMMANDS.insertRowBelow(ws) },
    { label: 'Delete rows', run: () => COMMANDS.deleteRows(ws) }, { label: 'Clear rows', run: () => COMMANDS.clear(ws) },
    '-',
    { label: 'Hide rows', run: () => COMMANDS.hideRows(ws) }, { label: 'Unhide rows', disabled: !ws.sheet.hiddenRows.size, run: () => COMMANDS.unhideRows(ws) },
    { label: 'Row height…', run: async () => {
      const cur = ws.sheet.rowHeights.get(ws.sel.active.r) || E.DEFAULT_ROW_HEIGHT;
      const v = await prompt('Row height', 'Height in pixels', String(cur), { validate: s => (Number(s) >= 8 && Number(s) <= 600 ? null : 'Enter a number from 8 to 600.') });
      if (v) ws.exec(ops.resize(ws.wb, ws.sheet, 'row', selectedIndexes(ws, 'row'), Number(v)));
    } },
    { label: 'Freeze up to this row', run: () => ws.exec(ops.freeze(ws.wb, ws.sheet, ws.sel.ranges[0].r2 + 1, ws.sheet.freeze.cols)) }
  ], at);
}
