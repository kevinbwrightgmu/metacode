// @ts-check
// ── YouTube (YouTube Data API v3) ─────────────────────────────────────────────
// What a YouTube job can collect, all through Google's official API with an
// API key (no scraping of youtube.com pages):
//
//   video     one or more videos by URL or ID: metadata and statistics
//   search    videos matching a query (relevance, date, views, rating), with a
//             date range — "oldest videos on a topic" is a date range sorted
//             oldest first, optionally keeping only titles that contain the words
//   channel   a channel by URL, @handle or ID: its details, playlists and
//             uploads (CriticalHunter/Youtube_Scraper's "scrape a channel")
//   playlist  a playlist and its videos
//   livechat  the live chat of a stream that is live now (YouTube's API serves
//             live chats only while the stream is live; replays of past chats
//             aren't available through it)
//
// For each video it can add comments (top-level, optionally replies) and a
// "viral score" (Trenblack/Youtube_Viral_data_scraper): 0.5 × views ÷ the
// channel's average views per video + 0.5 × views ÷ its subscribers, with
// < 1 "not viral", 1–2 "does well", > 2 "viral".
//
// Quota: every call costs units of the key's daily quota (10,000 by default;
// search 100, most other calls 1). Each job has a budget; the server's own key
// is also metered per Pacific-time day (when Google resets it). A quota or key
// error stops the job with the reason — nothing is retried around it.

const { ScraperError, cancelledError } = require('../errors');
const { sleep } = require('../network/rate-limiter');

const COST = /** @type {Record<string, number>} */ ({ search: 100, videos: 1, channels: 1, playlists: 1, playlistItems: 1, commentThreads: 1, comments: 1, liveChatMessages: 5 });
// Where each resource lives under /youtube/v3/ — the API's resource names aren't always its paths
const PATH = /** @type {Record<string, string>} */ ({ liveChatMessages: 'liveChat/messages' });
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const HANDLE_RE = /^@?[A-Za-z0-9._-]{3,100}$/;
const ORDERS = ['relevance', 'date', 'viewCount', 'rating', 'title'];
const DURATIONS = ['any', 'short', 'medium', 'long'];

const invalid = /** @param {string} m */ m => new ScraperError('invalid_request', m, { status: 400 });

/* ── Targets ─────────────────────────────────────── */

/** A video ID from an ID or any YouTube video URL (watch, youtu.be, shorts, live, embed). @param {string} raw */
function parseVideoId(raw) {
  const s = String(raw || '').trim();
  if (VIDEO_ID_RE.test(s)) return s;
  let u = null;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (e) { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') { const id = u.pathname.slice(1).split('/')[0]; return VIDEO_ID_RE.test(id) ? id : null; }
  if (!/^youtube(-nocookie)?\.com$/.test(host)) return null;
  const v = u.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * A channel reference: { by: 'id' | 'handle' | 'username', value }.
 * @param {string} raw
 */
function parseChannel(raw) {
  const s = String(raw || '').trim();
  if (CHANNEL_ID_RE.test(s)) return { by: 'id', value: s };
  if (/^@/.test(s) && HANDLE_RE.test(s)) return { by: 'handle', value: s };
  let u = null;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (e) { u = null; }
  if (u && /^(www\.|m\.)?youtube\.com$/.test(u.hostname)) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'channel' && CHANNEL_ID_RE.test(parts[1] || '')) return { by: 'id', value: parts[1] };
    if (parts[0] && parts[0].startsWith('@') && HANDLE_RE.test(parts[0])) return { by: 'handle', value: decodeURIComponent(parts[0]) };
    if (parts[0] === 'user' && parts[1]) return { by: 'username', value: parts[1] };
    if (parts[0] === 'c' && parts[1]) throw invalid('Custom channel URLs (youtube.com/c/…) can\'t be looked up through the API. Open the channel and copy its @handle or its youtube.com/channel/UC… address instead.');
  }
  if (HANDLE_RE.test(s) && !/[./]/.test(s)) return { by: 'handle', value: '@' + s.replace(/^@/, '') };
  return null;
}

/** @param {string} raw */
function parsePlaylistId(raw) {
  const s = String(raw || '').trim();
  let u = null;
  try { u = /^https?:\/\//i.test(s) || /youtube\.com/.test(s) ? new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s) : null; } catch (e) { u = null; }
  if (u) { const l = u.searchParams.get('list'); return l && PLAYLIST_ID_RE.test(l) ? l : null; }
  return PLAYLIST_ID_RE.test(s) && !VIDEO_ID_RE.test(s) ? s : null;
}

/** @param {unknown} v @param {string} what → ISO date or null */
function isoDate(v, what) {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t) || t < Date.UTC(2005, 3, 1) || t > Date.now() + 86400000) throw invalid(what + ' must be a date between April 2005 and today.');
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Validates what a YouTube job collects.
 * @param {any} t
 * @returns {Record<string, any>}
 */
