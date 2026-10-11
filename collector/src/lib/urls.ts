// ── Safe links ────────────────────────────────────────────────────────────────
// Links from collected data are only ever http(s), and "Open on Reddit" links
// only go to Reddit.

const REDDIT_HOST = /^(?:[a-z0-9-]+\.)*(?:reddit\.com|redd\.it)$/i;

export function isRedditHost(hostname: string): boolean {
  return REDDIT_HOST.test(hostname);
}

/** http/https URLs only (anything else, e.g. javascript:, becomes null). */
export function safeHttpUrl(value: string | null | undefined, base?: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
