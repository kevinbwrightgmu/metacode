// @ts-check
// ── Menus, dialogs and messages ───────────────────────────────────────────────
import { h, icon, keyText } from './util.js';

/** @type {HTMLElement | null} */
let openMenu = null;
/** @type {(() => void) | null} */
let menuCleanup = null;

export function closeMenu() {
  if (menuCleanup) menuCleanup();
  menuCleanup = null;
  if (openMenu) openMenu.remove();
  openMenu = null;
}

/**
 * @typedef {{ label: string, run?: () => void, key?: string, icon?: string, disabled?: boolean, danger?: boolean, sub?: MenuItem[] } | '-' | { heading: string } | { element: HTMLElement }} MenuItem
 * @param {MenuItem[]} items @param {{ x: number, y: number }} at @param {{ onClose?: () => void }} [o]
 */
export function showMenu(items, at, o = {}) {
  closeMenu();
  const prevFocus = /** @type {HTMLElement | null} */ (document.activeElement);
  const menu = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div.menu-sep', { role: 'separator' })); continue; }
    if ('heading' in it) { menu.append(h('div.menu-label', null, it.heading)); continue; }
    if ('element' in it) { menu.append(it.element); continue; }
    const b = h('button.menu-item', { role: 'menuitem', disabled: it.disabled, class: it.danger ? 'danger' : undefined, html: (it.icon ? icon(it.icon) : '') });
    b.append(h('span', null, it.label + (it.sub ? ' ›' : '')));
    if (it.key) b.append(h('span.key', null, keyText(it.key)));
    b.onclick = (e) => {
      e.stopPropagation();
      if (it.sub) { const r = b.getBoundingClientRect(); const subItems = it.sub; showMenu(subItems, { x: r.right - 4, y: r.top - 5 }, o); return; }
      closeMenu();
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
      if (it.run) it.run();
    };
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const x = Math.max(4, Math.min(at.x, window.innerWidth - r.width - 6));
  const y = Math.max(4, at.y + r.height > window.innerHeight - 6 ? Math.max(4, window.innerHeight - r.height - 6) : at.y);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  openMenu = menu;
  const first = /** @type {HTMLElement | null} */ (menu.querySelector('.menu-item:not(:disabled)'));
  if (first) first.focus();
  const onDown = (/** @type {MouseEvent} */ e) => { if (!menu.contains(/** @type {Node} */ (e.target))) { closeMenu(); if (o.onClose) o.onClose(); } };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    const btns = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('.menu-item:not(:disabled)')));
    const i = btns.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); if (prevFocus && prevFocus.isConnected) prevFocus.focus(); if (o.onClose) o.onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (btns[(i + 1) % btns.length] || btns[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[(i - 1 + btns.length) % btns.length] || btns[0]).focus(); }
  };
  setTimeout(() => { document.addEventListener('mousedown', onDown, true); document.addEventListener('keydown', onKey, true); }, 0);
  window.addEventListener('blur', closeMenu, { once: true });
  menuCleanup = () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  return menu;
}

/**
 * A modal dialog. Resolves with what `done(value)` is called with (null when closed).
 * @param {{ title: string, body: HTMLElement | HTMLElement[], buttons?: { label: string, kind?: string, value?: any, run?: (done: (v: any) => void) => void, disabled?: boolean, id?: string }[], wide?: boolean, onOpen?: (el: HTMLElement, done: (v: any) => void) => void, initialFocus?: string }} o
 * @returns {Promise<any>}
 */
