# YouTube and X in the Scraper

Sidebar → **Scraper** has a platform menu: **Reddit**, **YouTube**,
**X (Twitter)** and **LinkedIn**.

- **Reddit** is the existing scraper ([reddit-scraper.md](reddit-scraper.md)).
- **YouTube and X** collect through each platform's **official API**. Their jobs
  run in the same job system as Reddit's, so the same features apply:
  - progress and logs, pause and resume, durable records;
  - CSV / JSON / NDJSON export and **Add to project**;
  - your plan's scrape limits;
  - the server's network route (direct, proxy or VPN gateway — see
    [scraper-network.md](scraper-network.md)).
- **LinkedIn** isn't offered (see the end of this page).

## YouTube (YouTube Data API v3)

### Keys

Choose one, or both:
- **Server key.** Set `YOUTUBE_API_KEY` in `.env`. Everyone on the server
  shares its quota.
- **Your own key.** Scraper → YouTube → *Use your own YouTube API key*. It is
  kept in your browser and sent only with your jobs; the server never stores
  it.

To get a key:
1. Google Cloud Console → create a project.
2. APIs & Services → Library → enable **YouTube Data API v3**.
3. Credentials → Create credentials → API key. Restrict it to YouTube Data API
   v3, and to your server's IP address if you can.

Keep keys out of chats and repositories. If a key has been shared, delete it
in Google Cloud Console and create a new one.

### What a job can collect

| Choice | What you get | Based on |
|---|---|---|
| **Search videos** | Videos matching a query: sort by relevance, date, views, rating or title; length; published after/before. Optionally oldest first, keeping only titles that contain every word ("oldest videos on a topic") | Sunil02324's top-search-results script; CriticalHunter's *oldest videos on a topic* |
| **Specific videos** | Videos by URL or ID (watch, youtu.be, Shorts, live and embed links), up to 500 | Sunil02324's scrape-by-ID script |
| **A channel** | The channel's details (subscribers, views, video count, country, creation date), optionally its playlists, and its uploads | CriticalHunter's *scrape a channel* |
| **A playlist** | The playlist and its videos | CriticalHunter's *scrape a playlist* |
| **Live chat** | The chat of a stream that is **live now**: messages, Super Chats and Super Stickers (amount, currency, tier), and author flags (owner, moderator, member, verified). Followed until the stream ends or your limits | ohn0's live-chat scraper (see below) |

**Every video record** has:
- title, description, channel, publication time;
- views, likes, comments;
- duration (seconds), definition, captions, tags, category, language;
- live-stream times and concurrent viewers;
- thumbnail URL.

**Options for each video:**
- **Viral score.** Trenblack's Youtube_Viral_data_scraper. The score is
  `0.5 × views ÷ the channel's average views per video + 0.5 × views ÷
  subscribers`, labelled *not viral* (< 1), *does well* (1–2) or *viral* (> 2).
  Channels that hide their subscriber count get no score.
- **Comments.** Top comments or newest first, a number per video, for the first
  N videos. Optionally replies, all of them, not just the few YouTube shows
  inline. Videos with comments turned off are skipped, and the log says so.

**Record shapes.**
- Videos are `post` records with `platform: "youtube"`.
- Comments and chat messages are `comment` records. Chat messages also have
  `source: "live_chat"`.
- The channel and its playlists are `channel` and `playlist` records.

**Add to project** turns videos and comments into project posts. Their likes,
comments and views go to Metrics.

### Quota

Each call costs units of the key's daily quota. The default quota is 10,000
units a day, and Google resets it at midnight Pacific time.

| Call | Cost |
|---|---|
| Search page | 100 |
| Videos, channels, playlists, comments (per page of up to 50–100) | 1 |
| Live chat poll | counted as 5 in MetaCode (an estimate) |

How MetaCode handles quota:
- **Estimate before starting.** The form shows an estimate.
- **Per-job budget.** Each job has a quota budget (default 2,000). The job
  stops cleanly at its budget and keeps what it collected.
- **Server key meter.** The server's key is metered per Pacific-time day
  (`YOUTUBE_DAILY_QUOTA`, default 10,000). The meter is in memory, so a restart
  resets it.
- **Quota used up.** When Google answers "quota exceeded", the job stops with
  that reason. It doesn't retry.

### Limits of the API

- **Replays of a past stream's chat.** YouTube's API serves a live chat only
  while the stream is live, so a replay's chat can't be collected. ohn0's
  scraper reads replays from youtube.com's internal pages (`/live_chat_replay`,
  `/youtubei/…`). Those aren't an API, and YouTube's terms of service allow
  automated access only through its API or with YouTube's written permission,
  so MetaCode doesn't do this.
