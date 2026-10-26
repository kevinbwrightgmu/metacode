// "Send to Codebook" in a real browser (Playwright + Chromium), on the app
// side (public/js/lab-handoff.js, coding-rule.js, codebook.js): the app opens
// /app.html#codebook/lab/<submissionId> (or hears the Lab tab on
// BroadcastChannel('metacode-lab')), loads the submission, asks the user to
// confirm, writes the rule on the dimension through App.setState, reports the
// result to the server and to the Lab tab. The two /api/lab/codebook-submissions
// routes are mocked with page.route (this tests the app, not the Lab API).
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testEnv } = require('./helpers/harness');

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
const chromiumPath = findChromium();
const skip = !chromiumPath && 'no Chromium found (set CHROMIUM_PATH)';
let server, baseUrl, browser, tmp;

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-lab-handoff-e2e-'));
  Object.assign(process.env, testEnv({
    EMIS_API_KEY: '', ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'),
    PROJECT_DATA_DIR: path.join(tmp, 'projects'), AI_LAB_DATA_DIR: path.join(tmp, 'lab'), COLLAB_DATA_DIR: path.join(tmp, 'collab')
  }));
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const sid = s => 'cbs_' + String(s).padEnd(16, '0').slice(0, 16);
const EXP = 'exp_AbCdEfGhIjKlMnOp';
// HTML in the code must show as text, never become elements
const CODE = '// </pre><img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>\n' +
  'function classify(record, variable) {\n  return /love|great/i.test(record.text) ? { code: "pos", confidence: 0.8 } : "neg";\n}\n';

function payload(id, over) {
  return Object.assign({
    schema: 'metacode.coding-rule/1', submissionId: id, status: 'experimental', dimensionId: 'sentiment',
    experiment: { id: EXP, name: 'Sentiment rule' }, version: 3, codeHash: 'c'.repeat(64), language: 'javascript', code: CODE,
    contract: { name: 'classify/1', input: { record: 'id, text, author, timestamp, meta' }, output: { code: 'a code id or null' } },
    prompts: { original: 'Write a keyword rule', final: 'Handle sarcasm' }, rationale: 'Best held-out macro-F1 <b>so far</b>.',
    evaluation: { runId: 'xrn_0123456789abcdef', finishedAt: '2026-10-24T10:00:00.000Z', split: 'test', records: 412, accuracy: 0.814, macroF1: 0.79, kappa: 0.61, referenceN: 120, coverage: 0.971, errorRate: 0, baselineAgreement: 0.88, recommendation: 'retain' },
    security: { policy: 'passed', review: 'approved', reviewedAt: '2026-10-24T09:59:00.000Z' },
    sandbox: { id: 'sbx_0123456789abcdef', name: 'Climate threads · Sentiment', version: 2, sha256: 'd'.repeat(64) },
    selectedAt: '2026-10-24T10:05:00.000Z', sentAt: '2026-10-24T10:06:00.000Z'
  }, over || {});
}
function submission(id, over) {
  const p = payload(id, over);
  return { id, idempotencyKey: EXP + ':' + p.version + ':' + p.codeHash, version: p.version, codeHash: p.codeHash, status: 'pending', createdAt: p.sentAt, resolvedAt: null, dimensionId: null, error: null, payload: p };
}
const STATE = {
  project: { name: 'Climate threads', description: '' },
  posts: [{ id: 'p1', text: 'I love solar', humanCodes: { sentiment: 'pos' }, aiCodes: {} }],
  codebook: [
    { id: 'sentiment', name: 'Sentiment', description: 'Valence', codes: [{ id: 'pos', label: 'Positive', description: '', aiNotes: '' }, { id: 'neg', label: 'Negative', description: '', aiNotes: '' }] },
    { id: 'stance', name: 'Stance', description: '', codes: [{ id: 'support', label: 'Support', description: '', aiNotes: '' }] }
  ],
  network: { nodes: [], edges: [] }, settings: {}
};

async function until(fn, what, ms) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > (ms || 8000)) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 25));
  }
}

