// @ts-check
// ── The MetaCode sidebar ──────────────────────────────────────────────────────
//   Assistant     formulas, explanations, insights and cell clean-up, by AI
//   AI Coding     codes a text column with a codebook (the website's prompts)
//   Reliability   agreement between coders (the website's statistics)
//   MetaCode      open and save MetaCode projects
// Anything made by AI is marked in violet and shown as a preview first;
// nothing is written to the sheet until you apply it, and applying is one
// undoable step. Each AI tool says what it sends before it sends it.
import * as E from '../../shared/engine/index.js';
import { h, icon, esc, num } from './util.js';
import { toast, errText, confirm } from './ui.js';
import { currentRegion, looksLikeHeader } from './commands.js';
import * as M from './metacode-data.js';

const { ops } = E;
const sheets = /** @type {any} */ (window).sheets;
/** @typedef {import('./workspace.js').Workspace} Workspace */

const TABS = [['assistant', 'Assistant', 'ai'], ['coding', 'AI Coding', 'ai'], ['reliability', 'Reliability', 'human'], ['metacode', 'MetaCode', 'data']];
const MAX_CONTEXT_CHARS = 40000;

/** CSV-ish text of a block, for AI context (limited) @param {Workspace} ws @param {any} g @param {number} maxRows */
function blockText(ws, g, maxRows) {
  const lines = [];
  const b = ws.sheet.bounds();
  const r2 = Math.min(g.r2, b.maxRow, g.r1 + maxRows - 1), c2 = Math.min(g.c2, b.maxCol, g.c1 + 40);
  let size = 0;
  for (let r = g.r1; r <= r2; r++) {
    const row = [];
    for (let c = g.c1; c <= c2; c++) {
      const cell = ws.sheet.get(r, c);
      const t = cell ? E.formatValue(cell.v, ws.wb.styles.get(cell.s).numFmt).text : '';
      row.push(/[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t);
    }
    const line = row.join(',');
    size += line.length + 1;
    if (size > MAX_CONTEXT_CHARS) { lines.push('… (cut off)'); break; }
    lines.push(line);
  }
  return { text: lines.join('\n'), rows: lines.length, cols: c2 - g.c1 + 1, address: E.rangeA1({ r1: g.r1, c1: g.c1, r2, c2 }) };
}

/** @param {string} text */
function extractJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = Math.min(...['{', '['].map(ch => { const i = s.indexOf(ch); return i < 0 ? Infinity : i; }));
  const z = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (!Number.isFinite(a) || z <= a) throw new Error('The AI\'s answer wasn\'t in the expected format. Try again or rephrase.');
  return JSON.parse(s.slice(a, z + 1));
}

export class Sidebar {
  /** @param {HTMLElement} el @param {Workspace} ws */
  constructor(el, ws) {
    this.el = el;
    this.ws = ws;
    this.tab = 'assistant';
    this.tabsEl = h('div.side-tabs', { role: 'tablist', 'aria-label': 'MetaCode tools' });
    this.body = h('div.side-body', { role: 'tabpanel' });
    el.append(this.tabsEl, this.body);
    for (const [id, label, kind] of TABS) {
      const b = h('button.side-tab', { role: 'tab', class: kind !== 'ai' ? kind : undefined, dataset: { tab: id }, 'aria-selected': 'false' }, label);
      b.onclick = () => this.open(id);
      this.tabsEl.append(b);
    }
    /** @type {any} */
    this.coding = null;
    /** @type {HTMLElement | null} */
    this.formulaTarget = null;
    /** @type {(() => void) | null} */
    this.columnRefresh = null;
    /** @type {any} */
    this.opts = null;
    /** @type {string} */
    this.lastCodebook = '';
    this.render();
  }
  get online() { return this.ws.app.state.status === 'active'; }

  /** @param {string} tab @param {any} [opts] */
  open(tab, opts) {
    if (this.el.hidden) { this.el.hidden = false; sheets.setSettings({ sidebar: true }); this.ws.grid.layout(); this.ws.updateToolbar(); }
    this.tab = tab;
    this.opts = opts || null;
    this.render();
  }
  docChanged() { this.render(); }
  workbookChanged() { /* panels read the sheet when they act */ }
  selectionChanged() {
    if (this.tab === 'reliability' || this.tab === 'coding' || this.tab === 'metacode') this.refreshColumns();
    if (this.formulaTarget && this.formulaTarget.isConnected) { const a = this.ws.sel.active; this.formulaTarget.textContent = 'Describe what to calculate in ' + E.a1(a.r, a.c); }
  }

