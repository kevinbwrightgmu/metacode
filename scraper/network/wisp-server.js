// ── Wisp proxy endpoint ───────────────────────────────────────────────────────
// MetaCode's single egress point to Reddit. Wisp (MercuryWorkshop's protocol
// for multiplexing TCP streams over one WebSocket) is served by wisp-js at
// ws(s)://<MetaCode>/wisp/. Two clients use it:
//
//   • the server-side scraper (scraper/network/epoxy-transport.js): epoxy-tls
//     running in Node opens TLS *through* a Wisp stream, so the TLS session is
//     end-to-end between epoxy and Reddit;
//   • the in-app Reddit browser (Scramjet, in the browser tab): Scramjet's
//     service worker hands requests to epoxy-transport, which also speaks TLS
//     over this endpoint.
//
// The endpoint only opens TCP streams to Reddit's hosts on the allowed ports,
// never UDP, never to private/loopback addresses (unless explicitly enabled
// for local testing), and only for connections from MetaCode's own pages (or
// from this machine without an Origin header — the server-side scraper).

const { server: wisp, logging } = require('@mercuryworkshop/wisp-js/server');

const WISP_PATH = '/wisp/';

function configureWisp(config) {
  logging.set_level(logging.WARN);
  const o = wisp.options;
  o.hostname_whitelist  = config.wispHostPatterns.slice();
  o.hostname_blacklist  = null;
  o.port_whitelist      = config.wispPorts.slice();
  o.port_blacklist      = null;
  o.allow_udp_streams   = false;
  o.allow_tcp_streams   = true;
  // Direct-IP streams would skip the hostname allow-list entirely.
  o.allow_direct_ip     = false;
  o.allow_private_ips   = !!config.allowPrivateNetwork;
  o.allow_loopback_ips  = !!config.allowPrivateNetwork;
  o.stream_limit_total  = 64;
  // Not used: in wisp-js 0.5.0 the per-host check iterates connection.streams
  // (a plain object) and throws an uncaught TypeError that crashes the
  // process. Per-host concurrency for the scraper is enforced by
  // HostRateLimiter instead.
  o.stream_limit_per_host = -1;
  o.dns_result_order    = 'ipv4first';
  o.parse_real_ip       = false;
  o.wisp_version        = 2;
  return o;
}

function isLoopback(address) {
  return /^(127\.|::1$|::ffff:127\.)/.test(String(address || ''));
}

/** Hosts of PUBLIC_URL in .env (comma-separated), e.g. https://metac0.de → "metac0.de". */
function publicHosts() {
  return String(process.env.PUBLIC_URL || '').split(',').map(s => {
    try { return new URL(s.trim()).host.toLowerCase(); } catch (e) { return null; }
  }).filter(Boolean);
}

// A browser always sends Origin on a WebSocket handshake; it must be this
// server: the Host header, or — behind a reverse proxy that rewrites Host —
// the host it forwards (X-Forwarded-Host) or one named in PUBLIC_URL.
// Without Origin, only local processes (the scraper itself) may connect.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return isLoopback(req.socket && req.socket.remoteAddress);
  let parsed;
  try { parsed = new URL(origin); } catch (e) { return false; }
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const served = [req.headers.host].concat(String(req.headers['x-forwarded-host'] || '').split(','))
    .map(h => String(h || '').trim().toLowerCase()).filter(Boolean);
  // nginx's $host has no port: then the name alone must match (a site on e.g. :8443)
  return served.some(h => h === host || (!/:\d+$/.test(h) && h === hostname)) || publicHosts().includes(host);
}

// Explains refusals in the server log (once a minute per reason), so a
// misconfigured reverse proxy shows up in `pm2 logs`.
const logged = new Map();
function logOnce(key, message) {
  const now = Date.now();
  if (now - (logged.get(key) || 0) < 60000) return;
  logged.set(key, now);
  if (logged.size > 100) logged.clear();
  console.warn('[wisp] ' + message);
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.write('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  } catch (e) { /* socket already gone */ }
  socket.destroy();
}

// Returns an 'upgrade' listener for the HTTP server.
function createUpgradeHandler(config) {
  configureWisp(config);
  const sockets = new Set();
  function onUpgrade(req, socket, head) {
    // Exact match: wisp-js treats any URL not ending in "/" (e.g. "/wisp/?x"
    // or "/wisp/host:port") as the older wsproxy protocol.
    if (req.url !== WISP_PATH) return rejectUpgrade(socket, 404, 'Not Found');
    if (!config.enabled) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!originAllowed(req)) {
      const from = String(req.headers.origin).slice(0, 200);
      logOnce('origin:' + from, 'Refused a WebSocket from ' + from + ' (Host: ' + String(req.headers.host || 'none').slice(0, 200) + '). If that is this site\'s own address ' +
        'and MetaCode runs behind a reverse proxy, pass the site\'s host (nginx: proxy_set_header Host $host;) or set PUBLIC_URL=' + from + ' in .env. See docs/deploy-vps.md.');
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    socket.on('error', () => {});
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    wisp.routeRequest(req, socket, head);
  }
  // Closes every open Wisp connection (server shutdown).
  onUpgrade.closeAll = () => { sockets.forEach(s => s.destroy()); sockets.clear(); };
  return onUpgrade;
}

// /wisp/ reached as a plain HTTP request: something in front of MetaCode (a
// reverse proxy or CDN) didn't pass the WebSocket upgrade on. Say so.
function plainHttpHandler(req, res) {
  logOnce('plain', 'The Wisp endpoint (/wisp/) was requested without a WebSocket upgrade: the reverse proxy in front of MetaCode isn\'t forwarding WebSockets ' +
    '(nginx needs "proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade;"). ' +
    'The Scraper falls back to its HTTP relay meanwhile. See docs/deploy-vps.md.');
  res.status(426).set('Upgrade', 'websocket').type('text/plain')
    .send('This is MetaCode\'s Wisp endpoint: it only accepts WebSocket connections. If you see this from a browser page, a reverse proxy is not forwarding WebSockets — see docs/deploy-vps.md.');
}

module.exports = { createUpgradeHandler, configureWisp, originAllowed, plainHttpHandler, WISP_PATH };
