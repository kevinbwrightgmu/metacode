import { describe, expect, it } from 'vitest';
import { isEmbedded, sendToProject, toMetaCodePost } from '../src/lib/metacode';
import type { CommentRecord, PostRecord } from '../src/types';

const post: PostRecord = {
  record_type: 'post', id: 'abc123', fullname: 't3_abc123', url: 'https://www.reddit.com/r/science/comments/abc123/a_title/',
  subreddit: 'science', title: 'A title', body: 'The text\n\nin two paragraphs', author: 'alice', created_at: '2026-01-02T03:04:05.000Z',
  score: 42, num_comments: 7, counts_approximate: false, link_url: null, post_type: 'text', flair: null, over_18: false,
  details_collected: true, source_url: 'https://www.reddit.com/r/science/comments/abc123/a_title/',
  first_collected_at: '2026-01-03T00:00:00.000Z', collected_at: '2026-01-03T00:00:00.000Z', job_ids: ['j1']
};

const comment: CommentRecord = {
  record_type: 'comment', id: 'c9', fullname: 't1_c9', post_id: 'abc123', parent_comment_id: null, subreddit: 'science',
  author: 'bob', body: 'A reply', created_at: '2026-01-02T04:00:00.000Z', score: -3, counts_approximate: false, depth: 0,
  url: 'https://www.reddit.com/r/science/comments/abc123/comment/c9/', source_url: post.url,
  first_collected_at: '2026-01-03T00:00:00.000Z', collected_at: '2026-01-03T00:00:00.000Z', job_ids: ['j1']
};

describe('Add to project (MetaCode posts)', () => {
  it('a post becomes a MetaCode post: the whole post as text, score and comment count as engagement', () => {
    expect(toMetaCodePost(post)).toEqual({
      id: 'reddit_abc123', text: 'A title\n\nThe text\n\nin two paragraphs', author: 'alice', timestamp: '2026-01-02T03:04:05.000Z',
      engagement: { likes: 42, shares: null, comments: 7, views: null }, humanCodes: {}, aiCodes: {},
      source: { platform: 'reddit', type: 'post', subreddit: 'science', permalink: post.url }
    });
  });

  it('link posts bring their link; missing values stay empty, not 0', () => {
    const p = toMetaCodePost({ ...post, body: null, link_url: 'https://example.com/x', author: null, created_at: null, score: null, num_comments: null });
    expect(p.text).toBe('A title\n\nLink: https://example.com/x');
    expect(p.author).toBe('');
    expect(p.timestamp).toBe('');
    expect(p.engagement).toEqual({ likes: null, shares: null, comments: null, views: null });
  });

  it('a comment becomes a MetaCode post with its own id and a pointer to its post or parent comment', () => {
    expect(toMetaCodePost(comment)).toEqual({
      id: 'reddit_c_c9', text: 'A reply', author: 'bob', timestamp: '2026-01-02T04:00:00.000Z',
      engagement: { likes: -3, shares: null, comments: null, views: null }, humanCodes: {}, aiCodes: {},
      source: { platform: 'reddit', type: 'comment', subreddit: 'science', permalink: comment.url, post_id: 'abc123', parent_id: 't3_abc123' }
    });
    expect(toMetaCodePost({ ...comment, parent_comment_id: 'p1' }).source.parent_id).toBe('t1_p1');
  });

  it('outside MetaCode there is no project to send to', async () => {
    expect(isEmbedded()).toBe(false);
    await expect(sendToProject([toMetaCodePost(post)])).rejects.toThrow(/Scraper page/);
  });
});
