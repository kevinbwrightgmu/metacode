// ── Reddit addresses ──────────────────────────────────────────────────────────
// Which pages the collector may open, how listing/search/post addresses are
// built, and how Reddit permalinks are read. The MetaCode server's Wisp
// endpoint enforces the real host allow-list; these checks keep the bot (and
// anyone using the visible browser) on public Reddit pages and give clear
// messages instead of failed loads.

import type { ListingSort, TopTime } from '../types';

export const CANONICAL_ORIGIN = 'https://www.reddit.com';
const REDDIT_HOST = /^(?:[a-z0-9-]+\.)*(?:reddit\.com|redd\.it)$/i;

/** Login, account, messaging and moderation pages are never opened. */
const PRIVATE_PATH = /^\/(?:login|register|account|password|settings|prefs|message|messages|chat|notifications|submit|mod|report|logout)(?:[/?#]|$)|^\/user\/[^/]+\/(?:saved|upvoted|downvoted|hidden)(?:[/?#]|$)|^\/r\/[^/]+\/about\/(?:modqueue|reports|spam|edited|unmoderated|banned|muted|contributors|moderators\/edit)(?:[/?#]|$)/i;

const SUBREDDIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;

export function isRedditHost(hostname: string): boolean {
  return REDDIT_HOST.test(hostname);
}

/** "r/Technology", "/r/technology/", "technology" → "technology"-as-typed; null when not a valid name. */
export function cleanSubreddit(input: string): string | null {
  const name = String(input || '').trim().replace(/^\/?r\//i, '').replace(/\/+$/, '');
  return SUBREDDIT_NAME.test(name) ? name : null;
}

/** http/https URLs only (anything else, e.g. javascript:, becomes null). */
export function safeHttpUrl(value: string | null | undefined, base?: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export interface Site {
  /** Where the bot opens pages, e.g. https://www.reddit.com */
  base: URL;
  /** Extra hosts the MetaCode server allows (a test mirror). */
  extraHosts: string[];
}

/**
 * Checks the configured Reddit address: a reddit.com host over https, or a
 * host the MetaCode server allows (from /api/scraper/status). Throws with a
 * readable message otherwise.
 */
export function parseRedditBase(input: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(String(input || '').trim() || CANONICAL_ORIGIN);
  } catch {
    throw new Error('The Reddit address isn\'t a valid URL.');
  }
  if (isRedditHost(url.hostname)) {
    if (url.protocol !== 'https:') throw new Error('Reddit addresses must use https://.');
  } else if (!allowedHosts.map(h => h.toLowerCase()).includes(url.hostname.toLowerCase())) {
    throw new Error('Only Reddit addresses (or a mirror the MetaCode server allows) can be used.');
  } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The Reddit address must use http:// or https://.');
  }
  return new URL(url.origin + '/');
}

/** Why `url` may not be opened, or null when it may. */
export function navigationProblem(url: URL, site: Site): string | null {
  const host = url.hostname.toLowerCase();
  const allowedHost = isRedditHost(host) || host === site.base.hostname.toLowerCase() || site.extraHosts.includes(host);
  if (!allowedHost) return 'Only Reddit pages can be opened here.';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isRedditHost(host))) return 'Reddit pages are opened over https only.';
  if (PRIVATE_PATH.test(url.pathname)) return 'Login, account, message and moderation pages aren\'t opened by the collector.';
  return null;
}

/** Accepts "r/foo", "reddit.com/…", a path or a full URL; returns a URL on the configured site or throws. */
export function resolveBrowserInput(input: string, site: Site): URL {
  let text = String(input || '').trim();
  if (!text) return new URL('/', site.base);
  if (/^\/?(?:r|u|user)\//i.test(text)) text = new URL(text.replace(/^\/?/, '/'), site.base).href;
  else if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('That isn\'t a valid address.'); }
  // Any reddit.com page opens on the configured Reddit address (e.g. old.reddit.com, or a test mirror)
  if (isRedditHost(url.hostname) && !isRedditHost(site.base.hostname)) url = new URL(url.pathname + url.search, site.base);
  const problem = navigationProblem(url, site);
  if (problem) throw new Error(problem);
  return url;
}

export function isOldReddit(base: URL): boolean {
  return /^old\./i.test(base.hostname);
}

export function subredditListingUrl(base: URL, subreddit: string, sort: ListingSort, time: TopTime): string {
  const u = new URL('/r/' + encodeURIComponent(subreddit) + '/' + sort + '/', base);
  if (sort === 'top') u.searchParams.set('t', time);
  return u.href;
}

export function searchUrl(base: URL, query: string, subreddit: string | null, sort: ListingSort, time: TopTime): string {
  const old = isOldReddit(base);
  const path = subreddit ? '/r/' + encodeURIComponent(subreddit) + '/search' + (old ? '' : '/') : (old ? '/search' : '/search/');
  const u = new URL(path, base);
  u.searchParams.set('q', query);
  if (subreddit) u.searchParams.set('restrict_sr', old ? 'on' : '1');
  if (!old) u.searchParams.set('type', 'link');
  if (sort === 'new' || sort === 'top') u.searchParams.set('sort', sort);
  if (sort === 'top') u.searchParams.set('t', time);
  return u.href;
}

export interface Permalink {
  subreddit: string;
  postId: string;
  slug: string | null;
  commentId: string | null;
}

/**
 * Reads a Reddit post or comment permalink:
 * /r/<sub>/comments/<post>/<slug>/[<comment>/] and /r/<sub>/comments/<post>/comment/<comment>/.
 */
export function parsePermalink(href: string | null | undefined, base?: string): Permalink | null {
  if (!href) return null;
  let url: URL;
  try { url = new URL(href, base || CANONICAL_ORIGIN); } catch { return null; }
  const m = /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{1,12})(?:\/([^/?#]*))?(?:\/([a-z0-9]{1,12}))?\/?$/i.exec(url.pathname);
  if (!m) return null;
  const slug = m[3] || null;
  const commentId = m[4] ? m[4].toLowerCase() : null;
  return {
    subreddit: m[1],
    postId: m[2].toLowerCase(),
    slug: slug === 'comment' ? null : slug,
    commentId
  };
}

/** The canonical address of a post, always on www.reddit.com. */
export function canonicalPostUrl(subreddit: string, postId: string, slug?: string | null): string {
  return CANONICAL_ORIGIN + '/r/' + subreddit + '/comments/' + postId + '/' + (slug ? slug + '/' : '');
}

export function canonicalCommentUrl(subreddit: string, postId: string, commentId: string): string {
  return CANONICAL_ORIGIN + '/r/' + subreddit + '/comments/' + postId + '/comment/' + commentId + '/';
}

/** Where the bot opens a post: the same path on the configured Reddit address. */
export function postPageUrl(base: URL, canonicalUrl: string): string {
  const u = new URL(canonicalUrl);
  return new URL(u.pathname, base).href;
}

/** Turns an address on a test mirror into the same address on reddit.com (canonical form for records). */
export function toCanonicalHost(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname === 'www.reddit.com') return u.href;
    return CANONICAL_ORIGIN + u.pathname + u.search + u.hash;
  } catch {
    return href;
  }
}

/** Do two addresses show the same page (same host and path, ignoring a trailing slash and Scramjet's "$" parameters)? */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '').toLowerCase();
    return x.host.toLowerCase() === y.host.toLowerCase() && path(x) === path(y);
  } catch {
    return false;
  }
}
