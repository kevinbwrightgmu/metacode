// Stand-ins for the YouTube Data API v3 and the X API v2, for the platform
// tests. They implement the endpoints MetaCode calls with realistic shapes,
// paging and error answers. They show that MetaCode's requests, paging,
// records and error handling are right; they don't show what Google or X
// return today.
const http = require('http');

const CH = 'UCtestchannel000000000aa';                       // 24 chars, starts with UC
const UPLOADS = 'UUtestchannel000000000aa';
const vid = n => 'vid' + String(n).padStart(8, '0');           // 11 chars
// views chosen for viral scores with subs 1000, 50,000 views over 10 videos (avg 5,000)
const VIEWS = [20000, 2000, 500, 3000, 100, 9000, 7000, 400, 6000, 50];

function createYouTubeMock() {
  const seen = { requests: [], keys: [] };
  const state = { liveCalls: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams;
    seen.requests.push(u.pathname.replace('/youtube/v3/', '') + '?' + q.toString().replace(/key=[^&]*/, 'key=…'));
    seen.keys.push(q.get('key'));
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const fail = (status, reason, message) => send(status, { error: { code: status, message, errors: [{ reason, message }] } });
    if (q.get('key') === 'quota-exhausted-key-000000') return fail(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.');
    if (q.get('key') === 'not-a-valid-key-0000000000') return fail(400, 'badRequest', 'API key not valid. Please pass a valid API key.');
    const resource = u.pathname.replace(/^\/youtube\/v3\//, '');
    const page = (items, size) => {
      const start = Number(q.get('pageToken') || 0);
      const next = start + size < items.length ? String(start + size) : undefined;
      return { items: items.slice(start, start + size), nextPageToken: next, pageInfo: { totalResults: items.length } };
    };
    if (resource === 'channels') {
      // @livechan has two streams live among its uploads; @searchonly's live stream shows up only in live search.
      if (q.get('forHandle') === '@livechan') return send(200, { items: [{ id: 'UClivechannel0000000000aa', contentDetails: { relatedPlaylists: { uploads: 'UUlivechannel0000000000aa' } } }] });
      if (q.get('forHandle') === '@searchonly') return send(200, { items: [{ id: 'UCsearchonly00000000000aa', contentDetails: { relatedPlaylists: { uploads: 'UUsearchonly00000000000aa' } } }] });
      const ok = q.get('forHandle') === '@testchan' || (q.get('id') || '').split(',').includes(CH);
      if (!ok) return send(200, { items: [] });
      return send(200, { items: [{ id: CH, snippet: { title: 'Test Channel', customUrl: '@testchan', description: 'A channel', publishedAt: '2015-01-01T00:00:00Z', country: 'US' },
        statistics: { subscriberCount: '1000', viewCount: '50000', videoCount: '10', hiddenSubscriberCount: false }, contentDetails: { relatedPlaylists: { uploads: UPLOADS } } }] });
    }
    if (resource === 'playlists') {
      if (q.get('channelId') === CH) return send(200, page([1, 2].map(n => ({ id: 'PLtestplaylist' + n, snippet: { title: 'Playlist ' + n, channelId: CH, channelTitle: 'Test Channel', publishedAt: '2016-01-01T00:00:00Z' }, contentDetails: { itemCount: 3 } })), 50));
      if (q.get('id') === 'PLtestplaylist1') return send(200, { items: [{ id: 'PLtestplaylist1', snippet: { title: 'Playlist 1', channelId: CH, channelTitle: 'Test Channel' }, contentDetails: { itemCount: 3 } }] });
      return send(200, { items: [] });
    }
    if (resource === 'playlistItems') {
      const lists = { [UPLOADS]: VIEWS.map((_, i) => vid(i)), PLtestplaylist1: [vid(1), vid(4), vid(7)],
        UUlivechannel0000000000aa: [vid(0), 'endingvid01', 'livevideo01', 'endedvideo1'], UUsearchonly00000000000aa: [vid(2), 'endedvideo1'] };
      const ids = lists[q.get('playlistId') || ''] || null;
      if (!ids) return fail(404, 'playlistNotFound', 'The playlist identified with the request\'s playlistId parameter cannot be found.');
      return send(200, page(ids.map(id => ({ contentDetails: { videoId: id } })), 4));
    }
    if (resource === 'videos') {
      const LIVE = {
        livevideo01: { activeLiveChatId: 'chat-1', actualStartTime: '2026-10-17T10:00:00Z', concurrentViewers: '321' },
        endingvid01: { activeLiveChatId: 'chat-ends', actualStartTime: '2026-10-17T10:00:00Z', concurrentViewers: '50' },
        memberlive1: { activeLiveChatId: 'chat-members', actualStartTime: '2026-10-17T10:00:00Z' },
        endedvideo1: { actualStartTime: '2026-10-01T10:00:00Z', actualEndTime: '2026-10-01T12:00:00Z' }
      };
      const items = (q.get('id') || '').split(',').filter(id => /^vid\d{8}$/.test(id) || LIVE[id]).map(id => {
        const n = /^vid/.test(id) ? Number(id.slice(3)) : 0;
        const live = LIVE[id];
        const state = live && live.activeLiveChatId && !live.actualEndTime ? 'live' : 'none';
        return { id, snippet: { title: 'Video ' + n + (n % 2 ? ' about cats' : ' about dogs'), description: 'Description ' + n, channelId: CH, channelTitle: 'Test Channel', liveBroadcastContent: state,
          publishedAt: new Date(Date.UTC(2020, 0, 1 + n)).toISOString(), tags: ['t' + n], categoryId: '22', thumbnails: { high: { url: 'https://i.ytimg.com/vi/' + id + '/hq.jpg' } } },
          statistics: { viewCount: String(VIEWS[n] || 10), likeCount: String(10 + n), commentCount: String(3) }, contentDetails: { duration: 'PT1H2M3S', definition: 'hd', caption: 'false' },
          liveStreamingDetails: live };
      });
      return send(200, { items });
    }
    if (resource === 'search') {
      if (q.get('eventType') === 'live') {
        seen.liveSearches = (seen.liveSearches || 0) + 1;
        return send(200, { items: ['UClivechannel0000000000aa', 'UCsearchonly00000000000aa'].includes(q.get('channelId') || '') ? [{ id: { kind: 'youtube#video', videoId: 'livevideo01' } }] : [] });
      }
      const all = [vid(5), vid(1), vid(3), vid(2), vid(7), vid(9)];
      const p = page(all.map(id => { const n = Number(id.slice(3)); return { id: { kind: 'youtube#video', videoId: id }, snippet: { title: 'Video ' + n + (n % 2 ? ' about cats' : ' about dogs'), publishedAt: new Date(Date.UTC(2020, 0, 1 + n)).toISOString() } }; }), 4);
      return send(200, p);
    }
    if (resource === 'commentThreads') {
      const v = q.get('videoId');
      if (v === vid(1)) return fail(403, 'commentsDisabled', 'The video identified by the videoId parameter has disabled comments.');
      const threads = [1, 2, 3].map(i => ({ id: 'c-' + v + '-' + i, snippet: { totalReplyCount: i === 1 ? 3 : 0, topLevelComment: { id: 'c-' + v + '-' + i,
        snippet: { textOriginal: 'Comment ' + i + ' on ' + v, authorDisplayName: 'user' + i, authorChannelId: { value: 'UCuser' + i }, likeCount: i, publishedAt: '2021-01-0' + i + 'T00:00:00Z', updatedAt: '2021-01-0' + i + 'T00:00:00Z' } } },
        replies: i === 1 ? { comments: [{ id: 'r-' + v + '-1', snippet: { textOriginal: 'Reply 1', authorDisplayName: 'replier', likeCount: 0, publishedAt: '2021-02-01T00:00:00Z' } }] } : undefined }));
      return send(200, page(threads, 2));
    }
    if (resource === 'comments') {
      const parent = q.get('parentId');
      return send(200, page([1, 2, 3].map(i => ({ id: 'r-' + parent.slice(2) + '-' + i, snippet: { textOriginal: 'Reply ' + i, authorDisplayName: 'replier', likeCount: 0, parentId: parent, publishedAt: '2021-02-0' + i + 'T00:00:00Z' } })), 100));
    }
    // YouTube's path for liveChatMessages.list is /liveChat/messages (not /liveChatMessages)
    if (resource === 'liveChat/messages') {
      const chat = q.get('liveChatId');
      if (chat === 'chat-members') return fail(403, 'forbidden', 'The requester is not allowed to access the requested live chat.');
      if (chat === 'chat-ends') {
        return send(200, { pollingIntervalMillis: 10, nextPageToken: 'end1', items: [
          { id: 'e1', snippet: { type: 'textMessageEvent', displayMessage: 'Last words', publishedAt: '2026-10-17T10:10:00Z' }, authorDetails: { displayName: 'viewer1', channelId: 'UCviewer1' } },
          { id: 'e2', snippet: { type: 'tombstone', publishedAt: '2026-10-17T10:10:01Z' }, authorDetails: { displayName: 'viewer2', channelId: 'UCviewer2' } },
          { id: 'e3', snippet: { type: 'chatEndedEvent', publishedAt: '2026-10-17T10:10:02Z' }, authorDetails: { displayName: 'Test Channel', channelId: CH } }] });
      }
      if (chat !== 'chat-1') return fail(404, 'liveChatNotFound', 'The live chat that you are trying to retrieve cannot be found.');
      state.liveCalls++;
      const n = state.liveCalls;
      const msgs = [1, 2].map(i => ({ id: 'm' + n + '-' + i, snippet: { type: i === 2 && n === 1 ? 'superChatEvent' : 'textMessageEvent', displayMessage: 'Hello ' + n + '-' + i, publishedAt: '2026-10-17T10:0' + n + ':0' + i + 'Z',
        superChatDetails: i === 2 && n === 1 ? { amountDisplayString: '$5.00', amountMicros: '5000000', currency: 'USD', tier: 2 } : undefined },
        authorDetails: { displayName: 'viewer' + i, channelId: 'UCviewer' + i, isChatModerator: i === 1, isChatOwner: false, isChatSponsor: false, isVerified: false } }));
      return send(200, { items: msgs, nextPageToken: 'tok' + n, pollingIntervalMillis: 10, offlineAt: n >= 2 ? '2026-10-17T11:00:00Z' : undefined });
    }
    // Like Google: an unknown path is an HTML 404 page, not a JSON error
    res.writeHead(404, { 'content-type': 'text/html; charset=UTF-8' });
    res.end('<!DOCTYPE html><html><title>Error 404 (Not Found)!!1</title><p>The requested URL <code>' + u.pathname + '</code> was not found on this server.</p></html>');
  });
  return {
    seen, state, CH, vid, VIEWS,
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port + '/youtube/v3'))),
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })
  };
}

