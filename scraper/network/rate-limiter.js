// ── Polite per-host request scheduling ────────────────────────────────────────
// One limiter is shared by every scraper job and the custom-code sandbox, so
// running several jobs never multiplies the request rate against Reddit.
// For each host it enforces: at most `maxConcurrent` requests in flight, at
// least `intervalMs` between request starts (the larger of the job's delay
// and the server-wide floor), and pauses Reddit asks for (HTTP 429 /
// X-Ratelimit-Remaining reaching 0).

const { cancelledError } = require('../errors');

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || cancelledError());
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || cancelledError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

class HostRateLimiter {
  constructor(opts) {
    this.maxConcurrent = Math.max(1, (opts && opts.maxConcurrent) || 1);
    this.hosts = new Map();       // host → { nextAt, pausedUntil, active, waiters: [] }
    this.now = (opts && opts.now) || Date.now;
  }

  state(host) {
    if (!this.hosts.has(host)) this.hosts.set(host, { nextAt: 0, pausedUntil: 0, active: 0, waiters: [] });
    return this.hosts.get(host);
  }

  // Waits for a slot; resolves to a release() function. `intervalMs` is the
  // minimum gap after the previous request start to this host; `limit` caps
  // concurrency below the global maximum (a job's own concurrency setting).
  async acquire(host, intervalMs, signal, limit) {
    const s = this.state(host);
    const cap = Math.max(1, Math.min(this.maxConcurrent, limit || this.maxConcurrent));
    for (;;) {
      if (signal && signal.aborted) throw signal.reason || cancelledError();
      const now = this.now();
      const readyAt = Math.max(s.nextAt, s.pausedUntil);
      if (s.active < cap && now >= readyAt) {
        s.active++;
        s.nextAt = now + Math.max(0, intervalMs || 0);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          s.active--;
          const waiters = s.waiters.splice(0);
          waiters.forEach(w => w());
        };
      }
      if (s.active >= cap) {
        // Wait for a release (or the signal), whichever comes first.
        await new Promise((resolve, reject) => {
          const wake = () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); };
          const onAbort = () => {
            const i = s.waiters.indexOf(wake);
            if (i !== -1) s.waiters.splice(i, 1);
            reject(signal.reason || cancelledError());
          };
          s.waiters.push(wake);
          if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
      } else {
        await sleep(readyAt - now, signal);
      }
    }
  }

  // Reddit asked for a pause (429 Retry-After, or its rate-limit window is used up).
  pause(host, untilMs) {
    const s = this.state(host);
    if (untilMs > s.pausedUntil) s.pausedUntil = untilMs;
  }

  pausedUntil(host) {
    const s = this.hosts.get(host);
    return s && s.pausedUntil > this.now() ? s.pausedUntil : 0;
  }
}

module.exports = { HostRateLimiter, sleep };
