// @ts-check
// ── Network manager ───────────────────────────────────────────────────────────
// The bottom half of the scraper's request execution: every request the
// Reddit HTTP client (reddit-http.js — destination checks, robots.txt, rate
// limits, retries with backoff and Retry-After) decides to send goes through
// here. It
//
//   • picks the provider (route) the administrator configured,
//   • refuses at once while that route's circuit breaker is open,
//   • gives each attempt a request id and measures how it ended,
//   • runs the VPN gateway's health check, if one is configured.
//
// It has the same interface as the transports it wraps (kind, request(),
// status(), choose(), close()), so nothing above it changed shape.
//
// Failover: with SCRAPER_NETWORK_FAILOVER=on and more than one provider in
// SCRAPER_NETWORK_PROVIDERS, requests use the next provider in the list while
// an earlier one's circuit is open — never because Reddit refused or limited
// a request, never more than the configured list (at most three), and back to
// the first as soon as its circuit closes. Without that setting an open
// circuit simply pauses collection.

const crypto = require('crypto');
const { ScraperError } = require('../errors');
const { CircuitBreaker } = require('./circuit-breaker');
const { RequestMetrics, outcomeOfStatus, outcomeOfError } = require('./metrics');
const { logger } = require('../../lib/log');

/** @typedef {import('./providers').NetworkProvider} NetworkProvider */
/** @typedef {import('../../types/scraper').TransportRequest} TransportRequest */
/** @typedef {import('../../types/scraper').TransportResponse} TransportResponse */
/** @typedef {import('../../types/scraper').HealthResult} HealthResult */
/** @typedef {import('../../types/scraper').ProviderPublicStatus} ProviderPublicStatus */
/** @typedef {import('./circuit-breaker').BreakerOptions} BreakerOptions */

const log = logger('scraper');

/**
 * @typedef {object} ProviderEntry
 * @property {NetworkProvider} provider
 * @property {CircuitBreaker} breaker
 * @property {RequestMetrics} metrics
 * @property {HealthResult | null} lastHealth
 * @property {HealthResult | null} lastHealthOk
 * @property {HealthResult | null} lastHealthFailure
 */

