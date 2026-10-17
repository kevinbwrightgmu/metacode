// ── Standard (no-code) Reddit scraper ─────────────────────────────────────────
// Runs one normalized target (see targets.js) through the Reddit HTTP client
// and hands normalized records to the job. Pagination follows Reddit's
// `after` cursor and stops at the first of: max pages, max items, no more
// pages, an empty page, or cancellation.
//
// ctx (from the job manager):
//   http          RedditHttpClient
//   requestOpts   { signal, delayMs, concurrency, retries, timeoutMs, log, onRequest }
//   emit(records) → number of items the job can still accept
//   remaining()   → same, without adding anything
//   progress(patch), log(level, message), setMeta(key, value)
//   checkpoint(state)  (optional) called after each page's records were
//                 emitted — the job manager writes them to disk first — with
//                 where to continue from (types/scraper.d.ts StandardCheckpoint)
//   resumeFrom    (optional) the last checkpoint, when the job is resumed
//   committed()   (optional) the records already collected, when resumed
//
// Resuming re-reads at most the page after the checkpoint; records seen again
// are dropped by their Reddit id. Listings change between runs (new posts push
// older ones down), so a resumed listing can miss or repeat items near the
// cursor — repeats are de-duplicated, gaps aren't detectable from the listing.

const F = require('./format');
const { ScraperError, isScraperError } = require('../errors');

function readListing(json, what) {
  if (!json || json.kind !== 'Listing' || !json.data || !Array.isArray(json.data.children)) {
    throw new ScraperError('parse_error', 'Reddit\'s answer for ' + what + ' wasn\'t a listing MetaCode could read.', { status: 502 });
  }
  return json.data;
}

// Listing items count against options.maxItems; ctx.remaining() is the
// job's overall capacity (which also covers comments fetched afterwards).
// `shared` carries the unique items and page count across several listings
// (the sort sweep), so items seen in an earlier sort aren't counted twice.
function newShared() { return { collected: 0, keys: new Set(), pages: 0, posts: [] }; }
function newCheckpoint() { return { v: 1, phase: 'listing', sort: 0, after: null, pages: 0, seen: 0, commentsDone: 0 }; }

// A resumed job: what the earlier runs collected. In the listing phase every
// record so far is a listing item; afterwards only the posts are needed (for
// their comment threads).
function sharedFromCommitted(ctx) {
  const shared = newShared();
  const recs = typeof ctx.committed === 'function' ? ctx.committed() : [];
  recs.forEach(r => {
    const key = F.recordKey(r);
    if (key) shared.keys.add(key);
    if (r.record_type === 'post') shared.posts.push(r);
  });
  shared.collected = recs.length;
  return shared;
}

function saveCheckpoint(ctx, cp) { if (cp && typeof ctx.checkpoint === 'function') ctx.checkpoint(cp); }

// `cp` (optional) is the job's checkpoint: the listing continues from cp.after,
// and after every page that isn't the last one the cursor is saved. When the
// listing ends the caller moves the checkpoint on (next sort, comments, done).
// options.since (unix seconds): items older than that are skipped, and a
// listing sorted by "new" stops at the first one (incremental collection).
async function paginate(ctx, options, path, query, what, shared, cp, sortedByNew) {
  shared = shared || newShared();
  let after = cp ? cp.after : null;
  let pages = cp ? cp.pages : 0;
  let seen = cp ? cp.seen : 0;
  const since = Number(options.since) || 0;
  const left = () => Math.min(options.maxItems - shared.collected, ctx.remaining());
  let reachedOld = false;
  while (pages < options.maxPages && left() > 0) {
    // Ask for a full page when items may repeat from an earlier sort.
    const limit = shared.keys.size ? 100 : Math.min(100, left());
    const q = Object.assign({}, query, { limit, after: after || undefined, count: seen || undefined });
    const { json } = await ctx.http.getJson(path, Object.assign({}, ctx.requestOpts, { query: q, context: what }));
    pages++;
    shared.pages++;
    const data = readListing(json, what);
    const fresh = [];
    let older = 0;
    for (const r of data.children.map(c => F.normalizeThing(c)).filter(Boolean)) {
      if (fresh.length >= left()) break;
      if (since && Number.isFinite(r.created_utc) && r.created_utc < since) { older++; continue; }
      const key = F.recordKey(r);
      if (key && shared.keys.has(key)) continue;
      if (key) shared.keys.add(key);
      fresh.push(r);
    }
    seen += data.children.length;
    shared.collected += fresh.length;
    fresh.forEach(r => { if (r.record_type === 'post') shared.posts.push(r); });
    ctx.emit(fresh);
    ctx.progress({ pagesFetched: shared.pages, message: what + ' page ' + pages + ': ' + fresh.length + ' new item' + (fresh.length === 1 ? '' : 's') });
    after = typeof data.after === 'string' && data.after ? data.after : null;
    if (older && sortedByNew) {
      reachedOld = true;
      ctx.log('info', what + ': reached items older than ' + new Date(since * 1000).toISOString().replace('.000Z', 'Z') + ', which an earlier job already covered; stopping.');
      break;
    }
    if (!after || data.children.length === 0) {
      ctx.log('info', after ? 'Reddit returned an empty page; stopping.' : 'Reached the end of the listing.');
      break;
    }
    if (cp) { cp.after = after; cp.pages = pages; cp.seen = seen; saveCheckpoint(ctx, cp); }
  }
  if (!reachedOld) {
    if (pages >= options.maxPages && after) ctx.log('info', what + ': stopped at the page limit (' + options.maxPages + ').');
    else if (left() <= 0 && after) ctx.log('info', 'Stopped at the item limit (' + options.maxItems + ').');
  }
  return shared.posts;
}

