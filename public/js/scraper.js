/* ══════════════════════════════════════════════
   scraper.js — Reddit Scraper page

   Two modes:
     • Standard — pick a target (subreddit, search, post, profile, any Reddit
       URL…) and limits; the server scrapes and normalizes the data.
     • Custom code — write scrape(ctx) in Python, JavaScript or TypeScript; it runs on
       the server in an isolated sandbox (Python in Pyodide, JavaScript/TypeScript in QuickJS) with a small SDK.
   Jobs run on the server (/api/scraper); this page starts them, follows
   their progress over server-sent events, shows and exports the results,
   and can add them to the project as posts for coding.
   ══════════════════════════════════════════════ */

const RedditScraper = (() => {

  const API = '/api/scraper';
  const FORM_KEY = 'metacode_scraper_form_v1';   // per-browser form memory (not project data)
  const FINISHED = ['completed', 'failed', 'cancelled'];
  const CM_VERSION = '5.65.21';
  const CM_BASE = 'https://cdn.jsdelivr.net/npm/codemirror@' + CM_VERSION + '/';

  const TARGETS = [
    { id: 'subreddit',       label: 'Subreddit' },
    { id: 'search',          label: 'Search' },
    { id: 'post',            label: 'Post + comments' },
    { id: 'user',            label: 'User profile' },
    { id: 'url',             label: 'Any Reddit URL' },
    { id: 'listing',         label: 'Front page / domain' },
    { id: 'subreddit_about', label: 'Subreddit info' },
    { id: 'user_about',      label: 'User info' }
  ];
  const SORTS = {
    subreddit: ['hot', 'new', 'top', 'rising', 'controversial'],
    search:    ['relevance', 'hot', 'top', 'new', 'comments'],
    user:      ['new', 'hot', 'top', 'controversial'],
    listing:   ['hot', 'best', 'new', 'top', 'rising', 'controversial'],
    comments:  ['confidence', 'top', 'new', 'controversial', 'old', 'qa']
  };
  const TIMES = ['hour', 'day', 'week', 'month', 'year', 'all'];
  const TYPE_BADGE = { post: 'badge-blue', comment: 'badge-teal', subreddit: 'badge-violet', user: 'badge-amber' };
  const STATUS_BADGE = { queued: 'badge-gray', running: 'badge-blue', completed: 'badge-green', failed: 'badge-red', cancelled: 'badge-amber' };

  const LANGUAGES = [
    { id: 'python', label: 'Python' },
    { id: 'javascript', label: 'JavaScript' },
    { id: 'typescript', label: 'TypeScript' }
  ];

  const TEMPLATES = {
    'py-subreddit-posts': {
      label: 'Subreddit posts (pagination)',
      language: 'python',
      code:
`# Collects posts from a subreddit, page by page.
# ctx.target is the target chosen in the form (or None); ctx.params is the JSON below.
async def scrape(ctx):
    sub = (ctx.target or {}).get("subreddit") or ctx.params.get("subreddit", "AskScience")
    sort = ctx.params.get("sort", "new")
    ctx.log.info(f"Scraping r/{sub} ({sort})")

    count = 0
    async for page in ctx.reddit.pages(f"/r/{sub}/{sort}"):
        for post in page["records"]:
            if ctx.remaining() == 0:      # item limit reached
                return
            ctx.emit(post)                # normalized post record
            count += 1
        ctx.progress(f"{count} posts so far")
` },
    'py-keywords': {
      label: 'Keyword matches across subreddits (regex)',
      language: 'python',
      code:
`# Scans new posts in several subreddits and keeps those matching keywords.
# Parameters example: { "subreddits": ["science", "environment"], "keywords": ["climate", "emission"] }
import re
from collections import Counter

async def scrape(ctx):
    subs = ctx.params.get("subreddits", ["science"])
    words = ctx.params.get("keywords", ["climate"])
    pattern = re.compile(r"\\b(" + "|".join(map(re.escape, words)) + r")\\w*", re.IGNORECASE)
    hits = Counter()

    for sub in subs:
        result = await ctx.reddit.listing(f"/r/{sub}/new", max_pages=2)
        for post in result["items"]:
            text = post.get("full_text") or f"{post['title'] or ''} {post['selftext'] or ''}"
            found = sorted({m.lower() for m in pattern.findall(text)})
            if found:
                hits.update(found)
                ctx.emit({**post, "matched_keywords": ";".join(found)})
        ctx.log.info(f"r/{sub}: scanned {len(result['items'])} posts")
        if ctx.remaining() == 0:
            break

    return {"meta": {"keyword_counts": dict(hits.most_common())}}
` },
    'py-post-comments': {
      label: 'Post comments + text statistics',
      language: 'python',
      code:
`# Fetches one post and its comment tree; adds word counts and reply depth stats.
# Use the "Post + comments" target (or set { "postId": "abc123" } in parameters).
import statistics

async def scrape(ctx):
    post_id = (ctx.target or {}).get("postId") or ctx.params.get("postId")
    if not post_id:
        raise ValueError("Choose a post target or set params.postId")

    thread = await ctx.reddit.post(post_id, limit=200, depth=8, sort="top")
    ctx.emit(thread["post"])
    comments = [{**c, "word_count": len((c["body"] or "").split())} for c in thread["comments"]]
    ctx.emit(comments)

    if thread["more_count"]:
        ctx.log.warn(f"{thread['more_count']} collapsed comments were not loaded")
    counts = [c["word_count"] for c in comments] or [0]
    return {"meta": {
        "post_title": thread["post"]["title"],
        "comments": len(comments),
        "median_words": statistics.median(counts),
        "max_depth": max((c["depth"] or 0 for c in comments), default=0),
    }}
` },
    'py-author-summary': {
      label: 'Per-author summary of a subreddit',
      language: 'python',
      code:
`# Builds one summary row per author from a subreddit's top posts.
# Parameters example: { "subreddit": "dataisbeautiful", "t": "month" }
from collections import defaultdict

async def scrape(ctx):
    sub = (ctx.target or {}).get("subreddit") or ctx.params.get("subreddit", "dataisbeautiful")
    result = await ctx.reddit.listing(f"/r/{sub}/top", query={"t": ctx.params.get("t", "month")}, max_pages=3)

    authors = defaultdict(lambda: {"posts": 0, "score": 0, "comments": 0, "titles": []})
    for post in result["items"]:
        a = authors[post["author"] or "[deleted]"]
        a["posts"] += 1
        a["score"] += post["score"] or 0
        a["comments"] += post["num_comments"] or 0
        a["titles"].append(post["title"])

    rows = [{"author": name, "subreddit": sub, "posts": a["posts"], "total_score": a["score"],
             "avg_score": round(a["score"] / a["posts"], 1), "total_comments": a["comments"],
             "top_title": a["titles"][0]}
            for name, a in authors.items()]
    rows.sort(key=lambda r: r["total_score"], reverse=True)
    ctx.log.info(f"{len(result['items'])} posts from {len(rows)} authors")
    return rows
` },
    'py-raw-fetch': {
      label: 'Raw fetch + manual parsing + retries',
      language: 'python',
      code:
`# Low-level example: ctx.fetch() with ctx.retry(), parsing the JSON yourself.
# ctx.fetch only reaches Reddit, uses GET/HEAD, and is rate-limited by the server.
async def scrape(ctx):
    sub = ctx.params.get("subreddit", "AskHistorians")

    async def get(attempt):
        r = await ctx.fetch(f"https://www.reddit.com/r/{sub}/top.json?t=week&limit=25&raw_json=1")
        if r.status == 429 or r.status >= 500:
            raise RuntimeError(f"HTTP {r.status}")
        return r

    res = await ctx.retry(get, retries=2, delay=5)
    res.raise_for_status()
    return [{
        "id": child["data"]["id"],
        "title": child["data"]["title"],
        "score": child["data"]["score"],
        "created_at": ctx.reddit.to_iso(child["data"]["created_utc"]),
        "text": ctx.utils.strip_html(child["data"].get("selftext_html") or ""),
    } for child in res.json()["data"]["children"]]
` },
    'subreddit-posts': {
      label: 'Subreddit posts (pagination)',
      code:
`// Collects posts from a subreddit, page by page.
// ctx.target is the target chosen in the form (or null); ctx.params is the JSON below.
async function scrape(ctx) {
  const sub = (ctx.target && ctx.target.subreddit) || ctx.params.subreddit || 'AskScience';
  const sort = ctx.params.sort || 'new';
  ctx.log.info('Scraping r/' + sub + ' (' + sort + ')');

  let count = 0;
  for await (const page of ctx.reddit.pages('/r/' + sub + '/' + sort)) {
    for (const post of page.records) {
      if (ctx.remaining() === 0) return;        // item limit reached
      ctx.emit(post);                            // normalized post record
      count++;
    }
    ctx.progress({ message: count + ' posts so far' });
  }
}
` },
    'keyword-filter': {
      label: 'Keyword filter across subreddits',
      code:
`// Scans new posts in several subreddits and keeps those mentioning a keyword.
// Parameters example: { "subreddits": ["science", "environment"], "keywords": ["climate", "emissions"] }
async function scrape(ctx) {
  const subs = ctx.params.subreddits || ['science'];
  const keywords = (ctx.params.keywords || ['climate']).map(k => k.toLowerCase());

  for (const sub of subs) {
    const { items } = await ctx.reddit.listing('/r/' + sub + '/new', { maxPages: 2 });
    for (const post of items) {
      const text = (post.full_text || (post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
      const matched = keywords.filter(k => text.includes(k));
      if (matched.length) ctx.emit({ ...post, matched_keywords: matched.join(';') });
    }
    ctx.log.info('r/' + sub + ': scanned ' + items.length + ' posts');
    if (ctx.remaining() === 0) break;
  }
}
` },
    'post-comments': {
      label: 'Post comments with reply depth',
      code:
`// Fetches one post and its comment tree; adds a word count to each comment.
// Use the "Post + comments" target (or set { "postId": "abc123" } in parameters).
async function scrape(ctx) {
  const id = (ctx.target && ctx.target.postId) || ctx.params.postId;
  if (!id) throw new Error('Choose a post target or set params.postId');

  const { post, comments, moreCount } = await ctx.reddit.post(id, { limit: 200, depth: 8, sort: 'top' });
  ctx.emit(post);
  ctx.emit(comments.map(c => ({ ...c, word_count: (c.body || '').split(/\\s+/).filter(Boolean).length })));
  if (moreCount) ctx.log.warn(moreCount + ' collapsed comments were not loaded');
  return { meta: { post_title: post.title, comments: comments.length } };
}
` },
    'raw-fetch': {
      label: 'Raw fetch + manual parsing + retries',
      code:
`// Low-level example: ctx.fetch() with ctx.retry(), parsing the JSON yourself.
// ctx.fetch only reaches Reddit, uses GET/HEAD, and is rate-limited by the server.
async function scrape(ctx) {
  const sub = ctx.params.subreddit || 'AskHistorians';
  const res = await ctx.retry(async () => {
    const r = await ctx.fetch('https://www.reddit.com/r/' + sub + '/top.json?t=week&limit=25&raw_json=1');
    if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
    return r;
  }, { retries: 2, delayMs: 5000 });

  if (!res.ok) throw new Error('Reddit answered HTTP ' + res.status);
  const json = await res.json();
  return json.data.children.map(child => ({
    id: child.data.id,
    title: child.data.title,
    score: child.data.score,
    created_at: ctx.reddit.toIso(child.data.created_utc),
    text: ctx.utils.stripHtml(child.data.selftext_html || '')
  }));
}
` },
    'typescript': {
      label: 'TypeScript example',
      language: 'typescript',
      code:
`// TypeScript: type annotations are stripped before the code runs.
interface Row { subreddit: string; title: string | null; score: number | null }

async function scrape(ctx: any): Promise<{ data: Row[] }> {
  const subs: string[] = ctx.params.subreddits || ['programming', 'learnprogramming'];
  const data: Row[] = [];
  for (const sub of subs) {
    const { items } = await ctx.reddit.listing('/r/' + sub + '/hot', { maxPages: 1, maxItems: 10 });
    for (const p of items) data.push({ subreddit: sub, title: p.title, score: p.score });
  }
  return { data };
}
` }
  };

  let status = null;
  let form = loadForm();
  let job = null;            // current job (detail view from the server)
  let records = [];          // its records, loaded incrementally
  let logs = [];
  let es = null;             // EventSource for the current job
  let fetching = false, refetch = false;
  let durationTimer = null;
  let editor = null;         // CodeMirror instance (null → textarea fallback)
  let jobsList = [];
  let browserOpen = false;
  const view = { tab: 'table', search: '', type: 'all', sort: 'created_desc', shown: 200 };

  /* ── Form memory ──────────────────────────── */
  function defaultForm() {
    return {
      mode: 'standard',
      target: { type: 'subreddit', subreddit: '', sort: 'hot', time: 'day', query: '', searchSubreddit: '', searchSort: 'relevance',
        searchTime: 'all', postId: '', commentSort: 'confidence', username: '', section: 'overview', userSort: 'new', userTime: 'all',
        url: '', domain: '', listingSort: 'hot', listingTime: 'day' },
      customTarget: 'none',
      options: { maxItems: 100, maxPages: 5, delaySec: null, timeoutSec: null, concurrency: 1, retries: 2,
        includeComments: false, commentPosts: 10, commentLimit: 100, commentDepth: 5, includeMetadata: true },
      language: 'python',
      code: TEMPLATES['py-subreddit-posts'].code,
      params: '{\n  "subreddit": "AskScience"\n}',
      engine: null,             // null = the server's default (browser without API credentials)
      lastJobId: null
    };
  }
  function loadForm() {
    const base = defaultForm();
    try {
      const saved = JSON.parse(localStorage.getItem(FORM_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        return Object.assign(base, saved, {
          target: Object.assign(base.target, saved.target || {}),
          options: Object.assign(base.options, saved.options || {})
        });
      }
    } catch (e) { /* unreadable form memory: start fresh */ }
    return base;
  }
  function saveForm() {
    try { localStorage.setItem(FORM_KEY, JSON.stringify(form)); } catch (e) { /* storage full or blocked: form just isn't remembered */ }
  }

  /* ── Helpers ──────────────────────────────── */
  const esc = s => App.esc(s);
  const $ = id => document.getElementById(id);

  async function api(path, opts) {
    opts = opts || {};
    const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
    let res;
    try {
      res = await fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    } catch (e) {
      throw new Error('Couldn\'t reach the MetaCode server. Is it still running?');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || ('Request failed (HTTP ' + res.status + ')'));
      err.type = data && data.error && data.error.type;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function safeHref(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
  }
  function fmtNum(n) { return typeof n === 'number' && isFinite(n) ? n.toLocaleString() : '—'; }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDuration(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    return m + ' min ' + (s % 60) + ' s';
  }
  function jobDuration(j) {
    if (!j || !j.startedAt) return null;
    const end = j.finishedAt ? Date.parse(j.finishedAt) : Date.now();
    return end - Date.parse(j.startedAt);
  }
  function options(list, selected, labeller) {
    return list.map(v => '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(labeller ? labeller(v) : v) + '</option>').join('');
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /* ── Render ───────────────────────────────── */
  function render() {
    const container = $('view-container');
    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Reddit API Scraper</div>
          <div class="view-subtitle">The server-side scraper: Reddit API keys, RedditAPIs.com and custom code. The main Scraper is the Reddit Collector.</div>
        </div>
        <div class="view-actions">
          <a class="btn btn-ghost" href="#scraper">← Scraper</a>
          <button class="btn btn-secondary" id="sc-browser-toggle" onclick="RedditScraper.toggleBrowser()">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Browse Reddit
          </button>
        </div>
      </div>

      <div class="card sc-banner" id="sc-status"><span class="text-muted">Checking the scraper…</span></div>

      <div class="card" id="sc-api" style="margin-bottom:16px" hidden></div>

      <div class="card" id="sc-browser" style="margin-bottom:16px" hidden></div>

      <div class="sc-toolbar">
        <div class="sc-modes" role="tablist" aria-label="Scraping mode">
          <button class="sc-mode" role="tab" data-mode="standard" onclick="RedditScraper.setMode('standard')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            Standard scraper
          </button>
          <button class="sc-mode" role="tab" data-mode="custom" onclick="RedditScraper.setMode('custom')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            Custom code
          </button>
        </div>
        <div class="form-hint" id="sc-mode-hint"></div>
      </div>

      <div id="sc-custom" hidden></div>

      <div class="sc-grid">
        <div class="card">
          <div class="card-title" id="sc-target-title">Reddit target</div>
          <div class="form-group" style="margin-bottom:14px">
            <label class="form-label" for="sc-target-type">What to scrape</label>
            <select class="form-select" id="sc-target-type" onchange="RedditScraper.onTargetType(this.value)"></select>
          </div>
          <div id="sc-target-fields"></div>
          <div class="mt-3" id="sc-target-check"></div>
        </div>
        <div class="card">
          <div class="card-title">Limits &amp; politeness</div>
          <div id="sc-options"></div>
        </div>
      </div>

      <div class="sc-runbar">
        <label class="form-label" for="sc-engine" style="margin:0">Fetch Reddit through</label>
        <select class="form-select" id="sc-engine" style="width:auto" onchange="RedditScraper.setEngine(this.value)"></select>
        <button class="btn btn-primary" id="sc-start" onclick="RedditScraper.start()">Start scrape</button>
        <button class="btn btn-secondary" id="sc-cancel" onclick="RedditScraper.cancel()" hidden>Cancel job</button>
        <div class="form-error" id="sc-form-error" role="alert"></div>
      </div>

      <div class="card" id="sc-job" style="margin-bottom:16px" hidden></div>

      <div class="card" id="sc-jobs">
        <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
          Recent jobs
          <button class="btn btn-ghost btn-sm" onclick="RedditScraper.refreshJobs()" style="font-size:11.5px;padding:2px 8px">&#8635; Refresh</button>
        </div>
        <div id="sc-jobs-list"><div class="text-muted" style="font-size:12.5px">Loading…</div></div>
      </div>
    `;
    renderMode();
    renderTargetType();
    renderEngine();
    renderOptions();
    loadStatus();
    refreshJobs();
    if (job) { renderJob(); if (!FINISHED.includes(job.status) && !es) connect(job.id); }
    else if (form.lastJobId) openJob(form.lastJobId, true);
    if (browserOpen) renderBrowser();
  }

  function isActive() {
    return !!$('sc-target-fields');
  }

  async function loadStatus() {
    const el = $('sc-status');
    try {
      status = await api('/status');
    } catch (e) {
      if (el) el.innerHTML = '<span class="text-error">&#10007; ' + esc(e.message) + '</span>';
      return;
    }
    RedditBrowser.configure({ allowedHosts: status.allowedHosts });
    if (!isActive()) return;
    renderEngine();
    renderStatus();
    renderApiAccess();
    renderOptions();
    renderMode();
  }

  /* ── Reddit API access ─────────────────────── */
  // Reddit refuses logged-out requests from many networks (HTTP 403 block).
  // A free Reddit "script" app's ID and secret let the server use Reddit's
  // official API instead; they're checked with Reddit and saved on the server
  // (never shown again or sent back to the browser).
  let apiOpen = false;

  function renderApiAccess() {
    const el = $('sc-api');
    if (!el || !status || !status.enabled) return;
    el.hidden = false;
    el.innerHTML = redditApisSection() + '<hr class="divider" style="margin:16px 0">' + redditAppSection();
  }

  // RedditAPIs.com: a third-party pay-per-call Reddit data API (one bearer key).
  let rapiOpen = false;
  function redditApisSection() {
    const r = status.redditApis || {};
    const title = '<div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin:0"><span>RedditAPIs.com key ' +
      (r.configured ? '<span class="badge badge-green" style="margin-left:8px">Connected</span>' : '<span class="badge badge-gray" style="margin-left:8px">Optional · paid</span>') + '</span>';
    if (r.configured) {
      return title + (r.source === 'saved' ? '<button class="btn btn-ghost btn-sm" onclick="RedditScraper.removeRedditApisKey()">Remove</button>' : '') + '</div>' +
        '<div class="form-hint mt-2">Key ' + esc(r.keyHint || '') + (r.source === 'env' ? ' · from the server\'s .env file (REDDITAPIS_KEY)' : '') +
        (r.balance ? ' · balance at last check: ' + esc(String(r.balance.value)) : '') +
        '. Choose <strong>RedditAPIs.com</strong> under "Fetch Reddit through". Manage keys and credit at ' +
        '<a href="' + esc(r.dashboardUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--blue)">redditapis.com</a>.</div>';
    }
    return title + '<button class="btn btn-ghost btn-sm" onclick="RedditScraper.toggleRedditApis()" aria-expanded="' + rapiOpen + '">' + (rapiOpen ? 'Hide' : 'Add key') + '</button></div>' +
      '<div class="form-hint mt-2">A third-party service (not Reddit) that sells Reddit data per request with one API key — no Reddit app needed. Its own pricing and terms apply.</div>' +
      (rapiOpen ? `
      <ol style="font-size:13px;color:var(--tx-second);line-height:1.7;margin:12px 0 14px 18px">
        <li>Open <a href="${esc(r.dashboardUrl || 'https://www.redditapis.com/dashboard/api-keys')}" target="_blank" rel="noopener noreferrer" style="color:var(--blue)">redditapis.com → Dashboard → API keys</a> and copy a key.</li>
        <li>Paste it below and click <strong>Check &amp; save</strong> (the check uses their free account endpoint).</li>
      </ol>
      <div class="sc-inline">
        <input class="form-input" id="sc-rapi-key" type="password" autocomplete="off" spellcheck="false" placeholder="RedditAPIs.com API key" aria-label="RedditAPIs.com API key">
        <button class="btn btn-primary" id="sc-rapi-save" onclick="RedditScraper.saveRedditApisKey()">Check &amp; save</button>
      </div>
      <div class="form-hint mt-2">Saved on the MetaCode server (redditapis-key.json); never shown again or sent to custom code.</div>
      <div class="form-error mt-2" id="sc-rapi-error" role="alert"></div>` : '');
  }

  function toggleRedditApis() { rapiOpen = !rapiOpen; renderApiAccess(); }

  async function saveRedditApisKey() {
    const btn = $('sc-rapi-save');
    const errEl = $('sc-rapi-error');
    if (errEl) errEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      status = await api('/redditapis-key', { method: 'POST', body: { key: $('sc-rapi-key').value } });
      rapiOpen = false;
      form.engine = 'redditapis';
      saveForm();
      renderEngine(); renderStatus(); renderApiAccess(); renderOptions();
      App.notify('RedditAPIs.com key saved — jobs now use RedditAPIs.com', 'success', 4500);
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
    } finally {
      if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = 'Check & save'; }
    }
  }

  async function removeRedditApisKey() {
    if (!confirm('Remove the saved RedditAPIs.com key from this MetaCode server?')) return;
    try {
      status = await api('/redditapis-key', { method: 'DELETE' });
      if (form.engine === 'redditapis') { form.engine = null; saveForm(); }
      renderEngine(); renderStatus(); renderApiAccess(); renderOptions();
      App.notify('RedditAPIs.com key removed', 'success');
    } catch (e) { App.notify(e.message, 'error'); }
  }

  // Reddit's own API (free "script" app).
  function redditAppSection() {
    const c = status.credentials || {};
    if (c.configured) {
      return '<div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin:0">' +
        '<span>Reddit API access <span class="badge badge-green" style="margin-left:8px">Connected</span></span>' +
        (c.source === 'saved' ? '<button class="btn btn-ghost btn-sm" onclick="RedditScraper.disconnectApi()">Disconnect</button>' : '') + '</div>' +
        '<div class="form-hint mt-2">Reddit app ' + esc(c.clientIdHint || '') + (c.username ? ' · u/' + esc(c.username) : '') +
        (c.source === 'env' ? ' · from the server\'s .env file' : '') +
        '. Choose <strong>MetaCode server (Reddit API)</strong> under "Fetch Reddit through" to use it.</div>';
    }
    return '<div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin:0">' +
      '<span>Reddit API access <span class="badge badge-gray" style="margin-left:8px">Optional</span></span>' +
      '<button class="btn btn-ghost btn-sm" onclick="RedditScraper.toggleApi()" aria-expanded="' + apiOpen + '">' + (apiOpen ? 'Hide' : 'Set up') + '</button></div>' +
      '<div class="form-hint mt-2">Needed when Reddit answers "refused this request because it was made without a Reddit login or API key" (HTTP 403). Free, takes about 2 minutes.</div>' +
      (apiOpen ? `
      <ol style="font-size:13px;color:var(--tx-second);line-height:1.7;margin:12px 0 14px 18px">
        <li>Signed in to Reddit, open <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener noreferrer" style="color:var(--blue)">reddit.com/prefs/apps</a> and click <strong>create another app…</strong></li>
        <li>Name it (e.g. MetaCode), choose <strong>script</strong>, set the redirect uri to <span class="sc-code-inline">http://localhost:3000</span>, and create it.</li>
        <li>Copy the ID shown under the app's name and the <strong>secret</strong> into the fields below.</li>
      </ol>
      <div class="sc-fields">
        <div class="form-group"><label class="form-label" for="sc-api-id">Client ID</label>
          <input class="form-input" id="sc-api-id" autocomplete="off" spellcheck="false" placeholder="e.g. p-jcoLKBynTLew"></div>
        <div class="form-group"><label class="form-label" for="sc-api-secret">Secret</label>
          <input class="form-input" id="sc-api-secret" type="password" autocomplete="off" spellcheck="false"></div>
        <div class="form-group"><label class="form-label" for="sc-api-user">Your Reddit username <span>(optional — identifies your client to Reddit)</span></label>
          <input class="form-input" id="sc-api-user" autocomplete="off" spellcheck="false" placeholder="without u/"></div>
      </div>
      <div class="flex gap-3 mt-3" style="align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" id="sc-api-save" onclick="RedditScraper.connectApi()">Check &amp; save</button>
        <span class="form-hint">Saved on the MetaCode server (reddit-credentials.json); the secret is never shown again. Reddit's API terms apply.</span>
      </div>
      <div class="form-error mt-2" id="sc-api-error" role="alert"></div>` : '');
  }

  function toggleApi(open) {
    apiOpen = open === undefined ? !apiOpen : !!open;
    renderApiAccess();
    if (apiOpen) { const el = $('sc-api'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  async function connectApi() {
    const btn = $('sc-api-save');
    const errEl = $('sc-api-error');
    if (errEl) errEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Checking with Reddit…'; }
    try {
      status = await api('/credentials', { method: 'POST', body: {
        clientId: $('sc-api-id').value, clientSecret: $('sc-api-secret').value, username: $('sc-api-user').value } });
      apiOpen = false;
      form.engine = 'server';      // use the API for the next runs
      saveForm();
      renderEngine(); renderStatus(); renderApiAccess(); renderOptions();
      App.notify('Reddit API connected — jobs now use Reddit\'s API', 'success', 4500);
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
    } finally {
      if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = 'Check & save'; }
    }
  }

  async function disconnectApi() {
    if (!confirm('Remove the saved Reddit API keys from this MetaCode server?')) return;
    try {
      status = await api('/credentials', { method: 'DELETE' });
      if (form.engine === 'server') { form.engine = null; saveForm(); }
      renderEngine(); renderStatus(); renderApiAccess(); renderOptions();
      App.notify('Reddit API keys removed', 'success');
    } catch (e) { App.notify(e.message, 'error'); }
  }

  /* ── Engine: where Reddit requests are made ── */
  // "browser": this tab fetches them through Scramjet's transport (epoxy-tls
  // over MetaCode's Wisp endpoint) — no API credentials or .env setup.
  // "server": the MetaCode server fetches them (Reddit API credentials, or
  // public pages subject to robots.txt).
  function currentEngine() {
    const avail = e => !status || !status.engines || (status.engines[e] && status.engines[e].available);
    let chosen = form.engine || (status && status.defaultEngine) || 'browser';
    if (!avail(chosen)) chosen = status && avail(status.defaultEngine) ? status.defaultEngine : 'server';
    if (chosen === 'browser' && !avail('browser')) chosen = 'server';
    return chosen;
  }

  function renderEngine() {
    const sel = $('sc-engine');
    if (!sel) return;
    const engine = currentEngine();
    const browserOk = !status || (status.engines && status.engines.browser.available);
    const serverLabel = status && status.mode === 'oauth' ? 'MetaCode server (Reddit API)' : 'MetaCode server (needs Reddit API keys)';
    const rapiOk = status && status.engines && status.engines.redditapis && status.engines.redditapis.available;
    sel.innerHTML = (rapiOk ? '<option value="redditapis"' + (engine === 'redditapis' ? ' selected' : '') + '>RedditAPIs.com (API key, paid per request)</option>' : '') +
      (browserOk ? '<option value="browser"' + (engine === 'browser' ? ' selected' : '') + '>This browser (Scramjet) — no setup</option>' : '') +
      '<option value="server"' + (engine === 'server' ? ' selected' : '') + '>' + esc(serverLabel) + '</option>';
  }

  function setEngine(value) {
    form.engine = ['server', 'redditapis'].includes(value) ? value : 'browser';
    saveForm();
    renderEngine();
    renderStatus();
    renderOptions();
  }

  function engineLimits() {
    if (!status) return null;
    const e = status.engines && status.engines[currentEngine()];
    const minDelayMs = e ? e.minDelayMs : status.limits.minDelayMs;
    return Object.assign({}, status.limits, { minDelayMs, defaultDelayMs: Math.max(minDelayMs, status.limits.defaultDelayMs) });
  }

  function renderStatus() {
    const el = $('sc-status');
    if (!el || !status) return;
    if (!status.enabled) {
      el.innerHTML = '<span class="text-error">&#10007; The Reddit scraper is turned off on this server (SCRAPER_ENABLED=false in .env).</span>';
      return;
    }
    const parts = [];
    const engine = currentEngine();
    const lim = engineLimits();
    if (engine === 'redditapis') {
      const bal = status.redditApis && status.redditApis.balance;
      parts.push('<span class="badge badge-green">RedditAPIs.com</span>');
      parts.push('<span class="badge badge-gray">' + esc(transportLabel()) + '</span>');
      parts.push('<span class="text-second">Requests go to the third-party RedditAPIs.com service with your API key (billed per request by them' +
        (bal ? '; balance at last check: ' + esc(String(bal.value)) : '') + '). At least ' + (lim.minDelayMs / 1000) + ' s between requests · up to ' +
        fmtNum(lim.maxItems) + ' items per job. Supports subreddits, search, posts with comments, user posts/comments and info.</span>');
    } else if (engine === 'browser') {
      parts.push('<span class="badge badge-green">This browser (Scramjet)</span>');
      parts.push('<span class="badge badge-gray">epoxy-tls over Wisp</span>');
      parts.push('<span class="text-second">Reddit requests are made by this tab through the same connection as Browse Reddit — no API keys or setup. ' +
        'Keep MetaCode open until a job finishes. At least ' + (lim.minDelayMs / 1000) + ' s between requests · up to ' + fmtNum(lim.maxItems) + ' items per job.</span>');
    } else {
      parts.push(status.mode === 'oauth'
        ? '<span class="badge badge-green">Server · Reddit Data API (OAuth)</span>'
        : '<span class="badge badge-amber">Server · public pages (no API credentials)</span>');
      parts.push('<span class="badge badge-gray">' + esc(transportLabel()) + '</span>');
      parts.push('<span class="text-second">At least ' + (lim.minDelayMs / 1000) + ' s between requests · up to ' + fmtNum(lim.maxItems) + ' items per job</span>');
      if (!status.transport.available) parts.push('<span class="text-error">&#10007; Server-side scraping needs Node.js 22+ (found ' + esc(status.node) + ').</span>');
      if (status.mode === 'public' && status.respectRobotsTxt) {
        parts.push('<span class="sc-banner-warn">Without Reddit API credentials the server only reads pages Reddit\'s robots.txt allows, which excludes most of Reddit. ' +
          'Choose "This browser (Scramjet)" below, or add REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET to .env.</span>');
      }
      if (status.userAgentIsDefault) parts.push('<span class="sc-banner-warn">Set SCRAPER_USER_AGENT in .env so Reddit can identify your client.</span>');
    }
    el.innerHTML = parts.join('');
  }

  // Which engine makes the server's HTTPS requests (python/reddit_fetch.py, or epoxy-tls).
  function transportLabel() {
    const t = status.transport || {};
    if (t.kind === 'python' && t.python) return 'Python ' + t.python.version;
    if (t.kind === 'epoxy') return 'epoxy-tls over Wisp' + (t.setting === 'auto' && t.pythonError ? ' (Python not found)' : '');
    return t.setting === 'epoxy' ? 'epoxy-tls over Wisp' : 'Python engine';
  }

  /* ── Mode ─────────────────────────────────── */
  function setMode(mode) {
    if (mode === form.mode) return;
    syncEditorToForm();
    form.mode = mode;
    saveForm();
    renderMode();
    renderTargetType();
  }

  function renderMode() {
    document.querySelectorAll('.sc-mode').forEach(b => {
      const on = b.dataset.mode === form.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const hint = $('sc-mode-hint');
    const customBox = $('sc-custom');
    const startBtn = $('sc-start');
    if (form.mode === 'custom') {
      if (hint) hint.textContent = 'Your Python, JavaScript or TypeScript runs on the server in an isolated sandbox and can only reach Reddit.';
      if (startBtn) startBtn.textContent = 'Run custom scraper';
      if (customBox) { customBox.hidden = false; if (!customBox.dataset.ready) renderCustom(); }
      const title = $('sc-target-title'); if (title) title.textContent = 'Target (optional — passed to your code as ctx.target)';
    } else {
      if (hint) hint.textContent = 'Pick a target and limits; MetaCode collects structured posts and comments.';
      if (startBtn) startBtn.textContent = 'Start scrape';
      if (customBox) customBox.hidden = true;
      const title = $('sc-target-title'); if (title) title.textContent = 'Reddit target';
    }
    if (status && form.mode === 'custom' && !status.customCode.available && hint) {
      hint.innerHTML = '<span class="text-error">&#10007; ' + esc(status.customCode.reason || 'Custom code is unavailable.') + '</span>';
    }
  }

  /* ── Target form ──────────────────────────── */
  function renderTargetType() {
    const sel = $('sc-target-type');
    if (!sel) return;
    const list = (form.mode === 'custom' ? [{ id: 'none', label: 'No target (use ctx.params)' }] : []).concat(TARGETS);
    const current = form.mode === 'custom' ? form.customTarget : form.target.type;
    sel.innerHTML = list.map(t => '<option value="' + t.id + '"' + (t.id === current ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('');
    renderTargetFields();
  }

  function onTargetType(value) {
    if (form.mode === 'custom') form.customTarget = value;
    if (value !== 'none') form.target.type = value;
    saveForm();
    renderTargetFields();
  }

  function field(id, label, html, hint, span) {
    return '<div class="form-group' + (span ? ' sc-span' : '') + '"><label class="form-label" for="' + id + '">' + label + '</label>' + html +
      (hint ? '<div class="form-hint">' + hint + '</div>' : '') + '</div>';
  }
  function input(id, key, placeholder, extra) {
    return '<input class="form-input" id="' + id + '" data-key="' + key + '" value="' + esc(form.target[key] || '') + '" placeholder="' + esc(placeholder) +
      '" autocomplete="off" spellcheck="false" oninput="RedditScraper.onField(this)"' + (extra || '') + '>';
  }
  function select(id, key, list, labeller) {
    return '<select class="form-select" id="' + id + '" data-key="' + key + '" onchange="RedditScraper.onField(this, true)">' + options(list, form.target[key], labeller) + '</select>';
  }

  function renderTargetFields() {
    const el = $('sc-target-fields');
    if (!el) return;
    const t = form.target;
    const type = form.mode === 'custom' && form.customTarget === 'none' ? 'none' : t.type;
    let html = '';
    const timeField = (key, sortKey) => (['top', 'controversial'].includes(t[sortKey]) || sortKey === 'searchSort')
      ? field('sc-f-' + key, 'Time range', select('sc-f-' + key, key, TIMES, cap)) : '';
    switch (type) {
      case 'none':
        html = '<div class="form-hint">Your code receives <span class="sc-code-inline">ctx.target = null</span>. Use the parameters JSON for inputs.</div>';
        break;
      case 'subreddit':
        html = field('sc-f-subreddit', 'Subreddit', input('sc-f-subreddit', 'subreddit', 'e.g. AskScience  (combine with +: science+askscience)'), null, true) +
          field('sc-f-sort', 'Sort', select('sc-f-sort', 'sort', SORTS.subreddit, cap)) + timeField('time', 'sort');
        break;
      case 'search':
        html = field('sc-f-query', 'Search query', input('sc-f-query', 'query', 'e.g. climate policy  (Reddit search syntax works: title:, author:, self:yes)'), null, true) +
          field('sc-f-searchSubreddit', 'Only in subreddit <span>(optional)</span>', input('sc-f-searchSubreddit', 'searchSubreddit', 'e.g. politics')) +
          field('sc-f-searchSort', 'Sort', select('sc-f-searchSort', 'searchSort', SORTS.search, cap)) + timeField('searchTime', 'searchSort');
        break;
      case 'post':
        html = field('sc-f-postId', 'Post URL or id', input('sc-f-postId', 'postId', 'https://www.reddit.com/r/…/comments/abc123/… or abc123'), null, true) +
          field('sc-f-commentSort', 'Comment sort', select('sc-f-commentSort', 'commentSort', SORTS.comments, v => v === 'confidence' ? 'Best' : v === 'qa' ? 'Q&A' : cap(v)));
        break;
      case 'user':
        html = field('sc-f-username', 'Username', input('sc-f-username', 'username', 'e.g. spez  (without u/)'), null, true) +
          field('sc-f-section', 'Section', select('sc-f-section', 'section', ['overview', 'submitted', 'comments'], v => v === 'submitted' ? 'Posts' : cap(v))) +
          field('sc-f-userSort', 'Sort', select('sc-f-userSort', 'userSort', SORTS.user, cap)) + timeField('userTime', 'userSort');
        break;
      case 'url':
        html = field('sc-f-url', 'Reddit URL', '<div class="sc-inline">' + input('sc-f-url', 'url', 'Paste any reddit.com or redd.it link') +
          '<button class="btn btn-secondary btn-sm" type="button" onclick="RedditScraper.checkTarget()">Check</button></div>',
          'Subreddits, posts, user profiles, search pages, the front page and /domain/ listings are detected automatically.', true);
        break;
      case 'listing':
        html = field('sc-f-domain', 'Domain <span>(optional — leave empty for the front page)</span>', input('sc-f-domain', 'domain', 'e.g. nytimes.com'), null, true) +
          field('sc-f-listingSort', 'Sort', select('sc-f-listingSort', 'listingSort', SORTS.listing, cap)) + timeField('listingTime', 'listingSort');
        break;
      case 'subreddit_about':
        html = field('sc-f-subreddit', 'Subreddit', input('sc-f-subreddit', 'subreddit', 'e.g. AskScience'), 'Collects one record: name, title, description, subscribers, creation date…', true);
        break;
      case 'user_about':
        html = field('sc-f-username', 'Username', input('sc-f-username', 'username', 'e.g. spez'), 'Collects one record: account age and karma.', true);
        break;
    }
    el.innerHTML = '<div class="sc-fields">' + html + '</div>';
    const check = $('sc-target-check');
    if (check) check.innerHTML = '';
    setFormError('');
  }

  function onField(el, rerender) {
    form.target[el.dataset.key] = el.value;
    saveForm();
    if (rerender) renderTargetFields();
    const check = $('sc-target-check');
    if (check && !rerender) check.innerHTML = '';
  }

  // Form → the API's target object (throws with a friendly message).
  function buildTarget() {
    const t = form.target;
    const type = form.mode === 'custom' ? form.customTarget : t.type;
    const need = (v, msg) => { if (!String(v || '').trim()) throw new Error(msg); return String(v).trim(); };
    switch (type) {
      case 'none': return null;
      case 'subreddit': {
        const sub = need(t.subreddit, 'Enter a subreddit name.').replace(/^\/?r\//i, '');
        if (!/^[A-Za-z0-9][A-Za-z0-9_]{1,20}(\+[A-Za-z0-9][A-Za-z0-9_]{1,20})*$/.test(sub)) throw new Error('"' + sub + '" isn\'t a valid subreddit name (2–21 letters, digits or underscores).');
        return { type, subreddit: sub, sort: t.sort, time: t.time };
      }
      case 'search':
        return { type, query: need(t.query, 'Enter a search query.'), subreddit: String(t.searchSubreddit || '').trim().replace(/^\/?r\//i, ''), sort: t.searchSort, time: t.searchTime };
      case 'post':
        return { type, postId: need(t.postId, 'Enter a post URL or id.'), commentSort: t.commentSort };
      case 'user': {
        const name = need(t.username, 'Enter a username.').replace(/^\/?(u|user)\//i, '');
        if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) throw new Error('"' + name + '" isn\'t a valid Reddit username.');
        return { type, username: name, section: t.section, sort: t.userSort, time: t.userTime };
      }
      case 'url': {
        const url = need(t.url, 'Paste a Reddit URL.');
        if (!/(^|\.|\/\/)(reddit\.com|redd\.it)(\/|$|:)/i.test(url)) throw new Error('That isn\'t a Reddit URL (reddit.com or redd.it).');
        return { type, url };
      }
      case 'listing':
        return { type, domain: String(t.domain || '').trim(), sort: t.listingSort, time: t.listingTime };
      case 'subreddit_about':
        return { type, subreddit: need(t.subreddit, 'Enter a subreddit name.').replace(/^\/?r\//i, '') };
      case 'user_about':
        return { type, username: need(t.username, 'Enter a username.').replace(/^\/?(u|user)\//i, '') };
      default:
        throw new Error('Choose what to scrape.');
    }
  }

  // Asks the server to validate the target and shows what it resolved to.
  async function checkTarget() {
    const el = $('sc-target-check');
    try {
      const target = buildTarget();
      if (!target) return;
      const data = await api('/resolve', { method: 'POST', body: { target } });
      if (el) el.innerHTML = '<div class="sc-resolved">&#10003; ' + esc(data.target.label) + '</div>';
      setFormError('');
      return data.target;
    } catch (e) {
      if (el) el.innerHTML = '';
      setFormError(e.message);
      return null;
    }
  }

  function setFormError(msg) {
    const el = $('sc-form-error');
    if (el) el.textContent = msg || '';
  }

  /* ── Options ──────────────────────────────── */
  function renderOptions() {
    const el = $('sc-options');
    if (!el) return;
    const o = form.options;
    const lim = engineLimits();
    const minDelay = lim ? lim.minDelayMs / 1000 : 1;
    const delay = o.delaySec !== null && o.delaySec !== undefined && o.delaySec !== '' ? o.delaySec : (lim ? lim.defaultDelayMs / 1000 : 2);
    const timeout = o.timeoutSec !== null && o.timeoutSec !== undefined && o.timeoutSec !== '' ? o.timeoutSec : (lim ? lim.requestTimeoutMs / 1000 : 20);
    const num = (id, key, label, value, min, max, step, hint) => field(id, label,
      '<input class="form-input" type="number" id="' + id + '" data-opt="' + key + '" value="' + esc(value) + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '" oninput="RedditScraper.onOption(this)">', hint);
    const check = (id, key, label) => '<label class="sc-check"><input type="checkbox" id="' + id + '" data-opt="' + key + '"' + (o[key] ? ' checked' : '') +
      ' onchange="RedditScraper.onOption(this)"> ' + label + '</label>';
    el.innerHTML = '<div class="sc-fields">' +
      num('sc-o-maxItems', 'maxItems', 'Maximum items', o.maxItems, 1, lim ? lim.maxItems : 5000, 1, lim ? 'Server limit: ' + fmtNum(lim.maxItems) : null) +
      num('sc-o-maxPages', 'maxPages', 'Maximum pages', o.maxPages, 1, lim ? lim.maxPages : 50, 1, 'Up to 100 items per page') +
      num('sc-o-delay', 'delaySec', 'Delay between requests <span>(s)</span>', delay, minDelay, 120, 0.5, 'Minimum ' + minDelay + ' s on this server') +
      num('sc-o-timeout', 'timeoutSec', 'Request timeout <span>(s)</span>', timeout, 1, lim ? lim.requestTimeoutMs / 1000 : 120, 1) +
      num('sc-o-concurrency', 'concurrency', 'Concurrent requests', o.concurrency, 1, lim ? lim.maxConcurrentRequests : 2, 1, 'Shared politeness limit per Reddit host') +
      num('sc-o-retries', 'retries', 'Retries on failure', o.retries, 0, 5, 1, '429/5xx and network errors, with backoff') +
      '<div class="sc-span" style="display:flex;flex-direction:column;gap:8px">' +
        check('sc-o-includeComments', 'includeComments', 'Also fetch comments for listing posts') +
        '<div class="sc-fields" id="sc-comment-opts"' + (o.includeComments ? '' : ' hidden') + '>' +
          num('sc-o-commentPosts', 'commentPosts', 'Posts to fetch comments for', o.commentPosts, 1, 100, 1, 'One request per post') +
          num('sc-o-commentLimit', 'commentLimit', 'Comments per post', o.commentLimit, 1, 500, 1) +
        '</div>' +
        check('sc-o-expandMore', 'expandMore', 'Load collapsed comments ("load more") — Reddit API only, up to "Comments per post"') +
        check('sc-o-sweepSorts', 'sweepSorts', 'Subreddits: combine sorts to get past Reddit\'s ~1,000-post listing limit (Maximum pages applies to each sort)') +
        check('sc-o-includeMetadata', 'includeMetadata', 'Include subreddit / profile metadata') +
      '</div>' +
    '</div>';
  }

  function onOption(el) {
    const key = el.dataset.opt;
    if (el.type === 'checkbox') form.options[key] = el.checked;
    else form.options[key] = el.value === '' ? null : Number(el.value);
    if (key === 'includeComments') { const box = $('sc-comment-opts'); if (box) box.hidden = !el.checked; }
    saveForm();
  }

  function buildOptions() {
    const o = form.options;
    const out = {
      maxItems: o.maxItems, maxPages: o.maxPages, concurrency: o.concurrency, retries: o.retries,
      includeComments: !!o.includeComments, commentPosts: o.commentPosts, commentLimit: o.commentLimit,
      expandMore: !!o.expandMore, sweepSorts: !!o.sweepSorts,
      commentDepth: o.commentDepth, includeMetadata: o.includeMetadata !== false
    };
    const d = $('sc-o-delay'), t = $('sc-o-timeout');
    if (d && d.value !== '') out.delayMs = Math.round(Number(d.value) * 1000);
    if (t && t.value !== '') out.timeoutMs = Math.round(Number(t.value) * 1000);
    Object.keys(out).forEach(k => { if (out[k] === null || out[k] === undefined || (typeof out[k] === 'number' && !isFinite(out[k]))) delete out[k]; });
    return out;
  }

  /* ── Custom code ──────────────────────────── */
  function renderCustom() {
    const box = $('sc-custom');
    if (!box) return;
    box.dataset.ready = '1';
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="sc-editor-head">
          <div class="card-title" style="margin:0">Custom scraper code</div>
          <div class="flex gap-2" style="flex-wrap:wrap">
            <select class="form-select" id="sc-template" aria-label="Load an example" onchange="RedditScraper.loadTemplate(this.value)">
              <option value="">Load an example…</option>
              ${LANGUAGES.map(l => '<optgroup label="' + l.label + '">' + Object.keys(TEMPLATES).filter(k => templateLanguage(k) === l.id)
                .map(k => '<option value="' + k + '">' + esc(TEMPLATES[k].label) + '</option>').join('') + '</optgroup>').join('')}
            </select>
            <select class="form-select" id="sc-language" aria-label="Language" onchange="RedditScraper.setLanguage(this.value, true)">
              ${LANGUAGES.map(l => {
                const off = languageUnavailable(l.id);
                return '<option value="' + l.id + '"' + (form.language === l.id ? ' selected' : '') + (off ? ' disabled title="' + esc(off) + '"' : '') + '>' +
                  l.label + (off ? ' (unavailable)' : '') + '</option>';
              }).join('')}
            </select>
            <button class="btn btn-secondary btn-sm" type="button" onclick="RedditScraper.showApi()">API reference</button>
          </div>
        </div>
        <div class="sc-editor" id="sc-editor"></div>
        <div class="form-hint mt-2" id="sc-code-hint">${codeHint()}</div>
        <div class="form-group mt-3">
          <label class="form-label" for="sc-params">Parameters <span>(JSON object, available as ctx.params)</span></label>
          <textarea class="form-textarea sc-params" id="sc-params" spellcheck="false" oninput="RedditScraper.onParams(this.value)">${esc(form.params)}</textarea>
        </div>
      </div>`;
    mountEditor();
  }

  function loadCss(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    document.head.appendChild(l);
  }
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src="' + src + '"]');
      if (existing) { if (existing.dataset.loaded) return resolve(); existing.addEventListener('load', () => resolve()); existing.addEventListener('error', reject); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { s.dataset.loaded = '1'; resolve(); };
      s.onerror = () => reject(new Error('load failed'));
      document.head.appendChild(s);
    });
  }

  let cmPromise = null;
  function loadCodeMirror() {
    if (window.CodeMirror) return Promise.resolve(true);
    if (!cmPromise) {
      loadCss(CM_BASE + 'lib/codemirror.min.css');
      cmPromise = loadScriptOnce(CM_BASE + 'lib/codemirror.min.js')
        .then(() => Promise.all([
          loadScriptOnce(CM_BASE + 'mode/javascript/javascript.min.js'),
          loadScriptOnce(CM_BASE + 'mode/python/python.min.js'),
          loadScriptOnce(CM_BASE + 'addon/edit/matchbrackets.min.js'),
          loadScriptOnce(CM_BASE + 'addon/edit/closebrackets.min.js')
        ]))
        .then(() => true, () => false);
    }
    return cmPromise;
  }

  // The editor: CodeMirror when its CDN files load, otherwise a plain
  // monospace textarea (works offline).
  function mountEditor() {
    const host = $('sc-editor');
    if (!host) return;
    editor = null;
    host.innerHTML = '<textarea class="sc-code-fallback" id="sc-code" spellcheck="false" aria-label="Scraper code"></textarea>';
    const ta = $('sc-code');
    ta.value = form.code;
    ta.addEventListener('input', () => { form.code = ta.value; saveForm(); });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText(form.language === 'python' ? '    ' : '  ', s, ta.selectionEnd, 'end');
        form.code = ta.value; saveForm();
      }
    });
    loadCodeMirror().then(ok => {
      if (!ok || !window.CodeMirror || !document.body.contains(ta)) return;
      const indent = form.language === 'python' ? 4 : 2;
      editor = window.CodeMirror.fromTextArea(ta, {
        mode: editorMode(form.language),
        lineNumbers: true, indentUnit: indent, tabSize: indent, matchBrackets: true, autoCloseBrackets: true, lineWrapping: false,
        extraKeys: { Tab: cm => cm.execCommand(cm.somethingSelected() ? 'indentMore' : 'insertSoftTab') }
      });
      editor.on('change', () => { form.code = editor.getValue(); saveForm(); });
    });
  }

  function getCode() { return editor ? editor.getValue() : ($('sc-code') ? $('sc-code').value : form.code); }
  function setCode(code) {
    form.code = code;
    if (editor) editor.setValue(code);
    else if ($('sc-code')) $('sc-code').value = code;
    saveForm();
  }
  function syncEditorToForm() { if ($('sc-code') || editor) form.code = getCode(); }

  function loadTemplate(key) {
    const t = TEMPLATES[key];
    if (!t) return;
    const current = getCode().trim();
    const isTemplate = Object.values(TEMPLATES).some(x => x.code.trim() === current);
    if (current && !isTemplate && !confirm('Replace your code with the "' + t.label + '" example?')) {
      $('sc-template').value = '';
      return;
    }
    setCode(t.code);
    setLanguage(templateLanguage(key));
    $('sc-template').value = '';
  }

  function templateLanguage(key) { return (TEMPLATES[key] && TEMPLATES[key].language) || 'javascript'; }
  function editorMode(lang) { return lang === 'python' ? 'text/x-python' : lang === 'typescript' ? 'text/typescript' : 'text/javascript'; }
  function languageUnavailable(lang) {
    const cc = status && status.customCode;
    if (!cc) return null;
    if (lang === 'python') return cc.python && !cc.python.available ? (cc.python.reason || 'Python isn\'t available on this server.') : null;
    return cc.languages && !cc.languages.includes(lang) ? (cc.reason || 'Not available on this server.') : null;
  }
  function codeHint() {
    const cc = status && status.customCode;
    const py = form.language === 'python';
    const mem = cc ? (py && cc.python ? cc.python.memoryMb : cc.memoryMb) : null;
    return (py
      ? 'Define <span class="sc-code-inline">async def scrape(ctx)</span>. Runs in ' + (cc && cc.python ? esc(cc.python.runtime) : 'Pyodide') +
        ', with the whole standard library (<span class="sc-code-inline">re</span>, <span class="sc-code-inline">json</span>, <span class="sc-code-inline">statistics</span>, <span class="sc-code-inline">collections</span>…). '
      : 'Define <span class="sc-code-inline">async function scrape(ctx)</span>. ') +
      'Records you <span class="sc-code-inline">ctx.emit()</span> or return become the results. Limits: ' +
      (cc ? Math.round(cc.timeoutMs / 1000) + ' s, ' + mem + ' MB' : 'time and memory capped') + '; network only to Reddit through the server\'s rate limiter.';
  }

  // fromUser: picked in the language menu — an untouched example switches to
  // the same kind of example in the new language.
  function setLanguage(lang, fromUser) {
    const next = LANGUAGES.some(l => l.id === lang) ? lang : 'javascript';
    if (fromUser && next !== form.language) {
      const current = getCode().trim();
      const shown = Object.keys(TEMPLATES).find(k => TEMPLATES[k].code.trim() === current);
      const swap = { python: 'py-subreddit-posts', javascript: 'subreddit-posts', typescript: 'typescript' }[next];
      if ((!current || shown) && swap && templateLanguage(shown || '') !== next) setCode(TEMPLATES[swap].code);
    }
    form.language = next;
    const sel = $('sc-language'); if (sel) sel.value = form.language;
    if (editor) {
      const indent = next === 'python' ? 4 : 2;
      editor.setOption('mode', editorMode(next));
      editor.setOption('indentUnit', indent);
      editor.setOption('tabSize', indent);
    }
    const hint = $('sc-code-hint'); if (hint) hint.innerHTML = codeHint();
    saveForm();
  }

  function onParams(v) { form.params = v; saveForm(); }

  function showApi(lang) {
    if ((lang || form.language) === 'python') return showPythonApi();
    App.openModal('Custom scraper API — JavaScript', `
      <div class="sc-api">
        <h4>Execution model</h4>
        <p>Your code defines <code>async function scrape(ctx)</code>. It runs on the MetaCode server inside a QuickJS sandbox (a separate
        JavaScript engine compiled to WebAssembly) in its own restricted process: no <code>require</code>, files, environment variables, timers or
        direct network access. Records you <code>ctx.emit()</code> are kept even if the run later fails or is cancelled; whatever you
        <code>return</code> (an array, or <code>{ data: [...], meta: {...} }</code>) is added at the end. Every value must be JSON-serializable.</p>
        <h4>Inputs</h4>
        <dl>
          <dt>ctx.target</dt><dd>The target from the form, normalized (e.g. <code>{ type: "subreddit", subreddit, sort, time, path, label }</code>), or <code>null</code>.</dd>
          <dt>ctx.params</dt><dd>The parameters JSON object.</dd>
          <dt>ctx.options</dt><dd>Limits from the form: <code>maxItems, maxPages, delayMs, timeoutMs, concurrency, retries, commentLimit, commentDepth…</code></dd>
          <dt>ctx.mode</dt><dd><code>"oauth"</code> (Reddit Data API) or <code>"public"</code> (public pages).</dd>
        </dl>
        <h4>Reddit helpers</h4>
        <dl>
          <dt>ctx.reddit.json(path, query?)</dt><dd>GET a Reddit JSON endpoint, e.g. <code>"/r/science/new"</code> with <code>{ limit: 50 }</code>. Uses the API or public pages automatically. → parsed JSON</dd>
          <dt>ctx.reddit.pages(path, opts?)</dt><dd>Async iterator over a listing's pages: <code>for await (const page of …)</code>; each page has <code>number, records, children, after</code>. opts: <code>query, maxPages, limit, after</code>.</dd>
          <dt>ctx.reddit.listing(path, opts?)</dt><dd>Collects a listing → <code>{ items, pages }</code> (opts also take <code>maxItems</code>).</dd>
          <dt>ctx.reddit.post(id, opts?)</dt><dd>A post and its comment tree → <code>{ post, comments, moreCount }</code>; opts: <code>limit, depth, sort</code>.</dd>
          <dt>ctx.reddit.subreddit(name)</dt><dd>Subreddit info record.</dd>
          <dt>ctx.reddit.user(name)</dt><dd>User info record.</dd>
          <dt>ctx.reddit.normalize*()</dt><dd><code>normalizePost, normalizeComment, normalizeSubreddit, normalizeUser, normalizeThing, flattenComments, extractMedia, toIso</code> — the same formatters the standard scraper uses.</dd>
        </dl>
        <h4>Network</h4>
        <dl>
          <dt>ctx.fetch(url, init?)</dt><dd>GET/HEAD to Reddit hosts only (<code>${esc(status ? status.allowedHosts.join(', ') : 'www.reddit.com, old.reddit.com, oauth.reddit.com')}</code>).
          Only <code>accept</code>, <code>accept-language</code>, <code>if-none-match</code>, <code>if-modified-since</code> headers are passed. → <code>{ ok, status, statusText, url, headers.get(), text(), json() }</code></dd>
        </dl>
        <p>All requests go through the server's rate limiter (your delay, at least the server minimum), retries, robots.txt policy and the Wisp proxy allow-list.</p>
        <h4>Output, logging &amp; control</h4>
        <dl>
          <dt>ctx.emit(record | records)</dt><dd>Add results now. → items still allowed. Duplicates (same Reddit id) are dropped.</dd>
          <dt>ctx.remaining()</dt><dd>How many more items fit under Maximum items.</dd>
          <dt>ctx.log(…), ctx.log.info/warn/error/debug</dt><dd>Write to the job log (<code>console.log</code> works too).</dd>
          <dt>ctx.progress({ message, pages })</dt><dd>Update the progress line / page count.</dd>
          <dt>ctx.sleep(ms)</dt><dd>Wait (max 60 s per call).</dd>
          <dt>ctx.retry(fn, { retries, delayMs, factor })</dt><dd>Retry an async function with exponential backoff.</dd>
        </dl>
        <h4>Utilities</h4>
        <dl>
          <dt>ctx.utils.get(obj, "a.b.c", fallback)</dt><dd>Safe nested property access.</dd>
          <dt>ctx.utils.pick(obj, keys)</dt><dd>Copy selected fields (missing → null).</dd>
          <dt>ctx.utils.stripHtml(html)</dt><dd>HTML → plain text (for <code>selftext_html</code>, <code>body_html</code>).</dd>
          <dt>ctx.utils.decodeEntities(text)</dt><dd>Decode HTML entities.</dd>
          <dt>ctx.utils.matchAll(regex, text)</dt><dd>All matches with groups.</dd>
          <dt>ctx.utils.unique(arr, keyFn) · chunk(arr, n)</dt><dd>Array helpers.</dd>
        </dl>
        <h4>Example</h4>
        <pre>async function scrape(ctx) {
  for await (const page of ctx.reddit.pages('/r/science/top', { query: { t: 'week' }, maxPages: 2 })) {
    ctx.emit(page.records.filter(p => p.num_comments > 50));
  }
}</pre>
      </div>`, '<button class="btn btn-secondary" onclick="RedditScraper.showApi(\'python\')">Python version</button><button class="btn btn-primary" onclick="App.closeModal()">Close</button>');
  }

  function showPythonApi() {
    const cc = status && status.customCode;
    const hosts = esc(status ? status.allowedHosts.join(', ') : 'www.reddit.com, old.reddit.com, oauth.reddit.com');
    App.openModal('Custom scraper API — Python', `
      <div class="sc-api">
        <h4>Execution model</h4>
        <p>Your code defines <code>async def scrape(ctx)</code>. It runs on the MetaCode server in
        ${cc && cc.python ? esc(cc.python.runtime) : 'Pyodide (CPython in WebAssembly)'}, inside its own restricted process: the whole
        Python standard library works (<code>re</code>, <code>json</code>, <code>statistics</code>, <code>collections</code>, <code>datetime</code>,
        <code>itertools</code>, <code>math</code>, <code>csv</code>, <code>html</code>…), but there are no third-party packages (no pip), no files on the server,
        no environment variables, no programs and no direct network access — only <code>ctx</code> reaches Reddit.
        <code>print()</code> writes to the job log. Records you <code>ctx.emit()</code> are kept even if the run later fails or is cancelled;
        whatever you <code>return</code> (a list of dicts, or <code>{"data": [...], "meta": {...}}</code>) is added at the end.
        Values must be JSON-serializable (dates become ISO strings).</p>
        <h4>Inputs</h4>
        <dl>
          <dt>ctx.target</dt><dd>The target from the form as a dict (e.g. <code>{"type": "subreddit", "subreddit": …, "sort": …}</code>), or <code>None</code>.</dd>
          <dt>ctx.params</dt><dd>The parameters JSON object, as a dict.</dd>
          <dt>ctx.options</dt><dd>Limits from the form: <code>maxItems, maxPages, delayMs, commentLimit, commentDepth…</code></dd>
          <dt>ctx.mode</dt><dd><code>"oauth"</code>, <code>"public"</code>, <code>"browser"</code> or <code>"redditapis"</code>.</dd>
        </dl>
        <h4>Reddit helpers (await them)</h4>
        <dl>
          <dt>await ctx.reddit.json(path, query=None)</dt><dd>GET a Reddit JSON endpoint, e.g. <code>"/r/science/new"</code>, <code>{"limit": 50}</code> → parsed JSON.</dd>
          <dt>async for page in ctx.reddit.pages(path, max_pages=None, limit=100, after=None, query=None)</dt><dd>A listing page by page; each page is a dict with <code>number, records, children, after</code>.</dd>
          <dt>await ctx.reddit.listing(path, max_items=None, max_pages=None, query=None)</dt><dd>Collects a listing → <code>{"items": [...], "pages": n}</code>.</dd>
          <dt>await ctx.reddit.post(post_id, limit=None, depth=None, sort="confidence")</dt><dd>A post and its comment tree → <code>{"post", "comments", "more_count"}</code>.</dd>
          <dt>await ctx.reddit.subreddit(name) · await ctx.reddit.user(name)</dt><dd>Info records.</dd>
          <dt>ctx.reddit.normalize_post / normalize_comment / normalize_subreddit / normalize_user / normalize_thing / flatten_comments / extract_media / to_iso</dt>
          <dd>The same formatters the standard scraper uses (no await).</dd>
        </dl>
        <h4>Network</h4>
        <dl>
          <dt>await ctx.fetch(url, method="GET", headers=None)</dt><dd>GET/HEAD to Reddit hosts only (<code>${hosts}</code>) → a requests-style
          response: <code>.ok, .status (.status_code), .url, .headers.get(), .text, .json(), .raise_for_status()</code>.</dd>
        </dl>
        <p>All requests go through the server's rate limiter (your delay, at least the server minimum), retries and robots.txt policy.
        Failed requests raise <code>ScraperError</code> with <code>.type</code> (<code>"not_found"</code>, <code>"rate_limited"</code>, <code>"forbidden"</code>…).</p>
        <h4>Output, logging &amp; control</h4>
        <dl>
          <dt>ctx.emit(record_or_records)</dt><dd>Add dict(s) to the results now → how many more fit. Duplicates (same Reddit id) are dropped.</dd>
          <dt>ctx.remaining()</dt><dd>How many more items fit under Maximum items.</dd>
          <dt>ctx.log(…), ctx.log.info/warn/error/debug</dt><dd>Write to the job log (<code>print()</code> works too).</dd>
          <dt>ctx.progress(message=None, pages=None)</dt><dd>Update the progress line / page count.</dd>
          <dt>await ctx.sleep(seconds)</dt><dd>Wait (max 60 s per call).</dd>
          <dt>await ctx.retry(fn, retries=2, delay=2.0, factor=2.0)</dt><dd>Calls <code>fn(attempt)</code> (sync or async) with exponential backoff.</dd>
        </dl>
        <h4>Utilities</h4>
        <dl>
          <dt>ctx.utils.get(obj, "a.b.0.c", default)</dt><dd>None-safe nested lookup.</dd>
          <dt>ctx.utils.pick(obj, keys) · unique(items, key=None) · chunk(items, n)</dt><dd>Small helpers.</dd>
          <dt>ctx.utils.strip_html(html) · decode_entities(text)</dt><dd>HTML → plain text.</dd>
        </dl>
        <h4>Example</h4>
        <pre>import statistics

async def scrape(ctx):
    async for page in ctx.reddit.pages("/r/science/top", query={"t": "week"}, max_pages=2):
        busy = [p for p in page["records"] if p["num_comments"] > 50]
        ctx.emit(busy)
        if busy:
            print("median score", statistics.median(p["score"] for p in busy))</pre>
      </div>`, '<button class="btn btn-secondary" onclick="RedditScraper.showApi(\'javascript\')">JavaScript version</button><button class="btn btn-primary" onclick="App.closeModal()">Close</button>');
  }

  function parseParams() {
    const text = String(form.params || '').trim();
    if (!text) return {};
    let v;
    try { v = JSON.parse(text); } catch (e) { throw new Error('Parameters aren\'t valid JSON: ' + e.message); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Parameters must be a JSON object, e.g. { "subreddit": "science" }.');
    return v;
  }

  /* ── Start / cancel ───────────────────────── */
  async function start() {
    setFormError('');
    let body;
    try {
      const options = buildOptions();
      if (form.mode === 'custom') {
        syncEditorToForm();
        if (!form.code.trim()) throw new Error('Write your scraper code first.');
        body = { mode: 'custom', code: form.code, language: form.language, params: parseParams(), options, engine: currentEngine() };
        const target = buildTarget();
        if (target) body.target = target;
      } else {
        body = { mode: 'standard', target: buildTarget(), options, engine: currentEngine() };
      }
    } catch (e) {
      setFormError(e.message);
      return;
    }
    const btn = $('sc-start');
    if (btn) btn.disabled = true;
    try {
      // Browser mode: this tab must be listening before the job's first request.
      if (body.engine === 'browser') await ensureRelay();
      const data = await api('/jobs', { method: 'POST', body });
      setJob(data.job);
      App.notify('Scraper job started', 'info');
      refreshJobs();
    } catch (e) {
      setFormError(e.message);
      App.notify(e.message, 'error', 5000);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      await api('/jobs/' + job.id + '/cancel', { method: 'POST' });
    } catch (e) {
      App.notify(e.message, 'error');
    }
  }

  /* ── Current job ──────────────────────────── */
  function setJob(summary) {
    if (es) { es.close(); es = null; }
    job = Object.assign({ logs: [] }, summary);
    records = [];
    logs = [];
    view.shown = 200;
    form.lastJobId = job.id;
    saveForm();
    renderJob();
    connect(job.id);
  }

  async function openJob(id, quiet) {
    try {
      const data = await api('/jobs/' + id);
      setJob(data.job);
      if (!quiet) { const el = $('sc-job'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } catch (e) {
      if (form.lastJobId === id) { form.lastJobId = null; saveForm(); }
      if (!quiet) App.notify(e.message, 'error');
    }
  }

  // Follows a job over server-sent events (snapshot, status, progress, log,
  // records, meta). The server closes the stream once the job has finished.
  function connect(id) {
    if (typeof EventSource !== 'function') return pollJob(id);
    const source = new EventSource(API + '/jobs/' + encodeURIComponent(id) + '/events');
    es = source;
    const mine = () => es === source && job && job.id === id;
    source.addEventListener('snapshot', e => {
      if (!mine()) return;
      const data = JSON.parse(e.data);
      job = data.job;
      logs = job.logs || [];
      renderJob();
      fetchRecords();
      if (FINISHED.includes(job.status)) { source.close(); es = null; }
    });
    source.addEventListener('status', e => {
      if (!mine()) return;
      const prev = job.status;
      Object.assign(job, JSON.parse(e.data));
      renderJob();
      if (FINISHED.includes(job.status)) {
        source.close();
        es = null;
        fetchRecords();
        refreshJobs();
        if (prev !== job.status) announce();
      }
    });
    source.addEventListener('progress', e => {
      if (!mine()) return;
      job.progress = JSON.parse(e.data);
      job.itemCount = job.progress.itemsFound;
      renderProgress();
    });
    source.addEventListener('log', e => {
      if (!mine()) return;
      const entry = JSON.parse(e.data);
      logs.push(entry);
      if (logs.length > 1000) logs.shift();
      appendLog(entry);
    });
    source.addEventListener('records', () => { if (mine()) fetchRecords(); });
    source.addEventListener('meta', e => { if (mine()) { job.meta = JSON.parse(e.data); if (view.tab === 'meta') renderTab(); } });
    source.addEventListener('removed', () => { if (mine()) { source.close(); es = null; } });
    source.onerror = () => {
      if (!mine()) return;
      if (source.readyState === EventSource.CLOSED) {
        es = null;
        // The stream couldn't be (re)opened — fall back to polling.
        pollJob(id);
      }
    };
  }

  async function pollJob(id) {
    while (job && job.id === id) {
      try {
        const data = await api('/jobs/' + id);
        const prev = job.status;
        job = data.job;
        logs = job.logs || [];
        renderJob();
        await fetchRecords();
        if (FINISHED.includes(job.status)) { if (prev !== job.status) { announce(); refreshJobs(); } return; }
      } catch (e) {
        if (e.status === 404) { App.notify(e.message, 'warning'); job = null; renderJob(); return; }
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  function announce() {
    if (job.status === 'completed') App.notify('Scrape finished: ' + fmtNum(job.itemCount) + ' item' + (job.itemCount === 1 ? '' : 's'), job.itemCount ? 'success' : 'warning', 4500);
    else if (job.status === 'failed') App.notify('Scrape failed: ' + (job.error ? job.error.message : 'unknown error'), 'error', 6000);
    else if (job.status === 'cancelled') App.notify('Scrape cancelled — ' + fmtNum(job.itemCount) + ' items kept', 'warning');
  }

  // Loads records added since the last fetch (results are append-only).
  async function fetchRecords() {
    if (!job) return;
    if (fetching) { refetch = true; return; }
    fetching = true;
    const id = job.id;
    try {
      for (;;) {
        const data = await api('/jobs/' + id + '/results?offset=' + records.length + '&limit=2000');
        if (!job || job.id !== id) return;
        records = records.concat(data.records);
        if (records.length >= data.total || !data.records.length) break;
      }
      renderResultsSummary();
      if (['table', 'json'].includes(view.tab)) renderTab();
    } catch (e) {
      if (e.status !== 404) App.notify('Couldn\'t load results: ' + e.message, 'error');
    } finally {
      fetching = false;
      if (refetch) { refetch = false; setTimeout(fetchRecords, 300); }
    }
  }

  function renderJob() {
    const el = $('sc-job');
    const cancelBtn = $('sc-cancel');
    if (!el) return;
    clearInterval(durationTimer);
    if (!job) { el.hidden = true; if (cancelBtn) cancelBtn.hidden = true; return; }
    el.hidden = false;
    const running = !FINISHED.includes(job.status);
    if (cancelBtn) cancelBtn.hidden = !running;
    el.innerHTML = `
      <div class="sc-job-head">
        <div class="sc-job-title">
          <span class="badge ${STATUS_BADGE[job.status] || 'badge-gray'}" id="sc-job-status">${esc(cap(job.status))}</span>
          <span class="sc-label" title="${esc(job.label)}">${esc(job.label)}</span>
          <span class="badge ${job.mode === 'custom' ? 'badge-violet' : 'badge-gray'}">${job.mode === 'custom' ? 'Custom code' : 'Standard'}</span>
          <span class="badge badge-gray">${job.engine === 'browser' ? 'Browser' : 'Server'}</span>
        </div>
        <div class="flex gap-2">
          ${running ? '<button class="btn btn-secondary btn-sm" onclick="RedditScraper.cancel()">Cancel</button>' : ''}
        </div>
      </div>
      <div class="progress-wrap"><div class="progress-bar ${running ? 'sc-indeterminate' : ''}" id="sc-progress-bar"
        style="width:100%;background:${job.status === 'failed' ? 'var(--error)' : job.status === 'cancelled' ? 'var(--warning)' : 'var(--success)'}"></div></div>
      <div class="sc-stats" id="sc-stats"></div>
      <div class="sc-message" id="sc-message"></div>
      ${job.error ? '<div class="sc-error-box" role="alert">' + esc(job.error.message) +
        (job.error.type === 'reddit_blocked' && status && !(status.credentials && status.credentials.configured)
          ? '<div class="mt-3"><button class="btn btn-secondary btn-sm" onclick="RedditScraper.toggleApi(true)">Set up Reddit API access</button></div>' : '') +
        (job.error.type === 'reddit_blocked' && status && status.credentials && status.credentials.configured && job.engine === 'browser'
          ? '<div class="mt-3"><button class="btn btn-secondary btn-sm" onclick="RedditScraper.setEngine(\'server\'); RedditScraper.start()">Switch to the Reddit API and run again</button></div>' : '') +
        '</div>' : ''}
      <div class="sc-tabs" role="tablist">
        ${[['table', 'Results'], ['json', 'JSON'], ['logs', 'Logs'], ['meta', 'Metadata']].map(([k, l]) =>
          '<button class="sc-tab' + (view.tab === k ? ' active' : '') + '" role="tab" data-tab="' + k + '" onclick="RedditScraper.setTab(\'' + k + '\')">' + l +
          (k === 'table' ? '<span class="badge badge-gray" id="sc-count-badge">' + fmtNum(records.length) + '</span>' : '') + '</button>').join('')}
      </div>
      <div id="sc-tab-body"></div>`;
    renderProgress();
    renderTab();
    if (running) durationTimer = setInterval(() => { if (!$('sc-stats')) return clearInterval(durationTimer); renderProgress(); }, 1000);
  }

  function renderProgress() {
    const el = $('sc-stats');
    if (!el || !job) return;
    const p = job.progress || {};
    const stat = (n, l) => '<div class="sc-stat"><div class="sc-stat-num">' + n + '</div><div class="sc-stat-label">' + l + '</div></div>';
    el.innerHTML =
      stat(fmtNum(p.itemsFound !== undefined ? p.itemsFound : job.itemCount), 'Items') +
      stat(fmtNum(p.pagesFetched), 'Pages') +
      stat(fmtNum(p.requests), 'Requests') +
      stat(fmtNum(p.duplicates), 'Duplicates skipped') +
      stat(fmtNum(p.errors), 'Errors') +
      stat(job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—', 'Started') +
      stat(fmtDuration(jobDuration(job)), 'Duration');
    const msg = $('sc-message');
    if (msg) msg.textContent = p.message || '';
  }

  function setTab(tab) {
    view.tab = tab;
    document.querySelectorAll('.sc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    renderTab();
  }

  function renderTab() {
    const el = $('sc-tab-body');
    if (!el || !job) return;
    if (view.tab === 'logs') return renderLogs(el);
    if (view.tab === 'meta') return renderMeta(el);
    renderResults(el);
  }

  function renderResultsSummary() {
    const b = $('sc-count-badge');
    if (b) b.textContent = fmtNum(records.length);
  }

  /* ── Results ──────────────────────────────── */
  function filtered() {
    const needle = view.search.trim().toLowerCase();
    let rows = records;
    if (view.type !== 'all') rows = rows.filter(r => r.record_type === view.type);
    if (needle) {
      rows = rows.filter(r => Object.keys(r).some(k => {
        const v = r[k];
        return (typeof v === 'string' || typeof v === 'number') && String(v).toLowerCase().includes(needle);
      }));
    }
    const by = {
      created_desc:  (a, b) => (b.created_utc || 0) - (a.created_utc || 0),
      created_asc:   (a, b) => (a.created_utc || 0) - (b.created_utc || 0),
      score_desc:    (a, b) => (b.score === null || b.score === undefined ? -Infinity : b.score) - (a.score === null || a.score === undefined ? -Infinity : a.score),
      comments_desc: (a, b) => (b.num_comments || 0) - (a.num_comments || 0),
      original:      null
    }[view.sort];
    return by ? rows.slice().sort(by) : rows;
  }

  // A post's content after its title: the body, or for a post without
  // text what it links to. Older results (scraped before full_text) are
  // pieced together from their fields.
  function postRest(r) {
    const title = (r.title || '').trim();
    if (r.full_text) return title && r.full_text.startsWith(title) ? r.full_text.slice(title.length).trim() : r.full_text;
    const own = u => u && (u === r.permalink || (r.post_id && u.includes('/comments/' + r.post_id)));
    const media = r.media && r.media.url && !own(r.media.url) ? r.media.url : '';
    return r.selftext || media || (r.url && !own(r.url) ? r.url : '');
  }
  // The whole post as text: title, body, link/media, poll options, crosspost.
  function postText(r) {
    return r.full_text || [r.title, postRest(r)].filter(Boolean).join('\n\n');
  }

  function textOf(r) {
    if (r.record_type === 'post') return postText(r);
    if (r.record_type === 'comment') return r.body || '';
    if (r.record_type === 'subreddit') return (r.name ? 'r/' + r.name : '') + (r.title ? ' — ' + r.title : '');
    if (r.record_type === 'user') return r.name ? 'u/' + r.name : '';
    return r.title || r.body || r.text || r.name || JSON.stringify(r).slice(0, 200);
  }

  function renderResults(el) {
    const types = Array.from(new Set(records.map(r => r.record_type).filter(Boolean)));
    const typeOpts = ['all'].concat(types);
    if (!typeOpts.includes(view.type)) view.type = 'all';
    const rows = filtered();
    const toolbar = `
      <div class="sc-results-bar">
        <input class="form-input" id="sc-search" type="search" placeholder="Search results…" value="${esc(view.search)}" oninput="RedditScraper.onSearch(this.value)" aria-label="Search results">
        <select class="form-select" aria-label="Record type" onchange="RedditScraper.onType(this.value)">${options(typeOpts, view.type, v => v === 'all' ? 'All types' : cap(v) + 's')}</select>
        <select class="form-select" aria-label="Sort" onchange="RedditScraper.onSort(this.value)">
          ${options(['created_desc', 'created_asc', 'score_desc', 'comments_desc', 'original'], view.sort,
            v => ({ created_desc: 'Newest first', created_asc: 'Oldest first', score_desc: 'Highest score', comments_desc: 'Most comments', original: 'Collection order' })[v])}
        </select>
        <button class="btn btn-secondary btn-sm" onclick="RedditScraper.copyJson()" ${records.length ? '' : 'disabled'}>Copy JSON</button>
        <select class="form-select" aria-label="Export" onchange="RedditScraper.exportAs(this.value); this.value=''" ${records.length ? '' : 'disabled'}>
          <option value="">Export…</option>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
          <option value="json-nested">JSON (comments nested in posts)</option>
          <option value="ndjson">NDJSON</option>
          <option value="edges">Reply network (edges CSV)</option>
        </select>
        <button class="btn btn-teal btn-sm" onclick="RedditScraper.addToProject()" ${records.some(r => r.record_type === 'post' || r.record_type === 'comment') ? '' : 'disabled'}>Add to project</button>
      </div>`;

    if (view.tab === 'json') {
      const shown = rows.slice(0, 500);
      el.innerHTML = toolbar + (rows.length > 500 ? '<div class="form-hint mb-4">Showing the first 500 of ' + fmtNum(rows.length) + ' records — export for the rest.</div>' : '') +
        '<pre class="sc-pre sc-json" id="sc-json">' + esc(JSON.stringify(shown, null, 2)) + '</pre>';
      return;
    }

    if (!records.length) {
      const running = !FINISHED.includes(job.status);
      el.innerHTML = toolbar + '<div class="empty-state" style="padding:36px 16px"><div class="empty-title">' +
        (running ? 'Waiting for results…' : 'No results') + '</div><div class="empty-sub">' +
        (running ? 'Items appear here as pages are collected.' : (job.status === 'failed' ? 'The job failed before collecting anything — see the error above and the Logs tab.' :
          'Nothing matched. Try another sort, a longer time range, or higher limits.')) + '</div></div>';
      return;
    }
    const visible = rows.slice(0, view.shown);
    const index = new Map(records.map((r, i) => [r, i]));
    el.innerHTML = toolbar + averagesOf(rows) + `
      <div class="table-wrap"><table class="table sc-table">
        <thead><tr><th>Type</th><th>Title / text</th><th>Author</th><th>Subreddit</th><th class="sc-cell-num">Score</th><th class="sc-cell-num">Comments</th><th>Created</th></tr></thead>
        <tbody>${visible.map(r => {
          const i = index.get(r);
          return '<tr tabindex="0" onclick="RedditScraper.showRecord(' + i + ')" onkeydown="if(event.key===\'Enter\')RedditScraper.showRecord(' + i + ')">' +
            '<td><span class="badge ' + (TYPE_BADGE[r.record_type] || 'badge-gray') + '">' + esc(r.record_type || 'record') + '</span></td>' +
            '<td>' + (r.record_type === 'post'
              ? '<div class="sc-cell-text" title="' + esc(textOf(r).slice(0, 500)) + '">' + esc((r.title || '').slice(0, 300) || '—') + '</div>' +
                (postRest(r) ? '<div class="sc-cell-text sc-cell-sub">' + esc(postRest(r).slice(0, 300)) + '</div>' : '')
              : '<div class="sc-cell-text" title="' + esc(textOf(r).slice(0, 300)) + '">' + esc(textOf(r).slice(0, 300) || '—') + '</div>') + '</td>' +
            '<td>' + esc(r.author || '—') + '</td>' +
            '<td>' + (r.subreddit ? 'r/' + esc(r.subreddit) : '—') + '</td>' +
            '<td class="sc-cell-num">' + fmtNum(r.score) + '</td>' +
            '<td class="sc-cell-num">' + fmtNum(r.num_comments) + '</td>' +
            '<td style="white-space:nowrap">' + fmtDate(r.created_at) + '</td></tr>';
        }).join('')}</tbody>
      </table></div>
      <div class="flex gap-3 mt-3" style="align-items:center">
        <span class="form-hint">Showing ${fmtNum(visible.length)} of ${fmtNum(rows.length)}${rows.length !== records.length ? ' (filtered from ' + fmtNum(records.length) + ')' : ''}</span>
        ${rows.length > visible.length ? '<button class="btn btn-secondary btn-sm" onclick="RedditScraper.showMore()">Show 200 more</button>' : ''}
      </div>`;
  }

  // Average likes, comments, shares and views of the posts in view (of the
  // comments, when there are no posts) — the numbers Add to project sends to Metrics.
  const AVERAGES = [['likes', 'Avg likes', 'score', '#EF4444'], ['comments', 'Avg comments', '', '#7C3AED'],
    ['shares', 'Avg shares', 'crossposts', '#3B82F6'], ['views', 'Avg views', '', '#0D9488']];
  function averagesOf(rows) {
    const posts = rows.filter(r => r.record_type === 'post');
    const base = posts.length ? posts : rows.filter(r => r.record_type === 'comment');
    if (!base.length) return '';
    const what = posts.length ? 'post' : 'comment';
    const eng = base.map(engagementOf);
    return '<div class="sc-avg" id="sc-avg">' + AVERAGES.map(([key, label, note, color]) => {
      const vals = eng.map(e => e[key]).filter(v => v !== null);
      const value = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)).toLocaleString() : null;
      return '<div class="sc-avg-tile" data-metric="' + key + '">' + (value === null
        ? '<div class="sc-avg-value is-empty">' + (key === 'views' && what === 'post' ? 'Not provided by Reddit' : 'No data') + '</div>'
        : '<div class="sc-avg-value" style="color:' + color + '">' + value + '</div>') +
        '<div class="sc-avg-label">' + label + (note ? ' <span>(' + note + ')</span>' : '') + '</div></div>';
    }).join('') + '</div>' +
      '<div class="form-hint sc-avg-hint">Per ' + what + ', over ' + fmtNum(base.length) + ' ' + what + (base.length === 1 ? '' : 's') +
      (rows.length !== records.length ? ' matching the search or filter' : '') + ' — the numbers <b>Add to project</b> sends to Metrics.</div>';
  }

  let searchTimer = null;
  function onSearch(v) {
    view.search = v;
    view.shown = 200;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      renderTab();
      const s = $('sc-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }, 200);
  }
  function onType(v) { view.type = v; view.shown = 200; renderTab(); }
  function onSort(v) { view.sort = v; renderTab(); }
  function showMore() { view.shown += 200; renderTab(); }

  function renderLogs(el) {
    el.innerHTML = '<div class="sc-logs" id="sc-logs" role="log" aria-live="polite">' + logs.map(logLine).join('') + '</div>' +
      (job.logsDropped ? '<div class="form-hint mt-2">' + fmtNum(job.logsDropped) + ' older log lines were dropped.</div>' : '');
    const box = $('sc-logs');
    if (box) box.scrollTop = box.scrollHeight;
  }
  function logLine(l) {
    const t = new Date(l.ts);
    return '<div class="sc-log sc-log-' + esc(l.level) + '"><span class="sc-log-ts">' + esc(isNaN(t) ? '' : t.toLocaleTimeString()) + '</span><span>' + esc(l.message) + '</span></div>';
  }
  function appendLog(entry) {
    const box = $('sc-logs');
    if (!box || view.tab !== 'logs') return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.insertAdjacentHTML('beforeend', logLine(entry));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function kv(obj, skip) {
    const keys = Object.keys(obj || {}).filter(k => !(skip || []).includes(k));
    if (!keys.length) return '<div class="text-muted" style="font-size:13px">None</div>';
    return '<dl class="sc-kv">' + keys.map(k => {
      const v = obj[k];
      let html;
      if (v === null || v === undefined || v === '') html = '<span class="text-muted">—</span>';
      else if (typeof v === 'object') html = '<pre class="sc-pre" style="margin:0">' + esc(JSON.stringify(v, null, 2)) + '</pre>';
      else if (safeHref(String(v))) html = '<a href="' + esc(v) + '" target="_blank" rel="noopener noreferrer" style="color:var(--blue)">' + esc(v) + '</a>';
      else html = esc(String(v));
      return '<dt>' + esc(k) + '</dt><dd>' + html + '</dd>';
    }).join('') + '</dl>';
  }

  function renderMeta(el) {
    const m = job.meta || {};
    el.innerHTML =
      (m.subreddit ? '<div class="card-title mt-2">Subreddit</div>' + kv(m.subreddit, ['record_type']) : '') +
      (m.user ? '<div class="card-title mt-4">User</div>' + kv(m.user, ['record_type']) : '') +
      (m.custom ? '<div class="card-title mt-4">Returned by your code (meta)</div>' + kv(m.custom) : '') +
      '<div class="card-title mt-4">Target</div>' + kv(job.target || { target: 'none' }, ['path']) +
      '<div class="card-title mt-4">Options</div>' + kv(job.options) +
      '<div class="card-title mt-4">Job</div>' + kv({ id: job.id, mode: job.mode, status: job.status, created: fmtDate(job.createdAt),
        started: fmtDate(job.startedAt), finished: fmtDate(job.finishedAt), duration: fmtDuration(jobDuration(job)), items: job.itemCount });
  }

  function showRecord(i) {
    const r = records[i];
    if (!r) return;
    const link = recordLink(r);
    let body = '';
    if (r.record_type === 'post') {
      body += '<div class="sc-body-text" style="font-weight:600;font-size:15px;margin-bottom:8px">' + esc(r.title || '') + '</div>';
      const rest = postRest(r);
      if (rest) body += '<div class="sc-body-text mb-4">' + esc(rest) + '</div>';
      const comments = records.filter(c => c.record_type === 'comment' && c.post_id === r.post_id);
      if (comments.length) {
        body += '<div class="card-title mt-4">Comments in these results (' + comments.length + ')</div>' + comments.slice(0, 200).map(c =>
          '<div class="sc-comment" style="margin-left:' + Math.min(8, c.depth || 0) * 14 + 'px"><div class="sc-comment-meta">' + esc(c.author || '[deleted]') + ' · ' +
          fmtNum(c.score) + ' points · ' + fmtDate(c.created_at) + '</div><div class="sc-body-text">' + esc(c.body || '') + '</div></div>').join('') +
          (comments.length > 200 ? '<div class="form-hint">… and ' + (comments.length - 200) + ' more</div>' : '');
      }
    } else if (r.record_type === 'comment') {
      if (r.post_title) body += '<div class="form-hint mb-4">On: ' + esc(r.post_title) + '</div>';
      body += '<div class="sc-body-text mb-4">' + esc(r.body || '') + '</div>';
    }
    body += '<div class="card-title mt-4">All fields</div>' + kv(r);
    // The URL comes from scraped data, so it's looked up by record index —
    // never embedded in the inline handler.
    const browse = link && status && status.browser.enabled
      ? '<button class="btn btn-secondary" onclick="App.closeModal(); RedditScraper.browseRecord(' + i + ')">Open in Reddit browser</button>' : '';
    App.openModal(cap(r.record_type || 'Record') + (r.author ? ' by ' + r.author : ''), body,
      browse + (link ? '<a class="btn btn-secondary" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Open on Reddit</a>' : '') +
      '<button class="btn btn-primary" onclick="App.closeModal()">Close</button>');
  }

  /* ── Copy / export / add to project ───────── */
  async function copyJson() {
    const text = JSON.stringify(filtered(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      App.notify('Copied ' + fmtNum(filtered().length) + ' records as JSON', 'success');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      App.notify(ok ? 'Copied as JSON' : 'Copy failed — use Export instead', ok ? 'success' : 'error');
    }
  }

  function exportAs(kind) {
    if (!job || !kind) return;
    if (kind === 'edges') return exportEdges();
    const format = kind === 'json-nested' ? 'json' : kind;
    const params = new URLSearchParams({ format });
    if (kind === 'json-nested') params.set('nested', '1');
    if (view.type !== 'all') params.set('type', view.type);
    const a = document.createElement('a');
    a.href = API + '/jobs/' + encodeURIComponent(job.id) + '/export?' + params.toString();
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    App.notify('Export started', 'success');
  }

  // Who replied to whom: comment author → author of the parent post/comment.
  function buildReplyEdges(list) {
    const authorOf = new Map();
    list.forEach(r => { if (r.fullname && r.author) authorOf.set(r.fullname, r.author); });
    const weights = new Map();
    list.forEach(r => {
      if (r.record_type !== 'comment' || !r.author || !r.parent_id) return;
      const target = authorOf.get(r.parent_id);
      if (!target || target === r.author || r.author === '[deleted]' || target === '[deleted]') return;
      const key = r.author + '\u0000' + target;
      weights.set(key, (weights.get(key) || 0) + 1);
    });
    return Array.from(weights.entries()).map(([k, w]) => { const [s, t] = k.split('\u0000'); return [s, t, w, 'reply']; });
  }

  function exportEdges() {
    const edges = buildReplyEdges(records);
    if (!edges.length) { App.notify('No reply relationships found — scrape a post with comments, or include comments', 'warning', 4500); return; }
    App.downloadCSV('reddit_reply_network.csv', ['source', 'target', 'weight', 'type'], edges);
    App.notify('Exported ' + edges.length + ' reply edges — load them in Analyze CSV', 'success', 4500);
  }

  // Reddit's engagement numbers → the project's engagement fields, which
  // Metrics charts and lists per post: score → likes, comments → comments,
  // crossposts → shares, view_count → views (Reddit rarely sends one), plus
  // upvote ratio and awards.
  function engagementOf(r) {
    const n = x => (typeof x === 'number' && isFinite(x) ? x : null);
    if (r.record_type === 'post') {
      return { likes: n(r.score), shares: n(r.num_crossposts), comments: n(r.num_comments), views: n(r.view_count),
        upvoteRatio: n(r.upvote_ratio), awards: n(r.total_awards) };
    }
    return { likes: n(r.score), shares: null, comments: null, views: null };
  }

  // Scraped record → MetaCode post (the same shape Import Data creates).
  function toPost(r) {
    if (r.record_type === 'post') {
      return {
        id: 'reddit_' + r.post_id,
        text: postText(r),
        author: r.author || '',
        timestamp: r.created_at || '',
        engagement: engagementOf(r),
        humanCodes: {}, aiCodes: {},
        source: { platform: 'reddit', type: 'post', subreddit: r.subreddit, permalink: r.permalink }
      };
    }
    return {
      id: 'reddit_c_' + r.comment_id,
      text: r.body || '',
      author: r.author || '',
      timestamp: r.created_at || '',
      engagement: engagementOf(r),
      humanCodes: {}, aiCodes: {},
      source: { platform: 'reddit', type: 'comment', subreddit: r.subreddit, permalink: r.permalink, post_id: r.post_id, parent_id: r.parent_id }
    };
  }

  function addToProject() {
    const posts = records.filter(r => r.record_type === 'post' && r.post_id);
    const comments = records.filter(r => r.record_type === 'comment' && r.comment_id);
    App.openModal('Add to project', `
      <p style="font-size:13.5px;color:var(--tx-second);margin-bottom:14px">Scraped items become project posts you can code in AI Coding and Human Coding.
        Each one's engagement goes to <b>Metrics</b>: score becomes <em>likes</em>, comment count <em>comments</em>, crossposts <em>shares</em>,
        plus upvote ratio and awards. Items already in the project keep their text and codes; their engagement numbers are updated.</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label class="sc-check"><input type="checkbox" id="sc-add-posts" ${posts.length ? 'checked' : 'disabled'}> ${fmtNum(posts.length)} posts (the whole post: title, text, and links, images or polls)</label>
        <label class="sc-check"><input type="checkbox" id="sc-add-comments" ${comments.length ? (posts.length ? '' : 'checked') : 'disabled'}> ${fmtNum(comments.length)} comments</label>
      </div>`,
      '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" onclick="RedditScraper.confirmAdd()">Add</button>');
  }

  // The newer numbers of a re-scraped item, over what the project has (a
  // number Reddit didn't send, e.g. views from an engagement CSV, is kept).
  // null when nothing changed.
  function refreshedEngagement(old, latest) {
    const merged = Object.assign({}, old || {});
    let changed = false;
    Object.keys(latest).forEach(k => {
      if (latest[k] !== null && latest[k] !== undefined && merged[k] !== latest[k]) { merged[k] = latest[k]; changed = true; }
    });
    return changed ? merged : null;
  }

  function confirmAdd() {
    const wantPosts = $('sc-add-posts') && $('sc-add-posts').checked;
    const wantComments = $('sc-add-comments') && $('sc-add-comments').checked;
    const existing = App.getState().posts || [];
    const chosen = records
      .filter(r => (wantPosts && r.record_type === 'post' && r.post_id) || (wantComments && r.record_type === 'comment' && r.comment_id))
      .map(toPost);
    const latest = new Map(chosen.map(p => [p.id, p]));
    // Items already in the project: same text and codes, newer engagement
    let updated = 0;
    const kept = existing.map(p => {
      const again = latest.get(p.id);
      const engagement = again && refreshedEngagement(p.engagement, again.engagement);
      if (!engagement) return p;
      updated++;
      return Object.assign({}, p, { engagement });
    });
    const ids = new Set(existing.map(p => p.id));
    const fresh = chosen.filter(p => !ids.has(p.id) && (ids.add(p.id), true));
    App.closeModal();
    if (!fresh.length && !updated) { App.notify('Nothing new to add — these items are already in the project', 'warning'); return; }
    App.setState({ posts: kept.concat(fresh) });
    const stat = document.getElementById('stat-posts');
    if (stat) stat.textContent = kept.length + fresh.length;
    const refreshed = fmtNum(updated) + ' item' + (updated === 1 ? '' : 's') + ' already in the project';
    App.notify(fresh.length
      ? 'Added ' + fmtNum(fresh.length) + ' items to the project (' + fmtNum(kept.length + fresh.length) + ' posts total)' +
        (updated ? ' and updated the engagement numbers of ' + refreshed : '') + ' — see Metrics for their engagement'
      : 'Nothing new to add — updated the engagement numbers of ' + refreshed + ' (see Metrics)', 'success', 5000);
  }

  /* ── Recent jobs ──────────────────────────── */
  async function refreshJobs() {
    const el = $('sc-jobs-list');
    if (!el) return;
    try {
      jobsList = (await api('/jobs')).jobs;
    } catch (e) {
      el.innerHTML = '<div class="text-error" style="font-size:12.5px">' + esc(e.message) + '</div>';
      return;
    }
    if (!$('sc-jobs-list')) return;
    if (!jobsList.length) {
      el.innerHTML = '<div class="text-muted" style="font-size:12.5px">No jobs yet. Jobs and their results are kept in server memory' +
        (status ? ' for ' + status.limits.jobRetentionMinutes + ' minutes' : '') + ' — export or add results to the project to keep them.</div>';
      return;
    }
    el.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Job</th><th>Mode</th><th>Status</th><th class="sc-cell-num">Items</th><th>Created</th><th></th></tr></thead><tbody>' +
      jobsList.map(j => '<tr><td><div class="sc-cell-text" title="' + esc(j.label) + '">' + esc(j.label) + '</div></td>' +
        '<td>' + (j.mode === 'custom' ? 'Custom code' : 'Standard') + (j.engine === 'browser' ? ' · browser' : ' · server') + '</td>' +
        '<td><span class="badge ' + (STATUS_BADGE[j.status] || 'badge-gray') + '">' + esc(cap(j.status)) + '</span></td>' +
        '<td class="sc-cell-num">' + fmtNum(j.itemCount) + '</td>' +
        '<td style="white-space:nowrap">' + fmtDate(j.createdAt) + '</td>' +
        '<td style="white-space:nowrap;text-align:right">' +
          '<button class="btn btn-ghost btn-sm" onclick="RedditScraper.openJob(\'' + esc(j.id) + '\')">Open</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="RedditScraper.deleteJob(\'' + esc(j.id) + '\')" aria-label="Delete job">Delete</button>' +
        '</td></tr>').join('') + '</tbody></table></div>';
  }

  async function deleteJob(id) {
    const j = jobsList.find(x => x.id === id);
    if (j && !FINISHED.includes(j.status) && !confirm('This job is still running. Cancel and delete it?')) return;
    try {
      await api('/jobs/' + id, { method: 'DELETE' });
      if (job && job.id === id) { if (es) { es.close(); es = null; } job = null; records = []; renderJob(); form.lastJobId = null; saveForm(); }
      refreshJobs();
    } catch (e) { App.notify(e.message, 'error'); }
  }

  /* ── Reddit browser (Scramjet) ────────────── */
  function toggleBrowser() {
    browserOpen = !browserOpen;
    const el = $('sc-browser');
    if (!el) return;
    if (!browserOpen) { el.hidden = true; return; }
    renderBrowser();
  }

  function renderBrowser(url) {
    const el = $('sc-browser');
    if (!el) return;
    el.hidden = false;
    if (status && !status.browser.enabled) {
      el.innerHTML = '<div class="text-error" style="font-size:13px">The in-app Reddit browser is turned off on this server (SCRAPER_BROWSER_ENABLED=false).</div>';
      return;
    }
    el.innerHTML = `
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">Reddit browser
        <button class="btn btn-ghost btn-sm" onclick="RedditScraper.toggleBrowser()" aria-label="Close browser">✕</button></div>
      <form class="sc-browser-bar" onsubmit="RedditScraper.browse(); return false">
        <button class="btn btn-ghost btn-sm" type="button" onclick="RedditBrowser.back()" aria-label="Back">←</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="RedditBrowser.forward()" aria-label="Forward">→</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="RedditBrowser.reload()" aria-label="Reload">&#8635;</button>
        <input class="form-input" id="sc-browser-url" value="${esc(url || 'https://www.reddit.com/')}" aria-label="Reddit address" spellcheck="false">
        <button class="btn btn-secondary btn-sm" type="submit">Go</button>
        <button class="btn btn-primary btn-sm" type="button" onclick="RedditScraper.useBrowserPage()">Use this page as target</button>
      </form>
      <div class="form-hint" id="sc-browser-note" style="margin-bottom:8px">Pages load through Scramjet in this tab and reach Reddit only via MetaCode's Wisp proxy (epoxy-tls end-to-end TLS). Logging in isn't needed for browsing.</div>
      <iframe class="sc-browser-frame" id="sc-browser-frame" title="Reddit browser" referrerpolicy="no-referrer"></iframe>`;
    const iframe = $('sc-browser-frame');
    const note = $('sc-browser-note');
    RedditBrowser.init(iframe).then(() => {
      RedditBrowser.go($('sc-browser-url').value);
    }).catch(e => {
      if (note) { note.className = 'form-error'; note.textContent = 'The Reddit browser couldn\'t start: ' + e.message; }
    });
  }

  function recordLink(r) {
    return r ? (safeHref(r.permalink) || safeHref(r.profile_url) || safeHref(r.url)) : null;
  }

  // Opens a result's Reddit page in the in-app browser.
  function browseRecord(i) {
    const link = recordLink(records[i]);
    if (!link) return;
    let url;
    try { url = RedditBrowser.normalizeUrl(link); } catch (e) { App.notify(e.message, 'warning'); return; }
    browserOpen = true;
    renderBrowser(url);
    const el = $('sc-browser');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function browse() {
    try {
      const url = RedditBrowser.go($('sc-browser-url').value);
      $('sc-browser-url').value = url;
    } catch (e) {
      App.notify(e.message, 'error');
    }
  }

  function useBrowserPage() {
    const shown = RedditBrowser.currentUrl() || ($('sc-browser-url') ? $('sc-browser-url').value : '');
    if (!shown) { App.notify('Open a Reddit page first', 'warning'); return; }
    if ($('sc-browser-url')) $('sc-browser-url').value = shown;
    const url = RedditBrowser.asRedditUrl(shown);
    form.target.type = 'url';
    form.target.url = url;
    if (form.mode === 'custom') form.customTarget = 'url';
    saveForm();
    renderTargetType();
    checkTarget().then(t => { if (t) App.notify('Target set: ' + t.label, 'success'); });
  }

  /* ── Browser relay client ─────────────────── */
  // Browser-mode jobs run on the server but ask an open MetaCode tab to make
  // their Reddit requests. This tab listens on /api/scraper/relay/events,
  // claims a request (so only one tab fetches it), fetches it through the
  // Scramjet transport and posts the answer back.
  const RELAY_MAX_BYTES = 8 * 1024 * 1024;
  let relaySource = null;
  let relayReady = null;
  const relayActive = new Map();     // request id → AbortController

  function ensureRelay() {
    if (relaySource && relaySource.readyState !== 2 /* CLOSED */) return relayReady;
    if (typeof EventSource !== 'function') return Promise.reject(new Error('This browser doesn\'t support server-sent events.'));
    const source = new EventSource(API + '/relay/events');
    relaySource = source;
    relayReady = new Promise(resolve => {
      source.addEventListener('ready', () => resolve(), { once: true });
      setTimeout(resolve, 4000);
    });
    source.addEventListener('ready', e => {
      try { RedditBrowser.configure({ allowedHosts: JSON.parse(e.data).allowedHosts }); } catch (err) { /* keep the previous host list */ }
    });
    source.addEventListener('relay', e => {
      let req = null;
      try { req = JSON.parse(e.data); } catch (err) { return; }
      handleRelay(req);
    });
    source.addEventListener('relay-cancel', e => {
      try { const c = relayActive.get(JSON.parse(e.data).id); if (c) c.abort(); } catch (err) { /* ignore */ }
    });
    return relayReady;
  }

  async function handleRelay(req) {
    if (!req || typeof req.id !== 'string' || relayActive.has(req.id)) return;
    const ac = new AbortController();
    relayActive.set(req.id, ac);
    const path = '/relay/' + encodeURIComponent(req.id);
    try {
      try {
        await api(path + '/claim', { method: 'POST', body: {} });
      } catch (e) {
        return;                       // another tab took it, or it already ended
      }
      let payload;
      if (!['GET', 'HEAD'].includes(req.method) || !RedditBrowser.isAllowedUrl(req.url)) {
        payload = { error: 'HostBlocked: the browser refused a request that is not to Reddit' };
      } else {
        try {
          payload = await RedditBrowser.fetchThrough(req.url, req.method, req.headers, ac.signal, RELAY_MAX_BYTES);
        } catch (e) {
          payload = { error: String((e && e.message) || e || 'request failed') };
        }
      }
      if (ac.signal.aborted) return;
      await api(path, { method: 'POST', body: payload }).catch(() => {});
    } finally {
      relayActive.delete(req.id);
    }
  }

  function browserJobRunning() {
    const mine = j => j && j.engine === 'browser' && !FINISHED.includes(j.status);
    return mine(job) || jobsList.some(mine) || relayActive.size > 0;
  }

  // Closing or reloading the tab would stop a browser-mode job's requests.
  window.addEventListener('beforeunload', e => {
    if (!browserJobRunning()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // After a reload (on any page), resume serving browser-mode jobs that are still running.
  setTimeout(async () => {
    try {
      const res = await fetch(API + '/jobs');
      if (!res.ok) return;
      const data = await res.json();
      jobsList = data.jobs || [];
      if (jobsList.some(j => j.engine === 'browser' && !FINISHED.includes(j.status))) ensureRelay();
    } catch (e) { /* server unreachable: nothing to resume */ }
  }, 0);

  return {
    render, setMode, setEngine, toggleApi, connectApi, disconnectApi, toggleRedditApis, saveRedditApisKey, removeRedditApisKey, onTargetType, onField, onOption, checkTarget, start, cancel,
    loadTemplate, setLanguage, onParams, showApi, setTab, onSearch, onType, onSort, showMore,
    showRecord, copyJson, exportAs, addToProject, confirmAdd, refreshJobs, openJob, deleteJob,
    toggleBrowser, browse, browseRecord, useBrowserPage,
    // exposed for tests
    _buildReplyEdges: buildReplyEdges, _toPost: toPost
  };
})();
