// Settings and Projects: the .env loader (encodings, file names, overrides,
// reload), the settings status / reload API, per-feature AI models (against a
// stand-in for MetaCode's AI service), the saved-projects API, and both pages
// in a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createEnvLoader, decode } = require('../env-file');
const { testEnv } = require('./helpers/harness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-settings-'));
const envFile = path.join(tmp, 'settings.env');

/* ── .env loader (unit) ───────────────────── */
test('decode reads UTF-8, UTF-8 with BOM and UTF-16 (with and without BOM)', () => {
  const text = 'OPENCODE_API_KEY=abc\nPORT=1\n';
  assert.equal(decode(Buffer.from(text)).text, text);
  assert.equal(decode(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text)])).text, text);
  const le = decode(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
  assert.deepEqual([le.text, le.encoding], [text, 'UTF-16 LE']);
  assert.equal(decode(Buffer.from(text, 'utf16le')).text, text);
  const be = Buffer.from(text, 'utf16le'); be.swap16();
  assert.equal(decode(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])).text, text);
});

test('the loader finds .env.txt, wins over stale system values, reports names only, and reloads', () => {
  const saved = { file: process.env.METACODE_ENV_FILE, key: process.env.MC_TEST_KEY, other: process.env.MC_TEST_OTHER };
  delete process.env.METACODE_ENV_FILE;
  const appDir = fs.mkdtempSync(path.join(tmp, 'app-'));
  try {
    fs.writeFileSync(path.join(appDir, '.env.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('MC_TEST_KEY = "secret-value"\r\nMC_TEST_OTHER=1\r\n', 'utf16le')]));
    process.env.MC_TEST_KEY = 'stale';
    const loader = createEnvLoader(appDir);
    const info = loader.load();
    assert.equal(info.found, true);
    assert.equal(info.name, '.env.txt');
    assert.equal(info.where, 'the MetaCode folder');
    assert.equal(info.encoding, 'UTF-16 LE');
    assert.deepEqual(info.keys, ['MC_TEST_KEY', 'MC_TEST_OTHER']);
    assert.deepEqual(info.overridden, ['MC_TEST_KEY']);
    assert.equal(process.env.MC_TEST_KEY, 'secret-value');
    assert.ok(!JSON.stringify(info).includes('secret-value'), 'values are never reported');
    assert.ok(info.warnings.some(w => /\.env\.txt/.test(w)) && info.warnings.some(w => /UTF-16/.test(w)));
    // A key removed from the file stops applying after a reload
    fs.writeFileSync(path.join(appDir, '.env.txt'), 'MC_TEST_KEY=new\n');
    loader.load();
    assert.equal(process.env.MC_TEST_KEY, 'new');
    assert.equal(process.env.MC_TEST_OTHER, undefined);
  } finally {
    if (saved.file === undefined) delete process.env.METACODE_ENV_FILE; else process.env.METACODE_ENV_FILE = saved.file;
    ['MC_TEST_KEY', 'MC_TEST_OTHER'].forEach(k => { delete process.env[k]; });
  }
});

/* ── Server: settings status, reload, models, projects ─── */
let aiService, serviceBase, server, base, browser;
const seenModels = [];
const faults = { broken: new Set(), flaky: 0 };   // models that always fail; number of next requests that fail with 503
// Parallel AI Coding: how many slow requests the AI service is working on at once
const load = { now: 0, max: 0, total: 0, garbled: new Set() };
// Rate limits: how often each model was called
const hits = {};
// Server errors (HTTP 502): flop-* models always fail; wobbly-coder fails while wobble.left > 0
const wobble = { left: 0 };
// What the AI service saw and says: whether a provider is set up (it reads the same .env as MetaCode,
// see /v1/reload), Reload .env calls, requests without the right token, MetaCode's timeout header
const SERVICE_TOKEN = 'test-service-token-0123456789';
const GATEWAY_KEY = 'emis-test-key-123456';
const SERVICE_STARTED = new Date().toISOString();
const service = { ready: false, reloads: 0, wrongToken: 0, timeoutHeader: null };
// .env lines pointing MetaCode at the AI service (and the key the service reads from the same file)
const serviceEnv = (url, token) => 'OPENCODE_SERVICE_URL=' + (url || serviceBase) + '\nOPENCODE_SERVICE_TOKEN=' + (token || SERVICE_TOKEN) + '\n';
const keyLine = 'EMIS_API_KEY=' + GATEWAY_KEY + '\n';

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
const chromiumPath = findChromium();
const noBrowser = !chromiumPath && 'no Chromium found (set CHROMIUM_PATH)';

// The models the stand-in lists: plain ids (as an older service, or a provider, would list them) and a
// few "provider/model" ids of two providers with names, as the service lists them
const PLAIN_MODELS = ['model-a', 'model-b', 'model-c', 'sse-model', 'responses-model', 'responses-sse-model', 'streams-unless-told', 'wrapped-model', 'picture-model',
  'error200-model', 'think-model', 'forbidden-model', 'unicode-model', 'slow-model', 'coder-model', 'acme-opus-4-8', 'acme-opus-4-7', 'acme-opus-3-0', 'acme-mini-2',
  'acme-opus-4-9', 'strm-pro-2-0', 'strm-pro-1-9', 'flop-pro-3-0', 'flop-pro-2-9', 'flop-pro-2-8', 'wobbly-coder'];
const PROVIDERS = [{ id: 'gw', name: 'Test gateway' }, { id: 'zen', name: 'Zen test' }];
const NAMED_MODELS = [['zen/pickle-pro-1', 'Pickle Pro 1'], ['gw/pickle-pro-1', 'Pickle Pro 1'], ['gw/pickle-pro-2', 'Pickle Pro 2'], ['gw/pickle-mini', 'Pickle Mini'], ['gw/quota-all', 'Quota All']];
function modelList() {
  if (!service.ready) return { object: 'list', default: null, providers: PROVIDERS.map(p => Object.assign({ ready: false }, p)), data: [] };
  const named = NAMED_MODELS.map(([id, name]) => {
    const [provider, model] = id.split('/');
    return { id, object: 'model', provider, provider_name: PROVIDERS.find(p => p.id === provider).name, model, name, available: true };
  });
  return { object: 'list', providers: PROVIDERS.map(p => Object.assign({ ready: true }, p)), data: PLAIN_MODELS.map(id => ({ id })).concat(named) };
}
// GET /v1/status. The gateway's entry has fields MetaCode must not pass on (its key): only the known ones reach the browser
function serviceStatus() {
  return {
    service: { name: 'metacode-opencode', version: 'test', opencode: '2.1.4', startedAt: SERVICE_STARTED, pid: process.pid, host: '127.0.0.1', port: aiService.address().port },
    ready: service.ready, default: null, warnings: [],
    providers: [
      { id: 'gw', name: 'Test gateway', kind: 'openai-compatible', ready: service.ready, problem: service.ready ? null : 'Add the gateway key in .env, then Reload .env.', warnings: [],
        keyCount: service.ready ? 1 : 0, baseHost: 'gateway.example', proxy: null, transport: 'Node.js', models: { listed: service.ready ? 30 : 0, available: service.ready ? 30 : 0 }, resting: null,
        apiKey: process.env.EMIS_API_KEY, keys: service.ready ? [{ masked: '…' + GATEWAY_KEY.slice(-4), status: 'available', cooldownSecondsLeft: 0, requestCount: 0, key: GATEWAY_KEY }] : [] },
      { id: 'zen', name: 'Zen test', kind: 'zen', ready: service.ready, problem: null, warnings: [], keyCount: 0, free: true, note: 'Free models only.',
        models: { listed: 1, available: 1 }, catalog: { source: 'bundled', updatedAt: SERVICE_STARTED, models: 1 }, resting: null, keys: [] }
    ]
  };
}
const send = (res, status, body, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(JSON.stringify(body)); };
const sse = (res, text) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(text); };

test.before(async () => {
  // A stand-in for MetaCode's AI service. It answers like the service where a test needs it (its
  // token, /v1/status, /v1/reload, its own error types) and otherwise like a provider would (plain
  // model ids, errors judged by their HTTP status, other reply shapes): MetaCode reads both.
  aiService = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/v1/')) { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><body>Some website</body></html>'); }
      if (req.headers.authorization !== 'Bearer ' + SERVICE_TOKEN) {
        service.wrongToken++;
        return send(res, 401, { error: { type: 'authentication_error', message: 'MetaCode\'s OpenCode service needs its access token.' } });
      }
      if (req.url === '/v1/status') return send(res, 200, serviceStatus());
      // (the service reads the same .env as MetaCode: a provider is set up once its key is there)
      if (req.url === '/v1/reload' && req.method === 'POST') { service.reloads++; service.ready = !!process.env.EMIS_API_KEY; return send(res, 200, serviceStatus()); }
      if (req.url === '/v1/models') return send(res, 200, modelList());
      if (req.url !== '/v1/chat/completions') return send(res, 404, { error: { type: 'not_found', message: 'Not found.' } });
      const j = JSON.parse(body || '{}');
      service.timeoutHeader = req.headers['x-request-timeout-ms'];
      if (!service.ready) return send(res, 503, { error: { type: 'not_configured', provider: 'gw', message: 'Test gateway isn\'t set up.' } });
      const answer = (content, extra) => send(res, 200, Object.assign({ id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }, extra || {}));
      // Some gateways answer as a stream unless told not to (MetaCode says stream: false)
      if (j.model === 'streams-unless-told' && j.stream !== false) return sse(res, 'data: {"choices":[{"delta":{"content":"streamed by default"}}]}\n\ndata: [DONE]\n\n');
      if (j.model === 'responses-sse-model') return sse(res, 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok from "}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"responses sse"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"output_text":"ok from responses sse"}}\n\n');
      if (j.model === 'unicode-model') return answer('ok → café … 你好 — ' + j.messages.map(m => m.content).join('|'));
      if (j.model === 'forbidden-model') return send(res, 403, { error: { message: 'this key may not use forbidden-model' } });
      if (/^flop-/.test(j.model) || (j.model === 'wobbly-coder' && wobble.left > 0)) {
        if (j.model === 'wobbly-coder') wobble.left--;
        return send(res, 502, { error: { message: 'bad gateway' } });
      }
      if (j.model === 'wobbly-coder') {
        const user = String((j.messages.find(m => m.role === 'user') || {}).content || '');
        return answer('{"codings":{"d1":{"code":"' + (/happy/.test(user) ? 'pos' : 'neg') + '","confidence":0.9,"reasoning":"ok"}}}');
      }
      hits[j.model] = (hits[j.model] || 0) + 1;
      // Throttled models (a 429 without the service's error type: the model only)
      if (j.model === 'strm-pro-1-9') return sse(res, 'data: {"model":"strm-pro-1-9","choices":[{"delta":{"content":"streamed by 1-9"}}]}\n\ndata: [DONE]\n\n');
      if (j.model === 'acme-opus-4-8' || j.model === 'acme-opus-4-9' || j.model === 'strm-pro-2-0') return send(res, 429, { error: { message: 'model busy' } });
      // The service's own 429s: a provider's usage quota used up (scope provider), one model throttled (scope model)
      if (j.model === 'zen/pickle-pro-1' || j.model === 'gw/quota-all') {
        const provider = j.model.split('/')[0];
        const seconds = provider === 'zen' ? 3600 : 8;
        return send(res, 429, { error: { type: 'quota_exceeded', scope: 'provider', provider, window: 'day', retry_after_seconds: seconds, reset_at: new Date(Date.now() + seconds * 1000).toISOString(),
          message: PROVIDERS.find(p => p.id === provider).name + '\'s usage quota for this day is used up. It resets in ' + seconds + ' seconds.' } }, { 'Retry-After': String(seconds) });
      }
      if (j.model === 'gw/pickle-mini') {
        return send(res, 429, { error: { type: 'rate_limited', scope: 'model', provider: 'gw', model: j.model, retry_after_seconds: 30, message: 'Test gateway is rate-limiting "Pickle Mini". Try again in 30 seconds.' } }, { 'Retry-After': '30' });
      }
      if (j.stream && /^gw\//.test(j.model)) return sse(res, 'data: ' + JSON.stringify({ model: j.model, choices: [{ index: 0, delta: { content: 'ok from ' + j.model } }] }) + '\n\ndata: ' + JSON.stringify({ model: j.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      // Takes a while, like a real model; answers AI Coding prompts with codings JSON
      if (j.model === 'slow-model' || j.model === 'coder-model') {
        load.now++; load.total++; load.max = Math.max(load.max, load.now);
        const user = String((j.messages.find(m => m.role === 'user') || {}).content || '');
        setTimeout(() => {
          load.now--;
          let content = 'ok from ' + j.model + ': ' + user;
          if (j.model === 'coder-model') {
            // a post marked GARBLE gets an unreadable answer the first time
            if (/GARBLE/.test(user) && !load.garbled.has(user)) { load.garbled.add(user); content = 'Sorry, I cannot do JSON today.'; }
            else content = 'Here you go: {"codings":{"d1":{"code":"' + (/happy/.test(user) ? 'pos' : 'neg') + '","confidence":0.8,"reasoning":"Because."}}}';
          }
          if (!res.writableEnded && !res.destroyed) answer(content);
        }, 250);
        return;
      }
      seenModels.push(j.model);
      if (faults.flaky > 0) { faults.flaky--; return send(res, 503, { error: { message: 'busy' } }); }
      if (faults.broken.has(j.model)) return send(res, 500, { error: { message: 'model crashed' } });
      // Other reply shapes some gateways use
      if (j.model === 'sse-model') return sse(res, 'data: {"id":"s1","model":"sse-model","choices":[{"delta":{"content":"ok "}}]}\n\ndata: {"choices":[{"delta":{"content":"from sse"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      if (j.model === 'responses-model') return send(res, 200, { id: 'r1', model: j.model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok from responses' }] }] });
      if (j.model === 'wrapped-model') return send(res, 200, { data: { choices: [{ message: { role: 'assistant', content: 'ok from wrapped' } }] } });
      if (j.model === 'picture-model') return answer([{ type: 'text', text: 'Here is your cat: ' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
      if (j.model === 'error200-model') return send(res, 200, { error: { message: 'quota for this model is disabled' } });
      if (j.model === 'think-model' && !(j.max_tokens >= 1024)) return send(res, 200, { model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: 'thinking…' }, finish_reason: 'length' }] });
      return answer('ok from ' + j.model);
    });
  });
  await new Promise(r => aiService.listen(0, '127.0.0.1', r));
  serviceBase = 'http://127.0.0.1:' + aiService.address().port + '/v1';
  fs.writeFileSync(envFile, serviceEnv());                // the AI service has no provider set up yet
  Object.assign(process.env, testEnv({
    METACODE_ENV_FILE: envFile, SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects')
  }));
  delete process.env.EMIS_API_KEY;
  const { start } = require('../server');
  server = await start(0);
  base = 'http://localhost:' + server.address().port;
  if (chromiumPath) browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (aiService) { aiService.closeAllConnections(); await new Promise(r => aiService.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = async (method, url, body, headers) => {
  const res = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const hi = { messages: [{ role: 'user', content: 'hi' }] };
const aiComponent = async () => (await json('GET', '/api/status')).json.components.find(c => c.id === 'ai');
// The status page checks again at most every 5 s: its AI part once it is `status` (and its note matches `note`)
async function aiStatusBecomes(status, note) {
  let ai;
  for (let end = Date.now() + 8000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) {
    ai = await aiComponent();
    if (ai.status === status && (!note || note.test(ai.note))) break;
  }
  return ai;
}

test('settings status shows what .env set (names only) and the AI service\'s providers; Reload .env reaches the service, which picks up a new key without a restart', async () => {
  let st = (await json('GET', '/api/settings/status')).json;
  assert.equal(st.env.found, true);
  assert.deepEqual(st.env.keys, ['OPENCODE_SERVICE_URL', 'OPENCODE_SERVICE_TOKEN']);
  assert.equal(st.ai.provider, 'opencode');
  assert.equal(st.ai.ready, false);
  assert.match(st.ai.problem, /no AI provider is set up yet/);
  assert.deepEqual(st.ai.service, { host: '127.0.0.1:' + aiService.address().port, mode: 'off', managed: false, running: true, version: 'test', opencode: '2.1.4', startedAt: SERVICE_STARTED, problem: null });
  assert.deepEqual(st.ai.providers.map(p => [p.id, p.name, p.ready, p.problem, p.keyCount]), [['gw', 'Test gateway', false, 'Add the gateway key in .env, then Reload .env.', 0], ['zen', 'Zen test', false, null, 0]]);
  const ai = await json('POST', '/api/ai', hi);
  assert.equal(ai.status, 503);
  assert.equal(ai.json.error.type, 'not_configured');
  assert.match(ai.json.error.message, /Settings → AI providers/);
  const status = await aiComponent();
  assert.deepEqual([status.status, status.note], ['off', 'AI isn\'t set up on this server.']);

  // The key goes into the same .env; Reload .env has the service read it again
  fs.writeFileSync(envFile, serviceEnv() + keyLine);
  const reloaded = await json('POST', '/api/settings/reload', {});
  assert.equal(reloaded.status, 200);
  assert.equal(service.reloads, 1, 'POST /v1/reload');
  assert.equal(reloaded.json.ai.ready, true);
  assert.equal(reloaded.json.ai.problem, null);
  assert.deepEqual(reloaded.json.ai.providers.map(p => [p.id, p.ready, p.keyCount, p.free, p.note]), [['gw', true, 1, null, null], ['zen', true, 0, true, 'Free models only.']]);
  const keys = (await json('GET', '/api/keys/status')).json;
  assert.equal(keys.provider, 'opencode');
  assert.deepEqual(keys.providers.map(p => [p.id, p.name, p.kind, p.ready, p.keyCount, p.baseHost, p.transport]),
    [['gw', 'Test gateway', 'openai-compatible', true, 1, 'gateway.example', 'Node.js'], ['zen', 'Zen test', 'zen', true, 0, null, null]]);
  assert.deepEqual(keys.providers[1].catalog, { source: 'bundled', updatedAt: SERVICE_STARTED, models: 1 });
  assert.deepEqual(keys.keys, [{ provider: 'gw', source: 'env', masked: '…3456', status: 'available', cooldownSecondsLeft: 0, requestCount: 0 }], 'the keys, flattened for older pages');
  const settings = (await json('GET', '/api/settings/status')).json;
  for (const text of [JSON.stringify(reloaded.json), JSON.stringify(keys), JSON.stringify(settings)]) {
    assert.ok(!text.includes(GATEWAY_KEY) && !text.includes(SERVICE_TOKEN) && !/apiKey/.test(text), 'neither the key nor the service\'s token is ever sent');
  }
  const answered = await json('POST', '/api/ai', Object.assign({ model: 'model-b' }, hi));
  assert.equal(answered.status, 200);
  assert.equal(service.timeoutHeader, '120000', 'MetaCode tells the service how long it waits');
  assert.equal(service.wrongToken, 0, 'every request carried the service\'s token');
  assert.deepEqual((await json('GET', '/api/health')).json, { status: 'ok', provider: 'opencode', aiConfigured: true, aiReady: true, node: process.version });
  // Reload is refused from other sites
  assert.equal((await json('POST', '/api/settings/reload', {}, { Origin: 'https://evil.example' })).status, 403);
});

test('the AI service not answering, or refusing MetaCode\'s token: AI isn\'t ready, says what to do, and requests fail at once', async () => {
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const deadPort = closed.address().port;
  await new Promise(r => closed.close(r));
  try {
    fs.writeFileSync(envFile, serviceEnv('http://127.0.0.1:' + deadPort + '/v1') + keyLine);
    let st = (await json('POST', '/api/settings/reload', {})).json.ai;
    assert.equal(st.ready, false);
    assert.match(st.problem, new RegExp('isn\'t running at 127\\.0\\.0\\.1:' + deadPort + '\\..*pm2'));
    assert.equal(st.service.running, false);
    const t0 = Date.now();
    let r = await json('POST', '/api/ai', Object.assign({ model: 'model-b' }, hi));
    assert.deepEqual([r.status, r.json.error.type], [502, 'network']);
    assert.match(r.json.error.message, /AI service \(OpenCode\) isn't running/);
    assert.ok(Date.now() - t0 < 1500, 'not retried: nothing is listening');
    const keys = (await json('GET', '/api/keys/status')).json;
    assert.deepEqual([keys.providers, keys.keys], [[], []]);
    assert.match(keys.problem, /isn't running/);
    const health = (await json('GET', '/api/health')).json;
    assert.deepEqual([health.aiConfigured, health.aiReady], [true, false]);
    const status = await aiStatusBecomes('outage');
    assert.deepEqual([status.status, status.note], ['outage', 'The AI service isn\'t answering.']);

    // Another token than the service's
    fs.writeFileSync(envFile, serviceEnv(serviceBase, 'another-service-token-000000') + keyLine);
    st = (await json('POST', '/api/settings/reload', {})).json.ai;
    assert.equal(st.ready, false);
    assert.match(st.problem, /didn't accept MetaCode's access token.*OPENCODE_SERVICE_TOKEN/);
    r = await json('POST', '/api/ai', Object.assign({ model: 'model-b' }, hi));
    assert.deepEqual([r.status, r.json.error.type], [401, 'authentication_error']);
    assert.match(r.json.error.message, /access token/);
    assert.ok(service.wrongToken > 0);
  } finally {
    fs.writeFileSync(envFile, serviceEnv() + keyLine);
    assert.equal((await json('POST', '/api/settings/reload', {})).json.ai.ready, true);
  }
});

test('each request uses the model it asks for', async () => {
  seenModels.length = 0;
  for (const model of ['model-b', 'model-c', undefined]) {
    const r = await json('POST', '/api/ai', Object.assign({ messages: [{ role: 'user', content: 'hi' }] }, model ? { model } : {}), { 'x-provider': 'openai' });
    assert.equal(r.status, 200);
  }
  assert.deepEqual(seenModels.slice(0, 2), ['model-b', 'model-c']);
  assert.ok(seenModels[2], 'without a model the server picks its default');
  const models = (await json('GET', '/api/models')).json.models.map(m => m.id);
  assert.ok(['model-a', 'model-b', 'model-c'].every(m => models.includes(m)));
});

test('a temporary failure at the AI service is retried; a failing model falls back (a picked one too, unless switching is off)', async () => {
  const ask = model => json('POST', '/api/ai', Object.assign({ messages: [{ role: 'user', content: 'hi' }] }, model ? { model } : {}), { 'x-provider': 'openai' });
  faults.flaky = 1;
  let r = await ask('model-b');
  assert.equal(r.status, 200, 'a 503 is retried');
  assert.equal(r.json.choices[0].message.content, 'ok from model-b');

  const def = (await json('GET', '/api/models')).json.models[0].id;     // the server default
  faults.broken = new Set([def]);
  seenModels.length = 0;
  const res = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  const body = await res.json();
  assert.equal(res.status, 200, 'answered by another model');
  assert.notEqual(body.model, def);
  assert.equal(res.headers.get('x-metacode-model-fallback'), body.model);
  // While it rests, the next request goes straight to the similar model
  seenModels.length = 0;
  const next = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(next.status, 200);
  assert.equal(next.headers.get('x-metacode-model-fallback'), body.model);
  assert.ok(!seenModels.includes(def), 'the failing model wasn\'t asked again');

  // A model the user picked that the AI service can't run right now is answered by the closest model too, and says so
  const picked = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-provider': 'openai' }, body: JSON.stringify({ model: def, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(picked.status, 200, 'a picked model that fails is swapped');
  assert.equal(picked.headers.get('x-metacode-model-fallback'), body.model);
  assert.equal(picked.headers.get('x-metacode-model-fallback-reason'), 'failed');
  assert.equal(picked.headers.get('x-metacode-model-requested'), def);
  // …unless switching is turned off (Settings → AI models): then it says what failed
  const off = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-provider': 'openai', 'X-MetaCode-Model-Switch': 'off' }, body: JSON.stringify({ model: def, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(off.status, 502, 'switching off: not swapped');
  assert.match((await off.json()).error.message, /Settings → AI models/);
  // A picked model the key may not use isn't swapped (another model would hide that); the reason is shown
  r = await ask('forbidden-model');
  assert.equal(r.status, 403);
  assert.equal(r.json.error.type, 'permission_error');
  assert.match(r.json.error.message, /this key may not use forbidden-model/);
  faults.broken = new Set();
});

test('replies in other shapes are read; an unreadable one says what the AI service sent', async () => {
  const ask = model => json('POST', '/api/ai', { model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
  for (const [model, text] of [['sse-model', 'ok from sse'], ['responses-model', 'ok from responses'], ['responses-sse-model', 'ok from responses sse'], ['wrapped-model', 'ok from wrapped'],
    ['think-model', 'ok from think-model'], ['streams-unless-told', 'ok from streams-unless-told'], ['picture-model', 'Here is your cat: [image omitted]']]) {
    const r = await ask(model);
    assert.equal(r.status, 200, model);
    assert.equal(r.json.choices[0].message.content, text, model);
  }
  const bad = await ask('error200-model');
  assert.equal(bad.status, 502);
  assert.match(bad.json.error.message, /quota for this model is disabled/);
});

test('an OPENCODE_SERVICE_URL that isn\'t the service\'s API address (a website answers there) is named in the warning and in the errors', async () => {
  fs.writeFileSync(envFile, serviceEnv(serviceBase.replace(/\/v1$/, '')) + keyLine);
  try {
    const st = (await json('POST', '/api/settings/reload', {})).json.ai;
    assert.ok(st.warnings.some(w => /OPENCODE_SERVICE_URL normally ends in \/v1/.test(w)), JSON.stringify(st.warnings));
    assert.equal(st.ready, false);
    const r = await json('POST', '/api/ai', Object.assign({ model: 'model-b' }, hi), { 'x-provider': 'openai' });
    assert.deepEqual([r.status, r.json.error.type], [502, 'malformed_response']);
    assert.match(r.json.error.message, /web page.*OPENCODE_SERVICE_URL.*\/v1/);
    const models = (await json('GET', '/api/models')).json;
    assert.deepEqual(models.models, []);
    assert.match(models.note, /web page.*OPENCODE_SERVICE_URL/);
  } finally {
    fs.writeFileSync(envFile, serviceEnv() + keyLine);
    await json('POST', '/api/settings/reload', {});
  }
});

test('non-ASCII text in prompts and answers survives the trip (Windows console encodings)', async () => {
  const r = await json('POST', '/api/ai', { model: 'unicode-model', messages: [{ role: 'user', content: 'Grüße → “quotes” …' }] }, { 'x-provider': 'openai' });
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, 'ok → café … 你好 — Grüße → “quotes” …');
});

test('MetaCode reaches its AI service directly, never through HTTP(S)_PROXY (a proxy would see the service\'s token)', async () => {
  let proxied = 0;
  const proxy = http.createServer((req, res) => { proxied++; res.statusCode = 502; res.end(); });
  proxy.on('connect', (req, socket) => { proxied++; socket.destroy(); });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const url = 'http://127.0.0.1:' + proxy.address().port;
  Object.assign(process.env, { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url });
  delete process.env.NO_PROXY; delete process.env.no_proxy;
  try {
    const r = await json('POST', '/api/ai', Object.assign({ model: 'model-b' }, hi), { 'x-provider': 'openai' });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'ok from model-b');
    assert.equal(proxied, 0, 'nothing went through the proxy');
  } finally {
    names.forEach(n => { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; });
    proxy.closeAllConnections(); await new Promise(r => proxy.close(r));
  }
});

/* ── Parallel AI Coding (POST /api/ai/batch) ─── */
async function batch(body, signal) {
  const res = await fetch(base + '/api/ai/batch', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, lines: text.split('\n').filter(Boolean).map(l => JSON.parse(l)), headers: res.headers };
}
const chatBody = (model, content) => ({ model, max_tokens: 50, messages: [{ role: 'user', content }] });

test('AI batch: several copies of the same model answer at once, each answer streamed back with its id', async () => {
  Object.assign(load, { now: 0, max: 0, total: 0 });
  const t0 = Date.now();
  const r = await batch({ parallel: 4, requests: Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, body: chatBody('slow-model', 'post ' + i) })) });
  const took = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /ndjson/);
  const answers = r.lines.filter(l => !l.done);
  assert.equal(answers.length, 12);
  assert.deepEqual(answers.map(a => a.id).sort(), Array.from({ length: 12 }, (_, i) => 'p' + i).sort());
  answers.forEach(a => { assert.equal(a.ok, true); assert.equal(a.data.choices[0].message.content, 'ok from slow-model: post ' + a.id.slice(1)); });
  assert.deepEqual(r.lines[r.lines.length - 1], { done: true, parallel: 4 });
  assert.equal(load.max, 4, 'four requests ran side by side');
  assert.ok(took < 12 * 250 * 0.6, 'faster than one at a time (' + took + ' ms)');

  // One at a time when parallel is 1
  Object.assign(load, { now: 0, max: 0 });
  await batch({ parallel: 1, requests: [1, 2, 3].map(i => ({ id: i, body: chatBody('slow-model', 'x') })) });
  assert.equal(load.max, 1);

  // A failing request doesn't stop the others
  const mixed = await batch({ parallel: 3, requests: [{ id: 'a', body: chatBody('slow-model', 'a') }, { id: 'b', body: chatBody('forbidden-model', 'b') }, { id: 'c', body: chatBody('slow-model', 'c') }] });
  const byId = Object.fromEntries(mixed.lines.filter(l => !l.done).map(l => [l.id, l]));
  assert.equal(byId.a.ok, true);
  assert.equal(byId.c.ok, true);
  assert.equal(byId.b.ok, false);
  assert.equal(byId.b.status, 403);
  assert.match(byId.b.error.message, /forbidden-model/);
});

test('AI batch: capped by AI_MAX_PARALLEL, validated, same-origin only, and stops when the browser leaves', async () => {
  process.env.AI_MAX_PARALLEL = '3';
  try {
    assert.equal((await json('GET', '/api/settings/status')).json.ai.maxParallel, 3);
    Object.assign(load, { now: 0, max: 0 });
    const r = await batch({ parallel: 50, requests: Array.from({ length: 7 }, (_, i) => ({ id: i, body: chatBody('slow-model', 'x') })) });
    assert.equal(load.max, 3);
    assert.equal(r.lines[r.lines.length - 1].parallel, 3);
  } finally { delete process.env.AI_MAX_PARALLEL; }
  assert.equal((await json('GET', '/api/settings/status')).json.ai.maxParallel, 16, 'default cap');

  assert.equal((await json('POST', '/api/ai/batch', { requests: [] })).status, 400);
  assert.equal((await json('POST', '/api/ai/batch', { requests: [{ id: 1, body: Object.assign(chatBody('slow-model', 'x'), { stream: true }) }] })).status, 400);
  assert.equal((await json('POST', '/api/ai/batch', { requests: [{ id: 1 }] })).status, 400);
  assert.equal((await json('POST', '/api/ai/batch', { requests: [{ id: 1, body: chatBody('slow-model', 'x') }] }, { Origin: 'https://evil.example' })).status, 403);

  // Stop: closing the connection stops the batch
  Object.assign(load, { now: 0, max: 0, total: 0 });
  const ctl = new AbortController();
  const pending = batch({ parallel: 2, requests: Array.from({ length: 20 }, (_, i) => ({ id: i, body: chatBody('slow-model', 'x') })) }, ctl.signal).catch(e => e);
  await new Promise(r => setTimeout(r, 400));
  ctl.abort();
  assert.equal((await pending).name, 'AbortError');
  await new Promise(r => setTimeout(r, 700));
  assert.ok(load.total <= 6, 'no new requests after Stop (sent ' + load.total + ')');
});

// Saved projects live in each browser now; projects an older version saved on
// the server are only offered for import to the person on this computer.
const legacyProject = { id: 'pr_legacyOne123', name: 'Old shared study', description: '', createdAt: '2025-01-01T00:00:00.000Z', savedAt: '2025-01-02T00:00:00.000Z', revision: 4,
  data: { project: { name: 'Old shared study', description: '' }, posts: [{ id: 'o1', text: 'old post', aiCodes: {}, humanCodes: {} }], codebook: [], network: { nodes: [], edges: [] }, networkAnalysis: null } };
/* ── Rate-limited models switch to the closest one ─── */
const ask = (model, headers) => fetch(base + '/api/ai', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'x-provider': 'openai' }, headers || {}), body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }) });

