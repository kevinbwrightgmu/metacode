# Scraper reliability: network providers, circuit breaker and durable jobs

This covers the layer under the Reddit Scraper and the AI Scraper (beta): how
requests leave the server, what happens when they fail, and how jobs survive a
restart. For using the scraper itself, see [reddit-scraper.md](reddit-scraper.md).

What this layer does **not** do: it does not get around Reddit's bans, rate
limits, logins, CAPTCHAs or blocks. It does not rotate IP addresses or
identities. When Reddit refuses access (HTTP 401/403, a private or banned
community, robots.txt), the job stops and says why. When Reddit asks the
scraper to slow down (HTTP 429, `Retry-After`, `X-Ratelimit-*`), it waits for as
long as it was asked to.

## 1. How a request travels

```
standard scraper / AI agent / custom code
  → RedditHttpClient.request()         scraper/network/reddit-http.js
       destination allow-list · robots.txt · shared per-host rate limiter ·
       bounded retries (≤ 5, exponential backoff with jitter, Retry-After) ·
       manual redirects, each hop re-checked
  → NetworkManager.request()           scraper/network/network-manager.js
       picks the provider · circuit breaker · request id · metrics
  → provider.request()                 scraper/network/providers.js
       direct (Python worker or epoxy-tls) | HTTP(S) proxy | VPN gateway
```

How each outcome is handled:

| Response or failure | Handling |
|---|---|
| Connection timeout, DNS or connection failure, proxy error | Retried within the request's retry limit (default 2, at most 5) with backoff; counts against the route's circuit breaker |
| HTTP 429 | The host is paused for `Retry-After` / `X-Ratelimit-Reset` (at most 5 min), then retried within the limit |
| HTTP 401 | Stops; reported as an authentication problem (OAuth tokens are refreshed once first) |
| HTTP 403 | Stops; reported as denied access (block page, private, quarantined, premium-only) |
| HTTP 404 | Reported as a missing subreddit, user or post |
| HTTP 5xx | Retried within the limit; counts against the circuit breaker |
| Unreadable answer (HTML instead of JSON, bad listing) | Reported as a parsing failure |
| Destination not on the allow-list | Refused before anything is sent |

## 2. Network providers

| Provider | When it exists | Capabilities |
|---|---|---|
| `direct` | always | This server's own connection: the Python standard-library worker, or epoxy-tls over Wisp. Connects to the address it checked; rejects private addresses; verifies TLS |
| `proxy` | `SCRAPER_PROXY_URL` is set | An HTTP or HTTPS proxy (`CONNECT` tunnel; TLS stays end to end). The proxy resolves host names |
| `vpn-gateway` | `SCRAPER_VPN_GATEWAY_PROXY_URL` is set | A separately managed VPN gateway that exposes an HTTP proxy. Optional status URL, checked every minute; when it reports the tunnel down, requests stop (fail closed) |

SOCKS proxies are not offered: the HTTP client MetaCode uses (undici 6) can't
tunnel through them. A `socks5://` URL is reported as a configuration problem
rather than silently ignored.

Only the server administrator configures providers, in `.env`. Nothing a user
sends can add a route or change where one points. Ordinary users see which
route is in use and whether it works; administrators see more (below). Nobody
sees credentials.

### Settings

| Variable | Required | Format | Default | Secret |
|---|---|---|---|---|
| `SCRAPER_NETWORK_PROVIDERS` | no | comma list of `direct`, `proxy`, `vpn-gateway` (at most 3, in order of preference) | `direct` | no |
| `SCRAPER_NETWORK_FAILOVER` | no | `on` / `off` | `off` | no |
| `SCRAPER_PROXY_URL` | for `proxy` | `http://[user:pass@]host:port` or `https://…` | — | **yes** (may hold credentials) |
| `SCRAPER_VPN_GATEWAY_PROXY_URL` | for `vpn-gateway` | as above | — | **yes** |
| `SCRAPER_VPN_GATEWAY_HEALTH_URL` | no | `http(s)://host:port/path`; healthy on 2xx, and if it answers JSON with a `status`, that status must be `running`, `connected`, `up`, `ok` or `healthy` | — | no |
| `SCRAPER_CIRCUIT_FAILURES` | no | 1–100 | `5` | no |
| `SCRAPER_CIRCUIT_COOLDOWN_SECONDS` | no | 1–3600 | `30` | no |
| `SCRAPER_CIRCUIT_MAX_COOLDOWN_SECONDS` | no | 1–21600 | `300` | no |

