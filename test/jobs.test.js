const test = require('node:test');
const assert = require('node:assert/strict');
const { JobManager } = require('../scraper/jobs/job-manager');
const { runStandardScrape } = require('../scraper/reddit/standard-scraper');
const { HostRateLimiter } = require('../scraper/network/rate-limiter');
const { RedditHttpClient } = require('../scraper/network/reddit-http');
const { normalizeTarget, normalizeOptions } = require('../scraper/reddit/targets');
const { ScraperError } = require('../scraper/errors');
const { testConfig, FakeTransport, json } = require('./helpers/harness');
const { post, listing } = require('./helpers/mock-reddit');

function manager(runners, env) {
  const config = testConfig(env);
  return new JobManager({ config, http: { mode: 'public' }, runners, logToConsole: false });
}
const spec = (extra) => Object.assign({ mode: 'standard', target: { label: 't' }, options: { maxItems: 10 } }, extra || {});
const done = (jobs, job) => new Promise(resolve => {
  if (['completed', 'failed', 'cancelled'].includes(job.status)) return resolve(job);
  jobs.on('event', function on(j, type, payload) {
    if (j === job && type === 'status' && ['completed', 'failed', 'cancelled'].includes(payload.status)) { jobs.off('event', on); resolve(job); }
  });
});

test('job status transitions: queued → running → completed, with events', async () => {
  const statuses = [];
  const jobs = manager({ standard: async (job, ctx) => { ctx.emit([{ record_type: 'post', fullname: 't3_a' }]); ctx.progress({ pagesFetched: 1 }); } });
  jobs.on('event', (j, type, p) => { if (type === 'status') statuses.push(p.status); });
  const job = jobs.create(spec());
  assert.equal(job.status, 'running', 'starts immediately when a slot is free');
  await done(jobs, job);
  assert.deepEqual(statuses, ['running', 'completed']);
  const s = jobs.summary(job);
  assert.equal(s.itemCount, 1);
  assert.equal(s.progress.pagesFetched, 1);
  assert.ok(s.startedAt && s.finishedAt && s.durationMs >= 0);
  assert.throws(() => jobs.transition(job, 'running'), /Invalid job transition/);
});

test('jobs are queued beyond the concurrency limit and start in order', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const jobs = manager({ standard: async () => { await gate; } }, { SCRAPER_MAX_CONCURRENT_JOBS: '1' });
  const a = jobs.create(spec());
  const b = jobs.create(spec());
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'queued');
  assert.match(b.progress.message, /Queued/);
  release();
  await done(jobs, a);
  await done(jobs, b);
  assert.equal(b.status, 'completed');
});

