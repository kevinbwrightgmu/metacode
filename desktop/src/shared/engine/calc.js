// @ts-check
// ── Recalculation ─────────────────────────────────────────────────────────────
// Keeps, for every formula, the cells and ranges it reads, and the reverse:
// which formulas read a given cell. When cells change, only the formulas that
// (directly or through other formulas) depend on them are recalculated, in an
// order where every formula comes after the formulas it reads. Circular
// references are found and get #REF! ("circular reference") instead of
// looping. Volatile functions (NOW, TODAY, RAND, RANDBETWEEN) run on every
// recalculation.
//
// Ranges are indexed by column (wide ranges in a separate list) so finding
// the formulas that read a changed cell stays fast with many formulas; large
// batches of changes (paste, import) are matched range-by-range instead.

import { parse, refsOf, functionsOf } from './formula.js';
import { evaluate, scalar, RangeRef } from './evaluate.js';
import { VOLATILE } from './functions.js';
import { MAX_COLS, MAX_ROWS } from './address.js';
import { err, ERR, CellError } from './values.js';

const WIDE = 64;           // ranges wider than this go in the wide list

/**
 * @typedef {import('./workbook.js').Sheet} Sheet
 * @typedef {import('./workbook.js').Workbook} Workbook
 * @typedef {{ sheetId: string | null, sheetName: string | null, r1: number, c1: number, r2: number, c2: number, single: boolean }} Dep
 * @typedef {{ gk: string, sheet: Sheet, key: number, r: number, c: number, text: string, ast: any, error: CellError | null, deps: Dep[], volatile: boolean }} Entry
 */

/** @param {string} sheetId @param {number} key */
const gkOf = (sheetId, key) => sheetId + '|' + key;

export class Calc {
  /** @param {Workbook} wb */
  constructor(wb) {
    this.wb = wb;
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
    /** precedent cell → formulas reading it @type {Map<string, Set<string>>} */
    this.cellDeps = new Map();
    /** sheet → column → range deps; and sheet → wide range deps @type {Map<string, Map<number, Set<string>>>} */
    this.colDeps = new Map();
    /** @type {Map<string, Set<string>>} */
    this.wideDeps = new Map();
    /** formula → its range deps (with the formula's gk) for batch matching @type {Map<string, Set<string>>} */
    this.rangeFormulas = new Map();
    /** references to sheets that don't exist (yet), by lower-case name @type {Map<string, Set<string>>} */
    this.unresolved = new Map();
    /** @type {Set<string>} */
    this.volatile = new Set();
    /** how many formulas each column of each sheet holds (data-only columns get fast sums) @type {Map<string, Map<number, number>>} */
    this.formulaCols = new Map();
    this.now = () => Date.now();
    this.random = Math.random;
    this.stats = { lastRecalcMs: 0, lastCount: 0 };
  }

  /* ── Registering formulas ───────────────────── */

  /** @param {Sheet} sheet @param {number} key @param {string} text */
  register(sheet, key, text) {
    const gk = gkOf(sheet.id, key);
    if (this.entries.has(gk)) this.unregister(sheet, key);
    const r = Math.floor(key / MAX_COLS), c = key % MAX_COLS;
    /** @type {Entry} */
    const e = { gk, sheet, key, r, c, text, ast: null, error: null, deps: [], volatile: false };
    try {
      e.ast = parse(text);
    } catch (x) {
      e.error = err(ERR.NAME, x && /** @type {any} */ (x).message ? 'Formula error: ' + /** @type {any} */ (x).message : 'The formula can\'t be read');
    }
    if (e.ast) {
      for (const ref of refsOf(e.ast)) {
        const target = ref.sheet === null ? sheet : this.wb.sheetByName(ref.sheet);
        const r1 = Math.min(ref.a.r, ref.b.r), r2 = Math.max(ref.a.r, ref.b.r), c1 = Math.min(ref.a.c, ref.b.c), c2 = Math.max(ref.a.c, ref.b.c);
        /** @type {Dep} */
        const d = { sheetId: target ? target.id : null, sheetName: target ? null : /** @type {string} */ (ref.sheet).toLowerCase(), r1, c1, r2, c2, single: r1 === r2 && c1 === c2 };
        e.deps.push(d);
      }
      for (const name of functionsOf(e.ast)) if (VOLATILE.has(name)) e.volatile = true;
    }
    this.entries.set(gk, e);
    this.link(e);
    let fc = this.formulaCols.get(sheet.id);
    if (!fc) this.formulaCols.set(sheet.id, (fc = new Map()));
    fc.set(c, (fc.get(c) || 0) + 1);
  }

