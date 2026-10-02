// Python custom code: Pyodide (CPython in WebAssembly) in a locked-down child
// process. Same contract as the JavaScript sandbox, Python naming.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sandboxSupported } = require('../scraper/sandbox/custom-runner');
const { ScraperError } = require('../scraper/errors');
const { harness } = require('./helpers/sandbox-harness');

const support = sandboxSupported('python');
const skip = !support.ok && support.reason;

const py = (h, code) => h.run(code, 'python');

test('python: SDK pagination, emit, return value, print → log, meta, stdlib', { skip }, async () => {
  const h = harness();
  await py(h, `
import statistics

async def scrape(ctx):
    scores = []
    async for page in ctx.reddit.pages("/r/" + ctx.target["subreddit"] + "/new"):
        ctx.emit(page["records"])
        scores += [p["score"] for p in page["records"]]
    print("params", ctx.params["n"], "pages", len(scores))
    thread = await ctx.reddit.post("x")
    return {"data": [{"custom": True, "comments": len(thread["comments"]), "more": thread["more_count"],
                      "title": thread["post"]["title"], "mean": statistics.mean(scores)}],
            "meta": {"pages": 2}}
`);
  assert.deepEqual(h.out.records.slice(0, 3).map(r => r.post_id), ['tes001', 'tes002', 'tes003']);
  assert.equal(h.out.records[3].custom, true);
  assert.equal(h.out.records[3].comments, 1);
  assert.equal(h.out.records[3].more, 3);
  assert.equal(h.out.records[3].title, 'Post 1 in test');
  assert.equal(typeof h.out.records[3].mean, 'number');
  assert.deepEqual(h.out.meta.custom, { pages: 2 });
  assert.ok(h.out.logs.includes('info [code] params 2 pages 3'), h.out.logs.join('\n'));
  assert.ok(h.out.calls[1].url.includes('after=t3_next'));
});

test('python: ctx.fetch returns a requests-style response with filtered headers', { skip }, async () => {
  const h = harness();
  await py(h, `
async def scrape(ctx):
    r = await ctx.fetch("https://www.reddit.com/r/test/new.json", headers={"accept": "application/json"})
    r.raise_for_status()
    return [{"ok": r.ok, "status": r.status_code, "type": r.headers.get("Content-Type"),
             "cookie": r.headers.get("set-cookie"), "n": len(r.json()["data"]["children"])}]
`);
  assert.deepEqual(h.out.records, [{ ok: true, status: 200, type: 'application/json', cookie: null, n: 2 }]);
});

