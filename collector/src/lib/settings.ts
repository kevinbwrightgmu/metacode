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
  /** The way the server's pages reach Reddit unless the user picks another (SCRAPER_DEFAULT_ENGINE). */
  defaultEngine: 'redditapis' | 'browser' | 'server';
  /** The server's network route to Reddit, when it isn't working (null when it is, or unknown). */
  networkProblem: string | null;
}

interface NetworkStatus { label?: string; state?: string; active?: boolean; retryAt?: string | null }

/** A sentence about the server's network route when it isn't working; null when it is. */
export function networkProblemOf(list: NetworkStatus[] | undefined): string | null {
  const active = Array.isArray(list) ? (list.find(p => p && p.active) || list[0]) : null;
  if (!active || !active.state || active.state === 'ok' || active.state === 'degraded') return null;
  if (active.state === 'misconfigured') return 'The server\'s network route to Reddit (' + (active.label || 'unknown') + ') isn\'t configured correctly, so jobs can\'t reach Reddit. Tell the server\'s administrator.';
  const when = active.retryAt ? new Date(active.retryAt) : null;
  return 'The server\'s network route to Reddit (' + (active.label || 'unknown') + ') failed several times in a row, so requests are paused' +
    (when && !isNaN(when.getTime()) ? ' until ' + when.toLocaleTimeString() : '') + '. New jobs may fail until it recovers.';
}

/** Reads /api/scraper/status from the MetaCode server that serves the app. */
export async function fetchServerInfo(fetchFn: typeof fetch = fetch): Promise<ServerInfo> {
  const none = (problem: string): ServerInfo => ({ problem, serverMode: 'public', serverRedditApis: false, defaultEngine: 'redditapis', networkProblem: null });
  try {
    const res = await fetchFn('/api/scraper/status', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) return none(res.status === 404 ? 'This MetaCode server has no scraper (an older version, or SCRAPER_ENABLED=false).' : 'The MetaCode server answered HTTP ' + res.status + '.');
    const j = await res.json() as { enabled?: boolean; mode?: string; defaultEngine?: string; aiScraper?: { available?: boolean; reason?: string | null }; redditApis?: { configured?: boolean }; network?: NetworkStatus[] };
    const problem = j.enabled === false ? 'The Reddit scraper is turned off on this server (SCRAPER_ENABLED=false).'
      : !j.aiScraper ? 'This MetaCode server is from before the AI Scraper. Update it (git pull, then restart).'
      : j.aiScraper.available ? null : (j.aiScraper.reason || 'The AI Scraper isn\'t available on this server.');
    const defaultEngine = j.defaultEngine === 'browser' || j.defaultEngine === 'server' ? j.defaultEngine : 'redditapis';
    return { problem, serverMode: j.mode === 'oauth' ? 'oauth' : 'public', serverRedditApis: !!(j.redditApis && j.redditApis.configured), defaultEngine, networkProblem: networkProblemOf(j.network) };
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

export interface AccessOption {
  value: RedditAccess;
  label: string;
  note: string;
  /** Usable now (RedditAPIs.com needs a key: yours or the server's). */
  ready: boolean;
}

/** The ways this browser's jobs can reach Reddit: RedditAPIs.com first, always offered. */
export function accessOptions(keys: OwnKeys, server: ServerInfo): AccessOption[] {
  const out: AccessOption[] = [];
  const rapiKey = keys.redditapis ? 'your' : server.serverRedditApis ? 'the server\'s' : null;
  out.push(rapiKey
    ? { value: 'redditapis', label: 'RedditAPIs.com (' + rapiKey + ' key, paid per request)', ready: true,
        note: 'A third-party paid service; every request is billed to ' + rapiKey + ' RedditAPIs.com account.' }
    : { value: 'redditapis', label: 'RedditAPIs.com (add your API key)', ready: false,
        note: 'A third-party service that sells Reddit data per request. Add your key on MetaCode\'s Reddit Scraper page → RedditAPIs.com key (it stays in this browser), or choose another way below.' });
  if (keys.reddit) out.push({ value: 'own', label: 'Your Reddit API keys (' + (keys.reddit.hint || 'saved in this browser') + ')', ready: true,
    note: 'Reddit\'s official API with your own limit (about 100 requests a minute). Works even when Reddit blocks the server\'s address.' });
  out.push(server.serverMode === 'oauth'
    ? { value: 'server', label: 'This MetaCode server\'s Reddit API keys', ready: true, note: 'Shared by everyone using this server, so jobs may be slower.' }
    : { value: 'server', label: 'This MetaCode server, without API keys', ready: true, note: 'Public Reddit pages. Reddit often blocks servers this way ("blocked by network security") — add your own Reddit API keys if it does.' });
  return out;
}

// The way to reach Reddit this browser picked last (the New job form remembers it).
export const ACCESS_STORAGE = 'metacode.aiScraper.access';

/** The option the New job form starts on: this browser's last choice, else the server's default (RedditAPIs.com). */
export function initialAccess(options: AccessOption[], server: ServerInfo | null,
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): RedditAccess {
  let saved: string | null = null;
  try { saved = storage ? storage.getItem(ACCESS_STORAGE) : null; } catch { saved = null; }
  if (saved && options.some(o => o.value === saved)) return saved as RedditAccess;
  const want: RedditAccess = !server || server.defaultEngine === 'redditapis' ? 'redditapis' : options.some(o => o.value === 'own') ? 'own' : 'server';
  return options.some(o => o.value === want) ? want : (options[0] ? options[0].value : 'server');
}

export function saveAccess(value: RedditAccess, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { if (storage) storage.setItem(ACCESS_STORAGE, value); } catch { /* private window: not remembered */ }
}
