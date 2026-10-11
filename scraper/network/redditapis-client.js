// ── RedditAPIs.com engine ─────────────────────────────────────────────────────
// redditapis.com is a third-party, pay-per-call Reddit data API (not run by
// Reddit): one bearer key from https://www.redditapis.com/dashboard/api-keys,
// REST endpoints under https://api.redditapis.com/api/reddit/*. This client
// lets every MetaCode scraper path (standard targets, pagination, sort sweep,
// custom code) use it unchanged: it accepts the same Reddit paths as
// RedditHttpClient.getJson(), calls the matching redditapis.com endpoint, and
// hands back Reddit-shaped JSON ({kind: "Listing", data: {children, after}},
// {kind: "t5", data}, [postListing, commentListing]).
//
// Requests still go through MetaCode's transport (epoxy-tls over the Wisp
// endpoint, whose allow-list includes the redditapis.com API host), the shared
// rate limiter and retries. The key is only ever sent to the configured
// redditapis.com origin and never reaches the browser, logs or custom code.
//
// Endpoint mapping (see docs.redditapis.com and the official redditapis-mcp):
//   /r/<sub>/<sort>           → GET /api/reddit/posts?subreddit&sort&t&limit&after
//   /r/<sub>/search, /search  → GET /api/reddit/search?q&subreddit&sort&t&limit&after
//   /r/<sub>/about            → GET /api/reddit/sub/<sub>/about
//   /user/<name>/about        → GET /api/reddit/user/<name>
//   /user/<name>/submitted    → GET /api/reddit/user/<name>/submitted?sort&t&limit&after
//   /user/<name>/comments     → GET /api/reddit/user/<name>/comments?sort&limit&after
//   /comments/<id>            → GET /api/reddit/post/<id>, then /api/reddit/comments?permalink
//   key check / balance       → GET /account/me (free)

const { RedditHttpClient } = require('./reddit-http');
const { ScraperError, sanitize } = require('../errors');

const DASHBOARD_URL = 'https://www.redditapis.com/dashboard/api-keys';
const LISTING_KEYS = ['posts', 'comments', 'items', 'results', 'children', 'things'];

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

// A listing item (Reddit {kind, data} or a flat object) → Reddit thing.
function toThing(item, defaultKind) {
  if (!isObj(item)) return null;
  if (typeof item.kind === 'string' && isObj(item.data)) return { kind: item.kind, data: item.data };
  const name = typeof item.name === 'string' ? item.name : '';
  let kind = item.kind && typeof item.kind === 'string' && /^(t1|t3|more)$/.test(item.kind) ? item.kind : null;
  if (!kind) {
    if (/^t1_/.test(name) || (item.body !== undefined && item.title === undefined)) kind = 't1';
    else if (/^t3_/.test(name) || item.title !== undefined) kind = 't3';
    else kind = defaultKind;
  }
  return { kind, data: item };
}

// Any of the listing envelopes → Reddit Listing. null if unrecognised.
function toListing(body, defaultKind) {
  let items = null;
  let after = null;
  let status = null;
  if (Array.isArray(body)) items = body;
  else if (isObj(body)) {
    if (body.kind === 'Listing' && isObj(body.data) && Array.isArray(body.data.children)) {
      items = body.data.children;
      after = body.data.after;
    } else if (isObj(body.data) && Array.isArray(body.data.children)) {
      items = body.data.children;
      after = body.data.after;
    } else {
      const key = LISTING_KEYS.find(k => Array.isArray(body[k]));
      if (key) items = body[key];
      else if (Array.isArray(body.data)) items = body.data;
    }
    if (after === null || after === undefined) after = body.after;
    if (typeof body.listing_status === 'string') status = body.listing_status;
  }
  if (!items) return null;
  return {
    listing: { kind: 'Listing', data: { after: typeof after === 'string' && after ? after : null, children: items.map(i => toThing(i, defaultKind)).filter(Boolean) } },
    status
  };
}

// A single object (subreddit, user, post) → its data object.
function unwrapObject(body, keys) {
  if (!isObj(body)) return null;
  if (typeof body.kind === 'string' && isObj(body.data)) return body.data;
  for (const k of keys) if (isObj(body[k])) return isObj(body[k].data) && body[k].kind ? body[k].data : body[k];
  if (isObj(body.data) && !Array.isArray(body.data.children)) return body.data;
  const listed = toListing(body, 't3');
  if (listed && listed.listing.data.children.length) return listed.listing.data.children[0].data;
  return body;
}

