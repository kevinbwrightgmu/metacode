// @ts-check
// ── What the window may ask the main process to do ────────────────────────────
// A fixed list of requests (no "run this" or "open any URL"), each with its
// inputs checked here. Requests are accepted only from the app's own page
// (app://sheets). Everything that needs the subscription checks it here too,
// not only in the window. Answers are { ok: true, value } or
// { ok: false, error: { code, message } } — never a stack trace or a token.
'use strict';
const path = require('path');
const { ORIGIN } = require('./protocol');

const MAX_TEXT = 512 * 1024 * 1024;

class InputError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.code = 'invalid_request'; }
}

const check = {
  /** @param {unknown} v @param {string} what @param {number} [max] */
  str(v, what, max = 10000) { if (typeof v !== 'string' || v.length > max) throw new InputError(what + ' must be text.'); return v; },
  /** @param {unknown} v @param {string} what */
  obj(v, what) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InputError(what + ' is missing.'); return /** @type {Record<string, any>} */ (v); },
  /** @param {unknown} v */
  stamp(v) {
    if (v === null || v === undefined) return null;
    const o = check.obj(v, 'The file state');
    if (!Number.isFinite(o.mtimeMs) || !Number.isFinite(o.size)) throw new InputError('The file state is invalid.');
    return { mtimeMs: Number(o.mtimeMs), size: Number(o.size) };
  },
  /** @param {unknown} v */
  bytes(v) { if (!(v instanceof Uint8Array)) throw new InputError('Expected file contents.'); if (v.length > MAX_TEXT) throw new InputError('Too large.'); return v; }
};

/** @param {unknown} e */
function errorOut(e) {
  const err = /** @type {any} */ (e) || {};
  const code = typeof err.code === 'string' && /^[a-z_]{2,40}$/.test(err.code) ? err.code : 'error';
  let message = typeof err.message === 'string' && err.message ? err.message : 'Something went wrong.';
  // file system errors: a plain explanation instead of the system's text with paths
  if (err.code === 'EACCES' || err.code === 'EPERM') message = 'The app doesn\'t have permission to use that file or folder.';
  else if (err.code === 'ENOSPC') message = 'The disk is full.';
  else if (err.code === 'ENOENT') message = 'The file or folder isn\'t there any more.';
  else if (err.code === 'EBUSY') message = 'The file is in use by another program.';
  else if (err.code === 'EROFS') message = 'That location is read-only.';
  return { ok: false, error: { code: /^E[A-Z]+$/.test(String(err.code)) ? 'file_error' : code, message: message.replace(/Bearer\s+[\w.-]+/g, 'Bearer [hidden]').slice(0, 500) } };
}

/**
 * @param {{ ipcMain: any, dialog: any, shell: any, clipboard: any, ClipboardItem?: any, getWindow: () => any, app: any,
 *           auth: ReturnType<typeof import('./auth').createAuth>, entitlement: ReturnType<typeof import('./entitlement').createEntitlement>,
 *           files: ReturnType<typeof import('./files').createFiles>, platform: ReturnType<typeof import('./platform').createPlatform>,
 *           settings: { get: () => any, set: (patch: any) => any }, info: () => any, rendererReady?: () => void, quitReady: () => void, quitAck: () => void, quitCancel: () => void }} d
 */
