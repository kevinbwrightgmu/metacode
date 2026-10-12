// ── Plans from Stripe ─────────────────────────────────────────────────────────
// An account's plan is whatever its Stripe subscription says (an active,
// trialing or past-due subscription to the Pro, Max or Ultra product), never
// what the browser says. The server keeps each account's Stripe customer id
// (created here, with the Supabase user id in its metadata), asks Stripe for
// the customer's subscriptions, and remembers the answer for five minutes —
// or until Stripe's webhook, a return from checkout or "Refresh" says it
// changed. Talks to Stripe's REST API directly (no SDK); STRIPE_SECRET_KEY
// stays on the server and never appears in errors or logs.
const crypto = require('crypto');
const Plans = require('../public/js/plans.js');
const { request } = require('./http');

const ENTITLED = new Set(['active', 'trialing', 'past_due']);
const PLAN_TTL = 5 * 60 * 1000;
const PRICE_TTL = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BillingError extends Error {
  constructor(status, type, message) { super(message); this.status = status; this.type = type; }
}

// application/x-www-form-urlencoded with Stripe's nested keys (a[b][0]=c)
function formEncode(obj, prefix, out) {
  out = out || [];
  Object.keys(obj || {}).forEach(k => {
    const v = obj[k];
    const key = prefix ? prefix + '[' + k + ']' : k;
    if (v === undefined || v === null) return;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  });
  return out.join('&');
}

// Stripe-Signature: t=…,v1=… (HMAC-SHA256 of "t.payload" with the endpoint secret)
function verifyWebhook(rawBody, header, secret, opts) {
  opts = opts || {};
  const now = opts.now || Date.now;
  const tolerance = opts.toleranceSec === undefined ? 300 : opts.toleranceSec;
  const parts = String(header || '').split(',').map(s => s.trim().split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]).filter(Boolean);
  if (!t || !sigs.length || !/^\d+$/.test(t)) throw new BillingError(400, 'bad_signature', 'Missing or malformed Stripe-Signature header.');
  if (Math.abs(now() / 1000 - Number(t)) > tolerance) throw new BillingError(400, 'bad_signature', 'The webhook timestamp is too old.');
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(t + '.').update(payload).digest();
  const ok = sigs.some(s => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new BillingError(400, 'bad_signature', 'The webhook signature doesn\'t match.');
  let event;
  try { event = JSON.parse(payload.toString('utf8')); } catch (e) { throw new BillingError(400, 'invalid_request', 'The webhook body isn\'t JSON.'); }
  return event;
}

