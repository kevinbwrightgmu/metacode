# MetaCode architecture map (Phase Zero)

This is the discovery report written before the scraper reliability upgrade and
the Ultra AI Coding Lab. It records what existed, what worked, what was missing,
and the baseline test results. The changes made afterwards are described in
[scraper-network.md](scraper-network.md), [ai-lab.md](ai-lab.md) and the final
report ([implementation-report.md](implementation-report.md)).

## 1. Technology inventory

| Area | What is actually there | Files | Role |
|---|---|---|---|
| Runtime | Node.js 22 (22.22.0 here), npm with `package-lock.json` | `package.json` | One server process |
| Backend | Express 4.22 | `server.js` (≈2,300 lines), `scraper/`, `surveys/`, `accounts/`, `projects/` | HTTP API, static files, Wisp WebSocket |
| Frontend (main app) | Vanilla JS, hash router, no build step | `public/app.html`, `public/js/app.js` (`const App`), one file per view | Research workspace |
| Frontend (Survey Studio) | Vanilla JS, separate page | `public/studio.html`, `public/js/survey/*` | Survey editor |
| Frontend (AI Scraper, beta) | TypeScript 5.9 + React 19 + Vite 7, built to `collector/dist`, served at `/collector/` | `collector/src/**` | AI Scraper UI |
| Design system | CSS custom properties in `public/css/main.css` (`--bg`, `--surface`, `--accent`, …), Space Grotesk / Inter / JetBrains Mono | `public/css/*.css` | Shared look |
| Database | **No SQL database on the server.** JSON-file stores with atomic temp-file + rename writes: `survey-data/`, `project-data/`, `account-data/usage.json`. Supabase Postgres holds only the signed-in user's synced workspace (`metacode_data`, Row Level Security) | `surveys/store.js`, `projects/`, `accounts/usage.js`, `supabase/migrations/` | Persistence |
| ORM | None | — | — |
| Authentication | Supabase Auth (PKCE) in the browser; the server verifies the access token with `GET /auth/v1/user` (60 s cache). Without Supabase settings, accounts are off and a browser cookie id (`owner.js`) scopes data | `accounts/auth.js`, `owner.js`, `public/js/account.js` | Identity |
| Billing | Stripe (REST through undici), signed webhooks | `accounts/billing.js`, `accounts/check-billing.js` | Plans |
| Ultra entitlement | `public/js/plans.js` (shared by server and pages): plan → features + limits. The plan comes from Stripe subscriptions or `ACCOUNT_PLAN_OVERRIDES` | `public/js/plans.js`, `accounts/index.js` | Authorization |
| Scraper | In-process job manager, Reddit HTTP client (destination allow-list, robots.txt, rate limiter, retries), transports: Python stdlib worker, epoxy-tls over Wisp, RedditAPIs.com client, browser relay | `scraper/**`, `python/reddit_fetch.py` | Data collection |
| Queue / workers | No queue technology. Jobs live in server memory (`JobManager`), at most `SCRAPER_MAX_CONCURRENT_JOBS` run at once; lost on restart | `scraper/jobs/job-manager.js` | Background work |
| Code sandbox | QuickJS (WASM) and Pyodide (WASM) in a child process started with Node's permission model, globals stripped, memory and time limits | `scraper/sandbox/*` | Custom scraper code |
| AI | "EMIS", an OpenAI-compatible gateway: several keys with rotation, quota tracking, model fallback, streaming relay; model list from `emis-models.json` (the service's `/cli/opencode.json`: its models with tool calling) or `GET /v1/models`; optional Python transport | `server.js` (`/api/ai`, `/api/ai/batch`, `/api/models`), `emis-python.js`, `emis-models.json` | AI coding, assistant, AI Scraper |
| Storage services | Local disk only | — | — |
| Logging / monitoring | `console.*` with `[area]` prefixes (pm2 logs), secret redaction helpers (`redact`, `sanitize`), status page with health checks | `status-page.js`, `server.js` | Operations |
| Tests | `node --test` (unit, integration with mock servers, Playwright end-to-end with Chromium), Vitest for the collector | `test/**`, `collector/test/**` | Verification |
| CI | None in the repository (no `.github/`) | — | — |
| Lint / type check | No linter. Type checking only for the collector (`tsc --noEmit`) | `collector/tsconfig*.json` | — |
| Deployment | One VPS: nginx → pm2 (`fork` mode, 1 instance) → `node server.js`; `.env` next to `server.js`; Python venv in `.venv` | `ecosystem.config.cjs`, `docs/deploy-vps.md` | Hosting |

## 2. Existing scraper audit (one job, start to finish)

1. **Start.** The Scraper page (`public/js/scraper.js`) or the AI Scraper (`collector/src/lib/ai-jobs.ts`) sends `POST /api/scraper/jobs` with `{ mode, engine, target | goal | code, options }`.
2. **Validation.** `parseSpec()` (`scraper/index.js`): mode, engine, `normalizeTarget()` (subreddit/user/post/search/listing, strict patterns), `normalizeOptions()` (clamped to server limits), code size/language checks, own-key validation.
3. **Authorization.** `sameOriginOnly` (CSRF), `policy.use` (sign-in + `scraper` feature) and `policy.job` (mode features, jobs at once, jobs per day, items per job and per month — the item cap is lowered to what the plan allows). Ownership: `ownerOf(req)` (account first, then the browser id).
4. **Source selection.** `engine`: `server` (Reddit Data API with OAuth keys, or public `.json` pages subject to robots.txt), `redditapis` (third-party RedditAPIs.com, pay-per-call), `browser` (an open MetaCode tab relays the requests).
5. **Outbound requests.** Always `RedditHttpClient.request()` (`scraper/network/reddit-http.js`): destination allow-list (Reddit hosts, allowed ports), robots.txt, the shared per-host `HostRateLimiter`, the transport (Python worker connects to the address it checked, rejects private addresses, verifies TLS, never follows redirects), manual redirect handling with re-checks.
6. **Pagination.** Reddit `after` cursors, max pages, max items, optional sweep through several sorts to get past the ~1,000-item listing limit (`scraper/reddit/standard-scraper.js`).
7. **Normalization.** `scraper/reddit/format.js` → flat records with `record_type`, ids, permalink, timestamps, scores.
8. **Duplicates.** `F.recordKey()` per record; a `Set` per job drops repeats (counted in `progress.duplicates`).
9. **Persistence.** None: records stay in memory for `SCRAPER_JOB_RETENTION_MINUTES` (120) and are gone after a restart. Users export (CSV/JSON/NDJSON) or add them to a project.
10. **Progress.** Counters on the job (`pagesFetched`, `requests`, `itemsFound`, `duplicates`, `errors`, `message`), pushed over server-sent events (coalesced to 4/s) or polled.
11. **Failures.** `ScraperError` types with user-facing messages (`scraper/errors.js`), raw transport errors classified and never shown verbatim; unexpected errors become `internal_error`.
12. **Retry / resume.** Request-level retries only (bounded: ≤ 5, exponential backoff with jitter, `Retry-After`, `X-Ratelimit-*`). A failed or cancelled job cannot be resumed; the user starts a new one.

**Problems found**

| Problem | Where | Severity |
|---|---|---|
| Jobs, progress and results are lost on restart (no persistence, no checkpoints, no resume) | `job-manager.js` | High (reliability) |
| No circuit breaker: when the network route to Reddit is down every job retries on its own and fails | `reddit-http.js` | Medium |
| Queue is unbounded server-wide (only per-plan "jobs at once" limits it, and only with accounts on) | `job-manager.js` | Medium (backpressure) |
| No network-provider abstraction: no way to route through an administrator-approved proxy or VPN gateway; no network health diagnostics | `scraper/index.js` | Medium |
| No pause/resume; no "waiting for permitted retry" state | `job-manager.js` | Medium |
| Request outcomes are counted, but not measured (latency, timeouts, 429s per route) | `reddit-http.js` | Low |
| `HostRateLimiter.pause()` honours `Retry-After` up to 5 min; good. Retries are bounded; good. No unbounded loops found | — | OK |
| Credentials: server keys only from `.env` (legacy files read-only); users' own keys are sent per job and never stored | `credentials.js` | OK |
| Public `.json` pages are not Reddit's documented Data API; RedditAPIs.com is a third-party service whose terms the operator must check. The documented route is the OAuth Data API, which is supported | `config.js` | Documented, not changed (would change the live product's default) |