// A browser context with the seeded project, a "Lab tab" listening on the channel, and the app page
async function setup(subs, state) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(s => {
    try {
      localStorage.setItem('metacode_tour_app', 'done');
      if (!localStorage.getItem('seeded')) { localStorage.setItem('strata_v1', s); localStorage.setItem('seeded', '1'); }
    } catch (e) { /* ignore */ }
  }, JSON.stringify(state || STATE));
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  // only this machine — no internet
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route => route.abort());
  // The Lab API (another module): GET a submission, POST its result
  const lab = { gets: [], results: [] };
  await page.route(/\/api\/lab\/codebook-submissions\//, async route => {
    const req = route.request();
    const m = /^\/api\/lab\/codebook-submissions\/([^/]+)(\/result)?$/.exec(new URL(req.url()).pathname);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!m) return json(404, { error: { type: 'not_found', message: 'Unknown AI Coding Lab endpoint.' } });
    const id = decodeURIComponent(m[1]);
    const s = subs[id];
    if (req.method() === 'GET' && !m[2]) {
      lab.gets.push(id);
      if (!s) return json(404, { error: { type: 'not_found', message: 'Not found.' } });
      if (s.httpStatus) return json(s.httpStatus, { error: s.error });
      const { responseExtra, ...sub } = s;   // responseExtra: more fields of the answer (e.g. the variable)
      return json(200, Object.assign({ submission: sub, experiment: { id: s.payload.experiment.id, name: s.payload.experiment.name } }, responseExtra || {}));
    }
    if (req.method() === 'POST' && m[2]) {
      const body = req.postDataJSON();
      const headers = await req.allHeaders();
      lab.results.push({ id, body, origin: headers.origin || null, contentType: headers['content-type'] || '' });
      if (s && s.status !== 'applied') Object.assign(s, { status: body.status, dimensionId: body.dimensionId || null, error: body.error || null, resolvedAt: new Date().toISOString() });
      return json(200, { submission: s || null });
    }
    return json(405, { error: { type: 'method', message: 'No.' } });
  });
  // The "Lab tab": another page of the same origin listening on the channel
  const listener = await context.newPage();
  await listener.goto(baseUrl + '/js/coding-rule.js');
  await listener.evaluate(() => { window.msgs = []; window.bc = new BroadcastChannel('metacode-lab'); window.bc.onmessage = e => window.msgs.push(e.data); });
  return { context, page, errors, lab, listener };
}
const resultOn = (listener, id) => listener.waitForFunction(id => window.msgs.find(m => m.type === 'coding-rule-result' && m.submissionId === id), id, { timeout: 8000 }).then(h => h.jsonValue());
const codebookOf = page => page.evaluate(() => App.getState().codebook);
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('strata_v1')).codebook);

