// ── Scrape targets ────────────────────────────────────────────────────────────
// Turns what the user entered (a target type plus fields, or any Reddit URL)
// into a normalized, validated target, and validates the job options against
// the server's limits. Nothing here touches the network.

const { ScraperError } = require('../errors');

const LISTING_SORTS  = ['hot', 'new', 'top', 'rising', 'controversial'];
const FRONT_SORTS    = ['best', 'hot', 'new', 'top', 'rising', 'controversial'];
const SEARCH_SORTS   = ['relevance', 'hot', 'top', 'new', 'comments'];
const USER_SORTS     = ['new', 'hot', 'top', 'controversial'];
const USER_SECTIONS  = ['overview', 'submitted', 'comments'];
const COMMENT_SORTS  = ['confidence', 'top', 'new', 'controversial', 'old', 'qa'];
const TIME_RANGES    = ['hour', 'day', 'week', 'month', 'year', 'all'];
const TARGET_TYPES   = ['subreddit', 'search', 'post', 'user', 'listing', 'subreddit_about', 'user_about', 'url'];

const SUBREDDIT_RE = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;
const USERNAME_RE  = /^[A-Za-z0-9_-]{3,20}$/;
const POST_ID_RE   = /^[a-z0-9]{3,12}$/i;
const DOMAIN_RE    = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

function invalid(message) {
  return new ScraperError('invalid_target', message, { status: 400 });
}

function clean(s) { return typeof s === 'string' ? s.trim() : ''; }

