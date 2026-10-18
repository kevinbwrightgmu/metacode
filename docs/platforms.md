# YouTube, X and LinkedIn in the Scraper

Sidebar → **Scraper** has a platform menu: **Reddit**, **YouTube**,
**X (Twitter)** and **LinkedIn**.

- **Reddit** is the existing scraper ([reddit-scraper.md](reddit-scraper.md)).
- **YouTube, X and LinkedIn** collect through each platform's **official API**
  (LinkedIn also imports your own data archive). Their jobs run in the same job
  system as Reddit's, so the same features apply:
  - progress and logs, pause and resume, durable records;
  - CSV / JSON / NDJSON export and **Add to project**;
  - your plan's scrape limits;
  - the server's network route (direct, proxy or VPN gateway — see
    [scraper-network.md](scraper-network.md)).

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
| **Live chat** | The chat of a stream that is **live now**, from the stream's link or from a channel (`youtube.com/@name/live` or `@name`: the job looks for a live stream among the channel's newest 50 uploads, and runs YouTube's live search, 100 units, only if none is there; with several streams live it follows the most-watched one and logs the others). You get messages, Super Chats and Super Stickers (amount, currency, tier), and author flags (owner, moderator, member, verified). The job follows the chat until the stream or chat ends or your limits are reached. Members-only and restricted chats are refused with the reason | ohn0's live-chat scraper (see below) |

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

LinkedIn has no API for reading just anyone's profile or posts. The Scraper
offers the two ways LinkedIn does allow:

| Choice | What you get | Needs |
|---|---|---|
| **Pages you manage** | The LinkedIn Pages the token's member helps manage: name, address, website, follower count, your role(s) | An access token |
| **A Page's posts** | A Page's posts, newest first (or recently edited first): text, date, kind (text, article, images, video, poll, repost), article link, poll options, visibility, reactions by type (Like, Celebrate, Love, Insightful, Support, Funny), comment count. Optionally impressions, unique impressions, clicks, reposts and engagement rate, and the comments of the first N posts (text, date, likes, replies) | An access token from a member who is an admin of the Page |
| **Your LinkedIn data archive** | Your own posts, comments, reactions and reposts, from LinkedIn's *Get a copy of your data* | Nothing: no token, no request to LinkedIn |

### Access token (Pages and their posts)

LinkedIn's Community Management API serves these. Choose one, or both:
- **Server token.** Set `LINKEDIN_ACCESS_TOKEN` in `.env`. Jobs then read the
  Pages that token's member manages.
- **Your own token.** Scraper → LinkedIn → *Use your own LinkedIn access token*.
  It is kept in your browser and sent only with your jobs.

To get a token:
1. LinkedIn Developer Portal (developer.linkedin.com) → **Create app**, linked
   to a LinkedIn Page you are an admin of. Verify the app with the Page.
2. Products → request the **Community Management API**. LinkedIn reviews the
   request, and it must be the only product on the app.
3. Docs and tools → **OAuth Token Tools** → Create token. Pick the app, tick the
   scopes it offers that start with `r_organization` or `rw_organization`, sign
   in and copy the token. Tokens last 60 days; then make a new one.

What a token can read:
- **Posts** need `r_organization_social`.
- **Statistics** (impressions, clicks…) need `rw_organization_admin` or
  `r_organization_admin` and an admin or analyst role on the Page. Without
  them, the job collects the posts and logs that statistics were left out.
- **Commenters** are LinkedIn member IDs (`urn:li:person:…`), not names: the API
  doesn't give other members' names. The Page's own comments are named.

