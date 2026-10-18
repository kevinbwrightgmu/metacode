// @ts-check
// ── Undo and redo ─────────────────────────────────────────────────────────────
// Three kinds of steps:
//   cells     which cells changed, before and after (typing, paste, styles,
//             clearing, fill, find & replace) — cheap, kept per cell
//   layout    a sheet's widths, heights, hidden rows/columns, frozen panes,
//             filter — the old and new values of what changed
//   snapshot  the whole workbook's sheets before and after (inserting or
//             deleting rows and columns, sorting, sheet changes) — their cell
//             maps are copied by reference, cells themselves aren't copied
// The history keeps at most 200 steps.

import { Sheet } from './workbook.js';

export const MAX_STEPS = 200;

/**
 * @typedef {import('./workbook.js').Workbook} Workbook
 * @typedef {{ type: 'cells', sheetId: string, changes: [number, any, any][], label: string, select?: any }} CellsStep
 * @typedef {{ type: 'layout', sheetId: string, before: Record<string, any>, after: Record<string, any>, label: string, select?: any }} LayoutStep
 * @typedef {{ type: 'snapshot', before: Snapshot, after: Snapshot, label: string, select?: any }} SnapshotStep
 * @typedef {CellsStep | LayoutStep | SnapshotStep} Step
 * @typedef {{ order: string[], active: string, sheets: Record<string, any> }} Snapshot
 */

/** A copy of what a layout change touches @param {Sheet} sheet @param {string[]} props */
export function layoutOf(sheet, props) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const p of props) {
    const v = /** @type {any} */ (sheet)[p];
    out[p] = v instanceof Map ? new Map(v) : v instanceof Set ? new Set(v) : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

/** @param {Sheet} sheet @param {Record<string, any>} layout */
function applyLayout(sheet, layout) {
  for (const [k, v] of Object.entries(layout)) /** @type {any} */ (sheet)[k] = v instanceof Map ? new Map(v) : v instanceof Set ? new Set(v) : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

const SHEET_PROPS = ['name', 'colWidths', 'rowHeights', 'hiddenRows', 'hiddenCols', 'filteredRows', 'freeze', 'filter', 'tabColor'];

/** The workbook's sheets as they are now @param {Workbook} wb @returns {Snapshot} */
export function snapshot(wb) {
  /** @type {Record<string, any>} */
  const sheets = {};
  for (const s of wb.sheets) sheets[s.id] = Object.assign({ cells: new Map(s.cells) }, layoutOf(s, SHEET_PROPS));
  return { order: wb.sheets.map(s => s.id), active: wb.activeSheetId, sheets };
}

/** Puts the workbook back to a snapshot (sheets keep their identity) @param {Workbook} wb @param {Snapshot} snap */
export function restore(wb, snap) {
  const byId = new Map(wb.sheets.map(s => [s.id, s]));
  wb.sheets = snap.order.map(id => {
    const data = snap.sheets[id];
    const s = byId.get(id) || new Sheet(id, data.name);
    s.cells = new Map(data.cells);
    applyLayout(s, Object.fromEntries(SHEET_PROPS.map(p => [p, data[p]])));
    s._bounds = null;
    return s;
  });
  wb.activeSheetId = snap.order.includes(snap.active) ? snap.active : snap.order[0];
  wb.calc.rebuild();
  wb.calc.recalcAll();
}

export class History {
  constructor() {
    /** @type {Step[]} */
    this.undoStack = [];
    /** @type {Step[]} */
    this.redoStack = [];
  }
  /** @param {Step | null} step */
  push(step) {
    if (!step) return;
    if (step.type === 'cells' && !step.changes.length) return;
    this.undoStack.push(step);
    if (this.undoStack.length > MAX_STEPS) this.undoStack.shift();
    this.redoStack = [];
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { const s = this.undoStack[this.undoStack.length - 1]; return s ? s.label : ''; }
  get redoLabel() { const s = this.redoStack[this.redoStack.length - 1]; return s ? s.label : ''; }
  /** @param {Workbook} wb @returns {Step | null} */
  undo(wb) {
    const step = this.undoStack.pop();
    if (!step) return null;
    apply(wb, step, false);
    this.redoStack.push(step);
    return step;
  }
  /** @param {Workbook} wb @returns {Step | null} */
  redo(wb) {
    const step = this.redoStack.pop();
    if (!step) return null;
    apply(wb, step, true);
    this.undoStack.push(step);
    return step;
  }
  clear() { this.undoStack = []; this.redoStack = []; }
}

/** @param {Workbook} wb @param {Step} step @param {boolean} forward */
function apply(wb, step, forward) {
  if (step.type === 'snapshot') { restore(wb, forward ? step.after : step.before); wb.changed({ type: 'structure' }); return; }
  const sheet = wb.sheet(step.sheetId);
  if (!sheet) return;
  if (step.type === 'layout') { applyLayout(sheet, forward ? step.after : step.before); wb.changed({ type: 'layout', sheet }); return; }
  const changed = [];
  for (const [key, before, after] of step.changes) {
    const r = Math.floor(key / 16384), c = key % 16384;
    wb.setCell(sheet, r, c, forward ? after : before);
    changed.push({ sheet, r, c });
  }
  wb.recalc(changed);
  wb.changed({ type: 'cells', sheet });
}
