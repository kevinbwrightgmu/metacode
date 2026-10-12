// ── Accounts, plans and limits ────────────────────────────────────────────────
// Sign-in is Supabase Auth (the browser signs in; the server verifies the token
// with Supabase — auth.js). Plans come from Stripe subscriptions (billing.js).
// What each plan includes is public/js/plans.js. This module:
//
//   • attach          middleware: req.account = the verified user (or null)
//   • router          /api/account   GET /config, GET /me, POST /claim
//   • billingRouter   /api/billing   POST /checkout, /portal, /sync
//   • webhook         POST /api/billing/webhook (raw body, Stripe-signed)
//   • guards          aiSingle, aiBatch, feature(name, { meter })
//   • policies        for Survey Studio (surveys/) and the Reddit Scraper (scraper/)
//   • upgradeGuard    the in-app browser's Wisp WebSocket
//
// With accounts off (no SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY) every guard
// lets everything through and MetaCode works as it did before.
//
// Errors use MetaCode's usual { error: { type, message } } shape:
//   401 sign_in_required · 402 plan_required · 429 limit_reached /
//   account_rate_limited · 503 account_unavailable — the pages (account.js)
//   turn these into a sign-in or upgrade dialog.
const express = require('express');
const Plans = require('../public/js/plans.js');
const { accountConfig } = require('./config');
const { createAuth } = require('./auth');
const { UsageStore, nextReset } = require('./usage');
const { createRateLimiter } = require('./rate');
const { createBilling, BillingError } = require('./billing');
const { ownerOf, browserOwnerOf, isLoopback } = require('../owner');

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = n => Number(n).toLocaleString('en-US');

function fail(status, type, message, extra) {
  const e = new Error(message);
  e.status = status; e.type = type; e.extra = extra || null;
  return e;
}
function send(res, e) {
  if (res.headersSent) return;
  if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
  res.status(e.status || 500).json({ error: Object.assign({ type: e.type || 'internal_error', message: e.message }, e.extra || {}) });
}

