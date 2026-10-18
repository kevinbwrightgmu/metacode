// @ts-check
// ── The bridge between the window and the main process ────────────────────────
// The window gets window.sheets: one function per request in src/main/ipc.js
// and a few events. No Node.js, no ipcRenderer, no generic "invoke".
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Failures reach the window as { name, message, code } (an Error's extra
// fields don't survive the bridge between the two worlds)
/** @param {string} channel */
const call = channel => async (/** @type {any} */ args) => {
  const r = await ipcRenderer.invoke(channel, args);
  if (r && r.ok) return r.value;
  throw { name: 'SheetsError', message: (r && r.error && r.error.message) || 'Something went wrong.', code: (r && r.error && r.error.code) || 'error' };
};
const EVENTS = ['auth:changed', 'auth:linkError', 'menu:command', 'app:openFile', 'app:beforeQuit', 'ai:batchLine', 'theme:changed'];
/** @param {string} channel @param {(data: any) => void} fn */
function on(channel, fn) {
  if (!EVENTS.includes(channel) || typeof fn !== 'function') throw new Error('Unknown event');
  const listener = (/** @type {any} */ _e, /** @type {any} */ data) => fn(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const channels = {
  appInfo: 'app:info', getSettings: 'settings:get', setSettings: 'settings:set',
  authState: 'auth:state', signIn: 'auth:signIn', sendSignInLink: 'auth:sendLink', signOut: 'auth:signOut', recheck: 'auth:recheck', openExternal: 'open:external',
  library: 'files:library', recent: 'files:recent', forgetRecent: 'files:forgetRecent', openDialog: 'files:openDialog', readWorkbook: 'files:read', readBytes: 'files:readBytes',
  saveWorkbook: 'files:save', saveAs: 'files:saveAs', createWorkbook: 'files:create', renameWorkbook: 'files:rename', duplicateWorkbook: 'files:duplicate',
  deleteWorkbook: 'files:delete', reveal: 'files:reveal', changedOnDisk: 'files:changed', importDialog: 'files:importDialog', exportDialog: 'files:exportDialog',
  putRecovery: 'recovery:put', listRecovery: 'recovery:list', readRecovery: 'recovery:read', discardRecovery: 'recovery:discard',
  readClipboard: 'clipboard:read', writeClipboard: 'clipboard:write',
  ai: 'ai:run', aiModels: 'ai:models', aiBatchStart: 'ai:batchStart', aiBatchStop: 'ai:batchStop',
  projects: 'platform:projects', project: 'platform:project', createProject: 'platform:createProject',
  scraperJobs: 'platform:scraperJobs', scraperResults: 'platform:scraperResults',
  windowState: 'window:state', ready: 'app:ready', quitReady: 'app:quitReady', quitAck: 'app:quitAck', quitCancel: 'app:quitCancel'
};
/** @type {Record<string, any>} */
const api = { on, platform: process.platform };
for (const [name, channel] of Object.entries(channels)) api[name] = call(channel);

contextBridge.exposeInMainWorld('sheets', Object.freeze(api));
