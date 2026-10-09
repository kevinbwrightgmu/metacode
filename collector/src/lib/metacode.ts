// ── Inside MetaCode: "Add to project" ─────────────────────────────────────────
// MetaCode's Scraper page shows the collector in a frame (/collector/?embed=1).
// "Add to project" turns collected records into MetaCode project posts — the
// same shape Import Data and the old scraper create, so their engagement
// (score → likes, comments → comments) shows up in Metrics — and hands them to
// the MetaCode page with postMessage (same origin only). MetaCode adds new
// ones and updates the engagement numbers of posts it already has.

import type { CommentRecord, PostRecord } from '../types';

export const ADD_MESSAGE = 'metacode-collector:add-to-project';
export const ADDED_MESSAGE = 'metacode-collector:added';

export interface MetaCodePost {
  id: string;
  text: string;
  author: string;
  timestamp: string;
  engagement: { likes: number | null; shares: number | null; comments: number | null; views: number | null };
  humanCodes: Record<string, never>;
  aiCodes: Record<string, never>;
  source: { platform: 'reddit'; type: 'post' | 'comment'; subreddit: string | null; permalink: string | null; post_id?: string; parent_id?: string };
}

export function toMetaCodePost(r: PostRecord | CommentRecord): MetaCodePost {
  if (r.record_type === 'post') {
    return {
      id: 'reddit_' + r.id,
      text: [r.title, r.body, r.link_url ? 'Link: ' + r.link_url : null].filter(Boolean).join('\n\n'),
      author: r.author || '',
      timestamp: r.created_at || '',
      engagement: { likes: r.score, shares: null, comments: r.num_comments, views: null },
      humanCodes: {}, aiCodes: {},
      source: { platform: 'reddit', type: 'post', subreddit: r.subreddit, permalink: r.url }
    };
  }
  return {
    id: 'reddit_c_' + r.id,
    text: r.body || '',
    author: r.author || '',
    timestamp: r.created_at || '',
    engagement: { likes: r.score, shares: null, comments: null, views: null },
    humanCodes: {}, aiCodes: {},
    source: { platform: 'reddit', type: 'comment', subreddit: r.subreddit, permalink: r.url, post_id: r.post_id,
      parent_id: r.parent_comment_id ? 't1_' + r.parent_comment_id : 't3_' + r.post_id }
  };
}

/** Is the collector shown inside MetaCode's Scraper page? */
export function isEmbedded(): boolean {
  try {
    return new URLSearchParams(location.search).has('embed') && window.parent !== window && window.parent.location.origin === location.origin;
  } catch {
    return false;          // a parent on another origin: not MetaCode
  }
}

export interface AddResult { added: number; updated: number; total: number }

let nextId = 1;
/** Sends posts to the MetaCode page around the collector; resolves with what it did. */
export function sendToProject(posts: MetaCodePost[], timeoutMs = 10000): Promise<AddResult> {
  if (!isEmbedded()) return Promise.reject(new Error('Open the collector from MetaCode\'s Scraper page to add records to a project.'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener('message', onReply); reject(new Error('MetaCode didn\'t answer. Reload the Scraper page and try again.')); }, timeoutMs);
    function onReply(e: MessageEvent) {
      if (e.source !== window.parent || e.origin !== location.origin) return;
      const d = e.data as { type?: string; id?: number; error?: string } & Partial<AddResult>;
      if (!d || d.type !== ADDED_MESSAGE || d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onReply);
      if (d.error) reject(new Error(d.error));
      else resolve({ added: d.added || 0, updated: d.updated || 0, total: d.total || 0 });
    }
    window.addEventListener('message', onReply);
    window.parent.postMessage({ type: ADD_MESSAGE, id, posts }, location.origin);
  });
}
