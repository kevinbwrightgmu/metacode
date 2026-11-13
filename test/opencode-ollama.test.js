// MetaCode's OpenCode service and its local last-resort backup (opencode/providers/ollama.mjs):
// Ollama on this server, found by itself (OLLAMA_BACKUP=auto), left out while it isn't there,
// offering OLLAMA_MODELS (downloaded when missing) as backup models that are never the default
// while another provider has a model. Against a stand-in for Ollama and one for the AI gateway.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const TOKEN = 'test-service-token-ollama-0123456789';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ollama-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Stand-ins ────────────────────────────────────────────────────────────────
const ollama = { have: [], pulls: [], pullDelayMs: 0, chats: [], auth: [], formats: [], server: null, base: null };
function startOllama() {
  return new Promise(resolve => {
    ollama.server = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => { b += c; });
      req.on('end', () => {
        const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.method === 'GET' && req.url === '/api/tags') return send(200, { models: ollama.have.map(name => ({ name, model: name, size: 123 })) });
        if (req.method === 'POST' && req.url === '/api/pull') {
          // (streamed, as Ollama does: a line of progress now and then, then {"status":"success"} or {"error"})
          const { model, stream } = JSON.parse(b || '{}');
          ollama.pulls.push({ model, stream });
          const line = obj => res.write(JSON.stringify(obj) + '\n');
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          line({ status: 'pulling manifest' });
          if (/^missing\//.test(model)) return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n');
          line({ status: 'pulling 1234', digest: 'sha256:1234', total: 1000, completed: 500 });
          return setTimeout(() => {
            if (!ollama.have.includes(model)) ollama.have.push(model);
            line({ status: 'pulling 1234', digest: 'sha256:1234', total: 1000, completed: 1000 });
            line({ status: 'verifying sha256 digest' });
            res.end(JSON.stringify({ status: 'success' }) + '\n');
          }, ollama.pullDelayMs);
        }
        if (req.method === 'GET' && req.url === '/v1/models') {
          return send(200, { object: 'list', data: ollama.have.map(id => ({ id, object: 'model', created: 0, owned_by: 'library' })) });
        }
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          const body = JSON.parse(b || '{}');
          ollama.chats.push(body.model);
          ollama.auth.push(req.headers.authorization || null);
          ollama.formats.push(body.response_format || null);
          if (!ollama.have.includes(body.model)) return send(404, { error: { message: 'model "' + body.model + '" not found, try pulling it first', type: 'api_error' } });
          if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'local ' + body.model }, finish_reason: 'stop' }] }) + '\n\n');
            return res.end('data: [DONE]\n\n');
          }
          return send(200, { id: 'c', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'local ' + body.model }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
        }
        send(404, { error: 'not found' });
      });
    });
    ollama.server.listen(0, '127.0.0.1', () => { ollama.base = 'http://127.0.0.1:' + ollama.server.address().port; resolve(); });
  });
}
let gateway = null, gatewayBase = null;
function startGateway() {
  return new Promise(resolve => {
    gateway = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => { b += c; });
      req.on('end', () => {
        const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'gpt-small', object: 'model' }] });
        const body = JSON.parse(b || '{}');
        send(200, { id: 'g', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'gateway ' + body.model }, finish_reason: 'stop' }] });
      });
    });
    gateway.listen(0, '127.0.0.1', () => { gatewayBase = 'http://127.0.0.1:' + gateway.address().port + '/v1'; resolve(); });
  });
}
const closedPort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });

// ── The service ──────────────────────────────────────────────────────────────
let S;
const running = [];
async function start(env) {
  const svc = await S.startService({
    env: Object.assign({
      METACODE_ENV_FILE: 'none', METACODE_LOG: 'off', OPENCODE_SERVICE_DATA_DIR: fs.mkdtempSync(path.join(tmp, 'svc-')), OPENCODE_SERVICE_TOKEN: TOKEN,
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLED_PROVIDERS: 'opencode',
      EMIS_BASE_URL: gatewayBase, EMIS_API_KEY: 'emis-test-key-0123456789', EMIS_TRANSPORT: 'node', EMIS_MODELS_FILE: 'none',
      OLLAMA_BASE_URL: ollama.base + '/v1'
    }, env),
    port: 0, host: '127.0.0.1', log: { info() {}, warn() {}, error() {} }
  });
  running.push(svc);
  return svc;
}
async function call(svc, method, p, body) {
  const res = await fetch(svc.url.replace(/\/v1$/, '') + p, {
    method, headers: Object.assign({ authorization: 'Bearer ' + TOKEN }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: res.status, text, json, headers: res.headers };
}
const models = async svc => (await call(svc, 'GET', '/v1/models')).json;
const statusOf = async (svc, id) => (await call(svc, 'GET', '/v1/status')).json.providers.find(p => p.id === id);
async function until(check, ms, what) {
  const deadline = Date.now() + (ms || 8000);
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + (what || 'a condition'));
    await sleep(100);
  }
}

