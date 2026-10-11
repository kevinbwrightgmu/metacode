// ── Settings, and what the MetaCode server offers ─────────────────────────────
import type { RedditAccess, Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = {
  retentionDays: 0,
  defaultMaxPosts: 50,
  defaultCommentsPerPost: 0,
  defaultMaxSteps: 25,
  defaultMaxMinutes: 10,
  exportFormat: 'json',
  csvBom: true
};

/** [min, max] for each number setting — the same limits the server applies to AI jobs. */
export const SETTING_LIMITS = {
  retentionDays: [0, 3650],
  defaultMaxPosts: [1, 300],
  defaultCommentsPerPost: [0, 100],
  defaultMaxSteps: [5, 60],
  defaultMaxMinutes: [1, 30]
} as const;

export function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Any stored or typed settings → valid settings (out-of-range numbers are clamped; old settings are dropped). */
export function cleanSettings(input: Partial<Settings> | null | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  const d = DEFAULT_SETTINGS;
  return {
    retentionDays: clampInt(s.retentionDays, SETTING_LIMITS.retentionDays, 0),
    defaultMaxPosts: clampInt(s.defaultMaxPosts, SETTING_LIMITS.defaultMaxPosts, d.defaultMaxPosts),
    defaultCommentsPerPost: clampInt(s.defaultCommentsPerPost, SETTING_LIMITS.defaultCommentsPerPost, d.defaultCommentsPerPost),
    defaultMaxSteps: clampInt(s.defaultMaxSteps, SETTING_LIMITS.defaultMaxSteps, d.defaultMaxSteps),
    defaultMaxMinutes: clampInt(s.defaultMaxMinutes, SETTING_LIMITS.defaultMaxMinutes, d.defaultMaxMinutes),
    exportFormat: s.exportFormat === 'jsonl' || s.exportFormat === 'csv' ? s.exportFormat : 'json',
    csvBom: s.csvBom !== false
  };
}

export interface ServerInfo {
  /** Why AI jobs can't run on this server (no AI key, scraper off…), or null. */
  problem: string | null;
  /** How the server itself reaches Reddit: with its own API keys ("oauth") or public pages. */
  serverMode: 'oauth' | 'public';
  /** The server has its own RedditAPIs.com key. */
  serverRedditApis: boolean;
}

/** Reads /api/scraper/status from the MetaCode server that serves the app. */
export async function fetchServerInfo(fetchFn: typeof fetch = fetch): Promise<ServerInfo> {
  const none = (problem: string): ServerInfo => ({ problem, serverMode: 'public', serverRedditApis: false });
  try {
    const res = await fetchFn('/api/scraper/status', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) return none(res.status === 404 ? 'This MetaCode server has no scraper (an older version, or SCRAPER_ENABLED=false).' : 'The MetaCode server answered HTTP ' + res.status + '.');
    const j = await res.json() as { enabled?: boolean; mode?: string; aiScraper?: { available?: boolean; reason?: string | null }; redditApis?: { configured?: boolean } };
    const problem = j.enabled === false ? 'The Reddit scraper is turned off on this server (SCRAPER_ENABLED=false).'
      : !j.aiScraper ? 'This MetaCode server is from before the AI Scraper. Update it (git pull, then restart).'
      : j.aiScraper.available ? null : (j.aiScraper.reason || 'The AI Scraper isn\'t available on this server.');
    return { problem, serverMode: j.mode === 'oauth' ? 'oauth' : 'public', serverRedditApis: !!(j.redditApis && j.redditApis.configured) };
  } catch {
    return none('The MetaCode server couldn\'t be reached. Start it with npm start (this app is served at /collector/).');
  }
}

// ── Your own API keys ─────────────────────────────────────────────────────────
// Added on MetaCode's Reddit Scraper page (Reddit API access) and kept in this
// browser only (same origin, so this app sees them too). They're sent with
// your jobs and never stored on the server.
export const OWN_KEYS_STORAGE = 'metacode.scraper.ownKeys';

export interface OwnKeys {
  reddit: { clientId: string; clientSecret: string; username: string | null; hint: string } | null;
  redditapis: { key: string; hint: string } | null;
}

export function readOwnKeys(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): OwnKeys {
  let raw: unknown = null;
  try { raw = storage ? JSON.parse(storage.getItem(OWN_KEYS_STORAGE) || 'null') : null; } catch { raw = null; }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const r = o.reddit, k = o.redditapis;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    reddit: r && text(r.clientId) && text(r.clientSecret)
      ? { clientId: text(r.clientId), clientSecret: text(r.clientSecret), username: text(r.username) || null, hint: text(r.hint) } : null,
    redditapis: k && text(k.key) ? { key: text(k.key), hint: text(k.hint) } : null
  };
}

export interface AccessOption { value: RedditAccess; label: string; note: string }

/** The ways this browser's jobs can reach Reddit, best first. */
export function accessOptions(keys: OwnKeys, server: ServerInfo): AccessOption[] {
  const out: AccessOption[] = [];
  if (keys.reddit) out.push({ value: 'own', label: 'Your Reddit API keys (' + (keys.reddit.hint || 'saved in this browser') + ')',
    note: 'Reddit\'s official API with your own limit (about 100 requests a minute). Works even when Reddit blocks the server\'s address.' });
  if (keys.redditapis || server.serverRedditApis) out.push({ value: 'redditapis', label: 'RedditAPIs.com (' + (keys.redditapis ? 'your key' : 'the server\'s key') + ', paid per request)',
    note: 'A third-party paid service; every request is billed to ' + (keys.redditapis ? 'your' : 'the server\'s') + ' RedditAPIs.com account.' });
  out.push(server.serverMode === 'oauth'
    ? { value: 'server', label: 'This MetaCode server\'s Reddit API keys', note: 'Shared by everyone using this server, so jobs may be slower.' }
    : { value: 'server', label: 'This MetaCode server, without API keys', note: 'Public Reddit pages. Reddit often blocks servers this way ("blocked by network security") — add your own Reddit API keys if it does.' });
  return out;
}
