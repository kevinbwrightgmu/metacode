const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../scraper/reddit/format');
const exporter = require('../scraper/export');
const { parseRobots, isAllowed } = require('../scraper/network/robots');

test('result formatting: posts with missing fields become nulls, not errors', () => {
  const r = F.normalizePost({ id: 'abc', name: 't3_abc', title: 'Hi', created_utc: 1700000000 });
  assert.equal(r.record_type, 'post');
  assert.equal(r.post_id, 'abc');
  assert.equal(r.created_at, '2023-11-14T22:13:20.000Z');
  for (const k of ['author', 'subreddit', 'url', 'permalink', 'score', 'upvote_ratio', 'num_comments', 'selftext', 'flair', 'media']) {
    assert.equal(r[k], null, k);
  }
  const empty = F.normalizePost(undefined);
  assert.equal(empty.post_id, null);
  assert.equal(F.toIso('nope'), null);
});

test('result formatting: full post fields, permalinks and media', () => {
  const r = F.normalizePost({
    id: 'p1', name: 't3_p1', title: 'T', author: 'a', subreddit: 's', permalink: '/r/s/comments/p1/t/', url: 'https://i.redd.it/x.jpg',
    created_utc: 1, edited: 2, score: 10, upvote_ratio: 0.5, num_comments: 4, selftext: '', link_flair_text: 'News',
    post_hint: 'image', thumbnail: 'https://b.thumbs.redditmedia.com/t.jpg', is_self: false
  });
  assert.equal(r.permalink, 'https://www.reddit.com/r/s/comments/p1/t/');
  assert.equal(r.edited_at, '1970-01-01T00:00:02.000Z');
  assert.equal(r.flair, 'News');
  assert.deepEqual(r.media, { type: 'image', url: 'https://i.redd.it/x.jpg', thumbnail: 'https://b.thumbs.redditmedia.com/t.jpg', items: [] });

  const gallery = F.extractMedia({ is_gallery: true, gallery_data: { items: [{ media_id: 'm1', caption: 'c' }] }, media_metadata: { m1: { m: 'image/jpg', s: { u: 'https://preview.redd.it/m1.jpg' } } } });
  assert.equal(gallery.type, 'gallery');
  assert.equal(gallery.items[0].url, 'https://preview.redd.it/m1.jpg');
  const video = F.extractMedia({ is_video: true, media: { reddit_video: { fallback_url: 'https://v.redd.it/v/DASH_720.mp4', duration: 12 } } });
  assert.equal(video.type, 'video');
  assert.equal(video.duration, 12);
  assert.equal(F.extractMedia({ is_self: true }), null);
  assert.equal(F.normalizePost({ thumbnail: 'self', url: 'javascript:alert(1)' }).url, null);
});

test('result formatting: comment trees flatten in reading order and count "more" stubs', () => {
  const c = (id, parent, replies) => ({ kind: 't1', data: { id, name: 't1_' + id, link_id: 't3_p', parent_id: parent, body: id, created_utc: 5, replies: replies ? { kind: 'Listing', data: { children: replies } } : '' } });
  const tree = [c('a', 't3_p', [c('a1', 't1_a', [c('a1x', 't1_a1')])]), { kind: 'more', data: { count: 4 } }, c('b', 't3_p')];
  const flat = F.flattenComments(tree, { post_title: 'Title' });
  assert.deepEqual(flat.comments.map(x => x.comment_id), ['a', 'a1', 'a1x', 'b']);
  assert.equal(flat.moreCount, 4);
  assert.equal(flat.comments[0].parent_type, 'post');
  assert.equal(flat.comments[1].parent_type, 'comment');
  assert.equal(flat.comments[0].post_id, 'p');
  assert.equal(flat.comments[0].post_title, 'Title');
  assert.equal(F.flattenComments(tree, {}, 2).comments.length, 2);
  assert.equal(F.normalizeThing({ kind: 'more', data: {} }), null);
  assert.equal(F.normalizeThing({ kind: 't5', data: { display_name: 'x', subscribers: 3 } }).subscribers, 3);
  assert.equal(F.normalizeThing({ kind: 't2', data: { name: 'u', link_karma: 1 } }).profile_url, 'https://www.reddit.com/user/u');
  assert.equal(F.recordKey({ record_type: 'subreddit', name: 'Sci' }), 'sub:sci');
});

test('export: CSV escapes quotes/newlines and neutralizes spreadsheet formulas', () => {
  const csv = exporter.toCSV([
    { record_type: 'post', post_id: '1', title: '=HYPERLINK("http://evil")', score: -5, selftext: 'line1\nline2, "quoted"', media: { type: 'image' } },
    { record_type: 'comment', comment_id: 'c', body: '@SUM(1)', score: 3, extra: null }
  ]);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'record_type,post_id,comment_id,title,score,selftext,body,media,extra');
  assert.ok(lines[1].includes('"\'=HYPERLINK(""http://evil"")"'));
  assert.ok(lines[1].includes(',-5,'), 'negative numbers are not prefixed');
  assert.ok(lines[1].includes('"line1\nline2, ""quoted"""'));
  assert.ok(lines[1].includes('"{""type"":""image""}"'));
  assert.ok(csv.includes('\'@SUM(1)'));
  assert.equal(exporter.csvCell(null), '');
});

test('export: JSON (flat and nested) and NDJSON', () => {
  const records = [
    { record_type: 'post', post_id: 'p', fullname: 't3_p' },
    { record_type: 'comment', comment_id: 'c1', post_id: 'p' },
    { record_type: 'comment', comment_id: 'c2', post_id: 'other' },
    { record_type: 'user', name: 'u' }
  ];
  const job = { id: 'j', mode: 'standard', target: { type: 'post' }, status: 'completed', createdAt: 't', finishedAt: 't2', meta: {} };
  const flat = JSON.parse(exporter.toJSON(job, records, false));
  assert.equal(flat.count, 4);
  assert.equal(flat.records.length, 4);
  assert.equal(flat.job.id, 'j');
  const nested = JSON.parse(exporter.toJSON(job, records, true));
  assert.equal(nested.records[0].comments.length, 1);
  assert.equal(nested.records.length, 3);          // post (with c1), orphan comment c2, user
  const nd = exporter.toNDJSON(records).trim().split('\n');
  assert.equal(nd.length, 4);
  assert.deepEqual(JSON.parse(nd[3]), records[3]);
  assert.equal(exporter.toNDJSON([]), '');
});

test('robots.txt: group selection, longest match, wildcards', () => {
  const groups = parseRobots([
    'User-agent: *', 'Disallow: /', '',
    'User-agent: metacode-reddit-scraper', 'Disallow: /r/*/comments/', 'Allow: /r/', 'Allow: /robots.txt$'
  ].join('\n'));
  const ua = 'nodejs:metacode-reddit-scraper:1.0 (by /u/x)';
  assert.equal(isAllowed(groups, ua, '/r/science/new.json').allowed, true);
  assert.equal(isAllowed(groups, ua, '/r/science/comments/abc.json').allowed, false);
  assert.equal(isAllowed(groups, ua, '/user/x.json').allowed, true);       // no rule in its group matches
  assert.equal(isAllowed(groups, 'OtherBot/1.0', '/r/science/new.json').allowed, false);
  assert.match(isAllowed(groups, 'OtherBot/1.0', '/x').rule, /Disallow: \//);
  assert.equal(isAllowed(parseRobots(''), ua, '/anything').allowed, true);
  const tie = parseRobots('User-agent: *\nDisallow: /page\nAllow: /page\n');
  assert.equal(isAllowed(tie, ua, '/page').allowed, true);
});