  /** @param {Entry} e */
  link(e) {
    for (const d of e.deps) {
      if (!d.sheetId) { addTo(this.unresolved, /** @type {string} */ (d.sheetName), e.gk); continue; }
      if (d.single) { addTo(this.cellDeps, gkOf(d.sheetId, d.r1 * MAX_COLS + d.c1), e.gk); continue; }
      addTo(this.rangeFormulas, d.sheetId, e.gk);
      if (d.c2 - d.c1 + 1 > WIDE) { addTo(this.wideDeps, d.sheetId, e.gk); continue; }
      let cols = this.colDeps.get(d.sheetId);
      if (!cols) this.colDeps.set(d.sheetId, (cols = new Map()));
      for (let c = d.c1; c <= d.c2; c++) addTo(cols, c, e.gk);
    }
    if (e.volatile) this.volatile.add(e.gk);
  }

  /** @param {Sheet} sheet @param {number} key */
  unregister(sheet, key) {
    const gk = gkOf(sheet.id, key);
    const e = this.entries.get(gk);
    if (!e) return;
    for (const d of e.deps) {
      if (!d.sheetId) { removeFrom(this.unresolved, /** @type {string} */ (d.sheetName), gk); continue; }
      if (d.single) { removeFrom(this.cellDeps, gkOf(d.sheetId, d.r1 * MAX_COLS + d.c1), gk); continue; }
      removeFrom(this.rangeFormulas, d.sheetId, gk);
      if (d.c2 - d.c1 + 1 > WIDE) { removeFrom(this.wideDeps, d.sheetId, gk); continue; }
      const cols = this.colDeps.get(d.sheetId);
      if (cols) for (let c = d.c1; c <= d.c2; c++) removeFrom(cols, c, gk);
    }
    this.volatile.delete(gk);
    this.entries.delete(gk);
    const fc = this.formulaCols.get(sheet.id);
    if (fc) { const n = (fc.get(e.c) || 0) - 1; if (n > 0) fc.set(e.c, n); else fc.delete(e.c); }
  }

  /** Re-reads every formula (after sheets were renamed, deleted or rebuilt) */
  rebuild() {
    this.entries.clear(); this.cellDeps.clear(); this.colDeps.clear(); this.wideDeps.clear(); this.rangeFormulas.clear(); this.unresolved.clear(); this.volatile.clear(); this.formulaCols.clear();
    for (const s of this.wb.sheets) for (const [k, c] of s.cells) if (c.f) this.register(s, k, c.f);
  }

  /** A new sheet: formulas that referred to its name now point at it @param {Sheet} sheet */
  sheetAdded(sheet) {
    const waiting = this.unresolved.get(sheet.name.toLowerCase());
    if (!waiting || !waiting.size) return;
    const list = Array.from(waiting).map(gk => this.entries.get(gk)).filter(Boolean);
    for (const e of /** @type {Entry[]} */ (list)) this.register(e.sheet, e.key, e.text);
    this.recalcFormulas(new Set(list.map(e => /** @type {Entry} */ (e).gk)));
  }

  /* ── Who depends on what ────────────────────── */

