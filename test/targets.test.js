const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRedditUrl, normalizeTarget, normalizeOptions } = require('../scraper/reddit/targets');
const { testConfig } = require('./helpers/harness');

test('Reddit URL validation: supported page types are detected', () => {
  assert.deepEqual(parseRedditUrl('https://www.reddit.com/r/AskScience/'), { type: 'subreddit', subreddit: 'AskScience', sort: 'hot', time: undefined });
  assert.equal(parseRedditUrl('reddit.com/r/science/top/?t=week').sort, 'top');
  assert.equal(parseRedditUrl('reddit.com/r/science/top/?t=week').time, 'week');
  assert.equal(parseRedditUrl('old.reddit.com/r/python+learnpython/new').subreddit, 'python+learnpython');

  const post = parseRedditUrl('https://www.reddit.com/r/AskHistorians/comments/abc123/some_title/');
  assert.equal(post.type, 'post');
  assert.equal(post.postId, 'abc123');
  assert.equal(post.subreddit, 'AskHistorians');
  assert.equal(parseRedditUrl('https://www.reddit.com/r/ab/comments/abc123/t/def456/').focusCommentId, 'def456');
  assert.deepEqual(parseRedditUrl('https://redd.it/abc123'), { type: 'post', postId: 'abc123' });
  assert.equal(parseRedditUrl('https://www.reddit.com/comments/abc123').postId, 'abc123');

  assert.deepEqual(parseRedditUrl('https://www.reddit.com/user/spez/submitted/'), { type: 'user', username: 'spez', section: 'submitted', sort: undefined, time: undefined });
  assert.equal(parseRedditUrl('https://www.reddit.com/u/spez').section, 'overview');
  assert.equal(parseRedditUrl('https://www.reddit.com/user/spez/about').type, 'user_about');
  assert.equal(parseRedditUrl('https://www.reddit.com/r/science/about').type, 'subreddit_about');

  const search = parseRedditUrl('https://www.reddit.com/search/?q=climate+policy&sort=new&t=month');
  assert.equal(search.type, 'search');
  assert.equal(search.query, 'climate policy');
  assert.equal(parseRedditUrl('https://www.reddit.com/r/politics/search/?q=vote').subreddit, 'politics');

  assert.equal(parseRedditUrl('https://www.reddit.com/').type, 'listing');
  assert.equal(parseRedditUrl('https://www.reddit.com/top/?t=day').sort, 'top');
  assert.equal(parseRedditUrl('https://www.reddit.com/domain/nytimes.com/').domain, 'nytimes.com');
});

