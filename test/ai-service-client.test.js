// MetaCode's side of its AI service (server.js): which model may answer for
// another, readiness, retries and the messages an operator reads — against a
// stand-in for the service on 127.0.0.1 whose answers each test sets. Also
// the AI Coding Lab's price list for the service's "provider/model" ids.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { testEnv } = require('./helpers/harness');
const shared = require('../opencode/shared');
const { createPricing } = require('../ai-lab/pricing');

// undici's own response timeouts (300 s unless set) are made short here: MetaCode's
// client for the service must set none of its own (AI_TIMEOUT_MS limits each request)
const undici = require('undici');
const RealAgent = undici.Agent;
undici.Agent = class extends RealAgent { constructor(o) { super(Object.assign({ headersTimeout: 500, bodyTimeout: 500 }, o)); } };

const TOKEN = 'test-service-token-ai-client-0123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ai-client-'));
const dataDir = path.join(tmp, 'oc');
const HOME = shared.homeId(dataDir);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROVIDERS = [{ id: 'gw', name: 'Test gateway', ready: true }, { id: 'zen', name: 'Zen test', ready: true }];
const entry = (id, name, extra) => {
  const [provider, model] = id.split('/');
  return Object.assign({ id, object: 'model', provider, provider_name: PROVIDERS.find(p => p.id === provider).name, model, name, free: false, available: true }, extra || {});
};
const MODELS = [
  entry('gw/claude-opus-5.5', 'Claude Opus 5.5'), entry('gw/gpt-5.5', 'GPT-5.5'),
  entry('gw/glm-5.3-flash', 'GLM-5.3 Flash'), entry('gw/glm-5.2-flash', 'GLM-5.2 Flash'), entry('gw/glm-5.1-flash', 'GLM-5.1 Flash'),
  entry('zen/claude-opus-5.5', 'Claude Opus 5.5'), entry('zen/claude-sonnet-4-5', 'Claude Sonnet 4.5', { variants: ['high', 'max'] }),
  entry('zen/glm-5.3-flash-free', 'GLM-5.3 Flash Free', { free: true }), entry('zen/big-pickle', 'Big Pickle', { free: true, variants: ['low', 'high'] })
];

// The stand-in's answers; each test sets what it needs (reset() puts the defaults back)
const svc = {};
function reset() {
  Object.assign(svc, {
    token: TOKEN,               // the token it accepts (null: any)
    home: HOME,                 // GET /health's "home": which MetaCode's data folder (shared.homeId)
    foreign: false,             // another program: "404 Not Found" for everything
    models: MODELS, default: 'gw/claude-opus-5.5',
    chat: null,                 // (body, send, res) → true when it answered the chat itself
    seen: [], health: 0, reloads: 0
  });
}
reset();
const completion = (model, content) => ({ id: 'x', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
function handle(req, res) {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    const send = (status, obj, headers) => { if (!res.headersSent) { res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers)); res.end(JSON.stringify(obj)); } };
    if (svc.foreign) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not Found'); }
    if (req.url === '/health') { svc.health++; return send(200, { ok: true, service: 'metacode-opencode', version: 'test', pid: process.pid, home: svc.home }); }
    if (svc.token && req.headers.authorization !== 'Bearer ' + svc.token) return send(401, { error: { type: 'authentication_error', message: 'MetaCode\'s OpenCode service needs its access token.' } });
    const status = { service: { name: 'metacode-opencode', version: 'test' }, ready: true, default: svc.default, warnings: [], providers: PROVIDERS };
    if (req.url === '/v1/status') return send(200, status);
    if (req.url === '/v1/reload' && req.method === 'POST') { svc.reloads++; return send(200, status); }
    if (req.url === '/v1/models') return send(200, { object: 'list', default: svc.default, providers: PROVIDERS, data: svc.models });
    if (req.url !== '/v1/chat/completions') return send(404, { error: { type: 'not_found', message: 'Not found.' } });
    const body = JSON.parse(b || '{}');
    svc.seen.push(body.model);
    if (svc.chat && svc.chat(body, send, res)) return;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'ok from ' + body.model }, finish_reason: 'stop' }] }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    send(200, completion(body.model, 'ok from ' + body.model));
  });
}
// A stand-in on a port of its own, that can be stopped and started again (a service restarting)
function standIn(port) {
  const sockets = new Set();
  let s = null;
  return {
    port,
    async start() {
      s = http.createServer(handle);
      s.on('connection', c => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
      await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve); });
      this.port = s.address().port;
    },
    async stop() { if (!s) return; sockets.forEach(c => c.destroy()); await new Promise(r => s.close(r)); s = null; }
  };
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

