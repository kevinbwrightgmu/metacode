// The OpenCode service's OpenAI-compatible provider (opencode/providers/
// openai-compatible.mjs), i.e. EMIS inside the service, against a stand-in for
// EMIS on 127.0.0.1. What the gateway's documentation says: a key's budget is
// prompts and/or tokens per day, week or month, reported in X-RateLimit-*
// headers, and 429 means it's used up until the window rolls over; keys look
// like "emis-…" (the .env.example placeholder isn't one); the website's browser
// check doesn't apply to API requests made with a key (a web page means a wrong
// address or a proxy, not a rejected key); images can come back inside a chat
// answer. Plus what MetaCode learned about it: several keys in rotation, a 429
// for one model vs the key's budget, the /v1 fix, the Python transport, the
// models file. The modules are ESM, so they're import()ed. Nothing here leaves
// this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');

const KEY = 'emis-docs-test-key-0123456789';
const KEY2 = 'emis-second-test-key-9876543210';
const BAD_KEY = 'emis-rejected-test-key-000000';      // the stand-in answers chats with 401 for it
const LIST_BAD_KEY = 'emis-list-rejected-key-00000';   // …and GET /models with 401 for this one
const SPENT_KEY = 'emis-spent-test-key-1111111111';    // …and 429 "budget used up" for it
const UNPAID_KEY = 'emis-unpaid-test-key-3333333333';  // …and 402 (no credit left) for it
const HEADER_SECRET = 'gw-header-secret-0123456789';   // a provider's own header (options.headers); some gateways echo it
const ALL_KEYS = [KEY, KEY2, BAD_KEY, LIST_BAD_KEY, SPENT_KEY, UNPAID_KEY, HEADER_SECRET];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-opencode-emis-'));
let P, O, E, emis, emisBase;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const python = ['python3', 'python'].some(cmd => { try { return spawnSync(cmd, ['--version']).status === 0; } catch (e) { return false; } });

// ── The stand-in for EMIS ─────────────────────────────────────────────────────
const LISTED = ['prompts-only', 'budget-said', 'gemini-3.8-flash', 'gemini-3.7-flash', 'slow', 'picture', 'picture-only', 'other-1',
  'forbidden-model', 'blocked-model', 'budget-model', 'busy-a', 'busy-b', 'busy-c', 'limited-model', 'sse-model', 'json-model', 'eos-model',
  'unicode-model', 'missing-model', 'error200-model', 'claude-opus-5.5', 'dall-e-3', 'text-embedding-3-large',
  'streams-unless-told', 'stream-only-model', 'empty-unless-stream', 'think-model', 'redirect-model', 'echo-header', 'cut-short', 'finish-only'];
const state = { calls: [], seen: [], modelsMode: 'ok', models: LISTED, listCalls: 0, remaining: 100, websiteListNotFound: false, cutShort: 0 };
const reset = seconds => String(Math.floor(Date.now() / 1000) + seconds);
const chunk = (model, delta, finish) => JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model, choices: [Object.assign({ index: 0, delta }, finish ? { finish_reason: finish } : {})] });

function startEmis() {
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
      // the website (the address without /v1)
      if (!req.url.startsWith('/v1/')) {
        if (state.websiteListNotFound && /\/models$/.test(req.url)) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Not found</title>'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><html><body>EMIS website</body></html>');
      }
      if (req.url === '/v1/models') {
        state.listCalls++;
        if (key === LIST_BAD_KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"Invalid API key"}}'); }
        if (state.modelsMode === 'webpage403') { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Just a moment...</title>'); }
        if (state.modelsMode === 'webpage200') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>emis</title>'); }
        if (state.modelsMode === 'down') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"down"}}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: state.models.map(id => ({ id, object: 'model' })) }));
      }
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch (e) { j = {}; }
      state.calls.push(j.model);
      state.seen.push({ url: req.url, headers: req.headers, body: j, key });
      const send = (status, headers, text) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers)); res.end(text); };
      const answer = (content, extra) => JSON.stringify(Object.assign({ id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }, extra));
      const quota = { 'X-RateLimit-Window': 'day', 'X-RateLimit-Limit-Prompts': '100', 'X-RateLimit-Remaining-Prompts': String(state.remaining), 'X-RateLimit-Reset': reset(3600) };
      if (key === BAD_KEY) return send(401, {}, '{"error":{"message":"Invalid API key"}}');
      if (key === SPENT_KEY) return send(429, Object.assign({}, quota, { 'X-RateLimit-Remaining-Prompts': '0', 'X-RateLimit-Reset': reset(7200) }), '{"error":{"message":"budget used up"}}');
      if (key === UNPAID_KEY) return send(402, {}, '{"error":{"message":"Insufficient credits on this key"}}');
      if (!state.models.includes(j.model)) return send(404, {}, JSON.stringify({ error: { message: 'The model `' + j.model + '` does not exist' } }));
      switch (j.model) {
        // A key with only a prompt budget, reporting its (absent) token budget as 0 of 0
        case 'prompts-only':
          return send(200, { 'X-RateLimit-Window': 'week', 'X-RateLimit-Limit-Prompts': '100', 'X-RateLimit-Remaining-Prompts': '99', 'X-RateLimit-Limit-Tokens': '0', 'X-RateLimit-Remaining-Tokens': '0', 'X-RateLimit-Reset': reset(3600) }, answer('ok'));
        // The budget ran out, which the message says before the headers do
        case 'budget-said':
          return send(429, { 'X-RateLimit-Window': 'day', 'X-RateLimit-Limit-Tokens': '5000', 'X-RateLimit-Remaining-Tokens': '400', 'X-RateLimit-Reset': reset(3600) }, '{"error":{"message":"Token budget exceeded for this window"}}');
        // One model limited by its provider, in the provider's words, while the key has plenty of budget left
        case 'gemini-3.8-flash':
          return send(429, { 'X-RateLimit-Window': 'week', 'X-RateLimit-Limit-Prompts': '1000', 'X-RateLimit-Remaining-Prompts': '950', 'X-RateLimit-Reset': reset(5 * 86400) }, '{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}');
        case 'limited-model':
          return send(429, Object.assign({ 'Retry-After': '20' }, quota), '{"error":{"message":"model busy"}}');
        // The key's budget is used up: every model would fail (the window resets in 2 s)
        case 'budget-model':
          return send(429, Object.assign({}, quota, { 'X-RateLimit-Remaining-Prompts': '0', 'X-RateLimit-Reset': reset(2) }), '{"error":{"message":"budget used up"}}');
        // 429s without quota headers: the key is being paused (Retry-After 1 s)
        case 'busy-a': case 'busy-b': case 'busy-c':
          return send(429, { 'Retry-After': '1' }, '{"error":{"message":"slow down"}}');
        case 'forbidden-model': return send(403, {}, '{"error":{"message":"this key may not use forbidden-model"}}');
        case 'redirect-model': return send(302, { Location: 'https://elsewhere.example/login' }, '');
        case 'blocked-model': res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Just a moment...</title>');
        case 'missing-model': return send(404, {}, '{"error":{"message":"The model `missing-model` does not exist"}}');
        case 'error200-model': return send(200, {}, '{"error":{"message":"quota for this model is disabled"}}');
        case 'slow': return setTimeout(() => send(200, quota, answer('ok, slowly')), 1500);
        case 'picture': return send(200, {}, answer([{ type: 'text', text: 'Here is your cat: ' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]));
        case 'picture-only': return send(200, {}, answer([{ type: 'image_url', image_url: { url: 'https://example.org/cat.png' } }]));
        case 'json-model': return send(200, quota, answer('plain JSON from json-model'));       // ignores stream: true
        case 'eos-model': return send(200, {}, answer('ended oddly').replace('"stop"', '"eos"'));
        case 'unicode-model': return send(200, {}, answer('ok → café … 你好 — ' + (j.messages || []).map(m => m.content).join('|')));
        // like EMIS's example: answers as a stream (no finish_reason) unless told not to
        case 'streams-unless-told':
          if (j.stream === false) return send(200, {}, answer('plain'));
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end('data: {"choices":[{"delta":{"content":"streamed by default"}}]}\n\ndata: [DONE]\n\n');
        case 'stream-only-model':
          if (j.stream !== true) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('not supported, use stream'); }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end('data: {"choices":[{"delta":{"content":"ok "}}]}\n\ndata: {"choices":[{"delta":{"content":"via stream"}}]}\n\ndata: [DONE]\n\n');
        // like a user's EMIS: 200 with an empty body unless the reply is streamed (and asked for as a stream)
        case 'empty-unless-stream':
          if (j.stream !== true || !/event-stream/.test(String(req.headers.accept || ''))) { res.writeHead(200); return res.end(); }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end('data: {"choices":[{"delta":{"content":"ok streamed"}}]}\n\ndata: [DONE]\n\n');
        // a reasoning model that spends a small budget thinking (MetaCode asks again with more)
        case 'think-model':
          if (!(j.max_tokens >= 1024)) return send(200, {}, JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning_content: 'thinking…' }, finish_reason: 'length' }] }));
          return send(200, {}, answer('ok from think-model'));
        // a gateway that quotes the provider's own header back in its error
        case 'echo-header': return send(400, {}, JSON.stringify({ error: { message: 'gateway token ' + req.headers['x-gateway-token'] + ' is not allowed for this route' } }));
        // the answer stops in the middle: no finish_reason, no [DONE] (a proxy closed it cleanly)
        case 'cut-short':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end('data: ' + chunk(j.model, { role: 'assistant', content: 'The answer is: ' }) + '\n\ndata: ' + chunk(j.model, { content: '{"label": "pos' }) + '\n\n');
        // a finish_reason, then the end without [DONE]
        case 'finish-only':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end('data: ' + chunk(j.model, { role: 'assistant', content: 'finished' }, 'stop') + '\n\n');
        case 'sse-model':                                                                           // streams even when not asked
          res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream' }, quota));
          return res.end('data: ' + chunk(j.model, { role: 'assistant', content: 'ok ' }) + '\n\ndata: ' + chunk(j.model, { content: 'from sse' }, 'stop') + '\n\ndata: [DONE]\n\n');
      }
      // Like EMIS: a stream when asked for one (in pieces, a little apart), else a plain answer
      if (j.stream) {
        res.on('close', () => { if (!res.writableEnded) state.cutShort++; });      // the caller went away mid-answer
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream' }, quota));
        const parts = ['ok ', 'from ', j.model];
        let i = 0;
        const next = () => {
          if (res.destroyed) return;
          if (i < parts.length) { res.write('data: ' + chunk(j.model, i ? { content: parts[i] } : { role: 'assistant', content: parts[i] }) + '\n\n'); i++; return setTimeout(next, 120); }
          res.write('data: ' + chunk(j.model, {}, 'stop') + '\n\n');
          res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) + '\n\n');
          res.end('data: [DONE]\n\n');
        };
        return next();
      }
      return send(200, quota, answer('ok from ' + j.model));
    });
  });
  srv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
    port: srv.address().port,
    close: () => new Promise(r => { sockets.forEach(s => s.destroy()); srv.close(r); })
  })));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const logged = [];
