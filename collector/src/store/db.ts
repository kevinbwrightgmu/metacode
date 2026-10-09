// ── Local storage (IndexedDB) ─────────────────────────────────────────────────
// Posts, comments, jobs and collection errors live in this browser's
// IndexedDB — nothing is sent to a server. Reddit ids are the keys, so a post
// seen twice is one record (merged, see mergeRecords). All operations are
// asynchronous; long scans use cursors so large collections aren't loaded
// into memory at once. Works in the page and in Web Workers.
//
// Never stored: passwords, cookies, tokens or any other credentials.

import type { CollectionError, CommentRecord, JobRecord, PostRecord, Settings } from '../types';
import { mergeRecords } from '../extract/normalize';
import type { BotStore } from '../bot/bot';

export const DB_NAME = 'metacode-reddit-collector';
const DB_VERSION = 1;
type StoreName = 'posts' | 'comments' | 'jobs' | 'errors' | 'settings';

export type RecordKind = 'post' | 'comment';
export type RecordSort = 'collected_desc' | 'created_desc' | 'created_asc' | 'score_desc' | 'subreddit_asc';

export interface RecordFilter {
  type: RecordKind;
  /** Matches title, body, subreddit and author (case-insensitive). */
  text: string;
  subreddit: string;
  jobId: string;
  /** Collection date bounds, YYYY-MM-DD (inclusive). */
  collectedFrom: string;
  collectedTo: string;
}

export const EMPTY_FILTER: RecordFilter = { type: 'post', text: '', subreddit: '', jobId: '', collectedFrom: '', collectedTo: '' };

export interface Counts { posts: number; comments: number; jobs: number; errors: number }

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

