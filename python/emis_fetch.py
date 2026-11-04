#!/usr/bin/env python3
"""MetaCode — EMIS worker (AI requests made from Python).

EMIS documents its API with curl and Python's OpenAI SDK (any OpenAI client
works; its website's browser check doesn't apply to API requests made with a
key). MetaCode's OpenCode service (opencode/, its EMIS provider) sends its
non-streamed EMIS requests through this worker when Python is available
(EMIS_TRANSPORT=auto, the default; =python to require it; =node to skip it),
and through Node.js otherwise (streamed answers always go through Node.js).

Chat requests (whole answers: stream:false, as MetaCode always sent them)
go out with the official `openai` package when it's installed (the client
EMIS's documentation shows), else `httpx` (installed with openai: pip install
openai), else Python's standard library (urllib) — no pip install needed. An
answer that comes as a stream anyway is read up to its "data: [DONE]" line,
not until the connection closes: a gateway may keep a finished stream open,
and reading on would wait for the time limit.
Proxies: HTTPS_PROXY / HTTP_PROXY / NO_PROXY are honoured by all three, or
EMIS_PROXY when given in the request (then for every request, as from Node.js).

Protocol (UTF-8 JSON, one object per line):
  stdout   {"ready": true, "python": "3.12.1", "client": "openai 1.54.0"}
  stdin    {"id": 1, "method": "POST", "url": "https://…/v1/chat/completions",
            "key": "emis-…", "body": {…} | null, "headers": {…extra headers from the
            provider's config…}, "timeoutMs": 120000, "proxy": ""}
  stdout   {"id": 1, "status": 200, "headers": {...}, "body": "text"}
       or  {"id": 1, "error": {"kind": "timeout|dns|tls|connection|invalid", "code": "...", "message": "..."}}
The key is used only for the Authorization header of the request it came
with; it is never printed or logged.
"""

import base64
import json
import platform
import queue
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
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


# The provider's own extra headers (its config's options.headers); never the ones this worker sets
RESERVED = ("authorization", "content-type", "content-length", "host", "accept")


def extra_headers(req):
    given = req.get("headers") if isinstance(req.get("headers"), dict) else {}
    return {str(k): str(v) for k, v in given.items() if str(k).lower() not in RESERVED}


# The line that ends a streamed answer (OpenAI's SSE format), and a chunk that finishes it
DONE_LINE = re.compile(r"^data:\s*\[DONE\]\s*$")
FINISH = re.compile(r'"finish_reason"\s*:\s*"[^"]')
# After a finish_reason without [DONE], how long the stream may stay silent before it counts as over
END_GRACE_S = 2.0


def hang_up(resp):
    """Shuts the connection under a response whose answer is in (urllib's or httpx's), so a
    thread still waiting on it for more returns and the response can be closed."""
    sock = None
    try:
        sock = resp.fp.raw._sock                                   # urllib
    except Exception:
        try:
            sock = resp.extensions["network_stream"].get_extra_info("socket")    # httpx
        except Exception:
            sock = None
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass


def read_stream(lines, timeout, stop=None):
    """A streamed answer's text, up to its "data: [DONE]" line.

    `lines` yields the body's lines (bytes or text, with or without their line
    ending). Reading stops there even if the gateway keeps the connection open;
    after a finish_reason, also when no more data comes for END_GRACE_S (a
    gateway may keep a finished stream open without [DONE]); and after
    `timeout` seconds in all (keep-alive lines would otherwise keep the socket's
    own per-read timeout from ever firing). An answer without either (plain
    JSON, or a gateway that just closes) is read to its end. The lines are read
    in a thread of their own, so a silent connection can't hold this one;
    `stop()` (hang_up) ends that thread when reading stops before the end.
    """
    deadline = time.monotonic() + timeout
    q = queue.Queue()

    def pump():
        try:
            for raw in lines:
                q.put(raw)
        except Exception as e:  # (the connection closed under it, once the answer is in)
            q.put(e)
        q.put(None)
    threading.Thread(target=pump, daemon=True).start()
    out = []
    finished_at = None
    ended = False                           # the thread is done (the connection closed or failed)
    while True:
        now = time.monotonic()
        wait = deadline - now
        if finished_at is not None:
            wait = min(wait, finished_at + END_GRACE_S - now)
        if wait <= 0:
            if finished_at is not None:
                break
            raise TimeoutError("the answer took longer than %d s" % timeout)
        try:
            item = q.get(timeout=wait)
        except queue.Empty:
            continue
        if item is None:
            ended = True
            break
        if isinstance(item, Exception):
            ended = True
            if finished_at is not None:
                break
            raise item
        line = item.decode("utf-8", "replace") if isinstance(item, bytes) else item
        out.append(line if line.endswith("\n") else line + "\n")
        text = line.strip()
        if DONE_LINE.match(text):
            out.append("\n")       # (the blank line that ends the event)
            break
        if text.startswith("data:") and (finished_at is not None or FINISH.search(text)):
            finished_at = time.monotonic()      # (more of the answer, e.g. its usage, extends the wait)
    if not ended and stop is not None:
        stop()
    return "".join(out)


