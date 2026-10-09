import { describe, expect, it } from 'vitest';
import { detectVariant, extractListing, extractPostPage, parseCount, textOf } from '../src/extract/parse';
import { first, own, all } from '../src/extract/selectors';
import { fixture, html } from './helpers';

const LISTING = 'https://www.reddit.com/r/technology/new/';
const POST = 'https://www.reddit.com/r/technology/comments/1abc24/ask_what_laptop_for_students/';

describe('counts', () => {
  it('keeps exact numbers, marks rounded ones, and never turns "not shown" into 0', () => {
    expect(parseCount('1,204')).toEqual({ value: 1204, approximate: false });
    expect(parseCount('0')).toEqual({ value: 0, approximate: false });
    expect(parseCount('-3')).toEqual({ value: -3, approximate: false });
    expect(parseCount('1.2k')).toEqual({ value: 1200, approximate: true });
    expect(parseCount('3M')).toEqual({ value: 3000000, approximate: true });
    expect(parseCount('45 points')).toEqual({ value: 45, approximate: false });
    for (const hidden of ['Vote', '•', '', '[score hidden]', null, undefined]) expect(parseCount(hidden as string).value).toBeNull();
  });
});

describe('www.reddit.com (shreddit) pages', () => {
  it('reads a subreddit feed: attributes, flair, NSFW, text preview; promoted posts excluded', () => {
    const doc = fixture('shreddit-listing.html');
    expect(detectVariant(doc)).toBe('shreddit');
    const { posts, nextUrl, variant } = extractListing(doc, LISTING);
    expect(variant).toBe('shreddit');
    expect(nextUrl).toBeNull();
    expect(posts.map(p => p.id)).toEqual(['1abc23', '1abc24', '1abc25']);
    const [link, text, image] = posts;
    expect(link).toMatchObject({
      subreddit: 'technology', title: 'Chip makers announce new standard', author: 'alice_w',
      created: '2026-10-01T12:34:56.123000+0000', linkUrl: 'https://example.com/news/chips?ref=a&b=1',
      postType: 'link', flair: 'Hardware', over18: null, fromPostPage: false
    });
    expect(link.score).toEqual({ value: 15432, approximate: false });
    expect(link.numComments).toEqual({ value: 1204, approximate: false });
    expect(text.linkUrl).toBeNull();                     // its "content" is its own comments page
    expect(text.over18).toBe(true);
    expect(text.body).toBe('My budget is $800.\n\n- Light\n- Long battery');
    expect(text.score.value).toBe(0);                    // a real zero
    expect(image.score.value).toBeNull();                // "Vote": not shown
    expect(image.numComments).toEqual({ value: 1200, approximate: true });
    expect(image.author).toBe('[deleted]');
  });

  it('reads a post page: full text and the comment tree (ids, parents, depth, text only)', () => {
    const { post, comments } = extractPostPage(fixture('shreddit-post.html'), POST);
    expect(post).toMatchObject({ id: '1abc24', fromPostPage: true, title: 'Ask: what laptop for students?' });
    expect(post!.body).toBe('My budget is $800.\n\nRequirements:\n\n- Light\n- Long battery\n\n  keep   spacing');
    expect(comments.map(c => [c.id, c.parentId, c.depth])).toEqual([['c001', null, 0], ['c002', 'c001', 1], ['c003', 'c002', 2], ['c004', null, 0]]);
    expect(comments[0]).toMatchObject({ postId: '1abc24', author: 'carol', body: 'Get a used ThinkPad.', created: '2026-09-30T09:15:00.000Z' });
    expect(comments[0].score).toEqual({ value: 45, approximate: false });
    expect(comments[1].body).toBe('Agreed — this one.');
    expect(comments[1].created).toBe('2026-09-30T10:00:00.000Z');    // its own time, not a reply's
    expect(comments[2]).toMatchObject({ author: '[deleted]', body: '[removed]' });
    expect(comments[2].score.value).toBeNull();
    expect(comments[3].body).toBe('Second option: a MacBook Air.');   // script content is never read as text
    expect(comments[3].score).toEqual({ value: 2500, approximate: true });
  });
});

