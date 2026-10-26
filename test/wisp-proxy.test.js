// MetaCode's Wisp endpoint (/wisp/) as a server behind a reverse proxy sees it:
// which sites may open the WebSocket, and what happens when a proxy drops the
// upgrade. (The Reddit Scraper's in-app browser, Browse Reddit, uses it.)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createMockReddit } = require('./helpers/mock-reddit');
const { testEnv } = require('./helpers/harness');

let mock, server, port;
test.before(async () => {
  mock = createMockReddit();
  const base = await mock.listen();
  Object.assign(process.env, testEnv({ REDDIT_BASE_URL: base }));
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
