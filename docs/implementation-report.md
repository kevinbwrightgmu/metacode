# Implementation report: scraper reliability and the Ultra AI Coding Lab

This covers two pieces of work on branch `claude/reddit-scraper-integration-duqgpd`:
- commit `b55672f` — scraper reliability;
- commit `35f2b0c` — AI Coding Lab.

Each statement below is backed by code in the repository and by the tests in
section G. Where something was only tested against local mocks, or not done,
the report says so.

---

## A. Architecture discovered

The full Phase Zero report is [docs/architecture-map.md](architecture-map.md).
In short:

- **Server.** One Node.js 22 / Express 4 process under pm2 (fork mode, one
  instance), behind nginx on one VPS. There is no build step for the main app.
- **Front end.**
  - The main app is vanilla JavaScript (`public/app.html`, `public/js/app.js`)
    with a hash router.
  - Survey Studio is its own page.
  - The AI Scraper (beta) is a TypeScript + React + Vite app served at
    `/collector/`.
- **Persistence.** There is no SQL database on the server. Persistence is
  JSON-file stores with atomic writes (`survey-data/`, `project-data/`,
  `account-data/`). Supabase Postgres holds only each signed-in user's synced
  workspace, protected by Row Level Security.
- **Identity and plans.**
  - Supabase Auth, verified by the server on every request.
  - Plans come from Stripe subscriptions, or the operator's
    `ACCOUNT_PLAN_OVERRIDES`, through the shared `public/js/plans.js`. Signed
    webhooks invalidate a 5-minute cache.
  - The browser's view of the plan is display only.
- **AI.** "EMIS", an OpenAI-compatible gateway with key rotation, quotas,
  fallback and streaming.
- **Scraper, before this work.**
  - Jobs lived only in memory: they were lost on restart, with no checkpoints
    or resume.
  - There was no circuit breaker, no network-provider abstraction, and no
    pause/resume or "waiting" state.
  - The queue was unbounded server-wide.
  - Retries and `Retry-After` handling were already bounded and correct.
- **Ultra.** It existed as a plan with higher limits, but had no Ultra-only
  product.
- **Mullvad VPN app.** Reviewed for reference only. It is a Rust daemon that
  needs root and nftables, and is GPL-3.0. Its "access method" rotation exists
  to evade blocking, and was deliberately not adopted. A VPN can only be used as
  a separately managed gateway that MetaCode reaches as an HTTPS proxy.
- **Baseline, before any change.**
  - `npm test`: 247/247.
  - Collector tests: 27/27.
  - No linter, no server type checking, no CI.

## B. Implementation summary

### Scraper reliability (`b55672f`)

- **Network providers** (`scraper/network/providers.js`, `network-manager.js`):
  - Kinds:
    - direct — the existing Python / epoxy transports;
    - an administrator-configured HTTPS proxy;
    - a "VPN gateway", which is an HTTPS proxy run by a separately managed
      VPN container.
  - Proxy credentials are never shown in status output.
  - SOCKS is reported as unsupported rather than half-implemented.
  - Configuration comes only from the server's environment. Users can't supply
    network settings.
- **Request handling.** Every request gets:
  - a request id;
  - a timeout and a response-size cap;
  - outcome classification: ok, http_4xx, http_429, http_5xx, timeout,
    network, tls, proxy;
  - metrics: counts and latency p50/p95.
- **Circuit breaker** (`circuit-breaker.js`): closed / open / half-open, per
  provider.
  - Only timeouts, network, TLS, proxy and 5xx failures open it. An access
    denial (4xx) never does.
  - Failing over to another provider is off by default
    (`SCRAPER_NETWORK_FAILOVER=on`). It happens only while a circuit is open,
    and only through the administrator's listed providers (at most 3). It is
    never a way around a refusal.
- **Durable jobs** (`scraper/jobs/job-store.js`, `job-manager.js`):
  - **Storage and states.**
    - Saved under `scraper-data/`: atomic `job.json`, fsync'd `records.ndjson`
      and `events.ndjson`, and a lease file.
    - An explicit state machine:
      queued → running → waiting / paused / completed / failed / cancelled.
  - **Checkpoints and collection.**
    - Checkpoints are written after the records they cover.
    - Incremental "collect newer" (`since`) with early stop and deduplication.
  - **Waits and backpressure.**
    - Bounded waits on rate limits and outages (6 waits, up to 30 minutes),
      then the job pauses.
    - Backpressure: 20 queued jobs at most; disk budget 2 GB; paused jobs kept
      24 hours.
  - **Recovery after a restart.**
    - Jobs on server keys continue.
    - Jobs on a user's own keys, or fetched through their browser, pause until
      that person resumes them.
    - Custom-code and AI jobs end with their records kept.
