# ══════════════════════════════════════════════
#  python-prelude.py — the custom-scraper SDK for Python
#
#  Runs INSIDE the Pyodide sandbox (python-child.js), never in the server's
#  own Python. It builds the `ctx` object passed to the user's
#  `async def scrape(ctx)` from three bridge functions:
#
#    call(name, json) -> Promise[json]   asynchronous host services
#    send(name, json) -> error text      fire-and-forget (log, emit, progress)
#    format(name, json) -> json          reddit/format.js (record shapes)
#
#  Only JSON strings cross the bridge. The host decides what each call may do
#  (Reddit hosts only, GET/HEAD only, rate-limited, size-capped). Mirrors the
#  JavaScript SDK (guest-prelude.js) with Python naming.
# ══════════════════════════════════════════════

import html as _html
import inspect as _inspect
import json as _json
import linecache as _linecache
import re as _re
import traceback as _traceback
import datetime as _dt

from _metacode_host import call as _host_call, send as _host_send, format as _host_format

_USER_FILE = "scraper.py"
_HOST_TYPES = {
    "cancelled", "not_available", "payment_required", "browser_unavailable", "reddit_blocked",
    "forbidden_private", "forbidden_quarantined", "forbidden_premium", "timeout", "network", "tls",
    "proxy_blocked", "proxy_error", "http_error", "not_found", "forbidden", "rate_limited",
    "robots_disallowed", "robots_unavailable", "auth_error", "invalid_url", "host_not_allowed",
    "invalid_request", "too_large", "parse_error",
}


def _no_processes(*args, **kwargs):
    raise PermissionError("Running programs isn't available in the MetaCode sandbox")


import os as _os
for _name in ("system", "popen", "fork", "forkpty", "execv", "execve", "execl", "execle", "execlp", "execvp", "execvpe",
              "spawnl", "spawnle", "spawnv", "spawnve", "posix_spawn", "posix_spawnp", "kill", "killpg"):
    if hasattr(_os, _name):
        setattr(_os, _name, _no_processes)
del _name


class ScraperError(Exception):
    """Raised for failed host requests. `type` says why: "not_found",
    "rate_limited", "forbidden", "host_not_allowed", … (see the docs)."""

    def __init__(self, type, message):
        super().__init__(message)
        self.type = type
        self.message = message

    def __str__(self):
        return self.message


def _json_default(value):
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return value.isoformat()
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _dumps(value):
    return _json.dumps(value, default=_json_default, ensure_ascii=False, allow_nan=False)


async def _call(name, args=None):
    out = _json.loads(await _host_call(name, _dumps(args)))
    if out.get("ok"):
        value = out.get("value")
        return None if value in (None, "") else _json.loads(value)
    err = out.get("error") or {}
    exc = ScraperError(err.get("type") or "custom_code_error", err.get("message") or "Host call failed")
    exc._from_host = True
    raise exc


def _send(name, value):
    problem = _host_send(name, _dumps(value))
    if problem:
        raise ValueError(problem)


def _fmt(name, *args):
    return _json.loads(_host_format(name, _dumps(list(args))))


def _text(x):
    if isinstance(x, str):
        return x
    if isinstance(x, BaseException):
        return type(x).__name__ + ": " + str(x)
    try:
        return _dumps(x)
    except Exception:
        return repr(x)


class _Log:
    def _at(self, level, args):
        _send("log", {"level": level, "message": " ".join(_text(a) for a in args)})

    def __call__(self, *args):
        self._at("info", args)

    def debug(self, *args):
        self._at("debug", args)

    def info(self, *args):
        self._at("info", args)

    def warn(self, *args):
        self._at("warn", args)

    warning = warn

    def error(self, *args):
        self._at("error", args)


class Headers(dict):
    """Response headers; lookups ignore case."""

    def get(self, name, default=None):
        return super().get(str(name).lower(), default)

    def __getitem__(self, name):
        return super().__getitem__(str(name).lower())

    def __contains__(self, name):
        return super().__contains__(str(name).lower())


