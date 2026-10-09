import { describe, expect, it } from 'vitest';
import { classifyPage } from '../src/extract/detect';
import { inDateRange, mergeRecords, normalizeComment, normalizePost, toIsoDate } from '../src/extract/normalize';
import { extractListing, extractPostPage, type RawPost } from '../src/extract/parse';
import { fixture, html } from './helpers';

const seen = { jobId: 'job_a', at: '2026-10-02T00:00:00.000Z', sourceUrl: 'https://www.reddit.com/r/technology/new/' };

describe('page classification', () => {
  it('content, empty results, and pages Reddit shows instead of content', () => {
    expect(classifyPage(fixture('shreddit-listing.html'), seen.sourceUrl, 'listing').kind).toBe('content');
    expect(classifyPage(fixture('shreddit-post.html'), 'https://www.reddit.com/r/technology/comments/1abc24/x/', 'post').kind).toBe('content');
    expect(classifyPage(fixture('empty-search.html'), 'https://www.reddit.com/search/?q=qwertyuiop', 'listing').kind).toBe('empty');
    const blocked = classifyPage(fixture('blocked.html'), seen.sourceUrl, 'listing');
    expect(blocked).toMatchObject({ kind: 'blocked', stopJob: true, retryable: false });
    expect(classifyPage(fixture('captcha.html'), seen.sourceUrl, 'listing')).toMatchObject({ kind: 'captcha', stopJob: true });
    expect(classifyPage(fixture('private.html'), 'https://www.reddit.com/r/secret/', 'listing')).toMatchObject({ kind: 'private', stopJob: false });
    expect(classifyPage(html('<p>Log in to continue</p>'), seen.sourceUrl, 'listing').kind).toBe('login_required');
    expect(classifyPage(html('<form action="/over18"><button>Yes</button></form>'), seen.sourceUrl, 'listing').kind).toBe('age_gate');
    expect(classifyPage(html('<p>Too Many Requests</p>'), seen.sourceUrl, 'listing')).toMatchObject({ kind: 'rate_limited', stopJob: true });
    expect(classifyPage(html('<h1>Sorry, nobody on Reddit goes by that name.</h1>'), seen.sourceUrl, 'listing').kind).toBe('not_found');
    const proxy = classifyPage(html('<meta name="collector-proxy-error" content="network down"><p>x</p>'), seen.sourceUrl, 'listing');
    expect(proxy).toMatchObject({ kind: 'proxy_error', retryable: true });
    expect(proxy.message).toContain('network down');
  });

  it('a page with posts counts as content even if it mentions "rate limit" in a title', () => {
    const doc = html('<shreddit-app><shreddit-post id="t3_aa1" permalink="/r/a/comments/aa1/x/" post-title="Why do APIs rate limit?"></shreddit-post></shreddit-app>');
    expect(classifyPage(doc, seen.sourceUrl, 'listing').kind).toBe('content');
  });
});

describe('dates', () => {
  it('reads Reddit\'s formats and refuses impossible values', () => {
    expect(toIsoDate('2026-10-01T12:34:56.123000+0000')).toBe('2026-10-01T12:34:56.123Z');
    expect(toIsoDate('2025-09-30T12:00:00+00:00')).toBe('2025-09-30T12:00:00.000Z');
    expect(toIsoDate(1759315200000)).toBe('2025-10-01T10:40:00.000Z');
    expect(toIsoDate('1759315200')).toBe('2025-10-01T10:40:00.000Z');
    for (const bad of ['yesterday', '', null, '1999-01-01T00:00:00Z', 'NaN']) expect(toIsoDate(bad as string)).toBeNull();
  });
  it('date ranges: inclusive days; unknown dates are undecided', () => {
    expect(inDateRange('2026-10-01T23:59:59.000Z', '2026-10-01', '2026-10-01')).toBe(true);
    expect(inDateRange('2026-09-30T23:59:59.000Z', '2026-10-01', '')).toBe(false);
    expect(inDateRange('2026-10-02T00:00:00.000Z', '', '2026-10-01')).toBe(false);
    expect(inDateRange(null, '2026-10-01', '')).toBeNull();
    expect(inDateRange(null, '', '')).toBe(true);
  });
});

