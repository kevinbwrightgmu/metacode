// MetaCode → its real OpenCode service → the AI providers, end to end. The
// service (opencode/server.mjs) runs in-process on a free port with its own
// data folder; MetaCode (server.js) reaches it at OPENCODE_SERVICE_URL with the
// token both read from that folder's token file. The providers are 127.0.0.1
// stand-ins: OpenCode Zen's inference API (OPENCODE_INFERENCE_URL: OpenAI chat
// and Anthropic Messages, as SSE) and the AI gateway (EMIS_BASE_URL: its model
// list, streamed and plain answers, quota headers, a key it refuses, and 429s
// that make the service pause a key). Zen's catalog is the bundled
// opencode/zen-models.json. The last test lets MetaCode start the service
// itself (OPENCODE_SERVICE_MANAGED=on) in a separate MetaCode process and
// checks it stops with MetaCode. Nothing here leaves this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { testEnv } = require('./helpers/harness');

const KEY1 = 'emis-integration-first-key-11111111';
const BAD_KEY = 'emis-integration-refused-key-0000000';     // the gateway answers 401 for it
const KEY3 = 'emis-integration-third-key-33333333';
const ZEN_KEY = 'zen-integration-key-0123456789abcdef';
const SECRETS = [KEY1, BAD_KEY, KEY3, ZEN_KEY];
const LIVE = ['claude-opus-5.5', 'big-pickle', 'gpt-5.5-mini', 'glm-5.3-flash', 'busy-a', 'busy-b', 'busy-c'];      // what the gateway runs now
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-oc-integration-'));
const dataDir = path.join(tmp, 'opencode-data');
const envFile = path.join(tmp, '.env');
const modelsFile = path.join(tmp, 'emis-models.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let zen, gateway, svc, server, base, srv;
const serviceLog = [];
const answers = [];          // every MetaCode answer's text, checked for secrets at the end

// ── Stand-ins ─────────────────────────────────────────────────────────────────
function listen(handler) {
  const sockets = new Set();
  const s = http.createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', c => { b += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(b || '{}'); } catch (e) { body = {}; }
      handler(req, res, body);
    });
  });
  s.on('connection', c => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  return new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve({
    base: 'http://127.0.0.1:' + s.address().port,
    close: () => new Promise(r => { sockets.forEach(c => c.destroy()); s.close(r); })
  })));
}
const sseHead = { 'content-type': 'text/event-stream' };
const chunk = (model, delta, finish) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [Object.assign({ index: 0, delta }, finish ? { finish_reason: finish } : {})] });

// OpenCode Zen: /openai/v1/chat/completions and /anthropic/v1/messages; state.limit = its free-usage limit (429)
async function startZen() {
  const state = { seen: [], limit: false };
  const s = await listen((req, res, body) => {
    const p = new URL(req.url, 'http://x').pathname;
    state.seen.push({ path: p, model: body.model, stream: body.stream, auth: req.headers.authorization || null, apiKey: req.headers['x-api-key'] || null,
      session: req.headers['x-opencode-session'], client: req.headers['x-opencode-client'], ua: req.headers['user-agent'] });
    if (state.limit) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '900' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } }));
    }
    if (p === '/openai/v1/chat/completions') {
      res.writeHead(200, sseHead);
      for (const c of [chunk(body.model, { role: 'assistant', content: 'Hello ' }), chunk(body.model, { content: 'from Zen' }, 'stop'),
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }]) {
        res.write('data: ' + JSON.stringify(c) + '\n\n');
      }
      return res.end('data: [DONE]\n\n');
    }
    if (p === '/anthropic/v1/messages') {
      res.writeHead(200, sseHead);
      for (const e of [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' }
      ]) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"no route"}}');
  });
  return Object.assign(s, { state, chats: () => state.seen.length });
}

