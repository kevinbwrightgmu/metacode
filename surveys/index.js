// ── Survey Studio API ─────────────────────────────────────────────────────────
// Two routers with different audiences:
//
//   /api/surveys/*         the editor (MetaCode's own pages; state changes only
//                          from the same origin): publishing, versions,
//                          responses. Survey Studio keeps drafts and the
//                          library in the browser (survey-store.js); what is
//                          here belongs to the browser that sent it (the
//                          mc_owner cookie, owner.js) and only that browser
//                          can see or change it. The draft routes still work
//                          the same way, per browser.
//   /api/public/surveys/*  respondents: the published version of a survey and
//                          response submission. Nothing else is reachable
//                          with a public link.
//
// plus GET /s/:publicId, the respondent-facing page.
//
// Survey documents are validated and repaired with the same model the editor
// uses (public/js/survey/survey-core.js); submitted responses are checked
// against the published version with the same logic engine the respondent's
// browser ran (survey-logic.js).

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Core = require('../public/js/survey/survey-core.js');
const Logic = require('../public/js/survey/survey-logic.js');
const { SurveyStore, randomId } = require('./store');
const { ownerOf, isLoopback } = require('../owner');

const MAX_DOC_BYTES = Core.LIMITS.docBytes;

class ApiError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}

function sendError(res, err) {
  if (res.headersSent) return;
  if (err instanceof ApiError) return res.status(err.status).json({ error: Object.assign({ type: err.type, message: err.message }, err.extra || {}) });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: { type: 'too_large', message: 'The survey is too large to save (25 MB at most — large images are the usual cause).' } });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: { type: 'invalid_request', message: 'The request body isn\'t valid JSON.' } });
  console.error('[surveys] ' + (err && (err.stack || err.message)));
  res.status(500).json({ error: { type: 'internal_error', message: 'Something went wrong while handling the survey.' } });
}

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => sendError(res, err));

// State-changing editor requests must come from MetaCode's own pages.
function sameOriginOnly(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch (e) { host = null; }
    if (host !== req.headers.host) return sendError(res, new ApiError(403, 'forbidden_origin', 'Requests from other websites aren\'t allowed.'));
  }
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    return sendError(res, new ApiError(403, 'forbidden_origin', 'Requests from other websites aren\'t allowed.'));
  }
  next();
}

// Small fixed-window limiter for the public submission routes.
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'x';
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
    if (++h.n > limit) return sendError(res, new ApiError(429, 'rate_limited', 'Too many requests — please wait a minute and try again.'));
    if (hits.size > 10000) hits.clear();
    next();
  };
}

function cleanDoc(input) {
  const size = Buffer.byteLength(JSON.stringify(input || {}));
  if (size > MAX_DOC_BYTES) throw new ApiError(413, 'too_large', 'The survey is too large to save (25 MB at most — large images are the usual cause).');
  const { doc, problems } = Core.normalizeDoc(input);
  if (Object.keys(doc.elements).length > Core.LIMITS.elements) throw new ApiError(400, 'too_many_elements', 'A survey can have at most ' + Core.LIMITS.elements + ' elements.');
  return { doc, problems };
}