  /** Formulas that read the cell directly @param {string} sheetId @param {number} r @param {number} c @param {Set<string>} out */
  directDependents(sheetId, r, c, out) {
    const single = this.cellDeps.get(gkOf(sheetId, r * MAX_COLS + c));
    if (single) for (const g of single) out.add(g);
    const cols = this.colDeps.get(sheetId);
    const inRange = (/** @type {string} */ g) => {
      const e = this.entries.get(g);
      return !!e && e.deps.some(d => d.sheetId === sheetId && !d.single && r >= d.r1 && r <= d.r2 && c >= d.c1 && c <= d.c2);
    };
    const colSet = cols && cols.get(c);
    if (colSet) for (const g of colSet) if (!out.has(g) && inRange(g)) out.add(g);
    const wide = this.wideDeps.get(sheetId);
    if (wide) for (const g of wide) if (!out.has(g) && inRange(g)) out.add(g);
  }

  /**
   * Formulas that read any of many changed cells (a paste, an import):
   * each range formula of an affected sheet is checked once.
   * @param {{ sheet: Sheet, r: number, c: number }[]} changed @param {Set<string>} out
   */
  manyDependents(changed, out) {
    /** @type {Map<string, { keys: number[], r1: number, c1: number, r2: number, c2: number }>} */
    const bySheet = new Map();
    for (const ch of changed) {
      const single = this.cellDeps.get(gkOf(ch.sheet.id, ch.r * MAX_COLS + ch.c));
      if (single) for (const g of single) out.add(g);
      let b = bySheet.get(ch.sheet.id);
      if (!b) bySheet.set(ch.sheet.id, (b = { keys: [], r1: ch.r, c1: ch.c, r2: ch.r, c2: ch.c }));
      b.keys.push(ch.r * MAX_COLS + ch.c);
      if (ch.r < b.r1) b.r1 = ch.r; if (ch.r > b.r2) b.r2 = ch.r; if (ch.c < b.c1) b.c1 = ch.c; if (ch.c > b.c2) b.c2 = ch.c;
    }
    for (const [sheetId, b] of bySheet) {
      const formulas = this.rangeFormulas.get(sheetId);
      if (!formulas) continue;
      b.keys.sort((x, y) => x - y);
      for (const g of formulas) {
        if (out.has(g)) continue;
        const e = this.entries.get(g);
        if (!e) continue;
        for (const d of e.deps) {
          if (d.sheetId !== sheetId || d.single || d.r2 < b.r1 || d.r1 > b.r2 || d.c2 < b.c1 || d.c1 > b.c2) continue;
          if (anyKeyIn(b.keys, d)) { out.add(g); break; }
        }
      }
    }
  }

  /* ── Recalculating ──────────────────────────── */

  /** After cells changed @param {{ sheet: Sheet, r: number, c: number }[]} changed */
  recalc(changed) {
    /** @type {Set<string>} */
    const dirty = new Set();
    for (const ch of changed) { const g = gkOf(ch.sheet.id, ch.r * MAX_COLS + ch.c); if (this.entries.has(g)) dirty.add(g); }
    if (changed.length > 64) this.manyDependents(changed, dirty);
    else for (const ch of changed) this.directDependents(ch.sheet.id, ch.r, ch.c, dirty);
    for (const g of this.volatile) dirty.add(g);
    // Everything downstream of those formulas
    const queue = Array.from(dirty);
    while (queue.length) {
      const g = /** @type {string} */ (queue.pop());
      const e = this.entries.get(g);
      if (!e) continue;
      /** @type {Set<string>} */
      const next = new Set();
      this.directDependents(e.sheet.id, e.r, e.c, next);
      for (const n of next) if (!dirty.has(n)) { dirty.add(n); queue.push(n); }
    }
    return this.recalcFormulas(dirty);
  }

  /** Recalculates every formula (after loading or rebuilding) */
  recalcAll() { return this.recalcFormulas(new Set(this.entries.keys())); }

