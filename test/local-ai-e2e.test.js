// The Local AI pages in a real browser (js/local-ai.js): the AI Model Store recommending what fits, searching
// and filtering, a model's sizes, an install with its progress; Installed Models (load, the default and each
// feature's model, a model's settings, delete); AI Chat streaming an answer; System. Then the Downloads card's
// Pause, Resume and Cancel, the admin token on another device, live progress after the event stream fails, AI
// Chat's notes and stops, what each page says when something can't be reached, the models the AI service doesn't
// offer, one model under two names, and names in another case. Against stand-ins for Ollama, ollama.com's
// library, Ollama's registry and MetaCode's AI service.
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

// MetaCode's AI service, as far as these pages need it: the chat models Ollama has (local, first-class; like the
// real service, never an embedding model), streamed chats. How an answer goes depends on the question: "slowly"
// takes seconds, "think" only thinks until its length limit, "at length" is cut off at it, "fail" breaks off
// with the service's error.
const chats = [];
const streams = [];               // { ask, closed: the browser went away before the end, ended }
function aiService(si) {
  return http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/health') return send(200, { ok: true, service: 'metacode-opencode', version: 'test' });
      if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: { type: 'authentication_error', message: 'token' } });
      const models = [...si.st.installed.keys()].filter(m => !/embed/i.test(m)).map(m => ({ id: 'ollama/' + m, object: 'model', provider: 'ollama', provider_name: 'On this device (Ollama)', model: m, name: m + ' (on this device)', free: false, available: true, local: true, backup: false }));
      const providers = [{ id: 'ollama', name: 'On this device (Ollama)', ready: models.length > 0, local: true, keyCount: 0,
        ...(models.length ? {} : { problem: 'Ollama has no chat model yet. Install one in the AI Model Store.' }) }];
      if (req.url === '/v1/status') return send(200, { service: { name: 'metacode-opencode', version: 'test' }, ready: models.length > 0, default: models[0] ? models[0].id : null, warnings: [], providers });
      if (req.url === '/v1/models') return send(200, { object: 'list', default: models[0] ? models[0].id : null, providers, data: models });
      if (req.url === '/v1/local/refresh') return send(200, { ok: true, refreshed: ['ollama'] });
      if (req.url === '/v1/reload') return send(200, { ok: true });
      if (req.url !== '/v1/chat/completions') return send(404, { error: { type: 'not_found', message: 'Not found.' } });
      const body = JSON.parse(b || '{}');
      chats.push(body);
      const ask = String(((body.messages || []).slice(-1)[0] || {}).content || '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish) => res.write('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] }) + '\n\n');
      if (/think/i.test(ask)) { chunk({ reasoning_content: 'Let me think about codes…' }); chunk({}, 'length'); return res.end('data: [DONE]\n\n'); }
      if (/at length/i.test(ask)) { chunk({ content: 'It goes on and on' }); chunk({}, 'length'); return res.end('data: [DONE]\n\n'); }
      if (/fail/i.test(ask)) { res.write('data: ' + JSON.stringify({ error: { message: 'The model ran out of memory.' } }) + '\n\n'); return res.end(); }
      const slow = /slowly/i.test(ask);
      const words = slow ? Array.from({ length: 30 }, (x, n) => 'word' + n + ' ') : ['A codebook ', 'lists the codes ', 'and their rules.'];
      const stream = { ask, closed: false, ended: false };
      streams.push(stream);
      res.on('close', () => { if (!stream.ended) stream.closed = true; });
      let i = 0;
      const tick = () => {
        if (stream.closed) return;
        if (i < words.length) { chunk({ content: words[i++] }); setTimeout(tick, slow ? 200 : 60); }
        else { stream.ended = true; chunk({}, 'stop'); res.end('data: [DONE]\n\n'); }
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
// opts.context: more options for the browser context; opts.setup(context): before the page loads (routes)
async function open(url, opts) {
  opts = opts || {};
  const context = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 } }, opts.context));
  await context.addInitScript(() => { try { localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } });
  if (opts.setup) await opts.setup(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(baseUrl + url);
  return { page, context, errors };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + (ms || 10000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + (what || 'it'));
    await sleep(100);
  }
}
// A press as a person makes one: the button held for half a second, while a download's progress repaints the page
async function press(page, selector) {
  const box = await (await page.waitForSelector(selector)).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(500);
  await page.mouse.up();
}
// The server's own state of a download (null: it has none). (Names are compared whatever their case: the server may
// keep a tag's, as ollama.com spells it.)
const jobOf = async model => ((await (await fetch(baseUrl + '/api/local-ai/installs')).json()).installs || []).find(j => j.model.toLowerCase() === model.toLowerCase()) || null;
const installedHas = name => [...si.st.installed.keys()].some(n => n.toLowerCase() === name.toLowerCase());
// Takes a model off the stand-in Ollama as if it had never been pulled: not installed, nothing kept of a download,
// none of its layers on disk (a stand-in that keeps them finishes the next download at once)
function forget(name) {
  const key = name.toLowerCase();
  for (const [n, m] of [...si.st.installed]) {
    if (n.toLowerCase() !== key) continue;
    si.st.installed.delete(n);
    if (si.st.blobs && m.blobs) m.blobs.forEach(d => si.st.blobs.delete(d));
  }
  si.st.partial.delete(name); si.st.partial.delete(key);
}
// Whether the page has such an element (a boolean: a failed assertion on an element handle would print all of
// Playwright's connection, gigabytes of it)
const has = async (page, selector) => !!(await page.$(selector));
// Leaves the page for the Dashboard and comes back (the module keeps its state, as when people click around)
async function revisit(page, hash, selector) {
  await page.evaluate(() => { location.hash = '#dashboard'; });
  await page.waitForFunction(() => !document.querySelector('#view-container .lai'));
  await page.evaluate(h => { location.hash = h; }, hash);
  await page.waitForSelector(selector);
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

test('Downloads: Pause, Resume and Cancel in the Downloads card reach the server, and Install buttons keep working while a download runs', { skip, timeout: 120000 }, async () => {
  for (const m of ['gemma3:270m', 'gemma3:1b']) forget(m);
  si.st.pullDelayMs = 400;        // 20 steps: 8 s for a download, its progress repainting the page every 400 ms
  const { page, context, errors } = await open('/app.html#model-store');
  await page.waitForSelector('.lai-tier .lai-card');
  await page.click('.lai-tab[data-tab="all"]');
  await page.click('.lai-card [data-act="details"][data-name="gemma3"]');
  await page.click('.lai-table [data-act="install"][data-model="gemma3:270m"]');
  // The Details modal's other Install buttons still answer once the progress has repainted the modal
  await page.waitForFunction(() => /\d+%/.test((document.querySelector('.lai-table [data-install-for="gemma3:270m"]') || {}).textContent || ''));
  await press(page, '.lai-table [data-act="install"][data-model="gemma3:1b"]');
  assert.equal((await until(() => jobOf('gemma3:1b'), 5000, 'the second install')).state, 'queued');
  await page.keyboard.press('Escape');
  // …and so do the grid's: one more from Recommended, cancelled in Downloads while it waits
  await page.click('.lai-tab[data-tab="recommended"]');
  const other = await page.$$eval('.lai-tier [data-act="install"]', els => els.map(e => e.dataset.model).find(m => !/^gemma3:/.test(m)));
  assert.ok(other, 'a model to install from the grid');
  await press(page, '.lai-tier [data-act="install"][data-model="' + other + '"]');
  assert.equal((await until(() => jobOf(other), 5000, 'the install from the grid')).state, 'queued');
  await press(page, '#lai-jobs [data-act="cancel"][data-model="' + other + '" i]');
  await until(async () => !(await jobOf(other)), 5000, 'Cancel while it waits');
  await page.waitForFunction(m => !document.querySelector('#lai-jobs [data-model="' + m + '" i]'), other);
  // Pause the running download: the next in the queue starts
  await press(page, '#lai-jobs [data-act="pause"][data-model="gemma3:270m"]');
  await until(async () => (await jobOf('gemma3:270m')).state === 'paused', 5000, 'Pause');
  await until(async () => (await jobOf('gemma3:1b')).state === 'downloading', 5000, 'the next download');
  // Resume it: it waits for that one
  await press(page, '#lai-jobs [data-act="resume"][data-model="gemma3:270m"]');
  await until(async () => (await jobOf('gemma3:270m')).state === 'queued', 5000, 'Resume');
  // Cancel the one downloading: the resumed one continues where it stopped. (Steps of 100 ms meanwhile: the rest
  // of gemma3:1b takes about 2 s, longer than the press, and the row is still repainted during it. Faster, it
  // could finish before Cancel is released, and a finished download can't be cancelled.)
  si.st.pullDelayMs = 100;
  await press(page, '#lai-jobs [data-act="cancel"][data-model="gemma3:1b"]');
  await until(async () => !(await jobOf('gemma3:1b')), 5000, 'Cancel while it downloads');
  si.st.pullDelayMs = 25;
  const done = await until(async () => { const j = await jobOf('gemma3:270m'); return j.state === 'done' && j; }, 15000, 'the download');
  assert.equal(done.resumed, true, 'it continued where it stopped');
  await page.waitForFunction(() => /gemma3:270m is installed and verified/.test(document.getElementById('notif-stack').textContent));
  await page.waitForFunction(() => !document.querySelector('#lai-jobs .lai-job'));
  assert.equal(installedHas('gemma3:1b'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Live progress comes back after the event stream fails for good (an HTTP error when it reconnects)', { skip, timeout: 90000 }, async () => {
  forget('gemma3:1b');
  si.st.pullDelayMs = 500;
  let calls = 0;
  const { page, context, errors } = await open('/app.html#model-store', {
    setup: ctx => ctx.route(u => new URL(u).pathname === '/api/local-ai/installs/events', route => {
      calls++;
      // 1: the server goes away (the stream ends, to be reconnected soon); 2: the proxy in front of it answers 502,
      // and EventSource gives up for good; then MetaCode is back
      if (calls === 1) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 200\nevent: snapshot\ndata: {"installs":[]}\n\n' });
      if (calls === 2) return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>502 Bad Gateway</h1>' });
      return route.continue();
    }),
  });
  await page.waitForSelector('.lai-tier .lai-card');
  await until(() => calls >= 2, 10000, 'the 502');
  // A download started meanwhile (from another browser) shows here, and so does its end
  const r = await fetch(baseUrl + '/api/local-ai/installs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemma3:1b' }) });
  assert.equal(r.status, 202);
  await page.waitForSelector('#lai-jobs .lai-job[data-model="gemma3:1b"]', { timeout: 15000 });
  assert.ok(calls >= 3);
  await page.waitForFunction(() => /gemma3:1b is installed/.test(document.getElementById('notif-stack').textContent), null, { timeout: 20000 });
  assert.deepEqual(errors, []);
  await context.close();
  si.st.pullDelayMs = 25;
});

