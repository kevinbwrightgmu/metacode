# Running MetaCode on a VPS with pm2

This guide sets up MetaCode on a Linux server (Ubuntu 22.04/24.04 or Debian 12): pm2 keeps it running,
nginx serves it over HTTPS, and the Scraper works through the reverse proxy.

```
Browser ──https──▶ nginx :443 ──http──▶ MetaCode (pm2, port 3000)
          wss://your-site/wisp/  ──▶  MetaCode's own Wisp server (the Scraper's connection to Reddit)
```

**Why the proxy matters for the Scraper.** The Scraper (the Reddit Collector in the sidebar) opens Reddit pages
in your browser through Scramjet. Scramjet reaches Reddit through MetaCode's **own Wisp server** at `/wisp/`.
Wisp runs inside `server.js`, so there is nothing extra to install or run. The browser connects to it with a
**WebSocket**. A reverse proxy that doesn't forward WebSockets causes this error:

```
Hyper client: hyper_util::client::legacy::Error(Connect, WebSocketConnectFailed("websocket did not open"))
(client error (Wisp WebSocket failed to connect: websocket did not open))
```

The nginx setup in [step 6](#6-nginx-and-https) forwards WebSockets correctly. Until the proxy is fixed, the
Scraper falls back to MetaCode's **HTTP relay** (`POST /api/scraper/fetch`), which works through any proxy. The
line under the Reddit browser says which connection is in use. Wisp is faster and handles everything a page
does, so fix the proxy anyway.

Throughout this guide, replace `metac0.de` with your domain and `~/metacode` with where you put MetaCode.

**Already running MetaCode under pm2?** Update it, build the Scraper, and switch to the included pm2 file:

```bash
cd ~/metacode
git pull
npm install
npm run collector:install
npm run collector:build
pm2 ls                           # the name your MetaCode process has
pm2 delete metacode              # that name
pm2 start ecosystem.config.cjs
pm2 save
```

Then compare your reverse proxy with [step 6](#6-nginx-and-https): its three WebSocket lines fix the error
above. Run the checks in [step 9](#9-check-that-it-works).

---

## 1. What you need

- A VPS with at least **1 GB RAM**, and SSH access as a user who can `sudo`.
- A domain whose DNS **A record** points at the VPS: `metac0.de`, plus `www.metac0.de` and `status.metac0.de`
  (the [status page](../README.md#status-page)) if you want them.
- **HTTPS.** The Scraper only works on `https://` (or `http://localhost`), because Scramjet needs a service
  worker and browsers only allow those on secure pages. Opening `http://your-ip:3000` loads MetaCode, but
  the Scraper won't run there.

## 2. Install Node.js 22, pm2 and git

MetaCode's scraper needs **Node.js 22**. Building the Scraper (Vite 7) needs **22.12 or newer**.

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v                  # v22.12.0 or newer
sudo npm install -g pm2
```

If you already use `nvm`, `nvm install 22 && nvm alias default 22` works too. Then install pm2 with
`npm install -g pm2`, without sudo.

## 3. Get MetaCode and build the Scraper

```bash
cd ~
git clone https://github.com/kevinbwrightgmu/metacode.git   # a private repo asks for a GitHub token or SSH key
cd ~/metacode
npm install                     # MetaCode's server
npm run collector:install       # the Scraper's own dependencies (collector/)
npm run collector:build         # builds it into collector/dist; MetaCode serves it at /collector/
```

If you skip the build, the Scraper page shows *"The scraper isn't built yet"* and lists these commands.

**Python** (optional) is used for Analyze CSV (NetworkX), the AI requests and the old scraper's server engine.
Without it, those features fall back or stay off. Ubuntu 23.04+ and Debian 12 don't allow `pip install` into
the system Python, so use a virtual environment in `.venv`. The pm2 file below puts it first on `PATH`.

```bash
sudo apt install -y python3 python3-venv
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 4. Settings (`.env`)

```bash
cp .env.example .env
nano .env
```

Set at least:

```ini
EMIS_API_KEY=your-key                 # the AI key
PORT=3000                             # nginx forwards to this port
PUBLIC_URL=https://metac0.de          # your site's address (several: comma-separated)
SCRAPER_USER_AGENT=nodejs:metacode-scraper:1.0 (by /u/your_reddit_name)
```

`PUBLIC_URL` tells MetaCode which site's pages may open WebSockets to `/wisp/`. It lets the Wisp connection
work even when a proxy hides the original host name. With the nginx config below it isn't strictly needed,
but it does no harm. The other settings are explained in `.env.example`.

## 5. Start it with pm2

The repo includes `ecosystem.config.cjs`, which runs **one** MetaCode process in fork mode. Don't use cluster
mode or `-i max`: running jobs, their live progress and the Wisp connections live in that one process's memory.

```bash
cd ~/metacode
pm2 start ecosystem.config.cjs
pm2 status                       # "metacode" should be "online"
pm2 logs metacode --lines 30     # the startup banner: port, .env, AI status
```

Start it again automatically after a reboot:

```bash
pm2 startup                      # prints a "sudo env PATH=… pm2 startup …" command: run that command
pm2 save                         # remembers the running apps
```

If MetaCode already runs under pm2 with another command (for example `pm2 start server.js --name metacode`),
switch to the file once: `pm2 delete metacode && pm2 start ecosystem.config.cjs && pm2 save`.

Useful commands:

| Command | What it does |
|---|---|
| `pm2 logs metacode` | Live log. MetaCode writes proxy and Wisp hints here (see Troubleshooting). |
| `pm2 reload metacode` | Restart with new code or a changed `.env` |
| `pm2 stop metacode` / `pm2 start metacode` | Stop / start |
| `pm2 monit` | CPU and memory |
| `pm2 install pm2-logrotate` | Keep the log files from growing forever (optional) |

## 6. nginx and HTTPS

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/metacode
```

Paste this file, with your domain in `server_name`:

```nginx
# WebSockets: pass "Connection: upgrade" on only when the browser asked for one.
# (If another site file already defines $connection_upgrade, leave this map out:
#  nginx refuses to load the same variable twice.)
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name metac0.de www.metac0.de status.metac0.de;

    client_max_body_size 25m;            # imports and project uploads (MetaCode accepts up to 10 MB of JSON)

    location / {
        proxy_pass http://127.0.0.1:3000;

        # WebSockets (the Scraper's /wisp/ connection). Without these three lines you get
        # "WebSocketConnectFailed("websocket did not open")".
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # The original host name: used by the WebSocket origin check and the status page (status.metac0.de)
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;

        # Live progress (server-sent events), streamed AI answers and relayed pages arrive as they're sent
        proxy_buffering off;
        proxy_cache off;

        # Scraper sessions and long AI coding runs keep connections open
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable it and get a certificate. Certbot adds the HTTPS server block and the http → https redirect to this
file, and keeps the `location` settings:

```bash
sudo ln -s /etc/nginx/sites-available/metacode /etc/nginx/sites-enabled/metacode
sudo rm -f /etc/nginx/sites-enabled/default        # only if you don't use nginx's default site
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d metac0.de -d www.metac0.de -d status.metac0.de
```

**Using Caddy instead of nginx?** Caddy gets the certificate itself and forwards WebSockets and the host name
by default. The whole `/etc/caddy/Caddyfile` is:

```
metac0.de, www.metac0.de, status.metac0.de {
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

**Using Cloudflare** (orange-cloud proxied DNS)? In the Cloudflare dashboard, turn on **Network → WebSockets**
and set **SSL/TLS → Full (strict)**. With "Flexible", the browser uses https but Cloudflare talks http to
nginx, which causes redirect loops after certbot's redirect.

## 7. A public server: Reddit API keys and limits

If your VPS's IP is blocked by Reddit ("You've been blocked by network security"), the page-based Scraper
can't reach Reddit from it. The **Reddit API scraper** works through Reddit's official API instead.

- **Each user adds their own keys** (Reddit API scraper → Reddit API access → Add your keys). They stay in
  that user's browser, are sent only with their jobs, and give each user their own Reddit API limit (about
  100 requests a minute per app). Nobody can see, change or remove anyone else's keys.
- **Optionally, give the server its own keys** in `.env` (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`,
  `SCRAPER_USER_AGENT`) for users who haven't added theirs. All of them share that one limit. These can't be
  changed from the web.
- Don't register several Reddit apps yourself and spread users across them: that's against Reddit's
  developer terms.
- At most `SCRAPER_MAX_CONCURRENT_JOBS` jobs run at once on the server (default 2, up to 16); others wait
  their turn. With many users bringing their own keys, raise it, e.g. `SCRAPER_MAX_CONCURRENT_JOBS=8`.

## 8. Firewall

Only nginx should be reachable from outside. Port 3000 should stay closed:

```bash
sudo ufw allow OpenSSH            # first, so you don't lock yourself out
sudo ufw allow 'Nginx Full'       # 80 and 443
sudo ufw enable
sudo ufw status
```

If your VPS provider has its own firewall (security groups), allow 22, 80 and 443 there as well.

## 9. Check that it works

From your own computer:

```bash
# The site and the Scraper app
curl -sI https://metac0.de/app.html | head -1            # HTTP/2 200
curl -sI https://metac0.de/collector/ | head -1          # HTTP/2 200 (503 = not built: step 3)

# The Wisp WebSocket through the proxy. Expect "101 Switching Protocols"; then press Ctrl+C or wait 3 s
curl -i --http1.1 --max-time 3 https://metac0.de/wisp/ \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://metac0.de" 2>/dev/null | head -1
```

| You get | Meaning |
|---|---|
| `HTTP/1.1 101 Switching Protocols` | WebSockets reach MetaCode. The Scraper uses Wisp. |
| `426` *"…a reverse proxy is not forwarding WebSockets"* | nginx is missing the `Upgrade`/`Connection` lines, or Cloudflare's WebSockets switch is off |
| `403` | The origin check refused it: add `proxy_set_header Host $host;` or set `PUBLIC_URL` (then `pm2 reload metacode`) |
| `502` / `504` | MetaCode isn't running or isn't on that port: `pm2 status`, `pm2 logs metacode` |

Then open `https://metac0.de/app.html#scraper` and start a small job. The line under the Reddit browser says
*"Connected through Wisp (WebSocket, end-to-end TLS)"* when the WebSocket works. It says *"Connected through
MetaCode's HTTP relay"*, with the reason, when the Scraper had to fall back.

## 10. Updating

```bash
cd ~/metacode
git pull
npm install
npm run collector:install
npm run collector:build
pm2 reload metacode
```

Do the reload when no scraping is running. Jobs of the Reddit API scraper live in the server's memory, and a
Scraper (collector) job running in a browser loses its connection for a moment. Projects, codebooks and
collected Scraper data are stored in each user's browser, so they survive restarts.

## 11. Troubleshooting

**"Wisp WebSocket failed to connect: websocket did not open" / `WebSocketConnectFailed`**
The WebSocket to `/wisp/` doesn't reach MetaCode. Run `pm2 logs metacode` and look for one of these:

- `[wisp] The Wisp endpoint (/wisp/) was requested without a WebSocket upgrade` means nginx forwards the
  request but drops the upgrade. Add the `proxy_http_version 1.1`, `Upgrade` and `Connection` lines and the
  `map` from step 6, then `sudo nginx -t && sudo systemctl reload nginx`. On Cloudflare, also turn on
  WebSockets.
- `[wisp] Refused a WebSocket from https://metac0.de (Host: 127.0.0.1:3000)…` (your own address) means nginx replaces the host name.
  Add `proxy_set_header Host $host;`, or set `PUBLIC_URL=https://metac0.de` in `.env` and
  `pm2 reload metacode`.
- Nothing at all means the request never reached MetaCode. Check that the nginx site is enabled
  (`ls /etc/nginx/sites-enabled`), that `server_name` matches, and that `proxy_pass` uses MetaCode's `PORT`.

While this is broken, the Scraper uses the HTTP relay by itself (**Settings → Connection to Reddit:
Automatic**). "Wisp only" shows the error instead of falling back.

**"You've been blocked by network security" / "Reddit blocked this browser's requests"**
Reddit is blocking your server's IP address, which it often does for data-centre addresses. MetaCode doesn't
work around that. Use the Reddit API scraper with Reddit API keys ([step 7](#7-a-public-server-reddit-api-keys-and-limits)),
or ask Reddit to review the block with the "File a ticket" link on that page.

**The Scraper page says "The scraper isn't built yet" (or `/collector/` answers 503)**
Run `npm run collector:install && npm run collector:build` in `~/metacode`, then `pm2 reload metacode`.

**"Scramjet needs the collector to be opened over https:// or at http://localhost"**
You opened MetaCode over plain http (for example `http://your-ip:3000`). Use the https address from step 6.

**The build fails with "Vite requires Node.js version 20.19+ or 22.12+"**
Update Node.js (step 2). Then check `node -v`. `pm2 reload metacode` keeps using the Node version pm2 started
with, so after a Node.js update run `pm2 update` once.

**A Scraper job stops at once: "robots.txt doesn't allow…"**
Reddit's robots.txt asks automated clients not to crawl. By default (**Settings → robots.txt: Obey**) the
Scraper follows it, so jobs on reddit.com stop before loading a page. "Warn" runs the job and records why.
That is your decision, and you are responsible for Reddit's terms. The **Reddit API scraper** (link at the
top of the Scraper page) uses Reddit's official API with your own API keys instead.

**Serving on a port other than 443, e.g. `https://metac0.de:8443`, and you get "Requests from other websites aren't allowed"**
nginx's `$host` leaves out the port, and MetaCode compares the page's address with the host name it
receives. Use `proxy_set_header Host $http_host;` (which keeps the port) instead of `$host`.

**502 Bad Gateway from nginx**
MetaCode isn't running: `pm2 status`, then `pm2 logs metacode --lines 50` for the reason (a missing
`npm install`, a port in use, a Node.js that's too old).

**Changed `.env` but nothing changed**
AI settings can be reloaded from **Settings → AI connection → Reload .env**. Everything else (`PORT`,
`PUBLIC_URL`, scraper settings) needs `pm2 reload metacode`.
