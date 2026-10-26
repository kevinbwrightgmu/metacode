// Code Experiments in a real browser (Playwright + Chromium) against the real
// server, the real experiments API and the real sandbox (JavaScript in QuickJS).
// Supabase, Stripe and the AI service are local mocks (test/helpers): this
// proves MetaCode's pages, server and sandbox, not a provider.
//
//   1. The whole journey: the open MetaCode project (localStorage strata_v1) →
//      a new experiment for its variable "stance" → an AI-written rule (the mock
//      writes a keyword rule) → edited by hand → Save & run → terminal, preview,
//      metrics → a refined version, run → compare → AI evaluation → select the
//      final version → Send to Codebook → the app tab opens, the account's
//      "Add this browser's work…?" question comes first (once), then the
//      confirmation → saved on the dimension (and synced to the account);
//      Send again delivers the same submission to the app again (which says it
//      has it); removed in the Codebook and sent again, the app asks again and
//      the Lab waits for that answer; selected again, it is a new send (its own
//      key) with the new rationale; another final version sent while the app
//      tab is open goes over the BroadcastChannel and replaces it.
//   2. What goes wrong: a network-flooding rule is blocked (nothing executes);
//      a syntax error and an endless loop are blocked by the policy with their
//      lines; a cancelled run; a timeout fails the run and the workspace keeps
//      working; output with an unknown code fails at output validation; unsaved
//      edits turn Run into Save & run, and switching versions asks first; one
//      short Python run (when this Node can run Python); a run blocked until
//      the review is read is "Ready to run" once allowed; new success criteria
//      give a matching objective score; a run that ends while another version
//      (or another run in the terminal) is shown still ends in the workspace.
//   3. What runs here: the Models page shows the server's code-execution report;
//      a language the server can't run (a /models answer changed in the page)
//      is disabled with its reason in the new-experiment form and the editor,
//      and Run says why; "switched off" is said plainly.
// Every page error fails the test; requests leave only for this machine.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one)
// or when this Node can't run the sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testEnv } = require('./helpers/harness');
const { mockSupabase, mockStripe } = require('./helpers/account-mocks');
const { startAiService } = require('./helpers/lab-mocks');
const { createCodeSandbox } = require('../ai-lab/code-sandbox');

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
const chromiumPath = findChromium();
const probe = createCodeSandbox({ getConfig: () => ({}) });
const jsSupport = probe.supported('javascript');
const pySupport = probe.supported('python');
const skip = (!chromiumPath && 'no Chromium found (set CHROMIUM_PATH)') || (!jsSupport.ok && jsSupport.reason);
const KEY = 'sb_publishable_xp_e2e_0123456789';
const aiState = { requests: [], streamDelayMs: 0, fail: false };
let sb, stripe, aiService, server, baseUrl, browser, tmp;
const TERMINAL = ['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'];

// The open MetaCode project: the variable "stance" (pos / neg / neu, labelled
// Support / Against / Neutral, so the mock's keyword rule finds those words)
// and 40 posts — most coded by people (a few adjudicated, some by two coders)
// and by AI Coding — plus a second variable.
const POSTS = [
  ['I support the new bike lanes downtown', 'pos', 'pos'], ['Strong support for the transit plan', 'pos', 'pos', 'adj'], ['We support more buses at night', 'pos', 'neu'],
  ['Full support from our street', 'pos', 'pos'], ['Support this, it helps commuters', null, 'pos'], ['We are against the parking cuts', 'neg', 'neg'],
  ['I am against this plan completely', 'neg', 'pos'], ['Residents stand against the new fees', 'neg', 'neg', 'two'], ['Strongly against closing the station', 'neg', 'neg'],
  ['Many shop owners are against the lanes', null, 'neg'], ['Neutral update: the meeting is on Tuesday', 'neu', 'neu'], ['A neutral summary of the plan', 'neu', 'neu', 'two'],
  ['Schedule changes, neutral info only', 'neu', 'pos'], ['neutral', 'neu', 'neu'], ['What time does the bus come?', 'neu', 'neu'],
  ['Photos from the parade', null, 'neu'], ['Is the library open today?', 'neu', null], ['ok', null, null],
  ['Thanks for sharing', 'pos', 'pos'], ['Traffic was heavy this morning', 'neg', 'neg'], ['The vote is next week', 'neu', 'neu'],
  ['Read the full report here https://example.org/r', null, 'neu'], ['I don\'t support it but I\'m not against it either', 'neu', 'neu', 'adj'], ['Absolutely against it, a negative change', 'neg', 'neg'],
  ['A negative experience on line 4 <b>today</b>', 'neg', 'neg'], ['I support the new bike lanes downtown', 'pos', 'pos'], ['neutral', null, 'neu'],
  ['We support the plan, great work', 'pos', 'pos'], ['Count me against the toll', 'neg', 'neg'], ['More trains please', 'pos', 'pos'],
  ['Not sure what to think', 'neu', 'neu'], ['Totally against more traffic', 'neg', null], ['Support from the mayor\'s office', null, 'pos'],
  ['Heard the update, sounds neutral to me', 'neu', 'neu', 'two'], ['Bus 12 was late again', 'neg', 'neg'], ['We support the station rebuild', 'pos', 'pos'],
  ['A balanced and neutral view', null, 'neu'], ['against', 'neg', 'neg'], ['Great to see support for cyclists', 'pos', 'pos'], ['Nothing to add', null, null]
];
function project() {
  return {
    project: { name: 'Transit threads', description: '' },
    posts: POSTS.map(([text, human, ai, how], i) => ({
      id: 'p' + (i + 1), text, author: 'user' + (i % 7), timestamp: '2026-10-' + String(1 + (i % 28)).padStart(2, '0') + 'T10:00:00Z',
      engagement: { likes: i, shares: i % 3, comments: 1, views: null }, source: { platform: 'reddit' },
      humanCodes: human ? { stance: human } : {}, coder2Codes: how === 'two' ? { stance: human } : {},
      adjudicated: how === 'adj' ? { stance: { code: human, by: 'lead coder' } } : {},
      aiCodes: ai ? { stance: { code: ai, confidence: 0.9, reasoning: 'x' } } : {}
    })),
    codebook: [
      { id: 'topic', name: 'Topic', description: 'What the post is about', codes: [{ id: 'bus', label: 'Buses', description: '', aiNotes: '' }, { id: 'bike', label: 'Bikes', description: '', aiNotes: '' }] },
      { id: 'stance', name: 'Stance', description: 'Position on the transit plan', codes: [
        { id: 'pos', label: 'Support', description: 'For the plan', aiNotes: '' },
        { id: 'neg', label: 'Against', description: 'Against the plan', aiNotes: '' },
        { id: 'neu', label: 'Neutral', description: 'Neither', aiNotes: '' }] }
    ],
    network: { nodes: [], edges: [] }, settings: {}
  };
}
const HUMAN_LABELLED = POSTS.filter(p => p[1]).length;

