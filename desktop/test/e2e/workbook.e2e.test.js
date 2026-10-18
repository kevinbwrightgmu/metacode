// End to end: working with workbooks in the real app — typing, formulas,
// formatting, copy/paste, undo, fill, sort, filter, sheets, saving and
// reopening, import and export (CSV, .xlsx), crash recovery, files changed or
// deleted by other programs, and a 100,000-row sheet (timed).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startWorld, launchApp, signIn, waitForStatus, newWorkbook, typeRows, cell, goTo, mod } = require('./fixtures');

let world;
test.before(async () => { world = await startWorld(); });
test.after(async () => { if (world) await world.close(); });

/** A signed-in (Pro) app, optionally with AutoSave off */
async function ready(o = {}) {
  const l = await launchApp(world, o);
  if (!o.userData) { await signIn(l.page, world.users.pro); }
  await waitForStatus(l.page, ['active']);
  await l.page.waitForSelector('#shell:not([hidden])');
  if (o.autosave === false) {
    await l.page.evaluate(async () => { await window.sheets.setSettings({ autosave: false }); window.__sheetsApp.applySettings(await window.sheets.getSettings()); });
  }
  return l;
}
/** Screen position of a cell's centre (or a corner) */
async function cellPoint(page, r, c, where = 'center') {
  return page.evaluate(([rr, cc, w]) => {
    const g = window.__sheetsApp.ws.grid;
    const rect = g.cellRect(rr, cc);
    const box = g.scroller.getBoundingClientRect();
    const z = g.zoom;
    const x = w === 'br' ? rect.x + rect.w - 1 : rect.x + rect.w / 2, y = w === 'br' ? rect.y + rect.h - 1 : rect.y + rect.h / 2;
    return { x: box.left + x * z, y: box.top + y * z };
  }, [r, c, where]);
}
const engine = () => import(path.join(__dirname, '..', '..', 'src', 'shared', 'engine', 'index.js'));

test('create, type, format, save, close and reopen: everything is kept', { timeout: 120000 }, async () => {
  const { app, page, library } = await ready({ autosave: false });
  try {
    await newWorkbook(page);
    await typeRows(page, [['Name', 'Score', 'Date'], ['Ada', 91, '2024-03-05'], ['Grace', 84.5, '2024-03-06'], ['Total', '=SUM(B2:B3)', '=C3-C2']]);
    assert.deepEqual(await cell(page, 'B4'), { v: 175.5, f: '=SUM(B2:B3)', style: {} });
    assert.equal((await cell(page, 'C4')).v, 1);
    assert.equal((await cell(page, 'C2')).style.numFmt, 'yyyy-mm-dd', 'a typed date gets a date format');
    await goTo(page, 'A1');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press(mod + '+b');
    assert.equal((await cell(page, 'C1')).style.bold, true);
    await page.keyboard.press(mod + '+s');
    await page.waitForFunction(() => window.__sheetsApp.current.saveState === 'saved' && !window.__sheetsApp.current.dirty);
    const file = await page.evaluate(() => window.__sheetsApp.current.path);
    assert.ok(file.startsWith(library));
    await page.keyboard.press(mod + '+w');
    await page.waitForSelector('#home:not([hidden]) .file-row');
    await page.click('.file-row >> text=Untitled spreadsheet');
    await page.waitForSelector('#workbook:not([hidden])');
    assert.equal((await cell(page, 'B4')).v, 175.5);
    assert.equal((await cell(page, 'B4')).f, '=SUM(B2:B3)');
    assert.equal((await cell(page, 'A1')).style.bold, true);
    assert.equal((await cell(page, 'C2')).style.numFmt, 'yyyy-mm-dd');
  } finally { await app.close(); }
});

test('copy and paste move formulas; cut moves references; undo and redo', { timeout: 120000 }, async () => {
  const { app, page } = await ready();
  try {
    await newWorkbook(page);
    await typeRows(page, [[1], ['=A1*2']]);
    await goTo(page, 'A2');
    await page.keyboard.press(mod + '+c');
    await goTo(page, 'A3');
    await page.keyboard.press(mod + '+v');
    assert.deepEqual([(await cell(page, 'A3')).f, (await cell(page, 'A3')).v], ['=A2*2', 4]);
    await page.keyboard.press(mod + '+z');
    assert.equal((await cell(page, 'A3')).v, null);
    await page.keyboard.press(mod + '+y');
    assert.equal((await cell(page, 'A3')).v, 4);
    // cut A1 to C1: A2's formula follows it
    await goTo(page, 'A1');
    await page.keyboard.press(mod + '+x');
    await goTo(page, 'C1');
    await page.keyboard.press(mod + '+v');
    assert.equal((await cell(page, 'A2')).f, '=C1*2');
    assert.equal((await cell(page, 'A2')).v, 2);
    // text pasted from another app (tab-separated)
    await page.evaluate(() => window.sheets.writeClipboard({ text: 'x\t10\ny\t20' }));
    await goTo(page, 'E1');
    await page.keyboard.press(mod + '+v');
    assert.deepEqual([(await cell(page, 'E2')).v, (await cell(page, 'F2')).v], ['y', 20]);
  } finally { await app.close(); }
});