test('Downloads on Installed Models: an interrupted download continues from its Resume button', { skip, timeout: 90000 }, async () => {
  const model = 'qwen2.5-coder:0.5b';
  forget(model);
  si.st.pullDelayMs = 25;
  si.st.breakAt = 3000000;           // (the connection breaks half-way)
  try {
    const { page, context, errors } = await open('/app.html#installed-models');
    await page.waitForSelector('#lai-installed .card');
    const r = await fetch(baseUrl + '/api/local-ai/installs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    assert.equal(r.status, 202);
    assert.equal((await until(async () => { const j = await jobOf(model); return j && j.state === 'failed' && j; }, 10000, 'the interruption')).code, 'interrupted');
    await page.waitForSelector('#lai-jobs .lai-job[data-model="' + model + '" i] [data-act="resume"]');
    assert.match(await page.textContent('#lai-jobs'), /Resume to continue from where it stopped/);
    await press(page, '#lai-jobs [data-act="resume"][data-model="' + model + '" i]');
    const done = await until(async () => { const j = await jobOf(model); return j && j.state === 'done' && j; }, 15000, 'the download');
    assert.equal(done.resumed, true, 'it continued where it stopped');
    await page.waitForFunction(m => ((document.querySelector('#lai-installed tbody') || {}).textContent || '').includes(m), model);
    await page.waitForFunction(() => !document.querySelector('#lai-jobs .lai-job'));
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    si.st.breakAt = null;
    forget(model);
  }
});

test('Another device: the admin token is checked before it is kept, a refused one is said so, and it can be forgotten', { skip, timeout: 90000 }, async () => {
  process.env.LOCAL_AI_ADMIN_TOKEN = 'store-admin-token-2026';
  try {
    // (a request that a proxy forwarded is never "this machine")
    const { page, context, errors } = await open('/app.html#dashboard', { context: { extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } } });
    const saved = () => page.evaluate(() => localStorage.getItem('metacode_local_ai_token'));
    const notes = () => page.textContent('#notif-stack');
    const clearNotes = () => page.evaluate(() => { document.getElementById('notif-stack').innerHTML = ''; });
    // A token saved by an earlier version with a character fetch can't send (an en dash): the Store still opens,
    // and the token is forgotten, saying so
    await page.evaluate(() => localStorage.setItem('metacode_local_ai_token', 'store–admin-token-2026'));
    await page.evaluate(() => { location.hash = '#model-store'; });
    await page.waitForSelector('.lai-locked #lai-token', { timeout: 15000 });
    assert.equal(await saved(), null);
    assert.equal(await has(page, '.lai-problem'), false);
    assert.match(await notes(), /so it was forgotten/);
    // Typed again with the dash: not kept, and said why; one too short, the same
    await clearNotes();
    await page.fill('#lai-token', 'store–admin-token-2026');
    await page.click('[data-act="token"]');
    await page.waitForFunction(() => /can't send/.test(document.getElementById('notif-stack').textContent));
    assert.equal(await saved(), null);
    await page.fill('#lai-token', 'short-token');
    await page.click('[data-act="token"]');
    await page.waitForFunction(() => /at least 12 characters/.test(document.getElementById('notif-stack').textContent));
    assert.equal(await saved(), null);
    // A wrong token: kept, and the page says the server refused it
    await page.fill('#lai-token', 'store-admin-token-2025');
    await page.click('[data-act="token"]');
    await page.waitForFunction(() => /refused the admin token/.test((document.querySelector('.lai-locked') || {}).textContent || ''));
    assert.equal(await saved(), 'store-admin-token-2025');
    await page.click('[data-act="forget-token"]');
    await page.waitForFunction(() => { const l = document.querySelector('.lai-locked'); return l && !/refused/.test(l.textContent); });
    assert.equal(await saved(), null);
    // The right one: models can be installed from here, and the page says a token is in use
    await page.fill('#lai-token', 'store-admin-token-2026');
    await page.click('[data-act="token"]');
    await page.waitForSelector('.lai-head');
    await page.waitForFunction(() => !document.querySelector('.lai-locked') && document.querySelector('.lai-card [data-act="install"]'));
    assert.equal(await saved(), 'store-admin-token-2026');
    assert.match(await page.textContent('.lai-tokenline'), /admin token kept in this browser/);
    // When the store can't be shown, the token can still be forgotten
    const isStatus = u => new URL(u).pathname === '/api/local-ai/status';
    await page.route(isStatus, route => route.fulfill({ status: 500, json: { error: { message: 'Something broke.' } } }));
    await revisit(page, '#model-store', '.lai-problem');
    assert.match(await page.textContent('.lai-problem'), /Something broke\./);
    await page.click('.lai-problem [data-act="forget-token"]');
    await until(async () => (await saved()) === null, 5000, 'the token to be forgotten');
    await page.unroute(isStatus);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    delete process.env.LOCAL_AI_ADMIN_TOKEN;
  }
});

test('Another device: an admin token with spaces or a Latin-1 letter (a passphrase) is kept and works; a control character isn\'t', { skip, timeout: 90000 }, async () => {
  try {
    const { page, context, errors } = await open('/app.html#dashboard', { context: { extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } } });
    const saved = () => page.evaluate(() => localStorage.getItem('metacode_local_ai_token'));
    for (const t of ['correct horse battery staple', 'Passwörter-sind-sicher-2026']) {
      process.env.LOCAL_AI_ADMIN_TOKEN = t;
      await page.evaluate(() => { localStorage.removeItem('metacode_local_ai_token'); location.hash = '#dashboard'; });
      await page.evaluate(() => { location.hash = '#model-store'; });
      await page.waitForSelector('.lai-locked #lai-token', { timeout: 15000 });
      await page.fill('#lai-token', t);
      await page.click('[data-act="token"]');
      await page.waitForFunction(() => !document.querySelector('.lai-locked') && document.querySelector('.lai-card [data-act="install"]'), null, { timeout: 15000 });
      assert.equal(await saved(), t);
    }
    // (a browser sends a control character, but the server's HTTP parser refuses it: every request would fail)
    await page.evaluate(() => { localStorage.removeItem('metacode_local_ai_token'); location.hash = '#dashboard'; });
    await page.evaluate(() => { location.hash = '#model-store'; });
    await page.waitForSelector('.lai-locked #lai-token', { timeout: 15000 });
    await page.fill('#lai-token', 'abc\x01def-ghi-123');
    await page.click('[data-act="token"]');
    await page.waitForFunction(() => /can't send/.test(document.getElementById('notif-stack').textContent));
    assert.equal(await saved(), null);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    delete process.env.LOCAL_AI_ADMIN_TOKEN;
  }
});

test('AI Chat: leaving mid-answer stops it; notes and errors aren\'t sent back as the model\'s words; a cut-off answer says so; Enter in an IME doesn\'t send', { skip, timeout: 90000 }, async () => {
  si.st.installed.set('gemma3:270m', { digest: 'x', size: 6000800 });
  const { page, context, errors } = await open('/app.html#ai-chat');
  await page.waitForSelector('#lai-chat-model');
  const answers = () => page.$$eval('.lai-assistant', els => els.map(e => e.textContent));
  const ask = async (text, n) => {
    await page.fill('#lai-chat-input', text);
    await page.press('#lai-chat-input', 'Enter');
    await page.waitForFunction(k => document.querySelectorAll('.lai-assistant').length === k && !/^…$/.test(document.querySelectorAll('.lai-assistant')[k - 1].textContent) &&
      document.getElementById('lai-stop').hidden, n);
  };
  // Leaving the page mid-answer stops the answer (the AI service sees the browser go)
  await page.fill('#lai-chat-input', 'Tell me slowly about codebooks');
  await page.press('#lai-chat-input', 'Enter');
  await page.waitForFunction(() => /word1 /.test((document.querySelector('.lai-assistant') || {}).textContent || ''));
  const slow = streams[streams.length - 1];
  await page.evaluate(() => { location.hash = '#dashboard'; });
  await until(() => slow.closed, 3000, 'the answer to stop');
  // Back on the page, the next question is sent
  await page.evaluate(() => { location.hash = '#ai-chat'; });
  await page.waitForSelector('#lai-chat-model');
  assert.match((await answers())[0], /^word0 word1 .*\(stopped\)$/);
  const before = chats.length;
  await ask('Think about codes', 2);
  assert.equal(chats.length, before + 1);
  assert.match((await answers())[1], /length limit/);
  assert.doesNotMatch((await answers())[1], /stopped/);
  await ask('Tell me about it at length', 3);
  assert.match((await answers())[2], /^It goes on and on.*cut off/);
  await ask('Now fail', 4);
  assert.match((await answers())[3], /⚠.*ran out of memory/);
  await ask('What is a codebook?', 5);
  assert.match((await answers())[4], /^A codebook lists the codes and their rules\.$/);
  // What the model was sent: only its own words, and no question that got no answer
  const sent = chats[chats.length - 1].messages;
  assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(sent[0].content, 'Tell me slowly about codebooks');
  assert.match(sent[1].content, /^word0 word1 /);
  assert.deepEqual(sent.slice(2).map(m => m.content), ['Tell me about it at length', 'It goes on and on', 'What is a codebook?']);
  assert.ok(!sent.some(m => /stopped|length limit|cut off|⚠/.test(m.content)), JSON.stringify(sent));
  // Enter that confirms an IME candidate doesn't send the half-typed text (Chrome marks it isComposing, Safari only
  // with keyCode 229)
  const n = chats.length;
  await page.fill('#lai-chat-input', 'にほんご');
  await page.$eval('#lai-chat-input', el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  await page.$eval('#lai-chat-input', el => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { get: () => 229 });
    el.dispatchEvent(e);
  });
  await sleep(400);
  assert.equal(chats.length, n);
  assert.equal(await page.inputValue('#lai-chat-input'), 'にほんご');
  // (and a plain Enter sends it)
  await page.press('#lai-chat-input', 'Enter');
  await until(() => chats.length === n + 1, 5000, 'the question');
  assert.equal(chats[n].messages.slice(-1)[0].content, 'にほんご');
  assert.deepEqual(errors, []);
  await context.close();
});

