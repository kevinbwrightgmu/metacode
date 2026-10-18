// @ts-check
// ── The workbook view ─────────────────────────────────────────────────────────
// Toolbar, formula bar, grid, MetaCode sidebar, sheet tabs and status bar for
// the open workbook. Every change goes through the engine's operations
// (shared/engine/ops.js) and is recorded for undo.
import * as E from '../../shared/engine/index.js';
import { Grid } from './grid.js';
import { h, icon, debounce, num, esc, keyText } from './util.js';
import { showMenu, colorMenu, toast, errText, prompt, confirm } from './ui.js';
import { FUNCTION_HELP, callAt } from './functions-help.js';
import { COMMANDS, KEYMAP, cellContextMenu, headerContextMenu, currentRegion } from './commands.js';
import { Sidebar } from './sidebar.js';
import { filterPopup } from './dialogs.js';

const { ops } = E;
const sheets = /** @type {any} */ (window).sheets;

const FONTS = ['Default', 'Arial', 'Calibri', 'Cambria', 'Courier New', 'Georgia', 'Helvetica', 'Inter', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];
export const NUMBER_FORMATS = [
  ['General', 'General'], ['Number', '#,##0.00'], ['Integer', '#,##0'], ['Percent', '0.00%'], ['Currency', '$#,##0.00'], ['Accounting', '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'],
  ['Date', 'yyyy-mm-dd'], ['Long date', 'mmmm d, yyyy'], ['Time', 'h:mm'], ['Date time', 'yyyy-mm-dd hh:mm'], ['Duration', '[h]:mm:ss'], ['Scientific', '0.00E+00'], ['Fraction', '# ?/?'], ['Text', '@']
];

export class Workspace {
  /** @param {HTMLElement} root @param {any} app */
  constructor(root, app) {
    this.root = root;
    this.app = app;
    /** @type {any} */
    this.doc = null;
    /** @type {{ clip: any, text: string } | null} */
    this.clip = null;
    this.settings = app.settings;
    // the parts of the view (made in build())
    const el = /** @type {HTMLElement} */ (/** @type {any} */ (null));
    this.toolbar = el; this.formulaBar = el; this.banner = el; this.gridHost = el; this.sidebarEl = el; this.content = el; this.sheetTabs = el; this.sheetBar = el; this.status = el;
    this.textSwatch = el; this.fillSwatch = el;
    this.nameBox = /** @type {HTMLInputElement} */ (/** @type {any} */ (null));
    this.formulaInput = this.nameBox;
    this.fmtSelect = /** @type {HTMLSelectElement} */ (/** @type {any} */ (null));
    this.fontSelect = this.fmtSelect; this.sizeSelect = this.fmtSelect;
    this.grid = /** @type {Grid} */ (/** @type {any} */ (null));
    this.sidebar = /** @type {Sidebar} */ (/** @type {any} */ (null));
    this.statusSoon = /** @type {any} */ (null);
    /** @type {(() => void) | null} */
    this.unsub = null;
    /** @type {any} */
    this.ac = null;
    /** @type {HTMLElement | null} */
    this.hint = null;
    this.build();
  }

  get wb() { return this.doc.wb; }
  get sheet() { return this.doc.wb.activeSheet; }
  get sel() { return this.grid.sel; }
  /** The selected ranges (clamped to the sheet) */
  ranges() { return this.sel.ranges.map((/** @type {any} */ g) => ({ r1: g.r1, c1: g.c1, r2: Math.min(g.r2, E.MAX_ROWS - 1), c2: Math.min(g.c2, E.MAX_COLS - 1) })); }
  /** The single selected range, or null (with a message) when several are selected @param {string} what */
  oneRange(what) {
    if (this.sel.ranges.length > 1) { toast(what + ' works on one range at a time — select a single range.', { kind: 'error' }); return null; }
    return this.ranges()[0];
  }

  /* ── Building the view ─────────────────────── */

  build() {
    const r = this.root;
    this.toolbar = h('div.toolbar', { role: 'toolbar', 'aria-label': 'Formatting' });
    this.nameBox = /** @type {HTMLInputElement} */ (h('input.name-box', { 'aria-label': 'Cell address (type one to go there)', spellcheck: 'false' }));
    this.formulaInput = /** @type {HTMLInputElement} */ (h('input.formula-input', { 'aria-label': 'Formula bar', spellcheck: 'false' }));
    this.formulaBar = h('div.formula-bar', null, this.nameBox, h('div.fx', { 'aria-hidden': 'true' }, 'fx'), this.formulaInput);
    this.banner = h('div', { hidden: true });
    this.gridHost = h('div.grid-host');
    this.sidebarEl = h('aside.sidebar', { 'aria-label': 'MetaCode tools', hidden: !this.settings.sidebar });
    this.content = h('div.content', null, this.gridHost, this.sidebarEl);
    this.sheetTabs = h('div.sheet-tabs', { role: 'tablist', 'aria-label': 'Sheets' });
    this.sheetBar = h('div.sheet-bar', null, h('button.add', { 'aria-label': 'Add sheet', title: 'Add sheet (Shift+F11)', html: icon('plus'), onclick: () => this.run('insertSheet') }), this.sheetTabs);
    this.status = h('div.statusbar', { role: 'status' });
    r.append(this.toolbar, this.formulaBar, this.banner, this.content, this.sheetBar, this.status);
    this.formulaBar.hidden = !this.settings.formulaBar;

    this.grid = new Grid(this.gridHost, { emit: (n, d) => this.onGrid(n, d) });
    this.grid.gridlines = this.settings.gridlines;
    this.grid.emitKeyToAutocomplete = (/** @type {KeyboardEvent} */ e) => this.autocompleteKey(e);
    this.sidebar = new Sidebar(this.sidebarEl, this);
    this.buildToolbar();
    this.bindFormulaBar();
    this.bindClipboard();
    this.statusSoon = debounce(() => this.updateStatus(), 60);
  }