test('the fill handle continues a series; Delete clears; editing with F2 and Escape', { timeout: 120000 }, async () => {
  const { app, page } = await ready();
  try {
    await newWorkbook(page);
    await typeRows(page, [[1], [2]]);
    await goTo(page, 'A1:A2');
    const from = await cellPoint(page, 1, 0, 'br');
    const to = await cellPoint(page, 5, 0);
    await page.mouse.move(from.x + 1, from.y + 1);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await Promise.all(['A3', 'A4', 'A5', 'A6'].map(async a => (await cell(page, a)).v)), [3, 4, 5, 6]);
    await goTo(page, 'A6');
    await page.keyboard.press('Delete');
    assert.equal((await cell(page, 'A6')).v, null);
    await goTo(page, 'A1');
    await page.keyboard.press('F2');
    await page.keyboard.type('0');
    await page.keyboard.press('Escape');
    assert.equal((await cell(page, 'A1')).v, 1, 'Escape cancels the edit');
    await page.keyboard.press('F2');
    await page.keyboard.type('0');
    await page.keyboard.press('Enter');
    assert.equal((await cell(page, 'A1')).v, 10);
  } finally { await app.close(); }
});

test('sort, filter (through the column\'s filter button), find, sheets and cross-sheet formulas', { timeout: 120000 }, async () => {
  const { app, page } = await ready();
  try {
    await newWorkbook(page);
    await typeRows(page, [['Name', 'Score'], ['Carol', 70], ['Ada', 91], ['Bob', 84]]);
    await goTo(page, 'A2');
    await page.click('button[data-cmd=sortAsc]');
    assert.deepEqual(await Promise.all(['A2', 'A3', 'A4'].map(async a => (await cell(page, a)).v)), ['Ada', 'Bob', 'Carol'], 'sorted, header kept on top');
    await page.keyboard.press(mod + '+Shift+f');
    await page.waitForFunction(() => !!window.__sheetsApp.current.wb.activeSheet.filter);
    // click B1's filter button on the canvas, pick a condition
    const btn = await page.evaluate(() => { const g = window.__sheetsApp.ws.grid; const r = g.cellRect(0, 1); const box = g.scroller.getBoundingClientRect(); return { x: box.left + (r.x + r.w - 10) * g.zoom, y: box.top + (r.y + r.h / 2) * g.zoom }; });
    await page.mouse.click(btn.x, btn.y);
    await page.waitForSelector('.filter-pop');
    await page.selectOption('.filter-pop select', '>');
    await page.fill('.filter-pop input[placeholder=Value]', '80');
    await page.click('.filter-pop button:has-text("Apply")');
    const hidden = await page.evaluate(() => Array.from(window.__sheetsApp.current.wb.activeSheet.filteredRows));
    assert.deepEqual(hidden, [3], 'Carol (70) is filtered out');
    // find
    await page.keyboard.press(mod + '+f');
    await page.fill('.floating.find input[placeholder=Find]', 'bob');
    await page.waitForSelector('.floating.find >> text=1 match');
    await page.keyboard.press('Escape');
    // a second sheet referring to the first
    await page.click('.sheet-bar .add');
    await page.waitForFunction(() => window.__sheetsApp.current.wb.sheets.length === 2);
    await page.dblclick('.sheet-tab[aria-selected=true]');
    await page.fill('.sheet-tab input', 'Summary');
    await page.keyboard.press('Enter');
    await page.focus('.grid .scroller');
    await typeRows(page, [['=SUM(Sheet1!B2:B4)']]);
    assert.equal((await cell(page, 'A1', 'Summary')).v, 245);
    // renaming the first sheet rewrites the formula
    await page.dblclick('.sheet-tab >> text=Sheet1');
    await page.fill('.sheet-tab input', 'Data 2024');
    await page.keyboard.press('Enter');
    assert.equal((await cell(page, 'A1', 'Summary')).f, "=SUM('Data 2024'!B2:B4)");
  } finally { await app.close(); }
});

