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
async function paginate(ctx, options, path, query, what) {
  let after = null;
  let pages = 0;
  let seen = 0;
  let collected = 0;
  const posts = [];
  const left = () => Math.min(options.maxItems - collected, ctx.remaining());
  while (pages < options.maxPages && left() > 0) {
    const limit = Math.min(100, left());
    const q = Object.assign({}, query, { limit, after, count: seen || undefined });
    const { json } = await ctx.http.getJson(path, Object.assign({}, ctx.requestOpts, { query: q, context: what }));
    pages++;
    const data = readListing(json, what);
    const records = data.children.map(c => F.normalizeThing(c)).filter(Boolean).slice(0, left());
    seen += data.children.length;
    collected += records.length;
    records.forEach(r => { if (r.record_type === 'post') posts.push(r); });
    ctx.emit(records);
    ctx.progress({ pagesFetched: pages, message: 'Page ' + pages + ': ' + records.length + ' item' + (records.length === 1 ? '' : 's') });
    after = typeof data.after === 'string' && data.after ? data.after : null;
    if (!after || data.children.length === 0) {
      ctx.log('info', after ? 'Reddit returned an empty page; stopping.' : 'Reached the end of the listing.');
      break;
    }
  }
  if (pages >= options.maxPages && after) ctx.log('info', 'Stopped at the page limit (' + options.maxPages + ').');
  else if (left() <= 0 && after) ctx.log('info', 'Stopped at the item limit (' + options.maxItems + ').');
  return posts;
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
  return { post, comments: flat.comments, moreCount: flat.moreCount };
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

async function runStandardScrape(target, options, ctx) {
  ctx.log('info', 'Target: ' + target.label);
  ctx.log('info', 'Mode: ' + (ctx.http.label || (ctx.http.mode === 'oauth' ? 'Reddit Data API (OAuth)' : 'public Reddit pages')) +
    '; at least ' + (ctx.requestOpts.delayMs / 1000) + ' s between requests.');

  switch (target.type) {
    case 'subreddit': {
      if (options.includeMetadata && !target.subreddit.includes('+') && !['all', 'popular'].includes(target.subreddit.toLowerCase())) {
        await addMetadata(ctx, 'subreddit', '/r/' + target.subreddit + '/about', F.normalizeSubreddit);
      }
      const posts = await paginate(ctx, options, target.path, { t: target.time }, 'r/' + target.subreddit);
      if (options.includeComments) await addComments(ctx, options, posts);
      return;
    }
    case 'listing': {
      const posts = await paginate(ctx, options, target.path, { t: target.time }, target.label);
      if (options.includeComments) await addComments(ctx, options, posts);
      return;
    }
    case 'search': {
      const query = { q: target.query, sort: target.sort, t: target.time, type: 'link' };
      if (target.subreddit) query.restrict_sr = target.restrictSr ? 'on' : undefined;
      const posts = await paginate(ctx, options, target.path, query, 'This search');
      if (options.includeComments) await addComments(ctx, options, posts);
      return;
    }
    case 'user': {
      if (options.includeMetadata) await addMetadata(ctx, 'user', '/user/' + target.username + '/about', F.normalizeUser);
      const posts = await paginate(ctx, options, target.path, { sort: target.sort, t: target.time }, 'u/' + target.username);
      if (options.includeComments) await addComments(ctx, options, posts);
      return;
    }
    case 'post': {
      const res = await fetchPostWithComments(ctx, options, target.postId, target);
      ctx.emit([res.post]);
      ctx.emit(res.comments);
      ctx.progress({ pagesFetched: 1, message: 'Post and ' + res.comments.length + ' comments' });
      if (res.moreCount) ctx.log('info', res.moreCount + ' more comment(s) are collapsed behind "load more" links on Reddit and weren\'t fetched.');
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
async function addComments(ctx, options, posts) {
  const list = posts.filter(p => p.post_id).slice(0, options.commentPosts);
  if (!list.length) return;
  ctx.log('info', 'Fetching comments for ' + list.length + ' post(s)…');
  let done = 0;
  for (const p of list) {
    if (ctx.remaining() <= 0) { ctx.log('info', 'Item limit reached; skipping remaining comment threads.'); break; }
    try {
      const res = await fetchPostWithComments(ctx, options, p.post_id, {});
      ctx.emit(res.comments);
    } catch (err) {
      if (isScraperError(err) && err.type === 'cancelled') throw err;
      ctx.log('warn', 'Comments for post ' + p.post_id + ' failed: ' + (err.message || 'unknown error'));
      ctx.progress({ errorsDelta: 1 });
    }
    done++;
    ctx.progress({ message: 'Comments: ' + done + ' of ' + list.length + ' posts' });
  }
}

module.exports = { runStandardScrape };