test('a rate-limited model is answered by the closest similar model, and isn\'t called again while it rests', async () => {
  let res = await ask('acme-opus-4-8');
  let body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.model, 'acme-opus-4-7', 'same family and line, nearest version — not acme-opus-3-0 or acme-mini-2');
  // The nearest version (4-9) was tried first, but it is rate-limited too
  assert.deepEqual([hits['acme-opus-4-9'], hits['acme-opus-3-0'], hits['acme-mini-2']], [1, undefined, undefined]);
  assert.equal(res.headers.get('x-metacode-model-fallback'), 'acme-opus-4-7');
  assert.equal(res.headers.get('x-metacode-model-fallback-reason'), 'rate_limited');
  assert.equal(res.headers.get('x-metacode-model-requested'), 'acme-opus-4-8');
  assert.equal(hits['acme-opus-4-8'], 1);
  // A 429 that doesn't say its scope is about the model: its provider isn't resting
  assert.deepEqual((await json('GET', '/api/settings/status')).json.ai.restingProviders, []);
  // While it rests, requests go straight to the substitute
  res = await ask('acme-opus-4-8');
  assert.equal((await res.json()).model, 'acme-opus-4-7');
  assert.equal(hits['acme-opus-4-8'], 1, 'not called again');
  const st = (await json('GET', '/api/settings/status')).json;
  assert.deepEqual(st.ai.rateLimitedModels.map(x => x.model).sort(), ['acme-opus-4-8', 'acme-opus-4-9']);
  assert.equal(st.ai.modelSwitch, true);
  // A resting model whose closest match is resting too: the next closest answers, nothing rate-limited is called
  res = await ask('acme-opus-4-9');
  body = await res.json();
  assert.equal(body.model, 'acme-opus-4-7');
  assert.deepEqual([hits['acme-opus-4-8'], hits['acme-opus-4-9']], [1, 1]);
  // Switching turned off (Settings → AI models): a clear 429 instead
  res = await ask('acme-opus-4-8', { 'X-MetaCode-Model-Switch': 'off' });
  body = await res.json();
  assert.equal(res.status, 429);
  assert.equal(body.error.type, 'model_rate_limited');
  assert.match(body.error.message, /acme-opus-4-8.*turned off in Settings/);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  // AI Coding's batch: each answer says which model answered
  const r = await fetch(base + '/api/ai/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parallel: 2, requests: [1, 2].map(id => ({ id, body: { model: 'acme-opus-4-8', max_tokens: 20, messages: [{ role: 'user', content: 'x' }] } })) }) });
  const lines = (await r.text()).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => !l.done);
  assert.deepEqual(lines.map(l => [l.ok, l.fallback, l.fallbackReason, l.requested]), [[true, 'acme-opus-4-7', 'rate_limited', 'acme-opus-4-8'], [true, 'acme-opus-4-7', 'rate_limited', 'acme-opus-4-8']]);
});

