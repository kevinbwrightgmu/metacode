// @ts-check
// ── Durable scraper jobs ──────────────────────────────────────────────────────
// Each job is a folder under SCRAPER_DATA_DIR/jobs/<id>/:
//
//   job.json        the job's state: configuration snapshot (never credentials),
//                   status, progress, checkpoint, error, recent log lines.
//                   Written to a temporary file and renamed into place, so a
//                   crash never leaves half a file.
//   records.ndjson  the collected records, one JSON object per line, appended
//                   and fsync'ed batch by batch. A checkpoint is only written
//                   after the records it covers are on disk, so resuming never
//                   skips data; records collected again after a resume are
//                   dropped by their Reddit id (de-duplication).
//   events.ndjson   status changes, waits, checkpoints and errors (no content).
//   lease           which server process runs the job and until when it holds
//                   it. Created exclusively; a lease that wasn't renewed in
//                   time is stale and may be taken over, so two processes
//                   sharing this folder can't run the same job at once.
//
// MetaCode runs as one process (pm2 fork mode), so this is a safeguard rather
// than a distributed queue; see docs/scraper-network.md.

const fs = require('fs');
const path = require('path');

/** @typedef {import('../../types/scraper').JobEvent} JobEvent */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class JobStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir           SCRAPER_DATA_DIR
   * @param {string} opts.instanceId    this server process
   * @param {number} [opts.leaseMs]     how long a lease lasts without renewal (default 60 s)
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.dir = path.join(opts.dir, 'jobs');
    this.instanceId = opts.instanceId;
    this.leaseMs = opts.leaseMs || 60000;
    this.now = opts.now || Date.now;
    /** @type {Map<string, number>} open records file per running job */
    this.fds = new Map();
    /** @type {Map<string, number>} bytes on disk per job */
    this.sizes = new Map();
  }

  /** @param {string} id */
  jobDir(id) {
    if (!ID.test(id)) throw new Error('Invalid job id.');
    return path.join(this.dir, id);
  }

  /** Every job saved on disk (unreadable folders are skipped and reported). → { jobs, skipped } */
  loadAll() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    /** @type {Record<string, unknown>[]} */
    const jobs = [];
    let skipped = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!ID.test(name)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(this.dir, name, 'job.json'), 'utf8'));
        if (!state || state.id !== name) { skipped++; continue; }
        jobs.push(state);
        this.sizes.set(name, this.measure(name));
      } catch (e) {
        skipped++;
      }
    }
    return { jobs, skipped };
  }

  /** @param {string} id */
  measure(id) {
    let total = 0;
    for (const f of ['job.json', 'records.ndjson', 'events.ndjson']) {
      try { total += fs.statSync(path.join(this.jobDir(id), f)).size; } catch (e) { /* missing */ }
    }
    return total;
  }

  diskBytes() { let n = 0; this.sizes.forEach(v => { n += v; }); return n; }

  /**
   * Saves the job's state atomically.
   * @param {{ id: string }} state
   */
  save(state) {
    const dir = this.jobDir(state.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'job.json');
    const tmp = file + '.' + process.pid + '.tmp';
    const text = JSON.stringify(state);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.sizes.set(state.id, this.measure(state.id));
  }

  /**
   * Appends records and flushes them to disk before returning.
   * @param {string} id
   * @param {object[]} records
   */
  appendRecords(id, records) {
    if (!records.length) return;
    let fd = this.fds.get(id);
    if (fd === undefined) {
      fs.mkdirSync(this.jobDir(id), { recursive: true, mode: 0o700 });
      fd = fs.openSync(path.join(this.jobDir(id), 'records.ndjson'), 'a', 0o600);
      this.fds.set(id, fd);
    }
    const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    this.sizes.set(id, (this.sizes.get(id) || 0) + Buffer.byteLength(text));
  }

  /** @param {string} id */
  closeRecords(id) {
    const fd = this.fds.get(id);
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* already closed */ } this.fds.delete(id); }
  }

  /**
   * The job's records. A last line cut off by a crash is ignored.
   * @param {string} id
   * @returns {Record<string, unknown>[]}
   */
  readRecords(id) {
    let text = '';
    try { text = fs.readFileSync(path.join(this.jobDir(id), 'records.ndjson'), 'utf8'); } catch (e) { return []; }
    /** @type {Record<string, unknown>[]} */
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* torn write */ }
    }
    return out;
  }

  /**
   * @param {string} id
   * @param {JobEvent} event
   */
  appendEvent(id, event) {
    try {
      fs.mkdirSync(this.jobDir(id), { recursive: true, mode: 0o700 });
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(path.join(this.jobDir(id), 'events.ndjson'), line, { mode: 0o600 });
      this.sizes.set(id, (this.sizes.get(id) || 0) + Buffer.byteLength(line));
    } catch (e) { /* events are informational */ }
  }

  /**
   * @param {string} id
   * @param {number} offset
   * @param {number} limit
   * @returns {{ total: number, events: JobEvent[] }}
   */
  readEvents(id, offset, limit) {
    let text = '';
    try { text = fs.readFileSync(path.join(this.jobDir(id), 'events.ndjson'), 'utf8'); } catch (e) { return { total: 0, events: [] }; }
    /** @type {JobEvent[]} */
    const all = [];
    for (const line of text.split('\n')) { if (line) { try { all.push(JSON.parse(line)); } catch (e) { /* torn */ } } }
    return { total: all.length, events: all.slice(offset, offset + limit) };
  }

  /** @param {string} id */
  leaseFile(id) { return path.join(this.jobDir(id), 'lease'); }

  /**
   * Takes the job's lease for this process. → true when it holds it.
   * @param {string} id
   */
  acquireLease(id) {
    fs.mkdirSync(this.jobDir(id), { recursive: true, mode: 0o700 });
    const file = this.leaseFile(id);
    const body = JSON.stringify({ instance: this.instanceId, expiresAt: this.now() + this.leaseMs });
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code !== 'EEXIST') throw e;
    }
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { held = null; }
    if (held && held.instance !== this.instanceId && Number(held.expiresAt) > this.now()) return false;   // another live process holds it
    fs.writeFileSync(file, body, { mode: 0o600 });                                                        // ours, or stale
    return true;
  }

  /** @param {string} id */
  renewLease(id) {
    try {
      const held = JSON.parse(fs.readFileSync(this.leaseFile(id), 'utf8'));
      if (held.instance !== this.instanceId) return false;
      fs.writeFileSync(this.leaseFile(id), JSON.stringify({ instance: this.instanceId, expiresAt: this.now() + this.leaseMs }), { mode: 0o600 });
      return true;
    } catch (e) { return false; }
  }

  /** @param {string} id */
  releaseLease(id) {
    try {
      const held = JSON.parse(fs.readFileSync(this.leaseFile(id), 'utf8'));
      if (held.instance === this.instanceId) fs.unlinkSync(this.leaseFile(id));
    } catch (e) { /* none */ }
  }

  /**
   * Who holds the lease (null when nobody, or it expired).
   * @param {string} id
   * @returns {{ instance: string, expiresAt: number } | null}
   */
  leaseOf(id) {
    try {
      const held = JSON.parse(fs.readFileSync(this.leaseFile(id), 'utf8'));
      return Number(held.expiresAt) > this.now() ? held : null;
    } catch (e) { return null; }
  }

  /** @param {string} id */
  remove(id) {
    this.closeRecords(id);
    try { fs.rmSync(this.jobDir(id), { recursive: true, force: true }); } catch (e) { /* gone */ }
    this.sizes.delete(id);
  }

  close() { Array.from(this.fds.keys()).forEach(id => this.closeRecords(id)); }
}

module.exports = { JobStore, JOB_ID: ID };
