# Reddit Scraper

The **Scraper** page (sidebar → Data → **Scraper**) collects Reddit posts, comments, subreddit and
profile information so you can code them in MetaCode like any imported posts. It has two modes:

- **Standard scraper** — pick a target and limits; MetaCode fetches, paginates and normalizes the data.
- **Custom code** — write your own `scrape(ctx)` in JavaScript or TypeScript; it runs in an isolated
  sandbox on the server with a small Reddit SDK.

Jobs run on the MetaCode server in the background. The page follows their progress live, shows the
results (table, JSON, logs, metadata) and exports them (CSV, JSON, NDJSON, reply-network edges) or adds
them to the project as posts.

Contents: [How it works](#1-how-it-works) · [MercuryWorkshop components](#2-how-the-mercuryworkshop-components-are-used) ·
[Configuration](#3-configuration) · [Standard scrape](#4-running-a-standard-scrape) ·
[Custom code](#5-writing-custom-scraper-code) · [Custom code API](#6-api-available-to-custom-code) ·
[Security](#7-security-model-and-limitations) · [Rate limiting](#8-rate-limiting-and-responsible-use) ·
[Jobs](#9-how-scraper-jobs-work) · [Troubleshooting](#10-troubleshooting) · [Licenses](#licenses)

---

## 1. How it works

```
Browser (Scraper page)                          MetaCode server (Node.js)
──────────────────────                          ─────────────────────────────────────────────
POST /api/scraper/jobs ───────────────────────▶ JobManager (queue, status, logs, results)
GET  /api/scraper/jobs/:id/events  ◀── SSE ───        │
GET  /api/scraper/jobs/:id/results                    ├─ standard scraper ─┐
GET  /api/scraper/jobs/:id/export                     └─ custom code ──────┤ (Pyodide or QuickJS sandbox
                                                                           │  process, asks the server over IPC)
                                                       RedditHttpClient  ◀─┘
                                                       destination check · robots.txt · rate limiter ·
                                                       retries · OAuth token · redirects
                                                              │
                                                       server engine (SCRAPER_SERVER_TRANSPORT):
                                                       Python worker python/reddit_fetch.py
                                                         (allow-list, no private IPs, TLS verify)
                                                       — or, without Python —
                                                       epoxy-tls (WASM) → WebSocket → Wisp /wisp/
                                                              │  TCP
                                                              ▼
                                                     www.reddit.com / oauth.reddit.com
```

1. The page sends the target and options to `POST /api/scraper/jobs`; the server validates them,
   creates a job and answers `202` immediately.
2. The job runs in the background (at most `SCRAPER_MAX_CONCURRENT_JOBS` at once; the rest wait as
   *queued*). Progress, log lines and new results are pushed to the page over server-sent events — the
   same mechanism `/api/ai` uses for streaming.
3. Every Reddit request goes through one client (`scraper/network/reddit-http.js`) that enforces the
   allowed hosts, robots.txt, the shared rate limiter, retries and Reddit's rate-limit headers, and
   sends the request with **epoxy-tls over MetaCode's own Wisp endpoint**.
4. Reddit's JSON is normalized into records (`scraper/reddit/format.js`): `post`, `comment`,
   `subreddit`, `user`. Fields Reddit didn't send are `null`.
5. Results stay in server memory (like the rest of MetaCode's server state) for
   `SCRAPER_JOB_RETENTION_MINUTES`. Export them, or click **Add to project** to store them in the
   project (browser localStorage) as posts.

Where requests are made — **Fetch Reddit through** (next to *Start scrape*):

| Engine | Default when | How | Notes |
|---|---|---|---|
| **This browser (Scramjet)** | no Reddit API credentials | The job runs on the server, but each Reddit request is handed to your open MetaCode tab, which fetches it through the same Scramjet transport as **Browse Reddit** (epoxy-tls over MetaCode's Wisp endpoint) and sends the answer back | **No setup.** Requests carry your browser's own User-Agent; no credentials are used; the server's robots.txt check doesn't apply (these are your browser's requests). Rate limiting, retries, caps and the Reddit-only allow-list still apply. Keep MetaCode open until the job finishes |
| **MetaCode server – Reddit Data API** | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` set | `oauth.reddit.com` | Application-only OAuth token; Reddit's documented API and limits apply. Works without a tab open |
| **MetaCode server – public pages** | (choose it explicitly) | `www.reddit.com/….json` | Checks Reddit's robots.txt before each path, which currently refuses most of Reddit |

Browser-mode request flow:

```
job (server) → RedditHttpClient → RelayHub ── SSE /api/scraper/relay/events ──▶ MetaCode tab
                                     ▲                                             │ claim, then fetch via
                                     └──── POST /api/scraper/relay/:id ◀───────────┘ epoxy-transport → /wisp/ → Reddit
```

The first tab to claim a request fetches it (several open tabs don't duplicate requests). Closing or
reloading the tab mid-job pauses its requests; MetaCode warns before you leave, and reopening MetaCode
(any page) resumes serving the job if it hasn't timed out. Custom code works in browser mode too.

## 2. How the MercuryWorkshop components are used

| Component | Package (version) | Where it sits | Why |
|---|---|---|---|
| **Wisp protocol** | spec: [wisp-protocol](https://github.com/MercuryWorkshop/wisp-protocol); server: `@mercuryworkshop/wisp-js` 0.5.0 | `/wisp/` WebSocket endpoint on the MetaCode server (`scraper/network/wisp-server.js`) | MetaCode's single egress point to Reddit. It multiplexes TCP streams over one WebSocket and enforces the allow-list (Reddit hosts, port 443, no UDP, no direct IPs, no private/loopback addresses) for both the server-side scraper and the in-app browser |
| **Epoxy TLS** | `@mercuryworkshop/epoxy-tls` 2.1.19-1 | In the server process (`scraper/network/epoxy-transport.js`) | HTTP + TLS client compiled to WebAssembly that tunnels through Wisp. TLS runs end-to-end between epoxy and Reddit with certificate verification (never disabled); the Wisp hop only sees ciphertext |
| **Scramjet** | `@mercuryworkshop/scramjet` 2.0.67-alpha.2 + `@mercuryworkshop/scramjet-controller` 0.0.14 | In the browser tab: service worker `public/scramjet-sw.js`, page code `public/js/scraper-browser.js`, files served at `/scramjet/*` | The **Browse Reddit** panel: an interception proxy that rewrites Reddit pages so they can be browsed inside MetaCode; "Use this page as target" turns the current page into a scrape target |
| **Epoxy transport** | `@mercuryworkshop/epoxy-transport` 3.0.1 | In the browser tab, shared by the Scramjet controller and browser-mode scrape jobs | The proxy-transports implementation Scramjet uses to fetch: epoxy-tls in the browser, connected to `wss://<MetaCode>/wisp/`. Browser-mode jobs fetch their Reddit requests with it (`scraper/network/browser-relay.js`) |
| **Bare transport** | `@mercuryworkshop/bare-transport` | **Not used** | It is a proxy-transports implementation for the legacy TompHTTP *Bare server* protocol — an alternative to Wisp, not a layer on top of it. Using it would require running a Bare server (an HTTP proxy endpoint) next to Wisp, adding a second egress path and attack surface with no benefit, so MetaCode uses the Wisp + epoxy transport only. (Scramjet's own bootstrapper doesn't implement the Bare option either.) |

Server-side jobs use the Python engine (`python/reddit_fetch.py`) when Python 3.8+ is installed. In that case epoxy-tls
over Wisp is their fallback, and it can be forced with `SCRAPER_SERVER_TRANSPORT=epoxy`. The in-app browser and
browser-mode jobs always use Scramjet + epoxy-transport over Wisp.

Request flow of the in-app browser:

```
iframe (proxied page) → scramjet-sw.js (service worker) → Scramjet controller (MetaCode tab)
  → rewrite → epoxy-transport (epoxy-tls in WASM) → wss://<MetaCode>/wisp/ → Reddit
```

Integration notes:

- Packages are installed from npm and served from `node_modules` at fixed paths (`/scramjet/scramjet.js`,
  `scramjet.wasm`, `controller.api.js`, `controller.inject.js`, `controller.sw.js`,
  `epoxy-transport.js`). Scramjet's `proxy-bootstrap` package was **not** used because it downloads
  packages from the npm registry at server start-up; pinning exact versions in `package.json`/the lockfile
  is safer and works offline. The Scramjet versions are pinned exactly because the controller checks that
  it is paired with the Scramjet build it was compiled for.
- The Scramjet controller's URL prefix is `/scramjet/~/`; the service worker only handles requests under
  that prefix and lets every other MetaCode request through.
- The Wisp endpoint accepts WebSocket upgrades only on exactly `/wisp/`, only from MetaCode's own origin
  (or, without an `Origin` header, from the local machine — the server-side scraper).
- wisp-js 0.5.0's `stream_limit_per_host` option crashes the process (it iterates an object), so it is
  left off; per-host concurrency is enforced by MetaCode's rate limiter. `stream_limit_total` (64) is used.
- wisp-js options are process-wide, so one scraper instance per process is supported.

## 3. Configuration

All settings live in the server's `.env` (see `.env.example`). Restart MetaCode after changing them.
Invalid values are ignored with a warning in the start-up banner.

| Variable | Default | What it does |
|---|---|---|
| `SCRAPER_ENABLED` | `true` | Turns the scraper (API, Wisp endpoint, browser files) on or off |
| `SCRAPER_USER_AGENT` | `nodejs:metacode-reddit-scraper:1.0 (self-hosted research tool)` | Sent with every request. Reddit asks for `<platform>:<app id>:<version> (by /u/<username>)` — set your own |
| `SCRAPER_CREDENTIALS_FILE` | `reddit-credentials.json` next to `server.js` | Where keys saved from the Scraper page are stored |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | — | Optional. Reddit app credentials → server engine uses the Reddit Data API (and becomes the default). Never sent to the browser, the sandbox, or logs |
| `SCRAPER_RESPECT_ROBOTS_TXT` | `true` | In public mode, check Reddit's robots.txt before each path |
| `SCRAPER_MIN_DELAY_MS` | `1000` | Minimum delay between two requests to the same host (all jobs combined) |
| `SCRAPER_PUBLIC_MIN_DELAY_MS` | `6000` | Higher minimum without API credentials — server public mode and browser mode (Reddit allows ≈10 unauthenticated requests/minute) |
| `SCRAPER_DEFAULT_DELAY_MS` | `2000` | Default "Delay between requests" in the form |
| `SCRAPER_REQUEST_TIMEOUT_MS` | `20000` | Maximum time per request (1000–120000) |
| `SCRAPER_MAX_CONCURRENT_REQUESTS` | `2` | Requests in flight per Reddit host, shared by all jobs (1–8) |
| `SCRAPER_MAX_ITEMS` / `SCRAPER_MAX_PAGES` | `5000` / `50` | Hard per-job caps |
| `SCRAPER_MAX_CONCURRENT_JOBS` | `2` | Jobs running at once; others queue |
| `SCRAPER_MAX_STORED_JOBS` / `SCRAPER_JOB_RETENTION_MINUTES` | `50` / `120` | How many finished jobs and for how long results are kept in memory |
| `SCRAPER_MAX_RESPONSE_BYTES` | `8388608` | Largest accepted Reddit response |
| `SCRAPER_CUSTOM_CODE_ENABLED` | `true` | Allow the Custom code mode |
| `SCRAPER_CUSTOM_TIMEOUT_MS` | `120000` | Wall-clock limit per custom run (1 s – 15 min) |
| `SCRAPER_CUSTOM_MEMORY_MB` | `64` | Memory limit of the QuickJS (JavaScript/TypeScript) sandbox |
| `SCRAPER_CUSTOM_PYTHON_MEMORY_MB` | `256` | WebAssembly memory limit of the Python (Pyodide) sandbox |
| `SCRAPER_SERVER_TRANSPORT` | `auto` | Who makes the server's HTTPS requests: `python` (python/reddit_fetch.py), `epoxy` (epoxy-tls over Wisp), or `auto` (Python when found, else epoxy-tls) |
| `SCRAPER_PYTHON` | — | Python command for the server engine (default: `python3`, then `python`, then `py -3` on Windows) |
| `SCRAPER_BROWSER_ENABLED` | `true` | Serve the in-app Reddit browser (Scramjet) and allow the browser engine |
| `REDDIT_BASE_URL` / `REDDIT_OAUTH_BASE_URL` | `https://www.reddit.com` / `https://oauth.reddit.com` | Where Reddit is reached. Change only for testing against a mock |
| `SCRAPER_ALLOW_PRIVATE_NETWORK` | `false` | Lets the Wisp proxy connect to private/loopback addresses. **Testing only** |

Requirements: **Node.js 22 or newer** for the scraper (WebSocket client for epoxy-tls, `--permission`
for the sandbox; TypeScript needs 22.13+). The rest of MetaCode still runs on Node 18; the Scraper page
then explains what's missing.

### Reddit API credentials

Needed when Reddit refuses logged-out requests from your network — the job then fails with
*"Reddit refused this request because it was made without a Reddit login or API key"* (an HTTP 403 block
page). That refusal applies to everything you request logged out, whichever subreddit it is; MetaCode doesn't try
to get around it. Reddit's API with a free app's keys is the supported way in. Also useful to scrape without
keeping a tab open.

**From the Scraper page (no restart, no `.env`):**

1. Sign in to Reddit and open <https://www.reddit.com/prefs/apps>. Read Reddit's
   [Data API Terms](https://www.redditinc.com/policies/data-api-terms) and
   [Developer Terms](https://www.redditinc.com/policies/developer-terms); research use may need
   Reddit's approval.
2. **create another app…** → name it, type **script**, redirect URI `http://localhost:3000` → create.
3. On the Scraper page open **Reddit API access → Set up** (or click **Set up Reddit API access** on the failed
   job), paste the ID shown under the app's name and the **secret**, optionally your username, and click
   **Check & save**. MetaCode asks Reddit for a token with them; only keys that work are saved.
4. **Fetch Reddit through** switches to **MetaCode server (Reddit API)**. Run the job again.

The keys are saved on the server in `reddit-credentials.json` (next to `server.js`, file mode 600, git-ignored;
another path can be set with `SCRAPER_CREDENTIALS_FILE`). The secret is never sent back to the browser,
logged, or given to custom code. **Disconnect** deletes the file.

**Or in `.env`** (takes precedence; the page then can't change them): `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
and `SCRAPER_USER_AGENT`, e.g. `nodejs:metacode-scraper:1.0 (by /u/your_username)`, then restart.

Subreddits that are **private**, **quarantined** or **Premium-only** can't be read with app keys either; the
error says which it is.

MetaCode uses the application-only `client_credentials` grant: it reads public data only and never logs
in as a user.

### RedditAPIs.com API key (third-party, paid)

[RedditAPIs.com](https://www.redditapis.com) is a **third-party commercial service, not Reddit**. It sells
Reddit data through its own REST API (`https://api.redditapis.com`) and charges per request. MetaCode can use
it as a third way to fetch data: **Fetch Reddit through → RedditAPIs.com (API key, paid per request)**.
Pricing, terms and how it sources its data are between you and that vendor. Read its terms and check that
using it fits your research ethics/IRB requirements.

1. Create a key at <https://www.redditapis.com/dashboard/api-keys>.
2. On the Scraper page open **Reddit API access → RedditAPIs.com key**, paste the key and click
   **Check & save**. MetaCode checks the key against `GET /account/me`, which costs nothing, and saves it only if
   it works. The card shows the last four characters and your balance.
   Or set `REDDITAPIS_KEY` in `.env` (this takes precedence). `REDDITAPIS_BASE_URL` overrides the API origin.
3. The engine switches to RedditAPIs.com. Run the job.

The key is saved in `redditapis-key.json` next to `server.js` (file mode 600, git-ignored). Set
`SCRAPER_REDDITAPIS_KEY_FILE` to store it somewhere else. It is never sent back to the browser, logged, or
given to custom code. **Remove** deletes the file.

Every request is a billed call, so keep **Maximum items/pages** modest. The rate limiter still applies
(`SCRAPER_MIN_DELAY_MS`).

What works with this engine:

- subreddit listings (all sorts, plus time range for top/controversial);
- search (site-wide or in a subreddit);
- post + comments;
- subreddit info;
- user info;
- a user's **Posts** or **Comments**;
- the combine-sorts sweep;
- custom code through `ctx.reddit.*` / `ctx.reddit.json(path)` for those same paths.

What doesn't work:

- the user *overview*: pick Posts or Comments instead;
- front page / domain listings;
- loading collapsed comments (`/api/morechildren`);
- `ctx.fetch()`.

These fail with a clear "not available with the RedditAPIs.com engine" message.

The errors you may see map to:

- an invalid key → "check the key";
- out of credit (HTTP 402) → top up;
- a rate limit (429) → backs off and retries.

## 4. Running a standard scrape

1. Sidebar → **Scraper**. Leave **Standard scraper** selected. **Fetch Reddit through** is *This browser
   (Scramjet)* unless API credentials are configured — nothing else to set up.
2. **What to scrape**:
   - **Subreddit** — name (combine with `+`, e.g. `science+askscience`), sort (hot/new/top/rising/
     controversial), time range for top/controversial.
   - **Search** — query (Reddit search syntax such as `title:` and `author:` works), optional subreddit,
     sort, time range.
   - **Post + comments** — a post URL or id; comment sort. Collects the post and its comment tree.
   - **User profile** — overview, posts (submitted) or comments; sort; time range.
   - **Any Reddit URL** — paste a link; **Check** shows what it was recognized as. Share links
     (`/r/…/s/…`) can't be resolved — open them and paste the full URL.
   - **Front page / domain**, **Subreddit info**, **User info**.
   - Or open **Browse Reddit**, navigate, and click **Use this page as target**.
3. **Limits & politeness**: maximum items and pages (≤ 100 items per page), delay between requests (the
   server minimum always applies), request timeout, concurrent requests, retries. Optionally fetch the
   comments of the first N listing posts (one request per post) and subreddit/profile metadata.
   Two options for larger collections:
   - **Combine sorts** (subreddits) — Reddit serves at most ~1,000 items per listing. With this on, the
     scraper pages through the chosen sort, then new, hot, top (all/year/month/week), controversial
     (all/year) and rising, keeping only posts it hasn't seen, until *Maximum items* unique posts.
     *Maximum pages* applies to each sort, so one job can make up to 10 × that many listing requests.
   - **Load collapsed comments** — fetches comments hidden behind "load more" through the API's
     `/api/morechildren` (up to 100 per request, at most 20 requests per post), up to *Comments per post*.
     Needs Reddit API access; in other modes the log says it was skipped.
4. **Start scrape**. The job card shows status, items, pages, requests, skipped duplicates, errors, start
   time and duration; tabs show **Results**, **JSON**, **Logs** and **Metadata**.
5. Results: search, filter by type, sort, click a row for all fields (and a post's comments), **Copy
   JSON**, **Export…** (CSV, JSON, JSON with comments nested under posts, NDJSON, reply-network edges
   for Analyze CSV), **Add to project** (posts/comments become project posts with the whole post as
   their text, and each one's engagement goes to **Metrics** → *Engagement by post*: score → likes,
   comment count → comments, crossposts → shares, plus upvote ratio and awards — Reddit has no view
   counts. Posts already in the project keep their text and codes; adding them again updates their
   engagement numbers).

Record fields (any may be `null`):

- **post** — `post_id, fullname, title, author, subreddit, url, permalink, created_at, created_utc, edited_at,
  score, upvote_ratio, num_comments, selftext, full_text, flair, author_flair, domain, is_self, over_18, spoiler,
  stickied, locked, archived, distinguished, num_crossposts, total_awards, media {type, url, thumbnail, items}`
  - `selftext` is the post's text. When Reddit's `selftext` is empty it is read from `selftext_html`
    (as plain text), from the field another API uses for it, or — for a crosspost — from the original post.
  - `full_text` is the entire post as readable text: the title, the text, and for posts without text
    what they consist of (the link, image or video URL, gallery captions, poll options), plus where a
    crosspost came from. The results table, the detail view and **Add to project** use it.
- **comment** — `comment_id, fullname, post_id, parent_id, parent_type, author, subreddit, body, score,
  created_at, created_utc, edited_at, permalink, depth, is_submitter, stickied, distinguished,
  controversiality, author_flair, post_title, post_permalink`
- **subreddit** — `subreddit_id, name, title, description, subscribers, active_users, created_at, over_18,
  subreddit_type, lang, url, icon`
- **user** — `user_id, name, created_at, link_karma, comment_karma, total_karma, is_employee, is_mod,
  verified, icon, profile_url`

CSV exports neutralize spreadsheet formulas (cells starting with `= + - @` get a leading `'`), because
scraped text is untrusted.

## 5. Writing custom scraper code

Switch to **Custom code**. Pick a language: **Python** (the default), **JavaScript** or **TypeScript**.
Define `scrape(ctx)`; emit records as you go, or return them.

```python
import statistics

async def scrape(ctx):
    sub = ctx.params.get("subreddit", "AskScience")
    async for page in ctx.reddit.pages(f"/r/{sub}/new", max_pages=3):
        busy = [p for p in page["records"] if p["num_comments"] >= 10]
        ctx.emit(busy)
        if busy:
            print("page", page["number"], "median score", statistics.median(p["score"] for p in busy))
```

```js
async function scrape(ctx) {
  const sub = ctx.params.subreddit || 'AskScience';
  for await (const page of ctx.reddit.pages('/r/' + sub + '/new', { maxPages: 3 })) {
    ctx.emit(page.records.filter(p => p.num_comments >= 10));
    ctx.progress({ message: 'page ' + page.number });
  }
}
```

- **Load an example…** offers ready-made scripts for each language:
  - Python:
    - pagination;
    - keyword matches with a regex and a `Counter`;
    - post comments plus `statistics`;
    - a per-author summary;
    - raw fetch with retries.
  - JavaScript: the same kinds of examples.
  - TypeScript: one example.
  Switching the language swaps an untouched example for the same example in the new language.
- **Parameters** (JSON object) become `ctx.params`. The target form is optional in this mode
  (`ctx.target` is the normalized target, or `null`/`None` for "No target").
- The limits form applies:
  - `ctx.options.maxItems` caps results;
  - `maxPages` caps `ctx.reddit.pages`;
  - the delay, concurrency and retries apply to every request your code makes.
- Return a list/array of records, `{data: [...]}`, `{data, meta}` (`meta` appears in the Metadata tab), or nothing.
  Records must be JSON-serializable (in Python, `datetime`s and sets are converted for you). Records with the
  same Reddit `fullname` are kept once.
- **Python**:
  - `print()` writes to the job log.
  - The whole standard library is available (`re`, `json`, `statistics`, `collections`, `datetime`, `itertools`,
    `math`, `csv`, `html`…).
  - Third-party packages (pandas, requests, praw…) are not. Export the results and analyse them in your own Python.
  - A plain `def scrape(ctx)` works too, but anything that talks to Reddit must be awaited, so use `async def`.
  - Errors show a normal Python traceback of your code.
- **TypeScript**: type annotations are stripped before running. Enums, namespaces and parameter properties
  aren't supported.
- **JavaScript**: `console.log` writes to the job log.

## 6. API available to custom code

### Python

| API | Description |
|---|---|
| `ctx.target`, `ctx.params`, `ctx.options` | Dicts: the normalized target (or `None`), the parameters, the limits (`maxItems`, `maxPages`, `commentLimit`, …) |
| `ctx.mode` | `"oauth"`, `"public"`, `"browser"` or `"redditapis"` |
| `await ctx.reddit.json(path, query=None)` | GET a Reddit JSON endpoint → parsed JSON |
| `async for page in ctx.reddit.pages(path, max_pages=None, limit=100, after=None, query=None)` | Listing pages: dicts with `number, records, children, after` |
| `await ctx.reddit.listing(path, max_items=None, max_pages=None, query=None)` | → `{"items": [...], "pages": n}` |
| `await ctx.reddit.post(post_id, limit=None, depth=None, sort="confidence")` | → `{"post", "comments", "more_count"}` |
| `await ctx.reddit.subreddit(name)` / `await ctx.reddit.user(name)` | Info records |
| `ctx.reddit.normalize_post / normalize_comment / normalize_subreddit / normalize_user / normalize_thing / flatten_comments / extract_media / to_iso` | The standard scraper's formatters |
| `await ctx.fetch(url, method="GET", headers=None)` | GET/HEAD to Reddit hosts only → requests-style response: `.ok`, `.status`/`.status_code`, `.url`, `.headers.get()`, `.text`, `.json()`, `.raise_for_status()` |
| `ctx.emit(record_or_list)` / `ctx.remaining()` | Add results now → items still allowed |
| `ctx.log(...)`, `ctx.log.debug/info/warn/error(...)`, `print(...)` | Job log (max 2000 lines) |
| `ctx.progress(message=None, pages=None)` | Progress line / page counter |
| `await ctx.sleep(seconds)` | Wait (≤ 60 s per call) |
| `await ctx.retry(fn, retries=2, delay=2.0, factor=2.0)` | Calls `fn(attempt)` (sync or async) with exponential backoff |
| `ctx.utils.get(obj, "a.b.0", default)`, `pick`, `unique(items, key=None)`, `chunk`, `strip_html`, `decode_entities` | Helpers |

Failed host requests raise `ScraperError` (available by name in your code). Its `.type` is one of
`"not_found"`, `"rate_limited"`, `"forbidden"`, `"host_not_allowed"`, `"robots_disallowed"` and so on. If you
don't catch it, the job fails with the same type and message.

### JavaScript / TypeScript

| API | Description |
|---|---|
| `ctx.target` | Normalized target from the form, or `null` |
| `ctx.params` | Parameters JSON object |
| `ctx.options` | `maxItems, maxPages, delayMs, timeoutMs, concurrency, retries, includeComments, commentPosts, commentLimit, commentDepth, includeMetadata` |
| `ctx.mode` | `"oauth"` or `"public"` |
| `ctx.reddit.json(path, query?)` | GET a Reddit JSON endpoint (API or public pages, chosen automatically) → parsed JSON |
| `ctx.reddit.pages(path, { query, maxPages, limit, after }?)` | Async iterator over listing pages: `{ number, records, children, after }` |
| `ctx.reddit.listing(path, { query, maxPages, maxItems }?)` | → `{ items, pages }` |
| `ctx.reddit.post(id, { limit, depth, sort }?)` | → `{ post, comments, moreCount }` |
| `ctx.reddit.subreddit(name)` / `ctx.reddit.user(name)` | Info records |
| `ctx.reddit.normalizePost / normalizeComment / normalizeSubreddit / normalizeUser / normalizeThing / flattenComments / extractMedia / toIso` | The standard scraper's formatters |
| `ctx.fetch(url, { method, headers }?)` | GET/HEAD to Reddit hosts only. Headers allowed: `accept`, `accept-language`, `if-none-match`, `if-modified-since`. → `{ ok, status, statusText, url, headers.get/has/entries, text(), json() }` (response headers limited to content-type, caching and rate-limit headers) |
| `ctx.emit(recordOrArray)` | Add results now → number of items still allowed |
| `ctx.remaining()` | Items still allowed |
| `ctx.log(...)`, `ctx.log.debug/info/warn/error(...)` | Job log (max 2000 lines) |
| `ctx.progress({ message, pages })` | Progress line / page counter |
| `ctx.sleep(ms)` | Wait (≤ 60 s per call) |
| `ctx.retry(fn, { retries = 2, delayMs = 2000, factor = 2 })` | Retry with exponential backoff |
| `ctx.utils.get(obj, 'a.b.c', fallback)`, `pick(obj, keys)`, `unique(arr, keyFn)`, `chunk(arr, n)`, `stripHtml(html)`, `decodeEntities(text)`, `matchAll(regex, text)` | Helpers |

Errors from the host (blocked host, robots.txt refusal, 429 after retries, timeouts, cancellation) are
thrown into your code as `Error` objects with a `type` property; uncaught, they fail the job with the
same message.

## 7. Security model and limitations

Custom code is untrusted and never runs in the MetaCode server's own JavaScript engine or in the server's
Python. Each run gets a fresh, locked-down process.

**JavaScript / TypeScript — QuickJS** (`quickjs-emscripten`):

- The code runs in a separate JavaScript engine compiled to WebAssembly.
- It has no `require`, `process`, file system, timers, `fetch` or any Node object.
- The only bridge is two functions that exchange JSON strings with the host.
- Memory is capped (`SCRAPER_CUSTOM_MEMORY_MB`), CPU loops are interrupted at the deadline, and stack depth is limited.

**Python — Pyodide** (CPython compiled to WebAssembly). Pyodide can call into JavaScript, so its process takes
away everything network-shaped before your code runs:

- Python's `js` module is an empty object (timers only), not Node's global scope.
- The networking built-ins (`net`, `tls`, `http(s)`, `dns`, `vm`, `child_process`, …) can't be loaded: there is a
  module resolve hook and `process.getBuiltinModule` is removed.
- `fetch`, `WebSocket` and similar globals are deleted.
- Pyodide's opt-in Node sockets, host-folder mounts (`NODEFS`) and package downloads are disabled.
- `os.system` and similar functions raise `PermissionError`.
- WebAssembly memory can't grow past `SCRAPER_CUSTOM_PYTHON_MEMORY_MB` (your code gets `MemoryError`).
- An infinite loop is killed at the timeout; records emitted before that are kept.

The test suite checks each of these from inside Python: Node globals, the `Function` constructor, `run_js`, Node
sockets, `socket`, `asyncio` connections, `urllib`, `pyfetch`, host mounts, package installs, `os.system`,
`subprocess`, server files and secrets. A walk over every JavaScript object Python can reach finds no route to
`process`, `require` or the global scope.

**Both languages** run in a process started with:

- Node's permission model (`--permission`). The process may read only its engine's own files. It can't write
  files, read `.env` or any other file, spawn processes, start workers, load native addons or use WASI.
- An empty environment: no API keys or secrets.
- A capped V8 heap and string code generation disabled.
- A hard kill (SIGKILL) from the parent at the timeout or on cancellation.

All network access is performed by the server (or, in browser mode, relayed to your MetaCode tab) on
the sandbox's behalf: Reddit hosts only, GET/HEAD
only, through the rate limiter, robots.txt policy and the Wisp allow-list. OAuth tokens are added by
the server and never visible to the code; `set-cookie` and other response headers are filtered out.
Every message from the sandbox is size-capped (1 MB per batch, 64 MB per run).

Limitations to be aware of:

- Node's permission model doesn't restrict network sockets in Node 22. A hypothetical escape from
  QuickJS's or Pyodide's WebAssembly sandbox into the child's Node runtime would still have no files, no
  secrets and no child processes. For Python, the module hook and the removed globals also stand in the
  way. It could, however, try to open network connections. Run MetaCode on a trusted network, or set
  `SCRAPER_CUSTOM_CODE_ENABLED=false` on shared deployments.
- Python scrapers need Node.js 22.15+ (for the module hook). Each run starts a fresh interpreter, which
  takes about 2 seconds.
- Browser mode: the tab only fetches GET/HEAD requests to Reddit hosts that the server already
  validated, and checks the host again itself. Relay answers are accepted only from MetaCode's own
  origin. Requests go out with your browser's User-Agent from your own connection, and robots.txt is
  not consulted — you are responsible for using it within Reddit's terms.
- MetaCode has no user accounts: anyone who can open the MetaCode page can start jobs. The scraper API
  only answers same-origin requests and refuses cross-site state changes, and the Wisp endpoint refuses
  other origins — but don't expose MetaCode to untrusted networks.
- wisp-js 0.5.0 checks a stream's resolved address and then resolves the hostname again when connecting
  (its DNS-cache TTL compares milliseconds with seconds), so DNS rebinding isn't fully excluded at the
  Wisp layer. The hostname allow-list only admits Reddit-owned domains, which keeps this theoretical.
- Results live in server memory; a restart loses them (export or add them to the project).
- The in-app browser renders Reddit inside MetaCode's origin through Scramjet's rewriting; it is a
  convenience for finding targets, not a security boundary. Don't sign in to Reddit inside it.

## 8. Rate limiting and responsible use

- One **shared limiter** for all jobs and custom code: at least `SCRAPER_MIN_DELAY_MS` (OAuth) or
  `SCRAPER_PUBLIC_MIN_DELAY_MS` (public) between request starts to the same host, and at most
  `SCRAPER_MAX_CONCURRENT_REQUESTS` in flight. A job's own delay can only be larger.
- Reddit's `X-Ratelimit-Remaining`/`-Reset` headers are followed: when the window is used up, all
  requests to that host wait for the reset.
- HTTP 429 honours `Retry-After` (up to 5 minutes); 5xx, timeouts and network errors are retried with
  exponential backoff and jitter, up to the job's **Retries** (0–5).
- Hard caps on items, pages, response size and job count; descriptive User-Agent on every request.
- The scraper doesn't log in, solve CAPTCHAs, rotate IPs, spoof browsers or follow login / age-gate
  redirects — such pages fail with an explanation. Private, quarantined or banned communities fail with
  a 403 message.
- You are responsible for complying with Reddit's terms, its API rules and your research ethics
  approvals (e.g. handling of usernames and deleted content).

## 9. How scraper jobs work

| Status | Meaning |
|---|---|
| `queued` | Waiting for a free slot (`SCRAPER_MAX_CONCURRENT_JOBS`) |
| `running` | Fetching; progress and logs stream to the page |
| `completed` | Finished (possibly with 0 items — the log explains) |
| `failed` | Stopped by an error; items collected before it are kept |
| `cancelled` | Stopped by **Cancel**; items collected before it are kept |

API (same-origin; errors are `{ error: { message, type } }`):

| Endpoint | |
|---|---|
| `GET /api/scraper/status` | Mode, transport, limits, sandbox availability |
| `POST /api/scraper/resolve` | `{ target }` → normalized target (validation) |
| `POST /api/scraper/jobs` | `{ mode: "standard"\|"custom", target, options, code?, language?, params? }` → `202 { job }` |
| `GET /api/scraper/jobs` | Recent jobs |
| `GET /api/scraper/jobs/:id` | Job detail incl. logs |
| `GET /api/scraper/jobs/:id/events` | Server-sent events: `snapshot`, `status`, `progress`, `log`, `records`, `meta`; ends when the job finishes |
| `GET /api/scraper/jobs/:id/results?offset&limit&type&search` | Records |
| `GET /api/scraper/jobs/:id/logs` | Log lines |
| `GET /api/scraper/jobs/:id/export?format=csv\|json\|ndjson&type=&nested=1` | Download |
| `POST /api/scraper/jobs/:id/cancel` | Cancel |
| `DELETE /api/scraper/jobs/:id` | Cancel if needed and delete |

## 10. Troubleshooting

| Message / symptom | Cause and fix |
|---|---|
| "Reddit's robots.txt doesn't allow automated access …" | Server engine without credentials. Switch **Fetch Reddit through** to *This browser (Scramjet)*, or configure [Reddit API credentials](#reddit-api-credentials) |
| "No MetaCode browser tab is connected …" | A browser-mode job needs MetaCode open in a tab. Reopen MetaCode (any page) and start the job again |
| "Couldn't verify Reddit's TLS certificate …" | A proxy, firewall or antivirus intercepts HTTPS. epoxy-tls verifies certificates end-to-end and won't accept an interception certificate; run MetaCode on a network without HTTPS inspection |
| "The Wisp proxy closed the connection before TLS started …" | The host isn't allowed, resolved to a private address, or is unreachable from the server. Check internet access; don't point `REDDIT_BASE_URL` at private hosts without `SCRAPER_ALLOW_PRIVATE_NETWORK` |
| "MetaCode couldn't reach its Wisp proxy endpoint" | The server's own `/wisp/` WebSocket failed — restart MetaCode; check that a reverse proxy forwards WebSocket upgrades |
| "Reddit refused this request because it was made without a Reddit login or API key …" | Reddit blocks logged-out access from your network (all subreddits, not just this one). Connect [Reddit API access](#reddit-api-credentials) on the Scraper page and run with *MetaCode server (Reddit API)* |
| "r/… is private" / "is quarantined" / "only available to Reddit Premium members" | Reddit restricts that community; it can't be scraped |
| "Reddit refused the API sign-in request with a block page …" | Reddit blocks this network even for the API; MetaCode can't reach Reddit from here |
| "The keys weren't saved: Reddit rejected the API client ID / secret" | Re-copy the ID (under the app name) and secret; the app type must be **script** |
| "… refused access (HTTP 403 …)" (other) | Restricted page, or Reddit wants a login/API key from this network → connect Reddit API access |
| "That subreddit doesn't exist" | Reddit redirected to subreddit search: check the spelling |
| "Reddit is rate-limiting requests (HTTP 429) …" | Raise **Delay between requests**, lower concurrency, or wait |
| "Reddit sent a web page instead of data …" | Block/login/age page; use API credentials |
| "Reddit rejected REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET" | Check the values, the app type (script/web) and restart |
| Job completed with 0 items | Empty listing, no search matches, or limits too small — see the Logs tab |
| "Your scraper threw an error: …" / ran past the time limit / out of memory | Fix the code (the message includes the line in `scraper.py` / `scraper.js`); emit in batches; raise `SCRAPER_CUSTOM_TIMEOUT_MS` / `SCRAPER_CUSTOM_PYTHON_MEMORY_MB` / `SCRAPER_CUSTOM_MEMORY_MB` if needed |
| "Your scraper tried to use something the sandbox doesn't allow" | Python code reached for networking or programs; use `ctx.fetch` / `ctx.reddit` |
| "Python scrapers need Node.js 22.15 or newer" / "The Python sandbox (Pyodide) isn't installed" | Update Node.js / run `npm install` |
| "Python 3.8+ wasn't found for the Python scraper engine" | Only with `SCRAPER_SERVER_TRANSPORT=python`: install Python 3 or set `SCRAPER_PYTHON`. With `auto`, MetaCode uses epoxy-tls instead |
| "Couldn't verify the server's TLS certificate … (Python engine)" | On macOS with Python from python.org run *Install Certificates.command* (or `pip install certifi`); otherwise an HTTPS-inspecting proxy is in the way |
| "The custom-code sandbox needs Node.js 22 …" / "TypeScript needs Node.js 22.13 …" | Upgrade Node.js |
| Browse Reddit: "couldn't start" | Needs a browser with service workers and MetaCode at `http://localhost` or `https://`; check that `SCRAPER_BROWSER_ENABLED` isn't `false` |
| Results disappeared | Jobs are kept in memory for `SCRAPER_JOB_RETENTION_MINUTES` and lost on restart — export or add to the project |
| `npm test` browser tests skipped | No Chromium found; set `CHROMIUM_PATH` or install one with `npx playwright install chromium` |

## Licenses

Some MercuryWorkshop packages are **AGPL-3.0-only** (Scramjet, scramjet-controller, epoxy-tls,
epoxy-transport); wisp-js is LGPL-3.0-or-later; quickjs-emscripten is MIT. MetaCode itself is MIT.
If you distribute MetaCode, or let others use a modified version over a network, the AGPL's obligations
(offering the corresponding source) apply to those components — review them before deploying beyond
your own machine. Setting `SCRAPER_BROWSER_ENABLED=false` stops serving the Scramjet/epoxy-transport
browser code; epoxy-tls is still used on the server.