// Comment nodes (Reddit {kind, data} with Listing or array replies, or flat
// objects with a `replies` array) → Reddit's nested comment format, which
// format.flattenComments() reads.
function toCommentTree(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(node => {
    if (!isObj(node)) return null;
    const thing = typeof node.kind === 'string' && isObj(node.data) ? { kind: node.kind, data: Object.assign({}, node.data) }
      : (node.kind === 'more' ? { kind: 'more', data: node } : { kind: 't1', data: Object.assign({}, node) });
    if (thing.kind === 't1') {
      const r = thing.data.replies;
      if (Array.isArray(r)) thing.data.replies = { kind: 'Listing', data: { children: toCommentTree(r) } };
      else if (isObj(r) && isObj(r.data) && Array.isArray(r.data.children)) thing.data.replies = { kind: 'Listing', data: { children: toCommentTree(r.data.children) } };
      else if (isObj(r) && Array.isArray(r.children)) thing.data.replies = { kind: 'Listing', data: { children: toCommentTree(r.children) } };
      else thing.data.replies = '';
    }
    return thing;
  }).filter(Boolean);
}

function commentNodes(body) {
  if (Array.isArray(body)) {
    if (body.length >= 2 && isObj(body[1]) && body[1].kind === 'Listing') return body[1].data.children;   // Reddit's own pair
    return body;
  }
  if (!isObj(body)) return null;
  if (Array.isArray(body.comments)) return body.comments;
  if (isObj(body.comments) && isObj(body.comments.data) && Array.isArray(body.comments.data.children)) return body.comments.data.children;
  if (Array.isArray(body.children)) return body.children;
  if (isObj(body.data) && Array.isArray(body.data.children)) return body.data.children;
  return null;
}

class RedditApisClient extends RedditHttpClient {
  // opts: { config, transport, limiter, getKey: () => key|null, baseUrl, limitScope }
  constructor(opts) {
    super({ config: Object.assign({}, opts.config, { oauth: null, respectRobotsTxt: false }), transport: opts.transport, limiter: opts.limiter,
      limitScope: opts.limitScope });
    this.getKey = opts.getKey;
    this.base = new URL(opts.baseUrl);
    this.label = 'RedditAPIs.com (API key, billed per request)';
  }

  get mode() { return 'redditapis'; }

  minInterval(delayMs) {
    return Math.max(this.config.minDelayMs, Number.isFinite(delayMs) ? delayMs : this.config.defaultDelayMs);
  }

  // Only the configured redditapis.com origin.
  checkDestination(raw) {
    let url;
    try { url = new URL(String(raw)); } catch (e) { throw new ScraperError('invalid_url', 'That isn\'t a valid URL.', { status: 400 }); }
    if (url.origin !== this.base.origin || url.username || url.password) {
      throw new ScraperError('host_not_allowed', 'The RedditAPIs.com engine only calls ' + this.base.host + '.', { status: 400 });
    }
    url.hash = '';
    return url;
  }

  // ctx.fetch() in custom code: raw Reddit URLs aren't available through this service.
  async request(url) {
    throw new ScraperError('not_available', 'ctx.fetch() isn\'t available with the RedditAPIs.com engine — use ctx.reddit.json / pages / listing / post, ' +
      'or switch "Fetch Reddit through" to another engine.', { status: 400 });
  }

  buildApiUrl(pathOrUrl) { return String(pathOrUrl); }

  async call(path, params, opts, what) {
    const key = this.getKey();
    if (!key) throw new ScraperError('auth_error', 'No RedditAPIs.com API key is set. Add one on the Scraper page (Reddit API access) or in .env (REDDITAPIS_KEY).', { status: 400 });
    const url = new URL(path, this.base);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
    const res = await RedditHttpClient.prototype.request.call(this, url.href, Object.assign({}, opts, {
      method: 'GET', internal: true, skipRobots: true, skipAuth: true,
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
    }));
    let body = null;
    try { body = JSON.parse(res.body); } catch (e) { body = undefined; }
    if (res.status >= 200 && res.status < 300) {
      if (body === undefined) throw new ScraperError('parse_error', 'RedditAPIs.com sent a response that isn\'t JSON for ' + what + '.', { status: 502 });
      return body;
    }
    throw this.apiError(res.status, body, what);
  }

