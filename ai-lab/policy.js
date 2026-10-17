// @ts-check
// ── Who may use the AI Coding Lab ─────────────────────────────────────────────
// One decision, made on the server for every Lab request (pages, API calls,
// streams, downloads, background runs):
//
//   1. the Lab is turned on (AI_LAB_ENABLED);
//   2. accounts on: the request carries a session Supabase verified
//      (accounts/auth.js) — never anything the browser claims about itself;
//   3. the plan comes from the billing system (Stripe subscriptions or the
//      administrator's ACCOUNT_PLAN_OVERRIDES, accounts/billing.js) and
//      includes the `aiLab` feature — the Ultra plan (public/js/plans.js);
//      expired, cancelled or unpaid subscriptions don't;
//   4. every object a request names is looked up in that user's own storage
//      (store.js), so other users' projects, runs and files don't exist for it.
//
// Being an administrator (ADMIN_EMAILS) doesn't open the Lab: administrators
// use it on the same terms as anyone (an Ultra plan, which they can give
// themselves with ACCOUNT_PLAN_OVERRIDES) and never see other users' data.
//
// With accounts off there are no plans, so the Lab stays closed unless the
// operator sets AI_LAB_WITHOUT_ACCOUNTS=true for a private server; data is
// then kept per browser (owner.js).

const crypto = require('crypto');
const Plans = require('../public/js/plans.js');
const { browserOwnerOf } = require('../owner');

/** @typedef {import('../types/ai-lab').LabPrincipal} LabPrincipal */
/** @typedef {{ status: number, type: string, message: string, extra?: Record<string, unknown> | null }} LabDenial */

/**
 * @param {object} deps
 * @param {any} deps.accounts             accounts/index.js
 * @param {() => ReturnType<typeof import('./config').labConfig>} deps.getConfig
 */
function createLabPolicy(deps) {
  const { accounts, getConfig } = deps;
  const keyOf = /** @param {string} s */ s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);
  /** @param {any} e @returns {LabDenial} */
  const denial = e => ({ status: e.status || 403, type: e.type || 'forbidden', message: e.message, extra: e.extra || null });

  /**
   * @param {any} req
   * @returns {Promise<{ principal: LabPrincipal } | { denied: LabDenial }>}
   */
  async function decide(req) {
    const cfg = getConfig();
    if (!cfg.enabled) return { denied: { status: 503, type: 'lab_disabled', message: 'The AI Coding Lab is turned off on this server.' } };
    if (accounts && accounts.enabled()) {
      const c = await accounts.contextOf(req);
      const e = accounts.needUser(c, 'the AI Coding Lab') || accounts.needFeature(c, 'aiLab', 'The AI Coding Lab is part of the Ultra plan.');
      if (e) return { denied: denial(e) };
      return { principal: { key: keyOf('metacode-lab:' + c.user.id), userId: c.user.id, plan: c.plan.id, limits: c.plan.limits, anonymousMode: false } };
    }
    if (!cfg.withoutAccounts) {
      return { denied: { status: 403, type: 'lab_requires_accounts', message: 'The AI Coding Lab is an Ultra-plan feature, and accounts aren\'t turned on for this server. The administrator can turn accounts on (docs/accounts.md), or allow the Lab on a private server with AI_LAB_WITHOUT_ACCOUNTS=true.' } };
    }
    const owner = browserOwnerOf(req);
    if (!owner) return { denied: { status: 401, type: 'no_identity', message: 'This browser has no MetaCode identity yet. Reload the page.' } };
    return { principal: { key: keyOf('metacode-lab-browser:' + owner), userId: 'browser:' + owner, plan: 'ultra', limits: Plans.get('ultra').limits, anonymousMode: true } };
  }

  // Express middleware: req.lab = the principal, or the denial as the answer
  /** @type {(req: any, res: any, next: (err?: unknown) => void) => void} */
  function require(req, res, next) {
    decide(req).then(r => {
      if ('denied' in r) {
        const d = r.denied;
        return res.status(d.status).json({ error: Object.assign({ type: d.type, message: d.message }, d.extra || {}) });
      }
      req.lab = r.principal;
      next();
    }, next);
  }

  return { decide, require };
}

module.exports = { createLabPolicy };
