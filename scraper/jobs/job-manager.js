// @ts-check
// ── Scraper jobs ──────────────────────────────────────────────────────────────
// Jobs run in the background so no HTTP request waits on a scrape: POST
// /api/scraper/jobs answers 202 at once and progress is followed through
// server-sent events or by polling.
//
// With a JobStore (job-store.js; on by default, SCRAPER_PERSIST_JOBS) every
// job is kept on disk: its configuration, status, progress, checkpoint and
// records survive a restart. Without one (unit tests, or persistence turned
// off) jobs live in memory only, as before.
//
// Status machine (anything else is refused):
//
//   queued  → running | paused | cancelled
//   running → completed | failed | cancelled
//           | waiting    a temporary failure (network route down, rate limit,
//                        Reddit server errors) — the job is retried at
//                        `retryAt`, at most SCRAPER_MAX_JOB_WAITS times and
//                        SCRAPER_MAX_JOB_WAIT_MINUTES in total
//           | paused     the user paused it, or the automatic retries ran out
//           | queued     the server is shutting down / restarted; resumes from
//                        its checkpoint when it starts again
//   waiting → queued | paused | cancelled | failed
//   paused  → queued (resume) | cancelled
//   completed, failed, cancelled: final
//
// Only standard scrapes can wait, pause and resume: they have checkpoints
// (standard-scraper.js). Custom-code and AI jobs can't be resumed part-way,
// so a temporary failure fails them, and a restart ends them as failed
// ("interrupted") with what they collected kept.
//
// Access denials (HTTP 401/403, private or banned communities, robots.txt)
// always fail the job: they are answers, not outages, and are never retried
// through another route.

const { EventEmitter } = require('events');
const crypto = require('crypto');
const F = require('../reddit/format');
const { ScraperError, isScraperError, cancelledError, sanitize } = require('../errors');
const { logger } = require('../../lib/log');

/** @typedef {import('../../types/scraper').JobStatus} JobStatus */
/** @typedef {import('../../types/scraper').JobCheckpoint} JobCheckpoint */
/** @typedef {import('../../types/scraper').JobEvent} JobEvent */
/** @typedef {import('./job-store').JobStore} JobStore */

/** @type {Record<JobStatus, JobStatus[]>} */
const TRANSITIONS = {
  queued:    ['running', 'paused', 'cancelled'],
  running:   ['waiting', 'paused', 'completed', 'failed', 'cancelled', 'queued'],
  waiting:   ['queued', 'paused', 'cancelled', 'failed'],
  paused:    ['queued', 'cancelled'],
  completed: [], failed: [], cancelled: []
};
/** @type {Set<string>} */
const FINISHED = new Set(['completed', 'failed', 'cancelled']);
/** Jobs that hold a place in the queue (count against "jobs at once"). */
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const MAX_LOG_LINES = 1000;
const SAVED_LOG_LINES = 200;
const MAX_LOG_LENGTH = 2000;
/** Failures worth waiting out (when the job can resume). */
const WAITABLE = new Set(['network_unavailable', 'rate_limited', 'network', 'timeout', 'proxy_error', 'proxy_unavailable', 'robots_unavailable']);
const log = logger('scraper');

/**
 * @typedef {object} JobProgress
 * @property {number} pagesFetched
 * @property {number} requests
 * @property {number} requestsOk
 * @property {number} requestsFailed
 * @property {number} retries
 * @property {number} itemsFound
 * @property {number} duplicates
 * @property {number} errors
 * @property {string} message
 */

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} mode
 * @property {string | null} owner
 * @property {{ userId: string, reserved: number, period: string, settled?: boolean } | null} usage
 * @property {string} engine
 * @property {'server' | 'own' | 'browser'} keySource
 * @property {JobStatus} status
 * @property {any} target
 * @property {string} label
 * @property {any} options
 * @property {number} capacity
 * @property {string | null} code
 * @property {string | null} language
 * @property {object | null} params
 * @property {string} createdAt
 * @property {string | null} startedAt
 * @property {string | null} finishedAt
 * @property {string} updatedAt
 * @property {JobProgress} progress
 * @property {Record<string, unknown>[] | null} records   null until loaded from disk
 * @property {Set<string>} keys
 * @property {number} itemCount
 * @property {{ ts: string, level: string, message: string }[]} logs
 * @property {number} logsDropped
 * @property {Record<string, any>} meta
 * @property {{ type: string, message: string } | null} error
 * @property {{ type: string, message: string } | null} lastError
 * @property {JobCheckpoint | null} checkpoint
 * @property {number} attempts       runs started
 * @property {number} waits
 * @property {number} waitedMs
 * @property {string | null} retryAt
 * @property {string | null} pausedReason
 * @property {string | null} lastCollectedAt
 * @property {boolean} resumable
 * @property {AbortController} controller
 * @property {any} http
 * @property {NodeJS.Timeout | null} timer
 * @property {NodeJS.Timeout | null} heartbeat
 * @property {string | null} stopReason   why the running job is being stopped: pause | shutdown | cancel
 */

class JobManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {any} opts.config
   * @param {any} opts.http
   * @param {Record<string, (job: Job, ctx: any) => Promise<unknown>>} opts.runners
   * @param {() => number} [opts.now]
   * @param {boolean} [opts.logToConsole]
   * @param {JobStore | null} [opts.store]
   * @param {(job: Job) => ({ http: any } | { needs: 'keys' | 'browser' })} [opts.reattach]   after a restart: the job's HTTP client again
   */
  constructor(opts) {
    super();
    this.setMaxListeners(0);
    this.config  = opts.config;
    this.http    = opts.http;
    this.runners = opts.runners;
    this.now     = opts.now || Date.now;
    this.store   = opts.store || null;
    this.reattach = opts.reattach || null;
    /** @type {Map<string, Job>} */
    this.jobs    = new Map();
    /** @type {Job[]} */
    this.queue   = [];
    this.running = 0;
    this.logToConsole = opts.logToConsole !== false;
    /** @type {Map<string, number>} last time each job's state was written */
    this.savedAt = new Map();
    this.counters = { created: 0, completed: 0, failed: 0, cancelled: 0, paused: 0, waits: 0, recovered: 0, records: 0, duplicates: 0 };
    this.instanceStartedAt = this.now();
  }

  /** @param {number} [t] */
  iso(t) { return new Date(t === undefined ? this.now() : t).toISOString(); }

  // spec: { mode, engine, target, options, code, language, label, httpFor, keySource } —
  // already validated. httpFor(jobId) gives the job its own HTTP client.
  /** @param {any} spec */
  create(spec) {
    this.prune();
    const queued = this.queue.length;
    if (queued >= (this.config.maxQueuedJobs || Infinity)) {
      throw new ScraperError('queue_full', 'The scraper is busy: ' + queued + ' jobs are already waiting to start on this server. Try again in a few minutes.', { status: 503, retryAfterMs: 60000 });
    }
    if (this.store && this.config.maxDiskBytes && this.store.diskBytes() > this.config.maxDiskBytes) {
      this.prune(true);
      if (this.store.diskBytes() > this.config.maxDiskBytes) {
        log.error('storage.full', { bytes: this.store.diskBytes(), limit: this.config.maxDiskBytes });
        throw new ScraperError('storage_full', 'The scraper\'s storage on this server is full, so no new jobs can start. Delete finished jobs you no longer need, or ask the administrator to raise SCRAPER_MAX_DISK_MB.', { status: 503 });
      }
    }
    const id = crypto.randomUUID();
    const now = this.iso();
    /** @type {Job} */
    const job = {
      id,
      mode: spec.mode,
      owner: spec.owner || null,      // owner.js: the account or browser that started it; only it can see the job
      usage: spec.usage || null,      // the plan usage reserved for it (accounts/), settled when it finishes
      engine: spec.engine || 'server',
      keySource: spec.keySource || (spec.engine === 'browser' ? 'browser' : 'server'),
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
      createdAt: now, startedAt: null, finishedAt: null, updatedAt: now,
      progress: { pagesFetched: 0, requests: 0, requestsOk: 0, requestsFailed: 0, retries: 0, itemsFound: 0, duplicates: 0, errors: 0, message: 'Waiting to start…' },
      records: [], keys: new Set(), itemCount: 0,
      logs: [], logsDropped: 0,
      meta: {},
      error: null, lastError: null,
      checkpoint: null, attempts: 0, waits: 0, waitedMs: 0, retryAt: null, pausedReason: null, lastCollectedAt: null,
      resumable: spec.mode === 'standard',
      controller: new AbortController(),
      http: null, timer: null, heartbeat: null, stopReason: null
    };
    job.http = typeof spec.httpFor === 'function' ? spec.httpFor(id) : null;
    this.jobs.set(id, job);
    this.counters.created++;
    this.log(job, 'info', 'Job created (' + (job.mode === 'custom' ? 'custom code' : job.mode === 'ai' ? 'AI Scraper' : 'standard scraper') + ').');
    this.event(job, 'created', { mode: job.mode, engine: job.engine, keys: job.keySource });
    this.persist(job, true);
    this.queue.push(job);
    this.pump();
    return job;
  }

  /** @param {string} id */
  get(id) { return this.jobs.get(id) || null; }

  list() {
    return Array.from(this.jobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * @param {Job} job
   * @param {JobStatus} to
   */
  transition(job, to) {
    if (!TRANSITIONS[job.status].includes(to)) {
      throw new Error('Invalid job transition ' + job.status + ' → ' + to);
    }
    const from = job.status;
    job.status = to;
    if (to === 'running' && !job.startedAt) job.startedAt = this.iso();
    if (FINISHED.has(to)) {
      job.finishedAt = this.iso();
      if (to === 'completed' || to === 'failed' || to === 'cancelled') this.counters[to]++;
    }
    if (to === 'paused') this.counters.paused++;
    if (to !== 'waiting') job.retryAt = null;
    if (to !== 'paused') job.pausedReason = to === 'queued' || to === 'running' ? null : job.pausedReason;
    this.event(job, 'status', { from, to });
    this.persist(job, true);
    if (FINISHED.has(to) && this.store) this.store.closeRecords(job.id);
    this.emit('event', job, 'status', this.summary(job));
  }

  pump() {
    while (this.running < this.config.maxConcurrentJobs && this.queue.length) {
      const job = /** @type {Job} */ (this.queue.shift());
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

  /** @param {Job} job */
  async execute(job) {
    if (this.store && !this.store.acquireLease(job.id)) {
      // Another MetaCode process sharing SCRAPER_DATA_DIR holds this job
      job.pausedReason = 'lease_held';
      this.log(job, 'warn', 'Another MetaCode server process is running this job; this one left it alone.');
      this.transition(job, 'paused');
      return;
    }
    job.controller = new AbortController();
    job.stopReason = null;
    job.attempts++;
    this.transition(job, 'running');
    if (job.attempts > 1) this.log(job, 'info', 'Resuming' + (job.checkpoint ? ' from the checkpoint at ' + job.checkpoint.items + ' item' + (job.checkpoint.items === 1 ? '' : 's') : '') + ' (run ' + job.attempts + ').');
    job.progress.message = job.attempts > 1 ? 'Resuming…' : 'Running…';
    if (this.store) {
      const store = this.store;
      job.heartbeat = setInterval(() => store.renewLease(job.id), Math.max(1000, Math.floor(store.leaseMs / 3)));
      if (job.heartbeat.unref) job.heartbeat.unref();
    }
    const signal = job.controller.signal;
    try {
      this.ensureRecords(job);
      const ctx = this.contextFor(job);
      const runner = this.runners[job.mode];
      if (!runner) throw new ScraperError('invalid_request', 'Unknown scraper mode.', { status: 400 });
      await runner(job, ctx);
      if (signal.aborted) throw signal.reason || cancelledError();
      const n = job.itemCount;
      job.progress.message = n ? 'Finished: ' + n + ' item' + (n === 1 ? '' : 's') + '.' : 'Finished, but no items were found.';
      if (!n) {
        this.log(job, 'warn', 'The scrape finished without results. The listing may be empty, the search may have no matches, or the limits may be too small.');
        job.meta.empty = true;
      }
      this.log(job, 'info', job.progress.message);
      this.transition(job, 'completed');
    } catch (err) {
      this.handleFailure(job, err);
    } finally {
      if (job.heartbeat) { clearInterval(job.heartbeat); job.heartbeat = null; }
      if (this.store) this.store.releaseLease(job.id);
      this.emit('event', job, 'progress', job.progress);
    }
  }

  /**
   * A run ended with an exception: stopped on purpose, a temporary failure to
   * wait out, or a failure.
   * @param {Job} job
   * @param {unknown} err
   */
  handleFailure(job, err) {
    const signal = job.controller.signal;
    const reason = job.stopReason;
    if (reason === 'shutdown') return;     // shutdown() already recorded what happens next
    const e = isScraperError(err) ? /** @type {ScraperError} */ (err) : (signal.aborted && isScraperError(signal.reason) ? /** @type {ScraperError} */ (signal.reason) : null);
    if (reason === 'pause') {
      job.pausedReason = job.pausedReason || 'user';
      job.progress.message = 'Paused after ' + job.itemCount + ' item' + (job.itemCount === 1 ? '' : 's') + '.';
      this.log(job, 'info', job.progress.message + ' Press Resume to continue from the last checkpoint.');
      this.transition(job, 'paused');
      return;
    }
    if ((e && e.type === 'cancelled') || signal.aborted) {
      job.progress.message = 'Cancelled after ' + job.itemCount + ' item' + (job.itemCount === 1 ? '' : 's') + '.';
      this.log(job, 'warn', job.progress.message + ' Results collected so far are kept.');
      this.transition(job, 'cancelled');
      return;
    }
    if (e && job.resumable && this.waitable(e)) {
      job.lastError = { type: e.type, message: e.message };
      if (e.detail) this.consoleLog('warn', job, e.type + ': ' + e.detail);
      const delay = this.waitDelay(job, e);
      const maxWaits = this.config.maxJobWaits === undefined ? 6 : this.config.maxJobWaits;
      const maxWaitMs = (this.config.maxJobWaitMinutes === undefined ? 30 : this.config.maxJobWaitMinutes) * 60000;
      if (job.waits < maxWaits && job.waitedMs + delay <= maxWaitMs) return this.wait(job, delay, e);
      if (maxWaits > 0) {
        job.pausedReason = 'retry_limit';
        job.progress.message = 'Paused: ' + e.message;
        this.log(job, 'warn', 'Paused after ' + job.waits + ' automatic retr' + (job.waits === 1 ? 'y' : 'ies') + ' (' + Math.round(job.waitedMs / 60000) + ' min of waiting): ' + e.message + ' Press Resume to try again later; the ' + job.itemCount + ' item' + (job.itemCount === 1 ? '' : 's') + ' collected so far are kept.');
        this.transition(job, 'paused');
        return;
      }
    }
    if (e) {
      job.error = { type: e.type, message: e.message };
      if (e.detail) this.consoleLog('warn', job, e.type + ': ' + e.detail);
    } else {
      // An unexpected exception: log it on the server, show a generic message.
      job.error = { type: 'internal_error', message: 'Something went wrong in the scraper. The server log has details.' };
      this.consoleLog('error', job, 'Unexpected error: ' + sanitize(err && /** @type {Error} */ (err).stack || String(err), 600));
    }
    job.progress.errors++;
    job.progress.message = 'Failed: ' + job.error.message;
    this.log(job, 'error', job.error.message);
    this.event(job, 'error', { type: job.error.type });
    this.transition(job, 'failed');
  }

  /** @param {ScraperError} e */
  waitable(e) {
    if (WAITABLE.has(e.type)) return e.type !== 'proxy_blocked' || e.retryable;
    return e.type === 'http_error' && (e.httpStatus || 0) >= 500;
  }

  /**
   * How long to wait: what the source or the circuit breaker asked for, else
   * an exponential backoff with jitter (30 s, 60 s, 120 s … up to 10 min).
   * @param {Job} job
   * @param {ScraperError} e
   */
  waitDelay(job, e) {
    const base = Number(this.config.jobWaitBaseMs) || 30000;
    if (e.retryAfterMs && e.retryAfterMs > 0) return Math.min(15 * 60000, Math.max(1000, e.retryAfterMs));
    const backoff = Math.min(10 * 60000, base * Math.pow(2, job.waits));
    return Math.round(backoff * (0.8 + Math.random() * 0.4));
  }

  /**
   * @param {Job} job
   * @param {number} delay
   * @param {ScraperError} e
   */
  wait(job, delay, e) {
    job.waits++;
    job.waitedMs += delay;
    this.counters.waits++;
    const at = this.now() + delay;
    job.progress.message = 'Waiting until ' + new Date(at).toISOString().slice(11, 19) + ' UTC: ' + e.message;
    this.log(job, 'warn', e.message + ' Trying again in ' + Math.round(delay / 1000) + ' s (automatic retry ' + job.waits + ' of ' + (this.config.maxJobWaits === undefined ? 6 : this.config.maxJobWaits) + ').');
    this.event(job, 'wait', { type: e.type, ms: delay });
    this.transition(job, 'waiting');
    job.retryAt = this.iso(at);
    this.persist(job, true);
    this.armWait(job);
  }

  /** @param {Job} job */
  armWait(job) {
    if (job.timer) clearTimeout(job.timer);
    const delay = Math.max(0, Date.parse(job.retryAt || '') - this.now()) || 0;
    job.timer = setTimeout(() => {
      job.timer = null;
      if (job.status !== 'waiting') return;
      this.transition(job, 'queued');
      this.queue.push(job);
      this.pump();
    }, delay);      // not unref'd: a waiting job is work in progress (shutdown() clears it)
  }

  // What a runner gets to interact with its job.
  /** @param {Job} job */
  contextFor(job) {
    const self = this;
    const o = job.options;
    const ctx = {
      http: job.http || this.http,
      signal: job.controller.signal,
      log: (/** @type {string} */ level, /** @type {string} */ message) => self.log(job, level, message),
      progress: (/** @type {any} */ patch) => self.progress(job, patch),
      emit: (/** @type {any} */ records) => self.addRecords(job, records),
      remaining: () => Math.max(0, job.capacity - job.itemCount),
      setMeta: (/** @type {string} */ key, /** @type {unknown} */ value) => { job.meta[key] = value; self.persist(job); self.emit('event', job, 'meta', job.meta); },
      // Resuming: where the last run got to, and what it had collected
      resumeFrom: job.checkpoint ? job.checkpoint.state : null,
      committed: () => /** @type {Record<string, unknown>[]} */ (job.records || []),
      // The scraper calls this after a page's records were emitted (and so are on disk)
      checkpoint: (/** @type {import('../../types/scraper').StandardCheckpoint} */ state) => self.checkpoint(job, state),
      requestOpts: {
        signal: job.controller.signal,
        delayMs: o.delayMs,
        concurrency: o.concurrency,
        retries: o.retries,
        timeoutMs: o.timeoutMs,
        log: (/** @type {string} */ level, /** @type {string} */ message) => self.log(job, level, message),
        onRequest: (/** @type {{ status?: number | null, error?: string, attempt?: number }} */ info) => {
          job.progress.requests++;
          if (info.attempt && info.attempt > 0) job.progress.retries++;
          if (info.error || (info.status && info.status >= 400)) { job.progress.errors++; job.progress.requestsFailed++; }
          else job.progress.requestsOk++;
          self.emit('event', job, 'progress', job.progress);
        }
      }
    };
    return ctx;
  }

  /**
   * Records the point a resumed run continues from. Called after the records
   * it covers were appended (and flushed) to disk.
   * @param {Job} job
   * @param {import('../../types/scraper').StandardCheckpoint} state
   */
  checkpoint(job, state) {
    job.checkpoint = { at: this.iso(), items: job.itemCount, state: Object.assign({}, state) };
    this.event(job, 'checkpoint', { items: job.itemCount, phase: state.phase, sort: state.sort, pages: state.pages });
    this.persist(job, true);
    this.emit('event', job, 'meta', job.meta);
  }

  /**
   * @param {Job} job
   * @param {any} patch
   */
  progress(job, patch) {
    patch = patch || {};
    if (Number.isFinite(patch.pagesFetched)) job.progress.pagesFetched = Math.max(job.progress.pagesFetched, patch.pagesFetched);
    if (Number.isFinite(patch.pagesDelta)) job.progress.pagesFetched += patch.pagesDelta;
    if (Number.isFinite(patch.errorsDelta)) job.progress.errors += patch.errorsDelta;
    if (typeof patch.message === 'string') job.progress.message = patch.message.slice(0, 300);
    this.persist(job);
    this.emit('event', job, 'progress', job.progress);
  }

  // Adds records (de-duplicated, capped at the job's capacity), writes them to
  // disk before anything else happens. → remaining capacity.
  /**
   * @param {Job} job
   * @param {unknown} records
   */
  addRecords(job, records) {
    const list = Array.isArray(records) ? records : [records];
    const recs = /** @type {Record<string, unknown>[]} */ (job.records || this.ensureRecords(job));
    /** @type {Record<string, unknown>[]} */
    const added = [];
    for (const r of list) {
      if (job.itemCount + added.length >= job.capacity) break;
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const rec = /** @type {Record<string, unknown>} */ (r);
      const key = F.recordKey(rec);
      if (key) {
        if (job.keys.has(key)) { job.progress.duplicates++; this.counters.duplicates++; continue; }
        job.keys.add(key);
      }
      added.push(rec);
    }
    if (added.length) {
      if (this.store) this.store.appendRecords(job.id, added);
      added.forEach(r => recs.push(r));
      job.itemCount = recs.length;
      job.lastCollectedAt = this.iso();
      this.counters.records += added.length;
    }
    job.progress.itemsFound = job.itemCount;
    if (added.length) this.emit('event', job, 'records', { added: added.length, total: job.itemCount });
    this.persist(job);
    this.emit('event', job, 'progress', job.progress);
    return Math.max(0, job.capacity - job.itemCount);
  }

  /**
   * The job's records, loaded from disk when they aren't in memory.
   * @param {Job} job
   */
  ensureRecords(job) {
    if (job.records) return job.records;
    const recs = this.store ? this.store.readRecords(job.id) : [];
    job.records = recs;
    job.keys = new Set();
    recs.forEach(r => { const k = F.recordKey(r); if (k) job.keys.add(k); });
    job.itemCount = recs.length;
    return recs;
  }

  /** @param {Job} job */
  recordsOf(job) { return /** @type {Record<string, any>[]} */ (this.ensureRecords(job)); }

  /**
   * @param {Job} job
   * @param {string} level
   * @param {unknown} message
   */
  log(job, level, message) {
    const lvl = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    let text = String(message === undefined || message === null ? '' : message).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');
    if (text.length > MAX_LOG_LENGTH) text = text.slice(0, MAX_LOG_LENGTH - 1) + '…';
    const entry = { ts: this.iso(), level: lvl, message: text };
    job.logs.push(entry);
    if (job.logs.length > MAX_LOG_LINES) { job.logs.shift(); job.logsDropped++; }
    this.emit('event', job, 'log', entry);
    if (lvl === 'error') this.consoleLog('warn', job, text);
  }

  /**
   * @param {Job} job
   * @param {JobEvent['type']} type
   * @param {JobEvent['data']} [data]
   */
  event(job, type, data) {
    if (this.store) this.store.appendEvent(job.id, { ts: this.iso(), type, data });
  }

  /**
   * @param {string} level
   * @param {Job} job
   * @param {string} text
   */
  consoleLog(level, job, text) {
    if (!this.logToConsole) return;
    const line = '[scraper] job ' + job.id.slice(0, 8) + ': ' + sanitize(text, 400);
    if (level === 'error') console.error(line); else console.warn(line);
  }

  /**
   * Writes the job's state to disk (now, or at most every 2 s for progress updates).
   * @param {Job} job
   * @param {boolean} [now]
   */
  persist(job, now) {
    job.updatedAt = this.iso();
    if (!this.store) return;
    const last = this.savedAt.get(job.id) || 0;
    if (!now && this.now() - last < 2000) {
      if (!this.savedAt.has('pending:' + job.id)) {
        this.savedAt.set('pending:' + job.id, 1);
        const t = setTimeout(() => { this.savedAt.delete('pending:' + job.id); if (this.jobs.has(job.id)) this.persist(job, true); }, 2000);
        if (t.unref) t.unref();
      }
      return;
    }
    this.savedAt.set(job.id, this.now());
    try { this.store.save(this.snapshot(job)); }
    catch (e) { log.error('job.save_failed', { job: job.id.slice(0, 8), code: /** @type {NodeJS.ErrnoException} */ (e).code || 'error' }); }
  }

  /**
   * What is written to job.json — the configuration snapshot and state, never
   * credentials (those stay in the job's HTTP client, in memory only).
   * @param {Job} job
   */
  snapshot(job) {
    return {
      schema: 1,
      id: job.id, mode: job.mode, owner: job.owner, usage: job.usage, engine: job.engine, keySource: job.keySource,
      status: job.status, target: job.target, label: job.label, options: job.options, capacity: job.capacity,
      code: job.code, language: job.language, params: job.params,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, updatedAt: job.updatedAt,
      progress: job.progress, itemCount: job.itemCount, logs: job.logs.slice(-SAVED_LOG_LINES), logsDropped: job.logsDropped + Math.max(0, job.logs.length - SAVED_LOG_LINES),
      meta: job.meta, error: job.error, lastError: job.lastError, checkpoint: job.checkpoint,
      attempts: job.attempts, waits: job.waits, waitedMs: job.waitedMs, retryAt: job.retryAt, pausedReason: job.pausedReason,
      lastCollectedAt: job.lastCollectedAt, resumable: job.resumable
    };
  }

  /**
   * Pauses a queued, waiting or running job (standard scrapes only).
   * @param {string} id
   */
  pause(id) {
    const job = this.get(id);
    if (!job) return null;
    if (!job.resumable) throw new ScraperError('invalid_state', 'This kind of job can\'t be paused and resumed (only standard scrapes keep checkpoints). Cancel it instead; what it collected is kept.', { status: 409 });
    if (job.status === 'queued') {
      this.queue = this.queue.filter(j => j !== job);
      job.pausedReason = 'user';
      job.progress.message = 'Paused before it started.';
      this.transition(job, 'paused');
      this.pump();
    } else if (job.status === 'waiting') {
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
      job.pausedReason = 'user';
      job.progress.message = 'Paused after ' + job.itemCount + ' items.';
      this.transition(job, 'paused');
    } else if (job.status === 'running') {
      this.log(job, 'info', 'Pausing at the next safe point…');
      this.event(job, 'pause_requested');
      job.stopReason = 'pause';
      job.pausedReason = 'user';
      job.controller.abort(cancelledError());     // stops it like a cancel; stopReason makes it a pause
    } else {
      throw new ScraperError('invalid_state', 'Only queued, waiting or running jobs can be paused (this one is ' + job.status + ').', { status: 409 });
    }
    return job;
  }

  /**
   * Resumes a paused job (or a waiting one, at once). `httpFor` gives it its
   * HTTP client again — needed after a restart for jobs that ran on the user's
   * own keys or browser.
   * @param {string} id
   * @param {{ httpFor?: (jobId: string) => any }} [opts]
   */
  resume(id, opts) {
    const job = this.get(id);
    if (!job) return null;
    if (!job.resumable) throw new ScraperError('invalid_state', 'This kind of job can\'t be resumed. Start a new one.', { status: 409 });
    if (job.status === 'waiting') {
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    } else if (job.status !== 'paused') {
      throw new ScraperError('invalid_state', 'Only paused or waiting jobs can be resumed (this one is ' + job.status + ').', { status: 409 });
    }
    if (opts && typeof opts.httpFor === 'function') job.http = opts.httpFor(job.id);
    if (job.pausedReason === 'needs_keys' && !(opts && opts.httpFor)) {
      throw new ScraperError('invalid_request', 'This job used your own Reddit API keys, which aren\'t kept on the server. Resume it from the page that has them (Reddit API access), so they are sent again.', { status: 400 });
    }
    // A fresh allowance of automatic retries for this run
    job.waits = 0;
    job.waitedMs = 0;
    this.event(job, 'resume', { items: job.itemCount });
    this.log(job, 'info', 'Resume requested.');
    this.transition(job, 'queued');
    this.queue.push(job);
    this.pump();
    return job;
  }

  /**
   * Changes settings of a paused job: a longer delay between requests, fewer
   * items or pages. Nothing that would need more of the plan's allowance.
   * @param {string} id
   * @param {{ delayMs?: number, maxItems?: number, maxPages?: number }} patch
   * @param {{ minDelayMs: number, maxPages: number }} limits
   */
  reconfigure(id, patch, limits) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status !== 'paused') throw new ScraperError('invalid_state', 'Pause the job before changing its settings.', { status: 409 });
    const o = Object.assign({}, job.options);
    /** @type {Record<string, number>} */
    const changed = {};
    const int = /** @param {unknown} v */ v => (Number.isInteger(Number(v)) ? Number(v) : NaN);
    if (patch.delayMs !== undefined) {
      const v = int(patch.delayMs);
      if (!(v >= limits.minDelayMs && v <= 120000)) throw new ScraperError('invalid_request', 'The delay between requests must be ' + limits.minDelayMs + '–120000 ms.', { status: 400 });
      o.delayMs = changed.delayMs = v;
    }
    if (patch.maxItems !== undefined) {
      const v = int(patch.maxItems);
      if (!(v >= Math.max(1, job.itemCount) && v <= o.maxItems)) throw new ScraperError('invalid_request', 'Maximum items can only be lowered (to between ' + Math.max(1, job.itemCount) + ' and ' + o.maxItems + ').', { status: 400 });
      job.capacity = Math.max(job.itemCount, job.capacity - (o.maxItems - v));
      o.maxItems = changed.maxItems = v;
    }
    if (patch.maxPages !== undefined) {
      const v = int(patch.maxPages);
      if (!(v >= 1 && v <= limits.maxPages)) throw new ScraperError('invalid_request', 'Maximum pages must be 1–' + limits.maxPages + '.', { status: 400 });
      o.maxPages = changed.maxPages = v;
    }
    job.options = o;
    this.event(job, 'config', changed);
    this.log(job, 'info', 'Settings changed: ' + Object.entries(changed).map(([k, v]) => k + ' = ' + v).join(', ') + '.');
    this.persist(job, true);
    this.emit('event', job, 'status', this.summary(job));
    return job;
  }

  /** @param {string} id */
  cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (FINISHED.has(job.status)) return job;
    this.event(job, 'cancel_requested');
    if (job.status === 'queued' || job.status === 'waiting' || job.status === 'paused') {
      if (job.status === 'queued') this.queue = this.queue.filter(j => j !== job);
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
      job.progress.message = job.status === 'queued' && !job.attempts ? 'Cancelled before it started.' : 'Cancelled after ' + job.itemCount + ' item' + (job.itemCount === 1 ? '' : 's') + '.';
      this.log(job, 'warn', job.progress.message);
      this.transition(job, 'cancelled');
      this.pump();
    } else if (job.status === 'running') {
      this.log(job, 'warn', 'Cancelling…');
      job.stopReason = 'cancel';
      job.controller.abort(cancelledError());
    }
    return job;
  }

  /** @param {string} id */
  remove(id) {
    const job = this.get(id);
    if (!job) return false;
    if (!FINISHED.has(job.status)) this.cancel(id);
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    this.jobs.delete(id);
    if (this.store) this.store.remove(id);
    this.emit('removed', job);
    return true;
  }

  // Retention: finished jobs older than SCRAPER_JOB_RETENTION_MINUTES go
  // first, then the oldest finished jobs while there are more than
  // maxStoredJobs (or, `forSpace`, while the disk is over its limit). Paused
  // jobs left alone longer than SCRAPER_PAUSED_RETENTION_HOURS are cancelled.
  /** @param {boolean} [forSpace] */
  prune(forSpace) {
    const now = this.now();
    const cutoff = now - this.config.jobRetentionMinutes * 60000;
    const pausedCutoff = now - (this.config.pausedRetentionHours || 24) * 3600000;
    for (const job of Array.from(this.jobs.values())) {
      if (FINISHED.has(job.status) && Date.parse(job.finishedAt || job.updatedAt) < cutoff) this.remove(job.id);
      else if (job.status === 'paused' && Date.parse(job.updatedAt) < pausedCutoff) {
        this.log(job, 'warn', 'Cancelled: it stayed paused for more than ' + (this.config.pausedRetentionHours || 24) + ' hours.');
        this.transition(job, 'cancelled');
      }
    }
    const finished = this.list().filter(j => FINISHED.has(j.status)).reverse();
    while (this.jobs.size >= this.config.maxStoredJobs && finished.length) this.remove(/** @type {Job} */ (finished.shift()).id);
    if (forSpace && this.store) {
      while (this.store.diskBytes() > (this.config.maxDiskBytes || Infinity) && finished.length) this.remove(/** @type {Job} */ (finished.shift()).id);
    }
  }

  /**
   * After a restart: brings back the jobs saved on disk. Finished jobs come
   * back as they were; standard scrapes that were queued, running or waiting
   * continue from their checkpoint (or wait for their owner when they need
   * the user's own keys or browser); other jobs end as interrupted.
   * → { loaded, resumed, paused, interrupted, skipped }
   */
  recover() {
    const out = { loaded: 0, resumed: 0, paused: 0, interrupted: 0, skipped: 0 };
    if (!this.store) return out;
    const { jobs, skipped } = this.store.loadAll();
    out.skipped = skipped;
    for (const s of /** @type {any[]} */ (jobs)) {
      if (this.jobs.has(s.id)) continue;
      const lease = this.store.leaseOf(s.id);
      if (lease && lease.instance !== this.store.instanceId && !FINISHED.has(s.status)) { out.skipped++; continue; }   // another live process runs it
      /** @type {Job} */
      const job = Object.assign({
        progress: { pagesFetched: 0, requests: 0, requestsOk: 0, requestsFailed: 0, retries: 0, itemsFound: 0, duplicates: 0, errors: 0, message: '' },
        logs: [], logsDropped: 0, meta: {}, error: null, lastError: null, checkpoint: null, attempts: 0, waits: 0, waitedMs: 0,
        retryAt: null, pausedReason: null, lastCollectedAt: null, keySource: 'server', itemCount: 0
      }, s, {
        records: null, keys: new Set(), controller: new AbortController(), http: null, timer: null, heartbeat: null, stopReason: null,
        resumable: s.mode === 'standard'
      });
      ['requestsOk', 'requestsFailed', 'retries'].forEach(k => { if (!Number.isFinite(job.progress[/** @type {'retries'} */ (k)])) job.progress[/** @type {'retries'} */ (k)] = 0; });
      this.jobs.set(job.id, job);
      out.loaded++;
      if (FINISHED.has(job.status)) continue;
      const was = job.status;
      if (!job.resumable) {
        if (was === 'paused') continue;
        this.ensureRecords(job);
        job.error = { type: 'interrupted', message: 'The server restarted while this job was ' + (was === 'queued' ? 'waiting to start' : 'running') + '. ' +
          (job.itemCount ? 'The ' + job.itemCount + ' item' + (job.itemCount === 1 ? '' : 's') + ' collected before that are kept; start' : 'Start') + ' the job again to collect more.' };
        job.progress.message = 'Interrupted by a server restart.';
        this.log(job, 'warn', job.error.message);
        job.status = 'failed';
        job.finishedAt = this.iso();
        this.event(job, 'recovered', { from: was, to: 'failed' });
        this.persist(job, true);
        out.interrupted++;
        continue;
      }
      if (was === 'paused') continue;
      // queued / running / waiting → continue, if the job's HTTP client can be rebuilt here
      const again = this.reattach ? this.reattach(job) : { http: null };
      if ('needs' in again) {
        job.status = 'paused';
        job.pausedReason = again.needs === 'keys' ? 'needs_keys' : 'needs_browser';
        job.progress.message = again.needs === 'keys'
          ? 'Paused by a server restart: this job used your own Reddit API keys, which aren\'t kept on the server. Press Resume on the Scraper page to continue.'
          : 'Paused by a server restart: this job fetched Reddit through your browser. Open MetaCode and press Resume to continue.';
        this.log(job, 'warn', job.progress.message);
        this.event(job, 'recovered', { from: was, to: 'paused' });
        this.persist(job, true);
        out.paused++;
        continue;
      }
      job.http = again.http;
      if (was === 'waiting' && job.retryAt && Date.parse(job.retryAt) > this.now()) {
        this.log(job, 'info', 'The server restarted; the job keeps waiting until ' + job.retryAt + '.');
        this.event(job, 'recovered', { from: was, to: 'waiting' });
        this.persist(job, true);
        this.armWait(job);
      } else {
        job.status = 'queued';
        job.progress.message = 'Resuming after a server restart…';
        this.log(job, 'info', 'The server restarted; the job continues from its last checkpoint.');
        this.event(job, 'recovered', { from: was, to: 'queued' });
        this.persist(job, true);
        this.queue.push(job);
      }
      out.resumed++;
      this.counters.recovered++;
    }
    this.pump();
    if (out.loaded) log.info('jobs.recovered', out);
    return out;
  }

  // Public view of a job (no records, no internals).
  /** @param {Job} job */
  summary(job) {
    const end = job.finishedAt ? Date.parse(job.finishedAt) : this.now();
    return {
      id: job.id,
      mode: job.mode,
      engine: job.engine,
      status: job.status,
      label: job.label,
      target: job.target,
      options: job.options,
      capacity: job.capacity,
      language: job.language,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      updatedAt: job.updatedAt,
      durationMs: job.startedAt ? Math.max(0, end - Date.parse(job.startedAt)) : null,
      progress: Object.assign({}, job.progress),
      itemCount: job.itemCount,
      error: job.error,
      lastError: job.lastError,
      meta: job.meta,
      logsDropped: job.logsDropped,
      resumable: job.resumable,
      persistent: !!this.store,
      checkpoint: job.checkpoint ? { at: job.checkpoint.at, items: job.checkpoint.items, phase: job.checkpoint.state.phase } : null,
      attempts: job.attempts,
      waits: job.waits,
      retryAt: job.retryAt,
      pausedReason: job.pausedReason,
      lastCollectedAt: job.lastCollectedAt,
      keySource: job.keySource
    };
  }

  /** @param {Job} job */
  detail(job) {
    return Object.assign(this.summary(job), { code: job.code, params: job.params, logs: job.logs.slice() });
  }

  // Filter / search / page through a job's records.
  /**
   * @param {Job} job
   * @param {any} q
   */
  query(job, q) {
    q = q || {};
    let rows = this.recordsOf(job);
    if (q.type && q.type !== 'all') rows = rows.filter(r => r.record_type === q.type);
    if (q.search) {
      const needle = String(q.search).toLowerCase();
      rows = rows.filter(r => ['title', 'body', 'selftext', 'full_text', 'author', 'subreddit', 'flair', 'name'].some(k => typeof r[k] === 'string' && r[k].toLowerCase().includes(needle)));
    }
    const total = rows.length;
    const offset = Math.max(0, Number(q.offset) || 0);
    const limit = Math.max(1, Math.min(10000, Number(q.limit) || 500));
    return { total, offset, limit, records: rows.slice(offset, offset + limit) };
  }

  /**
   * A finished or running job's collection summary (from its records).
   * @param {Job} job
   */
  collectionSummary(job) {
    const recs = this.recordsOf(job);
    /** @type {Record<string, number>} */
    const byType = {};
    /** @type {Record<string, number>} */
    const subs = {};
    let first = Infinity, last = -Infinity;
    for (const r of recs) {
      byType[r.record_type || 'other'] = (byType[r.record_type || 'other'] || 0) + 1;
      if (typeof r.subreddit === 'string') subs[r.subreddit] = (subs[r.subreddit] || 0) + 1;
      const t = Number(r.created_utc);
      if (Number.isFinite(t) && t > 0) { first = Math.min(first, t); last = Math.max(last, t); }
    }
    const topSubs = Object.entries(subs).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    return {
      status: job.status, items: recs.length, byType, subreddits: topSubs,
      oldestItemAt: Number.isFinite(first) ? new Date(first * 1000).toISOString() : null,
      newestItemAt: Number.isFinite(last) ? new Date(last * 1000).toISOString() : null,
      duplicatesSkipped: job.progress.duplicates,
      requests: { total: job.progress.requests, ok: job.progress.requestsOk, failed: job.progress.requestsFailed, retries: job.progress.retries },
      pages: job.progress.pagesFetched, runs: job.attempts, waits: job.waits,
      checkpoint: job.checkpoint ? { at: job.checkpoint.at, items: job.checkpoint.items, phase: job.checkpoint.state.phase } : null,
      lastCollectedAt: job.lastCollectedAt,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      error: job.error, lastError: job.lastError
    };
  }

  /**
   * @param {Job} job
   * @param {number} offset
   * @param {number} limit
   */
  events(job, offset, limit) {
    return this.store ? this.store.readEvents(job.id, offset, limit) : { total: 0, events: [] };
  }

  /** Queue health for administrators. */
  stats() {
    const all = this.list();
    /** @type {Record<string, number>} */
    const byStatus = {};
    all.forEach(j => { byStatus[j.status] = (byStatus[j.status] || 0) + 1; });
    const oldestQueued = this.queue.reduce((t, j) => Math.min(t, Date.parse(j.updatedAt)), Infinity);
    const waiting = all.filter(j => j.status === 'waiting');
    return {
      byStatus,
      queueDepth: this.queue.length,
      running: this.running,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      maxQueuedJobs: this.config.maxQueuedJobs || null,
      oldestQueuedSeconds: Number.isFinite(oldestQueued) ? Math.round((this.now() - oldestQueued) / 1000) : null,
      nextRetryAt: waiting.map(j => j.retryAt).filter(Boolean).sort()[0] || null,
      persistent: !!this.store,
      diskBytes: this.store ? this.store.diskBytes() : null,
      maxDiskBytes: this.config.maxDiskBytes || null,
      since: this.iso(this.instanceStartedAt),
      counters: Object.assign({}, this.counters)
    };
  }

  // Server shutting down (pm2 reload): standard scrapes are left queued so
  // they continue from their checkpoint after the restart; others end as
  // interrupted. Without a store, jobs are cancelled as before.
  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
      if (job.heartbeat) { clearInterval(job.heartbeat); job.heartbeat = null; }
      if (!this.store) {
        if (job.status === 'running') job.controller.abort(cancelledError());
        if (job.status === 'queued') this.cancel(job.id);
        continue;
      }
      if (job.status !== 'running') continue;
      job.stopReason = 'shutdown';
      if (job.resumable) {
        job.status = 'queued';
        job.progress.message = 'Stopped by a server restart; continues from its last checkpoint.';
      } else {
        job.status = 'failed';
        job.finishedAt = this.iso();
        job.error = { type: 'interrupted', message: 'The server restarted while this job was running. The ' + job.itemCount + ' item' + (job.itemCount === 1 ? '' : 's') + ' collected before that are kept; start the job again to collect more.' };
      }
      this.event(job, 'status', { from: 'running', to: job.status });
      this.persist(job, true);
      this.store.releaseLease(job.id);
      job.controller.abort(cancelledError());
    }
    if (this.store) this.store.close();
  }
}

module.exports = { JobManager, TRANSITIONS, FINISHED, ACTIVE };
