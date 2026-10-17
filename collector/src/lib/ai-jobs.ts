// ── AI jobs on the MetaCode server ────────────────────────────────────────────
// The AI Scraper's jobs run on the MetaCode server: an AI agent
// (python/ai_scraper.py) plans searches and picks posts, and the server makes
// the Reddit requests. This page starts a job, follows it live (server-sent
// events, or polling where those aren't available) and copies the records the
// job keeps into this browser.

import type { AiJobConfig, AiStep, JobState, JobStats, LogEntry, LogLevel } from '../types';
import type { OwnKeys } from './settings';
import type { ServerRecord } from './records';

const API = '/api/scraper';
const FINISHED = new Set(['completed', 'failed', 'cancelled']);

export interface ServerJob {
  id: string;
  mode: string;
  status: 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';
  label: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { itemsFound?: number; pagesFetched?: number; errors?: number; message?: string };
  itemCount: number;
  error: { type: string; message: string } | null;
  meta: { ai?: { steps?: AiStep[]; kept?: number; aiCalls?: number; summary?: string | null; reason?: string | null } } | null;
  logs?: { ts: string; level: string; message: string }[];
}

async function call<T>(fetchFn: typeof fetch, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchFn(API + path, {
    credentials: 'same-origin', ...init,
    headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) }
  });
  let j: { error?: { message?: string } } | null = null;
  try { j = await res.json(); } catch { j = null; }
  if (!res.ok) throw new Error((j && j.error && j.error.message) || 'The MetaCode server answered HTTP ' + res.status + '.');
  return j as T;
}

/** The request that starts a job. Your own keys go with it (the server uses them for this job only). */
export function jobRequest(config: AiJobConfig, keys: OwnKeys): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mode: 'ai', goal: config.goal, engine: config.access === 'redditapis' ? 'redditapis' : 'server',
    ai: { maxPosts: config.maxPosts, commentsPerPost: config.commentsPerPost, maxSteps: config.maxSteps, maxMinutes: config.maxMinutes, model: config.model }
  };
  if (config.access === 'own') {
    if (!keys.reddit) throw new Error('Your Reddit API keys aren\'t in this browser any more. Add them on MetaCode\'s Reddit Scraper page (Reddit API access), or choose another way to reach Reddit.');
    body.credentials = { clientId: keys.reddit.clientId, clientSecret: keys.reddit.clientSecret, username: keys.reddit.username || '' };
  }
  if (config.access === 'redditapis' && keys.redditapis) body.redditApisKey = keys.redditapis.key;
  return body;
}

