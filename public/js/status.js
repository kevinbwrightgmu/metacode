/* ══════════════════════════════════════════════
   status.js — the status page (status.html)

   Reads /api/status every 30 seconds (and on "Refresh") and shows the
   overall state, each component with its last 24 hours, and incidents.
   On status.* hosts, links to MetaCode go to the main site, and if this
   host can't answer /api/status (e.g. the page is served from somewhere
   else), the main site's /api/status is used instead (it allows that).
   A 404 means the MetaCode server is older than this page: it needs a
   restart to run the version that has the status checks.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LABEL = { operational: 'Operational', degraded: 'Degraded', outage: 'Outage', off: 'Not set up', none: 'No data' };
  const REFRESH_MS = 30000;

  // On status.metac0.de, "MetaCode" links point at metac0.de
  const main = /^status\./i.test(location.hostname) ? location.protocol + '//' + location.host.replace(/^status\./i, '') : '';
  if (main) [['st-home', '/'], ['st-home2', '/'], ['st-app', '/app.html'], ['st-studio', '/studio.html']].forEach(([id, p]) => { const a = $(id); if (a) a.href = main + p; });

  const time = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateTime = iso => {
    const d = new Date(iso), today = new Date();
    return (d.toDateString() === today.toDateString() ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })) + ', ' + time(iso);
  };
  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }
  function duration(a, b) {
    const m = Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }

  function render(d) {
    const ov = $('st-overall');
    ov.className = 'st-overall is-' + d.status;
    ov.setAttribute('aria-busy', 'false');
    $('st-overall-title').textContent = d.label;
    $('st-overall-sub').textContent = 'Checked ' + ago(d.updatedAt) + ' · updates every 30 seconds';
    document.title = (d.status === 'operational' ? '' : '⚠ ') + 'MetaCode Status — ' + d.label;

    const bucket = d.window.bucketMs;
    const start = Date.parse(d.window.start);
    $('st-components').innerHTML = d.components.map(c => {
      const bars = c.history.map((s, i) => {
        const from = new Date(start + i * bucket).toISOString(), to = new Date(start + (i + 1) * bucket).toISOString();
        const label = time(from) + '–' + time(to) + ': ' + LABEL[s];
        return '<span class="is-' + s + '" title="' + esc(label) + '"></span>';
      }).join('');
      const counted = c.history.filter(s => s !== 'none' && s !== 'off').length;
      return '<li class="st-comp">' +
        '<div class="st-comp-row"><div><div class="st-comp-name">' + esc(c.name) + '</div><div class="st-comp-desc">' + esc(c.description) + '</div>' +
          (c.note ? '<div class="st-comp-note">' + esc(c.note) + '</div>' : '') + '</div>' +
          '<span class="st-chip is-' + c.status + '">' + LABEL[c.status] + '</span></div>' +
        '<div class="st-bars" role="img" aria-label="' + esc(c.name + ', last 24 hours: ' + (counted ? (c.uptime !== null ? c.uptime + '% operational' : '') : 'no data yet')) + '">' + bars + '</div>' +
        '<div class="st-bars-axis" aria-hidden="true"><span>24 h ago</span><span>' + (c.uptime !== null ? c.uptime + '% operational' : '') + '</span><span>Now</span></div>' +
      '</li>';
    }).join('');

    const since = Date.parse(d.startedAt);
    $('st-range').textContent = Date.now() - since < 24 * 3600 * 1000 ? 'Since ' + dateTime(d.startedAt) + ' (last 24 h)' : 'Last 24 hours';
    $('st-incidents').innerHTML = d.incidents.length ? d.incidents.map(i =>
      '<li class="st-incident"><span class="st-chip is-' + (i.resolvedAt ? 'operational' : i.status) + '">' + (i.resolvedAt ? 'Resolved' : LABEL[i.status]) + '</span>' +
        '<div class="st-incident-title">' + esc(i.name) + ': ' + esc(i.status === 'outage' ? 'outage' : 'degraded performance') + '</div>' +
        '<div class="st-incident-meta">' + esc(i.note) + ' · ' + esc(dateTime(i.startedAt)) + (i.resolvedAt ? ' – ' + esc(time(i.resolvedAt)) + ' (' + duration(i.startedAt, i.resolvedAt) + ')' : ' · ongoing') + '</div></li>'
    ).join('') : '<li class="st-empty">No incidents in the last 24 hours.</li>';
    $('st-foot').textContent = 'Times are shown in your time zone. History is kept since the server last started (' + dateTime(d.startedAt) + ').';
  }

  // Where the status data comes from: this host, or (status.* hosts) the main site
  const sources = ['/api/status'].concat(main ? [main + '/api/status'] : []);
  let source = 0;
  async function fetchStatus() {
    let last = null;
    for (let k = 0; k < sources.length; k++) {
      const i = (source + k) % sources.length;
      try {
        const res = await fetch(sources[i], { cache: 'no-store' });
        if (!res.ok) { last = Object.assign(new Error('HTTP ' + res.status), { status: res.status }); continue; }
        source = i;                                  // keep using what worked
        return await res.json();
      } catch (e) { last = last || e; }
    }
    throw last || new Error('no answer');
  }
  function problem(title, sub) {
    const ov = $('st-overall');
    ov.className = 'st-overall is-unreachable';
    ov.setAttribute('aria-busy', 'false');
    $('st-overall-title').textContent = title;
    $('st-overall-sub').textContent = sub;
  }

  let timer = null;
  async function load() {
    const btn = $('st-refresh');
    btn.classList.add('is-spinning');
    btn.disabled = true;
    try {
      render(await fetchStatus());
    } catch (e) {
      if (e.status === 404) {
        problem('The status checks aren\'t running on this server',
          'The MetaCode server here is running an older version than this page. Restart it (stop it, then run npm start) and this page fills in.');
      } else {
        problem('MetaCode can\'t be reached', 'The status check didn\'t answer (' + e.message + '). Trying again in 30 seconds.');
      }
    } finally {
      btn.classList.remove('is-spinning');
      btn.disabled = false;
      clearTimeout(timer);
      timer = setTimeout(load, REFRESH_MS);
    }
  }
  $('st-refresh').addEventListener('click', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load();
})();