// The listing is done: the checkpoint moves on to `next` (cursor reset).
function listingDone(ctx, cp, next) {
  if (!cp) return;
  Object.assign(cp, { after: null, pages: 0, seen: 0 }, next);
  saveCheckpoint(ctx, cp);
}

// Reddit serves at most ~1,000 items per listing. Other sorts of the same
// subreddit surface different posts, so the sweep pages through each in turn
// (the chosen sort first) until maxItems unique posts are collected.
// maxPages applies to each sort.
const SWEEP_SORTS = [['new'], ['hot'], ['top', 'all'], ['top', 'year'], ['top', 'month'], ['top', 'week'],
  ['controversial', 'all'], ['controversial', 'year'], ['rising']];

async function sweepSubreddit(ctx, options, target, shared, cp) {
  shared = shared || newShared();
  const order = [[target.sort, target.time]].concat(SWEEP_SORTS.filter(([s, t]) => !(s === target.sort && (t || undefined) === (target.time || undefined))));
  ctx.log('info', 'Combining sorts to get past Reddit\'s ~1,000-item listing limit (up to ' + options.maxPages + ' page(s) per sort).');
  for (let i = cp ? cp.sort : 0; i < order.length; i++) {
    const [sort, time] = order[i];
    if (shared.collected >= options.maxItems || ctx.remaining() <= 0) break;
    const before = shared.collected;
    const label = 'r/' + target.subreddit + '/' + sort + (time ? ' (' + time + ')' : '');
    await paginate(ctx, options, '/r/' + target.subreddit + '/' + sort, { t: time }, label, shared, cp, sort === 'new');
    ctx.log('info', label + ': ' + (shared.collected - before) + ' new post(s), ' + shared.collected + ' unique so far.');
    listingDone(ctx, cp, { sort: i + 1 });
  }
  return shared.posts;
}

// Comments Reddit collapsed behind "load more" links, via the API's
// /api/morechildren (up to 100 ids per request), until commentLimit comments.
const MAX_MORE_CALLS = 20;

async function expandMoreComments(ctx, options, post, comments, moreIds, sort) {
  if (!moreIds.length) return [];
  if (ctx.http.mode !== 'oauth') {
    ctx.log('info', ctx.http.mode === 'redditapis'
      ? 'Loading collapsed comments isn\'t offered through RedditAPIs.com; skipped.'
      : 'Loading collapsed comments needs Reddit API access (Scraper page → Reddit API access); skipped.');
    return [];
  }
  const have = new Set(comments.map(c => c.comment_id));
  const queue = moreIds.filter(id => !have.has(id));
  const added = [];
  const extra = { post_id: post.post_id, post_title: post.title, post_permalink: post.permalink };
  let calls = 0;
  try {
    while (queue.length && comments.length + added.length < options.commentLimit && calls < MAX_MORE_CALLS) {
      const batch = queue.splice(0, 100);
      const { json } = await ctx.http.getJson('/api/morechildren', Object.assign({}, ctx.requestOpts, {
        query: { api_type: 'json', link_id: 't3_' + post.post_id, children: batch.join(','), sort, limit_children: 'false', depth: options.commentDepth },
        context: 'Collapsed comments'
      }));
      calls++;
      const things = json && json.json && json.json.data && Array.isArray(json.json.data.things) ? json.json.data.things : null;
      if (!things) throw new ScraperError('parse_error', 'Reddit\'s answer for collapsed comments wasn\'t readable.', { status: 502 });
      for (const t of things) {
        if (!t || !t.data) continue;
        if (t.kind === 'more') {
          (Array.isArray(t.data.children) ? t.data.children : []).forEach(id => { if (typeof id === 'string' && !have.has(id)) queue.push(id); });
          continue;
        }
        if (t.kind !== 't1') continue;
        const c = F.normalizeComment(t.data, extra);
        if (!c.comment_id || have.has(c.comment_id)) continue;
        have.add(c.comment_id);
        added.push(c);
        if (comments.length + added.length >= options.commentLimit) break;
      }
    }
  } catch (err) {
    if (isScraperError(err) && err.type === 'cancelled') throw err;
    ctx.log('warn', 'Loading collapsed comments of post ' + post.post_id + ' stopped: ' + (err.message || 'unknown error'));
  }
  ctx.log('info', 'Loaded ' + added.length + ' collapsed comment(s) for post ' + post.post_id + '.');
  return added;
}

