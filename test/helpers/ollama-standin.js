// A stand-in for Ollama (as Ollama 0.40 behaves: downloads stream progress per layer, a stopped download
// continues where it stopped, a missing model is an {"error"} line in a 200 stream, installed digests are the
// sha256 of the registry's manifest, names are looked up whatever their case and listed in the case of the
// first pull, HEAD /api/blobs/<digest> says whether a layer is complete on disk), for ollama.com's library
// pages and for Ollama's registry (manifests at /v2/<namespace>/<model>/manifests/<tag>, a "%2F" in a name is
// no separator; gemma4's size tags are manifest lists, one variant per runner, each variant a blob).
// Used by test/local-ai.test.js and test/local-ai-e2e.test.js.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ollama');
const LIBRARY_HTML = fs.readFileSync(path.join(FIXTURES, 'library.html'), 'utf8');
const TAGS_HTML = fs.readFileSync(path.join(FIXTURES, 'gemma3-tags.html'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const MANIFEST_LIST = 'application/vnd.ollama.manifest.list.v2+json';
// Ollama's names: "gemma3" is "gemma3:latest", and the case doesn't matter
const keyOf = name => { const n = String(name).toLowerCase(); return /:[^:/]*$/.test(n) ? n : n + ':latest'; };

const MODEL_BYTES = 6000000;
// The registry's manifest for a model: its layers (each model its own, a new revision a new weights layer), and
// the digest Ollama reports once it's installed. (runner: one variant of a manifest list.)
function manifestFor(name, revision, runner) {
  const id = keyOf(name) + (runner ? ' ' + runner : '');
  const digest = what => 'sha256:' + sha256(what + ' ' + id);
  const weights = runner === 'mlx' ? MODEL_BYTES + 1000000 : MODEL_BYTES;
  const layers = [
    { mediaType: 'application/vnd.ollama.image.model', size: weights, digest: digest('model ' + (revision || 1)) },
    { mediaType: 'application/vnd.ollama.image.template', size: 300, digest: digest('template') },
  ];
  const config = { mediaType: 'application/vnd.docker.container.image.v1+json', size: 500, digest: digest('config') };
  const body = JSON.stringify(Object.assign({ schemaVersion: 2, mediaType: MANIFEST, config, layers }, runner ? { runner } : {}));
  return { body, digest: sha256(body), size: weights + 300 + 500, layers: layers.concat([config]) };
}
const isList = name => /^gemma4:(latest|e2b|e4b|12b|26b|31b)$/.test(keyOf(name));
// A tag with variants for llama.cpp and MLX: the list, and each variant
function listFor(name, revision) {
  const variants = ['llamacpp', 'mlx'].map(runner => Object.assign({ runner }, manifestFor(name, revision, runner)));
  const body = JSON.stringify({ schemaVersion: 2, mediaType: MANIFEST_LIST, manifests: variants.map(v => ({ mediaType: MANIFEST, digest: 'sha256:' + v.digest, runner: v.runner, format: v.runner === 'mlx' ? 'safetensors' : 'gguf' })) });
  return { body, digest: sha256(body), variants };
}

function standIns(opts) {
  opts = opts || {};
  const st = {
    installed: new Map(),       // name, as listed → { digest, size, blobs }
    blobs: new Set(),           // the layers complete on disk
    loaded: new Set(),
    partial: new Map(),         // keyOf(name) → bytes kept from a stopped download
    revisions: new Map(),       // keyOf(name) → the registry's revision of it (a new one has new weights)
    version: '0.40.17',         // what /api/version says
    // the variant this Ollama pulls from a manifest list: MLX for an Ollama 0.40 or later on a Mac with Apple
    // Silicon; llama.cpp elsewhere, and for an older Ollama, which asks the registry for the plain manifest
    runner: 'llamacpp',
    pullDelayMs: 25,            // per progress step (20 steps)
    verifyDelayMs: 0,           // nothing sent for this long after "verifying sha256 digest"
    registryDelayMs: 0,         // before the registry answers a manifest
    breakAt: null,              // stop the stream after this many bytes (an interrupted download)
    wrongDigest: false,
    pulls: [], deletes: [], loads: [], unloads: [], registry: [],
  };
  const named = model => [...st.installed.keys()].find(n => keyOf(n) === keyOf(model)) || null;
  // What Ollama pulls for a name: the manifest, or the variant of a manifest list for its runner
  const pulled = model => {
    const revision = st.revisions.get(keyOf(model));
    return isList(model) ? listFor(model, revision).variants.find(v => v.runner === st.runner) : manifestFor(model, revision);
  };
  const app = express();
  app.use(express.json());
  // Ollama
  app.get('/api/version', (req, res) => res.json({ version: st.version }));
  // (a cloud model, pulled with the command line, has its remote_host)
  app.get('/api/tags', (req, res) => res.json({ models: [...st.installed.entries()].map(([name, m]) => Object.assign({ name, model: name, size: m.size, digest: m.digest, modified_at: '2026-11-21T00:00:00Z', details: { family: 'gemma3', parameter_size: '268M', quantization_level: 'Q8_0', context_length: 32768 }, capabilities: ['completion'] }, m.remote_host ? { remote_host: m.remote_host, remote_model: name.replace(/-?cloud$/, '') } : {})) }));
  app.get('/api/ps', (req, res) => res.json({ models: [...st.loaded].map(name => ({ name, model: name, size: 326201507, size_vram: 0, expires_at: '2026-11-21T01:00:00Z', context_length: 4096 })) }));
  app.head('/api/blobs/:digest', (req, res) => res.status(st.blobs.has(req.params.digest) ? 200 : 404).end());
  app.post('/api/generate', (req, res) => {
    const { keep_alive: keep } = req.body;
    const model = named(req.body.model);
    if (!model) return res.status(404).json({ error: 'model \'' + req.body.model + '\' not found' });
    if (keep === 0) { st.loaded.delete(model); st.unloads.push(model); return res.json({ model, done: true, done_reason: 'unload' }); }
    st.loaded.add(model); st.loads.push([model, keep]);
    res.json({ model, done: true, done_reason: 'load' });
  });
  app.delete('/api/delete', (req, res) => {
    st.deletes.push(req.body.model);
    const model = named(req.body.model);
    if (!model) return res.status(404).json({ error: 'model \'' + req.body.model + '\' not found' });
    const gone = st.installed.get(model);
    st.installed.delete(model);
    st.loaded.delete(model);
    // (the layers no other model uses are removed)
    const kept = new Set([...st.installed.values()].flatMap(m => m.blobs || []));
    for (const d of gone.blobs || []) if (!kept.has(d)) st.blobs.delete(d);
    res.status(200).end();
  });
  app.post('/api/pull', async (req, res) => {
    const model = req.body.model;
    st.pulls.push(model);
    res.status(200).type('application/x-ndjson');
    const line = o => res.write(JSON.stringify(o) + '\n');
    line({ status: 'pulling manifest' });
    if (/^missing/.test(model)) { line({ error: 'pull model manifest: file does not exist' }); return res.end(); }
    let gone = false;
    res.on('close', () => { gone = true; });
    const m = pulled(model);
    const [weights, ...rest] = m.layers;
    const short = l => 'pulling ' + l.digest.slice(7, 19);
    const key = keyOf(model);
    let done = st.blobs.has(weights.digest) ? weights.size : st.partial.get(key) || 0;
    line({ status: short(weights), digest: weights.digest, total: weights.size, ...(done ? { completed: done } : {}) });
    while (done < weights.size) {
      await sleep(st.pullDelayMs);
      if (gone) { st.partial.set(key, done); return; }
      done = Math.min(weights.size, done + weights.size / 20);
      st.partial.set(key, done);
      line({ status: short(weights), digest: weights.digest, total: weights.size, completed: done });
      if (st.breakAt !== null && done >= st.breakAt) { st.breakAt = null; return res.destroy(); }
    }
    for (const l of rest) line({ status: short(l), digest: l.digest, total: l.size, completed: l.size });
    line({ status: 'verifying sha256 digest' });
    if (st.verifyDelayMs) { await sleep(st.verifyDelayMs); if (gone) return; }
    line({ status: 'writing manifest' });
    st.partial.delete(key);
    m.layers.forEach(l => st.blobs.add(l.digest));
    st.installed.set(named(model) || model, { digest: st.wrongDigest ? 'f'.repeat(64) : m.digest, size: m.size, blobs: m.layers.map(l => l.digest) });
    line({ status: 'success' });
    res.end();
  });
  // ollama.com (the library) and the registry
  app.get('/library', (req, res) => res.type('html').send(LIBRARY_HTML));
  app.get('/library/:name/tags', (req, res) => (req.params.name === 'gemma3' ? res.type('html').send(TAGS_HTML) : res.status(404).send('no')));
  // (the raw path: each part decoded on its own, as a registry does)
  const variants = new Map();    // digest → body: the variants of the manifest lists served
  app.get(/^\/v2\/.+\/(manifests|blobs)\/[^/]+$/, async (req, res) => {
    st.registry.push(req.path + ' ' + (req.get('accept') || ''));
    const parts = req.path.split('/').slice(2);
    const [what, ref] = [parts[parts.length - 2], decodeURIComponent(parts[parts.length - 1])];
    const repoParts = parts.slice(0, -2);
    const unknown = () => res.status(404).json({ errors: [{ code: what === 'blobs' ? 'BLOB_UNKNOWN' : 'MANIFEST_UNKNOWN' }] });
    if (repoParts.length !== 2 || repoParts.some(x => /%2f/i.test(x))) return unknown();
    const [ns, name] = repoParts.map(decodeURIComponent);
    const repo = ns === 'library' ? name : ns + '/' + name;
    if (what === 'blobs') return variants.has(ref) ? res.type('application/octet-stream').send(variants.get(ref)) : unknown();
    if (st.registryDelayMs) { await sleep(st.registryDelayMs); if (req.destroyed) return; }
    const model = repo + ':' + ref;
    if (/^missing/.test(repo)) return unknown();
    const revision = st.revisions.get(keyOf(model));
    if (isList(model)) {
      // (a client that doesn't ask for manifest lists gets the llama.cpp variant, as from registry.ollama.ai)
      const list = listFor(model, revision);
      list.variants.forEach(v => variants.set('sha256:' + v.digest, v.body));
      if (String(req.get('accept') || '').includes(MANIFEST_LIST)) return res.type(MANIFEST_LIST).send(list.body);
      return res.type(MANIFEST).send(list.variants[0].body);
    }
    res.type(MANIFEST).send(manifestFor(model, revision).body);
  });
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    resolve({ st, base, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) });
  }));
}


module.exports = { standIns, manifestFor, listFor, keyOf, MODEL_BYTES, LIBRARY_HTML, TAGS_HTML };
