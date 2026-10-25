// @ts-check
// ── Dialogs and panels ────────────────────────────────────────────────────────
import * as E from '../../shared/engine/index.js';
import { h, icon, keyText, esc } from './util.js';
import { dialog, toast, errText, closeMenu, colorMenu } from './ui.js';
import { FUNCTION_HELP } from './functions-help.js';

const { ops } = E;
const sheets = /** @type {any} */ (window).sheets;

/** @typedef {import('./workspace.js').Workspace} Workspace */

/* ── Find and replace ──────────────────────────── */

/** @param {Workspace} ws @param {boolean} replace */
export function findPanel(ws, replace) {
  const existing = /** @type {HTMLElement | null} */ (ws.gridHost.querySelector('.floating.find'));
  if (existing) existing.remove();
  const q = /** @type {HTMLInputElement} */ (h('input.input', { placeholder: 'Find', 'aria-label': 'Find' }));
  const rep = /** @type {HTMLInputElement} */ (h('input.input', { placeholder: 'Replace with', 'aria-label': 'Replace with' }));
  const opt = (/** @type {string} */ label) => { const c = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' })); return { el: h('label.check.small', null, c, label), c }; };
  const mc = opt('Match case'), whole = opt('Whole cell'), inF = opt('Search formulas'), all = opt('All sheets'), rx = opt('Regular expression');
  const info = h('span.small.muted', { 'aria-live': 'polite' });
  /** @type {{ sheet: any, r: number, c: number }[]} */
  let hits = [];
  let idx = -1;
  const options = () => ({ query: q.value, matchCase: mc.c.checked, wholeCell: whole.c.checked, inFormulas: inF.c.checked, allSheets: all.c.checked, regex: rx.c.checked });
  const search = () => {
    hits = q.value ? ops.findAll(ws.wb, ws.sheet, options()) : [];
    idx = -1;
    highlight();
    info.textContent = q.value ? (hits.length ? hits.length + ' match' + (hits.length === 1 ? '' : 'es') : 'No matches') : '';
  };
  const highlight = () => { ws.grid.highlights = new Set(hits.filter(x => x.sheet === ws.sheet).map(x => E.keyOf(x.r, x.c))); ws.grid.invalidate(); };
  const go = (/** @type {number} */ dir) => {
    if (!hits.length) { search(); if (!hits.length) return; }
    idx = (idx + dir + hits.length) % hits.length;
    const x = hits[idx];
    if (x.sheet !== ws.sheet) { ws.activateSheet(x.sheet.id); highlight(); }
    ws.grid.ensureExtent(x.r, x.c);
    ws.grid.setSelection([{ r1: x.r, c1: x.c, r2: x.r, c2: x.c }], { r: x.r, c: x.c });
    info.textContent = (idx + 1) + ' of ' + hits.length;
  };
  const replaceOne = () => {
    if (idx < 0 || !hits[idx]) { go(1); return; }
    const r = ops.replaceAll(ws.wb, ws.sheet, options(), rep.value, [hits[idx]]);
    r.steps.forEach((/** @type {any} */ s) => ws.exec(s));
    search(); go(1);
  };
  const replaceAll = () => {
    const r = ops.replaceAll(ws.wb, ws.sheet, options(), rep.value);
    r.steps.forEach((/** @type {any} */ s) => ws.exec(s));
    toast(r.count ? 'Replaced ' + r.count + ' cell' + (r.count === 1 ? '' : 's') + '.' : 'Nothing to replace.');
    search();
  };
  const close = () => { panel.remove(); ws.grid.highlights = new Set(); ws.grid.invalidate(); ws.grid.focus(); };
  const panel = h('div.floating.find', { role: 'dialog', 'aria-label': replace ? 'Find and replace' : 'Find' },
    h('h3', null, replace ? 'Find and replace' : 'Find', h('span.spacer'), h('button.btn.ghost.small', { 'aria-label': 'Close', html: icon('x'), onclick: close })),
    h('div.field', null, q), replace ? h('div.field', null, rep) : null,
    h('div.row.wrap', null, mc.el, whole.el, inF.el, all.el, rx.el),
    h('div.row', null, info, h('span.spacer'),
      h('button.btn.small', { onclick: () => go(-1) }, 'Previous'), h('button.btn.small.primary', { onclick: () => go(1) }, 'Next')),
    replace ? h('div.row.end', null, h('button.btn.small', { onclick: replaceOne }, 'Replace'), h('button.btn.small', { onclick: replaceAll }, 'Replace all')) : null);
  q.addEventListener('input', search);
  [mc, whole, inF, all, rx].forEach(o => o.c.addEventListener('change', search));
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && e.target === q) { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
    if (e.key === 'Enter' && e.target === rep) { e.preventDefault(); replaceOne(); }
  });
  ws.gridHost.append(panel);
  const a = ws.sel.active;
  const cur = ws.wb.valueAt(ws.sheet, a.r, a.c);
  if (typeof cur === 'string' && cur.length < 100) q.value = cur;
  q.focus(); q.select();
  if (q.value) search();
}

