import { describe, expect, it, vi } from 'vitest';
import { cleanSubreddit, navigationProblem, parsePermalink, parseRedditBase, resolveBrowserInput, safeHttpUrl, searchUrl, subredditListingUrl, type Site } from '../src/lib/urls';
import { ROBOTS_TOKEN, isAllowed, parseRobots } from '../src/lib/robots';
import { AbortError, PauseGate, backoffDelay, sleep, withRetry } from '../src/lib/timing';
import { cleanSettings } from '../src/lib/settings';
import { validateJob } from '../src/bot/validate';
import type { JobConfig } from '../src/types';

const site: Site = { base: new URL('https://www.reddit.com/'), extraHosts: ['localhost'] };

describe('addresses', () => {
  it('only public Reddit pages (or the server\'s mirror) may be opened', () => {
    expect(navigationProblem(new URL('https://www.reddit.com/r/science/'), site)).toBeNull();
    expect(navigationProblem(new URL('https://old.reddit.com/r/science/comments/x/y/'), site)).toBeNull();
    expect(navigationProblem(new URL('http://localhost:4000/r/test/'), site)).toBeNull();
    expect(navigationProblem(new URL('https://example.com/'), site)).toMatch(/Only Reddit/);
    expect(navigationProblem(new URL('https://evilreddit.com/'), site)).toMatch(/Only Reddit/);
    expect(navigationProblem(new URL('http://www.reddit.com/'), site)).toMatch(/https/);
    for (const p of ['/login/', '/message/inbox/', '/settings/profile', '/user/bob/saved/', '/chat/', '/r/x/about/modqueue/']) {
      expect(navigationProblem(new URL('https://www.reddit.com' + p), site)).toMatch(/aren't opened/);
    }
    expect(navigationProblem(new URL('https://www.reddit.com/user/bob/'), site)).toBeNull();
  });

  it('browser input: shortcuts, schemes, and Reddit pages opened on the configured address', () => {
    expect(resolveBrowserInput('r/science', site).href).toBe('https://www.reddit.com/r/science');
    expect(resolveBrowserInput('reddit.com/r/a/', site).href).toBe('https://reddit.com/r/a/');
    const mirror: Site = { base: new URL('http://localhost:4000/'), extraHosts: ['localhost'] };
    expect(resolveBrowserInput('https://www.reddit.com/r/a/?x=1', mirror).href).toBe('http://localhost:4000/r/a/?x=1');
    expect(() => resolveBrowserInput('javascript:alert(1)', site)).toThrow();
    expect(() => resolveBrowserInput('https://example.com', site)).toThrow(/Only Reddit/);
  });

  it('the configured Reddit address must be Reddit over https, or an allowed mirror', () => {
    expect(parseRedditBase('https://old.reddit.com/r/x', []).href).toBe('https://old.reddit.com/');
    expect(() => parseRedditBase('http://www.reddit.com', [])).toThrow(/https/);
    expect(() => parseRedditBase('https://example.com', [])).toThrow();
    expect(parseRedditBase('http://localhost:4000', ['localhost']).href).toBe('http://localhost:4000/');
  });

  it('listing and search addresses for both front-ends', () => {
    expect(subredditListingUrl(site.base, 'science', 'top', 'month')).toBe('https://www.reddit.com/r/science/top/?t=month');
    expect(searchUrl(site.base, 'climate change', 'science', 'new', 'week')).toBe('https://www.reddit.com/r/science/search/?q=climate+change&restrict_sr=1&type=link&sort=new');
    expect(searchUrl(new URL('https://old.reddit.com/'), 'a&b', null, 'hot', 'week')).toBe('https://old.reddit.com/search?q=a%26b');
  });

  it('permalinks, subreddit names and safe links', () => {
    expect(parsePermalink('/r/foo/comments/abc12/some_title/')).toEqual({ subreddit: 'foo', postId: 'abc12', slug: 'some_title', commentId: null });
    expect(parsePermalink('/r/foo/comments/abc12/some_title/def34/')).toMatchObject({ postId: 'abc12', commentId: 'def34' });
    expect(parsePermalink('/r/foo/comments/abc12/comment/def34/')).toMatchObject({ postId: 'abc12', slug: null, commentId: 'def34' });
    expect(parsePermalink('/r/foo/')).toBeNull();
    expect(cleanSubreddit(' r/AskHistorians/ ')).toBe('AskHistorians');
    expect(cleanSubreddit('no spaces')).toBeNull();
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('/x', 'https://www.reddit.com/r/a/')).toBe('https://www.reddit.com/x');
  });
});

describe('robots.txt', () => {
  it('Reddit-style "Disallow: /" blocks everything; longest rule wins; Allow wins ties', () => {
    const all = parseRobots('# comment\nUser-agent: *\nDisallow: /\n');
    expect(isAllowed(all, ROBOTS_TOKEN, '/r/science/new/')).toEqual({ allowed: false, rule: 'Disallow: /' });
    const mixed = parseRobots('User-agent: *\nDisallow: /r/*/comments/\nAllow: /r/science/comments/\nDisallow: /search$\n\nUser-agent: other-bot\nDisallow:\n');
    expect(isAllowed(mixed, ROBOTS_TOKEN, '/r/a/comments/x/').allowed).toBe(false);
    expect(isAllowed(mixed, ROBOTS_TOKEN, '/r/science/comments/x/').allowed).toBe(true);
    expect(isAllowed(mixed, ROBOTS_TOKEN, '/search').allowed).toBe(false);
    expect(isAllowed(mixed, ROBOTS_TOKEN, '/search?q=x').allowed).toBe(true);
    expect(isAllowed(parseRobots('User-agent: metacode-reddit-collector\nDisallow: /r/\nUser-agent: *\nAllow: /'), ROBOTS_TOKEN, '/r/a/').allowed).toBe(false);
    expect(isAllowed(parseRobots(''), ROBOTS_TOKEN, '/anything').allowed).toBe(true);
  });
});