// The owner hash stays on the server.
function strip(rec) { const { owner, ...rest } = rec || {}; return rest; }   // eslint-disable-line no-unused-vars
const publicSummary = strip;

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/* ── Respondent information and session timelines ─────────────────────────
   Only what the published survey says it collects is stored, and only the
   survey's owner can read it (the editor API). The public API never returns it. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_TYPES = new Set(['start', 'page', 'focus', 'answer', 'skip', 'invalid', 'submit', 'away', 'back', 'resume', 'abandon']);
const MAX_EVENTS = 3000;
const MAX_EVENT_T = 14 * 24 * 3600 * 1000;

// One event from the respondent's browser → a clean copy, or null.
function cleanEvent(e) {
  if (!e || typeof e !== 'object' || !EVENT_TYPES.has(e.type)) return null;
  const t = Number(e.t);
  if (!Number.isFinite(t) || t < 0 || t > MAX_EVENT_T) return null;
  const out = { t: Math.round(t), type: e.type };
  ['page', 'from', 'q'].forEach(k => { if (typeof e[k] === 'string' && ID_RE.test(e[k])) out[k] = e[k]; });
  if (['next', 'back', 'jump'].includes(e.dir)) out.dir = e.dir;
  if (e.type === 'answer') {
    if (e.cleared === true) out.cleared = true;
    else if (Number.isInteger(e.len) && e.len >= 0 && e.len < 1e6) out.len = e.len;
    else if (e.value !== undefined) {
      const json = JSON.stringify(e.value);
      if (json !== undefined && json.length <= 600) out.value = e.value;
      else out.value = '[long value]';
    }
  }
  if (e.type === 'invalid') {
    if (Array.isArray(e.qs)) out.qs = e.qs.filter(x => typeof x === 'string' && ID_RE.test(x)).slice(0, 50);
    if (e.respondent === true) out.respondent = true;
  }
  return out;
}
function cleanEvents(list) { return (Array.isArray(list) ? list : []).slice(0, MAX_EVENTS).map(cleanEvent).filter(Boolean); }
// Appends events to a response's session timeline (capped).
function appendEvents(r, events) {
  if (!events.length) return;
  const sess = r.session || (r.session = {});
  sess.events = Array.isArray(sess.events) ? sess.events : [];
  const room = MAX_EVENTS - sess.events.length;
  if (room < events.length) sess.truncated = true;
  if (room > 0) sess.events.push(...events.slice(0, room));
}

const COUNTRY_RE = /^[A-Za-z]{2}$/;
// SURVEY_GEO_HEADERS: where the reverse proxy puts the IP-based location.
//   cloudflare                → CF-IPCountry and CF-Region (Cloudflare's visitor location headers)
//   <country-header>[,<region-header>]  e.g. X-Country-Code,X-Region (nginx GeoIP2, a load balancer…)
// Unset: no country/region (they are never guessed from anything else).
function geoConfig(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (v.toLowerCase() === 'cloudflare') return { country: 'cf-ipcountry', region: 'cf-region', source: 'cloudflare' };
  const [country, region] = v.split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9-]{1,60}$/.test(x));
  return country ? { country, region: region || null, source: 'header' } : null;
}
const normIp = ip => String(ip || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1').slice(0, 64);
const isPrivate = ip => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80:)/i.test(ip);
// The respondent's IP address as the server sees it. Behind a reverse proxy the
// address is only known when TRUST_PROXY tells Express which proxy to believe.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip'];
  const trusted = req.app && req.app.get('trust proxy');
  const sock = normIp(req.socket && req.socket.remoteAddress);
  if (forwarded && !trusted && isPrivate(sock)) return { ip: null, note: 'behind_proxy' };
  const ip = normIp(req.ip || sock);
  return ip ? { ip } : { ip: null, note: 'unknown' };
}
// Metadata the server derives for a response, limited to what the survey collects.
function derivedOf(req, priv, geo) {
  const d = priv.derived;
  if (!d.ip && !d.country && !d.region) return null;
  const out = {};
  if (d.ip) { const c = clientIp(req); out.ip = c.ip; if (c.note) out.ipNote = c.note; }
  if (d.country || d.region) {
    if (!geo) out.geoNote = 'not_configured';
    else {
      out.geoSource = geo.source;
      if (d.country) {
        const raw = String(req.headers[geo.country] || '').trim().toUpperCase();
        out.country = COUNTRY_RE.test(raw) && raw !== 'XX' && raw !== 'T1' ? raw : null;
      }
      if (d.region && geo.region) {
        const raw = String(req.headers[geo.region] || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
        out.region = raw || null;
      }
    }
  }
  return out;
}
// Participant-entered fields the published survey asks for → clean values; required ones are checked on completion.
function respondentOf(body, priv, complete) {
  const src = body && body.respondent && typeof body.respondent === 'object' ? body.respondent : {};
  const out = {};
  const problems = [];
  const take = (key, max) => { const v = typeof src[key] === 'string' ? src[key].replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : ''; if (v) out[key] = v; };
  if (priv.entered.name) take('name', 120);
  if (priv.entered.participantId || priv.link) take('participantId', 80);
  if (priv.link && out.participantId) out.participantIdSource = 'link';
  else if (out.participantId) out.participantIdSource = 'entered';
  if (complete) {
    if (priv.entered.name && priv.entered.name.required && !out.name) problems.push({ question: 'respondent', message: priv.entered.name.label + ' is required.' });
    const pidReq = (priv.entered.participantId && priv.entered.participantId.required) || (priv.link && priv.link.required);
    if (pidReq && !out.participantId) problems.push({ question: 'respondent', message: 'A participant code is required.' });
  }
  return { respondent: out, problems };
}
const recordingOf = (body, priv) => {
  if (priv.session === 'off') return null;
  const r = body && body.session && body.session.recording;
  return r === 'consent' && priv.session === 'consent' ? 'consent' : r === 'notice' && priv.session === 'notice' ? 'notice' : r === 'declined' ? 'declined' : null;
};

function deviceOf(ua) {
  const s = String(ua || '');
  if (/iPad|Tablet/i.test(s)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(s)) return 'mobile';
  return s ? 'desktop' : 'unknown';
}

function createSurveys(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir || process.env.SURVEY_DATA_DIR || path.join(__dirname, '..', 'survey-data');
  const store = new SurveyStore(path.resolve(dataDir));
  const pagePath = path.join(__dirname, '..', 'public', 'survey.html');
  const geo = geoConfig(opts.geoHeaders !== undefined ? opts.geoHeaders : process.env.SURVEY_GEO_HEADERS);
  // Plans and limits (accounts/): who may create and publish, and how many
  // responses an owner's surveys take. Without a policy nothing is limited.
  const policy = opts.policy || null;
  const allowed = async (req, action, ctx) => {
    if (!policy) return;
    const e = await policy.editor(req, action, ctx);
    if (e) throw Object.assign(new ApiError(e.status, e.type, e.message), { extra: e.extra });
  };
  const isLive = sum => !!(sum && sum.publish && !sum.publish.unpublished && sum.publish.open);
  const liveCount = async owner => (await store.list(owner)).filter(isLive).length;
  // Collects something only the higher plans include (IP, location, session timeline)
  const advancedOf = doc => { const p = Core.privacyOf(doc); return !!(p.derived.ip || p.derived.country || p.derived.region || p.session !== 'off'); };

  /* ── Editor API ───────────────────────────── */
  const router = express.Router();
  router.use(sameOriginOnly);
  router.use(express.json({ limit: '26mb' }));

  // Surveys saved by older versions (before surveys belonged to a browser):
  // the person running MetaCode on this computer can take them over.
  const localOnly = (req, res, next) => (isLoopback(req) ? next() : sendError(res, new ApiError(404, 'not_found', 'Not found.')));
  router.get('/legacy', localOnly, wrap(async (req, res) => { res.json({ surveys: (await store.list(null)).map(publicSummary), library: await store.legacyLibrary() }); }));
  router.post('/legacy/:id/claim', localOnly, wrap(async (req, res) => {
    const owner = ownerOf(req);
    if (!owner) throw new ApiError(401, 'no_owner', 'This browser has no MetaCode identity yet — reload the page.');
    const rec = await store.claim(req.params.id, owner);
    if (!rec) throw new ApiError(404, 'not_found', 'That survey doesn\'t exist or was already imported.');
    res.json({ survey: strip(Object.assign({}, rec, { doc: Core.normalizeDoc(rec.doc).doc })) });
  }));

  // Everything else belongs to the browser that sends the request
  router.use((req, res, next) => {
    req.owner = ownerOf(req);
    if (!req.owner) return sendError(res, new ApiError(401, 'no_owner', 'This browser has no MetaCode identity yet — reload the page.'));
    next();
  });

  router.get('/', wrap(async (req, res) => {
    res.json({ surveys: (await store.list(req.owner)).map(publicSummary), dataDir: opts.exposeDataDir ? store.dir : undefined });
  }));

  router.post('/', wrap(async (req, res) => {
    await allowed(req, 'create');
    const body = req.body || {};
    let doc;
    let problems = [];
    if (body.doc) {
      ({ doc, problems } = cleanDoc(body.doc));
      doc.id = Core.uid('sv');   // imports and templates always get a fresh id
    } else {
      doc = Core.createSurvey({ title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 300) : 'Untitled survey' });
    }
    if (typeof body.title === 'string' && body.title.trim()) doc.title = body.title.trim().slice(0, 300);
    doc.meta = Object.assign({}, doc.meta, { createdAt: new Date().toISOString() });
    const rec = await store.create(doc, req.owner);
    res.status(201).json({ survey: strip(rec), problems });
  }));

  router.get('/library', wrap(async (req, res) => { res.json({ library: await store.library(req.owner) }); }));

  router.put('/library', wrap(async (req, res) => {
    await allowed(req, 'library');
    const lib = req.body && req.body.library;
    if (!lib || typeof lib !== 'object') throw new ApiError(400, 'invalid_request', 'Send { library: { components, styles, templates } }.');
    const pick = (arr, max) => (Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object' && typeof x.id === 'string').slice(0, max) : []);
    const clean = { components: pick(lib.components, 500), styles: pick(lib.styles, 500), templates: pick(lib.templates, 200) };
    if (Buffer.byteLength(JSON.stringify(clean)) > MAX_DOC_BYTES) throw new ApiError(413, 'too_large', 'The library is too large.');
    await store.saveLibrary(req.owner, clean);
    res.json({ library: clean });
  }));

  // Someone else's survey answers exactly like a missing one.
  const load = async (id, req) => {
    const rec = await store.get(id);
    if (!rec || !rec.owner || rec.owner !== req.owner) throw new ApiError(404, 'not_found', 'That survey doesn\'t exist (it may have been deleted).');
    return rec;
  };

  router.get('/:id', wrap(async (req, res) => {
    const rec = await load(req.params.id, req);
    const { doc, problems } = Core.normalizeDoc(rec.doc);
    res.json({ survey: strip(Object.assign({}, rec, { doc })), problems });
  }));

  router.put('/:id', wrap(async (req, res) => {
    await load(req.params.id, req);
    await allowed(req, 'save');
    const body = req.body || {};
    if (!body.doc) throw new ApiError(400, 'invalid_request', 'Send { doc, baseRevision }.');
    const { doc, problems } = cleanDoc(body.doc);
    doc.id = req.params.id;
    doc.meta = Object.assign({}, doc.meta, { updatedAt: new Date().toISOString() });
    const out = await store.save(req.params.id, doc, body.baseRevision, !!body.force);
    if (out.notFound) throw new ApiError(404, 'not_found', 'That survey doesn\'t exist (it may have been deleted).');
    if (out.conflict) return res.status(409).json({ error: { type: 'conflict', message: 'This survey was changed somewhere else (another tab or window) since you opened it.' }, revision: out.revision, updatedAt: out.updatedAt });
    res.json({ revision: out.record.revision, updatedAt: out.record.updatedAt, problems, publish: out.record.publish });
  }));

  router.delete('/:id', wrap(async (req, res) => {
    await load(req.params.id, req);
    if (!(await store.remove(req.params.id))) throw new ApiError(404, 'not_found', 'That survey doesn\'t exist.');
    res.json({ ok: true });
  }));

  router.post('/:id/duplicate', wrap(async (req, res) => {
    const rec = await load(req.params.id, req);
    await allowed(req, 'create');
    const { doc } = Core.normalizeDoc(rec.doc);
    doc.id = Core.uid('sv');
    doc.title = (doc.title + ' (copy)').slice(0, 300);
    const created = await store.create(doc, req.owner);
    res.status(201).json({ survey: strip(created) });
  }));

  router.post('/:id/publish', wrap(async (req, res) => {
    if (policy) {
      const existing = await store.get(req.params.id);
      const mine = existing && existing.owner === req.owner ? existing : null;
      const draft = req.body && req.body.doc ? cleanDoc(req.body.doc).doc : mine ? mine.doc : null;
      await allowed(req, 'publish', { liveCount: await liveCount(req.owner), alreadyLive: isLive(mine), advanced: draft ? advancedOf(Core.normalizeDoc(draft).doc) : false });
    }
    // A draft kept in the browser is sent along with its first publish
    if (req.body && req.body.doc && !(await store.get(req.params.id))) {
      if (!store.validId(req.params.id)) throw new ApiError(400, 'invalid_request', 'Invalid survey id.');
      const first = cleanDoc(req.body.doc).doc;
      first.id = req.params.id;
      await store.create(first, req.owner);
    }
    const rec = await load(req.params.id, req);
    // Publishing an explicit doc (the editor's current state) saves it first.
    let doc = rec.doc;
    if (req.body && req.body.doc) {
      const out = await store.save(req.params.id, cleanDoc(req.body.doc).doc, req.body.baseRevision, !!req.body.force);
      if (out.conflict) return res.status(409).json({ error: { type: 'conflict', message: 'This survey was changed somewhere else since you opened it.' }, revision: out.revision });
      doc = out.record.doc;
    }
    const { doc: clean } = Core.normalizeDoc(doc);
    const questions = Object.values(clean.elements).filter(e => Core.isQuestionType(e.type) && !e.hidden);
    const content = Object.values(clean.elements).filter(e => !e.hidden && e.type !== 'button' && e.type !== 'container');
    if (!content.length) throw new ApiError(400, 'empty_survey', 'Add some content before publishing.');
    const problems = Logic.ruleProblems(clean).filter(p => p.level !== 'warning');
    if (problems.length && !(req.body && req.body.ignoreProblems)) {
      return res.status(422).json({ error: { type: 'logic_problems', message: 'Fix the logic problems before publishing.' }, problems });
    }
    const publish = await store.publish(req.params.id, clean);
    const fresh = await store.get(req.params.id);
    res.json({ publish, revision: fresh.revision, questions: questions.length, url: '/s/' + publish.publicId });
  }));

  router.patch('/:id/publish', wrap(async (req, res) => {
    const rec = await load(req.params.id, req);
    if (req.body && req.body.open && !isLive(rec)) await allowed(req, 'reopen', { liveCount: await liveCount(req.owner), alreadyLive: false });
    const out = await store.setPublishState(req.params.id, { open: !!(req.body && req.body.open) });
    if (!out) throw new ApiError(404, 'not_published', 'This survey hasn\'t been published.');
    res.json({ publish: out });
  }));

  router.delete('/:id/publish', wrap(async (req, res) => {
    await load(req.params.id, req);
    const out = await store.setPublishState(req.params.id, { unpublish: true });
    if (!out) throw new ApiError(404, 'not_published', 'This survey hasn\'t been published.');
    res.json({ publish: out });
  }));

  router.get('/:id/versions', wrap(async (req, res) => {
    await load(req.params.id, req);
    res.json({ versions: await store.versions(req.params.id) });
  }));

  router.get('/:id/versions/:n', wrap(async (req, res) => {
    await load(req.params.id, req);
    const v = await store.version(req.params.id, req.params.n);
    if (!v) throw new ApiError(404, 'not_found', 'That version doesn\'t exist.');
    res.json({ version: v });
  }));

  router.get('/:id/responses', wrap(async (req, res) => {
    await load(req.params.id, req);
    const list = await store.responses(req.params.id);
    res.json({ responses: list.map(({ tokenHash, ...r }) => r) });
  }));

  router.delete('/:id/responses/:rid', wrap(async (req, res) => {
    await load(req.params.id, req);
    const removed = await store.updateResponses(req.params.id, list => {
      const i = list.findIndex(r => r.id === req.params.rid);
      if (i === -1) return false;
      list.splice(i, 1);
      return true;
    });
    if (!removed) throw new ApiError(404, 'not_found', 'That response doesn\'t exist.');
    res.json({ ok: true });
  }));

  // Data minimization: remove IP addresses, location, identity fields or session timelines from every response.
  router.post('/:id/responses/erase', wrap(async (req, res) => {
    await load(req.params.id, req);
    const what = req.body && req.body.what;
    if (!['ip', 'location', 'identity', 'timeline'].includes(what)) throw new ApiError(400, 'invalid_request', 'what must be ip, location, identity or timeline.');
    const n = await store.updateResponses(req.params.id, list => {
      let count = 0;
      list.forEach(r => {
        const d = r.respondent && r.respondent.derived;
        if (what === 'ip' && d && d.ip !== undefined) { delete d.ip; delete d.ipNote; d.ipErased = true; count++; }
        if (what === 'location' && d && (d.country !== undefined || d.region !== undefined)) { delete d.country; delete d.region; d.locationErased = true; count++; }
        if (what === 'identity' && r.respondent && (r.respondent.name || r.respondent.participantId)) { delete r.respondent.name; delete r.respondent.participantId; delete r.respondent.participantIdSource; r.respondent.identityErased = true; count++; }
        if (what === 'timeline' && r.session && Array.isArray(r.session.events)) { r.session.events = []; r.session.erased = true; count++; }
      });
      return count;
    });
    res.json({ ok: true, updated: n });
  }));

  router.delete('/:id/responses', wrap(async (req, res) => {
    await load(req.params.id, req);
    const n = await store.updateResponses(req.params.id, list => { const count = list.length; list.splice(0, list.length); return count; });
    res.json({ ok: true, deleted: n });
  }));

  /* ── Public (respondent) API ──────────────── */
  const publicRouter = express.Router();
  publicRouter.use(express.json({ limit: '1mb' }));
  const limit = rateLimiter(opts.rateLimit || 120, 60000);

  const published = async publicId => {
    const rec = await store.byPublicId(publicId);
    if (!rec) throw new ApiError(404, 'not_found', 'This survey link isn\'t valid or the survey is no longer available.');
    return rec;
  };

  publicRouter.get('/:publicId', wrap(async (req, res) => {
    const rec = await published(req.params.publicId);
    const v = await store.version(rec.id, rec.publish.version);
    if (!v) throw new ApiError(404, 'not_found', 'This survey isn\'t available.');
    res.set('Cache-Control', 'no-store');
    res.json({ survey: { publicId: rec.publish.publicId, version: v.version, open: !!rec.publish.open, doc: v.doc, balance: await balanceCounts(rec.id, v.doc) } });
  }));

  // For "assign … balanced" blocks: how many responses so far got each condition,
  // so a new participant is given one of the least-used conditions.
  async function balanceCounts(id, doc) {
    const names = new Set();
    const walk = list => (Array.isArray(list) ? list : []).forEach(a => {
      if (!a || typeof a !== 'object') return;
      if (a.type === 'assign' && a.method === 'balanced' && a.name) names.add(a.name);
      if (a.type === 'if') { walk(a.then); walk(a.else); }
      if (a.type === 'randomBranch') (a.branches || []).forEach(walk);
    });
    (doc.rules || []).forEach(r => { walk(r.then); walk(r.else); });
    if (!names.size) return {};
    const out = {};
    names.forEach(n => { out[n] = {}; });
    (await store.responses(id)).forEach(r => names.forEach(n => {
      const v = r.vars && r.vars[n];
      if (v !== undefined && v !== null && v !== '') out[n][String(v)] = (out[n][String(v)] || 0) + 1;
    }));
    return out;
  }

  async function versionDoc(rec, version) {
    const n = Number(version) || rec.publish.version;
    const v = await store.version(rec.id, n);
    if (!v) throw new ApiError(400, 'invalid_version', 'This version of the survey no longer exists — reload the page.');
    return v;
  }

  function record(payload, v, req) {
    const checked = Logic.validateSubmission(v.doc, payload);
    if (payload.complete && checked.errors.length) {
      throw Object.assign(new ApiError(422, 'invalid_response', 'Some answers are missing or invalid.'), { problems: checked.errors });
    }
    return checked;
  }

  const sanitizePath = p => (Array.isArray(p) ? p.filter(x => typeof x === 'string' && x.length < 80).slice(0, 500) : []);

  publicRouter.post('/:publicId/responses', limit, wrap(async (req, res) => {
    const rec = await published(req.params.publicId);
    if (!rec.publish.open) throw new ApiError(403, 'closed', 'This survey isn\'t accepting responses right now.');
    const body = req.body || {};
    const v = await versionDoc(rec, body.version);
    let checked;
    try { checked = record(body, v, req); } catch (e) { if (e.problems) return res.status(422).json({ error: { type: e.type, message: e.message }, problems: e.problems }); throw e; }
    const priv = Core.privacyOf(v.doc);
    const who = respondentOf(body, priv, !!body.complete);
    if (who.problems.length) return res.status(422).json({ error: { type: 'invalid_response', message: who.problems[0].message }, problems: who.problems });
    // The owner's plan: Survey Studio included, and responses left this month
    if (policy) { const e = await policy.response(rec); if (e) throw new ApiError(e.status, e.type, e.message); }
    const token = crypto.randomBytes(24).toString('hex');
    const now = new Date().toISOString();
    const derived = derivedOf(req, priv, geo);
    const respondent = Object.keys(who.respondent).length || derived ? Object.assign({}, who.respondent, derived ? { derived } : {}) : undefined;
    const recording = recordingOf(body, priv);
    const response = {
      id: randomId('r_', 10), version: v.version,
      status: body.complete ? 'complete' : 'in_progress',
      startedAt: typeof body.startedAt === 'string' && !Number.isNaN(Date.parse(body.startedAt)) ? body.startedAt : now,
      updatedAt: now, completedAt: body.complete ? now : null,
      answers: checked.answers, byKey: checked.byKey, score: checked.score, vars: checked.vars,
      path: sanitizePath(body.path), outcome: typeof body.outcome === 'string' ? body.outcome.slice(0, 500) : null,
      meta: { device: deviceOf(req.headers['user-agent']), language: String(req.headers['accept-language'] || '').split(',')[0].slice(0, 20) },
      tokenHash: sha(token)
    };
    if (respondent) response.respondent = respondent;
    if (recording) {
      response.session = { recording, startedAt: typeof (body.session || {}).startedAt === 'string' && !Number.isNaN(Date.parse(body.session.startedAt)) ? body.session.startedAt : response.startedAt, events: [] };
      if (recording !== 'declined') appendEvents(response, cleanEvents(body.events));
    }
    await store.updateResponses(rec.id, list => { list.push(response); });
    res.status(201).json({ responseId: response.id, token, status: response.status });
  }));

  publicRouter.put('/:publicId/responses/:rid', limit, wrap(async (req, res) => {
    const rec = await published(req.params.publicId);
    if (!rec.publish.open) throw new ApiError(403, 'closed', 'This survey isn\'t accepting responses right now.');
    const body = req.body || {};
    const out = await store.updateResponses(rec.id, async list => {
      const r = list.find(x => x.id === req.params.rid);
      if (!r || r.tokenHash !== sha(body.token || '')) throw new ApiError(404, 'not_found', 'That response doesn\'t exist.');
      if (r.status === 'complete') throw new ApiError(409, 'already_complete', 'This response was already submitted.');
      const v = await versionDoc(rec, r.version);
      const checked = record(body, v, req);
      const priv = Core.privacyOf(v.doc);
      const who = respondentOf(body, priv, !!body.complete);
      if (who.problems.length) throw Object.assign(new ApiError(422, 'invalid_response', who.problems[0].message), { problems: who.problems });
      const now = new Date().toISOString();
      Object.assign(r, { answers: checked.answers, byKey: checked.byKey, score: checked.score, vars: checked.vars, path: sanitizePath(body.path), updatedAt: now,
        outcome: typeof body.outcome === 'string' ? body.outcome.slice(0, 500) : r.outcome });
      if (Object.keys(who.respondent).length) {
        const derived = r.respondent && r.respondent.derived;
        r.respondent = Object.assign({}, who.respondent, derived ? { derived } : {});
      }
      const recording = recordingOf(body, priv);
      if (recording && !r.session) r.session = { recording, startedAt: r.startedAt, events: [] };
      if (r.session && r.session.recording !== 'declined' && recording && recording !== 'declined') appendEvents(r, cleanEvents(body.events));
      if (body.complete) { r.status = 'complete'; r.completedAt = now; }
      return r.status;
    }).catch(e => { if (e.problems) { res.status(422).json({ error: { type: e.type, message: e.message }, problems: e.problems }); return null; } throw e; });
    if (out === null) return;
    res.json({ responseId: req.params.rid, status: out });
  }));

  // The last timeline events of a respondent who leaves before finishing (sent with keepalive).
  publicRouter.post('/:publicId/responses/:rid/events', limit, wrap(async (req, res) => {
    const rec = await published(req.params.publicId);
    const body = req.body || {};
    const out = await store.updateResponses(rec.id, async list => {
      const r = list.find(x => x.id === req.params.rid);
      if (!r || r.tokenHash !== sha(body.token || '')) throw new ApiError(404, 'not_found', 'That response doesn\'t exist.');
      if (r.status === 'complete') throw new ApiError(409, 'already_complete', 'This response was already submitted.');
      if (!r.session || r.session.recording === 'declined') return 0;
      const events = cleanEvents(body.events);
      appendEvents(r, events);
      r.updatedAt = new Date().toISOString();
      return events.length;
    });
    res.json({ ok: true, recorded: out });
  }));

  // Body-parser failures (bad JSON, too large) and anything else thrown outside
  // a handler get the same safe JSON errors instead of Express's stack page.
  const errorHandler = (err, req, res, next) => sendError(res, err); // eslint-disable-line no-unused-vars
  router.use(errorHandler);
  publicRouter.use(errorHandler);

  const pageHandler = (req, res, next) => {
    if (!/^[A-Za-z0-9]{4,40}$/.test(req.params.publicId)) return next();
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.sendFile(pagePath);
  };

  return { router, publicRouter, pageHandler, store };
}

module.exports = { createSurveys, cleanEvent, geoConfig, clientIp };