test('send to Codebook from the link: confirm, saved on the dimension, server and Lab tab told; again = no-op; replace; view; remove', { skip, timeout: 90000 }, async () => {
  const one = sid('first'), two = sid('second');
  const subs = { [one]: submission(one), [two]: submission(two, { version: 4, codeHash: 'e'.repeat(64), code: 'function classify(r) { return null; }\n' }) };
  const { context, page, errors, lab, listener } = await setup(subs);

  // Every dimension links to the Lab
  await page.goto(baseUrl + '/app.html#codebook');
  await page.waitForSelector('.dim-card');
  assert.deepEqual(await page.$$eval('.cr-improve', as => as.map(a => [a.textContent.trim(), a.getAttribute('href')])),
    [['Improve in AI Coding Lab', '/ultra/ai-lab#experiments/new/sentiment'], ['Improve in AI Coding Lab', '/ultra/ai-lab#experiments/new/stance']]);

  await page.goto(baseUrl + '/app.html#codebook/lab/' + one);
  await page.waitForSelector('#lh-save');
  assert.equal(await page.textContent('#topbar-title'), 'Codebook');
  assert.equal(await page.textContent('#modal-title'), 'Save coding rule to the Codebook');
  const body = await page.textContent('#modal-body');
  assert.match(body, /coding rule for the variable Sentiment/);
  assert.equal(await page.textContent('#lh-version'), 'v3 of “Sentiment rule”');
  assert.equal(await page.textContent('#lh-language'), 'JavaScript');
  assert.match(await page.textContent('#lh-change'), /^New rule/);
  assert.match(body, /Policy checks passed · AI review approved/);
  assert.match(body, /412 held-out records/);
  const metrics = await page.$$eval('#modal-body .cr-metric', li => li.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(metrics.includes('81.4% Held-out accuracy n = 120'), metrics.join(' | '));
  assert.ok(metrics.includes('0.79 Held-out macro-F1 n = 120'));
  assert.ok(metrics.includes('97.1% Coverage n = 412'));
  assert.ok(metrics.includes('88% Agreement with AI coding'));
  // The code and the rationale are text: exactly what was sent, no elements made from them
  assert.equal(await page.textContent('#lh-code'), CODE);
  assert.equal(await page.$$eval('#lh-code *', els => els.length), 0);
  assert.equal(await page.textContent('#lh-rationale'), 'Best held-out macro-F1 <b>so far</b>.');
  assert.equal(await page.$$eval('#modal-body img, #modal-body script', els => els.length), 0);
  assert.equal(lab.results.length, 0, 'nothing reported before the user decides');
  assert.ok((await page.title()).startsWith('Confirm coding rule'), 'the tab title asks for attention');

  await page.click('#lh-save');
  await page.waitForSelector('.cr-panel');
  assert.equal(await page.isVisible('#modal-backdrop'), false);
  assert.equal(await page.textContent('#dim-sentiment .cr-head'), 'Coding rule · v3 · JavaScript · experimental — not used by AI Coding');
  assert.equal(await page.locator('#dim-stance .cr-panel').count(), 0);
  const panelMetrics = await page.$$eval('#dim-sentiment .cr-metric', li => li.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(panelMetrics, ['81.4% Held-out accuracy n = 120', '0.79 Held-out macro-F1 n = 120', '97.1% Coverage n = 412', '88% Agreement with AI coding']);
  assert.match(await page.textContent('#dim-sentiment .cr-sent'), /^Sent .+ from “Sentiment rule”$/);
  assert.equal(await page.getAttribute('#dim-sentiment .cr-open', 'href'), '/ultra/ai-lab#experiment/' + EXP);
  let cb = await codebookOf(page);
  assert.equal(cb[0].codingRule.submissionId, one);
  assert.equal(cb[0].codingRule.code, CODE);
  assert.equal(cb[0].codingRule.version, 3);
  assert.deepEqual(cb[0].codingRuleHistory, []);
  assert.equal('codingRule' in cb[1], false);
  assert.equal((await stored(page))[0].codingRule.submissionId, one, 'saved to localStorage through App.setState');
  await until(() => lab.results.length === 1, 'the result POST');
  assert.deepEqual(lab.results[0].body, { status: 'applied', dimensionId: 'sentiment' });
  assert.equal(lab.results[0].id, one);
  assert.match(lab.results[0].contentType, /application\/json/);
  assert.deepEqual(await resultOn(listener, one), { type: 'coding-rule-result', submissionId: one, ok: true, dimensionId: 'sentiment' });
  assert.equal(new URL(page.url()).hash, '#codebook', 'the hash is cleaned');
  assert.equal(await page.title(), 'MetaCode — Social Media Coding Platform', 'the title is back');
  assert.equal(await page.evaluate(() => window.__pwned), undefined);

  // View code: escaped, with metadata
  await page.click('#dim-sentiment .cr-view');
  await page.waitForSelector('#cr-view-code');
  assert.equal(await page.textContent('#cr-view-code'), CODE);
  assert.equal(await page.$$eval('#cr-view-code *', els => els.length), 0);
  assert.match(await page.textContent('#cr-view'), /Experiment\s*Sentiment rule/);
  await page.click('#modal-foot .btn-primary');

  // The same submission again (the Lab retrying): no dialog, nothing changes, reported applied
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, one);
  await until(() => lab.results.length === 2, 'the second result POST');
  assert.deepEqual(lab.results[1].body, { status: 'applied', dimensionId: 'sentiment' });
  assert.equal(await page.locator('#lh-save').count(), 0, 'no confirmation for a no-op');
  await page.waitForSelector('.notif:has-text("already in the Codebook")');
  const cb2 = await codebookOf(page);
  assert.deepEqual(cb2, cb, 'unchanged');
  await listener.waitForFunction(id => window.msgs.filter(m => m.type === 'coding-rule-result' && m.submissionId === id && m.ok).length === 2, one);

  // A newer version replaces it; the old one goes to the history
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, two);
  await page.waitForSelector('#lh-save');
  assert.match(await page.textContent('#lh-change'), /^Replaces v3 \(sent .+\), which moves to the rule's history\.$/);
  await page.click('#lh-save');
  await page.waitForFunction(() => /· v4 ·/.test((document.querySelector('#dim-sentiment .cr-head') || {}).textContent || ''));
  cb = await codebookOf(page);
  assert.equal(cb[0].codingRule.submissionId, two);
  assert.deepEqual(cb[0].codingRuleHistory.map(h => [h.submissionId, h.version, typeof h.replacedAt]), [[one, 3, 'string']]);
  assert.match(await page.textContent('#dim-sentiment .cr-history summary'), /History \(1 earlier version\)/);
  await until(() => lab.results.length === 3, 'the third result POST');
  assert.deepEqual(lab.results[2], { id: two, body: { status: 'applied', dimensionId: 'sentiment' }, origin: baseUrl, contentType: lab.results[2].contentType });

  // Editing a code keeps the code's other fields; editing the dimension keeps the rule
  await page.evaluate(() => { const s = App.getState(); s.codebook[0].codes[0].extraField = 'kept'; App.save(); Codebook.render(); });
  await page.click('#codes-sentiment .dim-code:first-child button[title="Edit"]');
  await page.fill('#code-label', 'Positive tone');
  await page.click('#modal-foot .btn-primary');
  cb = await codebookOf(page);
  assert.deepEqual(cb[0].codes[0], { id: 'pos', label: 'Positive tone', description: '', aiNotes: '', extraField: 'kept' });
  assert.equal(cb[0].codingRule.submissionId, two);

  // Remove the rule (asks first, in a dialog)
  await page.click('#dim-sentiment .cr-remove');
  await page.waitForSelector('#cr-remove-confirm');
  assert.match(await page.textContent('#cr-remove'), /This removes v4 and its history \(1 earlier version\) from “Sentiment”/);
  await page.click('#cr-remove-confirm');
  await page.waitForFunction(() => !document.querySelector('#dim-sentiment .cr-panel'));
  cb = await codebookOf(page);
  assert.equal('codingRule' in cb[0], false);
  assert.equal('codingRuleHistory' in cb[0], false);
  assert.equal(cb[0].name, 'Sentiment');

  // Sending the removed rule again (the Lab's Send to Codebook): asked again, saved again, reported applied
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, two);
  await page.waitForSelector('#lh-save');
  assert.match(await page.textContent('#lh-change'), /^New rule/);
  await page.click('#lh-save');
  await page.waitForSelector('#dim-sentiment .cr-panel');
  cb = await codebookOf(page);
  assert.equal(cb[0].codingRule.submissionId, two);
  assert.deepEqual(cb[0].codingRuleHistory, []);
  await until(() => lab.results.length === 4, 'the result POST after removing');
  assert.deepEqual(lab.results[3].body, { status: 'applied', dimensionId: 'sentiment' });
  await listener.waitForFunction(id => window.msgs.filter(m => m.type === 'coding-rule-result' && m.submissionId === id && m.ok).length === 2, two);

  assert.deepEqual(errors, []);
  await context.close();
});

