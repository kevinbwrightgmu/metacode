// @ts-check
// ── X (Twitter), through the official X API v2 ────────────────────────────────
// What an X job can collect with a bearer token (the server's X_BEARER_TOKEN
// or the user's own, sent per job and never stored):
//
//   search    posts matching a query (X's search operators work), newest first
//             ("Latest") or most relevant first ("Top"), with a date range.
//             Recent search covers the last 7 days; "full archive" needs an X
//             plan that includes it.
//   user      a user's recent posts (optionally without replies / reposts)
//   posts     specific posts by URL or ID
//
// Each post keeps what israel-dryer/Twitter-Scraper collected (name, handle,
// date, text, replies, reposts, likes) and more (quotes, bookmarks, views
// when X reports them, language, conversation, links). Logging in with a
// password and scrolling x.com isn't how MetaCode reads X: it is against X's
// terms, needs users' passwords on the server and stops at X's checks.

const { ScraperError } = require('../errors');

const POST_ID_RE = /^\d{1,25}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_FIELDS = 'created_at,public_metrics,lang,conversation_id,author_id,referenced_tweets,entities,possibly_sensitive';
const USER_FIELDS = 'username,name,verified,public_metrics,created_at';

const invalid = /** @param {string} m */ m => new ScraperError('invalid_request', m, { status: 400 });

/** A post ID from an ID or an x.com / twitter.com status URL. @param {string} raw */
function parsePostId(raw) {
  const s = String(raw || '').trim();
  if (POST_ID_RE.test(s)) return s;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status(?:es)?\/(\d{1,25})/i);
  return m ? m[1] : null;
}

/** A username from @name, a profile URL or the bare name. @param {string} raw */
function parseUsername(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i);
  const name = m ? m[1] : s.replace(/^@/, '');
  return USERNAME_RE.test(name) && !/^(home|search|explore|i|settings|messages|notifications)$/i.test(name) ? name : null;
}

/** @param {unknown} v @param {string} what */
function isoDate(v, what) {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t) || t < Date.UTC(2006, 2, 21) || t > Date.now() + 86400000) throw invalid(what + ' must be a date between March 2006 and today.');
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** @param {any} t */
function normalizeXTarget(t) {
  if (!t || typeof t !== 'object') throw invalid('Choose what to collect from X.');
  const type = String(t.type || '');
  if (type === 'search') {
    const query = String(t.query || '').trim();
    if (!query || query.length > 1024) throw invalid('Type an X search query (up to 1,024 characters; X\'s search operators work).');
    const startTime = isoDate(t.startTime, '"From"'), endTime = isoDate(t.endTime, '"Until"');
    if (startTime && endTime && startTime >= endTime) throw invalid('"From" must be earlier than "Until".');
    return { platform: 'x', type, query, sort: t.sort === 'top' ? 'top' : 'latest', archive: t.archive === true, startTime, endTime,
      label: 'X · search "' + (query.length > 60 ? query.slice(0, 59) + '…' : query) + '"' };
  }
  if (type === 'user') {
    const username = parseUsername(t.username);
    if (!username) throw invalid('Enter an X username (e.g. @nasa) or profile URL.');
    return { platform: 'x', type, username, excludeReplies: t.excludeReplies === true, excludeReposts: t.excludeReposts === true, label: 'X · @' + username };
  }
  if (type === 'posts') {
    /** @type {unknown[]} */
    const raw = Array.isArray(t.posts) ? t.posts : String(t.posts || '').split(/[\s,]+/);
    /** @type {string[]} */
    const ids = [];
    for (const r of raw.map(x => String(x).trim()).filter(Boolean)) {
      const id = parsePostId(r);
      if (!id) throw invalid('"' + r.slice(0, 80) + '" isn\'t an X post URL or ID.');
      if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) throw invalid('Paste at least one X post URL or ID.');
    if (ids.length > 1000) throw invalid('A job takes at most 1,000 posts.');
    return { platform: 'x', type, postIds: ids, label: 'X · ' + (ids.length === 1 ? 'post ' + ids[0] : ids.length + ' posts') };
  }
  throw invalid('X jobs collect a search, a user\'s posts or specific posts.');
}

/** @param {any} o @param {Record<string, any>} target */
function normalizeXOptions(o, target) {
  o = o && typeof o === 'object' ? o : {};
  const n = o.maxPosts === undefined || o.maxPosts === '' ? 100 : Number(o.maxPosts);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw invalid('Posts must be a whole number from 1 to 10,000.');
  return { maxPosts: target.type === 'posts' ? target.postIds.length : n };
}

/* ── Records ─────────────────────────────────────── */