test('the status page shows the AI service as degraded while models are rate-limited (without spending prompts)', async () => {
  const before = Object.assign({}, hits);
  const ai = await aiStatusBecomes('degraded', /rate-limited/);
  assert.equal(ai.status, 'degraded');
  assert.match(ai.note, /rate-limited; requests for (it|them) use the closest similar model\./);
  assert.deepEqual(hits, before, 'no chat requests were made');
  assert.ok(!/emis|Test gateway|Zen test|\.env/i.test(JSON.stringify((await json('GET', '/api/status')).json)), 'no provider names or settings');
});

test('streamed requests switch to the closest model too, before anything is sent', async () => {
  const res = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-provider': 'openai' }, body: JSON.stringify({ model: 'strm-pro-2-0', stream: true, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  assert.equal(res.headers.get('x-metacode-model-fallback'), 'strm-pro-1-9');
  assert.match(await res.text(), /streamed by 1-9/);
});

test('a provider whose usage quota is used up rests: its models are answered by the same model from another provider, without asking it again', async () => {
  let res = await ask('zen/pickle-pro-1');
  let body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.model, 'gw/pickle-pro-1', 'the same model, from the provider that can answer');
  assert.deepEqual([res.headers.get('x-metacode-model-fallback'), res.headers.get('x-metacode-model-fallback-reason'), res.headers.get('x-metacode-model-requested')],
    ['gw/pickle-pro-1', 'rate_limited', 'zen/pickle-pro-1']);
  let st = (await json('GET', '/api/settings/status')).json.ai;
  assert.deepEqual(st.restingProviders.map(p => [p.provider, p.reason]), [['zen', 'quota']]);
  assert.ok(Date.parse(st.restingProviders[0].until) > Date.now() + 3500 * 1000, 'until the reset time the service gave');
  assert.ok(!st.rateLimitedModels.some(x => x.model === 'zen/pickle-pro-1'), 'the provider rests, not the model');
  // While it rests, its models aren't sent to it: the other provider answers at once, streamed too
  res = await ask('zen/pickle-pro-1');
  assert.equal((await res.json()).model, 'gw/pickle-pro-1');
  const streamed = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-provider': 'openai' }, body: JSON.stringify({ model: 'zen/pickle-pro-1', stream: true, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('x-metacode-model-fallback'), 'gw/pickle-pro-1');
  assert.match(await streamed.text(), /ok from gw\/pickle-pro-1[\s\S]*data: \[DONE\]/);
  assert.equal(hits['zen/pickle-pro-1'], 1, 'asked once');
  // Switching turned off: the service's message, when it resets, and nothing is sent
  res = await ask('zen/pickle-pro-1', { 'X-MetaCode-Model-Switch': 'off' });
  body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual([body.error.type, body.error.scope, body.error.window], ['quota_exceeded', 'provider', 'day']);
  assert.match(body.error.message, /Zen test's usage quota for this day is used up/);
  assert.ok(Number(res.headers.get('retry-after')) > 3500 && body.error.retryAfterSeconds > 3500);
  assert.equal(hits['zen/pickle-pro-1'], 1);
  // A 429 for one model of the other provider (scope model): that model rests and a similar one answers — not
  // one of the resting provider's
  res = await ask('gw/pickle-mini');
  body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(res.headers.get('x-metacode-model-fallback-reason'), 'rate_limited');
  assert.ok(!/^zen\//.test(body.model), body.model);
  st = (await json('GET', '/api/settings/status')).json.ai;
  assert.ok(st.rateLimitedModels.some(x => x.model === 'gw/pickle-mini'));
  assert.deepEqual(st.restingProviders.map(p => p.provider), ['zen']);
});

test('the status page says when every provider is resting (usage quota used up), and is back to normal after', { timeout: 30000 }, async () => {
  const res = await ask('gw/quota-all', { 'X-MetaCode-Model-Switch': 'off' });      // the gateway's quota too, for 8 seconds
  assert.equal(res.status, 429);
  const ai = await aiStatusBecomes('degraded', /quota/);
  assert.equal(ai.status, 'degraded');
  assert.match(ai.note, /^The usage quota is used up; AI features resume in \d+ seconds?\.$/);
  for (let end = Date.now() + 10000; Date.now() < end; await new Promise(r => setTimeout(r, 300))) {
    if (!(await json('GET', '/api/settings/status')).json.ai.restingProviders.some(p => p.provider === 'gw')) break;
  }
  assert.deepEqual((await json('GET', '/api/settings/status')).json.ai.restingProviders.map(p => p.provider), ['zen']);
});

test('projects saved on the server by older versions: listed and readable from this computer only; nothing new is stored there', async () => {
  fs.mkdirSync(path.join(tmp, 'projects', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'projects', 'projects', legacyProject.id + '.json'), JSON.stringify(legacyProject));
  const list = await json('GET', '/api/projects/legacy');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.projects.map(p => [p.id, p.name, p.counts.posts]), [[legacyProject.id, 'Old shared study', 1]]);
  const one = await json('GET', '/api/projects/legacy/' + legacyProject.id);
  assert.equal(one.json.project.data.posts[0].text, 'old post');
  assert.equal((await json('GET', '/api/projects/legacy', undefined, { 'X-Forwarded-For': '203.0.113.7' })).status, 404, 'not through a proxy / from elsewhere');
  assert.equal((await json('GET', '/api/projects/legacy/../../etc')).status, 404);
  // The old shared routes are gone
  assert.equal((await json('POST', '/api/projects', { name: 'x', data: legacyProject.data })).status, 404);
  assert.equal((await json('GET', '/api/projects')).status, 404);
});

