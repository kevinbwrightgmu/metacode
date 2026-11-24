// The AI Model Store's catalog: the models in Ollama's library, read from ollama.com, with sizes and context
// windows from each model's tags page and exact download sizes and digests from Ollama's registry.
//
// There is no official JSON catalog, so the library's pages are read like a browser would. The parsers are
// tolerant, a page that can't be read leaves the cached catalog in place, and a dated snapshot ships with
// MetaCode (catalog-snapshot.json, made by scripts/update-model-catalog.js) for a first start offline.
// "Cloud" models (they run on Ollama's servers) are kept out: prompts never leave the device.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIBRARY_URL = 'https://ollama.com/library';
const REGISTRY = 'https://registry.ollama.ai/v2/library/';
const SNAPSHOT = path.join(__dirname, 'catalog-snapshot.json');
// (asked for as Ollama asks: a tag with variants for several runners, llama.cpp and MLX, is a list of manifests)
const MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const MANIFEST_LIST = 'application/vnd.ollama.manifest.list.v2+json';
const MANIFEST_TYPES = MANIFEST_LIST + ', ' + MANIFEST;
const LIBRARY_MAX_AGE_MS = 24 * 3600 * 1000;      // the library is looked at again after a day (when online)
const TAGS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;     // a model's tags after a week
const RETRY_MS = 5 * 60 * 1000;                   // after ollama.com didn't answer, the saved catalog for 5 minutes

// Requests to ollama.com and its registry go out like the AI service's: through HTTPS_PROXY / HTTP_PROXY when set
// (NO_PROXY respected). Node's own fetch ignores those variables.
let proxyAgent = null;
function internetFetch(url, init) {
  const undici = require('undici');
  if (!proxyAgent) {
    const emit = process.emitWarning;          // (undici calls EnvHttpProxyAgent experimental on stderr; not worth a line)
    process.emitWarning = function (w, o, ...rest) {
      const code = o && typeof o === 'object' ? o.code : rest[0];
      return code === 'UNDICI-EHPA' ? undefined : emit.call(process, w, o, ...rest);
    };
    try { proxyAgent = new undici.EnvHttpProxyAgent(); } finally { process.emitWarning = emit; }
  }
  return undici.fetch(url, Object.assign({ dispatcher: proxyAgent }, init));
}

const decode = s => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
const text = s => decode(String(s || '').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// "95.3M" → 95300000, "42K" → 42000
function count(s) {
  const m = /^([\d.,]+)\s*([KMB])?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
}
// "292MB" → 292000000 (the library uses decimal units: 291,554,930 bytes shows as 292MB)
function bytes(s) {
  const m = /^([\d.]+)\s*(B|KB|MB|GB|TB)$/i.exec(String(s || '').trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()]);
}
// "32K" → 32768, "128K" → 131072, "1M" → 1048576
function tokens(s) {
  const m = /^([\d.]+)\s*([KM])?$/i.exec(String(s || '').trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ K: 1024, M: 1024 * 1024 }[(m[2] || '').toUpperCase()] || 1));
}
// "1b" → 1e9, "270m" → 2.7e8, "8x7b" → 5.6e10, "e2b" → 2e9 (effective); null when it isn't a size
function params(size) {
  const m = /^(?:(\d+)x)?e?([\d.]+)([mbt])$/i.exec(String(size || '').trim());
  if (!m) return null;
  return Math.round((m[1] ? Number(m[1]) : 1) * Number(m[2]) * { m: 1e6, b: 1e9, t: 1e12 }[m[3].toLowerCase()]);
}

