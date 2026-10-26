// Which AI models MetaCode offers (server.js's model list, ai-lab/providers.js):
// the AI service's own list (GET /v1/models: "provider/model" ids with names,
// providers, free and availability flags and capabilities) is shown as it is,
// the default first, models the service doesn't offer right now marked rather
// than presented as plainly usable; unknown model ids never reach the
// service; nothing secret reaches the browser; no model name gives away which
// gateway is behind a provider. Uses a stand-in for the AI service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { testEnv } = require('./helpers/harness');

const TOKEN = 'test-service-token-0123456789';
const KEY = 'emis-test-key-models-0123456789';        // a provider's key, which the service must never pass on (here it does)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-models-'));
const PROVIDERS = [{ id: 'emis', name: 'AI gateway', ready: true }, { id: 'opencode', name: 'OpenCode Zen', ready: true }];
// An entry of the service's list (opencode/server.mjs)
const entry = (id, name, extra) => {
  const [provider, model] = id.split('/');
  return Object.assign({ id, object: 'model', created: 0, owned_by: provider, provider, provider_name: PROVIDERS.find(p => p.id === provider).name, model, name, free: false, available: true }, extra || {});
};
const STANDARD = [
  entry('emis/model-one', 'Model One', { tool_call: true, reasoning: false, attachment: false, context_window: 128000, max_output: 8192, options: { apiKey: KEY } }),
  entry('emis/model-two', 'Model Two', { tool_call: false, reasoning: true, available: false }),
  entry('emis/model-three', 'Model Three', { available: null, api_key: KEY }),
  entry('emis/plain-model', 'plain-model'),              // (a model only the gateway's live list has: named by its id)
  entry('opencode/big-pickle', 'Big Pickle', { free: true, default: true, tool_call: true, reasoning: true }),
  entry('opencode/model-one', 'Model One')
];
const svc = { list: 'ok', listCalls: 0, chats: [], models: STANDARD, default: 'opencode/big-pickle' };
let aiService, server, base, mod;

