// @ts-check
// ── /api/desktop — what the MetaCode Sheets desktop app needs from the server ──
// The desktop app (desktop/) is part of the Pro, Max and Ultra plans (plans.js,
// feature "desktop"). Its main process signs in with the same Supabase account
// as the website and sends the account's access token as a Bearer token; the
// server verifies it with Supabase and looks the plan up in Stripe exactly as
// for the website (accounts/). Nothing the app says about itself is trusted.
//
//   GET  /config        public: whether desktop access is available here, the
//                        Supabase project to sign in with (publishable key —
//                        public by design), the lease public key, the upgrade page
//   GET  /entitlement   the signed-in account's plan and, if it includes the
//                        desktop app, a signed lease (lease.js) for offline use
//   POST /ai            one AI request (OpenAI chat format), for the app's AI
//                        tools — desktop plans only, counted like the website's
//                        "other AI requests"
//   POST /ai/batch      AI Coding of many rows — desktop plans only, counted
//                        like the website's AI Coding (posts per week)
//
// With accounts off (no SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY) the server
// can't tell who is asking, so desktop access is off — unless the
// administrator of a private, single-user server sets
// DESKTOP_WITHOUT_ACCOUNTS=true (then anyone who can reach the server can use
// the app and its AI quota).

const express = require('express');
const Plans = require('../public/js/plans.js');
const { loadLeaseKey, signLease } = require('./lease');

const DEFAULT_OFFLINE_HOURS = 72;

/** @param {Record<string, string | undefined>} env */
function desktopConfig(env) {
  const hours = Number(String(env.DESKTOP_OFFLINE_HOURS || '').trim());
  return {
    enabled: !/^(false|off|no|0)$/i.test(String(env.DESKTOP_ENABLED || '').trim()),
    withoutAccounts: /^(true|on|yes|1)$/i.test(String(env.DESKTOP_WITHOUT_ACCOUNTS || '').trim()),
    offlineHours: Number.isFinite(hours) && hours >= 1 && hours <= 336 ? hours : DEFAULT_OFFLINE_HOURS,
    minVersion: /^\d+\.\d+\.\d+$/.test(String(env.DESKTOP_MIN_VERSION || '').trim()) ? String(env.DESKTOP_MIN_VERSION).trim() : null,
    downloadUrl: /^https:\/\//i.test(String(env.DESKTOP_DOWNLOAD_URL || '').trim()) ? String(env.DESKTOP_DOWNLOAD_URL).trim() : null
  };
}

/**
 * @param {object} deps
 * @param {any} deps.accounts         accounts/ (createAccounts())
 * @param {{ chat: (body: any, opts?: any) => Promise<any>, problem: () => string | null }} deps.ai   server.js's AI helper
 * @param {(req: any, res: any) => any} deps.aiBatchRoute   server.js's /api/ai/batch handler
 * @param {Record<string, string | undefined>} [deps.env]
 */
