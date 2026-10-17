// @ts-check
// ── Platform API requests (YouTube, X) ────────────────────────────────────────
// The request executor for official platform APIs. Every call goes through the
// scraper's network manager (the administrator's route: direct, proxy or VPN
// gateway, with its circuit breaker) and the shared per-host rate limiter, and
// gets:
//   • a timeout and cancellation (the job's signal),
//   • bounded retries with exponential backoff and jitter for network failures
//     and 5xx answers, and Retry-After for 429s (never more than `retries`),
//   • the platform's own error classification (quota used up, invalid key,
//     not found …) — refusals are reported, never worked around,
//   • no credentials in logs or errors: messages never contain the URL.

const { ScraperError, isScraperError, cancelledError } = require('../errors');
const { sleep } = require('../network/rate-limiter');

const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;

/**
 * @typedef {object} PlatformRequestOptions
 * @property {Record<string, string>} [headers]   e.g. authorization (never logged)
 * @property {AbortSignal} [signal]
 * @property {number} [delayMs]                     minimum gap between two requests to the host
 * @property {number} [timeoutMs]
 * @property {number} [retries]
 * @property {string} [limitKey]                    rate-limit bucket (host, or host + the user's key scope)
 * @property {string} label                         "YouTube" / "X", for messages
 * @property {(level: string, message: string) => void} [log]
 * @property {(info: { status?: number | null, error?: string, attempt?: number }) => void} [onRequest]
 * @property {(status: number, json: any, headers: Record<string, string>) => ScraperError | null} [classify]  non-2xx → error
 */

class PlatformHttp {
  /**
   * @param {object} opts
   * @param {{ request: (req: import('../../types/scraper').TransportRequest) => Promise<import('../../types/scraper').TransportResponse> }} opts.transport  the network manager
   * @param {import('../network/rate-limiter').HostRateLimiter} opts.limiter
   * @param {string} opts.userAgent
   * @param {number} [opts.timeoutMs]
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.transport = opts.transport;
    this.limiter = opts.limiter;
    this.userAgent = opts.userAgent;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.now = opts.now || Date.now;
  }

  /**
   * GET a JSON API URL. → { json, headers, status }
   * @param {string} url
   * @param {PlatformRequestOptions} opts
   */
  async getJson(url, opts) {
    const signal = opts.signal;
    const log = opts.log || (() => {});
    const retries = Math.max(0, Math.min(5, Number.isInteger(opts.retries) ? /** @type {number} */ (opts.retries) : 2));
    const host = new URL(url).host;
    const key = opts.limitKey || host;
    const interval = Math.max(0, opts.delayMs || 0);
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) throw signal.reason || cancelledError();
      const release = await this.limiter.acquire(key, interval, signal, 1);
      let res;
      try {
        res = await this.transport.request({
          url, method: 'GET', timeoutMs: Math.min(this.timeoutMs, opts.timeoutMs || this.timeoutMs), signal,
          headers: Object.assign({ accept: 'application/json', 'user-agent': this.userAgent }, opts.headers || {})
        });
      } catch (err) {
        release();
        if (signal && signal.aborted) throw signal.reason || cancelledError();
        const e = isScraperError(err) ? /** @type {ScraperError} */ (err) : new ScraperError('network', 'The request failed.', { status: 502, retryable: true });
        // The route refused before sending (circuit open, misconfigured): nothing to retry here
        if (e.type === 'network_unavailable' || e.type === 'network_misconfigured' || e.type === 'cancelled') throw e;
        if (opts.onRequest) opts.onRequest({ status: null, error: e.type, attempt });
        const own = this.reword(e, opts.label);
        if (own.retryable && attempt < retries) {
          const wait = this.backoff(attempt, interval);
          log('warn', own.message + ' Retrying in ' + Math.round(wait / 1000) + ' s (attempt ' + (attempt + 2) + ' of ' + (retries + 1) + ').');
          await sleep(wait, signal);
          continue;
        }
        throw own;
      }
      release();
      if (opts.onRequest) opts.onRequest({ status: res.status, attempt });
      let json = null;
      try { json = res.body ? JSON.parse(res.body) : null; } catch (e) { json = null; }
      if (res.status >= 200 && res.status < 300) {
        if (json === null) throw new ScraperError('parse_error', opts.label + ' answered with something that isn\'t JSON.', { status: 502 });
        return { json, headers: res.headers, status: res.status };
      }
      const classified = opts.classify ? opts.classify(res.status, json, res.headers) : null;
      const retryable429 = res.status === 429 || (classified && classified.type === 'rate_limited');
      if (retryable429) {
        const wait = this.retryAfter(res.headers, attempt, interval);
        this.limiter.pause(key, this.now() + wait);
        if (attempt < retries) {
          log('warn', opts.label + ' is rate-limiting requests (HTTP ' + res.status + '); waiting ' + Math.round(wait / 1000) + ' s before retrying.');
          continue;
        }
        throw classified || new ScraperError('rate_limited', opts.label + ' kept rate-limiting requests (HTTP 429). Try again later.', { status: 429, retryable: true, retryAfterMs: wait });
      }
      if (res.status >= 500 && attempt < retries) {
        const wait = this.backoff(attempt, interval);
        log('warn', opts.label + ' answered HTTP ' + res.status + '; retrying in ' + Math.round(wait / 1000) + ' s.');
        await sleep(wait, signal);
        continue;
      }
      throw classified || new ScraperError('http_error', opts.label + ' answered HTTP ' + res.status + '.', { status: 502, httpStatus: res.status, retryable: res.status >= 500 });
    }
  }

  /**
   * Transport errors are worded for Reddit; say which platform it was.
   * @param {ScraperError} e @param {string} label
   */
  reword(e, label) {
    const words = /** @type {Record<string, string>} */ ({
      timeout: label + ' didn\'t answer in time.',
      network: 'The connection to ' + label + ' failed.',
      tls: 'Couldn\'t verify ' + label + '\'s TLS certificate. Something on the route may be intercepting HTTPS.'
    });
    if (!words[e.type]) return e;
    return new ScraperError(e.type, words[e.type], { status: e.status, retryable: e.retryable, detail: e.detail });
  }

  /** @param {Record<string, string>} headers @param {number} attempt @param {number} interval */
  retryAfter(headers, attempt, interval) {
    const ra = headers && headers['retry-after'];
    let ms = null;
    if (ra !== undefined) {
      const s = Number(ra);
      if (Number.isFinite(s) && s >= 0) ms = s * 1000;
      else if (Number.isFinite(Date.parse(ra))) ms = Date.parse(ra) - this.now();
    }
    const reset = Number(headers && headers['x-rate-limit-reset']);      // X: unix seconds when the window resets
    if (ms === null && Number.isFinite(reset) && reset > 0) ms = reset * 1000 - this.now();
    if (ms === null) ms = this.backoff(attempt, interval);
    return Math.max(1000, Math.min(MAX_RETRY_WAIT_MS, ms));
  }

  /** @param {number} attempt @param {number} interval */
  backoff(attempt, interval) {
    const base = Math.max(2000, interval) * Math.pow(2, attempt);
    return Math.min(60000, Math.round(base * (0.8 + Math.random() * 0.4)));
  }
}

module.exports = { PlatformHttp };