async function openApp(hash) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto(base + '/app.html' + hash);
  return { page, context, errors };
}

test('Settings page: .env status, AI ready in the top bar, a model per feature used by that feature', { skip: noBrowser, timeout: 90000 }, async () => {
  const { page, context, errors } = await openApp('#settings');
  await page.waitForFunction(() => /AI is ready/.test((document.getElementById('s-env-status') || {}).textContent || ''));
  assert.match(await page.textContent('#s-env-status'), /settings\.env.*OPENCODE_SERVICE_URL/s);
  assert.equal(await page.textContent('#status-label'), 'AI ready');
  await page.waitForSelector('#s-feature-models select[data-feature="assistant"] option[value="model-c"]', { state: 'attached' });
  await page.selectOption('#s-model', 'model-b');
  await page.selectOption('#s-feature-models select[data-feature="assistant"]', 'model-c');
  await page.click('text=Save model settings');
  const settings = await page.evaluate(() => App.getState().settings);
  assert.equal(settings.model, 'model-b');
  assert.deepEqual(settings.models, { assistant: 'model-c' });
  seenModels.length = 0;
  await page.evaluate(() => App.callClaude([{ role: 'user', content: 'hi' }], '', 10, { feature: 'assistant' }));
  await page.evaluate(() => App.callClaude([{ role: 'user', content: 'hi' }], '', 10, { feature: 'coding' }));
  assert.deepEqual(seenModels, ['model-c', 'model-b'], 'the assistant uses its own model; AI Coding uses the default');
  await page.click('text=Test connection');
  await page.waitForFunction(() => /Connected/.test(document.getElementById('api-test-result').textContent));
  assert.deepEqual(errors, []);
  await context.close();
});

