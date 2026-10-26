// Code experiments in the AI Coding Lab, against the real server: sandbox data
// → experiment → AI generation (mock) → policy and AI review stored → run in
// the real sandbox (JavaScript in QuickJS; one Python run in Pyodide) →
// metrics → results → edit → second run → compare → evaluation (numbers
// checked) → final selection → Codebook submission (idempotent) → result.
// Blocked flows (policy, review rejected, review needing acknowledgement),
// stale code, one run at a time, invalid output, cancel, deleting while a run
// is going, cross-user isolation, export and delete-all, plans and limits.
// Supabase, Stripe and the AI service are local mocks (test/helpers): these
// tests prove MetaCode's own code paths, not any provider's behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mockSupabase, mockStripe } = require('./helpers/account-mocks');
const { testEnv } = require('./helpers/harness');
const { startAiService } = require('./helpers/lab-mocks');
const { createCodeSandbox } = require('../ai-lab/code-sandbox');
const { LabStore } = require('../ai-lab/store');
const CP = require('../ai-lab/code-policy');
const C = require('../ai-lab/checks');
const CodingRule = require('../public/js/coding-rule.js');

const KEY = 'sb_publishable_LabExperiments_0123456789';
const probe = createCodeSandbox({ getConfig: () => ({}) });
const jsSupport = probe.supported('javascript');
const pySupport = probe.supported('python');
const tsSupport = probe.supported('typescript');
const skipJs = !jsSupport.ok && jsSupport.reason;
const skipPy = skipJs || (!pySupport.ok && pySupport.reason);
const skipTs = skipJs || (!tsSupport.ok && tsSupport.reason);
const TERMINAL = ['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'];

let sb, stripe, aiService, server, base, tmp, srv;
const U = {}, T = {};
const aiState = { requests: [], streamDelayMs: 0, fail: false };
const ctx = {};

// The variable and 30 posts: 10 "support", 10 "oppose", 5 "neutral", 5 with no keyword
// (their human label is neutral, so a keyword rule without "opinion" gets them wrong)
const VARIABLE = { id: 'stance', name: 'Stance', description: 'The post\'s position on the plan', codes: [
  { id: 'support', label: 'Support', description: 'For the plan' },
  { id: 'oppose', label: 'Oppose', description: 'Against the plan' },
  { id: 'neutral', label: 'Neutral', description: 'Neither' }] };
function makeRecords() {
  const out = [];
  for (let i = 1; i <= 30; i++) {
    let text, reference, baseline;
    if (i <= 10) { text = i <= 3 ? 'I support this plan.' : 'I support this plan, item ' + i + '.'; reference = 'support'; baseline = i === 10 ? 'neutral' : 'support'; }
    else if (i <= 20) { text = 'We oppose the plan, case ' + i + '.'; reference = 'oppose'; baseline = i >= 18 ? 'neutral' : 'oppose'; }
    else if (i <= 25) { text = 'Just neutral facts, number ' + i + '.'; reference = 'neutral'; baseline = 'neutral'; }
    else { text = 'No opinion here, entry ' + i + '.'; reference = 'neutral'; baseline = i === 30 ? null : 'support'; }
    out.push({ id: 'p' + i, text, author: 'user' + (i % 4), timestamp: '2026-10-0' + (1 + (i % 9)) + 'T10:00:00Z', meta: { platform: 'reddit', likes: i }, reference, referenceSource: 'adjudicated', baseline });
  }
  return out;
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-labx-'));
  sb = mockSupabase({ apikey: KEY });
  await sb.start();
  stripe = mockStripe({ key: 'sk_test_labx', products: {
    prod_VQeJh2lPqfmae9: { id: 'prod_VQeJh2lPqfmae9', active: true, default_price: 'price_pro' },
    prod_VQeK26tKchu1VI: { id: 'prod_VQeK26tKchu1VI', active: true, default_price: 'price_max' },
    prod_VQeKXAJtQQLKqm: { id: 'prod_VQeKXAJtQQLKqm', active: true, default_price: 'price_ultra' } } });
  await stripe.start();
  aiService = await startAiService(aiState);
  for (const who of ['ultra', 'ultra2', 'ultra3', 'free', 'admin']) { U[who] = sb.addUser(who + '@example.org', 'pw-' + who); T[who] = sb.issue(U[who]).access_token; }
  for (const who of ['ultra', 'ultra2', 'ultra3']) stripe.subscribe(U[who].id, 'prod_VQeKXAJtQQLKqm');
  Object.assign(process.env, testEnv({
    SUPABASE_URL: sb.url, SUPABASE_PUBLISHABLE_KEY: KEY, STRIPE_SECRET_KEY: 'sk_test_labx', STRIPE_API_BASE: stripe.url,
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    AI_LAB_DATA_DIR: path.join(tmp, 'lab'), AI_LAB_PRICING_FILE: path.join(tmp, 'none.json'), ADMIN_EMAILS: 'admin@example.org',
    OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + aiService.address().port + '/v1', OPENCODE_SERVICE_TOKEN: 'test-service-token-0123456789',
    OPENCODE_MODEL: 'lab-model', AI_MODEL_SWITCH: 'off' }));
  srv = require('../server');
  server = await srv.start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (aiService) { aiService.closeAllConnections(); await new Promise(r => aiService.close(r)); }
  if (sb) await sb.close();
  if (stripe) await stripe.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function api(method, p, who, body) {
  const headers = who ? { Cookie: 'mc_session=' + T[who] } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, json, text };
}
const as = who => ({
  get: p => api('GET', p, who),
  post: (p, b) => api('POST', p, who, b === undefined ? {} : b),
  patch: (p, b) => api('PATCH', p, who, b),
  del: (p, b) => api('DELETE', p, who, b)
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 30000);
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('timed out waiting');
}
const xp = id => '/api/lab/experiments/' + id;
async function waitRun(who, runId) {
  return until(async () => { const r = await as(who).get('/api/lab/xruns/' + runId); assert.equal(r.status, 200, r.text); return TERMINAL.includes(r.json.run.status) ? r.json.run : null; }, 60000);
}
async function runVersion(who, expId, ver, split) {
  const r = await as(who).post(xp(expId) + '/runs', { version: ver.version, codeHash: ver.codeHash, split: split || 'all' });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.run.status, 'queued');
  return waitRun(who, r.json.run.id);
}
async function generate(who, expId, prompt, extra) {
  const r = await as(who).post(xp(expId) + '/generate', Object.assign({ prompt, mode: 'new' }, extra || {}));
  assert.equal(r.status, 201, r.text);
  return r.json.version;
}
async function newExperiment(who, sandboxId, body) {
  const r = await as(who).post('/api/lab/experiments', Object.assign({ name: 'Stance rule', sandboxId, language: 'javascript' }, body || {}));
  assert.equal(r.status, 201, r.text);
  return r.json.experiment;
}
async function importSandbox(who) {
  const r = await as(who).post('/api/lab/sandboxes/import', { name: 'Stance posts', source: { kind: 'project', projectName: 'Plan study' }, variable: VARIABLE, records: makeRecords() });
  assert.equal(r.status, 201, r.text);
  return r.json.sandbox;
}
// A rule that loops until the time limit (written so the static policy can't see it)
const SLOW = 'function classify(record, variable) {\n  let n = 0;\n  for (let i = 0; i >= 0; i++) { n = n + 1; }\n  return null;\n}\n';
/** Every file under a folder (to prove nothing was written back after a delete). */
function filesUnder(dir) {
  let out = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of names) { const p = path.join(dir, d.name); out = out.concat(d.isDirectory() ? filesUnder(p) : [p]); }
  return out;
}

test('access and models report code execution; plans without the Lab get 402', async () => {
  const acc = await as('ultra').get('/api/lab/access');
  assert.equal(acc.json.codeExecution, 'sandbox');
  const models = await as('ultra').get('/api/lab/models');
  assert.equal(models.status, 200, models.text);
  assert.equal(models.json.codeExecution, 'sandbox');
  assert.equal(models.json.execution.mode, 'sandbox');
  assert.equal(models.json.execution.limits.timeoutMs, 15000);
  if (!skipJs) assert.ok(models.json.execution.languages.includes('javascript'));
  assert.ok(models.json.execution.isolation && typeof models.json.execution.isolation.networkNamespace === 'boolean');
  assert.ok(Array.isArray(models.json.execution.unavailable), 'unavailable: [{language, reason}]');
  models.json.execution.unavailable.forEach(x => { assert.equal(typeof x.language, 'string'); assert.match(x.reason, /\S/); });
  assert.deepEqual(models.json.execution.warnings, []);
  for (const [m, p] of [['GET', '/api/lab/experiments'], ['GET', '/api/lab/sandboxes'], ['POST', '/api/lab/sandboxes/import'], ['GET', '/api/lab/codebook-submissions/cbs_AAAAAAAAAAAAAAAA']]) {
    const r = await api(m, p, 'free', m === 'POST' ? {} : undefined);
    assert.equal(r.status, 402, m + ' ' + p);
    assert.equal(r.json.error.type, 'plan_required');
  }
  assert.equal((await api('GET', '/api/lab/experiments', null)).status, 401);
  const usage = await as('ultra').get('/api/lab/usage');
  assert.equal(usage.json.meters.labExecutions.limit, 500);
  assert.equal(usage.json.meters.labExecutions.period, 'day');
});

