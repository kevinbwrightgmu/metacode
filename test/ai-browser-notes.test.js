// What the browser says about the AI, in a real browser (Playwright + Chromium) against the full
// MetaCode server and a stand-in for its AI service (two providers, "gw" ahead of "zen"):
//   - a model saved without its provider stays as saved while a provider ahead of the match hasn't
//     listed its models (the server maps it per request), and moves once it has
//   - the assistant shows the server's own message when MetaCode and the AI service don't share the
//     access token, or a web page answered, instead of blaming a provider's key
//   - its advice after a used-up usage limit offers another provider only when one can answer
//   - Settings → AI connection says when every ready provider is resting, and when free models may
//     answer for paid ones (AI_FALLBACK_TO_FREE_MODELS=on)
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { testEnv } = require('./helpers/harness');

function findChromium() {
  const candidates = [];
  if (process.env.CHROMIUM_PATH) candidates.push(process.env.CHROMIUM_PATH);
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try { fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse().forEach(d => candidates.push(path.join(root, d, 'chrome-linux', 'chrome'))); } catch (e) { /* none */ }
  try { candidates.push(require('playwright-core').chromium.executablePath()); } catch (e) { /* none */ }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
const chromiumPath = findChromium();
const skip = !chromiumPath && 'no Chromium found (set CHROMIUM_PATH)';

const TOKEN = 'notes-test-service-token-0123456789';
const STARTED = new Date().toISOString();
// gwReady: the gateway has listed its models; tokenOk: the service accepts MetaCode's token
const svc = { gwReady: false, gwKeys: 1, tokenOk: true };
const PROVIDERS = [{ id: 'gw', name: 'Test gateway' }, { id: 'zen', name: 'Zen test' }];
function modelList() {
  const gw = svc.gwReady ? [['gw/claude-opus-5.5', 'Claude Opus 5.5', false], ['gw/blocked-model', 'Blocked Model', false], ['gw/limit-model', 'Limit Model', false]] : [];
  const zen = [['zen/claude-opus-5-5', 'Claude Opus 5.5', false], ['zen/limit-model', 'Zen Limit', true], ['zen/pickle', 'Pickle', true]];
  return {
    object: 'list', default: 'zen/pickle',
    providers: PROVIDERS.map(p => Object.assign({ ready: p.id === 'zen' || svc.gwReady }, p)),
    data: gw.concat(zen).map(([id, name, free]) => ({ id, object: 'model', provider: id.split('/')[0], provider_name: PROVIDERS.find(p => p.id === id.split('/')[0]).name,
      model: id.split('/')[1], name, free, available: true }))
  };
}
function serviceStatus(port) {
  return {
    service: { name: 'metacode-opencode', version: 'test', opencode: '2.1.4', startedAt: STARTED, pid: process.pid, host: '127.0.0.1', port },
    ready: true, default: 'zen/pickle', warnings: [],
    providers: [
      { id: 'gw', name: 'Test gateway', kind: 'openai-compatible', ready: svc.gwReady, problem: svc.gwReady ? null : 'Test gateway is still loading its model list. Try again in a moment.',
        warnings: [], keyCount: svc.gwKeys, models: { listed: svc.gwReady ? 3 : 0, available: svc.gwReady ? 3 : 0 }, resting: null, keys: [] },
      { id: 'zen', name: 'Zen test', kind: 'zen', ready: true, problem: null, warnings: [], keyCount: 0, free: true, note: null, models: { listed: 3, available: 3 }, resting: null, keys: [] }
    ]
  };
}
const send = (res, status, body, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(JSON.stringify(body)); };

let aiService, server, base, browser;

test.before(async () => {
  if (skip) return;
  aiService = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!svc.tokenOk || req.headers.authorization !== 'Bearer ' + TOKEN) {
        return send(res, 401, { error: { type: 'authentication_error', message: 'MetaCode\'s OpenCode service needs its access token.' } });
      }
      if (req.url === '/v1/status') return send(res, 200, serviceStatus(aiService.address().port));
      if (req.url === '/v1/reload') return send(res, 200, serviceStatus(aiService.address().port));
      if (req.url === '/v1/models') return send(res, 200, modelList());
      if (req.url !== '/v1/chat/completions') return send(res, 404, { error: { type: 'not_found', message: 'Not found.' } });
      const j = JSON.parse(body || '{}');
      // A proxy's web page answered instead of the gateway's API
      if (j.model === 'gw/blocked-model') {
        return send(res, 403, { error: { type: 'blocked', provider: 'gw', model: j.model, message: 'A web page answered (HTTP 403) instead of Test gateway\'s API. A proxy or firewall on this network may be answering; check EMIS_BASE_URL.' } });
      }
      // A provider's usage limit is used up (the whole provider rests)
      if (j.model === 'gw/limit-model' || j.model === 'zen/limit-model') {
        const provider = j.model.split('/')[0];
        return send(res, 429, { error: { type: 'quota_exceeded', scope: 'provider', provider, window: 'day', retry_after_seconds: 3600, reset_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          message: PROVIDERS.find(p => p.id === provider).name + '\'s usage limit for this day is used up. It resets in an hour.' } }, { 'Retry-After': '3600' });
      }
      send(res, 200, { id: 'x', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok from ' + j.model }, finish_reason: 'stop' }] });
    });
  });
  await new Promise(r => aiService.listen(0, '127.0.0.1', r));
  Object.assign(process.env, testEnv({ OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + aiService.address().port + '/v1', OPENCODE_SERVICE_TOKEN: TOKEN }));
  const { start } = require('../server');
  server = await start(0);
  base = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (aiService) { aiService.closeAllConnections(); await new Promise(r => aiService.close(r)); }
});

