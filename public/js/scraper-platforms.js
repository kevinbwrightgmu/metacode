/* ══════════════════════════════════════════════
   scraper-platforms.js — YouTube, X and LinkedIn forms on the Scraper page

   The platform menu's YouTube, X and LinkedIn panels. Jobs go to the same
   scraper API and job list as Reddit's: the current-job panel, results,
   exports and Add to project are shared (scraper.js). Users' own API keys
   are kept in this browser only and sent with their jobs; the server never
   stores them. A LinkedIn data archive is unzipped here, in the browser, and
   only its posts, comments, reactions and reposts tables (and the name from
   Profile.csv) are sent.
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
  const ownLinkedInToken = () => keys().linkedin || null;

  /* ── Form memory ─────────────────────────── */
  const DEFAULTS = {
    youtube: { type: 'search', videos: '', query: '', order: 'relevance', publishedAfter: '', publishedBefore: '', oldestFirst: false, titleMustContain: false, videoDuration: 'any',
      channel: '', playlist: '', video: '', maxVideos: 50, includeComments: false, commentVideos: 10, commentsPerVideo: 100, commentOrder: 'relevance', includeReplies: false,
      viral: false, includePlaylists: false, maxChatMessages: 2000, maxChatMinutes: 30, quotaBudget: 2000 },
    x: { type: 'search', query: '', sort: 'latest', startTime: '', endTime: '', archive: false, username: '', excludeReplies: false, excludeReposts: false, posts: '', maxPosts: 100 },
    linkedin: { type: 'posts', organization: '', sortBy: 'CREATED', maxPosts: 100, includeComments: false, commentPosts: 20, commentsPerPost: 100, includeStats: false,
      archivePosts: true, archiveComments: true, archiveReactions: false, since: '', until: '' }
  };
  let form = load();
  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(FORM) || 'null'); } catch (e) { saved = null; }
    return { youtube: Object.assign({}, DEFAULTS.youtube, saved && saved.youtube), x: Object.assign({}, DEFAULTS.x, saved && saved.x), linkedin: Object.assign({}, DEFAULTS.linkedin, saved && saved.linkedin) };
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


  /* ── LinkedIn ────────────────────────────── */
  function linkedinKeyHTML(st) {
    const mine = ownLinkedInToken();
    return '<div class="sc-api-row">' + (mine
      ? '<span class="badge badge-green">Your LinkedIn access token</span> <span class="text-second">…' + esc(mine.slice(-4)) + ' — kept in this browser, sent only with your jobs.</span> <button class="btn btn-ghost btn-sm" onclick="ScraperPlatforms.removeKey(\'linkedin\')">Remove</button>'
      : st.serverToken ? '<span class="badge badge-blue">This server\'s LinkedIn token</span> <span class="text-second">Shared by everyone on this server; it reads the Pages its member manages. Add your own to read yours.</span>'
        : '<span class="badge badge-amber">No LinkedIn access token</span> <span class="text-second">Add one to read your Pages\' posts. Importing your data archive needs none.</span>') + '</div>' +
      '<details class="sc-details"' + (!mine && !st.serverToken ? ' open' : '') + '><summary>' + (mine ? 'Replace your token' : 'Use your own LinkedIn access token') + '</summary>' +
        '<ol class="form-hint" style="margin:8px 0 8px 18px"><li>LinkedIn Developer Portal (developer.linkedin.com) → <b>Create app</b>, linked to a LinkedIn Page you are an admin of; verify it with the Page.</li>' +
        '<li>Products → request the <b>Community Management API</b>. LinkedIn reviews requests; it must be the only product on the app.</li>' +
        '<li>Docs and tools → <b>OAuth Token Tools</b> → Create token: pick the app, tick the scopes it offers that start with <code>r_organization</code> or <code>rw_organization</code>, sign in, copy the token. Tokens last 60 days.</li></ol>' +
        '<div class="form-hint" style="margin-bottom:8px">LinkedIn\'s API reads the Pages the token\'s member manages — not other people\'s profiles or posts.</div>' +
        '<div class="sc-inline"><input class="form-input" id="pf-li-key" type="password" autocomplete="off" placeholder="LinkedIn access token"><button class="btn btn-secondary btn-sm" onclick="ScraperPlatforms.saveKey(\'linkedin\')">Save token</button></div></details>';
  }

  // The archive the user picked: { files: [{ name, text }], error } (kept in memory, never stored)
  let archive = { files: [], error: '', reading: false };
  const ARCHIVE_TABLES = ['shares.csv', 'comments.csv', 'reactions.csv', 'instantreposts.csv', 'profile.csv'];
  const MAX_ARCHIVE_CHARS = 8 * 1024 * 1024;
  const wantedEntry = name => ARCHIVE_TABLES.includes(String(name).split(/[\\/]/).pop().toLowerCase());

  // The tables we need from a .zip, read in the browser (stored or deflated
  // entries, as LinkedIn's archives are). Nothing else in it is read.
  async function readZip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error(file.name + ' isn\'t a .zip archive.');
    const entries = dv.getUint16(end + 10, true);
    let p = dv.getUint32(end + 16, true);
    const out = [];
    for (let n = 0; n < entries; n++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error(file.name + ' is damaged or isn\'t a plain .zip. Unzip it and choose its CSV files instead.');
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!wantedEntry(name)) continue;
      if (flags & 1) throw new Error(file.name + ' is password-protected. Unzip it and choose its CSV files instead.');
      if (csize === 0xFFFFFFFF || usize > MAX_ARCHIVE_CHARS * 4) throw new Error(name + ' is too large to import here.');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = buf.subarray(start, start + csize);
      let bytes;
      if (method === 0) bytes = data;
      else if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser can\'t open .zip files. Unzip the archive and choose its CSV files instead.');
        bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      } else throw new Error(file.name + ' uses a compression this page can\'t open. Unzip it and choose its CSV files instead.');
      out.push({ name, text: new TextDecoder('utf-8').decode(bytes) });
    }
    return out;
  }

  // Profile.csv → just "First Name,Last Name" (the rest of it — address,
  // birth date… — never leaves the browser)
  function nameOnly(text) {
    const rows = [];
    let row = [], field = '', quoted = false, fresh = true;
    for (let i = 0; i < text.length && rows.length < 50; i++) {
      const c = text[i];
      if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; continue; }
      if (c === '"' && fresh) { quoted = true; fresh = false; }
      else if (c === ',') { row.push(field); field = ''; fresh = true; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; fresh = true; }
      else { field += c; fresh = false; }
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const norm = c => c.trim().replace(/^﻿/, '').toLowerCase();
    const h = rows.findIndex(r => r.some(c => norm(c) === 'first name') && r.some(c => norm(c) === 'last name'));
    if (h < 0 || !rows[h + 1]) return '';
    const col = name => rows[h].findIndex(c => norm(c) === name);
    const q = v => '"' + String(v || '').replace(/"/g, '""') + '"';
    return 'First Name,Last Name\n' + q(rows[h + 1][col('first name')]) + ',' + q(rows[h + 1][col('last name')]) + '\n';
  }

  async function pickArchive(list) {
    archive = { files: [], error: '', reading: true };
    showArchive();
    try {
      const files = [];
      for (const f of Array.from(list || [])) {
        if (/\.zip$/i.test(f.name)) files.push(...await readZip(f));
        else if (wantedEntry(f.name)) files.push({ name: f.name, text: await f.text() });
      }
      // One copy of each table (LinkedIn's full archive repeats the basic one)
      const seen = new Set();
      archive.files = files.filter(f => { const k = f.name.split(/[\\/]/).pop().toLowerCase(); return !seen.has(k) && (seen.add(k), true); })
        .map(f => (/profile\.csv$/i.test(f.name) ? { name: f.name, text: nameOnly(f.text) } : f)).filter(f => f.text);
      const chars = archive.files.reduce((a, f) => a + f.text.length, 0);
      if (!archive.files.some(f => !/profile\.csv$/i.test(f.name))) archive.error = 'No Shares.csv, Comments.csv, Reactions.csv or InstantReposts.csv in what you chose. Request the archive with Posts, Comments and Reactions included.';
      else if (chars > MAX_ARCHIVE_CHARS) archive.error = 'These tables hold over 8 MB of text — too much to import at once. Import posts, comments and reactions separately, or choose a date range after unzipping.';
    } catch (e) {
      archive.files = [];
      archive.error = e.message || 'Couldn\'t read that file.';
    }
    archive.reading = false;
    showArchive();
  }
  function showArchive() {
    const el = $('pf-li-archive-summary');
    if (!el) return;
    if (archive.reading) { el.innerHTML = '<span class="text-muted">Reading…</span>'; return; }
    if (archive.error) { el.innerHTML = '<span class="form-error" style="display:block">' + esc(archive.error) + '</span>'; return; }
    el.innerHTML = archive.files.length
      ? '<span class="badge badge-green">Ready</span> <span class="text-second">' + archive.files.map(f => esc(f.name.split(/[\\/]/).pop()) + ' (' + Math.max(1, Math.round(f.text.length / 1024)).toLocaleString() + ' KB)').join(', ') + '</span>'
      : '';
  }

  function linkedinFields() {
    const f = form.linkedin, P = 'linkedin';
    const types = [['posts', 'A Page\'s posts'], ['pages', 'Pages you manage'], ['archive', 'Your LinkedIn data archive']];
    let target = '', opts = '';
    if (f.type === 'posts') {
      target = field('pf-linkedin-organization', 'LinkedIn Page', text(P, 'organization', 'linkedin.com/company/… , its vanity name or numeric ID'), 'A Page the token\'s member is an admin of.') +
        field('pf-linkedin-sortBy', 'Order', select(P, 'sortBy', [['CREATED', 'Newest first'], ['LAST_MODIFIED', 'Recently edited first']]));
      opts = '<div class="sc-fields">' + field('pf-linkedin-maxPosts', 'Posts (at most)', num(P, 'maxPosts', 1, 5000)) + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px">' +
        check(P, 'includeStats', 'Add impressions, clicks, reposts and engagement <span class="text-muted">(needs an admin or analyst role on the Page)</span>') +
        check(P, 'includeComments', 'Collect comments', true) + '</div>' +
        (f.includeComments ? '<div class="sc-fields">' + field('pf-linkedin-commentPosts', 'Of the first … posts', num(P, 'commentPosts', 1, 500)) +
          field('pf-linkedin-commentsPerPost', 'Comments per post', num(P, 'commentsPerPost', 1, 1000)) + '</div>' : '') +
        '<p class="form-hint">Each post keeps its text, date, reactions by type, comment count and links; comments keep their text, date and likes. LinkedIn identifies commenters by member ID, not name.</p>';
    } else if (f.type === 'pages') {
      target = '<p class="form-hint">Lists the LinkedIn Pages the token\'s member helps manage — name, address, follower count and your role — so you can pick one for "A Page\'s posts".</p>';
      opts = '<p class="form-hint">Nothing to set.</p>';
    } else {
      target = '<ol class="form-hint" style="margin:10px 0 12px 18px"><li>linkedin.com → <b>Me</b> → Settings &amp; Privacy → Data privacy → <b>Get a copy of your data</b>.</li>' +
        '<li>Choose the files you want: tick <b>Posts</b>, <b>Comments</b> and <b>Reactions</b> (and <b>Profile</b> for your name) → Request archive. LinkedIn emails a link, usually within minutes.</li>' +
        '<li>Choose the downloaded .zip here (or the CSV files in it).</li></ol>' +
        field('pf-li-archive', 'Archive', '<input class="form-input" id="pf-li-archive" type="file" accept=".zip,.csv" multiple onchange="ScraperPlatforms.pickArchive(this.files)">',
          'Read in this browser: only Shares.csv, Comments.csv, Reactions.csv, InstantReposts.csv and your name from Profile.csv are sent. Messages, connections and the rest stay on your computer.') +
        '<div id="pf-li-archive-summary" style="margin-top:6px"></div>';
      opts = '<div style="display:flex;flex-direction:column;gap:6px">' + check(P, 'archivePosts', 'Your posts') + check(P, 'archiveComments', 'Your comments') +
        check(P, 'archiveReactions', 'Your reactions and reposts <span class="text-muted">(what you reacted to — no text)</span>') + '</div>' +
        '<div class="sc-fields">' + field('pf-linkedin-since', 'From', text(P, 'since', '', 'date')) + field('pf-linkedin-until', 'Until', text(P, 'until', '', 'date')) + '</div>';
    }
    return '<div class="sc-grid"><div class="card"><div class="card-title">What to collect</div>' +
      field('pf-linkedin-type', 'From LinkedIn', select(P, 'type', types)) + target + '</div>' +
      '<div class="card"><div class="card-title">Options</div>' + opts + '</div></div>';
  }

  function linkedinBody() {
    const f = form.linkedin;
    if (f.type === 'archive') {
      return { target: { type: 'archive', files: archive.files },
        options: { posts: !!f.archivePosts, comments: !!f.archiveComments, reactions: !!f.archiveReactions, since: f.since || null, until: f.until || null } };
    }
    if (f.type === 'pages') return { target: { type: 'pages' }, options: {} };
    return { target: { type: 'posts', organization: f.organization, sortBy: f.sortBy },
      options: { maxPosts: int(f.maxPosts), includeComments: !!f.includeComments, commentPosts: int(f.commentPosts), commentsPerPost: int(f.commentsPerPost), includeStats: !!f.includeStats } };
  }

  /* ── Rendering ───────────────────────────── */
  function render(platform) {
    const el = $('sc-platform');
    if (!el || !host) return;
    const st = (host.status() && host.status().platforms) || null;
    if (!st) { el.innerHTML = '<div class="card"><span class="text-muted">Checking the scraper…</span></div>'; return; }
    const ps = st[platform];
    const short = { youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn' }[platform];
    if (!ps || !ps.enabled) { el.innerHTML = '<div class="card"><span class="text-second">' + short + ' collection is turned off on this server.</span></div>'; return; }
    const name = platform === 'x' ? 'X (Twitter)' : short;
    const archiveMode = platform === 'linkedin' && form.linkedin.type === 'archive';
    const keyHTML = platform === 'youtube' ? youtubeKeyHTML(ps) : platform === 'x' ? xKeyHTML(ps) : linkedinKeyHTML(ps);
    const via = archiveMode ? 'Read from the archive you choose; nothing is requested from LinkedIn.'
      : 'Through ' + name + '\'s official API' + ({ youtube: ' (YouTube Data API v3)', x: ' (X API v2)', linkedin: ' (Community Management API)' }[platform]) + '. Requests use this server\'s network route.';
    el.innerHTML = (archiveMode ? '' : '<div class="card sc-api" style="margin-bottom:16px"><div class="card-title">' + name + ' API access</div>' + keyHTML + '</div>') +
      (platform === 'youtube' ? youtubeFields() : platform === 'x' ? xFields() : linkedinFields()) +
      '<div class="sc-runbar"><span class="form-hint">' + via + '</span>' +
        '<button class="btn btn-primary" id="pf-start" onclick="ScraperPlatforms.start(\'' + platform + '\')">' + (archiveMode ? 'Import archive' : 'Start ' + short + ' job') + '</button>' +
        '<div class="form-error" id="pf-error" role="alert"></div></div>';
    if (platform === 'youtube') updateQuota();
    if (archiveMode) showArchive();
  }

  function saveKey(platform) {
    const input = $({ youtube: 'pf-yt-key', x: 'pf-x-key', linkedin: 'pf-li-key' }[platform]);
    const v = input ? input.value.trim().replace(/^Bearer\s+/i, '') : '';
    if (platform === 'youtube' && !/^[A-Za-z0-9_-]{20,100}$/.test(v)) { App.notify('That doesn\'t look like a YouTube (Google) API key.', 'warning'); return; }
    if (platform === 'x' && !/^[A-Za-z0-9%._~+/=-]{20,400}$/.test(v)) { App.notify('That doesn\'t look like an X API bearer token.', 'warning'); return; }
    if (platform === 'linkedin' && !/^[A-Za-z0-9._~+/=-]{20,2000}$/.test(v)) { App.notify('That doesn\'t look like a LinkedIn access token.', 'warning'); return; }
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
      : platform === 'x' ? { mode: 'platform', platform, target: xTarget(), options: { maxPosts: int(form.x.maxPosts) } }
        : Object.assign({ mode: 'platform', platform }, linkedinBody());
    if (platform === 'linkedin' && form.linkedin.type === 'archive') {
      const problem = archive.reading ? 'The archive is still being read.' : archive.error || (!archive.files.length ? 'Choose your LinkedIn data archive first.' : '');
      if (problem) { if (err) err.textContent = problem; return; }
    }
    if (platform === 'youtube' && ownYouTubeKey()) body.youtubeApiKey = ownYouTubeKey();
    if (platform === 'x' && ownXToken()) body.xBearerToken = ownXToken();
    if (platform === 'linkedin' && form.linkedin.type !== 'archive' && ownLinkedInToken()) body.linkedinAccessToken = ownLinkedInToken();
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
    if (p === 'linkedin') return ownLinkedInToken() ? { linkedinAccessToken: ownLinkedInToken() } : null;
    return {};
  }

  function attach(h) { host = h; }

  return { attach, render, set, saveKey, removeKey, start, resumeFields, quotaEstimate, pickArchive };
})();