// The payload as the Lab builds it (ai-lab/experiments.js codingRule): the contract lists the variable's codes
const contractFor = (variable, codes) => ({ name: 'classify/1', input: { record: 'id, text, author, timestamp, meta', variable: { id: variable.id, name: variable.name, codes } }, output: { returns: 'a code id or null', codes } });

test('codes: a rule that can return codes the open variable lacks is refused; codes the rule never returns are a warning; where it comes from is shown', { skip, timeout: 90000 }, async () => {
  const other = sid('otherproj'), fewer = sid('fewer'), known = sid('known'), drift = sid('drift');
  const stance = { id: 'stance', name: 'Policy Stance' };
  const subs = {
    // Measured on project A's "stance" (support/oppose/neutral); the open project's "stance" has only support
    [other]: Object.assign(submission(other, { dimensionId: 'stance', contract: contractFor(stance, ['support', 'oppose', 'neutral']), sandbox: { id: 'sbx_0123456789abcdef', name: 'Project A · Policy Stance', version: 1, sha256: 'd'.repeat(64) } }),
      { responseExtra: { variable: stance } }),
    // The open "sentiment" has pos and neg; this rule only ever returns pos
    [fewer]: Object.assign(submission(fewer, { contract: contractFor({ id: 'sentiment', name: 'Sentiment' }, ['pos']) }), { responseExtra: { variable: { id: 'sentiment', name: 'Sentiment' } } }),
    // When the Lab names the sandbox's project, the confirmation does too (and warns when it isn't the open one)
    [known]: Object.assign(submission(known, { contract: contractFor({ id: 'sentiment', name: 'Sentiment' }, ['pos', 'neg']) }),
      { responseExtra: { variable: { id: 'sentiment', name: 'Sentiment' }, sandbox: { id: 'sbx_0123456789abcdef', name: 'Project A · Sentiment', source: { kind: 'project', projectName: 'Project A' } } } }),
    [drift]: submission(drift, { contract: contractFor({ id: 'sentiment', name: 'Sentiment' }, ['pos', 'neg']) })
  };
  const { context, page, errors, lab, listener } = await setup(subs);
  await page.goto(baseUrl + '/app.html#codebook');
  await page.waitForSelector('.dim-card');

  // Refused: the codes are listed, nothing saved, the Lab told why
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, other);
  await page.waitForSelector('#lh-message');
  assert.equal(await page.textContent('#modal-title'), 'The variable\'s codes don\'t match this rule');
  const msg = await page.textContent('#lh-message');
  assert.match(msg, /This rule can return oppose, neutral, which the variable “Stance” \(stance\) in the open project “Climate threads” doesn't have\./);
  assert.match(msg, /The rule's codes: support, oppose, neutral; the variable's codes: support\./);
  assert.match(await page.textContent('#lh-detail'), /Measured on the variable “Policy Stance” from the sandbox “Project A · Policy Stance”\. Add the missing codes to the variable, or open the project the rule was made for, then send again\./);
  await until(() => lab.results.length === 1, 'the failed result');
  assert.equal(lab.results[0].body.status, 'failed');
  assert.match(lab.results[0].body.error, /can return codes that the variable “Stance” \(stance\) in the open project doesn't have: oppose, neutral\./);
  const r1 = await resultOn(listener, other);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /oppose, neutral/);
  assert.equal('codingRule' in (await codebookOf(page))[1], false);
  await page.click('#lh-close');

  // A warning (save allowed): the variable has codes the rule never returns; the target and the source are named
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, fewer);
  await page.waitForSelector('#lh-save');
  assert.equal(await page.textContent('#lh-target'), 'Sentiment sentiment in “Climate threads” (the open project)');
  assert.equal(await page.textContent('#lh-source'), 'The variable “Sentiment” from the sandbox “Climate threads · Sentiment”');
  assert.equal(await page.textContent('#lh-rule-codes'), 'pos');
  assert.match(await page.textContent('#lh-codes'), /“Sentiment” has codes this rule never returns: neg\. The rule was measured with the codes pos, so its results say nothing about neg\. You can still save it\./);
  assert.equal(await page.locator('#lh-other-project').count(), 0);
  await page.click('#lh-save');
  await page.waitForSelector('#dim-sentiment .cr-panel');
  await until(() => lab.results.length === 2, 'the applied result');
  assert.deepEqual(lab.results[1].body, { status: 'applied', dimensionId: 'sentiment' });
  assert.equal((await codebookOf(page))[0].codingRule.submissionId, fewer);
  // The panel says what the rule never returns
  assert.match(await page.textContent('#dim-sentiment .cr-drift'), /never returns neg/);

  // The sandbox's project is known and isn't the open one: named, with a warning
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, known);
  await page.waitForSelector('#lh-save');
  assert.equal(await page.textContent('#lh-source'), 'The variable “Sentiment” from the project “Project A” (sandbox “Climate threads · Sentiment”)');
  assert.match(await page.textContent('#lh-other-project'), /This rule was measured on posts from the project “Project A”, not the open project “Climate threads”\./);
  assert.equal(await page.locator('#lh-codes').count(), 0, 'same codes: no codes warning');
  await page.click('#lh-cancel');
  await until(() => lab.results.length === 3, 'the cancelled result');

  // Codes deleted while the dialog is open: Save refuses, with the codes
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, drift);
  await page.waitForSelector('#lh-save');
  await page.evaluate(() => { const s = App.getState(); App.setState({ codebook: s.codebook.map(d => (d.id === 'sentiment' ? Object.assign({}, d, { codes: d.codes.filter(c => c.id !== 'neg') }) : d)) }); });
  await page.click('#lh-save');
  await page.waitForSelector('#lh-message');
  assert.match(await page.textContent('#lh-message'), /doesn't have: neg\./);
  await until(() => lab.results.length === 4, 'the refused save');
  assert.equal(lab.results[3].body.status, 'failed');
  assert.match(lab.results[3].body.error, /neg/);
  assert.equal((await codebookOf(page))[0].codingRule.submissionId, fewer, 'the rule already there stays');
  await page.click('#lh-close');

  // The rule already on the variable, sent again after its codes changed: a no-op, reported applied
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, fewer);
  await until(() => lab.results.length === 5, 'the no-op result');
  assert.deepEqual(lab.results[4].body, { status: 'applied', dimensionId: 'sentiment' });
  assert.equal(await page.locator('#lh-save').count(), 0);

  assert.deepEqual(errors, []);
  await context.close();
});