class Response:
    """What ctx.fetch() returns, shaped like requests' Response."""

    def __init__(self, r):
        self.status = self.status_code = r.get("status")
        self.status_text = self.reason = r.get("statusText") or ""
        self.url = r.get("url")
        self.ok = 200 <= (self.status or 0) < 300
        self.headers = Headers({str(k).lower(): v for k, v in (r.get("headers") or {}).items()})
        self.text = r.get("body") or ""

    def json(self):
        try:
            return _json.loads(self.text)
        except ValueError as e:
            raise ValueError("Response from %s is not valid JSON (%s)" % (self.url, e)) from None

    def raise_for_status(self):
        if not self.ok:
            raise ScraperError("http_error", "HTTP %s for %s" % (self.status, self.url))

    def __repr__(self):
        return "<Response [%s] %s>" % (self.status, self.url)


class _Utils:
    @staticmethod
    def get(obj, path, default=None):
        """utils.get(post, "media.reddit_video.duration") — None-safe lookup."""
        parts = path if isinstance(path, (list, tuple)) else str(path).split(".")
        cur = obj
        for part in parts:
            if cur is None:
                return default
            if isinstance(cur, dict):
                cur = cur.get(part)
            elif isinstance(cur, (list, tuple)):
                try:
                    cur = cur[int(part)]
                except (ValueError, IndexError):
                    return default
            else:
                cur = getattr(cur, str(part), None)
        return default if cur is None else cur

    @staticmethod
    def pick(obj, keys):
        return {k: (obj or {}).get(k) for k in keys or []}

    @staticmethod
    def unique(items, key=None):
        seen, out = set(), []
        for item in items or []:
            k = key(item) if key else item
            k = _dumps(k) if isinstance(k, (dict, list)) else k
            if k not in seen:
                seen.add(k)
                out.append(item)
        return out

    @staticmethod
    def chunk(items, size):
        items, size = list(items or []), max(1, int(size))
        return [items[i:i + size] for i in range(0, len(items), size)]

    @staticmethod
    def decode_entities(text):
        return _html.unescape(str(text or ""))

    @staticmethod
    def strip_html(markup):
        s = _re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", str(markup or ""))
        s = _re.sub(r"(?i)<br\s*/?>", "\n", s)
        s = _re.sub(r"(?i)</(p|div|li|h[1-6])>", "\n", s)
        s = _html.unescape(_re.sub(r"<[^>]+>", " ", s))
        s = _re.sub(r"[ \t]+", " ", s)
        return _re.sub(r"\n\s+", "\n", s).strip()


