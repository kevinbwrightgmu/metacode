// A local stand-in for Reddit used by the tests. It speaks the same JSON
// shapes as Reddit's public .json pages and Data API (Listing / t3 / t1 / t5 /
// t2 things, `after` pagination, /comments/<id> post+comment pairs, OAuth
// token endpoint) and can simulate failures: rate limiting, server errors,
// private and missing subreddits, slow answers, robots.txt rules.

const http = require('http');

function post(sub, i) {
  const id = sub.toLowerCase().slice(0, 3) + i.toString(36).padStart(3, '0');
  return {
    kind: 't3',
    data: {
      id, name: 't3_' + id, title: 'Post ' + i + ' in ' + sub, author: 'user' + (i % 7), subreddit: sub,
      url: 'https://example.com/' + i, permalink: '/r/' + sub + '/comments/' + id + '/post_' + i + '/',
      created_utc: 1700000000 + i * 60, score: 100 - i, upvote_ratio: 0.9, num_comments: 3,
      selftext: i % 2 ? 'Body of post ' + i : '', link_flair_text: i % 3 ? null : 'Discussion',
      is_self: !!(i % 2), domain: i % 2 ? 'self.' + sub : 'example.com', over_18: false, stickied: false,
      thumbnail: 'self', post_hint: i % 2 ? undefined : 'link'
    }
  };
}

function comment(postId, sub, id, depth, replies) {
  return {
    kind: 't1',
    data: {
      id, name: 't1_' + id, link_id: 't3_' + postId, parent_id: depth === 0 ? 't3_' + postId : 't1_' + id.slice(0, -1),
      author: 'commenter_' + id, subreddit: sub, body: '=SUM(A1) comment ' + id, score: 5, created_utc: 1700001000,
      permalink: '/r/' + sub + '/comments/' + postId + '/x/' + id + '/', depth, is_submitter: false,
      replies: replies && replies.length ? { kind: 'Listing', data: { children: replies } } : ''
    }
  };
}

function listing(children, after) {
  return { kind: 'Listing', data: { after: after || null, before: null, dist: children.length, children } };
}