test('Codebook CSV import keeps a variable\'s coding rule and history, and marks codes the rule returns that the CSV dropped; the example codebook asks first', { skip, timeout: 90000 }, async () => {
  const state = JSON.parse(JSON.stringify(STATE));
  const rulePayload = payload(sid('csvrule'), { contract: contractFor({ id: 'sentiment', name: 'Sentiment' }, ['pos', 'neg']) });
  state.codebook[0].codes[0].extraField = 'kept';
  state.codebook[0].custom = 'kept too';
  state.codebook[0].codingRule = Object.assign({}, rulePayload, { appliedAt: '2026-10-24T11:00:00.000Z' });
  state.codebook[0].codingRuleHistory = [Object.assign({}, payload(sid('older'), { version: 2 }), { replacedAt: '2026-10-24T11:00:00.000Z' })];
  const { context, page, errors } = await setup({}, state);
  await page.goto(baseUrl + '/app.html#codebook');
  await page.waitForSelector('#dim-sentiment .cr-panel');
  assert.equal(await page.locator('#dim-sentiment .cr-drift').count(), 0, 'codes match: no mark');
  // Papa Parse comes from a CDN (blocked here): a small stand-in for header + comma rows
  await page.evaluate(() => {
    window.Papa = { parse(file, o) { file.text().then(t => { const [h, ...rows] = t.trim().split(/\r?\n/).map(l => l.split(',')); o.complete({ data: rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] || '']))) }); }); } };
  });
  const importCsv = async text => {
    await page.click('.view-actions .btn-secondary');
    await page.waitForSelector('#cb-file', { state: 'attached' });
    assert.match(await page.textContent('#cb-import-rules'), /Coding rules from the AI Coding Lab aren't in codebook CSVs/);
    await page.setInputFiles('#cb-file', { name: 'codebook.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
    await page.waitForFunction(() => !document.getElementById('modal-backdrop').classList.contains('is-open'));
  };

  // Same codes, new descriptions: the rule, its history and other fields stay
  await importCsv('dimension_name,dimension_description,code_id,code_label,code_description\nSentiment,Tone,pos,Positive,Upbeat\nSentiment,Tone,neg,Negative,Downbeat\nTopic,,econ,Economy,\n');
  let cb = await codebookOf(page);
  const s = cb.find(d => d.id === 'sentiment');
  assert.equal(s.description, 'Tone');
  assert.deepEqual(s.codes, [{ id: 'pos', label: 'Positive', description: 'Upbeat', aiNotes: '', extraField: 'kept' }, { id: 'neg', label: 'Negative', description: 'Downbeat', aiNotes: '' }]);
  assert.equal(s.custom, 'kept too');
  assert.equal(s.codingRule.submissionId, sid('csvrule'));
  assert.deepEqual(s.codingRuleHistory.map(h => h.submissionId), [sid('older')]);
  assert.deepEqual(cb.map(d => d.id), ['sentiment', 'stance', 'topic']);
  await page.waitForSelector('#dim-sentiment .cr-panel');
  assert.equal(await page.locator('#dim-sentiment .cr-drift').count(), 0);
  assert.equal((await stored(page))[0].codingRule.submissionId, sid('csvrule'), 'saved');

  // The CSV drops "neg", which the rule can return: the rule stays, marked in the panel, and the import says so
  await importCsv('dimension_name,code_id,code_label\nSentiment,pos,Positive\nSentiment,mixed,Mixed\n');
  cb = await codebookOf(page);
  assert.equal(cb[0].codingRule.submissionId, sid('csvrule'));
  assert.equal(cb[0].codingRuleHistory.length, 1);
  assert.deepEqual(cb[0].codes.map(c => c.id), ['pos', 'mixed']);
  const mark = await page.textContent('#dim-sentiment .cr-drift.cr-warn');
  assert.match(mark, /Codes changed since this rule was tested: it can return neg, which “Sentiment” no longer has\. It never returns mixed\./);
  await page.waitForSelector('.notif:has-text("codes changed since")');
  // View code says so too
  await page.click('#dim-sentiment .cr-view');
  await page.waitForSelector('#cr-view .cr-drift');
  await page.click('#modal-foot .btn-primary');

  // The example codebook replaces everything: it asks first when a variable has a coding rule
  const dialogs = [];
  page.once('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.evaluate(() => Codebook.loadExample());
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /coding rule/);
  assert.equal((await codebookOf(page))[0].codingRule.submissionId, sid('csvrule'), 'cancelled: nothing changed');
  page.once('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.evaluate(() => Codebook.loadExample());
  assert.deepEqual((await codebookOf(page)).map(d => d.id), ['sentiment', 'stance', 'incivility', 'topic']);
  assert.equal('codingRule' in (await codebookOf(page))[0], false);

  assert.deepEqual(errors, []);
  await context.close();
});

test('failures: variable missing, cancel, Escape, invalid rule, Ultra plan required, unknown submission', { skip, timeout: 90000 }, async () => {
  const missing = sid('missing'), named = sid('named'), cancel = sid('cancel'), esc = sid('escape'), invalid = sid('invalid'), ultra = sid('ultra'), unknown = sid('unknown');
  const subs = {
    [missing]: submission(missing, { dimensionId: 'topic' }),
    [named]: Object.assign(submission(named, { dimensionId: 'topic' }), { responseExtra: { variable: { id: 'topic', name: 'Primary Topic' } } }),
    [cancel]: submission(cancel),
    [esc]: submission(esc),
    [invalid]: submission(invalid, { code: '// ' + 'x'.repeat(70 * 1024), security: { policy: 'passed', review: 'rejected', reviewedAt: null } }),
    [ultra]: { httpStatus: 402, error: { type: 'plan_required', message: 'The AI Coding Lab is part of the Ultra plan.' } }
  };
  const { context, page, errors, lab, listener } = await setup(subs);
  const before = STATE.codebook;

  // The variable isn't in the open project
  await page.goto(baseUrl + '/app.html#codebook/lab/' + missing);
  await page.waitForSelector('#lh-message');
  assert.equal(await page.textContent('#modal-title'), 'This variable isn\'t in the open project');
  assert.match(await page.textContent('#lh-message'), /This rule is for the variable with the id “topic”, and the open project “Climate threads” doesn't have it\. Open the project that has it, then send again\./);
  assert.match(await page.textContent('#lh-detail'), /From the experiment “Sentiment rule”, sandbox “Climate threads · Sentiment”\./);
  await until(() => lab.results.length === 1, 'the failed result');
  assert.equal(lab.results[0].body.status, 'failed');
  assert.match(lab.results[0].body.error, /no variable with the id “topic”/);
  const r1 = await resultOn(listener, missing);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /no variable/);
  assert.equal(new URL(page.url()).hash, '#codebook');
  await page.click('#lh-close');
  // When the Lab's answer names the variable, the message does too
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, named);
  await page.waitForSelector('#lh-message');
  assert.match(await page.textContent('#lh-message'), /^This rule is for the variable “Primary Topic” \(id topic\), and the open project “Climate threads” doesn't have it\./);
  await until(() => lab.results.length === 2, 'the second failed result');
  lab.results.splice(1, 1);
  await page.click('#lh-close');

  // Cancel
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, cancel);
  await page.waitForSelector('#lh-cancel');
  await page.click('#lh-cancel');
  await until(() => lab.results.length === 2, 'the cancelled result');
  assert.deepEqual(lab.results[1].body, { status: 'failed', error: 'Cancelled in MetaCode' });
  assert.deepEqual(await resultOn(listener, cancel), { type: 'coding-rule-result', submissionId: cancel, ok: false, error: 'Cancelled in MetaCode' });
  assert.equal(await page.isVisible('#modal-backdrop'), false);

  // Closing the dialog with Escape is a cancel too
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, esc);
  await page.waitForSelector('#lh-save');
  await page.keyboard.press('Escape');
  await until(() => lab.results.length === 3, 'the escaped result');
  assert.deepEqual(lab.results[2].body, { status: 'failed', error: 'Cancelled in MetaCode' });

  // An invalid rule (too large, review rejected): the problems are listed
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, invalid);
  await page.waitForSelector('#lh-problems');
  const problems = await page.$$eval('#lh-problems li', li => li.map(x => x.textContent));
  assert.ok(problems.some(p => /too large/.test(p)), problems.join(' | '));
  assert.ok(problems.some(p => /rejected/.test(p)));
  await until(() => lab.results.length === 4, 'the invalid result');
  assert.equal(lab.results[3].body.status, 'failed');
  assert.match(lab.results[3].body.error, /^The coding rule isn't valid: /);
  await page.click('#lh-close');

  // The server refuses (plan): a readable message; nothing to record on the server
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, ultra);
  await page.waitForSelector('#lh-message');
  assert.equal(await page.textContent('#modal-title'), 'The AI Coding Lab needs the Ultra plan');
  assert.match(await page.textContent('#lh-message'), /part of the Ultra plan/);
  const r5 = await resultOn(listener, ultra);
  assert.equal(r5.ok, false);
  assert.match(r5.error, /Ultra plan/);
  await page.click('#lh-close');

  // Unknown submission (another account's, or deleted)
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, unknown);
  await page.waitForSelector('#lh-message');
  assert.match(await page.textContent('#lh-message'), /wasn't found/);
  assert.equal((await resultOn(listener, unknown)).ok, false);
  await page.click('#lh-close');
  assert.equal(lab.results.length, 4, 'refused loads post no result');

  // Not a submission id at all: nothing is fetched
  const gets = lab.gets.length;
  await page.evaluate(() => { location.hash = '#codebook/lab/..%2F..%2Fadmin'; });
  await page.waitForSelector('.notif:has-text("doesn\'t point to a coding rule")');
  assert.equal(lab.gets.length, gets);
  assert.equal(new URL(page.url()).hash, '#codebook');

  assert.deepEqual(await codebookOf(page), before, 'the codebook never changed');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the Lab tab asks on the channel: this tab answers at once, confirms and reports', { skip, timeout: 60000 }, async () => {
  const id = sid('channel');
  const subs = { [id]: submission(id) };
  const { context, page, errors, lab, listener } = await setup(subs);
  await page.goto(baseUrl + '/app.html#dashboard');
  await page.waitForSelector('.dash-grid');
  // The Lab waits 1200 ms for an answer before opening a new tab
  await listener.evaluate(id => window.bc.postMessage({ type: 'apply-coding-rule', submissionId: id }), id);
  const ack = await listener.waitForFunction(id => window.msgs.find(m => m.type === 'coding-rule-ack' && m.submissionId === id), id, { timeout: 1200 });
  assert.deepEqual(await ack.jsonValue(), { type: 'coding-rule-ack', submissionId: id });
  // Messages that aren't for the app (or carry a bad id) are ignored
  await listener.evaluate(() => { window.bc.postMessage({ type: 'apply-coding-rule', submissionId: '<img src=x>' }); window.bc.postMessage('junk'); window.bc.postMessage({ type: 'other' }); });
  await page.waitForSelector('#lh-save');
  assert.equal(await page.textContent('#topbar-title'), 'Dashboard', 'the dialog opens over the page the user is on');
  // Sending again while the dialog is open: answered, not shown twice
  await listener.evaluate(id => window.bc.postMessage({ type: 'apply-coding-rule', submissionId: id }), id);
  await listener.waitForFunction(id => window.msgs.filter(m => m.type === 'coding-rule-ack' && m.submissionId === id).length === 2, id);
  await page.click('#lh-save');
  assert.deepEqual(await resultOn(listener, id), { type: 'coding-rule-result', submissionId: id, ok: true, dimensionId: 'sentiment' });
  assert.equal(lab.results.length, 1);
  assert.deepEqual(lab.results[0].body, { status: 'applied', dimensionId: 'sentiment' });
  assert.equal(lab.gets.length, 1, 'loaded once');
  assert.equal((await codebookOf(page))[0].codingRule.submissionId, id);
  await page.waitForSelector('.notif:has-text("Saved to the Codebook")');
  assert.deepEqual(errors, []);
  await context.close();
});