  /**
   * Evaluates the given formulas, precedents first. → the cells whose value changed.
   * @param {Set<string>} dirty
   * @returns {{ sheet: Sheet, r: number, c: number }[]}
   */
  recalcFormulas(dirty) {
    const t0 = Date.now();
    // Dirty formulas by sheet (sorted keys) and by column (sorted rows), to find the ones inside a range quickly
    /** @type {Map<string, number[]>} */
    const bySheet = new Map();
    /** @type {Map<string, Map<number, number[]>>} */
    const byCol = new Map();
    for (const g of dirty) {
      const e = this.entries.get(g);
      if (!e) continue;
      let a = bySheet.get(e.sheet.id);
      if (!a) bySheet.set(e.sheet.id, (a = []));
      a.push(e.key);
      let cols = byCol.get(e.sheet.id);
      if (!cols) byCol.set(e.sheet.id, (cols = new Map()));
      let rows = cols.get(e.c);
      if (!rows) cols.set(e.c, (rows = []));
      rows.push(e.r);
    }
    for (const a of bySheet.values()) a.sort((x, y) => x - y);
    for (const cols of byCol.values()) for (const rows of cols.values()) rows.sort((x, y) => x - y);

    /** Dirty formulas this one reads @param {Entry} e @returns {string[]} */
    const precedents = e => {
      const out = [];
      for (const d of e.deps) {
        if (!d.sheetId) continue;
        const keys = bySheet.get(d.sheetId);
        if (!keys) continue;
        if (d.single) { const g = gkOf(d.sheetId, d.r1 * MAX_COLS + d.c1); if (dirty.has(g)) out.push(g); continue; }
        const cols = /** @type {Map<number, number[]>} */ (byCol.get(d.sheetId));
        if (d.c2 - d.c1 < WIDE) {
          for (let c = d.c1; c <= d.c2; c++) {
            const rows = cols.get(c);
            if (!rows) continue;
            for (let i = lowerBound(rows, d.r1); i < rows.length && rows[i] <= d.r2; i++) out.push(gkOf(d.sheetId, rows[i] * MAX_COLS + c));
          }
          continue;
        }
        let lo = lowerBound(keys, d.r1 * MAX_COLS + d.c1);
        const hiKey = d.r2 * MAX_COLS + d.c2;
        for (; lo < keys.length && keys[lo] <= hiKey; lo++) {
          const k = keys[lo], c = k % MAX_COLS;
          if (c >= d.c1 && c <= d.c2) out.push(gkOf(d.sheetId, k));
        }
      }
      return out;
    };

    // Depth-first ordering without recursion; a node seen again while still open is a cycle
    /** @type {Map<string, number>} 1 open, 2 done */
    const state = new Map();
    /** @type {string[]} */
    const order = [];
    /** @type {Set<string>} */
    const cyclic = new Set();
    for (const start of dirty) {
      if (state.has(start) || !this.entries.has(start)) continue;
      /** @type {{ g: string, pre: string[], i: number }[]} */
      const stack = [{ g: start, pre: precedents(/** @type {Entry} */ (this.entries.get(start))), i: 0 }];
      state.set(start, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.i < top.pre.length) {
          const p = top.pre[top.i++];
          const st = state.get(p);
          if (st === 1) {
            // a cycle: everything on the stack from p up to here
            const from = stack.findIndex(f => f.g === p);
            for (let k = from; k < stack.length; k++) cyclic.add(stack[k].g);
            continue;
          }
          if (st === 2 || !this.entries.has(p)) continue;
          state.set(p, 1);
          stack.push({ g: p, pre: precedents(/** @type {Entry} */ (this.entries.get(p))), i: 0 });
        } else {
          state.set(top.g, 2);
          order.push(top.g);
          stack.pop();
        }
      }
    }
    /** @type {{ sheet: Sheet, r: number, c: number }[]} */
    const changedCells = [];
    // Prefix sums of data-only columns, built on first use in this pass (data doesn't change while formulas are evaluated)
    /** @type {Map<string, any>} */
    const colCache = new Map();
    const colStats = (/** @type {Sheet} */ sheet, /** @type {number} */ c) => {
      const k = sheet.id + '|' + c;
      if (colCache.has(k)) return colCache.get(k);
      const fc = this.formulaCols.get(sheet.id);
      let stats = null;
      if (!fc || !fc.get(c)) stats = buildColumnStats(sheet, c);
      colCache.set(k, stats);
      return stats;
    };
    const ctxBase = {
      colStats,
      sheetByName: (/** @type {string} */ n) => this.wb.sheetByName(n),
      valueAt: (/** @type {Sheet} */ s, /** @type {number} */ r, /** @type {number} */ c) => { const cell = s.cells.get(r * MAX_COLS + c); return cell ? (cell.v === undefined ? null : cell.v) : null; },
      now: this.now, random: this.random
    };
    for (const g of order) {
      const e = /** @type {Entry} */ (this.entries.get(g));
      const cell = e.sheet.cells.get(e.key);
      if (!cell) continue;
      let v;
      if (cyclic.has(g)) v = err(ERR.REF, 'Circular reference: this formula depends on its own result');
      else if (e.error) v = e.error;
      else {
        const ctx = Object.assign({ sheet: e.sheet, r: e.r, c: e.c }, ctxBase);
        try {
          v = scalar(evaluate(e.ast, /** @type {any} */ (ctx)), /** @type {any} */ (ctx));
        } catch (x) {
          v = x instanceof CellError ? x : err(ERR.VALUE);
        }
        if (v === null || v === undefined) v = 0;
        if (v instanceof RangeRef) v = err(ERR.VALUE);
        if (typeof v === 'number' && !Number.isFinite(v)) v = err(ERR.NUM);
      }
      if (!sameValue(cell.v, v)) changedCells.push({ sheet: e.sheet, r: e.r, c: e.c });
      cell.v = v;
    }
    this.stats = { lastRecalcMs: Date.now() - t0, lastCount: order.length };
    return changedCells;
  }

  /** Is there a formula at this cell that's part of a circular reference? @param {Sheet} sheet @param {number} r @param {number} c */
  isCircular(sheet, r, c) {
    const cell = sheet.get(r, c);
    return !!(cell && cell.f && cell.v instanceof CellError && /^Circular/.test(cell.v.detail || ''));
  }
}

