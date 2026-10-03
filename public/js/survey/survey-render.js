/* ══════════════════════════════════════════════
   survey-render.js — turns a survey document into DOM

   One renderer for all three places a survey appears, so they always match:
     • the editor canvas  (mode 'design': inert controls, every element
                           carries data-svid so it can be selected)
     • preview/test mode and the published survey  (mode 'live': real
                           inputs, wired to SurveyRuntime through ctx.live)

   Styles are generated per element into their own <style> tag (base rule +
   hover / focus / active / checked / disabled rules), so changing one
   element only rewrites one small stylesheet. Geometry (position, size,
   transform) is inline on the element's node.
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore;
  const { num, isObj, isQuestionType, isContainerType } = Core;

  let scopeSeq = 0;
  const SVG = (inner, cls) => '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + inner + '</svg>';
  const SHAPES = {
    star: '<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/>',
    heart: '<path d="M12 20.7l-1.3-1.2C5.6 14.9 2.4 12 2.4 8.4 2.4 5.5 4.7 3.3 7.5 3.3c1.6 0 3.2.8 4.5 2 1.3-1.2 2.9-2 4.5-2 2.8 0 5.1 2.2 5.1 5.1 0 3.6-3.2 6.5-8.3 11.1z"/>',
    check: '<polyline points="5 12.5 10 17 19 7.5"/>'
  };
  const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' };
  const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };

  function h(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) Object.keys(attrs).forEach(k => { if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]); });
    return n;
  }

  const isOff = n => n.classList.contains('sv-off') || n.classList.contains('sv-el-hidden') || n.classList.contains('sv-tab-hidden');

  function create(host, doc, opts) {
    opts = opts || {};
    const mode = opts.mode === 'live' ? 'live' : 'design';
    const live = mode === 'live' ? (opts.live || {}) : null;
    const scope = 'svs' + (++scopeSeq) + Math.random().toString(36).slice(2, 6);
    const scopeSel = '.sv-root[data-sv="' + scope + '"]';
    const nodes = new Map();       // id → element node
    const childHosts = new Map();  // id → node that holds its children
    const styleTags = new Map();   // id → <style>
    let pageId = null;

    const rootEl = h('div', 'sv-root sv-mode-' + mode, { 'data-sv': scope });
    const styleHost = h('div', 'sv-style-host', { hidden: true, 'aria-hidden': 'true' });
    const tokenStyle = h('style');
    styleHost.appendChild(tokenStyle);
    const artboard = h('div', 'sv-artboard');
    rootEl.appendChild(styleHost);
    rootEl.appendChild(artboard);
    host.appendChild(rootEl);

    const getEl = id => (live && live.getEl ? live.getEl(id) : doc.elements[id]);
    const layoutOfRef = ref => {
      const pid = Core.pageIdOfRef(ref);
      if (pid) return { mode: 'free' };
      const p = getEl(ref);
      return (p && p.props && p.props.layout) || { mode: 'free' };
    };

    /* ── Styles ─────────────────────────────── */
    function writeTokens() {
      const page = Core.getPage(doc, pageId);
      const pageStyle = Core.deepMerge(Core.deepMerge({ fill: 'var(--sv-surface)', radius: 'var(--sv-radiusLarge)', borderWidth: 1, borderColor: 'var(--sv-border)',
        shadows: [{ x: 0, y: 1, blur: 3, spread: 0, color: 'rgba(15,23,42,0.06)' }] }, doc.theme.page || {}), (page && page.style) || {});
      tokenStyle.textContent = scopeSel + '{' + Core.tokenDecls(doc) + '}' +
        scopeSel + ' .sv-artboard{' + Core.styleDecls(pageStyle).join(';') + '}';
    }
    function writeStyle(id) {
      const el = getEl(id);
      if (!el) return;
      let tag = styleTags.get(id);
      if (!tag) { tag = h('style'); styleTags.set(id, tag); styleHost.appendChild(tag); }
      tag.textContent = Core.elementCss(doc, el, scopeSel);
    }

    /* ── Geometry ───────────────────────────── */
    function applyFrame(id) {
      const el = getEl(id), node = nodes.get(id);
      if (!el || !node) return;
      const f = el.frame;
      const lay = layoutOfRef(el.parent);
      const abs = lay.mode === 'free' || f.pos === 'free';
      const st = node.style;
      st.position = abs ? 'absolute' : 'relative';
      st.left = abs ? num(f.x, 0) + 'px' : '';
      st.top = abs ? num(f.y, 0) + 'px' : '';
      st.flex = ''; st.alignSelf = ''; st.minWidth = ''; st.maxWidth = ''; st.flexShrink = '';
      const horiz = lay.mode === 'stack' && lay.dir === 'h';
      // width
      if (typeof f.w === 'number') { st.width = f.w + 'px'; if (!abs) st.flexShrink = '0'; }
      else if (f.w === 'fill') {
        if (abs) st.width = '100%';
        else if (horiz) { st.width = 'auto'; st.flex = '1 1 0'; st.minWidth = '0'; }
        else { st.width = 'auto'; st.alignSelf = 'stretch'; }
      } else { st.width = 'max-content'; st.maxWidth = abs ? '' : '100%'; }
      // height
      if (typeof f.h === 'number') { st.height = f.h + 'px'; if (!abs) st.flexShrink = '0'; }
      else if (f.h === 'fill') {
        if (abs) st.height = '100%';
        else if (!horiz && lay.mode === 'stack') { st.height = 'auto'; st.flex = (st.flex ? st.flex : '1 1 0'); }
        else { st.height = 'auto'; st.alignSelf = 'stretch'; }
      } else st.height = '';
      // free children: stacking order = layer order (DOM order may be reading order)
      if (abs) {
        const siblings = Core.childIds(doc, el.parent);
        st.zIndex = String(siblings.indexOf(id) + 1);
      } else st.zIndex = '';
      st.transformOrigin = '0 0';
      st.transform = Core.transformCss(f, f.distort ? { w: node.offsetWidth || num(f.w, 0), h: node.offsetHeight || num(f.h, 0) } : null);
    }

    function applyLayout(id) {
      const el = getEl(id), hostNode = childHosts.get(id);
      if (!el || !hostNode) return;
      const lay = (el.props && el.props.layout) || { mode: 'free' };
      const st = hostNode.style;
      st.display = ''; st.flexDirection = ''; st.gap = ''; st.alignItems = ''; st.justifyContent = ''; st.flexWrap = ''; st.gridTemplateColumns = '';
      if (lay.mode === 'stack') {
        st.display = 'flex';
        st.flexDirection = lay.dir === 'h' ? 'row' : 'column';
        st.gap = num(lay.gap, 0) + 'px';
        st.alignItems = ALIGN[lay.align] || (lay.dir === 'h' ? 'center' : 'stretch');
        st.justifyContent = JUSTIFY[lay.justify] || 'flex-start';
        st.flexWrap = lay.wrap ? 'wrap' : 'nowrap';
      } else if (lay.mode === 'grid') {
        st.display = 'grid';
        st.gridTemplateColumns = 'repeat(' + Math.max(1, Math.min(24, num(lay.cols, 2))) + ', minmax(0, 1fr))';
        st.gap = num(lay.gap, 0) + 'px';
        st.alignItems = ALIGN[lay.align] === 'stretch' ? 'stretch' : (ALIGN[lay.align] || 'start');
      }
      hostNode.classList.toggle('sv-free', lay.mode !== 'stack' && lay.mode !== 'grid');
    }

    /* ── Element nodes ──────────────────────── */
    function textValue(el) {
      if (live && live.text) return live.text(el);
      return String(el.props.text === undefined ? '' : el.props.text);
    }
    function setText(n, el, rich) {
      if (rich) n.innerHTML = Core.sanitizeHtml(textValue(el));
      else n.textContent = textValue(el);
    }

    function indicatorNode(el, ctx) {
      const shape = el.props.shape || 'radio';
      const n = h('span', 'sv-el sv-indicator sv-ind-' + shape, { 'data-svid': el.id, 'aria-hidden': 'true' });
      if (shape === 'radio') n.appendChild(h('span', 'sv-mark sv-mark-dot'));
      else if (shape === 'checkbox') n.insertAdjacentHTML('beforeend', SVG(SHAPES.check, 'sv-mark sv-mark-check'));
      else if (shape === 'star' || shape === 'heart') n.insertAdjacentHTML('beforeend', SVG(SHAPES[shape], 'sv-shape-icon'));
      else if (shape === 'toggle') n.appendChild(h('span', 'sv-mark sv-knob'));
      else if (shape === 'number') { const t = h('span', 'sv-ind-num'); const opt = getEl(el.parent); t.textContent = opt && opt.type === 'option' ? String(opt.props.value) : ''; n.appendChild(t); }
      return n;
    }

    function fieldNode(el, q) {
      const k = el.props.kind || 'text';
      const wrap = h('div', 'sv-el sv-field sv-field-' + k, { 'data-svid': el.id });
      const qid = q ? q.id : el.id;
      const inputId = scope + '-in-' + el.id;
      let input;
      if (k === 'textarea') input = h('textarea', 'sv-control sv-input');
      else if (k === 'select') {
        input = h('select', 'sv-control sv-input sv-select');
        const ph = h('option', null, { value: '' }); ph.textContent = el.props.placeholder || 'Select…'; input.appendChild(ph);
        (Array.isArray(el.props.options) ? el.props.options : []).forEach(o => {
          const op = h('option', null, { value: String(o.value !== undefined && o.value !== '' ? o.value : Core.slug(o.label)) }); op.textContent = String(o.label || ''); input.appendChild(op);
        });
        wrap.insertAdjacentHTML('beforeend', '<svg class="sv-select-arrow" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>');
      } else if (k === 'range') {
        input = h('input', 'sv-control sv-range', { type: 'range', min: num(el.props.min, 0), max: num(el.props.max, 10), step: num(el.props.step, 1) || 1 });
      } else {
        const type = { number: 'number', date: 'date', time: 'time', text: 'text', email: 'email' }[k] || 'text';
        input = h('input', 'sv-control sv-input', { type });
        if (k === 'number') { if (el.props.min !== null && el.props.min !== undefined && el.props.min !== '') input.min = el.props.min; if (el.props.max !== null && el.props.max !== undefined && el.props.max !== '') input.max = el.props.max; input.step = el.props.step || 'any'; input.inputMode = 'decimal'; }
      }
      input.id = inputId;
      if (el.props.placeholder && k !== 'select' && k !== 'range') input.placeholder = el.props.placeholder;
      if (q && (k !== 'range')) input.setAttribute('aria-labelledby', titleIdOf(q.id));
      if (q && k === 'range') input.setAttribute('aria-labelledby', titleIdOf(q.id));
      if (el.a11y && el.a11y.label) input.setAttribute('aria-label', el.a11y.label);
      if (k === 'range') {
        const row = h('div', 'sv-range-row');
        row.appendChild(input);
        if (el.props.showValue !== false) { const out = h('output', 'sv-range-value', { for: inputId }); row.appendChild(out); }
        wrap.appendChild(row);
        if (el.props.minLabel || el.props.maxLabel) {
          const labels = h('div', 'sv-range-labels');
          const a = h('span'); a.textContent = el.props.minLabel || ''; const b = h('span'); b.textContent = el.props.maxLabel || '';
          labels.appendChild(a); labels.appendChild(b);
          wrap.appendChild(labels);
        }
      } else wrap.appendChild(input);
      if (mode === 'design') { input.tabIndex = -1; input.setAttribute('aria-hidden', 'true'); if (input.tagName !== 'SELECT') input.readOnly = true; if (k === 'range') input.value = String((num(el.props.min, 0) + num(el.props.max, 10)) / 2); syncRange(wrap); }
      else if (live && q) live.bindField(q, el, input, wrap);
      return wrap;
    }
    function syncRange(wrap) {
      const r = wrap.querySelector('.sv-range'); if (!r) return;
      const min = num(r.min, 0), max = num(r.max, 10), v = num(r.value, min);
      wrap.style.setProperty('--sv-range-pct', ((v - min) / ((max - min) || 1) * 100) + '%');
      const out = wrap.querySelector('.sv-range-value'); if (out) out.textContent = r.dataset.empty === '1' ? '–' : String(v);
    }
    const titleIdOf = qid => scope + '-t-' + qid;
    const errorIdOf = qid => scope + '-e-' + qid;

    function nodeFor(el) {
      const t = el.type;
      const def = Core.getType(t) || {};
      const q = (def.part || isQuestionType(t)) ? Core.questionOf(doc, el.id) : null;
      let n, childHost = null;
      const base = 'sv-el sv-t-' + t;
      switch (t) {
        case 'heading': case 'paragraph': case 'label': case 'instructions': case 'caption': case 'richtext': case 'optlabel': case 'qdesc': {
          n = h('div', base, { 'data-svid': el.id });
          const tag = t === 'heading' ? (/^h[1-6]$/.test(el.props.tag) ? el.props.tag : 'h2') : (t === 'paragraph' ? 'p' : 'div');
          const inner = h(tag, 'sv-text' + (t === 'richtext' ? ' sv-rich' : ''));
          setText(inner, el, t === 'richtext');
          n.appendChild(inner);
          break;
        }
        case 'qtitle': {
          n = h('div', base, { 'data-svid': el.id });
          const inner = h('div', 'sv-text', { id: q ? titleIdOf(q.id) : undefined });
          setText(inner, el, false);
          n.appendChild(inner);
          const req = h('span', 'sv-req', { 'aria-hidden': 'true' }); req.textContent = '*';
          n.appendChild(req);
          if (mode === 'design' && q && q.behavior && q.behavior.required) n.classList.add('is-required');
          if (live && q) { const sr = h('span', 'sv-sr-only sv-req-sr'); sr.textContent = ' (required)'; inner.appendChild(sr); }
          break;
        }
        case 'qerror': {
          n = h('div', base, { 'data-svid': el.id });
          const inner = h('div', 'sv-text', { id: q ? errorIdOf(q.id) : undefined });
          if (mode === 'design') { inner.textContent = el.props.text || 'This question is required.'; n.classList.add('sv-design-sample'); }
          else { n.setAttribute('role', 'alert'); n.setAttribute('aria-live', 'polite'); }
          n.appendChild(inner);
          break;
        }
        case 'option': {
          const multi = q && (q.props.multi || q.type === 'multiple');
          n = h(live ? 'label' : 'div', base + ' sv-option sv-hover-host', { 'data-svid': el.id });
          if (live && q) {
            const input = h('input', 'sv-native', { type: multi ? 'checkbox' : 'radio', name: scope + '-' + q.id, value: String(el.props.value) });
            if (el.a11y && el.a11y.label) input.setAttribute('aria-label', el.a11y.label);
            else if (!(el.children || []).some(c => getEl(c) && getEl(c).type === 'optlabel')) input.setAttribute('aria-label', String(el.props.value));
            n.appendChild(input);
            live.bindOption(q, el, input, n);
          }
          childHost = n;
          break;
        }
        case 'indicator': n = indicatorNode(el); break;
        case 'field': n = fieldNode(el, q); break;
        case 'rankitem': {
          n = h('div', base + ' sv-rankitem sv-hover-host', { 'data-svid': el.id });
          n.innerHTML = '<span class="sv-rank-handle" aria-hidden="true">' + SVG('<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>') + '</span>' +
            '<span class="sv-rank-pos"></span><span class="sv-rank-label"></span>';
          n.querySelector('.sv-rank-label').textContent = String(el.props.label || '');
          if (live && q) {
            const up = h('button', 'sv-rank-btn', { type: 'button', 'aria-label': 'Move ' + (el.props.label || 'item') + ' up' }); up.innerHTML = SVG('<polyline points="6 15 12 9 18 15"/>');
            const down = h('button', 'sv-rank-btn', { type: 'button', 'aria-label': 'Move ' + (el.props.label || 'item') + ' down' }); down.innerHTML = SVG('<polyline points="6 9 12 15 18 9"/>');
            n.appendChild(up); n.appendChild(down);
            live.bindRankItem(q, el, n, up, down);
          }
          break;
        }
        case 'matrixgrid': {
          n = h('div', base + ' sv-matrix', { 'data-svid': el.id, role: live ? 'table' : undefined });
          const cols = Array.isArray(el.props.columns) ? el.props.columns : [];
          n.style.setProperty('--sv-mx-cols', 'min(' + num(el.props.rowLabelWidth, 200) + 'px, 38%) repeat(' + Math.max(1, cols.length) + ', minmax(44px, 1fr))');
          const head = h('div', 'sv-matrix-head', { role: live ? 'row' : undefined });
          head.appendChild(h('span', 'sv-matrix-corner', { role: live ? 'columnheader' : undefined }));
          cols.forEach(c => { const s = h('span', 'sv-matrix-col', { role: live ? 'columnheader' : undefined }); s.textContent = String(c.label || ''); head.appendChild(s); });
          n.appendChild(head);
          childHost = n;
          break;
        }
        case 'matrixrow': {
          n = h('div', base + ' sv-matrixrow sv-hover-host', { 'data-svid': el.id, role: live ? 'row' : undefined });
          const grid = getEl(el.parent);
          const cols = grid && Array.isArray(grid.props.columns) ? grid.props.columns : [];
          const lab = h('span', 'sv-matrix-rowlabel', { role: live ? 'rowheader' : undefined, id: scope + '-mr-' + el.id }); lab.textContent = String(el.props.label || '');
          n.appendChild(lab);
          cols.forEach((c, i) => {
            const cell = h(live ? 'label' : 'span', 'sv-matrix-cell', { role: live ? 'cell' : undefined });
            if (live && q) {
              const input = h('input', 'sv-native', { type: 'radio', name: scope + '-' + q.id + '-' + el.id, value: String(c.value !== undefined && c.value !== '' ? c.value : Core.slug(c.label)), 'aria-label': (el.props.label || '') + ': ' + (c.label || '') });
              cell.appendChild(input);
              live.bindMatrixCell(q, el, c, input, cell);
            }
            cell.appendChild(h('span', 'sv-matrix-dot', { 'aria-hidden': 'true' }));
            n.appendChild(cell);
          });
          break;
        }
        case 'image': {
          n = h('div', base, { 'data-svid': el.id });
          const src = Core.safeUrl(el.props.src, ['https', 'http', 'data-image', 'relative']);
          if (src) {
            const img = h('img', 'sv-img', { src, alt: el.props.alt || '', draggable: 'false', loading: mode === 'live' ? 'lazy' : undefined });
            img.style.objectFit = ['cover', 'contain', 'fill', 'none', 'scale-down'].includes(el.props.fit) ? el.props.fit : 'cover';
            if (el.props.focusX !== undefined) img.style.objectPosition = num(el.props.focusX, 50) + '% ' + num(el.props.focusY, 50) + '%';
            n.appendChild(img);
          } else if (mode === 'design') n.appendChild(placeholder('image', 'Image — set a source in the inspector'));
          break;
        }
        case 'video': {
          n = h('div', base, { 'data-svid': el.id });
          const embed = Core.videoEmbedUrl(el.props.src);
          const src = Core.safeUrl(el.props.src, ['https', 'http', 'relative']);
          if (mode === 'design') n.appendChild(placeholder('video', embed ? 'Video: ' + el.props.src : (src ? 'Video: ' + src : 'Video — paste a YouTube, Vimeo or .mp4 link')));
          else if (embed) n.appendChild(h('iframe', 'sv-media', { src: embed, title: el.props.title || 'Video', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true, loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin' }));
          else if (src) {
            const v = h('video', 'sv-media', { src, controls: el.props.controls !== false, autoplay: !!el.props.autoplay, loop: !!el.props.loop, muted: !!el.props.muted || !!el.props.autoplay, playsinline: true, preload: 'metadata', 'aria-label': el.props.title || 'Video' });
            const poster = Core.safeUrl(el.props.poster, ['https', 'http', 'data-image', 'relative']); if (poster) v.poster = poster;
            n.appendChild(v);
          }
          break;
        }
        case 'audio': {
          n = h('div', base, { 'data-svid': el.id });
          const src = Core.safeUrl(el.props.src, ['https', 'http', 'relative']);
          if (mode === 'design') n.appendChild(placeholder('audio', src ? 'Audio: ' + src : 'Audio — paste an audio file link'));
          else if (src) n.appendChild(h('audio', 'sv-media', { src, controls: el.props.controls !== false, loop: !!el.props.loop, preload: 'metadata', 'aria-label': el.props.title || 'Audio' }));
          break;
        }
        case 'embed': {
          n = h('div', base, { 'data-svid': el.id });
          const src = Core.safeUrl(el.props.src, ['https']);
          if (mode === 'design') n.appendChild(placeholder('embed', src ? 'Embedded: ' + src : 'Embedded content — paste an https:// link'));
          else if (src) n.appendChild(h('iframe', 'sv-media', { src, title: el.props.title || 'Embedded content', sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation', referrerpolicy: 'no-referrer', loading: 'lazy' }));
          break;
        }
        case 'tabs': {
          n = h('div', base + ' sv-tabs', { 'data-svid': el.id });
          const bar = h('div', 'sv-tabbar', { role: live ? 'tablist' : undefined });
          const panels = (el.children || []).map(getEl).filter(Boolean);
          const active = live && live.tabActive ? live.tabActive(el) : Math.max(0, Math.min(panels.length - 1, num(el.props.active, 0)));
          panels.forEach((p, i) => {
            const b = h('button', 'sv-tab' + (i === active ? ' is-active' : ''), { type: 'button', role: live ? 'tab' : undefined, 'aria-selected': live ? String(i === active) : undefined, tabindex: mode === 'design' ? '-1' : (i === active ? '0' : '-1'), 'data-tab-index': i });
            b.textContent = String(p.props.label || 'Tab ' + (i + 1));
            if (live) b.addEventListener('click', () => live.setTab(el, i));
            bar.appendChild(b);
          });
          n.appendChild(bar);
          childHost = h('div', 'sv-tabpanels');
          n.appendChild(childHost);
          n.dataset.active = String(active);
          break;
        }
        case 'divider': case 'spacer': case 'group': case 'container': case 'section': case 'tabpanel': {
          n = h('div', base, { 'data-svid': el.id, role: t === 'divider' ? 'separator' : undefined });
          if (isContainerType(t)) childHost = n;
          break;
        }
        case 'shape': {
          n = h('div', base + ' sv-shape-' + (el.props.shape || 'rect'), { 'data-svid': el.id, 'aria-hidden': 'true' });
          break;
        }
        case 'button': {
          n = h('button', base + ' sv-button sv-hover-host', { 'data-svid': el.id, type: 'button', tabindex: mode === 'design' ? '-1' : undefined });
          const inner = h('span', 'sv-text');
          inner.textContent = live && live.buttonLabel ? live.buttonLabel(el) : (el.props.text || defaultButtonLabel(el));
          n.appendChild(inner);
          if (live) n.addEventListener('click', e => { e.preventDefault(); live.onButton(el, n); });
          break;
        }
        case 'progress': {
          n = h('div', base + ' sv-progress', { 'data-svid': el.id, role: live ? 'progressbar' : undefined, 'aria-valuemin': live ? '0' : undefined, 'aria-valuemax': live ? '100' : undefined });
          const bar = h('div', 'sv-progress-fill');
          const pct = live && live.progress ? live.progress() : 40;
          bar.style.width = pct + '%';
          if (live) n.setAttribute('aria-valuenow', String(Math.round(pct)));
          n.appendChild(bar);
          if (el.props.showLabel) { const l = h('span', 'sv-progress-label'); l.textContent = Math.round(pct) + '%'; n.appendChild(l); }
          break;
        }
        default: {
          // Question containers and any type registered later.
          n = h('div', base + (isQuestionType(t) ? ' sv-question' : ''), { 'data-svid': el.id });
          if (isQuestionType(t)) {
            n.setAttribute('role', ['single', 'yesno', 'rating', 'likert'].includes(t) && !el.props.multi ? 'radiogroup' : 'group');
            n.setAttribute('aria-labelledby', titleIdOf(el.id));
            if (live) n.setAttribute('aria-describedby', errorIdOf(el.id));
          }
          if (isContainerType(t)) childHost = n;
          if (def.render) { const out = def.render(el, { mode, live, h }); if (out) n.appendChild(out); }
        }
      }
      // Accessibility overrides
      if (el.a11y) {
        if (el.a11y.label && !['option', 'field'].includes(t)) n.setAttribute('aria-label', el.a11y.label);
        if (el.a11y.role && /^[a-z]+$/.test(el.a11y.role)) n.setAttribute('role', el.a11y.role);
        if (el.a11y.description) n.setAttribute('title', el.a11y.description);
        if (live && el.a11y.tabIndex !== undefined && el.a11y.tabIndex !== '' && Number.isFinite(Number(el.a11y.tabIndex))) n.tabIndex = Number(el.a11y.tabIndex);
        if (live && el.a11y.live) n.setAttribute('aria-live', el.a11y.live);
        if (el.a11y.hidden) n.setAttribute('aria-hidden', 'true');
      }
      if (el.responsive && el.responsive.hideMobile) n.classList.add('sv-hide-narrow');
      if (el.responsive && el.responsive.hideDesktop) n.classList.add('sv-hide-wide');
      if (live && el.anim && el.anim.enter && el.anim.enter !== 'none') {
        n.classList.add('sv-anim', 'sv-anim-' + el.anim.enter);
        n.style.setProperty('--sv-anim-dur', num(el.anim.duration, 450) + 'ms');
        n.style.setProperty('--sv-anim-delay', num(el.anim.delay, 0) + 'ms');
        n.style.setProperty('--sv-anim-ease', String(el.anim.easing || 'ease-out').replace(/[^a-z0-9(),.\s-]/gi, ''));
      }
      if (live && el.anim && el.anim.loop && el.anim.loop !== 'none') {
        n.classList.add('sv-loop-' + el.anim.loop);
        n.style.setProperty('--sv-loop-dur', num(el.anim.loopDuration, 2000) + 'ms');
      }
      if (el.hidden) n.classList.add('sv-el-hidden');
      if (mode === 'design') {
        if (el.locked) n.classList.add('sv-locked');
      }
      return { node: n, childHost };
    }

    function defaultButtonLabel(el) {
      const a = el.props.action || {};
      if (a.type === 'back') return doc.settings.backLabel || 'Back';
      if (a.type === 'submit') return doc.settings.submitLabel || 'Submit';
      if (a.type === 'auto') {
        const page = Core.pageOf(doc, el.id);
        const idx = page ? doc.pages.indexOf(page) : 0;
        const later = doc.pages.slice(idx + 1).some(p => !(p.props && p.props.ending));
        return later ? (doc.settings.nextLabel || 'Next') : (doc.settings.submitLabel || 'Submit');
      }
      if (a.type === 'next') return doc.settings.nextLabel || 'Next';
      return 'Button';
    }

    function placeholder(kind, text) {
      const p = h('div', 'sv-placeholder');
      p.innerHTML = SVG(Core.ICONS[kind] || '') + '<span></span>';
      p.querySelector('span').textContent = text;
      return p;
    }

    // Builds an element and its subtree. In live mode the children of free
    // containers are inserted in reading order (top→bottom, left→right) for
    // screen readers; z-index keeps the visual stacking order.
    function build(id) {
      const el = getEl(id);
      if (!el) return null;
      const { node, childHost } = nodeFor(el);
      nodes.set(id, node);
      if (childHost) childHosts.set(id, childHost); else childHosts.delete(id);
      writeStyle(id);
      if (childHost && Array.isArray(el.children)) {
        applyLayout(id);
        orderedChildren(el.children, layoutOfRef(id)).forEach(cid => { const c = build(cid); if (c) childHost.appendChild(c); });
        if (el.type === 'tabs') {
          const active = Number(node.dataset.active || 0);
          el.children.forEach((cid, i) => { const c = nodes.get(cid); if (c) c.classList.toggle('sv-tab-hidden', i !== active); });
        }
      }
      applyFrame(id);
      if (mode === 'design' && opts.decorate) opts.decorate(el, node);
      return node;
    }
    function orderedChildren(ids, lay) {
      if (mode !== 'live' || lay.mode !== 'free') return ids.slice();
      return ids.slice().sort((a, b) => {
        const A = getEl(a), B = getEl(b);
        if (!A || !B) return 0;
        const dockA = A.frame.dock === 'bottom' ? 1 : 0, dockB = B.frame.dock === 'bottom' ? 1 : 0;
        if (dockA !== dockB) return dockA - dockB;
        const dy = num(A.frame.y, 0) - num(B.frame.y, 0);
        return Math.abs(dy) > 4 ? dy : num(A.frame.x, 0) - num(B.frame.x, 0);
      });
    }

    function renderPage(pid) {
      pageId = pid;
      nodes.clear(); childHosts.clear();
      styleTags.forEach(t => t.remove()); styleTags.clear();
      writeTokens();
      artboard.innerHTML = '';
      const page = Core.getPage(doc, pid);
      artboard.dataset.page = pid || '';
      artboard.style.width = num(doc.settings.width, 760) + 'px';
      if (!page) return;
      artboard.setAttribute('aria-label', page.name);
      orderedChildren(page.children, { mode: 'free' }).forEach(id => { const n = build(id); if (n) artboard.appendChild(n); });
      layout();
    }

    // Re-renders elements in place (content + styles + subtree).
    function refresh(ids) {
      const list = ids ? Array.from(new Set(ids)) : null;
      if (!list) { renderPage(pageId); return; }
      // Only the outermost of the requested ids need rebuilding.
      const set = new Set(list.filter(id => nodes.has(id)));
      const outer = Array.from(set).filter(id => !Core.ancestors(doc, id).some(a => set.has(a)));
      outer.forEach(id => {
        const old = nodes.get(id);
        if (!old || !old.parentNode) return;
        // drop stale descendants from the maps
        Core.descendants(doc, id).forEach(d => { nodes.delete(d); });
        const fresh = build(id);
        if (fresh) old.parentNode.replaceChild(fresh, old);
      });
      layout();
    }
    function restyle(ids) { (ids || Array.from(nodes.keys())).forEach(id => { if (nodes.has(id)) writeStyle(id); }); }
    function restyleAll() { writeTokens(); restyle(); }
    function reframe(ids) { ids.forEach(id => { applyFrame(id); if (childHosts.has(id)) applyLayout(id); }); layout(); }

    // Post-layout pass: auto-size free containers, place docked elements,
    // apply 4-corner distortion (needs the measured size) and size the page.
    function layout() {
      const page = Core.getPage(doc, pageId);
      if (!page) return;
      const ids = Array.from(nodes.keys());
      // deepest first
      const depth = id => Core.ancestors(doc, id).length;
      ids.filter(id => childHosts.has(id)).sort((a, b) => depth(b) - depth(a)).forEach(id => {
        const el = getEl(id), node = nodes.get(id);
        if (!el || !node) return;
        const lay = (el.props && el.props.layout) || { mode: 'free' };
        if (lay.mode === 'stack' || lay.mode === 'grid') return;
        const kids = (el.children || []).map(c => nodes.get(c)).filter(k => k && !isOff(k) && k.parentNode === childHosts.get(id));
        const cs = getComputedStyle(node);
        if (el.frame.h === 'auto') {
          const bottom = kids.reduce((m, k) => Math.max(m, k.offsetTop + k.offsetHeight), 0);
          node.style.height = Math.max(24, bottom + parseFloat(cs.paddingBottom || 0) + parseFloat(cs.borderBottomWidth || 0)) + 'px';
        }
        if (el.frame.w === 'auto') {
          const right = kids.reduce((m, k) => Math.max(m, k.offsetLeft + k.offsetWidth), 0);
          node.style.width = Math.max(24, right + parseFloat(cs.paddingRight || 0) + parseFloat(cs.borderRightWidth || 0)) + 'px';
        }
      });
      // docked elements under the page content
      const free = page.children.map(id => ({ id, el: getEl(id), node: nodes.get(id) })).filter(x => x.el && x.node && !isOff(x.node));
      let contentBottom = 0;
      free.forEach(x => { if (x.el.frame.dock !== 'bottom') contentBottom = Math.max(contentBottom, x.node.offsetTop + x.node.offsetHeight); });
      let bottom = contentBottom;
      free.forEach(x => {
        if (x.el.frame.dock !== 'bottom') return;
        const top = contentBottom + num(x.el.frame.y, 32);
        x.node.style.top = top + 'px';
        bottom = Math.max(bottom, top + x.node.offsetHeight);
      });
      // distortion needs the measured box
      ids.forEach(id => { const el = getEl(id); if (el && el.frame.distort) applyFrame(id); });
      const pad = 48;
      const minH = mode === 'design' ? num(page.minHeight, 640) : num(page.props && page.props.minHeight, 0);
      artboard.style.height = Math.max(minH, Math.ceil(bottom + pad)) + 'px';
      if (opts.onLayout) opts.onLayout();
    }

    function setForcedState(id, state) {
      nodes.forEach(n => n.classList.remove('sv-force-hover', 'sv-force-focus', 'sv-force-active', 'is-checked', 'is-disabled'));
      if (!id || !state) return;
      const n = nodes.get(id);
      if (!n) return;
      if (state === 'checked') n.classList.add('is-checked');
      else if (state === 'disabled') n.classList.add('is-disabled');
      else n.classList.add('sv-force-' + state);
    }

    return {
      root: rootEl, artboard, scope, scopeSel, mode,
      setDoc(d) { doc = d; },
      get doc() { return doc; },
      get pageId() { return pageId; },
      renderPage, refresh, restyle, restyleAll, reframe, layout, writeTokens,
      node: id => nodes.get(id) || null,
      childHost: id => childHosts.get(id) || null,
      nodes: () => nodes,
      syncRange, titleIdOf, errorIdOf, defaultButtonLabel, setForcedState,
      destroy() { rootEl.remove(); nodes.clear(); childHosts.clear(); styleTags.clear(); }
    };
  }

  root.SurveyRender = { create };
})(typeof window !== 'undefined' ? window : this);
