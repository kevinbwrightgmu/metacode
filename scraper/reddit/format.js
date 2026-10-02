/* ══════════════════════════════════════════════
   format.js — Reddit JSON → MetaCode scraper records

   Shared by the standard scraper (Node) and the custom-code sandbox (QuickJS,
   where it is evaluated as plain source and exposed as ctx.reddit.normalize*).
   So: no Node APIs, no require(), nothing beyond ES2020.

   Every record is a flat-ish object with a `record_type` ("post", "comment",
   "subreddit", "user"). Reddit doesn't send every field on every endpoint,
   so every field defaults to null instead of being assumed present.
   ══════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RedditFormat = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var REDDIT_ORIGIN = 'https://www.reddit.com';

  function val(x) { return x === undefined ? null : x; }
  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
  function str(x) { return typeof x === 'string' ? x : null; }
  function bool(x) { return typeof x === 'boolean' ? x : null; }

  function toIso(utcSeconds) {
    if (typeof utcSeconds !== 'number' || !isFinite(utcSeconds)) return null;
    try { return new Date(utcSeconds * 1000).toISOString(); } catch (e) { return null; }
  }

  function edited(x) {
    if (x === false || x === undefined || x === null) return null;
    if (typeof x === 'number') return toIso(x);
    return null;
  }

  function permalink(p) {
    if (typeof p !== 'string' || !p) return null;
    return /^https?:\/\//.test(p) ? p : REDDIT_ORIGIN + p;
  }

  function stripPrefix(fullname) {
    return typeof fullname === 'string' ? fullname.replace(/^t\d_/, '') : null;
  }

  function httpUrl(x) {
    return typeof x === 'string' && /^https?:\/\//.test(x) ? x : null;
  }

  // Images, videos and galleries, as far as the listing says.
  function extractMedia(d) {
    if (!d || typeof d !== 'object') return null;
    var thumbnail = httpUrl(d.thumbnail);
    if (d.is_gallery && d.media_metadata && d.gallery_data && Array.isArray(d.gallery_data.items)) {
      var items = [];
      d.gallery_data.items.forEach(function (it) {
        var meta = it && d.media_metadata[it.media_id];
        var src = meta && meta.s ? (meta.s.u || meta.s.gif || meta.s.mp4) : null;
        if (src) items.push({ url: src, caption: str(it.caption), mime: str(meta.m) });
      });
      return { type: 'gallery', url: items.length ? items[0].url : null, thumbnail: thumbnail, items: items };
    }
    var video = d.secure_media && d.secure_media.reddit_video ? d.secure_media.reddit_video
              : (d.media && d.media.reddit_video ? d.media.reddit_video : null);
    if (d.is_video && video) {
      return { type: 'video', url: str(video.fallback_url), thumbnail: thumbnail, duration: num(video.duration), items: [] };
    }
    var preview = d.preview && Array.isArray(d.preview.images) && d.preview.images[0] && d.preview.images[0].source
      ? d.preview.images[0].source.url : null;
    if (d.post_hint === 'image') {
      return { type: 'image', url: httpUrl(d.url_overridden_by_dest || d.url) || preview, thumbnail: thumbnail, items: [] };
    }
    if (d.is_self) return null;
    var link = httpUrl(d.url_overridden_by_dest || d.url);
    if (link || preview) return { type: d.post_hint === 'rich:video' ? 'embed' : 'link', url: link, thumbnail: thumbnail || preview, items: [] };
    return null;
  }

  function normalizePost(d) {
    d = d || {};
    return {
      record_type:   'post',
      post_id:       str(d.id),
      fullname:      str(d.name),
      title:         str(d.title),
      author:        str(d.author),
      subreddit:     str(d.subreddit),
      url:           httpUrl(d.url_overridden_by_dest || d.url),
      permalink:     permalink(d.permalink),
      created_at:    toIso(d.created_utc),
      created_utc:   num(d.created_utc),
      edited_at:     edited(d.edited),
      score:         num(d.score),
      upvote_ratio:  num(d.upvote_ratio),
      num_comments:  num(d.num_comments),
      selftext:      str(d.selftext),
      flair:         str(d.link_flair_text),
      author_flair:  str(d.author_flair_text),
      domain:        str(d.domain),
      is_self:       bool(d.is_self),
      over_18:       bool(d.over_18),
      spoiler:       bool(d.spoiler),
      stickied:      bool(d.stickied),
      locked:        bool(d.locked),
      archived:      bool(d.archived),
      distinguished: str(d.distinguished),
      num_crossposts: num(d.num_crossposts),
      total_awards:  num(d.total_awards_received),
      media:         extractMedia(d)
    };
  }

  function normalizeComment(d, extra) {
    d = d || {};
    extra = extra || {};
    var parent = str(d.parent_id);
    return {
      record_type:   'comment',
      comment_id:    str(d.id),
      fullname:      str(d.name),
      post_id:       stripPrefix(d.link_id) || val(extra.post_id),
      parent_id:     parent,
      parent_type:   parent ? (parent.indexOf('t3_') === 0 ? 'post' : 'comment') : null,
      author:        str(d.author),
      subreddit:     str(d.subreddit),
      body:          str(d.body),
      score:         num(d.score),
      created_at:    toIso(d.created_utc),
      created_utc:   num(d.created_utc),
      edited_at:     edited(d.edited),
      permalink:     permalink(d.permalink),
      depth:         num(d.depth),
      is_submitter:  bool(d.is_submitter),
      stickied:      bool(d.stickied),
      distinguished: str(d.distinguished),
      controversiality: num(d.controversiality),
      author_flair:  str(d.author_flair_text),
      post_title:    str(d.link_title) || val(extra.post_title),
      post_permalink: permalink(d.link_permalink) || val(extra.post_permalink)
    };
  }

  function normalizeSubreddit(d) {
    d = d || {};
    return {
      record_type:   'subreddit',
      subreddit_id:  str(d.id),
      name:          str(d.display_name),
      title:         str(d.title),
      description:   str(d.public_description),
      subscribers:   num(d.subscribers),
      active_users:  num(d.active_user_count) !== null ? num(d.active_user_count) : num(d.accounts_active),
      created_at:    toIso(d.created_utc),
      over_18:       bool(d.over18),
      subreddit_type: str(d.subreddit_type),
      lang:          str(d.lang),
      url:           permalink(d.url),
      icon:          httpUrl(d.community_icon ? String(d.community_icon).split('?')[0] : d.icon_img)
    };
  }

  function normalizeUser(d) {
    d = d || {};
    return {
      record_type:   'user',
      user_id:       str(d.id),
      name:          str(d.name),
      created_at:    toIso(d.created_utc),
      link_karma:    num(d.link_karma),
      comment_karma: num(d.comment_karma),
      total_karma:   num(d.total_karma),
      is_employee:   bool(d.is_employee),
      is_mod:        bool(d.is_mod),
      verified:      bool(d.verified),
      icon:          httpUrl(d.icon_img ? String(d.icon_img).split('?')[0] : null),
      profile_url:   d.name ? REDDIT_ORIGIN + '/user/' + d.name : null
    };
  }

  // Any Reddit "thing" ({kind, data}) → record, or null for kinds that
  // aren't content (e.g. "more" stubs).
  function normalizeThing(thing, extra) {
    if (!thing || typeof thing !== 'object' || !thing.data) return null;
    switch (thing.kind) {
      case 't3': return normalizePost(thing.data);
      case 't1': return normalizeComment(thing.data, extra);
      case 't5': return normalizeSubreddit(thing.data);
      case 't2': return normalizeUser(thing.data);
      default:   return null;
    }
  }

  // A comment tree (the second element of /comments/<id>.json) → flat list in
  // reading order. "more" stubs (comments Reddit didn't include) are counted.
  function flattenComments(children, extra, limit) {
    var out = [];
    var more = 0;
    var max = typeof limit === 'number' && limit > 0 ? limit : Infinity;
    (function walk(list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || typeof c !== 'object') continue;
        if (c.kind === 'more') { more += (c.data && typeof c.data.count === 'number') ? c.data.count : 0; continue; }
        if (c.kind !== 't1') continue;
        if (out.length >= max) { more++; continue; }
        out.push(normalizeComment(c.data, extra));
        var replies = c.data && c.data.replies;
        if (replies && typeof replies === 'object' && replies.data) walk(replies.data.children);
      }
    })(children);
    return { comments: out, moreCount: more };
  }

  // Unique key for de-duplication.
  function recordKey(r) {
    if (!r) return null;
    if (r.fullname) return r.fullname;
    if (r.record_type === 'subreddit' && r.name) return 'sub:' + r.name.toLowerCase();
    if (r.record_type === 'user' && r.name) return 'user:' + r.name.toLowerCase();
    return null;
  }

  return {
    toIso: toIso, normalizePost: normalizePost, normalizeComment: normalizeComment,
    normalizeSubreddit: normalizeSubreddit, normalizeUser: normalizeUser,
    normalizeThing: normalizeThing, flattenComments: flattenComments,
    extractMedia: extractMedia, recordKey: recordKey
  };
});
