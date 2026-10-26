# ══════════════════════════════════════════════
#  lab-prelude.py — the AI Coding Lab's harness for Python coding rules
#
#  Runs INSIDE the Pyodide sandbox (scraper/sandbox/python-child.js, started
#  by ai-lab/code-sandbox.js), never in the server's own Python. In order:
#
#    1. the static policy analyzer reads the code with `ast` (nothing is
#       executed) and sends its findings to the parent;
#    2. 'analyze' mode stops there; any error finding stops the run too;
#    3. the code runs with a reduced set of builtins and an importer that
#       admits only the allowed standard-library modules;
#    4. records are pulled from the parent in batches (`input.next`, the
#       only host call there is) and classify(record, variable) is called
#       once per record; results go back in batches of about 256 KB.
#
#  The policy and the reduced builtins are defence in depth: the boundary
#  is the WebAssembly engine inside a locked-down process (python-child.js).
#  Only JSON strings cross the bridge.
# ══════════════════════════════════════════════

import ast as _ast
import builtins as _builtins
import inspect as _inspect
import json as _json
import linecache as _linecache
import re as _re
import sys as _sys
import time as _time
import traceback as _traceback
import warnings as _warnings

from _metacode_host import call as _host_call, send as _host_send

_USER_FILE = "rule.py"
# Tests turn this off (by editing a copy of this file) to show the runtime
# guards hold on their own. It is never configurable from outside.
_ENFORCE_POLICY = True
_BATCH_CHARS = 256 * 1024
_MAX_RESULT_CHARS = 64 * 1024
_PROGRESS_EVERY = 50
_TRACE_FRAMES = 6
_MAX_CODE_BYTES = 100 * 1024
_MAX_CODE_LINES = 3000
_MAX_FINDINGS = 50


def _no_processes(*args, **kwargs):
    raise PermissionError("Running programs isn't available in the MetaCode sandbox")


import os as _os
for _name in ("system", "popen", "fork", "forkpty", "execv", "execve", "execl", "execle", "execlp", "execvp", "execvpe",
              "spawnl", "spawnle", "spawnv", "spawnve", "posix_spawn", "posix_spawnp", "kill", "killpg"):
    if hasattr(_os, _name):
        setattr(_os, _name, _no_processes)
del _name


# ── Runtime audit hook (defence in depth; can't be removed) ───────────────────
# Installed after the prelude's own imports and armed just before user code.
# Even code that reaches Python's internals past the static policy (e.g. via a
# str.format field or a reached real __import__) is refused the dangerous
# *operations* themselves: opening files, running programs, sockets, ctypes,
# and building/running code at run time. The events fire from the C
# implementations, so reaching a module another way (e.g. raw `_socket`) is
# caught all the same. We do NOT block `import` by module name here: CPython's
# own standard library imports "system" modules internally (e.g. _strptime
# imports _thread, time and locale), so a run-time import allow-list breaks
# legitimate allowed-module calls. The module allow-list is enforced instead by
# the static policy and the guarded importer (direct user imports), while the
# operation events above neutralise what a reached module could actually do.
_AUDIT_ENFORCE = False       # armed in __metacode_run, before the user's code runs
_AUDIT_PROCESS_EVENTS = frozenset((
    "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "subprocess.Popen",
))


def _audit_in_import():
    """True when the current operation is the import machinery reading a
    module's own source, so legitimately importing an allowed module at call
    time isn't mistaken for the user opening a file."""
    try:
        frame = _sys._getframe(2)
    except BaseException:
        return False
    while frame is not None:
        name = frame.f_code.co_filename
        if "importlib" in name or name.startswith("<frozen "):
            return True
        frame = frame.f_back
    return False