test('import CSV and .xlsx (from the command line and the import path); export .xlsx and CSV', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(world.tmp, 'files-'));
  const csv = path.join(dir, 'posts.csv');
  fs.writeFileSync(csv, 'id,text,likes\n1789012345678901234,"Hello, world",5\n0042,=HYPERLINK("x"),-3\n');
  const E = await engine();
  const { writeXlsx } = await import(path.join(__dirname, '..', '..', 'src', 'shared', 'io', 'xlsx.js'));
  const { browserCodec } = await import(path.join(__dirname, '..', '..', 'src', 'shared', 'io', 'zip.js'));
  const wb = E.newWorkbook('Scores');
  E.ops.setInputs(wb, wb.activeSheet, [{ r: 0, c: 0, input: 'a' }, { r: 0, c: 1, input: '5' }, { r: 1, c: 1, input: '=B1*3' }]);
  const xlsx = path.join(dir, 'Scores.xlsx');
  fs.writeFileSync(xlsx, await writeXlsx(wb, { deflate: browserCodec.deflate }));
  // opened from the command line (as when double-clicking the file)
  const { app, page, library } = await ready({ args: [csv] });
  try {
    await page.waitForFunction(() => window.__sheetsApp.current && /posts/.test(window.__sheetsApp.current.name), null, { timeout: 30000 });
    assert.equal((await cell(page, 'A2')).v, '1789012345678901234', 'long IDs stay exact');
    assert.equal((await cell(page, 'A3')).v, '0042');
    assert.equal((await cell(page, 'B3')).v, '=HYPERLINK("x")');
    assert.equal((await cell(page, 'B3')).f, null, 'formulas in a CSV are not run');
    assert.ok(fs.existsSync(path.join(library, 'posts.mcsheet')), 'converted into the library');
    await page.waitForSelector('.banner.info >> text=Long ID numbers');
    // .xlsx through the app's import path
    const bytes = Array.from(fs.readFileSync(xlsx));
    await page.evaluate(b => window.__sheetsApp.importBytes(new Uint8Array(b), 'Scores.xlsx'), bytes);
    await page.waitForFunction(() => /Scores/.test(window.__sheetsApp.current.name));
    assert.deepEqual([(await cell(page, 'B2')).f, (await cell(page, 'B2')).v], ['=B1*3', 15]);
    // export: the save dialog is answered by the test
    const outX = path.join(dir, 'out.xlsx'), outC = path.join(dir, 'out.csv');
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, outX);
    await page.evaluate(() => window.__sheetsApp.exportXlsx(window.__sheetsApp.current));
    await page.waitForFunction(() => document.querySelector('.toast') && /Exported/.test(document.querySelector('.toast').textContent));
    const { readXlsx } = await import(path.join(__dirname, '..', '..', 'src', 'shared', 'io', 'xlsx.js'));
    const back = (await readXlsx(new Uint8Array(fs.readFileSync(outX)), { inflate: browserCodec.inflate })).workbook;
    assert.equal(back.valueAt(back.activeSheet, 1, 1), 15);
    await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, outC);
    await page.click('.doc-tab >> text=posts');
    await page.evaluate(() => window.__sheetsApp.exportDelimited(window.__sheetsApp.current, 'csv'));
    for (let i = 0; i < 50 && !fs.existsSync(outC); i++) await page.waitForTimeout(100);
    const text = fs.readFileSync(outC, 'utf8');
    assert.match(text, /^﻿id,text,likes\r\n/);
    assert.match(text, /0042,'=HYPERLINK\(""x""\)|0042,"'=HYPERLINK\(""x""\)"/, 'formula-like text is guarded: ' + JSON.stringify(text));
    if (process.env.MCSHEETS_SKIP_OPENPYXL !== '1') {
      try {
        const out = execFileSync('python3', ['-I', '-c', 'import sys,openpyxl;ws=openpyxl.load_workbook(sys.argv[1]).active;print(ws["B2"].value)', outX], { encoding: 'utf8' }).trim();
        assert.equal(out, '=B1*3', 'openpyxl reads the exported file');
      } catch (e) { if (!/No module named|ENOENT/.test(String(e.message))) throw e; }
    }
  } finally { await app.close(); }
});

