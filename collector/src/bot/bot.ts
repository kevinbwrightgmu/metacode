// ── The collection bot ────────────────────────────────────────────────────────
// Runs one job: opens each listing (subreddit or search) in the browser,
// reads the posts shown, scrolls or follows "next" for more, opens post pages
// for details and comments, and saves records as it goes. One page at a
// time, with a pause between page loads. Every step checks for pause, stop,
// and the job's limits. Whatever was saved stays saved if the job fails.

import type { CommentRecord, JobConfig, JobProgress, JobRecord, JobState, JobStats, LogEntry, LogLevel, PostRecord, RobotsDecision, Settings } from '../types';
import type { PageDriver, PageHandle } from './driver';
import { NavigationError } from './driver';
import { extractListing, extractPostPage } from '../extract/parse';
import { classifyPage, type PageStatus } from '../extract/detect';
import { inDateRange, normalizeComment, normalizePost } from '../extract/normalize';
import { AbortError, PauseGate, isAbort, sleep as realSleep, withRetry } from '../lib/timing';
import { ROBOTS_TOKEN, isAllowed, parseRobots } from '../lib/robots';
import { postPageUrl, searchUrl, subredditListingUrl, type Site } from '../lib/urls';
import { describeJob } from './validate';

/** Where the bot saves what it collects (the IndexedDB store, or a fake in tests). */
export interface BotStore {
  upsertPosts(records: PostRecord[]): Promise<void>;
  upsertComments(records: CommentRecord[]): Promise<void>;
  saveJob(job: JobRecord): Promise<void>;
  addError(error: { jobId: string; at: string; url: string | null; kind: string; message: string }): Promise<void>;
}

export interface BotDeps {
  driver: PageDriver;
  store: BotStore;
  settings: Settings;
  site: Site;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  newId?: () => string;
}

export type BotEvent =
  | { type: 'progress'; progress: JobProgress }
  | { type: 'log'; entry: LogEntry }
  | { type: 'done'; job: JobRecord };

/** A page that showed Reddit's refusal (block, CAPTCHA…) rather than content. */
class PageRefused extends Error {
  constructor(public status: PageStatus, public url: string) { super(status.message); this.name = 'PageRefused'; }
}
class RetryablePage extends Error {
  readonly retryable = true;
  constructor(public status: PageStatus) { super(status.message); this.name = 'RetryablePage'; }
}
/** The job's post limit or run time was reached: stop collecting, keep everything. */
class LimitReached extends Error {
  constructor(message: string) { super(message); this.name = 'LimitReached'; }
}

const POLL_MS = 250;
const SETTLE_MS = 3000;        // how long an apparently empty, fully loaded page is watched before it counts as empty
const STALE_SCROLLS = 2;       // scrolls in a row without new items before a feed counts as finished

interface Target { label: string; url: string }

export function buildTargets(config: JobConfig, site: Site): Target[] {
  if (config.targetType === 'search') {
    return [{ label: 'search "' + config.query + '"' + (config.searchSubreddit ? ' in r/' + config.searchSubreddit : ''),
      url: searchUrl(site.base, config.query, config.searchSubreddit || null, config.sort, config.time) }];
  }
  return config.subreddits.map(s => ({ label: 'r/' + s, url: subredditListingUrl(site.base, s, config.sort, config.time) }));
}

export class CollectorJob {
  readonly id: string;
  readonly config: JobConfig;
  readonly done: Promise<JobRecord>;
  private deps: Required<Omit<BotDeps, 'newId'>> & Pick<BotDeps, 'newId'>;
  private abort = new AbortController();
  private gate = new PauseGate();
  private listeners = new Set<(e: BotEvent) => void>();
  private stats: JobStats = { postsCollected: 0, commentsCollected: 0, postsSkipped: 0, pagesVisited: 0, errors: 0, retries: 0 };
  private state: JobState = 'running';
  private operation = 'Starting';
  private currentUrl: string | null = null;
  private target: string | null = null;
  private startedMs: number;
  private startedAt: string;
  private deadline: number;
  private robots: RobotsDecision | null = null;
  private seenPosts = new Set<string>();
  private savedPosts = new Set<string>();     // counted in stats.postsCollected
  private postsTaken = 0;
  private navigations = 0;
  readonly logs: LogEntry[] = [];

