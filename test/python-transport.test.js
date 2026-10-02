// The Python server engine (python/reddit_fetch.py via PythonTransport), its
// network rules, and the automatic fallback to epoxy-tls over Wisp.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { PythonTransport, AutoTransport } = require('../scraper/network/python-transport');
const { createMockReddit } = require('./helpers/mock-reddit');
const { testConfig, startScraperApp, postJson, waitForJob } = require('./helpers/harness');

let mock, base, slow, slowBase;
const transports = [];

function pythonTransport(env, configExtra) {
  const t = new PythonTransport({ config: testConfig(Object.assign({ REDDIT_BASE_URL: base }, configExtra || {})), env: env || process.env });
  transports.push(t);
  return t;
}

test.before(async () => {
  mock = createMockReddit();
  base = await mock.listen();
  // Odd responses: gzip, an oversized body, and one that never answers.
  slow = http.createServer((req, res) => {
    if (req.url === '/gzip.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync(JSON.stringify({ hello: 'gzip', n: 3 })));
    }
    if (req.url === '/huge.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('x'.repeat(200 * 1024));
    }
    if (req.url === '/hang.json') return;           // never answers
    res.writeHead(404).end();
  });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  slowBase = 'http://localhost:' + slow.address().port;
});

test.after(async () => {
  transports.forEach(t => t.close());
  await mock.close();
  slow.closeAllConnections();
  await new Promise(r => slow.close(r));
});

test('python engine: starts, fetches Reddit JSON, passes headers back', async () => {
  const t = pythonTransport();
  const info = await t.start();
  assert.match(info.python, /^3\.\d+/);
  const res = await t.request({ url: base + '/r/test/new.json?limit=2', headers: { accept: 'application/json' }, timeoutMs: 5000 });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /json/);
  assert.equal(JSON.parse(res.body).data.children.length, 2);
  const seen = mock.state.requests.find(r => r.path === '/r/test/new.json');
  assert.equal(seen.headers['user-agent'], 'nodejs:metacode-tests:1.0 (by /u/metacode_tests)');
  const head = await t.request({ url: base + '/r/test/new.json', method: 'HEAD', timeoutMs: 5000 });
  assert.equal(head.body, '');
});

test('python engine: gzip is decoded; size and time limits apply', async () => {
  const t = pythonTransport(null, { REDDIT_OAUTH_BASE_URL: slowBase, SCRAPER_MAX_RESPONSE_BYTES: String(64 * 1024) });
  const gz = await t.request({ url: slowBase + '/gzip.json', timeoutMs: 5000 });
  assert.deepEqual(JSON.parse(gz.body), { hello: 'gzip', n: 3 });
  assert.equal(gz.headers['content-encoding'], undefined);
  await assert.rejects(t.request({ url: slowBase + '/huge.json', timeoutMs: 5000 }), err => err.type === 'too_large');
  const t0 = Date.now();
  await assert.rejects(t.request({ url: slowBase + '/hang.json', timeoutMs: 1000 }), err => err.type === 'timeout');
  assert.ok(Date.now() - t0 < 6000);
  // The worker survives all of that.
  assert.equal((await t.request({ url: slowBase + '/gzip.json', timeoutMs: 5000 })).status, 200);
});

test('python engine enforces the network rules itself (not only Node)', async () => {
  const t = pythonTransport();
  await assert.rejects(t.request({ url: 'https://example.com/', timeoutMs: 5000 }), err => err.type === 'proxy_blocked' && /allow-list/.test(err.message));
  await assert.rejects(t.request({ url: 'http://127.0.0.1:' + new URL(base).port + '/', timeoutMs: 5000 }), err => err.type === 'proxy_blocked' && /IP/.test(err.message));
  await assert.rejects(t.request({ url: 'https://www.reddit.com:8443/', timeoutMs: 5000 }), err => err.type === 'proxy_blocked' && /Port/.test(err.message));
  await assert.rejects(t.request({ url: 'ftp://www.reddit.com/', timeoutMs: 5000 }), err => err.type === 'invalid_url');
  await assert.rejects(t.request({ url: 'https://user:pw@www.reddit.com/', timeoutMs: 5000 }), err => err.type === 'invalid_url');
  // Without SCRAPER_ALLOW_PRIVATE_NETWORK, a host that resolves to loopback is refused.
  const strict = pythonTransport(null, { SCRAPER_ALLOW_PRIVATE_NETWORK: 'false' });
  await assert.rejects(strict.request({ url: base + '/r/test/new.json', timeoutMs: 5000 }), err => err.type === 'proxy_blocked' && /private/.test(err.message));
});

test('python engine: redirects are returned, not followed', async () => {
  const t = pythonTransport();
  const res = await t.request({ url: base + '/r/missing/new.json', timeoutMs: 5000 });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /subreddits\/search/);
});

test('auto engine: uses Python when it starts, otherwise falls back to epoxy-tls', async () => {
  const fakeEpoxy = { kind: 'epoxy', request: async () => ({ status: 299, statusText: '', headers: {}, body: 'epoxy', url: 'x' }) };
  const good = new AutoTransport({ mode: 'auto', python: pythonTransport(), epoxy: fakeEpoxy });
  assert.equal((await good.request({ url: base + '/r/test/new.json', timeoutMs: 5000 })).status, 200);
  assert.equal(good.status().engine, 'python');

  const missing = pythonTransport({ SCRAPER_PYTHON: '/nonexistent/python3' });
  const chosen = [];
  const fallback = new AutoTransport({ mode: 'auto', python: missing, epoxy: fakeEpoxy, onChoose: (t, err) => chosen.push([t.kind, !!err]) });
  assert.equal((await fallback.request({ url: base + '/x', timeoutMs: 5000 })).body, 'epoxy');
  assert.deepEqual(chosen, [['epoxy', true]]);
  assert.match(fallback.status().pythonError, /Python 3\.8\+ wasn't found/);

  const forced = new AutoTransport({ mode: 'python', python: pythonTransport({ SCRAPER_PYTHON: '/nonexistent/python3' }), epoxy: fakeEpoxy });
  await assert.rejects(forced.request({ url: base + '/x' }), err => err.type === 'not_available');
  const epoxyOnly = new AutoTransport({ mode: 'epoxy', python: missing, epoxy: fakeEpoxy });
  assert.equal(epoxyOnly.kind, 'epoxy');
});

test('a full standard job runs through the Python engine, and through epoxy-tls when chosen', async () => {
  for (const engine of ['python', 'epoxy']) {
    const app = await startScraperApp({ REDDIT_BASE_URL: base, SCRAPER_SERVER_TRANSPORT: engine, SCRAPER_RESPECT_ROBOTS_TXT: 'false' });
    try {
      const { json } = await postJson(app.api + '/jobs', { mode: 'standard', engine: 'server', target: { type: 'subreddit', subreddit: 'test', sort: 'new' }, options: { maxItems: 30, maxPages: 2 } });
      const job = await waitForJob(app.api, json.job.id);
      assert.equal(job.status, 'completed', engine + ': ' + JSON.stringify(job.error));
      assert.equal(job.itemCount, 30);
      const status = await (await fetch(app.api + '/status')).json();
      assert.equal(status.transport.kind, engine);
    } finally {
      await app.close();
    }
  }
});