def streaming_body(req):
    return isinstance(req.get("body"), dict) and bool(req["body"].get("stream"))


def is_event_stream(content_type):
    # (a gateway may stream even when asked for a whole answer: read like a stream then)
    return "event-stream" in str(content_type or "").lower()


def via_openai(req):
    base, path = base_and_path(req["url"])
    if not base or path not in ("/chat/completions", "/models"):
        return None
    timeout = max(1.0, req.get("timeoutMs", 120000) / 1000.0)
    proxy = req.get("proxy") or None
    http_client = httpx.Client(proxy=proxy, timeout=timeout) if proxy else None
    client = openai.OpenAI(base_url=base, api_key=req["key"], timeout=timeout, max_retries=0, http_client=http_client,
                           default_headers=extra_headers(req) or None)
    try:
        if path == "/models":
            raw = client.models.with_raw_response.list()
            resp = raw.http_response
            return {"status": resp.status_code, "headers": dict(resp.headers), "body": resp.text}
        body = dict(req.get("body") or {})
        model = body.pop("model", None)
        messages = body.pop("messages", [])
        # Everything else goes through as-is, so no SDK version can reject a field. The answer is
        # read as it comes: one that is a stream after all is read up to its end (read_stream)
        with client.chat.completions.with_streaming_response.create(model=model, messages=messages, extra_body=body or None) as raw:
            resp = raw.http_response
            if resp.status_code < 400 and is_event_stream(resp.headers.get("content-type")):
                text = read_stream(resp.iter_lines(), timeout, lambda: hang_up(resp))
            else:
                text = resp.read().decode(resp.encoding or "utf-8", "replace")
            return {"status": resp.status_code, "headers": dict(resp.headers), "body": text}
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
    h = {"User-Agent": USER_AGENT}
    h.update(extra_headers(req))
    h.update({"Authorization": "Bearer " + req["key"], "Accept": "text/event-stream" if streaming else "application/json"})
    if req.get("body") is not None:
        h["Content-Type"] = "application/json"
    return h


def via_httpx(req):
    timeout = max(1.0, req.get("timeoutMs", 120000) / 1000.0)
    proxy = req.get("proxy") or None
    data = json.dumps(req["body"]).encode("utf-8") if req.get("body") is not None else None
    with httpx.Client(proxy=proxy, timeout=timeout, follow_redirects=False) as c:
        with c.stream(req.get("method", "GET"), req["url"], headers=headers_for(req), content=data) as resp:
            if resp.status_code < 400 and (streaming_body(req) or is_event_stream(resp.headers.get("content-type"))):
                body = read_stream(resp.iter_lines(), timeout, lambda: hang_up(resp))
            else:
                body = resp.read().decode(resp.encoding or "utf-8", "replace")
            return {"status": resp.status_code, "headers": dict(resp.headers), "body": body}


def via_urllib(req):
    timeout = max(1.0, req.get("timeoutMs", 120000) / 1000.0)
    data = json.dumps(req["body"]).encode("utf-8") if req.get("body") is not None else None
    handlers = []
    proxy = req.get("proxy")
    if proxy:
        # EMIS_PROXY is set on the request itself (below): urllib's ProxyHandler
        # would skip it for hosts NO_PROXY lists, and the environment's proxies don't apply
        handlers.append(urllib.request.ProxyHandler({}))
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
    if proxy:
        p = urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy)
        host = p.hostname or ""
        if ":" in host:
            host = "[" + host + "]"
        if p.username:
            cred = urllib.parse.unquote(p.username) + ":" + urllib.parse.unquote(p.password or "")
            r.add_header("Proxy-Authorization", "Basic " + base64.b64encode(cred.encode("utf-8")).decode("ascii"))
        r.set_proxy(host + (":" + str(p.port) if p.port else ""), p.scheme or "http")
    try:
        with opener.open(r, timeout=timeout) as resp:
            if streaming_body(req) or is_event_stream(resp.headers.get("Content-Type")):
                body = read_stream(resp, timeout, lambda: hang_up(resp))
            else:
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
        if openai is not None and not streaming_body(req):
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
    pool = ThreadPoolExecutor(max_workers=64)   # AI Coding runs several requests at once (AI_MAX_PARALLEL)
    for raw in sys.stdin.buffer:            # bytes: decoded as UTF-8 whatever the locale is
        line = raw.decode("utf-8", "replace").strip()
        if line:
            pool.submit(handle, line)


if __name__ == "__main__":
    main()