test('Settings: switching to a similar model is on by default, says which model answered, and can be turned off', { skip: noBrowser, timeout: 60000 }, async () => {
  const { page, context, errors } = await openApp('#settings');
  await page.waitForSelector('#s-switch');
  assert.equal(await page.isChecked('#s-switch'), true);
  // acme-opus-4-8 is still resting from the test above
  await page.waitForFunction(() => /acme-opus-4-8/.test(document.getElementById('s-limited').textContent));
  await page.evaluate(() => App.setState({ settings: Object.assign({}, App.getState().settings, { model: 'acme-opus-4-8', models: {} }) }));
  const text = await page.evaluate(() => App.callClaude([{ role: 'user', content: 'hi' }], '', 20, { feature: 'assistant' }));
  assert.match(text, /ok from acme-opus-4-7/);
  await page.waitForSelector('.notif', { state: 'attached' });
  assert.match(await page.textContent('#notif-stack'), /rate-limiting “acme-opus-4-8”.*“acme-opus-4-7”/);
  // Off: the request waits for the chosen model instead
  await page.uncheck('#s-switch');
  await page.click('text=Save model settings');
  assert.equal(await page.evaluate(() => App.getState().settings.switchModels), false);
  await page.evaluate(() => App.setState({ settings: Object.assign({}, App.getState().settings, { model: 'acme-opus-4-8' }) }));   // (saving also saved the dropdown's model)
  const err = await page.evaluate(() => App.callClaude([{ role: 'user', content: 'hi' }], '', 20, { feature: 'assistant' }).then(() => null, e => e.message));
  assert.match(err, /rate-limiting the model "acme-opus-4-8"/);
  await page.evaluate(() => App.setState({ settings: Object.assign({}, App.getState().settings, { model: '', switchModels: true }) }));
  assert.deepEqual(errors, []);
  await context.close();
});