/** @param {unknown} v */
const num = v => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * @param {any} t a post
 * @param {Map<string, any>} users author_id → user
 */
function postRecord(t, users) {
  const u = users.get(t.author_id) || {};
  const m = t.public_metrics || {};
  const refs = Array.isArray(t.referenced_tweets) ? t.referenced_tweets : [];
  const ref = /** @param {string} kind */ kind => { const r = refs.find(/** @param {any} x */ x => x.type === kind); return r ? String(r.id) : null; };
  const handle = u.username ? String(u.username) : null;
  const url = 'https://x.com/' + (handle || 'i/web') + '/status/' + t.id;
  const ent = t.entities || {};
  const text = String(t.text || '');
  return {
    record_type: 'post', platform: 'x', fullname: 'x:post:' + t.id,
    post_id: String(t.id), title: null,
    author: handle, author_name: u.name ? String(u.name) : null, author_id: t.author_id ? String(t.author_id) : null,
    author_verified: u.verified === true, author_followers: u.public_metrics ? num(u.public_metrics.followers_count) : null,
    created_at: t.created_at ? String(t.created_at) : null, created_utc: t.created_at ? Math.floor(Date.parse(t.created_at) / 1000) : null,
    selftext: text, full_text: text,
    score: num(m.like_count), like_count: num(m.like_count), retweet_count: num(m.retweet_count), reply_count: num(m.reply_count),
    quote_count: num(m.quote_count), bookmark_count: num(m.bookmark_count), view_count: num(m.impression_count),
    num_comments: num(m.reply_count),
    lang: t.lang ? String(t.lang) : null, conversation_id: t.conversation_id ? String(t.conversation_id) : null,
    in_reply_to: ref('replied_to'), quotes: ref('quoted'), is_repost: !!ref('retweeted'),
    possibly_sensitive: t.possibly_sensitive === true,
    hashtags: Array.isArray(ent.hashtags) ? ent.hashtags.map(/** @param {any} h */ h => '#' + h.tag).join(' ') : null,
    mentions: Array.isArray(ent.mentions) ? ent.mentions.map(/** @param {any} h */ h => '@' + h.username).join(' ') : null,
    links: Array.isArray(ent.urls) ? ent.urls.map(/** @param {any} l */ l => l.expanded_url || l.url).filter(Boolean).join(' ') : null,
    url, permalink: url
  };
}

/* ── Errors ──────────────────────────────────────── */

/** @param {number} status @param {any} json */
function classifyX(status, json) {
  const j = json || {};
  const said = String(j.detail || j.title || (Array.isArray(j.errors) && j.errors[0] && (j.errors[0].message || j.errors[0].detail)) || '').replace(/\s+/g, ' ').slice(0, 300);
  const kind = String(j.reason || j.type || '');
  if (status === 401) return new ScraperError('auth_error', 'X didn\'t accept the bearer token (HTTP 401). Check it in the X developer portal (Projects & Apps → Keys and tokens).', { status: 401 });
  if (status === 402 || /credits|payment/i.test(said)) return new ScraperError('payment_required', 'X says this needs credits or a paid plan' + (said ? ': ' + said : '.'), { status: 402 });
  if (status === 403) {
    const plan = /client-not-enrolled|not.*(enrolled|attached)|access level|product|tier|plan/i.test(kind + ' ' + said);
    return new ScraperError('forbidden', plan
      ? 'Your X API plan doesn\'t include this endpoint (X: ' + (said || kind) + '). Reading posts needs a plan with search access; full-archive search needs a higher one.'
      : 'X refused this request (HTTP 403' + (said ? ': ' + said : '') + ').', { status: 403 });
  }
  if (status === 404) return new ScraperError('not_found', 'X doesn\'t have that' + (said ? ' (' + said + ')' : '') + '.', { status: 404 });
  if (status === 400) return new ScraperError('invalid_request', 'X didn\'t accept the request' + (said ? ': ' + said : '.'), { status: 400 });
  if (status === 429) return new ScraperError('rate_limited', 'X is rate-limiting this token (HTTP 429). Its limits are per 15-minute window.', { status: 429, retryable: true });
  return null;
}

/* ── The runner ──────────────────────────────────── */

/**
 * @param {object} deps
 * @param {import('./http').PlatformHttp} deps.http
 * @param {ReturnType<typeof import('./config').platformConfig>['x']} deps.config
 */
