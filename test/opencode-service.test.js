// MetaCode's OpenCode service (opencode/server.mjs) with its Zen provider,
// config and catalog, started in-process on a free port with its own data
// folder. OpenCode Zen is a stand-in on 127.0.0.1 (OPENCODE_INFERENCE_URL)
// that speaks the protocols Zen's models use: OpenAI chat completions (and
// Mistral's, the same), Anthropic Messages, OpenAI Responses and Gemini, all
// as SSE; it also
// serves a models.dev catalog (OPENCODE_MODELS_URL). The AI gateway (emis) is
// switched off unless a test is about it; then a second stand-in plays it
// (EMIS_BASE_URL). Nothing here leaves this machine.
// The service is ESM, so it's import()ed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TOKEN = 'test-service-token-0123456789';
const ZEN_KEY = 'zen-test-key-0123456789abcdef';
const BUNDLED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'opencode', 'zen-models.json'), 'utf8'));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let S;                       // opencode/server.mjs
let up;                      // the stand-in for Zen (and models.opencode.ai)
const running = [];
const gateways = [];         // stand-ins for the AI gateway (emis), per test
const temps = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-oc-'));
  temps.push(dir);
  return dir;
}

// ── A small Zen catalog, so every case is known ───────────────────────────────
const zenModel = (id, extra) => Object.assign({
  id, name: id, tool_call: true, reasoning: false, attachment: false, temperature: true, release_date: '2026-01-01',
  modalities: { input: ['text'], output: ['text'] }, limit: { context: 100000, output: 32000 }, cost: { input: 0, output: 0 }
}, extra);
const FIXTURE = {
  opencode: {
    id: 'opencode', env: ['OPENCODE_API_KEY'], npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/inference/openai/v1', name: 'OpenCode',
    models: {
      'free-chat': zenModel('free-chat', {
        name: 'Free Chat', reasoning: true, release_date: '2026-03-01', limit: { context: 100000, output: 1000 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], interleaved: { field: 'reasoning_content' },
        provider: { api: 'https://opencode.ai/inference/openai/v1' }
      }),
      'big-pickle': zenModel('big-pickle', { name: 'Big Pickle', release_date: '2025-10-17' }),
      'cold-free': zenModel('cold-free', { name: 'Cold Free', temperature: false, tool_call: false, release_date: '2026-02-01' }),
      'claude-sonnet-4-5': zenModel('claude-sonnet-4-5', {
        name: 'Claude Sonnet 4.5', reasoning: true, attachment: true, release_date: '2025-09-29', modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 64000 }, reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/anthropic/v1' }, cost: { input: 3, output: 15 }
      }),
      'gpt-5.4-nano': zenModel('gpt-5.4-nano', {
        name: 'GPT-5.4 Nano', reasoning: true, release_date: '2026-03-05', temperature: false, limit: { context: 400000, output: 128000 },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
        provider: { npm: '@ai-sdk/openai', api: 'https://opencode.ai/inference/openai/v1' }, cost: { input: 0.2, output: 1.25 }
      }),
      'retired-free': zenModel('retired-free', { status: 'deprecated' })
    }
  }
};
let fixturePath;

// ── The stand-in upstream: records every request; `up.set(handler)` decides the answers
function startUpstream() {
  const state = { seen: [], handler: null, catalog: null, sockets: new Set() };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', c => { b += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (e) { body = b; }
      const entry = { method: req.method, url: req.url, headers: req.headers, body, closed: false };
      res.on('close', () => { entry.closed = true; });
      if (req.url === '/api.json' || req.url.endsWith('/api.json')) {
        state.seen.push(entry);
        return (state.catalog || ((q, r) => r.writeHead(404).end()))(req, res, entry);
      }
      state.seen.push(entry);
      Promise.resolve((state.handler || standard)(req, res, entry)).catch(e => {
        if (!res.headersSent) res.writeHead(599);
        res.end(String(e));
      });
    });
  });
  srv.on('connection', s => { state.sockets.add(s); s.on('close', () => state.sockets.delete(s)); });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    resolve({
      port, base: 'http://127.0.0.1:' + port, state,
      set(handler) { state.handler = handler; state.seen.length = 0; },
      calls: () => state.seen.filter(e => !e.url.endsWith('/api.json')),
      close: () => new Promise(r => { state.sockets.forEach(s => s.destroy()); srv.close(r); })
    });
  }));
}

function sse(res, chunks, opts) {
  const { done = true, hold = false } = opts || {};
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write('data: ' + (typeof c === 'string' ? c : JSON.stringify(c)) + '\n\n');
  if (hold) return;
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}
const named = (res, events) => {          // Anthropic / Responses streams: `event:` + `data:`
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
  res.end();
};
const reply = (status, body, headers) => (req, res) => {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const chunk = (delta, finish_reason) => ({ id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'up', choices: [{ index: 0, delta, ...(finish_reason !== undefined ? { finish_reason } : {}) }] });
const chatHello = res => sse(res, [
  chunk({ role: 'assistant', reasoning_content: 'Thinking.' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }, 'stop'),
  { id: 'cmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
]);
const anthropicHello = res => named(res, [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' }
]);
const responsesHello = res => named(res, [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }
]);
const geminiHello = res => sse(res, [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }], { done: false });
function standard(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/openai/v1/chat/completions' || p === '/mistral/v1/chat/completions') return chatHello(res);
  if (p === '/anthropic/v1/messages') return anthropicHello(res);
  if (p === '/openai/v1/responses') return responsesHello(res);
  if (/^\/google\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(p)) return geminiHello(res);
  return reply(404, { error: { message: 'no route ' + p } })(req, res);
}

// ── The service ───────────────────────────────────────────────────────────────
function envFor(extra) {
  return Object.assign({
    METACODE_ENV_FILE: 'none',
    OPENCODE_SERVICE_DATA_DIR: tempDir(),
    OPENCODE_SERVICE_TOKEN: TOKEN,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_INFERENCE_URL: up.base,
    OPENCODE_MODELS_PATH: fixturePath,
    OPENCODE_DISABLED_PROVIDERS: 'emis'
  }, extra);
}

async function start(extra, opts) {
  const lines = [];
  const log = { info: l => lines.push('info ' + l), warn: l => lines.push('warn ' + l), error: l => lines.push('error ' + l) };
  const env = extra && extra.__raw ? extra.__raw : envFor(extra);
  const svc = await S.startService(Object.assign({ env, port: 0, host: '127.0.0.1', log }, opts));
  svc.lines = lines;
  svc.origin = svc.url.replace(/\/v1$/, '');
  running.push(svc);
  return svc;
}

async function call(svc, method, p, body, headers) {
  const res = await fetch(svc.origin + p, {
    method,
    headers: Object.assign({ authorization: 'Bearer ' + svc.token }, body !== undefined ? { 'content-type': 'application/json' } : {}, headers),
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}
const chat = (svc, body, headers) => call(svc, 'POST', '/v1/chat/completions', Object.assign({ messages: [{ role: 'user', content: 'Say hello.' }] }, body), headers);

// SSE text → the data payloads (objects, or the string "[DONE]")
const events = text => text.split('\n\n').map(b => b.trim()).filter(b => b.startsWith('data: ')).map(b => (b === 'data: [DONE]' ? '[DONE]' : JSON.parse(b.slice(6))));

async function until(check, ms, what) {
  const deadline = Date.now() + (ms || 5000);
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + (what || 'a condition'));
    await sleep(25);
  }
}

test.before(async () => {
  S = await import('../opencode/server.mjs');
  up = await startUpstream();
  fixturePath = path.join(tempDir(), 'catalog.json');
  fs.writeFileSync(fixturePath, JSON.stringify(FIXTURE));
});

test.afterEach(async () => {
  while (running.length) await running.pop().close();
  while (gateways.length) await gateways.pop().close();
  up.set(null);
  up.state.catalog = null;
});

