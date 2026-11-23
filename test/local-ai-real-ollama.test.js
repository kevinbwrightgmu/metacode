// The AI Model Store and the AI service against a real Ollama: a tiny model installed through the Store (its
// progress, the digest checked against Ollama's registry), loaded, answering a chat through the AI service in
// AI_MODE=local-only (nothing else is offered), and unloaded.
// Opt-in: METACODE_TEST_OLLAMA=1, with Ollama running at OLLAMA_BASE_URL (default 127.0.0.1:11434) and the
// internet reachable for Ollama's registry. It downloads gemma3:270m (292 MB) when it isn't there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createLocalAi } = require('../local-ai');

const skip = process.env.METACODE_TEST_OLLAMA !== '1' && 'set METACODE_TEST_OLLAMA=1 (with Ollama running) to test against a real Ollama';
const BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const MODEL = 'gemma3:270m';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a real Ollama: a model installed through the Store (progress, verified), loaded, answering through the AI service in local-only mode, unloaded', { skip, timeout: 15 * 60 * 1000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-real-ollama-'));
  const local = createLocalAi({ env: { OLLAMA_BASE_URL: BASE, LOCAL_AI_DATA_DIR: tmp }, isLoopback: () => true });
  const app = express();
  app.use('/api/local-ai', local.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const api = async (method, p, body) => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/local-ai' + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  let svc = null;
  try {
    const st = await api('GET', '/status');
    assert.equal(st.json.ollama.running, true, 'Ollama answers at ' + BASE);
    // A fresh install (deleted first when it's there), watched as the Store does
    if ((await api('GET', '/models')).json.models.some(m => m.name === MODEL)) assert.equal((await api('POST', '/models/delete', { model: MODEL })).status, 200);
    const started = await api('POST', '/installs', { model: MODEL });
    assert.equal(started.status, 202);
    let job = null, sawProgress = false;
    for (let i = 0; i < 1200; i++) {
      job = (await api('GET', '/installs')).json.installs.find(j => j.model === MODEL);
      if (job && job.state === 'downloading' && job.percent > 0 && job.percent < 100) sawProgress = true;
      if (job && ['done', 'failed'].includes(job.state)) break;
      await sleep(250);
    }
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(job.verified, true, 'the installed digest is the registry\'s');
    assert.ok(sawProgress || job.total > 0, 'progress was reported');
    const listed = (await api('GET', '/models')).json.models.find(m => m.name === MODEL);
    assert.ok(listed && listed.size > 2e8, JSON.stringify(listed));
    // Loaded into memory, as the Installed Models page does
    const loaded = await api('POST', '/models/load', { model: MODEL });
    assert.ok(loaded.json.models.find(m => m.name === MODEL).loaded, 'in memory');
    // The AI service in local-only mode: only this machine's models, and one answers (held to JSON)
    const S = await import('../opencode/server.mjs');
    svc = await S.startService({
      env: { METACODE_ENV_FILE: 'none', METACODE_LOG: 'off', AI_MODE: 'local-only', OLLAMA_BASE_URL: BASE, OPENCODE_SERVICE_DATA_DIR: fs.mkdtempSync(path.join(tmp, 'svc-')),
        OPENCODE_SERVICE_TOKEN: 'real-ollama-test-token-0123456789', OPENCODE_DISABLE_MODELS_FETCH: '1', EMIS_API_KEY: 'emis-not-used-0123456789' },
      port: 0, host: '127.0.0.1', log: { info() {}, warn() {}, error() {} }
    });
    const call = async (p, body) => {
      const res = await fetch(svc.url.replace(/\/v1$/, '') + p, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer real-ollama-test-token-0123456789', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };
    const models = (await call('/v1/models')).json;
    assert.ok(models.data.length && models.data.every(m => m.provider === 'ollama'), JSON.stringify(models.data.map(m => m.id)));
    assert.equal(models.default, 'ollama/' + MODEL);
    const t0 = Date.now();
    const answer = await call('/v1/chat/completions', { model: 'ollama/' + MODEL, max_tokens: 60, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'Return a JSON object {"tone": "positive" or "negative"} for: I love this!' }] });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    const text = answer.json.choices[0].message.content;
    assert.doesNotThrow(() => JSON.parse(text), 'valid JSON: ' + text);
    console.log('# real answer in ' + (Date.now() - t0) + ' ms: ' + text.replace(/\s+/g, ' '));
    const cloud = await call('/v1/chat/completions', { model: 'emis/claude-opus-5.5', messages: [{ role: 'user', content: 'hi' }] });
    assert.notEqual(cloud.status, 200, 'no cloud model in local-only mode');
    // Stopped
    const unloaded = await api('POST', '/models/unload', { model: MODEL });
    assert.equal(unloaded.json.models.find(m => m.name === MODEL).loaded, null);
  } finally {
    if (svc) await svc.close().catch(() => {});
    local.close();
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
