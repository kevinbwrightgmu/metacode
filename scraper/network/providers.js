// @ts-check
// ── Network providers ─────────────────────────────────────────────────────────
// A network provider is a route the scraper's requests can take to Reddit (or
// RedditAPIs.com). The collection pipeline never knows which one it uses: it
// calls request() and gets an HTTP answer or a classified ScraperError.
//
//   direct       this server's own connection — the existing transports
//                (Python standard-library worker, or epoxy-tls over Wisp).
//                Always available; the default.
//   http-proxy   an HTTP(S) proxy the server administrator configured
//                (SCRAPER_PROXY_URL). Requests are tunnelled with CONNECT, so
//                TLS still runs end to end between this server and Reddit.
//   vpn-gateway  a separately managed VPN gateway (another host, VM or
//                container) that exposes an HTTP proxy
//                (SCRAPER_VPN_GATEWAY_PROXY_URL) and, optionally, a status URL
//                (SCRAPER_VPN_GATEWAY_HEALTH_URL) MetaCode checks before and
//                while using it. MetaCode never starts, stops or configures the
//                VPN itself — see docs/scraper-network.md.
//
// Only the administrator configures providers, in .env; nothing a user sends
// can add a route or change where one points. SOCKS proxies aren't offered:
// the HTTP client MetaCode uses (undici 6) can't tunnel through them, and a
// provider that can't work isn't presented as if it could.
//
// Every provider enforces the destination allow-list again (Reddit's hosts and
// the configured RedditAPIs.com host, allowed ports), verifies TLS
// certificates, never follows redirects (the request executor re-checks each
// hop), limits response size and honours timeouts and cancellation.

const zlib = require('zlib');
const { ScraperError, cancelledError, sanitize } = require('../errors');

/** @typedef {import('../../types/scraper').TransportRequest} TransportRequest */
/** @typedef {import('../../types/scraper').TransportResponse} TransportResponse */
/** @typedef {import('../../types/scraper').Transport} Transport */
/** @typedef {import('../../types/scraper').ProviderKind} ProviderKind */
/** @typedef {import('../../types/scraper').ProviderCapabilities} ProviderCapabilities */
/** @typedef {import('../../types/scraper').HealthResult} HealthResult */

/**
 * @typedef {object} NetworkProvider
 * @property {string} id
 * @property {ProviderKind} kind
 * @property {string} label                    shown to users
 * @property {ProviderCapabilities} capabilities
 * @property {string[]} problems               configuration problems (empty = usable)
 * @property {(req: TransportRequest) => Promise<TransportResponse>} request
 * @property {((signal?: AbortSignal) => Promise<HealthResult>) | undefined} [healthCheck]
 * @property {() => Record<string, unknown>} adminDetails  non-secret details for administrators
 * @property {(() => void) | undefined} [close]
 */

/**
 * @typedef {object} DestinationRules
 * @property {RegExp[]} hostPatterns
 * @property {number[]} ports
 * @property {boolean} allowPlainHttp   only for a local test mock (SCRAPER_ALLOW_PRIVATE_NETWORK)
 */

/** The existing transport (Python worker, or epoxy-tls over Wisp), as a provider. */
class DirectProvider {
  /** @param {{ transport: Transport }} opts */
  constructor(opts) {
    this.id = 'direct';
    /** @type {ProviderKind} */
    this.kind = 'direct';
    this.label = 'MetaCode server (direct)';
    this.transport = opts.transport;
    /** @type {ProviderCapabilities} */
    this.capabilities = { https: true, httpProxy: false, socks: false, healthCheck: false, remoteDns: false, changesEgressIp: false };
    /** @type {string[]} */
    this.problems = [];
    /** @type {((signal?: AbortSignal) => Promise<HealthResult>) | undefined} */
    this.healthCheck = undefined;
  }

  /** @param {TransportRequest} req */
  request(req) { return this.transport.request(req); }

  adminDetails() {
    const t = this.transport;
    return Object.assign({ transport: t.kind }, typeof t.status === 'function' ? t.status() : {});
  }

  close() { if (typeof this.transport.close === 'function') this.transport.close(); }
}

/**
 * Parses an administrator's proxy URL. → { url, problems }
 * @param {string} raw
 * @param {string} name   the setting's name, for messages
 */