// ── ollama.com/library ─────────────────────────────────────────────────────
// → [{ name, description, capabilities, sizes, pulls, tagCount, updated }], cloud-only models left out
function parseLibrary(html) {
  const out = [];
  const seen = new Set();
  for (const block of String(html || '').split(/<li\b/i).slice(1)) {
    const href = /href="\/library\/([a-z0-9][a-z0-9._-]*)"/i.exec(block);
    if (!href || seen.has(href[1])) continue;
    const name = href[1];
    const description = text((/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block) || [])[1]);
    const badges = [];
    const re = /<span\b[^>]*class="([^"]*rounded-md[^"]*)"[^>]*>\s*([^<]{1,40}?)\s*<\/span>/gi;
    let m;
    while ((m = re.exec(block))) badges.push({ cls: m[1], value: decode(m[2]).trim() });
    const sizes = badges.filter(b => /blue|ddf4ff/.test(b.cls) && params(b.value) !== null).map(b => b.value.toLowerCase());
    const capabilities = badges.filter(b => !/blue|ddf4ff/.test(b.cls)).map(b => b.value.toLowerCase()).filter(v => /^[a-z][a-z-]{1,20}$/.test(v));
    if (capabilities.includes('cloud') && !sizes.length) continue;       // only on Ollama's servers
    const pulls = count((/<span\b[^>]*>\s*([\d.,]+[KMB]?)\s*<\/span>\s*<span\b[^>]*>\s*(?:&nbsp;|\s)*Pulls/i.exec(block) || [])[1]);
    const tagCount = count((/<span\b[^>]*>\s*([\d,]+)\s*<\/span>\s*<span\b[^>]*>\s*(?:&nbsp;|\s)*Tags/i.exec(block) || [])[1]);
    const updatedTitle = (/title="([A-Z][a-z]{2} \d{1,2}, \d{4}[^"]*)"/.exec(block) || [])[1];
    const updated = updatedTitle && !isNaN(Date.parse(updatedTitle.replace(' UTC', 'Z').replace(/ (AM|PM)Z$/, ' $1 UTC'))) ? new Date(Date.parse(updatedTitle.replace(/ UTC$/, ' UTC'))).toISOString() : null;
    seen.add(name);
    out.push({ name, description, capabilities: capabilities.filter(c => c !== 'cloud'), sizes, pulls, tagCount, updated });
  }
  return out;
}

// ── ollama.com/library/<name>/tags ─────────────────────────────────────────
// → [{ tag: "gemma3:270m", digest: "e7d36fb2c3b3", size, context, inputs: ["text"] }]
function parseTags(html, name) {
  const out = [];
  const seen = new Set();
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<a href="/library/(' + esc + ':[a-z0-9._-]+)"[^>]*class="[^"]*md:hidden[^"]*"[^>]*>([\\s\\S]*?)</a>', 'gi');
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[1];
    if (seen.has(tag) || /:.*cloud/i.test(tag)) continue;
    const line = text(m[2]);                    // "gemma3:270m e7d36fb2c3b3 • 292MB • 32K context window • Text input • 1 year ago"
    const digest = (/\b([0-9a-f]{12})\b/.exec(line) || [])[1] || null;
    // (a tag with variants for several runners shows a range, "16GB - 19GB": the bigger, so the estimates of
    // memory and disk stay on the safe side)
    const sizes = /•\s*([\d.]+\s*(?:B|KB|MB|GB|TB))(?:\s*[-–]\s*([\d.]+\s*(?:B|KB|MB|GB|TB)))?\s*•/i.exec(line);
    const size = sizes && bytes(sizes[2] || sizes[1]);
    const context = tokens((/•\s*([\d.]+\s*[KM]?)\s*context window/i.exec(line) || [])[1]);
    const inputs = ((/•\s*([A-Za-z, ]+?)\s*input/i.exec(line) || [])[1] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!size) continue;
    seen.add(tag);
    out.push({ tag, digest, size, context, inputs });
  }
  return out;
}

// The tags worth showing first: one per size badge (gemma3:1b …) and :latest; the rest are other quantizations
function mainTags(model, tags) {
  const sizes = new Set((model.sizes || []).map(s => s.toLowerCase()));
  const main = tags.filter(t => { const v = t.tag.split(':')[1]; return v === 'latest' || sizes.has(v); });
  return main.length ? main : tags.slice(0, 6);
}

