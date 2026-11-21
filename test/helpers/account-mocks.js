// Local stand-ins for the services accounts/ talks to, so tests never reach the
// real Supabase project or Stripe:
//   • mockSupabase(): Auth (password sign-in, sign-up, refresh, user, logout, the
//     PKCE email-link exchange, resend, sign-in links) and
//     a small PostgREST for the metacode_data table, with per-user row isolation
//     (what Row Level Security does in the real database).
//   • mockStripe(): customers, subscriptions, products, checkout and portal
//     sessions — enough of the REST API for accounts/billing.js.
// These prove MetaCode's own code against the documented API shapes; they don't
// prove the live services are configured.
const http = require('http');
const crypto = require('crypto');

const b64u = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
function jwtFor(sub, email, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + (ttlSec || 3600);
  return b64u({ alg: 'ES256', typ: 'JWT' }) + '.' + b64u({ sub, email, role: 'authenticated', aud: 'authenticated', exp }) + '.' + crypto.randomBytes(16).toString('base64url');
}
const readBody = req => new Promise(resolve => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(b)); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

function mockSupabase(opts) {
  opts = opts || {};
  const users = new Map();       // email → { id, email, password, confirmed }
  const tokens = new Map();      // access token → user id
  const refresh = new Map();     // refresh token → user id
  const rows = [];               // metacode_data rows
  const calls = [];
  const mails = [];              // emails Supabase would send: { type, email }
  const flows = new Map();       // email → code challenge of its latest PKCE flow (sign-up, link, reset, resend)
  const codes = new Map();       // auth code (from a clicked email link) → { email, challenge }
  let clock = Date.now();
  const nextStamp = () => { clock = Math.max(clock + 1, Date.now()); return new Date(clock).toISOString(); };

  function addUser(email, password, o) {
    const u = { id: (o && o.id) || crypto.randomUUID(), email: email.toLowerCase(), password, confirmed: !(o && o.unconfirmed) };
    users.set(u.email, u);
    return u;
  }
  function issue(u) {
    const access = jwtFor(u.id, u.email, 3600);
    const r = crypto.randomBytes(12).toString('hex');
    tokens.set(access, u.id);
    refresh.set(r, u.id);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: r, user: publicUser(u) };
  }
  const publicUser = u => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.confirmed ? new Date().toISOString() : null, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() });
  const userById = id => Array.from(users.values()).find(u => u.id === id) || null;
  // Someone clicks the latest link Supabase emailed to `email`: Supabase confirms the address and
  // sends the browser back with ?code=… (exchanged for a session with the verifier the browser kept)
  function clickEmailLink(email) {
    const u = users.get(String(email).toLowerCase());
    if (u) u.confirmed = true;
    const code = crypto.randomUUID();
    codes.set(code, { email: String(email).toLowerCase(), challenge: flows.get(String(email).toLowerCase()) || null });
    return code;
  }
  const flowFrom = (email, data) => { if (data.code_challenge) flows.set(String(email || '').toLowerCase(), data.code_challenge); };
  const bearerUser = req => { const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/); return m && tokens.has(m[1]) ? userById(tokens.get(m[1])) : null; };

  // PostgREST filters used by cloud-sync.js: col=eq.v, col=gt.v, col=in.(a,b)
  function matches(row, params) {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      const m = v.match(/^(eq|gt|gte|in)\.(.*)$/);
      if (!m) continue;
      const val = row[k] === undefined ? null : row[k];
      if (m[1] === 'eq' && String(val) !== decodeURIComponent(m[2])) return false;
      if (m[1] === 'gt' && !(String(val) > m[2])) return false;
      if (m[1] === 'gte' && !(String(val) >= m[2])) return false;
      if (m[1] === 'in') { const list = m[2].replace(/^\(|\)$/g, '').split(',').map(s => decodeURIComponent(s.replace(/^"|"$/g, ''))); if (!list.includes(String(val))) return false; }
    }
    return true;
  }
  // Postgres jsonb doesn't keep the order of an object's keys: it hands them back
  // shorter keys first, then in byte order. The real database does this, so the
  // stand-in does too (code that compares JSON text would break on it).
  function jsonb(v) {
    if (Array.isArray(v)) return v.map(jsonb);
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0)).forEach(k => { if (v[k] !== undefined) out[k] = jsonb(v[k]); });
      return out;
    }
    return v;
  }
  // PostgREST select: col, alias:col, col->>key and alias:col->>key (text from a JSON column)
  function project(row, select) {
    if (!select || select === '*') return Object.assign({}, row);
    const out = {};
    select.split(',').forEach(c => {
      const m = c.trim().match(/^(?:([\w]+):)?([\w]+)(?:->>([\w]+))?$/);
      if (!m) return;
      const v = m[3] ? (row[m[2]] && row[m[2]][m[3]] !== undefined && row[m[2]][m[3]] !== null ? String(row[m[2]][m[3]]) : null) : row[m[2]];
      out[m[1] || m[3] || m[2]] = v;
    });
    return out;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, apikey: req.headers.apikey || null });
    // Supabase Auth's errors carry a code; supabase-js reads it on API version 2024-01-01 responses
    const json = (status, obj, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' }, headers || {})); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') return json(204);
    if (opts.apikey && req.headers.apikey !== opts.apikey) return json(401, { message: 'Invalid API key' });
    const p = url.pathname;
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch (e) { data = {}; }

    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = users.get(String(data.email || '').toLowerCase());
      if (!u || u.password !== data.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (!u.confirmed) return json(400, { error: 'invalid_grant', code: 'email_not_confirmed', msg: 'Email not confirmed' });
      if (opts.captcha && !(data.gotrue_meta_security && data.gotrue_meta_security.captcha_token)) return json(400, { code: 'captcha_failed', msg: 'captcha protection: request disallowed (no captcha response)' });
      return json(200, issue(u));
    }
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
      const c = codes.get(data.auth_code);
      if (!c) return json(400, { code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' });
      codes.delete(data.auth_code);
      const hashed = crypto.createHash('sha256').update(String(data.code_verifier || '')).digest('base64url');
      if (!c.challenge || hashed !== c.challenge) return json(400, { code: 'bad_code_verifier', msg: 'code challenge does not match previously saved code verifier' });
      return json(200, issue(users.get(c.email)));
    }
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const id = refresh.get(data.refresh_token);
      if (!id) return json(400, { error: 'invalid_grant', msg: 'Invalid Refresh Token' });
      refresh.delete(data.refresh_token);
      return json(200, issue(userById(id)));
    }
    if (p === '/auth/v1/signup') {
      if (users.has(String(data.email || '').toLowerCase())) return json(422, { code: 'user_already_exists', msg: 'User already registered' });
      if (opts.emailTeam && !opts.emailTeam.includes(String(data.email || '').toLowerCase())) return json(400, { code: 'email_address_not_authorized', msg: 'Email address "' + data.email + '" cannot be used as it is not authorized' });
      const u = addUser(String(data.email), String(data.password), { unconfirmed: !!opts.confirmEmail });
      flowFrom(u.email, data);
      if (opts.confirmEmail) { mails.push({ type: 'signup', email: u.email }); return json(200, publicUser(u)); }
      return json(200, issue(u));
    }
    if (p === '/auth/v1/user' && req.method === 'GET') {
      const u = bearerUser(req);
      return u ? json(200, publicUser(u)) : json(401, { code: 'bad_jwt', msg: 'invalid JWT' });
    }
    if (p === '/auth/v1/user' && req.method === 'PUT') {
      const u = bearerUser(req);
      if (!u) return json(401, { msg: 'invalid JWT' });
      if (data.password) u.password = data.password;
      return json(200, publicUser(u));
    }
    if (p === '/auth/v1/logout') {
      const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
      if (m) tokens.delete(m[1]);
      return json(204);
    }
    if (p === '/auth/v1/otp') {
      if (data.create_user === false && !users.has(String(data.email || '').toLowerCase())) return json(422, { code: 'otp_disabled', msg: 'Signups not allowed for otp' });
      flowFrom(data.email, data);
      mails.push({ type: 'magiclink', email: String(data.email || '').toLowerCase() });
      return json(200, {});
    }
    if (p === '/auth/v1/recover') { flowFrom(data.email, data); mails.push({ type: 'recovery', email: String(data.email || '').toLowerCase() }); return json(200, {}); }
    if (p === '/auth/v1/resend') {
      if (opts.emailLimit && mails.length >= opts.emailLimit) return json(429, { code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
      flowFrom(data.email, data);
      mails.push({ type: data.type, email: String(data.email || '').toLowerCase() });
      return json(200, {});
    }
    if (p === '/auth/v1/settings') return json(200, { external: { email: true }, disable_signup: false });

    if (p === '/rest/v1/metacode_data') {
      const u = bearerUser(req);
      if (!u) return json(401, { code: 'PGRST301', message: 'JWT invalid' });
      const params = Array.from(url.searchParams.entries());
      const mine = rows.filter(r => r.user_id === u.id);
      if (req.method === 'GET') {
        let list = mine.filter(r => matches(r, params));
        list.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
        const limit = Number(url.searchParams.get('limit')) || list.length;
        return json(200, list.slice(0, limit).map(r => project(r, url.searchParams.get('select'))));
      }
      if (req.method === 'POST') {
        const list = Array.isArray(data) ? data : [data];
        const saved = [];
        for (const r of list) {
          if (r.user_id && r.user_id !== u.id) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "metacode_data"' });
          const row = { user_id: u.id, kind: r.kind, id: r.id, data: r.data === undefined || r.data === null ? null : jsonb(r.data), deleted: !!r.deleted, updated_at: nextStamp() };
          const i = rows.findIndex(x => x.user_id === u.id && x.kind === row.kind && x.id === row.id);
          if (i >= 0) rows[i] = row; else rows.push(row);
          saved.push(row);
        }
        // ?select=… (supabase-js .upsert().select()) returns what was saved, with the server's timestamps
        if (url.searchParams.get('select')) return json(201, saved.map(r => project(r, url.searchParams.get('select'))));
        return json(201, undefined);
      }
      if (req.method === 'DELETE') {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === u.id && matches(rows[i], params)) rows.splice(i, 1);
        return json(204);
      }
      return json(405, { message: 'method' });
    }
    json(404, { message: 'not found: ' + p });
  });

  return {
    server, users, rows, calls, mails, addUser, issue, jwtFor, clickEmailLink,
    async start() { this.url = await listen(server); return this.url; },
    close: () => close(server)
  };
}