export async function startAiJob(body: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<ServerJob> {
  return (await call<{ job: ServerJob }>(fetchFn, '/jobs', { method: 'POST', body: JSON.stringify(body) })).job;
}
export async function getJob(id: string, fetchFn: typeof fetch = fetch): Promise<ServerJob> {
  return (await call<{ job: ServerJob }>(fetchFn, '/jobs/' + encodeURIComponent(id))).job;
}
export async function cancelJob(id: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await call(fetchFn, '/jobs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: '{}' });
}
/** The job's records from `offset` on (the server keeps them in the order the AI kept them). */
export async function fetchRecords(id: string, offset: number, fetchFn: typeof fetch = fetch): Promise<{ total: number; records: ServerRecord[] }> {
  const r = await call<{ total: number; records: ServerRecord[] }>(fetchFn, '/jobs/' + encodeURIComponent(id) + '/results?type=all&limit=1000&offset=' + Math.max(0, offset));
  return { total: Number(r.total) || 0, records: Array.isArray(r.records) ? r.records : [] };
}

export const isFinished = (job: Pick<ServerJob, 'status'>) => FINISHED.has(job.status);

/** The server's job status → this page's job state. */
export function stateOf(job: Pick<ServerJob, 'status'>): JobState {
  // (AI jobs can't pause; "paused" and "waiting" only happen to standard scrapes, mapped here for completeness)
  return job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'stopped' : job.status === 'paused' ? 'paused' : 'running';
}

/** Why a finished job ended, in words. */
export function outcomeOf(job: ServerJob, config: Pick<AiJobConfig, 'maxPosts' | 'maxSteps' | 'maxMinutes'>): string | null {
  if (job.status === 'failed') return job.error ? job.error.message : 'The job failed.';
  if (job.status === 'cancelled') return 'Stopped. The posts kept before that are saved.';
  if (job.status !== 'completed') return null;
  const ai = (job.meta && job.meta.ai) || {};
  const kept = ai.kept || 0;
  switch (ai.reason) {
    case 'limit': return 'Reached the limit of ' + config.maxPosts + ' posts.';
    case 'steps': return 'Used all ' + config.maxSteps + ' steps (' + kept + ' post' + (kept === 1 ? '' : 's') + ' kept).';
    case 'time': return 'Reached the time limit of ' + config.maxMinutes + ' min (' + kept + ' post' + (kept === 1 ? '' : 's') + ' kept).';
    default: return kept ? 'The AI finished: ' + kept + ' post' + (kept === 1 ? '' : 's') + ' kept.' : 'The AI finished without finding posts that fit.';
  }
}

export function statsOf(job: ServerJob, counted: { posts: number; comments: number }): JobStats {
  const ai = (job.meta && job.meta.ai) || {};
  return {
    postsCollected: counted.posts, commentsCollected: counted.comments,
    steps: Array.isArray(ai.steps) ? ai.steps.length : 0, aiCalls: ai.aiCalls || 0,
    requests: (job.progress && job.progress.pagesFetched) || 0, errors: (job.progress && job.progress.errors) || 0
  };
}

export function logEntry(e: { ts?: string; at?: string; level?: string; message?: string }): LogEntry {
  const level: LogLevel = e.level === 'warn' || e.level === 'error' ? e.level : 'info';
  return { at: e.ts || e.at || new Date().toISOString(), level, message: String(e.message || '') };
}

export interface WatchHandlers {
  update(job: ServerJob): void;
  log(entry: LogEntry): void;
  /** The job now has `total` records on the server. */
  records(total: number): void;
  finished(job: ServerJob): void;
  /** The server doesn't have the job any more (restarted, or it expired). */
  lost(message: string): void;
}

export interface EventSourceLike {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  close(): void;
  readyState: number;
  onerror: ((e: Event) => void) | null;
}

export type EventSourceCtor = new (url: string) => EventSourceLike;

/** Follows a job until it finishes. → a function that stops watching. */
export function watchJob(id: string, on: WatchHandlers, opts?: { EventSource?: EventSourceCtor | null; fetch?: typeof fetch; pollMs?: number }): () => void {
  const ES = opts && opts.EventSource !== undefined ? opts.EventSource : (typeof EventSource === 'undefined' ? null : EventSource as unknown as EventSourceCtor);
  const fetchFn = (opts && opts.fetch) || fetch;
  let job: ServerJob | null = null;
  let stopped = false, es: EventSourceLike | null = null, timer: ReturnType<typeof setTimeout> | null = null, lastTotal = -1;

  const stop = () => { stopped = true; if (es) es.close(); if (timer) clearTimeout(timer); };
  const finish = (j: ServerJob) => { if (stopped) return; on.records(j.itemCount); on.update(j); stop(); on.finished(j); };
  const seen = (j: ServerJob) => {
    job = j;
    if (j.itemCount !== lastTotal) { lastTotal = j.itemCount; on.records(j.itemCount); }
    on.update(j);
  };

  async function poll() {
    if (stopped) return;
    try {
      const j = await getJob(id, fetchFn);
      if (stopped) return;
      if (isFinished(j)) return finish(j);
      seen(j);
    } catch (err) {
      if (stopped) return;
      if (/doesn't exist/.test((err as Error).message)) { stop(); return on.lost('The MetaCode server no longer has this job (it restarted, or the job expired). The posts copied so far are kept.'); }
    }
    timer = setTimeout(poll, (opts && opts.pollMs) || 2000);
  }

  if (!ES) { void poll(); return stop; }
  es = new ES(API + '/jobs/' + encodeURIComponent(id) + '/events');
  const data = (e: MessageEvent) => { try { return JSON.parse(String(e.data)); } catch { return null; } };
  es.addEventListener('snapshot', e => {
    const d = data(e);
    if (!d || !d.job) return;
    (d.job.logs || []).forEach((l: { ts: string; level: string; message: string }) => on.log(logEntry(l)));
    if (isFinished(d.job)) finish(d.job); else seen(d.job);
  });
  es.addEventListener('progress', e => { const d = data(e); if (job && d) seen({ ...job, progress: d, itemCount: Number(d.itemsFound) || job.itemCount }); });
  es.addEventListener('meta', e => { const d = data(e); if (job && d) seen({ ...job, meta: d }); });
  es.addEventListener('records', e => { const d = data(e); if (job && d) seen({ ...job, itemCount: Number(d.total) || job.itemCount }); });
  es.addEventListener('log', e => { const d = data(e); if (d) on.log(logEntry(d)); });
  es.addEventListener('status', e => {
    const d = data(e);
    if (!d) return;
    const j: ServerJob = { ...(job || d), ...d };
    if (isFinished(j)) finish(j); else seen(j);
  });
  es.addEventListener('removed', () => { stop(); on.lost('The job was removed from the MetaCode server. The posts copied so far are kept.'); });
  es.onerror = () => {
    // The stream ended without the job finishing (proxy timeout, server restart): fall back to polling
    if (!stopped && es && es.readyState === 2) { es = null; void poll(); }
  };
  return stop;
}
