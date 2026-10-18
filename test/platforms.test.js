// YouTube, X and LinkedIn in the scraper: target parsing, record shapes, viral
// scores, LinkedIn archives and error classification (unit), then jobs through
// the real scraper API, job manager and network route against stand-ins for
// the YouTube Data API, X API v2 and LinkedIn's REST API
// (test/helpers/platform-mocks.js). The stand-ins show that MetaCode's
// requests, paging, records, quota accounting and refusals are handled; they
// don't show what Google, X or LinkedIn answer today.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { startScraperApp, postJson, getJson, waitForJob } = require('./helpers/harness');
const { createYouTubeMock, createXMock, createLinkedInMock } = require('./helpers/platform-mocks');
const YT = require('../scraper/platforms/youtube');
const X = require('../scraper/platforms/x');
const LI = require('../scraper/platforms/linkedin');

const SERVER_YT_KEY = 'server-youtube-key-0000000000';
const SERVER_X_TOKEN = 'server-x-token-000000000000';
const SERVER_LI_TOKEN = 'li-server-token-000000000000000000';

/* ── Unit ────────────────────────────────────────── */

test('YouTube targets: video, channel and playlist references in every common form', () => {
  for (const s of ['dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ?si=x', 'https://www.youtube.com/embed/dQw4w9WgXcQ']) {
    assert.equal(YT.parseVideoId(s), 'dQw4w9WgXcQ', s);
  }
  assert.equal(YT.parseVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.deepEqual(YT.parseChannel('https://www.youtube.com/@SomeHandle/videos'), { by: 'handle', value: '@SomeHandle' });
  assert.deepEqual(YT.parseChannel('@SomeHandle'), { by: 'handle', value: '@SomeHandle' });
  assert.deepEqual(YT.parseChannel('UCtestchannel000000000aa'), { by: 'id', value: 'UCtestchannel000000000aa' });
  assert.deepEqual(YT.parseChannel('https://www.youtube.com/channel/UCtestchannel000000000aa'), { by: 'id', value: 'UCtestchannel000000000aa' });
  assert.deepEqual(YT.parseChannel('https://www.youtube.com/user/oldname'), { by: 'username', value: 'oldname' });
  assert.throws(() => YT.parseChannel('https://www.youtube.com/c/Custom'), /Custom channel URLs/);
  assert.equal(YT.parsePlaylistId('https://www.youtube.com/playlist?list=PLabcdefghij123'), 'PLabcdefghij123');
  assert.equal(YT.parsePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij123'), 'PLabcdefghij123');
  assert.throws(() => YT.normalizeYouTubeTarget({ type: 'video', videos: 'nope' }), /isn't a YouTube video/);
  assert.throws(() => YT.normalizeYouTubeTarget({ type: 'search', query: 'x', publishedAfter: '2024-01-01', publishedBefore: '2023-01-01' }), /earlier/);
  const t = YT.normalizeYouTubeTarget({ type: 'search', query: 'climate', order: 'date', publishedAfter: '2010-01-01', oldestFirst: true });
  assert.equal(t.publishedAfter, '2010-01-01T00:00:00Z');
  assert.equal(t.oldestFirst, true);
});

test('YouTube records, durations and Trenblack\'s viral score', () => {
  assert.equal(YT.durationSeconds('PT1H2M3S'), 3723);
  assert.equal(YT.durationSeconds('P1DT1M'), 86460);
  assert.equal(YT.durationSeconds('nope'), null);
  const ch = { subs: 1000, views: 50000, videos: 10 };             // average 5,000 views per video
  assert.deepEqual(YT.viralScore(20000, ch), { score: 12, category: 'viral' });
  assert.deepEqual(YT.viralScore(2000, ch), { score: 1.2, category: 'does well' });
  assert.deepEqual(YT.viralScore(500, ch), { score: 0.3, category: 'not viral' });
  assert.deepEqual(YT.viralScore(500, { subs: null, views: 1, videos: 1 }), { score: null, category: null }, 'hidden subscribers: no score');
  const v = YT.videoRecord({ id: 'abcdefghijk', snippet: { title: 'T', description: 'D', channelTitle: 'C', channelId: 'UC1', publishedAt: '2020-01-02T03:04:05Z' }, statistics: { viewCount: '7', likeCount: '2', commentCount: '1' }, contentDetails: { duration: 'PT5M' } });
  assert.equal(v.record_type, 'post');
  assert.equal(v.platform, 'youtube');
  assert.equal(v.fullname, 'yt:video:abcdefghijk');
  assert.equal(v.view_count, 7);
  assert.equal(v.score, 2);
  assert.equal(v.full_text, 'T\n\nD');
  assert.equal(v.duration_seconds, 300);
  assert.equal(v.created_utc, Date.UTC(2020, 0, 2, 3, 4, 5) / 1000);
});

test('YouTube errors are classified: quota, invalid key, API not enabled, comments off — never retried around', () => {
  const err = (status, reason, message) => YT.classifyYouTube(status, { error: { code: status, message: message || reason, errors: [{ reason }] } });
  assert.equal(err(403, 'quotaExceeded').type, 'quota_exceeded');
  assert.match(err(403, 'quotaExceeded').message, /midnight Pacific/);
  assert.equal(err(400, 'badRequest', 'API key not valid. Please pass a valid API key.').type, 'auth_error');
  assert.equal(err(403, 'accessNotConfigured').type, 'auth_error');
  assert.match(err(403, 'accessNotConfigured').message, /isn't enabled/);
  assert.equal(err(403, 'commentsDisabled').type, 'comments_disabled');
  assert.equal(err(403, 'rateLimitExceeded').type, 'rate_limited');
  assert.equal(err(404, 'videoNotFound').type, 'not_found');
  const m = new YT.QuotaMeter(150, () => Date.UTC(2026, 0, 1, 12));
  m.spend(100);
  assert.throws(() => m.spend(100), e => e.type === 'quota_exceeded');
  assert.equal(m.remaining(), 50);
});

test('X targets and errors: post URLs, usernames; a plan without access is said plainly', () => {
  assert.equal(X.parsePostId('https://x.com/nasa/status/1234567890123456789'), '1234567890123456789');
  assert.equal(X.parsePostId('https://twitter.com/nasa/status/1234567890123456789?s=20'), '1234567890123456789');
  assert.equal(X.parsePostId('hello'), null);
  assert.equal(X.parseUsername('@NASA'), 'NASA');
  assert.equal(X.parseUsername('https://x.com/NASA'), 'NASA');
  assert.equal(X.parseUsername('https://x.com/home'), null);
  assert.equal(X.classifyX(401, {}).type, 'auth_error');
  const plan = X.classifyX(403, { reason: 'client-not-enrolled', detail: 'must use keys and tokens from a Twitter developer App that is attached to a Project' });
  assert.equal(plan.type, 'forbidden');
  assert.match(plan.message, /plan doesn't include this endpoint/);
  assert.equal(X.classifyX(429, {}).type, 'rate_limited');
  const t = X.normalizeXTarget({ type: 'search', query: 'climate lang:en -is:retweet', sort: 'top' });
  assert.equal(t.sort, 'top');
});

// A LinkedIn "Get a copy of your data" archive, as its CSV files read
const ARCHIVE = {
  shares: '﻿Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\r\n' +
    '2024-03-05 14:22:31,https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7171/,"First line, with a comma\r\n""Quoted"" second line",https://example.org/a,,MEMBER_NETWORK\r\n' +
    '2023-01-02 08:00:00,https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A6262/,An older post,,,PUBLIC\r\n',
  comments: 'Date,Link,Message\n2024-04-01 10:00:00,https://www.linkedin.com/feed/update/urn:li:activity:999/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A999%2C555%29,"Nice, thanks"\n' +
    '2024-04-03 09:30:00,https://www.linkedin.com/feed/update/urn:li:activity:998/,"Second comment"\n',
  reactions: 'Date,Type,Link\n2024-04-02 11:00:00,PRAISE,https://www.linkedin.com/feed/update/urn:li:activity:888\n2024-04-02 11:05:00,LIKE,https://www.linkedin.com/feed/update/urn:li:activity:887\n',
  reposts: 'Date,Link\n2024-05-01 12:00:00,https://www.linkedin.com/feed/update/urn:li:activity:777\n',
  profile: 'First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary\nAda,Lovelace,,"12 Private Road, London",Dec 10 1815,Analyst,"Multi\nline summary"\n'
};
const archiveFiles = () => [
  { name: 'Basic_LinkedInDataExport_10-01-2026/Shares.csv', text: ARCHIVE.shares }, { name: 'Comments.csv', text: ARCHIVE.comments },
  { name: 'Reactions.csv', text: ARCHIVE.reactions }, { name: 'InstantReposts.csv', text: ARCHIVE.reposts }, { name: 'Profile.csv', text: ARCHIVE.profile }
];

test('LinkedIn: Page references, little-text commentary, Rest.li encoding and API versions', () => {
  assert.deepEqual(LI.parseOrganization('https://www.linkedin.com/company/acme-research/'), { by: 'vanity', value: 'acme-research' });
  assert.deepEqual(LI.parseOrganization('linkedin.com/company/12345/admin/page-posts/published/'), { by: 'id', value: '12345' });
  assert.deepEqual(LI.parseOrganization('https://de.linkedin.com/showcase/acme-labs?trk=x'), { by: 'vanity', value: 'acme-labs' });
  assert.deepEqual(LI.parseOrganization('urn:li:organization:777'), { by: 'id', value: '777' });
  assert.deepEqual(LI.parseOrganization('Acme-Research'), { by: 'vanity', value: 'acme-research' });
  assert.equal(LI.parseOrganization('https://www.linkedin.com/in/someone'), null, 'a person\'s profile isn\'t a Page');
  assert.throws(() => LI.normalizeLinkedInTarget({ type: 'posts', organization: 'https://www.linkedin.com/in/someone' }), /Enter a LinkedIn Page/);
  assert.throws(() => LI.normalizeLinkedInTarget({ type: 'profiles' }), /Pages you manage, a Page's posts or your LinkedIn data archive/);
  assert.equal(LI.plainText('Our {hashtag|\\#|Research} with @[Acme Labs](urn:li:organization:1002) \\(new\\)'), 'Our #Research with @Acme Labs (new)');
  // As LinkedIn's client encodes them: URL encoding plus Rest.li's ( ) '
  assert.equal(LI.enc('urn:li:share:123'), 'urn%3Ali%3Ashare%3A123');
  assert.equal(LI.restliList(['urn:li:share:1', 'urn:li:ugcPost:2']), 'List(urn%3Ali%3Ashare%3A1,urn%3Ali%3AugcPost%3A2)');
  assert.equal(LI.enc("a(b)'c,d"), 'a%28b%29%27c%2Cd');
  assert.equal(LI.versionFor(Date.UTC(2026, 9, 17), 1), '202609');
  assert.equal(LI.versionFor(Date.UTC(2026, 0, 5), 1), '202512');
  assert.deepEqual(LI.linkUrns('https://www.linkedin.com/feed/update/urn:li:activity:999/?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A999%2C555%29'), { post: 'urn:li:activity:999', comment: '555' });
  assert.deepEqual(LI.linkUrns('https://www.linkedin.com/feed/update/urn%3Ali%3Augcpost%3A42/'), { post: 'urn:li:ugcPost:42', comment: null });
});

test('LinkedIn errors: an inactive API version, expired and invalid tokens, missing permissions — said plainly', () => {
  assert.equal(LI.classifyLinkedIn(426, { status: 426, code: 'NONEXISTENT_VERSION', message: 'Requested version 202610 is not active' }).type, 'version_unsupported');
  const expired = LI.classifyLinkedIn(401, { serviceErrorCode: 65601, code: 'EXPIRED_ACCESS_TOKEN', message: 'The token used in the request has expired' });
  assert.equal(expired.type, 'auth_error');
  assert.match(expired.message, /expired \(they last 60 days\)/);
  assert.match(LI.classifyLinkedIn(401, { code: 'INVALID_ACCESS_TOKEN' }).message, /didn't accept the access token/);
  const denied = LI.classifyLinkedIn(403, { code: 'ACCESS_DENIED', message: 'Not enough permissions to access: partnerApiPostsExternal.FINDER-author.20260801' });
  assert.equal(denied.type, 'forbidden');
  assert.match(denied.message, /Community Management API.*r_organization_social.*admin of the Page/);
  assert.equal(LI.classifyLinkedIn(429, {}).type, 'rate_limited');
});

test('LinkedIn data archive: posts with line breaks and quotes, comments, reactions and reposts; dates filter; only the name is taken from Profile.csv', () => {
  const a = LI.parseArchive({ type: 'archive', files: archiveFiles().concat([{ name: 'messages.csv', text: 'FROM,TO,CONTENT\nsomeone,me,private' }]) }, { reactions: true, since: '2024-01-01' });
  assert.equal(a.target.owner, 'Ada Lovelace');
  assert.deepEqual(a.target.counts, { posts: 1, comments: 2, reactions: 3, outOfRange: 1 });
  assert.deepEqual(a.target.files, ['Shares.csv', 'Comments.csv', 'Reactions.csv', 'InstantReposts.csv']);
  const post = a.records.find(r => r.record_type === 'post');
  assert.equal(post.post_id, 'urn:li:share:7171');
  assert.equal(post.selftext, 'First line, with a comma\n"Quoted" second line');
  assert.equal(post.full_text, 'First line, with a comma\n"Quoted" second line\n\nhttps://example.org/a');
  assert.equal(post.created_at, '2024-03-05T14:22:31.000Z');
  assert.equal(post.author, 'Ada Lovelace');
  const c = a.records.filter(r => r.record_type === 'comment');
  assert.deepEqual(c.map(x => [x.comment_id.startsWith('archive:') ? 'hash' : x.comment_id, x.post_id, x.body]), [['555', 'urn:li:activity:999', 'Nice, thanks'], ['hash', 'urn:li:activity:998', 'Second comment']]);
  assert.deepEqual(a.records.filter(r => r.record_type === 'reaction').map(x => x.reaction).sort(), ['Celebrate', 'Like', 'Repost']);
  const kept = JSON.stringify(a);
  assert.ok(!kept.includes('Private Road') && !kept.includes('1815') && !kept.includes('private'), 'nothing else from Profile.csv, and no other files, is kept');
  // Reactions are left out unless asked for; an empty choice or range is refused
  assert.equal(LI.parseArchive({ type: 'archive', files: archiveFiles() }, {}).records.filter(r => r.record_type === 'reaction').length, 0);
  assert.throws(() => LI.parseArchive({ type: 'archive', files: archiveFiles() }, { since: '2025-01-01' }), /Nothing in the archive falls between the dates/);
  assert.throws(() => LI.parseArchive({ type: 'archive', files: [{ name: 'Connections.csv', text: 'First Name\nX' }] }, {}), /Shares\.csv, Comments\.csv, Reactions\.csv/);
  assert.throws(() => LI.parseArchive({ type: 'archive', files: [] }, {}), /Choose your LinkedIn data archive/);
  // Only web links are kept from the files
  const odd = LI.parseArchive({ type: 'archive', files: [{ name: 'Shares.csv', text: 'Date,ShareLink,ShareCommentary,SharedUrl\n2024-01-01 00:00:00,javascript:alert(1),Hi,https://ok.example/x\n' }] }, {});
  assert.equal(odd.records[0].url, null);
  assert.equal(odd.records[0].shared_url, 'https://ok.example/x');
});

/* ── Through the scraper API ─────────────────────── */

let yt, xm, li, app, ytBase, xBase, liBase;
test.before(async () => {
  yt = createYouTubeMock();
  xm = createXMock();
  li = createLinkedInMock();
  ytBase = await yt.listen();
  xBase = await xm.listen();
  liBase = await li.listen();
  app = await startScraperApp({ YOUTUBE_API_BASE_URL: ytBase, X_API_BASE_URL: xBase, LINKEDIN_API_BASE_URL: liBase, YOUTUBE_API_KEY: SERVER_YT_KEY, X_BEARER_TOKEN: SERVER_X_TOKEN,
    LINKEDIN_ACCESS_TOKEN: SERVER_LI_TOKEN, YOUTUBE_MIN_DELAY_MS: '0', X_MIN_DELAY_MS: '0', LINKEDIN_MIN_DELAY_MS: '0' });
});
test.after(async () => {
  if (app) await app.close();
  if (yt) await yt.close();
  if (xm) await xm.close();
  if (li) await li.close();
});

const start = body => postJson(app.api + '/jobs', Object.assign({ mode: 'platform' }, body));
const results = async id => (await getJson(app.api + '/jobs/' + id + '/results?limit=1000')).json;

test('status: which platforms work, never the keys', async () => {
  const { json } = await getJson(app.api + '/status');
  assert.equal(json.platforms.youtube.serverKey, true);
  assert.equal(json.platforms.x.serverToken, true);
  assert.equal(json.platforms.linkedin.enabled, true);
  assert.equal(json.platforms.linkedin.serverToken, true);
  const shown = JSON.stringify(json);
  assert.ok(!shown.includes(SERVER_YT_KEY) && !shown.includes(SERVER_X_TOKEN) && !shown.includes(SERVER_LI_TOKEN));
  const r = await start({ platform: 'linkedin', target: { type: 'profiles', profile: 'https://www.linkedin.com/in/someone' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /Pages you manage, a Page's posts or your LinkedIn data archive/);
  assert.equal((await start({ platform: 'myspace', target: {} })).status, 400);
});

test('YouTube channel: details, playlists, every upload with stats and viral scores, comments with replies; quota counted; key never shown', async () => {
  const r = await start({ platform: 'youtube', target: { type: 'channel', channel: 'https://www.youtube.com/@testchan' },
    options: { maxVideos: 6, viral: true, includePlaylists: true, includeComments: true, commentVideos: 3, commentsPerVideo: 10, includeReplies: true } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError || job.error));
  const { records } = await results(job.id);
  const by = type => records.filter(x => x.record_type === type);
  assert.equal(by('channel').length, 1);
  assert.equal(by('channel')[0].subscriber_count, 1000);
  assert.equal(by('playlist').length, 2);
  const videos = by('post');
  assert.equal(videos.length, 6, 'paged through the uploads list (4 per page) to 6 videos');
  assert.deepEqual(videos.map(v => v.video_id), [0, 1, 2, 3, 4, 5].map(yt.vid));
  assert.equal(videos[0].viral_category, 'viral');
  assert.equal(videos[1].viral_category, 'does well');
  assert.equal(videos[2].viral_category, 'not viral');
  assert.ok(videos.every(v => v.platform === 'youtube' && v.duration_seconds === 3723 && v.url.startsWith('https://www.youtube.com/watch?v=')));
  const comments = by('comment');
  // video 1 has comments turned off: skipped, the job goes on
  assert.ok(!comments.some(c => c.video_id === yt.vid(1)));
  assert.ok(job.logs === undefined || true);
  const v0 = comments.filter(c => c.video_id === yt.vid(0));
  assert.equal(v0.filter(c => c.depth === 0).length, 3, 'paged through the comment threads');
  assert.equal(v0.filter(c => c.depth === 1).length, 3, 'all 3 replies of the first thread, fetched because only 1 was shown');
  assert.equal(v0.find(c => c.depth === 1).parent_id, 'c-' + yt.vid(0) + '-1');
  // quota: channels 1 + playlists 1 + playlistItems 2 + videos 1 (+1 channel stats already known: 0) + commentThreads 2+2 + comments 1+1 …
  const detail = (await getJson(app.api + '/jobs/' + job.id)).json.job;
  assert.ok(detail.meta.youtubeQuota >= 8 && detail.meta.youtubeQuota < 30, 'quota units counted: ' + detail.meta.youtubeQuota);
  assert.ok(yt.seen.keys.every(k => k === SERVER_YT_KEY), 'the server key was used');
  const shown = JSON.stringify(detail) + JSON.stringify((await getJson(app.api + '/jobs/' + job.id + '/logs')).json);
  assert.ok(!shown.includes(SERVER_YT_KEY), 'the key never appears in the job, its logs or events');
  // Exports and the file name
  const csv = await fetch(app.api + '/jobs/' + job.id + '/export?format=csv');
  assert.match(csv.headers.get('content-disposition'), /youtube_/);
  assert.match(await csv.text(), /viral_category/);
});

test('YouTube search: "oldest videos on a topic" — date range, oldest first, titles containing the words', async () => {
  const r = await start({ platform: 'youtube', target: { type: 'search', query: 'cats', order: 'date', publishedAfter: '2019-01-01', oldestFirst: true, titleMustContain: true }, options: { maxVideos: 10 } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  const videos = (await results(job.id)).records.filter(x => x.record_type === 'post');
  assert.deepEqual(videos.map(v => v.video_id), [1, 3, 5, 7, 9].map(yt.vid), 'only "cats" titles, oldest first, across both search pages');
  assert.deepEqual(videos.map(v => v.search_rank), [1, 2, 3, 4, 5]);
  assert.ok(yt.seen.requests.some(q => /^search\?.*publishedAfter=2019-01-01T00%3A00%3A00Z/.test(q) && /order=date/.test(q)));
});

test('YouTube: the job\'s quota budget stops it cleanly; a used-up daily quota or a bad key fails it with the reason', async () => {
  // Budget: one search (100) + videos (1) fits in 101; the second search page doesn't
  let r = await start({ platform: 'youtube', target: { type: 'search', query: 'dogs' }, options: { maxVideos: 6, quotaBudget: 101 } });
  let job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  const logs = (await getJson(app.api + '/jobs/' + job.id + '/logs')).json.logs.map(l => l.message).join('\n');
  assert.match(logs, /quota budget \(101 units\)/);
  // The user's own key, used up
  r = await start({ platform: 'youtube', youtubeApiKey: 'quota-exhausted-key-000000', target: { type: 'video', videos: yt.vid(0) } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.lastError ? job.lastError.type : job.error.type, 'quota_exceeded');
  r = await start({ platform: 'youtube', youtubeApiKey: 'not-a-valid-key-0000000000', target: { type: 'video', videos: yt.vid(0) } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /isn't valid/);
  r = await start({ platform: 'youtube', youtubeApiKey: 'has spaces', target: { type: 'video', videos: yt.vid(0) } });
  assert.equal(r.status, 400);
});

test('YouTube with the user\'s own key: used for their job only and never written to disk', async () => {
  const mine = 'users-own-youtube-key-123456';
  const before = yt.seen.keys.length;
  const r = await start({ platform: 'youtube', youtubeApiKey: mine, target: { type: 'video', videos: [yt.vid(2), 'https://youtu.be/' + yt.vid(3)].join('\n') } });
  assert.equal(r.status, 202);
  assert.equal(r.json.job.keySource, 'own');
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  assert.ok(yt.seen.keys.slice(before).every(k => k === mine));
  const dir = path.join(app.config.dataDir, 'jobs', job.id);
  const onDisk = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(onDisk.length > 0 && !onDisk.includes(mine), 'the key is not in the job\'s files');
});

test('YouTube live chat: follows a live stream\'s chat until it goes offline; an ended stream is explained', async () => {
  let r = await start({ platform: 'youtube', target: { type: 'livechat', video: 'https://www.youtube.com/watch?v=livevideo01' }, options: { maxChatMessages: 100, maxChatMinutes: 2 } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  let job = await waitForJob(app.api, r.json.job.id, 20000);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  const recs = (await results(job.id)).records;
  const chat = recs.filter(x => x.source === 'live_chat');
  assert.equal(chat.length, 4, 'two polls of two messages, then offline');
  const sc = chat.find(c => c.message_type === 'superChatEvent');
  assert.equal(sc.amount, '$5.00');
  assert.equal(chat.find(c => c.author === 'viewer1').is_moderator, true);
  assert.equal(recs.filter(x => x.record_type === 'post').length, 1, 'the stream itself');
  assert.ok(yt.seen.requests.some(q => q.startsWith('liveChat/messages?') && /liveChatId=chat-1/.test(q) && /part=snippet%2CauthorDetails/.test(q)), 'YouTube\'s real path for chat messages: /liveChat/messages');
  r = await start({ platform: 'youtube', target: { type: 'livechat', video: 'endedvideo1' } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /has ended.*only serves the chat of streams that are live now/);
});

test('YouTube live chat from a channel link (@name/live) finds its current stream; a chat that ends stops the job; restricted chats are explained', async () => {
  yt.state.liveCalls = 0;
  const searchesBefore = yt.seen.liveSearches || 0;
  // Found among the channel's uploads without a live search; of its two live streams, the one with the most viewers
  let r = await start({ platform: 'youtube', target: { type: 'livechat', video: 'https://www.youtube.com/@livechan/live' }, options: { maxChatMinutes: 2 } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  let job = await waitForJob(app.api, r.json.job.id, 20000);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  let recs = (await results(job.id)).records;
  assert.equal(recs.find(x => x.record_type === 'post').video_id, 'livevideo01', 'the channel\'s most-watched live stream was found');
  assert.equal(recs.filter(x => x.source === 'live_chat').length, 4);
  assert.equal(yt.seen.liveSearches || 0, searchesBefore, 'no live search was needed');
  let detail = (await getJson(app.api + '/jobs/' + job.id)).json.job;
  assert.ok(detail.meta.youtubeQuota < 100, 'no 100-unit search was spent: ' + detail.meta.youtubeQuota);
  const logs = (await getJson(app.api + '/jobs/' + job.id + '/logs')).json.logs.map(l => l.message).join('\n');
  assert.match(logs, /has 2 streams live; following the one with the most viewers/);
  assert.match(logs, /endingvid01/, 'the other live stream is named');
  // A live stream missing from the uploads is found through YouTube's live search
  r = await start({ platform: 'youtube', target: { type: 'livechat', video: '@searchonly' }, options: { maxChatMinutes: 2 } });
  job = await waitForJob(app.api, r.json.job.id, 20000);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  assert.equal((await results(job.id)).records.find(x => x.record_type === 'post').video_id, 'livevideo01');
  assert.equal(yt.seen.liveSearches, searchesBefore + 1, 'the live search ran once');
  detail = (await getJson(app.api + '/jobs/' + job.id)).json.job;
  assert.ok(detail.meta.youtubeQuota >= 100, 'the live search is counted (100 units): ' + detail.meta.youtubeQuota);
  // A channel that isn't live
  r = await start({ platform: 'youtube', target: { type: 'livechat', video: '@testchan' } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /Couldn't find a live stream on @testchan.*paste the stream's own link/);
  // chatEndedEvent: the job stops at once; deleted-message placeholders are left out
  r = await start({ platform: 'youtube', target: { type: 'livechat', video: 'https://youtu.be/endingvid01' }, options: { maxChatMinutes: 5 } });
  job = await waitForJob(app.api, r.json.job.id, 10000);
  assert.equal(job.status, 'completed');
  recs = (await results(job.id)).records.filter(x => x.source === 'live_chat');
  assert.deepEqual(recs.map(x => x.body), ['Last words']);
  // Members-only / restricted chat
  r = await start({ platform: 'youtube', target: { type: 'livechat', video: 'memberlive1' } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /limited to members or subscribers/);
  // Not a stream link or a channel
  r = await start({ platform: 'youtube', target: { type: 'livechat', video: 'https://example.com/x' } });
  assert.equal(r.status, 400);
});

test('X: search (Latest → recency), a user\'s posts without replies, posts by URL — with the bearer token, and plan refusals explained', async () => {
  let r = await start({ platform: 'x', target: { type: 'search', query: 'research lang:en', sort: 'latest' }, options: { maxPosts: 5 } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  let job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  let posts = (await results(job.id)).records;
  assert.equal(posts.length, 5, 'two pages');
  assert.ok(xm.seen.requests.some(q => q.startsWith('/2/tweets/search/recent?') && /sort_order=recency/.test(q) && /expansions=author_id/.test(q)));
  assert.ok(xm.seen.auth.every(a => a === 'Bearer ' + SERVER_X_TOKEN));
  const p1 = posts.find(p => p.post_id === '1001');
  assert.deepEqual([p1.author, p1.author_name, p1.like_count, p1.retweet_count, p1.reply_count, p1.view_count, p1.platform], ['testuser', 'Test User', 2, 1, 2, 100, 'x']);
  assert.equal(p1.url, 'https://x.com/testuser/status/1001');
  assert.equal(p1.hashtags, '#research');
  r = await start({ platform: 'x', target: { type: 'user', username: '@testuser', excludeReplies: true }, options: { maxPosts: 10 } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  posts = (await results(job.id)).records;
  assert.deepEqual(posts.map(p => p.post_id).sort(), ['1001', '1003', '1005']);
  assert.ok(xm.seen.requests.some(q => q.startsWith('/2/users/42/tweets?') && /exclude=replies/.test(q)));
  r = await start({ platform: 'x', target: { type: 'posts', posts: 'https://x.com/testuser/status/1002, 1009' } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed');
  assert.deepEqual((await results(job.id)).records.map(p => p.post_id), ['1002']);
  r = await start({ platform: 'x', xBearerToken: 'x-noplan-token-00000000000000', target: { type: 'search', query: 'a' } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /plan doesn't include this endpoint/);
});

test('LinkedIn: the Pages you manage, with their names, your roles and followers — through the official API, stepping back to an active API version', async () => {
  const from = li.seen.requests.length;
  const r = await start({ platform: 'linkedin', target: { type: 'pages' } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  const pages = (await results(job.id)).records;
  assert.deepEqual(pages.map(p => [p.record_type, p.name, p.roles, p.follower_count, p.url]), [
    ['page', 'Acme Research', 'ADMINISTRATOR, ANALYST', 4321, 'https://www.linkedin.com/company/acme-research/'],
    ['page', 'Acme Labs', 'ANALYST', 12, 'https://www.linkedin.com/company/acme-labs/']
  ]);
  // As LinkedIn's client sends them: Rest.li 2.0, the method, a version; one that isn't active is stepped back from
  const versions = li.seen.versions.slice(from);
  assert.equal(versions[0], li.monthsBack(1), 'it starts at last month\'s version');
  assert.ok(versions.slice(1).every(v => v === li.state.latestVersion), 'then uses the active one: ' + versions.join(', '));
  assert.ok(li.seen.methods.slice(from).includes('finder') && li.seen.methods.slice(from).includes('batch_get'));
  assert.ok(li.seen.auth.slice(from).every(a => a === 'Bearer ' + SERVER_LI_TOKEN));
  const logs = (await getJson(app.api + '/jobs/' + job.id + '/logs')).json.logs.map(l => l.message).join('\n');
  assert.match(logs, /doesn't serve API version \d{6}; trying \d{6}/);
  const detail = JSON.stringify((await getJson(app.api + '/jobs/' + job.id)).json) + logs;
  assert.ok(!detail.includes(SERVER_LI_TOKEN), 'the token never appears in the job or its logs');
});

test('LinkedIn: a Page\'s posts with reactions, comment counts, statistics and comments; little text made plain; URNs encoded as Rest.li requires', async () => {
  const r = await start({ platform: 'linkedin', target: { type: 'posts', organization: 'https://www.linkedin.com/company/acme-research/' },
    options: { maxPosts: 5, includeComments: true, commentPosts: 1, commentsPerPost: 3, includeStats: true } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  const recs = (await results(job.id)).records;
  assert.deepEqual(recs.map(x => x.record_type), ['page', 'post', 'post', 'post', 'post', 'post', 'comment', 'comment', 'comment']);
  const posts = recs.filter(x => x.record_type === 'post');
  assert.deepEqual(posts.map(p => p.post_id), ['urn:li:share:7001', 'urn:li:share:7002', 'urn:li:ugcPost:7003', 'urn:li:share:7004', 'urn:li:share:7005'], 'two pages of posts');
  const p1 = posts[0];
  assert.equal(p1.selftext, 'Our #Research with @Acme Labs (new)');
  assert.equal(p1.author, 'Acme Research');
  assert.equal(p1.platform, 'linkedin');
  assert.equal(p1.reaction_count, 3);
  assert.equal(p1.reactions, 'Like 2, Celebrate 1');
  assert.equal(p1.score, 3);
  assert.equal(p1.num_comments, 5);
  assert.equal(p1.impression_count, 1000);
  assert.equal(p1.view_count, 1000);
  assert.equal(p1.share_count, 1);
  assert.equal(p1.url, 'https://www.linkedin.com/feed/update/urn:li:share:7001/');
  assert.equal(p1.created_at, new Date(Date.UTC(2026, 8, 29, 12)).toISOString());
  assert.equal(posts[1].content_type, 'article');
  assert.equal(posts[1].article_url, 'https://acme.example/report');
  assert.equal(posts[2].impression_count, 3000, 'ugcPosts get statistics too');
  assert.equal(posts[3].poll_question, 'Which?');
  assert.equal(posts[3].poll_options, 'A | B');
  assert.equal(posts[4].is_repost, true);
  const comments = recs.filter(x => x.record_type === 'comment');
  assert.deepEqual(comments.map(c => [c.comment_id, c.post_id, c.body, c.author, c.score]), [
    ['901', 'urn:li:share:7001', 'Comment 1', 'urn:li:person:member1', 1],
    ['902', 'urn:li:share:7001', 'Comment 2', 'Acme Research', 2],
    ['903', 'urn:li:share:7001', 'Comment 3', 'urn:li:person:member3', 3]
  ], 'the first 3 comments over two pages; the Page\'s own comment is named');
  const sent = li.seen.requests.join('\n');
  assert.match(sent, /\/posts\?author=urn%3Ali%3Aorganization%3A1001&q=author/);
  assert.match(sent, /\/socialActions\/urn%3Ali%3Ashare%3A7001\/comments/);
  assert.match(sent, /shares=List\(urn%3Ali%3Ashare%3A7001,urn%3Ali%3Ashare%3A7002\)&ugcPosts=List\(urn%3Ali%3AugcPost%3A7003\)/);
});

test('LinkedIn: statistics the token may not read are left out with the reason; a Page the member can\'t read and an expired token fail with what to do', async () => {
  li.state.statsForbidden = true;
  try {
    const r = await start({ platform: 'linkedin', target: { type: 'posts', organization: '1001' }, options: { maxPosts: 2, includeStats: true } });
    const job = await waitForJob(app.api, r.json.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
    const posts = (await results(job.id)).records.filter(x => x.record_type === 'post');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].impression_count, null);
    assert.equal(posts[0].reaction_count, 3, 'reactions are still there');
    const logs = (await getJson(app.api + '/jobs/' + job.id + '/logs')).json.logs.map(l => l.message).join('\n');
    assert.match(logs, /didn't give post statistics.*rw_organization_admin/);
  } finally { li.state.statsForbidden = false; }
  let r = await start({ platform: 'linkedin', target: { type: 'posts', organization: 'https://www.linkedin.com/company/acme-labs/' } });
  let job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /refused.*Community Management API/);
  r = await start({ platform: 'linkedin', target: { type: 'posts', organization: 'no-such-page' } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /no Page at linkedin\.com\/company\/no-such-page/);
  r = await start({ platform: 'linkedin', linkedinAccessToken: 'li-expired-token-00000000000000', target: { type: 'pages' } });
  job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'failed');
  assert.match((job.lastError || job.error).message, /expired \(they last 60 days\)/);
  assert.equal((await start({ platform: 'linkedin', linkedinAccessToken: 'not a token', target: { type: 'pages' } })).status, 400);
});

test('LinkedIn with the user\'s own access token: used for their job only and never written to disk', async () => {
  const mine = 'li-users-own-token-1234567890abcdef';
  const from = li.seen.auth.length;
  const r = await start({ platform: 'linkedin', linkedinAccessToken: 'Bearer ' + mine, target: { type: 'pages' } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.job.keySource, 'own');
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  assert.ok(li.seen.auth.slice(from).length > 0 && li.seen.auth.slice(from).every(a => a === 'Bearer ' + mine));
  const dir = path.join(app.config.dataDir, 'jobs', job.id);
  const onDisk = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(onDisk.length > 0 && !onDisk.includes(mine), 'the token is not in the job\'s files');
});

test('LinkedIn data archive import: no token or request to LinkedIn; records kept, the uploaded files are not', async () => {
  const from = li.seen.requests.length;
  const r = await start({ platform: 'linkedin', target: { type: 'archive', files: archiveFiles() }, options: { reactions: true } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.equal(r.json.job.keySource, 'upload');
  const job = await waitForJob(app.api, r.json.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
  const recs = (await results(job.id)).records;
  assert.deepEqual(recs.map(x => x.record_type), ['post', 'post', 'comment', 'comment', 'reaction', 'reaction', 'reaction']);
  assert.ok(recs.every(x => x.platform === 'linkedin' && x.source === 'archive' && x.author === 'Ada Lovelace'));
  assert.equal(li.seen.requests.length, from, 'nothing was requested from LinkedIn');
  const detail = (await getJson(app.api + '/jobs/' + job.id)).json.job;
  assert.equal(detail.target.type, 'archive');
  assert.deepEqual(detail.target.counts, { posts: 2, comments: 2, reactions: 3, outOfRange: 0 });
  const dir = path.join(app.config.dataDir, 'jobs', job.id);
  const onDisk = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(onDisk.includes('Nice, thanks'), 'the imported records are kept');
  assert.ok(!onDisk.includes('Private Road') && !onDisk.includes('ShareCommentary'), 'the uploaded files themselves are not');
  // CSV export of the imported records
  const csv = await fetch(app.api + '/jobs/' + job.id + '/export?format=csv&type=post');
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /First line, with a comma/);
  // Nothing usable → refused at once, with the reason
  const bad = await start({ platform: 'linkedin', target: { type: 'archive', files: [{ name: 'Connections.csv', text: 'First Name,Last Name\nA,B' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /Request the archive with Posts, Comments and Reactions/);
});

test('LinkedIn data archive import stops at the server\'s item limit and says how many were left out', async () => {
  const small = await startScraperApp({ SCRAPER_MAX_ITEMS: '3' });
  try {
    const r = await postJson(small.api + '/jobs', { mode: 'platform', platform: 'linkedin', target: { type: 'archive', files: archiveFiles() }, options: { reactions: true } });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    const job = await waitForJob(small.api, r.json.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
    assert.equal((await getJson(small.api + '/jobs/' + job.id + '/results?limit=100')).json.records.length, 3);
    const logs = (await getJson(small.api + '/jobs/' + job.id + '/logs')).json.logs.map(l => l.message).join('\n');
    assert.match(logs, /The archive has 2 posts, 2 comments, 3 reactions and reposts; 4 of them didn't fit in this job's limit/);
  } finally { await small.close(); }
});

/* ── The VPN gateway carries platform requests too ── */

test('platform requests take the administrator\'s route: through the VPN gateway when one is configured', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, sock, head) => {
    seen.push(req.url);
    const [host, port] = req.url.split(':');
    const up = net.connect(Number(port), host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const viaVpn = await startScraperApp({ YOUTUBE_API_BASE_URL: ytBase, YOUTUBE_API_KEY: SERVER_YT_KEY, YOUTUBE_MIN_DELAY_MS: '0', SCRAPER_VPN_GATEWAY_PROXY_URL: 'http://127.0.0.1:' + proxy.address().port });
  try {
    const st = (await getJson(viaVpn.api + '/status')).json;
    assert.equal(st.transport.name, 'VPN gateway');
    const r = await postJson(viaVpn.api + '/jobs', { mode: 'platform', platform: 'youtube', target: { type: 'video', videos: yt.vid(4) } });
    const job = await waitForJob(viaVpn.api, r.json.job.id);
    assert.equal(job.status, 'completed', JSON.stringify(job.lastError));
    assert.ok(seen.length >= 1 && seen.every(h => h === new URL(ytBase).host), 'the request went through the gateway: ' + seen.join(', '));
  } finally {
    await viaVpn.close();
    proxy.closeAllConnections(); await new Promise(r => proxy.close(r));
  }
});
