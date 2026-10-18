// @ts-check
// ── An open workbook ──────────────────────────────────────────────────────────
// The workbook, its undo history, where it's saved, and its view (selection,
// scroll, zoom). Saving:
//   • AutoSave (on by default) writes the file a few seconds after the last
//     change — after checking it wasn't changed by another program since.
//   • Unsaved changes are also copied to the recovery folder every few
//     seconds, so a crash loses at most that much; they're offered back at
//     the next start.
import * as E from '../../shared/engine/index.js';

const sheets = /** @type {any} */ (window).sheets;
let counter = 0;
const newDocId = () => 'd' + Date.now().toString(36) + (++counter) + Math.random().toString(36).slice(2, 6);

export class Doc {
  /**
   * @param {E.Workbook} wb
   * @param {{ path?: string | null, stat?: { mtimeMs: number, size: number } | null, name?: string, docId?: string, dirty?: boolean, notes?: string[] }} [o]
   */
  constructor(wb, o = {}) {
    this.wb = wb;
    this.history = new E.History();
    this.path = o.path || null;
    this.stat = o.stat || null;
    this.name = o.name || wb.name || 'Untitled';
    wb.name = this.name;
    this.docId = o.docId || newDocId();
    this.savedVersion = o.dirty ? -1 : wb.version;
    /** @type {null | { kind: 'changed' | 'missing', message: string }} */
    this.conflict = null;
    /** @type {'saved' | 'saving' | 'unsaved' | 'error' | 'conflict'} */
    this.saveState = o.dirty ? 'unsaved' : 'saved';
    this.saveError = '';
    this.lastSavedAt = o.dirty ? 0 : Date.now();
    this.notes = o.notes || [];
    this.view = { zoom: 1, sheets: /** @type {Record<string, any>} */ ({}) };
    /** @type {Set<() => void>} */
    this.listeners = new Set();
    this.recoveryVersion = -1;
    this.saving = null;
    this.unsub = wb.onChange(() => this.changed());
  }

  get dirty() { return this.wb.version !== this.savedVersion; }
  /** @param {() => void} fn */
  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emitState() { for (const fn of this.listeners) { try { fn(); } catch (e) { /* listener */ } } }

  changed() {
    if (this.saveState === 'saved') this.saveState = 'unsaved';
    this.emitState();
  }

  /** Records an editing operation's undo step @param {any} step */
  record(step) { if (step) this.history.push(step); return step; }

  serialize() { return E.serialize(this.wb); }

  /**
   * Saves to the file (or asks where, for a workbook that has none).
   * @param {{ force?: boolean, auto?: boolean }} [o]
   * @returns {Promise<'saved' | 'conflict' | 'cancelled' | 'error'>}
   */
  async save(o = {}) {
    if (this.saving) { await this.saving; if (!this.dirty && !o.force) return 'saved'; }
    if (this.conflict && o.auto) return 'conflict';
    const version = this.wb.version;
    let text;
    try { text = this.serialize(); } catch (e) { this.saveState = 'error'; this.saveError = 'The workbook couldn\'t be prepared for saving.'; this.emitState(); return 'error'; }
    this.saveState = 'saving';
    this.emitState();
    const run = (async () => {
      try {
        if (!this.path) {
          const r = await sheets.saveAs({ suggestedName: this.name, text });
          if (!r) { this.saveState = this.dirty ? 'unsaved' : 'saved'; this.emitState(); return 'cancelled'; }
          this.path = r.path; this.stat = r.stat; this.name = r.name; this.wb.name = r.name;
        } else {
          const r = await sheets.saveWorkbook({ path: this.path, text, expected: this.stat, force: !!o.force });
          if (r.conflict) {
            this.conflict = { kind: r.conflict, message: r.message };
            this.saveState = 'conflict';
            this.emitState();
            return 'conflict';
          }
          this.stat = r.stat;
        }
        this.conflict = null;
        this.savedVersion = version;
        this.lastSavedAt = Date.now();
        this.saveState = this.dirty ? 'unsaved' : 'saved';
        this.saveError = '';
        sheets.discardRecovery({ docId: this.docId }).catch(() => {});
        this.recoveryVersion = version;
        this.emitState();
        return 'saved';
      } catch (e) {
        this.saveState = 'error';
        this.saveError = e && /** @type {any} */ (e).message ? String(/** @type {any} */ (e).message) : 'Saving failed.';
        this.emitState();
        return 'error';
      }
    })();
    this.saving = run;
    try { return await run; } finally { this.saving = null; }
  }

  /** Save as a new file (always asks) */
  async saveAs() {
    const text = this.serialize();
    const version = this.wb.version;
    const r = await sheets.saveAs({ suggestedName: this.name, text });
    if (!r) return 'cancelled';
    this.path = r.path; this.stat = r.stat; this.name = r.name; this.wb.name = r.name;
    this.conflict = null;
    this.savedVersion = version;
    this.lastSavedAt = Date.now();
    this.saveState = this.dirty ? 'unsaved' : 'saved';
    sheets.discardRecovery({ docId: this.docId }).catch(() => {});
    this.emitState();
    return 'saved';
  }

  /** A copy of unsaved changes in the recovery folder */
  async snapshotForRecovery() {
    if (!this.dirty || this.recoveryVersion === this.wb.version) return;
    const version = this.wb.version;
    try {
      await sheets.putRecovery({ docId: this.docId, meta: { name: this.name, path: this.path }, text: this.serialize() });
      this.recoveryVersion = version;
    } catch (e) { /* the next try may work */ }
  }

  dispose() { this.unsub(); this.listeners.clear(); sheets.discardRecovery({ docId: this.docId }).catch(() => {}); }
}

/** A Doc from a .mcsheet file's text @param {string} text @param {any} [o] */
export function docFromText(text, o) {
  const wb = E.parseFile(text);
  return new Doc(wb, o);
}
