// Import and export: ZIP (bounded, checked), XML (no DTDs), .xlsx (our own
// round trip, files read by openpyxl — an independent implementation — and
// files written by openpyxl or by hand the way Excel writes them), CSV
// (RFC 4180, encodings, delimiters, the injection guard) and hostile files.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as E from '../src/shared/engine/index.js';
import { openZip, makeZip, browserCodec, crc32, ZipError } from '../src/shared/io/zip.js';
import { saxParse, parseTree, esc, XmlError } from '../src/shared/io/xml.js';
import { readXlsx, writeXlsx, exportNotes, XlsxError } from '../src/shared/io/xlsx.js';
import { parseCsv, detectDelimiter, decodeText, fieldToCell, readCsv, sheetToCsv } from '../src/shared/io/csv.js';

const { ops } = E;
globalThis.ReliabilityStats = createRequire(import.meta.url)('../../public/js/reliability-stats.js');
const nodeCodec = {
  async inflate(data, max) {
    try { return new Uint8Array(zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, max) })); }
    catch (e) { if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw new ZipError('too large'); throw e; }
  },
  async deflate(data) { return new Uint8Array(zlib.deflateRawSync(data)); }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsheets-io-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let python = null;
try { execFileSync('python3', ['-I', '-c', 'import openpyxl'], { stdio: 'ignore' }); python = 'python3'; } catch { /* the openpyxl cross-checks are skipped */ }
/** Runs a Python snippet with openpyxl; argv[1] is the file */
const py = (code, file) => JSON.parse(execFileSync(python, ['-I', '-c', code, file], { encoding: 'utf8' }));

const code = v => (v instanceof E.CellError ? v.code : v);
function book(name = 'Test') {
  const wb = E.newWorkbook(name);
  const s = wb.activeSheet;
  const put = (cells, sheet) => ops.setInputs(wb, sheet || s, Object.entries(cells).map(([a, v]) => { const p = E.parseA1(a); return { r: p.r, c: p.c, input: String(v) }; }));
  const at = (a, sheet) => { const p = E.parseA1(a); return (sheet || s).get(p.r, p.c); };
  const style = (a, patch, sheet) => { const g = E.parseRange(a); ops.styleRanges(wb, sheet || s, [g], patch); };
  return { wb, s, put, at, style };
}
const val = (wb, sheetName, a) => { const sh = wb.sheetByName(sheetName); const p = E.parseA1(a); return code(wb.valueAt(sh, p.r, p.c)); };
const cellOf = (wb, sheetName, a) => { const p = E.parseA1(a); return wb.sheetByName(sheetName).get(p.r, p.c); };
const styleOf = (wb, sheetName, a) => { const c = cellOf(wb, sheetName, a); return wb.styles.get(c ? c.s : undefined); };

/* ── ZIP ─────────────────────────────────────────── */

test('zip: round trip with both codecs; damaged, encrypted, ZIP64 and oversized entries are refused', async () => {
  const files = [{ name: 'a.txt', data: 'hello '.repeat(1000) }, { name: 'dir/ü.bin', data: new Uint8Array([0, 1, 2, 255]) }];
  for (const codec of [browserCodec, nodeCodec]) {
    const bytes = await makeZip(files, { deflate: codec.deflate });
    const z = openZip(bytes, { inflate: codec.inflate });
    assert.deepEqual(z.names(), ['a.txt', 'dir/ü.bin']);
    assert.equal(await z.text('a.txt'), 'hello '.repeat(1000));
    assert.deepEqual(Array.from(await z.read('dir/ü.bin')), [0, 1, 2, 255]);
    assert.equal(await z.read('missing'), null);
  }
  // python's zipfile reads what we write
  const bytes = await makeZip(files, { deflate: browserCodec.deflate });
  if (python) {
    fs.writeFileSync(path.join(tmp, 'x.zip'), bytes);
    const out = py('import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"bad":z.testzip(),"n":z.namelist(),"a":len(z.read("a.txt"))}))', path.join(tmp, 'x.zip'));
    assert.deepEqual(out, { bad: null, n: ['a.txt', 'dir/ü.bin'], a: 6000 });
  }
  // a flipped byte in the data → checksum mismatch (or an inflate error)
  const damaged = bytes.slice();
  damaged[40] ^= 0xFF;
  await assert.rejects(openZip(damaged, { inflate: browserCodec.inflate }).read('a.txt'));
  // encrypted flag
  const enc = bytes.slice();
  const dv = new DataView(enc.buffer);
  const cd = dv.getUint32(enc.length - 22 + 16, true);
  dv.setUint16(cd + 8, dv.getUint16(cd + 8, true) | 1, true);
  await assert.rejects(openZip(enc, { inflate: browserCodec.inflate }).read('a.txt'), /encrypted/);
  // ZIP64 markers
  const z64 = bytes.slice();
  new DataView(z64.buffer).setUint32(z64.length - 22 + 16, 0xFFFFFFFF, true);
  assert.throws(() => openZip(z64, { inflate: browserCodec.inflate }), /ZIP64/);
  // not a zip
  assert.throws(() => openZip(new TextEncoder().encode('just text, not an archive'), { inflate: browserCodec.inflate }), ZipError);
  // too many entries
  assert.throws(() => openZip(bytes, { inflate: browserCodec.inflate, maxEntries: 1 }), /too many entries/);
});

