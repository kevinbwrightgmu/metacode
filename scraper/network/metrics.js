// @ts-check
// ── Request outcome metrics ───────────────────────────────────────────────────
// Counted for every request a network provider carries: how it ended, how
// long it took, how many are in flight. Only what is measured is reported —
// latency comes from answered requests, nothing is estimated.

const { isScraperError } = require('../errors');

/** @typedef {import('../../types/scraper').RequestOutcome} RequestOutcome */
/** @typedef {import('../../types/scraper').MetricsSnapshot} MetricsSnapshot */

/** Outcomes where the route worked (an HTTP answer came back). */
const ANSWERED = new Set(['ok', 'redirect', 'http_401', 'http_403', 'http_404', 'http_429', 'http_4xx']);

/**
 * An HTTP status → outcome.
 * @param {number} status
 * @returns {RequestOutcome}
 */
function outcomeOfStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 401) return 'http_401';
  if (status === 403) return 'http_403';
  if (status === 404) return 'http_404';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  return 'http_4xx';
}

/**
 * A transport error → outcome.
 * @param {unknown} err
 * @returns {RequestOutcome}
 */
function outcomeOfError(err) {
  if (!isScraperError(err)) return 'network';
  const e = /** @type {{ type: string, retryable: boolean }} */ (err);
  switch (e.type) {
    case 'cancelled': return 'cancelled';
    case 'timeout': return 'timeout';
    case 'tls': return 'tls';
    case 'proxy_error': case 'proxy_unavailable': return 'proxy';
    // The epoxy transport reports an unreachable host and a refused (allow-listed) one alike; the
    // Python worker's refusal is final. Only the retryable kind says something about the route.
    case 'proxy_blocked': return e.retryable ? 'proxy' : 'blocked';
    case 'too_large': return 'too_large';
    case 'invalid_url': case 'host_not_allowed': return 'invalid';
    case 'network_unavailable': return 'circuit_open';
    default: return 'network';
  }
}

class RequestMetrics {
  /** @param {{ window?: number, now?: () => number }} [opts] */
  constructor(opts) {
    this.window = Math.max(10, (opts && opts.window) || 200);
    this.now = (opts && opts.now) || Date.now;
    this.total = 0;
    this.active = 0;
    /** @type {Partial<Record<RequestOutcome, number>>} */
    this.byOutcome = {};
    /** @type {{ outcome: RequestOutcome, ms: number }[]} */
    this.recent = [];
    this.lastSuccessAt = 0;
    this.lastFailureAt = 0;
    /** @type {RequestOutcome | null} */
    this.lastFailure = null;
  }

  start() { this.active++; return this.now(); }

  /**
   * @param {number} startedAt  from start()
   * @param {RequestOutcome} outcome
   */
  end(startedAt, outcome) {
    this.active = Math.max(0, this.active - 1);
    this.total++;
    this.byOutcome[outcome] = (this.byOutcome[outcome] || 0) + 1;
    const ms = Math.max(0, this.now() - startedAt);
    this.recent.push({ outcome, ms });
    if (this.recent.length > this.window) this.recent.shift();
    if (ANSWERED.has(outcome)) this.lastSuccessAt = this.now();
    else if (outcome !== 'cancelled') { this.lastFailureAt = this.now(); this.lastFailure = outcome; }
  }

  /** @returns {MetricsSnapshot} */
  snapshot() {
    const answered = this.recent.filter(r => ANSWERED.has(r.outcome)).map(r => r.ms).sort((a, b) => a - b);
    /** @param {number} q */
    const pct = q => (answered.length ? answered[Math.min(answered.length - 1, Math.floor(q * answered.length))] : null);
    const iso = /** @param {number} t */ t => (t ? new Date(t).toISOString() : null);
    return {
      total: this.total,
      byOutcome: Object.assign({}, this.byOutcome),
      active: this.active,
      timeouts: this.byOutcome.timeout || 0,
      rateLimited: this.byOutcome.http_429 || 0,
      recent: {
        window: this.recent.length,
        ok: answered.length,
        failed: this.recent.filter(r => !ANSWERED.has(r.outcome) && r.outcome !== 'cancelled').length,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95)
      },
      lastSuccessAt: iso(this.lastSuccessAt),
      lastFailureAt: iso(this.lastFailureAt),
      lastFailure: this.lastFailure
    };
  }
}

module.exports = { RequestMetrics, outcomeOfStatus, outcomeOfError, ANSWERED };
