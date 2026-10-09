// A stand-in for www.reddit.com for the Reddit Collector's end-to-end test.
// Pages follow the shreddit structure (web components carrying their data
// in attributes) and behave like Reddit's: a subreddit feed loads more posts
// with a script when scrolled to the end, post pages carry a comment tree.
// Every request arrives through MetaCode's Wisp proxy (Scramjet in the page).

const http = require('http');

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function post(sub, i) {
  const id = 'q' + sub.slice(0, 2) + i;
  return { id, sub, title: 'Post ' + i + ' in r/' + sub + (i === 2 ? ' — <b>not bold</b> & "quoted"' : ''), author: 'user' + i,
    score: i === 3 ? 0 : 100 - i, comments: 3, created: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - i * 3600 * 1000).toISOString() };
}

function postEl(p) {
  return '<article style="min-height:180px;border-bottom:1px solid #ddd;padding:12px"><shreddit-post id="t3_' + p.id + '" permalink="/r/' + p.sub + '/comments/' + p.id + '/post_' + p.id + '/"' +
    ' post-title="' + esc(p.title) + '" author="' + p.author + '" subreddit-prefixed-name="r/' + p.sub + '" score="' + p.score + '" comment-count="' + p.comments + '"' +
    ' created-timestamp="' + p.created + '" post-type="text" domain="self.' + p.sub + '">' +
    '<a slot="full-post-link" href="/r/' + p.sub + '/comments/' + p.id + '/post_' + p.id + '/">' + esc(p.title) + '</a>' +
    '<div slot="text-body"><p>Preview of ' + p.id + '</p></div></shreddit-post></article>';
}

function page(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title></head><body><shreddit-app>' + body + '</shreddit-app></body></html>';
}

function createCollectorMock(opts) {
  const state = Object.assign({ robots: 'User-agent: *\nAllow: /\n', total: 12, pageSize: 5, requests: [] }, opts || {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    state.requests.push({ path: url.pathname + url.search, ua: String(req.headers['user-agent'] || '') });
    const send = (status, type, body) => { res.writeHead(status, { 'content-type': type + '; charset=utf-8' }); res.end(body); };
    if (url.pathname === '/robots.txt') return send(200, 'text/plain', state.robots);
    if (url.pathname === '/') return send(200, 'text/html', page('Reddit (mock)', '<h1>Mock Reddit home</h1><a href="/r/alpha/new/">r/alpha</a>'));

    let m = /^\/r\/([a-z]+)(?:\/(?:new|hot|top|rising))?\/?$/.exec(url.pathname);
    if (m) {
      const sub = m[1];
      if (sub === 'broken') { state.brokenHits = (state.brokenHits || 0) + 1; return req.socket.destroy(); }   // the connection drops: a proxy error
      if (sub === 'blocked') return send(403, 'text/html', '<html><head><title>Blocked</title></head><body><h1>whoa there, pardner!</h1><p>You\'ve been blocked by network security.</p></body></html>');
      const first = Array.from({ length: Math.min(state.pageSize, state.total) }, (_, i) => post(sub, i + 1));
      // Like Reddit's feed: more posts load when the reader scrolls to the end.
      const script = '<script>(function(){var loading=false,next=' + (first.length + 1) + ',total=' + state.total + ';' +
        'function more(){if(loading||next>total)return;if(window.innerHeight+window.scrollY<document.body.scrollHeight-300)return;loading=true;' +
        'fetch("/svc/more?sub=' + sub + '&from="+next).then(function(r){return r.text()}).then(function(h){' +
        'var t=document.createElement("template");t.innerHTML=h;document.querySelector("shreddit-feed").appendChild(t.content);' +
        'next+=' + state.pageSize + ';loading=false;})}window.addEventListener("scroll",more);})();</script>';
      return send(200, 'text/html', page('r/' + sub, '<main><h1>r/' + sub + '</h1><shreddit-feed>' + first.map(postEl).join('') + '</shreddit-feed></main>' + script));
    }
    if (url.pathname === '/svc/more') {
      const sub = url.searchParams.get('sub');
      const from = Number(url.searchParams.get('from'));
      const items = [];
      for (let i = from; i < from + state.pageSize && i <= state.total; i++) items.push(post(sub, i));
      return setTimeout(() => send(200, 'text/html', items.map(postEl).join('')), 150);
    }
    m = /^\/r\/([a-z]+)\/comments\/([a-z0-9]+)\/[^/]*\/$/.exec(url.pathname);
    if (m) {
      const [, sub, id] = m;
      const i = Number(id.replace(/^q[a-z]{2}/, ''));
      const p = post(sub, i);
      const c = (cid, parent, depth, text, children) => '<shreddit-comment thingid="t1_' + cid + '" postid="t3_' + id + '" parentid="' + parent + '" depth="' + depth + '"' +
        ' author="commenter_' + cid + '" score="' + (depth + 1) + '" permalink="/r/' + sub + '/comments/' + id + '/comment/' + cid + '/">' +
        '<div slot="commentMeta"><faceplate-timeago ts="2026-10-02T08:00:00.000Z"></faceplate-timeago></div><div slot="comment"><p>' + esc(text) + '</p></div>' + (children || '') + '</shreddit-comment>';
      const tree = c(id + 'a', 't3_' + id, 0, 'Top comment on ' + id, c(id + 'b', 't1_' + id + 'a', 1, 'Reply to ' + id + 'a')) + c(id + 'c', 't3_' + id, 0, 'Another top comment');
      return send(200, 'text/html', page(p.title + ' : r/' + sub,
        '<main><shreddit-post id="t3_' + p.id + '" permalink="/r/' + sub + '/comments/' + p.id + '/post_' + p.id + '/" post-title="' + esc(p.title) + '" author="' + p.author + '"' +
        ' subreddit-prefixed-name="r/' + sub + '" score="' + p.score + '" comment-count="3" created-timestamp="' + p.created + '" post-type="text">' +
        '<h1 slot="title">' + esc(p.title) + '</h1><div slot="text-body"><p>Full text of ' + p.id + '.</p><p>Second paragraph.</p></div></shreddit-post>' +
        '<shreddit-comment-tree>' + tree + '</shreddit-comment-tree></main>'));
    }
    send(404, 'text/html', page('Not found', '<h1>page not found</h1>'));
  });
  return {
    state,
    server,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://localhost:' + server.address().port))),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

module.exports = { createCollectorMock, post };
