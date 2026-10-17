// @ts-check
// ── Circuit breaker ───────────────────────────────────────────────────────────
// One per network provider. It watches whether the *route* works — not whether
// Reddit grants access — and stops sending requests down a route that keeps
// failing, so a broken network doesn't turn every job into a retry storm.
//
//   closed     requests flow. `failureThreshold` qualifying failures in a row → open.
//   open       requests are refused at once (a `network_unavailable` error with
//              the time of the next attempt) until the cooldown has passed.
//   half_open  one probe request is let through: success → closed; failure →
//              open again with a doubled cooldown (up to maxCooldownMs).
//
// Qualifying failures are infrastructure failures: connection errors, DNS,
// TLS, proxy/gateway errors, timeouts and HTTP 5xx. An HTTP 401/403/404/429 is
// an answer — the route works — so it never opens the circuit; access denials
// and rate limits are handled by the request executor (stop / wait), never by
// switching routes. An open circuit never makes MetaCode try other routes on
// its own; see network-manager.js for the administrator's failover policy.

/** @typedef {import('../../types/scraper').CircuitState} CircuitState */
/** @typedef {import('../../types/scraper').CircuitSnapshot} CircuitSnapshot */
/** @typedef {import('../../types/scraper').RequestOutcome} RequestOutcome */

/** Outcomes that count against a route's health. */
const QUALIFYING = new Set(['timeout', 'network', 'tls', 'proxy', 'http_5xx']);

/**
 * @typedef {object} BreakerOptions
 * @property {number} [failureThreshold]  qualifying failures in a row that open the circuit (default 5)
 * @property {number} [cooldownMs]        first open period (default 30 s)
 * @property {number} [maxCooldownMs]     longest open period (default 5 min)
 * @property {number} [probeTimeoutMs]    a half-open probe that hasn't answered by then frees the slot (default 2 min)
 * @property {() => number} [now]
 */

class CircuitBreaker {
  /** @param {BreakerOptions} [opts] */
  constructor(opts) {
    const o = opts || {};
    this.failureThreshold = Math.max(1, o.failureThreshold || 5);
    this.baseCooldownMs = Math.max(100, o.cooldownMs || 30000);
    this.maxCooldownMs = Math.max(this.baseCooldownMs, o.maxCooldownMs || 5 * 60000);
    this.probeTimeoutMs = o.probeTimeoutMs || 2 * 60000;
    this.now = o.now || Date.now;
    /** @type {CircuitState} */
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.cooldownMs = this.baseCooldownMs;
    this.openedAt = 0;
    this.openUntil = 0;
    this.opens = 0;
    this.probeStartedAt = 0;
    /** @type {RequestOutcome | null} */
    this.lastFailure = null;
    this.lastFailureAt = 0;
    this.lastSuccessAt = 0;
    /** @type {string | null} why it's held open from outside (e.g. "the gateway reports the tunnel is down") */
    this.forcedOpen = null;
    /** @type {(from: CircuitState, to: CircuitState) => void} */
    this.onTransition = () => {};
  }

  /** @param {CircuitState} to */
  move(to) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onTransition(from, to);
  }

  /**
   * May a request go out now?
   * @returns {{ allowed: true, probe: boolean } | { allowed: false, retryAt: number, reason: string }}
   */
  check() {
    const now = this.now();
    if (this.forcedOpen) return { allowed: false, retryAt: now + this.baseCooldownMs, reason: this.forcedOpen };
    if (this.state === 'closed') return { allowed: true, probe: false };
    if (this.state === 'open') {
      if (now < this.openUntil) return { allowed: false, retryAt: this.openUntil, reason: 'open' };
      this.move('half_open');
      this.probeStartedAt = 0;
    }
    // half_open: one probe at a time
    if (this.probeStartedAt && now - this.probeStartedAt < this.probeTimeoutMs) {
      return { allowed: false, retryAt: now + Math.min(5000, this.baseCooldownMs), reason: 'probing' };
    }
    this.probeStartedAt = now;
    return { allowed: true, probe: true };
  }

  /** The route answered (any HTTP status except a qualifying 5xx). */
  success() {
    this.lastSuccessAt = this.now();
    this.consecutiveFailures = 0;
    this.probeStartedAt = 0;
    if (this.state !== 'closed') {
      this.cooldownMs = this.baseCooldownMs;
      this.move('closed');
    }
  }

  /**
   * A request ended with `outcome`. Non-qualifying outcomes (answers, cancellations) don't count.
   * @param {RequestOutcome} outcome
   */
  record(outcome) {
    if (outcome === 'cancelled' || outcome === 'circuit_open') {
      if (this.state === 'half_open') this.probeStartedAt = 0;   // the probe didn't happen; let the next one try
      return;
    }
    if (!QUALIFYING.has(outcome)) return this.success();
    const now = this.now();
    this.lastFailure = outcome;
    this.lastFailureAt = now;
    this.consecutiveFailures++;
    if (this.state === 'half_open') {
      this.cooldownMs = Math.min(this.maxCooldownMs, this.cooldownMs * 2);
      this.open(now);
    } else if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
      this.open(now);
    }
  }

  /** @param {number} now */
  open(now) {
    this.openedAt = now;
    this.openUntil = now + this.cooldownMs;
    this.probeStartedAt = 0;
    this.opens++;
    this.move('open');
  }

  /**
   * Holds the circuit open for a reason found outside the request path (a
   * failed gateway health check), or releases it (null).
   * @param {string | null} reason
   */
  force(reason) {
    if (reason) {
      if (!this.forcedOpen) this.opens++;
      this.forcedOpen = reason;
      if (this.state !== 'open') { this.openedAt = this.now(); this.openUntil = this.now() + this.baseCooldownMs; this.move('open'); }
    } else if (this.forcedOpen) {
      this.forcedOpen = null;
      // Let the next request probe the route rather than trusting the health check alone
      this.openUntil = this.now();
    }
  }

  /** An administrator closed the circuit by hand. */
  reset() {
    this.forcedOpen = null;
    this.consecutiveFailures = 0;
    this.cooldownMs = this.baseCooldownMs;
    this.probeStartedAt = 0;
    this.move('closed');
  }

  /** When requests can be tried again (0 when they can now). */
  retryAt() {
    if (this.forcedOpen) return this.now() + this.baseCooldownMs;
    return this.state === 'open' ? this.openUntil : 0;
  }

  /** @returns {CircuitSnapshot} */
  snapshot() {
    const iso = /** @param {number} t */ t => (t ? new Date(t).toISOString() : null);
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      opens: this.opens,
      openedAt: this.state === 'closed' ? null : iso(this.openedAt),
      retryAt: iso(this.retryAt()),
      lastFailureAt: iso(this.lastFailureAt),
      lastFailure: this.lastFailure,
      lastSuccessAt: iso(this.lastSuccessAt),
      forcedOpen: this.forcedOpen
    };
  }
}

module.exports = { CircuitBreaker, QUALIFYING };
