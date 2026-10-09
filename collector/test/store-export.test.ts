import { beforeEach, describe, expect, it } from 'vitest';
import { CollectorStore, DB_NAME, EMPTY_FILTER, orderThread } from '../src/store/db';
import { COMMENT_COLUMNS, ExportBuilder, POST_COLUMNS, csvCell } from '../src/export/format';
import { buildExport } from '../src/export/run';
import type { CommentRecord, JobRecord, PostRecord } from '../src/types';

function post(id: string, over: Partial<PostRecord> = {}): PostRecord {
  return {
    record_type: 'post', id, fullname: 't3_' + id, url: 'https://www.reddit.com/r/sci/comments/' + id + '/', subreddit: 'sci', title: 'Post ' + id,
    body: null, author: 'u_' + id, created_at: '2026-10-01T00:00:00.000Z', score: 1, num_comments: 0, counts_approximate: false,
    link_url: null, post_type: 'text', flair: null, over_18: null, details_collected: false, source_url: 'https://www.reddit.com/r/sci/',
    first_collected_at: '2026-10-02T00:00:00.000Z', collected_at: '2026-10-02T00:00:00.000Z', job_ids: ['j1'], ...over
  };
}
function comment(id: string, postId: string, parent: string | null, over: Partial<CommentRecord> = {}): CommentRecord {
  return {
    record_type: 'comment', id, fullname: 't1_' + id, post_id: postId, parent_comment_id: parent, subreddit: 'sci', author: 'a', body: 'text ' + id,
    created_at: null, score: 1, counts_approximate: false, depth: parent ? 1 : 0, url: null, source_url: 'https://www.reddit.com/r/sci/comments/' + postId + '/',
    first_collected_at: '2026-10-02T00:00:00.000Z', collected_at: '2026-10-02T00:00:00.000Z', job_ids: ['j1'], ...over
  };
}

let store: CollectorStore;
beforeEach(async () => {
  if (store) store.close();
  await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = () => resolve(); });
  store = await CollectorStore.open();
});

describe('IndexedDB store', () => {
  it('deduplicates by Reddit id and merges repeat sightings', async () => {
    expect(await store.upsertPostsCounted([post('a'), post('b'), post('a', { score: 5 })])).toEqual({ added: 2, updated: 0 });
    expect(await store.upsertPostsCounted([post('a', { score: 9, author: null, job_ids: ['j2'], collected_at: '2026-10-03T00:00:00.000Z' })])).toEqual({ added: 0, updated: 1 });
    const a = await store.getPost('a');
    expect(a).toMatchObject({ score: 9, author: 'u_a', job_ids: ['j1', 'j2'], collected_at: '2026-10-03T00:00:00.000Z' });
    expect((await store.counts()).posts).toBe(2);
  });

  it('search, filters, sorting and paging', async () => {
    await store.upsertPosts([
      post('a', { title: 'Climate news', score: 50, subreddit: 'science', created_at: '2026-09-01T00:00:00.000Z' }),
      post('b', { body: 'about CLIMATE', score: 5, subreddit: 'env', job_ids: ['j2'] }),
      post('c', { title: 'Other', score: null, collected_at: '2026-10-09T00:00:00.000Z' })
    ]);
    const q = (f: Partial<typeof EMPTY_FILTER>, sort = 'score_desc' as const) => store.query({ ...EMPTY_FILTER, ...f }, sort, 0, 10).then(r => r.rows.map(x => x.id));
    expect(await q({ text: 'climate' })).toEqual(['a', 'b']);
    expect(await q({ subreddit: 'r/ENV' })).toEqual(['b']);
    expect(await q({ jobId: 'j2' })).toEqual(['b']);
    expect(await q({ collectedFrom: '2026-10-05' })).toEqual(['c']);
    expect(await q({})).toEqual(['a', 'b', 'c']);           // a missing score sorts last
    expect(await q({}, 'created_asc' as never)).toEqual(['a', 'b', 'c'].sort((x, y) => (x === 'a' ? -1 : y === 'a' ? 1 : x < y ? -1 : 1)));
    const page = await store.query({ ...EMPTY_FILTER }, 'score_desc', 1, 1);
    expect([page.total, page.rows.map(r => r.id)]).toEqual([3, ['b']]);
  });

  it('comments come back as a thread; deleting a post deletes its comments', async () => {
    await store.upsertPosts([post('p1'), post('p2')]);
    await store.upsertComments([comment('c2', 'p1', 'c1', { score: 1 }), comment('c1', 'p1', null, { score: 3 }), comment('c3', 'p1', null, { score: 9 }), comment('x', 'p2', null)]);
    expect((await store.commentsForPost('p1')).map(c => c.id)).toEqual(['c3', 'c1', 'c2']);
    await store.deleteRecords('post', ['p1']);
    expect(await store.counts()).toMatchObject({ posts: 1, comments: 1 });
  });

  it('retention removes records not seen recently; clearing removes everything collected', async () => {
    await store.upsertPosts([post('old', { collected_at: '2026-01-01T00:00:00.000Z' }), post('new', { collected_at: '2026-10-01T00:00:00.000Z' })]);
    await store.upsertComments([comment('oc', 'old', null, { collected_at: '2026-01-01T00:00:00.000Z' })]);
    expect(await store.applyRetention(30, Date.parse('2026-10-05T00:00:00Z'))).toEqual({ posts: 1, comments: 1 });
    expect(await store.applyRetention(0)).toEqual({ posts: 0, comments: 0 });
    expect((await store.counts()).posts).toBe(1);
    await store.saveJob({ id: 'j1' } as JobRecord);
    await store.addError({ jobId: 'j1', at: '2026-10-02T00:00:00.000Z', url: null, kind: 'x', message: 'm' });
    await store.clearAll();
    expect(await store.counts()).toEqual({ posts: 0, comments: 0, jobs: 0, errors: 0 });
  });

  it('jobs left running when the page closed are marked as interrupted', async () => {
    const job = { id: 'j9', state: 'running', startedAt: '2026-10-01T00:00:00.000Z', finishedAt: null } as unknown as JobRecord;
    await store.saveJob(job);
    expect(await store.closeInterruptedJobs()).toBe(1);
    const [saved] = await store.listJobs();
    expect(saved.state).toBe('stopped');
    expect(saved.outcome).toMatch(/Interrupted/);
  });

  it('orders orphaned replies (parent not collected) as top-level', () => {
    expect(orderThread([comment('r', 'p', 'missing'), comment('t', 'p', null, { score: 0 })]).map(c => c.id)).toEqual(['r', 't']);
  });
});