function parseProxyUrl(raw, name) {
  /** @type {string[]} */
  const problems = [];
  let url = null;
  try { url = new URL(raw); } catch (e) { url = null; }
  if (!url) problems.push(name + ' isn\'t a valid URL (expected http://host:port or https://host:port).');
  else if (/^socks/i.test(url.protocol)) problems.push(name + ' is a SOCKS proxy. MetaCode\'s HTTP client (undici 6) can\'t use SOCKS; expose an HTTP proxy on the gateway instead (most VPN gateway containers can).');
  else if (!['http:', 'https:'].includes(url.protocol)) problems.push(name + ' must start with http:// or https://.');
  else if (url.pathname && url.pathname !== '/') problems.push(name + ' should be just the proxy\'s address (scheme, host and port), without a path.');
  return { url: problems.length ? null : url, problems };
}

/**
 * Where a proxy points, for administrators — never its credentials.
 * @param {URL | null} url
 */
function proxyLabel(url) {
  return url ? url.protocol + '//' + url.hostname + (url.port ? ':' + url.port : '') + (url.username ? ' (with credentials)' : '') : null;
}

/**
 * Turns an undici / socket error into a ScraperError (no addresses or credentials in the message).
 * @param {unknown} err
 * @param {AbortSignal | null | undefined} signal
 * @param {string} via   "the proxy" / "the VPN gateway"
 */
function classifyUndiciError(err, signal, via) {
  if (signal && signal.aborted) return signal.reason instanceof ScraperError ? signal.reason : cancelledError();
  const e = /** @type {{ code?: string, message?: string, name?: string, cause?: { code?: string, message?: string } }} */ (err || {});
  const code = String(e.code || (e.cause && e.cause.code) || '');
  const msg = String(e.message || '') + ' ' + String((e.cause && e.cause.message) || '');
  const detail = sanitize(code + ' ' + msg, 200);
  if (/Proxy response \((\d+)\)/.test(msg)) {
    const status = (msg.match(/Proxy response \((\d+)\)/) || [])[1];
    return new ScraperError('proxy_error', 'The connection through ' + via + ' was refused by ' + via + ' (it answered HTTP ' + status + ' to the tunnel request). ' +
      'Check the gateway\'s own logs and its allow-list; MetaCode does not try other routes on its own.', { status: 502, retryable: true, detail });
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || /timeout/i.test(code) || e.name === 'TimeoutError') {
    return new ScraperError('timeout', 'Reddit didn\'t answer in time (through ' + via + ').', { status: 504, retryable: true, detail });
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new ScraperError('proxy_error', 'Couldn\'t connect to ' + via + ' in time.', { status: 502, retryable: true, detail });
  }
  if (/CERT|SSL|TLS|certificate/i.test(code + msg)) {
    return new ScraperError('tls', 'Couldn\'t verify the TLS certificate of the site at the other end of ' + via + '. Something on the route may be intercepting HTTPS.', { status: 502, detail });
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/.test(code + msg)) {
    return new ScraperError('proxy_error', 'Couldn\'t reach ' + via + ' (connection refused or address not found). Is it running?', { status: 502, retryable: true, detail });
  }
  return new ScraperError('network', 'The connection through ' + via + ' failed.', { status: 502, retryable: true, detail });
}

/**
 * Reads a response body with a size limit, decompressing it if needed.
 * @param {AsyncIterable<Buffer> & { destroy?: (err?: Error) => void }} body
 * @param {string} encoding
 * @param {number} maxBytes
 */
async function readBody(body, encoding, maxBytes) {
  /** @type {Buffer[]} */
  const parts = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      if (typeof body.destroy === 'function') body.destroy();
      throw new ScraperError('too_large', 'The response was larger than SCRAPER_MAX_RESPONSE_BYTES.', { status: 502 });
    }
    parts.push(chunk);
  }
  let buf = Buffer.concat(parts);
  const enc = encoding.toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
    else if (enc === 'deflate') buf = zlib.inflateSync(buf, { maxOutputLength: maxBytes });
    else if (enc === 'br') buf = zlib.brotliDecompressSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    throw new ScraperError('parse_error', 'The response couldn\'t be decompressed.', { status: 502 });
  }
  return buf.toString('utf8');
}

