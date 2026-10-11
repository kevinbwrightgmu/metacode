// ── Records from the MetaCode server ──────────────────────────────────────────
// AI jobs run on the MetaCode server, which keeps the posts and comments the AI
// picked in its own (Reddit API) format. The page copies them into this
// browser in the collector's schema (SCHEMA.md), so Data, exports and
// "Add to project" work the same for every record.

import type { CommentRecord, PostRecord, PostType } from '../types';
import { safeHttpUrl } from './urls';

/** A record as the MetaCode scraper returns it (scraper/reddit/format.js). */
export type ServerRecord = Record<string, unknown> & { record_type?: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const ID = /^[a-z0-9]{1,16}$/;

function postType(r: ServerRecord): PostType {
  const media = r.media && typeof r.media === 'object' ? (r.media as { type?: unknown }).type : null;
  if (media === 'image' || media === 'video' || media === 'gallery' || media === 'poll' || media === 'crosspost') return media;
  if (r.is_self === true) return 'text';
  return str(r.url) ? 'link' : 'other';
}

/** → the collector's record, or null for anything that isn't a readable post or comment. */
export function fromServerRecord(r: ServerRecord, jobId: string, now: string): PostRecord | CommentRecord | null {
  if (!r || typeof r !== 'object') return null;
  if (r.record_type === 'post') {
    const id = str(r.post_id);
    if (!id || !ID.test(id)) return null;
    const permalink = safeHttpUrl(str(r.permalink)) || 'https://www.reddit.com/comments/' + id + '/';
    const isSelf = r.is_self === true;
    return {
      record_type: 'post', id, fullname: 't3_' + id, url: permalink,
      subreddit: str(r.subreddit), title: str(r.title), body: str(r.selftext), author: str(r.author),
      created_at: str(r.created_at), score: num(r.score), num_comments: num(r.num_comments), counts_approximate: false,
      link_url: isSelf ? null : safeHttpUrl(str(r.url)), post_type: postType(r), flair: str(r.flair), over_18: bool(r.over_18),
      details_collected: true, source_url: permalink, first_collected_at: now, collected_at: now, job_ids: [jobId]
    };
  }
  if (r.record_type === 'comment') {
    const id = str(r.comment_id);
    const postId = str(r.post_id);
    if (!id || !ID.test(id) || !postId) return null;
    const parent = str(r.parent_id);
    const url = safeHttpUrl(str(r.permalink));
    return {
      record_type: 'comment', id, fullname: 't1_' + id, post_id: postId,
      parent_comment_id: parent && parent.startsWith('t1_') ? parent.slice(3) : null,
      subreddit: str(r.subreddit), author: str(r.author), body: str(r.body), created_at: str(r.created_at),
      score: num(r.score), counts_approximate: false, depth: num(r.depth), url,
      source_url: url || 'https://www.reddit.com/comments/' + postId + '/', first_collected_at: now, collected_at: now, job_ids: [jobId]
    };
  }
  return null;
}

/** The same post or comment seen again: newer values win, nothing known is lost. */
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
