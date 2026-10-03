// ── Survey Studio API ─────────────────────────────────────────────────────────
// Two routers with different audiences:
//
//   /api/surveys/*         the editor (MetaCode's own pages; state changes only
//                          from the same origin): drafts, autosave, publishing,
//                          versions, responses, the shared library.
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

const MAX_DOC_BYTES = Core.LIMITS.docBytes;

class ApiError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}

function sendError(res, err) {
  if (res.headersSent) return;
  if (err instanceof ApiError) return res.status(err.status).json({ error: { type: err.type, message: err.message } });
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

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

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

  /* ── Editor API ───────────────────────────── */
  const router = express.Router();
  router.use(sameOriginOnly);
  router.use(express.json({ limit: '26mb' }));

  router.get('/', wrap(async (req, res) => {
    res.json({ surveys: await store.list(), dataDir: opts.exposeDataDir ? store.dir : undefined });
  }));

  router.post('/', wrap(async (req, res) => {
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
    const rec = await store.create(doc);
    res.status(201).json({ survey: rec, problems });
  }));

  router.get('/library', wrap(async (req, res) => { res.json({ library: await store.library() }); }));

  router.put('/library', wrap(async (req, res) => {
    const lib = req.body && req.body.library;
    if (!lib || typeof lib !== 'object') throw new ApiError(400, 'invalid_request', 'Send { library: { components, styles, templates } }.');
    const pick = (arr, max) => (Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object' && typeof x.id === 'string').slice(0, max) : []);
    const clean = { components: pick(lib.components, 500), styles: pick(lib.styles, 500), templates: pick(lib.templates, 200) };
    if (Buffer.byteLength(JSON.stringify(clean)) > MAX_DOC_BYTES) throw new ApiError(413, 'too_large', 'The library is too large.');
    await store.saveLibrary(clean);
    res.json({ library: clean });
  }));

  const load = async id => {
    const rec = await store.get(id);
    if (!rec) throw new ApiError(404, 'not_found', 'That survey doesn\'t exist (it may have been deleted).');
    return rec;
  };

  router.get('/:id', wrap(async (req, res) => {
    const rec = await load(req.params.id);
    const { doc, problems } = Core.normalizeDoc(rec.doc);
    res.json({ survey: Object.assign({}, rec, { doc }), problems });
  }));

  router.put('/:id', wrap(async (req, res) => {
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
    if (!(await store.remove(req.params.id))) throw new ApiError(404, 'not_found', 'That survey doesn\'t exist.');
    res.json({ ok: true });
  }));

  router.post('/:id/duplicate', wrap(async (req, res) => {
    const rec = await load(req.params.id);
    const { doc } = Core.normalizeDoc(rec.doc);
    doc.id = Core.uid('sv');
    doc.title = (doc.title + ' (copy)').slice(0, 300);
    const created = await store.create(doc);
    res.status(201).json({ survey: created });
  }));

  router.post('/:id/publish', wrap(async (req, res) => {
    const rec = await load(req.params.id);
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
    const out = await store.setPublishState(req.params.id, { open: !!(req.body && req.body.open) });
    if (!out) throw new ApiError(404, 'not_published', 'This survey hasn\'t been published.');
    res.json({ publish: out });
  }));

  router.delete('/:id/publish', wrap(async (req, res) => {
    const out = await store.setPublishState(req.params.id, { unpublish: true });
    if (!out) throw new ApiError(404, 'not_published', 'This survey hasn\'t been published.');
    res.json({ publish: out });
  }));

  router.get('/:id/versions', wrap(async (req, res) => {
    await load(req.params.id);
    res.json({ versions: await store.versions(req.params.id) });
  }));

  router.get('/:id/versions/:n', wrap(async (req, res) => {
    const v = await store.version(req.params.id, req.params.n);
    if (!v) throw new ApiError(404, 'not_found', 'That version doesn\'t exist.');
    res.json({ version: v });
  }));

  router.get('/:id/responses', wrap(async (req, res) => {
    await load(req.params.id);
    const list = await store.responses(req.params.id);
    res.json({ responses: list.map(({ tokenHash, ...r }) => r) });
  }));

  router.delete('/:id/responses/:rid', wrap(async (req, res) => {
    await load(req.params.id);
    const removed = await store.updateResponses(req.params.id, list => {
      const i = list.findIndex(r => r.id === req.params.rid);
      if (i === -1) return false;
      list.splice(i, 1);
      return true;
    });
    if (!removed) throw new ApiError(404, 'not_found', 'That response doesn\'t exist.');
    res.json({ ok: true });
  }));

  router.delete('/:id/responses', wrap(async (req, res) => {
    await load(req.params.id);
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
    res.json({ survey: { publicId: rec.publish.publicId, version: v.version, open: !!rec.publish.open, doc: v.doc } });
  }));

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
    const token = crypto.randomBytes(24).toString('hex');
    const now = new Date().toISOString();
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
      const now = new Date().toISOString();
      Object.assign(r, { answers: checked.answers, byKey: checked.byKey, score: checked.score, vars: checked.vars, path: sanitizePath(body.path), updatedAt: now,
        outcome: typeof body.outcome === 'string' ? body.outcome.slice(0, 500) : r.outcome });
      if (body.complete) { r.status = 'complete'; r.completedAt = now; }
      return r.status;
    }).catch(e => { if (e.problems) { res.status(422).json({ error: { type: e.type, message: e.message }, problems: e.problems }); return null; } throw e; });
    if (out === null) return;
    res.json({ responseId: req.params.rid, status: out });
  }));

  const pageHandler = (req, res, next) => {
    if (!/^[A-Za-z0-9]{4,40}$/.test(req.params.publicId)) return next();
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.sendFile(pagePath);
  };

  return { router, publicRouter, pageHandler, store };
}

module.exports = { createSurveys };
