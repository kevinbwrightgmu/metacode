/* ══════════════════════════════════════════════
   collector-view.js — the Scraper page: the Reddit Collector inside MetaCode

   Shows the Reddit Collector (collector/, served at /collector/) in the main
   area. Its bot reads public Reddit pages loaded through Scramjet and keeps
   what it collects in this browser. "Add to project" in the collector sends
   posts here (postMessage, same origin only): new ones are added to the
   project, posts already in it get their engagement numbers updated — the
   numbers Metrics shows. The older server-side scraper (Reddit API keys,
   custom code) stays available at #scraper-api.
   ══════════════════════════════════════════════ */

const CollectorView = (() => {
  const ADD = 'metacode-collector:add-to-project';
  const ADDED = 'metacode-collector:added';
  const ID = /^reddit_(?:c_)?[a-z0-9]{1,12}$/;
  const MAX_TEXT = 100000;

  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max || 2000) : '');

  // A post from the collector → a clean MetaCode post (only known fields, checked types).
  function cleanPost(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID.test(p.id)) return null;
    const e = p.engagement && typeof p.engagement === 'object' ? p.engagement : {};
    const s = p.source && typeof p.source === 'object' ? p.source : {};
    const permalink = typeof s.permalink === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*reddit\.com\//i.test(s.permalink) ? s.permalink : null;
    const source = { platform: 'reddit', type: s.type === 'comment' ? 'comment' : 'post', subreddit: str(s.subreddit, 30) || null, permalink };
    if (source.type === 'comment') { source.post_id = str(s.post_id, 20); source.parent_id = str(s.parent_id, 20); }
    return {
      id: p.id, text: str(p.text, MAX_TEXT), author: str(p.author, 60), timestamp: str(p.timestamp, 40),
      engagement: { likes: num(e.likes), shares: num(e.shares), comments: num(e.comments), views: num(e.views) },
      humanCodes: {}, aiCodes: {}, source
    };
  }

  // The newer numbers of a post the project already has (a number the collector
  // didn't send — e.g. views from an engagement CSV — is kept). null when nothing changed.
  function refreshedEngagement(old, latest) {
    const merged = Object.assign({}, old || {});
    let changed = false;
    Object.keys(latest).forEach(k => {
      if (latest[k] !== null && merged[k] !== latest[k]) { merged[k] = latest[k]; changed = true; }
    });
    return changed ? merged : null;
  }

  function addToProject(list) {
    if (!Array.isArray(list) || list.length > 50000) throw new Error('MetaCode received an unreadable list of posts.');
    const incoming = new Map();
    list.forEach(p => { const c = cleanPost(p); if (c) incoming.set(c.id, c); });
    const existing = App.getState().posts || [];
    let updated = 0;
    const kept = existing.map(p => {
      const again = incoming.get(p.id);
      if (!again) return p;
      incoming.delete(p.id);
      const engagement = refreshedEngagement(p.engagement, again.engagement);
      if (!engagement) return p;
      updated++;
      return Object.assign({}, p, { engagement });
    });
    const fresh = Array.from(incoming.values());
    if (fresh.length || updated) App.setState({ posts: kept.concat(fresh) });
    const total = kept.length + fresh.length;
    const stat = document.getElementById('stat-posts');
    if (stat) stat.textContent = total;
    if (fresh.length || updated) {
      App.notify((fresh.length ? 'Added ' + fresh.length + ' Reddit items to the project' : 'Nothing new to add') +
        (updated ? ' · updated the engagement of ' + updated + ' already there' : ''), 'success', 4500);
    }
    return { added: fresh.length, updated, total };
  }

  function onMessage(e) {
    const frame = document.getElementById('cv-frame');
    if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.type !== ADD) return;
    let reply;
    try { reply = Object.assign({ type: ADDED, id: d.id }, addToProject(d.posts)); }
    catch (err) { reply = { type: ADDED, id: d.id, error: err.message }; }
    frame.contentWindow.postMessage(reply, location.origin);
  }

  function render() {
    const container = document.getElementById('view-container');
    container.classList.add('view-container-flush');
    container.innerHTML = `
      <div class="cv-wrap">
        <div class="cv-bar">
          <div class="cv-intro">Collect public posts and comments: a bot reads subreddits or a search in the built-in Reddit browser (Scramjet).
            In <b>Data</b>, <b>Add to project</b> sends them here for coding — with their engagement for Metrics.</div>
          <a class="btn btn-ghost btn-sm" href="#scraper-api" title="The server-side scraper: Reddit API keys, RedditAPIs.com and custom code">Reddit API scraper</a>
        </div>
        <iframe id="cv-frame" class="cv-frame" src="/collector/?embed=1" title="Reddit Collector"></iframe>
        <div id="cv-missing" class="card cv-missing" hidden>
          <div class="card-title">The scraper isn't built yet</div>
          <p>The scraper is a separate app in the <code>collector/</code> folder. Build it once on the server, then reload this page:</p>
          <pre class="sc-pre">npm run collector:install
npm run collector:build</pre>
          <p class="form-hint">On a server managed by pm2, run these in the MetaCode folder and then <code>pm2 reload metacode</code> — see docs/deploy-vps.md.</p>
        </div>
      </div>`;
    window.addEventListener('message', onMessage);
    App.setViewCleanup(() => {
      window.removeEventListener('message', onMessage);
      container.classList.remove('view-container-flush');
    });
    // Not built yet: say how to build it instead of showing an error page
    fetch('/collector/', { method: 'HEAD', cache: 'no-store' }).then(res => {
      if (res.ok) return;
      const frame = document.getElementById('cv-frame');
      const missing = document.getElementById('cv-missing');
      if (frame) frame.hidden = true;
      if (missing) missing.hidden = false;
    }).catch(() => {});
  }

  return { render, _addToProject: addToProject };
})();