let main, server, base;
const baseEnv = () => testEnv({
  OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + main.port + '/v1', OPENCODE_SERVICE_TOKEN: TOKEN, OPENCODE_SERVICE_DATA_DIR: dataDir, OPENCODE_SERVICE_MANAGED: 'off',
  SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', DESKTOP_RELEASES_REPO: 'off',
  ACCOUNT_DATA_DIR: path.join(tmp, 'a'), SURVEY_DATA_DIR: path.join(tmp, 's'), PROJECT_DATA_DIR: path.join(tmp, 'p'), AI_LAB_DATA_DIR: path.join(tmp, 'l'), COLLAB_DATA_DIR: path.join(tmp, 'c')
});
const VARIABLES = ['OPENCODE_SERVICE_URL', 'OPENCODE_SERVICE_PORT', 'OPENCODE_SERVICE_TOKEN', 'OPENCODE_SERVICE_MANAGED', 'OPENCODE_MODEL', 'EMIS_MODEL', 'AI_MODEL_SWITCH',
  'AI_FALLBACK_TO_FREE_MODELS', 'AI_BATCH_PAUSE_SECONDS', 'AI_TIMEOUT_MS'];

test.before(async () => {
  main = standIn(0);
  await main.start();
  Object.assign(process.env, baseEnv());
  for (const k of VARIABLES) if (!(k in baseEnv())) delete process.env[k];
  server = await require('../server').start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  // (MetaCode stops looking after a service on the port before anything closes)
  if (server) { await configure({}); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (main) await main.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function request(method, p, body, headers) {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: r.status, headers: r.headers, text, json };
}
const ask = (model, headers, extra) => request('POST', '/api/ai', Object.assign(model ? { model } : {}, { messages: [{ role: 'user', content: 'hi' }] }, extra), headers);
const SWITCH_OFF = { 'x-metacode-model-switch': 'off' };
// MetaCode's settings: the test defaults with `env` over them (undefined removes one), then Reload .env
// (which also starts over: rests, failures, the model list); setup() changes the stand-in's answers first
async function configure(env, setup) {
  reset();
  if (setup) setup();
  const values = Object.assign(baseEnv(), env);
  for (const k of VARIABLES) if (values[k] === undefined) delete process.env[k];
  Object.entries(values).forEach(([k, v]) => { if (v !== undefined) process.env[k] = v; });
  const r = await request('POST', '/api/settings/reload', {});
  assert.equal(r.status, 200, r.text);
  return r.json.ai;
}
// The stand-in as the service at the default address (no OPENCODE_SERVICE_URL), MetaCode running it or not
const atDefaultAddress = (managed, extra) => Object.assign({ OPENCODE_SERVICE_URL: undefined, OPENCODE_SERVICE_PORT: String(main.port), OPENCODE_SERVICE_MANAGED: managed }, extra);
async function until(check, ms, what) {
  const deadline = Date.now() + (ms || 8000);
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + (what || 'a condition'));
    await sleep(100);
  }
}
const aiPart = async () => (await request('GET', '/api/status')).json.components.find(c => c.id === 'ai');

// ── Which model may answer for another ────────────────────────────────────────

