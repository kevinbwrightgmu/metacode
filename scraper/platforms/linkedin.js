// @ts-check
// ── LinkedIn, through LinkedIn's official REST API and members' data archives ─
// LinkedIn has no API for reading just anyone's profile or posts. What it does
// offer, and what a LinkedIn job collects:
//
//   pages     the LinkedIn Pages the token's member helps manage
//             (organizationAcls), with names and follower counts
//   posts     a Page's posts (Posts API) with their reactions and comment
//             counts (socialMetadata), optionally impressions, clicks and
//             reposts (organizationalEntityShareStatistics) and comments
//             (socialActions). Needs an access token from a LinkedIn developer
//             app that has the Community Management API, for a member who is
//             an admin of the Page (scope r_organization_social; statistics
//             also rw_organization_admin or r_organization_admin).
//   archive   the member's own posts, comments, reactions and reposts from
//             LinkedIn's "Get a copy of your data" archive, uploaded from the
//             browser. Nothing is requested from LinkedIn.
//
// Requests are made the way LinkedIn's own client library does them
// (github.com/linkedin-developers/linkedin-api-js-client): the versioned base
// URL /rest, a LinkedIn-Version header (YYYYMM), Rest.li protocol 2.0.0 and its
// URN encoding. LinkedIn retires API versions after about a year, so when a
// version isn't active the job steps back a month at a time (a few tries).
//
// Scrapers that log in to linkedin.com with a member's session (a password or
// the li_at cookie) and read its pages aren't how MetaCode reads LinkedIn: its
// User Agreement forbids it, its robots.txt disallows it, it answers them with
// login and bot checks, and it restricts the accounts used.

const crypto = require('crypto');
const { ScraperError, cancelledError } = require('../errors');

const ORG_ID_RE = /^\d{1,20}$/;
const VANITY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REACTION_NAMES = /** @type {Record<string, string>} */ ({
  LIKE: 'Like', PRAISE: 'Celebrate', EMPATHY: 'Love', INTEREST: 'Insightful', APPRECIATION: 'Support', ENTERTAINMENT: 'Funny', MAYBE: 'Curious', REPOST: 'Repost'
});
const VERSION_TRIES = 6;                       // months to step back when a version isn't active
const MAX_ARCHIVE_CHARS = 8 * 1024 * 1024;     // under the server's 10 MB request limit
const MAX_ARCHIVE_ROWS = 200000;

const invalid = /** @param {string} m */ m => new ScraperError('invalid_request', m, { status: 400 });

/* ── Rest.li ─────────────────────────────────────── */

