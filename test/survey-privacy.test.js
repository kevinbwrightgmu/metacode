// Respondent information, derived metadata and session timelines (surveys/index.js):
// what is stored, only what the published survey says it collects, only with
// disclosure, visible only to the survey's owner, and erasable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Core = require('../public/js/survey/survey-core.js');
const { createSurveys, cleanEvent, geoConfig } = require('../surveys');

const ME = 'mc_owner=' + 'c'.repeat(48);
const OTHER = 'mc_owner=' + 'd'.repeat(48);
const servers = [];
let dataDir;

async function startServer(opts, trust) {
  const surveys = createSurveys(Object.assign({ dataDir, rateLimit: 500 }, opts));
  const app = express();
  if (trust) app.set('trust proxy', trust);
  app.use('/api/surveys', surveys.router);
  app.use('/api/public/surveys', surveys.publicRouter);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, headers) => {
    const res = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json', cookie: ME }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text };
  };
  return { base, call };
}
test.before(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-privacy-')); });
test.after(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// One question and a Respondent information block, with the given settings.
function surveyDoc(fields, recording) {
  const doc = Core.createSurvey({ title: 'Privacy test' });
  const page = doc.pages[0];
  const add = type => {
    const t = Core.buildElement(type);
    Object.values(t.elements).forEach(e => { doc.elements[e.id] = e; });
    const el = doc.elements[t.rootId];
    el.parent = 'page:' + page.id;
    page.children.splice(page.children.length - 1, 0, el.id);
    return el;
  };
  const q = add('single');
  q.behavior.dataKey = 'q1';
  const block = add('respondent');
  block.props.fields = fields;
  doc.settings.sessionRecording = recording || 'off';
  return { doc, q, value: Core.questionParts(doc, q.id, 'option')[0].props.value };
}
async function publish(call, doc) {
  const created = await call('POST', '/api/surveys', { doc });
  const id = created.json.survey.id;
  const pub = await call('POST', '/api/surveys/' + id + '/publish', {});
  assert.equal(pub.status, 200, pub.text);
  return { id, publicId: pub.json.publish.publicId, version: pub.json.publish.version };
}

test('the core model: privacy summary, disclosure text and safe defaults', () => {
  const b = Core.buildElement('respondent');
  const cfg = Core.respondentConfig(b.elements[b.rootId]);
  assert.deepEqual(Object.keys(cfg.fields), ['name', 'participantId', 'country', 'region', 'ip']);
  assert.equal(cfg.fields.name.on, false);
  assert.equal(cfg.fields.ip.on, false, 'IP collection is off by default');
  assert.equal(cfg.fields.participantId.from, 'entered');
  const { doc } = surveyDoc({ ip: { on: true }, country: { on: true }, participantId: { on: true, from: 'link', param: 'p<id>', show: false } }, 'consent');
  const clean = Core.normalizeDoc(doc).doc;
  const priv = Core.privacyOf(clean);
  assert.deepEqual(priv.derived, { ip: true, country: true, region: false });
  assert.deepEqual(priv.link, { param: 'pid', show: false, required: false }, 'unsafe characters are removed from the link parameter');
  assert.equal(priv.session, 'consent');
  assert.match(Core.derivedNotice(priv), /your IP address and your approximate location \(country, estimated from your IP address\)/);
  assert.equal(Core.derivedNotice({ derived: { ip: false, country: false, region: false } }), '');
  assert.equal(Core.normalizeDoc(Object.assign({}, clean, { settings: Object.assign({}, clean.settings, { sessionRecording: 'secret' }) })).doc.settings.sessionRecording, 'off');
});

test('participant fields and server-derived metadata are stored only as configured; geolocation only from trusted headers', async () => {
  const { call } = await startServer({ geoHeaders: 'cloudflare' });
  const { doc, q, value } = surveyDoc({ name: { on: true, label: 'Name', required: true }, participantId: { on: true, from: 'entered' }, country: { on: true }, region: { on: true }, ip: { on: true } });
  const { id, publicId, version } = await publish(call, doc);
  const geo = { 'cf-ipcountry': 'us', 'cf-region': 'California<script>' };
  // required name is checked on completion
  const missing = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version, complete: true, answers: { [q.id]: value }, respondent: { participantId: 'P1' } }, geo);
  assert.equal(missing.status, 422);
  assert.match(missing.json.error.message, /Name is required/);
  const ok = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version, complete: true, answers: { [q.id]: value }, respondent: { name: '  Ada Lovelace ', participantId: 'P-0042', extra: 'ignored' } }, geo);
  assert.equal(ok.status, 201, ok.text);
  const r = (await call('GET', '/api/surveys/' + id + '/responses')).json.responses[0];
  assert.deepEqual(r.respondent, { name: 'Ada Lovelace', participantId: 'P-0042', participantIdSource: 'entered', derived: { ip: '127.0.0.1', geoSource: 'cloudflare', country: 'US', region: 'Californiascript' } });
  assert.equal(r.answers[q.id], value);
  assert.equal(r.session, undefined, 'no timeline when recording is off');
  // The public API never returns it, other browsers can't read it
  const pub = await call('GET', '/api/public/surveys/' + publicId);
  assert.doesNotMatch(pub.text, /P-0042|127\.0\.0\.1|Lovelace/);
  assert.equal((await call('GET', '/api/surveys/' + id + '/responses', undefined, { cookie: OTHER })).status, 404);
});

