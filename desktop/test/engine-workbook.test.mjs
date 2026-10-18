// Workbooks: recalculation (incremental, cross-sheet, circular references),
// references that follow copies / inserted and deleted rows / moved cells /
// renamed sheets, the editing operations (paste, fill, sort, filter, find and
// replace, styles) with undo and redo, and the .mcsheet format (round trip,
// damaged and hostile files).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/shared/engine/index.js';

const { ops } = E;
function book() {
  const wb = E.newWorkbook('Test');
  const s = wb.activeSheet;
  const history = new E.History();
  const put = (cells, sheet) => {
    const sh = sheet || s;
    history.push(ops.setInputs(wb, sh, Object.entries(cells).map(([a, v]) => { const p = E.parseA1(a); return { r: p.r, c: p.c, input: String(v) }; })));
  };
  const val = (a, sheet) => { const p = E.parseA1(a); return wb.valueAt(sheet || s, p.r, p.c); };
  const f = (a, sheet) => { const p = E.parseA1(a); const c = (sheet || s).get(p.r, p.c); return c ? c.f : undefined; };
  return { wb, s, history, put, val, f };
}
const code = v => (v instanceof E.CellError ? v.code : v);

test('recalculation follows chains, diamonds and ranges, and only touches what depends on a change', () => {
  const { wb, put, val } = book();
  put({ A1: 1, A2: '=A1*2', A3: '=A2+A1', A4: '=SUM(A1:A3)', B1: '=A4*10', C1: 7, C2: '=C1' });
  assert.deepEqual(['A2', 'A3', 'A4', 'B1'].map(a => val(a)), [2, 3, 6, 60]);
  put({ A1: 10 });
  assert.deepEqual(['A2', 'A3', 'A4', 'B1'].map(a => val(a)), [20, 30, 60, 600]);
  assert.equal(wb.calc.stats.lastCount, 4, 'C2 (unrelated) wasn\'t recalculated');
  put({ A2: 5 });                                            // a formula replaced by a value
  assert.equal(val('A4'), 30, '10 + 5 + 15');
  put({ A1: '' });
  assert.equal(val('A3'), 5);
});