// One value encoded as LinkedIn's client encodes it: URL encoding, plus
// Rest.li's own reserved characters ( ) ' (encodeURIComponent already
// encodes , and :).
/** @param {string | number} v */
const enc = v => encodeURIComponent(String(v)).replace(/[()']/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** @param {(string | number)[]} vs */
const restliList = vs => 'List(' + vs.map(enc).join(',') + ')';

/** The API version `monthsBack` months before `now`, as YYYYMM. @param {number} now @param {number} monthsBack */
function versionFor(now, monthsBack) {
  const d = new Date(now);
  const m = d.getUTCFullYear() * 12 + d.getUTCMonth() - monthsBack;
  return String(Math.floor(m / 12)) + String((m % 12) + 1).padStart(2, '0');
}

/* ── Targets ─────────────────────────────────────── */

/**
 * A LinkedIn Page from its address, vanity name, numeric ID or URN.
 * @param {unknown} raw
 * @returns {{ by: 'id' | 'vanity', value: string } | null}
 */
function parseOrganization(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return null;
  let m = s.match(/^urn:li:organization(?:Brand)?:(\d{1,20})$/i);
  if (m) return { by: 'id', value: m[1] };
  if (ORG_ID_RE.test(s)) return { by: 'id', value: s };
  m = s.match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.|www\.)?linkedin\.com\/(?:company|showcase|school)\/([^/?#\s]+)/i);
  if (m) {
    let seg = m[1];
    try { seg = decodeURIComponent(seg); } catch (e) { /* keep it as it is */ }
    if (ORG_ID_RE.test(seg)) return { by: 'id', value: seg };
    return VANITY_RE.test(seg) ? { by: 'vanity', value: seg.toLowerCase() } : null;
  }
  if (/[/:]/.test(s) || /linkedin\.com/i.test(s)) return null;
  return VANITY_RE.test(s) ? { by: 'vanity', value: s.toLowerCase() } : null;
}

/** @param {any} t */
function normalizeLinkedInTarget(t) {
  if (!t || typeof t !== 'object') throw invalid('Choose what to collect from LinkedIn.');
  const type = String(t.type || '');
  if (type === 'pages') return { platform: 'linkedin', type, label: 'LinkedIn · Pages you manage' };
  if (type === 'posts') {
    const org = parseOrganization(t.organization);
    if (!org) throw invalid('Enter a LinkedIn Page: its address (linkedin.com/company/…), its vanity name or its numeric ID.');
    return { platform: 'linkedin', type, organization: org, sortBy: t.sortBy === 'LAST_MODIFIED' ? 'LAST_MODIFIED' : 'CREATED',
      label: 'LinkedIn · ' + (org.by === 'id' ? 'Page ' + org.value : '/company/' + org.value) };
  }
  throw invalid('LinkedIn jobs collect the Pages you manage, a Page\'s posts or your LinkedIn data archive.');
}

/** @param {unknown} v @param {number} fallback @param {number} min @param {number} max @param {string} what */
function whole(v, fallback, min, max, what) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(what + ' must be a whole number from ' + min.toLocaleString('en-US') + ' to ' + max.toLocaleString('en-US') + '.');
  return n;
}

/** @param {any} o @param {Record<string, any>} target */
function normalizeLinkedInOptions(o, target) {
  o = o && typeof o === 'object' ? o : {};
  if (target.type === 'pages') return { maxPosts: 0, includeComments: false, commentPosts: 0, commentsPerPost: 0, includeStats: false };
  const maxPosts = whole(o.maxPosts, 100, 1, 5000, 'Posts');
  const includeComments = o.includeComments === true;
  return {
    maxPosts,
    includeComments,
    commentPosts: includeComments ? Math.min(maxPosts, whole(o.commentPosts, 20, 1, 500, '"Of the first … posts"')) : 0,
    commentsPerPost: includeComments ? whole(o.commentsPerPost, 100, 1, 1000, 'Comments per post') : 0,
    includeStats: o.includeStats === true
  };
}

/** How many records a job may hold. @param {Record<string, any>} target @param {ReturnType<typeof normalizeLinkedInOptions>} o */
function linkedinCapacity(target, o) {
  if (target.type === 'pages') return 1000;
  return 1 + o.maxPosts + o.commentPosts * o.commentsPerPost;
}

/* ── Text ────────────────────────────────────────── */

// Post commentary is in LinkedIn's "little text" format: hashtags as
// {hashtag|\#|tag}, mentions as @[Name](urn:li:…), reserved characters
// escaped with a backslash. → plain text.
/** @param {unknown} s */
function plainText(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\{hashtag\|\\?#\|([^}]*)\}/g, '#$1')
    .replace(/@\[([^\]]*)\]\(urn:li:[^)]*\)/g, '@$1')
    .replace(/\\([\\|{}@[\]()<>#*_~])/g, '$1');
}

/** A LinkedIn localized value (a string, or { localized: { en_US: … } }). @param {...any} vs */
function localized(...vs) {
  for (const v of vs) {
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object' && v.localized && typeof v.localized === 'object') {
      const first = Object.values(v.localized).find(x => typeof x === 'string' && x);
      if (first) return /** @type {string} */ (first);
    }
  }
  return null;
}

/** @param {unknown} v */
const num = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** @param {unknown} ms */
const isoOf = ms => (num(ms) === null ? null : new Date(Number(ms)).toISOString());
/** @param {unknown} ms */
const utcOf = ms => (num(ms) === null ? null : Math.floor(Number(ms) / 1000));
/** @param {string} s */
const shortHash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/* ── Records from the API ────────────────────────── */

/**
 * @param {any} org an organization from the Organizations API (or just { id })
 * @param {{ followers?: number | null, roles?: string[] }} extra
 */
function pageRecord(org, extra) {
  const id = String(org.id);
  const vanity = org.vanityName ? String(org.vanityName) : null;
  const url = 'https://www.linkedin.com/company/' + (vanity || id) + '/';
  return {
    record_type: 'page', platform: 'linkedin', fullname: 'li:page:' + id,
    page_id: id, urn: 'urn:li:organization:' + id,
    name: localized(org.localizedName, org.name), vanity_name: vanity,
    website: localized(org.localizedWebsite, org.website),
    description: localized(org.localizedDescription, org.description),
    follower_count: extra.followers === undefined ? null : extra.followers,
    roles: extra.roles && extra.roles.length ? extra.roles.join(', ') : null,
    created_at: null, created_utc: null,
    url, permalink: url
  };
}

/** Reaction totals from socialMetadata. @param {any} meta */
function reactionsOf(meta) {
  const sums = meta && meta.reactionSummaries && typeof meta.reactionSummaries === 'object' ? meta.reactionSummaries : null;
  if (!sums) return null;
  /** @type {[string, number][]} */
  const parts = Object.entries(sums).map(([k, v]) => [k, num(v && v.count) || 0]);
  const by = /** @type {Record<string, number>} */ (Object.fromEntries(parts));
  return {
    total: parts.reduce((a, [, n]) => a + n, 0),
    like: by.LIKE === undefined ? 0 : by.LIKE,
    breakdown: parts.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => (REACTION_NAMES[k] || k) + ' ' + n).join(', ') || null
  };
}

/**
 * @param {any} p a post from the Posts API
 * @param {string | null} pageName
 * @param {any} [meta] its socialMetadata
 * @param {any} [stats] its totalShareStatistics
 */
function postRecord(p, pageName, meta, stats) {
  const urn = String(p.id);
  const c = p.content && typeof p.content === 'object' ? p.content : {};
  const article = c.article || null;
  const poll = c.poll || null;
  const text = plainText(p.commentary);
  const contentType = article ? 'article' : c.multiImage ? 'images' : c.carousel ? 'carousel' : c.media ? 'media' : poll ? 'poll' : c.celebration ? 'celebration' : p.reshareContext ? 'repost' : 'text';
  const pollOptions = poll && Array.isArray(poll.options) ? poll.options.map(/** @param {any} x */ x => x && x.text).filter(Boolean).join(' | ') : null;
  const rx = reactionsOf(meta);
  const st = stats || {};
  const t = num(p.publishedAt) !== null ? p.publishedAt : p.createdAt;
  const url = 'https://www.linkedin.com/feed/update/' + urn + '/';
  const fullText = [text, article && article.title, article && article.source, poll && poll.question ? 'Poll: ' + poll.question + (pollOptions ? ' (' + pollOptions + ')' : '') : null].filter(Boolean).join('\n\n');
  return {
    record_type: 'post', platform: 'linkedin', fullname: 'li:post:' + urn,
    post_id: urn, title: null,
    author: pageName || (p.author ? String(p.author) : null), author_id: p.author ? String(p.author) : null,
    created_at: isoOf(t), created_utc: utcOf(t), last_modified_at: isoOf(p.lastModifiedAt),
    selftext: text, full_text: fullText || text,
    content_type: contentType,
    article_url: article && article.source ? String(article.source) : null, article_title: article && article.title ? String(article.title) : null,
    poll_question: poll && poll.question ? String(poll.question) : null, poll_options: pollOptions,
    media_id: c.media && c.media.id ? String(c.media.id) : null,
    visibility: p.visibility ? String(p.visibility) : null, lifecycle_state: p.lifecycleState ? String(p.lifecycleState) : null,
    is_repost: !!p.reshareContext, reshare_of: p.reshareContext && p.reshareContext.parent ? String(p.reshareContext.parent) : null,
    score: rx ? rx.total : null, reaction_count: rx ? rx.total : null, like_count: rx ? rx.like : null, reactions: rx ? rx.breakdown : null,
    num_comments: meta && meta.commentSummary ? num(meta.commentSummary.count) : null,
    comments_state: meta && meta.commentsState ? String(meta.commentsState) : null,
    impression_count: num(st.impressionCount), unique_impressions: num(st.uniqueImpressionsCount), click_count: num(st.clickCount),
    share_count: num(st.shareCount), engagement_rate: num(st.engagement), view_count: num(st.impressionCount),
    url, permalink: url
  };
}

/**
 * @param {any} cm a comment from socialActions/{urn}/comments
 * @param {string} postUrn
 * @param {string} pageUrn @param {string | null} pageName
 */
function commentRecord(cm, postUrn, pageUrn, pageName) {
  const id = String(cm.id || (cm.commentUrn ? String(cm.commentUrn).replace(/^.*,(\d+)\)$/, '$1') : shortHash(JSON.stringify(cm))));
  const actor = cm.actor ? String(cm.actor) : (cm.created && cm.created.actor ? String(cm.created.actor) : null);
  const byPage = !!actor && actor === pageUrn;
  const likes = cm.likesSummary || {};
  const replies = cm.commentsSummary || {};
  const t = cm.created && cm.created.time;
  const url = 'https://www.linkedin.com/feed/update/' + postUrn + '/';
  return {
    record_type: 'comment', platform: 'linkedin', fullname: 'li:comment:' + (cm.commentUrn ? String(cm.commentUrn) : postUrn + ':' + id),
    comment_id: id, comment_urn: cm.commentUrn ? String(cm.commentUrn) : null,
    post_id: postUrn, parent_id: cm.parentComment ? String(cm.parentComment) : null,
    author: byPage ? (pageName || actor) : actor, author_id: actor, author_is_page: byPage,
    body: cm.message && typeof cm.message.text === 'string' ? cm.message.text : '',
    created_at: isoOf(t), created_utc: utcOf(t),
    score: num(likes.totalLikes !== undefined ? likes.totalLikes : likes.aggregatedTotalLikes),
    num_replies: num(replies.aggregatedTotalComments !== undefined ? replies.aggregatedTotalComments : replies.totalFirstLevelComments),
    depth: cm.parentComment ? 1 : 0,
    url, permalink: url
  };
}

/* ── The data archive ────────────────────────────── */

const ARCHIVE_FILES = /** @type {Record<string, string>} */ ({
  'shares.csv': 'shares', 'comments.csv': 'comments', 'reactions.csv': 'reactions', 'instantreposts.csv': 'reposts', 'profile.csv': 'profile'
});

/** Which archive table a file is, from its name. @param {unknown} name */
function archiveKind(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  return ARCHIVE_FILES[base.toLowerCase()] || null;
}

/** RFC 4180 CSV → rows. Quoted fields may hold commas, quotes ("") and line breaks. @param {string} text */
function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '', quoted = false, startOfField = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"' && startOfField) { quoted = true; startOfField = false; }
    else if (c === ',') { row.push(field); field = ''; startOfField = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; startOfField = true;
      if (rows.length > MAX_ARCHIVE_ROWS) throw invalid('That archive file has more than ' + MAX_ARCHIVE_ROWS.toLocaleString('en-US') + ' rows.');
    } else { field += c; startOfField = false; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rows as objects keyed by lower-case column name, under the first row that
// has every needed column (LinkedIn puts notes above some tables).
/** @param {string} text @param {string[]} need */
function tableOf(text, need) {
  const rows = parseCsv(text);
  const h = rows.findIndex(r => need.every(n => r.some(c => c.trim().toLowerCase() === n)));
  if (h < 0) return null;
  const header = rows[h].map(c => c.trim().toLowerCase());
  return rows.slice(h + 1).filter(r => r.some(c => c.trim()))
    .map(r => /** @type {Record<string, string>} */ (Object.fromEntries(header.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))));
}

/** An archive date ("2024-03-05 14:22:31", UTC) → ms. @param {unknown} v */
function archiveTime(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const t = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) ? Date.parse(s.replace(' ', 'T') + 'Z') : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const URN_TYPES = /** @type {Record<string, string>} */ ({ activity: 'activity', share: 'share', ugcpost: 'ugcPost' });
/** The post (and comment) a LinkedIn link points to. @param {unknown} link */
function linkUrns(link) {
  let s = String(link || '');
  try { s = decodeURIComponent(s); } catch (e) { /* keep it as it is */ }
  const post = s.match(/urn:li:(activity|share|ugcPost):(\d{1,25})/i);
  const comment = s.match(/urn:li:comment:\((?:urn:li:)?(?:activity|ugcPost|share):\d{1,25},(\d{1,25})\)/i);
  return { post: post ? 'urn:li:' + URN_TYPES[post[1].toLowerCase()] + ':' + post[2] : null, comment: comment ? comment[1] : null };
}

/** A web link from the archive, or null (only http(s) links are kept). @param {unknown} v */
function webLink(v) {
  const s = String(v || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) && s.length <= 2000 ? s : null;
}

/** @param {unknown} v @param {string} what */
function dayBound(v, what) {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t) || t < Date.UTC(2003, 0, 1) || t > Date.now() + 86400000) throw invalid(what + ' must be a date between 2003 and today.');
  return t;
}

