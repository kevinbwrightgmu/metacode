// ── Status page ───────────────────────────────────────────────────────────────
// status.metac0.de (or any host named status.*, or /status on the main site)
// shows whether MetaCode and the services it depends on are working.
//
//   GET /api/status → { status, label, updatedAt, startedAt, components: [...],
//                       window: { start, end, bucketMs }, incidents: [...] }
//
// Each component has a check function (given by server.js) that answers
// { status, note } — status is one of:
//   operational · degraded · outage · off (not set up / turned off here)
// Checks run every minute and whenever the page asks (at most every 5 s; the
// slow parts of a check cache their own results). Uptime counts at most one
// sample a minute per component, so page views don't skew it. The last 24 hours are kept in memory as 30-minute buckets (the
// worst status seen in each), plus the incidents — when a component left
// "operational" and when it came back. Memory resets when the server
// restarts; the page says since when it has data. Nothing secret is shown:
// no keys, addresses, file paths or error details.

const path = require('path');

const RANK = { operational: 0, off: 0, degraded: 1, outage: 2 };
const DAY = 24 * 3600 * 1000;

function createStatusMonitor(opts) {
  const components = opts.components;            // [{ id, name, description, check }]
  const intervalMs = opts.intervalMs || 60 * 1000;
  const bucketMs = opts.bucketMs || 30 * 60 * 1000;
  const windowMs = opts.windowMs || DAY;
  const now = opts.now || (() => Date.now());
  const startedAt = now();
  const state = new Map(components.map(c => [c.id, { status: 'operational', note: '', checkedAt: 0, sampledAt: 0, buckets: new Map(), samples: 0, up: 0 }]));
  const incidents = [];                          // newest first, at most 30
  let lastRun = 0, running = null, timer = null;

  async function runOne(c) {
    let out;
    try {
      out = await Promise.race([
        Promise.resolve().then(() => c.check()),
        new Promise(resolve => setTimeout(() => resolve({ status: 'outage', note: 'The check didn\'t finish in time.' }), opts.checkTimeoutMs || 15000).unref())
      ]);
    } catch (e) { out = { status: 'outage', note: 'The check failed.' }; }
    const status = RANK[out && out.status] !== undefined ? out.status : 'outage';
    const note = String((out && out.note) || '').slice(0, 200);
    const st = state.get(c.id);
    const t = now();
    // Incidents: leaving "operational" (worsening is recorded), coming back
    const open = incidents.find(i => i.component === c.id && !i.resolvedAt);
    if (RANK[status] > 0 && !open) incidents.unshift({ id: c.id + '-' + t, component: c.id, name: c.name, status, note, startedAt: new Date(t).toISOString(), resolvedAt: null });
    else if (RANK[status] > 0 && open) { if (RANK[status] > RANK[open.status]) open.status = status; open.note = note; }
    else if (RANK[status] === 0 && open) open.resolvedAt = new Date(t).toISOString();
    if (incidents.length > 30) incidents.length = 30;
    const changed = st.status !== status;
    st.status = status; st.note = note; st.checkedAt = t;
    if (status !== 'off') {
      if (t - st.sampledAt >= intervalMs * 0.8 || changed) {
        st.samples++;
        if (status === 'operational') st.up++;
        st.sampledAt = t;
      }
      const b = Math.floor(t / bucketMs) * bucketMs;
      const prev = st.buckets.get(b);
      if (!prev || RANK[status] > RANK[prev]) st.buckets.set(b, status);
      for (const k of st.buckets.keys()) if (k < t - windowMs - bucketMs) st.buckets.delete(k);
    }
  }

  function run() {
    if (running) return running;
    running = Promise.all(components.map(runOne)).then(() => { lastRun = now(); running = null; }, () => { running = null; });
    return running;
  }

  function overall() {
    const live = components.map(c => state.get(c.id)).filter(s => s.status !== 'off');
    const worst = live.reduce((m, s) => Math.max(m, RANK[s.status]), 0);
    const down = live.filter(s => s.status === 'outage').length;
    if (worst === 0) return { status: 'operational', label: 'All systems operational' };
    if (worst === 1) return { status: 'degraded', label: 'Some systems are degraded' };
    if (down > live.length / 2) return { status: 'outage', label: 'Major outage' };     // more than half are down
    return { status: 'outage', label: 'Partial outage' };
  }

  function snapshot() {
    const t = now();
    const first = Math.floor((t - windowMs) / bucketMs) * bucketMs + bucketMs;
    return Object.assign(overall(), {
      updatedAt: new Date(lastRun || t).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      window: { start: new Date(first).toISOString(), end: new Date(t).toISOString(), bucketMs },
      components: components.map(c => {
        const st = state.get(c.id);
        const history = [];
        for (let b = first; b <= t; b += bucketMs) history.push(b + bucketMs <= startedAt ? 'none' : (st.buckets.get(b) || (st.status === 'off' ? 'off' : 'none')));
        return {
          id: c.id, name: c.name, description: c.description || '', status: st.status, note: st.note,
          checkedAt: st.checkedAt ? new Date(st.checkedAt).toISOString() : null,
          uptime: st.samples ? Math.round(st.up / st.samples * 10000) / 100 : null,
          history
        };
      }),
      incidents: incidents.filter(i => !i.resolvedAt || Date.parse(i.resolvedAt) > t - windowMs).map(i => Object.assign({}, i))
    });
  }

  async function handler(req, res) {
    if (now() - lastRun > 5000) await run();
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');      // public, nothing secret
    res.json(snapshot());
  }

  return {
    run, snapshot, handler,
    start() { if (!timer) { timer = setInterval(() => run().catch(() => {}), intervalMs); timer.unref(); run().catch(() => {}); } },
    stop() { clearInterval(timer); timer = null; }
  };
}

// Serves the status page for status.* hosts (STATUS_HOST, default
// status.metac0.de, or any host whose name starts with "status.") and at
// /status on every host. On a status host, everything that isn't the page,
// its files or /api/status is sent to the main site (the same address
// without "status.").
function statusRoutes(opts) {
  const publicDir = opts.publicDir;
  const configured = () => String(process.env.STATUS_HOST || 'status.metac0.de').trim().toLowerCase();
  const isStatusHost = host => {
    const h = String(host || '').toLowerCase();
    return !!h && (h === configured() || h.startsWith('status.'));
  };
  const PAGE_FILES = /^\/(css\/(main|status)\.css|js\/status\.js|img\/[\w.-]+\.(png|svg|ico))$/;
  const page = (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'status.html'));
  };
  return {
    isStatusHost,
    // Before the app's static files and routes
    hostRouter(req, res, next) {
      if (!isStatusHost(req.hostname)) return next();
      if (req.path === '/' || req.path === '/index.html' || req.path === '/status' || req.path === '/status.html') return page(req, res);
      if (req.path === '/api/status' || PAGE_FILES.test(req.path)) return next();
      // Anything else belongs to the main site
      const host = String(req.headers.host || '').replace(/^status\./i, '');
      if (!host || isStatusHost(host)) return res.status(404).end();
      return res.redirect(302, req.protocol + '://' + host + req.originalUrl);
    },
    page
  };
}

module.exports = { createStatusMonitor, statusRoutes, RANK };
