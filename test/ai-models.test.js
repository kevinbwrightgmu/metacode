// Which AI models MetaCode offers (server.js's model list, ai-lab/providers.js):
// emis-models.json is the catalog, checked against the AI service's own list
// (GET /models) so models the service doesn't offer are marked rather than
// presented as plainly usable; unknown model ids never reach the service;
// keys never reach the browser. Uses a stand-in AI service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { testEnv } = require('./helpers/harness');

const KEY = 'emis-test-key-models-0123456789';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-models-'));
const modelsFile = path.join(tmp, 'emis-models.json');
const svc = { list: 'ok', listCalls: 0, chats: [] };
let emis, server, base, mod;

test.before(async () => {
  emis = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') {
        svc.listCalls++;
        if (svc.list === 'down') { res.statusCode = 503; return res.end('{"error":{"message":"maintenance"}}'); }
        return res.end(JSON.stringify({ data: [{ id: 'model-one' }, { id: 'model-three' }, { id: 'model-extra' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        const j = JSON.parse(body || '{}');
        svc.chats.push(j.model);
        return res.end(JSON.stringify({ id: 'x', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok from ' + j.model }, finish_reason: 'stop' }] }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => emis.listen(0, '127.0.0.1', r));
  const emisBase = 'http://127.0.0.1:' + emis.address().port + '/v1';
  // The operator's catalog: three models (one the service no longer lists), the key only as an env reference
  fs.writeFileSync(modelsFile, JSON.stringify({ provider: { emis: { options: { baseURL: emisBase, apiKey: '{env:EMIS_API_KEY}' }, models: {
    'model-one': { name: 'Model One', tool_call: true, reasoning: false, attachment: false, limit: { context: 128000, output: 8192 } },
    'model-two': { name: 'Model Two', tool_call: false, reasoning: true },
    'model-three': { name: 'Model Three' }
  } } } }));
  Object.assign(process.env, testEnv({
    EMIS_BASE_URL: emisBase, EMIS_API_KEY: KEY, EMIS_TRANSPORT: 'node', EMIS_MODELS_FILE: modelsFile, EMIS_MODEL: '',
    SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ACCOUNT_DATA_DIR: path.join(tmp, 'a'), SURVEY_DATA_DIR: path.join(tmp, 's'), PROJECT_DATA_DIR: path.join(tmp, 'p'), DESKTOP_RELEASES_REPO: 'off'
  }));
  mod = require('../server');
  server = await mod.start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (emis) { emis.closeAllConnections(); await new Promise(r => emis.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async p => { const r = await fetch(base + p); const text = await r.text(); return { status: r.status, text, json: JSON.parse(text) }; };

test('the catalog\'s models are checked against the service\'s own list: offered ones are marked, the others flagged, none hidden', async () => {
  svc.list = 'ok';
  const r = await get('/api/models');
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'emis-models.json');
  assert.deepEqual(r.json.models.map(m => [m.id, m.available]), [['model-one', true], ['model-two', false], ['model-three', true]], 'the catalog\'s order; model-extra (service only) isn\'t added');
  const one = r.json.models[0];
  assert.deepEqual([one.toolCall, one.reasoning, one.attachment, one.contextWindow, one.maxOutput], [true, false, false, 128000, 8192], 'capabilities from the catalog, never guessed');
  assert.equal(r.json.models[2].toolCall, undefined, 'unknown capabilities are left out, not assumed');
  assert.equal(r.json.availability.checked, true);
  assert.equal(r.json.availability.listed, 2);
  assert.deepEqual(r.json.availability.notListed, ['model-two']);
  assert.match(r.json.availability.at, /^\d{4}-\d\d-\d\dT/);
  assert.ok(!r.text.includes(KEY) && !/EMIS_API_KEY|apiKey/.test(r.text), 'no key or key reference reaches the browser');
});

test('when the service\'s list can\'t be read, availability is "unknown" (no model is marked unavailable) and the catalog still works', async () => {
  svc.list = 'down';
  try {
    const r = await get('/api/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.models.map(m => m.id), ['model-one', 'model-two', 'model-three']);
    assert.ok(r.json.models.every(m => !('available' in m)), 'not marked either way');
    assert.equal(r.json.availability.checked, false);
    assert.match(r.json.availability.note, /Couldn't check which models the AI service offers right now/);
    assert.ok(!r.text.includes(KEY));
  } finally { svc.list = 'ok'; }
});

test('a model id that isn\'t in the catalog never reaches the service (the default is used); catalog models are sent as asked', async () => {
  svc.chats.length = 0;
  const ask = model => fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }) }).then(r => r.json());
  const a = await ask('model-three');
  assert.match(JSON.stringify(a), /ok from model-three/);
  const b = await ask('gpt-made-up-9000');
  assert.match(JSON.stringify(b), /ok from model-one/, 'the default (first in the catalog)');
  const c = await ask('../../etc/passwd');
  assert.match(JSON.stringify(c), /ok from model-one/);
  assert.deepEqual(svc.chats, ['model-three', 'model-one', 'model-one'], 'only catalog ids were sent');
});

test('the AI Coding Lab sees the same availability (from the cached check, so Lab requests never wait for it)', async () => {
  await get('/api/models');                      // a fresh check is cached
  const calls = svc.listCalls;
  const lab = mod.aiLab;
  assert.ok(lab && lab.registry, 'the Lab exposes its provider registry');
  const cat = await lab.registry.catalog();
  const mc = cat.find(p => p.provider === 'metacode');
  assert.deepEqual(mc.models.map(m => [m.id, m.available]), [['model-one', true], ['model-two', false], ['model-three', true]]);
  assert.equal(mc.models[0].contextWindow, 128000);
  assert.equal(svc.listCalls, calls, 'answered from the cache');
  // An unknown model is refused by the Lab before any request
  await assert.rejects(lab.registry.resolve('metacode', 'not-a-model'), e => e.type === 'model_unavailable');
});

const chromium = (() => { try { const p = require('playwright-core').chromium.executablePath(); return fs.existsSync(p) ? p : (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null); } catch (e) { return fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null; } })();

test('Settings: models the service doesn\'t offer are marked in every model picker, with a summary', { skip: !chromium && 'no Chromium', timeout: 60000 }, async () => {
  const browser = await require('playwright-core').chromium.launch({ executablePath: chromium });
  try {
    const page = await browser.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.abort());
    await page.goto(base + '/app.html#settings');
    await page.waitForFunction(() => document.querySelectorAll('#s-model option').length > 2);
    const opts = await page.$$eval('#s-model option', os => os.map(o => [o.value, o.textContent]));
    assert.deepEqual(opts.find(o => o[0] === 'model-two'), ['model-two', 'Model Two — not offered by the AI service now']);
    assert.ok(!/not offered/.test(opts.find(o => o[0] === 'model-three')[1]));
    assert.match(await page.textContent('#s-model-hint'), /3 models in emis-models\.json; 2 offered by the AI service now, 1 not \(marked\)\./);
    const feature = await page.$$eval('#s-feature-models select option', os => os.filter(o => o.value === 'model-two').map(o => o.textContent));
    assert.ok(feature.length && feature.every(t => /not offered/.test(t)), 'per-feature pickers too');
  } finally { await browser.close(); }
});
