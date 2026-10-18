// @ts-check
// ── MetaCode Sheets: the main process ─────────────────────────────────────────
// Starts the window, signs in, checks the subscription with the MetaCode
// server (entitlement.js), keeps the session in the system keychain
// (secure-store.js), reads and writes workbooks (files.js) and talks to
// MetaCode for the AI and project features (platform.js). The window
// (src/renderer) is sandboxed, has no Node.js and no network access, and can
// only ask for the things listed in ipc.js.
'use strict';
const { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain, net, protocol, session, nativeTheme, powerMonitor, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const { registerScheme, handleProtocol, ORIGIN } = require('./protocol');
const { loadAppConfig } = require('./config');
const { createHttp } = require('./http');
const { createSecureStore } = require('./secure-store');
const { createAuth } = require('./auth');
const { createEntitlement } = require('./entitlement');
const { createPlatform } = require('./platform');
const { createFiles } = require('./files');
const { registerIpc } = require('./ipc');
const { menuTemplate } = require('./menu');

const APP_ROOT = path.join(__dirname, '..', '..');
const isMac = process.platform === 'darwin';
const devFlag = (/** @type {string} */ name) => !app.isPackaged && process.argv.includes(name);
const devValue = (/** @type {string} */ name) => { if (app.isPackaged) return null; const a = process.argv.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
const dev = devFlag('--dev');

// development/test builds may keep their data elsewhere (never a packaged app)
const userDataOverride = devValue('--user-data');
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));
app.setName('MetaCode Sheets');
app.enableSandbox();
registerScheme(protocol);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  const cfg = loadAppConfig({ appRoot: APP_ROOT, isPackaged: app.isPackaged, argv: process.argv });
  /** @type {BrowserWindow | null} */
  let win = null;
  let quitting = false, quitConfirmed = false, rendererReady = false;
  /** @type {string[]} */
  const pendingOpen = [];
  /** @type {string[]} */
  const pendingLinks = [];

  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  const readSettings = () => { try { const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; } };
  /** @type {any} */
  let settings = readSettings();
  const writeSettings = () => { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (e) { /* not essential */ } };
  const applyTheme = () => { nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system'; };
  applyTheme();

  const send = (/** @type {string} */ channel, /** @type {any} */ data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };

  const http = createHttp({ fetch: (url, init) => net.fetch(url, init), userAgent: 'sheets/' + app.getVersion() });
  const store = createSecureStore({ file: path.join(app.getPath('userData'), 'session.bin'), safeStorage, insecureTestStore: devFlag('--insecure-test-store') });
  /** @type {ReturnType<typeof createEntitlement>} */
  let entitlement;
  const auth = createAuth({
    http, store, server: cfg.serverUrl,
    accounts: async () => { const c = await entitlement.config(); return c && c.accounts && c.accounts.enabled ? c.accounts : null; }
  });
  entitlement = createEntitlement({
    http, auth, store, server: cfg.serverUrl, pinnedKeys: cfg.leasePublicKeys, appVersion: app.getVersion(),
    onChange: state => send('auth:changed', state)
  });
  const platform = createPlatform({ http, auth, entitlement, server: cfg.serverUrl });
  const libraryOverride = devValue('--library');
  const files = createFiles({
    libraryDir: libraryOverride ? path.resolve(libraryOverride) : path.join(app.getPath('documents'), 'MetaCode Sheets'),
    userData: app.getPath('userData'),
    trash: p => shell.trashItem(p)
  });
  const { crashed } = files.startSession();

  /** Files and links given on the command line or by the system @param {string[]} argv */
  function takeArgs(argv) {
    for (const a of argv.slice(1)) {
      if (/^metacode-sheets:\/\//i.test(a)) pendingLinks.push(a);
      else if (!a.startsWith('-') && /\.(mcsheet|xlsx|xlsm|csv|tsv)$/i.test(a) && path.isAbsolute(a) && fs.existsSync(a)) pendingOpen.push(files.grant(a));
    }
    flush();
  }
  function flush() {
    if (!rendererReady) return;
    while (pendingOpen.length) send('app:openFile', { path: pendingOpen.shift() });
    while (pendingLinks.length) {
      const link = /** @type {string} */ (pendingLinks.shift());
      auth.completeEmailLink(link).then(() => entitlement.check('sign-in')).catch(e => send('auth:linkError', { message: e && e.message ? String(e.message) : 'The sign-in link didn\'t work.' }));
    }
  }

  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    takeArgs(argv);
  });
  app.on('open-file', (e, p) => { e.preventDefault(); if (/\.(mcsheet|xlsx|xlsm|csv|tsv)$/i.test(p)) { pendingOpen.push(files.grant(p)); flush(); } });
  app.on('open-url', (e, url) => { e.preventDefault(); pendingLinks.push(url); flush(); });

  function createWindow() {
    const ui = session.fromPartition('sheets-ui');
    // the window loads only the app's own files…
    ui.webRequest.onBeforeRequest((details, cb) => {
      const ok = /^(app:\/\/sheets\/|devtools:|data:|blob:)/.test(details.url) || (dev && /^chrome-extension:/.test(details.url));
      cb({ cancel: !ok });
    });
    // …and gets no camera, microphone, notifications, location…
    ui.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
    ui.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
    handleProtocol(ui.protocol, { renderer: path.join(APP_ROOT, 'src', 'renderer'), shared: path.join(APP_ROOT, 'src', 'shared') });

    const bounds = settings.bounds && Number.isFinite(settings.bounds.width) ? settings.bounds : { width: 1360, height: 860 };
    win = new BrowserWindow({
      width: Math.max(760, bounds.width), height: Math.max(520, bounds.height), x: bounds.x, y: bounds.y, minWidth: 760, minHeight: 520,
      show: false, title: 'MetaCode Sheets', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0F172A' : '#F8FAFC',
      icon: process.platform === 'linux' ? path.join(APP_ROOT, 'build', 'icon.png') : undefined,
      webPreferences: {
        partition: 'sheets-ui',
        preload: path.join(APP_ROOT, 'src', 'preload', 'preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true,
        allowRunningInsecureContent: false, webviewTag: false, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true,
        devTools: dev
      }
    });
    if (settings.maximized) win.maximize();
    win.once('ready-to-show', () => { if (win) win.show(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) e.preventDefault(); });
    win.webContents.on('will-redirect', (e, url) => { if (!url.startsWith(ORIGIN + '/')) e.preventDefault(); });
    win.webContents.on('will-attach-webview', e => e.preventDefault());
    win.webContents.on('did-finish-load', () => { rendererReady = true; flush(); });
    win.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      rendererReady = false;
      dialog.showMessageBox({ type: 'error', title: 'MetaCode Sheets', message: 'The window stopped unexpectedly.', detail: 'Changes from the last few seconds are kept and will be offered when it reopens.', buttons: ['Reopen'] })
        .then(() => { if (win && !win.isDestroyed()) win.reload(); });
    });
    win.on('unresponsive', () => {
      if (!win) return;
      dialog.showMessageBox(win, { type: 'warning', title: 'MetaCode Sheets', message: 'MetaCode Sheets isn\'t responding.', detail: 'It may be busy with a large calculation. Changes from the last few seconds are kept if you reload.', buttons: ['Wait', 'Reload'], defaultId: 0 })
        .then(r => { if (r.response === 1 && win && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); });
    });
    const keepBounds = () => { if (!win || win.isDestroyed()) return; settings.maximized = win.isMaximized(); if (!win.isMaximized() && !win.isMinimized()) settings.bounds = win.getBounds(); writeSettings(); };
    win.on('resize', debounce(keepBounds, 500));
    win.on('move', debounce(keepBounds, 500));
    win.on('close', e => {
      if (quitConfirmed) return;
      e.preventDefault();
      askToQuit();
    });
    win.on('closed', () => { win = null; });
    win.loadURL(ORIGIN + '/index.html');
  }

  /** The window saves or discards unsaved work, then answers with app:quitReady */
  function askToQuit() {
    if (quitting) return;
    quitting = true;
    if (!win || win.isDestroyed() || !rendererReady) { quitConfirmed = true; app.quit(); return; }
    send('app:beforeQuit', {});
    // a window that doesn't even acknowledge (hung) doesn't keep the app open
    // forever: its unsaved work is in the recovery folder
    quitTimer = setTimeout(() => { if (!quitConfirmed) { quitConfirmed = true; app.quit(); } }, 8000);
  }
  /** @type {any} */
  let quitTimer = null;

  registerIpc({
    ipcMain, dialog, shell, clipboard, app, auth, entitlement, files, platform,
    getWindow: () => win,
    settings: {
      get: () => ({ theme: settings.theme || 'system', zoom: Number(settings.zoom) || 1, gridlines: settings.gridlines !== false, formulaBar: settings.formulaBar !== false, sidebar: settings.sidebar !== false, aiModel: typeof settings.aiModel === 'string' ? settings.aiModel : '' }),
      set: patch => {
        if (['system', 'light', 'dark'].includes(patch.theme)) settings.theme = patch.theme;
        if (Number.isFinite(patch.zoom)) settings.zoom = Math.max(0.5, Math.min(2, Number(patch.zoom)));
        for (const k of ['gridlines', 'formulaBar', 'sidebar']) if (typeof patch[k] === 'boolean') settings[k] = patch[k];
        if (typeof patch.aiModel === 'string' && patch.aiModel.length <= 200) settings.aiModel = patch.aiModel;
        writeSettings();
        applyTheme();
        return true;
      }
    },
    info: () => ({
      version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch,
      server: cfg.serverUrl, serverSource: cfg.source, pinned: cfg.pinned, dev, crashed, storage: store.kind(),
      library: files.libraryDir(), dark: nativeTheme.shouldUseDarkColors
    }),
    quitReady: () => { clearTimeout(quitTimer); quitConfirmed = true; app.quit(); },
    quitAck: () => { clearTimeout(quitTimer); },
    quitCancel: () => { clearTimeout(quitTimer); quitting = false; }
  });

  app.on('before-quit', e => {
    if (quitConfirmed) return;
    e.preventDefault();
    askToQuit();
  });
  app.on('will-quit', () => { entitlement.stop(); files.endSession(); });
  app.on('window-all-closed', () => app.quit());
  // no other windows, ever
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', ev => ev.preventDefault());
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(/** @type {any} */ (menuTemplate({ send: cmd => send('menu:command', { cmd }), isMac, dev, appName: 'MetaCode Sheets' }))));
    nativeTheme.on('updated', () => send('theme:changed', { dark: nativeTheme.shouldUseDarkColors }));
    powerMonitor.on('resume', () => { entitlement.check('resume').catch(() => {}); });
    if (app.isPackaged) app.setAsDefaultProtocolClient('metacode-sheets');
    createWindow();
    takeArgs(process.argv);
    entitlement.check('launch').catch(() => {});
  });
}

/** @param {(...a: any[]) => void} fn @param {number} ms */
function debounce(fn, ms) {
  /** @type {any} */
  let t = null;
  return (/** @type {any[]} */ ...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