const log = { info: (e, f) => logged.push(['info', e, f]), warn: (e, f) => logged.push(['warn', e, f]), error: (e, f) => logged.push(['error', e, f]) };

// A provider like the service makes it from opencode/opencode.json (config entry
// already substituted). Node transport and the live model list unless a test says otherwise.
function provider(opts) {
  const o = opts || {};
  const options = Object.assign({ baseURL: emisBase, apiKey: KEY }, o.options);
  const config = Object.assign({ npm: '@ai-sdk/openai-compatible', name: 'AI gateway', options }, o.config);
  const env = Object.assign({ EMIS_TRANSPORT: 'node', EMIS_MODELS_FILE: 'none' }, o.env);
  const p = P.createProvider({ id: o.id || 'emis', config, env, log, shared: { REPO_DIR: tmp } });
  return p;
}
async function withProvider(opts, fn) {
  const p = provider(opts);
  try { return await fn(p); } finally { await p.close(); }
}
// The model's entry as the provider lists it (or as the service would make it, when the list can't be had)
const entryFor = async (p, model) => (await p.models().catch(() => [])).find(m => m.model === model) || { id: p.id + '/' + model, provider: p.id, model, variants: [], protocol: 'chat' };
const body = (entry, extra) => O.validateChatBody(Object.assign({ model: entry.id, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }, extra));

// A non-streamed answer (what the service's route makes of the events)
async function ask(p, model, extra, run) {
  const entry = await entryFor(p, model);
  return O.toChatCompletion(p.chat(body(entry, extra), entry, Object.assign({ timeoutMs: 10000, stream: false }, run)), { model: entry.id });
}
// What a request failed with (always a ServiceError, before any event)
async function failure(p, model, extra, run) {
  const entry = await entryFor(p, model);
  const events = [];
  try {
    for await (const e of p.chat(body(entry, extra), entry, Object.assign({ timeoutMs: 10000, stream: false }, run))) events.push(e);
  } catch (err) {
    assert.ok(E.isServiceError(err), 'a ServiceError: ' + (err && err.stack));
    assert.deepEqual(events, [], 'thrown before the first event');
    assert.ok(err.message.length <= 400, 'short enough: ' + err.message);
    assert.ok(!ALL_KEYS.some(k => err.message.includes(k)) && !/Bearer \w/.test(err.message), 'no key in the message');
    assert.equal(err.provider, p.id);
    return err;
  }
  return assert.fail('the request should have failed (' + model + ')');
}
const key0 = p => p.status().keys[0];

test.before(async () => {
  P = await import('../opencode/providers/openai-compatible.mjs');
  O = await import('../opencode/openai.mjs');
  E = await import('../opencode/errors.mjs');
  emis = await startEmis();
  emisBase = 'http://127.0.0.1:' + emis.port + '/v1';
});
test.after(async () => {
  if (emis) await emis.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  // nothing secret reached the log
  const text = JSON.stringify(logged);
  assert.ok(!ALL_KEYS.some(k => text.includes(k)), 'no key in the log');
});

// ── Config and keys ───────────────────────────────────────────────────────────