function createAccounts(opts) {
  opts = opts || {};
  const getConfig = opts.getConfig || (() => accountConfig(process.env));
  const usage = opts.usage || new UsageStore(getConfig().dataDir);
  const auth = createAuth(getConfig, { now: opts.now });
  const billing = createBilling({ getConfig, usage, now: opts.now });
  const rate = createRateLimiter({ now: opts.now });
  const claimers = [];
  const enabled = () => getConfig().enabled;

  /* ── Who is it, and what may they do? ───── */
  async function attach(req, res, next) {
    req.account = null;
    if (!enabled()) return next();
    const token = auth.tokenOf(req);
    if (!token) return next();
    try {
      const r = await auth.verify(token);
      if (r.user) req.account = r.user;
      else req.accountError = r.error;
    } catch (e) {
      req.accountError = 'unavailable';
    }
    next();
  }

  // → { enabled:false } | { enabled, user:null, reason } | { enabled, user, info, plan }
  async function contextOf(req) {
    if (!enabled()) return { enabled: false };
    if (req._accountCtx) return req._accountCtx;
    if (!req.account) return (req._accountCtx = { enabled: true, user: null, reason: req.accountError || null });
    usage.noteUser(req.account);
    const info = await billing.planFor(req.account);
    return (req._accountCtx = { enabled: true, user: req.account, info, plan: Plans.get(info.plan) });
  }

  function needUser(c, what) {
    if (c.user) return null;
    if (c.reason === 'unavailable') return fail(503, 'account_unavailable', 'MetaCode couldn\'t check your sign-in just now. Try again in a minute.');
    return fail(401, 'sign_in_required', (c.reason === 'expired' || c.reason === 'invalid' ? 'Your sign-in has expired. Sign in again to use ' : 'Sign in to use ') + what + '.');
  }
  function needFeature(c, feature, message) {
    if (c.plan.features[feature]) return null;
    if (c.info.error) return fail(503, 'account_unavailable', 'MetaCode couldn\'t check your subscription with Stripe just now. Try again in a minute.');
    const lowest = Plans.lowestWith(feature);
    const names = Plans.namesFrom(lowest.id);
    return fail(402, 'plan_required', message || (cap(Plans.FEATURES[feature].label) + ' is part of the ' + Plans.listNames(names) + ' plan' + (names.length > 1 ? 's' : '') + '.'),
      { feature, requiredPlan: lowest.id, plan: c.plan.id });
  }
  function limitError(c, meter, r) {
    const m = Plans.METERS[meter];
    const next = Plans.ORDER.map(Plans.get).find(p => p.rank > c.plan.rank && p.limits[m.limit] > r.limit) || null;
    const when = new Date(r.resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return fail(429, 'limit_reached',
      'You\'ve used all ' + fmt(r.limit) + ' ' + m.unit + ' ' + Plans.PERIODS[m.period].this + ' on the ' + c.plan.name + ' plan (' + m.label.toLowerCase() + '). ' +
      'It resets ' + (m.period === 'day' ? 'tomorrow' : 'on ' + (m.period === 'week' ? new Date(r.resetsAt).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) + ', ' : '') + when) + (next ? ' — or upgrade to ' + next.name + ' for ' + fmt(next.limits[m.limit]) + ' ' + Plans.PERIODS[m.period].a + '.' : '.'),
      { meter, used: r.used, limit: r.limit, resetsAt: r.resetsAt, plan: c.plan.id, upgradeTo: next ? next.id : null });
  }
  function perMinute(c, bucket, limit) {
    const r = rate.take(c.user.id + ':' + bucket, limit);
    if (r.ok) return null;
    const e = fail(429, 'account_rate_limited', 'Too many requests — the ' + c.plan.name + ' plan allows ' + limit + ' a minute. Try again in ' + r.retryAfter + ' s.', { retryAfterSeconds: r.retryAfter });
    e.retryAfter = r.retryAfter;
    return e;
  }

  /* ── AI ────────────────────────────────── */
  // POST /api/ai — one request. AI Coding's single-post requests (X-MetaCode-Feature:
  // coding) count as coded posts; everything else (assistant, column detection,
  // Test connection) as "other AI requests" per day. Failed answers aren't charged.
  async function aiSingle(req, res, next) {
    try {
      const c = await contextOf(req);
      if (!c.enabled) return next();
      const e = needUser(c, 'MetaCode\'s AI features') || perMinute(c, 'ai', c.plan.limits.aiRequestsPerMinute);
      if (e) return send(res, e);
      const meter = String(req.headers['x-metacode-feature'] || '').toLowerCase() === 'coding' ? 'aiPosts' : 'aiRequests';
      const r = usage.reserve(c.user.id, meter, 1, c.plan.limits[Plans.METERS[meter].limit]);
      if (!r.granted) return send(res, limitError(c, meter, r));
      res.on('finish', () => { if (res.statusCode >= 400) usage.release(c.user.id, meter, 1, r.period); });
      next();
    } catch (err) { next(err); }
  }

  // POST /api/ai/batch — AI Coding; each request is one post. Takes what's left of
  // the week's posts: the rest of the batch is answered with limit_reached
  // (req.aiAllowance), and req.settleAi(successes) gives back what didn't succeed.
  async function aiBatch(req, res, next) {
    try {
      const c = await contextOf(req);
      if (!c.enabled) return next();
      let e = needUser(c, 'AI Coding') || perMinute(c, 'ai', c.plan.limits.aiRequestsPerMinute);
      if (e) return send(res, e);
      const n = req.body && Array.isArray(req.body.requests) ? req.body.requests.length : 0;
      if (!n) return next();            // the route answers bad requests
      const releaseSlot = rate.acquire(c.user.id + ':batch', c.plan.limits.aiBatchesAtOnce);
      if (!releaseSlot) return send(res, fail(429, 'account_rate_limited', 'The ' + c.plan.name + ' plan runs ' + c.plan.limits.aiBatchesAtOnce + ' AI coding run' + (c.plan.limits.aiBatchesAtOnce === 1 ? '' : 's') + ' at a time. Wait for the current one to finish.'));
      const r = usage.reserve(c.user.id, 'aiPosts', n, c.plan.limits.aiPostsPerWeek);
      if (!r.granted) { releaseSlot(); return send(res, limitError(c, 'aiPosts', r)); }
      req.aiAllowance = r.granted;
      req.aiLimitMessage = limitError(c, 'aiPosts', Object.assign({}, r, { used: r.limit })).message;
      let settled = false;
      req.settleAi = successes => {
        if (settled) return;
        settled = true;
        usage.release(c.user.id, 'aiPosts', r.granted - Math.min(r.granted, successes || 0), r.period);
      };
      res.on('close', () => { releaseSlot(); if (!settled) req.settleAi(0); });
      next();
    } catch (err) { next(err); }
  }

  // A feature (and optionally one use of a daily/monthly meter), e.g. network analysis.
  function feature(name, o) {
    o = o || {};
    return async (req, res, next) => {
      try {
        const c = await contextOf(req);
        if (!c.enabled) return next();
        const e = needUser(c, Plans.FEATURES[name].label) || needFeature(c, name);
        if (e) return send(res, e);
        if (o.meter) {
          const r = usage.reserve(c.user.id, o.meter, 1, c.plan.limits[Plans.METERS[o.meter].limit]);
          if (!r.granted) return send(res, limitError(c, o.meter, r));
          res.on('finish', () => { if (res.statusCode >= 400) usage.release(c.user.id, o.meter, 1, r.period); });
        }
        next();
      } catch (err) { next(err); }
    };
  }

  /* ── Survey Studio (surveys/index.js) ─────── */
  const surveysPolicy = {
    // action: 'create' | 'save' | 'library' | 'publish' | 'reopen'
    // ctx: { liveCount, alreadyLive, advanced } (publish / reopen)
    async editor(req, action, ctx) {
      const c = await contextOf(req);
      if (!c.enabled) return null;
      const e = needUser(c, 'Survey Studio') || needFeature(c, 'surveys');
      if (e) return e;
      if (action === 'publish' || action === 'reopen') {
        ctx = ctx || {};
        if (action === 'publish' && ctx.advanced) {
          const a = needFeature(c, 'surveyAdvanced', 'Collecting IP addresses, locations or session timelines is part of the Max and Ultra plans. Turn them off in Settings (and in the Respondent information block) to publish on ' + c.plan.name + ', or upgrade.');
          if (a) return a;
        }
        const max = c.plan.limits.publishedSurveys;
        if (!ctx.alreadyLive && ctx.liveCount >= max) {
          const next = Plans.ORDER.map(Plans.get).find(p => p.rank > c.plan.rank && p.limits.publishedSurveys > max);
          return fail(429, 'limit_reached', 'The ' + c.plan.name + ' plan has ' + max + ' live survey' + (max === 1 ? '' : 's') + ' at a time. Close or unpublish one first' + (next ? ', or upgrade to ' + next.name + ' for ' + next.limits.publishedSurveys + '.' : '.'),
            { meter: 'publishedSurveys', used: ctx.liveCount, limit: max, plan: c.plan.id, upgradeTo: next ? next.id : null });
        }
        usage.linkOwner(ownerOf(req), c.user.id);
      }
      return null;
    },
    // A new response to a published survey: counted against the owner's plan.
    // Surveys published without an account (or with accounts off) aren't limited.
    async response(rec) {
      if (!enabled()) return null;
      const userId = usage.userOfOwner(rec.owner);
      if (!userId) return null;
      const email = usage.emailOf(userId);
      const info = await billing.planFor({ id: userId, email, emailConfirmed: !!email });
      if (info.error) return null;                 // Stripe is down: don't turn respondents away
      const plan = Plans.get(info.plan);
      const closed = fail(403, 'closed', 'This survey isn\'t accepting responses right now.');
      if (!plan.features.surveys) return closed;
      const r = usage.reserve(userId, 'surveyResponses', 1, plan.limits.surveyResponsesPerMonth);
      return r.granted ? null : closed;
    }
  };

  /* ── Reddit Scraper (scraper/index.js) ────── */
  const scraperPolicy = {
    async use(req) {
      const c = await contextOf(req);
      if (!c.enabled) return null;
      return needUser(c, 'the Reddit Scraper') || needFeature(c, 'scraper');
    },
    // Before a job starts: mode, jobs at once and per day, and items — the job's
    // item cap is lowered to what the plan allows (per job and left this month).
    async job(req, spec, info) {
      const c = await contextOf(req);
      if (!c.enabled) return null;
      let e = needUser(c, 'the Reddit Scraper') || needFeature(c, 'scraper') ||
        (spec.mode === 'ai' ? needFeature(c, 'aiScraper') : spec.mode === 'custom' ? needFeature(c, 'customCode') : null);
      if (e) return e;
      const L = c.plan.limits;
      if ((info && info.running) >= L.scrapeJobsAtOnce) {
        return fail(429, 'account_rate_limited', 'The ' + c.plan.name + ' plan runs ' + L.scrapeJobsAtOnce + ' scrape' + (L.scrapeJobsAtOnce === 1 ? '' : 's') + ' at a time. Wait for the current one to finish or cancel it.');
      }
      const jobs = usage.reserve(c.user.id, 'scrapeJobs', 1, L.scrapeJobsPerDay);
      if (!jobs.granted) return limitError(c, 'scrapeJobs', jobs);
      const left = L.scrapeItemsPerMonth - usage.used(c.user.id, 'scrapeItems');
      if (left <= 0) {
        usage.release(c.user.id, 'scrapeJobs', 1, jobs.period);
        return limitError(c, 'scrapeItems', { used: L.scrapeItemsPerMonth, limit: L.scrapeItemsPerMonth, resetsAt: nextReset('month', Date.now()) });
      }
      const allowed = Math.min(L.scrapeItemsPerJob, left);
      spec.options.maxItems = Math.min(spec.options.maxItems || allowed, allowed);
      spec.capacity = Math.min(spec.capacity || spec.options.maxItems, allowed);
      if (spec.options.ai && spec.options.ai.maxPosts) spec.options.ai.maxPosts = Math.min(spec.options.ai.maxPosts, allowed);
      const items = usage.reserve(c.user.id, 'scrapeItems', spec.capacity, L.scrapeItemsPerMonth);
      spec.usage = { userId: c.user.id, reserved: items.granted, period: items.period };
      return null;
    },
    // A finished job is charged for what it collected; the rest of its reservation goes back.
    jobFinished(job) {
      const u = job && job.usage;
      if (!u || u.settled) return;
      u.settled = true;
      usage.release(u.userId, 'scrapeItems', u.reserved - Math.min(u.reserved, (job.records || []).length), u.period);
    }
  };

  // The in-app Reddit browser's Wisp WebSocket needs scraper access. The
  // server's own connection to it (the epoxy transport) doesn't carry a
  // session and is always allowed: it comes from this machine, with no proxy
  // in between and no Origin header — which browsers always send.
  function upgradeGuard(handler, o) {
    o = o || {};
    const isWisp = o.isWisp || (req => /^\/wisp\/?/.test(String(req.url || '')));
    const guarded = (req, socket, head) => {
      if (!enabled() || !isWisp(req) || (isLoopback(req) && !req.headers.origin)) return handler(req, socket, head);
      (async () => {
        await new Promise(resolve => attach(req, null, resolve));
        const e = await scraperPolicy.use(req);
        if (!e) return handler(req, socket, head);
        try { socket.write('HTTP/1.1 ' + e.status + ' ' + (e.status === 401 ? 'Unauthorized' : e.status === 402 ? 'Payment Required' : 'Forbidden') + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (x) { /* gone */ }
        socket.destroy();
      })().catch(() => { try { socket.destroy(); } catch (x) { /* gone */ } });
    };
    Object.keys(handler).forEach(k => { guarded[k] = handler[k]; });   // keep closeAll()
    return guarded;
  }

  /* ── /api/account ─────────────────────────── */
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.get('/config', (req, res) => {
    const cfg = getConfig();
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: cfg.enabled, supabaseUrl: cfg.supabaseUrl, publishableKey: cfg.publishableKey, billing: cfg.enabled && cfg.stripe.enabled });
  });
  // Plan prices from Stripe (public: the plan cards show them before sign-in)
  router.get('/prices', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled()) return res.json({ prices: {} });
    try { res.json({ prices: await billing.pricesInfo() }); } catch (e) { res.json({ prices: {} }); }
  });
  router.get('/me', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const c = await contextOf(req);
      if (!c.enabled) return res.json({ enabled: false });
      if (!c.user) return res.json({ enabled: true, signedIn: false, reason: c.reason || null });
      const i = c.info;
      res.json({
        enabled: true, signedIn: true,
        user: { id: c.user.id, email: c.user.email },
        plan: { id: c.plan.id, name: c.plan.name, source: i.source, status: i.status || null, renewsAt: i.renewsAt || null, cancelAtPeriodEnd: !!i.cancelAtPeriodEnd, billingUnavailable: !!i.error },
        features: c.plan.features,
        limits: c.plan.limits,
        usage: Object.assign(usage.summary(c.user.id, c.plan.limits), { publishedSurveys: { limit: c.plan.limits.publishedSurveys } }),
        billing: { enabled: getConfig().stripe.enabled, canManage: !!i.customer && i.source === 'stripe' }
      });
    } catch (err) { send(res, fail(500, 'internal_error', 'Something went wrong while loading your account.')); }
  });
  // Moves what this browser made before signing in (published surveys and their
  // responses, the Survey Studio library, running scrapes) to the account.
  router.post('/claim', async (req, res) => {
    try {
      const c = await contextOf(req);
      if (!c.enabled) return send(res, fail(404, 'not_found', 'Accounts are off on this server.'));
      const e = needUser(c, 'your account');
      if (e) return send(res, e);
      const from = browserOwnerOf(req), to = ownerOf(req);
      const moved = {};
      if (from && to && from !== to) {
        for (const fn of claimers) Object.assign(moved, await fn(from, to));
      }
      usage.linkOwner(to, c.user.id);
      res.json({ ok: true, moved });
    } catch (err) { send(res, fail(500, 'internal_error', 'Something went wrong while moving this browser\'s data to your account.')); }
  });

  /* ── /api/billing ─────────────────────────── */
  const billingRouter = express.Router();
  billingRouter.use(express.json({ limit: '16kb' }));
  const originOf = req => getConfig().publicUrl || (req.protocol + '://' + req.get('host'));
  const billingRoute = fn => async (req, res) => {
    try {
      const c = await contextOf(req);
      if (!c.enabled) return send(res, fail(404, 'not_found', 'Accounts are off on this server.'));
      const e = needUser(c, 'billing');
      if (e) return send(res, e);
      if (!getConfig().stripe.enabled) return send(res, fail(503, 'billing_unavailable', 'Billing isn\'t set up on this server yet.'));
      const r = rate.take(c.user.id + ':billing', 20);
      if (!r.ok) return send(res, Object.assign(fail(429, 'account_rate_limited', 'Too many billing requests — try again in a minute.'), { retryAfter: r.retryAfter }));
      await fn(req, res, c);
    } catch (err) {
      if (err instanceof BillingError) return send(res, err);
      console.error('[billing] ' + (err && err.message ? String(err.message).slice(0, 200) : 'error'));
      send(res, fail(500, 'internal_error', 'Something went wrong with billing.'));
    }
  };
  billingRouter.post('/checkout', billingRoute(async (req, res, c) => {
    const plan = String((req.body && req.body.plan) || '').toLowerCase();
    res.json(await billing.checkout(c.user, plan, originOf(req)));
  }));
  billingRouter.post('/portal', billingRoute(async (req, res, c) => {
    res.json({ url: await billing.portal(c.user, originOf(req)) });
  }));
  billingRouter.post('/sync', billingRoute(async (req, res, c) => {
    billing.invalidate(c.user.id);
    req._accountCtx = null;
    const info = await billing.planFor(c.user);
    res.json({ plan: info.plan, billingUnavailable: !!info.error });
  }));

  // Stripe → MetaCode. Mounted with express.raw() so the signature can be checked.
  async function webhook(req, res) {
    const secret = getConfig().stripe.webhookSecret;
    if (!enabled() || !secret) return res.status(404).json({ error: { type: 'not_found', message: 'Not found.' } });
    let event;
    try { event = billing.verifyWebhook(req.body, req.headers['stripe-signature'], secret); }
    catch (err) { return res.status(400).json({ error: { type: err.type || 'bad_signature', message: 'Invalid webhook.' } }); }
    billing.handleEvent(event);
    res.json({ received: true });
  }

  return {
    enabled, config: getConfig, usage, billing, auth, attach, contextOf,
    aiSingle, aiBatch, feature, surveysPolicy, scraperPolicy, upgradeGuard,
    router, billingRouter, webhook,
    onClaim(fn) { claimers.push(fn); },
    flush() { usage.flush(); }
  };
}

module.exports = { createAccounts, fail };