def _audit_user_on_stack():
    """True when a frame of the user's own file is executing right now. Used to
    block exec/compile only for the user's code: the harness compiles the
    user's code and renders tracebacks (which parse source lines) itself, and
    those must not be mistaken for the user building code at run time."""
    try:
        frame = _sys._getframe(2)
    except BaseException:
        return False
    while frame is not None:
        if frame.f_code.co_filename == _USER_FILE:
            return True
        frame = frame.f_back
    return False


def _audit_hook(event, args):
    if not _AUDIT_ENFORCE:
        return
    if event == "open":
        if _audit_in_import():
            return
        raise PermissionError("Opening files isn't available in the MetaCode sandbox")
    if event in _AUDIT_PROCESS_EVENTS:
        raise PermissionError("Running programs isn't available in the MetaCode sandbox")
    if event.startswith("socket."):
        raise PermissionError("Network access isn't available in the MetaCode sandbox")
    if event.startswith("ctypes."):
        raise PermissionError("Calling native code (ctypes) isn't available in the MetaCode sandbox")
    if event in ("exec", "compile") and _audit_user_on_stack():
        raise PermissionError("Building or running code at run time isn't available in the MetaCode sandbox")


try:
    _sys.addaudithook(_audit_hook)
    _AUDIT_AVAILABLE = True
except BaseException:   # Pyodide builds without audit-hook support: the static policy and reduced builtins still apply.
    _AUDIT_AVAILABLE = False


# ── Static policy (rule names match ai-lab/code-policy.js where they apply) ──

_NETWORK_MODULES = frozenset((
    "requests", "urllib", "urllib3", "http", "httpx", "aiohttp", "socket", "ssl", "ftplib", "smtplib", "poplib",
    "imaplib", "telnetlib", "socketserver", "xmlrpc", "websocket", "websockets", "asyncio", "select", "selectors",
    "email", "webbrowser", "pyodide", "pyodide_js", "js", "micropip",
))
_SYSTEM_MODULES = frozenset((
    "os", "sys", "subprocess", "shutil", "pathlib", "io", "glob", "tempfile", "fileinput", "ctypes", "importlib",
    "builtins", "pickle", "marshal", "shelve", "multiprocessing", "threading", "_thread", "signal", "resource", "pty",
    "fcntl", "posix", "gc", "inspect", "code", "codeop", "runpy", "pkgutil", "zipimport", "mmap", "sqlite3", "dbm",
    "platform", "site", "linecache", "traceback", "types", "weakref", "atexit", "faulthandler",
))
_FORBIDDEN_CALLS = {
    "eval": "eval() can't be used: a coding rule may not run code built from strings.",
    "exec": "exec() can't be used: a coding rule may not run code built from strings.",
    "compile": "compile() can't be used: a coding rule may not build code at run time.",
    "__import__": "__import__() can't be used: write a plain import of an allowed module.",
    "open": "open() can't be used: the sandbox has no files.",
    "input": "input() can't be used: a coding rule gets its data from the record.",
    "breakpoint": "breakpoint() isn't available in the sandbox.",
    "help": "help() isn't available in the sandbox.",
    "exit": "exit() isn't available: return a value from classify instead.",
    "quit": "quit() isn't available: return a value from classify instead.",
    "globals": "globals() can't be used: a coding rule may not inspect namespaces.",
    "locals": "locals() can't be used: a coding rule may not inspect namespaces.",
    "vars": "vars() can't be used: a coding rule may not inspect namespaces.",
    "memoryview": "memoryview() isn't available in the sandbox.",
}
_ATTR_FUNCTIONS = ("getattr", "setattr", "delattr")
_ATTR_FACTORIES = ("attrgetter", "methodcaller")
# str.format field specs ("{0.__class__}") and string.Formatter do attribute/
# item traversal at run time from a plain string the AST can't see; forbid the
# APIs that read a format/field string other than the checked str.format.
_FORBIDDEN_FORMAT_ATTRS = frozenset(("format_map", "vformat", "get_field", "Formatter"))
_DUNDER_TOKEN = _re.compile(r"__[A-Za-z0-9]+__")
_ALLOWED_DUNDER_ATTRS = frozenset(("__name__", "__doc__", "__init__"))
_ALLOWED_DUNDER_STRINGS = frozenset(("__name__", "__doc__", "__init__", "__main__"))
_FORBIDDEN_NAMES = frozenset(("__builtins__", "__loader__", "__spec__", "__import__", "__file__"))
# Allowed modules import system modules for themselves (random._os,
# dataclasses.sys, …); reaching them through an attribute is refused too.
_MODULE_LEAKS = frozenset((
    "os", "_os", "sys", "_sys", "posix", "builtins", "_builtins", "importlib", "_imp", "_bootstrap", "subprocess",
    "socket", "_socket", "inspect", "_inspect", "ctypes", "gc", "js", "pyodide", "pyodide_js", "_pyodide", "modules",
))
_HIDDEN_WORDS = ("__import__", "importlib", "subprocess", "os.system", "os.popen", "socket", "builtins",
                 "__subclasses__", "__globals__", "__builtins__", "__class__", "__bases__", "__mro__", "__code__")
