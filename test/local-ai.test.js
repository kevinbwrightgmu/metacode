// The AI Model Store's server side (local-ai/): reading Ollama's library, recommendations that fit the device,
// and every /api/local-ai route against a stand-in Ollama that behaves like the real one (checked with Ollama
// 0.40): downloads stream progress per layer, a stopped download continues where it stopped, a missing model is
// an {"error"} line in a 200 stream, installed digests are the sha256 of the registry's manifest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { parseLibrary, parseTags, mainTags, categories, createCatalog } = require('../local-ai/catalog');
const { recommend, ramNeeded } = require('../local-ai/recommend');
const { createLocalAi } = require('../local-ai');
const { normalize } = require('../local-ai/installs');
const { standIns, manifestFor, MODEL_BYTES } = require('./helpers/ollama-standin');

const FIXTURES = path.join(__dirname, 'fixtures', 'ollama');
const LIBRARY_HTML = fs.readFileSync(path.join(FIXTURES, 'library.html'), 'utf8');
const TAGS_HTML = fs.readFileSync(path.join(FIXTURES, 'gemma3-tags.html'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GB = 1e9;

// ── Reading the library ─────────────────────────────────────────────────────

test('the library page: names, descriptions, capabilities, sizes, pulls and dates; cloud-only models left out', () => {
  const models = parseLibrary(LIBRARY_HTML);
  assert.deepEqual(models.map(m => m.name), ['gemma3', 'deepseek-r1', 'nomic-embed-text', 'qwen2.5-coder']);
  const g = models[0];
  assert.equal(g.description, 'The current, most capable model that runs on a single GPU.');
  assert.deepEqual(g.capabilities, ['vision']);
  assert.deepEqual(g.sizes, ['270m', '1b', '4b', '12b', '27b']);
  assert.equal(g.pulls, 42000000);
  assert.match(g.updated, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(models[1].capabilities, ['tools', 'thinking']);
  assert.deepEqual(categories(models[1]).sort(), ['general', 'reasoning', 'small']);
  assert.deepEqual(categories(models[2]), ['embedding']);
  assert.ok(categories(models[3]).includes('coding'));
  assert.ok(categories(g).includes('vision') && categories(g).includes('small'));
  assert.equal(parseLibrary('<html>nothing here</html>').length, 0);
});

test('a model\'s tags page: size, context window, inputs and digest per tag; the main tags first', () => {
  const tags = parseTags(TAGS_HTML, 'gemma3');
  assert.deepEqual(tags.find(t => t.tag === 'gemma3:270m'), { tag: 'gemma3:270m', digest: 'e7d36fb2c3b3', size: 292000000, context: 32768, inputs: ['text'] });
  assert.deepEqual(tags.find(t => t.tag === 'gemma3:4b').inputs, ['text', 'image']);
  const model = parseLibrary(LIBRARY_HTML)[0];
  assert.deepEqual(mainTags(model, tags).map(t => t.tag), ['gemma3:latest', 'gemma3:270m', 'gemma3:1b', 'gemma3:4b']);
});

test('the shipped snapshot: hundreds of local models with their tags, for a first start offline', () => {
  const snap = require('../local-ai/catalog-snapshot.json');
  assert.ok(snap.models.length >= 150, snap.models.length);
  assert.ok(Date.parse(snap.fetchedAt));
  assert.ok(snap.tags.gemma3 && snap.tags.gemma3.tags.some(t => t.tag === 'gemma3:270m' && t.size > 2e8));
  assert.ok(!snap.models.some(m => m.capabilities.includes('cloud')));
});

test('model names: library names only, ":latest" when there is no tag, never a cloud tag', () => {
  assert.equal(normalize('gemma3'), 'gemma3:latest');
  assert.equal(normalize('Gemma3:1B'), 'gemma3:1b');
  assert.equal(normalize('someone/model:q4'), 'someone/model:q4');
  for (const bad of ['', '../etc', 'a b', 'gpt-oss:120b-cloud', 'x;rm -rf', 'http://x/y']) assert.equal(normalize(bad), null, bad);
});

// ── Recommendations ─────────────────────────────────────────────────────────

const hw = (totalGb, gpus) => ({ memory: { total: totalGb * GB, available: totalGb * GB * 0.7 }, gpus: gpus || [], os: { platform: 'linux' }, arch: 'x64', disk: { free: 100 * GB } });
const catalogModels = () => {
  const models = parseLibrary(LIBRARY_HTML).map(m => Object.assign(m, { categories: categories(m) }));
  const tags = parseTags(TAGS_HTML, 'gemma3');
  models[0].tags = mainTags(models[0], tags);
  return models;
};

test('recommendations never exceed what the device can hold; the best tag that fits; tiers by real size', () => {
  // the measured footprint: gemma3:270m (292 MB) used 326 MB on CPU — the estimate is at least that, not wildly more
  const need270 = ramNeeded(292e6, 268e6);
  assert.ok(need270 >= 326e6 && need270 < 500e6, need270);
  for (const total of [2, 4, 8, 16, 64]) {
    const r = recommend(catalogModels(), hw(total));
    const all = r.tiers.flatMap(t => t.models);
    assert.ok(all.every(m => m.need <= r.device.budget), total + ' GB: ' + JSON.stringify(all.map(m => [m.tag, m.need])));
  }
  // 2 GB: only the 270m fits (the budget keeps 1.5 GB for the system)
  const tiny = recommend(catalogModels(), hw(2));
  const g = tiny.tiers.flatMap(t => t.models).find(m => m.name === 'gemma3');
  assert.equal(g.tag, 'gemma3:270m');
  assert.equal(tiny.tiers.find(t => t.id === 'ultra').models.some(m => m.name === 'gemma3'), true);
  // 8 GB: the biggest gemma3 that fits is 4b; it's in "Low resource"… or "Balanced" by its real need
  const mid = recommend(catalogModels(), hw(8)).tiers.flatMap(t => t.models).find(m => m.name === 'gemma3');
  assert.equal(mid.tag, 'gemma3:4b');
  assert.equal(mid.estimated, false);
  // A GPU with enough memory: the card says so
  const gpu = recommend(catalogModels(), hw(16, [{ vendor: 'nvidia', name: 'RTX', memory: 12 * GB, usable: true }]));
  assert.equal(gpu.device.gpu.name, 'RTX');
  assert.equal(gpu.tiers.flatMap(t => t.models).find(m => m.name === 'gemma3').runsOn, 'gpu');
  // 1 GB: nothing fits, and nothing is recommended
  assert.equal(recommend(catalogModels(), hw(1)).tiers.flatMap(t => t.models).length, 0);
});

// ── The routes, against stand-ins ───────────────────────────────────────────

let si, api, local, tmp, changed;
const disk = { free: 100 * GB };
test.before(async () => {
  si = await standIns();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-local-ai-'));
  changed = [];
  local = createLocalAi({
    env: { OLLAMA_BASE_URL: si.base + '/v1', LOCAL_AI_DATA_DIR: tmp, LOCAL_AI_ADMIN_TOKEN: 'admin-token-123456' },
    libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', minLibraryModels: 1,
    // (a request from "this machine" unless the test says it came through a proxy)
    isLoopback: req => req.get('x-test-remote') !== '1',
    hardware: { detect: async () => ({ os: { platform: 'linux', name: 'Test Linux' }, arch: 'x64', cpu: { model: 'Test CPU', threads: 4 }, memory: { total: 16 * GB, available: 12 * GB }, gpus: [], disk: { path: tmp, free: disk.free, total: 200 * GB } }) },
    onModelsChanged: (what, model) => changed.push([what, model]),
  });
  const app = express();
  app.use('/api/local-ai', local.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/local-ai';
  api = async (method, p, body, headers) => {
    const res = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text };
  };
  api.close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  api.port = server.address().port;
  api.events = () => {
    const events = [];
    const ac = new AbortController();
    fetch(base + '/installs/events', { signal: ac.signal }).then(async res => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = (/^event: (.+)$/m.exec(block) || [])[1];
          const data = (/^data: (.+)$/m.exec(block) || [])[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    }).catch(() => {});
    return { events, stop: () => ac.abort() };
  };
});
test.after(async () => {
  if (local) local.close();
  if (api) await api.close();
  if (si) await si.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
async function until(check, ms, what) {
  const deadline = Date.now() + (ms || 8000);
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + (what || 'a condition'));
    await sleep(25);
  }
}
const job = async model => (await api('GET', '/installs')).json.installs.find(j => j.model === model);

test('status, hardware and runtimes: Ollama found with its version; this machine may manage models; the compatibility matrix', async () => {
  const s = await api('GET', '/status');
  assert.equal(s.status, 200);
  assert.deepEqual([s.json.ollama.running, s.json.ollama.version, s.json.manage.allowed, s.json.manage.how], [true, '0.40.17', true, 'this-machine']);
  const remote = await api('GET', '/status', undefined, { 'x-test-remote': '1' });
  assert.equal(remote.json.manage.allowed, false);
  assert.match(remote.json.manage.reason, /admin token \(LOCAL_AI_ADMIN_TOKEN\)/);
  assert.equal((await api('GET', '/hardware')).json.cpu.threads, 4);
  const r = await api('GET', '/runtimes');
  assert.equal(r.json.runtimes[0].id, 'ollama');
  assert.equal(r.json.runtimes[0].status, 'running');
  assert.equal(r.json.platform.id, 'linux-x64');
  assert.ok(r.json.matrix.find(x => x.id === 'ios').ollama === 'no');
});

test('the catalog: read live from the library, then kept on disk; one model\'s tags each say how they fit this device', async () => {
  const c = await api('GET', '/catalog');
  assert.equal(c.json.source, 'live');
  assert.deepEqual(c.json.models.map(m => m.name), ['gemma3', 'deepseek-r1', 'nomic-embed-text', 'qwen2.5-coder']);
  assert.ok(fs.existsSync(path.join(tmp, 'catalog.json')));
  const g = await api('GET', '/catalog/model?name=gemma3&refresh=1');       // (every tag, from the tags page)
  assert.equal(g.status, 200);
  const t270 = g.json.tags.find(t => t.tag === 'gemma3:270m');
  assert.equal(t270.fit.level, 'good');
  assert.equal(g.json.tags.find(t => t.tag === 'gemma3:1b-it-qat').main, false);
  assert.equal((await api('GET', '/catalog/model?name=nope')).status, 404);
  const rec = await api('GET', '/recommendations');
  assert.ok(rec.json.tiers.flatMap(t => t.models).some(m => m.tag === 'gemma3:4b'));
});

test('the catalog offline: the copy kept on disk, or the shipped snapshot on a first start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-catalog-'));
  try {
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    const fresh = createCatalog({ dataDir: dir, fetch: offline });
    const r = await fresh.refresh(true);
    assert.equal(r.ok, false);
    assert.match(r.problem, /can't be reached/);
    assert.equal(fresh.list().source, 'snapshot');
    assert.ok(fresh.list().models.length >= 150);
    // with a copy on disk, that copy (and its date)
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ fetchedAt: '2026-11-01T00:00:00.000Z', models: parseLibrary(LIBRARY_HTML), tags: {} }));
    const cached = createCatalog({ dataDir: dir, fetch: offline });
    assert.deepEqual([cached.list().source, cached.list().fetchedAt, cached.list().models.length], ['cache', '2026-11-01T00:00:00.000Z', 4]);
    // a page that changed beyond reading: the copy stays
    const changedPage = createCatalog({ dataDir: dir, fetch: async () => new Response('<html>new design</html>', { status: 200 }) });
    assert.match((await changedPage.refresh(true)).problem, /couldn't be read/);
    assert.equal(changedPage.list().models.length, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install: progress, speed and time left as events; verified against the registry\'s digest; MetaCode told; the same model never twice at once', async () => {
  const ev = api.events();
  const r = await api('POST', '/installs', { model: 'gemma3:1b' });
  assert.equal(r.status, 202);
  assert.equal(r.json.job.model, 'gemma3:1b');
  const again = await api('POST', '/installs', { model: 'Gemma3:1b' });
  assert.equal(again.status, 200);
  assert.equal(again.json.already, true);
  await until(async () => { const j = await job('gemma3:1b'); return j && j.state === 'done'; }, 10000, 'the install');
  const j = await job('gemma3:1b');
  assert.equal(j.verified, true);
  assert.match(j.status, /verified/);
  assert.equal(si.st.pulls.filter(m => m === 'gemma3:1b').length, 1, 'one download');
  assert.deepEqual(changed.pop(), ['installed', 'gemma3:1b']);
  await sleep(50);
  ev.stop();
  const progress = ev.events.filter(e => e.type === 'job' && e.data.state === 'downloading' && e.data.percent !== null);
  assert.ok(progress.length >= 2, JSON.stringify(ev.events.map(e => e.data.state)));
  assert.ok(progress.some(e => e.data.percent > 0 && e.data.percent < 100));
  assert.ok(progress.every(e => e.data.total >= MODEL_BYTES));
  assert.ok(ev.events.some(e => e.data.state === 'done'));
  assert.equal(ev.events[0].type, 'snapshot');
  // Installed models: details, loaded or not, the space they use
  const m = await api('GET', '/models');
  assert.deepEqual(m.json.models.map(x => [x.name, x.loaded]), [['gemma3:1b', null]]);
  assert.equal(m.json.totalSize, manifestFor('gemma3:1b').size);
});

test('pause keeps what arrived and resume continues from there; cancel forgets the download', async () => {
  si.st.pullDelayMs = 60;
  await api('POST', '/installs', { model: 'qwen2.5-coder:0.5b' });
  await until(async () => { const j = await job('qwen2.5-coder:0.5b'); return j && j.completed >= MODEL_BYTES * 0.2; }, 8000, 'some progress');
  assert.equal((await api('POST', '/installs/pause', { model: 'qwen2.5-coder:0.5b' })).status, 200);
  await until(async () => (await job('qwen2.5-coder:0.5b')).state === 'paused', 5000, 'paused');
  const kept = si.st.partial.get('qwen2.5-coder:0.5b');
  assert.ok(kept > 0 && kept < MODEL_BYTES);
  si.st.pullDelayMs = 10;
  await api('POST', '/installs/resume', { model: 'qwen2.5-coder:0.5b' });
  await until(async () => (await job('qwen2.5-coder:0.5b')).state === 'done', 8000, 'done after resuming');
  const j = await job('qwen2.5-coder:0.5b');
  assert.equal(j.resumed, true, 'Ollama continued the earlier download');
  // cancel
  si.st.pullDelayMs = 80;
  await api('POST', '/installs', { model: 'deepseek-r1:1.5b' });
  await until(async () => { const x = await job('deepseek-r1:1.5b'); return x && x.state === 'downloading'; });
  await api('POST', '/installs/cancel', { model: 'deepseek-r1:1.5b' });
  await until(async () => !(await job('deepseek-r1:1.5b')), 5000, 'gone');
  si.st.pullDelayMs = 25;
});

test('problems: no such model, not enough disk, an interrupted download (resumable), a digest that doesn\'t match', async () => {
  // a name the library doesn't have
  await api('POST', '/installs', { model: 'missing-model:1b' });
  await until(async () => { const j = await job('missing-model:1b'); return j && j.state === 'failed'; });
  assert.equal((await job('missing-model:1b')).code, 'not_in_library');
  // not enough disk for the manifest's size
  disk.free = MODEL_BYTES / 2;
  await api('POST', '/installs', { model: 'gemma3:4b' });
  await until(async () => { const j = await job('gemma3:4b'); return j && j.state === 'failed'; });
  const d = await job('gemma3:4b');
  assert.equal(d.code, 'insufficient_disk');
  assert.match(d.error, /Not enough disk space: gemma3:4b needs/);
  assert.ok(!si.st.pulls.includes('gemma3:4b'), 'nothing downloaded');
  disk.free = 100 * GB;
  // the stream stops half-way: failed, and resuming continues
  si.st.breakAt = MODEL_BYTES / 2;
  await api('POST', '/installs', { model: 'gemma3:270m' });
  await until(async () => { const j = await job('gemma3:270m'); return j && j.state === 'failed'; });
  const broken = await job('gemma3:270m');
  assert.equal(broken.code, 'interrupted');
  assert.match(broken.error, /Resume to continue/);
  await api('POST', '/installs/resume', { model: 'gemma3:270m' });
  await until(async () => (await job('gemma3:270m')).state === 'done');
  assert.equal((await job('gemma3:270m')).verified, true);
  // installed, but not what the registry has
  si.st.wrongDigest = true;
  await api('POST', '/installs', { model: 'nomic-embed-text:latest' });
  await until(async () => { const j = await job('nomic-embed-text:latest'); return j && j.state === 'done'; });
  assert.equal((await job('nomic-embed-text:latest')).verified, false);
  si.st.wrongDigest = false;
  assert.equal((await api('POST', '/installs', { model: '../../etc/passwd' })).status, 400);
});

test('installed models: load, unload with keep-alive from the model\'s settings, delete (not while downloading), update', async () => {
  const bad = await api('PUT', '/models/settings', { model: 'gemma3:1b', settings: { temperature: 7 } });
  assert.equal(bad.status, 400);
  const s = await api('PUT', '/models/settings', { model: 'gemma3:1b', settings: { temperature: 0.3, maxTokens: 512, keepAliveMinutes: 30 } });
  assert.deepEqual(s.json.settings, { temperature: 0.3, maxTokens: 512, keepAliveMinutes: 30 });
  assert.deepEqual(local.modelSettings('ollama/gemma3:1b'), { temperature: 0.3, maxTokens: 512, keepAliveMinutes: 30 });
  let m = await api('POST', '/models/load', { model: 'gemma3:1b' });
  assert.deepEqual(si.st.loads.pop(), ['gemma3:1b', '30m']);
  assert.ok(m.json.models.find(x => x.name === 'gemma3:1b').loaded);
  m = await api('POST', '/models/unload', { model: 'gemma3:1b' });
  assert.equal(m.json.models.find(x => x.name === 'gemma3:1b').loaded, null);
  // update = pull again
  const u = await api('POST', '/models/update', { model: 'gemma3:1b' });
  assert.equal(u.status, 202);
  assert.equal(u.json.job.update, true);
  await until(async () => (await job('gemma3:1b')).state === 'done');
  // delete: not while it downloads
  si.st.pullDelayMs = 80;
  await api('POST', '/installs', { model: 'deepseek-r1:7b' });
  await until(async () => { const x = await job('deepseek-r1:7b'); return x && x.state === 'downloading'; });
  assert.equal((await api('POST', '/models/delete', { model: 'deepseek-r1:7b' })).status, 409);
  await api('POST', '/installs/cancel', { model: 'deepseek-r1:7b' });
  si.st.pullDelayMs = 25;
  const del = await api('POST', '/models/delete', { model: 'gemma3:1b' });
  assert.equal(del.status, 200);
  assert.ok(!del.json.models.some(x => x.name === 'gemma3:1b'));
  assert.deepEqual(changed.pop(), ['deleted', 'gemma3:1b']);
  assert.equal(local.modelSettings('gemma3:1b'), null, 'its settings went with it');
  assert.equal((await api('POST', '/models/delete', { model: 'gemma3:1b' })).status, 404);
});

test('managing models from another device needs the admin token; browsing doesn\'t', async () => {
  const remote = { 'x-test-remote': '1' };
  for (const [method, p, body] of [['POST', '/installs', { model: 'gemma3:270m' }], ['POST', '/models/delete', { model: 'gemma3:270m' }], ['POST', '/models/load', { model: 'gemma3:270m' }], ['PUT', '/models/settings', { model: 'gemma3:270m', settings: {} }], ['POST', '/installs/cancel', { model: 'x:1' }], ['POST', '/runtimes/scan']]) {
    const r = await api(method, p, body, remote);
    assert.equal(r.status, 403, p);
    assert.equal(r.json.error.code, 'manage_locked');
  }
  assert.equal((await api('GET', '/catalog', undefined, remote)).status, 200);
  assert.equal((await api('GET', '/models', undefined, remote)).status, 200);
  const wrong = await api('POST', '/models/load', { model: 'gemma3:270m' }, Object.assign({ 'x-metacode-admin-token': 'nope' }, remote));
  assert.equal(wrong.status, 403);
  const right = await api('POST', '/models/load', { model: 'gemma3:270m' }, Object.assign({ 'x-metacode-admin-token': 'admin-token-123456' }, remote));
  assert.equal(right.status, 200);
  assert.equal((await api('GET', '/status', undefined, Object.assign({ 'x-metacode-admin-token': 'admin-token-123456' }, remote))).json.manage.how, 'token');
});

test('another website whose name is pointed at 127.0.0.1 (DNS rebinding) can\'t manage models; this machine\'s own names can', async () => {
  // (a request with any Host header: a page can't choose it, and fetch doesn't let this test either)
  const raw = (method, p, host, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, path: '/api/local-ai' + p, method, headers: { host, 'content-type': 'application/json' } }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  for (const host of ['evil.example:' + api.port, 'evil.example', '127.0.0.1.evil.example', 'localhost.evil.example:' + api.port]) {
    assert.equal((await raw('GET', '/status', host)).json.manage.allowed, false, host);
    const r = await raw('POST', '/models/load', host, { model: 'gemma3:270m' });
    assert.deepEqual([r.status, r.json.error.code], [403, 'manage_locked'], host);
  }
  for (const host of ['localhost:' + api.port, '127.0.0.1:' + api.port, '127.1.2.3', '[::1]:' + api.port, 'metacode.localhost']) {
    assert.equal((await raw('GET', '/status', host)).json.manage.allowed, true, host);
  }
});

test('Ollama not running: the store still browses (catalog, recommendations), and says how to install Ollama', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-no-ollama-'));
  const off = createLocalAi({ env: { OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1', LOCAL_AI_DATA_DIR: dir }, libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', isLoopback: () => true });
  const app = express(); app.use('/x', off.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const at = p => fetch('http://127.0.0.1:' + server.address().port + '/x' + p).then(async r => ({ status: r.status, json: await r.json() }));
  try {
    const s = await at('/status');
    assert.deepEqual([s.status, s.json.ollama.running], [200, false]);
    const rt = await at('/runtimes');
    assert.equal(rt.json.runtimes[0].status, 'not-running');
    assert.match(rt.json.runtimes[0].detail, /Install it from ollama\.com/);
    assert.equal((await at('/catalog')).status, 200);
    const m = await at('/models');
    assert.equal(m.status, 503);
    assert.match(m.json.error.message, /isn't answering/);
  } finally {
    off.close();
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
