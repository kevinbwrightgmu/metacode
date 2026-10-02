const test = require('node:test');
const assert = require('node:assert/strict');
const { createCustomRunner, sandboxSupported, validateCode } = require('../scraper/sandbox/custom-runner');
const { ScraperError } = require('../scraper/errors');
const { listing, post } = require('./helpers/mock-reddit');

const supported = sandboxSupported().ok;

function harness(httpOverride, limits) {
  const run = createCustomRunner({ config: Object.assign({ customMemoryMb: 32, customTimeoutMs: 4000 }, limits || {}) });
  const out = { records: [], logs: [], progress: [], meta: {}, calls: [] };
  const ac = new AbortController();
  const ctx = {
    signal: ac.signal,
    emit: r => { out.records.push(...r); return 100; },
    log: (level, message) => out.logs.push(level + ' ' + message),
    progress: p => out.progress.push(p),
    setMeta: (k, v) => { out.meta[k] = v; },
    requestOpts: { signal: ac.signal },
    http: Object.assign({
      mode: 'public',
      buildApiUrl: (p, q) => 'https://www.reddit.com' + p + '.json' + (q ? '?' + new URLSearchParams(q) : ''),
      // Same contract as RedditHttpClient.getJson, on top of this fake request().
      async getJson(p, opts) {
        const r = await this.request(this.buildApiUrl(p, opts && opts.query), opts);
        if (r.status < 200 || r.status >= 300) throw require('../scraper/errors').httpError(r.status, null, r);
        return { json: JSON.parse(r.body), url: r.url, headers: r.headers };
      },
      request: async (url, opts) => {
        out.calls.push({ url, opts });
        const u = new URL(url);
        if (u.pathname.startsWith('/comments/')) {
          const p = post('test', 1);
          return { status: 200, url, headers: { 'content-type': 'application/json', 'set-cookie': 'secret=1' }, body: JSON.stringify([listing([p]), listing([
            { kind: 't1', data: { id: 'c1', name: 't1_c1', link_id: 't3_x', parent_id: 't3_x', body: 'hi', replies: '' } },
            { kind: 'more', data: { count: 3 } }])]) };
        }
        const after = u.searchParams.get('after');
        const kids = after ? [post('test', 3)] : [post('test', 1), post('test', 2)];
        return { status: 200, url, statusText: 'OK', headers: { 'content-type': 'application/json', 'set-cookie': 'secret=1' }, body: JSON.stringify(listing(kids, after ? null : 't3_next')) };
      }
    }, httpOverride || {})
  };
  const job = (code, language) => ({ code, language: language || 'javascript', target: { type: 'subreddit', subreddit: 'test' }, options: { maxItems: 50, maxPages: 3, commentLimit: 10, commentDepth: 3 }, params: { n: 2 } });
  return { run: (code, language) => run(job(code, language), ctx), out, ac };
}

test('custom code input validation', () => {
  assert.throws(() => validateCode('', 'javascript'), /Write your scraper code/);
  assert.throws(() => validateCode('x'.repeat(300 * 1024), 'javascript'), /too long/);
  assert.throws(() => validateCode('x', 'python'), /javascript or typescript/);
});

test('custom scraper execution: SDK pagination, emit, return value, logs, meta', { skip: !supported }, async () => {
  const h = harness();
  await h.run(`
    async function scrape(ctx) {
      let pages = 0;
      for await (const page of ctx.reddit.pages('/r/' + ctx.target.subreddit + '/new')) {
        pages++;
        ctx.emit(page.records);
      }
      console.log('params', ctx.params.n, 'pages', pages);
      const { post, comments, moreCount } = await ctx.reddit.post('x');
      return { data: [{ custom: true, comments: comments.length, more: moreCount, title: post.title }], meta: { pages } };
    }`);
  assert.deepEqual(h.out.records.slice(0, 3).map(r => r.post_id), ['tes001', 'tes002', 'tes003']);
  assert.deepEqual(h.out.records[3], { custom: true, comments: 1, more: 3, title: 'Post 1 in test' });
  assert.deepEqual(h.out.meta.custom, { pages: 2 });
  assert.ok(h.out.logs.some(l => l === 'info [code] params 2 pages 2'));
  assert.equal(h.out.calls[1].url.includes('after=t3_next'), true);
});

test('custom scraper: ctx.fetch returns a Response-like object with filtered headers', { skip: !supported }, async () => {
  const h = harness();
  await h.run(`
    async function scrape(ctx) {
      const r = await ctx.fetch('https://www.reddit.com/r/test/new.json', { headers: { accept: 'application/json' } });
      const body = await r.json();
      return [{ ok: r.ok, status: r.status, type: r.headers.get('content-type'), cookie: r.headers.get('set-cookie'), n: body.data.children.length }];
    }`);
  assert.deepEqual(h.out.records, [{ ok: true, status: 200, type: 'application/json', cookie: null, n: 2 }]);
});