function createMockReddit(opts) {
  opts = opts || {};
  const state = {
    requests: [],
    robots: opts.robots !== undefined ? opts.robots : 'User-agent: *\nAllow: /\n',
    postsPerSub: opts.postsPerSub || 250,
    rateLimitRemaining: {},   // path prefix → number of 429s left to send
    failures: {},             // path prefix → number of 500s left to send
    delayMs: 0,
    token: 'test-token-123',
    clientId: 'test-client-id', clientSecret: 'test-client-secret'
  };

  function send(res, status, body, headers) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json; charset=UTF-8',
      'x-ratelimit-remaining': '99', 'x-ratelimit-used': '1', 'x-ratelimit-reset': '60' }, headers || {}));
    res.end(text);
  }

  function handle(req, res, body) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\.json$/, '');
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, at: Date.now() });

    for (const [prefix, n] of Object.entries(state.rateLimitRemaining)) {
      if (p.startsWith(prefix) && n > 0) { state.rateLimitRemaining[prefix]--; return send(res, 429, { message: 'Too Many Requests', error: 429 }, { 'retry-after': '1' }); }
    }
    for (const [prefix, n] of Object.entries(state.failures)) {
      if (p.startsWith(prefix) && n > 0) { state.failures[prefix]--; return send(res, 503, 'upstream error'); }
    }

    if (p === '/robots.txt') return state.robots === null ? send(res, 404, 'not found') : send(res, 200, state.robots);

    if (p === '/api/v1/access_token' && req.method === 'POST') {
      const auth = String(req.headers.authorization || '');
      const expected = 'Basic ' + Buffer.from(state.clientId + ':' + state.clientSecret).toString('base64');
      if (auth !== expected || !/grant_type=client_credentials/.test(body)) return send(res, 401, { error: 'invalid_grant' });
      return send(res, 200, { access_token: state.token, token_type: 'bearer', expires_in: 86400, scope: '*' });
    }
    if (opts.requireToken && String(req.headers.authorization || '') !== 'bearer ' + state.token) return send(res, 401, { error: 401 });

    // HTML pages (for the in-app browser test): anything not asked for as .json.
    if (req.method === 'GET' && !/\.json$/.test(url.pathname) && !url.pathname.startsWith('/api/') && /text\/html/.test(String(req.headers.accept || ''))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><head><title>Mock Reddit</title></head><body><h1 id="mock-title">Mock Reddit page ' +
        url.pathname.replace(/[<>&"]/g, '') + '</h1><a id="mock-link" href="/r/test/comments/abc123/hello/">A post</a></body></html>');
    }

    let m;
    // Collapsed comments ("load more"): each requested id becomes a reply to c1;
    // id "y" also returns a nested "more" stub for "z1".
    if (p === '/api/morechildren') {
      const ids = String(url.searchParams.get('children') || '').split(',').filter(Boolean);
      const link = String(url.searchParams.get('link_id') || '').replace(/^t3_/, '');
      const things = [];
      ids.forEach(id => {
        things.push({ kind: 't1', data: { id, name: 't1_' + id, link_id: 't3_' + link, parent_id: 't1_c1', author: 'more_' + id, subreddit: 'test',
          body: 'collapsed comment ' + id, score: 1, created_utc: 1700002000, depth: 1, permalink: '/r/test/comments/' + link + '/x/' + id + '/' } });
        if (id === 'y') things.push({ kind: 'more', data: { count: 1, children: ['z1'], parent_id: 't1_y' } });
      });
      return send(res, 200, { json: { errors: [], data: { things } } });
    }
    if ((m = p.match(/^\/r\/([^/]+)\/about$/))) {
      const sub = m[1];
      if (sub === 'missing') return send(res, 404, { error: 404 });
      return send(res, 200, { kind: 't5', data: { id: 'abc', display_name: sub, title: 'The ' + sub + ' community', public_description: 'About ' + sub, subscribers: 12345, created_utc: 1500000000, over18: false, subreddit_type: 'public' } });
    }
    if ((m = p.match(/^\/user\/([^/]+)\/about$/))) {
      return send(res, 200, { kind: 't2', data: { id: 'u1', name: m[1], created_utc: 1400000000, link_karma: 10, comment_karma: 20, total_karma: 30 } });
    }
    if ((m = p.match(/^\/user\/([^/]+)\/(overview|submitted|comments)$/))) {
      const sub = 'u_' + m[1];
      return send(res, 200, listing([post(sub, 1), post(sub, 2)], null));
    }
    if ((m = p.match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)$/))) {
      const id = m[1];
      if (id === 'nopost') return send(res, 404, { error: 404 });
      const sub = 'test';
      const p0 = post(sub, 1); p0.data.id = id; p0.data.name = 't3_' + id;
      const tree = [
        comment(id, sub, 'c1', 0, [comment(id, sub, 'c1a', 1, [])]),
        comment(id, sub, 'c2', 0, []),
        { kind: 'more', data: { count: 7, children: ['x', 'y'] } }
      ];
      return send(res, 200, [listing([p0]), listing(tree)]);
    }
    if ((m = p.match(/^\/r\/([^/]+)\/(hot|new|top|rising|controversial)$/)) || (m = p.match(/^\/r\/([^/]+)\/search$/)) || p === '/search' || p === '/hot' || p === '/new') {
      const sub = m ? m[1] : 'all';
      if (sub === 'missing') return send(res, 302, '', { location: '/subreddits/search.json?q=missing' });
      if (sub === 'private') return send(res, 403, { reason: 'private', message: 'Forbidden', error: 403 });
      if (sub === 'quarantinedsub') return send(res, 403, { reason: 'quarantined', message: 'Forbidden', error: 403 });
      if (sub === 'netblock' && !/^bearer /.test(String(req.headers.authorization || ''))) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><body>You\'ve been blocked by network security.</body></html>');
      }
      if (sub === 'htmlblock') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body>whoa there, pardner!</body></html>'); }
      if (sub === 'empty') return send(res, 200, listing([], null));
      const total = sub === 'small' ? 3 : state.postsPerSub;
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25);
      const after = url.searchParams.get('after');
      let start = 0;
      if (after) start = Number(after.split('_')[2] || 0);
      const children = [];
      // Each sort family surfaces different posts (new/hot share theirs), so a
      // sort sweep can collect more than one listing holds.
      const sortName = m && m[2] ? m[2] : 'hot';
      const base = { top: 300, controversial: 600, rising: 900 }[sortName] || 0;
      for (let i = start; i < Math.min(total, start + limit); i++) children.push(post(sub, base + i));
      const next = start + limit < total ? 't3_after_' + (start + limit) : null;
      return send(res, 200, listing(children, next));
    }
    return send(res, 404, { error: 404 });
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (state.delayMs) setTimeout(() => handle(req, res, body), state.delayMs);
      else handle(req, res, body);
    });
  });

  return {
    state,
    server,
    listen() {
      return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://localhost:' + server.address().port)));
    },
    close() { return new Promise(resolve => { server.closeAllConnections && server.closeAllConnections(); server.close(() => resolve()); }); }
  };
}

module.exports = { createMockReddit, post, listing };