_NOW_ATTRS = frozenset(("now", "utcnow", "today"))


def _module_advice(top, allowed):
    if top in _NETWORK_MODULES:
        return "Module '%s' isn't available: there is no network in the sandbox. A coding rule can only look at the record it's given." % top
    if top in _SYSTEM_MODULES:
        return "Module '%s' isn't available: the sandbox has no files or programs." % top
    if top == "time":
        return "Module 'time' isn't available: a coding rule must give the same answer every time (use the record's timestamp)."
    return "Module '%s' isn't available in the sandbox. Allowed modules: %s." % (top, ", ".join(sorted(allowed)))


class _Policy:
    def __init__(self, code, allowed):
        self.lines = code.splitlines()
        self.allowed = frozenset(allowed)
        self.findings = []
        self._seen = set()

    def add(self, rule, severity, message, node=None, line=None, column=None):
        if node is not None:
            line = getattr(node, "lineno", None)
            offset = getattr(node, "col_offset", None)
            column = None if offset is None else offset + 1
        key = (rule, line, message)
        if key in self._seen or len(self.findings) >= _MAX_FINDINGS:
            return
        self._seen.add(key)
        excerpt = ""
        if isinstance(line, int) and 1 <= line <= len(self.lines):
            excerpt = self.lines[line - 1].strip()[:160]
        self.findings.append({"rule": rule, "severity": severity, "message": message[:300],
                              "line": line, "column": column, "excerpt": excerpt})

    # Loop exits that belong to this loop: break at this loop's level, or
    # return / raise anywhere except inside nested functions and classes.
    def _exits(self, statements, nested_loop=False):
        for stmt in statements:
            if isinstance(stmt, (_ast.Return, _ast.Raise)):
                return True
            if isinstance(stmt, _ast.Break) and not nested_loop:
                return True
            if isinstance(stmt, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
                continue
            is_loop = isinstance(stmt, (_ast.For, _ast.AsyncFor, _ast.While))
            # A loop's own body: its breaks are its own. Its else block isn't part of it.
            if self._exits(getattr(stmt, "body", None) or [], nested_loop or is_loop):
                return True
            for block in (getattr(stmt, "orelse", None), getattr(stmt, "finalbody", None)):
                if isinstance(block, list) and self._exits(block, nested_loop):
                    return True
            for handler in getattr(stmt, "handlers", None) or []:
                if self._exits(handler.body, nested_loop):
                    return True
            for case in getattr(stmt, "cases", None) or []:
                if self._exits(case.body, nested_loop):
                    return True
        return False

    def _bound_names(self, tree):
        names = set()
        for node in _ast.walk(tree):
            if isinstance(node, _ast.Name) and isinstance(node.ctx, (_ast.Store, _ast.Del)):
                names.add(node.id)
            elif isinstance(node, _ast.arg):
                names.add(node.arg)
            elif isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
                names.add(node.name)
            elif isinstance(node, _ast.alias):
                names.add((node.asname or node.name).split(".")[0])
            elif isinstance(node, _ast.ExceptHandler) and node.name:
                names.add(node.name)
            elif isinstance(node, (_ast.MatchAs, _ast.MatchStar)) and node.name:
                names.add(node.name)
            elif isinstance(node, _ast.MatchMapping) and node.rest:
                names.add(node.rest)
        return names

    # Names bound by imports of refused modules (already reported once).
    def _refused_names(self, tree):
        names = set()
        for node in _ast.walk(tree):
            if isinstance(node, _ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] not in self.allowed:
                        names.add(alias.asname or alias.name.split(".")[0])
            elif isinstance(node, _ast.ImportFrom) and (node.level or (node.module or "").split(".")[0] not in self.allowed):
                names.update(alias.asname or alias.name for alias in node.names)
        return names

    def _check_imports(self, node):
        if isinstance(node, _ast.ImportFrom):
            if node.level:
                self.add("forbidden_import", "error", "Relative imports aren't available: a coding rule is a single file.", node)
                return
            modules = [node.module or ""]
            for alias in node.names:
                if alias.name in _ATTR_FACTORIES and alias.asname:
                    self.add("forbidden_call", "error", "Import %s without renaming it, so its use can be checked." % alias.name, node)
        else:
            modules = [alias.name for alias in node.names]
        for module in modules:
            top = module.split(".")[0]
            if top not in self.allowed:
                self.add("forbidden_import", "error", _module_advice(top, self.allowed), node)
            elif top == "random":
                self.add("nondeterministic", "warning", "random gives different answers on each run, so results can't be reproduced.", node)

    def _check_call(self, node):
        func = node.func
        name = func.id if isinstance(func, _ast.Name) else func.attr if isinstance(func, _ast.Attribute) else None
        if isinstance(func, _ast.Name) and name in _FORBIDDEN_CALLS:
            self.add("forbidden_call", "error", _FORBIDDEN_CALLS[name], node)
        if isinstance(func, _ast.Name) and name in _ATTR_FUNCTIONS:
            attr = node.args[1] if len(node.args) > 1 else None
            if not (isinstance(attr, _ast.Constant) and isinstance(attr.value, str)) or attr.value.startswith("__"):
                self.add("forbidden_call", "error",
                         "%s() needs a constant attribute name here (no names built at run time, no double-underscore names)." % name, node)
        if name in _ATTR_FACTORIES:
            # attrgetter(*names) / methodcaller(name, *args): the names must be plain constants.
            names = list(node.args) if name == "attrgetter" else list(node.args[:1])
            if not names or node.keywords and name == "attrgetter" or \
               any(not (isinstance(a, _ast.Constant) and isinstance(a.value, str)) or "__" in a.value for a in names):
                self.add("forbidden_call", "error", "%s() needs constant names without double underscores." % name, node)
        if name == "fromhex":
            self.add("obfuscation", "warning", "bytes.fromhex() hides text in hex, which makes the code hard to check.", node)
        if name in _FORBIDDEN_FORMAT_ATTRS:
            self.add("forbidden_call", "error",
                     "%s isn't available: it reads attribute or item access from a string at run time, which the policy can't inspect (plain str.format with a checked field string is fine)." % name, node)

    # A string literal, or a '+' chain of only string literals folded into one
    # ('{0.' + '__cla' + 'ss__}'): otherwise the dunder check below is evaded by
    # splitting the name across concatenation.
    def _fold_str(self, node):
        if isinstance(node, _ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, _ast.BinOp) and isinstance(node.op, _ast.Add):
            left = self._fold_str(node.left)
            if left is None:
                return None
            right = self._fold_str(node.right)
            if right is None:
                return None
            return left + right
        return None

    def _check_string(self, value, node):
        bad = [t for t in _DUNDER_TOKEN.findall(value) if t not in _ALLOWED_DUNDER_STRINGS]
        if bad:
            self.add("forbidden_attribute", "error",
                     "The string '%s' names one of Python's internals ('%s'); reaching internals by name isn't allowed." % (value[:40], bad[0]), node)
            return
        for word in _HIDDEN_WORDS:
            if word in value:
                self.add("obfuscation", "warning", "This string mentions '%s'; hidden names are a common way to sneak code past checks." % word, node)
                break
        if len(value) > 2000 and len(value.strip(" \n\r\tABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-")) == 0:
            self.add("obfuscation", "warning", "A very long encoded-looking string (%d characters) hides what the code does." % len(value), node)

    def run(self, code):
        if len(code.encode("utf-8", "replace")) > _MAX_CODE_BYTES or len(self.lines) > _MAX_CODE_LINES:
            self.add("size", "error", "The code is too long (at most 100 KB and 3000 lines).", line=None)
            return self.findings
        try:
            with _warnings.catch_warnings():
                _warnings.simplefilter("ignore")   # compile() reports them again when the code runs
                tree = _ast.parse(code, filename=_USER_FILE)
        except SyntaxError as e:
            self.add("syntax", "error", "SyntaxError: %s" % (e.msg or "invalid syntax"), line=e.lineno, column=e.offset)
            return self.findings
        except (ValueError, RecursionError, MemoryError) as e:
            self.add("syntax", "error", "The code can't be read: %s" % type(e).__name__, line=None)
            return self.findings

        bound = self._bound_names(tree)
        refused = self._refused_names(tree)
        called = set()
        inner_binops = set()   # '+' chains that are part of a larger folded chain (checked once, at the top)
        chr_calls = 0
        for node in _ast.walk(tree):
            if isinstance(node, _ast.Call):
                called.add(id(node.func))
            elif isinstance(node, _ast.BinOp) and isinstance(node.op, _ast.Add):
                for side in (node.left, node.right):
                    if isinstance(side, _ast.BinOp) and isinstance(side.op, _ast.Add) and self._fold_str(side) is not None:
                        inner_binops.add(id(side))

        for node in _ast.walk(tree):
            if isinstance(node, (_ast.Import, _ast.ImportFrom)):
                self._check_imports(node)
            elif isinstance(node, _ast.Call):
                self._check_call(node)
                if isinstance(node.func, _ast.Name) and node.func.id == "chr":
                    chr_calls += 1
            elif isinstance(node, _ast.Name):
                if node.id in _FORBIDDEN_NAMES:
                    self.add("forbidden_name", "error", "'%s' is off limits: it reaches Python's internals." % node.id, node)
                elif id(node) not in called and isinstance(node.ctx, _ast.Load):
                    if node.id in _FORBIDDEN_CALLS and node.id not in bound:
                        self.add("forbidden_call", "error", _FORBIDDEN_CALLS[node.id], node)
                    elif node.id in _ATTR_FUNCTIONS + _ATTR_FACTORIES and node.id not in bound:
                        self.add("forbidden_call", "error",
                                 "%s may only be called directly with a constant name (passing it around hides what it reaches)." % node.id, node)
                    elif node.id == "Formatter" and node.id not in bound:
                        self.add("forbidden_call", "error",
                                 "Formatter isn't available: it reads attribute or item access from a string at run time, which the policy can't inspect.", node)
                    elif node.id == "chr":
                        chr_calls += 4   # map(chr, …) and the like
            elif isinstance(node, _ast.Attribute):
                attr = node.attr
                if attr.startswith("__") and attr not in _ALLOWED_DUNDER_ATTRS:
                    self.add("forbidden_attribute", "error",
                             "Attribute '%s' is off limits: double-underscore attributes reach Python's internals." % attr, node)
                elif attr in _FORBIDDEN_FORMAT_ATTRS and id(node) not in called:
                    self.add("forbidden_call", "error",
                             "%s isn't available: it reads attribute or item access from a string at run time, which the policy can't inspect." % attr, node)
                elif attr in _MODULE_LEAKS and not (isinstance(node.value, _ast.Name) and node.value.id in refused):
                    self.add("forbidden_attribute", "error",
                             "'.%s' reaches a system module through another module; the sandbox has no files, programs or network." % attr, node)
                elif attr in _ATTR_FACTORIES and id(node) not in called:
                    self.add("forbidden_call", "error",
                             "%s may only be called directly with constant names (passing it around hides what it reaches)." % attr, node)
                elif attr in _NOW_ATTRS and isinstance(node.value, (_ast.Name, _ast.Attribute)):
                    self.add("nondeterministic", "warning", "%s() changes between runs; use the record's timestamp instead." % attr, node)
            elif isinstance(node, _ast.MatchClass):
                for attr in node.kwd_attrs:
                    if attr.startswith("__") and attr not in _ALLOWED_DUNDER_ATTRS:
                        self.add("forbidden_attribute", "error",
                                 "Attribute '%s' is off limits: double-underscore attributes reach Python's internals." % attr, node)
            elif isinstance(node, _ast.Constant) and isinstance(node.value, str):
                self._check_string(node.value, node)
            elif isinstance(node, _ast.BinOp) and isinstance(node.op, _ast.Add) and id(node) not in inner_binops:
                folded = self._fold_str(node)
                if folded is not None:
                    self._check_string(folded, node)
            elif isinstance(node, _ast.While):
                test = node.test
                if isinstance(test, _ast.Constant) and test.value and not self._exits(node.body):
                    self.add("infinite_loop", "error",
                             "This 'while %r' loop has no break, return or raise, so it never ends." % (test.value,), node)
        if chr_calls >= 4:
            self.add("obfuscation", "warning", "Building text from many chr() calls hides what the code does.", line=None)

        classify = [n for n in tree.body if isinstance(n, (_ast.FunctionDef, _ast.AsyncFunctionDef)) and n.name == "classify"]
        if not classify:
            self.add("contract", "error", "Define a top-level function: def classify(record, variable):", line=None)
        elif isinstance(classify[-1], _ast.AsyncFunctionDef):
            self.add("contract", "error", "classify must be a regular def, not async def (it returns its answer directly).", classify[-1])
        elif self._yields(classify[-1].body):
            self.add("contract", "error", "classify must return a value; it can't be a generator (yield).", classify[-1])
        self.findings.sort(key=lambda f: (f["line"] or 0, f["column"] or 0))
        return self.findings

    def _yields(self, statements):
        stack = list(statements)
        while stack:
            node = stack.pop()
            if isinstance(node, (_ast.Yield, _ast.YieldFrom)):
                return True
            if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.Lambda, _ast.ClassDef)):
                continue
            stack.extend(_ast.iter_child_nodes(node))
        return False


