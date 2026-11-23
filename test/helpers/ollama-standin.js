// A stand-in for Ollama (as Ollama 0.40 behaves: downloads stream progress per layer, a stopped download
// continues where it stopped, a missing model is an {"error"} line in a 200 stream, installed digests are the
// sha256 of the registry's manifest), for ollama.com's library pages and for Ollama's registry.
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

const MODEL_BYTES = 6000000;
// The registry's manifest for a model: its layers, and the digest Ollama reports once it's installed
function manifestFor(name) {
  const body = JSON.stringify({ schemaVersion: 2, config: { size: 500 }, layers: [{ mediaType: 'application/vnd.ollama.image.model', size: MODEL_BYTES, digest: 'sha256:' + 'a'.repeat(64) }, { mediaType: 'application/vnd.ollama.image.template', size: 300, digest: 'sha256:' + 'b'.repeat(64) }] });
  return { body, digest: crypto.createHash('sha256').update(body).digest('hex'), size: MODEL_BYTES + 300 + 500 };
}

function standIns(opts) {
  opts = opts || {};
  const st = {
    installed: new Map(),       // name → { digest, size }
    loaded: new Set(),
    partial: new Map(),         // name → bytes kept from a stopped download
    pullDelayMs: 25,            // per progress step (20 steps)
    breakAt: null,              // stop the stream after this many bytes (an interrupted download)
    wrongDigest: false,
    pulls: [], deletes: [], loads: [], unloads: [],
  };
  const app = express();
  app.use(express.json());
  // Ollama
  app.get('/api/version', (req, res) => res.json({ version: '0.40.17' }));
  app.get('/api/tags', (req, res) => res.json({ models: [...st.installed.entries()].map(([name, m]) => ({ name, model: name, size: m.size, digest: m.digest, modified_at: '2026-11-21T00:00:00Z', details: { family: 'gemma3', parameter_size: '268M', quantization_level: 'Q8_0', context_length: 32768 }, capabilities: ['completion'] })) }));
  app.get('/api/ps', (req, res) => res.json({ models: [...st.loaded].map(name => ({ name, model: name, size: 326201507, size_vram: 0, expires_at: '2026-11-21T01:00:00Z', context_length: 4096 })) }));
  app.post('/api/generate', (req, res) => {
    const { model, keep_alive: keep } = req.body;
    if (!st.installed.has(model)) return res.status(404).json({ error: 'model \'' + model + '\' not found' });
    if (keep === 0) { st.loaded.delete(model); st.unloads.push(model); return res.json({ model, done: true, done_reason: 'unload' }); }
    st.loaded.add(model); st.loads.push([model, keep]);
    res.json({ model, done: true, done_reason: 'load' });
  });
  app.delete('/api/delete', (req, res) => {
    const { model } = req.body;
    st.deletes.push(model);
    if (!st.installed.delete(model)) return res.status(404).json({ error: 'model \'' + model + '\' not found' });
    st.loaded.delete(model);
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
    const digest = 'sha256:' + 'a'.repeat(64);
    let done = st.partial.get(model) || 0;
    line({ status: 'pulling aaaaaaaaaaaa', digest, total: MODEL_BYTES, ...(done ? { completed: done } : {}) });
    while (done < MODEL_BYTES) {
      await sleep(st.pullDelayMs);
      if (gone) { st.partial.set(model, done); return; }
      done = Math.min(MODEL_BYTES, done + MODEL_BYTES / 20);
      st.partial.set(model, done);
      line({ status: 'pulling aaaaaaaaaaaa', digest, total: MODEL_BYTES, completed: done });
      if (st.breakAt !== null && done >= st.breakAt) { st.breakAt = null; return res.destroy(); }
    }
    line({ status: 'pulling bbbbbbbbbbbb', digest: 'sha256:' + 'b'.repeat(64), total: 300, completed: 300 });
    line({ status: 'verifying sha256 digest' });
    line({ status: 'writing manifest' });
    st.partial.delete(model);
    const m = manifestFor(model);
    st.installed.set(model, { digest: st.wrongDigest ? 'f'.repeat(64) : m.digest, size: m.size });
    line({ status: 'success' });
    res.end();
  });
  // ollama.com (the library) and the registry
  app.get('/library', (req, res) => res.type('html').send(LIBRARY_HTML));
  app.get('/library/:name/tags', (req, res) => (req.params.name === 'gemma3' ? res.type('html').send(TAGS_HTML) : res.status(404).send('no')));
  app.get('/v2/library/:name/manifests/:tag', (req, res) => {
    if (/^missing/.test(req.params.name)) return res.status(404).json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] });
    res.type('application/vnd.docker.distribution.manifest.v2+json').send(manifestFor(req.params.name + ':' + req.params.tag).body);
  });
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    resolve({ st, base, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) });
  }));
}


module.exports = { standIns, manifestFor, MODEL_BYTES, LIBRARY_HTML, TAGS_HTML };
