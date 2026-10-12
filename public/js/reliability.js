/* ══════════════════════════════════════════════
   reliability.js — Reliability Analysis entry points

   The analysis itself is the Reliability Analysis tab of Human Coding
   (human-coding.js), built on reliability-stats.js. This module keeps the
   sidebar route (#reliability) and the summaries other pages use: the
   Export page's reliability CSV and the assistant's project summary.
   Statistics that aren't defined are null (never shown as 0).
   ══════════════════════════════════════════════ */

const ReliabilityAnalyzer = (() => {
  const S = window.ReliabilityStats;

  function render() { HumanCoder.render('reliability'); }

  // Coder 1 vs AI per dimension (posts both coded).
  function computeAll(dual, pair) {
    const { posts, codebook } = App.getState();
    const src = dual || posts;
    const [A, B] = pair || ['coder1', 'ai'];
    return codebook.map(dim => {
      const pairs = src.map(p => ({ a: HumanCoder.valueOf(p, A, dim.id), b: HumanCoder.valueOf(p, B, dim.id) }));
      const cats = dim.codes.map(c => c.id);
      const pa = S.percentAgreement(pairs), k = S.cohenKappa(pairs, cats), al = S.krippendorffAlpha(pairs.map(x => [x.a, x.b]), 'nominal');
      return { id: dim.id, name: dim.name, n: pa.n, pa: pa.value, kappa: k.value, alpha: al.value, interp: S.interpret(k.value), kappaNote: k.reason || null };
    });
  }

  function computeOverall(dual, codebook, pair) {
    const stats = computeAll(dual, pair);
    const n = stats.reduce((s, x) => s + x.n, 0);
    const agree = stats.reduce((s, x) => s + (x.pa === null ? 0 : x.pa * x.n), 0);
    const ks = stats.map(x => x.kappa).filter(v => v !== null);
    const as = stats.map(x => x.alpha).filter(v => v !== null);
    return { pa: n ? agree / n : null, kappa: ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : null, alpha: as.length ? as.reduce((a, b) => a + b, 0) / as.length : null, n };
  }

  function exportReport() { location.hash = '#human-coding/reliability'; }

  return { render, computeAll, computeOverall, exportReport };
})();
