/* ══════════════════════════════════════════════
   survey-canvas.js — the editor's visual canvas

   The survey is rendered by SurveyRender (design mode) inside a pannable,
   zoomable world. On top sits an overlay with selection outlines and
   handles, computed from each element's real transform matrix, so handles
   follow rotated, skewed, scaled and nested elements exactly.

   Interactions:
     click → select (siblings stay in scope; double-click drills into
       groups/questions down to a single option, indicator or label;
       Ctrl/⌘-click selects the deepest element directly)
     drag → move (smart guides + grid snapping; Alt-drag duplicates;
       elements in a stack layout are reordered instead)
     handles → resize (Shift: keep proportions, Alt: from the centre),
       rotate (Shift: 15° steps); Scale tool (K) changes scale instead of size
     marquee · Space/H/middle-drag to pan · Ctrl+wheel or pinch to zoom
     double-click text → edit in place · drop palette items onto the canvas
     T / R / F tools draw text, shapes and containers
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore, Logic = root.SurveyLogic, Render = root.SurveyRender;
  const { num, clamp } = Core;

  const TEXT_EDIT = {
    heading: ['.sv-text', 'text'], paragraph: ['.sv-text', 'text'], label: ['.sv-text', 'text'], instructions: ['.sv-text', 'text'],
    caption: ['.sv-text', 'text'], richtext: ['.sv-text', 'text', true], qtitle: ['.sv-text', 'text'], qdesc: ['.sv-text', 'text'],
    optlabel: ['.sv-text', 'text'], qerror: ['.sv-text', 'text'], button: ['.sv-text', 'text'],
    rankitem: ['.sv-rank-label', 'label'], matrixrow: ['.sv-matrix-rowlabel', 'label']
  };
  const SINGLE_LINE = new Set(['heading', 'label', 'caption', 'qtitle', 'optlabel', 'button', 'rankitem', 'matrixrow']);
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_POS = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
  const SNAP_PX = 6;

  function create(container, store, cmds, opts) {
    opts = opts || {};
    const doc = () => store.doc;
    let zoom = 1, panX = 40, panY = 32;
    let tool = 'select';
    let showGrid = false, snapOn = true;
    let spaceDown = false;
    let hoverId = null;
    let drag = null;
    let editing = null;
    let guides = [];
    let insertLine = null;
    let ghosts = new Set();
    let forced = null;
    const pointers = new Map();

    container.innerHTML = '';
    const viewport = el('div', 'ss-viewport', { tabindex: '0', role: 'application', 'aria-label': 'Survey canvas. Use the layers panel or arrow keys to work with elements.' });
    const world = el('div', 'ss-world');
    const gridLayer = el('div', 'ss-gridlayer', { 'aria-hidden': 'true' });
    const overlay = el('div', 'ss-overlay', { 'aria-hidden': 'true' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ss-overlay-svg');
    overlay.appendChild(svg);
    const marquee = el('div', 'ss-marquee');
    const sizeBadge = el('div', 'ss-size-badge');
    const richBar = el('div', 'ss-richbar', { role: 'toolbar', 'aria-label': 'Text formatting' });
    richBar.innerHTML = [['bold', 'B', 'Bold (Ctrl+B)'], ['italic', 'I', 'Italic (Ctrl+I)'], ['underline', 'U', 'Underline (Ctrl+U)'], ['insertUnorderedList', '•', 'Bulleted list'], ['createLink', '🔗', 'Link'], ['removeFormat', '⨯', 'Clear formatting']]
      .map(([c, l, t]) => '<button type="button" data-cmd="' + c + '" title="' + t + '" aria-label="' + t + '">' + l + '</button>').join('');
    viewport.appendChild(world);
    viewport.appendChild(overlay);
    viewport.appendChild(marquee);
    viewport.appendChild(sizeBadge);
    viewport.appendChild(richBar);
    container.appendChild(viewport);

    const renderer = Render.create(world, store.doc, { mode: 'design', decorate, onLayout: () => { positionGrid(); scheduleOverlay(); } });
    world.appendChild(gridLayer);

    function el(tag, cls, attrs) { const n = document.createElement(tag); if (cls) n.className = cls; if (attrs) Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k])); return n; }

    function computeGhosts() {
      ghosts = new Set();
      Object.values(doc().elements).forEach(e => { if (e.behavior && e.behavior.initiallyHidden) ghosts.add(e.id); });
      doc().rules.forEach(r => { if (r.enabled && (!r.trigger || r.trigger.type === 'always')) (r.then || []).forEach(a => { if (a.type === 'show' && a.target) ghosts.add(a.target); }); });
    }
    function decorate(e, node) {
      if (ghosts.has(e.id)) { node.classList.add('sv-ghost'); node.title = 'Hidden until a logic rule shows it'; }
      if (e.type === 'button' && e.props.action && e.props.action.type === 'back' && e.props.autoHide !== false) {
        const p = Core.pageOf(doc(), e.id);
        if (p && doc().pages.indexOf(p) === 0) { node.classList.add('sv-ghost'); node.title = 'Hidden on the first page (nothing to go back to)'; }
      }
    }

    /* ── View transform ─────────────────────── */
    function applyView() {
      world.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      viewport.style.setProperty('--ss-zoom', zoom);
      scheduleOverlay();
      if (opts.onZoom) opts.onZoom(zoom);
    }
    function zoomAt(z, sx, sy) {
      z = clamp(z, 0.1, 8);
      const r = viewport.getBoundingClientRect();
      const cx = sx === undefined ? r.width / 2 : sx, cy = sy === undefined ? r.height / 2 : sy;
      const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
      zoom = z;
      panX = cx - wx * zoom; panY = cy - wy * zoom;
      applyView();
    }
    function fit() {
      const r = viewport.getBoundingClientRect();
      const ab = renderer.artboard;
      const w = ab.offsetWidth || num(doc().settings.width, 760), h = ab.offsetHeight || 800;
      const z = clamp(Math.min((r.width - 80) / w, (r.height - 80) / h, 1), 0.1, 8);
      zoom = z;
      panX = (r.width - w * z) / 2 - ab.offsetLeft * z;
      panY = 32;
      applyView();
    }
    function fitWidth() {
      const r = viewport.getBoundingClientRect();
      const ab = renderer.artboard;
      const w = ab.offsetWidth || 760;
      zoom = clamp(Math.min((r.width - 64) / w, 1.5), 0.1, 8);
      panX = (r.width - w * zoom) / 2 - ab.offsetLeft * zoom;
      panY = 32;
      applyView();
    }

    /* ── Geometry helpers ───────────────────── */
    function nodeMatrix(node) {
      let m = new DOMMatrix();
      let n = node;
      let guard = 0;
      while (n && n !== world && guard++ < 200) {
        const parent = n.offsetParent;
        const cs = getComputedStyle(n);
        const t = cs.transform && cs.transform !== 'none' ? new DOMMatrix(cs.transform) : new DOMMatrix();
        const off = parent && parent !== world ? [parent.clientLeft, parent.clientTop] : [0, 0];
        const local = new DOMMatrix().translate(n.offsetLeft + off[0], n.offsetTop + off[1]).multiply(t);
        m = local.multiply(m);
        if (!parent || parent === document.body) break;
        n = parent;
      }
      return m;
    }
    const project = (m, x, y) => { const p = m.transformPoint(new DOMPoint(x, y)); return { x: p.x / (p.w || 1), y: p.y / (p.w || 1) }; };
    const toScreen = p => ({ x: p.x * zoom + panX, y: p.y * zoom + panY });
    function screenPoint(e) { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function worldPoint(e) { const s = screenPoint(e); return { x: (s.x - panX) / zoom, y: (s.y - panY) / zoom }; }
    // Matrix from an element's parent coordinate space (where its x/y live) to world.
    function parentSpaceMatrix(id) {
      const e = doc().elements[id];
      const pid = Core.pageIdOfRef(e.parent);
      const host = pid ? renderer.artboard : (renderer.childHost(e.parent) || renderer.node(e.parent));
      if (!host) return new DOMMatrix();
      return nodeMatrix(host).translate(host.clientLeft, host.clientTop);
    }
    function cornersOf(id) {
      const n = renderer.node(id);
      if (!n || !n.isConnected || n.offsetParent === null) return null;
      const m = nodeMatrix(n);
      const w = n.offsetWidth, h = n.offsetHeight;
      return { m, w, h, pts: [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => toScreen(project(m, x, y))) };
    }
    function measure(id) { const n = renderer.node(id); return n ? { w: n.offsetWidth, h: n.offsetHeight } : null; }

    /* ── Overlay ────────────────────────────── */
    let overlayQueued = false;
    function scheduleOverlay() {
      if (overlayQueued) return;
      overlayQueued = true;
      requestAnimationFrame(() => { overlayQueued = false; drawOverlay(); });
    }
    function poly(pts, cls) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      p.setAttribute('points', pts.map(q => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' '));
      p.setAttribute('class', cls);
      svg.appendChild(p);
    }
    function line(a, b, cls) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
      l.setAttribute('class', cls);
      svg.appendChild(l);
    }
    // Handles are created once and repositioned (not rebuilt) on every redraw.
    const handleEls = {};
    function handleEl(name) {
      if (!handleEls[name]) {
        const n = el('div', name === 'rot' ? 'ss-rot' : 'ss-handle ss-h-' + name, { 'data-handle': name });
        n.title = name === 'rot' ? 'Drag to rotate (Shift: 15° steps)' : 'Drag to resize (Shift: keep proportions, Alt: from centre)';
        overlay.appendChild(n);
        handleEls[name] = n;
      }
      return handleEls[name];
    }
    function drawOverlay() {
      svg.innerHTML = '';
      Object.values(handleEls).forEach(n => { n.style.display = 'none'; });
      overlay.querySelectorAll('.ss-lock-badge').forEach(n => n.remove());
      sizeBadge.style.display = 'none';
      if (editing) { positionRichBar(); }
      const sel = store.selection.filter(id => renderer.node(id));
      // scope (parent) outline
      if (sel.length) {
        const p = doc().elements[sel[0]] && doc().elements[sel[0]].parent;
        if (p && !Core.pageIdOfRef(p)) { const c = cornersOf(p); if (c) poly(c.pts, 'ss-scope'); }
      }
      if (hoverId && !sel.includes(hoverId) && !drag) { const c = cornersOf(hoverId); if (c) poly(c.pts, 'ss-hover'); }
      sel.forEach(id => {
        const c = cornersOf(id);
        if (!c) return;
        const e = doc().elements[id];
        poly(c.pts, e.locked ? 'ss-sel ss-sel-locked' : 'ss-sel');
      });
      if (sel.length === 1 && !editing) {
        const id = sel[0];
        const e = doc().elements[id];
        const c = cornersOf(id);
        if (c && e && !e.locked) {
          HANDLES.forEach(hname => {
            const [fx, fy] = HANDLE_POS[hname];
            const p = toScreen(project(c.m, fx * c.w, fy * c.h));
            const hnd = handleEl(hname);
            hnd.style.display = '';
            hnd.style.left = p.x + 'px'; hnd.style.top = p.y + 'px';
            hnd.style.cursor = cursorFor(hname, c);
            hnd.title = tool === 'scale' ? 'Drag to scale' : 'Drag to resize (Shift: keep proportions, Alt: from centre, Ctrl: scale)';
          });
          // rotation handle: above the top edge, along the element's "up"
          const top = toScreen(project(c.m, c.w / 2, 0));
          const mid = toScreen(project(c.m, c.w / 2, c.h / 2));
          const dx = top.x - mid.x, dy = top.y - mid.y;
          const len = Math.hypot(dx, dy) || 1;
          const rp = { x: top.x + dx / len * 26, y: top.y + dy / len * 26 };
          line(top, rp, 'ss-rot-line');
          const rot = handleEl('rot');
          rot.style.display = '';
          rot.style.left = rp.x + 'px'; rot.style.top = rp.y + 'px';
          const bottom = toScreen(project(c.m, c.w / 2, c.h));
          sizeBadge.style.display = 'block';
          sizeBadge.textContent = Math.round(c.w) + ' × ' + Math.round(c.h) + (num(e.frame.rot, 0) ? '  ·  ' + Math.round(num(e.frame.rot, 0) * 10) / 10 + '°' : '');
          const by = Math.max(bottom.y, ...c.pts.map(q => q.y)) + 10;
          sizeBadge.style.left = bottom.x + 'px'; sizeBadge.style.top = by + 'px';
        } else if (c && e && e.locked) {
          const b = el('div', 'ss-lock-badge'); b.textContent = '🔒 Locked';
          b.style.left = c.pts[0].x + 'px'; b.style.top = (c.pts[0].y - 22) + 'px';
          overlay.appendChild(b);
        }
      }
      guides.forEach(g => line(toScreen(g.a), toScreen(g.b), 'ss-guide'));
      if (insertLine) line(toScreen(insertLine.a), toScreen(insertLine.b), 'ss-insert');
      if (opts.onOverlay) opts.onOverlay();
    }
    function cursorFor(hname, c) {
      // pick a resize cursor matching the handle's on-screen direction
      const [fx, fy] = HANDLE_POS[hname];
      const p = toScreen(project(c.m, fx * c.w, fy * c.h)), o = toScreen(project(c.m, c.w / 2, c.h / 2));
      let a = Math.atan2(p.y - o.y, p.x - o.x) * 180 / Math.PI;
      a = (a + 360 + 22.5) % 180;
      return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.floor(a / 45) % 4];
    }

    function positionGrid() {
      const ab = renderer.artboard;
      gridLayer.style.left = (ab.offsetLeft + renderer.root.offsetLeft) + 'px';
      gridLayer.style.top = (ab.offsetTop + renderer.root.offsetTop) + 'px';
      gridLayer.style.width = ab.offsetWidth + 'px';
      gridLayer.style.height = ab.offsetHeight + 'px';
      gridLayer.style.backgroundSize = num(doc().settings.grid, 8) + 'px ' + num(doc().settings.grid, 8) + 'px';
      gridLayer.style.display = showGrid ? 'block' : 'none';
    }

    /* ── Rendering & store sync ─────────────── */
    function renderPage() {
      computeGhosts();
      renderer.renderPage(store.pageId);
      if (forced) renderer.setForcedState(forced.id, forced.state);
      revealErrors();
      positionGrid();
      scheduleOverlay();
    }
    const offStore = store.on((type, info) => {
      if (type === 'change') {
        if (editing) return;
        if (info.structure || info.logic || info.pages) { renderPage(); return; }
        if (info.theme || info.settings) { renderer.restyleAll(); if (info.settings) renderPage(); }
        const onPage = Array.from(info.ids).filter(id => renderer.node(id));
        const frameOnly = onPage.filter(id => info.frameOnly.has(id));
        const other = onPage.filter(id => !info.frameOnly.has(id));
        if (other.length) {
          // a parent's layout/style change can move its children: refresh it
          renderer.refresh(other);
          if (forced) renderer.setForcedState(forced.id, forced.state);
        }
        if (frameOnly.length) renderer.reframe(frameOnly);
        scheduleOverlay();
      } else if (type === 'page') renderPage();
      else if (type === 'select') { hoverId = null; revealErrors(); scheduleOverlay(); }
    });
    // Sample error messages ("This question is required.") only show for the
    // selected question, so the page isn't covered in red while designing.
    function revealErrors() {
      const want = new Set();
      store.selection.forEach(id => {
        const q = store.doc.elements[id] && Core.isQuestionType(store.doc.elements[id].type) ? store.doc.elements[id] : Core.questionOf(store.doc, id);
        if (q) Core.questionParts(store.doc, q.id, 'qerror').forEach(e => want.add(e.id));
      });
      let changed = false;
      container.querySelectorAll('.sv-design-sample').forEach(n => {
        const on = want.has(n.getAttribute('data-svid'));
        if (n.classList.contains('is-revealed') !== on) { n.classList.toggle('is-revealed', on); changed = true; }
      });
      if (changed) renderer.layout();
    }

    /* ── Hit testing & selection ────────────── */
    function chainAt(target) {
      const chain = [];
      let n = target && target.closest ? target.closest('[data-svid]') : null;
      while (n && renderer.root.contains(n)) {
        chain.unshift(n.dataset.svid);
        n = n.parentElement && n.parentElement.closest('[data-svid]');
      }
      return chain.filter(id => doc().elements[id] && !doc().elements[id].locked);
    }
    function pick(chain, e) {
      if (!chain.length) return null;
      if (e.ctrlKey || e.metaKey) return chain[chain.length - 1];
      const sel = store.selection;
      if (sel.length) {
        const scope = doc().elements[sel[0]] ? doc().elements[sel[0]].parent : null;
        const sameLevel = chain.find(id => doc().elements[id].parent === scope);
        if (sameLevel) return sameLevel;
        const selectedInChain = chain.find(id => sel.includes(id));
        if (selectedInChain) return selectedInChain;
      }
      return chain[0];
    }

    viewport.addEventListener('pointermove', e => {
      if (drag || pointers.size > 1) return;
      const chain = chainAt(e.target);
      const id = chain.length ? pick(chain, { ctrlKey: e.ctrlKey, metaKey: e.metaKey }) : null;
      if (id !== hoverId) { hoverId = id; scheduleOverlay(); }
    });
    viewport.addEventListener('pointerleave', () => { if (hoverId) { hoverId = null; scheduleOverlay(); } });

    /* ── Pointer interactions ───────────────── */
    viewport.addEventListener('pointerdown', e => {
      if (e.button === 2) return;
      if (editing && editing.node.contains(e.target)) return;
      if (editing) finishEdit(true);
      if (richBar.contains(e.target)) return;
      viewport.focus({ preventScroll: true });
      pointers.set(e.pointerId, screenPoint(e));
      if (pointers.size === 2) { startPinch(); return; }
      const handle = e.target.closest && e.target.closest('[data-handle]');
      if (handle) { e.preventDefault(); startHandleDrag(e, handle.dataset.handle); return; }
      if (e.button === 1 || spaceDown || tool === 'hand') { e.preventDefault(); startPan(e); return; }
      if (tool === 'text' || tool === 'rect' || tool === 'frame') { e.preventDefault(); startCreate(e); return; }
      const chain = chainAt(e.target);
      if (!chain.length) {
        if (e.pointerType === 'touch') { startPan(e); return; }
        startMarquee(e);
        return;
      }
      e.preventDefault();
      const id = pick(chain, e);
      if (e.shiftKey) { store.select([id], { toggle: true }); return; }
      if (!store.selection.includes(id)) store.select([id]);
      startMoveDrag(e, id);
    });
    viewport.addEventListener('pointerup', e => { pointers.delete(e.pointerId); });
    viewport.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); });

    // Tracks one pointer until it is released. With `lazy`, the pointer is
    // only captured once it moves (capturing on press would retarget the
    // following click/dblclick to the viewport).
    function capture(e, onMove, onUp, lazy) {
      const target = viewport;
      let captured = false;
      const grab = () => { if (captured) return; captured = true; try { target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } };
      if (!lazy) grab();
      const move = ev => { if (ev.pointerId !== e.pointerId) return; if (lazy && (ev.buttons & 1)) grab(); onMove(ev); };
      const up = ev => {
        if (ev.pointerId !== e.pointerId) return;
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        pointers.delete(ev.pointerId);
        onUp(ev);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    }

    function startPan(e) {
      const s0 = screenPoint(e), p0 = { x: panX, y: panY };
      viewport.classList.add('is-panning');
      capture(e, ev => { const s = screenPoint(ev); panX = p0.x + s.x - s0.x; panY = p0.y + s.y - s0.y; applyView(); }, () => viewport.classList.remove('is-panning'));
    }

    let pinch = null;
    function startPinch() {
      const pts = Array.from(pointers.values());
      pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), z0: zoom, c0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, pan0: { x: panX, y: panY } };
      drag = null;
    }
    viewport.addEventListener('pointermove', e => {
      if (!pinch || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, screenPoint(e));
      if (pointers.size < 2) return;
      const pts = Array.from(pointers.values());
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const z = clamp(pinch.z0 * d / (pinch.d0 || 1), 0.1, 8);
      const wx = (pinch.c0.x - pinch.pan0.x) / pinch.z0, wy = (pinch.c0.y - pinch.pan0.y) / pinch.z0;
      zoom = z; panX = c.x - wx * z; panY = c.y - wy * z;
      applyView();
    });
    viewport.addEventListener('pointerup', () => { if (pointers.size < 2) pinch = null; });

    function startMarquee(e) {
      const s0 = screenPoint(e);
      const additive = e.shiftKey;
      const before = store.selection;
      let moved = false;
      capture(e, ev => {
        const s = screenPoint(ev);
        if (!moved && Math.hypot(s.x - s0.x, s.y - s0.y) < 3) return;
        moved = true;
        const x = Math.min(s.x, s0.x), y = Math.min(s.y, s0.y), w = Math.abs(s.x - s0.x), h = Math.abs(s.y - s0.y);
        Object.assign(marquee.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        const vr = viewport.getBoundingClientRect();
        const hits = store.page.children.filter(id => {
          const n = renderer.node(id), d = doc().elements[id];
          if (!n || !d || d.locked || d.hidden) return false;
          const r = n.getBoundingClientRect();
          return r.right - vr.left >= x && r.left - vr.left <= x + w && r.bottom - vr.top >= y && r.top - vr.top <= y + h;
        });
        store.select(additive ? Array.from(new Set(before.concat(hits))) : hits);
      }, () => {
        marquee.style.display = 'none';
        if (!moved && !additive) store.select([]);
      }, true);
    }

    // Snapping (free elements, axis-aligned guides in the parent's space).
    function snapMove(id, box, others, parentBox) {
      const thr = SNAP_PX / zoom;
      const xs = [], ys = [];
      others.forEach(b => { xs.push(b.x, (b.x + b.r) / 2, b.r); ys.push(b.y, (b.y + b.b) / 2, b.b); });
      if (parentBox) { xs.push(0, parentBox.w / 2, parentBox.w); ys.push(0, parentBox.h / 2); }
      const mine = { x: [box.x, (box.x + box.r) / 2, box.r], y: [box.y, (box.y + box.b) / 2, box.b] };
      let bestX = null, bestY = null;
      mine.x.forEach(v => xs.forEach(t => { const d = t - v; if (Math.abs(d) <= thr && (bestX === null || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, t }; }));
      mine.y.forEach(v => ys.forEach(t => { const d = t - v; if (Math.abs(d) <= thr && (bestY === null || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, t }; }));
      const out = { dx: bestX ? bestX.d : 0, dy: bestY ? bestY.d : 0, lines: [] };
      const all = others.concat([{ x: box.x + out.dx, y: box.y + out.dy, r: box.r + out.dx, b: box.b + out.dy }]);
      if (bestX) out.lines.push({ axis: 'x', at: bestX.t, from: Math.min(...all.map(b => b.y)), to: Math.max(...all.map(b => b.b)) });
      if (bestY) out.lines.push({ axis: 'y', at: bestY.t, from: Math.min(...all.map(b => b.x)), to: Math.max(...all.map(b => b.r)) });
      return out;
    }

    let dragSeq = 0;
    function startMoveDrag(e, clickedId) {
      const w0 = worldPoint(e);
      let started = false;
      let ids = [];
      let items = [];
      const seq = ++dragSeq;
      capture(e, ev => {
        const w = worldPoint(ev);
        if (!started) {
          if (Math.hypot(w.x - w0.x, w.y - w0.y) * zoom < 4) return;
          started = true;
          ids = cmds.topLevel(store.selection).filter(id => !doc().elements[id].locked);
          if (ev.altKey && ids.length) ids = cmds.duplicate(ids, 0);
          items = ids.map(id => {
            const d = doc().elements[id];
            const free = cmds.isFreeIn(id);
            const pm = parentSpaceMatrix(id);
            return { id, free, x0: num(d.frame.x, 0), y0: num(d.frame.y, 0), inv: pm.inverse(), pm };
          });
          drag = { kind: 'move' };
          viewport.classList.add('is-dragging');
        }
        const freeItems = items.filter(it => it.free);
        if (freeItems.length) {
          const p = freeItems[0];
          const a = p.inv.transformPoint(new DOMPoint(w0.x, w0.y)), b = p.inv.transformPoint(new DOMPoint(w.x, w.y));
          let dx = b.x - a.x, dy = b.y - a.y;
          guides = [];
          if (!ev.ctrlKey && !ev.metaKey) {
            const prim = doc().elements[p.id];
            const size = measure(p.id) || { w: 0, h: 0 };
            const corners = [[0, 0], [size.w, 0], [size.w, size.h], [0, size.h]].map(([x, y]) => Core.localToParent(Object.assign({}, prim.frame, { x: p.x0 + dx, y: p.y0 + dy }), size.w, size.h, x, y));
            const box = { x: Math.min(...corners.map(c => c.x)), y: Math.min(...corners.map(c => c.y)), r: Math.max(...corners.map(c => c.x)), b: Math.max(...corners.map(c => c.y)) };
            if (snapOn) {
              const others = Core.childIds(doc(), prim.parent).filter(o => !ids.includes(o) && renderer.node(o) && !doc().elements[o].hidden && cmds.isFreeIn(o)).map(cmds.boxOf);
              const pid = Core.pageIdOfRef(prim.parent);
              const pbox = pid ? { w: num(doc().settings.width, 760), h: renderer.artboard.offsetHeight } : measure(prim.parent);
              const s = snapMove(p.id, box, others, pbox);
              dx += s.dx; dy += s.dy;
              guides = s.lines.map(l => (l.axis === 'x'
                ? { a: toWorld(p.pm, l.at, l.from - 12), b: toWorld(p.pm, l.at, l.to + 12) }
                : { a: toWorld(p.pm, l.from - 12, l.at), b: toWorld(p.pm, l.to + 12, l.at) }));
              if (!s.lines.length && showGrid) {
                const g = num(doc().settings.grid, 8);
                dx = Math.round((p.x0 + dx) / g) * g - p.x0; dy = Math.round((p.y0 + dy) / g) * g - p.y0;
              }
            }
          }
          store.tx(ids.length > 1 ? 'Move ' + ids.length + ' elements' : 'Move', t => freeItems.forEach(it => {
            const d = t.el(it.id);
            d.frame.x = Math.round(it.x0 + dx); d.frame.y = Math.round(it.y0 + dy);
            if (d.frame.dock === 'bottom') d.frame.dock = undefined;
          }), { coalesce: 'move-' + seq });
        } else if (items.length === 1) {
          // stack layouts: reorder by pointer position — or, once the pointer
          // leaves the parent, detach the element into free positioning
          const it = items[0];
          const d = doc().elements[it.id];
          const parentNode = renderer.childHost(d.parent) || renderer.node(d.parent);
          const pc = parentNode && cornersOf(d.parent);
          const sp = toScreen(w);
          const inside = pc ? pointInPoly(sp, pc.pts) : true;
          if (inside || ev.shiftKey) flowInsert(it.id, w);
          else {
            const n = renderer.node(it.id);
            const a = it.inv.transformPoint(new DOMPoint(w0.x, w0.y)), bpt = it.inv.transformPoint(new DOMPoint(w.x, w.y));
            const sx = n.offsetLeft, sy = n.offsetTop, sw = n.offsetWidth;
            insertLine = null; drag.insert = null;
            store.tx('Move out of layout', t => {
              const el = t.el(it.id);
              el.frame.pos = 'free';
              if (typeof el.frame.w !== 'number') el.frame.w = Math.round(sw);
              el.frame.x = Math.round(sx + bpt.x - a.x); el.frame.y = Math.round(sy + bpt.y - a.y);
            }, { coalesce: 'move-' + seq });
            it.free = true; it.x0 = sx; it.y0 = sy;
            if (opts.notify) opts.notify('Moved out of the layout — it\'s now positioned freely (Ctrl+Z to undo)', 'info');
          }
        }
        scheduleOverlay();
      }, () => {
        viewport.classList.remove('is-dragging');
        if (drag && drag.kind === 'move' && insertLine && drag.insert) {
          const it = drag.insert;
          cmds.moveTo([it.id], it.parent, it.index);
        }
        drag = null; guides = []; insertLine = null;
        scheduleOverlay();
        if (!started && clickedId && store.selection.length > 1 && !e.shiftKey) store.select([clickedId]);
      }, true);
    }
    function pointInPoly(p, pts) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], c = pts[j];
        if (((a.y > p.y) !== (c.y > p.y)) && (p.x < (c.x - a.x) * (p.y - a.y) / ((c.y - a.y) || 1e-9) + a.x)) inside = !inside;
      }
      return inside;
    }
    function toWorld(pm, x, y) { const p = pm.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; }

    function flowInsert(id, w) {
      const d = doc().elements[id];
      const lay = Core.layoutOf(doc(), d.parent);
      const sibs = Core.childIds(doc(), d.parent).filter(s => s !== id && renderer.node(s) && !doc().elements[s].hidden);
      const horiz = lay.dir === 'h';
      let index = sibs.length;
      let best = null;
      sibs.forEach((s, i) => {
        const c = cornersOf(s); if (!c) return;
        const mid = project(c.m, c.w / 2, c.h / 2);
        if (index === sibs.length && (horiz ? w.x < mid.x : w.y < mid.y)) { index = i; best = s; }
      });
      const ref = best || sibs[sibs.length - 1];
      if (!ref) return;
      const c = cornersOf(ref);
      const m = c.m;
      insertLine = best
        ? (horiz ? { a: project(m, -4, 0), b: project(m, -4, c.h) } : { a: project(m, 0, -4), b: project(m, c.w, -4) })
        : (horiz ? { a: project(m, c.w + 4, 0), b: project(m, c.w + 4, c.h) } : { a: project(m, 0, c.h + 4), b: project(m, c.w, c.h + 4) });
      const fullIndex = best ? Core.childIds(doc(), d.parent).indexOf(best) : Core.childIds(doc(), d.parent).length;
      drag.insert = { id, parent: d.parent, index: fullIndex };
    }

    function startHandleDrag(e, hname) {
      const id = store.primary;
      const d = doc().elements[id];
      if (!d || d.locked) return;
      const n = renderer.node(id);
      const w0 = n.offsetWidth, h0 = n.offsetHeight;
      const f0 = Object.assign({}, d.frame, { w: w0, h: h0 });
      const pm = parentSpaceMatrix(id), inv = pm.inverse();
      const free = cmds.isFreeIn(id);
      const lin = Core.frameLinear(f0), linInv = Core.invertLinear(lin);
      const ox = num(f0.ox, 0.5), oy = num(f0.oy, 0.5);
      const seq = ++dragSeq;
      const scaleMode = tool === 'scale' || e.ctrlKey || e.metaKey;
      drag = { kind: hname === 'rot' ? 'rotate' : 'resize' };
      const toParent = ev => { const w = worldPoint(ev); const p = inv.transformPoint(new DOMPoint(w.x, w.y)); return { x: p.x, y: p.y }; };
      const center = Core.localToParent(f0, w0, h0, ox * w0, oy * h0);
      const a0 = Math.atan2(toParent(e).y - center.y, toParent(e).x - center.x);
      capture(e, ev => {
        const p = toParent(ev);
        if (hname === 'rot') {
          const a = Math.atan2(p.y - center.y, p.x - center.x);
          let rot = num(f0.rot, 0) + (a - a0) * 180 / Math.PI;
          rot = ((rot + 180) % 360 + 360) % 360 - 180;
          if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
          store.tx('Rotate', t => { t.el(id).frame.rot = Math.round(rot * 10) / 10; }, { coalesce: 'rot-' + seq });
          scheduleOverlay();
          return;
        }
        const [hx, hy] = HANDLE_POS[hname];
        const fromCenter = ev.altKey;
        const ax = hname === 'n' || hname === 's' ? 0.5 : (fromCenter ? 0.5 : 1 - hx);
        const ay = hname === 'e' || hname === 'w' ? 0.5 : (fromCenter ? 0.5 : 1 - hy);
        const anchorP = Core.localToParent(f0, w0, h0, ax * w0, ay * h0);
        const v = { x: p.x - anchorP.x, y: p.y - anchorP.y };
        const u = Core.applyLinear(linInv, v.x, v.y);
        let nw = w0, nh = h0;
        const factor = fromCenter ? 2 : 1;
        if (hx !== 0.5) nw = Math.max(4, (hx === 1 ? u.x : -u.x) * factor + (fromCenter ? 0 : 0));
        if (hy !== 0.5) nh = Math.max(4, (hy === 1 ? u.y : -u.y) * factor);
        if (fromCenter) { if (hx !== 0.5) nw = Math.max(4, Math.abs(u.x) * 2); if (hy !== 0.5) nh = Math.max(4, Math.abs(u.y) * 2); }
        const corner = hx !== 0.5 && hy !== 0.5;
        if (ev.shiftKey && corner) { const r = Math.max(nw / w0, nh / h0); nw = w0 * r; nh = h0 * r; }
        if (scaleMode) {
          const sx = num(f0.sx, 1) * nw / w0, sy = num(f0.sy, 1) * nh / h0;
          const nf = Object.assign({}, f0, { sx: hx !== 0.5 ? sx : f0.sx, sy: hy !== 0.5 ? sy : f0.sy });
          const nl = Core.frameLinear(nf);
          // keep the anchor fixed: x = A - O - L(a - O)
          const q = Core.applyLinear(nl, ax * w0 - ox * w0, ay * h0 - oy * h0);
          store.tx('Scale', t => {
            const fr = t.el(id).frame;
            fr.sx = Math.round(nf.sx * 1000) / 1000; fr.sy = Math.round(nf.sy * 1000) / 1000;
            if (free) { fr.x = Math.round(anchorP.x - ox * w0 - q.x); fr.y = Math.round(anchorP.y - oy * h0 - q.y); }
          }, { coalesce: 'scale-' + seq });
        } else {
          nw = Math.round(nw); nh = Math.round(nh);
          store.tx('Resize', t => {
            const fr = t.el(id).frame;
            if (hx !== 0.5) fr.w = nw;
            if (hy !== 0.5) fr.h = nh;
            if (free) {
              // keep the opposite edge/corner where it was: x = A − O − L(a − O)
              const W = hx !== 0.5 ? nw : w0, H = hy !== 0.5 ? nh : h0;
              const qq = Core.applyLinear(lin, ax * W - ox * W, ay * H - oy * H);
              fr.x = Math.round(anchorP.x - ox * W - qq.x); fr.y = Math.round(anchorP.y - oy * H - qq.y);
            }
          }, { coalesce: 'resize-' + seq });
        }
        scheduleOverlay();
      }, () => { drag = null; scheduleOverlay(); });
    }

    function startCreate(e) {
      const page = store.page;
      const ab = renderer.artboard;
      const abM = nodeMatrix(ab).translate(ab.clientLeft, ab.clientTop).inverse();
      const toPage = ev => { const w = worldPoint(ev); const p = abM.transformPoint(new DOMPoint(w.x, w.y)); return { x: p.x, y: p.y }; };
      const p0 = toPage(e);
      const kind = tool;
      let p1 = p0;
      capture(e, ev => {
        p1 = toPage(ev);
        const s0 = toScreen(project(nodeMatrix(ab).translate(ab.clientLeft, ab.clientTop), p0.x, p0.y));
        const s1 = toScreen(project(nodeMatrix(ab).translate(ab.clientLeft, ab.clientTop), p1.x, p1.y));
        Object.assign(marquee.style, { display: 'block', left: Math.min(s0.x, s1.x) + 'px', top: Math.min(s0.y, s1.y) + 'px', width: Math.abs(s1.x - s0.x) + 'px', height: Math.abs(s1.y - s0.y) + 'px' });
      }, () => {
        marquee.style.display = 'none';
        const w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
        const at = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y) };
        const big = w > 6 && h > 6;
        let id = null;
        if (kind === 'text') {
          id = cmds.addElement('label', { parentRef: 'page:' + page.id, at, size: big ? { w, h } : null, props: { text: 'Text' } });
          if (id && !big) store.tx('Text size', t => { t.el(id).frame.w = 'auto'; t.el(id).frame.h = 'auto'; }, { coalesce: 'create-' + id });
        } else if (kind === 'rect') id = cmds.addElement('shape', { parentRef: 'page:' + page.id, at, size: big ? { w, h } : { w: 160, h: 120 } });
        else if (kind === 'frame') id = cmds.addElement('container', { parentRef: 'page:' + page.id, at, size: big ? { w, h } : { w: 320, h: 200 } });
        setTool('select');
        if (id && kind === 'text') requestAnimationFrame(() => startEdit(id));
      });
    }

    /* ── Inline text editing ────────────────── */
    function canEdit(id) { const d = doc().elements[id]; return !!(d && TEXT_EDIT[d.type] && !d.locked); }
    function startEdit(id) {
      if (!canEdit(id)) return false;
      const d = doc().elements[id];
      const [selector, prop, rich] = TEXT_EDIT[d.type];
      const n = renderer.node(id);
      const target = n && n.querySelector(selector);
      if (!target) return false;
      store.select([id]);
      const original = rich ? target.innerHTML : target.textContent;
      if (d.type === 'qtitle') target.querySelectorAll('.sv-req-sr').forEach(x => x.remove());
      if (d.type === 'button' && !d.props.text) target.textContent = target.textContent;
      if (d.type === 'qerror' && !d.props.text) target.textContent = '';
      target.contentEditable = rich ? 'true' : 'plaintext-only';
      if (target.contentEditable !== 'plaintext-only' && !rich) target.contentEditable = 'true';
      target.classList.add('ss-editing');
      n.classList.add('ss-editing-host');
      target.spellcheck = true;
      editing = { id, node: n, target, prop, rich, original };
      target.focus({ preventScroll: true });
      const range = document.createRange(); range.selectNodeContents(target);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
      richBar.style.display = rich ? 'flex' : 'none';
      scheduleOverlay();
      target.addEventListener('keydown', onEditKey);
      target.addEventListener('paste', onEditPaste);
      target.addEventListener('blur', onEditBlur);
      if (opts.onEditing) opts.onEditing(true);
      return true;
    }
    function onEditKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(true); viewport.focus(); }
      else if (e.key === 'Enter' && !e.shiftKey && editing && SINGLE_LINE.has(doc().elements[editing.id].type)) { e.preventDefault(); finishEdit(true); viewport.focus(); }
    }
    function onEditPaste(e) {
      if (editing && editing.rich) return;
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    }
    function onEditBlur() { setTimeout(() => { if (editing && document.activeElement !== editing.target && !richBar.contains(document.activeElement)) finishEdit(true); }, 0); }
    function finishEdit(commit) {
      if (!editing) return;
      const ed = editing;
      editing = null;
      ed.target.removeEventListener('keydown', onEditKey);
      ed.target.removeEventListener('paste', onEditPaste);
      ed.target.removeEventListener('blur', onEditBlur);
      ed.target.contentEditable = 'false';
      ed.target.removeAttribute('contenteditable');
      ed.target.classList.remove('ss-editing');
      ed.node.classList.remove('ss-editing-host');
      richBar.style.display = 'none';
      if (opts.onEditing) opts.onEditing(false);
      let value = ed.rich ? Core.sanitizeHtml(ed.target.innerHTML) : ed.target.innerText.replace(/\n$/, '');
      const d = doc().elements[ed.id];
      if (commit && d && value !== String(d.props[ed.prop] === undefined ? '' : d.props[ed.prop])) {
        if (d.type === 'button' && value.trim() === renderer.defaultButtonLabel(d) && !d.props.text) value = '';
        store.tx('Edit text', t => { t.el(ed.id).props[ed.prop] = value; });
      } else renderer.refresh([ed.id]);
      scheduleOverlay();
    }
    function positionRichBar() {
      if (!editing || !editing.rich) return;
      const c = cornersOf(editing.id);
      if (!c) return;
      richBar.style.left = Math.min(...c.pts.map(p => p.x)) + 'px';
      richBar.style.top = Math.max(4, Math.min(...c.pts.map(p => p.y)) - 40) + 'px';
    }
    richBar.addEventListener('mousedown', e => e.preventDefault());
    richBar.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || !editing) return;
      const cmd = b.dataset.cmd;
      if (cmd === 'createLink') { const url = prompt('Link address (https://…)', 'https://'); if (url && Core.safeUrl(url, ['https', 'http', 'mailto'])) document.execCommand('createLink', false, url); }
      else document.execCommand(cmd, false, null);
      editing.target.focus();
    });

    viewport.addEventListener('dblclick', e => {
      if (editing) return;
      const chain = chainAt(e.target);
      if (!chain.length) return;
      const sel = store.selection;
      let i = chain.findIndex(id => sel.includes(id));
      if (i !== -1 && i < chain.length - 1) {
        let next = chain[i + 1];
        // skip structural wrappers (answer group, matrix grid) when drilling in
        if (['choices', 'matrixgrid'].includes(doc().elements[next].type) && chain[i + 2]) { next = chain[i + 2]; i += 1; }
        // drilling into a text element goes straight to editing it
        store.select([next]);
        if (chain.indexOf(next) === chain.length - 1 && canEdit(next) && !Core.isContainerType(doc().elements[next].type)) startEdit(next);
        return;
      }
      const id = i !== -1 ? chain[i] : pick(chain, e);
      if (canEdit(id)) startEdit(id);
      else if (Core.isContainerType(doc().elements[id].type) && chain.length > chain.indexOf(id) + 1) store.select([chain[chain.indexOf(id) + 1]]);
    });

    /* ── Wheel, keys, drop ──────────────────── */
    viewport.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const s = screenPoint(e);
        zoomAt(zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022)), s.x, s.y);
      } else {
        panX -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        panY -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        applyView();
      }
    }, { passive: false });

    viewport.addEventListener('contextmenu', e => {
      e.preventDefault();
      const chain = chainAt(e.target);
      if (chain.length) { const id = pick(chain, e); if (!store.selection.includes(id)) store.select([id]); }
      if (opts.onContextMenu) opts.onContextMenu(e, { at: pagePoint(e) });
    });

    function pagePoint(e) {
      const ab = renderer.artboard;
      const inv = nodeMatrix(ab).translate(ab.clientLeft, ab.clientTop).inverse();
      const w = worldPoint(e);
      const p = inv.transformPoint(new DOMPoint(w.x, w.y));
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }

    viewport.addEventListener('dragover', e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).some(t => t === 'application/x-survey-type' || t === 'application/x-survey-component')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const target = dropTarget(e);
      hoverId = target && target !== 'page' ? target : null;
      scheduleOverlay();
    });
    viewport.addEventListener('drop', e => {
      const type = e.dataTransfer.getData('application/x-survey-type');
      const comp = e.dataTransfer.getData('application/x-survey-component');
      if (!type && !comp) return;
      e.preventDefault();
      const target = dropTarget(e);
      hoverId = null;
      if (comp && opts.onDropComponent) { opts.onDropComponent(comp, pagePoint(e)); return; }
      if (target && target !== 'page' && cmds.canContain(target, type)) {
        const host = doc().elements[target];
        const lay = Core.layoutOf(doc(), target);
        let at = null;
        if (lay.mode === 'free') { const inv = parentSpaceMatrixForHost(target).inverse(); const w = worldPoint(e); const p = inv.transformPoint(new DOMPoint(w.x, w.y)); at = { x: p.x, y: p.y }; }
        cmds.addElement(type, { parentRef: host.id, at });
      } else {
        cmds.addElement(type, { parentRef: 'page:' + store.page.id, at: pagePoint(e) });
      }
      viewport.focus();
    });
    function parentSpaceMatrixForHost(id) { const host = renderer.childHost(id) || renderer.node(id); return nodeMatrix(host).translate(host.clientLeft, host.clientTop); }
    function dropTarget(e) {
      const chain = chainAt(e.target);
      for (let i = chain.length - 1; i >= 0; i--) {
        const d = doc().elements[chain[i]];
        if (['container', 'group', 'section', 'tabpanel'].includes(d.type)) return d.id;
      }
      return 'page';
    }

    /* ── Tools & settings ───────────────────── */
    function setTool(t) {
      tool = t;
      viewport.dataset.tool = t;
      if (opts.onTool) opts.onTool(t);
      scheduleOverlay();
    }
    function setSpace(down) { spaceDown = down; viewport.classList.toggle('is-space', down); }
    function setGrid(v) { showGrid = v; positionGrid(); }
    function setSnap(v) { snapOn = v; }
    function setForced(id, state) { forced = id && state ? { id, state } : null; renderer.setForcedState(id, state); scheduleOverlay(); }

    // Keeps the selection visible (e.g. after picking it in the layers panel).
    function reveal(id) {
      const c = cornersOf(id);
      if (!c) return;
      const r = viewport.getBoundingClientRect();
      const xs = c.pts.map(p => p.x), ys = c.pts.map(p => p.y);
      let dx = 0, dy = 0;
      if (Math.max(...xs) > r.width - 20) dx = r.width - 40 - Math.max(...xs);
      if (Math.min(...xs) < 20) dx = 40 - Math.min(...xs);
      if (Math.max(...ys) > r.height - 20) dy = r.height - 40 - Math.max(...ys);
      if (Math.min(...ys) < 20) dy = 40 - Math.min(...ys);
      if (dx || dy) { panX += dx; panY += dy; applyView(); }
    }

    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => scheduleOverlay()); ro.observe(viewport); }

    renderPage();
    applyView();
    requestAnimationFrame(() => fitWidth());

    return {
      viewport, renderer,
      get zoom() { return zoom; },
      get tool() { return tool; },
      get editing() { return !!editing; },
      zoomIn: () => zoomAt(zoom * 1.25), zoomOut: () => zoomAt(zoom / 1.25), zoomTo: z => zoomAt(z), fit, fitWidth,
      setTool, setSpace, setGrid, setSnap, setForced, startEdit, finishEdit, reveal, measure, renderPage,
      pageHeight: () => renderer.artboard.offsetHeight,
      redraw: scheduleOverlay,
      destroy() { offStore(); if (ro) ro.disconnect(); renderer.destroy(); container.innerHTML = ''; }
    };
  }

  root.SurveyCanvas = { create };
})(typeof window !== 'undefined' ? window : this);