class _Reddit:
    def __init__(self, run):
        self._run = run

    async def json(self, path, query=None):
        """Any Reddit JSON endpoint, e.g. await ctx.reddit.json("/r/python/about")."""
        r = await _call("redditJson", {"path": str(path), "query": query or None})
        try:
            return _json.loads(r["body"])
        except (ValueError, TypeError, KeyError):
            raise ValueError("Reddit returned data that is not JSON for %s" % path) from None

    async def pages(self, path, max_pages=None, limit=100, after=None, query=None):
        """async for page in ctx.reddit.pages("/r/python/new"): page["records"], …"""
        opts = self._run.options
        max_pages = max(1, min(int(opts["maxPages"]), int(max_pages or opts["maxPages"])))
        limit = max(1, min(100, int(limit or 100)))
        for number in range(1, max_pages + 1):
            q = dict(query or {})
            q["limit"] = limit
            if after:
                q["after"] = after
            data = await self.json(path, q)
            if not isinstance(data, dict) or data.get("kind") != "Listing" or not isinstance((data.get("data") or {}).get("children"), list):
                raise ValueError("%s did not return a Reddit listing" % path)
            children = data["data"]["children"]
            after = data["data"].get("after")
            _send("progress", {"pagesDelta": 1, "message": "Page %d of %s" % (number, path)})
            records = [r for r in (_fmt("normalizeThing", c) for c in children) if r]
            yield {"number": number, "children": children, "records": records, "after": after}
            if not after or not children:
                return

    async def listing(self, path, max_items=None, max_pages=None, query=None, limit=100):
        """Collects records from a listing: {"items": [...], "pages": n}."""
        cap = max(1, int(max_items or self._run.options["maxItems"]))
        items, count = [], 0
        async for page in self.pages(path, max_pages=max_pages, limit=limit, query=query):
            count += 1
            items.extend(page["records"][: cap - len(items)])
            if len(items) >= cap:
                break
        return {"items": items, "pages": count}

    async def post(self, post_id, limit=None, depth=None, sort="confidence"):
        """A post and its comments: {"post", "comments", "more_count"}."""
        opts = self._run.options
        pid = _re.sub(r"^t3_", "", str(post_id))
        data = await self.json("/comments/" + pid, {
            "limit": limit or opts.get("commentLimit") or 100,
            "depth": depth or opts.get("commentDepth") or 5,
            "sort": sort,
        })
        if not isinstance(data, list) or len(data) < 2:
            raise ValueError("Post %s did not return a post + comments pair" % pid)
        posts = [c for c in data[0]["data"]["children"] if c.get("kind") == "t3"]
        if not posts:
            raise ScraperError("not_found", "Post %s not found" % pid)
        record = _fmt("normalizePost", posts[0]["data"])
        flat = _fmt("flattenComments", data[1]["data"]["children"],
                    {"post_id": record["post_id"], "post_title": record["title"], "post_permalink": record["permalink"]}, limit)
        return {"post": record, "comments": flat["comments"], "more_count": flat["moreCount"]}

    async def subreddit(self, name):
        data = await self.json("/r/%s/about" % name)
        return _fmt("normalizeSubreddit", data["data"]) if isinstance(data, dict) and data.get("data") else None

    async def user(self, name):
        data = await self.json("/user/%s/about" % name)
        return _fmt("normalizeUser", data["data"]) if isinstance(data, dict) and data.get("data") else None

    @staticmethod
    def normalize_post(data):
        return _fmt("normalizePost", data)

    @staticmethod
    def normalize_comment(data, extra=None):
        return _fmt("normalizeComment", data, extra or {})

    @staticmethod
    def normalize_subreddit(data):
        return _fmt("normalizeSubreddit", data)

    @staticmethod
    def normalize_user(data):
        return _fmt("normalizeUser", data)

    @staticmethod
    def normalize_thing(thing):
        return _fmt("normalizeThing", thing)

    @staticmethod
    def flatten_comments(children, extra=None, limit=None):
        out = _fmt("flattenComments", children, extra or {}, limit)
        return {"comments": out["comments"], "more_count": out["moreCount"], "more_ids": out.get("moreIds", [])}

    @staticmethod
    def extract_media(data):
        return _fmt("extractMedia", data)

    @staticmethod
    def to_iso(utc_seconds):
        return _fmt("toIso", utc_seconds)


class Context:
    """The `ctx` passed to scrape(ctx). See the API reference on the Scraper page."""

    def __init__(self, init):
        self.target = init.get("target")
        self.options = init.get("options") or {}
        self.params = init.get("params") or {}
        self.mode = init.get("mode")
        self.log = _Log()
        self.utils = _Utils()
        self.reddit = _Reddit(self)
        self.ScraperError = ScraperError
        self._emitted = 0

    async def fetch(self, url, method="GET", headers=None):
        """A raw GET/HEAD to a Reddit URL (same rules as the standard scraper)."""
        r = await _call("fetch", {"url": str(url), "method": method or "GET", "headers": headers or {}})
        return Response(r)

    def emit(self, records):
        """Adds record(s) to the results; returns how many more fit (max items)."""
        items = records if isinstance(records, (list, tuple)) else [records]
        clean = [r for r in items if isinstance(r, dict)]
        if len(clean) != len(items):
            self.log.warn("emit() skipped %d value(s) that are not dicts" % (len(items) - len(clean)))
        room = max(0, int(self.options["maxItems"]) - self._emitted)
        clean = clean[:room]
        if clean:
            _send("emit", clean)
            self._emitted += len(clean)
        return self.remaining()

    def remaining(self):
        return max(0, int(self.options["maxItems"]) - self._emitted)

    def progress(self, message=None, pages=None):
        _send("progress", {"message": None if message is None else str(message), "pagesDelta": None if pages is None else int(pages)})

    async def sleep(self, seconds):
        """Waits (seconds, max 60 per call). Requests are already rate-limited."""
        await _call("sleep", {"ms": max(0, float(seconds or 0)) * 1000})

    async def retry(self, fn, retries=2, delay=2.0, factor=2.0):
        """await ctx.retry(lambda attempt: ctx.fetch(url)) — retries with backoff."""
        retries = max(0, min(10, int(retries)))
        delay = max(0.0, float(delay))
        attempt = 0
        while True:
            try:
                result = fn(attempt)
                if _inspect.isawaitable(result):
                    result = await result
                return result
            except Exception as e:
                if attempt >= retries:
                    raise
                self.log.warn("Attempt %d failed (%s); retrying in %.1f s" % (attempt + 1, _text(e), delay))
                await self.sleep(delay)
                delay *= max(1.0, float(factor))
                attempt += 1