test('sandbox data: import with a report, pages of records, versions, from a dataset, delete', async () => {
  const me = as('ultra');
  const bad = makeRecords();
  bad.push({ id: 'bad id!', text: 'x' }, { id: 'p31', text: 'y'.repeat(20050), reference: 'maybe' });
  const r = await me.post('/api/lab/sandboxes/import', { name: 'Stance posts', source: { kind: 'project', projectName: 'Plan study' }, variable: VARIABLE, records: bad });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.report.accepted, 31);
  assert.equal(r.json.report.rejected, 1);
  assert.equal(r.json.report.truncated, 1);
  assert.ok(r.json.report.problems.some(p => /isn't a code/.test(p.problem)));
  const s = r.json.sandbox;
  assert.match(s.id, /^sbx_/);
  assert.equal(s.versions[0].count, 31);
  assert.equal(s.versions[0].referenceCount, 30);
  assert.equal(s.versions[0].devCount + s.versions[0].testCount, 31);
  assert.match(s.versions[0].sha256, /^[a-f0-9]{64}$/);
  const pageOne = await me.get('/api/lab/sandboxes/' + s.id + '?limit=10&offset=5');
  assert.equal(pageOne.json.total, 31);
  assert.equal(pageOne.json.records.length, 10);
  assert.ok(['dev', 'test'].includes(pageOne.json.records[0].split));
  const v2 = await me.post('/api/lab/sandboxes/' + s.id + '/import', { records: makeRecords().slice(0, 12) });
  assert.equal(v2.status, 200, v2.text);
  assert.equal(v2.json.sandbox.versions.length, 2);
  assert.equal((await me.get('/api/lab/sandboxes/' + s.id + '?version=2')).json.total, 12);
  assert.equal((await me.get('/api/lab/sandboxes/' + s.id + '?version=9')).status, 404);
  const list = await me.get('/api/lab/sandboxes');
  assert.ok(list.json.sandboxes.some(x => x.id === s.id));

  // In use: refused without force; with force the experiment goes too
  const e = await newExperiment('ultra', s.id);
  assert.equal(e.sandboxVersion, 2);
  const del = await me.del('/api/lab/sandboxes/' + s.id);
  assert.equal(del.status, 409);
  assert.equal(del.json.error.type, 'in_use');
  assert.equal((await me.del('/api/lab/sandboxes/' + s.id + '?force=1')).status, 200);
  assert.equal((await me.get(xp(e.id))).status, 404);
  assert.equal((await me.get('/api/lab/sandboxes/' + s.id)).status, 404);

  // From a frozen Training Studio dataset version
  const d = (await me.post('/api/lab/datasets', { name: 'Stance examples' })).json.dataset;
  for (const [i, exp] of [['1', 'support'], ['2', 'oppose'], ['3', 'something else']]) await me.post('/api/lab/datasets/' + d.id + '/examples', { example: { task: 'Code the stance', input: 'Post ' + i + ' says ' + exp, expected: exp } });
  assert.equal((await me.post('/api/lab/sandboxes/from-dataset', { datasetId: d.id, version: 1, variable: VARIABLE })).status, 404, 'only committed versions');
  assert.equal((await me.post('/api/lab/datasets/' + d.id + '/versions', { acceptErrors: true })).status, 200);
  const fd = await me.post('/api/lab/sandboxes/from-dataset', { datasetId: d.id, version: 1, variable: VARIABLE, name: 'From dataset' });
  assert.equal(fd.status, 201, fd.text);
  assert.equal(fd.json.sandbox.source.kind, 'dataset');
  assert.equal(fd.json.sandbox.versions[0].count, 3);
  assert.equal(fd.json.sandbox.versions[0].referenceCount, 2);
  assert.equal((await me.del('/api/lab/sandboxes/' + fd.json.sandbox.id)).status, 200);
});

test('full flow: generate → policy and review stored → run → metrics → results → edit → compare → evaluate → select → Codebook', { skip: skipJs }, async () => {
  const me = as('ultra');
  const s = await importSandbox('ultra');
  ctx.sandbox = s;
  const created = await me.post('/api/lab/experiments', { name: 'Stance rule', sandboxId: s.id, language: 'javascript', objective: { text: 'Code stance by keywords', criteria: [{ metric: 'accuracy', weight: 3 }, { metric: 'coverage', weight: 1 }] } });
  assert.equal(created.status, 201, created.text);
  const e = created.json.experiment;
  ctx.exp = e;
  assert.match(e.id, /^exp_/);
  assert.deepEqual(e.variable.codes.map(c => c.id), ['support', 'oppose', 'neutral']);
  assert.equal((await me.post(xp(e.id) + '/generate', { prompt: '   ' })).status, 400);
  assert.equal((await me.post(xp(e.id) + '/generate', { prompt: 'x'.repeat(4001) })).status, 400);

  // Generation: a new version with its policy and AI review stored
  const before = aiState.requests.length;
  const v1 = await generate('ultra', e.id, 'Code each post by the stance keyword it mentions');
  assert.equal(v1.version, 1);
  assert.equal(v1.origin, 'generated');
  assert.match(v1.codeHash, /^[a-f0-9]{64}$/);
  assert.match(v1.code, /function classify\(record, variable\)/);
  assert.ok(!/```/.test(v1.code), 'the markdown fence is removed');
  assert.equal(v1.policy.ok, true);
  assert.equal(v1.policy.engine, 'acorn');
  assert.equal(v1.review.decision, 'approved');
  assert.equal(v1.review.codeHash, v1.codeHash);
  assert.equal(v1.generation.mode, 'new');
  assert.equal(aiState.requests.length - before, 2, 'one generation, one review');
  const genReq = aiState.requests[before];
  const prompt = genReq.messages.map(m => m.content).join('\n');
  assert.match(prompt, /^You write coding rules for MetaCode\./);
  const sandbox = (await me.get('/api/lab/sandboxes/' + s.id + '?limit=100')).json.records;
  for (const r of sandbox.filter(x => x.split === 'test')) assert.ok(!prompt.includes('"id":"' + r.id + '"'), 'held-out record ' + r.id + ' never reaches a prompt');
  let exp = (await me.get(xp(e.id))).json.experiment;
  assert.deepEqual(exp.thread.map(m => m.role + ':' + m.kind), ['user:generate', 'assistant:generate']);
  assert.equal(exp.thread[1].version, 1);

  // Run v1 (all records)
  const run1 = await runVersion('ultra', e.id, v1);
  assert.equal(run1.status, 'succeeded', JSON.stringify(run1.failure));
  assert.equal(run1.stage, 'done');
  assert.equal(run1.sandbox.recordCount, 30);
  assert.equal(run1.sandbox.sha256, s.versions[0].sha256);
  assert.equal(run1.security.review.decision, 'approved');
  assert.equal(run1.security.policy.ok, true);
  assert.equal(run1.output.valid, true);
  assert.ok(run1.isolation && run1.isolation.engine.includes('QuickJS'));
  assert.equal(run1.engine.name, 'QuickJS (quickjs-emscripten)');
  assert.ok(run1.timing.startedAt && run1.timing.finishedAt && run1.timing.durationMs >= 0);
  const stages = new Set(run1.log.map(l => l.stage));
  for (const st of ['input', 'review', 'policy', 'execution', 'output', 'metrics']) assert.ok(stages.has(st), 'a line for stage ' + st);
  assert.ok(run1.log.every((l, i) => l.seq === i + 1), 'lines are numbered in order');
  const texts = makeRecords().map(r => r.text);
  assert.ok(run1.log.filter(l => l.stream === 'system').every(l => !texts.some(t => l.text.includes(t))), 'no record text in system lines');
  assert.match(run1.log[run1.log.length - 1].text, /^Coded 25\/30 · coverage 83\.3% · errors 0/);
  const m1 = run1.metrics;
  assert.equal(m1.processed, 30);
  assert.equal(m1.errors, 0);
  assert.equal(m1.coverage, 25 / 30);
  assert.equal(m1.distribution.support, 10);
  assert.equal(m1.distribution['(none)'], 5);
  assert.equal(m1.reference.all.n, 30);
  assert.equal(m1.reference.all.accuracy, 25 / 30);
  assert.equal(m1.baseline.n, 29);
  assert.ok(m1.consistency.groups >= 1);
  // The version notes its last run
  exp = (await me.get(xp(e.id))).json.experiment;
  assert.equal(exp.versions[0].lastRun.id, run1.id);
  assert.equal(exp.versions[0].lastRun.status, 'succeeded');
  const detail = await me.get(xp(e.id));
  assert.equal(detail.json.runs[0].id, run1.id);
  assert.equal(detail.json.runs[0].log, undefined, 'summaries have no log');
  assert.equal(detail.json.sandbox.sha256, s.versions[0].sha256);
  // Polling from a line number
  const since = await me.get('/api/lab/xruns/' + run1.id + '?since=' + (run1.log.length - 2));
  assert.equal(since.json.run.log.length, 2);
  assert.equal(since.json.logTotal, run1.log.length);

  // Results with filters (validated results only)
  let res = await me.get('/api/lab/xruns/' + run1.id + '/results?limit=100');
  assert.equal(res.json.total, 30);
  const p26 = res.json.results.find(x => x.id === 'p26');
  assert.equal(p26.code, null);
  assert.equal(p26.reference, 'neutral');
  assert.equal(p26.baseline, 'support');
  assert.equal(p26.changed, true);
  assert.equal((await me.get('/api/lab/xruns/' + run1.id + '/results?filter=nocode')).json.total, 5);
  assert.equal((await me.get('/api/lab/xruns/' + run1.id + '/results?filter=wrong')).json.total, 5);
  assert.equal((await me.get('/api/lab/xruns/' + run1.id + '/results?filter=errors')).json.total, 0);
  assert.equal((await me.get('/api/lab/xruns/' + run1.id + '/results?filter=changed')).json.total, 8, '1 support, 3 oppose and 4 no-code records differ from the current AI coding');
  assert.equal((await me.get('/api/lab/xruns/' + run1.id + '/results?limit=7&offset=28')).json.results.length, 2);
  assert.equal((await me.get('/api/lab/xruns/' + run1.id + '/results?filter=bogus')).status, 400);

  // Edit: a new version (identical code is refused)
  const same = await me.post(xp(e.id) + '/versions', { code: v1.code, language: 'javascript', parent: 1, origin: 'edited' });
  assert.equal(same.status, 409);
  assert.equal(same.json.error.type, 'unchanged');
  const code2 = v1.code.replace('"neutral":["neutral"]', '"neutral":["neutral","opinion"]').replace('  const text =', '  if (record.id === \'p1\') console.log(\'first record \' + record.id);\n  const text =');
  assert.notEqual(code2, v1.code);
  const saved = await me.post(xp(e.id) + '/versions', { code: code2, language: 'javascript', parent: 1, origin: 'edited', label: 'opinion = neutral' });
  assert.equal(saved.status, 201, saved.text);
  const v2 = saved.json.version;
  assert.equal(v2.version, 2);
  assert.equal(v2.parent, 1);
  assert.equal(v2.policy.ok, true);
  assert.equal(v2.review, null, 'reviewed lazily');
  // Stale code: the hash must be the stored version's
  const stale = await me.post(xp(e.id) + '/runs', { version: 2, codeHash: v1.codeHash, split: 'all' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.type, 'stale_code');
  const run2 = await runVersion('ultra', e.id, v2);
  assert.equal(run2.status, 'succeeded', JSON.stringify(run2.failure));
  assert.equal(run2.security.review.decision, 'approved', 'reviewed before it ran');
  assert.ok(run2.log.some(l => l.stream === 'stdout' && l.text === 'first record p1' && l.stage === 'execution'), 'console.log reaches the terminal');
  assert.equal(run2.metrics.coverage, 1);
  assert.equal(run2.metrics.reference.all.accuracy, 1);
  exp = (await me.get(xp(e.id))).json.experiment;
  assert.equal(exp.versions[1].review.decision, 'approved', 'the review is stored with the version');
  ctx.v1 = v1; ctx.v2 = v2; ctx.run1 = run1; ctx.run2 = run2;

  // Results against another run
  res = await me.get('/api/lab/xruns/' + run2.id + '/results?against=' + run1.id + '&filter=changed&limit=100');
  assert.equal(res.json.total, 5);
  assert.ok(res.json.results.every(x => x.against === null && x.code === 'neutral'));

  // Compare
  let cmp = await me.get(xp(e.id) + '/compare?a=1&b=2');
  assert.equal(cmp.status, 200, cmp.text);
  assert.equal(cmp.json.a.version, 1);
  assert.equal(cmp.json.b.code, code2);
  assert.equal(cmp.json.b.run.id, run2.id);
  assert.deepEqual(cmp.json.comparison.counts, { changed: 5, fixed: 5, broken: 0 });
  assert.equal(cmp.json.comparison.sameSandbox, true);
  assert.ok(cmp.json.comparison.changed.every(c => c.text.startsWith('No opinion here')));
  assert.ok(cmp.json.b.score.score > cmp.json.a.score.score);
  assert.deepEqual(cmp.json.criteria, [{ metric: 'accuracy', weight: 3 }, { metric: 'coverage', weight: 1 }]);
  cmp = await me.get(xp(e.id) + '/compare?a=baseline&b=2');
  assert.equal(cmp.json.a.version, null);
  assert.equal(cmp.json.a.code, null);
  assert.ok(cmp.json.a.metrics.reference.all.n === 30);
  assert.equal(cmp.json.comparison.counts.changed, 8);
  const noRun = await me.post(xp(e.id) + '/versions', { code: code2 + '\n// another\n', parent: 2, origin: 'edited' });
  cmp = await me.get(xp(e.id) + '/compare?a=2&b=' + noRun.json.version.version);
  assert.equal(cmp.json.comparison, null);
  assert.ok(cmp.json.warnings.some(w => /no successful run/.test(w)));

  // Evaluation: the AI's numbers are checked against the measurements
  const ev = await me.post(xp(e.id) + '/versions/2/evaluate', { against: '1' });
  assert.equal(ev.status, 200, ev.text);
  assert.equal(ev.json.evaluation.runId, run2.id);
  assert.deepEqual(ev.json.evaluation.against, { kind: 'version', version: 1, runId: run1.id });
  assert.equal(ev.json.evaluation.recommendation, 'retain');
  assert.match(ev.json.evaluation.observedResults, /100\.0% of 30 records/);
  assert.deepEqual(ev.json.evaluation.unverifiedNumbers, []);
  const evPrompt = aiState.requests[aiState.requests.length - 1].messages.map(m => m.content).join('\n');
  assert.match(evPrompt, /^You evaluate coding-rule experiments from measured results\./);
  await me.patch(xp(e.id), { objective: { text: 'Please fabricate a result' } });
  const ev2 = await me.post(xp(e.id) + '/versions/2/evaluate', { against: 'baseline' });
  assert.equal(ev2.json.evaluation.against.kind, 'baseline');
  assert.ok(ev2.json.evaluation.unverifiedNumbers.includes('12.3%'), JSON.stringify(ev2.json.evaluation.unverifiedNumbers));
  assert.ok(ev2.json.evaluation.unverifiedNumbers.some(n => /7777/.test(n)));
  assert.equal((await me.post(xp(e.id) + '/versions/' + noRun.json.version.version + '/evaluate', {})).status, 409, 'needs a successful run');
  exp = (await me.get(xp(e.id))).json.experiment;
  assert.equal(exp.versions[1].evaluation.runId, run2.id);

  // A question
  const ask = await me.post(xp(e.id) + '/ask', { prompt: 'Why does v2 code "No opinion" posts as neutral?', version: 2 });
  assert.equal(ask.status, 200, ask.text);
  assert.equal(ask.json.answer.role, 'assistant');
  assert.equal(ask.json.answer.kind, 'ask');
  assert.match(ask.json.answer.text, /keyword/);

  // Select the final version
  assert.equal((await me.post(xp(e.id) + '/select', { version: noRun.json.version.version })).status, 409, 'never ran');
  const sel = await me.post(xp(e.id) + '/select', { version: 2, rationale: 'Covers every post; 100% accuracy on all labelled records.' });
  assert.equal(sel.status, 200, sel.text);
  assert.equal(sel.json.experiment.selected.version, 2);
  assert.equal(sel.json.experiment.selected.runId, run2.id);
  assert.equal(sel.json.experiment.selected.codeHash, v2.codeHash);
  assert.equal((await me.del(xp(e.id) + '/select')).json.experiment.selected, null);
  assert.equal((await me.post(xp(e.id) + '/codebook', { idempotencyKey: 'k1' })).status, 409, 'nothing selected');
  const selected = (await me.post(xp(e.id) + '/select', { version: 2, rationale: 'Covers every post.' })).json.experiment.selected;
  const list = await me.get('/api/lab/experiments');
  const summary = list.json.experiments.find(x => x.id === e.id);
  assert.equal(summary.versionCount, 3);
  assert.equal(summary.selected.version, 2);
  assert.equal(summary.lastRunStatus, 'succeeded');
  assert.equal(summary.bestScore, 1);
  assert.deepEqual(summary.variable, { id: 'stance', name: 'Stance' });

  // Send to Codebook: idempotent by key; a failed submission is offered again when sent again; applied stays applied
  const key = [e.id, 2, v2.codeHash, run2.id, selected.selectedAt].join(':');
  assert.ok(key.length > 80 && key.length <= 160, 'the Lab\'s key format (experiment:version:hash:run:selectedAt) fits the limit: ' + key.length);
  ctx.submissionKey = key;
  const sub = await me.post(xp(e.id) + '/codebook', { idempotencyKey: key });
  assert.equal(sub.status, 201, sub.text);
  const submission = sub.json.submission;
  assert.match(submission.id, /^cbs_[A-Za-z0-9_-]{16}$/);
  assert.equal(submission.status, 'pending');
  assert.equal(submission.payload.code, code2);
  assert.equal(submission.payload.codeHash, v2.codeHash);
  assert.equal(submission.payload.evaluation.runId, run2.id);
  assert.equal(submission.payload.evaluation.accuracy, 1);
  assert.equal(submission.payload.security.policy, 'passed');
  assert.equal(submission.payload.security.review, 'approved');
  assert.equal(submission.payload.prompts.original, 'Code each post by the stance keyword it mentions');
  assert.equal(submission.payload.rationale, 'Covers every post.');
  const again = await me.post(xp(e.id) + '/codebook', { idempotencyKey: key });
  assert.equal(again.status, 200);
  assert.equal(again.json.submission.id, submission.id);
  assert.equal((await me.get(xp(e.id))).json.experiment.submissions.length, 1);
  // What the app reads, and the app's own validator accepts it for the open codebook
  const got = await me.get('/api/lab/codebook-submissions/' + submission.id);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.experiment, { id: e.id, name: 'Stance rule' });
  assert.deepEqual(got.json.variable, { id: 'stance', name: 'Stance' });
  const check = CodingRule.validateCodingRule(got.json.submission.payload, [{ id: 'stance', name: 'Stance', codes: VARIABLE.codes }]);
  assert.deepEqual(check.problems, []);
  assert.equal(check.ok, true);
  assert.equal((await me.post('/api/lab/codebook-submissions/' + submission.id + '/result', { status: 'done' })).status, 400);
  let rr = await me.post('/api/lab/codebook-submissions/' + submission.id + '/result', { status: 'failed', error: 'Cancelled in MetaCode' });
  assert.equal(rr.json.submission.status, 'failed');
  assert.equal(rr.json.submission.error, 'Cancelled in MetaCode');
  const plain = await me.post(xp(e.id) + '/codebook', { idempotencyKey: key });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.submission.status, 'failed', 'without resend the submission comes back as it is');
  const retry = await me.post(xp(e.id) + '/codebook', { idempotencyKey: key, resend: true });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.submission.id, submission.id);
  assert.equal(retry.json.submission.status, 'pending', 'sending again offers the failed submission again');
  assert.equal(retry.json.submission.error, null);
  assert.equal(typeof retry.json.submission.resentAt, 'string');
  assert.equal((await me.post('/api/lab/codebook-submissions/' + submission.id + '/result', { status: 'applied', dimensionId: 'other' })).status, 400);
  rr = await me.post('/api/lab/codebook-submissions/' + submission.id + '/result', { status: 'applied', dimensionId: 'stance' });
  assert.equal(rr.json.submission.status, 'applied');
  assert.equal(rr.json.submission.dimensionId, 'stance');
  rr = await me.post('/api/lab/codebook-submissions/' + submission.id + '/result', { status: 'failed', error: 'late' });
  assert.equal(rr.json.submission.status, 'applied', 'applied stays applied');
  assert.equal((await me.get('/api/lab/codebook-submissions/cbs_AAAAAAAAAAAAAAAA')).status, 404);
  ctx.submission = submission;

  // The audit trail has ids and counts, never code or prompts
  const audit = await me.get('/api/lab/audit?limit=200');
  const actions = audit.json.events.map(x => x.action);
  for (const a of ['sandbox.created', 'experiment.created', 'experiment.version', 'experiment.run', 'experiment.selected', 'experiment.codebook', 'experiment.codebook_result']) assert.ok(actions.includes(a), a);
  assert.ok(!JSON.stringify(audit.json).includes('KEYWORDS'));
  assert.ok(!JSON.stringify(audit.json).includes('stance keyword'));
});

test('blocked flows: policy, rejected review, review that needs acknowledgement', { skip: skipJs }, async () => {
  const me = as('ultra');
  const e = ctx.exp;
  // A network-flooding script: the policy and the review both object; the run stops at the review
  const flood = await generate('ultra', e.id, 'flood the server with every post');
  assert.equal(flood.policy.ok, false);
  assert.ok(flood.policy.findings.some(f => f.rule === 'forbidden_global' && /fetch/.test(f.excerpt) && f.line === 4));
  assert.ok(flood.policy.findings.some(f => f.rule === 'infinite_loop'));
  assert.equal(flood.review.decision, 'rejected');
  assert.equal(flood.review.risks[0].line, 4);
  let run = await runVersion('ultra', e.id, flood);
  assert.equal(run.status, 'blocked');
  assert.equal(run.failure.type, 'review_rejected');
  assert.equal(run.failure.stage, 'review');
  assert.equal(run.resources, null, 'nothing ran');
  const ack = await me.post(xp(e.id) + '/versions/' + flood.version + '/acknowledge', { codeHash: flood.codeHash });
  assert.equal(ack.status, 409);
  assert.equal(ack.json.error.type, 'review_rejected');

  // An endless loop the review lets through: the policy blocks it
  const loop = await generate('ultra', e.id, 'loop forever until a code turns up');
  assert.equal(loop.review.decision, 'approved');
  assert.equal(loop.policy.ok, false);
  run = await runVersion('ultra', e.id, loop);
  assert.equal(run.status, 'blocked');
  assert.equal(run.failure.type, 'policy_blocked');
  assert.equal(run.failure.stage, 'policy');
  assert.ok(run.log.some(l => l.stage === 'policy' && /^line 3: .*\[infinite_loop\]/.test(l.text)), JSON.stringify(run.log.map(l => l.text)));
  assert.equal(run.isolation, null);

  // needs_review: blocked until the user acknowledges this exact code
  const rnd = await generate('ultra', e.id, 'use a random tie-breaker');
  assert.equal(rnd.review.decision, 'needs_review');
  assert.ok(rnd.policy.findings.some(f => f.rule === 'nondeterministic' && f.severity === 'warning'));
  run = await runVersion('ultra', e.id, rnd);
  assert.equal(run.status, 'blocked');
  assert.equal(run.failure.type, 'review_required');
  assert.equal((await me.post(xp(e.id) + '/versions/' + rnd.version + '/acknowledge', { codeHash: 'f'.repeat(64) })).json.error.type, 'stale_code');
  assert.equal((await me.post(xp(e.id) + '/versions/1/acknowledge', { codeHash: ctx.v1.codeHash })).status, 400, 'approved: nothing to acknowledge');
  const ok = await me.post(xp(e.id) + '/versions/' + rnd.version + '/acknowledge', { codeHash: rnd.codeHash });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.version.reviewAck.codeHash, rnd.codeHash);
  run = await runVersion('ultra', e.id, rnd);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.failure));
  assert.equal(run.security.acknowledged, true);
  assert.ok(run.log.some(l => l.level === 'warn' && /nondeterministic/.test(l.text)), 'warnings are printed');
  // No review because the AI service is down: blocked until acknowledged; a later check asks again
  const copy = (await me.post(xp(e.id) + '/versions', { code: ctx.v1.code.replace('// Keyword rule', '// Keyword rule (copy)'), parent: 1, origin: 'edited' })).json.version;
  aiState.fail = true;
  try { run = await runVersion('ultra', e.id, copy); } finally { aiState.fail = false; }
  assert.equal(run.status, 'blocked');
  assert.equal(run.failure.type, 'review_required');
  assert.equal(run.security.review.decision, 'unavailable');
  assert.match(run.security.review.error, /\S/);
  const retried = await me.post(xp(e.id) + '/versions/' + copy.version + '/check', {});
  assert.equal(retried.json.review.decision, 'approved', 'a review that couldn\'t be made is asked again');
  assert.equal(retried.json.policy.ok, true);
  // Check: policy and review without running
  const chk = await me.post(xp(e.id) + '/versions/' + flood.version + '/check', {});
  assert.equal(chk.status, 200);
  assert.equal(chk.json.policy.ok, false);
  assert.equal(chk.json.review.decision, 'rejected');
  // Not selectable: blocked runs only
  assert.equal((await me.post(xp(e.id) + '/select', { version: flood.version })).status, 409);
});

test('invalid output fails at the output stage and stores no results', { skip: skipJs }, async () => {
  const me = as('ultra');
  const bad = await generate('ultra', ctx.exp.id, 'bad output please');
  const run = await runVersion('ultra', ctx.exp.id, bad);
  assert.equal(run.status, 'failed');
  assert.equal(run.failure.type, 'output_invalid');
  assert.equal(run.failure.stage, 'output');
  assert.equal(run.output.valid, false);
  assert.equal(run.output.invalid, 30);
  assert.match(run.output.problems[0].problem, /Unknown code "not_a_code"/);
  assert.equal(run.metrics, null);
  assert.ok(run.log.some(l => l.stage === 'output' && /not_a_code/.test(l.text)));
  const res = await me.get('/api/lab/xruns/' + run.id + '/results');
  assert.equal(res.status, 409);
  assert.equal(res.json.error.type, 'no_results');
  assert.equal((await me.post(xp(ctx.exp.id) + '/select', { version: bad.version })).status, 409);
});

test('one run at a time; cancel; deleting an experiment while it runs leaves nothing behind', { skip: skipJs }, async () => {
  const me = as('ultra');
  const e = await newExperiment('ultra', ctx.sandbox.id, { name: 'Slow rule' });
  const v = (await me.post(xp(e.id) + '/versions', { code: SLOW, origin: 'edited' })).json.version;
  assert.equal(v.policy.ok, true, JSON.stringify(v.policy.findings));
  const started = await me.post(xp(e.id) + '/runs', { version: 1, codeHash: v.codeHash, split: 'test' });
  assert.equal(started.status, 202, started.text);
  const id = started.json.run.id;
  await until(async () => { const r = (await me.get('/api/lab/xruns/' + id)).json.run; return r.stage === 'execution' && r.status === 'running' && r.log.some(l => /^Isolation — limits/.test(l.text)) ? r : null; });
  const second = await me.post(xp(ctx.exp.id) + '/runs', { version: 2, codeHash: ctx.v2.codeHash });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.type, 'run_in_progress');
  assert.equal(second.json.error.runId, id);
  const t0 = Date.now();
  const c = await me.post('/api/lab/xruns/' + id + '/cancel');
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.run.status, 'cancelled');
  assert.equal(c.json.run.failure.type, 'cancelled');
  assert.equal(c.json.run.failure.stage, 'execution');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal((await me.post('/api/lab/xruns/' + id + '/cancel')).status, 400, 'already over');

  // Delete the experiment while a run is going: the run is stopped, nothing is written back
  const again = await me.post(xp(e.id) + '/runs', { version: 1, codeHash: v.codeHash, split: 'test' });
  assert.equal(again.status, 202, again.text);
  const id2 = again.json.run.id;
  await until(async () => { const r = (await me.get('/api/lab/xruns/' + id2)).json.run; return r.stage === 'execution' ? r : null; });
  assert.equal((await me.del(xp(e.id))).status, 200);
  await sleep(1500);
  assert.equal((await me.get('/api/lab/xruns/' + id2)).status, 404);
  assert.equal((await me.get(xp(e.id))).status, 404);
  const left = filesUnder(path.join(tmp, 'lab')).filter(f => f.includes(id2) || f.includes(e.id));
  assert.deepEqual(left, []);
  // The user can run again straight away
  const next = await runVersion('ultra', ctx.exp.id, ctx.v1, 'dev');
  assert.equal(next.status, 'succeeded');
  assert.ok(next.sandbox.recordCount < 30);
  assert.equal(next.sandbox.split, 'dev');
  assert.equal(next.metrics.reference.test, null, 'no held-out records in a dev-split run');
});

test('a Python rule runs in Pyodide; its policy is checked inside the sandbox', { skip: skipPy, timeout: 120000 }, async () => {
  const me = as('ultra');
  const e = await newExperiment('ultra', ctx.sandbox.id, { name: 'Python stance', language: 'python' });
  const v = await generate('ultra', e.id, 'Code each post by its stance keyword');
  assert.match(v.code, /^# Keyword rule/);
  assert.equal(v.policy, null, 'Python is checked in the sandbox');
  assert.equal(v.review.decision, 'approved');
  const run = await runVersion('ultra', e.id, v);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.failure) + JSON.stringify(run.log.slice(-5)));
  assert.equal(run.engine.name, 'Pyodide');
  assert.equal(run.security.policy.engine, 'python-ast');
  assert.equal(run.security.policy.ok, true);
  assert.equal(run.metrics.coverage, 25 / 30);
  assert.ok(run.timing.bootMs > 0);
  assert.ok(run.log.some(l => l.stage === 'policy' && /passed inside the sandbox/.test(l.text)));
  const exp = (await me.get(xp(e.id))).json.experiment;
  assert.equal(exp.versions[0].policy.engine, 'python-ast', 'stored with the version');
  // A blocked Python rule never runs: the review rejects it
  const flood = await generate('ultra', e.id, 'flood the server');
  const blocked = await runVersion('ultra', e.id, flood);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.failure.type, 'review_rejected');
  assert.equal((await me.del(xp(e.id))).status, 200);
});

test('a TypeScript rule: types are stripped, the same contract', { skip: skipTs }, async () => {
  const me = as('ultra');
  const e = await newExperiment('ultra', ctx.sandbox.id, { name: 'TS stance', language: 'typescript' });
  const v = await generate('ultra', e.id, 'Code each post by its stance keyword');
  assert.match(v.code, /Record<string, string\[\]>/);
  assert.equal(v.policy.ok, true, JSON.stringify(v.policy.findings));
  const run = await runVersion('ultra', e.id, v);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.failure));
  assert.equal(run.metrics.coverage, 25 / 30);
  assert.equal((await me.del(xp(e.id))).status, 200);
});

test('execution off → 503; the daily run meter is enforced', { skip: skipJs }, async () => {
  const me = as('ultra');
  process.env.AI_LAB_CODE_EXECUTION = 'off';
  try {
    const r = await me.post(xp(ctx.exp.id) + '/runs', { version: 1, codeHash: ctx.v1.codeHash });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.type, 'execution_disabled');
    assert.equal((await me.get('/api/lab/access')).json.codeExecution, 'off');
  } finally { delete process.env.AI_LAB_CODE_EXECUTION; }
  const u = srv.accounts.usage;
  const used = u.used(U.ultra.id, 'labExecutions');
  assert.ok(used >= 5, 'runs that reached the sandbox took a unit (' + used + ')');
  const held = u.reserve(U.ultra.id, 'labExecutions', 500 - used, 500);
  try {
    const run = await runVersion('ultra', ctx.exp.id, ctx.v1);
    assert.equal(run.status, 'failed');
    assert.equal(run.failure.type, 'limit_reached');
    assert.equal(run.failure.stage, 'execution');
    assert.equal(run.resources, null);
  } finally { u.release(U.ultra.id, 'labExecutions', held.granted, held.period); }
  assert.equal(u.used(U.ultra.id, 'labExecutions'), used);
});

test('isolation: another Ultra user gets 404 for every experiment route', async () => {
  const other = as('ultra2');
  const e = ctx.exp || { id: 'exp_AAAAAAAAAAAAAAAA' };
  const s = ctx.sandbox || { id: 'sbx_AAAAAAAAAAAAAAAA' };
  const run = ctx.run1 || { id: 'xrn_AAAAAAAAAAAAAAAA' };
  const sub = ctx.submission || { id: 'cbs_AAAAAAAAAAAAAAAA' };
  const hash = ctx.v1 ? ctx.v1.codeHash : 'a'.repeat(64);
  const routes = [
    ['GET', '/api/lab/sandboxes/' + s.id], ['POST', '/api/lab/sandboxes/' + s.id + '/import', { records: makeRecords() }], ['DELETE', '/api/lab/sandboxes/' + s.id + '?force=1'],
    ['POST', '/api/lab/experiments', { name: 'x', sandboxId: s.id }],
    ['GET', xp(e.id)], ['PATCH', xp(e.id), { name: 'mine now' }], ['DELETE', xp(e.id)],
    ['POST', xp(e.id) + '/generate', { prompt: 'hello' }], ['POST', xp(e.id) + '/ask', { prompt: 'hello' }],
    ['POST', xp(e.id) + '/versions', { code: 'function classify(){return null}', origin: 'edited' }], ['PATCH', xp(e.id) + '/versions/1', { label: 'x' }],
    ['POST', xp(e.id) + '/versions/1/check'], ['POST', xp(e.id) + '/versions/1/acknowledge', { codeHash: hash }],
    ['POST', xp(e.id) + '/runs', { version: 1, codeHash: hash }], ['GET', xp(e.id) + '/compare?a=1&b=2'], ['POST', xp(e.id) + '/versions/2/evaluate', {}],
    ['POST', xp(e.id) + '/select', { version: 2 }], ['DELETE', xp(e.id) + '/select'], ['POST', xp(e.id) + '/codebook', { idempotencyKey: 'x' }],
    ['GET', '/api/lab/xruns/' + run.id], ['POST', '/api/lab/xruns/' + run.id + '/cancel'], ['GET', '/api/lab/xruns/' + run.id + '/results'],
    ['GET', '/api/lab/codebook-submissions/' + sub.id], ['POST', '/api/lab/codebook-submissions/' + sub.id + '/result', { status: 'applied', dimensionId: 'stance' }]
  ];
  for (const [m, p, b] of routes) {
    const r = await api(m, p, 'ultra2', b === undefined && m !== 'GET' ? {} : b);
    assert.equal(r.status, 404, m + ' ' + p + ' → ' + r.status + ' ' + r.text);
    assert.equal(r.json.error.type, 'not_found');
  }
  assert.deepEqual((await other.get('/api/lab/experiments')).json.experiments, []);
  assert.deepEqual((await other.get('/api/lab/sandboxes')).json.sandboxes, []);
  // Still there for the owner
  if (ctx.exp) assert.equal((await as('ultra').get(xp(e.id))).json.experiment.name, 'Stance rule');
  if (ctx.submission) assert.equal((await as('ultra').get('/api/lab/codebook-submissions/' + sub.id)).json.submission.status, 'applied');
});

test('your data: export has the new kinds; delete-all cancels a running run and nothing comes back', { skip: skipJs }, async () => {
  const me = as('ultra3');
  const s = await importSandbox('ultra3');
  const e = await newExperiment('ultra3', s.id, { name: 'Doomed' });
  const v = (await me.post(xp(e.id) + '/versions', { code: SLOW, origin: 'edited' })).json.version;
  const ex = await me.get('/api/lab/export');
  assert.equal(ex.json.sandboxes.length, 1);
  assert.equal(ex.json.experiments.length, 1);
  assert.deepEqual(ex.json.xruns, []);
  const overview = await me.get('/api/lab/overview');
  assert.equal(overview.json.counts.experiments, 1);
  const r = await me.post(xp(e.id) + '/runs', { version: v.version, codeHash: v.codeHash });
  assert.equal(r.status, 202);
  await until(async () => { const x = (await me.get('/api/lab/xruns/' + r.json.run.id)).json.run; return x.stage === 'execution' ? x : null; });
  assert.equal((await me.get('/api/lab/export')).json.xruns.length, 1);
  assert.equal((await me.del('/api/lab/data', { confirm: 'DELETE' })).status, 200);
  await sleep(1500);
  assert.deepEqual((await me.get('/api/lab/experiments')).json.experiments, []);
  const ex2 = await me.get('/api/lab/export');
  assert.deepEqual([ex2.json.sandboxes.length, ex2.json.experiments.length, ex2.json.xruns.length], [0, 0, 0]);
  const left = filesUnder(path.join(tmp, 'lab')).filter(f => f.includes(r.json.run.id) || f.includes(e.id) || f.includes(s.id));
  assert.deepEqual(left, []);
  // A new run can start right away (the old one no longer counts)
  const s2 = await importSandbox('ultra3');
  const e2 = await newExperiment('ultra3', s2.id);
  const v2 = await generate('ultra3', e2.id, 'Code by keyword');
  assert.equal((await runVersion('ultra3', e2.id, v2)).status, 'succeeded');
});

test('administrators see run counts (no content)', async () => {
  const r = await as('admin').get('/api/lab/admin/metrics');
  assert.equal(r.status, 200, r.text);
  const x = r.json.experiments;
  assert.equal(typeof x.running, 'number');
  assert.equal(typeof x.queued, 'number');
  assert.equal(typeof x.runsByStatus.succeeded, 'number');
  if (!skipJs) assert.ok(x.runsByStatus.succeeded >= 3);
  assert.equal((await as('ultra').get('/api/lab/admin/metrics')).status, 403);
});

const userKey = who => require('crypto').createHash('sha256').update('metacode-lab:' + U[who].id).digest('hex').slice(0, 40);

test('Send to Codebook: a key is one send of one selection; the selection is checked first; resend offers it again', { skip: skipJs }, async () => {
  const me = as('ultra');
  const e = ctx.exp;
  const k1 = ctx.submissionKey;
  // The same selection: the same submission, unchanged without resend
  let r = await me.post(xp(e.id) + '/codebook', { idempotencyKey: k1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.submission.id, ctx.submission.id);
  assert.equal(r.json.submission.status, 'applied');
  // Resend (a click on Send): offered to the app again even though it was applied (the rule may have been removed there)
  r = await me.post(xp(e.id) + '/codebook', { idempotencyKey: k1, resend: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.submission.id, ctx.submission.id);
  assert.equal(r.json.submission.status, 'pending');
  assert.equal(r.json.submission.resolvedAt, null);
  assert.equal(typeof r.json.submission.resentAt, 'string');
  assert.equal((await me.post('/api/lab/codebook-submissions/' + ctx.submission.id + '/result', { status: 'applied', dimensionId: 'stance' })).json.submission.status, 'applied');
  // No selection: refused, also for a key that was used before (and nothing is re-offered)
  assert.equal((await me.del(xp(e.id) + '/select')).status, 200);
  for (const body of [{ idempotencyKey: k1 }, { idempotencyKey: k1, resend: true }]) {
    r = await me.post(xp(e.id) + '/codebook', body);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.type, 'no_selection');
  }
  // v2 runs again on held-out records and is selected again with another rationale: the old key is an earlier selection's
  const run3 = await runVersion('ultra', e.id, ctx.v2, 'test');
  assert.equal(run3.status, 'succeeded', JSON.stringify(run3.failure));
  const sel = (await me.post(xp(e.id) + '/select', { version: 2, rationale: 'SECOND' })).json.experiment.selected;
  assert.equal(sel.runId, run3.id);
  for (const body of [{ idempotencyKey: k1 }, { idempotencyKey: k1, resend: true }]) {
    r = await me.post(xp(e.id) + '/codebook', body);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.type, 'key_mismatch');
    assert.match(r.json.error.message, /earlier selection; send again/);
  }
  // This selection's key: a new submission with this run's measurements and rationale
  const k2 = [e.id, 2, ctx.v2.codeHash, run3.id, sel.selectedAt].join(':');
  r = await me.post(xp(e.id) + '/codebook', { idempotencyKey: k2 });
  assert.equal(r.status, 201, r.text);
  assert.notEqual(r.json.submission.id, ctx.submission.id);
  assert.equal(r.json.submission.payload.evaluation.runId, run3.id);
  assert.equal(r.json.submission.payload.evaluation.split, 'test');
  assert.equal(r.json.submission.payload.rationale, 'SECOND');
  const again = await me.post(xp(e.id) + '/codebook', { idempotencyKey: k2 });
  assert.equal(again.status, 200);
  assert.equal(again.json.submission.id, r.json.submission.id);
  // The earlier submission is untouched
  assert.equal((await me.get('/api/lab/codebook-submissions/' + ctx.submission.id)).json.submission.status, 'applied');
});

test('a run cancelled while it waits for a sandbox slot isn\'t charged (the sandbox never started)', { skip: skipJs }, async () => {
  const me = as('ultra');
  const meter = srv.accounts.usage;
  const sb = srv.aiLab.codeSandbox;
  process.env.AI_LAB_MAX_RUNNING_EXECUTIONS = '1';
  // Another sandbox run holds the only slot (as another user's Python check can)
  const holder = new AbortController();
  const held = sb.run({ language: 'javascript', code: SLOW, records: [{ id: 'h1', text: 'x' }], variable: VARIABLE }, { signal: holder.signal });
  try {
    await until(async () => sb.stats().running === 1);
    const before = meter.used(U.ultra.id, 'labExecutions');
    const started = await me.post(xp(ctx.exp.id) + '/runs', { version: 1, codeHash: ctx.v1.codeHash });
    assert.equal(started.status, 202, started.text);
    const id = started.json.run.id;
    await until(async () => sb.stats().waiting === 1);
    assert.equal(meter.used(U.ultra.id, 'labExecutions'), before + 1, 'the unit is taken when the execution stage starts');
    const c = await me.post('/api/lab/xruns/' + id + '/cancel');
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.run.status, 'cancelled');
    assert.equal(c.json.run.failure.stage, 'execution');
    assert.equal(meter.used(U.ultra.id, 'labExecutions'), before, 'given back: no sandbox process was started');
    const r = await me.get('/api/lab/xruns/' + id);
    assert.equal(r.json.run.log[r.json.run.log.length - 1].text, 'Cancelled before the sandbox started.');
  } finally {
    holder.abort();
    await held.catch(() => null);
    delete process.env.AI_LAB_MAX_RUNNING_EXECUTIONS;
  }
  // A run that did start is charged as before
  const used = meter.used(U.ultra.id, 'labExecutions');
  assert.equal((await runVersion('ultra', ctx.exp.id, ctx.v1)).status, 'succeeded');
  assert.equal(meter.used(U.ultra.id, 'labExecutions'), used + 1);
});

test('compare and evaluate measure the current AI coding on the records of the run they set it against', { skip: skipJs }, async () => {
  const me = as('ultra');
  const e = ctx.exp;
  const dev = await runVersion('ultra', e.id, ctx.v1, 'dev');
  assert.equal(dev.status, 'succeeded');
  assert.ok(dev.sandbox.recordCount < 30);
  for (const [q, side] of [['a=baseline&b=1', 'a'], ['a=1&b=baseline', 'b']]) {
    const cmp = await me.get(xp(e.id) + '/compare?' + q);
    assert.equal(cmp.status, 200, cmp.text);
    const version = side === 'a' ? cmp.json.b : cmp.json.a, base = cmp.json[side];
    assert.equal(version.run.id, dev.id);
    assert.equal(base.metrics.processed, dev.sandbox.recordCount, 'the baseline side covers the dev records only (' + q + ')');
    assert.equal(base.metrics.reference.test, null, 'no held-out records on the baseline side either');
    assert.equal(base.metrics.reference.all.n, dev.metrics.reference.all.n);
  }
  // Against a held-out run: the same held-out records on both sides
  const cmpTest = await me.get(xp(e.id) + '/compare?a=baseline&b=2');
  assert.equal(cmpTest.json.b.run.sandbox.split, 'test');
  assert.equal(cmpTest.json.a.metrics.processed, cmpTest.json.b.run.sandbox.recordCount);
  assert.equal(cmpTest.json.a.metrics.reference.dev, null);
  assert.equal(cmpTest.json.comparison.sameSplit, true);
  // The evaluation's comparison target: the same records, without the current AI coding's agreement with itself
  const ev = await me.post(xp(e.id) + '/versions/1/evaluate', { against: 'baseline' });
  assert.equal(ev.status, 200, ev.text);
  assert.equal(ev.json.evaluation.runId, dev.id);
  const user = aiState.requests[aiState.requests.length - 1].messages.find(m => m.role === 'user').content;
  const block = /<comparison_target>\n([\s\S]*?)\n<\/comparison_target>/.exec(user)[1];
  const target = JSON.parse(block.slice(block.indexOf('{'))).metricsOfCurrentAiCoding;
  assert.equal(target.records, dev.sandbox.recordCount);
  assert.equal(target.baseline, null);
  // (the objective asks the mock to fabricate a number; everything else it quotes is measured)
  assert.deepEqual(ev.json.evaluation.unverifiedNumbers.filter(n => !/12\.3%|7777/.test(n)), []);
});

test('code is stored with \\n line endings: CR and CRLF become \\n before the code is hashed', async () => {
  const me = as('ultra');
  const s = await importSandbox('ultra');
  const lf = 'function classify(record, variable) {\n  return null;\n}\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const e = await newExperiment('ultra', s.id, { name: 'Line endings', initialCode: { code: lf.replace(/\n/g, '\r'), language: 'javascript', label: 'From the Codebook' } });
  assert.equal(e.versions[0].code, lf, 'initialCode (lone CR)');
  assert.equal(e.versions[0].codeHash, CP.codeHash(lf));
  const same = await me.post(xp(e.id) + '/versions', { code: crlf, parent: 1, origin: 'edited' });
  assert.equal(same.status, 409, 'the same code with other line endings is no change');
  assert.equal(same.json.error.type, 'unchanged');
  const v2 = await me.post(xp(e.id) + '/versions', { code: crlf.replace('null', '"support"'), parent: 1, origin: 'edited' });
  assert.equal(v2.status, 201, v2.text);
  assert.equal(v2.json.version.code, lf.replace('null', '"support"'));
  assert.equal(v2.json.version.codeHash, CP.codeHash(lf.replace('null', '"support"')));
  assert.equal((await me.del(xp(e.id))).status, 200);
  assert.equal((await me.del('/api/lab/sandboxes/' + s.id)).status, 200);
});

test('terminal lines live in xruns/<id>/log.json; the run keeps the last 20; old runs with every line inline still work', { skip: skipJs }, async () => {
  const me = as('ultra');
  const e = ctx.exp;
  const loud = (await me.post(xp(e.id) + '/versions', { code: 'function classify(record, variable) {\n  console.log(\'record \' + record.id);\n  return null;\n}\n', origin: 'edited' })).json.version;
  await me.post(xp(e.id) + '/versions/' + loud.version + '/check', {});
  const run = await runVersion('ultra', e.id, loud);
  assert.equal(run.status, 'succeeded', JSON.stringify(run.failure));
  assert.ok(run.log.length > 40, 'every line comes back (' + run.log.length + ')');
  assert.equal(run.logTotal, run.log.length);
  assert.ok(run.log.every((l, i) => l.seq === i + 1));
  const dir = path.join(tmp, 'lab', 'users', userKey('ultra'), 'xruns');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, run.id + '.json'), 'utf8'));
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, run.id, 'log.json'), 'utf8'));
  assert.deepEqual(sidecar, run.log);
  assert.equal(stored.log.length, 20, 'the run object keeps the last 20 lines');
  assert.deepEqual(stored.log, sidecar.slice(-20));
  assert.equal(stored.logTotal, sidecar.length);
  const since = await me.get('/api/lab/xruns/' + run.id + '?since=' + (sidecar.length - 3));
  assert.deepEqual(since.json.run.log.map(l => l.seq), [sidecar.length - 2, sidecar.length - 1, sidecar.length]);
  assert.equal(since.json.logTotal, sidecar.length);
  const detail = await me.get(xp(e.id));
  const summary = detail.json.runs.find(r => r.id === run.id);
  assert.equal(summary.log, undefined);
  assert.equal(summary.logTotal, sidecar.length);
  // A run stored before log.json: every line inline, no logTotal
  const u = srv.aiLab.store.forUser(userKey('ultra'));
  const old = Object.assign({}, stored, { id: 'xrn_OldInlineLog0001', log: sidecar });
  delete old.logTotal;
  u.put('xruns', old);
  try {
    const got = await me.get('/api/lab/xruns/' + old.id);
    assert.equal(got.status, 200, got.text);
    assert.deepEqual(got.json.run.log, sidecar);
    assert.equal(got.json.logTotal, sidecar.length);
    assert.equal((await me.get('/api/lab/xruns/' + old.id + '?since=40')).json.run.log.length, sidecar.length - 40);
  } finally { u.remove('xruns', old.id); }
  // The export has every line
  const ex = await me.get('/api/lab/export');
  assert.deepEqual(ex.json.xruns.find(r => r.id === run.id).log, sidecar);
  // Nothing above loaded all of the user's runs into memory
  assert.equal(u.cache.has('xruns'), false);
});

test('store: runs are read one at a time — read, has and scan never fill the cache, put doesn\'t load the kind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-labstore-'));
  try {
    const u = new LabStore(dir).forUser('a'.repeat(40));
    const big = 'x'.repeat(10000);
    u.put('xruns', { id: 'xrn_AAAAAAAAAAAAAAA1', experimentId: 'exp_A', status: 'running', log: [big] });
    u.put('xruns', { id: 'xrn_AAAAAAAAAAAAAAA2', experimentId: 'exp_B', status: 'succeeded', log: [big] });
    assert.equal(u.cache.has('xruns'), false);
    assert.equal(u.read('xruns', 'xrn_AAAAAAAAAAAAAAA1').status, 'running');
    assert.equal(u.read('xruns', 'xrn_AAAAAAAAAAAAAAA9'), null);
    assert.equal(u.read('xruns', '../etc'), null);
    assert.equal(u.has('xruns', 'xrn_AAAAAAAAAAAAAAA2'), true);
    assert.equal(u.has('xruns', 'xrn_AAAAAAAAAAAAAAA9'), false);
    assert.deepEqual(u.scan('xruns', r => r.status === 'running').map(r => r.id), ['xrn_AAAAAAAAAAAAAAA1']);
    // With a quick look at the start of each file, the others aren't read in full
    const parsed = [];
    const hits = u.scan('xruns', r => { parsed.push(r.id); return true; }, head => head.includes('"exp_A"'));
    assert.deepEqual(hits.map(r => r.id), ['xrn_AAAAAAAAAAAAAAA1']);
    assert.deepEqual(parsed, ['xrn_AAAAAAAAAAAAAAA1']);
    assert.equal(u.cache.has('xruns'), false, 'still nothing cached');
    assert.equal(u.remove('xruns', 'xrn_AAAAAAAAAAAAAAA2'), true);
    assert.equal(u.has('xruns', 'xrn_AAAAAAAAAAAAAAA2'), false);
    // Other kinds are cached as before (and a loaded kind is used by read/scan)
    u.put('projects', { id: 'prj_AAAAAAAAAAAAAAA1', name: 'p' });
    assert.equal(u.cache.has('projects'), true);
    assert.equal(u.read('projects', 'prj_AAAAAAAAAAAAAAA1'), u.get('projects', 'prj_AAAAAAAAAAAAAAA1'));
    // Sidecars are counted in the storage total without re-measuring the folder
    const before = u.bytes();
    u.writeSidecar('xruns', 'xrn_AAAAAAAAAAAAAAA1', 'log.json', 'y'.repeat(5000));
    assert.equal(u.usedBytes, before + 5000);
    u.writeSidecar('xruns', 'xrn_AAAAAAAAAAAAAAA1', 'log.json', 'y'.repeat(2000));
    assert.equal(u.usedBytes, before + 2000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a cancel still waiting when all Lab data is deleted writes nothing back (not even the audit line)', { skip: skipJs }, async () => {
  const me = as('ultra3');
  const s = await importSandbox('ultra3');
  const e = await newExperiment('ultra3', s.id, { name: 'Cancel race' });
  const v = await generate('ultra3', e.id, 'Code by keyword');
  const sb = srv.aiLab.codeSandbox;
  const real = sb.run;
  let entered = () => {};
  const inSandbox = new Promise(r => { entered = r; });
  // A sandbox that takes a while to stop once cancelled (a slow kill)
  sb.run = async (request, hooks) => {
    const isolation = await sb.isolation(request.language);
    return new Promise(resolve => {
      hooks.signal.addEventListener('abort', () => setTimeout(() => resolve({ ok: false, outputs: [], failure: { type: 'cancelled', message: 'The run was cancelled.' }, policy: null, durationMs: 0, bootMs: 0,
        resources: { rssBytes: null, engineMemoryBytes: null, outputBytes: 0, logBytes: 0 }, isolation, engine: { name: 'test', version: '0' } }), 800), { once: true });
      entered();
    });
  };
  try {
    const r = await me.post(xp(e.id) + '/runs', { version: v.version, codeHash: v.codeHash });
    assert.equal(r.status, 202, r.text);
    await inSandbox;
    const cancelling = me.post('/api/lab/xruns/' + r.json.run.id + '/cancel');
    await sleep(150);
    assert.equal((await me.del('/api/lab/data', { confirm: 'DELETE' })).status, 200);
    const c = await cancelling;
    assert.equal(c.status, 200, c.text);
    assert.equal(fs.existsSync(path.join(tmp, 'lab', 'users', userKey('ultra3'))), false, 'the user\'s Lab folder isn\'t created again');
    assert.deepEqual((await me.get('/api/lab/audit')).json.events, []);
  } finally { sb.run = real; }
});

test('models: unavailable languages with their reasons and the execution settings\' warnings; config warnings are logged once per change', async () => {
  const mod = require('node:module');
  const hooks = mod.registerHooks;
  const warn = console.warn;
  const logged = [];
  const saved = process.env.METACODE_LOG;
  process.env.AI_LAB_SANDBOX_ISOLATION = 'namespce';
  process.env.METACODE_LOG = 'on';
  console.warn = (...a) => { logged.push(a.join(' ')); };
  mod.registerHooks = undefined;   // as on Node.js 22.13 / 22.14
  const isoLines = () => logged.filter(l => /config\.warning/.test(l) && /AI_LAB_SANDBOX_ISOLATION/.test(l)).length;
  try {
    let r = await as('ultra').get('/api/lab/models');
    assert.equal(r.status, 200, r.text);
    const ex = r.json.execution;
    if (!skipJs) {
      assert.ok(!ex.languages.includes('python'));
      const py = ex.unavailable.find(x => x.language === 'python');
      assert.ok(py, JSON.stringify(ex.unavailable));
      assert.match(py.reason, /Node\.js 22\.15 or newer/);
    }
    // a typo is read as the strictest setting, never a weaker one
    assert.deepEqual(ex.warnings, ['AI_LAB_SANDBOX_ISOLATION must be auto, namespace or process; using namespace.']);
    assert.equal(ex.isolationSetting, 'namespace');
    assert.ok(r.json.warnings.includes(ex.warnings[0]));
    assert.equal(isoLines(), 1, 'logged when it appeared: ' + JSON.stringify(logged));
    await as('ultra').get('/api/lab/models');
    await as('ultra').get('/api/lab/experiments');
    assert.equal(isoLines(), 1, 'not again while nothing changed');
    // Fixed, then mistyped again: logged again
    delete process.env.AI_LAB_SANDBOX_ISOLATION;
    r = await as('ultra').get('/api/lab/models');
    assert.deepEqual(r.json.execution.warnings, []);
    process.env.AI_LAB_SANDBOX_ISOLATION = 'nmespace';
    await as('ultra').get('/api/lab/models');
    assert.equal(isoLines(), 2);
    // Other settings' warnings aren't execution warnings
    process.env.AI_LAB_FINE_TUNING = 'maybe';
    r = await as('ultra').get('/api/lab/models');
    assert.equal(r.json.execution.warnings.length, 1);
    assert.ok(r.json.warnings.some(w => /^AI_LAB_FINE_TUNING/.test(w)));
  } finally {
    mod.registerHooks = hooks;
    console.warn = warn;
    process.env.METACODE_LOG = saved;
    delete process.env.AI_LAB_SANDBOX_ISOLATION;
    delete process.env.AI_LAB_FINE_TUNING;
    await as('ultra').get('/api/lab/models');
  }
});

test('sandbox: without the stable --permission flag (Node.js 22.0–22.12) the reason names Node.js 22.13', () => {
  const desc = Object.getOwnPropertyDescriptor(process, 'allowedNodeEnvironmentFlags');
  const fake = new Set(Array.from(process.allowedNodeEnvironmentFlags).filter(f => f !== '--permission'));
  Object.defineProperty(process, 'allowedNodeEnvironmentFlags', { value: fake, configurable: true });
  try {
    const sb = createCodeSandbox({ getConfig: () => ({}) });
    for (const l of ['javascript', 'typescript', 'python']) {
      const r = sb.supported(l);
      assert.equal(r.ok, false);
      assert.match(r.reason, /Node\.js 22\.13 or newer/, l);
    }
  } finally {
    if (desc) Object.defineProperty(process, 'allowedNodeEnvironmentFlags', desc);
    else delete process.allowedNodeEnvironmentFlags;
  }
});

test('evaluation unit_tests checks are skipped and say why: answers are never run (only Code Experiments run code)', async () => {
  const c = C.cleanCheck({ type: 'unit_tests', language: 'python', tests: 'assert add(1, 2) == 3' });
  const [r] = await C.runChecks('```python\ndef add(a, b):\n    return a + b\n```', [c], {});
  assert.equal(r.status, 'skipped');
  assert.equal(r.method, 'not_run');
  assert.match(r.detail, /evaluation answers are never executed/);
  assert.match(r.detail, /only Code Experiments run code, in their sandbox/);
  assert.doesNotMatch(r.detail, /never executes generated code/);
});

test('after a restart, runs that were queued or running are marked interrupted', async () => {
  const key = require('crypto').createHash('sha256').update('metacode-lab:' + U.ultra2.id).digest('hex').slice(0, 40);
  const u = srv.aiLab.store.forUser(key);
  const at = new Date().toISOString();
  const stub = (id, status) => ({ id, experimentId: 'exp_AAAAAAAAAAAAAAAA', version: 1, codeHash: 'a'.repeat(64), language: 'javascript', status, stage: status === 'queued' ? 'input' : 'execution', failure: null,
    sandbox: { id: 'sbx_AAAAAAAAAAAAAAAA', version: 1, sha256: 'b'.repeat(64), split: 'all', recordCount: 0, recordIdsHash: '' }, config: {}, engine: null, isolation: null,
    security: { policy: null, review: null, acknowledged: false }, log: [], logTruncated: false, timing: { queuedAt: at, startedAt: status === 'queued' ? null : at, finishedAt: null, durationMs: null, bootMs: null },
    resources: null, output: null, metrics: null, createdAt: at });
  u.put('xruns', stub('xrn_RecoverQueued001', 'queued'));
  u.put('xruns', stub('xrn_RecoverRunning01', 'running'));
  srv.aiLab.experiments.start();
  for (const id of ['xrn_RecoverQueued001', 'xrn_RecoverRunning01']) {
    const r = await as('ultra2').get('/api/lab/xruns/' + id);
    assert.equal(r.json.run.status, 'interrupted');
    assert.equal(r.json.run.failure.type, 'interrupted');
    assert.ok(r.json.run.timing.finishedAt);
    assert.match(r.json.run.log[0].text, /server restarted/);
    assert.equal(r.json.run.logTotal, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'lab', 'users', key, 'xruns', id, 'log.json'), 'utf8')).length, 1);
  }
  // Recovery read the runs without keeping any of them (or anyone's) in memory
  for (const k of srv.aiLab.store.userKeys()) assert.equal(srv.aiLab.store.forUser(k).cache.has('xruns'), false, k);
});
