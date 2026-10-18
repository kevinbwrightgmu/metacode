// @ts-check
// ── MetaCode Sheets: the window ───────────────────────────────────────────────
// Shows the sign-in / upgrade screens until the main process says the account
// may use the app, then the home screen and the open workbooks (as tabs).
// When access ends (signed out, plan changed, offline access ran out) the
// workbooks' unsaved changes are kept in the recovery folder and the window
// locks; it comes back as it was once access is confirmed again.
import * as E from '../../shared/engine/index.js';
import { sheetToCsv } from '../../shared/io/csv.js';
import { h, icon, debounce } from './util.js';
import { dialog, confirm, prompt, toast, errText, showMenu, closeMenu } from './ui.js';
import { renderAccess } from './access.js';
import { renderHome } from './home.js';
import { Workspace } from './workspace.js';
import { Doc } from './doc.js';
import { COMMANDS, commandFor } from './commands.js';
import * as io from './io.js';
import * as M from './metacode-data.js';
import * as D from './dialogs.js';

const sheets = /** @type {any} */ (window).sheets;
const isMac = sheets.platform === 'darwin';
/** Commands that also work on the home screen */
const APP_COMMANDS = new Set(['new', 'open', 'home', 'import', 'settings', 'about', 'account', 'upgrade', 'website', 'shortcuts', 'functionsHelp', 'themeSystem', 'themeLight', 'themeDark', 'openProject', 'scraperImport']);

class App {
  constructor() {
    /** @type {any} */
    this.state = { status: 'starting' };
    /** @type {any} */
    this.info = {};
    /** @type {any} */
    this.settings = {};
    /** @type {Doc[]} */
    this.docs = [];
    /** @type {Doc | null} */
    this.current = null;
    this.autosave = true;
    /** the account the open workbooks belong to */
    this.owner = null;
    this.els = {
      access: /** @type {HTMLElement} */ (document.getElementById('access')),
      shell: /** @type {HTMLElement} */ (document.getElementById('shell')),
      tabs: /** @type {HTMLElement} */ (document.getElementById('doc-tabs')),
      home: /** @type {HTMLElement} */ (document.getElementById('home')),
      workbook: /** @type {HTMLElement} */ (document.getElementById('workbook'))
    };
    /** @type {Map<Doc, any>} */
    this.saveTimers = new Map();
    this.ws = /** @type {Workspace} */ (/** @type {any} */ (null));
    /** @type {string[]} */
    this.pendingFiles = [];
  }

  async boot() {
    this.info = await sheets.appInfo();
    this.applySettings(await sheets.getSettings());
    this.ws = new Workspace(this.els.workbook, this);
    sheets.on('auth:changed', (/** @type {any} */ s) => this.setState(s));
    sheets.on('auth:linkError', (/** @type {any} */ e) => toast(e.message, { kind: 'error' }));
    sheets.on('menu:command', (/** @type {any} */ m) => this.command(m.cmd));
    // files opened from the system (double-click, command line) wait until access is confirmed
    sheets.on('app:openFile', (/** @type {any} */ f) => { if (this.unlocked()) this.openAny(f.path); else this.pendingFiles.push(f.path); });
    sheets.on('app:beforeQuit', () => this.beforeQuit());
    sheets.on('theme:changed', (/** @type {any} */ t) => this.applyTheme(!!t.dark));
    this.applyTheme(!!this.info.dark);
    window.addEventListener('keydown', e => {
      if (e.defaultPrevented) return;
      const cmd = commandFor(e, isMac);
      if (!cmd) return;
      if (document.querySelector('.backdrop') && !['save', 'saveAs'].includes(cmd)) return;   // a dialog is open
      e.preventDefault();
      this.command(cmd);
    });
    window.addEventListener('online', () => sheets.recheck().catch(() => {}));
    window.addEventListener('focus', () => this.checkFilesOnDisk());
    setInterval(() => { for (const d of this.docs) d.snapshotForRecovery(); }, 5000);
    this.setState(await sheets.authState());
    sheets.ready();          // listening: the main process may now send files and sign-in links
  }

