// ── Page parsing ──────────────────────────────────────────────────────────────
// Reads posts and comments out of a Reddit page's DOM. Works on any Document
// — the live page inside the Scramjet frame, or a fixture in tests — and
// never runs page scripts or follows links. Output is "raw": strings and
// numbers exactly as displayed, normalised and validated by normalize.ts.

import { SELECTORS, all, first, own } from './selectors';
import { isRedditHost, parsePermalink, safeHttpUrl } from '../lib/urls';

export type Variant = 'shreddit' | 'old' | 'generic';

export interface RawCount { value: number | null; approximate: boolean }

export interface RawPost {
  id: string | null;
  subreddit: string | null;
  title: string | null;
  body: string | null;
  author: string | null;
  created: string | null;
  score: RawCount;
  numComments: RawCount;
  permalink: string | null;
  linkUrl: string | null;
  postType: string | null;
  domain: string | null;
  flair: string | null;
  over18: boolean | null;
  /** Read from the post's own page (full text and details), not a listing. */
  fromPostPage: boolean;
  variant: Variant;
}

export interface RawComment {
  id: string | null;
  postId: string | null;
  parentId: string | null;
  subreddit: string | null;
  author: string | null;
  body: string | null;
  created: string | null;
  score: RawCount;
  depth: number | null;
  permalink: string | null;
}

export interface ListingExtract {
  variant: Variant;
  posts: RawPost[];
  /** Old Reddit's "next" page, when there is one. */
  nextUrl: string | null;
}

export interface PostPageExtract {
  variant: Variant;
  post: RawPost | null;
  comments: RawComment[];
}

// ── Small readers ─────────────────────────────────────────────────────────────

const BLOCK = new Set(['P', 'DIV', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'TR', 'HR', 'FIGURE', 'SECTION', 'ARTICLE']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'SVG', 'svg', 'IMG']);

