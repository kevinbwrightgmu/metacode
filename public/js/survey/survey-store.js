/* ══════════════════════════════════════════════
   survey-store.js — the editor's document store

   • All edits go through transactions: store.tx(label, api => { … }).
     The store records the before/after state of every entity a
     transaction touches (one element, the page list, the theme…), which
     makes undo/redo exact, cheap in memory and independent of how the
     edit was made (canvas drag, inspector, layers, logic, keyboard).
     Continuous edits (dragging, typing) pass a `coalesce` key so they
     become one undo step.
   • Selection, current page and change notifications live here too.
   • Autosave: changes are saved after a short pause (and at least every
     few seconds while editing), with a backup in localStorage until the
     save is confirmed. Conflicts (the survey was saved from another tab)
     are reported, never silently overwritten.
   • Where surveys live: drafts and the library are kept in this browser
     (LocalDB, js/local-db.js), so people sharing a MetaCode server never
     see each other's surveys. Only publishing puts a copy on the server:
     the published versions and their responses, which belong to this
     browser (the mc_owner cookie). api() answers the draft routes itself
     and sends the rest to /api/surveys.
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore;
  const { clone } = Core;
  const HISTORY_LIMIT = 250;
  const DOC_KEYS = ['title', 'description', 'settings', 'theme', 'variables', 'rules', 'styles', 'meta'];

  function server(path, opts) {
    opts = opts || {};
    return fetch('/api/surveys' + path, {
      method: opts.method || 'GET',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(async res => {
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        const err = new Error((data && data.error && data.error.message) || ('The server answered ' + res.status + '.'));
        err.status = res.status; err.type = data && data.error && data.error.type; err.data = data;
        throw err;
      }
      return data;
    }, () => { const err = new Error('Couldn\'t reach the MetaCode server.'); err.network = true; throw err; });
  }

  /* ── Drafts in this browser ─────────────── */
  const DB = root.LocalDB;
  const failure = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
  const nowIso = () => new Date().toISOString();
  const clean = input => {
    const size = JSON.stringify(input || {}).length;
    if (size > Core.LIMITS.docBytes) throw failure(413, 'The survey is too large to save (25 MB at most — large images are the usual cause).');
    return Core.normalizeDoc(input);
  };
  function summarize(rec) {
    const doc = rec.doc || {};
    return {
      id: rec.id, title: doc.title || 'Untitled survey', description: doc.description || '',
      createdAt: rec.createdAt, updatedAt: rec.updatedAt, revision: rec.revision,
      pages: (doc.pages || []).length, questions: Object.values(doc.elements || {}).filter(e => e && Core.isQuestionType(e.type)).length,
      publish: rec.publish || null, responses: 0, completed: 0, lastResponseAt: null
    };
  }
  async function loadLocal(id) {
    const rec = await DB.get('surveys', id);
    if (!rec) throw failure(404, 'That survey doesn\'t exist (it may have been deleted, or it was made in another browser).');
    return rec;
  }
  // The server's publish state, with the draft revision that was published as recorded here
  const mergePublish = (local, remote) => (remote ? Object.assign({}, remote, { publishedRevision: local && local.publishedRevision !== undefined ? local.publishedRevision : remote.publishedRevision }) : local || null);

  async function local(path, opts) {
    const method = opts.method || 'GET';
    const body = opts.body || {};
    if (path === '' && method === 'GET') {
      const list = (await DB.all('surveys')).map(summarize);
      let remote = [];
      try { remote = (await server('')).surveys || []; } catch (e) { remote = []; }   // offline: drafts still list
      const byId = new Map(remote.map(r => [r.id, r]));
      list.forEach(sum => {
        const r = byId.get(sum.id);
        if (!r) return;
        sum.publish = mergePublish(sum.publish, r.publish);
        Object.assign(sum, { responses: r.responses, completed: r.completed, lastResponseAt: r.lastResponseAt });
      });
      return { surveys: list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
    }
    if (path === '' && method === 'POST') {
      let doc, problems = [];
      if (body.doc) { ({ doc, problems } = clean(body.doc)); doc.id = Core.uid('sv'); }
      else doc = Core.createSurvey({ title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 300) : 'Untitled survey' });
      if (typeof body.title === 'string' && body.title.trim()) doc.title = body.title.trim().slice(0, 300);
      doc.meta = Object.assign({}, doc.meta, { createdAt: nowIso() });
      const rec = { id: doc.id, revision: 1, createdAt: nowIso(), updatedAt: nowIso(), doc, publish: null };
      await DB.put('surveys', rec);
      return { survey: rec, problems };
    }
    if (path === '/library') {
      if (method === 'GET') {
        const r = await DB.get('meta', 'survey-library');
        return { library: Object.assign({ components: [], styles: [], templates: [] }, r ? r.library : {}) };
      }
      const lib = body.library || {};
      const pick = (arr, max) => (Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object' && typeof x.id === 'string').slice(0, max) : []);
      const cleanLib = { components: pick(lib.components, 500), styles: pick(lib.styles, 500), templates: pick(lib.templates, 200) };
      await DB.put('meta', { id: 'survey-library', library: cleanLib });
      return { library: cleanLib };
    }
    const m = path.match(/^\/([^/]+)(\/duplicate|\/publish)?$/);
    if (!m) return null;
    const id = decodeURIComponent(m[1]);
    const rec = await loadLocal(id);
    if (!m[2]) {
      if (method === 'GET') {
        const { doc, problems } = Core.normalizeDoc(rec.doc);
        let publish = rec.publish || null;
        if (publish) {
          try { publish = mergePublish(publish, (await server('/' + encodeURIComponent(id))).survey.publish); } catch (e) { /* offline or not on the server: keep the last known state */ }
        }
        return { survey: Object.assign({}, rec, { doc, publish }), problems };
      }
      if (method === 'PUT') {
        if (!body.doc) throw failure(400, 'Send { doc, baseRevision }.');
        const { doc, problems } = clean(body.doc);
        doc.id = id;
        doc.meta = Object.assign({}, doc.meta, { updatedAt: nowIso() });
        const latest = await loadLocal(id);
        if (!body.force && body.baseRevision !== undefined && body.baseRevision !== null && Number(body.baseRevision) !== latest.revision) {
          throw failure(409, 'This survey was changed somewhere else (another tab or window) since you opened it.', { type: 'conflict', data: { revision: latest.revision, updatedAt: latest.updatedAt } });
        }
        const next = Object.assign({}, latest, { doc, revision: latest.revision + 1, updatedAt: nowIso() });
        await DB.put('surveys', next);
        return { revision: next.revision, updatedAt: next.updatedAt, problems, publish: next.publish };
      }
      if (method === 'DELETE') {
        // A published copy and its responses go too
        if (rec.publish) { try { await server('/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; } }
        await DB.del('surveys', id);
        return { ok: true };
      }
    }
    if (m[2] === '/duplicate') {
      const { doc } = Core.normalizeDoc(rec.doc);
      doc.id = Core.uid('sv');
      doc.title = (doc.title + ' (copy)').slice(0, 300);
      const copy = { id: doc.id, revision: 1, createdAt: nowIso(), updatedAt: nowIso(), doc, publish: null };
      await DB.put('surveys', copy);
      return { survey: copy };
    }
    if (m[2] === '/publish') {
      // The server keeps the published copy; the draft stays here
      const out = await server('/' + encodeURIComponent(id) + '/publish', { method, body: method === 'POST' ? Object.assign({}, body, { doc: rec.doc, force: true }) : opts.body });
      const latest = await loadLocal(id);
      const publish = Object.assign({}, out.publish, { publishedRevision: method === 'POST' ? latest.revision : (latest.publish && latest.publish.publishedRevision) });
      await DB.put('surveys', Object.assign({}, latest, { publish }));
      return Object.assign({}, out, { publish, revision: latest.revision });
    }
    return null;
  }

  // Older versions kept surveys on the server, shared by everyone. The person
  // running MetaCode on this computer can move them into this browser.
  async function legacy() {
    try { return await server('/legacy'); } catch (e) { return { surveys: [], library: null }; }
  }
  async function importLegacy(ids, lib) {
    let n = 0;
    for (const id of ids) {
      const rec = (await server('/legacy/' + encodeURIComponent(id) + '/claim', { method: 'POST', body: {} })).survey;
      await DB.put('surveys', { id: rec.id, revision: rec.revision, createdAt: rec.createdAt, updatedAt: rec.updatedAt, doc: rec.doc, publish: rec.publish || null });
      n++;
    }
    if (lib) {
      const cur = (await local('/library', { method: 'GET' })).library;
      const add = (a, b) => a.concat((b || []).filter(x => x && !a.some(y => y.id === x.id)));
      await local('/library', { method: 'PUT', body: { library: { components: add(cur.components, lib.components), styles: add(cur.styles, lib.styles), templates: add(cur.templates, lib.templates) } } });
    }
    return n;
  }

  // Same answers as the server's routes, for both kinds.
  function api(path, opts) {
    opts = opts || {};
    if (!DB) return server(path, opts);
    return Promise.resolve().then(() => local(path, opts)).then(out => (out === null ? server(path, opts) : out));
  }

  function backupKey(id) { return 'metacode_survey_backup_' + id; }

  function create(record, opts) {
    opts = opts || {};
    const doc = Core.normalizeDoc(record.doc).doc;
    const listeners = new Set();
    let undoStack = [], redoStack = [];
    let current = null;          // open transaction
    let selection = [];
    let pageId = doc.pages[0].id;
    let revision = record.revision;
    let publish = record.publish || null;
    const save = { status: 'saved', dirty: false, timer: null, firstDirtyAt: 0, inFlight: null, error: null, retryMs: 0, lastSavedAt: Date.now() };
    let backupTimer = null;

    function emit(type, info) { listeners.forEach(fn => { try { fn(type, info || {}); } catch (e) { console.error(e); } }); }

    /* ── Transactions ─────────────────────── */
    function touch(key, getter) {
      if (!current) throw new Error('Edits must happen inside store.tx()');
      if (!current.changes.has(key)) current.changes.set(key, { key, before: clone(getter()) });
    }
    const txApi = {
      get doc() { return doc; },
      el(id) { if (!doc.elements[id]) return null; touch('el:' + id, () => doc.elements[id]); return doc.elements[id]; },
      addEl(el) { touch('el:' + el.id, () => undefined); doc.elements[el.id] = el; return el; },
      removeEl(id) { if (!doc.elements[id]) return; touch('el:' + id, () => doc.elements[id]); delete doc.elements[id]; },
      pages() { touch('pages', () => doc.pages); return doc.pages; },
      part(key) { if (DOC_KEYS.indexOf(key) === -1) throw new Error('Unknown document part ' + key); touch('doc:' + key, () => doc[key]); return doc[key]; },
      set(key, value) { if (DOC_KEYS.indexOf(key) === -1) throw new Error('Unknown document part ' + key); touch('doc:' + key, () => doc[key]); doc[key] = value; },
      // children list of an element or a page (records the owner)
      children(ref) {
        const pid = Core.pageIdOfRef(ref);
        if (pid) { const p = txApi.pages().find(x => x.id === pid); return p ? p.children : null; }
        const el = txApi.el(ref);
        return el && Array.isArray(el.children) ? el.children : null;
      }
    };

    function tx(label, fn, o) {
      o = o || {};
      if (current) return fn(txApi);   // nested: part of the outer transaction
      current = { label, changes: new Map(), selBefore: selection.slice(), pageBefore: pageId };
      let result;
      try {
        result = fn(txApi);
      } catch (e) {
        // roll back whatever was applied
        const ch = current; current = null;
        Array.from(ch.changes.values()).reverse().forEach(c => applyValue(c.key, c.before));
        emit('change', describe(ch.changes, true));
        throw e;
      }
      const ch = current; current = null;
      if (!ch.changes.size) return result;
      ch.changes.forEach(c => { c.after = clone(currentValue(c.key)); });
      // drop no-op changes
      Array.from(ch.changes.keys()).forEach(k => { const c = ch.changes.get(k); if (JSON.stringify(c.before) === JSON.stringify(c.after)) ch.changes.delete(k); });
      if (!ch.changes.size) return result;
      // selection may reference deleted elements
      selection = selection.filter(id => doc.elements[id]);
      const entry = { label, changes: ch.changes, selBefore: ch.selBefore, selAfter: selection.slice(), pageBefore: ch.pageBefore, pageAfter: pageId, coalesce: o.coalesce || null, time: Date.now() };
      const last = undoStack[undoStack.length - 1];
      if (o.coalesce && last && last.coalesce === o.coalesce && entry.time - last.time < 2000) {
        entry.changes.forEach((c, k) => { if (last.changes.has(k)) last.changes.get(k).after = c.after; else last.changes.set(k, c); });
        last.time = entry.time; last.selAfter = entry.selAfter;
      } else {
        undoStack.push(entry);
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      }
      redoStack = [];
      markDirty();
      emit('change', describe(ch.changes));
      return result;
    }

    function currentValue(key) {
      if (key === 'pages') return doc.pages;
      if (key.indexOf('el:') === 0) return doc.elements[key.slice(3)];
      return doc[key.slice(4)];
    }
    function applyValue(key, value) {
      if (key === 'pages') doc.pages = clone(value);
      else if (key.indexOf('el:') === 0) { const id = key.slice(3); if (value === undefined) delete doc.elements[id]; else doc.elements[id] = clone(value); }
      else doc[key.slice(4)] = clone(value);
    }
    // What changed, so views can update minimally.
    function describe(changes) {
      const info = { ids: new Set(), frameOnly: new Set(), structure: false, theme: false, settings: false, logic: false, pages: false, doc: false };
      changes.forEach((c, key) => {
        if (key === 'pages') { info.structure = true; info.pages = true; return; }
        if (key.indexOf('doc:') === 0) {
          const k = key.slice(4);
          if (k === 'theme' || k === 'styles') info.theme = true;
          if (k === 'settings') info.settings = true;
          if (k === 'rules' || k === 'variables') info.logic = true;
          info.doc = true;
          return;
        }
        const id = key.slice(3);
        info.ids.add(id);
        const b = c.before, a = c.after;
        if (!b || !a || b.parent !== a.parent || JSON.stringify(b.children) !== JSON.stringify(a.children) || b.hidden !== a.hidden || b.type !== a.type) { info.structure = true; return; }
        const strip = x => JSON.stringify(Object.assign({}, x, { frame: null }));
        if (strip(b) === strip(a)) info.frameOnly.add(id);
      });
      return info;
    }

    function undo() {
      const e = undoStack.pop();
      if (!e) return false;
      Array.from(e.changes.values()).reverse().forEach(c => applyValue(c.key, c.before));
      redoStack.push(e);
      selection = e.selBefore.filter(id => doc.elements[id]);
      if (doc.pages.some(p => p.id === e.pageBefore)) pageId = e.pageBefore;
      else if (!doc.pages.some(p => p.id === pageId)) pageId = doc.pages[0].id;
      markDirty();
      emit('change', Object.assign(describe(e.changes), { undo: true, label: e.label }));
      emit('select');
      return e.label;
    }
    function redo() {
      const e = redoStack.pop();
      if (!e) return false;
      e.changes.forEach(c => applyValue(c.key, c.after));
      undoStack.push(e);
      selection = e.selAfter.filter(id => doc.elements[id]);
      if (doc.pages.some(p => p.id === e.pageAfter)) pageId = e.pageAfter;
      else if (!doc.pages.some(p => p.id === pageId)) pageId = doc.pages[0].id;
      markDirty();
      emit('change', Object.assign(describe(e.changes), { redo: true, label: e.label }));
      emit('select');
      return e.label;
    }

    /* ── Selection & page ─────────────────── */
    function select(ids, o) {
      const list = (Array.isArray(ids) ? ids : (ids ? [ids] : [])).filter(id => doc.elements[id]);
      const next = o && o.toggle ? toggle(selection, list) : (o && o.add ? Array.from(new Set(selection.concat(list))) : list);
      if (JSON.stringify(next) === JSON.stringify(selection)) return;
      selection = next;
      // keep the current page in sync with the selection
      if (selection.length) { const p = Core.pageOf(doc, selection[0]); if (p && p.id !== pageId) { pageId = p.id; emit('page'); } }
      emit('select');
    }
    function toggle(cur, list) { const out = cur.slice(); list.forEach(id => { const i = out.indexOf(id); if (i === -1) out.push(id); else out.splice(i, 1); }); return out; }
    function setPage(id) {
      if (!doc.pages.some(p => p.id === id) || id === pageId) return;
      pageId = id;
      selection = [];
      emit('page');
      emit('select');
    }

    /* ── Autosave ─────────────────────────── */
    function markDirty() {
      save.dirty = true;
      if (!save.firstDirtyAt) save.firstDirtyAt = Date.now();
      setStatus(save.inFlight ? 'saving' : 'unsaved');
      clearTimeout(backupTimer);
      backupTimer = setTimeout(writeBackup, 400);
      schedule();
    }
    function schedule(delay) {
      clearTimeout(save.timer);
      if (save.status === 'conflict') return;
      const waited = Date.now() - save.firstDirtyAt;
      const d = delay !== undefined ? delay : (waited > 5000 ? 0 : 900);
      save.timer = setTimeout(() => flush().catch(() => {}), d);
    }
    function setStatus(s, err) {
      save.status = s; save.error = err || null;
      emit('save', { status: s, error: save.error });
    }
    function writeBackup() {
      try { localStorage.setItem(backupKey(doc.id), JSON.stringify({ doc, baseRevision: revision, savedAt: new Date().toISOString(), dirty: save.dirty })); }
      catch (e) { /* storage full or blocked: the server copy is the safety net */ }
    }
    function clearBackup() { try { localStorage.removeItem(backupKey(doc.id)); } catch (e) { /* ignore */ } }

    function flush(o) {
      o = o || {};
      clearTimeout(save.timer);
      if (save.inFlight) return save.inFlight.then(() => (save.dirty ? flush(o) : null));
      if (!save.dirty && !o.force) return Promise.resolve(null);
      if (save.status === 'conflict' && !o.overwrite) return Promise.reject(Object.assign(new Error('This survey was changed somewhere else.'), { conflict: true }));
      const snapshot = JSON.parse(JSON.stringify(doc));
      save.dirty = false; save.firstDirtyAt = 0;
      setStatus('saving');
      save.inFlight = api('/' + encodeURIComponent(doc.id), { method: 'PUT', body: { doc: snapshot, baseRevision: revision, force: !!o.overwrite } }).then(res => {
        revision = res.revision;
        if (res.publish) publish = res.publish;
        save.inFlight = null; save.retryMs = 0; save.lastSavedAt = Date.now();
        if (save.dirty) { setStatus('unsaved'); schedule(300); }
        else { setStatus('saved'); clearBackup(); }
        emit('saved', { revision });
        return res;
      }, err => {
        save.inFlight = null;
        save.dirty = true;
        if (!save.firstDirtyAt) save.firstDirtyAt = Date.now();
        writeBackup();
        if (err.status === 409) { setStatus('conflict', err); throw Object.assign(err, { conflict: true }); }
        if (err.status === 413) { setStatus('error', err); throw err; }
        setStatus(err.network ? 'offline' : 'error', err);
        save.retryMs = Math.min(30000, (save.retryMs || 1000) * 2);
        schedule(save.retryMs);
        throw err;
      });
      return save.inFlight;
    }

    function readBackup() {
      try {
        const raw = localStorage.getItem(backupKey(doc.id));
        if (!raw) return null;
        const b = JSON.parse(raw);
        return b && b.doc && b.dirty ? b : null;
      } catch (e) { return null; }
    }
    // Replaces the document (restore backup / reload server copy).
    function replaceDoc(newDoc, o) {
      const clean = Core.normalizeDoc(newDoc).doc;
      tx(o && o.label || 'Restore', t => {
        Object.keys(doc.elements).forEach(id => { if (!clean.elements[id]) t.removeEl(id); });
        Object.keys(clean.elements).forEach(id => { if (doc.elements[id]) { t.el(id); doc.elements[id] = clean.elements[id]; } else t.addEl(clean.elements[id]); });
        t.pages(); doc.pages.splice(0, doc.pages.length, ...clean.pages);
        DOC_KEYS.forEach(k => t.set(k, clean[k]));
      });
      if (!doc.pages.some(p => p.id === pageId)) pageId = doc.pages[0].id;
      selection = [];
      emit('page'); emit('select');
    }

    return {
      get doc() { return doc; },
      get selection() { return selection.slice(); },
      get primary() { return selection[0] || null; },
      get pageId() { return pageId; },
      get page() { return doc.pages.find(p => p.id === pageId) || doc.pages[0]; },
      get revision() { return revision; },
      set revision(r) { revision = r; },
      get publish() { return publish; },
      set publish(p) { publish = p; emit('publish'); },
      get saveState() { return { status: save.status, error: save.error, dirty: save.dirty, lastSavedAt: save.lastSavedAt }; },
      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,
      undoLabel: () => (undoStack.length ? undoStack[undoStack.length - 1].label : ''),
      redoLabel: () => (redoStack.length ? redoStack[redoStack.length - 1].label : ''),
      tx, undo, redo, select, setPage, flush, readBackup, clearBackup, replaceDoc, writeBackup,
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      emit,
      destroy() { clearTimeout(save.timer); clearTimeout(backupTimer); listeners.clear(); }
    };
  }

  root.SurveyStore = { create, api, legacy, importLegacy };
})(typeof window !== 'undefined' ? window : this);
