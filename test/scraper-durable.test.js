// The scraper's reliability layer: circuit breaker, network providers (direct,
// administrator proxy, external VPN gateway), durable jobs with checkpoints,
// restart recovery, pause/resume, leases, backpressure and ownership.
// Everything runs against local mocks — none of this proves that a real
// proxy, VPN gateway or Reddit behaves the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

process.env.METACODE_LOG = 'off';

const { CircuitBreaker } = require('../scraper/network/circuit-breaker');
const { RequestMetrics, outcomeOfStatus, outcomeOfError } = require('../scraper/network/metrics');
const { ProxyProvider, DirectProvider, providersFromEnv } = require('../scraper/network/providers');
const { NetworkManager } = require('../scraper/network/network-manager');
const { JobStore } = require('../scraper/jobs/job-store');
const { JobManager } = require('../scraper/jobs/job-manager');
const { runStandardScrape } = require('../scraper/reddit/standard-scraper');
const { HostRateLimiter } = require('../scraper/network/rate-limiter');
const { RedditHttpClient } = require('../scraper/network/reddit-http');
const { normalizeTarget, normalizeOptions } = require('../scraper/reddit/targets');
const { ScraperError, classifyTransportError } = require('../scraper/errors');
const { testConfig, FakeTransport, json, startScraperApp, postJson, getJson } = require('./helpers/harness');
const { post, listing } = require('./helpers/mock-reddit');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-durable-'));
const FINAL = ['completed', 'failed', 'cancelled'];
const until = (jobs, job, statuses) => new Promise(resolve => {
  if (statuses.includes(job.status)) return resolve(job);
  jobs.on('event', function on(j, type, p) {
    if (j === job && type === 'status' && statuses.includes(p.status)) { jobs.off('event', on); resolve(job); }
  });
});

/* ── Circuit breaker ─────────────────────────────────────────── */

test('circuit breaker: opens after N qualifying failures, refuses while open, probes once, closes on success', () => {
  let now = 1000;
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, maxCooldownMs: 4000, now: () => now });
  assert.equal(b.check().allowed, true);
  b.record('timeout'); b.record('network');
  assert.equal(b.state, 'closed');
  b.record('http_5xx');
  assert.equal(b.state, 'open');
  const refused = b.check();
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAt, 2000);
  now = 2000;
  const probe = b.check();
  assert.deepEqual(probe, { allowed: true, probe: true });
  assert.equal(b.state, 'half_open');
  assert.equal(b.check().allowed, false, 'only one probe at a time');
  b.record('ok');
  assert.equal(b.state, 'closed');
  assert.equal(b.consecutiveFailures, 0);
});

test('circuit breaker: a failed probe reopens with a doubled cooldown (capped); answers never open it', () => {
  let now = 0;
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 3000, now: () => now });
  b.record('proxy');
  assert.equal(b.state, 'open');
  now = 1000; b.check(); b.record('timeout');
  assert.equal(b.snapshot().retryAt, new Date(3000).toISOString(), 'cooldown doubled to 2 s');
  now = 3000; b.check(); b.record('timeout');
  assert.equal(b.retryAt(), 6000, 'capped at 3 s');
  b.reset();
  assert.equal(b.state, 'closed');
  // 401/403/404/429 are answers from the source: the route works
  const c = new CircuitBreaker({ failureThreshold: 1, now: () => now });
  ['http_401', 'http_403', 'http_404', 'http_429', 'http_4xx', 'cancelled'].forEach(o => c.record(o));
  assert.equal(c.state, 'closed');
  c.force('the gateway reports its tunnel as "down"');
  assert.equal(c.check().allowed, false);
  c.force(null);
  assert.equal(c.check().allowed, true);
});

test('metrics: outcomes are classified and latency comes only from answered requests', () => {
  let now = 0;
  const m = new RequestMetrics({ now: () => now });
  const a = m.start(); now = 100; m.end(a, outcomeOfStatus(200));
  const b = m.start(); now = 400; m.end(b, outcomeOfStatus(503));
  const c = m.start(); now = 500; m.end(c, outcomeOfError(new ScraperError('timeout', 'x', { retryable: true })));
  const d = m.start(); m.end(d, outcomeOfStatus(429));
  const s = m.snapshot();
  assert.equal(s.total, 4);
  assert.deepEqual(s.byOutcome, { ok: 1, http_5xx: 1, timeout: 1, http_429: 1 });
  assert.equal(s.timeouts, 1);
  assert.equal(s.rateLimited, 1);
  assert.equal(s.recent.ok, 2, '200 and 429 are answers');
  assert.equal(s.recent.failed, 2);
  assert.equal(s.recent.p50Ms, 100);
  assert.equal(outcomeOfError(new ScraperError('proxy_blocked', 'refused')), 'blocked', 'a refused destination says nothing about the route');
  assert.equal(outcomeOfError(classifyTransportError(new Error('tls handshake eof'))), 'proxy');
});

/* ── Providers ───────────────────────────────────────────────── */

const RULES = { hostPatterns: [/^127\.0\.0\.1$/, /^(?:[a-z0-9-]+\.)*reddit\.com$/i], ports: [], allowPlainHttp: true };

