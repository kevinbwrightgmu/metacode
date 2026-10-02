#!/usr/bin/env python3
"""MetaCode scraper — HTTPS worker (the "Python" server engine).

Started once by scraper/network/python-transport.js and kept running. It
performs the HTTPS requests of server-side scraper jobs (Reddit's API, public
pages, RedditAPIs.com) with Python's standard library only — no pip install.

Protocol (UTF-8 JSON, one object per line):
  argv[1]  config: {"hostPatterns": [[regex, flags]], "ports": [443],
                    "allowPrivate": false, "userAgent": "...", "maxBytes": N}
  stdout   {"ready": true, "python": "3.12.1", "ssl": "OpenSSL 3.0.13"}
  stdin    {"id": 1, "method": "GET", "url": "https://...", "headers": {...},
            "body": null | "text", "timeoutMs": 20000}
  stdout   {"id": 1, "status": 200, "statusText": "OK", "headers": {...},
            "body": "text", "url": "https://..."}
       or  {"id": 1, "error": {"kind": "tls|dns|timeout|blocked|too_large|connection|invalid", "message": "..."}}

Node decides *whether* a request may be made (allowed hosts, robots.txt, rate
limits, retries). This worker enforces the network rules again on its own:
https/http only, allow-listed host names and ports, and no private, loopback
or link-local addresses (unless the server is configured for local testing).
It connects to the address it checked (no second DNS lookup), verifies TLS
certificates (never disabled) and never follows redirects.
"""

import http.client
import ipaddress
import json
import re
import socket
import ssl
import sys
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

MAX_WORKERS = 8


class FetchError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message


def load_config():
    cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    flags = lambda f: re.IGNORECASE if "i" in (f or "") else 0
    return {
        "patterns": [re.compile(src, flags(fl)) for src, fl in cfg.get("hostPatterns", [])],
        "ports": set(int(p) for p in cfg.get("ports", [443])),
        "allow_private": bool(cfg.get("allowPrivate")),
        "user_agent": str(cfg.get("userAgent") or "metacode-scraper"),
        "max_bytes": int(cfg.get("maxBytes") or 8 * 1024 * 1024),
    }


CONFIG = load_config()


def tls_context():
    ctx = ssl.create_default_context()
    try:  # python.org builds on macOS ship without a CA store; certifi fills it in.
        import certifi  # noqa: WPS433 — optional
        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    return ctx


TLS = tls_context()


def address_allowed(ip):
    addr = ipaddress.ip_address(ip)
    if getattr(addr, "ipv4_mapped", None):
        addr = addr.ipv4_mapped
    if CONFIG["allow_private"]:
        return not addr.is_multicast and not addr.is_unspecified
    return addr.is_global and not addr.is_multicast