/* ── Filter ────────────────────────────────────── */

/** @param {Workspace} ws @param {number} col @param {{ x: number, y: number }} at */
export function filterPopup(ws, col, at) {
  closeMenu();
  document.querySelectorAll('.filter-pop').forEach(x => x.remove());
  const f = ws.sheet.filter;
  if (!f) return;
  const last = Math.min(f.range.r2, ws.sheet.bounds().maxRow);
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (let r = f.range.r1 + 1; r <= last; r++) {
    const t = ops.filterText(ws.wb, ws.sheet.get(r, col));
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const values = Array.from(counts.keys()).sort((x, y) => (x === '' ? 1 : y === '' ? -1 : x.localeCompare(y, undefined, { numeric: true })));
  const cond = f.conditions[col];
  const chosen = new Set(cond && cond.type === 'values' ? cond.values : values);
  const search = /** @type {HTMLInputElement} */ (h('input.input', { placeholder: 'Search values', 'aria-label': 'Search values' }));
  const list = h('div.filter-values', { role: 'group', 'aria-label': 'Values' });
  const draw = () => {
    list.innerHTML = '';
    const term = search.value.toLowerCase();
    const shown = values.filter(v => !term || v.toLowerCase().includes(term)).slice(0, 1000);
    for (const v of shown) {
      const c = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: chosen.has(v) }));
      c.onchange = () => { if (c.checked) chosen.add(v); else chosen.delete(v); };
      list.append(h('label.check.small', null, c, (v === '' ? '(Blanks)' : v) + '  ', h('span.muted', null, '(' + counts.get(v) + ')')));
    }
    if (values.length > 1000) list.append(h('p.small.muted', null, 'Showing the first 1,000 values — search to find others.'));
  };
  search.oninput = draw;
  const op = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Condition' },
    ...[['', 'No condition'], ['contains', 'Text contains'], ['notcontains', 'Text doesn\'t contain'], ['=', 'Is equal to'], ['<>', 'Isn\'t equal to'], ['>', 'Greater than'], ['>=', 'Greater than or equal'], ['<', 'Less than'], ['<=', 'Less than or equal'], ['blank', 'Is empty'], ['notblank', 'Isn\'t empty']]
      .map(([v, t]) => h('option', { value: v, selected: cond && cond.type === 'condition' && cond.op === v }, t))));
  const val = /** @type {HTMLInputElement} */ (h('input.input', { placeholder: 'Value', 'aria-label': 'Condition value', value: cond && cond.type === 'condition' ? String(cond.value === undefined ? '' : cond.value) : '' }));
  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); ws.grid.focus(); };
  const apply = () => {
    let c = null;
    if (op.value) c = { type: 'condition', op: op.value, value: ['blank', 'notblank'].includes(op.value) ? undefined : val.value };
    else if (chosen.size !== values.length) c = { type: 'values', values: Array.from(chosen) };
    ws.exec(ops.setFilterCondition(ws.wb, ws.sheet, col, c));
    close();
  };
  const sortBy = (/** @type {boolean} */ desc) => {
    const g = { r1: f.range.r1, c1: f.range.c1, r2: Math.max(f.range.r2, ws.sheet.bounds().maxRow), c2: f.range.c2 };
    ws.exec(ops.sortRange(ws.wb, ws.sheet, g, [{ col, desc }], true));
    ops.applyFilter(ws.wb, ws.sheet);
    close();
  };
  const pop = h('div.floating.filter-pop', { role: 'dialog', 'aria-label': 'Filter column ' + E.colName(col) },
    h('h3', null, 'Filter ' + E.colName(col)),
    h('div.row', null, h('button.btn.small', { onclick: () => sortBy(false), html: icon('sortAsc') + 'A → Z' }), h('button.btn.small', { onclick: () => sortBy(true), html: icon('sortDesc') + 'Z → A' })),
    h('div.side-section', null, h('label.field', null, h('span', null, 'By condition'), op, val)),
    h('div.side-section', null, h('span.small.muted', null, 'By values'), search,
      h('div.row', null, h('button.linkish.small', { onclick: () => { values.forEach(v => chosen.add(v)); draw(); } }, 'Select all'), h('button.linkish.small', { onclick: () => { chosen.clear(); draw(); } }, 'Clear')), list),
    h('div.row.end', null, h('button.btn.small', { onclick: () => { ws.exec(ops.setFilterCondition(ws.wb, ws.sheet, col, null)); close(); } }, 'Clear filter'), h('button.btn.small.primary', { onclick: apply }, 'Apply')));
  pop.style.position = 'fixed';
  pop.style.left = Math.max(8, Math.min(at.x - 140, window.innerWidth - 300)) + 'px';
  pop.style.top = Math.max(8, Math.min(at.y + 4, window.innerHeight - 480)) + 'px';
  pop.style.right = 'auto';
  document.body.append(pop);
  draw();
  const outside = (/** @type {MouseEvent} */ e) => { if (!pop.contains(/** @type {Node} */ (e.target))) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  pop.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  search.focus();
}

