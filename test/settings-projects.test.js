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
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] }));
      if (req.url === '/v1/chat/completions') {
        const j = JSON.parse(body || '{}');
        seenModels.push(j.model);
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
  assert.deepEqual(models.slice().sort(), ['model-a', 'model-b', 'model-c']);
});

test('projects API: save, list, open, update, duplicate, delete; guarded and validated', async () => {
  const data = { project: { name: 'Study A', description: 'd' }, posts: [{ id: 'p1', text: 'hello', aiCodes: { s: 'pos' }, humanCodes: {} }, { id: 'p2', text: 'x' }], codebook: [{ id: 'dim', codes: [] }], network: { nodes: [], edges: [] }, settings: { secret: 'no' } };
  const created = await json('POST', '/api/projects', { name: 'Study A', data });
  assert.equal(created.status, 201);
  const id = created.json.project.id;
  assert.match(id, /^pr_[A-Za-z0-9]+$/);
  assert.deepEqual(created.json.project.counts, { posts: 2, aiCoded: 1, humanCoded: 0, dimensions: 1, nodes: 0, edges: 0 });
  const list = (await json('GET', '/api/projects')).json.projects;
  assert.ok(list.some(p => p.id === id && p.name === 'Study A'));
  const got = (await json('GET', '/api/projects/' + id)).json.project;
  assert.equal(got.data.posts.length, 2);
  assert.equal(got.data.settings, undefined, 'browser settings are never stored with a project');
  const put = await json('PUT', '/api/projects/' + id, { name: 'Study A v2', data: Object.assign({}, data, { posts: data.posts.slice(0, 1) }) });
  assert.equal(put.json.project.revision, 2);
  assert.equal(put.json.project.counts.posts, 1);
  const dup = await json('POST', '/api/projects/' + id + '/duplicate', {});
  assert.equal(dup.json.project.name, 'Study A v2 (copy)');
  assert.equal((await json('DELETE', '/api/projects/' + dup.json.project.id)).status, 200);
  assert.equal((await json('GET', '/api/projects/' + dup.json.project.id)).status, 404);
  assert.equal((await json('GET', '/api/projects/../../etc')).status, 404);
  assert.equal((await json('POST', '/api/projects', { data: 'nope' })).status, 400);
  assert.equal((await json('POST', '/api/projects', { name: 'x', data }, { Origin: 'https://evil.example' })).status, 403);
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

test('Projects page: save, autosave, new project, reopen a saved one', { skip: noBrowser, timeout: 120000 }, async () => {
  const { page, context, errors } = await openApp('#projects');
  await page.waitForSelector('#pj-current');
  // Put some data in the open project, then save it
  await page.evaluate(() => App.setState({ project: { name: 'Climate study', description: '' }, posts: [{ id: 'a', text: 'one', aiCodes: {}, humanCodes: {} }] }));
  await page.evaluate(() => ProjectsView.render());
  await page.click('#pj-saveas');
  await page.click('#pj-ok');
  await page.waitForFunction(() => ProjectsView.link() && /Climate study/.test(document.getElementById('pj-list').textContent));
  const saved = (await json('GET', '/api/projects')).json.projects.find(p => p.name === 'Climate study');
  assert.ok(saved);
  assert.equal(saved.counts.posts, 1);
  // Autosave: a change is saved to the server a few seconds later
  await page.evaluate(() => App.setState({ posts: App.getState().posts.concat([{ id: 'b', text: 'two', aiCodes: {}, humanCodes: {} }]) }));
  let counted = 0;
  for (let i = 0; i < 40 && counted !== 2; i++) {
    await new Promise(r => setTimeout(r, 400));
    counted = (await json('GET', '/api/projects/' + saved.id)).json.project.counts.posts;
  }
  assert.equal(counted, 2, 'autosaved to the server');
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