def _analyze(code, allowed):
    return _Policy(code, allowed).run(code)


# ── Running the code ─────────────────────────────────────────────────────────

_REMOVED_BUILTINS = ("open", "eval", "exec", "compile", "input", "breakpoint", "help", "exit", "quit", "globals",
                     "locals", "vars", "memoryview", "__loader__", "__spec__")


# Private helpers that allowed modules import from C code through the *calling* frame's
# builtins — e.g. datetime.strptime imports _strptime while the rule's frame is on top. The
# static policy still refuses `import _strptime` written in a rule; this only lets the
# allowed modules work.
_INTERNAL_HELPERS = frozenset(("_strptime", "_datetime", "_pydatetime", "_decimal", "_pydecimal", "_json",
                               "_heapq", "_bisect", "_random", "_statistics", "_string", "_sre",
                               "_functools", "_operator", "_collections", "_collections_abc", "_abc"))


def _safe_builtins(allowed):
    allowed = frozenset(allowed)
    real_import = _builtins.__import__

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        top = str(name).split(".")[0]
        if level or (top not in allowed and top not in _INTERNAL_HELPERS):
            raise ImportError("Module '%s' isn't available in the MetaCode sandbox" % name)
        return real_import(name, globals, locals, fromlist, level)

    table = {k: v for k, v in _builtins.__dict__.items() if k not in _REMOVED_BUILTINS}
    table["__import__"] = guarded_import
    return table


