const test = require('node:test');
const assert = require('node:assert/strict');
const { HostRateLimiter } = require('../scraper/network/rate-limiter');
const { RedditHttpClient } = require('../scraper/network/reddit-http');
const { classifyTransportError, cancelledError } = require('../scraper/errors');
const { originAllowed } = require('../scraper/network/wisp-server');
const { testConfig, FakeTransport, json, TEST_UA } = require('./helpers/harness');

const listing = children => ({ kind: 'Listing', data: { after: null, children } });

function client(handler, env) {
  const config = testConfig(env);
  const transport = new FakeTransport(handler);
  const limiter = new HostRateLimiter({ maxConcurrent: config.maxConcurrentRequests });
  return { http: new RedditHttpClient({ config, transport, limiter }), transport, limiter, config };
}

test('rate limiting: requests to one host are spaced by the interval', async () => {
  const limiter = new HostRateLimiter({ maxConcurrent: 4 });
  const starts = [];
  for (let i = 0; i < 4; i++) {
    const release = await limiter.acquire('www.reddit.com', 60);
    starts.push(Date.now());
    release();
  }
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 55, 'gap ' + (starts[i] - starts[i - 1]));
  // Another host isn't slowed down by the first.
  const t0 = Date.now();
  (await limiter.acquire('oauth.reddit.com', 60))();
  assert.ok(Date.now() - t0 < 30);
});