export function dialog(o) {
  return new Promise(resolve => {
    const prevFocus = /** @type {HTMLElement | null} */ (document.activeElement);
    const box = h('div.dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title, class: o.wide ? 'wide' : undefined });
    const back = h('div.backdrop', null, box);
    let closed = false;
    const done = (/** @type {any} */ v) => {
      if (closed) return;
      closed = true;
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
      resolve(v === undefined ? null : v);
    };
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = /** @type {HTMLButtonElement | null} */ (box.querySelector('footer .btn.primary:not(:disabled), footer .btn.ai:not(:disabled), footer .btn.danger-bg:not(:disabled)'));
        if (primary) { e.preventDefault(); e.stopPropagation(); primary.click(); }
      }
      if (e.key === 'Tab') {
        const f = /** @type {HTMLElement[]} */ (Array.from(box.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(x => !(/** @type {any} */ (x).disabled) && /** @type {HTMLElement} */ (x).offsetParent !== null));
        if (!f.length) return;
        const i = f.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    const closeBtn = h('button.btn.ghost.small.x', { 'aria-label': 'Close', html: icon('x'), onclick: () => done(null) });
    box.append(h('header', null, h('h2', null, o.title), closeBtn));
    const body = h('div.body');
    body.append(...(Array.isArray(o.body) ? o.body : [o.body]));
    box.append(body);
    if (o.buttons && o.buttons.length) {
      const foot = h('footer');
      for (const b of o.buttons) {
        const btn = h('button.btn' + (b.kind ? '.' + b.kind : ''), { disabled: b.disabled, id: b.id }, b.label);
        btn.onclick = () => { if (b.run) b.run(done); else done(b.value === undefined ? b.label : b.value); };
        foot.append(btn);
      }
      box.append(foot);
    }
    document.getElementById('overlays')?.append(back);
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', e => { if (e.target === back) done(null); });
    if (o.onOpen) o.onOpen(box, done);
    const focus = /** @type {HTMLElement | null} */ (o.initialFocus ? box.querySelector(o.initialFocus) : box.querySelector('input, select, textarea, footer .btn.primary, footer .btn'));
    setTimeout(() => { if (focus) { focus.focus(); if (focus instanceof HTMLInputElement) focus.select(); } }, 20);
  });
}

/** Resolves with 'ok', 'extra' or null @param {string} title @param {string} message @param {{ ok?: string, cancel?: string, danger?: boolean, extra?: string }} [o] */
export function confirm(title, message, o = {}) {
  /** @type {{ label: string, value: any, kind?: string }[]} */
  const buttons = [{ label: o.cancel || 'Cancel', value: null }];
  if (o.extra) buttons.push({ label: o.extra, value: 'extra' });
  buttons.push({ label: o.ok || 'OK', kind: o.danger ? 'danger-bg' : 'primary', value: 'ok' });
  return dialog({ title, body: h('p.muted', null, message), buttons });
}

/** @param {string} title @param {string} label @param {string} value @param {{ ok?: string, hint?: string, validate?: (v: string) => string | null }} [o] */
export function prompt(title, label, value, o = {}) {
  const input = /** @type {HTMLInputElement} */ (h('input.input', { value, 'aria-label': label }));
  const err = h('p.error-text');
  return dialog({
    title,
    body: [h('label.field', null, h('span', null, label), input, o.hint ? h('small', null, o.hint) : null), err],
    buttons: [{ label: 'Cancel', value: null }, { label: o.ok || 'OK', kind: 'primary', run: done => { const v = input.value.trim(); const problem = o.validate ? o.validate(v) : (v ? null : 'Enter a value.'); if (problem) { err.textContent = problem; input.focus(); return; } done(v); } }]
  });
}

/** A short message in the corner @param {string} message @param {{ kind?: 'ok' | 'error' | 'info', action?: { label: string, run: () => void }, ms?: number }} [o] */
export function toast(message, o = {}) {
  const t = h('div.toast', { class: o.kind && o.kind !== 'info' ? o.kind : undefined }, h('span', null, message));
  if (o.action) { const a = o.action; t.append(h('button', { onclick: () => { t.remove(); a.run(); } }, a.label)); }
  document.getElementById('toasts')?.append(t);
  setTimeout(() => t.remove(), o.ms || (o.kind === 'error' ? 8000 : 4000));
}

/** @param {any} e */
export const errText = e => (e && e.message ? String(e.message) : 'Something went wrong.');

export const PALETTE = ['#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF',
  '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#0000FF', '#9900FF', '#FF00FF',
  '#E6B8AF', '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#C9DAF8', '#CFE2F3', '#D9D2E9', '#EAD1DC',
  '#DD7E6B', '#EA9999', '#F9CB9C', '#FFE599', '#B6D7A8', '#A2C4C9', '#A4C2F4', '#9FC5E8', '#B4A7D6', '#D5A6BD',
  '#CC4125', '#E06666', '#F6B26B', '#FFD966', '#93C47D', '#76A5AF', '#6D9EEB', '#6FA8DC', '#8E7CC3', '#C27BA0',
  '#2563EB', '#7C3AED', '#0D9488', '#10B981', '#F59E0B', '#EF4444', '#0F172A', '#475569', '#1E3A8A', '#4C1D95'];

/** A colour picker menu @param {{ x: number, y: number }} at @param {(color: string | null) => void} pick @param {string} noneLabel */
export function colorMenu(at, pick, noneLabel) {
  const grid = h('div.palette');
  for (const c of PALETTE) {
    const b = h('button', { title: c, 'aria-label': c });
    b.style.background = c;
    b.onclick = () => { closeMenu(); pick(c); };
    grid.append(b);
  }
  const custom = /** @type {HTMLInputElement} */ (h('input', { type: 'color', 'aria-label': 'Custom colour' }));
  custom.onchange = () => { closeMenu(); pick(custom.value.toUpperCase()); };
  showMenu([{ label: noneLabel, run: () => pick(null) }, '-', { element: grid }, { element: h('label.menu-item', null, 'Custom…', custom) }], at);
}