test('providers: only administrator settings create routes; SOCKS and bad URLs are reported, not used', () => {
  const transport = new FakeTransport(() => ({ status: 200 }));
  const deps = { transport, rules: RULES, maxResponseBytes: 1024 };
  let r = providersFromEnv({}, deps);
  assert.deepEqual(r.order, ['direct']);
  assert.equal(r.failover, false);
  r = providersFromEnv({ SCRAPER_PROXY_URL: 'socks5://gw:1080', SCRAPER_NETWORK_PROVIDERS: 'proxy' }, deps);
  assert.match(r.providers[0].problems.join(' '), /SOCKS/);
  assert.equal(r.providers[0].capabilities.socks, false);
  r = providersFromEnv({ SCRAPER_VPN_GATEWAY_PROXY_URL: 'http://user:s3cret-pass@gateway.internal:8888', SCRAPER_VPN_GATEWAY_HEALTH_URL: 'http://gateway.internal:8000/v1/vpn/status',
    SCRAPER_NETWORK_PROVIDERS: 'vpn-gateway,direct,nope', SCRAPER_NETWORK_FAILOVER: 'on' }, deps);
  assert.deepEqual(r.order, ['vpn-gateway', 'direct']);
  assert.equal(r.failover, true);
  assert.ok(r.warnings.some(w => /nope/.test(w)));
  const gw = r.providers[0];
  assert.equal(gw.kind, 'vpn-gateway');
  assert.equal(gw.capabilities.healthCheck, true);
  assert.equal(gw.capabilities.changesEgressIp, true);
  const shown = JSON.stringify(gw.adminDetails());
  assert.ok(!/s3cret|user:/.test(shown), 'no credentials in admin details: ' + shown);
  assert.match(shown, /gateway\.internal:8888 \(with credentials\)/);
  r.providers.forEach(p => p.close && p.close());
});

// A minimal HTTP CONNECT proxy (what an administrator's proxy or VPN gateway exposes)
function startConnectProxy(opts) {
  opts = opts || {};
  const seen = { connects: [], auth: [] };
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    seen.connects.push(req.url);
    seen.auth.push(req.headers['proxy-authorization'] || null);
    if (opts.refuse) { clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: 'http://127.0.0.1:' + server.address().port })));
}

function startOrigin(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port })));
}

test('proxy provider: requests are tunnelled through the administrator\'s proxy, with its credentials, and the allow-list still applies', async () => {
  const origin = await startOrigin((req, res) => {
    if (req.url === '/big') { res.writeHead(200); res.end('x'.repeat(5000)); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: req.url, ua: req.headers['user-agent'] }));
  });
  const proxy = await startConnectProxy();
  const p = new ProxyProvider({ id: 'proxy', proxyUrl: proxy.url.replace('//', '//admin:pw@'), rules: Object.assign({}, RULES, { ports: [origin.port] }), maxResponseBytes: 1024 });
  try {
    const res = await p.request({ url: origin.url + '/r/test/new.json?limit=1', method: 'GET', headers: { 'user-agent': 'test-ua' }, timeoutMs: 5000 });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).path, '/r/test/new.json?limit=1');
    assert.deepEqual(proxy.seen.connects, ['127.0.0.1:' + origin.port]);
    assert.equal(proxy.seen.auth[0], 'Basic ' + Buffer.from('admin:pw').toString('base64'));
    await assert.rejects(p.request({ url: origin.url + '/big', method: 'GET', headers: {}, timeoutMs: 5000 }), e => e.type === 'too_large');
    await assert.rejects(p.request({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET', headers: {}, timeoutMs: 5000 }), e => e.type === 'host_not_allowed');
    assert.equal(proxy.seen.connects.length, 2, 'the refused destination never reached the proxy');
  } finally {
    p.close(); proxy.server.close(); origin.server.close();
  }
});

test('proxy provider: a proxy that refuses the tunnel or is down is a classified route failure (no addresses in the message)', async () => {
  const proxy = await startConnectProxy({ refuse: true });
  const p = new ProxyProvider({ id: 'proxy', proxyUrl: proxy.url, rules: Object.assign({}, RULES, { ports: [9] }), maxResponseBytes: 1024 });
  const dead = new ProxyProvider({ id: 'proxy', proxyUrl: 'http://127.0.0.1:1', rules: Object.assign({}, RULES, { ports: [9] }), maxResponseBytes: 1024 });
  try {
    await assert.rejects(p.request({ url: 'http://127.0.0.1:9/x', method: 'GET', headers: {}, timeoutMs: 3000 }), e => e.type === 'proxy_error' && /HTTP 403/.test(e.message) && !/127\.0\.0\.1/.test(e.message));
    await assert.rejects(dead.request({ url: 'http://127.0.0.1:9/x', method: 'GET', headers: {}, timeoutMs: 3000 }), e => e.type === 'proxy_error' && outcomeOfError(e) === 'proxy');
  } finally { p.close(); dead.close(); proxy.server.close(); }
});

/* ── Network manager ─────────────────────────────────────────── */