test('AI Chat says why no model can answer: the server can\'t be reached, Ollama isn\'t running, or the AI service\'s own reason', { skip, timeout: 90000 }, async () => {
  si.st.installed.set('gemma3:270m', { digest: 'x', size: 6000800 });
  const { page, context, errors } = await open('/app.html#ai-chat');
  await page.waitForSelector('#lai-chat-model');
  const head = () => page.textContent('.lai-chat-head');
  const isModels = u => new URL(u).pathname === '/api/models';
  const isStatus = u => new URL(u).pathname === '/api/local-ai/status';
  // The MetaCode server can't be reached
  await page.route(isModels, route => route.abort());
  await revisit(page, '#ai-chat', '.lai-chat-head');
  assert.match(await head(), /MetaCode server can't be reached/);
  assert.doesNotMatch(await head(), /Install one/);
  await page.unroute(isModels);
  // Ollama isn't running (the AI service hides its models then)
  const installed = new Map(si.st.installed);
  si.st.installed.clear();
  try {
    await page.route(isStatus, async route => {
      const r = await route.fetch();
      const j = await r.json();
      j.ollama.running = false; j.ollama.version = null;
      return route.fulfill({ response: r, json: j });
    });
    await revisit(page, '#ai-chat', '.lai-chat-head');
    assert.match(await head(), /Ollama isn't running/);
    await page.unroute(isStatus);
    // Ollama runs but the AI service offers nothing: its own reason
    await revisit(page, '#ai-chat', '.lai-chat-head');
    const note = await page.evaluate(async () => (await (await fetch('/api/models')).json()).note);
    assert.ok(note, 'the server says why');
    assert.ok((await head()).includes(note), await head());
    // Ollama runs and only cloud models are offered: install one
    await page.route(isModels, route => route.fulfill({ json: { models: [{ id: 'opencode/big-model', name: 'Big model' }], providers: [] } }));
    await revisit(page, '#ai-chat', '.lai-chat-head');
    assert.match(await head(), /No model on this device can answer yet\. Install one in the AI Model Store/);
  } finally {
    installed.forEach((v, k) => si.st.installed.set(k, v));
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('System: when the server can\'t be reached it says so, not what an earlier visit showed', { skip, timeout: 60000 }, async () => {
  const { page, context, errors } = await open('/app.html#system');
  await page.waitForSelector('.lai-sys');
  assert.match(await page.textContent('.lai-sys'), /Disk for models/);
  await page.route(u => new URL(u).pathname.startsWith('/api/local-ai/'), route => route.abort());
  await revisit(page, '#system', '.lai-sys');
  const text = await page.textContent('.lai-sys');
  assert.match(text, /It can't be reached right now/);
  assert.doesNotMatch(text, /Disk for models/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('AI Model Store: the catalog\'s age, sorting by size, a late Details answer stays out of another model\'s, no Ollama on 32-bit ARM', { skip, timeout: 90000 }, async () => {
  const fiveHoursAgo = new Date(Date.now() - 5 * 3600e3).toISOString();
  const { page, context, errors } = await open('/app.html#model-store', {
    setup: ctx => ctx.route(u => new URL(u).pathname === '/api/local-ai/catalog', async route => {
      const r = await route.fetch();
      const j = await r.json();
      j.source = 'live'; j.fetchedAt = fiveHoursAgo;
      // (two models whose tags aren't known yet: one has size badges, the other none)
      j.models.forEach(m => { if (m.name === 'qwen2.5-coder' || m.name === 'nomic-embed-text') m.tags = []; });
      return route.fulfill({ response: r, json: j });
    }),
  });
  await page.waitForSelector('.lai-source');
  assert.match(await page.textContent('.lai-source'), /Catalog: from ollama\.com 5 h ago · 4 models/);
  // Sorting by size: the smallest download first (gemma3:270m, 292 MB); without known tags, the smallest size badge
  // (qwen2.5-coder's 0.5b, about 300 MB at 4 bits) before deepseek-r1:1.5b (1.1 GB); a model with neither comes last
  await page.click('.lai-tab[data-tab="all"]');
  await page.selectOption('#lai-sort', 'size');
  await page.waitForFunction(() => document.querySelector('.lai-grid .lai-card h4').textContent === 'gemma3');
  assert.deepEqual(await page.$$eval('.lai-grid .lai-card h4', els => els.map(e => e.textContent)), ['gemma3', 'qwen2.5-coder', 'deepseek-r1', 'nomic-embed-text']);
  assert.equal(await page.inputValue('#lai-sort'), 'size');
  // Details: qwen2.5-coder's answer is slow; closed, and gemma3's opened, the late answer stays out
  let release;
  const held = new Promise(r => { release = r; });
  await page.route(u => new URL(u).pathname === '/api/local-ai/catalog/model' && new URL(u).searchParams.get('name') === 'qwen2.5-coder', async route => { await held; return route.continue(); });
  await page.click('.lai-card [data-act="details"][data-name="qwen2.5-coder"]');
  await page.waitForSelector('#modal-backdrop.is-open');
  await page.keyboard.press('Escape');
  await page.click('.lai-card [data-act="details"][data-name="gemma3"]');
  await page.waitForSelector('.lai-table [data-install-for="gemma3:270m"]');
  const late = page.waitForResponse(r => r.url().includes('name=qwen2.5-coder'));
  release();
  await late;
  await sleep(300);
  assert.equal(await page.textContent('#modal-title'), 'gemma3');
  assert.ok(await page.$('.lai-table [data-install-for="gemma3:270m"]'), 'gemma3\'s sizes are still shown');
  assert.doesNotMatch(await page.textContent('#modal-body'), /Code-Specific Qwen/);
  await page.keyboard.press('Escape');
  // Ollama not running: the pages say what the server says about it, as System does (here the server's own answers
  // for a 64-bit Linux machine, where it says how to install it, and for 32-bit ARM, which has none)
  const { createRuntimes, MATRIX } = require('../local-ai/runtimes');
  const runtimesOf = (os, arch) => createRuntimes({ ollama: { version: async () => null, base: () => 'http://127.0.0.1:11434' } }).list({ os, arch });
  const x64 = await runtimesOf({ platform: 'linux', name: 'Ubuntu 24.04' }, 'x64');
  const arm = await runtimesOf({ platform: 'linux', name: 'Raspberry Pi OS' }, 'arm');
  assert.equal(x64.runtimes[0].status, 'not-running');
  assert.equal(arm.runtimes[0].status, 'unsupported');
  let runtimes = x64;
  const edit = (pathname, fn) => page.route(u => new URL(u).pathname === pathname, async route => { const r = await route.fetch(); const j = await r.json(); fn(j); return route.fulfill({ response: r, json: j }); });
  await edit('/api/local-ai/status', j => { j.ollama.running = false; j.ollama.version = null; });
  await page.route(u => new URL(u).pathname === '/api/local-ai/runtimes', route => route.fulfill({ json: Object.assign({}, runtimes, { matrix: MATRIX }) }));
  await revisit(page, '#model-store', '.lai-head');
  assert.match(await page.textContent('.lai-head'), /Ollama isn't running/);
  assert.ok((await page.textContent('.lai-head')).includes(x64.runtimes[0].detail), await page.textContent('.lai-head'));
  // 32-bit ARM (and the memory free now not known, as on a Mac whose vm_stat didn't answer)
  runtimes = arm;
  await edit('/api/local-ai/hardware', j => { j.arch = 'arm'; j.memory.available = null; });
  await revisit(page, '#model-store', '.lai-head');
  const head = await page.textContent('.lai-head');
  assert.match(head, /No Ollama for this system/);
  assert.match(head, /There is no Ollama for this system \(32-bit ARM Linux/);
  assert.doesNotMatch(head, /Install it from ollama\.com/);
  assert.match(await page.textContent('.lai-chips'), / RAM\d+ CPU threads, arm/);
  assert.doesNotMatch(await page.textContent('.lai-chips'), /\?/);
  await revisit(page, '#system', '.lai-sys');
  assert.match(await page.textContent('.lai-sys'), /Memory\d+ (GB|MB)GPU/);       // (no "(? available)")
  await revisit(page, '#installed-models', '#lai-installed .card');
  assert.match(await page.textContent('#lai-installed'), /There is no Ollama for this system/);
  assert.doesNotMatch(await page.textContent('.lai-head'), /Install it from ollama\.com/);
  await page.route(u => new URL(u).pathname === '/api/models', route => route.fulfill({ json: { models: [], providers: [], note: 'No AI model on this computer is ready.' } }));
  await revisit(page, '#ai-chat', '.lai-chat-head');
  assert.match(await page.textContent('.lai-chat-head'), /There is no Ollama for this system/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Installed Models shows Ollama\'s list at once while MetaCode\'s AI service is slow to say which models it offers, and offers none until it has', { skip, timeout: 60000 }, async () => {
  si.st.installed.set('gemma3:270m', { digest: 'x', size: 6000800 });
  let release;
  const held = new Promise(r => { release = r; });
  try {
    // (the AI service's list doesn't come: /api/models is held back)
    const { page, context, errors } = await open('/app.html#dashboard', { setup: c => c.route(u => new URL(u).pathname === '/api/models', async route => { await held; await route.continue().catch(() => {}); }) });
    await page.evaluate(() => { location.hash = '#installed-models'; });
    await page.waitForSelector('#lai-installed tbody tr', { timeout: 5000 });
    assert.match(await page.textContent('#lai-installed tbody'), /Checking whether MetaCode's AI service offers it…/);
    assert.ok(await page.$('[data-act="load"][data-model="gemma3:270m"]'), 'Load, Stop, Settings and Delete need only Ollama');
    assert.equal(await has(page, '[data-act="default"][data-model="gemma3:270m"]'), false);
    assert.equal(await page.$$eval('select[data-feature="coding"] option', os => os.length), 1, 'no model offered for a feature yet');
    // once it answers: offered
    release();
    await page.waitForSelector('#lai-installed[data-offered="known"] [data-act="default"][data-model="gemma3:270m"]');
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    release();
  }
});

test('Installed Models: a model the AI service doesn\'t offer (an embedding model) isn\'t offered as the default or a feature\'s model; two names for the same files say so', { skip, timeout: 60000 }, async () => {
  si.st.installed.set('gemma3:270m', { digest: 'x', size: 6000800 });
  si.st.installed.set('nomic-embed-text:latest', { digest: 'y', size: 274302450 });
  // (`ollama pull gemma3`, then gemma3:4b from the Store: one model under two names)
  si.st.installed.set('gemma3:latest', { digest: 'd'.repeat(64), size: 3338801804 });
  si.st.installed.set('gemma3:4b', { digest: 'd'.repeat(64), size: 3338801804 });
  try {
    const { page, context, errors } = await open('/app.html#installed-models');
    await page.waitForFunction(() => /nomic-embed-text/.test((document.querySelector('#lai-installed tbody') || {}).textContent || ''));
    // (what MetaCode's AI service offers is filled in once it answers)
    const answered = () => page.waitForSelector('#lai-installed[data-offered="known"] tbody');
    await answered();
    const rowOf = name => page.$$eval('#lai-installed tbody tr', (trs, n) => trs.map(t => t.textContent).find(t => t.startsWith(n)), name);
    assert.ok(await page.$('[data-act="default"][data-model="gemma3:270m"]'));
    assert.equal(await has(page, '[data-act="default"][data-model="nomic-embed-text:latest"]'), false);
    assert.match(await rowOf('nomic-embed-text'), /Not offered for AI features: an embedding model/);
    const options = await page.$$eval('select[data-feature="coding"] option', os => os.map(o => o.value));
    assert.ok(options.includes('ollama/gemma3:270m'));
    assert.ok(!options.includes('ollama/nomic-embed-text:latest'), JSON.stringify(options));
    // A model the AI service doesn't list (METACODE_OLLAMA_MODELS can leave models out): not offered either. An
    // embedding model never is, even when a service set up by hand lists it.
    await page.route(u => new URL(u).pathname === '/api/models', async route => {
      const r = await route.fetch();
      const j = await r.json();
      j.models = j.models.filter(m => m.id !== 'ollama/gemma3:270m').concat([{ id: 'ollama/nomic-embed-text:latest', name: 'nomic-embed-text:latest (on this device)', provider: 'ollama', local: true }]);
      return route.fulfill({ response: r, json: j });
    });
    await revisit(page, '#installed-models', '#lai-installed tbody');
    await answered();
    assert.equal(await has(page, '[data-act="default"][data-model="gemma3:270m"]'), false);
    assert.match(await rowOf('gemma3:270m'), /Not offered for AI features: MetaCode's AI service doesn't list it/);
    const offered = await page.$$eval('select[data-feature="coding"] option', os => os.map(o => o.value));
    assert.ok(!offered.includes('ollama/gemma3:270m') && !offered.includes('ollama/nomic-embed-text:latest'), JSON.stringify(offered));
    assert.equal(await has(page, '[data-act="default"][data-model="nomic-embed-text:latest"]'), false);
    assert.match(await rowOf('nomic-embed-text'), /Not offered for AI features: an embedding model/);
    assert.ok(await page.$('[data-act="default"][data-model="gemma3:4b"]'));
    // The same files under two names: each row says so, and so does Delete (it would free nothing)
    assert.match(await rowOf('gemma3:4b'), /the same files as gemma3:latest/);
    assert.match(await rowOf('gemma3:latest'), /the same files as gemma3:4b/);
    await page.click('[data-act="delete"][data-model="gemma3:latest"]');
    await page.waitForSelector('#lai-del-ok');
    assert.match(await page.textContent('#modal-body'), /gemma3:latest has the same files as gemma3:4b.*frees no disk space while gemma3:4b stays/);
    await page.evaluate(() => App.closeModal());
    await page.click('[data-act="delete"][data-model="nomic-embed-text:latest"]');
    await page.waitForSelector('#lai-del-ok');
    assert.match(await page.textContent('#modal-body'), /It is removed from this computer \(274 MB\)/);
    await page.evaluate(() => App.closeModal());
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    for (const m of ['nomic-embed-text:latest', 'gemma3:latest', 'gemma3:4b']) si.st.installed.delete(m);
  }
});

test('Names in another case: a tag the catalog spells with capitals shows its download and then Installed; a model Ollama lists in capitals counts as installed', { skip, timeout: 90000 }, async () => {
  const had = si.st.installed.get('gemma3:270m');
  si.st.installed.delete('gemma3:270m');
  si.st.installed.set('Gemma3:270M', { digest: 'e'.repeat(64), size: 291554930 });   // (pulled as "Gemma3:270M")
  forget('gemma3:1b');
  si.st.pullDelayMs = 150;
  try {
    const { page, context, errors } = await open('/app.html#model-store', {
      setup: ctx => ctx.route(u => new URL(u).pathname === '/api/local-ai/catalog/model', async route => {
        const r = await route.fetch();
        const j = await r.json();
        (j.tags || []).forEach(t => { if (t.tag === 'gemma3:1b') t.tag = 'gemma3:1B'; });
        return route.fulfill({ response: r, json: j });
      }),
    });
    await page.waitForSelector('.lai-tier .lai-card');
    await page.click('.lai-tab[data-tab="all"]');
    await page.click('.lai-card [data-act="details"][data-name="gemma3"]');
    await page.waitForSelector('.lai-table [data-install-for="gemma3:1B"]');
    assert.equal(await page.textContent('.lai-table [data-install-for="gemma3:270m"]'), 'Installed');
    await page.click('.lai-table [data-act="install"][data-model="gemma3:1B"]');
    // (the server's name for the download may differ in case: it keys downloads in lowercase)
    assert.ok(await until(() => jobOf('gemma3:1b'), 5000, 'the download'));
    await page.waitForFunction(() => /\d+%/.test(document.querySelector('.lai-table [data-install-for="gemma3:1B"]').textContent));
    await page.waitForFunction(() => document.querySelector('.lai-table [data-install-for="gemma3:1B"]').textContent === 'Installed', null, { timeout: 15000 });
    assert.ok(installedHas('gemma3:1b'));
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    si.st.installed.delete('Gemma3:270M');
    if (had) si.st.installed.set('gemma3:270m', had);
    si.st.pullDelayMs = 25;
  }
});