test('formulas across sheets follow renames, refer to sheets created later, and #REF! when a sheet goes', () => {
  const { wb, s, put, val, f } = book();
  const data = wb.addSheet('Data');
  put({ A1: 5, A2: 6 }, data);
  put({ A1: '=SUM(Data!A1:A2)', A2: "='Later sheet'!A1+1" });
  assert.equal(val('A1'), 11);
  assert.equal(code(val('A2')), '#REF!');
  const later = wb.addSheet('Later sheet');
  put({ A1: 41 }, later);
  assert.equal(val('A2'), 42, 'the formula found the new sheet');
  wb.renameSheet(data, 'Raw data');
  assert.equal(f('A1'), "=SUM('Raw data'!A1:A2)", 'renamed in the formula (quoted now)');
  assert.equal(val('A1'), 11);
  put({ A1: 100 }, data);
  assert.equal(val('A1'), 106, 'still linked after the rename');
  assert.throws(() => wb.renameSheet(data, 'Later sheet'), /already a sheet/);
  assert.throws(() => wb.renameSheet(data, 'bad:name'), /can't contain/);
  wb.deleteSheet(data);
  assert.equal(f('A1'), '=SUM(#REF!)');
  assert.equal(code(val('A1')), '#REF!');
  assert.throws(() => { wb.deleteSheet(later); wb.deleteSheet(s); }, /at least one sheet/);
});

test('circular references are caught (the cycle and what depends on it), and long chains don\'t overflow', () => {
  const { wb, s, put, val } = book();
  put({ A1: '=B1+1', B1: '=A1+1', C1: '=A1*2', D1: '=D1' });
  for (const a of ['A1', 'B1', 'C1', 'D1']) assert.equal(code(val(a)), '#REF!', a);
  assert.match(val('A1').detail, /Circular/);
  assert.equal(wb.calc.isCircular(s, 0, 0), true);
  put({ B1: 5 });
  assert.equal(val('A1'), 6, 'breaking the cycle recovers');
  assert.equal(val('C1'), 12);
  // 30,000-step chain (recursion would overflow the stack)
  const entries = [{ r: 0, c: 5, input: '1' }];
  for (let r = 1; r < 30000; r++) entries.push({ r, c: 5, input: '=F' + r + '+1' });
  ops.setInputs(wb, s, entries);
  assert.equal(wb.valueAt(s, 29999, 5), 30000);
  ops.setInputs(wb, s, [{ r: 0, c: 5, input: '10' }]);
  assert.equal(wb.valueAt(s, 29999, 5), 30009);
});

test('volatile functions recalculate on every change', () => {
  const { wb, put, val } = book();
  let t = Date.UTC(2024, 0, 1, 12);
  wb.calc.now = () => t;
  put({ A1: '=NOW()', B1: 1 });
  const first = val('A1');
  t += 3600e3;
  put({ B1: 2 });
  assert.ok(Math.abs(val('A1') - first - 1 / 24) < 1e-9, 'NOW moved on by an hour');
});

test('copying a formula moves its relative references; $ anchors stay', () => {
  assert.equal(E.shiftFormula('=A1+$B$1+C$1+$D1', 2, 1), '=B3+$B$1+D$1+$D3');
  assert.equal(E.shiftFormula('=SUM(A:A)', 5, 1), '=SUM(B:B)');
  assert.equal(E.shiftFormula('=SUM(1:1)', 2, 3), '=SUM(3:3)');
  assert.equal(E.shiftFormula("='Q1 data'!A1*2", 1, 0), "='Q1 data'!A2*2");
  assert.equal(E.shiftFormula('=A1', -1, 0), '=#REF!', 'off the sheet');
  assert.equal(E.shiftFormula('=LOG10(A1)+"A1"', 1, 0), '=LOG10(A2)+"A1"', 'only references change');
});

test('inserting and deleting rows and columns adjusts references everywhere', () => {
  const adj = (f, axis, at, count, home = true) => E.adjustForStructure(f, { sheetName: 'Sheet1', home, axis, at, count });
  assert.equal(adj('=A5+A1', 'row', 2, 3), '=A8+A1');
  assert.equal(adj('=SUM(A1:A10)', 'row', 4, 2), '=SUM(A1:A12)', 'inserting inside a range grows it');
  assert.equal(adj('=SUM(A1:A10)', 'row', 0, 1), '=SUM(A2:A11)');
  assert.equal(adj('=SUM(A1:A10)', 'row', 2, -3), '=SUM(A1:A7)', 'deleting inside shrinks it');
  assert.equal(adj('=A5', 'row', 4, -1), '=#REF!', 'a deleted cell');
  assert.equal(adj('=SUM(A3:A4)', 'row', 2, -2), '=SUM(#REF!)');
  assert.equal(adj('=SUM(A1:A5)', 'row', 0, -2), '=SUM(A1:A3)');
  assert.equal(adj('=C1+$C$1', 'col', 1, 2), '=E1+$E$1', 'absolute references move too');
  assert.equal(adj('=SUM(A:A)', 'row', 0, 5), '=SUM(A:A)', 'whole columns don\'t change with rows');
  assert.equal(adj('=Sheet1!A5', 'row', 0, 1, false), '=Sheet1!A6', 'from another sheet');
  assert.equal(adj('=A5', 'row', 0, 1, false), '=A5', 'another sheet\'s own A5 stays');

  const { wb, s, history, put, val, f } = book();
  const other = wb.addSheet('Other');
  put({ A1: 1, A2: 2, A3: 3, A4: '=SUM(A1:A3)', B2: '=A2*10', C1: '=A2' });
  put({ A1: '=Sheet1!A3' }, other);
  history.push(ops.insertDelete(wb, s, 'row', 1, 2));
  assert.equal(f('A6'), '=SUM(A1:A5)');
  assert.equal(val('A6'), 6);
  assert.equal(f('B4'), '=A4*10');
  assert.equal(f('A1', other), '=Sheet1!A5');
  assert.equal(f('C1'), '=A4');
  history.push(ops.insertDelete(wb, s, 'row', 3, -1));    // delete the old row 2 (now row 4)
  assert.equal(f('A5'), '=SUM(A1:A4)');
  assert.equal(val('A5'), 4);
  assert.equal(f('C1'), '=#REF!', 'C1 referred to the deleted cell');
  assert.equal(code(val('C1')), '#REF!');
  history.undo(wb);
  assert.equal(f('B4'), '=A4*10', 'undo restores the exact formulas');
  assert.equal(val('A6'), 6);
  history.undo(wb);
  assert.equal(f('A4'), '=SUM(A1:A3)');
  assert.equal(f('A1', other), '=Sheet1!A3');
  history.redo(wb);
  assert.equal(f('A6'), '=SUM(A1:A5)');
  history.push(ops.insertDelete(wb, s, 'col', 0, 1));
  assert.equal(f('B6'), '=SUM(B1:B5)');
  assert.equal(f('A1', other), '=Sheet1!B5');
});

test('paste: formulas adjust; paste values / formats; a bigger selection takes whole copies; cut moves references', () => {
  const { wb, s, history, put, val, f } = book();
  put({ A1: 1, A2: 2, B1: '=A1*2' });
  history.push(ops.styleRanges(wb, s, [{ r1: 0, c1: 1, r2: 0, c2: 1 }], { bold: true, numFmt: '0.00' }));
  const clip = ops.copyRange(wb, s, { r1: 0, c1: 1, r2: 0, c2: 1 }, false);
  assert.equal(clip.text, '2.00');
  assert.match(clip.html, /font-weight:bold/);
  history.push(ops.pasteClip(wb, s, { r1: 1, c1: 1, r2: 1, c2: 1 }, clip).step);
  assert.equal(f('B2'), '=A2*2');
  assert.equal(val('B2'), 4);
  assert.equal(wb.styles.get(s.get(1, 1).s).bold, true);
  history.push(ops.pasteClip(wb, s, { r1: 0, c1: 3, r2: 0, c2: 3 }, clip, 'values').step);
  assert.equal(f('D1'), undefined);
  assert.equal(val('D1'), 2);
  const { range } = ops.pasteClip(wb, s, { r1: 4, c1: 1, r2: 7, c2: 1 }, clip);
  assert.deepEqual(range, { r1: 4, c1: 1, r2: 7, c2: 1 }, 'one cell filled four times');
  assert.equal(f('B8'), '=A8*2');
  // Cut A1:A2 to C10: B1, B2 follow
  const cut = ops.copyRange(wb, s, { r1: 0, c1: 0, r2: 1, c2: 0 }, true);
  history.push(ops.pasteClip(wb, s, { r1: 9, c1: 2, r2: 9, c2: 2 }, cut).step);
  assert.equal(f('B1'), '=C10*2');
  assert.equal(f('B2'), '=C11*2');
  assert.equal(val('B2'), 4);
  assert.equal(val('A1'), null);
  history.undo(wb);
  assert.equal(f('B1'), '=A1*2');
  assert.equal(val('A1'), 1);
});

test('pasting text from other apps (tab-separated, quoted, formulas typed)', () => {
  const { wb, s, val, f } = book();
  assert.deepEqual(ops.parseClipboardText('a\tb\n"multi\nline"\t"say ""hi"""\n'), [['a', 'b'], ['multi\nline', 'say "hi"']]);
  const { range } = ops.pasteText(wb, s, { r1: 0, c1: 0, r2: 0, c2: 0 }, '1\t2\n3\t=A1+B1');
  assert.deepEqual(range, { r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.equal(val('B2'), 3);
  assert.equal(f('B2'), '=A1+B1');
});

test('fill: series of numbers, dates, text and names; formulas adjust; up and left too', () => {
  const { wb, s, history, put, val, f } = book();
  put({ A1: 1, A2: 3, B1: 'Item 1', C1: 'Mon', D1: '2024-03-05', E1: '=A1*2', F1: 7, G1: 'Q09' });
  history.push(ops.fill(wb, s, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 }));
  assert.deepEqual(['A3', 'A4', 'A5'].map(a => val(a)), [5, 7, 9]);
  history.push(ops.fill(wb, s, { r1: 0, c1: 1, r2: 0, c2: 6 }, { r1: 0, c1: 1, r2: 3, c2: 6 }));
  assert.deepEqual(['B2', 'B3', 'B4'].map(a => val(a)), ['Item 2', 'Item 3', 'Item 4']);
  assert.deepEqual(['C2', 'C3'].map(a => val(a)), ['Tue', 'Wed']);
  assert.deepEqual(['D2', 'D3'].map(a => val(a)), [45357, 45358], 'a date steps a day');
  assert.equal(f('E3'), '=A3*2');
  assert.deepEqual(['F2', 'F3'].map(a => val(a)), [7, 7], 'one number is copied');
  assert.equal(val('G3'), 'Q11', 'leading zeros kept');
  // upwards: continue backwards
  put({ A10: 10, A11: 20 });
  history.push(ops.fill(wb, s, { r1: 9, c1: 0, r2: 10, c2: 0 }, { r1: 7, c1: 0, r2: 10, c2: 0 }));
  assert.deepEqual(['A8', 'A9'].map(a => val(a)), [-10, 0]);
  assert.deepEqual(E.fillSeries(['January', 'March'], 2), ['May', 'July']);
  assert.deepEqual(E.fillSeries(['DEC'], 2), ['JAN', 'FEB']);
  assert.deepEqual(E.fillSeries([0.1, 0.2], 2), [0.3, 0.4]);
  assert.equal(E.fillSeries([true], 2), null);
});

test('sort: by several columns, header kept, blanks last, formulas move with their row', () => {
  const { wb, s, history, put, val, f } = book();
  put({ A1: 'name', B1: 'group', C1: 'score', D1: 'double',
    A2: 'Cy', B2: 'b', C2: 75, D2: '=C2*2', A3: 'Ann', B3: 'a', C3: 88, D3: '=C3*2', A4: 'Bob', B4: 'a', C4: 92, D4: '=C4*2', A5: 'Dee', B5: '', C5: 60, D5: '=C5*2' });
  history.push(ops.sortRange(wb, s, { r1: 0, c1: 0, r2: 4, c2: 3 }, [{ col: 1 }, { col: 2, desc: true }], true));
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5'].map(a => val(a)), ['name', 'Bob', 'Ann', 'Cy', 'Dee']);
  assert.equal(f('D2'), '=C2*2', 'the formula moved with its row and still points at it');
  assert.equal(val('D2'), 184);
  history.undo(wb);
  assert.deepEqual(['A2', 'A3'].map(a => val(a)), ['Cy', 'Ann']);
});

test('filter: values and conditions hide rows (the header stays); find and replace', () => {
  const { wb, s, history, put, val } = book();
  put({ A1: 'city', B1: 'pop', A2: 'Paris', B2: 2100, A3: 'Lyon', B3: 500, A4: 'Paris', B4: 2200, A5: 'Nice', B5: 340 });
  history.push(ops.setFilter(wb, s, { r1: 0, c1: 0, r2: 4, c2: 1 }));
  history.push(ops.setFilterCondition(wb, s, 0, { type: 'values', values: ['Paris'] }));
  assert.deepEqual(Array.from(s.filteredRows).sort(), [2, 4]);
  history.push(ops.setFilterCondition(wb, s, 1, { type: 'condition', op: '>', value: 2150 }));
  assert.deepEqual(Array.from(s.filteredRows).sort(), [1, 2, 4]);
  assert.equal(s.rowHeight(1), 0);
  assert.equal(ops.selectionStats(wb, s, [{ r1: 1, c1: 1, r2: 4, c2: 1 }]).sum, 2200, 'hidden rows aren\'t counted');
  history.undo(wb);
  assert.deepEqual(Array.from(s.filteredRows).sort(), [2, 4]);
  history.push(ops.setFilter(wb, s, null));
  assert.equal(s.filteredRows.size, 0);
  const hits = ops.findAll(wb, s, { query: 'paris' });
  assert.equal(hits.length, 2);
  assert.equal(ops.findAll(wb, s, { query: 'paris', matchCase: true }).length, 0);
  const r = ops.replaceAll(wb, s, { query: 'Paris' }, 'Marseille');
  assert.equal(r.count, 2);
  assert.equal(val('A4'), 'Marseille');
  put({ C1: '=B2+B3' });
  ops.replaceAll(wb, s, { query: 'B3', inFormulas: true }, 'B4');
  assert.equal(val('C1'), 4300);
});

test('styles, borders, clearing, sizes, hiding and freezing are undoable', () => {
  const { wb, s, history, put, val } = book();
  put({ A1: 1, B2: 'x' });
  const g = [{ r1: 0, c1: 0, r2: 1, c2: 1 }];
  history.push(ops.styleRanges(wb, s, g, { bold: true, fill: '#FFFF00' }));
  assert.equal(wb.styles.get(s.get(1, 0).s).fill, '#FFFF00', 'empty cells in the range get the style too');
  history.push(ops.setBorders(wb, s, g, 'outer'));
  const st = wb.styles.get(s.get(0, 0).s);
  assert.equal(st.border.top.style, 'thin');
  assert.equal(st.border.left.style, 'thin');
  assert.equal(st.border.right, undefined);
  history.push(ops.clearRanges(wb, s, g, 'contents'));
  assert.equal(val('A1'), null);
  assert.equal(wb.styles.get(s.get(0, 0).s).bold, true, 'clearing contents keeps formatting');
  history.undo(wb);
  assert.equal(val('A1'), 1);
  history.push(ops.resize(wb, s, 'col', [0, 1], 180));
  assert.equal(s.colWidth(1), 180);
  history.push(ops.setHidden(wb, s, 'row', [3], true));
  assert.equal(s.rowHeight(3), 0);
  history.push(ops.freeze(wb, s, 1, 2));
  assert.deepEqual(s.freeze, { rows: 1, cols: 2 });
  history.undo(wb); history.undo(wb); history.undo(wb);
  assert.deepEqual(s.freeze, { rows: 0, cols: 0 });
  assert.equal(s.rowHeight(3), E.DEFAULT_ROW_HEIGHT);
  assert.equal(s.colWidth(1), E.DEFAULT_COL_WIDTH);
  assert.equal(history.canRedo, true);
});

test('the .mcsheet format round-trips everything; damaged, hostile or newer files are refused', () => {
  const { wb, s, history, put } = book();
  put({ A1: 'Text', A2: 42, A3: '=A2*2', A4: 'TRUE', A5: '#N/A', B1: '12%', C1: '2024-03-05' });
  history.push(ops.styleRanges(wb, s, [{ r1: 0, c1: 0, r2: 0, c2: 0 }], { bold: true, color: '#FF0000', border: { bottom: { style: 'thick', color: '#00FF00' } } }));
  history.push(ops.resize(wb, s, 'col', [0], 150));
  history.push(ops.freeze(wb, s, 1, 0));
  history.push(ops.setHidden(wb, s, 'col', [5], true));
  const data = wb.addSheet('Data');
  put({ B2: '=Sheet1!A3+1' }, data);
  history.push(ops.setFilter(wb, data, { r1: 0, c1: 0, r2: 9, c2: 2 }));
  wb.activeSheetId = data.id;
  const text = E.serialize(wb);
  const back = E.parseFile(text);
  assert.equal(E.serialize(back).replace(/"savedAt":"[^"]+"/, ''), text.replace(/"savedAt":"[^"]+"/, ''), 'identical after a round trip');
  const s2 = back.sheets[0];
  assert.equal(back.valueAt(s2, 2, 0), 84);
  assert.equal(back.valueAt(back.sheets[1], 1, 1), 85);
  assert.equal(back.styles.get(s2.get(0, 0).s).border.bottom.style, 'thick');
  assert.equal(back.activeSheet.name, 'Data');
  assert.equal(back.valueAt(s2, 4, 0).code, '#N/A');

  assert.throws(() => E.parseFile('not json'), /damaged/);
  assert.throws(() => E.parseFile('{"format":"something-else"}'), /isn't a MetaCode Sheets file/);
  assert.throws(() => E.parseFile(JSON.stringify({ format: 'metacode-sheets', version: 99, workbook: { sheets: [{}] } })), /newer version/);
  // Hostile content is reduced to plain data
  const evil = E.parseFile(JSON.stringify({ format: 'metacode-sheets', version: 1, workbook: { name: 'x', styles: [{}, { color: 'red; background:url(x)', bold: 'yes', family: '<script>', numFmt: 'x'.repeat(500) }],
    sheets: [{ name: 'a/b*c', cells: [[0, 0, { e: '#BOGUS' }], [1, 1, 'ok', 'not a formula', 1], [-1, 0, 1], [0, 99999, 1], [2, 0, { __proto__: { polluted: true } }]], colWidths: { '-5': 10, 3: 'wide' } }] } }));
  const es = evil.sheets[0];
  assert.equal(es.name, 'a_b_c');
  assert.equal(evil.valueAt(es, 0, 0), null);
  assert.equal(es.get(1, 1).f, undefined);
  assert.deepEqual(evil.styles.get(es.get(1, 1).s), {});
  assert.equal(es.cells.size, 1);
  assert.equal(es.colWidths.size, 0);
  assert.equal(({}).polluted, undefined);
});

test('undo/redo history is bounded and labelled', () => {
  const { history, put } = book();
  for (let i = 0; i < E.MAX_SHEETS + 50; i++) put({ A1: i });
  assert.ok(history.undoStack.length <= 200);
  assert.equal(history.undoLabel, 'Typing');
});

test('fast SUM / COUNT / AVERAGE over large data columns agree with cell-by-cell evaluation', () => {
  const { wb, s, put, val } = book();
  const rows = Array.from({ length: 400 }, (_, i) => [i % 3 === 0 ? 'text' : i, i % 5 === 0 ? true : i / 2, i]);
  ops.setValues(wb, s, 0, 0, rows, 'data');
  put({ E1: '=SUM(A1:A400)', E2: '=COUNT(A1:B400)', E3: '=AVERAGE(B2:B399)', E4: '=SUM(A10:C300)', E5: '=SUM(A:A)' });
  let sumA = 0, cnt = 0, sumB = 0, nB = 0, sum4 = 0;
  rows.forEach((r, i) => {
    if (typeof r[0] === 'number') { sumA += r[0]; cnt++; if (i >= 9 && i <= 299) sum4 += r[0]; }
    if (typeof r[1] === 'number') { cnt++; if (i >= 1 && i <= 398) { sumB += r[1]; nB++; } if (i >= 9 && i <= 299) sum4 += r[1]; }
    if (i >= 9 && i <= 299) sum4 += r[2];
  });
  assert.equal(val('E1'), sumA);
  assert.equal(val('E2'), cnt);
  assert.equal(val('E3'), sumB / nB);
  assert.equal(val('E4'), sum4);
  assert.equal(val('E5'), sumA);
  put({ A350: '#N/A' });
  assert.equal(code(val('E1')), '#N/A', 'an error in the range is the result');
  put({ A350: '=1+1' });
  assert.equal(val('E1'), sumA - 349 + 2, 'a column with a formula is summed cell by cell');
});