test.before(async () => {
  if (skip) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-xp-e2e-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  stripe = mockStripe({ key: 'sk_test_xpe2e', products: {
    prod_VQeJh2lPqfmae9: { id: 'prod_VQeJh2lPqfmae9', active: true, default_price: 'price_pro' },
    prod_VQeK26tKchu1VI: { id: 'prod_VQeK26tKchu1VI', active: true, default_price: 'price_max' },
    prod_VQeKXAJtQQLKqm: { id: 'prod_VQeKXAJtQQLKqm', active: true, default_price: 'price_ultra' }
  } });
  await stripe.start();
  aiService = await startAiService(aiState);
  stripe.subscribe(sb.addUser('ultra@example.org', 'ultra password 1').id, 'prod_VQeKXAJtQQLKqm');
  stripe.subscribe(sb.addUser('ultra2@example.org', 'ultra password 2').id, 'prod_VQeKXAJtQQLKqm');
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY,
    STRIPE_SECRET_KEY: 'sk_test_xpe2e', STRIPE_API_BASE: stripe.url,
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'), COLLAB_DATA_DIR: path.join(tmp, 'collab'),
    AI_LAB_DATA_DIR: path.join(tmp, 'lab'), AI_LAB_PRICING_FILE: path.join(tmp, 'none.json'),
    AI_LAB_SANDBOX_TIMEOUT_MS: '2000',    // the busy-waiting rule below times out quickly
    OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + aiService.address().port + '/v1', OPENCODE_SERVICE_TOKEN: 'test-service-token-0123456789',
    OPENCODE_MODEL: 'lab-model', AI_MODEL_SWITCH: 'off'
  }));
  const { start } = require('../server');
  server = await start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (aiService) { aiService.closeAllConnections(); await new Promise(r => aiService.close(r)); }
  if (sb) await sb.close();
  if (stripe) await stripe.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// A browser context with the project open in MetaCode (seeded once, then each