test('settings: no key → not ready (says to add EMIS_API_KEY); the .env.example placeholder isn\'t a key; a key that doesn\'t look like the gateway\'s is used with a warning', async () => {
  await withProvider({ options: { apiKey: '' } }, async p => {
    const st = p.status();
    assert.equal(st.ready, false);
    assert.equal(st.kind, 'openai-compatible');
    assert.match(st.problem, /EMIS_API_KEY.*Reload \.env/);
    const err = await failure(p, 'other-1');
    assert.equal(err.type, 'not_configured');
    assert.equal(err.status, 503);
    assert.deepEqual(state.calls.filter(m => m === 'other-1'), [], 'nothing was sent');
  });
  await withProvider({ options: { apiKey: 'your-key' } }, async p => {
    const st = p.status();
    assert.equal(st.ready, false, 'not "AI ready" with a key that would be refused');
    assert.ok(st.warnings.some(w => /EMIS_API_KEY entry 1 is still the placeholder/.test(w)), JSON.stringify(st.warnings));
  });
  // the gateway's own address (settings only: nothing is sent there): a key without "emis-" gets a warning
  let st = P.loadSettings('emis', { options: { baseURL: '', apiKey: 'sk-0123456789abcdef0123' } }, {});
  assert.equal(st.problem, null);
  assert.equal(st.baseUrl, P.EMIS_DEFAULT_BASE_URL, 'an empty baseURL = the default address');
  assert.ok(st.warnings.some(w => /doesn't start with "emis-"/.test(w)), JSON.stringify(st.warnings));
  await withProvider({ options: { apiKey: 'sk-0123456789abcdef0123' } }, async p => {
    const s = p.status();
    assert.equal(s.ready, true);
    assert.equal(s.baseHost, '127.0.0.1:' + emis.port);
    assert.ok(!s.warnings.some(w => /emis-/.test(w)), 'another address may have other keys');
    assert.ok(!JSON.stringify(s).includes('sk-0123456789abcdef0123'), 'the key itself is never shown');
    assert.equal(s.keys[0].masked, '…0123');
  });
  await withProvider({ options: { apiKey: ' ' + KEY + ' ,\u200B' + KEY2 + ', ' + KEY + ',bad key…,é-key-0123456789' } }, async p => {
    const st = p.status();
    assert.equal(st.keyCount, 2, 'spaces and zero-width characters stripped, duplicates dropped');
    assert.ok(!st.warnings.some(w => /emis-/.test(w)), 'no warning for real-looking keys');
    assert.ok(st.warnings.some(w => /entry 4 is still the placeholder/.test(w)));
    assert.ok(st.warnings.some(w => /entry 5 contains characters that cannot be sent/.test(w)));
    assert.ok(!JSON.stringify(st).includes(KEY), 'the key itself is never shown');
  });
  // the address: http(s) only, no credentials, /v1 and plain-http warnings
  for (const bad of ['ftp://example.com/v1', 'https://user:pw@example.com/v1', 'not a url']) {
    const bst = P.loadSettings('emis', { options: { baseURL: bad, apiKey: KEY } }, {});
    assert.match(bst.problem, /EMIS_BASE_URL in the server's \.env file is not a valid http\(s\) URL/, bad);
  }
  st = P.loadSettings('emis', { options: { baseURL: 'http://gateway.example/api/?x=1#y', apiKey: KEY } }, {});
  assert.equal(st.baseUrl, 'http://gateway.example/api', 'query, hash and the trailing / are dropped');
  assert.ok(st.warnings.some(w => /normally ends in \/v1/.test(w)) && st.warnings.some(w => /plain http/.test(w)));
  st = P.loadSettings('emis', { options: { apiKey: KEY } }, { EMIS_BASE_URL: emisBase, EMIS_TRANSPORT: 'carrier-pigeon', EMIS_PROXY: 'socks5://x' });
  assert.equal(st.baseUrl, emisBase, 'EMIS_BASE_URL when the config doesn\'t set baseURL');
  assert.equal(st.transport, 'auto');
  assert.ok(st.warnings.some(w => /EMIS_TRANSPORT must be auto, python or node/.test(w)));
  assert.match(st.problem, /EMIS_PROXY .* isn't an http\(s\) URL/);
  // another OpenAI-compatible provider: its own setting names, Node.js, no emis- warning, no default address
  st = P.loadSettings('acme', { options: { apiKey: 'sk-acme-0123456789abcdef' } }, { EMIS_TRANSPORT: 'python', EMIS_BASE_URL: emisBase });
  assert.match(st.problem, /provider\.acme\.options\.baseURL isn't set/);
  st = P.loadSettings('acme', { options: { baseURL: 'https://api.acme.example', apiKey: 'sk-acme-0123456789abcdef' } }, { EMIS_TRANSPORT: 'python', EMIS_PROXY: 'http://127.0.0.1:9' });
  assert.equal(st.problem, null);
  assert.equal(st.transport, 'node');
  assert.equal(st.proxy, 'env', 'EMIS_PROXY is the gateway\'s only');
  assert.deepEqual(st.warnings, []);
});

test('a key with a prompt budget only (its token budget reported as 0 of 0) isn\'t treated as used up; the quota shows in the status', async () => {
  await withProvider({}, async p => {
    state.calls.length = 0;
    const done = await ask(p, 'prompts-only');
    assert.equal(done.choices[0].message.content, 'ok');
    const k = key0(p);
    assert.equal(k.status, 'available');
    assert.equal(k.requestCount, 1);
    assert.deepEqual([k.quota.window, k.quota.limitPrompts, k.quota.remainingPrompts, k.quota.limitTokens, k.quota.remainingTokens], ['week', 100, 99, 0, 0]);
    assert.ok(Date.parse(k.quota.resetAt) > Date.now() && Date.parse(k.quota.updatedAt) <= Date.now());
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1', 'the next request goes out');
    assert.deepEqual(state.calls, ['prompts-only', 'other-1']);
    // quota headers of a streamed answer are read too
    state.remaining = 42;
    const entry = await entryFor(p, 'other-1');
    for await (const e of p.chat(body(entry, { stream: true }), entry, { stream: true, timeoutMs: 10000 })) void e;
    assert.equal(key0(p).quota.remainingPrompts, 42);
    state.remaining = 100;
    assert.equal(p.status().resting, null);
  });
});

test('a 429 that says the budget is spent rests the key until the reset, even if the headers still show some left; then every model waits, without calling the gateway', async () => {
  await withProvider({}, async p => {
    state.calls.length = 0;
    const err = await failure(p, 'budget-said');
    assert.equal(err.status, 429);
    assert.equal(err.type, 'quota_exceeded');
    assert.equal(err.scope, 'provider');
    assert.equal(err.window, 'day');
    assert.match(err.message, /quota for this day is used up\. It resets in /);
    assert.ok(err.retryAfterSeconds > 3500 && err.retryAfterSeconds <= 3600, String(err.retryAfterSeconds));
    assert.ok(Math.abs(Date.parse(err.resetAt) - (Date.now() + 3600 * 1000)) < 5000);
    assert.equal(err.toBody().error.reset_at, err.resetAt);
    assert.deepEqual(state.calls, ['budget-said']);
    assert.equal(key0(p).status, 'cooling_down');
    assert.ok(key0(p).cooldownSecondsLeft > 3500);
    assert.deepEqual(p.status().resting && [p.status().resting.reason, p.status().resting.window], ['quota', 'day']);
    state.calls.length = 0;
    const again = await failure(p, 'other-1');
    assert.equal(again.type, 'quota_exceeded', 'every model waits for the reset');
    assert.deepEqual(state.calls, [], 'without calling the gateway');
    // Reload .env forgets the rest
    await p.reload();
    assert.equal(key0(p).status, 'available');
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1');
  });
});

test('a 429 for one model whose provider says "exhausted … quota" while the key has budget left: that model is rate-limited (scope model), not the key', async () => {
  await withProvider({}, async p => {
    state.calls.length = 0;
    const err = await failure(p, 'gemini-3.8-flash');
    assert.equal(err.status, 429);
    assert.equal(err.type, 'rate_limited');
    assert.equal(err.scope, 'model', 'MetaCode rests the model and answers with the closest one');
    assert.equal(err.model, 'emis/gemini-3.8-flash');
    assert.deepEqual(state.calls, ['gemini-3.8-flash'], 'tried once');
    assert.equal(key0(p).status, 'available');
    assert.equal(key0(p).quota.remainingPrompts, 950, 'the quota headers of an error are read');
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1', 'other models aren\'t held up');
    // Retry-After is passed on
    const limited = await failure(p, 'limited-model');
    assert.deepEqual([limited.type, limited.scope, limited.retryAfterSeconds], ['rate_limited', 'model', 20]);
    assert.equal(limited.toBody().error.retry_after_seconds, 20);
    assert.deepEqual(limited.toHeaders(), { 'Retry-After': '20' });
    assert.match(limited.message, /emis\/limited-model/);
    assert.equal(key0(p).status, 'available');
  });
});

test('a used-up key budget rests the key (scope provider, no other model tried); 429s on three models without quota headers pause the key', async () => {
  await withProvider({}, async p => {
    state.calls.length = 0;
    let err = await failure(p, 'budget-model');
    assert.deepEqual([err.status, err.type, err.scope, err.window], [429, 'quota_exceeded', 'provider', 'day']);
    assert.match(err.message, /Your AI usage quota for this day is used up\. It resets in \d+ seconds?/);
    assert.equal(key0(p).status, 'cooling_down');
    await sleep(2300);                                      // the budget window resets
    assert.equal(key0(p).status, 'available');
    // busy-a → busy-b → busy-c all refused without quota headers: it's the key being paused
    state.calls.length = 0;
    err = await failure(p, 'busy-a');
    assert.deepEqual([err.type, err.scope, err.retryAfterSeconds], ['rate_limited', 'model', 1]);
    err = await failure(p, 'busy-b');
    assert.deepEqual([err.type, err.scope], ['rate_limited', 'model']);
    err = await failure(p, 'busy-c');
    assert.deepEqual([err.status, err.type, err.scope], [429, 'rate_limited', 'provider'], 'the key is paused: the provider asked to pause');
    assert.match(err.message, /AI gateway asked MetaCode to pause\. Try again in \d+ seconds?/);
    assert.equal(err.retryAfterSeconds, 1);
    assert.deepEqual(state.calls, ['busy-a', 'busy-b', 'busy-c']);
    assert.equal(p.status().resting.reason, 'paused');
    assert.equal((await failure(p, 'other-1')).type, 'rate_limited', 'while it rests, nothing is sent');
    assert.deepEqual(state.calls, ['busy-a', 'busy-b', 'busy-c']);
    await sleep(1300);                                      // Retry-After: 1
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1', 'the key is back');
  });
});

test('several keys: a spent key rests and the next key answers the same request; a rejected key (401) is tried last; all keys resting → quota_exceeded without an upstream call', async () => {
  await withProvider({ options: { apiKey: [SPENT_KEY, KEY].join(',') } }, async p => {
    state.seen.length = 0;
    const done = await ask(p, 'other-1');
    assert.equal(done.choices[0].message.content, 'ok from other-1');
    assert.deepEqual(state.seen.map(s => s.key), [SPENT_KEY, KEY], 'one try per key, in rotation');
    const keys = p.status().keys;
    assert.deepEqual(keys.map(k => k.status), ['cooling_down', 'available']);
    assert.equal(keys[0].quota.remainingPrompts, 0);
    state.seen.length = 0;
    await ask(p, 'other-1');
    assert.deepEqual(state.seen.map(s => s.key), [KEY], 'the resting key isn\'t tried');
  });
  await withProvider({ options: { apiKey: [BAD_KEY, KEY2].join(',') } }, async p => {
    await p.models();
    state.seen.length = 0;
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1');
    assert.deepEqual(state.seen.map(s => s.key), [BAD_KEY, KEY2], '401: the next key, same request');
    assert.deepEqual(p.status().keys.map(k => [k.status, k.requestCount]), [['invalid', 0], ['available', 1]]);
    assert.ok(logged.some(([level, event, f]) => level === 'error' && event === 'key.rejected' && f.key === 'key 1/2' && f.status === 401));
    // the rotation starts with each key in turn, but the rejected one goes last
    for (let i = 0; i < 2; i++) {
      state.seen.length = 0;
      await ask(p, 'other-1');
      assert.deepEqual(state.seen.map(s => s.key), [KEY2]);
    }
  });
  await withProvider({ options: { apiKey: [BAD_KEY].join(',') } }, async p => {
    const err = await failure(p, 'other-1');
    assert.deepEqual([err.status, err.type], [401, 'authentication_error']);
    assert.match(err.message, /AI gateway didn't accept the key in EMIS_API_KEY \("Invalid API key"\)\. Check EMIS_API_KEY in the server's \.env file, then click Reload \.env in Settings\./);
  });
  await withProvider({ options: { apiKey: [SPENT_KEY, 'emis-another-spent-key-22222222'].join(',') } }, async p => {
    // (the stand-in only knows one spent key: spend the other through budget-model)
    state.seen.length = 0;
    let err = await failure(p, 'budget-model');
    assert.equal(err.type, 'quota_exceeded');
    assert.equal(state.seen.length, 2, 'both keys tried once');
    assert.match(err.message, /Every configured AI key has used up its usage quota\. The first one resets in /);
    state.seen.length = 0;
    err = await failure(p, 'other-1');
    assert.deepEqual([err.type, err.scope], ['quota_exceeded', 'provider']);
    assert.deepEqual(state.seen, [], 'no upstream call');
  });
});

test('a 403 for a model shows the gateway\'s reason and keeps the key; a 403 web page is "blocked" (a wrong address or a proxy, not a rejected key — and nobody is told to install Python)', async () => {
  await withProvider({ options: { apiKey: [KEY, KEY2].join(',') } }, async p => {
    state.seen.length = 0;
    let err = await failure(p, 'forbidden-model');
    assert.deepEqual([err.status, err.type], [403, 'permission_error']);
    assert.match(err.message, /this key may not use forbidden-model/);
    assert.match(err.message, /Settings → AI models/);
    assert.equal(state.seen.length, 1, 'not tried with the other key: the model, not the key');
    assert.deepEqual(p.status().keys.map(k => k.status), ['available', 'available']);
    err = await failure(p, 'blocked-model');
    assert.deepEqual([err.status, err.type], [403, 'blocked']);
    assert.match(err.message, /web page answered \(HTTP 403\)/);
    assert.match(err.message, /EMIS_BASE_URL/);
    assert.doesNotMatch(err.message, /Python|pip install/);
    assert.deepEqual(p.status().keys.map(k => k.status), ['available', 'available'], 'no key marked as rejected');
    err = await failure(p, 'missing-model');
    assert.deepEqual([err.status, err.type], [404, 'model_not_found']);
    assert.match(err.message, /doesn't offer the model "emis\/missing-model"/);
    err = await failure(p, 'error200-model');
    assert.equal(err.status, 502);
    assert.match(err.message, /quota for this model is disabled/);
    // a redirect isn't followed (the key only goes to the configured address)
    err = await failure(p, 'redirect-model');
    assert.deepEqual([err.status, err.type, err.code, err.upstreamStatus], [502, 'malformed_response', 'redirect', 302]);
    assert.match(err.message, /answered with a redirect \(HTTP 302\) instead of a result\. Check EMIS_BASE_URL/);
    assert.equal(state.seen.filter(s => s.body.model === 'redirect-model').length, 1);
  });
});

test('the models list: a web page instead of the API names EMIS_BASE_URL; the key isn\'t rejected for it', async () => {
  await withProvider({}, async p => {
    try {
      state.modelsMode = 'webpage403';
      let err = await p.models({ refresh: true }).then(() => null, e => e);
      assert.ok(E.isServiceError(err));
      assert.equal(err.type, 'blocked');
      assert.match(err.message, /web page answered \(HTTP 403\)/);
      assert.match(err.message, /EMIS_BASE_URL/);
      assert.doesNotMatch(err.message, /Python|pip install/);
      assert.notEqual(key0(p).status, 'invalid', 'the key isn\'t marked as rejected');
      state.modelsMode = 'webpage200';
      err = await p.models({ refresh: true }).then(() => null, e => e);
      assert.equal(err.type, 'malformed_response');
      assert.match(err.message, /it sent a web page.*EMIS_BASE_URL is the API address ending in \/v1/);
    } finally { state.modelsMode = 'ok'; }
    // a rejected key (401) on the list: the next key is used, the rejected one shows as invalid
  });
  await withProvider({ options: { apiKey: [LIST_BAD_KEY, KEY].join(',') } }, async p => {
    const list = await p.models({ refresh: true });
    assert.ok(list.length > 5);
    assert.deepEqual(p.status().keys.map(k => k.status), ['invalid', 'available']);
  });
});

test('a picture in an answer is marked, not dropped without a trace; an answer that is only a picture isn\'t "empty"', async () => {
  await withProvider({}, async p => {
    assert.equal((await ask(p, 'picture')).choices[0].message.content, 'Here is your cat: [image omitted]');
    assert.equal((await ask(p, 'picture-only')).choices[0].message.content, '[image omitted]');
  });
});

test('answers in plain JSON or SSE, asked for streamed or not; an unknown finish_reason is a stop; non-ASCII text survives', async () => {
  await withProvider({}, async p => {
    // plain JSON to a streamed request, SSE to a non-streamed one
    let done = await ask(p, 'json-model');
    assert.equal(done.choices[0].message.content, 'plain JSON from json-model');
    assert.deepEqual(done.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    const entry = await entryFor(p, 'json-model');
    const chunks = [];
    for await (const c of O.toChunks(p.chat(body(entry, { stream: true }), entry, { stream: true, timeoutMs: 10000 }), { model: entry.id, includeUsage: true })) chunks.push(c);
    assert.equal(chunks.map(c => (c.choices[0] && c.choices[0].delta.content) || '').join(''), 'plain JSON from json-model');
    assert.equal(chunks[chunks.length - 1].usage.total_tokens, 8);
    done = await ask(p, 'sse-model');
    assert.equal(done.choices[0].message.content, 'ok from sse');
    done = await ask(p, 'eos-model');
    assert.deepEqual([done.choices[0].message.content, done.choices[0].finish_reason], ['ended oddly', 'stop']);
    // EMIS's quirks: a stream without finish_reason, a model that only streams, an empty 200 unless
    // streamed (and asked for with Accept: text/event-stream) — every call is a streamed one upstream
    for (const [model, text] of [['streams-unless-told', 'streamed by default'], ['stream-only-model', 'ok via stream'], ['empty-unless-stream', 'ok streamed']]) {
      done = await ask(p, model);
      assert.deepEqual([done.choices[0].message.content, done.choices[0].finish_reason], [text, 'stop'], model);
    }
    // a reasoning model that used its whole budget thinking: finish_reason length (MetaCode asks again with more)
    done = await ask(p, 'think-model', { max_tokens: 100 });
    assert.deepEqual([done.choices[0].message.content, done.choices[0].message.reasoning_content, done.choices[0].finish_reason], ['', 'thinking…', 'length']);
    assert.equal((await ask(p, 'think-model', { max_tokens: 1024 })).choices[0].message.content, 'ok from think-model');
    done = await ask(p, 'unicode-model', { messages: [{ role: 'user', content: 'Grüße → “quotes” …' }] });
    assert.equal(done.choices[0].message.content, 'ok → café … 你好 — Grüße → “quotes” …');
    assert.equal(done.model, 'emis/unicode-model');
  });
});

test('the request reaching the gateway: the client\'s messages exactly as sent, max_tokens, reasoning_effort, tools; Authorization with the key; nothing of the service\'s own', async () => {
  await withProvider({ options: { headers: { 'X-Team': 'metacode', Authorization: 'Bearer nope' } } }, async p => {
    const messages = [
      { role: 'developer', content: 'Answer briefly.' },
      { role: 'system', content: 'You code posts.', name: 'policy' },
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }], name: 'ann' }
    ];
    state.seen.length = 0;
    await ask(p, 'other-1', {
      messages, max_tokens: 33, temperature: 0.2, reasoning_effort: 'low', stop: ['END'],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }], tool_choice: 'auto',
      response_format: { type: 'json_object' }
    });
    const sent = state.seen[0];
    assert.deepEqual(sent.body.messages, messages, 'developer role, names and image detail unchanged');
    assert.equal(sent.body.model, 'other-1', 'the gateway gets its own model id');
    assert.equal(sent.body.max_tokens, 33);
    assert.equal(sent.body.temperature, 0.2);
    assert.equal(sent.body.reasoning_effort, 'low');
    assert.deepEqual(sent.body.stop, ['END']);
    assert.equal(sent.body.tools[0].function.name, 'lookup');
    assert.equal(sent.body.tool_choice, 'auto');
    assert.deepEqual(sent.body.response_format, { type: 'json_object' });
    assert.equal(sent.body.stream, true);
    assert.equal(sent.headers.authorization, 'Bearer ' + KEY);
    assert.equal(sent.headers['x-team'], 'metacode', 'the config\'s headers');
    assert.match(sent.headers.accept, /text\/event-stream/);
    for (const h of ['x-oc-trace', 'x-oc-transport', 'traceparent', 'b3']) assert.equal(sent.headers[h], undefined, h);
    assert.ok(p.status().warnings.some(w => /"Authorization" .* can't be sent/.test(w)));
  });
});

test('streamed calls go through Node.js (even with Python available), arrive as they come, and can be cancelled', async () => {
  await withProvider({ env: { EMIS_TRANSPORT: 'auto' } }, async p => {
    const entry = await entryFor(p, 'other-1');
    state.seen.length = 0;
    const t0 = Date.now();
    const times = [];
    let text = '';
    for await (const e of p.chat(body(entry, { stream: true }), entry, { stream: true, timeoutMs: 10000 })) {
      if (e.type === 'text-delta') { times.push(Date.now() - t0); text += e.text; }
    }
    assert.equal(text, 'ok from other-1');
    assert.ok(times[times.length - 1] - times[0] >= 150, 'incremental: ' + times.join(', '));
    assert.doesNotMatch(String(state.seen[0].headers['user-agent']), /Python/);
    // the caller goes away: the upstream request is cancelled
    state.cutShort = 0;
    const ac = new AbortController();
    const err = await (async () => {
      try {
        for await (const e of p.chat(body(entry, { stream: true }), entry, { stream: true, timeoutMs: 10000, signal: ac.signal })) { if (e.type === 'text-delta') ac.abort(); }
      } catch (e) { return e; }
      return null;
    })();
    assert.equal(err && err.type, 'cancelled');
    assert.equal(err.status, 499);
    await sleep(100);
    assert.equal(state.cutShort, 1, 'the gateway saw the request end');
    // a reader that stops early cancels it too (no error)
    for await (const e of p.chat(body(entry, { stream: true }), entry, { stream: true, timeoutMs: 10000 })) { if (e.type === 'text-delta') break; }
    await sleep(100);
    assert.equal(state.cutShort, 2);
  });
});

test('timeouts: the gateway not answering within timeoutMs is a timeout (504), through Node.js and through Python — tried once', { timeout: 30000 }, async () => {
  await withProvider({}, async p => {
    state.calls.length = 0;
    const t0 = Date.now();
    const err = await failure(p, 'slow', {}, { timeoutMs: 500 });
    assert.deepEqual([err.status, err.type], [504, 'timeout']);
    assert.ok(Date.now() - t0 < 1400, 'didn\'t wait for the answer');
    assert.match(err.message, /AI_TIMEOUT_MS/);
    assert.deepEqual(state.calls, ['slow']);
  });
  if (!python) return;
  for (const transport of ['auto', 'python']) {
    await withProvider({ env: { EMIS_TRANSPORT: transport } }, async p => {
      await p.models();
      state.calls.length = 0;
      const err = await failure(p, 'slow', {}, { timeoutMs: 600 });
      assert.deepEqual([err.status, err.type], [504, 'timeout'], transport);
      assert.deepEqual(state.calls, ['slow'], transport + ': not sent again from Node.js');
      // and a cancelled request through Python
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const gone = await failure(p, 'slow', {}, { signal: ac.signal });
      assert.equal(gone.type, 'cancelled', transport);
    });
  }
});

// ── The /v1 fix, the proxy, the Python transport ──────────────────────────────

test('a base URL without /v1 (the website answers) is corrected automatically, with a warning — for the model list and for chats', async () => {
  const fixedWarning = p => p.status().warnings.some(w => /EMIS_BASE_URL should end in \/v1; the AI service is using .*\/v1 until you change it/.test(w));
  await withProvider({ options: { baseURL: emisBase.replace(/\/v1$/, '') } }, async p => {
    assert.ok(p.status().warnings.some(w => /normally ends in \/v1/.test(w)));
    assert.ok((await p.models()).length > 5, 'the list came from …/v1/models');
    assert.ok(fixedWarning(p), JSON.stringify(p.status().warnings));
    state.seen.length = 0;
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1');
    assert.deepEqual(state.seen.map(s => s.url), ['/v1/chat/completions'], 'kept');
  });
  // the website has no …/models page: the first chat finds the API address
  state.websiteListNotFound = true;
  const file = path.join(tmp, 'v1-models.json');
  fs.writeFileSync(file, JSON.stringify({ provider: { emis: { models: { 'other-1': { name: 'Other 1' } } } } }));
  try {
    await withProvider({ options: { baseURL: emisBase.replace(/\/v1$/, '') }, env: { EMIS_MODELS_FILE: file } }, async p => {
      assert.equal((await p.models())[0].available, null, 'the list couldn\'t be had');
      assert.ok(!fixedWarning(p));
      state.seen.length = 0;
      const done = await ask(p, 'other-1');
      assert.equal(done.choices[0].message.content, 'ok from other-1');
      assert.deepEqual(state.seen.map(s => s.url), ['/v1/chat/completions'], 'the website answered the first try (not a chat call)');
      assert.ok(fixedWarning(p), JSON.stringify(p.status().warnings));
      state.seen.length = 0;
      await ask(p, 'other-1');
      assert.deepEqual(state.seen.map(s => s.url), ['/v1/chat/completions'], 'kept');
      assert.equal(p.status().baseHost, '127.0.0.1:' + emis.port);
    });
  } finally { state.websiteListNotFound = false; }
});

test('EMIS_PROXY: requests go through it (Node.js and Python)', async t => {
  let proxied = 0;
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
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  try {
    await withProvider({ env: { EMIS_PROXY: proxyUrl } }, async p => {
      assert.equal(p.status().proxy, '127.0.0.1:' + proxy.address().port);
      proxied = 0;
      assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1');
      assert.ok(proxied >= 1, 'the request went through the proxy');
    });
    await t.test('through Python', { skip: !python && 'no Python' }, async () => {
      await withProvider({ env: { EMIS_PROXY: proxyUrl, EMIS_TRANSPORT: 'python' } }, async p => {
        proxied = 0;
        state.seen.length = 0;
        assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1');
        assert.ok(proxied >= 1, 'the Python request went through the proxy');
        assert.match(String(state.seen[0].headers['user-agent']), /Python/);
      });
    });
    // without EMIS_PROXY: HTTPS_PROXY / HTTP_PROXY with NO_PROXY from the service's environment
    await withProvider({ env: { HTTP_PROXY: proxyUrl, NO_PROXY: 'example.invalid' } }, async p => {
      proxied = 0;
      await ask(p, 'other-1');
      assert.ok(proxied >= 1, 'HTTP_PROXY used');
    });
    await withProvider({ env: { HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1' } }, async p => {
      proxied = 0;
      await ask(p, 'other-1');
      await p.models({ refresh: true });
      assert.equal(proxied, 0, 'NO_PROXY honoured');
    });
  } finally {
    proxy.closeAllConnections();
    await new Promise(r => proxy.close(r));
  }
});

test('the Python transport: non-streamed requests go through python/emis_fetch.py (its User-Agent); auto falls back to Node.js without Python; python mode says Python is missing', { skip: !python && 'no Python', timeout: 60000 }, async () => {
  await withProvider({ env: { EMIS_TRANSPORT: 'auto' }, options: { headers: { 'X-Team': 'metacode' } } }, async p => {
    state.seen.length = 0;
    const done = await ask(p, 'other-1');
    assert.equal(done.choices[0].message.content, 'ok from other-1');
    assert.deepEqual(done.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, 'the buffered stream: usage too');
    const sent = state.seen[0];
    assert.match(String(sent.headers['user-agent']), /^MetaCode\/1\.0 \(OpenAI-compatible client; Python 3|^OpenAI\/Python/, 'sent from Python');
    assert.equal(sent.headers['x-team'], 'metacode', 'the config\'s headers, from Python too');
    assert.equal(sent.headers.authorization, 'Bearer ' + KEY);
    assert.equal(sent.body.stream, true, 'the request is streamed, the answer read whole');
    assert.match(sent.headers.accept, /event-stream/);
    assert.equal(sent.headers['x-oc-transport'], undefined);
    assert.match(p.status().transport, /^Python 3\.\d+(\.\d+)? \((openai|httpx|urllib)/);
    // its answers are read like any other: quota headers, a 429 for the budget, a 403
    assert.equal(key0(p).quota.remainingPrompts, 100);
    assert.equal((await failure(p, 'forbidden-model')).type, 'permission_error');
    assert.equal((await failure(p, 'blocked-model')).type, 'blocked');
    assert.equal((await failure(p, 'redirect-model')).code, 'redirect', 'Python doesn\'t follow redirects either');
    assert.equal((await failure(p, 'missing-model')).type, 'model_not_found');
    assert.equal((await ask(p, 'picture')).choices[0].message.content, 'Here is your cat: [image omitted]');
    // the model list goes through it too (first, the refresh the missing model started in the background
    // finishes: a forced refresh joins one already under way)
    await p.models({ refresh: true });
    state.listCalls = 0;
    assert.ok((await p.models({ refresh: true })).length > 5);
    assert.equal(state.listCalls, 1);
  });
  // No Python on PATH (and no EMIS_PYTHON): auto uses Node.js, python mode fails clearly
  const noPython = { PATH: path.join(tmp, 'empty-bin'), EMIS_PYTHON: '', SCRAPER_PYTHON: '' };
  await withProvider({ env: Object.assign({ EMIS_TRANSPORT: 'auto' }, noPython) }, async p => {
    state.seen.length = 0;
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1');
    assert.doesNotMatch(String(state.seen[state.seen.length - 1].headers['user-agent']), /Python/);
    assert.equal(p.status().transport, 'Node.js (Python not found)');
  });
  await withProvider({ env: Object.assign({ EMIS_TRANSPORT: 'python' }, noPython) }, async p => {
    const listErr = await p.models().then(() => null, e => e);
    assert.deepEqual([listErr && listErr.type, listErr && listErr.code], ['network', 'NO_PYTHON'], 'the model list says so too');
    const err = await failure(p, 'other-1');
    assert.deepEqual([err.status, err.type, err.code], [502, 'network', 'NO_PYTHON']);
    assert.match(err.message, /EMIS_TRANSPORT is python, but Python wasn't found/);
    assert.match(p.status().transport, /^Python — not available: /);
  });
  await withProvider({ env: { EMIS_TRANSPORT: 'node' } }, async p => assert.equal(p.status().transport, 'Node.js'));
});

test('Reload .env while a request is with the Python worker: it is answered, not sent to the gateway a second time', { skip: !python && 'no Python', timeout: 30000 }, async () => {
  await withProvider({ env: { EMIS_TRANSPORT: 'python' } }, async p => {
    await p.models();                            // (the worker is running)
    state.calls.length = 0;
    const pending = ask(p, 'slow');
    await sleep(600);
    const st = await p.reload({ EMIS_TRANSPORT: 'python', EMIS_MODELS_FILE: 'none' });
    assert.match(st.transport, /^Python /, 'the new worker is already running');
    const done = await pending;
    assert.equal(done.choices[0].message.content, 'ok, slowly');
    assert.deepEqual(state.calls, ['slow'], 'one call');
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1', 'the new worker answers');
  });
});

// ── Models ────────────────────────────────────────────────────────────────────

test('the live model list (no models file): the gateway\'s order, image/embedding models left out, cached, single-flight, whitelist/blacklist', async () => {
  await withProvider({ config: { blacklist: ['other-1'] } }, async p => {
    state.listCalls = 0;
    const [a, b] = await Promise.all([p.models({ refresh: true }), p.models()]);
    assert.equal(state.listCalls, 1, 'one fetch for both');
    assert.deepEqual(a.map(m => m.id), b.map(m => m.id));
    const ids = a.map(m => m.model);
    assert.deepEqual(ids, LISTED.filter(id => !/dall-e|embedding/.test(id) && id !== 'other-1'));
    const m = a.find(x => x.model === 'claude-opus-5.5');
    assert.deepEqual(m, {
      id: 'emis/claude-opus-5.5', provider: 'emis', providerName: 'AI gateway', model: 'claude-opus-5.5', name: 'claude-opus-5.5', free: false, available: true,
      toolCall: undefined, reasoning: undefined, attachment: undefined, temperature: undefined, contextWindow: undefined, maxOutput: undefined,
      variants: [], releaseDate: undefined, protocol: 'chat'
    });
    await p.models();
    assert.equal(state.listCalls, 1, 'cached');
    const st = p.status();
    assert.deepEqual([st.models.listed, st.models.available, st.models.source], [ids.length, ids.length, 'live']);
    assert.ok(Date.parse(st.models.checkedAt) <= Date.now());
    // the gateway down: the last list it sent is used meanwhile
    state.modelsMode = 'down';
    try { assert.equal((await p.models({ refresh: true })).length, ids.length); } finally { state.modelsMode = 'ok'; }
  });
  await withProvider({ config: { whitelist: ['other-1', 'slow', 'not-listed'] } }, async p => {
    assert.deepEqual((await p.models()).map(m => m.model), ['slow', 'other-1']);
  });
  await withProvider({}, async p => {
    state.modelsMode = 'down';
    try {
      const err = await p.models({ refresh: true }).then(() => null, e => e);
      assert.deepEqual([err && err.type, err && err.upstreamStatus], ['upstream_error', 503], 'no list yet: the failure');
    } finally { state.modelsMode = 'ok'; }
  });
});

test('the models file (emis-models.json, OpenCode\'s format): names, capabilities and limits, the live list for availability, re-read when it changes, merged with the config\'s models', async () => {
  const file = path.join(tmp, 'emis-models.json');
  const write = json => {
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify(json));        // (with a BOM, as some Windows editors write it)
    const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
    fs.utimesSync(file, t, t);
  };
  write({
    $schema: 'https://opencode.ai/config.json',
    provider: { emis: { npm: '@ai-sdk/openai-compatible', name: 'emis', options: { baseURL: 'https://other.example/v1', apiKey: 'emis-literal-key-in-file-0123' }, models: {
      'claude-opus-5.5': { name: 'Claude Opus 5.5', tool_call: true, reasoning: true, attachment: true, limit: { context: 200000, output: 32000 } },
      'other-1': { name: 'Other <b>One</b>', tool_call: false, attachment: false, temperature: false },
      'not-offered': { name: 'Not Offered' },
      'old-model': { name: 'Old', status: 'deprecated' },
      'bad id!': { name: 'x' }
    } } }
  });
  await withProvider({ env: { EMIS_MODELS_FILE: 'emis-models.json' }, config: { models: { 'config-only': { name: 'Config Only', tool_call: true }, 'other-1': { name: 'Other One (config)' } } } }, async p => {
    const list = await p.models();
    assert.deepEqual(list.map(m => [m.model, m.name, m.available]), [
      ['claude-opus-5.5', 'Claude Opus 5.5', true], ['other-1', 'Other One (config)', true], ['not-offered', 'Not Offered', false], ['config-only', 'Config Only', false]
    ], 'the file\'s order, then the config\'s; deprecated and bad ids left out; available = in the live list');
    const opus = list[0];
    assert.deepEqual([opus.id, opus.toolCall, opus.reasoning, opus.attachment, opus.contextWindow, opus.maxOutput, opus.protocol], ['emis/claude-opus-5.5', true, true, true, 200000, 32000, 'chat']);
    assert.deepEqual([list[1].toolCall, list[1].attachment, list[1].temperature], [false, false, false]);
    assert.equal(list[1].name, 'Other One (config)');
    const st = p.status();
    assert.deepEqual([st.models.listed, st.models.available, st.models.source], [4, 2, 'emis-models.json']);
    assert.ok(logged.some(([, e]) => e === 'models_file.literal_key'), 'a key written into the file is warned about (never read)');
    assert.ok(logged.some(([, e]) => e === 'models_file.base_url'));
    // the file's flags: refused before calling the gateway
    state.calls.length = 0;
    let err = await failure(p, 'other-1', { tools: [{ type: 'function', function: { name: 'f' } }] });
    assert.deepEqual([err.status, err.type], [400, 'unsupported_feature']);
    err = await failure(p, 'other-1', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
    assert.equal(err.type, 'unsupported_feature');
    assert.deepEqual(state.calls, []);
    // temperature: false → not sent
    state.seen.length = 0;
    await ask(p, 'other-1', { temperature: 0.5 });
    assert.equal('temperature' in state.seen[0].body, false);
    // a model the file lists that the gateway doesn't run: says so, and names the file
    err = await failure(p, 'not-offered');
    assert.equal(err.type, 'model_not_found');
    assert.match(err.message, /although it's listed in emis-models\.json/);

    // edited: picked up without a restart
    await sleep(2100);
    write({ provider: { gateway: { models: { 'model-x': { name: 'Model X' } } } } });      // the only provider: used whatever its name
    assert.deepEqual((await p.models()).map(m => m.model), ['model-x', 'config-only', 'other-1']);
    // broken: the live list instead
    await sleep(2100);
    fs.writeFileSync(file, '{ not json');
    assert.ok((await p.models()).some(m => m.model === 'claude-opus-5.5' && m.name === 'Other One (config)') === false);
    assert.equal(p.status().models.source, 'config', 'the config\'s models remain the catalog');
    assert.match(p.status().models.problem, /couldn't be read as JSON/);
  });
  // too large → the live list; without the config's models that's the catalog
  fs.writeFileSync(file, JSON.stringify({ provider: { emis: { models: { a: {} } } }, pad: 'x'.repeat(2 * 1024 * 1024) }));
  await withProvider({ env: { EMIS_MODELS_FILE: file } }, async p => {
    assert.ok((await p.models()).length > 10);
    assert.equal(p.status().models.source, 'live');
    assert.match(p.status().models.problem, /too large/);
  });
  // a file without the provider's section
  fs.writeFileSync(file, JSON.stringify({ provider: { a: { models: { x: {} } }, b: { models: { y: {} } } } }));
  await withProvider({ env: { EMIS_MODELS_FILE: file } }, async p => {
    await p.models();
    assert.match(p.status().models.problem, /has no provider\.emis\.models section/);
  });
  // options.models_file (relative to the repository) wins over EMIS_MODELS_FILE
  write({ provider: { emis: { models: { 'other-1': { name: 'From options' } } } } });
  await withProvider({ options: { models_file: 'emis-models.json' }, env: { EMIS_MODELS_FILE: 'none' } }, async p => {
    assert.deepEqual((await p.models()).map(m => m.name), ['From options']);
  });
  assert.equal(P.parseModelsFile({}, 'emis', 'x.json').problem, 'x.json has no provider.emis.models section.');
  assert.equal(P.parseModelsFile({ provider: { emis: { models: { 'bad id': {} } } } }, 'emis', 'x.json').problem, 'x.json lists no usable models.');
});

test('availability before the first live list: models() waits a little for it; without a key nothing is fetched', async () => {
  await withProvider({ options: { apiKey: '' } }, async p => {
    state.listCalls = 0;
    await sleep(50);
    assert.equal(state.listCalls, 0, 'no key: no requests');
    assert.deepEqual(await p.models(), [], 'not set up: no models');
    assert.deepEqual(p.status().models, { listed: 0, available: null, source: 'live', checkedAt: null });
  });
});

test('quota header parsing and budget rules', () => {
  const h = new Headers({ 'X-RateLimit-Window': 'Week', 'X-RateLimit-Limit-Prompts': '100', 'X-RateLimit-Remaining-Prompts': '0', 'X-RateLimit-Reset': String(1893456000 * 1000) });
  assert.deepEqual(P.readQuotaHeaders(h), { window: 'week', limitPrompts: 100, limitTokens: null, remainingPrompts: 0, remainingTokens: null, resetAt: 1893456000 * 1000 }, 'milliseconds tolerated');
  assert.equal(P.readQuotaHeaders({ 'x-ratelimit-window': 'fortnight' }), null, 'nothing usable: null');
  assert.equal(P.readQuotaHeaders({ 'content-type': 'x' }), null);
  assert.equal(P.budgetUsedUp({ remainingPrompts: 0, limitPrompts: 100, remainingTokens: null, limitTokens: null }), true);
  assert.equal(P.budgetUsedUp({ remainingPrompts: 99, limitPrompts: 100, remainingTokens: 0, limitTokens: 0 }), false, '0 of 0 = no budget of that kind');
  for (const m of ['Token budget exceeded for this window', 'You have exhausted your budget', 'budget used up']) assert.match(m, P.BUDGET_MESSAGE);
  for (const m of ['Resource has been exhausted (e.g. check quota).', 'Rate limit exceeded', 'quota exceeded']) assert.doesNotMatch(m, P.BUDGET_MESSAGE);
});

test('through the service (startService), when it is there: models listed with provider prefix, a chat answered by the gateway', async t => {
  const serverFile = path.join(__dirname, '..', 'opencode', 'server.mjs');
  if (!fs.existsSync(serverFile)) return t.skip('opencode/server.mjs isn\'t there yet');
  const S = await import('../opencode/server.mjs');
  if (typeof S.startService !== 'function') return t.skip('no startService');
  const dataDir = path.join(tmp, 'service-data');
  const token = 'test-service-token-0123456789';
  const env = {
    OPENCODE_SERVICE_HOST: '127.0.0.1', OPENCODE_SERVICE_PORT: '0', OPENCODE_SERVICE_TOKEN: token, OPENCODE_SERVICE_DATA_DIR: dataDir,
    OPENCODE_DISABLED_PROVIDERS: 'opencode', OPENCODE_DISABLE_MODELS_FETCH: '1', METACODE_ENV_FILE: 'none', METACODE_LOG: 'off',
    EMIS_BASE_URL: emisBase, EMIS_API_KEY: KEY, EMIS_TRANSPORT: 'node', EMIS_MODELS_FILE: 'none'
  };
  let svc;
  try { svc = await S.startService({ env, port: 0, host: '127.0.0.1', dataDir, token, log }); }
  catch (e) { return t.skip('startService failed: ' + (e && e.message)); }
  try {
    const addr = svc.address ? svc.address() : (svc.server && svc.server.address());
    const base = svc.url || ('http://127.0.0.1:' + addr.port + '/v1');
    const call = async (method, url, json) => {
      const r = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: json ? JSON.stringify(json) : undefined });
      return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
    };
    const models = await call('GET', '/models');
    assert.equal(models.status, 200, JSON.stringify(models.json));
    assert.ok(models.json.data.some(m => m.id === 'emis/other-1' && m.provider === 'emis'), JSON.stringify(models.json).slice(0, 300));
    const r = await call('POST', '/chat/completions', { model: 'emis/other-1', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.choices[0].message.content, 'ok from other-1');
    // streamed: chunks as they come, with the full model id, then [DONE]
    const sse = await fetch(base + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'emis/other-1', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /event-stream/);
    const lines = (await sse.text()).split('\n').filter(l => l.startsWith('data: '));
    assert.equal(lines[lines.length - 1], 'data: [DONE]');
    const chunks = lines.slice(0, -1).map(l => JSON.parse(l.slice(6)));
    assert.equal(chunks.map(c => (c.choices[0] && c.choices[0].delta.content) || '').join(''), 'ok from other-1');
    assert.ok(chunks.every(c => c.model === 'emis/other-1'));
    assert.equal(chunks[chunks.length - 1].usage.total_tokens, 10);
    const limited = await call('POST', '/chat/completions', { model: 'emis/limited-model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(limited.status, 429);
    assert.deepEqual([limited.json.error.type, limited.json.error.scope, limited.json.error.retry_after_seconds], ['rate_limited', 'model', 20]);
    const spent = await call('POST', '/chat/completions', { model: 'emis/budget-said', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(spent.status, 429);
    assert.deepEqual([spent.json.error.type, spent.json.error.scope, spent.json.error.window, spent.json.error.provider], ['quota_exceeded', 'provider', 'day', 'emis']);
    assert.ok(Number(spent.headers.get('retry-after')) > 3500);
    const status = await call('GET', '/status');
    const emisStatus = status.json.providers.find(x => x.id === 'emis');
    assert.equal(emisStatus.keyCount, 1);
    assert.deepEqual([emisStatus.keys[0].status, emisStatus.resting && emisStatus.resting.reason], ['cooling_down', 'quota']);
    assert.ok(!JSON.stringify(status.json).includes(KEY));
  } finally {
    if (svc && svc.close) await svc.close();
  }
});

// ── What a review found ───────────────────────────────────────────────────────

test('a secret in the provider\'s own headers (options.headers) never shows in its errors or the log, whatever the gateway quotes back', async () => {
  await withProvider({ id: 'mygw', config: { name: 'My gateway' }, options: { headers: { 'x-gateway-token': HEADER_SECRET } } }, async p => {
    state.seen.length = 0;
    const err = await failure(p, 'echo-header');
    assert.equal(state.seen[0].headers['x-gateway-token'], HEADER_SECRET, 'the header is sent');
    assert.equal(err.type, 'invalid_request');
    assert.match(err.message, /gateway token \[redacted\] is not allowed/);
    assert.ok(!String(err.log).includes(HEADER_SECRET), 'nor in the line for the service\'s log: ' + err.log);
    assert.ok(!JSON.stringify(logged).includes(HEADER_SECRET));
  });
});

test('a gateway stream that stops without a finish_reason or [DONE] is incomplete (malformed_response), not a finished answer; [DONE] alone or a finish_reason alone still ends it', async () => {
  for (const transport of ['node'].concat(python ? ['python'] : [])) {
    await withProvider({ env: { EMIS_TRANSPORT: transport } }, async p => {
      // (the parts came first: what the service's route makes of it is the failure, not an answer)
      const err = await ask(p, 'cut-short').then(() => null, e => e);
      assert.ok(E.isServiceError(err), 'a ServiceError (' + transport + '): ' + (err && err.stack));
      assert.deepEqual([err.status, err.type, err.code, err.provider], [502, 'malformed_response', 'incomplete', 'emis'], transport);
      assert.match(err.message, /the answer ended before it was complete/);
      const entry = await entryFor(p, 'cut-short');
      const parts = [];
      await assert.rejects(async () => { for await (const e of p.chat(body(entry, { stream: true }), entry, { stream: true, timeoutMs: 10000 })) parts.push(e); },
        e => E.isServiceError(e) && e.code === 'incomplete', 'streamed (' + transport + ')');
      assert.ok(!parts.some(e => e.type === 'finish'), 'no finish was made up');
      assert.equal((await ask(p, 'finish-only')).choices[0].message.content, 'finished');
      assert.equal((await ask(p, 'streams-unless-told')).choices[0].message.content, 'streamed by default');
    });
  }
});

test('with a models file, a live list the gateway can\'t send (e.g. a wrong address that answers 404) is a warning in the status', async () => {
  const file = path.join(tmp, 'models-for-status.json');
  fs.writeFileSync(file, JSON.stringify({ provider: { emis: { models: { 'claude-opus-5.5': { name: 'Claude Opus 5.5' } } } } }));
  state.websiteListNotFound = true;
  try {
    await withProvider({ options: { baseURL: emisBase.replace(/\/v1$/, '/api/v1') }, env: { EMIS_MODELS_FILE: file } }, async p => {
      assert.deepEqual((await p.models()).map(m => [m.model, m.available]), [['claude-opus-5.5', null]]);
      const st = p.status();
      assert.equal(st.ready, true);
      assert.ok(st.warnings.some(w => /^Couldn't check which models AI gateway offers right now \(AI gateway couldn't find the requested endpoint\. Check that EMIS_BASE_URL .* ends in \/v1\)\.$/.test(w)), JSON.stringify(st.warnings));
    });
  } finally { state.websiteListNotFound = false; }
});

test('a key the gateway answers 402 (no credit) rests, and the next key answers the same request; with that key alone: quota_exceeded, then no more calls until it resets', async () => {
  await withProvider({ options: { apiKey: [UNPAID_KEY, KEY].join(',') } }, async p => {
    state.seen.length = 0;
    assert.equal((await ask(p, 'other-1')).choices[0].message.content, 'ok from other-1');
    assert.deepEqual(state.seen.map(s => s.key), [UNPAID_KEY, KEY], 'one try per key, in rotation');
    assert.deepEqual(p.status().keys.map(k => k.status), ['cooling_down', 'available']);
    state.seen.length = 0;
    await ask(p, 'other-1');
    assert.deepEqual(state.seen.map(s => s.key), [KEY], 'the resting key isn\'t tried');
    assert.equal(p.status().resting, null);
  });
  await withProvider({ options: { apiKey: UNPAID_KEY } }, async p => {
    state.seen.length = 0;
    let err = await failure(p, 'other-1');
    assert.deepEqual([err.status, err.type, err.scope], [429, 'quota_exceeded', 'provider']);
    assert.ok(err.retryAfterSeconds > 0);
    assert.equal(p.status().resting.reason, 'quota');
    err = await failure(p, 'other-1');
    assert.equal(err.type, 'quota_exceeded');
    assert.equal(state.seen.length, 1, 'no second upstream call');
  });
});

test('python mode: a worker that stops in the middle of a request: the network error says so (details: …)', { timeout: 30000 }, async () => {
  const fake = path.join(tmp, 'fake-python.js');
  fs.writeFileSync(fake, 'process.stdout.write(JSON.stringify({ ready: true, python: "3.0-fake", client: "fake" }) + "\\n");\nprocess.stdin.once("data", () => process.exit(3));\n');
  await withProvider({ env: { EMIS_TRANSPORT: 'python', EMIS_PYTHON: process.execPath + ' ' + fake } }, async p => {
    const err = await failure(p, 'other-1');
    assert.deepEqual([err.status, err.type, err.code], [502, 'network', 'ECONNRESET']);
    assert.match(err.message, /^The connection to AI gateway dropped before it answered\. Try again\. \(details: Python: The Python worker stopped\.\)$/);
  });
});
