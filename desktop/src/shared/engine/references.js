// @ts-check
// ── Rewriting the references in formulas ──────────────────────────────────────
// What spreadsheet users expect when they copy a formula, insert or delete
// rows and columns, move cells, or rename / delete a sheet. Each function
// takes formula text ("=…") and gives back new text; only reference tokens
// change, everything else (spacing, functions, text) is kept as written.
// A reference that no longer points anywhere becomes #REF!.

import { tokenize, untokenize } from './formula.js';
import { colName, MAX_ROWS, MAX_COLS, sheetRef } from './address.js';

/** @typedef {import('./formula.js').Ref} Ref @typedef {import('./formula.js').RefPoint} RefPoint */

/** A reference token's text @param {Ref} ref @param {string | null} sheetText the sheet prefix as written (without "!") */
export function refText(ref, sheetText) {
  const p = (/** @type {RefPoint} */ x) => (x.absC ? '$' : '') + colName(x.c) + (x.absR ? '$' : '') + (x.r + 1);
  const pre = sheetText ? sheetText + '!' : '';
  if (ref.kind === 'cols') return pre + (ref.a.absC ? '$' : '') + colName(ref.a.c) + ':' + (ref.b.absC ? '$' : '') + colName(ref.b.c);
  if (ref.kind === 'rows') return pre + (ref.a.absR ? '$' : '') + (ref.a.r + 1) + ':' + (ref.b.absR ? '$' : '') + (ref.b.r + 1);
  if (ref.kind === 'cell') return pre + p(ref.a);
  return pre + p(ref.a) + ':' + p(ref.b);
}

/** The sheet prefix of a token as written ("Sheet1", "'My sheet'") or null @param {string} tokenText */
function writtenSheet(tokenText) {
  const m = /^('(?:[^']|'')+'|[^!]+)!/.exec(tokenText);
  return m ? m[1] : null;
}

/**
 * Rewrites each reference token with fn (which returns a new ref, or null for #REF!).
 * @param {string} formula
 * @param {(ref: Ref) => Ref | null | undefined} fn  undefined: keep as it is
 */
function mapRefs(formula, fn) {
  if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  let tokens;
  try { tokens = tokenize(formula.slice(1)); } catch (e) { return formula; }
  let changed = false;
  for (const t of tokens) {
    if (t.t !== 'ref' || !t.ref) continue;
    const next = fn(t.ref);
    if (next === undefined) continue;
    changed = true;
    if (next === null) { t.s = '#REF!'; continue; }
    t.s = refText(next, writtenSheet(t.s));
    t.ref = next;
  }
  return changed ? '=' + untokenize(tokens) : formula;
}

/**
 * The formula as it reads when copied from (r, c) to (r + dr, c + dc):
 * relative row/column parts move, $-anchored parts stay.
 * @param {string} formula @param {number} dr @param {number} dc
 */
export function shiftFormula(formula, dr, dc) {
  if (!dr && !dc) return formula;
  return mapRefs(formula, ref => {
    const move = (/** @type {RefPoint} */ p, /** @type {boolean} */ rowOnly, /** @type {boolean} */ colOnly) => ({
      r: p.absR || colOnly ? p.r : p.r + dr, c: p.absC || rowOnly ? p.c : p.c + dc, absR: p.absR, absC: p.absC
    });
    let a, b;
    if (ref.kind === 'cols') { a = move(ref.a, false, true); b = move(ref.b, false, true); }
    else if (ref.kind === 'rows') { a = move(ref.a, true, false); b = move(ref.b, true, false); }
    else { a = move(ref.a, false, false); b = move(ref.b, false, false); }
    if ([a, b].some(p => p.r < 0 || p.c < 0 || p.r >= MAX_ROWS || p.c >= MAX_COLS)) return null;
    return { sheet: ref.sheet, kind: ref.kind, a, b };
  });
}

/**
 * After rows or columns were inserted (count > 0) or deleted (count < 0) at
 * index `at` of the sheet named `sheetName`. `home` says whether the formula
 * itself is on that sheet (its unprefixed references point there).
 * @param {string} formula
 * @param {{ sheetName: string, home: boolean, axis: 'row' | 'col', at: number, count: number }} o
 */
export function adjustForStructure(formula, o) {
  const target = o.sheetName.toLowerCase();
  const isRow = o.axis === 'row';
  const limit = isRow ? MAX_ROWS : MAX_COLS;
  return mapRefs(formula, ref => {
    const onTarget = ref.sheet === null ? o.home : ref.sheet.toLowerCase() === target;
    if (!onTarget) return undefined;
    if (isRow && ref.kind === 'cols') return undefined;
    if (!isRow && ref.kind === 'rows') return undefined;
    const get = (/** @type {RefPoint} */ p) => (isRow ? p.r : p.c);
    const set = (/** @type {RefPoint} */ p, /** @type {number} */ v) => (isRow ? { r: v, c: p.c, absR: p.absR, absC: p.absC } : { r: p.r, c: v, absR: p.absR, absC: p.absC });
    let lo = Math.min(get(ref.a), get(ref.b)), hi = Math.max(get(ref.a), get(ref.b));
    const single = ref.kind === 'cell';
    if (o.count > 0) {
      const n = o.count;
      if (lo >= o.at) lo += n;
      if (hi >= o.at) hi += n;
      if (hi >= limit) { if (single || lo >= limit) return null; hi = limit - 1; }
    } else {
      const n = -o.count, end = o.at + n;     // deleted: [at, end)
      if (lo >= o.at && hi < end) return null;
      const nlo = lo < o.at ? lo : lo >= end ? lo - n : o.at;
      const nhi = hi < o.at ? hi : hi >= end ? hi - n : o.at - 1;
      if (nhi < nlo) return null;
      lo = nlo; hi = nhi;
    }
    if (lo === Math.min(get(ref.a), get(ref.b)) && hi === Math.max(get(ref.a), get(ref.b))) return undefined;
    const aFirst = get(ref.a) <= get(ref.b);
    return { sheet: ref.sheet, kind: ref.kind, a: set(ref.a, aFirst ? lo : hi), b: set(ref.b, aFirst ? hi : lo) };
  });
}

