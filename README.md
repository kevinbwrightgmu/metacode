# MetaCode — Social Media Coding Platform

An AI-assisted content analysis platform for researchers. Auto-code social media posts, apply your own codebook, perform manual human coding, calculate intercoder reliability, and run real NetworkX social network analysis on any CSV.

Opening the app now shows a landing page first — click **Launch MetaCode** to get to the actual tool (`app.html`).

---

## Features

| Module | Description |
|---|---|
| **Import Data** | Upload CSVs for posts, engagement metrics, and social network data. The `text` column is optional — if no text-like column is found by name, AI reads the file's structure and maps it for you |
| **Scraper** | Sidebar → **Scraper** is the Reddit Collector (`collector/`, React + TypeScript): a bot reads public posts and comments from Reddit pages loaded through Scramjet, follows robots.txt by default, stores records in this browser (IndexedDB) and exports JSON, JSON Lines or CSV. **Add to project** sends them to the project with their engagement for Metrics. Pages load through MetaCode's own Wisp proxy, or its HTTP relay when a reverse proxy blocks WebSockets. See [collector/README.md](collector/README.md) |
| **Reddit API Scraper** | Linked from the top of the Scraper page (`#scraper-api`). Collects subreddit, search, post-and-comments and profile data from Reddit (standard mode) or with your own sandboxed Python, JavaScript or TypeScript (custom code mode), with Reddit API keys or without. Live progress, results table/JSON, CSV/JSON export, and **Add to project**. Server requests go through a Python worker (or epoxy-tls over Wisp without Python). See [docs/reddit-scraper.md](docs/reddit-scraper.md) |
| **Projects** | Save the open project and keep as many as you like (in your browser — private to you, even on a shared MetaCode server): reopen an earlier one, rename, duplicate, export/import as JSON, delete. A project that's open is saved automatically (Autosave) |
| **Survey Studio** | Its own page, opened from the front page (**Open Survey Studio**). Build surveys on a freeform canvas where every part — down to a single answer choice — can be moved, resized, rotated, scaled, distorted and styled; 30+ element types, layers, groups, components, a theme with per-element overrides, Scratch-style block logic (show/hide, skip, branching, variables, formulas, scores, conditional styling, randomization blocks for assigning participants to conditions or messages), device preview, versioned publishing to a public link, and response collection with CSV/JSON export. Open-text answers can be added to the project for coding. See [docs/survey-studio.md](docs/survey-studio.md) |
| **Codebook Builder** | Define custom coding dimensions and codes; each code has an optional AI Fine-Tuning Notes field the model reads during Auto-Coding, separate from the Description shown to human coders; import/export as CSV |
| **AI Auto-Coding** | The AI applies your codebook to posts and provides confidence scores + reasoning |
| **Human Coding** | Efficient post-by-post manual coding interface with AI suggestions |
| **Reliability Analysis** | Cohen's Kappa, Krippendorff's Alpha, % agreement, confusion matrices |
| **Analyze CSV (NetworkX)** | Upload *any* CSV — AI (or heuristics) detects source/target edge columns, then a real Python NetworkX backend computes density, centrality (degree/betweenness/closeness/eigenvector), components, and communities |
| **Network Graph** | Interactive D3.js force-directed visualization — can be populated directly from the NetworkX analysis, with detected communities as node colors; export the full graph as PNG or SVG at any time, regardless of current zoom/pan |
| **Metrics** | Engagement averages, every post's engagement (sortable list — posts from the Scraper bring theirs), code distributions, engagement by code, AI–human agreement and completion charts |
| **Export** | Download coded data, reliability reports, and codebook as CSV |
| **MetaCode Assistant** | Built-in help chat — click **Ask MetaCode** (top right) to ask how to use any feature, what a number means, or how to fix an error; answers come from the same AI as AI Coding and use a summary of your project's current state |

---

## Quick Start