test('without SURVEY_GEO_HEADERS, location headers are ignored; behind an untrusted proxy the IP is not guessed', async () => {
  const plain = await startServer({ geoHeaders: '' });
  const { doc, q, value } = surveyDoc({ participantId: { on: false }, country: { on: true }, ip: { on: true } });
  const a = await publish(plain.call, doc);
  await plain.call('POST', '/api/public/surveys/' + a.publicId + '/responses', { version: a.version, complete: true, answers: { [q.id]: value } }, { 'cf-ipcountry': 'FR', 'x-forwarded-for': '203.0.113.9' });
  const r = (await plain.call('GET', '/api/surveys/' + a.id + '/responses')).json.responses[0];
  assert.deepEqual(r.respondent, { derived: { ip: null, ipNote: 'behind_proxy', geoNote: 'not_configured' } });

  const proxied = await startServer({ geoHeaders: 'X-Country,X-Region' }, 'loopback');
  const b = await publish(proxied.call, doc);
  await proxied.call('POST', '/api/public/surveys/' + b.publicId + '/responses', { version: b.version, complete: true, answers: { [q.id]: value } }, { 'x-country': 'de', 'x-forwarded-for': '203.0.113.9' });
  const r2 = (await proxied.call('GET', '/api/surveys/' + b.id + '/responses')).json.responses[0];
  assert.deepEqual(r2.respondent.derived, { ip: '203.0.113.9', geoSource: 'header', country: 'DE' }, 'TRUST_PROXY: the forwarded address is the respondent');
  assert.deepEqual(geoConfig('cloudflare'), { country: 'cf-ipcountry', region: 'cf-region', source: 'cloudflare' });
  assert.equal(geoConfig(''), null);
});

test('a participant code from the link is stored as such; nothing identifying is kept when the survey doesn\'t ask', async () => {
  const { call } = await startServer({});
  const linked = surveyDoc({ participantId: { on: true, from: 'link', param: 'pid', show: false, required: true } });
  const a = await publish(call, linked.doc);
  const nope = await call('POST', '/api/public/surveys/' + a.publicId + '/responses', { version: a.version, complete: true, answers: { [linked.q.id]: linked.value } });
  assert.equal(nope.status, 422, 'required participant code');
  await call('POST', '/api/public/surveys/' + a.publicId + '/responses', { version: a.version, complete: true, answers: { [linked.q.id]: linked.value }, respondent: { participantId: 'PANEL-7' } });
  const r = (await call('GET', '/api/surveys/' + a.id + '/responses')).json.responses[0];
  assert.deepEqual(r.respondent, { participantId: 'PANEL-7', participantIdSource: 'link' });

  const anon = surveyDoc({ participantId: { on: false } });
  const b = await publish(call, anon.doc);
  await call('POST', '/api/public/surveys/' + b.publicId + '/responses', { version: b.version, complete: true, answers: { [anon.q.id]: anon.value }, respondent: { name: 'Sneaky', participantId: 'X' } }, { 'cf-ipcountry': 'US' });
  const r2 = (await call('GET', '/api/surveys/' + b.id + '/responses')).json.responses[0];
  assert.equal(r2.respondent, undefined, 'an anonymous survey stores nothing about the respondent');
});

