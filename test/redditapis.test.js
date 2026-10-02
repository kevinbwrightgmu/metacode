// The RedditAPIs.com engine: key check/save, endpoint mapping, response
// translation, errors and custom code — against a local stand-in for
// api.redditapis.com, through the real Wisp + epoxy-tls transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockReddit } = require('./helpers/mock-reddit');
const { createMockRedditApis } = require('./helpers/mock-redditapis');
const { startScraperApp, postJson, getJson, waitForJob } = require('./helpers/harness');
const { toListing, toCommentTree, unwrapObject, commentNodes, balanceOf } = require('../scraper/network/redditapis-client');
const { sandboxSupported } = require('../scraper/sandbox/custom-runner');
const F = require('../scraper/reddit/format');

let reddit, rapi, app, keyFile;
const KEY = 'rapi_test_key_123456';

test.before(async () => {
  reddit = createMockReddit();
  const redditBase = await reddit.listen();
  rapi = createMockRedditApis({ key: KEY });
  const rapiBase = await rapi.listen();
  keyFile = path.join(os.tmpdir(), 'metacode-rapi-key-' + process.pid + '-' + Date.now() + '.json');
  app = await startScraperApp({ REDDIT_BASE_URL: redditBase, REDDITAPIS_BASE_URL: rapiBase }, { redditApisKeyFile: keyFile });
});
test.after(async () => {
  await app.close();
  await rapi.close();
  await reddit.close();
  try { fs.unlinkSync(keyFile); } catch (e) { /* removed by a test */ }
});

const run = async body => {
  const r = await postJson(app.api + '/jobs', Object.assign({ engine: 'redditapis' }, body));
  assert.equal(r.status, 202, JSON.stringify(r.json));
  return waitForJob(app.api, r.json.job.id, 30000);
};
const results = async (id, q) => (await getJson(app.api + '/jobs/' + id + '/results?limit=5000' + (q || ''))).json;

test('response translation handles each documented envelope', () => {
  const flat = toListing({ posts: [{ id: 'a', name: 't3_a', title: 'A' }], after: 'c1', listing_status: null }, 't3');
  assert.deepEqual(flat.listing.data.children[0], { kind: 't3', data: { id: 'a', name: 't3_a', title: 'A' } });
  assert.equal(flat.listing.data.after, 'c1');
  const native = toListing({ kind: 'Listing', data: { after: null, children: [{ kind: 't1', data: { id: 'c', body: 'x' } }] } }, 't3');
  assert.equal(native.listing.data.children[0].kind, 't1');
  assert.equal(toListing({ comments: [{ id: 'c', body: 'hi' }] }, 't3').listing.data.children[0].kind, 't1');
  assert.equal(toListing([{ title: 'x' }], 't1').listing.data.children[0].kind, 't3');
  assert.equal(toListing({ nothing: true }, 't3'), null);
  assert.equal(toListing({ posts: [], after: null, listing_status: 'truncated' }, 't3').status, 'truncated');

  assert.equal(unwrapObject({ kind: 't5', data: { display_name: 'x' } }).display_name, 'x');
  assert.equal(unwrapObject({ post: { id: 'p' } }, ['post']).id, 'p');
  assert.equal(unwrapObject({ name: 'spez', link_karma: 1 }, ['user']).name, 'spez');

  // Flat nodes with reply arrays and Reddit-native nodes both become a tree flattenComments reads.
  const tree = toCommentTree([
    { id: 'a', name: 't1_a', body: 'A', parent_id: 't3_p', replies: [{ id: 'b', name: 't1_b', body: 'B', parent_id: 't1_a', replies: [] }] },
    { kind: 't1', data: { id: 'c', name: 't1_c', body: 'C', parent_id: 't3_p', replies: { kind: 'Listing', data: { children: [] } } } },
    { kind: 'more', data: { count: 3, children: ['d'] } }
  ]);
  const flatTree = F.flattenComments(tree, { post_id: 'p' });
  assert.deepEqual(flatTree.comments.map(c => c.comment_id), ['a', 'b', 'c']);
  assert.equal(flatTree.moreCount, 3);
  assert.equal(commentNodes({ comments: [] }).length, 0);
  assert.equal(commentNodes({ unexpected: 1 }), null);
  assert.deepEqual(balanceOf({ balance: 2.5 }), { field: 'balance', value: 2.5 });
  assert.equal(balanceOf({}), null);
});