## 3. Subscription audit (Ultra, billing source → authorization decision)

| Question | Finding |
|---|---|
| Where is subscription state stored? | Not stored. Stripe is the source of truth: `billing.planFor()` lists the customer's subscriptions; the answer is cached in memory for 5 minutes per user. The account ↔ customer link is in `account-data/usage.json` |
| How do billing events update it? | Signed webhooks (`/api/billing/webhook`, HMAC-SHA256, 300 s tolerance) drop the cached plan; the next request re-reads Stripe. Duplicate and out-of-order events are therefore harmless (idempotent) |
| Renewals | Subscription stays `active`; nothing to do |
| Failed payments / grace | `past_due` counts as entitled (Stripe's retry period); `unpaid`, `canceled`, `incomplete_expired` do not |
| Cancellation at period end | Status stays `active` until the period ends, so access continues through the paid period (Stripe semantics) |
| Immediate revocation / expiry / refund that cancels | Status becomes `canceled` → not entitled; a webhook makes it immediate, otherwise within 5 minutes |
| Stripe outage | The last answer is kept 60 s longer; with no cached answer the feature check answers 503 `account_unavailable` (fails closed, never upgrades) |
| Can the client influence its plan? | No. The browser's view (`GET /api/account/me`) is display only; every protected route calls `contextOf()` on the server |
| Server-side enforcement today | AI (`aiSingle`, `aiBatch`), scraper (`policy.use`/`policy.job`, Wisp upgrade), surveys (`surveysPolicy`), network analysis (`feature('network')`) |
| Administrators | No role existed; plan overrides (`ACCOUNT_PLAN_OVERRIDES`) are the only privileged configuration |

Decision: the AI Lab uses the same path — `contextOf()` → `needUser()` → `needFeature('aiLab')` — with a new `aiLab` feature that only the Ultra plan has in `plans.js`. No second subscription mechanism.

## 4. AI integration audit

- One provider: EMIS (OpenAI-compatible; its documented endpoints are `GET /v1/models` and `POST /v1/chat/completions`, streaming or not), several keys, quota headers (a budget of prompts and/or tokens per day, week or month; 429 until it rolls over), per-model rate-limit resting, similar-model fallback, streaming relay, empty-answer retry. No embeddings and no fine-tuning are offered by it; images and videos are made inside a chat completion, and MetaCode uses only the text of answers.
- Model metadata: id, name, `tool_call`, `reasoning`, `attachment` from `emis-models.json`. No context-window or pricing data.
- The AI Scraper gets a narrow interface (`scraperAi.chat()`), which is the pattern the AI Lab follows.
- Usage limits: AI requests and posts per plan (`accounts/usage.js`, synchronous reservations, so concurrent requests can't overshoot).

## 5. Mullvad VPN app review (reference only)

Reviewed at commit `e522e99` (shallow clone, read only).

- **What it is:** a Rust system service (`mullvad-daemon`, `talpid-core`) plus Electron GUI (`desktop/`) and CLI (`mullvad-cli`), talking over gRPC on a Unix socket (`mullvad-management-interface`). The tunnel state machine (`talpid-core/src/tunnel_state_machine/`) moves Disconnected → Connecting → Connected → Disconnecting, with an Error state that *blocks all traffic* rather than leaking it.
- **Platforms:** Linux desktop distributions (Ubuntu LTS, Debian 12+, Fedora), Windows, macOS, Android, iOS. It is tested with a desktop environment, not as a headless server component.
- **Privileges:** root. It rewrites the host firewall (nftables on Linux), routing tables and DNS. On a VPS that also serves the website, its default policy ("all network packets should be blocked" except the tunnel) would affect the web server's own traffic; split tunnelling on Linux uses cgroups (`mullvad-exclude`).
- **Monitoring:** `mullvad status` / the gRPC management interface, local only.
- **License:** GPL-3.0. Copying or translating its code into MetaCode would bring GPL obligations; talking to a separately run component over a network protocol does not.
- **Patterns worth adopting:** an explicit connection state machine; failing closed when the tunnel is down; exponential backoff with jitter and a maximum delay (`talpid-future/src/retry.rs`).
- **Pattern deliberately not adopted:** `mullvad-api`'s access-method *rotation* (try the next method when one fails). Mullvad uses it to reach its own API under censorship; applied to Reddit it would be rotating routes until a request succeeds, which this project must not do.
- **Conclusion:** do not run the Mullvad app inside the MetaCode process or on the web host. If an operator needs a VPN route, run it as a **separately managed gateway** (its own host, VM or container network namespace) that exposes an HTTP proxy, and point MetaCode's `vpn-gateway` network provider at it. Whether a VPN service's terms allow automated collection is for the operator to check. A VPN changes the route and IP address; it does not make Reddit accept requests.

## 6. Baseline verification (before any change)

| Check | Command | Result |
|---|---|---|
| Unit + integration + end-to-end | `npm test` | **247 / 247 passed**, 0 failed, 0 skipped (167 s) |
| Collector type check | `npm --prefix collector run typecheck` (part of build) | Passed |
| Collector build | `npm --prefix collector run build` | Passed |
| Collector tests | `npx vitest run` in `collector/` | **27 / 27 passed** |
| Linter | — | None configured |
| Server type check | — | None configured (JavaScript) |
| Database migrations | — | One Supabase SQL migration, applied by the operator in the Supabase dashboard; no migration runner in the repo |
| Known flaky test | a scraper timing assertion (`276 ms` vs `≥ 280 ms`) failed once earlier in this project and passed 3/3 alone | Pre-existing |

## 7. Prioritized plan

1. Shared foundations: an explicit administrator policy (`ADMIN_EMAILS`), the `aiLab` entitlement, structured logging with redaction, a type check for the new server modules (JSDoc + `tsc --checkJs`).
2. Scraper reliability: network providers + circuit breaker + request metrics; durable jobs with a state machine, leases, checkpoints, restart recovery, pause/resume, backpressure; admin diagnostics.
3. Scraper interface: real progress, waiting/paused states, retry counts, checkpoint, network status, pause/resume.
4. AI Lab: entitlement policy, page at `/ultra/ai-lab`, projects, provider registry, workbench with streaming, coding profiles with versions, knowledge base with keyword retrieval, datasets with versions and checks, evaluations with comparisons and regressions, prompt-optimization workflow, usage visibility.
5. Fine-tuning only through a provider that actually offers it, operator-enabled, tested against a mock.
6. Hardening, documentation, final report.

Storage decision: the new modules keep the existing convention (atomic JSON / NDJSON files on the server's disk, one process). A database server would be a new piece of infrastructure the current deployment doesn't have; the stores are written behind small interfaces so they can move to SQLite or Postgres later.