test('a free model never answers for one that isn\'t free (its provider may use the prompts), unless AI_FALLBACK_TO_FREE_MODELS=on; free for free still switches', async () => {
  // The gateway's usage quota is used up; the other provider has only free models left that are like its models
  const quota = (body, send) => {
    if (!/^gw\//.test(body.model)) return false;
    send(429, { error: { type: 'quota_exceeded', scope: 'provider', provider: 'gw', retry_after_seconds: 3600, message: 'Test gateway\'s usage quota is used up.' } }, { 'Retry-After': '3600' });
    return true;
  };
  const paidElsewhere = id => /^zen\//.test(id) && !MODELS.find(m => m.id === id).free;
  let ai = await configure({});
  assert.equal(ai.freeFallback, false);
  svc.models = MODELS.filter(m => !paidElsewhere(m.id));
  svc.chat = quota;
  for (const model of ['gw/claude-opus-5.5', undefined]) {
    const r = await ask(model);
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json.error.type, 'quota_exceeded');
    assert.equal(r.headers.get('x-metacode-model-fallback'), null);
  }
  const streamed = await ask('gw/gpt-5.5', {}, { stream: true });
  assert.equal(streamed.status, 429, streamed.text);
  assert.deepEqual(svc.seen.filter(m => /^zen\//.test(m)), [], 'no post went to a free model');

  // A free model that is rate-limited: another free model answers
  svc.chat = (body, send) => {
    if (body.model !== 'zen/glm-5.3-flash-free') return false;
    send(429, { error: { type: 'rate_limited', scope: 'model', provider: 'zen', model: body.model, retry_after_seconds: 30, message: 'Busy.' } });
    return true;
  };
  const free = await ask('zen/glm-5.3-flash-free');
  assert.equal(free.status, 200, free.text);
  assert.equal(free.headers.get('x-metacode-model-fallback'), 'zen/big-pickle');

  // The operator allows it
  ai = await configure({ AI_FALLBACK_TO_FREE_MODELS: 'on' });
  assert.equal(ai.freeFallback, true);
  svc.models = MODELS.filter(m => !paidElsewhere(m.id));
  svc.chat = quota;
  const r = await ask('gw/claude-opus-5.5');
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get('x-metacode-model-fallback'), /^zen\/(glm-5\.3-flash-free|big-pickle)$/);
});

test('a usage limit of one model (quota_exceeded with scope "model") rests that model, not its provider', async () => {
  await configure({});
  svc.chat = (body, send) => {
    if (body.model !== 'zen/glm-5.3-flash-free') return false;
    send(429, { error: { type: 'quota_exceeded', scope: 'model', provider: 'zen', model: body.model, retry_after_seconds: 3600, message: 'Zen test\'s free models\' limit is reached; pick a paid model.' } });
    return true;
  };
  const r = await ask('zen/glm-5.3-flash-free', SWITCH_OFF);
  assert.equal(r.status, 429, r.text);
  const st = (await request('GET', '/api/settings/status')).json.ai;
  assert.deepEqual(st.restingProviders, [], 'the provider doesn\'t rest');
  assert.deepEqual(st.rateLimitedModels.map(m => m.model), ['zen/glm-5.3-flash-free']);
  const paid = await ask('zen/claude-sonnet-4-5', SWITCH_OFF);
  assert.equal(paid.status, 200, paid.text);
  assert.equal(svc.seen[svc.seen.length - 1], 'zen/claude-sonnet-4-5', 'the provider\'s other models are still asked');
});

test('a model id with a reasoning variant ("provider/model#variant") is sent with it; an unknown variant is refused; OPENCODE_MODEL may have one', async () => {
  await configure({});
  let r = await ask('zen/claude-sonnet-4-5#max');
  assert.equal(r.status, 200, r.text);
  assert.equal(svc.seen.pop(), 'zen/claude-sonnet-4-5#max');
  assert.equal(r.headers.get('x-metacode-model-fallback'), null);
  r = await ask('claude-sonnet-4-5#high');
  assert.equal(r.status, 200, r.text);
  assert.equal(svc.seen.pop(), 'zen/claude-sonnet-4-5#high', 'an id saved without its provider, with its variant');
  r = await ask('zen/claude-sonnet-4-5#default');
  assert.equal(svc.seen.pop(), 'zen/claude-sonnet-4-5');
  r = await ask('zen/claude-sonnet-4-5#bogus');
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error.type, 'invalid_request');
  assert.match(r.json.error.message, /has no variant "bogus" \(it has high, max\)/);
  assert.deepEqual(svc.seen, [], 'not sent (and not answered by another model)');

  await configure({ OPENCODE_MODEL: 'zen/claude-sonnet-4-5#max' });
  let list = (await request('GET', '/api/models')).json;
  assert.deepEqual([list.models[0].id, list.models[0].name, list.note], ['zen/claude-sonnet-4-5', 'Claude Sonnet 4.5 (default)', undefined]);
  r = await ask();
  assert.equal(r.status, 200, r.text);
  assert.equal(svc.seen.pop(), 'zen/claude-sonnet-4-5#max', 'the server default, with its variant');

  await configure({ OPENCODE_MODEL: 'zen/claude-sonnet-4-5#nope' });
  list = (await request('GET', '/api/models')).json;
  assert.equal(list.models[0].id, 'zen/claude-sonnet-4-5');
  assert.match(list.note, /OPENCODE_MODEL \("zen\/claude-sonnet-4-5#nope"\) has no variant "nope" \(it has high, max\)/);
  await ask();
  assert.equal(svc.seen.pop(), 'zen/claude-sonnet-4-5');
});