test('zip: a "zip bomb" stops at the size limit while inflating, whatever the header claims', async () => {
  const big = new Uint8Array(50 * 1024 * 1024);                // 50 MB of zeros → ~50 KB compressed
  const bytes = await makeZip([{ name: 'bomb.xml', data: big }], { deflate: nodeCodec.deflate });
  assert.ok(bytes.length < 200 * 1024);
  // the header's size is honest here: refused before inflating
  await assert.rejects(openZip(bytes, { inflate: browserCodec.inflate, maxEntryBytes: 10 * 1024 * 1024 }).read('bomb.xml'), /too large/);
  // a lying header (claims 1 KB): the inflater itself stops at the limit
  const liar = bytes.slice();
  const dv = new DataView(liar.buffer);
  const cd = dv.getUint32(liar.length - 22 + 16, true);
  dv.setUint32(cd + 24, 1024, true);
  for (const codec of [browserCodec, nodeCodec]) {
    await assert.rejects(openZip(liar, { inflate: codec.inflate, maxEntryBytes: 10 * 1024 * 1024 }).read('bomb.xml'));
  }
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

/* ── XML ─────────────────────────────────────────── */

test('xml: DOCTYPE (entity expansion) refused; entities, CDATA and namespaces handled; text escaped for output', () => {
  const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
  assert.throws(() => parseTree(laughs), XmlError);
  const ext = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><x>&xxe;</x>';
  assert.throws(() => parseTree(ext), XmlError);
  const t = parseTree('<x:root xmlns:x="u" a="1 &amp; 2"><x:c>&lt;b&gt; &#65;&#x42; &unknown;</x:c><![CDATA[<raw>]]><!-- c --></x:root>');
  assert.equal(t.children[0].name, 'root');
  assert.equal(t.children[0].attrs.a, '1 & 2');
  assert.equal(t.children[0].children[0].text, '<b> AB &unknown;');
  assert.equal(t.children[0].text, '<raw>');
  assert.throws(() => saxParse('<a><b', {}), XmlError);
  assert.equal(esc('a<b>&"c"\u0001\u0008ok'), 'a&lt;b&gt;&amp;&quot;c&quot;ok');
});

/* ── XLSX: our own round trip ────────────────────── */

function richBook() {
  const { wb, s, put, style } = book('Rich');
  s.name = 'Data';
  put({
    A1: 'Name', B1: 'Score', C1: 'When', D1: 'Flag', E1: 'Note',
    A2: 'Ada', B2: 91.5, C2: '2024-03-05', D2: 'TRUE', E2: '  padded  ',
    A3: 'Grace & "Hopper" <x>', B3: -7, C3: '2024-12-31 14:30', D3: 'FALSE', E3: 'line1\nline2',
    A4: 'Ünïcødé 漢字 🙂', B4: 1e-7, C4: '9:15', D4: '#N/A', E4: "'00123",
    B5: '=SUM(B2:B4)', B6: '=IFS(B2>90,"A",TRUE,"B")', B7: '=XLOOKUP("Ada",A2:A4,B2:B4)', B8: '=B5/0', B9: '=A2&" "&TEXT(C2,"yyyy")',
    B10: '=CONCAT(A2,"-",A3)', B11: '=STDEV.S(B2:B4)'
  });
  style('A1:E1', { bold: true, fill: '#1F4E79', color: '#FFFFFF', h: 'center' });
  style('B2:B4', { numFmt: '#,##0.00;[Red]-#,##0.00' });
  style('A3', { italic: true, underline: true, strike: true, size: 14, family: 'Georgia', v: 'middle', wrap: true, indent: 2 });
  ops.setBorders(wb, s, [E.parseRange('A2:B3')], 'all', { style: 'medium', color: '#FF0000' });
  s.colWidths.set(0, 180); s.colWidths.set(4, 60);
  s.rowHeights.set(0, 32); s.rowHeights.set(20, 40);   // row 21 has only a height
  s.hiddenRows.add(15); s.hiddenCols.add(6);
  s.freeze = { rows: 1, cols: 1 };
  s.filter = { range: { r1: 0, c1: 0, r2: 3, c2: 4 }, conditions: {} };
  s.tabColor = '#00B050';
  const other = wb.addSheet("Q1 'Raw' data");
  put({ A1: 10, A2: 20, B1: "=SUM(Data!B2:B3)+A1", B2: '=COHENKAPPA(A1:A2,A1:A2)' }, other);
  put({ F1: "='Q1 ''Raw'' data'!A2*2" });
  wb.activeSheetId = other.id;
  return wb;
}

test('xlsx: everything the app keeps survives a write and read through our own code', async () => {
  const wb = richBook();
  const bytes = await writeXlsx(wb, { deflate: browserCodec.deflate });
  fs.writeFileSync(path.join(tmp, 'rich.xlsx'), bytes);
  const { workbook: back, notes } = await readXlsx(bytes, { inflate: browserCodec.inflate, name: 'rich' });
  assert.deepEqual(back.sheets.map(s => s.name), ['Data', "Q1 'Raw' data"]);
  assert.equal(back.activeSheet.name, "Q1 'Raw' data");
  const d = 'Data';
  assert.equal(val(back, d, 'A3'), 'Grace & "Hopper" <x>');
  assert.equal(val(back, d, 'A4'), 'Ünïcødé 漢字 🙂');
  assert.equal(val(back, d, 'E2'), '  padded  ');
  assert.equal(val(back, d, 'E3'), 'line1\nline2');
  assert.equal(val(back, d, 'E4'), '00123');
  assert.equal(val(back, d, 'B4'), 1e-7);
  assert.equal(val(back, d, 'D2'), true);
  assert.equal(val(back, d, 'D3'), false);
  assert.equal(val(back, d, 'D4'), '#N/A');
  assert.equal(val(back, d, 'C2'), E.dateToSerial(2024, 3, 5));
  assert.ok(E.isDateFormat(styleOf(back, d, 'C2').numFmt));
  assert.equal(cellOf(back, d, 'B6').f, '=IFS(B2>90,"A",TRUE,"B")', 'the _xlfn. prefix is written and removed again');
  assert.equal(val(back, d, 'B6'), 'A');
  assert.equal(val(back, d, 'B7'), 91.5);
  assert.equal(val(back, d, 'B8'), '#DIV/0!');
  assert.equal(val(back, d, 'B9'), 'Ada 2024');
  assert.equal(val(back, d, 'B10'), 'Ada-Grace & "Hopper" <x>');
  assert.equal(val(back, d, 'F1'), 40);
  assert.equal(val(back, "Q1 'Raw' data", 'B1'), 10 + 91.5 - 7);
  assert.equal(val(back, "Q1 'Raw' data", 'B2'), 1);
  const h = styleOf(back, d, 'A1');
  assert.deepEqual([h.bold, h.fill, h.color, h.h], [true, '#1F4E79', '#FFFFFF', 'center']);
  assert.equal(styleOf(back, d, 'B2').numFmt, '#,##0.00;[Red]-#,##0.00');
  const a3 = styleOf(back, d, 'A3');
  assert.deepEqual([a3.italic, a3.underline, a3.strike, a3.size, a3.family, a3.v, a3.wrap, a3.indent], [true, true, true, 14, 'Georgia', 'middle', true, 2]);
  assert.deepEqual(a3.border.top, { style: 'medium', color: '#FF0000' });
  const s = back.sheetByName(d);
  assert.equal(s.colWidths.get(0), 180);
  assert.equal(s.colWidths.get(4), 60);
  assert.equal(s.rowHeights.get(0), 32);
  assert.equal(s.rowHeights.get(20), 40);
  assert.ok(s.hiddenRows.has(15) && s.hiddenCols.has(6));
  assert.deepEqual(s.freeze, { rows: 1, cols: 1 });
  assert.deepEqual(s.filter.range, { r1: 0, c1: 0, r2: 3, c2: 4 });
  assert.equal(s.tabColor, '#00B050');
  assert.deepEqual(notes, []);
  assert.match(exportNotes(wb)[0], /COHENKAPPA/);
  assert.deepEqual(exportNotes(E.newWorkbook('x')), []);
});

test('xlsx: openpyxl (an independent reader) opens our files and sees the same contents', { skip: !python && 'python3 with openpyxl isn\'t installed' }, async () => {
  const out = py(`
import sys, json, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb["Data"]
q = wb["Q1 'Raw' data"]
c = lambda a: ws[a].value
print(json.dumps({
  "sheets": wb.sheetnames, "active": wb.active.title,
  "a3": c("A3"), "a4": c("A4"), "e3": c("E3"), "e2": c("E2"), "b2": c("B2"), "d2": c("D2"), "d4": c("D4"),
  "c2": ws["C2"].value.isoformat(), "c2fmt": ws["C2"].number_format,
  "b6": c("B6"), "b7": c("B7"), "f1": c("F1"), "qb1": q["B1"].value,
  "bold": ws["A1"].font.b, "fill": ws["A1"].fill.fgColor.rgb, "fontColor": ws["A1"].font.color.rgb, "align": ws["A1"].alignment.horizontal,
  "fmt": ws["B2"].number_format, "border": ws["A2"].border.top.style, "borderColor": ws["A2"].border.top.color.rgb,
  "italic": ws["A3"].font.i, "size": ws["A3"].font.sz, "family": ws["A3"].font.name, "wrap": ws["A3"].alignment.wrap_text,
  "widthA": round(ws.column_dimensions["A"].width, 2), "height1": ws.row_dimensions[1].height,
  "hiddenRow": ws.row_dimensions[16].hidden, "hiddenCol": ws.column_dimensions["G"].hidden,
  "freeze": ws.freeze_panes, "filter": ws.auto_filter.ref, "tab": ws.sheet_properties.tabColor.rgb,
  "dims": ws.dimensions
}))`, path.join(tmp, 'rich.xlsx'));
  assert.deepEqual(out.sheets, ['Data', "Q1 'Raw' data"]);
  assert.equal(out.active, "Q1 'Raw' data");
  assert.equal(out.a3, 'Grace & "Hopper" <x>');
  assert.equal(out.a4, 'Ünïcødé 漢字 🙂');
  assert.equal(out.e3, 'line1\nline2');
  assert.equal(out.e2, '  padded  ');
  assert.equal(out.b2, 91.5);
  assert.equal(out.d2, true);
  assert.equal(out.d4, '#N/A');
  assert.equal(out.c2, '2024-03-05T00:00:00');
  assert.ok(/y/.test(out.c2fmt));
  assert.equal(out.b6, '=_xlfn.IFS(B2>90,"A",TRUE,"B")');
  assert.equal(out.b7, '=_xlfn.XLOOKUP("Ada",A2:A4,B2:B4)');
  assert.equal(out.f1, "='Q1 ''Raw'' data'!A2*2");
  assert.equal(out.qb1, '=SUM(Data!B2:B3)+A1');
  assert.equal(out.bold, true);
  assert.equal(out.fill, 'FF1F4E79');
  assert.equal(out.fontColor, 'FFFFFFFF');
  assert.equal(out.align, 'center');
  assert.equal(out.fmt, '#,##0.00;[Red]-#,##0.00');
  assert.equal(out.border, 'medium');
  assert.equal(out.borderColor, 'FFFF0000');
  assert.deepEqual([out.italic, out.size, out.family, out.wrap], [true, 14, 'Georgia', true]);
  assert.equal(out.widthA, 25);                                   // (180 - 5) / 7
  assert.equal(out.height1, 24);                                  // 32 px = 24 pt
  assert.equal(out.hiddenRow, true);
  assert.equal(out.hiddenCol, true);
  assert.equal(out.freeze, 'B2');
  assert.equal(out.filter, 'A1:E4');
  assert.equal(out.tab, 'FF00B050');
});

test('xlsx: a workbook written by openpyxl reads correctly (dates, styles, merged cells, freeze, widths)', { skip: !python && 'python3 with openpyxl isn\'t installed' }, async () => {
  const file = path.join(tmp, 'openpyxl.xlsx');
  execFileSync(python, ['-I', '-c', `
import sys, datetime, openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Survey 2024"
ws.append(["id", "text", "likes", "posted", "ok"])
ws.append(["1789012345678901234", "Great post!", 12, datetime.datetime(2024, 5, 1, 13, 45), True])
ws.append(["0042", "=not a formula", 3.25, datetime.date(1999, 12, 31), False])
ws["B3"].data_type = "s"
ws["F1"] = "=SUM(C2:C3)"
ws["F2"] = "=AVERAGE(C2:C3)"
ws["G1"] = "=_xlfn.IFS(C2>10,\\"many\\",TRUE,\\"few\\")"
ws["A1"].font = Font(bold=True, color="FF0000FF", size=13)
ws["B1"].fill = PatternFill("solid", fgColor="FFFFFF00")
ws["C1"].alignment = Alignment(horizontal="right", vertical="top", wrap_text=True)
ws["D1"].border = Border(bottom=Side(style="thick", color="FF00FF00"))
ws["C2"].number_format = "0.0%"
ws.column_dimensions["B"].width = 40
ws.row_dimensions[3].height = 30
ws.row_dimensions[4].hidden = True
ws.freeze_panes = "A2"
ws.merge_cells("H1:I2")
ws["H1"] = "merged"
ws.sheet_properties.tabColor = "FF7030A0"
other = wb.create_sheet("Lookup")
other["A1"] = "=VLOOKUP(\\"Great post!\\",'Survey 2024'!B2:C3,2,FALSE)"
wb.save(sys.argv[1])
`, file]);
  const { workbook: wb, notes } = await readXlsx(new Uint8Array(fs.readFileSync(file)), { inflate: browserCodec.inflate });
  const n = 'Survey 2024';
  assert.deepEqual(wb.sheets.map(s => s.name), [n, 'Lookup']);
  assert.equal(val(wb, n, 'A2'), '1789012345678901234', 'long IDs stay exact text');
  assert.equal(val(wb, n, 'A3'), '0042');
  assert.equal(val(wb, n, 'B3'), '=not a formula');
  assert.equal(cellOf(wb, n, 'B3').f, undefined, 'a string that starts with = is not a formula');
  assert.equal(val(wb, n, 'C3'), 3.25);
  assert.ok(Math.abs(val(wb, n, 'D2') - (E.dateToSerial(2024, 5, 1) + (13 * 60 + 45) / 1440)) < 1e-9);
  assert.equal(val(wb, n, 'D3'), E.dateToSerial(1999, 12, 31));
  assert.ok(E.isDateFormat(styleOf(wb, n, 'D2').numFmt));
  assert.equal(val(wb, n, 'E2'), true);
  assert.equal(val(wb, n, 'F1'), 15.25, 'formulas are recalculated on open');
  assert.equal(val(wb, n, 'F2'), 7.625);
  assert.equal(cellOf(wb, n, 'G1').f, '=IFS(C2>10,"many",TRUE,"few")');
  assert.equal(val(wb, n, 'G1'), 'many');
  assert.equal(val(wb, 'Lookup', 'A1'), 12);
  const a1 = styleOf(wb, n, 'A1');
  assert.deepEqual([a1.bold, a1.color, a1.size], [true, '#0000FF', 13]);
  assert.equal(styleOf(wb, n, 'B1').fill, '#FFFF00');
  const c1 = styleOf(wb, n, 'C1');
  assert.deepEqual([c1.h, c1.v, c1.wrap], ['right', 'top', true]);
  assert.deepEqual(styleOf(wb, n, 'D1').border.bottom, { style: 'thick', color: '#00FF00' });
  assert.equal(styleOf(wb, n, 'C2').numFmt, '0.0%');
  const s = wb.sheetByName(n);
  assert.equal(s.colWidths.get(1), 285);
  assert.equal(s.rowHeights.get(2), 40);
  assert.ok(s.hiddenRows.has(3));
  assert.deepEqual(s.freeze, { rows: 1, cols: 0 });
  assert.equal(s.tabColor, '#7030A0');
  assert.equal(val(wb, n, 'H1'), 'merged');
  assert.ok(notes.some(t => /merged cell range/.test(t)));
});

/** A hand-made .xlsx with what Excel writes and openpyxl doesn't */
async function excelStyleFile(o = {}) {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:workbookPr${o.date1904 ? ' date1904="1"' : ''}/><x:bookViews><x:workbookView activeTab="1"/></x:bookViews><x:sheets><x:sheet name="One" sheetId="1" r:id="rId1"/><x:sheet name="Two" sheetId="2" state="hidden" r:id="rId2"/><x:sheet name="Chart1" sheetId="3" r:id="rId9"/></x:sheets></x:workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId9" Target="chartsheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/theme/theme1.xml', data: '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="x"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="112233"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme></a:themeElements></a:theme>' },
    { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst ${ns}><si><t>plain</t></si><si><r><rPr><b/></rPr><t>rich </t></r><r><t xml:space="preserve">text</t></r></si><si><t>漢字</t><rPh sb="0" eb="2"><t>かんじ</t></rPh></si></sst>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0"?><styleSheet ${ns}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color theme="4" tint="0.5"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor indexed="10"/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0"?><worksheet ${ns}><sheetViews><sheetView><pane xSplit="2" ySplit="3" topLeftCell="C4" state="frozen"/></sheetView></sheetViews><cols><col min="2" max="3" width="20" customWidth="1"/><col min="5" max="5" width="9" hidden="1"/></cols><sheetData>` +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s" s="2"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>inline</t></is></c><c r="E1" t="e"><v>#REF!</v></c></row>' +
      '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B5" si="0">A2*10+$A$2</f><v>11</v></c><c r="C2" s="1"><v>45000</v></c><c r="D2" t="d"><v>2024-01-02T12:00:00Z</v></c></row>' +
      '<row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>0</v></c><c r="C3" s="3"><v>1</v></c></row>' +
      '<row r="4" ht="30" customHeight="1" hidden="1"><c r="A4"><v>3</v></c><c r="B4"><f t="shared" si="0"/></c></row>' +
      '<row><c><v>4</v></c><c><f t="shared" si="0"/></c><c t="str"><f>_xlfn.CONCAT("a","b")</f><v>ab</v></c><c t="b"><v>1</v></c></row>' +
      '</sheetData><autoFilter ref="A1:D5"/><mergeCells count="1"><mergeCell ref="F1:G1"/></mergeCells></worksheet>' },
    { name: 'xl/worksheets/sheet2.xml', data: `<?xml version="1.0"?><worksheet ${ns}><sheetPr><tabColor theme="4"/></sheetPr><sheetData><row r="1"><c r="A1"><f>One!B5+1</f><v>0</v></c><c r="B1"><f>FORECAST.ETS(1,2,3)</f></c></row></sheetData></worksheet>` }
  ];
  if (o.macros) files.push({ name: 'xl/vbaProject.bin', data: new Uint8Array([1, 2, 3]) });
  if (o.extraSheet) files.find(f => f.name === 'xl/worksheets/sheet2.xml').data = o.extraSheet;
  return makeZip(files, { deflate: browserCodec.deflate });
}

test('xlsx: Excel-style XML — shared formulas, rich and phonetic strings, theme/indexed colours, implicit positions, 1904 dates', async () => {
  const { workbook: wb, notes } = await readXlsx(await excelStyleFile(), { inflate: browserCodec.inflate });
  assert.deepEqual(wb.sheets.map(s => s.name), ['One', 'Two']);
  assert.equal(wb.activeSheet.name, 'Two');
  assert.equal(val(wb, 'One', 'A1'), 'plain');
  assert.equal(val(wb, 'One', 'B1'), 'rich text');
  assert.equal(val(wb, 'One', 'C1'), '漢字', 'phonetic runs are not part of the text');
  assert.equal(val(wb, 'One', 'D1'), 'inline');
  assert.equal(val(wb, 'One', 'E1'), '#REF!');
  assert.deepEqual(['B2', 'B3', 'B4', 'B5'].map(a => cellOf(wb, 'One', a).f), ['=A2*10+$A$2', '=A3*10+$A$2', '=A4*10+$A$2', '=A5*10+$A$2']);
  assert.deepEqual(['B2', 'B3', 'B4', 'B5'].map(a => val(wb, 'One', a)), [11, 21, 31, 41]);
  assert.equal(val(wb, 'One', 'A5'), 4, 'cells without r= follow on');
  assert.equal(cellOf(wb, 'One', 'C5').f, '=CONCAT("a","b")');
  assert.equal(val(wb, 'One', 'D5'), true);
  assert.equal(val(wb, 'One', 'C2'), 45000);
  assert.equal(styleOf(wb, 'One', 'C2').numFmt, 'dd/mm/yyyy');
  assert.equal(val(wb, 'One', 'D2'), E.dateToSerial(2024, 1, 2) + 0.5);
  const b1 = styleOf(wb, 'One', 'B1');
  assert.equal(b1.bold, true);
  assert.equal(b1.color, '#889199', 'theme accent1 (#112233) lightened by tint 0.5');
  assert.equal(b1.fill, '#FF0000', 'indexed colour 10');
  const one = wb.sheetByName('One');
  assert.deepEqual(one.freeze, { rows: 3, cols: 2 });
  assert.equal(one.colWidths.get(1), 145);
  assert.equal(one.colWidths.get(2), 145);
  assert.ok(one.hiddenCols.has(4));
  assert.equal(one.rowHeights.get(3), 40);
  assert.ok(one.hiddenRows.has(3));
  assert.deepEqual(one.filter.range, { r1: 0, c1: 0, r2: 4, c2: 3 });
  assert.equal(val(wb, 'Two', 'A1'), 42);
  assert.equal(val(wb, 'Two', 'B1'), '#NAME?');
  assert.equal(wb.sheetByName('Two').tabColor, '#112233');
  assert.ok(notes.some(t => /"Two" was a hidden sheet/.test(t)));
  assert.ok(notes.some(t => /"Chart1" isn't a worksheet/.test(t)));
  assert.ok(notes.some(t => /merged cell range/.test(t)));
  assert.ok(notes.some(t => /FORECAST\.ETS/.test(t)), 'unknown functions are listed');

  const { workbook: w1904 } = await readXlsx(await excelStyleFile({ date1904: true }), { inflate: browserCodec.inflate });
  assert.equal(val(w1904, 'One', 'C2'), 45000 + 1462, 'dates in the 1904 system move to 1900');
  assert.equal(val(w1904, 'One', 'C3'), 1 + 1462);
  assert.equal(val(w1904, 'One', 'A2'), 1, 'plain numbers don\'t move');
});

test('xlsx: hostile and wrong files are refused with a message; macros are never run', async () => {
  const { notes } = await readXlsx(await excelStyleFile({ macros: true }), { inflate: browserCodec.inflate });
  assert.ok(notes.some(t => /macros were ignored/.test(t)));
  const doctype = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaa">]><worksheet><sheetData/></worksheet>';
  await assert.rejects(readXlsx(await excelStyleFile({ extraSheet: doctype }), { inflate: browserCodec.inflate }), (e) => e instanceof XlsxError && /damaged/.test(e.message));
  await assert.rejects(readXlsx(await excelStyleFile(), { inflate: browserCodec.inflate, maxCells: 5 }), /more than 5 cells/);
  await assert.rejects(readXlsx(new TextEncoder().encode('a,b\n1,2'), { inflate: browserCodec.inflate }), XlsxError);
  const docx = await makeZip([{ name: 'word/document.xml', data: '<w:document/>' }], { deflate: browserCodec.deflate });
  await assert.rejects(readXlsx(docx, { inflate: browserCodec.inflate }), /Word document/);
  const noSheets = await makeZip([{ name: 'xl/workbook.xml', data: '<workbook><sheets/></workbook>' }], { deflate: browserCodec.deflate });
  await assert.rejects(readXlsx(noSheets, { inflate: browserCodec.inflate }), /no sheets/);
});

test('xlsx: 100,000 cells write and read back in reasonable time (measured)', async () => {
  const wb = E.newWorkbook('Big');
  const s = wb.activeSheet;
  const words = ['alpha', 'beta', 'gamma', 'delta'];
  for (let r = 0; r < 20000; r++) {
    s.cells.set(E.keyOf(r, 0), { v: r });
    s.cells.set(E.keyOf(r, 1), { v: words[r % 4] + ' ' + (r % 100) });
    s.cells.set(E.keyOf(r, 2), { v: r * 1.5 });
    s.cells.set(E.keyOf(r, 3), { v: r % 2 === 0 });
    s.cells.set(E.keyOf(r, 4), { v: null, f: '=A' + (r + 1) + '+C' + (r + 1) });
  }
  s._bounds = null;
  wb.calc.rebuild();
  wb.calc.recalcAll();
  let t = performance.now();
  const bytes = await writeXlsx(wb, { deflate: browserCodec.deflate });
  const writeMs = performance.now() - t;
  t = performance.now();
  const { workbook: back } = await readXlsx(bytes, { inflate: browserCodec.inflate });
  const readMs = performance.now() - t;
  console.log(`  100k-cell .xlsx: ${(bytes.length / 1024).toFixed(0)} KB, write ${writeMs.toFixed(0)} ms, read+recalc ${readMs.toFixed(0)} ms`);
  assert.equal(val(back, 'Sheet1', 'E20000'), 19999 + 19999 * 1.5);
  assert.equal(val(back, 'Sheet1', 'B7'), 'gamma 6');
  assert.ok(writeMs < 15000 && readMs < 15000);
});

/* ── CSV ─────────────────────────────────────────── */

test('csv: RFC 4180 parsing — quotes, doubled quotes, line breaks in fields, CRLF/LF/CR, empty fields', () => {
  const { rows, delimiter } = parseCsv('a,"b,c","say ""hi""",\r\n"multi\nline",,x\rlast,"",end\n');
  assert.equal(delimiter, ',');
  assert.deepEqual(rows, [['a', 'b,c', 'say "hi"', ''], ['multi\nline', '', 'x'], ['last', '', 'end']]);
  assert.deepEqual(parseCsv('﻿one,two').rows, [['one', 'two']]);
  assert.deepEqual(parseCsv('"unclosed,quote\nstill').rows, [['unclosed,quote\nstill']], 'an unclosed quote runs to the end, as in Excel');
  assert.deepEqual(parseCsv('"a"b,c').rows, [['ab', 'c']], 'text after a closing quote is kept');
  assert.deepEqual(parseCsv('').rows, []);
  const big = parseCsv('1,2,3\n4,5,6\n7,8,9', { maxCells: 4 });
  assert.equal(big.truncated, true);
});

test('csv: delimiter and encoding detection', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2,5;3\n4;5;6'), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a|b\n1|2'), '|');
  assert.equal(detectDelimiter('"x,y";b\n"1,2";3\n"5,6";4'), ';', 'commas inside quotes don\'t count');
  assert.equal(detectDelimiter('single column\nvalues'), ',');
  const utf16 = new Uint8Array([0xFF, 0xFE, ...Array.from(Buffer.from('é,ü\n1,2', 'utf16le'))]);
  assert.deepEqual(decodeText(utf16), { text: 'é,ü\n1,2', encoding: 'UTF-16 LE' });
  assert.deepEqual(decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41])), { text: 'A', encoding: 'UTF-8 (BOM)' });
  assert.deepEqual(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xE9])), { text: 'café', encoding: 'Windows-1252' }, 'not valid UTF-8 → Windows-1252');
  assert.equal(decodeText(new TextEncoder().encode('naïve')).encoding, 'UTF-8');
});

test('csv: fields become values like Excel, but IDs, leading zeros and formulas stay text', () => {
  assert.deepEqual(fieldToCell('42'), { v: 42 });
  assert.deepEqual(fieldToCell('-3.5'), { v: -3.5 });
  assert.deepEqual(fieldToCell('12%'), { v: 0.12, numFmt: '0%' });
  assert.deepEqual(fieldToCell('$1,200.50'), { v: 1200.5, numFmt: '$#,##0.00' });
  assert.deepEqual(fieldToCell('TRUE'), { v: true });
  assert.deepEqual(fieldToCell('2024-03-05'), { v: E.dateToSerial(2024, 3, 5), numFmt: 'yyyy-mm-dd' });
  assert.deepEqual(fieldToCell('00123'), { v: '00123' });
  assert.deepEqual(fieldToCell('1789012345678901234'), { v: '1789012345678901234' });
  assert.deepEqual(fieldToCell('=HYPERLINK("http://evil","x")'), { v: '=HYPERLINK("http://evil","x")' });
  assert.deepEqual(fieldToCell('=1+1', { formulas: true }), { v: null, f: '=1+1' });
  assert.deepEqual(fieldToCell("'quoted"), { v: "'quoted" });
  assert.deepEqual(fieldToCell('42', { convert: false }), { v: '42' });
  assert.deepEqual(fieldToCell('hello'), { v: 'hello' });
  assert.equal(fieldToCell(''), null);
});

test('csv: import into a workbook, export with quoting and the injection guard, and round trip', () => {
  const csv = 'id,text,likes,posted\n1789012345678901234,"Hello, world",5,2024-05-01\n0042,=cmd|\' /C calc\'!A0,-3,\n';
  const { workbook: wb, delimiter, encoding, rows } = readCsv(new TextEncoder().encode(csv), { name: 'posts.csv' });
  assert.deepEqual([delimiter, encoding, rows], [',', 'UTF-8', 3]);
  const s = wb.activeSheet;
  assert.equal(s.name, 'posts');
  assert.equal(val(wb, 'posts', 'A2'), '1789012345678901234');
  assert.equal(val(wb, 'posts', 'B2'), 'Hello, world');
  assert.equal(val(wb, 'posts', 'C3'), -3);
  assert.equal(val(wb, 'posts', 'B3'), "=cmd|' /C calc'!A0");
  assert.equal(s.get(2, 1).f, undefined, 'the formula in the file was not run');
  const out = sheetToCsv(wb, s);
  assert.equal(out.split('\r\n')[2], "0042,'=cmd|' /C calc'!A0,-3,", 'text that looks like a formula gets an apostrophe; a real negative number doesn\'t');
  assert.equal(out.split('\r\n')[1], '1789012345678901234,"Hello, world",5,2024-05-01', 'dates are written as shown');
  assert.ok(out.endsWith('\r\n'));
  // the guard can be turned off; then the original text round-trips exactly
  const raw = sheetToCsv(wb, s, { protect: false });
  assert.deepEqual(parseCsv(raw).rows, parseCsv(csv).rows.map(r => r.concat(Array(4 - r.length).fill(''))));
  // other values: booleans, errors, formulas' results, text needing quotes, guard cases
  const { wb: w2, s: s2, put } = book();
  put({ A1: 'TRUE', B1: '#N/A', C1: '=2*21', D1: 'multi\nline', E1: ' lead', F1: '@SUM(1)', G1: "'+cmd", H1: "'-5" });
  assert.equal(sheetToCsv(w2, s2), 'TRUE,#N/A,42,"multi\nline"," lead",\'@SUM(1),\'+cmd,-5\r\n', 'text "-5" is a plain number: no apostrophe needed');
  assert.equal(sheetToCsv(w2, s2, { delimiter: '\t', range: { r1: 0, c1: 0, r2: 0, c2: 2 } }), 'TRUE\t#N/A\t42\r\n');
  assert.ok(sheetToCsv(w2, s2, { bom: true }).startsWith('﻿'));
  // full-precision numbers unless asked for what's shown
  const { wb: w3, s: s3, put: put3, style } = book();
  put3({ A1: '3.14159265358979', A2: '1234567.891' });
  style('A1:A2', { numFmt: '#,##0.00' });
  assert.equal(sheetToCsv(w3, s3), '3.14159265358979\r\n1234567.891\r\n');
  assert.equal(sheetToCsv(w3, s3, { formatted: true }), '3.14\r\n"1,234,567.89"\r\n');
  // hidden rows can be left out (e.g. exporting a filtered view)
  s3.hiddenRows.add(0);
  assert.equal(sheetToCsv(w3, s3, { skipHidden: true }), '1234567.891\r\n');
  assert.equal(sheetToCsv(E.newWorkbook('e'), E.newWorkbook('e').activeSheet), '');
});
