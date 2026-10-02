// A local stand-in for api.redditapis.com, following the shapes in its docs
// and official MCP server: bearer auth (403 {"error":"Invalid token"} for a
// wrong key), 402 {"error":"Insufficient credits", top_up_url} when out of
// credit, listings as { posts | comments: [...], after, listing_status },
// subreddit info as { kind: "t5", data }, flat user and post objects, and a
// comment tree of { kind, data } nodes whose replies are arrays.

const http = require('http');
const { post } = require('./mock-reddit');

function createMockRedditApis(opts) {
  opts = opts || {};
  const state = { key: opts.key || 'rapi_test_key_123456', requests: [], perListing: opts.perListing || 250, balance: 4.5 };

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function page(items, url, mapper) {
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25);
    const after = url.searchParams.get('after');
    const start = after ? Number(after.replace('cursor_', '')) : 0;
    const slice = items.slice(start, start + limit).map(mapper);
    const next = start + limit < items.length ? 'cursor_' + (start + limit) : null;
    const body = { after: next };
    if (!next) body.listing_status = items.length >= 250 ? 'truncated' : 'complete';
    return { slice, body };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    state.requests.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const auth = String(req.headers.authorization || '');
    if (!auth) return send(res, 401, { error: 'Missing token' });
    if (auth !== 'Bearer ' + state.key) return send(res, 403, { error: 'Invalid token' });

    if (p === '/account/me') return send(res, 200, { email: 'researcher@example.com', balance: state.balance, calls_total: state.requests.length });

    let m;
    if (p === '/api/reddit/posts' || p === '/api/reddit/search') {
      const sub = url.searchParams.get('subreddit') || 'all';
      if (sub === 'broke') return send(res, 402, { error: 'Insufficient credits', top_up_url: 'https://www.redditapis.com/billing' });
      if (sub === 'nosuch') return send(res, 404, { error: 'Subreddit not found' });
      const sort = url.searchParams.get('sort') || 'new';
      const base = { top: 300, controversial: 600, rising: 900 }[sort] || 0;
      const total = p === '/api/reddit/search' ? 30 : state.perListing;
      const items = Array.from({ length: total }, (_, i) => base + i);
      const { slice, body } = page(items, url, i => post(sub, i).data);
      body.posts = slice;
      return send(res, 200, body);
    }
    if ((m = p.match(/^\/api\/reddit\/sub\/([^/]+)\/about$/))) {
      return send(res, 200, { kind: 't5', data: { id: 'sub1', display_name: decodeURIComponent(m[1]), title: 'About ' + m[1], subscribers: 4321, created_utc: 1500000000, over18: false } });
    }
    if ((m = p.match(/^\/api\/reddit\/user\/([^/]+)\/(submitted|comments)$/))) {
      const name = decodeURIComponent(m[1]);
      if (m[2] === 'submitted') {
        const { slice, body } = page([1, 2, 3], url, i => post('u_' + name, i).data);
        body.posts = slice;
        return send(res, 200, body);
      }
      const { slice, body } = page([1, 2], url, i => ({ id: 'uc' + i, name: 't1_uc' + i, body: 'user comment ' + i, author: name, subreddit: 'test',
        link_id: 't3_abc123', parent_id: 't3_abc123', score: i, created_utc: 1700000000 + i, link_title: 'A post' }));
      body.comments = slice;
      return send(res, 200, body);
    }
    if ((m = p.match(/^\/api\/reddit\/user\/([^/]+)$/))) {
      return send(res, 200, { name: decodeURIComponent(m[1]), id: 'u1', link_karma: 11, comment_karma: 22, total_karma: 33, created_utc: 1400000000 });
    }
    if ((m = p.match(/^\/api\/reddit\/post\/([^/]+)$/))) {
      if (m[1] === 'gone') return send(res, 404, { error: 'Post not found' });
      const d = post('test', 7).data;
      d.id = m[1]; d.name = 't3_' + m[1]; d.permalink = '/r/test/comments/' + m[1] + '/a_title/';
      return send(res, 200, d);
    }
    if (p === '/api/reddit/comments') {
      const link = (url.searchParams.get('permalink') || '').split('/')[4] || 'x';
      const c = (id, parent, depth, replies) => ({ kind: 't1', data: { id, name: 't1_' + id, link_id: 't3_' + link, parent_id: parent, author: 'a_' + id,
        body: 'comment ' + id, score: 2, created_utc: 1700000500, depth, permalink: '/r/test/comments/' + link + '/a_title/' + id + '/', replies } });
      return send(res, 200, { comments: [
        c('k1', 't3_' + link, 0, [c('k1a', 't1_k1', 1, [])]),
        c('k2', 't3_' + link, 0, []),
        { kind: 'more', data: { count: 2, children: ['m1', 'm2'] } }
      ], after: null });
    }
    return send(res, 404, { error: 'Not found' });
  });

  return {
    state, server,
    listen() { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://localhost:' + server.address().port))); },
    close() { return new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
  };
}

module.exports = { createMockRedditApis };
