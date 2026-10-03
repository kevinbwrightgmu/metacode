/* ══════════════════════════════════════════════
   survey-inspector.js — the properties panel

   Shows every property of the selected element(s), grouped into sections
   (Content, Layout, Transform, Appearance, Typography, Spacing, Effects,
   States, Behavior, Animation, Accessibility, Responsive, Advanced).
   "Basic" shows the common fields; "All" shows everything.

   Style fields show where their value comes from: a filled dot means the
   value is set on this element (click it to reset), a hollow dot means it
   is inherited from the theme (Theme tab → element defaults).

   Fields are declared as data — { label, path, kind, … } — so new element
   types only need to declare their own content fields.
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore, Logic = root.SurveyLogic;
  const { num, isObj, clone } = Core;
  const PREF_KEY = 'metacode_survey_inspector_v1';

  const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const TEXT_TYPES = ['heading', 'paragraph', 'label', 'richtext', 'instructions', 'caption', 'qtitle', 'qdesc', 'optlabel', 'qerror'];
  const CONTAINERS = t => Core.isContainerType(t);
  const QUESTION = t => Core.isQuestionType(t);

  const OPTS = {
    weight: [['', 'Inherit'], ['300', 'Light 300'], ['400', 'Regular 400'], ['500', 'Medium 500'], ['600', 'Semibold 600'], ['700', 'Bold 700'], ['800', 'Extra bold 800']],
    align: [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']],
    transform: [['', 'None'], ['uppercase', 'UPPERCASE'], ['lowercase', 'lowercase'], ['capitalize', 'Capitalize']],
    decoration: [['', 'None'], ['underline', 'Underline'], ['line-through', 'Strikethrough'], ['overline', 'Overline']],
    borderStyle: [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['double', 'Double']],
    blend: [['', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Color dodge'], ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['luminosity', 'Luminosity']],
    enter: [['none', 'None'], ['fade', 'Fade in'], ['slide-up', 'Slide up'], ['slide-down', 'Slide down'], ['slide-left', 'Slide from right'], ['slide-right', 'Slide from left'], ['zoom', 'Zoom in'], ['pop', 'Pop'], ['spin', 'Spin in'], ['blur', 'Blur in']],
    loop: [['none', 'None'], ['pulse', 'Pulse'], ['float', 'Float'], ['spin', 'Spin'], ['wiggle', 'Wiggle']],
    easing: [['ease-out', 'Ease out'], ['ease-in-out', 'Ease in-out'], ['ease-in', 'Ease in'], ['linear', 'Linear'], ['cubic-bezier(.34,1.56,.64,1)', 'Overshoot']],
    clip: [['none', 'None'], ['circle', 'Circle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['pentagon', 'Pentagon'], ['hexagon', 'Hexagon'], ['star', 'Star'], ['arrow', 'Arrow'], ['message', 'Speech bubble'], ['parallelogram', 'Parallelogram'], ['inset', 'Inset (custom)'], ['polygon', 'Polygon (custom points)']],
    mask: [['', 'None'], ['fade-bottom', 'Fade bottom'], ['fade-top', 'Fade top'], ['fade-left', 'Fade left'], ['fade-right', 'Fade right'], ['radial', 'Radial vignette']],
    overflow: [['', 'Visible'], ['hidden', 'Clip contents'], ['auto', 'Scroll']],
    cursor: [['', 'Default'], ['pointer', 'Pointer'], ['text', 'Text'], ['move', 'Move'], ['not-allowed', 'Not allowed'], ['help', 'Help']],
    shape: [['radio', 'Radio'], ['checkbox', 'Checkbox'], ['star', 'Star'], ['heart', 'Heart'], ['circle', 'Circle'], ['square', 'Square'], ['toggle', 'Toggle switch'], ['number', 'Number']],
    role: [['', 'Automatic'], ['group', 'group'], ['region', 'region'], ['note', 'note'], ['img', 'img'], ['heading', 'heading'], ['presentation', 'presentation'], ['status', 'status'], ['alert', 'alert']],
    live: [['', 'Off'], ['polite', 'Polite'], ['assertive', 'Assertive']],
    fit: [['cover', 'Cover'], ['contain', 'Contain'], ['fill', 'Stretch'], ['none', 'Original size'], ['scale-down', 'Scale down']],
    shapeKind: [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'], ['star', 'Star'], ['line', 'Line']],
    format: [['', 'Any text'], ['email', 'Email address'], ['url', 'Web address'], ['phone', 'Phone number'], ['number', 'Number'], ['integer', 'Whole number']],
    tag: [['h1', 'H1'], ['h2', 'H2'], ['h3', 'H3'], ['h4', 'H4'], ['h5', 'H5'], ['h6', 'H6']]
  };

  function create(container, store, cmds, opts) {
    opts = opts || {};
    const doc = () => store.doc;
    let prefs = { all: false, closed: {} };
    try { prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* defaults */ }
    let bindings = [];
    let renderedFor = '';
    let selfChange = false;
    let stateTab = 'hover';
    let forcing = false;
    let popover = null;

    container.classList.add('ss-inspector');
    const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

    /* ── Value access ─────────────────────── */
    // Each field binds to `path` on its target element (default: the selected one).
    function targetsFor(f, els) { return els.map(el => (f.target ? f.target(el) : el)).filter(Boolean); }
    function valueOf(f, els) {
      const ts = targetsFor(f, els);
      if (!ts.length) return { value: undefined, mixed: false };
      const vals = ts.map(t => (f.get ? f.get(t) : Core.getPath(t, f.path)));
      const mixed = vals.some(v => JSON.stringify(v) !== JSON.stringify(vals[0]));
      return { value: vals[0], mixed };
    }
    function inheritedOf(f, els) {
      if (!f.path || f.path.indexOf('style.') !== 0) return undefined;
      const t = targetsFor(f, els)[0];
      if (!t) return undefined;
      return Core.getPath(Core.inheritedStyle(doc(), t), f.path.slice(6));
    }
    function setValue(f, els, value, o) {
      if (f.custom) { selfChange = true; try { f.custom(value); } finally { selfChange = false; } render(true); return; }
      const ts = targetsFor(f, els);
      if (!ts.length) return;
      selfChange = true;
      try {
        store.tx((o && o.label) || 'Change ' + (f.label || 'property').toLowerCase(), t => ts.forEach(target => {
          const el = t.el(target.id);
          if (!el) return;
          if (f.set) f.set(el, value, t);
          else Core.setPath(el, f.path, value === '' && f.emptyUndefined !== false && f.kind !== 'text' && f.kind !== 'textarea' ? undefined : value);
        }), { coalesce: (o && o.coalesce === false) ? null : 'insp:' + (f.path || f.label) + ':' + ts.map(x => x.id).join(',') });
      } finally { selfChange = false; }
      refreshValues();
    }

    /* ── Field widgets ────────────────────── */
    function fieldRow(f, els) {
      const row = document.createElement('div');
      row.className = 'ss-field ss-field-' + f.kind + (f.wide ? ' is-wide' : '');
      const id = 'ssf-' + Math.random().toString(36).slice(2, 9);
      const isStyle = f.path && f.path.indexOf('style.') === 0;
      const lab = document.createElement('label');
      lab.className = 'ss-field-label';
      lab.htmlFor = id;
      lab.textContent = f.label;
      if (f.hint) lab.title = f.hint;
      row.appendChild(lab);
      const dot = document.createElement('button');
      if (isStyle) {
        dot.type = 'button';
        dot.className = 'ss-dot';
        lab.prepend(dot);
        dot.addEventListener('click', e => { e.preventDefault(); if (dot.classList.contains('is-set')) setValue(f, els, undefined, { label: 'Reset ' + f.label.toLowerCase(), coalesce: false }); });
      }
      const ctl = document.createElement('div');
      ctl.className = 'ss-field-ctl';
      row.appendChild(ctl);
      const widget = WIDGETS[f.kind] || WIDGETS.text;
      const api = widget(ctl, f, id, v => setValue(f, els, v), els, lab);
      const update = () => {
        const { value, mixed } = valueOf(f, els);
        const inherited = inheritedOf(f, els);
        if (isStyle) {
          const set = value !== undefined;
          dot.classList.toggle('is-set', set);
          dot.title = set ? 'Set on this element — click to reset to the theme value' : 'Inherited from the theme';
          dot.setAttribute('aria-label', dot.title);
        }
        row.classList.toggle('is-inherited', isStyle && value === undefined);
        api.update(value, { mixed, inherited });
      };
      update();
      bindings.push(update);
      return row;
    }

    function numInput(id, f, onChange, label) {
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.className = 'ss-input ss-num';
      input.id = id;
      input.autocomplete = 'off';
      const commit = () => {
        const raw = input.value.trim();
        if (raw === '') { onChange(f.allowEmpty === false ? (f.min !== undefined ? f.min : 0) : ''); return; }
        let v = Number(raw.replace(',', '.'));
        if (!Number.isFinite(v)) {
          // simple arithmetic like "120+16" or "50*2"
          if (/^[\d\s+\-*/.()]+$/.test(raw)) { try { v = Logic.evaluate(raw, Logic.makeEnv(doc(), { answers: {} })); } catch (e) { v = NaN; } }
          if (!Number.isFinite(v)) return;
        }
        if (f.min !== undefined) v = Math.max(f.min, v);
        if (f.max !== undefined) v = Math.min(f.max, v);
        if (f.round !== false) v = Math.round(v * 1000) / 1000;
        onChange(v);
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = (f.step || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          const cur = Number(input.value) || 0;
          input.value = String(Math.round((cur + step) * 1000) / 1000);
          commit();
        } else if (e.key === 'Enter') { commit(); input.select(); }
      });
      // scrub: drag the label left/right
      if (label) {
        label.classList.add('ss-scrub');
        label.addEventListener('pointerdown', e => {
          if (e.target.closest('.ss-dot')) return;
          e.preventDefault();
          const x0 = e.clientX, v0 = Number(input.value) || Number(input.placeholder) || 0;
          const step = f.step || 1;
          label.setPointerCapture(e.pointerId);
          const mv = ev => {
            let v = v0 + Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1);
            if (f.min !== undefined) v = Math.max(f.min, v);
            if (f.max !== undefined) v = Math.min(f.max, v);
            v = Math.round(v * 1000) / 1000;
            input.value = String(v);
            onChange(v);
          };
          const up = () => { label.removeEventListener('pointermove', mv); label.removeEventListener('pointerup', up); };
          label.addEventListener('pointermove', mv);
          label.addEventListener('pointerup', up);
        });
      }
      return input;
    }

    const WIDGETS = {
      number(ctl, f, id, onChange, els, label) {
        const input = numInput(id, f, onChange, label);
        ctl.appendChild(input);
        if (f.unit) { const u = document.createElement('span'); u.className = 'ss-unit'; u.textContent = f.unit; ctl.appendChild(u); }
        return { update(v, s) { if (document.activeElement === input) return; input.value = s.mixed ? '' : (v === undefined || v === null || v === '' ? '' : String(v)); input.placeholder = s.mixed ? 'Mixed' : (s.inherited !== undefined && typeof s.inherited !== 'object' ? String(s.inherited).replace(/^var\(--sv-(\w+)\)$/, (m, k) => String(tokenValue(k) === undefined ? k : tokenValue(k))) : (f.placeholder || '')); } };
      },
      size(ctl, f, id, onChange, els, label) {
        const input = numInput(id, f, onChange, label);
        const mode = document.createElement('select');
        mode.className = 'ss-select ss-mini';
        mode.setAttribute('aria-label', f.label + ' mode');
        [['fixed', 'Fixed'], ['fill', 'Fill'], ['auto', 'Hug']].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; mode.appendChild(o); });
        mode.addEventListener('change', () => {
          if (mode.value === 'fixed') { const m = opts.measure && els[0] && opts.measure(els[0].id); onChange(Math.round(m ? (f.path === 'frame.w' ? m.w : m.h) : 100)); }
          else onChange(mode.value);
        });
        ctl.appendChild(input); ctl.appendChild(mode);
        return {
          update(v, s) {
            const numeric = typeof v === 'number';
            mode.value = s.mixed ? 'fixed' : (numeric ? 'fixed' : (v === 'fill' ? 'fill' : 'auto'));
            if (document.activeElement !== input) {
              if (numeric && !s.mixed) input.value = String(v);
              else { input.value = ''; const m = !s.mixed && opts.measure && els[0] && opts.measure(els[0].id); input.placeholder = s.mixed ? 'Mixed' : (m ? String(Math.round(f.path === 'frame.w' ? m.w : m.h)) : ''); }
            }
          }
        };
      },
      text(ctl, f, id, onChange) {
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'ss-input'; input.id = id; input.autocomplete = 'off';
        if (f.placeholder) input.placeholder = f.placeholder;
        input.addEventListener(f.live ? 'input' : 'change', () => onChange(input.value));
        if (f.live) input.addEventListener('change', () => onChange(input.value));
        ctl.appendChild(input);
        return { update(v, s) { if (document.activeElement === input) return; input.value = s.mixed ? '' : (v === undefined || v === null ? '' : String(v)); input.placeholder = s.mixed ? 'Mixed' : (s.inherited !== undefined ? String(s.inherited) : (f.placeholder || '')); } };
      },
      textarea(ctl, f, id, onChange) {
        const ta = document.createElement('textarea');
        ta.className = 'ss-input ss-textarea' + (f.mono ? ' is-mono' : ''); ta.id = id; ta.rows = f.rows || 3; ta.spellcheck = !f.mono;
        if (f.placeholder) ta.placeholder = f.placeholder;
        ta.addEventListener('input', () => onChange(ta.value));
        ctl.appendChild(ta);
        return { update(v, s) { if (document.activeElement === ta) return; ta.value = s.mixed ? '' : (v === undefined || v === null ? '' : String(v)); } };
      },
      select(ctl, f, id, onChange) {
        const sel = document.createElement('select');
        sel.className = 'ss-select'; sel.id = id;
        const items = typeof f.options === 'function' ? f.options() : f.options;
        items.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); });
        sel.addEventListener('change', () => onChange(f.numeric ? Number(sel.value) : sel.value));
        ctl.appendChild(sel);
        return { update(v, s) { const val = s.mixed ? '' : (v === undefined || v === null ? (s.inherited !== undefined ? String(s.inherited) : (f.def !== undefined ? String(f.def) : '')) : String(v)); if (!Array.from(sel.options).some(o => o.value === val)) { const o = document.createElement('option'); o.value = val; o.textContent = s.mixed ? 'Mixed' : (val || '—'); sel.appendChild(o); } sel.value = val; } };
      },
      toggle(ctl, f, id, onChange) {
        const wrap = document.createElement('label'); wrap.className = 'ss-switch';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = id;
        cb.addEventListener('change', () => onChange(f.invert ? !cb.checked : cb.checked));
        const knob = document.createElement('span'); knob.className = 'ss-switch-knob';
        wrap.appendChild(cb); wrap.appendChild(knob);
        ctl.appendChild(wrap);
        return { update(v, s) { const b = !!v; cb.checked = f.invert ? !b : b; cb.indeterminate = !!s.mixed; } };
      },
      seg(ctl, f, id, onChange) {
        const wrap = document.createElement('div'); wrap.className = 'ss-seg'; wrap.setAttribute('role', 'radiogroup'); wrap.id = id;
        const btns = f.options.map(([v, l, title]) => {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'ss-seg-btn'; b.innerHTML = l; b.title = title || ''; b.setAttribute('aria-label', title || String(l).replace(/<[^>]+>/g, ''));
          b.setAttribute('role', 'radio');
          b.addEventListener('click', () => onChange(v));
          wrap.appendChild(b);
          return [v, b];
        });
        ctl.appendChild(wrap);
        return { update(v, s) { const val = v === undefined ? (s.inherited !== undefined ? s.inherited : f.def) : v; btns.forEach(([bv, b]) => { const on = !s.mixed && String(bv) === String(val); b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); }); } };
      },
      range(ctl, f, id, onChange) {
        const r = document.createElement('input'); r.type = 'range'; r.className = 'ss-range'; r.id = id;
        r.min = f.min; r.max = f.max; r.step = f.step || 0.01;
        const n = document.createElement('input'); n.type = 'text'; n.className = 'ss-input ss-num ss-num-sm'; n.setAttribute('aria-label', f.label);
        r.addEventListener('input', () => { n.value = r.value; onChange(Number(r.value)); });
        n.addEventListener('change', () => { const v = Number(n.value); if (Number.isFinite(v)) onChange(Math.min(f.max, Math.max(f.min, v))); });
        ctl.appendChild(r); ctl.appendChild(n);
        return { update(v, s) { const val = v === undefined ? (typeof s.inherited === 'number' ? s.inherited : f.def) : v; if (document.activeElement !== r) r.value = String(val); if (document.activeElement !== n) n.value = s.mixed ? '' : String(val); } };
      },
      color(ctl, f, id, onChange) {
        const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'ss-swatch'; sw.setAttribute('aria-label', 'Choose ' + f.label.toLowerCase());
        const input = document.createElement('input'); input.type = 'text'; input.className = 'ss-input ss-color-text'; input.id = id; input.autocomplete = 'off'; input.spellcheck = false;
        input.addEventListener('change', () => onChange(input.value.trim()));
        sw.addEventListener('click', () => openColor(sw, input.value || input.placeholder, v => { input.value = v; onChange(v); }));
        ctl.appendChild(sw); ctl.appendChild(input);
        return {
          update(v, s) {
            const shown = v !== undefined ? v : s.inherited;
            sw.style.setProperty('--c', resolveColor(shown));
            sw.classList.toggle('is-empty', !shown || shown === 'transparent');
            if (document.activeElement !== input) { input.value = s.mixed ? '' : (v === undefined ? '' : prettyColor(v)); input.placeholder = s.mixed ? 'Mixed' : prettyColor(s.inherited || ''); }
          }
        };
      },
      font(ctl, f, id, onChange) {
        const sel = document.createElement('select'); sel.className = 'ss-select'; sel.id = id;
        Core.FONTS.forEach(ft => { const o = document.createElement('option'); o.value = ft.value; o.textContent = ft.label; sel.appendChild(o); });
        const custom = document.createElement('option'); custom.value = '__custom'; custom.textContent = 'Custom…'; sel.appendChild(custom);
        sel.addEventListener('change', () => {
          if (sel.value === '__custom') { const v = prompt('Font family (CSS), e.g. "Roboto", sans-serif'); if (v) onChange(Core.cleanValue(v)); }
          else onChange(sel.value);
        });
        ctl.appendChild(sel);
        return { update(v, s) { const val = v !== undefined ? v : (s.inherited || ''); if (!Array.from(sel.options).some(o => o.value === val)) { const o = document.createElement('option'); o.value = val; o.textContent = String(val).replace(/^var\(--sv-(\w+)\)$/, 'Theme $1') || 'Inherit'; sel.insertBefore(o, custom); } sel.value = val; } };
      },
      box4(ctl, f, id, onChange) {
        const wrap = document.createElement('div'); wrap.className = 'ss-box4';
        const names = ['Top', 'Right', 'Bottom', 'Left'];
        const inputs = names.map((n, i) => {
          const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.className = 'ss-input ss-num ss-num-sm'; inp.setAttribute('aria-label', f.label + ' ' + n.toLowerCase()); inp.title = n;
          if (i === 0) inp.id = id;
          inp.addEventListener('change', () => {
            const vals = inputs.map(x => (x.value.trim() === '' ? null : Number(x.value)));
            if (vals.every(v => v === null)) return onChange(undefined);
            const base = currentBase();
            onChange(vals.map((v, k) => (v === null || !Number.isFinite(v) ? base[k] : v)));
          });
          wrap.appendChild(inp);
          return inp;
        });
        let base = [0, 0, 0, 0];
        const currentBase = () => base;
        const all = document.createElement('button'); all.type = 'button'; all.className = 'ss-mini-btn'; all.textContent = '='; all.title = 'Use the top value on all sides';
        all.addEventListener('click', () => { const v = Number(inputs[0].value || inputs[0].placeholder || 0); onChange([v, v, v, v]); });
        wrap.appendChild(all);
        ctl.appendChild(wrap);
        return { update(v, s) { const arr = Array.isArray(v) ? v : null; const inh = Array.isArray(s.inherited) ? s.inherited : [0, 0, 0, 0]; base = arr || inh; inputs.forEach((inp, i) => { if (document.activeElement === inp) return; inp.value = arr && !s.mixed ? String(arr[i]) : ''; inp.placeholder = String(inh[i] === undefined ? 0 : inh[i]); }); } };
      },
      origin(ctl, f, id, onChange, els) {
        const g = document.createElement('div'); g.className = 'ss-origin'; g.id = id; g.setAttribute('role', 'radiogroup');
        const cells = [];
        [0, 0.5, 1].forEach(oy => [0, 0.5, 1].forEach(ox => {
          const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'Origin ' + ['left', 'centre', 'right'][ox * 2] + ' ' + ['top', 'middle', 'bottom'][oy * 2]);
          b.addEventListener('click', () => {
            selfChange = true;
            try {
              store.tx('Change origin', t => els.forEach(e => {
                // keep the element visually in place when moving its origin
                const el = t.el(e.id);
                const m = opts.measure && opts.measure(e.id) || { w: num(el.frame.w, 100), h: num(el.frame.h, 50) };
                const before = Core.localToParent(el.frame, m.w, m.h, 0, 0);
                el.frame.ox = ox; el.frame.oy = oy;
                const after = Core.localToParent(el.frame, m.w, m.h, 0, 0);
                el.frame.x = Math.round(num(el.frame.x, 0) + before.x - after.x); el.frame.y = Math.round(num(el.frame.y, 0) + before.y - after.y);
              }));
            } finally { selfChange = false; }
            refreshValues();
          });
          g.appendChild(b); cells.push([ox, oy, b]);
        }));
        ctl.appendChild(g);
        return { update() { const fr = els[0].frame; cells.forEach(([ox, oy, b]) => b.classList.toggle('is-on', num(fr.ox, 0.5) === ox && num(fr.oy, 0.5) === oy)); } };
      },
      shadows(ctl, f, id, onChange) {
        const list = document.createElement('div'); list.className = 'ss-shadows'; list.id = id;
        const add = document.createElement('button'); add.type = 'button'; add.className = 'ss-link-btn'; add.textContent = '+ Add shadow';
        let cur = [];
        add.addEventListener('click', () => onChange(cur.concat([{ x: 0, y: 4, blur: 12, spread: 0, color: 'rgba(15,23,42,0.12)' }])));
        ctl.appendChild(list); ctl.appendChild(add);
        return {
          update(v, s) {
            cur = Array.isArray(v) ? clone(v) : (Array.isArray(s.inherited) ? clone(s.inherited) : []);
            list.innerHTML = '';
            cur.forEach((sh, i) => {
              const row = document.createElement('div'); row.className = 'ss-shadow-row';
              [['x', 'X'], ['y', 'Y'], ['blur', 'Blur'], ['spread', 'Spread']].forEach(([k, l]) => {
                const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ss-input ss-num ss-num-sm'; inp.value = num(sh[k], 0); inp.title = l; inp.setAttribute('aria-label', 'Shadow ' + (i + 1) + ' ' + l);
                inp.addEventListener('change', () => { cur[i][k] = Number(inp.value) || 0; onChange(cur); });
                row.appendChild(inp);
              });
              const c = document.createElement('button'); c.type = 'button'; c.className = 'ss-swatch ss-swatch-sm'; c.style.setProperty('--c', resolveColor(sh.color)); c.setAttribute('aria-label', 'Shadow colour');
              c.addEventListener('click', () => openColor(c, sh.color, val => { cur[i].color = val; onChange(cur); }));
              row.appendChild(c);
              const inset = document.createElement('button'); inset.type = 'button'; inset.className = 'ss-mini-btn' + (sh.inset ? ' is-on' : ''); inset.textContent = 'In'; inset.title = 'Inner shadow';
              inset.addEventListener('click', () => { cur[i].inset = !cur[i].inset; onChange(cur); });
              row.appendChild(inset);
              const del = document.createElement('button'); del.type = 'button'; del.className = 'ss-mini-btn'; del.textContent = '✕'; del.setAttribute('aria-label', 'Remove shadow');
              del.addEventListener('click', () => { cur.splice(i, 1); onChange(cur.length ? cur : []); });
              row.appendChild(del);
              list.appendChild(row);
            });
          }
        };
      },
      distort(ctl, f, id, onChange) {
        const wrap = document.createElement('div'); wrap.className = 'ss-distort'; wrap.id = id;
        const corners = [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right']];
        let cur = {};
        const inputs = {};
        corners.forEach(([k, l]) => {
          const cell = document.createElement('div'); cell.className = 'ss-distort-cell';
          const t = document.createElement('span'); t.textContent = l; cell.appendChild(t);
          inputs[k] = [0, 1].map(axis => {
            const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ss-input ss-num ss-num-sm'; inp.setAttribute('aria-label', l + ' ' + (axis ? 'Y' : 'X') + ' offset'); inp.placeholder = axis ? 'Y' : 'X';
            inp.addEventListener('change', () => { const c = Object.assign({ tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] }, clone(cur)); c[k] = (c[k] || [0, 0]).slice(); c[k][axis] = Number(inp.value) || 0; onChange(c); });
            cell.appendChild(inp);
            return inp;
          });
          wrap.appendChild(cell);
        });
        const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'ss-link-btn'; reset.textContent = 'Reset distortion';
        reset.addEventListener('click', () => onChange(undefined));
        ctl.appendChild(wrap); ctl.appendChild(reset);
        return { update(v) { cur = isObj(v) ? v : {}; corners.forEach(([k]) => inputs[k].forEach((inp, axis) => { if (document.activeElement !== inp) inp.value = cur[k] ? String(cur[k][axis] || 0) : ''; })); } };
      },
      list(ctl, f, id, onChange) {
        // editable rows of { label, value, score } (dropdown options, matrix columns)
        const wrap = document.createElement('div'); wrap.className = 'ss-list'; wrap.id = id;
        const add = document.createElement('button'); add.type = 'button'; add.className = 'ss-link-btn'; add.textContent = '+ ' + (f.addLabel || 'Add');
        let cur = [];
        add.addEventListener('click', () => { const n = cur.length + 1; onChange(cur.concat([{ label: (f.itemLabel || 'Option') + ' ' + n, value: Core.slug((f.itemLabel || 'option') + '_' + n), score: 0 }])); });
        ctl.appendChild(wrap); ctl.appendChild(add);
        return {
          update(v) {
            cur = Array.isArray(v) ? clone(v) : [];
            wrap.innerHTML = '<div class="ss-list-head"><span>Label</span><span>Value</span><span>Score</span><span></span></div>';
            cur.forEach((it, i) => {
              const row = document.createElement('div'); row.className = 'ss-list-row';
              ['label', 'value', 'score'].forEach(k => {
                const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ss-input'; inp.value = it[k] === undefined ? '' : String(it[k]); inp.setAttribute('aria-label', k + ' of item ' + (i + 1));
                inp.addEventListener('change', () => { cur[i][k] = k === 'score' ? (Number(inp.value) || 0) : (k === 'value' && /^-?\d+(\.\d+)?$/.test(inp.value) ? Number(inp.value) : inp.value); if (k === 'label' && !it._valueEdited && (String(cur[i].value).startsWith('option_') || !cur[i].value)) cur[i].value = Core.slug(inp.value); onChange(cur); });
                row.appendChild(inp);
              });
              const ctrls = document.createElement('span'); ctrls.className = 'ss-list-ctrls';
              [['↑', -1, 'Move up'], ['↓', 1, 'Move down']].forEach(([s, d, t]) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ss-mini-btn'; b.textContent = s; b.title = t; b.setAttribute('aria-label', t); b.addEventListener('click', () => { const j = i + d; if (j < 0 || j >= cur.length) return; const [x] = cur.splice(i, 1); cur.splice(j, 0, x); onChange(cur); }); ctrls.appendChild(b); });
              const del = document.createElement('button'); del.type = 'button'; del.className = 'ss-mini-btn'; del.textContent = '✕'; del.setAttribute('aria-label', 'Remove item ' + (i + 1));
              del.addEventListener('click', () => { cur.splice(i, 1); onChange(cur); });
              ctrls.appendChild(del);
              row.appendChild(ctrls);
              wrap.appendChild(row);
            });
          }
        };
      },
      action(ctl, f, id, onChange) {
        const type = document.createElement('select'); type.className = 'ss-select'; type.id = id;
        [['none', 'Nothing (use logic rules)'], ['auto', 'Next page, or Submit on the last page'], ['next', 'Next page'], ['back', 'Previous page'], ['submit', 'Submit the survey'], ['goto', 'Go to a page…'], ['url', 'Open a link…']]
          .forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; type.appendChild(o); });
        const target = document.createElement('select'); target.className = 'ss-select'; target.setAttribute('aria-label', 'Target page');
        const url = document.createElement('input'); url.type = 'text'; url.className = 'ss-input'; url.placeholder = 'https://…'; url.setAttribute('aria-label', 'Link address');
        let cur = {};
        const emit = () => onChange(Object.assign({}, { type: type.value }, type.value === 'goto' ? { target: target.value } : {}, type.value === 'url' ? { target: url.value.trim() } : {}));
        type.addEventListener('change', emit); target.addEventListener('change', emit); url.addEventListener('change', emit);
        ctl.appendChild(type); ctl.appendChild(target); ctl.appendChild(url);
        return {
          update(v) {
            cur = isObj(v) ? v : { type: 'none' };
            type.value = cur.type || 'none';
            target.innerHTML = doc().pages.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
            if (cur.type === 'goto') target.value = cur.target || doc().pages[0].id;
            target.style.display = cur.type === 'goto' ? '' : 'none';
            url.style.display = cur.type === 'url' ? '' : 'none';
            if (cur.type === 'url' && document.activeElement !== url) url.value = cur.target || '';
          }
        };
      },
      image(ctl, f, id, onChange) {
        const input = document.createElement('input'); input.type = 'text'; input.className = 'ss-input'; input.id = id; input.placeholder = 'https://… or upload';
        input.addEventListener('change', () => onChange(input.value.trim()));
        const up = document.createElement('button'); up.type = 'button'; up.className = 'ss-mini-btn ss-upload'; up.textContent = 'Upload'; up.title = 'Upload an image (stored inside the survey)';
        const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'; file.hidden = true;
        up.addEventListener('click', () => file.click());
        file.addEventListener('change', () => { const fl = file.files && file.files[0]; if (fl) readImage(fl).then(onChange, e => opts.notify && opts.notify(e.message, 'error')); file.value = ''; });
        ctl.appendChild(input); ctl.appendChild(up); ctl.appendChild(file);
        return { update(v, s) { if (document.activeElement === input) return; input.value = s.mixed ? '' : (typeof v === 'string' && v.startsWith('data:') ? '(uploaded image)' : (v || '')); } };
      },
      expr(ctl, f, id, onChange) {
        const input = document.createElement('input'); input.type = 'text'; input.className = 'ss-input is-mono'; input.id = id; input.placeholder = f.placeholder || 'e.g. value > 0';
        const err = document.createElement('div'); err.className = 'ss-field-err';
        const check = () => { const m = input.value.trim() ? Logic.checkExpression(input.value) : null; err.textContent = m || ''; return !m; };
        input.addEventListener('input', check);
        input.addEventListener('change', () => { if (check()) onChange(input.value.trim()); });
        ctl.appendChild(input); ctl.appendChild(err);
        return { update(v) { if (document.activeElement !== input) { input.value = v || ''; check(); } } };
      },
      json(ctl, f, id, onChange, els) {
        const ta = document.createElement('textarea'); ta.className = 'ss-input ss-textarea is-mono'; ta.rows = 10; ta.id = id; ta.spellcheck = false;
        const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'ss-mini-btn'; apply.textContent = 'Apply JSON';
        const err = document.createElement('div'); err.className = 'ss-field-err';
        apply.addEventListener('click', () => {
          let v;
          try { v = JSON.parse(ta.value); } catch (e) { err.textContent = 'Not valid JSON: ' + e.message; return; }
          if (!isObj(v)) { err.textContent = 'The element must be a JSON object.'; return; }
          const el = els[0];
          // structure fields can't be changed here (use the layers panel)
          v.id = el.id; v.parent = el.parent; v.type = el.type; if (el.children) v.children = el.children.slice(); else delete v.children;
          const test = Core.normalizeDoc({ pages: [{ id: 'p', children: [el.id] }], elements: Object.assign({}, { [el.id]: Object.assign({}, v, { parent: 'page:p', children: undefined }) }) });
          if (test.problems.length) { err.textContent = test.problems[0]; return; }
          err.textContent = '';
          selfChange = true;
          try { store.tx('Edit JSON', t => { const target = t.el(el.id); Object.keys(target).forEach(k => delete target[k]); Object.assign(target, clone(v)); }); } finally { selfChange = false; }
          render(true);
        });
        ctl.appendChild(ta); ctl.appendChild(apply); ctl.appendChild(err);
        return { update() { if (document.activeElement !== ta) ta.value = JSON.stringify(els[0], null, 2); } };
      },
      info(ctl, f) { const d = document.createElement('div'); d.className = 'ss-info'; d.innerHTML = f.html; ctl.appendChild(d); return { update() {} }; }
    };

    function readImage(file) {
      return new Promise((resolve, reject) => {
        if (file.size > 12 * 1024 * 1024) return reject(new Error('That image is larger than 12 MB.'));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The image couldn\'t be read.'));
        reader.onload = () => {
          const src = String(reader.result);
          if (file.type === 'image/svg+xml' || file.type === 'image/gif' || file.size < 400 * 1024) return resolve(src);
          // downscale large photos so the survey stays small
          const img = new Image();
          img.onload = () => {
            const max = 1800, s = Math.min(1, max / Math.max(img.width, img.height));
            const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86));
          };
          img.onerror = () => reject(new Error('That file isn\'t an image MetaCode can read.'));
          img.src = src;
        };
        reader.readAsDataURL(file);
      });
    }

    /* ── Colours ──────────────────────────── */
    function tokenValue(key) { return (doc().theme.tokens || {})[key]; }
    function resolveColor(v) {
      if (!v) return 'transparent';
      return String(v).replace(/var\(--sv-(\w+)\)/g, (m, k) => tokenValue(k) || 'transparent');
    }
    function prettyColor(v) { const m = /^var\(--sv-(\w+)\)$/.exec(String(v || '')); return m ? 'Theme: ' + (Core.TOKENS.find(t => t.key === m[1]) || { label: m[1] }).label : String(v || ''); }
    function toHex(v) {
      const c = resolveColor(v);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillStyle = c;
      return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) ? ctx.fillStyle : '#000000';
    }
    function openColor(anchor, value, onPick) {
      closePopover();
      const pop = document.createElement('div');
      pop.className = 'ss-popover ss-color-pop';
      pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Choose a colour');
      const tokens = Core.TOKENS.filter(t => t.kind === 'color');
      pop.innerHTML = '<div class="ss-pop-title">Theme colours</div><div class="ss-pop-swatches">' +
        tokens.map(t => '<button type="button" class="ss-swatch ss-swatch-sm" style="--c:' + esc(tokenValue(t.key)) + '" data-v="var(--sv-' + t.key + ')" title="' + esc(t.label) + '" aria-label="' + esc(t.label) + '"></button>').join('') +
        '</div><div class="ss-pop-title">Other</div><div class="ss-pop-swatches">' +
        ['transparent', '#FFFFFF', '#000000', 'rgba(15,23,42,0.08)', 'rgba(37,99,235,0.12)', 'linear-gradient(135deg, #2563EB, #7C3AED)', 'linear-gradient(135deg, #0D9488, #2563EB)', 'linear-gradient(180deg, #EFF6FF, #FFFFFF)']
          .map(c => '<button type="button" class="ss-swatch ss-swatch-sm' + (c === 'transparent' ? ' is-empty' : '') + '" style="--c:' + esc(c) + '" data-v="' + esc(c) + '" title="' + esc(c) + '" aria-label="' + esc(c) + '"></button>').join('') +
        '</div><div class="ss-pop-row"><input type="color" class="ss-native-color" aria-label="Pick any colour"><input type="text" class="ss-input" aria-label="Colour value" placeholder="#hex, rgba(), gradient…"></div>';
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 260, r.left - 200)) + 'px';
      pop.style.top = Math.min(window.innerHeight - 260, r.bottom + 6) + 'px';
      const native = pop.querySelector('.ss-native-color'), text = pop.querySelector('.ss-input');
      native.value = toHex(value); text.value = value && !/^var\(/.test(value) ? value : '';
      pop.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { onPick(b.dataset.v); closePopover(); } });
      native.addEventListener('input', () => onPick(native.value));
      text.addEventListener('change', () => { if (text.value.trim()) onPick(Core.cleanValue(text.value.trim())); });
      text.addEventListener('keydown', e => { if (e.key === 'Enter') { if (text.value.trim()) onPick(Core.cleanValue(text.value.trim())); closePopover(); } if (e.key === 'Escape') closePopover(); });
      popover = pop;
      setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
      pop.querySelector('[data-v]').focus();
    }
    function outside(e) { if (popover && !popover.contains(e.target)) closePopover(); }
    function closePopover() { if (popover) { popover.remove(); popover = null; document.removeEventListener('pointerdown', outside, true); } }

    /* ── Section definitions ──────────────── */
    const S = (path, label, kind, extra) => Object.assign({ path: 'style.' + path, label, kind }, extra || {});
    const part = type => el => (Core.isQuestionType(el.type) ? Core.questionParts(doc(), el.id, type)[0] || null : null);

    function contentFields(el) {
      const t = el.type;
      const f = [];
      if (TEXT_TYPES.includes(t)) {
        f.push({ path: 'props.text', label: t === 'richtext' ? 'Text (HTML)' : (t === 'qerror' ? 'Message' : 'Text'), kind: 'textarea', rows: t === 'heading' || t === 'label' || t === 'optlabel' ? 2 : 4, wide: true,
          placeholder: t === 'qerror' ? 'Leave empty to show the validation message' : 'Use {{answerKey}} or {{score}} to insert answers' });
        if (t === 'heading') f.push({ path: 'props.tag', label: 'Level', kind: 'select', options: OPTS.tag, def: 'h2' });
      }
      if (QUESTION(t)) {
        f.push({ label: 'Question', kind: 'textarea', rows: 2, wide: true, target: part('qtitle'), path: 'props.text' });
        f.push({ label: 'Description', kind: 'textarea', rows: 2, wide: true, target: part('qdesc'), path: 'props.text', when: e => !!part('qdesc')(e) });
        const kind = Logic.valueKind(el);
        if (t === 'rating') {
          f.push({ label: 'Scale (items)', kind: 'number', min: 2, max: 20, get: e => Core.questionParts(doc(), e.id, 'option').length, custom: v => cmds.setRatingCount(el.id, v) });
          f.push({ label: 'Symbol', kind: 'select', options: OPTS.shape, get: e => { const i = Core.questionParts(doc(), e.id, 'indicator')[0]; return i ? i.props.shape : 'star'; },
            set: (e, v, tx) => Core.questionParts(doc(), e.id, 'indicator').forEach(i => { tx.el(i.id).props.shape = v; }) });
          f.push({ path: 'props.fillUpTo', label: 'Fill up to choice', kind: 'toggle' });
        } else if (kind === 'choice' || kind === 'multi') {
          if (t !== 'dropdown') {
            f.push({ label: 'Indicator', kind: 'select', options: [['', '—']].concat(OPTS.shape), get: e => { const i = Core.questionParts(doc(), e.id, 'indicator')[0]; return i ? i.props.shape : ''; },
              set: (e, v, tx) => Core.questionParts(doc(), e.id, 'indicator').forEach(i => { if (v) tx.el(i.id).props.shape = v; }) });
            f.push({ path: 'props.multi', label: 'Allow several answers', kind: 'toggle', when: e => e.type !== 'multiple' });
          }
        }
        const field = part('field')(el);
        if (field) fieldPropFields(field.props.kind, part('field')).forEach(x => f.push(x));
        const grid = part('matrixgrid')(el);
        if (grid) f.push({ label: 'Columns', kind: 'list', wide: true, target: part('matrixgrid'), path: 'props.columns', addLabel: 'Add column', itemLabel: 'Column' });
      }
      if (t === 'field') fieldPropFields(el.props.kind).forEach(x => f.push(x));
      if (t === 'option') {
        f.push({ path: 'props.value', label: 'Value', kind: 'text', hint: 'Stored in responses and used by logic', set: (e, v) => { e.props.value = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; } });
        f.push({ path: 'props.score', label: 'Score', kind: 'number', step: 1 });
        f.push({ path: 'props.exclusive', label: 'Clears other choices', kind: 'toggle', hint: '“None of the above” behaviour for multiple-choice questions' });
      }
      if (t === 'indicator') f.push({ path: 'props.shape', label: 'Shape', kind: 'select', options: OPTS.shape });
      if (t === 'rankitem' || t === 'matrixrow' || t === 'tabpanel') {
        f.push({ path: 'props.label', label: 'Label', kind: 'text', live: true });
        if (t !== 'tabpanel') f.push({ path: 'props.value', label: 'Value', kind: 'text' });
      }
      if (t === 'matrixgrid') {
        f.push({ path: 'props.columns', label: 'Columns', kind: 'list', wide: true, addLabel: 'Add column', itemLabel: 'Column' });
        f.push({ path: 'props.rowLabelWidth', label: 'Row label width', kind: 'number', unit: 'px', min: 0 });
      }
      if (t === 'image') {
        f.push({ path: 'props.src', label: 'Image', kind: 'image', wide: true });
        f.push({ path: 'props.alt', label: 'Alt text', kind: 'text', hint: 'Describes the image for screen readers' });
        f.push({ path: 'props.fit', label: 'Fit', kind: 'select', options: OPTS.fit, def: 'cover' });
        f.push({ path: 'props.focusX', label: 'Focus X', kind: 'number', unit: '%', min: 0, max: 100, advanced: true });
        f.push({ path: 'props.focusY', label: 'Focus Y', kind: 'number', unit: '%', min: 0, max: 100, advanced: true });
      }
      if (t === 'video') {
        f.push({ path: 'props.src', label: 'Video link', kind: 'text', wide: true, placeholder: 'YouTube, Vimeo or .mp4 link' });
        f.push({ path: 'props.title', label: 'Title', kind: 'text' });
        f.push({ path: 'props.poster', label: 'Poster image', kind: 'text', advanced: true });
        ['controls', 'autoplay', 'loop', 'muted'].forEach(k => f.push({ path: 'props.' + k, label: k[0].toUpperCase() + k.slice(1), kind: 'toggle', advanced: k !== 'controls' }));
      }
      if (t === 'audio') {
        f.push({ path: 'props.src', label: 'Audio link', kind: 'text', wide: true, placeholder: 'https://…/sound.mp3' });
        f.push({ path: 'props.title', label: 'Title', kind: 'text' });
        f.push({ path: 'props.loop', label: 'Loop', kind: 'toggle' });
      }
      if (t === 'embed') {
        f.push({ path: 'props.src', label: 'Page link', kind: 'text', wide: true, placeholder: 'https://…' });
        f.push({ path: 'props.title', label: 'Title', kind: 'text' });
      }
      if (t === 'button') {
        f.push({ path: 'props.text', label: 'Label', kind: 'text', live: true, placeholder: 'Automatic' });
        f.push({ path: 'props.action', label: 'On click', kind: 'action', wide: true });
        f.push({ path: 'props.autoHide', label: 'Hide on first page', kind: 'toggle', when: e => e.props.action && e.props.action.type === 'back' });
      }
      if (t === 'progress') f.push({ path: 'props.showLabel', label: 'Show percentage', kind: 'toggle' });
      if (t === 'shape') f.push({ path: 'props.shape', label: 'Shape', kind: 'select', options: OPTS.shapeKind });
      if (t === 'tabs') f.push({ path: 'props.active', label: 'Tab shown in editor', kind: 'select', numeric: true, options: () => (el.children || []).map((c, i) => [String(i), (doc().elements[c] && doc().elements[c].props.label) || 'Tab ' + (i + 1)]) });
      return f.filter(x => !x.when || x.when(el));
    }
    function fieldPropFields(kind, target) {
      const f = [];
      const tg = target ? { target } : {};
      if (kind === 'select') f.push(Object.assign({ path: 'props.options', label: 'Options', kind: 'list', wide: true, addLabel: 'Add option', itemLabel: 'Option' }, tg));
      if (kind !== 'range' && kind !== 'date' && kind !== 'time') f.push(Object.assign({ path: 'props.placeholder', label: 'Placeholder', kind: 'text', live: true }, tg));
      if (kind === 'number' || kind === 'range') {
        f.push(Object.assign({ path: 'props.min', label: 'Minimum', kind: 'number' }, tg));
        f.push(Object.assign({ path: 'props.max', label: 'Maximum', kind: 'number' }, tg));
        f.push(Object.assign({ path: 'props.step', label: 'Step', kind: 'number', min: 0 }, tg));
      }
      if (kind === 'range') {
        f.push(Object.assign({ path: 'props.showValue', label: 'Show value', kind: 'toggle' }, tg));
        f.push(Object.assign({ path: 'props.minLabel', label: 'Left label', kind: 'text', live: true }, tg));
        f.push(Object.assign({ path: 'props.maxLabel', label: 'Right label', kind: 'text', live: true }, tg));
      }
      if (kind === 'text' || kind === 'textarea') f.push(Object.assign({ path: 'props.maxLength', label: 'Max characters', kind: 'number', min: 0, advanced: true }, tg));
      return f;
    }

    function layoutFields(el) {
      if (!CONTAINERS(el.type) || el.type === 'tabs') return [];
      const lay = (el.props.layout) || { mode: 'free' };
      const f = [{ path: 'props.layout.mode', label: 'Layout', kind: 'seg', def: 'free', options: [['free', 'Free', 'Free positioning: drag children anywhere'], ['stack', 'Stack', 'Children flow one after another'], ['grid', 'Grid', 'Children fill a grid']] }];
      if (lay.mode === 'stack') {
        f.push({ path: 'props.layout.dir', label: 'Direction', kind: 'seg', def: 'v', options: [['v', '↓ Vertical', 'Top to bottom'], ['h', '→ Horizontal', 'Left to right']] });
        f.push({ path: 'props.layout.align', label: 'Align', kind: 'select', options: [['stretch', 'Stretch'], ['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['baseline', 'Baseline']] });
        f.push({ path: 'props.layout.justify', label: 'Distribute', kind: 'select', options: [['start', 'Start'], ['center', 'Center'], ['end', 'End'], ['between', 'Space between'], ['around', 'Space around'], ['evenly', 'Space evenly']] });
        f.push({ path: 'props.layout.wrap', label: 'Wrap', kind: 'toggle' });
      }
      if (lay.mode === 'grid') f.push({ path: 'props.layout.cols', label: 'Columns', kind: 'number', min: 1, max: 24 });
      if (lay.mode !== 'free') f.push({ path: 'props.layout.gap', label: 'Gap', kind: 'number', unit: 'px', min: 0 });
      f.push(S('overflow', 'Overflow', 'select', { options: OPTS.overflow, advanced: true }));
      return f;
    }

    function transformFields(els) {
      const el = els[0];
      const inFlow = els.every(e => !cmds.isFreeIn(e.id));
      const pageChild = els.every(e => Core.pageIdOfRef(e.parent));
      const f = [];
      if (!pageChild) f.push({ path: 'frame.pos', label: 'Position', kind: 'seg', def: 'flow', options: [['flow', 'In layout', 'Positioned by the parent\'s stack/grid'], ['free', 'Free', 'Positioned by X/Y inside the parent']], hint: 'Elements in a stack can break out and be placed freely' });
      if (pageChild && els.some(e => e.frame.dock)) f.push({ path: 'frame.dock', label: 'Docked below content', kind: 'toggle', set: (e, v) => { e.frame.dock = v ? 'bottom' : undefined; } });
      if (!inFlow) { f.push({ path: 'frame.x', label: 'X', kind: 'number', unit: 'px' }, { path: 'frame.y', label: 'Y', kind: 'number', unit: 'px', hint: el.frame.dock ? 'Distance below the page content (docked)' : '' }); }
      f.push({ path: 'frame.w', label: 'Width', kind: 'size' }, { path: 'frame.h', label: 'Height', kind: 'size' });
      f.push({ path: 'frame.rot', label: 'Rotation', kind: 'number', unit: '°', step: 1 });
      f.push({ path: 'frame.sx', label: 'Scale X', kind: 'number', step: 0.05, unit: '×' }, { path: 'frame.sy', label: 'Scale Y', kind: 'number', step: 0.05, unit: '×' });
      f.push({ label: 'Flip', kind: 'seg', options: [['h', '⇋ Horizontal', 'Flip horizontally'], ['v', '⇵ Vertical', 'Flip vertically']], get: () => null,
        set: (e, v) => { if (v === 'h') e.frame.sx = -num(e.frame.sx, 1); else e.frame.sy = -num(e.frame.sy, 1); } });
      f.push({ path: 'frame.kx', label: 'Skew X', kind: 'number', unit: '°', advanced: true }, { path: 'frame.ky', label: 'Skew Y', kind: 'number', unit: '°', advanced: true });
      if (els.length === 1) f.push({ label: 'Anchor point', kind: 'origin', advanced: true, hint: 'The point rotation, scale and skew happen around' });
      f.push({ path: 'frame.rx', label: 'Tilt X (3D)', kind: 'number', unit: '°', advanced: true }, { path: 'frame.ry', label: 'Tilt Y (3D)', kind: 'number', unit: '°', advanced: true });
      f.push({ path: 'frame.persp', label: 'Perspective', kind: 'number', unit: 'px', min: 0, advanced: true, placeholder: 'none' });
      f.push({ path: 'frame.distort', label: 'Distort (corner offsets)', kind: 'distort', wide: true, advanced: true });
      return f;
    }

    function appearanceFields(els) {
      const t = els[0].type;
      const f = [S('fill', 'Fill', 'color'), S('opacity', 'Opacity', 'range', { min: 0, max: 1, step: 0.01, def: 1 }),
        S('borderColor', 'Border colour', 'color'), S('borderWidth', 'Border width', 'number', { unit: 'px', min: 0 }),
        S('borderStyle', 'Border style', 'select', { options: OPTS.borderStyle, advanced: true }),
        S('bT', 'Border top', 'number', { unit: 'px', min: 0, advanced: true }), S('bR', 'Border right', 'number', { unit: 'px', min: 0, advanced: true }),
        S('bB', 'Border bottom', 'number', { unit: 'px', min: 0, advanced: true }), S('bL', 'Border left', 'number', { unit: 'px', min: 0, advanced: true }),
        S('radius', 'Corner radius', 'number', { unit: 'px', min: 0 }),
        S('rTL', 'Radius top-left', 'number', { unit: 'px', min: 0, advanced: true }), S('rTR', 'Radius top-right', 'number', { unit: 'px', min: 0, advanced: true }),
        S('rBR', 'Radius bottom-right', 'number', { unit: 'px', min: 0, advanced: true }), S('rBL', 'Radius bottom-left', 'number', { unit: 'px', min: 0, advanced: true }),
        S('shadows', 'Shadows', 'shadows', { wide: true }),
        S('fillImage', 'Background image', 'image', { advanced: true, wide: true }), S('fillSize', 'Background size', 'select', { options: [['cover', 'Cover'], ['contain', 'Contain'], ['auto', 'Original'], ['100% 100%', 'Stretch']], advanced: true }),
        S('blend', 'Blend mode', 'select', { options: OPTS.blend, advanced: true })];
      if (['indicator', 'rankitem', 'matrixgrid', 'matrixrow', 'tabs', 'progress'].includes(t)) f.splice(2, 0, S('markColor', t === 'indicator' ? 'Mark colour' : 'Accent colour', 'color'));
      if (t === 'field') f.splice(2, 0, S('placeholderColor', 'Placeholder colour', 'color'), S('trackColor', 'Slider track', 'color'), S('thumbColor', 'Slider thumb / accent', 'color'));
      return f;
    }
    function typographyFields() {
      return [S('fontFamily', 'Font', 'font'), S('fontSize', 'Size', 'number', { unit: 'px', min: 1 }), S('fontWeight', 'Weight', 'select', { options: OPTS.weight }),
        S('color', 'Text colour', 'color'), S('lineHeight', 'Line height', 'number', { step: 0.05 }), S('letterSpacing', 'Letter spacing', 'number', { unit: 'px', step: 0.1 }),
        S('textAlign', 'Align', 'seg', { options: [['left', '⟸', 'Left'], ['center', '≡', 'Center'], ['right', '⟹', 'Right'], ['justify', '☰', 'Justify']] }),
        S('vAlign', 'Vertical align', 'seg', { advanced: true, options: [['top', '⤒', 'Top'], ['middle', '↕', 'Middle'], ['bottom', '⤓', 'Bottom']] }),
        S('fontStyle', 'Italic', 'toggle', { advanced: true, set: (e, v) => { Core.setPath(e, 'style.fontStyle', v ? 'italic' : undefined); }, get: e => (Core.getPath(e, 'style.fontStyle') === 'italic' ? true : undefined) }),
        S('textTransform', 'Case', 'select', { options: OPTS.transform, advanced: true }), S('textDecoration', 'Decoration', 'select', { options: OPTS.decoration, advanced: true }),
        S('textShadow', 'Text shadow', 'text', { advanced: true, placeholder: 'e.g. 0 1px 2px rgba(0,0,0,.2)' }), S('whiteSpace', 'Line wrapping', 'select', { options: [['', 'Wrap'], ['nowrap', 'No wrapping'], ['pre', 'Preserve spaces']], advanced: true })];
    }
    function spacingFields() { return [S('padding', 'Padding', 'box4', { wide: true }), S('margin', 'Margin', 'box4', { wide: true, advanced: true })]; }
    function effectFields() {
      return [S('blur', 'Blur', 'number', { unit: 'px', min: 0 }), S('brightness', 'Brightness', 'number', { unit: '%', min: 0 }), S('contrast', 'Contrast', 'number', { unit: '%', min: 0 }),
        S('saturate', 'Saturation', 'number', { unit: '%', min: 0 }), S('hue', 'Hue rotate', 'number', { unit: '°' }), S('grayscale', 'Greyscale', 'number', { unit: '%', min: 0, max: 100 }),
        S('sepia', 'Sepia', 'number', { unit: '%', min: 0, max: 100 }), S('invert', 'Invert', 'number', { unit: '%', min: 0, max: 100 }),
        S('backdropBlur', 'Backdrop blur', 'number', { unit: 'px', min: 0 }), S('dropShadow', 'Drop shadow (shape-aware)', 'text', { placeholder: '0 4px 8px rgba(0,0,0,.25)' }),
        S('clip.shape', 'Clip / mask shape', 'select', { options: OPTS.clip }),
        S('clip.points', 'Polygon points', 'text', { placeholder: '0% 0%, 100% 0%, 50% 100%', when: e => (Core.getPath(e, 'style.clip.shape') === 'polygon') }),
        S('clip.round', 'Inset rounding', 'number', { unit: 'px', when: e => Core.getPath(e, 'style.clip.shape') === 'inset' }),
        S('mask', 'Fade mask', 'select', { options: OPTS.mask }), S('cursor', 'Cursor', 'select', { options: OPTS.cursor })];
    }
    function stateFields(els) {
      const st = stateTab;
      const base = 'states.' + st + '.';
      const t = els[0].type;
      const f = [S(base + 'fill', 'Fill', 'color'), S(base + 'color', 'Text colour', 'color'), S(base + 'borderColor', 'Border colour', 'color'),
        S(base + 'borderWidth', 'Border width', 'number', { unit: 'px', min: 0 }), S(base + 'opacity', 'Opacity', 'range', { min: 0, max: 1, step: 0.01, def: 1 }),
        S(base + 'scale', 'Scale', 'number', { step: 0.01, unit: '×', placeholder: '1' }), S(base + 'shadows', 'Shadows', 'shadows', { wide: true })];
      if (['indicator', 'rankitem', 'matrixrow', 'field'].includes(t)) f.splice(3, 0, S(base + 'markColor', 'Mark / accent colour', 'color'));
      f.push(S('transition', 'Transition', 'number', { unit: 'ms', min: 0, step: 10 }));
      return f;
    }
    function behaviorFields(els) {
      const el = els[0];
      const t = el.type;
      const f = [];
      if (QUESTION(t)) {
        const kind = Logic.valueKind(el);
        f.push({ path: 'behavior.required', label: 'Required', kind: 'toggle' });
        f.push({ path: 'behavior.dataKey', label: 'Answer key', kind: 'text', placeholder: Core.dataKeyOf(doc(), el), hint: 'Column name in exports, and the name used in formulas',
          set: (e, v) => { const k = String(v || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1'); const taken = Object.values(doc().elements).some(o => o.id !== e.id && o.behavior && o.behavior.dataKey === k); if (taken) { if (opts.notify) opts.notify('Another question already uses "' + k + '".', 'error'); return; } e.behavior.dataKey = k || undefined; } });
        f.push({ path: 'behavior.validation.requiredMessage', label: 'Required message', kind: 'text', placeholder: 'This question is required.', advanced: true });
        if (kind === 'text') {
          f.push({ path: 'behavior.validation.format', label: 'Format', kind: 'select', options: OPTS.format });
          f.push({ path: 'behavior.validation.minLength', label: 'Min length', kind: 'number', min: 0, advanced: true }, { path: 'behavior.validation.maxLength', label: 'Max length', kind: 'number', min: 0, advanced: true });
          f.push({ path: 'behavior.validation.pattern', label: 'Pattern (regex)', kind: 'text', advanced: true, placeholder: '^[A-Z]{2}\\d{4}$' }, { path: 'behavior.validation.patternMessage', label: 'Pattern message', kind: 'text', advanced: true });
          f.push({ path: 'behavior.readOnly', label: 'Read only', kind: 'toggle', advanced: true });
        }
        if (kind === 'number') { f.push({ path: 'behavior.validation.integer', label: 'Whole numbers only', kind: 'toggle', advanced: true }); f.push({ path: 'props.scored', label: 'Counts towards score', kind: 'toggle', advanced: true }); }
        if (kind === 'multi') f.push({ path: 'behavior.validation.minSelect', label: 'Min selections', kind: 'number', min: 0 }, { path: 'behavior.validation.maxSelect', label: 'Max selections', kind: 'number', min: 0 });
        f.push({ path: 'behavior.validation.rule', label: 'Custom rule', kind: 'expr', advanced: true, placeholder: 'e.g. value >= age', hint: 'A formula that must be true; "value" is this answer' });
        f.push({ path: 'behavior.validation.ruleMessage', label: 'Rule message', kind: 'text', advanced: true });
      }
      f.push({ path: 'behavior.initiallyHidden', label: 'Hidden at start', kind: 'toggle', hint: 'Starts hidden; a logic rule can show it' });
      if (['button', 'field', 'option'].includes(t) || QUESTION(t)) f.push({ path: 'behavior.disabled', label: 'Disabled at start', kind: 'toggle', advanced: true });
      if (t === 'button' || QUESTION(t)) {
        const n = doc().rules.filter(r => JSON.stringify(r).indexOf(el.id) !== -1).length;
        f.push({ label: 'Logic', kind: 'info', wide: true, html: (n ? n + ' rule' + (n === 1 ? ' uses' : 's use') + ' this element. ' : 'No rules use this element yet. ') + '<button type="button" class="ss-link-btn" data-act="logic">Open Logic →</button>' });
      }
      return f;
    }
    function animFields() {
      return [{ path: 'anim.enter', label: 'Entrance', kind: 'select', options: OPTS.enter, def: 'none' },
        { path: 'anim.duration', label: 'Duration', kind: 'number', unit: 'ms', min: 0, step: 50, placeholder: '450' },
        { path: 'anim.delay', label: 'Delay', kind: 'number', unit: 'ms', min: 0, step: 50, placeholder: '0' },
        { path: 'anim.easing', label: 'Easing', kind: 'select', options: OPTS.easing, def: 'ease-out' },
        { path: 'anim.loop', label: 'Loop', kind: 'select', options: OPTS.loop, def: 'none', advanced: true },
        { path: 'anim.loopDuration', label: 'Loop duration', kind: 'number', unit: 'ms', min: 100, step: 100, advanced: true, placeholder: '2000' }];
    }
    function a11yFields(els) {
      return [{ path: 'a11y.label', label: 'Accessible name', kind: 'text', hint: 'Read by screen readers instead of the visible text' },
        { path: 'a11y.description', label: 'Tooltip / description', kind: 'text' },
        { path: 'a11y.role', label: 'Role', kind: 'select', options: OPTS.role, advanced: true },
        { path: 'a11y.tabIndex', label: 'Tab order', kind: 'number', advanced: true, placeholder: 'auto' },
        { path: 'a11y.live', label: 'Announce changes', kind: 'select', options: OPTS.live, advanced: true },
        { path: 'a11y.hidden', label: 'Hide from screen readers', kind: 'toggle', advanced: true }];
    }
    function responsiveFields() {
      return [{ path: 'responsive.hideMobile', label: 'Hide on narrow screens', kind: 'toggle', hint: 'Below the survey\'s reflow width (Theme → Survey settings)' },
        { path: 'responsive.hideDesktop', label: 'Hide on wide screens', kind: 'toggle' }];
    }
    function advancedFields(els) {
      const f = [S('css', 'Custom CSS', 'textarea', { mono: true, rows: 4, wide: true, placeholder: 'e.g. outline: 2px dashed red;\nbackground: conic-gradient(…);' })];
      if (els.length === 1) f.push({ label: 'Element JSON', kind: 'json', wide: true });
      return f;
    }

    function sectionsFor(els) {
      const el = els[0];
      const single = els.length === 1;
      const t = el.type;
      const textish = TEXT_TYPES.includes(t) || ['button', 'field', 'rankitem', 'matrixgrid', 'matrixrow', 'tabs', 'option', 'progress'].includes(t) || QUESTION(t) || CONTAINERS(t);
      const list = [];
      if (single) {
        const c = contentFields(el);
        if (c.length) list.push({ id: 'content', title: 'Content', fields: c });
        const l = layoutFields(el);
        if (l.length) list.push({ id: 'layout', title: 'Layout', fields: l });
      }
      list.push({ id: 'transform', title: 'Transform', fields: transformFields(els) });
      list.push({ id: 'appearance', title: 'Appearance', fields: appearanceFields(els) });
      if (textish) list.push({ id: 'typography', title: 'Typography', fields: typographyFields() });
      list.push({ id: 'spacing', title: 'Spacing', fields: spacingFields() });
      list.push({ id: 'effects', title: 'Effects, clipping & masks', fields: effectFields(), advanced: true });
      list.push({ id: 'states', title: 'Interaction states', fields: stateFields(els), tabs: true });
      if (single) list.push({ id: 'behavior', title: 'Behavior & validation', fields: behaviorFields(els) });
      list.push({ id: 'animation', title: 'Animation', fields: animFields() });
      list.push({ id: 'a11y', title: 'Accessibility', fields: a11yFields(els), advanced: !single });
      list.push({ id: 'responsive', title: 'Responsive', fields: responsiveFields(), advanced: true });
      list.push({ id: 'advanced', title: 'Advanced', fields: advancedFields(els), advanced: true });
      return list;
    }

    /* ── Rendering ─────────────────────────── */
    function header(els) {
      const el = els[0];
      const h = document.createElement('div');
      h.className = 'ss-insp-head';
      if (els.length > 1) {
        h.innerHTML = '<div class="ss-insp-title"><span class="ss-insp-type">' + els.length + ' elements selected</span></div>' +
          '<div class="ss-insp-sub">Changes apply to all of them.</div>';
      } else {
        const def = Core.getType(el.type) || {};
        h.innerHTML = '<div class="ss-insp-title"><svg class="ss-ico" viewBox="0 0 24 24" aria-hidden="true">' + (def.icon || '') + '</svg>' +
          '<input class="ss-insp-name" aria-label="Element name" placeholder="' + esc(Core.displayName(doc(), el)) + '"></div>' +
          '<div class="ss-insp-sub"><span class="ss-badge">' + esc(Core.typeLabel(el.type)) + '</span>' + (Core.isQuestionType(el.type) ? '<span class="ss-badge ss-badge-blue" title="Answer key">' + esc(Core.dataKeyOf(doc(), el)) + '</span>' : '') +
          (el.locked ? '<span class="ss-badge ss-badge-amber">Locked</span>' : '') + (el.hidden ? '<span class="ss-badge">Hidden</span>' : '') + '</div>';
        const name = h.querySelector('.ss-insp-name');
        name.value = el.name || '';
        name.addEventListener('change', () => { selfChange = true; try { store.tx('Rename', t => { t.el(el.id).name = name.value.trim().slice(0, 200); }); } finally { selfChange = false; } });
        if (Core.isQuestionType(el.type) || ['choices', 'option', 'matrixgrid', 'tabs'].includes(el.type)) {
          const q = Core.questionOf(doc(), el.id);
          const acts = document.createElement('div'); acts.className = 'ss-insp-actions';
          const kind = q ? Logic.valueKind(q) : null;
          if (q && (kind === 'choice' || kind === 'multi') && q.type !== 'dropdown' && q.type !== 'rating') acts.innerHTML += '<button type="button" class="ss-chip-btn" data-act="add-option">+ Option</button>';
          if (q && q.type === 'ranking') acts.innerHTML += '<button type="button" class="ss-chip-btn" data-act="add-rank">+ Item</button>';
          if (q && q.type === 'matrix') acts.innerHTML += '<button type="button" class="ss-chip-btn" data-act="add-row">+ Row</button>';
          if (q && !Core.questionParts(doc(), q.id, 'qdesc').length) acts.innerHTML += '<button type="button" class="ss-chip-btn" data-act="add-desc">+ Description</button>';
          if (q && !Core.questionParts(doc(), q.id, 'qerror').length) acts.innerHTML += '<button type="button" class="ss-chip-btn" data-act="add-error">+ Validation message</button>';
          if (el.type === 'tabs') acts.innerHTML += '<button type="button" class="ss-chip-btn" data-act="add-tab">+ Tab</button>';
          if (acts.innerHTML) h.appendChild(acts);
        }
      }
      return h;
    }

    function render(force) {
      closePopover();
      const sel = store.selection.filter(id => doc().elements[id]);
      const key = sel.join(',') + '|' + (prefs.all ? 1 : 0) + '|' + stateTab;
      if (!force && key === renderedFor) { refreshValues(); return; }
      const scroll = container.scrollTop;
      renderedFor = key;
      bindings = [];
      container.innerHTML = '';
      const top = document.createElement('div');
      top.className = 'ss-insp-top';
      top.innerHTML = '<div class="ss-seg ss-seg-sm" role="radiogroup" aria-label="Detail level"><button type="button" class="ss-seg-btn' + (!prefs.all ? ' is-on' : '') + '" data-detail="basic" role="radio" aria-checked="' + !prefs.all + '">Basic</button><button type="button" class="ss-seg-btn' + (prefs.all ? ' is-on' : '') + '" data-detail="all" role="radio" aria-checked="' + !!prefs.all + '">All properties</button></div>';
      container.appendChild(top);
      if (!sel.length) { renderPage(); container.scrollTop = scroll; return; }
      const els = sel.map(id => doc().elements[id]);
      container.appendChild(header(els));
      sectionsFor(els).forEach(sec => {
        if (sec.advanced && !prefs.all) return;
        const fields = sec.fields.filter(f => (prefs.all || !f.advanced) && (!f.when || f.when(els[0])));
        if (!fields.length) return;
        const box = document.createElement('section');
        box.className = 'ss-sec';
        const open = !prefs.closed[sec.id];
        box.innerHTML = '<button type="button" class="ss-sec-head" aria-expanded="' + open + '"><span>' + esc(sec.title) + '</span><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>';
        const body = document.createElement('div');
        body.className = 'ss-sec-body';
        body.hidden = !open;
        if (sec.tabs) {
          const tabs = document.createElement('div'); tabs.className = 'ss-state-tabs'; tabs.setAttribute('role', 'tablist');
          Core.STATE_NAMES.forEach(s => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'ss-state-tab' + (s === stateTab ? ' is-on' : ''); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(s === stateTab));
            b.textContent = { hover: 'Hover', focus: 'Focus', active: 'Pressed', checked: 'Selected', disabled: 'Disabled' }[s];
            b.addEventListener('click', () => { stateTab = s; if (forcing && opts.canvas) opts.canvas.setForced(sel[0], stateTab); render(true); });
            tabs.appendChild(b);
          });
          body.appendChild(tabs);
          const pv = document.createElement('label'); pv.className = 'ss-check-row';
          pv.innerHTML = '<input type="checkbox"' + (forcing ? ' checked' : '') + '> Show this state on the canvas';
          pv.querySelector('input').addEventListener('change', e => { forcing = e.target.checked; if (opts.canvas) opts.canvas.setForced(forcing ? sel[0] : null, forcing ? stateTab : null); });
          body.appendChild(pv);
        }
        fields.forEach(f => body.appendChild(fieldRow(f, els)));
        box.appendChild(body);
        box.querySelector('.ss-sec-head').addEventListener('click', e => {
          const b = e.currentTarget; const isOpen = b.getAttribute('aria-expanded') === 'true';
          b.setAttribute('aria-expanded', String(!isOpen)); body.hidden = isOpen;
          prefs.closed[sec.id] = isOpen; savePrefs();
        });
        container.appendChild(box);
      });
      container.scrollTop = scroll;
    }
    function renderPage() {
      const page = store.page;
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div class="ss-insp-head"><div class="ss-insp-title"><svg class="ss-ico" viewBox="0 0 24 24" aria-hidden="true">' + Core.ICONS.page + '</svg><span class="ss-insp-type">Page</span></div>' +
        '<div class="ss-insp-sub">Nothing selected — these are the page\'s settings. Click an element on the canvas, or pick it in Layers.</div></div>';
      container.appendChild(wrap);
      const pf = [
        { label: 'Name', kind: 'text', get: () => page.name, set: v => cmds.updatePage(page.id, p => { p.name = String(v).slice(0, 200) || p.name; }, 'Rename page') },
        { label: 'Canvas height', kind: 'number', min: 100, unit: 'px', get: () => page.minHeight, set: v => cmds.updatePage(page.id, p => { p.minHeight = Math.max(100, Number(v) || 640); }, 'Page height'), hint: 'Minimum height in the editor; the published page fits its content' },
        { label: 'Background', kind: 'color', get: () => Core.getPath(page, 'style.fill'), inherited: 'var(--sv-surface)', set: v => cmds.updatePage(page.id, p => { Core.setPath(p, 'style.fill', v || undefined); }, 'Page background') },
        { label: 'Corner radius', kind: 'number', min: 0, unit: 'px', get: () => Core.getPath(page, 'style.radius'), set: v => cmds.updatePage(page.id, p => { Core.setPath(p, 'style.radius', v === '' ? undefined : v); }, 'Page radius') },
        { label: 'Border colour', kind: 'color', get: () => Core.getPath(page, 'style.borderColor'), inherited: 'var(--sv-border)', set: v => cmds.updatePage(page.id, p => { Core.setPath(p, 'style.borderColor', v || undefined); }, 'Page border') },
        { label: 'Background image', kind: 'image', wide: true, get: () => Core.getPath(page, 'style.fillImage'), set: v => cmds.updatePage(page.id, p => { Core.setPath(p, 'style.fillImage', v || undefined); }, 'Page image') },
        { label: 'Ending page', kind: 'toggle', get: () => !!(page.props && page.props.ending), set: v => cmds.updatePage(page.id, p => { p.props.ending = !!v; }, 'Ending page'), hint: 'Shown after submitting when a rule sends respondents here; skipped in normal navigation' },
        { label: 'Skipped by default', kind: 'toggle', get: () => !!(page.props && page.props.initiallyHidden), set: v => cmds.updatePage(page.id, p => { p.props.initiallyHidden = !!v; }, 'Skip page'), hint: 'A logic rule can show it' }
      ];
      const sec = document.createElement('section'); sec.className = 'ss-sec';
      const body = document.createElement('div'); body.className = 'ss-sec-body';
      pf.forEach(f => {
        const row = document.createElement('div'); row.className = 'ss-field ss-field-' + f.kind + (f.wide ? ' is-wide' : '');
        const id = 'ssp-' + Math.random().toString(36).slice(2, 8);
        const lab = document.createElement('label'); lab.className = 'ss-field-label'; lab.htmlFor = id; lab.textContent = f.label; if (f.hint) lab.title = f.hint;
        const ctl = document.createElement('div'); ctl.className = 'ss-field-ctl';
        row.appendChild(lab); row.appendChild(ctl);
        const api = (WIDGETS[f.kind])(ctl, f, id, v => { selfChange = true; try { f.set(v); } finally { selfChange = false; } refreshValues(); }, [], lab);
        const upd = () => api.update(f.get(), { mixed: false, inherited: f.inherited });
        upd(); bindings.push(upd);
        body.appendChild(row);
      });
      sec.appendChild(body);
      container.appendChild(sec);
      const tips = document.createElement('div');
      tips.className = 'ss-tips';
      tips.innerHTML = '<div class="ss-tips-title">Tips</div><ul>' +
        '<li>Double-click a question to select one answer option; double-click again to reach its label or indicator.</li>' +
        '<li><kbd>Ctrl</kbd>/<kbd>⌘</kbd>-click selects the deepest element directly.</li>' +
        '<li>Drag a property\'s name left/right to scrub its value.</li>' +
        '<li>Theme changes every element at once; anything you set here overrides it for one element.</li></ul>';
      container.appendChild(tips);
    }

    function refreshValues() { bindings.forEach(fn => { try { fn(); } catch (e) { /* field removed */ } }); }

    container.addEventListener('click', e => {
      const det = e.target.closest('[data-detail]');
      if (det) { prefs.all = det.dataset.detail === 'all'; savePrefs(); render(true); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = store.primary;
      const q = id ? Core.questionOf(doc(), id) : null;
      switch (act.dataset.act) {
        case 'add-option': if (q) cmds.addOption(q.id); break;
        case 'add-rank': if (q) cmds.addListItem(q.id, 'rankitem'); break;
        case 'add-row': if (q) cmds.addListItem(q.id, 'matrixrow'); break;
        case 'add-desc': if (q) cmds.addQuestionPart(q.id, 'qdesc'); break;
        case 'add-error': if (q) cmds.addQuestionPart(q.id, 'qerror'); break;
        case 'add-tab': {
          const tabs = doc().elements[id];
          if (tabs && tabs.type === 'tabs') {
            const tree = Core.instantiate(Core.spec('tabpanel', { props: { label: 'Tab ' + (tabs.children.length + 1), layout: { mode: 'stack', dir: 'v', gap: 12, align: 'stretch' } }, frame: { w: 'fill', h: 'auto' }, children: [] }), tabs.id);
            store.tx('Add tab', t => { cmds.insertTree(t, tree, tabs.id); t.el(tabs.id).props.active = tabs.children.length - 1; });
          }
          break;
        }
        case 'logic': if (opts.openLogic) opts.openLogic(id); break;
        default: break;
      }
    });

    const off = store.on((type, info) => {
      if (type === 'select' || type === 'page') { if (forcing && opts.canvas) { forcing = false; opts.canvas.setForced(null); } render(); return; }
      if (type === 'change') {
        if (selfChange) return;
        const sel = store.selection;
        const structural = info.structure || info.undo || info.redo || sel.some(id => info.ids.has(id) && !info.frameOnly.has(id));
        if (structural) { render(true); return; }
        refreshValues();
      }
    });
    render(true);

    return { render: () => render(true), refresh: refreshValues, closePopover, openColor, destroy() { off(); closePopover(); container.innerHTML = ''; } };
  }

  root.SurveyInspector = { create, OPTS };
})(typeof window !== 'undefined' ? window : this);
