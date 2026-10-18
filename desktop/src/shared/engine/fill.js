// @ts-check
// ── Fill series ───────────────────────────────────────────────────────────────
// What dragging the fill handle continues, as Excel does:
//   1, 2           → 3, 4, …       (two or more numbers: a linear trend)
//   5              → 5, 5, …       (one number is copied)
//   a date         → the next days (one date steps a day)
//   Item 1, Item 3 → Item 5, …     (text ending in a number: the step between them)
//   Mon / January  → Tue / February (day and month names, as written)
// Anything else is copied in a cycle (the caller's job when this returns null).

const DAYS = [['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']];
const MONTHS = [['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']];

/** Same letter case as the example @param {string} word @param {string} like */
function caseLike(word, like) {
  if (like === like.toUpperCase()) return word.toUpperCase();
  if (like === like.toLowerCase()) return word.toLowerCase();
  return word;
}

/** @param {string} s */
function nameIndex(s) {
  for (const list of [DAYS, MONTHS]) {
    for (const names of list) {
      const i = names.findIndex(n => n.toLowerCase() === s.toLowerCase());
      if (i >= 0) return { names, i };
    }
  }
  return null;
}

/**
 * The next `count` values after `values`, or null when they should be copied.
 * @param {any[]} values literal values, in the direction of the fill
 * @param {number} count
 * @param {boolean} [dates] the source cells are formatted as dates
 * @returns {any[] | null}
 */
export function fillSeries(values, count, dates) {
  if (!values.length || values.some(v => v === null || v === undefined)) return null;
  // Numbers
  if (values.every(v => typeof v === 'number')) {
    if (values.length === 1) return dates ? Array.from({ length: count }, (_, i) => values[0] + i + 1) : null;
    const n = values.length;
    const xs = values.map((_, i) => i);
    const mx = (n - 1) / 2, my = values.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (values[i] - my); sxx += (xs[i] - mx) ** 2; }
    const slope = sxy / sxx, icept = my - slope * mx;
    return Array.from({ length: count }, (_, k) => clean(icept + slope * (n + k)));
  }
  // Text ending in a number (same text before it)
  if (values.every(v => typeof v === 'string')) {
    const parts = values.map(v => /^(.*?)(\d+)(\D*)$/.exec(v));
    if (parts.every(Boolean) && parts.every(p => p && p[1] === /** @type {RegExpExecArray} */ (parts[0])[1] && p[3] === /** @type {RegExpExecArray} */ (parts[0])[3])) {
      const ps = /** @type {RegExpExecArray[]} */ (parts);
      const nums = ps.map(p => Number(p[2]));
      const step = nums.length > 1 ? nums[nums.length - 1] - nums[nums.length - 2] : 1;
      const width = ps[0][2].startsWith('0') ? ps[0][2].length : 0;
      return Array.from({ length: count }, (_, k) => {
        const v = nums[nums.length - 1] + step * (k + 1);
        const t = width && v >= 0 ? String(v).padStart(width, '0') : String(v);
        return ps[0][1] + t + ps[0][3];
      });
    }
    // Day and month names
    const found = values.map(nameIndex);
    if (found.every(Boolean) && found.every(f => f && f.names === /** @type {any} */ (found[0]).names)) {
      const fs = /** @type {{ names: string[], i: number }[]} */ (found);
      const len = fs[0].names.length;
      const step = fs.length > 1 ? (fs[fs.length - 1].i - fs[fs.length - 2].i + len) % len || len : 1;
      const like = values[values.length - 1];
      return Array.from({ length: count }, (_, k) => caseLike(fs[0].names[(fs[fs.length - 1].i + step * (k + 1)) % len], like));
    }
  }
  return null;
}

/** Rounds away floating-point noise (0.1 + 0.2) @param {number} v */
function clean(v) { return Number(v.toPrecision(12)); }