describe('old.reddit.com pages', () => {
  it('reads the listing and its "next" link; skips promoted posts', () => {
    const doc = fixture('old-listing.html');
    expect(detectVariant(doc)).toBe('old');
    const { posts, nextUrl } = extractListing(doc, 'https://old.reddit.com/r/science/');
    expect(nextUrl).toBe('https://old.reddit.com/r/science/?count=25&after=t3_x2');
    expect(posts.map(p => p.id)).toEqual(['x1', 'x2']);
    expect(posts[0]).toMatchObject({
      subreddit: 'science', author: 'sci_writer', title: 'New study on sleep', created: '2025-10-01T10:40:00.000Z',
      linkUrl: 'https://www.nature.com/articles/abc', postType: 'link', flair: 'Health', over18: false
    });
    expect(posts[1]).toMatchObject({ postType: 'text', linkUrl: null });
    expect(posts[1].numComments.value).toBe(0);
  });

  it('reads the post page with nested comments, exact scores and deleted comments', () => {
    const { post, comments } = extractPostPage(fixture('old-post.html'), 'https://old.reddit.com/r/science/comments/x2/question_about_peer_review/');
    expect(post).toMatchObject({ id: 'x2', body: 'How long does it usually take?\n\nThanks!', fromPostPage: true });
    expect(comments.map(c => [c.id, c.parentId, c.depth, c.author])).toEqual([['k1', null, 0, 'reviewer2'], ['k2', 'k1', 1, 'curious'], ['k3', null, 0, null]]);
    expect(comments[0].score).toEqual({ value: 1534, approximate: false });   // from the title, not "1.5k points"
    expect(comments[0].body).toBe('Months, sometimes.');                     // not its reply's text
    expect(comments[2].body).toBe('[deleted]');
    expect(comments[2].score.value).toBeNull();
  });
});

describe('fallbacks when the markup is unfamiliar', () => {
  it('reads posts from links to comment pages (Reddit links only, one per post)', () => {
    const doc = fixture('search-generic.html');
    expect(detectVariant(doc)).toBe('generic');
    const { posts } = extractListing(doc, 'https://www.reddit.com/search/?q=climate');
    expect(posts.map(p => [p.id, p.subreddit, p.title])).toEqual([['s1', 'science', 'Climate paper discussion'], ['s2', 'environment', 'Carbon capture']]);
    expect(posts[0].score.value).toBeNull();
  });

  it('uses the next selector when the first one finds nothing', () => {
    const doc = html('<shreddit-app><shreddit-post id="t3_ab1"><a slot="full-post-link" href="/r/foo/comments/ab1/hello/">x</a><h1 slot="title">Hello <b>there</b></h1></shreddit-post></shreddit-app>');
    const [p] = extractListing(doc, 'https://www.reddit.com/r/foo/').posts;
    expect(p).toMatchObject({ id: 'ab1', subreddit: 'foo', title: 'Hello there', permalink: '/r/foo/comments/ab1/hello/' });
  });

  it('a post without a usable id attribute takes it from its permalink', () => {
    const doc = html('<shreddit-app><shreddit-post id="weird" permalink="/r/foo/comments/zz9/x/" post-title="T"></shreddit-post></shreddit-app>');
    expect(extractListing(doc, 'https://www.reddit.com/r/foo/').posts[0].id).toBe('zz9');
  });

  it('selector helpers skip unsupported selectors and nested owners', () => {
    const doc = html('<div class="a"><p class="x">outer</p><div class="a"><p class="x">inner</p></div></div>');
    expect(first(doc, [':not-a-real-selector(', '.x'])!.textContent).toBe('outer');
    expect(all(doc, ['.missing', '.x']).length).toBe(2);
    const inner = doc.querySelectorAll('.a')[1];
    expect(own(inner, ['.x'], '.a')!.textContent).toBe('inner');
    const outer = doc.querySelector('.a')!;
    expect(own(outer, ['.x'], '.a')!.textContent).toBe('outer');
  });

  it('text extraction keeps paragraphs and drops hidden parts', () => {
    const doc = html('<div id="t"><p>One <span aria-hidden="true">HIDDEN</span>two</p><p>Three<br>four</p><style>.x{}</style></div>');
    expect(textOf(doc.getElementById('t'))).toBe('One two\n\nThree\nfour');
    expect(textOf(null)).toBeNull();
    expect(textOf(html('<p>   </p>').body)).toBeNull();
  });
});
