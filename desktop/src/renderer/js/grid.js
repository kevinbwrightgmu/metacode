// @ts-check
// ── The grid ──────────────────────────────────────────────────────────────────
// A canvas that draws only the cells in view (so a sheet with a million rows
// scrolls as fast as one with ten), under a transparent scrolling layer that
// gives native scrollbars and receives the mouse. Frozen rows and columns are
// drawn in their own panes. Typing opens an editor (a textarea) over the
// active cell. For screen readers, the active cell's address and contents are
// announced in a live region.
import * as E from '../../shared/engine/index.js';
import { Axis } from './axis.js';
import { h } from './util.js';

const CH = 24;                    // column header height
const MIN_RH = 46;                // row header width (wider for long row numbers)
const HANDLE = 7;                 // fill handle size
const RESIZE_ZONE = 4;
const PT = 4 / 3;                 // points → pixels

/**
 * @typedef {{ r1: number, c1: number, r2: number, c2: number }} Range
 * @typedef {{ ranges: Range[], active: { r: number, c: number }, anchor: { r: number, c: number } }} Selection
 */

/** @param {Range} g */
const norm = g => ({ r1: Math.min(g.r1, g.r2), c1: Math.min(g.c1, g.c2), r2: Math.max(g.r1, g.r2), c2: Math.max(g.c1, g.c2) });

