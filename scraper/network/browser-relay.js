// ── Browser relay: Reddit requests fetched by the user's MetaCode tab ─────────
// The "This browser (Scramjet)" engine. Jobs still run on the server (targets,
// pagination, rate limiting, retries, normalizers, custom-code sandbox), but
// the HTTP requests themselves are handed to an open MetaCode tab, which
// fetches them with the same Scramjet transport the in-app Reddit browser
// uses (epoxy-transport → MetaCode's Wisp endpoint → Reddit) and posts the
// answer back. No Reddit API credentials or server-side setup are needed.
//
//   job → RedditHttpClient (destination check, rate limiter, retries)
//       → RelayHub.transportFor(job).request()   … waits for a tab
//   tab ← GET  /api/scraper/relay/events          (SSE "relay" event)
//   tab → POST /api/scraper/relay/:id/claim       (first tab to claim fetches)
//   tab → POST /api/scraper/relay/:id             ({ status, headers, body } or { error })
//
// Destinations are validated by RedditHttpClient before anything is relayed,
// and the tab checks them again; only GET/HEAD to Reddit hosts are relayed.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { ScraperError, classifyTransportError, cancelledError } = require('../errors');

// Headers the tab may receive: the browser sends its own User-Agent.
const RELAYED_HEADERS = new Set(['accept', 'accept-language', 'if-none-match', 'if-modified-since']);

class RelayHub extends EventEmitter {
  constructor(opts) {
    super();
    this.setMaxListeners(0);
    this.maxResponseBytes = (opts && opts.maxResponseBytes) || 8 * 1024 * 1024;
    this.pending = new Map();   // id → { id, jobId, request, claimed, resolve, reject, timer }
    this.subscribers = 0;
    this.byOwner = new Map();   // owner → connected tabs
    this.ownerOfJob = () => null;   // set by the scraper: which browser a job belongs to
  }

  // Tabs connect per browser: a job's requests only go to its own browser's tabs.
  subscribe(owner) { this.subscribers++; if (owner) this.byOwner.set(owner, (this.byOwner.get(owner) || 0) + 1); }
  unsubscribe(owner) {
    this.subscribers--;
    if (owner) { const n = (this.byOwner.get(owner) || 1) - 1; if (n > 0) this.byOwner.set(owner, n); else this.byOwner.delete(owner); }
  }
  tabsFor(owner) { return owner ? (this.byOwner.get(owner) || 0) : this.subscribers; }
  // Whether a tab of this browser may see / answer the request
  allowed(request, owner) { const o = this.ownerOfJob(request.jobId); return !o || o === owner; }
  ownerOfRequest(id) { const e = this.pending.get(id); return e ? this.ownerOfJob(e.jobId) : null; }

  // Requests no tab has claimed yet (sent to a tab when it connects).
  unclaimed(owner) {
    return Array.from(this.pending.values()).filter(p => !p.claimed && (owner === undefined || this.allowed(p.request, owner))).map(p => p.request);
  }

  transportFor(jobId) {
    const hub = this;
    return {
      request(req) { return hub.relay(jobId, req); }
    };
  }

  relay(jobId, req) {
    const signal = req.signal || null;
    if (signal && signal.aborted) return Promise.reject(signal.reason || cancelledError());
    const id = crypto.randomUUID();
    const headers = {};
    Object.entries(req.headers || {}).forEach(([k, v]) => {
      if (RELAYED_HEADERS.has(String(k).toLowerCase())) headers[String(k).toLowerCase()] = String(v);
    });
    const request = { id, jobId, url: req.url, method: req.method || 'GET', headers };
    return new Promise((resolve, reject) => {
      const entry = { id, jobId, request, claimed: false, resolve, reject, timer: null, onAbort: null };
      const finish = () => {
        clearTimeout(entry.timer);
        if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
        this.pending.delete(id);
      };
      entry.finish = finish;
      entry.timer = setTimeout(() => {
        finish();
        this.emit('cancel', { id });
        reject(this.tabsFor(this.ownerOfJob(jobId))
          ? new ScraperError('timeout', 'Reddit didn\'t answer the browser within ' + Math.round((req.timeoutMs || 20000) / 1000) + ' seconds.', { status: 504, retryable: true })
          : new ScraperError('browser_unavailable', 'No MetaCode browser tab is connected to run this browser-mode scrape. ' +
              'Keep MetaCode open (any page) until the job finishes, or reopen the Scraper page.', { status: 503 }));
      }, req.timeoutMs || 20000);
      if (signal) {
        entry.onAbort = () => { finish(); this.emit('cancel', { id }); reject(signal.reason || cancelledError()); };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.emit('request', request);
    });
  }

  // First tab to claim a request fetches it; others skip it.
  claim(id) {
    const entry = this.pending.get(id);
    if (!entry || entry.claimed) return null;
    entry.claimed = true;
    return entry.request;
  }

  // A tab's answer. Returns false when the request is unknown or already settled.
  respond(id, payload) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.finish();
    if (!payload || typeof payload !== 'object') {
      entry.reject(new ScraperError('proxy_error', 'The browser sent an unreadable answer.', { status: 502, retryable: true }));
      return true;
    }
    if (payload.error !== undefined) {
      // The tab's fetch failed (network, TLS, Wisp…): classify like a server-side failure.
      entry.reject(classifyTransportError(new Error(String(payload.error).slice(0, 500))));
      return true;
    }
    const status = Number(payload.status);
    const body = typeof payload.body === 'string' ? payload.body : '';
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      entry.reject(new ScraperError('proxy_error', 'The browser sent an invalid HTTP status.', { status: 502, retryable: true }));
      return true;
    }
    if (Buffer.byteLength(body) > this.maxResponseBytes) {
      entry.reject(new ScraperError('too_large', 'Reddit\'s response was larger than SCRAPER_MAX_RESPONSE_BYTES.', { status: 502 }));
      return true;
    }
    const headers = {};
    if (payload.headers && typeof payload.headers === 'object') {
      Object.entries(payload.headers).forEach(([k, v]) => {
        if (typeof v === 'string' || typeof v === 'number') headers[String(k).toLowerCase()] = String(v);
      });
    }
    entry.resolve({ status, statusText: typeof payload.statusText === 'string' ? payload.statusText : '', headers, body, url: entry.request.url });
    return true;
  }

  // A job finished or was deleted: drop its outstanding requests.
  cancelJob(jobId) {
    for (const entry of Array.from(this.pending.values())) {
      if (entry.jobId !== jobId) continue;
      entry.finish();
      this.emit('cancel', { id: entry.id });
      entry.reject(cancelledError());
    }
  }
}

module.exports = { RelayHub, RELAYED_HEADERS };
