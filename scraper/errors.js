// ── Scraper errors ────────────────────────────────────────────────────────────
// Every failure the scraper reports carries a machine-readable `type` and a
// message written for the user (what happened, what to do). Raw transport
// errors are classified here and never shown verbatim: they can contain URLs,
// internal addresses or library internals. The same { error: { message, type } }
// contract as the rest of MetaCode's API is used when one reaches a route.

class ScraperError extends Error {
  constructor(type, message, opts) {
    super(message);
    opts = opts || {};
    this.name = 'ScraperError';
    this.type = type;
    this.status = opts.status || 400;          // HTTP status when returned by a route
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs || null;
    this.httpStatus = opts.httpStatus || null; // status Reddit answered with, if any
    this.detail = opts.detail || null;         // short, sanitized detail for the server log only
  }
}

const isScraperError = err => err instanceof ScraperError;

// Strips anything that shouldn't reach a log line: URLs with query strings,
// bearer tokens, basic-auth headers, control characters.
function sanitize(text, max) {
  let s = String(text === undefined || text === null ? '' : text);
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
       .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
       .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]')
       .replace(/[\u0000-\u001F\u007F]+/g, ' ')
       .replace(/\s{2,}/g, ' ')
       .trim();
  const limit = max || 240;
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

// Turns an exception from the epoxy-tls client (Rust/hyper error strings) or
// the Wisp connection into a ScraperError.
function classifyTransportError(err) {
  if (isScraperError(err)) return err;
  const raw = String((err && (err.message || err)) || '');
  const detail = sanitize(raw, 200);
  if (/InvalidCertificate|UnknownIssuer|certificate|CertExpired|NotValidForName|BadSignature/i.test(raw)) {
    return new ScraperError('tls', 'Couldn\'t verify Reddit\'s TLS certificate. A firewall, antivirus or proxy that ' +
      'inspects HTTPS traffic may be intercepting the connection.', { status: 502, detail });
  }
  if (/tls handshake eof|HostBlocked|refus/i.test(raw)) {
    return new ScraperError('proxy_blocked', 'The Wisp proxy closed the connection before TLS started. The host may be ' +
      'outside the scraper\'s allow-list, resolve to a blocked (private) address, or be unreachable from this server.', { status: 502, retryable: true, detail });
  }
  if (/websocket|wisp|ws:\/\/|stream provider/i.test(raw)) {
    return new ScraperError('proxy_error', 'MetaCode couldn\'t reach its Wisp proxy endpoint. Restart MetaCode; if this ' +
      'persists, check that nothing blocks WebSocket connections to the server.', { status: 502, retryable: true, detail });
  }
  if (/dns|resolve|lookup|ENOTFOUND|EAI_AGAIN|no such host/i.test(raw)) {
    return new ScraperError('network', 'Couldn\'t look up Reddit\'s address. Check this computer\'s internet connection.', { status: 502, retryable: true, detail });
  }
  if (/timed? ?out|elapsed/i.test(raw)) {
    return new ScraperError('timeout', 'Reddit didn\'t answer in time.', { status: 504, retryable: true, detail });
  }
  if (/Connect|connection|reset|broken pipe|eof|closed|io error|hyper/i.test(raw)) {
    return new ScraperError('network', 'The connection to Reddit failed. Check the internet connection and try again.', { status: 502, retryable: true, detail });
  }
  return new ScraperError('network', 'The request to Reddit failed.', { status: 502, retryable: true, detail });
}

// Reddit's HTTP answer → ScraperError (for non-2xx statuses). `res` (optional)
// is the response ({ headers, body }): Reddit explains many refusals in the
// body — {"reason": "private" | "quarantined" | "gold_only" | "banned"} — while
// a refusal of logged-out traffic as a whole comes back as an HTML block page.
const NETWORK_BLOCK_MESSAGE = 'Reddit refused this request because it was made without a Reddit login or API key ' +
  '(Reddit blocks logged-out access from many networks). This isn\'t about the subreddit itself. ' +
  'Fix: on the Scraper page, open "Reddit API access", paste a free Reddit app\'s ID and secret, and run the job with ' +
  '"Fetch Reddit through: MetaCode server (Reddit API)".';

function redditReason(res) {
  if (!res || typeof res.body !== 'string') return { reason: null, html: false };
  const type = String((res.headers && res.headers['content-type']) || '');
  const body = res.body;
  if (/html/i.test(type) || /^\s*</.test(body)) return { reason: null, html: true };
  try {
    const json = JSON.parse(body);
    if (json && typeof json.reason === 'string') return { reason: json.reason.toLowerCase(), html: false };
  } catch (e) { /* not JSON */ }
  return { reason: null, html: /blocked|network security/i.test(body) };
}

function httpError(status, context, res) {
  const what = context || 'Reddit';
  const { reason, html } = redditReason(res);
  const opts = { status: 502, httpStatus: status };
  if (status === 401) return new ScraperError('auth_error', what + ' requires authentication (HTTP 401). Check the Reddit API keys (Scraper page → Reddit API access, or REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in .env).', opts);
  if (reason === 'private') return new ScraperError('forbidden_private', what + ' is private: only its approved members can read it, so it can\'t be scraped.', Object.assign(opts, { status: 403 }));
  if (reason === 'quarantined') return new ScraperError('forbidden_quarantined', what + ' is quarantined: Reddit only shows it to logged-in accounts that have opted in, so it can\'t be scraped with API keys or logged out.', Object.assign(opts, { status: 403 }));
  if (reason === 'gold_only') return new ScraperError('forbidden_premium', what + ' is only available to Reddit Premium members, so it can\'t be scraped.', Object.assign(opts, { status: 403 }));
  if (reason === 'banned') return new ScraperError('not_found', what + ' has been banned by Reddit.', Object.assign(opts, { status: 404 }));
  if (status === 403) {
    // Reddit's refusal of logged-out traffic is an HTML block page.
    if (html) return new ScraperError('reddit_blocked', NETWORK_BLOCK_MESSAGE, Object.assign(opts, { status: 403 }));
    return new ScraperError('forbidden', what + ' refused access (HTTP 403' + (reason ? ', reason: ' + reason.slice(0, 40) : '') + '). ' +
      'The subreddit or profile may be restricted, or Reddit may require a login or API key from this network (Scraper page → Reddit API access).', Object.assign(opts, { status: 403 }));
  }
  if (status === 404) return new ScraperError('not_found', what + ' was not found (HTTP 404). Check the subreddit, user or post.', { status: 404, httpStatus: status });
  if (status === 429) return new ScraperError('rate_limited', 'Reddit is rate-limiting requests (HTTP 429). The scraper waited and retried, but the limit persisted — raise the delay between requests or try later.', { status: 429, httpStatus: status, retryable: true });
  if (status >= 500) return new ScraperError('http_error', 'Reddit had a server problem (HTTP ' + status + '). Try again later.', { status: 502, httpStatus: status, retryable: true });
  return new ScraperError('http_error', what + ' answered with HTTP ' + status + '.', { status: 502, httpStatus: status });
}

function cancelledError() {
  return new ScraperError('cancelled', 'The job was cancelled.', { status: 409 });
}

module.exports = { ScraperError, isScraperError, sanitize, classifyTransportError, httpError, cancelledError };