test('Projects page: saved in this browser (not on the server), autosave, reopen; other browsers see nothing; old server projects import', { skip: noBrowser, timeout: 120000 }, async () => {
  const { page, context, errors } = await openApp('#projects');
  await page.waitForSelector('#pj-current');
  const local = () => page.evaluate(() => LocalDB.all('projects'));
  // Put some data in the open project, then save it
  await page.evaluate(() => App.setState({ project: { name: 'Climate study', description: '' }, posts: [{ id: 'a', text: 'one', aiCodes: {}, humanCodes: {} }] }));
  await page.evaluate(() => ProjectsView.render());
  await page.click('#pj-saveas');
  await page.click('#pj-ok');
  await page.waitForFunction(() => ProjectsView.link() && /Climate study/.test(document.getElementById('pj-list').textContent));
  const saved = (await local()).find(p => p.name === 'Climate study');
  assert.ok(saved, 'kept in the browser');
  assert.equal(saved.data.posts.length, 1);
  assert.ok(!fs.readdirSync(path.join(tmp, 'projects', 'projects')).some(f => f.startsWith(saved.id)), 'nothing written on the server');
  // Autosave: a change is saved a few seconds later
  await page.evaluate(() => App.setState({ posts: App.getState().posts.concat([{ id: 'b', text: 'two', aiCodes: {}, humanCodes: {} }]) }));
  let counted = 0;
  for (let i = 0; i < 40 && counted !== 2; i++) {
    await new Promise(r => setTimeout(r, 400));
    counted = (await local()).find(p => p.id === saved.id).data.posts.length;
  }
  assert.equal(counted, 2, 'autosaved');
  // Another browser (another person) sees none of it
  {
    const other = await openApp('#projects');
    await other.page.waitForFunction(() => /No saved projects yet/.test((document.getElementById('pj-list') || {}).textContent || ''));
    assert.notEqual(await other.page.evaluate(() => LocalDB.owner()), await page.evaluate(() => LocalDB.owner()), 'each browser has its own identity');
    await other.context.close();
  }
  // Projects an older version saved on the server can be imported
  await page.waitForSelector('#pj-legacy-go');
  await page.click('#pj-legacy-go');
  await page.waitForFunction(id => !!document.querySelector('#pj-list tr[data-id="' + id + '"]'), legacyProject.id);
  assert.equal(await page.locator('#pj-legacy-go').count(), 0, 'offered only until imported');
  // New empty project (the linked one is saved first, nothing is asked)
  await page.click('#pj-new');
  await page.waitForURL(/#dashboard/);
  await page.waitForFunction(() => App.getState().posts.length === 0);
  // Reopen the saved project from the list
  await page.goto(base + '/app.html#projects');
  await page.waitForSelector(`#pj-list tr[data-id="${saved.id}"] [data-act="open"]`);
  await page.click(`#pj-list tr[data-id="${saved.id}"] [data-act="open"]`);
  await page.waitForURL(/#dashboard/);
  await page.waitForFunction(() => App.getState().posts.length === 2);
  assert.equal(await page.evaluate(() => App.getState().project.name), 'Climate study');
  assert.equal(await page.evaluate(() => ProjectsView.link().id), saved.id);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Projects page: the name given when saving sticks (top bar, list, after autosave and reload); renames reach the data; a failed save changes nothing', { skip: noBrowser, timeout: 120000 }, async () => {
  const { page, context, errors } = await openApp('#projects');
  await page.waitForSelector('#pj-saveas');
  const local = () => page.evaluate(() => LocalDB.all('projects'));
  const shown = () => page.evaluate(() => ({ top: document.getElementById('topbar-project').textContent, state: App.getState().project.name,
    card: (document.querySelector('#pj-current') || {}).textContent || '', link: ProjectsView.link() }));
  assert.equal((await shown()).state, 'Untitled Project');
  // Save a new project under a new name: one step, and the name shows at once
  await page.click('#pj-saveas');
  await page.fill('#pj-name', 'Heat pump study');
  await page.click('#pj-ok');
  await page.waitForFunction(() => ProjectsView.link() && ProjectsView.link().name === 'Heat pump study');
  let s = await shown();
  assert.equal(s.top, 'Heat pump study');
  assert.equal(s.state, 'Heat pump study');
  assert.match(s.card, /Heat pump study\s+Saved/);
  assert.equal(s.link.dirty, false, 'taking the saved name isn\'t an unsaved change');
  const first = (await local()).find(p => p.name === 'Heat pump study');
  assert.equal(first.data.project.name, 'Heat pump study', 'the saved data opens with that name');
  // A later change is autosaved under the same name (it used to become "Untitled Project" here)
  await page.evaluate(() => App.setState({ posts: [{ id: 'a', text: 'one', aiCodes: {}, humanCodes: {} }] }));
  await page.waitForFunction(id => LocalDB.get('projects', id).then(p => p.data.posts.length === 1), first.id, { timeout: 15000 });
  let rec = (await local()).find(p => p.id === first.id);
  assert.deepEqual([rec.name, rec.data.project.name], ['Heat pump study', 'Heat pump study']);
  assert.equal((await local()).length, 1, 'no duplicate record');
  await page.reload();
  await page.waitForSelector('#pj-current');
  assert.equal((await shown()).top, 'Heat pump study', 'after a reload');
  // Save as a new copy: the copy is opened under its name, the original keeps its own
  await page.click('#pj-saveas');
  await page.fill('#pj-name', 'Heat pump study v2');
  await page.click('#pj-ok');
  await page.waitForFunction(() => ProjectsView.link().name === 'Heat pump study v2');
  s = await shown();
  assert.equal(s.top, 'Heat pump study v2');
  assert.notEqual(s.link.id, first.id);
  rec = (await local()).find(p => p.id === first.id);
  assert.equal(rec.name, 'Heat pump study', 'the original isn\'t renamed');
  // Renaming the project that isn't open renames its data too, so it opens under the new name
  await page.click(`#pj-list tr[data-id="${first.id}"] [data-act="rename"]`);
  await page.fill('#pj-name', 'Heat pumps 2025');
  await page.click('#pj-ok');
  await page.waitForFunction(id => LocalDB.get('projects', id).then(p => p.name === 'Heat pumps 2025'), first.id);
  assert.equal((await local()).find(p => p.id === first.id).data.project.name, 'Heat pumps 2025');
  assert.equal((await shown()).top, 'Heat pump study v2', 'the open project isn\'t affected');
  // Renaming the open project shows at once and keeps the same saved project
  const v2 = (await shown()).link.id;
  await page.click(`#pj-list tr[data-id="${v2}"] [data-act="rename"]`);
  await page.fill('#pj-name', 'Final study');
  await page.click('#pj-ok');
  await page.waitForFunction(() => document.getElementById('topbar-project').textContent === 'Final study');
  assert.equal((await shown()).link.id, v2);
  // A failed save: an error in the dialog, no success message, the name and link stay as they were
  await page.evaluate(() => { window.__put = LocalDB.put; LocalDB.put = () => Promise.reject(new Error('Storage is full')); });
  await page.click('#pj-saveas');
  await page.fill('#pj-name', 'Never saved');
  await page.click('#pj-ok');
  await page.waitForFunction(() => /Storage is full/.test(document.getElementById('pj-err').textContent));
  s = await shown();
  assert.deepEqual([s.top, s.state, s.link.id], ['Final study', 'Final study', v2]);
  assert.equal(await page.evaluate(() => /Never saved/.test(document.getElementById('notif-stack').textContent)), false, 'no success message for it');
  await page.evaluate(() => { LocalDB.put = window.__put; App.closeModal(); });
  assert.ok(!(await local()).some(p => p.name === 'Never saved'));
  // Reopening the renamed project from the list
  await page.click(`#pj-list tr[data-id="${first.id}"] [data-act="open"]`);
  await page.waitForURL(/#dashboard/);
  await page.waitForFunction(() => document.getElementById('topbar-project').textContent === 'Heat pumps 2025');
  assert.equal(await page.evaluate(() => App.getState().project.name), 'Heat pumps 2025');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Backup: everything kept in one browser can be restored in another, which then manages the same published surveys', { skip: noBrowser, timeout: 60000 }, async () => {
  const a = await openApp('#settings');
  await a.page.waitForSelector('#s-data-card');
  await a.page.evaluate(() => LocalDB.put('projects', { id: 'pr_backupTest01', name: 'Backed up', savedAt: new Date().toISOString(), data: { posts: [{ id: 'x', text: 'y' }], codebook: [] } }));
  await a.page.evaluate(() => LocalDB.put('surveys', { id: 'sv_backup01', revision: 1, doc: { title: 'S' } }));
  const dl = a.page.waitForEvent('download');
  await a.page.click('#s-data-card button:has-text("Download a backup")');
  const file = path.join(tmp, 'backup.json');
  await (await dl).saveAs(file);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(backup.format, 'metacode-backup');
  assert.ok(backup.stores.projects.some(p => p.id === 'pr_backupTest01'));
  const ownerA = await a.page.evaluate(() => LocalDB.owner());

  const b = await openApp('#settings');
  await b.page.waitForSelector('#s-data-card');
  assert.notEqual(await b.page.evaluate(() => LocalDB.owner()), ownerA);
  await b.page.click('#s-data-card button:has-text("Restore from a backup")');
  await b.page.setInputFiles('#s-restore-file', file);
  await Promise.all([b.page.waitForNavigation(), b.page.click('#s-restore-go')]);
  await b.page.waitForSelector('#s-data-card');
  assert.equal(await b.page.evaluate(() => LocalDB.owner()), ownerA, 'takes over the identity');
  assert.ok(await b.page.evaluate(() => document.cookie.includes('mc_owner=')));
  assert.equal((await b.page.evaluate(() => LocalDB.get('projects', 'pr_backupTest01'))).name, 'Backed up');
  assert.ok(await b.page.evaluate(() => LocalDB.get('surveys', 'sv_backup01')));
  assert.deepEqual(a.errors.concat(b.errors), []);
  await a.context.close(); await b.context.close();
});

test('AI Coding page: posts are coded by several copies of the model at once; the number is configurable', { skip: noBrowser, timeout: 90000 }, async () => {
  const { page, context, errors } = await openApp('#dashboard');
  await page.waitForFunction(() => App.hasApiKeys());
  const posts = Array.from({ length: 10 }, (_, i) => ({ id: 'post' + i, text: (i % 2 ? 'I am happy ' : 'I am sad ') + i + (i === 3 ? ' GARBLE' : ''), aiCodes: {}, humanCodes: {} }));
  await page.evaluate(posts => {
    App.setState({ posts, codebook: [{ id: 'd1', name: 'Mood', codes: [{ id: 'pos', label: 'Positive' }, { id: 'neg', label: 'Negative' }] }],
      settings: Object.assign({}, App.getState().settings, { model: 'coder-model', models: {}, delay: 0 }) });
  }, posts);
  await page.evaluate(() => App.navigate('ai-coding'));
  await page.waitForSelector('#ai-parallel');
  assert.equal(await page.inputValue('#ai-parallel'), '4', 'four at once by default');
  await page.fill('#ai-parallel', '5');
  await page.dispatchEvent('#ai-parallel', 'change');
  assert.equal(await page.evaluate(() => App.getState().settings.parallel), 5, 'saved with the settings');
  Object.assign(load, { now: 0, max: 0, total: 0 });
  load.garbled.clear();
  await page.click('#run-btn');
  await page.waitForFunction(() => /Done/.test(document.getElementById('status-msg').textContent), null, { timeout: 30000 });
  const coded = await page.evaluate(() => App.getState().posts.map(p => p.aiCodes.d1 && p.aiCodes.d1.code));
  assert.deepEqual(coded, posts.map((p, i) => (i % 2 ? 'pos' : 'neg')), 'every post coded, the unreadable answer retried');
  assert.equal(load.max, 5, 'five copies worked at once');
  assert.equal(load.total, 11, '10 posts + 1 retry');
  assert.match(await page.textContent('#status-msg'), /10 posts coded/);
  // The Settings page has the same number
  await page.evaluate(() => App.navigate('settings'));
  await page.waitForSelector('#s-parallel');
  assert.equal(await page.inputValue('#s-parallel'), '5');
  await page.fill('#s-parallel', '99');
  await page.click('text=Save model settings');
  assert.equal(await page.evaluate(() => App.getState().settings.parallel), 16, 'clamped to the server\'s limit');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a batch that hits server errors (HTTP 502) pauses, runs fewer at once, tries again and recovers', { timeout: 60000 }, async () => {
  wobble.left = 12;                      // the first 4 requests fail, each after MetaCode's own 3 tries
  const res = await fetch(base + '/api/ai/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parallel: 4,
    requests: [1, 2, 3, 4].map(i => ({ id: 'w' + i, body: { model: 'wobbly-coder', max_tokens: 50, messages: [{ role: 'user', content: 'post ' + i }] } })) }) });
  const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
  const notices = lines.filter(l => l.notice);
  assert.equal(notices.length, 1, 'one pause, however many requests were running when it began');
  assert.deepEqual([notices[0].notice.type, notices[0].notice.waitSeconds, notices[0].notice.parallel], ['upstream_error', 5, 2]);
  assert.match(notices[0].notice.message, /server error \(HTTP 502\)/);
  const results = lines.filter(l => l.id);
  assert.deepEqual(results.map(l => l.ok), [true, true, true, true], 'every request answered after the pause');
  assert.deepEqual(lines[lines.length - 1], { done: true, parallel: 4 }, 'server errors don\'t lower the speed for good');
  assert.equal(wobble.left, 0);
});