test.after(async () => {
  if (up) await up.close();
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

// ── Access ────────────────────────────────────────────────────────────────────

test('health needs no token; every /v1 route does; unknown routes are 404', async () => {
  const svc = await start();
  const health = await fetch(svc.origin + '/health');
  assert.equal(health.status, 200);
  const h = await health.json();
  assert.equal(h.ok, true);
  assert.equal(h.service, 'metacode-opencode');
  assert.equal(h.opencode, '2.1.4');
  assert.equal(h.version, require('../package.json').version);
  assert.equal(h.pid, process.pid);
  assert.ok(!JSON.stringify(h).includes(TOKEN));

  for (const [method, p] of [['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['GET', '/v1/status'], ['POST', '/v1/reload'], ['GET', '/v1/nothing']]) {
    const none = await fetch(svc.origin + p, { method });
    assert.equal(none.status, 401, method + ' ' + p + ' without a token');
    const j = await none.json();
    assert.equal(j.error.type, 'authentication_error');
    assert.match(j.error.message, /access token/);
    const wrong = await fetch(svc.origin + p, { method, headers: { authorization: 'Bearer ' + TOKEN + 'x' } });
    assert.equal(wrong.status, 401, method + ' ' + p + ' with a wrong token');
  }
  const basic = await fetch(svc.origin + '/v1/models', { headers: { authorization: 'Basic ' + TOKEN } });
  assert.equal(basic.status, 401);

  const missing = await call(svc, 'GET', '/v1/nothing');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.type, 'not_found');
  assert.equal((await call(svc, 'GET', '/elsewhere')).status, 404);
  assert.equal(up.calls().length, 0);
});

test('without OPENCODE_SERVICE_TOKEN the token is made once and kept in the data folder', async () => {
  const dataDir = tempDir();
  const svc = await start({ OPENCODE_SERVICE_TOKEN: '', OPENCODE_SERVICE_DATA_DIR: dataDir });
  const file = path.join(dataDir, 'token');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), svc.token);
  assert.match(svc.token, /^[0-9a-f]{64}$/);
  assert.equal((await call(svc, 'GET', '/v1/models')).status, 200);
  await svc.close();
  running.pop();
  const again = await start({ OPENCODE_SERVICE_TOKEN: '', OPENCODE_SERVICE_DATA_DIR: dataDir });
  assert.equal(again.token, svc.token);
  assert.ok(!again.lines.join('\n').includes(svc.token), 'the token is never logged');
});

test('a port in use: a clear EADDRINUSE error', async () => {
  const svc = await start();
  await assert.rejects(S.startService({ env: envFor(), port: svc.port, host: '127.0.0.1', log: { info() {}, warn() {}, error() {} } }), e => {
    assert.equal(e.code, 'EADDRINUSE');
    assert.match(e.message, new RegExp('Port ' + svc.port + ' is in use'));
    assert.match(e.message, /OPENCODE_SERVICE_MANAGED=off/);
    return true;
  });
});

// ── Models ────────────────────────────────────────────────────────────────────

test('/v1/models: the bundled catalog — free models only without a key, in OpenCode\'s order', async () => {
  const svc = await start({ OPENCODE_MODELS_PATH: '' });
  const r = await call(svc, 'GET', '/v1/models');
  assert.equal(r.status, 200);
  const m = r.json;
  assert.equal(m.object, 'list');
  assert.deepEqual(m.providers, [{ id: 'emis', name: 'AI gateway', ready: false }, { id: 'opencode', name: 'OpenCode Zen', ready: true }]);
  const ids = m.data.map(e => e.id);
  assert.deepEqual(ids.slice(0, 3), ['opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free']);
  assert.equal(ids.length, 9);
  assert.ok(m.data.every(e => e.free === true && e.available === true && e.provider === 'opencode' && e.owned_by === 'opencode'));
  assert.equal(m.default, 'opencode/big-pickle');
  const pickle = m.data[0];
  assert.deepEqual(pickle, {
    id: 'opencode/big-pickle', object: 'model', created: 1760659200, owned_by: 'opencode', provider: 'opencode', provider_name: 'OpenCode Zen',
    model: 'big-pickle', name: 'Big Pickle', free: true, available: true, default: true, tool_call: true, reasoning: true, attachment: false,
    temperature: true, context_window: 200000, max_output: 32000, variants: [], release_date: '2025-10-17'
  });
  assert.deepEqual(m.data.find(e => e.model === 'glm-5.3-flash-free').variants, ['low', 'high', 'max']);
  assert.equal(m.data.filter(e => e.default).length, 1);

  const st = (await call(svc, 'GET', '/v1/status')).json;
  const zen = st.providers.find(p => p.id === 'opencode');
  assert.equal(zen.catalog.source, 'bundled');
  assert.equal(zen.catalog.models, Object.keys(BUNDLED.opencode.models).length);
  assert.equal(zen.free, true);
  assert.equal(zen.keyCount, 0);
  assert.match(zen.note, /Free models only/);
  assert.deepEqual(zen.models, { listed: 9, available: 9 });
});

test('/v1/models: OPENCODE_API_KEY offers every model (newest first); OPENCODE_DISABLE_FREE_MODELS takes the free ones away', async () => {
  const keyed = await start({ OPENCODE_MODELS_PATH: '', OPENCODE_API_KEY: ZEN_KEY });
  const all = (await call(keyed, 'GET', '/v1/models')).json.data;
  assert.equal(all.length, 82);
  const dates = all.map(e => Date.parse(e.release_date) || 0);
  assert.deepEqual(dates, dates.slice().sort((a, b) => b - a), 'newest release first');
  assert.ok(all.some(e => e.free === false));
  const st = (await call(keyed, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode');
  assert.equal(st.keyCount, 1);
  assert.equal(st.free, false);
  assert.equal(st.keys[0].masked, '…cdef');
  assert.ok(!JSON.stringify(st).includes(ZEN_KEY));

  const paidOnly = await start({ OPENCODE_MODELS_PATH: '', OPENCODE_API_KEY: ZEN_KEY, OPENCODE_DISABLE_FREE_MODELS: '1' });
  const paid = (await call(paidOnly, 'GET', '/v1/models')).json.data;
  assert.equal(paid.length, 73);
  assert.ok(paid.every(e => e.free === false));

  const nothing = await start({ OPENCODE_MODELS_PATH: '', OPENCODE_DISABLE_FREE_MODELS: 'true' });
  const r = (await call(nothing, 'GET', '/v1/models')).json;
  assert.deepEqual(r.data, []);
  assert.equal(r.default, null);
  const zen = (await call(nothing, 'GET', '/v1/status')).json;
  assert.equal(zen.ready, false);
  const p = zen.providers.find(x => x.id === 'opencode');
  assert.equal(p.ready, false);
  assert.equal(p.problem, 'Add OPENCODE_API_KEY to use OpenCode Zen (free models are switched off by OPENCODE_DISABLE_FREE_MODELS).');
  const asked = await chat(nothing, { model: 'opencode/big-pickle' });
  assert.equal(asked.status, 503);
  assert.equal(asked.json.error.type, 'not_configured');
  const noModel = await chat(nothing, {});
  assert.equal(noModel.status, 503);
  assert.equal(noModel.json.error.type, 'not_configured');
});

test('/v1/models: a switched-off gateway is listed but not ready; status explains it', async () => {
  const svc = await start();
  const st = (await call(svc, 'GET', '/v1/status')).json;
  assert.deepEqual(Object.keys(st).sort(), ['default', 'providers', 'ready', 'service', 'warnings']);
  assert.equal(st.service.name, 'metacode-opencode');
  assert.equal(st.service.port, svc.port);
  assert.equal(st.service.host, '127.0.0.1');
  assert.equal(st.ready, true);
  const emis = st.providers.find(p => p.id === 'emis');
  assert.equal(emis.ready, false);
  assert.equal(emis.kind, 'openai-compatible');
  assert.match(emis.problem, /OPENCODE_DISABLED_PROVIDERS/);
  const r = await chat(svc, { model: 'emis/claude-opus-5.5' });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.type, 'not_configured');
  assert.equal(r.json.error.provider, 'emis');
  assert.equal(up.calls().length, 0);
});

test('/v1/models: the gateway enabled without a key (or its module) leaves Zen working', async () => {
  const svc = await start({ OPENCODE_DISABLED_PROVIDERS: '', EMIS_API_KEY: '', EMIS_MODELS_FILE: path.join(tempDir(), 'none.json') });
  const m = (await call(svc, 'GET', '/v1/models')).json;
  assert.equal(m.providers[0].id, 'emis');
  assert.equal(m.providers[0].ready, false);
  assert.ok(m.data.length > 0 && m.data.every(e => e.provider === 'opencode'));
  const emis = (await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'emis');
  assert.ok(emis.problem, 'says why the gateway isn\'t ready');
  assert.equal((await chat(svc, { model: 'opencode/free-chat' })).status, 200);
});

test('the catalog fixture: deprecated models are gone; order and free gating like OpenCode', async () => {
  const free = await start();
  assert.deepEqual((await call(free, 'GET', '/v1/models')).json.data.map(e => e.model), ['big-pickle', 'free-chat', 'cold-free']);
  const keyed = await start({ OPENCODE_API_KEY: ZEN_KEY });
  const m = (await call(keyed, 'GET', '/v1/models')).json;
  assert.deepEqual(m.data.map(e => e.model), ['gpt-5.4-nano', 'free-chat', 'cold-free', 'big-pickle', 'claude-sonnet-4-5']);
  assert.equal(m.default, 'opencode/gpt-5.4-nano', 'the first Zen model in Zen\'s order');
  const claude = m.data.find(e => e.model === 'claude-sonnet-4-5');
  assert.deepEqual(claude.variants, ['high', 'max']);
  assert.equal(claude.free, false);
  assert.equal(claude.attachment, true);
  const st = (await call(keyed, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode');
  assert.equal(st.catalog.source, 'file');
});

test('default model: OPENCODE_MODEL, bare ids and other spellings, the config, EMIS_MODEL; unusable ones are skipped with a warning', async () => {
  const exact = await start({ OPENCODE_MODEL: 'opencode/free-chat' });
  assert.equal((await call(exact, 'GET', '/v1/models')).json.default, 'opencode/free-chat');

  const bare = await start({ OPENCODE_MODEL: 'cold-free' });
  const m = (await call(bare, 'GET', '/v1/models')).json;
  assert.equal(m.default, 'opencode/cold-free');
  assert.deepEqual(m.data.filter(e => e.default).map(e => e.id), ['opencode/cold-free']);

  const spelled = await start({ OPENCODE_MODEL: 'opencode/FREE-CHAT' });
  assert.equal((await call(spelled, 'GET', '/v1/models')).json.default, 'opencode/free-chat', 'another spelling on the named provider');

  const zenBundled = await start({ OPENCODE_MODELS_PATH: '', OPENCODE_MODEL: 'glm-5-3-flash-free' });
  assert.equal((await call(zenBundled, 'GET', '/v1/models')).json.default, 'opencode/glm-5.3-flash-free', 'canonical spelling of a bare id');

  const unusable = await start({ OPENCODE_MODEL: 'opencode/gpt-5.4-nano', EMIS_MODEL: 'claude-opus-5.5' });
  const st = (await call(unusable, 'GET', '/v1/status')).json;
  assert.equal(st.default, 'opencode/big-pickle');
  assert.ok(st.warnings.some(w => /^OPENCODE_MODEL is "opencode\/gpt-5\.4-nano", which can't be used .*OPENCODE_API_KEY/.test(w)), st.warnings.join('\n'));
  assert.ok(!st.warnings.some(w => /EMIS_MODEL/.test(w)), 'EMIS_MODEL only counts when OPENCODE_MODEL and the config have none');
  assert.equal(unusable.lines.filter(l => /OPENCODE_MODEL is/.test(l)).length, 1, 'warned once');
  await call(unusable, 'GET', '/v1/models');
  assert.equal(unusable.lines.filter(l => /OPENCODE_MODEL is/.test(l)).length, 1, 'still once');

  const legacy = await start({ EMIS_MODEL: 'claude-opus-5.5' });
  const lst = (await call(legacy, 'GET', '/v1/status')).json;
  assert.equal(lst.default, 'opencode/big-pickle');
  assert.ok(lst.warnings.some(w => /^EMIS_MODEL is "emis\/claude-opus-5\.5"/.test(w)), lst.warnings.join('\n'));

  const dir = tempDir();
  const cfg = path.join(dir, 'operator.json');
  fs.writeFileSync(cfg, JSON.stringify({ model: 'opencode/cold-free', provider: { opencode: { models: { 'free-chat': { name: 'Renamed Chat' } } } } }));
  const configured = await start({ OPENCODE_CONFIG: cfg });
  const c = (await call(configured, 'GET', '/v1/models')).json;
  assert.equal(c.default, 'opencode/cold-free');
  assert.equal(c.data.find(e => e.model === 'free-chat').name, 'Renamed Chat');

  // a chat without a model gets the default
  const noModel = await chat(configured, { model: undefined });
  assert.equal(noModel.status, 200);
  assert.equal(noModel.json.model, 'opencode/cold-free');
  assert.equal(up.calls()[0].body.model, 'cold-free');
});

test('config: OPENCODE_CONFIG merges over opencode.json; unknown keys and providers get warnings', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'secret.txt'), '  ' + ZEN_KEY + '\n');
  const cfg = path.join(dir, 'operator.json');
  fs.writeFileSync(cfg, JSON.stringify({
    theme: 'dark',
    disabled_providers: [],
    provider: {
      opencode: { options: { apiKey: '{file:secret.txt}', timeout: 5 }, blacklist: ['cold-free'], models: { 'free-chat': { limit: { output: 500 }, cost: { input: 1 } } } },
      other: { npm: '@ai-sdk/anthropic', options: { apiKey: 'x' } }
    }
  }));
  const svc = await start({ OPENCODE_CONFIG: cfg, OPENCODE_DISABLED_PROVIDERS: 'emis' });
  const m = (await call(svc, 'GET', '/v1/models')).json;
  assert.ok(!m.data.some(e => e.model === 'cold-free'), 'blacklist');
  assert.ok(m.data.some(e => e.model === 'claude-sonnet-4-5'), 'the key came from {file:…}');
  assert.equal(m.data.find(e => e.model === 'free-chat').max_output, 500);
  assert.deepEqual(m.providers.map(p => p.id), ['emis', 'opencode'], '"other" is skipped');
  const st = (await call(svc, 'GET', '/v1/status')).json;
  const w = st.warnings.join('\n');
  assert.match(w, /"theme" isn't supported by MetaCode's OpenCode service and is ignored\./);
  assert.match(w, /"provider\.opencode\.options\.timeout" isn't supported/);
  assert.match(w, /"provider\.opencode\.models\.\*\.cost" isn't supported/);
  assert.match(w, /The provider "other" is skipped: only OpenCode Zen and OpenAI-compatible providers/);
  assert.ok(!JSON.stringify(st).includes(ZEN_KEY));

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  const svc2 = await start({ OPENCODE_CONFIG: broken });
  assert.ok((await call(svc2, 'GET', '/v1/status')).json.warnings.some(x => /^OPENCODE_CONFIG \(.*broken\.json\) is ignored: it isn't valid JSON\./.test(x)));
  assert.equal((await call(svc2, 'GET', '/v1/models')).json.data.length, 3);

  const allow = path.join(dir, 'allow.json');
  fs.writeFileSync(allow, JSON.stringify({ enabled_providers: ['emis'] }));
  const svc3 = await start({ OPENCODE_CONFIG: allow, OPENCODE_DISABLED_PROVIDERS: '' });
  const st3 = (await call(svc3, 'GET', '/v1/status')).json;
  assert.match(st3.providers.find(p => p.id === 'opencode').problem, /not in enabled_providers/);
});

// ── Chat: the requests that reach Zen ─────────────────────────────────────────

const SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const UA = /^opencode\/metacode\/2\.1\.4\/metacode$/;

test('chat protocol, not streamed: path, "public" key, OpenCode headers, max tokens clamped, temperature', async () => {
  const svc = await start();
  const r = await chat(svc, { model: 'opencode/free-chat', max_tokens: 5000, temperature: 0.3 }, { 'X-Request-Timeout-Ms': '60000' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('x-opencode-provider'), 'opencode');
  assert.equal(r.headers.get('x-opencode-model'), 'opencode/free-chat');
  const c = r.json;
  assert.match(c.id, /^chatcmpl-/);
  assert.equal(c.object, 'chat.completion');
  assert.equal(c.model, 'opencode/free-chat');
  assert.deepEqual(c.choices[0].message, { role: 'assistant', content: 'Hello', reasoning_content: 'Thinking.' });
  assert.equal(c.choices[0].finish_reason, 'stop');
  assert.deepEqual(c.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

  const calls = up.calls();
  assert.equal(calls.length, 1);
  const q = calls[0];
  assert.equal(q.method, 'POST');
  assert.equal(q.url, '/openai/v1/chat/completions');
  assert.equal(q.headers.authorization, 'Bearer public');
  assert.match(q.headers['x-opencode-session'], SESSION);
  assert.equal(q.headers['x-opencode-client'], 'metacode');
  assert.match(q.headers['user-agent'], UA);
  assert.equal(q.headers.traceparent, undefined);
  assert.equal(q.headers.b3, undefined);
  assert.equal(q.body.model, 'free-chat');
  assert.equal(q.body.stream, true);
  assert.equal(q.body.max_completion_tokens, 1000, 'clamped to the model\'s output limit');
  assert.equal(q.body.temperature, 0.3);
  assert.equal(q.body.reasoning_effort, undefined);
  assert.deepEqual(q.body.messages, [{ role: 'user', content: 'Say hello.' }]);

  // a new session id per request
  await chat(svc, { model: 'opencode/free-chat' });
  assert.notEqual(up.calls()[1].headers['x-opencode-session'], q.headers['x-opencode-session']);
  assert.equal(up.calls()[1].body.max_completion_tokens, undefined, 'no limit asked, none sent (chat)');
});

test('chat protocol, streamed: chunks with the full model id, the usage chunk, [DONE]', async () => {
  const svc = await start();
  const r = await chat(svc, { model: 'opencode/free-chat', stream: true, stream_options: { include_usage: true } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(r.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(r.headers.get('x-accel-buffering'), 'no');
  assert.equal(r.headers.get('x-opencode-model'), 'opencode/free-chat');
  const ev = events(r.text);
  assert.equal(ev[ev.length - 1], '[DONE]');
  const chunks = ev.slice(0, -1);
  assert.ok(chunks.every(c => c.object === 'chat.completion.chunk' && c.model === 'opencode/free-chat'));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map(c => (c.choices[0] && c.choices[0].delta.content) || '').join(''), 'Hello');
  assert.equal(chunks.map(c => (c.choices[0] && c.choices[0].delta.reasoning_content) || '').join(''), 'Thinking.');
  assert.equal(chunks.find(c => c.choices[0] && c.choices[0].finish_reason).choices[0].finish_reason, 'stop');
  const usage = chunks[chunks.length - 1];
  assert.deepEqual(usage.choices, []);
  assert.deepEqual(usage.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

  const plain = events((await chat(svc, { model: 'opencode/free-chat', stream: true })).text);
  assert.ok(!plain.some(c => c !== '[DONE]' && c.usage), 'no usage chunk unless asked');
});

test('variants: "#variant" wins over reasoning_effort; an unknown variant is refused; an unknown effort is ignored', async () => {
  const svc = await start();
  await chat(svc, { model: 'opencode/free-chat#high', reasoning_effort: 'low' });
  assert.equal(up.calls()[0].body.reasoning_effort, 'high');
  const named = await chat(svc, { model: 'opencode/free-chat#low' });
  assert.equal(named.json.model, 'opencode/free-chat#low');
  assert.equal(named.headers.get('x-opencode-model'), 'opencode/free-chat#low');
  up.set(null);
  await chat(svc, { model: 'opencode/free-chat', reasoning_effort: 'low' });
  assert.equal(up.calls()[0].body.reasoning_effort, 'low');
  up.set(null);
  await chat(svc, { model: 'opencode/free-chat', reasoning_effort: 'medium' });
  assert.equal(up.calls()[0].body.reasoning_effort, undefined, 'no such variant: not sent');
  up.set(null);
  await chat(svc, { model: 'opencode/big-pickle', reasoning_effort: 'high' });
  assert.equal(up.calls()[0].body.reasoning_effort, undefined, 'a model without variants');

  up.set(null);
  const bad = await chat(svc, { model: 'opencode/free-chat#ultra' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.type, 'invalid_request');
  assert.match(bad.json.error.message, /no variant "ultra" \(it has low, high\)/);
  const plain = await chat(svc, { model: 'opencode/free-chat#default' });
  assert.equal(plain.status, 200);
  assert.equal(up.calls().length, 1);
  assert.equal(up.calls()[0].body.reasoning_effort, undefined);
});

test('temperature is only sent to models that take it', async () => {
  const svc = await start();
  await chat(svc, { model: 'opencode/cold-free', temperature: 0.7 });
  assert.equal(up.calls()[0].body.temperature, undefined);
});

test('anthropic protocol (paid, with the key): x-api-key, max_tokens from the model, thinking variants', async () => {
  const svc = await start({ OPENCODE_API_KEY: ZEN_KEY, OPENAI_API_KEY: 'sk-stray-openai-key-0000', ANTHROPIC_API_KEY: 'sk-ant-stray-key-0000' });
  const r = await chat(svc, { model: 'opencode/claude-sonnet-4-5', temperature: 0.2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'Hello');
  assert.deepEqual(r.json.usage.prompt_tokens, 3);
  let q = up.calls()[0];
  assert.equal(q.url, '/anthropic/v1/messages?beta=true');
  assert.equal(q.headers['x-api-key'], ZEN_KEY);
  assert.equal(q.headers.authorization, undefined);
  assert.match(q.headers['x-opencode-session'], SESSION);
  assert.equal(q.headers['x-opencode-client'], 'metacode');
  assert.match(q.headers['user-agent'], UA);
  assert.equal(q.body.model, 'claude-sonnet-4-5');
  assert.equal(q.body.max_tokens, 64000, 'the model\'s output limit when none is asked');
  assert.equal(q.body.temperature, 0.2);

  up.set(null);
  await chat(svc, { model: 'opencode/claude-sonnet-4-5', max_tokens: 100000 });
  assert.equal(up.calls()[0].body.max_tokens, 64000, 'clamped');

  up.set(null);
  await chat(svc, { model: 'opencode/claude-sonnet-4-5#high', temperature: 0.5, max_tokens: 2000 });
  q = up.calls()[0];
  assert.deepEqual(q.body.thinking, { type: 'enabled', budget_tokens: 16000 });
  assert.equal(q.body.temperature, undefined, 'no temperature with thinking');
  assert.ok(q.body.max_tokens >= 32000, 'room for the thinking budget');

  up.set(null);
  const s = await chat(svc, { model: 'opencode/claude-sonnet-4-5', stream: true });
  const ev = events(s.text);
  assert.equal(ev.slice(0, -1).map(c => (c.choices[0] && c.choices[0].delta.content) || '').join(''), 'Hello');
  assert.equal(ev[ev.length - 1], '[DONE]');
  assert.ok(!JSON.stringify(up.state.seen).includes('stray'), 'stray provider keys in the environment never reach Zen');
});

test('responses protocol (paid, with the key): Bearer key, max_output_tokens, effort variants', async () => {
  const svc = await start({ OPENCODE_API_KEY: ZEN_KEY });
  const r = await chat(svc, { model: 'opencode/gpt-5.4-nano', max_completion_tokens: 300, temperature: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'Hello');
  let q = up.calls()[0];
  assert.equal(q.url, '/openai/v1/responses');
  assert.equal(q.headers.authorization, 'Bearer ' + ZEN_KEY);
  assert.match(q.headers['x-opencode-session'], SESSION);
  assert.equal(q.body.model, 'gpt-5.4-nano');
  assert.equal(q.body.max_output_tokens, 300);
  assert.equal(q.body.temperature, undefined, 'the model takes no temperature');

  up.set(null);
  const s = await chat(svc, { model: 'opencode/gpt-5.4-nano', reasoning_effort: 'xhigh', stream: true, stream_options: { include_usage: true } });
  q = up.calls()[0];
  assert.equal(q.body.reasoning.effort, 'xhigh');
  assert.ok(q.body.include.includes('reasoning.encrypted_content'));
  const ev = events(s.text);
  assert.equal(ev[ev.length - 1], '[DONE]');
  assert.equal(ev.slice(0, -1).map(c => (c.choices[0] && c.choices[0].delta.content) || '').join(''), 'Hello');
  assert.deepEqual(ev[ev.length - 2].usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(s.headers.get('x-opencode-model'), 'opencode/gpt-5.4-nano');
});

test('model ids: bare ids, other spellings, unknown models and providers, paid models without a key', async () => {
  const svc = await start();
  const bare = await chat(svc, { model: 'big-pickle' });
  assert.equal(bare.status, 200);
  assert.equal(bare.json.model, 'opencode/big-pickle');
  assert.equal(bare.headers.get('x-opencode-model'), 'opencode/big-pickle');

  const unknown = await chat(svc, { model: 'opencode/no-such-model' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.type, 'model_not_found');
  assert.equal(unknown.json.error.provider, 'opencode');
  const unknownBare = await chat(svc, { model: 'no-such-model' });
  assert.equal(unknownBare.status, 404);
  assert.equal(unknownBare.json.error.type, 'model_not_found');
  const retired = await chat(svc, { model: 'opencode/retired-free' });
  assert.equal(retired.status, 404);
  assert.match(retired.json.error.message, /any more/);

  const noProvider = await chat(svc, { model: 'nowhere/some-model' });
  assert.equal(noProvider.status, 503);
  assert.equal(noProvider.json.error.type, 'not_configured');

  const paid = await chat(svc, { model: 'opencode/claude-sonnet-4-5' });
  assert.equal(paid.status, 503);
  assert.equal(paid.json.error.type, 'not_configured');
  assert.match(paid.json.error.message, /needs OPENCODE_API_KEY/);
  const paidBare = await chat(svc, { model: 'claude-sonnet-4-5' });
  assert.equal(paidBare.status, 503);
  assert.match(paidBare.json.error.message, /needs OPENCODE_API_KEY/);
  assert.equal(up.calls().length, 1, 'only the bare big-pickle request went upstream');
});

test('bad requests and unsupported features never reach Zen', async () => {
  const svc = await start();
  const notJson = await call(svc, 'POST', '/v1/chat/completions', '{"messages": [', {});
  assert.equal(notJson.status, 400);
  assert.equal(notJson.json.error.type, 'invalid_request');
  const n2 = await chat(svc, { model: 'opencode/free-chat', n: 2 });
  assert.equal(n2.status, 400);
  assert.equal(n2.json.error.type, 'invalid_request');
  const role = await call(svc, 'POST', '/v1/chat/completions', { model: 'opencode/free-chat', messages: [{ role: 'robot', content: 'x' }] });
  assert.equal(role.status, 400);

  const tools = await chat(svc, { model: 'opencode/cold-free', tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }] });
  assert.equal(tools.status, 400);
  assert.equal(tools.json.error.type, 'unsupported_feature');
  assert.equal(tools.json.error.provider, 'opencode');
  const image = await call(svc, 'POST', '/v1/chat/completions', {
    model: 'opencode/free-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] }]
  });
  assert.equal(image.status, 400);
  assert.equal(image.json.error.type, 'unsupported_feature');
  const imageStream = await call(svc, 'POST', '/v1/chat/completions', {
    model: 'opencode/free-chat', stream: true,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] }]
  });
  assert.equal(imageStream.status, 400, 'a streamed request fails with a real status before the stream starts');
  assert.equal(up.calls().length, 0);
});

// ── Chat: failures ────────────────────────────────────────────────────────────

test('Zen\'s free limit: quota_exceeded for the provider, then answered at once without asking Zen', async () => {
  const svc = await start();
  up.set(reply(429, { type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } }, { 'retry-after': '3600' }));
  const r = await chat(svc, { model: 'opencode/free-chat' });
  assert.equal(r.status, 429);
  const e = r.json.error;
  assert.equal(e.type, 'quota_exceeded');
  assert.equal(e.scope, 'provider');
  assert.equal(e.provider, 'opencode');
  assert.equal(e.model, 'opencode/free-chat');
  assert.equal(e.retry_after_seconds, 3600);
  assert.ok(Math.abs(Date.parse(e.reset_at) - (Date.now() + 3600e3)) < 10000);
  assert.equal(r.headers.get('retry-after'), '3600');
  assert.match(e.message, /OpenCode Zen's usage limit is used up/);
  assert.ok(e.message.length < 400);
  assert.equal(up.calls().length, 1);

  const again = await chat(svc, { model: 'opencode/big-pickle', stream: true });
  assert.equal(again.status, 429);
  assert.equal(again.json.error.type, 'quota_exceeded');
  assert.equal(again.json.error.scope, 'provider');
  assert.equal(again.json.error.model, 'opencode/big-pickle');
  assert.ok(again.json.error.retry_after_seconds > 3500 && again.json.error.retry_after_seconds <= 3600);
  assert.match(again.json.error.message, /It resets in (60 minutes|59 minutes|about 1 hour)\./);
  assert.equal(up.calls().length, 1, 'no second upstream call');

  const zen = (await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode');
  assert.equal(zen.resting.reason, 'quota');
  assert.ok(Date.parse(zen.resting.until) > Date.now() + 3500e3);

  // Reload resets the provider's state
  await call(svc, 'POST', '/v1/reload');
  up.set(null);
  assert.equal((await chat(svc, { model: 'opencode/free-chat' })).status, 200);
});

test('a model\'s own 429: rate_limited for the model only; the next request still goes to Zen', async () => {
  const svc = await start();
  up.set(reply(429, { error: { type: 'rate_limit_error', message: 'Too many requests for this model' } }, { 'retry-after': '7' }));
  const r = await chat(svc, { model: 'opencode/free-chat' });
  assert.equal(r.status, 429);
  assert.equal(r.json.error.type, 'rate_limited');
  assert.equal(r.json.error.scope, 'model');
  assert.equal(r.json.error.retry_after_seconds, 7);
  assert.equal(r.headers.get('retry-after'), '7');
  const again = await chat(svc, { model: 'opencode/free-chat' });
  assert.equal(again.status, 429);
  assert.equal(up.calls().length, 2);
  assert.equal((await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode').resting, null);
});

test('upstream 5xx → upstream_error; streamed: a real status before the first event, an error event after it', async () => {
  const svc = await start();
  up.set(reply(503, { error: { message: 'overloaded' } }));
  const r = await chat(svc, { model: 'opencode/free-chat' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.type, 'upstream_error');
  assert.equal(r.json.error.upstream_status, 503);
  const s = await chat(svc, { model: 'opencode/free-chat', stream: true });
  assert.equal(s.status, 502, 'nothing came yet, so a real HTTP error');
  assert.equal(s.json.error.type, 'upstream_error');

  up.set((req, res) => sse(res, [chunk({ role: 'assistant', content: 'Hel' }), { error: { message: 'overloaded', type: 'server_error', code: 503 } }], { done: false }));
  const mid = await chat(svc, { model: 'opencode/free-chat', stream: true });
  assert.equal(mid.status, 200);
  const ev = events(mid.text);
  assert.ok(!ev.includes('[DONE]'), 'no [DONE] after a failure');
  const last = ev[ev.length - 1];
  assert.equal(last.error.type, 'upstream_error');
  assert.equal(ev[0].choices[0].delta.content, 'Hel');
});

test('X-Request-Timeout-Ms: the upstream wait is 3 s shorter (at least 1 s) → timeout', async () => {
  const svc = await start();
  up.set(async (req, res) => { await sleep(2500); if (!res.destroyed) chatHello(res); });
  const started = Date.now();
  const r = await chat(svc, { model: 'opencode/free-chat' }, { 'X-Request-Timeout-Ms': '4000' });
  assert.equal(r.status, 504);
  assert.equal(r.json.error.type, 'timeout');
  assert.ok(Date.now() - started < 2400, 'gave up after about 1 s');
});

test('a client that goes away cancels the upstream request; closing the service cancels the rest', async () => {
  const svc = await start();
  up.set((req, res) => sse(res, [chunk({ role: 'assistant', content: 'Hel' })], { hold: true }));
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'opencode/free-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request(svc.origin + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' } }, res => {
      assert.equal(res.statusCode, 200);
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    req.end(body);
  });
  await until(() => up.calls()[0] && up.calls()[0].closed, 5000, 'the upstream connection to close');
  await until(() => svc.lines.some(l => /→ 200 then 499 cancelled/.test(l)), 5000, 'the log line');

  up.set((req, res) => sse(res, [chunk({ role: 'assistant', content: 'Hel' })], { hold: true }));
  const pending = fetch(svc.origin + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opencode/free-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  }).then(r => r.text()).catch(() => '');
  await until(() => up.calls().length === 1, 5000, 'the second request upstream');
  await sleep(50);
  await svc.close();
  await until(() => up.calls()[0].closed, 5000, 'close() to cancel the upstream call');
  await pending;
});

test('bodies over 32 MB are refused with request_too_large', async () => {
  const svc = await start();
  const big = JSON.stringify({ model: 'opencode/free-chat', messages: [{ role: 'user', content: 'x'.repeat(33 * 1024 * 1024) }] });
  const r = await fetch(svc.origin + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: big });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error.type, 'request_too_large');
  assert.equal(up.calls().length, 0);
  const fine = await chat(svc, { model: 'opencode/free-chat', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] });
  assert.equal(fine.status, 200, 'a big body under the limit is fine');
});

// ── Catalog refresh and reload ────────────────────────────────────────────────

test('catalog: fetched from OPENCODE_MODELS_URL, cached with its ETag, 304 keeps the cache; OPENCODE_MODELS_PATH wins', async () => {
  const fresh = JSON.parse(JSON.stringify(BUNDLED));
  fresh.opencode.models['brand-new-free'] = zenModel('brand-new-free', { name: 'Brand New', release_date: '2026-10-20' });
  const entries = [];
  up.state.catalog = (req, res, entry) => {
    entries.push(entry);
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
    res.end(JSON.stringify(Object.assign({ other: { id: 'other', models: {} } }, fresh)));
  };
  const dataDir = tempDir();
  const env = { OPENCODE_MODELS_PATH: '', OPENCODE_DISABLE_MODELS_FETCH: '', OPENCODE_MODELS_URL: up.base + '/', OPENCODE_SERVICE_DATA_DIR: dataDir };
  const svc = await start(env);
  const zenStatus = async s => (await call(s, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode');
  await until(async () => (await zenStatus(svc)).catalog.source === 'remote', 5000, 'the remote catalog');
  assert.equal(entries[0].url, '/api.json');
  assert.match(entries[0].headers['user-agent'], UA);
  assert.equal(entries[0].headers['if-none-match'], undefined, 'nothing cached yet');
  const m = (await call(svc, 'GET', '/v1/models')).json;
  assert.ok(m.data.some(e => e.id === 'opencode/brand-new-free'));
  assert.equal(m.default, 'opencode/big-pickle', 'still OpenCode\'s preferred free model first');
  const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'models-catalog.json'), 'utf8'));
  assert.equal(cache.etag, '"v1"');
  assert.deepEqual(Object.keys(cache.opencode.models).sort(), Object.keys(fresh.opencode.models).sort());
  assert.equal(cache.other, undefined, 'only the Zen entry is kept');
  await svc.close();
  running.pop();

  // A restart: the cache first, then a check with its ETag (304: unchanged)
  const again = await start(env);
  await until(() => entries.length === 2, 5000, 'the second check');
  assert.equal(entries[1].headers['if-none-match'], '"v1"');
  await until(async () => (await zenStatus(again)).catalog.checkedAt, 5000, 'the check to finish');
  const st = await zenStatus(again);
  assert.equal(st.catalog.source, 'cache');
  assert.ok((await call(again, 'GET', '/v1/models')).json.data.some(e => e.id === 'opencode/brand-new-free'));

  // A failing source keeps what there is (and says so once)
  up.state.catalog = reply(500, 'down');
  const failing = await start(Object.assign({}, env, { OPENCODE_SERVICE_DATA_DIR: tempDir() }));
  await until(() => failing.lines.some(l => /Couldn't refresh the OpenCode Zen model catalog from 127\.0\.0\.1:\d+ \(HTTP 500\); keeping the bundled copy\./.test(l)), 5000, 'the failure line');
  assert.equal((await zenStatus(failing)).catalog.source, 'bundled');

  // OPENCODE_MODELS_PATH wins over the cache and nothing is fetched
  const before = entries.length;
  const pinned = await start(Object.assign({}, env, { OPENCODE_MODELS_PATH: fixturePath }));
  await sleep(200);
  assert.equal((await zenStatus(pinned)).catalog.source, 'file');
  assert.deepEqual((await call(pinned, 'GET', '/v1/models')).json.data.map(e => e.model), ['big-pickle', 'free-chat', 'cold-free']);
  assert.equal(entries.length, before);
});

test('reload: re-reads the settings file and the config, and answers with the status', async () => {
  const dir = tempDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'OPENCODE_MODEL=opencode/cold-free\n');
  const svc = await start({ METACODE_ENV_FILE: envFile });
  assert.equal((await call(svc, 'GET', '/v1/models')).json.data.length, 3);
  assert.equal((await call(svc, 'GET', '/v1/models')).json.default, 'opencode/cold-free');

  fs.writeFileSync(envFile, '﻿OPENCODE_API_KEY=' + ZEN_KEY + '\nOPENCODE_MODEL=opencode/claude-sonnet-4-5\n');
  const r = await call(svc, 'POST', '/v1/reload');
  assert.equal(r.status, 200);
  assert.equal(r.json.default, 'opencode/claude-sonnet-4-5');
  const zen = r.json.providers.find(p => p.id === 'opencode');
  assert.equal(zen.keyCount, 1);
  assert.deepEqual(zen.models, { listed: 5, available: 5 });
  assert.ok(!r.text.includes(ZEN_KEY));
  assert.equal((await call(svc, 'GET', '/v1/models')).json.data.length, 5);

  // the in-process reload() does the same
  fs.writeFileSync(envFile, 'OPENCODE_DISABLED_PROVIDERS=emis,opencode\n');
  const st = await svc.reload();
  assert.equal(st.ready, false);
  assert.match(st.providers.find(p => p.id === 'opencode').problem, /OPENCODE_DISABLED_PROVIDERS/);
  const off = await chat(svc, { model: 'opencode/free-chat' });
  assert.equal(off.status, 503);
  assert.equal(off.json.error.type, 'not_configured');
  assert.ok(!svc.lines.join('\n').includes(ZEN_KEY), 'the key is never logged');
});

// ── The AI gateway (emis) beside Zen ──────────────────────────────────────────

const GW_KEY = 'emis-gateway-test-key-0123456789';
const GW_KEY2 = 'emis-gateway-other-key-9876543210';
const GW_MODELS = ['claude-opus-5.5', 'big-pickle', 'gw-only'];

// The stand-in for the gateway: GET /v1/models (gw.list: 'ok' | 'refused' | 'hang') and chats
// (gw.chat(req, res, body) decides; by default a short stream). Records every request.
function startGateway() {
  const gw = { seen: [], models: GW_MODELS.slice(), list: 'ok', chat: null, sockets: new Set() };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', c => { b += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (e) { body = b; }
      const entry = { method: req.method, url: req.url, key: String(req.headers.authorization || '').replace(/^Bearer /, ''), headers: req.headers, body };
      gw.seen.push(entry);
      if (req.url === '/v1/models') {
        if (gw.list === 'hang') return;
        if (gw.list === 'refused') return reply(401, { error: { message: 'Invalid API key' } })(req, res);
        return reply(200, { object: 'list', data: gw.models.map(id => ({ id, object: 'model' })) })(req, res);
      }
      if (gw.chat) return gw.chat(req, res, body);
      sse(res, [chunk({ role: 'assistant', content: 'Hello from the gateway' }), chunk({}, 'stop')]);
    });
  });
  srv.on('connection', s => { gw.sockets.add(s); s.on('close', () => gw.sockets.delete(s)); });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    gw.base = 'http://127.0.0.1:' + srv.address().port + '/v1';
    gw.chats = () => gw.seen.filter(e => e.url === '/v1/chat/completions');
    gw.close = () => new Promise(r => { gw.sockets.forEach(s => s.destroy()); srv.close(r); });
    gateways.push(gw);
    resolve(gw);
  }));
}

// Both providers on: the gateway (its live model list, through Node.js) and Zen (the fixture catalog)
const bothEnv = (gw, extra) => Object.assign({
  OPENCODE_DISABLED_PROVIDERS: '', EMIS_BASE_URL: gw.base, EMIS_API_KEY: GW_KEY, EMIS_TRANSPORT: 'node', EMIS_MODELS_FILE: 'none'
}, extra);

test('both providers: the gateway\'s models first, then Zen\'s; bare ids prefer the gateway; the default model chain', async () => {
  const gw = await startGateway();
  const svc = await start(bothEnv(gw));
  const m = (await call(svc, 'GET', '/v1/models')).json;
  assert.deepEqual(m.providers, [{ id: 'emis', name: 'AI gateway', ready: true }, { id: 'opencode', name: 'OpenCode Zen', ready: true }]);
  assert.deepEqual(m.data.map(e => e.id), ['emis/claude-opus-5.5', 'emis/big-pickle', 'emis/gw-only', 'opencode/big-pickle', 'opencode/free-chat', 'opencode/cold-free']);
  assert.equal(m.default, 'emis/claude-opus-5.5', 'the gateway\'s old default, while it lists it');
  const first = m.data[0];
  assert.deepEqual([first.provider, first.provider_name, first.model, first.available, first.free, first.default], ['emis', 'AI gateway', 'claude-opus-5.5', true, false, true]);
  assert.ok(!gw.seen.some(e => e.headers['x-oc-transport'] || e.headers['x-oc-trace']), 'nothing of the service\'s own reaches the gateway');

  // a bare id both list: the gateway's
  let r = await chat(svc, { model: 'big-pickle' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('x-opencode-provider'), 'emis');
  assert.equal(r.json.model, 'emis/big-pickle');
  assert.equal(r.json.choices[0].message.content, 'Hello from the gateway');
  assert.deepEqual(gw.chats().map(e => [e.body.model, e.key]), [['big-pickle', GW_KEY]]);
  assert.equal(up.calls().length, 0, 'Zen wasn\'t asked');
  // …under another spelling too; Zen's when named; a bare id only Zen lists is Zen's
  assert.equal((await chat(svc, { model: 'claude-opus-5-5' })).json.model, 'emis/claude-opus-5.5');
  r = await chat(svc, { model: 'opencode/big-pickle' });
  assert.deepEqual([r.headers.get('x-opencode-provider'), r.json.choices[0].message.content], ['opencode', 'Hello']);
  assert.equal((await chat(svc, { model: 'free-chat' })).json.model, 'opencode/free-chat');
  assert.equal((await chat(svc, { model: undefined })).json.model, 'emis/claude-opus-5.5', 'no model: the default');
  for (const id of ['emis/gw-only', 'opencode/free-chat']) {
    const s = await chat(svc, { model: id, stream: true, stream_options: { include_usage: true } });
    assert.equal(s.status, 200, id);
    assert.equal(s.headers.get('x-opencode-model'), id);
    const ev = events(s.text);
    assert.equal(ev[ev.length - 1], '[DONE]', id);
    assert.ok(ev.slice(0, -1).every(c => c.model === id), id);
    assert.ok(ev.slice(0, -1).map(c => (c.choices[0] && c.choices[0].delta.content) || '').join('').startsWith('Hello'), id);
  }

  // the default model: OPENCODE_MODEL, else EMIS_MODEL, else the gateway's claude-opus-5.5, else Zen's first
  assert.equal((await call(await start(bothEnv(gw, { OPENCODE_MODEL: 'opencode/free-chat' })), 'GET', '/v1/models')).json.default, 'opencode/free-chat');
  assert.equal((await call(await start(bothEnv(gw, { EMIS_MODEL: 'gw-only' })), 'GET', '/v1/models')).json.default, 'emis/gw-only');
  gw.models = ['gw-only'];
  const without = (await call(await start(bothEnv(gw)), 'GET', '/v1/models')).json;
  assert.equal(without.default, 'opencode/big-pickle', 'the gateway doesn\'t list claude-opus-5.5: Zen\'s first model');
  assert.deepEqual(without.data.filter(e => e.default).map(e => e.id), ['opencode/big-pickle']);
});

test('a bare id stays with the gateway when it lists the model under another spelling, even if Zen has the exact one', async () => {
  const gw = await startGateway();
  gw.models = ['claude-sonnet-4.5'];
  const svc = await start(bothEnv(gw, { OPENCODE_API_KEY: ZEN_KEY }));
  const ids = (await call(svc, 'GET', '/v1/models')).json.data.map(e => e.id);
  assert.ok(ids.includes('emis/claude-sonnet-4.5') && ids.includes('opencode/claude-sonnet-4-5'), ids.join(', '));
  const r = await chat(svc, { model: 'claude-sonnet-4-5' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.model, 'emis/claude-sonnet-4.5');
  assert.deepEqual(gw.chats().map(e => e.body.model), ['claude-sonnet-4.5']);
});

test('Zen\'s free limit rests Zen only: the gateway keeps answering (and the other way round)', async () => {
  const gw = await startGateway();
  const svc = await start(bothEnv(gw));
  up.set(reply(429, { type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } }, { 'retry-after': '600' }));
  let r = await chat(svc, { model: 'opencode/free-chat' });
  assert.deepEqual([r.status, r.json.error.type, r.json.error.scope, r.json.error.provider, r.json.error.retry_after_seconds], [429, 'quota_exceeded', 'provider', 'opencode', 600]);
  assert.equal((await chat(svc, { model: 'emis/gw-only' })).status, 200, 'the gateway still answers');
  assert.equal((await chat(svc, { model: 'big-pickle' })).headers.get('x-opencode-provider'), 'emis', 'a bare id: the gateway\'s');
  r = await chat(svc, { model: 'opencode/big-pickle', stream: true });
  assert.deepEqual([r.status, r.json.error.type, r.json.error.provider], [429, 'quota_exceeded', 'opencode'], 'Zen answered at once (a real status, no stream)');
  assert.equal(up.calls().length, 1, 'Zen was asked once');
  let st = (await call(svc, 'GET', '/v1/status')).json;
  assert.equal(st.ready, true);
  assert.equal(st.default, 'emis/claude-opus-5.5');
  assert.equal(st.providers.find(p => p.id === 'opencode').resting.reason, 'quota');
  assert.equal(st.providers.find(p => p.id === 'emis').resting, null);

  // the gateway's key budget used up: the gateway rests, Zen answers
  await call(svc, 'POST', '/v1/reload');                     // (forgets Zen's rest)
  up.set(null);
  const reset = Math.floor(Date.now() / 1000) + 7200;
  gw.chat = (req, res) => reply(429, { error: { message: 'budget used up' } },
    { 'X-RateLimit-Window': 'week', 'X-RateLimit-Limit-Prompts': '100', 'X-RateLimit-Remaining-Prompts': '0', 'X-RateLimit-Reset': String(reset) })(req, res);
  r = await chat(svc, { model: 'emis/gw-only' });
  assert.deepEqual([r.status, r.json.error.type, r.json.error.scope, r.json.error.provider, r.json.error.window], [429, 'quota_exceeded', 'provider', 'emis', 'week']);
  assert.ok(Number(r.headers.get('retry-after')) > 7000);
  const asked = gw.chats().length;
  assert.equal((await chat(svc, { model: 'emis/claude-opus-5.5' })).json.error.type, 'quota_exceeded');
  assert.equal(gw.chats().length, asked, 'answered without asking the gateway');
  assert.equal((await chat(svc, { model: 'opencode/free-chat' })).status, 200, 'Zen answers');
  st = (await call(svc, 'GET', '/v1/status')).json;
  assert.deepEqual(st.providers.find(p => p.id === 'emis').resting && st.providers.find(p => p.id === 'emis').resting.reason, 'quota');
  assert.equal(st.providers.find(p => p.id === 'opencode').resting, null);
});

test('reload: a changed EMIS_API_KEY is used for the next request; the keys\' state starts over; a removed key switches the gateway off', async () => {
  const gw = await startGateway();
  const envFile = path.join(tempDir(), '.env');
  fs.writeFileSync(envFile, 'EMIS_API_KEY=' + GW_KEY + '\n');
  const env = bothEnv(gw, { METACODE_ENV_FILE: envFile });
  delete env.EMIS_API_KEY;
  const svc = await start(env);
  assert.equal((await chat(svc, { model: 'emis/gw-only' })).status, 200);
  assert.equal(gw.chats()[0].key, GW_KEY);
  let emis = (await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'emis');
  assert.deepEqual([emis.keyCount, emis.keys[0].masked, emis.keys[0].requestCount], [1, '…' + GW_KEY.slice(-4), 1]);

  fs.writeFileSync(envFile, 'EMIS_API_KEY=' + GW_KEY2 + '\n');
  const r = await call(svc, 'POST', '/v1/reload');
  assert.equal(r.status, 200);
  emis = r.json.providers.find(p => p.id === 'emis');
  assert.deepEqual([emis.ready, emis.keyCount, emis.keys[0].masked, emis.keys[0].requestCount], [true, 1, '…' + GW_KEY2.slice(-4), 0]);
  assert.equal((await chat(svc, { model: 'emis/gw-only' })).status, 200);
  assert.equal(gw.chats()[1].key, GW_KEY2, 'the new key');
  assert.equal(gw.seen.filter(e => e.url === '/v1/models').pop().key, GW_KEY2, 'the model list too');

  fs.writeFileSync(envFile, '# no gateway key\n');
  const off = (await call(svc, 'POST', '/v1/reload')).json;
  emis = off.providers.find(p => p.id === 'emis');
  assert.equal(emis.ready, false);
  assert.match(emis.problem, /EMIS_API_KEY/);
  const m = (await call(svc, 'GET', '/v1/models')).json;
  assert.ok(m.data.length > 0 && m.data.every(e => e.provider === 'opencode'));
  assert.equal(m.default, 'opencode/big-pickle');
  const asked = await chat(svc, { model: 'emis/gw-only' });
  assert.deepEqual([asked.status, asked.json.error.type, asked.json.error.provider], [503, 'not_configured', 'emis']);
  const text = svc.lines.join('\n') + r.text + JSON.stringify(off);
  assert.ok(![GW_KEY, GW_KEY2].some(k => text.includes(k)), 'no key in the log or the status');
});

test('a gateway that can\'t list its models: its own error for its models; Zen isn\'t held up; /v1/status answers within MetaCode\'s 3 s', async () => {
  const gw = await startGateway();
  gw.list = 'refused';
  const svc = await start(bothEnv(gw));
  const st = (await call(svc, 'GET', '/v1/status')).json;
  let emis = st.providers.find(p => p.id === 'emis');
  assert.equal(emis.ready, false);
  assert.match(emis.problem, /didn't accept the key in EMIS_API_KEY/);
  assert.equal(st.ready, true, 'Zen is');
  const r = await chat(svc, { model: 'emis/gw-only' });
  assert.deepEqual([r.status, r.json.error.type, r.json.error.provider, r.json.error.model], [401, 'authentication_error', 'emis', 'emis/gw-only'],
    'the gateway\'s own failure, with its provider (so MetaCode doesn\'t take it for its own token)');
  assert.match(r.json.error.message, /EMIS_API_KEY/);
  const bare = await chat(svc, { model: 'gw-only' });
  assert.equal(bare.status, 404);
  assert.match(bare.json.error.message, /AI gateway couldn't be asked: AI gateway didn't accept the key/);
  assert.equal((await chat(svc, { model: 'opencode/free-chat' })).status, 200);
  assert.equal(gw.chats().length, 0);

  // a list that never comes
  gw.list = 'hang';
  let t0 = Date.now();
  const slow = await start(bothEnv(gw));
  assert.ok(Date.now() - t0 < 4000, 'started in ' + (Date.now() - t0) + ' ms');
  t0 = Date.now();
  emis = (await call(slow, 'GET', '/v1/status')).json.providers.find(p => p.id === 'emis');
  assert.ok(Date.now() - t0 < 2900, 'answered in ' + (Date.now() - t0) + ' ms');
  assert.equal(emis.ready, false);
  assert.match(emis.problem, /still loading its model list/, slow.lines.join("\n"));
  t0 = Date.now();
  assert.equal((await chat(slow, { model: 'opencode/free-chat' })).status, 200);
  assert.ok(Date.now() - t0 < 1000, 'Zen didn\'t wait for the gateway (' + (Date.now() - t0) + ' ms)');
});

test('stray provider keys in the real environment never reach Zen or the gateway, whatever the protocol', async () => {
  const STRAY = {
    OPENAI_API_KEY: 'sk-stray-openai-key-000000000000', ANTHROPIC_API_KEY: 'sk-ant-stray-key-0000000000000', GOOGLE_GENERATIVE_AI_API_KEY: 'stray-google-key-00000000',
    MISTRAL_API_KEY: 'stray-mistral-key-00000000', OPENAI_ORG_ID: 'org-stray-0000000000', OPENAI_BASE_URL: 'http://127.0.0.1:9/stray'
  };
  const saved = {};
  for (const [k, v] of Object.entries(STRAY)) { saved[k] = process.env[k]; process.env[k] = v; }
  const catalog = JSON.parse(JSON.stringify(FIXTURE));
  Object.assign(catalog.opencode.models, {
    'gemini-free': zenModel('gemini-free', { name: 'Gemini Free', provider: { npm: '@ai-sdk/google', api: 'https://opencode.ai/inference/google/v1beta' } }),
    'mistral-free': zenModel('mistral-free', { name: 'Mistral Free', provider: { npm: '@ai-sdk/mistral', api: 'https://opencode.ai/inference/mistral/v1' } })
  });
  const file = path.join(tempDir(), 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(catalog));
  const gw = await startGateway();
  try {
    for (const key of ['', ZEN_KEY]) {
      const svc = await start(bothEnv(gw, { OPENCODE_MODELS_PATH: file, OPENCODE_API_KEY: key }));
      up.set(null);
      const models = ['free-chat', 'gemini-free', 'mistral-free'].concat(key ? ['claude-sonnet-4-5', 'gpt-5.4-nano'] : []);
      for (const model of models) {
        for (const stream of [false, true]) {
          const r = await chat(svc, { model: 'opencode/' + model, stream });
          assert.equal(r.status, 200, model + ': ' + r.text);
          const text = stream ? events(r.text).slice(0, -1).map(c => (c.choices[0] && c.choices[0].delta.content) || '').join('') : r.json.choices[0].message.content;
          assert.equal(text, 'Hello', model + (stream ? ' (stream)' : ''));
        }
      }
      assert.equal((await chat(svc, { model: 'emis/gw-only' })).status, 200);
      const sent = JSON.stringify(up.state.seen.map(e => [e.url, e.headers, e.body])) + JSON.stringify(gw.seen.map(e => [e.url, e.headers, e.body]));
      for (const [k, v] of Object.entries(STRAY)) assert.ok(!sent.includes(v), k + ' was sent');
      assert.equal(up.calls().find(e => e.url.startsWith('/google/')).headers['x-goog-api-key'], key || 'public');
      assert.equal(up.calls().find(e => e.url.startsWith('/mistral/')).headers.authorization, 'Bearer ' + (key || 'public'));
      assert.ok(gw.seen.every(e => e.key === GW_KEY));
      await svc.close();
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ── Run as a program ──────────────────────────────────────────────────────────

const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
});

test('node opencode/server.mjs: reads .env, answers, refuses a second copy on its port, and stops cleanly on SIGTERM with a stream running', { timeout: 30000 }, async () => {
  const dir = tempDir();
  const port = await freePort();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, [
    'OPENCODE_SERVICE_HOST=127.0.0.1', 'OPENCODE_SERVICE_PORT=' + port, 'OPENCODE_SERVICE_TOKEN=' + TOKEN, 'OPENCODE_SERVICE_DATA_DIR=' + path.join(dir, 'data'),
    'OPENCODE_DISABLE_MODELS_FETCH=1', 'OPENCODE_INFERENCE_URL=' + up.base, 'OPENCODE_MODELS_PATH=' + fixturePath, 'OPENCODE_DISABLED_PROVIDERS=emis'
  ].join('\n') + '\n');
  const run = () => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'opencode', 'server.mjs')], {
      env: { PATH: process.env.PATH, HOME: dir, METACODE_ENV_FILE: envFile }, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.out = '';
    child.stdout.on('data', d => { child.out += d; });
    child.stderr.on('data', d => { child.out += d; });
    child.exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })));
    return child;
  };
  const child = run();
  try {
    await until(() => /is listening on http:\/\/127\.0\.0\.1:\d+ — /.test(child.out), 10000, 'the startup line');
    const origin = 'http://127.0.0.1:' + port;
    assert.equal((await fetch(origin + '/health')).status, 200);
    assert.equal((await fetch(origin + '/v1/models', { headers: { authorization: 'Bearer ' + TOKEN } })).status, 200);

    const second = run();
    assert.equal((await second.exited).code, 1);
    assert.match(second.out, new RegExp('Port ' + port + ' is in use .*OPENCODE_SERVICE_MANAGED=off'));

    up.set((req, res) => sse(res, [chunk({ role: 'assistant', content: 'Hel' })], { hold: true }));
    const res = await fetch(origin + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/free-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value);
    assert.match(text, /"content":"Hel"/);
    const t0 = Date.now();
    child.kill('SIGTERM');
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); } }
    catch (e) { assert.fail('the stream was cut off instead of ended (' + e.message + '): ' + text); }
    const ev = events(text);
    const last = ev[ev.length - 1].error;
    assert.deepEqual([last && last.type, last && last.code, last && last.provider], ['internal_error', 'shutting_down', 'opencode'], 'the stream ends with an error event: ' + text);
    assert.match(last.message, /OpenCode service stopped \(it is being restarted or shut down\) before OpenCode Zen finished answering/);
    assert.ok(!ev.includes('[DONE]'));
    const { code } = await child.exited;
    assert.equal(code, 0, child.out);
    assert.ok(Date.now() - t0 < 4000, 'stopped in ' + (Date.now() - t0) + ' ms');
    assert.match(child.out, /OpenCode service stopped\./);
    await until(() => up.calls()[0] && up.calls()[0].closed, 5000, 'the upstream request to close');
    assert.ok(!child.out.includes(TOKEN), 'the token is never printed');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

