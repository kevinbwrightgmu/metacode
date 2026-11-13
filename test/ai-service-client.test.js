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
    models: MODELS, default: 'gw/claude-opus-5.5', providers: PROVIDERS,
    chat: null,                 // (body, send, res) → true when it answered the chat itself
    seen: [], limits: [], formats: [], health: 0, reloads: 0       // limits: each chat's X-Request-Timeout-Ms; formats: its response_format type
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
    const status = { service: { name: 'metacode-opencode', version: 'test' }, ready: true, default: svc.default, warnings: [], providers: svc.providers };
    if (req.url === '/v1/status') return send(200, status);
    if (req.url === '/v1/reload' && req.method === 'POST') { svc.reloads++; return send(200, status); }
    if (req.url === '/v1/models') return send(200, { object: 'list', default: svc.default, providers: svc.providers.map(p => ({ id: p.id, name: p.name, ready: p.ready, backup: p.backup })), data: svc.models });
    if (req.url !== '/v1/chat/completions') return send(404, { error: { type: 'not_found', message: 'Not found.' } });
    const body = JSON.parse(b || '{}');
    svc.seen.push(body.model);
    svc.limits.push([body.model, req.headers['x-request-timeout-ms']]);
    svc.formats.push([body.model, body.response_format ? body.response_format.type : null]);
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
  'AI_FALLBACK_TO_FREE_MODELS', 'AI_BATCH_PAUSE_SECONDS', 'AI_TIMEOUT_MS', 'AI_KEEPALIVE_SECONDS', 'DESKTOP_WITHOUT_ACCOUNTS', 'AI_LOCAL_TIMEOUT_MS', 'AI_LOCAL_PARALLEL'];

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