  apiError(status, body, what) {
    const err = isObj(body) && typeof body.error === 'string' ? body.error : '';
    const detail = err ? ' (' + sanitize(err, 120) + ')' : '';
    if (status === 401 || err === 'Invalid token') {
      return new ScraperError('auth_error', 'RedditAPIs.com rejected the API key' + detail + '. Check it at ' + DASHBOARD_URL + '.', { status: 502, httpStatus: status });
    }
    if (status === 402) {
      return new ScraperError('payment_required', 'Your RedditAPIs.com balance is used up' + detail + '. Top up at https://www.redditapis.com, then run the job again. ' +
        'Results collected so far are kept.', { status: 402, httpStatus: status });
    }
    if (status === 403) return new ScraperError('forbidden', what + ' isn\'t accessible (RedditAPIs.com answered 403' + detail + '): it may be private, banned or quarantined.', { status: 403, httpStatus: status });
    if (status === 404) return new ScraperError('not_found', what + ' wasn\'t found (RedditAPIs.com answered 404' + detail + ').', { status: 404, httpStatus: status });
    if (status === 429) return new ScraperError('rate_limited', 'RedditAPIs.com is rate-limiting requests (HTTP 429); the scraper waited and retried. Raise the delay between requests or try later.', { status: 429, httpStatus: status, retryable: true });
    if (status >= 500) return new ScraperError('http_error', 'RedditAPIs.com had a server problem (HTTP ' + status + '). Try again later.', { status: 502, httpStatus: status, retryable: true });
    return new ScraperError('http_error', 'RedditAPIs.com refused the request for ' + what + ' (HTTP ' + status + detail + ').', { status: 502, httpStatus: status });
  }

  listing(body, kind, what, opts) {
    const r = toListing(body, kind);
    if (!r) throw new ScraperError('parse_error', 'RedditAPIs.com\'s answer for ' + what + ' wasn\'t a listing MetaCode recognises.', { status: 502 });
    if (!r.listing.data.after && r.status && r.status !== 'complete' && opts && opts.log) {
      opts.log('info', what + ': RedditAPIs.com reports listing_status "' + sanitize(r.status, 30) + '" — Reddit stopped serving this listing; ' +
        'other sorts or time ranges can surface more.');
    }
    return r.listing;
  }

  // Reddit path → Reddit-shaped JSON, via redditapis.com.
  async getJson(pathOrUrl, opts) {
    opts = opts || {};
    let path = String(pathOrUrl || '');
    const q = Object.assign({}, opts.query || {});
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      u.searchParams.forEach((v, k) => { if (q[k] === undefined) q[k] = v; });
      path = u.pathname;
    } else {
      const i = path.indexOf('?');
      if (i !== -1) { new URLSearchParams(path.slice(i + 1)).forEach((v, k) => { if (q[k] === undefined) q[k] = v; }); path = path.slice(0, i); }
    }
    path = ('/' + path.replace(/^\/+/, '')).replace(/\.json$/i, '').replace(/\/+$/, '') || '/';
    const page = { limit: q.limit, after: q.after };
    const enc = encodeURIComponent;
    let m;
    const done = json => ({ json, url: 'redditapis:' + path, headers: {} });

