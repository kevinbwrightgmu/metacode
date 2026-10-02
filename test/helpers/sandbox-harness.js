// Runs custom scraper code through the real sandbox runner with a fake
// Reddit HTTP client (shared by the JavaScript and Python sandbox tests).
const { createCustomRunner } = require('../../scraper/sandbox/custom-runner');
const { listing, post } = require('./mock-reddit');

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
        if (r.status < 200 || r.status >= 300) throw require('../../scraper/errors').httpError(r.status, null, r);
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
  return { run: (code, language, extra) => run(Object.assign(job(code, language), extra || {}), ctx), out, ac };
}

module.exports = { harness };
