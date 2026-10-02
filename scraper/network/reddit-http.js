// ── Reddit HTTP client ────────────────────────────────────────────────────────
// The one path every scraper request takes (standard scraper, custom-code
// fetches, OAuth token, robots.txt). It enforces, in order:
//   1. destination check — only Reddit API hosts and allowed ports;
//   2. robots.txt (public mode only, unless disabled by the operator);
//   3. the shared per-host rate limiter (delay floor + concurrency);
//   4. the request itself, over epoxy-tls → Wisp (see epoxy-transport.js);
//   5. Reddit's rate-limit headers, 429 Retry-After, bounded retries with
//      exponential backoff for transient failures, and manual redirects
//      (each hop re-checked against 1–2).
//
// Modes: with REDDIT_CLIENT_ID/SECRET the client uses Reddit's Data API
// (oauth.reddit.com) with an application-only OAuth token; otherwise it reads
// the public .json pages on www.reddit.com.

const { ScraperError, httpError, cancelledError, isScraperError } = require('../errors');
const { parseRobots, isAllowed } = require('./robots');
const { sleep } = require('./rate-limiter');

const ROBOTS_TTL_MS         = 6 * 3600 * 1000;
const ROBOTS_FAIL_TTL_MS    = 10 * 60 * 1000;
const MAX_RETRY_WAIT_MS     = 5 * 60 * 1000;
const MAX_REDIRECTS         = 3;
const USER_HEADER_ALLOWLIST = new Set(['accept', 'accept-language', 'if-none-match', 'if-modified-since']);

class RedditHttpClient {
  constructor(opts) {
    this.config    = opts.config;
    this.transport = opts.transport;
    this.limiter   = opts.limiter;
    this.now       = opts.now || Date.now;
    this.token     = null;      // { value, expiresAt }
    this.tokenPromise = null;
    this.robots    = new Map(); // origin → { groups | null, failed, fetchedAt }
    this.stats     = { requests: 0, errors: 0 };
  }

  get mode() { return this.config.oauth ? 'oauth' : 'public'; }

  get apiBase() { return this.mode === 'oauth' ? this.config.redditOAuthBaseUrl : this.config.redditBaseUrl; }

  minInterval(delayMs) {
    const floor = this.mode === 'oauth' ? this.config.minDelayMs : Math.max(this.config.minDelayMs, this.config.publicMinDelayMs);
    return Math.max(floor, Number.isFinite(delayMs) ? delayMs : this.config.defaultDelayMs);
  }

