// Integration tests for the Survey Studio HTTP API (surveys/index.js) on its
// own Express server with a temporary data directory: drafts and autosave
// conflicts, publishing and versions, public response collection, and the
// guards on both routers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Core = require('../public/js/survey/survey-core.js');
const { createSurveys } = require('../surveys');

let server, base, dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-surveys-'));
  const surveys = createSurveys({ dataDir, rateLimit: 40 });
  const app = express();
  app.use('/api/surveys', surveys.router);
  app.use('/api/public/surveys', surveys.publicRouter);
  app.get('/s/:publicId', surveys.pageHandler);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Each browser has its own identity (the mc_owner cookie, owner.js); these tests are one browser.
const ME = 'mc_owner=' + 'a'.repeat(48);
const OTHER = 'mc_owner=' + 'b'.repeat(48);
async function call(method, url, body, headers) {
  const res = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json', cookie: ME }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// A survey with one required single-choice question and a follow-up that
// only shows (and is only accepted) when the first answer is "option_a".
function surveyDoc() {
  const doc = Core.createSurvey({ title: 'API test' });
  const page = doc.pages[0];
  const add = type => {
    const t = Core.buildElement(type);
    Object.values(t.elements).forEach(e => { doc.elements[e.id] = e; });
    const q = doc.elements[t.rootId];
    q.parent = 'page:' + page.id;
    page.children.splice(page.children.length - 1, 0, q.id);
    return q;
  };
  const q1 = add('single');
  q1.behavior.required = true;
  q1.behavior.dataKey = 'q1';
  const q2 = add('shorttext');
  q2.behavior.dataKey = 'q2';
  const first = Core.questionParts(doc, q1.id, 'option')[0].props.value;
  doc.rules.push({ id: 'rule_show', name: 'Show follow-up', enabled: true, trigger: { type: 'always' },
    when: { op: 'all', items: [{ id: 'c1', left: { kind: 'answer', ref: q1.id }, cmp: 'eq', right: { kind: 'value', value: first } }] },
    then: [{ type: 'show', target: q2.id }], else: [] });
  return { doc, q1, q2, first };
}

test('create, list, load, autosave with revisions, conflict, duplicate and delete', async () => {
  const created = await call('POST', '/api/surveys', { title: 'My survey' });
  assert.equal(created.status, 201);
  const rec = created.json.survey;
  assert.equal(rec.doc.title, 'My survey');
  assert.equal(rec.revision, 1);

  const list = await call('GET', '/api/surveys');
  assert.ok(list.json.surveys.some(s => s.id === rec.id));
  assert.equal(list.json.dataDir, undefined, 'the server path is not exposed');

  const doc = rec.doc;
  doc.title = 'Renamed';
  const saved = await call('PUT', '/api/surveys/' + rec.id, { doc, baseRevision: 1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.revision, 2);

  const stale = await call('PUT', '/api/surveys/' + rec.id, { doc, baseRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.type, 'conflict');
  assert.equal(stale.json.revision, 2);
  const forced = await call('PUT', '/api/surveys/' + rec.id, { doc, baseRevision: 1, force: true });
  assert.equal(forced.status, 200);

  const loaded = await call('GET', '/api/surveys/' + rec.id);
  assert.equal(loaded.json.survey.doc.title, 'Renamed');

  const dup = await call('POST', '/api/surveys/' + rec.id + '/duplicate');
  assert.equal(dup.status, 201);
  assert.notEqual(dup.json.survey.id, rec.id);
  assert.equal(dup.json.survey.doc.title, 'Renamed (copy)');

  assert.equal((await call('DELETE', '/api/surveys/' + dup.json.survey.id)).status, 200);
  assert.equal((await call('GET', '/api/surveys/' + dup.json.survey.id)).status, 404);
  assert.ok(fs.readdirSync(path.join(dataDir, 'trash')).length >= 1, 'deleted surveys go to the trash folder');
});

test('imported documents are repaired and get a fresh id', async () => {
  const res = await call('POST', '/api/surveys', { doc: { id: '../../etc', title: 'Imported', pages: [], elements: { x: { type: 'heading', props: { text: 'Hi' } } } } });
  assert.equal(res.status, 201);
  assert.notEqual(res.json.survey.id, '../../etc');
  assert.match(res.json.survey.id, /^[A-Za-z0-9_]+$/);
  assert.equal(res.json.survey.doc.elements.x.props.text, 'Hi');
  assert.ok(res.json.problems.length > 0);
});

test('editor routes refuse cross-site requests and bad input without leaking internals', async () => {
  const other = await call('POST', '/api/surveys', { title: 'x' }, { origin: 'https://evil.example' });
  assert.equal(other.status, 403);
  assert.equal(other.json.error.type, 'forbidden_origin');
  const site = await call('POST', '/api/surveys', { title: 'x' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(site.status, 403);
  const bad = await fetch(base + '/api/surveys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  const badText = await bad.text();
  assert.ok(!badText.includes(dataDir) && !/at .*\.js:\d+/.test(badText), 'no paths or stack traces in errors');
  const missing = await call('GET', '/api/surveys/nope');
  assert.equal(missing.status, 404);
  assert.ok(!missing.text.includes(dataDir));
});

test('publish → public fetch → submit (validated) → stored with version; republish keeps old versions', async () => {
  const { doc, q1, q2, first } = surveyDoc();
  const rec = (await call('POST', '/api/surveys', { doc })).json.survey;

  // Unpublished surveys aren't reachable publicly
  const pub = await call('POST', '/api/surveys/' + rec.id + '/publish', {});
  assert.equal(pub.status, 200);
  assert.equal(pub.json.publish.version, 1);
  const publicId = pub.json.publish.publicId;
  assert.match(publicId, /^[A-Za-z0-9]{10,}$/);
  assert.equal(pub.json.url, '/s/' + publicId);

  const page = await fetch(base + '/s/' + publicId);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);

  const pv = await call('GET', '/api/public/surveys/' + publicId);
  assert.equal(pv.status, 200);
  assert.equal(pv.json.survey.version, 1);
  assert.equal(pv.json.survey.open, true);
  assert.ok(pv.json.survey.doc.elements[q1.id]);
  assert.equal(pv.json.survey.doc.meta && pv.json.survey.doc.meta.owner, undefined);

  // Missing required answer → 422
  const missing = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version: 1, answers: {}, complete: true });
  assert.equal(missing.status, 422);
  assert.deepEqual(missing.json.problems.map(p => p.question), [q1.id]);

  // Progress save, then completion with the token
  const started = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version: 1, answers: { [q1.id]: first }, complete: false });
  assert.equal(started.status, 201);
  assert.equal(started.json.status, 'in_progress');
  const { responseId, token } = started.json;
  const wrongToken = await call('PUT', '/api/public/surveys/' + publicId + '/responses/' + responseId, { token: 'x', answers: {}, complete: true });
  assert.equal(wrongToken.status, 404);
  const done = await call('PUT', '/api/public/surveys/' + publicId + '/responses/' + responseId,
    { token, answers: { [q1.id]: first, [q2.id]: 'Because it works', injected: '<script>' }, complete: true });
  assert.equal(done.status, 200);
  assert.equal(done.json.status, 'complete');
  const again = await call('PUT', '/api/public/surveys/' + publicId + '/responses/' + responseId, { token, answers: {}, complete: true });
  assert.equal(again.status, 409);

  // An answer to a question that logic hides is not stored
  const other = Core.questionParts(doc, q1.id, 'option')[1].props.value;
  const hidden = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version: 1, answers: { [q1.id]: other, [q2.id]: 'should be dropped' }, complete: true });
  assert.equal(hidden.status, 201);

  const responses = (await call('GET', '/api/surveys/' + rec.id + '/responses')).json.responses;
  assert.equal(responses.length, 2);
  const [a, b] = responses;
  assert.equal(a.status, 'complete');
  assert.equal(a.version, 1);
  assert.deepEqual(a.byKey, { q1: first, q2: 'Because it works' });
  assert.equal(a.tokenHash, undefined, 'token hashes are never returned');
  assert.deepEqual(b.byKey, { q1: other });

  // Re-publish an edited survey: new version, same link, old version still stored
  doc.title = 'API test v2';
  const pub2 = await call('POST', '/api/surveys/' + rec.id + '/publish', { doc, baseRevision: rec.revision });
  assert.equal(pub2.status, 200);
  assert.equal(pub2.json.publish.version, 2);
  assert.equal(pub2.json.publish.publicId, publicId);
  const versions = (await call('GET', '/api/surveys/' + rec.id + '/versions')).json.versions;
  assert.deepEqual(versions.map(v => v.version).sort(), [1, 2]);
  assert.equal((await call('GET', '/api/surveys/' + rec.id + '/versions/1')).json.version.doc.title, 'API test');
  assert.equal((await call('GET', '/api/public/surveys/' + publicId)).json.survey.doc.title, 'API test v2');

  // Close → submissions refused; reopen; unpublish → link dead
  assert.equal((await call('PATCH', '/api/surveys/' + rec.id + '/publish', { open: false })).status, 200);
  const closed = await call('POST', '/api/public/surveys/' + publicId + '/responses', { answers: { [q1.id]: first }, complete: true });
  assert.equal(closed.status, 403);
  assert.equal((await call('PATCH', '/api/surveys/' + rec.id + '/publish', { open: true })).status, 200);
  assert.equal((await call('DELETE', '/api/surveys/' + rec.id + '/publish')).status, 200);
  assert.equal((await call('GET', '/api/public/surveys/' + publicId)).status, 404);

  // Delete one response, then all
  assert.equal((await call('DELETE', '/api/surveys/' + rec.id + '/responses/' + a.id)).status, 200);
  const cleared = await call('DELETE', '/api/surveys/' + rec.id + '/responses');
  assert.equal(cleared.json.deleted, 1);
});