/* ── Format cells ──────────────────────────────── */

/** @param {Workspace} ws @param {string} [tab] */
export async function formatCellsDialog(ws, tab) {
  const st = ws.activeStyle();
  const a = ws.sel.active;
  const sample = ws.wb.valueAt(ws.sheet, a.r, a.c);
  const code = /** @type {HTMLInputElement} */ (h('input.input', { value: st.numFmt || 'General', 'aria-label': 'Format code', spellcheck: 'false' }));
  const preview = h('div.fmt-preview', { 'aria-live': 'polite' });
  const showPreview = () => {
    try {
      const v = typeof sample === 'number' ? sample : sample === null ? 1234.5678 : sample;
      const out = E.formatValue(v, code.value || 'General');
      preview.textContent = out.text;
      preview.style.color = out.color || '';
    } catch (e) { preview.textContent = 'This format can\'t be read.'; }
  };
  code.oninput = showPreview;
  const presets = h('div.row.wrap', null, ...[['General', 'General'], ['1,234.57', '#,##0.00'], ['12.3%', '0.0%'], ['$1,234.57', '$#,##0.00'], ['2024-03-05', 'yyyy-mm-dd'], ['5 Mar 2024', 'd mmm yyyy'], ['14:30', 'hh:mm'], ['1.23E+03', '0.00E+00'], ['(1,234)', '#,##0;(#,##0)'], ['Text', '@']]
    .map(([label, c]) => h('button.btn.small', { onclick: () => { code.value = c; showPreview(); } }, label)));
  const hAlign = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Horizontal alignment' }, ...[['', 'Automatic'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']].map(([v, t]) => h('option', { value: v, selected: (st.h || '') === v }, t))));
  const vAlign = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Vertical alignment' }, ...[['', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']].map(([v, t]) => h('option', { value: v, selected: (st.v || '') === v }, t))));
  const wrap = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: !!st.wrap }));
  const indent = /** @type {HTMLInputElement} */ (h('input.input', { type: 'number', min: '0', max: '15', value: String(st.indent || 0), 'aria-label': 'Indent' }));
  const family = /** @type {HTMLInputElement} */ (h('input.input', { value: st.family || '', placeholder: 'Default', 'aria-label': 'Font' }));
  const size = /** @type {HTMLInputElement} */ (h('input.input', { type: 'number', min: '6', max: '96', value: String(st.size || 11), 'aria-label': 'Size' }));
  const checks = /** @type {Record<string, HTMLInputElement>} */ ({});
  for (const k of ['bold', 'italic', 'underline', 'strike']) checks[k] = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: !!st[k] }));
  let color = st.color || null, fill = st.fill || null;
  const swatch = (/** @type {() => string | null} */ get, /** @type {(c: string | null) => void} */ set, /** @type {string} */ none) => {
    const b = h('button.btn.small', { type: 'button' });
    const paint = () => { b.textContent = get() || none; b.style.borderLeft = '14px solid ' + (get() || 'transparent'); };
    b.onclick = () => { const r = b.getBoundingClientRect(); colorMenu({ x: r.left, y: r.bottom + 4 }, c => { set(c); paint(); }, none); };
    paint();
    return b;
  };
  let borderKind = '', borderStyle = 'thin', borderColor = '#000000';
  const borderBtns = h('div.row.wrap', null, ...[['all', 'All'], ['outer', 'Outside'], ['inner', 'Inside'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['none', 'None']].map(([k, t]) => {
    const b = h('button.btn.small', { type: 'button', 'aria-pressed': 'false' }, t);
    b.onclick = () => { borderKind = k; borderBtns.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); b.classList.add('primary'); borderBtns.querySelectorAll('button').forEach(x => { if (x !== b) x.classList.remove('primary'); }); };
    return b;
  }));
  const bStyle = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Line style' }, ...['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'].map(s => h('option', { value: s }, s[0].toUpperCase() + s.slice(1)))));
  bStyle.onchange = () => { borderStyle = bStyle.value; };
  const sections = {
    number: h('div', null, h('label.field', null, h('span', null, 'Format code'), code, h('small', null, 'Excel-style codes: 0.00 · #,##0 · 0% · yyyy-mm-dd · [Red]-0.00 · "text"')), presets, h('span.small.muted', null, 'Preview'), preview),
    alignment: h('div', null, h('label.field', null, h('span', null, 'Horizontal'), hAlign), h('label.field', null, h('span', null, 'Vertical'), vAlign), h('label.field', null, h('span', null, 'Indent'), indent), h('label.check', null, wrap, 'Wrap text')),
    font: h('div', null, h('label.field', null, h('span', null, 'Font'), family), h('label.field', null, h('span', null, 'Size (pt)'), size),
      h('div.row.wrap', null, h('label.check', null, checks.bold, 'Bold'), h('label.check', null, checks.italic, 'Italic'), h('label.check', null, checks.underline, 'Underline'), h('label.check', null, checks.strike, 'Strikethrough')),
      h('div.row', null, h('span.small', null, 'Text colour'), swatch(() => color, c => { color = c; }, 'Automatic'), h('span.small', null, 'Fill'), swatch(() => fill, c => { fill = c; }, 'No fill'))),
    border: h('div', null, borderBtns, h('div.row', null, h('label.field', null, h('span', null, 'Line'), bStyle), h('div.field', null, h('span', null, 'Colour'), swatch(() => borderColor, c => { borderColor = c || '#000000'; }, 'Black'))))
  };
  const tabs = h('div.side-tabs', { role: 'tablist' });
  const body = h('div');
  const show = (/** @type {string} */ name) => {
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
    body.replaceChildren(/** @type {any} */ (sections)[name]);
  };
  for (const [k, t] of [['number', 'Number'], ['alignment', 'Alignment'], ['font', 'Font'], ['border', 'Border']]) tabs.append(h('button.side-tab.data', { role: 'tab', dataset: { tab: k }, onclick: () => show(k) }, t));
  show(tab && /** @type {any} */ (sections)[tab] ? tab : 'number');
  showPreview();
  const ok = await dialog({ title: 'Format cells', wide: true, body: [tabs, body], buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', kind: 'primary', value: 'ok' }] });
  if (!ok) return;
  try { E.formatValue(1, code.value || 'General'); } catch (e) { toast('The format code can\'t be read, so it wasn\'t applied.', { kind: 'error' }); return; }
  const n = Math.round(Number(size.value));
  ws.styleSel({
    numFmt: !code.value || code.value === 'General' ? null : code.value.slice(0, 200),
    h: hAlign.value || null, v: vAlign.value || null, wrap: wrap.checked || null, indent: Math.max(0, Math.min(15, Math.round(Number(indent.value) || 0))) || null,
    family: family.value.trim().replace(/[^\w \-,'"]/g, '').slice(0, 80) || null, size: Number.isFinite(n) && n >= 6 && n <= 96 && n !== 11 ? n : null,
    bold: checks.bold.checked || null, italic: checks.italic.checked || null, underline: checks.underline.checked || null, strike: checks.strike.checked || null,
    color, fill
  });
  if (borderKind) ws.exec(ops.setBorders(ws.wb, ws.sheet, ws.ranges(), /** @type {any} */ (borderKind), { style: borderStyle, color: borderColor }));
}

/* ── Sort, duplicates ──────────────────────────── */

/** @param {Workspace} ws @param {any} g */
export async function sortDialog(ws, g) {
  const { looksLikeHeader } = await import('./commands.js');
  const header = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: looksLikeHeader(ws.wb, ws.sheet, g) }));
  const colLabel = (/** @type {number} */ c) => E.colName(c) + (header.checked ? ' — ' + String(E.formatValue(ws.wb.valueAt(ws.sheet, g.r1, c), undefined).text || '').slice(0, 30) : '');
  /** @type {{ col: HTMLSelectElement, order: HTMLSelectElement }[]} */
  const keys = [];
  const keyRows = h('div');
  const addKey = (/** @type {number} */ c) => {
    const col = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Sort by column' }));
    for (let x = g.c1; x <= g.c2; x++) col.append(h('option', { value: String(x), selected: x === c }, colLabel(x)));
    const order = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Order' }, h('option', { value: 'asc' }, 'A → Z (smallest first)'), h('option', { value: 'desc' }, 'Z → A (largest first)')));
    keys.push({ col, order });
    keyRows.append(h('div.row', null, h('span.small.muted', null, keys.length === 1 ? 'Sort by' : 'then by'), col, order));
  };
  addKey(Math.max(g.c1, Math.min(g.c2, ws.sel.active.c)));
  header.onchange = () => keys.forEach(k => Array.from(k.col.options).forEach(o => { o.textContent = colLabel(Number(o.value)); }));
  const ok = await dialog({
    title: 'Sort range ' + E.rangeA1(g), wide: true,
    body: [h('label.check', null, header, 'The first row is a header'), keyRows, h('button.btn.small', { onclick: () => { if (keys.length < 3) addKey(g.c1); } }, 'Add another sort column')],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Sort', kind: 'primary', value: 'ok' }]
  });
  if (!ok) return;
  ws.exec(ops.sortRange(ws.wb, ws.sheet, g, keys.map(k => ({ col: Number(k.col.value), desc: k.order.value === 'desc' })), header.checked));
  if (ws.sheet.filter) ops.applyFilter(ws.wb, ws.sheet);
}