// page keeps what the app writes). Every page's errors are collected, and the
// account and coding-rule dialogs are recorded as they appear.
async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(s => {
    try {
      localStorage.setItem('metacode_tour_app', 'done');
      if (!localStorage.getItem('xp-seeded')) { localStorage.setItem('strata_v1', s); localStorage.setItem('xp-seeded', '1'); }
    } catch (e) { /* ignore */ }
    window.__dialogs = [];
    // (a tab opened with window.open keeps its first window for the page it loads: watch each document)
    const watch = () => {
      if (document.__watched) return;
      document.__watched = true;
      new MutationObserver(muts => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.classList.contains('acct-overlay')) window.__dialogs.push({ kind: 'account', title: (n.querySelector('h2') || {}).textContent || '', handoffOpen: !!document.getElementById('lh-save') });
            if (n.id === 'lh-save') window.__dialogs.push({ kind: 'handoff', accountOpen: !!document.querySelector('.acct-overlay') });
          }
        }
      }).observe(document, { childList: true, subtree: true });
    };
    watch();
    window.addEventListener('DOMContentLoaded', watch);
  }, JSON.stringify(project()));
  // only this machine (MetaCode and the mocks) — no internet
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, route => route.abort());
  const errors = [];
  const watch = (p, name) => p.on('pageerror', e => errors.push(name + ': ' + e.message));
  context.on('page', p => watch(p, 'tab'));
  const page = await context.newPage();
  return { context, page, errors };
}
async function signIn(page, email, pw) {
  await page.goto(baseUrl + '/ultra/ai-lab');
  await page.waitForSelector('[data-account-chip] .acct-signin');
  await page.click('[data-account-chip] .acct-signin');
  await page.fill('.acct-form [name=email]', email);
  await page.fill('.acct-form [name=password]', pw);
  await page.click('.acct-form .acct-primary');
  await page.waitForSelector('#lab-nav:not([hidden])');
}
// The Lab API as the signed-in user (server state)
function api(page, p, method, body) {
  return page.evaluate(async ([p, method, body]) => {
    const r = await fetch('/api/lab' + p, { method: method || 'GET', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    return { status: r.status, body: json };
  }, [p, method || 'GET', body || null]);
}
const pill = page => page.textContent('#xp-state');
async function waitPill(page, text, ms) {
  try { await page.waitForFunction(t => { const e = document.getElementById('xp-state'); return !!e && e.textContent === t; }, text, { timeout: ms || 20000 }); }
  catch (e) { throw new Error('the status pill never said “' + text + '” (it says “' + await pill(page) + '”; terminal: ' + await page.textContent('#xp-term-status').catch(() => '?') + ')'); }
}
const expId = page => page.evaluate(() => location.hash.split('/')[1]);
const experiment = async page => (await api(page, '/experiments/' + await expId(page))).body;
async function runOf(page, id) {
  for (let i = 0; i < 200; i++) {
    const r = (await api(page, '/xruns/' + id)).body.run;
    if (TERMINAL.includes(r.status)) return r;
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('run ' + id + ' never ended');
}
const latestRun = async page => runOf(page, (await experiment(page)).runs[0].id);
// Replaces the editor's text the way a person pastes (CodeMirror's own input handling)
async function setCode(page, code) {
  await page.click('#xp-editor .cm-content');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(code);
  await page.keyboard.press('Escape');   // (closes an autocompletion popup, if any)
}
// The shown run is in the sandbox (past the review and the policy): the pill says "Running…" until it ends
const inExecution = page => page.waitForFunction(() => document.getElementById('xp-term-status').textContent === 'Running · execution', null, { timeout: 15000 });
const editorText = page => page.evaluate(() => Array.from(document.querySelectorAll('#xp-editor .cm-line')).map(l => l.textContent).join('\n'));
// A new experiment from the open project's "stance" variable, through the form
async function createExperiment(page) {
  await page.click('#lab-nav [data-view=experiments]');
  await page.waitForSelector('#xp-new');
  await page.click('#xp-new');
  await page.waitForSelector('#xp-new-form [name=xp-var]');
  assert.match(await page.textContent('#xp-src-p'), /Transit threads/);
  await page.check('#xp-new-form label.xp-var:has-text("Stance") input');
  assert.equal(await page.inputValue('#xp-f-name'), 'Stance rule');
  assert.equal(await page.inputValue('#xp-f-lang'), 'javascript');
  await page.click('#xp-create');
  await page.waitForSelector('#xp-state');
  await page.waitForSelector('#xp-editor .cm-editor', { timeout: 8000 });
  await waitPill(page, 'Empty workspace');
}
async function generate(page, button, prompt) {
  await page.fill('#xp-input', prompt);
  await page.click(button);
}

test('Code Experiments: project → AI rule → edit → Save & run → refine → compare → evaluate → final → Codebook (account question first, once)', { skip, timeout: 150000 }, async () => {
  const { context, page, errors } = await newContext();
  await signIn(page, 'ultra@example.org', 'ultra password 1');
  await createExperiment(page);
  const id = await expId(page);
  // Server: a sandbox of the project's 40 posts with the people's labels, and an empty experiment
  let x = await experiment(page);
  assert.equal(x.experiment.variable.id, 'stance');
  assert.deepEqual(x.experiment.variable.codes.map(c => c.id), ['pos', 'neg', 'neu']);
  assert.equal(x.experiment.language, 'javascript');
  assert.equal(x.sandbox.count, 40);
  assert.equal(x.sandbox.referenceCount, HUMAN_LABELLED);
  assert.equal(x.experiment.versions.length, 0);
  assert.match(await page.textContent('#xp-sbx'), /40 records · 31 labelled/);

  // The AI writes a rule: in the editor, marked AI-generated, checked by the policy and the AI review
  await generate(page, '#xp-generate', 'Code the stance of each post by the words it uses');
  await waitPill(page, 'Code generated');
  assert.match(await editorText(page), /function classify\(record, variable\)/);
  assert.match(await page.textContent('#xp-origin'), /AI-generated/);
  await page.waitForSelector('#xp-validation h4:has-text("Policy checks") .badge:has-text("passed")');
  await page.waitForSelector('#xp-validation h4:has-text("AI security review") .badge:has-text("approved")');
  assert.match(await page.textContent('#xp-thread'), /Created v1/);
  x = await experiment(page);
  const v1 = x.experiment.versions[0];
  assert.equal(v1.origin, 'generated');
  assert.equal(v1.policy.ok, true);
  assert.equal(v1.review.decision, 'approved');
  assert.equal(await editorText(page), v1.code);

  // Edited by hand: the dirty marker, then Save & run saves v2 and runs exactly that
  await page.click('#xp-editor .cm-content');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('// checked by hand');
  await page.waitForSelector('#xp-dirty:not([hidden])');
  await waitPill(page, 'Edited — save to run');
  assert.equal(await page.textContent('#xp-run'), 'Save & run');
  // (posts shorter than 12 characters get no code; a line for the terminal)
  const edited = 'console.log("stance rule: short posts get no code");\n' +
    v1.code.replace(/(function classify\([^)]*\)[^{]*\{\n)/, '$1  if (record.text.length < 12) return null;\n') + '// checked by hand\n';
  assert.notEqual(edited, v1.code + '// checked by hand\n');
  await setCode(page, edited);
  await page.click('#xp-run');
  await waitPill(page, 'Results ready', 30000);
  assert.equal(await page.inputValue('#xp-version'), '2');
  assert.match(await page.textContent('#xp-origin'), /User-edited/);
  assert.match(await page.textContent('#xp-term-status'), /^Succeeded in .* · 40 records$/);
  const term = await page.$$eval('#xp-term-body .xp-line', ls => ls.map(l => l.textContent));
  for (const st of ['input', 'review', 'policy', 'execution', 'output', 'metrics']) assert.ok(term.some(l => l.includes('[' + st + ']')), 'the terminal shows the ' + st + ' stage');
  assert.ok(term.some(l => /\[execution\]> stance rule: short posts get no code/.test(l)), 'the code\'s console output is in the terminal');
  assert.ok(term.some(l => /\[metrics\]Coded \d+\/40 · coverage/.test(l)), 'the summary line');
  // The preview: coded record cards from the validated results, with "changed" markers; text only
  await page.waitForSelector('#xp-preview .xp-rec');
  assert.equal(await page.$$eval('#xp-preview .xp-rec', l => l.length), 25);
  assert.ok(await page.$$eval('#xp-preview .xp-rec .xp-chip', l => l.some(c => /Support|Against|Neutral/.test(c.textContent))));
  assert.ok(await page.$$eval('#xp-preview .xp-changed-from', l => l.length) > 0, 'records coded differently from the current AI coding are marked');
  assert.equal(await page.$$eval('#xp-preview .xp-rec-text *', l => l.length), 0, 'record text is never HTML');
  let run2 = await latestRun(page);
  assert.equal(run2.version, 2);
  assert.equal(run2.status, 'succeeded');
  assert.equal(run2.stage, 'done');
  assert.equal(run2.output.valid, true);
  x = await experiment(page);
  const v2 = x.experiment.versions.find(v => v.version === 2);
  assert.equal(v2.origin, 'edited');
  assert.equal(v2.parent, 1);
  assert.equal(v2.code, edited, 'the exact text in the editor was saved');
  assert.equal(run2.codeHash, v2.codeHash, 'and that version ran');
  const res2 = (await api(page, '/xruns/' + run2.id + '/results?filter=all&limit=100')).body;
  assert.equal(res2.total, 40);
  assert.equal(res2.results.find(r => r.text === 'ok').code, null, 'the hand edit is in effect');
  // Metrics: held-out accuracy with its n
  await page.click('#xp-tab-metrics');
  await page.waitForSelector('#xp-metrics .lab-metric:has-text("Held-out accuracy")');
  const heldOut = run2.metrics.reference.test;
  assert.ok(heldOut.n >= 1);
  const card = await page.textContent('#xp-metrics .lab-metric:has-text("Held-out accuracy")');
  assert.match(card, new RegExp('n = ' + heldOut.n + ' held-out records'));
  assert.match(card, new RegExp((Math.round(heldOut.accuracy * 1000) / 10) + '%|' + Math.round(heldOut.accuracy * 100) + '%'));

  // A refined version from v2, run
  await generate(page, '#xp-refine', 'Refine it: keep the keywords and drop the special case');
  await waitPill(page, 'Code generated');
  assert.equal(await page.inputValue('#xp-version'), '3');
  await page.click('#xp-run');
  await waitPill(page, 'Results ready', 30000);
  const run3 = await latestRun(page);
  assert.equal(run3.version, 3);
  assert.equal(run3.status, 'succeeded');
  x = await experiment(page);
  assert.equal(x.experiment.versions.find(v => v.version === 3).parent, 2);

  // Unsaved edits: switching versions asks first (Cancel keeps them); Reset drops them
  await page.click('#xp-editor .cm-content');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('// not saved');
  await page.waitForSelector('#xp-dirty:not([hidden])');
  await page.selectOption('#xp-version', '2');
  await page.waitForSelector('#modal-title:has-text("Discard your edits?")');
  await page.click('#lab-c-no');
  assert.equal(await page.inputValue('#xp-version'), '3');
  assert.match(await editorText(page), /\/\/ not saved/);
  await page.click('#xp-reset');
  await page.waitForSelector('#xp-dirty[hidden]', { state: 'attached' });
  await waitPill(page, 'Results ready');

  // Compare v2 → v3: the diff, both runs' metrics and the records that changed
  await page.click('#xp-compare');
  await page.waitForFunction(() => location.hash.endsWith('/compare/2/3'));
  await page.waitForSelector('#xp-merge .cm-mergeView');
  await waitPill(page, 'Comparing versions');
  const cmp = (await api(page, '/experiments/' + id + '/compare?a=2&b=3')).body;
  assert.equal(cmp.a.run.id, run2.id);
  assert.equal(cmp.b.run.id, run3.id);
  assert.ok(cmp.comparison.counts.changed >= 2);
  await page.waitForSelector('#xp-cmp-changed table');
  assert.match(await page.textContent('#xp-cmp-changed'), new RegExp(cmp.comparison.counts.changed + ' records coded differently · ' + cmp.comparison.counts.fixed + ' fixed'));
  assert.equal(await page.$$eval('#xp-cmp-changed tbody tr', l => l.length), cmp.comparison.counts.changed);
  const accRow = await page.$$eval('.xp-cmp-table tbody tr', rows => rows.map(r => Array.from(r.children).map(c => c.textContent)).find(c => c[0] === 'Held-out accuracy'));
  assert.ok(accRow && /%/.test(accRow[1]) && /%/.test(accRow[2]), 'both runs\' held-out accuracy');
  assert.match(await page.textContent('.xp-compare-view'), /Ran without errors ≠ better/);
  await page.click('text=Back to the workspace');
  await page.waitForSelector('#xp-editor .cm-editor');
  await waitPill(page, 'Results ready');

  // AI evaluation of v3: the sections, labelled as an interpretation
  await page.click('#xp-tab-eval');
  await page.click('#xp-evaluate');
  await page.waitForSelector('#xp-eval-out .xp-eval-head', { timeout: 20000 });
  const evalText = await page.textContent('#xp-eval-out');
  for (const h of ['Proposed improvement', 'Reasoning', 'Observed results', 'Comparison', 'Trade-offs', 'Limitations', 'Recommendation']) assert.ok(evalText.includes(h), h);
  assert.match(evalText, /AI interpretation — check it against the measured numbers/);
  x = await experiment(page);
  assert.equal(x.experiment.versions.find(v => v.version === 3).evaluation.runId, run3.id);

  // The final version, with a rationale
  await page.click('#xp-tab-final');
  await page.fill('#xp-rationale', 'Best held-out score, no errors');
  await page.click('#xp-select');
  await waitPill(page, 'Final version selected');
  assert.match(await page.textContent('#xp-final-badge'), /Final: v3/);
  x = await experiment(page);
  assert.deepEqual([x.experiment.selected.version, x.experiment.selected.runId, x.experiment.selected.rationale], [3, run3.id, 'Best held-out score, no errors']);
  const codeHash = x.experiment.selected.codeHash;
  // A send is one send of this selection: its key names the version, the code, the run and when it was selected
  const key3 = [id, 3, codeHash, run3.id, x.experiment.selected.selectedAt].join(':');

  // Send to Codebook: the app opens in a new tab of this browser (same storage). The signed-in
  // account hasn't seen this browser's work yet, so it asks first — once — and only then does the
  // coding-rule confirmation appear (no stacked dialogs; neither answer is lost).
  const appP = context.waitForEvent('page', { timeout: 15000 });
  await page.click('#xp-send');
  const app = await appP;
  await app.waitForURL(/\/app\.html#codebook\/lab\/cbs_[A-Za-z0-9_-]{16}$/);
  await app.waitForSelector('.acct-overlay h2:has-text("Add this browser\'s work to your account?")', { timeout: 20000 });
  await waitPill(page, 'Sending to Codebook…');
  await app.waitForTimeout(1500);   // (Account reports the sign-in more than once: no second question)
  assert.equal(await app.$$eval('.acct-overlay', l => l.length), 1);
  assert.equal(await app.$('#lh-save'), null, 'the confirmation waits for the account question');
  await app.click('.acct-overlay button:has-text("Add to my account")');
  await app.waitForSelector('#lh-save', { timeout: 15000 });
  assert.match(await app.textContent('#lh-version'), /v3 of “Stance rule”/);
  assert.match(await app.textContent('#lh-change'), /^New rule/);
  assert.equal(await app.textContent('#lh-code'), (await experiment(page)).experiment.versions.find(v => v.version === 3).code);
  await app.click('#lh-save');
  await waitPill(page, 'Saved to Codebook');
  assert.match(await page.textContent('#xp-send-status'), /Saved to the Codebook \(variable “Stance”\)/);
  const dialogs = await app.evaluate(() => window.__dialogs);
  assert.deepEqual(dialogs.map(d => d.kind), ['account', 'handoff'], JSON.stringify(dialogs));
  assert.equal(dialogs[0].handoffOpen, false);
  assert.equal(dialogs[1].accountOpen, false);
  // The app's Codebook shows the rule on "stance"; App state has exactly the selected code
  await app.waitForSelector('.cr-panel[data-dim="stance"] .cr-head:has-text("v3")');
  const rule = await app.evaluate(() => App.getState().codebook.find(d => d.id === 'stance').codingRule);
  assert.equal(rule.version, 3);
  assert.equal(rule.codeHash, codeHash);
  assert.equal(rule.experiment.id, id);
  // The run covered all records; its accuracy is the held-out one, and the Codebook says so
  assert.deepEqual([rule.evaluation.split, rule.evaluation.referenceSplit], ['all', 'test']);
  assert.equal(rule.evaluation.accuracy, run3.metrics.reference.test.accuracy);
  assert.equal(rule.evaluation.referenceN, run3.metrics.reference.test.n);
  assert.match(await app.textContent('.cr-panel[data-dim="stance"] [data-metric="accuracy"]'), new RegExp('Held-out accuracy n = ' + run3.metrics.reference.test.n));
  x = await experiment(page);
  assert.equal(x.experiment.submissions.length, 1);
  const sub = x.experiment.submissions[0];
  assert.equal(sub.status, 'applied');
  assert.equal(sub.dimensionId, 'stance');
  assert.equal(sub.idempotencyKey, key3);
  assert.equal(rule.submissionId, sub.id);
  // "Add to my account" was kept too: the open project, with the rule, reaches the account
  const t0 = Date.now();
  let synced = null;
  while (!synced && Date.now() - t0 < 20000) {
    const row = sb.rows.find(r => r.kind === 'workspace' && r.id === 'current');
    const dim = row && row.data && Array.isArray(row.data.codebook) ? row.data.codebook.find(d => d.id === 'stance') : null;
    if (dim && dim.codingRule && dim.codingRule.submissionId === sub.id) synced = dim;
    else await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(synced, 'the open project with the coding rule was saved to the account');

  // Sending again: the same submission (same key) is delivered to the app again — it already has it and says so,
  // without asking — and nothing is added anywhere
  await page.click('#xp-send');
  await waitPill(page, 'Saved to Codebook');
  const again = await api(page, '/experiments/' + id + '/codebook', 'POST', { idempotencyKey: key3 });
  assert.equal(again.status, 200);
  assert.equal(again.body.submission.id, sub.id);
  assert.equal(again.body.submission.status, 'applied');
  assert.ok(again.body.submission.resentAt, 'the click sent it to the app again');
  x = await experiment(page);
  assert.equal(x.experiment.submissions.length, 1);
  // …and the app applying it again changes nothing (no history entry)
  await app.evaluate(sid => { location.hash = '#codebook/lab/' + sid; }, sub.id);
  await app.waitForFunction(() => location.hash === '#codebook');
  const dim = await app.evaluate(() => App.getState().codebook.find(d => d.id === 'stance'));
  assert.equal(dim.codingRule.submissionId, sub.id);
  assert.equal((dim.codingRuleHistory || []).length, 0);
  assert.equal(await app.$$eval('.acct-overlay', l => l.length), 0);

  // Removed in the Codebook ("…so you can send it to the Codebook again"), then sent again: the app asks again,
  // and the Lab waits for that answer (an earlier "applied" doesn't count)
  await app.click('#dim-stance .cr-remove');
  await app.click('#cr-remove-confirm');
  await app.waitForFunction(() => !App.getState().codebook.find(d => d.id === 'stance').codingRule);
  await page.click('#xp-send');
  await app.waitForSelector('#lh-save', { timeout: 15000 });
  assert.match(await app.textContent('#lh-change'), /^New rule/);
  await page.waitForTimeout(2500);   // (longer than the Lab's 2 s look at the submission)
  assert.equal(await pill(page), 'Sending to Codebook…');
  assert.match(await page.textContent('#xp-send-status'), /Switch to your MetaCode tab to confirm/);
  await app.click('#lh-save');
  await waitPill(page, 'Saved to Codebook');
  assert.equal((await app.evaluate(() => App.getState().codebook.find(d => d.id === 'stance').codingRule)).submissionId, sub.id);
  x = await experiment(page);
  assert.deepEqual(x.experiment.submissions.map(s => [s.id, s.status]), [[sub.id, 'applied']]);

  // Selected again with another reason: a new send (its own key) with the new selection, asked in the app
  await page.click('#xp-unselect');
  await page.click('#lab-c-yes');
  await page.fill('#xp-rationale', 'Best held-out score, checked twice');
  await page.click('#xp-select');
  await waitPill(page, 'Final version selected');
  await page.click('#xp-send');
  await app.waitForSelector('#lh-save', { timeout: 15000 });
  assert.equal(await app.textContent('#lh-rationale'), 'Best held-out score, checked twice');
  await app.click('#lh-save');
  await waitPill(page, 'Saved to Codebook');
  x = await experiment(page);
  assert.equal(x.experiment.submissions.length, 2);
  const sub2 = x.experiment.submissions[1];
  assert.notEqual(sub2.id, sub.id);
  assert.equal(sub2.idempotencyKey, [id, 3, codeHash, run3.id, x.experiment.selected.selectedAt].join(':'));
  assert.equal(sub2.status, 'applied');
  const rule2 = await app.evaluate(() => App.getState().codebook.find(d => d.id === 'stance').codingRule);
  assert.deepEqual([rule2.submissionId, rule2.rationale], [sub2.id, 'Best held-out score, checked twice']);

  // Another final version, sent while the app tab is open: it answers on the channel and asks there
  await page.selectOption('#xp-version', '2');
  await waitPill(page, 'Run succeeded');   // (on the Finalize tab: "Results ready" once Preview or Metrics shows them)
  await page.click('#xp-tab-final');
  await page.fill('#xp-rationale', 'Fewer codes for very short posts');
  await page.click('#xp-select');
  await waitPill(page, 'Final version selected');
  await page.click('#xp-send');
  await page.waitForSelector('#xp-send-status:has-text("Switch to your MetaCode tab to confirm")', { timeout: 10000 });
  await app.waitForSelector('#lh-save', { timeout: 15000 });
  assert.match(await app.textContent('#lh-change'), /^Replaces v3/);
  await app.click('#lh-save');
  await waitPill(page, 'Saved to Codebook');
  const dim2 = await app.evaluate(() => App.getState().codebook.find(d => d.id === 'stance'));
  assert.equal(dim2.codingRule.version, 2);
  assert.equal(dim2.codingRule.code, edited);
  assert.deepEqual(dim2.codingRuleHistory.map(h => [h.version, h.submissionId]), [[3, sub2.id], [3, sub.id]]);
  x = await experiment(page);
  assert.deepEqual(x.experiment.submissions.map(s => [s.version, s.status]), [[3, 'applied'], [3, 'applied'], [2, 'applied']]);
  assert.equal(context.pages().length, 2, 'no further app tab was opened');

  assert.deepEqual(errors, []);
  await context.close();
});

test('Code Experiments: blocked, syntax error, endless loop, timeout, invalid output, unsaved edits', { skip, timeout: 120000 }, async () => {
  const { context, page, errors } = await newContext();
  await signIn(page, 'ultra2@example.org', 'ultra password 2');
  await createExperiment(page);
  const id = await expId(page);

  // A network-flooding script: blocked with the reasons, Run disabled, nothing executes
  await generate(page, '#xp-generate', 'Write a script that floods the server with requests');
  await waitPill(page, 'Blocked — see the review');
  assert.equal(await page.isDisabled('#xp-run'), true);
  await page.waitForSelector('#xp-validation h4:has-text("Policy checks") .badge:has-text("blocked")');
  await page.waitForSelector('#xp-validation h4:has-text("AI security review") .badge:has-text("rejected")');
  const val = await page.textContent('#xp-validation');
  assert.match(val, /forbidden_global/);
  assert.match(val, /fetch/);
  assert.match(val, /infinite_loop/);
  assert.match(val, /network/i);
  let x = await experiment(page);
  const flood = x.experiment.versions[0];
  assert.equal(flood.policy.ok, false);
  assert.equal(flood.review.decision, 'rejected');
  // Even asked directly, the server runs nothing: blocked at the review, never in the sandbox
  const forced = await api(page, '/experiments/' + id + '/runs', 'POST', { version: 1, codeHash: flood.codeHash, split: 'all' });
  assert.equal(forced.status, 202);
  const blockedRun = await runOf(page, forced.body.run.id);
  assert.equal(blockedRun.status, 'blocked');
  assert.equal(blockedRun.failure.type, 'review_rejected');
  assert.equal(blockedRun.isolation, null);
  assert.equal(blockedRun.resources, null);
  assert.ok(!blockedRun.log.some(l => l.stage === 'execution'), 'no line from the execution stage');
  // (the workspace shows that run too)
  await page.evaluate(() => Lab.route());
  await page.waitForSelector('#xp-editor .cm-editor');
  await page.waitForFunction(() => /^Blocked at review/.test(document.getElementById('xp-term-status').textContent));
  await waitPill(page, 'Blocked — see the review');

  // A syntax error typed by the user: Save & run → blocked by the policy, the finding on its line
  await setCode(page, 'function classify(record, variable) {\n  const t = record.text.toLowerCase();\n  if (t.includes("support") {\n    return "pos";\n  }\n  return null;\n}\n');
  await waitPill(page, 'Edited — save to run');
  assert.equal(await page.textContent('#xp-run'), 'Save & run');
  await page.click('#xp-run');
  await waitPill(page, 'Blocked — see the review', 20000);
  assert.equal(await page.inputValue('#xp-version'), '2');
  await page.waitForSelector('#xp-validation .xp-find-error:has-text("syntax") button:has-text("line 3")');
  let r = await latestRun(page);
  assert.equal(r.version, 2);
  assert.equal(r.status, 'blocked');
  assert.equal(r.failure.type, 'policy_blocked');
  assert.ok(!r.log.some(l => l.stage === 'execution'));
  x = await experiment(page);
  const syn = x.experiment.versions.find(v => v.version === 2).policy.findings.find(f => f.rule === 'syntax');
  assert.equal(syn.line, 3);
  assert.match(await page.textContent('#xp-term-body'), /line 3: /);
  // Check shows the same finding
  await page.click('#xp-check');
  await page.waitForSelector('#xp-validation .xp-find-error:has-text("syntax") button:has-text("line 3")');

  // A loop with its break: passes the checks; with the break removed: blocked as an endless loop
  const looped = brk => 'function classify(record, variable) {\n  let i = 0;\n  while (true) {\n    i++;\n' + (brk ? '    if (i > 3) break;\n' : '') + '  }\n  return "neu";\n}\n';
  await setCode(page, looped(true));
  await page.click('#xp-save');
  await page.waitForFunction(() => document.getElementById('xp-version').value === '3');
  await page.click('#xp-check');
  await page.waitForSelector('#xp-validation h4:has-text("Policy checks") .badge:has-text("passed")');
  await waitPill(page, 'Ready to run');
  await setCode(page, looped(false));
  await page.click('#xp-run');
  await page.waitForFunction(() => document.getElementById('xp-version').value === '4');
  await waitPill(page, 'Blocked — see the review', 20000);
  await page.waitForSelector('#xp-validation .xp-find-error:has-text("infinite_loop") button:has-text("line 3")');
  r = await latestRun(page);
  assert.equal(r.version, 4);
  assert.equal(r.status, 'blocked');
  assert.equal(r.failure.type, 'policy_blocked');
  assert.ok(!r.log.some(l => l.stage === 'execution'));

  // A long, finite busy-wait (30 s). Cancelled at once: the run stops and the workspace follows it…
  await setCode(page, 'function classify(record, variable) {\n  const end = Date.now() + 30000;\n  while (Date.now() < end) { /* wait */ }\n  return "neu";\n}\n');
  await page.click('#xp-run');
  await page.waitForSelector('#xp-cancel:not([hidden])');
  await page.click('#xp-cancel');
  await page.waitForFunction(() => document.getElementById('xp-term-status').textContent === 'Cancelled', null, { timeout: 15000 });
  await waitPill(page, 'Run cancelled', 10000);
  r = await latestRun(page);
  assert.equal(r.version, 5);
  assert.equal(r.status, 'cancelled');
  assert.match(await page.$eval('#xp-version', s => s.selectedOptions[0].textContent), /^v5 · User-edited · cancelled/);
  // …run again against the 2 s limit: it fails with the timeout…
  await page.click('#xp-rerun');
  await page.waitForFunction(id => { const o = document.querySelector('#xp-run-pick option:checked'); return o && o.value !== id; }, r.id);
  await waitPill(page, 'Run failed', 30000);
  assert.match(await page.textContent('#xp-term-status'), /^Failed at execution: .*(time|limit)/i);
  r = await latestRun(page);
  assert.equal(r.version, 5);
  assert.equal(r.status, 'failed');
  assert.equal(r.failure.type, 'timeout');
  assert.ok(r.log.some(l => l.stage === 'execution'));
  // …and the workspace still works: edit, run again
  await setCode(page, 'function classify(record, variable) {\n  return /support/i.test(record.text) ? "pos" : null;\n}\n');
  await page.click('#xp-run');
  await waitPill(page, 'Results ready', 30000);
  r = await latestRun(page);
  assert.equal(r.version, 6);
  assert.equal(r.status, 'succeeded');
  await page.waitForSelector('#xp-preview .xp-rec');

  // Output with an unknown code: the run fails at output validation; the preview shows no results from it
  await setCode(page, 'function classify(record, variable) {\n  return { code: "maybe", confidence: 0.5 };\n}\n');
  await page.click('#xp-run');
  await waitPill(page, 'Run failed', 30000);
  assert.match(await page.textContent('#xp-term-status'), /^Failed at output: /);
  assert.match(await page.textContent('#xp-term-body'), /unknown code|isn.t one of|not a code/i);
  await page.click('#xp-tab-preview');
  await page.waitForSelector('#xp-preview h3:has-text("This run has no results")');
  assert.equal(await page.$$eval('#xp-preview .xp-rec', l => l.length), 0);
  r = await latestRun(page);
  assert.equal(r.version, 7);
  assert.equal(r.status, 'failed');
  assert.equal(r.stage, 'output');
  assert.equal(r.failure.type, 'output_invalid');
  assert.equal(r.output.valid, false);
  assert.equal((await api(page, '/xruns/' + r.id + '/results')).status, 409);

  // Unsaved edits: Run becomes Save & run; switching versions asks, and discarding loads that version
  await page.click('#xp-editor .cm-content');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('// draft');
  await waitPill(page, 'Edited — save to run');
  assert.equal(await page.textContent('#xp-run'), 'Save & run');
  await page.selectOption('#xp-version', '6');
  await page.waitForSelector('#modal-title:has-text("Discard your edits?")');
  await page.click('#lab-c-yes');
  await page.waitForFunction(() => document.getElementById('xp-version').value === '6');
  await page.waitForSelector('#xp-dirty[hidden]', { state: 'attached' });
  assert.doesNotMatch(await editorText(page), /\/\/ draft/);
  assert.equal(await page.textContent('#xp-run'), 'Run');
  await waitPill(page, 'Results ready');
  x = await experiment(page);
  assert.equal(x.experiment.versions.length, 7, 'no version was saved for the discarded draft');

  // One short Python run: the language changes in the editor, Save & run, its policy checked inside the sandbox
  if (pySupport.ok) {
    await page.selectOption('#xp-lang', 'python');
    await setCode(page, 'import re\n\ndef classify(record, variable):\n    print("checking", record["id"])\n    return "pos" if re.search(r"support", record["text"], re.I) else None\n');
    assert.equal(await page.textContent('#xp-run'), 'Save & run');
    await page.click('#xp-run');
    await waitPill(page, 'Results ready', 60000);
    r = await latestRun(page);
    assert.deepEqual([r.version, r.language, r.status, r.security.policy.engine], [8, 'python', 'succeeded', 'python-ast']);
    const py = await page.textContent('#xp-term-body');
    assert.match(py, /passed inside the sandbox before your code ran/);
    assert.match(py, /> checking p1/);
  }

  // A rule the AI review wants a person to read (it uses randomness): Save & run is blocked at the review.
  // Once allowed, the pill says it is ready to run, like the Run button
  await page.selectOption('#xp-lang', 'javascript');
  await setCode(page, 'function classify(record, variable) {\n  const jitter = Math.random() * 0;\n  return /support/i.test(record.text) ? "pos" : null;\n}\n');
  await page.click('#xp-run');
  await waitPill(page, 'Blocked — see the review', 20000);
  r = await latestRun(page);
  assert.deepEqual([r.status, r.failure.type], ['blocked', 'review_required']);
  assert.equal(await page.isDisabled('#xp-run'), true);
  await page.click('#xp-ack');
  await waitPill(page, 'Ready to run');
  assert.equal(await page.isDisabled('#xp-run'), false);
  await page.waitForSelector('#xp-validation .badge:has-text("you allowed running")');
  await page.click('#xp-run');
  await waitPill(page, 'Results ready', 30000);
  r = await latestRun(page);
  assert.deepEqual([r.status, r.security.acknowledged], ['succeeded', true]);
  const rndVersion = await page.inputValue('#xp-version');
  const rndRun = r.id;

  // New success criteria: the objective score is recomputed with them and agrees with its parts
  await page.click('#xp-tab-metrics');
  await page.waitForSelector('#xp-metrics .xp-score b');
  const scoreBefore = await page.textContent('#xp-metrics .xp-score b');
  assert.notEqual(scoreBefore, '1.00');
  await page.click('#xp-context > summary');
  await page.click('#xp-criteria .xp-crit-row:nth-child(3) [data-cdel]');
  await page.click('#xp-criteria .xp-crit-row:nth-child(2) [data-cdel]');
  await page.selectOption('#xp-criteria .xp-crit-row [data-cm]', 'errorRate');
  await page.fill('#xp-criteria .xp-crit-row [data-cw]', '1');
  await page.click('#xp-criteria-save');
  await page.waitForFunction(() => { const rows = document.querySelectorAll('#xp-metrics .xp-score + .table-wrap tbody tr'); return rows.length === 1 && /^Error rate/.test(rows[0].textContent); });
  const parts = await page.$$eval('#xp-metrics .xp-score + .table-wrap tbody tr', rows => rows.map(row => Array.from(row.children).map(c => c.textContent)));
  assert.deepEqual(parts, [['Error rate', '1', '1.00', 'used']]);
  assert.equal(await page.textContent('#xp-metrics .xp-score b'), '1.00');
  assert.equal((await experiment(page)).runs.find(x => x.id === rndRun).score, 1, 'the server scores it the same way');

  // A run that ends while another version is shown: the workspace follows it (pill, buttons, version list)
  const slow = 'function classify(record, variable) {\n  const end = Date.now() + 30000;\n  while (Date.now() < end) { /* wait */ }\n  return "pos";\n}\n';
  await setCode(page, slow);
  await page.click('#xp-run');
  await inExecution(page);
  const slowVersion = await page.inputValue('#xp-version');
  const slowRun = (await experiment(page)).runs[0];
  assert.deepEqual([String(slowRun.version), TERMINAL.includes(slowRun.status)], [slowVersion, false]);
  await page.selectOption('#xp-version', rndVersion);
  await page.waitForFunction(id => document.getElementById('xp-run-pick').value === id, rndRun);
  assert.equal(await pill(page), 'Running…');
  assert.equal((await runOf(page, slowRun.id)).status, 'failed');   // (the 2 s limit)
  await waitPill(page, 'Results ready', 8000);
  assert.equal(await page.isDisabled('#xp-run'), false);
  assert.equal(await page.isDisabled('#xp-generate'), false);
  assert.equal(await page.isHidden('#xp-cancel'), true);
  assert.match(await page.$eval('#xp-version option[value="' + slowVersion + '"]', o => o.textContent), /✗ failed/);
  // …and while another run is picked in the terminal
  await page.selectOption('#xp-run-pick', slowRun.id);
  await page.click('#xp-rerun');
  await inExecution(page);
  const rerun = (await experiment(page)).runs[0];
  assert.notEqual(rerun.id, slowRun.id);
  await page.selectOption('#xp-run-pick', rndRun);
  assert.equal(await pill(page), 'Running…');
  assert.equal((await runOf(page, rerun.id)).status, 'failed');
  await waitPill(page, 'Results ready', 8000);
  assert.equal(await page.isDisabled('#xp-run'), false);
  assert.equal(await page.isHidden('#xp-cancel'), true);

  assert.deepEqual(errors, []);
  await context.close();
});

test('Code Experiments: the Models page shows what runs here; a language the server can\'t run is disabled with its reason', { skip, timeout: 90000 }, async () => {
  const { context, page, errors } = await newContext();
  await signIn(page, 'ultra2@example.org', 'ultra password 2');
  const LABEL = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python' };

  // The server's own report
  const real = (await api(page, '/models')).body.execution;
  await page.click('#lab-nav [data-view=models]');
  await page.waitForSelector('#md-exec');
  assert.equal(await page.textContent('#md-exec-mode'), real.mode === 'sandbox' ? 'On: in the isolated sandbox, only when you click Run' : 'Off');
  assert.equal(await page.textContent('#md-exec-langs'), real.languages.map(l => LABEL[l]).join(', ') || 'none');
  if (real.isolation) {
    const iso = await page.textContent('#md-exec-isolation');
    assert.ok(iso.includes(real.isolation.network) && iso.includes(real.isolation.limits), iso);
    assert.match(iso, new RegExp('Network namespace: ' + (real.isolation.networkNamespace ? 'yes' : 'no')));
  }
  assert.match(await page.textContent('#md-exec-limits'), new RegExp('per run · ' + real.limits.memoryMb + ' MB memory \\(Python ' + real.limits.pythonMemoryMb + ' MB\\)'));
  assert.equal(await page.$('#md-exec-unavailable'), null);

  // As on Node 22.13–22.14 (Python can't run) with a mistyped setting: the page shows what /models says
  const reason = 'Python coding rules need Node.js 22.15 or newer (this server runs Node.js 22.13.0).';
  const warning = 'AI_LAB_SANDBOX_ISOLATION="nmespace" isn\'t auto, namespace or process: using namespace.';
  let off = false;
  await page.route('**/api/lab/models', async route => {
    const res = await route.fetch();
    const body = await res.json();
    Object.assign(body.execution, { languages: body.execution.languages.filter(l => l !== 'python'), unavailable: [{ language: 'python', reason }], warnings: [warning] });
    if (off) { body.codeExecution = 'off'; Object.assign(body.execution, { mode: 'off', isolation: null }); }
    await route.fulfill({ response: res, json: body });
  });
  await page.click('#md-refresh');
  await page.waitForSelector('#md-exec-unavailable');
  assert.equal(await page.textContent('#md-exec-unavailable li'), 'Python: ' + reason);
  assert.equal(await page.textContent('#md-exec-warnings li'), warning);
  assert.doesNotMatch(await page.textContent('#md-exec-langs'), /Python/);

  // The new-experiment form: Python is there but disabled, with the reason; a Codebook rule in Python still picks it, and says why it can't run
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('strata_v1'));
    s.codebook.find(d => d.id === 'stance').codingRule = { code: 'def classify(record, variable):\n    return None\n', language: 'python', version: 2 };
    localStorage.setItem('strata_v1', JSON.stringify(s));
  });
  await page.click('#lab-nav [data-view=experiments]');
  await page.click('#xp-new');
  await page.waitForSelector('#xp-f-lang');
  assert.deepEqual(await page.$$eval('#xp-f-lang option', os => os.map(o => [o.value, o.disabled, o.title])), [['javascript', false, ''], ['python', true, reason], ['typescript', false, '']]);
  assert.match(await page.textContent('#xp-f-lang option[value=python]'), /can't run here/);
  assert.equal(await page.inputValue('#xp-f-lang'), 'javascript');
  assert.equal(await page.textContent('#xp-f-lang-why'), 'Can\'t run here: Python — ' + reason);
  await page.check('#xp-new-form label.xp-var:has-text("Stance") input');
  assert.equal(await page.isChecked('#xp-f-fromrule'), true);
  assert.equal(await page.inputValue('#xp-f-lang'), 'python');
  assert.match(await page.textContent('#xp-f-lang-na'), new RegExp('^Python can\'t run on this server: ' + reason.replace(/[.()]/g, '\\$&')));
  await page.click('#xp-create');
  await page.waitForSelector('#xp-editor .cm-editor', { timeout: 8000 });
  // The workspace: the notice, the editor's language select, and Run says why
  assert.match(await page.textContent('#xp-lang-na'), /^Python can't run on this server: /);
  assert.equal(await page.$eval('#xp-lang option[value=python]', o => o.disabled), true);
  assert.equal(await page.isDisabled('#xp-run'), true);
  assert.equal(await page.getAttribute('#xp-run', 'title'), reason);

  // Running code switched off: said plainly, without claiming how the server is configured
  await page.route(/\/api\/lab\/experiments\/[^/?]+$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    body.execution = { mode: 'off' };
    await route.fulfill({ response: res, json: body });
  });
  await page.evaluate(() => Lab.route());
  await page.waitForSelector('#xp-off');
  const notice = await page.textContent('#xp-off');
  assert.match(notice, /^Running code is switched off on this server\. You can still write/);
  assert.doesNotMatch(notice, /AI_LAB_CODE_EXECUTION|=off/);
  assert.equal(await page.isDisabled('#xp-run'), true);
  off = true;
  await page.click('#lab-nav [data-view=models]');
  await page.waitForSelector('#md-exec-off');
  assert.equal(await page.textContent('#md-exec-mode'), 'Off');
  await page.click('#lab-nav [data-view=experiments]');
  await page.click('#xp-new');
  await page.waitForSelector('#xp-f-off');

  assert.deepEqual(errors, []);
  await context.close();
});
