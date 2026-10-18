// @ts-check
// ── Small helpers for the window: DOM, icons, text ────────────────────────────

/** @param {any} s */
export const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, ch => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/**
 * Creates an element: h('button.btn.primary', { onclick, title }, 'Text', child…)
 * @param {string} tag @param {Record<string, any> | null} [attrs] @param {...any} kids
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') /** @type {any} */ (el)[k] = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') /** @type {any} */ (el)[k] = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

/** @param {string} sel @param {ParentNode} [root] */
export const $ = (sel, root) => /** @type {HTMLElement} */ ((root || document).querySelector(sel));

/** @param {(...a: any[]) => void} fn @param {number} ms */
export function debounce(fn, ms) {
  /** @type {any} */
  let t = null;
  const d = (/** @type {any[]} */ ...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  d.flush = (/** @type {any[]} */ ...a) => { clearTimeout(t); fn(...a); };
  return d;
}

/** "3 min ago" @param {number} ms */
export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + ' s ago';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  const d = new Date(ms);
  if (s < 86400 && d.getDate() === new Date().getDate()) return 'today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (s < 7 * 86400) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}
/** @param {number} n */
export const bytes = n => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
/** @param {number} n */
export const num = n => (Number.isInteger(n) ? n.toLocaleString() : Number(n.toPrecision(10)).toLocaleString(undefined, { maximumFractionDigits: 6 }));

const P = (/** @type {string} */ d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
/** Icons (stroke, 24×24) */
export const ICONS = /** @type {Record<string, string>} */ ({
  home: P('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  x: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  sheet: P('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>'),
  open: P('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  import: P('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
  export: P('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 21h14"/>'),
  more: P('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  undo: P('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: P('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  bold: P('<path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z"/>'),
  italic: P('<path d="M14 5h-4M14 19h-4M14 5l-4 14"/>'),
  underline: P('<path d="M7 4v7a5 5 0 0010 0V4M5 20h14"/>'),
  strike: P('<path d="M5 12h14M16 6.5A4 3 0 008 7c0 3 8 2 8 6s-5.5 4-8 1.5"/>'),
  textColor: P('<path d="M6 17L11 5h2l5 12M8.2 12h7.6"/>'),
  fill: P('<path d="M5 12l7-7 7 7-7 7z"/><path d="M19 15s2 2.3 2 3.5a2 2 0 01-4 0c0-1.2 2-3.5 2-3.5z"/>'),
  border: P('<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16" stroke-dasharray="2 2"/>'),
  alignLeft: P('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
  alignCenter: P('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
  alignRight: P('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
  wrap: P('<path d="M4 6h16M4 12h13a3 3 0 010 6h-4M4 18h5"/><path d="M15 16l-2 2 2 2"/>'),
  filter: P('<path d="M4 5h16l-6 7v6l-4 2v-8z"/>'),
  sortAsc: P('<path d="M7 4v16M3 8l4-4 4 4M14 6h3M14 12h5M14 18h7"/>'),
  sortDesc: P('<path d="M7 4v16M3 16l4 4 4-4M14 6h7M14 12h5M14 18h3"/>'),
  freeze: P('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9h16M9 4v16"/>'),
  sigma: P('<path d="M17 5H7l6 7-6 7h10"/>'),
  sparkles: P('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>'),
  sidebar: P('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  search: P('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  user: P('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>'),
  cloud: P('<path d="M7 18a5 5 0 01-.5-10A6 6 0 0118 9a4.5 4.5 0 01-1 9z"/>'),
  folder: P('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
  project: P('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/>'),
  scraper: P('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16"/>'),
  check: P('<path d="M5 12l5 5L20 7"/>'),
  chart: P('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  percent: P('<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/>'),
  dollar: P('<path d="M12 3v18M16.5 7.5c-1-1.5-2.7-2-4.5-2-2.5 0-4 1.3-4 3s1.5 2.6 4 3c2.6.4 4.5 1.3 4.5 3.3S14.5 18.5 12 18.5c-2 0-3.8-.7-4.8-2.3"/>'),
  decUp: P('<path d="M4 17h.01M8 14a2 2 0 104 0v-4a2 2 0 10-4 0zM15 14a2 2 0 104 0v-4a2 2 0 10-4 0z"/><path d="M18 20l2-2-2-2"/>'),
  decDown: P('<path d="M4 17h.01M9 14a2 2 0 104 0v-4a2 2 0 10-4 0z"/><path d="M18 20l-2-2 2-2M16 18h5"/>'),
  key: P('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>'),
  warning: P('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>'),
  offline: P('<path d="M3 3l18 18M8.5 8.6A6 6 0 0118 9a4.5 4.5 0 012.6 7.9M17 18H7a5 5 0 01-1.6-9.7"/>'),
  people: P('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2A5 5 0 0121.5 19"/>')
});
/** @param {string} name */
export const icon = name => ICONS[name] || '';
/** An element holding an icon @param {string} name */
export function iconEl(name) { const s = document.createElement('span'); s.innerHTML = icon(name); return /** @type {Element} */ (s.firstElementChild); }

/** Platform-correct shortcut text: "Ctrl+S" / "⌘S" @param {string} accel */
export function keyText(accel) {
  const mac = /** @type {any} */ (window).sheets && /** @type {any} */ (window).sheets.platform === 'darwin';
  if (!mac) return accel.replace(/CmdOrCtrl/g, 'Ctrl');
  return accel.replace(/CmdOrCtrl\+?/g, '⌘').replace(/Shift\+?/g, '⇧').replace(/Alt\+?/g, '⌥').replace(/Ctrl\+?/g, '⌃');
}
