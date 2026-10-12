/* ══════════════════════════════════════════════
   reliability-stats.js — intercoder reliability statistics

   Pure functions (no DOM), used by the Reliability Analysis tab and tested
   in test/reliability-stats.test.js against published examples and
   scikit-learn / the krippendorff package.

   Data shapes
     pairs:  [{ a: code|null, b: code|null }, …]  one per coding unit; a unit
             counts for a pairwise statistic only when both codes are present
             (pairwise deletion of missing values).
     units:  [[code, code, …], …]  every coder's value for a unit (missing
             values left out) — for Krippendorff's α, which uses every unit
             with at least two values.

   Every statistic returns { value, … } or { value: null, reason } when it
   can't be computed (too few units, or undefined because there is no
   variation), so the interface can say why instead of showing a number.
   ══════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReliabilityStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const present = v => v !== undefined && v !== null && v !== '';
  const complete = pairs => pairs.filter(p => present(p.a) && present(p.b));
  const MIN_UNITS = 2;

  function percentAgreement(pairs) {
    const ps = complete(pairs);
    if (!ps.length) return { value: null, n: 0, reason: 'No units were coded by both.' };
    const agree = ps.filter(p => p.a === p.b).length;
    return { value: agree / ps.length, n: ps.length, agree };
  }

  // Cohen's κ for two coders and nominal categories: (po − pe) / (1 − pe).
  function cohenKappa(pairs, categories) {
    const ps = complete(pairs);
    const n = ps.length;
    if (n < MIN_UNITS) return { value: null, n, reason: n ? 'Needs at least ' + MIN_UNITS + ' units coded by both.' : 'No units were coded by both.' };
    const cats = categories && categories.length ? categories : Array.from(new Set(ps.flatMap(p => [p.a, p.b])));
    const po = ps.filter(p => p.a === p.b).length / n;
    let pe = 0;
    cats.forEach(c => { pe += (ps.filter(p => p.a === c).length / n) * (ps.filter(p => p.b === c).length / n); });
    if (pe >= 1 - 1e-12) return { value: null, n, po, pe, reason: 'Undefined: both coders used the same single category for every unit, so chance agreement is 100%.' };
    return { value: (po - pe) / (1 - pe), n, po, pe };
  }

  // Weighted κ for ordered categories (linear or quadratic disagreement weights).
  function weightedKappa(pairs, ordered, scheme) {
    const ps = complete(pairs);
    const n = ps.length;
    if (n < MIN_UNITS) return { value: null, n, reason: n ? 'Needs at least ' + MIN_UNITS + ' units coded by both.' : 'No units were coded by both.' };
    const k = ordered.length;
    if (k < 2) return { value: null, n, reason: 'Needs at least two ordered categories.' };
    const idx = new Map(ordered.map((c, i) => [c, i]));
    const usable = ps.filter(p => idx.has(p.a) && idx.has(p.b));
    if (usable.length < MIN_UNITS) return { value: null, n: usable.length, reason: 'Codes outside the ordered scale.' };
    const w = (i, j) => { const d = Math.abs(i - j) / (k - 1); return scheme === 'quadratic' ? d * d : d; };
    const m = usable.length;
    const ra = new Array(k).fill(0), rb = new Array(k).fill(0);
    let obs = 0;
    usable.forEach(p => { const i = idx.get(p.a), j = idx.get(p.b); ra[i]++; rb[j]++; obs += w(i, j); });
    obs /= m;
    let exp = 0;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) exp += (ra[i] / m) * (rb[j] / m) * w(i, j);
    if (exp <= 1e-12) return { value: null, n: m, reason: 'Undefined: no expected disagreement (a single category was used throughout).' };
    return { value: 1 - obs / exp, n: m, observed: obs, expected: exp, scheme: scheme === 'quadratic' ? 'quadratic' : 'linear' };
  }

  // Krippendorff's α for any number of coders and missing data.
  // level: 'nominal' | 'ordinal' | 'interval'; ordered: category order (ordinal),
  // or numeric category values are used as-is (interval).
  function krippendorffAlpha(units, level, ordered) {
    const lv = ['ordinal', 'interval'].includes(level) ? level : 'nominal';
    const us = units.map(u => u.filter(present)).filter(u => u.length >= 2);
    if (!us.length) return { value: null, n: 0, units: 0, reason: 'No unit has codes from two or more coders.' };
    const cats = lv === 'ordinal' && ordered && ordered.length ? ordered.slice() : Array.from(new Set(us.flat()));
    if (lv === 'interval') cats.sort((x, y) => Number(x) - Number(y));
    const ix = new Map(cats.map((c, i) => [c, i]));
    const K = cats.length;
    const o = Array.from({ length: K }, () => new Array(K).fill(0));
    us.forEach(u => {
      const mu = u.length;
      for (let i = 0; i < mu; i++) for (let j = 0; j < mu; j++) {
        if (i === j) continue;
        const a = ix.get(u[i]), b = ix.get(u[j]);
        if (a === undefined || b === undefined) continue;
        o[a][b] += 1 / (mu - 1);
      }
    });
    const nc = o.map(row => row.reduce((s, x) => s + x, 0));
    const n = nc.reduce((s, x) => s + x, 0);
    if (n <= 1) return { value: null, n, units: us.length, reason: 'Too few pairable values.' };
    const delta2 = (c, k) => {
      if (c === k) return 0;
      if (lv === 'nominal') return 1;
      if (lv === 'interval') { const d = Number(cats[c]) - Number(cats[k]); return d * d; }
      const lo = Math.min(c, k), hi = Math.max(c, k);
      let s = 0;
      for (let g = lo; g <= hi; g++) s += nc[g];
      s -= (nc[c] + nc[k]) / 2;
      return s * s;
    };
    let Do = 0, De = 0;
    for (let c = 0; c < K; c++) for (let k = 0; k < K; k++) {
      const d = delta2(c, k);
      if (!d) continue;
      Do += o[c][k] * d;
      De += nc[c] * nc[k] * d;
    }
    Do /= n;
    De /= n * (n - 1);
    if (De <= 1e-12) return { value: null, n, units: us.length, reason: 'Undefined: every value is the same category, so there is no variation to agree on.' };
    return { value: 1 - Do / De, n, units: us.length, observed: Do, expected: De, level: lv };
  }

  // Confusion matrix: rows = coder A's codes, columns = coder B's codes.
  function confusion(pairs, categories) {
    const ps = complete(pairs);
    const cats = categories && categories.length ? categories : Array.from(new Set(ps.flatMap(p => [p.a, p.b])));
    const m = cats.map(() => cats.map(() => 0));
    const ix = new Map(cats.map((c, i) => [c, i]));
    let other = 0;
    ps.forEach(p => { const i = ix.get(p.a), j = ix.get(p.b); if (i === undefined || j === undefined) other++; else m[i][j]++; });
    return { categories: cats, matrix: m, n: ps.length, outside: other };
  }

  // Code-level binary agreement: did each coder assign `code` to the unit?
  // a = both yes, b = A only, c = B only, d = neither.
  function binaryAgreement(pairs, code) {
    const ps = complete(pairs);
    let a = 0, b = 0, c = 0, d = 0;
    ps.forEach(p => { const x = p.a === code, y = p.b === code; if (x && y) a++; else if (x) b++; else if (y) c++; else d++; });
    const n = ps.length;
    const out = { a, b, c, d, n, po: n ? (a + d) / n : null, positive: a + b + c ? (2 * a) / (2 * a + b + c) : null };
    const k = cohenKappa(ps.map(p => ({ a: p.a === code ? 1 : 0, b: p.b === code ? 1 : 0 })), [0, 1]);
    out.kappa = k.value;
    out.kappaReason = k.reason || null;
    return out;
  }

  // Landis & Koch (1977) labels — a convention, not a test.
  function interpret(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
    if (v < 0) return 'Poor';
    if (v <= 0.2) return 'Slight';
    if (v <= 0.4) return 'Fair';
    if (v <= 0.6) return 'Moderate';
    if (v <= 0.8) return 'Substantial';
    return 'Almost perfect';
  }

  return { percentAgreement, cohenKappa, weightedKappa, krippendorffAlpha, confusion, binaryAgreement, interpret, MIN_UNITS };
});