test.before(async () => {
  S = await import('../opencode/server.mjs');
  await startOllama();
  await startGateway();
});
test.after(async () => {
  for (const svc of running) await svc.close().catch(() => {});
  ollama.server.closeAllConnections(); await new Promise(r => ollama.server.close(r));
  gateway.closeAllConnections(); await new Promise(r => gateway.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});
test.beforeEach(() => { Object.assign(ollama, { have: [], pulls: [], pullDelayMs: 0, chats: [], auth: [], formats: [] }); });

test('Ollama answering (OLLAMA_BACKUP=auto, the default): its OLLAMA_MODELS are offered as local backup models — in that order, never the default while the gateway has a model — and answer chats, streamed too', async () => {
  ollama.have = ['tiny-b:270m', 'tiny-a:0.5b', 'big:70b', 'nomic-embed-text:latest'];
  const svc = await start({ OLLAMA_MODELS: 'tiny-a:0.5b,tiny-b:270m', OLLAMA_AUTO_PULL: 'off' });
  const m = await models(svc);
  // (OpenCode Zen is switched off here: listed, not ready)
  assert.deepEqual(m.providers.map(p => [p.id, p.ready, !!p.backup]), [['emis', true, false], ['opencode', false, false], ['ollama', true, true]]);
  const local = m.data.filter(e => e.provider === 'ollama');
  assert.deepEqual(local.map(e => [e.id, e.name, e.backup, e.local, e.free]), [
    ['ollama/tiny-a:0.5b', 'tiny-a:0.5b (local backup)', true, true, false],
    ['ollama/tiny-b:270m', 'tiny-b:270m (local backup)', true, true, false]
  ]);
  assert.equal(m.default, 'emis/gpt-small', 'the gateway\'s model is the default');
  const st = await statusOf(svc, 'ollama');
  assert.equal(st.ready, true);
  assert.equal(st.keyCount, 0);
  assert.match(st.note, /^Last-resort backup: answers only when no other provider's model can, one request at a time\. Models: tiny-a:0\.5b, tiny-b:270m\.$/);
  // a chat for a local model (Ollama takes no key; any placeholder is sent), asking for JSON (as MetaCode does for AI Coding)
  const r = await call(svc, 'POST', '/v1/chat/completions', { model: 'ollama/tiny-b:270m', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'code this' }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'local tiny-b:270m');
  assert.deepEqual(ollama.formats, [{ type: 'json_object' }], 'response_format reaches Ollama');
  assert.ok(ollama.auth[0], 'a placeholder key is sent');
  const s = await call(svc, 'POST', '/v1/chat/completions', { model: 'ollama/tiny-a:0.5b', stream: true, messages: [{ role: 'user', content: 'code this' }] });
  assert.equal(s.status, 200, s.text);
  assert.match(s.text, /local tiny-a:0\.5b/);
  // a model Ollama has but OLLAMA_MODELS doesn't name isn't offered
  const big = await call(svc, 'POST', '/v1/chat/completions', { model: 'ollama/big:70b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(big.status, 404, big.text);
  assert.match(big.json.error.message, /isn't one of MetaCode's local backup models \(OLLAMA_MODELS\)/);
  // a bare id that both could mean goes to the gateway first
  ollama.have.push('gpt-small');
  const bare = await call(svc, 'POST', '/v1/chat/completions', { model: 'gpt-small', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(bare.json.choices[0].message.content, 'gateway gpt-small');
});

test('OLLAMA_MODELS=all: every chat model Ollama has (not its embedding models); with only Ollama ready, its first model is the default', async () => {
  ollama.have = ['tiny-b:270m', 'big:70b', 'nomic-embed-text:latest'];
  const svc = await start({ OLLAMA_MODELS: 'all', OPENCODE_DISABLED_PROVIDERS: 'opencode,emis' });
  const m = await models(svc);
  assert.deepEqual(m.data.map(e => e.id), ['ollama/tiny-b:270m', 'ollama/big:70b']);
  assert.equal(m.default, 'ollama/tiny-b:270m', 'the only provider: its model is the default');
});

test('nothing answering at OLLAMA_BASE_URL: with auto it is left out of every list; with OLLAMA_BACKUP=on it is listed with the problem; with off it is absent', async () => {
  const port = await closedPort();
  const auto = await start({ OLLAMA_BASE_URL: 'http://127.0.0.1:' + port + '/v1' });
  const st = (await call(auto, 'GET', '/v1/status')).json;
  assert.deepEqual(st.providers.map(p => p.id), ['emis', 'opencode'], 'no row for a server without Ollama');
  assert.deepEqual((await models(auto)).providers.map(p => p.id), ['emis', 'opencode']);

  const on = await start({ OLLAMA_BASE_URL: 'http://127.0.0.1:' + port + '/v1', OLLAMA_BACKUP: 'on' });
  const p = await statusOf(on, 'ollama');
  assert.equal(p.ready, false);
  assert.match(p.problem, /^Ollama isn't answering at http:\/\/127\.0\.0\.1:\d+ \(.+\)\. Install and start Ollama on this server \(ollama\.com\), or set OLLAMA_BASE_URL\.$/);

  ollama.have = ['tiny-a:0.5b'];
  const off = await start({ OLLAMA_BACKUP: 'off', OLLAMA_MODELS: 'tiny-a:0.5b' });
  assert.deepEqual((await call(off, 'GET', '/v1/status')).json.providers.map(x => x.id), ['emis', 'opencode']);
  assert.equal((await models(off)).data.some(e => e.provider === 'ollama'), false);
});

test('OLLAMA_MODELS Ollama doesn\'t have yet are downloaded one after the other (POST /api/pull), then offered; meanwhile the status says so', async () => {
  ollama.pullDelayMs = 600;
  const svc = await start({ OLLAMA_MODELS: 'tiny-a:0.5b,tiny-b:270m' });
  const p = await until(async () => { const x = await statusOf(svc, 'ollama'); return x && /Downloading .*%/.test(x.problem || '') && x; }, 5000, 'downloading');
  assert.equal(p.ready, false);
  assert.match(p.problem, /^Downloading tiny-a:0\.5b \(50%\) — the local backup is ready when that's done\.$/);
  await until(async () => (await statusOf(svc, 'ollama')).ready, 8000, 'ready');
  assert.deepEqual(ollama.pulls, [{ model: 'tiny-a:0.5b', stream: true }, { model: 'tiny-b:270m', stream: true }], 'one after the other');
  const local = (await models(svc)).data.filter(e => e.provider === 'ollama').map(e => e.id);
  assert.deepEqual(local, ['ollama/tiny-a:0.5b', 'ollama/tiny-b:270m']);
});

test('OLLAMA_AUTO_PULL=off, or a download that fails: nothing more is tried, and the problem says what to run', async () => {
  const svc = await start({ OLLAMA_MODELS: 'tiny-a:0.5b', OLLAMA_AUTO_PULL: 'off' });
  const p = await statusOf(svc, 'ollama');
  assert.equal(p.ready, false);
  assert.equal(p.problem, 'Ollama has none of the models in OLLAMA_MODELS (tiny-a:0.5b). Run "ollama pull tiny-a:0.5b" on the server (OLLAMA_AUTO_PULL is off).');
  assert.deepEqual(ollama.pulls, []);

  const failing = await start({ OLLAMA_MODELS: 'missing/model:1b' });
  const f = await until(async () => { const x = await statusOf(failing, 'ollama'); return /downloading failed/.test(x.problem || '') && x; }, 5000, 'the failure');
  assert.match(f.problem, /^Ollama has none of the models in OLLAMA_MODELS \(missing\/model:1b\): downloading failed — missing\/model:1b \(pull model manifest: file does not exist\)\. Run "ollama pull missing\/model:1b" on the server\.$/);
});

test('a proxy set for the internet (HTTPS_PROXY / HTTP_PROXY) doesn\'t get the requests for Ollama on this machine', async () => {
  ollama.have = ['tiny-a:0.5b'];
  const port = await closedPort();
  const svc = await start({ OLLAMA_MODELS: 'tiny-a:0.5b', OLLAMA_AUTO_PULL: 'off', HTTP_PROXY: 'http://127.0.0.1:' + port, HTTPS_PROXY: 'http://127.0.0.1:' + port, OPENCODE_DISABLED_PROVIDERS: 'opencode,emis' });
  const r = await call(svc, 'POST', '/v1/chat/completions', { model: 'ollama/tiny-a:0.5b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.choices[0].message.content, 'local tiny-a:0.5b');
});
