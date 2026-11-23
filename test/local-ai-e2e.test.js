// The Local AI pages in a real browser (js/local-ai.js): the AI Model Store recommending what fits, searching
// and filtering, a model's sizes, an install with its progress; Installed Models (load, the default and each
// feature's model, a model's settings, delete); AI Chat streaming an answer; System. Against stand-ins for Ollama,
// ollama.com's library, Ollama's registry and MetaCode's AI service.
// Skipped when no Chromium is available (set CHROMIUM_PATH to point at one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { testEnv } = require('./helpers/harness');
const { standIns } = require('./helpers/ollama-standin');

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
const TOKEN = 'local-ai-e2e-service-token-0123456789';

// MetaCode's AI service, as far as these pages need it: the models Ollama has (local, first-class), streamed chats
const chats = [];
function aiService(si) {
  return http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/health') return send(200, { ok: true, service: 'metacode-opencode', version: 'test' });
      if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: { type: 'authentication_error', message: 'token' } });
      const models = [...si.st.installed.keys()].map(m => ({ id: 'ollama/' + m, object: 'model', provider: 'ollama', provider_name: 'On this device (Ollama)', model: m, name: m + ' (on this device)', free: false, available: true, local: true, backup: false }));
      const providers = [{ id: 'ollama', name: 'On this device (Ollama)', ready: models.length > 0, local: true, keyCount: 0 }];
      if (req.url === '/v1/status') return send(200, { service: { name: 'metacode-opencode', version: 'test' }, ready: models.length > 0, default: models[0] ? models[0].id : null, warnings: [], providers });
      if (req.url === '/v1/models') return send(200, { object: 'list', default: models[0] ? models[0].id : null, providers, data: models });
      if (req.url === '/v1/local/refresh') return send(200, { ok: true, refreshed: ['ollama'] });
      if (req.url === '/v1/reload') return send(200, { ok: true });
      if (req.url !== '/v1/chat/completions') return send(404, { error: { type: 'not_found', message: 'Not found.' } });
      const body = JSON.parse(b || '{}');
      chats.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const words = ['A codebook ', 'lists the codes ', 'and their rules.'];
      let i = 0;
      const tick = () => {
        if (i < words.length) { res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content: words[i++] } }] }) + '\n\n'); setTimeout(tick, 60); }
        else { res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n'); res.end('data: [DONE]\n\n'); }
      };
      tick();
    });
  });
}