### Prerequisites
- **Node.js** v18 or higher → [nodejs.org](https://nodejs.org) (**v22 or higher** for the Reddit Scraper)
- **Python** 3.9 or higher (only needed for the "Analyze CSV" NetworkX feature) → [python.org](https://python.org)
- An **AI API key** for MetaCode's AI service (keys are issued manually by the service's operator).

### Setup (4 steps)

**1. Install Node dependencies**
```bash
npm install
```

**2. Install the Python NetworkX dependency** (only needed for "Analyze CSV")
```bash
pip install -r requirements.txt
```

**3. Add your AI key**
```bash
cp .env.example .env
# Edit .env and set your key:
# EMIS_API_KEY=your-key
```
The key is only read by MetaCode's server — it never reaches the browser. See [AI Provider](#ai-provider)
for the other settings. **Settings → AI connection** shows which file was read and which settings it contained
(names only); after editing `.env`, click **Reload .env** — no restart needed for the AI settings. In **Settings →
AI models** pick a default model and, if you like, a different model for each AI feature.

**4. Start the server**
```bash
npm start
```

Then open **http://localhost:3000** in your browser. The top bar and the "Analyze CSV" page both show a live status indicator so you always know whether the AI and Python/NetworkX are ready.

The **Scraper** page needs one build step first (see [Scraper (Reddit Collector)](#scraper-reddit-collector) below).
The **Reddit API scraper** works with no extra setup, and Reddit API credentials are optional: see [Reddit Scraper](#reddit-scraper).

**Running MetaCode on a server** (a VPS with pm2, nginx and HTTPS): follow **[docs/deploy-vps.md](docs/deploy-vps.md)**.
It includes `ecosystem.config.cjs` for pm2 and an nginx config that forwards the Scraper's WebSocket.

### Tests
```bash
npm test          # all tests (browser tests need Chromium: set CHROMIUM_PATH, or they are skipped)
npm run test:unit # without the server/browser tests
```

### Scraper (Reddit Collector)
The sidebar's **Scraper** page is a separate app in `collector/`. Build it once, and again after each update:
```bash
npm run collector:install   # its own dependencies, in collector/
npm run collector:build     # build into collector/dist; MetaCode shows it on the Scraper page (and at /collector/)
npm run collector:test      # its unit tests (end-to-end tests run in npm test once it is built)
```
Until it is built, the Scraper page shows these commands. See [collector/README.md](collector/README.md) for the
development server, the live check and troubleshooting.

---

## Recommended Workflow

```
1. Import Data     → Upload your posts CSV (a "text" column helps but isn't required)
                     — or Scraper → collect Reddit posts/comments → Add to project
2. Codebook        → Define dimensions (Sentiment, Stance, Topic, etc.) and codes
3. AI Coding       → Run batch AI coding — the model codes all posts automatically
4. Human Coding    → Manually code a sample of posts for reliability testing
5. Reliability     → Compare AI vs Human coding — view Kappa, Alpha, confusion matrix
6. Analyze CSV     → Upload any relational CSV (mentions, follows, replies) for NetworkX analysis
7. Network Graph   → Explore the graph visually, or send NetworkX results straight in
8. Metrics         → Explore code distributions and engagement by code
9. Export          → Download coded data and reliability report
```

---

## Data Formats

### Posts CSV
```
text,id,author,timestamp,likes,shares,comments,views
"Post content here",p001,username,2024-01-15,234,45,12,5600
```
No column is strictly required. If a `text`-like column (text, content, body, post, message, tweet, comment)
isn't found by name, the app asks the AI to read your header row and a few sample rows and map the
columns itself. If it still can't find free-text content, posts import anyway with blank text — engagement
and network features keep working.

### Any Edge/Relationship CSV (for "Analyze CSV")
```
source,target,weight,type
u1,u2,3,follows
```
Works with **any** column names — `from/to`, `follower/followee`, `sender/receiver`, `src/dst`, and more are
auto-detected by heuristic matching first; if nothing matches, the AI reads the header and sample rows and
infers which columns represent a relationship. You can always override the detected mapping by hand.

### Network Nodes CSV (for the Network Graph's manual import)
```
id,label,group,size
u1,@username,community_A,15
```

### Network Edges CSV (for the Network Graph's manual import)
```
source,target,weight,type
u1,u2,3,follows
```

### Codebook CSV (for import)
```
dimension_name,dimension_description,code_id,code_label,code_description,code_ai_notes
Sentiment,Emotional valence,pos,Positive,Expresses optimism,
Sentiment,Emotional valence,neg,Negative,Expresses pessimism,Watch for sarcasm — exaggerated praise about bad news is Negative
```
`code_ai_notes` is optional and separate from `code_description`: the description is shown to human coders,
while the AI notes are additional instructions included only in the AI's prompt during Auto-Coding — useful
for correcting a recurring mistake or disambiguating from a similar code without changing what coders see.

---

## Analyze CSV (NetworkX)

This page (sidebar → **Analyze CSV**) is a general-purpose network analysis tool for *any* CSV that
represents relationships — mentions, replies, follows, retweets, co-occurrence, anything with a
source/target shape.

**How it works:**
1. Upload a CSV. A quick heuristic checks for common column-name pairs (source/target, from/to,
   follower/followee, etc.). If nothing matches, the AI reads the header and a few sample rows and
   proposes a mapping — which two columns are the relationship, which (if any) is a weight, and
   whether the relationship is directed.
2. Review or override the detected mapping, then click **Run NetworkX Analysis**.
3. A real Python process (using the [NetworkX](https://networkx.org) library) computes: node/edge
   counts, density, average degree, connected components, diameter, average path length, average
   clustering coefficient, degree/betweenness/closeness/eigenvector centrality (top 15 nodes each),
   and community detection via greedy modularity.
4. Click **Send to Network Graph** to load the exact nodes and edges — with detected communities
   as node colors and degree centrality as node size — straight into the D3 Network Graph view.

Graphs over 500 nodes automatically skip the slowest centrality measures (closeness, eigenvector)
and approximate betweenness by sampling, so analysis stays fast.

If NetworkX isn't installed, both the app's top status banner and the Analyze CSV page will tell you
plainly — just run `pip install -r requirements.txt` and refresh.

---

## Reddit Scraper

The **Reddit API scraper** collects Reddit data on the MetaCode server. Open it with the **Reddit API scraper**
link at the top of the Scraper page (sidebar → **Scraper**, which is the [Reddit Collector](collector/README.md)), or at
`app.html#scraper-api`. Full guide: **[docs/reddit-scraper.md](docs/reddit-scraper.md)**
(how it works, configuration, custom-code API, security model, rate limiting, troubleshooting, licenses).

- **Standard scraper** — subreddit listings, search, a post with its comments, user profiles, any Reddit URL
  (auto-detected), front page / domain listings, subreddit and user info. Limits for items, pages, delay,
  timeout, concurrency and retries; optional comments for listing posts.
- **Custom code** — `async def scrape(ctx)` in **Python** (the default), or `async function scrape(ctx)` in
  JavaScript/TypeScript, with a Reddit SDK:
  - `ctx.reddit.pages/listing/post/json`;
  - `ctx.fetch`, `ctx.emit`, `ctx.log`, `ctx.retry`, and more;
  - Python's whole standard library (`re`, `statistics`, `collections`, …).

  Python runs in Pyodide (CPython compiled to WebAssembly) and JS/TS in QuickJS. Either way the code runs in a
  permission-restricted Node process with no files, secrets or direct network access, and with time and memory
  limits.
- **Python server engine** — server-side jobs make their HTTPS requests through `python/reddit_fetch.py`, which
  uses only Python's standard library. Without Python, they fall back to epoxy-tls over Wisp
  (`SCRAPER_SERVER_TRANSPORT`).
- **With Reddit API keys**: combine sorts to collect past Reddit's ~1,000-post listing limit, and load comments
  collapsed behind "load more".
- **Jobs** run in the background (queued → running → completed / failed / cancelled) with live progress over
  server-sent events. Results: table with search/filter/sort and record details, JSON, logs, metadata;
  export CSV/JSON/NDJSON or a reply-network edge list for Analyze CSV; **Add to project** turns posts and
  comments into project posts (the whole post — title, text, link/media, poll options — as the text) and sends each one's
  engagement to **Metrics** (score → likes, comments, crossposts → shares, upvote ratio, awards; adding again refreshes the numbers).
  The results show the average likes (score), comments, shares (crossposts) and views of the posts in view.
- **Networking**: every Reddit request goes through MetaCode's own Wisp endpoint (`/wisp/`, wisp-js), which
  only connects to Reddit's hosts, using epoxy-tls (end-to-end TLS in WebAssembly). The **Browse Reddit**
  panel is built on Scramjet with epoxy-transport over the same endpoint.
- **No setup by default — "This browser (Scramjet)"**: jobs run on the server, but your open MetaCode tab makes
  the Reddit requests through the same Scramjet/epoxy connection as Browse Reddit, so no API keys or `.env`
  changes are needed. Keep MetaCode open until a job finishes. With `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`
  you can instead run jobs entirely on the server through Reddit's API, or with a `REDDITAPIS_KEY` through the third-party RedditAPIs.com service (paid per request).
- **Responsible use**: shared per-host rate limiter with a server-enforced minimum delay, Reddit rate-limit
  headers and `Retry-After` honoured, caps on items/pages, no login/CAPTCHA/age-gate circumvention. The server
  engine checks robots.txt when it reads public pages without credentials.
- Results are kept in server memory for `SCRAPER_JOB_RETENTION_MINUTES` (default 120): export them or add them
  to the project.

| Variable | Default | What it does |
|---|---|---|
| `SCRAPER_USER_AGENT` | generic MetaCode UA | Identify your client: `nodejs:metacode-scraper:1.0 (by /u/you)` |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | — | Optional: the server's Reddit API keys, for users who haven't added their own. Each user can add their own on the Reddit API scraper page (**Reddit API access**): they stay in that browser and give that user their own API limit. Needed when Reddit blocks logged-out access from your network (HTTP 403, "blocked by network security") |
| `REDDITAPIS_KEY` | — | Optional: the server's key for [RedditAPIs.com](https://www.redditapis.com/dashboard/api-keys), a third-party paid (per-request) Reddit data API. Users can add their own instead (kept in their browser) |
| `SCRAPER_RESPECT_ROBOTS_TXT` | `true` | Check robots.txt in public mode |
| `SCRAPER_MIN_DELAY_MS` / `SCRAPER_PUBLIC_MIN_DELAY_MS` | `1000` / `6000` | Minimum delay between requests per host |
| `SCRAPER_MAX_ITEMS` / `SCRAPER_MAX_PAGES` | `5000` / `50` | Hard per-job caps |
| `SCRAPER_CUSTOM_CODE_ENABLED` / `SCRAPER_CUSTOM_TIMEOUT_MS` / `SCRAPER_CUSTOM_MEMORY_MB` | `true` / `120000` / `64` | Custom-code sandbox (memory: JavaScript) |
| `SCRAPER_CUSTOM_PYTHON_MEMORY_MB` | `256` | Memory limit of Python custom scrapers |
| `SCRAPER_SERVER_TRANSPORT` / `SCRAPER_PYTHON` | `auto` / — | Server HTTPS engine: `python`, `epoxy` or `auto`; Python command to use |

All scraper variables (concurrency, retention, response size, browser on/off, test-only overrides) are listed in
`.env.example` and the guide.

---

## Survey Studio

Survey Studio builds and runs surveys on its own page, `studio.html`. Open it from the front page with
**Open Survey Studio**. Full guide: **[docs/survey-studio.md](docs/survey-studio.md)**.

**New to it? Take the hands-on tutorial** — **Tutorial & tour** in the Studio's top bar (or the compass
button in the editor, the empty survey list, or `studio.html?tutorial=1`). In about five minutes it walks you
through the whole workflow on a practice survey: name it, add and edit a question, make it required, add a
follow-up shown by logic, change the theme colour, preview on a phone, publish and find the responses. Each
step points at what to use and moves on once you've done it; any step can be skipped, and a closed tutorial
can be resumed. It works on phones too (the side panels open by themselves). The same menu has a 2-minute
tour of the screen.

- **Design:** start from a template or a blank page. Add questions, text, media and layout elements from the
  palette.
  - Every element, including each answer, indicator and label, has its own transform, appearance,
    typography, states, behaviour, validation, accessibility and animation.
  - The canvas has handles, snapping, grid, zoom/pan, align/distribute, groups, layers, lock/hide,
    copy/paste and undo/redo.
- **Logic:** block coding like Scratch. Drag *when …* hat blocks, *if/else* blocks, show/hide, page and
  variable blocks, and condition/value blocks onto a workspace and snap them together. Variables, formulas
  and scores are included. Problems are listed, and publishing is blocked until they are fixed.
- **Preview:** Desktop, Tablet or Mobile, with a live test panel showing answers, variables, active rules
  and an event log.
- **Publish:** creates an immutable version and a public link, `/s/<id>`. Re-publishing keeps the link.
  Each response records its version.
- **Responses:** summaries, a response table, and CSV/JSON export. **Add text answers to project** sends
  open-text answers to the coding tools.

Survey drafts stay in your browser. Publishing puts the published version on the server (JSON files in
`SURVEY_DATA_DIR`, default `survey-data/`), where its responses are collected; only the browser that
published it can see them. Respondents must be able to reach your MetaCode server to answer.

---

## Intercoder Reliability Metrics

| Metric | Formula | What it measures |
|---|---|---|
| **% Agreement** | agreements / total | Raw proportion of matching codes |
| **Cohen's κ** | (Po − Pe) / (1 − Pe) | Agreement corrected for chance |
| **Krippendorff's α** | 1 − Do/De | Reliability for 2+ nominal raters |

### Kappa Interpretation
| κ value | Strength |
|---|---|
| < 0.00 | Poor |
| 0.01–0.20 | Slight |
| 0.21–0.40 | Fair |
| 0.41–0.60 | Moderate |
| 0.61–0.80 | Substantial ✓ |
| 0.81–1.00 | Near Perfect ✓ |

For most research contexts, κ ≥ 0.61 is the acceptable threshold.

---

## Keyboard Shortcuts (Human Coding)

| Key | Action |
|---|---|
| `→` or `J` | Next post |
| `←` or `K` | Previous post |
| Check "Auto-advance" | Automatically move to next post when all dimensions are coded |

---

## AI Coding Tips

- **Provider**: all AI features run through the AI service (see [AI Provider](#ai-provider))
- **Quota**: The AI service gives each key a budget of prompts and tokens per day, week or month. Coding a large dataset uses one prompt per post (more if a post has to be retried), so check your quota before a big run
- **Model selection**: Click "Fetch Models" in Settings to see exactly which models the AI service offers — the lineup can change over time
- **Codebook quality**: Clear, specific code descriptions dramatically improve AI coding accuracy
- **Fine-tuning a code**: If the AI keeps misapplying one specific code, open it in the Codebook and add a note in "AI Fine-Tuning Notes" — e.g. "don't count sarcastic praise as Positive." This is read by the AI on every future coding run but never shown to human coders, so it won't bias manual coding or your reliability comparison
- **Speed (copies at once)**: AI Coding splits the posts between several simultaneous requests to the same model — 4 by default. Change the number in the **at once** box next to **Run AI Coding** or in Settings → AI models (1 = one post at a time; up to `AI_MAX_PARALLEL`, 16 by default). Results appear as each post finishes. If the AI service rate-limits the key, MetaCode halves the number, pauses and retries by itself. Every post still uses one prompt of your quota, so more copies finish sooner but don't cost more
- **Stop and resume**: **Stop** cancels the requests still waiting; run again later to code only the uncoded posts
- **Reasoning**: Click the 💬 button on any AI-coded post to view the model's reasoning

---

## MetaCode Assistant

Click **Ask MetaCode** in the top bar to open a help chat on the right side of the app. Ask it how to use a
page, what a statistic means, or why something isn't working — e.g. "Explain my reliability results" or
"Why is my Network Graph blank?". Suggested questions change with the page you're on. On screens 1440px and
wider the panel sits beside your work; on smaller screens it opens over the right side (press **Esc** or ✕ to close).

**How it works:** the assistant uses the same AI as AI Coding, with the model chosen in Settings and the
key in the server's `.env` — through the same local server, with key rotation. Each question sends the AI service:
- a short reference guide to MetaCode (`public/js/assistant-knowledge.js` — update it when features change);
- a summary of your project's current state — counts, codebook dimension and code names, reliability and
  network statistics, the page you're on, and how many API keys are configured (never the keys themselves,
  and never the text of your posts);
- the last few messages of the conversation.

The conversation lives in memory only: it's cleared when you reload the page or click the clear button.
Each question uses roughly 3,000 tokens of your AI token quota.

---

## AI Provider

Every AI feature — AI Coding, the assistant, column detection in Import Data and Analyze CSV, and Test
Connection — goes through MetaCode's own server to the **AI service**, an OpenAI-compatible AI gateway:

```
browser → POST /api/ai (MetaCode server) → POST https://emis.zxs-is-very.cool/v1/chat/completions
```

Configuration lives only in the server's `.env` file:

| Variable | Required | What it does |
|---|---|---|
| `EMIS_API_KEY` | yes | Your AI key. Several keys can be listed, comma-separated — MetaCode rotates between them |
| `EMIS_BASE_URL` | no | AI service address, default `https://emis.zxs-is-very.cool/v1` |
| `EMIS_MODEL` | no | Default model. If empty: the first model in `emis-models.json` (without that file: `gpt-oss-120b` if the AI service lists it, otherwise the first model the AI service lists) |
| `EMIS_MODELS_FILE` | no | Model list file, default `emis-models.json` in the MetaCode folder |
| `EMIS_TRANSPORT` | no | What sends AI requests: `auto` (default — Python, with the `openai` package when installed, else Node.js), `python` or `node` |
| `EMIS_PROXY` | no | Proxy for AI requests (`HTTPS_PROXY` / `NO_PROXY` are used too) |
| `EMIS_MODEL_SWITCH` | no | `off` stops MetaCode from answering with the closest similar model when the AI service rate-limits the chosen one (on by default) |
| `AI_MAX_PARALLEL` | no | The most copies of the model AI Coding may run at once (default 16, max 64); users choose up to this |
| `AI_BATCH_PAUSE_SECONDS` | no | How long AI Coding first pauses when the AI service answers with a server error (default 5; doubles with each pause, up to 60) |
| `EMIS_TIMEOUT_MS` | no | How long to wait for the AI service (default 120000 ms) |

After changing `.env`, click **Settings → Reload .env** (AI settings apply at once; scraper and port settings
need a restart). MetaCode looks for `.env` next to `server.js`, then in the folder the server was started from,
then in the folder above; `.env.txt` (Windows often adds `.txt`) is accepted, and files saved by Notepad as
"Unicode" (UTF-16) are read correctly. Values in `.env` replace variables of the same name already set in your
system environment (an old system variable is a common reason a new key seems not to load) — Settings and the
startup banner say when that happens.

- **Models.** The model list comes from `emis-models.json` — the AI service's models in OpenCode's config format
  (`provider.emis.models`: id → name, `tool_call`, `reasoning`, `attachment`). To update it, edit the file or
  replace it with a newer OpenCode config from the AI service; changes are picked up without a restart. Only the model
  ids, names and capability flags are read from it — the AI service address and key always come from `.env`. If the
  file is missing, MetaCode asks the AI service for its live list (`GET /v1/models`) instead. The model picked in Settings
  is used when it's listed; otherwise the default above is used (the server log says so). A request that needs
  something a model's flags say it lacks (tool calling, images) is refused with a clear message.
- **Quota.** The AI service reports each key's remaining prompts and tokens with every answer and returns HTTP 429 once
  the budget for the current day, week or month is used up. MetaCode then rests that key until the reset
  time the AI service gave (another key is used if you listed several) and shows a message saying when the quota
  resets. Restarting the server clears this memory.
- **Rate-limited models switch to the closest one.** A 429 while the key still has budget means the AI service is
  throttling that one model. MetaCode then rests just that model (1 minute, doubling while it keeps
  happening, up to 15 — or what `Retry-After` says) and answers with the **closest similar model**: same
  family and line first (Claude Opus → Claude Opus, Qwen Max Thinking → Qwen Max Thinking), then the nearest
  version and size, the same speed tier and capabilities (`model-match.js`). Requests for the resting model go
  straight to the substitute without calling the AI service, and the app says which model answered (AI Coding's summary
  counts the posts coded by a substitute). Up to four similar models are tried per request. If one key gets
  429s on three different models within 20 seconds without quota headers, it's the key being paused, so the
  key rests instead. Turn switching off per browser in Settings → AI models (*If a model is rate-limited, use
  the closest similar model*) or for the whole server with `EMIS_MODEL_SWITCH=off`. A used-up budget applies
  to every model, so switching doesn't help there.
- **Server errors (HTTP 5xx) from the AI service.** Each request is retried twice first. A model that still
  fails rests briefly (30 seconds, doubling while it keeps failing, up to 5 minutes): requests for the server's
  default model go straight to the closest similar model meanwhile (a model you picked is still asked), and
  failing models aren't used as substitutes. When three different models fail within a minute, the AI service
  itself is having problems: MetaCode stops trying other models and says so, and the status page shows the AI
  service as down until an answer comes through. During AI Coding, a server error pauses the run (5 s, then
  10, 20, 40, 60), halves how many posts are coded at once and tries those posts again — the status line says
  so — then speeds back up as answers arrive. Posts that still fail are tried again after 15 and 30 seconds. If
  the AI service keeps failing for about 2 minutes, the run stops instead of sending the rest; click
  **Run AI Coding** again later (coded posts are kept).
- **Security.** The key is sent only to the AI service address in `.env`: never to the browser, never logged,
  never returned by an endpoint or included in an error. The browser can't choose the AI service address or key.
  Other websites open in your browser can't use MetaCode's AI endpoints (they're same-origin only).
- **Settings page.** *AI connection* shows the `.env` file that was read (name, location, encoding), the names
  of the settings in it, warnings, whether AI is ready, and **Reload .env** / **Test connection**. *AI models*
  has a default model plus one per feature — AI Coding, Ask MetaCode, Import Data (column detection) and
  Analyze CSV (edge detection); "Same as default" follows the default. *AI Coding: copies of the model working
  at once* sets how many posts are coded side by side; *If a model is rate-limited, use the closest similar
  model* (on by default) and a list of the models the AI service is rate-limiting right now. *AI keys* lists each key masked, with
  its status and remaining quota.
- **Streaming.** `POST /api/ai` also accepts `"stream": true` (OpenAI request format) and then relays the AI service's
  server-sent events (`chat.completion.chunk` …, then `data: [DONE]`); a failure mid-stream arrives as a
  final `data: {"error": {...}}` event. The current interface doesn't use streaming.

---

## Status Page

`status.metac0.de` shows whether MetaCode is working, in the usual status-page style: an overall state
("All systems operational", "Some systems are degraded", "Partial outage", "Major outage"), each component
with its last 24 hours as 30-minute bars and its uptime, and recent incidents. Components: **MetaCode app**,
**AI service** (reachable, quota, rate-limited models — checked without spending prompts), **Survey publishing
& responses** (storage writable), **Network analysis** (Python/NetworkX) and the **Reddit scraper**. It
refreshes every 30 seconds. Nothing secret is shown — no keys, addresses, paths or error details.

- **Same server, no separate deployment.** MetaCode answers requests for `status.metac0.de` (set another name
  with `STATUS_HOST`; any host starting with `status.` works too) with the status page and its data
  (`GET /api/status`, public, CORS-enabled JSON). Other paths on that host redirect to the main site. The page
  is also at **`/status`** on the main site (linked from the front page's footer), e.g.
  `http://localhost:3000/status` — or `http://status.localhost:3000` to try the subdomain locally.
- **To put it online:** point a DNS record for `status.metac0.de` at the same server as the main site (a
  CNAME to `metac0.de` is enough), include the name in your TLS certificate, and if a reverse proxy sits in
  front of MetaCode, make it pass the original host name (nginx: `proxy_set_header Host $host;`).
- History is kept in memory since the server last started (the page says since when).
- **After updating MetaCode, restart the server** (stop it, then `npm start`). The page's files are served
  straight from disk, but its data (`/api/status`) only exists once the server runs the new code — until then
  the page says *"The status checks aren't running on this server"* (the browser console shows a 404 for
  `api/status`). On a `status.*` host the page also tries the main site's `/api/status`, so it still works if
  the status host is served from somewhere else.

---

## Guided Tour

New to MetaCode? The front page's **Take the guided tour** link, the **Take the tour** button at the bottom
of the sidebar, or `app.html?tour=1` starts a tour: a spotlight moves through every page in workflow order
(Dashboard → Projects → Import → Scraper → Codebook → AI Coding → Human Coding → Reliability → Analyze CSV →
Network → Metrics → Export → Settings) with a card explaining each, then hands over to Survey Studio's tour
(the survey list, then each editor tab — it can make a practice survey to show the editor on). Survey Studio
also has a hands-on tutorial (see [Survey Studio](#survey-studio)). Use → / ←
or the buttons, and Esc to stop. A first visit offers the tour in a small card (once per browser).

---

## All Data is Local — and Private to Each Browser

Your work lives in **your browser**: the open project, posts, codes and settings in localStorage, and
saved projects and Survey Studio surveys in the browser's IndexedDB storage (`public/js/local-db.js`).
Several people can share one MetaCode server without seeing each other's work — each browser gets a
random identity (kept in localStorage and the `mc_owner` cookie), and the few things the server has to
hold belong to that browser only. **Settings → Your data** downloads a backup of everything, and restores
it in another browser or on another computer. Keep backup files private: they include the identity that
manages your published surveys.

Nothing is sent to any server except AI requests to the AI service (for coding, structure detection and assistant questions — they include the
post text being coded) and your own machine's Python process (for NetworkX analysis — this never leaves your
computer). The AI key stays in the server's `.env` file and is only sent to the AI service.

Survey Studio puts a survey on the server only when you publish it: the published versions and their
responses are stored as JSON files (`SURVEY_DATA_DIR`, default `survey-data/`) so respondents on other
devices can answer, and only the browser that published it can see or manage them.

The Reddit Scraper is the exception that reaches out on purpose: when you run a scrape (or open the in-app
Reddit browser), MetaCode's server requests data from Reddit. Scrape results are kept in the server's memory
(visible only to the browser that started the job) until they expire or the server restarts; they only become part of your project (localStorage) when you
click **Add to project**.

To reset everything: Settings → Danger Zone → Reset All Data.

**Upgrading from an older version?** Older versions saved projects (`project-data/`) and surveys on the
server, shared by everyone. Open MetaCode on the computer that runs it (`http://localhost:…`) and the
Projects page and Survey Studio offer to import them into your browser; published survey links and their
responses keep working. Other computers aren't offered them.

---

## File Structure

```
metacode/
├── server.js                  Express server: AI requests to the AI service + Python/NetworkX bridge + scraper wiring
├── package.json
├── requirements.txt            Python dependency (networkx) for the NetworkX feature
├── .env.example                Copy to .env and add your AI key
├── emis-models.json            The AI models offered in Settings (OpenCode config format)
├── collector/                  Reddit Collector: client-side bot over Scramjet (React + Vite + TypeScript) — see collector/README.md
│   ├── src/                    browser/ (Scramjet + bridge), bot/, extract/ (selectors, parsing), store/ (IndexedDB), export/, ui/
│   ├── test/                   Vitest unit tests and Reddit page fixtures
│   └── SCHEMA.md               Record schema and export formats
├── scraper/                    Reddit scraper (server side) — see docs/reddit-scraper.md
│   ├── index.js                /api/scraper routes, SSE, exports, Scramjet file serving
│   ├── config.js               SCRAPER_* / REDDIT_* settings
│   ├── errors.js               Error types and user-facing messages
│   ├── export.js               CSV / JSON / NDJSON
│   ├── network/                Python + epoxy-tls transports, Wisp endpoint, rate limiter, robots.txt, Reddit HTTP client
│   ├── reddit/                 Targets/URL parsing, record formatters, standard scraper
│   ├── jobs/job-manager.js     Job queue, status, logs, results
│   └── sandbox/                Custom code: Pyodide (Python) and QuickJS (JS/TS) sandbox processes, SDKs, runner
├── env-file.js                 Reads .env (encodings, .env.txt, other folders, reload) — see AI Provider
├── status-page.js              Status page (status.metac0.de, /status): checks, history, host routing
├── model-match.js              "Closest model" ranking, used when the AI service rate-limits a model
├── owner.js                    Which browser a request comes from (mc_owner cookie) — published surveys, scraper jobs
├── projects/                   Import of projects older versions saved on the server (this computer only)
├── surveys/                    Survey Studio server side: API routes, publishing, responses, JSON-file store
├── docs/reddit-scraper.md      Reddit API scraper guide
├── docs/deploy-vps.md         Running MetaCode on a server: pm2, nginx, HTTPS, troubleshooting
├── ecosystem.config.cjs        pm2 process file (one process, fork mode)
├── docs/survey-studio.md       Survey Studio guide
├── test/                       node:test suites (+ Playwright browser tests) and a mock Reddit
├── python/
│   ├── network_analysis.py     Reads edges JSON on stdin, runs NetworkX, writes stats JSON on stdout
│   ├── check_env.py            Reports whether NetworkX is installed
│   └── reddit_fetch.py         Scraper's Python HTTPS engine (standard library only)
├── public/
│   ├── index.html                Landing page — explains MetaCode, links to app.html
│   ├── scramjet-sw.js            Service worker for the Scraper's in-app Reddit browser (Scramjet)
│   ├── app.html                  The actual application shell (dashboard, sidebar, etc.)
│   ├── studio.html               Survey Studio (its own page, linked from the front page)
│   ├── status.html               Status page (served for status.metac0.de and at /status); css/status.css, js/status.js
│   ├── survey.html               Respondent page for published surveys (/s/<id>)
│   ├── img/
│   │   ├── metacode-mark.png     Logo mark (used as favicon + sidebar brand)
│   │   └── metacode-wordmark.png Full "METACODE" wordmark (used on the landing page)
│   ├── css/main.css              Design system + component styles
│   ├── css/survey.css            Survey rendering; css/survey-studio.css + survey-blocks.css  Survey Studio editor
│   └── js/
│       ├── app.js               Router, state, modals, notifications, Settings, AI requests (via the server)
│       ├── local-db.js          Your data in this browser (IndexedDB), browser identity, backup/restore
│       ├── tour.js · app-tour.js  Guided tours and hands-on tutorials (spotlight + card); the coding app's tour
│       ├── projects.js          Projects page: saved projects (in the browser), autosave
│       ├── data.js              CSV import for posts/engagement/network (AI-assisted structure detection)
│       ├── codebook.js          Coding scheme management
│       ├── ai-coding.js         Batch AI coding
│       ├── human-coding.js      Manual coding interface
│       ├── reliability.js       Kappa, Alpha, confusion matrices
│       ├── csv-analyzer.js      AI edge detection + NetworkX analysis UI
│       ├── network.js           D3.js network visualization
│       ├── engagement.js        Chart.js charts for the Metrics section
│       ├── collector-view.js    Scraper page: the Reddit Collector in a frame; Add to project (postMessage)
│       ├── scraper.js           Reddit API Scraper page (forms, editor, job progress, results, export)
│       ├── scraper-browser.js   In-app Reddit browser (Scramjet controller + epoxy-transport)
│       ├── survey/              Survey Studio: model, logic engine, renderer, runtime, editor (see docs/survey-studio.md)
│       ├── assistant.js         MetaCode Assistant panel (chat UI, prompt, app-state summary)
│       └── assistant-knowledge.js  What the assistant knows about MetaCode — update when features change
└── sample-data/
    ├── sample-posts.csv
    ├── sample-codebook.csv
    ├── sample-network-nodes.csv
    └── sample-network-edges.csv
```

---

## Citing This Tool

If you use MetaCode in your research, please acknowledge:

> MetaCode Social Media Coding Platform (2024). AI-assisted content analysis with intercoder reliability and NetworkX-based social network analysis.

---

## Troubleshooting

**"AI not set up" in the top bar / the key in `.env` doesn't load**
→ Open **Settings**: *AI connection* says which `.env` file was read and which setting names it found. Put
`EMIS_API_KEY=your-key` in it (one setting per line), save, and click **Reload .env**. If it says no file was
found, the file must be called `.env` (not `.env.example`) next to `server.js`.

**HTTP 502 / "Couldn't reach the AI service" / "The AI service couldn't run the model … (HTTP 502)" / "The AI service is having server problems right now"**
→ An HTTP 502 *from the AI service* (the message says "server error (HTTP 502)") is a problem on the AI
service's side: MetaCode retries, pauses AI Coding and slows it down, and uses a similar model when the
server's default model is the one failing (see *Server errors* above). When several models fail, wait a few
minutes and click **Run AI Coding** again — coded posts are kept; the status page (`/status`) shows when the
AI service is answering again. If a model you picked keeps failing on its own, choose another one in
Settings → AI models. For other 502s: open **Settings → AI connection → Test connection**
to see the exact message. On networks that only allow the internet through a proxy, add
`HTTPS_PROXY=http://proxy:port` (or `EMIS_PROXY`) to `.env` and click **Reload .env** — Node.js doesn't use
the system proxy by itself. If a model you picked keeps failing, choose another one in Settings → AI models.

**Status page: "The status checks aren't running on this server" / 404 for `api/status`**
→ The MetaCode server is still running the version from before the update. Restart it (stop it, then
`npm start`).

**HTTP 403 / "The AI service's website check answered instead of the API"**
→ MetaCode sends AI requests from Python (with the official `openai` package when installed), as the AI service's
documentation does. Install Python 3, run `pip install -r requirements.txt` (adds `openai`), and restart.
**Settings → AI connection** shows what sends the requests ("requests sent by Python … (openai …)"). A 403
that names a model means your key can't use that model: pick another in Settings → AI models.

**"Your AI usage quota … is used up"**
→ The key's AI budget for the current day/week/month is spent; the message says when it resets. Wait until
then, or add another AI key to `EMIS_API_KEY` (comma-separated).

**"The AI service doesn't offer the model …"**
→ In Settings → AI models, pick another model and click "Save model settings" (or set `EMIS_MODEL` in `.env`).
If the model is listed in `emis-models.json` but the AI service no longer serves it, update that file.

**"NetworkX not available" on the Analyze CSV page**
→ Run `pip install -r requirements.txt` (or `pip3 install -r requirements.txt`) in the project folder, then refresh the page

**CSV not importing correctly / posts show blank text**
→ Ensure your file is UTF-8 encoded. If no text-like column is detected and no AI key is set, posts import with blank text by design — set `EMIS_API_KEY` in `.env` to enable AI-assisted column detection

**Network graph not rendering**
→ Check that your nodes CSV has an `id` column and edges CSV has `source` and `target` columns matching node IDs — or use "Analyze CSV" instead, which detects this automatically

**Scraper: "Wisp WebSocket failed to connect: websocket did not open" / "The proxy couldn't fetch the page"**
→ A reverse proxy (nginx, Caddy, Cloudflare) in front of MetaCode isn't forwarding WebSockets to `/wisp/`. The
Scraper falls back to MetaCode's HTTP relay by itself (the line under its browser says so), and `pm2 logs`
says what the proxy is missing. To fix the proxy, see [docs/deploy-vps.md](docs/deploy-vps.md#11-troubleshooting).

**Scraper page: "The scraper isn't built yet"**
→ Run `npm run collector:install && npm run collector:build`, then restart MetaCode (`pm2 reload metacode` on a server).

**Reddit API scraper errors** ("robots.txt doesn't allow…", TLS certificate, 403, 429, sandbox limits)
→ See the troubleshooting table in [docs/reddit-scraper.md](docs/reddit-scraper.md#10-troubleshooting)

**All data disappeared**
→ Check if you're in a private/incognito window (localStorage is cleared on close). Switch to a regular browser window.