/** @param {Workspace} ws @param {any} g */
export async function removeDuplicatesDialog(ws, g) {
  const { looksLikeHeader, removeDuplicates } = await import('./commands.js');
  const header = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: looksLikeHeader(ws.wb, ws.sheet, g) }));
  const boxes = [];
  const list = h('div.filter-values');
  for (let c = g.c1; c <= Math.min(g.c2, g.c1 + 200); c++) {
    const b = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: true, dataset: { col: String(c) } }));
    boxes.push(b);
    const head = ws.wb.valueAt(ws.sheet, g.r1, c);
    list.append(h('label.check.small', null, b, E.colName(c) + (head !== null && head !== '' ? ' — ' + String(head).slice(0, 40) : '')));
  }
  const ok = await dialog({
    title: 'Remove duplicate rows', body: [h('p.muted', null, 'In ' + E.rangeA1(g) + ', rows whose values in the chosen columns match an earlier row are removed (text is compared ignoring case and surrounding spaces). You can undo this.'), h('label.check', null, header, 'The first row is a header'), list],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Remove duplicates', kind: 'primary', value: 'ok' }]
  });
  if (!ok) return;
  const cols = boxes.filter(b => b.checked).map(b => Number(b.dataset.col));
  if (!cols.length) { toast('Choose at least one column to compare.', { kind: 'error' }); return; }
  const n = removeDuplicates(ws, g, cols, header.checked);
  toast(n ? 'Removed ' + n + ' duplicate row' + (n === 1 ? '' : 's') + '.' : 'No duplicate rows found.');
}

