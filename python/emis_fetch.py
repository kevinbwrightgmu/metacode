#!/usr/bin/env python3
"""MetaCode — EMIS worker (AI requests made from Python).

EMIS documents its API for Python's OpenAI SDK, and some networks / gateway
checks treat Node.js's HTTP client differently from Python's, so MetaCode's
server sends its EMIS requests through this worker when Python is available
(EMIS_TRANSPORT=auto, the default; =python to require it; =node to skip it).

It uses, in order of preference:
  1. the official `openai` package (pip install openai) — exactly the client
     EMIS's documentation shows;
  2. `httpx` (installed with openai);
  3. Python's standard library (urllib) — no pip install needed.
Proxies: HTTPS_PROXY / HTTP_PROXY / NO_PROXY are honoured by all three, or
EMIS_PROXY when given in the request.

Protocol (UTF-8 JSON, one object per line):
  stdout   {"ready": true, "python": "3.12.1", "client": "openai 1.54.0"}
  stdin    {"id": 1, "method": "POST", "url": "https://…/v1/chat/completions",
            "key": "emis-…", "body": {…} | null, "timeoutMs": 120000, "proxy": ""}
  stdout   {"id": 1, "status": 200, "headers": {...}, "body": "text"}
       or  {"id": 1, "error": {"kind": "timeout|dns|tls|connection|invalid", "code": "...", "message": "..."}}
The key is used only for the Authorization header of the request it came
with; it is never printed or logged.
"""

import json
import platform
import socket
import ssl
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = "MetaCode/1.0 (OpenAI-compatible client; Python %s)" % platform.python_version()
out_lock = threading.Lock()

try:
    import openai  # noqa: F401
    import httpx
    CLIENT = "openai " + getattr(openai, "__version__", "?")
except Exception:  # pragma: no cover - depends on what is installed
    openai = None
    try:
        import httpx
        CLIENT = "httpx " + getattr(httpx, "__version__", "?")
    except Exception:
        httpx = None
        CLIENT = "urllib"


def emit(obj):
    # Pure-ASCII JSON written as bytes: works whatever the console encoding is
    # (Windows' default code page can't print "→" or "…" and used to crash here).
    line = json.dumps(obj, ensure_ascii=True)
    with out_lock:
        sys.stdout.buffer.write((line + "\n").encode("ascii"))
        sys.stdout.buffer.flush()


def classify(exc):
    text = str(exc)
    low = text.lower()
    if isinstance(exc, (socket.timeout, TimeoutError)) or "timed out" in low or "timeout" in type(exc).__name__.lower():
        return "timeout", "ETIMEDOUT"
    if isinstance(exc, ssl.SSLError) or "certificate" in low or "ssl" in low:
        return "tls", "CERT_ERROR"
    if "name or service not known" in low or "nodename nor servname" in low or "getaddrinfo" in low or "no address" in low:
        return "dns", "ENOTFOUND"
    if "refused" in low:
        return "connection", "ECONNREFUSED"
    if "reset" in low:
        return "connection", "ECONNRESET"
    return "connection", "ECONNRESET"


def base_and_path(url):
    i = url.find("/v1/")
    if i == -1:
        return None, None
    return url[: i + 3], url[i + 3:]


def via_openai(req):
    base, path = base_and_path(req["url"])
    if not base or path not in ("/chat/completions", "/models"):
        return None
    timeout = max(1.0, req.get("timeoutMs", 120000) / 1000.0)
    proxy = req.get("proxy") or None
    http_client = httpx.Client(proxy=proxy, timeout=timeout) if proxy else None
    client = openai.OpenAI(base_url=base, api_key=req["key"], timeout=timeout, max_retries=0, http_client=http_client)
    try:
        if path == "/models":
            raw = client.models.with_raw_response.list()
        else:
            body = dict(req.get("body") or {})
            model = body.pop("model", None)
            messages = body.pop("messages", [])
            # Everything else goes through as-is, so no SDK version can reject a field
            raw = client.chat.completions.with_raw_response.create(model=model, messages=messages, extra_body=body or None)
        resp = raw.http_response
        return {"status": resp.status_code, "headers": dict(resp.headers), "body": resp.text}
    except openai.APIStatusError as e:
        resp = e.response
        return {"status": resp.status_code, "headers": dict(resp.headers), "body": resp.text}
    except openai.APITimeoutError as e:
        raise TimeoutError(str(e))
    except openai.APIConnectionError as e:
        raise ConnectionError(str(e.__cause__ or e))
    finally:
        client.close()


