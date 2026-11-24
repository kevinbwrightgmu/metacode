// Model installs (downloads through Ollama), one at a time, the others queued:
// - progress, speed and time left from Ollama's progress lines;
// - pause = stop the download, keeping what arrived; resume = pull again, and Ollama continues from there
//   (checked with a real Ollama); cancel = stop and forget the download. Ollama keeps the parts on disk until it
//   starts again more than an hour later, and installing again before then continues from them;
// - the same model is never downloaded twice at once;
// - before a download: what it still has to fetch (the registry's layers Ollama doesn't have yet, less what it
//   keeps of them) against the free disk space;
// - after it: the installed model's digest against the registry's (the sha256 of its manifest, or of one of the
//   variants when a tag has variants for several runners).
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const NAME = /^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9][a-z0-9._-]{0,80})?(:[a-z0-9][a-z0-9._-]{0,60})?$/i;
const DISK_MARGIN = 512e6;                // left free after a download

// "gemma3" → "gemma3:latest"; null when it isn't a model name Ollama could pull from its library. The name is
// lowercase; a tag keeps its case (ollama.com lists gemma4:e2b-it-q4_K_M), as Ollama keeps it.
function normalize(model) {
  const m = String(model || '').trim();
  if (!NAME.test(m) || /cloud/i.test(m.split(':')[1] || '')) return null;
  const [name, tag] = m.split(':');
  return name.toLowerCase() + ':' + (tag || 'latest');
}
// Ollama keeps a model under the case it was first pulled with, and a pull in another case updates that one:
// downloads and settings are kept under this key, so names that differ only in case are one model
function keyOf(model) {
  const m = String(model || '').trim().toLowerCase();
  return /:[^:/]*$/.test(m) ? m : m + ':latest';
}
const size = n => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.ceil(n / 1e6) + ' MB');