test('a batch stops sending when the AI service keeps failing, instead of trying every request', { timeout: 90000 }, async () => {
  process.env.AI_BATCH_PAUSE_SECONDS = '0.05';
  try {
    const res = await fetch(base + '/api/ai/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parallel: 1,
      requests: [1, 2, 3, 4].map(i => ({ id: 'f' + i, body: { model: 'flop-pro-3-0', max_tokens: 20, messages: [{ role: 'user', content: 'hi ' + i }] } })) }) });
    const lines = (await res.text()).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.filter(l => l.notice).map(l => l.notice.waitSeconds), [0.1, 0.1, 0.2, 0.4, 0.8], '5 pauses, each longer');
    const results = lines.filter(l => l.id);
    assert.deepEqual(results.map(l => [l.id, l.ok, l.error.type]), [['f1', false, 'upstream_error'], ['f2', false, 'upstream_error'], ['f3', false, 'service_unavailable'], ['f4', false, 'service_unavailable']]);
    assert.match(results[2].error.message, /kept failing for about 2 minutes .*HTTP 502.*what was already done is kept/);
    assert.equal(lines[lines.length - 1].done, true);
  } finally { delete process.env.AI_BATCH_PAUSE_SECONDS; }
});

test('server errors from several models are reported as the AI service having problems, also on the status page; an answer clears it', { timeout: 30000 }, async () => {
  const bodies = [];
  for (const model of ['flop-pro-3-0', 'flop-pro-2-9', 'flop-pro-2-8']) {
    const r = await ask(model, { 'X-MetaCode-Model-Switch': 'off' });      // (with switching on, a similar model would be tried first)
    assert.equal(r.status, 502, model);
    bodies.push((await r.json()).error);
  }
  assert.equal(bodies[0].type, 'upstream_error');
  assert.match(bodies[0].message, /couldn't run the model "flop-pro-3-0" right now: it answered with a server error \(HTTP 502\)/);
  assert.match(bodies[0].message, /you picked/);
  assert.match(bodies[2].message, /having server problems right now: 3 different models answered with server errors \(HTTP 502\)/);
  assert.equal(bodies[2].retryAfterSeconds, 30);
  assert.doesNotMatch(bodies[2].message, /you picked/, 'picking another model wouldn\'t help');
  const aiStatus = async () => (await json('GET', '/api/status')).json.components.find(c => c.id === 'ai');
  let ai;
  for (let end = Date.now() + 8000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) if ((ai = await aiStatus()).status === 'outage') break;
  assert.equal(ai.status, 'outage');
  assert.match(ai.note, /server errors for several models/);
  // An answer from any model: the service is working again (the failing models still rest)
  assert.equal((await ask('model-b')).status, 200);
  for (let end = Date.now() + 8000; Date.now() < end; await new Promise(r => setTimeout(r, 500))) if ((ai = await aiStatus()).status !== 'outage') break;
  assert.equal(ai.status, 'degraded');
  assert.match(ai.note, /\d+ models are failing at the AI service( and \d+ models? (is|are) rate-limited)?; requests for them use the closest similar model\./);
});

test('AI Coding page: server errors pause the run (the status line says so) and every post is still coded', { skip: noBrowser, timeout: 90000 }, async () => {
  const { page, context, errors } = await openApp('#dashboard');
  await page.waitForFunction(() => App.hasApiKeys());
  const posts = Array.from({ length: 6 }, (_, i) => ({ id: 'wp' + i, text: (i % 2 ? 'I am happy ' : 'I am sad ') + i, aiCodes: {}, humanCodes: {} }));
  await page.evaluate(posts => {
    App.setState({ posts, codebook: [{ id: 'd1', name: 'Mood', codes: [{ id: 'pos', label: 'Positive' }, { id: 'neg', label: 'Negative' }] }],
      settings: Object.assign({}, App.getState().settings, { model: 'wobbly-coder', models: {}, delay: 0, parallel: 3 }) });
  }, posts);
  await page.evaluate(() => App.navigate('ai-coding'));
  await page.waitForSelector('#run-btn');
  wobble.left = 9;                       // the first 3 posts fail, each after 3 tries
  await page.click('#run-btn');
  await page.waitForFunction(() => /server problem \(HTTP 502\) — pausing 5 s/.test(document.getElementById('status-msg').textContent), null, { timeout: 30000 });
  await page.waitForFunction(() => /Done/.test(document.getElementById('status-msg').textContent), null, { timeout: 45000 });
  const coded = await page.evaluate(() => App.getState().posts.map(p => p.aiCodes.d1 && p.aiCodes.d1.code));
  assert.deepEqual(coded, posts.map((p, i) => (i % 2 ? 'pos' : 'neg')));
  assert.match(await page.textContent('#status-msg'), /6 posts coded\./);
  assert.deepEqual(errors, []);
  await context.close();
});
