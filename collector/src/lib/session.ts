// ── One AI job, followed from this page ───────────────────────────────────────
// Watches a job on the MetaCode server, copies the records it keeps into this
// browser (in order, each once), and keeps the job's local record up to date.
// A page reload picks the job up again where it left off (JobRecord.synced).

import type { AiJobConfig, CommentRecord, JobRecord, LogEntry, PostRecord } from '../types';
import { cancelJob, fetchRecords, outcomeOf, stateOf, statsOf, watchJob, type EventSourceCtor, type ServerJob, type WatchHandlers } from './ai-jobs';
import { fromServerRecord } from './records';

export interface SessionStore {
  upsertPosts(records: PostRecord[]): Promise<void>;
  upsertComments(records: CommentRecord[]): Promise<void>;
  saveJob(job: JobRecord): Promise<void>;
}

export function newJobRecord(job: ServerJob, config: AiJobConfig, now: string): JobRecord {
  return { id: job.id, config, state: 'running', outcome: null, summary: null, startedAt: job.createdAt || now, finishedAt: null,
    stats: { postsCollected: 0, commentsCollected: 0, steps: 0, aiCalls: 0, requests: 0, errors: 0 }, steps: [], synced: 0 };
}

export class AiJobSession {
  record: JobRecord;
  logs: LogEntry[] = [];
  private stopWatching: (() => void) | null = null;
  private syncing: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: AiJobSession) => void>();
  private last: ServerJob | null = null;

  constructor(private store: SessionStore, record: JobRecord,
    private deps: { fetch?: typeof fetch; EventSource?: EventSourceCtor | null; now?: () => string; pollMs?: number } = {}) {
    this.record = { ...record, steps: record.steps || [] };
  }

  get active(): boolean { return this.record.state === 'running' || this.record.state === 'stopping'; }

  subscribe(fn: (s: AiJobSession) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private changed() { this.listeners.forEach(fn => fn(this)); }
  private now() { return this.deps.now ? this.deps.now() : new Date().toISOString(); }

  /** Starts following the job (live events, or polling). */
  watch(): void {
    const handlers: WatchHandlers = {
      update: job => { this.last = job; this.apply(job); this.changed(); },
      log: entry => { this.logs = (this.logs.length > 500 ? this.logs.slice(-400) : this.logs).concat(entry); this.changed(); },
      records: total => { this.queueSync(total); },
      finished: job => {
        this.last = job;
        this.queueSync(job.itemCount);
        this.syncing = this.syncing.then(async () => {
          this.apply(job);
          this.record = { ...this.record, state: stateOf(job), outcome: outcomeOf(job, this.record.config), finishedAt: job.finishedAt || this.now() };
          await this.store.saveJob(this.record);
          this.changed();
        });
      },
      lost: message => {
        this.syncing = this.syncing.then(async () => {
          this.record = { ...this.record, state: 'stopped', outcome: message, finishedAt: this.now() };
          await this.store.saveJob(this.record);
          this.changed();
        });
      }
    };
    this.stopWatching = watchJob(this.record.id, handlers, { fetch: this.deps.fetch, EventSource: this.deps.EventSource, pollMs: this.deps.pollMs });
  }

  /** Asks the server to stop the job (records kept so far stay). */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.record = { ...this.record, state: 'stopping' };
    this.changed();
    await cancelJob(this.record.id, this.deps.fetch);
  }

  /** Stops following (e.g. the page goes away); the job itself keeps running on the server. */
  detach(): void { if (this.stopWatching) this.stopWatching(); }

  /** Resolves once everything queued so far has been copied. */
  settled(): Promise<void> { return this.syncing; }

  private apply(job: ServerJob) {
    const ai = (job.meta && job.meta.ai) || {};
    this.record = {
      ...this.record,
      steps: Array.isArray(ai.steps) ? ai.steps : this.record.steps,
      summary: ai.summary || this.record.summary,
      stats: statsOf(job, { posts: this.record.stats.postsCollected, comments: this.record.stats.commentsCollected })
    };
  }

  private queueSync(total: number) {
    this.syncing = this.syncing.then(() => this.sync(total)).catch(err => {
      this.logs = this.logs.concat({ at: this.now(), level: 'warn', message: 'Couldn\'t copy records yet: ' + (err as Error).message + ' (tried again on the next update).' });
      this.changed();
    });
  }

  private async sync(total: number) {
    while (this.record.synced < total) {
      const { records } = await fetchRecords(this.record.id, this.record.synced, this.deps.fetch);
      if (!records.length) break;
      const now = this.now();
      const posts: PostRecord[] = [], comments: CommentRecord[] = [];
      for (const r of records) {
        const c = fromServerRecord(r, this.record.id, now);
        if (c && c.record_type === 'post') posts.push(c); else if (c) comments.push(c);
      }
      await this.store.upsertPosts(posts);
      await this.store.upsertComments(comments);
      const stats = { ...this.record.stats, postsCollected: this.record.stats.postsCollected + posts.length, commentsCollected: this.record.stats.commentsCollected + comments.length };
      this.record = { ...this.record, synced: this.record.synced + records.length, stats };
      if (this.last) this.apply(this.last);
      await this.store.saveJob(this.record);
      this.changed();
    }
  }
}