test('API key: checked with /account/me, saved (mode 600, never echoed), becomes the default engine', async () => {
  let st = (await getJson(app.api + '/status')).json;
  assert.equal(st.redditApis.configured, false);
  assert.notEqual(st.defaultEngine, 'redditapis');
  assert.equal((await postJson(app.api + '/jobs', { engine: 'redditapis', target: { type: 'subreddit', subreddit: 'test' } })).status, 400);

  const bad = await postJson(app.api + '/redditapis-key', { key: 'rapi_wrong_key_000000' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /wasn't saved: RedditAPIs\.com rejected the API key/);
  assert.equal(fs.existsSync(keyFile), false);
  assert.equal((await postJson(app.api + '/redditapis-key', { key: 'x' })).status, 400);

  const ok = await postJson(app.api + '/redditapis-key', { key: 'Bearer ' + KEY });    // pasted with "Bearer" is fine
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.redditApis.configured, true);
  assert.equal(ok.json.redditApis.source, 'saved');
  assert.equal(ok.json.redditApis.keyHint, '…3456');
  assert.deepEqual(ok.json.redditApis.balance, { field: 'balance', value: 4.5 });
  assert.equal(ok.json.defaultEngine, 'redditapis');
  assert.equal(ok.json.engines.redditapis.available, true);
  assert.ok(!JSON.stringify(ok.json).includes(KEY), 'key never returned');
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(keyFile, 'utf8')).key, KEY);
  assert.ok(rapi.state.requests.some(q => q.path === '/account/me'));
});

test('subreddit scrape through RedditAPIs.com: mapping, paging, normalized records', async () => {
  const before = rapi.state.requests.length;
  const job = await run({ target: { type: 'subreddit', subreddit: 'WeirdSideHustles', sort: 'top', time: 'week' }, options: { maxItems: 150, maxPages: 3 } });
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.engine, 'redditapis');
  assert.equal(job.itemCount, 150);
  assert.equal(job.meta.subreddit.subscribers, 4321);
  const sent = rapi.state.requests.slice(before);
  const listings = sent.filter(q => q.path === '/api/reddit/posts');
  assert.equal(listings.length, 2);
  assert.deepEqual([listings[0].query.subreddit, listings[0].query.sort, listings[0].query.t, listings[0].query.limit], ['WeirdSideHustles', 'top', 'week', '100']);
  assert.equal(listings[1].query.after, 'cursor_100', 'the opaque cursor is passed back exactly');
  assert.ok(sent.every(q => q.headers.authorization === 'Bearer ' + KEY));
  assert.ok(!reddit.state.requests.some(q => String(q.headers.authorization || '').includes(KEY)), 'key only goes to redditapis.com');
  const { records } = await results(job.id);
  assert.equal(records[0].record_type, 'post');
  assert.match(records[0].permalink, /^https:\/\/www\.reddit\.com\/r\/WeirdSideHustles\/comments\//);
  assert.ok(job.logs.some(l => /RedditAPIs\.com/.test(l.message)));
});

test('post with comments, user posts/comments/info and search', async () => {
  let job = await run({ target: { type: 'post', postId: 'abc123' }, options: { commentLimit: 50 } });
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  let r = await results(job.id);
  assert.deepEqual(r.records.map(x => x.record_type), ['post', 'comment', 'comment', 'comment']);
  assert.deepEqual(r.records.slice(1).map(x => x.comment_id), ['k1', 'k1a', 'k2']);
  assert.equal(r.records[2].parent_type, 'comment');
  assert.ok(job.logs.some(l => /2 more comment/.test(l.message)));
  assert.equal(rapi.state.requests.filter(q => q.path === '/api/reddit/comments').pop().query.permalink, '/r/test/comments/abc123/a_title/');

  job = await run({ target: { type: 'user', username: 'spez', section: 'submitted' } });
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.itemCount, 3);
  assert.equal(job.meta.user.link_karma, 11);
  job = await run({ target: { type: 'user', username: 'spez', section: 'comments' } });
  r = await results(job.id);
  assert.deepEqual(r.records.map(x => x.record_type), ['comment', 'comment']);
  job = await run({ target: { type: 'user_about', username: 'spez' } });
  assert.equal((await results(job.id)).records[0].total_karma, 33);
  job = await run({ target: { type: 'search', query: 'side hustle', subreddit: 'WeirdSideHustles', sort: 'new' } });
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.itemCount, 30);
  const s = rapi.state.requests.filter(q => q.path === '/api/reddit/search').pop();
  assert.deepEqual([s.query.q, s.query.subreddit, s.query.sort], ['side hustle', 'WeirdSideHustles', 'new']);
});

