// ── npm run billing:check ─────────────────────────────────────────────────────
// Asks Stripe, with the server's own settings (.env), whether everything the
// plans need is in place, and says what to fix:
//   • STRIPE_SECRET_KEY works (live or test mode)
//   • each plan's product exists in that mode, is active, and has a default
//     price that is active and recurring (or STRIPE_PRICE_* points to one)
//   • the customer portal is set up (Manage subscription, switching plans)
//   • a webhook endpoint sends the needed events to /api/billing/webhook
// Read-only: nothing in Stripe is created or changed. Secrets aren't printed.
const { request } = require('./http');
const { accountConfig } = require('./config');

const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];
const redact = s => String(s || '').replace(/\b(sk|rk|pk|whsec)_(live|test)?_?[A-Za-z0-9*]{4,}/g, '$1_…');

// → [{ ok: true | false | null (a warning), label, detail }]
async function checkBilling(cfg, opts) {
  opts = opts || {};
  const s = cfg.stripe;
  const out = [];
  const add = (ok, label, detail) => out.push({ ok, label, detail: detail || '' });
  const call = async (path, method, body) => {
    try {
      const r = await request(s.apiBase + path, { method: method || 'GET', body, headers: Object.assign({ Authorization: 'Bearer ' + s.secretKey }, body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), timeoutMs: 15000 });
      return { ok: r.ok, status: r.status, json: r.json || {}, message: redact((r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status)) };
    } catch (e) { return { ok: false, status: 0, json: {}, message: 'MetaCode couldn\'t reach Stripe (' + e.message + ').' }; }
  };

  if (!s.secretKey) { add(false, 'STRIPE_SECRET_KEY', 'Not set in .env. Add your secret key (sk_live_… or sk_test_…) from Stripe → Developers → API keys.'); return out; }
  if (!s.enabled) { add(false, 'STRIPE_SECRET_KEY', 'Doesn\'t look like a Stripe secret key. It should start with sk_live_, sk_test_, rk_live_ or rk_test_ — not pk_ (that\'s the publishable key, which MetaCode doesn\'t use).'); return out; }
  const live = /_live_/.test(s.secretKey);
  const mode = live ? 'live' : 'test';
  add(true, 'STRIPE_SECRET_KEY', (live ? 'Live' : 'Test') + ' mode key (' + (/^rk_/.test(s.secretKey) ? 'restricted' : 'secret') + ').');

  for (const plan of ['pro', 'max', 'ultra']) {
    const name = plan.charAt(0).toUpperCase() + plan.slice(1);
    const id = s.products[plan];
    const p = await call('/v1/products/' + encodeURIComponent(id));
    if (p.status === 401) { add(false, 'STRIPE_SECRET_KEY', 'Stripe refused the key: ' + p.message); return out; }
    if (!p.ok) {
      add(false, name + ' product (' + id + ')', p.status === 404
        ? 'Not found with this ' + mode + ' key. Stripe says: “' + p.message + '” Products made in ' + (live ? 'test' : 'live') + ' mode don\'t exist in ' + mode + ' mode — create it in ' + mode + ' mode (or copy it there) and put its id in STRIPE_PRODUCT_' + plan.toUpperCase() + ', or use the ' + (live ? 'test' : 'live') + ' key.'
        : p.status === 403 ? 'The restricted key can\'t read products. Give it “Products: read” (and Prices: read, Customers: write, Checkout Sessions: write, Subscriptions: read, Customer portal: write).'
        : 'Stripe says: ' + p.message);
      continue;
    }
    if (p.json.active === false) { add(false, name + ' product (' + id + ')', 'Archived in Stripe. Unarchive it (Product catalog → the product → ⋯ → Unarchive).'); continue; }
    const priceId = s.prices[plan] || (typeof p.json.default_price === 'string' ? p.json.default_price : p.json.default_price && p.json.default_price.id);
    if (!priceId) { add(false, name + ' product (' + id + ')', 'Has no default price. In Stripe open the product, add a recurring monthly price and choose “Set as default price” (or set STRIPE_PRICE_' + plan.toUpperCase() + ').'); continue; }
    const pr = await call('/v1/prices/' + encodeURIComponent(priceId));
    if (!pr.ok) { add(false, name + ' price (' + priceId + ')', pr.status === 403 ? 'The restricted key can\'t read prices (needs “Prices: read”).' : 'Stripe says: ' + pr.message); continue; }
    const P = pr.json;
    const product = typeof P.product === 'string' ? P.product : P.product && P.product.id;
    if (P.active === false) add(false, name + ' price (' + priceId + ')', 'This price is archived. Set an active price as the product\'s default.');
    else if (P.type !== 'recurring' || !P.recurring) add(false, name + ' price (' + priceId + ')', 'This is a one-time price, but plans are subscriptions. Add a recurring (e.g. monthly) price to the product and set it as the default.');
    else if (product && product !== id) add(false, name + ' price (' + priceId + ')', 'Belongs to a different product (' + product + ') than STRIPE_PRODUCT_' + plan.toUpperCase() + '.');
    else {
      const tax = typeof p.json.tax_code === 'string' ? p.json.tax_code : p.json.tax_code && p.json.tax_code.id;
      add(true, name, ((P.unit_amount || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: String(P.currency || 'usd').toUpperCase() }) + ' every ' + (P.recurring.interval_count > 1 ? P.recurring.interval_count + ' ' : '') + P.recurring.interval + ' (' + priceId + ')' + (tax ? ', tax code ' + tax : '') + '.');
      // Stripe Managed Payments (and some Stripe Tax setups) refuse checkout for a product without one
      if (!tax) add(null, name + ' tax code', 'The product has no tax code. With Managed Payments on, Stripe refuses checkout (“the product tax code is missing”). In Stripe: Product catalog → ' + (p.json.name ? '“' + p.json.name + '”' : 'the product') + ' → Edit → Product tax code → “Software as a service (SaaS) – business use” (txcd_10103001), then Save.');
    }
  }

  // What checkout needs to do, tested without doing it: each request names an
  // object that doesn't exist, so Stripe answers "no such …" when the key may do
  // it and "permission denied" (403) when it may not. Nothing is created.
  const NONE = 'MetaCodeCheckDoesNotExist';
  const perms = [
    ['Customers', 'Read', () => call('/v1/customers?limit=1')],
    ['Customers', 'Write', () => call('/v1/customers/cus_' + NONE, 'POST', 'metadata%5Bmetacode_check%5D=1')],
    ['Subscriptions', 'Read', () => call('/v1/subscriptions?limit=1')],
    ['Checkout Sessions', 'Write', () => call('/v1/checkout/sessions/cs_' + NONE + '/expire', 'POST', '')],
    ['Customer portal', 'Write', () => call('/v1/billing_portal/sessions', 'POST', 'customer=cus_' + NONE)]
  ];
  const missing = [];
  for (const [what, level, probe] of perms) {
    const r = await probe();
    if (r.status === 403 || (r.status === 401 && /permission/i.test(r.message))) missing.push(what + ': ' + level);
    else if (r.status === 0 || r.status >= 500) { add(null, what + ' (' + level + ')', 'Couldn\'t check: ' + r.message); }
  }
  if (missing.length) add(false, 'Key permissions', 'The ' + (/^rk_/.test(s.secretKey) ? 'restricted ' : '') + 'key may not: ' + missing.join(', ') + '. Developers → API keys → your key → Edit, and set ' + missing.join(', ') + ' (checkout needs them). Changes apply at once.');
  else add(true, 'Key permissions', 'Customers (read, write), Subscriptions (read), Checkout Sessions (write), Customer portal (write).');

  // A live account that can't take payments yet (activation unfinished) can't start a checkout
  if (live) {
    const acct = await call('/v1/account');
    if (acct.ok && acct.json.charges_enabled === false) add(false, 'Stripe account', 'Can\'t take live payments yet. Finish activating the account in Stripe (the banner at the top of the Dashboard lists what\'s missing).');
    else if (acct.ok) add(true, 'Stripe account', 'Can take live payments.');
  }

  const portal = await call('/v1/billing_portal/configurations?is_default=true&limit=1');
  if (!portal.ok) add(null, 'Customer portal', portal.status === 403 ? 'The restricted key can\'t read portal settings (add “Customer portal: write”).' : 'Couldn\'t check: ' + portal.message);
  else {
    const c = portal.json.data && portal.json.data[0];
    if (!c || c.active === false) add(false, 'Customer portal', 'Not set up in ' + mode + ' mode. In Stripe: Settings → Billing → Customer portal → Save (turn on cancellations and plan switching). “Manage subscription” and changing plans need it.');
    else {
      const upd = c.features && c.features.subscription_update;
      const listed = new Set(((upd && upd.products) || []).map(x => x.product));
      const missing = ['pro', 'max', 'ultra'].filter(p => !listed.has(s.products[p]));
      if (!upd || !upd.enabled) add(null, 'Customer portal', 'Set up, but switching plans is off. Settings → Billing → Customer portal → Subscriptions → turn on “Customers can switch plans” and add the three products.');
      else if (missing.length) add(null, 'Customer portal', 'Plan switching doesn\'t include ' + missing.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ') + '. Add their prices under Customer portal → Subscriptions → Products.');
      else add(true, 'Customer portal', 'Set up, with switching between the three plans.');
    }
  }

  if (!s.webhookSecret) add(null, 'Webhook', 'STRIPE_WEBHOOK_SECRET isn\'t set: plan changes still arrive, within 5 minutes. To make them instant, add an endpoint (below) and put its signing secret in .env.');
  const hooks = await call('/v1/webhook_endpoints?limit=100');
  const want = (cfg.publicUrl || 'https://<your site>') + '/api/billing/webhook';
  if (!hooks.ok) add(null, 'Webhook endpoint', hooks.status === 403 ? 'The restricted key can\'t list webhook endpoints (optional: “Webhook endpoints: read”).' : 'Couldn\'t check: ' + hooks.message);
  else {
    const mine = (hooks.json.data || []).filter(h => /\/api\/billing\/webhook\/?$/.test(h.url));
    if (!mine.length) add(s.webhookSecret ? false : null, 'Webhook endpoint', 'None in ' + mode + ' mode points to ' + want + '. Developers → Webhooks → Add endpoint, with the events ' + EVENTS.join(', ') + '.');
    else {
      const h = mine[0];
      const ev = new Set(h.enabled_events || []);
      const lacking = ev.has('*') ? [] : EVENTS.filter(e => !ev.has(e));
      if (h.status && h.status !== 'enabled') add(false, 'Webhook endpoint', h.url + ' is ' + h.status + ' in Stripe. Enable it.');
      else if (lacking.length) add(null, 'Webhook endpoint', h.url + ' doesn\'t send ' + lacking.join(', ') + '. Add those events.');
      else add(true, 'Webhook endpoint', h.url + (cfg.publicUrl && h.url.replace(/\/+$/, '') !== want ? ' (PUBLIC_URL is ' + cfg.publicUrl + ' — make sure this is the same site)' : ''));
    }
  }
  return out;
}

if (require.main === module) {
  const path = require('path');
  const { createEnvLoader } = require('../env-file');
  const env = createEnvLoader(path.join(__dirname, '..')).load();
  const cfg = accountConfig(process.env);
  console.log('\n  Checking Stripe for MetaCode\'s plans' + (env.found ? ' (settings: ' + env.file + ')' : ' (no .env found)') + '\n');
  if (!cfg.enabled) console.log('  ⚠ Accounts are off: ' + (cfg.problems[0] || 'SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY aren\'t set') + '\n');
  checkBilling(cfg).then(list => {
    list.forEach(r => console.log('  ' + (r.ok === true ? '✓' : r.ok === false ? '✗' : '⚠') + ' ' + r.label + (r.detail ? ' — ' + r.detail : '')));
    const bad = list.filter(r => r.ok === false).length;
    console.log('\n  ' + (bad ? bad + ' problem' + (bad === 1 ? '' : 's') + ' to fix. Then run: pm2 reload metacode' : 'Everything plans need is in place.') + '\n');
    process.exitCode = bad ? 1 : 0;
  });
}

module.exports = { checkBilling, EVENTS };
