// Integration tests: HTTP API → job manager → Reddit HTTP client → epoxy-tls
// → MetaCode's Wisp endpoint → (mock) Reddit, all real except Reddit itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockReddit } = require('./helpers/mock-reddit');
const { startScraperApp, postJson, getJson, readEvents, waitForJob } = require('./helpers/harness');
const { sandboxSupported } = require('../scraper/sandbox/custom-runner');
const { configureWisp } = require('../scraper/network/wisp-server');

let mock, app, base;

test.before(async () => {
  mock = createMockReddit();
  base = await mock.listen();
  app = await startScraperApp({ REDDIT_BASE_URL: base });
});
test.after(async () => {
  await app.close();
  await mock.close();
});

const start = (body) => postJson(app.api + '/jobs', body);

test('status endpoint reports mode, transport and limits without secrets', async () => {
  const { status, json } = await getJson(app.api + '/status');
  assert.equal(status, 200);
  assert.equal(json.enabled, true);
  assert.equal(json.mode, 'public');
  assert.equal(json.transport.name, 'epoxy-tls over Wisp');
  assert.equal(json.transport.wispPath, '/wisp/');
  assert.ok(json.allowedHosts.includes('www.reddit.com'));
  assert.ok(json.limits.maxItems > 0);
  assert.ok(!JSON.stringify(json).includes('secret'));
});