**Failover.** Off by default: when the preferred route is down, collection
pauses. With `SCRAPER_NETWORK_FAILOVER=on`, requests use the next provider in
`SCRAPER_NETWORK_PROVIDERS` *only while an earlier one's circuit is open*, and
return to it as soon as it recovers. Failover is never triggered by Reddit
refusing or rate-limiting a request — only by the route itself failing — and
never goes beyond the administrator's list. Turn it on only if every route in
the list is one you are allowed to collect from.

## 3. Circuit breaker

One per provider (`scraper/network/circuit-breaker.js`).

- **Closed** — requests flow.
- **Open** — after `SCRAPER_CIRCUIT_FAILURES` route failures in a row
  (timeouts, connection/DNS/TLS/proxy errors, HTTP 5xx), requests are refused
  at once with the time of the next attempt, for `SCRAPER_CIRCUIT_COOLDOWN_SECONDS`.
- **Half-open** — one probe request is let through: success closes the
  circuit; failure opens it again with a doubled cooldown (up to the maximum).

HTTP 401/403/404/429 are answers — the route works — so they never open the
circuit. A failing VPN-gateway health check holds the gateway's circuit open
until the gateway reports healthy again.

## 4. Durable jobs

Jobs are kept under `SCRAPER_DATA_DIR` (default `scraper-data/`, not committed):

```
scraper-data/jobs/<job id>/
  job.json        configuration snapshot, status, progress, checkpoint (never credentials)
  records.ndjson  collected records, appended and fsync'ed page by page
  events.ndjson   status changes, waits, checkpoints, errors (no content)
  lease           which server process runs the job, renewed every 20 s
```

### States

```
queued  → running | paused | cancelled
running → completed | failed | cancelled | waiting | paused | queued (restart)
waiting → queued | paused | cancelled | failed
paused  → queued (resume) | cancelled
```

- **waiting** — a temporary failure (route down, persistent 429, Reddit 5xx,
  network) after the request-level retries. The job retries at `retryAt` — the
  circuit's or Reddit's time, else 30 s, 60 s, 120 s … — at most
  `SCRAPER_MAX_JOB_WAITS` times and `SCRAPER_MAX_JOB_WAIT_MINUTES` in total,
  then it is **paused** (never retried forever). Access denials are never waited out.
- **paused** — by the user, or after the automatic retries. **Resume**
  continues from the last checkpoint with a fresh allowance of retries.
- Only **standard scrapes** can wait, pause and resume; they have checkpoints.
  Custom-code and AI jobs can't be resumed part-way: a temporary failure fails
  them, and a restart ends them as *interrupted* with what they collected kept.

### Checkpoints