/** An HTTP(S) proxy configured by the administrator — on its own, or as a VPN gateway's proxy. */
class ProxyProvider {
  /**
   * @param {object} opts
   * @param {'proxy' | 'vpn-gateway'} opts.id
   * @param {string} opts.proxyUrl
   * @param {string} [opts.healthUrl]          VPN gateway only: its status endpoint
   * @param {DestinationRules} opts.rules
   * @param {number} opts.maxResponseBytes
   * @param {number} [opts.connectTimeoutMs]
   * @param {typeof import('undici')} [opts.undici]   for tests
   */
  constructor(opts) {
    this.id = opts.id;
    /** @type {ProviderKind} */
    this.kind = opts.id === 'vpn-gateway' ? 'vpn-gateway' : 'http-proxy';
    this.via = this.kind === 'vpn-gateway' ? 'the VPN gateway' : 'the proxy';
    this.label = this.kind === 'vpn-gateway' ? 'VPN gateway (managed by this server\'s administrator)' : 'Proxy (configured by this server\'s administrator)';
    this.rules = opts.rules;
    this.maxResponseBytes = opts.maxResponseBytes;
    this.connectTimeoutMs = opts.connectTimeoutMs || 10000;
    this.undici = opts.undici || require('undici');
    const settingName = this.kind === 'vpn-gateway' ? 'SCRAPER_VPN_GATEWAY_PROXY_URL' : 'SCRAPER_PROXY_URL';
    const parsed = parseProxyUrl(opts.proxyUrl, settingName);
    this.problems = parsed.problems;
    this.proxy = parsed.url;
    /** @type {URL | null} */
    this.health = null;
    if (opts.healthUrl) {
      let h = null;
      try { h = new URL(opts.healthUrl); } catch (e) { h = null; }
      if (!h || !['http:', 'https:'].includes(h.protocol)) this.problems.push('SCRAPER_VPN_GATEWAY_HEALTH_URL must be an http(s) URL.');
      else this.health = h;
    }
    /** @type {ProviderCapabilities} */
    this.capabilities = { https: true, httpProxy: true, socks: false, healthCheck: !!this.health, remoteDns: true, changesEgressIp: true };
    /** @type {import('undici').ProxyAgent | null} */
    this.agent = null;
    if (this.proxy) {
      const p = this.proxy;
      const token = p.username || p.password
        ? 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64') : undefined;
      const uri = p.protocol + '//' + p.host;
      this.agent = new this.undici.ProxyAgent({
        uri, token,
        connect: { timeout: this.connectTimeoutMs },
        requestTls: { rejectUnauthorized: true },
        proxyTls: { rejectUnauthorized: true }
      });
    }
    this.healthCheck = this.health ? (/** @param {AbortSignal} [signal] */ signal => this.checkGateway(signal)) : undefined;
  }

  /** @param {URL} url */
  checkDestination(url) {
    const httpOk = url.protocol === 'https:' || (url.protocol === 'http:' && this.rules.allowPlainHttp);
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!httpOk || url.username || url.password || !this.rules.hostPatterns.some(re => re.test(url.hostname)) || !this.rules.ports.includes(port)) {
      throw new ScraperError('host_not_allowed', 'That destination isn\'t on the scraper\'s allow-list.', { status: 400 });
    }
  }

  /**
   * @param {TransportRequest} req
   * @returns {Promise<TransportResponse>}
   */
  async request(req) {
    if (!this.agent) throw new ScraperError('proxy_unavailable', 'The ' + (this.kind === 'vpn-gateway' ? 'VPN gateway' : 'proxy') + ' isn\'t configured correctly: ' + this.problems.join(' '), { status: 503 });
    const url = new URL(req.url);
    this.checkDestination(url);
    if (req.signal && req.signal.aborted) throw req.signal.reason instanceof ScraperError ? req.signal.reason : cancelledError();
    const timeout = AbortSignal.timeout(Math.max(1000, req.timeoutMs || 20000));
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    try {
      const res = await this.undici.request(url, {
        method: /** @type {import('undici').Dispatcher.HttpMethod} */ (req.method || 'GET'),
        headers: req.headers,
        body: req.body === undefined || req.body === null ? undefined : String(req.body),
        dispatcher: this.agent,
        signal,
        headersTimeout: req.timeoutMs,
        bodyTimeout: req.timeoutMs,
        maxRedirections: 0
      });
      /** @type {Record<string, string>} */
      const headers = {};
      Object.entries(res.headers).forEach(([k, v]) => { if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v); });
      const body = await readBody(res.body, headers['content-encoding'] || '', this.maxResponseBytes);
      return { status: res.statusCode, statusText: '', headers, body, url: url.href };
    } catch (err) {
      if (err instanceof ScraperError) throw err;
      if (timeout.aborted && !(req.signal && req.signal.aborted)) {
        throw new ScraperError('timeout', 'Reddit didn\'t answer in time (through ' + this.via + ').', { status: 504, retryable: true });
      }
      throw classifyUndiciError(err, req.signal, this.via);
    }
  }

  /**
   * The gateway's own status endpoint: healthy when it answers 2xx and, if it
   * reports a JSON `status`, that status says the tunnel is up.
   * @param {AbortSignal} [signal]
   * @returns {Promise<HealthResult>}
   */
  async checkGateway(signal) {
    const started = Date.now();
    const done = /** @param {boolean} ok @param {string | null} detail */ (ok, detail) => ({ ok, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, detail });
    if (!this.health) return done(false, 'No status URL is configured.');
    const timeout = AbortSignal.timeout(5000);
    try {
      const res = await this.undici.request(this.health, { method: 'GET', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headersTimeout: 5000, bodyTimeout: 5000, maxRedirections: 0 });
      const text = await readBody(res.body, '', 64 * 1024);
      if (res.statusCode < 200 || res.statusCode >= 300) return done(false, 'The gateway\'s status endpoint answered HTTP ' + res.statusCode + '.');
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      const status = json && typeof json === 'object' && typeof json.status === 'string' ? json.status.toLowerCase() : null;
      if (status && !['running', 'connected', 'up', 'ok', 'healthy'].includes(status)) return done(false, 'The gateway reports its tunnel as "' + sanitize(status, 30) + '".');
      return done(true, null);
    } catch (err) {
      return done(false, timeout.aborted ? 'The gateway\'s status endpoint didn\'t answer within 5 s.' : 'The gateway\'s status endpoint couldn\'t be reached.');
    }
  }

  adminDetails() {
    return { proxy: proxyLabel(this.proxy), healthEndpoint: this.health ? this.health.protocol + '//' + this.health.host + this.health.pathname : null, problems: this.problems.slice() };
  }

  close() { if (this.agent) this.agent.close().catch(() => {}); }
}