async function fetchPostWithComments(ctx, options, postId, extra) {
  const query = { limit: options.commentLimit, depth: options.commentDepth, sort: extra.commentSort || 'confidence' };
  if (extra.focusCommentId) query.comment = extra.focusCommentId;
  const { json } = await ctx.http.getJson('/comments/' + postId, Object.assign({}, ctx.requestOpts, { query, context: 'That post' }));
  if (!Array.isArray(json) || json.length < 2) {
    throw new ScraperError('parse_error', 'Reddit\'s answer for post ' + postId + ' wasn\'t the expected post + comments pair.', { status: 502 });
  }
  const postListing = readListing(json[0], 'post ' + postId);
  const postThing = postListing.children.find(c => c && c.kind === 't3');
  if (!postThing) throw new ScraperError('not_found', 'Post ' + postId + ' wasn\'t found.', { status: 404 });
  const post = F.normalizePost(postThing.data);
  const commentData = readListing(json[1], 'the comments of post ' + postId);
  const flat = F.flattenComments(commentData.children, { post_id: post.post_id, post_title: post.title, post_permalink: post.permalink }, options.commentLimit);
  let comments = flat.comments;
  let expanded = 0;
  if (options.expandMore && flat.moreIds.length && comments.length < options.commentLimit) {
    const more = await expandMoreComments(ctx, options, post, comments, flat.moreIds, query.sort);
    expanded = more.length;
    comments = comments.concat(more);
  }
  return { post, comments, moreCount: Math.max(0, flat.moreCount - expanded) };
}

async function addMetadata(ctx, key, path, normalize) {
  try {
    const { json } = await ctx.http.getJson(path, Object.assign({}, ctx.requestOpts, { context: 'Metadata' }));
    if (json && json.data) ctx.setMeta(key, normalize(json.data));
  } catch (err) {
    if (isScraperError(err) && err.type === 'cancelled') throw err;
    ctx.log('warn', 'Couldn\'t load ' + key + ' metadata: ' + (err.message || 'unknown error'));
  }
}

// A listing target (subreddit, front page / listing, search, user): the
// listing, then optionally comment threads, each step checkpointed.
async function runListing(ctx, options, cp, shared, listing) {
  if (cp.phase === 'listing') {
    const posts = await listing(shared);
    shared.posts = posts;
    listingDone(ctx, cp, { phase: options.includeComments ? 'comments' : 'done' });
  }
  if (cp.phase === 'comments') {
    await addComments(ctx, options, shared.posts, cp);
    listingDone(ctx, cp, { phase: 'done' });
  }
}

