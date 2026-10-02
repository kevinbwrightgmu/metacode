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

// A browser always sends Origin on a WebSocket handshake; it must be this
// server. Without Origin, only local processes (the scraper itself) may connect.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return isLoopback(req.socket && req.socket.remoteAddress);
  let parsed;
  try { parsed = new URL(origin); } catch (e) { return false; }
  return parsed.host === String(req.headers.host || '');
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
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    socket.on('error', () => {});
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    wisp.routeRequest(req, socket, head);
  }
  // Closes every open Wisp connection (server shutdown).
  onUpgrade.closeAll = () => { sockets.forEach(s => s.destroy()); sockets.clear(); };
  return onUpgrade;
}

module.exports = { createUpgradeHandler, configureWisp, originAllowed, WISP_PATH };
