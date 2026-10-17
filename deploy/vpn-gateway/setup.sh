#!/usr/bin/env bash
# Prepares the VPN gateway: your WireGuard key, a random proxy password and a
# random status API key. Prints the lines to add to MetaCode's .env.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f vpn.env ] || [ -f gluetun/auth/config.toml ]; then
  echo "vpn.env or gluetun/auth/config.toml already exists. Edit them, or delete them to start over." >&2
  exit 1
fi
rand() { local s; s="$(head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"; printf '%s' "${s:0:$1}"; }
echo "Mullvad: account page → WireGuard configuration → generate a key → download any config file."
read -r -p "PrivateKey from that file: " KEY
read -r -p "Address from that file (IPv4 part, e.g. 10.64.12.34/32): " ADDR
read -r -p "Exit country (optional, e.g. USA or Sweden; Enter for any): " COUNTRY
[ -n "$KEY" ] && [ -n "$ADDR" ] || { echo "Both the key and the address are needed." >&2; exit 1; }
ADDR="${ADDR%%,*}"
PROXY_PASSWORD="$(rand 32)"
API_KEY="$(rand 40)"
umask 077
{
  echo "VPN_SERVICE_PROVIDER=mullvad"
  echo "VPN_TYPE=wireguard"
  echo "WIREGUARD_PRIVATE_KEY=$KEY"
  echo "WIREGUARD_ADDRESSES=$ADDR"
  if [ -n "$COUNTRY" ]; then echo "SERVER_COUNTRIES=$COUNTRY"; fi
  echo "HTTPPROXY_USER=metacode"
  echo "HTTPPROXY_PASSWORD=$PROXY_PASSWORD"
} > vpn.env
mkdir -p gluetun/auth
cat > gluetun/auth/config.toml <<TOML
[[roles]]
name = "metacode"
auth = "apikey"
apikey = "$API_KEY"
routes = ["GET /v1/vpn/status", "GET /v1/publicip/ip"]
TOML
cat <<OUT

Done. Next:
  1. docker compose up -d        (then: docker logs -f metacode-vpn  — wait for "Public IP address is …")
  2. Add these lines to MetaCode's .env (they are secrets):

SCRAPER_VPN_GATEWAY_PROXY_URL=http://metacode:$PROXY_PASSWORD@127.0.0.1:8888
SCRAPER_VPN_GATEWAY_HEALTH_URL=http://127.0.0.1:8000/v1/vpn/status
SCRAPER_VPN_GATEWAY_IP_URL=http://127.0.0.1:8000/v1/publicip/ip
SCRAPER_VPN_GATEWAY_HEALTH_API_KEY=$API_KEY

  3. pm2 reload metacode
  4. Scraper page → Network diagnostics → "Test route" on the VPN gateway.
OUT