  // Validates a destination. Returns the parsed URL or throws.
  checkDestination(raw) {
    let url;
    try { url = new URL(String(raw)); } catch (e) {
      throw new ScraperError('invalid_url', 'That isn\'t a valid URL.', { status: 400 });
    }
    const allowedProtocols = new Set(['https:']);
    [this.config.redditBaseUrl, this.config.redditOAuthBaseUrl].forEach(b => allowedProtocols.add(new URL(b).protocol));
    if (!allowedProtocols.has(url.protocol)) {
      throw new ScraperError('invalid_url', 'Only https:// URLs can be requested.', { status: 400 });
    }
    if (url.username || url.password) throw new ScraperError('invalid_url', 'URLs with credentials aren\'t allowed.', { status: 400 });
    if (!this.config.apiHosts.includes(url.hostname.toLowerCase())) {
      throw new ScraperError('host_not_allowed', 'The scraper may only request Reddit (' + this.config.apiHosts.filter(h => /reddit\.com$/.test(h)).join(', ') +
        '); "' + url.hostname + '" isn\'t allowed.', { status: 400 });
    }
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!this.config.wispPorts.includes(port)) {
      throw new ScraperError('host_not_allowed', 'Port ' + port + ' isn\'t allowed.', { status: 400 });
    }
    url.hash = '';
    return url;
  }

  // A Reddit path or URL → the URL to request in the current mode, with
  // raw_json=1 (no HTML-escaped text) and .json for public pages.
  buildApiUrl(pathOrUrl, query) {
    let path = String(pathOrUrl || '/');
    let search = new URLSearchParams();
    if (/^https?:\/\//i.test(path)) {
      const u = this.checkDestination(path);
      path = u.pathname;
      search = u.searchParams;
    } else {
      const q = path.indexOf('?');
      if (q !== -1) { search = new URLSearchParams(path.slice(q + 1)); path = path.slice(0, q); }
      if (!path.startsWith('/')) path = '/' + path;
    }
    path = path.replace(/\/+$/, '') || '/';
    path = path.replace(/\.json$/i, '');
    if (this.mode === 'public' && path !== '/') path += '.json';
    if (this.mode === 'public' && path === '/') path = '/.json';
    Object.entries(query || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      search.set(k, String(v));
    });
    search.set('raw_json', '1');
    return this.apiBase + path + '?' + search.toString();
  }

  // ── OAuth (application-only) ────────────────────────────────────────────
  async getToken(ctx) {
    if (!this.config.oauth) return null;
    if (this.token && this.token.expiresAt - 60000 > this.now()) return this.token.value;
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        const { clientId, clientSecret } = this.config.oauth;
        const res = await this.request(this.config.redditBaseUrl + '/api/v1/access_token', Object.assign({}, ctx, {
          method: 'POST',
          internal: true,
          skipRobots: true,
          skipAuth: true,
          headers: {
            'authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
            'content-type': 'application/x-www-form-urlencoded'
          },
          body: 'grant_type=client_credentials',
          retries: 1
        }));
        if (res.status === 401 || res.status === 403) {
          throw new ScraperError('auth_error', 'Reddit rejected REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (HTTP ' + res.status + '). Check them in .env and restart MetaCode.', { status: 502 });
        }
        if (res.status < 200 || res.status >= 300) throw httpError(res.status, 'Reddit\'s OAuth endpoint');
        let json = null;
        try { json = JSON.parse(res.body); } catch (e) { json = null; }
        if (!json || typeof json.access_token !== 'string') {
          throw new ScraperError('auth_error', 'Reddit didn\'t return an access token. Check that the Reddit app is a "script" or "web" app.', { status: 502 });
        }
        const ttl = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 3600 * 1000;
        this.token = { value: json.access_token, expiresAt: this.now() + ttl };
        return this.token.value;
      })().finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  // ── robots.txt ──────────────────────────────────────────────────────────
  robotsApplies(url) {
    if (!this.config.respectRobotsTxt || this.mode === 'oauth') return false;
    return url.host.toLowerCase() !== new URL(this.config.redditOAuthBaseUrl).host.toLowerCase();
  }

  async checkRobots(url, ctx) {
    if (!this.robotsApplies(url)) return;
    const origin = url.origin;
    let entry = this.robots.get(origin);
    const now = this.now();
    if (!entry || now - entry.fetchedAt > (entry.failed ? ROBOTS_FAIL_TTL_MS : ROBOTS_TTL_MS)) {
      entry = { groups: null, failed: false, failure: null, fetchedAt: now };
      try {
        const res = await this.request(origin + '/robots.txt', Object.assign({}, ctx, { internal: true, skipRobots: true, retries: 1 }));
        if (res.status >= 200 && res.status < 300) entry.groups = parseRobots(res.body);
        else if (res.status >= 400 && res.status < 500 && res.status !== 429) entry.groups = [];
        else entry.failed = true;
      } catch (err) {
        if (isScraperError(err) && err.type === 'cancelled') throw err;
        entry.failed = true;
        // A transport failure (TLS, network, proxy) is the real problem: report it as such.
        if (isScraperError(err)) entry.failure = err;
      }
      this.robots.set(origin, entry);
    }
    if (entry.failed && entry.failure) throw entry.failure;
    if (entry.failed) {
      throw new ScraperError('robots_unavailable', 'Reddit\'s robots.txt couldn\'t be read, so the scraper can\'t confirm automated access is allowed. ' +
        'Check the connection and try again, or configure Reddit API credentials (see docs/reddit-scraper.md).', { status: 503, retryable: true });
    }
    const verdict = isAllowed(entry.groups, this.config.userAgent, url.pathname + url.search);
    if (!verdict.allowed) {
      throw new ScraperError('robots_disallowed', 'Reddit\'s robots.txt doesn\'t allow automated access to ' + url.pathname +
        ' (' + verdict.rule + '). Use Reddit\'s official Data API instead: set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env ' +
        '(see docs/reddit-scraper.md → "Reddit API credentials").', { status: 403 });
    }
  }

  // ── Requests ────────────────────────────────────────────────────────────
  // opts: { method, headers, body, signal, delayMs, concurrency, retries,
  //         timeoutMs, log(level, msg), onRequest(info), skipRobots, internal }
  // → { status, statusText, headers, body, url } (any HTTP status; throws on
  //   transport failure after retries, cancellation, robots or destination)
  async request(rawUrl, opts) {
    opts = opts || {};
    const signal = opts.signal || null;
    const log = opts.log || (() => {});
    let url = this.checkDestination(rawUrl);
    const method = String(opts.method || 'GET').toUpperCase();
    if (!opts.internal && method !== 'GET' && method !== 'HEAD') {
      throw new ScraperError('invalid_request', 'Only GET and HEAD requests are allowed.', { status: 400 });
    }
    const retries = Math.max(0, Math.min(5, Number.isInteger(opts.retries) ? opts.retries : 2));
    const interval = this.minInterval(opts.delayMs);
    const timeoutMs = Math.min(this.config.requestTimeoutMs, opts.timeoutMs || this.config.requestTimeoutMs);

    const baseHeaders = {};
    Object.entries(opts.headers || {}).forEach(([k, v]) => {
      const name = String(k).toLowerCase();
      if (opts.internal || USER_HEADER_ALLOWLIST.has(name)) baseHeaders[name] = String(v);
    });
    if (!baseHeaders.accept) baseHeaders.accept = 'application/json';
    baseHeaders['user-agent'] = this.config.userAgent;

    let redirects = 0;
    let authRefreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) throw signal.reason || cancelledError();
      if (!opts.skipRobots) await this.checkRobots(url, opts);

      const headers = Object.assign({}, baseHeaders);
      // The token is only ever sent to the OAuth API host.
      const oauthHost = new URL(this.config.redditOAuthBaseUrl).host;
      if (!opts.skipAuth && this.mode === 'oauth' && url.host === oauthHost) {
        headers.authorization = 'bearer ' + await this.getToken(opts);
      }

      const host = url.host;
      const release = await this.limiter.acquire(host, interval, signal, opts.concurrency);
      const started = this.now();
      let res;
      try {
        this.stats.requests++;
        res = await this.transport.request({ url: url.href, method, headers, body: opts.body, timeoutMs, signal });
      } catch (err) {
        release();
        this.stats.errors++;
        if (isScraperError(err) && err.type === 'cancelled') throw err;
        if (signal && signal.aborted) throw signal.reason || cancelledError();
        if (opts.onRequest) opts.onRequest({ url: url.href, status: null, ms: this.now() - started, attempt, error: err.type });
        if (err.retryable && attempt < retries) {
          const wait = this.backoff(attempt, interval);
          log('warn', err.message + ' Retrying in ' + Math.round(wait / 1000) + ' s (attempt ' + (attempt + 2) + ' of ' + (retries + 1) + ').');
          await sleep(wait, signal);
          continue;
        }
        throw err;
      }
      release();
      if (opts.onRequest) opts.onRequest({ url: url.href, status: res.status, ms: this.now() - started, attempt });
      this.noteRateHeaders(host, res.headers, log);

      if (res.status === 429) {
        const wait = this.retryAfter(res.headers, attempt, interval);
        this.limiter.pause(host, this.now() + wait);
        if (attempt < retries) {
          log('warn', 'Reddit is rate-limiting (HTTP 429); waiting ' + Math.round(wait / 1000) + ' s before retrying.');
          continue;
        }
        return res;
      }
      if (res.status >= 500 && attempt < retries) {
        const wait = this.backoff(attempt, interval);
        log('warn', 'Reddit answered HTTP ' + res.status + '; retrying in ' + Math.round(wait / 1000) + ' s.');
        await sleep(wait, signal);
        continue;
      }
      if (res.status === 401 && headers.authorization && !authRefreshed) {
        authRefreshed = true;
        this.token = null;
        attempt--;                       // a refreshed token doesn't count as a retry
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location && method !== 'POST') {
        if (redirects >= MAX_REDIRECTS) throw new ScraperError('http_error', 'Reddit redirected too many times.', { status: 502 });
        const next = new URL(res.headers.location, url);
        redirects++;
        if (/^\/subreddits\/search/.test(next.pathname)) {
          throw new ScraperError('not_found', 'That subreddit doesn\'t exist (Reddit redirected to subreddit search).', { status: 404, httpStatus: res.status });
        }
        if (/^\/(login|account\/login)/.test(next.pathname) || /^\/over18/.test(next.pathname)) {
          throw new ScraperError('forbidden', 'Reddit requires a login or age confirmation for this page; the scraper doesn\'t bypass such checks.', { status: 403, httpStatus: res.status });
        }
        url = this.checkDestination(next.href);
        attempt--;                       // following a redirect isn't a retry
        continue;
      }
      return Object.assign({}, res, { url: url.href });
    }
  }

  // Reddit returns X-Ratelimit-Remaining / -Reset on API responses; when the
  // window is used up, every request to that host waits until it resets.
  noteRateHeaders(host, headers, log) {
    const remaining = Number(headers['x-ratelimit-remaining']);
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(remaining) && Number.isFinite(reset) && remaining < 1 && reset > 0) {
      const until = this.now() + Math.min(MAX_RETRY_WAIT_MS, reset * 1000);
      this.limiter.pause(host, until);
      log('warn', 'Reddit\'s rate-limit window is used up; pausing requests for ' + Math.round(reset) + ' s.');
    }
  }

  retryAfter(headers, attempt, interval) {
    const ra = headers['retry-after'];
    let ms = null;
    if (ra !== undefined) {
      const s = Number(ra);
      if (Number.isFinite(s) && s >= 0) ms = s * 1000;
      else if (Number.isFinite(Date.parse(ra))) ms = Date.parse(ra) - this.now();
    }
    if (ms === null) {
      const reset = Number(headers['x-ratelimit-reset']);
      if (Number.isFinite(reset) && reset > 0) ms = reset * 1000;
    }
    if (ms === null) ms = this.backoff(attempt, interval);
    return Math.max(1000, Math.min(MAX_RETRY_WAIT_MS, ms));
  }

  backoff(attempt, interval) {
    const base = Math.max(2000, interval) * Math.pow(2, attempt);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(60000, Math.round(base * jitter));
  }

  // GET a Reddit JSON endpoint in the current mode → parsed JSON.
  async getJson(pathOrUrl, opts) {
    opts = opts || {};
    const url = this.buildApiUrl(pathOrUrl, opts.query);
    const res = await this.request(url, opts);
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, opts.context);
    const type = String(res.headers['content-type'] || '');
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      if (/html/i.test(type) || /^\s*</.test(res.body)) {
        throw new ScraperError('parse_error', 'Reddit sent a web page instead of data — it may be showing a block, login or ' +
          'age-check page to this network. Configure Reddit API credentials for reliable access.', { status: 502 });
      }
      throw new ScraperError('parse_error', 'Reddit\'s response couldn\'t be read as JSON.', { status: 502 });
    }
    return { json, url: res.url, headers: res.headers };
  }
}

module.exports = { RedditHttpClient, USER_HEADER_ALLOWLIST };