- **API and UI.**
  - Pause, resume, a summary, history, configuration changes (PATCH), paged
    job lists, `Retry-After` on refusals, network status, and admin network
    diagnostics.
  - The scraper page shows real progress, waiting/paused banners, and
    Pause / Resume / Summary / Collect newer controls. Network notices appear
    in the collector.
- **Shared foundations.**
  - `lib/log.js`: structured logs with secret redaction.
  - An administrator role (`ADMIN_EMAILS`), which grants no plan and no data.
  - The `aiLab` feature and Lab meters in `plans.js`.
  - `npm run typecheck` over `// @ts-check` server modules, with types in
    `types/`.

### AI Coding Lab (`35f2b0c`) — full description in [docs/ai-lab.md](ai-lab.md)

- **Entitlement** (`ai-lab/policy.js`): a server-side decision on every route,
  stream, download and background run, from the billing system.
  - Being an administrator opens nothing.
  - With accounts off, the Lab is closed unless the operator opts in.
- **Projects and Knowledge Base.**
  - Background ingestion and chunking.
  - Credential files are refused by name; binary content is refused.
  - Secrets are redacted before storage, and prompt-injection text is flagged.
  - BM25 keyword retrieval, scoped to one project. Passages are sent as
    untrusted `<reference>` data.
- **Coding Profiles.**
  - Structured fields; every change is a version.
  - Compare, restore, duplicate, rename, archive, import/export (JSON) and
    export of the rendered instructions.
  - Candidate versions must be accepted or rejected by the user.
- **AI Workbench.**
  - Streamed answers (SSE). Stop cancels the model request, and the partial
    answer is kept and marked.
  - Regenerate, task types, and summaries of older messages.
  - A per-answer report of what was sent.
  - Markdown rendering of untrusted output; copy; export (Markdown/JSON).
  - Line diffs against your own file, computed in the browser.
- **Training Studio.**
  - Datasets with a draft and frozen, hashed versions.
  - JSONL/JSON/CSV import with per-row problems and duplicate skipping.
  - Exports, including chat-format JSONL.
  - Quality reports, deterministic splits, and version comparison.
- **Evaluations.**
  - Suites pinned to a dataset version.
  - Deterministic checks. `syntax` only parses; nothing is executed.
    `unit_tests` is always skipped.
  - AI-graded rubric checks, labelled with the grading model and method
    version.
  - Background runs with real progress; resumable after cancel, failure or
    restart.
  - Metric definitions are shown in the UI.
  - Comparisons are refused across different task sets. They warn about
    confounders, and list regressions and improvements with both answers.
- **Prompt optimisation.** "Suggest an improvement" creates a candidate profile
  version from a run's failures. It is never accepted automatically.
- **Fine-tuning** (`ai-lab/finetune.js`).
  - Only through an operator-enabled, OpenAI-compatible provider, and only
    after the user confirms the cost.
  - The data must pass quality gates.
  - Statuses and events come from the provider's own API. Nothing is
    simulated.
- **Usage.**
  - Lab meters: model calls per day, tokens per month, evaluation runs, and
    fine-tunes. They use reserve-then-settle, and give back failed calls.
  - Per-account storage quota and an API rate ceiling.
  - Export everything; delete everything.
- **Isolation.** Structural: each account has its own folder, keyed by a
  one-way hash.
- **Operational metrics.** Administrators can see counts and timings only,
  never content.
- **Navigation.** The app's sidebar has an "AI Coding Lab" link. For non-Ultra
  users it carries an "Ultra" lock badge.

## C. File-level changes

### Scraper reliability (`b55672f`, 38 files)

| Change | Files |
|---|---|
| New | `scraper/network/providers.js`, `network-manager.js`, `circuit-breaker.js`, `metrics.js`; `scraper/jobs/job-store.js`; `lib/log.js`; `types/scraper.d.ts`; `tsconfig.json`; `docs/architecture-map.md`; `docs/scraper-network.md`; `test/scraper-durable.test.js` |
| Rewritten | `scraper/jobs/job-manager.js` (state machine, persistence, leases, waits, recovery) |
| Changed | `scraper/index.js` (routes, network status, recovery); `scraper/config.js`; `scraper/reddit/standard-scraper.js` (checkpoints, `since`); `scraper/reddit/targets.js`; `scraper/network/reddit-http.js`; `accounts/config.js`, `accounts/index.js` (admin role, resume policy); `public/js/plans.js` (aiLab feature, Lab limits and meters); `public/js/account.js`; `public/js/scraper.js` + `public/css/main.css` (controls, banners, network panel); `collector/src/lib/{ai-jobs,settings}.ts`, `collector/src/ui/App.tsx`; `server.js` (admin guard); `.env.example`, `.gitignore`, `README.md`, `docs/reddit-scraper.md`; `package.json` / `package-lock.json` (dev deps, `typecheck`) |
| Tests changed | `test/api.test.js`, `test/e2e.test.js`, `test/jobs.test.js`, `test/helpers/harness.js`, `collector/test/ai.test.ts` |

