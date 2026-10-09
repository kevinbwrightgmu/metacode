// ── robots.txt (RFC 9309) ─────────────────────────────────────────────────────
// Read before every job: the group matching our product token (or "*"), the
// longest matching rule wins, Allow wins a tie, "*" and "$" wildcards.
// A missing robots.txt (4xx) means no restrictions; an unreadable one (5xx,
// network failure) is treated as "disallow everything" until it can be read.

export interface RobotsGroup { agents: string[]; rules: { allow: boolean; path: string }[] }

/** The token the collector identifies as when matching robots.txt groups. */
export const ROBOTS_TOKEN = 'metacode-reddit-collector';

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current && (field === 'allow' || field === 'disallow')) current.rules.push({ allow: field === 'allow', path: value });
  }
  return groups;
}

function ruleMatches(rulePath: string, path: string): boolean {
  if (rulePath === '') return false;
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  let pattern = '';
  for (const ch of body) pattern += ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + pattern + (anchored ? '$' : '')).test(path);
}

export function isAllowed(groups: RobotsGroup[], token: string, pathWithQuery: string): { allowed: boolean; rule: string | null } {
  const t = token.toLowerCase();
  const specific = groups.filter(g => g.agents.some(a => a && a !== '*' && t.includes(a)));
  const chosen = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  let best: { len: number; allow: boolean; path: string } | null = null;
  for (const r of chosen.flatMap(g => g.rules)) {
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    const len = r.path.replace(/\$$/, '').length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, path: r.path };
  }
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: (best.allow ? 'Allow: ' : 'Disallow: ') + best.path };
}