/**
 * Cells in `from` (on sheet `sheetName`) were moved by (dr, dc) — cut and
 * paste. References entirely inside the moved block follow it.
 * @param {string} formula
 * @param {{ sheetName: string, home: boolean, from: { r1: number, c1: number, r2: number, c2: number }, dr: number, dc: number, toSheetName?: string, formulaMoved?: boolean }} o
 */
export function adjustForMove(formula, o) {
  const target = o.sheetName.toLowerCase();
  return mapRefs(formula, ref => {
    const onTarget = ref.sheet === null ? o.home : ref.sheet.toLowerCase() === target;
    if (!onTarget || ref.kind !== 'cell' && ref.kind !== 'range') return undefined;
    const r1 = Math.min(ref.a.r, ref.b.r), r2 = Math.max(ref.a.r, ref.b.r), c1 = Math.min(ref.a.c, ref.b.c), c2 = Math.max(ref.a.c, ref.b.c);
    if (!(r1 >= o.from.r1 && r2 <= o.from.r2 && c1 >= o.from.c1 && c2 <= o.from.c2)) return undefined;
    const mv = (/** @type {RefPoint} */ p) => ({ r: p.r + o.dr, c: p.c + o.dc, absR: p.absR, absC: p.absC });
    const a = mv(ref.a), b = mv(ref.b);
    if ([a, b].some(p => p.r < 0 || p.c < 0 || p.r >= MAX_ROWS || p.c >= MAX_COLS)) return null;
    let sheet = ref.sheet;
    if (o.toSheetName && o.toSheetName.toLowerCase() !== target) sheet = o.toSheetName;
    return { sheet, kind: ref.kind, a, b };
  });
}

/** After a sheet was renamed @param {string} formula @param {string} oldName @param {string} newName */
export function renameSheetRefs(formula, oldName, newName) {
  const old = oldName.toLowerCase();
  if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  let tokens;
  try { tokens = tokenize(formula.slice(1)); } catch (e) { return formula; }
  let changed = false;
  for (const t of tokens) {
    if (t.t !== 'ref' || !t.ref || t.ref.sheet === null || t.ref.sheet.toLowerCase() !== old) continue;
    t.ref = Object.assign({}, t.ref, { sheet: newName });
    t.s = refText(t.ref, sheetRef(newName));
    changed = true;
  }
  return changed ? '=' + untokenize(tokens) : formula;
}

/** After a sheet was deleted: its references become #REF! @param {string} formula @param {string} name */
export function deleteSheetRefs(formula, name) {
  const n = name.toLowerCase();
  return mapRefs(formula, ref => (ref.sheet !== null && ref.sheet.toLowerCase() === n ? null : undefined));
}

/** A reference as the token text it would have in a formula on `fromSheet` (for pointing at cells while typing) @param {string} sheetName @param {boolean} sameSheet @param {{ r1: number, c1: number, r2: number, c2: number }} g */
export function referenceText(sheetName, sameSheet, g) {
  const ref = { sheet: sameSheet ? null : sheetName, kind: /** @type {'cell' | 'range'} */ (g.r1 === g.r2 && g.c1 === g.c2 ? 'cell' : 'range'),
    a: { r: g.r1, c: g.c1, absR: false, absC: false }, b: { r: g.r2, c: g.c2, absR: false, absC: false } };
  return refText(ref, sameSheet ? null : sheetRef(sheetName));
}

/** Cycles a reference's $ anchors (F4): A1 → $A$1 → A$1 → $A1 → A1 @param {string} text */
export function cycleAnchors(text) {
  let tokens;
  try { tokens = tokenize(text); } catch (e) { return text; }
  const t = tokens.find(x => x.t === 'ref');
  if (!t || !t.ref) return text;
  const st = (/** @type {RefPoint} */ p) => (p.absR && p.absC ? 0 : p.absR ? 1 : p.absC ? 2 : 3);
  const next = [{ absR: true, absC: false }, { absR: false, absC: true }, { absR: false, absC: false }, { absR: true, absC: true }][st(t.ref.a)];
  const ref = Object.assign({}, t.ref, { a: Object.assign({}, t.ref.a, next), b: Object.assign({}, t.ref.b, next) });
  t.s = refText(ref, writtenSheet(t.s));
  return untokenize(tokens);
}