After each page, the standard scraper records where to continue (the listing,
the sort when sweeping sorts, Reddit's `after` cursor, comment threads done).
The checkpoint is written **after** that page's records are on disk, so a
crash can only make a resumed job read one page again — those records are
dropped by their Reddit id. Listings change between runs; a resumed listing
can miss items that moved across the cursor. That can't be detected from the
listing and is a known limitation.

### Restarts

On start, the server reloads saved jobs:

- standard scrapes that were queued, running or waiting continue from their
  checkpoint;
- jobs that used the user's **own API keys** (never stored on the server) or
  the user's **browser** wait as paused until the user presses Resume;
- custom-code and AI jobs end as failed (`interrupted`), records kept.

`pm2 reload metacode` stops running standard scrapes cleanly (left queued) and
they continue after the restart.

### Incremental collection

`options.since` (unix seconds or a date) keeps only items posted after it; a
listing sorted by **new** stops at the first older item. On the Scraper page,
**Collect newer items** on a finished job sorted by new starts a job for the
same listing from its newest item.

### Backpressure and retention

| Variable | Default | Meaning |
|---|---|---|
| `SCRAPER_PERSIST_JOBS` | `true` | `false` keeps jobs in memory only (as before) |
| `SCRAPER_DATA_DIR` | `scraper-data/` | Where jobs are kept |
| `SCRAPER_MAX_QUEUED_JOBS` | `20` | Jobs waiting to start, server-wide; more → `503 queue_full` with `Retry-After` |
| `SCRAPER_MAX_DISK_MB` | `2048` | Job storage limit; oldest finished jobs are removed first, then new jobs are refused (`storage_full`) |
| `SCRAPER_JOB_RETENTION_MINUTES` | `120` | Finished jobs (and their files) are deleted after this |
| `SCRAPER_PAUSED_RETENTION_HOURS` | `24` | Paused jobs left alone this long are cancelled |
| `SCRAPER_MAX_JOB_WAITS` | `6` | Automatic retries of a job (0 = fail at once, as before) |
| `SCRAPER_MAX_JOB_WAIT_MINUTES` | `30` | Longest total wait before pausing |

Plan limits (accounts/) still apply: paused jobs don't count against "jobs at
once"; resuming checks the plan again (an expired subscription can't resume).

## 5. API

| Route | Who | What |
|---|---|---|
| `POST /api/scraper/jobs/:id/pause` | job owner | Pause (standard scrapes) |
| `POST /api/scraper/jobs/:id/resume` | job owner | Resume a paused or waiting job; body may carry `credentials` / `redditApisKey` again |
| `PATCH /api/scraper/jobs/:id` | job owner | Paused jobs: `delayMs` (≥ the floor), `maxItems` / `maxPages` (lower only) |
| `GET /api/scraper/jobs/:id/summary` | job owner | Items by type, time range, top subreddits, requests ok/failed/retries, checkpoint |
| `GET /api/scraper/jobs/:id/history?offset&limit` | job owner | Recorded events |
| `GET /api/scraper/jobs?limit&before` | owner's jobs | Paged list (`next` = cursor) |
| `GET /api/scraper/network` | anyone allowed to scrape | Route label, state, circuit, retry time, capabilities |
| `GET /api/scraper/admin/network` | administrators | Providers (proxy shown as `scheme://host:port`), circuits, request metrics (outcomes, latency p50/p95, timeouts, 429s, active), health checks, queue health, disk use |
| `POST /api/scraper/admin/network/:id/check` · `/reset` | administrators | Run a gateway health check now · close a circuit |

Other users' jobs answer `404` on every route. Administrators are accounts whose
verified email is in `ADMIN_EMAILS` (see [accounts.md](accounts.md)); being one
grants no plan and no access to other people's jobs.

## 6. Running a VPN gateway

**The quick way:** `deploy/vpn-gateway/` has a ready-made gateway: gluetun +
Mullvad over WireGuard in a container on the same server, with a setup script
that prints the `.env` lines. Its [README](../deploy/vpn-gateway/README.md)
walks through the whole setup and the common problems.

Don't install a VPN client (Mullvad's app or any other) directly on the
machine that serves the website. It takes over the host's routing and
firewall (see [architecture-map.md](architecture-map.md) §5). Run the VPN as a
**separate gateway** that MetaCode reaches as an HTTP proxy. That can be the
kit's container, another host, or a VM:

1. **Run the gateway** in its own network namespace. It needs `NET_ADMIN`
   (and usually `/dev/net/tun`) *on its side*; MetaCode needs no extra
   privileges.