export function matchesFilter(r: PostRecord | CommentRecord, f: Partial<RecordFilter>): boolean {
  if (f.subreddit && (r.subreddit || '').toLowerCase() !== f.subreddit.toLowerCase().replace(/^r\//, '')) return false;
  if (f.jobId && !r.job_ids.includes(f.jobId)) return false;
  const day = r.collected_at.slice(0, 10);
  if (f.collectedFrom && day < f.collectedFrom) return false;
  if (f.collectedTo && day > f.collectedTo) return false;
  if (f.text) {
    const needle = f.text.toLowerCase();
    const hay = [r.record_type === 'post' ? r.title : null, r.body, r.subreddit, r.author].filter(Boolean).join('\n').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sortKey(r: PostRecord | CommentRecord, sort: RecordSort): string | number {
  switch (sort) {
    case 'created_desc':
    case 'created_asc': return r.created_at || '';
    case 'score_desc': return r.score === null ? -Infinity : r.score;
    case 'subreddit_asc': return (r.subreddit || '￿').toLowerCase();
    default: return r.collected_at;
  }
}

export class CollectorStore implements BotStore {
  private constructor(private db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB): Promise<CollectorStore> {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('posts')) {
        const s = db.createObjectStore('posts', { keyPath: 'id' });
        s.createIndex('collected_at', 'collected_at');
        s.createIndex('subreddit', 'subreddit');
      }
      if (!db.objectStoreNames.contains('comments')) {
        const s = db.createObjectStore('comments', { keyPath: 'id' });
        s.createIndex('post_id', 'post_id');
        s.createIndex('collected_at', 'collected_at');
      }
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
      if (!db.objectStoreNames.contains('errors')) db.createObjectStore('errors', { keyPath: 'id', autoIncrement: true }).createIndex('jobId', 'jobId');
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error || new Error('This browser\'s IndexedDB storage couldn\'t be opened.'));
      open.onblocked = () => reject(new Error('The collector\'s storage is being upgraded in another tab; close other collector tabs and reload.'));
    });
    db.onversionchange = () => db.close();
    return new CollectorStore(db);
  }

  close(): void { this.db.close(); }

  private tx(stores: StoreName | StoreName[], mode: IDBTransactionMode = 'readonly'): IDBTransaction {
    return this.db.transaction(stores, mode);
  }

  // ── Records ─────────────────────────────────────────────────────────────
  private async upsert<T extends PostRecord | CommentRecord>(storeName: 'posts' | 'comments', records: T[]): Promise<{ added: number; updated: number }> {
    if (!records.length) return { added: 0, updated: 0 };
    const tx = this.tx(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    let added = 0, updated = 0;
    // Same id twice in one batch: merge them first
    const byId = new Map<string, T>();
    for (const r of records) byId.set(r.id, byId.has(r.id) ? mergeRecords(byId.get(r.id)!, r) : r);
    await Promise.all(Array.from(byId.values()).map(async r => {
      const existing = await req(store.get(r.id)) as T | undefined;
      if (existing) { updated++; store.put(mergeRecords(existing, r)); } else { added++; store.put(r); }
    }));
    await done(tx);
    return { added, updated };
  }
  async upsertPosts(records: PostRecord[]): Promise<void> { await this.upsert('posts', records); }
  async upsertComments(records: CommentRecord[]): Promise<void> { await this.upsert('comments', records); }
  upsertPostsCounted(records: PostRecord[]) { return this.upsert('posts', records); }
  upsertCommentsCounted(records: CommentRecord[]) { return this.upsert('comments', records); }

  async getPost(id: string): Promise<PostRecord | undefined> {
    return req(this.tx('posts').objectStore('posts').get(id)) as Promise<PostRecord | undefined>;
  }
  async getComment(id: string): Promise<CommentRecord | undefined> {
    return req(this.tx('comments').objectStore('comments').get(id)) as Promise<CommentRecord | undefined>;
  }
  async commentsForPost(postId: string): Promise<CommentRecord[]> {
    const rows = await req(this.tx('comments').objectStore('comments').index('post_id').getAll(postId)) as CommentRecord[];
    return orderThread(rows);
  }

  /**
   * Walks every record of one kind with a cursor, calling `fn` for each match.
   * Nothing but the current record is held in memory.
   */
  async each(kind: RecordKind, filter: Partial<RecordFilter>, fn: (r: PostRecord | CommentRecord) => void): Promise<number> {
    const storeName = kind === 'post' ? 'posts' : 'comments';
    const tx = this.tx(storeName);
    const cursorReq = tx.objectStore(storeName).openCursor();
    let n = 0;
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c) return resolve();
        const r = c.value as PostRecord | CommentRecord;
        if (matchesFilter(r, filter)) { n++; fn(r); }
        c.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    return n;
  }

  /** A sorted page of matching records, plus how many match in total. */
  async query(filter: RecordFilter, sort: RecordSort, offset: number, limit: number): Promise<{ total: number; rows: (PostRecord | CommentRecord)[] }> {
    const keys: [string | number, string][] = [];
    await this.each(filter.type, filter, r => { keys.push([sortKey(r, sort), r.id]); });
    const dir = sort === 'created_asc' || sort === 'subreddit_asc' ? 1 : -1;
    keys.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) * dir || (a[1] < b[1] ? -1 : 1));
    const ids = keys.slice(offset, offset + limit).map(k => k[1]);
    const storeName = filter.type === 'post' ? 'posts' : 'comments';
    const store = this.tx(storeName).objectStore(storeName);
    const rows = await Promise.all(ids.map(id => req(store.get(id)))) as (PostRecord | CommentRecord)[];
    return { total: keys.length, rows: rows.filter(Boolean) };
  }

  async deleteRecords(kind: RecordKind, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const stores: StoreName[] = kind === 'post' ? ['posts', 'comments'] : ['comments'];
    const tx = this.tx(stores, 'readwrite');
    if (kind === 'post') {
      const comments = tx.objectStore('comments');
      for (const id of ids) {
        tx.objectStore('posts').delete(id);
        // A post's comments go with it
        const keys = await req(comments.index('post_id').getAllKeys(id));
        keys.forEach(k => comments.delete(k));
      }
    } else {
      ids.forEach(id => tx.objectStore('comments').delete(id));
    }
    await done(tx);
    return ids.length;
  }

  /** Deletes every record not seen since `days` days ago. → how many of each were removed. */
  async applyRetention(days: number, now = Date.now()): Promise<{ posts: number; comments: number }> {
    if (!days || days <= 0) return { posts: 0, comments: 0 };
    const cutoff = new Date(now - days * 86400000).toISOString();
    const out = { posts: 0, comments: 0 };
    for (const [storeName, key] of [['posts', 'posts'], ['comments', 'comments']] as const) {
      const tx = this.tx(storeName, 'readwrite');
      const range = IDBKeyRange.upperBound(cutoff, true);
      const cursorReq = tx.objectStore(storeName).index('collected_at').openCursor(range);
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const c = cursorReq.result;
          if (!c) return resolve();
          c.delete();
          out[key]++;
          c.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      await done(tx);
    }
    return out;
  }

  /** Removes all collected data, jobs and errors (settings are kept). */
  async clearAll(): Promise<void> {
    const tx = this.tx(['posts', 'comments', 'jobs', 'errors'], 'readwrite');
    (['posts', 'comments', 'jobs', 'errors'] as const).forEach(s => tx.objectStore(s).clear());
    await done(tx);
  }

  async counts(): Promise<Counts> {
    const tx = this.tx(['posts', 'comments', 'jobs', 'errors']);
    const [posts, comments, jobs, errors] = await Promise.all((['posts', 'comments', 'jobs', 'errors'] as const).map(s => req(tx.objectStore(s).count())));
    return { posts, comments, jobs, errors };
  }

  async subreddits(): Promise<string[]> {
    const names = new Set<string>();
    await this.each('post', {}, r => { if (r.subreddit) names.add(r.subreddit); });
    await this.each('comment', {}, r => { if (r.subreddit) names.add(r.subreddit); });
    return Array.from(names).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  // ── Jobs and errors ─────────────────────────────────────────────────────
  async saveJob(job: JobRecord): Promise<void> {
    const tx = this.tx('jobs', 'readwrite');
    tx.objectStore('jobs').put(job);
    await done(tx);
  }
  async listJobs(): Promise<JobRecord[]> {
    const jobs = await req(this.tx('jobs').objectStore('jobs').getAll()) as JobRecord[];
    return jobs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }
  async addError(error: Omit<CollectionError, 'id'>): Promise<void> {
    const tx = this.tx('errors', 'readwrite');
    tx.objectStore('errors').add(error);
    await done(tx);
  }
  async listErrors(jobId?: string, limit = 200): Promise<CollectionError[]> {
    const store = this.tx('errors').objectStore('errors');
    const rows = await req(jobId ? store.index('jobId').getAll(jobId) : store.getAll()) as CollectionError[];
    return rows.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
  }

  /** Jobs still marked as running when the page was closed: finish them as stopped. */
  async closeInterruptedJobs(): Promise<number> {
    const jobs = await this.listJobs();
    const open = jobs.filter(j => j.state === 'running' || j.state === 'paused' || j.state === 'stopping');
    for (const j of open) await this.saveJob({ ...j, state: 'stopped', outcome: 'Interrupted: the collector page was closed or reloaded while this job ran. Records saved before that are kept.', finishedAt: j.finishedAt || new Date().toISOString() });
    return open.length;
  }

  // ── Settings ────────────────────────────────────────────────────────────
  async loadSettings(): Promise<Partial<Settings> | null> {
    const row = await req(this.tx('settings').objectStore('settings').get('settings')) as { key: string; value: Partial<Settings> } | undefined;
    return row ? row.value : null;
  }
  async saveSettings(value: Settings): Promise<void> {
    const tx = this.tx('settings', 'readwrite');
    tx.objectStore('settings').put({ key: 'settings', value });
    await done(tx);
  }
}

/** Comments in reading order: each top-level comment followed by its replies. */
export function orderThread(rows: CommentRecord[]): CommentRecord[] {
  const children = new Map<string | null, CommentRecord[]>();
  const ids = new Set(rows.map(r => r.id));
  for (const r of rows) {
    const parent = r.parent_comment_id && ids.has(r.parent_comment_id) ? r.parent_comment_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(r);
  }
  for (const list of children.values()) list.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || (a.created_at || '').localeCompare(b.created_at || ''));
  const out: CommentRecord[] = [];
  const walk = (parent: string | null) => (children.get(parent) || []).forEach(c => { out.push(c); walk(c.id); });
  walk(null);
  return out;
}

/** Storage this site uses and may use (where the browser reports it). */
export async function storageEstimate(): Promise<{ usage: number | null; quota: number | null; persisted: boolean | null }> {
  const sm = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!sm || !sm.estimate) return { usage: null, quota: null, persisted: null };
  const e = await sm.estimate();
  const persisted = sm.persisted ? await sm.persisted() : null;
  return { usage: e.usage ?? null, quota: e.quota ?? null, persisted };
}
