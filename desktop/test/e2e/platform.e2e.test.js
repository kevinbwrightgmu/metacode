// End to end: the MetaCode features in the app, through the real server
// (the AI service is a stand-in that gives fixed answers):
//   AI Assistant — formula suggestion (preview, then insert), clean-up of a
//   column (preview of every change, then one undoable step);
//   AI Coding — a codebook, a confirmation, coded rows written on request;
//   Reliability — computed locally, inserted as live formulas;
//   MetaCode projects — open one from the account, save a sheet as a new one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startWorld, launchApp, signIn, waitForStatus, newWorkbook, typeRows, cell, goTo, mod } = require('./fixtures');

let world;
test.before(async () => { world = await startWorld(); });
test.after(async () => { if (world) await world.close(); });

async function ready(who = 'ultra') {
  const l = await launchApp(world);
  await signIn(l.page, world.users[who]);
  await waitForStatus(l.page, 'active');
  await l.page.waitForSelector('#shell:not([hidden])');
  return l;
}

test('AI Assistant: a suggested formula is previewed, then inserted only when asked', { timeout: 120000 }, async () => {
  const { app, page } = await ready();
  try {
    await newWorkbook(page);
    await typeRows(page, [['Name', 'Score'], ['Ada', 91], ['Grace', 84], ['Alan', 77]]);
    await goTo(page, 'B5');
    await page.keyboard.press(mod + '+Shift+a');
    await page.waitForSelector('.sidebar:not([hidden]) .side-body >> text=AI Assistant');
    await page.fill('.side-body textarea', 'the total score');
    await page.click('.side-body button:has-text("Suggest a formula")');
    await page.waitForSelector('.ai-output >> text=Suggested by AI');
    assert.match(await page.textContent('.ai-output'), /=SUM\(B2:B4\)/);
    assert.match(await page.textContent('.ai-output'), /Result if inserted: 252/);
    assert.equal((await cell(page, 'B5')).v, null, 'nothing written yet');
    await page.click('.side-body button:has-text("Insert into B5")');
    assert.deepEqual([(await cell(page, 'B5')).f, (await cell(page, 'B5')).v], ['=SUM(B2:B4)', 252]);
    const sent = world.ai.calls[world.ai.calls.length - 1];
    assert.match(sent.messages[1].content, /Ada,91/, 'the sheet\'s data went with the request');
  } finally { await app.close(); }
});

test('AI clean-up: every change is previewed; applying is one undoable step', { timeout: 120000 }, async () => {
  const { app, page } = await ready();
  try {
    await newWorkbook(page);
    await typeRows(page, [['germany'], ['france'], ['Japan']]);
    await goTo(page, 'A1:A3');
    await page.keyboard.press(mod + '+Shift+a');
    await page.selectOption('.side-body select', 'transform');
    await page.fill('.side-body textarea', 'upper case');
    await page.click('.side-body button:has-text("Preview changes")');
    await page.click('.dialog button:has-text("Send")');
    await page.waitForSelector('.side-body .preview-table');
    assert.match(await page.textContent('.side-body'), /3 AI-suggested changes/);
    assert.equal((await cell(page, 'A1')).v, 'germany', 'preview only');
    await page.click('.side-body button:has-text("Apply 3 changes")');
    assert.deepEqual(await Promise.all(['A1', 'A2', 'A3'].map(async a => (await cell(page, a)).v)), ['GERMANY', 'FRANCE', 'JAPAN']);
    await page.focus('.grid .scroller');
    await page.keyboard.press(mod + '+z');
    assert.deepEqual(await Promise.all(['A1', 'A2', 'A3'].map(async a => (await cell(page, a)).v)), ['germany', 'france', 'Japan'], 'one undo reverts them all');
  } finally { await app.close(); }
});

test('AI Coding: codes a text column with a codebook, after confirmation; results written on request', { timeout: 120000 }, async () => {
  const { app, page } = await ready();
  try {
    await newWorkbook(page);
    await typeRows(page, [['id', 'text'], [1, 'I love this'], [2, 'This is awful'], [3, 'Great work']]);
    await goTo(page, 'B2');
    await page.evaluate(() => window.__sheetsApp.ws.sidebar.open('coding'));
    await page.fill('.side-body textarea', '# Sentiment\npos = Positive\nneg = Negative');
    await page.selectOption('.side-body select', '1');
    await page.click('.side-body button:has-text("Code rows with AI")');
    await page.waitForSelector('.dialog >> text=Code 3 rows');
    await page.click('.dialog button:has-text("Start coding")');
    await page.waitForSelector('.side-body button:has-text("Write 3 rows to the sheet")', { timeout: 30000 });
    assert.equal((await cell(page, 'C2')).v, null, 'nothing written before you ask');
    await page.click('.side-body button:has-text("Write 3 rows to the sheet")');
    assert.equal((await cell(page, 'C1')).v, 'Sentiment (AI)');
    assert.deepEqual(await Promise.all(['C2', 'C3', 'C4'].map(async a => (await cell(page, a)).v)), ['pos', 'neg', 'pos']);
    assert.equal((await cell(page, 'D2')).v, 0.9);
  } finally { await app.close(); }
});