2. **Lock down the proxy.** Make it reachable from MetaCode only (bind it to
   127.0.0.1 or a private interface, and firewall it), and give it a password.
3. **In MetaCode's `.env`:**
   ```
   SCRAPER_VPN_GATEWAY_PROXY_URL=http://user:password@127.0.0.1:8888
   SCRAPER_VPN_GATEWAY_HEALTH_URL=http://127.0.0.1:8000/v1/vpn/status
   SCRAPER_VPN_GATEWAY_IP_URL=http://127.0.0.1:8000/v1/publicip/ip
   SCRAPER_VPN_GATEWAY_HEALTH_API_KEY=…
   ```
   Then run `pm2 reload metacode`.
   - **Default route.** A configured gateway is used by default. You only need
     `SCRAPER_NETWORK_PROVIDERS` to choose a different order, for example
     `vpn-gateway,direct` together with `SCRAPER_NETWORK_FAILOVER=on`. If that
     setting is present but leaves out a configured gateway, Network
     diagnostics shows a warning.
   - **Protected status page.** gluetun v3.40 and later protect its status
     routes. Send the key from its auth file
     (`SCRAPER_VPN_GATEWAY_HEALTH_API_KEY`, sent as `X-API-Key`), or put
     `user:password` in the URL for basic auth.
   - **What a failed status check does.** A status endpoint that refuses
     MetaCode (401/403) or doesn't exist (404) is reported as a configuration
     problem and does not stop traffic. A gateway that is unreachable, or one
     that reports its tunnel down, stops traffic: jobs wait instead of using
     the direct route.
4. **Verify** as an administrator (`ADMIN_EMAILS`). Open Scraper page →
   **Network diagnostics**:
   - the gateway is listed as healthy, with its exit address;
   - **Test route** sends one request to reddit.com/robots.txt through it and
     says what came back.

   Then stop the tunnel. The gateway should turn *unavailable*, and jobs should
   wait.

**Who owns what.** The gateway's operator manages its software, VPN account,
credentials and updates. MetaCode only uses the proxy and reads the status
URLs.

**What a VPN does and doesn't do.** It changes the route and the address
requests come from. It doesn't make Reddit accept them: a 403 through the
gateway means Reddit refuses that address, and MetaCode doesn't cycle through
addresses to get past it. The VPN provider's own terms may restrict automated
traffic, so check them.

**Verified.**
- The provider code is tested against a local `CONNECT` proxy and a mock
  status endpoint, with and without its API key (`test/scraper-durable.test.js`).
- The kit's setting names, routes and header were checked against gluetun's
  source.

**Not verified.** It wasn't run against a live VPN here.

## 7. Recovery procedures

| Situation | What to do |
|---|---|
| Jobs stuck in *waiting* | Check **Network diagnostics**: an open circuit shows when it retries. Fix the route (gateway, proxy, internet), then **Close circuit** or wait for the probe |
| A job paused after automatic retries | Fix the cause shown on the job, then **Resume** |
| Invalid network configuration | The Settings status and diagnostics list the problem; jobs fail with `network_misconfigured` rather than silently using another route. Fix `.env`, `pm2 reload metacode` |
| Rotating proxy/gateway credentials | Change the URL in `.env`, `pm2 reload metacode` (running standard scrapes continue from their checkpoints) |
| Worker crashed / server killed | Start it again: saved jobs are reloaded (§4). A job whose lease is still held by another *live* process is left to it |
| Disk full (`storage_full`) | Delete finished jobs, lower `SCRAPER_JOB_RETENTION_MINUTES`, or raise `SCRAPER_MAX_DISK_MB` |
| Corrupted job folder | It is skipped at start (counted in the log line `jobs.recovered … skipped=N`); delete that folder |

MetaCode is one process (pm2 `fork` mode). Two processes must not share
`SCRAPER_DATA_DIR` as a way of scaling: the lease only stops them running the
same job twice; each would still keep its own in-memory queue.
