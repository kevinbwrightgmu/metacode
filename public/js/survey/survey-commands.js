/* ══════════════════════════════════════════════
   survey-commands.js — editing operations

   Every way of changing a survey (canvas, layers panel, inspector buttons,
   keyboard shortcuts, context menu) calls these, so each operation is one
   undoable transaction with consistent rules:
     add · delete · duplicate · copy / paste (also across surveys and tabs)
     group / ungroup · reorder layers · move into containers
     align / distribute · lock / hide · copy / paste style · pages
     question helpers (options, ranking items, matrix rows, rating scale)
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore;
  const { num, clone, isContainerType } = Core;
  const CLIP_KEY = 'metacode_survey_clipboard_v1';
  const STYLE_CLIP_KEY = 'metacode_survey_style_clipboard_v1';

  function create(store, env) {
    env = env || {};
    // measure(id) → { w, h } from the canvas (sizes of auto-sized elements)
    const measure = id => (env.measure && env.measure(id)) || sizeOf(id);
    const doc = () => store.doc;
    const notify = (msg, type) => env.notify && env.notify(msg, type);

    function sizeOf(id) {
      const el = doc().elements[id];
      return { w: typeof el.frame.w === 'number' ? el.frame.w : 200, h: typeof el.frame.h === 'number' ? el.frame.h : 60 };
    }
    function parentRefOf(id) { const el = doc().elements[id]; return el ? el.parent : null; }
    function siblings(id) { return Core.childIds(doc(), parentRefOf(id)); }
    function isFreeIn(id) {
      const el = doc().elements[id];
      if (!el) return false;
      return Core.layoutOf(doc(), el.parent).mode === 'free' || el.frame.pos === 'free';
    }
    // Axis-aligned box of an element in its parent's space.
    function boxOf(id) {
      const el = doc().elements[id];
      const { w, h } = measure(id);
      const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => Core.localToParent(el.frame, w, h, x, y));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys), w, h };
    }

    function canContain(parentRef, type) {
      const pid = Core.pageIdOfRef(parentRef);
      if (type === 'tabpanel') { const p = doc().elements[parentRef]; return !!(p && p.type === 'tabs'); }
      if (type === 'matrixrow') { const p = doc().elements[parentRef]; return !!(p && p.type === 'matrixgrid'); }
      if (pid) return true;
      const p = doc().elements[parentRef];
      if (!p || !isContainerType(p.type)) return false;
      if (p.type === 'tabs') return type === 'tabpanel';
      if (p.type === 'matrixgrid') return type === 'matrixrow';
      return true;
    }

    // Lowest point of the page content (for placing new elements).
    function contentBottom(page) {
      let bottom = 24;
      page.children.forEach(id => {
        const el = doc().elements[id];
        if (!el || el.frame.dock === 'bottom' || el.hidden) return;
        bottom = Math.max(bottom, boxOf(id).b);
      });
      return bottom;
    }

    // Inserts an instantiated tree. parentRef: 'page:<id>' or element id.
    function insertTree(t, tree, parentRef, index, at) {
      Object.values(tree.elements).forEach(el => t.addEl(el));
      const root = doc().elements[tree.rootId];
      root.parent = parentRef;
      const list = t.children(parentRef);
      const i = index === undefined || index === null || index < 0 || index > list.length ? list.length : index;
      list.splice(i, 0, tree.rootId);
      const free = Core.layoutOf(doc(), parentRef).mode === 'free';
      if (free) {
        root.frame.pos = 'free';
        if (at) { root.frame.x = Math.round(at.x); root.frame.y = Math.round(at.y); }
      } else if (Core.pageIdOfRef(parentRef) === null) {
        root.frame.pos = 'flow';
        if (typeof root.frame.w === 'number' && root.frame.w > 400) root.frame.w = 'fill';
      }
      return tree.rootId;
    }

    // Where a new element goes when the user doesn't say: inside the
    // selected container (if it takes children) or below the page content.
    function defaultTarget(type) {
      const sel = store.selection;
      if (sel.length === 1) {
        const el = doc().elements[sel[0]];
        if (el && isContainerType(el.type) && !Core.isQuestionType(el.type) && canContain(el.id, type) && el.type !== 'option' && el.type !== 'choices') return { parentRef: el.id };
      }
      const page = store.page;
      const width = num(doc().settings.width, 760);
      return { parentRef: 'page:' + page.id, at: { x: 48, y: contentBottom(page) + 24 }, width };
    }

    function addElement(type, o) {
      o = o || {};
      const tree = Core.buildElement(type);
      const root = tree.elements[tree.rootId];
      const target = o.parentRef ? { parentRef: o.parentRef, at: o.at } : defaultTarget(type);
      if (!canContain(target.parentRef, type)) { notify(Core.typeLabel(type) + ' can\'t go there.', 'error'); return null; }
      if (Core.pageIdOfRef(target.parentRef) && typeof root.frame.w === 'number') {
        const maxW = num(doc().settings.width, 760) - 96;
        if (root.frame.w > maxW) root.frame.w = Math.max(80, maxW);
      }
      if (o.size) { root.frame.w = Math.max(4, Math.round(o.size.w)); root.frame.h = Math.max(4, Math.round(o.size.h)); }
      if (o.props) Object.assign(root.props, o.props);
      let id = null;
      store.tx('Add ' + Core.typeLabel(type).toLowerCase(), t => { id = insertTree(t, tree, target.parentRef, o.index, o.at || target.at); });
      store.select([id]);
      return id;
    }

    function removeIds(t, ids) {
      const all = new Set();
      ids.forEach(id => { if (doc().elements[id]) { all.add(id); Core.descendants(doc(), id).forEach(d => all.add(d)); } });
      // detach top-level ones from their parents
      ids.forEach(id => {
        const el = doc().elements[id];
        if (!el) return;
        const list = t.children(el.parent);
        if (list) { const i = list.indexOf(id); if (i !== -1) list.splice(i, 1); }
      });
      all.forEach(id => t.removeEl(id));
    }

    // Copies of answer options / ranking items / matrix rows need their own
    // stored value, or choosing one would also select its twin.
    function uniquifyValues(newIds) {
      const d = doc();
      newIds.forEach(rootId => {
        [rootId].concat(Core.descendants(d, rootId)).forEach(id => {
          const el = d.elements[id];
          if (!el || !['option', 'rankitem', 'matrixrow'].includes(el.type)) return;
          const q = Core.questionOf(d, id);
          if (!q) return;
          const taken = new Set(Core.questionParts(d, q.id, el.type).filter(o => o.id !== id).map(o => String(o.props.value)));
          if (!taken.has(String(el.props.value))) return;
          if (typeof el.props.value === 'number') { let v = el.props.value + 1; while (taken.has(String(v))) v++; el.props.value = v; return; }
          const base = String(el.props.value).replace(/_\d+$/, '') || 'option';
          let n = 2; while (taken.has(base + '_' + n)) n++;
          el.props.value = base + '_' + n;
        });
      });
    }

    function topLevel(ids) {
      const set = new Set(ids);
      return ids.filter(id => doc().elements[id] && !Core.ancestors(doc(), id).some(a => set.has(a)));
    }

    function deleteSelection(ids) {
      ids = topLevel(ids || store.selection);
      if (!ids.length) return;
      const locked = ids.filter(id => doc().elements[id].locked);
      ids = ids.filter(id => !doc().elements[id].locked);
      if (locked.length && !ids.length) { notify('Locked elements can\'t be deleted — unlock them first.', 'error'); return; }
      const parents = ids.map(parentRefOf);
      store.tx(ids.length === 1 ? 'Delete ' + Core.typeLabel(doc().elements[ids[0]].type).toLowerCase() : 'Delete ' + ids.length + ' elements', t => removeIds(t, ids));
      // select the parent (if it's an element) to keep context
      const p = parents.find(r => r && !Core.pageIdOfRef(r) && doc().elements[r]);
      store.select(p ? [p] : []);
    }

    function duplicate(ids, offset) {
      ids = topLevel(ids || store.selection);
      if (!ids.length) return [];
      const out = [];
      store.tx(ids.length === 1 ? 'Duplicate' : 'Duplicate ' + ids.length + ' elements', t => {
        ids.forEach(id => {
          const el = doc().elements[id];
          const copy = Core.copySubtree(doc().elements, id, el.parent);
          const rootEl = copy.elements[copy.rootId];
          const list = t.children(el.parent);
          const idx = list.indexOf(id) + 1;
          Object.values(copy.elements).forEach(e => t.addEl(e));
          list.splice(idx, 0, copy.rootId);
          if (isFreeIn(id)) { rootEl.frame.x = num(rootEl.frame.x, 0) + (offset === undefined ? 16 : offset); rootEl.frame.y = num(rootEl.frame.y, 0) + (offset === undefined ? 16 : offset); }
          rootEl.locked = false;
          out.push(copy.rootId);
        });
        out.forEach(id => t.el(id));
        uniquifyValues(out);
      });
      store.select(out);
      return out;
    }

    /* ── Clipboard ─────────────────────────── */
    function copy(ids, cut) {
      ids = topLevel(ids || store.selection);
      if (!ids.length) return false;
      const elements = {};
      ids.forEach(id => { elements[id] = clone(doc().elements[id]); Core.descendants(doc(), id).forEach(d => { elements[d] = clone(doc().elements[d]); }); });
      const payload = { kind: 'metacode-survey-elements', v: 1, from: doc().id, roots: ids, elements, theme: { types: clone(doc().theme.types) } };
      const text = JSON.stringify(payload);
      try { localStorage.setItem(CLIP_KEY, text); } catch (e) { notify('The selection is too large for the clipboard.', 'error'); return false; }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
      if (cut) deleteSelection(ids);
      notify((cut ? 'Cut ' : 'Copied ') + ids.length + ' element' + (ids.length === 1 ? '' : 's'), 'info');
      return true;
    }
    function readClipboard(text) {
      let raw = text;
      if (!raw) { try { raw = localStorage.getItem(CLIP_KEY); } catch (e) { raw = null; } }
      if (!raw) return null;
      try { const p = JSON.parse(raw); return p && p.kind === 'metacode-survey-elements' && Array.isArray(p.roots) ? p : null; } catch (e) { return null; }
    }
    function paste(text, at) {
      const clip = readClipboard(text);
      if (!clip) { notify('Nothing to paste — copy elements first.', 'info'); return []; }
      // Paste into the selected container (if it accepts them), else the page.
      const sel = store.selection;
      let parentRef = 'page:' + store.page.id;
      if (sel.length === 1) {
        const el = doc().elements[sel[0]];
        if (el && isContainerType(el.type) && clip.roots.every(r => clip.elements[r] && canContain(el.id, clip.elements[r].type))) parentRef = el.id;
        else if (el && el.parent && !Core.pageIdOfRef(el.parent) && clip.roots.every(r => clip.elements[r] && canContain(el.parent, clip.elements[r].type))) parentRef = el.parent;
      }
      const out = [];
      const sameSurvey = clip.from === doc().id;
      store.tx('Paste', t => {
        clip.roots.forEach((rid, i) => {
          if (!clip.elements[rid]) return;
          if (!canContain(parentRef, clip.elements[rid].type)) return;
          const copied = Core.copySubtree(clip.elements, rid, parentRef);
          const free = Core.layoutOf(doc(), parentRef).mode === 'free';
          const rootEl = copied.elements[copied.rootId];
          if (free) {
            rootEl.frame.pos = 'free';
            if (at) { rootEl.frame.x = Math.round(at.x) + i * 12; rootEl.frame.y = Math.round(at.y) + i * 12; }
            else if (sameSurvey) { rootEl.frame.x = num(rootEl.frame.x, 0) + 24; rootEl.frame.y = num(rootEl.frame.y, 0) + 24; }
          }
          // keep the source survey's look for pasted elements (theme type styles)
          if (!sameSurvey && clip.theme && clip.theme.types) {
            Object.values(copied.elements).forEach(e => { const ts = clip.theme.types[e.type]; if (ts) e.style = Core.deepMerge(ts, e.style); });
          }
          insertTree(t, copied, parentRef, undefined, null);
          out.push(copied.rootId);
        });
        uniquifyValues(out);
      });
      if (!out.length) notify('Those elements can\'t be pasted here.', 'error');
      store.select(out);
      return out;
    }

    function copyStyle(id) {
      const el = doc().elements[id || store.primary];
      if (!el) return;
      try { localStorage.setItem(STYLE_CLIP_KEY, JSON.stringify({ style: el.style || {}, type: el.type })); } catch (e) { return; }
      notify('Style copied', 'info');
    }
    function pasteStyle(ids) {
      let clip = null;
      try { clip = JSON.parse(localStorage.getItem(STYLE_CLIP_KEY) || 'null'); } catch (e) { clip = null; }
      if (!clip) { notify('Copy a style first.', 'info'); return; }
      applyStyle(ids || store.selection, clip.style, 'Paste style');
    }
    function applyStyle(ids, style, label) {
      if (!ids.length) return;
      store.tx(label || 'Apply style', t => ids.forEach(id => { const el = t.el(id); if (el) el.style = clone(style || {}); }));
    }

    /* ── Grouping & layers ─────────────────── */
    function group(ids) {
      ids = topLevel(ids || store.selection);
      if (ids.length < 1) return null;
      const parent = parentRefOf(ids[0]);
      if (!ids.every(id => parentRefOf(id) === parent)) { notify('Group elements that share the same parent.', 'error'); return null; }
      const boxes = ids.map(boxOf);
      const gx = Math.min(...boxes.map(b => b.x)), gy = Math.min(...boxes.map(b => b.y));
      const gr = Math.max(...boxes.map(b => b.r)), gb = Math.max(...boxes.map(b => b.b));
      const freeParent = Core.layoutOf(doc(), parent).mode === 'free';
      const tree = Core.buildElement('group');
      const g = tree.elements[tree.rootId];
      g.name = 'Group';
      Object.assign(g.frame, { x: Math.round(gx), y: Math.round(gy), w: Math.round(gr - gx), h: 'auto', pos: freeParent ? 'free' : 'flow' });
      store.tx('Group', t => {
        const list = t.children(parent);
        const idx = Math.min(...ids.map(id => list.indexOf(id)));
        const order = list.filter(id => ids.includes(id));
        order.forEach(id => list.splice(list.indexOf(id), 1));
        t.addEl(g);
        g.parent = parent;
        list.splice(idx, 0, g.id);
        order.forEach(id => {
          const el = t.el(id);
          const b = boxOf(id);
          const free = isFreeInParentBefore(el, parent);
          el.parent = g.id;
          el.frame.pos = 'free';
          el.frame.x = Math.round((free ? num(el.frame.x, 0) : b.x) - gx);
          el.frame.y = Math.round((free ? num(el.frame.y, 0) : b.y) - gy);
          g.children.push(id);
        });
      });
      store.select([g.id]);
      return g.id;
    }
    function isFreeInParentBefore(el, parent) { return Core.layoutOf(doc(), parent).mode === 'free' || el.frame.pos === 'free'; }

    function ungroup(ids) {
      ids = (ids || store.selection).filter(id => { const el = doc().elements[id]; return el && isContainerType(el.type) && !Core.isQuestionType(el.type) && !['option', 'choices', 'matrixgrid', 'tabs', 'tabpanel'].includes(el.type); });
      if (!ids.length) { notify('Select a group or container to ungroup.', 'info'); return; }
      const out = [];
      store.tx('Ungroup', t => {
        ids.forEach(gid => {
          const g = doc().elements[gid];
          const parent = g.parent;
          const list = t.children(parent);
          let idx = list.indexOf(gid);
          const freeParent = Core.layoutOf(doc(), parent).mode === 'free';
          const gLay = (g.props && g.props.layout) || { mode: 'free' };
          g.children.slice().forEach(cid => {
            const c = t.el(cid);
            const b = boxOf(cid);
            c.parent = parent;
            if (freeParent) {
              const free = gLay.mode === 'free' || c.frame.pos === 'free';
              const lx = free ? num(c.frame.x, 0) : b.x, ly = free ? num(c.frame.y, 0) : b.y;
              const p = Core.localToParent(g.frame, measure(gid).w, measure(gid).h, lx, ly);
              c.frame.x = Math.round(p.x); c.frame.y = Math.round(p.y);
              c.frame.rot = num(c.frame.rot, 0) + num(g.frame.rot, 0);
              c.frame.pos = 'free';
            } else c.frame.pos = 'flow';
            list.splice(++idx, 0, cid);
            out.push(cid);
          });
          list.splice(list.indexOf(gid), 1);
          t.removeEl(gid);
        });
      });
      store.select(out);
    }

    function reorder(ids, how) {
      ids = topLevel(ids || store.selection);
      if (!ids.length) return;
      const labels = { forward: 'Bring forward', backward: 'Send backward', front: 'Bring to front', back: 'Send to back' };
      store.tx(labels[how] || 'Reorder', t => {
        const byParent = {};
        ids.forEach(id => { (byParent[parentRefOf(id)] = byParent[parentRefOf(id)] || []).push(id); });
        Object.keys(byParent).forEach(parent => {
          const list = t.children(parent);
          const sel = byParent[parent].slice().sort((a, b) => list.indexOf(a) - list.indexOf(b));
          if (how === 'front') { sel.forEach(id => list.splice(list.indexOf(id), 1)); list.push(...sel); }
          else if (how === 'back') { sel.forEach(id => list.splice(list.indexOf(id), 1)); list.unshift(...sel); }
          else if (how === 'forward') { sel.slice().reverse().forEach(id => { const i = list.indexOf(id); if (i < list.length - 1 && !sel.includes(list[i + 1])) { list.splice(i, 1); list.splice(i + 1, 0, id); } }); }
          else if (how === 'backward') { sel.forEach(id => { const i = list.indexOf(id); if (i > 0 && !sel.includes(list[i - 1])) { list.splice(i, 1); list.splice(i - 1, 0, id); } }); }
        });
      });
    }

    // Moves elements into another parent at an index (layers drag & drop).
    function moveTo(ids, parentRef, index) {
      ids = topLevel(ids);
      if (!ids.length) return false;
      if (ids.some(id => id === parentRef || Core.isAncestor(doc(), id, parentRef))) { notify('An element can\'t be moved inside itself.', 'error'); return false; }
      if (!ids.every(id => canContain(parentRef, doc().elements[id].type))) { notify('Those elements can\'t go there.', 'error'); return false; }
      store.tx('Move', t => {
        const target = t.children(parentRef);
        let at = index === undefined || index === null ? target.length : index;
        ids.forEach(id => {
          const el = t.el(id);
          const from = t.children(el.parent);
          const i = from.indexOf(id);
          if (from === target && i !== -1 && i < at) at--;
          if (i !== -1) from.splice(i, 1);
          const crossing = el.parent !== parentRef;
          el.parent = parentRef;
          const free = Core.layoutOf(doc(), parentRef).mode === 'free';
          if (free) { el.frame.pos = 'free'; if (crossing) { el.frame.x = Math.max(0, num(el.frame.x, 0)); el.frame.y = Math.max(0, num(el.frame.y, 0)); } }
          else if (crossing) el.frame.pos = 'flow';
          target.splice(Math.max(0, Math.min(at, target.length)), 0, id);
          at++;
        });
      });
      return true;
    }

    function setFlag(ids, flag, value) {
      ids = ids || store.selection;
      if (!ids.length) return;
      const v = value === undefined ? !ids.every(id => doc().elements[id] && doc().elements[id][flag]) : value;
      store.tx((v ? '' : 'Un') + (flag === 'locked' ? 'lock' : 'hide'), t => ids.forEach(id => { const el = t.el(id); if (el) el[flag] = v; }));
    }

    /* ── Align & distribute (free elements in one parent) ── */
    function align(ids, mode) {
      ids = topLevel(ids || store.selection).filter(isFreeIn);
      if (!ids.length) { notify('Align works on freely positioned elements.', 'info'); return; }
      let ref;
      if (ids.length === 1) {
        const parent = parentRefOf(ids[0]);
        const pid = Core.pageIdOfRef(parent);
        const pw = pid ? num(doc().settings.width, 760) : measure(parent).w;
        const ph = pid ? (env.pageHeight ? env.pageHeight() : 800) : measure(parent).h;
        ref = { x: 0, y: 0, r: pw, b: ph };
      } else {
        const bs = ids.map(boxOf);
        ref = { x: Math.min(...bs.map(b => b.x)), y: Math.min(...bs.map(b => b.y)), r: Math.max(...bs.map(b => b.r)), b: Math.max(...bs.map(b => b.b)) };
      }
      store.tx('Align ' + mode, t => ids.forEach(id => {
        const b = boxOf(id); const el = t.el(id);
        let dx = 0, dy = 0;
        if (mode === 'left') dx = ref.x - b.x;
        if (mode === 'center') dx = (ref.x + ref.r) / 2 - (b.x + b.r) / 2;
        if (mode === 'right') dx = ref.r - b.r;
        if (mode === 'top') dy = ref.y - b.y;
        if (mode === 'middle') dy = (ref.y + ref.b) / 2 - (b.y + b.b) / 2;
        if (mode === 'bottom') dy = ref.b - b.b;
        el.frame.x = Math.round(num(el.frame.x, 0) + dx);
        el.frame.y = Math.round(num(el.frame.y, 0) + dy);
      }));
    }
    function distribute(ids, axis) {
      ids = topLevel(ids || store.selection).filter(isFreeIn);
      if (ids.length < 3) { notify('Select three or more elements to distribute.', 'info'); return; }
      const items = ids.map(id => ({ id, b: boxOf(id) })).sort((a, c) => (axis === 'h' ? a.b.x - c.b.x : a.b.y - c.b.y));
      const first = items[0].b, last = items[items.length - 1].b;
      const total = items.reduce((s, it) => s + (axis === 'h' ? it.b.r - it.b.x : it.b.b - it.b.y), 0);
      const span = axis === 'h' ? last.r - first.x : last.b - first.y;
      const gap = (span - total) / (items.length - 1);
      let pos = axis === 'h' ? first.x : first.y;
      store.tx('Distribute', t => items.forEach(it => {
        const el = t.el(it.id);
        const size = axis === 'h' ? it.b.r - it.b.x : it.b.b - it.b.y;
        const d = pos - (axis === 'h' ? it.b.x : it.b.y);
        if (axis === 'h') el.frame.x = Math.round(num(el.frame.x, 0) + d); else el.frame.y = Math.round(num(el.frame.y, 0) + d);
        pos += size + gap;
      }));
    }

    function nudge(ids, dx, dy) {
      ids = topLevel(ids || store.selection).filter(id => !doc().elements[id].locked);
      const free = ids.filter(isFreeIn);
      if (!free.length) {
        // flow elements: arrow keys reorder within their stack
        if (ids.length === 1 && (dx || dy)) reorderFlow(ids[0], (dy || dx) > 0 ? 1 : -1);
        return;
      }
      store.tx('Move', t => free.forEach(id => { const el = t.el(id); el.frame.x = Math.round(num(el.frame.x, 0) + dx); el.frame.y = Math.round(num(el.frame.y, 0) + dy); }), { coalesce: 'nudge' });
    }
    function reorderFlow(id, dir) {
      const list = siblings(id);
      const i = list.indexOf(id), j = i + dir;
      if (j < 0 || j >= list.length) return;
      store.tx('Reorder', t => { const l = t.children(parentRefOf(id)); l.splice(i, 1); l.splice(j, 0, id); }, { coalesce: 'reorder-flow' });
    }

    /* ── Pages ─────────────────────────────── */
    function addPage(afterId) {
      let page = null;
      store.tx('Add page', t => {
        const pages = t.pages();
        page = Core.createPage('Page ' + (pages.length + 1));
        const idx = afterId ? pages.findIndex(p => p.id === afterId) + 1 : pages.length;
        pages.splice(idx, 0, page);
        const tree = Core.instantiate(Core.navSpec());
        Object.values(tree.elements).forEach(e => t.addEl(e));
        const nav = doc().elements[tree.rootId];
        nav.parent = 'page:' + page.id; nav.frame.pos = 'free';
        page.children.push(tree.rootId);
        const h = Core.buildElement('heading');
        h.elements[h.rootId].props.text = page.name;
        Object.assign(h.elements[h.rootId].frame, { x: 48, y: 48, pos: 'free' });
        Object.values(h.elements).forEach(e => t.addEl(e));
        doc().elements[h.rootId].parent = 'page:' + page.id;
        page.children.unshift(h.rootId);
      });
      store.setPage(page.id);
      return page;
    }
    function duplicatePage(pid) {
      const src = Core.getPage(doc(), pid);
      if (!src) return;
      let page = null;
      store.tx('Duplicate page', t => {
        const pages = t.pages();
        page = Object.assign(Core.createPage(src.name + ' copy'), { minHeight: src.minHeight, style: clone(src.style), props: clone(src.props) });
        src.children.forEach(cid => {
          const copied = Core.copySubtree(doc().elements, cid, 'page:' + page.id);
          Object.values(copied.elements).forEach(e => t.addEl(e));
          page.children.push(copied.rootId);
        });
        pages.splice(pages.indexOf(src) + 1, 0, page);
      });
      store.setPage(page.id);
    }
    function deletePage(pid) {
      if (doc().pages.length <= 1) { notify('A survey needs at least one page.', 'error'); return false; }
      const page = Core.getPage(doc(), pid);
      if (!page) return false;
      const idx = doc().pages.indexOf(page);
      store.tx('Delete page', t => {
        removeIds(t, page.children.slice());
        const pages = t.pages();
        pages.splice(pages.findIndex(p => p.id === pid), 1);
      });
      store.setPage(doc().pages[Math.max(0, idx - 1)].id);
      return true;
    }
    function movePage(pid, dir) {
      const i = doc().pages.findIndex(p => p.id === pid), j = i + dir;
      if (i < 0 || j < 0 || j >= doc().pages.length) return;
      store.tx('Move page', t => { const pages = t.pages(); const [p] = pages.splice(i, 1); pages.splice(j, 0, p); });
    }
    function updatePage(pid, fn, label) {
      store.tx(label || 'Edit page', t => { const p = t.pages().find(x => x.id === pid); if (p) fn(p); }, { coalesce: 'page-' + pid + '-' + (label || '') });
    }

    /* ── Question helpers ─────────────────── */
    function choicesOf(qid) { return Core.questionParts(doc(), qid, 'choices')[0] || null; }
    function addOption(qid) {
      const q = doc().elements[qid];
      const opts = Core.questionParts(doc(), qid, 'option');
      const group = choicesOf(qid);
      if (!group) return null;
      let newId = null;
      store.tx('Add option', t => {
        const n = opts.length + 1;
        let copied;
        if (opts.length) copied = Core.copySubtree(doc().elements, opts[opts.length - 1].id, group.id);
        else {
          const kind = q.type === 'multiple' ? 'checkbox' : 'radio';
          copied = Core.instantiate(Core.spec('option', { props: { value: 'option_' + n, score: 0, layout: { mode: 'stack', dir: 'h', gap: 10, align: 'center' } }, frame: { w: 'fill', h: 'auto' },
            children: [Core.spec('indicator', { props: { shape: kind }, frame: { w: 20, h: 20 } }), Core.spec('optlabel', { props: { text: 'Option ' + n }, frame: { w: 'fill', h: 'auto' } })] }), group.id);
        }
        const rootEl = copied.elements[copied.rootId];
        const isNumeric = typeof rootEl.props.value === 'number';
        rootEl.props.value = isNumeric ? Math.max(0, ...opts.map(o => num(o.props.value, 0))) + 1 : 'option_' + n + (opts.some(o => o.props.value === 'option_' + n) ? '_' + Date.now().toString(36).slice(-3) : '');
        if (isNumeric) rootEl.props.score = rootEl.props.value;
        Object.values(copied.elements).forEach(e => { if (e.type === 'optlabel') e.props.text = 'Option ' + n; });
        insertTree(t, copied, group.id);
        newId = copied.rootId;
      });
      store.select([newId]);
      return newId;
    }
    function addListItem(qid, type) {
      const parent = type === 'matrixrow' ? Core.questionParts(doc(), qid, 'matrixgrid')[0] : choicesOf(qid);
      if (!parent) return null;
      const items = Core.questionParts(doc(), qid, type);
      const n = items.length + 1;
      let id = null;
      store.tx(type === 'matrixrow' ? 'Add row' : 'Add item', t => {
        const copied = items.length ? Core.copySubtree(doc().elements, items[items.length - 1].id, parent.id)
          : Core.instantiate(Core.spec(type, { props: {}, frame: { w: 'fill', h: 'auto' } }), parent.id);
        const r = copied.elements[copied.rootId];
        r.props.label = (type === 'matrixrow' ? 'Row ' : 'Item ') + n;
        r.props.value = (type === 'matrixrow' ? 'row_' : 'item_') + n + (items.some(i => i.props.value === (type === 'matrixrow' ? 'row_' : 'item_') + n) ? '_' + Date.now().toString(36).slice(-3) : '');
        insertTree(t, copied, parent.id);
        id = copied.rootId;
      });
      store.select([id]);
      return id;
    }
    // Rating: rebuild the scale with n options, keeping the first option's look.
    function setRatingCount(qid, n) {
      n = Math.max(2, Math.min(20, Math.round(num(n, 5))));
      const opts = Core.questionParts(doc(), qid, 'option');
      const group = choicesOf(qid);
      if (!group || !opts.length || opts.length === n) return;
      store.tx('Change scale', t => {
        if (opts.length > n) removeIds(t, opts.slice(n).map(o => o.id));
        else for (let i = opts.length; i < n; i++) {
          const copied = Core.copySubtree(doc().elements, opts[opts.length - 1].id, group.id);
          copied.elements[copied.rootId].props.value = i + 1;
          copied.elements[copied.rootId].props.score = i + 1;
          insertTree(t, copied, group.id);
        }
      });
    }
    function addQuestionPart(qid, type) {
      const q = doc().elements[qid];
      if (Core.questionParts(doc(), qid, type).length) return;
      const tree = Core.instantiate(Core.spec(type, { props: { text: type === 'qdesc' ? 'Add a short description' : '' }, frame: { w: 'fill', h: 'auto' } }), qid);
      store.tx(type === 'qdesc' ? 'Add description' : 'Add validation message', t => {
        const title = Core.questionParts(doc(), qid, 'qtitle')[0];
        const list = t.children(qid);
        const idx = type === 'qdesc' && title ? list.indexOf(title.id) + 1 : list.length;
        insertTree(t, tree, q.id, idx);
      });
      store.select([tree.rootId]);
    }

    /* ── Library (components / styles) ───── */
    function snapshot(ids) {
      ids = topLevel(ids || store.selection);
      const elements = {};
      ids.forEach(id => { elements[id] = clone(doc().elements[id]); Core.descendants(doc(), id).forEach(d => { elements[d] = clone(doc().elements[d]); }); });
      return { roots: ids, elements, theme: { types: clone(doc().theme.types) } };
    }
    function insertSnapshot(snap, label) {
      const text = JSON.stringify(Object.assign({ kind: 'metacode-survey-elements', v: 1, from: 'library' }, snap));
      store.select([]);
      const page = store.page;
      const out = paste(text, { x: 48, y: contentBottom(page) + 24 });
      void label;
      return out;
    }

    return {
      addElement, deleteSelection, duplicate, copy, paste, readClipboard, copyStyle, pasteStyle, applyStyle,
      group, ungroup, reorder, moveTo, setFlag, align, distribute, nudge, reorderFlow, canContain, topLevel,
      addPage, duplicatePage, deletePage, movePage, updatePage,
      addOption, addListItem, setRatingCount, addQuestionPart,
      snapshot, insertSnapshot, contentBottom, boxOf, isFreeIn, insertTree
    };
  }

  root.SurveyCommands = { create };
})(typeof window !== 'undefined' ? window : this);
