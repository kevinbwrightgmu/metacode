import { describe, expect, it } from 'vitest';
import { CollectorJob, type BotStore } from '../src/bot/bot';
import { NavigationError, type PageDriver, type PageHandle, type RobotsFetch } from '../src/bot/driver';
import { mergeRecords } from '../src/extract/normalize';
import { AbortError } from '../src/lib/timing';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import type { CommentRecord, JobConfig, JobRecord, PostRecord, Settings } from '../src/types';
import { fixtureHtml, html } from './helpers';

// ── Test doubles ──────────────────────────────────────────────────────────────

class MemoryStore implements BotStore {
  posts = new Map<string, PostRecord>();
  comments = new Map<string, CommentRecord>();
  jobs: JobRecord[] = [];
  errors: { kind: string; message: string; url: string | null }[] = [];
  async upsertPosts(rs: PostRecord[]) { rs.forEach(r => this.posts.set(r.id, this.posts.has(r.id) ? mergeRecords(this.posts.get(r.id)!, r) : r)); }
  async upsertComments(rs: CommentRecord[]) { rs.forEach(r => this.comments.set(r.id, this.comments.has(r.id) ? mergeRecords(this.comments.get(r.id)!, r) : r)); }
  async saveJob(j: JobRecord) { this.jobs.push(j); }
  async addError(e: { kind: string; message: string; url: string | null }) { this.errors.push(e); }
}

interface P { id: string; created?: string; sub?: string }
const shredditPost = (p: P) => '<article><shreddit-post id="t3_' + p.id + '" permalink="/r/' + (p.sub || 'tech') + '/comments/' + p.id + '/t/" post-title="Title ' + p.id +
  '" author="u' + p.id + '" score="1" comment-count="2" post-type="text" created-timestamp="' + (p.created || '2026-10-01T00:00:00.000000+0000') + '"></shreddit-post></article>';
const feed = (posts: P[]) => html('<shreddit-app><shreddit-feed>' + posts.map(shredditPost).join('') + '</shreddit-feed></shreddit-app>');
function appendPosts(doc: Document, posts: P[]) {
  const t = doc.createElement('template');
  t.innerHTML = posts.map(shredditPost).join('');
  doc.querySelector('shreddit-feed')!.append(t.content);
}
const oldListing = (posts: P[], next: string | null) => html('<body class="listing-page"><div id="siteTable">' + posts.map(p =>
  '<div class="thing link" data-fullname="t3_' + p.id + '" data-subreddit="' + (p.sub || 'tech') + '" data-author="a" data-permalink="/r/' + (p.sub || 'tech') + '/comments/' + p.id + '/t/" data-timestamp="1759276800000" data-score="3" data-comments-count="1"><a class="title">T ' + p.id + '</a></div>'
).join('') + (next ? '<span class="next-button"><a href="' + next + '">next</a></span>' : '') + '</div></body>');
const postPage = (id: string, comments: string[]) => html('<shreddit-app><shreddit-post id="t3_' + id + '" permalink="/r/tech/comments/' + id + '/t/" post-title="Title ' + id +
  '" author="u' + id + '" score="5" comment-count="' + comments.length + '" post-type="text" created-timestamp="2026-10-01T00:00:00.000000+0000"><div slot="text-body"><p>Full text of ' + id + '</p></div></shreddit-post>' +
  comments.map(c => '<shreddit-comment thingid="t1_' + c + '" postid="t3_' + id + '" parentid="t3_' + id + '" depth="0" author="x" score="1"><div slot="comment"><p>Comment ' + c + '</p></div></shreddit-comment>').join('') + '</shreddit-app>');

class FakeDriver implements PageDriver {
  opened: string[] = [];
  scrolls = 0;
  robots: RobotsFetch | Error = { status: 200, text: 'User-agent: *\nAllow: /\n' };
  failures = new Map<string, number>();
  constructor(public pages: Record<string, () => Document>, public onScroll?: (page: PageHandle) => void) {}
  async open(url: string, signal: AbortSignal): Promise<PageHandle> {
    if (signal.aborted) throw new AbortError();
    this.opened.push(url);
    const left = this.failures.get(url) || 0;
    if (left > 0) { this.failures.set(url, left - 1); throw new NavigationError('The page didn\'t load within 30 s.'); }
    const make = this.pages[url];
    if (!make) throw new NavigationError('No such page in the test: ' + url);
    return { url, document: make() };
  }
  scrollToEnd(page: PageHandle) { this.scrolls++; this.onScroll?.(page); }
  async fetchRobots(): Promise<RobotsFetch> { if (this.robots instanceof Error) throw this.robots; return this.robots; }
}