/**
 * An uploaded archive (its CSV files' text) → the job's target and records.
 * Only the needed tables are read; Profile.csv gives the author's name and
 * nothing else from it is kept.
 * @param {any} t     { type: 'archive', files: [{ name, text }] }
 * @param {any} o     { posts, comments, reactions, since, until }
 */
function parseArchive(t, o) {
  o = o && typeof o === 'object' ? o : {};
  const files = Array.isArray(t && t.files) ? t.files : [];
  if (!files.length) throw invalid('Choose your LinkedIn data archive (the .zip LinkedIn emailed you) or its CSV files.');
  /** @type {Record<string, string>} */
  const texts = {};
  let chars = 0;
  for (const f of files) {
    const kind = f && archiveKind(f.name);
    if (!kind || typeof f.text !== 'string') continue;
    chars += f.text.length;
    if (chars > MAX_ARCHIVE_CHARS) throw invalid('These files are too large to import at once (over 8 MB of text). Import posts, comments and reactions separately, or choose a date range.');
    texts[kind] = f.text;
  }
  const want = { posts: o.posts !== false, comments: o.comments !== false, reactions: o.reactions === true };
  if (!want.posts && !want.comments && !want.reactions) throw invalid('Choose what to import: posts, comments or reactions.');
  const since = dayBound(o.since, '"From"'), untilDay = dayBound(o.until, '"Until"');
  const until = untilDay === null ? null : untilDay + 86400000 - 1;
  if (since !== null && until !== null && since > until) throw invalid('"From" must be earlier than "Until".');
  const inRange = /** @param {number | null} ms */ ms => ms === null || ((since === null || ms >= since) && (until === null || ms <= until));

  let owner = null;
  if (texts.profile) {
    const p = (tableOf(texts.profile, ['first name', 'last name']) || [])[0];
    if (p) owner = ((p['first name'] || '').trim() + ' ' + (p['last name'] || '').trim()).trim() || null;
  }
  /** @type {Record<string, unknown>[]} */
  const records = [];
  const counts = { posts: 0, comments: 0, reactions: 0, outOfRange: 0 };
  const base = { platform: 'linkedin', source: 'archive', author: owner, author_name: owner };
  /** @param {number | null} ms */
  const when = ms => ({ created_at: isoOf(ms), created_utc: utcOf(ms) });

  if (want.posts && texts.shares) {
    for (const r of tableOf(texts.shares, ['date', 'sharecommentary']) || tableOf(texts.shares, ['date', 'sharelink']) || []) {
      const ms = archiveTime(r.date);
      if (!inRange(ms)) { counts.outOfRange++; continue; }
      const link = webLink(r.sharelink);
      const text = (r.sharecommentary || '').replace(/\r\n/g, '\n').trim();
      const shared = webLink(r.sharedurl);
      const id = linkUrns(link).post || 'archive:' + shortHash((r.date || '') + '\n' + text + '\n' + (shared || ''));
      records.push(Object.assign({ record_type: 'post', fullname: 'li:post:' + id, post_id: id, title: null }, base, when(ms), {
        selftext: text, full_text: [text, shared].filter(Boolean).join('\n\n'),
        shared_url: shared, media_url: webLink(r.mediaurl), visibility: (r.visibility || '').trim() || null,
        score: null, num_comments: null, url: link, permalink: link
      }));
      counts.posts++;
    }
  }
  if (want.comments && texts.comments) {
    for (const r of tableOf(texts.comments, ['date', 'message']) || []) {
      const ms = archiveTime(r.date);
      if (!inRange(ms)) { counts.outOfRange++; continue; }
      const link = webLink(r.link);
      const u = linkUrns(link);
      const body = (r.message || '').replace(/\r\n/g, '\n').trim();
      const id = u.comment || 'archive:' + shortHash((r.date || '') + '\n' + (link || '') + '\n' + body);
      records.push(Object.assign({ record_type: 'comment', fullname: 'li:comment:' + id, comment_id: id, post_id: u.post, parent_id: null }, base, when(ms), {
        body, score: null, depth: 0, url: link, permalink: link
      }));
      counts.comments++;
    }
  }
  if (want.reactions) {
    /** @type {[string | undefined, string[], (r: Record<string, string>) => string][]} */
    const tables = [[texts.reactions, ['date', 'type', 'link'], r => (r.type || '').trim().toUpperCase() || 'LIKE'], [texts.reposts, ['date', 'link'], () => 'REPOST']];
    for (const [text, need, typeOf] of tables) {
      if (!text) continue;
      for (const r of tableOf(text, need) || []) {
        const ms = archiveTime(r.date);
        if (!inRange(ms)) { counts.outOfRange++; continue; }
        const link = webLink(r.link);
        const type = typeOf(r);
        records.push(Object.assign({ record_type: 'reaction', fullname: 'li:reaction:' + shortHash(type + '\n' + (r.date || '') + '\n' + (link || '')) }, base, when(ms), {
          reaction_type: type, reaction: REACTION_NAMES[type] || type, post_id: linkUrns(link).post, url: link, permalink: link
        }));
        counts.reactions++;
      }
    }
  }
  const found = Object.keys(texts).filter(k => k !== 'profile');
  if (!records.length) {
    throw invalid(!found.length
      ? 'None of LinkedIn\'s posts, comments or reactions files is in what you chose (Shares.csv, Comments.csv, Reactions.csv, InstantReposts.csv). Request the archive with Posts, Comments and Reactions included.'
      : counts.outOfRange ? 'Nothing in the archive falls between the dates you chose.' : 'The archive has nothing of the kinds you chose to import.');
  }
  const target = {
    platform: 'linkedin', type: 'archive', files: found.map(k => ({ shares: 'Shares.csv', comments: 'Comments.csv', reactions: 'Reactions.csv', reposts: 'InstantReposts.csv' })[k]),
    owner, counts, label: 'LinkedIn · your data archive' + (owner ? ' (' + owner + ')' : '')
  };
  return { target, records, options: { kinds: want, since: since === null ? null : new Date(since).toISOString().slice(0, 10), until: untilDay === null ? null : new Date(untilDay).toISOString().slice(0, 10) } };
}