test('one provider failing for every model: requests switch to another provider\'s model; the status page says degraded, not outage', { timeout: 30000 }, async () => {
  await configure({});
  // (upstream status 501: a server error that isn't retried, so the test is quick)
  svc.chat = (body, send) => {
    if (!/^gw\//.test(body.model)) return false;
    send(502, { error: { type: 'upstream_error', provider: 'gw', model: body.model, upstream_status: 501, message: 'Test gateway had a server problem.' } });
    return true;
  };
  for (const model of ['gw/glm-5.3-flash', 'gw/glm-5.2-flash', 'gw/glm-5.1-flash']) assert.equal((await ask(model, SWITCH_OFF)).status, 502, model);
  // the server's default model (the gateway's): the same model from the other provider
  const d = await ask();
  assert.equal(d.status, 200, d.text);
  assert.equal(d.headers.get('x-metacode-model-fallback'), 'zen/claude-opus-5.5');
  // a model picked in Settings that the failing provider can't run: another provider's model too
  const picked = await ask('gw/gpt-5.5');
  assert.equal(picked.status, 200, picked.text);
  assert.match(picked.headers.get('x-metacode-model-fallback'), /^zen\//);
  // switching off: the provider's problem, named as one provider's
  const off = await ask('gw/gpt-5.5', SWITCH_OFF);
  assert.equal(off.status, 502);
  assert.match(off.json.error.message, /provider .*server problems right now: \d+ of its models answered with server errors/);
  const part = await until(async () => { const p = await aiPart(); return /server errors/.test(p.note) ? p : null; }, 8000, 'the status page');
  assert.equal(part.status, 'degraded');
  assert.match(part.note, /One of the AI providers is answering with server errors/);
});

// ── Readiness and the service's address ──────────────────────────────────────

test('another program at the default address: AI isn\'t ready, and the messages say to set a free OPENCODE_SERVICE_PORT (an OPENCODE_SERVICE_URL stand-in still works)', async () => {
  const foreign = () => { svc.foreign = true; };
  let ai = await configure(atDefaultAddress('off'), foreign);
  assert.equal(ai.ready, false);
  assert.match(ai.problem, /Another program, not MetaCode's AI service, answers at 127\.0\.0\.1:\d+\. Set OPENCODE_SERVICE_PORT/);
  assert.equal((await request('GET', '/api/health')).json.aiReady, false);
  const r = await ask('gw/gpt-5.5');
  assert.equal(r.status, 502);
  assert.match(r.json.error.message, /OPENCODE_SERVICE_PORT/);
  assert.doesNotMatch(r.json.error.message, /OPENCODE_SERVICE_URL/);
  // MetaCode would run the service (auto): it doesn't start one, and says the same
  ai = await configure(atDefaultAddress('auto'), foreign);
  assert.equal(ai.ready, false);
  assert.equal(ai.service.managed, false);
  assert.match(ai.problem, /Another program/);
  assert.match(ai.service.problem, /Another program/);
  // the same answers at an OPENCODE_SERVICE_URL: a stand-in without /v1/status, as before
  ai = await configure({}, foreign);
  assert.equal(ai.ready, true);
});

test('another MetaCode\'s AI service on the port: not used, and the messages say to give this copy its own OPENCODE_SERVICE_PORT', async () => {
  let ai = await configure(atDefaultAddress('auto'), () => { svc.home = 'ffffffffffffffff'; svc.token = 'another-copys-token-0000000000'; });
  assert.equal(ai.ready, false);
  assert.match(ai.problem, /Another MetaCode's AI service \(from a different folder\) is using port \d+\. Set OPENCODE_SERVICE_PORT/);
  assert.equal(ai.service.problem, ai.problem);
  const r = await ask('gw/gpt-5.5');
  assert.equal(r.status, 401, r.text);
  assert.match(r.json.error.message, /Another MetaCode's AI service/);
  assert.deepEqual(svc.seen, [], 'no prompt went to it');
  // this copy's own service with another token: the token, and the port for a second copy
  svc.home = HOME;
  ai = (await request('POST', '/api/settings/reload', {})).json.ai;
  assert.match(ai.problem, /didn't accept MetaCode's access token/);
  assert.match(ai.problem, /OPENCODE_SERVICE_TOKEN/);
  assert.match(ai.problem, /OPENCODE_SERVICE_PORT/);
});

test('OPENCODE_SERVICE_URL written out as the default address is the default: MetaCode looks for the service there (and would start it)', async () => {
  await configure({});
  const ai = await configure(atDefaultAddress('auto', { OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + main.port + '/v1' }));
  assert.ok(svc.health > 0, 'GET /health asked');
  assert.equal(ai.ready, true);
  assert.equal(ai.problem, null);
});

test('Reload .env with a new OPENCODE_SERVICE_TOKEN (or a new token file) starts the service again instead of sending the new token to the old one', async () => {
  const anyToken = () => { svc.token = null; };
  await configure(atDefaultAddress('auto', { OPENCODE_SERVICE_TOKEN: 'first-service-token-00000000' }), anyToken);
  const health = svc.health;
  process.env.OPENCODE_SERVICE_TOKEN = 'second-service-token-0000000';
  let ai = (await request('POST', '/api/settings/reload', {})).json.ai;
  assert.ok(svc.health > health, 'looked for the service again');
  assert.equal(svc.reloads, 0, 'the old service wasn\'t sent the new token');
  assert.equal(ai.ready, true);
  // the token file: made again
  await configure(atDefaultAddress('auto', { OPENCODE_SERVICE_TOKEN: undefined }), anyToken);
  fs.rmSync(path.join(dataDir, 'token'), { force: true });
  const h2 = svc.health;
  ai = (await request('POST', '/api/settings/reload', {})).json.ai;
  assert.ok(svc.health > h2, 'looked for the service again');
  assert.equal(svc.reloads, 0);
  // nothing changed: the service is asked to reload
  ai = (await request('POST', '/api/settings/reload', {})).json.ai;
  assert.equal(svc.reloads, 1);
});

test('the AI service starting to answer later (pm2): AI is ready again by itself; while it isn\'t running, the message points at pm2 and npm install', { timeout: 30000 }, async () => {
  const late = standIn(await freePort());
  try {
    let ai = await configure({ OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + late.port + '/v1' });
    assert.equal(ai.ready, false);
    const r = await ask('gw/gpt-5.5');
    assert.equal(r.status, 502);
    assert.match(r.json.error.message, /isn't running at 127\.0\.0\.1:\d+\..*"pm2 status".*"pm2 logs metacode-opencode.*npm install.*pm2 restart metacode-opencode/);
    assert.equal((await request('GET', '/api/health')).json.aiReady, false);
    await late.start();
    // nothing else asks: /api/health only reads what MetaCode knows
    await until(async () => (await request('GET', '/api/health')).json.aiReady, 8000, 'AI ready again');
    ai = (await request('GET', '/api/settings/status')).json.ai;
    assert.equal(ai.service.running, true);
  } finally { await late.stop(); }
});

test('a short restart of the AI service: requests are retried, a batch pauses instead of failing the rest, "shutting down" answers are tried again', { timeout: 60000 }, async () => {
  await configure({});
  let shutting = 1;
  svc.chat = (body, send) => {
    if (shutting-- <= 0) return false;
    send(500, { error: { type: 'internal_error', code: 'shutting_down', message: 'MetaCode\'s OpenCode service is shutting down. Try again in a moment.' } });
    return true;
  };
  const r = await ask('gw/gpt-5.5');
  assert.equal(r.status, 200, r.text);

  const late = standIn(await freePort());
  try {
    await late.start();
    await configure({ OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + late.port + '/v1', AI_BATCH_PAUSE_SECONDS: '0.5' });
    assert.equal((await request('GET', '/api/models')).json.models.length, MODELS.length);
    // it stops; comes back after 1 s (retried), then a request with it gone for longer than the retries (the batch pauses)
    await late.stop();
    setTimeout(() => late.start(), 1000);
    assert.equal((await ask('gw/gpt-5.5')).status, 200);
    await late.stop();
    setTimeout(() => late.start(), 3200);
    const b = await request('POST', '/api/ai/batch', { parallel: 1, requests: [1, 2, 3].map(id => ({ id, body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post ' + id }] } })) });
    const lines = b.text.trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.filter(l => l.id).map(l => l.ok), [true, true, true], b.text);
    assert.ok(lines.some(l => l.notice && l.notice.type === 'network'), 'the batch paused: ' + b.text);
  } finally { await late.stop(); }
});

test('answers slower than undici\'s own timeouts: MetaCode waits as long as AI_TIMEOUT_MS says, without sending the prompt again', async () => {
  await configure({});
  svc.chat = (body, send, res) => {
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'slow ' } }] }) + '\n\n');
      setTimeout(() => res.end('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'stream' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'), 1200);
    } else setTimeout(() => send(200, completion(body.model, 'slow answer')), 1200);
    return true;
  };
  const r = await ask('gw/gpt-5.5');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'slow answer');
  assert.equal(svc.seen.length, 1, 'sent once');
  const s = await ask('gw/gpt-5.5', {}, { stream: true });
  assert.equal(s.status, 200);
  assert.match(s.text, /slow [\s\S]*stream[\s\S]*\[DONE\]/);
});

test('started beside its AI service (pm2 starts both at once): MetaCode waits for it before saying how it is', { timeout: 60000 }, async () => {
  const port = await freePort();
  const late = standIn(await freePort());
  const env = Object.assign({}, process.env);
  for (const k of VARIABLES.concat(['NODE_TEST_CONTEXT'])) delete env[k];
  const own = path.join(tmp, 'started');
  Object.assign(env, baseEnv(), { PORT: String(port), OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + late.port + '/v1',
    ACCOUNT_DATA_DIR: path.join(own, 'a'), SURVEY_DATA_DIR: path.join(own, 's'), PROJECT_DATA_DIR: path.join(own, 'p'), AI_LAB_DATA_DIR: path.join(own, 'l'), COLLAB_DATA_DIR: path.join(own, 'c') });
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  try {
    const health = async () => { try { return await (await fetch('http://127.0.0.1:' + port + '/api/health')).json(); } catch (e) { return null; } };
    const h = await until(health, 20000, 'MetaCode to start\n' + out);
    assert.equal(h.aiReady, true, 'while it waits, AI counts as starting');
    await sleep(700);
    await late.start();
    const line = await until(() => /AI\s+→ .*\n/.exec(out), 20000, 'the banner\'s AI line\n' + out);
    assert.match(line[0], /OpenCode service at 127\.0\.0\.1:\d+ \(external\) — Test gateway: ready/);
    assert.equal((await health()).aiReady, true);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([exited, sleep(10000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await late.stop();
  }
});

// ── The AI Coding Lab's price list ────────────────────────────────────────────

test('price lists from before model ids named their provider ("metacode:<id>") still price the gateway\'s models, never another provider\'s', () => {
  const file = path.join(tmp, 'pricing.json');
  fs.writeFileSync(file, JSON.stringify({ asOf: '2026-10-01', models: { 'metacode:claude-opus-5.5': { inputPerMTok: 15, outputPerMTok: 75 }, 'metacode:emis/gpt-5.5': { inputPerMTok: 1, outputPerMTok: 8 } } }));
  const pricing = createPricing(file);
  assert.deepEqual(pricing.costOf('metacode', 'emis/claude-opus-5.5', { promptTokens: 1000, completionTokens: 500 }), { amount: 0.0525, currency: 'USD', basis: 'estimated', pricingAsOf: '2026-10-01' });
  assert.equal(pricing.priceOf('metacode', 'emis/gpt-5.5').input, 1, 'new keys as they are');
  assert.equal(pricing.priceOf('metacode', 'opencode/claude-opus-5.5'), null, 'an old key never prices OpenCode Zen\'s model');
  assert.equal(pricing.priceOf('openai', 'emis/claude-opus-5.5'), null);
});
