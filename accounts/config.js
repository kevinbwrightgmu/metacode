// ── Account settings (from the environment) ───────────────────────────────────
// Accounts are on when SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set; with
// them unset MetaCode runs as before (no sign-in, no plans, no limits). Read on
// every use so Settings → Reload .env applies changes.
//
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  the project's publishable (or legacy anon) key. It is
//                             public by design — browsers use it, and Row Level
//                             Security decides what each signed-in user may read.
//                             A secret / service_role key is refused here.
//   STRIPE_SECRET_KEY         sk_live_… / sk_test_… (or a restricted rk_ key): plan lookup
//                             and checkout. Unset: everyone is on Free.
//   STRIPE_WEBHOOK_SECRET     whsec_…: lets Stripe tell MetaCode about plan changes at once
//   STRIPE_PRODUCT_PRO / _MAX / _ULTRA   product ids (defaults below)
//   STRIPE_PRICE_PRO / _MAX / _ULTRA     price ids (default: each product's default price)
//   ACCOUNT_PLAN_OVERRIDES    "<user id or verified email>=<plan>, …" — e.g. staff accounts
//   ACCOUNT_DATA_DIR          usage counters and Stripe customer links (default account-data/)

const path = require('path');

const DEFAULT_PRODUCTS = { pro: 'prod_VQeJh2lPqfmae9', max: 'prod_VQeK26tKchu1VI', ultra: 'prod_VQeKXAJtQQLKqm' };
const PAID = ['pro', 'max', 'ultra'];
const isLocalHost = host => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host);

function decodeJwtPayload(token) {
  const part = String(token).split('.')[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return null; }
}

// Never let a secret key reach the browser through /api/account/config.
function keyProblem(key) {
  if (!key) return null;
  if (/^sb_secret_/i.test(key)) return 'SUPABASE_PUBLISHABLE_KEY holds a secret key (sb_secret_…). Use the publishable key (sb_publishable_…) — the secret key must never be sent to browsers.';
  if (/^eyJ/.test(key)) {
    const p = decodeJwtPayload(key);
    if (p && p.role === 'service_role') return 'SUPABASE_PUBLISHABLE_KEY holds the service_role key. Use the anon / publishable key — the service_role key must never be sent to browsers.';
    return null;
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) return 'SUPABASE_PUBLISHABLE_KEY doesn\'t look like a Supabase publishable key (sb_publishable_…).';
  return null;
}

function urlProblem(url) {
  let u;
  try { u = new URL(url); } catch (e) { return 'SUPABASE_URL isn\'t a valid URL.'; }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocalHost(u.host))) return u.pathname.replace(/\/+$/, '') ? 'SUPABASE_URL should be just the project address, e.g. https://<project>.supabase.co' : null;
  return 'SUPABASE_URL must start with https://';
}

function parseOverrides(raw) {
  const out = { byId: {}, byEmail: {} };
  String(raw || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean).forEach(pair => {
    const m = pair.match(/^(.+?)\s*[=:]\s*(free|pro|max|ultra)$/i);
    if (!m) return;
    const who = m[1].trim(), plan = m[2].toLowerCase();
    if (who.includes('@')) out.byEmail[who.toLowerCase()] = plan; else out.byId[who] = plan;
  });
  return out;
}

function accountConfig(env) {
  env = env || process.env;
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '').trim();
  const problems = [];
  if (supabaseUrl && !publishableKey) problems.push('SUPABASE_URL is set but SUPABASE_PUBLISHABLE_KEY isn\'t — accounts are off.');
  if (!supabaseUrl && publishableKey) problems.push('SUPABASE_PUBLISHABLE_KEY is set but SUPABASE_URL isn\'t — accounts are off.');
  const up = supabaseUrl ? urlProblem(supabaseUrl) : null;
  const kp = keyProblem(publishableKey);
  if (up) problems.push(up);
  if (kp) problems.push(kp);
  const off = /^(false|off|no|0)$/i.test(String(env.ACCOUNTS_ENABLED || '').trim());
  const enabled = !!(supabaseUrl && publishableKey) && !up && !kp && !off;

  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim();
  if (secretKey && !/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(secretKey)) problems.push('STRIPE_SECRET_KEY doesn\'t look like a Stripe secret key (sk_live_… or sk_test_…).');
  // Testing only: point Stripe calls at a local mock
  let apiBase = String(env.STRIPE_API_BASE || 'https://api.stripe.com').trim().replace(/\/+$/, '');
  try { const u = new URL(apiBase); if (!(u.protocol === 'https:' || isLocalHost(u.host))) apiBase = 'https://api.stripe.com'; } catch (e) { apiBase = 'https://api.stripe.com'; }
  const products = {}, prices = {};
  PAID.forEach(p => {
    products[p] = String(env['STRIPE_PRODUCT_' + p.toUpperCase()] || DEFAULT_PRODUCTS[p]).trim();
    const price = String(env['STRIPE_PRICE_' + p.toUpperCase()] || '').trim();
    if (price) prices[p] = price;
  });
  const publicUrl = String(env.PUBLIC_URL || '').split(',').map(s => s.trim().replace(/\/+$/, '')).find(s => /^https?:\/\//i.test(s)) || null;

  return {
    enabled,
    supabaseUrl: enabled ? supabaseUrl : null,
    publishableKey: enabled ? publishableKey : null,
    stripe: {
      enabled: !!secretKey && /^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(secretKey),
      secretKey: secretKey || null,
      webhookSecret: String(env.STRIPE_WEBHOOK_SECRET || '').trim() || null,
      apiBase, products, prices
    },
    overrides: parseOverrides(env.ACCOUNT_PLAN_OVERRIDES),
    publicUrl,
    dataDir: path.resolve(String(env.ACCOUNT_DATA_DIR || '').trim() || path.join(__dirname, '..', 'account-data')),
    problems
  };
}

module.exports = { accountConfig, keyProblem, decodeJwtPayload, DEFAULT_PRODUCTS, PAID, isLocalHost };