/* ── Functions ─────────────────────────────────── */

/** @param {Workspace} ws @param {boolean} insert */
export async function insertFunctionDialog(ws, insert) {
  const names = Object.keys(E.FUNCTIONS).sort();
  const cats = Array.from(new Set(names.map(n => (FUNCTION_HELP[n] ? FUNCTION_HELP[n][2] : 'Other')))).sort();
  const search = /** @type {HTMLInputElement} */ (h('input.input', { placeholder: 'Search functions', 'aria-label': 'Search functions' }));
  const cat = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'), ...cats.map(c => h('option', { value: c }, c))));
  const list = h('div.fn-list', { role: 'listbox', 'aria-label': 'Functions' });
  let chosen = '';
  const draw = () => {
    list.innerHTML = '';
    const t = search.value.trim().toUpperCase();
    for (const n of names) {
      const help = FUNCTION_HELP[n] || [E.FUNCTIONS[n].args || '', E.FUNCTIONS[n].summary || '', 'Other'];
      if (cat.value && help[2] !== cat.value) continue;
      if (t && !n.includes(t) && !help[1].toUpperCase().includes(t)) continue;
      const item = h('div.item', { role: 'option', 'aria-selected': n === chosen ? 'true' : 'false', tabindex: '-1' }, h('b', null, n + '(' + help[0] + ')'), h('div', null, help[1]));
      item.onclick = () => { chosen = n; list.querySelectorAll('.item').forEach(x => x.setAttribute('aria-selected', 'false')); item.setAttribute('aria-selected', 'true'); };
      item.ondblclick = () => { chosen = n; /** @type {HTMLElement | null} */ (document.querySelector('#fn-insert'))?.click(); };
      list.append(item);
    }
  };
  search.oninput = draw; cat.onchange = draw;
  draw();
  const r = await dialog({
    title: insert ? 'Insert a function' : 'Functions', wide: true,
    body: [h('div.row', null, search, cat), list, h('p.small.muted', null, names.length + ' functions. Functions marked "MetaCode" (reliability statistics) work in MetaCode Sheets; other spreadsheet apps show #NAME? for them.')],
    buttons: insert ? [{ label: 'Cancel', value: null }, { label: 'Insert', kind: 'primary', id: 'fn-insert', run: done => done(chosen || null) }] : [{ label: 'Close', value: null }]
  });
  if (!r || !insert) return;
  if (ws.grid.editing) {
    const ed = ws.grid.editor;
    const pos = ed.selectionStart;
    const ins = (ed.value ? '' : '=') + r + '(';
    ed.value = ed.value.slice(0, pos) + ins + ed.value.slice(ed.selectionEnd);
    ed.focus();
    ed.setSelectionRange(pos + ins.length, pos + ins.length);
  } else ws.grid.startEdit('=' + r + '(');
}