/* ── Errors ──────────────────────────────────────── */

/** @param {number} status @param {any} json */
function classifyLinkedIn(status, json) {
  const j = json || {};
  const code = String(j.code || '');
  const service = num(j.serviceErrorCode);
  const said = String(j.message || '').replace(/\s+/g, ' ').slice(0, 300);
  if (status === 426 || code === 'NONEXISTENT_VERSION' || code === 'VERSION_MISSING' || /\bversion\b.*\b(not active|does not exist|isn't active|deprecated|sunset)/i.test(said)) {
    return new ScraperError('version_unsupported', 'LinkedIn doesn\'t serve that API version (' + (said || 'HTTP ' + status) + ').', { status: 502 });
  }
  if (status === 401) {
    const expired = code === 'EXPIRED_ACCESS_TOKEN' || service === 65601;
    const revoked = code === 'REVOKED_ACCESS_TOKEN' || service === 65602;
    return new ScraperError('auth_error', expired
      ? 'The LinkedIn access token has expired (they last 60 days). Make a new one in the LinkedIn Developer Portal (your app → Auth → OAuth 2.0 tools) and add it again.'
      : revoked ? 'The LinkedIn access token was revoked. Make a new one in the LinkedIn Developer Portal and add it again.'
        : 'LinkedIn didn\'t accept the access token (HTTP 401). Check that you copied the whole token.', { status: 401 });
  }
  if (status === 403) {
    return new ScraperError('forbidden', 'LinkedIn refused this request' + (said ? ' (LinkedIn: ' + said + ')' : '') + '. Reading a Page\'s posts needs a token from an app with the Community Management API, the r_organization_social scope, and a member who is an admin of the Page.', { status: 403 });
  }
  if (status === 404) return new ScraperError('not_found', 'LinkedIn doesn\'t have that' + (said ? ' (' + said + ')' : '') + '.', { status: 404 });
  if (status === 400 || status === 422) return new ScraperError('invalid_request', 'LinkedIn didn\'t accept the request' + (said ? ': ' + said : '.'), { status: 400 });
  if (status === 429) return new ScraperError('rate_limited', 'LinkedIn\'s request limit for this app or member is reached (HTTP 429). Its daily limits reset at midnight UTC.', { status: 429, retryable: true });
  return null;
}

/* ── The runner ──────────────────────────────────── */

// Whether a collection has more after this page: LinkedIn's paging block
// (a "next" link, or the total) when it sends one, else a full page.
/** @param {any} r @param {number} got @param {number} count @param {number} nextStart */
function hasMore(r, got, count, nextStart) {
  if (!got) return false;
  const p = r && r.paging && typeof r.paging === 'object' ? r.paging : {};
  if (Array.isArray(p.links) && p.links.length) return p.links.some(/** @param {any} l */ l => l && l.rel === 'next');
  const total = num(p.total);
  if (total !== null) return nextStart < total;
  return got >= count;
}

/**
 * @param {object} deps
 * @param {import('./http').PlatformHttp} deps.http
 * @param {ReturnType<typeof import('./config').platformConfig>['linkedin']} deps.config
 * @param {() => number} [deps.now]
 */
function createLinkedInRunner(deps) {
  const now = deps.now || Date.now;
  const versions = { working: /** @type {string | null} */ (null) };     // the API version that last worked, for later jobs

  /** An archive import: the records parsed from the upload, kept in memory only. @param {any} job @param {any} ctx */
  async function runArchive(job, ctx) {
    const recs = ctx.http && Array.isArray(ctx.http.linkedinArchive) ? ctx.http.linkedinArchive : null;
    if (!recs) throw new ScraperError('invalid_request', 'The uploaded archive isn\'t kept on the server, and this import was interrupted. Start a new import from Scraper → LinkedIn.', { status: 400 });
    const state = Object.assign({ v: 1, done: 0 }, ctx.resumeFrom || {});
    while (state.done < recs.length && ctx.remaining() > 0) {
      if (ctx.signal && ctx.signal.aborted) throw ctx.signal.reason || cancelledError();
      const batch = recs.slice(state.done, state.done + Math.min(500, ctx.remaining()));
      ctx.progress({ message: 'Importing your LinkedIn data (' + state.done.toLocaleString('en-US') + ' of ' + recs.length.toLocaleString('en-US') + ')…', pagesDelta: 1 });
      ctx.emit(batch);
      state.done += batch.length;
      ctx.checkpoint(Object.assign({}, state));
      await new Promise(r => setImmediate(r));
    }
    const c = job.target.counts || {};
    const what = [c.posts && c.posts + ' posts', c.comments && c.comments + ' comments', c.reactions && c.reactions + ' reactions and reposts'].filter(Boolean).join(', ');
    if (state.done < recs.length) ctx.log('warn', 'The archive has ' + what + '; ' + (recs.length - state.done).toLocaleString('en-US') + ' of them didn\'t fit in this job\'s limit and were left out.');
    else ctx.log('info', 'Imported ' + what + ' from the archive.');
  }

  /** @param {any} job @param {any} ctx */
  return async function runLinkedIn(job, ctx) {
    const target = job.target, o = job.options.linkedin;
    if (target.type === 'archive') return runArchive(job, ctx);
    const own = job.keySource === 'own';
    const token = own ? ctx.http && ctx.http.linkedinToken : deps.config.accessToken;
    if (!token) throw new ScraperError(own ? 'auth_error' : 'not_available', own ? 'This job used your own LinkedIn access token, which isn\'t kept on the server. Add it again on the Scraper page and press Resume.' : 'No LinkedIn access token is set on this server (LINKEDIN_ACCESS_TOKEN). Add your own on the Scraper page.', { status: 400 });
    const scope = own ? 'own:' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 12) : 'server';
    const auto = Array.from({ length: VERSION_TRIES }, (_, i) => versionFor(now(), i + 1));
    const candidates = Array.from(new Set([deps.config.apiVersion, versions.working].concat(auto).filter(Boolean)));
    let vi = 0;

    /**
     * One request. `params` values are already Rest.li-encoded.
     * @param {string} path @param {Record<string, string | number | null | undefined>} params @param {string} method
     */
    async function api(path, params, method) {
      const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => k + '=' + v).join('&');
      for (;;) {
        const version = /** @type {string} */ (candidates[vi]);
        try {
          const r = await deps.http.getJson(deps.config.baseUrl + path + (qs ? '?' + qs : ''), {
            signal: ctx.signal, label: 'LinkedIn', delayMs: deps.config.minDelayMs, retries: job.options.retries, timeoutMs: job.options.timeoutMs,
            headers: { authorization: 'Bearer ' + token, 'linkedin-version': version, 'x-restli-protocol-version': '2.0.0', 'x-restli-method': method },
            limitKey: new URL(deps.config.baseUrl).host + '#' + scope, log: ctx.log, onRequest: ctx.requestOpts.onRequest, classify: classifyLinkedIn
          });
          versions.working = version;
          return r.json;
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (e && e.type === 'version_unsupported') {
            if (vi + 1 < candidates.length) {
              ctx.log('info', 'LinkedIn doesn\'t serve API version ' + version + '; trying ' + candidates[vi + 1] + '.');
              vi++;
              continue;
            }
            throw new ScraperError('version_unsupported', 'LinkedIn didn\'t accept any recent API version (tried ' + candidates.join(', ') + '). Set LINKEDIN_API_VERSION in .env to a version LinkedIn lists as active (YYYYMM).', { status: 502 });
          }
          throw err;
        }
      }
    }

    /** @param {unknown} err */
    const refused = err => { const t = err && /** @type {any} */ (err).type; return t === 'forbidden' || t === 'not_found' || t === 'invalid_request'; };
    // Batch results are keyed by entity key, which may arrive URL-encoded
    /** @param {any} results */
    const keyed = results => {
      /** @type {Record<string, any>} */
      const out = {};
      Object.entries(results && typeof results === 'object' ? results : {}).forEach(([k, v]) => { let key = k; try { key = decodeURIComponent(k); } catch (e) { /* keep */ } out[key] = v; });
      return out;
    };
    let followersOff = false;
    /** @param {string} id */
    async function followers(id) {
      if (followersOff) return null;
      try {
        const r = await api('/networkSizes/' + enc('urn:li:organization:' + id), { edgeType: 'COMPANY_FOLLOWED_BY_MEMBER' }, 'get');
        return num(r.firstDegreeSize);
      } catch (err) {
        if (!refused(err)) throw err;
        followersOff = true;
        ctx.log('info', 'LinkedIn didn\'t give follower counts for this token, so they are left out.');
        return null;
      }
    }

    if (target.type === 'pages') {
      ctx.progress({ message: 'Asking LinkedIn which Pages you manage…' });
      /** @type {Map<string, string[]>} */
      const roles = new Map();
      for (let start = 0, i = 0; i < 20; i++) {
        const r = await api('/organizationAcls', { q: 'roleAssignee', state: 'APPROVED', start, count: 100 }, 'finder');
        const els = Array.isArray(r.elements) ? r.elements : [];
        for (const e of els) {
          const m = String(e.organization || e.organizationTarget || e.organizationalTarget || '').match(/^urn:li:organization:(\d{1,20})$/);
          if (!m) continue;
          const list = roles.get(m[1]) || [];
          if (e.role && !list.includes(String(e.role))) list.push(String(e.role));
          roles.set(m[1], list);
        }
        start += els.length;
        if (!hasMore(r, els.length, 100, start)) break;
      }
      if (!roles.size) { ctx.log('warn', 'LinkedIn lists no Pages that this member helps manage.'); return; }
      const ids = Array.from(roles.keys());
      for (let i = 0; i < ids.length && ctx.remaining() > 0; i += 50) {
        const batch = ids.slice(i, i + 50);
        /** @type {Record<string, any>} */
        let orgs = {};
        try { orgs = keyed((await api('/organizations', { ids: restliList(batch) }, 'batch_get')).results); }
        catch (err) { if (!refused(err)) throw err; ctx.log('warn', 'LinkedIn didn\'t give the Pages\' names (' + /** @type {any} */ (err).message + ')'); }
        /** @type {Record<string, unknown>[]} */
        const recs = [];
        for (const id of batch) recs.push(pageRecord(orgs[id] || orgs['urn:li:organization:' + id] || { id }, { roles: roles.get(id), followers: await followers(id) }));
        ctx.emit(recs.slice(0, ctx.remaining()));
      }
      return;
    }

    // A Page's posts
    const state = Object.assign({ v: 1, orgId: null, orgName: null, start: 0, done: 0, phase: 'posts', commentFor: [], ci: 0, cstart: 0, cdone: 0, metaOff: false, statsOff: false }, ctx.resumeFrom || {});
    const save = () => ctx.checkpoint(Object.assign({}, state, { commentFor: state.commentFor.slice() }));
    if (!state.orgId) {
      const ref = target.organization;
      ctx.progress({ message: 'Looking up the LinkedIn Page…' });
      /** @type {any} */
      let org = null;
      if (ref.by === 'vanity') {
        try {
          const r = await api('/organizations', { q: 'vanityName', vanityName: enc(ref.value) }, 'finder');
          org = Array.isArray(r.elements) && r.elements[0] ? r.elements[0] : null;
        } catch (err) {
          if (/** @type {any} */ (err).type !== 'not_found') throw err;
        }
        if (!org || !org.id) throw new ScraperError('not_found', 'LinkedIn has no Page at linkedin.com/company/' + ref.value + '.', { status: 404 });
      } else {
        try { org = await api('/organizations/' + ref.value, {}, 'get'); }
        catch (err) {
          if (!refused(err)) throw err;
          ctx.log('info', 'LinkedIn didn\'t give this Page\'s details (' + /** @type {any} */ (err).message + ') — reading its posts anyway.');
        }
        org = Object.assign({ id: ref.value }, org || {});
      }
      state.orgId = String(org.id);
      state.orgName = localized(org.localizedName, org.name);
      ctx.emit([pageRecord(org, { followers: await followers(state.orgId) })]);
      save();
    }
    const orgUrn = 'urn:li:organization:' + state.orgId;

    /** Reactions and comment counts for posts, by URN. @param {string[]} urns */
    async function socialMeta(urns) {
      if (state.metaOff || !urns.length) return {};
      try { return keyed((await api('/socialMetadata', { ids: restliList(urns) }, 'batch_get')).results); }
      catch (err) {
        if (!refused(err)) throw err;
        state.metaOff = true;
        ctx.log('warn', 'LinkedIn didn\'t give reaction and comment counts (' + /** @type {any} */ (err).message + ') — posts are collected without them.');
        return {};
      }
    }
    /** Impressions, clicks, reposts, engagement for the Page's posts, by URN. @param {string[]} urns */
    async function shareStats(urns) {
      if (!o.includeStats || state.statsOff || !urns.length) return {};
      const shares = urns.filter(u => /^urn:li:share:/.test(u)), ugc = urns.filter(u => /^urn:li:ugcPost:/.test(u));
      /** @type {Record<string, any>} */
      const out = {};
      try {
        const r = await api('/organizationalEntityShareStatistics', { q: 'organizationalEntity', organizationalEntity: enc(orgUrn), shares: shares.length ? restliList(shares) : null, ugcPosts: ugc.length ? restliList(ugc) : null }, 'finder');
        (Array.isArray(r.elements) ? r.elements : []).forEach(/** @param {any} e */ e => { const k = e.share || e.ugcPost; if (k) out[String(k)] = e.totalShareStatistics || {}; });
      } catch (err) {
        if (!refused(err)) throw err;
        state.statsOff = true;
        ctx.log('warn', 'LinkedIn didn\'t give post statistics (' + /** @type {any} */ (err).message + '). Statistics need the rw_organization_admin (or r_organization_admin) scope and an admin or analyst role on the Page.');
      }
      return out;
    }

    while (state.phase === 'posts') {
      if (state.done >= o.maxPosts || ctx.remaining() <= 0) { state.phase = 'comments'; break; }
      const count = Math.max(1, Math.min(100, o.maxPosts - state.done));
      ctx.progress({ message: 'Reading the Page\'s posts (' + state.done + ' so far)…' });
      const r = await api('/posts', { author: enc(orgUrn), q: 'author', count, start: state.start, sortBy: target.sortBy }, 'finder');
      ctx.progress({ pagesDelta: 1 });
      const all = Array.isArray(r.elements) ? r.elements : [];
      const take = all.filter(/** @param {any} p */ p => p && p.id).slice(0, o.maxPosts - state.done);
      const urns = take.map(/** @param {any} p */ p => String(p.id));
      const metas = await socialMeta(urns);
      const stats = await shareStats(urns);
      if (take.length) ctx.emit(take.map(/** @param {any} p */ p => postRecord(p, state.orgName, metas[String(p.id)], stats[String(p.id)])));
      if (o.includeComments) urns.forEach(/** @param {string} u */ u => { if (state.commentFor.length < o.commentPosts) state.commentFor.push(u); });
      state.done += take.length;
      state.start += all.length;
      if (!hasMore(r, all.length, count, state.start)) state.phase = 'comments';
      save();
    }
    if (!state.done) ctx.log('warn', 'LinkedIn returned no posts for this Page.');

    if (o.includeComments) {
      while (state.ci < state.commentFor.length && ctx.remaining() > 0) {
        const urn = state.commentFor[state.ci];
        const count = Math.max(1, Math.min(100, o.commentsPerPost - state.cdone));
        ctx.progress({ message: 'Reading comments (post ' + (state.ci + 1) + ' of ' + state.commentFor.length + ')…' });
        /** @type {any[]} */
        let els = [];
        /** @type {any} */
        let r = null;
        try { r = await api('/socialActions/' + enc(urn) + '/comments', { start: state.cstart, count }, 'get_all'); els = Array.isArray(r.elements) ? r.elements : []; }
        catch (err) {
          const e = /** @type {any} */ (err);
          if (e.type === 'forbidden') { ctx.log('warn', 'LinkedIn didn\'t give comments (' + e.message + ')'); break; }
          if (e.type !== 'not_found') throw err;
          ctx.log('info', 'LinkedIn has no comments for ' + urn + '.');
        }
        const take = els.slice(0, o.commentsPerPost - state.cdone);
        if (take.length) ctx.emit(take.map(c => commentRecord(c, urn, orgUrn, state.orgName)));
        state.cdone += take.length;
        state.cstart += els.length;
        if (!hasMore(r, els.length, count, state.cstart) || state.cdone >= o.commentsPerPost) { state.ci++; state.cstart = 0; state.cdone = 0; }
        save();
      }
    }
  };
}

module.exports = {
  normalizeLinkedInTarget, normalizeLinkedInOptions, linkedinCapacity, createLinkedInRunner, parseArchive,
  parseOrganization, plainText, parseCsv, linkUrns, versionFor, postRecord, commentRecord, pageRecord, classifyLinkedIn, enc, restliList
};