def _user_traceback(exc):
    frames = [f for f in _traceback.extract_tb(exc.__traceback__) if f.filename == _USER_FILE]
    lines = []
    if frames:
        lines.append("Traceback (most recent call last):")
        lines.extend(l.rstrip("\n") for l in _traceback.format_list(frames[-_TRACE_FRAMES:]))
    lines.extend(l.rstrip("\n") for l in _traceback.format_exception_only(type(exc), exc))
    return "\n".join(lines)[:4000]


def _record_error(exc):
    """'Type: message' and then the last frames of the user's file (like the JavaScript harness)."""
    lines = [l.rstrip("\n") for l in _traceback.format_exception_only(type(exc), exc)]
    frames = [f for f in _traceback.extract_tb(exc.__traceback__) if f.filename == _USER_FILE]
    lines.extend(l.rstrip("\n") for l in _traceback.format_list(frames[-_TRACE_FRAMES:]))
    return "\n".join(lines)[:4000]


def _dumps(value):
    return _json.dumps(value, ensure_ascii=False, allow_nan=False)


_INF = float("inf")


def _finite(value):
    """Carry non-finite floats across the JSON bridge as {"$nonfinite": "NaN"|
    "Infinity"|"-Infinity"} instead of letting json raise (which would turn a
    NaN confidence into a per-record error); the parent then reports it as an
    output problem and fails the run, like the JavaScript harness."""
    if isinstance(value, float):
        if value != value:
            return {"$nonfinite": "NaN"}
        if value == _INF:
            return {"$nonfinite": "Infinity"}
        if value == -_INF:
            return {"$nonfinite": "-Infinity"}
        return value
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def _fail(kind, message):
    return _dumps({"ok": False, "error": {"type": kind, "message": message[:4000]}})