// A page of the app (only this computer's addresses), its settings set before it loads
async function openApp(settings, hash) {
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.abort());
  if (settings) await page.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('strata_v1', JSON.stringify({ settings: s })); } }, settings);
  await page.goto(base + '/app.html' + (hash || ''));
  await page.waitForFunction(() => typeof App !== 'undefined' && App.getServerStatus() && App.getServerStatus().ai);
  return page;
}
// Asks the assistant once and returns its error text
async function assistantError(page, model) {
  await page.evaluate(m => App.setState({ settings: Object.assign({}, App.getState().settings, { models: { assistant: m }, switchModels: false }) }), model);
  await page.evaluate(() => { Assistant.clear(); Assistant.open(); Assistant.send('How do I code posts?'); });
  await page.waitForSelector('.asst-msg-error');
  return page.textContent('.asst-msg-error');
}

test('a model saved without its provider stays as saved while a provider ahead of the match hasn\'t listed its models, and moves once it has', { skip, timeout: 60000 }, async () => {
  svc.gwReady = false;
  const page = await openApp({ model: 'claude-opus-5-5', models: { coding: 'claude-opus-5.5', assistant: 'zen/claude-opus-5.5' } }, '#settings');
  try {
    await page.waitForFunction(() => document.querySelectorAll('#s-model option').length > 2);
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('strata_v1')).settings);
    // (the old spelling is read as the new one; the gateway may list it too, so it isn't moved to Zen)
    assert.equal(await page.evaluate(() => App.getState().settings.model), 'claude-opus-5.5');
    assert.equal(await page.evaluate(() => App.getState().settings.models.coding), 'claude-opus-5.5');
    assert.notEqual((await saved()).model, 'zen/claude-opus-5-5', 'not saved under Zen');
    assert.match(await page.textContent('#s-model'), /claude-opus-5\.5 \(not in the list\)/);
    // An id that names its provider is updated as before
    assert.equal(await page.evaluate(() => App.getState().settings.models.assistant), 'zen/claude-opus-5-5');
    // The gateway has listed its models: now the saved id becomes the gateway's, like the server maps it
    svc.gwReady = true;
    await page.evaluate(() => { App.navigate('dashboard'); App.navigate('settings'); });
    await page.waitForFunction(() => App.getState().settings.model === 'gw/claude-opus-5.5');
    assert.equal(await page.evaluate(() => App.getState().settings.models.coding), 'gw/claude-opus-5.5');
    assert.equal((await saved()).model, 'gw/claude-opus-5.5');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('a model saved without its provider moves at once when the provider ahead has no key at all (it will never list its models)', { skip, timeout: 60000 }, async () => {
  svc.gwReady = false;
  svc.gwKeys = 0;
  await fetch(base + '/api/settings/reload', { method: 'POST' });   // (MetaCode asks the service again)
  const page = await openApp({ model: 'claude-opus-5-5', models: {} }, '#settings');
  try {
    await page.waitForFunction(() => App.getServerStatus() && document.querySelectorAll('#s-model option').length > 2);
    // (the model list may have arrived before Settings' status: look again once both are there)
    await page.evaluate(() => { App.navigate('dashboard'); App.navigate('settings'); });
    await page.waitForFunction(() => App.getState().settings.model === 'zen/claude-opus-5-5');
    assert.deepEqual(page.errors, []);
  } finally {
    svc.gwKeys = 1;
    await page.close();
    await fetch(base + '/api/settings/reload', { method: 'POST' });
  }
});

test('Settings → AI connection says when free models may answer for paid ones (AI_FALLBACK_TO_FREE_MODELS=on), and only then', { skip, timeout: 60000 }, async () => {
  svc.gwReady = true;
  const page = await openApp(null, '#settings');
  try {
    await page.waitForFunction(() => /AI is ready/.test((document.getElementById('s-env-status') || {}).textContent || ''));
    assert.doesNotMatch(await page.textContent('#s-env-status'), /free models may answer/i);
    // The operator allows it (the server reports it as settings.ai.freeFallback) and clicks Reload .env
    process.env.AI_FALLBACK_TO_FREE_MODELS = 'on';
    await page.click('#s-reload-env');
    await page.waitForFunction(() => /free models may answer for paid ones/i.test(document.getElementById('s-env-status').textContent));
    assert.equal(await page.evaluate(() => App.getServerStatus().ai.freeFallback), true);
    assert.deepEqual(page.errors, []);
  } finally {
    delete process.env.AI_FALLBACK_TO_FREE_MODELS;
    await page.close();
    await fetch(base + '/api/settings/reload', { method: 'POST' });
  }
});

test('the assistant shows the server\'s message when a web page answered, or MetaCode and the AI service don\'t share the access token — not "check the provider\'s key"', { skip, timeout: 60000 }, async () => {
  svc.gwReady = true;
  const page = await openApp();
  try {
    const blocked = await assistantError(page, 'gw/blocked-model');
    assert.match(blocked, /A web page answered \(HTTP 403\)/);
    assert.match(blocked, /Settings → AI connection/);
    assert.doesNotMatch(blocked, /didn.t accept the key/);
    // Every request is refused for its token (the service reads another OPENCODE_SERVICE_TOKEN)
    svc.tokenOk = false;
    const token = await assistantError(page, 'zen/pickle');
    assert.match(token, /access token/);
    assert.match(token, /OPENCODE_SERVICE_TOKEN/);
    assert.doesNotMatch(token, /didn.t accept the key/);
    assert.deepEqual(page.errors, []);
  } finally {
    svc.tokenOk = true;
    await page.close();
    await fetch(base + '/api/settings/reload', { method: 'POST' });   // (MetaCode asks the service again)
  }
});

test('after a used-up usage limit the assistant offers another provider only when one can answer; with every ready provider resting, Settings says so', { skip, timeout: 60000 }, async () => {
  svc.gwReady = true;
  const page = await openApp();
  try {
    await page.waitForFunction(() => App.hasApiKeys());
    // The gateway's limit is used up; Zen can still answer
    const first = await assistantError(page, 'gw/limit-model');
    assert.match(first, /Test gateway's usage limit for this day is used up/);
    assert.match(first, /another AI provider can answer/);
    // Now Zen's too (this page read the server's status before either): nothing else can answer
    const second = await assistantError(page, 'zen/limit-model');
    assert.match(second, /Zen test's usage limit for this day is used up/);
    assert.doesNotMatch(second, /another AI provider/);
    assert.match(second, /work again/);
    // Settings → AI connection: resting, not "AI is ready"
    await page.evaluate(() => App.navigate('settings'));
    await page.waitForFunction(() => /resting until/i.test(document.getElementById('s-env-status').textContent));
    const box = await page.textContent('#s-env-status');
    assert.doesNotMatch(box, /AI is ready/);
    assert.match(box, /Test gateway/);
    assert.match(box, /Zen test/);
    assert.equal(await page.textContent('#s-ai-badge'), 'Resting');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});