export class Grid {
  /**
   * @param {HTMLElement} host
   * @param {{ emit: (name: string, data?: any) => void }} o
   */
  constructor(host, o) {
    this.host = host;
    this.emit = o.emit;
    /** @type {any} */
    this.doc = null;
    this.el = h('div.grid', { role: 'grid', 'aria-label': 'Spreadsheet', 'aria-roledescription': 'spreadsheet' });
    this.canvas = /** @type {HTMLCanvasElement} */ (h('canvas', { 'aria-hidden': 'true' }));
    this.spacer = h('div.spacer');
    this.scroller = h('div.scroller', { tabindex: '0', 'aria-label': 'Cells' }, this.spacer);
    this.editor = /** @type {HTMLTextAreaElement} */ (h('textarea.cell-editor', { spellcheck: 'false', 'aria-label': 'Cell contents', hidden: true }));
    this.live = h('div.sr-only', { 'aria-live': 'polite' });
    this.el.append(this.canvas, this.scroller, this.editor, this.live);
    host.append(this.el);
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d', { alpha: false }));
    this.zoom = 1;
    this.gridlines = true;
    this.showFormulas = false;
    this.extentRows = 200;
    this.extentCols = 40;
    /** @type {Set<number>} find results on this sheet */
    this.highlights = new Set();
    /** @type {{ sheetId: string, range: Range } | null} */
    this.marquee = null;
    /** @type {null | { r: number, c: number, text0: string, formula: boolean, pointStart: number, pointEnd: number }} */
    this.editing = null;
    this.frame = 0;
    this.colors = this.readColors();
    /** @type {any} */
    this.drag = null;
    this.axisCache = /** @type {any} */ ({ key: '', rows: null, cols: null });
    this.measureCache = new Map();
    /** set by the workspace: lets the formula autocomplete take keys first @type {((e: KeyboardEvent) => boolean) | null} */
    this.emitKeyToAutocomplete = null;
    /** true while a click in the grid inserts a reference into a formula being typed */
    this.keepEditing = false;
    /** @type {any} */
    this.announceTimer = 0;
    /** the column a run of Tab presses started in: Enter goes back to it on the next row (as in Excel) @type {number | null} */
    this.tabStart = null;

    this.scroller.addEventListener('scroll', () => this.onScroll());
    this.scroller.addEventListener('mousedown', e => this.onMouseDown(e));
    this.scroller.addEventListener('mousemove', e => this.onHover(e));
    this.scroller.addEventListener('dblclick', e => this.onDblClick(e));
    this.scroller.addEventListener('contextmenu', e => this.onContextMenu(e));
    this.scroller.addEventListener('keydown', e => this.onKey(e));
    this.scroller.addEventListener('focus', () => this.announce());
    this.editor.addEventListener('keydown', e => this.onEditorKey(e));
    this.editor.addEventListener('input', () => { this.fitEditor(); this.emit('editInput', { text: this.editor.value, caret: this.editor.selectionStart }); });
    this.editor.addEventListener('click', () => this.emit('editInput', { text: this.editor.value, caret: this.editor.selectionStart }));
    this.editor.addEventListener('blur', () => { if (this.editing && !this.keepEditing) setTimeout(() => { if (this.editing && document.activeElement !== this.editor && !this.keepEditing && !this.el.contains(document.activeElement) && !this.formulaBarFocused()) this.commitEdit(null); }, 0); });
    new ResizeObserver(() => this.layout()).observe(host);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.colors = this.readColors(); this.invalidate(); });
  }

  formulaBarFocused() { const a = document.activeElement; return !!a && a.classList.contains('formula-input'); }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (/** @type {string} */ n) => cs.getPropertyValue(n).trim();
    return { bg: v('--grid-bg'), line: v('--grid-line'), text: v('--grid-text'), header: v('--grid-header'), headerText: v('--grid-header-text'), headerActive: v('--grid-header-active'), headerActiveText: v('--grid-header-active-text'), sel: v('--grid-sel'), selBorder: v('--grid-sel-border'), freeze: v('--grid-freeze'), find: v('--grid-find'), font: v('--font'), dark: matchMedia('(prefers-color-scheme: dark)').matches };
  }

  /* ── Binding to a document ─────────────────── */

  /** @param {any} doc */
  setDoc(doc) {
    if (this.editing) this.cancelEdit();
    this.doc = doc;
    this.marquee = null;
    this.highlights = new Set();
    if (!doc) { this.invalidate(); return; }
    this.zoom = doc.view.zoom || 1;
    this.sheetChanged();
  }
  get wb() { return this.doc.wb; }
  get sheet() { return this.doc.wb.activeSheet; }
  /** @returns {{ sel: Selection, scroll: { x: number, y: number } }} */
  get sv() {
    const id = this.sheet.id;
    const views = this.doc.view.sheets;
    if (!views[id]) views[id] = { sel: { ranges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }], active: { r: 0, c: 0 }, anchor: { r: 0, c: 0 } }, scroll: { x: 0, y: 0 } };
    return views[id];
  }
  get sel() { return this.sv.sel; }
  /** The active sheet changed (switch, insert, delete) */
  sheetChanged() {
    if (this.editing) this.cancelEdit();
    this.highlights = new Set();
    this.axisCache.key = '';
    const b = this.sheet.bounds();
    this.extentRows = Math.max(200, b.maxRow + 101);
    this.extentCols = Math.max(30, b.maxCol + 11);
    this.layout();
    const s = this.sv.scroll;
    this.scroller.scrollTop = s.y;
    this.scroller.scrollLeft = s.x;
    this.selectionChanged(false);
  }

  /* ── Geometry ──────────────────────────────── */

  axes() {
    const s = this.sheet;
    const key = s.id + ':' + this.wb.version + ':' + this.extentRows + ':' + this.extentCols + ':' + s.rowHeights.size + ':' + s.colWidths.size + ':' + s.hiddenRows.size + ':' + s.filteredRows.size + ':' + s.hiddenCols.size;
    if (this.axisCache.key !== key) {
      const hiddenRows = new Set([...s.hiddenRows, ...s.filteredRows]);
      this.axisCache = {
        key,
        rows: new Axis(E.DEFAULT_ROW_HEIGHT, s.rowHeights, (/** @type {number} */ r) => hiddenRows.has(r), hiddenRows, Math.min(E.MAX_ROWS, this.extentRows)),
        cols: new Axis(E.DEFAULT_COL_WIDTH, s.colWidths, (/** @type {number} */ c) => s.hiddenCols.has(c), s.hiddenCols, Math.min(E.MAX_COLS, this.extentCols))
      };
    }
    return /** @type {{ rows: Axis, cols: Axis }} */ (this.axisCache);
  }
  /** Width of the row number column */
  rowHeaderWidth() { const last = Math.min(E.MAX_ROWS, this.extentRows); return Math.max(MIN_RH, String(last).length * 8 + 16); }
  metrics() {
    const { rows, cols } = this.axes();
    const z = this.zoom;
    const W = this.host.clientWidth / z, H = this.host.clientHeight / z;
    const RH = this.rowHeaderWidth();
    const fr = Math.min(this.sheet.freeze.rows, rows.count), fc = Math.min(this.sheet.freeze.cols, cols.count);
    const fh = rows.offset(fr), fw = cols.offset(fc);
    const sx = this.scroller.scrollLeft / z, sy = this.scroller.scrollTop / z;
    return { rows, cols, z, W, H, RH, fr, fc, fh, fw, sx, sy };
  }
  /** Screen rectangle of a cell (in sheet units, before zoom) @param {number} r @param {number} c */
  cellRect(r, c) {
    const m = this.metrics();
    const x = m.RH + m.cols.offset(c) - (c >= m.fc ? m.sx : 0);
    const y = CH + m.rows.offset(r) - (r >= m.fr ? m.sy : 0);
    return { x, y, w: m.cols.size(c), h: m.rows.size(r) };
  }

  layout() {
    if (!this.doc) return;
    const { rows, cols, z, RH } = this.metrics();
    this.spacer.style.width = Math.ceil((RH + cols.total() + 40) * z) + 'px';
    this.spacer.style.height = Math.ceil((CH + rows.total() + 40) * z) + 'px';
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, hh = this.host.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hh * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hh * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = hh + 'px';
    }
    this.invalidate();
  }

  onScroll() {
    if (!this.doc) return;
    const s = this.sv.scroll;
    s.x = this.scroller.scrollLeft; s.y = this.scroller.scrollTop;
    // grow the scrollable area as the end comes near
    const near = (/** @type {number} */ pos, /** @type {number} */ size, /** @type {number} */ view) => pos + view * 3 > size;
    let grew = false;
    if (near(this.scroller.scrollTop, this.scroller.scrollHeight, this.scroller.clientHeight) && this.extentRows < E.MAX_ROWS) { this.extentRows = Math.min(E.MAX_ROWS, this.extentRows + Math.max(500, Math.round(this.extentRows / 2))); grew = true; }
    if (near(this.scroller.scrollLeft, this.scroller.scrollWidth, this.scroller.clientWidth) && this.extentCols < E.MAX_COLS) { this.extentCols = Math.min(E.MAX_COLS, this.extentCols + 20); grew = true; }
    if (grew) this.layout(); else this.invalidate();
    if (this.editing) this.placeEditor();
  }
  /** Makes sure the extent covers a cell @param {number} r @param {number} c */
  ensureExtent(r, c) {
    let grew = false;
    if (r + 50 > this.extentRows) { this.extentRows = Math.min(E.MAX_ROWS, r + 200); grew = true; }
    if (c + 10 > this.extentCols) { this.extentCols = Math.min(E.MAX_COLS, c + 20); grew = true; }
    if (grew) this.layout();
  }

  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  /* ── Drawing ───────────────────────────────── */

  draw() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    if (!this.doc) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = this.colors.bg; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); return; }
    const m = this.metrics();
    const k = dpr * m.z;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, m.W, m.H);
    ctx.textBaseline = 'middle';
    /** crisp 1-px lines */
    const px = (/** @type {number} */ v) => (Math.round(v * k) + 0.5) / k;
    const lw = 1 / k;

    // visible rows/cols of the scrolling area
    const r0 = m.rows.indexAt(m.fh + m.sy), r1 = Math.min(m.rows.count - 1, m.rows.indexAt(m.fh + m.sy + Math.max(0, m.H - CH - m.fh)) + 1);
    const c0 = m.cols.indexAt(m.fw + m.sx), c1 = Math.min(m.cols.count - 1, m.cols.indexAt(m.fw + m.sx + Math.max(0, m.W - m.RH - m.fw)) + 1);
    const frozenRows = m.fr > 0 ? [0, m.fr - 1] : null, frozenCols = m.fc > 0 ? [0, m.fc - 1] : null;
    /** quadrant: [rowFrom, rowTo, colFrom, colTo, sx, sy, clipX, clipY, clipW, clipH] */
    const quads = [];
    const mainX = m.RH + m.fw, mainY = CH + m.fh;
    quads.push({ rr: [Math.max(r0, m.fr), r1], cc: [Math.max(c0, m.fc), c1], sx: m.sx, sy: m.sy, x: mainX, y: mainY, w: m.W - mainX, h: m.H - mainY });
    if (frozenRows) quads.push({ rr: frozenRows, cc: [Math.max(c0, m.fc), c1], sx: m.sx, sy: 0, x: mainX, y: CH, w: m.W - mainX, h: m.fh });
    if (frozenCols) quads.push({ rr: [Math.max(r0, m.fr), r1], cc: frozenCols, sx: 0, sy: m.sy, x: m.RH, y: mainY, w: m.fw, h: m.H - mainY });
    if (frozenRows && frozenCols) quads.push({ rr: frozenRows, cc: frozenCols, sx: 0, sy: 0, x: m.RH, y: CH, w: m.fw, h: m.fh });

    for (const q of quads) {
      if (q.w <= 0 || q.h <= 0) continue;
      ctx.save();
      ctx.beginPath(); ctx.rect(q.x, q.y, q.w, q.h); ctx.clip();
      this.drawCells(m, q, px, lw);
      this.drawSelection(m, q, px, lw);
      ctx.restore();
    }
    this.drawHeaders(m, quads, px, lw);
    // frozen pane lines
    ctx.strokeStyle = this.colors.freeze; ctx.lineWidth = 2 / k;
    if (m.fr) { ctx.beginPath(); ctx.moveTo(0, CH + m.fh); ctx.lineTo(m.W, CH + m.fh); ctx.stroke(); }
    if (m.fc) { ctx.beginPath(); ctx.moveTo(m.RH + m.fw, 0); ctx.lineTo(m.RH + m.fw, m.H); ctx.stroke(); }
  }

  /** The font for a style @param {any} st */
  font(st) {
    const size = (st.size || 11) * PT;
    return (st.italic ? 'italic ' : '') + (st.bold ? '700 ' : '400 ') + size.toFixed(1) + 'px ' + (st.family ? '"' + String(st.family).replace(/"/g, '') + '", ' : '') + this.colors.font;
  }

  /** @param {any} m @param {any} q @param {(v: number) => number} px @param {number} lw */
  drawCells(m, q, px, lw) {
    const ctx = this.ctx, s = this.sheet, wb = this.wb;
    const X = (/** @type {number} */ c) => m.RH + m.cols.offset(c) - q.sx;
    const Y = (/** @type {number} */ r) => CH + m.rows.offset(r) - q.sy;
    const [ra, rb] = q.rr, [ca, cb] = q.cc;
    if (rb < ra || cb < ca) return;
    // fills and find highlights
    for (let r = ra; r <= rb; r++) {
      const hgt = m.rows.size(r);
      if (!hgt) continue;
      const y = Y(r);
      for (let c = ca; c <= cb; c++) {
        const cell = s.cells.get(E.keyOf(r, c));
        const key = E.keyOf(r, c);
        if (cell && cell.s) { const st = wb.styles.get(cell.s); if (st.fill) { ctx.fillStyle = st.fill; ctx.fillRect(X(c), y, m.cols.size(c), hgt); } }
        if (this.highlights.has(key)) { ctx.fillStyle = this.colors.find; ctx.fillRect(X(c), y, m.cols.size(c), hgt); }
      }
    }
    // gridlines
    if (this.gridlines) {
      ctx.strokeStyle = this.colors.line; ctx.lineWidth = lw;
      ctx.beginPath();
      const yTop = Y(ra), yBot = Y(rb) + m.rows.size(rb), xL = X(ca), xR = X(cb) + m.cols.size(cb);
      for (let c = ca; c <= cb + 1; c++) { if (c <= cb && !m.cols.size(c)) continue; const x = px(X(c) - 1 + (c > cb ? 0 : 0)); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); }
      for (let r = ra; r <= rb + 1; r++) { if (r <= rb && !m.rows.size(r)) continue; const y = px(Y(r) - 1); ctx.moveTo(xL, y); ctx.lineTo(xR, y); }
      ctx.stroke();
    }
    // text: left-aligned text may spill into empty cells to its right
    const lastCol = cb;
    for (let r = ra; r <= rb; r++) {
      const hgt = m.rows.size(r);
      if (!hgt) continue;
      const y = Y(r);
      for (let c = ca; c <= cb; c++) {
        const cell = s.cells.get(E.keyOf(r, c));
        if (!cell) continue;
        const v = cell.v;
        const showF = this.showFormulas && cell.f;
        if (!showF && (v === null || v === undefined || v === '')) continue;
        const wdt = m.cols.size(c);
        if (!wdt) continue;
        const st = wb.styles.get(cell.s);
        let text, color = null;
        if (showF) text = cell.f;
        else { const f = E.formatValue(v, st.numFmt); text = f.text; color = f.color; }
        if (!text) continue;
        ctx.font = this.font(st);
        let fg = color || st.color || this.colors.text;
        if (this.colors.dark && !st.fill && !color && st.color && isDark(st.color)) fg = this.colors.text;
        ctx.fillStyle = fg;
        const isNum = typeof v === 'number' && !showF, isCenter = typeof v === 'boolean' || v instanceof E.CellError;
        const align = st.h || (isNum ? 'right' : isCenter ? 'center' : 'left');
        const pad = 4 + (st.indent ? st.indent * 9 : 0);
        const x = X(c);
        const valign = st.v || 'bottom';
        if (st.wrap && !isNum) {
          const lines = this.wrapLines(text, wdt - 8);
          const lh = (st.size || 11) * PT * 1.25;
          const total = lines.length * lh;
          let ty = valign === 'top' ? y + 2 + lh / 2 : valign === 'middle' ? y + (hgt - total) / 2 + lh / 2 : y + hgt - total - 2 + lh / 2;
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, wdt, hgt); ctx.clip();
          for (const line of lines) { this.fillText(line, align, x, wdt, pad, ty); ty += lh; }
          ctx.restore();
        } else {
          const tw = this.measure(text, ctx.font);
          let room = wdt;
          if (align === 'left' && tw > wdt - pad) {
            // spill right over empty neighbours
            for (let n = c + 1; n <= lastCol + 20 && room < tw + pad + 2; n++) {
              const nc = s.cells.get(E.keyOf(r, n));
              if (nc && nc.v !== null && nc.v !== undefined && nc.v !== '') break;
              room += m.cols.size(n);
            }
          }
          const ty = valign === 'top' ? y + 2 + (st.size || 11) * PT * 0.6 : valign === 'middle' ? y + hgt / 2 : y + hgt - 2 - (st.size || 11) * PT * 0.55;
          if (isNum && tw > wdt - 6) {
            // a number that doesn't fit is shown as ### (as in Excel), never cut off
            ctx.save(); ctx.beginPath(); ctx.rect(x, y, wdt, hgt); ctx.clip();
            this.fillText('#'.repeat(Math.max(1, Math.floor((wdt - 6) / Math.max(4, this.measure('#', ctx.font))))), 'right', x, wdt, 4, ty);
            ctx.restore();
          } else if (tw > room - pad || align !== 'left') {
            ctx.save(); ctx.beginPath(); ctx.rect(x, y, align === 'left' ? room : wdt, hgt); ctx.clip();
            this.fillText(text, align, x, wdt, pad, ty);
            ctx.restore();
          } else this.fillText(text, align, x, wdt, pad, ty);
          if (st.underline || st.strike) {
            const tx = align === 'right' ? x + wdt - pad - tw : align === 'center' ? x + (wdt - tw) / 2 : x + pad;
            ctx.strokeStyle = fg; ctx.lineWidth = Math.max(lw, (st.size || 11) / 14);
            ctx.beginPath();
            if (st.underline) { ctx.moveTo(tx, ty + (st.size || 11) * PT * 0.45); ctx.lineTo(tx + Math.min(tw, room), ty + (st.size || 11) * PT * 0.45); }
            if (st.strike) { ctx.moveTo(tx, ty); ctx.lineTo(tx + Math.min(tw, room), ty); }
            ctx.stroke();
          }
        }
      }
    }
    // borders
    for (let r = ra; r <= rb; r++) {
      const hgt = m.rows.size(r);
      if (!hgt) continue;
      for (let c = ca; c <= cb; c++) {
        const cell = s.cells.get(E.keyOf(r, c));
        if (!cell || !cell.s) continue;
        const b = wb.styles.get(cell.s).border;
        if (!b) continue;
        const x = X(c), y = Y(r), w = m.cols.size(c);
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const bs = b[side];
          if (!bs) continue;
          const width = bs.style === 'thick' ? 3 : bs.style === 'medium' ? 2 : 1;
          ctx.strokeStyle = this.colors.dark && isDark(bs.color || '#000000') ? this.colors.text : (bs.color || '#000000');
          ctx.lineWidth = width * lw * (this.zoom >= 1 ? 1 : 1 / this.zoom);
          ctx.setLineDash(bs.style === 'dashed' ? [4, 3] : bs.style === 'dotted' ? [1, 2] : []);
          ctx.beginPath();
          const x1 = px(x - 1), x2 = px(x + w - 1), y1 = px(y - 1), y2 = px(y + hgt - 1);
          if (side === 'top') { ctx.moveTo(x1, y1); ctx.lineTo(x2, y1); }
          if (side === 'bottom') { ctx.moveTo(x1, y2); ctx.lineTo(x2, y2); }
          if (side === 'left') { ctx.moveTo(x1, y1); ctx.lineTo(x1, y2); }
          if (side === 'right') { ctx.moveTo(x2, y1); ctx.lineTo(x2, y2); }
          ctx.stroke();
          if (bs.style === 'double') { ctx.beginPath(); const o = 2 * lw; if (side === 'top') { ctx.moveTo(x1, y1 + o); ctx.lineTo(x2, y1 + o); } if (side === 'bottom') { ctx.moveTo(x1, y2 - o); ctx.lineTo(x2, y2 - o); } if (side === 'left') { ctx.moveTo(x1 + o, y1); ctx.lineTo(x1 + o, y2); } if (side === 'right') { ctx.moveTo(x2 - o, y1); ctx.lineTo(x2 - o, y2); } ctx.stroke(); }
        }
      }
    }
    ctx.setLineDash([]);
    // filter buttons in the filter's header row
    const f = s.filter;
    if (f && f.range.r1 >= ra && f.range.r1 <= rb) {
      const y = Y(f.range.r1), hgt = m.rows.size(f.range.r1);
      for (let c = Math.max(ca, f.range.c1); c <= Math.min(cb, f.range.c2); c++) {
        const w = m.cols.size(c);
        if (!w) continue;
        const bx = X(c) + w - 18, by = y + (hgt - 16) / 2;
        const active = !!f.conditions[c];
        ctx.fillStyle = active ? this.colors.selBorder : this.colors.header;
        ctx.strokeStyle = this.colors.line; ctx.lineWidth = lw;
        ctx.fillRect(bx, by, 16, 16); ctx.strokeRect(px(bx), px(by), 16, 16);
        ctx.fillStyle = active ? this.colors.bg : this.colors.headerText;
        ctx.beginPath(); ctx.moveTo(bx + 4, by + 6); ctx.lineTo(bx + 12, by + 6); ctx.lineTo(bx + 8, by + 11); ctx.closePath(); ctx.fill();
      }
    }
  }

  /** @param {string} text @param {string} align @param {number} x @param {number} w @param {number} pad @param {number} y */
  fillText(text, align, x, w, pad, y) {
    const ctx = this.ctx;
    if (align === 'right') { ctx.textAlign = 'right'; ctx.fillText(text, x + w - pad, y); }
    else if (align === 'center') { ctx.textAlign = 'center'; ctx.fillText(text, x + w / 2, y); }
    else { ctx.textAlign = 'left'; ctx.fillText(text, x + pad, y); }
  }
  /** @param {string} text @param {string} font */
  measure(text, font) {
    const key = font + '\u0000' + text;
    let w = this.measureCache.get(key);
    if (w === undefined) {
      if (this.measureCache.size > 20000) this.measureCache.clear();
      const prev = this.ctx.font;
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.ctx.font = prev;
      this.measureCache.set(key, w);
    }
    return w;
  }
  /** @param {string} text @param {number} width */
  wrapLines(text, width) {
    const out = [];
    for (const para of String(text).split('\n')) {
      const words = para.split(/(\s+)/);
      let line = '';
      for (const wd of words) {
        const next = line + wd;
        if (line && this.ctx.measureText(next).width > width) { out.push(line.trimEnd()); line = wd.trimStart(); }
        else line = next;
      }
      out.push(line);
      if (out.length > 200) break;
    }
    return out;
  }

  /** @param {any} m @param {any} q @param {(v: number) => number} px @param {number} lw */
  drawSelection(m, q, px, lw) {
    const ctx = this.ctx;
    const X = (/** @type {number} */ c) => m.RH + m.cols.offset(c) - q.sx;
    const Y = (/** @type {number} */ r) => CH + m.rows.offset(r) - q.sy;
    const sel = this.sel;
    const k = 1 / lw;
    for (const g of sel.ranges) {
      const x1 = X(g.c1), y1 = Y(g.r1), x2 = X(Math.min(g.c2, m.cols.count - 1) + 1), y2 = Y(Math.min(g.r2, m.rows.count - 1) + 1);
      const single = g.r1 === g.r2 && g.c1 === g.c2;
      if (!single || sel.ranges.length > 1) { ctx.fillStyle = this.colors.sel; ctx.fillRect(x1, y1, x2 - x1, y2 - y1); }
      ctx.strokeStyle = this.colors.selBorder; ctx.lineWidth = sel.ranges.length > 1 ? lw : 2 * lw;
      ctx.strokeRect(px(x1 - 1), px(y1 - 1), Math.round((x2 - x1) * k) / k, Math.round((y2 - y1) * k) / k);
    }
    // the active cell: white inside, thick border
    const a = sel.active;
    if (m.rows.size(a.r) && m.cols.size(a.c)) {
      const x = X(a.c), y = Y(a.r), w = m.cols.size(a.c), hh = m.rows.size(a.r);
      if (sel.ranges.some(g => g.r1 !== g.r2 || g.c1 !== g.c2) || sel.ranges.length > 1) {
        ctx.strokeStyle = this.colors.selBorder; ctx.lineWidth = 2 * lw; ctx.strokeRect(px(x), px(y), w - 2 * lw, hh - 2 * lw);
      }
    }
    // the fill handle (bottom right of the last range)
    const last = sel.ranges[sel.ranges.length - 1];
    if (sel.ranges.length === 1 && !this.editing) {
      const hx = X(Math.min(last.c2, m.cols.count - 1) + 1), hy = Y(Math.min(last.r2, m.rows.count - 1) + 1);
      ctx.fillStyle = this.colors.selBorder;
      ctx.fillRect(hx - HANDLE / 2 - 1, hy - HANDLE / 2 - 1, HANDLE, HANDLE);
      ctx.strokeStyle = this.colors.bg; ctx.lineWidth = lw; ctx.strokeRect(hx - HANDLE / 2 - 1, hy - HANDLE / 2 - 1, HANDLE, HANDLE);
    }
    // copied cells: a dashed outline
    if (this.marquee && this.marquee.sheetId === this.sheet.id) {
      const g = this.marquee.range;
      ctx.strokeStyle = this.colors.selBorder; ctx.lineWidth = 2 * lw; ctx.setLineDash([5, 4]);
      ctx.strokeRect(px(X(g.c1) - 1), px(Y(g.r1) - 1), X(g.c2 + 1) - X(g.c1), Y(g.r2 + 1) - Y(g.r1));
      ctx.setLineDash([]);
    }
    // a drag in progress (fill)
    if (this.drag && this.drag.kind === 'fill' && this.drag.dest) {
      const g = this.drag.dest;
      ctx.strokeStyle = this.colors.selBorder; ctx.lineWidth = lw; ctx.setLineDash([3, 3]);
      ctx.strokeRect(px(X(g.c1) - 1), px(Y(g.r1) - 1), X(g.c2 + 1) - X(g.c1), Y(g.r2 + 1) - Y(g.r1));
      ctx.setLineDash([]);
    }
  }

  /** @param {any} m @param {any[]} quads @param {(v: number) => number} px @param {number} lw */
  drawHeaders(m, quads, px, lw) {
    const ctx = this.ctx, C = this.colors;
    const sel = this.sel;
    const activeCols = new Set(), activeRows = new Set();
    let fullCols = false, fullRows = false;
    for (const g of sel.ranges) {
      if (g.r1 === 0 && g.r2 >= E.MAX_ROWS - 1) fullCols = true;
      if (g.c1 === 0 && g.c2 >= E.MAX_COLS - 1) fullRows = true;
      for (let c = g.c1; c <= Math.min(g.c2, g.c1 + 400); c++) activeCols.add(c);
      for (let r = g.r1; r <= Math.min(g.r2, g.r1 + 2000); r++) activeRows.add(r);
    }
    ctx.font = '500 11.5px ' + C.font;
    ctx.textAlign = 'center';
    // column headers
    ctx.fillStyle = C.header; ctx.fillRect(m.RH, 0, m.W - m.RH, CH);
    for (const q of quads.filter(q => q.y === CH + m.fh || (m.fr === 0 && q.y === CH))) {
      if (q.y !== CH + m.fh) continue;
      ctx.save(); ctx.beginPath(); ctx.rect(q.x, 0, q.w, CH); ctx.clip();
      for (let c = q.cc[0]; c <= q.cc[1]; c++) {
        const w = m.cols.size(c);
        if (!w) continue;
        const x = m.RH + m.cols.offset(c) - q.sx;
        if (activeCols.has(c)) { ctx.fillStyle = C.headerActive; ctx.fillRect(x, 0, w, CH); }
        ctx.fillStyle = activeCols.has(c) ? C.headerActiveText : C.headerText;
        ctx.fillText(E.colName(c), x + w / 2, CH / 2 + 1);
        ctx.strokeStyle = C.line; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(px(x + w - 1), 0); ctx.lineTo(px(x + w - 1), CH); ctx.stroke();
      }
      if (fullCols) { ctx.fillStyle = C.selBorder; ctx.fillRect(q.x, CH - 2, q.w, 2); }
      ctx.restore();
    }
    // row headers
    ctx.fillStyle = C.header; ctx.fillRect(0, CH, m.RH, m.H - CH);
    for (const q of quads.filter(q => q.x === m.RH + m.fw)) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, q.y, m.RH, q.h); ctx.clip();
      for (let r = q.rr[0]; r <= q.rr[1]; r++) {
        const hh = m.rows.size(r);
        if (!hh) continue;
        const y = CH + m.rows.offset(r) - q.sy;
        if (activeRows.has(r)) { ctx.fillStyle = C.headerActive; ctx.fillRect(0, y, m.RH, hh); }
        ctx.fillStyle = activeRows.has(r) ? C.headerActiveText : C.headerText;
        ctx.fillText(String(r + 1), m.RH / 2, y + hh / 2 + 1);
        ctx.strokeStyle = C.line; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(0, px(y + hh - 1)); ctx.lineTo(m.RH, px(y + hh - 1)); ctx.stroke();
      }
      if (fullRows) { ctx.fillStyle = C.selBorder; ctx.fillRect(m.RH - 2, q.y, 2, q.h); }
      ctx.restore();
    }
    // header borders and the corner
    ctx.strokeStyle = C.line; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(0, px(CH - 1)); ctx.lineTo(m.W, px(CH - 1)); ctx.moveTo(px(m.RH - 1), 0); ctx.lineTo(px(m.RH - 1), m.H); ctx.stroke();
    ctx.fillStyle = C.header; ctx.fillRect(0, 0, m.RH - 1, CH - 1);
    ctx.fillStyle = C.headerText; ctx.beginPath(); ctx.moveTo(m.RH - 6, CH - 14); ctx.lineTo(m.RH - 6, CH - 6); ctx.lineTo(m.RH - 14, CH - 6); ctx.closePath(); ctx.fill();
  }

  /* ── Hit testing ───────────────────────────── */

  /** @param {MouseEvent} e */
  hit(e) {
    const rect = this.scroller.getBoundingClientRect();
    const m = this.metrics();
    const x = (e.clientX - rect.left) / m.z, y = (e.clientY - rect.top) / m.z;
    const colAt = (/** @type {number} */ xx) => (xx - m.RH < m.fw ? m.cols.indexAt(xx - m.RH) : m.cols.indexAt(xx - m.RH + m.sx));
    const rowAt = (/** @type {number} */ yy) => (yy - CH < m.fh ? m.rows.indexAt(yy - CH) : m.rows.indexAt(yy - CH + m.sy));
    const colX = (/** @type {number} */ c) => m.RH + m.cols.offset(c) - (c >= m.fc ? m.sx : 0);
    const rowY = (/** @type {number} */ r) => CH + m.rows.offset(r) - (r >= m.fr ? m.sy : 0);
    if (x > m.W - 2 || y > m.H - 2 || x < 0 || y < 0) return { area: 'outside', x, y };
    if (y < CH && x < m.RH) return { area: 'corner', x, y };
    if (y < CH) {
      const c = colAt(x);
      const right = colX(c) + m.cols.size(c);
      if (Math.abs(x - right) <= RESIZE_ZONE) return { area: 'colResize', c, x, y };
      const left = colX(c);
      if (Math.abs(x - left) <= RESIZE_ZONE && c > 0) { const p = m.cols.nextVisible(c - 1, -1); if (p >= 0) return { area: 'colResize', c: p, x, y }; }
      return { area: 'colHeader', c, x, y };
    }
    if (x < m.RH) {
      const r = rowAt(y);
      const bottom = rowY(r) + m.rows.size(r);
      if (Math.abs(y - bottom) <= RESIZE_ZONE) return { area: 'rowResize', r, x, y };
      const top = rowY(r);
      if (Math.abs(y - top) <= RESIZE_ZONE && r > 0) { const p = m.rows.nextVisible(r - 1, -1); if (p >= 0) return { area: 'rowResize', r: p, x, y }; }
      return { area: 'rowHeader', r, x, y };
    }
    const r = rowAt(y), c = colAt(x);
    // the fill handle
    const sel = this.sel;
    if (sel.ranges.length === 1 && !this.editing) {
      const g = sel.ranges[0];
      const hx = colX(Math.min(g.c2, m.cols.count - 1) + 1), hy = rowY(Math.min(g.r2, m.rows.count - 1) + 1);
      if (Math.abs(x - hx) <= HANDLE && Math.abs(y - hy) <= HANDLE) return { area: 'handle', r, c, x, y };
    }
    // filter buttons
    const f = this.sheet.filter;
    if (f && r === f.range.r1 && c >= f.range.c1 && c <= f.range.c2) {
      const bx = colX(c) + m.cols.size(c) - 18, by = rowY(r) + (m.rows.size(r) - 16) / 2;
      if (x >= bx && x <= bx + 16 && y >= by && y <= by + 16) return { area: 'filterButton', r, c, x, y, rect: { x: (bx * m.z) + this.scroller.getBoundingClientRect().left, y: ((by + 16) * m.z) + this.scroller.getBoundingClientRect().top } };
    }
    return { area: 'cell', r, c, x, y };
  }

  /* ── Mouse ─────────────────────────────────── */

  /** @param {MouseEvent} e */
  onHover(e) {
    if (this.drag) return;
    const t = this.hit(e);
    this.scroller.style.cursor = t.area === 'colResize' ? 'col-resize' : t.area === 'rowResize' ? 'row-resize' : t.area === 'handle' ? 'crosshair' : t.area === 'filterButton' ? 'pointer' : 'cell';
  }

  /** @param {MouseEvent} e */
  onMouseDown(e) {
    if (!this.doc) return;
    // clicks on the native scrollbars
    if (e.offsetX > this.scroller.clientWidth || e.offsetY > this.scroller.clientHeight) return;
    const t = /** @type {any} */ (this.hit(e));
    if (t.area === 'outside') return;
    if (e.button === 2) {
      // right-click inside the selection keeps it
      if (t.area === 'cell' && this.sel.ranges.some(g => E.inRange(g, t.r, t.c))) return;
      if (t.area === 'colHeader' && this.sel.ranges.some(g => g.c1 <= t.c && t.c <= g.c2 && g.r1 === 0 && g.r2 >= E.MAX_ROWS - 1)) return;
      if (t.area === 'rowHeader' && this.sel.ranges.some(g => g.r1 <= t.r && t.r <= g.r2 && g.c1 === 0 && g.c2 >= E.MAX_COLS - 1)) return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    // point mode: clicking a cell while typing a formula inserts its reference
    if (this.editing && this.editing.formula && t.area === 'cell' && this.canPoint()) {
      this.keepEditing = true;
      this.pointAt({ r1: t.r, c1: t.c, r2: t.r, c2: t.c });
      this.drag = { kind: 'point', start: { r: t.r, c: t.c } };
      this.trackDrag(e);
      return;
    }
    if (this.editing) this.commitEdit(null);
    this.tabStart = null;
    this.scroller.focus({ preventScroll: true });
    if (t.area === 'filterButton') { this.emit('filterButton', { col: t.c, at: t.rect }); return; }
    if (t.area === 'colResize' || t.area === 'rowResize') {
      const axis = t.area === 'colResize' ? 'col' : 'row';
      const idx = axis === 'col' ? t.c : t.r;
      const m = this.metrics();
      const start = axis === 'col' ? m.cols.size(idx) : m.rows.size(idx);
      this.drag = { kind: 'resize', axis, idx, start, from: axis === 'col' ? e.clientX : e.clientY, size: start };
      this.trackDrag(e);
      return;
    }
    if (t.area === 'handle') { this.drag = { kind: 'fill', src: Object.assign({}, this.sel.ranges[0]), dest: null }; this.trackDrag(e); return; }
    const sel = this.sel;
    if (t.area === 'corner') { this.setSelection([{ r1: 0, c1: 0, r2: E.MAX_ROWS - 1, c2: E.MAX_COLS - 1 }], { r: 0, c: 0 }); return; }
    const add = e.ctrlKey || e.metaKey;
    let anchor = { r: t.area === 'colHeader' ? 0 : t.r, c: t.area === 'rowHeader' ? 0 : t.c };
    if (e.shiftKey && !add) anchor = sel.anchor;
    const kind = t.area === 'colHeader' ? 'cols' : t.area === 'rowHeader' ? 'rows' : 'cells';
    const point = { r: kind === 'cols' ? 0 : t.r, c: kind === 'rows' ? 0 : t.c };
    const rangeFor = (/** @type {{ r: number, c: number }} */ a, /** @type {{ r: number, c: number }} */ b) => kind === 'cols' ? { r1: 0, c1: Math.min(a.c, b.c), r2: E.MAX_ROWS - 1, c2: Math.max(a.c, b.c) }
      : kind === 'rows' ? { r1: Math.min(a.r, b.r), c1: 0, r2: Math.max(a.r, b.r), c2: E.MAX_COLS - 1 } : norm({ r1: a.r, c1: a.c, r2: b.r, c2: b.c });
    const base = add ? sel.ranges.slice() : [];
    const active = e.shiftKey && !add ? sel.active : point;
    this.setSelection(base.concat([rangeFor(anchor, point)]), active, anchor);
    this.drag = { kind: 'select', anchor, base, rangeFor, sel: kind };
    this.trackDrag(e);
  }

  /** @param {MouseEvent} e0 */
  trackDrag(e0) {
    let last = e0;
    /** @type {any} */
    let timer = null;
    const move = (/** @type {MouseEvent} */ e) => {
      last = e;
      this.dragTo(e);
      // scroll while dragging past an edge
      const rect = this.scroller.getBoundingClientRect();
      const out = e.clientX < rect.left + 20 || e.clientX > rect.right - 20 || e.clientY < rect.top + 30 || e.clientY > rect.bottom - 20;
      if (out && !timer && this.drag && this.drag.kind !== 'resize') {
        timer = setInterval(() => {
          const r2 = this.scroller.getBoundingClientRect();
          const dx = last.clientX < r2.left + 20 ? -30 : last.clientX > r2.right - 20 ? 30 : 0;
          const dy = last.clientY < r2.top + 30 ? -30 : last.clientY > r2.bottom - 20 ? 30 : 0;
          this.scroller.scrollLeft += dx; this.scroller.scrollTop += dy;
          this.dragTo(last);
        }, 40);
      } else if (!out && timer) { clearInterval(timer); timer = null; }
    };
    const up = (/** @type {MouseEvent} */ e) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (timer) clearInterval(timer);
      this.endDrag(e);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /** @param {MouseEvent} e */
  dragTo(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'resize') {
      const delta = ((d.axis === 'col' ? e.clientX : e.clientY) - d.from) / this.zoom;
      d.size = Math.max(d.axis === 'col' ? 12 : 8, d.start + delta);
      const map = d.axis === 'col' ? this.sheet.colWidths : this.sheet.rowHeights;
      map.set(d.idx, Math.round(d.size));       // live preview; recorded as one step on release
      this.axisCache.key = '';
      this.layout();
      return;
    }
    const t = /** @type {any} */ (this.hit(e));
    const clampT = { r: Math.max(0, t.r === undefined ? (t.y < CH ? this.metrics().rows.indexAt(this.metrics().sy) : this.sel.active.r) : t.r), c: Math.max(0, t.c === undefined ? this.sel.active.c : t.c) };
    if (d.kind === 'select') {
      const point = { r: d.sel === 'cols' ? E.MAX_ROWS - 1 : clampT.r, c: d.sel === 'rows' ? E.MAX_COLS - 1 : clampT.c };
      const g = d.rangeFor(d.anchor, point);
      this.setSelection(d.base.concat([g]), this.sel.active, d.anchor, true);
    } else if (d.kind === 'fill') {
      const s = d.src;
      const dr = clampT.r > s.r2 ? clampT.r - s.r2 : clampT.r < s.r1 ? clampT.r - s.r1 : 0;
      const dc = clampT.c > s.c2 ? clampT.c - s.c2 : clampT.c < s.c1 ? clampT.c - s.c1 : 0;
      if (!dr && !dc) d.dest = null;
      else if (Math.abs(dr) >= Math.abs(dc)) d.dest = dr > 0 ? { r1: s.r1, c1: s.c1, r2: s.r2 + dr, c2: s.c2 } : { r1: s.r1 + dr, c1: s.c1, r2: s.r2, c2: s.c2 };
      else d.dest = dc > 0 ? { r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 + dc } : { r1: s.r1, c1: s.c1 + dc, r2: s.r2, c2: s.c2 };
      this.invalidate();
    } else if (d.kind === 'point') {
      this.pointAt(norm({ r1: d.start.r, c1: d.start.c, r2: clampT.r, c2: clampT.c }));
    }
  }

  /** @param {MouseEvent} _e */
  endDrag(_e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'resize') {
      const map = d.axis === 'col' ? this.sheet.colWidths : this.sheet.rowHeights;
      // put the old size back, then record the change as an undo step
      if (d.start === (d.axis === 'col' ? E.DEFAULT_COL_WIDTH : E.DEFAULT_ROW_HEIGHT)) map.delete(d.idx); else map.set(d.idx, d.start);
      const idxs = this.selectedWhole(d.axis, d.idx);
      this.emit('resize', { axis: d.axis, indexes: idxs, size: Math.round(d.size) });
      return;
    }
    if (d.kind === 'fill' && d.dest) { this.emit('fill', { src: d.src, dest: d.dest }); this.setSelection([d.dest], this.sel.active, this.sel.anchor); return; }
    if (d.kind === 'point') { this.keepEditing = false; this.editor.focus(); return; }
    this.invalidate();
  }

  /** The rows/columns a resize applies to: the whole selected ones, if the dragged one is among them @param {'row' | 'col'} axis @param {number} idx */
  selectedWhole(axis, idx) {
    const out = new Set([idx]);
    for (const g of this.sel.ranges) {
      if (axis === 'col' && g.r1 === 0 && g.r2 >= E.MAX_ROWS - 1 && g.c1 <= idx && idx <= g.c2) for (let c = g.c1; c <= Math.min(g.c2, g.c1 + 1000); c++) out.add(c);
      if (axis === 'row' && g.c1 === 0 && g.c2 >= E.MAX_COLS - 1 && g.r1 <= idx && idx <= g.r2) for (let r = g.r1; r <= Math.min(g.r2, g.r1 + 10000); r++) out.add(r);
    }
    return Array.from(out);
  }

  /** @param {MouseEvent} e */
  onDblClick(e) {
    const t = /** @type {any} */ (this.hit(e));
    if (t.area === 'colResize') { this.emit('autofit', { axis: 'col', indexes: this.selectedWhole('col', /** @type {number} */ (t.c)) }); return; }
    if (t.area === 'rowResize') { this.emit('autofit', { axis: 'row', indexes: this.selectedWhole('row', /** @type {number} */ (t.r)) }); return; }
    if (t.area === 'handle') { this.emit('fillDownToData'); return; }
    if (t.area === 'cell') this.startEdit(null);
  }

  /** @param {MouseEvent} e */
  onContextMenu(e) {
    e.preventDefault();
    const t = this.hit(e);
    if (t.area === 'outside') return;
    this.emit('contextMenu', { area: t.area === 'colHeader' || t.area === 'colResize' ? 'col' : t.area === 'rowHeader' || t.area === 'rowResize' ? 'row' : 'cell', x: e.clientX, y: e.clientY });
  }

  /* ── Selection ─────────────────────────────── */

  /**
   * @param {Range[]} ranges @param {{ r: number, c: number }} active @param {{ r: number, c: number }} [anchor] @param {boolean} [quiet] skip scrolling
   */
  setSelection(ranges, active, anchor, quiet) {
    const sel = this.sel;
    sel.ranges = ranges.map(norm);
    sel.active = { r: active.r, c: active.c };
    sel.anchor = anchor ? { r: anchor.r, c: anchor.c } : { r: active.r, c: active.c };
    this.selectionChanged(!quiet);
  }
  /** @param {number} r @param {number} c @param {boolean} [extend] */
  select(r, c, extend) {
    r = Math.max(0, Math.min(E.MAX_ROWS - 1, r)); c = Math.max(0, Math.min(E.MAX_COLS - 1, c));
    this.ensureExtent(r, c);
    if (extend) {
      const a = this.sel.anchor;
      this.sel.ranges = [norm({ r1: a.r, c1: a.c, r2: r, c2: c })];
      this.selectionChanged(true, { r, c });
    } else this.setSelection([{ r1: r, c1: c, r2: r, c2: c }], { r, c });
  }
  /** @param {boolean} scroll @param {{ r: number, c: number }} [focus] */
  selectionChanged(scroll, focus) {
    if (scroll) this.scrollIntoView(focus ? focus.r : this.sel.active.r, focus ? focus.c : this.sel.active.c);
    this.invalidate();
    this.emit('selection', this.sel);
    this.announceSoon();
  }
  /** @param {number} r @param {number} c */
  scrollIntoView(r, c) {
    const m = this.metrics();
    const z = m.z;
    if (r >= m.fr && r < m.rows.count) {
      const top = m.rows.offset(r) - m.fh, bottom = top + m.rows.size(r);
      const view = m.H - CH - m.fh;
      if (top < m.sy) this.scroller.scrollTop = top * z;
      else if (bottom > m.sy + view) this.scroller.scrollTop = (bottom - view + 2) * z;
    }
    if (c >= m.fc && c < m.cols.count) {
      const left = m.cols.offset(c) - m.fw, right = left + m.cols.size(c);
      const view = m.W - m.RH - m.fw;
      if (left < m.sx) this.scroller.scrollLeft = left * z;
      else if (right > m.sx + view) this.scroller.scrollLeft = Math.min(left, right - view + 2) * z;
    }
  }

  announceSoon() { clearTimeout(this.announceTimer); this.announceTimer = setTimeout(() => this.announce(), 150); }
  announce() {
    if (!this.doc || document.activeElement !== this.scroller) return;
    const a = this.sel.active;
    const cell = this.sheet.get(a.r, a.c);
    const text = cell ? E.formatValue(cell.v, this.wb.styles.get(cell.s).numFmt).text : '';
    const g = this.sel.ranges[0];
    const multi = this.sel.ranges.length > 1 || g.r1 !== g.r2 || g.c1 !== g.c2;
    this.live.textContent = E.a1(a.r, a.c) + (text ? ', ' + text : ', empty') + (cell && cell.f ? ', formula ' + cell.f : '') + (multi ? ', selection ' + this.sel.ranges.map(x => E.rangeA1(x)).join(', ') : '');
  }

  /* ── Keyboard ──────────────────────────────── */

  /** The last filled (or first empty) cell from (r, c) in a direction, like Ctrl+arrow in Excel @param {number} r @param {number} c @param {number} dr @param {number} dc */
  jump(r, c, dr, dc) {
    const s = this.sheet;
    const filled = (/** @type {number} */ rr, /** @type {number} */ cc) => { const cell = s.cells.get(E.keyOf(rr, cc)); return !!cell && cell.v !== null && cell.v !== undefined && cell.v !== ''; };
    const b = s.bounds();
    const limR = dr > 0 ? Math.max(b.maxRow, r) : 0, limC = dc > 0 ? Math.max(b.maxCol, c) : 0;
    let rr = r, cc = c;
    const step = () => { rr += dr; cc += dc; };
    const inside = () => rr >= 0 && cc >= 0 && rr < E.MAX_ROWS && cc < E.MAX_COLS && (dr > 0 ? rr <= limR + 1 : true) && (dc > 0 ? cc <= limC + 1 : true);
    const nextFilled = filled(r + dr, c + dc);
    if (filled(r, c) && nextFilled) {
      // to the end of this block
      while (true) { const nr = rr + dr, nc = cc + dc; if (nr < 0 || nc < 0 || !filled(nr, nc)) break; rr = nr; cc = nc; }
      return { r: rr, c: cc };
    }
    // to the start of the next block, or the edge
    step();
    while (inside() && !filled(rr, cc)) step();
    if (!inside()) return { r: dr > 0 ? (filled(r, c) || nextFilled ? Math.max(r, b.maxRow) : E.MAX_ROWS - 1) : dr < 0 ? 0 : r, c: dc > 0 ? (filled(r, c) ? Math.max(c, b.maxCol) : E.MAX_COLS - 1) : dc < 0 ? 0 : c };
    return { r: rr, c: cc };
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (!this.doc || this.editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const sel = this.sel, a = sel.active;
    const m = this.metrics();
    const pageRows = Math.max(1, Math.floor((m.H - CH - m.fh) / E.DEFAULT_ROW_HEIGHT) - 1);
    const visR = (/** @type {number} */ r, /** @type {number} */ dir) => { const n = m.rows.nextVisible(r, dir); return n < 0 ? Math.max(0, Math.min(r, E.MAX_ROWS - 1)) : n; };
    const visC = (/** @type {number} */ c, /** @type {number} */ dir) => { const n = m.cols.nextVisible(c, dir); return n < 0 ? Math.max(0, Math.min(c, E.MAX_COLS - 1)) : n; };
    // where an extended selection's moving corner is
    const g = sel.ranges[sel.ranges.length - 1];
    const corner = { r: g.r1 === sel.anchor.r ? g.r2 : g.r1, c: g.c1 === sel.anchor.c ? g.c2 : g.c1 };
    const from = e.shiftKey ? corner : a;
    const move = (/** @type {number} */ r, /** @type {number} */ c) => { e.preventDefault(); this.tabStart = null; this.select(r, c, e.shiftKey); };
    switch (e.key) {
      case 'ArrowDown': if (mod) { const j = this.jump(from.r, from.c, 1, 0); return move(j.r, j.c); } return move(visR(Math.min(E.MAX_ROWS - 1, from.r + 1), 1), from.c);
      case 'ArrowUp': if (mod) { const j = this.jump(from.r, from.c, -1, 0); return move(j.r, j.c); } return move(visR(Math.max(0, from.r - 1), -1), from.c);
      case 'ArrowRight': if (mod) { const j = this.jump(from.r, from.c, 0, 1); return move(j.r, j.c); } return move(from.r, visC(Math.min(E.MAX_COLS - 1, from.c + 1), 1));
      case 'ArrowLeft': if (mod) { const j = this.jump(from.r, from.c, 0, -1); return move(j.r, j.c); } return move(from.r, visC(Math.max(0, from.c - 1), -1));
      case 'PageDown': return move(visR(Math.min(E.MAX_ROWS - 1, from.r + pageRows), 1), from.c);
      case 'PageUp': return move(visR(Math.max(0, from.r - pageRows), -1), from.c);
      case 'Home': if (mod) return move(0, 0); return move(from.r, 0);
      case 'End': if (mod) { const b = this.sheet.bounds(); return move(Math.max(0, b.maxRow), Math.max(0, b.maxCol)); } return move(from.r, Math.max(0, this.sheet.bounds().maxCol));
      case 'Tab': case 'Enter': {
        e.preventDefault();
        const back = e.shiftKey;
        const one = sel.ranges.length === 1 && g.r1 === g.r2 && g.c1 === g.c2;
        if (one) {
          const start = this.tabStart;
          if (e.key === 'Tab') { this.select(a.r, visC(Math.max(0, a.c + (back ? -1 : 1)), back ? -1 : 1)); this.tabStart = back ? null : (start === null ? a.c : start); }
          else { this.select(visR(Math.max(0, a.r + (back ? -1 : 1)), back ? -1 : 1), start === null || back ? a.c : start); this.tabStart = null; }
          return;
        }
        // move inside the selection
        let r = a.r, c = a.c;
        if (e.key === 'Tab') { c += back ? -1 : 1; if (c > g.c2) { c = g.c1; r++; } if (c < g.c1) { c = g.c2; r--; } if (r > g.r2) r = g.r1; if (r < g.r1) r = g.r2; }
        else { r += back ? -1 : 1; if (r > g.r2) { r = g.r1; c++; } if (r < g.r1) { r = g.r2; c--; } if (c > g.c2) c = g.c1; if (c < g.c1) c = g.c2; }
        sel.active = { r, c };
        this.selectionChanged(true);
        return;
      }
      case 'F2': e.preventDefault(); this.startEdit(null); return;
      case 'Delete': case 'Backspace': e.preventDefault(); this.emit('clear'); return;
      case 'Escape': if (this.marquee) { this.marquee = null; this.emit('marqueeCleared'); this.invalidate(); } return;
      case ' ':
        if (mod && !e.shiftKey) { e.preventDefault(); this.setSelection([{ r1: 0, c1: g.c1, r2: E.MAX_ROWS - 1, c2: g.c2 }], a, a); return; }
        if (e.shiftKey && !mod) { e.preventDefault(); this.setSelection([{ r1: g.r1, c1: 0, r2: g.r2, c2: E.MAX_COLS - 1 }], a, a); return; }
        break;
      default: break;
    }
    // typing starts editing (replacing the cell's contents)
    if (!mod && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      this.startEdit(e.key);
    }
  }

  /* ── Editing ───────────────────────────────── */

  /** Starts editing the active cell; `initial` replaces its contents (typing), null keeps them (F2) @param {string | null} initial */
  startEdit(initial) {
    if (!this.doc || this.editing) return;
    const a = this.sel.active;
    this.scrollIntoView(a.r, a.c);
    const text0 = this.wb.inputOf(this.sheet, a.r, a.c);
    const text = initial === null ? text0 : initial;
    this.editing = { r: a.r, c: a.c, text0, formula: text.startsWith('='), pointStart: -1, pointEnd: -1 };
    const cell = this.sheet.get(a.r, a.c);
    const st = this.wb.styles.get(cell ? cell.s : undefined);
    this.editor.style.font = this.font(st);
    this.editor.style.fontSize = ((st.size || 11) * PT * this.zoom).toFixed(1) + 'px';
    this.editor.style.textAlign = 'left';
    this.editor.value = text;
    this.editor.hidden = false;
    this.placeEditor();
    this.editor.focus();
    const end = text.length;
    this.editor.setSelectionRange(end, end);
    this.invalidate();
    this.emit('editStart', { text, r: a.r, c: a.c });
  }
  placeEditor() {
    if (!this.editing) return;
    const r = this.cellRect(this.editing.r, this.editing.c);
    const z = this.zoom;
    this.editor.style.left = (r.x * z - 1) + 'px';
    this.editor.style.top = (r.y * z - 1) + 'px';
    this.editor.style.minWidth = (r.w * z + 2) + 'px';
    this.editor.style.minHeight = (r.h * z + 2) + 'px';
    this.fitEditor();
  }
  fitEditor() {
    const ed = this.editor;
    ed.style.width = '0px'; ed.style.height = '0px';
    const maxW = Math.max(120, this.host.clientWidth - parseFloat(ed.style.left || '0') - 8);
    ed.style.width = Math.min(maxW, ed.scrollWidth + 12) + 'px';
    ed.style.height = Math.min(this.host.clientHeight - parseFloat(ed.style.top || '0') - 4, ed.scrollHeight + 2) + 'px';
  }
  /** Text from the formula bar while editing @param {string} text */
  setEditText(text) {
    if (!this.editing) return;
    this.editor.value = text;
    this.editing.formula = text.startsWith('=');
    this.fitEditor();
  }
  /** Whether a click should insert a reference: right after an operator, "(", "," or "=" */
  canPoint() {
    if (!this.editing) return false;
    const ed = this.editor;
    const caret = ed.selectionStart;
    if (this.editing.pointEnd === caret && this.editing.pointStart >= 0) return true;
    const before = ed.value.slice(0, caret).trimEnd();
    return /[=(,+\-*/^&<>:;]$/.test(before) || before === '=';
  }
  /** Inserts (or replaces the last inserted) reference @param {Range} g */
  pointAt(g) {
    if (!this.editing) return;
    const ed = this.editor;
    const ref = g.r1 === g.r2 && g.c1 === g.c2 ? E.a1(g.r1, g.c1) : E.rangeA1(g);
    let start = ed.selectionStart, end = ed.selectionEnd;
    if (this.editing.pointStart >= 0 && this.editing.pointEnd === start) start = this.editing.pointStart;
    ed.value = ed.value.slice(0, start) + ref + ed.value.slice(end);
    this.editing.pointStart = start;
    this.editing.pointEnd = start + ref.length;
    ed.setSelectionRange(this.editing.pointEnd, this.editing.pointEnd);
    this.fitEditor();
    this.emit('editInput', { text: ed.value, caret: this.editing.pointEnd });
  }
  /** @param {KeyboardEvent} e */
  onEditorKey(e) {
    if (!this.editing) return;
    if (this.emitKeyToAutocomplete && this.emitKeyToAutocomplete(e)) return;
    const ed = this.editor;
    if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); return; }
    if (e.key === 'Enter' && (e.altKey || (e.ctrlKey && e.shiftKey))) {
      e.preventDefault();
      const s = ed.selectionStart;
      ed.value = ed.value.slice(0, s) + '\n' + ed.value.slice(ed.selectionEnd);
      ed.setSelectionRange(s + 1, s + 1);
      this.fitEditor();
      this.emit('editInput', { text: ed.value, caret: s + 1 });
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); this.commitEdit(e.ctrlKey || e.metaKey ? 'fillSelection' : e.shiftKey ? 'up' : 'down'); return; }
    if (e.key === 'Tab') { e.preventDefault(); this.commitEdit(e.shiftKey ? 'left' : 'right'); return; }
    // arrows commit and move when the edit started by typing and the caret is at the end (Excel's "Enter" mode)
    if (['ArrowUp', 'ArrowDown'].includes(e.key) && !ed.value.includes('\n') && !this.editing.formula) { e.preventDefault(); this.commitEdit(e.key === 'ArrowUp' ? 'up' : 'down'); return; }
    if (this.editing.pointStart >= 0 && !['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) { this.editing.pointStart = -1; this.editing.pointEnd = -1; }
    if (e.key === 'F4' && this.editing.formula) { e.preventDefault(); this.cycleAbsolute(); }
  }
  /** F4: A1 → $A$1 → A$1 → $A1 → A1 for the reference at the caret */
  cycleAbsolute() {
    const ed = this.editor;
    const caret = ed.selectionStart;
    const text = ed.value;
    const re = /\$?[A-Za-z]{1,3}\$?\d{1,7}/g;
    let m;
    while ((m = re.exec(text))) {
      if (m.index <= caret && caret <= m.index + m[0].length) {
        const p = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(m[0]);
        if (!p) return;
        const state = (p[1] ? 2 : 0) + (p[3] ? 1 : 0);
        const next = { 0: [1, 1], 3: [0, 1], 1: [1, 0], 2: [0, 0] }[state] || [1, 1];
        const rep = (next[0] ? '$' : '') + p[2] + (next[1] ? '$' : '') + p[4];
        ed.value = text.slice(0, m.index) + rep + text.slice(m.index + m[0].length);
        ed.setSelectionRange(m.index + rep.length, m.index + rep.length);
        this.emit('editInput', { text: ed.value, caret: ed.selectionStart });
        return;
      }
    }
  }
  /** @param {'down' | 'up' | 'left' | 'right' | 'fillSelection' | null} move */
  commitEdit(move) {
    if (!this.editing) return;
    const ed = this.editing;
    const text = this.editor.value;
    this.editing = null;
    this.editor.hidden = true;
    this.keepEditing = false;
    this.emit('editEnd', {});
    if (text !== ed.text0 || move === 'fillSelection') this.emit('commit', { r: ed.r, c: ed.c, text, fillSelection: move === 'fillSelection' });
    this.scroller.focus({ preventScroll: true });
    const tabStart = this.tabStart;
    if (move === 'down') this.select(this.metrics().rows.nextVisible(Math.min(E.MAX_ROWS - 1, ed.r + 1), 1), tabStart === null ? ed.c : tabStart);
    else if (move === 'up') this.select(Math.max(0, ed.r - 1), ed.c);
    else if (move === 'right') this.select(ed.r, Math.min(E.MAX_COLS - 1, ed.c + 1));
    else if (move === 'left') this.select(ed.r, Math.max(0, ed.c - 1));
    this.tabStart = move === 'right' ? (tabStart === null ? ed.c : tabStart) : null;
    this.invalidate();
  }
  cancelEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.editor.hidden = true;
    this.keepEditing = false;
    this.emit('editEnd', { cancelled: true });
    this.scroller.focus({ preventScroll: true });
    this.invalidate();
  }

  focus() { if (this.editing) this.editor.focus(); else this.scroller.focus({ preventScroll: true }); }
  setZoom(/** @type {number} */ z) { this.zoom = Math.max(0.5, Math.min(2, z)); if (this.doc) this.doc.view.zoom = this.zoom; this.layout(); if (this.editing) this.placeEditor(); }
}

/** @param {string} hex */
function isDark(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return false;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 70;
}