async function runStandardScrape(target, options, ctx) {
  const resume = ctx.resumeFrom && ctx.resumeFrom.v === 1 ? ctx.resumeFrom : null;
  const cp = Object.assign(newCheckpoint(), resume || {});
  const shared = resume ? sharedFromCommitted(ctx) : newShared();
  if (resume) {
    ctx.log('info', 'Continuing from the checkpoint (' + (cp.phase === 'comments' ? 'comment threads, ' + cp.commentsDone + ' done' : cp.phase === 'done' ? 'all steps done' : 'listing, ' + cp.pages + ' page(s) read') + '; ' + shared.collected + ' item(s) already collected).');
  } else {
    ctx.log('info', 'Target: ' + target.label);
  }
  ctx.log('info', 'Mode: ' + (ctx.http.label || (ctx.http.mode === 'oauth' ? 'Reddit Data API (OAuth)' : 'public Reddit pages')) +
    '; at least ' + (ctx.requestOpts.delayMs / 1000) + ' s between requests.');
  if (options.since) ctx.log('info', 'Only items posted after ' + new Date(options.since * 1000).toISOString().replace('.000Z', 'Z') + ' are collected.');
  if (cp.phase === 'done') return;

  switch (target.type) {
    case 'subreddit': {
      if (!resume && options.includeMetadata && !target.subreddit.includes('+') && !['all', 'popular'].includes(target.subreddit.toLowerCase())) {
        await addMetadata(ctx, 'subreddit', '/r/' + target.subreddit + '/about', F.normalizeSubreddit);
      }
      return runListing(ctx, options, cp, shared, sh => (options.sweepSorts
        ? sweepSubreddit(ctx, options, target, sh, cp)
        : paginate(ctx, options, target.path, { t: target.time }, 'r/' + target.subreddit, sh, cp, target.sort === 'new')));
    }
    case 'listing': {
      return runListing(ctx, options, cp, shared, sh => paginate(ctx, options, target.path, { t: target.time }, target.label, sh, cp, target.sort === 'new'));
    }
    case 'search': {
      const query = { q: target.query, sort: target.sort, t: target.time, type: 'link' };
      if (target.subreddit) query.restrict_sr = target.restrictSr ? 'on' : undefined;
      return runListing(ctx, options, cp, shared, sh => paginate(ctx, options, target.path, query, 'This search', sh, cp, target.sort === 'new'));
    }
    case 'user': {
      if (!resume && options.includeMetadata) await addMetadata(ctx, 'user', '/user/' + target.username + '/about', F.normalizeUser);
      return runListing(ctx, options, cp, shared, sh => paginate(ctx, options, target.path, { sort: target.sort, t: target.time }, 'u/' + target.username, sh, cp, target.sort === 'new'));
    }
    case 'post': {
      const res = await fetchPostWithComments(ctx, options, target.postId, target);
      ctx.emit([res.post]);
      ctx.emit(res.comments);
      ctx.progress({ pagesFetched: 1, message: 'Post and ' + res.comments.length + ' comments' });
      if (res.moreCount) {
        ctx.log('info', res.moreCount + ' more comment(s) are collapsed behind "load more" links on Reddit and weren\'t fetched' +
          (options.expandMore ? ' (comment limit reached, or Reddit API access is needed).' : ' — turn on "Load collapsed comments" to fetch them.'));
      }
      return;
    }
    case 'subreddit_about': {
      const { json } = await ctx.http.getJson(target.path, Object.assign({}, ctx.requestOpts, { context: 'r/' + target.subreddit }));
      if (!json || json.kind !== 't5' || !json.data) throw new ScraperError('not_found', 'r/' + target.subreddit + ' wasn\'t found.', { status: 404 });
      ctx.emit([F.normalizeSubreddit(json.data)]);
      ctx.progress({ pagesFetched: 1, message: 'Subreddit info loaded' });
      return;
    }
    case 'user_about': {
      const { json } = await ctx.http.getJson(target.path, Object.assign({}, ctx.requestOpts, { context: 'u/' + target.username }));
      if (!json || json.kind !== 't2' || !json.data) throw new ScraperError('not_found', 'u/' + target.username + ' wasn\'t found.', { status: 404 });
      ctx.emit([F.normalizeUser(json.data)]);
      ctx.progress({ pagesFetched: 1, message: 'Profile info loaded' });
      return;
    }
    default:
      throw new ScraperError('invalid_target', 'Unsupported target type.', { status: 400 });
  }
}

// Optional: the comments of the first N posts of a listing (one request each).
// A failure that should stop (and let the job wait or pause), not just skip one thread.
const STOPS_COMMENTS = new Set(['cancelled', 'network_unavailable', 'network_misconfigured', 'rate_limited', 'auth_error', 'reddit_blocked']);

async function addComments(ctx, options, posts, cp) {
  const list = posts.filter(p => p.post_id).slice(0, options.commentPosts);
  if (!list.length) return;
  const start = cp ? Math.min(cp.commentsDone || 0, list.length) : 0;
  ctx.log('info', 'Fetching comments for ' + (list.length - start) + ' post(s)…');
  let done = start;
  for (const p of list.slice(start)) {
    if (ctx.remaining() <= 0) { ctx.log('info', 'Item limit reached; skipping remaining comment threads.'); break; }
    try {
      const res = await fetchPostWithComments(ctx, options, p.post_id, {});
      ctx.emit(res.comments);
    } catch (err) {
      if (isScraperError(err) && STOPS_COMMENTS.has(err.type)) throw err;
      ctx.log('warn', 'Comments for post ' + p.post_id + ' failed: ' + (err.message || 'unknown error'));
      ctx.progress({ errorsDelta: 1 });
    }
    done++;
    if (cp) { cp.commentsDone = done; saveCheckpoint(ctx, cp); }
    ctx.progress({ message: 'Comments: ' + done + ' of ' + list.length + ' posts' });
  }
}

module.exports = { runStandardScrape, fetchPostWithComments, readListing };
