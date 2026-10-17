// @ts-check
// ── AI Coding Lab usage ───────────────────────────────────────────────────────
// Uses the same usage counters as the rest of MetaCode (accounts/usage.js:
// synchronous reservations, so concurrent requests can't overshoot a limit)
// with the Lab's meters from public/js/plans.js:
//
//   labRequests  model calls per day (workbench answers, evaluation tasks, AI
//                grading, optimisation suggestions, summaries)
//   labTokens    tokens per month — what the provider reported, or MetaCode's
//                estimate (characters / 4) when it reported nothing
//   labEvalRuns  evaluation runs per day      labFineTunes  per month
//
// Before a call: one request and the estimated tokens are reserved; after it,
// the reservation is settled to what was used (failed calls give everything
// back). Concurrent generations are capped per account.

const PlansModule = require('../public/js/plans.js');
/** @type {{ METERS: Record<string, { limit: string, period: string, label: string, unit: string }>, PERIODS: Record<string, { this: string, a: string }> }} */
const Plans = PlansModule;
const { LabError } = require('./errors');
const { nextReset } = require('../accounts/usage');

/** @typedef {import('../types/ai-lab').LabPrincipal} LabPrincipal */
/** @typedef {import('../types/ai-lab').MessageUsage} MessageUsage */

const fmt = /** @param {number} n */ n => Number(n).toLocaleString('en-US');

/**
 * @param {{ usage: any, rate: any }} deps   accounts' UsageStore and rate limiter
 */
function createLabUsage(deps) {
  const { usage, rate } = deps;

  /**
   * @param {LabPrincipal} p
   * @param {string} meter
   * @param {{ used: number, limit: number, resetsAt: string }} r
   */
  function limitError(p, meter, r) {
    const m = Plans.METERS[meter];
    return new LabError('limit_reached', 'You\'ve used the AI Coding Lab\'s fair-use allowance of ' + fmt(r.limit) + ' ' + m.unit + ' ' + Plans.PERIODS[m.period].this +
      ' (' + m.label.toLowerCase() + '). It resets ' + new Date(r.resetsAt).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' UTC.',
      { status: 429, extra: { meter, used: r.used, limit: r.limit, resetsAt: r.resetsAt } });
  }

  /**
   * Takes one unit of a simple meter (evaluation runs, fine-tuning jobs).
   * @param {LabPrincipal} p
   * @param {string} meter
   */
  function take(p, meter) {
    const limit = p.limits[Plans.METERS[meter].limit];
    const r = usage.reserve(p.userId, meter, 1, limit);
    if (!r.granted) throw limitError(p, meter, r);
    return { release: () => usage.release(p.userId, meter, 1, r.period) };
  }

  /**
   * Before a model call. → a ticket to settle when the call ends.
   * @param {LabPrincipal} p
   * @param {{ estimatedTokens: number, interactive: boolean }} o
   */
  function begin(p, o) {
    const L = p.limits;
    let releaseSlot = () => {};
    if (o.interactive) {
      const slot = rate.acquire(p.userId + ':lab-gen', Math.max(1, L.labGenerationsAtOnce || 1));
      if (!slot) throw new LabError('busy', 'The Ultra plan runs ' + (L.labGenerationsAtOnce || 1) + ' answers at a time in the Lab. Wait for one to finish (or stop it).', { status: 429 });
      releaseSlot = slot;
    }
    const req = usage.reserve(p.userId, 'labRequests', 1, L.labRequestsPerDay);
    if (!req.granted) { releaseSlot(); throw limitError(p, 'labRequests', req); }
    const want = Math.max(1, Math.round(o.estimatedTokens));
    const tok = usage.reserve(p.userId, 'labTokens', want, L.labTokensPerMonth);
    if (!tok.granted) {
      usage.release(p.userId, 'labRequests', 1, req.period);
      releaseSlot();
      throw limitError(p, 'labTokens', Object.assign({}, tok, { used: tok.limit }));
    }
    let settled = false;
    return {
      /**
       * The call ended: `used` tokens (null = it failed before using any).
       * @param {MessageUsage | null} used
       */
      settle(used) {
        if (settled) return;
        settled = true;
        releaseSlot();
        if (!used) {
          usage.release(p.userId, 'labRequests', 1, req.period);
          usage.release(p.userId, 'labTokens', tok.granted, tok.period);
          return;
        }
        const actual = used.promptTokens + used.completionTokens;
        if (actual > tok.granted) usage.add(p.userId, 'labTokens', actual - tok.granted);
        else usage.release(p.userId, 'labTokens', tok.granted - actual, tok.period);
      }
    };
  }

  /** @param {LabPrincipal} p */
  function summary(p) {
    /** @type {Record<string, { used: number, limit: number, period: string, resetsAt: string, label: string, unit: string }>} */
    const out = {};
    ['labRequests', 'labTokens', 'labEvalRuns', 'labFineTunes'].forEach(meter => {
      const m = Plans.METERS[meter];
      out[meter] = { used: usage.used(p.userId, meter), limit: p.limits[m.limit], period: m.period, resetsAt: nextReset(m.period, Date.now()), label: m.label, unit: m.unit };
    });
    return out;
  }

  return { begin, take, summary, limitError };
}

module.exports = { createLabUsage };
