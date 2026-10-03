/* ══════════════════════════════════════════════
   survey-logic-ui.js — the Logic tab

   Rules are built from blocks, Scratch-style:
     WHEN (event)  →  IF (conditions, nestable "all/any" groups)
                   →  THEN (actions)  →  OTHERWISE (actions)
   e.g.  WHEN while answering  IF answer to "Do you smoke?" is "yes"
         THEN show "How many per day?"
   Variables hold values (optionally calculated by a formula); formulas use
   the expression language from survey-logic.js. Each rule can also be
   edited as JSON. Problems (missing targets, invalid formulas) are listed
   live and block publishing.
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore, Logic = root.SurveyLogic;
  const { clone, isObj } = Core;
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function create(container, store, opts) {
    opts = opts || {};
    const doc = () => store.doc;
    const jsonOpen = new Set();
    let focusRule = null;

    let selfEdit = false;
    // Applies an edit, then re-renders and puts focus back on the same control.
    function edit(label, fn, coalesce) {
      const key = focusKey(document.activeElement);
      selfEdit = true;
      try { store.tx(label, t => { const rules = t.part('rules'); const vars = t.part('variables'); fn(rules, vars); }, coalesce ? { coalesce } : undefined); }
      finally { selfEdit = false; }
      render();
      if (key) { const el = container.querySelector(key); if (el) el.focus(); }
    }
    function focusKey(el) {
      if (!el || !container.contains(el)) return null;
      const attrs = ['data-of', 'data-af', 'data-rf', 'data-vf', 'data-gf', 'data-path', 'data-act', 'data-list'];
      let sel = el.tagName.toLowerCase() + attrs.filter(a => el.hasAttribute(a)).map(a => '[' + a + '="' + CSS.escape(el.getAttribute(a)) + '"]').join('');
      const rule = el.closest('[data-rule]'), action = el.closest('.ss-action'), v = el.closest('[data-var]');
      if (action) sel = '.ss-action[data-list="' + action.dataset.list + '"][data-index="' + action.dataset.index + '"] ' + sel;
      if (v) sel = '[data-var="' + CSS.escape(v.dataset.var) + '"] ' + sel;
      if (rule) sel = '[data-rule="' + CSS.escape(rule.dataset.rule) + '"] ' + sel;
      return sel;
    }
    const ruleById = (rules, id) => rules.find(r => r.id === id);

    function questions() { return Core.questionsInOrder(doc()); }
    function pageName(el) { const p = Core.pageOf(doc(), el.id); return p ? p.name : ''; }
    function qOptions(selected) {
      return '<option value="">Choose a question…</option>' + questions().map(q => '<option value="' + esc(q.id) + '"' + (q.id === selected ? ' selected' : '') + '>' + esc(Core.dataKeyOf(doc(), q) + ' · ' + Core.displayName(doc(), q)) + '</option>').join('');
    }
    function elementOptions(selected, filter) {
      let html = '<option value="">Choose…</option>';
      doc().pages.forEach(p => {
        const ids = Core.descendants(doc(), 'page:' + p.id).filter(id => !filter || filter(doc().elements[id]));
        if (!ids.length) return;
        html += '<optgroup label="' + esc(p.name) + '">' + ids.map(id => { const e = doc().elements[id]; return '<option value="' + esc(id) + '"' + (id === selected ? ' selected' : '') + '>' + esc((Core.isQuestionType(e.type) ? '❓ ' : '') + Core.displayName(doc(), e)) + '</option>'; }).join('') + '</optgroup>';
      });
      return html;
    }
    function pageOptions(selected, withAny) {
      return (withAny ? '<option value="any"' + (selected === 'any' ? ' selected' : '') + '>any page</option>' : '<option value="">Choose a page…</option>') +
        doc().pages.map((p, i) => '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc((i + 1) + '. ' + p.name) + '</option>').join('');
    }
    function varOptions(selected) {
      return '<option value="">Choose a variable…</option>' + doc().variables.map(v => '<option value="' + esc(v.name) + '"' + (v.name === selected ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('');
    }

    /* ── Rendering ───────────────────────── */
    function render() {
      const problems = Logic.ruleProblems(doc());
      const errs = problems.filter(p => p.level !== 'warning'), warns = problems.filter(p => p.level === 'warning');
      let html = '<div class="ss-logic">';
      html += '<aside class="ss-logic-side">' + varsCard() + keysCard() + helpCard() + '</aside><div class="ss-logic-main">';
      html += '<div class="ss-logic-top"><div><h2 class="ss-logic-h">Logic rules</h2><p class="ss-logic-sub">Rules run top to bottom. Use them to show or skip questions, branch between pages, calculate values and change how things look.</p></div>' +
        '<div class="ss-logic-new"><button type="button" class="btn btn-primary btn-sm" data-act="new-menu" aria-haspopup="true">+ New rule</button></div></div>';
      if (errs.length || warns.length) {
        html += '<div class="ss-problems' + (errs.length ? ' is-error' : '') + '" role="status"><strong>' + (errs.length ? errs.length + ' problem' + (errs.length === 1 ? '' : 's') + ' must be fixed before publishing' : 'Warnings') + '</strong><ul>' +
          problems.map(p => '<li class="' + (p.level === 'warning' ? 'is-warn' : '') + '">' + esc(p.message) + '</li>').join('') + '</ul></div>';
      }
      if (!doc().rules.length) {
        html += '<div class="ss-logic-empty"><div class="ss-block ss-b-event">WHEN someone answers</div><div class="ss-block ss-b-cond">IF answer to Question A is “Yes”</div><div class="ss-block ss-b-act">THEN show Question B</div>' +
          '<p>No rules yet. Start from an example:</p><div class="ss-btn-row">' + presetButtons() + '</div></div>';
      }
      doc().rules.forEach((r, i) => { html += ruleCard(r, i, problems.filter(p => p.rule === r.id)); });
      html += '</div></div>';
      container.innerHTML = html;
      if (focusRule) { const el = container.querySelector('[data-rule="' + focusRule + '"]'); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('is-flash'); } focusRule = null; }
    }
    function presetButtons() {
      return '<button type="button" class="ss-chip-btn" data-preset="show">Show a question based on an answer</button>' +
        '<button type="button" class="ss-chip-btn" data-preset="skip">Skip to a page based on an answer</button>' +
        '<button type="button" class="ss-chip-btn" data-preset="style">Change a colour when an answer is chosen</button>' +
        '<button type="button" class="ss-chip-btn" data-preset="score">End the survey when the score is high</button>' +
        '<button type="button" class="ss-chip-btn" data-preset="blank">Blank rule</button>';
    }

    function varsCard() {
      let html = '<section class="ss-card"><div class="ss-card-head"><span>Variables</span><button type="button" class="ss-chip-btn" data-act="add-var">+ Add</button></div>';
      if (!doc().variables.length) html += '<p class="ss-empty-note">Variables store values: a running total, a flag, a calculated result. Use them in formulas, conditions and text like {{total}}.</p>';
      doc().variables.forEach(v => {
        const err = v.formula ? Logic.checkExpression(v.formula) : null;
        html += '<div class="ss-var" data-var="' + esc(v.id) + '"><div class="ss-var-row"><input class="ss-input is-mono" data-vf="name" value="' + esc(v.name) + '" aria-label="Variable name">' +
          '<select class="ss-select" data-vf="type" aria-label="Variable type">' + ['number', 'text', 'boolean'].map(t => '<option' + (t === v.type ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' +
          '<button type="button" class="ss-icon-btn" data-act="del-var" aria-label="Delete variable ' + esc(v.name) + '">✕</button></div>' +
          '<label class="ss-var-lab">Start value<input class="ss-input" data-vf="initial" value="' + esc(v.initial) + '"></label>' +
          '<label class="ss-var-lab">Formula <span>(optional — recalculated after every answer)</span><input class="ss-input is-mono" data-vf="formula" value="' + esc(v.formula) + '" placeholder="e.g. score * 2 + q3"></label>' +
          (err ? '<div class="ss-field-err">' + esc(err) + '</div>' : '') + '</div>';
      });
      return html + '</section>';
    }
    function keysCard() {
      const qs = questions();
      return '<section class="ss-card"><div class="ss-card-head"><span>Answer keys</span></div><p class="ss-empty-note">Use these names in formulas and {{ }} text.</p><ul class="ss-keys">' +
        (qs.length ? qs.map(q => '<li><code>' + esc(Core.dataKeyOf(doc(), q)) + '</code><span>' + esc(Core.displayName(doc(), q)) + '</span></li>').join('') : '<li class="ss-empty-note">No questions yet.</li>') +
        '<li><code>score</code><span>Total score of the answers so far</span></li><li><code>page</code><span>Current page number</span></li></ul></section>';
    }
    function helpCard() {
      return '<details class="ss-card ss-help"><summary>Formula reference</summary><ul class="ss-keys">' + Logic.FUNC_HELP.map(([f, d]) => '<li><code>' + esc(f) + '</code><span>' + esc(d) + '</span></li>').join('') +
        '<li><code>+ - * / % ^</code><span>Arithmetic; + also joins text</span></li><li><code>== != &lt; &lt;= &gt; &gt;=</code><span>Comparisons</span></li><li><code>and or not</code><span>Combine tests (also &amp;&amp; || !)</span></li></ul></details>';
    }

    function ruleCard(r, i, problems) {
      const trig = r.trigger || { type: 'always' };
      const showJson = jsonOpen.has(r.id);
      let html = '<article class="ss-rule' + (r.enabled ? '' : ' is-off') + (problems.some(p => p.level !== 'warning') ? ' has-error' : '') + '" data-rule="' + esc(r.id) + '">' +
        '<header class="ss-rule-head"><label class="ss-switch" title="' + (r.enabled ? 'Enabled' : 'Disabled') + '"><input type="checkbox" data-rf="enabled"' + (r.enabled ? ' checked' : '') + ' aria-label="Rule enabled"><span class="ss-switch-knob"></span></label>' +
        '<input class="ss-rule-name" data-rf="name" value="' + esc(r.name) + '" aria-label="Rule name">' +
        '<div class="ss-rule-tools"><button type="button" class="ss-icon-btn" data-act="up" title="Move up" aria-label="Move rule up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="ss-icon-btn" data-act="down" title="Move down" aria-label="Move rule down"' + (i === doc().rules.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="ss-icon-btn" data-act="dup" title="Duplicate" aria-label="Duplicate rule">⧉</button>' +
        '<button type="button" class="ss-icon-btn' + (showJson ? ' is-on' : '') + '" data-act="json" title="Edit as JSON" aria-label="Edit rule as JSON">{ }</button>' +
        '<button type="button" class="ss-icon-btn" data-act="del" title="Delete" aria-label="Delete rule">✕</button></div></header>';
      if (showJson) {
        html += '<div class="ss-rule-json"><textarea class="ss-input ss-textarea is-mono" rows="12" spellcheck="false" aria-label="Rule JSON">' + esc(JSON.stringify(r, null, 2)) + '</textarea>' +
          '<div class="ss-btn-row"><button type="button" class="btn btn-primary btn-sm" data-act="json-apply">Apply JSON</button><span class="ss-field-err" data-json-err></span></div></div>';
      } else {
        html += '<div class="ss-block ss-b-event"><span class="ss-kw">WHEN</span><select class="ss-select" data-rf="trigger" aria-label="When">' +
          Object.keys(Logic.TRIGGERS).map(k => '<option value="' + k + '"' + (trig.type === k ? ' selected' : '') + '>' + esc(Logic.TRIGGERS[k].label) + '</option>').join('') + '</select>';
        if (trig.type === 'pageExit' || trig.type === 'pageEnter') html += '<select class="ss-select" data-rf="trigger.page" aria-label="Which page">' + pageOptions(trig.page || 'any', true) + '</select>';
        if (trig.type === 'click') html += '<select class="ss-select" data-rf="trigger.element" aria-label="Which button">' + elementOptions(trig.element, e => e.type === 'button') + '</select>';
        html += '</div>';
        html += '<div class="ss-block ss-b-cond"><span class="ss-kw">IF</span>' + groupHtml(r.when || { op: 'all', items: [] }, 'when') + '</div>';
        html += '<div class="ss-block ss-b-act"><span class="ss-kw">THEN</span><div class="ss-actions">' + (r.then || []).map((a, j) => actionHtml(a, 'then', j, trig)).join('') +
          '<button type="button" class="ss-add-btn" data-act="add-action" data-list="then">+ Add action</button></div></div>';
        if ((r.else || []).length) html += '<div class="ss-block ss-b-else"><span class="ss-kw">OTHERWISE</span><div class="ss-actions">' + r.else.map((a, j) => actionHtml(a, 'else', j, trig)).join('') +
          '<button type="button" class="ss-add-btn" data-act="add-action" data-list="else">+ Add action</button></div></div>';
        else html += '<button type="button" class="ss-add-btn ss-add-else" data-act="add-action" data-list="else">+ Otherwise…</button>';
      }
      if (problems.length) html += '<ul class="ss-rule-problems">' + problems.map(p => '<li class="' + (p.level === 'warning' ? 'is-warn' : '') + '">' + esc(p.message.replace(r.name + ': ', '')) + '</li>').join('') + '</ul>';
      return html + '</article>';
    }

    function groupHtml(g, path) {
      const items = g.items || [];
      let html = '<div class="ss-group" data-group="' + esc(path) + '">';
      if (!items.length) html += '<span class="ss-always">always (no conditions)</span>';
      else html += '<span class="ss-group-op"><select class="ss-select" data-gf="op" aria-label="Combine conditions"><option value="all"' + (g.op !== 'any' ? ' selected' : '') + '>all</option><option value="any"' + (g.op === 'any' ? ' selected' : '') + '>any</option></select> of these are true:</span>';
      items.forEach((c, k) => {
        const p = path + '.' + k;
        if (isObj(c.group)) html += '<div class="ss-cond ss-cond-group">' + groupHtml(c.group, p + '.group') + '<button type="button" class="ss-icon-btn" data-act="del-cond" data-path="' + esc(p) + '" aria-label="Remove group">✕</button></div>';
        else html += condHtml(c, p);
      });
      html += '<div class="ss-btn-row"><button type="button" class="ss-add-btn" data-act="add-cond" data-path="' + esc(path) + '">+ Condition</button><button type="button" class="ss-add-btn" data-act="add-group" data-path="' + esc(path) + '">+ Group</button></div></div>';
      return html;
    }

    function operandHtml(op, side, p) {
      op = op || { kind: side === 'left' ? 'answer' : 'value' };
      const kinds = side === 'left' ? [['answer', 'answer to'], ['var', 'variable'], ['score', 'score'], ['page', 'page number'], ['expr', 'formula']] : [['value', 'value'], ['answer', 'answer to'], ['var', 'variable'], ['score', 'score'], ['expr', 'formula']];
      let html = '<select class="ss-select ss-op-kind" data-of="' + side + '.kind" data-path="' + esc(p) + '" aria-label="' + side + ' operand type">' + kinds.map(([k, l]) => '<option value="' + k + '"' + (op.kind === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
      if (op.kind === 'answer') html += '<select class="ss-select" data-of="' + side + '.ref" data-path="' + esc(p) + '" aria-label="Question">' + qOptions(op.ref) + '</select>';
      if (op.kind === 'var') html += '<select class="ss-select" data-of="' + side + '.name" data-path="' + esc(p) + '" aria-label="Variable">' + varOptions(op.name) + '</select>';
      if (op.kind === 'expr') html += '<input class="ss-input is-mono" data-of="' + side + '.expr" data-path="' + esc(p) + '" value="' + esc(op.expr || '') + '" placeholder="formula" aria-label="Formula">';
      return html;
    }
    function valueInput(c, p) {
      const left = c.left || {};
      const q = left.kind === 'answer' ? doc().elements[left.ref] : null;
      const kind = q ? Logic.valueKind(q) : null;
      const val = c.right && c.right.kind === 'value' ? c.right.value : '';
      if (q && (kind === 'choice' || kind === 'multi')) {
        const choices = Logic.choicesOf(doc(), q);
        return '<select class="ss-select" data-of="right.value" data-path="' + esc(p) + '" aria-label="Value">' + '<option value="">Choose…</option>' +
          choices.map(ch => '<option value="' + esc(ch.value) + '"' + (String(ch.value) === String(val) ? ' selected' : '') + '>' + esc(ch.label || ch.value) + '</option>').join('') + '</select>';
      }
      return '<input class="ss-input" data-of="right.value" data-path="' + esc(p) + '" value="' + esc(val) + '" placeholder="value" aria-label="Value"' + (kind === 'number' ? ' inputmode="decimal"' : '') + '>';
    }
    function condHtml(c, p) {
      const cmp = Logic.CMP[c.cmp] ? c.cmp : 'eq';
      let html = '<div class="ss-cond">' + operandHtml(c.left, 'left', p) +
        '<select class="ss-select ss-cmp" data-of="cmp" data-path="' + esc(p) + '" aria-label="Comparison">' + Object.keys(Logic.CMP).map(k => '<option value="' + k + '"' + (k === cmp ? ' selected' : '') + '>' + esc(Logic.CMP[k].label) + '</option>').join('') + '</select>';
      if (!Logic.CMP[cmp].unary) {
        const right = c.right || { kind: 'value' };
        html += right.kind === 'value' ? '<span class="ss-op-right"><select class="ss-select ss-op-kind" data-of="right.kind" data-path="' + esc(p) + '" aria-label="Compare with"><option value="value" selected>value</option><option value="answer">answer to</option><option value="var">variable</option><option value="score">score</option><option value="expr">formula</option></select>' + valueInput(c, p) + '</span>'
          : '<span class="ss-op-right">' + operandHtml(right, 'right', p) + '</span>';
      }
      return html + '<button type="button" class="ss-icon-btn" data-act="del-cond" data-path="' + esc(p) + '" aria-label="Remove condition">✕</button></div>';
    }

    function actionHtml(a, list, j, trig) {
      const def = Logic.ACTIONS[a.type] || {};
      const event = trig.type !== 'always';
      const types = Object.keys(Logic.ACTIONS).filter(k => event || Logic.ACTIONS[k].state || k === a.type);
      let html = '<div class="ss-action" data-list="' + list + '" data-index="' + j + '"><select class="ss-select" data-af="type" aria-label="Action">' +
        types.map(k => '<option value="' + k + '"' + (k === a.type ? ' selected' : '') + '>' + esc(Logic.ACTIONS[k].label) + '</option>').join('') + '</select>';
      if (def.target === 'page') html += '<select class="ss-select" data-af="target" aria-label="Page">' + pageOptions(a.target) + '</select>';
      else if (def.target === 'question') html += '<select class="ss-select" data-af="target" aria-label="Question">' + qOptions(a.target) + '</select>';
      else if (def.target === 'text') html += '<select class="ss-select" data-af="target" aria-label="Text element">' + elementOptions(a.target, e => Core.isTextType(e.type)) + '</select>';
      else if (def.target) html += '<select class="ss-select" data-af="target" aria-label="Element">' + elementOptions(a.target) + '</select>';
      if (def.path) html += '<select class="ss-select" data-af="path" aria-label="Property">' + Logic.SETTABLE.map(([p, l]) => '<option value="' + p + '"' + (p === a.path ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
      if (def.variable) html += '<select class="ss-select" data-af="name" aria-label="Variable">' + varOptions(a.name) + '</select><span class="ss-kw-sm">to</span><input class="ss-input is-mono" data-af="expr" value="' + esc(a.expr || '') + '" placeholder="formula, e.g. total + 1" aria-label="Formula">';
      if (def.value && !def.variable) {
        const isColor = def.path && /fill|color|Color/.test(a.path || '');
        html += '<input class="ss-input" data-af="value" value="' + esc(a.value === undefined ? '' : a.value) + '" placeholder="' + (a.type === 'complete' || a.type === 'message' ? 'Message (use {{score}} etc.)' : a.type === 'openUrl' ? 'https://…' : 'value') + '" aria-label="Value">';
        if (isColor) html += '<button type="button" class="ss-swatch ss-swatch-sm" data-act="pick-color" style="--c:' + esc(resolve(a.value)) + '" aria-label="Pick colour"></button>';
      }
      return html + '<button type="button" class="ss-icon-btn" data-act="del-action" aria-label="Remove action">✕</button></div>';
    }
    function resolve(v) { return String(v || '').replace(/var\(--sv-(\w+)\)/g, (m, k) => doc().theme.tokens[k] || ''); }

    /* ── Path helpers for nested conditions ── */
    function getGroup(rule, path) {
      // path like "when" or "when.2.group"
      const parts = path.split('.');
      let cur = rule.when;
      for (let i = 1; i < parts.length; i += 2) cur = cur.items[Number(parts[i])].group;
      return cur;
    }
    function getCond(rule, path) {
      const parts = path.split('.');
      const g = getGroup(rule, parts.slice(0, -1).join('.'));
      return { group: g, index: Number(parts[parts.length - 1]), cond: g.items[Number(parts[parts.length - 1])] };
    }

    /* ── Events ──────────────────────────── */
    function ruleIdOf(el) { const card = el.closest('[data-rule]'); return card ? card.dataset.rule : null; }

    container.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const act = b.dataset.act, rid = ruleIdOf(b);
      if (b.dataset.preset) { addPreset(b.dataset.preset); closeMenu(); return; }
      switch (act) {
        case 'new-menu': openMenu(b); return;
        case 'add-var': edit('Add variable', (rules, vars) => { let n = vars.length + 1; while (vars.some(v => v.name === 'var' + n)) n++; vars.push({ id: Core.uid('var'), name: 'var' + n, type: 'number', initial: 0, formula: '' }); }); return;
        case 'del-var': { const vid = b.closest('[data-var]').dataset.var; edit('Delete variable', (rules, vars) => { const i = vars.findIndex(v => v.id === vid); if (i !== -1) vars.splice(i, 1); }); return; }
        default: break;
      }
      if (!rid) return;
      switch (act) {
        case 'up': case 'down': edit('Move rule', rules => { const i = rules.findIndex(r => r.id === rid), j = i + (act === 'up' ? -1 : 1); if (j < 0 || j >= rules.length) return; const [r] = rules.splice(i, 1); rules.splice(j, 0, r); }); break;
        case 'dup': edit('Duplicate rule', rules => { const i = rules.findIndex(r => r.id === rid); const c = clone(rules[i]); c.id = Core.uid('rule'); c.name = rules[i].name + ' (copy)'; rules.splice(i + 1, 0, c); }); break;
        case 'del': if (confirm('Delete this rule?')) edit('Delete rule', rules => { const i = rules.findIndex(r => r.id === rid); rules.splice(i, 1); }); break;
        case 'json': if (jsonOpen.has(rid)) jsonOpen.delete(rid); else jsonOpen.add(rid); render(); break;
        case 'json-apply': {
          const ta = b.closest('[data-rule]').querySelector('textarea');
          const err = b.closest('[data-rule]').querySelector('[data-json-err]');
          let v; try { v = JSON.parse(ta.value); } catch (x) { err.textContent = 'Not valid JSON: ' + x.message; return; }
          const test = Core.normalizeDoc({ pages: [{ id: 'p', children: [] }], rules: [v] });
          const cleanRule = Object.assign(test.doc.rules[0], { id: rid });
          edit('Edit rule JSON', rules => { const i = rules.findIndex(r => r.id === rid); rules[i] = cleanRule; });
          jsonOpen.delete(rid); render();
          break;
        }
        case 'add-cond': edit('Add condition', rules => { const g = getGroup(ruleById(rules, rid), b.dataset.path); const q = questions()[0]; g.items.push({ id: Core.uid('c'), left: { kind: 'answer', ref: q ? q.id : '' }, cmp: 'eq', right: { kind: 'value', value: '' } }); }); break;
        case 'add-group': edit('Add group', rules => { const g = getGroup(ruleById(rules, rid), b.dataset.path); g.items.push({ id: Core.uid('g'), group: { op: 'any', items: [] } }); }); break;
        case 'del-cond': edit('Remove condition', rules => { const { group, index } = getCond(ruleById(rules, rid), b.dataset.path); group.items.splice(index, 1); }); break;
        case 'add-action': edit('Add action', rules => { const r = ruleById(rules, rid); const list = b.dataset.list; r[list] = r[list] || []; const ev = r.trigger && r.trigger.type !== 'always'; r[list].push(ev ? { type: 'goto', target: '' } : { type: 'show', target: '' }); }); break;
        case 'del-action': { const a = b.closest('.ss-action'); edit('Remove action', rules => { const r = ruleById(rules, rid); r[a.dataset.list].splice(Number(a.dataset.index), 1); }); break; }
        case 'pick-color': {
          const a = b.closest('.ss-action');
          if (opts.openColor) opts.openColor(b, '', v => edit('Change rule value', rules => { ruleById(rules, rid)[a.dataset.list][Number(a.dataset.index)].value = v; }));
          break;
        }
        default: break;
      }
    });

    container.addEventListener('change', e => {
      const t = e.target;
      const rid = ruleIdOf(t);
      const varRow = t.closest('[data-var]');
      if (varRow && t.dataset.vf) {
        const vid = varRow.dataset.var, k = t.dataset.vf;
        edit('Edit variable', (rules, vars) => {
          const v = vars.find(x => x.id === vid);
          if (!v) return;
          if (k === 'name') {
            const name = t.value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || v.name;
            if (vars.some(x => x !== v && x.name === name)) { if (opts.notify) opts.notify('A variable called "' + name + '" already exists.', 'error'); return; }
            // rename references in rules
            rules.forEach(r => { const s = JSON.stringify(r); if (s.indexOf('"name":"' + v.name + '"') !== -1) Object.assign(r, JSON.parse(s.split('"name":"' + v.name + '"').join('"name":"' + name + '"'))); });
            v.name = name;
          } else if (k === 'initial') v.initial = v.type === 'number' ? (Number(t.value) || 0) : (v.type === 'boolean' ? /^(true|1|yes)$/i.test(t.value) : t.value);
          else v[k] = t.value;
        });
        return;
      }
      if (!rid) return;
      if (t.dataset.rf) {
        const k = t.dataset.rf;
        edit('Edit rule', rules => {
          const r = ruleById(rules, rid);
          if (k === 'enabled') r.enabled = t.checked;
          else if (k === 'name') r.name = t.value.slice(0, 200) || r.name;
          else if (k === 'trigger') {
            r.trigger = { type: t.value };
            if (t.value === 'pageExit' || t.value === 'pageEnter') r.trigger.page = store.pageId;
            if (t.value === 'click') { const btn = Object.values(doc().elements).find(x => x.type === 'button'); r.trigger.element = btn ? btn.id : ''; }
          } else if (k === 'trigger.page') r.trigger.page = t.value;
          else if (k === 'trigger.element') r.trigger.element = t.value;
        });
        return;
      }
      if (t.dataset.gf === 'op') { const path = t.closest('[data-group]').dataset.group; edit('Edit conditions', rules => { getGroup(ruleById(rules, rid), path).op = t.value; }); return; }
      if (t.dataset.of) {
        const path = t.dataset.path;
        edit('Edit condition', rules => {
          const { cond } = getCond(ruleById(rules, rid), path);
          const [side, field] = t.dataset.of.split('.');
          if (side === 'cmp') { cond.cmp = t.value; return; }
          cond[side] = cond[side] || {};
          if (field === 'kind') cond[side] = { kind: t.value };
          else if (field === 'value') cond[side].value = /^-?\d+(\.\d+)?$/.test(t.value) ? Number(t.value) : t.value;
          else cond[side][field] = t.value;
          if (side === 'left' && field === 'ref') cond.right = { kind: 'value', value: '' };
        });
        return;
      }
      if (t.dataset.af) {
        const a = t.closest('.ss-action');
        const k = t.dataset.af;
        edit('Edit action', rules => {
          const r = ruleById(rules, rid);
          const act = r[a.dataset.list][Number(a.dataset.index)];
          if (k === 'type') { const keep = act.target; r[a.dataset.list][Number(a.dataset.index)] = { type: t.value, target: (Logic.ACTIONS[t.value] || {}).target === (Logic.ACTIONS[act.type] || {}).target ? keep : '' }; if (t.value === 'setProp') r[a.dataset.list][Number(a.dataset.index)].path = 'style.fill'; }
          else if (k === 'value') act.value = /^-?\d+(\.\d+)?$/.test(t.value) && act.type !== 'setText' && act.type !== 'message' && act.type !== 'complete' ? Number(t.value) : t.value;
          else act[k] = t.value;
        });
      }
    });

    let menu = null;
    function openMenu(anchor) {
      closeMenu();
      menu = document.createElement('div');
      menu.className = 'ss-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = presetButtons().replace(/ss-chip-btn/g, 'ss-menu-item');
      anchor.parentNode.appendChild(menu);
      menu.querySelector('button').focus();
      setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    }
    function outside(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
    function closeMenu() { if (menu) { menu.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); } }

    function addPreset(kind) {
      const qs = questions();
      const choiceQ = qs.find(q => ['choice', 'multi'].includes(Logic.valueKind(q)) && q.type !== 'dropdown') || qs[0];
      const other = qs.find(q => choiceQ && q.id !== choiceQ.id);
      const firstVal = choiceQ ? (Logic.choicesOf(doc(), choiceQ)[0] || {}).value : '';
      const pages = doc().pages;
      const rule = { id: Core.uid('rule'), name: 'Rule ' + (doc().rules.length + 1), enabled: true, trigger: { type: 'always' }, when: { op: 'all', items: [] }, then: [], else: [] };
      const cond = choiceQ ? [{ id: Core.uid('c'), left: { kind: 'answer', ref: choiceQ.id }, cmp: 'eq', right: { kind: 'value', value: firstVal === undefined ? '' : firstVal } }] : [];
      if (kind === 'show') { rule.name = 'Show a follow-up question'; rule.when.items = cond; rule.then = [{ type: 'show', target: other ? other.id : '' }]; }
      else if (kind === 'skip') { rule.name = 'Branch to a page'; rule.trigger = { type: 'pageExit', page: choiceQ ? (Core.pageOf(doc(), choiceQ.id) || pages[0]).id : pages[0].id }; rule.when.items = cond; rule.then = [{ type: 'goto', target: pages[pages.length - 1].id }]; }
      else if (kind === 'style') {
        const opt = choiceQ ? Core.questionParts(doc(), choiceQ.id, 'option')[0] : null;
        rule.name = 'Highlight when chosen'; rule.when.items = cond; rule.then = [{ type: 'setProp', target: choiceQ ? choiceQ.id : '', path: 'style.fill', value: 'var(--sv-tealLight)' }];
        void opt;
      } else if (kind === 'score') { rule.name = 'End early on a high score'; rule.trigger = { type: 'pageExit', page: 'any' }; rule.when.items = [{ id: Core.uid('c'), left: { kind: 'score' }, cmp: 'gte', right: { kind: 'value', value: 10 } }]; rule.then = [{ type: 'complete', value: 'Thanks! Your score was {{score}}.' }]; }
      focusRule = rule.id;
      edit('Add rule', rules => { rules.push(rule); });
    }

    const off = store.on((type, info) => { if (type === 'change' && !selfEdit && (info.logic || info.structure || info.undo || info.redo || info.ids.size)) render(); });
    render();
    return { render, focus(id) { focusRule = id; render(); }, destroy() { off(); closeMenu(); } };
  }

  root.SurveyLogicUI = { create };
})(typeof window !== 'undefined' ? window : this);
