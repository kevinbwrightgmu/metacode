// Model installs (downloads through Ollama), one at a time, the others queued:
// - progress, speed and time left from Ollama's progress lines;
// - pause = stop the download, keeping what arrived; resume = pull again, and Ollama continues from there
//   (checked with a real Ollama); cancel = stop and forget it (Ollama tidies the parts up when it restarts);
// - the same model is never downloaded twice at once;
// - before a download: what it still has to fetch (the registry's layers Ollama doesn't have yet) against the
//   free disk space;
// - after it: the installed model's digest against the registry's (the sha256 of its manifest, or of one of the
//   variants when a tag has variants for several runners).
'use strict';
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

function createInstalls(opts) {
  const { ollama, catalog, hardware } = opts;
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
  // with an installed model, needs only the rest), less what arrived of them before a pause or an interruption
  async function toFetch(j) {
    let need = 0;
    // (16 at a time: an MLX variant has a thousand layers and more)
    for (let i = 0; i < j.blobs.length && !j.stopping; i += 16) {
      const part = j.blobs.slice(i, i + 16);
      const have = await Promise.all(part.map(b => ollama.hasBlob(b.digest)));
      part.forEach((b, k) => { if (!have[k]) need += Math.max(0, b.size - (j.arrived[b.digest] || 0)); });
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
    const need = j.blobs && free !== null ? await toFetch(j) : 0;
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
          j.arrived[line.digest] = layer.completed;                                   // (kept for the disk check of a resume)
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
      // (what arrived per layer: an interrupted download installed again continues, as a resume does)
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