test('custom scraper: TypeScript is supported', { skip: !supported }, async () => {
  const h = harness();
  await h.run('interface R { n: number }\nconst scrape = async (ctx: any): Promise<R[]> => [{ n: ctx.params.n as number }];', 'typescript');
  assert.deepEqual(h.out.records, [{ n: 2 }]);
});

test('custom scraper failure: exceptions, syntax errors and missing scrape()', { skip: !supported }, async () => {
  const h = harness();
  await assert.rejects(h.run('async function scrape() { throw new Error("boom") }'), err => err.type === 'custom_code_error' && /boom/.test(err.message) && /scraper\.js:1/.test(err.message));
  await assert.rejects(h.run('async function scrape( {'), err => err.type === 'custom_code_error' && /SyntaxError/.test(err.message));
  await assert.rejects(h.run('function other() {}'), err => /Define a function named scrape/.test(err.message));
  await assert.rejects(h.run('async function scrape() { return 42 }'), err => /must return an array/.test(err.message));
});

test('custom scraper: host errors (e.g. blocked host) reach the code and keep their type', { skip: !supported }, async () => {
  const h = harness({ request: async () => { throw new ScraperError('host_not_allowed', 'The scraper may only request Reddit.'); } });
  await assert.rejects(h.run('async function scrape(ctx) { await ctx.fetch("https://example.com/") }'), err => err.type === 'host_not_allowed');
  const caught = harness({ request: async () => { throw new ScraperError('rate_limited', 'Reddit is rate-limiting'); } });
  await caught.run('async function scrape(ctx) { try { await ctx.fetch("https://www.reddit.com/") } catch (e) { return [{ type: e.type, msg: e.message }] } }');
  assert.deepEqual(caught.out.records, [{ type: 'rate_limited', msg: 'Reddit is rate-limiting' }]);
});

test('custom scraper timeout: infinite loops and endless waits are stopped', { skip: !supported }, async () => {
  const h = harness(null, { customTimeoutMs: 1500 });
  const t0 = Date.now();
  await assert.rejects(h.run('async function scrape() { while (true) {} }'), err => err.type === 'custom_code_timeout');
  assert.ok(Date.now() - t0 < 6000);
  const w = harness({ request: () => new Promise(() => {}) }, { customTimeoutMs: 1000 });
  await assert.rejects(w.run('async function scrape(ctx) { await ctx.fetch("https://www.reddit.com/") }'), err => err.type === 'custom_code_timeout');
});

test('custom scraper memory limit', { skip: !supported }, async () => {
  const h = harness(null, { customMemoryMb: 16 });
  await assert.rejects(h.run('async function scrape() { const a = []; while (true) a.push("x".repeat(100000) + Math.random()); }'), err => ['custom_code_memory', 'custom_code_timeout'].includes(err.type));
});

test('sandbox isolation: no Node globals, no host objects, no environment', { skip: !supported }, async () => {
  process.env.METACODE_TEST_SECRET = 'do-not-leak';
  const h = harness();
  await h.run(`
    async function scrape(ctx) {
      const probes = {};
      probes.process = typeof process;
      probes.require = typeof require;
      probes.globalFetch = typeof fetch;
      probes.setTimeout = typeof setTimeout;
      probes.hostFunction = typeof __host_call;
      probes.viaConstructor = (function () { try { return ctx.fetch.constructor.constructor('return typeof process')(); } catch (e) { return 'error'; } })();
      probes.viaThis = (function () { try { return typeof Function('return this')().process; } catch (e) { return 'error'; } })();
      probes.frozen = Object.isFrozen(ctx);
      return [probes];
    }`);
  assert.deepEqual(h.out.records[0], {
    process: 'undefined', require: 'undefined', globalFetch: 'undefined', setTimeout: 'undefined', hostFunction: 'undefined',
    viaConstructor: 'undefined', viaThis: 'undefined', frozen: true
  });
  delete process.env.METACODE_TEST_SECRET;
});

test('sandbox process: Node permission model blocks files, child processes and env', { skip: !supported }, async () => {
  // Starts the sandbox child directly with the same flags and asks Node (not
  // QuickJS) what it can do — the second layer of isolation.
  const { fork } = require('child_process');
  const path = require('path');
  const probe = path.join(__dirname, 'helpers', 'permission-probe.js');
  const result = await new Promise((resolve, reject) => {
    const child = fork(probe, [], { env: {}, execArgv: ['--permission', '--allow-fs-read=' + probe], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.on('message', resolve);
    child.on('error', reject);
  });
  assert.deepEqual(result, { readEnvFile: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', env: [] });
});

test('cancellation kills the sandbox', { skip: !supported }, async () => {
  const h = harness({ request: () => new Promise(() => {}) }, { customTimeoutMs: 20000 });
  const p = h.run('async function scrape(ctx) { ctx.emit({ a: 1 }); await ctx.fetch("https://www.reddit.com/") }');
  setTimeout(() => h.ac.abort(new ScraperError('cancelled', 'The job was cancelled.')), 500);
  await assert.rejects(p, err => err.type === 'cancelled');
  assert.deepEqual(h.out.records, [{ a: 1 }]);
});
