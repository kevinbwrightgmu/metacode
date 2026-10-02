// ── Scraper jobs ──────────────────────────────────────────────────────────────
// Jobs run in the background so no HTTP request waits on a scrape: POST
// /api/scraper/jobs answers 202 at once and progress is followed through
// server-sent events (the same SSE mechanism /api/ai uses for streaming) or
// by polling. Like MetaCode's other server state (EMIS key rotation), jobs
// live in server memory: results are kept for SCRAPER_JOB_RETENTION_MINUTES
// and are lost on restart — export them or add them to the project.
//
// Status machine:
//   queued → running → completed | failed | cancelled
//   queued → cancelled

const { EventEmitter } = require('events');
const crypto = require('crypto');
const F = require('../reddit/format');
const { ScraperError, isScraperError, cancelledError, sanitize } = require('../errors');

const TRANSITIONS = {
  queued:    ['running', 'cancelled'],
  running:   ['completed', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: []
};
const FINISHED = new Set(['completed', 'failed', 'cancelled']);
const MAX_LOG_LINES = 1000;
const MAX_LOG_LENGTH = 2000;

class JobManager extends EventEmitter {
  // runners: { standard(job, ctx), custom(job, ctx) } — each resolves when done
  constructor(opts) {
    super();
    this.setMaxListeners(0);
    this.config  = opts.config;
    this.http    = opts.http;
    this.runners = opts.runners;
    this.now     = opts.now || Date.now;
    this.jobs    = new Map();
    this.queue   = [];
    this.running = 0;
    this.logToConsole = opts.logToConsole !== false;
  }

  // spec: { mode, target, options, code, language, label } — already validated
  create(spec) {
    this.prune();
    const id = crypto.randomUUID();
    const job = {
      id,
      mode: spec.mode,
      status: 'queued',
      target: spec.target,
      label: spec.label || (spec.target && spec.target.label) || (spec.mode === 'custom' ? 'Custom scraper' : 'Scrape'),
      options: spec.options,
      // How many records the job may hold: maxItems, plus the comment budget
      // when comments are fetched for listing posts (see capacityFor()).
      capacity: spec.capacity || spec.options.maxItems,
      code: spec.code || null,
      language: spec.language || null,
      params: spec.params || null,
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: { pagesFetched: 0, requests: 0, itemsFound: 0, duplicates: 0, errors: 0, message: 'Waiting to start…' },
      records: [],
      keys: new Set(),
      logs: [],
      logsDropped: 0,
      meta: {},
      error: null,
      controller: new AbortController()
    };
    this.jobs.set(id, job);
    this.log(job, 'info', 'Job created (' + (job.mode === 'custom' ? 'custom code' : 'standard scraper') + ').');
    this.queue.push(job);
    this.pump();
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  list() {
    return Array.from(this.jobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  transition(job, to) {
    if (!TRANSITIONS[job.status].includes(to)) {
      throw new Error('Invalid job transition ' + job.status + ' → ' + to);
    }
    job.status = to;
    if (to === 'running') job.startedAt = new Date(this.now()).toISOString();
    if (FINISHED.has(to)) job.finishedAt = new Date(this.now()).toISOString();
    this.emit('event', job, 'status', this.summary(job));
  }

  pump() {
    while (this.running < this.config.maxConcurrentJobs && this.queue.length) {
      const job = this.queue.shift();
      if (job.status !== 'queued') continue;
      this.running++;
      this.execute(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
    this.queue.forEach((job, i) => {
      const msg = 'Queued — ' + (i + 1) + ' job' + (i ? 's' : '') + ' ahead of it… (at most ' + this.config.maxConcurrentJobs + ' run at once)';
      if (job.progress.message !== msg) { job.progress.message = msg; this.emit('event', job, 'progress', job.progress); }
    });
  }

  async execute(job) {
    this.transition(job, 'running');
    job.progress.message = 'Running…';
    const signal = job.controller.signal;
    const ctx = this.contextFor(job);
    try {
      const runner = this.runners[job.mode];
      if (!runner) throw new ScraperError('invalid_request', 'Unknown scraper mode.', { status: 400 });
      await runner(job, ctx);
      if (signal.aborted) throw signal.reason || cancelledError();
      job.progress.message = job.records.length
        ? 'Finished: ' + job.records.length + ' item' + (job.records.length === 1 ? '' : 's') + '.'
        : 'Finished, but no items were found.';
      if (!job.records.length) {
        this.log(job, 'warn', 'The scrape finished without results. The listing may be empty, the search may have no matches, or the limits may be too small.');
        job.meta.empty = true;
      }
      this.log(job, 'info', job.progress.message);
      this.transition(job, 'completed');
    } catch (err) {
      const e = isScraperError(err) ? err : (signal.aborted && isScraperError(signal.reason) ? signal.reason : null);
      if ((e && e.type === 'cancelled') || signal.aborted) {
        job.progress.message = 'Cancelled after ' + job.records.length + ' item' + (job.records.length === 1 ? '' : 's') + '.';
        this.log(job, 'warn', job.progress.message + ' Results collected so far are kept.');
        this.transition(job, 'cancelled');
        return;
      }
      if (e) {
        job.error = { type: e.type, message: e.message };
        if (e.detail) this.consoleLog('warn', job, e.type + ': ' + e.detail);
      } else {
        // An unexpected exception: log it on the server, show a generic message.
        job.error = { type: 'internal_error', message: 'Something went wrong in the scraper. The server log has details.' };
        this.consoleLog('error', job, 'Unexpected error: ' + sanitize(err && (err.stack || err.message), 600));
      }
      job.progress.errors++;
      job.progress.message = 'Failed: ' + job.error.message;
      this.log(job, 'error', job.error.message);
      this.transition(job, 'failed');
    } finally {
      this.emit('event', job, 'progress', job.progress);
    }
  }

  // What a runner gets to interact with its job.
  contextFor(job) {
    const self = this;
    const o = job.options;
    const ctx = {
      http: this.http,
      signal: job.controller.signal,
      log: (level, message) => self.log(job, level, message),
      progress: patch => self.progress(job, patch),
      emit: records => self.addRecords(job, records),
      remaining: () => Math.max(0, job.capacity - job.records.length),
      setMeta: (key, value) => { job.meta[key] = value; self.emit('event', job, 'meta', job.meta); },
      requestOpts: {
        signal: job.controller.signal,
        delayMs: o.delayMs,
        concurrency: o.concurrency,
        retries: o.retries,
        timeoutMs: o.timeoutMs,
        log: (level, message) => self.log(job, level, message),
        onRequest: info => {
          job.progress.requests++;
          if (info.error || (info.status && info.status >= 400)) job.progress.errors++;
          self.emit('event', job, 'progress', job.progress);
        }
      }
    };
    return ctx;
  }

  progress(job, patch) {
    patch = patch || {};
    if (Number.isFinite(patch.pagesFetched)) job.progress.pagesFetched = Math.max(job.progress.pagesFetched, patch.pagesFetched);
    if (Number.isFinite(patch.pagesDelta)) job.progress.pagesFetched += patch.pagesDelta;
    if (Number.isFinite(patch.errorsDelta)) job.progress.errors += patch.errorsDelta;
    if (typeof patch.message === 'string') job.progress.message = patch.message.slice(0, 300);
    this.emit('event', job, 'progress', job.progress);
  }

  // Adds records (de-duplicated, capped at maxItems). → remaining capacity.
  addRecords(job, records) {
    if (!Array.isArray(records)) records = [records];
    let added = 0;
    for (const r of records) {
      if (job.records.length >= job.capacity) break;
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const key = F.recordKey(r);
      if (key) {
        if (job.keys.has(key)) { job.progress.duplicates++; continue; }
        job.keys.add(key);
      }
      job.records.push(r);
      added++;
    }
    job.progress.itemsFound = job.records.length;
    if (added) this.emit('event', job, 'records', { added, total: job.records.length });
    this.emit('event', job, 'progress', job.progress);
    return Math.max(0, job.capacity - job.records.length);
  }

  log(job, level, message) {
    const lvl = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    let text = String(message === undefined || message === null ? '' : message).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');
    if (text.length > MAX_LOG_LENGTH) text = text.slice(0, MAX_LOG_LENGTH - 1) + '…';
    const entry = { ts: new Date(this.now()).toISOString(), level: lvl, message: text };
    job.logs.push(entry);
    if (job.logs.length > MAX_LOG_LINES) { job.logs.shift(); job.logsDropped++; }
    this.emit('event', job, 'log', entry);
    if (lvl === 'error') this.consoleLog('warn', job, text);
  }

  consoleLog(level, job, text) {
    if (!this.logToConsole) return;
    const line = '[scraper] job ' + job.id.slice(0, 8) + ': ' + sanitize(text, 400);
    if (level === 'error') console.error(line); else console.warn(line);
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      this.queue = this.queue.filter(j => j !== job);
      job.progress.message = 'Cancelled before it started.';
      this.log(job, 'warn', job.progress.message);
      this.transition(job, 'cancelled');
      this.pump();
    } else if (job.status === 'running') {
      this.log(job, 'warn', 'Cancelling…');
      job.controller.abort(cancelledError());
    }
    return job;
  }

  remove(id) {
    const job = this.get(id);
    if (!job) return false;
    if (!FINISHED.has(job.status)) this.cancel(id);
    this.jobs.delete(id);
    this.emit('removed', job);
    return true;
  }

  // Finished jobs older than the retention period go first; then the oldest
  // finished jobs while there are more than maxStoredJobs.
  prune() {
    const cutoff = this.now() - this.config.jobRetentionMinutes * 60000;
    for (const job of this.jobs.values()) {
      if (FINISHED.has(job.status) && Date.parse(job.finishedAt) < cutoff) this.remove(job.id);
    }
    const finished = this.list().filter(j => FINISHED.has(j.status)).reverse();
    while (this.jobs.size >= this.config.maxStoredJobs && finished.length) this.remove(finished.shift().id);
  }

  // Public view of a job (no records, no internals).
  summary(job) {
    const end = job.finishedAt ? Date.parse(job.finishedAt) : this.now();
    return {
      id: job.id,
      mode: job.mode,
      status: job.status,
      label: job.label,
      target: job.target,
      options: job.options,
      capacity: job.capacity,
      language: job.language,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.startedAt ? Math.max(0, end - Date.parse(job.startedAt)) : null,
      progress: Object.assign({}, job.progress),
      itemCount: job.records.length,
      error: job.error,
      meta: job.meta,
      logsDropped: job.logsDropped
    };
  }

  detail(job) {
    return Object.assign(this.summary(job), { code: job.code, params: job.params, logs: job.logs.slice() });
  }

  // Filter / search / page through a job's records.
  query(job, q) {
    q = q || {};
    let rows = job.records;
    if (q.type && q.type !== 'all') rows = rows.filter(r => r.record_type === q.type);
    if (q.search) {
      const needle = String(q.search).toLowerCase();
      rows = rows.filter(r => ['title', 'body', 'selftext', 'author', 'subreddit', 'flair', 'name'].some(k => typeof r[k] === 'string' && r[k].toLowerCase().includes(needle)));
    }
    const total = rows.length;
    const offset = Math.max(0, Number(q.offset) || 0);
    const limit = Math.max(1, Math.min(10000, Number(q.limit) || 500));
    return { total, offset, limit, records: rows.slice(offset, offset + limit) };
  }

  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.controller.abort(cancelledError());
      if (job.status === 'queued') this.cancel(job.id);
    }
  }
}

module.exports = { JobManager, TRANSITIONS, FINISHED };
