// @ts-check
// ── Cell addresses ────────────────────────────────────────────────────────────
// Rows and columns are 0-based inside the engine and shown 1-based / lettered
// (A1) to people, with Excel's limits: 1,048,576 rows × 16,384 columns (XFD).
// A cell's key in a sheet's map is row × MAX_COLS + col (always an exact
// integer: the largest key is about 1.7e10).

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

/** 0 → "A", 25 → "Z", 26 → "AA" @param {number} c */
export function colName(c) {
  let s = '';
  let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** "A" → 0, "aa" → 26; -1 when not a column name @param {string} name */
export function colIndex(name) {
  if (!/^[A-Za-z]{1,3}$/.test(name)) return -1;
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1 < MAX_COLS ? n - 1 : -1;
}

/** @param {number} r @param {number} c */
export const keyOf = (r, c) => r * MAX_COLS + c;
/** @param {number} key @returns {[number, number]} */
export const rcOf = key => [Math.floor(key / MAX_COLS), key % MAX_COLS];

/** "B3" → { r: 2, c: 1 } (also "$B$3"); null when not a cell address @param {string} s */
export function parseA1(s) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(s).trim());
  if (!m) return null;
  const c = colIndex(m[1]), r = Number(m[2]) - 1;
  if (c < 0 || r < 0 || r >= MAX_ROWS) return null;
  return { r, c };
}

/** @param {number} r @param {number} c @param {boolean} [absR] @param {boolean} [absC] */
export function a1(r, c, absR, absC) {
  return (absC ? '$' : '') + colName(c) + (absR ? '$' : '') + (r + 1);
}

/**
 * A range from "A1:C5" / "A1" / "A:C" / "3:7".
 * @param {string} s
 * @returns {{ r1: number, c1: number, r2: number, c2: number } | null}
 */
export function parseRange(s) {
  const t = String(s).trim().replace(/\$/g, '');
  let m = /^([A-Za-z]{1,3}\d{1,7})(?::([A-Za-z]{1,3}\d{1,7}))?$/.exec(t);
  if (m) {
    const a = parseA1(m[1]), b = m[2] ? parseA1(m[2]) : a;
    if (!a || !b) return null;
    return normRange({ r1: a.r, c1: a.c, r2: b.r, c2: b.c });
  }
  m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(t);
  if (m) {
    const c1 = colIndex(m[1]), c2 = colIndex(m[2]);
    return c1 < 0 || c2 < 0 ? null : normRange({ r1: 0, c1, r2: MAX_ROWS - 1, c2 });
  }
  m = /^(\d{1,7}):(\d{1,7})$/.exec(t);
  if (m) {
    const r1 = Number(m[1]) - 1, r2 = Number(m[2]) - 1;
    return r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS ? null : normRange({ r1, c1: 0, r2, c2: MAX_COLS - 1 });
  }
  return null;
}

/** @param {{ r1: number, c1: number, r2: number, c2: number }} g */
export function normRange(g) {
  return { r1: Math.min(g.r1, g.r2), c1: Math.min(g.c1, g.c2), r2: Math.max(g.r1, g.r2), c2: Math.max(g.c1, g.c2) };
}

/** { r1, c1, r2, c2 } → "A1:C5" (or "A1" for one cell) @param {{ r1: number, c1: number, r2: number, c2: number }} g */
export function rangeA1(g) {
  if (g.r1 === 0 && g.r2 === MAX_ROWS - 1 && !(g.c1 === 0 && g.c2 === MAX_COLS - 1)) return colName(g.c1) + ':' + colName(g.c2);
  if (g.c1 === 0 && g.c2 === MAX_COLS - 1 && !(g.r1 === 0 && g.r2 === MAX_ROWS - 1)) return (g.r1 + 1) + ':' + (g.r2 + 1);
  const a = a1(g.r1, g.c1), b = a1(g.r2, g.c2);
  return a === b ? a : a + ':' + b;
}

/** A sheet name as written in a formula: quoted when it isn't a plain identifier @param {string} name */
export function sheetRef(name) {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !parseA1(name) && !/^(TRUE|FALSE)$/i.test(name) && !/^R\d*C\d*$/i.test(name)
    ? name : "'" + name.replace(/'/g, "''") + "'";
}

/** @param {{ r1: number, c1: number, r2: number, c2: number }} g @param {number} r @param {number} c */
export const inRange = (g, r, c) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
/** @param {{ r1: number, c1: number, r2: number, c2: number }} a @param {{ r1: number, c1: number, r2: number, c2: number }} b */
export const intersects = (a, b) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
