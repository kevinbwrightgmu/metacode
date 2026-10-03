// End-to-end tests for Survey Studio in a real browser (Playwright + Chromium)
// against the full MetaCode server, with survey data in a temporary folder.
//
//   1. The complete authoring → publishing → response flow, step by step:
//      open site → Survey Studio → create → add question → add choice → select
//      one answer → width/height/scale/rotation/colour/typography → move →
//      duplicate → reorder → second question → logic → preview → test logic →
//      save → reload → intact → publish → respondent page → submit → stored.
//   2. Canvas editing: draw, resize and rotate with handles, undo/redo,
//      copy/paste, marquee, group, layers, inline text, theme, pages, mobile.
//   3. The rest of MetaCode keeps working around the new view.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../public/js/survey/survey-core.js');
const { testEnv } = require('./helpers/harness');

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
      .forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome')));
  } catch (e) { /* no browser cache */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* not installed */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

const chromiumPath = findChromium();
const skip = !chromiumPath && 'no Chromium found (set CHROMIUM_PATH)';

let server, baseUrl, browser, dataDir;

test.before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-survey-e2e-'));
  Object.assign(process.env, testEnv({ SURVEY_DATA_DIR: dataDir, EMIS_API_KEY: '' }));
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function openApp(hash, viewport) {
  const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // No internet in CI: CDN assets (fonts, Chart.js…) fail fast.
  await page.route(/^https?:\/\/(?!localhost)/, route => route.abort());
  await page.goto(baseUrl + '/app.html' + (hash || ''));
  return { page, context, errors };
}

// Helpers that read the editor's live state
const studio = {
  doc: page => page.evaluate(() => SurveyStudio.current().store.doc),
  primary: page => page.evaluate(() => SurveyStudio.current().store.primary),
  selection: page => page.evaluate(() => SurveyStudio.current().store.selection),
  select: (page, ids) => page.evaluate(ids => SurveyStudio.current().store.select(ids), ids),
  frame: (page, id) => page.evaluate(id => SurveyStudio.current().store.doc.elements[id].frame, id)
};
const optionsOf = (doc, q) => Core.questionParts(doc, q, 'option');

// Set a numeric/text property in the inspector by its label.
async function setField(page, label, value) {
  const row = page.locator('.ss-right .ss-field').filter({ has: page.locator('.ss-field-label', { hasText: new RegExp('^' + label + '$') }) }).first();
  const input = row.locator('input.ss-input, input.ss-num').first();
  await input.fill(String(value));
  await input.press('Enter');
  await input.blur();
}

test('Survey Studio: create → style one answer → logic → preview → save/reload → publish → respond → stored', { skip, timeout: 180000 }, async () => {
  const { page, context, errors } = await openApp('');

  // 1–2. Open the site and enter the platform from the sidebar
  const nav = page.locator('.nav-item[data-view="surveys"]');
  await nav.waitFor();
  assert.equal((await nav.textContent()).trim(), 'Survey Studio');
  await nav.click();
  await page.waitForSelector('#ss-new');
  assert.equal(new URL(page.url()).hash, '#surveys');
  assert.equal(await page.textContent('#topbar-title'), 'Survey Studio');

  // 3. Create a survey
  await page.click('#ss-new');
  await page.waitForSelector('.ss-viewport .sv-artboard');
  assert.match(new URL(page.url()).hash, /^#surveys\/sv_/);

  // 4. Add a question
  await page.click('.ss-pal-item[data-type="single"]');
  const qid = await studio.primary(page);
  assert.equal((await studio.doc(page)).elements[qid].type, 'single');

  // 5. Add an answer choice
  const n0 = optionsOf(await studio.doc(page), qid).length;
  await page.click('.ss-chip-btn[data-act="add-option"]');
  assert.equal(optionsOf(await studio.doc(page), qid).length, n0 + 1);

  // 6. Select one individual answer: click selects the question, double-click drills in
  await studio.select(page, []);
  const optId = optionsOf(await studio.doc(page), qid)[1].id;
  const ob = await page.locator(`.ss-viewport [data-svid="${optId}"]`).boundingBox();
  await page.mouse.click(ob.x + ob.width - 30, ob.y + ob.height / 2);
  assert.deepEqual(await studio.selection(page), [qid]);
  await page.mouse.dblclick(ob.x + ob.width - 30, ob.y + ob.height / 2);
  assert.deepEqual(await studio.selection(page), [optId]);

  // 7–10. Width, height, scale and rotation of that one answer
  await setField(page, 'Width', 300);
  await setField(page, 'Height', 56);
  await setField(page, 'Scale X', 1.2);
  await setField(page, 'Scale Y', 1.1);
  await setField(page, 'Rotation', 8);
  let f = await studio.frame(page, optId);
  assert.deepEqual([f.w, f.h, f.sx, f.sy, f.rot], [300, 56, 1.2, 1.1, 8]);
  assert.match(await page.locator(`.ss-viewport [data-svid="${optId}"]`).evaluate(n => getComputedStyle(n).transform), /matrix/);

  // 11. Colour
  const fill = page.locator('.ss-right .ss-field-color').filter({ has: page.locator('.ss-field-label', { hasText: /^Fill$/ }) }).first();
  await fill.locator('.ss-color-text').fill('#FDE68A');
  await fill.locator('.ss-color-text').press('Enter');
  assert.equal((await studio.doc(page)).elements[optId].style.fill, '#FDE68A');
  assert.equal(await page.locator(`.ss-viewport [data-svid="${optId}"]`).evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(253, 230, 138)');

  // 12. Typography
  await setField(page, 'Size', 19);
  await page.locator('.ss-right .ss-field').filter({ has: page.locator('.ss-field-label', { hasText: /^Weight$/ }) }).first().locator('select').selectOption('700');
  const style = (await studio.doc(page)).elements[optId].style;
  assert.equal(style.fontSize, 19);
  assert.equal(style.fontWeight, '700');

  // 13. Move it by dragging on the canvas: in the stacked choice list a drag
  // past the next answer moves it there
  const siblings = async () => { const d = await studio.doc(page); return d.elements[d.elements[optId].parent].children.slice(); };
  const order = await siblings();
  const next = order[order.indexOf(optId) + 1];
  const mb = await page.locator(`.ss-viewport [data-svid="${optId}"]`).boundingBox();
  const nb = await page.locator(`.ss-viewport [data-svid="${next}"]`).boundingBox();
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width / 2 + 10, nb.y + nb.height * 0.85, { steps: 10 });
  await page.mouse.up();
  const moved = await siblings();
  assert.ok(moved.indexOf(optId) > order.indexOf(optId), 'the answer moved down: ' + JSON.stringify([order, moved, optId]));
  assert.deepEqual(await studio.selection(page), [optId]);

  // 14. Duplicate (Ctrl+D) — the copy gets its own stored value
  await page.locator('.ss-viewport').focus();
  await page.keyboard.press('Control+d');
  let doc = await studio.doc(page);
  const opts = optionsOf(doc, qid);
  assert.equal(opts.length, n0 + 2);
  assert.equal(new Set(opts.map(o => o.props.value)).size, opts.length);

  // 15. Reorder (send backward)
  const parentOf = d => d.elements[d.elements[optId].parent].children.slice();
  const order0 = parentOf(doc);
  await studio.select(page, [optId]);
  await page.locator('.ss-viewport').focus();
  await page.keyboard.press('Control+BracketLeft');
  assert.notDeepEqual(parentOf(await studio.doc(page)), order0);

  // 16. Another question
  await studio.select(page, []);
  await page.click('.ss-pal-item[data-type="shorttext"]');
  const q2 = await studio.primary(page);
  assert.equal((await studio.doc(page)).elements[q2].type, 'shorttext');

  // 17. Logic: "show the follow-up when an answer is chosen" preset
  await page.click('.ss-mode[data-mode="logic"]');
  await page.waitForSelector('.ss-logic');
  await page.click('[data-preset="show"]');
  await page.waitForSelector('.ss-rule');
  doc = await studio.doc(page);
  const rule = doc.rules[0];
  assert.equal(rule.when.items[0].left.ref, qid);
  assert.deepEqual(rule.then, [{ type: 'show', target: q2 }]);
  const trigger = optionsOf(doc, qid).find(o => String(o.props.value) === String(rule.when.items[0].right.value));
  assert.ok(trigger, 'the condition compares against a real option value');

  // 18–19. Preview and test the logic
  await page.click('.ss-mode[data-mode="preview"]');
  await page.waitForSelector('#ss-pv-host .sv-artboard');
  assert.equal(await page.locator(`#ss-pv-host [data-svid="${q2}"]`).isVisible(), false);
  await page.locator(`#ss-pv-host [data-svid="${trigger.id}"]`).click({ force: true });
  await page.waitForFunction(id => { const n = document.querySelector('#ss-pv-host [data-svid="' + id + '"]'); return n && n.offsetParent !== null; }, q2);
  // Reset clears answers and hides it again
  await page.click('#ss-pv-reset');
  await page.waitForFunction(id => { const n = document.querySelector('#ss-pv-host [data-svid="' + id + '"]'); return n && n.offsetParent === null; }, q2);

  // 20. Save
  await page.click('.ss-mode[data-mode="design"]');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => SurveyStudio.current().store.saveState.status === 'saved', null, { timeout: 10000 });
  doc = await studio.doc(page);
  const snapshot = JSON.stringify({ opt: doc.elements[optId], q: doc.elements[qid], q2: doc.elements[q2], rules: doc.rules });

  // 21–22. Reload and confirm everything is intact
  await page.reload();
  await page.waitForSelector('.ss-viewport .sv-artboard');
  doc = await studio.doc(page);
  assert.equal(JSON.stringify({ opt: doc.elements[optId], q: doc.elements[qid], q2: doc.elements[q2], rules: doc.rules }), snapshot);
  assert.equal(await page.locator(`.ss-viewport [data-svid="${optId}"]`).evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(253, 230, 138)');

  // 23. Publish
  await page.click('#ss-publish');
  await page.waitForSelector('#ss-pub-go');
  await page.click('#ss-pub-go');
  await page.waitForSelector('#ss-pub-url', { timeout: 10000 });
  const url = await page.inputValue('#ss-pub-url');
  assert.match(url, /\/s\/[A-Za-z0-9]+$/);

  // 24. Open the respondent version (a separate visitor)
  const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const rp = await visitor.newPage();
  const visitorErrors = [];
  rp.on('pageerror', e => visitorErrors.push(e.message));
  await rp.route(/^https?:\/\/(?!localhost)/, route => route.abort());
  await rp.goto(url);
  await rp.waitForSelector(`.sv-artboard [data-svid="${qid}"]`);
  assert.equal(await rp.locator('.ss-app, .ss-inspector').count(), 0, 'no editor UI on the respondent page');
  assert.equal(await rp.locator(`[data-svid="${q2}"]`).isVisible(), false);

  // 25. Answer and submit
  await rp.locator(`[data-svid="${trigger.id}"]`).click({ force: true });
  await rp.locator(`[data-svid="${q2}"] input`).fill('Because it works');
  await rp.locator('.sv-button', { hasText: 'Submit' }).click();
  await rp.waitForSelector('.sv-complete', { timeout: 10000 });

  // 26. The response is stored, with the published version
  const id = doc.id;
  const stored = await page.evaluate(id => fetch('/api/surveys/' + id + '/responses').then(r => r.json()), id);
  assert.equal(stored.responses.length, 1);
  const r = stored.responses[0];
  assert.equal(r.status, 'complete');
  assert.equal(r.version, 1);
  assert.deepEqual(r.answers, { [qid]: trigger.props.value, [q2]: 'Because it works' });

  // …and shows up in the Responses view
  await page.keyboard.press('Escape');
  await page.waitForSelector('#modal-backdrop.is-open', { state: 'detached' }).catch(() => page.waitForSelector('#modal-backdrop:not(.is-open)'));
  await page.click('.ss-mode[data-mode="responses"]');
  await page.waitForSelector('.ss-responses .stat-card');
  assert.match(await page.textContent('.ss-responses'), /Because it works/);

  assert.deepEqual(errors, []);
  assert.deepEqual(visitorErrors, []);
  await visitor.close();
  await context.close();
});

test('Survey Studio canvas: draw, handles, undo/redo, clipboard, marquee, groups, layers, text, theme, pages, mobile', { skip, timeout: 180000 }, async () => {
  const { page, context, errors } = await openApp('#surveys');
  await page.waitForSelector('#ss-new');
  await page.click('#ss-new');
  await page.waitForSelector('.ss-viewport .sv-artboard');

  // Draw a rectangle with the R tool
  await page.keyboard.press('r');
  const ab = await page.locator('.ss-viewport .sv-artboard').boundingBox();
  await page.mouse.move(ab.x + 60, ab.y + 220);
  await page.mouse.down();
  await page.mouse.move(ab.x + 200, ab.y + 320, { steps: 5 });
  await page.mouse.up();
  const shape = await studio.primary(page);
  let f = await studio.frame(page, shape);
  assert.ok(f.w > 80 && f.h > 50, JSON.stringify(f));

  // Resize from the south-east handle: the top-left stays put
  const f0 = f;
  const se = await page.locator('.ss-handle.ss-h-se').boundingBox();
  await page.mouse.move(se.x + 4, se.y + 4);
  await page.mouse.down();
  await page.mouse.move(se.x + 44, se.y + 24, { steps: 5 });
  await page.mouse.up();
  f = await studio.frame(page, shape);
  assert.ok(f.w > f0.w + 30 && f.h > f0.h + 10);
  assert.deepEqual([f.x, f.y], [f0.x, f0.y]);

  // Rotate with the rotation handle
  const rot = await page.locator('.ss-rot').boundingBox();
  const sb = await page.locator(`.ss-viewport [data-svid="${shape}"]`).boundingBox();
  await page.mouse.move(rot.x + 6, rot.y + 6);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width + 60, sb.y + sb.height / 2, { steps: 6 });
  await page.mouse.up();
  const rotated = (await studio.frame(page, shape)).rot;
  assert.ok(Math.abs(rotated) >= 30, 'rot=' + rotated);

  // Resizing the rotated shape from one corner keeps the opposite corner fixed
  const nw = await page.locator('.ss-handle.ss-h-nw').boundingBox();
  const seBefore = await page.locator('.ss-handle.ss-h-se').boundingBox();
  await page.mouse.move(nw.x + 4, nw.y + 4);
  await page.mouse.down();
  await page.mouse.move(nw.x - 30, nw.y - 10, { steps: 5 });
  await page.mouse.up();
  const seAfter = await page.locator('.ss-handle.ss-h-se').boundingBox();
  assert.ok(Math.abs(seAfter.x - seBefore.x) <= 2 && Math.abs(seAfter.y - seBefore.y) <= 2);

  // Undo twice (resize, rotate) → unrotated; redo → rotated again
  await page.locator('.ss-viewport').focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  assert.ok(Math.abs((await studio.frame(page, shape)).rot) < 0.01);
  await page.keyboard.press('Control+Shift+z');
  assert.equal((await studio.frame(page, shape)).rot, rotated);

  // Copy and paste
  await studio.select(page, [shape]);
  await page.locator('.ss-viewport').focus();
  await page.keyboard.press('Control+c');
  const count = () => page.evaluate(() => SurveyStudio.current().store.page.children.length);
  const c0 = await count();
  await page.evaluate(() => {
    const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true });
    ev.clipboardData.setData('text/plain', localStorage.getItem('metacode_survey_clipboard_v1'));
    document.querySelector('.ss-viewport').dispatchEvent(ev);
  });
  assert.equal(await count(), c0 + 1);

  // Marquee selects several elements
  const vp = await page.locator('.ss-viewport').boundingBox();
  await page.mouse.move(vp.x + 5, vp.y + 5);
  await page.mouse.down();
  await page.mouse.move(vp.x + vp.width - 5, vp.y + vp.height - 5, { steps: 6 });
  await page.mouse.up();
  assert.ok((await studio.selection(page)).length >= 4);

  // Group and ungroup the two shapes, then align them
  const shapes = await page.evaluate(() => { const s = SurveyStudio.current().store; return s.page.children.filter(id => s.doc.elements[id].type === 'shape'); });
  await studio.select(page, shapes);
  await page.locator('.ss-viewport').focus();
  await page.keyboard.press('Control+g');
  const group = await page.evaluate(() => SurveyStudio.current().store.doc.elements[SurveyStudio.current().store.primary]);
  assert.equal(group.type, 'group');
  assert.equal(group.children.length, 2);
  await page.keyboard.press('Control+Shift+g');
  assert.deepEqual((await studio.selection(page)).sort(), shapes.slice().sort());
  await page.click('.ss-toolbar [data-act="align-left"]');
  const xs = await page.evaluate(ids => ids.map(id => SurveyStudio.current().store.doc.elements[id].frame.x), shapes);
  assert.equal(xs[0], xs[1]);

  // Layers panel: lock and unlock from the tree
  await page.click('.ss-left-tabs [data-left="layers"]');
  const row = page.locator('.ss-tree .ss-row').first();
  const rowId = await row.getAttribute('data-id');
  await row.click();
  await row.hover();
  await row.locator('[data-toggle="locked"]').click();
  assert.equal((await studio.doc(page)).elements[rowId].locked, true);
  await page.locator(`.ss-tree .ss-row[data-id="${rowId}"] [data-toggle="locked"]`).click();
  assert.ok(!(await studio.doc(page)).elements[rowId].locked);

  // Inline text editing on the canvas
  const hid = await page.evaluate(() => Object.values(SurveyStudio.current().store.doc.elements).find(e => e.type === 'heading').id);
  const hb = await page.locator(`.ss-viewport [data-svid="${hid}"]`).boundingBox();
  await page.mouse.dblclick(hb.x + 20, hb.y + hb.height / 2);
  await page.keyboard.type('My new title');
  await page.keyboard.press('Enter');
  assert.equal((await studio.doc(page)).elements[hid].props.text, 'My new title');

  // Every question type can be added
  await page.click('.ss-left-tabs [data-left="add"]');
  for (const t of ['matrix', 'ranking', 'rating', 'likert', 'slider', 'dropdown', 'tabs', 'image', 'section']) {
    await studio.select(page, []);
    await page.click(`.ss-pal-item[data-type="${t}"]`);
    assert.equal((await studio.doc(page)).elements[await studio.primary(page)].type, t);
  }

  // Theme token changes the whole survey
  await page.click('.ss-mode[data-mode="theme"]');
  await page.fill('[data-token-in="primary"]', '#0D9488');
  await page.press('[data-token-in="primary"]', 'Enter');
  assert.equal((await studio.doc(page)).theme.tokens.primary, '#0D9488');

  // Pages
  await page.click('.ss-mode[data-mode="design"]');
  await page.click('.ss-pagebar [data-act="add-page"]');
  assert.equal((await studio.doc(page)).pages.length, 2);

  // Mobile preview reflows into one column without overlaps
  await page.click('.ss-mode[data-mode="preview"]');
  await page.click('[data-device="mobile"]');
  await page.waitForSelector('#ss-pv-host .sv-reflow .sv-artboard');
  const overlaps = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#ss-pv-host .sv-artboard > .sv-el')].filter(n => n.offsetParent !== null)
      .map(n => n.getBoundingClientRect()).filter(r => r.height > 0);
    let bad = 0;
    for (let i = 1; i < els.length; i++) if (els[i].top < els[i - 1].bottom - 1) bad++;
    return bad;
  });
  assert.equal(overlaps, 0);

  // Back to the list
  await page.click('.ss-mode[data-mode="design"]');
  await page.click('.ss-back');
  await page.waitForSelector('.ss-table');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the rest of MetaCode keeps working around Survey Studio', { skip, timeout: 60000 }, async () => {
  const { page, context, errors } = await openApp('#surveys');
  await page.waitForSelector('#ss-new');
  for (const view of ['dashboard', 'scraper', 'settings']) {
    await page.click(`.nav-item[data-view="${view}"]`);
    await page.waitForFunction(v => location.hash === '#' + v, view);
    assert.equal(await page.locator('.ss-app').count(), 0, 'the editor is torn down when leaving');
    assert.ok(await page.locator(`.nav-item[data-view="${view}"]`).evaluate(n => n.classList.contains('active')));
  }
  await page.click('.nav-item[data-view="surveys"]');
  await page.waitForSelector('#ss-new');
  assert.deepEqual(errors.filter(e => !/is not defined/.test(e)), []);
  await context.close();
});