  constructor(config: JobConfig, deps: BotDeps) {
    this.deps = { now: Date.now, sleep: realSleep, ...deps };
    this.config = config;
    this.id = (deps.newId || (() => 'job_' + Math.random().toString(36).slice(2, 10)))();
    this.startedMs = this.deps.now();
    this.startedAt = new Date(this.startedMs).toISOString();
    this.deadline = this.startedMs + config.maxRuntimeMinutes * 60000;
    this.done = this.run();
  }

  // ── Controls ──────────────────────────────────────────────────────────────
  on(listener: (e: BotEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  pause(): void {
    if (this.state !== 'running') return;
    this.gate.pause();
    this.setState('paused', 'Paused');
    this.log('info', 'Paused. The current page finishes loading; nothing new starts until you resume.');
  }
  resume(): void {
    if (this.state !== 'paused') return;
    this.gate.resume();
    this.setState('running', 'Resuming');
    this.log('info', 'Resumed.');
  }
  stop(): void {
    if (this.state === 'completed' || this.state === 'stopped' || this.state === 'failed' || this.state === 'stopping') return;
    this.setState('stopping', 'Stopping');
    this.log('info', 'Stopping — everything collected so far is kept.');
    this.gate.resume();
    this.abort.abort();
  }
  get progress(): JobProgress {
    return {
      jobId: this.id, state: this.state, operation: this.operation, currentUrl: this.currentUrl, target: this.target,
      stats: { ...this.stats }, limits: { maxPosts: this.config.maxPosts, maxRuntimeMs: this.config.maxRuntimeMinutes * 60000 },
      startedAt: this.startedAt, elapsedMs: this.deps.now() - this.startedMs
    };
  }

  // ── Events ────────────────────────────────────────────────────────────────
  private emit(e: BotEvent): void {
    for (const l of Array.from(this.listeners)) { try { l(e); } catch { /* a listener's problem isn't the job's */ } }
  }
  private emitProgress(): void { this.emit({ type: 'progress', progress: this.progress }); }
  private setState(state: JobState, operation?: string): void {
    this.state = state;
    if (operation) this.operation = operation;
    this.emitProgress();
  }
  private setOperation(operation: string, url?: string | null): void {
    this.operation = operation;
    if (url !== undefined) this.currentUrl = url;
    this.emitProgress();
  }
  private log(level: LogLevel, message: string): void {
    const entry = { at: new Date(this.deps.now()).toISOString(), level, message };
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    this.emit({ type: 'log', entry });
  }
  private async recordError(url: string | null, kind: string, message: string): Promise<void> {
    this.stats.errors++;
    this.log('error', message + (url ? ' — ' + url : ''));
    try { await this.deps.store.addError({ jobId: this.id, at: new Date(this.deps.now()).toISOString(), url, kind, message }); } catch { /* storage problems are reported elsewhere */ }
  }

  private jobRecord(outcome: string | null, finished: boolean): JobRecord {
    return {
      id: this.id, config: this.config, state: this.state, outcome,
      startedAt: this.startedAt, finishedAt: finished ? new Date(this.deps.now()).toISOString() : null,
      stats: { ...this.stats }, robots: this.robots
    };
  }
  private async saveJob(outcome: string | null = null, finished = false): Promise<void> {
    try { await this.deps.store.saveJob(this.jobRecord(outcome, finished)); } catch (err) { this.log('warn', 'The job record couldn\'t be saved: ' + (err as Error).message); }
  }

  // ── Checks done between steps ─────────────────────────────────────────────
  private async checkpoint(): Promise<void> {
    if (this.abort.signal.aborted) throw new AbortError();
    if (this.gate.isPaused) await this.gate.wait(this.abort.signal);
    if (this.deps.now() >= this.deadline) throw new LimitReached('The run-time limit (' + this.config.maxRuntimeMinutes + ' min) was reached.');
  }
  private postLimitReached(): boolean { return this.postsTaken >= this.config.maxPosts; }

  // ── Main ──────────────────────────────────────────────────────────────────
  private async run(): Promise<JobRecord> {
    await Promise.resolve();           // let the caller subscribe before the first event
    this.log('info', 'Job started: ' + describeJob(this.config) + '; collecting ' + ({ posts: 'posts', comments: 'comments', both: 'posts and comments' })[this.config.mode] + ', up to ' + this.config.maxPosts + ' posts.');
    await this.saveJob();
    let outcome: string;
    try {
      const targets = buildTargets(this.config, this.deps.site);
      if (!(await this.checkRobots(targets))) {
        this.state = 'failed';
        outcome = this.robots ? this.robots.note : 'robots.txt couldn\'t be checked.';
        this.log('error', outcome);
      } else {
        const queue: { id: string; url: string }[] = [];
        for (const t of targets) {
          if (this.postLimitReached()) break;
          await this.collectListing(t, queue);
        }
        if (queue.length) {
          this.log('info', 'Opening ' + queue.length + ' post page' + (queue.length === 1 ? '' : 's') + ' for ' + (this.config.mode === 'posts' ? 'details' : 'comments') + '.');
          for (let i = 0; i < queue.length; i++) {
            await this.checkpoint();
            this.target = 'post ' + (i + 1) + ' of ' + queue.length;
            await this.collectPostPage(queue[i]);
          }
        }
        this.state = 'completed';
        outcome = this.postLimitReached() ? 'Reached the limit of ' + this.config.maxPosts + ' posts.' : 'Finished: no more posts within the job\'s pages and limits.';
      }
    } catch (err) {
      if (err instanceof LimitReached) {
        this.state = 'completed';
        outcome = err.message;
      } else if (isAbort(err)) {
        this.state = 'stopped';
        outcome = 'Stopped by you.';
      } else if (err instanceof PageRefused) {
        this.state = 'failed';
        outcome = err.status.message;
        await this.recordError(err.url, err.status.kind, err.status.message);
      } else {
        this.state = 'failed';
        outcome = 'The job failed: ' + ((err as Error)?.message || String(err));
        await this.recordError(this.currentUrl, 'unexpected', outcome);
      }
    }
    this.operation = outcome;
    this.target = null;
    this.log(this.state === 'failed' ? 'error' : 'info', outcome + ' Collected ' + this.stats.postsCollected + ' posts and ' + this.stats.commentsCollected + ' comments.');
    await this.saveJob(outcome, true);
    const job = this.jobRecord(outcome, true);
    this.emitProgress();
    this.emit({ type: 'done', job });
    this.listeners.clear();
    return job;
  }

  // ── robots.txt ────────────────────────────────────────────────────────────
  private async checkRobots(targets: Target[]): Promise<boolean> {
    const policy = this.deps.settings.robotsPolicy;
    const origin = this.deps.site.base.origin;
    const paths = targets.map(t => { const u = new URL(t.url); return u.pathname + u.search; });
    if (this.config.mode !== 'posts' || this.config.targetType === 'search') {
      paths.push(this.config.subreddits[0] ? '/r/' + this.config.subreddits[0] + '/comments/' : '/r/all/comments/');
    }
    this.setOperation('Reading ' + origin + '/robots.txt', origin + '/robots.txt');
    let decision: RobotsDecision;
    try {
      const res = await this.deps.driver.fetchRobots(origin, this.abort.signal);
      if (res.status >= 400 && res.status < 500) {
        decision = { checked: true, allowed: true, rule: null, policy, note: 'No robots.txt (HTTP ' + res.status + '): no restrictions.' };
      } else if (res.status >= 200 && res.status < 300) {
        const groups = parseRobots(res.text);
        const blocked = paths.map(p => ({ p, r: isAllowed(groups, ROBOTS_TOKEN, p) })).find(x => !x.r.allowed);
        decision = blocked
          ? { checked: true, allowed: false, rule: blocked.r.rule, policy, note: 'Reddit\'s robots.txt disallows automated access to ' + blocked.p + ' (' + blocked.r.rule + ').' }
          : { checked: true, allowed: true, rule: null, policy, note: 'robots.txt allows these pages.' };
      } else {
        decision = { checked: false, allowed: false, rule: null, policy, note: 'robots.txt couldn\'t be read (HTTP ' + res.status + '), so access is treated as disallowed.' };
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      decision = { checked: false, allowed: false, rule: null, policy, note: 'robots.txt couldn\'t be read (' + (err as Error).message + '), so access is treated as disallowed.' };
    }
    this.robots = decision;
    if (decision.allowed) { this.log('info', decision.note); return true; }
    if (policy === 'warn') {
      this.robots = { ...decision, note: decision.note + ' Continuing because Settings → robots.txt is set to "warn" (only for collection Reddit has permitted).' };
      this.log('warn', this.robots.note);
      return true;
    }
    this.robots = { ...decision, note: decision.note + ' The job didn\'t open any pages. Reddit offers its Data API for permitted research access.' };
    return false;
  }

  // ── Loading pages ─────────────────────────────────────────────────────────
  /** Waits until the page shows content or something definite (a refusal, an empty listing). */
  private async waitForContent(page: PageHandle, expect: 'listing' | 'post'): Promise<PageStatus> {
    const start = this.deps.now();
    let completeSince: number | null = null;
    for (;;) {
      if (this.abort.signal.aborted) throw new AbortError();
      const doc = page.document;
      const status = classifyPage(doc, page.url, expect);
      if (status.kind !== 'empty') return status;
      const now = this.deps.now();
      if (doc.readyState === 'complete') completeSince ??= now; else completeSince = null;
      if ((completeSince !== null && now - completeSince >= SETTLE_MS) || now - start >= this.deps.settings.pageTimeoutMs) return status;
      await this.deps.sleep(POLL_MS, this.abort.signal);
    }
  }

  /** Opens a page (after the polite pause), retrying load failures with backoff. */
  private async load(url: string, expect: 'listing' | 'post'): Promise<{ page: PageHandle; status: PageStatus }> {
    return withRetry(async attempt => {
      await this.checkpoint();
      if (this.navigations > 0) {
        this.setOperation('Waiting ' + Math.round(this.deps.settings.pageDelayMs / 100) / 10 + ' s before the next page', url);
        await this.deps.sleep(this.deps.settings.pageDelayMs, this.abort.signal);
        await this.checkpoint();
      }
      this.navigations++;
      this.setOperation((attempt ? 'Retrying ' : 'Opening ') + (expect === 'post' ? 'post page' : 'listing'), url);
      const page = await this.deps.driver.open(url, this.abort.signal);
      this.stats.pagesVisited++;
      this.setOperation('Reading the page', page.url);
      const status = await this.waitForContent(page, expect);
      if (status.retryable) throw new RetryablePage(status);
      return { page, status };
    }, {
      retries: this.deps.settings.maxRetries,
      baseMs: 2000,
      maxMs: 30000,
      signal: this.abort.signal,
      sleepFn: this.deps.sleep,
      isRetryable: err => err instanceof NavigationError || err instanceof RetryablePage,
      onRetry: (err, n, ms) => {
        this.stats.retries++;
        this.log('warn', (err as Error).message + ' Trying again in ' + Math.round(ms / 1000) + ' s (retry ' + n + ' of ' + this.deps.settings.maxRetries + ').');
        this.emitProgress();
      }
    });
  }

  /** A page that isn't content: stop the job for refusals, otherwise record it and go on. */
  private async handleStatus(status: PageStatus, url: string): Promise<boolean> {
    if (status.kind === 'content') return true;
    if (status.stopJob) throw new PageRefused(status, url);
    if (status.kind === 'empty') { this.log('info', status.message + ' — ' + url); return false; }
    await this.recordError(url, status.kind, status.message);
    return false;
  }

  private async savePosts(posts: PostRecord[]): Promise<void> {
    await this.deps.store.upsertPosts(posts);
    for (const p of posts) {
      if (this.savedPosts.has(p.id)) continue;
      this.savedPosts.add(p.id);
      this.stats.postsCollected++;
    }
  }

  // ── Listings ──────────────────────────────────────────────────────────────
  private async collectListing(target: Target, queue: { id: string; url: string }[]): Promise<void> {
    this.target = target.label;
    let loaded: { page: PageHandle; status: PageStatus };
    try {
      loaded = await this.load(target.url, 'listing');
    } catch (err) {
      if (err instanceof NavigationError || err instanceof RetryablePage) { await this.recordError(target.url, 'load_failed', 'Couldn\'t load ' + target.label + ' after ' + (this.deps.settings.maxRetries + 1) + ' tries: ' + err.message); return; }
      throw err;
    }
    let { page } = loaded;
    if (!(await this.handleStatus(loaded.status, page.url))) return;

    let steps = 1;
    let stale = 0;
    for (;;) {
      await this.checkpoint();
      this.setOperation('Reading posts on ' + target.label, page.url);
      const { posts, nextUrl, variant } = extractListing(page.document, page.url);
      const sourceUrl = page.url;
      const at = new Date(this.deps.now()).toISOString();
      const toSave: PostRecord[] = [];
      let fresh = 0, withDates = 0, olderThanRange = 0;
      for (const raw of posts) {
        if (this.postLimitReached()) break;
        if (!raw.id || this.seenPosts.has(raw.id)) continue;
        this.seenPosts.add(raw.id);
        fresh++;
        const result = normalizePost(raw, { jobId: this.id, at, sourceUrl });
        if (!result.ok) { this.stats.postsSkipped++; this.log('warn', 'Skipped a post: ' + result.reason + '.'); continue; }
        const post = result.record;
        const range = inDateRange(post.created_at, this.config.dateFrom, this.config.dateTo);
        if (post.created_at) withDates++;
        if (range === false) {
          this.stats.postsSkipped++;
          if (this.config.dateFrom && post.created_at && post.created_at.slice(0, 10) < this.config.dateFrom) olderThanRange++;
          continue;
        }
        // Unknown date with a date range: decide on the post's own page, or skip
        const needsPage = this.config.mode !== 'posts' || raw.variant === 'generic' || range === null;
        if (range === null && this.config.mode === 'posts' && raw.variant !== 'generic') { this.stats.postsSkipped++; continue; }
        this.postsTaken++;
        if (needsPage) queue.push({ id: post.id, url: postPageUrl(this.deps.site.base, post.url) });
        if (this.config.mode !== 'comments' && range === true) toSave.push(post);
      }
      if (toSave.length) await this.savePosts(toSave);
      this.emitProgress();
      if (fresh) this.log('info', target.label + ': ' + fresh + ' new post' + (fresh === 1 ? '' : 's') + ' on this ' + (variant === 'old' ? 'page' : 'step') + (toSave.length !== fresh ? ' (' + toSave.length + ' saved now)' : '') + '.');

      if (this.postLimitReached()) return;
      if (this.config.sort === 'new' && olderThanRange && olderThanRange === withDates && fresh) {
        this.log('info', target.label + ': reached posts older than ' + this.config.dateFrom + '; moving on.');
        return;
      }
      if (steps >= this.config.maxDepth) {
        this.log('info', target.label + ': reached the limit of ' + this.config.maxDepth + ' pages / scroll steps.');
        return;
      }
      steps++;
      if (variant === 'old') {
        if (!nextUrl) { this.log('info', target.label + ': no more pages.'); return; }
        let next: { page: PageHandle; status: PageStatus };
        try {
          next = await this.load(nextUrl, 'listing');
        } catch (err) {
          if (err instanceof NavigationError || err instanceof RetryablePage) { await this.recordError(nextUrl, 'load_failed', 'Couldn\'t load the next page: ' + err.message); return; }
          throw err;
        }
        page = next.page;
        if (!(await this.handleStatus(next.status, page.url))) return;
      } else {
        const grew = await this.scrollForMore(page, () => extractListing(page.document, page.url).posts.length, 'posts');
        if (!grew) {
          stale++;
          if (stale >= STALE_SCROLLS) { this.log('info', target.label + ': no more posts load when scrolling.'); return; }
        } else stale = 0;
      }
    }
  }

  /** Scrolls to the end and waits for more items to appear. → whether any did. */
  private async scrollForMore(page: PageHandle, count: () => number, what: string): Promise<boolean> {
    const before = count();
    this.setOperation('Scrolling for more ' + what, page.url);
    this.deps.driver.scrollToEnd(page);
    const waitUntil = this.deps.now() + Math.max(this.deps.settings.scrollDelayMs, 500) + Math.min(10000, this.deps.settings.pageTimeoutMs / 3);
    await this.deps.sleep(this.deps.settings.scrollDelayMs, this.abort.signal);
    for (;;) {
      if (count() > before) return true;
      if (this.deps.now() >= waitUntil) return false;
      await this.checkpoint();
      await this.deps.sleep(POLL_MS, this.abort.signal);
    }
  }

  // ── Post pages ────────────────────────────────────────────────────────────
  private async collectPostPage(item: { id: string; url: string }): Promise<void> {
    let loaded: { page: PageHandle; status: PageStatus };
    try {
      loaded = await this.load(item.url, 'post');
    } catch (err) {
      if (err instanceof NavigationError || err instanceof RetryablePage) { await this.recordError(item.url, 'load_failed', 'Couldn\'t load the post page: ' + err.message); return; }
      throw err;
    }
    const { page } = loaded;
    if (!(await this.handleStatus(loaded.status, page.url))) return;

    const at = new Date(this.deps.now()).toISOString();
    const extract = extractPostPage(page.document, page.url);
    let post: PostRecord | null = null;
    if (extract.post) {
      const result = normalizePost(extract.post, { jobId: this.id, at, sourceUrl: page.url });
      if (result.ok) post = result.record;
      else this.log('warn', 'The post on ' + page.url + ' couldn\'t be read: ' + result.reason + '.');
    }
    const range = inDateRange(post ? post.created_at : null, this.config.dateFrom, this.config.dateTo);
    if (range !== true) {
      this.stats.postsSkipped++;
      this.log('info', 'Skipped ' + item.url + ': ' + (range === false ? 'outside the date range.' : 'its date isn\'t shown.'));
      this.emitProgress();
      return;
    }
    if (post && this.config.mode !== 'comments') await this.savePosts([post]);
    if (this.config.mode !== 'posts' && this.config.maxCommentsPerPost > 0) await this.collectComments(page, post ? post.id : item.id);
    this.emitProgress();
  }

  private async collectComments(page: PageHandle, postId: string): Promise<void> {
    const seen = new Set<string>();
    let saved = 0, steps = 1, stale = 0;
    const max = this.config.maxCommentsPerPost;
    for (;;) {
      await this.checkpoint();
      this.setOperation('Reading comments', page.url);
      const at = new Date(this.deps.now()).toISOString();
      const batch: CommentRecord[] = [];
      for (const raw of extractPostPage(page.document, page.url).comments) {
        if (saved + batch.length >= max) break;
        const result = normalizeComment(raw, { jobId: this.id, at, sourceUrl: page.url });
        if (!result.ok || seen.has(result.record.id)) continue;
        if (result.record.post_id !== postId) continue;      // e.g. a comment quoted from another thread
        seen.add(result.record.id);
        batch.push(result.record);
      }
      if (batch.length) {
        await this.deps.store.upsertComments(batch);
        saved += batch.length;
        this.stats.commentsCollected += batch.length;
        this.emitProgress();
      }
      if (saved >= max || steps >= this.config.maxDepth) break;
      steps++;
      const grew = await this.scrollForMore(page, () => extractPostPage(page.document, page.url).comments.length, 'comments');
      if (!grew && ++stale >= STALE_SCROLLS) break;
      if (grew) stale = 0;
    }
    this.log('info', 'Post ' + postId + ': ' + saved + ' comment' + (saved === 1 ? '' : 's') + '.');
  }
}

/** Starts a job right away; returns its handle (controls, events, and `done`). */
export function startJob(config: JobConfig, deps: BotDeps): CollectorJob {
  return new CollectorJob(config, deps);
}