function normalizeYouTubeTarget(t) {
  if (!t || typeof t !== 'object') throw invalid('Choose what to collect from YouTube.');
  const type = String(t.type || '');
  if (type === 'video') {
    /** @type {unknown[]} */
    const raw = Array.isArray(t.videos) ? t.videos : String(t.videos || t.video || '').split(/[\s,]+/);
    /** @type {string[]} */
    const ids = [];
    for (const r of raw.map(x => String(x).trim()).filter(Boolean)) {
      const id = parseVideoId(r);
      if (!id) throw invalid('"' + r.slice(0, 80) + '" isn\'t a YouTube video URL or ID.');
      if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) throw invalid('Paste at least one YouTube video URL or ID.');
    if (ids.length > 500) throw invalid('A job takes at most 500 videos.');
    return { platform: 'youtube', type, videoIds: ids, label: 'YouTube · ' + (ids.length === 1 ? 'video ' + ids[0] : ids.length + ' videos') };
  }
  if (type === 'search') {
    const query = String(t.query || '').trim();
    if (!query || query.length > 500) throw invalid('Type what to search YouTube for (up to 500 characters).');
    const order = ORDERS.includes(t.order) ? t.order : 'relevance';
    const videoDuration = DURATIONS.includes(t.videoDuration) ? t.videoDuration : 'any';
    const publishedAfter = isoDate(t.publishedAfter, '"Published after"');
    const publishedBefore = isoDate(t.publishedBefore, '"Published before"');
    if (publishedAfter && publishedBefore && publishedAfter >= publishedBefore) throw invalid('"Published after" must be earlier than "Published before".');
    const regionCode = /^[A-Za-z]{2}$/.test(String(t.regionCode || '')) ? String(t.regionCode).toUpperCase() : null;
    const relevanceLanguage = /^[A-Za-z]{2}(-[A-Za-z]{2,4})?$/.test(String(t.relevanceLanguage || '')) ? String(t.relevanceLanguage) : null;
    return { platform: 'youtube', type, query, order, videoDuration, publishedAfter, publishedBefore, regionCode, relevanceLanguage,
      oldestFirst: t.oldestFirst === true, titleMustContain: t.titleMustContain === true,
      label: 'YouTube · search "' + (query.length > 60 ? query.slice(0, 59) + '…' : query) + '"' };
  }
  if (type === 'channel') {
    const ref = parseChannel(t.channel);
    if (!ref) throw invalid('Enter a channel as its @handle, its youtube.com/@… or youtube.com/channel/UC… address, or its channel ID.');
    return { platform: 'youtube', type, channel: ref, label: 'YouTube · channel ' + ref.value };
  }
  if (type === 'playlist') {
    const id = parsePlaylistId(t.playlist);
    if (!id) throw invalid('Enter a playlist URL (with list=…) or a playlist ID.');
    return { platform: 'youtube', type, playlistId: id, label: 'YouTube · playlist ' + id };
  }
  if (type === 'livechat') {
    const raw = String(t.video || '').trim();
    const id = parseVideoId(raw);
    if (id) return { platform: 'youtube', type, videoId: id, label: 'YouTube · live chat of ' + id };
    // A channel (youtube.com/@name/live, @name, youtube.com/channel/UC…/live): the job finds what it is streaming now
    let ref = null;
    try { ref = parseChannel(raw.replace(/\/(live|streams|featured|videos)\/?(\?.*)?$/i, '')); } catch (e) { ref = null; }
    if (ref) return { platform: 'youtube', type, channel: ref, label: 'YouTube · live chat of ' + ref.value };
    throw invalid('Enter the URL of a stream that is live now (youtube.com/watch?v=… or youtube.com/live/…), or a channel (youtube.com/@name/live or @name) to follow its current stream.');
  }
  throw invalid('YouTube jobs collect a video, a search, a channel, a playlist or a live chat.');
}

/** @param {unknown} v @param {number} min @param {number} max @param {number} fallback @param {string} what */
function clampInt(v, min, max, fallback, what) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(what + ' must be a whole number from ' + min + ' to ' + max + '.');
  return n;
}

/** @param {any} o @param {Record<string, any>} target */
function normalizeYouTubeOptions(o, target) {
  o = o && typeof o === 'object' ? o : {};
  const out = {
    maxVideos: clampInt(o.maxVideos, 1, 500, 50, 'Videos'),
    includeComments: o.includeComments === true,
    commentVideos: clampInt(o.commentVideos, 1, 500, 10, 'Videos to read comments of'),
    commentsPerVideo: clampInt(o.commentsPerVideo, 1, 5000, 100, 'Comments per video'),
    commentOrder: o.commentOrder === 'time' ? 'time' : 'relevance',
    includeReplies: o.includeReplies === true,
    viral: o.viral === true,
    includePlaylists: o.includePlaylists === true,
    maxChatMessages: clampInt(o.maxChatMessages, 1, 50000, 2000, 'Chat messages'),
    maxChatMinutes: clampInt(o.maxChatMinutes, 1, 240, 30, 'Minutes to follow the chat'),
    quotaBudget: clampInt(o.quotaBudget, 50, 100000, 2000, 'Quota budget')
  };
  if (target.type === 'video') out.maxVideos = target.videoIds.length;
  return out;
}

