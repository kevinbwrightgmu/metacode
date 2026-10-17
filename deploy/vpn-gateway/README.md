# VPN gateway for the scraper

This kit runs a VPN client, [gluetun](https://github.com/qdm12/gluetun), in its
own Docker container. The scraper sends its requests through the HTTP proxy that
gluetun opens. Mullvad over WireGuard is set up by default; gluetun supports many
other providers through `vpn.env`.

**Why a container?** A VPN client installed on the server itself (Mullvad's app,
`wg-quick`, OpenVPN) takes over the machine's routing and firewall, so the
website's own traffic would go through the VPN too. Inside this container, the
VPN only carries what MetaCode sends to its proxy:
- `NET_ADMIN` and `/dev/net/tun` apply inside the container only;
- the website keeps its normal connection;
- MetaCode itself needs no extra privileges.

## Setup on the VPS (Ubuntu)

1. **Install Docker**, once:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2
   sudo usermod -aG docker $USER    # then log out and back in
   ```
2. **Get a WireGuard key from Mullvad.** Go to your account page → WireGuard
   configuration → generate a key → download any config file. You need its
   `PrivateKey` and the IPv4 part of its `Address` (e.g. `10.64.12.34/32`).
3. **Prepare the gateway:**
   ```bash
   cd ~/metacode/deploy/vpn-gateway
   ./setup.sh
   ```
   The script writes:
   - `vpn.env` — your key and a random proxy password;
   - `gluetun/auth/config.toml` — a random API key that lets MetaCode read the
     tunnel status.

   Both files are readable by you only and are ignored by git. The script then
   prints four lines for MetaCode's `.env`.
4. **Start the gateway:**
   ```bash
   docker compose up -d
   docker logs -f metacode-vpn     # wait for "Public IP address is …", then Ctrl+C
   ```
5. **Connect MetaCode.** Paste the four lines into `~/metacode/.env`:
   ```ini
   SCRAPER_VPN_GATEWAY_PROXY_URL=http://metacode:<password>@127.0.0.1:8888
   SCRAPER_VPN_GATEWAY_HEALTH_URL=http://127.0.0.1:8000/v1/vpn/status
   SCRAPER_VPN_GATEWAY_IP_URL=http://127.0.0.1:8000/v1/publicip/ip
   SCRAPER_VPN_GATEWAY_HEALTH_API_KEY=<api key>
   ```
   Then reload:
   ```bash
   pm2 reload metacode
   ```
   You don't need `SCRAPER_NETWORK_PROVIDERS`: a configured gateway is used
   automatically. The log line `[scraper] Network route: VPN gateway …`
   confirms it.
6. **Check that it works.** To see the diagnostics, you need to be an
   administrator: add your email to `ADMIN_EMAILS` in `.env`. Then:
   - open Scraper → **Network diagnostics**;
   - the VPN gateway row should show **healthy**, with the exit address and
     country;
   - press **Test route** to send one request to reddit.com through the tunnel.

## When it doesn't work

| What you see | Cause and fix |
|---|---|
| Nothing changes after adding the lines | `pm2 reload metacode` wasn't run, or `SCRAPER_NETWORK_PROVIDERS` is set to something that doesn't list `vpn-gateway`. Diagnostics shows a warning in that case. Remove the setting or add `vpn-gateway` to it |
| "status endpoint refused MetaCode (HTTP 401)" | The API key in `.env` doesn't match `gluetun/auth/config.toml`, or that file is missing. After editing the file: `docker compose restart` |
| "status endpoint couldn't be reached" / route "unavailable" | The container isn't running. Run `docker ps` and `docker logs metacode-vpn`. Most often the WireGuard key or address is wrong, or the key was revoked in your Mullvad account |
| "reports its tunnel as stopped" | gluetun is up but its VPN isn't. See `docker logs metacode-vpn` |
| Test route: "Couldn't reach the VPN gateway" | Nothing listens on 127.0.0.1:8888. Check that `HTTPPROXY` is on (it is in `docker-compose.yml`) and that the container is up |
| Test route: "refused this address (HTTP 403)" | The tunnel works, but Reddit blocks that exit address. A VPN changes where requests come from; it doesn't make a site accept them. MetaCode doesn't cycle through addresses to get around a refusal. Add Reddit API keys, or pick another exit with `SERVER_COUNTRIES` in `vpn.env` and `docker compose up -d` |
| gluetun log: route not valid | An old gluetun image. Run `docker compose pull && docker compose up -d` |

## Notes

- **Updates:** `docker compose pull && docker compose up -d`.
- **Stop:** `docker compose down`. While the gateway is down, MetaCode's scraper
  pauses instead of quietly falling back to the server's own address.
  `SCRAPER_NETWORK_FAILOVER=on` together with
  `SCRAPER_NETWORK_PROVIDERS=vpn-gateway,direct` allows that fallback on
  purpose.
- **Terms of use:** your VPN provider's terms apply to automated traffic.
- **What was verified:**
  - The gluetun setting names, route names and the `X-API-Key` header were
    checked against gluetun's source code.
  - `setup.sh` and `docker compose config` were tested.
  - MetaCode's side is tested against a local proxy and a mock status
    endpoint.
  - It was not run against a live Mullvad tunnel here.