function createDesktopApi(deps) {
  const accounts = deps.accounts;
  const env = () => deps.env || process.env;
  const cfg = () => desktopConfig(env());
  /** @type {ReturnType<typeof loadLeaseKey> | null} */
  let key = null;
  const leaseKey = () => key || (key = loadLeaseKey({ env: env(), dataDir: accounts.config().dataDir }));

  /** @param {number} status @param {string} type @param {string} message @param {any} [extra] */
  const fail = (status, type, message, extra) => ({ status, type, message, extra: extra || null });
  /** @param {any} res @param {{ status: number, type: string, message: string, extra: any }} e */
  const send = (res, e) => res.status(e.status).json({ error: Object.assign({ type: e.type, message: e.message }, e.extra || {}) });
  /** @param {any} req */
  const originOf = req => accounts.config().publicUrl || (req.protocol + '://' + req.get('host'));

  // Is desktop access possible on this server at all?
  function unavailable() {
    const c = cfg();
    if (!c.enabled) return fail(403, 'desktop_unavailable', 'The desktop app is turned off on this MetaCode server.');
    if (!accounts.enabled() && !c.withoutAccounts) return fail(403, 'desktop_unavailable', 'This MetaCode server doesn\'t have accounts turned on, so it can\'t check subscriptions for the desktop app.');
    return null;
  }

  // Guard for the app's premium routes: a signed-in account whose plan includes the desktop app.
  function requireDesktop() {
    const feature = accounts.feature('desktop');
    /** @param {any} req @param {any} res @param {() => void} next */
    return (req, res, next) => {
      const u = unavailable();
      if (u) return send(res, u);
      if (!accounts.enabled()) return next();          // DESKTOP_WITHOUT_ACCOUNTS
      return feature(req, res, next);
    };
  }

  const router = express.Router();
  router.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {() => void} */ next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/config', (/** @type {any} */ req, /** @type {any} */ res) => {
    const c = cfg(), a = accounts.config();
    const u = unavailable();
    const origin = originOf(req);
    let lease = null;
    if (!u) { const k = leaseKey(); lease = { alg: 'Ed25519', kid: k.kid, publicKey: k.publicKeyB64 }; }
    res.json({
      app: 'metacode-sheets',
      server: origin,
      available: !u, reason: u ? u.message : null,
      accounts: accounts.enabled() ? { enabled: true, supabaseUrl: a.supabaseUrl, publishableKey: a.publishableKey } : { enabled: false, withoutAccounts: c.withoutAccounts },
      lease, offlineHours: c.offlineHours, minVersion: c.minVersion, downloadUrl: c.downloadUrl,
      plansWithDesktop: Plans.ORDER.filter(id => Plans.has(id, 'desktop')),
      upgradeUrl: origin + '/app.html#account',
      accountUrl: origin + '/app.html#account',
      signUpUrl: origin + '/app.html#account'
    });
  });

  router.get('/entitlement', async (/** @type {any} */ req, /** @type {any} */ res) => {
    try {
      const u = unavailable();
      if (u) return send(res, u);
      const c = cfg();
      const origin = originOf(req);
      const ttlMs = c.offlineHours * 3600 * 1000;
      if (!accounts.enabled()) {
        const lease = signLease(leaseKey(), { sub: 'local', plan: 'ultra', server: origin, ttlMs });
        return res.json({ entitled: true, user: { id: 'local', email: null }, plan: { id: 'local', name: 'This server', source: 'server' },
          lease: { token: lease.token, expiresAt: new Date(Number(lease.payload.exp) * 1000).toISOString() }, upgradeUrl: origin + '/app.html#account', checkedAt: new Date().toISOString() });
      }
      const ctx = await accounts.contextOf(req);
      const e = accounts.needUser(ctx, 'MetaCode Sheets');
      if (e) return accounts.send(res, e);
      const r = accounts.rate.take(ctx.user.id + ':desktop-entitlement', 30);
      if (!r.ok) { res.set('Retry-After', String(r.retryAfter)); return send(res, fail(429, 'account_rate_limited', 'Too many checks — try again in ' + r.retryAfter + ' s.', { retryAfterSeconds: r.retryAfter })); }
      const info = ctx.info, plan = ctx.plan;
      const planOut = { id: plan.id, name: plan.name, source: info.source, status: info.status || null, renewsAt: info.renewsAt || null, cancelAtPeriodEnd: !!info.cancelAtPeriodEnd };
      const user = { id: ctx.user.id, email: ctx.user.email };
      if (!plan.features.desktop) {
        // Stripe couldn't be asked: say so, so the app keeps its lease instead of locking
        if (info.error) return send(res, fail(503, 'account_unavailable', 'MetaCode couldn\'t check your subscription with Stripe just now. Try again in a minute.'));
        const lowest = Plans.lowestWith('desktop');
        return res.json({ entitled: false, reason: 'plan_required', user, plan: planOut, requiredPlan: lowest ? lowest.id : null,
          plansWithDesktop: Plans.ORDER.filter(id => Plans.has(id, 'desktop')).map(id => Plans.get(id).name),
          upgradeUrl: origin + '/app.html#account', checkedAt: new Date().toISOString() });
      }
      const lease = signLease(leaseKey(), { sub: ctx.user.id, email: ctx.user.email, plan: plan.id, server: origin, ttlMs });
      res.json({ entitled: true, user, plan: planOut, features: plan.features, limits: plan.limits,
        lease: { token: lease.token, expiresAt: new Date(Number(lease.payload.exp) * 1000).toISOString() },
        upgradeUrl: origin + '/app.html#account', checkedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[desktop] entitlement: ' + (err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message).slice(0, 200) : 'error'));
      send(res, fail(500, 'internal_error', 'Something went wrong while checking your subscription.'));
    }
  });

  // One AI request for the app's AI tools (formula help, explanations, insights, cleaning)
  router.post('/ai', requireDesktop(), accounts.aiSingle, async (/** @type {any} */ req, /** @type {any} */ res) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : null;
      if (!b || !Array.isArray(b.messages) || !b.messages.length || b.messages.length > 50 || b.stream) {
        return send(res, fail(400, 'invalid_request', 'Send { messages: [...] } (OpenAI chat format, not streamed).'));
      }
      const problem = deps.ai.problem();
      if (problem) return send(res, fail(503, 'ai_unavailable', problem));
      const body = { messages: b.messages, max_tokens: Math.max(1, Math.min(4000, Number(b.max_tokens) || 1000)), temperature: Number.isFinite(Number(b.temperature)) ? Math.max(0, Math.min(1, Number(b.temperature))) : 0.1 };
      if (typeof b.model === 'string' && b.model.length <= 200) /** @type {any} */ (body).model = b.model;
      const out = await deps.ai.chat(body);
      if (out.aborted) return;
      if (out.failure) return send(res, fail(out.failure.status || 502, out.failure.type || 'ai_error', out.failure.message || 'The AI service failed.', out.failure.retryAfterSeconds ? { retryAfterSeconds: out.failure.retryAfterSeconds } : null));
      const choice = out.completion && out.completion.choices && out.completion.choices[0];
      res.json({ text: String((choice && choice.message && choice.message.content) || '').trim(), model: out.model || null });
    } catch (err) {
      console.error('[desktop] ai: ' + (err && /** @type {any} */ (err).message ? String(/** @type {any} */ (err).message).slice(0, 200) : 'error'));
      if (!res.headersSent) send(res, fail(500, 'internal_error', 'Something went wrong in MetaCode\'s AI service.'));
    }
  });

  // AI Coding of many rows: the website's batch route, behind the desktop guard
  router.post('/ai/batch', requireDesktop(), accounts.aiBatch, (/** @type {any} */ req, /** @type {any} */ res) => deps.aiBatchRoute(req, res));

  return { router, config: cfg, leaseKey, requireDesktop };
}

module.exports = { createDesktopApi, desktopConfig };