- **Custom channel URLs** (`youtube.com/c/…`) can't be looked up. Use the
  channel's @handle or `youtube.com/channel/UC…` address instead.
- **Search size.** A search returns about 500 results at most.
- **Not reworked from CriticalHunter:**
  - Its watch-history features (Google Takeout import, most watched, early
    viewed).
  - Its video download list: downloading videos isn't permitted by YouTube's
    terms.

## X (Twitter) — X API v2

### Token

Choose one, or both:
- **Server token.** Set `X_BEARER_TOKEN` in `.env`.
- **Your own token.** Scraper → X → *Use your own X API bearer token*. It is
  kept in your browser only.

To get a token: in developer.x.com, open your Project's App → Keys and tokens
→ Bearer Token.

Reading posts needs an X API plan that includes search, and X bills for it.
Recent search covers the last 7 days. Full-archive search needs a higher plan.
If the plan doesn't include an endpoint, the job stops and says so.

### What a job can collect

| Choice | What you get |
|---|---|
| **Search posts** | X's search operators work (`from:`, `lang:`, `-is:retweet`, `has:links` …). **Latest** (recency) or **Top** (relevance), a date range, optionally the full archive |
| **A user's posts** | A user's recent posts, optionally without replies and/or reposts |
| **Specific posts** | Posts by URL or ID, up to 1,000 |

**Every post record** has:
- the fields israel-dryer/Twitter-Scraper collected: name, handle, date, text,
  replies, reposts, likes;
- quotes, bookmarks, and views when X reports them;
- language, conversation ID, reply-to and quote IDs, whether it is a repost;
- hashtags, mentions and links;
- the author's verified flag and follower count;
- the post's URL.

**Not ported:** israel-dryer's scraper logs in to x.com with a username and
password and scrolls the search page in a browser. That approach:
- is against X's terms;
- would need users' X passwords on the server;
- stops at X's login checks;
- breaks whenever x.com changes.

The official API gives the same fields reliably.

## LinkedIn

LinkedIn isn't offered.
- **No API.** It has no API for reading other people's profiles or posts.
- **Terms.** Its User Agreement forbids automated collection behind its login.
- **How existing tools work.** Tools that scrape profiles, such as the
  linked linkedin-profile-scraper-api, run a headless browser on someone's
  logged-in session (their `li_at` cookie), and LinkedIn restricts accounts for
  it.

If you have LinkedIn posts in a spreadsheet, for example your own posts from
LinkedIn's *Get a copy of your data*, use **Import Data**.

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `YOUTUBE_API_KEY` | — | The server's YouTube key (**secret**) |
| `YOUTUBE_DAILY_QUOTA` | 10000 | The server key's daily quota, for MetaCode's meter |
| `YOUTUBE_ENABLED` | true | Turns YouTube off when false |
| `YOUTUBE_MIN_DELAY_MS` | 250 | Minimum gap between two YouTube requests |
| `X_BEARER_TOKEN` | — | The server's X bearer token (**secret**) |
| `X_ENABLED` | true | Turns X off when false |
| `X_MIN_DELAY_MS` | 1000 | Minimum gap between two X requests |

## API

These platforms use the scraper API, with `POST /api/scraper/jobs` and
`mode: "platform"`:

```json
{ "mode": "platform", "platform": "youtube",
  "target": { "type": "channel", "channel": "@handle" },
  "options": { "maxVideos": 50, "viral": true, "includeComments": true, "commentVideos": 10, "commentsPerVideo": 100, "quotaBudget": 2000 },
  "youtubeApiKey": "optional: your own key" }
```

```json
{ "mode": "platform", "platform": "x",
  "target": { "type": "search", "query": "climate lang:en", "sort": "latest" },
  "options": { "maxPosts": 500 },
  "xBearerToken": "optional: your own token" }
```

The rest is the same as for Reddit jobs: job status, events, results, export,
pause and resume. Resuming a job that used your own key needs the key again.

## What was verified

- **Covered by tests.** Requests, paging, records, quota accounting, error
  handling, own keys staying off disk, and routing through the VPN gateway.
  They are tested against local stand-ins for the YouTube Data API and the X
  API (`test/platforms.test.js`, `test/platforms-e2e.test.js`).
- **Not verified.** The stand-ins can't show what Google and X answer today,
  and live calls weren't possible from the development environment. The
  endpoints, parameters and error reasons follow the two APIs' documentation.
  Run one small job of each kind after deploying.