/** An element's visible text with paragraphs, line breaks and list items kept; null when empty. */
export function textOf(el: Element | null | undefined): string | null {
  if (!el) return null;
  const out: string[] = [];
  const walk = (node: Node, inPre: boolean) => {
    if (node.nodeType === 3) {
      const t = node.nodeValue || '';
      out.push(inPre ? t : t.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const e = node as Element;
    if (SKIP.has(e.tagName) || e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('hidden')) return;
    if (e.tagName === 'BR') { out.push('\n'); return; }
    const block = BLOCK.has(e.tagName);
    if (block) out.push('\n');
    if (e.tagName === 'LI') out.push('\n- ');
    const pre = inPre || e.tagName === 'PRE';
    e.childNodes.forEach(c => walk(c, pre));
    if (block) out.push('\n');
  };
  walk(el, false);
  const text = out.join('')
    .split('\n').map(l => l.replace(/[ \t]+$/g, '').replace(/^ (?=\S)/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

function attr(el: Element | null | undefined, ...names: string[]): string | null {
  if (!el) return null;
  for (const n of names) {
    const v = el.getAttribute(n);
    if (v !== null && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * A displayed count → number. "1,234" and "1234" are exact; "1.2k" / "3.4m"
 * are rounded displays (approximate). "Vote", "•", "" and the like → null:
 * not shown, which is different from a real 0.
 */
export function parseCount(value: string | null | undefined): RawCount {
  if (value === null || value === undefined) return { value: null, approximate: false };
  const s = String(value).trim().toLowerCase().replace(/\s+(points?|votes?|comments?|upvotes?)$/, '');
  if (/^-?\d{1,3}(?:,\d{3})+$|^-?\d+$/.test(s)) return { value: Number(s.replace(/,/g, '')), approximate: false };
  const m = /^(-?\d+(?:\.\d+)?)\s*([km])$/.exec(s);
  if (m) return { value: Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : 1e6)), approximate: true };
  return { value: null, approximate: false };
}

function stripPrefix(value: string | null, prefix: RegExp): string | null {
  return value ? value.replace(prefix, '') || null : null;
}

/** "t3_abc12" → "abc12". The prefix is required: a bare attribute value could be anything. */
function thingId(value: string | null, kind: 't1' | 't3'): string | null {
  if (!value) return null;
  const m = new RegExp('^' + kind + '_([a-z0-9]{1,12})$', 'i').exec(value.trim());
  return m ? m[1].toLowerCase() : null;
}

/** The creation time inside `root` (its own, when `ownerSelector` is given). */
function timeIn(root: Element, ownerSelector?: string): string | null {
  const el = ownerSelector ? own(root, SELECTORS.shreddit.time, ownerSelector) : first(root, SELECTORS.shreddit.time);
  return attr(el, 'ts', 'datetime');
}

// ── Variant detection ─────────────────────────────────────────────────────────

export function detectVariant(doc: Document): Variant {
  if (first(doc, SELECTORS.shreddit.marker)) return 'shreddit';
  if (first(doc, SELECTORS.old.marker)) return 'old';
  return 'generic';
}

// ── shreddit (www.reddit.com) ─────────────────────────────────────────────────

function shredditPost(el: Element, pageUrl: string, fromPostPage: boolean): RawPost {
  const permalink = attr(el, 'permalink') || attr(first(el, SELECTORS.shreddit.permalinkLink), 'href');
  const link = parsePermalink(permalink, pageUrl);
  const subreddit = stripPrefix(attr(el, 'subreddit-name', 'subreddit-prefixed-name'), /^r\//i) || (link && link.subreddit);
  const contentHref = safeHttpUrl(attr(el, 'content-href'), pageUrl);
  // A text post's "content" is its own comments page: not an outside link.
  const linkUrl = contentHref && !parsePermalink(contentHref) ? contentHref : null;
  const body = first(el, SELECTORS.shreddit.body);
  return {
    id: thingId(attr(el, 'id', 'post-id', 'thingid'), 't3') || (link && link.postId),
    subreddit,
    title: attr(el, 'post-title') || textOf(first(el, SELECTORS.shreddit.title)),
    body: body && body.closest('shreddit-post') === el ? textOf(body) : null,
    author: stripPrefix(attr(el, 'author'), /^u\//i),
    created: attr(el, 'created-timestamp') || timeIn(el),
    score: parseCount(attr(el, 'score')),
    numComments: parseCount(attr(el, 'comment-count')),
    permalink,
    linkUrl,
    postType: attr(el, 'post-type'),
    domain: attr(el, 'domain'),
    flair: textOf(first(el, SELECTORS.shreddit.flair)),
    over18: el.hasAttribute('nsfw') || el.hasAttribute('is-nsfw') || el.getAttribute('over18') === 'true' ? true : null,
    fromPostPage,
    variant: 'shreddit'
  };
}

function shredditComment(el: Element, pageUrl: string, page: RawPost | null): RawComment {
  const permalink = attr(el, 'permalink');
  const link = parsePermalink(permalink, pageUrl);
  const parentAttr = attr(el, 'parentid');
  let parentId: string | null;
  if (parentAttr) parentId = /^t3_/i.test(parentAttr) ? null : thingId(parentAttr, 't1');
  else {
    const parent = el.parentElement && el.parentElement.closest('shreddit-comment');
    parentId = parent ? thingId(attr(parent, 'thingid', 'id'), 't1') : null;
  }
  const depthAttr = attr(el, 'depth');
  let depth = depthAttr !== null && /^\d+$/.test(depthAttr) ? Number(depthAttr) : null;
  if (depth === null) {
    depth = 0;
    for (let p = el.parentElement && el.parentElement.closest('shreddit-comment'); p; p = p.parentElement && p.parentElement.closest('shreddit-comment')) depth++;
  }
  return {
    id: thingId(attr(el, 'thingid', 'comment-id', 'id'), 't1') || (link && link.commentId),
    postId: thingId(attr(el, 'postid'), 't3') || (link && link.postId) || (page && page.id),
    parentId,
    subreddit: (link && link.subreddit) || (page && page.subreddit),
    author: stripPrefix(attr(el, 'author'), /^u\//i),
    body: textOf(own(el, SELECTORS.shreddit.commentBody, 'shreddit-comment')),
    created: attr(own(el, SELECTORS.shreddit.time, 'shreddit-comment'), 'ts', 'datetime') || attr(el, 'created-timestamp'),
    score: parseCount(attr(el, 'score')),
    depth,
    permalink
  };
}

// ── old.reddit.com ────────────────────────────────────────────────────────────

function oldPostType(el: Element, domain: string | null): string | null {
  if (el.getAttribute('data-is-gallery') === 'true') return 'gallery';
  if (attr(el, 'data-crosspost-root-title', 'data-crosspost-root-subreddit')) return 'crosspost';
  if (!domain) return null;
  if (/^self\./i.test(domain)) return 'text';
  if (/^(?:i\.redd\.it|i\.imgur\.com|imgur\.com)$/i.test(domain)) return 'image';
  if (/^v\.redd\.it$/i.test(domain)) return 'video';
  return 'link';
}

function oldPost(el: Element, pageUrl: string, fromPostPage: boolean): RawPost {
  const permalink = attr(el, 'data-permalink') || attr(first(el, ['a.comments', 'a.bylink']), 'href');
  const link = parsePermalink(permalink, pageUrl);
  const domain = attr(el, 'data-domain');
  const target = safeHttpUrl(attr(el, 'data-url'), pageUrl);
  const timestamp = attr(el, 'data-timestamp');
  const nsfw = attr(el, 'data-nsfw');
  const body = fromPostPage ? first(el, SELECTORS.old.body) : null;
  return {
    id: thingId(attr(el, 'data-fullname'), 't3') || (link && link.postId),
    subreddit: attr(el, 'data-subreddit') || (link && link.subreddit),
    title: textOf(first(el, SELECTORS.old.title)),
    body: textOf(body),
    author: attr(el, 'data-author'),
    created: timestamp && /^\d+$/.test(timestamp) ? new Date(Number(timestamp)).toISOString() : attr(first(el, SELECTORS.old.time), 'datetime'),
    score: parseCount(attr(el, 'data-score')),
    numComments: parseCount(attr(el, 'data-comments-count')),
    permalink,
    linkUrl: target && !parsePermalink(target) ? target : null,
    postType: oldPostType(el, domain),
    domain,
    flair: textOf(first(el, SELECTORS.old.flair)),
    over18: nsfw === 'true' ? true : nsfw === 'false' ? false : null,
    fromPostPage,
    variant: 'old'
  };
}

function oldComment(el: Element, pageUrl: string, page: RawPost | null): RawComment {
  const entry = first(el, SELECTORS.old.commentEntry);
  const permalink = attr(el, 'data-permalink');
  const link = parsePermalink(permalink, pageUrl);
  const parent = el.parentElement && el.parentElement.closest('.thing.comment');
  let depth = 0;
  for (let p = parent; p; p = p.parentElement && p.parentElement.closest('.thing.comment')) depth++;
  const scoreEl = entry && first(entry, SELECTORS.old.commentScore);
  // The exact score is in the title attribute; the text may be rounded ("1.2k points")
  const exact = parseCount(attr(scoreEl, 'title'));
  const deleted = el.classList.contains('deleted');
  return {
    id: thingId(attr(el, 'data-fullname'), 't1') || (link && link.commentId),
    postId: (link && link.postId) || (page && page.id),
    parentId: parent ? thingId(attr(parent, 'data-fullname'), 't1') : null,
    subreddit: attr(el, 'data-subreddit') || (link && link.subreddit) || (page && page.subreddit),
    author: deleted ? null : attr(el, 'data-author') || textOf(entry && first(entry, SELECTORS.old.commentAuthor)),
    body: textOf(entry && first(entry, SELECTORS.old.commentBody)),
    created: attr(entry && first(entry, SELECTORS.old.time), 'datetime'),
    score: exact.value !== null ? exact : parseCount(textOf(scoreEl)),
    depth,
    permalink
  };
}

// ── generic fallback ──────────────────────────────────────────────────────────

const EMPTY_COUNT: RawCount = { value: null, approximate: false };

/** Is `href` on Reddit (or on the page's own host, e.g. a test mirror)? */
function onReddit(href: string | null, pageUrl: string): boolean {
  try {
    const u = new URL(href || '', pageUrl);
    return isRedditHost(u.hostname) || u.host === new URL(pageUrl).host;
  } catch {
    return false;
  }
}

/** Any links to posts' comment pages, one record per post (the longest link text is the title). */
function genericPosts(doc: Document, pageUrl: string): RawPost[] {
  const byId = new Map<string, RawPost>();
  for (const a of all(doc, SELECTORS.generic.permalink)) {
    const href = a.getAttribute('href');
    if (!onReddit(href, pageUrl)) continue;
    const link = parsePermalink(href, pageUrl);
    if (!link || link.commentId) continue;
    const text = textOf(a);
    const existing = byId.get(link.postId);
    if (existing) {
      if (text && (!existing.title || text.length > existing.title.length) && !/^\d+\s+comments?$/i.test(text)) existing.title = text;
      continue;
    }
    byId.set(link.postId, {
      id: link.postId, subreddit: link.subreddit, title: text && !/^\d+\s+comments?$/i.test(text) ? text : null, body: null, author: null,
      created: null, score: EMPTY_COUNT, numComments: EMPTY_COUNT, permalink: href, linkUrl: null, postType: null, domain: null,
      flair: null, over18: null, fromPostPage: false, variant: 'generic'
    });
  }
  return Array.from(byId.values());
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Posts on a listing or search page (promoted posts excluded), plus old Reddit's next-page link. */
export function extractListing(doc: Document, pageUrl: string): ListingExtract {
  const variant = detectVariant(doc);
  if (variant === 'shreddit') {
    const posts = all(doc, SELECTORS.shreddit.post)
      .filter(el => !el.closest(SELECTORS.shreddit.ad.join(',')) && el.getAttribute('promoted') === null)
      .map(el => shredditPost(el, pageUrl, false));
    return { variant, posts: posts.length ? posts : genericPosts(doc, pageUrl), nextUrl: null };
  }
  if (variant === 'old') {
    const posts = all(doc, SELECTORS.old.post)
      .filter(el => el.getAttribute('data-promoted') !== 'true')
      .map(el => oldPost(el, pageUrl, false));
    const next = safeHttpUrl(attr(first(doc, SELECTORS.old.next), 'href'), pageUrl);
    return { variant, posts, nextUrl: next };
  }
  return { variant, posts: genericPosts(doc, pageUrl), nextUrl: null };
}

/** The post shown on its own page, and the comments currently rendered there. */
export function extractPostPage(doc: Document, pageUrl: string): PostPageExtract {
  const variant = detectVariant(doc);
  const pageLink = parsePermalink(pageUrl);
  if (variant === 'shreddit') {
    const postEl = all(doc, SELECTORS.shreddit.post).find(el => !pageLink || thingId(attr(el, 'id'), 't3') === pageLink.postId || parsePermalink(attr(el, 'permalink'), pageUrl)?.postId === pageLink.postId)
      || first(doc, SELECTORS.shreddit.post);
    const post = postEl ? shredditPost(postEl, pageUrl, true) : null;
    const comments = all(doc, SELECTORS.shreddit.comment).map(el => shredditComment(el, pageUrl, post));
    return { variant, post, comments };
  }
  if (variant === 'old') {
    const postEl = first(doc, ['#siteTable .thing.link[data-fullname]', '.thing.link[data-fullname]']);
    const post = postEl ? oldPost(postEl, pageUrl, true) : null;
    const comments = all(doc, SELECTORS.old.comment).map(el => oldComment(el, pageUrl, post));
    return { variant, post, comments };
  }
  // Generic: the page's own post from its address and heading; comments aren't recognised.
  const post: RawPost | null = pageLink ? {
    id: pageLink.postId, subreddit: pageLink.subreddit, title: textOf(first(doc, SELECTORS.generic.pageTitle)), body: null, author: null,
    created: null, score: EMPTY_COUNT, numComments: EMPTY_COUNT, permalink: pageUrl, linkUrl: null, postType: null, domain: null,
    flair: null, over18: null, fromPostPage: true, variant: 'generic'
  } : null;
  return { variant, post, comments: [] };
}