test('python: errors show a traceback of the user code; syntax errors and a missing scrape() are explained', { skip }, async () => {
  const h = harness();
  await assert.rejects(py(h, 'async def scrape(ctx):\n    x = 1\n    raise ValueError("boom")\n'),
    err => err.type === 'custom_code_error' && /ValueError: boom/.test(err.message) && /scraper\.py", line 3, in scrape/.test(err.message) && !/metacode_sdk/.test(err.message));
  await assert.rejects(py(h, 'async def scrape(ctx:\n    pass\n'), err => err.type === 'custom_code_error' && /SyntaxError/.test(err.message) && /line 1/.test(err.message));
  await assert.rejects(py(h, 'x = 1\n'), err => /Define a function named scrape/.test(err.message));
  await assert.rejects(py(h, 'async def scrape(ctx):\n    return 42\n'), err => /must return a list/.test(err.message));
  await assert.rejects(py(h, 'def scrape(ctx):\n    return scrape(ctx)\n'), err => /recursion/.test(err.message));
});

test('python: a plain (non-async) scrape() works; datetimes are serialized', { skip }, async () => {
  const h = harness();
  await py(h, 'import datetime\ndef scrape(ctx):\n    return [{"when": datetime.date(2024, 1, 2), "tags": {"a"}}]\n');
  assert.deepEqual(h.out.records, [{ when: '2024-01-02', tags: ['a'] }]);
});

test('python: host errors keep their type, and can be caught as ScraperError', { skip }, async () => {
  const h = harness({ request: async () => { throw new ScraperError('host_not_allowed', 'The scraper may only request Reddit.'); } });
  await assert.rejects(py(h, 'async def scrape(ctx):\n    await ctx.fetch("https://example.com/")\n'), err => err.type === 'host_not_allowed');
  const caught = harness({ request: async () => { throw new ScraperError('rate_limited', 'Reddit is rate-limiting'); } });
  await py(caught, `
async def scrape(ctx):
    try:
        await ctx.fetch("https://www.reddit.com/")
    except ScraperError as e:
        return [{"type": e.type, "msg": str(e)}]
`);
  assert.deepEqual(caught.out.records, [{ type: 'rate_limited', msg: 'Reddit is rate-limiting' }]);
});

test('python: infinite loops are stopped at the time limit; records emitted before are kept', { skip }, async () => {
  const h = harness(null, { customTimeoutMs: 1500 });
  const t0 = Date.now();
  await assert.rejects(py(h, 'async def scrape(ctx):\n    ctx.emit({"a": 1})\n    while True:\n        pass\n'), err => err.type === 'custom_code_timeout');
  assert.ok(Date.now() - t0 < 15000);
  assert.deepEqual(h.out.records, [{ a: 1 }]);
});

test('python: memory is capped (MemoryError can be caught; otherwise the job fails cleanly)', { skip }, async () => {
  const h = harness(null, { customPythonMemoryMb: 128 });
  await py(h, `
async def scrape(ctx):
    blocks = []
    try:
        while True:
            blocks.append(bytearray(8_000_000))
    except MemoryError:
        n = len(blocks)
        blocks = None
        return [{"caught": True, "mb": n * 8}]
`);
  assert.equal(h.out.records[0].caught, true);
  assert.ok(h.out.records[0].mb < 128);
  const bomb = harness(null, { customPythonMemoryMb: 128 });
  await assert.rejects(py(bomb, 'async def scrape(ctx):\n    x = []\n    while True:\n        x.append("y" * 1000000)\n'),
    err => ['custom_code_memory', 'custom_code_timeout'].includes(err.type));
});

test('python isolation: no Node, no network, no host files, no programs, no secrets', { skip }, async () => {
  process.env.METACODE_TEST_SECRET = 'do-not-leak';
  const h = harness(null, { customTimeoutMs: 20000 });
  await py(h, `
import os, socket, asyncio, subprocess, urllib.request

async def scrape(ctx):
    res = {}
    async def probe(name, fn):
        try:
            value = fn()
            if hasattr(value, "__await__"):
                value = await value
            res[name] = "OPEN"
        except BaseException as e:
            res[name] = "blocked"
    import js, pyodide_js
    await probe("js.process", lambda: js.process)
    await probe("js.fetch", lambda: js.fetch)
    await probe("js.require", lambda: js.require)
    await probe("function_constructor", lambda: js.setTimeout.constructor("return process")())
    await probe("run_js", lambda: __import__("pyodide.code").code.run_js("1"))
    await probe("node_sockets", lambda: pyodide_js.useNodeSockFS())
    await probe("node_sockets_internal", lambda: pyodide_js._api.initializeNodeSockFS())
    await probe("mount_host_dir", lambda: pyodide_js.mountNodeFS("/host", "/"))
    await probe("nodefs", lambda: pyodide_js.FS.filesystems.NODEFS)
    await probe("load_package", lambda: pyodide_js.loadPackage("https://example.com/x.whl"))
    await probe("module_require", lambda: pyodide_js._module.require)
    await probe("host_bridge_import", lambda: __import__("_metacode_host"))
    await probe("socket", lambda: socket.create_connection(("93.184.215.14", 80), timeout=3))
    await probe("asyncio_open_connection", lambda: asyncio.wait_for(asyncio.open_connection("93.184.215.14", 80), 3))
    await probe("urllib", lambda: urllib.request.urlopen("http://example.com", timeout=3))
    await probe("pyfetch", lambda: __import__("pyodide.http").http.pyfetch("http://example.com"))
    await probe("os_system", lambda: os.system("id"))
    await probe("subprocess", lambda: subprocess.run(["id"]))
    await probe("read_server_file", lambda: open("/home/user/metacode/server.js").read())
    res["secret_in_env"] = any("do-not-leak" in str(v) for v in os.environ.values())
    return [res]
`);
  const r = h.out.records[0];
  assert.equal(r.secret_in_env, false);
  delete r.secret_in_env;
  for (const [name, outcome] of Object.entries(r)) assert.equal(outcome, 'blocked', name);
  assert.equal(Object.keys(r).length, 19);
  delete process.env.METACODE_TEST_SECRET;
});

test('python: every Python example on the Scraper page runs', { skip }, async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'scraper.js'), 'utf8');
  const literal = src.slice(src.indexOf('const TEMPLATES = {') + 'const TEMPLATES = '.length, src.indexOf('\n  };\n', src.indexOf('const TEMPLATES = {')) + 4);
  const templates = vm.runInNewContext('(' + literal + ')');
  const keys = Object.keys(templates).filter(k => templates[k].language === 'python');
  assert.ok(keys.length >= 5);
  for (const key of keys) {
    const h = harness();
    // Parameters every example understands (the post example needs a post id).
    const params = { postId: 'abc123', subreddit: 'test', subreddits: ['test'], keywords: ['post'] };
    await h.run(templates[key].code, 'python', { params }).catch(err => assert.fail(key + ': ' + err.message));
    assert.ok(h.out.records.length > 0, key + ' produced no records');
  }
});

test('python and javascript report availability separately', () => {
  assert.equal(typeof sandboxSupported('python').ok, 'boolean');
  assert.equal(typeof sandboxSupported('javascript').ok, 'boolean');
});
