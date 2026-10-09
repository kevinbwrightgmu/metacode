// MetaCode's two ways for the Reddit Collector to reach Reddit, as a server
// sees them: the Wisp WebSocket (/wisp/) behind a reverse proxy, and the HTTP
// relay (/api/scraper/fetch) used when WebSockets can't get through.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createCollectorMock } = require('./helpers/collector-mock');
const { testEnv } = require('./helpers/harness');
const { isPrivateAddress } = require('../scraper/network/http-relay');

let mock, mirror, server, port;
test.before(async () => {
  mock = createCollectorMock();
  mirror = await mock.listen();
  Object.assign(process.env, testEnv({ REDDIT_BASE_URL: mirror, EMIS_API_KEY: '' }));
  const { start } = require('../server');
  server = await start(0);
  port = server.address().port;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (mock) await mock.close();
  delete process.env.PUBLIC_URL;
});

/** A WebSocket handshake to /wisp/ with the given headers → the HTTP status (101 = accepted). */
function handshake(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/wisp/', headers: Object.assign({
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
    }, headers) });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

function relay(body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const all = Object.assign({
      'content-type': 'application/json', 'content-length': Buffer.byteLength(data), host: 'localhost:' + port, origin: 'http://localhost:' + port, 'sec-fetch-site': 'same-origin'
    }, headers || {});
    Object.keys(all).forEach(k => { if (all[k] === null) delete all[k]; });      // null: leave the header out
    const req = http.request({ host: '127.0.0.1', port, path: '/api/scraper/fetch', method: 'POST', headers: all }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('Wisp accepts its own site behind a reverse proxy (Host, X-Forwarded-Host, PUBLIC_URL) and refuses other sites', async () => {
  assert.equal(await handshake({ Host: 'localhost:' + port, Origin: 'http://localhost:' + port }), 101, 'direct');
  assert.equal(await handshake({ Host: 'metac0.de', Origin: 'https://metac0.de' }), 101, 'proxy passing Host');
  assert.equal(await handshake({ Host: '127.0.0.1:' + port, 'X-Forwarded-Host': 'metac0.de', Origin: 'https://metac0.de' }), 101, 'proxy rewriting Host, forwarding the original');
  assert.equal(await handshake({ Host: '127.0.0.1:' + port, Origin: 'https://metac0.de' }), 403, 'unknown site');
  assert.equal(await handshake({ Host: 'metac0.de', Origin: 'https://metac0.de:8443' }), 101, 'site on another port, proxy passing $host (no port)');
  assert.equal(await handshake({ Host: 'metac0.de:3000', Origin: 'https://metac0.de:8443' }), 403, 'two different ports');
  assert.equal(await handshake({ Host: 'metac0.de', Origin: 'https://evil-metac0.de' }), 403, 'a look-alike name');
  process.env.PUBLIC_URL = 'https://metac0.de, https://www.metac0.de';
  try {
    assert.equal(await handshake({ Host: '127.0.0.1:' + port, Origin: 'https://www.metac0.de' }), 101, 'listed in PUBLIC_URL');
  } finally { delete process.env.PUBLIC_URL; }
  assert.equal(await handshake({ Host: 'metac0.de', Origin: 'https://evil.example' }), 403, 'another website');
});

test('/wisp/ without a WebSocket upgrade says the proxy is dropping WebSockets', async () => {
  const res = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/wisp/' }, r => {
    let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject));
  assert.equal(res.status, 426);
  assert.match(res.body, /reverse proxy is not forwarding WebSockets/);
});

test('the HTTP relay fetches Reddit pages (status, headers, body) and nothing else', async () => {
  const ok = await relay({ url: mirror + '/r/alpha/new/', method: 'GET', headers: [['accept', 'text/html'], ['cookie', 'loid=abc'], ['host', 'evil']] });
  assert.equal(ok.status, 200);
  const nl = ok.body.indexOf('\n');
  const meta = JSON.parse(ok.body.slice(0, nl));
  assert.equal(meta.status, 200);
  assert.ok(meta.headers.some(([k, v]) => k === 'content-type' && /text\/html/.test(v)));
  assert.match(ok.body.slice(nl + 1), /<shreddit-post id="t3_qal1"/);
  const notFound = await relay({ url: mirror + '/nothing/', method: 'GET' });
  assert.equal(JSON.parse(notFound.body.split('\n')[0]).status, 404, 'Reddit\'s own errors pass through');

  const refused = async (body, headers) => (await relay(body, headers)).status;
  assert.equal(await refused({ url: 'https://example.com/', method: 'GET' }), 403, 'not a Reddit host');
  assert.equal(await refused({ url: 'http://127.0.0.1:' + port + '/api/ai', method: 'GET' }), 403, 'IP addresses');
  assert.equal(await refused({ url: 'file:///etc/passwd', method: 'GET' }), 403);
  assert.equal(await refused({ url: mirror + '/r/alpha/new/', method: 'POST' }), 405, 'reads only');
  assert.equal(await refused({ url: mirror + '/r/alpha/new/', method: 'GET' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), 403, 'other websites');
  const bare = { origin: null, 'sec-fetch-site': null };
  assert.equal(await refused({ url: mirror + '/r/alpha/new/', method: 'GET' }, bare), 200, 'a tool on this machine');
  assert.equal(await refused({ url: mirror + '/r/alpha/new/', method: 'GET' }, Object.assign({ 'x-forwarded-for': '203.0.113.9' }, bare)), 403,
    'behind a reverse proxy, a request from outside that isn\'t from a page isn\'t "local"');
  const before = mock.state.requests.length;
  await relay({ url: mirror.replace(/:\d+$/, ':1') + '/x', method: 'GET' });
  assert.equal(mock.state.requests.length, before, 'ports outside the allow-list are never contacted');
});

test('private addresses are recognised', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.1.2.3', '100.64.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['151.101.1.140', '2a04:4e42::396']) assert.equal(isPrivateAddress(ip), false, ip);
});