function setup(config: Partial<JobConfig>, driver: FakeDriver, settings: Partial<Settings> = {}) {
  let t = Date.parse('2026-10-08T00:00:00Z');
  const store = new MemoryStore();
  const full: JobConfig = { targetType: 'subreddit', subreddits: ['tech'], sort: 'new', time: 'week', query: '', searchSubreddit: '', mode: 'posts',
    maxPosts: 100, maxCommentsPerPost: 10, dateFrom: '', dateTo: '', maxDepth: 10, maxRuntimeMinutes: 60, ...config };
  const job = new CollectorJob(full, {
    driver, store, settings: { ...DEFAULT_SETTINGS, pageDelayMs: 1000, ...settings },
    site: { base: new URL(settings.redditBase || 'https://www.reddit.com/'), extraHosts: [] },
    now: () => t,
    sleep: async (ms, signal) => { if (signal?.aborted) throw new AbortError(); t += ms; await new Promise(r => setTimeout(r, 0)); if (signal?.aborted) throw new AbortError(); },
    newId: () => 'job_test'
  });
  return { job, store, advance: (ms: number) => { t += ms; } };
}

const NEW = 'https://www.reddit.com/r/tech/new/';
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: 'p' + (from + i) }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('listings', () => {
  it('scrolls an infinite feed until the post limit, skipping posts already seen', async () => {
    let batch = 0;
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 5)) }, page => {
      batch++;
      appendPosts(page.document, batch === 1 ? [{ id: 'p4' }, { id: 'p5' }, ...ids(6, 8)] : ids(9, 12));
    });
    const { job, store } = setup({ maxPosts: 7 }, driver);
    const done = await job.done;
    expect(done.state).toBe('completed');
    expect(done.outcome).toBe('Reached the limit of 7 posts.');
    expect(done.stats.postsCollected).toBe(7);
    expect(Array.from(store.posts.keys())).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(driver.scrolls).toBe(1);
    expect(driver.opened).toEqual([NEW]);
  });

  it('a feed that stops growing ends after two scrolls without new posts', async () => {
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 3)) }, () => {});
    const { job } = setup({}, driver);
    const done = await job.done;
    expect([done.state, done.stats.postsCollected, driver.scrolls]).toEqual(['completed', 3, 2]);
    expect(done.outcome).toMatch(/no more posts/);
  });

  it('old Reddit: follows "next" pages up to the page limit', async () => {
    const base = 'https://old.reddit.com';
    const driver = new FakeDriver({
      [base + '/r/tech/new/']: () => oldListing(ids(1, 2), base + '/r/tech/new/?after=t3_p2'),
      [base + '/r/tech/new/?after=t3_p2']: () => oldListing(ids(3, 4), base + '/r/tech/new/?after=t3_p4'),
      [base + '/r/tech/new/?after=t3_p4']: () => oldListing(ids(5, 6), null)
    });
    const { job, store } = setup({ maxDepth: 2 }, driver, { redditBase: base });
    const done = await job.done;
    expect(driver.opened).toEqual([base + '/r/tech/new/', base + '/r/tech/new/?after=t3_p2']);
    expect(store.posts.size).toBe(4);
    expect(done.stats.pagesVisited).toBe(2);
  });

  it('dates: posts outside the range are skipped; with "new" the bot stops at older posts', async () => {
    const posts = [{ id: 'a', created: '2026-10-05T00:00:00.000Z' }, { id: 'b', created: '2026-10-03T00:00:00.000Z' }, { id: 'c', created: '2026-09-20T00:00:00.000Z' }];
    const driver = new FakeDriver({ [NEW]: () => feed(posts) }, page => appendPosts(page.document, [{ id: 'd', created: '2026-09-01T00:00:00.000Z' }]));
    const { job, store } = setup({ dateFrom: '2026-10-01', dateTo: '2026-10-04' }, driver);
    const done = await job.done;
    expect(Array.from(store.posts.keys())).toEqual(['b']);
    expect(done.stats.postsSkipped).toBe(3);
    expect(job.logs.some(l => /older than 2026-10-01/.test(l.message))).toBe(true);
  });
});