def resolve(host, port):
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise FetchError("dns", "Couldn't look up %s (%s)" % (host, e.strerror or e))
    # IPv4 first, like the Wisp endpoint.
    infos.sort(key=lambda i: 0 if i[0] == socket.AF_INET else 1)
    for family, _type, _proto, _name, sockaddr in infos:
        if address_allowed(sockaddr[0]):
            return family, sockaddr
    raise FetchError("blocked", "%s resolves to a private or reserved address, which the scraper may not connect to" % host)


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connects to the already-checked address; TLS still verifies the host name."""

    def __init__(self, host, port, sockaddr, family, timeout):
        super().__init__(host, port, timeout=timeout, context=TLS)
        self._sockaddr, self._family = sockaddr, family

    def connect(self):
        sock = socket.socket(self._family, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._sockaddr)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, port, sockaddr, family, timeout):
        super().__init__(host, port, timeout=timeout)
        self._sockaddr, self._family = sockaddr, family

    def connect(self):
        sock = socket.socket(self._family, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._sockaddr)
        self.sock = sock


def read_limited(resp, limit):
    chunks, total = [], 0
    while True:
        chunk = resp.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise FetchError("too_large", "The response was larger than %d KB" % (limit // 1024))
        chunks.append(chunk)
    return b"".join(chunks)


def decompress(data, encoding, limit):
    encoding = (encoding or "").lower().strip()
    if encoding in ("", "identity"):
        return data
    if encoding not in ("gzip", "deflate"):
        raise FetchError("invalid", "Unsupported content-encoding: " + encoding)
    d = zlib.decompressobj(16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS)
    out = d.decompress(data, limit + 1)
    if len(out) > limit or d.unconsumed_tail:
        raise FetchError("too_large", "The response was larger than %d KB" % (limit // 1024))
    return out


def fetch(req):
    url = str(req.get("url") or "")
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.hostname or parts.username or parts.password:
        raise FetchError("invalid", "Only plain http(s) URLs can be fetched")
    host = parts.hostname.lower()
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        ipaddress.ip_address(host)
        raise FetchError("blocked", "Direct IP addresses can't be fetched")
    except ValueError:
        pass
    if not any(p.search(host) for p in CONFIG["patterns"]):
        raise FetchError("blocked", "%s is not on the scraper's allow-list" % host)
    if port not in CONFIG["ports"]:
        raise FetchError("blocked", "Port %d is not allowed" % port)
    method = str(req.get("method") or "GET").upper()
    if method not in ("GET", "HEAD", "POST"):
        raise FetchError("invalid", "Method %s is not allowed" % method)

    timeout = max(1.0, float(req.get("timeoutMs") or 20000) / 1000.0)
    family, sockaddr = resolve(host, port)
    conn_cls = PinnedHTTPSConnection if parts.scheme == "https" else PinnedHTTPConnection
    conn = conn_cls(host, port, sockaddr, family, timeout)
    headers = {str(k): str(v) for k, v in (req.get("headers") or {}).items()}
    lower = {k.lower() for k in headers}
    if "user-agent" not in lower:
        headers["User-Agent"] = CONFIG["user_agent"]
    if "accept-encoding" not in lower:
        headers["Accept-Encoding"] = "gzip, deflate"
    body = req.get("body")
    body = body.encode("utf-8") if isinstance(body, str) else None
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        raw = b"" if method == "HEAD" else read_limited(resp, CONFIG["max_bytes"])
        out_headers = {}
        for name, value in resp.getheaders():
            key = name.lower()
            out_headers[key] = out_headers[key] + ", " + value if key in out_headers else value
        data = decompress(raw, out_headers.get("content-encoding"), CONFIG["max_bytes"])
        out_headers.pop("content-encoding", None)
        out_headers.pop("content-length", None)
        return {"status": resp.status, "statusText": resp.reason or "", "headers": out_headers,
                "body": data.decode("utf-8", "replace"), "url": url}
    finally:
        conn.close()


def classify(exc):
    if isinstance(exc, FetchError):
        return exc.kind, exc.message
    if isinstance(exc, ssl.SSLCertVerificationError):
        return "tls", "certificate verify failed: %s" % (exc.verify_message or exc)
    if isinstance(exc, ssl.SSLError):
        return "tls", "TLS error: %s" % (exc.reason or exc)
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout", "timed out"
    if isinstance(exc, socket.gaierror):
        return "dns", "lookup failed: %s" % exc
    if isinstance(exc, (ConnectionError, OSError, http.client.HTTPException)):
        return "connection", "%s: %s" % (type(exc).__name__, exc)
    return "connection", "%s: %s" % (type(exc).__name__, exc)


OUT_LOCK = threading.Lock()


def write(obj):
    line = json.dumps(obj, ensure_ascii=False)
    with OUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def handle(req):
    rid = req.get("id")
    try:
        result = fetch(req)
        result["id"] = rid
        write(result)
    except BaseException as exc:  # noqa: BLE001 — every failure is reported back
        kind, message = classify(exc)
        write({"id": rid, "error": {"kind": kind, "message": str(message)[:300]}})


def main():
    write({"ready": True, "python": sys.version.split()[0], "ssl": ssl.OPENSSL_VERSION})
    pool = ThreadPoolExecutor(max_workers=MAX_WORKERS)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        pool.submit(handle, req)
    try:
        pool.shutdown(wait=False, cancel_futures=True)
    except TypeError:  # Python 3.8
        pool.shutdown(wait=False)


if __name__ == "__main__":
    if sys.version_info < (3, 8):
        write({"ready": False, "error": "Python 3.8 or newer is needed"})
        sys.exit(1)
    main()
