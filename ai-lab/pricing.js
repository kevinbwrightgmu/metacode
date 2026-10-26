// @ts-check
// ── Prices for cost estimates ─────────────────────────────────────────────────
// MetaCode never invents prices. The operator may keep a price list in
// ai-lab-pricing.json (or AI_LAB_PRICING_FILE):
//
//   { "asOf": "2026-10-01", "currency": "USD",
//     "models": { "openai:gpt-4o-mini": { "inputPerMTok": 0.15, "outputPerMTok": 0.60 },
//                 "metacode:emis/gpt-5.5": { "inputPerMTok": 1.25, "outputPerMTok": 10 } } }
//
// A cost is then *estimated* as tokens × price (labelled with the list's
// date). A model without a price has an *unknown* cost. No provider used here
// reports what a request was actually charged, so no cost is ever shown as
// charged.

const fs = require('fs');

/** @typedef {import('../types/ai-lab').CostEstimate} CostEstimate */
/** @typedef {import('../types/ai-lab').MessageUsage} MessageUsage */

/**
 * @param {string} file
 */
function createPricing(file) {
  /** @type {{ mtimeMs: number, data: { asOf: string | null, currency: string, models: Record<string, { input: number, output: number }> } | null, problem: string | null } | null} */
  let cache = null;

  function load() {
    let st = null;
    try { st = fs.statSync(file); } catch (e) { st = null; }
    if (!st) { cache = { mtimeMs: 0, data: null, problem: null }; return cache; }
    if (cache && cache.mtimeMs === st.mtimeMs) return cache;
    let data = null, problem = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      /** @type {Record<string, { input: number, output: number }>} */
      const models = {};
      Object.entries(raw && typeof raw.models === 'object' ? raw.models : {}).forEach(([k, v]) => {
        const p = /** @type {any} */ (v);
        const input = Number(p && p.inputPerMTok), output = Number(p && p.outputPerMTok);
        if (/^[A-Za-z0-9._:\/-]{1,160}$/.test(k) && Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) models[k] = { input, output };
      });
      data = { asOf: typeof raw.asOf === 'string' ? raw.asOf.slice(0, 40) : null, currency: typeof raw.currency === 'string' ? raw.currency.slice(0, 8) : 'USD', models };
    } catch (e) {
      problem = 'The price list (' + file + ') couldn\'t be read; costs are shown as unknown.';
    }
    cache = { mtimeMs: st.mtimeMs, data, problem };
    return cache;
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @returns {{ input: number, output: number, currency: string, asOf: string | null } | null}
   */
  function priceOf(provider, model) {
    const c = load();
    if (!c.data) return null;
    const p = c.data.models[provider + ':' + model] || c.data.models[model]
      // price lists from before model ids named their provider: "metacode:<id>" priced the gateway's model
      || (provider === 'metacode' && model.startsWith('emis/') ? c.data.models['metacode:' + model.slice(5)] : undefined);
    return p ? { input: p.input, output: p.output, currency: c.data.currency, asOf: c.data.asOf } : null;
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @param {MessageUsage | null} usage
   * @returns {CostEstimate}
   */
  function costOf(provider, model, usage) {
    const p = priceOf(provider, model);
    if (!p || !usage) return { amount: null, currency: p ? p.currency : null, basis: 'unknown', pricingAsOf: p ? p.asOf : null };
    const amount = (usage.promptTokens * p.input + usage.completionTokens * p.output) / 1e6;
    return { amount: Math.round(amount * 1e6) / 1e6, currency: p.currency, basis: 'estimated', pricingAsOf: p.asOf };
  }

  function info() { const c = load(); return { configured: !!c.data, asOf: c.data ? c.data.asOf : null, currency: c.data ? c.data.currency : null, models: c.data ? Object.keys(c.data.models).length : 0, problem: c.problem }; }

  return { priceOf, costOf, info };
}

/**
 * Sums cost estimates; unknown parts make the total partial.
 * @param {CostEstimate[]} list
 * @returns {CostEstimate & { unknownParts: number }}
 */
function sumCosts(list) {
  let amount = 0, known = 0, unknown = 0;
  /** @type {string | null} */
  let currency = null;
  /** @type {string | null} */
  let asOf = null;
  list.forEach(c => {
    if (c && c.basis === 'estimated' && c.amount !== null) { amount += c.amount; known++; currency = currency || c.currency; asOf = asOf || c.pricingAsOf; }
    else unknown++;
  });
  return { amount: known ? Math.round(amount * 1e6) / 1e6 : null, currency, basis: known ? 'estimated' : 'unknown', pricingAsOf: asOf, unknownParts: unknown };
}

module.exports = { createPricing, sumCosts };