test('publishing is refused for empty surveys and broken logic', async () => {
  const empty = Core.createSurvey({ title: 'Empty' });
  Object.values(empty.elements).filter(e => e.type === 'heading' || e.type === 'paragraph').forEach(e => { e.hidden = true; });
  const rec = (await call('POST', '/api/surveys', { doc: empty })).json.survey;
  const res = await call('POST', '/api/surveys/' + rec.id + '/publish', {});
  assert.equal(res.status, 400);
  assert.equal(res.json.error.type, 'empty_survey');

  const { doc } = surveyDoc();
  doc.rules[0].then = [{ type: 'show', target: 'el_does_not_exist' }];
  const rec2 = (await call('POST', '/api/surveys', { doc })).json.survey;
  const bad = await call('POST', '/api/surveys/' + rec2.id + '/publish', {});
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.type, 'logic_problems');
  assert.ok(bad.json.problems.length >= 1);
});

test('library round-trips and is filtered', async () => {
  const put = await call('PUT', '/api/surveys/library', { library: { components: [{ id: 'c1', name: 'Card' }, 'junk'], styles: [{ id: 's1', style: { color: 'red' } }] } });
  assert.equal(put.status, 200);
  const lib = (await call('GET', '/api/surveys/library')).json.library;
  assert.deepEqual(lib.components.map(c => c.id), ['c1']);
  assert.deepEqual(lib.styles.map(s => s.id), ['s1']);
});