**Requests.** They follow LinkedIn's own client library
([linkedin-developers/linkedin-api-js-client](https://github.com/linkedin-developers/linkedin-api-js-client)):
- the versioned API (`https://api.linkedin.com/rest`);
- Rest.li protocol 2.0.0 and its URN encoding;
- a `LinkedIn-Version` header.

**API version.** LinkedIn retires API versions after about a year. MetaCode
starts at last month's version. If LinkedIn doesn't serve a version, MetaCode
steps back a month at a time, for up to six months, and later jobs reuse the
version that worked. To pin one, set `LINKEDIN_API_VERSION=YYYYMM`.

**Errors.** An expired or revoked token, a missing permission, an unknown Page
and LinkedIn's daily limits (HTTP 429, reset at midnight UTC) each stop the
job with what to do.

### Your data archive

1. linkedin.com → **Me** → Settings & Privacy → Data privacy → **Get a copy of
   your data**.
2. Choose *Want something in particular?* and tick **Posts**, **Comments** and
   **Reactions**, plus **Profile** for your name. Then press *Request archive*.
   LinkedIn emails a download link, usually within minutes; the full archive
   takes up to a day.
3. Scraper → LinkedIn → *Your LinkedIn data archive*. Choose the .zip, or the
   CSV files in it, and press **Import archive**.

What the import does:
- **Reading happens in your browser.** It unzips the archive and sends only
  `Shares.csv`, `Comments.csv`, `Reactions.csv` and `InstantReposts.csv`, plus
  your first and last name from `Profile.csv`. Messages, connections and
  everything else stay on your computer.
- **Choose what to import.** Your posts, your comments, and/or your reactions
  and reposts (reactions have no text). You can limit it to a date range.
- **The server keeps the records, not the files.** The uploaded tables are held
  in memory for the import only. If the import is interrupted, start a new one.
- **Records.**
  - Posts and comments are `post` and `comment` records with
    `source: "archive"`; you are their author.
  - Reactions and reposts are `reaction` records (`reaction_type`, the post's
    link).

### Why MetaCode doesn't log in to linkedin.com

Some tools on GitHub read LinkedIn by logging in as a member, for example the
linkedin-profile-scraper-api, joeyism/linkedin_scraper and tomquirk/linkedin-api.
They use a password or the `li_at` session cookie and read linkedin.com's pages
or its internal API. MetaCode doesn't, for these reasons:
- **Terms.** LinkedIn's User Agreement forbids it.
- **robots.txt.** It disallows automated access.
- **Account risk.** LinkedIn restricts the accounts used.
- **It would mean getting around LinkedIn's checks.** From a server, these tools
  meet LinkedIn's login and bot checks. Getting past them is what this
  project's rules exclude.

**Records.** LinkedIn records have `platform: "linkedin"`:
- posts are `post` records;
- comments are `comment` records;
- Pages are `page` records.

Add to project turns posts and comments into project posts. Their reactions,
comments, reposts and impressions go to Metrics.

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
| `LINKEDIN_ACCESS_TOKEN` | — | The server's LinkedIn access token (**secret**) |
| `LINKEDIN_API_VERSION` | last month | The LinkedIn API version (`YYYYMM`); steps back when inactive |
| `LINKEDIN_ENABLED` | true | Turns LinkedIn off when false |
| `LINKEDIN_MIN_DELAY_MS` | 500 | Minimum gap between two LinkedIn requests |

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

```json
{ "mode": "platform", "platform": "linkedin",
  "target": { "type": "posts", "organization": "https://www.linkedin.com/company/acme/" },
  "options": { "maxPosts": 200, "includeStats": true, "includeComments": true, "commentPosts": 20, "commentsPerPost": 100 },
  "linkedinAccessToken": "optional: your own token" }
```

```json
{ "mode": "platform", "platform": "linkedin",
  "target": { "type": "archive", "files": [{ "name": "Shares.csv", "text": "Date,ShareLink,ShareCommentary,…" }] },
  "options": { "posts": true, "comments": true, "reactions": false, "since": "2024-01-01", "until": null } }
```

The rest is the same as for Reddit jobs: job status, events, results, export,
pause and resume. Resuming a job that used your own key needs the key again.

## What was verified

- **Covered by tests.** Requests, paging, records, quota accounting, error
  handling, own keys staying off disk, and routing through the VPN gateway.
  They are tested against local stand-ins for the YouTube Data API, the X API
  and LinkedIn's REST API (`test/platforms.test.js`,
  `test/platforms-e2e.test.js`).
  - The LinkedIn stand-in insists on what LinkedIn does: the Rest.li headers, an
    active version and encoded URNs.
  - The archive import is tested in a browser with a .zip, including that
    messages, connections and the rest of `Profile.csv` aren't sent.
- **Verified against the real API.** YouTube live chat was run against the real
  YouTube API with a real key.
- **Not verified live.**
  - The stand-ins can't show what X and LinkedIn answer today: live calls to
    them weren't possible from the development environment.
  - The LinkedIn endpoints and parameters follow LinkedIn's documentation and
    its official client library.
  - The archive's file and column names follow LinkedIn's export as of 2025.
- **After deploying.** Run one small job of each kind.