describe('post pages and comments', () => {
  const realListing = () => new DOMParser().parseFromString(fixtureHtml('shreddit-listing.html'), 'text/html');
  const realPost = () => new DOMParser().parseFromString(fixtureHtml('shreddit-post.html'), 'text/html');
  const listingUrl = 'https://www.reddit.com/r/technology/new/';
  const pages = {
    [listingUrl]: realListing,
    'https://www.reddit.com/r/technology/comments/1abc23/chip_makers_announce_new_standard/': () => postPage('1abc23', ['z1']),
    'https://www.reddit.com/r/technology/comments/1abc24/ask_what_laptop_for_students/': realPost,
    'https://www.reddit.com/r/technology/comments/1abc25/photo_of_the_new_rover/': () => postPage('1abc25', [])
  };

  it('comments mode: opens each post and saves its comments (up to the limit), not the posts', async () => {
    const driver = new FakeDriver(pages, () => {});
    const { job, store } = setup({ subreddits: ['technology'], mode: 'comments', maxCommentsPerPost: 2 }, driver);
    const done = await job.done;
    expect(done.state).toBe('completed');
    expect(store.posts.size).toBe(0);
    expect(Array.from(store.comments.keys()).sort()).toEqual(['c001', 'c002', 'z1']);
    expect(store.comments.get('c002')).toMatchObject({ post_id: '1abc24', parent_comment_id: 'c001', depth: 1 });
    expect(done.stats.commentsCollected).toBe(3);
    expect(driver.opened.length).toBe(4);
  });

  it('both: post details from the post page replace the listing preview, counted once', async () => {
    const driver = new FakeDriver(pages, () => {});
    const { job, store } = setup({ subreddits: ['technology'], mode: 'both' }, driver);
    const done = await job.done;
    expect(done.stats.postsCollected).toBe(3);
    expect(store.posts.get('1abc24')).toMatchObject({ details_collected: true, score: 12, num_comments: 4 });
    expect(store.posts.get('1abc24')!.body).toMatch(/^My budget is \$800\.\n\nRequirements:/);
    expect(store.comments.size).toBe(5);
  });
});

describe('failures and refusals', () => {
  it('retries a page that didn\'t load, with growing waits', async () => {
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 2)) }, () => {});
    driver.failures.set(NEW, 2);
    const { job } = setup({}, driver, { maxRetries: 3 });
    const done = await job.done;
    expect([done.state, done.stats.retries, done.stats.postsCollected]).toEqual(['completed', 2, 2]);
    expect(job.logs.filter(l => /Trying again in/.test(l.message)).map(l => /Trying again in (\d+) s/.exec(l.message)![1])).toEqual(['2', '4']);
  });

  it('a page that keeps failing is recorded, and the job moves on', async () => {
    const other = 'https://www.reddit.com/r/other/new/';
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 1)), [other]: () => feed([{ id: 'o1', sub: 'other' }]) }, () => {});
    driver.failures.set(NEW, 99);
    const { job, store } = setup({ subreddits: ['tech', 'other'] }, driver, { maxRetries: 1 });
    const done = await job.done;
    expect(done.state).toBe('completed');
    expect(done.stats.errors).toBe(1);
    expect(store.errors[0]).toMatchObject({ kind: 'load_failed', url: NEW });
    expect(Array.from(store.posts.keys())).toEqual(['o1']);
  });

  it('Reddit refusing (block page) stops the job; what was collected stays', async () => {
    const blocked = 'https://www.reddit.com/r/blocked/new/';
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 2)), [blocked]: () => new DOMParser().parseFromString(fixtureHtml('blocked.html'), 'text/html') }, () => {});
    const { job, store } = setup({ subreddits: ['tech', 'blocked'] }, driver);
    const done = await job.done;
    expect(done.state).toBe('failed');
    expect(done.outcome).toMatch(/blocked this browser/);
    expect(store.posts.size).toBe(2);
    expect(store.errors.map(e => e.kind)).toEqual(['blocked']);
  });

  it('a CAPTCHA stops the job without any attempt to answer it', async () => {
    const driver = new FakeDriver({ [NEW]: () => new DOMParser().parseFromString(fixtureHtml('captcha.html'), 'text/html') });
    const { job } = setup({}, driver, { maxRetries: 3 });
    const done = await job.done;
    expect([done.state, done.stats.retries]).toEqual(['failed', 0]);
    expect(done.outcome).toMatch(/CAPTCHA/);
  });

  it('a private community is skipped and reported, not retried', async () => {
    const priv = 'https://www.reddit.com/r/secret/new/';
    const driver = new FakeDriver({ [priv]: () => new DOMParser().parseFromString(fixtureHtml('private.html'), 'text/html'), [NEW]: () => feed(ids(1, 1)) }, () => {});
    const { job, store } = setup({ subreddits: ['secret', 'tech'] }, driver);
    const done = await job.done;
    expect(done.state).toBe('completed');
    expect(store.errors.map(e => e.kind)).toEqual(['private']);
    expect(store.posts.size).toBe(1);
  });
});

