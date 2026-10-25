/* ══════════════════════════════════════════════
   account.js — sign-in, plans and limits in MetaCode's pages

   Accounts are on when the server has Supabase settings (GET /api/account/
   config); otherwise this file does nothing and MetaCode works as before.

   • Sign-in uses Supabase Auth in the browser (supabase-js, served by MetaCode
     at /vendor/supabase.js): email + password, sign-up with email
     confirmation, password reset, and email sign-in links (PKCE flow).
   • The session's access token goes to MetaCode's own server in the
     mc_session cookie (SameSite=Strict). The server checks it with Supabase and
     takes the plan from Stripe — nothing here decides what anyone may do; it
     only shows it (GET /api/account/me).
   • Plan dialogs, checkout (Stripe Checkout) and the billing portal.
   • The account chip in the top bar, the Account page (app.html#account), the
     plan gates on pages that need a plan, and lock badges in the sidebar.
   • Any MetaCode API answer that says "sign in", "upgrade" or "limit reached"
     opens the matching dialog, wherever the request came from.
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Plans = root.MetaPlans;
  const COOKIE = 'mc_session';
  const ACCOUNT_TYPES = new Set(['sign_in_required', 'plan_required', 'limit_reached', 'account_rate_limited', 'account_unavailable']);
  // App pages that need a plan, and the feature they need
  const GATED = { 'scraper': 'scraper', 'scraper-beta': 'aiScraper', 'csv-analyzer': 'network', 'network': 'network' };

  let config = null, client = null, session = null, me = null, prices = null;
  const listeners = [];
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  const origFetch = root.fetch.bind(root);

  const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const fmt = n => Number(n).toLocaleString();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // app.js declares `const App` (not a window property); studio-shell.js sets window.App
  const app = () => (typeof App !== 'undefined' ? App : root.App) || null;
  function notify(msg, type, ms) {
    if (app() && typeof app().notify === 'function') return app().notify(msg, type || 'info', ms);
    // the AI Coding Lab's own toasts (lab-core.js), so the two stacks don't overlap
    if (typeof Lab !== 'undefined' && Lab && typeof Lab.notify === 'function') return Lab.notify(msg, type || 'info', ms);
    let stack = document.getElementById('acct-toasts');
    if (!stack) { stack = document.createElement('div'); stack.id = 'acct-toasts'; stack.className = 'acct-toasts'; stack.setAttribute('role', 'status'); document.body.appendChild(stack); }
    const el = document.createElement('div');
    el.className = 'acct-toast ' + (type || 'info');
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), ms || 4000);
  }

  /* ── The session cookie for MetaCode's server ── */
  function setCookie(s) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    if (s && s.access_token) {
      const left = s.expires_at ? Math.max(30, s.expires_at - Math.floor(Date.now() / 1000) - 15) : 3000;
      document.cookie = COOKIE + '=' + encodeURIComponent(s.access_token) + '; Path=/; Max-Age=' + left + '; SameSite=Strict' + secure;
    } else {
      document.cookie = COOKIE + '=; Path=/; Max-Age=0; SameSite=Strict' + secure;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('Couldn\'t load ' + src));
      document.head.appendChild(s);
    });
  }

  // Sign-in links and confirmations come back as ?code=… (PKCE); tidy the address bar afterwards.
  function cleanUrl() {
    const u = new URL(location.href);
    let changed = false;
    ['code', 'error', 'error_code', 'error_description', 'type'].forEach(k => { if (u.searchParams.has(k)) { u.searchParams.delete(k); changed = true; } });
    if (changed) history.replaceState(null, '', u.pathname + (u.search && u.search !== '?' ? u.search : '') + u.hash);
  }

  async function init() {
    try {
      const r = await origFetch('/api/account/config', { credentials: 'same-origin' });
      config = r.ok ? await r.json() : { enabled: false };
    } catch (e) { config = { enabled: false }; }
    if (!config.enabled) { readyResolve(); emit(); return; }
    const linkError = new URL(location.href).searchParams.get('error_description');
    try {
      if (!root.supabase || !root.supabase.createClient) await loadScript('/vendor/supabase.js');
      client = root.supabase.createClient(config.supabaseUrl, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
      });
      client.auth.onAuthStateChange((event, s) => onSession(event, s));
      const { data } = await client.auth.getSession();
      session = (data && data.session) || null;
      setCookie(session);
    } catch (e) {
      console.warn('[account] Sign-in isn\'t available: ' + (e && e.message));
    }
    cleanUrl();
    if (linkError) setTimeout(() => notify('That sign-in link didn\'t work: ' + linkError, 'error', 7000), 300);
    readyResolve();
    await refresh();
  }

  function onSession(event, s) {
    const before = session && session.user ? session.user.id : null;
    session = s || null;
    setCookie(session);
    const after = session && session.user ? session.user.id : null;
    if (event === 'PASSWORD_RECOVERY') setTimeout(openNewPassword, 0);
    // (never await Supabase calls inside this callback)
    if (before !== after || event === 'SIGNED_OUT' || event === 'USER_UPDATED') setTimeout(refresh, 0);
  }

  async function refresh() {
    if (!config || !config.enabled) { emit(); return me; }
    try {
      const r = await origFetch('/api/account/me', { credentials: 'same-origin', cache: 'no-store' });
      me = r.ok ? await r.json() : me;
    } catch (e) { /* offline: keep what we had */ }
    emit();
    return me;
  }

  function emit() {
    listeners.slice().forEach(fn => { try { fn(me); } catch (e) { console.error(e); } });
    document.querySelectorAll('[data-account-chip]').forEach(renderChip);
    decorateNav();
    try { document.dispatchEvent(new CustomEvent('metacode:account', { detail: me })); } catch (e) { /* old browser */ }
  }

  /* ── What the current plan allows (display only — the server decides) ── */
  const enabled = () => !!(config && config.enabled);
  const known = () => !!(config && (!config.enabled || me));
  const signedIn = () => !!(me && me.signedIn);
  const plan = () => (me && me.plan) || { id: 'free', name: 'Free' };
  function can(feature) {
    if (!enabled()) return true;
    return signedIn() && !!(me.features && me.features[feature]);
  }
  function featureLabel(feature) { return (Plans.FEATURES[feature] || { label: feature }).label; }
  function plansWith(feature) { const low = Plans.lowestWith(feature); return low ? Plans.namesFrom(low.id) : []; }

  // true when allowed (or accounts are off); otherwise opens sign-in / plans and returns false
  function requireFeature(feature, what) {
    if (!enabled()) return true;
    const label = what || featureLabel(feature);
    if (!me) { notify('Checking your account…', 'info', 1500); return false; }
    if (!signedIn()) { openSignIn({ reason: 'Sign in to use ' + label + '.' }); return false; }
    if (!can(feature)) {
      const names = plansWith(feature);
      openPlans({ reason: cap(label) + ' is part of the ' + Plans.listNames(names) + ' plan' + (names.length > 1 ? 's' : '') + '.', highlight: (Plans.lowestWith(feature) || {}).id });
      return false;
    }
    return true;
  }

  /* ── API answers that need the person's attention ── */
  let lastPrompt = { type: '', at: 0 };
  function isOurApi(url) {
    try { const u = new URL(url, location.href); return u.origin === location.origin && /^\/api\//.test(u.pathname) && !/^\/api\/(public\/|account\/config)/.test(u.pathname); } catch (e) { return false; }
  }
  function handleApiError(err) {
    if (!err || !ACCOUNT_TYPES.has(err.type) || !enabled()) return false;
    const now = Date.now();
    if (lastPrompt.type === err.type && now - lastPrompt.at < 2000) return true;
    lastPrompt = { type: err.type, at: now };
    if (dialogOpen() && err.type !== 'account_rate_limited') return true;
    if (err.type === 'sign_in_required') openSignIn({ reason: err.message });
    else if (err.type === 'plan_required') openPlans({ reason: err.message, highlight: err.requiredPlan });
    else if (err.type === 'limit_reached') { if (err.upgradeTo) openPlans({ reason: err.message, highlight: err.upgradeTo }); else notify(err.message, 'warning', 8000); refresh(); }
    else notify(err.message, 'warning', 6000);
    return true;
  }
  root.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const ours = isOurApi(url);
    // The first requests wait (briefly) until the session cookie is fresh
    if (ours && !/\/api\/account\/(me|prices)/.test(url)) await Promise.race([ready, sleep(4000)]);
    const res = await origFetch(input, init);
    // Only something the person did (a POST, PUT, …) opens a dialog; background loads (GET) fail quietly
    const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (ours && method !== 'GET' && method !== 'HEAD' && enabled() && [401, 402, 403, 429, 503].includes(res.status) && /json/.test(res.headers.get('content-type') || '')) {
      res.clone().json().then(j => handleApiError(j && j.error)).catch(() => {});
    }
    return res;
  };

  /* ── Dialogs ───────────────────────────────── */
  let openDialog = null;
  function dialogOpen() { return !!openDialog; }
  function dialog(title, bodyHTML, opts) {
    opts = opts || {};
    closeDialog();
    const wrap = document.createElement('div');
    wrap.className = 'acct-overlay';
    wrap.innerHTML = '<div class="acct-dialog' + (opts.wide ? ' is-wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="acct-d-title">' +
      '<div class="acct-d-head"><h2 id="acct-d-title">' + esc(title) + '</h2><button type="button" class="acct-x" aria-label="Close">✕</button></div>' +
      '<div class="acct-d-body">' + bodyHTML + '</div></div>';
    const prev = document.activeElement;
    const close = () => {
      if (!wrap.parentNode) return;
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      if (openDialog && openDialog.wrap === wrap) openDialog = null;
      if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
      if (opts.onClose) opts.onClose();
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    wrap.querySelector('.acct-x').onclick = close;
    document.body.appendChild(wrap);
    openDialog = { wrap, close };
    const first = wrap.querySelector('input, button.acct-primary, .acct-d-body button');
    setTimeout(() => { if (first) first.focus(); }, 30);
    return { el: wrap, close };
  }
  function closeDialog() { if (openDialog) openDialog.close(); }

  function authError(e) {
    const m = String((e && (e.message || e.msg)) || 'Something went wrong.');
    if (/invalid login credentials/i.test(m)) return 'That email and password don\'t match an account.';
    if (/email not confirmed/i.test(m)) return 'Confirm your email first — open the link we sent you, then sign in.';
    if (/already registered|already exists/i.test(m)) return 'There\'s already an account with that email. Sign in instead.';
    if (/fetch|network/i.test(m)) return 'MetaCode couldn\'t reach the sign-in service. Check your connection and try again.';
    return m;
  }
  const redirectTo = () => location.origin + '/app.html';

  function openSignIn(opts) {
    opts = opts || {};
    if (!enabled()) return;
    if (!client) { notify('Sign-in isn\'t available right now. Reload the page and try again.', 'error'); return; }
    let mode = opts.mode || 'signin';
    const d = dialog(mode === 'signup' ? 'Create your MetaCode account' : 'Sign in to MetaCode', '', { onClose: opts.onClose });
    const body = d.el.querySelector('.acct-d-body');
    const draw = () => {
      d.el.querySelector('#acct-d-title').textContent = mode === 'signup' ? 'Create your MetaCode account' : mode === 'reset' ? 'Reset your password' : 'Sign in to MetaCode';
      body.innerHTML = (opts.reason ? '<p class="acct-reason">' + esc(opts.reason) + '</p>' : '') +
        '<div class="acct-tabs" role="tablist">' +
          '<button type="button" role="tab" data-mode="signin" aria-selected="' + (mode !== 'signup') + '">Sign in</button>' +
          '<button type="button" role="tab" data-mode="signup" aria-selected="' + (mode === 'signup') + '">Create account</button></div>' +
        '<form class="acct-form" novalidate>' +
          '<label>Email<input type="email" name="email" autocomplete="email" required maxlength="254" value="' + esc(opts.email || '') + '"></label>' +
          (mode === 'reset' ? '' : '<label>Password<input type="password" name="password" autocomplete="' + (mode === 'signup' ? 'new-password' : 'current-password') + '" required minlength="' + (mode === 'signup' ? 8 : 1) + '" maxlength="200">' + (mode === 'signup' ? '<small>At least 8 characters.</small>' : '') + '</label>') +
          '<p class="acct-err" role="alert"></p>' +
          '<button type="submit" class="acct-primary">' + (mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Email me a reset link' : 'Sign in') + '</button>' +
          (mode === 'signin' ? '<div class="acct-links"><button type="button" data-act="reset">Forgot password?</button><button type="button" data-act="link">Email me a sign-in link</button></div>' : '') +
          (mode === 'reset' ? '<div class="acct-links"><button type="button" data-mode="signin">Back to sign in</button></div>' : '') +
        '</form>' +
        '<p class="acct-fine">' + (mode === 'signup' ? 'Free accounts include AI coding of up to ' + fmt(Plans.get('free').limits.aiPostsPerWeek) + ' posts a week. ' : '') +
          'Your projects and surveys are saved to your account, so they\'re there on any device you sign in on.</p>';
      body.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { opts.email = body.querySelector('[name=email]').value; mode = b.dataset.mode; draw(); }; });
      const form = body.querySelector('form');
      const err = body.querySelector('.acct-err');
      const email = () => body.querySelector('[name=email]').value.trim();
      const busy = (on, label) => { const b = form.querySelector('.acct-primary'); b.disabled = on; if (label) b.textContent = label; };
      const actBtn = body.querySelector('[data-act=reset]');
      if (actBtn) actBtn.onclick = () => { opts.email = email(); mode = 'reset'; draw(); };
      const linkBtn = body.querySelector('[data-act=link]');
      if (linkBtn) linkBtn.onclick = async () => {
        err.textContent = '';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email())) { err.textContent = 'Enter your email address first.'; return; }
        linkBtn.disabled = true;
        const { error } = await client.auth.signInWithOtp({ email: email(), options: { emailRedirectTo: redirectTo(), shouldCreateUser: false } });
        linkBtn.disabled = false;
        if (error) { err.textContent = authError(error); return; }
        body.innerHTML = '<p class="acct-ok">Check your inbox: we sent a sign-in link to <b>' + esc(email()) + '</b>. Open it in this browser.</p>';
      };
      form.onsubmit = async e => {
        e.preventDefault();
        err.textContent = '';
        const pw = form.querySelector('[name=password]');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email())) { err.textContent = 'Enter a valid email address.'; return; }
        if (pw && mode === 'signup' && pw.value.length < 8) { err.textContent = 'Use at least 8 characters for your password.'; return; }
        if (pw && !pw.value) { err.textContent = 'Enter your password.'; return; }
        try {
          if (mode === 'reset') {
            busy(true, 'Sending…');
            const { error } = await client.auth.resetPasswordForEmail(email(), { redirectTo: redirectTo() });
            if (error) throw error;
            body.innerHTML = '<p class="acct-ok">If there\'s an account for <b>' + esc(email()) + '</b>, a link to set a new password is on its way. Open it in this browser.</p>';
            return;
          }
          if (mode === 'signup') {
            busy(true, 'Creating your account…');
            const { data, error } = await client.auth.signUp({ email: email(), password: pw.value, options: { emailRedirectTo: redirectTo() } });
            if (error) throw error;
            if (!data.session) {
              body.innerHTML = '<p class="acct-ok">Almost there — we sent a confirmation link to <b>' + esc(email()) + '</b>. Open it in this browser to finish creating your account.</p>';
              return;
            }
          } else {
            busy(true, 'Signing in…');
            const { error } = await client.auth.signInWithPassword({ email: email(), password: pw.value });
            if (error) throw error;
          }
          d.close();
          notify('Signed in as ' + email(), 'success');
          if (opts.then) setTimeout(opts.then, 300);
        } catch (x) {
          err.textContent = authError(x);
          busy(false, mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Email me a reset link' : 'Sign in');
        }
      };
      setTimeout(() => { const f = body.querySelector('[name=email]'); if (f && !f.value) f.focus(); else if (body.querySelector('[name=password]')) body.querySelector('[name=password]').focus(); }, 30);
    };
    draw();
  }

  function openNewPassword() {
    const d = dialog('Choose a new password',
      '<form class="acct-form" novalidate><label>New password<input type="password" name="pw" autocomplete="new-password" minlength="8" maxlength="200" required><small>At least 8 characters.</small></label>' +
      '<label>Repeat it<input type="password" name="pw2" autocomplete="new-password" maxlength="200" required></label><p class="acct-err" role="alert"></p>' +
      '<button type="submit" class="acct-primary">Save the new password</button></form>');
    const form = d.el.querySelector('form'), err = d.el.querySelector('.acct-err');
    form.onsubmit = async e => {
      e.preventDefault();
      const a = form.pw.value, b = form.pw2.value;
      if (a.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
      if (a !== b) { err.textContent = 'The two passwords are different.'; return; }
      const { error } = await client.auth.updateUser({ password: a });
      if (error) { err.textContent = authError(error); return; }
      d.close();
      notify('Your new password is saved.', 'success');
    };
  }

  async function loadPrices() {
    if (prices) return prices;
    try { const r = await origFetch('/api/account/prices'); prices = r.ok ? (await r.json()).prices || {} : {}; } catch (e) { prices = {}; }
    return prices;
  }
  function priceLabel(id) {
    const p = prices && prices[id];
    if (!p) return '';
    const amount = (p.amount / 100).toLocaleString(undefined, { style: 'currency', currency: p.currency.toUpperCase(), minimumFractionDigits: p.amount % 100 ? 2 : 0 });
    return amount + (p.interval ? ' / ' + p.interval : '');
  }

  function plansHTML(highlight) {
    const cur = signedIn() ? plan().id : null;
    const curRank = cur ? Plans.get(cur).rank : -1;
    const managed = me && me.plan && me.plan.source === 'override';
    return '<div class="acct-plans">' + Plans.ORDER.map(id => {
      const p = Plans.get(id);
      let action = '';
      if (cur === id) action = '<span class="acct-current">Your plan</span>';
      else if (id === 'free') action = cur ? '' : '<button type="button" class="acct-secondary" data-signup>Create a free account</button>';
      else if (managed) action = '';
      else if (!cur) action = '<button type="button" class="acct-primary" data-choose="' + id + '">Choose ' + p.name + '</button>';
      else if (p.rank > curRank) action = '<button type="button" class="acct-primary" data-choose="' + id + '">Upgrade to ' + p.name + '</button>';
      else action = '<button type="button" class="acct-secondary" data-choose="' + id + '">Switch to ' + p.name + '</button>';
      return '<div class="acct-plan' + (id === highlight ? ' is-highlight' : '') + (cur === id ? ' is-current' : '') + '">' +
        '<div class="acct-plan-name">' + p.name + '</div><div class="acct-plan-price">' + (id === 'free' ? '$0' : esc(priceLabel(id)) || '&nbsp;') + '</div>' +
        '<div class="acct-plan-tag">' + esc(p.tagline) + '</div><ul>' + Plans.highlights(id).map(h => '<li>' + esc(h) + '</li>').join('') + '</ul>' +
        '<div class="acct-plan-act">' + action + '</div></div>';
    }).join('') + '</div>';
  }
  function wirePlans(scope, onDone) {
    scope.querySelectorAll('[data-choose]').forEach(b => { b.onclick = () => choosePlan(b.dataset.choose, b); });
    scope.querySelectorAll('[data-signup]').forEach(b => { b.onclick = () => { if (onDone) onDone(); openSignIn({ mode: 'signup' }); }; });
  }

  async function openPlans(opts) {
    opts = opts || {};
    if (!enabled()) return;
    await loadPrices();
    const d = dialog('MetaCode plans', (opts.reason ? '<p class="acct-reason">' + esc(opts.reason) + '</p>' : '') + plansHTML(opts.highlight) +
      '<p class="acct-fine">Plans renew monthly and can be changed or cancelled any time from Account → Manage subscription. AI coding posts reset every Monday (00:00 UTC); other monthly limits on the 1st, daily ones at midnight UTC.</p>', { wide: true });
    wirePlans(d.el, d.close);
  }

  async function postJson(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok) { const e = new Error((j && j.error && j.error.message) || 'Request failed (' + r.status + ')'); e.type = j && j.error && j.error.type; throw e; }
    return j || {};
  }
  async function choosePlan(id, btn) {
    if (!signedIn()) { closeDialog(); openSignIn({ reason: 'Create an account or sign in to choose ' + Plans.get(id).name + '.', mode: 'signup' }); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Opening checkout…'; }
    try {
      const out = await postJson('/api/billing/checkout', { plan: id });
      if (out.url) location.href = out.url;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      if (!ACCOUNT_TYPES.has(e.type)) notify(e.message, 'error', 7000);
    }
  }
  async function manageBilling(btn) {
    if (btn) btn.disabled = true;
    try { const out = await postJson('/api/billing/portal'); if (out.url) location.href = out.url; }
    catch (e) { notify(e.message, 'error', 6000); if (btn) btn.disabled = false; }
  }

  async function signOut() {
    if (!client) return;
    if (root.CloudSync && typeof root.CloudSync.beforeSignOut === 'function') {
      const ok = await root.CloudSync.beforeSignOut();
      if (!ok) return;
    }
    try { await client.auth.signOut(); } catch (e) { /* the session is dropped locally anyway */ }
    setCookie(null);
    me = Object.assign({}, me || {}, { signedIn: false });
    notify('Signed out', 'info');
    setTimeout(() => location.reload(), 400);
  }

  /* ── The account chip (top bars) ───────────── */
  function initials(email) { return String(email || '?').charAt(0).toUpperCase(); }
  function renderChip(el) {
    if (!enabled()) { el.hidden = true; return; }
    el.hidden = false;
    if (!me) { el.innerHTML = '<span class="acct-chip is-loading" aria-hidden="true">…</span>'; return; }
    if (!signedIn()) {
      el.innerHTML = '<button type="button" class="acct-chip acct-signin">Sign in</button>';
      el.querySelector('button').onclick = () => openSignIn();
      return;
    }
    const p = plan();
    el.innerHTML = '<button type="button" class="acct-chip" aria-haspopup="menu" aria-expanded="false" title="' + esc(me.user.email) + '">' +
      '<span class="acct-avatar" aria-hidden="true">' + esc(initials(me.user.email)) + '</span><span class="acct-plan-badge plan-' + esc(p.id) + '">' + esc(p.name) + '</span></button>';
    const btn = el.querySelector('button');
    btn.onclick = e => { e.stopPropagation(); toggleMenu(el, btn); };
  }
  function toggleMenu(el, btn) {
    const open = document.querySelector('.acct-menu');
    if (open) { open.remove(); btn.setAttribute('aria-expanded', 'false'); return; }
    const p = plan();
    const m = document.createElement('div');
    m.className = 'acct-menu';
    m.setAttribute('role', 'menu');
    const accountUrl = /\/app\.html$/.test(location.pathname) ? '#account' : 'app.html#account';
    m.innerHTML = '<div class="acct-menu-who"><b>' + esc(me.user.email) + '</b><span>' + esc(p.name) + ' plan</span></div>' +
      '<a role="menuitem" href="' + accountUrl + '">Account &amp; usage</a>' +
      '<button type="button" role="menuitem" data-m="plans">Plans</button>' +
      (me.billing && me.billing.canManage ? '<button type="button" role="menuitem" data-m="manage">Manage subscription</button>' : '') +
      '<button type="button" role="menuitem" data-m="out">Sign out</button>';
    el.appendChild(m);
    btn.setAttribute('aria-expanded', 'true');
    const close = () => { m.remove(); btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);
    m.querySelector('[data-m=plans]').onclick = () => { close(); openPlans(); };
    const mg = m.querySelector('[data-m=manage]'); if (mg) mg.onclick = () => { close(); manageBilling(); };
    m.querySelector('[data-m=out]').onclick = () => { close(); signOut(); };
    m.querySelector('a').addEventListener('click', close);
  }

  /* ── Sidebar locks and page gates (app.html) ── */
  function decorateNav() {
    document.querySelectorAll('.nav-item[data-view], .nav-item[data-feature]').forEach(a => {
      const f = a.dataset.feature || GATED[a.dataset.view];
      let lock = a.querySelector('.nav-lock');
      const need = f && enabled() && me && !can(f) ? (Plans.lowestWith(f) || {}).name : null;
      if (!need) { if (lock) lock.remove(); return; }
      if (!lock) { lock = document.createElement('span'); lock.className = 'nav-lock'; a.appendChild(lock); }
      lock.textContent = need;
      lock.title = cap(featureLabel(f)) + ' needs ' + need + ' or higher';
    });
  }

  // Renders a plan prompt instead of a page that needs a plan. → true when it did.
  function gate(view, container) {
    const f = GATED[view];
    if (!f) return false;
    if (!known()) {
      container.innerHTML = '<div class="loading-state">Checking your plan…</div>';
      const again = () => { off(again); const a = app(); if (a && a.getCurrentView && a.getCurrentView().id === view) a.navigate(location.hash.slice(1) || view); };
      onChange(again);
      return true;
    }
    if (can(f)) return false;
    container.innerHTML = gateHTML(f);
    wireGate(container, f);
    return true;
  }
  function gateHTML(f, title) {
    const low = Plans.lowestWith(f);
    const names = plansWith(f);
    const head = signedIn() ? cap(featureLabel(f)) + ' is part of the ' + Plans.listNames(names) + ' plan' + (names.length > 1 ? 's' : '') + '.'
      : 'Sign in to use ' + featureLabel(f) + '.';
    return '<div class="acct-gate"><div class="acct-gate-card"><div class="acct-gate-icon" aria-hidden="true">🔒</div><h2>' + esc(title || head) + '</h2>' +
      (title ? '<p>' + esc(head) + '</p>' : '') +
      '<p>' + (signedIn() ? 'You\'re on the ' + esc(plan().name) + ' plan. ' + esc(Plans.get(low.id).name) + ' adds ' + esc(featureLabel(f)) + '.'
        : 'It\'s part of the ' + esc(Plans.listNames(names)) + ' plans; free accounts can import, code and analyse their own data.') + '</p>' +
      '<div class="acct-gate-actions">' + (signedIn() ? '<button type="button" class="acct-primary" data-gate="plans">See plans</button>' : '<button type="button" class="acct-primary" data-gate="signin">Sign in</button><button type="button" class="acct-secondary" data-gate="plans">See plans</button>') + '</div></div></div>';
  }
  function wireGate(container, f) {
    container.querySelectorAll('[data-gate]').forEach(b => {
      b.onclick = () => (b.dataset.gate === 'signin' ? openSignIn({ reason: 'Sign in to use ' + featureLabel(f) + '.' }) : openPlans({ highlight: (Plans.lowestWith(f) || {}).id }));
    });
  }

  /* ── Usage ─────────────────────────────────── */
  function usageOf(meter) { return me && me.usage ? me.usage[meter] : null; }
  function meterHTML(meter, opts) {
    opts = opts || {};
    const m = Plans.METERS[meter], u = usageOf(meter);
    if (!m || !u) return '';
    if (!u.limit) return '<div class="acct-meter is-none"><div class="acct-meter-top"><span>' + esc(m.label) + '</span><span>Not in your plan</span></div></div>';
    const pct = Math.min(100, Math.round(u.used / u.limit * 100));
    const reset = new Date(u.resetsAt);
    return '<div class="acct-meter' + (pct >= 100 ? ' is-full' : pct >= 80 ? ' is-high' : '') + '"><div class="acct-meter-top"><span>' + esc(opts.label || m.label) + '</span><span><b>' + fmt(u.used) + '</b> of ' + fmt(u.limit) + ' ' + esc(m.unit) + ' ' + Plans.PERIODS[m.period].this + '</span></div>' +
      '<div class="acct-bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + u.limit + '" aria-valuenow="' + u.used + '" aria-label="' + esc(m.label) + '"><span style="width:' + pct + '%"></span></div>' +
      '<div class="acct-meter-foot">Resets ' + esc(reset.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })) + (m.period === 'day' ? ' (midnight UTC)' : m.period === 'week' ? ' (Monday, 00:00 UTC)' : '') + '</div></div>';
  }
  // A one-line note for a page (e.g. AI Coding): sign in / what's left this month
  function noteHTML(meter, what) {
    if (!enabled() || !known()) return '';
    if (!signedIn()) return '<div class="acct-note">Sign in to use ' + esc(what) + ' — free accounts include ' + fmt(Plans.get('free').limits[Plans.METERS[meter].limit]) + ' ' + esc(Plans.METERS[meter].unit) + ' ' + Plans.PERIODS[Plans.METERS[meter].period].a + '. <button type="button" class="acct-linkbtn" data-acct="signin">Sign in</button></div>';
    const u = usageOf(meter);
    if (!u) return '';
    const left = Math.max(0, u.limit - u.used);
    return '<div class="acct-note' + (left === 0 ? ' is-full' : '') + '">' + esc(plan().name) + ' plan: <b>' + fmt(left) + '</b> of ' + fmt(u.limit) + ' ' + esc(Plans.METERS[meter].unit) + ' left ' + Plans.PERIODS[Plans.METERS[meter].period].this + '. ' +
      (plan().id !== 'ultra' ? '<button type="button" class="acct-linkbtn" data-acct="plans">More with ' + esc((Plans.ORDER.map(Plans.get).find(p => p.rank > Plans.get(plan().id).rank) || {}).name || '') + '</button>' : '') + '</div>';
  }
  function wireNotes() { /* the note buttons are handled by one listener on the page (below) */ }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-acct]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.acct === 'signin') openSignIn();
    else openPlans({ highlight: b.dataset.plan || undefined });
  });
  function remaining(meter) { const u = usageOf(meter); return u ? Math.max(0, u.limit - u.used) : Infinity; }

  /* ── The Account page (app.html#account) ───── */
  async function renderPage(container, param) {
    container.innerHTML = '<div class="loading-state">Loading your account…</div>';
    await ready;
    if (param === 'success' && signedIn()) {
      try { await postJson('/api/billing/sync'); } catch (e) { /* the webhook will catch up */ }
      await refresh();
      notify('Thanks! You\'re on the ' + plan().name + ' plan.', 'success', 6000);
      history.replaceState(null, '', '#account');
    } else if (!me) await refresh();
    await loadPrices();
    if (!enabled()) {
      container.innerHTML = '<div class="acct-page"><div class="card"><div class="card-title">Accounts</div><p>Accounts aren\'t turned on for this MetaCode server, so there are no plans or limits: everything is available and your work is kept in this browser. (The server administrator turns accounts on with SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.)</p></div></div>';
      return;
    }
    if (!signedIn()) {
      container.innerHTML = '<div class="acct-page"><div class="card acct-hero"><div><div class="card-title">Your MetaCode account</div><p>Sign in to save your projects and surveys to your account, use AI coding, and choose a plan.</p></div>' +
        '<div class="acct-hero-actions"><button type="button" class="acct-primary" data-a="signin">Sign in</button><button type="button" class="acct-secondary" data-a="signup">Create a free account</button></div></div>' +
        '<h3 class="acct-h">Plans</h3>' + plansHTML() + '</div>';
      container.querySelector('[data-a=signin]').onclick = () => openSignIn();
      container.querySelector('[data-a=signup]').onclick = () => openSignIn({ mode: 'signup' });
      wirePlans(container);
      return;
    }
    const p = me.plan;
    const status = p.source === 'override' ? 'Set by this site\'s administrators'
      : p.status === 'past_due' ? 'Payment overdue — update your card in Manage subscription'
      : p.status === 'trialing' ? 'Trial' + (p.renewsAt ? ' until ' + new Date(p.renewsAt).toLocaleDateString() : '')
      : p.cancelAtPeriodEnd && p.renewsAt ? 'Ends on ' + new Date(p.renewsAt).toLocaleDateString()
      : p.renewsAt ? 'Renews on ' + new Date(p.renewsAt).toLocaleDateString() : (p.id === 'free' ? 'No subscription' : '');
    const sync = root.CloudSync ? root.CloudSync.status() : null;
    container.innerHTML = '<div class="acct-page">' +
      '<div class="acct-grid">' +
        '<div class="card"><div class="card-title">Account</div><div class="acct-who"><span class="acct-avatar big" aria-hidden="true">' + esc(initials(me.user.email)) + '</span><div><b>' + esc(me.user.email) + '</b><div class="text-muted">Signed in</div></div></div>' +
          '<div class="acct-row"><button type="button" class="acct-secondary" data-a="password">Change password</button><button type="button" class="acct-secondary" data-a="out">Sign out</button></div></div>' +
        '<div class="card"><div class="card-title">Plan</div><div class="acct-planline"><span class="acct-plan-badge big plan-' + esc(p.id) + '">' + esc(p.name) + '</span><span class="text-muted">' + esc(status) + '</span></div>' +
          (p.billingUnavailable ? '<p class="acct-warn">MetaCode couldn\'t check your subscription with Stripe just now; it will try again shortly.</p>' : '') +
          '<div class="acct-row">' + (me.billing && me.billing.canManage ? '<button type="button" class="acct-primary" data-a="manage">Manage subscription</button>' : '') +
          (me.billing && me.billing.enabled ? '<button type="button" class="acct-secondary" data-a="refresh" title="Check Stripe for changes now">Refresh</button>' : '') + '</div></div>' +
        '<div class="card"><div class="card-title">Your data</div><div id="acct-sync">' + (sync ? syncHTML(sync) : '<p class="text-muted">Saved in this browser.</p>') + '</div></div>' +
      '</div>' +
      (can('desktop') ? '<div class="card acct-desktop"><div class="card-title">MetaCode Sheets</div><p>Your plan includes the desktop spreadsheet for Windows, macOS and Linux. Install it, then sign in with this account.</p>' +
        '<div class="acct-row"><a class="acct-primary" href="/download">Download MetaCode Sheets</a></div></div>' : '') +
      '<div class="card"><div class="card-title">Usage</div><div class="acct-meters">' + Object.keys(Plans.METERS).filter(k => !Plans.METERS[k].feature || can(Plans.METERS[k].feature)).map(k => meterHTML(k)).join('') + '</div>' +
        '<p class="acct-fine">Only work that succeeds is counted: AI answers that fail and scrapes that collect less than their limit are given back.</p></div>' +
      '<h3 class="acct-h">Plans</h3>' + plansHTML() + '</div>';
    const on = (a, fn) => { const b = container.querySelector('[data-a=' + a + ']'); if (b) b.onclick = () => fn(b); };
    on('out', () => signOut());
    on('password', () => openNewPassword());
    on('manage', b => manageBilling(b));
    on('refresh', async b => { b.disabled = true; try { await postJson('/api/billing/sync'); await refresh(); renderPage(container); } catch (e) { b.disabled = false; notify(e.message, 'error'); } });
    wirePlans(container);
    wireSync(container);
  }
  function syncHTML(s) {
    const when = s.lastSync ? new Date(s.lastSync).toLocaleTimeString() : null;
    const text = s.state === 'syncing' ? 'Saving to your account…'
      : s.state === 'error' ? 'Couldn\'t reach your account storage: ' + esc(s.error || 'unknown error') + '. Your work is safe in this browser and will be saved when it can.'
      : s.state === 'offline' ? 'Offline — changes are kept in this browser and saved when you\'re back online.'
      : s.state === 'idle' ? 'Saved to your account' + (when ? ' (last synced ' + esc(when) + ')' : '') + '.' : 'Saved in this browser.';
    return '<p class="acct-sync acct-sync-' + esc(s.state) + '">' + text + (s.pending ? ' <span class="text-muted">' + s.pending + ' change' + (s.pending === 1 ? '' : 's') + ' waiting.</span>' : '') +
      (s.tooLarge ? ' <span class="text-muted">' + s.tooLarge + ' item' + (s.tooLarge === 1 ? ' is' : 's are') + ' too large for your account storage and kept in this browser only.</span>' : '') + '</p>' +
      '<div class="acct-row"><button type="button" class="acct-secondary" data-a="syncnow">Sync now</button></div>';
  }
  function wireSync(container) {
    const b = container.querySelector('[data-a=syncnow]');
    if (b) b.onclick = async () => { b.disabled = true; await root.CloudSync.syncNow(); const box = container.querySelector('#acct-sync'); if (box) { box.innerHTML = syncHTML(root.CloudSync.status()); wireSync(container); } };
  }

  function onChange(fn) { listeners.push(fn); }
  function off(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }

  // Back to this tab (e.g. after checkout in another one): the plan may have changed
  let lastVisible = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !enabled()) return;
    if (Date.now() - lastVisible > 15000) refresh();
    lastVisible = Date.now();
  });

  const Account = {
    ready, init, refresh, enabled, signedIn, plan, can, me: () => me, client: () => client, session: () => session,
    require: requireFeature, openSignIn, openPlans, signOut, manageBilling, handleApiError,
    gate, gateHTML, wireGate, meterHTML, noteHTML, wireNotes, remaining, renderPage, onChange, off,
    mountChip(el) { el.setAttribute('data-account-chip', ''); renderChip(el); },
    GATED
  };
  root.Account = Account;
  document.addEventListener('click', e => { if (!e.target.closest || !e.target.closest('.acct-menu, [data-account-chip]')) { const m = document.querySelector('.acct-menu'); if (m) m.remove(); } });
  init();
})(window);
