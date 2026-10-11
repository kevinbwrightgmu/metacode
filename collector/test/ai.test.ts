import { describe, expect, it, vi } from 'vitest';
import { fromServerRecord, mergeRecords } from '../src/lib/records';
import { accessOptions, cleanSettings, readOwnKeys, OWN_KEYS_STORAGE, type ServerInfo } from '../src/lib/settings';
import { jobRequest, outcomeOf, stateOf, watchJob, type ServerJob } from '../src/lib/ai-jobs';
import { AiJobSession, newJobRecord, type SessionStore } from '../src/lib/session';
import { describeJob } from '../src/lib/jobs';
import type { AiJobConfig, CommentRecord, JobRecord, PostRecord } from '../src/types';

const NOW = '2026-10-11T12:00:00.000Z';
const serverPost = (id: string, extra: Record<string, unknown> = {}) => ({
  record_type: 'post', post_id: id, fullname: 't3_' + id, title: 'Title ' + id, author: 'alice', subreddit: 'science',
  url: 'https://www.reddit.com/r/science/comments/' + id + '/x/', permalink: 'https://www.reddit.com/r/science/comments/' + id + '/x/',
  created_at: '2026-10-01T00:00:00.000Z', score: 12, num_comments: 3, selftext: 'Body ' + id, is_self: true, flair: null, over_18: false, media: null, ...extra
});
const serverComment = (id: string, postId: string, parent: string) => ({
  record_type: 'comment', comment_id: id, post_id: postId, parent_id: parent, author: 'bob', subreddit: 'science', body: 'Reply ' + id,
  score: 2, created_at: '2026-10-02T00:00:00.000Z', permalink: 'https://www.reddit.com/r/science/comments/' + postId + '/x/' + id + '/', depth: parent.startsWith('t1_') ? 1 : 0
});
const config: AiJobConfig = { goal: 'Posts about heat pumps', maxPosts: 10, commentsPerPost: 2, maxSteps: 20, maxMinutes: 10, access: 'server', model: '' };

describe('records from the server', () => {
  it('a text post, a link post and an image post', () => {
    const p = fromServerRecord(serverPost('abc'), 'j1', NOW) as PostRecord;
    expect(p).toMatchObject({ record_type: 'post', id: 'abc', fullname: 't3_abc', title: 'Title abc', body: 'Body abc', post_type: 'text', link_url: null,
      url: 'https://www.reddit.com/r/science/comments/abc/x/', score: 12, num_comments: 3, counts_approximate: false, details_collected: true, job_ids: ['j1'],
      first_collected_at: NOW, collected_at: NOW });
    const link = fromServerRecord(serverPost('lnk', { is_self: false, url: 'https://example.com/a', selftext: null }), 'j1', NOW) as PostRecord;
    expect([link.post_type, link.link_url, link.body]).toEqual(['link', 'https://example.com/a', null]);
    expect((fromServerRecord(serverPost('img', { is_self: false, media: { type: 'image' } }), 'j1', NOW) as PostRecord).post_type).toBe('image');
  });

  it('comments know their parent comment; unsafe or unreadable values are dropped', () => {
    const top = fromServerRecord(serverComment('c1', 'abc', 't3_abc'), 'j1', NOW) as CommentRecord;
    const reply = fromServerRecord(serverComment('c2', 'abc', 't1_c1'), 'j1', NOW) as CommentRecord;
    expect([top.parent_comment_id, reply.parent_comment_id, reply.depth, reply.post_id]).toEqual([null, 'c1', 1, 'abc']);
    const bad = fromServerRecord(serverPost('xyz', { permalink: 'javascript:alert(1)' }), 'j1', NOW) as PostRecord;
    expect(bad.url).toBe('https://www.reddit.com/comments/xyz/');
    expect(fromServerRecord({ record_type: 'post', post_id: '../x' }, 'j1', NOW)).toBeNull();
    expect(fromServerRecord({ record_type: 'subreddit', name: 'x' }, 'j1', NOW)).toBeNull();
  });

  it('a post kept by two jobs is one record with both job ids', () => {
    const a = fromServerRecord(serverPost('abc', { score: 5 }), 'j1', '2026-10-01T00:00:00.000Z') as PostRecord;
    const b = fromServerRecord(serverPost('abc', { score: 9 }), 'j2', NOW) as PostRecord;
    expect(mergeRecords(a, b)).toMatchObject({ score: 9, job_ids: ['j1', 'j2'], first_collected_at: '2026-10-01T00:00:00.000Z', collected_at: NOW });
  });
});