test('rate limiting: concurrency cap, pauses and cancellation while waiting', async () => {
  const limiter = new HostRateLimiter({ maxConcurrent: 2 });
  const r1 = await limiter.acquire('h', 0);
  const r2 = await limiter.acquire('h', 0);
  let third = false;
  const p3 = limiter.acquire('h', 0).then(rel => { third = true; return rel; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(third, false, 'third request waits while two are in flight');
  r1();
  (await p3)();
  assert.equal(third, true);
  r2();

  limiter.pause('h', Date.now() + 80);
  const t0 = Date.now();
  (await limiter.acquire('h', 0))();
  assert.ok(Date.now() - t0 >= 70, 'pause respected');

  const ac = new AbortController();
  limiter.pause('h', Date.now() + 5000);
  const waiting = limiter.acquire('h', 0, ac.signal);
  ac.abort(cancelledError());
  await assert.rejects(waiting, err => err.type === 'cancelled');
});

test('HTTP client: only Reddit hosts and allowed ports can be requested', async () => {
  const { http, transport } = client(() => json({}));
  await assert.rejects(http.request('https://example.com/r/x.json'), err => err.type === 'host_not_allowed');
  await assert.rejects(http.request('https://www.reddit.com:8443/r/x.json'), err => err.type === 'host_not_allowed');
  await assert.rejects(http.request('https://user:pw@www.reddit.com/'), err => err.type === 'invalid_url');
  await assert.rejects(http.request('file:///etc/passwd'), err => err.type === 'invalid_url');
  await assert.rejects(http.request('not a url'), err => err.type === 'invalid_url');
  await assert.rejects(http.request('https://www.reddit.com/api/x', { method: 'POST' }), err => err.type === 'invalid_request');
  assert.equal(transport.requests.length, 0, 'nothing was sent');
});

test('HTTP client: public mode builds .json URLs, sends the User-Agent and only allowed headers', async () => {
  const { http, transport } = client(req => (req.url.endsWith('/robots.txt') ? { body: 'User-agent: *\nAllow: /\n' } : json(listing([]))));
  assert.equal(http.mode, 'public');
  assert.equal(http.buildApiUrl('/r/science/new', { limit: 5, after: null }), 'https://www.reddit.com/r/science/new.json?limit=5&raw_json=1');
  assert.equal(http.buildApiUrl('https://old.reddit.com/r/a1/top.json?t=week'), 'https://www.reddit.com/r/a1/top.json?t=week&raw_json=1');
  await http.request('https://www.reddit.com/r/science.json', { headers: { cookie: 'x=1', accept: 'application/json', 'X-Forwarded-For': '1.2.3.4' } });
  const req = transport.requests[1];
  assert.equal(req.headers['user-agent'], TEST_UA);
  assert.equal(req.headers.cookie, undefined);
  assert.equal(req.headers['x-forwarded-for'], undefined);
  assert.equal(req.headers.authorization, undefined);
});

test('HTTP client: robots.txt is enforced in public mode', async () => {
  const blocked = client(req => (req.url.endsWith('/robots.txt') ? { body: 'User-agent: *\nDisallow: /\n' } : json({})));
  await assert.rejects(blocked.http.getJson('/r/science/new'), err => err.type === 'robots_disallowed' && /REDDIT_CLIENT_ID/.test(err.message));
  assert.equal(blocked.transport.requests.length, 1, 'only robots.txt was fetched');

  const unreachable = client(req => (req.url.endsWith('/robots.txt') ? { status: 503, body: '' } : json({})), {});
  await assert.rejects(unreachable.http.getJson('/r/science/new', { retries: 0 }), err => err.type === 'robots_unavailable');

  // A TLS/network failure while reading robots.txt is reported as itself.
  const intercepted = client(() => { throw classifyTransportError(new Error('invalid peer certificate: UnknownIssuer')); });
  await assert.rejects(intercepted.http.getJson('/r/science/new', { retries: 0 }), err => err.type === 'tls');

  const missing = client(req => (req.url.endsWith('/robots.txt') ? { status: 404, body: '' } : json(listing([]))));
  assert.equal((await missing.http.getJson('/r/science/new')).json.kind, 'Listing');

  const off = client(() => json(listing([])), { SCRAPER_RESPECT_ROBOTS_TXT: 'false' });
  await off.http.getJson('/r/science/new');
  assert.ok(!off.transport.requests.some(r => r.url.endsWith('/robots.txt')));
});

test('HTTP client: OAuth mode fetches a token and sends it only to the API host', async () => {
  const env = { REDDIT_CLIENT_ID: 'test-client-id', REDDIT_CLIENT_SECRET: 'test-client-secret' };
  const { http, transport } = client(req => {
    if (req.url.endsWith('/api/v1/access_token')) {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64'));
      assert.equal(req.body, 'grant_type=client_credentials');
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    return json(listing([]));
  }, env);
  assert.equal(http.mode, 'oauth');
  assert.equal(http.buildApiUrl('/r/science/new'), 'https://oauth.reddit.com/r/science/new?raw_json=1');
  await http.getJson('/r/science/new');
  await http.getJson('/r/science/hot');
  const api = transport.requests.filter(r => r.url.startsWith('https://oauth.reddit.com'));
  assert.equal(api.length, 2);
  assert.ok(api.every(r => r.headers.authorization === 'bearer tok'));
  assert.equal(transport.requests.filter(r => r.url.endsWith('/access_token')).length, 1, 'token is cached');
  assert.ok(!transport.requests.some(r => r.url.endsWith('/robots.txt')), 'robots.txt does not apply to the API');
  await http.request('https://www.reddit.com/r/x.json');
  assert.equal(transport.requests[transport.requests.length - 1].headers.authorization, undefined, 'no token for www.reddit.com');
});

test('HTTP client: OAuth credential rejection and token refresh after 401', async () => {
  const env = { REDDIT_CLIENT_ID: 'test-client-id', REDDIT_CLIENT_SECRET: 'wrong-secret' };
  const bad = client(req => (req.url.endsWith('/access_token') ? { status: 401, body: '{}' } : json({})), env);
  await assert.rejects(bad.http.getJson('/r/a1/new'), err => err.type === 'auth_error' && !/wrong-secret/.test(err.message));

  let tokens = 0;
  let first = true;
  const ok = client(req => {
    if (req.url.endsWith('/access_token')) { tokens++; return json({ access_token: 't' + tokens, expires_in: 3600 }); }
    if (first) { first = false; return { status: 401, body: '{}' }; }
    return json(listing([]));
  }, { REDDIT_CLIENT_ID: 'test-client-id', REDDIT_CLIENT_SECRET: 'test-client-secret' });
  await ok.http.getJson('/r/a1/new', { retries: 0 });
  assert.equal(tokens, 2);
  assert.equal(ok.transport.requests[ok.transport.requests.length - 1].headers.authorization, 'bearer t2');
});

test('HTTP client: 429 is retried after Retry-After; persistent 429 fails as rate_limited', async () => {
  let n = 0;
  const { http, limiter } = client(req => {
    if (req.url.endsWith('/robots.txt')) return { status: 404 };
    n++;
    return n === 1 ? { status: 429, headers: { 'retry-after': '1' }, body: '' } : json(listing([]));
  });
  const t0 = Date.now();
  const logs = [];
  await http.getJson('/r/a1/new', { log: (l, m) => logs.push(m) });
  assert.ok(Date.now() - t0 >= 950, 'waited for Retry-After');
  assert.ok(logs.some(m => /HTTP 429/.test(m)));
  assert.equal(n, 2);
  assert.equal(limiter.pausedUntil('www.reddit.com'), 0);

  const always = client(req => (req.url.endsWith('/robots.txt') ? { status: 404 } : { status: 429, headers: { 'retry-after': '1' }, body: '' }));
  await assert.rejects(always.http.getJson('/r/a1/new', { retries: 1 }), err => err.type === 'rate_limited' && err.httpStatus === 429);
});

test('HTTP client: rate-limit headers pause the host until reset', async () => {
  const { http, limiter } = client(req => (req.url.endsWith('/robots.txt') ? { status: 404 } : json(listing([]), { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2' })));
  await http.getJson('/r/a1/new');
  assert.ok(limiter.pausedUntil('www.reddit.com') > Date.now() + 1000);
});

test('HTTP client: transient network errors and 5xx are retried with backoff, then reported', async () => {
  let n = 0;
  const { http } = client(req => {
    if (req.url.endsWith('/robots.txt')) return { status: 404 };
    n++;
    if (n === 1) throw classifyTransportError(new Error('Hyper client: Connect error: connection reset'));
    if (n === 2) return { status: 502, body: 'bad gateway' };
    return json(listing([]));
  });
  http.backoff = () => 10;
  await http.getJson('/r/a1/new');
  assert.equal(n, 3);

  const down = client(req => {
    if (req.url.endsWith('/robots.txt')) return { status: 404 };
    throw classifyTransportError(new Error('Hyper client: Connect error: connection refused by host'));
  });
  down.http.backoff = () => 10;
  await assert.rejects(down.http.getJson('/r/a1/new', { retries: 1 }), err => ['network', 'proxy_blocked'].includes(err.type));
});

test('HTTP client: redirects are re-checked; HTML and status codes map to clear errors', async () => {
  const routes = {
    '/r/missing/new.json': { status: 302, headers: { location: '/subreddits/search.json?q=missing' } },
    '/r/moved/new.json': { status: 301, headers: { location: 'https://www.reddit.com/r/target1/new.json' } },
    '/r/target1/new.json': json(listing([])),
    '/r/offsite/new.json': { status: 302, headers: { location: 'https://evil.example/steal' } },
    '/r/gated/new.json': { status: 302, headers: { location: '/over18?dest=x' } },
    '/r/private/new.json': { status: 403, body: '{}' },
    '/r/gone/new.json': { status: 404, body: '{}' },
    '/r/html/new.json': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>blocked</html>' },
    '/r/broken/new.json': { status: 200, headers: { 'content-type': 'application/json' }, body: '{"kind": "Listing", ' }
  };
  const { http } = client(req => {
    const u = new URL(req.url);
    if (u.pathname === '/robots.txt') return { status: 404 };
    return routes[u.pathname] || { status: 500, body: '' };
  });
  const err = async (path, type) => assert.rejects(http.getJson(path, { retries: 0 }), e => { assert.equal(e.type, type, path + ': ' + e.message); return true; });
  await err('/r/missing/new', 'not_found');
  assert.equal((await http.getJson('/r/moved/new')).json.kind, 'Listing');
  await err('/r/offsite/new', 'host_not_allowed');
  await err('/r/gated/new', 'forbidden');
  await err('/r/private/new', 'forbidden');
  await err('/r/gone/new', 'not_found');
  await err('/r/html/new', 'parse_error');
  await err('/r/broken/new', 'parse_error');
});

test('transport errors are classified without leaking details', () => {
  const tls = classifyTransportError(new Error('Hyper client: Connect, Io(Custom { kind: InvalidData, error: InvalidCertificate(UnknownIssuer) }) https://www.reddit.com/x?token=abc'));
  assert.equal(tls.type, 'tls');
  assert.ok(!/token=abc/.test(tls.message));
  assert.ok(!/token=abc/.test(tls.detail || ''), 'URLs are stripped from log detail');
  assert.equal(classifyTransportError(new Error('tls handshake eof')).type, 'proxy_blocked');
  assert.equal(classifyTransportError(new Error('failed to connect to websocket ws://127.0.0.1:1/wisp/')).type, 'proxy_error');
  assert.equal(classifyTransportError(new Error('dns error: failed to lookup address')).type, 'network');
  assert.equal(classifyTransportError(new Error('operation timed out')).type, 'timeout');
  assert.equal(classifyTransportError(new Error('weird')).type, 'network');
});

test('Wisp endpoint accepts only same-origin browsers or local processes', () => {
  const req = (origin, host, addr) => ({ headers: Object.assign({ host }, origin ? { origin } : {}), socket: { remoteAddress: addr } });
  assert.equal(originAllowed(req('http://localhost:3000', 'localhost:3000', '127.0.0.1')), true);
  assert.equal(originAllowed(req('https://evil.example', 'localhost:3000', '127.0.0.1')), false);
  assert.equal(originAllowed(req(null, 'localhost:3000', '127.0.0.1')), true);
  assert.equal(originAllowed(req(null, 'metacode.lan:3000', '192.168.1.20')), false);
  assert.equal(originAllowed(req('null', 'localhost:3000', '127.0.0.1')), false);
});

test('browser relay: requests go to one claiming tab; answers are validated', async () => {
  const { RelayHub } = require('../scraper/network/browser-relay');
  const hub = new RelayHub({ maxResponseBytes: 1000 });
  hub.subscribers = 1;
  const seen = [];
  hub.on('request', r => seen.push(r));
  const p = hub.transportFor('job1').request({ url: 'https://www.reddit.com/r/a1.json', method: 'GET', headers: { 'user-agent': 'server-ua', accept: 'application/json', authorization: 'x' }, timeoutMs: 2000 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].headers, { accept: 'application/json' }, 'no user-agent or credentials are relayed');
  assert.equal(hub.unclaimed().length, 1);
  assert.ok(hub.claim(seen[0].id));
  assert.equal(hub.claim(seen[0].id), null, 'second tab cannot claim');
  assert.equal(hub.unclaimed().length, 0);
  assert.equal(hub.respond(seen[0].id, { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":1}' }), true);
  const res = await p;
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(hub.respond(seen[0].id, { status: 200, body: '' }), false, 'late answers are ignored');

  const bad = hub.transportFor('job1').request({ url: 'https://www.reddit.com/x', timeoutMs: 2000 });
  hub.respond(seen[1].id, { status: 99999, body: '' });
  await assert.rejects(bad, err => err.type === 'proxy_error');
  const big = hub.transportFor('job1').request({ url: 'https://www.reddit.com/x', timeoutMs: 2000 });
  hub.respond(seen[2].id, { status: 200, body: 'x'.repeat(2000) });
  await assert.rejects(big, err => err.type === 'too_large');
  const failed = hub.transportFor('job1').request({ url: 'https://www.reddit.com/x', timeoutMs: 2000 });
  hub.respond(seen[3].id, { error: 'invalid peer certificate: UnknownIssuer' });
  await assert.rejects(failed, err => err.type === 'tls');

  const cancelled = [];
  hub.on('cancel', c => cancelled.push(c.id));
  const dropped = hub.transportFor('job2').request({ url: 'https://www.reddit.com/x', timeoutMs: 2000 });
  hub.cancelJob('job2');
  await assert.rejects(dropped, err => err.type === 'cancelled');
  assert.equal(cancelled.length, 1);

  hub.subscribers = 0;
  await assert.rejects(hub.transportFor('job3').request({ url: 'https://www.reddit.com/x', timeoutMs: 50 }), err => err.type === 'browser_unavailable');
});