describe('robots.txt policy', () => {
  it('obey: a disallowing robots.txt stops the job before any page is opened', async () => {
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 1)) });
    driver.robots = { status: 200, text: 'User-agent: *\nDisallow: /\n' };
    const { job } = setup({}, driver);
    const done = await job.done;
    expect(done.state).toBe('failed');
    expect(driver.opened).toEqual([]);
    expect(done.robots).toMatchObject({ checked: true, allowed: false, rule: 'Disallow: /', policy: 'obey' });
    expect(done.outcome).toMatch(/disallows automated access/);
  });

  it('warn: the job runs, and the decision is recorded with the job', async () => {
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 1)) }, () => {});
    driver.robots = { status: 200, text: 'User-agent: *\nDisallow: /\n' };
    const { job } = setup({}, driver, { robotsPolicy: 'warn' });
    const done = await job.done;
    expect(done.state).toBe('completed');
    expect(done.robots!.note).toMatch(/Continuing because Settings/);
  });

  it('an unreadable robots.txt counts as disallowed; a missing one (404) allows', async () => {
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 1)) }, () => {});
    driver.robots = new Error('network down');
    expect((await setup({}, driver).job.done).state).toBe('failed');
    driver.robots = { status: 404, text: '' };
    expect((await setup({}, driver).job.done).state).toBe('completed');
  });
});

describe('controls and limits', () => {
  it('stop: the job ends as stopped and keeps what it saved', async () => {
    let n = 0;
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 3)) }, page => appendPosts(page.document, ids(100 + n * 3, 102 + n++ * 3)));
    const { job, store } = setup({}, driver);
    job.on(e => { if (e.type === 'progress' && driver.scrolls === 2) job.stop(); });
    const done = await job.done;
    expect(done.state).toBe('stopped');
    expect(done.outcome).toBe('Stopped by you.');
    expect(store.posts.size).toBeGreaterThanOrEqual(3);
    expect(store.jobs.at(-1)!.state).toBe('stopped');
  });

  it('pause holds the job before the next page; resume continues', async () => {
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 2)) }, () => {});
    const { job } = setup({}, driver);
    job.pause();
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
    expect(job.progress.state).toBe('paused');
    expect(driver.opened).toEqual([]);
    job.resume();
    const done = await job.done;
    expect([done.state, done.stats.postsCollected]).toEqual(['completed', 2]);
  });

  it('stops at the run-time limit with what it collected', async () => {
    let n = 0;
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 2)) }, page => appendPosts(page.document, [{ id: 'q' + n++ }]));
    const { job } = setup({ maxRuntimeMinutes: 1, maxDepth: 100 }, driver, { scrollDelayMs: 20000 });
    const done = await job.done;
    expect(done.state).toBe('completed');
    expect(done.outcome).toMatch(/run-time limit \(1 min\)/);
    expect(done.stats.postsCollected).toBeGreaterThan(2);
  });

  it('emits progress, log and done events', async () => {
    const driver = new FakeDriver({ [NEW]: () => feed(ids(1, 1)) }, () => {});
    const { job } = setup({}, driver);
    const types = new Set<string>();
    job.on(e => types.add(e.type));
    await job.done;
    expect(Array.from(types).sort()).toEqual(['done', 'log', 'progress']);
  });
});
