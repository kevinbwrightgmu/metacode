/* ══════════════════════════════════════════════
   scraper-platforms.js — YouTube and X forms on the Scraper page

   The platform menu's YouTube and X panels (LinkedIn explains why it isn't
   offered). Jobs go to the same scraper API and job list as Reddit's: the
   current-job panel, results, exports and Add to project are shared
   (scraper.js). Users' own API keys are kept in this browser only and sent
   with their jobs; the server never stores them.
   ══════════════════════════════════════════════ */

const ScraperPlatforms = (() => {
  'use strict';
  const KEYS = 'metacode.scraper.platformKeys';
  const FORM = 'metacode.scraper.platformForm';
  const esc = s => App.esc(s);
  const $ = id => document.getElementById(id);
  let host = null;          // { api(path, opts), status(), startJob(body) } from scraper.js

  /* ── Keys kept in this browser ───────────── */
  function keys() { try { return JSON.parse(localStorage.getItem(KEYS) || '{}') || {}; } catch (e) { return {}; } }
  function setKey(name, value) {
    const k = keys();
    if (value) k[name] = value; else delete k[name];
    try { localStorage.setItem(KEYS, JSON.stringify(k)); return true; } catch (e) { return false; }
  }
  const ownYouTubeKey = () => keys().youtube || null;
  const ownXToken = () => keys().x || null;

  /* ── Form memory ─────────────────────────── */
  const DEFAULTS = {
    youtube: { type: 'search', videos: '', query: '', order: 'relevance', publishedAfter: '', publishedBefore: '', oldestFirst: false, titleMustContain: false, videoDuration: 'any',
      channel: '', playlist: '', video: '', maxVideos: 50, includeComments: false, commentVideos: 10, commentsPerVideo: 100, commentOrder: 'relevance', includeReplies: false,
      viral: false, includePlaylists: false, maxChatMessages: 2000, maxChatMinutes: 30, quotaBudget: 2000 },
    x: { type: 'search', query: '', sort: 'latest', startTime: '', endTime: '', archive: false, username: '', excludeReplies: false, excludeReposts: false, posts: '', maxPosts: 100 }
  };
  let form = load();
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(FORM) || 'null'); } catch (e) { saved = null; }
    return { youtube: Object.assign({}, DEFAULTS.youtube, saved && saved.youtube), x: Object.assign({}, DEFAULTS.x, saved && saved.x) };
  }
  function save() { try { localStorage.setItem(FORM, JSON.stringify(form)); } catch (e) { /* not remembered */ } }

  /* ── Small builders ──────────────────────── */
  const field = (id, label, control, hint) => '<div class="form-group"><label class="form-label" for="' + id + '">' + label + '</label>' + control + (hint ? '<div class="form-hint">' + hint + '</div>' : '') + '</div>';
  const text = (p, k, placeholder, type) => '<input class="form-input" id="pf-' + p + '-' + k + '" type="' + (type || 'text') + '" value="' + esc(form[p][k]) + '" placeholder="' + esc(placeholder || '') + '" oninput="ScraperPlatforms.set(\'' + p + '\',\'' + k + '\',this.value)">';
  const area = (p, k, placeholder) => '<textarea class="form-textarea" id="pf-' + p + '-' + k + '" rows="3" placeholder="' + esc(placeholder || '') + '" oninput="ScraperPlatforms.set(\'' + p + '\',\'' + k + '\',this.value)">' + esc(form[p][k]) + '</textarea>';
  const num = (p, k, min, max) => '<input class="form-input" id="pf-' + p + '-' + k + '" type="number" min="' + min + '" max="' + max + '" value="' + esc(form[p][k]) + '" oninput="ScraperPlatforms.set(\'' + p + '\',\'' + k + '\',this.value)">';
  const select = (p, k, opts) => '<select class="form-select" id="pf-' + p + '-' + k + '" onchange="ScraperPlatforms.set(\'' + p + '\',\'' + k + '\',this.value,true)">' +
    opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(form[p][k]) === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
  const check = (p, k, label, rerender) => '<label class="sc-check"><input type="checkbox" id="pf-' + p + '-' + k + '"' + (form[p][k] ? ' checked' : '') + ' onchange="ScraperPlatforms.set(\'' + p + '\',\'' + k + '\',this.checked,' + (rerender ? 'true' : 'false') + ')"> ' + label + '</label>';

  function set(p, k, value, rerender) {
    form[p][k] = value;
    save();
    if (rerender) render(p);
    else if (p === 'youtube') updateQuota();
  }

  /* ── YouTube ─────────────────────────────── */
  // A rough count of quota units for the current form (search 100, other calls 1)
  function quotaEstimate() {
    const f = form.youtube;
    const videos = Math.max(1, Number(f.maxVideos) || 50);
    let units = 0;
    if (f.type === 'search') units += Math.ceil(videos / 50) * 100;
    if (f.type === 'channel') units += 1 + Math.ceil(videos / 50) + (f.includePlaylists ? 1 : 0);
    if (f.type === 'playlist') units += 1 + Math.ceil(videos / 50);
    if (f.type === 'livechat') return 1 + Math.ceil((Number(f.maxChatMinutes) || 30) * 60 / 5) * 5;
    units += Math.ceil((f.type === 'video' ? Math.max(1, f.videos.split(/[\s,]+/).filter(Boolean).length) : videos) / 50);
    if (f.viral) units += Math.ceil(videos / 50);
    if (f.includeComments) units += Math.min(videos, Number(f.commentVideos) || 10) * Math.ceil((Number(f.commentsPerVideo) || 100) / 100);
    return units;
  }
  function updateQuota() {
    const el = $('pf-yt-quota');
    if (el) el.textContent = 'About ' + quotaEstimate().toLocaleString() + ' quota units (most for this job: ' + Number(form.youtube.quotaBudget || 2000).toLocaleString() + ').';
  }

  function youtubeKeyHTML(st) {
    const mine = ownYouTubeKey();
    return '<div class="sc-api-row">' + (mine
      ? '<span class="badge badge-green">Your YouTube API key</span> <span class="text-second">…' + esc(mine.slice(-4)) + ' — kept in this browser, sent only with your jobs.</span> <button class="btn btn-ghost btn-sm" onclick="ScraperPlatforms.removeKey(\'youtube\')">Remove</button>'
      : st.serverKey ? '<span class="badge badge-blue">This server\'s YouTube key</span> <span class="text-second">' + (st.quota ? st.quota.remaining.toLocaleString() + ' of ' + st.quota.limit.toLocaleString() + ' units left today (resets at midnight Pacific time). ' : '') + 'Add your own key to use your own quota.</span>'
        : '<span class="badge badge-amber">No YouTube API key</span> <span class="text-second">Add one to collect from YouTube.</span>') + '</div>' +
      '<details class="sc-details"' + (!mine && !st.serverKey ? ' open' : '') + '><summary>' + (mine ? 'Replace your key' : 'Use your own YouTube API key') + '</summary>' +
        '<ol class="form-hint" style="margin:8px 0 8px 18px"><li>Google Cloud Console → create a project → APIs &amp; Services → Library → enable <b>YouTube Data API v3</b>.</li><li>Credentials → Create credentials → API key. Restrict it to YouTube Data API v3.</li><li>Paste it here. The free quota is 10,000 units a day; a search costs 100.</li></ol>' +
        '<div class="sc-inline"><input class="form-input" id="pf-yt-key" type="password" autocomplete="off" placeholder="YouTube (Google) API key"><button class="btn btn-secondary btn-sm" onclick="ScraperPlatforms.saveKey(\'youtube\')">Save key</button></div></details>';
  }

  function youtubeFields() {
    const f = form.youtube, P = 'youtube';
    const types = [['search', 'Search videos'], ['video', 'Specific videos'], ['channel', 'A channel (all uploads)'], ['playlist', 'A playlist'], ['livechat', 'Live chat of a stream']];
    let target = '';
    if (f.type === 'video') target = field('pf-youtube-videos', 'Videos', area(P, 'videos', 'One URL or ID per line, e.g. https://www.youtube.com/watch?v=…'), 'Watch, youtu.be, Shorts and live links all work (up to 500).');
    else if (f.type === 'search') {
      target = field('pf-youtube-query', 'Search for', text(P, 'query', 'e.g. climate change protest')) +
        '<div class="sc-fields">' + field('pf-youtube-order', 'Sort by', select(P, 'order', [['relevance', 'Relevance'], ['date', 'Upload date (newest)'], ['viewCount', 'View count'], ['rating', 'Rating'], ['title', 'Title']])) +
        field('pf-youtube-videoDuration', 'Length', select(P, 'videoDuration', [['any', 'Any'], ['short', 'Under 4 minutes'], ['medium', '4–20 minutes'], ['long', 'Over 20 minutes']])) +
        field('pf-youtube-publishedAfter', 'Published after', text(P, 'publishedAfter', '', 'date')) + field('pf-youtube-publishedBefore', 'Published before', text(P, 'publishedBefore', '', 'date')) + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px">' + check(P, 'oldestFirst', 'List the oldest videos first') + check(P, 'titleMustContain', 'Only videos whose title contains every search word') +
        '<div class="form-hint">For the oldest videos on a topic: set "Published before" (e.g. 2010), tick both boxes. YouTube returns up to about 500 results per search.</div></div>';
    } else if (f.type === 'channel') {
      target = field('pf-youtube-channel', 'Channel', text(P, 'channel', '@handle, youtube.com/@handle or youtube.com/channel/UC…')) + check(P, 'includePlaylists', 'Also list the channel\'s playlists');
    } else if (f.type === 'playlist') target = field('pf-youtube-playlist', 'Playlist', text(P, 'playlist', 'https://www.youtube.com/playlist?list=…'));
    else if (f.type === 'livechat') {
      target = field('pf-youtube-video', 'Live stream', text(P, 'video', 'Stream link (youtube.com/watch?v=… or /live/…) or channel (@name or youtube.com/@name/live)')) +
        '<div class="form-hint">YouTube\'s API serves a chat only while the stream is live; the job follows it until the stream ends or the limits below. With a channel, the job finds the stream it has live now (a search: 100 quota units). The chat of a past stream (a replay) can\'t be collected through the API.</div>';
    }
    let opts = '';
    if (f.type === 'livechat') {
      opts = '<div class="sc-fields">' + field('pf-youtube-maxChatMessages', 'Messages (at most)', num(P, 'maxChatMessages', 1, 50000)) + field('pf-youtube-maxChatMinutes', 'Follow for (minutes)', num(P, 'maxChatMinutes', 1, 240)) + '</div>';
    } else {
      opts = '<div class="sc-fields">' + (f.type === 'video' ? '' : field('pf-youtube-maxVideos', 'Videos (at most)', num(P, 'maxVideos', 1, 500))) + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px">' +
        check(P, 'viral', 'Add a viral score to each video <span class="text-muted">(views ÷ the channel\'s average and subscribers: not viral &lt; 1, does well 1–2, viral &gt; 2)</span>') +
        check(P, 'includeComments', 'Collect comments', true) + '</div>' +
        (f.includeComments ? '<div class="sc-fields">' + field('pf-youtube-commentVideos', 'Of the first … videos', num(P, 'commentVideos', 1, 500)) +
          field('pf-youtube-commentsPerVideo', 'Comments per video', num(P, 'commentsPerVideo', 1, 5000)) +
          field('pf-youtube-commentOrder', 'Comment order', select(P, 'commentOrder', [['relevance', 'Top comments'], ['time', 'Newest first']])) + '</div>' + check(P, 'includeReplies', 'Include replies') : '');
    }
    opts += '<div class="sc-fields" style="margin-top:10px">' + field('pf-youtube-quotaBudget', 'Quota budget for this job', num(P, 'quotaBudget', 50, 100000), '<span id="pf-yt-quota"></span>') + '</div>';
    return '<div class="sc-grid"><div class="card"><div class="card-title">What to collect</div>' +
      field('pf-youtube-type', 'From YouTube', select(P, 'type', types)) + target + '</div>' +
      '<div class="card"><div class="card-title">Options</div>' + opts + '</div></div>';
  }

  function youtubeTarget() {
    const f = form.youtube;
    if (f.type === 'video') return { type: 'video', videos: f.videos };
    if (f.type === 'search') return { type: 'search', query: f.query, order: f.order, videoDuration: f.videoDuration, publishedAfter: f.publishedAfter || null, publishedBefore: f.publishedBefore || null, oldestFirst: !!f.oldestFirst, titleMustContain: !!f.titleMustContain };
    if (f.type === 'channel') return { type: 'channel', channel: f.channel };
    if (f.type === 'playlist') return { type: 'playlist', playlist: f.playlist };
    return { type: 'livechat', video: f.video };
  }
  const int = v => (v === '' || v === null || v === undefined ? undefined : Number(v));
  function youtubeOptions() {
    const f = form.youtube;
    return { maxVideos: int(f.maxVideos), includeComments: !!f.includeComments, commentVideos: int(f.commentVideos), commentsPerVideo: int(f.commentsPerVideo), commentOrder: f.commentOrder,
      includeReplies: !!f.includeReplies, viral: !!f.viral, includePlaylists: !!f.includePlaylists, maxChatMessages: int(f.maxChatMessages), maxChatMinutes: int(f.maxChatMinutes), quotaBudget: int(f.quotaBudget) };
  }

  /* ── X ───────────────────────────────────── */
  function xKeyHTML(st) {
    const mine = ownXToken();
    return '<div class="sc-api-row">' + (mine
      ? '<span class="badge badge-green">Your X bearer token</span> <span class="text-second">…' + esc(mine.slice(-4)) + ' — kept in this browser, sent only with your jobs.</span> <button class="btn btn-ghost btn-sm" onclick="ScraperPlatforms.removeKey(\'x\')">Remove</button>'
      : st.serverToken ? '<span class="badge badge-blue">This server\'s X token</span> <span class="text-second">Shared by everyone on this server. Add your own to use your own X plan.</span>'
        : '<span class="badge badge-amber">No X API token</span> <span class="text-second">Add one to collect from X.</span>') + '</div>' +
      '<details class="sc-details"' + (!mine && !st.serverToken ? ' open' : '') + '><summary>' + (mine ? 'Replace your token' : 'Use your own X API bearer token') + '</summary>' +
        '<ol class="form-hint" style="margin:8px 0 8px 18px"><li>developer.x.com → your Project\'s App → Keys and tokens → Bearer Token.</li><li>Reading posts needs an X API plan that includes search (X bills for it); the full archive needs a higher plan. Recent search covers the last 7 days.</li></ol>' +
        '<div class="sc-inline"><input class="form-input" id="pf-x-key" type="password" autocomplete="off" placeholder="X API bearer token"><button class="btn btn-secondary btn-sm" onclick="ScraperPlatforms.saveKey(\'x\')">Save token</button></div></details>';
  }

  function xFields() {
    const f = form.x, P = 'x';
    let target = '';
    if (f.type === 'search') {
      target = field('pf-x-query', 'Search for', text(P, 'query', 'e.g. "climate strike" lang:en -is:retweet'), 'X\'s search operators work: from:, lang:, -is:retweet, has:links …') +
        '<div class="sc-fields">' + field('pf-x-sort', 'Show', select(P, 'sort', [['latest', 'Latest'], ['top', 'Top (most relevant)']])) +
        field('pf-x-startTime', 'From', text(P, 'startTime', '', 'date')) + field('pf-x-endTime', 'Until', text(P, 'endTime', '', 'date')) + '</div>' +
        check(P, 'archive', 'Search the full archive (needs an X plan with full-archive search)');
    } else if (f.type === 'user') {
      target = field('pf-x-username', 'User', text(P, 'username', '@username or x.com/username')) +
        '<div style="display:flex;flex-direction:column;gap:6px">' + check(P, 'excludeReplies', 'Leave out replies') + check(P, 'excludeReposts', 'Leave out reposts') + '</div>';
    } else target = field('pf-x-posts', 'Posts', area(P, 'posts', 'One post URL or ID per line'));
    return '<div class="sc-grid"><div class="card"><div class="card-title">What to collect</div>' +
      field('pf-x-type', 'From X', select(P, 'type', [['search', 'Search posts'], ['user', 'A user\'s posts'], ['posts', 'Specific posts']])) + target + '</div>' +
      '<div class="card"><div class="card-title">Options</div>' + (f.type === 'posts' ? '<p class="form-hint">Every post you list is read (up to 1,000).</p>' : field('pf-x-maxPosts', 'Posts (at most)', num(P, 'maxPosts', 1, 10000))) +
      '<p class="form-hint">Each post keeps the author\'s name and handle, the date, text, replies, reposts, likes, quotes, bookmarks and views (when X reports them).</p></div></div>';
  }

  function xTarget() {
    const f = form.x;
    if (f.type === 'search') return { type: 'search', query: f.query, sort: f.sort, startTime: f.startTime || null, endTime: f.endTime || null, archive: !!f.archive };
    if (f.type === 'user') return { type: 'user', username: f.username, excludeReplies: !!f.excludeReplies, excludeReposts: !!f.excludeReposts };
    return { type: 'posts', posts: f.posts };
  }

  /* ── Rendering ───────────────────────────── */
  function render(platform) {
    const el = $('sc-platform');
    if (!el || !host) return;
    const st = (host.status() && host.status().platforms) || null;
    if (platform === 'linkedin') {
      el.innerHTML = '<div class="card"><div class="card-title">LinkedIn</div>' +
        '<p class="text-second" style="font-size:13.5px">LinkedIn isn\'t available. It has no API for reading other people\'s profiles or posts, and its User Agreement forbids collecting them automatically behind its login — tools that do it run on someone\'s logged-in session and get accounts restricted.</p>' +
        '<p class="text-second" style="font-size:13.5px;margin-top:8px">If you have LinkedIn posts in a spreadsheet (for example your own posts from LinkedIn\'s "Get a copy of your data"), bring them in with <a href="#import">Import Data</a> and code them like any other posts.</p></div>';
      return;
    }
    if (!st) { el.innerHTML = '<div class="card"><span class="text-muted">Checking the scraper…</span></div>'; return; }
    const ps = st[platform];
    if (!ps || !ps.enabled) { el.innerHTML = '<div class="card"><span class="text-second">' + (platform === 'youtube' ? 'YouTube' : 'X') + ' collection is turned off on this server.</span></div>'; return; }
    const name = platform === 'youtube' ? 'YouTube' : 'X (Twitter)';
    el.innerHTML = '<div class="card sc-api" style="margin-bottom:16px"><div class="card-title">' + name + ' API access</div>' + (platform === 'youtube' ? youtubeKeyHTML(ps) : xKeyHTML(ps)) + '</div>' +
      (platform === 'youtube' ? youtubeFields() : xFields()) +
      '<div class="sc-runbar"><span class="form-hint">Through ' + name + '\'s official API' + (platform === 'youtube' ? ' (YouTube Data API v3)' : ' (X API v2)') + '. Requests use this server\'s network route.</span>' +
        '<button class="btn btn-primary" id="pf-start" onclick="ScraperPlatforms.start(\'' + platform + '\')">Start ' + (platform === 'youtube' ? 'YouTube' : 'X') + ' job</button>' +
        '<div class="form-error" id="pf-error" role="alert"></div></div>';
    if (platform === 'youtube') updateQuota();
  }

  function saveKey(platform) {
    const input = $(platform === 'youtube' ? 'pf-yt-key' : 'pf-x-key');
    const v = input ? input.value.trim().replace(/^Bearer\s+/i, '') : '';
    if (platform === 'youtube' && !/^[A-Za-z0-9_-]{20,100}$/.test(v)) { App.notify('That doesn\'t look like a YouTube (Google) API key.', 'warning'); return; }
    if (platform === 'x' && !/^[A-Za-z0-9%._~+/=-]{20,400}$/.test(v)) { App.notify('That doesn\'t look like an X API bearer token.', 'warning'); return; }
    const kept = setKey(platform, v);
    App.notify(kept ? 'Saved in this browser' : 'Saved until you close this page (this browser doesn\'t allow storing it)', 'success');
    render(platform);
  }
  function removeKey(platform) { setKey(platform, null); render(platform); }

  async function start(platform) {
    const err = $('pf-error');
    if (err) err.textContent = '';
    const body = platform === 'youtube'
      ? { mode: 'platform', platform, target: youtubeTarget(), options: youtubeOptions() }
      : { mode: 'platform', platform, target: xTarget(), options: { maxPosts: int(form.x.maxPosts) } };
    if (platform === 'youtube' && ownYouTubeKey()) body.youtubeApiKey = ownYouTubeKey();
    if (platform === 'x' && ownXToken()) body.xBearerToken = ownXToken();
    const btn = $('pf-start');
    if (btn) btn.disabled = true;
    try { await host.startJob(body); }
    catch (e) { if (err) err.textContent = e.message; App.notify(e.message, 'error', 6000); }
    finally { if (btn) btn.disabled = false; }
  }

  // What a resumed own-key job needs again → body fields, or null when missing
  function resumeFields(job) {
    if (!job || job.mode !== 'platform' || job.keySource !== 'own') return {};
    const p = job.target && job.target.platform;
    if (p === 'youtube') return ownYouTubeKey() ? { youtubeApiKey: ownYouTubeKey() } : null;
    if (p === 'x') return ownXToken() ? { xBearerToken: ownXToken() } : null;
    return {};
  }

  function attach(h) { host = h; }

  return { attach, render, set, saveKey, removeKey, start, resumeFields, quotaEstimate };
})();
