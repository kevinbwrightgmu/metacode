// Reliability statistics (public/js/reliability-stats.js) against published
// examples and reference implementations. Reference values were computed with
// scikit-learn 1.9 (cohen_kappa_score) and the krippendorff package, and match
// the worked examples in Krippendorff (2011), "Computing Krippendorff's
// Alpha-Reliability", and the Cohen's kappa example on Wikipedia.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/js/reliability-stats.js');

const close = (actual, expected, msg) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-5, (msg || '') + ' expected ' + expected + ', got ' + actual);
const pairsOf = (a, b) => a.map((x, i) => ({ a: x, b: b[i] }));

test('Cohen\'s κ: the 50-unit yes/no example (po 0.70, pe 0.50 → κ 0.40)', () => {
  const a = Array(20).fill('y').concat(Array(5).fill('y'), Array(10).fill('n'), Array(15).fill('n'));
  const b = Array(20).fill('y').concat(Array(5).fill('n'), Array(10).fill('y'), Array(15).fill('n'));
  const k = S.cohenKappa(pairsOf(a, b));
  close(k.value, 0.4);
  close(k.po, 0.7);
  close(k.pe, 0.5);
  assert.equal(k.n, 50);
  close(S.percentAgreement(pairsOf(a, b)).value, 0.7);
});

test('Cohen\'s κ, linear and quadratic weighted κ on a 5-point ordinal example (scikit-learn values)', () => {
  const A = [1, 2, 3, 4, 5, 3, 2, 4, 5, 1, 3, 2], B = [1, 3, 3, 5, 4, 3, 1, 4, 5, 2, 2, 2];
  const p = pairsOf(A, B);
  close(S.cohenKappa(p).value, 0.368421, 'unweighted');
  close(S.weightedKappa(p, [1, 2, 3, 4, 5], 'linear').value, 0.663551, 'linear');
  close(S.weightedKappa(p, [1, 2, 3, 4, 5], 'quadratic').value, 0.856574, 'quadratic');
  close(S.krippendorffAlpha(A.map((x, i) => [x, B[i]]), 'nominal').value, 0.394737, 'α nominal');
  close(S.krippendorffAlpha(A.map((x, i) => [x, B[i]]), 'ordinal', [1, 2, 3, 4, 5]).value, 0.865833, 'α ordinal');
});

test('Krippendorff\'s α: the 4-coder, 12-unit example with missing values (nominal .743, ordinal .815, interval .849)', () => {
  const N = null;
  const coders = [[1, 2, 3, 3, 2, 1, 4, 1, 2, N, N, N], [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, N, 3], [N, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, N], [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, N]];
  const units = coders[0].map((_, u) => coders.map(c => c[u]));
  close(S.krippendorffAlpha(units, 'nominal').value, 0.743421, 'nominal');
  close(S.krippendorffAlpha(units, 'ordinal', [1, 2, 3, 4, 5]).value, 0.815388, 'ordinal');
  close(S.krippendorffAlpha(units, 'interval').value, 0.849107, 'interval');
  // unit 12 has a single value and is not pairable
  assert.equal(S.krippendorffAlpha(units, 'nominal').units, 11);
});

test('Krippendorff\'s α: the two-coder binary example (α = 0.095)', () => {
  const a = [0, 1, 0, 0, 0, 0, 0, 0, 1, 0], b = [1, 1, 1, 0, 0, 1, 0, 0, 0, 0];
  close(S.krippendorffAlpha(a.map((x, i) => [x, b[i]]), 'nominal').value, 0.095238);
});

test('undefined or impossible statistics say why instead of returning a number', () => {
  const same = [{ a: 'x', b: 'x' }, { a: 'x', b: 'x' }, { a: 'x', b: 'x' }];
  const k = S.cohenKappa(same);
  assert.equal(k.value, null);
  assert.match(k.reason, /single category/);
  assert.equal(S.percentAgreement(same).value, 1);
  assert.equal(S.krippendorffAlpha(same.map(p => [p.a, p.b]), 'nominal').value, null);
  assert.match(S.krippendorffAlpha(same.map(p => [p.a, p.b]), 'nominal').reason, /no variation/);
  assert.match(S.cohenKappa([{ a: 'x', b: 'y' }]).reason, /at least 2/);
  assert.match(S.cohenKappa([]).reason, /No units/);
  assert.equal(S.weightedKappa(same, ['x'], 'linear').value, null);
  assert.equal(S.krippendorffAlpha([[1], [2]], 'nominal').value, null);
});

test('missing codes are left out pairwise; confusion matrix and code-level agreement', () => {
  const pairs = [{ a: 'p', b: 'p' }, { a: 'p', b: 'n' }, { a: 'n', b: 'n' }, { a: 'n', b: null }, { a: undefined, b: 'p' }, { a: 'n', b: 'n' }];
  assert.equal(S.percentAgreement(pairs).n, 4);
  close(S.percentAgreement(pairs).value, 0.75);
  const cm = S.confusion(pairs, ['p', 'n']);
  assert.deepEqual(cm.matrix, [[1, 1], [0, 2]]);
  assert.equal(cm.n, 4);
  const bin = S.binaryAgreement(pairs, 'p');
  assert.deepEqual([bin.a, bin.b, bin.c, bin.d], [1, 1, 0, 2]);
  close(bin.po, 0.75);
  close(bin.positive, 2 / 3);
  close(bin.kappa, 0.5);
});

test('Landis & Koch labels', () => {
  assert.deepEqual([-0.1, 0.1, 0.3, 0.5, 0.7, 0.9, null].map(S.interpret), ['Poor', 'Slight', 'Fair', 'Moderate', 'Substantial', 'Almost perfect', 'n/a']);
});
