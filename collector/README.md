# AI Scraper (beta)

Describe the Reddit posts you need in a sentence or two. An AI agent on the MetaCode server works out where
they're discussed, searches, reads posts when it's unsure, and keeps the ones that fit. You watch each step.
The posts are kept in your browser, exported as JSON, JSON Lines or CSV, and **Add to project** sends them to
MetaCode for coding, with their score and comment count as engagement for Metrics.

In MetaCode it is the sidebar's **AI Scraper** page (`app.html#scraper-beta`); it also runs on its own at
`/collector/`. The regular **Reddit Scraper** (sidebar → Scraper) is unchanged.

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Using it](#using-it)
- [Reaching Reddit](#reaching-reddit)
- [Limits and cost](#limits-and-cost)
- [Security](#security)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [What it can't do](#what-it-cant-do)

## Quick start

The MetaCode server needs:

- **Node.js 22.12 or newer** (building the app with Vite 7).
- **Python 3.8+**. The agent is `python/ai_scraper.py`, standard library only. `SCRAPER_PYTHON` picks the
  command if it isn't `python3`.
- **MetaCode's AI key** (`EMIS_API_KEY=emis-…` in `.env`; keys are issued by hand — message @kawaii_zxs on Discord,
  user ID 1079096114273320971). The agent uses MetaCode's AI service like the other AI features.

```bash
# in the MetaCode folder
npm install                    # MetaCode server
npm run collector:install      # this app's dependencies (collector/node_modules)
npm run collector:build        # type-check + production build → collector/dist
npm start                      # MetaCode at http://localhost:3000
# open http://localhost:3000/app.html#scraper-beta (inside MetaCode) or http://localhost:3000/collector/
```

| Command (MetaCode folder) | What it does |
|---|---|
| `npm run collector:dev` | Vite dev server with hot reload at http://localhost:5173/collector/. Run `npm start` first: Vite proxies `/api/scraper` to it (`METACODE_URL`, see `collector/.env.example`). |
| `npm run collector:build` | Type-check (`tsc`) and build into `collector/dist`, which MetaCode serves at `/collector/`. |
| `npm run collector:test` | This app's unit tests (Vitest + jsdom + fake IndexedDB). |
| `python3 -m unittest discover -s test/python` | The agent's unit tests. Also part of `npm test`. |
| `node --test --test-force-exit test/ai-scraper.test.js test/collector.test.js` | The agent through the server, and this app end to end in Chromium. Also part of `npm test`. |

## How it works

```
 This app (TypeScript, React)          MetaCode server (Node.js)                     python/ai_scraper.py
 ┌──────────────────────────┐ POST    ┌──────────────────────────────────┐ JSON     ┌──────────────────────┐
 │ New job: the goal,       │ /jobs   │ AI job (scraper/ai/agent-runner) │ lines    │ the agent: plan →    │
 │ limits, Reddit access    │───────▶ │  · "ai" → MetaCode's AI service  │◀───────▶ │ call a tool → read   │
 │ Monitor: the AI's steps  │◀─────── │  · tools → the job's Reddit      │          │ the result → …       │
 │ Data, exports, Add to    │ events  │    client (rate limits, keys)    │          │ → finish             │
 │ project (IndexedDB)      │ results │  · keeps the records it picks    │          └──────────────────────┘
 └──────────────────────────┘         └──────────────────────────────────┘
```

1. **You describe the goal** (for example *"first-hand accounts of long COVID fatigue from r/covidlonghaulers
   and r/cfs, newest first"*) and set the limits. The app starts an AI job on the MetaCode server
   (`POST /api/scraper/jobs`, mode `ai`).
2. **The agent** (`python/ai_scraper.py`) asks the AI model for one step at a time. The model answers with
   a JSON object, `{"thought": …, "tool": …, "args": …}`, picking from these tools:
   - `find_subreddits`: communities by name or description;
   - `search_posts`: Reddit search, all of Reddit or one subreddit, with sort, time span and "more";
   - `list_posts`: a subreddit's hot, new, top, rising or controversial posts;
   - `read_post`: a post's full text and some top comments, when the title isn't enough;
   - `keep`: add posts seen in results to the collection;
   - `finish`: end the job, with a summary.

   The agent checks each call, shows the model a compact result (id, subreddit, score, comments, age, title,
   the start of the text), remembers what it already tried, and says when a call was wrong so the model can
   fix it.
3. **The server makes every request.** AI requests go through MetaCode's AI service (same key, model choice,
   fallbacks and quota messages as other AI features). Reddit requests go through the job's Reddit client
   (destination checks, rate limits, retries). `keep` adds the records Reddit returned to the server, so the
   AI can't make posts up.
4. **This app follows the job** with server-sent events (or polling): the steps appear in the Monitor as they
   happen, and the posts the AI keeps are copied into this browser's IndexedDB. If you reload the page or close
   it, the job keeps running on the server and the app picks it up again when it opens.

| Part | Files | Role |
|---|---|---|
| Agent | `../python/ai_scraper.py` | The plan → act → observe loop, tool checks, the model's memory of earlier steps |
| Server side | `../scraper/ai/agent-runner.js`, `../scraper/index.js` | Starts the agent; answers its AI and tool calls; budgets; job API |
| AI jobs client | `src/lib/ai-jobs.ts`, `src/lib/session.ts` | Starts, watches, stops jobs; copies records into IndexedDB in order, each once |
| Records | `src/lib/records.ts` | The server's records → this app's schema ([SCHEMA.md](SCHEMA.md)) |
| Storage and exports | `src/store/db.ts`, `src/export/*` | IndexedDB (dedupe, merge, query, retention), exports in a Web Worker |
| Views | `src/ui/*` | Overview, New job, Monitor, Data, Settings |

## Using it

1. **New job.** Describe what you need. Mention constraints the AI should respect, such as subreddits, time
   span, "newest first", or "first-hand accounts only". Set the limits: posts to keep, comments per post (0 for
   none), AI steps, and run time.
2. **Monitor.** Each step shows what the AI did, why (its thought), and what came back. **Stop** ends the job;
   the posts kept so far stay. At the end you see the outcome and the AI's own summary, and inside MetaCode
   **Add this job's posts to project** sends them for coding.
3. **Data.** Search, filter by subreddit, job and collection date, open a record with its comment thread,
   **Open on Reddit**, delete records, export everything or the filtered records, and **Add these to project**.

The AI model is chosen in MetaCode's **Settings → AI models → AI Scraper** (default: the server's model).

## Reaching Reddit

The job's Reddit requests are made by the MetaCode server, in one of three ways (**New job → Reaching Reddit**).
The form starts on **RedditAPIs.com** (the server's `SCRAPER_DEFAULT_ENGINE`) and remembers your last choice in
this browser.

| Choice | Needs | Notes |
|---|---|---|
| **RedditAPIs.com** (default) | Your key (Reddit Scraper page → RedditAPIs.com key) or the server's | A third-party paid service, billed per request. `find_subreddits` isn't available through it. Without a key the option reads *RedditAPIs.com (add your API key)* and **Start** stays off. |
| **Your Reddit API keys** | Keys added on the Reddit Scraper page → Reddit API access | They stay in this browser and are sent only with your jobs. They give your own limit (about 100 requests a minute per app) and work when Reddit blocks the server's address. |
| **This MetaCode server** | — | The server's Reddit API keys if it has them (a limit shared by everyone), otherwise public pages. Reddit often blocks servers' public requests ("You've been blocked by network security"), and robots.txt applies to public pages. |

The AI doesn't change what Reddit allows. It can't log in, solve CAPTCHAs, or get past blocks. If Reddit
refuses the server, the job stops and says so.

## Limits and cost

- **Steps** (5–60, default 25): tool calls the AI may make. Replies the agent couldn't read don't count, but
  three in a row end the job.
- **AI requests**: one per step, at most the step limit plus 6, all on MetaCode's AI key. On a shared server
  everyone shares that key's budget (prompts and/or tokens per day, week or month; when it's used up, jobs stop
  until it rolls over).
- **Posts to keep** (1–300) and **comments per post** (0–100): the job ends when the limit is reached.
- **Run time** (1–30 minutes): then the AI is asked to wrap up, and stopped a minute later.
- **Reddit requests**: paced like any MetaCode scraper job (at least `SCRAPER_MIN_DELAY_MS` apart, per set of
  keys). At most `SCRAPER_MAX_CONCURRENT_JOBS` jobs of any kind run at once on the server.
- The server keeps a finished job for `SCRAPER_JOB_RETENTION_MINUTES` (default 120). The posts already copied
  into this browser stay here.

## Security

- **The AI can only read.** Its tools are read-only Reddit queries with bounded limits. There is no tool to
  open other websites, log in, post, or run code.
- **Reddit content is data.** Posts and comments are shown to the AI marked as data, and its instructions say
  to ignore instructions inside them. Even if a post manages to steer the AI, the worst it can do is choose
  another read-only call within the job's budget.
- **No made-up records.** `keep` takes ids the agent has seen in results, and the server adds the records
  Reddit returned for those ids.
- **No secrets in the agent.** `python/ai_scraper.py` gets no keys and no `.env`, only the goal, the limits,
  and tool results. Your own Reddit keys go from this browser to the server with the job, and are used for its
  Reddit requests only. They're never stored on the server, shown to the AI, or logged.
- **Collected text is rendered as text** (React escaping). Outside links must be http(s), open with
  `rel="noopener noreferrer nofollow"` and show their domain. "Open on Reddit" links only go to Reddit.
- **Add to project** talks to MetaCode with `postMessage`, same origin only. MetaCode accepts messages only
  from its own frame and copies known fields with checked types.

## Tests

| Covered | Where | Real AI or Reddit? |
|---|---|---|
| The agent: reading the model's replies (fenced, wrapped in prose, malformed), argument checks and limits, invalid and repeated calls, server errors, fatal errors, time limit, long-job memory, the JSON-lines protocol | `../test/python/test_ai_scraper.py` | no: scripted |
| AI jobs through the server: tools against a stand-in Reddit, records only from Reddit, steps and summary, limits (posts, steps), AI quota error, Reddit blocking the server, your own keys, cancelling | `../test/ai-scraper.test.js` | no: scripted AI, stand-in Reddit |
| Records, settings, your keys, job requests, outcomes, live events and polling, copying records in order | `test/ai.test.ts` | no |
| IndexedDB and exports | `test/store-export.test.ts` | no |
| End to end in Chromium: a job from this app (on its own and inside MetaCode, with the model picked in Settings), the steps in the Monitor, Data, Add to project, a reload while a job runs | `../test/collector.test.js` | no: a stand-in AI service drives the real agent |

These tests show the pieces work together. They don't show how well a real AI model picks posts for a real
goal; that depends on the model you choose. Try a small job first and read the steps.

## Troubleshooting

**"The AI Scraper needs Python 3 on the MetaCode server"**
Install Python 3 (`sudo apt install python3`), or set `SCRAPER_PYTHON` to its command, then restart MetaCode.

**"MetaCode's AI isn't set up yet" / an AI quota or rate-limit message**
The AI service is MetaCode's: set `EMIS_API_KEY` in `.env` (Settings → AI connection shows the state). A used-up
quota ends the job, and the posts kept so far stay.

**The job stops with "You've been blocked by network security" / "Reddit refused this request…"**
Reddit is blocking the server's address. Add your own Reddit API keys (Reddit Scraper → Reddit API access) and
choose **Your Reddit API keys** under Reaching Reddit.

**"robots.txt doesn't allow automated access…"**
Without API keys the server reads Reddit's public pages and follows robots.txt, which disallows most of Reddit.
Use API keys.

**"The AI model didn't answer in the required format 3 times in a row"**
Some models don't follow the JSON format reliably. Pick another one in Settings → AI models → AI Scraper.

**The AI keeps posts that don't fit, or stops early**
Make the goal more specific: what counts and what doesn't, where to look, and how many posts. Read the steps in
the Monitor to see how it searched. A larger model usually judges better.

**`/collector/` or the AI Scraper page says "isn't built yet"**
Run `npm run collector:install && npm run collector:build`, then reload.

**The Monitor stops updating**
The app falls back to polling when the event stream breaks, which can happen when a proxy times out long
connections. Reloading the page picks the job up again. Jobs are lost when the server restarts; the posts
already copied stay.

## What it can't do

- It only collects public posts through Reddit's API (or RedditAPIs.com). It doesn't read private, quarantined
  or age-gated communities, or anything that needs a login.
- It's as good as the model and the goal. Check what it kept before you rely on it, the same way you would check
  a student assistant's work.
- One job at a time per browser. The server's limits on concurrent jobs and Reddit requests apply.