test('cancellation: queued jobs cancel immediately; running jobs stop and keep partial results', async () => {
  const jobs = manager({
    standard: async (job, ctx) => {
      ctx.emit([{ record_type: 'post', fullname: 't3_1' }]);
      await new Promise((resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
    }
  }, { SCRAPER_MAX_CONCURRENT_JOBS: '1' });
  const running = jobs.create(spec());
  const queued = jobs.create(spec());
  jobs.cancel(queued.id);
  assert.equal(queued.status, 'cancelled');
  jobs.cancel(running.id);
  await done(jobs, running);
  assert.equal(running.status, 'cancelled');
  assert.equal(running.records.length, 1);
  assert.ok(running.logs.some(l => /Cancelled after 1 item/.test(l.message)));
});

test('failures: scraper errors keep their message; unexpected errors are generic', async () => {
  const jobs = manager({
    standard: async (job) => {
      if (job.label === 'known') throw new ScraperError('forbidden', 'Reddit refused access (HTTP 403).');
      throw new Error('secret internal detail /home/user/.env');
    }
  });
  const known = jobs.create(spec({ label: 'known' }));
  const unknown = jobs.create(spec({ label: 'other' }));
  await done(jobs, known);
  await done(jobs, unknown);
  assert.equal(known.status, 'failed');
  assert.deepEqual(known.error, { type: 'forbidden', message: 'Reddit refused access (HTTP 403).' });
  assert.equal(unknown.error.type, 'internal_error');
  assert.ok(!/secret|\.env/.test(unknown.error.message));
  assert.ok(!unknown.logs.some(l => /secret internal/.test(l.message)));
});

test('empty results complete with a notice; records are de-duplicated and capped', async () => {
  const jobs = manager({
    standard: async (job, ctx) => {
      if (job.label === 'empty') return;
      const left = ctx.emit([{ fullname: 't3_a' }, { fullname: 't3_a' }, { fullname: 't3_b' }, 'not an object', null, { fullname: 't3_c' }]);
      assert.equal(left, 0);
    }
  });
  const empty = jobs.create(spec({ label: 'empty' }));
  await done(jobs, empty);
  assert.equal(empty.status, 'completed');
  assert.equal(empty.meta.empty, true);
  assert.ok(empty.logs.some(l => l.level === 'warn' && /without results/.test(l.message)));

  const capped = jobs.create(spec({ options: { maxItems: 2 } }));
  await done(jobs, capped);
  assert.deepEqual(capped.records.map(r => r.fullname), ['t3_a', 't3_b']);
  assert.equal(capped.progress.duplicates, 1);
});

test('results query: type filter, search and paging', async () => {
  const jobs = manager({ standard: async (job, ctx) => ctx.emit([
    { record_type: 'post', fullname: 't3_1', title: 'Climate news' },
    { record_type: 'comment', fullname: 't1_1', body: 'about climate' },
    { record_type: 'comment', fullname: 't1_2', body: 'unrelated' }
  ]) });
  const job = jobs.create(spec());
  await done(jobs, job);
  assert.equal(jobs.query(job, { type: 'comment' }).total, 2);
  assert.equal(jobs.query(job, { search: 'CLIMATE' }).total, 2);
  const page = jobs.query(job, { offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.records[0].fullname, 't1_1');
});

test('old finished jobs are pruned; logs are capped', async () => {
  let now = Date.now();
  const config = testConfig({ SCRAPER_JOB_RETENTION_MINUTES: '1', SCRAPER_MAX_STORED_JOBS: '3' });
  const jobs = new JobManager({ config, http: {}, runners: { standard: async (job, ctx) => { for (let i = 0; i < 1100; i++) ctx.log('info', 'x' + i); } }, now: () => now, logToConsole: false });
  const old = jobs.create(spec());
  await done(jobs, old);
  assert.equal(old.logs.length, 1000);
  assert.ok(old.logsDropped > 0);
  now += 2 * 60000;
  const fresh = jobs.create(spec());
  assert.equal(jobs.get(old.id), null, 'expired job removed');
  await done(jobs, fresh);
  for (let i = 0; i < 4; i++) await done(jobs, jobs.create(spec()));
  assert.ok(jobs.list().length <= 3);
});

// The standard scraper against a scripted Reddit (no network).
function standardHarness(handler, env) {
  const config = testConfig(env);
  const transport = new FakeTransport(handler);
  const http = new RedditHttpClient({ config, transport, limiter: new HostRateLimiter({ maxConcurrent: 2 }) });
  const jobs = new JobManager({ config, http, runners: { standard: (job, ctx) => runStandardScrape(job.target, job.options, ctx) }, logToConsole: false });
  return { jobs, transport, config };
}

test('standard scraper: paginates with "after", stops at item and page limits', async () => {
  const { jobs, transport, config } = standardHarness(req => {
    const u = new URL(req.url);
    if (u.pathname === '/robots.txt') return { status: 404 };
    if (u.pathname.endsWith('/about.json')) return json({ kind: 't5', data: { display_name: 'test', subscribers: 5 } });
    const after = u.searchParams.get('after');
    const start = after ? Number(after.split('_')[1]) : 0;
    const limit = Number(u.searchParams.get('limit'));
    const kids = [];
    for (let i = start; i < start + limit; i++) kids.push(post('test', i));
    return json(listing(kids, 'x_' + (start + limit)));
  });
  const target = normalizeTarget({ type: 'subreddit', subreddit: 'test', sort: 'new' });
  const options = normalizeOptions({ maxItems: 250, maxPages: 2 }, config);
  const job = jobs.create({ mode: 'standard', target, options });
  await done(jobs, job);
  assert.equal(job.status, 'completed', JSON.stringify(job.error));
  assert.equal(job.records.length, 200, 'two pages of 100');
  assert.equal(job.progress.pagesFetched, 2);
  assert.equal(job.meta.subreddit.subscribers, 5);
  const pages = transport.requests.filter(r => r.url.includes('/r/test/new.json'));
  assert.equal(new URL(pages[1].url).searchParams.get('after'), 'x_100');
  assert.ok(job.logs.some(l => /page limit/.test(l.message)));
});

test('standard scraper: network failure after retries fails the job with a clear message', async () => {
  const { classifyTransportError } = require('../scraper/errors');
  const { jobs } = standardHarness(req => {
    if (req.url.endsWith('/robots.txt')) return { status: 404 };
    throw classifyTransportError(new Error('dns error: failed to lookup address information'));
  });
  jobs.http.backoff = () => 5;
  const job = jobs.create({ mode: 'standard', target: normalizeTarget({ type: 'search', query: 'x' }), options: normalizeOptions({ retries: 1 }, testConfig()) });
  await done(jobs, job);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.type, 'network');
  assert.match(job.error.message, /internet connection/);
  assert.ok(job.logs.some(l => /Retrying/.test(l.message)));
});