describe('records', () => {
  it('posts: canonical URLs, nulls for what wasn\'t shown, unsafe links dropped', () => {
    const [link, text, image] = extractListing(fixture('shreddit-listing.html'), seen.sourceUrl).posts.map(p => normalizePost(p, seen));
    expect(link.ok && link.record).toMatchObject({
      record_type: 'post', id: '1abc23', fullname: 't3_1abc23', subreddit: 'technology',
      url: 'https://www.reddit.com/r/technology/comments/1abc23/chip_makers_announce_new_standard/',
      created_at: '2026-10-01T12:34:56.123Z', score: 15432, num_comments: 1204, counts_approximate: false,
      post_type: 'link', flair: 'Hardware', details_collected: false, job_ids: ['job_a'], source_url: seen.sourceUrl
    });
    expect(text.ok && text.record).toMatchObject({ post_type: 'text', link_url: null, score: 0, num_comments: 0, over_18: true });
    expect(image.ok && image.record).toMatchObject({ post_type: 'image', score: null, num_comments: 1200, counts_approximate: true });

    const bad: RawPost = { ...(extractListing(fixture('shreddit-listing.html'), seen.sourceUrl).posts[0]), linkUrl: 'javascript:alert(1)', author: '<img src=x>' };
    const r = normalizePost(bad, seen);
    expect(r.ok && r.record.link_url).toBeNull();
    expect(r.ok && r.record.author).toBeNull();
    expect(normalizePost({ ...bad, id: 'NOT VALID!', permalink: null }, seen)).toEqual({ ok: false, reason: 'no post id' });
  });

  it('a mirror address is stored as the reddit.com address', () => {
    const post = extractListing(fixture('shreddit-listing.html'), seen.sourceUrl).posts[0];
    const r = normalizePost(post, { ...seen, sourceUrl: 'http://localhost:4000/r/technology/new/' });
    expect(r.ok && r.record.source_url).toBe('https://www.reddit.com/r/technology/new/');
  });

  it('comments: parent ids, depth, canonical comment URL', () => {
    const page = 'https://www.reddit.com/r/technology/comments/1abc24/ask_what_laptop_for_students/';
    const out = extractPostPage(fixture('shreddit-post.html'), page).comments.map(c => normalizeComment(c, { ...seen, sourceUrl: page }));
    expect(out.every(r => r.ok)).toBe(true);
    const recs = out.map(r => (r.ok ? r.record : null))!;
    expect(recs[1]).toMatchObject({ id: 'c002', fullname: 't1_c002', post_id: '1abc24', parent_comment_id: 'c001', depth: 1,
      url: 'https://www.reddit.com/r/technology/comments/1abc24/comment/c002/', score: 0 });
    expect(recs[2]).toMatchObject({ author: '[deleted]', score: null });
    expect(recs[3]).toMatchObject({ score: 2500, counts_approximate: true });
  });

  it('merging: newer values win, missing values never erase, details survive a later listing visit', () => {
    const posts = extractListing(fixture('shreddit-listing.html'), seen.sourceUrl).posts;
    const fromPage = normalizePost({ ...posts[1], body: 'Full text', fromPostPage: true }, { ...seen, jobId: 'job_a' });
    const later = normalizePost({ ...posts[1], body: 'Preview…', score: { value: 99, approximate: false }, author: null, fromPostPage: false },
      { jobId: 'job_b', at: '2026-10-05T00:00:00.000Z', sourceUrl: seen.sourceUrl });
    if (!fromPage.ok || !later.ok) throw new Error('setup');
    const merged = mergeRecords(fromPage.record, later.record);
    expect(merged).toMatchObject({ body: 'Full text', details_collected: true, score: 99, author: 'bob',
      first_collected_at: seen.at, collected_at: '2026-10-05T00:00:00.000Z', job_ids: ['job_a', 'job_b'] });
  });
});