    if ((m = path.match(/^\/r\/([^/]+)\/(hot|new|top|rising|controversial|best)$/i))) {
      const what = 'r/' + m[1];
      const body = await this.call('/api/reddit/posts', Object.assign({ subreddit: m[1], sort: m[2].toLowerCase(), t: q.t }, page), opts, what);
      return done(this.listing(body, 't3', what + '/' + m[2], opts));
    }
    if ((m = path.match(/^\/r\/([^/]+)$/i))) {
      const body = await this.call('/api/reddit/posts', Object.assign({ subreddit: m[1], sort: 'hot' }, page), opts, 'r/' + m[1]);
      return done(this.listing(body, 't3', 'r/' + m[1], opts));
    }
    if ((m = path.match(/^\/r\/([^/]+)\/search$/i)) || path === '/search') {
      const what = 'This search';
      const body = await this.call('/api/reddit/search', Object.assign({ q: q.q, subreddit: m ? m[1] : undefined, sort: q.sort, t: q.t }, page), opts, what);
      return done(this.listing(body, 't3', what, opts));
    }
    if ((m = path.match(/^\/r\/([^/]+)\/about$/i))) {
      const body = await this.call('/api/reddit/sub/' + enc(m[1]) + '/about', null, opts, 'r/' + m[1]);
      const data = unwrapObject(body, ['subreddit', 'about']);
      if (!data) throw new ScraperError('parse_error', 'RedditAPIs.com\'s answer for r/' + m[1] + ' info wasn\'t readable.', { status: 502 });
      return done({ kind: 't5', data });
    }
    if ((m = path.match(/^\/(?:user|u)\/([^/]+)\/about$/i))) {
      const body = await this.call('/api/reddit/user/' + enc(m[1]), null, opts, 'u/' + m[1]);
      const data = unwrapObject(body, ['user', 'profile']);
      if (!data) throw new ScraperError('parse_error', 'RedditAPIs.com\'s answer for u/' + m[1] + ' wasn\'t readable.', { status: 502 });
      return done({ kind: 't2', data });
    }
    if ((m = path.match(/^\/(?:user|u)\/([^/]+)\/(submitted|comments)$/i))) {
      const section = m[2].toLowerCase();
      const params = Object.assign({ sort: q.sort }, section === 'submitted' ? { t: q.t } : {}, page);
      const body = await this.call('/api/reddit/user/' + enc(m[1]) + '/' + section, params, opts, 'u/' + m[1]);
      return done(this.listing(body, section === 'comments' ? 't1' : 't3', 'u/' + m[1] + ' ' + section, opts));
    }
    if ((m = path.match(/^\/(?:user|u)\/([^/]+)(?:\/overview)?$/i))) {
      throw new ScraperError('not_available', 'RedditAPIs.com doesn\'t offer a profile overview. Choose the profile\'s Posts or Comments section instead.', { status: 400 });
    }
    if ((m = path.match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/.*)?$/i))) {
      return done(await this.postWithComments(m[1].toLowerCase(), opts));
    }
    if (path === '/api/morechildren') {
      throw new ScraperError('not_available', 'Loading collapsed comments isn\'t offered through RedditAPIs.com.', { status: 400 });
    }
    throw new ScraperError('not_available', 'RedditAPIs.com doesn\'t offer "' + sanitize(path, 80) + '". With this engine you can scrape subreddits, search, ' +
      'posts with comments, user posts or comments, and subreddit/user info.', { status: 400 });
  }

  async postWithComments(id, opts) {
    const what = 'Post ' + id;
    const postBody = await this.call('/api/reddit/post/' + encodeURIComponent(id), null, opts, what);
    const post = unwrapObject(postBody, ['post']);
    if (!post || typeof post.permalink !== 'string' || !post.permalink) {
      throw new ScraperError('parse_error', 'RedditAPIs.com\'s answer for ' + what + ' had no permalink to load its comments.', { status: 502 });
    }
    const permalink = post.permalink.replace(/^https?:\/\/[^/]+/i, '');
    const body = await this.call('/api/reddit/comments', { permalink }, opts, what + ' comments');
    const nodes = commentNodes(body);
    if (!nodes) throw new ScraperError('parse_error', 'RedditAPIs.com\'s answer for the comments of ' + what + ' wasn\'t a comment tree MetaCode recognises.', { status: 502 });
    return [
      { kind: 'Listing', data: { after: null, children: [{ kind: 't3', data: post }] } },
      { kind: 'Listing', data: { after: null, children: toCommentTree(nodes) } }
    ];
  }

  // Free key check (GET /account/me). → the account object.
  async account(opts) {
    return this.call('/account/me', null, Object.assign({ retries: 1 }, opts || {}), 'Your RedditAPIs.com account');
  }
}

// A balance-like number from /account/me, if it has one.
function balanceOf(account) {
  if (!isObj(account)) return null;
  for (const k of ['balance', 'credit_balance', 'credits', 'remaining_credits', 'balance_usd']) {
    if (typeof account[k] === 'number' && Number.isFinite(account[k])) return { field: k, value: account[k] };
  }
  if (isObj(account.account)) return balanceOf(account.account);
  return null;
}

module.exports = { RedditApisClient, toListing, toThing, toCommentTree, unwrapObject, commentNodes, balanceOf, DASHBOARD_URL };