def _user_traceback(exc):
    frames = [f for f in _traceback.extract_tb(exc.__traceback__) if f.filename == _USER_FILE]
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):")
        lines.extend(l.rstrip("\n") for l in _traceback.format_list(frames[-8:]))
    lines.extend(l.rstrip("\n") for l in _traceback.format_exception_only(type(exc), exc))
    return "\n".join(lines)


def _failure(exc):
    if isinstance(exc, ScraperError) and getattr(exc, "_from_host", False) and exc.type in _HOST_TYPES:
        return {"ok": False, "error": {"type": exc.type, "message": exc.message}}
    if isinstance(exc, MemoryError):
        return {"ok": False, "error": {"type": "custom_code_memory", "message": "Your scraper ran out of memory (sandbox limit) and was stopped."}}
    if isinstance(exc, RecursionError):
        return {"ok": False, "error": {"type": "custom_code_error", "message": "Your scraper exceeded the maximum recursion depth (infinite recursion?)."}}
    return {"ok": False, "error": {"type": "custom_code_error", "message": ("Your scraper threw an error: " + _user_traceback(exc))[:1500]}}


async def __metacode_run(code, init_json):
    try:
        ctx = Context(_json.loads(init_json))
        lines = code.splitlines(True)
        _linecache.cache[_USER_FILE] = (len(code), None, lines, _USER_FILE)
        try:
            compiled = compile(code, _USER_FILE, "exec")
        except SyntaxError as e:
            where = " (scraper.py, line %s)" % e.lineno if e.lineno else ""
            return _dumps({"ok": False, "error": {"type": "custom_code_error", "message": "SyntaxError: %s%s" % (e.msg, where)}})
        namespace = {"__name__": "__scraper__", "ScraperError": ScraperError}
        exec(compiled, namespace)
        scrape = namespace.get("scrape")
        if not callable(scrape):
            return _dumps({"ok": False, "error": {"type": "custom_code_error",
                                                  "message": "Define a function named scrape, e.g.  async def scrape(ctx): …"}})
        result = scrape(ctx)
        if _inspect.isawaitable(result):
            result = await result
        data, meta = [], None
        if isinstance(result, (list, tuple)):
            data = list(result)
        elif isinstance(result, dict):
            if "data" in result:
                if not isinstance(result["data"], (list, tuple)):
                    raise TypeError('scrape() returned {"data": ...} that is not a list')
                data = list(result["data"])
            if isinstance(result.get("meta"), dict):
                meta = result["meta"]
        elif result is not None:
            raise TypeError("scrape() must return a list of records, {'data': [...]}, or None (records sent with ctx.emit are kept)")
        if data:
            ctx.emit(data)
        return _dumps({"ok": True, "emitted": ctx._emitted, "meta": meta})
    except BaseException as exc:  # noqa: BLE001 — every failure becomes a job error
        try:
            return _dumps(_failure(exc))
        except BaseException:
            return _dumps({"ok": False, "error": {"type": "custom_code_error", "message": "Your scraper failed: " + type(exc).__name__}})
