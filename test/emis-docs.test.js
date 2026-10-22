// What the AI service's documentation says, against a stand-in for it: a key's
// budget is prompts and/or tokens per day, week or month, and 429 means it's
// used up until the window rolls over; keys look like "emis-…" (the
// .env.example placeholder isn't one); the website's browser check doesn't
// apply to API requests made with a key (a web page means a wrong address or
// a proxy, not a rejected key); images can come back inside a chat answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { testEnv } = require('./helpers/harness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-emis-docs-'));
const envFile = path.join(tmp, 'emis.env');
const KEY = 'emis-docs-test-key-0123456789';
const calls = [];
let modelsMode = 'ok';
let emis, emisBase, server, base;

const reset = () => String(Math.floor(Date.now() / 1000) + 3600);
test.before(async () => {
  emis = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/models') {
        if (modelsMode === 'webpage403') { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Just a moment...</title>'); }
        if (modelsMode === 'webpage200') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>emis</title>'); }
        return res.end(JSON.stringify({ data: ['prompts-only', 'budget-said', 'picture', 'picture-only', 'other-1'].map(id => ({ id })) }));
      }
      const j = JSON.parse(body || '{}');
      calls.push(j.model);
      const answer = content => JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      // A key with only a prompt budget, reporting its (absent) token budget as 0 of 0
      if (j.model === 'prompts-only') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-RateLimit-Window': 'week', 'X-RateLimit-Limit-Prompts': '100', 'X-RateLimit-Remaining-Prompts': '99',
          'X-RateLimit-Limit-Tokens': '0', 'X-RateLimit-Remaining-Tokens': '0', 'X-RateLimit-Reset': reset() });
        return res.end(answer('ok'));
      }
      // The budget ran out, which the message says before the headers do
      if (j.model === 'budget-said') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'X-RateLimit-Window': 'day', 'X-RateLimit-Limit-Tokens': '5000', 'X-RateLimit-Remaining-Tokens': '400', 'X-RateLimit-Reset': reset() });
        return res.end('{"error":{"message":"Token budget exceeded for this window"}}');
      }
      if (j.model === 'picture') return res.end(answer([{ type: 'text', text: 'Here is your cat: ' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]));
      if (j.model === 'picture-only') return res.end(answer([{ type: 'image_url', image_url: { url: 'https://example.org/cat.png' } }]));
      return res.end(answer('ok from ' + j.model));
    });
  });
  await new Promise(r => emis.listen(0, '127.0.0.1', r));
  emisBase = 'http://127.0.0.1:' + emis.address().port + '/v1';
  fs.writeFileSync(envFile, 'EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=' + KEY + '\n');
  Object.assign(process.env, testEnv({
    METACODE_ENV_FILE: envFile, EMIS_MODELS_FILE: path.join(tmp, 'none.json'), EMIS_TRANSPORT: 'node', EMIS_MODEL: '',
    SUPABASE_URL: '', ACCOUNT_DATA_DIR: path.join(tmp, 'a'), SURVEY_DATA_DIR: path.join(tmp, 's'), PROJECT_DATA_DIR: path.join(tmp, 'p'), DESKTOP_RELEASES_REPO: 'off'
  }));
  server = await require('../server').start(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (emis) { emis.closeAllConnections(); await new Promise(r => emis.close(r)); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const ask = model => json('POST', '/api/ai', { model, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] });
const reload = async env => { fs.writeFileSync(envFile, env); return (await json('POST', '/api/settings/reload', {})).json; };
const keyStatus = async () => (await json('GET', '/api/keys/status')).json.keys[0];

test('a key with a prompt budget only (its token budget reported as 0 of 0) isn\'t treated as used up', async () => {
  assert.equal((await ask('prompts-only')).status, 200);
  const k = await keyStatus();
  assert.equal(k.status, 'available');
  assert.deepEqual([k.quota.window, k.quota.remainingPrompts, k.quota.limitTokens], ['week', 99, 0]);
  calls.length = 0;
  assert.equal((await ask('other-1')).status, 200, 'the next request goes out');
  assert.deepEqual(calls, ['other-1']);
});

test('a 429 that says the budget is spent rests the key until the reset (no hopping between models), even if the headers still show some left', async () => {
  calls.length = 0;
  const r = await ask('budget-said');
  assert.equal(r.status, 429);
  assert.equal(r.json.error.type, 'quota_exceeded');
  assert.match(r.json.error.message, /quota for this day is used up\. It resets in /);
  assert.deepEqual(calls, ['budget-said'], 'no similar model was tried: they share the key\'s budget');
  assert.equal((await keyStatus()).status, 'cooling_down');
  calls.length = 0;
  assert.equal((await ask('other-1')).status, 429, 'every model waits for the reset');
  assert.deepEqual(calls, [], 'without calling the AI service');
  await reload('EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=' + KEY + '\n');       // (forgets the rest)
});

test('the .env.example placeholder isn\'t taken for a key; a key that doesn\'t look like the AI service\'s is used, with a warning', async () => {
  let st = await reload('EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=your-key\n');
  assert.equal(st.ai.ready, false, 'not "AI ready" with a key that would be refused');
  assert.ok(st.ai.warnings.some(w => /placeholder/.test(w)), JSON.stringify(st.ai.warnings));
  st = await reload('EMIS_API_KEY=sk-0123456789abcdef0123\n');          // the AI service's own address (not called here)
  assert.equal(st.ai.ready, true);
  assert.ok(st.ai.warnings.some(w => /doesn't start with "emis-"/.test(w)));
  st = await reload('EMIS_BASE_URL=' + emisBase + '\nEMIS_API_KEY=' + KEY + '\n');
  assert.ok(!st.ai.warnings.some(w => /emis-/.test(w)), 'no warning for a real-looking key');
});

test('a web page instead of the API is a wrong address or a proxy, not a rejected key — and nobody is told to install Python', async () => {
  modelsMode = 'webpage403';
  try {
    const r = await json('GET', '/api/models?refresh=1');
    const text = JSON.stringify(r.json);
    assert.match(text, /web page answered \(HTTP 403\)/);
    assert.match(text, /EMIS_BASE_URL/);
    assert.doesNotMatch(text, /Python|pip install/);
    assert.notEqual((await keyStatus()).status, 'invalid', 'the key isn\'t marked as rejected');
    modelsMode = 'webpage200';
    assert.match(JSON.stringify((await json('GET', '/api/models?refresh=1')).json), /it sent a web page.*EMIS_BASE_URL is the API address ending in \/v1/);
  } finally { modelsMode = 'ok'; await json('GET', '/api/models?refresh=1'); }
});

test('a picture in an answer is marked, not dropped without a trace; an answer that is only a picture isn\'t "empty"', async () => {
  let r = await ask('picture');
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, 'Here is your cat: [image omitted]');
  r = await ask('picture-only');
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, '[image omitted]');
});