class NetworkManager {
  /**
   * @param {object} opts
   * @param {NetworkProvider[]} opts.providers   in the administrator's order (first = preferred)
   * @param {boolean} [opts.failover]
   * @param {BreakerOptions} [opts.breaker]
   * @param {number} [opts.healthIntervalMs]     how often a gateway's health check runs (default 60 s)
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    if (!opts.providers.length) throw new Error('At least one network provider is needed.');
    this.now = opts.now || Date.now;
    this.failover = !!opts.failover && opts.providers.length > 1;
    this.healthIntervalMs = opts.healthIntervalMs || 60000;
    /** @type {ProviderEntry[]} */
    this.entries = opts.providers.map(provider => {
      const breaker = new CircuitBreaker(Object.assign({ now: this.now }, opts.breaker || {}));
      breaker.onTransition = (from, to) => log[to === 'closed' ? 'info' : 'warn']('circuit.' + to, { provider: provider.id, from, failures: breaker.consecutiveFailures, reason: breaker.forcedOpen });
      return { provider, breaker, metrics: new RequestMetrics({ now: this.now }), lastHealth: null, lastHealthOk: null, lastHealthFailure: null };
    });
    /** @type {NodeJS.Timeout | null} */
    this.healthTimer = null;
    /** @type {string | null} the provider that carried the last request */
    this.lastUsed = null;
  }

  /** The existing transports' kind (python / epoxy / pending) when the direct route is first; else the provider's kind. */
  get kind() {
    const first = this.entries[0].provider;
    const t = /** @type {{ transport?: { kind: string } }} */ (/** @type {unknown} */ (first)).transport;
    return t ? t.kind : first.kind;
  }

  /** The direct provider's transport, if configured (for epoxy version info, choose()). */
  get directTransport() {
    const d = this.entries.find(e => e.provider.id === 'direct');
    return d ? /** @type {{ transport?: import('../../types/scraper').Transport }} */ (/** @type {unknown} */ (d.provider)).transport || null : null;
  }

  get info() { const t = this.directTransport; return t ? t.info : null; }

  /** @param {string} id */
  entry(id) { return this.entries.find(e => e.provider.id === id) || null; }

  /**
   * One attempt of one request.
   * @param {TransportRequest} req
   * @returns {Promise<TransportResponse & { requestId: string, provider: string }>}
   */
  async request(req) {
    const requestId = 'r_' + crypto.randomBytes(6).toString('hex');
    const candidates = this.failover ? this.entries : this.entries.slice(0, 1);
    let soonest = Infinity;
    /** @type {string | null} */
    let reason = null;
    for (const e of candidates) {
      if (e.provider.problems.length) continue;
      const gate = e.breaker.check();
      if (!gate.allowed) {
        soonest = Math.min(soonest, gate.retryAt);
        if (!reason) reason = gate.reason === 'open' || gate.reason === 'probing' ? null : gate.reason;
        continue;
      }
      if (e !== this.entries[0] && this.lastUsed !== e.provider.id) log.warn('provider.failover', { from: this.entries[0].provider.id, to: e.provider.id });
      return this.attempt(e, req, requestId);
    }
    const misconfigured = candidates.every(e => e.provider.problems.length);
    if (misconfigured) {
      throw new ScraperError('network_misconfigured', 'The scraper\'s network route isn\'t configured correctly on this server, so no requests can be made. The server administrator can see the problem under Scraper → Network status.', { status: 503 });
    }
    const wait = Math.max(1000, (Number.isFinite(soonest) ? soonest : this.now() + 30000) - this.now());
    throw new ScraperError('network_unavailable',
      (reason ? 'The scraper\'s network route is down (' + reason + ').' : 'The scraper\'s network route to Reddit failed several times in a row, so requests are paused to avoid a retry storm.') +
      ' MetaCode will try again in about ' + Math.ceil(wait / 1000) + ' s.', { status: 503, retryAfterMs: wait });
  }

  /**
   * @param {ProviderEntry} e
   * @param {TransportRequest} req
   * @param {string} requestId
   */
  async attempt(e, req, requestId) {
    const started = e.metrics.start();
    this.lastUsed = e.provider.id;
    try {
      const res = await e.provider.request(req);
      const outcome = outcomeOfStatus(res.status);
      e.metrics.end(started, outcome);
      e.breaker.record(outcome);
      if (outcome === 'http_5xx' || outcome === 'http_429') {
        log.warn('request.answer', { req: requestId, provider: e.provider.id, host: hostOf(req.url), outcome, status: res.status, ms: this.now() - started });
      }
      return Object.assign({}, res, { requestId, provider: e.provider.id });
    } catch (err) {
      const outcome = outcomeOfError(err);
      e.metrics.end(started, outcome);
      e.breaker.record(outcome);
      if (outcome !== 'cancelled') {
        const se = /** @type {{ type?: string, detail?: string }} */ (err || {});
        log.warn('request.failed', { req: requestId, provider: e.provider.id, host: hostOf(req.url), outcome, type: se.type || 'error', ms: this.now() - started, detail: se.detail || null });
      }
      if (err && typeof err === 'object') /** @type {{ requestId?: string }} */ (err).requestId = requestId;
      throw err;
    }
  }

  /**
   * Runs one provider's health check now (administrators, and the timer).
   * @param {string} id
   * @returns {Promise<HealthResult | null>}
   */
  async checkHealth(id) {
    const e = this.entry(id);
    if (!e || typeof e.provider.healthCheck !== 'function') return null;
    const r = await e.provider.healthCheck();
    e.lastHealth = r;
    if (r.ok) { e.lastHealthOk = r; e.breaker.force(null); }
    else { e.lastHealthFailure = r; e.breaker.force(r.detail || 'its health check failed'); log.warn('provider.unhealthy', { provider: id, detail: r.detail }); }
    return r;
  }

  /** Starts the periodic health checks of providers that have one. */
  startHealthChecks() {
    if (this.healthTimer) return;
    const run = () => { this.entries.forEach(e => { if (typeof e.provider.healthCheck === 'function' && !e.provider.problems.length) this.checkHealth(e.provider.id).catch(() => {}); }); };
    if (!this.entries.some(e => typeof e.provider.healthCheck === 'function')) return;
    run();
    this.healthTimer = setInterval(run, this.healthIntervalMs);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  /**
   * An administrator closed a circuit by hand.
   * @param {string} id
   */
  reset(id) {
    const e = this.entry(id);
    if (!e) return false;
    e.breaker.reset();
    log.info('circuit.reset', { provider: id });
    return true;
  }

  /**
   * What ordinary users see: which route, and whether it works — no addresses, no credentials.
   * @returns {ProviderPublicStatus[]}
   */
  publicStatus() {
    return this.entries.map((e, i) => {
      const snap = e.breaker.snapshot();
      const state = e.provider.problems.length ? 'misconfigured' : snap.state === 'open' ? 'unavailable' : snap.state === 'half_open' || e.breaker.consecutiveFailures > 0 ? 'degraded' : 'ok';
      return {
        id: e.provider.id, kind: e.provider.kind, label: e.provider.label,
        active: this.failover ? this.lastUsed ? this.lastUsed === e.provider.id : i === 0 : i === 0,
        available: state !== 'misconfigured' && state !== 'unavailable',
        state, circuit: snap.state, retryAt: snap.retryAt, capabilities: Object.assign({}, e.provider.capabilities)
      };
    });
  }

  /** Everything an administrator may see (still no credentials). */
  adminStatus() {
    return {
      failover: this.failover,
      order: this.entries.map(e => e.provider.id),
      providers: this.entries.map(e => ({
        id: e.provider.id, kind: e.provider.kind, label: e.provider.label,
        capabilities: e.provider.capabilities,
        configured: !e.provider.problems.length,
        problems: e.provider.problems.slice(),
        details: e.provider.adminDetails(),
        circuit: e.breaker.snapshot(),
        metrics: e.metrics.snapshot(),
        health: {
          checks: typeof e.provider.healthCheck === 'function',
          last: e.lastHealth, lastSuccess: e.lastHealthOk, lastFailure: e.lastHealthFailure
        }
      }))
    };
  }

  /** The direct transport's own status (Python / epoxy), for the existing status page. */
  status() {
    const t = this.directTransport;
    return t && typeof t.status === 'function' ? t.status() : {};
  }

  choose() {
    const t = this.directTransport;
    return t && typeof t.choose === 'function' ? t.choose() : Promise.resolve(null);
  }

  close() {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    this.entries.forEach(e => { if (typeof e.provider.close === 'function') e.provider.close(); });
  }
}

/** @param {string} url */
function hostOf(url) { try { return new URL(url).host; } catch (e) { return '?'; } }

module.exports = { NetworkManager };