// ── Ollama's registry ──────────────────────────────────────────────────────
// Which variant of a tag with variants for several runners (a manifest list) Ollama gets depends on the Ollama.
// From 0.40 it asks for the list and takes the variant for its own computer (manifest/manifest.go,
// runnerPreferences: MLX first on a Mac with Apple Silicon, llama.cpp first everywhere else). Before 0.40 it
// asks for the plain manifest only, and the registry answers with the llama.cpp variant. An unknown version
// counts as new, as does 0.0.0 (a development build).
function listsAsked(version) {
  const v = /^0\.(\d+)\./.exec(String(version || ''));
  return !v || Number(v[1]) >= 40 || version === '0.0.0';
}
// Whether the Ollama that downloads (its version, when known) on this device (appleSilicon, as hardware.js found
// it) takes a tag's MLX variant: → true, false, or null when it isn't known whether this is Apple Silicon
function pullsMlx(appleSilicon, version) {
  if (!listsAsked(version)) return false;
  return typeof appleSilicon === 'boolean' ? appleSilicon : null;
}
// The variant Ollama pulls from a manifest list (manifest/manifest.go, runnerPreferences): MLX first on a Mac
// with Apple Silicon, llama.cpp first everywhere else. → the list's entry, or null when none fits
function pickVariant(list, appleSilicon) {
  const variants = Array.isArray(list && list.manifests) ? list.manifests : [];
  for (const runner of appleSilicon ? ['mlx', 'llamacpp', 'ggml'] : ['llamacpp', 'ggml', 'mlx']) {
    const v = variants.find(c => c && (!c.mediaType || c.mediaType === MANIFEST) && String(c.runner || '').trim().toLowerCase() === runner);
    if (v) return v;
  }
  return null;
}
// A manifest's layers (its config included), each digest once: → [{ digest, size }]
function layersOf(m) {
  const out = new Map();
  for (const l of (Array.isArray(m.layers) ? m.layers : []).concat(m.config ? [m.config] : [])) {
    if (l && typeof l.digest === 'string' && !out.has(l.digest)) out.set(l.digest, Number(l.size) || 0);
  }
  return [...out].map(([digest, size]) => ({ digest, size }));
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ── Categories ─────────────────────────────────────────────────────────────
const CATEGORY = [
  ['coding', /\b(code|coder|coding|codestral|devstral|starcoder|codellama|codegemma|codeqwen|programming|software engineer)/i],
  ['reasoning', /\b(reason|reasoning|thinking|think|r1\b|qwq|math)/i],
  ['multilingual', /\b(multilingual|multiple languages|\d{2,} languages|languages)\b/i],
];
function categories(model) {
  const caps = model.capabilities || [];
  const hay = model.name + ' ' + (model.description || '');
  const out = new Set();
  if (caps.includes('embedding') || /embed/i.test(model.name)) out.add('embedding');
  if (caps.includes('vision')) out.add('vision');
  if (caps.includes('thinking')) out.add('reasoning');
  for (const [cat, re] of CATEGORY) if (re.test(hay)) out.add(cat);
  const smallest = Math.min(...(model.sizes || []).map(params).filter(n => n !== null));
  if (isFinite(smallest) && smallest <= 3e9) out.add('small');
  if (!out.has('embedding')) out.add('general');
  return [...out];
}

// ── The catalog: live, cached, or the snapshot ─────────────────────────────
function createCatalog(opts) {
  const fetchImpl = opts.fetch || internetFetch;
  const now = opts.now || Date.now;
  const file = path.join(opts.dataDir, 'catalog.json');
  const libraryUrl = opts.libraryUrl || LIBRARY_URL;
  // (the library's namespace, …/v2/library/; models of other namespaces are beside it, …/v2/<user>/<model>)
  const root = String(opts.registry || REGISTRY).replace(/\/*$/, '/').replace(/\/library\/$/, '/');
  let mem = null;              // { source, fetchedAt, models: [...], tags: { name: { fetchedAt, tags } } }
  let refreshing = null;
  let failed = null;           // { at, problem }: ollama.com didn't answer (it isn't asked again for a while)

  function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
  function load() {
    if (mem) return mem;
    const cached = readJson(file);
    if (cached && Array.isArray(cached.models) && cached.models.length) mem = Object.assign({ tags: {} }, cached, { source: 'cache' });
    else {
      const snap = readJson(SNAPSHOT) || { fetchedAt: null, models: [], tags: {} };
      mem = { source: 'snapshot', fetchedAt: snap.fetchedAt, models: snap.models || [], tags: snap.tags || {} };
    }
    return mem;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: mem.fetchedAt, models: mem.models, tags: mem.tags }));
      fs.renameSync(tmp, file);
    } catch (e) { /* a read-only install keeps the catalog in memory */ }
  }
  // (`signal`: the caller's, to stop it early)
  async function get(url, ms, headers, signal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms || 15000);
    const stop = () => ac.abort();
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
    try {
      const res = await fetchImpl(url, { signal: ac.signal, headers: Object.assign({ 'User-Agent': 'MetaCode-ModelStore', Accept: 'text/html' }, headers || {}) });
      const body = await res.text();
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
    }
  }
  const unreachable = e => 'The library at ollama.com can\'t be reached (' + (e && e.name === 'AbortError' ? 'no answer' : 'offline?') + '); the saved catalog is shown.';
  // (ollama.com didn't answer a moment ago: the saved catalog at once, rather than another wait of up to 20 s)
  const resting = () => failed && now() - failed.at < RETRY_MS;

  // The library, fetched again when older than a day (or when asked): → { ok, problem? }
  async function refresh(force) {
    const cat = load();
    if (!force && cat.source !== 'snapshot' && cat.fetchedAt && now() - Date.parse(cat.fetchedAt) < LIBRARY_MAX_AGE_MS) return { ok: true };
    if (!force && resting()) return { ok: false, problem: failed.problem };
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await get(libraryUrl, 20000);
        if (r.status !== 200) return { ok: false, problem: 'ollama.com answered HTTP ' + r.status + '.' };
        const models = parseLibrary(r.body);
        // (ollama.com's page reading as far fewer models than the catalog has is a page that changed, not a smaller
        // library; a mirror of the operator's own may list just a few)
        const floor = opts.minModels !== undefined ? opts.minModels : libraryUrl === LIBRARY_URL ? Math.max(1, Math.floor(cat.models.length / 3)) : 1;
        if (models.length < floor) return { ok: false, problem: 'ollama.com\'s library page couldn\'t be read (it may have changed); the saved catalog is shown.' };
        mem = { source: 'live', fetchedAt: new Date(now()).toISOString(), models, tags: cat.tags || {} };
        save();
        return { ok: true };
      } catch (e) {
        return { ok: false, problem: unreachable(e) };
      }
    })().then(r => { failed = r.ok ? null : { at: now(), problem: r.problem }; refreshing = null; return r; });
    return refreshing;
  }

  // One model's tags (sizes, context windows), from its tags page when online and not known recently
  async function tagsOf(name, force) {
    const cat = load();
    const known = cat.tags[name];
    if (known && !force && now() - Date.parse(known.fetchedAt || 0) < TAGS_MAX_AGE_MS) return { tags: known.tags, fetchedAt: known.fetchedAt };
    if (!force && resting()) return known ? { tags: known.tags, fetchedAt: known.fetchedAt, stale: true } : { tags: [], fetchedAt: null, offline: true };
    try {
      const r = await get(libraryUrl + '/' + encodeURIComponent(name) + '/tags', 15000);
      if (r.status === 200) {
        const tags = parseTags(r.body, name);
        if (tags.length) {
          cat.tags[name] = { fetchedAt: new Date(now()).toISOString(), tags };
          save();
          return { tags, fetchedAt: cat.tags[name].fetchedAt };
        }
      }
    } catch (e) { failed = { at: now(), problem: unreachable(e) }; }     // (offline: what's known, if anything)
    return known ? { tags: known.tags, fetchedAt: known.fetchedAt, stale: true } : { tags: [], fetchedAt: null, offline: true };
  }

  // The registry's manifest for "name:tag", as the Ollama here pulls it: its layers with their exact sizes, their
  // total, and the digest Ollama will report once it's installed. A tag with variants for several runners is a
  // list of manifests: Ollama 0.40 and later pull the variant for their computer and report that one's digest; an
  // older Ollama gets the registry's plain manifest (see pullsMlx). `digests`: every variant's, as an Ollama in a
  // VM, a container or on another computer takes the one for its own system.
  // (o.appleSilicon: what the hardware module found; otherwise this process's own platform and architecture.
  // o.version: Ollama's, when known. o.signal: stops it early.)
  async function manifest(model, o) {
    o = o || {};
    const [name, tag] = String(model).split(':');
    const repo = root + (name.includes('/') ? name : 'library/' + name).split('/').map(encodeURIComponent).join('/');
    const unreadable = { ok: false, problem: 'Ollama\'s registry sent something unreadable.' };
    const r = await get(repo + '/manifests/' + encodeURIComponent(tag || 'latest'), 15000, { Accept: listsAsked(o.version) ? MANIFEST_TYPES : MANIFEST }, o.signal);
    if (r.status === 404) return { ok: false, missing: true };
    if (r.status !== 200) return { ok: false, problem: 'Ollama\'s registry answered HTTP ' + r.status + '.' };
    let m;
    try { m = JSON.parse(r.body); } catch (e) { return unreadable; }
    let digest = sha256(r.body);
    let digests = [digest];
    if (m && m.mediaType === MANIFEST_LIST) {
      digests = (Array.isArray(m.manifests) ? m.manifests : []).map(c => String(c && c.digest || '').toLowerCase().replace(/^sha256:/, '')).filter(d => /^[0-9a-f]{64}$/.test(d));
      const mlx = pullsMlx(o.appleSilicon, o.version);
      const v = pickVariant(m, mlx === null ? process.platform === 'darwin' && process.arch === 'arm64' : mlx);
      if (!v) return { ok: false, problem: 'Ollama\'s registry has no variant of ' + model + ' that Ollama runs on this computer.' };
      const want = String(v.digest || '').toLowerCase().replace(/^sha256:/, '');
      if (!/^[0-9a-f]{64}$/.test(want)) {
        // (a variant written out in the list: its digest is Ollama's own encoding of it, so it isn't compared)
        m = v; digest = null;
      } else {
        // (each variant is a blob of the model's repository, fetched as Ollama fetches it)
        const b = await get(repo + '/blobs/sha256:' + want, 15000, { Accept: '*/*' }, o.signal);
        if (b.status !== 200) return { ok: false, problem: 'Ollama\'s registry answered HTTP ' + b.status + ' for a variant of ' + model + '.' };
        if (sha256(b.body) !== want) return unreadable;
        try { m = JSON.parse(b.body); } catch (e) { return unreadable; }
        digest = want;
      }
    }
    if (!m || typeof m !== 'object') return unreadable;
    const blobs = layersOf(m);
    return { ok: true, size: blobs.reduce((n, l) => n + l.size, 0), digest, digests: digest && !digests.includes(digest) ? digests.concat(digest) : digests, blobs };
  }

  // The catalog for the browser: each model with its categories and the tags known so far
  function list() {
    const cat = load();
    return {
      source: cat.source, fetchedAt: cat.fetchedAt,
      models: cat.models.map(m => {
        const t = cat.tags[m.name];
        return Object.assign({}, m, { categories: categories(m), tags: t ? mainTags(m, t.tags) : [], allTags: t ? t.tags.length : null });
      }),
    };
  }
  function find(name) { return load().models.find(m => m.name === name) || null; }

  return { refresh, tagsOf, manifest, list, find, mainTags };
}

module.exports = { createCatalog, internetFetch, parseLibrary, parseTags, mainTags, categories, pickVariant, pullsMlx, params, bytes, tokens, count, LIBRARY_URL, SNAPSHOT };