test('randomization: balanced assignment counts come with the public survey and conditions are stored', async () => {
  const { doc, q1, first } = surveyDoc();
  doc.variables.push({ id: 'v_cond', name: 'condition', type: 'text', initial: '', formula: '' });
  doc.rules.push({ id: 'rule_rand', name: 'Assign', enabled: true, trigger: { type: 'always' }, when: { op: 'all', items: [] }, else: [],
    then: [{ type: 'assign', name: 'condition', method: 'balanced', options: ['control', 'treatment'] }] });
  const rec = (await call('POST', '/api/surveys', { doc })).json.survey;
  const publicId = (await call('POST', '/api/surveys/' + rec.id + '/publish', {})).json.publish.publicId;
  const pv = await call('GET', '/api/public/surveys/' + publicId);
  assert.deepEqual(pv.json.survey.balance, { condition: {} });
  const sent = await call('POST', '/api/public/surveys/' + publicId + '/responses',
    { version: 1, answers: { [q1.id]: first }, varState: { __seed: 's1', condition: 'treatment' }, complete: true });
  assert.equal(sent.status, 201);
  const tampered = await call('POST', '/api/public/surveys/' + publicId + '/responses',
    { version: 1, answers: { [q1.id]: first }, varState: { __seed: 's2', condition: 'not-a-condition' }, complete: true });
  assert.equal(tampered.status, 201);
  const responses = (await call('GET', '/api/surveys/' + rec.id + '/responses')).json.responses;
  assert.equal(responses[0].vars.condition, 'treatment');
  assert.ok(['control', 'treatment'].includes(responses[1].vars.condition));
  assert.equal(responses[0].vars.__seed, undefined);
  const counts = (await call('GET', '/api/public/surveys/' + publicId)).json.survey.balance.condition;
  assert.equal((counts.control || 0) + (counts.treatment || 0), 2);
  assert.ok(counts.treatment >= 1);
});