test('a crash keeps unsaved work: it is offered back at the next start', { timeout: 120000 }, async () => {
  const first = await ready({ autosave: false });
  const { userData } = first;
  try {
    await newWorkbook(first.page);
    await typeRows(first.page, [['unsaved', 123]]);
    await first.page.waitForTimeout(6500);                      // recovery copies every 5 s
  } finally {
    first.app.process().kill('SIGKILL');                         // no clean exit
    await new Promise(r => setTimeout(r, 500));
  }
  const { app, page } = await ready({ userData });
  try {
    await page.waitForSelector('.recovery >> text=closed unexpectedly');
    await page.click('.recovery button:has-text("Restore")');
    await page.waitForSelector('#workbook:not([hidden])');
    assert.equal((await cell(page, 'B1')).v, 123);
    assert.equal(await page.evaluate(() => window.__sheetsApp.current.dirty), true, 'restored as unsaved changes');
  } finally { await app.close(); }
});

test('files changed or deleted by another program: no silent overwrite', { timeout: 120000 }, async () => {
  const { app, page } = await ready();
  try {
    await newWorkbook(page);
    await typeRows(page, [['mine', 1]]);
    await page.waitForFunction(() => window.__sheetsApp.current.saveState === 'saved' && !window.__sheetsApp.current.dirty, null, { timeout: 10000 });
    const file = await page.evaluate(() => window.__sheetsApp.current.path);
    // another program rewrites the file
    await new Promise(r => setTimeout(r, 30));
    const theirs = fs.readFileSync(file, 'utf8').replace('"mine"', '"theirs"');
    fs.writeFileSync(file, theirs + ' ');
    await goTo(page, 'B1');
    await typeRows(page, [[2]]);
    await page.waitForSelector('.banner >> text=changed by another program', { timeout: 10000 });
    assert.match(fs.readFileSync(file, 'utf8'), /"theirs"/, 'their version is still there');
    await page.click('.banner button:has-text("Keep mine")');
    await page.click('.dialog button:has-text("Replace")');
    await page.waitForFunction(() => window.__sheetsApp.current.saveState === 'saved');
    assert.match(fs.readFileSync(file, 'utf8'), /"mine"/);
    // deleted elsewhere
    fs.unlinkSync(file);
    await goTo(page, 'C1');
    await typeRows(page, [[3]]);
    await page.waitForSelector('.banner >> text=moved or deleted', { timeout: 10000 });
    await page.click('.banner button:has-text("Save it again where it was")');
    await page.waitForFunction(f => window.__sheetsApp.current.saveState === 'saved', file);
    assert.ok(fs.existsSync(file));
  } finally { await app.close(); }
});

test('a 100,000-row workbook opens and scrolls (timed)', { timeout: 120000 }, async () => {
  const E = await engine();
  const wb = E.newWorkbook('Big');
  const s = wb.activeSheet;
  for (let r = 0; r < 100000; r++) {
    s.cells.set(E.keyOf(r, 0), { v: r + 1 });
    s.cells.set(E.keyOf(r, 1), { v: 'post ' + r });
    s.cells.set(E.keyOf(r, 2), { v: (r * 7) % 100 });
    s.cells.set(E.keyOf(r, 3), { v: r % 3 === 0 });
    s.cells.set(E.keyOf(r, 4), { v: null, f: '=A' + (r + 1) + '*C' + (r + 1) });
  }
  s._bounds = null;
  wb.calc.rebuild(); wb.calc.recalcAll();
  const l0 = await ready();
  const lib = l0.library;
  await l0.app.close();
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'Big.mcsheet'), E.serialize(wb));
  const { app, page } = await ready({ userData: path.dirname(lib) });
  try {
    await page.waitForSelector('.file-row >> text=Big');
    const t0 = Date.now();
    await page.click('.file-row >> text=Big');
    await page.waitForFunction(() => window.__sheetsApp.current && window.__sheetsApp.current.name === 'Big');
    const openMs = Date.now() - t0;
    // scroll through the sheet: time per frame drawn
    const frames = await page.evaluate(async () => {
      const g = window.__sheetsApp.ws.grid;
      const times = [];
      for (let i = 0; i < 30; i++) {
        g.scroller.scrollTop += 24 * 400;
        const t = performance.now();
        g.draw();
        times.push(performance.now() - t);
        await new Promise(r => requestAnimationFrame(r));
      }
      times.sort((a, b) => a - b);
      return { median: times[15], max: times[29] };
    });
    // an edit that recalculates one dependent
    await goTo(page, 'C50000');
    const t1 = Date.now();
    await typeRows(page, [[1000]]);
    const editMs = Date.now() - t1;
    assert.equal((await cell(page, 'E50000')).v, 50000 * 1000);
    console.log('    100k rows × 5 columns: open ' + openMs + ' ms; draw a screen: median ' + frames.median.toFixed(1) + ' ms, max ' + frames.max.toFixed(1) + ' ms; type and recalculate: ' + editMs + ' ms');
    assert.ok(openMs < 30000 && frames.median < 100);
  } finally { await app.close(); }
});