/** The most records a job may hold (its capacity before the plan's limits). @param {Record<string, any>} target @param {ReturnType<typeof normalizeYouTubeOptions>} o */
function youtubeCapacity(target, o) {
  if (target.type === 'livechat') return o.maxChatMessages + 1;
  let n = o.maxVideos + 1;
  if (target.type === 'channel' && o.includePlaylists) n += 200;
  if (o.includeComments) n += Math.min(o.commentVideos, o.maxVideos) * o.commentsPerVideo;
  return n;
}

/* ── Records ─────────────────────────────────────── */

/** ISO 8601 duration (PT1H2M3S) → seconds. @param {unknown} d */
function durationSeconds(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(d || ''));
  if (!m) return null;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}
/** @param {unknown} v */
const num = v => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** @param {unknown} v */
const str = v => (typeof v === 'string' ? v : v === undefined || v === null ? null : String(v));
/** @param {unknown} iso */
const unix = iso => { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
/** @param {any} th */
const thumb = th => (th && (th.maxres || th.high || th.medium || th.default) ? (th.maxres || th.high || th.medium || th.default).url : null);
const watchUrl = /** @param {string} id */ id => 'https://www.youtube.com/watch?v=' + id;

/** @param {any} v a videos.list item */
function videoRecord(v) {
  const s = v.snippet || {}, st = v.statistics || {}, cd = v.contentDetails || {}, ls = v.liveStreamingDetails || {};
  const title = str(s.title) || '', description = str(s.description) || '';
  return {
    record_type: 'post', platform: 'youtube', fullname: 'yt:video:' + v.id,
    post_id: v.id, video_id: v.id, title,
    author: str(s.channelTitle), channel_id: str(s.channelId), channel_title: str(s.channelTitle),
    url: watchUrl(v.id), permalink: watchUrl(v.id),
    created_at: str(s.publishedAt), created_utc: unix(s.publishedAt),
    selftext: description, full_text: description ? title + '\n\n' + description : title,
    score: num(st.likeCount), like_count: num(st.likeCount), view_count: num(st.viewCount),
    num_comments: num(st.commentCount), comment_count: num(st.commentCount), favorite_count: num(st.favoriteCount),
    duration_seconds: durationSeconds(cd.duration), definition: str(cd.definition), has_captions: cd.caption === 'true',
    licensed_content: cd.licensedContent === true, category_id: str(s.categoryId), tags: Array.isArray(s.tags) ? s.tags.join(', ') : null,
    default_language: str(s.defaultLanguage || s.defaultAudioLanguage), live_broadcast: str(s.liveBroadcastContent),
    live_started_at: str(ls.actualStartTime), live_ended_at: str(ls.actualEndTime), concurrent_viewers: num(ls.concurrentViewers),
    thumbnail_url: thumb(s.thumbnails)
  };
}

/** @param {any} t a commentThreads/comments item's snippet holder @param {string} videoId @param {string | null} parentId @param {number | null} replies */
function commentRecord(t, videoId, parentId, replies) {
  const s = t.snippet || {};
  const published = str(s.publishedAt), updated = str(s.updatedAt);
  return {
    record_type: 'comment', platform: 'youtube', fullname: 'yt:comment:' + t.id,
    comment_id: t.id, post_id: videoId, video_id: videoId, parent_id: parentId, depth: parentId ? 1 : 0,
    author: str(s.authorDisplayName), author_channel_id: s.authorChannelId && s.authorChannelId.value ? String(s.authorChannelId.value) : null,
    body: str(s.textOriginal !== undefined ? s.textOriginal : s.textDisplay) || '',
    score: num(s.likeCount), like_count: num(s.likeCount), reply_count: replies,
    created_at: published, created_utc: unix(published), edited_at: updated && updated !== published ? updated : null,
    permalink: watchUrl(videoId) + '&lc=' + t.id
  };
}

/** @param {any} m a liveChatMessages item @param {string} videoId */
function chatRecord(m, videoId) {
  const s = m.snippet || {}, a = m.authorDetails || {};
  const sc = s.superChatDetails || s.superStickerDetails || null;
  return {
    record_type: 'comment', platform: 'youtube', source: 'live_chat', fullname: 'yt:chat:' + m.id,
    comment_id: m.id, post_id: videoId, video_id: videoId, parent_id: null, depth: 0,
    message_type: str(s.type), body: str(s.displayMessage) || (s.textMessageDetails && str(s.textMessageDetails.messageText)) || '',
    author: str(a.displayName), author_channel_id: str(a.channelId || s.authorChannelId),
    is_owner: a.isChatOwner === true, is_moderator: a.isChatModerator === true, is_member: a.isChatSponsor === true, is_verified: a.isVerified === true,
    created_at: str(s.publishedAt), created_utc: unix(s.publishedAt),
    amount: sc ? str(sc.amountDisplayString) : null, amount_micros: sc ? num(sc.amountMicros) : null, currency: sc ? str(sc.currency) : null, tier: sc ? num(sc.tier) : null,
    permalink: watchUrl(videoId)
  };
}

/** @param {any} c a channels.list item */
function channelRecord(c) {
  const s = c.snippet || {}, st = c.statistics || {};
  return {
    record_type: 'channel', platform: 'youtube', fullname: 'yt:channel:' + c.id,
    channel_id: c.id, name: str(s.title), handle: str(s.customUrl), description: str(s.description),
    created_at: str(s.publishedAt), country: str(s.country),
    subscriber_count: st.hiddenSubscriberCount ? null : num(st.subscriberCount), view_count: num(st.viewCount), video_count: num(st.videoCount),
    uploads_playlist: c.contentDetails && c.contentDetails.relatedPlaylists ? str(c.contentDetails.relatedPlaylists.uploads) : null,
    url: 'https://www.youtube.com/channel/' + c.id, thumbnail_url: thumb(s.thumbnails)
  };
}

/** @param {any} p a playlists.list item */
function playlistRecord(p) {
  const s = p.snippet || {};
  return {
    record_type: 'playlist', platform: 'youtube', fullname: 'yt:playlist:' + p.id,
    playlist_id: p.id, title: str(s.title), description: str(s.description), channel_id: str(s.channelId), channel_title: str(s.channelTitle),
    item_count: p.contentDetails ? num(p.contentDetails.itemCount) : null, created_at: str(s.publishedAt),
    url: 'https://www.youtube.com/playlist?list=' + p.id
  };
}

/**
 * Trenblack's viral score. → { score, category } or nulls when the channel hides its subscribers or has no videos.
 * @param {number | null} views @param {{ subs: number | null, views: number | null, videos: number | null } | undefined} ch
 */
function viralScore(views, ch) {
  if (views === null || !ch || !ch.subs || !ch.views || !ch.videos) return { score: null, category: null };
  const avg = ch.views / ch.videos;
  const score = 0.5 * (views / avg) + 0.5 * (views / ch.subs);
  return { score: Math.round(score * 1000) / 1000, category: score < 1 ? 'not viral' : score <= 2 ? 'does well' : 'viral' };
}

/* ── Errors ──────────────────────────────────────── */

/**
 * YouTube's error answers → ScraperError. Reasons from error.errors[0].reason.
 * @param {number} status @param {any} json
 */
function classifyYouTube(status, json) {
  const e = json && json.error ? json.error : {};
  const reason = String((Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason) || (e.details && e.details[0] && e.details[0].reason) || e.status || '').toLowerCase();
  const said = String(e.message || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 200);
  if (/quotaexceeded|dailylimitexceeded/.test(reason)) {
    return new ScraperError('quota_exceeded', 'The YouTube API key\'s daily quota is used up. Google resets it at midnight Pacific time; until then this key can\'t make requests. (Each search costs 100 units of the default 10,000.)', { status: 429 });
  }
  if (/ratelimitexceeded|userratelimitexceeded/.test(reason)) return new ScraperError('rate_limited', 'YouTube is rate-limiting this key.', { status: 429, retryable: true });
  if (/keyinvalid|api_key_invalid/.test(reason) || (status === 400 && /api key not valid/i.test(said))) return new ScraperError('auth_error', 'The YouTube API key isn\'t valid. Check it in Google Cloud Console → APIs & Services → Credentials.', { status: 401 });
  if (/accessnotconfigured|service_disabled/.test(reason)) return new ScraperError('auth_error', 'The YouTube Data API v3 isn\'t enabled for this key\'s Google Cloud project. Enable it under APIs & Services → Library.', { status: 401 });
  if (/ipreferer|api_key_ip_address_blocked|api_key_http_referrer_blocked|forbidden_restricted|api_key_service_blocked/.test(reason)) return new ScraperError('auth_error', 'The YouTube API key\'s restrictions don\'t allow this server (IP, referrer or API restrictions in Google Cloud Console).', { status: 401 });
  if (/commentsdisabled/.test(reason)) return new ScraperError('comments_disabled', 'Comments are turned off for this video.', { status: 403 });
  if (/livechatended|livechatdisabled|livechatnotfound|livechatinactive/.test(reason)) return new ScraperError('chat_unavailable', 'The live chat isn\'t available: ' + (said || reason) + '.', { status: 404 });
  if (status === 401) return new ScraperError('auth_error', 'YouTube asked for a sign-in (HTTP 401) for this data. MetaCode only reads public data with an API key.', { status: 401 });
  if (status === 404 || /notfound/.test(reason)) return new ScraperError('not_found', 'YouTube doesn\'t have that (HTTP 404' + (said ? ': ' + said : '') + ').', { status: 404 });
  if (status === 403) return new ScraperError('forbidden', 'YouTube refused this request (HTTP 403' + (said ? ': ' + said : '') + ').', { status: 403 });
  if (status === 400) return new ScraperError('invalid_request', 'YouTube didn\'t accept the request' + (said ? ': ' + said : '.'), { status: 400 });
  return null;
}

/* ── Quota ───────────────────────────────────────── */

/** The server key's daily quota, per Pacific-time day (in memory; resets at midnight Pacific like Google's). */
class QuotaMeter {
  /** @param {number} limit @param {() => number} [now] */
  constructor(limit, now) { this.limit = limit; this.now = now || Date.now; this.day = ''; this.used = 0; }
  dayKey() { return new Date(this.now()).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
  roll() { const d = this.dayKey(); if (d !== this.day) { this.day = d; this.used = 0; } }
  remaining() { this.roll(); return Math.max(0, this.limit - this.used); }
  /** @param {number} units */
  spend(units) {
    this.roll();
    if (this.used + units > this.limit) {
      throw new ScraperError('quota_exceeded', 'This server\'s YouTube quota for today (' + this.limit + ' units) is used up. It resets at midnight Pacific time — or add your own YouTube API key on the Scraper page.', { status: 429 });
    }
    this.used += units;
  }
}

/* ── The runner ──────────────────────────────────── */

/**
 * @param {object} deps
 * @param {import('./http').PlatformHttp} deps.http
 * @param {ReturnType<typeof import('./config').platformConfig>['youtube']} deps.config
 * @param {QuotaMeter} deps.serverQuota
 */
function createYouTubeRunner(deps) {
  /**
   * @param {any} job
   * @param {any} ctx  the job manager's context
   */
  return async function runYouTube(job, ctx) {
    const target = job.target, o = job.options.youtube;
    const own = job.keySource === 'own';
    const key = own ? ctx.http && ctx.http.youtubeKey : deps.config.apiKey;
    if (!key) throw new ScraperError(own ? 'auth_error' : 'not_available', own ? 'This job used your own YouTube API key, which isn\'t kept on the server. Add it again on the Scraper page and press Resume.' : 'No YouTube API key is set on this server (YOUTUBE_API_KEY). Add your own on the Scraper page.', { status: 400 });
    const signal = ctx.signal;
    let spent = Number(job.meta.youtubeQuota) || 0;
    const scope = own ? 'own:' + require('crypto').createHash('sha256').update(key).digest('hex').slice(0, 12) : 'server';

    /** One API call. @param {string} resource @param {Record<string, string | number | null | undefined>} params */
    async function api(resource, params) {
      const cost = COST[resource] || 1;
      if (spent + cost > o.quotaBudget) {
        throw new ScraperError('quota_budget', 'Stopped at this job\'s YouTube quota budget (' + o.quotaBudget + ' units). Raise "Quota budget" to collect more.', { status: 429 });
      }
      if (!own) deps.serverQuota.spend(cost);
      spent += cost;
      ctx.setMeta('youtubeQuota', spent);
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
      qs.set('key', key);
      const r = await deps.http.getJson(deps.config.baseUrl + '/' + (PATH[resource] || resource) + '?' + qs.toString(), {
        signal, label: 'YouTube', delayMs: deps.config.minDelayMs, retries: job.options.retries, timeoutMs: job.options.timeoutMs,
        limitKey: new URL(deps.config.baseUrl).host + '#' + scope, log: ctx.log, onRequest: ctx.requestOpts.onRequest, classify: classifyYouTube
      });
      return r.json;
    }

    const room = () => ctx.remaining() > 0;
    /** @param {Record<string, any>[]} recs */
    const emit = recs => { if (recs.length) ctx.emit(recs); };
    /** @type {Record<string, any>} */
    const state = Object.assign({ v: 1, phase: 'collect', ids: [], pageToken: null, pages: 0, detailsDone: 0, commentIndex: 0, channels: {} }, ctx.resumeFrom || {});
    const save = () => ctx.checkpoint(Object.assign({}, state));

    try {
      if (target.type === 'livechat') return await liveChat();
      if (state.phase === 'collect') await collect();
      if (state.phase === 'details') await details();
      if (state.phase === 'comments') await comments();
      ctx.progress({ message: 'Finished. ' + spent + ' quota unit' + (spent === 1 ? '' : 's') + ' used.' });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e && e.type === 'quota_budget') { ctx.log('warn', e.message); ctx.progress({ message: e.message }); return; }
      throw err;
    }

    // Phase 1: which videos
    async function collect() {
      if (target.type === 'video') state.ids = target.videoIds.slice();
      else if (target.type === 'search') await collectSearch();
      else if (target.type === 'channel') await collectChannel();
      else if (target.type === 'playlist') await collectPlaylist();
      state.phase = 'details'; state.pageToken = null;
      save();
    }

    async function collectSearch() {
      /** @type {{ id: string, at: string }[]} */
      const found = state.found || [];
      /** @type {string[]} */
      const words = target.query.toLowerCase().split(/\s+/).filter(Boolean);
      while (found.length < o.maxVideos) {
        ctx.progress({ message: 'Searching YouTube (page ' + (state.pages + 1) + ')…' });
        const page = await api('search', {
          part: 'snippet', type: 'video', q: target.query, order: target.order, maxResults: 50, pageToken: state.pageToken,
          publishedAfter: target.publishedAfter, publishedBefore: target.publishedBefore, regionCode: target.regionCode,
          relevanceLanguage: target.relevanceLanguage, videoDuration: target.videoDuration === 'any' ? null : target.videoDuration
        });
        state.pages++; ctx.progress({ pagesDelta: 1 });
        for (const it of page.items || []) {
          const id = it.id && it.id.videoId;
          if (!id || found.some(f => f.id === id)) continue;
          const title = String((it.snippet && it.snippet.title) || '').toLowerCase();
          if (target.titleMustContain && !words.every(w => title.includes(w))) continue;
          found.push({ id, at: String((it.snippet && it.snippet.publishedAt) || '') });
          if (found.length >= o.maxVideos) break;
        }
        state.found = found; state.pageToken = page.nextPageToken || null;
        save();
        if (!state.pageToken) break;
      }
      if (target.oldestFirst) found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      state.ids = found.map(f => f.id);
      if (!state.ids.length) ctx.log('warn', 'YouTube found no videos for this search' + (target.titleMustContain ? ' whose titles contain every word' : '') + '.');
    }

    /** @param {string} playlistId */
    async function collectPlaylistItems(playlistId) {
      while (state.ids.length < o.maxVideos) {
        ctx.progress({ message: 'Listing videos (page ' + (state.pages + 1) + ')…' });
        const page = await api('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken: state.pageToken });
        state.pages++; ctx.progress({ pagesDelta: 1 });
        for (const it of page.items || []) {
          const id = it.contentDetails && it.contentDetails.videoId;
          if (id && !state.ids.includes(id)) state.ids.push(id);
          if (state.ids.length >= o.maxVideos) break;
        }
        state.pageToken = page.nextPageToken || null;
        save();
        if (!state.pageToken) break;
      }
    }

    async function collectChannel() {
      if (!state.uploads) {
        const ref = target.channel;
        const params = /** @type {Record<string, string>} */ ({ part: 'snippet,statistics,contentDetails' });
        params[ref.by === 'id' ? 'id' : ref.by === 'handle' ? 'forHandle' : 'forUsername'] = ref.value;
        const r = await api('channels', params);
        const c = (r.items || [])[0];
        if (!c) throw new ScraperError('not_found', 'YouTube has no channel ' + ref.value + '.', { status: 404 });
        const rec = channelRecord(c);
        emit([rec]);
        state.channels[c.id] = { subs: rec.subscriber_count, views: rec.view_count, videos: rec.video_count };
        state.uploads = rec.uploads_playlist;
        state.channelId = c.id;
        save();
        if (o.includePlaylists) {
          let token = null, n = 0;
          do {
            const p = await api('playlists', { part: 'snippet,contentDetails', channelId: c.id, maxResults: 50, pageToken: token });
            emit((p.items || []).map(playlistRecord));
            n += (p.items || []).length;
            token = p.nextPageToken || null;
          } while (token && n < 200 && room());
        }
      }
      if (!state.uploads) throw new ScraperError('not_found', 'That channel has no uploads list.', { status: 404 });
      await collectPlaylistItems(state.uploads);
    }

    async function collectPlaylist() {
      if (!state.playlistRead) {
        const r = await api('playlists', { part: 'snippet,contentDetails', id: target.playlistId });
        const p = (r.items || [])[0];
        if (!p) throw new ScraperError('not_found', 'YouTube has no public playlist ' + target.playlistId + '.', { status: 404 });
        emit([playlistRecord(p)]);
        state.playlistRead = true;
        save();
      }
      await collectPlaylistItems(target.playlistId);
    }

    // Phase 2: each video's metadata and statistics (50 per call)
    async function details() {
      while (state.detailsDone < state.ids.length && room()) {
        /** @type {string[]} */
        const batch = state.ids.slice(state.detailsDone, state.detailsDone + 50);
        ctx.progress({ message: 'Reading video details (' + state.detailsDone + ' of ' + state.ids.length + ')…' });
        const r = await api('videos', { part: 'snippet,statistics,contentDetails,liveStreamingDetails', id: batch.join(','), maxResults: 50 });
        const byId = new Map((r.items || []).map(/** @param {any} v */ v => [v.id, v]));
        const missing = batch.filter(id => !byId.has(id));
        if (missing.length) ctx.log('warn', missing.length + ' video' + (missing.length === 1 ? ' isn\'t' : 's aren\'t') + ' available (private, deleted or not found): ' + missing.slice(0, 10).join(', ') + (missing.length > 10 ? '…' : '') + '.');
        /** @type {Record<string, any>[]} */
        let recs = batch.filter(id => byId.has(id)).map(id => videoRecord(byId.get(id)));
        if (o.viral) {
          const need = Array.from(new Set(recs.map(x => x.channel_id).filter(id => id && !state.channels[id])));
          for (let i = 0; i < need.length; i += 50) {
            const cr = await api('channels', { part: 'statistics', id: need.slice(i, i + 50).join(','), maxResults: 50 });
            (cr.items || []).forEach(/** @param {any} c */ c => {
              const st = c.statistics || {};
              state.channels[c.id] = { subs: st.hiddenSubscriberCount ? null : num(st.subscriberCount), views: num(st.viewCount), videos: num(st.videoCount) };
            });
          }
          recs = recs.map(x => { const v = viralScore(x.view_count, state.channels[x.channel_id || '']); return Object.assign(x, { viral_score: v.score, viral_category: v.category }); });
        }
        if (target.type === 'search') recs.forEach(x => { x.search_rank = state.ids.indexOf(x.video_id) + 1; });
        emit(recs);
        state.detailsDone += batch.length;
        save();
      }
      state.phase = o.includeComments ? 'comments' : 'done';
      save();
    }

    // Phase 3: comments of the first `commentVideos` videos
    async function comments() {
      const last = Math.min(state.ids.length, o.commentVideos);
      while (state.commentIndex < last && room()) {
        const videoId = state.ids[state.commentIndex];
        ctx.progress({ message: 'Reading comments of video ' + (state.commentIndex + 1) + ' of ' + last + '…' });
        let got = 0, token = null;
        try {
          do {
            const page = await api('commentThreads', { part: 'snippet,replies', videoId, maxResults: 100, order: o.commentOrder, textFormat: 'plainText', pageToken: token });
            /** @type {Record<string, any>[]} */
            const recs = [];
            for (const th of page.items || []) {
              const top = th.snippet && th.snippet.topLevelComment;
              if (!top) continue;
              const total = num(th.snippet.totalReplyCount) || 0;
              recs.push(commentRecord(top, videoId, null, total));
              got++;
              if (o.includeReplies && total) {
                const shown = (th.replies && th.replies.comments) || [];
                if (shown.length >= total) shown.forEach(/** @param {any} c */ c => { recs.push(commentRecord(c, videoId, top.id, null)); got++; });
                else got += await replies(top.id, videoId, o.commentsPerVideo - got, recs);
              }
              if (got >= o.commentsPerVideo) break;
            }
            emit(recs);
            token = page.nextPageToken || null;
          } while (token && got < o.commentsPerVideo && room());
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (e && (e.type === 'comments_disabled' || e.type === 'not_found')) ctx.log('info', 'Video ' + videoId + ': ' + e.message);
          else throw err;
        }
        state.commentIndex++;
        save();
      }
      state.phase = 'done';
      save();
    }

    /** All replies of a comment (when the thread shows only some). @param {string} parentId @param {string} videoId @param {number} budget @param {Record<string, any>[]} out */
    async function replies(parentId, videoId, budget, out) {
      let n = 0, token = null;
      do {
        const page = await api('comments', { part: 'snippet', parentId, maxResults: 100, textFormat: 'plainText', pageToken: token });
        for (const c of page.items || []) { if (n >= budget) break; out.push(commentRecord(c, videoId, parentId, null)); n++; }
        token = page.nextPageToken || null;
      } while (token && n < budget);
      return n;
    }

    // Live chat: follows a live stream's chat for up to maxChatMinutes
    async function liveChat() {
      if (!state.chatId) {
        if (!state.videoId) state.videoId = target.videoId || await currentStream();
        const r = await api('videos', { part: 'snippet,liveStreamingDetails,statistics,contentDetails', id: state.videoId });
        const v = (r.items || [])[0];
        if (!v) throw new ScraperError('not_found', 'YouTube has no public video ' + state.videoId + '.', { status: 404 });
        emit([videoRecord(v)]);
        const ls = v.liveStreamingDetails || {};
        if (!ls.activeLiveChatId) {
          throw new ScraperError('chat_unavailable', ls.actualEndTime
            ? 'This stream has ended. YouTube\'s API only serves the chat of streams that are live now, so a replay\'s chat can\'t be collected through it.'
            : ls.scheduledStartTime && !ls.actualStartTime ? 'This stream hasn\'t started yet (scheduled for ' + ls.scheduledStartTime + '). Start the job once it is live.'
              : ls.actualStartTime ? 'This stream is live, but its chat is turned off.'
                : 'This video isn\'t a live stream, so it has no live chat.', { status: 404 });
        }
        state.chatId = ls.activeLiveChatId;
        save();
        ctx.log('info', 'Following the live chat of "' + String((v.snippet && v.snippet.title) || state.videoId).slice(0, 120) + '".');
      }
      const videoId = state.videoId;
      const until = Date.now() + o.maxChatMinutes * 60000;
      let total = Number(state.chatCount) || 0;
      let ended = false;
      while (!ended && total < o.maxChatMessages && Date.now() < until && room()) {
        if (signal.aborted) throw signal.reason || cancelledError();
        let page;
        try {
          page = await api('liveChatMessages', { liveChatId: state.chatId, part: 'snippet,authorDetails', maxResults: 2000, pageToken: state.pageToken });
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (e && e.type === 'chat_unavailable') { ctx.log('info', 'The chat ended: ' + e.message); break; }
          if (e && (e.type === 'forbidden' || (e.type === 'auth_error' && e.status === 401 && /sign-in/.test(e.message)))) {
            throw new ScraperError('chat_unavailable', 'YouTube doesn\'t let MetaCode read this chat: it is limited to members or subscribers, or restricted by the channel. MetaCode only reads public live chats.', { status: 403 });
          }
          throw err;
        }
        const items = (page.items || []).filter(/** @param {any} m */ m => !(m.snippet && m.snippet.type === 'tombstone'));
        if (items.some(/** @param {any} m */ m => m.snippet && m.snippet.type === 'chatEndedEvent')) ended = true;
        const recs = items.filter(/** @param {any} m */ m => !(m.snippet && m.snippet.type === 'chatEndedEvent')).map(/** @param {any} m */ m => chatRecord(m, videoId));
        emit(recs.slice(0, o.maxChatMessages - total));
        total += Math.min(recs.length, o.maxChatMessages - total);
        state.pageToken = page.nextPageToken || state.pageToken;
        state.chatCount = total;
        save();
        ctx.progress({ message: 'Following the live chat: ' + total + ' message' + (total === 1 ? '' : 's') + ' so far.', pagesDelta: 1 });
        if (ended) { ctx.log('info', 'The chat has ended.'); break; }
        if (page.offlineAt) { ctx.log('info', 'The stream went offline at ' + page.offlineAt + '.'); break; }
        const wait = Math.max(2000, Math.min(60000, Number(page.pollingIntervalMillis) || 5000));
        if (total < o.maxChatMessages && Date.now() + wait < until) await sleep(wait, signal);
        else break;
      }
      ctx.progress({ message: 'Collected ' + total + ' chat message' + (total === 1 ? '' : 's') + '. ' + spent + ' quota units used (live chat calls are counted as 5 units each, an estimate).' });
    }

    // A channel's stream that is live now (a search: 100 quota units)
    async function currentStream() {
      const ref = target.channel;
      let channelId = ref.by === 'id' ? ref.value : null;
      if (!channelId) {
        const params = /** @type {Record<string, string>} */ ({ part: 'id' });
        params[ref.by === 'handle' ? 'forHandle' : 'forUsername'] = ref.value;
        const c = await api('channels', params);
        channelId = c.items && c.items[0] && c.items[0].id;
        if (!channelId) throw new ScraperError('not_found', 'YouTube has no channel ' + ref.value + '.', { status: 404 });
      }
      ctx.progress({ message: 'Looking for the channel\'s live stream…' });
      const s = await api('search', { part: 'id', channelId, eventType: 'live', type: 'video', maxResults: 5 });
      const id = s.items && s.items[0] && s.items[0].id && s.items[0].id.videoId;
      if (!id) throw new ScraperError('chat_unavailable', ref.value + ' isn\'t streaming live right now. Start the job while the stream is live (or paste the stream\'s own link).', { status: 404 });
      return String(id);
    }
  };
}

module.exports = {
  normalizeYouTubeTarget, normalizeYouTubeOptions, youtubeCapacity, createYouTubeRunner, QuotaMeter,
  parseVideoId, parseChannel, parsePlaylistId, durationSeconds, viralScore, classifyYouTube,
  videoRecord, commentRecord, chatRecord, channelRecord, playlistRecord, COST
};