function registerIpc(d) {
  /** @type {Map<string, AbortController>} */
  const batches = new Map();

  /** @param {any} event */
  function fromApp(event) {
    const w = d.getWindow();
    const url = event.senderFrame ? event.senderFrame.url : '';
    return !!w && event.sender === w.webContents && typeof url === 'string' && url.startsWith(ORIGIN + '/');
  }
  function needUnlocked() {
    if (!d.entitlement.unlocked()) { const e = new Error('MetaCode Sheets is locked: sign in with a Pro, Max or Ultra plan.'); /** @type {any} */ (e).code = 'locked'; throw e; }
  }
  /**
   * @param {string} channel @param {(args: any, event: any) => any} fn @param {{ unlocked?: boolean }} [opts]
   */
  function handle(channel, fn, opts = {}) {
    d.ipcMain.handle(channel, async (/** @type {any} */ event, /** @type {any} */ args) => {
      if (!fromApp(event)) return { ok: false, error: { code: 'forbidden', message: 'Not allowed.' } };
      try {
        if (opts.unlocked) needUnlocked();
        return { ok: true, value: await fn(args === undefined ? {} : args, event) };
      } catch (e) { return errorOut(e); }
    });
  }
  const win = () => d.getWindow();

  /* ── App, account ─────────────────────────── */
  handle('app:info', () => d.info());
  handle('settings:get', () => d.settings.get());
  handle('settings:set', a => d.settings.set(check.obj(a, 'Settings')));
  handle('auth:state', () => d.entitlement.state());
  handle('auth:signIn', async a => {
    await d.auth.signInWithPassword(check.str(a.email, 'The email', 320), check.str(a.password, 'The password', 500));
    return d.entitlement.check('sign-in');
  });
  handle('auth:sendLink', async a => d.auth.sendEmailLink(check.str(a.email, 'The email', 320)));
  handle('auth:signOut', async () => { await d.auth.signOut(); return d.entitlement.signedOut(); });
  handle('auth:recheck', () => d.entitlement.check('manual'));
  handle('open:external', a => {
    const s = d.entitlement.state();
    const urls = /** @type {Record<string, string | null>} */ ({
      upgrade: s.upgradeUrl, account: s.accountUrl, signup: s.signUpUrl, reset: s.accountUrl, download: s.downloadUrl, website: s.server
    });
    const url = urls[check.str(a.target, 'The link', 40)];
    if (!url || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) throw new InputError('That link isn\'t available.');
    return d.shell.openExternal(url).then(() => true);
  });

  /* ── Workbooks ────────────────────────────── */
  handle('files:library', () => d.files.library(), { unlocked: true });
  handle('files:recent', () => d.files.recent(), { unlocked: true });
  handle('files:forgetRecent', a => { d.files.forgetRecent(a.path); return true; });
  handle('files:openDialog', async () => {
    const r = await d.dialog.showOpenDialog(win(), {
      title: 'Open', defaultPath: d.files.libraryDir(), properties: ['openFile'],
      filters: [{ name: 'Spreadsheets', extensions: ['mcsheet', 'xlsx', 'xlsm', 'csv', 'tsv', 'txt'] }, { name: 'MetaCode Sheets', extensions: ['mcsheet'] }, { name: 'Excel', extensions: ['xlsx', 'xlsm'] }, { name: 'CSV / text', extensions: ['csv', 'tsv', 'txt'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = d.files.grant(r.filePaths[0]);
    return { path: p, kind: /\.mcsheet$/i.test(p) ? 'workbook' : 'import' };
  }, { unlocked: true });
  handle('files:read', a => d.files.readWorkbook(a.path), { unlocked: true });
  handle('files:readBytes', a => d.files.readBytes(a.path), { unlocked: true });
  handle('files:save', a => d.files.saveWorkbook(a.path, check.str(a.text, 'The workbook', MAX_TEXT), { expected: check.stamp(a.expected), force: a.force === true }), { unlocked: true });
  handle('files:saveAs', async a => {
    const name = d.files.cleanName(a.suggestedName) || 'Untitled';
    const r = await d.dialog.showSaveDialog(win(), { title: 'Save as', defaultPath: path.join(d.files.libraryDir(), name + '.mcsheet'), filters: [{ name: 'MetaCode Sheets', extensions: ['mcsheet'] }] });
    if (r.canceled || !r.filePath) return null;
    const target = /\.mcsheet$/i.test(r.filePath) ? r.filePath : r.filePath + '.mcsheet';
    const out = await d.files.writeNew(target, check.str(a.text, 'The workbook', MAX_TEXT));
    return Object.assign(out, { name: path.basename(out.path).replace(/\.mcsheet$/i, '') });
  }, { unlocked: true });
  handle('files:create', a => d.files.createInLibrary(check.str(a.name, 'The name', 200), check.str(a.text, 'The workbook', MAX_TEXT)), { unlocked: true });
  handle('files:rename', a => d.files.rename(a.path, a.name), { unlocked: true });
  handle('files:duplicate', a => d.files.duplicate(a.path), { unlocked: true });
  handle('files:delete', a => d.files.remove(a.path), { unlocked: true });
  handle('files:reveal', a => { d.shell.showItemInFolder(d.files.allowed(a.path)); return true; }, { unlocked: true });
  handle('files:changed', a => d.files.changedOnDisk(a.path, check.stamp(a.expected) || /** @type {any} */ (null)), { unlocked: true });
  handle('files:importDialog', async () => {
    const r = await d.dialog.showOpenDialog(win(), { title: 'Import', properties: ['openFile'], filters: [{ name: 'Spreadsheets and data', extensions: ['xlsx', 'xlsm', 'csv', 'tsv', 'txt'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return d.files.readBytes(d.files.grant(r.filePaths[0]));
  }, { unlocked: true });
  handle('files:exportDialog', async a => {
    const kind = check.str(a.kind, 'The format', 10);
    const ext = /** @type {Record<string, string>} */ ({ xlsx: 'xlsx', csv: 'csv', tsv: 'tsv', mcsheet: 'mcsheet' })[kind];
    if (!ext) throw new InputError('Unknown export format.');
    const name = d.files.cleanName(a.suggestedName) || 'Export';
    const r = await d.dialog.showSaveDialog(win(), { title: 'Export', defaultPath: path.join(d.app.getPath('documents'), name + '.' + ext), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    const target = r.filePath.toLowerCase().endsWith('.' + ext) ? r.filePath : r.filePath + '.' + ext;
    const data = typeof a.data === 'string' ? check.str(a.data, 'The export', MAX_TEXT) : check.bytes(a.data);
    return d.files.writeNew(target, data);
  }, { unlocked: true });

  /* ── Recovery (always allowed: work is kept even when the app locks) ── */
  handle('recovery:put', a => {
    const meta = check.obj(a.meta, 'Details');
    return d.files.putRecovery(a.docId, { name: String(meta.name || 'Untitled'), path: typeof meta.path === 'string' ? meta.path : null }, check.str(a.text, 'The workbook', MAX_TEXT));
  });
  handle('recovery:list', () => d.files.listRecovery());
  handle('recovery:read', a => d.files.readRecovery(a.docId), { unlocked: true });
  handle('recovery:discard', a => d.files.discardRecovery(a.docId));

  /* ── Clipboard (for "paste values"; normal copy/paste uses the page's events) ── */
  // Electron's clipboard is asynchronous (W3C-style: readText, read, write of ClipboardItems)
  handle('clipboard:read', async () => {
    const text = String((await d.clipboard.readText()) || '').slice(0, 64 * 1024 * 1024);
    let html = '';
    try {
      for (const item of await d.clipboard.read()) if (item.types.includes('text/html')) { const b = await item.getType('text/html'); html = typeof b === 'string' ? b : await b.text(); break; }
    } catch (e) { html = ''; }
    return { text, html: html.slice(0, 64 * 1024 * 1024) };
  }, { unlocked: true });
  handle('clipboard:write', async a => {
    const text = check.str(a.text, 'Text', 64 * 1024 * 1024);
    if (typeof a.html === 'string' && a.html && d.ClipboardItem) await d.clipboard.write([new d.ClipboardItem({ 'text/plain': text, 'text/html': a.html.slice(0, 64 * 1024 * 1024) })]);
    else await d.clipboard.writeText(text);
    return true;
  }, { unlocked: true });

  /* ── MetaCode features (the server checks the plan on every call) ── */
  handle('ai:run', a => {
    const messages = a.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > 50 || messages.some(m => !m || typeof m.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role) || m.content.length > 400000)) throw new InputError('The AI request is invalid.');
    return d.platform.ai({ messages, model: typeof a.model === 'string' ? a.model.slice(0, 200) : undefined, max_tokens: Number(a.max_tokens) || undefined, temperature: Number.isFinite(a.temperature) ? a.temperature : undefined });
  }, { unlocked: true });
  handle('ai:models', () => d.platform.models(), { unlocked: true });
  handle('ai:batchStart', async (a, event) => {
    const jobId = check.str(a.jobId, 'The job', 64);
    if (!Array.isArray(a.requests) || !a.requests.length || a.requests.length > 500) throw new InputError('Send 1–500 requests per batch.');
    const requests = a.requests.map((/** @type {any} */ r) => ({ id: r && r.id, body: check.obj(r && r.body, 'A request') }));
    const ctl = new AbortController();
    batches.set(jobId, ctl);
    try {
      return await d.platform.aiBatch({ requests, parallel: Math.max(1, Math.min(8, Number(a.parallel) || 3)) }, line => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:batchLine', { jobId, line });
      }, ctl.signal);
    } finally { batches.delete(jobId); }
  }, { unlocked: true });
  handle('ai:batchStop', a => { const c = batches.get(String(a.jobId)); if (c) c.abort(); return !!c; });
  handle('platform:projects', () => d.platform.projects(), { unlocked: true });
  handle('platform:project', a => d.platform.project(check.str(a.id, 'The project', 200)), { unlocked: true });
  handle('platform:createProject', a => d.platform.createProject(check.obj(a.project, 'The project')), { unlocked: true });
  handle('platform:scraperJobs', () => d.platform.scraperJobs(), { unlocked: true });
  handle('platform:scraperResults', a => d.platform.scraperResults(check.str(a.id, 'The job', 100), { offset: a.offset, limit: a.limit }), { unlocked: true });

  /* ── Window ───────────────────────────────── */
  handle('window:state', a => {
    const w = win();
    if (!w) return false;
    w.setTitle(typeof a.title === 'string' && a.title ? a.title.slice(0, 200) + ' — MetaCode Sheets' : 'MetaCode Sheets');
    if (process.platform === 'darwin') { w.setDocumentEdited(!!a.dirty); if (typeof a.path === 'string') w.setRepresentedFilename(a.path); }
    return true;
  });
  handle('app:ready', () => { if (d.rendererReady) d.rendererReady(); return true; });
  handle('app:quitReady', () => { d.quitReady(); return true; });
  handle('app:quitAck', () => { d.quitAck(); return true; });
  handle('app:quitCancel', () => { d.quitCancel(); return true; });

  return { abortAll() { for (const c of batches.values()) c.abort(); batches.clear(); } };
}

module.exports = { registerIpc, errorOut, InputError };