test('combine sorts works through RedditAPIs.com', async () => {
  const job = await run({ target: { type: 'subreddit', subreddit: 'sweepme', sort: 'new' }, options: { maxItems: 700, maxPages: 3, sweepSorts: true, includeMetadata: false } });
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.itemCount, 700);
  const { records } = await results(job.id);
  assert.equal(new Set(records.map(x => x.post_id)).size, 700);
});

test('errors: out of credits, not found, unsupported pages, collapsed comments', async () => {
  let job = await run({ target: { type: 'subreddit', subreddit: 'broke' }, options: { includeMetadata: false } });
  assert.equal(job.error.type, 'payment_required');
  assert.match(job.error.message, /balance is used up/);
  job = await run({ target: { type: 'subreddit', subreddit: 'nosuch' }, options: { includeMetadata: false } });
  assert.equal(job.error.type, 'not_found');
  job = await run({ target: { type: 'post', postId: 'gone' } });
  assert.equal(job.error.type, 'not_found');
  job = await run({ target: { type: 'user', username: 'spez', section: 'overview' }, options: { includeMetadata: false } });
  assert.equal(job.error.type, 'not_available');
  assert.match(job.error.message, /Posts or Comments/);
  job = await run({ target: { type: 'listing', sort: 'hot' } });
  assert.equal(job.error.type, 'not_available');
  job = await run({ target: { type: 'post', postId: 'abc123' }, options: { expandMore: true } });
  assert.equal(job.status, 'completed');
  assert.ok(job.logs.some(l => /isn't offered through RedditAPIs\.com/.test(l.message)));
});

test('custom code uses RedditAPIs.com through ctx.reddit; ctx.fetch explains it is unavailable', { skip: !sandboxSupported().ok }, async () => {
  let job = await run({ mode: 'custom', code: 'async function scrape(ctx) { const { items } = await ctx.reddit.listing("/r/WeirdSideHustles/new", { maxPages: 1, maxItems: 5 }); const sub = await ctx.reddit.subreddit("WeirdSideHustles"); return items.map(p => ({ ...p, subs: sub.subscribers })); }' });
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  const { records } = await results(job.id);
  assert.equal(records.length, 5);
  assert.equal(records[0].subs, 4321);
  job = await run({ mode: 'custom', code: 'async function scrape(ctx) { await ctx.fetch("https://www.reddit.com/r/x.json") }' });
  assert.equal(job.error.type, 'not_available');
  assert.match(job.error.message, /ctx\.fetch\(\) isn't available/);
});

test('a wrong saved key fails jobs clearly; removing the key works; .env key wins', async () => {
  const saved = rapi.state.key;
  rapi.state.key = 'rapi_rotated_key_999999';
  try {
    const job = await run({ target: { type: 'subreddit', subreddit: 'test' }, options: { includeMetadata: false } });
    assert.equal(job.error.type, 'auth_error');
    assert.match(job.error.message, /redditapis\.com\/dashboard\/api-keys/);
  } finally {
    rapi.state.key = saved;
  }
  const del = await fetch(app.api + '/redditapis-key', { method: 'DELETE' });
  const st = await del.json();
  assert.equal(st.redditApis.configured, false);
  assert.equal(fs.existsSync(keyFile), false);

  const envApp = await startScraperApp({ REDDITAPIS_KEY: KEY, REDDITAPIS_BASE_URL: 'http://localhost:' + rapi.server.address().port });
  try {
    const s2 = (await getJson(envApp.api + '/status')).json;
    assert.equal(s2.redditApis.source, 'env');
    assert.equal((await postJson(envApp.api + '/redditapis-key', { key: KEY })).status, 409);
    assert.equal((await fetch(envApp.api + '/redditapis-key', { method: 'DELETE' })).status, 409);
  } finally {
    await envApp.close();
    require('../scraper/network/wisp-server').configureWisp(app.config);
  }
});
