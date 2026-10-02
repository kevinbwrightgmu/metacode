/* ══════════════════════════════════════════════
   guest-prelude.js — the custom-scraper SDK

   Evaluated INSIDE the QuickJS sandbox (never in Node) before the user's
   code. It builds the `ctx` object passed to the user's scrape(ctx) out of
   two host functions installed by sandbox-child.js:

     __host_call(name, json) → Promise<json>   asynchronous host services
     __host_send(name, json)                   fire-and-forget (log, emit, progress)

   Everything crossing the boundary is a JSON string, so no host object ever
   enters the sandbox. The host side decides what each call may do (Reddit
   hosts only, GET/HEAD only, rate-limited, size-capped).
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  var hostCall = globalThis.__host_call;
  var hostSend = globalThis.__host_send;
  var F = globalThis.RedditFormat;
  delete globalThis.__host_call;
  delete globalThis.__host_send;

  function call(name, args) {
    return hostCall(name, JSON.stringify(args === undefined ? null : args)).then(function (text) {
      return text === undefined || text === '' ? null : JSON.parse(text);
    });
  }
  function send(name, args) { hostSend(name, JSON.stringify(args === undefined ? null : args)); }

  function stringify(x) {
    if (typeof x === 'string') return x;
    if (x instanceof Error) return x.name + ': ' + x.message;
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  }
  function logAt(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(stringify(arguments[i]));
      send('log', { level: level, message: parts.join(' ') });
    };
  }

  function makeResponse(r) {
    var headers = r.headers || {};
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.statusText || '',
      url: r.url,
      headers: {
        get: function (name) { var v = headers[String(name).toLowerCase()]; return v === undefined ? null : v; },
        has: function (name) { return Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()); },
        entries: function () { return Object.keys(headers).map(function (k) { return [k, headers[k]]; }); }
      },
      text: function () { return Promise.resolve(r.body); },
      json: function () {
        return new Promise(function (resolve) { resolve(JSON.parse(r.body)); }).catch(function (e) {
          throw new Error('Response from ' + r.url + ' is not valid JSON (' + e.message + ')');
        });
      }
    };
  }

  function sleep(ms) { return call('sleep', { ms: Number(ms) || 0 }); }

  async function retry(fn, opts) {
    opts = opts || {};
    var retries = Math.max(0, Math.min(10, opts.retries === undefined ? 2 : Number(opts.retries)));
    var delay = Math.max(0, Number(opts.delayMs === undefined ? 2000 : opts.delayMs));
    var factor = Math.max(1, Number(opts.factor === undefined ? 2 : opts.factor));
    for (var attempt = 0; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        if (attempt >= retries) throw e;
        ctx.log.warn('Attempt ' + (attempt + 1) + ' failed (' + stringify(e) + '); retrying in ' + Math.round(delay) + ' ms');
        await sleep(delay);
        delay *= factor;
      }
    }
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' };
  function decodeEntities(s) {
    return String(s === undefined || s === null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, function (m, e) {
      if (e[0] === '#') {
        var code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      var k = e.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
    });
  }
  function stripHtml(html) {
    return decodeEntities(String(html || '')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .trim();
  }
  function get(obj, path, fallback) {
    var parts = Array.isArray(path) ? path : String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return fallback;
      cur = cur[parts[i]];
    }
    return cur === undefined ? fallback : cur;
  }
  function pick(obj, keys) {
    var out = {};
    (keys || []).forEach(function (k) { out[k] = obj && obj[k] !== undefined ? obj[k] : null; });
    return out;
  }
  function unique(arr, keyFn) {
    var seen = new Set();
    return (arr || []).filter(function (x) {
      var k = keyFn ? keyFn(x) : x;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function chunk(arr, size) {
    var out = [];
    size = Math.max(1, size | 0);
    for (var i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  function matchAll(re, text) {
    if (!(re instanceof RegExp)) throw new TypeError('utils.matchAll expects a RegExp');
    var flags = re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags;
    var out = [];
    String(text || '').replace(new RegExp(re.source, flags), function () {
      out.push(Array.prototype.slice.call(arguments, 0, arguments.length - 2));
      return '';
    });
    return out;
  }

  var emitted = 0;
  var init = null;
  var ctx = null;

  function emit(records) {
    var list = Array.isArray(records) ? records : [records];
    var clean = list.filter(function (r) { return r && typeof r === 'object' && !Array.isArray(r); });
    if (list.length !== clean.length) ctx.log.warn('emit() skipped ' + (list.length - clean.length) + ' value(s) that are not plain objects');
    var room = Math.max(0, init.options.maxItems - emitted);
    clean = clean.slice(0, room);
    if (clean.length) {
      emitted += clean.length;
      send('emit', clean);
    }
    return Math.max(0, init.options.maxItems - emitted);
  }

  async function redditJson(pathOrUrl, query) {
    var r = await call('redditJson', { path: String(pathOrUrl), query: query || null });
    try { return JSON.parse(r.body); } catch (e) { throw new Error('Reddit returned data that is not JSON for ' + pathOrUrl); }
  }

  // Async generator over the pages of a listing: { number, children, records, after }.
  async function* pages(pathOrUrl, opts) {
    opts = opts || {};
    var maxPages = Math.max(1, Math.min(init.options.maxPages, Number(opts.maxPages) || init.options.maxPages));
    var limit = Math.max(1, Math.min(100, Number(opts.limit) || 100));
    var after = opts.after || null;
    for (var n = 1; n <= maxPages; n++) {
      var q = Object.assign({}, opts.query || {}, { limit: limit });
      if (after) q.after = after;
      var json = await redditJson(pathOrUrl, q);
      if (!json || json.kind !== 'Listing' || !json.data || !Array.isArray(json.data.children)) {
        throw new Error(String(pathOrUrl) + ' did not return a Reddit listing');
      }
      var children = json.data.children;
      after = json.data.after || null;
      send('progress', { pagesDelta: 1, message: 'Page ' + n + ' of ' + pathOrUrl });
      yield { number: n, children: children, records: children.map(function (c) { return F.normalizeThing(c); }).filter(Boolean), after: after };
      if (!after || !children.length) return;
    }
  }

  async function listing(pathOrUrl, opts) {
    opts = opts || {};
    var max = Math.max(1, Number(opts.maxItems) || init.options.maxItems);
    var items = [];
    var count = 0;
    for await (var page of pages(pathOrUrl, opts)) {
      count++;
      for (var i = 0; i < page.records.length && items.length < max; i++) items.push(page.records[i]);
      if (items.length >= max) break;
    }
    return { items: items, pages: count };
  }

  async function post(id, opts) {
    opts = opts || {};
    var postId = String(id).replace(/^t3_/, '');
    var json = await redditJson('/comments/' + postId, {
      limit: opts.limit || init.options.commentLimit || 100,
      depth: opts.depth || init.options.commentDepth || 5,
      sort: opts.sort || 'confidence'
    });
    if (!Array.isArray(json) || json.length < 2) throw new Error('Post ' + postId + ' did not return a post + comments pair');
    var p = (json[0].data.children || []).filter(function (c) { return c.kind === 't3'; })[0];
    if (!p) throw new Error('Post ' + postId + ' not found');
    var record = F.normalizePost(p.data);
    var flat = F.flattenComments(json[1].data.children, { post_id: record.post_id, post_title: record.title, post_permalink: record.permalink }, opts.limit);
    return { post: record, comments: flat.comments, moreCount: flat.moreCount };
  }

  async function about(kind, name) {
    var json = await redditJson(kind === 'user' ? '/user/' + name + '/about' : '/r/' + name + '/about');
    return json && json.data ? (kind === 'user' ? F.normalizeUser(json.data) : F.normalizeSubreddit(json.data)) : null;
  }

  var log = logAt('info');
  log.debug = logAt('debug');
  log.info = logAt('info');
  log.warn = logAt('warn');
  log.error = logAt('error');

  globalThis.console = { log: log.info, info: log.info, debug: log.debug, warn: log.warn, error: log.error };

  globalThis.__metacode_run = async function (initJson) {
    init = JSON.parse(initJson);
    ctx = Object.freeze({
      target: init.target,
      options: init.options,
      params: init.params || {},
      mode: init.mode,
      fetch: function (url, opts) {
        opts = opts || {};
        return call('fetch', { url: String(url), method: opts.method || 'GET', headers: opts.headers || {} }).then(makeResponse);
      },
      reddit: Object.freeze({
        json: redditJson,
        pages: pages,
        listing: listing,
        post: post,
        subreddit: function (name) { return about('subreddit', name); },
        user: function (name) { return about('user', name); },
        normalizePost: F.normalizePost,
        normalizeComment: F.normalizeComment,
        normalizeSubreddit: F.normalizeSubreddit,
        normalizeUser: F.normalizeUser,
        normalizeThing: F.normalizeThing,
        flattenComments: F.flattenComments,
        extractMedia: F.extractMedia,
        toIso: F.toIso
      }),
      emit: emit,
      remaining: function () { return Math.max(0, init.options.maxItems - emitted); },
      log: log,
      progress: function (p) { send('progress', { message: p && p.message ? String(p.message) : undefined, pagesDelta: p && p.pages ? Number(p.pages) : undefined }); },
      sleep: sleep,
      retry: retry,
      utils: Object.freeze({ get: get, pick: pick, unique: unique, chunk: chunk, stripHtml: stripHtml, decodeEntities: decodeEntities, matchAll: matchAll })
    });
    if (typeof globalThis.scrape !== 'function') {
      throw new Error('Define a function named scrape, e.g.  async function scrape(ctx) { … }');
    }
    var result = await globalThis.scrape(ctx);
    var data = [];
    var meta = null;
    if (Array.isArray(result)) data = result;
    else if (result && typeof result === 'object') {
      if (Array.isArray(result.data)) data = result.data;
      else if (result.data !== undefined) throw new Error('scrape() returned { data } that is not an array');
      if (result.meta && typeof result.meta === 'object') meta = result.meta;
    } else if (result !== undefined && result !== null) {
      throw new Error('scrape() must return an array of records, { data: [...] }, or nothing (records sent with ctx.emit are kept)');
    }
    if (data.length) emit(data);
    return JSON.stringify({ emitted: emitted, meta: meta });
  };
})();
