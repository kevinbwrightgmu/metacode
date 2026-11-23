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
const MANIFEST_TYPES = 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json';
const LIBRARY_MAX_AGE_MS = 24 * 3600 * 1000;      // the library is looked at again after a day (when online)
const TAGS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;     // a model's tags after a week

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
    const size = bytes((/•\s*([\d.]+\s*(?:B|KB|MB|GB|TB))\s*•/i.exec(line) || [])[1]);
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
  const file = path.join(opts.dataDir, 'catalog.json');
  const libraryUrl = opts.libraryUrl || LIBRARY_URL;
  const registry = opts.registry || REGISTRY;
  let mem = null;              // { source, fetchedAt, models: [...], tags: { name: { fetchedAt, tags } } }
  let refreshing = null;

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
  async function get(url, ms, headers) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms || 15000);
    try {
      const res = await fetchImpl(url, { signal: ac.signal, headers: Object.assign({ 'User-Agent': 'MetaCode-ModelStore', Accept: 'text/html' }, headers || {}) });
      const body = await res.text();
      return { status: res.status, body };
    } finally { clearTimeout(timer); }
  }

  // The library, fetched again when older than a day (or when asked): → { ok, problem? }
  async function refresh(force) {
    const cat = load();
    if (!force && cat.source !== 'snapshot' && cat.fetchedAt && Date.now() - Date.parse(cat.fetchedAt) < LIBRARY_MAX_AGE_MS) return { ok: true };
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await get(libraryUrl, 20000);
        if (r.status !== 200) return { ok: false, problem: 'ollama.com answered HTTP ' + r.status + '.' };
        const models = parseLibrary(r.body);
        // (a page that reads as far fewer models than the catalog has is a page that changed, not a smaller library)
        const floor = opts.minModels !== undefined ? opts.minModels : Math.max(1, Math.floor(cat.models.length / 3));
        if (models.length < floor) return { ok: false, problem: 'ollama.com\'s library page couldn\'t be read (it may have changed); the saved catalog is shown.' };
        mem = { source: 'live', fetchedAt: new Date().toISOString(), models, tags: cat.tags || {} };
        save();
        return { ok: true };
      } catch (e) {
        return { ok: false, problem: 'The library at ollama.com can\'t be reached (' + (e && e.name === 'AbortError' ? 'no answer' : 'offline?') + '); the saved catalog is shown.' };
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  // One model's tags (sizes, context windows), from its tags page when online and not known recently
  async function tagsOf(name, force) {
    const cat = load();
    const known = cat.tags[name];
    if (known && !force && Date.now() - Date.parse(known.fetchedAt || 0) < TAGS_MAX_AGE_MS) return { tags: known.tags, fetchedAt: known.fetchedAt };
    try {
      const r = await get(libraryUrl + '/' + encodeURIComponent(name) + '/tags', 15000);
      if (r.status === 200) {
        const tags = parseTags(r.body, name);
        if (tags.length) {
          cat.tags[name] = { fetchedAt: new Date().toISOString(), tags };
          save();
          return { tags, fetchedAt: cat.tags[name].fetchedAt };
        }
      }
    } catch (e) { /* offline: what's known, if anything */ }
    return known ? { tags: known.tags, fetchedAt: known.fetchedAt, stale: true } : { tags: [], fetchedAt: null, offline: true };
  }

  // The registry's manifest for "name:tag": its exact download size and the digest Ollama will report
  async function manifest(model) {
    const [name, tag] = String(model).split(':');
    const r = await get(registry + encodeURIComponent(name) + '/manifests/' + encodeURIComponent(tag || 'latest'), 15000, { Accept: MANIFEST_TYPES });
    if (r.status === 404) return { ok: false, missing: true };
    if (r.status !== 200) return { ok: false, problem: 'Ollama\'s registry answered HTTP ' + r.status + '.' };
    let m;
    try { m = JSON.parse(r.body); } catch (e) { return { ok: false, problem: 'Ollama\'s registry sent something unreadable.' }; }
    const layers = Array.isArray(m.layers) ? m.layers : [];
    const size = layers.reduce((n, l) => n + (Number(l.size) || 0), 0) + (m.config && Number(m.config.size) || 0);
    return { ok: true, size, digest: crypto.createHash('sha256').update(r.body).digest('hex') };
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

module.exports = { createCatalog, internetFetch, parseLibrary, parseTags, mainTags, categories, params, bytes, tokens, count, LIBRARY_URL, SNAPSHOT };