describe('exports', () => {
  it('CSV cells: quoting, line breaks, formulas neutralised, arrays joined, null empty', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"\nthere')).toBe('"say ""hi""\nthere"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('@SUM(1)')).toBe('\'@SUM(1)');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(['j1', 'j2'])).toBe('j1;j2');
  });

  it('every schema field is a CSV column (nothing silently dropped)', () => {
    expect(Object.keys(post('a')).sort()).toEqual([...POST_COLUMNS].sort());
    expect(Object.keys(comment('c', 'a', null)).sort()).toEqual([...COMMENT_COLUMNS].sort());
  });

  it('JSON, JSONL and CSV from the same records', async () => {
    const meta = { exportedAt: '2026-10-08T12:34:00.000Z', scope: 'all' as const, filter: null, bom: true };
    const build = (format: 'json' | 'jsonl' | 'csv') => {
      const b = new ExportBuilder(format, meta);
      b.addPost(post('a', { title: 'Ünïcode, "quoted"', score: 0 }));
      b.addPost(post('b'));
      b.addComment(comment('c1', 'a', null));
      return b.finish();
    };
    const [json] = build('json');
    const doc = JSON.parse(json.parts.join(''));
    expect(doc).toMatchObject({ schema_version: 1, exported_at: meta.exportedAt, counts: { posts: 2, comments: 1 } });
    expect(doc.posts[0]).toMatchObject({ id: 'a', title: 'Ünïcode, "quoted"', score: 0, body: null });
    expect(Object.keys(doc.posts[0])).toEqual(POST_COLUMNS);
    expect(json.name).toBe('reddit-collector-20261008-1234.json');

    const [jsonl] = build('jsonl');
    const lines = jsonl.parts.join('').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.record_type)).toEqual(['post', 'post', 'comment']);

    const csv = build('csv');
    expect(csv.map(f => f.name)).toEqual(['reddit-collector-20261008-1234-posts.csv', 'reddit-collector-20261008-1234-comments.csv']);
    const postsCsv = csv[0].parts.join('');
    expect(postsCsv.startsWith('﻿record_type,id,fullname,url,')).toBe(true);
    expect(postsCsv).toContain('"Ünïcode, ""quoted"""');
    expect(postsCsv.split('\r\n').length).toBe(4);           // header, 2 rows, trailing empty
    const empty = new ExportBuilder('json', meta).finish();
    expect(JSON.parse(empty[0].parts.join(''))).toMatchObject({ posts: [], comments: [] });
  });

  it('exports all data or only the filtered records, straight from IndexedDB', async () => {
    await store.upsertPosts([post('a', { title: 'climate' }), post('b')]);
    await store.upsertComments([comment('c1', 'a', null)]);
    const all = await buildExport(store, { format: 'jsonl', scope: 'all', filter: null, bom: false, exportedAt: '2026-10-08T00:00:00.000Z' });
    expect([all.posts, all.comments]).toEqual([2, 1]);
    const filtered = await buildExport(store, { format: 'json', scope: 'filtered', filter: { ...EMPTY_FILTER, text: 'climate' }, bom: false, exportedAt: '2026-10-08T00:00:00.000Z' });
    expect([filtered.posts, filtered.comments]).toEqual([1, 0]);
    expect(filtered.files[0].name).toContain('-filtered');
    const text = await new Promise<string>(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(filtered.files[0].blob); });
    expect(JSON.parse(text).filter.text).toBe('climate');
  });
});