function normalizeSubredditName(raw) {
  let s = clean(raw).replace(/^\/?r\//i, '').replace(/\/+$/, '');
  if (!s) throw invalid('Enter a subreddit name, e.g. "AskScience".');
  const parts = s.split('+');
  if (parts.length > 25) throw invalid('Combine at most 25 subreddits with "+".');
  parts.forEach(p => {
    if (!SUBREDDIT_RE.test(p)) {
      throw invalid('"' + p.slice(0, 40) + '" isn\'t a valid subreddit name (2–21 letters, digits or underscores, not starting with "_").');
    }
  });
  return parts.join('+');
}

function normalizeUsername(raw) {
  const s = clean(raw).replace(/^\/?(u|user)\//i, '').replace(/^@/, '').replace(/\/+$/, '');
  if (!USERNAME_RE.test(s)) throw invalid('"' + s.slice(0, 40) + '" isn\'t a valid Reddit username (3–20 letters, digits, "_" or "-").');
  return s;
}

function pick(value, allowed, fallback, label) {
  const v = clean(value).toLowerCase();
  if (!v) return fallback;
  if (!allowed.includes(v)) throw invalid('Unknown ' + label + ' "' + v.slice(0, 30) + '". Use one of: ' + allowed.join(', ') + '.');
  return v;
}

const REDDIT_HOST_RE = /^(?:(?:www|old|new|np|m|i|amp|sh)\.)?reddit\.com$/i;

// Any Reddit URL → target fields. Throws an invalid_target error with a
// specific message for anything that isn't a supported page.
function parseRedditUrl(raw) {
  let text = clean(raw);
  if (!text) throw invalid('Enter a Reddit URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text.replace(/^\/+/, '');
  let url;
  try { url = new URL(text); } catch (e) { throw invalid('That isn\'t a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('Only http(s) Reddit URLs are supported.');
  const host = url.hostname.toLowerCase();

  if (host === 'redd.it' || host === 'www.redd.it') {
    const id = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!POST_ID_RE.test(id)) throw invalid('That redd.it link doesn\'t contain a post id.');
    return { type: 'post', postId: id.toLowerCase() };
  }
  if (!REDDIT_HOST_RE.test(host)) throw invalid('"' + host.slice(0, 60) + '" isn\'t a Reddit address. Use a reddit.com or redd.it URL.');

  const seg = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  const q = url.searchParams;
  const lower = seg.map(s => s.toLowerCase());

  // /comments/<id>[/slug[/commentId]]  and  /r/<sub>/comments/<id>/...
  const ci = lower.indexOf('comments');
  if (ci !== -1 && (ci === 0 || (lower[0] === 'r' && ci === 2) || ((lower[0] === 'user' || lower[0] === 'u') && ci === 2))) {
    const id = seg[ci + 1];
    if (!id || !POST_ID_RE.test(id)) throw invalid('That post URL doesn\'t contain a valid post id.');
    const t = { type: 'post', postId: id.toLowerCase() };
    if (lower[0] === 'r') t.subreddit = normalizeSubredditName(seg[1]);
    if (seg[ci + 3] && POST_ID_RE.test(seg[ci + 3])) t.focusCommentId = seg[ci + 3].toLowerCase();
    return t;
  }
  if (lower[0] === 'r' && lower[2] === 's') {
    throw invalid('Reddit share links (/r/…/s/…) can\'t be resolved by the scraper. Open the link in a browser and paste the full post URL.');
  }
  if (lower[0] === 'r') {
    const sub = normalizeSubredditName(seg[1] || '');
    if (lower[2] === 'search') {
      return { type: 'search', subreddit: sub, query: q.get('q') || '', sort: q.get('sort') || undefined, time: q.get('t') || undefined, restrictSr: q.get('restrict_sr') !== '0' && q.get('restrict_sr') !== 'off' };
    }
    if (lower[2] === 'about') return { type: 'subreddit_about', subreddit: sub };
    if (!lower[2] || LISTING_SORTS.includes(lower[2])) {
      return { type: 'subreddit', subreddit: sub, sort: lower[2] || 'hot', time: q.get('t') || undefined };
    }
    throw invalid('The scraper doesn\'t support "/r/' + sub + '/' + seg[2].slice(0, 30) + '" pages. Use the subreddit, a post, or search.');
  }
  if (lower[0] === 'user' || lower[0] === 'u') {
    const name = normalizeUsername(seg[1] || '');
    if (lower[2] === 'about') return { type: 'user_about', username: name };
    let section = lower[2] || 'overview';
    if (section === 'posts') section = 'submitted';
    if (!USER_SECTIONS.includes(section)) throw invalid('Supported profile pages are overview, submitted (posts) and comments.');
    return { type: 'user', username: name, section, sort: q.get('sort') || undefined, time: q.get('t') || undefined };
  }
  if (lower[0] === 'search') {
    return { type: 'search', query: q.get('q') || '', sort: q.get('sort') || undefined, time: q.get('t') || undefined };
  }
  if (lower[0] === 'domain') {
    const d = clean(seg[1] || '');
    if (!DOMAIN_RE.test(d)) throw invalid('That domain listing URL doesn\'t contain a valid domain.');
    return { type: 'listing', domain: d.toLowerCase(), sort: lower[2] || 'hot', time: q.get('t') || undefined };
  }
  if (seg.length === 0 || (seg.length === 1 && FRONT_SORTS.includes(lower[0]))) {
    return { type: 'listing', sort: lower[0] || 'hot', time: q.get('t') || undefined };
  }
  throw invalid('This Reddit URL isn\'t a supported page. Supported: subreddits, posts (with comments), user profiles, search, front page and domain listings.');
}

// User input → normalized target with the API path and a human label.
function normalizeTarget(input) {
  if (!input || typeof input !== 'object') throw invalid('Choose what to scrape.');
  const type = clean(input.type).toLowerCase();
  if (!TARGET_TYPES.includes(type)) throw invalid('Unknown target type. Use one of: ' + TARGET_TYPES.join(', ') + '.');

  let t;
  if (type === 'url') {
    t = Object.assign(parseRedditUrl(input.url), {});
    // Fields given alongside a URL (e.g. sort chosen in the form) win when the URL has none.
    ['sort', 'time', 'commentSort'].forEach(k => { if (t[k] === undefined && input[k]) t[k] = input[k]; });
  } else if (type === 'post') {
    const raw = clean(input.postId || input.url);
    if (!raw) throw invalid('Enter a post URL or id.');
    t = POST_ID_RE.test(raw.replace(/^t3_/i, '')) && !/[/.]/.test(raw)
      ? { type: 'post', postId: raw.replace(/^t3_/i, '').toLowerCase() }
      : parseRedditUrl(raw);
    if (t.type !== 'post') throw invalid('That URL isn\'t a Reddit post.');
  } else {
    t = Object.assign({}, input, { type });
  }
  return finalize(t, input);
}

function finalize(t, input) {
  const out = { type: t.type };
  switch (t.type) {
    case 'subreddit': {
      out.subreddit = normalizeSubredditName(t.subreddit);
      out.sort = pick(t.sort, LISTING_SORTS, 'hot', 'sort');
      if (out.sort === 'top' || out.sort === 'controversial') out.time = pick(t.time, TIME_RANGES, 'day', 'time range');
      out.path = '/r/' + out.subreddit + '/' + out.sort;
      out.label = 'r/' + out.subreddit + ' · ' + out.sort + (out.time ? ' (' + out.time + ')' : '');
      break;
    }
    case 'search': {
      const query = clean(t.query);
      if (!query) throw invalid('Enter a search query.');
      if (query.length > 512) throw invalid('The search query is too long (512 characters at most).');
      out.query = query;
      out.sort = pick(t.sort, SEARCH_SORTS, 'relevance', 'sort');
      out.time = pick(t.time, TIME_RANGES, 'all', 'time range');
      if (clean(t.subreddit)) {
        out.subreddit = normalizeSubredditName(t.subreddit);
        out.restrictSr = t.restrictSr !== false;
        out.path = '/r/' + out.subreddit + '/search';
      } else {
        out.path = '/search';
      }
      out.label = 'Search "' + query.slice(0, 60) + '"' + (out.subreddit ? ' in r/' + out.subreddit : '') + ' · ' + out.sort;
      break;
    }
    case 'post': {
      const id = clean(t.postId).replace(/^t3_/i, '').toLowerCase();
      if (!POST_ID_RE.test(id)) throw invalid('That isn\'t a valid Reddit post id.');
      out.postId = id;
      if (t.subreddit) out.subreddit = normalizeSubredditName(t.subreddit);
      if (t.focusCommentId) out.focusCommentId = t.focusCommentId;
      out.commentSort = pick(t.commentSort || (input && input.commentSort), COMMENT_SORTS, 'confidence', 'comment sort');
      out.path = '/comments/' + id;
      out.label = 'Post ' + id + (out.subreddit ? ' in r/' + out.subreddit : '') + ' with comments';
      break;
    }
    case 'user': {
      out.username = normalizeUsername(t.username);
      out.section = pick(t.section, USER_SECTIONS, 'overview', 'profile section');
      out.sort = pick(t.sort, USER_SORTS, 'new', 'sort');
      if (out.sort === 'top' || out.sort === 'controversial') out.time = pick(t.time, TIME_RANGES, 'all', 'time range');
      out.path = '/user/' + out.username + '/' + out.section;
      out.label = 'u/' + out.username + ' · ' + out.section + ' · ' + out.sort;
      break;
    }
    case 'listing': {
      out.sort = pick(t.sort, FRONT_SORTS, 'hot', 'sort');
      if (out.sort === 'top' || out.sort === 'controversial') out.time = pick(t.time, TIME_RANGES, 'day', 'time range');
      if (t.domain) {
        if (!DOMAIN_RE.test(clean(t.domain))) throw invalid('That isn\'t a valid domain.');
        out.domain = clean(t.domain).toLowerCase();
        if (out.sort === 'best') out.sort = 'hot';
        out.path = '/domain/' + out.domain + '/' + out.sort;
        out.label = 'Links to ' + out.domain + ' · ' + out.sort;
      } else {
        out.path = '/' + out.sort;
        out.label = 'Front page · ' + out.sort;
      }
      break;
    }
    case 'subreddit_about': {
      out.subreddit = normalizeSubredditName(t.subreddit);
      if (out.subreddit.includes('+')) throw invalid('Subreddit info works for one subreddit at a time.');
      out.path = '/r/' + out.subreddit + '/about';
      out.label = 'r/' + out.subreddit + ' · info';
      break;
    }
    case 'user_about': {
      out.username = normalizeUsername(t.username);
      out.path = '/user/' + out.username + '/about';
      out.label = 'u/' + out.username + ' · profile info';
      break;
    }
    default:
      throw invalid('Unsupported target.');
  }
  return out;
}

function clampInt(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ScraperError('invalid_options', label + ' must be a number.', { status: 400 });
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Job options, clamped to the server's limits (the server always wins).
function normalizeOptions(input, config) {
  const o = input && typeof input === 'object' ? input : {};
  const floor = config.oauth ? config.minDelayMs : Math.max(config.minDelayMs, config.publicMinDelayMs);
  return {
    maxItems:       clampInt(o.maxItems, 1, config.maxItems, Math.min(100, config.maxItems), 'Maximum items'),
    maxPages:       clampInt(o.maxPages, 1, config.maxPages, Math.min(5, config.maxPages), 'Maximum pages'),
    delayMs:        clampInt(o.delayMs, floor, 120000, Math.max(floor, config.defaultDelayMs), 'Delay between requests'),
    timeoutMs:      clampInt(o.timeoutMs, 1000, config.requestTimeoutMs, config.requestTimeoutMs, 'Request timeout'),
    concurrency:    clampInt(o.concurrency, 1, config.maxConcurrentRequests, 1, 'Concurrent requests'),
    retries:        clampInt(o.retries, 0, 5, 2, 'Retries'),
    includeComments: o.includeComments === true,
    commentPosts:   clampInt(o.commentPosts, 1, 100, 10, 'Posts to fetch comments for'),
    commentLimit:   clampInt(o.commentLimit, 1, 500, 100, 'Comments per post'),
    commentDepth:   clampInt(o.commentDepth, 1, 10, 5, 'Comment depth'),
    includeMetadata: o.includeMetadata !== false
  };
}

module.exports = {
  parseRedditUrl, normalizeTarget, normalizeOptions, normalizeSubredditName, normalizeUsername,
  LISTING_SORTS, FRONT_SORTS, SEARCH_SORTS, USER_SORTS, USER_SECTIONS, COMMENT_SORTS, TIME_RANGES, TARGET_TYPES
};
