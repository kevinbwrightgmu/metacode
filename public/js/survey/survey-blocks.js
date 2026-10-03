/* ══════════════════════════════════════════════
   survey-blocks.js — the Logic tab: Scratch-style block coding

   Drag blocks from the palette onto the workspace and snap them together:
     Events     yellow hat blocks that start a script ("when leaving page …")
     Control    if / if-else C-blocks that hold other blocks
     Looks      show, hide, enable, set text / property, show message
     Pages      go to page, next, back, skip page, submit, end survey
     Answers    (answer to …), <… is answered>, (score), set answer
     Operators  <( ) = ( )>, <and>, <or>, <not>, ( ( ) + ( ) ), join, formula
     Variables  (variable), set … to ( ), change … by ( )

   A script is stored as an ordinary rule in doc.rules, so the same logic
   engine runs it in the editor preview, on the respondent page and on the
   server (survey-logic.js):
     rule = { trigger, then: [statements], ui: {x, y} }
     statement = action | { type: 'if', when: { items: [boolean] }, then, else, withElse }
     boolean   = { left, cmp, right } | { group: { op: all|any|not, items } } | { expr }
     value     = { kind: value|answer|var|score|page|expr|calc, … }
   Blocks that aren't attached to an event are kept as rules with trigger
   "none" (they never run); a loose reporter is kept in rule.loose.
   Older rules (WHEN … IF … THEN … OTHERWISE) open as a hat + if-else block.
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore, Logic = root.SurveyLogic;
  const { clone, isObj } = Core;
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const CATS = [
    { id: 'events', label: 'Events', color: '#E0A100', dark: '#B07D00' },
    { id: 'control', label: 'Control', color: '#EA7317', dark: '#BF5A0E' },
    { id: 'looks', label: 'Looks', color: '#7C3AED', dark: '#5B21B6' },
    { id: 'pages', label: 'Pages', color: '#2563EB', dark: '#1D4ED8' },
    { id: 'answers', label: 'Answers', color: '#0891B2', dark: '#0E7490' },
    { id: 'operators', label: 'Operators', color: '#16A34A', dark: '#15803D' },
    { id: 'variables', label: 'Variables', color: '#DB2777', dark: '#BE185D' }
  ];
  const CAT = {};
  CATS.forEach(c => { CAT[c.id] = c; });
  // Which category colours each statement / reporter
  const ACTION_CAT = {
    show: 'looks', hide: 'looks', enable: 'looks', disable: 'looks', require: 'looks', optional: 'looks', setProp: 'looks', setText: 'looks', message: 'looks',
    goto: 'pages', next: 'pages', back: 'pages', showPage: 'pages', hidePage: 'pages', submit: 'pages', complete: 'pages', openUrl: 'pages',
    setAnswer: 'answers', setVar: 'variables', changeVar: 'variables', if: 'control'
  };
  const VALUE_CAT = { answer: 'answers', score: 'answers', page: 'answers', var: 'variables', calc: 'operators', expr: 'operators' };
  const CALC_LABEL = { '+': '+', '-': '−', '*': '×', '/': '÷', '%': 'mod' };
  const SNAP = 30;          // px (unscaled) within which a stack snaps to a connection

  const lit = v => ({ kind: 'value', value: v === undefined ? '' : v });
  const emptyWhen = () => ({ op: 'all', items: [null] });

  function create(container, store, opts) {
    opts = opts || {};
    const doc = () => store.doc;
    let W = null;                 // working copy of doc.rules (canonical block form)
    let zoom = 1;
    let selfEdit = false;
    let selected = null;          // element of the selected block
    let drag = null;
    let refs = new WeakMap();     // block element → where its JSON lives (rebuilt on every render)
    const palRefs = new WeakMap(); // palette block → its factory
    const cleanup = [];

    container.innerHTML =
      '<div class="bk-app">' +
        '<aside class="bk-palette" aria-label="Blocks">' +
          '<nav class="bk-cats" aria-label="Block categories">' + CATS.map(c => '<button type="button" class="bk-cat" data-cat="' + c.id + '"><span class="bk-cat-dot" style="background:' + c.color + ';border-color:' + c.dark + '"></span><span>' + c.label + '</span></button>').join('') + '</nav>' +
          '<div class="bk-pal-list" tabindex="-1"></div>' +
          '<div class="bk-trash" aria-hidden="true"><svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>Drop here to delete</div>' +
        '</aside>' +
        '<section class="bk-main">' +
          '<div class="bk-ws" tabindex="0" aria-label="Scripts workspace — drag blocks here"><div class="bk-canvas"></div><div class="bk-empty"></div></div>' +
          '<div class="bk-zoom"><button type="button" data-z="in" title="Zoom in" aria-label="Zoom in">+</button><button type="button" data-z="reset" title="Actual size" aria-label="Actual size">=</button><button type="button" data-z="out" title="Zoom out" aria-label="Zoom out">−</button></div>' +
          '<div class="bk-problems" role="status" aria-live="polite"></div>' +
        '</section>' +
      '</div>';
    const app = container.querySelector('.bk-app');
    const pal = container.querySelector('.bk-pal-list');
    const ws = container.querySelector('.bk-ws');
    const canvas = container.querySelector('.bk-canvas');
    const probEl = container.querySelector('.bk-problems');
    const emptyEl = container.querySelector('.bk-empty');

    /* ── Commit ───────────────────────────────── */
    function commit(label, fnVars) {
      selfEdit = true;
      try {
        store.tx(label, t => {
          t.set('rules', clone(W));
          if (fnVars) fnVars(t.part('variables'));
        });
      } finally { selfEdit = false; }
      render();
    }

    /* ── Canonical block form ─────────────────── */
    function foldBool(it) {
      if (!isObj(it)) return null;
      if (isObj(it.group)) {
        const g = it.group;
        const items = (g.items || []).map(foldBool);
        if (g.op === 'not') return { group: { op: 'not', items: [items[0] === undefined ? null : items[0]] } };
        if (items.length === 0) return null;
        if (items.length === 1) return items[0];
        let acc = { group: { op: g.op === 'any' ? 'any' : 'all', items: [items[0], items[1]] } };
        for (let i = 2; i < items.length; i++) acc = { group: { op: acc.group.op, items: [acc, items[i]] } };
        return acc;
      }
      return it;
    }
    function canonList(list) {
      return (Array.isArray(list) ? list : []).filter(isObj).map(a => {
        if (a.type === 'if') {
          const when = isObj(a.when) ? a.when : { op: 'all', items: [] };
          const f = (when.items || []).length ? foldBool({ group: when }) : null;
          return Object.assign({}, a, { when: { op: 'all', items: [f] }, then: canonList(a.then), else: canonList(a.else), withElse: !!(a.withElse || (a.else && a.else.length)) });
        }
        if ((a.type === 'setVar' || a.type === 'changeVar') && !isObj(a.from)) {
          const b = Object.assign({}, a, { from: a.expr !== undefined && a.expr !== '' ? { kind: 'expr', expr: a.expr } : lit(a.value === undefined ? (a.type === 'changeVar' ? 1 : 0) : a.value) });
          delete b.expr; delete b.value;
          return b;
        }
        return a;
      });
    }
    function canonRule(r) {
      r = clone(r);
      if (!r.trigger) r.trigger = { type: 'always' };
      const hasWhen = r.when && (r.when.items || []).length;
      if (hasWhen && r.trigger.type !== 'none') {
        r.then = [{ type: 'if', when: r.when, then: r.then || [], else: r.else || [], withElse: !!(r.else && r.else.length) }];
      }
      r.when = { op: 'all', items: [] };
      r.else = [];
      r.then = canonList(r.then);
      return r;
    }

    /* ── Field option lists ───────────────────── */
    const trunc = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    function elementOpts(filter) {
      const d = doc();
      const out = [];
      d.pages.forEach(p => {
        const ids = Core.descendants(d, 'page:' + p.id).filter(id => d.elements[id] && (!filter || filter(d.elements[id])));
        if (ids.length) out.push({ group: p.name, items: ids.map(id => ({ value: id, label: trunc(Core.displayName(d, d.elements[id]), 44) })) });
      });
      return out;
    }
    const questionOpts = () => elementOpts(e => Core.isQuestionType(e.type));
    const textOpts = () => elementOpts(e => Core.isTextType(e.type) || ['qtitle', 'qdesc', 'optlabel', 'button'].includes(e.type));
    const buttonOpts = () => elementOpts(e => e.type === 'button');
    const pageOpts = any => (any ? [{ value: 'any', label: 'any page' }] : []).concat(doc().pages.map((p, i) => ({ value: p.id, label: (i + 1) + '. ' + trunc(p.name, 30) })));
    const varOpts = () => doc().variables.map(v => ({ value: v.name, label: v.name }));
    const firstQuestion = () => { const q = Core.questionsInOrder(doc())[0]; return q ? q.id : ''; };
    const firstElement = () => { const q = firstQuestion(); if (q) return q; const p = doc().pages[0]; const ids = p ? Core.descendants(doc(), 'page:' + p.id) : []; return ids[0] || ''; };
    const firstOf = groups => { const g = groups.find(x => x.items && x.items.length); return g ? g.items[0].value : ''; };
    const firstVar = () => (doc().variables[0] ? doc().variables[0].name : '');

    /* ── Block definitions (palette) ──────────── */
    const hat = type => () => ({ hat: { type, page: type === 'pageEnter' || type === 'pageExit' ? (doc().pages[0] || {}).id : undefined, element: type === 'click' ? ((buttonOpts()[0] || { items: [{}] }).items[0].value) : undefined } });
    const stmt = o => () => ({ stmts: [typeof o === 'function' ? o() : clone(o)] });
    const bool = o => () => ({ bool: typeof o === 'function' ? o() : clone(o) });
    const val = o => () => ({ value: typeof o === 'function' ? o() : clone(o) });
    function palette() {
      const q = firstQuestion(), el = firstElement(), pg = (doc().pages[0] || {}).id || '', v = firstVar();
      const ans = () => ({ kind: 'answer', ref: firstQuestion() });
      return {
        events: [hat('always'), hat('pageEnter'), hat('pageExit'), hat('click'), hat('submit')],
        control: [stmt(() => ({ type: 'if', when: emptyWhen(), then: [], else: [], withElse: false })), stmt(() => ({ type: 'if', when: emptyWhen(), then: [], else: [], withElse: true }))],
        looks: [stmt({ type: 'show', target: el }), stmt({ type: 'hide', target: el }), stmt({ type: 'require', target: q }), stmt({ type: 'optional', target: q }),
          stmt({ type: 'enable', target: el }), stmt({ type: 'disable', target: el }), stmt({ type: 'setText', target: firstOf(textOpts()), value: 'Hello!' }),
          stmt({ type: 'setProp', target: el, path: 'style.fill', value: '#FDE68A' }), stmt({ type: 'message', value: 'Thanks!' })],
        pages: [stmt({ type: 'goto', target: pg }), stmt({ type: 'next' }), stmt({ type: 'back' }), stmt({ type: 'hidePage', target: pg }), stmt({ type: 'showPage', target: pg }),
          stmt({ type: 'submit' }), stmt({ type: 'complete', value: 'Thank you for your time.' }), stmt({ type: 'openUrl', value: 'https://' })],
        answers: [val(ans), bool(() => ({ left: ans(), cmp: 'notEmpty', right: lit('') })), bool(() => ({ left: ans(), cmp: 'eq', right: lit('') })),
          val({ kind: 'score' }), val({ kind: 'page' }), stmt({ type: 'setAnswer', target: q, value: '' })],
        operators: [bool({ left: lit(''), cmp: 'eq', right: lit('') }), bool({ left: lit(''), cmp: 'gt', right: lit('') }), bool({ left: lit(''), cmp: 'lt', right: lit('') }),
          bool({ left: lit(''), cmp: 'contains', right: lit('') }),
          bool({ group: { op: 'all', items: [null, null] } }), bool({ group: { op: 'any', items: [null, null] } }), bool({ group: { op: 'not', items: [null] } }),
          val({ kind: 'calc', op: '+', a: lit(''), b: lit('') }), val({ kind: 'calc', op: '-', a: lit(''), b: lit('') }), val({ kind: 'calc', op: '*', a: lit(''), b: lit('') }),
          val({ kind: 'calc', op: '/', a: lit(''), b: lit('') }), val({ kind: 'calc', op: 'join', a: lit('hello '), b: lit('world') }), val({ kind: 'calc', op: 'round', a: lit(''), b: lit('') }),
          val({ kind: 'expr', expr: 'score * 2' }), bool({ expr: 'answer("q1") = "yes"' })],
        variables: v ? [].concat(doc().variables.map(x => val({ kind: 'var', name: x.name })), [stmt({ type: 'setVar', name: v, from: lit(0) }), stmt({ type: 'changeVar', name: v, from: lit(1) })]) : []
      };
    }

    /* ── Rendering helpers ────────────────────── */
    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const label = t => mk('span', 'bk-label', t);
    let interactive = true;        // false while rendering the palette / drag ghost

    function select(options, value, onChange, cls) {
      const s = mk('select', 'bk-dd' + (cls ? ' ' + cls : ''));
      let found = false;
      const add = (parent, o) => { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; if (String(o.value) === String(value)) { op.selected = true; found = true; } parent.appendChild(op); };
      options.forEach(o => {
        if (o.group) { const g = document.createElement('optgroup'); g.label = o.group; o.items.forEach(i => add(g, i)); s.appendChild(g); } else add(s, o);
      });
      if (!found) { const op = document.createElement('option'); op.value = value || ''; op.textContent = value ? '(missing)' : 'choose…'; op.selected = true; s.insertBefore(op, s.firstChild); s.classList.add('is-missing'); }
      // A native select is as wide as its longest option; size it to the chosen one, like Scratch
      const chosen = s.options[s.selectedIndex];
      s.style.width = Math.ceil(textWidth(chosen ? chosen.textContent : '') + (cls && cls.indexOf('bk-dd-op') !== -1 ? 34 : 42)) + 'px';
      if (interactive) s.addEventListener('change', () => onChange(s.value));
      else s.tabIndex = -1;
      return s;
    }
    let measureCtx = null;
    function textWidth(t) {
      if (!measureCtx) { measureCtx = document.createElement('canvas').getContext('2d'); }
      measureCtx.font = '600 12px Inter, system-ui, sans-serif';
      return measureCtx.measureText(String(t)).width;
    }
    function autoWidth(inp, min, max) {
      const t = String(inp.value) || String(inp.placeholder || '') || ' ';
      inp.style.width = Math.max(min, Math.min(max, textWidth(t) + 20)) + 'px';
    }
    function textField(value, onChange, o) {
      o = o || {};
      const inp = mk('input', 'bk-text' + (o.mono ? ' is-mono' : '') + (o.cls ? ' ' + o.cls : ''));
      inp.type = 'text';
      inp.value = value === undefined || value === null ? '' : String(value);
      inp.placeholder = o.placeholder || '';
      inp.setAttribute('aria-label', o.aria || 'Value');
      inp.spellcheck = false;
      autoWidth(inp, o.min || 28, o.max || 260);
      if (interactive) {
        inp.addEventListener('input', () => autoWidth(inp, o.min || 28, o.max || 260));
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } e.stopPropagation(); });
        inp.addEventListener('change', () => onChange(inp.value));
      } else inp.tabIndex = -1;
      return inp;
    }
    const numOrText = s => (/^\s*-?\d+(\.\d+)?\s*$/.test(s) ? Number(s) : s);

    /* Value slot: a literal or a reporter block */
    function valueSlot(holder, key, rule, hint) {
      const slot = mk('span', 'bk-slot bk-vslot');
      const node = holder[key];
      if (isObj(node) && node.kind && node.kind !== 'value') {
        slot.appendChild(renderValue(node, rule, { holder, key }));
      } else {
        const v = isObj(node) ? node.value : '';
        if (hint && hint.choices && hint.choices.length) {
          slot.appendChild(select([{ value: '', label: 'choose…' }].concat(hint.choices.map(c => ({ value: c.value, label: trunc(c.label, 30) }))), v,
            nv => { holder[key] = lit(numOrText(nv)); commit('Edit block'); }, 'bk-dd-lit'));
        } else {
          slot.appendChild(textField(v, nv => { holder[key] = lit(numOrText(nv)); commit('Edit block'); }, { cls: 'is-lit', aria: 'Value', min: 26, max: 200 }));
        }
      }
      if (interactive) refs.set(slot, { slot: 'value', holder, key, rule });
      return slot;
    }
    /* Boolean slot: empty hexagon or a boolean block */
    function boolSlot(holder, key, rule) {
      const slot = mk('span', 'bk-slot bk-bslot');
      const node = holder[key];
      if (isObj(node)) slot.appendChild(renderBool(node, rule, { holder, key }));
      else slot.appendChild(mk('span', 'bk-bempty'));
      if (interactive) refs.set(slot, { slot: 'bool', holder, key, rule });
      return slot;
    }

    function choicesFor(node) {
      if (!isObj(node) || node.kind !== 'answer') return null;
      const q = doc().elements[node.ref];
      if (!q) return null;
      const kind = Logic.valueKind(q);
      if (kind === 'choice' || kind === 'multi') return Logic.choicesOf(doc(), q).map(c => ({ value: c.value, label: c.label }));
      return null;
    }

    function colorize(n, cat) { const c = CAT[cat]; n.style.setProperty('--bk-c', c.color); n.style.setProperty('--bk-d', c.dark); n.dataset.cat = cat; }

    function renderValue(node, rule, at) {
      const n = mk('span', 'bk-rep');
      colorize(n, VALUE_CAT[node.kind] || 'operators');
      const row = n;
      switch (node.kind) {
        case 'answer':
          row.append(label('answer to'), select(questionOpts(), node.ref, v => { node.ref = v; commit('Edit block'); }));
          break;
        case 'var':
          row.append(select(varOpts(), node.name, v => { node.name = v; commit('Edit block'); }, 'bk-dd-var'));
          break;
        case 'score': row.append(label('score')); break;
        case 'page': row.append(label('page number')); break;
        case 'expr':
          row.append(label('formula'), textField(node.expr, v => { node.expr = v; commit('Edit formula'); }, { mono: true, aria: 'Formula', min: 60, max: 280 }));
          break;
        case 'calc': {
          node.a = node.a || lit(''); node.b = node.b || lit('');
          if (node.op === 'join') row.append(label('join'), valueSlot(node, 'a', rule), valueSlot(node, 'b', rule));
          else if (node.op === 'round') row.append(label('round'), valueSlot(node, 'a', rule));
          else row.append(valueSlot(node, 'a', rule), select(['+', '-', '*', '/', '%', 'min', 'max'].map(o => ({ value: o, label: CALC_LABEL[o] || o })), node.op, v => { node.op = v; commit('Edit block'); }, 'bk-dd-op'), valueSlot(node, 'b', rule));
          break;
        }
        default: row.append(label('?'));
      }
      if (interactive && at) refs.set(n, Object.assign({ drag: 'value' }, at, { rule }));
      return n;
    }

    function renderBool(node, rule, at) {
      const n = mk('span', 'bk-bool');
      let cat = 'operators';
      if (isObj(node.group)) {
        const g = node.group;
        if (g.op === 'not') { g.items = [g.items[0] === undefined ? null : g.items[0]]; n.append(label('not'), boolSlot(g.items, 0, rule)); }
        else { while (g.items.length < 2) g.items.push(null); n.append(boolSlot(g.items, 0, rule), label(g.op === 'any' ? 'or' : 'and'), boolSlot(g.items, 1, rule)); }
      } else if (typeof node.expr === 'string') {
        n.append(label('formula'), textField(node.expr, v => { node.expr = v; commit('Edit formula'); }, { mono: true, aria: 'Formula', min: 80, max: 280 }));
      } else {
        node.left = node.left || lit(''); node.right = node.right || lit('');
        const cmp = Logic.CMP[node.cmp] ? node.cmp : 'eq';
        if (isObj(node.left) && node.left.kind === 'answer') cat = 'answers';
        const ops = Object.keys(Logic.CMP).map(k => ({ value: k, label: { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }[k] || Logic.CMP[k].label }));
        n.append(valueSlot(node, 'left', rule), select(ops, cmp, v => { node.cmp = v; commit('Edit block'); }, 'bk-dd-op'));
        if (!Logic.CMP[cmp].unary) n.append(valueSlot(node, 'right', rule, { choices: choicesFor(node.left) }));
      }
      colorize(n, cat);
      if (interactive && at) refs.set(n, Object.assign({ drag: 'bool' }, at, { rule }));
      return n;
    }

    function renderStmt(a, arr, index, rule) {
      const def = Logic.ACTIONS[a.type] || {};
      const cat = ACTION_CAT[a.type] || 'looks';
      const isC = a.type === 'if';
      const b = mk('div', 'bk-block ' + (isC ? 'bk-c' : 'bk-stack'));
      b.dataset.shape = isC ? (a.withElse ? 'ce' : 'c') : 'stack';
      colorize(b, cat);
      const row = mk('div', 'bk-row');
      const set = (k, label2) => v => { a[k] = v; commit(label2 || 'Edit block'); };
      const elSel = (opts2) => select(opts2, a.target, set('target'));
      switch (a.type) {
        case 'if': {
          if (!isObj(a.when)) a.when = emptyWhen();
          if (!Array.isArray(a.when.items) || !a.when.items.length) a.when.items = [null];
          a.then = a.then || []; a.else = a.else || [];
          row.append(label('if'), boolSlot(a.when.items, 0, rule), label('then'));
          b.append(row, renderList(a.then, rule, 'bk-mouth'));
          if (a.withElse) { const r2 = mk('div', 'bk-row bk-else'); r2.append(label('else')); b.append(r2, renderList(a.else, rule, 'bk-mouth')); }
          b.append(mk('div', 'bk-foot'));
          break;
        }
        case 'show': case 'hide': case 'enable': case 'disable':
          row.append(label(a.type), elSel(elementOpts())); break;
        case 'require': row.append(label('make'), elSel(questionOpts()), label('required')); break;
        case 'optional': row.append(label('make'), elSel(questionOpts()), label('optional')); break;
        case 'setText': row.append(label('set text of'), elSel(textOpts()), label('to'), textField(a.value, set('value', 'Edit text'), { aria: 'Text', min: 40 })); break;
        case 'setProp':
          row.append(label('set'), select(Logic.SETTABLE.map(([p, l]) => ({ value: p, label: l.toLowerCase() })), a.path, set('path')), label('of'), elSel(elementOpts()), label('to'),
            textField(a.value, v => { a.value = numOrText(v); commit('Edit block'); }, { aria: 'Value', min: 40 }));
          break;
        case 'message': row.append(label('show message'), textField(a.value, set('value', 'Edit text'), { aria: 'Message', min: 60 })); break;
        case 'goto': row.append(label('go to page'), select(pageOpts(), a.target, set('target'))); break;
        case 'next': row.append(label('go to next page')); break;
        case 'back': row.append(label('go back a page')); break;
        case 'hidePage': row.append(label('skip page'), select(pageOpts(), a.target, set('target'))); break;
        case 'showPage': row.append(label('include page'), select(pageOpts(), a.target, set('target'))); break;
        case 'submit': row.append(label('submit the survey')); break;
        case 'complete': row.append(label('end survey saying'), textField(a.value, set('value', 'Edit text'), { aria: 'Message', min: 80 })); break;
        case 'openUrl': {
          const inp = textField(a.value, set('value', 'Edit link'), { aria: 'Link', min: 80, placeholder: 'https://example.com' });
          row.append(label('open link'), inp, label('in'),
            select([{ value: 'new', label: 'a new tab' }, { value: 'same', label: 'this tab' }], a.where === 'same' ? 'same' : 'new', set('where')));
          if (interactive) {
            // ↗ is a real link to the address (browsers never block a link the user
            // clicks). mousedown is cancelled so the address field keeps focus: its
            // change would otherwise re-render the block before the click lands.
            const go = mk('a', 'bk-try', '↗');
            go.target = '_blank'; go.rel = 'noopener noreferrer';
            go.title = 'Open this link now to check it'; go.setAttribute('aria-label', 'Open this link now');
            const sync = () => { const u = safeLink(inp.value); go.href = u || '#'; go.classList.toggle('is-off', !u); };
            sync();
            inp.addEventListener('input', sync);
            go.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
            go.addEventListener('click', e => {
              e.stopPropagation();
              if (!safeLink(inp.value)) { e.preventDefault(); tryLink(inp.value); }
            });
            row.append(go);
          }
          break;
        }
        case 'setAnswer': row.append(label('set answer of'), elSel(questionOpts()), label('to'), textField(a.value, v => { a.value = numOrText(v); commit('Edit block'); }, { aria: 'Answer', min: 40 })); break;
        case 'setVar': case 'changeVar':
          if (!isObj(a.from)) a.from = lit(a.type === 'changeVar' ? 1 : 0);
          row.append(label(a.type === 'setVar' ? 'set' : 'change'), select(varOpts(), a.name, set('name'), 'bk-dd-var'), label(a.type === 'setVar' ? 'to' : 'by'), valueSlot(a, 'from', rule));
          break;
        default: row.append(label(def.label || a.type));
      }
      if (!isC) b.append(row);
      if (interactive && arr) refs.set(b, { drag: 'stmt', arr, index, rule });
      return b;
    }

    function renderList(arr, rule, cls) {
      const list = mk('div', 'bk-list' + (cls ? ' ' + cls : ''));
      arr.forEach((a, i) => list.appendChild(renderStmt(a, arr, i, rule)));
      if (interactive) refs.set(list, { list: arr, rule });
      return list;
    }

    function hatLabel(t) {
      const trig = t || { type: 'always' };
      const row = mk('div', 'bk-row');
      const setT = (k) => v => { const before = autoName(trig); trig[k] = v; const r = W.find(x => x.trigger === trig); if (r && (r.name === before || !r.name)) r.name = autoName(trig); commit('Edit block'); };
      switch (trig.type) {
        case 'always': row.append(label('when any answer changes')); break;
        case 'pageEnter': row.append(label('when page'), select(pageOpts(true), trig.page || 'any', setT('page')), label('opens')); break;
        case 'pageExit': row.append(label('when leaving page'), select(pageOpts(true), trig.page || 'any', setT('page'))); break;
        case 'click': {
          const o = buttonOpts();
          row.append(label('when'), select(o.length ? o : [{ value: '', label: 'add a button first' }], trig.element, setT('element')), label('is clicked'));
          break;
        }
        case 'submit': row.append(label('when the survey is submitted')); break;
        default: row.append(label('when ' + trig.type));
      }
      return row;
    }
    function renderHat(rule) {
      const b = mk('div', 'bk-block bk-hat');
      b.dataset.shape = 'hat';
      colorize(b, 'events');
      b.appendChild(hatLabel(rule.trigger));
      if (interactive) refs.set(b, { drag: 'hat', rule });
      return b;
    }

    function renderScript(rule) {
      const s = mk('div', 'bk-script');
      s.dataset.rule = rule.id;
      if (rule.loose) {
        s.appendChild(isObj(rule.loose) && rule.loose.kind ? renderValue(rule.loose, rule, { loose: true }) : renderBool(rule.loose, rule, { loose: true }));
        if (interactive) refs.set(s.firstChild, { drag: rule.loose.kind ? 'value' : 'bool', loose: true, rule });
      } else {
        if (rule.trigger.type !== 'none') s.appendChild(renderHat(rule));
        const list = renderList(rule.then, rule, 'bk-top');
        s.appendChild(list);
      }
      if (rule.ui) { s.style.left = rule.ui.x + 'px'; s.style.top = rule.ui.y + 'px'; }
      return s;
    }

    /* ── Block shapes (SVG, drawn after layout) ── */
    const NOTCH = (x, y, dir) => (dir > 0 ? 'H' + (x + 12) + ' L' + (x + 16) + ' ' + (y + 4) + ' H' + (x + 24) + ' L' + (x + 28) + ' ' + y : 'H' + (x + 28) + ' L' + (x + 24) + ' ' + (y + 4) + ' H' + (x + 16) + ' L' + (x + 12) + ' ' + y);
    function shapePath(b) {
      const shape = b.dataset.shape;
      const rows = Array.from(b.children).filter(c => c.classList && c.classList.contains('bk-row'));
      const W0 = Math.max(shape === 'hat' ? 120 : 60, ...rows.map(r => r.offsetWidth));
      const H = b.offsetHeight;
      const bottom = (W) => 'V' + (H - 4) + ' Q' + W + ' ' + H + ' ' + (W - 4) + ' ' + H + ' ' + NOTCH(0, H, -1) + ' H4 Q0 ' + H + ' 0 ' + (H - 4) + ' Z';
      if (shape === 'hat') {
        const W = W0;
        return { W, d: 'M0 16 C18 -2 62 -2 86 12 H' + (W - 4) + ' Q' + W + ' 12 ' + W + ' 16 ' + bottom(W) };
      }
      const top = W => 'M0 4 Q0 0 4 0 ' + NOTCH(0, 0, 1) + ' H' + (W - 4) + ' Q' + W + ' 0 ' + W + ' 4 ';
      if (shape === 'stack') { const W = W0; return { W, d: top(W) + bottom(W) }; }
      // C-blocks
      const W = Math.max(W0, 140), A = 16;
      const mouths = Array.from(b.children).filter(c => c.classList && c.classList.contains('bk-mouth'));
      let d = top(W);
      mouths.forEach(m => {
        const y1 = m.offsetTop, y2 = m.offsetTop + m.offsetHeight;
        d += 'V' + (y1 - 4) + ' Q' + W + ' ' + y1 + ' ' + (W - 4) + ' ' + y1 + ' ' + NOTCH(A, y1, -1) + ' H' + (A + 4) + ' Q' + A + ' ' + y1 + ' ' + A + ' ' + (y1 + 4) +
          ' V' + (y2 - 4) + ' Q' + A + ' ' + y2 + ' ' + (A + 4) + ' ' + y2 + ' ' + NOTCH(A, y2, 1) + ' H' + (W - 4) + ' Q' + W + ' ' + y2 + ' ' + W + ' ' + (y2 + 4) + ' ';
      });
      return { W, d: d + bottom(W) };
    }
    function boolPath(n) {
      const W = n.offsetWidth, H = n.offsetHeight, h = H / 2;
      return { W, d: 'M' + h + ' 0 H' + (W - h) + ' L' + W + ' ' + h + ' L' + (W - h) + ' ' + H + ' H' + h + ' L0 ' + h + ' Z' };
    }
    function drawShapes(rootEl) {
      const blocks = rootEl.querySelectorAll('.bk-block, .bk-bool');
      // measure first, then write (avoids layout thrash)
      const geo = Array.from(blocks).map(b => [b, b.classList.contains('bk-bool') ? boolPath(b) : shapePath(b)]);
      geo.forEach(([b, g]) => {
        let svg = b.querySelector(':scope > svg.bk-shape');
        if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'bk-shape'); svg.setAttribute('aria-hidden', 'true'); svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path')); b.insertBefore(svg, b.firstChild); }
        svg.setAttribute('width', g.W); svg.setAttribute('height', b.offsetHeight);
        svg.firstChild.setAttribute('d', g.d);
        if (!b.classList.contains('bk-bool')) b.style.minWidth = g.W + 'px';
      });
    }

    /* ── Workspace render ─────────────────────── */
    function render() {
      W = (doc().rules || []).map(canonRule);
      refs = new WeakMap();
      interactive = true;
      canvas.innerHTML = '';
      const els = W.map(r => { const s = renderScript(r); canvas.appendChild(s); return [r, s]; });
      drawShapes(canvas);
      // Place scripts that have no position yet in a column
      let y = 24;
      els.forEach(([r, s]) => { if (r.ui) y = Math.max(y, r.ui.y + s.offsetHeight + 28); });
      els.forEach(([r, s]) => {
        if (r.ui) return;
        r.ui = { x: 28, y };
        s.style.left = '28px'; s.style.top = y + 'px';
        y += s.offsetHeight + 28;
      });
      sizeCanvas();
      renderProblems();
      emptyEl.hidden = W.length > 0;
      emptyEl.innerHTML = W.length ? '' : '<div class="bk-empty-card"><b>Build your survey\'s logic with blocks</b><span>Drag a yellow <i>when …</i> block from <b>Events</b> onto this space, then snap blocks underneath it — for example <i>if &lt;answer to … = yes&gt; then show …</i>.</span></div>';
      selected = null;   // the selection doesn't survive a re-render
    }
    function sizeCanvas() {
      let w = 0, h = 0;
      canvas.querySelectorAll(':scope > .bk-script').forEach(s => { w = Math.max(w, s.offsetLeft + s.offsetWidth); h = Math.max(h, s.offsetTop + s.offsetHeight); });
      canvas.style.width = Math.max(w + 400, ws.clientWidth / zoom) + 'px';
      canvas.style.height = Math.max(h + 400, ws.clientHeight / zoom) + 'px';
      canvas.style.transform = 'scale(' + zoom + ')';
      canvas.parentElement.style.setProperty('--bk-zoom', zoom);
      const sizer = ws.querySelector('.bk-sizer') || ws.appendChild(mk('div', 'bk-sizer'));
      sizer.style.width = (parseFloat(canvas.style.width) * zoom) + 'px';
      sizer.style.height = (parseFloat(canvas.style.height) * zoom) + 'px';
    }

    function renderPalette() {
      interactive = false;
      const defs = palette();
      pal.innerHTML = '';
      CATS.forEach(c => {
        const sec = mk('section', 'bk-pal-sec');
        sec.dataset.cat = c.id;
        const h = mk('h3', 'bk-pal-h', c.label);
        sec.appendChild(h);
        if (c.id === 'variables') {
          const mkBtn = mk('button', 'bk-make-var', 'Make a variable');
          mkBtn.type = 'button';
          mkBtn.addEventListener('click', () => variableDialog(null));
          sec.appendChild(mkBtn);
          if (!doc().variables.length) sec.appendChild(mk('p', 'bk-pal-note', 'Variables keep a value — a running total, a flag or a calculated result — that blocks can set, change and test.'));
        }
        (defs[c.id] || []).forEach((make, i) => {
          const item = mk('div', 'bk-pal-item');
          const payload = make();
          const n = payload.hat ? renderHat({ trigger: payload.hat }) : payload.stmts ? renderStmt(payload.stmts[0], null, 0, null) : payload.bool ? renderBool(payload.bool, null) : renderValue(payload.value, null);
          item.appendChild(n);
          item.dataset.cat = c.id; item.dataset.i = i;
          if (c.id === 'variables' && payload.value) {
            const gear = mk('button', 'bk-var-edit', '✎');
            gear.type = 'button'; gear.title = 'Rename, set a starting value or formula, or delete'; gear.setAttribute('aria-label', 'Edit variable ' + payload.value.name);
            gear.addEventListener('click', () => variableDialog(payload.value.name));
            item.appendChild(gear);
          }
          palRefs.set(n, { drag: 'palette', make });
          sec.appendChild(item);
        });
        pal.appendChild(sec);
      });
      drawShapes(pal);
      interactive = true;
    }
    container.querySelector('.bk-cats').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      const sec = pal.querySelector('.bk-pal-sec[data-cat="' + b.dataset.cat + '"]');
      if (sec) pal.scrollTo({ top: sec.offsetTop - 8, behavior: 'smooth' });
    });
    pal.addEventListener('scroll', () => {
      let cur = CATS[0].id;
      pal.querySelectorAll('.bk-pal-sec').forEach(s => { if (s.offsetTop - 30 <= pal.scrollTop) cur = s.dataset.cat; });
      container.querySelectorAll('.bk-cat').forEach(b => b.classList.toggle('is-on', b.dataset.cat === cur));
    });

    /* ── Problems ─────────────────────────────── */
    function renderProblems() {
      const probs = Logic.ruleProblems(doc());
      const errs = probs.filter(p => p.level !== 'warning'), warns = probs.filter(p => p.level === 'warning');
      canvas.querySelectorAll('.bk-script').forEach(s => s.classList.remove('has-error', 'has-warning'));
      probs.forEach(p => { const s = p.rule && canvas.querySelector('.bk-script[data-rule="' + CSS.escape(p.rule) + '"]'); if (s) s.classList.add(p.level === 'warning' ? 'has-warning' : 'has-error'); });
      if (!probs.length) { probEl.className = 'bk-problems is-ok'; probEl.innerHTML = '<span>✓ Logic checked — no problems</span>'; return; }
      probEl.className = 'bk-problems ' + (errs.length ? 'is-err' : 'is-warn');
      probEl.innerHTML = '<details' + (errs.length ? ' open' : '') + '><summary>' + (errs.length ? '⚠ ' + errs.length + ' problem' + (errs.length > 1 ? 's' : '') + ' to fix before publishing' : warns.length + ' note' + (warns.length > 1 ? 's' : '')) + '</summary><ul>' +
        probs.map(p => '<li class="' + (p.level === 'warning' ? 'is-warn' : 'is-err') + '"><button type="button" data-goto="' + esc(p.rule || '') + '">' + esc(p.message) + '</button></li>').join('') + '</ul></details>';
    }
    probEl.addEventListener('click', e => {
      const b = e.target.closest('[data-goto]');
      if (!b || !b.dataset.goto) return;
      const s = canvas.querySelector('.bk-script[data-rule="' + CSS.escape(b.dataset.goto) + '"]');
      if (!s) return;
      ws.scrollTo({ left: Math.max(0, s.offsetLeft * zoom - 40), top: Math.max(0, s.offsetTop * zoom - 40), behavior: 'smooth' });
      s.classList.remove('is-flash'); void s.offsetWidth; s.classList.add('is-flash');
    });

    /* ── Variables ────────────────────────────── */
    function variableDialog(name) {
      const v = name ? doc().variables.find(x => x.name === name) : null;
      const App = root.App;
      App.openModal(v ? 'Variable "' + v.name + '"' : 'New variable',
        '<div class="form-group"><label class="form-label" for="bk-v-name">Name</label><input class="form-input" id="bk-v-name" value="' + esc(v ? v.name : '') + '" placeholder="e.g. total" autocomplete="off"><p class="form-hint">Letters, numbers and _ — used in blocks and in formulas like {{total}}.</p></div>' +
        '<div class="form-group"><label class="form-label" for="bk-v-init">Starting value</label><input class="form-input" id="bk-v-init" value="' + esc(v ? v.initial : 0) + '"></div>' +
        '<div class="form-group"><label class="form-label" for="bk-v-formula">Always calculate as (optional formula)</label><input class="form-input" id="bk-v-formula" style="font-family:var(--font-mono, monospace)" value="' + esc(v ? v.formula : '') + '" placeholder="e.g. round(score / 3 * 100)"><p class="form-hint">Leave empty to set and change it with blocks.</p></div>' +
        '<div class="form-error" id="bk-v-err"></div>',
        (v ? '<button class="btn btn-ghost" id="bk-v-del" style="margin-right:auto;color:#B91C1C">Delete variable</button>' : '') +
        '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="bk-v-ok">' + (v ? 'Save' : 'Create') + '</button>');
      const nameIn = document.getElementById('bk-v-name');
      setTimeout(() => nameIn.focus(), 30);
      const ok = () => {
        const nm = nameIn.value.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
        const err = document.getElementById('bk-v-err');
        if (!nm) { err.textContent = 'Give the variable a name.'; return; }
        if (doc().variables.some(x => x.name === nm && x !== v)) { err.textContent = 'There is already a variable called "' + nm + '".'; return; }
        const initRaw = document.getElementById('bk-v-init').value;
        const formula = document.getElementById('bk-v-formula').value.trim();
        if (formula) { const fe = Logic.checkExpression(formula); if (fe) { err.textContent = 'Formula: ' + fe; return; } }
        const initial = numOrText(initRaw);
        const oldName = v ? v.name : null;
        if (oldName && oldName !== nm) renameVarInRules(oldName, nm);
        commit(v ? 'Edit variable' : 'Make a variable', vars => {
          if (v) { const x = vars.find(y => y.name === oldName); Object.assign(x, { name: nm, initial, type: typeof initial === 'number' ? 'number' : 'text', formula }); }
          else vars.push({ id: Core.uid('var'), name: nm, type: typeof initial === 'number' ? 'number' : 'text', initial, formula });
        });
        root.App.closeModal();
        renderPalette();
        const sec = pal.querySelector('.bk-pal-sec[data-cat="variables"]');
        if (sec) pal.scrollTo({ top: sec.offsetTop - 8 });
      };
      document.getElementById('bk-v-ok').onclick = ok;
      ['bk-v-name', 'bk-v-init', 'bk-v-formula'].forEach(id => document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') ok(); }));
      const del = document.getElementById('bk-v-del');
      if (del) del.onclick = () => { commit('Delete variable', vars => { const i = vars.findIndex(y => y.name === v.name); if (i >= 0) vars.splice(i, 1); }); root.App.closeModal(); renderPalette(); };
    }
    function renameVarInRules(from, to) {
      const walk = o => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!isObj(o)) return;
        if (o.kind === 'var' && o.name === from) o.name = to;
        if ((o.type === 'setVar' || o.type === 'changeVar') && o.name === from) o.name = to;
        Object.keys(o).forEach(k => { if (typeof o[k] === 'object') walk(o[k]); });
      };
      walk(W);
    }

    /* ── Drag and drop ────────────────────────── */
    const toCanvas = (cx, cy) => { const r = canvas.getBoundingClientRect(); return { x: (cx - r.left) / zoom, y: (cy - r.top) / zoom }; };
    function newRule(trigger, then, ui, loose) {
      const r = { id: Core.uid('rule'), name: '', enabled: true, trigger: trigger || { type: 'none' }, when: { op: 'all', items: [] }, then: then || [], else: [], ui };
      if (loose) r.loose = loose;
      r.name = autoName(r.trigger);
      return r;
    }
    function autoName(t) {
      if (!t) return 'Script';
      const pg = id => { const i = doc().pages.findIndex(p => p.id === id); return i >= 0 ? doc().pages[i].name : 'any page'; };
      switch (t.type) {
        case 'always': return 'When any answer changes';
        case 'pageEnter': return 'When ' + pg(t.page) + ' opens';
        case 'pageExit': return 'When leaving ' + pg(t.page);
        case 'click': return 'When ' + (doc().elements[t.element] ? Core.displayName(doc(), doc().elements[t.element]) : 'a button') + ' is clicked';
        case 'submit': return 'When the survey is submitted';
        default: return 'Loose blocks';
      }
    }
    const removeRule = r => { const i = W.indexOf(r); if (i >= 0) W.splice(i, 1); };

    app.addEventListener('pointerdown', e => {
      if (e.button !== 0 || drag) return;
      if (e.target.closest('input, select, button, a, textarea, .bk-problems, .bk-zoom')) return;
      let el = e.target;
      let ref = null;
      while (el && el !== app) { ref = refs.get(el) || palRefs.get(el); if (ref && ref.drag) break; ref = null; el = el.parentElement; }
      if (!ref) {
        if (e.target.closest('.bk-ws')) startPan(e);
        return;
      }
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY };
      const rect = el.getBoundingClientRect();
      const grab = { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
      if (ref.drag !== 'palette') selectBlock(el);
      const onMove = ev => {
        if (!drag) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
          beginDrag(ref, el, grab, ev);
        }
        if (drag) moveDrag(ev);
      };
      const onUp = ev => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        if (drag) endDrag(ev, ev.type === 'pointercancel');
        else if (ref.drag === 'palette') clickPalette(ref);
        else if (ref.drag === 'stmt' || ref.drag === 'hat') pendingTry = { ref, el, at: Date.now() };   // runs on the click event
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });

    /* ── Click to try (like clicking a block in Scratch) ── */
    // Runs from the click event — the one every browser trusts to open a tab.
    let pendingTry = null;
    app.addEventListener('click', e => {
      const p = pendingTry;
      pendingTry = null;
      if (!p || Date.now() - p.at > 1500 || e.target.closest('input, select, button, a, textarea')) return;
      tryBlocks(p.ref, p.el);
    });
    const notify = (msg, type, ms) => (opts.notify || (root.App && root.App.notify) || (() => {}))(msg, type, ms);
    // Opens a link block's address in a new tab. Runs inside the click, so browsers allow it.
    function safeLink(raw) {
      const link = Logic.linkOf(raw);
      return link && link.indexOf('{{') === -1 ? Core.safeUrl(link, ['https', 'http', 'mailto']) : null;
    }
    function tryLink(raw) {
      const link = Logic.linkOf(raw);
      const u = link && link.indexOf('{{') === -1 ? Core.safeUrl(link, ['https', 'http', 'mailto']) : null;
      if (!u) {
        notify(link ? 'This link uses {{…}}, which is filled in from answers — try it in Preview.' : 'Type a web address in the block first, like https://example.com.', link ? 'info' : 'error', 4200);
        return false;
      }
      let w = null;
      try { w = window.open(u, '_blank'); } catch (e) { w = null; }
      if (w) { try { w.opener = null; } catch (e) { /* cross-origin */ } notify('Opened ' + u, 'success', 2200); }
      else notify('Your browser blocked the new tab — allow pop-ups for this site, or try the link in Preview.', 'error', 5200);
      return !!w;
    }
    // Clicking a hat runs its script; clicking a block runs that block. Conditions see a
    // survey with no answers yet; open link and messages happen here, the rest is listed.
    function tryBlocks(ref, el) {
      const stmts = ref.drag === 'hat' ? ref.rule.then : [ref.arr[ref.index]];
      if (!stmts || !stmts.length) { notify('Snap blocks under this hat, then click it to try the script.', 'info', 3200); return; }
      const script = el.closest('.bk-script');
      if (script) { script.classList.remove('is-running'); void script.offsetWidth; script.classList.add('is-running'); setTimeout(() => script.classList.remove('is-running'), 900); }
      const trial = Object.assign({}, doc(), { rules: [{ id: '__try', name: 'Try', enabled: true, trigger: { type: 'click', element: '__try' }, when: { op: 'all', items: [] }, then: clone(stmts), else: [] }] });
      let effects = [];
      try { effects = Logic.runEvent(trial, { type: 'click', element: '__try' }, Logic.computeState(doc(), { answers: {} })); } catch (e) { effects = []; }
      let opened = false;
      const later = [];
      effects.forEach(e => {
        if (e.type === 'openUrl') { if (!opened) opened = tryLink(e.text || e.value) || true; }
        else if (e.type === 'message' || e.type === 'complete') notify(e.text || '(empty message)', 'info', 4200);
        else later.push((Logic.ACTIONS[e.type] || {}).label || e.type);
      });
      if (!effects.length) notify('Nothing ran: the if condition is false while there are no answers. Try it with answers in Preview.', 'info', 4800);
      else if (later.length && !opened) notify('In the survey this will: ' + later.slice(0, 3).join(', ').toLowerCase() + (later.length > 3 ? '…' : '') + '. Try it in Preview.', 'info', 4200);
    }

    // Clicking a palette block adds it to the workspace (keyboard-free shortcut)
    function clickPalette(ref) {
      const p = ref.make();
      const pos = { x: (ws.scrollLeft / zoom) + 40, y: (ws.scrollTop / zoom) + 40 };
      // find free spot below existing scripts in view
      let y = pos.y;
      canvas.querySelectorAll(':scope > .bk-script').forEach(s => { if (s.offsetLeft < pos.x + 300 && s.offsetTop + s.offsetHeight > y - 10 && s.offsetTop < y + 60) y = s.offsetTop + s.offsetHeight + 24; });
      if (p.hat) W.push(newRule(p.hat, [], { x: pos.x, y }));
      else if (p.stmts) W.push(newRule(null, p.stmts, { x: pos.x, y }));
      else W.push(newRule(null, [], { x: pos.x, y }, p.bool || p.value));
      commit('Add block');
    }

    function beginDrag(ref, el, grab, ev) {
      let payload;
      const fromPalette = ref.drag === 'palette';
      if (fromPalette) payload = ref.make();
      else if (ref.drag === 'hat') payload = { script: ref.rule };
      else if (ref.drag === 'stmt') {
        const stmts = ref.arr.splice(ref.index);
        if (ref.arr === ref.rule.then && ref.rule.trigger.type === 'none' && !ref.rule.then.length) removeRule(ref.rule);
        payload = { stmts };
      } else if (ref.loose) { removeRule(ref.rule); payload = ref.drag === 'bool' ? { bool: ref.rule.loose } : { value: ref.rule.loose }; }
      else if (ref.drag === 'bool') { payload = { bool: ref.holder[ref.key] }; ref.holder[ref.key] = null; }
      else if (ref.drag === 'value') { payload = { value: ref.holder[ref.key] }; ref.holder[ref.key] = lit(''); }
      // Ghost
      const ghost = mk('div', 'bk-ghost');
      const inner = mk('div', 'bk-ghost-in');
      inner.style.transform = 'scale(' + zoom + ')';
      ghost.appendChild(inner);
      interactive = false;
      if (payload.script) { const s = renderScript(payload.script); s.style.left = s.style.top = '0'; inner.appendChild(s); }
      else if (payload.hat) inner.appendChild(renderHat({ trigger: payload.hat }));
      else if (payload.stmts) { const l = mk('div', 'bk-list'); payload.stmts.forEach(a => l.appendChild(renderStmt(a, null, 0, null))); inner.appendChild(l); }
      else if (payload.bool) inner.appendChild(renderBool(payload.bool, null));
      else inner.appendChild(renderValue(payload.value, null));
      interactive = true;
      document.body.appendChild(ghost);
      drawShapes(inner);
      drag = { payload, grab, ghost, fromPalette, target: null, marker: null, hidden: null };
      app.classList.add('is-dragging');
      // Re-render the workspace without the dragged blocks so the gap closes
      if (payload.script) { const s = canvas.querySelector('.bk-script[data-rule="' + CSS.escape(payload.script.id) + '"]'); if (s) { s.style.visibility = 'hidden'; drag.hidden = s; } }
      else if (!fromPalette) rerenderWorking();
      drag.size = { w: inner.firstChild.offsetWidth, h: inner.firstChild.offsetHeight };
      moveDrag(ev);
    }
    // Re-render from W (the working copy) during a drag.
    function rerenderWorking() {
      refs = new WeakMap();
      canvas.innerHTML = '';
      W.forEach(r => canvas.appendChild(renderScript(r)));
      drawShapes(canvas);
    }

    function moveDrag(ev) {
      const d = drag;
      d.ghost.style.left = (ev.clientX - d.grab.x * zoom) + 'px';
      d.ghost.style.top = (ev.clientY - d.grab.y * zoom) + 'px';
      const overPal = !!(document.elementFromPoint(ev.clientX, ev.clientY) || { closest: () => null }).closest('.bk-palette');
      app.classList.toggle('is-over-trash', overPal && !(d.fromPalette));
      clearTarget();
      if (overPal) return;
      const p = toCanvas(ev.clientX - d.grab.x * zoom, ev.clientY - d.grab.y * zoom);   // ghost's top-left in canvas coords
      if (d.payload.stmts) d.target = findStackTarget(p);
      else if (d.payload.hat || (d.payload.script && d.payload.script.trigger.type !== 'none')) d.target = findTopTarget(p, d.payload.script);
      else if (d.payload.bool) d.target = findSlotTarget(p, 'bool');
      else if (d.payload.value) d.target = findSlotTarget(p, 'value');
      showTarget();
    }
    function clearTarget() {
      if (drag.marker) { drag.marker.remove(); drag.marker = null; }
      canvas.querySelectorAll('.bk-slot.is-target').forEach(s => s.classList.remove('is-target'));
      drag.target = null;
    }
    function showTarget() {
      const t = drag.target;
      if (!t) return;
      if (t.slotEl) { t.slotEl.classList.add('is-target'); return; }
      const m = mk('div', 'bk-marker');
      m.style.left = t.x + 'px'; m.style.top = (t.y - 3) + 'px'; m.style.width = Math.max(80, drag.size.w / zoom) + 'px';
      canvas.appendChild(m);
      drag.marker = m;
    }
    // Connection points for a stack of blocks
    function rel(el) { const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect(); return { x: (r.left - c.left) / zoom, y: (r.top - c.top) / zoom, w: r.width / zoom, h: r.height / zoom }; }
    function findStackTarget(p) {
      let best = null;
      const consider = (x, y, t) => { const dist = Math.hypot(p.x - x, p.y - y); if (dist < SNAP * 1.6 && (!best || dist < best.dist)) best = Object.assign({ x, y, dist }, t); };
      canvas.querySelectorAll('.bk-list').forEach(list => {
        const ref = refs.get(list);
        if (!ref) return;
        const kids = Array.from(list.children).filter(c => c.classList.contains('bk-block'));
        const lr = rel(list);
        const hatless = list.classList.contains('bk-top') && ref.rule.trigger.type === 'none';
        if (!kids.length) { consider(lr.x, lr.y, { list: ref.list, index: 0, rule: ref.rule }); return; }
        kids.forEach((k, i) => {
          const r = rel(k);
          if (i === 0 && hatless) consider(r.x, r.y - drag.size.h / zoom, { list: ref.list, index: 0, rule: ref.rule, above: true });
          else if (i > 0 || !hatless) consider(r.x, r.y, { list: ref.list, index: i, rule: ref.rule });
          if (i === kids.length - 1) consider(r.x, r.y + r.h, { list: ref.list, index: i + 1, rule: ref.rule });
        });
      });
      if (best && best.above) best.y = best.y + drag.size.h / zoom;   // marker on the seam
      return best;
    }
    // A hat can go on top of a stack that has no hat
    function findTopTarget(p, self) {
      let best = null;
      canvas.querySelectorAll(':scope > .bk-script').forEach(s => {
        const r = W.find(x => x.id === s.dataset.rule);
        if (!r || r === self || r.trigger.type !== 'none' || r.loose || !r.then.length) return;
        const sr = rel(s);
        const x = sr.x, y = sr.y - drag.size.h / zoom;
        const dist = Math.hypot(p.x - x, p.y - y);
        if (dist < SNAP * 1.6 && (!best || dist < best.dist)) best = { x, y: sr.y, dist, onto: r };
      });
      return best;
    }
    function findSlotTarget(p, kind) {
      let best = null;
      const py = p.y + (drag.size.h / zoom) / 2;
      canvas.querySelectorAll(kind === 'bool' ? '.bk-bslot' : '.bk-vslot').forEach(slot => {
        const ref = refs.get(slot);
        if (!ref) return;
        const r = rel(slot);
        const dx = p.x - r.x, dy = py - (r.y + r.h / 2);
        const inside = p.x >= r.x - 14 && p.x <= r.x + r.w && Math.abs(dy) <= r.h / 2 + 10;
        const dist = Math.hypot(dx, dy);
        if ((inside || dist < SNAP) && (!best || dist < best.dist || (inside && !best.inside))) best = { slotEl: slot, ref, dist, inside };
      });
      return best;
    }

    function endDrag(ev, cancelled) {
      const d = drag;
      drag = null;
      d.ghost.remove();
      if (d.marker) d.marker.remove();
      app.classList.remove('is-dragging', 'is-over-trash');
      if (cancelled) { render(); return; }
      const overPal = !!(document.elementFromPoint(ev.clientX, ev.clientY) || { closest: () => null }).closest('.bk-palette');
      const pos = toCanvas(ev.clientX - d.grab.x * zoom, ev.clientY - d.grab.y * zoom);
      pos.x = Math.round(Math.max(0, pos.x)); pos.y = Math.round(Math.max(0, pos.y));
      const P = d.payload, t = d.target;
      if (overPal) {
        if (d.fromPalette) { render(); return; }
        if (P.script) removeRule(P.script);
        commit('Delete blocks');
        return;
      }
      if (P.script) {
        if (t && t.onto) { P.script.then = P.script.then.concat(t.onto.then); P.script.ui = { x: t.onto.ui.x, y: Math.max(0, t.onto.ui.y - d.size.h / zoom + 4) }; removeRule(t.onto); }
        else P.script.ui = pos;
        commit('Move script');
        return;
      }
      if (P.hat) {
        if (t && t.onto) { t.onto.trigger = P.hat; t.onto.name = autoName(P.hat); t.onto.ui = { x: t.onto.ui.x, y: Math.max(0, t.onto.ui.y - d.size.h / zoom + 4) }; }
        else W.push(newRule(P.hat, [], pos));
        commit('Add block');
        return;
      }
      if (P.stmts) {
        if (t) {
          t.list.splice(t.index, 0, ...P.stmts);
          if (t.above && t.rule.ui) t.rule.ui = { x: t.rule.ui.x, y: Math.max(0, t.rule.ui.y - d.size.h / zoom + 4) };
        } else W.push(newRule(null, P.stmts, pos));
        commit(d.fromPalette ? 'Add block' : 'Move blocks');
        return;
      }
      const node = P.bool || P.value;
      if (t && t.ref) {
        const old = t.ref.holder[t.ref.key];
        t.ref.holder[t.ref.key] = node;
        // A block already in the slot is popped out next to it
        const displaced = P.bool ? isObj(old) : (isObj(old) && old.kind && old.kind !== 'value');
        if (displaced) W.push(newRule(null, [], { x: pos.x + 30, y: pos.y + 50 }, old));
      } else W.push(newRule(null, [], pos, node));
      commit(d.fromPalette ? 'Add block' : 'Move blocks');
    }

    /* ── Pan & zoom ───────────────────────────── */
    function startPan(e) {
      if (e.target.closest('.bk-script')) return;
      selectBlock(null);
      const sx = e.clientX, sy = e.clientY, sl = ws.scrollLeft, st = ws.scrollTop;
      ws.classList.add('is-panning');
      const mv = ev => { ws.scrollLeft = sl - (ev.clientX - sx); ws.scrollTop = st - (ev.clientY - sy); };
      const up = () => { ws.classList.remove('is-panning'); document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
    }
    function setZoom(z, cx, cy) {
      z = Math.max(0.5, Math.min(1.75, Math.round(z * 100) / 100));
      const r = ws.getBoundingClientRect();
      cx = cx === undefined ? r.width / 2 : cx - r.left; cy = cy === undefined ? r.height / 2 : cy - r.top;
      const wx = (ws.scrollLeft + cx) / zoom, wy = (ws.scrollTop + cy) / zoom;
      zoom = z;
      sizeCanvas();
      ws.scrollLeft = wx * zoom - cx; ws.scrollTop = wy * zoom - cy;
    }
    container.querySelector('.bk-zoom').addEventListener('click', e => {
      const b = e.target.closest('[data-z]');
      if (!b) return;
      setZoom(b.dataset.z === 'in' ? zoom + 0.15 : b.dataset.z === 'out' ? zoom - 0.15 : 1);
    });
    ws.addEventListener('wheel', e => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX, e.clientY); }, { passive: false });

    /* ── Selection, context menu, keyboard ────── */
    function selectBlock(el) {
      if (selected) selected.classList.remove('is-selected');
      selected = el;
      if (el) el.classList.add('is-selected');
    }
    function blockRef(el) { return el ? refs.get(el) : null; }
    function deleteBlock(el) {
      const ref = blockRef(el);
      if (!ref) return;
      if (ref.drag === 'hat') removeRule(ref.rule);
      else if (ref.drag === 'stmt') { ref.arr.splice(ref.index, 1); if (ref.rule.trigger.type === 'none' && !ref.rule.then.length) removeRule(ref.rule); }
      else if (ref.loose) removeRule(ref.rule);
      else if (ref.drag === 'bool') ref.holder[ref.key] = null;
      else if (ref.drag === 'value') ref.holder[ref.key] = lit('');
      else return;
      commit('Delete block');
    }
    function duplicateBlock(el) {
      const ref = blockRef(el);
      if (!ref) return;
      const r = rel(el.closest('.bk-script') || el);
      const at = { x: Math.round(r.x + 30), y: Math.round(r.y + r.h + 20) };
      if (ref.drag === 'hat') { const c = clone(ref.rule); c.id = Core.uid('rule'); c.ui = at; W.push(c); }
      else if (ref.drag === 'stmt') W.push(newRule(null, clone(ref.arr.slice(ref.index)), at));
      else if (ref.loose) { const c = clone(ref.rule); c.id = Core.uid('rule'); c.ui = at; W.push(c); }
      else W.push(newRule(null, [], at, clone(ref.holder[ref.key])));
      commit('Duplicate blocks');
    }
    function cleanUp() {
      let y = 24;
      Array.from(canvas.querySelectorAll(':scope > .bk-script')).sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft).forEach(s => {
        const r = W.find(x => x.id === s.dataset.rule);
        if (!r) return;
        r.ui = { x: 28, y };
        y += s.offsetHeight + 28;
      });
      commit('Clean up blocks');
      ws.scrollTo({ left: 0, top: 0 });
    }
    function editJson(rule) {
      const App = root.App;
      App.openModal('Script as JSON', '<p class="form-hint" style="margin-bottom:8px">The advanced representation of this script. It\'s checked when you save.</p><textarea class="form-input" id="bk-json" spellcheck="false" style="min-height:320px;font-family:var(--font-mono, monospace);font-size:12px">' + esc(JSON.stringify(rule, null, 2)) + '</textarea><div class="form-error" id="bk-json-err"></div>',
        '<button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button><button class="btn btn-primary" id="bk-json-ok">Save</button>');
      document.getElementById('bk-json-ok').onclick = () => {
        let parsed;
        try { parsed = JSON.parse(document.getElementById('bk-json').value); } catch (e) { document.getElementById('bk-json-err').textContent = 'Not valid JSON: ' + e.message; return; }
        if (!isObj(parsed)) { document.getElementById('bk-json-err').textContent = 'A script is a JSON object.'; return; }
        const i = W.indexOf(rule);
        const { doc: normal } = Core.normalizeDoc(Object.assign({}, doc(), { rules: [Object.assign({}, parsed, { id: rule.id })] }));
        W[i] = canonRule(normal.rules[0]);
        App.closeModal();
        commit('Edit script JSON');
      };
    }
    let menu = null;
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }
    function openMenu(x, y, items) {
      closeMenu();
      menu = mk('div', 'bk-menu');
      menu.setAttribute('role', 'menu');
      items.forEach(([lab, fn, danger]) => {
        const b = mk('button', danger ? 'is-danger' : '', lab);
        b.type = 'button'; b.setAttribute('role', 'menuitem');
        b.addEventListener('click', () => { closeMenu(); fn(); });
        menu.appendChild(b);
      });
      document.body.appendChild(menu);
      const r = menu.getBoundingClientRect();
      menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
      menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
      menu.querySelector('button').focus();
    }
    const onDocDown = e => { if (menu && !menu.contains(e.target)) closeMenu(); };
    document.addEventListener('pointerdown', onDocDown, true);
    cleanup.push(() => document.removeEventListener('pointerdown', onDocDown, true));
    ws.addEventListener('contextmenu', e => {
      e.preventDefault();
      let el = e.target, ref = null;
      while (el && el !== ws) { ref = refs.get(el); if (ref && ref.drag) break; ref = null; el = el.parentElement; }
      if (!ref) { openMenu(e.clientX, e.clientY, [['Clean up blocks', cleanUp]]); return; }
      selectBlock(el);
      const items = [['Duplicate', () => duplicateBlock(el)]];
      const scriptRule = ref.rule;
      if (scriptRule && !ref.loose) items.push(['Edit script as JSON…', () => editJson(scriptRule)]);
      items.push([ref.drag === 'hat' ? 'Delete script' : 'Delete block', () => deleteBlock(el), true]);
      openMenu(e.clientX, e.clientY, items);
    });
    const onKey = e => {
      if (container.closest('[hidden]') || !container.offsetParent) return;
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      if (e.key === 'Escape') { closeMenu(); selectBlock(null); return; }
      if (!selected) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteBlock(selected); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); e.stopPropagation(); duplicateBlock(selected); }
    };
    document.addEventListener('keydown', onKey, true);
    cleanup.push(() => document.removeEventListener('keydown', onKey, true));

    cleanup.push(store.on((type, info) => {
      if (type !== 'change' || selfEdit || drag) return;
      if (info.logic || info.structure || info.pages) { render(); if (info.logic || info.pages) renderPalette(); }
    }));
    const ro = new ResizeObserver(() => { if (!drag) sizeCanvas(); });
    ro.observe(ws);
    cleanup.push(() => ro.disconnect());

    function refresh() { render(); renderPalette(); }
    refresh();
    // fonts may load after the first layout; redraw shapes once they're ready
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (container.isConnected && !drag) { drawShapes(canvas); drawShapes(pal); } });

    return {
      render: refresh,
      destroy() { closeMenu(); cleanup.forEach(f => f()); container.innerHTML = ''; }
    };
  }

  root.SurveyBlocks = { create, CATS };
})(typeof window !== 'undefined' ? window : this);