test.before(async () => {
  aiService = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.statusCode = 401; return res.end('{"error":{"type":"authentication_error","message":"MetaCode\'s OpenCode service needs its access token."}}'); }
      if (req.url === '/v1/status') return res.end(JSON.stringify({ ready: true, default: svc.default, warnings: [], providers: PROVIDERS }));
      if (req.url === '/v1/models') {
        svc.listCalls++;
        if (svc.list === 'down') { res.statusCode = 500; return res.end('{"error":{"type":"internal_error","message":"MetaCode\'s OpenCode service couldn\'t list its models."}}'); }
        return res.end(JSON.stringify({ object: 'list', default: svc.default, providers: PROVIDERS, data: svc.models }));
      }
      if (req.url === '/v1/chat/completions') {
        const j = JSON.parse(body || '{}');
        svc.chats.push(j.model);
        const [provider, model] = j.model.split('/');
        // The gateway throttles this model…
        if (provider === 'emis' && model === 'alias-2.1') { res.statusCode = 429; return res.end('{"error":{"message":"model busy"}}'); }
        // …can't run these right now (a server error each time)…
        if (provider === 'emis' && /^acme-(opus-5\.5|opus-4\.8|opus-4[.-]7)$/.test(model)) { res.statusCode = 502; return res.end('{"error":{"message":"upstream failed"}}'); }
        // …and doesn't offer this one any more, although the service still lists it
        if (provider === 'emis' && model === 'acme-opus-5.4') { res.statusCode = 404; return res.end('{"error":{"message":"The model acme-opus-5.4 does not exist"}}'); }
        return res.end(JSON.stringify({ id: 'x', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok from ' + j.model }, finish_reason: 'stop' }] }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => aiService.listen(0, '127.0.0.1', r));
  Object.assign(process.env, testEnv({
    OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + aiService.address().port + '/v1', OPENCODE_SERVICE_TOKEN: TOKEN,
    SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ACCOUNT_DATA_DIR: path.join(tmp, 'a'), SURVEY_DATA_DIR: path.join(tmp, 's'), PROJECT_DATA_DIR: path.join(tmp, 'p'), DESKTOP_RELEASES_REPO: 'off'
  }));
  delete process.env.OPENCODE_MODEL;
  delete process.env.EMIS_MODEL;
  mod = require('../server');
  server = await mod.start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (aiService) { aiService.closeAllConnections(); await new Promise(r => aiService.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async p => { const r = await fetch(base + p); const text = await r.text(); return { status: r.status, text, json: JSON.parse(text) }; };
const ask = model => fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 }) });
const answer = async model => JSON.stringify(await (await ask(model)).json());
// Runs fn while the service lists other models (all of the gateway, without a default of its own), then
// puts the standard list back. GET /api/models always asks the service, so MetaCode has the new list at once.
async function withModels(list, fn) {
  Object.assign(svc, { models: list.map(([id, name]) => entry(id, name)), default: null });
  await get('/api/models');
  try { await fn(); } finally { Object.assign(svc, { models: STANDARD, default: 'opencode/big-pickle' }); await get('/api/models'); }
}

test('the service\'s list as it is: the default first, then its order; names, providers, free and availability flags and capabilities; nothing else reaches the browser', async () => {
  const r = await get('/api/models');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.provider, r.json.source, r.json.note, r.json.availability], ['opencode', 'opencode', undefined, undefined]);
  assert.deepEqual(r.json.providers, [{ id: 'emis', name: 'AI gateway', ready: true }, { id: 'opencode', name: 'OpenCode Zen', ready: true }]);
  assert.deepEqual(r.json.models.map(m => [m.id, m.name, m.provider, m.providerName, m.free, m.available]), [
    ['opencode/big-pickle', 'Big Pickle (default)', 'opencode', 'OpenCode Zen', true, true],
    ['emis/model-one', 'Model One · AI gateway', 'emis', 'AI gateway', false, true],
    ['emis/model-two', 'Model Two', 'emis', 'AI gateway', false, false],
    ['emis/model-three', 'Model Three', 'emis', 'AI gateway', false, undefined],
    ['emis/plain-model', 'plain-model', 'emis', 'AI gateway', false, true],
    ['opencode/model-one', 'Model One · OpenCode Zen', 'opencode', 'OpenCode Zen', false, true]
  ], 'two providers\' models with one name are told apart by the provider\'s name; "available" is left out when the service doesn\'t know');
  const one = r.json.models[1];
  assert.deepEqual([one.toolCall, one.reasoning, one.attachment, one.contextWindow, one.maxOutput], [true, false, false, 128000, 8192], 'capabilities from the service, never guessed');
  assert.equal(r.json.models[3].toolCall, undefined, 'unknown capabilities are left out, not assumed');
  assert.ok(r.json.models.every(m => !/emis/i.test(m.name)) && r.json.providers.every(p => !/emis/i.test(p.name)), 'no name gives away the gateway');
  assert.ok(!r.text.includes(KEY) && !r.text.includes(TOKEN) && !/apiKey|api_key|options/.test(r.text), 'only the known fields: no key, key setting or token reaches the browser');
});

test('when the service can\'t give its list: no models and a note why; a chat still goes to the model asked for (the service decides)', async () => {
  svc.list = 'down';
  try {
    const r = await get('/api/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.models, []);
    assert.match(r.json.note, /couldn't list its models/);
    svc.chats.length = 0;
    assert.match(await answer('emis/model-three'), /ok from emis\/model-three/);
    assert.deepEqual(svc.chats, ['emis/model-three']);
  } finally { svc.list = 'ok'; await get('/api/models'); }
});

test('a model id the service doesn\'t list never reaches it (the default is used); listed ids are sent as asked; an id saved without its provider is the same model', async () => {
  svc.chats.length = 0;
  assert.match(await answer('emis/model-three'), /ok from emis\/model-three/);
  assert.match(await answer('gpt-made-up-9000'), /ok from opencode\/big-pickle/, 'the service\'s default');
  assert.match(await answer('../../etc/passwd'), /ok from opencode\/big-pickle/);
  const bare = await ask('model-three');
  assert.match(JSON.stringify(await bare.json()), /ok from emis\/model-three/);
  assert.equal(bare.headers.get('x-metacode-model-fallback'), null, 'the same model, so no "another model answered" note');
  assert.match(await answer('model-one'), /ok from emis\/model-one/, 'on two providers: the first in the service\'s order');
  assert.deepEqual(svc.chats, ['emis/model-three', 'opencode/big-pickle', 'opencode/big-pickle', 'emis/model-three', 'emis/model-one'], 'only listed ids were sent');
});

test('the AI Coding Lab sees the same models (from the cached list, so Lab requests never wait for it)', async () => {
  await get('/api/models');                      // a fresh list is cached
  const calls = svc.listCalls;
  const lab = mod.aiLab;
  assert.ok(lab && lab.registry, 'the Lab exposes its provider registry');
  const cat = await lab.registry.catalog();
  const mc = cat.find(p => p.provider === 'metacode');
  assert.deepEqual(mc.models.map(m => [m.id, m.name, m.available, m.isDefault]), [
    ['emis/model-one', 'Model One · AI gateway', true, false], ['emis/model-two', 'Model Two', false, false], ['emis/model-three', 'Model Three', null, false],
    ['emis/plain-model', 'plain-model', true, false], ['opencode/big-pickle', 'Big Pickle', true, true], ['opencode/model-one', 'Model One · OpenCode Zen', true, false]
  ]);
  assert.equal(mc.models[0].contextWindow, 128000);
  assert.equal(mc.models[0].capabilities.toolCalling, true);
  assert.equal(svc.listCalls, calls, 'answered from the cache');
  // An unknown model is refused by the Lab before any request; one saved without its provider is found
  await assert.rejects(lab.registry.resolve('metacode', 'not-a-model'), e => e.type === 'model_unavailable');
  assert.equal((await lab.registry.resolve('metacode', 'model-three')).id, 'emis/model-three');
});

const chromium = (() => { try { const p = require('playwright-core').chromium.executablePath(); return fs.existsSync(p) ? p : (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null); } catch (e) { return fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null; } })();

test('Settings: model pickers grouped by provider, free and not-offered models marked, with a summary — and no gateway name; saved ids without a provider are updated', { skip: !chromium && 'no Chromium', timeout: 60000 }, async () => {
  const browser = await require('playwright-core').chromium.launch({ executablePath: chromium });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.abort());
    await page.goto(base + '/app.html#settings');
    await page.waitForFunction(() => document.querySelectorAll('#s-model option').length > 2);
    assert.deepEqual(await page.$$eval('#s-model optgroup', gs => gs.map(g => g.label)), ['AI gateway', 'OpenCode Zen'], 'in the service\'s order');
    const opts = await page.$$eval('#s-model option', os => os.map(o => [o.value, o.textContent]));
    assert.deepEqual(opts.find(o => o[0] === 'emis/model-two'), ['emis/model-two', 'Model Two — not offered now']);
    assert.deepEqual(opts.find(o => o[0] === 'opencode/big-pickle'), ['opencode/big-pickle', 'Big Pickle · free (default)']);
    assert.ok(!/not offered/.test(opts.find(o => o[0] === 'emis/model-three')[1]), 'unknown isn\'t "not offered"');
    assert.match(await page.textContent('#s-model-hint'), /^6 models from the AI service \(OpenCode\), 1 of them free; 1 not offered right now \(marked\)\./);
    const feature = await page.$$eval('#s-feature-models select option', os => os.filter(o => o.value === 'emis/model-two').map(o => o.textContent));
    assert.ok(feature.length && feature.every(t => /not offered/.test(t)), 'per-feature pickers too');
    const shown = await page.$$eval('#s-model, #s-feature-models select, #s-model-hint', els => els.map(e => e.textContent + ' ' + Array.from(e.querySelectorAll('optgroup')).map(g => g.label).join(' ')).join(' '));
    assert.doesNotMatch(shown, /emis/i, 'the gateway isn\'t named in the pickers');
    // Models saved before ids had a provider ("model-three") are saved under the list's id
    await page.evaluate(() => App.setState({ settings: Object.assign({}, App.getState().settings, { model: 'model-three', models: { assistant: 'model-one' } }) }));
    await page.evaluate(() => App.navigate('dashboard'));
    await page.evaluate(() => App.navigate('settings'));
    await page.waitForFunction(() => App.getState().settings.model === 'emis/model-three');
    assert.deepEqual(await page.evaluate(() => App.getState().settings.models), { assistant: 'emis/model-one' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a model saved under an older spelling of its id (claude-opus-5-5), with or without its provider, is the same model: used under the list\'s id, also by the Lab', { timeout: 30000 }, async () => {
  await withModels([['emis/model-one', 'Model One'], ['emis/model-4.1', 'Model Four One'], ['emis/model-three', 'Model Three']], async () => {
    svc.chats.length = 0;
    for (const asked of ['model-4-1', 'emis/model-4-1']) {
      const r = await ask(asked);
      assert.equal(r.status, 200);
      assert.match(JSON.stringify(await r.json()), /ok from emis\/model-4\.1/, asked);
      assert.equal(r.headers.get('x-metacode-model-fallback'), null, 'the same model, so no "another model answered" note');
    }
    assert.deepEqual(svc.chats, ['emis/model-4.1', 'emis/model-4.1']);
    assert.equal((await mod.aiLab.registry.resolve('metacode', 'model-4-1')).id, 'emis/model-4.1', 'Lab conversations saved with the old id keep working');
    await assert.rejects(mod.aiLab.registry.resolve('metacode', 'model-4-2'), e => e.type === 'model_unavailable', 'a different version isn\'t "the same model"');
  });
});

test('the default: the service\'s own, else the first chat model it lists; OPENCODE_MODEL when the service offers it (also without its provider), else a note', { timeout: 30000 }, async () => {
  const reload = () => fetch(base + '/api/settings/reload', { method: 'POST' });
  await withModels([['emis/dall-e-3', 'DALL-E 3'], ['emis/model-one', 'Model One'], ['emis/model-three', 'Model Three']], async () => {
    svc.chats.length = 0;
    assert.match(await answer('not-in-the-list'), /ok from emis\/model-one/, 'without a default of the service\'s: the first model that isn\'t an image model');
    assert.equal((await get('/api/models')).json.models[0].id, 'emis/model-one');
    try {
      process.env.OPENCODE_MODEL = 'model-three';
      await reload();
      const list = (await get('/api/models')).json;
      assert.deepEqual([list.models[0].id, list.models[0].name, list.note], ['emis/model-three', 'Model Three (default)', undefined]);
      assert.match(await answer('not-in-the-list'), /ok from emis\/model-three/);
      assert.equal((await get('/api/settings/status')).json.ai.defaultModel, 'emis/model-three');
      process.env.OPENCODE_MODEL = 'no-such-model';
      await reload();
      const noted = (await get('/api/models')).json;
      assert.equal(noted.models[0].id, 'emis/model-one');
      assert.match(noted.note, /OPENCODE_MODEL \("no-such-model"\) isn't offered by the AI service right now, so its default model is used/);
    } finally { delete process.env.OPENCODE_MODEL; await reload(); }
  });
});

test('a rate-limited model is answered by the same model from another provider first; else by a similar model, not by its other spelling (likely the same model, limited too)', { timeout: 30000 }, async () => {
  await withModels([['emis/alias-2.1', 'Alias 2.1'], ['emis/alias-2-1', 'Alias 2.1'], ['emis/alias-2.0', 'Alias 2.0'], ['emis/model-one', 'Model One']], async () => {
    const r = await ask('emis/alias-2.1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-metacode-model-fallback'), 'emis/alias-2.0');
    assert.equal(r.headers.get('x-metacode-model-fallback-reason'), 'rate_limited');
  });
  await withModels([['emis/alias-2.1', 'Alias 2.1'], ['emis/alias-2.0', 'Alias 2.0'], ['opencode/alias-2.1', 'Alias 2.1']], async () => {
    svc.chats.length = 0;
    const r = await ask('emis/alias-2.1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-metacode-model-fallback'), 'opencode/alias-2.1');
    assert.deepEqual(svc.chats, ['opencode/alias-2.1'], 'the resting model wasn\'t asked again');
  });
});

test('a picked model that is failing: a similar model that isn\'t offered is skipped, not the end of the search', { timeout: 60000 }, async () => {
  await withModels([['emis/acme-opus-5.5', 'Acme Opus 5.5'], ['emis/acme-opus-5.4', 'Acme Opus 5.4'], ['emis/acme-opus-5.3', 'Acme Opus 5.3'], ['emis/acme-sonnet-5', 'Acme Sonnet 5']], async () => {
    for (const round of ['first', 'while it rests']) {
      svc.chats.length = 0;
      const r = await ask('emis/acme-opus-5.5');
      assert.equal(r.status, 200, round + ': ' + JSON.stringify(await r.clone().json()));
      assert.equal(r.headers.get('x-metacode-model-fallback'), 'emis/acme-opus-5.3', round);
      assert.equal(svc.chats[svc.chats.length - 1], 'emis/acme-opus-5.3', round);
    }
  });
});

test('…and when no similar model can answer, the error is about the model that was picked, not a substitute', { timeout: 60000 }, async () => {
  await withModels([['emis/acme-opus-5.5', 'Acme Opus 5.5'], ['emis/acme-opus-5.4', 'Acme Opus 5.4']], async () => {
    const r = await ask('emis/acme-opus-5.5');
    const e = (await r.json()).error;
    assert.equal(r.status, 502);
    assert.equal(e.type, 'upstream_error');
    assert.match(e.message, /couldn't run the model "Acme Opus 5\.5 \(AI gateway\)"/);
    assert.doesNotMatch(e.message, /doesn't offer|Acme Opus 5\.4/, 'the model that isn\'t offered isn\'t blamed (or listed as failing)');
    assert.match(e.message, /"Acme Opus 5\.5 \(AI gateway\)" you picked/);
  });
});

test('a substitute\'s other spelling isn\'t tried next (likely the same model, failing too): a different model answers', { timeout: 60000 }, async () => {
  await withModels([['emis/acme-opus-4.8', 'Acme Opus 4.8'], ['emis/acme-opus-4.7', 'Acme Opus 4.7'], ['emis/acme-opus-4-7', 'Acme Opus 4.7'], ['emis/acme-opus-4.6', 'Acme Opus 4.6']], async () => {
    svc.chats.length = 0;
    const r = await ask('emis/acme-opus-4.8');
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(r.headers.get('x-metacode-model-fallback'), 'emis/acme-opus-4.6');
    assert.ok(!svc.chats.includes('emis/acme-opus-4-7'), 'tried: ' + svc.chats.join(', '));
  });
});