/* ── Settings, shortcuts, about ────────────────── */

/** @param {any} app */
export async function settingsDialog(app) {
  const s = await sheets.getSettings();
  const theme = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Theme' }, ...[['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => h('option', { value: v, selected: s.theme === v }, t))));
  const autosave = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: s.autosave !== false }));
  const model = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'AI model' }, h('option', { value: '' }, 'The server\'s default model')));
  const modelNote = h('small');
  if (app.state.status === 'active') {
    sheets.aiModels().then((/** @type {any} */ r) => {
      for (const m of r.models) model.append(h('option', { value: m.id, selected: m.id === s.aiModel }, m.name));
      // A saved model the list doesn't have (any more) stays selected rather than being reset on Save
      if (s.aiModel && !r.models.some((/** @type {any} */ m) => m.id === s.aiModel)) model.append(h('option', { value: s.aiModel, selected: true }, s.aiModel + ' (not in the list)'));
      if (r.note) modelNote.textContent = r.note;
    }).catch((/** @type {any} */ e) => { modelNote.textContent = errText(e); });
  } else modelNote.textContent = 'The model list needs a connection to MetaCode.';
  const info = app.info;
  const ok = await dialog({
    title: 'Settings',
    body: [
      h('label.field', null, h('span', null, 'Theme'), theme),
      h('label.check', null, autosave, 'AutoSave — save workbooks a few seconds after each change'),
      h('label.field', null, h('span', null, 'AI model for the AI tools'), model, modelNote),
      h('div.field', null, h('span', null, 'Library folder'), h('code.code', null, info.library), h('small', null, 'New workbooks are saved here. Workbooks you open from elsewhere stay where they are.')),
      h('div.field', null, h('span', null, 'Account'), h('span', null, (app.state.user && app.state.user.email) || '—', app.state.plan && app.state.plan.name ? ' · ' + app.state.plan.name : ''),
        h('small', null, info.storage ? 'Your session is kept in this computer\'s secure storage (' + (info.platform === 'darwin' ? 'Keychain' : info.platform === 'win32' ? 'Windows credential protection' : 'Secret Service') + ').' : 'This computer has no secure storage the app can use: you\'ll sign in at each start, and offline use is off.'))
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', value: 'ok' }]
  });
  if (!ok) return;
  await sheets.setSettings({ theme: theme.value, autosave: autosave.checked, aiModel: model.value });
  app.applySettings(await sheets.getSettings());
}