test('network manager: an open circuit refuses at once with a retry time; Reddit refusing access never opens it', async () => {
  let mode = 'down';
  const transport = new FakeTransport(() => {
    if (mode === 'down') throw classifyTransportError(new Error('connection reset'));
    if (mode === 'forbidden') return { status: 403, body: '<html>blocked</html>' };
    return { status: 200, body: '{}' };
  });
  const m = new NetworkManager({ providers: [new DirectProvider({ transport })], breaker: { failureThreshold: 2, cooldownMs: 60000 } });
  const req = { url: 'https://www.reddit.com/r/x.json', method: 'GET', headers: {}, timeoutMs: 1000 };
  await assert.rejects(m.request(req), e => e.type === 'network');
  await assert.rejects(m.request(req), e => e.type === 'network');
  const sent = transport.requests.length;
  await assert.rejects(m.request(req), e => e.type === 'network_unavailable' && e.retryAfterMs > 50000);
  assert.equal(transport.requests.length, sent, 'nothing was sent while the circuit is open');
  assert.equal(m.publicStatus()[0].state, 'unavailable');
  m.reset('direct');
  mode = 'forbidden';
  for (let i = 0; i < 5; i++) assert.equal((await m.request(req)).status, 403);
  assert.equal(m.publicStatus()[0].circuit, 'closed', '403s are answers, not outages');
  const admin = m.adminStatus().providers[0];
  assert.equal(admin.metrics.byOutcome.http_403, 5);
  assert.ok(admin.metrics.total >= 7);
  m.close();
});

test('network manager: a VPN gateway that reports its tunnel down fails closed — no silent fallback to the direct route', async () => {
  let gatewayStatus = 'running';
  const control = await startOrigin((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: gatewayStatus })); });
  const origin = await startOrigin((req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  const proxy = await startConnectProxy();
  const direct = new FakeTransport(() => ({ status: 200, body: '{"direct":true}' }));
  const build = failover => providersFromEnv({
    SCRAPER_VPN_GATEWAY_PROXY_URL: proxy.url, SCRAPER_VPN_GATEWAY_HEALTH_URL: control.url + '/v1/vpn/status',
    SCRAPER_NETWORK_PROVIDERS: 'vpn-gateway,direct', SCRAPER_NETWORK_FAILOVER: failover ? 'on' : 'off'
  }, { transport: direct, rules: Object.assign({}, RULES, { ports: [origin.port] }), maxResponseBytes: 4096 });
  const req = { url: origin.url + '/r/x.json', method: 'GET', headers: {}, timeoutMs: 3000 };
  const strict = build(false);
  const m = new NetworkManager({ providers: strict.providers, failover: strict.failover });
  try {
    assert.equal((await m.checkHealth('vpn-gateway')).ok, true);
    assert.equal((await m.request(req)).provider, 'vpn-gateway');
    gatewayStatus = 'disconnected';
    const h = await m.checkHealth('vpn-gateway');
    assert.equal(h.ok, false);
    assert.match(h.detail, /disconnected/);
    await assert.rejects(m.request(req), e => e.type === 'network_unavailable' && /disconnected/.test(e.message));
    assert.equal(direct.requests.length, 0, 'the direct route was not used');
    // With the administrator's explicit failover policy, the next listed route carries requests while the gateway is down
    const loose = build(true);
    const f = new NetworkManager({ providers: loose.providers, failover: loose.failover });
    await f.checkHealth('vpn-gateway');
    assert.equal((await f.request(req)).provider, 'direct');
    gatewayStatus = 'running';
    await f.checkHealth('vpn-gateway');
    assert.equal((await f.request(req)).provider, 'vpn-gateway', 'back to the preferred route once it is healthy');
    f.close();
  } finally {
    m.close(); proxy.server.close(); origin.server.close(); control.server.close();
  }
});