def _send(name, text):
    problem = _host_send(name, text)
    if problem:
        raise RuntimeError(problem)


async def _next_batch():
    reply = _json.loads(await _host_call("input.next", "{}"))
    if not reply.get("ok"):
        err = reply.get("error") or {}
        raise RuntimeError(err.get("message") or "The sandbox couldn't read the records.")
    value = reply.get("value")
    return _json.loads(value) if value else {"records": [], "done": True}


def _one(classify, record, variable_json):
    rid = _dumps(str(record.get("id")))
    t0 = _time.perf_counter()
    try:
        out = classify(record, _json.loads(variable_json))
    except BaseException as exc:  # noqa: BLE001 — MemoryError/RecursionError too: recorded, the run goes on
        ms = round((_time.perf_counter() - t0) * 1000, 3)
        try:
            text = _record_error(exc)
        except BaseException:
            text = type(exc).__name__
        return True, '{"id":%s,"error":%s,"ms":%s}' % (rid, _dumps(text), _dumps(ms))
    ms = round((_time.perf_counter() - t0) * 1000, 3)
    problem = None
    try:
        if _inspect.isawaitable(out):
            problem = "classify must return a value, not a coroutine (it can't be async)"
            if hasattr(out, "close"):
                out.close()
        else:
            out_json = _dumps(_finite(out))
            if len(out_json) > _MAX_RESULT_CHARS:
                # Too big to carry back: send a marker so the parent reports it
                # as an output problem (and fails the run), not a record error.
                out_json = '{"$oversized": %d}' % len(out_json)
    except BaseException:  # noqa: BLE001 — not serialisable (or too deep)
        problem = "classify returned a value that isn't JSON"
    if problem:
        return True, '{"id":%s,"error":%s,"ms":%s}' % (rid, _dumps(problem), _dumps(ms))
    return False, '{"id":%s,"out":%s,"ms":%s}' % (rid, out_json, _dumps(ms))