  render() {
    this.tabsEl.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === this.tab ? 'true' : 'false'));
    this.body.replaceChildren();
    if (!this.ws.doc) return;
    const fn = /** @type {any} */ (this)[this.tab + 'Panel'];
    if (fn) fn.call(this);
  }
  offlineNote() {
    return this.online ? null : h('div.notice.warn', { html: icon('offline') }, h('span', null, this.ws.app.state.status === 'offline' ? 'You\'re working offline. AI tools and MetaCode data need a connection to MetaCode.' : 'AI tools need an active Pro, Max or Ultra plan.'));
  }
  aiHeader(/** @type {string} */ title, /** @type {string} */ sub) {
    return [h('h3', null, title, h('span.ai-label', { html: icon('sparkles') + 'AI' })), h('p', null, sub)];
  }
  async model() { try { return (await sheets.getSettings()).aiModel || undefined; } catch (e) { return undefined; } }
  /** @param {any[]} messages @param {number} [maxTokens] */
  async ask(messages, maxTokens) { return sheets.ai({ messages, model: await this.model(), max_tokens: maxTokens || 1200, temperature: 0.2 }); }

  /* ── Assistant ─────────────────────────────── */

  assistantPanel() {
    const ws = this.ws;
    const b = this.body;
    b.append(...this.aiHeader('AI Assistant', 'Help with formulas and your data from MetaCode\'s AI. Each request counts toward your plan\'s AI requests.'));
    const off = this.offlineNote(); if (off) b.append(off);
    const modes = [['formula', 'Write a formula'], ['explain', 'Explain'], ['insights', 'Find insights'], ['transform', 'Clean / transform'], ['ask', 'Ask']];
    const mode = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'What to do' }, ...modes.map(([v, t]) => h('option', { value: v, selected: this.opts && this.opts.action === v }, t))));
    const area = h('div');
    b.append(h('label.field', null, h('span', null, 'What do you need?'), mode), area);
    const draw = () => {
      area.replaceChildren();
      const m = mode.value;
      if (m === 'formula') this.formulaTool(area);
      else if (m === 'explain') this.explainTool(area);
      else if (m === 'insights') this.insightsTool(area);
      else if (m === 'transform') this.transformTool(area);
      else this.askTool(area);
    };
    mode.onchange = draw;
    draw();
    void ws;
  }

  /** @param {HTMLElement} area */
  formulaTool(area) {
    const ws = this.ws;
    const a = ws.sel.active;
    const q = /** @type {HTMLTextAreaElement} */ (h('textarea.input', { placeholder: 'e.g. the average score for posts by verified authors, or the share of rows marked "yes"', 'aria-label': 'Describe the calculation' }));
    const out = h('div');
    const go = /** @type {HTMLButtonElement} */ (h('button.btn.ai.block', { disabled: !this.online, html: icon('sparkles') + 'Suggest a formula' }));
    this.formulaTarget = h('span', null, 'Describe what to calculate in ' + E.a1(a.r, a.c));
    area.append(h('label.field', null, this.formulaTarget, q),
      h('p.small.muted', null, 'Sends the headers and the first 15 rows around the active cell.'), go, out);
    go.onclick = async () => {
      if (!q.value.trim()) { q.focus(); return; }
      const a = ws.sel.active;
      const region = currentRegion(ws.sheet, a.r, a.c);
      const ctx = blockText(ws, region.r1 === region.r2 && region.c1 === region.c2 ? { r1: 0, c1: 0, r2: 14, c2: 15 } : region, 16);
      go.disabled = true; go.textContent = 'Thinking…';
      out.replaceChildren();
      try {
        const r = await this.ask([
          { role: 'system', content: 'You write spreadsheet formulas for MetaCode Sheets, which uses Excel syntax and these functions: ' + Object.keys(E.FUNCTIONS).sort().join(', ') + '. Reply with JSON only: {"formula":"=...","explanation":"one or two sentences"}. Use A1 references to the data shown; the sheet is named "' + ws.sheet.name + '".' },
          { role: 'user', content: 'The formula goes in cell ' + E.a1(a.r, a.c) + '. Data (' + ctx.address + ', CSV):\n' + ctx.text + '\n\nTask: ' + q.value.trim() }
        ], 600);
        const j = extractJson(r.text);
        let f = String(j.formula || '').trim();
        if (!f.startsWith('=')) f = '=' + f;
        let preview = '';
        try {
          const node = E.parse(f.slice(1));
          const v = E.evaluate(node, { sheet: ws.sheet, r: a.r, c: a.c, sheetByName: n => ws.wb.sheetByName(n), valueAt: (s, rr, cc) => ws.wb.valueAt(/** @type {any} */ (s), rr, cc), now: () => Date.now() });
          const sv = E.RangeRef && v instanceof E.RangeRef ? v.at(0, 0) : v;
          preview = sv instanceof E.CellError ? sv.code + (sv.detail ? ' — ' + sv.detail : '') : E.formatValue(sv, undefined).text;
        } catch (e) { preview = 'This formula can\'t be read: ' + errText(e); }
        out.append(h('div.ai-output', null, h('span.ai-label', { html: icon('sparkles') + 'Suggested by AI — check before using' }), h('div', null, h('code', null, f)), h('div.small', null, String(j.explanation || '')), h('div.small.muted', null, 'Result if inserted: ' + preview)),
          h('div.row', null,
            h('button.btn.primary.small', { onclick: () => { ws.exec(ops.setInputs(ws.wb, ws.sheet, [{ r: a.r, c: a.c, input: f }], 'AI formula')); toast('Inserted into ' + E.a1(a.r, a.c) + ' — Undo removes it.'); } }, 'Insert into ' + E.a1(a.r, a.c)),
            h('button.btn.small', { onclick: () => sheets.writeClipboard({ text: f }) }, 'Copy')));
      } catch (e) { out.append(h('p.error-text', null, errText(e))); }
      go.disabled = !this.online; go.innerHTML = icon('sparkles') + 'Suggest a formula';
    };
  }

  /** @param {HTMLElement} area */
  explainTool(area) {
    const ws = this.ws;
    const out = h('div');
    const go = /** @type {HTMLButtonElement} */ (h('button.btn.ai.block', { disabled: !this.online, html: icon('sparkles') + 'Explain the selection' }));
    area.append(h('p.small.muted', null, 'Explains the active cell\'s formula, or describes the selected cells. Sends the selection (up to 60 rows).'), go, out);
    go.onclick = async () => {
      const a = ws.sel.active;
      const cell = ws.sheet.get(a.r, a.c);
      const g = ws.ranges()[0];
      const ctx = blockText(ws, g, 60);
      go.disabled = true; go.textContent = 'Thinking…';
      out.replaceChildren();
      try {
        const content = cell && cell.f
          ? 'Explain this spreadsheet formula in plain language for a researcher, step by step but briefly. Cell ' + E.a1(a.r, a.c) + ' contains ' + cell.f + ' and currently shows ' + E.formatValue(cell.v, ws.wb.styles.get(cell.s).numFmt).text + '. Nearby data:\n' + blockText(ws, currentRegion(ws.sheet, a.r, a.c), 15).text
          : 'Describe what these spreadsheet cells contain (' + ctx.address + '), what each column seems to mean, and anything notable (blanks, outliers, inconsistent values). Be brief.\n' + ctx.text;
        const r = await this.ask([{ role: 'system', content: 'You help researchers understand spreadsheets. Answer in plain text, under 200 words.' }, { role: 'user', content }], 700);
        out.append(h('div.ai-output', null, h('span.ai-label', { html: icon('sparkles') + 'AI explanation' }), h('div', null, r.text)));
      } catch (e) { out.append(h('p.error-text', null, errText(e))); }
      go.disabled = !this.online; go.innerHTML = icon('sparkles') + 'Explain the selection';
    };
  }

  /** @param {HTMLElement} area */
  insightsTool(area) {
    const ws = this.ws;
    const out = h('div');
    const go = /** @type {HTMLButtonElement} */ (h('button.btn.ai.block', { disabled: !this.online, html: icon('sparkles') + 'Find insights' }));
    area.append(h('p.small.muted', null, 'Looks at the table around the active cell (or the selection): column summaries computed here, plus up to 150 rows sent to the AI.'), go, out);
    go.onclick = async () => {
      const g0 = ws.ranges()[0];
      const g = g0.r1 !== g0.r2 || g0.c1 !== g0.c2 ? g0 : currentRegion(ws.sheet, ws.sel.active.r, ws.sel.active.c);
      const header = looksLikeHeader(ws.wb, ws.sheet, g);
      // summaries computed locally, over all rows
      const b = ws.sheet.bounds();
      const lines = [];
      for (let c = g.c1; c <= Math.min(g.c2, b.maxCol, g.c1 + 30); c++) {
        let n = 0, sum = 0, min = Infinity, max = -Infinity, blanks = 0;
        const uniq = new Set();
        for (let r = g.r1 + (header ? 1 : 0); r <= Math.min(g.r2, b.maxRow); r++) {
          const v = ws.wb.valueAt(ws.sheet, r, c);
          if (v === null || v === '') { blanks++; continue; }
          if (typeof v === 'number') { n++; sum += v; min = Math.min(min, v); max = Math.max(max, v); }
          if (uniq.size < 5000) uniq.add(String(v));
        }
        const name = header ? String(ws.wb.valueAt(ws.sheet, g.r1, c) || E.colName(c)) : E.colName(c);
        lines.push(name + ': ' + (n ? 'numbers=' + n + ', mean=' + num(sum / n) + ', min=' + num(min) + ', max=' + num(max) + ', ' : '') + 'distinct=' + uniq.size + (uniq.size >= 5000 ? '+' : '') + ', blanks=' + blanks);
      }
      const ctx = blockText(ws, g, 150);
      go.disabled = true; go.textContent = 'Thinking…';
      out.replaceChildren();
      try {
        const r = await this.ask([
          { role: 'system', content: 'You are a careful research assistant. Give 3–6 concise, specific observations about the data (patterns, differences, data-quality issues), each one line, and say when something is only suggested by a sample. Don\'t invent numbers that aren\'t in the summaries or data.' },
          { role: 'user', content: 'Column summaries (all ' + (g.r2 - g.r1 + 1) + ' rows):\n' + lines.join('\n') + '\n\nFirst rows (CSV):\n' + ctx.text }
        ], 900);
        out.append(h('div.ai-output', null, h('span.ai-label', { html: icon('sparkles') + 'AI insights — verify before relying on them' }), h('div', null, r.text)),
          h('button.btn.small', { onclick: () => sheets.writeClipboard({ text: r.text }) }, 'Copy'));
      } catch (e) { out.append(h('p.error-text', null, errText(e))); }
      go.disabled = !this.online; go.innerHTML = icon('sparkles') + 'Find insights';
    };
  }

  /** @param {HTMLElement} area */
  transformTool(area) {
    const ws = this.ws;
    const instr = /** @type {HTMLTextAreaElement} */ (h('textarea.input', { placeholder: 'e.g. standardise country names to English · fix capitalisation · extract the hashtag · translate to English', 'aria-label': 'How to change the cells' }));
    const out = h('div');
    const go = /** @type {HTMLButtonElement} */ (h('button.btn.ai.block', { disabled: !this.online, html: icon('sparkles') + 'Preview changes' }));
    area.append(h('label.field', null, h('span', null, 'How should the selected cells change?'), instr),
      h('p.small.muted', null, 'Works on one selected column (up to 1,000 cells, sent in groups of 50). You see every change before anything is written.'), go, out);
    let stop = false;
    go.onclick = async () => {
      const g = ws.oneRange('AI clean-up');
      if (!g) return;
      if (!instr.value.trim()) { instr.focus(); return; }
      if (g.c1 !== g.c2) { toast('Select cells in one column.', { kind: 'error' }); return; }
      const b = ws.sheet.bounds();
      const cells = [];
      for (let r = g.r1; r <= Math.min(g.r2, b.maxRow) && cells.length < 1000; r++) {
        const cell = ws.sheet.get(r, g.c1);
        if (!cell || cell.f || cell.v === null || cell.v === '' || ws.sheet.isRowHidden(r)) continue;
        cells.push({ r, v: cell.v instanceof E.CellError ? cell.v.code : cell.v });
      }
      if (!cells.length) { toast('The selection has no values to change (formulas are left alone).', { kind: 'error' }); return; }
      const ok = await confirm('Send ' + cells.length + ' cells to MetaCode\'s AI?', 'The values in ' + E.rangeA1(g) + ' are sent with your instruction, in ' + Math.ceil(cells.length / 50) + ' request' + (cells.length > 50 ? 's' : '') + '. Nothing changes until you apply the preview.', { ok: 'Send' });
      if (!ok) return;
      stop = false;
      out.replaceChildren();
      const bar = h('div.progress.ai', null, h('div'));
      const stopBtn = h('button.btn.small', { onclick: () => { stop = true; } }, 'Stop');
      out.append(h('div.row', null, h('span.small', null, 'Working…'), h('span.spacer'), stopBtn), bar);
      go.disabled = true;
      /** @type {{ r: number, before: any, after: any }[]} */
      const changes = [];
      let failed = 0;
      for (let i = 0; i < cells.length && !stop; i += 50) {
        const chunk = cells.slice(i, i + 50);
        try {
          const r = await this.ask([
            { role: 'system', content: 'You transform spreadsheet cell values. You get a JSON array of values and an instruction. Reply with ONLY a JSON array of the same length, in the same order, with each transformed value (a string or number). Keep a value unchanged if the instruction doesn\'t apply. Never add commentary.' },
            { role: 'user', content: 'Instruction: ' + instr.value.trim() + '\nValues: ' + JSON.stringify(chunk.map(c => c.v)) }
          ], 3000);
          const arr = extractJson(r.text);
          if (!Array.isArray(arr) || arr.length !== chunk.length) { failed += chunk.length; continue; }
          arr.forEach((v, k) => {
            const nv = typeof v === 'number' || typeof v === 'string' ? v : v === null ? '' : String(v);
            if (String(nv) !== String(chunk[k].v)) changes.push({ r: chunk[k].r, before: chunk[k].v, after: nv });
          });
        } catch (e) { failed += chunk.length; if (/limit|plan|sign in|offline/i.test(errText(e))) { toast(errText(e), { kind: 'error' }); break; } }
        /** @type {HTMLElement} */ (bar.firstElementChild).style.width = Math.round(100 * Math.min(cells.length, i + 50) / cells.length) + '%';
      }
      go.disabled = !this.online;
      out.replaceChildren();
      if (failed) out.append(h('div.notice.warn', null, failed + ' cell' + (failed === 1 ? '' : 's') + ' couldn\'t be processed (the AI\'s answer didn\'t match). They\'re left as they are.'));
      if (!changes.length) { out.append(h('p.muted', null, stop ? 'Stopped. No changes yet.' : 'The AI suggested no changes.')); return; }
      const table = h('table.preview-table', null, h('tr', null, h('th', null, 'Cell'), h('th', null, 'Now'), h('th', null, 'AI suggests')));
      for (const c of changes.slice(0, 300)) table.append(h('tr', null, h('td', null, E.a1(c.r, g.c1)), h('td.old', null, String(c.before)), h('td.changed', null, String(c.after))));
      out.append(h('span.ai-label', { html: icon('sparkles') + changes.length + ' AI-suggested change' + (changes.length === 1 ? '' : 's') }), table,
        changes.length > 300 ? h('p.small.muted', null, 'Showing the first 300.') : '',
        h('div.row', null,
          h('button.btn.primary.small', { onclick: () => {
            // written as values (text stays text — nothing the AI returns becomes a formula)
            ws.exec(ops.setInputs(ws.wb, ws.sheet, changes.map(c => ({ r: c.r, c: g.c1, input: typeof c.after === 'number' ? String(c.after) : "'" + c.after })), 'AI clean-up'));
            toast('Applied ' + changes.length + ' changes — Undo reverses them all.');
            out.replaceChildren();
          } }, 'Apply ' + changes.length + ' change' + (changes.length === 1 ? '' : 's')),
          h('button.btn.small', { onclick: () => out.replaceChildren() }, 'Discard')));
    };
  }

  /** @param {HTMLElement} area */
  askTool(area) {
    const ws = this.ws;
    const q = /** @type {HTMLTextAreaElement} */ (h('textarea.input', { placeholder: 'Ask anything about the selected data or about spreadsheets', 'aria-label': 'Question' }));
    const include = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: true }));
    const out = h('div');
    const go = /** @type {HTMLButtonElement} */ (h('button.btn.ai.block', { disabled: !this.online, html: icon('sparkles') + 'Ask' }));
    area.append(h('label.field', null, h('span', null, 'Your question'), q), h('label.check.small', null, include, 'Include the selected cells (up to 100 rows)'), go, out);
    go.onclick = async () => {
      if (!q.value.trim()) { q.focus(); return; }
      go.disabled = true; go.textContent = 'Thinking…';
      try {
        const ctx = include.checked ? blockText(ws, ws.ranges()[0], 100) : null;
        const r = await this.ask([{ role: 'system', content: 'You help researchers with spreadsheets and data in MetaCode Sheets (Excel-style formulas). Be concise.' },
          { role: 'user', content: (ctx ? 'Selected data (' + ctx.address + ', CSV):\n' + ctx.text + '\n\n' : '') + q.value.trim() }], 1200);
        out.prepend(h('div.ai-output', null, h('span.ai-label', { html: icon('sparkles') + 'AI answer' }), h('div.small.muted', null, q.value.trim()), h('div', null, r.text)));
      } catch (e) { out.prepend(h('p.error-text', null, errText(e))); }
      go.disabled = !this.online; go.innerHTML = icon('sparkles') + 'Ask';
    };
  }

  /* ── AI Coding ─────────────────────────────── */

  /** Header names of the table around the active cell */
  tableInfo() {
    const ws = this.ws;
    const a = ws.sel.active;
    const g = currentRegion(ws.sheet, a.r, a.c);
    const header = looksLikeHeader(ws.wb, ws.sheet, g);
    const names = [];
    for (let c = g.c1; c <= g.c2; c++) names.push({ c, label: E.colName(c) + (header ? ' — ' + String(ws.wb.valueAt(ws.sheet, g.r1, c) || '').slice(0, 40) : '') });
    return { g, header, names };
  }
  refreshColumns() { if (this.columnRefresh) this.columnRefresh(); }

  codingPanel() {
    const ws = this.ws;
    const b = this.body;
    b.append(...this.aiHeader('AI Coding', 'Codes each row\'s text with your codebook using MetaCode\'s AI — the same prompts as AI Coding on the website. Each coded row counts toward your plan\'s AI Coding posts.'));
    const off = this.offlineNote(); if (off) b.append(off);
    const colSel = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Text column' }));
    const tableNote = h('small');
    let info = this.tableInfo();
    const fill = () => {
      info = this.tableInfo();
      colSel.replaceChildren(...info.names.map(n => h('option', { value: String(n.c), selected: n.c === ws.sel.active.c }, n.label)));
      tableNote.textContent = 'Table ' + E.rangeA1(info.g) + (info.header ? ', with a header row' : '') + ' — select a cell in your table to change it.';
    };
    this.columnRefresh = () => { if (!this.coding || !this.coding.running) fill(); };
    fill();
    const fromWb = M.codebookFromWorkbook(ws.wb);
    const cbText = /** @type {HTMLTextAreaElement} */ (h('textarea.input', { 'aria-label': 'Codebook', spellcheck: 'false', placeholder: '# Sentiment\npos = Positive — praise or approval\nneg = Negative — criticism\nneu = Neutral\n\n# Topic\nhealth = Health\npolitics = Politics' }));
    cbText.style.minHeight = '150px';
    cbText.style.fontFamily = 'var(--mono)';
    if (this.lastCodebook) cbText.value = this.lastCodebook;
    else if (fromWb.length) cbText.value = M.codebookText(fromWb);
    const reasoning = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
    const skipCoded = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: true }));
    const loadProject = h('button.btn.small', { disabled: !this.online }, 'Use a MetaCode project\'s codebook…');
    loadProject.onclick = async () => {
      const p = await this.ws.app.pickProject('Choose the project whose codebook to use');
      if (!p) return;
      try { const rec = await sheets.project({ id: p.id }); const cb = (rec.data && rec.data.codebook) || []; if (!cb.length) { toast('That project has no codebook yet.', { kind: 'error' }); return; } cbText.value = M.codebookText(cb); } catch (e) { toast(errText(e), { kind: 'error' }); }
    };
    const out = h('div');
    const run = /** @type {HTMLButtonElement} */ (h('button.btn.ai.block', { disabled: !this.online, html: icon('sparkles') + 'Code rows with AI' }));
    b.append(h('label.field', null, h('span', null, 'Text to code'), colSel, tableNote),
      h('label.field', null, h('span', null, 'Codebook'), cbText, h('small', null, 'One "# Dimension" line, then "code_id = Label — description" lines.')), loadProject,
      h('div.side-section', null, h('label.check.small', null, reasoning, 'Also write the AI\'s reasoning'), h('label.check.small', null, skipCoded, 'Skip rows that already have AI codes')),
      run, out);
    run.onclick = () => this.runCoding(info, Number(colSel.value), cbText.value, reasoning.checked, skipCoded.checked, out, run);
    if (this.coding && this.coding.out) out.append(this.coding.out);
  }

  /**
   * @param {any} info @param {number} col @param {string} text @param {boolean} withReasoning @param {boolean} skipCoded
   * @param {HTMLElement} out @param {HTMLButtonElement} run
   */
  async runCoding(info, col, text, withReasoning, skipCoded, out, run) {
    const ws = this.ws;
    const { codebook, problems } = M.parseCodebookText(text);
    if (problems.length || !codebook.length) { toast(problems[0] || 'Write a codebook first.', { kind: 'error' }); return; }
    this.lastCodebook = text;
    const g = info.g;
    const first = g.r1 + (info.header ? 1 : 0);
    // output columns: right after the table, or the existing "(AI)" columns from an earlier run
    const outCols = /** @type {Record<string, { code: number, conf: number, why: number }>} */ ({});
    let next = g.c2 + 1;
    for (const d of codebook) {
      let found = -1;
      for (let c = g.c1; c <= g.c2; c++) if (String(ws.wb.valueAt(ws.sheet, g.r1, c) || '') === d.name + ' (AI)') found = c;
      if (found >= 0 && info.header) outCols[d.id] = { code: found, conf: found + 1, why: withReasoning ? found + 2 : -1 };
      else { outCols[d.id] = { code: next, conf: next + 1, why: withReasoning ? next + 2 : -1 }; next += withReasoning ? 3 : 2; }
    }
    const rows = [];
    const b = ws.sheet.bounds();
    for (let r = first; r <= Math.min(g.r2, b.maxRow); r++) {
      if (ws.sheet.isRowHidden(r)) continue;
      const cell = ws.sheet.get(r, col);
      const t = cell ? E.formatValue(cell.v, ws.wb.styles.get(cell.s).numFmt).text : '';
      if (!t.trim()) continue;
      if (skipCoded && codebook.every(d => { const v = ws.wb.valueAt(ws.sheet, r, outCols[d.id].code); return v !== null && v !== ''; })) continue;
      rows.push({ r, text: t.slice(0, 8000) });
    }
    if (!rows.length) { toast('No rows to code (empty text, or all already coded).'); return; }
    const limits = this.ws.app.state.limits;
    const ok = await confirm('Code ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' with MetaCode\'s AI?',
      'Each row\'s text from column ' + E.colName(col) + ' is sent with your codebook (' + codebook.length + ' dimension' + (codebook.length === 1 ? '' : 's') + '). This uses ' + rows.length + ' of your plan\'s AI Coding posts' + (limits && limits.aiPostsPerWeek ? ' (' + num(limits.aiPostsPerWeek) + ' a week)' : '') + '. Results appear as a preview; nothing is written until you apply them.', { ok: 'Start coding' });
    if (!ok) return;
    const system = M.buildSystemPrompt(codebook);
    const model = await this.model();
    /** @type {Map<number, any>} */
    const results = new Map();
    let failed = 0, done = 0;
    const jobId = 'c' + Date.now().toString(36);
    const state = { running: true, out: h('div') };
    this.coding = state;
    const bar = h('div.progress.ai', null, h('div'));
    const status = h('span.small', { 'aria-live': 'polite' }, 'Starting…');
    const stopBtn = h('button.btn.small', { onclick: () => { state.running = false; sheets.aiBatchStop({ jobId }); } }, 'Stop');
    state.out.replaceChildren(h('div.row', null, status, h('span.spacer'), stopBtn), bar);
    out.replaceChildren(state.out);
    run.disabled = true;
    const update = () => {
      /** @type {HTMLElement} */ (bar.firstElementChild).style.width = Math.round(100 * (done + failed) / rows.length) + '%';
      status.textContent = done + ' coded' + (failed ? ', ' + failed + ' failed' : '') + ' of ' + rows.length;
    };
    const offLine = sheets.on('ai:batchLine', (/** @type {any} */ msg) => {
      if (msg.jobId !== jobId) return;
      const line = msg.line;
      if (line.notice) { status.textContent = line.notice.message + ' — pausing ' + line.notice.waitSeconds + ' s…'; return; }
      if (line.done) return;
      if (line.ok) {
        const c = line.data && line.data.choices && line.data.choices[0];
        try { results.set(Number(line.id), M.validCodings(M.parseCodings(String((c && c.message && c.message.content) || '')), codebook)); done++; }
        catch (e) { failed++; }
      } else { failed++; if (line.error && line.error.type === 'limit_reached') status.textContent = line.error.message; }
      update();
    });
    try {
      for (let i = 0; i < rows.length && state.running; i += 200) {
        const chunk = rows.slice(i, i + 200);
        await sheets.aiBatchStart({ jobId, parallel: 4, requests: chunk.map(x => ({ id: x.r, body: Object.assign({ messages: [{ role: 'system', content: system }, { role: 'user', content: M.buildUserMessage({ text: x.text }) }], max_tokens: 1000, temperature: 0.1 }, model ? { model } : {}) })) });
      }
    } catch (e) { toast(errText(e), { kind: 'error' }); }
    finally { offLine(); state.running = false; run.disabled = !this.online; }
    // preview, then write as one step
    if (!results.size) { state.out.replaceChildren(h('p.muted', null, failed ? 'No rows could be coded (' + failed + ' failed).' : 'Stopped before any rows were coded.')); return; }
    const sample = Array.from(results.entries()).slice(0, 15);
    const table = h('table.preview-table', null, h('tr', null, h('th', null, 'Row'), ...codebook.map(d => h('th', null, d.name))));
    for (const [r, cod] of sample) table.append(h('tr', null, h('td', null, String(r + 1)), ...codebook.map(d => h('td.changed', { title: cod[d.id].reasoning }, (cod[d.id].code || '—') + (cod[d.id].confidence !== null ? ' (' + Math.round(cod[d.id].confidence * 100) + '%)' : '')))));
    const firstCol = Math.min(...Object.values(outCols).map(o => o.code)), lastCol = Math.max(...Object.values(outCols).map(o => Math.max(o.conf, o.why)));
    state.out.replaceChildren(
      h('span.ai-label', { html: icon('sparkles') + results.size + ' rows coded by AI' + (failed ? ' · ' + failed + ' failed' : '') }), table,
      h('p.small.muted', null, 'Answers outside the codebook are left blank. Columns ' + E.colName(firstCol) + '–' + E.colName(lastCol) + ' will be written' + (info.header ? ', with headers' : '') + '.'),
      h('div.row', null,
        h('button.btn.primary.small', { onclick: () => {
          const entries = [];
          if (info.header) for (const d of codebook) {
            const o = outCols[d.id];
            entries.push({ r: g.r1, c: o.code, input: "'" + d.name + ' (AI)' }, { r: g.r1, c: o.conf, input: "'" + d.name + ' (AI confidence)' });
            if (o.why >= 0) entries.push({ r: g.r1, c: o.why, input: "'" + d.name + ' (AI reasoning)' });
          }
          for (const [r, cod] of results) for (const d of codebook) {
            const o = outCols[d.id], x = cod[d.id];
            entries.push({ r, c: o.code, input: x.code === null ? '' : "'" + x.code });
            entries.push({ r, c: o.conf, input: x.confidence === null ? '' : String(x.confidence) });
            if (o.why >= 0) entries.push({ r, c: o.why, input: x.reasoning ? "'" + x.reasoning : '' });
          }
          ws.exec(ops.setInputs(ws.wb, ws.sheet, entries, 'AI Coding'));
          toast('Wrote ' + results.size + ' rows of AI codes — Undo removes them.');
          state.out.replaceChildren();
          this.coding = null;
        } }, 'Write ' + results.size + ' rows to the sheet'),
        h('button.btn.small', { onclick: () => { state.out.replaceChildren(); this.coding = null; } }, 'Discard')));
  }

  /* ── Reliability ───────────────────────────── */

  reliabilityPanel() {
    const ws = this.ws;
    const b = this.body;
    const RS = /** @type {any} */ (window).ReliabilityStats;
    b.append(h('h3', null, 'Intercoder reliability', h('span.badge.ok', null, 'Your codes')), h('p', null, 'Agreement between coders, computed on this computer with the same statistics as MetaCode\'s Reliability page. Rows are coding units; choose one column per coder.'));
    const pick = () => /** @type {HTMLSelectElement} */ (h('select.input'));
    const c1 = pick(), c2 = pick();
    const more = /** @type {HTMLSelectElement} */ (h('select.input', { multiple: true, size: 3, 'aria-label': 'More coders (for Krippendorff\'s α)' }));
    const level = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Level of measurement' }, ...['nominal', 'ordinal', 'interval', 'ratio'].map(l => h('option', { value: l }, l[0].toUpperCase() + l.slice(1)))));
    const scheme = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Weights' }, h('option', { value: 'linear' }, 'Linear'), h('option', { value: 'quadratic' }, 'Quadratic')));
    const note = h('small');
    let info = this.tableInfo();
    const fill = () => {
      info = this.tableInfo();
      const opts = (/** @type {number} */ sel) => info.names.map(n => h('option', { value: String(n.c), selected: n.c === sel }, n.label));
      const a = ws.sel.active.c;
      c1.replaceChildren(...opts(a)); c2.replaceChildren(...opts(Math.min(info.g.c2, a + 1)));
      more.replaceChildren(...info.names.map(n => h('option', { value: String(n.c) }, n.label)));
      note.textContent = 'Table ' + E.rangeA1(info.g) + (info.header ? ' (header row skipped)' : '') + '.';
    };
    this.columnRefresh = fill;
    fill();
    const out = h('div');
    const go = h('button.btn.primary.block', null, 'Calculate');
    b.append(h('label.field', null, h('span', null, 'Coder 1'), c1), h('label.field', null, h('span', null, 'Coder 2'), c2),
      h('label.field', null, h('span', null, 'More coders (optional, for α)'), more, note),
      h('div.row', null, h('label.field', null, h('span', null, 'Level (for α)'), level), h('label.field', null, h('span', null, 'Weights (for weighted κ)'), scheme)), go, out);
    go.onclick = () => {
      if (!RS) { out.replaceChildren(h('p.error-text', null, 'The reliability statistics aren\'t loaded.')); return; }
      const g = info.g, first = g.r1 + (info.header ? 1 : 0), last = Math.min(g.r2, ws.sheet.bounds().maxRow);
      const val = (/** @type {number} */ r, /** @type {number} */ c) => { const v = ws.wb.valueAt(ws.sheet, r, c); return v === null || v === '' || v instanceof E.CellError ? null : typeof v === 'number' ? v : String(v).trim(); };
      const a = Number(c1.value), bcol = Number(c2.value);
      if (a === bcol) { out.replaceChildren(h('p.error-text', null, 'Choose two different columns.')); return; }
      const extra = Array.from(more.selectedOptions).map(o => Number(o.value)).filter(c => c !== a && c !== bcol);
      const pairs = [], units = [];
      for (let r = first; r <= last; r++) {
        const x = val(r, a), y = val(r, bcol);
        pairs.push({ a: x, b: y });
        units.push([x, y, ...extra.map(c => val(r, c))].filter(v => v !== null));
      }
      const ordered = Array.from(new Set(pairs.flatMap(p => [p.a, p.b]).filter(v => v !== null))).sort((p, q) => (typeof p === 'number' && typeof q === 'number' ? p - q : String(p).localeCompare(String(q), undefined, { numeric: true })));
      const pa = RS.percentAgreement(pairs), ck = RS.cohenKappa(pairs), wk = RS.weightedKappa(pairs, ordered, scheme.value);
      let ka;
      try { ka = RS.krippendorffAlpha(level.value === 'interval' || level.value === 'ratio' ? units.map(u => u.map(Number)) : units, level.value, ordered); } catch (e) { ka = { value: null, reason: errText(e) }; }
      const row = (/** @type {string} */ name, /** @type {any} */ res, /** @type {boolean} */ pct) => [h('span', null, name), h('b', { title: res.value === null ? res.reason || '' : RS.interpret(res.value) }, res.value === null ? 'n/a' : pct ? (res.value * 100).toFixed(1) + '%' : res.value.toFixed(3) + ' · ' + RS.interpret(res.value))];
      const n = pairs.filter(p => p.a !== null && p.b !== null).length;
      const result = h('div', null,
        h('div.kv', null, ...row('Percent agreement', pa, true), ...row('Cohen\'s κ', ck, false), ...row('Weighted κ (' + scheme.value + ')', wk, false), ...row('Krippendorff\'s α (' + level.value + ', ' + (2 + extra.length) + ' coders)', ka, false)),
        h('p.small.muted', null, n + ' units coded by both coders' + (pairs.length - n ? '; ' + (pairs.length - n) + ' with a missing code were left out of the pairwise statistics' : '') + '. Labels follow Landis & Koch (1977) — a convention, not a test.'));
      const insert = h('button.btn.small', null, 'Insert as formulas');
      insert.onclick = () => {
        const g2 = info.g;
        const at = { r: g2.r1, c: ws.sheet.bounds().maxCol + 2 };
        const rng = (/** @type {number} */ c) => E.rangeA1({ r1: first, c1: c, r2: last, c2: c });
        const allCols = [a, bcol, ...extra];
        const contiguous = allCols.slice().sort((x, y) => x - y).every((c, i, arr) => i === 0 || c === arr[i - 1] + 1);
        const entries = [
          { r: at.r, c: at.c, input: "'Reliability (" + E.colName(a) + ' vs ' + E.colName(bcol) + ')' },
          { r: at.r + 1, c: at.c, input: "'Percent agreement" }, { r: at.r + 1, c: at.c + 1, input: '=PERCENTAGREEMENT(' + rng(a) + ',' + rng(bcol) + ')' },
          { r: at.r + 2, c: at.c, input: "'Cohen's kappa" }, { r: at.r + 2, c: at.c + 1, input: '=COHENKAPPA(' + rng(a) + ',' + rng(bcol) + ')' },
          { r: at.r + 3, c: at.c, input: "'Weighted kappa (" + scheme.value + ')' }, { r: at.r + 3, c: at.c + 1, input: '=WEIGHTEDKAPPA(' + rng(a) + ',' + rng(bcol) + ',"' + scheme.value + '")' }
        ];
        if (contiguous) entries.push({ r: at.r + 4, c: at.c, input: "'Krippendorff's alpha (" + level.value + ')' }, { r: at.r + 4, c: at.c + 1, input: '=KRIPPENDORFF(' + E.rangeA1({ r1: first, c1: Math.min(...allCols), r2: last, c2: Math.max(...allCols) }) + ',"' + level.value + '")' });
        ws.exec(ops.setInputs(ws.wb, ws.sheet, entries, 'Insert reliability'));
        ws.grid.ensureExtent(at.r + 4, at.c + 1);
        ws.grid.setSelection([{ r1: at.r, c1: at.c, r2: at.r + 4, c2: at.c + 1 }], { r: at.r, c: at.c });
        toast('Inserted live formulas in ' + E.colName(at.c) + (at.r + 1) + ' — they update when codes change.');
      };
      out.replaceChildren(result, h('div.row', null, insert));
    };
  }

  /* ── MetaCode projects ─────────────────────── */

  metacodePanel() {
    const ws = this.ws;
    const b = this.body;
    b.append(h('h3', null, 'MetaCode projects', h('span.badge', null, 'Your account')), h('p', null, 'Open a project from your MetaCode account as a workbook, or turn a sheet of posts into a new project you can code on the website.'));
    const off = this.offlineNote(); if (off) b.append(off);
    b.append(h('div.row.wrap', null,
      h('button.btn.small', { disabled: !this.online, onclick: () => ws.app.openProjectPicker() }, 'Open a project…'),
      h('button.btn.small', { disabled: !this.online, onclick: () => ws.app.scraperPicker() }, 'Import scraper results…')));
    const src = ws.wb.meta && ws.wb.meta.metacodeProject;
    if (src) b.append(h('div.notice', null, h('span', null, 'This workbook came from the project "' + src.name + '". Saving it as a project creates a new one; the original isn\'t changed.')));
    b.append(h('div.side-section', null, h('h3', null, 'Save this sheet as a new project')));
    const name = /** @type {HTMLInputElement} */ (h('input.input', { value: ws.doc.name, 'aria-label': 'Project name' }));
    const selects = /** @type {Record<string, HTMLSelectElement>} */ ({});
    const roles = [['text', 'Post text (required)', /^(text|body|selftext|full_text|content|message|post)$/i], ['id', 'ID', /^(id|post_id|tweet_id)$/i], ['author', 'Author', /^(author|user|username|screen_name|channel)$/i],
      ['timestamp', 'Date', /^(timestamp|date|created_at|created_utc|published_at|time)$/i], ['likes', 'Likes', /^(likes?|like_count|score|ups|favorite_count)$/i], ['shares', 'Shares', /^(shares?|retweets?|retweet_count|share_count)$/i],
      ['comments', 'Comments', /^(comments?|num_comments|reply_count|replies)$/i], ['views', 'Views', /^(views?|view_count|impressions)$/i]];
    const fields = h('div');
    let info = this.tableInfo();
    const fill = () => {
      info = this.tableInfo();
      const headers = info.names.map(n => n.label.replace(/^[A-Z]+ — /, ''));
      fields.replaceChildren();
      for (const [role, label, re] of roles) {
        const s = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': /** @type {string} */ (label) }, h('option', { value: '-1' }, role === 'text' ? 'Choose a column' : '(none)'), ...info.names.map(n => h('option', { value: String(n.c) }, n.label))));
        const guess = info.header ? M.guessColumn(headers, /** @type {RegExp} */ (re)) : -1;
        if (guess >= 0) s.value = String(info.names[guess].c);
        selects[/** @type {string} */ (role)] = s;
        fields.append(h('label.field', null, h('span', null, /** @type {string} */ (label)), s));
      }
    };
    this.columnRefresh = fill;
    fill();
    const save = /** @type {HTMLButtonElement} */ (h('button.btn.primary.block', { disabled: !this.online }, 'Save to my MetaCode account'));
    save.onclick = async () => {
      const text = Number(selects.text.value);
      if (text < 0) { toast('Choose the column with the post text.', { kind: 'error' }); return; }
      const map = /** @type {any} */ ({});
      for (const [role] of roles) { const v = Number(selects[/** @type {string} */ (role)].value); if (v >= 0) map[/** @type {string} */ (role)] = v; }
      const g = info.g;
      const posts = M.postsFromSheet(ws.wb, ws.sheet, { r1: g.r1 + (info.header ? 1 : 0), r2: Math.min(g.r2, ws.sheet.bounds().maxRow) }, map);
      if (!posts.length) { toast('No rows with text to save.', { kind: 'error' }); return; }
      const codebook = M.codebookFromWorkbook(ws.wb);
      const ok = await confirm('Save ' + posts.length + ' posts as a new project?', 'A new project "' + (name.value.trim() || ws.doc.name) + '" is added to your MetaCode account' + (codebook.length ? ', with the codebook from this workbook\'s "Codebook" sheet' : '') + '. It appears under Projects on the website.', { ok: 'Save project' });
      if (!ok) return;
      save.disabled = true; save.textContent = 'Saving…';
      try {
        const pname = (name.value.trim() || ws.doc.name).slice(0, 300);
        const r = await sheets.createProject({ project: { name: pname, description: 'Created in MetaCode Sheets from "' + ws.doc.name + '".', data: { project: { name: pname, description: '' }, posts, codebook, network: { nodes: [], edges: [] }, networkAnalysis: null } } });
        toast('Saved "' + r.name + '" to your MetaCode account.', { kind: 'ok' });
      } catch (e) { toast(errText(e), { kind: 'error' }); }
      save.disabled = !this.online; save.textContent = 'Save to my MetaCode account';
    };
    b.append(h('label.field', null, h('span', null, 'Project name'), name), fields, save);
  }
}

export { esc };