test('VPN gateway: configuring it is enough to use it; an explicit list that leaves it out is reported', () => {
  const transport = new FakeTransport(() => ({ status: 200 }));
  const deps = { transport, rules: RULES, maxResponseBytes: 1024 };
  let r = providersFromEnv({ SCRAPER_VPN_GATEWAY_PROXY_URL: 'http://127.0.0.1:8888' }, deps);
  assert.deepEqual(r.order, ['vpn-gateway'], 'the gateway is used without SCRAPER_NETWORK_PROVIDERS');
  assert.deepEqual(r.warnings, []);
  r.providers.forEach(p => p.close && p.close());
  r = providersFromEnv({ SCRAPER_PROXY_URL: 'http://127.0.0.1:3128' }, deps);
  assert.deepEqual(r.order, ['proxy']);
  r.providers.forEach(p => p.close && p.close());
  r = providersFromEnv({ SCRAPER_VPN_GATEWAY_PROXY_URL: 'http://127.0.0.1:8888', SCRAPER_NETWORK_PROVIDERS: 'direct' }, deps);
  assert.deepEqual(r.order, ['direct'], 'the administrator\'s explicit choice wins');
  assert.ok(r.warnings.some(w => /doesn't list "vpn-gateway"/.test(w)), r.warnings.join(' | '));
  r = providersFromEnv({ SCRAPER_VPN_GATEWAY_HEALTH_URL: 'http://127.0.0.1:8000/v1/vpn/status' }, deps);
  assert.deepEqual(r.order, ['direct']);
  assert.ok(r.warnings.some(w => /without SCRAPER_VPN_GATEWAY_PROXY_URL/.test(w)));
});

test('VPN gateway: a protected status endpoint (gluetun-style API key or basic auth) works with credentials; without them it is reported, not a reason to stop traffic', async () => {
  const seen = [];
  const control = await startOrigin((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'] || null, auth: req.headers.authorization || null });
    const authed = req.headers['x-api-key'] === 'k3y-123' || req.headers.authorization === 'Basic ' + Buffer.from('ops:pw').toString('base64');
    if (!authed) { res.writeHead(401); res.end('unauthorized'); return; }
    const body = req.url === '/v1/publicip/ip' ? { public_ip: '185.65.135.7', country: 'Sweden', city: 'Stockholm' } : req.url === '/v1/vpn/status' ? { status: 'running' } : null;
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const origin = await startOrigin((req, res) => { res.writeHead(200); res.end('User-agent: *'); });
  const proxy = await startConnectProxy();
  const rules = Object.assign({}, RULES, { ports: [origin.port] });
  const make = env => providersFromEnv(Object.assign({ SCRAPER_VPN_GATEWAY_PROXY_URL: proxy.url, SCRAPER_VPN_GATEWAY_HEALTH_URL: control.url + '/v1/vpn/status',
    SCRAPER_VPN_GATEWAY_IP_URL: control.url + '/v1/publicip/ip' }, env), { transport: new FakeTransport(() => ({ status: 200 })), rules, maxResponseBytes: 4096 });
  const req = { url: origin.url + '/robots.txt', method: 'GET', headers: {}, timeoutMs: 3000 };
  const managers = [];
  try {
    // No credentials: a configuration problem — reported, traffic still flows
    const bare = make({});
    const m1 = new NetworkManager({ providers: bare.providers });
    managers.push(m1);
    const h1 = await m1.checkHealth('vpn-gateway');
    assert.equal(h1.ok, false);
    assert.equal(h1.kind, 'config');
    assert.match(h1.detail, /SCRAPER_VPN_GATEWAY_HEALTH_API_KEY/);
    assert.equal((await m1.request(req)).provider, 'vpn-gateway', 'a misconfigured status endpoint doesn\'t block requests');
    assert.equal(m1.publicStatus()[0].circuit, 'closed');
    // API key → healthy, with the exit address
    const keyed = make({ SCRAPER_VPN_GATEWAY_HEALTH_API_KEY: 'k3y-123' });
    const m2 = new NetworkManager({ providers: keyed.providers });
    managers.push(m2);
    const h2 = await m2.checkHealth('vpn-gateway');
    assert.equal(h2.ok, true, JSON.stringify(h2));
    assert.equal(h2.exitIp, '185.65.135.7');
    assert.equal(h2.exitLocation, 'Stockholm, Sweden');
    assert.equal(seen.filter(x => x.key === 'k3y-123').length, 2, 'the key went to both status endpoints');
    const shown = JSON.stringify(m2.adminStatus());
    assert.ok(!/k3y-123/.test(shown), 'the key is never shown');
    assert.match(shown, /"statusAuth":"API key"/);
    // user:password in the URL → basic auth; the stored URL keeps no credentials
    const basic = make({ SCRAPER_VPN_GATEWAY_HEALTH_URL: control.url.replace('//', '//ops:pw@') + '/v1/vpn/status', SCRAPER_VPN_GATEWAY_IP_URL: '' });
    const m3 = new NetworkManager({ providers: basic.providers });
    managers.push(m3);
    assert.equal((await m3.checkHealth('vpn-gateway')).ok, true);
    assert.ok(!/ops|pw@/.test(JSON.stringify(m3.adminStatus())));
    // A wrong path is a configuration problem too
    const wrong = make({ SCRAPER_VPN_GATEWAY_HEALTH_API_KEY: 'k3y-123', SCRAPER_VPN_GATEWAY_HEALTH_URL: control.url + '/v1/nope', SCRAPER_VPN_GATEWAY_IP_URL: '' });
    const m4 = new NetworkManager({ providers: wrong.providers });
    managers.push(m4);
    const h4 = await m4.checkHealth('vpn-gateway');
    assert.equal(h4.kind, 'config');
    assert.match(h4.detail, /HTTP 404/);
    // The gateway itself unreachable: that is an outage, and it stops traffic
    const gone = make({ SCRAPER_VPN_GATEWAY_HEALTH_URL: 'http://127.0.0.1:1/v1/vpn/status', SCRAPER_VPN_GATEWAY_IP_URL: '' });
    const m5 = new NetworkManager({ providers: gone.providers });
    managers.push(m5);
    const h5 = await m5.checkHealth('vpn-gateway');
    assert.equal(h5.kind, 'down');
    await assert.rejects(m5.request(req), e => e.type === 'network_unavailable');
  } finally {
    managers.forEach(m => m.close()); proxy.server.close(); origin.server.close(); control.server.close();
  }
});

test('route test: one real request through a route says whether it works end to end, without touching its circuit', async () => {
  const origin = await startOrigin((req, res) => { if (req.url === '/blocked') { res.writeHead(403); res.end(); return; } res.writeHead(200); res.end('ok'); });
  const proxy = await startConnectProxy();
  const rules = Object.assign({}, RULES, { ports: [origin.port] });
  const net = providersFromEnv({ SCRAPER_VPN_GATEWAY_PROXY_URL: proxy.url }, { transport: new FakeTransport(() => ({ status: 200 })), rules, maxResponseBytes: 4096 });
  const m = new NetworkManager({ providers: net.providers });
  const bad = new NetworkManager({ providers: providersFromEnv({ SCRAPER_VPN_GATEWAY_PROXY_URL: 'http://127.0.0.1:1' }, { transport: new FakeTransport(() => ({ status: 200 })), rules, maxResponseBytes: 4096 }).providers });
  try {
    const ok = await m.test('vpn-gateway', { url: origin.url + '/robots.txt' });
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.match(ok.detail, /through the VPN gateway/);
    const refused = await m.test('vpn-gateway', { url: origin.url + '/blocked' });
    assert.equal(refused.ok, true, 'the route works even when the site refuses the address');
    assert.match(refused.detail, /refused this address \(HTTP 403\)/);
    const down = await bad.test('vpn-gateway', { url: origin.url + '/robots.txt' });
    assert.equal(down.ok, false);
    assert.match(down.detail, /Couldn't reach the VPN gateway/);
    assert.equal(bad.publicStatus()[0].circuit, 'closed', 'tests don\'t count towards the circuit');
    assert.equal(await m.test('nope', { url: origin.url }), null);
  } finally { m.close(); bad.close(); proxy.server.close(); origin.server.close(); }
});

/* ── Durable jobs ────────────────────────────────────────────── */

// A scripted subreddit of `total` posts served 100 per page; `failAfter`: pages before the "network" dies.
function scriptedReddit(total, state) {
  return req => {
    const u = new URL(req.url);
    if (u.pathname === '/robots.txt') return { status: 404 };
    if (u.pathname.endsWith('/about.json')) return json({ kind: 't5', data: { display_name: 'test' } });
    state.pages = (state.pages || 0) + 1;
    state.afters = (state.afters || []).concat(u.searchParams.get('after'));
    if (state.failFrom && state.pages >= state.failFrom) throw classifyTransportError(new Error('connection reset by peer'));
    const after = u.searchParams.get('after');
    const start = after ? Number(after.split('_')[1]) : 0;
    const kids = [];
    for (let i = start; i < Math.min(total, start + 100); i++) kids.push(post('test', i));
    return json(listing(kids, start + 100 < total ? 'x_' + (start + 100) : null));
  };
}

function durableManager(dir, handler, env, extra) {
  const config = testConfig(Object.assign({ SCRAPER_DATA_DIR: dir }, env || {}));
  const transport = new FakeTransport(handler);
  const httpClient = new RedditHttpClient({ config, transport, limiter: new HostRateLimiter({ maxConcurrent: 2 }) });
  httpClient.backoff = () => 5;
  const store = new JobStore({ dir, instanceId: (extra && extra.instance) || 'inst-' + Math.random(), leaseMs: (extra && extra.leaseMs) || 60000 });
  const jobs = new JobManager({ config, http: httpClient, store, logToConsole: false, runners: { standard: (job, ctx) => runStandardScrape(job.target, job.options, ctx) },
    reattach: (extra && extra.reattach) || (() => ({ http: null })) });
  return { jobs, store, transport, config };
}

test('durable jobs: records and checkpoints are on disk; a checkpoint is only written after its records', async () => {
  const dir = tmpDir();
  const state = {};
  const { jobs, store, config } = durableManager(dir, scriptedReddit(250, state));
  const order = [];
  const append = store.appendRecords.bind(store), save = store.save.bind(store);
  store.appendRecords = (id, recs) => { order.push('records:' + recs.length); return append(id, recs); };
  store.save = s => { if (s.checkpoint) order.push('checkpoint:' + s.checkpoint.items); return save(s); };
  const job = jobs.create({ mode: 'standard', target: normalizeTarget({ type: 'subreddit', subreddit: 'test', sort: 'new' }), options: normalizeOptions({ maxItems: 250, maxPages: 5, includeMetadata: false }, config) });
  await until(jobs, job, FINAL);
  assert.equal(job.status, 'completed');
  const firstCp = order.findIndex(o => o.startsWith('checkpoint:'));
  assert.ok(firstCp > 0 && order[firstCp - 1] === 'records:100' && order[firstCp] === 'checkpoint:100', order.join(' '));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', job.id, 'job.json'), 'utf8'));
  assert.equal(saved.status, 'completed');
  assert.equal(saved.itemCount, 250);
  assert.equal(saved.checkpoint.state.phase, 'done');
  assert.ok(!('credentials' in saved) && !JSON.stringify(saved).includes('clientSecret'));
  assert.equal(store.readRecords(job.id).length, 250);
  // A torn last line (crash mid-write) is ignored
  fs.appendFileSync(path.join(dir, 'jobs', job.id, 'records.ndjson'), '{"record_type":"post","fullna');
  assert.equal(store.readRecords(job.id).length, 250);
  jobs.shutdown();
});

test('durable jobs: after a restart, a standard scrape continues from its checkpoint without re-reading earlier pages or duplicating records', async () => {
  const dir = tmpDir();
  const state = {};
  const first = durableManager(dir, scriptedReddit(450, state), {}, { instance: 'one' });
  const target = normalizeTarget({ type: 'subreddit', subreddit: 'test', sort: 'new' });
  const options = normalizeOptions({ maxItems: 450, maxPages: 10, includeMetadata: false }, first.config);
  const job = first.jobs.create({ mode: 'standard', target, options });
  // Stop the "server" after two pages are committed
  await new Promise(resolve => first.jobs.on('event', function on(j, type) {
    if (j === job && type === 'records' && job.itemCount >= 200) { first.jobs.off('event', on); resolve(); }
  }));
  first.jobs.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', job.id, 'job.json'), 'utf8'));
  assert.equal(saved.status, 'queued', 'left queued to continue after the restart');
  assert.ok(saved.checkpoint && saved.checkpoint.items >= 100);
  const resumeAfter = saved.checkpoint.state.after;

  const state2 = {};
  const second = durableManager(dir, scriptedReddit(450, state2), {}, { instance: 'two' });
  const r = second.jobs.recover();
  assert.equal(r.resumed, 1);
  const again = second.jobs.get(job.id);
  await until(second.jobs, again, FINAL);
  assert.equal(again.status, 'completed', JSON.stringify(again.error));
  assert.equal(state2.afters[0], resumeAfter, 'the first request after the restart continues at the checkpoint cursor');
  assert.ok(!state2.afters.includes(null), 'the listing was not restarted from the top');
  const recs = second.store.readRecords(job.id);
  assert.equal(recs.length, 450);
  assert.equal(new Set(recs.map(x => x.fullname)).size, 450, 'no duplicates on disk');
  assert.equal(again.attempts, 2);
  const events = second.jobs.events(again, 0, 500).events;
  assert.ok(events.some(e => e.type === 'recovered'));
  second.jobs.shutdown();
});

test('durable jobs: jobs that need the user (own keys, browser) wait for them after a restart; custom/AI jobs end as interrupted with their records', async () => {
  const dir = tmpDir();
  const gate = new Promise(() => {});
  const config = testConfig({ SCRAPER_DATA_DIR: dir });
  const store = new JobStore({ dir, instanceId: 'a' });
  const runners = {
    standard: async (job, ctx) => { ctx.emit([{ record_type: 'post', fullname: 't3_' + job.label }]); await gate; },
    custom: async (job, ctx) => { ctx.emit([{ record_type: 'post', fullname: 't3_c1' }, { record_type: 'post', fullname: 't3_c2' }]); await gate; }
  };
  const jobs = new JobManager({ config: Object.assign({}, config, { maxConcurrentJobs: 5 }), http: {}, store, runners, logToConsole: false });
  const own = jobs.create({ mode: 'standard', label: 'own', keySource: 'own', target: { label: 'own' }, options: { maxItems: 10 } });
  const custom = jobs.create({ mode: 'custom', label: 'custom', target: null, options: { maxItems: 10 }, code: 'x' });
  await new Promise(r => setTimeout(r, 30));
  // A crash: nothing is shut down cleanly, the leases simply expire
  fs.writeFileSync(path.join(dir, 'jobs', own.id, 'lease'), JSON.stringify({ instance: 'a', expiresAt: 0 }));
  fs.writeFileSync(path.join(dir, 'jobs', custom.id, 'lease'), JSON.stringify({ instance: 'a', expiresAt: 0 }));
  const store2 = new JobStore({ dir, instanceId: 'b' });
  const jobs2 = new JobManager({ config, http: {}, store: store2, runners, logToConsole: false, reattach: j => (j.keySource === 'own' ? { needs: 'keys' } : { http: null }) });
  const r = jobs2.recover();
  assert.equal(r.paused, 1);
  assert.equal(r.interrupted, 1);
  const o = jobs2.get(own.id), c = jobs2.get(custom.id);
  assert.equal(o.status, 'paused');
  assert.equal(o.pausedReason, 'needs_keys');
  assert.throws(() => jobs2.resume(o.id), /own Reddit API keys/);
  assert.equal(c.status, 'failed');
  assert.equal(c.error.type, 'interrupted');
  assert.match(c.error.message, /2 items collected before that are kept/);
  assert.equal(jobs2.recordsOf(c).length, 2);
});

test('durable jobs: a live lease held by another process is respected; a stale one is taken over', () => {
  const dir = tmpDir();
  let now = 1000;
  const a = new JobStore({ dir, instanceId: 'A', leaseMs: 1000, now: () => now });
  const b = new JobStore({ dir, instanceId: 'B', leaseMs: 1000, now: () => now });
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(a.acquireLease(id), true);
  assert.equal(b.acquireLease(id), false, 'A holds it');
  assert.equal(a.renewLease(id), true);
  assert.equal(b.renewLease(id), false);
  now += 5000;
  assert.equal(b.acquireLease(id), true, 'A stopped renewing: stale');
  a.releaseLease(id);
  assert.ok(b.leaseOf(id), 'A can no longer release B\'s lease');
  assert.throws(() => a.jobDir('../../etc'), /Invalid job id/);
});

test('pause and resume: a running scrape stops at a safe point and continues from its checkpoint', async () => {
  const dir = tmpDir();
  const state = {};
  let slow = true;
  const base = scriptedReddit(300, state);
  const { jobs, store, config } = durableManager(dir, async req => {
    if (slow && state.pages >= 1) await new Promise(r => setTimeout(r, 200));
    return base(req);
  });
  const job = jobs.create({ mode: 'standard', target: normalizeTarget({ type: 'subreddit', subreddit: 'test', sort: 'new' }), options: normalizeOptions({ maxItems: 300, maxPages: 10, includeMetadata: false }, config) });
  await new Promise(resolve => jobs.on('event', function on(j, type) { if (j === job && type === 'records') { jobs.off('event', on); resolve(); } }));
  jobs.pause(job.id);
  await until(jobs, job, ['paused']);
  assert.equal(job.pausedReason, 'user');
  const at = job.itemCount;
  assert.ok(at >= 100 && at < 300);
  assert.throws(() => jobs.reconfigure(job.id, { maxItems: 5000 }, { minDelayMs: 0, maxPages: 50 }), /only be lowered/);
  jobs.reconfigure(job.id, { delayMs: 10 }, { minDelayMs: 0, maxPages: 50 });
  slow = false;
  jobs.resume(job.id);
  await until(jobs, job, FINAL);
  assert.equal(job.status, 'completed');
  assert.equal(store.readRecords(job.id).length, 300);
  assert.equal(job.options.delayMs, 10);
  assert.equal(job.attempts, 2);
  jobs.shutdown();
});

test('a route outage puts the job in "waiting" until the circuit allows a retry, then it continues', async () => {
  const dir = tmpDir();
  const state = { failFrom: 2 };
  const config = testConfig({ SCRAPER_DATA_DIR: dir });
  const direct = new FakeTransport(scriptedReddit(300, state));
  const network = new NetworkManager({ providers: [new DirectProvider({ transport: direct })], breaker: { failureThreshold: 2, cooldownMs: 300 } });
  const httpClient = new RedditHttpClient({ config, transport: network, limiter: new HostRateLimiter({ maxConcurrent: 1 }) });
  httpClient.backoff = () => 5;
  const jobs = new JobManager({ config, http: httpClient, store: new JobStore({ dir, instanceId: 'w' }), logToConsole: false,
    runners: { standard: (job, ctx) => runStandardScrape(job.target, job.options, ctx) } });
  const job = jobs.create({ mode: 'standard', target: normalizeTarget({ type: 'subreddit', subreddit: 'test', sort: 'new' }), options: normalizeOptions({ maxItems: 300, maxPages: 10, includeMetadata: false, retries: 2 }, config) });
  await until(jobs, job, ['waiting']);
  assert.ok(job.retryAt);
  assert.match(job.progress.message, /Waiting until/);
  state.failFrom = 0;                                  // the route recovers
  await until(jobs, job, FINAL);
  assert.equal(job.status, 'completed', JSON.stringify(job.error || job.lastError));
  assert.equal(job.itemCount, 300);
  assert.ok(job.waits >= 1);
  jobs.shutdown();
  network.close();
});

test('access denied stops the job at once: no waiting, no other route', async () => {
  const dir = tmpDir();
  const { jobs, config, transport } = durableManager(dir, req => (new URL(req.url).pathname === '/robots.txt' ? { status: 404 } : { status: 403, headers: { 'content-type': 'application/json' }, body: '{"reason":"private"}' }));
  const job = jobs.create({ mode: 'standard', target: normalizeTarget({ type: 'subreddit', subreddit: 'test', sort: 'new' }), options: normalizeOptions({ includeMetadata: false }, config) });
  await until(jobs, job, FINAL);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.type, 'forbidden_private');
  assert.equal(job.waits, 0);
  assert.equal(transport.requests.filter(r => !r.url.endsWith('robots.txt')).length, 1, 'asked once');
  jobs.shutdown();
});

test('incremental collection: "since" stops a newest-first listing at items an earlier job covered', async () => {
  const dir = tmpDir();
  const state = {};
  // Newest first: post i was created at 1700000000 + i*60, so serve descending ids
  const { jobs, config } = durableManager(dir, req => {
    const u = new URL(req.url);
    if (u.pathname === '/robots.txt') return { status: 404 };
    state.pages = (state.pages || 0) + 1;
    const after = u.searchParams.get('after');
    const start = after ? Number(after.split('_')[1]) : 0;
    const kids = [];
    for (let i = start; i < start + 100; i++) kids.push(post('test', 999 - i));
    return json(listing(kids, 'x_' + (start + 100)));
  });
  const since = 1700000000 + 900 * 60;     // posts 900..999 are newer
  const job = jobs.create({ mode: 'standard', target: normalizeTarget({ type: 'subreddit', subreddit: 'test', sort: 'new' }), options: normalizeOptions({ maxItems: 1000, maxPages: 10, includeMetadata: false, since }, config) });
  await until(jobs, job, FINAL);
  assert.equal(job.status, 'completed');
  assert.equal(job.itemCount, 100, 'only posts from "since" on (999 … 900)');
  assert.equal(state.pages, 2, 'stopped on the first page with an older item');
  assert.throws(() => normalizeOptions({ since: '1999-01-01' }, config), /June 2005/);
  jobs.shutdown();
});

/* ── API ─────────────────────────────────────────────────────── */

test('API: pause/resume/summary/history/settings are owner-scoped; the queue applies backpressure; admin diagnostics are closed to users', async () => {
  const dir = tmpDir();
  const { createMockReddit } = require('./helpers/mock-reddit');
  const reddit = createMockReddit({ postsPerSub: 400 });
  const redditBase = await reddit.listen();
  const app = await startScraperApp({ SCRAPER_DATA_DIR: dir, REDDIT_BASE_URL: redditBase, SCRAPER_RESPECT_ROBOTS_TXT: 'false', SCRAPER_MAX_CONCURRENT_JOBS: '1', SCRAPER_MAX_QUEUED_JOBS: '1', SCRAPER_DEFAULT_DELAY_MS: '150' });
  const mine = { cookie: 'mc_owner=' + 'a'.repeat(40) }, theirs = { cookie: 'mc_owner=' + 'b'.repeat(40) };
  const call = (method, url, body, headers) => fetch(url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, headers: r.headers, json: await r.json().catch(() => null) }));
  try {
    const target = { type: 'subreddit', subreddit: 'slowsub', sort: 'new' };
    const a = await call('POST', app.api + '/jobs', { target, options: { maxItems: 400, maxPages: 10, includeMetadata: false } }, mine);
    assert.equal(a.status, 202);
    const id = a.json.job.id;
    const b = await call('POST', app.api + '/jobs', { target, options: { maxItems: 10, includeMetadata: false } }, mine);
    assert.equal(b.status, 202, 'one may wait in the queue');
    const c = await call('POST', app.api + '/jobs', { target, options: { maxItems: 10, includeMetadata: false } }, mine);
    assert.equal(c.status, 503);
    assert.equal(c.json.error.type, 'queue_full');
    assert.ok(Number(c.headers.get('retry-after')) > 0);
    // Someone else's job: every route answers like a missing one
    for (const [m, suffix] of [['POST', '/pause'], ['POST', '/resume'], ['GET', '/summary'], ['GET', '/history'], ['PATCH', '']]) {
      const r = await call(m, app.api + '/jobs/' + id + suffix, m === 'GET' ? null : {}, theirs);
      assert.equal(r.status, 404, m + ' ' + suffix);
    }
    const deadline = Date.now() + 10000;
    while ((await call('GET', app.api + '/jobs/' + id, null, mine)).json.job.itemCount === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
    const p = await call('POST', app.api + '/jobs/' + id + '/pause', {}, mine);
    assert.equal(p.status, 200, JSON.stringify(p.json));
    let job;
    do { await new Promise(r => setTimeout(r, 30)); job = (await call('GET', app.api + '/jobs/' + id, null, mine)).json.job; } while (job.status !== 'paused' && Date.now() < deadline);
    assert.equal(job.status, 'paused');
    assert.equal(job.resumable, true);
    assert.ok(job.checkpoint && job.checkpoint.items > 0);
    assert.equal((await call('PATCH', app.api + '/jobs/' + id, { delayMs: 10 }, mine)).status, 200);
    assert.equal((await call('PATCH', app.api + '/jobs/' + id, { maxItems: 100000 }, mine)).status, 400);
    const s = await call('GET', app.api + '/jobs/' + id + '/summary', null, mine);
    assert.equal(s.json.summary.items, job.itemCount);
    assert.equal(s.json.summary.byType.post, job.itemCount);
    assert.ok(s.json.summary.requests.total >= 1);
    const r = await call('POST', app.api + '/jobs/' + id + '/resume', {}, mine);
    assert.equal(r.status, 200);
    do { await new Promise(res => setTimeout(res, 50)); job = (await call('GET', app.api + '/jobs/' + id, null, mine)).json.job; } while (!FINAL.includes(job.status) && Date.now() < deadline + 20000);
    assert.equal(job.status, 'completed');
    assert.equal(job.itemCount, 400);
    const h = await call('GET', app.api + '/jobs/' + id + '/history?limit=500', null, mine);
    const types = h.json.events.map(e => e.type);
    ['created', 'checkpoint', 'pause_requested', 'resume', 'config'].forEach(t => assert.ok(types.includes(t), t + ' in ' + types.join(',')));
    // Network status for everyone, diagnostics only for administrators
    const st = await getJson(app.api + '/status');
    assert.equal(st.json.network[0].id, 'direct');
    assert.equal(st.json.jobStore.persistent, true);
    assert.equal((await getJson(app.api + '/admin/network')).status, 403);
    // Job lists are paged
    const list = await call('GET', app.api + '/jobs?limit=1', null, mine);
    assert.equal(list.json.jobs.length, 1);
    assert.ok(list.json.next);
  } finally {
    await app.close();
    await reddit.close();
  }
});

test('API: administrators see providers, circuits, metrics and queue health — never credentials', async () => {
  const dir = tmpDir();
  const app = await startScraperApp({ SCRAPER_DATA_DIR: dir, SCRAPER_PROXY_URL: 'http://ops:hunter2@proxy.internal:3128' }, { });
  const { createScraper } = require('../scraper');
  const { loadScraperConfig } = require('../scraper/config');
  const express = require('express');
  const config = loadScraperConfig(Object.assign(require('./helpers/harness').testEnv({ SCRAPER_DATA_DIR: tmpDir(), SCRAPER_PROXY_URL: 'http://ops:hunter2@proxy.internal:3128', SCRAPER_NETWORK_PROVIDERS: 'proxy,direct' })));
  const scraper = createScraper({ config, logToConsole: false, adminGuard: (req, res, next) => (req.headers['x-test-admin'] === 'yes' ? next() : res.status(403).json({ error: { type: 'forbidden', message: 'no' } })) });
  const a = express(); a.use(express.json()); a.use('/api/scraper', scraper.router);
  const server = http.createServer(a);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/scraper';
  try {
    assert.equal((await fetch(base + '/admin/network')).status, 403);
    const r = await fetch(base + '/admin/network', { headers: { 'x-test-admin': 'yes' } });
    const body = await r.json();
    assert.equal(r.status, 200);
    const text = JSON.stringify(body);
    assert.ok(!/hunter2|ops:/.test(text), 'no proxy credentials');
    assert.deepEqual(body.order, ['proxy', 'direct']);
    assert.equal(body.providers[0].details.proxy, 'http://proxy.internal:3128 (with credentials)');
    assert.ok(body.jobs && 'queueDepth' in body.jobs);
    const pub = await (await fetch(base + '/network')).json();
    assert.ok(!/proxy\.internal/.test(JSON.stringify(pub)), 'ordinary users don\'t see the proxy\'s address');
    const reset = await fetch(base + '/admin/network/proxy/reset', { method: 'POST', headers: { 'x-test-admin': 'yes' } });
    assert.equal(reset.status, 200);
    const check = await fetch(base + '/admin/network/proxy/check', { method: 'POST', headers: { 'x-test-admin': 'yes' } });
    assert.equal(check.status, 400, 'a plain proxy has no health check');
  } finally {
    scraper.shutdown();
    server.close();
    await app.close();
  }
});