test('target resolve endpoint validates Reddit URLs', async () => {
  const ok = await postJson(app.api + '/resolve', { target: { type: 'url', url: 'https://www.reddit.com/r/science/comments/abc123/x/' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.target.type, 'post');
  const bad = await postJson(app.api + '/resolve', { target: { type: 'url', url: 'https://example.com/r/science' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.type, 'invalid_target');
});

test('job creation validates input', async () => {
  let r = await start({ target: { type: 'subreddit', subreddit: 'bad name' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /valid subreddit name/);
  r = await start({ mode: 'robot', target: {} });
  assert.equal(r.status, 400);
  r = await start({ mode: 'custom', code: '' });
  assert.equal(r.status, sandboxSupported().ok ? 400 : 503);
  r = await fetch(app.api + '/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.ok(r.status >= 400);
  r = await getJson(app.api + '/jobs/does-not-exist');
  assert.equal(r.status, 404);
});

test('successful scrape: 202, SSE progress, completed status, results and exports', async () => {
  const r = await start({ target: { type: 'subreddit', subreddit: 'test', sort: 'new' }, options: { maxItems: 150, maxPages: 3 } });
  assert.equal(r.status, 202);
  const id = r.json.job.id;
  assert.ok(['queued', 'running'].includes(r.json.job.status));

  const events = await readEvents(app.api + '/jobs/' + id + '/events', 30000);
  assert.equal(events[0].event, 'snapshot');
  const statuses = events.filter(e => e.event === 'status').map(e => e.data.status);
  assert.equal(statuses[statuses.length - 1], 'completed');
  assert.ok(events.some(e => e.event === 'progress'), 'progress events');
  assert.ok(events.some(e => e.event === 'records'), 'records events');
  assert.ok(events.some(e => e.event === 'log'), 'log events');

  const job = (await getJson(app.api + '/jobs/' + id)).json.job;
  assert.equal(job.status, 'completed');
  assert.equal(job.itemCount, 150);
  assert.equal(job.progress.pagesFetched, 2);
  assert.ok(job.progress.requests >= 3);
  assert.equal(job.meta.subreddit.name, 'test');
  assert.ok(job.durationMs >= 0);

  const page = (await getJson(app.api + '/jobs/' + id + '/results?offset=100&limit=10')).json;
  assert.equal(page.total, 150);
  assert.equal(page.records.length, 10);
  assert.equal(page.records[0].record_type, 'post');
  assert.match(page.records[0].permalink, /^https:\/\/www\.reddit\.com\/r\/test\/comments\//);

  // Reddit saw our User-Agent and polite query parameters.
  const listingReq = mock.state.requests.find(q => q.path === '/r/test/new.json');
  assert.equal(listingReq.headers['user-agent'], app.config.userAgent);
  assert.equal(listingReq.query.raw_json, '1');

  const csv = await fetch(app.api + '/jobs/' + id + '/export?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="reddit_test_[0-9a-f]{8}\.csv"/);
  const text = await csv.text();
  assert.equal(text.trim().split('\r\n').length, 151);
  const jsonExport = await (await fetch(app.api + '/jobs/' + id + '/export?format=json')).json();
  assert.equal(jsonExport.count, 150);
  const nd = await (await fetch(app.api + '/jobs/' + id + '/export?format=ndjson')).text();
  assert.equal(nd.trim().split('\n').length, 150);
  const badFormat = await fetch(app.api + '/jobs/' + id + '/export?format=xml');
  assert.equal(badFormat.status, 400);
});

test('post target: post plus flattened comments; nested JSON export', async () => {
  const r = await start({ target: { type: 'post', postId: 'https://www.reddit.com/r/test/comments/abc123/title/' } });
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  const { records } = (await getJson(app.api + '/jobs/' + job.id + '/results')).json;
  assert.deepEqual(records.map(x => x.record_type), ['post', 'comment', 'comment', 'comment']);
  assert.equal(records[2].parent_type, 'comment');
  assert.ok(job.logs.some(l => /7 more comment/.test(l.message)));
  const nested = await (await fetch(app.api + '/jobs/' + job.id + '/export?format=json&nested=1')).json();
  assert.equal(nested.records[0].comments.length, 3);
});

test('listing with comments for the first posts', async () => {
  const r = await start({ target: { type: 'subreddit', subreddit: 'small' }, options: { includeComments: true, commentPosts: 2 } });
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  const { records } = (await getJson(app.api + '/jobs/' + job.id + '/results?type=comment')).json;
  assert.ok(records.length >= 3);
});

test('empty results complete with a warning', async () => {
  const r = await start({ target: { type: 'subreddit', subreddit: 'empty' } });
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.itemCount, 0);
  assert.equal(job.meta.empty, true);
  assert.ok(job.logs.some(l => l.level === 'warn' && /without results/.test(l.message)));
});

test('Reddit errors fail the job with understandable messages', async () => {
  const cases = [
    ['missing', 'not_found', /doesn't exist/],
    ['private', 'forbidden_private', /is private/],
    ['quarantinedsub', 'forbidden_quarantined', /quarantined/],
    ['netblock', 'reddit_blocked', /without a Reddit login or API key/],
    ['htmlblock', 'parse_error', /web page instead of data/]
  ];
  for (const [sub, type, pattern] of cases) {
    const r = await start({ target: { type: 'subreddit', subreddit: sub }, options: { includeMetadata: false } });
    const job = await waitForJob(app.api, r.json.job.id);
    assert.equal(job.status, 'failed', sub);
    assert.equal(job.error.type, type, sub);
    assert.match(job.error.message, pattern, sub);
  }
});

test('rate limiting: Reddit 429 is waited out and retried', async () => {
  mock.state.rateLimitRemaining['/r/ratelimited'] = 1;
  const r = await start({ target: { type: 'subreddit', subreddit: 'ratelimited', sort: 'new' }, options: { maxItems: 5, includeMetadata: false } });
  const job = await waitForJob(app.api, r.json.job.id, 20000);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.itemCount, 5);
  assert.ok(job.logs.some(l => /HTTP 429/.test(l.message)));
  const hits = mock.state.requests.filter(q => q.path === '/r/ratelimited/new.json');
  assert.equal(hits.length, 2);
  assert.ok(hits[1].at - hits[0].at >= 900, 'waited for Retry-After: 1');
});

test('server-side delay between requests is enforced', async () => {
  const r = await start({ target: { type: 'subreddit', subreddit: 'spaced', sort: 'new' }, options: { maxItems: 300, maxPages: 3, delayMs: 300, includeMetadata: false } });
  const job = await waitForJob(app.api, r.json.job.id, 20000);
  assert.equal(job.status, 'completed');
  const hits = mock.state.requests.filter(q => q.path === '/r/spaced/new.json');
  assert.equal(hits.length, 3);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i].at - hits[i - 1].at >= 280, 'gap ' + (hits[i].at - hits[i - 1].at));
});

test('robots.txt disallow stops the job before any page is fetched', async () => {
  const blocked = await startScraperApp({ REDDIT_BASE_URL: base });
  const prev = mock.state.robots;
  mock.state.robots = 'User-agent: *\nDisallow: /r/\n';
  try {
    const before = mock.state.requests.length;
    const r = await postJson(blocked.api + '/jobs', { target: { type: 'subreddit', subreddit: 'test' }, options: { includeMetadata: false } });
    const job = await waitForJob(blocked.api, r.json.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.type, 'robots_disallowed');
    const sent = mock.state.requests.slice(before).map(q => q.path);
    assert.deepEqual(sent, ['/robots.txt']);
  } finally {
    mock.state.robots = prev;
    await blocked.close();
    configureWisp(app.config);     // wisp-js options are process-wide
  }
});

test('network error: an unreachable Reddit fails the job after retries', async () => {
  const dead = await startScraperApp({ REDDIT_BASE_URL: 'http://localhost:1', SCRAPER_RESPECT_ROBOTS_TXT: 'false', SCRAPER_REQUEST_TIMEOUT_MS: '3000' });
  try {
    const r = await postJson(dead.api + '/jobs', { target: { type: 'subreddit', subreddit: 'test' }, options: { retries: 0, includeMetadata: false } });
    const job = await waitForJob(dead.api, r.json.job.id, 20000);
    assert.equal(job.status, 'failed');
    assert.ok(['network', 'proxy_blocked', 'timeout'].includes(job.error.type), job.error.type);
    assert.ok(!/localhost:1/.test(job.error.message), 'no internal address in the message');
  } finally {
    await dead.close();
    configureWisp(app.config);
  }
});

test('cancellation of a running job keeps partial results', async () => {
  const r = await start({ target: { type: 'subreddit', subreddit: 'slowsub', sort: 'new' }, options: { maxItems: 500, maxPages: 5, delayMs: 1500, includeMetadata: false } });
  const id = r.json.job.id;
  const deadline = Date.now() + 10000;
  while ((await getJson(app.api + '/jobs/' + id)).json.job.itemCount === 0 && Date.now() < deadline) await new Promise(res => setTimeout(res, 50));
  const c = await postJson(app.api + '/jobs/' + id + '/cancel', {});
  assert.equal(c.status, 200);
  const job = await waitForJob(app.api, id);
  assert.equal(job.status, 'cancelled');
  assert.ok(job.itemCount > 0 && job.itemCount < 500);
  const again = await postJson(app.api + '/jobs/' + id + '/cancel', {});
  assert.equal(again.status, 409);
  const del = await fetch(app.api + '/jobs/' + id, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await getJson(app.api + '/jobs/' + id)).status, 404);
});

test('custom code job runs in the sandbox through the API', { skip: !sandboxSupported().ok }, async () => {
  const code = `
    async function scrape(ctx) {
      const { items } = await ctx.reddit.listing('/r/' + ctx.params.sub + '/new', { maxPages: 1, maxItems: 7 });
      ctx.log.info('got ' + items.length);
      return items.map(p => ({ id: p.post_id, title: p.title.toUpperCase() }));
    }`;
  const r = await start({ mode: 'custom', code, params: { sub: 'test' }, options: { maxItems: 50 } });
  assert.equal(r.status, 202);
  const job = await waitForJob(app.api, r.json.job.id, 30000);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.itemCount, 7);
  assert.ok(job.logs.some(l => l.message === '[code] got 7'));
  const { records } = (await getJson(app.api + '/jobs/' + job.id + '/results')).json;
  assert.equal(records[0].title, 'POST 0 IN TEST');

  const fail = await start({ mode: 'custom', code: 'async function scrape(ctx) { await ctx.fetch("https://example.com/") }' });
  const failed = await waitForJob(app.api, fail.json.job.id, 30000);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.type, 'host_not_allowed');
});

test('same-origin protection for state-changing requests', async () => {
  const r = await postJson(app.api + '/jobs', { target: { type: 'subreddit', subreddit: 'test' } }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.type, 'forbidden_origin');
});

test('Wisp endpoint: refuses foreign origins and wrong paths; blocks non-Reddit hosts', async () => {
  const upgrade = (path, origin) => new Promise(resolve => {
    const http = require('http');
    const req = http.request({ host: '127.0.0.1', port: app.port, path, headers: Object.assign({
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }, origin ? { Origin: origin } : {}) });
    req.on('upgrade', res => { res.socket.destroy(); resolve(101); });
    req.on('response', res => resolve(res.statusCode));
    req.on('error', () => resolve('error'));
    req.end();
  });
  assert.equal(await upgrade('/wisp/', 'https://evil.example'), 403);
  assert.equal(await upgrade('/wisp/example.com:80', null), 404);
  assert.equal(await upgrade('/wisp/?x=1', null), 404);
  assert.equal(await upgrade('/wisp/', 'http://127.0.0.1:' + app.port), 101);

  // A Wisp client may only open streams to allow-listed hosts.
  const { EpoxyWispTransport } = require('../scraper/network/epoxy-transport');
  const t = new EpoxyWispTransport({ getWispUrl: () => 'ws://127.0.0.1:' + app.port + '/wisp/', userAgent: 'test' });
  await assert.rejects(t.request({ url: 'https://example.com/', timeoutMs: 8000 }), err => ['proxy_blocked', 'network', 'timeout'].includes(err.type));
});

test('Scramjet browser files are served with the right types', async () => {
  for (const [file, type] of [['scramjet.js', /javascript/], ['scramjet.wasm', /application\/wasm/], ['controller.sw.js', /javascript/], ['epoxy-transport.js', /javascript/]]) {
    const res = await fetch(app.url + '/scramjet/' + file);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get('content-type'), type, file);
    await res.arrayBuffer();
  }
  assert.equal((await fetch(app.url + '/scramjet/package.json')).status, 404);
  assert.equal((await fetch(app.url + '/scramjet/..%2f..%2fserver.js')).status, 404);
});

// A stand-in for a MetaCode tab serving browser-mode jobs: listens on the relay
// stream, claims each request, fetches it (here with Node's fetch) and answers.
function fakeTab(api, opts) {
  opts = opts || {};
  const controller = new AbortController();
  const handled = [];
  (async () => {
    const res = await fetch(api + '/relay/events', { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (!block.startsWith('event: relay\n')) continue;
        const req = JSON.parse(block.split('\ndata: ')[1]);
        (async () => {
          const claim = await postJson(api + '/relay/' + req.id + '/claim', {});
          if (claim.status !== 200) return;
          handled.push(req);
          let payload;
          try {
            const r = await fetch(req.url, { method: req.method, headers: Object.assign({ 'user-agent': 'FakeBrowser/1.0' }, req.headers) });
            payload = { status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers), body: await r.text() };
          } catch (e) { payload = { error: String(e.message) }; }
          await postJson(api + '/relay/' + req.id, payload);
        })().catch(() => {});
      }
    }
  })().catch(() => {});
  return { handled, stop: () => controller.abort() };
}

test('browser engine: requests are fetched by the tab — no robots.txt, no credentials', async () => {
  const prev = mock.state.robots;
  mock.state.robots = 'User-agent: *\nDisallow: /\n';          // would block the server engine
  const tab = fakeTab(app.api);
  try {
    await new Promise(r => setTimeout(r, 100));
    const status = (await getJson(app.api + '/status')).json;
    assert.equal(status.defaultEngine, 'browser');
    assert.equal(status.engines.browser.connectedTabs, 1);
    const before = mock.state.requests.length;
    const r = await start({ engine: 'browser', target: { type: 'subreddit', subreddit: 'test', sort: 'new' }, options: { maxItems: 120 } });
    assert.equal(r.status, 202);
    assert.equal(r.json.job.engine, 'browser');
    const job = await waitForJob(app.api, r.json.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(job.itemCount, 120);
    const sent = mock.state.requests.slice(before);
    assert.ok(!sent.some(q => q.path === '/robots.txt'), 'robots.txt not consulted');
    assert.ok(sent.every(q => q.headers['user-agent'] === 'FakeBrowser/1.0'), 'the browser\'s own User-Agent');
    assert.ok(sent.every(q => !q.headers.authorization));
    assert.ok(tab.handled.every(h => /^http:\/\/localhost:\d+\//.test(h.url)));

    // Custom code uses the same path.
    const c = await start({ engine: 'browser', mode: 'custom', code: 'async function scrape(ctx) { return (await ctx.reddit.listing("/r/test/new", { maxPages: 1, maxItems: 3 })).items; }' });
    const cj = await waitForJob(app.api, c.json.job.id, 30000);
    assert.equal(cj.status, 'completed', JSON.stringify(cj.error));
    assert.equal(cj.itemCount, 3);

  } finally {
    tab.stop();
    mock.state.robots = prev;
  }
});

test('browser engine: relay endpoints reject unknown requests, foreign origins and bad engines', async () => {
  assert.equal((await postJson(app.api + '/relay/nope/claim', {})).status, 409);
  assert.equal((await postJson(app.api + '/relay/nope', { status: 200, body: '' })).status, 409);
  assert.equal((await postJson(app.api + '/relay/nope', { status: 200 }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await start({ engine: 'mars', target: { type: 'subreddit', subreddit: 'test' } })).status, 400);
});

test('browser engine: with no MetaCode tab open the job fails with a clear message', async () => {
  const lonely = await startScraperApp({ REDDIT_BASE_URL: base, SCRAPER_REQUEST_TIMEOUT_MS: '1500' });
  try {
    const r = await postJson(lonely.api + '/jobs', { engine: 'browser', target: { type: 'subreddit', subreddit: 'test' }, options: { includeMetadata: false } });
    const job = await waitForJob(lonely.api, r.json.job.id, 15000);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.type, 'browser_unavailable');
    assert.match(job.error.message, /Keep MetaCode open/);
  } finally {
    await lonely.close();
    configureWisp(app.config);
  }
});

test('Reddit API access: keys are checked, saved (mode 600, never echoed) and fix the logged-out block', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const apiMock = createMockReddit({ requireToken: true });     // stands in for oauth.reddit.com
  const apiBase = await apiMock.listen();
  const file = path.join(os.tmpdir(), 'metacode-cred-test-' + process.pid + '-' + Date.now() + '.json');
  const env = { REDDIT_BASE_URL: base, REDDIT_OAUTH_BASE_URL: apiBase };
  let a = await startScraperApp(env, { credentialsFile: file });
  try {
    let st = (await getJson(a.api + '/status')).json;
    assert.equal(st.credentials.configured, false);
    assert.equal(st.defaultEngine, 'browser');

    // Logged-out: Reddit's block page → a clear, specific error.
    let r = await postJson(a.api + '/jobs', { engine: 'server', target: { type: 'subreddit', subreddit: 'netblock' }, options: { includeMetadata: false } });
    let job = await waitForJob(a.api, r.json.job.id);
    assert.equal(job.error.type, 'reddit_blocked');

    const bad = await postJson(a.api + '/credentials', { clientId: 'test-client-id', clientSecret: 'wrong-secret-value' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /weren't saved/);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await postJson(a.api + '/credentials', { clientId: 'x', clientSecret: '' })).status, 400);

    const ok = await postJson(a.api + '/credentials', { clientId: 'test-client-id', clientSecret: 'test-client-secret', username: 'u/metacode_user' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.credentials.configured, true);
    assert.equal(ok.json.credentials.source, 'saved');
    assert.equal(ok.json.credentials.clientIdHint, '…t-id');
    assert.equal(ok.json.credentials.username, 'metacode_user');
    assert.equal(ok.json.mode, 'oauth');
    assert.equal(ok.json.defaultEngine, 'server');
    assert.ok(!JSON.stringify(ok.json).includes('test-client-secret'), 'secret never returned');
    assert.ok(!JSON.stringify((await getJson(a.api + '/status')).json).includes('test-client-secret'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).clientSecret, 'test-client-secret');

    // Same subreddit now works through the API.
    r = await postJson(a.api + '/jobs', { engine: 'server', target: { type: 'subreddit', subreddit: 'netblock', sort: 'new' }, options: { maxItems: 5, includeMetadata: false } });
    job = await waitForJob(a.api, r.json.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(job.itemCount, 5);
    const apiReq = apiMock.state.requests.find(q => q.path === '/r/netblock/new');
    assert.equal(apiReq.headers.authorization, 'bearer test-token-123');
    assert.equal(apiReq.headers['user-agent'], 'nodejs:metacode-reddit-scraper:1.0 (by /u/metacode_user)');

    // Saved keys are loaded again after a restart.
    await a.close();
    a = await startScraperApp(env, { credentialsFile: file });
    st = (await getJson(a.api + '/status')).json;
    assert.equal(st.credentials.source, 'saved');

    const del = await fetch(a.api + '/credentials', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).credentials.configured, false);
    assert.equal(fs.existsSync(file), false);
  } finally {
    await a.close();
    await apiMock.close();
    try { require('fs').unlinkSync(file); } catch (e) { /* already removed */ }
    configureWisp(app.config);
  }
});

test('Reddit API access: keys from .env take precedence and can\'t be changed from the page', async () => {
  const a = await startScraperApp({ REDDIT_BASE_URL: base, REDDIT_CLIENT_ID: 'env-client-id', REDDIT_CLIENT_SECRET: 'env-client-secret' });
  try {
    const st = (await getJson(a.api + '/status')).json;
    assert.equal(st.credentials.source, 'env');
    assert.equal((await postJson(a.api + '/credentials', { clientId: 'test-client-id', clientSecret: 'test-client-secret' })).status, 409);
    assert.equal((await fetch(a.api + '/credentials', { method: 'DELETE' })).status, 409);
  } finally {
    await a.close();
    configureWisp(app.config);
  }
});

test('Reddit API: sort sweep collects past one listing, without duplicates', async () => {
  const apiMock = createMockReddit({ requireToken: true });
  const apiBase = await apiMock.listen();
  const a = await startScraperApp({ REDDIT_BASE_URL: base, REDDIT_OAUTH_BASE_URL: apiBase, REDDIT_CLIENT_ID: 'test-client-id', REDDIT_CLIENT_SECRET: 'test-client-secret' });
  try {
    // Without the sweep: one listing only (250 posts in the mock).
    let r = await postJson(a.api + '/jobs', { engine: 'server', target: { type: 'subreddit', subreddit: 'sweepsub', sort: 'new' }, options: { maxItems: 900, maxPages: 5, includeMetadata: false } });
    let job = await waitForJob(a.api, r.json.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(job.itemCount, 250);

    r = await postJson(a.api + '/jobs', { engine: 'server', target: { type: 'subreddit', subreddit: 'sweepsub', sort: 'new' }, options: { maxItems: 900, maxPages: 5, sweepSorts: true, includeMetadata: false } });
    job = await waitForJob(a.api, r.json.job.id, 30000);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert.equal(job.itemCount, 900);
    const { records } = (await getJson(a.api + '/jobs/' + job.id + '/results?limit=5000')).json;
    assert.equal(new Set(records.map(x => x.post_id)).size, 900, 'all unique');
    assert.ok(job.logs.some(l => /Combining sorts/.test(l.message)));
    assert.ok(job.logs.some(l => /sweepsub\/hot: 0 new post/.test(l.message)), 'hot repeats new and adds nothing');
    const paths = apiMock.state.requests.map(q => q.path);
    assert.ok(paths.includes('/r/sweepsub/top') && paths.includes('/r/sweepsub/controversial'));
    assert.ok(apiMock.state.requests.every(q => q.headers.authorization === 'bearer test-token-123'));
  } finally {
    await a.close();
    await apiMock.close();
    configureWisp(app.config);
  }
});

test('Reddit API: collapsed "load more" comments are loaded (public mode skips with a note)', async () => {
  const apiMock = createMockReddit({ requireToken: true });
  const apiBase = await apiMock.listen();
  const a = await startScraperApp({ REDDIT_BASE_URL: base, REDDIT_OAUTH_BASE_URL: apiBase, REDDIT_CLIENT_ID: 'test-client-id', REDDIT_CLIENT_SECRET: 'test-client-secret' });
  try {
    const r = await postJson(a.api + '/jobs', { engine: 'server', target: { type: 'post', postId: 'abc123' }, options: { expandMore: true, commentLimit: 50 } });
    const job = await waitForJob(a.api, r.json.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    const { records } = (await getJson(a.api + '/jobs/' + job.id + '/results?type=comment')).json;
    assert.deepEqual(records.map(c => c.comment_id), ['c1', 'c1a', 'c2', 'x', 'y', 'z1']);
    assert.equal(records[3].parent_id, 't1_c1');
    assert.equal(records[3].post_id, 'abc123');
    const more = apiMock.state.requests.filter(q => q.path === '/api/morechildren');
    assert.equal(more.length, 2);
    assert.equal(more[0].query.link_id, 't3_abc123');
    assert.equal(more[0].query.children, 'x,y');
    assert.ok(job.logs.some(l => /Loaded 3 collapsed comment/.test(l.message)));

    // The comment limit is respected.
    const r2 = await postJson(a.api + '/jobs', { engine: 'server', target: { type: 'post', postId: 'abc123' }, options: { expandMore: true, commentLimit: 4 } });
    const j2 = await waitForJob(a.api, r2.json.job.id);
    assert.equal((await getJson(a.api + '/jobs/' + j2.id + '/results?type=comment')).json.total, 4);
  } finally {
    await a.close();
    await apiMock.close();
    configureWisp(app.config);
  }
  // Public mode: no API → skipped with an explanation.
  const r = await start({ target: { type: 'post', postId: 'abc123' }, options: { expandMore: true } });
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  assert.ok(job.logs.some(l => /needs Reddit API access/.test(l.message)));
});

test('scraper jobs belong to the browser that started them', async () => {
  const A = { cookie: 'mc_owner=' + 'a'.repeat(48) };
  const B = { cookie: 'mc_owner=' + 'b'.repeat(48) };
  const r = await postJson(app.api + '/jobs', { target: { type: 'subreddit', subreddit: 'test' }, options: { maxItems: 5, maxPages: 1, includeMetadata: false } }, A);
  assert.equal(r.status, 202);
  const id = r.json.job.id;
  const get = async (u, h) => { const res = await fetch(app.api + u, { headers: h }); const text = await res.text(); return { status: res.status, json: () => JSON.parse(text) }; };
  assert.ok((await (await get('/jobs', A)).json()).jobs.some(j => j.id === id), 'listed for its browser');
  assert.ok(!(await (await get('/jobs', B)).json()).jobs.some(j => j.id === id), 'not for another');
  assert.ok(!(await (await get('/jobs', {})).json()).jobs.some(j => j.id === id), 'nor without an identity');
  for (const u of ['/jobs/' + id, '/jobs/' + id + '/results', '/jobs/' + id + '/logs', '/jobs/' + id + '/export?format=csv', '/jobs/' + id + '/events']) {
    assert.equal((await get(u, B)).status, 404, u);
  }
  const del = await fetch(app.api + '/jobs/' + id, { method: 'DELETE', headers: B });
  await del.text();
  assert.equal(del.status, 404);
  assert.equal((await get('/jobs/' + id, A)).status, 200);
  for (let i = 0; i < 100; i++) {
    if (['completed', 'failed', 'cancelled'].includes((await get('/jobs/' + id, A)).json().job.status)) break;
    await new Promise(r => setTimeout(r, 100));
  }
});
