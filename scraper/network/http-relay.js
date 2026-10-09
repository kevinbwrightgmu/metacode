// ── HTTP relay for the Reddit Collector ───────────────────────────────────────
// Scramjet normally reaches Reddit through MetaCode's Wisp endpoint, which is a
// WebSocket. Some hosting setups don't let WebSockets through (a reverse proxy
// without "Upgrade" forwarding, some CDNs and corporate proxies). For those,
// the collector falls back to this endpoint: an ordinary HTTP POST that asks
// MetaCode to fetch one Reddit URL and stream the answer back.
//
//   POST /api/scraper/fetch   { url, method, headers: [[name, value]…] }
//   → 200, body = one line of JSON { status, statusText, headers } + "\n" + the response body
//
// Same limits as the Wisp endpoint: only Reddit's hosts (the Wisp allow-list),
// only the allowed ports, never private or loopback addresses (unless enabled
// for tests), only GET and HEAD, no redirects followed (the browser follows
// them, through the relay again), bounded size and time, bounded concurrency,
// and only for MetaCode's own pages.

const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'expect']);
/** Response headers that no longer describe the body after Node's fetch has decoded it. */
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

function fromBrowserPage(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  if (req.headers.origin) return true;            // checked against Host by the scraper router
  // Behind a reverse proxy every request comes from 127.0.0.1: only direct ones count as local
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) return false;
  const addr = String((req.socket && req.socket.remoteAddress) || '');
  return /^(127\.|::1$|::ffff:127\.)/.test(addr);  // tools on this machine (tests)
}

function createHttpRelay(config, opts) {
  const fetchFn = (opts && opts.fetch) || fetch;
  // Pages, scripts and images (not just API answers): at least 20 MB and 30 s
  const maxBytes = Math.max(20 * 1024 * 1024, Number(config.maxResponseBytes) || 0);
  const timeoutMs = Math.min(120000, Math.max(30000, Number(config.requestTimeoutMs) || 0));
  const maxActive = 24;
  let active = 0;

  function allowedUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch (e) { return { problem: 'not a valid URL' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { problem: 'only http(s) URLs' };
    if (u.username || u.password) return { problem: 'URLs with credentials aren\'t relayed' };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return { problem: 'IP addresses aren\'t relayed' };
    if (!config.wispHostPatterns.some(re => re.test(host))) return { problem: 'only Reddit\'s hosts are relayed' };
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if (!config.wispPorts.includes(port)) return { problem: 'port ' + port + ' isn\'t allowed' };
    return { url: u };
  }

  /** → null, or [status, message] when the host may not or can't be reached. */
  async function addressProblem(hostname) {
    if (config.allowPrivateNetwork) return null;
    let addrs;
    try { addrs = await dns.lookup(hostname, { all: true }); } catch (e) { return [502, 'Couldn\'t reach Reddit from the server (' + hostname + ' couldn\'t be looked up).']; }
    return addrs.some(a => isPrivateAddress(a.address)) ? [403, 'Not relayed: it resolves to a private address.'] : null;
  }

  return async function relay(req, res) {
    const refuse = (status, message) => res.status(status).json({ error: { type: 'relay_refused', message } });
    if (!config.browserEnabled) return refuse(503, 'The Reddit browser is turned off (SCRAPER_BROWSER_ENABLED=false).');
    if (!fromBrowserPage(req)) return refuse(403, 'Only MetaCode\'s own pages may use the relay.');
    const body = req.body || {};
    const method = String(body.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return refuse(405, 'The relay only fetches pages (GET and HEAD).');
    const check = allowedUrl(body.url);
    if (check.problem) return refuse(403, 'Not relayed: ' + check.problem + '.');
    const problem = await addressProblem(check.url.hostname);
    if (problem) return refuse(problem[0], problem[1]);
    if (active >= maxActive) return refuse(429, 'Too many relayed requests at once; try again in a moment.');

    const headers = {};
    if (Array.isArray(body.headers)) {
      for (const pair of body.headers.slice(0, 100)) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const name = String(pair[0]).toLowerCase().trim();
        const value = String(pair[1]);
        if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || HOP_BY_HOP.has(name) || /[\r\n]/.test(value) || value.length > 8192) continue;
        headers[name] = headers[name] ? headers[name] + ', ' + value : value;
      }
    }

    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => controller.abort();
    res.on('close', onClose);
    try {
      const upstream = await fetchFn(check.url.href, { method, headers, redirect: 'manual', signal: controller.signal });
      const outHeaders = [];
      upstream.headers.forEach((value, name) => { if (!DROP_RESPONSE.has(name)) outHeaders.push([name, value]); });
      if (typeof upstream.headers.getSetCookie === 'function') {
        // forEach joins Set-Cookie headers; pass each one separately
        for (let i = outHeaders.length - 1; i >= 0; i--) if (outHeaders[i][0] === 'set-cookie') outHeaders.splice(i, 1);
        upstream.headers.getSetCookie().forEach(c => outHeaders.push(['set-cookie', c]));
      }
      res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.write(JSON.stringify({ status: upstream.status, statusText: upstream.statusText || '', headers: outHeaders }) + '\n');
      if (method === 'HEAD' || !upstream.body) return res.end();
      let total = 0;
      const stream = Readable.fromWeb(upstream.body);
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) { controller.abort(); res.destroy(); return; }
        if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
      }
      res.end();
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const message = controller.signal.aborted ? 'Reddit didn\'t answer within ' + Math.round(timeoutMs / 1000) + ' s.' : 'Couldn\'t reach Reddit from the server (' + String((err && err.cause && err.cause.code) || (err && err.message) || err).slice(0, 120) + ').';
      res.status(502).json({ error: { type: 'relay_failed', message } });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      active--;
    }
  };
}

module.exports = { createHttpRelay, isPrivateAddress };
