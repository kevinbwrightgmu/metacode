# Reddit Collector (client-side, Scramjet)

A local-first app for collecting **public** Reddit posts and comments. It loads Reddit pages
in an embedded browser built on [MercuryWorkshop Scramjet](https://github.com/MercuryWorkshop/scramjet).
A bot reads posts and comments from those pages, saves them in this browser's IndexedDB, and
you inspect and export them (JSON, JSON Lines, CSV).

The collector is part of MetaCode. The MetaCode server serves it at **`/collector/`**,
together with the Scramjet files and the proxy endpoint it needs. All collection, storage and
export happen in your browser.

**In MetaCode it is the sidebar's Scraper page** (`app.html#scraper`, the collector in a frame).
There, **Add to project** (in the Monitor after a job, and in Data for the records shown) sends
posts and comments to the open project. Score and comment count go with them as engagement, so
they show up in Metrics. Adding them again updates those numbers. The older server-side scraper
(Reddit API keys, custom code) is linked at the top of that page.

Running MetaCode on a server behind nginx with pm2: see [docs/deploy-vps.md](../docs/deploy-vps.md).

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Using it](#using-it)
- [robots.txt and Reddit's rules](#robotstxt-and-reddits-rules)
- [Configuration](#configuration)
- [Data, storage and exports](#data-storage-and-exports) (full schema: [SCHEMA.md](SCHEMA.md))
- [Security](#security)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Quick start

Prerequisites:

- **Node.js 22.12 or newer.** Vite 7 needs ^20.19 or ≥22.12, and MetaCode's scraper needs Node 22.
- **A browser with service workers and WebAssembly**, opened at `http://localhost` or over
  `https://`. Current Chrome, Edge and Firefox work. Private windows may block service workers.
- MetaCode's own dependencies (`npm install` in the MetaCode folder). Python is optional.

```bash
# in the MetaCode folder
npm install                    # MetaCode server
npm run collector:install      # collector dependencies (collector/node_modules)
npm run collector:build        # type-check + production build → collector/dist
npm start                      # MetaCode at http://localhost:3000
# open http://localhost:3000/app.html#scraper (inside MetaCode) or http://localhost:3000/collector/
```

| Command (MetaCode folder) | What it does |
|---|---|
| `npm run collector:dev` | Vite dev server with hot reload at http://localhost:5173/collector/. Run `npm start` first: Vite proxies Scramjet's files, the service worker and the Wisp endpoint to that server (`METACODE_URL`, see `collector/.env.example`). |
| `npm run collector:build` | Type-check (`tsc`) and build into `collector/dist`, which MetaCode serves at `/collector/`. |
| `npm run collector:test` | Unit tests (Vitest + jsdom + fake IndexedDB), no network. |
| `node --test --test-force-exit test/collector.test.js` | End-to-end tests in Chromium through real Scramjet, against a local stand-in for Reddit. Needs a build. Also part of `npm test`. |
| `npm --prefix collector run typecheck` | Type-check only. |
| `npm run collector:live-check -- --subreddit=science` | Manual check against **live** Reddit (see [Tests](#tests)). |

## How it works

```
 Dashboard (React)                       Scramjet frame (same origin)
 ┌──────────────────────┐   bridge     ┌───────────────────────────────┐
 │ New job → Bot        │◄────────────►│ reddit page, rewritten        │
 │ Monitor  Data  …     │  (plugin     │ by Scramjet                   │
 └─────┬────────────────┘   hooks)     └──────────────┬────────────────┘
       │ records                                      │ requests
       ▼                                              ▼
 IndexedDB ── export Web Worker ── files      service worker → controller → epoxy-tls
                                              → wss://<MetaCode>/wisp/ → reddit.com only
                                                (or POST /api/scraper/fetch, the HTTP relay,
                                                 when the WebSocket can't open)
```

| Part | Files | Role |
|---|---|---|
| Dashboard | `src/ui/*` | Overview, New job, Monitor, Data, Settings, and the browser panel |
| Scramjet browser layer | `src/browser/scramjet.ts` | Starts Scramjet, owns the frame, navigates, implements the bot's `PageDriver` |
| Bot | `src/bot/bot.ts`, `driver.ts`, `validate.ts` | Runs jobs: navigation, scrolling, pagination, comments, limits, retries, pause/stop, events |
| Extraction | `src/extract/selectors.ts`, `parse.ts`, `detect.ts`, `normalize.ts` | Selectors (one file), DOM → raw values, page classification, validation into records |
| Data pipeline | `src/store/db.ts`, `src/export/*` | IndexedDB (dedupe, merge, query, retention), exports in a Web Worker |

**Scramjet integration (verified against the installed source).** MetaCode pins
`@mercuryworkshop/scramjet` **2.0.67-alpha.2**, the newest release, published under npm's
`alpha` tag. That is the line developed in the repository's `packages/core`. It pairs with
`@mercuryworkshop/scramjet-controller` **0.0.14** (`packages/controller`),
`epoxy-transport` 3.0.1 and `wisp-js` 0.5.0. npm's `latest` tag still points to 1.1.0, whose
API (`ScramjetController`, bare-mux) is different and isn't used here. The MetaCode server serves:

- `/scramjet-sw.js`: a service worker (scope `/`) that routes only Scramjet's prefix to the
  controller (`$scramjetController.shouldRoute` / `route`).
- `/scramjet/scramjet.js`, `scramjet.wasm`: the rewriter.
- `/scramjet/controller.api.js`, `controller.inject.js`, `controller.sw.js`: the controller
  in the tab, its script injected into pages, and its service-worker part.
- `/scramjet/epoxy-transport.js`: TLS in WebAssembly over MetaCode's Wisp endpoint `/wisp/`,
  which only opens connections to Reddit's hosts.

The app sets `$scramjetController.config` (prefix `/scramjet/~/`, file paths), creates a
`Controller({ serviceworker, transport })`, awaits `controller.wait()`, and calls
`controller.createFrame(iframe, { plugins: [bridge] })` and `frame.go(url)`.

**Connection to Reddit.** Normally epoxy-tls reaches Reddit through MetaCode's Wisp WebSocket
(`/wisp/`), with TLS from the browser to Reddit. At start-up the collector checks that the
WebSocket opens. If it doesn't, usually because a reverse proxy doesn't forward WebSockets,
**Automatic** (Settings → Connection to Reddit) switches to MetaCode's **HTTP relay**
(`src/browser/http-transport.ts`). The relay is `POST /api/scraper/fetch`: the server fetches
GET/HEAD requests for the allowed Reddit hosts and ports and streams the answers back. TLS then
ends on the MetaCode server, and the relay carries no WebSockets. The line under the browser
says which connection is in use and why. **Wisp only** shows the error instead of falling back.

epoxy-tls reuses kept-alive connections, but it doesn't notice when the server closes one
during a pause of about 2 s or more. The next request on it never gets an answer. So after a
pause of a second with nothing in flight, requests go through a fresh epoxy client
(`src/browser/fresh-after-idle.ts`), while requests within a page load still share connections.

**The bridge.** A normal page can't script a cross-origin iframe. Scramjet, however, serves
each proxied page from the app's own origin (under its prefix), so the page in the frame is
same-origin with the dashboard. The bridge is a Scramjet controller plugin: a `ManagedPlugin`
subclass, the extension point the controller provides (`frame.hooks`). It taps:

- `frame.hooks.init.post`: Scramjet's inject script calls this every time a page initialises
  in the frame, passing that page's `window` and its real URL (`client.url`). The bot reads
  that window's `document` with ordinary DOM calls. No script is injected into Reddit's page,
  and no browser security boundary is crossed.
- `frame.hooks.error.request`: called when a proxied request fails. For a page load the
  bridge answers with a small error page (marked `<meta name="collector-proxy-error">`), so the
  frame stays usable and the bot sees a retryable failure instead of a broken frame.

Reading the page's DOM from the dashboard was tried out first, through real Scramjet in
Chromium, and is covered by the end-to-end tests.

**The bot, step by step.** For each subreddit (or the search):

1. **robots.txt.** Before anything else, read the live robots.txt through the same Scramjet
   transport and apply the policy (see [below](#robotstxt-and-reddits-rules)).
2. **Open the listing.** Wait for the page to show content, or something definite: a block
   page, CAPTCHA, login wall, age check, private or missing community, or an empty result.
3. **Read the posts.** Read every post shown, skipping ones already seen in this job and
   promoted posts. Apply the date range, normalise and validate each post, and save the batch.
4. **Get more posts.** On www.reddit.com, scroll to the end and wait for more posts to appear:
   Reddit's own infinite-scroll code loads them. A feed that doesn't grow after two scrolls is
   finished. On old.reddit.com, follow the **next** link. Stop at the post limit, the page /
   scroll limit, the run-time limit, or, with sort *New* and a start date, once posts are
   older than the range.
5. **Comments.** For the comments modes, open each post's page and save its full text and up
   to *N* comments. The tree is kept: parent ids and depth. The page is scrolled to load more
   comments, within the limits.

Pages load **one at a time**, with a delay between page loads (3 s by default, at least 1 s
and never below the server's minimum). Failed page loads are retried with exponential backoff
(2 s, 4 s, 8 s… capped at 30 s; 3 retries by default). Every step checks for pause, stop
(`AbortController`) and the run-time limit. Records are saved as they're read, so a failed or
stopped job keeps what it collected.

**Selectors** live in `src/extract/selectors.ts`. There's a list per item, tried in order, for
the www.reddit.com markup (`<shreddit-post>` and `<shreddit-comment>` attributes) and the
old.reddit.com markup (`.thing[data-fullname]`). A generic fallback reads any link to a post's
comments page when neither markup is recognised. When Reddit changes its pages, update that
file and the fixtures in `test/fixtures/`.

## Using it

1. **Settings.** Choose the Reddit address (www.reddit.com or old.reddit.com) and the pacing.
   The defaults are polite.
2. **New job.** Enter subreddits (up to 10) or a search, optionally restricted to one
   subreddit. Choose the sort and what to collect:
   - *Posts*: listing data only, fast.
   - *Comments*: opens each post.
   - *Posts and comments*: full post details plus comments.

   Set the limits (posts, comments per post, pages or scroll steps, run time) and an optional
   creation-date range. Mistakes are explained before the job can start, and warnings say
   what to expect, such as estimated time or a date range with a non-*New* sort.
3. **Monitor.** Shows the current page and operation, counts (saved, skipped, pages, errors,
   retries) and the log, with **Pause**, **Resume** and **Stop**. How many posts exist isn't
   known in advance, so the bars show progress toward *your limits*, never a made-up
   completion percentage. The browser panel shows what the bot sees.
4. **Data.** Search titles, text, subreddits and usernames, and filter by subreddit, job,
   collection date and type. Sort by collection time, creation time, score or subreddit. Click
   a row to see the record, a post's collected comment thread, and an **Open on Reddit** link.
   Delete selected or all matching records. Inside MetaCode, **Add these N to project** sends
   the records shown to the project.
5. **Export.** Export everything, or only the records the current filter shows, as JSON, JSON
   Lines or CSV.

Between jobs you can browse public Reddit pages in the browser panel. While a job runs, the
panel is the bot's, and manual navigation is off. Only one job runs at a time.

## robots.txt and Reddit's rules

The collector only reads pages any logged-out visitor can see. It doesn't log in, and it
blocks Reddit's login, account, message and moderation pages. It never solves or bypasses
CAPTCHAs, block pages, age checks, quarantine opt-ins or rate limits: when Reddit shows one,
that part of the job stops (for blocks, CAPTCHAs and rate limits, the whole job stops), and
the reason is shown and stored.

Before every job the bot reads `<Reddit address>/robots.txt` (RFC 9309: longest match wins,
`*`/`$` wildcards, the `*` group unless one names `metacode-reddit-collector`). What happens
next depends on what it finds:

- **Disallowed**: under the default **Obey** policy, the job doesn't open any page and says
  which rule stopped it.
- **Unreadable** (network error or 5xx): treated as disallowed.
- **Missing** (4xx): no restrictions.

The decision is stored with the job.

When this collector was written, Reddit's robots.txt disallowed all automated access
(`User-agent: *` / `Disallow: /`), and Reddit's Public Content Policy pointed researchers to
its Data API. So with **Obey**, jobs on reddit.com don't run unless that has changed. That's
the intended behaviour, not a bug. The other policy, **Warn and continue**
(Settings → robots.txt), records the decision and runs the job anyway. It exists only for
collection Reddit has permitted, for example under its research program, or for your own
content. For API-based collection, MetaCode's **Reddit API scraper** (linked at the top of the
Scraper page) supports Reddit's Data API with credentials.

## Configuration

**In the app (Settings, saved in IndexedDB):**

| Setting | Default | Range |
|---|---|---|
| Reddit address | `https://www.reddit.com` | www/old.reddit.com, or a mirror the server allows |
| Delay between page loads | 3000 ms | 1000–60000 ms, never below the server's minimum |
| Wait after each scroll | 1500 ms | 500–30000 ms |
| Page load timeout | 30000 ms | 5000–120000 ms |
| Retries per page | 3 | 0–6 |
| robots.txt policy | Obey | Obey / Warn and continue |
| Connection to Reddit | Automatic | Automatic (Wisp, else the HTTP relay) / Wisp only / HTTP relay only. Read when the browser starts: reload after changing it. |
| Default limits for new jobs | 50 posts, 50 comments | 1–1000 / 0–500 |
| Retention | 0 (keep) | records not seen for N days are deleted at start-up or on demand |
| Export format, CSV byte-order mark | JSON, on | |

Job limits: up to 10 subreddits, 1–1000 posts, 0–500 comments per post, 1–100 pages or scroll
steps, and 1–240 minutes.

**MetaCode server (`.env` in the MetaCode folder, see its `.env.example`):** the collector
uses the same settings as MetaCode's Reddit browser.

- `SCRAPER_BROWSER_ENABLED=false` turns Scramjet off (the collector then says so).
- `PORT` sets the server port.
- `PUBLIC_URL` (behind a reverse proxy) is the site's address, e.g. `https://metac0.de`. WebSockets
  to `/wisp/` from pages on it are accepted even when the proxy doesn't pass the original host name.
- `REDDIT_BASE_URL` (testing) adds a mirror host the proxy may reach. With it,
  `SCRAPER_ALLOW_PRIVATE_NETWORK=true` lets the proxy reach a local mock; use that only for tests.

**Development (`collector/.env`, see `.env.example`):** `METACODE_URL`, the MetaCode server the
Vite dev server proxies to. No secrets are needed or stored anywhere.

## Data, storage and exports

Posts and comments are separate collections in this browser's IndexedDB, keyed by Reddit's
ids. A record seen again is merged:

- Newer values win.
- A missing value never erases one collected earlier.
- Full post text isn't replaced by a listing preview.
- The jobs that saw it are kept.

Jobs and collection errors are stored too. Missing values are `null`, distinct from real
zeros; rounded displays like "1.2k" are flagged (`counts_approximate`). The schema, the JSON
document layout and the CSV column order are in **[SCHEMA.md](SCHEMA.md)**.

Exports run in a Web Worker that streams records from IndexedDB with cursors, so large
exports don't freeze the page. CSV writes `posts.csv` and `comments.csv` with every schema
field as a column. Arrays are joined with `;`, cells are quoted as needed, and spreadsheet
formulas are neutralised. Files are UTF-8.

Settings → Storage shows usage and offers:

- **Apply retention now**.
- **Delete all collected data**. Settings are kept.
- **Clear Reddit browsing data**. This removes cookies Reddit set inside the Scramjet frame,
  which Scramjet's controller keeps in its own IndexedDB database `__scramjet_controller`.

The collector itself never stores passwords, cookies or tokens.

## Security

- **Navigation.** Only Reddit hosts (and a mirror the server explicitly allows) can be opened,
  by the bot or by hand, and private pages are blocked. MetaCode's Wisp endpoint enforces the
  host allow-list on the server, so the collector isn't a general-purpose proxy.
- **Scraped content.** It's only ever rendered as text (React escaping). The parser drops
  scripts and markup, and Reddit's page scripts are never run by the collector.
- **Links.** Outside links from scraped data must be http(s), open with
  `rel="noopener noreferrer nofollow"` and show their domain. "Open on Reddit" links only go
  to reddit.com.
- **No code execution.** There are no user-supplied scripts and no JavaScript evaluation
  controls in the dashboard. Job definitions are validated and bounded before they run.
- **No secrets.** Nothing secret is needed: the collector uses no API keys or credentials.
- **HTTP relay.** `/api/scraper/fetch` only reads (GET/HEAD) from the same Reddit host and port
  allow-list as Wisp. It refuses IP addresses, URLs with credentials and addresses that resolve
  to private networks. It answers only pages of MetaCode's own site (`Sec-Fetch-Site`/`Origin`)
  and limits size, time and concurrency.
- **Add to project.** The collector frame talks to MetaCode with `postMessage`, same origin
  only. MetaCode accepts messages only from its own frame and copies known fields with checked
  types. Ids must look like Reddit ids, and links must point to reddit.com.

## Tests

| Covered | Where | Live Reddit? |
|---|---|---|
| Post/comment parsing (www and old Reddit), missing and malformed fields, selector fallbacks, text extraction | `test/parse.test.ts` (fixtures in `test/fixtures/`) | no: fixtures modelled on Reddit's markup |
| Page classification (block page, CAPTCHA, login, age gate, private, not found, empty, proxy error), dates, normalisation, merging | `test/detect-normalize.test.ts` | no |
| URL rules, robots.txt, retry/backoff, cancellation, pause, settings and job validation, error messages | `test/lib.test.ts` | no |
| IndexedDB (dedupe, merge, query, delete, retention, interrupted jobs) and JSON/JSONL/CSV exports | `test/store-export.test.ts` (fake-indexeddb) | no |
| Bot: infinite scroll, pagination, limits, dedupe, comments, retries, refusals, robots policy, pause/resume/stop, run-time limit, events | `test/bot.test.ts` (fake page driver) | no |
| **End to end through real Scramjet** in Chromium: service worker, rewriter, Wisp proxy, the plugin bridge, a page's own infinite-scroll script, post pages, IndexedDB, Data view, exports, robots policy, block page, dropped-connection retries, pause/resume/stop, navigation rules, "Scramjet unavailable" state, a blocked WebSocket (HTTP relay fallback, "Wisp only"), a server closing idle connections between pages, and MetaCode's Scraper page with **Add to project** | `../test/collector.test.js` (stand-in Reddit: `../test/helpers/collector-mock.js`) | no: local stand-in |
| MetaCode posts from records, fresh connections after a pause | `test/metacode.test.ts`, `test/fresh-after-idle.test.ts` | no |
| Wisp origin check behind proxies, the HTTP relay's limits | `../test/wisp-relay.test.js` | no |

**Manual live check.** `npm run collector:live-check -- --subreddit=science --posts=3`
(options `--base=https://old.reddit.com`, `--robots=warn`, `--headed`). It starts MetaCode,
runs one small job on live Reddit through Scramjet, and passes only if at least one real post
is collected, shown in the Data view, and present in a JSON export. Exit codes:

| Code | Meaning |
|---|---|
| 0 | Passed |
| 1 | Failed |
| 2 | Stopped by robots.txt |
| 3 | Reddit refused or couldn't be reached |

With the default policy, expect 2 as long as Reddit's robots.txt disallows everything.

The fixtures were written from Reddit's documented and observed markup. They were *not*
captured from live pages, because live Reddit couldn't be reached from the environment where
this was built. If the live check finds markup the selectors don't read, update
`selectors.ts` and add a fixture.

## Troubleshooting

**"Wisp WebSocket failed to connect: websocket did not open" / "The WebSocket to MetaCode's proxy (/wisp/) didn't open"**
A reverse proxy or CDN in front of MetaCode isn't forwarding WebSockets. With Settings →
Connection to Reddit on **Automatic**, the collector uses the HTTP relay meanwhile. To fix the
proxy, see [docs/deploy-vps.md](../docs/deploy-vps.md#10-troubleshooting).

**"Open the collector from MetaCode's Scraper page to add records to a project"**
Add to project needs the MetaCode page around the collector: use sidebar → **Scraper**, not
`/collector/` on its own.

**"The MetaCode server couldn't be reached" / "Couldn't load /scramjet/…"**
Start MetaCode (`npm start`) and open the collector from it (`http://localhost:3000/collector/`),
or run `npm run collector:dev` with MetaCode running. Opening `dist/index.html` as a file
doesn't work.

**`/collector/` says "isn't built yet"**
Run `npm run collector:install && npm run collector:build`, then reload.

**"The Scramjet service worker couldn't be registered"**
Service workers need `http://localhost` or `https://`, and private windows or strict privacy
settings may block them. If an old service worker misbehaves after an update, open DevTools →
Application → Service Workers → *Unregister*, then reload.

**"The MetaCode server's Reddit browser is turned off"**
Remove `SCRAPER_BROWSER_ENABLED=false` from MetaCode's `.env` and restart it.

**"a secure connection couldn't be made because the site's certificate wasn't trusted"**
Something on your network (a corporate proxy, firewall or antivirus) intercepts HTTPS.
Scramjet's transport (epoxy-tls) verifies Reddit's real certificate end to end and doesn't use
your system's extra certificates, so it refuses intercepted connections. Use a network without
HTTPS interception.

**A job stops with "robots.txt disallows automated access…"**
That's the **Obey** policy working. See [robots.txt and Reddit's rules](#robotstxt-and-reddits-rules).

**"Reddit blocked this browser's requests" / "CAPTCHA" / "too many requests"**
Reddit is refusing this connection. The job stops, and the collector doesn't work around it.
Wait, raise the page delay, and reduce limits, or use Reddit's Data API.

**A job finds no posts / fields are empty**
Reddit may have changed its markup. Check the browser panel (does the page show posts?),
then update `src/extract/selectors.ts`. A post read only through the generic fallback has
just its id, title and subreddit, until its page is opened.

**Dev server: the frame never loads**
`npm run collector:dev` needs MetaCode running at `METACODE_URL`. The Wisp endpoint only
accepts WebSockets from its own origin; the dev proxy rewrites the Origin header for that.

## Limitations

- Live Reddit wasn't reachable where this was built (outbound TLS was intercepted). The
  Scramjet integration, the bridge, scrolling and comments are verified end to end against a
  local stand-in that follows Reddit's www markup. Old Reddit markup is verified with
  fixtures only.
- With the default **Obey** policy and Reddit's robots.txt as last seen, jobs on reddit.com
  don't run.
- Comments hidden behind "more replies" / "load more comments" buttons aren't expanded; the
  bot only scrolls. It collects what the post page shows, up to your limit.
- Reddit's markup changes over time. Selectors are isolated in one file, with fallbacks, but
  a large redesign needs an update.
- One job at a time, in one tab: the bot drives the browser panel. Closing or reloading the
  tab ends the job, and records saved until then are kept.
- Posts read only from a listing have whatever that listing shows. Use a comments mode, or
  the generic-fallback path, to open post pages for full details.