/**
 * The providers this server's settings describe, in the administrator's order.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ transport: Transport, rules: DestinationRules, maxResponseBytes: number, undici?: typeof import('undici') }} deps
 * @returns {{ providers: NetworkProvider[], order: string[], failover: boolean, warnings: string[] }}
 */
function providersFromEnv(env, deps) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, NetworkProvider>} */
  const all = new Map();
  all.set('direct', new DirectProvider({ transport: deps.transport }));
  const proxyUrl = String(env.SCRAPER_PROXY_URL || '').trim();
  if (proxyUrl) all.set('proxy', new ProxyProvider({ id: 'proxy', proxyUrl, rules: deps.rules, maxResponseBytes: deps.maxResponseBytes, undici: deps.undici }));
  const gwUrl = String(env.SCRAPER_VPN_GATEWAY_PROXY_URL || '').trim();
  if (gwUrl) {
    all.set('vpn-gateway', new ProxyProvider({ id: 'vpn-gateway', proxyUrl: gwUrl, healthUrl: String(env.SCRAPER_VPN_GATEWAY_HEALTH_URL || '').trim() || undefined,
      rules: deps.rules, maxResponseBytes: deps.maxResponseBytes, undici: deps.undici }));
  } else if (String(env.SCRAPER_VPN_GATEWAY_HEALTH_URL || '').trim()) {
    warnings.push('SCRAPER_VPN_GATEWAY_HEALTH_URL is set without SCRAPER_VPN_GATEWAY_PROXY_URL; the VPN gateway isn\'t used.');
  }
  // SCRAPER_NETWORK_PROVIDERS: the order to use them in, e.g. "vpn-gateway" or "vpn-gateway,direct".
  const raw = String(env.SCRAPER_NETWORK_PROVIDERS || '').trim();
  let order = raw ? raw.split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean) : ['direct'];
  const unknown = order.filter(id => !all.has(id));
  if (unknown.length) warnings.push('SCRAPER_NETWORK_PROVIDERS names ' + unknown.join(', ') + ', which ' + (unknown.length === 1 ? 'isn\'t' : 'aren\'t') + ' configured; ' + (unknown.length === 1 ? 'it is' : 'they are') + ' skipped.');
  order = Array.from(new Set(order.filter(id => all.has(id)))).slice(0, 3);
  if (!order.length) { order = ['direct']; warnings.push('No usable network provider in SCRAPER_NETWORK_PROVIDERS; using the direct connection.'); }
  order.forEach(id => { const p = all.get(id); if (p && p.problems.length) warnings.push(p.problems.join(' ')); });
  // Failover to the next provider only when the administrator asks for it, and only when the current one's route is down.
  const failover = /^(1|true|yes|on)$/i.test(String(env.SCRAPER_NETWORK_FAILOVER || '').trim());
  if (failover && order.length < 2) warnings.push('SCRAPER_NETWORK_FAILOVER is on, but SCRAPER_NETWORK_PROVIDERS lists only one provider.');
  const providers = /** @type {NetworkProvider[]} */ (order.map(id => all.get(id)));
  // Configured but not in the order: close what was opened
  all.forEach((p, id) => { if (!order.includes(id) && id !== 'direct' && typeof p.close === 'function') p.close(); });
  return { providers, order, failover: failover && order.length > 1, warnings };
}

module.exports = { DirectProvider, ProxyProvider, providersFromEnv, parseProxyUrl, classifyUndiciError, readBody };
