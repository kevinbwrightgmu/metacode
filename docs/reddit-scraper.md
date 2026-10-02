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
GET  /api/scraper/jobs/:id/export                     └─ custom code ──────┤ (QuickJS sandbox process,
                                                                           │  asks the server over IPC)
                                                       RedditHttpClient  ◀─┘
                                                       destination check · robots.txt · rate limiter ·
                                                       retries · OAuth token · redirects
                                                              │
                                                       epoxy-tls (WASM, TLS client)
                                                              │  WebSocket
                                                       Wisp endpoint /wisp/ (wisp-js, allow-list)
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
| `SCRAPER_CUSTOM_MEMORY_MB` | `64` | Memory limit of the QuickJS sandbox |
| `SCRAPER_BROWSER_ENABLED` | `true` | Serve the in-app Reddit browser (Scramjet) and allow the browser engine |
| `REDDIT_BASE_URL` / `REDDIT_OAUTH_BASE_URL` | `https://www.reddit.com` / `https://oauth.reddit.com` | Where Reddit is reached. Change only for testing against a mock |
| `SCRAPER_ALLOW_PRIVATE_NETWORK` | `false` | Lets the Wisp proxy connect to private/loopback addresses. **Testing only** |

Requirements: **Node.js 22 or newer** for the scraper (WebSocket client for epoxy-tls, `--permission`
for the sandbox; TypeScript needs 22.13+). The rest of MetaCode still runs on Node 18; the Scraper page
then explains what's missing.

### Reddit API credentials

Optional — browser mode needs none. Use them to scrape without keeping a tab open, or for Reddit's
official API limits.

1. Sign in to Reddit and open <https://www.reddit.com/prefs/apps>. Read and accept Reddit's
   [Data API Terms](https://www.redditinc.com/policies/data-api-terms) and
   [Developer Terms](https://www.redditinc.com/policies/developer-terms); research use may need
   Reddit's approval.
2. **Create app** → type **script** (or **web app**), any redirect URI (e.g. `http://localhost:3000`).
3. Put the id shown under the app name in `REDDIT_CLIENT_ID` and the *secret* in `REDDIT_CLIENT_SECRET`.
4. Set `SCRAPER_USER_AGENT`, e.g. `nodejs:metacode-scraper:1.0 (by /u/your_username)`, and restart.

MetaCode uses the application-only `client_credentials` grant: it reads public data only and never logs
in as a user.

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
4. **Start scrape**. The job card shows status, items, pages, requests, skipped duplicates, errors, start
   time and duration; tabs show **Results**, **JSON**, **Logs** and **Metadata**.
5. Results: search, filter by type, sort, click a row for all fields (and a post's comments), **Copy
   JSON**, **Export…** (CSV, JSON, JSON with comments nested under posts, NDJSON, reply-network edges
   for Analyze CSV), **Add to project** (posts/comments become project posts; score → likes, comment
   count → comments; existing ids are skipped).

Record fields (any may be `null`):

- **post** — `post_id, fullname, title, author, subreddit, url, permalink, created_at, created_utc, edited_at,
  score, upvote_ratio, num_comments, selftext, flair, author_flair, domain, is_self, over_18, spoiler,
  stickied, locked, archived, distinguished, num_crossposts, total_awards, media {type, url, thumbnail, items}`
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

Switch to **Custom code**. Define `scrape(ctx)`; emit records as you go or return them:

```js
async function scrape(ctx) {
  const sub = ctx.params.subreddit || 'AskScience';
  for await (const page of ctx.reddit.pages('/r/' + sub + '/new', { maxPages: 3 })) {
    ctx.emit(page.records.filter(p => p.num_comments >= 10));
    ctx.progress({ message: 'page ' + page.number });
  }
}
```

- **Load an example…** offers ready-made scripts (pagination, keyword filter, post comments, raw fetch
  with retries, TypeScript).
- **Parameters** (JSON object) become `ctx.params`. The target form is optional in this mode
  (`ctx.target` is the normalized target, or `null` for "No target").
- The limits form applies: `ctx.options.maxItems` caps results, `maxPages` caps `ctx.reddit.pages`, the
  delay/concurrency/retries apply to every request your code makes.
- Return an array, `{ data: [...] }`, `{ data, meta }` (meta appears in the Metadata tab), or nothing.
  Records must be JSON-serializable objects; records with the same Reddit `fullname` are kept once.
- TypeScript: choose **TypeScript**; type annotations are stripped before running (enums, namespaces and
  parameter properties aren't supported).
- `console.log` writes to the job log.

## 6. API available to custom code

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

Custom code is untrusted and never runs in the MetaCode server's JavaScript engine. Two layers:

1. **QuickJS sandbox** (`quickjs-emscripten`): the code runs in a separate JavaScript engine compiled to
   WebAssembly. It has no `require`, `process`, file system, timers, `fetch` or any Node object. The only
   bridge is two functions that exchange JSON strings with the host; the host decides what each call may
   do. Memory is capped (`SCRAPER_CUSTOM_MEMORY_MB`), CPU loops are interrupted at the deadline, stack
   depth is limited.
2. **Restricted process**: each run gets a fresh Node process started with Node's permission model
   (`--permission`): it may read only the QuickJS engine files; it cannot write files, read `.env` or any
   other file, spawn processes, start workers, load native addons or use WASI. Its environment is empty
   (no API keys or secrets), its V8 heap is capped, string code generation is disabled, and the parent
   kills it (SIGKILL) at the timeout or on cancellation.

All network access is performed by the server (or, in browser mode, relayed to your MetaCode tab) on
the sandbox's behalf: Reddit hosts only, GET/HEAD
only, through the rate limiter, robots.txt policy and the Wisp allow-list. OAuth tokens are added by
the server and never visible to the code; `set-cookie` and other response headers are filtered out.
Every message from the sandbox is size-capped (1 MB per batch, 64 MB per run).

Limitations to be aware of:

- Node's permission model doesn't restrict network sockets in Node 22. A hypothetical escape from
  QuickJS's WebAssembly memory into the child's Node runtime would still have no files, no secrets and
  no child processes, but could open network connections. Run MetaCode on a trusted network, or set
  `SCRAPER_CUSTOM_CODE_ENABLED=false` on shared deployments.
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
| "Reddit refused access (HTTP 403) …" | Private/quarantined/banned community, or Reddit blocks unauthenticated traffic from your network → use API credentials |
| "That subreddit doesn't exist" | Reddit redirected to subreddit search: check the spelling |
| "Reddit is rate-limiting requests (HTTP 429) …" | Raise **Delay between requests**, lower concurrency, or wait |
| "Reddit sent a web page instead of data …" | Block/login/age page; use API credentials |
| "Reddit rejected REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET" | Check the values, the app type (script/web) and restart |
| Job completed with 0 items | Empty listing, no search matches, or limits too small — see the Logs tab |
| "Your scraper threw an error: …" / ran past the time limit / out of memory | Fix the code (the message includes the line in `scraper.js`); emit in batches; raise `SCRAPER_CUSTOM_TIMEOUT_MS` / `SCRAPER_CUSTOM_MEMORY_MB` if needed |
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
