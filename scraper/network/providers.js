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
//                (SCRAPER_VPN_GATEWAY_HEALTH_URL, with an API key or user:password
//                when the gateway protects it) MetaCode checks before and while
//                using it, and an exit-address URL (SCRAPER_VPN_GATEWAY_IP_URL).
//                MetaCode never starts, stops or configures the VPN itself — see
//                docs/scraper-network.md and deploy/vpn-gateway/.
//
// Which route is used: SCRAPER_NETWORK_PROVIDERS when it is set; otherwise a
// configured VPN gateway, else a configured proxy, else the direct connection.
// Setting up a gateway is enough to use it.
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
   * @param {string} [opts.healthApiKey]       sent as X-API-Key to the status endpoints (gluetun's "apikey" auth)
   * @param {string} [opts.ipUrl]              VPN gateway only: an endpoint reporting its public (exit) address
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
    /** @type {URL | null} */
    this.ipEndpoint = null;
    /** @type {Record<string, string>} headers for the status endpoints (credentials; never shown) */
    this.statusHeaders = {};
    if (opts.healthApiKey) this.statusHeaders['x-api-key'] = String(opts.healthApiKey);
    /** @param {string} raw @param {string} name */
    const statusUrl = (raw, name) => {
      let h = null;
      try { h = new URL(raw); } catch (e) { h = null; }
      if (!h || !['http:', 'https:'].includes(h.protocol)) { this.problems.push(name + ' must be an http(s) URL.'); return null; }
      // user:password in the URL → HTTP basic auth (gluetun's "basic" auth); the URL itself keeps no credentials
      if (h.username || h.password) {
        this.statusHeaders.authorization = 'Basic ' + Buffer.from(decodeURIComponent(h.username) + ':' + decodeURIComponent(h.password)).toString('base64');
        h.username = ''; h.password = '';
      }
      return h;
    };
    if (opts.healthUrl) this.health = statusUrl(opts.healthUrl, 'SCRAPER_VPN_GATEWAY_HEALTH_URL');
    if (opts.ipUrl) this.ipEndpoint = statusUrl(opts.ipUrl, 'SCRAPER_VPN_GATEWAY_IP_URL');
    /** @type {ProviderCapabilities} */
    this.capabilities = { https: true, httpProxy: true, socks: false, healthCheck: !!(this.health || this.ipEndpoint), remoteDns: true, changesEgressIp: true };
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
    this.healthCheck = this.health || this.ipEndpoint ? (/** @param {AbortSignal} [signal] */ signal => this.checkGateway(signal)) : undefined;
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
   * Fetches one of the gateway's status endpoints. → { status, json } or a failure kind
   * @param {URL} url
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<{ ok: true, status: number, json: any } | { ok: false, kind: 'down' | 'config', detail: string }>}
   */
  async statusJson(url, signal) {
    const timeout = AbortSignal.timeout(5000);
    try {
      const res = await this.undici.request(url, { method: 'GET', headers: Object.assign({ accept: 'application/json' }, this.statusHeaders),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headersTimeout: 5000, bodyTimeout: 5000, maxRedirections: 0 });
      const text = await readBody(res.body, '', 64 * 1024);
      const code = res.statusCode;
      if (code === 401 || code === 403) {
        return { ok: false, kind: 'config', detail: 'The gateway\'s status endpoint refused MetaCode (HTTP ' + code + '): it needs credentials. Set SCRAPER_VPN_GATEWAY_HEALTH_API_KEY ' +
          '(gluetun: an "apikey" role for this route in its control-server auth file) or put user:password in the URL. Requests still go through the gateway meanwhile.' };
      }
      if (code === 404) return { ok: false, kind: 'config', detail: 'The gateway has no status page at that address (HTTP 404). Check the path (gluetun: /v1/vpn/status, or /v1/openvpn/status on older versions).' };
      if (code < 200 || code >= 300) return { ok: false, kind: 'down', detail: 'The gateway\'s status endpoint answered HTTP ' + code + '.' };
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { ok: true, status: code, json };
    } catch (err) {
      return { ok: false, kind: 'down', detail: timeout.aborted ? 'The gateway\'s status endpoint didn\'t answer within 5 s.' : 'The gateway\'s status endpoint couldn\'t be reached (is the gateway running?).' };
    }
  }

  /**
   * The gateway's own status: healthy when its status endpoint answers 2xx
   * and, if it reports a JSON `status`, that status says the tunnel is up.
   * The exit address comes from SCRAPER_VPN_GATEWAY_IP_URL (or a `public_ip`
   * field in the status answer). A status endpoint that is set up wrongly
   * (401/403/404) is a configuration problem, reported without stopping
   * traffic; an unreachable gateway or a tunnel reported down stops it.
   * @param {AbortSignal} [signal]
   * @returns {Promise<HealthResult>}
   */
  async checkGateway(signal) {
    const started = Date.now();
    /** @param {boolean} ok @param {'ok' | 'down' | 'config'} kind @param {string | null} detail @param {{ ip?: string | null, where?: string | null }} [exit] */
    const done = (ok, kind, detail, exit) => ({ ok, kind, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, detail,
      exitIp: exit && exit.ip ? exit.ip : null, exitLocation: exit && exit.where ? exit.where : null });
    /** @param {any} j */
    const exitOf = j => {
      if (!j || typeof j !== 'object') return {};
      const ip = typeof j.public_ip === 'string' ? j.public_ip : typeof j.ip === 'string' ? j.ip : null;
      const where = [j.city, j.region, j.country].filter(x => typeof x === 'string' && x).map(x => sanitize(x, 40)).join(', ');
      return { ip: ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null, where: where || null };
    };
    let exit = {};
    if (this.health) {
      const r = await this.statusJson(this.health, signal);
      if (!r.ok) return done(false, r.kind, r.detail);
      const j = r.json;
      const status = j && typeof j === 'object' && typeof j.status === 'string' ? j.status.toLowerCase() : null;
      if (status && !['running', 'connected', 'up', 'ok', 'healthy'].includes(status)) return done(false, 'down', 'The gateway reports its tunnel as "' + sanitize(status, 30) + '".');
      exit = exitOf(j);
    }
    if (this.ipEndpoint) {
      const r = await this.statusJson(this.ipEndpoint, signal);
      if (r.ok) exit = exitOf(r.json);
      else if (!this.health) return done(false, r.kind, r.detail);
    }
    return done(true, 'ok', null, exit);
  }

  adminDetails() {
    const where = /** @param {URL | null} u */ u => (u ? u.protocol + '//' + u.host + u.pathname : null);
    return { proxy: proxyLabel(this.proxy), healthEndpoint: where(this.health), ipEndpoint: where(this.ipEndpoint),
      statusAuth: this.statusHeaders['x-api-key'] ? 'API key' : this.statusHeaders.authorization ? 'user and password' : 'none', problems: this.problems.slice() };
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
  const opt = /** @param {string} k */ k => String(env[k] || '').trim() || undefined;
  if (gwUrl) {
    all.set('vpn-gateway', new ProxyProvider({ id: 'vpn-gateway', proxyUrl: gwUrl, healthUrl: opt('SCRAPER_VPN_GATEWAY_HEALTH_URL'),
      healthApiKey: opt('SCRAPER_VPN_GATEWAY_HEALTH_API_KEY'), ipUrl: opt('SCRAPER_VPN_GATEWAY_IP_URL'),
      rules: deps.rules, maxResponseBytes: deps.maxResponseBytes, undici: deps.undici }));
  } else if (opt('SCRAPER_VPN_GATEWAY_HEALTH_URL') || opt('SCRAPER_VPN_GATEWAY_IP_URL')) {
    warnings.push('SCRAPER_VPN_GATEWAY_HEALTH_URL / _IP_URL are set without SCRAPER_VPN_GATEWAY_PROXY_URL (the gateway\'s proxy address); the VPN gateway isn\'t used.');
  }
  // SCRAPER_NETWORK_PROVIDERS: the order to use them in, e.g. "vpn-gateway" or "vpn-gateway,direct".
  // Unset: the gateway if one is configured, else the proxy, else the direct connection.
  const raw = String(env.SCRAPER_NETWORK_PROVIDERS || '').trim();
  let order = raw ? raw.split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean) : [all.has('vpn-gateway') ? 'vpn-gateway' : all.has('proxy') ? 'proxy' : 'direct'];
  if (raw) {
    ['vpn-gateway', 'proxy'].forEach(id => {
      if (all.has(id) && !order.includes(id)) warnings.push((id === 'vpn-gateway' ? 'A VPN gateway is configured (SCRAPER_VPN_GATEWAY_PROXY_URL)' : 'A proxy is configured (SCRAPER_PROXY_URL)') +
        ', but SCRAPER_NETWORK_PROVIDERS="' + raw + '" doesn\'t list "' + id + '", so it isn\'t used. Add it, or remove SCRAPER_NETWORK_PROVIDERS to use it by default.');
    });
  }
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