test('session events: stored only when the survey records with disclosure, cleaned, capped, appended with the token, and never when declined', async () => {
  const { call } = await startServer({});
  const { doc, q, value } = surveyDoc({ participantId: { on: false } }, 'consent');
  const { id, publicId, version } = await publish(call, doc);
  const events = [{ t: 0, type: 'start', page: doc.pages[0].id }, { t: 500, type: 'answer', q: q.id, value }, { t: 900, type: 'answer', q: q.id, len: 12 },
    { t: 1000, type: 'evil', q: q.id }, { t: -5, type: 'page' }, { t: 1100, type: 'page', page: 'x"><script>', dir: 'sideways' }, { t: 1200, type: 'invalid', qs: [q.id, '<bad>'] }];
  const first = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version, complete: false, answers: {}, events, session: { recording: 'consent', startedAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(first.status, 201);
  const { responseId, token } = first.json;
  let r = (await call('GET', '/api/surveys/' + id + '/responses')).json.responses[0];
  assert.equal(r.session.recording, 'consent');
  assert.deepEqual(r.session.events.map(e => e.type), ['start', 'answer', 'answer', 'page', 'invalid']);
  assert.deepEqual(r.session.events[3], { t: 1100, type: 'page' }, 'unsafe ids and unknown directions are dropped');
  assert.deepEqual(r.session.events[4].qs, [q.id]);
  // keepalive events need the response token
  assert.equal((await call('POST', '/api/public/surveys/' + publicId + '/responses/' + responseId + '/events', { token: 'wrong', events: [{ t: 2000, type: 'away' }] })).status, 404);
  assert.equal((await call('POST', '/api/public/surveys/' + publicId + '/responses/' + responseId + '/events', { token, events: [{ t: 2000, type: 'away' }, { t: 2600, type: 'back' }] })).json.recorded, 2);
  await call('PUT', '/api/public/surveys/' + publicId + '/responses/' + responseId, { token, version, complete: true, answers: { [q.id]: value }, events: [{ t: 3000, type: 'submit' }], session: { recording: 'consent' } });
  r = (await call('GET', '/api/surveys/' + id + '/responses')).json.responses[0];
  assert.deepEqual(r.session.events.slice(-3).map(e => e.type), ['away', 'back', 'submit']);
  assert.equal((await call('POST', '/api/public/surveys/' + publicId + '/responses/' + responseId + '/events', { token, events: [{ t: 4000, type: 'away' }] })).status, 409, 'nothing is added after submission');
  // declined: the respondent said no, so nothing is recorded
  const declined = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version, complete: true, answers: { [q.id]: value }, events, session: { recording: 'declined' } });
  const all = (await call('GET', '/api/surveys/' + id + '/responses')).json.responses;
  const d = all.find(x => x.id === declined.json.responseId);
  assert.deepEqual(d.session, { recording: 'declined', startedAt: d.startedAt, events: [] });
  // a survey that doesn't record ignores events
  const off = surveyDoc({ participantId: { on: false } }, 'off');
  const o = await publish(call, off.doc);
  await call('POST', '/api/public/surveys/' + o.publicId + '/responses', { version: o.version, complete: true, answers: { [off.q.id]: off.value }, events, session: { recording: 'consent' } });
  assert.equal((await call('GET', '/api/surveys/' + o.id + '/responses')).json.responses[0].session, undefined);
  // the cap
  const many = Array.from({ length: 3200 }, (_, i) => ({ t: i, type: 'focus', q: q.id }));
  const big = await call('POST', '/api/public/surveys/' + publicId + '/responses', { version, complete: false, answers: {}, events: many, session: { recording: 'consent' } });
  const b = (await call('GET', '/api/surveys/' + id + '/responses')).json.responses.find(x => x.id === big.json.responseId);
  assert.equal(b.session.events.length, 3000);
  assert.equal(cleanEvent({ t: 1, type: 'answer', q: 'q_1', value: 'x'.repeat(2000) }).value, '[long value]');
});

test('erase: IP addresses, location, identity fields and timelines can be removed from every response by the owner only', async () => {
  const { call } = await startServer({ geoHeaders: 'cloudflare' });
  const { doc, q, value } = surveyDoc({ name: { on: true }, participantId: { on: true }, country: { on: true }, ip: { on: true } }, 'notice');
  const { id, publicId, version } = await publish(call, doc);
  await call('POST', '/api/public/surveys/' + publicId + '/responses', { version, complete: true, answers: { [q.id]: value }, respondent: { name: 'N', participantId: 'P' }, events: [{ t: 0, type: 'start' }], session: { recording: 'notice' } }, { 'cf-ipcountry': 'CA' });
  assert.equal((await call('POST', '/api/surveys/' + id + '/responses/erase', { what: 'ip' }, { cookie: OTHER })).status, 404);
  assert.equal((await call('POST', '/api/surveys/' + id + '/responses/erase', { what: 'everything' })).status, 400);
  for (const what of ['ip', 'location', 'identity', 'timeline']) assert.equal((await call('POST', '/api/surveys/' + id + '/responses/erase', { what })).json.updated, 1);
  const r = (await call('GET', '/api/surveys/' + id + '/responses')).json.responses[0];
  assert.deepEqual(r.respondent, { derived: { geoSource: 'cloudflare', ipErased: true, locationErased: true }, identityErased: true });
  assert.deepEqual(r.session.events, []);
  assert.equal(r.session.erased, true);
  assert.equal(r.answers[q.id], value, 'answers are kept');
});
