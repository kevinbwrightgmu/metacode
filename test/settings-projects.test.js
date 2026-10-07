// Settings and Projects: the .env loader (encodings, file names, overrides,
// reload), the settings status / reload API, per-feature AI models (against a
// mock EMIS), the saved-projects API, and both pages in a real browser.
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
  const text = 'EMIS_API_KEY=abc\nPORT=1\n';
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
let emis, emisBase, server, base, browser;
const seenModels = [];
const emisFaults = { broken: new Set(), flaky: 0 };   // models that always fail; number of next requests that fail with 503
let proxied = 0;
let lastUserAgent = '';
let emptyHits = 0;
// Parallel AI Coding: how many slow requests EMIS is working on at once
const load = { now: 0, max: 0, total: 0, garbled: new Set() };
// Rate limits: how often each model was called, and the budget the mock reports
const hits = {};
const budget = { remaining: 100 };

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

test.before(async () => {
  // A mock EMIS: lists three models and echoes back the model each chat used
  emis = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (!req.url.startsWith('/v1/')) { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><body>EMIS website</body></html>'); }
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }, { id: 'sse-model' }, { id: 'responses-model' }, { id: 'wrapped-model' }, { id: 'error200-model' }, { id: 'think-model' }, { id: 'forbidden-model' }, { id: 'unicode-model' }, { id: 'streams-unless-told' }, { id: 'stream-only-model' }, { id: 'responses-sse-model' }, { id: 'empty-unless-stream' }, { id: 'slow-model' }, { id: 'coder-model' }, { id: 'acme-opus-4-8' }, { id: 'acme-opus-4-7' }, { id: 'acme-opus-3-0' }, { id: 'acme-mini-2' }, { id: 'acme-opus-4-9' }, { id: 'busy-a' }, { id: 'busy-b' }, { id: 'busy-c' }, { id: 'budget-model' }, { id: 'strm-pro-2-0' }, { id: 'strm-pro-1-9' }] }));
      if (req.url === '/v1/chat/completions') {
        const j = JSON.parse(body || '{}');
        lastUserAgent = String(req.headers['user-agent'] || '');
        // like EMIS's example: answers as a stream
        if (j.model === 'streams-unless-told' && j.stream !== false) { res.setHeader('Content-Type', 'text/event-stream'); return res.end('data: {"choices":[{"delta":{"content":"streamed by default"}}]}\n\ndata: [DONE]\n\n'); }
        if (j.model === 'stream-only-model') {
          if (j.stream !== true) { res.setHeader('Content-Type', 'text/plain'); return res.end('not supported, use stream'); }
          res.setHeader('Content-Type', 'text/event-stream');
          return res.end('data: {"choices":[{"delta":{"content":"ok "}}]}\n\ndata: {"choices":[{"delta":{"content":"via stream"}}]}\n\ndata: [DONE]\n\n');
        }
        if (j.model === 'responses-sse-model') { res.setHeader('Content-Type', 'text/event-stream'); return res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok from "}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"responses sse"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"output_text":"ok from responses sse"}}\n\n'); }
        // Like the user's EMIS: 200 with an empty body unless the reply is streamed
        if (j.model === 'empty-unless-stream') {
          emptyHits++;
          if (j.stream !== true || !/event-stream/.test(String(req.headers.accept || ''))) { res.statusCode = 200; return res.end(); }
          res.setHeader('Content-Type', 'text/event-stream');
          return res.end('data: {"choices":[{"delta":{"content":"ok streamed"}}]}\n\ndata: [DONE]\n\n');
        }
        if (j.model === 'unicode-model') return res.end(JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok → café … 你好 — ' + j.messages.map(m => m.content).join('|') }, finish_reason: 'stop' }] }));
        if (j.model === 'forbidden-model') { res.statusCode = 403; return res.end('{"error":{"message":"this key may not use forbidden-model"}}'); }
        hits[j.model] = (hits[j.model] || 0) + 1;
        const quotaHeaders = { 'X-RateLimit-Window': 'day', 'X-RateLimit-Limit-Prompts': '100', 'X-RateLimit-Remaining-Prompts': String(budget.remaining), 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600) };
        // EMIS throttles these models although the key has budget left
        if (j.model === 'strm-pro-1-9') { res.setHeader('Content-Type', 'text/event-stream'); return res.end('data: {"model":"strm-pro-1-9","choices":[{"delta":{"content":"streamed by 1-9"}}]}\n\ndata: [DONE]\n\n'); }
        if (j.model === 'acme-opus-4-8' || j.model === 'acme-opus-4-9' || j.model === 'strm-pro-2-0') { res.writeHead(429, Object.assign({ 'Content-Type': 'application/json' }, quotaHeaders)); return res.end('{"error":{"message":"model busy"}}'); }
        // 429s without quota headers: the key is being paused (Retry-After 1 s)
        if (/^busy-/.test(j.model)) { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' }); return res.end('{"error":{"message":"slow down"}}'); }
        // The key's budget is used up: every model would fail
        if (j.model === 'budget-model') { res.writeHead(429, Object.assign({ 'Content-Type': 'application/json' }, quotaHeaders, { 'X-RateLimit-Remaining-Prompts': '0', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 2) })); return res.end('{"error":{"message":"budget used up"}}'); }
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
            if (!res.writableEnded && !res.destroyed) res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
          }, 250);
          return;
        }
        seenModels.push(j.model);
        if (emisFaults.flaky > 0) { emisFaults.flaky--; res.statusCode = 503; return res.end('{"error":{"message":"busy"}}'); }
        if (emisFaults.broken.has(j.model)) { res.statusCode = 500; return res.end('{"error":{"message":"model crashed"}}'); }
        // Other reply shapes some gateways use
        if (j.model === 'sse-model') { res.setHeader('Content-Type', 'text/event-stream'); return res.end('data: {"id":"s1","model":"sse-model","choices":[{"delta":{"content":"ok "}}]}\n\ndata: {"choices":[{"delta":{"content":"from sse"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
        if (j.model === 'responses-model') return res.end(JSON.stringify({ id: 'r1', model: j.model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok from responses' }] }] }));
        if (j.model === 'wrapped-model') return res.end(JSON.stringify({ data: { choices: [{ message: { role: 'assistant', content: 'ok from wrapped' } }] } }));
        if (j.model === 'error200-model') return res.end(JSON.stringify({ error: { message: 'quota for this model is disabled' } }));
        if (j.model === 'think-model' && !(j.max_tokens >= 1024)) return res.end(JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: 'thinking…' }, finish_reason: 'length' }] }));
        return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok from ' + j.model }, finish_reason: 'stop' }] }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise(r => emis.listen(0, '127.0.0.1', r));
  emisBase = 'http://127.0.0.1:' + emis.address().port + '/v1';
  fs.writeFileSync(envFile, 'EMIS_BASE_URL=' + emisBase + '\n');           // no key yet
  Object.assign(process.env, testEnv({
    METACODE_ENV_FILE: envFile, EMIS_MODELS_FILE: path.join(tmp, 'no-such-models.json'),
    SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects')
  }));
  const { start } = require('../server');
  server = await start(0);
  base = 'http://localhost:' + server.address().port;
  if (chromiumPath) browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (emis) { emis.closeAllConnections(); await new Promise(r => emis.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = async (method, url, body, headers) => {
  const res = await fetch(base + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('settings status shows what .env set (names only); Reload .env picks up a new key without a restart', async () => {
  let st = (await json('GET', '/api/settings/status')).json;
  assert.equal(st.env.found, true);
  assert.deepEqual(st.env.keys, ['EMIS_BASE_URL']);
  assert.equal(st.ai.ready, false);
  assert.match(st.ai.problem, /EMIS_API_KEY/);
  const ai = await json('POST', '/api/ai', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ai.status, 401);
  assert.match(ai.json.error.message, /Reload \.env/);

  fs.writeFileSync(envFile, 'EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=emis-test-key-123456\n');
  const reloaded = await json('POST', '/api/settings/reload', {});
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.json.ai.ready, true);
  assert.equal(reloaded.json.ai.keyCount, 1);
  assert.ok(!JSON.stringify(reloaded.json).includes('emis-test-key-123456'), 'the key itself is never sent');
  const health = (await json('GET', '/api/health')).json;
  assert.equal(health.emisConfigured, true);
  // Reload is refused from other sites
  assert.equal((await json('POST', '/api/settings/reload', {}, { Origin: 'https://evil.example' })).status, 403);
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

test('a temporary EMIS failure is retried; a failing default model falls back; a picked one says so', async () => {
  const ask = model => json('POST', '/api/ai', Object.assign({ messages: [{ role: 'user', content: 'hi' }] }, model ? { model } : {}), { 'x-provider': 'openai' });
  emisFaults.flaky = 1;
  let r = await ask('model-b');
  assert.equal(r.status, 200, 'a 503 is retried');
  assert.equal(r.json.choices[0].message.content, 'ok from model-b');

  const def = (await json('GET', '/api/models')).json.models[0].id;     // the server default
  emisFaults.broken = new Set([def]);
  seenModels.length = 0;
  const res = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  const body = await res.json();
  assert.equal(res.status, 200, 'answered by another model');
  assert.notEqual(body.model, def);
  assert.equal(res.headers.get('x-metacode-model-fallback'), body.model);

  r = await ask(def);
  assert.equal(r.status, 502, 'a model the user picked is not swapped');
  assert.match(r.json.error.message, /Settings → AI models/);
  emisFaults.broken = new Set();
});

test('replies in other shapes are read; an unreadable one says what EMIS sent', async () => {
  const ask = model => json('POST', '/api/ai', { model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
  for (const [model, text] of [['sse-model', 'ok from sse'], ['responses-model', 'ok from responses'], ['wrapped-model', 'ok from wrapped'], ['think-model', 'ok from think-model']]) {
    const r = await ask(model);
    assert.equal(r.status, 200, model);
    assert.equal(r.json.choices[0].message.content, text, model);
  }
  const bad = await ask('error200-model');
  assert.equal(bad.status, 502);
  assert.match(bad.json.error.message, /quota for this model is disabled/);
});

test('an EMIS_BASE_URL without /v1 (the website answers) is corrected automatically', async () => {
  fs.writeFileSync(envFile, 'EMIS_BASE_URL=' + emisBase.replace(/\/v1$/, '') + '\nEMIS_API_KEY=emis-test-key-123456\n');
  try {
    await json('POST', '/api/settings/reload', {});
    const r = await json('POST', '/api/ai', { model: 'model-b', messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'ok from model-b');
    assert.ok((await json('GET', '/api/settings/status')).json.ai.warnings.some(w => /\/v1/.test(w)));
  } finally {
    fs.writeFileSync(envFile, 'EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=emis-test-key-123456\n');
    await json('POST', '/api/settings/reload', {});
  }
});

test('requests go through Python when it is available; a 403 shows EMIS\'s reason and keeps the key', async () => {
  const st = (await json('GET', '/api/settings/status')).json;
  const python = /^Python/.test(st.ai.transport);
  if (python) {
    const r = await json('POST', '/api/ai', { model: 'model-b', messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
    assert.equal(r.status, 200);
    let usingSdk = false;
    try { require('child_process').execSync('python3 -c "import openai"', { stdio: 'ignore' }); usingSdk = true; } catch (e) { /* no SDK */ }
    assert.match(lastUserAgent, usingSdk ? /^OpenAI\/Python/ : /Python/, 'sent from Python');
  }
  const bad = await json('POST', '/api/ai', { model: 'forbidden-model', messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
  assert.equal(bad.status, 403);
  assert.match(bad.json.error.message, /this key may not use forbidden-model/);
  const keys = (await json('GET', '/api/keys/status')).json.keys;
  assert.equal(keys[0].status, 'available', 'a model-specific 403 doesn\'t disable the key');
  const ok = await json('POST', '/api/ai', { model: 'model-b', messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
  assert.equal(ok.status, 200);
});

test('non-ASCII text in prompts and answers survives the trip (Windows console encodings)', async () => {
  const r = await json('POST', '/api/ai', { model: 'unicode-model', messages: [{ role: 'user', content: 'Grüße → “quotes” …' }] }, { 'x-provider': 'openai' });
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, 'ok → café … 你好 — Grüße → “quotes” …');
});

test('streamed answers: asked for non-streamed explicitly, read when streamed anyway, re-asked with stream: true when needed', async () => {
  for (const [model, text] of [['streams-unless-told', 'ok from streams-unless-told'], ['stream-only-model', 'ok via stream'], ['responses-sse-model', 'ok from responses sse']]) {
    const r = await json('POST', '/api/ai', { model, messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
    assert.equal(r.status, 200, model + ': ' + JSON.stringify(r.json));
    assert.equal(r.json.choices[0].message.content, text, model);
  }
});

test('an empty 200 reply switches to streaming at once (no retry delays) and is remembered', async () => {
  emptyHits = 0;
  const t0 = Date.now();
  let r = await json('POST', '/api/ai', { model: 'empty-unless-stream', messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.choices[0].message.content, 'ok streamed');
  assert.ok(emptyHits <= 2, 'at most one plain try, then streamed (fewer once streaming is known to work)');
  const first = emptyHits;
  assert.ok(Date.now() - t0 < 500, 'no retry delays');
  r = await json('POST', '/api/ai', { model: 'empty-unless-stream', messages: [{ role: 'user', content: 'again' }] }, { 'x-provider': 'openai' });
  assert.equal(r.status, 200);
  assert.equal(emptyHits, first + 1, 'the next request goes straight to streaming');
});

test('EMIS requests go through EMIS_PROXY when set (Node ignores HTTPS_PROXY by itself)', async () => {
  const net = require('net');
  // Handles both CONNECT tunnels and plain forwarded requests (absolute URLs)
  const proxy = http.createServer((req, res) => {
    proxied++;
    const target = new URL(req.url);
    const up = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, ur => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  proxy.on('connect', (req, socket, head) => {
    proxied++;
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  fs.writeFileSync(envFile, 'EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=emis-test-key-123456\nEMIS_PROXY=http://127.0.0.1:' + proxy.address().port + '\n');
  try {
    await json('POST', '/api/settings/reload', {});
    const r = await json('POST', '/api/ai', { model: 'model-b', messages: [{ role: 'user', content: 'hi' }] }, { 'x-provider': 'openai' });
    assert.equal(r.status, 200);
    assert.ok(proxied >= 1, 'the request went through the proxy');
  } finally {
    fs.writeFileSync(envFile, 'EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=emis-test-key-123456\n');
    await json('POST', '/api/settings/reload', {});
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
  // The key still has budget: it isn't resting, and other models are unaffected
  const keys = (await json('GET', '/api/keys/status')).json;
  assert.ok(JSON.stringify(keys).includes('available'), JSON.stringify(keys));
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
  const j = (await json('GET', '/api/status')).json;
  const ai = j.components.find(c => c.id === 'ai');
  assert.equal(ai.status, 'degraded');
  assert.match(ai.note, /rate-limited; requests use the closest similar model/);
  assert.deepEqual(hits, before, 'no chat requests were made');
  assert.ok(!/emis/i.test(JSON.stringify(j)));
});

test('streamed requests switch to the closest model too, before anything is sent', async () => {
  const res = await fetch(base + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-provider': 'openai' }, body: JSON.stringify({ model: 'strm-pro-2-0', stream: true, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  assert.equal(res.headers.get('x-metacode-model-fallback'), 'strm-pro-1-9');
  assert.match(await res.text(), /streamed by 1-9/);
});

test('a used-up key budget isn\'t "solved" by switching models; 429s on several models without quota headers pause the key', async () => {
  let res = await ask('budget-model');
  let body = await res.json();
  assert.equal(res.status, 429);
  assert.equal(body.error.type, 'quota_exceeded');
  assert.equal(res.headers.get('x-metacode-model-fallback'), null, 'no other model was tried');
  assert.ok(!(await json('GET', '/api/settings/status')).json.ai.rateLimitedModels.some(x => x.model === 'budget-model'), 'the key rests, not the model');
  await new Promise(r => setTimeout(r, 2300));            // the budget window resets
  // busy-a → busy-b → busy-c all refused without quota headers: it's the key being paused
  res = await ask('busy-a');
  body = await res.json();
  assert.equal(res.status, 429);
  assert.equal(body.error.type, 'rate_limited');
  assert.match(body.error.message, /pause/);
  assert.deepEqual([hits['busy-a'], hits['busy-b'], hits['busy-c']], [1, 1, 1]);
  assert.ok(!(await json('GET', '/api/settings/status')).json.ai.rateLimitedModels.some(x => /^busy-/.test(x.model)), 'the models aren\'t blamed for the key\'s pause');
  await new Promise(r => setTimeout(r, 1300));            // Retry-After: 1
  res = await ask('model-b');
  assert.equal(res.status, 200, 'the key is back');
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
  assert.match(await page.textContent('#s-env-status'), /settings\.env.*EMIS_API_KEY/s);
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
