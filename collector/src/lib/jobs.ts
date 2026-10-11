// ── Describing jobs ───────────────────────────────────────────────────────────
import type { AiJobConfig } from '../types';

/** A job in a few words: the goal (or, for jobs of the earlier bot, what it read). */
export function describeJob(config: AiJobConfig | Record<string, unknown> | null | undefined): string {
  const c = (config || {}) as Record<string, unknown>;
  if (typeof c.goal === 'string' && c.goal) return c.goal.length > 120 ? c.goal.slice(0, 119) + '…' : c.goal;
  // Jobs from the earlier in-browser bot (kept in this browser)
  if (c.targetType === 'search' && typeof c.query === 'string') return 'search "' + c.query + '"' + (c.searchSubreddit ? ' in r/' + c.searchSubreddit : '');
  if (Array.isArray(c.subreddits)) return c.subreddits.map(s => 'r/' + String(s)).join(', ');
  return 'Job';
}

export const ACCESS_LABEL: Record<AiJobConfig['access'], string> = {
  own: 'your Reddit API keys',
  server: 'the MetaCode server',
  redditapis: 'RedditAPIs.com'
};