describe('retries, pauses and cancellation', () => {
  it('backs off exponentially, capped', () => {
    expect([1, 2, 3, 4, 5].map(n => backoffDelay(n, 2000, 10000))).toEqual([2000, 4000, 8000, 10000, 10000]);
  });

  it('retries recoverable failures with growing waits, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry(async () => { if (++calls < 3) throw Object.assign(new Error('flaky'), { retryable: true }); return 'ok'; },
      { retries: 3, baseMs: 100, maxMs: 1000, isRetryable: e => (e as { retryable?: boolean }).retryable === true, sleepFn: async ms => { waits.push(ms); } });
    expect(result).toBe('ok');
    expect(waits).toEqual([100, 200]);
  });

  it('gives up after the retry budget, and never retries what isn\'t recoverable', async () => {
    const fail = vi.fn(async () => { throw Object.assign(new Error('down'), { retryable: true }); });
    await expect(withRetry(fail, { retries: 2, baseMs: 1, maxMs: 1, isRetryable: () => true, sleepFn: async () => {} })).rejects.toThrow('down');
    expect(fail).toHaveBeenCalledTimes(3);
    const fatal = vi.fn(async () => { throw new Error('blocked'); });
    await expect(withRetry(fatal, { retries: 5, baseMs: 1, maxMs: 1, isRetryable: () => false, sleepFn: async () => {} })).rejects.toThrow('blocked');
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it('cancellation interrupts waits and retries', async () => {
    const ctrl = new AbortController();
    const p = sleep(10_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(AbortError);
    await expect(withRetry(async () => 'x', { retries: 1, baseMs: 1, maxMs: 1, isRetryable: () => true, signal: ctrl.signal })).rejects.toBeInstanceOf(AbortError);
  });

  it('a paused gate holds until resumed (or stopped)', async () => {
    const gate = new PauseGate();
    gate.pause();
    let passed = false;
    const waiting = gate.wait().then(() => { passed = true; });
    await Promise.resolve();
    expect(passed).toBe(false);
    gate.resume();
    await waiting;
    expect(passed).toBe(true);
    gate.pause();
    const ctrl = new AbortController();
    const stopped = gate.wait(ctrl.signal);
    ctrl.abort();
    await expect(stopped).rejects.toBeInstanceOf(AbortError);
  });
});

describe('settings and job validation', () => {
  it('settings are clamped to safe limits; unknown addresses fall back', () => {
    const s = cleanSettings({ pageDelayMs: 10, maxRetries: 99, redditBase: 'https://example.com', robotsPolicy: 'ignore' as never }, [], 2000);
    expect(s).toMatchObject({ pageDelayMs: 2000, maxRetries: 6, redditBase: 'https://www.reddit.com', robotsPolicy: 'obey' });
  });

  it('job definitions are checked before anything runs', () => {
    const base: JobConfig = { targetType: 'subreddit', subreddits: ['r/science', 'technology', 'technology'], sort: 'new', time: 'week', query: '', searchSubreddit: '',
      mode: 'both', maxPosts: 20, maxCommentsPerPost: 10, dateFrom: '', dateTo: '', maxDepth: 5, maxRuntimeMinutes: 10 };
    const ok = validateJob(base, { pageDelayMs: 3000 });
    expect(ok.errors).toEqual([]);
    expect(ok.config!.subreddits).toEqual(['science', 'technology']);
    expect(ok.warnings.some(w => /extra page loads/.test(w))).toBe(true);
    const bad = validateJob({ ...base, subreddits: ['bad name'], maxPosts: 0, maxCommentsPerPost: 0, dateFrom: '2026-02-30', dateTo: '2020-01-01' }, { pageDelayMs: 3000 });
    expect(bad.config).toBeNull();
    expect(bad.errors.join(' ')).toMatch(/subreddit name.*Maximum posts.*comment.*start date/s);
    expect(validateJob({ ...base, targetType: 'search', query: '  ' }, { pageDelayMs: 3000 }).errors).toContain('Enter something to search for.');
    expect(validateJob({ ...base, dateFrom: '2026-01-01', sort: 'top' }, { pageDelayMs: 3000 }).warnings.join(' ')).toMatch(/work best with the "New" sort/);
  });
});

describe('proxy error messages', async () => {
  const { errorText } = await import('../src/browser/scramjet');
  it('explains common transport failures in plain words, keeping the detail short', () => {
    expect(errorText(new Error('Hyper client: Error(Connect, Io(Custom { kind: InvalidData, error: InvalidCertificate(UnknownIssuer) }))'))).toMatch(/^a secure connection couldn't be made.*\[Hyper client/);
    expect(errorText(new Error('Connection refused'))).toMatch(/^the connection was refused/);
    expect(errorText('x'.repeat(400)).length).toBeLessThan(200);
  });
});