  /** @param {any} s */
  applySettings(s) {
    this.settings = s;
    this.autosave = s.autosave !== false;
    if (this.ws) { this.ws.grid.gridlines = s.gridlines !== false; this.ws.grid.invalidate(); }
  }
  /** @param {string} theme */
  async setTheme(theme) { await sheets.setSettings({ theme }); this.applySettings(await sheets.getSettings()); }
  /** Light or dark, as the main process decides (system setting or View › Theme) @param {boolean} dark */
  applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (this.ws) { this.ws.grid.colors = this.ws.grid.readColors(); this.ws.grid.invalidate(); }
  }

  unlocked() { return this.state.status === 'active' || this.state.status === 'offline'; }

  /** @param {any} s */
  setState(s) {
    const was = this.unlocked();
    this.state = s;
    const now = this.unlocked();
    if (!now) {
      // keep unsaved work, then lock
      for (const d of this.docs) d.snapshotForRecovery();
      closeMenu();
      document.getElementById('overlays')?.replaceChildren();
      this.els.shell.hidden = true;
      this.els.access.hidden = false;
      renderAccess(this.els.access, s, { info: this.info, onRecheck: () => {} });
      return;
    }
    // another account signed in: its work isn't the previous account's
    const uid = s.user && s.user.id ? s.user.id : null;
    if (this.owner && uid && this.owner !== uid) { for (const d of this.docs.slice()) this.dropDoc(d); this.current = null; }
    if (uid) this.owner = uid;
    this.els.access.hidden = true;
    this.els.shell.hidden = false;
    if (!was) { if (this.current) this.showDoc(this.current); else this.showHome(); }
    else { this.renderTabs(); if (this.current) { this.ws.updateStatus(); this.ws.sidebar.render(); } else this.showHome(); }
    while (this.pendingFiles.length) this.openAny(/** @type {string} */ (this.pendingFiles.shift()));
  }

  /* ── Tabs ──────────────────────────────────── */

  renderTabs() {
    const bar = this.els.tabs;
    bar.replaceChildren();
    const home = h('button.doc-tab.home-tab', { role: 'tab', 'aria-selected': this.current ? 'false' : 'true', title: 'Home', html: icon('home') }, h('span.name', null, 'Home'));
    home.onclick = () => this.showHome();
    bar.append(home);
    for (const d of this.docs) {
      const tab = h('div.doc-tab', { role: 'tab', tabindex: '0', 'aria-selected': d === this.current ? 'true' : 'false', title: d.path || d.name });
      if (d.dirty || d.saveState === 'conflict' || d.saveState === 'error') tab.append(h('span.dot', { title: 'Unsaved changes' }));
      tab.append(h('span.name', null, d.name));
      const close = h('button.close', { 'aria-label': 'Close ' + d.name, html: icon('x') });
      close.onclick = (e) => { e.stopPropagation(); this.closeDoc(d); };
      tab.append(close);
      tab.onclick = () => this.showDoc(d);
      tab.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.showDoc(d); } };
      tab.onauxclick = (e) => { if (e.button === 1) this.closeDoc(d); };
      bar.append(tab);
    }
    bar.append(h('button.new-tab', { 'aria-label': 'New workbook', title: 'New workbook', html: icon('plus'), onclick: () => this.newWorkbook() }));
    if (this.current) sheets.windowState({ title: this.current.name, dirty: this.current.dirty, path: this.current.path || undefined }).catch(() => {});
    else sheets.windowState({ title: '' }).catch(() => {});
  }

  showHome() {
    if (this.ws && this.ws.grid.editing) this.ws.grid.commitEdit(null);
    this.current = null;
    this.els.workbook.hidden = true;
    this.els.home.hidden = false;
    this.ws.setDoc(null);
    this.renderTabs();
    renderHome(this.els.home, { app: this });
  }
  /** @param {Doc} doc */
  showDoc(doc) {
    if (this.ws.grid.editing && this.current !== doc) this.ws.grid.commitEdit(null);
    this.current = doc;
    this.els.home.hidden = true;
    this.els.workbook.hidden = false;
    this.ws.setDoc(doc);
    this.renderTabs();
  }
  /** @param {Doc} doc */
  addDoc(doc) {
    this.docs.push(doc);
    doc.onState(() => { this.renderTabs(); this.scheduleSave(doc); });
    this.showDoc(doc);
    return doc;
  }
  /** @param {Doc} doc */
  dropDoc(doc) {
    const t = this.saveTimers.get(doc);
    if (t) { t.cancel(); this.saveTimers.delete(doc); }
    this.docs = this.docs.filter(d => d !== doc);
    doc.dispose();
  }

  /** AutoSave: a few seconds after the last change @param {Doc} doc */
  scheduleSave(doc) {
    if (!this.autosave || !doc.path || !doc.dirty || doc.conflict || doc.saveState === 'saving') return;
    let t = this.saveTimers.get(doc);
    if (!t) {
      t = debounce(async () => {
        if (!this.docs.includes(doc) || !doc.dirty) return;
        const r = await doc.save({ auto: true });
        if (r === 'conflict' && this.current === doc) this.ws.renderBanner();
      }, doc.wb.sheets.reduce((n, s) => n + s.cells.size, 0) > 500000 ? 10000 : 2500);
      this.saveTimers.set(doc, t);
    }
    t();
  }

  /* ── Commands ──────────────────────────────── */

  /** @param {string} cmd */
  command(cmd) {
    if (!this.unlocked()) return;
    if (document.querySelector('.backdrop') && !['save', 'saveAs'].includes(cmd)) return;
    if (this.current) { this.ws.run(cmd); return; }
    if (APP_COMMANDS.has(cmd) && COMMANDS[cmd]) {
      try { const out = COMMANDS[cmd](this.ws); if (out && out.catch) out.catch((/** @type {any} */ e) => toast(errText(e), { kind: 'error' })); } catch (e) { toast(errText(e), { kind: 'error' }); }
    }
  }

  /* ── Workbooks ─────────────────────────────── */

  async newWorkbook() {
    const wb = E.newWorkbook('Untitled spreadsheet');
    try {
      const r = await sheets.createWorkbook({ name: 'Untitled spreadsheet', text: E.serialize(wb) });
      wb.name = r.name;
      this.addDoc(new Doc(wb, { path: r.path, stat: r.stat, name: r.name }));
    } catch (e) { toast(errText(e), { kind: 'error' }); }
  }
  async openDialog() {
    const r = await sheets.openDialog();
    if (r) await this.openAny(r.path);
  }
  /** @param {string} path */
  async openAny(path) {
    if (/\.mcsheet$/i.test(path)) return this.openPath(path);
    try { const f = await sheets.readBytes({ path }); await this.importBytes(f.bytes, f.name); } catch (e) { toast(errText(e), { kind: 'error' }); }
  }
  /** @param {string} path */
  async openPath(path) {
    const open = this.docs.find(d => d.path === path);
    if (open) { this.showDoc(open); return; }
    try {
      const f = await sheets.readWorkbook({ path });
      const t0 = performance.now();
      const wb = E.parseFile(f.text);
      const ms = performance.now() - t0;
      const doc = this.addDoc(new Doc(wb, { path: f.path, stat: f.stat, name: f.name }));
      if (ms > 1500) toast('Opened "' + doc.name + '" in ' + (ms / 1000).toFixed(1) + ' s.');
    } catch (e) { toast('Couldn\'t open the workbook: ' + errText(e), { kind: 'error' }); }
  }
  async importDialog() {
    const f = await sheets.importDialog();
    if (f) await this.importBytes(f.bytes, f.name);
  }
  /** Converts an .xlsx / .csv into a workbook in the library @param {Uint8Array} bytes @param {string} name */
  async importBytes(bytes, name) {
    const bar = h('div.progress', null, h('div'));
    const msg = h('p.small.muted', null, 'Reading "' + name + '"…');
    let closeProgress = () => {};
    const shown = dialog({ title: 'Importing', body: [msg, bar], onOpen: (_el, done) => { closeProgress = () => done(null); } });
    void shown;
    try {
      const r = await io.importFile(bytes, name, { onProgress: (f, m) => { /** @type {HTMLElement} */ (bar.firstElementChild).style.width = Math.round(f * 100) + '%'; msg.textContent = m; } });
      const wb = E.parseFile(r.text);
      const base = String(r.name || name.replace(/\.[^.]+$/, '')) || 'Imported';
      wb.name = base;
      const notes = r.notes.slice();
      if (r.extra && r.extra.delimiter) notes.unshift('Imported ' + r.extra.rows + ' rows (' + (r.extra.delimiter === '\t' ? 'tab' : '"' + r.extra.delimiter + '"') + '-separated, ' + r.extra.encoding + '). Long ID numbers, leading zeros and anything starting with "=" were kept as text.');
      const saved = await sheets.createWorkbook({ name: base, text: E.serialize(wb) });
      wb.name = saved.name;
      closeProgress();
      this.addDoc(new Doc(wb, { path: saved.path, stat: saved.stat, name: saved.name, notes }));
      toast('Imported "' + name + '" — saved as "' + saved.name + '" in your library. The original file is unchanged.');
    } catch (e) {
      closeProgress();
      toast('Couldn\'t import "' + name + '": ' + errText(e), { kind: 'error' });
    }
  }
  /** @param {Doc} doc */
  async saveDoc(doc) {
    const r = await doc.save();
    if (r === 'saved') toast('Saved "' + doc.name + '".', { ms: 1500 });
    else if (r === 'error') toast('Couldn\'t save: ' + doc.saveError, { kind: 'error' });
    else if (r === 'conflict') this.ws.renderBanner();
    this.renderTabs();
  }
  /** @param {Doc} doc */
  async renameDoc(doc) {
    const name = await prompt('Rename workbook', 'Name', doc.name, { ok: 'Rename' });
    if (!name || name === doc.name) return;
    try {
      if (doc.path) { const r = await sheets.renameWorkbook({ path: doc.path, name }); doc.path = r.path; doc.name = r.name; doc.stat = r.stat; }
      else doc.name = name;
      doc.wb.name = doc.name;
      this.renderTabs();
    } catch (e) { toast(errText(e), { kind: 'error' }); }
  }
  /** @param {string} from @param {string} to @param {string} name */
  pathRenamed(from, to, name) {
    const d = this.docs.find(x => x.path === from);
    if (!d) return;
    d.path = to; d.name = name; d.wb.name = name;
    sheets.changedOnDisk({ path: to, expected: null }).then((/** @type {any} */ r) => { if (r.stat) d.stat = r.stat; }).catch(() => {});
    this.renderTabs();
  }
  /** @param {Doc} doc */
  async duplicateDoc(doc) {
    if (doc.dirty || !doc.path) { const r = await doc.save(); if (r !== 'saved') return; }
    try { const r = await sheets.duplicateWorkbook({ path: doc.path }); await this.openPath(r.path); } catch (e) { toast(errText(e), { kind: 'error' }); }
  }
  /** @param {Doc} doc */
  async exportXlsx(doc) {
    if (this.ws.grid.editing) this.ws.grid.commitEdit(null);
    try {
      const r = await io.exportXlsx(doc.serialize());
      const saved = await sheets.exportDialog({ suggestedName: doc.name, kind: 'xlsx', data: r.bytes });
      if (saved) toast('Exported to ' + saved.path + (r.notes.length ? ' — ' + r.notes.join(' ') : ''), { ms: r.notes.length ? 9000 : 4000 });
    } catch (e) { toast('Export failed: ' + errText(e), { kind: 'error' }); }
  }
  /** @param {Doc} doc @param {'csv' | 'tsv'} kind */
  async exportDelimited(doc, kind) {
    if (this.ws.grid.editing) this.ws.grid.commitEdit(null);
    const s = doc.wb.activeSheet;
    const text = sheetToCsv(doc.wb, s, { delimiter: kind === 'tsv' ? '\t' : ',', bom: kind === 'csv' });
    try {
      const saved = await sheets.exportDialog({ suggestedName: doc.name + (doc.wb.sheets.length > 1 ? ' - ' + s.name : ''), kind, data: text });
      if (saved) toast('Exported "' + s.name + '" to ' + saved.path + '. Text that other apps would read as a formula starts with an apostrophe.', { ms: 6000 });
    } catch (e) { toast('Export failed: ' + errText(e), { kind: 'error' }); }
  }
  /** @param {Doc} doc */
  async closeDoc(doc) {
    if (this.ws.grid.editing && this.current === doc) this.ws.grid.commitEdit(null);
    if (doc.dirty) {
      if (this.autosave && doc.path && !doc.conflict) { const r = await doc.save({ auto: true }); if (r === 'saved') return this.finishClose(doc); }
      const r = await dialog({ title: 'Save changes to "' + doc.name + '"?', body: h('p.muted', null, 'Your changes will be lost if you don\'t save them.'),
        buttons: [{ label: 'Cancel', value: null }, { label: 'Don\'t save', value: 'discard' }, { label: 'Save', kind: 'primary', value: 'save' }] });
      if (!r) return;
      if (r === 'save') { const s = await doc.save(); if (s !== 'saved') return; }
    }
    this.finishClose(doc);
  }
  /** @param {Doc} doc */
  finishClose(doc) {
    const i = this.docs.indexOf(doc);
    this.dropDoc(doc);
    if (this.current === doc) {
      const next = this.docs[Math.min(i, this.docs.length - 1)];
      if (next) this.showDoc(next); else this.showHome();
    } else this.renderTabs();
  }
  /** Replaces a workbook with what's on disk (after a conflict) @param {Doc} doc */
  async reloadDoc(doc) {
    if (!doc.path) return;
    const ok = await confirm('Reload "' + doc.name + '"?', 'Your unsaved changes in this window are discarded and the file as it is on disk is opened. (They stay in the recovery folder until you close the app.)', { ok: 'Reload' });
    if (!ok) return;
    try {
      const f = await sheets.readWorkbook({ path: doc.path });
      const fresh = new Doc(E.parseFile(f.text), { path: f.path, stat: f.stat, name: f.name });
      const i = this.docs.indexOf(doc);
      await doc.snapshotForRecovery();
      doc.unsub();
      this.docs[i] = fresh;
      fresh.onState(() => { this.renderTabs(); this.scheduleSave(fresh); });
      this.showDoc(fresh);
    } catch (e) { toast(errText(e), { kind: 'error' }); }
  }
  /** @param {any} r an entry from listRecovery() */
  async restoreRecovery(r) {
    try {
      const rec = await sheets.readRecovery({ docId: r.docId });
      const wb = E.parseFile(rec.text);
      const doc = new Doc(wb, { name: r.name, path: r.path || null, docId: r.docId, dirty: true });
      if (doc.path) {
        const st = await sheets.changedOnDisk({ path: doc.path, expected: null }).catch(() => ({ state: 'missing' }));
        if (st.state === 'missing') { doc.conflict = { kind: 'missing', message: 'The file was moved or deleted.' }; doc.saveState = 'conflict'; }
        else doc.stat = st.stat;
      }
      this.addDoc(doc);
      toast('Restored "' + r.name + '". ' + (doc.path && !doc.conflict ? 'Save to keep it in the file (it isn\'t saved automatically yet).' : 'Save it to keep it.'), { ms: 7000 });
      doc.savedVersion = -1;
    } catch (e) { toast('Couldn\'t restore: ' + errText(e), { kind: 'error' }); }
  }

  /** Files changed by other programs while the app was in the background */
  async checkFilesOnDisk() {
    for (const d of this.docs) {
      if (!d.path || !d.stat || d.conflict || d.saveState === 'saving') continue;
      try {
        const r = await sheets.changedOnDisk({ path: d.path, expected: d.stat });
        if (r.state === 'same') continue;
        d.conflict = r.state === 'missing' ? { kind: 'missing', message: 'The file was moved or deleted.' } : { kind: 'changed', message: 'The file was changed by another program.' };
        d.saveState = 'conflict';
        d.emitState();
        if (this.current === d) this.ws.renderBanner();
      } catch (e) { /* not essential */ }
    }
  }

  /* ── MetaCode data ─────────────────────────── */

  /** A project chosen from the account @param {string} title */
  async pickProject(title) {
    if (this.state.status !== 'active') { toast('MetaCode projects need a connection to MetaCode.', { kind: 'error' }); return null; }
    const list = h('div.list', { role: 'listbox', 'aria-label': 'Projects' }, h('div.empty', null, 'Loading your projects…'));
    /** @type {any} */
    let chosen = null;
    const p = dialog({ title, wide: true, body: list, buttons: [{ label: 'Cancel', value: null }, { label: 'Open', kind: 'primary', run: done => done(chosen) }] });
    try {
      const projects = await sheets.projects();
      list.replaceChildren();
      if (!projects.length) list.append(h('div.empty', null, 'There are no saved projects in your account yet.'));
      for (const pr of projects) {
        const it = h('div.item', { role: 'option', tabindex: '0', 'aria-selected': 'false' }, h('span', { html: icon('project') }), h('span.grow', null, h('b', null, pr.name), pr.description ? ' — ' + pr.description : ''), h('span.small.muted', null, pr.updatedAt ? new Date(pr.updatedAt).toLocaleDateString() : ''));
        it.onclick = () => { chosen = pr; list.querySelectorAll('.item').forEach(x => x.setAttribute('aria-selected', 'false')); it.setAttribute('aria-selected', 'true'); };
        it.ondblclick = () => { chosen = pr; /** @type {HTMLElement | null} */ (document.querySelector('.dialog footer .btn.primary'))?.click(); };
        list.append(it);
      }
    } catch (e) { list.replaceChildren(h('div.empty', null, errText(e))); }
    return p;
  }
  async openProjectPicker() {
    const pr = await this.pickProject('Open a MetaCode project');
    if (!pr) return;
    try {
      const rec = await sheets.project({ id: pr.id });
      const wb = M.projectToWorkbook({ id: pr.id, name: pr.name, data: rec.data || rec });
      const saved = await sheets.createWorkbook({ name: pr.name, text: E.serialize(wb) });
      wb.name = saved.name;
      this.addDoc(new Doc(wb, { path: saved.path, stat: saved.stat, name: saved.name, notes: ['Opened from your MetaCode project "' + pr.name + '" as a copy in your library — changes here don\'t change the project on the website. To share results back, use MetaCode › Save Sheet as a MetaCode Project.'] }));
    } catch (e) { toast('Couldn\'t open the project: ' + errText(e), { kind: 'error' }); }
  }
  async scraperPicker() {
    if (this.state.status !== 'active') { toast('Scraper results need a connection to MetaCode.', { kind: 'error' }); return; }
    const list = h('div.list', { role: 'listbox', 'aria-label': 'Scraper jobs' }, h('div.empty', null, 'Loading your scraper jobs…'));
    /** @type {any} */
    let chosen = null;
    const into = /** @type {HTMLSelectElement} */ (h('select.input', { 'aria-label': 'Where to put the results' }, h('option', { value: 'new' }, 'A new workbook'), this.current ? h('option', { value: 'sheet' }, 'A new sheet in "' + this.current.name + '"') : null));
    const p = dialog({ title: 'Import scraper results', wide: true, body: [list, h('label.field', null, h('span', null, 'Put the results in'), into)], buttons: [{ label: 'Cancel', value: null }, { label: 'Import', kind: 'primary', run: done => done(chosen) }] });
    sheets.scraperJobs().then((/** @type {any[]} */ jobs) => {
      list.replaceChildren();
      const usable = jobs.filter(j => j.records > 0);
      if (!usable.length) list.append(h('div.empty', null, 'No scraper jobs with results. Run one in MetaCode\'s Scraper (on the website), then come back.'));
      for (const j of usable) {
        const it = h('div.item', { role: 'option', tabindex: '0', 'aria-selected': 'false' }, h('span', { html: icon('scraper') }), h('span.grow', null, h('b', null, j.label), ' · ' + j.status), h('span.small.muted', null, j.records.toLocaleString() + ' records'));
        it.onclick = () => { chosen = j; list.querySelectorAll('.item').forEach(x => x.setAttribute('aria-selected', 'false')); it.setAttribute('aria-selected', 'true'); };
        list.append(it);
      }
    }).catch((/** @type {any} */ e) => list.replaceChildren(h('div.empty', null, errText(e))));
    const job = await p;
    if (!job) return;
    const target = into.value;
    try {
      const records = [];
      for (let offset = 0; offset < 100000; offset += 10000) {
        const page = await sheets.scraperResults({ id: job.id, offset, limit: 10000 });
        records.push(...page.records);
        if (records.length >= page.total || !page.records.length) break;
      }
      const { rows } = M.recordsToRows(records);
      const name = ('Scraper ' + job.label).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Scraper results';
      const fill = (/** @type {E.Workbook} */ wb, /** @type {any} */ sheet) => {
        M.writeRows(wb, sheet, rows);
        const bold = wb.styles.id({ bold: true });
        for (let c = 0; c < rows[0].length; c++) { const cell = sheet.get(0, c); if (cell) cell.s = bold; }
        const dateStyle = wb.styles.id({ numFmt: 'yyyy-mm-dd hh:mm' });
        rows[0].forEach((/** @type {string} */ k, /** @type {number} */ c) => { if (k === 'created_utc' || /_utc$/.test(k)) for (let r = 1; r < rows.length; r++) { const cell = sheet.get(r, c); if (cell && typeof cell.v === 'number') cell.s = dateStyle; } });
        sheet.freeze = { rows: 1, cols: 0 };
      };
      if (target === 'sheet' && this.current) {
        const ws = this.ws;
        ws.structural('Import scraper results', () => { const s = ws.wb.addSheet(ws.wb.freeSheetName(name)); fill(ws.wb, s); ws.wb.activeSheetId = s.id; });
      } else {
        const wb = new E.Workbook({ name });
        const s = wb.addSheet('Results');
        fill(wb, s);
        wb.calc.rebuild(); wb.calc.recalcAll();
        const saved = await sheets.createWorkbook({ name, text: E.serialize(wb) });
        wb.name = saved.name;
        this.addDoc(new Doc(wb, { path: saved.path, stat: saved.stat, name: saved.name }));
      }
      toast('Imported ' + records.length.toLocaleString() + ' records from "' + job.label + '".');
    } catch (e) { toast('Couldn\'t import the results: ' + errText(e), { kind: 'error' }); }
  }

  /* ── Account ───────────────────────────────── */

  /** @param {MouseEvent | null} e */
  accountMenu(e) {
    const s = this.state;
    const at = e ? { x: e.clientX, y: e.clientY + 8 } : { x: window.innerWidth - 300, y: 60 };
    showMenu([
      { heading: (s.user && s.user.email) || 'Account' },
      { label: (s.plan && s.plan.name ? s.plan.name + ' plan' : 'Plan') + (s.status === 'offline' ? ' · offline' : ''), disabled: true },
      s.offlineUntil ? { label: 'Offline access until ' + new Date(s.offlineUntil).toLocaleString(), disabled: true } : '-',
      '-',
      { label: 'Manage account and plan', run: () => sheets.openExternal({ target: 'account' }) },
      { label: 'Check my subscription now', run: async () => { try { const st = await sheets.recheck(); toast(st.status === 'active' ? 'Your ' + ((st.plan && st.plan.name) || '') + ' plan is active.' : st.message || 'Checked.'); } catch (x) { toast(errText(x), { kind: 'error' }); } } },
      { label: 'Settings…', run: () => D.settingsDialog(this) },
      '-',
      { label: 'Sign out', run: async () => {
        const dirty = this.docs.filter(d => d.dirty);
        if (dirty.length) { const ok = await confirm('Sign out?', dirty.length + ' workbook' + (dirty.length === 1 ? ' has' : 's have') + ' unsaved changes. They\'re kept in the recovery folder and offered when you sign in again.', { ok: 'Sign out' }); if (!ok) return; }
        for (const d of this.docs) await d.snapshotForRecovery();
        await sheets.signOut();
      } }
    ], at);
  }

  /* ── Quitting ──────────────────────────────── */

  async beforeQuit() {
    sheets.quitAck().catch(() => {});
    if (this.ws.grid.editing) this.ws.grid.commitEdit(null);
    // AutoSave first
    for (const d of this.docs) if (d.dirty && d.path && this.autosave && !d.conflict) await d.save({ auto: true });
    const dirty = this.docs.filter(d => d.dirty);
    if (!dirty.length || !this.unlocked()) {
      for (const d of dirty) await d.snapshotForRecovery();
      return sheets.quitReady();
    }
    const r = await dialog({
      title: dirty.length === 1 ? 'Save changes to "' + dirty[0].name + '"?' : 'Save changes to ' + dirty.length + ' workbooks?',
      body: h('p.muted', null, 'If you don\'t save, your changes are lost.'),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Don\'t save', value: 'discard' }, { label: dirty.length === 1 ? 'Save' : 'Save all', kind: 'primary', value: 'save' }]
    });
    if (!r) { sheets.quitCancel(); return; }
    if (r === 'save') {
      for (const d of dirty) { const s = await d.save(); if (s !== 'saved') { this.showDoc(d); sheets.quitCancel(); return; } }
    } else for (const d of dirty) await sheets.discardRecovery({ docId: d.docId }).catch(() => {});
    sheets.quitReady();
  }
}

const app = new App();
/** @type {any} */ (window).__sheetsApp = app;      // for the end-to-end tests
app.boot().catch(e => {
  document.body.replaceChildren(h('div.access', null, h('div.access-card', null, h('h1', null, 'MetaCode Sheets couldn\'t start'), h('p', null, errText(e)))));
});