test('surveys belong to the browser that made them; other browsers get 404s and empty lists', async () => {
  const { doc, q1, first } = surveyDoc();
  const rec = (await call('POST', '/api/surveys', { doc })).json.survey;
  assert.equal(rec.owner, undefined, 'the owner hash isn\'t sent back');
  const pub = await call('POST', '/api/surveys/' + rec.id + '/publish', {});
  assert.equal(pub.status, 200);
  const other = { cookie: OTHER };
  assert.ok(!(await call('GET', '/api/surveys', undefined, other)).json.surveys.some(x => x.id === rec.id));
  for (const [m, u, b] of [['GET', ''], ['PUT', '', { doc }], ['DELETE', ''], ['GET', '/responses'], ['DELETE', '/responses'], ['GET', '/versions'], ['GET', '/versions/1'], ['PATCH', '/publish', { open: false }], ['DELETE', '/publish'], ['POST', '/duplicate', {}]]) {
    assert.equal((await call(m, '/api/surveys/' + rec.id + u, b, other)).status, 404, m + ' ' + u);
  }
  // …and can't publish over it either
  assert.equal((await call('POST', '/api/surveys/' + rec.id + '/publish', { doc }, other)).status, 404);
  // No identity at all: refused
  const anon = await call('GET', '/api/surveys', undefined, { cookie: '' });
  assert.equal(anon.status, 401);
  // Respondents need no identity
  const r = await fetch(base + '/api/public/surveys/' + pub.json.publish.publicId + '/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, answers: { [q1.id]: first }, complete: true }) });
  assert.equal(r.status, 201);
  assert.equal((await call('GET', '/api/surveys/' + rec.id + '/responses')).json.responses.length, 1);
  // Libraries are per browser too
  await call('PUT', '/api/surveys/library', { library: { components: [{ id: 'c1', name: 'Mine' }], styles: [], templates: [] } });
  assert.equal((await call('GET', '/api/surveys/library', undefined, other)).json.library.components.length, 0);
});

test('a draft kept in the browser is sent with its first publish', async () => {
  const { doc } = surveyDoc();
  doc.id = 'sv_localdraft01';
  const pub = await call('POST', '/api/surveys/' + doc.id + '/publish', { doc, force: true });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.publish.version, 1);
  const again = await call('POST', '/api/surveys/' + doc.id + '/publish', { doc: Object.assign({}, doc, { title: 'Edited' }), force: true });
  assert.equal(again.json.publish.version, 2);
  assert.equal((await call('GET', '/api/surveys/' + doc.id)).json.survey.doc.title, 'Edited');
  assert.equal((await call('POST', '/api/surveys/bad%20id!/publish', { doc })).status, 400);
});

test('surveys from older versions (no owner) can be claimed only from this computer', async () => {
  const { doc } = surveyDoc();
  doc.id = 'sv_legacy0001';
  const { SurveyStore } = require('../surveys/store');
  // written straight into the data folder, the way an older version stored it
  const st = new SurveyStore(dataDir);
  await st.writeJson(st.file('surveys', doc.id + '.json'), { id: doc.id, revision: 3, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z', doc, publish: null });
  // the running server indexed its folder already; a new router sees the file
  const surveys = require('../surveys').createSurveys({ dataDir, rateLimit: 40 });
  const app = express();
  app.use('/api/surveys', surveys.router);
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const b2 = 'http://127.0.0.1:' + srv.address().port;
  try {
    const get = (u, h) => fetch(b2 + u, { headers: Object.assign({ cookie: ME }, h || {}) });
    const list = await (await get('/api/surveys/legacy')).json();
    assert.deepEqual(list.surveys.map(x => x.id), [doc.id]);
    assert.equal((await get('/api/surveys/' + doc.id)).status, 404, 'nobody owns it yet');
    assert.equal((await get('/api/surveys/legacy', { 'x-forwarded-for': '203.0.113.9' })).status, 404, 'not through a proxy');
    const claim = await fetch(b2 + '/api/surveys/legacy/' + doc.id + '/claim', { method: 'POST', headers: { cookie: ME, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(claim.status, 200);
    const j = await claim.json();
    assert.equal(j.survey.revision, 3);
    assert.equal(j.survey.doc.title, 'API test');
    assert.equal((await get('/api/surveys/' + doc.id)).status, 200, 'now it is mine');
    assert.equal((await fetch(b2 + '/api/surveys/legacy/' + doc.id + '/claim', { method: 'POST', headers: { cookie: OTHER, 'content-type': 'application/json' }, body: '{}' })).status, 404, 'claimed only once');
  } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
});

test('public submissions are rate limited and unknown links are 404s', async () => {
  assert.equal((await call('GET', '/api/public/surveys/doesnotexist1')).status, 404);
  assert.equal((await fetch(base + '/s/bad$id')).status, 404);
  const { doc } = surveyDoc();
  const rec = (await call('POST', '/api/surveys', { doc })).json.survey;
  const publicId = (await call('POST', '/api/surveys/' + rec.id + '/publish', {})).json.publish.publicId;
  let limited = false;
  for (let i = 0; i < 60 && !limited; i++) {
    const r = await call('POST', '/api/public/surveys/' + publicId + '/responses', { answers: {}, complete: false });
    if (r.status === 429) limited = true;
  }
  assert.ok(limited, 'a burst of submissions is eventually refused with 429');
});
