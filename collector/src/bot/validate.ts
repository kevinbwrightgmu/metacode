// ── Job definitions: defaults, limits and validation ──────────────────────────
import type { JobConfig, Settings } from '../types';
import { cleanSubreddit } from '../lib/urls';

export const LIMITS = {
  maxSubreddits: 10,
  maxPosts: 1000,
  maxCommentsPerPost: 500,
  maxDepth: 100,
  maxRuntimeMinutes: 240,
  queryLength: 200
};

export function defaultJobConfig(settings: Pick<Settings, 'defaultMaxPosts' | 'defaultMaxComments'>): JobConfig {
  return {
    targetType: 'subreddit', subreddits: [], sort: 'new', time: 'week', query: '', searchSubreddit: '',
    mode: 'posts', maxPosts: settings.defaultMaxPosts, maxCommentsPerPost: settings.defaultMaxComments,
    dateFrom: '', dateTo: '', maxDepth: 10, maxRuntimeMinutes: 15
  };
}

export interface Validation { config: JobConfig | null; errors: string[]; warnings: string[] }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function intIn(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Checks a job definition (from the form, or anything else) and returns a clean copy or the problems. */
export function validateJob(input: Partial<JobConfig>, settings: Pick<Settings, 'pageDelayMs'>): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const c = { ...input } as JobConfig;

  if (c.targetType !== 'subreddit' && c.targetType !== 'search') errors.push('Choose subreddits or a search.');
  if (!['hot', 'new', 'top', 'rising'].includes(c.sort)) c.sort = 'new';
  if (!['hour', 'day', 'week', 'month', 'year', 'all'].includes(c.time)) c.time = 'week';
  if (!['posts', 'comments', 'both'].includes(c.mode)) errors.push('Choose what to collect.');

  if (c.targetType === 'subreddit') {
    const raw = (Array.isArray(c.subreddits) ? c.subreddits : []).map(s => String(s).trim()).filter(Boolean);
    const bad = raw.filter(s => !cleanSubreddit(s));
    if (!raw.length) errors.push('Enter at least one subreddit, e.g. technology.');
    if (bad.length) errors.push('Not a valid subreddit name: ' + bad.slice(0, 3).join(', ') + '. Names are 2–21 letters, digits or underscores.');
    const names = Array.from(new Set(raw.map(s => cleanSubreddit(s)).filter((s): s is string => !!s)));
    if (names.length > LIMITS.maxSubreddits) errors.push('At most ' + LIMITS.maxSubreddits + ' subreddits per job.');
    c.subreddits = names;
    c.query = '';
    c.searchSubreddit = '';
  } else if (c.targetType === 'search') {
    c.query = String(c.query || '').trim();
    if (!c.query) errors.push('Enter something to search for.');
    if (c.query.length > LIMITS.queryLength) errors.push('The search is too long (at most ' + LIMITS.queryLength + ' characters).');
    const sub = String(c.searchSubreddit || '').trim();
    c.searchSubreddit = sub ? cleanSubreddit(sub) || '' : '';
    if (sub && !c.searchSubreddit) errors.push('"' + sub + '" isn\'t a valid subreddit name.');
    c.subreddits = [];
    if (c.sort === 'rising') c.sort = 'new';
  }

  const maxPosts = intIn(c.maxPosts, 1, LIMITS.maxPosts);
  if (maxPosts === null) errors.push('Maximum posts must be a whole number from 1 to ' + LIMITS.maxPosts + '.');
  else c.maxPosts = maxPosts;
  const maxComments = intIn(c.maxCommentsPerPost, 0, LIMITS.maxCommentsPerPost);
  if (maxComments === null) errors.push('Maximum comments per post must be a whole number from 0 to ' + LIMITS.maxCommentsPerPost + '.');
  else c.maxCommentsPerPost = maxComments;
  if (c.mode !== 'posts' && maxComments === 0) errors.push('To collect comments, allow at least 1 comment per post.');
  const depth = intIn(c.maxDepth, 1, LIMITS.maxDepth);
  if (depth === null) errors.push('Maximum pages / scroll steps must be from 1 to ' + LIMITS.maxDepth + '.');
  else c.maxDepth = depth;
  const runtime = intIn(c.maxRuntimeMinutes, 1, LIMITS.maxRuntimeMinutes);
  if (runtime === null) errors.push('Maximum run time must be from 1 to ' + LIMITS.maxRuntimeMinutes + ' minutes.');
  else c.maxRuntimeMinutes = runtime;

  c.dateFrom = String(c.dateFrom || '').trim();
  c.dateTo = String(c.dateTo || '').trim();
  if (c.dateFrom && !validDay(c.dateFrom)) errors.push('The start date isn\'t a valid date (YYYY-MM-DD).');
  if (c.dateTo && !validDay(c.dateTo)) errors.push('The end date isn\'t a valid date (YYYY-MM-DD).');
  if (c.dateFrom && c.dateTo && validDay(c.dateFrom) && validDay(c.dateTo) && c.dateFrom > c.dateTo) errors.push('The start date is after the end date.');

  if (!errors.length) {
    if ((c.dateFrom || c.dateTo) && c.sort !== 'new') warnings.push('Date ranges work best with the "New" sort: other sorts mix dates, so the bot can\'t stop early at the start date and may read many posts outside the range.');
    if (c.dateFrom || c.dateTo) warnings.push('Posts whose date the page doesn\'t show are skipped while a date range is set.');
    const targets = c.targetType === 'subreddit' ? c.subreddits.length : 1;
    const listingPages = targets * c.maxDepth;
    const postPages = c.mode === 'posts' ? 0 : c.maxPosts;
    const minutes = Math.ceil(((listingPages + postPages) * settings.pageDelayMs) / 60000);
    if (c.mode !== 'posts') warnings.push('Comments are read from each post\'s own page: up to ' + c.maxPosts + ' extra page loads.');
    if (minutes > c.maxRuntimeMinutes) warnings.push('At the current page delay this could take about ' + minutes + ' minutes; the job stops at ' + c.maxRuntimeMinutes + ' minutes with what it has collected.');
  }
  return { config: errors.length ? null : c, errors, warnings };
}

/** A short description of a job, e.g. "r/technology, r/science · new" or "search "climate" in r/science". */
export function describeJob(c: JobConfig): string {
  const sort = c.sort === 'top' ? 'top (' + c.time + ')' : c.sort;
  if (c.targetType === 'search') return 'search "' + c.query + '"' + (c.searchSubreddit ? ' in r/' + c.searchSubreddit : '') + ' · ' + sort;
  return c.subreddits.map(s => 'r/' + s).join(', ') + ' · ' + sort;
}
