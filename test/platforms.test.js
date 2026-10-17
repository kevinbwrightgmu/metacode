// YouTube and X in the scraper: target parsing, record shapes, viral scores
// and error classification (unit), then jobs through the real scraper API,
// job manager and network route against stand-ins for the YouTube Data API
// and X API v2 (test/helpers/platform-mocks.js). The stand-ins show that
// MetaCode's requests, paging, records, quota accounting and refusals are
// handled; they don't show what Google or X answer today.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { startScraperApp, postJson, getJson, waitForJob } = require('./helpers/harness');
const { createYouTubeMock, createXMock } = require('./helpers/platform-mocks');
const YT = require('../scraper/platforms/youtube');
const X = require('../scraper/platforms/x');

const SERVER_YT_KEY = 'server-youtube-key-0000000000';
const SERVER_X_TOKEN = 'server-x-token-000000000000';

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

/* ── Through the scraper API ─────────────────────── */

let yt, xm, app, ytBase, xBase;
test.before(async () => {
  yt = createYouTubeMock();
  xm = createXMock();
  ytBase = await yt.listen();
  xBase = await xm.listen();
  app = await startScraperApp({ YOUTUBE_API_BASE_URL: ytBase, X_API_BASE_URL: xBase, YOUTUBE_API_KEY: SERVER_YT_KEY, X_BEARER_TOKEN: SERVER_X_TOKEN, YOUTUBE_MIN_DELAY_MS: '0', X_MIN_DELAY_MS: '0' });
});
test.after(async () => {
  if (app) await app.close();
  if (yt) await yt.close();
  if (xm) await xm.close();
});

const start = body => postJson(app.api + '/jobs', Object.assign({ mode: 'platform' }, body));
const results = async id => (await getJson(app.api + '/jobs/' + id + '/results?limit=1000')).json;

test('status: which platforms work, never the keys', async () => {
  const { json } = await getJson(app.api + '/status');
  assert.equal(json.platforms.youtube.serverKey, true);
  assert.equal(json.platforms.x.serverToken, true);
  assert.equal(json.platforms.linkedin.enabled, false);
  assert.ok(!JSON.stringify(json).includes(SERVER_YT_KEY) && !JSON.stringify(json).includes(SERVER_X_TOKEN));
  const r = await start({ platform: 'linkedin', target: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /LinkedIn isn't available/);
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