def headers_for(req):
    streaming = isinstance(req.get("body"), dict) and bool(req["body"].get("stream"))
    h = {"Authorization": "Bearer " + req["key"], "Accept": "text/event-stream" if streaming else "application/json", "User-Agent": USER_AGENT}
    if req.get("body") is not None:
        h["Content-Type"] = "application/json"
    return h


def via_httpx(req):
    timeout = max(1.0, req.get("timeoutMs", 120000) / 1000.0)
    proxy = req.get("proxy") or None
    data = json.dumps(req["body"]).encode("utf-8") if req.get("body") is not None else None
    with httpx.Client(proxy=proxy, timeout=timeout, follow_redirects=False) as c:
        resp = c.request(req.get("method", "GET"), req["url"], headers=headers_for(req), content=data)
        return {"status": resp.status_code, "headers": dict(resp.headers), "body": resp.text}


def via_urllib(req):
    timeout = max(1.0, req.get("timeoutMs", 120000) / 1000.0)
    data = json.dumps(req["body"]).encode("utf-8") if req.get("body") is not None else None
    handlers = []
    if req.get("proxy"):
        handlers.append(urllib.request.ProxyHandler({"http": req["proxy"], "https": req["proxy"]}))
    try:
        import certifi  # better CA bundle on macOS / old systems, when installed
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
    handlers.append(urllib.request.HTTPSHandler(context=ctx))

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    handlers.append(NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    r = urllib.request.Request(req["url"], data=data, headers=headers_for(req), method=req.get("method", "GET"))
    try:
        with opener.open(r, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return {"status": resp.status, "headers": dict(resp.headers.items()), "body": body}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        return {"status": e.code, "headers": dict(e.headers.items()) if e.headers else {}, "body": body}
    except urllib.error.URLError as e:
        raise e.reason if isinstance(e.reason, Exception) else ConnectionError(str(e.reason))


def handle(line):
    try:
        req = json.loads(line)
    except Exception:
        return
    rid = req.get("id")
    try:
        if not isinstance(req.get("url"), str) or not req["url"].startswith(("https://", "http://")):
            raise ValueError("invalid url")
        res = None
        body = req.get("body")
        streaming = isinstance(body, dict) and bool(body.get("stream"))
        if openai is not None and not streaming:
            res = via_openai(req)
        if res is None:
            res = via_httpx(req) if httpx is not None else via_urllib(req)
        res["id"] = rid
        emit(res)
    except ValueError as e:
        emit({"id": rid, "error": {"kind": "client", "code": "ERR_INVALID_URL", "message": str(e)}})
    except Exception as e:
        msg = (type(e).__name__ + ": " + str(e)).replace(req.get("key") or "\0", "[redacted]")[:400]
        net = isinstance(e, (OSError, TimeoutError, ConnectionError)) or (httpx is not None and isinstance(e, httpx.TransportError)) \
            or (openai is not None and isinstance(e, (openai.APIConnectionError,)))
        if net:
            kind, code = classify(e)
        else:
            kind, code = "client", "PYTHON_ERROR"   # a problem in this worker, not the network
        try:
            emit({"id": rid, "error": {"kind": kind, "code": code, "message": msg}})
        except Exception:
            pass


def main():
    emit({"ready": True, "python": platform.python_version(), "client": CLIENT})
    pool = ThreadPoolExecutor(max_workers=8)
    for raw in sys.stdin.buffer:            # bytes: decoded as UTF-8 whatever the locale is
        line = raw.decode("utf-8", "replace").strip()
        if line:
            pool.submit(handle, line)


if __name__ == "__main__":
    main()
