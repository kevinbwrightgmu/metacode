// ── Normalisation and validation ──────────────────────────────────────────────
// Raw values from parse.ts → the documented PostRecord / CommentRecord shape.
// Anything that can't be trusted (a malformed id, an unparseable date, a
// non-http link) becomes null — or, for the id itself, the record is refused
// with a reason — rather than being guessed.

import type { CommentRecord, PostRecord, PostType } from '../types';
import type { RawComment, RawPost } from './parse';
import { canonicalCommentUrl, canonicalPostUrl, parsePermalink, safeHttpUrl, toCanonicalHost } from '../lib/urls';

export type Result<T> = { ok: true; record: T } | { ok: false; reason: string };

const ID = /^[a-z0-9]{1,12}$/;
const SUB = /^[A-Za-z0-9_]{2,21}$/;
const MAX_TEXT = 100_000;        // Reddit's own limit for a post is 40,000 characters

/** A date string or epoch value → ISO 8601 UTC, or null when it can't be read. */
export function toIsoDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  let ms: number;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    ms = n < 1e11 ? n * 1000 : n;                  // seconds or milliseconds since 1970
  } else {
    // "2026-10-01T12:34:56.000000+0000": trim sub-millisecond digits and add the colon Date.parse needs
    const s = String(value).trim()
      .replace(/(\.\d{3})\d+/, '$1')
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    ms = Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 2005 || year > 2100) return null;     // Reddit started in 2005
  return new Date(ms).toISOString();
}

function cleanText(value: string | null): string | null {
  if (value === null) return null;
  const t = value.replace(/\u0000/g, '').trim();
  if (!t) return null;
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
}

function cleanName(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^u\//i, '');
  return /^(?:\[deleted\]|\[removed\]|[A-Za-z0-9_-]{1,40})$/.test(v) ? v : null;
}

function cleanSub(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^r\//i, '');
  return SUB.test(v) ? v : null;
}

const TYPE_MAP: Record<string, PostType> = {
  text: 'text', self: 'text', link: 'link', image: 'image', video: 'video', gallery: 'gallery',
  multi_media: 'gallery', 'multi-media': 'gallery', poll: 'poll', crosspost: 'crosspost'
};

function postType(raw: RawPost, linkUrl: string | null): PostType | null {
  if (raw.postType) {
    const t = TYPE_MAP[raw.postType.toLowerCase()];
    if (t) return t;
    return 'other';
  }
  if (raw.domain && /^self\./i.test(raw.domain)) return 'text';
  if (linkUrl) {
    const host = new URL(linkUrl).hostname;
    if (/^i\.redd\.it$|imgur\.com$/i.test(host)) return 'image';
    if (/^v\.redd\.it$/i.test(host)) return 'video';
    return 'link';
  }
  return null;
}

export interface Seen { jobId: string; at: string; sourceUrl: string }

export function normalizePost(raw: RawPost, seen: Seen): Result<PostRecord> {
  const link = parsePermalink(raw.permalink, seen.sourceUrl);
  const id = raw.id && ID.test(raw.id) ? raw.id : link ? link.postId : null;
  if (!id) return { ok: false, reason: 'no post id' };
  if (link && link.postId !== id) return { ok: false, reason: 'the permalink belongs to another post' };
  const subreddit = cleanSub(raw.subreddit) || (link && cleanSub(link.subreddit));
  const linkUrl = safeHttpUrl(raw.linkUrl);
  const counts = [raw.score, raw.numComments];
  return {
    ok: true,
    record: {
      record_type: 'post',
      id,
      fullname: 't3_' + id,
      url: subreddit ? canonicalPostUrl(subreddit, id, link && link.slug) : canonicalPostUrl('all', id).replace('/r/all/', '/'),
      subreddit,
      title: cleanText(raw.title),
      body: cleanText(raw.body),
      author: cleanName(raw.author),
      created_at: toIsoDate(raw.created),
      score: raw.score.value,
      num_comments: raw.numComments.value !== null && raw.numComments.value >= 0 ? raw.numComments.value : null,
      counts_approximate: counts.some(c => c.value !== null && c.approximate),
      link_url: linkUrl,
      post_type: postType(raw, linkUrl),
      flair: cleanText(raw.flair),
      over_18: raw.over18,
      details_collected: raw.fromPostPage && raw.variant !== 'generic',
      source_url: toCanonicalHost(seen.sourceUrl),
      first_collected_at: seen.at,
      collected_at: seen.at,
      job_ids: [seen.jobId]
    }
  };
}

export function normalizeComment(raw: RawComment, seen: Seen): Result<CommentRecord> {
  const link = parsePermalink(raw.permalink, seen.sourceUrl);
  const id = raw.id && ID.test(raw.id) ? raw.id : link && link.commentId ? link.commentId : null;
  if (!id) return { ok: false, reason: 'no comment id' };
  const postId = raw.postId && ID.test(raw.postId) ? raw.postId : link ? link.postId : null;
  if (!postId) return { ok: false, reason: 'no post id for comment ' + id };
  const parent = raw.parentId && ID.test(raw.parentId) && raw.parentId !== id ? raw.parentId : null;
  const subreddit = cleanSub(raw.subreddit) || (link && cleanSub(link.subreddit));
  return {
    ok: true,
    record: {
      record_type: 'comment',
      id,
      fullname: 't1_' + id,
      post_id: postId,
      parent_comment_id: parent,
      subreddit,
      author: cleanName(raw.author),
      body: cleanText(raw.body),
      created_at: toIsoDate(raw.created),
      score: raw.score.value,
      counts_approximate: raw.score.value !== null && raw.score.approximate,
      depth: raw.depth !== null && Number.isInteger(raw.depth) && raw.depth >= 0 ? raw.depth : null,
      url: subreddit ? canonicalCommentUrl(subreddit, postId, id) : safeHttpUrl(raw.permalink, seen.sourceUrl),
      source_url: toCanonicalHost(seen.sourceUrl),
      first_collected_at: seen.at,
      collected_at: seen.at,
      job_ids: [seen.jobId]
    }
  };
}

/**
 * The same post or comment seen again: newer values win, but a value the
 * page didn't show (null) never erases one collected earlier; full details
 * from a post page aren't replaced by a listing's shorter preview.
 */
export function mergeRecords<T extends PostRecord | CommentRecord>(existing: T, incoming: T): T {
  const merged: Record<string, unknown> = { ...existing };
  const keepDetails = existing.record_type === 'post' && (existing as PostRecord).details_collected && !(incoming as PostRecord).details_collected;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'job_ids' || key === 'first_collected_at') continue;
    if (value === null || value === undefined) continue;
    if (keepDetails && (key === 'body' || key === 'details_collected' || key === 'source_url' || key === 'link_url' || key === 'post_type')) continue;
    merged[key] = value;
  }
  if (existing.record_type === 'post') merged.details_collected = (existing as PostRecord).details_collected || (incoming as PostRecord).details_collected;
  merged.first_collected_at = existing.first_collected_at < incoming.first_collected_at ? existing.first_collected_at : incoming.first_collected_at;
  merged.collected_at = existing.collected_at > incoming.collected_at ? existing.collected_at : incoming.collected_at;
  merged.job_ids = Array.from(new Set([...existing.job_ids, ...incoming.job_ids]));
  return merged as T;
}

/** Is the post inside the job's date range? null when its date isn't known. */
export function inDateRange(createdAt: string | null, from: string, to: string): boolean | null {
  if (!from && !to) return true;
  if (!createdAt) return null;
  const day = createdAt.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}