// The AI gateway (EMIS): GET /v1/models, POST /v1/chat/completions (a stream when asked, else JSON)
async function startGateway() {
  const state = { seen: [], lists: 0 };
  const s = await listen((req, res, body) => {
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const json = (status, obj, headers) => { res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers)); res.end(JSON.stringify(obj)); };
    const quota = { 'X-RateLimit-Window': 'week', 'X-RateLimit-Limit-Prompts': '100', 'X-RateLimit-Remaining-Prompts': '97', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 86400) };
    if (req.url === '/v1/models') {
      state.lists++;
      if (key === BAD_KEY) return json(401, { error: { message: 'Invalid API key' } });
      return json(200, { object: 'list', data: LIVE.map(id => ({ id, object: 'model' })) }, quota);
    }
    if (req.url !== '/v1/chat/completions') return json(404, { error: { message: 'no route' } });
    state.seen.push({ model: body.model, stream: body.stream, key, ua: req.headers['user-agent'] });
    if (key === BAD_KEY) return json(401, { error: { message: 'Invalid API key' } });
    if (!LIVE.includes(body.model)) return json(404, { error: { message: 'The model `' + body.model + '` does not exist' } });
    // 429s without quota headers or Retry-After: the gateway is pausing the key (the service sees 3 models refused in 20 s)
    if (/^busy-/.test(body.model)) return json(429, { error: { message: 'slow down' } });
    if (!body.stream) {
      return json(200, { id: 'x', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok from ' + body.model }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }, quota);
    }
    res.writeHead(200, Object.assign({}, sseHead, quota));
    for (const c of [chunk(body.model, { role: 'assistant', content: 'ok ' }), chunk(body.model, { content: 'from ' + body.model }, 'stop'),
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }]) {
      res.write('data: ' + JSON.stringify(c) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  return Object.assign(s, { state });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function writeEnv(values) {
  fs.writeFileSync(envFile, Object.entries(values).map(([k, v]) => k + '=' + v).join('\n') + '\n');
}
async function request(method, p, body, headers) {
  const r = await fetch(base + p, {
    method, headers: Object.assign(body !== undefined ? { 'content-type': 'application/json' } : {}, headers),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  answers.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: r.status, headers: r.headers, text, json };
}
const get = p => request('GET', p);
const ask = (body, headers) => request('POST', '/api/ai', Object.assign({ messages: [{ role: 'user', content: 'Say hello.' }] }, body), Object.assign({ 'x-provider': 'openai' }, headers));
// SSE text → the data payloads (objects, or "[DONE]")
const events = text => text.split('\n\n').map(b => b.trim()).filter(b => b.startsWith('data: ')).map(b => (b === 'data: [DONE]' ? '[DONE]' : JSON.parse(b.slice(6))));
const streamedText = text => events(text).filter(e => e !== '[DONE]' && e.choices && e.choices[0] && e.choices[0].delta).map(e => e.choices[0].delta.content || '').join('');

async function until(check, ms, what) {
  const deadline = Date.now() + (ms || 8000);
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + (what || 'a condition'));
    await sleep(100);
  }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
// → true when something accepts connections at 127.0.0.1:port
function listeningAt(port) {
  return new Promise(resolve => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
  });
}

test.before(async () => {
  zen = await startZen();
  gateway = await startGateway();
  // The gateway's models file (OpenCode's config format): names and capabilities; "retired-model" isn't in its live list
  fs.writeFileSync(modelsFile, JSON.stringify({ provider: { emis: { models: {
    'claude-opus-5.5': { name: 'Claude Opus 5.5', tool_call: true, reasoning: true, attachment: true, limit: { context: 200000, output: 32000 } },
    'big-pickle': { name: 'Big Pickle', tool_call: true },
    'gpt-5.5-mini': { name: 'GPT-5.5 Mini', tool_call: true },
    'glm-5.3-flash': { name: 'GLM-5.3 Flash', tool_call: true },
    'retired-model': { name: 'Retired Model' },
    'busy-a': { name: 'Busy A' }, 'busy-b': { name: 'Busy B' }, 'busy-c': { name: 'Busy C' }
  } } } }));
  // .env as an operator writes it: the gateway's keys (the first is refused); no Zen key yet (free models only)
  writeEnv({ EMIS_API_KEY: BAD_KEY + ',' + KEY1 });
  // The service, as pm2 would run it: its environment plus the same .env (METACODE_ENV_FILE)
  const S = await import('../opencode/server.mjs');
  const log = { info: l => serviceLog.push('info ' + l), warn: l => serviceLog.push('warn ' + l), error: l => serviceLog.push('error ' + l) };
  svc = await S.startService({
    env: {
      METACODE_ENV_FILE: envFile, OPENCODE_SERVICE_DATA_DIR: dataDir, OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_INFERENCE_URL: zen.base, EMIS_BASE_URL: gateway.base + '/v1', EMIS_TRANSPORT: 'node', EMIS_MODELS_FILE: modelsFile
    },
    port: await freePort(), host: '127.0.0.1', log
  });
  // MetaCode: the service runs separately (managed off); no token in .env: both read it from the token file
  Object.assign(process.env, testEnv({
    METACODE_ENV_FILE: envFile, OPENCODE_SERVICE_URL: svc.url, OPENCODE_SERVICE_MANAGED: 'off', OPENCODE_SERVICE_DATA_DIR: dataDir,
    SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', DESKTOP_RELEASES_REPO: 'off',
    ACCOUNT_DATA_DIR: path.join(tmp, 'a'), SURVEY_DATA_DIR: path.join(tmp, 's'), PROJECT_DATA_DIR: path.join(tmp, 'p'),
    AI_LAB_DATA_DIR: path.join(tmp, 'l'), COLLAB_DATA_DIR: path.join(tmp, 'c')
  }));
  for (const k of ['OPENCODE_SERVICE_TOKEN', 'OPENCODE_MODEL', 'EMIS_MODEL', 'AI_MODEL_SWITCH', 'EMIS_MODEL_SWITCH', 'OPENCODE_API_KEY']) delete process.env[k];
  srv = require('../server');
  server = await srv.start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (svc) await svc.close();
  if (zen) await zen.close();
  if (gateway) await gateway.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── MetaCode through the service ──────────────────────────────────────────────

test('/api/models: both providers, in the service\'s order, with names, groups, free flags and the default first', async () => {
  const m = await get('/api/models');
  assert.equal(m.status, 200);
  assert.deepEqual([m.json.provider, m.json.source, m.json.note], ['opencode', 'opencode', undefined]);
  assert.deepEqual(m.json.providers, [{ id: 'emis', name: 'AI gateway', ready: true }, { id: 'opencode', name: 'OpenCode Zen', ready: true }]);
  const [first, ...rest] = m.json.models;
  // the default: the gateway's Claude Opus 5.5 (it lists it); its capabilities from the models file
  assert.deepEqual(first, { id: 'emis/claude-opus-5.5', name: 'Claude Opus 5.5 (default)', provider: 'emis', providerName: 'AI gateway', free: false, available: true,
    toolCall: true, reasoning: true, attachment: true, contextWindow: 200000, maxOutput: 32000 });
  // then the service's order: the gateway's file order, then Zen's free models (big-pickle first)
  const providers = rest.map(x => x.provider);
  assert.deepEqual(providers, providers.slice().sort((a, b) => (a === b ? 0 : a === 'emis' ? -1 : 1)), 'grouped by provider');
  const emis = rest.filter(x => x.provider === 'emis');
  const zenModels = rest.filter(x => x.provider === 'opencode');
  assert.deepEqual(emis.map(x => x.id), ['emis/big-pickle', 'emis/gpt-5.5-mini', 'emis/glm-5.3-flash', 'emis/retired-model', 'emis/busy-a', 'emis/busy-b', 'emis/busy-c']);
  assert.equal(zenModels.length, 9, 'without OPENCODE_API_KEY: only the free Zen models');
  assert.equal(zenModels[0].id, 'opencode/big-pickle');
  assert.ok(zenModels.every(x => x.free === true && x.available === true && x.providerName === 'OpenCode Zen'), 'Zen\'s free models are marked free');
  assert.ok(emis.every(x => x.free === false));
  assert.ok(!zenModels.some(x => /claude|gpt-5\.5$/.test(x.id)), 'no paid Zen model without a key');
  // a name both providers use gets the provider's name; one the gateway doesn't run now is marked
  const byId = Object.fromEntries(m.json.models.map(x => [x.id, x]));
  assert.equal(byId['emis/big-pickle'].name, 'Big Pickle · AI gateway');
  assert.equal(byId['opencode/big-pickle'].name, 'Big Pickle · OpenCode Zen');
  assert.equal(byId['opencode/glm-5.3-flash-free'].name, 'GLM-5.3-Flash Free');
  assert.equal(byId['emis/retired-model'].available, false);
  assert.ok(!/emis-models|EMIS|Discord/.test(m.text), 'neutral text for the browser');
});

test('/api/settings/status and /api/health: AI ready, the service and both providers', async () => {
  const h = await get('/api/health');
  assert.deepEqual([h.json.provider, h.json.aiConfigured, h.json.aiReady], ['opencode', true, true]);
  const s = await get('/api/settings/status');
  const ai = s.json.ai;
  assert.equal(ai.provider, 'opencode');
  assert.equal(ai.ready, true);
  assert.equal(ai.problem, null);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(ai.service, { host: '127.0.0.1:' + svc.port, mode: 'off', managed: false, running: true, version: pkg.version, opencode: '2.1.4',
    startedAt: ai.service.startedAt, problem: null });
  assert.ok(Number.isFinite(Date.parse(ai.service.startedAt)));
  assert.deepEqual(ai.providers.map(p => [p.id, p.name, p.ready, p.keyCount, p.free]), [['emis', 'AI gateway', true, 2, null], ['opencode', 'OpenCode Zen', true, 0, true]]);
  assert.deepEqual(ai.providers[0].models, { listed: 8, available: 7 });
  assert.deepEqual(ai.providers[1].models, { listed: 9, available: 9 });
  assert.match(ai.providers[1].note, /Free models only/);
  assert.equal(ai.providers[1].resting, null);
  assert.equal(ai.defaultModel, 'emis/claude-opus-5.5');
  assert.equal(ai.defaultModelName, 'Claude Opus 5.5');
  assert.deepEqual([ai.modelSwitch, ai.rateLimitedModels, ai.restingProviders], [true, [], []]);
  assert.ok(Number.isInteger(ai.maxParallel));
  // the public status page: working, without naming a provider or a setting
  const page = await until(async () => {
    const p = await get('/api/status');
    const part = p.json && p.json.components.find(c => c.id === 'ai');
    return part && part.status === 'operational' ? p : null;
  }, 8000, 'the status page\'s AI part');
  assert.ok(!/emis|AI gateway|\.env/i.test(page.text), page.text);
});

test('a Zen chat model: plain and streamed answers, sent the way OpenCode sends them', async () => {
  const before = zen.state.seen.length;
  const r = await ask({ model: 'opencode/glm-5.3-flash-free', max_tokens: 50 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'Hello from Zen');
  assert.equal(r.json.model, 'opencode/glm-5.3-flash-free');
  assert.equal(r.headers.get('x-metacode-model-fallback'), null);
  const sent = zen.state.seen[before];
  assert.equal(sent.path, '/openai/v1/chat/completions');
  assert.equal(sent.model, 'glm-5.3-flash-free');
  assert.equal(sent.auth, 'Bearer public', 'free models: the key "public", like OpenCode');
  assert.equal(sent.client, 'metacode');
  assert.match(sent.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(sent.ua, /^opencode\/metacode\/2\.1\.4\/metacode/);

  const s = await ask({ model: 'opencode/big-pickle', stream: true, stream_options: { include_usage: true } });
  assert.equal(s.status, 200, s.text);
  assert.match(s.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(streamedText(s.text), 'Hello from Zen');
  const evs = events(s.text);
  assert.equal(evs[evs.length - 1], '[DONE]');
  assert.deepEqual(evs.find(e => e.usage).usage.completion_tokens, 4);
  assert.equal(zen.state.seen[zen.state.seen.length - 1].model, 'big-pickle');
});

test('a gateway model: plain and streamed answers; the refused key is set aside, visible in /api/keys/status', async () => {
  const before = gateway.state.seen.length;
  for (let i = 0; i < 3; i++) {
    const r = await ask({ model: 'emis/gpt-5.5-mini' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.choices[0].message.content, /from gpt-5\.5-mini$/);
    assert.equal(r.json.model, 'emis/gpt-5.5-mini');
  }
  const s = await ask({ model: 'emis/gpt-5.5-mini', stream: true });
  assert.equal(s.status, 200, s.text);
  assert.equal(streamedText(s.text), 'ok from gpt-5.5-mini');
  const sent = gateway.state.seen.slice(before);
  assert.ok(sent.every(x => x.model === 'gpt-5.5-mini'));
  assert.ok(sent.filter(x => x.key === BAD_KEY).length <= 1, 'the refused key is tried at most once, then last');
  assert.equal(sent.filter(x => x.key === KEY1).length, 4, 'every answer came with the working key');
  // MetaCode's Settings → AI providers (re-read when older than 2 s)
  const k = await until(async () => {
    const r = await get('/api/keys/status');
    const g = r.json.providers.find(p => p.id === 'emis');
    return g && g.keys.some(x => x.status === 'invalid') && g.keys.some(x => x.requestCount >= 4) ? r : null;
  }, 8000, 'the key states in /api/keys/status');
  assert.equal(k.json.provider, 'opencode');
  assert.deepEqual(k.json.providers.map(p => p.id), ['emis', 'opencode']);
  const g = k.json.providers.find(p => p.id === 'emis');
  assert.equal(g.keyCount, 2);
  assert.equal(g.baseHost, '127.0.0.1:' + new URL(gateway.base).port);
  assert.equal(g.transport, 'Node.js');
  const good = g.keys.find(x => x.masked === '…' + KEY1.slice(-4));
  assert.equal(good.status, 'available');
  assert.equal(good.quota.window, 'week');
  assert.equal(good.quota.remainingPrompts, 97);
  assert.equal(g.keys.find(x => x.masked === '…' + BAD_KEY.slice(-4)).status, 'invalid');
  // the flattened list for older pages
  assert.deepEqual(k.json.keys.filter(x => x.provider === 'emis').map(x => x.masked).sort(), ['…' + BAD_KEY.slice(-4), '…' + KEY1.slice(-4)].sort());
});

test('a saved bare id (from before providers) is the gateway\'s model: emis/claude-opus-5.5', async () => {
  for (const saved of ['claude-opus-5.5', 'claude-opus-5-5']) {
    const before = gateway.state.seen.length;
    const r = await ask({ model: saved });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.model, 'emis/claude-opus-5.5', saved);
    assert.equal(gateway.state.seen[before].model, 'claude-opus-5.5');
  }
  // the service itself resolves a bare id the same way (OpenAI-compatible providers first)
  const r = await fetch(svc.url + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + svc.token },
    body: JSON.stringify({ model: 'claude-opus-5.5', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-opencode-model'), 'emis/claude-opus-5.5');
  await r.text();
  // no model: the default
  const d = await ask({});
  assert.equal(d.json.model, 'emis/claude-opus-5.5');
});

test('the AI Coding Lab streams through MetaCode with the providers\' measured token usage', async () => {
  const provider = srv.aiLab.registry.get('metacode');
  const listed = await provider.models();
  assert.equal(listed.problem, null);
  assert.ok(listed.models.find(x => x.id === 'emis/claude-opus-5.5').isDefault);
  assert.equal(listed.models.find(x => x.id === 'opencode/big-pickle').name, 'Big Pickle · OpenCode Zen');
  for (const [model, text, usage] of [['opencode/big-pickle', 'Hello from Zen', [11, 4]], ['emis/gpt-5.5-mini', 'ok from gpt-5.5-mini', [7, 3]]]) {
    let streamed = '';
    const out = await provider.stream({ model, messages: [{ role: 'user', content: 'Code this post.' }], maxTokens: 200 }, d => { streamed += d; });
    assert.equal(out.text, text);
    assert.equal(streamed, text);
    assert.equal(out.model, model);
    assert.equal(out.finishReason, 'stop');
    assert.deepEqual(out.usage, { promptTokens: usage[0], completionTokens: usage[1], measured: true }, model);
  }
  const plain = await provider.chat({ model: 'emis/glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
  assert.equal(plain.text, 'ok from glm-5.3-flash');
  assert.equal(plain.usage.measured, true);
});

test('/api/ai/batch answers each request through the service, from both providers', async () => {
  const r = await request('POST', '/api/ai/batch', {
    parallel: 2, system: 'You code posts.',
    requests: [
      { id: 'a', body: { model: 'emis/gpt-5.5-mini', messages: [{ role: 'user', content: 'post 1' }] } },
      { id: 'b', body: { model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'post 2' }] } },
      { id: 'c', body: { messages: [{ role: 'user', content: 'post 3' }] } }
    ]
  });
  assert.equal(r.status, 200);
  const lines = r.text.trim().split('\n').map(l => JSON.parse(l));
  const byId = Object.fromEntries(lines.filter(l => l.id).map(l => [l.id, l]));
  assert.ok(lines.some(l => l.done), 'ends with done');
  assert.ok(byId.a.ok && byId.b.ok && byId.c.ok, r.text);
  assert.equal(byId.a.data.choices[0].message.content, 'ok from gpt-5.5-mini');
  assert.equal(byId.b.data.choices[0].message.content, 'Hello from Zen');
  assert.equal(byId.c.data.model, 'emis/claude-opus-5.5', 'no model: the default');
});

test('Zen\'s free-usage limit: MetaCode answers with the closest gateway model and stops sending Zen requests while it rests', async t => {
  zen.state.limit = true;
  t.after(() => { zen.state.limit = false; });
  const before = zen.chats();
  const r = await ask({ model: 'opencode/big-pickle' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'ok from big-pickle');
  assert.equal(r.headers.get('x-metacode-model-fallback'), 'emis/big-pickle', 'the same model on the other provider');
  assert.equal(r.headers.get('x-metacode-model-fallback-reason'), 'rate_limited');
  assert.equal(r.headers.get('x-metacode-model-requested'), 'opencode/big-pickle');
  assert.equal(zen.chats(), before + 1, 'Zen was asked once');

  // another Zen model, streamed: switched at once, Zen isn't asked
  const s = await ask({ model: 'opencode/glm-5.3-flash-free', stream: true });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.headers.get('x-metacode-model-fallback'), 'emis/glm-5.3-flash');
  assert.equal(streamedText(s.text), 'ok from glm-5.3-flash');
  // without switching: the provider's limit, at once, with when it resets
  const n = await ask({ model: 'opencode/deepseek-v4.1-flash-free' }, { 'x-metacode-model-switch': 'off' });
  assert.equal(n.status, 429, n.text);
  assert.equal(n.json.error.type, 'quota_exceeded');
  assert.equal(n.json.error.scope, 'provider');
  assert.ok(n.json.error.retryAfterSeconds > 800 && n.json.error.retryAfterSeconds <= 900);
  assert.ok(Number(n.headers.get('retry-after')) > 800);
  assert.match(n.json.error.message, /OpenCode Zen's usage limit is used up.*It resets in 15 minutes/);
  assert.equal(zen.chats(), before + 1, 'still only the first request reached Zen');

  const st = await get('/api/settings/status');
  assert.deepEqual(st.json.ai.restingProviders.map(p => [p.provider, p.reason]), [['opencode', 'quota']]);
  const k = await until(async () => {
    const x = await get('/api/keys/status');
    const z = x.json.providers.find(p => p.id === 'opencode');
    return z && z.resting ? z : null;
  }, 8000, 'Zen resting in the service\'s status');
  assert.equal(k.resting.reason, 'quota');
});

test('Reload .env reaches the service: new gateway keys and a Zen key (paid models, the Anthropic protocol)', async () => {
  writeEnv({ EMIS_API_KEY: KEY1 + ',' + BAD_KEY + ',' + KEY3, OPENCODE_API_KEY: ZEN_KEY });
  const r = await request('POST', '/api/settings/reload');
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.env.keys.includes('OPENCODE_API_KEY'));
  const ai = r.json.ai;
  assert.equal(ai.ready, true);
  assert.deepEqual(ai.providers.map(p => [p.id, p.keyCount, p.free]), [['emis', 3, null], ['opencode', 1, false]]);
  assert.deepEqual(ai.restingProviders, [], 'the rests start over');
  assert.equal(ai.providers.find(p => p.id === 'opencode').resting, null, '…in the service too');

  const m = await get('/api/models');
  const zenModels = m.json.models.filter(x => x.provider === 'opencode');
  assert.ok(zenModels.length > 50, 'every Zen model with a key: ' + zenModels.length);
  const sonnet = zenModels.find(x => x.id === 'opencode/claude-sonnet-5');
  assert.ok(sonnet && sonnet.free === false);
  assert.equal(m.json.models.find(x => x.id === 'emis/claude-opus-5.5').name, 'Claude Opus 5.5 · AI gateway (default)');

  // an Anthropic-protocol Zen model, plain and streamed, with the key
  const before = zen.state.seen.length;
  const a = await ask({ model: 'opencode/claude-sonnet-5', max_tokens: 100 });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.choices[0].message.content, 'Hello from Claude');
  assert.equal(a.json.usage.prompt_tokens, 9);
  const sent = zen.state.seen[before];
  assert.equal(sent.path, '/anthropic/v1/messages');
  assert.equal(sent.model, 'claude-sonnet-5');
  assert.equal(sent.apiKey, ZEN_KEY);
  assert.equal(sent.client, 'metacode');
  const s = await ask({ model: 'opencode/claude-sonnet-5', stream: true });
  assert.equal(s.status, 200, s.text);
  assert.equal(streamedText(s.text), 'Hello from Claude');
  // a chat model now carries the key too
  await ask({ model: 'opencode/big-pickle' });
  assert.equal(zen.state.seen[zen.state.seen.length - 1].auth, 'Bearer ' + ZEN_KEY);
  // the new gateway key is used in turn
  for (let i = 0; i < 3; i++) await ask({ model: 'emis/gpt-5.5-mini' });
  assert.ok(gateway.state.seen.some(x => x.key === KEY3));
});

test('the gateway pausing its key after 429s for several models: MetaCode rests the gateway, not each model, and Zen answers', async () => {
  writeEnv({ EMIS_API_KEY: KEY1, OPENCODE_API_KEY: ZEN_KEY });
  const re = await request('POST', '/api/settings/reload');
  assert.equal(re.json.ai.providers.find(p => p.id === 'emis').keyCount, 1);
  const before = gateway.state.seen.length;
  const r = await ask({ model: 'emis/busy-a' });
  assert.equal(r.status, 200, r.text);
  // busy-a, then the most similar busy-b and busy-c, each refused: the service pauses the key, so the whole gateway
  assert.deepEqual(gateway.state.seen.slice(before).map(x => x.model), ['busy-a', 'busy-b', 'busy-c']);
  assert.match(r.headers.get('x-metacode-model-fallback'), /^opencode\//);
  assert.equal(r.headers.get('x-metacode-model-fallback-reason'), 'rate_limited');
  assert.equal(r.json.choices[0].message.content, /claude/.test(r.headers.get('x-metacode-model-fallback')) ? 'Hello from Claude' : 'Hello from Zen');
  const st = await get('/api/settings/status');
  assert.deepEqual(st.json.ai.restingProviders.map(p => [p.provider, p.reason]), [['emis', 'paused']]);
  assert.deepEqual(st.json.ai.rateLimitedModels, [], 'busy-a and busy-b don\'t go on resting: the pause explained their 429s');
  // the gateway isn't asked while it rests
  const n = gateway.state.seen.length;
  const g = await ask({ model: 'emis/gpt-5.5-mini' });
  assert.equal(g.status, 200, g.text);
  assert.match(g.headers.get('x-metacode-model-fallback'), /^opencode\//);
  assert.equal(gateway.state.seen.length, n);
});

test('nothing secret reaches MetaCode\'s answers or the service\'s log', () => {
  const text = answers.join('\n') + '\n' + serviceLog.join('\n');
  for (const s of SECRETS.concat([svc.token])) assert.ok(!text.includes(s), 'a key or the token leaked');
  assert.ok(serviceLog.some(l => /is listening on/.test(l)));
});

// ── MetaCode starts the service itself ────────────────────────────────────────

test('OPENCODE_SERVICE_MANAGED=on: MetaCode starts opencode/server.mjs on its port, uses it, and stops it on close', { timeout: 90000 }, async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(tmp, 'managed-'));
  const env = Object.assign({}, process.env, {
    METACODE_ENV_FILE: 'none', OPENCODE_SERVICE_MANAGED: 'on', OPENCODE_SERVICE_PORT: String(port), OPENCODE_SERVICE_DATA_DIR: path.join(dir, 'oc'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_INFERENCE_URL: zen.base, EMIS_BASE_URL: gateway.base + '/v1', EMIS_TRANSPORT: 'node',
    EMIS_MODELS_FILE: modelsFile, EMIS_API_KEY: KEY1,
    ACCOUNT_DATA_DIR: path.join(dir, 'a'), SURVEY_DATA_DIR: path.join(dir, 's'), PROJECT_DATA_DIR: path.join(dir, 'p'),
    AI_LAB_DATA_DIR: path.join(dir, 'l'), COLLAB_DATA_DIR: path.join(dir, 'c')
  });
  for (const k of ['OPENCODE_SERVICE_URL', 'OPENCODE_SERVICE_TOKEN', 'OPENCODE_API_KEY', 'NODE_TEST_CONTEXT']) delete env[k];
  // A second MetaCode, in its own process: start(0), then server.close() when told
  const code = 'const { start } = require(' + JSON.stringify(path.join(__dirname, '..', 'server.js')) + ');' +
    'start(0).then(s => { console.log("METACODE_PORT=" + s.address().port);' +
    ' process.stdin.on("data", () => s.close(() => { console.log("METACODE_CLOSED"); process.exit(0); })); });';
  const child = spawn(process.execPath, ['-e', code], { env, cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  let servicePid = null;
  try {
    const mcPort = Number((await until(() => /METACODE_PORT=(\d+)/.exec(out), 20000, 'MetaCode to start\n' + out))[1]);
    const mc = 'http://127.0.0.1:' + mcPort;
    // MetaCode started the service at OPENCODE_SERVICE_PORT and reaches it there
    const health = await until(async () => {
      try { const h = await fetch('http://127.0.0.1:' + port + '/health'); return h.ok ? h.json() : null; } catch (e) { return null; }
    }, 30000, 'the service MetaCode started\n' + out);
    servicePid = health.pid;
    assert.equal(health.service, 'metacode-opencode');
    assert.notEqual(health.pid, child.pid);
    const models = await until(async () => {
      const j = await (await fetch(mc + '/api/models')).json();
      return j.models.length ? j : null;
    }, 30000, 'models through the managed service\n' + out);
    assert.equal(models.models[0].id, 'emis/claude-opus-5.5');
    assert.ok(models.models.some(x => x.id === 'opencode/big-pickle' && x.free === true));
    // (running once MetaCode's own health check has seen it answer: a moment after it does)
    const s = await until(async () => {
      const j = await (await fetch(mc + '/api/settings/status')).json();
      return j.ai.service.running ? j : null;
    }, 10000, 'Settings to show the service running');
    assert.deepEqual([s.ai.ready, s.ai.service.mode, s.ai.service.managed, s.ai.service.host, s.ai.service.opencode], [true, 'on', true, '127.0.0.1:' + port, '2.1.4']);
    const r = await fetch(mc + '/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'Hello from Zen');
    assert.match(out, /\[opencode\] .*is listening on/, 'the child\'s log lines carry [opencode]');

    // closing MetaCode stops the service: its process is gone and the port is free again
    child.stdin.write('close\n');
    await until(() => /METACODE_CLOSED/.test(out), 15000, 'MetaCode to close\n' + out);
    let alive = true;
    try { process.kill(health.pid, 0); } catch (e) { alive = false; }
    assert.equal(alive, false, 'the service\'s process has stopped');
    assert.equal(await listeningAt(port), false, 'nothing listens on the service\'s port');
    await exited;
  } finally {
    // (after a failed check too: MetaCode closes properly, so the service it started doesn't outlive the test)
    if (child.exitCode === null) {
      child.stdin.write('close\n');
      await Promise.race([exited, sleep(10000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (servicePid) { try { process.kill(servicePid, 'SIGTERM'); } catch (e) { /* stopped with MetaCode */ } }
  }
  for (const s of SECRETS) assert.ok(!out.includes(s), 'no key in MetaCode\'s log');
});