/**
 * Running totals of one data column: sum and count of its numbers, and where
 * its errors are, so SUM / COUNT / AVERAGE of any part of it take constant time.
 * @param {Sheet} sheet @param {number} c
 */
function buildColumnStats(sheet, c) {
  const n = sheet.bounds().maxRow + 1;
  const sum = new Float64Array(n + 1), count = new Uint32Array(n + 1), errs = new Uint32Array(n + 1);
  /** @type {Map<number, CellError>} */
  const errAt = new Map();
  const cells = sheet.cells;
  let k = c;
  for (let r = 0; r < n; r++, k += MAX_COLS) {
    const cell = cells.get(k);
    const v = cell ? cell.v : null;
    sum[r + 1] = sum[r]; count[r + 1] = count[r]; errs[r + 1] = errs[r];
    if (typeof v === 'number') { sum[r + 1] += v; count[r + 1]++; }
    else if (v instanceof CellError) { errs[r + 1]++; errAt.set(r, v); }
  }
  return { rows: n, sum, count, errs, errAt };
}

/** @param {any} a @param {any} b */
function sameValue(a, b) {
  if (a instanceof CellError && b instanceof CellError) return a.code === b.code;
  return a === b;
}
/** @template K @param {Map<K, Set<string>>} m @param {K} k @param {string} v */
function addTo(m, k, v) { let s = m.get(k); if (!s) m.set(k, (s = new Set())); s.add(v); }
/** @template K @param {Map<K, Set<string>>} m @param {K} k @param {string} v */
function removeFrom(m, k, v) { const s = m.get(k); if (s) { s.delete(v); if (!s.size) m.delete(k); } }
/** @param {number[]} a @param {number} x */
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
/** Any changed key inside the dep's rectangle? (keys sorted) @param {number[]} keys @param {Dep} d */
function anyKeyIn(keys, d) {
  let i = lowerBound(keys, d.r1 * MAX_COLS + d.c1);
  const hi = d.r2 * MAX_COLS + d.c2;
  for (; i < keys.length && keys[i] <= hi; i++) { const c = keys[i] % MAX_COLS; if (c >= d.c1 && c <= d.c2) return true; }
  return false;
}

export { MAX_ROWS };