function mockStripe(opts) {
  opts = opts || {};
  const customers = new Map();     // id → { id, email, metadata }
  const subscriptions = [];        // { id, customer, status, items: { data: [{ price: { id, product } }] }, current_period_end, cancel_at_period_end }
  const products = Object.assign({}, opts.products || {});   // id → { id, default_price, active }
  const calls = [];
  const sessions = [];
  const recurring = (id, amount, product) => ({ id, object: 'price', active: true, type: 'recurring', unit_amount: amount, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, product });
  const prices = Object.assign({
    price_pro: recurring('price_pro', 900, 'prod_VQeJh2lPqfmae9'),
    price_max: recurring('price_max', 2900, 'prod_VQeK26tKchu1VI'),
    price_ultra: recurring('price_ultra', 7900, 'prod_VQeKXAJtQQLKqm')
  }, opts.prices || {});
  const parseForm = body => {
    const out = {};
    new URLSearchParams(body).forEach((v, k) => { out[k] = v; });
    return out;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization || null, idempotency: req.headers['idempotency-key'] || null });
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer ' + (opts.key || 'sk_test_mock')) return json(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    const p = url.pathname;
    // A restricted key without permission for this kind of object
    if ((opts.denied || []).some(prefix => p.startsWith(prefix))) return json(403, { error: { type: 'invalid_request_error', message: "The provided key 'rk_live_…' does not have the required permissions for this endpoint on account 'acct_1'." } });
    if (p === '/v1/account') return json(200, Object.assign({ id: 'acct_1', object: 'account', charges_enabled: true }, opts.account || {}));
    if (p === '/v1/customers' && req.method === 'GET') return json(200, { object: 'list', data: Array.from(customers.values()).slice(0, 1) });
    if (/^\/v1\/customers\/cus_[A-Za-z0-9]+$/.test(p) && req.method === 'POST' && !customers.has(p.split('/').pop())) return json(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: "No such customer: '" + p.split('/').pop() + "'" } });
    if (/^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(p)) return json(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such checkout.session' } });
    if (p === '/v1/customers/search') {
      const m = String(url.searchParams.get('query') || '').match(/metadata\['supabase_user_id'\]:'([^']+)'/);
      const found = Array.from(customers.values()).filter(c => m && c.metadata.supabase_user_id === m[1]);
      return json(200, { object: 'search_result', data: found });
    }
    if (p === '/v1/customers' && req.method === 'POST') {
      const f = parseForm(body);
      const id = 'cus_' + crypto.randomBytes(6).toString('hex');
      const c = { id, object: 'customer', email: f.email || null, metadata: { supabase_user_id: f['metadata[supabase_user_id]'] } };
      customers.set(id, c);
      return json(200, c);
    }
    if (p === '/v1/subscriptions' && req.method === 'GET') {
      return json(200, { object: 'list', data: subscriptions.filter(s => s.customer === url.searchParams.get('customer')) });
    }
    const price = p.match(/^\/v1\/prices\/([^/]+)$/);
    if (price) { const pr = prices[price[1]]; return pr ? json(200, pr) : json(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: "No such price: '" + price[1] + "'" } }); }
    const prod = p.match(/^\/v1\/products\/([^/]+)$/);
    if (prod) return products[prod[1]] ? json(200, products[prod[1]]) : json(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: "No such product: '" + prod[1] + "'" } });
    if (p === '/v1/billing_portal/configurations') return json(200, { object: 'list', data: opts.portal || [] });
    if (p === '/v1/webhook_endpoints') return json(200, { object: 'list', data: opts.webhooks || [] });
    if (p === '/v1/checkout/sessions' && req.method === 'POST') {
      const f = parseForm(body);
      sessions.push(f);
      return json(200, { id: 'cs_test_' + sessions.length, object: 'checkout.session', url: 'https://checkout.stripe.test/c/pay/cs_test_' + sessions.length, form: f });
    }
    if (p === '/v1/billing_portal/sessions' && req.method === 'POST') {
      const f = parseForm(body);
      if (f.customer && !customers.has(f.customer)) return json(400, { error: { type: 'invalid_request_error', code: 'resource_missing', param: 'customer', message: "No such customer: '" + f.customer + "'" } });
      return json(200, { id: 'bps_1', url: 'https://billing.stripe.test/p/session/' + f.customer });
    }
    json(404, { error: { type: 'invalid_request_error', message: 'Unrecognized request URL' } });
  });
  return {
    server, customers, subscriptions, products, calls, sessions,
    // Gives a customer (made for userId if needed) a subscription to product
    subscribe(userId, product, status) {
      let c = Array.from(customers.values()).find(x => x.metadata.supabase_user_id === userId);
      if (!c) { c = { id: 'cus_' + crypto.randomBytes(6).toString('hex'), object: 'customer', metadata: { supabase_user_id: userId } }; customers.set(c.id, c); }
      const s = { id: 'sub_' + crypto.randomBytes(6).toString('hex'), object: 'subscription', customer: c.id, status: status || 'active', cancel_at_period_end: false,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { supabase_user_id: userId }, items: { data: [{ price: { id: 'price_' + product, product } }] } };
      subscriptions.push(s);
      return s;
    },
    async start() { this.url = await listen(server); return this.url; },
    close: () => close(server)
  };
}

// A Stripe-Signature header for body, as Stripe would send it
function stripeSignature(body, secret, t) {
  t = t || Math.floor(Date.now() / 1000);
  return 't=' + t + ',v1=' + crypto.createHmac('sha256', secret).update(t + '.' + body).digest('hex');
}

module.exports = { mockSupabase, mockStripe, stripeSignature, jwtFor };