function createBilling(opts) {
  const getConfig = opts.getConfig;
  const usage = opts.usage;
  const now = opts.now || Date.now;
  const plans = new Map();      // userId → { info, until }
  const prices = new Map();     // plan → { id, until }

  const cfgStripe = () => getConfig().stripe;
  const planOfProduct = product => Object.keys(cfgStripe().products).find(p => cfgStripe().products[p] === product) || null;

  async function stripe(method, path, params, extraHeaders) {
    const s = cfgStripe();
    if (!s.enabled) throw new BillingError(503, 'billing_unavailable', 'Billing isn\'t set up on this server.');
    const qs = method === 'GET' && params ? '?' + formEncode(params) : '';
    let out;
    try {
      out = await request(s.apiBase + path + qs, {
        method,
        headers: Object.assign({ Authorization: 'Bearer ' + s.secretKey }, method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }, extraHeaders || {}),
        body: method === 'GET' ? undefined : formEncode(params || {}),
        timeoutMs: 15000
      });
    } catch (e) {
      throw new BillingError(503, 'billing_unavailable', 'MetaCode couldn\'t reach Stripe just now. Try again in a minute.');
    }
    if (!out.ok) {
      const err = (out.json && out.json.error) || {};
      // Stripe's own explanation helps the administrator; key-like strings are cut out of it
      const said = String(err.message || '').replace(/\b(sk|rk|pk|whsec)_(live_|test_)?[A-Za-z0-9*]{4,}/g, '$1_…').replace(/[^\x20-\x7E]/g, '').slice(0, 300);
      console.error('[billing] Stripe ' + method + ' ' + path.replace(/\/(cus|sub|cs)_[A-Za-z0-9]+/g, '/$1_…') + ' → ' + out.status + (err.type ? ' ' + err.type : '') + (err.code ? ' ' + err.code : '') + (err.param ? ' (' + err.param + ')' : '') +
        (said ? ': ' + said : '') + ' — run "npm run billing:check" to test the Stripe setup.');
      const e = new BillingError(out.status >= 500 ? 503 : 502, out.status >= 500 ? 'billing_unavailable' : 'billing_error',
        out.status >= 500 ? 'Stripe isn\'t answering right now. Try again in a minute.' : 'Billing isn\'t set up correctly on this server. Please contact the site\'s administrator.');
      e.stripeStatus = out.status;
      throw e;
    }
    return out.json || {};
  }

  // The account's Stripe customer (create: make one if there's none yet).
  async function customerFor(user, create) {
    let id = usage.customerOf(user.id);
    if (id) return id;
    if (UUID_RE.test(user.id)) {
      try {
        const found = await stripe('GET', '/v1/customers/search', { query: "metadata['supabase_user_id']:'" + user.id + "'", limit: 1 });
        const c = found.data && found.data[0];
        if (c && c.id) { usage.setCustomer(user.id, c.id); return c.id; }
      } catch (e) {
        if (e.type === 'billing_unavailable') throw e;   // search isn't available everywhere; carry on
      }
    }
    if (!create) return null;
    const c = await stripe('POST', '/v1/customers', { email: user.email || undefined, metadata: { supabase_user_id: user.id } },
      { 'Idempotency-Key': 'metacode-customer-' + user.id });
    usage.setCustomer(user.id, c.id);
    return c.id;
  }

  function override(user) {
    const o = getConfig().overrides;
    if (o.byId[user.id]) return o.byId[user.id];
    const email = user.emailConfirmed && user.email ? user.email : usage.emailOf(user.id);
    return email && o.byEmail[email] ? o.byEmail[email] : null;
  }

  async function lookup(user) {
    const cus = await customerFor(user, false);
    if (!cus) return { plan: 'free', source: 'stripe' };
    const subs = await stripe('GET', '/v1/subscriptions', { customer: cus, status: 'all', limit: 100 });
    let best = null;
    (subs.data || []).forEach(s => {
      if (!ENTITLED.has(s.status)) return;
      ((s.items && s.items.data) || []).forEach(it => {
        const pr = it.price || it.plan || {};
        const product = typeof pr.product === 'string' ? pr.product : pr.product && pr.product.id;
        const plan = planOfProduct(product);
        if (!plan || (best && Plans.get(plan).rank <= Plans.get(best.plan).rank)) return;
        const end = s.current_period_end || it.current_period_end || null;
        best = { plan, status: s.status, renewsAt: end ? new Date(end * 1000).toISOString() : null, cancelAtPeriodEnd: !!s.cancel_at_period_end };
      });
    });
    return Object.assign({ source: 'stripe', customer: true }, best || { plan: 'free' });
  }

  // → { plan, source, status?, renewsAt?, cancelAtPeriodEnd?, error? } — never throws
  async function planFor(user) {
    const o = override(user);
    if (o) return { plan: o, source: 'override' };
    if (!cfgStripe().enabled) return { plan: 'free', source: 'default' };
    const hit = plans.get(user.id);
    if (hit && hit.until > now()) return hit.info;
    try {
      const info = await lookup(user);
      plans.set(user.id, { info, until: now() + PLAN_TTL });
      return info;
    } catch (e) {
      if (hit) { plans.set(user.id, { info: hit.info, until: now() + 60000 }); return hit.info; }   // Stripe is down: keep the last answer a little longer
      return { plan: 'free', source: 'error', error: 'billing_unavailable' };
    }
  }

  async function priceOf(plan) {
    const s = cfgStripe();
    if (s.prices[plan]) return s.prices[plan];
    const hit = prices.get(plan);
    if (hit && hit.until > now()) return hit.id;
    const product = await stripe('GET', '/v1/products/' + encodeURIComponent(s.products[plan]));
    const id = typeof product.default_price === 'string' ? product.default_price : product.default_price && product.default_price.id;
    if (!id || product.active === false) {
      console.error('[billing] The ' + plan + ' product has no default price (or is archived) in Stripe; set STRIPE_PRICE_' + plan.toUpperCase() + '.');
      throw new BillingError(503, 'billing_error', 'The ' + Plans.get(plan).name + ' plan can\'t be bought right now. Please contact the site\'s administrator.');
    }
    prices.set(plan, { id, until: now() + PRICE_TTL });
    return id;
  }

  // What each plan costs (for the plan cards): { pro: { amount, currency, interval } } — {} when unknown
  let priceInfo = null;
  async function pricesInfo() {
    if (!cfgStripe().enabled) return {};
    if (priceInfo && priceInfo.until > now()) return priceInfo.value;
    const value = {};
    for (const plan of ['pro', 'max', 'ultra']) {
      try {
        const p = await stripe('GET', '/v1/prices/' + encodeURIComponent(await priceOf(plan)));
        if (Number.isFinite(p.unit_amount)) value[plan] = { amount: p.unit_amount, currency: String(p.currency || 'usd'), interval: (p.recurring && p.recurring.interval) || null };
      } catch (e) { /* shown without a price */ }
    }
    priceInfo = { value, until: now() + (Object.keys(value).length ? PRICE_TTL : 60000) };
    return value;
  }

  async function checkout(user, plan, origin) {
    if (!['pro', 'max', 'ultra'].includes(plan)) throw new BillingError(400, 'invalid_request', 'Choose Pro, Max or Ultra.');
    if (override(user)) throw new BillingError(409, 'plan_managed', 'Your plan is set by this site\'s administrators.');
    const current = await planFor(user);
    if (current.error) throw new BillingError(503, 'billing_unavailable', 'MetaCode couldn\'t check your subscription with Stripe just now. Try again in a minute.');
    // Already subscribed: changes and cancellations happen in Stripe's billing portal
    if (current.source === 'stripe' && current.plan !== 'free') return { url: await portal(user, origin), portal: true };
    const price = await priceOf(plan);
    const customer = await customerFor(user, true);
    const session = await stripe('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer,
      client_reference_id: user.id,
      line_items: { 0: { price, quantity: 1 } },
      allow_promotion_codes: 'true',
      subscription_data: { metadata: { supabase_user_id: user.id, plan } },
      metadata: { supabase_user_id: user.id, plan },
      success_url: origin + '/app.html#account/success',
      cancel_url: origin + '/app.html#account'
    });
    if (!session.url) throw new BillingError(502, 'billing_error', 'Stripe didn\'t return a checkout page.');
    return { url: session.url };
  }

  async function portal(user, origin) {
    const customer = await customerFor(user, false);
    if (!customer) throw new BillingError(404, 'no_subscription', 'You don\'t have a subscription yet.');
    const s = await stripe('POST', '/v1/billing_portal/sessions', { customer, return_url: origin + '/app.html#account' });
    if (!s.url) throw new BillingError(502, 'billing_error', 'Stripe didn\'t return the billing page.');
    return s.url;
  }

  function invalidate(userId) { if (userId) plans.delete(userId); }

  // A verified webhook event: link the customer (if the event names the account) and drop the cached plan.
  function handleEvent(event) {
    const obj = (event && event.data && event.data.object) || {};
    if (!/^(checkout\.session\.|customer\.subscription\.|invoice\.|customer\.)/.test(String(event && event.type))) return { ignored: true };
    const customer = typeof obj.customer === 'string' ? obj.customer : (obj.object === 'customer' ? obj.id : null);
    const named = (obj.metadata && obj.metadata.supabase_user_id) || obj.client_reference_id || null;
    let userId = customer ? usage.userOfCustomer(customer) : null;
    if (!userId && named && UUID_RE.test(named)) { userId = named; if (customer) usage.setCustomer(userId, customer); }
    invalidate(userId);
    return { userId };
  }

  return { planFor, checkout, portal, invalidate, handleEvent, priceOf, pricesInfo, verifyWebhook, planOfProduct };
}

module.exports = { createBilling, verifyWebhook, formEncode, BillingError, ENTITLED };