let si, svc, server, baseUrl, browser, tmp;
test.before(async () => {
  if (skip) return;
  si = await standIns();
  svc = aiService(si);
  await new Promise(r => svc.listen(0, '127.0.0.1', r));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-local-ai-e2e-'));
  Object.assign(process.env, testEnv({
    METACODE_DATA_DIR: tmp, LOCAL_AI_DATA_DIR: path.join(tmp, 'local-ai'), AI_MODE: 'local',
    OLLAMA_BASE_URL: si.base + '/v1', LOCAL_AI_LIBRARY_URL: si.base + '/library', LOCAL_AI_REGISTRY_URL: si.base + '/v2/library/',
    OPENCODE_SERVICE_URL: 'http://127.0.0.1:' + svc.address().port + '/v1', OPENCODE_SERVICE_TOKEN: TOKEN, OPENCODE_SERVICE_MANAGED: 'off'
  }));
  server = await require('../server').start(0);
  baseUrl = 'http://localhost:' + server.address().port;
  browser = await require('playwright-core').chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (svc) { svc.closeAllConnections(); await new Promise(r => svc.close(r)); }
  if (si) await si.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
async function open(url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(baseUrl + url);
  return { page, context, errors };
}

test('AI Model Store: what fits this computer, search and filters, a model\'s sizes, and an install with its progress', { skip, timeout: 120000 }, async () => {
  si.st.pullDelayMs = 80;
  const { page, context, errors } = await open('/app.html#model-store');
  await page.waitForSelector('.lai-tier .lai-card');
  assert.match(await page.textContent('.lai-head'), /Ollama 0\.40\.17 running/);
  assert.match(await page.textContent('.lai-source'), /Catalog: from ollama\.com just now · 4 models/);
  // Recommended: the biggest gemma3 that fits, never an embedding model
  const recommended = await page.$$eval('.lai-tier .lai-card h4', els => els.map(e => e.textContent));
  assert.ok(recommended.includes('gemma3'));
  assert.ok(!recommended.includes('nomic-embed-text'));
  // All models: search and filters
  await page.click('.lai-tab[data-tab="all"]');
  await page.fill('#lai-q', 'coder');
  await page.waitForFunction(() => document.querySelectorAll('.lai-grid .lai-card').length === 1);
  assert.equal(await page.textContent('.lai-grid .lai-card h4'), 'qwen2.5-coder');
  await page.fill('#lai-q', '');
  await page.click('.lai-filter[data-filter="category"][data-value="embedding"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.lai-grid .lai-card h4')].map(e => e.textContent).join() === 'nomic-embed-text');
  await page.click('.lai-filter[data-filter="category"][data-value=""]');
  // A model's sizes, each with how it fits here; install one from there
  await page.click('.lai-card [data-act="details"][data-name="gemma3"]');
  await page.waitForSelector('.lai-table tbody tr');
  const rows = await page.$$eval('.lai-table tbody tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(rows.some(r => /^gemma3:270m\s*292 MB/.test(r) && /fits/.test(r)), JSON.stringify(rows));
  assert.ok(rows.some(r => /^gemma3:27b/.test(r) && /too big here/.test(r)), 'a size too big for this computer says so');
  await page.click('.lai-table [data-act="install"][data-model="gemma3:270m"]');
  // Progress in Downloads (percent, then installed and verified)
  await page.waitForSelector('#lai-jobs .lai-job[data-model="gemma3:270m"]', { timeout: 10000 });
  await page.waitForFunction(() => { const b = document.querySelector('#lai-jobs .lai-job[data-model="gemma3:270m"] [role="progressbar"]'); return b && Number(b.getAttribute('aria-valuenow')) > 0; }, null, { timeout: 10000 });
  await page.waitForFunction(() => /is installed and verified/.test(document.getElementById('notif-stack').textContent), null, { timeout: 15000 });
  assert.ok(si.st.installed.has('gemma3:270m'));
  assert.deepEqual(errors, []);
  await context.close();
  si.st.pullDelayMs = 25;
});

test('Installed Models: load it, make it the default and the AI Coding model, its settings, delete it', { skip, timeout: 90000 }, async () => {
  if (!si.st.installed.has('gemma3:270m')) si.st.installed.set('gemma3:270m', { digest: 'x', size: 6000800 });
  const { page, context, errors } = await open('/app.html#installed-models');
  await page.waitForSelector('#lai-installed tbody tr');
  assert.match(await page.textContent('#lai-installed h3'), /^1 model,/);
  await page.click('[data-act="load"][data-model="gemma3:270m"]');
  await page.waitForFunction(() => /loaded/.test(document.querySelector('#lai-installed tbody tr').textContent));
  await page.click('[data-act="default"][data-model="gemma3:270m"]');
  await page.waitForFunction(() => App.getState().settings.model === 'ollama/gemma3:270m');
  await page.selectOption('select[data-feature="coding"]', 'ollama/gemma3:270m');
  assert.equal(await page.evaluate(() => App.getState().settings.models.coding), 'ollama/gemma3:270m');
  await page.click('[data-act="settings"][data-model="gemma3:270m"]');
  await page.fill('#lai-s-temp', '0.2');
  await page.fill('#lai-s-max', '256');
  await page.click('#lai-s-save');
  await page.waitForFunction(() => /Settings saved/.test(document.getElementById('notif-stack').textContent));
  const settings = await (await fetch(baseUrl + '/api/local-ai/models')).json();
  assert.deepEqual(settings.models[0].settings, { temperature: 0.2, maxTokens: 256 });
  await page.click('[data-act="delete"][data-model="gemma3:270m"]');
  await page.click('#lai-del-ok');
  await page.waitForFunction(() => /No model is installed yet/.test(document.getElementById('lai-installed').textContent));
  assert.equal(si.st.installed.has('gemma3:270m'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('AI Chat streams the answer of a model on this device; System shows this browser, the server, the runtimes and where each works', { skip, timeout: 90000 }, async () => {
  si.st.installed.set('gemma3:270m', { digest: 'x', size: 6000800 });
  const { page, context, errors } = await open('/app.html#ai-chat');
  await page.waitForSelector('#lai-chat-model');
  assert.equal(await page.inputValue('#lai-chat-model'), 'ollama/gemma3:270m');
  await page.fill('#lai-chat-input', 'What is a codebook?');
  await page.press('#lai-chat-input', 'Enter');
  await page.waitForFunction(() => /A codebook lists the codes and their rules\./.test(document.querySelector('.lai-assistant') ? document.querySelector('.lai-assistant').textContent : ''));
  const sent = chats[chats.length - 1];
  assert.equal(sent.model, 'ollama/gemma3:270m');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.messages.map(m => m.role), ['user']);
  await page.click('[data-act="new-chat"]');
  assert.match(await page.textContent('#lai-log'), /Ask anything/);
  await page.goto(baseUrl + '/app.html#system');
  await page.waitForSelector('.lai-sys');
  const text = (await page.textContent('#view-container')).replace(/\s+/g, ' ');
  assert.match(text, /This browser/);
  assert.match(text, /The MetaCode server/);
  assert.match(text, /Ollama ?running ?Ollama 0\.40\.17 answers at http:\/\/127\.0\.0\.1:\d+\./);
  assert.match(text, /Where each runtime works/);
  assert.match(text, /iPhone and iPad/);
  assert.match(text, /models on this computer first/);
  assert.deepEqual(errors, []);
  await context.close();
});