  buildToolbar() {
    const tb = this.toolbar;
    /** @param {string} ic @param {string} label @param {string} cmd @param {string} [key] */
    const btn = (ic, label, cmd, key) => { const b = h('button.tb', { 'aria-label': label, title: label + (key ? ' (' + keyText(key) + ')' : ''), html: icon(ic), dataset: { cmd } }); b.onclick = () => this.run(cmd); return b; };
    const sep = () => h('div.tb-sep', { role: 'separator' });
    this.fmtSelect = /** @type {HTMLSelectElement} */ (h('select.tb-select.fmt', { 'aria-label': 'Number format', title: 'Number format' }, ...NUMBER_FORMATS.map(([n, c]) => h('option', { value: c }, n)), h('option', { value: '__custom' }, 'Custom…')));
    this.fmtSelect.onchange = () => { const v = this.fmtSelect.value; if (v === '__custom') this.run('formatCells'); else this.styleSel({ numFmt: v === 'General' ? null : v }); this.grid.focus(); };
    this.fontSelect = /** @type {HTMLSelectElement} */ (h('select.tb-select.font', { 'aria-label': 'Font', title: 'Font' }, ...FONTS.map(f => h('option', { value: f === 'Default' ? '' : f }, f))));
    this.fontSelect.onchange = () => { this.styleSel({ family: this.fontSelect.value || null }); this.grid.focus(); };
    this.sizeSelect = /** @type {HTMLSelectElement} */ (h('select.tb-select.size', { 'aria-label': 'Font size', title: 'Font size' }, ...SIZES.map(s => h('option', { value: String(s) }, String(s)))));
    this.sizeSelect.onchange = () => { const v = Number(this.sizeSelect.value); this.styleSel({ size: v === 11 ? null : v }); this.grid.focus(); };
    const color = (/** @type {string} */ ic, /** @type {string} */ label, /** @type {string} */ prop) => {
      const sw = h('span.swatch');
      const b = h('button.tb.color', { 'aria-label': label, title: label, html: icon(ic) }, sw);
      b.onclick = () => { const rr = b.getBoundingClientRect(); colorMenu({ x: rr.left, y: rr.bottom + 4 }, c => { this.styleSel({ [prop]: c }); this.grid.focus(); }, prop === 'fill' ? 'No fill' : 'Automatic'); };
      return { b, sw };
    };
    const tc = color('textColor', 'Text colour', 'color'), fc = color('fill', 'Fill colour', 'fill');
    this.textSwatch = tc.sw; this.fillSwatch = fc.sw;
    const borders = h('button.tb', { 'aria-label': 'Borders', title: 'Borders', html: icon('border') });
    borders.onclick = () => { const rr = borders.getBoundingClientRect(); this.bordersMenu({ x: rr.left, y: rr.bottom + 4 }); };
    const sum = h('button.tb', { 'aria-label': 'Functions', title: 'AutoSum and functions', html: icon('sigma') });
    sum.onclick = () => { const rr = sum.getBoundingClientRect(); showMenu([
      ...['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map(n => ({ label: n, run: () => this.autoSum(n) })), '-',
      { label: 'More functions…', run: () => this.run('insertFunction'), key: 'Shift+F3' }], { x: rr.left, y: rr.bottom + 4 }); };
    const ai = h('button.tb.ai.text', { 'aria-label': 'AI Assistant', title: 'AI Assistant — MetaCode\'s AI (Ctrl+Shift+A)', html: icon('sparkles') + 'AI' });
    ai.onclick = () => this.run('aiAssistant');
    tb.append(
      btn('undo', 'Undo', 'undo', 'CmdOrCtrl+Z'), btn('redo', 'Redo', 'redo', 'CmdOrCtrl+Y'), sep(),
      this.fmtSelect, btn('percent', 'Percent', 'fmtPercent'), btn('dollar', 'Currency', 'fmtCurrency'), btn('decDown', 'Fewer decimals', 'decimalsDown'), btn('decUp', 'More decimals', 'decimalsUp'), sep(),
      this.fontSelect, this.sizeSelect, sep(),
      btn('bold', 'Bold', 'bold', 'CmdOrCtrl+B'), btn('italic', 'Italic', 'italic', 'CmdOrCtrl+I'), btn('underline', 'Underline', 'underline', 'CmdOrCtrl+U'), btn('strike', 'Strikethrough', 'strike', 'CmdOrCtrl+Shift+X'),
      tc.b, fc.b, borders, sep(),
      btn('alignLeft', 'Align left', 'alignLeft'), btn('alignCenter', 'Center', 'alignCenter'), btn('alignRight', 'Align right', 'alignRight'), btn('wrap', 'Wrap text', 'wrap'), sep(),
      btn('sortAsc', 'Sort A → Z', 'sortAsc'), btn('sortDesc', 'Sort Z → A', 'sortDesc'), btn('filter', 'Filter', 'toggleFilter', 'CmdOrCtrl+Shift+F'), btn('freeze', 'Freeze panes', 'freezeMenu'), sum, sep(),
      ai, btn('sidebar', 'MetaCode sidebar', 'toggleSidebar', 'CmdOrCtrl+Alt+B'));
  }

  /** @param {{ x: number, y: number }} at */
  bordersMenu(at) {
    const side = { style: 'thin', color: '#000000' };
    /** @param {string} kind @param {any} [s] */
    const set = (kind, s) => this.exec(ops.setBorders(this.wb, this.sheet, this.ranges(), /** @type {any} */ (kind), s || side));
    showMenu([
      { label: 'All borders', run: () => set('all') }, { label: 'Outside borders', run: () => set('outer') }, { label: 'Inside borders', run: () => set('inner') },
      { label: 'Top', run: () => set('top') }, { label: 'Bottom', run: () => set('bottom') }, { label: 'Left', run: () => set('left') }, { label: 'Right', run: () => set('right') },
      { label: 'Thick outside', run: () => set('outer', { style: 'medium', color: '#000000' }) }, { label: 'Double bottom', run: () => set('bottom', { style: 'double', color: '#000000' }) },
      '-', { label: 'No borders', run: () => set('none') }, { label: 'More…', run: () => this.run('formatCells', 'border') }
    ], at);
  }

  bindFormulaBar() {
    const fi = this.formulaInput;
    fi.addEventListener('focus', () => {
      if (!this.doc) return;
      if (!this.grid.editing) { this.grid.startEdit(null); fi.focus(); }
      fi.value = this.grid.editor.value;
    });
    fi.addEventListener('input', () => { this.grid.setEditText(fi.value); this.autocomplete(fi.value, fi.selectionStart || 0, fi); });
    fi.addEventListener('keydown', e => {
      if (this.autocompleteKey(e)) return;
      if (e.key === 'Enter') { e.preventDefault(); this.grid.setEditText(fi.value); this.grid.commitEdit(e.shiftKey ? 'up' : 'down'); }
      else if (e.key === 'Tab') { e.preventDefault(); this.grid.setEditText(fi.value); this.grid.commitEdit(e.shiftKey ? 'left' : 'right'); }
      else if (e.key === 'Escape') { e.preventDefault(); this.grid.cancelEdit(); }
    });
    fi.addEventListener('blur', () => setTimeout(() => { if (this.grid.editing && document.activeElement !== this.grid.editor && document.activeElement !== fi && !this.grid.keepEditing) { this.grid.setEditText(fi.value); this.grid.commitEdit(null); } }, 0));
    const nb = this.nameBox;
    nb.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); this.updateFormulaBar(); this.grid.focus(); }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = nb.value.trim();
      const m = /^(?:'?(.+?)'?!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/.exec(text);
      const g = m ? E.parseRange(m[2].replace(/\$/g, '')) : null;
      if (!g) { toast('Type a cell or range, like B4 or A1:C20 (or Sheet2!A1).', { kind: 'error' }); return; }
      if (m && m[1]) { const s = this.wb.sheetByName(m[1]); if (!s) { toast('There\'s no sheet called "' + m[1] + '".', { kind: 'error' }); return; } this.activateSheet(s.id); }
      const gr = E.normRange(g);
      this.grid.ensureExtent(gr.r2, gr.c2);
      this.grid.setSelection([gr], { r: gr.r1, c: gr.c1 });
      this.grid.focus();
    });
  }

  /* ── Clipboard (copy, cut and paste events, from the keyboard or the menu) ── */

  bindClipboard() {
    const active = () => !!this.doc && this.app.current === this.doc && document.activeElement === this.grid.scroller && !this.grid.editing;
    // Chromium only runs Copy/Cut/Paste (and fires their events) without a
    // text selection when the page asks for them by cancelling these
    for (const ev of ['beforecopy', 'beforecut', 'beforepaste']) document.addEventListener(ev, e => { if (active()) e.preventDefault(); });
    document.addEventListener('copy', e => { if (active()) { e.preventDefault(); this.copy(/** @type {ClipboardEvent} */ (e).clipboardData, false); } });
    document.addEventListener('cut', e => { if (active()) { e.preventDefault(); this.copy(/** @type {ClipboardEvent} */ (e).clipboardData, true); } });
    document.addEventListener('paste', e => {
      if (!active()) return;
      e.preventDefault();
      const cd = /** @type {ClipboardEvent} */ (e).clipboardData;
      this.paste(cd ? cd.getData('text/plain') : '', 'all');
    });
  }
  /** @param {DataTransfer | null} cd @param {boolean} cut */
  copy(cd, cut) {
    const g = this.oneRange(cut ? 'Cut' : 'Copy');
    if (!g) return;
    const b = this.sheet.bounds();
    const big = (Math.min(g.r2, b.maxRow) - g.r1 + 1) * (Math.min(g.c2, b.maxCol) - g.c1 + 1);
    if (big > 2000000) { toast('That\'s too many cells to copy at once (more than 2 million).', { kind: 'error' }); return; }
    const clip = ops.copyRange(this.wb, this.sheet, g, cut);
    this.clip = { clip, text: clip.text };
    if (cd) { cd.setData('text/plain', clip.text); cd.setData('text/html', clip.html); }
    else sheets.writeClipboard({ text: clip.text, html: clip.html }).catch(() => {});
    this.grid.marquee = { sheetId: this.sheet.id, range: clip.range };
    this.grid.invalidate();
  }
  /** @param {string} text @param {'all' | 'values'} mode */
  paste(text, mode) {
    const target = this.oneRange('Paste');
    if (!target) return;
    const norm = (/** @type {string} */ s) => String(s || '').replace(/\r\n/g, '\n').replace(/\n$/, '');
    try {
      if (this.clip && norm(this.clip.text) === norm(text)) {
        if (this.clip.clip.cut && !this.wb.sheet(this.clip.clip.sheetId)) { this.clip = null; return; }
        const r = ops.pasteClip(this.wb, this.sheet, target, this.clip.clip, mode);
        this.exec(r.step);
        this.grid.setSelection([r.range], { r: r.range.r1, c: r.range.c1 });
        if (this.clip.clip.cut) { this.clip = null; this.grid.marquee = null; }
      } else if (text) {
        if (text.length > 64 * 1024 * 1024) { toast('The clipboard holds too much to paste at once.', { kind: 'error' }); return; }
        const r = ops.pasteText(this.wb, this.sheet, target, text);
        this.exec(r.step);
        this.grid.setSelection([r.range], { r: r.range.r1, c: r.range.c1 });
      }
    } catch (e) { toast(errText(e), { kind: 'error' }); }
  }

  /* ── Binding to a document ─────────────────── */

  /** @param {any} doc */
  setDoc(doc) {
    if (this.unsub) this.unsub();
    this.doc = doc;
    this.clip = this.clip && doc && this.clip.clip.sheetId && doc.wb.sheet(this.clip.clip.sheetId) ? this.clip : null;
    this.grid.setDoc(doc);
    this.unsub = null;
    if (!doc) return;
    const offChange = doc.wb.onChange((/** @type {any} */ info) => this.onWorkbookChange(info));
    const offState = doc.onState(() => { this.updateStatus(); this.renderBanner(); });
    this.unsub = () => { offChange(); offState(); };
    this.renderSheetTabs();
    this.updateToolbar();
    this.updateFormulaBar();
    this.updateStatus();
    this.renderBanner();
    this.sidebar.docChanged();
    this.grid.focus();
  }

  /** @param {any} info */
  onWorkbookChange(info) {
    if (info && (info.type === 'structure' || info.type === 'sheets')) {
      if (!this.wb.sheet(this.wb.activeSheetId)) this.wb.activeSheetId = this.wb.sheets[0].id;
      this.renderSheetTabs();
      this.grid.axisCache.key = '';
      this.grid.layout();
    }
    if (info && info.type === 'layout') { this.grid.axisCache.key = ''; this.grid.layout(); }
    this.grid.invalidate();
    this.updateFormulaBar();
    this.statusSoon();
    this.sidebar.workbookChanged();
  }

  /** Records an undo step and refreshes @param {any} step */
  exec(step) {
    if (!step) return null;
    this.doc.record(step);
    this.grid.invalidate();
    this.updateToolbar();
    this.updateFormulaBar();
    this.statusSoon();
    return step;
  }
  /** Runs a command by name @param {string} cmd @param {any} [arg] */
  run(cmd, arg) {
    const fn = COMMANDS[cmd];
    if (!fn) return;
    try {
      const out = fn(this, arg);
      if (out && typeof out.catch === 'function') out.catch((/** @type {any} */ e) => toast(errText(e), { kind: 'error' }));
    } catch (e) { toast(errText(e), { kind: 'error' }); }
  }

  /** @param {Record<string, any>} patch */
  styleSel(patch) { return this.exec(ops.styleRanges(this.wb, this.sheet, this.ranges(), patch, 'Format')); }
  /** The style of the active cell */
  activeStyle() { const a = this.sel.active; const c = this.sheet.get(a.r, a.c); return this.wb.styles.get(c ? c.s : undefined); }

  /* ── Grid events ───────────────────────────── */

  /** @param {string} name @param {any} d */
  onGrid(name, d) {
    switch (name) {
      case 'selection': this.updateToolbar(); this.updateFormulaBar(); this.statusSoon(); this.sidebar.selectionChanged(); break;
      case 'commit': {
        try {
          if (d.fillSelection) {
            const entries = [];
            for (const g of this.ranges()) for (let r = g.r1; r <= Math.min(g.r2, g.r1 + 100000); r++) for (let c = g.c1; c <= Math.min(g.c2, g.c1 + 1000); c++) {
              const text = d.text.startsWith('=') ? E.shiftFormula(d.text, r - d.r, c - d.c) : d.text;
              entries.push({ r, c, input: text });
            }
            this.exec(ops.setInputs(this.wb, this.sheet, entries, 'Fill'));
          } else {
            if (d.text.startsWith('=') && d.text.length > 1) {
              try { E.parse(d.text.slice(1)); }
              catch (e) { toast('There\'s a problem with this formula: ' + errText(e) + ' It was kept as typed.', { kind: 'error' }); }
            }
            this.exec(ops.setInputs(this.wb, this.sheet, [{ r: d.r, c: d.c, input: d.text }]));
          }
        } catch (e) { toast(errText(e), { kind: 'error' }); }
        break;
      }
      case 'editStart': this.formulaInput.value = d.text; this.autocomplete(d.text, d.text.length, this.grid.editor); break;
      case 'editInput': if (document.activeElement !== this.formulaInput) this.formulaInput.value = d.text; this.autocomplete(d.text, d.caret, document.activeElement === this.formulaInput ? this.formulaInput : this.grid.editor); break;
      case 'editEnd': this.closeAutocomplete(); this.updateFormulaBar(); break;
      case 'clear': this.exec(ops.clearRanges(this.wb, this.sheet, this.ranges(), 'contents')); break;
      case 'resize': this.exec(ops.resize(this.wb, this.sheet, d.axis, d.indexes, d.size)); break;
      case 'autofit': this.run('fitColumns', d); break;
      case 'fill': try { this.exec(ops.fill(this.wb, this.sheet, d.src, d.dest)); } catch (e) { toast(errText(e), { kind: 'error' }); } break;
      case 'fillDownToData': this.run('fillDownToData'); break;
      case 'filterButton': filterPopup(this, d.col, d.at); break;
      case 'contextMenu': if (d.area === 'cell') cellContextMenu(this, d); else headerContextMenu(this, d); break;
      case 'marqueeCleared': this.clip = null; break;
      default: break;
    }
  }

  /* ── Formula autocomplete ──────────────────── */

  /** @param {string} text @param {number} caret @param {HTMLElement} anchor */
  autocomplete(text, caret, anchor) {
    this.closeAutocomplete();
    if (!text.startsWith('=')) return;
    const before = text.slice(0, caret);
    const m = /(^|[=(,;+\-*/^&<>:\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(before);
    const rect = anchor.getBoundingClientRect();
    const hostRect = this.gridHost.getBoundingClientRect();
    const x = rect.left - hostRect.left, y = rect.bottom - hostRect.top + 2;
    if (m && m[2].length >= 1 && !/^[A-Za-z]{1,3}\d+$/.test(m[2])) {
      const prefix = m[2].toUpperCase();
      const names = Object.keys(E.FUNCTIONS).filter(n => n.startsWith(prefix)).sort().slice(0, 12);
      if (names.length && !(names.length === 1 && names[0] === prefix && text[caret] === '(')) {
        const list = h('div.autocomplete', { role: 'listbox', 'aria-label': 'Functions' });
        names.forEach((n, i) => {
          const help = FUNCTION_HELP[n];
          const opt = h('div.opt', { role: 'option', 'aria-selected': i === 0 ? 'true' : 'false' }, h('b', null, n), h('span', null, help ? help[1] : ''));
          opt.onmousedown = (ev) => { ev.preventDefault(); this.acceptAutocomplete(n); };
          list.append(opt);
        });
        list.style.left = Math.max(0, x) + 'px';
        list.style.top = Math.max(0, y) + 'px';
        this.gridHost.append(list);
        this.ac = { list, names, index: 0, prefixLen: m[2].length, anchor };
        return;
      }
    }
    // inside a function call: show its arguments
    const call = callAt(text, caret);
    if (call && (FUNCTION_HELP[call.name] || E.FUNCTIONS[call.name])) {
      const args = (FUNCTION_HELP[call.name] ? FUNCTION_HELP[call.name][0] : E.FUNCTIONS[call.name].args || '').split(/,\s*/);
      const hint = h('div.fn-hint', { role: 'tooltip' });
      hint.innerHTML = '<b>' + esc(call.name) + '</b>(' + args.map((/** @type {string} */ a, /** @type {number} */ i) => (i === Math.min(call.arg, args.length - 1) ? '<b>' + esc(a) + '</b>' : esc(a))).join(', ') + ')';
      hint.style.left = Math.max(0, x) + 'px';
      hint.style.top = Math.max(0, y) + 'px';
      this.gridHost.append(hint);
      this.hint = hint;
    }
  }
  closeAutocomplete() {
    if (this.ac) { this.ac.list.remove(); this.ac = null; }
    if (this.hint) { this.hint.remove(); this.hint = null; }
  }
  /** @param {string} name */
  acceptAutocomplete(name) {
    if (!this.ac) return;
    const field = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (this.ac.anchor);
    const caret = field.selectionStart || 0;
    const v = field.value;
    const start = caret - this.ac.prefixLen;
    const next = v.slice(0, start) + name + '(' + v.slice(caret);
    field.value = next;
    const pos = start + name.length + 1;
    field.setSelectionRange(pos, pos);
    if (field === this.formulaInput) this.grid.setEditText(next); else { this.formulaInput.value = next; this.grid.fitEditor(); }
    this.closeAutocomplete();
    this.autocomplete(next, pos, field);
  }
  /** @param {KeyboardEvent} e */
  autocompleteKey(e) {
    if (!this.ac) return false;
    const ac = this.ac;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : -1) + ac.names.length) % ac.names.length;
      Array.from(ac.list.children).forEach((c, i) => c.setAttribute('aria-selected', i === ac.index ? 'true' : 'false'));
      /** @type {HTMLElement} */ (ac.list.children[ac.index]).scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.altKey)) { e.preventDefault(); this.acceptAutocomplete(ac.names[ac.index]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeAutocomplete(); return true; }
    return false;
  }

  /** Σ: =SUM(…) of the numbers above (or to the left) @param {string} fn */
  autoSum(fn) {
    const a = this.sel.active;
    const g = this.ranges()[0];
    const s = this.sheet;
    const isNum = (/** @type {number} */ r, /** @type {number} */ c) => typeof this.wb.valueAt(s, r, c) === 'number';
    if (g.r1 !== g.r2 || g.c1 !== g.c2) {
      // a selected block: a total under each column
      const r = Math.min(g.r2, s.bounds().maxRow) + 1;
      const entries = [];
      for (let c = g.c1; c <= Math.min(g.c2, s.bounds().maxCol); c++) entries.push({ r, c, input: '=' + fn + '(' + E.rangeA1({ r1: g.r1, c1: c, r2: r - 1, c2: c }) + ')' });
      this.exec(ops.setInputs(this.wb, s, entries, 'AutoSum'));
      return;
    }
    let r1 = a.r - 1;
    while (r1 >= 0 && isNum(r1, a.c)) r1--;
    let range = r1 + 1 <= a.r - 1 ? { r1: r1 + 1, c1: a.c, r2: a.r - 1, c2: a.c } : null;
    if (!range) { let c1 = a.c - 1; while (c1 >= 0 && isNum(a.r, c1)) c1--; if (c1 + 1 <= a.c - 1) range = { r1: a.r, c1: c1 + 1, r2: a.r, c2: a.c - 1 }; }
    this.grid.startEdit('=' + fn + '(' + (range ? E.rangeA1(range) : '') + ')');
    if (!range) { const ed = this.grid.editor; ed.setSelectionRange(ed.value.length - 1, ed.value.length - 1); }
  }

  /* ── Sheets ────────────────────────────────── */

  /** @param {string} id */
  activateSheet(id) {
    if (this.grid.editing) this.grid.commitEdit(null);
    if (!this.wb.sheet(id) || this.wb.activeSheetId === id) return;
    this.wb.activeSheetId = id;
    this.grid.sheetChanged();
    this.renderSheetTabs();
    this.updateFormulaBar();
    this.updateToolbar();
    this.statusSoon();
    this.sidebar.selectionChanged();
  }
  /** A structural change as one undo step @param {string} label @param {() => void} fn */
  structural(label, fn) {
    const before = E.snapshot(this.wb);
    fn();
    this.wb.calc.rebuild();
    this.wb.calc.recalcAll();
    this.wb.changed({ type: 'structure' });
    this.exec({ type: 'snapshot', before, after: E.snapshot(this.wb), label });
    this.grid.sheetChanged();
    this.renderSheetTabs();
  }
  renderSheetTabs() {
    if (!this.doc) return;
    const bar = this.sheetTabs;
    bar.innerHTML = '';
    for (const s of this.wb.sheets) {
      const tab = h('button.sheet-tab', { role: 'tab', 'aria-selected': s.id === this.wb.activeSheetId ? 'true' : 'false', draggable: 'true', title: s.name }, s.name);
      if (s.tabColor) { const cbar = h('span.tab-color'); cbar.style.background = s.tabColor; tab.append(cbar); }
      tab.onclick = () => this.activateSheet(s.id);
      tab.ondblclick = () => this.renameSheetInline(tab, s);
      tab.oncontextmenu = (e) => { e.preventDefault(); this.activateSheet(s.id); this.sheetMenu(s, { x: e.clientX, y: e.clientY }); };
      tab.onkeydown = (e) => { if (e.key === 'F2') { e.preventDefault(); this.renameSheetInline(tab, s); } if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = tab.getBoundingClientRect(); this.sheetMenu(s, { x: r.left, y: r.top - 8 }); } };
      tab.ondragstart = (e) => { e.dataTransfer?.setData('text/x-sheet', s.id); tab.classList.add('dragging'); };
      tab.ondragend = () => tab.classList.remove('dragging');
      tab.ondragover = (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('text/x-sheet')) e.preventDefault(); };
      tab.ondrop = (e) => {
        e.preventDefault();
        const id = e.dataTransfer?.getData('text/x-sheet');
        const from = this.wb.sheets.find((/** @type {any} */ x) => x.id === id);
        if (!from || from === s) return;
        const to = this.wb.sheets.indexOf(s);
        this.structural('Move sheet', () => this.wb.moveSheet(from, to));
      };
      bar.append(tab);
    }
    const active = /** @type {HTMLElement | null} */ (bar.querySelector('[aria-selected="true"]'));
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  /** @param {HTMLElement} tab @param {any} s */
  renameSheetInline(tab, s) {
    const input = /** @type {HTMLInputElement} */ (h('input', { value: s.name, 'aria-label': 'Sheet name' }));
    tab.replaceChildren(input);
    input.focus(); input.select();
    let done = false;
    const finish = (/** @type {boolean} */ save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== s.name) {
        const problem = this.wb.sheetNameProblem(name, s);
        if (problem) toast(problem, { kind: 'error' });
        else this.structural('Rename sheet', () => this.wb.renameSheet(s, name));
      }
      this.renderSheetTabs();
      this.grid.focus();
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
  }
  /** @param {any} s @param {{ x: number, y: number }} at */
  sheetMenu(s, at) {
    const i = this.wb.sheets.indexOf(s);
    showMenu([
      { label: 'Rename', run: () => { const tab = /** @type {HTMLElement} */ (this.sheetTabs.children[i]); if (tab) this.renameSheetInline(tab, s); } },
      { label: 'Duplicate', run: () => this.structural('Duplicate sheet', () => { const c = this.wb.duplicateSheet(s); this.wb.activeSheetId = c.id; }) },
      { label: 'Insert sheet', run: () => this.run('insertSheet') },
      { label: 'Tab colour', run: () => colorMenu(at, c => this.structural('Tab colour', () => { s.tabColor = c; }), 'No colour') },
      '-',
      { label: 'Move left', disabled: i === 0, run: () => this.structural('Move sheet', () => this.wb.moveSheet(s, i - 1)) },
      { label: 'Move right', disabled: i === this.wb.sheets.length - 1, run: () => this.structural('Move sheet', () => this.wb.moveSheet(s, i + 1)) },
      '-',
      { label: 'Delete sheet', danger: true, disabled: this.wb.sheets.length === 1, run: async () => {
        const ok = await confirm('Delete "' + s.name + '"?', 'Formulas that refer to it will show #REF!. You can undo this.', { ok: 'Delete', danger: true });
        if (ok) this.structural('Delete sheet', () => this.wb.deleteSheet(s));
      } }
    ], at);
  }

  /* ── Bars ──────────────────────────────────── */

  updateToolbar() {
    if (!this.doc) return;
    const st = this.activeStyle();
    const pressed = (/** @type {string} */ cmd, /** @type {boolean} */ on) => { const b = this.toolbar.querySelector('[data-cmd="' + cmd + '"]'); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false'); };
    pressed('bold', !!st.bold); pressed('italic', !!st.italic); pressed('underline', !!st.underline); pressed('strike', !!st.strike);
    pressed('alignLeft', st.h === 'left'); pressed('alignCenter', st.h === 'center'); pressed('alignRight', st.h === 'right'); pressed('wrap', !!st.wrap);
    pressed('toggleFilter', !!this.sheet.filter);
    pressed('toggleSidebar', !this.sidebarEl.hidden);
    pressed('freezeMenu', !!(this.sheet.freeze.rows || this.sheet.freeze.cols));
    const fmt = st.numFmt || 'General';
    const known = NUMBER_FORMATS.find(([, c]) => c === fmt);
    if (!known && !Array.from(this.fmtSelect.options).some(o => o.value === fmt)) {
      const extra = this.fmtSelect.querySelector('option[data-extra]');
      if (extra) extra.remove();
      const opt = h('option', { value: fmt, dataset: { extra: '1' } }, fmt.length > 18 ? fmt.slice(0, 18) + '…' : fmt);
      this.fmtSelect.insertBefore(opt, this.fmtSelect.lastElementChild);
    }
    this.fmtSelect.value = fmt;
    this.fontSelect.value = FONTS.includes(st.family) ? st.family : '';
    this.sizeSelect.value = String(st.size || 11);
    this.textSwatch.style.background = st.color || 'currentColor';
    this.fillSwatch.style.background = st.fill || 'transparent';
    const u = this.toolbar.querySelector('[data-cmd="undo"]'), r = this.toolbar.querySelector('[data-cmd="redo"]');
    if (u) { /** @type {HTMLButtonElement} */ (u).disabled = !this.doc.history.canUndo; u.setAttribute('title', this.doc.history.canUndo ? 'Undo ' + this.doc.history.undoLabel.toLowerCase() : 'Undo'); }
    if (r) { /** @type {HTMLButtonElement} */ (r).disabled = !this.doc.history.canRedo; r.setAttribute('title', this.doc.history.canRedo ? 'Redo ' + this.doc.history.redoLabel.toLowerCase() : 'Redo'); }
  }

  updateFormulaBar() {
    if (!this.doc) return;
    const sel = this.sel, a = sel.active;
    const g = sel.ranges[sel.ranges.length - 1];
    const multi = g.r1 !== g.r2 || g.c1 !== g.c2;
    if (document.activeElement !== this.nameBox) this.nameBox.value = multi && !this.grid.editing ? (g.r1 === 0 && g.r2 >= E.MAX_ROWS - 1 ? E.colName(g.c1) + ':' + E.colName(g.c2) : g.c1 === 0 && g.c2 >= E.MAX_COLS - 1 ? (g.r1 + 1) + ':' + (g.r2 + 1) : E.rangeA1(g)) : E.a1(a.r, a.c);
    if (!this.grid.editing) this.formulaInput.value = this.wb.inputOf(this.sheet, a.r, a.c);
  }

  updateStatus() {
    if (!this.doc) return;
    const d = this.doc;
    const st = this.app.state;
    const parts = [];
    const dotCls = d.saveState === 'saving' ? 'busy' : d.saveState === 'error' || d.saveState === 'conflict' ? 'warn' : d.dirty ? 'busy' : '';
    const label = d.saveState === 'saving' ? 'Saving…' : d.saveState === 'error' ? 'Not saved: ' + d.saveError : d.saveState === 'conflict' ? 'Not saved — see the message above' : d.dirty ? (d.path ? (this.app.autosave ? 'Unsaved changes — saving soon' : 'Unsaved changes') : 'Not saved yet') : d.path ? 'Saved' : 'New workbook';
    parts.push(h('span.state', { title: d.path || '' }, h('span.dot', { class: dotCls || undefined }), label));
    if (st.status === 'offline') parts.push(h('span.state', { title: st.message || '' }, h('span.dot.offline'), 'Offline — AI and MetaCode data need a connection'));
    const stats = h('span.stats');
    const g = this.sel.ranges;
    const one = g.length === 1 && g[0].r1 === g[0].r2 && g[0].c1 === g[0].c2;
    if (!one) {
      const s = ops.selectionStats(this.wb, this.sheet, this.ranges());
      if (s.numbers > 1) stats.append(h('span', null, 'Sum ', h('b', null, num(s.sum))), h('span', null, 'Average ', h('b', null, num(/** @type {number} */ (s.average)))));
      if (s.count > 1) stats.append(h('span', null, 'Count ', h('b', null, num(s.count))));
    }
    const zoom = h('span.zoom', null,
      h('button', { 'aria-label': 'Zoom out', onclick: () => this.run('zoomOut') }, '−'),
      h('span', null, Math.round(this.grid.zoom * 100) + '%'),
      h('button', { 'aria-label': 'Zoom in', onclick: () => this.run('zoomIn') }, '+'));
    this.status.replaceChildren(...parts, stats, zoom);
    this.app.renderTabs();
  }

  renderBanner() {
    const d = this.doc;
    const b = this.banner;
    if (!d) { b.hidden = true; return; }
    b.className = 'banner';
    b.replaceChildren();
    if (d.conflict) {
      if (d.conflict.kind === 'changed') {
        b.append(h('span', { html: icon('warning') }), h('span', null, h('b', null, 'This file was changed by another program. '), 'Your changes aren\'t saved to it yet.'), h('span.spacer'),
          h('button.btn.small', { onclick: () => this.app.reloadDoc(d) }, 'Use theirs (reload)'),
          h('button.btn.small', { onclick: async () => { d.conflict = null; const r = await d.saveAs(); if (r === 'saved') toast('Saved your version as a new file.'); this.renderBanner(); } }, 'Save mine as a copy…'),
          h('button.btn.small.primary', { onclick: async () => { const ok = await confirm('Replace the file?', 'The other program\'s changes to "' + d.name + '" will be replaced with yours. (The replaced version is kept in the app\'s backups.)', { ok: 'Replace' }); if (ok) { await d.save({ force: true }); this.renderBanner(); } } }, 'Keep mine'));
      } else {
        b.append(h('span', { html: icon('warning') }), h('span', null, h('b', null, 'The file was moved or deleted. '), 'Your work is still open here.'), h('span.spacer'),
          h('button.btn.small', { onclick: async () => { d.conflict = null; const r = await d.saveAs(); this.renderBanner(); if (r === 'saved') toast('Saved.'); } }, 'Save as…'),
          h('button.btn.small.primary', { onclick: async () => { await d.save({ force: true }); this.renderBanner(); } }, 'Save it again where it was'));
      }
      b.hidden = false;
      return;
    }
    if (d.notes && d.notes.length) {
      b.className = 'banner info';
      b.append(h('span', null, d.notes.join(' ')), h('span.spacer'), h('button.btn.small', { onclick: () => { d.notes = []; this.renderBanner(); } }, 'OK'));
      b.hidden = false;
      return;
    }
    b.hidden = true;
  }

  /** Current region around the active cell (for sort and filter) */
  region() { const a = this.sel.active; return currentRegion(this.sheet, a.r, a.c); }
}