async def __metacode_run(code, init_json):
    global _AUDIT_ENFORCE
    try:
        init = _json.loads(init_json)
        allowed = list(init.get("allowedModules") or [])
        findings = _analyze(code, allowed)
        _send("progress", _dumps({"policy": findings}))
        if init.get("mode") == "analyze":
            return _dumps({"ok": True, "emitted": 0, "meta": {"policy": findings}})
        blocking = [f for f in findings if f["severity"] == "error"]
        if blocking and _ENFORCE_POLICY:
            first = blocking[0]
            where = " (line %s)" % first["line"] if first["line"] else ""
            return _fail("policy_blocked", first["message"] + where)

        # Preload the allowed modules while the audit hook is still off, so a
        # rule that uses them hits cached imports; then arm the hook before the
        # user's code runs.
        for _m in list(allowed) + ["_strptime"]:
            try:
                _builtins.__import__(_m)
            except BaseException:
                pass
        _AUDIT_ENFORCE = _AUDIT_AVAILABLE

        _linecache.cache[_USER_FILE] = (len(code), None, code.splitlines(True), _USER_FILE)
        g = {"__name__": "metacode_rule", "__builtins__": _safe_builtins(allowed)}
        try:
            compiled = compile(code, _USER_FILE, "exec")
            exec(compiled, g)
        except MemoryError:
            return _fail("custom_code_memory", "Your coding rule ran out of memory (sandbox limit) while loading.")
        except BaseException as exc:  # noqa: BLE001 — top-level code failed
            return _fail("custom_code_error", "Your coding rule failed while loading: " + _user_traceback(exc))

        classify = g.get("classify")
        if not callable(classify):
            return _fail("contract_error", "Define a function classify(record, variable)")
        if _inspect.iscoroutinefunction(classify) or _inspect.isasyncgenfunction(classify):
            return _fail("contract_error", "classify must be a regular def, not async")
        if _inspect.isgeneratorfunction(classify):
            return _fail("contract_error", "classify must return a value; it can't be a generator (yield)")

        variable_json = _dumps(init.get("variable") or {})
        total = int(init.get("total") or 0)
        processed = errors = 0
        batch, batch_chars = [], 0
        while True:
            reply = await _next_batch()
            records = reply.get("records") or []
            for record in records:
                failed, item = _one(classify, record, variable_json)
                errors += 1 if failed else 0
                if batch and batch_chars + len(item) > _BATCH_CHARS:
                    _send("emit", "[" + ",".join(batch) + "]")
                    batch, batch_chars = [], 0
                batch.append(item)
                batch_chars += len(item) + 1
                processed += 1
                if processed % _PROGRESS_EVERY == 0:
                    _send("progress", _dumps({"done": processed, "total": total}))
            if reply.get("done") or not records:
                break
        if batch:
            _send("emit", "[" + ",".join(batch) + "]")
        if processed % _PROGRESS_EVERY:
            _send("progress", _dumps({"done": processed, "total": total}))
        return _dumps({"ok": True, "emitted": processed, "meta": {"processed": processed, "errors": errors}})
    except MemoryError:
        return _fail("custom_code_memory", "Your coding rule ran out of memory (sandbox limit) and was stopped.")
    except BaseException as exc:  # noqa: BLE001 — every failure becomes a run error
        try:
            return _fail("sandbox_error", "The Python harness failed: %s: %s" % (type(exc).__name__, str(exc)[:300]))
        except BaseException:
            return _fail("sandbox_error", "The Python harness failed.")
    finally:
        try:
            _sys.stdout.flush()
            _sys.stderr.flush()
        except BaseException:
            pass
