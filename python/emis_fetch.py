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
EMIS's documentation shows), else `httpx`, else Python's standard library
(urllib) — no pip install needed. The openai SDK brings its own HTTP
library: httpx2 from its 3.x releases, httpx before. An answer that comes as
a stream anyway is read up to its "data: [DONE]" line, not until the
connection closes: a gateway may keep a finished stream open, and reading on
would wait for the time limit.
Proxies: HTTPS_PROXY / HTTP_PROXY / NO_PROXY are honoured by all three, or
EMIS_PROXY when given in the request (then for every request, as from Node.js).

Protocol (UTF-8 JSON, one object per line):
  stdout   {"ready": true, "python": "3.12.1", "client": "openai 1.54.0"}
  stdin    {"id": 1, "method": "POST", "url": "https://…/v1/chat/completions",
            "key": "emis-…", "body": {…} | null, "headers": {…extra headers from the
            provider's config…}, "timeoutMs": 120000, "proxy": ""}
  stdout   {"id": 1, "status": 200, "headers": {...}, "body": "text"}
       or  {"id": 1, "error": {"kind": "timeout|dns|tls|connection|client", "code": "...", "message": "...",
                               "sent": true (the gateway had the whole request when the exchange broke:
                               sending it again from Node.js would spend the key's budget twice)}}
  stdin    {"id": 1, "cancel": true}     the caller has gone (Stop, its time is up): the request's
                                         connection is closed at once and nothing more is sent for it
The key is used only for the Authorization header of the request it came
with; it is never printed or logged.
"""

import base64
import http.client
import importlib
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


def _load_clients():
    """The openai SDK (or None) and the HTTP library for it and for the other requests: the one
    that SDK release uses (httpx2 from 3.x on, httpx before), else whichever is installed."""
    try:
        import openai as sdk
        major = int(str(getattr(sdk, "__version__", "0")).split(".")[0] or 0)
    except Exception:  # pragma: no cover - depends on what is installed
        sdk, major = None, 0
    lib = None
    for name in (("httpx2", "httpx") if sdk is not None and major >= 3 else ("httpx", "httpx2")):
        try:
            lib = importlib.import_module(name)
            break
        except Exception:
            pass
    if lib is None:
        sdk = None
    return sdk, lib


openai, httpx = _load_clients()
if openai is not None:
    CLIENT = "openai " + getattr(openai, "__version__", "?")
elif httpx is not None:
    CLIENT = httpx.__name__ + " " + getattr(httpx, "__version__", "?")
else:
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


class BadRequest(ValueError):
    """A request this worker can't send (not a network problem)."""


class CutOff(Exception):
    """The gateway's answer had begun (its status line came) when reading it failed."""

    def __init__(self, inner):
        Exception.__init__(self, str(inner))
        self.inner = inner


def shut(sock):
    """Shuts a socket down (not just closes it): a thread blocked reading from it returns at once."""
    try:
        # (the plain socket's shutdown, also for a TLS one: SSLSocket.shutdown would unwrap it under
        # the thread that is reading)
        socket.socket.shutdown(sock, socket.SHUT_RDWR)
    except Exception:
        pass


class Job:
    """One request: when it came, its time limit, and the sockets it opened — shut when its caller
    goes away (a cancel message) or its time is up, which stops it wherever it is waiting (for
    the connection, the headers or the rest of the answer)."""

    def __init__(self, rid, timeout):
        self.id = rid
        self.timeout = timeout
        self.deadline = time.monotonic() + timeout
        self.cancelled = False              # the caller has gone: nothing is sent for this request
        self.expired = False                # its time was up (it fails as a timeout)
        self.sent = False                   # the whole request went out (the gateway has it)
        self._socks = []
        self._lock = threading.Lock()

    def add(self, sock):
        if sock is None:
            return
        with self._lock:
            self._socks.append(sock)
            late = self.cancelled or self.expired
        if late:
            shut(sock)

    def hang_up(self):
        with self._lock:
            socks = list(self._socks)
        for s in socks:
            shut(s)

    def cancel(self):
        with self._lock:
            self.cancelled = True
        self.hang_up()

    def expire(self):
        with self._lock:
            self.expired = True
        self.hang_up()


jobs = {}                                   # id → Job, while it runs (or waits for a thread)
jobs_lock = threading.Lock()


def watchdog():
    """Ends requests whose time is up wherever they wait (a gateway that sends headers late, or
    keeps a connection open without an answer, would otherwise hold a thread past the caller's limit)."""
    while True:
        time.sleep(0.5)
        now = time.monotonic()
        with jobs_lock:
            late = [j for j in jobs.values() if not j.expired and now > j.deadline + 1.0]
        for j in late:
            j.expire()


def traced(job):
    """httpx's (or httpx2's) event hooks that hand each connection's socket to the job, as it opens
    (and note when the whole request has gone out)."""
    def trace(event, info):
        if event.endswith((".connect_tcp.complete", ".start_tls.complete")):
            try:
                job.add(info["return_value"].get_extra_info("socket"))
            except Exception:
                pass
        elif event.endswith(".send_request_body.complete"):
            job.sent = True

    def hook(request):
        request.extensions["trace"] = trace
    return {"request": [hook]}


# The line that ends a streamed answer (OpenAI's SSE format), a chunk that finishes it, and its usage
DONE_LINE = re.compile(r"^data:\s*\[DONE\]\s*$")
FINISH = re.compile(r'"finish_reason"\s*:\s*"[^"]')
USAGE = re.compile(r'"usage"\s*:\s*\{')
# After a finish_reason without [DONE], how long the stream may stay silent before it counts as over
END_GRACE_S = 2.0


def byte_lines(chunks):
    """The body's lines, split at "\\n" only. (httpx's iter_lines also splits at U+2028, U+2029 and
    U+0085, which a JSON string may hold as they are: the answer couldn't be read.)"""
    pending = []
    for chunk in chunks:
        start = 0
        while True:
            i = chunk.find(b"\n", start)
            if i < 0:
                if start < len(chunk):
                    pending.append(chunk[start:])
                break
            pending.append(chunk[start:i + 1])
            yield b"".join(pending)
            pending = []
            start = i + 1
    if pending:
        yield b"".join(pending)


def read_stream(lines, job):
    """A streamed answer's text, up to its "data: [DONE]" line.

    `lines` yields the body's lines (bytes or text, with or without their line
    ending). Reading stops there even if the gateway keeps the connection open;
    after a finish_reason, also when no more of the answer (its usage, another
    finish) comes for END_GRACE_S — pings don't count (a gateway may keep a
    finished stream open without [DONE]); and at the job's deadline
    (keep-alive lines would otherwise keep the socket's own per-read timeout
    from ever firing). An answer without either (plain JSON, or a gateway that
    just closes) is read to its end. The lines are read in a thread of their
    own, so a silent connection can't hold this one; job.hang_up() ends that
    thread when reading stops before the end.
    """
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
        wait = job.deadline - now
        if finished_at is not None:
            wait = min(wait, finished_at + END_GRACE_S - now)
        if wait <= 0:
            if finished_at is not None:
                break
            raise TimeoutError("the answer took longer than %d s" % job.timeout)
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
        if text.startswith("data:") and (FINISH.search(text) or (finished_at is not None and USAGE.search(text))):
            finished_at = time.monotonic()      # (more of the answer's end, e.g. its usage, extends the wait)
    if not ended:
        job.hang_up()
    return "".join(out)


def streaming_body(req):
    return isinstance(req.get("body"), dict) and bool(req["body"].get("stream"))


def is_event_stream(content_type):
    # (a gateway may stream even when asked for a whole answer: read like a stream then)
    return "event-stream" in str(content_type or "").lower()


def client_options(req, job, **more):
    """httpx.Client's settings for a request: its time limit, the hooks that give the job its
    sockets, and EMIS_PROXY when it's set (`proxy=` only then: httpx before 0.26 hasn't that name)."""
    kw = dict(timeout=job.timeout, event_hooks=traced(job), **more)
    if req.get("proxy"):
        kw["proxy"] = req["proxy"]
    return kw


def via_openai(req, job):
    base, path = base_and_path(req["url"])
    if not base or path not in ("/chat/completions", "/models"):
        return None
    timeout = job.timeout
    # (an HTTP client of its own: its connections' sockets go to the job)
    http_client = httpx.Client(**client_options(req, job))
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
            try:
                if resp.status_code < 400 and is_event_stream(resp.headers.get("content-type")):
                    text = read_stream(byte_lines(resp.iter_bytes()), job)
                else:
                    text = resp.read().decode(resp.encoding or "utf-8", "replace")
            except Exception as e:
                raise CutOff(e)
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
        http_client.close()


def headers_for(req):
    streaming = isinstance(req.get("body"), dict) and bool(req["body"].get("stream"))
    h = {"User-Agent": USER_AGENT}
    h.update(extra_headers(req))
    h.update({"Authorization": "Bearer " + req["key"], "Accept": "text/event-stream" if streaming else "application/json"})
    if req.get("body") is not None:
        h["Content-Type"] = "application/json"
    return h


def via_httpx(req, job):
    data = json.dumps(req["body"]).encode("utf-8") if req.get("body") is not None else None
    with httpx.Client(**client_options(req, job, follow_redirects=False)) as c:
        with c.stream(req.get("method", "GET"), req["url"], headers=headers_for(req), content=data) as resp:
            try:
                if resp.status_code < 400 and (streaming_body(req) or is_event_stream(resp.headers.get("content-type"))):
                    body = read_stream(byte_lines(resp.iter_bytes()), job)
                else:
                    body = resp.read().decode(resp.encoding or "utf-8", "replace")
            except Exception as e:
                raise CutOff(e)
            return {"status": resp.status_code, "headers": dict(resp.headers), "body": body}


def via_urllib(req, job):
    timeout = job.timeout
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

    # (connections whose sockets go to the job, as they open; the request has gone out once its
    # answer is awaited)
    class Conn(http.client.HTTPConnection):
        def connect(self):
            http.client.HTTPConnection.connect(self)
            job.add(self.sock)

        def getresponse(self):
            job.sent = True
            return http.client.HTTPConnection.getresponse(self)

    class TLSConn(http.client.HTTPSConnection):
        def connect(self):
            http.client.HTTPSConnection.connect(self)
            job.add(self.sock)

        def getresponse(self):
            job.sent = True
            return http.client.HTTPSConnection.getresponse(self)

    class Plain(urllib.request.HTTPHandler):
        def http_open(self, r):
            return self.do_open(Conn, r)

    class Secure(urllib.request.HTTPSHandler):
        def https_open(self, r):
            return self.do_open(TLSConn, r, context=ctx)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    handlers += [Plain(), Secure(context=ctx), NoRedirect()]
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
            try:
                if streaming_body(req) or is_event_stream(resp.headers.get("Content-Type")):
                    body = read_stream(resp, job)
                else:
                    body = resp.read().decode("utf-8", "replace")
            except Exception as e:
                raise CutOff(e)
            return {"status": resp.status, "headers": dict(resp.headers.items()), "body": body}
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace") if e.fp else ""
        except Exception as e2:
            raise CutOff(e2)
        return {"status": e.code, "headers": dict(e.headers.items()) if e.headers else {}, "body": body}
    except urllib.error.URLError as e:
        raise e.reason if isinstance(e.reason, Exception) else ConnectionError(str(e.reason))


def is_network_error(e):
    return isinstance(e, (OSError, TimeoutError, ConnectionError)) or (httpx is not None and isinstance(e, httpx.TransportError)) \
        or (openai is not None and isinstance(e, (openai.APIConnectionError,)))


def handle(req, job):
    rid = req.get("id")
    try:
        if job.cancelled:
            return                          # (its caller went away while it waited for a thread)
        if job.expired:
            raise TimeoutError("the request waited for a free thread for its whole time limit")
        if not isinstance(req.get("url"), str) or not req["url"].startswith(("https://", "http://")):
            raise BadRequest("invalid url")
        res = None
        if openai is not None and not streaming_body(req):
            res = via_openai(req, job)
        if res is None:
            res = via_httpx(req, job) if httpx is not None else via_urllib(req, job)
        if job.cancelled:
            return
        res["id"] = rid
        emit(res)
    except BadRequest as e:
        emit({"id": rid, "error": {"kind": "client", "code": "ERR_INVALID_URL", "message": str(e)}})
    except Exception as e:
        if job.cancelled:
            return                          # (nobody waits for this answer any more)
        answered = isinstance(e, CutOff)
        inner = e.inner if answered else e
        msg = (type(inner).__name__ + ": " + str(inner)).replace(req.get("key") or "\0", "[redacted]")[:400]
        if job.expired:
            kind, code = "timeout", "ETIMEDOUT"
        elif answered or is_network_error(inner):
            kind, code = classify(inner)
        else:
            kind, code = "client", "PYTHON_ERROR"   # a problem in this worker, not the network
        err = {"kind": kind, "code": code, "message": msg}
        if answered or job.sent:
            err["sent"] = True
        try:
            emit({"id": rid, "error": err})
        except Exception:
            pass
    finally:
        with jobs_lock:
            if jobs.get(rid) is job:
                del jobs[rid]


def main():
    emit({"ready": True, "python": platform.python_version(), "client": CLIENT})
    threading.Thread(target=watchdog, daemon=True).start()
    # AI Coding runs several requests at once (AI_MAX_PARALLEL, up to 64 a run, and several runs);
    # a request whose caller went away gives its thread back at once (a cancel message)
    pool = ThreadPoolExecutor(max_workers=256)
    for raw in sys.stdin.buffer:            # bytes: decoded as UTF-8 whatever the locale is
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if not isinstance(req, dict):
            continue
        rid = req.get("id")
        if req.get("cancel"):
            with jobs_lock:
                job = jobs.get(rid)
            if job is not None:
                job.cancel()
            continue
        try:
            timeout = max(1.0, float(req.get("timeoutMs") or 120000) / 1000.0)
        except Exception:
            timeout = 120.0
        job = Job(rid, timeout)
        with jobs_lock:
            jobs[rid] = job
        pool.submit(handle, req, job)


if __name__ == "__main__":
    main()