test('shared projects: a viewer is warned the rule stays in this browser; a Codebook conflict must be resolved first', { skip, timeout: 60000 }, async () => {
  const viewer = sid('viewer'), conflict = sid('conflict');
  const subs = { [viewer]: submission(viewer), [conflict]: submission(conflict, { dimensionId: 'stance' }) };
  const { context, page, errors, lab, listener } = await setup(subs);
  await page.goto(baseUrl + '/app.html#codebook');
  await page.waitForSelector('.dim-card');
  // Pretend this is a shared project this person can only view
  await page.evaluate(() => { Collab.active = () => true; Collab.canEdit = () => false; Collab.link = () => ({ role: 'viewer', conflicts: [] }); });
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, viewer);
  await page.waitForSelector('#lh-viewer');
  assert.match(await page.textContent('#lh-viewer'), /saved in this browser only/);
  await page.click('#lh-save');
  assert.equal((await resultOn(listener, viewer)).ok, true);
  assert.equal((await codebookOf(page))[0].codingRule.submissionId, viewer);

  // An editor with an unresolved conflict on the Codebook
  await page.evaluate(() => { Collab.canEdit = () => true; Collab.link = () => ({ role: 'editor', conflicts: [{ key: 'codebook' }] }); });
  await page.evaluate(id => { location.hash = '#codebook/lab/' + id; }, conflict);
  await page.waitForSelector('#lh-message');
  assert.equal(await page.textContent('#modal-title'), 'Resolve the Codebook conflict first');
  const r = await resultOn(listener, conflict);
  assert.equal(r.ok, false);
  assert.match(r.error, /conflict/);
  await until(() => lab.results.length === 2, 'the conflict result');
  assert.equal(lab.results[1].body.status, 'failed');
  assert.equal('codingRule' in (await codebookOf(page))[1], false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('ids with quotes from a CSV or a collaborator never reach the inline handlers as code', { skip, timeout: 60000 }, async () => {
  const state = JSON.parse(JSON.stringify(STATE));
  state.codebook[0].codes.push({ id: "x');window.__pwned=1;('", label: 'Odd', description: '', aiNotes: '' });
  state.codebook.push({ id: 'd"><img src=x onerror="window.__pwned=3">', name: 'Odd dimension', description: '', codes: [],
    codingRule: { version: 1, language: 'python', experiment: { id: 'javascript:alert(1)', name: '<b>x</b>' }, code: '<img src=x onerror="window.__pwned=4">', evaluation: { accuracy: 'NaN' } } });
  const { context, page, errors } = await setup({}, state);
  await page.goto(baseUrl + '/app.html#codebook');
  await page.waitForSelector('.dim-card');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('.dim-card img').count(), 0);
  // The odd code still works through its buttons: edit opens it, delete asks
  await page.click('#codes-sentiment .dim-code:nth-child(3) button[title="Edit"]');
  await page.waitForSelector('#code-label');
  assert.equal(await page.inputValue('#code-id'), "x');window.__pwned=1;('");
  await page.click('#modal-foot .btn-secondary');
  // The odd dimension's rule panel shows text only; no link for a bad experiment id; no Lab link for a bad variable id
  const odd = page.locator('.dim-card').nth(2);
  assert.equal(await odd.locator('.cr-head').textContent(), 'Coding rule · v1 · Python · experimental — not used by AI Coding');
  assert.equal(await odd.locator('.cr-open').count(), 0);
  assert.equal(await odd.locator('.cr-improve').count(), 0);
  await odd.locator('.cr-view').click();
  await page.waitForSelector('#cr-view-code');
  assert.equal(await page.textContent('#cr-view-code'), '<img src=x onerror="window.__pwned=4">');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.deepEqual(errors, []);
  await context.close();
});