describe('settings and your own keys', () => {
  it('settings are clamped, and settings of the earlier bot are dropped', () => {
    const s = cleanSettings({ defaultMaxPosts: 5000, defaultMaxSteps: 1, exportFormat: 'csv', pageDelayMs: 3000 } as never);
    expect(s).toEqual({ retentionDays: 0, defaultMaxPosts: 300, defaultCommentsPerPost: 0, defaultMaxSteps: 5, defaultMaxMinutes: 10, exportFormat: 'csv', csvBom: true });
  });

  it('reads the keys the Reddit Scraper page keeps in this browser', () => {
    const store = (v: unknown) => ({ getItem: (k: string) => (k === OWN_KEYS_STORAGE ? JSON.stringify(v) : null) });
    expect(readOwnKeys(store({ reddit: { clientId: 'id', clientSecret: 'sec', username: 'me', hint: '…t-id' }, redditapis: { key: 'rk', hint: '…rk' } })))
      .toEqual({ reddit: { clientId: 'id', clientSecret: 'sec', username: 'me', hint: '…t-id' }, redditapis: { key: 'rk', hint: '…rk' } });
    expect(readOwnKeys(store({ reddit: { clientId: 'id' } }))).toEqual({ reddit: null, redditapis: null });
    expect(readOwnKeys({ getItem: () => '{broken' })).toEqual({ reddit: null, redditapis: null });
    expect(readOwnKeys(null)).toEqual({ reddit: null, redditapis: null });
  });

  it('offers the ways to reach Reddit, best first', () => {
    const server: ServerInfo = { problem: null, serverMode: 'public', serverRedditApis: false };
    const none = { reddit: null, redditapis: null };
    expect(accessOptions(none, server).map(a => a.value)).toEqual(['server']);
    expect(accessOptions(none, server)[0].note).toMatch(/blocked by network security/);
    const mine = { reddit: { clientId: 'i', clientSecret: 's', username: null, hint: '…abcd' }, redditapis: null };
    const opts = accessOptions(mine, { ...server, serverMode: 'oauth', serverRedditApis: true });
    expect(opts.map(a => a.value)).toEqual(['own', 'redditapis', 'server']);
    expect(opts[0].label).toBe('Your Reddit API keys (…abcd)');
    expect(opts[1].label).toMatch(/the server's key/);
    expect(opts[2].label).toBe('This MetaCode server\'s Reddit API keys');
  });
});

describe('AI jobs', () => {
  const keys = { reddit: { clientId: 'cid', clientSecret: 'csec', username: 'me', hint: '' }, redditapis: { key: 'rkey', hint: '' } };

  it('the request carries the goal, the limits and only the keys the chosen access needs', () => {
    expect(jobRequest({ ...config, access: 'own', model: 'm1' }, keys)).toEqual({
      mode: 'ai', goal: 'Posts about heat pumps', engine: 'server',
      ai: { maxPosts: 10, commentsPerPost: 2, maxSteps: 20, maxMinutes: 10, model: 'm1' },
      credentials: { clientId: 'cid', clientSecret: 'csec', username: 'me' }
    });
    expect(jobRequest({ ...config, access: 'redditapis' }, keys)).toMatchObject({ engine: 'redditapis', redditApisKey: 'rkey' });
    expect(jobRequest(config, keys)).not.toHaveProperty('credentials');
    expect(() => jobRequest({ ...config, access: 'own' }, { reddit: null, redditapis: null })).toThrow(/aren't in this browser any more/);
  });

  it('server states and outcomes in words', () => {
    const job = (status: ServerJob['status'], ai: Record<string, unknown> = {}, error: ServerJob['error'] = null) =>
      ({ status, meta: { ai }, error } as unknown as ServerJob);
    expect(['queued', 'running', 'completed', 'failed', 'cancelled'].map(s => stateOf({ status: s as ServerJob['status'] }))).toEqual(['running', 'running', 'completed', 'failed', 'stopped']);
    expect(outcomeOf(job('completed', { reason: 'limit', kept: 10 }), config)).toBe('Reached the limit of 10 posts.');
    expect(outcomeOf(job('completed', { reason: 'steps', kept: 1 }), config)).toBe('Used all 20 steps (1 post kept).');
    expect(outcomeOf(job('completed', { reason: 'finished', kept: 0 }), config)).toBe('The AI finished without finding posts that fit.');
    expect(outcomeOf(job('failed', {}, { type: 'reddit_blocked', message: 'Reddit is blocking this server.' }), config)).toBe('Reddit is blocking this server.');
    expect(outcomeOf(job('cancelled'), config)).toMatch(/^Stopped/);
    expect(describeJob(config)).toBe('Posts about heat pumps');
    expect(describeJob({ subreddits: ['a', 'b'] })).toBe('r/a, r/b');
  });
});

// ── Following a job ───────────────────────────────────────────────────────────
class FakeES {
  static last: FakeES;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  readyState = 1;
  onerror: ((e: Event) => void) | null = null;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) { this.listeners.set(type, (this.listeners.get(type) || []).concat(fn)); }
  close() { this.readyState = 2; }
  emit(type: string, data: unknown) { (this.listeners.get(type) || []).forEach(fn => fn({ data: JSON.stringify(data) } as MessageEvent)); }
}

const serverJob = (patch: Partial<ServerJob> = {}): ServerJob => ({
  id: 'job1', mode: 'ai', status: 'running', label: 'AI: x', createdAt: NOW, startedAt: NOW, finishedAt: null,
  progress: { itemsFound: 0, pagesFetched: 0, errors: 0 }, itemCount: 0, error: null, meta: { ai: { steps: [], kept: 0, aiCalls: 0 } }, ...patch
});

/** A stand-in for the MetaCode server's job API. */
function fakeServer(records: unknown[]) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push((init && init.method || 'GET') + ' ' + url);
    const u = new URL(url, 'http://x');
    if (u.pathname.endsWith('/results')) {
      const offset = Number(u.searchParams.get('offset'));
      return { ok: true, status: 200, json: async () => ({ total: records.length, records: records.slice(offset, offset + 2) }) } as Response;
    }
    if (u.pathname.endsWith('/cancel')) return { ok: true, status: 200, json: async () => ({}) } as Response;
    return { ok: false, status: 404, json: async () => ({ error: { message: 'That scraper job doesn\'t exist (it may have expired or the server restarted).' } }) } as Response;
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function memoryStore() {
  const posts = new Map<string, PostRecord>(), comments = new Map<string, CommentRecord>(), jobs: JobRecord[] = [];
  const store: SessionStore = {
    async upsertPosts(r) { r.forEach(x => posts.set(x.id, posts.has(x.id) ? mergeRecords(posts.get(x.id)!, x) : x)); },
    async upsertComments(r) { r.forEach(x => comments.set(x.id, x)); },
    async saveJob(j) { jobs.push(j); }
  };
  return { store, posts, comments, jobs };
}

describe('following an AI job', () => {
  it('live events update the job; records are copied in order, each once; the finished job is saved with its outcome', async () => {
    const records = [serverPost('p1'), serverComment('c1', 'p1', 't3_p1'), serverPost('p2'), serverComment('c2', 'p2', 't3_p2'), serverPost('p1')];
    const { fetchFn, calls } = fakeServer(records);
    const mem = memoryStore();
    const session = new AiJobSession(mem.store, newJobRecord(serverJob(), config, NOW), { fetch: fetchFn, EventSource: FakeES as never, now: () => NOW });
    const seen: string[] = [];
    session.subscribe(s => seen.push(s.record.state));
    session.watch();
    const es = FakeES.last;
    expect(es.url).toBe('/api/scraper/jobs/job1/events');

    es.emit('snapshot', { job: { ...serverJob(), logs: [{ ts: NOW, level: 'info', message: 'Goal: x' }] } });
    es.emit('meta', { ai: { steps: [{ step: 1, tool: 'search_posts', args: '"heat pump"', thought: 'search first', result: null, error: false }], kept: 0, aiCalls: 1 } });
    expect(session.record.steps.map(s => s.tool)).toEqual(['search_posts']);
    expect(session.logs.map(l => l.message)).toEqual(['Goal: x']);
    es.emit('records', { added: 4, total: 4 });
    await session.settled();
    expect([...mem.posts.keys()]).toEqual(['p1', 'p2']);
    expect([...mem.comments.keys()]).toEqual(['c1', 'c2']);
    expect(session.record.synced).toBe(4);

    es.emit('status', { ...serverJob(), status: 'completed', finishedAt: NOW, itemCount: 5, meta: { ai: { steps: [], kept: 2, aiCalls: 3, reason: 'finished', summary: 'Two posts.' } } });
    await session.settled();
    expect(session.record).toMatchObject({ state: 'completed', outcome: 'The AI finished: 2 posts kept.', summary: 'Two posts.', synced: 5, finishedAt: NOW });
    expect(session.record.stats).toMatchObject({ postsCollected: 3, commentsCollected: 2, aiCalls: 3 });
    expect(mem.posts.size).toBe(2);
    expect(es.readyState).toBe(2);
    expect(mem.jobs[mem.jobs.length - 1].state).toBe('completed');
    expect(calls.filter(c => c.includes('/results')).map(c => new URL(c.split(' ')[1], 'http://x').searchParams.get('offset'))).toEqual(['0', '2', '4']);
    expect(seen).toContain('completed');
  });

  it('without live events it polls; a job the server no longer has ends as stopped', async () => {
    const { fetchFn } = fakeServer([]);
    const mem = memoryStore();
    const session = new AiJobSession(mem.store, newJobRecord(serverJob(), config, NOW), { fetch: fetchFn, EventSource: null, now: () => NOW, pollMs: 5 });
    const done = new Promise<void>(resolve => session.subscribe(s => { if (s.record.state === 'stopped') resolve(); }));
    session.watch();
    await done;
    expect(session.record.outcome).toMatch(/no longer has this job/);
  });

  it('Stop asks the server to cancel the job', async () => {
    const { fetchFn, calls } = fakeServer([]);
    const session = new AiJobSession(memoryStore().store, newJobRecord(serverJob(), config, NOW), { fetch: fetchFn, EventSource: FakeES as never });
    session.watch();
    await session.stop();
    expect(session.record.state).toBe('stopping');
    expect(calls).toContain('POST /api/scraper/jobs/job1/cancel');
    session.detach();
  });

  it('a stream that ends early falls back to polling', async () => {
    let polled = 0;
    const fetchFn = (async () => { polled++; return { ok: true, status: 200, json: async () => ({ job: serverJob({ status: 'completed', itemCount: 0 }) }) } as Response; }) as unknown as typeof fetch;
    const finished = new Promise<void>(resolve => watchJob('job1', { update() {}, log() {}, records() {}, lost() {}, finished: () => resolve() },
      { EventSource: FakeES as never, fetch: fetchFn, pollMs: 5 }));
    FakeES.last.readyState = 2;
    FakeES.last.onerror!(new Event('error'));
    await finished;
    expect(polled).toBe(1);
  });
});