test('Reliability: computed on the computer and inserted as live formulas', { timeout: 120000 }, async () => {
  const { app, page } = await ready('pro');
  try {
    await newWorkbook(page);
    await typeRows(page, [['Coder 1', 'Coder 2'], ['a', 'a'], ['b', 'b'], ['a', 'b'], ['c', 'c'], ['b', 'b']]);
    await goTo(page, 'A2');
    await page.evaluate(() => window.__sheetsApp.ws.sidebar.open('reliability'));
    await page.click('.side-body button:has-text("Calculate")');
    await page.waitForSelector('.side-body .kv');
    assert.match(await page.textContent('.side-body .kv'), /80\.0%/);
    await page.click('.side-body button:has-text("Insert as formulas")');
    const out = await page.evaluate(() => {
      const wb = window.__sheetsApp.current.wb; const s = wb.activeSheet;
      const found = [];
      for (const c of s.cells.values()) if (c.f && /PERCENTAGREEMENT|COHENKAPPA/.test(c.f)) found.push([c.f, c.v]);
      return found;
    });
    assert.equal(out.length, 2);
    assert.equal(out.find(x => /PERCENTAGREEMENT/.test(x[0]))[1], 0.8);
    const kappa = out.find(x => /COHENKAPPA/.test(x[0]))[1];
    assert.ok(kappa > 0.6 && kappa < 0.8, 'κ = ' + kappa);
  } finally { await app.close(); }
});

test('MetaCode projects: open one from the account as a workbook; save a sheet as a new project', { timeout: 120000 }, async () => {
  const user = world.users.max;
  world.sb.rows.push({ user_id: user.id, kind: 'projects', id: 'pr_seeded0000001', deleted: false, updated_at: new Date().toISOString(),
    data: { id: 'pr_seeded0000001', name: 'Climate posts', description: 'Seeded', createdAt: '2026-01-01T00:00:00Z', savedAt: '2026-01-01T00:00:00Z', revision: 1,
      data: { project: { name: 'Climate posts', description: '' },
        codebook: [{ id: 'stance', name: 'Stance', codes: [{ id: 'for', label: 'For' }, { id: 'against', label: 'Against' }] }],
        posts: [{ id: 'p1', text: 'We need action now', author: 'ann', timestamp: '2026-01-02', engagement: { likes: 5 }, humanCodes: { stance: 'for' }, coder2Codes: { stance: 'for' }, aiCodes: { stance: { code: 'for', confidence: 0.8, reasoning: 'Supports action.' } }, adjudicated: {} },
          { id: 'p2', text: 'It is all exaggerated', author: 'bob', engagement: { likes: 2 }, humanCodes: { stance: 'against' }, coder2Codes: { stance: 'for' }, aiCodes: {}, adjudicated: {} }],
        network: { nodes: [], edges: [] }, networkAnalysis: null } } });
  const { app, page } = await ready('max');
  try {
    await page.click('.start >> text=MetaCode project');
    await page.waitForSelector('.dialog .list .item >> text=Climate posts');
    await page.click('.dialog .list .item >> text=Climate posts');
    await page.click('.dialog button:has-text("Open")');
    await page.waitForFunction(() => window.__sheetsApp.current && /Climate posts/.test(window.__sheetsApp.current.name));
    assert.equal((await cell(page, 'B2', 'Posts')).v, 'We need action now');
    assert.equal((await cell(page, 'J1', 'Posts')).v, 'Stance · Coder 1');
    assert.equal((await cell(page, 'L2', 'Posts')).v, 'for', 'AI code');
    assert.equal((await cell(page, 'D2', 'Codebook')).v, 'for');
    // save it back as a new project (the original isn't changed)
    await page.evaluate(() => window.__sheetsApp.ws.sidebar.open('metacode'));
    await page.fill('.side-body input[aria-label="Project name"]', 'Climate posts (from Sheets)');
    await page.click('.side-body button:has-text("Save to my MetaCode account")');
    await page.click('.dialog button:has-text("Save project")');
    await page.waitForSelector('.toast >> text=Saved "Climate posts (from Sheets)"');
    const rows = world.sb.rows.filter(r => r.user_id === user.id && r.kind === 'projects');
    assert.equal(rows.length, 2);
    const made = rows.find(r => r.id !== 'pr_seeded0000001');
    assert.match(made.id, /^pr_[A-Za-z0-9]{12}$/);
    assert.equal(made.data.name, 'Climate posts (from Sheets)');
    assert.equal(made.data.data.posts.length, 2);
    assert.equal(made.data.data.posts[0].text, 'We need action now');
    assert.equal(made.data.data.codebook[0].id, 'stance', 'the codebook went along');
  } finally { await app.close(); }
});

test('offline, AI and MetaCode data say they need a connection (nothing is faked)', { timeout: 120000 }, async () => {
  const first = await ready('pro');
  const { userData } = first;
  await first.app.close();
  await world.serverDown();
  try {
    const { app, page } = await launchApp(world, { userData });
    try {
      await waitForStatus(page, 'offline');
      await newWorkbook(page);
      await page.keyboard.press(mod + '+Shift+a');
      await page.waitForSelector('.side-body .notice >> text=working offline');
      assert.equal(await page.isDisabled('.side-body button:has-text("Suggest a formula")'), true);
      assert.match(await page.textContent('.statusbar'), /Offline/);
    } finally { await app.close(); }
  } finally { await world.serverUp(); }
});
