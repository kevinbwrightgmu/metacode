// Performance of the engine on large sheets. Each test reports what it
// measured (node --test shows the diagnostics); the limits are generous so
// slow CI machines don't fail, and docs/desktop/README.md lists the numbers
// measured during development.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/shared/engine/index.js';

const { ops } = E;
const time = fn => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r]; };

test('200,000 values: load, SUM a whole column, save and reopen', t => {
  const wb = E.newWorkbook();
  const s = wb.activeSheet;
  const rows = Array.from({ length: 50000 }, (_, i) => [i, i * 2, 'row ' + i, i % 7]);
  const [load] = time(() => ops.setValues(wb, s, 0, 0, rows, 'Import'));
  const [sum, v] = time(() => { ops.setInputs(wb, s, [{ r: 0, c: 5, input: '=SUM(A:A)+SUM(B:B)+COUNTIF(D:D,3)' }]); return wb.valueAt(s, 0, 5); });
  assert.equal(v, 49999 * 50000 / 2 * 3 + 7143);
  const [save, text] = time(() => E.serialize(wb));
  const [open, back] = time(() => E.parseFile(text));
  assert.equal(back.valueAt(back.sheets[0], 0, 5), v);
  t.diagnostic(`load ${load.toFixed(0)} ms · SUM/COUNTIF over 50k rows ${sum.toFixed(0)} ms · save ${save.toFixed(0)} ms (${(text.length / 1e6).toFixed(1)} MB) · open ${open.toFixed(0)} ms`);
  assert.ok(load < 15000 && sum < 5000 && save < 10000 && open < 15000);
});

test('20,000 formulas: editing one input recalculates only its dependents, quickly', t => {
  const wb = E.newWorkbook();
  const s = wb.activeSheet;
  const entries = [];
  for (let r = 0; r < 20000; r++) { entries.push({ r, c: 0, input: String(r) }); entries.push({ r, c: 1, input: '=A' + (r + 1) + '*2+$D$1' }); }
  entries.push({ r: 0, c: 3, input: '1' });
  const [build] = time(() => ops.setInputs(wb, s, entries));
  const [one] = time(() => ops.setInputs(wb, s, [{ r: 500, c: 0, input: '7' }]));
  assert.equal(wb.calc.stats.lastCount, 1, 'only B501');
  assert.equal(wb.valueAt(s, 500, 1), 15);
  const [all] = time(() => ops.setInputs(wb, s, [{ r: 0, c: 3, input: '2' }]));
  assert.equal(wb.calc.stats.lastCount, 20000, 'every formula reads $D$1');
  t.diagnostic(`build 40k cells ${build.toFixed(0)} ms · one edit ${one.toFixed(1)} ms · edit read by 20k formulas ${all.toFixed(0)} ms`);
  assert.ok(one < 50 && all < 3000);
});

test('a running total over 20,000 rows and a 10,000-row paste under range formulas', t => {
  const wb = E.newWorkbook();
  const s = wb.activeSheet;
  const entries = [];
  for (let r = 0; r < 20000; r++) { entries.push({ r, c: 0, input: '1' }); entries.push({ r, c: 1, input: '=SUM($A$1:A' + (r + 1) + ')' }); }
  const [build] = time(() => ops.setInputs(wb, s, entries));
  assert.equal(wb.valueAt(s, 19999, 1), 20000);
  const [edit] = time(() => ops.setInputs(wb, s, [{ r: 19990, c: 0, input: '5' }]));
  assert.equal(wb.valueAt(s, 19999, 1), 20004);
  assert.equal(wb.calc.stats.lastCount, 10, 'only the totals from row 19,991 down');
  const paste = Array.from({ length: 10000 }, () => [2]);
  const [bulk] = time(() => ops.setValues(wb, s, 0, 0, paste, 'Paste'));
  assert.equal(wb.valueAt(s, 19999, 1), 20000 + 10000 + 4);
  t.diagnostic(`build ${build.toFixed(0)} ms · edit near the end ${edit.toFixed(1)} ms · paste 10k values under 20k range formulas ${bulk.toFixed(0)} ms`);
  assert.ok(edit < 200 && bulk < 20000);
});

test('inserting a row in a 50,000-cell sheet with 10,000 formulas, and undoing it', t => {
  const wb = E.newWorkbook();
  const s = wb.activeSheet;
  const h = new E.History();
  const entries = [];
  for (let r = 0; r < 10000; r++) { entries.push({ r, c: 0, input: String(r) }); entries.push({ r, c: 1, input: 'x' }); entries.push({ r, c: 2, input: 'y' }); entries.push({ r, c: 3, input: '=A' + (r + 1) + '+1' }); entries.push({ r, c: 4, input: 'z' }); }
  ops.setInputs(wb, s, entries);
  const [ins] = time(() => h.push(ops.insertDelete(wb, s, 'row', 10, 1)));
  assert.equal(s.get(5000, 3).f, '=A5001+1');
  const [undo] = time(() => h.undo(wb));
  assert.equal(s.get(5000, 3).f, '=A5001+1');
  assert.equal(s.get(10, 3).f, '=A11+1');
  t.diagnostic(`insert row ${ins.toFixed(0)} ms · undo ${undo.toFixed(0)} ms`);
  assert.ok(ins < 5000 && undo < 5000);
});