function createXRunner(deps) {
  /** @param {any} job @param {any} ctx */
  return async function runX(job, ctx) {
    const target = job.target, o = job.options.x;
    const own = job.keySource === 'own';
    const token = own ? ctx.http && ctx.http.xToken : deps.config.bearerToken;
    if (!token) throw new ScraperError(own ? 'auth_error' : 'not_available', own ? 'This job used your own X bearer token, which isn\'t kept on the server. Add it again on the Scraper page and press Resume.' : 'No X API bearer token is set on this server (X_BEARER_TOKEN). Add your own on the Scraper page.', { status: 400 });
    const scope = own ? 'own:' + require('crypto').createHash('sha256').update(token).digest('hex').slice(0, 12) : 'server';
    const state = Object.assign({ v: 1, next: null, pages: 0, done: 0, userId: null }, ctx.resumeFrom || {});
    const save = () => ctx.checkpoint(Object.assign({}, state));

    /** @param {string} path @param {Record<string, string | number | null | undefined>} params */
    async function api(path, params) {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
      const r = await deps.http.getJson(deps.config.baseUrl + path + (qs.toString() ? '?' + qs.toString() : ''), {
        signal: ctx.signal, label: 'X', delayMs: deps.config.minDelayMs, retries: job.options.retries, timeoutMs: job.options.timeoutMs,
        headers: { authorization: 'Bearer ' + token }, limitKey: new URL(deps.config.baseUrl).host + '#' + scope,
        log: ctx.log, onRequest: ctx.requestOpts.onRequest, classify: classifyX
      });
      return r.json;
    }

    /** Emits a page of posts (with their authors). @param {any} page */
    function emitPage(page) {
      const users = new Map(((page.includes && page.includes.users) || []).map(/** @param {any} u */ u => [u.id, u]));
      const recs = (page.data || []).map(/** @param {any} t */ t => postRecord(t, users));
      const take = recs.slice(0, Math.max(0, o.maxPosts - state.done));
      if (take.length) ctx.emit(take);
      state.done += take.length;
      return take.length;
    }

    if (target.type === 'posts') {
      while (state.done < target.postIds.length && ctx.remaining() > 0) {
        const batch = target.postIds.slice(state.done, state.done + 100);
        ctx.progress({ message: 'Reading posts (' + state.done + ' of ' + target.postIds.length + ')…' });
        const page = await api('/tweets', { ids: batch.join(','), 'tweet.fields': TWEET_FIELDS, expansions: 'author_id', 'user.fields': USER_FIELDS });
        const before = state.done;
        emitPage(page);
        const missing = (page.errors || []).length;
        if (missing) ctx.log('warn', missing + ' post' + (missing === 1 ? ' isn\'t' : 's aren\'t') + ' available (deleted, protected or not found).');
        state.done = before + batch.length;
        save();
      }
      return;
    }

    let path = '';
    /** @type {Record<string, string | number | null>} */
    const base = { 'tweet.fields': TWEET_FIELDS, expansions: 'author_id', 'user.fields': USER_FIELDS };
    if (target.type === 'search') {
      path = target.archive ? '/tweets/search/all' : '/tweets/search/recent';
      Object.assign(base, { query: target.query, sort_order: target.sort === 'top' ? 'relevancy' : 'recency', start_time: target.startTime, end_time: target.endTime });
    } else {
      if (!state.userId) {
        const u = await api('/users/by/username/' + encodeURIComponent(target.username), { 'user.fields': USER_FIELDS });
        if (!u.data || !u.data.id) throw new ScraperError('not_found', 'X has no user @' + target.username + '.', { status: 404 });
        state.userId = String(u.data.id);
        save();
      }
      path = '/users/' + state.userId + '/tweets';
      const exclude = [target.excludeReplies ? 'replies' : '', target.excludeReposts ? 'retweets' : ''].filter(Boolean).join(',');
      if (exclude) base.exclude = exclude;
    }
    const pageParam = target.type === 'search' ? 'next_token' : 'pagination_token';
    while (state.done < o.maxPosts && ctx.remaining() > 0) {
      ctx.progress({ message: 'Reading X (page ' + (state.pages + 1) + ', ' + state.done + ' posts so far)…' });
      const want = Math.min(100, Math.max(target.type === 'search' ? 10 : 5, o.maxPosts - state.done));
      const page = await api(path, Object.assign({}, base, { max_results: want, [pageParam]: state.next }));
      state.pages++; ctx.progress({ pagesDelta: 1 });
      emitPage(page);
      state.next = (page.meta && page.meta.next_token) || null;
      save();
      if (!state.next) break;
    }
    if (!state.done) ctx.log('warn', target.type === 'search' ? 'X found no posts for this search' + (target.archive ? '.' : ' in the last 7 days (recent search\'s window).') : 'No posts found.');
  };
}

module.exports = { normalizeXTarget, normalizeXOptions, createXRunner, parsePostId, parseUsername, postRecord, classifyX };