// ── What a review found ───────────────────────────────────────────────────────

test('GET /health says which data folder (which MetaCode copy) the service belongs to, as a hash', async () => {
  const dataDir = tempDir();
  const svc = await start({ OPENCODE_SERVICE_DATA_DIR: dataDir });
  const h = await (await fetch(svc.origin + '/health')).json();
  assert.equal(h.home, require('../opencode/shared.js').homeId(dataDir));
  assert.match(h.home, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(h).includes(dataDir), 'the folder itself isn\'t said');
});

test('free models switched off and no key: Zen doesn\'t say it is free', async () => {
  const zenOf = async svc => (await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode');
  const off = await zenOf(await start({ OPENCODE_DISABLE_FREE_MODELS: '1' }));
  assert.deepEqual([off.ready, off.free, off.keyCount], [false, false, 0]);
  assert.equal((await zenOf(await start())).free, true, 'no key, free models on: free');
});

test('a secret in Zen\'s own headers (options.headers in OPENCODE_CONFIG) never shows in its errors or the log', async () => {
  const SECRET = 'zen-header-secret-0123456789';
  const cfg = path.join(tempDir(), 'oc.json');
  fs.writeFileSync(cfg, JSON.stringify({ provider: { opencode: { options: { headers: { 'x-gateway-token': SECRET } } } } }));
  const svc = await start({ OPENCODE_CONFIG: cfg });
  up.set((req, res) => reply(403, { error: { message: 'gateway token ' + req.headers['x-gateway-token'] + ' is not allowed for this route' } })(req, res));
  for (const stream of [false, true]) {
    const r = await chat(svc, { model: 'opencode/free-chat', stream });
    assert.equal(r.status, 403);
    assert.equal(up.calls()[0].headers['x-gateway-token'], SECRET, 'the header is sent');
    assert.match(r.json.error.message, /gateway token \[redacted\] is not allowed/);
    assert.ok(!r.text.includes(SECRET), r.text);
    up.state.seen.length = 0;
  }
  assert.ok(!svc.lines.join('\n').includes(SECRET), svc.lines.join('\n'));
});

test('the catalog can\'t send OPENCODE_API_KEY elsewhere: a model whose address isn\'t under https://opencode.ai/inference/ is left out (unless the catalog is OPENCODE_MODELS_PATH)', async () => {
  const other = await startUpstream();
  try {
    const catalog = JSON.parse(JSON.stringify(FIXTURE));
    Object.assign(catalog.opencode.models, {
      'elsewhere-free': zenModel('elsewhere-free', { name: 'Elsewhere', release_date: '2026-09-01', provider: { api: other.base + '/v1' } }),
      'plain-http': zenModel('plain-http', { release_date: '2026-09-02', provider: { api: 'http://opencode.ai/inference/openai/v1' } }),
      'other-port': zenModel('other-port', { release_date: '2026-09-03', provider: { api: 'https://opencode.ai:8443/inference/openai/v1' } }),
      'look-alike': zenModel('look-alike', { release_date: '2026-09-04', provider: { api: 'https://opencode.ai.example/inference/openai/v1' } }),
      'outside': zenModel('outside', { release_date: '2026-09-05', provider: { api: 'https://opencode.ai/inference/../other/v1' } })
    });
    up.state.catalog = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); };
    const env = { OPENCODE_MODELS_PATH: '', OPENCODE_DISABLE_MODELS_FETCH: '', OPENCODE_MODELS_URL: up.base, OPENCODE_API_KEY: ZEN_KEY, OPENCODE_SERVICE_DATA_DIR: tempDir() };
    const svc = await start(env);
    const zenStatus = async () => (await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode');
    await until(async () => (await zenStatus()).catalog.source === 'remote', 5000, 'the remote catalog');
    const ids = (await call(svc, 'GET', '/v1/models')).json.data.map(e => e.model);
    for (const id of ['elsewhere-free', 'plain-http', 'other-port', 'look-alike', 'outside']) assert.ok(!ids.includes(id), id + ' is offered');
    assert.ok(ids.includes('free-chat') && ids.includes('claude-sonnet-4-5'));
    const r = await chat(svc, { model: 'opencode/elsewhere-free' });
    assert.equal(r.status, 404);
    assert.equal(other.state.seen.length, 0, 'nothing went to the other address');
    assert.ok((await zenStatus()).warnings.some(w => /5 models .*outside https:\/\/opencode\.ai\/inference\/.*left out/.test(w)), JSON.stringify((await zenStatus()).warnings));
    await svc.close();
    running.pop();
    // a restart with the cached copy and no fetching: still left out
    const cached = await start(Object.assign({}, env, { OPENCODE_DISABLE_MODELS_FETCH: '1' }));
    assert.equal((await call(cached, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode').catalog.source, 'cache');
    assert.ok(!(await call(cached, 'GET', '/v1/models')).json.data.some(e => e.model === 'elsewhere-free'));
    // the operator's own file is trusted as it is
    const file = path.join(tempDir(), 'catalog.json');
    fs.writeFileSync(file, JSON.stringify(catalog));
    const own = await start({ OPENCODE_MODELS_PATH: file, OPENCODE_API_KEY: ZEN_KEY });
    other.set((req, res) => chatHello(res));
    const r2 = await chat(own, { model: 'opencode/elsewhere-free' });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(other.calls().length, 1);
    // a plain-http catalog address (not this machine) is warned about
    const plain = await start({ OPENCODE_MODELS_URL: 'http://models.example', OPENCODE_DISABLE_MODELS_FETCH: '1' });
    assert.ok((await call(plain, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode').warnings.some(w => /OPENCODE_MODELS_URL uses plain http/.test(w)));
  } finally { await other.close(); }
});

test('Zen\'s free limit with a key: only the free models wait; paid models still answer (scope model)', async () => {
  const svc = await start({ OPENCODE_API_KEY: ZEN_KEY });
  up.set((req, res) => (/\/chat\/completions$/.test(req.url)
    ? reply(429, { type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } }, { 'retry-after': '3600' })(req, res)
    : standard(req, res)));
  const r = await chat(svc, { model: 'opencode/free-chat' });
  assert.deepEqual([r.status, r.json.error.type, r.json.error.scope, r.json.error.retry_after_seconds], [429, 'quota_exceeded', 'model', 3600]);
  assert.match(r.json.error.message, /free models' limit is reached; pick a paid model/);
  assert.doesNotMatch(r.json.error.message, /balance/);
  const paid = await chat(svc, { model: 'opencode/claude-sonnet-4-5' });
  assert.equal(paid.status, 200, paid.text);
  assert.equal((await chat(svc, { model: 'opencode/gpt-5.4-nano', stream: true })).status, 200);
  assert.equal(up.calls().length, 3);
  const free = await chat(svc, { model: 'opencode/big-pickle' });
  assert.deepEqual([free.status, free.json.error.type, free.json.error.scope], [429, 'quota_exceeded', 'model']);
  assert.ok(free.json.error.retry_after_seconds > 3500);
  assert.equal(up.calls().length, 3, 'another free model waits without asking Zen');
  assert.equal((await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode').resting, null, 'Zen as a whole isn\'t resting');
});

test('Zen\'s spend limit for one model (BudgetLimitError, coverage "models"): that model only (scope model, nothing rests); a workspace budget still rests Zen', async () => {
  const svc = await start({ OPENCODE_API_KEY: ZEN_KEY });
  const budget = metadata => (req, res) => (/\/anthropic\//.test(req.url)
    ? reply(429, { type: 'error', error: Object.assign({ type: 'BudgetLimitError', message: 'Budget exceeded' }, metadata ? { metadata } : {}) }, { 'retry-after': '900' })(req, res)
    : standard(req, res));
  up.set(budget({ coverage: 'models' }));
  const r = await chat(svc, { model: 'opencode/claude-sonnet-4-5' });
  assert.deepEqual([r.status, r.json.error.type, r.json.error.scope], [429, 'quota_exceeded', 'model']);
  assert.match(r.json.error.message, /this model's spend limit is reached; pick another model/i);
  assert.equal((await chat(svc, { model: 'opencode/gpt-5.4-nano' })).status, 200);
  assert.equal((await chat(svc, { model: 'opencode/free-chat' })).status, 200);
  assert.equal((await chat(svc, { model: 'opencode/claude-sonnet-4-5' })).status, 429);
  assert.equal(up.calls().length, 4, 'every request went to Zen');
  assert.equal((await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === 'opencode').resting, null);

  up.set(budget(null));
  const all = await chat(svc, { model: 'opencode/claude-sonnet-4-5' });
  assert.deepEqual([all.status, all.json.error.type, all.json.error.scope], [429, 'quota_exceeded', 'provider']);
  assert.equal((await chat(svc, { model: 'opencode/gpt-5.4-nano' })).status, 429);
  assert.equal(up.calls().length, 1, 'the workspace budget rests Zen');
});

test('a stream whose first part takes longer than half the time limit: the status line goes out, then a comment now and then, so MetaCode\'s timer doesn\'t run out while the model thinks', async () => {
  const svc = await start();
  up.set(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < 8 && !res.destroyed; i++) { res.write(': PROCESSING\n\n'); await sleep(250); }
    if (res.destroyed) return;
    for (const c of [chunk({ role: 'assistant', content: 'Hel' }), chunk({ content: 'lo' }, 'stop')]) res.write('data: ' + JSON.stringify(c) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const t0 = Date.now();
  const res = await fetch(svc.origin + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + svc.token, 'content-type': 'application/json', 'X-Request-Timeout-Ms': '2000' },
    body: JSON.stringify({ model: 'opencode/free-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  });
  const headersAfter = Date.now() - t0;
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(headersAfter < 1500, 'the status line came after ' + headersAfter + ' ms');
  assert.ok(Date.now() - t0 >= 1900, 'the answer itself came later');
  assert.ok((text.match(/^: /gm) || []).length >= 2, text);
  const ev = events(text);
  assert.equal(ev.slice(0, -1).map(c => (c.choices[0] && c.choices[0].delta.content) || '').join(''), 'Hello');
  assert.equal(ev[ev.length - 1], '[DONE]');

  // a failure before the first part (and before the grace time): still a real HTTP status
  up.set(reply(429, { error: { type: 'rate_limit_error', message: 'slow down' } }));
  const limited = await chat(svc, { model: 'opencode/free-chat', stream: true }, { 'X-Request-Timeout-Ms': '2000' });
  assert.deepEqual([limited.status, limited.json.error.type], [429, 'rate_limited']);
  // one after it (here: after 1 s of a 2 s limit): an error event in the stream
  up.set(async (req, res) => { await sleep(1400); reply(503, { error: { message: 'overloaded' } })(req, res); });
  const late = await chat(svc, { model: 'opencode/free-chat', stream: true }, { 'X-Request-Timeout-Ms': '5000' });
  assert.equal(late.status, 200);
  const lastEvent = events(late.text).pop();
  assert.equal(lastEvent.error && lastEvent.error.type, 'upstream_error', late.text);
});

test('node opencode/server.mjs without its packages installed: one line saying to run npm install (no stack), exit code 1', { timeout: 20000 }, async () => {
  const dir = tempDir();
  const hooks = path.join(dir, 'hide-packages.mjs');
  fs.writeFileSync(hooks, [
    'export async function resolve(specifier, context, next) {',
    '  if (specifier === "@opencode/ai" || specifier.startsWith("@opencode/ai/")) {',
    '    throw Object.assign(new Error("Cannot find package \'@opencode/ai\' imported from " + context.parentURL), { code: "ERR_MODULE_NOT_FOUND" });',
    '  }',
    '  return next(specifier, context);',
    '}'
  ].join('\n'));
  const register = path.join(dir, 'register.mjs');
  fs.writeFileSync(register, 'import { register } from "node:module";\nimport { pathToFileURL } from "node:url";\nregister(pathToFileURL(' + JSON.stringify(hooks) + '));\n');
  const script = path.join(__dirname, '..', 'opencode', 'server.mjs');
  for (const pm2 of [true, false]) {
    const child = spawn(process.execPath, ['--import', register, script], {
      env: Object.assign({ PATH: process.env.PATH, HOME: dir, METACODE_ENV_FILE: 'none', OPENCODE_SERVICE_DATA_DIR: path.join(dir, 'data'), OPENCODE_SERVICE_PORT: String(await freePort()) },
        pm2 ? { pm_exec_path: script } : {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const code = await new Promise(r => child.on('exit', r));
    assert.equal(code, 1, out + err);
    assert.equal(err.trim(), 'MetaCode\'s AI service can\'t start: the package @opencode/ai isn\'t installed. Run "npm install", then restart it' + (pm2 ? ' (pm2 restart metacode-opencode)' : '') + '.');
    assert.equal(out.trim(), '');
  }
});