export function shortcutsDialog() {
  const rows = [
    ['Move', 'Arrow keys · Tab · Enter'], ['Jump to the edge of the data', 'CmdOrCtrl+Arrow'], ['Extend the selection', 'Shift+Arrow'], ['Select column / row', 'CmdOrCtrl+Space · Shift+Space'],
    ['Edit the cell', 'F2 (or start typing)'], ['New line in a cell', 'Alt+Enter'], ['Fill the selection with the entry', 'CmdOrCtrl+Enter'], ['Switch $ references', 'F4 (while editing)'],
    ['Undo / Redo', 'CmdOrCtrl+Z · CmdOrCtrl+Y'], ['Copy / Cut / Paste', 'CmdOrCtrl+C · X · V'], ['Paste values only', 'CmdOrCtrl+Shift+V'],
    ['Fill down / right', 'CmdOrCtrl+D · CmdOrCtrl+R'], ['Find / Replace', 'CmdOrCtrl+F · ' + (sheets.platform === 'darwin' ? '⌘⌥F' : 'Ctrl+H')],
    ['Bold / Italic / Underline', 'CmdOrCtrl+B · I · U'], ['Format cells', 'CmdOrCtrl+1'], ['Filter', 'CmdOrCtrl+Shift+F'],
    ['Insert function', 'Shift+F3'], ['Insert today\'s date', 'CmdOrCtrl+;'], ['New sheet', 'Shift+F11'], ['Next / previous sheet', 'CmdOrCtrl+PageDown · PageUp'],
    ['Save / Save as', 'CmdOrCtrl+S · CmdOrCtrl+Shift+S'], ['AI Assistant', 'CmdOrCtrl+Shift+A'], ['Zoom', 'CmdOrCtrl+= · CmdOrCtrl+- · CmdOrCtrl+0']
  ];
  return dialog({ title: 'Keyboard shortcuts', wide: true, body: h('div.shortcuts', null, ...rows.flatMap(([a, b]) => [h('span', null, a), h('span', null, h('kbd', null, keyText(b)))])), buttons: [{ label: 'Close', kind: 'primary', value: null }] });
}

/** @param {any} app */
export function aboutDialog(app) {
  const i = app.info;
  return dialog({
    title: 'About MetaCode Sheets',
    body: [
      h('div.brand', null, h('img', { src: 'img/mark.png', alt: '' }), h('div', null, h('b', null, 'MetaCode Sheets ' + i.version), h('small', null, 'The MetaCode desktop spreadsheet'))),
      h('div.kv', null, h('span', null, 'Server'), h('b', null, i.server), h('span', null, 'Electron'), h('b', null, i.electron), h('span', null, 'System'), h('b', null, i.platform + ' ' + i.arch),
        h('span', null, 'Offline access'), h('b', null, app.state.offlineUntil ? 'until ' + new Date(app.state.offlineUntil).toLocaleString() : 'not available'), h('span', null, 'Signed release keys'), h('b', null, i.pinned ? 'pinned in this build' : 'from the server (development build)')),
      h('p.small.muted', null, 'Workbooks are kept on this computer. Nothing in an imported file is run: formulas are calculated by MetaCode Sheets, and macros are ignored. AI tools send the cells you choose to MetaCode\'s AI service, and say so before they do.')
    ],
    buttons: [{ label: 'Close', kind: 'primary', value: null }]
  });
}

export { esc };