test('Reddit URL validation: invalid input is rejected with a specific message', () => {
  const rejects = (input, pattern) => assert.throws(() => parseRedditUrl(input), err => err.type === 'invalid_target' && pattern.test(err.message), input);
  rejects('', /Enter a Reddit URL/);
  rejects('https://example.com/r/test', /isn't a Reddit address/);
  rejects('https://evilreddit.com/r/test', /isn't a Reddit address/);
  rejects('https://reddit.com.evil.io/r/test', /isn't a Reddit address/);
  rejects('ftp://reddit.com/r/test', /Only http\(s\)/);
  rejects('https://www.reddit.com/r/test/s/AbCdEf', /share links/);
  rejects('https://www.reddit.com/r/test/wiki/index', /doesn't support/);
  rejects('https://www.reddit.com/r/_bad/', /isn't a valid subreddit name/);
  rejects('https://www.reddit.com/r/this_name_is_much_too_long_for_reddit/', /isn't a valid subreddit name/);
  rejects('https://www.reddit.com/user/x/', /isn't a valid Reddit username/);
  rejects('https://www.reddit.com/comments/!!/', /valid post id/);
  rejects('https://www.reddit.com/settings/profile', /isn't a supported page/);
});

test('normalizeTarget builds API paths and labels and validates fields', () => {
  const sub = normalizeTarget({ type: 'subreddit', subreddit: 'r/AskScience', sort: 'top' });
  assert.equal(sub.path, '/r/AskScience/top');
  assert.equal(sub.time, 'day');                 // default time range for top
  assert.match(sub.label, /r\/AskScience · top \(day\)/);
  assert.equal(normalizeTarget({ type: 'subreddit', subreddit: 'x1', sort: 'new' }).time, undefined);

  assert.equal(normalizeTarget({ type: 'search', query: 'climate' }).path, '/search');
  assert.equal(normalizeTarget({ type: 'search', query: 'climate', subreddit: 'science' }).path, '/r/science/search');
  assert.equal(normalizeTarget({ type: 'post', postId: 't3_AbC123' }).postId, 'abc123');
  assert.equal(normalizeTarget({ type: 'post', postId: 'https://www.reddit.com/r/a1/comments/xyz789/t/' }).postId, 'xyz789');
  assert.equal(normalizeTarget({ type: 'url', url: 'https://www.reddit.com/r/science/' }).type, 'subreddit');
  assert.equal(normalizeTarget({ type: 'user', username: 'u/spez', section: 'comments' }).path, '/user/spez/comments');
  assert.equal(normalizeTarget({ type: 'listing', domain: 'NYTimes.com', sort: 'new' }).path, '/domain/nytimes.com/new');

  const bad = (input, pattern) => assert.throws(() => normalizeTarget(input), err => err.type === 'invalid_target' && pattern.test(err.message));
  bad(null, /Choose what to scrape/);
  bad({ type: 'nope' }, /Unknown target type/);
  bad({ type: 'subreddit', subreddit: '' }, /Enter a subreddit/);
  bad({ type: 'subreddit', subreddit: 'has space' }, /valid subreddit name/);
  bad({ type: 'subreddit', subreddit: 'ok', sort: 'weird' }, /Unknown sort/);
  bad({ type: 'subreddit', subreddit: 'ok', sort: 'top', time: 'decade' }, /Unknown time range/);
  bad({ type: 'search', query: '   ' }, /Enter a search query/);
  bad({ type: 'search', query: 'x'.repeat(600) }, /too long/);
  bad({ type: 'post', postId: '' }, /Enter a post URL or id/);
  bad({ type: 'post', postId: 'https://www.reddit.com/r/science/' }, /isn't a Reddit post/);
  bad({ type: 'url', url: 'https://example.org' }, /isn't a Reddit address/);
  bad({ type: 'subreddit_about', subreddit: 'a1+b2' }, /one subreddit at a time/);
});

test('normalizeOptions applies defaults and clamps to server limits', () => {
  const config = testConfig({ SCRAPER_MAX_ITEMS: '300', SCRAPER_MAX_PAGES: '4', SCRAPER_MIN_DELAY_MS: '1500', SCRAPER_PUBLIC_MIN_DELAY_MS: '3000', SCRAPER_MAX_CONCURRENT_REQUESTS: '2' });
  const d = normalizeOptions({}, config);
  assert.equal(d.maxItems, 100);
  assert.equal(d.maxPages, 4);
  assert.equal(d.delayMs, 3000);                  // public mode floor
  assert.equal(d.concurrency, 1);
  assert.equal(d.retries, 2);
  const c = normalizeOptions({ maxItems: 99999, maxPages: 0, delayMs: 10, concurrency: 50, retries: 99, timeoutMs: 1 }, config);
  assert.equal(c.maxItems, 300);
  assert.equal(c.maxPages, 1);
  assert.equal(c.delayMs, 3000);
  assert.equal(c.concurrency, 2);
  assert.equal(c.retries, 5);
  assert.equal(c.timeoutMs, 1000);
  assert.throws(() => normalizeOptions({ maxItems: 'lots' }, config), err => err.type === 'invalid_options');

  const oauth = testConfig({ SCRAPER_MIN_DELAY_MS: '1500', SCRAPER_PUBLIC_MIN_DELAY_MS: '3000', REDDIT_CLIENT_ID: 'abcd', REDDIT_CLIENT_SECRET: 'efgh' });
  assert.equal(normalizeOptions({ delayMs: 10 }, oauth).delayMs, 1500);   // OAuth mode floor
});

test('scraper config: secrets are never in warnings; bad values fall back', () => {
  const config = testConfig({ REDDIT_CLIENT_ID: 'my-client', REDDIT_CLIENT_SECRET: 'super-secret-value', SCRAPER_MAX_ITEMS: 'abc', REDDIT_BASE_URL: 'not a url' });
  assert.equal(config.maxItems, 5000);
  assert.equal(config.redditBaseUrl, 'https://www.reddit.com');
  assert.deepEqual(config.oauth, { clientId: 'my-client', clientSecret: 'super-secret-value' });
  assert.ok(config.warnings.length >= 2);
  assert.ok(config.warnings.every(w => !w.includes('super-secret-value')));
  const half = testConfig({ REDDIT_CLIENT_ID: 'only-id' });
  assert.equal(half.oauth, null);
  assert.ok(config.wispPorts.includes(443));
  assert.ok(config.wispHostPatterns.some(re => re.test('www.reddit.com')));
  assert.ok(!config.wispHostPatterns.some(re => re.test('reddit.com.evil.io')));
  assert.ok(!config.wispHostPatterns.some(re => re.test('example.com')));
});
