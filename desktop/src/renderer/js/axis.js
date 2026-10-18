// @ts-check
// ── Row and column positions ──────────────────────────────────────────────────
// Most rows have the default height; only some have their own size or are
// hidden (size 0). Positions are found from the default size plus the sum of
// the differences before an index (prefix sums over the exceptions), so a
// sheet with a million rows needs no million-entry array.

export class Axis {
  /**
   * @param {number} def default size
   * @param {Map<number, number>} sizes custom sizes
   * @param {(i: number) => boolean} hidden
   * @param {Iterable<number>} hiddenList every hidden index (for the exceptions)
   * @param {number} count number of indexes (rows or columns in a sheet)
   */
  constructor(def, sizes, hidden, hiddenList, count) {
    this.def = def;
    this.count = count;
    this.sizes = sizes;
    this.isHidden = hidden;
    /** @type {Map<number, number>} index → size (exceptions only) */
    const ex = new Map();
    for (const [i, s] of sizes) if (s !== def) ex.set(i, s);
    for (const i of hiddenList) ex.set(i, 0);
    /** @type {number[]} */
    this.idx = Array.from(ex.keys()).sort((a, b) => a - b);
    /** prefix[k] = sum of (size - def) for the first k exceptions */
    this.prefix = new Float64Array(this.idx.length + 1);
    for (let k = 0; k < this.idx.length; k++) this.prefix[k + 1] = this.prefix[k] + (/** @type {number} */ (ex.get(this.idx[k])) - def);
    this.ex = ex;
  }
  /** @param {number} i */
  size(i) { const s = this.ex.get(i); return s === undefined ? this.def : s; }
  /** Exceptions before index i @param {number} i */
  before(i) {
    let lo = 0, hi = this.idx.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.idx[m] < i) lo = m + 1; else hi = m; }
    return lo;
  }
  /** Start of index i (sum of the sizes before it) @param {number} i */
  offset(i) { return i * this.def + this.prefix[this.before(i)]; }
  /** The whole length */
  total() { return this.offset(this.count); }
  /** The index at a position (the last visible one for positions past the end) @param {number} pos */
  indexAt(pos) {
    if (pos <= 0) return this.nextVisible(0, 1);
    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.offset(m) <= pos) lo = m; else hi = m - 1;
    }
    // land on a visible index
    if (this.size(lo) === 0) { const n = this.nextVisible(lo, -1); return n < 0 ? this.nextVisible(lo, 1) : n; }
    return lo;
  }
  /** The next index (in direction dir, from i included) that isn't hidden; -1 when none @param {number} i @param {number} dir */
  nextVisible(i, dir) {
    for (let k = i; k >= 0 && k < this.count; k += dir) if (this.size(k) > 0) return k;
    return -1;
  }
}