test('AI Coding\'s "keep going" (anyModel): when the model runs out, a model of any provider picked at random codes the rest of the run — one pick while it lasts, then another; never a free one for a paid one; nothing with AI_MODEL_SWITCH=off', { timeout: 60000 }, async () => {
  const gatewayOut = (body, send) => {
    if (!/^gw\//.test(body.model)) return false;
    send(429, { error: { type: 'quota_exceeded', scope: 'provider', provider: 'gw', retry_after_seconds: 3600, message: 'Test gateway\'s usage quota is used up.' } }, { 'Retry-After': '3600' });
    return true;
  };
  const posts = (n, model) => Array.from({ length: n }, (_, i) => ({ id: 'p' + (i + 1), body: { model: model || 'gw/glm-5.3-flash', messages: [{ role: 'user', content: 'post ' + (i + 1) }] } }));
  const batch = async (extra, requests) => {
    const r = await request('POST', '/api/ai/batch', Object.assign({ parallel: 1, requests: requests || posts(6), switchModels: false }, extra));
    assert.equal(r.status, 200, r.text);
    return r.text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.id);
  };
  const PAID_ELSEWHERE = ['zen/claude-opus-5.5', 'zen/claude-sonnet-4-5'];

  // Without the option (and switching off in the browser): the run stops at the used-up quota
  await configure({}, () => { svc.chat = gatewayOut; });
  let lines = await batch({});
  assert.deepEqual(lines.map(l => (l.ok ? 'ok' : l.error.type)), Array(6).fill('quota_exceeded'));

  // With it: every post is coded, all by one paid model of the other provider, picked at random
  await configure({}, () => { svc.chat = gatewayOut; });
  lines = await batch({ anyModel: true });
  assert.deepEqual(lines.map(l => l.ok), Array(6).fill(true), JSON.stringify(lines));
  const used = [...new Set(lines.map(l => l.fallback))];
  assert.equal(used.length, 1, 'one pick for the run: ' + used);
  assert.ok(PAID_ELSEWHERE.includes(used[0]), 'a paid model, not a free one: ' + used[0]);
  assert.ok(lines.every(l => l.fallbackPick === 'random' && l.requested === 'gw/glm-5.3-flash' && l.fallbackReason === 'rate_limited'), JSON.stringify(lines[0]));
  assert.equal(svc.seen.filter(m => /^gw\//.test(m)).length, 1, 'the used-up gateway was asked once (then it rests)');

  // The pick runs out too: the other paid model takes over, and the run goes on
  await configure({}, () => {
    let first = null;
    svc.chat = (body, send) => {
      if (gatewayOut(body, send)) return true;
      if (!first) first = body.model;
      if (body.model !== first || svc.seen.filter(m => m === first).length < 3) return false;
      send(429, { error: { type: 'quota_exceeded', scope: 'model', provider: 'zen', model: body.model, retry_after_seconds: 3600, message: 'This model\'s spend limit is reached.' } });
      return true;
    };
  });
  lines = await batch({ anyModel: true });
  assert.deepEqual(lines.map(l => l.ok), Array(6).fill(true), JSON.stringify(lines));
  assert.deepEqual([...new Set(lines.map(l => l.fallback))].sort(), PAID_ELSEWHERE.slice().sort(), 'the second paid model took over');

  // A model that keeps failing at its provider (server errors) is left too — even one picked in Settings
  await configure({}, () => {
    svc.chat = (body, send) => {
      if (body.model !== 'gw/gpt-5.5') return false;
      send(502, { error: { type: 'upstream_error', upstream_status: 503, provider: 'gw', model: body.model, message: 'Test gateway couldn\'t run the model (HTTP 503).' } });
      return true;
    };
  });
  lines = await batch({ anyModel: true }, posts(2, 'gw/gpt-5.5'));
  assert.deepEqual(lines.map(l => [l.ok, l.fallbackPick, l.fallbackReason]), [[true, 'random', 'failed'], [true, 'random', 'failed']], JSON.stringify(lines));
  assert.notEqual(lines[0].fallback, 'gw/gpt-5.5');
  assert.ok(!MODELS.find(m => m.id === lines[0].fallback).free, 'not a free model');

  // The operator turned switching off: the option changes nothing
  await configure({ AI_MODEL_SWITCH: 'off' }, () => { svc.chat = gatewayOut; });
  lines = await batch({ anyModel: true });
  assert.deepEqual(lines.map(l => (l.ok ? 'ok' : l.error.type)), Array(6).fill('quota_exceeded'));
  assert.deepEqual(svc.seen.filter(m => /^zen\//.test(m)), [], 'nothing went to another provider');
});

test('a provider paused for hours: a batch doesn\'t wait it out in 30-second steps (each post fails at once), and the message says what could answer meanwhile', { timeout: 60000 }, async () => {
  const paused = (body, send) => {
    if (!/^gw\//.test(body.model)) return false;
    send(429, { error: { type: 'rate_limited', scope: 'provider', provider: 'gw', retry_after_seconds: 79200,
      message: 'Test gateway asked MetaCode to pause (it said: "Daily request budget used up"). Try again in about 22 hours.' } }, { 'Retry-After': '79200' });
    return true;
  };
  await configure({}, () => { svc.chat = paused; });
  const t0 = Date.now();
  const b = await request('POST', '/api/ai/batch', { parallel: 1, switchModels: false, requests: [1, 2, 3, 4, 5].map(i => ({ id: 'p' + i, body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post ' + i }] } })) });
  const lines = b.text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.id);
  assert.ok(Date.now() - t0 < 8000, 'no 30-second waits (' + (Date.now() - t0) + ' ms)');
  assert.deepEqual(lines.map(l => (l.ok ? 'ok' : l.error.type)), Array(5).fill('rate_limited'), b.text);
  assert.match(lines[0].error.message, /Try again in about 22 hours\. Models of another AI provider can answer meanwhile: pick one in Settings → AI models, or turn on "Keep going if the model runs out" next to Run AI Coding\./);
  assert.equal(svc.seen.filter(m => /^gw\//.test(m)).length, 1, 'the paused gateway was asked once');

  // Only free models elsewhere (switching on): the message says how they could stand in
  await configure({}, () => { svc.chat = paused; svc.models = MODELS.filter(m => !/^zen\//.test(m.id) || m.free); });
  const r = await ask('gw/gpt-5.5');
  assert.equal(r.status, 429, r.text);
  assert.match(r.json.error.message, /Free models of another AI provider can answer meanwhile: pick one in Settings → AI models \(marked "· free"\), or let them stand in for paid ones with AI_FALLBACK_TO_FREE_MODELS=on/);
});

// ── One provider paused: the other provider's models answer ──────────────────
// The stand-in's Zen ("zen", like OpenCode Zen) asks MetaCode to pause for `seconds`; the gateway answers
const zenPaused = seconds => (body, send) => {
  if (!/^zen\//.test(body.model)) return false;
  send(429, { error: { type: 'rate_limited', scope: 'provider', provider: 'zen', retry_after_seconds: seconds || 1800, message: 'Zen test asked MetaCode to pause.' } },
    { 'Retry-After': String(seconds || 1800) });
  return true;
};
const batchLines = b => b.text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.id);

test('OpenCode Zen paused: the gateway\'s models answer for its models — one request, a streamed one, AI Coding (the model picked, "keep going", the server\'s default), the desktop app — and nothing more goes to Zen meanwhile', { timeout: 60000 }, async () => {
  await configure({ DESKTOP_WITHOUT_ACCOUNTS: 'on' }, () => { svc.chat = zenPaused(); });
  for (const model of ['zen/big-pickle', 'zen/claude-sonnet-4-5']) {           // a free model and a paid one
    const r = await ask(model);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('x-metacode-model-fallback') || '', /^gw\//, model);
    assert.equal(r.headers.get('x-metacode-model-fallback-reason'), 'rate_limited', model);
    assert.match(r.json.choices[0].message.content, /^ok from gw\//);
  }
  assert.deepEqual(svc.seen.filter(m => /^zen\//.test(m)), ['zen/big-pickle'], 'Zen was asked once: it rests now');
  // streamed
  const s = await ask('zen/big-pickle', {}, { stream: true });
  assert.equal(s.status, 200, s.text);
  assert.match(s.headers.get('x-metacode-model-fallback') || '', /^gw\//);
  assert.match(s.text, /ok from gw\//);
  // AI Coding with a Zen model picked, then with "keep going"
  for (const anyModel of [false, true]) {
    const b = await request('POST', '/api/ai/batch', { parallel: 2, anyModel, requests: [1, 2, 3, 4].map(i => ({ id: 'p' + i, body: { model: 'zen/big-pickle', messages: [{ role: 'user', content: 'post ' + i }] } })) });
    const lines = batchLines(b);
    assert.deepEqual(lines.map(l => l.ok), [true, true, true, true], b.text);
    assert.ok(lines.every(l => /^gw\//.test(l.fallback) && l.fallbackReason === 'rate_limited' && l.requested === 'zen/big-pickle'), b.text);
    assert.ok(lines.every(l => l.fallbackPick === (anyModel ? 'random' : 'closest')), b.text);
  }
  // the desktop app's AI tools
  const d = await request('POST', '/api/desktop/ai', { model: 'zen/big-pickle', messages: [{ role: 'user', content: 'a formula' }] });
  assert.equal(d.status, 200, d.text);
  assert.match(d.json.model, /^gw\//);
  assert.match(d.json.text, /^ok from gw\//);
  assert.deepEqual(svc.seen.filter(m => /^zen\//.test(m)), ['zen/big-pickle'], 'nothing more went to Zen');

  // The server's default model is Zen's
  await configure({}, () => { svc.chat = zenPaused(); svc.default = 'zen/big-pickle'; });
  const r = await ask(null);
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get('x-metacode-model-fallback') || '', /^gw\//);

  // Switching turned off (Settings → AI models): Zen's pause is the answer, and it says what could answer meanwhile
  await configure({}, () => { svc.chat = zenPaused(); });
  const off = await ask('zen/big-pickle', SWITCH_OFF);
  assert.equal(off.status, 429, off.text);
  assert.match(off.json.error.message, /^Zen test asked MetaCode to pause\. Models of another AI provider can answer meanwhile: pick one in Settings → AI models\.$/);
});

test('OpenCode Zen with a key, its free models\' limit used up (code "free_models"): every free Zen model is left out — a paid model answers at once, not after the other free ones', async () => {
  const models = MODELS.concat([entry('zen/big-pickle-2-free', 'Big Pickle 2 Free', { free: true })]);     // (more like Big Pickle than any paid model)
  const isFree = id => !!(models.find(m => m.id === id) || {}).free;
  await configure({}, () => {
    svc.models = models;
    svc.chat = (body, send) => {
      if (!/^zen\//.test(body.model) || !isFree(body.model)) return false;
      send(429, { error: { type: 'quota_exceeded', scope: 'model', code: 'free_models', provider: 'zen', model: body.model, retry_after_seconds: 1800,
        message: 'Zen test\'s usage limit for free models is used up. It resets in 30 minutes. Pick a paid model.' } }, { 'Retry-After': '1800' });
      return true;
    };
  });
  for (const [i, model] of ['zen/big-pickle', 'zen/glm-5.3-flash-free'].entries()) {
    svc.seen.length = 0;
    const r = await ask(model);
    assert.equal(r.status, 200, r.text);
    const used = r.headers.get('x-metacode-model-fallback');
    assert.ok(used && !isFree(used), model + ': a paid model answered (' + used + ')');
    assert.deepEqual(svc.seen.filter(isFree), i ? [] : [model], model + (i ? ': not even sent (its free models rest)' : ': no other free Zen model was tried'));
  }
  // streamed, and AI Coding with "keep going": no free model either
  svc.seen.length = 0;
  const st = await ask('zen/big-pickle-2-free', {}, { stream: true });
  assert.equal(st.status, 200, st.text);
  assert.ok(!isFree(st.headers.get('x-metacode-model-fallback')), String(st.headers.get('x-metacode-model-fallback')));
  const kg = batchLines(await request('POST', '/api/ai/batch', { parallel: 2, anyModel: true, requests: [1, 2, 3].map(i => ({ id: 'p' + i, body: { model: 'zen/big-pickle', messages: [{ role: 'user', content: 'post ' + i }] } })) }));
  assert.ok(kg.every(l => l.ok && l.fallback && !isFree(l.fallback)), JSON.stringify(kg));
  assert.deepEqual(svc.seen.filter(isFree), [], 'no free model was sent anything');
  // the paid Zen models still answer for themselves
  assert.equal((await ask('zen/claude-sonnet-4-5')).headers.get('x-metacode-model-fallback'), null);
  // Switching off: Zen's own words and its reset time, not "rate-limiting the model … 15 minutes"; other free models
  // get the same answer without being sent
  svc.seen.length = 0;
  for (const model of ['zen/big-pickle', 'zen/big-pickle-2-free']) {
    const off = await ask(model, SWITCH_OFF);
    assert.equal(off.status, 429, off.text);
    assert.equal(off.json.error.type, 'quota_exceeded', model);
    assert.match(off.json.error.message, /^Zen test's usage limit for free models is used up\. It resets in 30 minutes\. Pick a paid model\. Other models can answer meanwhile: pick one in Settings → AI models\.$/, model);
    assert.ok(off.json.error.retryAfterSeconds > 1700, String(off.json.error.retryAfterSeconds));
  }
  assert.deepEqual(svc.seen, [], 'nothing was sent');
});

test('both providers paused: the message says the other one can\'t answer meanwhile either, and until when — also the first time, when MetaCode only learns it by trying one of its models', async () => {
  const setup = () => {
    svc.chat = (body, send) => {
      if (/^gw\//.test(body.model)) {
        send(429, { error: { type: 'rate_limited', scope: 'provider', provider: 'gw', retry_after_seconds: 79200, message: 'Test gateway asked MetaCode to pause. Try again in about 22 hours.' } }, { 'Retry-After': '79200' });
        return true;
      }
      return zenPaused(300)(body, send);
    };
  };
  const BOTH = /^Zen test asked MetaCode to pause\. Test gateway can't answer meanwhile either: it asked MetaCode to pause — it can be used again in about 22 hours \(/;
  await configure({}, setup);
  const first = await ask('zen/big-pickle');
  assert.equal(first.status, 429, first.text);
  assert.match(first.json.error.message, BOTH);
  assert.ok(svc.seen.some(m => /^gw\//.test(m)), 'a gateway model was tried');
  const again = await ask('zen/big-pickle');
  assert.match(again.json.error.message, BOTH);
  // …and for the gateway's models, the other way round; Zen's paid models could answer for them when Zen is
  // back in 5 minutes, so that's when to try again
  const gw = await ask('gw/gpt-5.5');
  assert.equal(gw.status, 429, gw.text);
  assert.match(gw.json.error.message, /^Test gateway asked MetaCode to pause\. Try again in about 22 hours\. Zen test can't answer meanwhile either: it asked MetaCode to pause — it can be used again in 5 minutes \(/);
  assert.ok(Number(gw.headers.get('retry-after')) <= 300, gw.headers.get('retry-after'));

  // Streamed: the same — the model asked for, and no "answered by" headers on a failure
  for (const stream of [true]) {
    await configure({}, setup);
    const s1 = await ask('zen/big-pickle', {}, { stream });
    assert.equal(s1.status, 429, s1.text);
    assert.match(s1.json.error.message, BOTH);
    assert.equal(s1.headers.get('x-metacode-model-fallback'), null);
    assert.match((await ask('zen/big-pickle', {}, { stream })).json.error.message, BOTH);
  }
});

test('the desktop app and the Lab pick their models themselves: their messages say "pick another model", not Settings → AI models', async () => {
  await configure({ DESKTOP_WITHOUT_ACCOUNTS: 'on', AI_MODEL_SWITCH: 'off' }, () => { svc.chat = zenPaused(1800); });
  const d = await request('POST', '/api/desktop/ai', { model: 'zen/big-pickle', messages: [{ role: 'user', content: 'a formula' }] });
  assert.equal(d.status, 429, d.text);
  assert.match(d.json.error.message, /^Zen test asked MetaCode to pause\. Models of another AI provider can answer meanwhile: pick another model\.$/);
  // the website's own request says where to pick
  const w = await ask('zen/big-pickle');
  assert.match(w.json.error.message, /^Zen test asked MetaCode to pause\. Models of another AI provider can answer meanwhile: pick one in Settings → AI models\.$/);
});

test('the AI Coding Lab never switches models (it compares the ones picked): while Zen rests, its chat and its stream fail with Zen\'s pause, and nothing goes to the gateway', async () => {
  await configure({}, () => { svc.chat = zenPaused(1800); });
  const lab = require('../server').aiLab.registry.get('metacode');
  const req = { model: 'zen/big-pickle', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 };
  await assert.rejects(lab.chat(req), e => /Zen test asked MetaCode to pause\. Models of another AI provider can answer meanwhile: pick another model\.$/.test(e.message));
  await assert.rejects(lab.stream(req, () => {}), e => /Zen test asked MetaCode to pause\. Models of another AI provider can answer meanwhile: pick another model\.$/.test(e.message));
  assert.deepEqual(svc.seen, ['zen/big-pickle'], 'nothing went to the gateway');
});

test('a model\'s own rate limit (switching off) while the other provider\'s usage limit is used up: the message ends "… turned off in Settings → AI models.) Zen test can\'t answer meanwhile either: its usage limit is used up — …"', async () => {
  await configure({}, () => {
    svc.models = MODELS.filter(m => ['gw/gpt-5.5', 'zen/claude-sonnet-4-5', 'zen/big-pickle'].includes(m.id));
    svc.default = 'gw/gpt-5.5';
    svc.chat = (body, send) => {
      if (/^zen\//.test(body.model)) {
        send(429, { error: { type: 'quota_exceeded', scope: 'provider', provider: 'zen', retry_after_seconds: 1800, message: 'Zen test\'s usage limit is used up. It resets in 30 minutes.' } }, { 'Retry-After': '1800' });
        return true;
      }
      send(429, { error: { type: 'rate_limited', scope: 'model', provider: 'gw', model: body.model, retry_after_seconds: 120, message: 'Test gateway is rate-limiting the model.' } }, { 'Retry-After': '120' });
      return true;
    };
  });
  assert.equal((await ask('zen/claude-sonnet-4-5', SWITCH_OFF)).status, 429);            // (Zen's usage limit: Zen rests)
  const r = await ask('gw/gpt-5.5', SWITCH_OFF);
  assert.equal(r.status, 429, r.text);
  assert.match(r.json.error.message, /\(Switching to a similar model is turned off in Settings → AI models\.\) Zen test can't answer meanwhile either: its usage limit is used up — it can be used again in 30 minutes \([^)]*\)\.$/);
});

test('a resting provider that couldn\'t stand in anyway (only free models, for a paid model) isn\'t named for a short wait', async () => {
  await configure({}, () => {
    svc.models = MODELS.filter(m => !/^zen\//.test(m.id) || m.free);
    svc.chat = (body, send) => {
      if (/^zen\//.test(body.model)) {
        send(429, { error: { type: 'quota_exceeded', scope: 'provider', provider: 'zen', retry_after_seconds: 1800, message: 'Zen test\'s usage limit is used up.' } }, { 'Retry-After': '1800' });
        return true;
      }
      send(429, { error: { type: 'rate_limited', scope: 'provider', provider: 'gw', retry_after_seconds: 300, message: 'Test gateway asked MetaCode to pause.' } }, { 'Retry-After': '300' });
      return true;
    };
  });
  assert.equal((await ask('zen/big-pickle', SWITCH_OFF)).status, 429);                     // (Zen's free limit: Zen rests)
  const r = await ask('gw/gpt-5.5');
  assert.equal(r.status, 429, r.text);
  assert.equal(r.json.error.message, 'Test gateway asked MetaCode to pause.');
});

test('Zen paused and the gateway\'s similar models rate-limited one by one (a key that isn\'t paused as a whole): the message says those were tried and are limited too', async () => {
  await configure({}, () => {
    svc.chat = (body, send) => {
      if (/^gw\//.test(body.model)) {
        send(429, { error: { type: 'rate_limited', scope: 'model', provider: 'gw', model: body.model, retry_after_seconds: 79200, message: 'Test gateway is rate-limiting the model.' } }, { 'Retry-After': '79200' });
        return true;
      }
      return zenPaused(900)(body, send);
    };
  });
  const r = await ask('zen/big-pickle');
  assert.equal(r.status, 429, r.text);
  assert.match(r.json.error.message, /^Zen test asked MetaCode to pause\. The most similar models of another AI provider \("[^"]+ \(Test gateway\)"(, "[^"]+ \(Test gateway\)")+\) are rate-limited too\.$/);
  assert.equal(r.headers.get('x-metacode-model-fallback'), null);
});

test('AI Coding: Zen paused for an hour, the gateway for a few seconds — the posts wait for the gateway instead of failing at once', { timeout: 60000 }, async () => {
  let gwBackAt = 0;
  await configure({}, () => {
    svc.chat = (body, send) => {
      if (/^gw\//.test(body.model) && Date.now() < gwBackAt) {
        send(429, { error: { type: 'rate_limited', scope: 'provider', provider: 'gw', retry_after_seconds: 3, message: 'Test gateway asked MetaCode to pause.' } }, { 'Retry-After': '3' });
        return true;
      }
      return zenPaused(3600)(body, send);
    };
  });
  gwBackAt = Date.now() + 3000;
  const t0 = Date.now();
  const b = await request('POST', '/api/ai/batch', { parallel: 2, requests: [1, 2, 3].map(i => ({ id: 'p' + i, body: { model: 'zen/big-pickle', messages: [{ role: 'user', content: 'post ' + i }] } })) });
  const lines = batchLines(b);
  assert.deepEqual(lines.map(l => (l.ok ? 'ok' : l.error.type)), ['ok', 'ok', 'ok'], b.text);
  assert.ok(lines.every(l => /^gw\//.test(l.fallback)), b.text);
  assert.ok(Date.now() - t0 >= 2500, 'waited for the gateway (' + (Date.now() - t0) + ' ms)');
});

test('one model rate-limited with switching off: its message says so, with nothing about other providers after it', async () => {
  const limited = (body, send) => {
    if (body.model !== 'gw/gpt-5.5') return false;
    send(429, { error: { type: 'rate_limited', scope: 'model', provider: 'gw', model: body.model, retry_after_seconds: 900, message: 'Test gateway is rate-limiting the model right now.' } }, { 'Retry-After': '900' });
    return true;
  };
  await configure({}, () => { svc.chat = limited; });
  const r = await ask('gw/gpt-5.5', SWITCH_OFF);
  assert.equal(r.status, 429, r.text);
  assert.match(r.json.error.message, /right now\. The first one can be used again in 15 minutes \([^)]*\)\. \(Switching to a similar model is turned off in Settings → AI models\.\)$/);
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

// ── The local backup (Ollama on this server) ─────────────────────────────────
// Its models (backup: true) answer only when no other provider's model can — and none is back within a minute —
// the first of them (the service lists the best first), one request at a time, with AI_LOCAL_TIMEOUT_MS
const LOCAL = { id: 'local', name: 'Local backup (Ollama)', ready: true, backup: true, local: true, keyCount: 0, note: 'Last-resort backup.' };
const LOCAL_MODELS = ['tiny:1b', 'tiny:270m'].map(m => ({ id: 'local/' + m, object: 'model', provider: 'local', provider_name: LOCAL.name, model: m, name: m + ' (local backup)',
  free: false, available: true, backup: true, local: true }));
const withLocal = () => { svc.providers = PROVIDERS.concat([LOCAL]); svc.models = MODELS.concat(LOCAL_MODELS); };
// A provider that asked MetaCode to pause for `seconds` (until `until`, when given: then it answers again)
const pausedFor = (provider, seconds, until) => (body, send) => {
  if (!body.model.startsWith(provider + '/') || (until && Date.now() >= until)) return false;
  send(429, { error: { type: 'rate_limited', scope: 'provider', provider, retry_after_seconds: seconds, message: provider + ' asked MetaCode to pause.' } }, { 'Retry-After': String(seconds) });
  return true;
};
const bothOut = () => (body, send) => pausedFor('gw', 79200)(body, send) || pausedFor('zen', 1800)(body, send);
const isLocal = m => /^local\//.test(m || '');

test('the local backup: listed as such, never the default, never standing in while another provider\'s model can (or can within a minute); once every other provider is out, its best model answers — a request, a stream, AI Coding, "keep going"', { timeout: 60000 }, async () => {
  const ai = await configure({}, withLocal);
  assert.deepEqual(ai.providers.map(p => [p.id, p.backup, p.local]), [['gw', false, false], ['zen', false, false], ['local', true, true]]);
  const list = await request('GET', '/api/models');
  assert.equal(list.json.models[0].id, 'gw/claude-opus-5.5', 'the default');
  assert.deepEqual(list.json.models.filter(m => isLocal(m.id)).map(m => [m.id, m.backup, m.local]), [['local/tiny:1b', true, true], ['local/tiny:270m', true, true]]);
  assert.equal((await ask()).status, 200);
  assert.deepEqual(svc.seen, ['gw/claude-opus-5.5']);

  // The gateway paused for hours: Zen's models answer for its models, never the backup
  await configure({}, () => { withLocal(); svc.chat = pausedFor('gw', 79200); });
  for (const model of ['gw/gpt-5.5', 'gw/claude-opus-5.5']) {
    const r = await ask(model);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('x-metacode-model-fallback'), /^zen\//);
  }
  let b = await request('POST', '/api/ai/batch', { parallel: 2, anyModel: true, requests: [1, 2, 3].map(i => ({ id: 'p' + i, body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post ' + i }] } })) });
  assert.deepEqual(batchLines(b).map(l => l.ok && /^zen\//.test(l.fallback)), [true, true, true], b.text);
  assert.equal(svc.seen.some(isLocal), false, 'nothing went to the backup');

  // Zen's pause ends within a minute: an AI Coding post waits for it rather than going to the backup
  await configure({}, () => { withLocal(); const until = Date.now() + 2500; svc.chat = (body, send) => pausedFor('gw', 79200)(body, send) || pausedFor('zen', 2, until)(body, send); });
  b = await request('POST', '/api/ai/batch', { parallel: 1, requests: [{ id: 'p1', body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post 1' }] } }] });
  const waited = batchLines(b);
  assert.deepEqual(waited.map(l => [l.ok, /^zen\//.test(l.fallback || '')]), [[true, true]], b.text);
  assert.equal(svc.seen.some(isLocal), false, 'nothing went to the backup');

  // Every other provider out for longer: the backup's first model answers — for a paid model and a free one, streamed too
  await configure({}, () => { withLocal(); svc.chat = bothOut(); });
  for (const model of ['gw/gpt-5.5', 'zen/big-pickle', undefined]) {
    const r = await ask(model);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get('x-metacode-model-fallback'), 'local/tiny:1b', String(model));
    assert.equal(r.json.choices[0].message.content, 'ok from local/tiny:1b');
  }
  const s = await ask('gw/claude-opus-5.5', {}, { stream: true });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.headers.get('x-metacode-model-fallback'), 'local/tiny:1b');
  assert.match(s.text, /ok from local\/tiny:1b/);
  // (its requests get AI_LOCAL_TIMEOUT_MS, 5 minutes by default; the others AI_TIMEOUT_MS)
  assert.ok(svc.limits.filter(([m]) => isLocal(m)).every(([, ms]) => ms === '300000'), JSON.stringify(svc.limits));
  assert.ok(svc.limits.filter(([m]) => !isLocal(m)).every(([, ms]) => ms === '120000'), JSON.stringify(svc.limits));

  // (only AI Coding's answers must be JSON: nothing above asked for it)
  assert.ok(svc.formats.every(([, f]) => f === null), JSON.stringify(svc.formats));

  // AI Coding: the model picked, and "keep going" — the backup's best model, not one at random; Ollama is told
  // to answer with valid JSON (only the backup: the other providers' models get the request as it was)
  for (const anyModel of [false, true]) {
    await configure({}, () => { withLocal(); svc.chat = bothOut(); });
    b = await request('POST', '/api/ai/batch', { parallel: 2, anyModel, requests: [1, 2, 3, 4].map(i => ({ id: 'p' + i, body: { model: 'gw/glm-5.3-flash', messages: [{ role: 'user', content: 'post ' + i }] } })) });
    assert.deepEqual(batchLines(b).map(l => [l.ok, l.fallback]), Array(4).fill([true, 'local/tiny:1b']), b.text);
    assert.deepEqual([...new Set(svc.formats.map(([m, f]) => (isLocal(m) ? 'local:' : 'other:') + f))].sort(), ['local:json_object', 'other:null']);
  }
  // …and "Code this" (one post: X-MetaCode-Feature: coding)
  const one = await ask('gw/gpt-5.5', { 'X-MetaCode-Feature': 'coding' });
  assert.equal(one.headers.get('x-metacode-model-fallback'), 'local/tiny:1b');
  assert.deepEqual(svc.formats[svc.formats.length - 1], ['local/tiny:1b', 'json_object']);

  // A free model that can't stand in for a paid one (its provider may use the prompts) leaves the backup to answer:
  // its prompts stay on this server
  await configure({}, () => { withLocal(); svc.models = svc.models.filter(m => !/^zen\//.test(m.id) || m.free); svc.chat = pausedFor('gw', 79200); });
  const p = await ask('gw/gpt-5.5');
  assert.equal(p.status, 200, p.text);
  assert.equal(p.headers.get('x-metacode-model-fallback'), 'local/tiny:1b');
  assert.equal(svc.seen.some(m => /^zen\//.test(m)), false);
});

test('the local backup with switching off: nothing switches to it, and the message says it could answer', async () => {
  await configure({}, () => { withLocal(); svc.chat = bothOut(); });
  assert.equal((await ask('zen/claude-opus-5.5', SWITCH_OFF)).status, 429);      // (MetaCode learns that Zen is paused too)
  const r = await ask('gw/gpt-5.5', SWITCH_OFF);
  assert.equal(r.status, 429, r.text);
  assert.match(r.json.error.message, /^gw asked MetaCode to pause\. The local backup \(small models on this server, slower and weaker\) can answer meanwhile: pick one of its models in Settings → AI models\.$/);
  assert.equal(svc.seen.some(isLocal), false);
  const lines = batchLines(await request('POST', '/api/ai/batch', { parallel: 1, switchModels: false, requests: [{ id: 'p1', body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post' }] } }] }));
  assert.equal(svc.seen.some(isLocal), false);
  assert.match(lines[0].error.message, /The local backup \(small models on this server, slower and weaker\) can answer meanwhile: pick one of its models in Settings → AI models, or turn on "Keep going if the model runs out" next to Run AI Coding\.$/);
});

test('the local backup answers one request at a time (AI_LOCAL_PARALLEL), the wait not counted toward its time limit (AI_LOCAL_TIMEOUT_MS); a slow answer says what to change', { timeout: 60000 }, async () => {
  let active = 0, most = 0;
  const slowLocal = ms => (body, send) => {
    if (!isLocal(body.model)) return bothOut()(body, send);
    active++; most = Math.max(most, active);
    setTimeout(() => { active--; send(200, completion(body.model, 'ok from ' + body.model)); }, ms);
    return true;
  };
  // 4 posts at once, each taking 0.6 s: one after the other, the last one waiting about 1.8 s — longer than AI_TIMEOUT_MS,
  // which isn't the backup's limit
  await configure({ AI_TIMEOUT_MS: '1000' }, () => { withLocal(); svc.chat = slowLocal(600); });
  let b = await request('POST', '/api/ai/batch', { parallel: 4, requests: [1, 2, 3, 4].map(i => ({ id: 'p' + i, body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post ' + i }] } })) });
  assert.deepEqual(batchLines(b).map(l => [l.ok, l.fallback]), Array(4).fill([true, 'local/tiny:1b']), b.text);
  assert.equal(most, 1, 'one at a time');
  assert.ok(svc.limits.filter(([m]) => isLocal(m)).every(([, ms]) => ms === '300000'), 'AI_LOCAL_TIMEOUT_MS, not AI_TIMEOUT_MS: ' + JSON.stringify(svc.limits));

  most = 0;
  await configure({ AI_LOCAL_PARALLEL: '2', AI_LOCAL_TIMEOUT_MS: '20000' }, () => { withLocal(); svc.chat = slowLocal(300); });
  b = await request('POST', '/api/ai/batch', { parallel: 4, requests: [1, 2, 3, 4].map(i => ({ id: 'p' + i, body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post ' + i }] } })) });
  assert.deepEqual(batchLines(b).map(l => l.ok), [true, true, true, true], b.text);
  assert.equal(most, 2, 'AI_LOCAL_PARALLEL=2');
  assert.ok(svc.limits.filter(([m]) => isLocal(m)).every(([, ms]) => ms === '20000'), JSON.stringify(svc.limits));

  // Too slow: after AI_LOCAL_TIMEOUT_MS, the message names the model and what to change
  await configure({ AI_LOCAL_TIMEOUT_MS: '10000', AI_TIMEOUT_MS: '1000' }, () => { withLocal(); svc.chat = (body) => isLocal(body.model); });
  const t0 = Date.now();
  const r = await ask('local/tiny:1b');
  assert.equal(r.status, 504, r.text);
  assert.ok(Date.now() - t0 >= 9500, 'waited AI_LOCAL_TIMEOUT_MS (' + (Date.now() - t0) + ' ms)');
  assert.equal(r.json.error.message, 'The local backup model "tiny:1b" didn\'t answer within 10 seconds. This server\'s CPU may be too slow for it: pick a smaller model in OLLAMA_MODELS, or raise AI_LOCAL_TIMEOUT_MS in the server\'s .env file.');
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

// ── Long answers behind a proxy ───────────────────────────────────────────────
// A proxy in front of MetaCode that closes a response once it has sent nothing for `idleMs`
// (Cloudflare does after about 100 s, nginx after its proxy_read_timeout): the browser then
// reports net::ERR_INCOMPLETE_CHUNKED_ENCODING and the batch fails with "network error".
async function silentProxy(idleMs) {
  const s = http.createServer((req, res) => {
    const up = http.request(base + req.url, { method: req.method, headers: req.headers }, ur => {
      res.writeHead(ur.statusCode, ur.headers);
      let timer = null;
      const idle = () => { clearTimeout(timer); timer = setTimeout(() => { res.destroy(); ur.destroy(); }, idleMs); };
      idle();
      ur.on('data', c => { idle(); res.write(c); });
      ur.on('end', () => { clearTimeout(timer); res.end(); });
      ur.on('error', () => { clearTimeout(timer); res.destroy(); });
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + s.address().port, close: () => new Promise(r => { s.closeAllConnections(); s.close(r); }) };
}
// The whole body as the browser gets it through the proxy, or how it broke off
async function through(proxy, p, body) {
  const r = await fetch(proxy.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try { return { status: r.status, text: await r.text() }; } catch (e) { return { status: r.status, broken: String(e && e.cause ? e.cause.code || e.cause.message : e) }; }
}

test('a batch whose first answers take longer than a proxy waits: MetaCode keeps the response open with a blank line every AI_KEEPALIVE_SECONDS', { timeout: 30000 }, async () => {
  await configure({ AI_KEEPALIVE_SECONDS: '1' }, () => {
    svc.chat = (body, send) => { setTimeout(() => send(200, completion(body.model, 'coded')), 3500); return true; };
  });
  const proxy = await silentProxy(2000);
  try {
    const r = await through(proxy, '/api/ai/batch', { requests: [1, 2, 3].map(i => ({ id: 'p' + i, body: { model: 'gw/gpt-5.5', messages: [{ role: 'user', content: 'post ' + i }] } })), parallel: 3 });
    assert.equal(r.broken, undefined, 'the proxy closed the batch: ' + r.broken);
    const lines = r.text.split('\n');
    const results = lines.filter(l => l.trim()).map(l => JSON.parse(l));
    assert.deepEqual(results.filter(x => x.id).map(x => [x.id, x.ok, x.data.choices[0].message.content]).sort(), [['p1', true, 'coded'], ['p2', true, 'coded'], ['p3', true, 'coded']]);
    assert.ok(results.some(x => x.done), 'the batch finished');
    assert.ok(lines.indexOf('') >= 0 && lines.indexOf('') < lines.findIndex(l => l.includes('"p')), 'blank lines came while nothing was answered yet');
  } finally { await proxy.close(); }
});

test('a streamed answer whose first part takes longer than a proxy waits: MetaCode sends SSE comments meanwhile', { timeout: 30000 }, async () => {
  await configure({ AI_KEEPALIVE_SECONDS: '1' }, () => {
    svc.chat = (body, send, res) => {
      // (like the service: the status line once it has waited a while, then nothing until the first part)
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      setTimeout(() => res.end('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: 'thought it over' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'), 3500);
      return true;
    };
  });
  const proxy = await silentProxy(2000);
  try {
    const r = await through(proxy, '/api/ai', { model: 'gw/gpt-5.5', stream: true, messages: [{ role: 'user', content: 'think first' }] });
    assert.equal(r.broken, undefined, 'the proxy closed the stream: ' + r.broken);
    assert.match(r.text, /^: keep-alive$/m);
    assert.match(r.text, /thought it over[\s\S]*data: \[DONE\]/);
  } finally { await proxy.close(); }
});

test('price lists from before model ids named their provider ("metacode:<id>") still price the gateway\'s models, never another provider\'s', () => {
  const file = path.join(tmp, 'pricing.json');
  fs.writeFileSync(file, JSON.stringify({ asOf: '2026-10-01', models: { 'metacode:claude-opus-5.5': { inputPerMTok: 15, outputPerMTok: 75 }, 'metacode:emis/gpt-5.5': { inputPerMTok: 1, outputPerMTok: 8 } } }));
  const pricing = createPricing(file);
  assert.deepEqual(pricing.costOf('metacode', 'emis/claude-opus-5.5', { promptTokens: 1000, completionTokens: 500 }), { amount: 0.0525, currency: 'USD', basis: 'estimated', pricingAsOf: '2026-10-01' });
  assert.equal(pricing.priceOf('metacode', 'emis/gpt-5.5').input, 1, 'new keys as they are');
  assert.equal(pricing.priceOf('metacode', 'opencode/claude-opus-5.5'), null, 'an old key never prices OpenCode Zen\'s model');
  assert.equal(pricing.priceOf('openai', 'emis/claude-opus-5.5'), null);
});
