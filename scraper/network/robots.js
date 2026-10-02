// ── robots.txt ────────────────────────────────────────────────────────────────
// Without Reddit API credentials the scraper reads Reddit's public pages, so
// it follows the site's robots.txt (RFC 9309): the group matching our
// User-Agent (or "*"), longest matching rule wins, Allow wins a tie, "*" and
// "$" wildcards. A 4xx robots.txt means "no restrictions"; an unreachable one
// or a 5xx means "assume everything is disallowed" until it can be read.

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  String(text || '').split(/\r\n|\r|\n/).forEach(rawLine => {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const colon = line.indexOf(':');
    if (colon === -1) return;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (!current) return;
    if (field === 'allow' || field === 'disallow') {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  });
  return groups;
}

// The product token RFC 9309 matches on: the User-Agent's first word,
// e.g. "nodejs:metacode-reddit-scraper:1.0 (…)" → "nodejs:metacode-reddit-scraper:1.0".
function productToken(userAgent) {
  return String(userAgent || '').trim().split(/[\s/]/)[0].toLowerCase();
}

function selectRules(groups, userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  const token = productToken(userAgent);
  const specific = groups.filter(g => g.agents.some(a => a && a !== '*' && (ua.includes(a) || token.includes(a))));
  const chosen = specific.length ? specific : groups.filter(g => g.agents.includes('*'));
  return chosen.reduce((rules, g) => rules.concat(g.rules), []);
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false;
  let pattern = '';
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  for (const ch of body) pattern += ch === '*' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + pattern + (anchored ? '$' : '')).test(path);
}

// → { allowed: boolean, rule: string|null }
function isAllowed(groups, userAgent, pathWithQuery) {
  const rules = selectRules(groups, userAgent);
  let best = null;
  rules.forEach(r => {
    if (!ruleMatches(r.path, pathWithQuery)) return;
    const len = r.path.replace(/\$$/, '').length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, path: r.path };
  });
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: (best.allow ? 'Allow: ' : 'Disallow: ') + best.path };
}

module.exports = { parseRobots, isAllowed, productToken };
