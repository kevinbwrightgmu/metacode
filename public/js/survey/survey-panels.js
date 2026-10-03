/* ══════════════════════════════════════════════
   survey-panels.js — left-hand panels of the editor

   • Add: every element type, grouped (click to add, or drag onto the canvas)
   • Layers: pages and the element tree of the current page — select,
     rename, hide, lock, reorder and re-nest by drag and drop, keyboard
     navigation (↑/↓, ←/→ to collapse/expand, F2 rename, Delete)
   • Library: reusable components and saved styles (shared by all surveys)
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore;
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const icon = (inner, cls) => '<svg class="' + (cls || 'ss-ico') + '" viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>';
  const EYE = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  const EYE_OFF = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/>';
  const LOCK = '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
  const UNLOCK = '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
  const CHEV = '<polyline points="9 18 15 12 9 6"/>';
  const DOTS = '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>';

  /* ── Add palette ──────────────────────────── */
  function createPalette(container, store, cmds, opts) {
    opts = opts || {};
    let query = '';
    function render() {
      const q = query.trim().toLowerCase();
      const cats = Core.CATEGORIES.filter(c => c.id !== 'part');
      let html = '<div class="ss-panel-search"><input type="search" class="ss-input" placeholder="Search elements…" aria-label="Search elements" value="' + esc(query) + '"></div>';
      cats.forEach(cat => {
        const types = Object.values(Core.TYPES).filter(t => t.category === cat.id && !t.part && (!q || t.label.toLowerCase().includes(q) || t.type.includes(q)));
        if (!types.length) return;
        html += '<div class="ss-pal-group"><div class="ss-pal-title">' + esc(cat.label) + '</div><div class="ss-pal-grid">' +
          types.map(t => '<button type="button" class="ss-pal-item" draggable="true" data-type="' + esc(t.type) + '" title="Add ' + esc(t.label.toLowerCase()) + ' (or drag onto the canvas)">' +
            icon(t.icon) + '<span>' + esc(t.label) + '</span></button>').join('') + '</div></div>';
      });
      const comps = (opts.library && opts.library().components) || [];
      const shown = comps.filter(c => !q || String(c.name).toLowerCase().includes(q));
      if (shown.length) {
        html += '<div class="ss-pal-group"><div class="ss-pal-title">Your components</div><div class="ss-pal-list">' +
          shown.map(c => '<button type="button" class="ss-pal-comp" draggable="true" data-comp="' + esc(c.id) + '">' + icon(Core.ICONS.group) + '<span>' + esc(c.name) + '</span></button>').join('') + '</div></div>';
      }
      container.innerHTML = html;
      const input = container.querySelector('input[type=search]');
      input.addEventListener('input', () => { query = input.value; const pos = input.selectionStart; render(); const i2 = container.querySelector('input[type=search]'); i2.focus(); i2.setSelectionRange(pos, pos); });
    }
    container.addEventListener('click', e => {
      const b = e.target.closest('[data-type]');
      if (b) { cmds.addElement(b.dataset.type); if (opts.onAdded) opts.onAdded(); return; }
      const c = e.target.closest('[data-comp]');
      if (c && opts.insertComponent) opts.insertComponent(c.dataset.comp);
    });
    container.addEventListener('dragstart', e => {
      const b = e.target.closest('[data-type]');
      const c = e.target.closest('[data-comp]');
      if (b) { e.dataTransfer.setData('application/x-survey-type', b.dataset.type); e.dataTransfer.effectAllowed = 'copy'; }
      else if (c) { e.dataTransfer.setData('application/x-survey-component', c.dataset.comp); e.dataTransfer.effectAllowed = 'copy'; }
    });
    render();
    return { render };
  }

  /* ── Layers ───────────────────────────────── */
  function createLayers(container, store, cmds, opts) {
    opts = opts || {};
    const doc = () => store.doc;
    const expanded = new Set();
    let renaming = null;
    let dragIds = null;

    // free-layout parents list the top layer first (like an image editor);
    // stacks list children in their visual order
    function orderedKids(ref) {
      const ids = Core.childIds(doc(), ref).slice();
      return Core.layoutOf(doc(), ref).mode === 'free' ? ids.reverse() : ids;
    }
    function ensureExpanded() {
      store.selection.forEach(id => Core.ancestors(doc(), id).forEach(a => expanded.add(a)));
    }

    function render() {
      ensureExpanded();
      const page = store.page;
      const sel = new Set(store.selection);
      let html = '<div class="ss-pages"><div class="ss-pages-head"><span>Pages</span><button type="button" class="ss-icon-btn" data-act="add-page" title="Add page" aria-label="Add page">+</button></div><ul class="ss-page-list" role="listbox" aria-label="Pages">';
      doc().pages.forEach((p, i) => {
        const on = p.id === page.id;
        html += '<li role="option" aria-selected="' + on + '" class="ss-page-row' + (on ? ' is-on' : '') + '" data-page="' + esc(p.id) + '" tabindex="' + (on ? 0 : -1) + '">' +
          '<span class="ss-page-num">' + (i + 1) + '</span><span class="ss-page-name">' + esc(p.name) + '</span>' +
          (p.props && p.props.ending ? '<span class="ss-mini-tag">End</span>' : '') + (p.props && p.props.initiallyHidden ? '<span class="ss-mini-tag">Skipped</span>' : '') +
          '<button type="button" class="ss-icon-btn ss-row-menu" data-page-menu="' + esc(p.id) + '" aria-label="Page actions for ' + esc(p.name) + '">' + icon(DOTS) + '</button></li>';
      });
      html += '</ul></div><div class="ss-layers-head"><span>Layers</span><span class="ss-layers-hint">' + esc(page.name) + '</span></div>';
      html += '<ul class="ss-tree" role="tree" aria-label="Layers of ' + esc(page.name) + '" aria-multiselectable="true">';
      const rows = [];
      const walk = (ref, depth) => {
        orderedKids(ref).forEach(id => {
          const el = doc().elements[id];
          if (!el) return;
          const kids = Array.isArray(el.children) && el.children.length;
          const open = expanded.has(id);
          rows.push(id);
          const def = Core.getType(el.type) || {};
          html += '<li role="treeitem" aria-level="' + (depth + 1) + '" aria-selected="' + sel.has(id) + '"' + (kids ? ' aria-expanded="' + open + '"' : '') +
            ' class="ss-row' + (sel.has(id) ? ' is-sel' : '') + (el.hidden ? ' is-hidden' : '') + (el.locked ? ' is-locked' : '') + '" data-id="' + esc(id) + '" draggable="true" tabindex="-1" style="--depth:' + depth + '">' +
            '<span class="ss-row-twist">' + (kids ? '<button type="button" class="ss-twist' + (open ? ' is-open' : '') + '" data-twist="' + esc(id) + '" tabindex="-1" aria-label="' + (open ? 'Collapse' : 'Expand') + '">' + icon(CHEV) + '</button>' : '') + '</span>' +
            icon(def.icon || '', 'ss-ico ss-row-ico' + (Core.isQuestionType(el.type) ? ' is-q' : '')) +
            (renaming === id ? '<input class="ss-rename" value="' + esc(el.name || Core.displayName(doc(), el)) + '" aria-label="Layer name">' : '<span class="ss-row-name">' + esc(Core.displayName(doc(), el)) + '</span>') +
            '<span class="ss-row-tools"><button type="button" class="ss-icon-btn" data-toggle="hidden" tabindex="-1" aria-label="' + (el.hidden ? 'Show' : 'Hide') + '" title="' + (el.hidden ? 'Show' : 'Hide') + ' (Ctrl+Shift+H)">' + icon(el.hidden ? EYE_OFF : EYE) + '</button>' +
            '<button type="button" class="ss-icon-btn" data-toggle="locked" tabindex="-1" aria-label="' + (el.locked ? 'Unlock' : 'Lock') + '" title="' + (el.locked ? 'Unlock' : 'Lock') + ' (Ctrl+Shift+L)">' + icon(el.locked ? LOCK : UNLOCK) + '</button></span></li>';
          if (kids && open) walk(id, depth + 1);
        });
      };
      walk('page:' + page.id, 0);
      html += '</ul>';
      if (!rows.length) html += '<div class="ss-empty-note">This page is empty. Add elements from the Add tab.</div>';
      container.innerHTML = html;
      const focusRow = container.querySelector('.ss-row.is-sel') || container.querySelector('.ss-row');
      if (focusRow) focusRow.tabIndex = 0;
      const ren = container.querySelector('.ss-rename');
      if (ren) {
        ren.focus(); ren.select();
        const commit = ok => { const id = renaming; renaming = null; if (ok && doc().elements[id]) store.tx('Rename layer', t => { t.el(id).name = ren.value.trim().slice(0, 200); }); render(); };
        ren.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
        ren.addEventListener('blur', () => { if (renaming) commit(true); });
      }
      const selRow = container.querySelector('.ss-row.is-sel');
      if (selRow && opts.scrollIntoView !== false) { const b = container.getBoundingClientRect(), r = selRow.getBoundingClientRect(); if (r.top < b.top || r.bottom > b.bottom) container.scrollTop += r.top - b.top - b.height / 3; }
    }

    function visibleRowIds() { return Array.from(container.querySelectorAll('.ss-row')).map(r => r.dataset.id); }

    container.addEventListener('click', e => {
      const twist = e.target.closest('[data-twist]');
      if (twist) { const id = twist.dataset.twist; if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); return; }
      const tog = e.target.closest('[data-toggle]');
      if (tog) { const row = tog.closest('.ss-row'); cmds.setFlag([row.dataset.id], tog.dataset.toggle); return; }
      if (e.target.closest('[data-act="add-page"]')) { cmds.addPage(store.pageId); return; }
      const pm = e.target.closest('[data-page-menu]');
      if (pm) { if (opts.pageMenu) opts.pageMenu(pm.dataset.pageMenu, pm); return; }
      const pr = e.target.closest('[data-page]');
      if (pr) { store.setPage(pr.dataset.page); return; }
      const row = e.target.closest('.ss-row');
      if (!row || e.target.closest('.ss-rename')) return;
      const id = row.dataset.id;
      if (e.shiftKey && store.selection.length) {
        const ids = visibleRowIds();
        const a = ids.indexOf(store.selection[store.selection.length - 1]), b = ids.indexOf(id);
        const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
        store.select(range, { add: true });
      } else if (e.ctrlKey || e.metaKey) store.select([id], { toggle: true });
      else store.select([id]);
      if (opts.onSelect) opts.onSelect(id);
    });
    container.addEventListener('dblclick', e => {
      const pr = e.target.closest('[data-page]');
      if (pr && !e.target.closest('button')) { const p = Core.getPage(doc(), pr.dataset.page); const name = prompt('Page name', p.name); if (name && name.trim()) cmds.updatePage(p.id, x => { x.name = name.trim().slice(0, 200); }, 'Rename page'); return; }
      const row = e.target.closest('.ss-row');
      if (row && !e.target.closest('button')) { renaming = row.dataset.id; render(); }
    });
    container.addEventListener('keydown', e => {
      const row = e.target.closest('.ss-row');
      const prow = e.target.closest('.ss-page-row');
      if (prow) {
        const list = Array.from(container.querySelectorAll('.ss-page-row'));
        const i = list.indexOf(prow);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = list[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (n) { store.setPage(n.dataset.page); setTimeout(() => { const r = container.querySelector('.ss-page-row.is-on'); if (r) r.focus(); }, 0); } }
        return;
      }
      if (!row) return;
      const ids = visibleRowIds();
      const i = ids.indexOf(row.dataset.id);
      const id = row.dataset.id;
      const go = j => { if (j >= 0 && j < ids.length) { store.select([ids[j]]); setTimeout(() => { const r = container.querySelector('.ss-row[data-id="' + ids[j] + '"]'); if (r) { r.tabIndex = 0; r.focus({ preventScroll: true }); } }, 0); } };
      if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (!expanded.has(id) && doc().elements[id].children && doc().elements[id].children.length) { expanded.add(id); render(); setTimeout(() => focusRowEl(id), 0); } else go(i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (expanded.has(id)) { expanded.delete(id); render(); setTimeout(() => focusRowEl(id), 0); } else { const p = doc().elements[id].parent; if (doc().elements[p]) { store.select([p]); setTimeout(() => focusRowEl(p), 0); } } }
      else if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); renaming = id; render(); }
      else if (e.key === ' ') { e.preventDefault(); store.select([id], { toggle: true }); }
    });
    function focusRowEl(id) { const r = container.querySelector('.ss-row[data-id="' + id + '"]'); if (r) { r.tabIndex = 0; r.focus({ preventScroll: true }); } }

    // drag & drop: before / after / inside
    let dropInfo = null;
    container.addEventListener('dragstart', e => {
      const row = e.target.closest('.ss-row');
      if (!row) return;
      dragIds = store.selection.includes(row.dataset.id) ? cmds.topLevel(store.selection) : [row.dataset.id];
      e.dataTransfer.setData('text/plain', 'layers');
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    });
    container.addEventListener('dragover', e => {
      if (!dragIds) return;
      const row = e.target.closest('.ss-row');
      clearMarks();
      if (!row) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const target = doc().elements[row.dataset.id];
      const canInside = Core.isContainerType(target.type) && dragIds.every(id => cmds.canContain(target.id, doc().elements[id].type));
      const pos = canInside && y > 0.3 && y < 0.7 ? 'inside' : (y < 0.5 ? 'before' : 'after');
      row.classList.add('drop-' + pos);
      dropInfo = { id: row.dataset.id, pos };
    });
    container.addEventListener('dragleave', e => { if (!container.contains(e.relatedTarget)) clearMarks(); });
    container.addEventListener('drop', e => {
      if (!dragIds || !dropInfo) return;
      e.preventDefault();
      const target = doc().elements[dropInfo.id];
      if (dropInfo.pos === 'inside') { cmds.moveTo(dragIds, target.id, null); expanded.add(target.id); }
      else {
        const parent = target.parent;
        const list = Core.childIds(doc(), parent);
        const free = Core.layoutOf(doc(), parent).mode === 'free';
        let idx = list.indexOf(target.id);
        // reversed display for free parents: "before" in the list = above = later in the array
        if (free) idx = dropInfo.pos === 'before' ? idx + 1 : idx;
        else idx = dropInfo.pos === 'before' ? idx : idx + 1;
        cmds.moveTo(dragIds, parent, idx);
      }
      dragIds = null; dropInfo = null; clearMarks();
    });
    container.addEventListener('dragend', () => { dragIds = null; dropInfo = null; clearMarks(); container.querySelectorAll('.is-dragging').forEach(r => r.classList.remove('is-dragging')); });
    function clearMarks() { container.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach(r => r.classList.remove('drop-before', 'drop-after', 'drop-inside')); }

    let queued = false;
    const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; render(); }); };
    const off = store.on(type => { if (type === 'change' || type === 'select' || type === 'page') schedule(); });
    render();
    return { render, rename: id => { renaming = id; render(); }, destroy: off };
  }

  /* ── Library ─────────────────────────────── */
  function createLibrary(container, store, cmds, opts) {
    const lib = () => opts.library();
    function render() {
      const L = lib();
      const sel = store.selection;
      let html = '<div class="ss-lib-sec"><div class="ss-lib-head"><span>Components</span><button type="button" class="ss-chip-btn" data-act="save-comp"' + (sel.length ? '' : ' disabled') + '>Save selection</button></div>';
      html += L.components.length ? '<ul class="ss-lib-list">' + L.components.map(c => '<li><button type="button" class="ss-lib-item" data-insert="' + esc(c.id) + '" title="Insert on this page">' + icon(Core.ICONS.group) + '<span>' + esc(c.name) + '</span><small>' + Object.keys(c.snapshot.elements || {}).length + ' el.</small></button>' +
        '<button type="button" class="ss-icon-btn" data-del-comp="' + esc(c.id) + '" aria-label="Delete component ' + esc(c.name) + '">✕</button></li>').join('') + '</ul>'
        : '<p class="ss-empty-note">Select elements and click <b>Save selection</b> to reuse them in any survey (also from the Add tab).</p>';
      html += '</div><div class="ss-lib-sec"><div class="ss-lib-head"><span>Saved styles</span><button type="button" class="ss-chip-btn" data-act="save-style"' + (sel.length === 1 ? '' : ' disabled') + '>Save style</button></div>';
      html += L.styles.length ? '<ul class="ss-lib-list">' + L.styles.map(s => '<li><button type="button" class="ss-lib-item" data-apply-style="' + esc(s.id) + '" title="Apply to the selection"' + (sel.length ? '' : ' disabled') + '><span class="ss-style-chip" style="' + esc(previewCss(s.style)) + '">Aa</span><span>' + esc(s.name) + '</span></button>' +
        '<button type="button" class="ss-icon-btn" data-del-style="' + esc(s.id) + '" aria-label="Delete style ' + esc(s.name) + '">✕</button></li>').join('') + '</ul>'
        : '<p class="ss-empty-note">Save an element\'s look (colours, borders, typography, states…) and apply it to any element with one click.</p>';
      html += '</div><div class="ss-lib-sec"><div class="ss-lib-head"><span>Style clipboard</span></div><div class="ss-btn-row"><button type="button" class="ss-chip-btn" data-act="copy-style"' + (sel.length === 1 ? '' : ' disabled') + '>Copy style</button><button type="button" class="ss-chip-btn" data-act="paste-style"' + (sel.length ? '' : ' disabled') + '>Paste style</button></div>' +
        '<p class="ss-empty-note">Shortcuts: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> / <kbd>V</kbd></p></div>';
      container.innerHTML = html;
    }
    function previewCss(st) {
      const s = st || {};
      const res = v => String(v || '').replace(/var\(--sv-(\w+)\)/g, (m, k) => (store.doc.theme.tokens || {})[k] || '');
      return 'background:' + res(s.fill || 'transparent') + ';color:' + res(s.color || 'inherit') + ';border:' + (s.borderWidth || 1) + 'px solid ' + res(s.borderColor || '#E2E8F0') + ';border-radius:' + (typeof s.radius === 'number' ? s.radius : 6) + 'px';
    }
    container.addEventListener('click', e => {
      const t = e.target.closest('button');
      if (!t || t.disabled) return;
      const L = lib();
      if (t.dataset.act === 'save-comp') {
        const name = prompt('Component name', Core.displayName(store.doc, store.doc.elements[store.selection[0]]) || 'Component');
        if (!name) return;
        L.components.push({ id: Core.uid('cmp'), name: name.trim().slice(0, 120), snapshot: cmds.snapshot(), createdAt: new Date().toISOString() });
        opts.saveLibrary();
      } else if (t.dataset.insert) { opts.insertComponent(t.dataset.insert); }
      else if (t.dataset.delComp) { if (!confirm('Delete this component from the library? Surveys that use it keep their copy.')) return; L.components = L.components.filter(c => c.id !== t.dataset.delComp); opts.saveLibrary(); }
      else if (t.dataset.act === 'save-style') {
        const el = store.doc.elements[store.selection[0]];
        const name = prompt('Style name', Core.typeLabel(el.type) + ' style');
        if (!name) return;
        L.styles.push({ id: Core.uid('sty'), name: name.trim().slice(0, 120), style: Core.clone(Core.resolveStyle(store.doc, el)), type: el.type });
        opts.saveLibrary();
      } else if (t.dataset.applyStyle) { const s = L.styles.find(x => x.id === t.dataset.applyStyle); if (s) cmds.applyStyle(store.selection, s.style, 'Apply style “' + s.name + '”'); }
      else if (t.dataset.delStyle) { L.styles = L.styles.filter(x => x.id !== t.dataset.delStyle); opts.saveLibrary(); }
      else if (t.dataset.act === 'copy-style') cmds.copyStyle();
      else if (t.dataset.act === 'paste-style') cmds.pasteStyle();
      render();
    });
    const off = store.on(type => { if (type === 'select') render(); });
    render();
    return { render, destroy: off };
  }

  root.SurveyPanels = { createPalette, createLayers, createLibrary };
})(typeof window !== 'undefined' ? window : this);