// What Ollama keeps of the layers it hasn't finished, and continues from: read from its models folder, so also
// after MetaCode restarted or a download was cancelled. A layer's parts each have a record,
// blobs/sha256-<hex>-partial-<n>, with the bytes completed (server/download.go); a model of many tensor files
// has blobs/sha256-<hex>.tmp, its size so far (transfer/download.go). When Ollama starts more than an hour later
// it removes them, and the layer counts whole again. → Map digest → bytes, or null when the folder can't be read
// (One file at a time: a folder on a network mount that stopped answering then holds up one of Node's file
// threads, not all of them.)
async function readKept(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { return null; }
  const kept = new Map();
  const add = (hex, n) => { const d = 'sha256:' + hex.toLowerCase(); kept.set(d, (kept.get(d) || 0) + Math.max(0, Number(n) || 0)); };
  for (const f of names) {
    const part = /^sha256-([0-9a-f]{64})-partial-\d+$/i.exec(f), tmp = /^sha256-([0-9a-f]{64})\.tmp$/i.exec(f);
    try {
      if (part) add(part[1], JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8')).Completed);
      else if (tmp) add(tmp[1], (await fs.promises.stat(path.join(dir, f))).size);
    } catch (e) { /* being written, or just removed: nothing kept */ }
  }
  return kept;
}
const KEPT_WAIT_MS = 2000;                // how long the disk check waits for Ollama's models folder

function createInstalls(opts) {
  const { ollama, catalog, hardware } = opts;
  // What Ollama keeps (readKept), as long as its models folder answers within 2 s, as hardware.js waits for it, and
  // the download isn't stopped meanwhile: otherwise null, as for a folder that can't be read. One look at a time:
  // while one still waits on the folder, the next doesn't start another.
  let looking = null;
  async function keptByOllama(disk, signal) {
    if (!disk || !disk.ollamaDir || !disk.path || looking) return null;
    const look = looking = readKept(path.join(disk.path, 'blobs')).catch(() => null).finally(() => { if (looking === look) looking = null; });
    let timer, stop;
    try {
      return await Promise.race([look, new Promise(r => { timer = setTimeout(r, opts.keptWaitMs || KEPT_WAIT_MS, null); }),
        new Promise(r => { stop = () => r(null); if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); } })]);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
    }
  }
  const onInstalled = opts.onInstalled || (() => {});
  const now = opts.now || Date.now;
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const jobs = new Map();               // keyOf(model) → job
  let running = null;

  const pub = j => ({
    model: j.model, state: j.state, completed: j.completed, total: j.total,
    percent: j.total ? Math.min(100, Math.floor(j.completed / j.total * 1000) / 10) : null,
    speed: j.speed ? Math.round(j.speed) : null, eta: j.speed && j.total > j.completed ? Math.round((j.total - j.completed) / j.speed) : null,
    status: j.status, error: j.error, code: j.code, resumed: j.resumed, verified: j.verified, update: j.update,
    startedAt: j.startedAt, updatedAt: j.updatedAt,
  });
  let lastEmit = 0;
  function emit(j, force) {
    j.updatedAt = new Date(now()).toISOString();
    const t = now();
    if (!force && t - lastEmit < 250) return;
    lastEmit = t;
    events.emit('job', pub(j));
  }
  function finish(j, state, extra) {
    Object.assign(j, { state, stopping: null }, extra || {});
    if (j.controller) j.controller = null;
    emit(j, true);
    if (running === j) running = null;
    next();
  }
  // Paused (what arrived is kept, and resuming continues from there) or cancelled (forgotten)
  function stopped(j) {
    if (j.stopping === 'cancel') { jobs.delete(keyOf(j.model)); return finish(j, 'cancelled', { status: 'Cancelled', speed: null }); }
    return finish(j, 'paused', { status: 'Paused: what arrived is kept, and resuming continues from there', speed: null });
  }
  // What a download still has to fetch: the layers Ollama doesn't have yet (an update, or a tag that shares them
  // with an installed model, needs only the rest), less what Ollama keeps of them. (Where its models folder can't
  // be read: less what arrived in this run before a pause or an interruption.)
  async function toFetch(j, disk) {
    const kept = await keptByOllama(disk, j.controller && j.controller.signal);
    let need = 0;
    // (16 at a time: an MLX variant has a thousand layers and more)
    for (let i = 0; i < j.blobs.length && !j.stopping; i += 16) {
      const part = j.blobs.slice(i, i + 16);
      const have = await Promise.all(part.map(b => ollama.hasBlob(b.digest)));
      part.forEach((b, k) => { if (!have[k]) need += Math.max(0, b.size - ((kept ? kept.get(String(b.digest).toLowerCase()) : j.arrived[b.digest]) || 0)); });
    }
    return need;
  }

  function next() {
    if (running) return;
    const j = [...jobs.values()].find(x => x.state === 'queued');
    if (!j) return;
    running = j;
    run(j).catch(err => finish(j, 'failed', { error: String(err && err.message || err), code: 'internal' }));
  }

  async function run(j) {
    j.state = 'checking'; j.status = 'Checking the model and the free disk space'; j.error = null; j.code = null;
    j.controller = new AbortController();          // (pause and cancel work from here on)
    emit(j, true);
    const hw = await hardware.detect(true);
    if (j.stopping) return stopped(j);
    // The registry's exact layers, sizes and digests, of the variant this Ollama pulls: it depends on its version
    // too (catalog.js, pullsMlx). Needs the internet, as the download itself does.
    let version = null;
    try { version = await ollama.version(); } catch (e) { version = null; }
    let man = null;
    try { man = await catalog.manifest(j.model, { signal: j.controller.signal, appleSilicon: hw.appleSilicon, version }); } catch (e) { man = null; }
    if (j.stopping) return stopped(j);
    if (man && man.missing) return finish(j, 'failed', { error: 'Ollama\'s library has no model called "' + j.model + '".', code: 'not_in_library' });
    if (man && man.ok) { j.expected = man.size; j.digest = man.digest; j.digests = man.digests || [man.digest]; j.blobs = man.blobs; j.total = Math.max(j.total || 0, man.size); }
    const free = hw.disk && Number.isFinite(hw.disk.free) ? hw.disk.free : null;
    const need = j.blobs && free !== null ? await toFetch(j, hw.disk) : 0;
    if (j.stopping) return stopped(j);
    if (need && free < need + DISK_MARGIN) {
      return finish(j, 'failed', { error: 'Not enough disk space: ' + j.model + ' needs ' + size(need) + (need < j.expected ? ' more' : '') + ' (and ' + size(DISK_MARGIN) + ' to spare), and ' +
        (hw.disk.path || 'the disk') + ' has ' + size(free) + ' free. Delete a model you don\'t use, or free some space.', code: 'insufficient_disk' });
    }
    j.state = 'downloading'; j.status = 'Starting the download';
    emit(j, true);
    const layers = new Map();             // digest → { total, completed }
    let sample = null;
    try {
      await ollama.pull(j.model, line => {
        if (line.digest && line.total) {
          const layer = layers.get(line.digest) || { total: line.total, completed: 0 };
          if (!layers.has(line.digest) && line.completed > 0) j.resumed = true;      // Ollama continued an earlier download
          layer.total = line.total;
          if (typeof line.completed === 'number') layer.completed = line.completed;
          layers.set(line.digest, layer);
          j.arrived[line.digest] = layer.completed;                                   // (the disk check's, if Ollama's folder can't be read)
          let total = 0, done = 0;
          for (const l of layers.values()) { total += l.total; done += l.completed; }
          j.completed = done;
          j.total = Math.max(total, j.expected || 0);
          const t = now();
          if (!sample) sample = { t, done };
          else if (t - sample.t >= 1000) {
            const rate = (done - sample.done) / ((t - sample.t) / 1000);
            j.speed = j.speed ? j.speed * 0.6 + rate * 0.4 : rate;
            sample = { t, done };
          }
          j.status = 'Downloading';
        } else if (/verifying/i.test(line.status)) { j.state = 'verifying'; j.status = 'Checking the download (sha256)'; j.speed = null; }
        else if (/writing manifest|removing/i.test(line.status)) j.status = 'Finishing';
        else if (/pulling manifest/i.test(line.status)) j.status = 'Asking Ollama\'s library';
        emit(j, j.state === 'verifying');
      }, j.controller.signal, opts.idleMs);
    } catch (e) {
      if (j.stopping) return stopped(j);
      const code = e && e.code || 'pull_failed';
      const resumable = code === 'interrupted' || code === 'unreachable';
      return finish(j, 'failed', { error: String(e && e.message || e) + (resumable ? ' Resume to continue from where it stopped.' : ''), code, speed: null });
    }
    // Installed: is it the model the registry has? (Ollama may list it in the case of an earlier pull; any variant
    // of a tag with several is the registry's)
    j.state = 'verifying'; j.status = 'Checking the installed model'; j.completed = j.total;
    emit(j, true);
    let verified = null;
    try {
      const key = keyOf(j.model);
      const installed = (await ollama.tags()).find(m => keyOf(m.name) === key || (m.model && keyOf(m.model) === key));
      if (!installed) return finish(j, 'failed', { error: 'Ollama said the download finished, but doesn\'t list ' + j.model + '.', code: 'not_installed' });
      if (j.digest) verified = j.digests.includes(String(installed.digest || '').toLowerCase().replace(/^sha256:/, ''));
    } catch (e) { verified = null; }
    if (verified === false) {
      return finish(j, 'done', { status: 'Installed, but its digest doesn\'t match Ollama\'s library: delete it and install it again if in doubt', verified: false });
    }
    finish(j, 'done', { status: verified ? 'Installed and verified against Ollama\'s library' : 'Installed', verified });
    try { await onInstalled(j.model); } catch (e) { /* the AI service finds it on its next look */ }
  }

  // → { job } or { error, status }
  function start(model, o) {
    const name = normalize(model);
    if (!name) return { status: 400, error: 'That isn\'t a model name from Ollama\'s library (like gemma3:1b).', code: 'invalid_model' };
    const existing = jobs.get(keyOf(name));
    if (existing && !['done', 'failed', 'cancelled'].includes(existing.state)) {
      if (existing.state === 'paused') return resume(name);
      return { job: pub(existing), already: true };
    }
    const j = { model: name, state: 'queued', status: 'Waiting for the download before it', completed: 0, total: 0, speed: null, resumed: false, verified: null,
      update: !!(o && o.update), startedAt: new Date(now()).toISOString(), updatedAt: null, controller: null, stopping: null, error: null, code: null,
      // (what arrived per layer, for the disk check where Ollama's folder can't be read: an interrupted
      // download installed again continues, as a resume does)
      arrived: existing && existing.state === 'failed' ? existing.arrived : {} };
    jobs.set(keyOf(name), j);
    emit(j, true);
    next();
    return { job: pub(j) };
  }
  function stop(model, how) {
    const name = normalize(model);
    const j = name && jobs.get(keyOf(name));
    if (!j) return { status: 404, error: 'No download of that model.', code: 'not_found' };
    if (j.state === 'queued' || (j.state === 'paused' && how === 'cancel') || (j.state === 'failed' && how === 'cancel')) {
      if (how === 'cancel') { jobs.delete(keyOf(name)); Object.assign(j, { state: 'cancelled', status: 'Cancelled' }); emit(j, true); return { job: pub(j) }; }
      Object.assign(j, { state: 'paused', status: 'Paused' }); emit(j, true); return { job: pub(j) };
    }
    if (!j.controller) return { job: pub(j) };
    j.stopping = how;
    j.controller.abort();
    return { job: pub(j) };
  }
  function resume(model) {
    const name = normalize(model);
    const j = name && jobs.get(keyOf(name));
    if (!j) return { status: 404, error: 'No download of that model.', code: 'not_found' };
    if (!['paused', 'failed'].includes(j.state)) return { job: pub(j) };
    Object.assign(j, { state: 'queued', status: 'Waiting to resume', error: null, code: null });
    emit(j, true);
    next();
    return { job: pub(j) };
  }

  return {
    start, resume, pause: m => stop(m, 'pause'), cancel: m => stop(m, 'cancel'),
    list: () => [...jobs.values()].map(pub),
    busy: model => { const j = jobs.get(keyOf(model)); return !!j && !['done', 'failed', 'cancelled', 'paused'].includes(j.state); },
    events, normalize,
    close: () => { for (const j of jobs.values()) if (j.controller) { j.stopping = 'pause'; j.controller.abort(); } },
  };
}

module.exports = { createInstalls, normalize, keyOf };