function createXMock() {
  const seen = { requests: [], auth: [] };
  const posts = n => ({ id: String(1000 + n), text: 'Post number ' + n + ' #research', author_id: n % 2 ? '42' : '43', created_at: new Date(Date.UTC(2026, 9, 10, n)).toISOString(), lang: 'en', conversation_id: String(1000 + n),
    public_metrics: { like_count: n * 2, retweet_count: n, reply_count: n + 1, quote_count: 0, bookmark_count: 1, impression_count: 100 * n }, entities: { hashtags: [{ tag: 'research' }] } });
  const users = [{ id: '42', username: 'testuser', name: 'Test User', verified: true, public_metrics: { followers_count: 500 } }, { id: '43', username: 'other', name: 'Other', verified: false, public_metrics: { followers_count: 5 } }];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams;
    seen.requests.push(u.pathname + '?' + q.toString());
    seen.auth.push(req.headers.authorization || null);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization === 'Bearer x-noplan-token-00000000000000') return send(403, { title: 'Client Forbidden', type: 'https://api.twitter.com/2/problems/client-forbidden', reason: 'client-not-enrolled', detail: 'When authenticating requests to the Twitter API v2 endpoints, you must use keys and tokens from a Twitter developer App that is attached to a Project.' });
    if (!/^Bearer [\w-]{20,}$/.test(req.headers.authorization || '')) return send(401, { title: 'Unauthorized', detail: 'Unauthorized', status: 401 });
    const pageOf = (all, size) => {
      const start = Number(q.get('next_token') || q.get('pagination_token') || 0);
      const next = start + size < all.length ? String(start + size) : undefined;
      return { data: all.slice(start, start + size), includes: { users }, meta: { result_count: Math.min(size, all.length - start), next_token: next } };
    };
    if (u.pathname === '/2/tweets/search/recent' || u.pathname === '/2/tweets/search/all') {
      if (!q.get('query')) return send(400, { errors: [{ message: 'query is required' }] });
      return send(200, pageOf([1, 2, 3, 4, 5].map(posts), Math.min(3, Number(q.get('max_results')) || 10)));
    }
    if (u.pathname === '/2/users/by/username/testuser') return send(200, { data: users[0] });
    if (u.pathname.startsWith('/2/users/by/username/')) return send(200, { errors: [{ detail: 'Could not find user', title: 'Not Found Error' }] });
    if (u.pathname === '/2/users/42/tweets') return send(200, pageOf([1, 3, 5].map(posts), 2));
    if (u.pathname === '/2/tweets') {
      const ids = (q.get('ids') || '').split(',');
      const found = ids.filter(id => Number(id) >= 1001 && Number(id) <= 1005).map(id => posts(Number(id) - 1000));
      const errors = ids.filter(id => !(Number(id) >= 1001 && Number(id) <= 1005)).map(id => ({ value: id, detail: 'Could not find tweet with ids: [' + id + '].', title: 'Not Found Error' }));
      return send(200, { data: found, includes: { users }, errors: errors.length ? errors : undefined });
    }
    send(404, { title: 'Not Found' });
  });
  return {
    seen,
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port + '/2'))),
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })
  };
}

module.exports = { createYouTubeMock, createXMock };
