// ── Settings: defaults, limits, server information ────────────────────────────
import type { Settings } from '../types';
import { parseRedditBase } from './urls';

export const DEFAULT_SETTINGS: Settings = {
  redditBase: 'https://www.reddit.com',
  pageDelayMs: 3000,
  scrollDelayMs: 1500,
  pageTimeoutMs: 30000,
  maxRetries: 3,
  robotsPolicy: 'obey',
  retentionDays: 0,
  defaultMaxPosts: 50,
  defaultMaxComments: 50,
  exportFormat: 'json',
  csvBom: true
};

/** [min, max] for each number setting. The page delay has a floor so the bot stays slow. */
export const SETTING_LIMITS = {
  pageDelayMs: [1000, 60000],
  scrollDelayMs: [500, 30000],
  pageTimeoutMs: [5000, 120000],
  maxRetries: [0, 6],
  retentionDays: [0, 3650],
  defaultMaxPosts: [1, 1000],
  defaultMaxComments: [0, 500]
} as const;

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Any stored or typed settings → valid settings (out-of-range numbers are clamped). */
export function cleanSettings(input: Partial<Settings> | null | undefined, allowedHosts: string[] = [], minPageDelayMs = 0): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  let base = DEFAULT_SETTINGS.redditBase;
  try { base = parseRedditBase(String(s.redditBase), allowedHosts).origin; } catch { /* keep the default */ }
  const delay = clampInt(s.pageDelayMs, SETTING_LIMITS.pageDelayMs, DEFAULT_SETTINGS.pageDelayMs);
  return {
    redditBase: base,
    pageDelayMs: Math.max(delay, Math.min(SETTING_LIMITS.pageDelayMs[1], minPageDelayMs)),
    scrollDelayMs: clampInt(s.scrollDelayMs, SETTING_LIMITS.scrollDelayMs, DEFAULT_SETTINGS.scrollDelayMs),
    pageTimeoutMs: clampInt(s.pageTimeoutMs, SETTING_LIMITS.pageTimeoutMs, DEFAULT_SETTINGS.pageTimeoutMs),
    maxRetries: clampInt(s.maxRetries, SETTING_LIMITS.maxRetries, DEFAULT_SETTINGS.maxRetries),
    robotsPolicy: s.robotsPolicy === 'warn' ? 'warn' : 'obey',
    retentionDays: clampInt(s.retentionDays, SETTING_LIMITS.retentionDays, 0),
    defaultMaxPosts: clampInt(s.defaultMaxPosts, SETTING_LIMITS.defaultMaxPosts, DEFAULT_SETTINGS.defaultMaxPosts),
    defaultMaxComments: clampInt(s.defaultMaxComments, SETTING_LIMITS.defaultMaxComments, DEFAULT_SETTINGS.defaultMaxComments),
    exportFormat: s.exportFormat === 'jsonl' || s.exportFormat === 'csv' ? s.exportFormat : 'json',
    csvBom: s.csvBom !== false
  };
}

export interface ServerInfo {
  /** Hosts the MetaCode server's proxy allows besides Reddit (e.g. a test mirror). */
  allowedHosts: string[];
  browserEnabled: boolean;
  /** The server's minimum delay between Reddit requests from a browser (ms). */
  minDelayMs: number;
  problem: string | null;
}

/** Reads /api/scraper/status from the MetaCode server that serves the collector. */
export async function fetchServerInfo(fetchFn: typeof fetch = fetch): Promise<ServerInfo> {
  try {
    const res = await fetchFn('/api/scraper/status', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) {
      return { allowedHosts: [], browserEnabled: false, minDelayMs: 0,
        problem: res.status === 404 ? 'This MetaCode server has no scraper (an older version, or SCRAPER_ENABLED=false).' : 'The MetaCode server answered HTTP ' + res.status + '.' };
    }
    const j = await res.json() as { allowedHosts?: unknown; browser?: { enabled?: boolean }; engines?: { browser?: { minDelayMs?: number } } };
    const hosts = Array.isArray(j.allowedHosts) ? j.allowedHosts.filter((h): h is string => typeof h === 'string').map(h => h.toLowerCase()) : [];
    const enabled = !!(j.browser && j.browser.enabled);
    return {
      allowedHosts: hosts,
      browserEnabled: enabled,
      minDelayMs: Number(j.engines?.browser?.minDelayMs) || 0,
      problem: enabled ? null : 'The MetaCode server\'s Reddit browser is turned off (SCRAPER_BROWSER_ENABLED=false), so Scramjet isn\'t available.'
    };
  } catch {
    return { allowedHosts: [], browserEnabled: false, minDelayMs: 0, problem: 'The MetaCode server couldn\'t be reached. Start it with npm start (the collector is served at /collector/).' };
  }
}
