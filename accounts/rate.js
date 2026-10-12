// Per-account request rates (a sliding one-minute window) and how many
// long-running things (AI batches, scrapes) an account runs at once.
function createRateLimiter(opts) {
  opts = opts || {};
  const now = opts.now || Date.now;
  const hits = new Map();      // key → [timestamps]
  const active = new Map();    // key → count
  let lastPrune = now();

  function prune() {
    const t = now();
    if (t - lastPrune < 60000) return;
    lastPrune = t;
    for (const [k, list] of hits) { while (list.length && list[0] <= t - 60000) list.shift(); if (!list.length) hits.delete(k); }
  }

  // → { ok: true } or { ok: false, retryAfter (seconds) }
  function take(key, limit, windowMs) {
    windowMs = windowMs || 60000;
    prune();
    const t = now();
    const list = hits.get(key) || [];
    while (list.length && list[0] <= t - windowMs) list.shift();
    if (list.length >= limit) { hits.set(key, list); return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) }; }
    list.push(t);
    hits.set(key, list);
    return { ok: true };
  }

  // → a release function, or null when `max` are already running
  function acquire(key, max) {
    const n = active.get(key) || 0;
    if (n >= max) return null;
    active.set(key, n + 1);
    let done = false;
    return () => { if (done) return; done = true; const c = (active.get(key) || 1) - 1; if (c > 0) active.set(key, c); else active.delete(key); };
  }

  return { take, acquire, activeCount: key => active.get(key) || 0 };
}

module.exports = { createRateLimiter };
