// @ts-check
// ── Home: start something, open a workbook, recover unsaved work ──────────────
import { h, icon, ago, bytes, esc } from './util.js';
import { showMenu, confirm, prompt, toast, errText } from './ui.js';

const sheets = /** @type {any} */ (window).sheets;

/**
 * @param {HTMLElement} root
 * @param {{ app: any }} o  the app controller (app.js)
 */
export async function renderHome(root, o) {
  const app = o.app;
  const state = app.state;
  root.innerHTML = '';
  const inner = h('div.home-inner');
  root.append(inner);
  const who = h('div.who', null,
    state.status === 'offline' ? h('span.badge.warn', { html: icon('offline') + ' Offline' }) : null,
    state.plan && state.plan.name ? h('span.badge.ok', null, state.plan.name) : null,
    h('span', null, state.user && state.user.email ? state.user.email : ''),
    h('button.btn.small', { onclick: (/** @type {MouseEvent} */ e) => app.accountMenu(e) , html: icon('user') + 'Account' }));
  inner.append(h('div.home-head', null, h('img', { src: 'img/mark.png', alt: '', width: 34, height: 34 }), h('h1', null, 'MetaCode Sheets'), who));

  const start = (/** @type {string} */ ic, /** @type {string} */ title, /** @type {string} */ sub, /** @type {() => void} */ run, /** @type {string} */ cls = '') => {
    const b = h('button.start', { class: cls || undefined, html: icon(ic) }, h('b', null, title), h('span', null, sub));
    b.onclick = run;
    return b;
  };
  inner.append(h('div.starts', null,
    start('plus', 'Blank workbook', 'Start from an empty sheet', () => app.newWorkbook()),
    start('open', 'Open…', 'A .mcsheet, .xlsx or .csv file', () => app.openDialog()),
    start('import', 'Import Excel or CSV', 'Converted to a MetaCode workbook', () => app.importDialog()),
    start('project', 'MetaCode project', 'Posts, codes and codebook', () => app.openProjectPicker(), 'ai'),
    start('scraper', 'Scraper results', 'From your MetaCode scraper jobs', () => app.scraperPicker(), 'ai')));

  // unsaved work from a previous session
  const recovery = await sheets.listRecovery().catch(() => []);
  const openIds = new Set(app.docs.map((/** @type {any} */ d) => d.docId));
  const orphans = recovery.filter((/** @type {any} */ r) => !openIds.has(r.docId));
  if (orphans.length) {
    const box = h('div.recovery', { role: 'region', 'aria-label': 'Recovered work' },
      h('h3', null, app.info.crashed ? 'MetaCode Sheets closed unexpectedly — your unsaved changes were kept' : 'Unsaved changes from an earlier session'));
    for (const r of orphans) {
      box.append(h('div.item', null,
        h('span', { html: icon('warning') }),
        h('span.spacer', null, h('b', null, r.name), ' · ', h('span.muted', null, 'kept ' + ago(r.savedAt) + (r.path ? ' · from ' + r.path : ' · never saved'))),
        h('button.btn.small.primary', { onclick: () => app.restoreRecovery(r) }, 'Restore'),
        h('button.btn.small', { onclick: async () => { const ok = await confirm('Discard recovered changes?', 'The unsaved changes to "' + r.name + '" will be deleted. This can\'t be undone.', { ok: 'Discard', danger: true }); if (ok) { await sheets.discardRecovery({ docId: r.docId }); renderHome(root, o); } } }, 'Discard')));
    }
    inner.append(box);
  }

  // the library
  inner.append(h('h2', null, 'Your workbooks'));
  const list = h('div.files', { role: 'list', 'aria-label': 'Workbooks in your library' }, h('div.empty', null, 'Loading…'));
  inner.append(list);
  let files = [];
  try { files = await sheets.library(); } catch (e) { list.innerHTML = '<div class="empty">' + esc(errText(e)) + '</div>'; return; }
  list.innerHTML = '';
  if (!files.length) list.append(h('div.empty', null, 'No workbooks yet. They\'re kept in ', h('b', null, app.info.library), '.'));
  for (const f of files) list.append(fileRow(f, app, () => renderHome(root, o)));

  // recent files elsewhere on the computer
  const recent = (await sheets.recent().catch(() => [])).filter((/** @type {any} */ r) => !r.path.startsWith(app.info.library));
  if (recent.length) {
    inner.append(h('h2', null, 'Recent elsewhere'));
    const rl = h('div.files', { role: 'list' });
    for (const r of recent) {
      const row = h('div.file-row', { role: 'listitem', tabindex: '0', title: r.path, html: icon('sheet') },
        h('span.name', null, r.name.replace(/\.mcsheet$/i, '')), h('span.when', null, r.missing ? 'moved or deleted' : 'opened ' + ago(r.openedAt)), h('span.size'),
        h('button.more', { 'aria-label': 'Remove from list', html: icon('x'), onclick: async (/** @type {Event} */ e) => { e.stopPropagation(); await sheets.forgetRecent({ path: r.path }); renderHome(root, o); } }));
      row.onclick = () => (r.missing ? toast('"' + r.name + '" isn\'t there any more — it may have been moved, renamed or deleted.', { kind: 'error' }) : app.openPath(r.path));
      row.onkeydown = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') row.click(); };
      rl.append(row);
    }
    inner.append(rl);
  }
}

/** @param {any} f @param {any} app @param {() => void} refresh */
function fileRow(f, app, refresh) {
  const more = h('button.more', { 'aria-label': 'More actions for ' + f.name, html: icon('more') });
  const row = h('div.file-row', { role: 'listitem', tabindex: '0', html: icon('sheet') },
    h('span.name', null, f.name), h('span.when', null, 'edited ' + ago(f.modified)), h('span.size', null, bytes(f.size)), more);
  row.onclick = () => app.openPath(f.path);
  row.onkeydown = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') app.openPath(f.path); if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); more.click(); } };
  const menu = (/** @type {{ x: number, y: number }} */ at) => showMenu([
    { label: 'Open', run: () => app.openPath(f.path) },
    { label: 'Rename…', run: async () => {
      const name = await prompt('Rename workbook', 'Name', f.name, { ok: 'Rename' });
      if (!name || name === f.name) return;
      try { const r = await sheets.renameWorkbook({ path: f.path, name }); app.pathRenamed(f.path, r.path, r.name); refresh(); } catch (e) { toast(errText(e), { kind: 'error' }); }
    } },
    { label: 'Duplicate', run: async () => { try { await sheets.duplicateWorkbook({ path: f.path }); refresh(); } catch (e) { toast(errText(e), { kind: 'error' }); } } },
    { label: 'Show in folder', run: () => sheets.reveal({ path: f.path }) },
    '-',
    { label: 'Delete…', danger: true, run: async () => {
      if (app.docs.some((/** @type {any} */ d) => d.path === f.path)) { toast('Close "' + f.name + '" before deleting it.', { kind: 'error' }); return; }
      const ok = await confirm('Delete "' + f.name + '"?', 'It moves to your computer\'s trash, where you can restore it.', { ok: 'Move to trash', danger: true });
      if (!ok) return;
      try { await sheets.deleteWorkbook({ path: f.path }); toast('Moved "' + f.name + '" to the trash.'); refresh(); } catch (e) { toast(errText(e), { kind: 'error' }); }
    } }
  ], at);
  more.onclick = (e) => { e.stopPropagation(); const r = more.getBoundingClientRect(); menu({ x: r.left, y: r.bottom + 4 }); };
  row.oncontextmenu = (e) => { e.preventDefault(); menu({ x: e.clientX, y: e.clientY }); };
  return row;
}
