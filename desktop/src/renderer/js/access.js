// @ts-check
// ── Signing in, and what's shown when the app can't be used ───────────────────
// Every screen here comes from the main process's state (entitlement.js),
// which only the MetaCode server can turn into "active".
import { h, icon } from './util.js';
import { errText } from './ui.js';

const sheets = /** @type {any} */ (window).sheets;

/** @param {string} title @param {string} [sub] */
const brand = (title, sub) => h('div.brand', null, h('img', { src: 'img/mark.png', alt: '' }), h('div', null, h('b', null, title), sub ? h('small', null, sub) : null));
/** @param {string} server */
const serverLine = server => h('div.server-line', null, 'MetaCode server: ' + server.replace(/^https?:\/\//, ''));

/**
 * Draws the screen for a state into the #access element.
 * @param {HTMLElement} root @param {any} state @param {{ info: any, onRecheck: () => void }} o
 */
export function renderAccess(root, state, o) {
  root.innerHTML = '';
  const s = state.status;
  if (s === 'starting' || s === 'checking') {
    root.append(h('div.access-card', null, brand('MetaCode Sheets'), h('div.row', null, h('div.spinner'), h('span.muted', null, 'Checking your MetaCode subscription…'))));
    return;
  }
  if (s === 'signed-out') return signIn(root, state, o);
  const card = h('div.access-card', { class: s === 'plan-required' ? 'wide' : undefined });
  root.append(card);
  card.append(brand('MetaCode Sheets', state.user && state.user.email ? 'Signed in as ' + state.user.email : undefined));
  const signOut = h('button.linkish', { onclick: async () => { try { await sheets.signOut(); } catch (e) { /* state event follows */ } } }, 'Sign out');
  const recheck = (/** @type {string} */ label) => h('button.btn.primary', { onclick: async (/** @type {any} */ ev) => { ev.target.disabled = true; ev.target.textContent = 'Checking…'; try { await sheets.recheck(); } finally { o.onRecheck(); } } }, label);

  if (s === 'plan-required') {
    card.append(
      h('h1', null, 'MetaCode Sheets comes with Pro, Max and Ultra'),
      h('p', null, (state.plan && state.plan.name ? 'Your account is on the ' + state.plan.name + ' plan. ' : '') + 'Upgrade to use the desktop spreadsheet — with MetaCode\'s AI tools, AI Coding and reliability analysis built in.'),
      h('div.plans', null, ...(state.plansWithDesktop || ['Pro', 'Max', 'Ultra']).map((/** @type {string} */ p) => h('div.plan', null, h('b', null, p), h('span', null, 'Includes MetaCode Sheets')))),
      h('div.row', null,
        h('button.btn.primary', { onclick: () => sheets.openExternal({ target: 'upgrade' }) }, 'See plans and upgrade'),
        recheck('I\'ve upgraded — check again'),
        h('span.spacer'), signOut),
      h('p.small.muted', null, 'The upgrade page opens in your browser. Your subscription is managed on the MetaCode website.')
    );
  } else if (s === 'unavailable') {
    card.append(h('h1', null, 'The desktop app isn\'t available here'), h('p', null, state.message || 'This MetaCode server has the desktop app turned off.'), h('div.row', null, recheck('Check again'), h('span.spacer'), signOut));
  } else if (s === 'update-required') {
    card.append(h('h1', null, 'Update MetaCode Sheets'), h('p', null, state.message),
      h('div.row', null, state.downloadUrl ? h('button.btn.primary', { onclick: () => sheets.openExternal({ target: 'download' }) }, 'Download the new version') : null, recheck('Check again'), h('span.spacer'), signOut));
  } else {
    // error: no connection and no valid offline access
    card.append(
      h('h1', null, 'Can\'t confirm your subscription'),
      h('div.notice.warn', { html: icon('offline') }, h('span', null, state.message || 'MetaCode can\'t be reached.')),
      h('p', null, 'Your workbooks are safe on this computer; unsaved changes were kept. Once MetaCode confirms your plan, everything is back where you left it.'),
      h('div.row', null, recheck('Try again'), h('span.spacer'), signOut)
    );
  }
  card.append(serverLine(state.server || ''));
}

/** @param {HTMLElement} root @param {any} state @param {{ info: any, onRecheck: () => void }} o */
function signIn(root, state, o) {
  const email = /** @type {HTMLInputElement} */ (h('input.input', { type: 'email', name: 'email', autocomplete: 'username', required: true, placeholder: 'you@university.edu', 'aria-label': 'Email' }));
  const password = /** @type {HTMLInputElement} */ (h('input.input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Password' }));
  const err = h('p.error-text', { role: 'alert' });
  if (state.message) err.textContent = state.message;
  const submit = /** @type {HTMLButtonElement} */ (h('button.btn.primary.block', { type: 'submit' }, 'Sign in'));
  const form = h('form', { novalidate: true },
    h('label.field', null, h('span', null, 'Email'), email),
    h('label.field', null, h('span', null, 'Password'), password),
    err, submit);
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) { err.textContent = 'Enter a valid email address.'; email.focus(); return; }
    if (!password.value) { err.textContent = 'Enter your password.'; password.focus(); return; }
    submit.disabled = true; submit.textContent = 'Signing in…';
    try {
      await sheets.signIn({ email: email.value.trim(), password: password.value });
      password.value = '';
    } catch (x) {
      err.textContent = errText(x);
      submit.disabled = false; submit.textContent = 'Sign in';
      password.focus(); password.select();
    }
  };
  const card = h('div.access-card', null,
    brand('MetaCode Sheets', 'The MetaCode desktop spreadsheet'),
    h('h1', null, 'Sign in'),
    h('p', null, 'Use your MetaCode account. MetaCode Sheets is included with the Pro, Max and Ultra plans.'),
    form);
  if (state.emailLink) {
    const linkBtn = h('button.btn.block', { type: 'button' }, 'Email me a sign-in link instead');
    linkBtn.onclick = async () => {
      err.textContent = '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) { err.textContent = 'Enter your email address first.'; email.focus(); return; }
      linkBtn.setAttribute('disabled', '');
      try {
        await sheets.sendSignInLink({ email: email.value.trim() });
        card.querySelector('form')?.replaceWith(h('div.notice', null, h('span', null, 'Check your inbox: a sign-in link is on its way to ' + email.value.trim() + '. Open it on this computer — it opens MetaCode Sheets and signs you in.')));
        linkBtn.remove();
      } catch (x) { err.textContent = errText(x); linkBtn.removeAttribute('disabled'); }
    };
    card.append(h('div.row', { class: 'wrap' }, linkBtn));
  }
  card.append(h('div.links', null,
    h('button.linkish', { type: 'button', onclick: () => sheets.openExternal({ target: 'reset' }) }, 'Forgot your password?'),
    h('button.linkish', { type: 'button', onclick: () => sheets.openExternal({ target: 'signup' }) }, 'Create an account')));
  if (o.info && !o.info.storage) card.append(h('p.small.muted', null, 'This computer has no system keychain the app can use, so you\'ll be asked to sign in each time you open it, and offline use isn\'t available.'));
  card.append(serverLine(state.server || ''));
  root.append(card);
  setTimeout(() => email.focus(), 30);
}