### AI Coding Lab (`35f2b0c`, 39 files)

| Change | Files |
|---|---|
| New server | `ai-lab/{index,policy,store,config,errors,providers,pricing,usage,profiles,knowledge,context,checks,datasets,evals,optimize,finetune}.js`; `types/ai-lab.d.ts`; `types/shims.d.ts` |
| New pages | `public/ai-lab.html`; `public/css/ai-lab.css`; `public/js/ai-lab/{lab-core,lab-markdown,lab-views,lab-workbench,lab-training,lab-evals}.js` |
| Changed | `server.js` (the Lab's AI adapter for the existing AI service, `/api/lab` mount, `/ultra/ai-lab` page, start/shutdown); `accounts/usage.js` (`add()` for settling tokens over the estimate); `accounts/http.js` (exports `dispatcherFor`); `public/app.html` (sidebar link) |
| Tests | New `test/ai-lab.test.js`, `test/ai-lab-e2e.test.js`, `test/helpers/lab-mocks.js`; `test/accounts-e2e.test.js` (+1 assertion: the Lab's Ultra lock) |
| Docs | New `docs/ai-lab.md`, this report; `.env.example` (Lab settings), `README.md`, `docs/accounts.md`, `docs/deploy-vps.md` |

No EMIS code, data or behaviour was removed or changed. The Lab calls the
existing AI service through its own adapter in `server.js`.

## D. Database changes

- **No SQL schema changes and no migrations.** The Supabase table
  `metacode_data` and its policies are unchanged.
- **New on-disk stores**, both git-ignored and created on first use:
  - `scraper-data/jobs/<job id>/`: `job.json`, `records.ndjson`,
    `events.ndjson`, `lease`. Setting: `SCRAPER_DATA_DIR`.
    `SCRAPER_PERSIST_JOBS=false` returns to in-memory jobs.
  - `lab-data/users/<key>/…`: per-account JSON objects, frozen dataset
    versions, run results and an audit log. Setting: `AI_LAB_DATA_DIR`.
- **Usage counters** (`account-data/usage.json`) gain the additive meters
  `labRequests`, `labTokens`, `labEvalRuns` and `labFineTunes`. Old files load
  unchanged.
- **Rollback:**
  - Deploy the previous commit. The new directories are ignored by older code
    and can be deleted.
  - Or keep the code and set `AI_LAB_ENABLED=false` and/or
    `SCRAPER_PERSIST_JOBS=false`.

Choosing JSON files over adding a database follows the existing architecture
and the single-process deployment. `ai-lab/store.js` and
`scraper/jobs/job-store.js` are the only modules to replace when moving to a
database.

## E. API changes

All changes are additive; no existing route changed its contract.

**Scraper** (`/api/scraper`), detailed in
[docs/scraper-network.md](scraper-network.md):

| Route | What it does |
|---|---|
| `POST /jobs/:id/pause` | Pause a job |
| `POST /jobs/:id/resume` | Resume a job (own keys are sent again; the plan is checked again) |
| `PATCH /jobs/:id` | Change delay, max items or max pages |
| `GET /jobs/:id/summary` | A job's summary |
| `GET /jobs/:id/history` | A job's state transitions |
| `GET /jobs?limit&before` | Paged job list (adds `next`) |
| `GET /jobs/:id/logs?offset&limit` | Paged logs |
| `GET /network` | Public network status |
| `GET /admin/network` | Administrators only |
| `POST /admin/network/:id/check` | Administrators only: run a health check |
| `POST /admin/network/:id/reset` | Administrators only: close a circuit |

Other scraper changes:
- New job states `waiting` and `paused` in summaries and SSE.
- Refusals carry `Retry-After`.

**Accounts.** `GET /api/account/me` adds `admin` (boolean).

**AI Coding Lab.**
- The page is `GET /ultra/ai-lab`.
- The API is under `/api/lab`; the full table is in
  [docs/ai-lab.md §11](ai-lab.md#11-api).
- Errors use MetaCode's `{ error: { type, message } }`, with status codes:
  - 401 — sign in;
  - 402 — plan;
  - 403 — origin, or accounts off;
  - 404 — not yours, or missing;
  - 409 — conflicts;
  - 413 — storage;
  - 429 — limits and concurrency;
  - 502 / 503 — provider.

## F. External dependencies

| Dependency | Kind | Notes |
|---|---|---|
| `typescript` 5.9.3, `@types/node` 22.20.5 | Dev only | `npm run typecheck`; not needed at runtime |
| No new runtime npm packages | — | Uses existing `express` and `undici` (ProxyAgent for providers) |
| highlight.js 11.9.0 from cdn.jsdelivr.net | Browser, optional | Code colouring in the Lab. If it fails to load, code is shown uncoloured |
| OpenAI or an OpenAI-compatible API | Optional, operator-configured, **paid** | Off unless `AI_LAB_OPENAI_API_KEY` is set. Fine-tuning additionally needs `AI_LAB_FINE_TUNING=on` |
| A separately managed VPN gateway | Optional, operator-run | MetaCode only connects to it as an HTTPS proxy. No VPN software runs in MetaCode's process or needs privileges |
| Supabase, Stripe, the existing AI service (EMIS) | Existing | No new configuration required |
| Mullvad VPN app repository | Reviewed only | Not vendored, not translated, not executed |

## G. Test results

The final run on this branch (Node 22.22, Chromium from `/opt/pw-browsers`):

| Check | Result |
|---|---|
| `npm test` (unit, integration, Playwright end-to-end) | **279 / 279 passed**, 0 failed, 0 skipped (158 s). The baseline was 247 |
| `npm run typecheck` | 0 errors |
| Collector `npx vitest run` | **30 / 30 passed** (baseline 27) |
| `test/scraper-durable.test.js` (18 tests) | Passed 3/3 consecutive runs |
| `test/ai-lab-e2e.test.js` (browser journey) | Passed 3/3 consecutive runs |

**New Lab tests** (`test/ai-lab.test.js`, 10 integration tests against the real
server):

1. **Entitlement matrix.** Signed out; Free, Pro and Max; Ultra active,
   trialing, cancelled at period end, past due, expired; an override; an admin;
   forged tokens; cross-site writes.
2. **Project, profile and knowledge.** Versioning, secret redaction,
   injection flags, refused key files, retrieval.
3. **A streamed conversation.**
   - Retrieval, the context report and usage.
   - Stop, keeping a partial answer.
   - Regenerate and a summary.
4. **A dataset.** Checks, the quality report, splits, a committed version.
5. **Suite to accepted candidate.** Suite → baseline (0%) → profile change →
   rerun (100%) → comparison → AI-suggested candidate → accept.
6. **Runs.** Non-comparable task sets are refused; a cancelled run resumes
   without repeating finished tasks.
7. **Isolation.** A second Ultra user can't read, change, stream into, export,
   compare or resume the first user's objects.
8. **Limits.** The daily allowance is enforced; failed calls aren't charged.
9. **Fine-tuning.** Unavailable without a provider. With a mock
   OpenAI-compatible API: file upload, job creation, status, events, cancel,
   and the gates for cost, data quality and minimum examples.
10. **Your data.** Export everything; delete everything.

**New browser tests** (`test/ai-lab-e2e.test.js`):
- The gate, for a signed-out user and a Pro user (the API answers 402 even if
  the page is bypassed).
- An Ultra user's whole journey through the UI:
  1. Project, a knowledge document and search.
  2. A profile.
  3. A Workbench streamed answer with its token report and context panel, then
     Stop.
  4. A dataset with checks, and a commit.
  5. A suite, and a baseline run at 0%.
  6. A suggested candidate, and a run at 100%.
  7. The comparison ("1 improved", with the single-attempt warning).
  8. Accepting the candidate, and the Overview.

  No page errors.

**What the tests do not show:**
- Supabase, Stripe, the AI service, the OpenAI-compatible API and Reddit are
  local mocks in these tests. Passing tests show that MetaCode's code paths
  work against those protocols, not that a live provider or a live Reddit
  response behaves the same way.
- No real fine-tuning job was created, and no paid API was called.
- The front end was tested in Chromium at desktop width only.

**Problems found and fixed while testing:**
- A navigation race in the Lab's router: a slower, older render could overwrite
  a newer view.
- Background refreshes writing into a page you had already left.
- An evaluation step that silently added an `exact` check to tasks that had
  none. Those tasks now stay ungraded, as documented.
- A made-up `sk_live_…` string in a test tripped GitHub push protection. The
  test now builds it at run time; push protection was not bypassed.

## H. Deployment instructions

On the VPS (`/home/ubuntu/metacode`), after merging into `main`:

```bash
cd ~/metacode
git pull
npm install                 # installs typescript/@types/node too (dev only; harmless)
pm2 reload metacode
```

1. **Nothing new is required.**
   - The Lab uses the existing Supabase, Stripe and AI settings.
   - The process must be able to write `scraper-data/` and `lab-data/`, which
     are created automatically.
   - The collector doesn't need rebuilding for this change.
2. **Optional `.env` settings** (see `.env.example`):
   - `ADMIN_EMAILS=you@…` — network diagnostics and Lab metrics.
   - `AI_LAB_PRICING_FILE` / `ai-lab-pricing.json` — cost estimates. Fill in
     real prices from your provider; there are no defaults.
   - `AI_LAB_OPENAI_API_KEY` and the fine-tuning variables — a second provider.
     Verify the base models and prices in the provider's current docs first.
   - `SCRAPER_NETWORK_PROVIDERS` / `SCRAPER_PROXY_URL` /
     `SCRAPER_VPN_GATEWAY_PROXY_URL` (+ `SCRAPER_VPN_GATEWAY_HEALTH_URL`) — only
     if you run an approved proxy or VPN gateway (docs/scraper-network.md).
3. **Check:**
   - Open `https://metac0.de/ultra/ai-lab`. A non-Ultra account sees the
     "part of Ultra" page; an Ultra account sees the Overview.
   - `GET /api/scraper/network` shows the network status.
4. **Back up** `account-data/`, `survey-data/`, `scraper-data/` and
   `lab-data/`.
5. **Roll back:**
   - Check out the previous commit and `pm2 reload metacode`.
   - Or set `AI_LAB_ENABLED=false` / `SCRAPER_PERSIST_JOBS=false` and reload.

## I. Known limitations

**Retrieval**
- Keyword search (BM25), not semantic search. No embeddings provider is
  integrated.

**Code execution**
- Generated code is never executed. `unit_tests` checks are always skipped. A
  real sandbox (a disposable microVM without network) would be a separate
  service; requirements are in docs/ai-lab.md §8.

**Fine-tuning**
- Implemented against the OpenAI-compatible API shape and tested only against a
  mock.
- The list of fine-tunable base models (`AI_LAB_FINE_TUNE_MODELS`) must come
  from the provider's current documentation. MetaCode doesn't guess it.

**Costs and tokens**
- Costs are estimates from an operator-maintained price list, or "unknown".
- Tokens are estimated (characters ÷ 4) when a provider doesn't report usage;
  every figure says which it is.

**Storage and scale**
- JSON files for a single server process. Running several processes would need
  the two store modules moved to a database.

**Scraper**
- SOCKS proxies aren't supported (reported as such).
- Custom-code and AI Scraper jobs can't resume part-way after a restart.

**Workbench**
- An answer that was streaming when the server restarted is lost. The question
  stays, and Regenerate answers it.
- Streams don't reconnect.

**Front end**
- The Lab front end has keyboard focus styles, ARIA labels and a responsive
  layout, but there has been no formal accessibility audit and no phone-width
  browser test.

**Infrastructure**
- There is no CI in the repository. Tests run locally (`npm test`).

**Open items**
- The in-app browser over proxy transports (task #53) is still waiting for your
  go-ahead.

## J. Recommended next steps

1. **Deploy and check with real services.** Deploy, then do one real Ultra
   session against the live AI service:
   - one conversation;
   - one small suite (5–10 tasks) with repeats = 3, to see the real latency,
     token and consistency figures.
2. **Price list.** Add `ai-lab-pricing.json` with your current prices, so costs
   show as estimates instead of "unknown".
3. **CI.** Add a workflow running `npm test`, `npm run typecheck` and the
   collector tests on every push.
4. **Before enabling fine-tuning:**
   - confirm the provider's current API, models and prices;
   - run one minimal job by hand;
   - only then set `AI_LAB_FINE_TUNING=on`.
5. **Semantic retrieval.** Consider an embeddings provider as an optional
   second index alongside BM25. Measure its effect with an evaluation suite
   before switching anything on by default.
6. **A sandbox service.** If running generated tests matters, design it as an
   isolated service (microVM, no network, strict limits) and review it before
   connecting `unit_tests` checks to it.
7. **A database.** If traffic grows beyond one process, move `ai-lab/store.js`
   and `scraper/jobs/job-store.js` to Postgres, with row-level ownership like
   `metacode_data`.
