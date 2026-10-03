/* ══════════════════════════════════════════════
   survey-runtime.js — a survey that people answer

   Used by Preview/Test mode in the editor and by the published survey
   (public/survey.html), so both behave identically. It owns the answers,
   runs the logic engine (SurveyLogic) after every change, validates pages,
   navigates (including branching and skipped pages) and hands the finished
   response to opts.onSubmit.

   SurveyRuntime.mount(host, doc, {
     mode: 'preview' | 'live',
     onSubmit(payload) → Promise,     // final response
     onProgress(payload) → Promise,   // optional, after each page
     onDebug(info),                   // preview: answers, variables, rules…
     onPageChange(page)
   }) → { reset(), goTo(pageId), getAnswers(), destroy() }
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore, Logic = root.SurveyLogic, Render = root.SurveyRender;
  const { num, isObj, isQuestionType } = Core;

  function mount(host, inputDoc, opts) {
    opts = opts || {};
    const doc = Core.normalizeDoc(inputDoc).doc;
    const keepHidden = !!doc.settings.keepHiddenAnswers;
    let answers = {};
    let varState = {};
    let visOverride = {};
    let touched = new Set();
    let errors = {};
    let attempted = new Set();      // pages the respondent tried to leave
    let history = [];
    let pageIndex = 0;
    let state = null;
    let overrides = {};             // id → element with setProp/setText applied
    let overrideSig = {};
    let rankOrder = {};
    let tabs = {};
    let finished = false;
    let busy = false;
    let startedAt = new Date().toISOString();
    let eventsLog = [];
    let message = null;
    const textDeps = new Set();     // elements whose text uses {{ }}

    // DOM scaffolding
    host.innerHTML = '';
    const run = document.createElement('div');
    run.className = 'sv-run sv-run-' + (opts.mode || 'live');
    const banner = document.createElement('div');
    banner.className = 'sv-run-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    const stage = document.createElement('div');
    stage.className = 'sv-stage';
    const scaler = document.createElement('div');
    scaler.className = 'sv-scaler';
    stage.appendChild(scaler);
    const announcer = document.createElement('div');
    announcer.className = 'sv-sr-only';
    announcer.setAttribute('aria-live', 'polite');
    run.appendChild(banner);
    run.appendChild(stage);
    run.appendChild(announcer);
    host.appendChild(run);

    const live = {
      getEl: id => overrides[id] || doc.elements[id],
      text: el => {
        const raw = state && state.text[el.id] !== undefined ? state.text[el.id] : String(el.props.text === undefined ? '' : el.props.text);
        if (raw.indexOf('{{') !== -1) textDeps.add(el.id);
        return state ? Logic.interpolate(raw, state.env) : raw;
      },
      bindOption, bindField, bindRankItem, bindMatrixCell,
      buttonLabel, onButton,
      progress: progressPct,
      tabActive: el => (tabs[el.id] !== undefined ? tabs[el.id] : Math.max(0, num(el.props.active, 0))),
      setTab: (el, i) => { tabs[el.id] = i; renderer.refresh([el.id]); applyState(); const b = renderer.node(el.id) && renderer.node(el.id).querySelector('[data-tab-index="' + i + '"]'); if (b) b.focus(); }
    };

    const renderer = Render.create(scaler, doc, { mode: 'live', live, onLayout: fit });
    renderer.root.classList.add('sv-live');

    /* ── Sizing (scale / reflow / fixed) ─────── */
    let ro = null;
    function fit() {
      const avail = run.clientWidth || host.clientWidth || doc.settings.width;
      const width = num(doc.settings.width, 760);
      const narrow = avail < num(doc.settings.reflowBelow, 640);
      renderer.root.classList.toggle('sv-narrow', narrow);
      renderer.root.classList.toggle('sv-wide', !narrow);
      const reflow = doc.settings.responsive === 'reflow' && narrow;
      renderer.root.classList.toggle('sv-reflow', reflow);
      let s = 1;
      if (reflow) { renderer.artboard.style.width = Math.max(240, avail) + 'px'; }
      else {
        renderer.artboard.style.width = width + 'px';
        if (doc.settings.responsive !== 'fixed') s = Math.min(1, avail / width);
      }
      scaler.style.transform = s === 1 ? '' : 'scale(' + s + ')';
      scaler.style.width = (reflow ? avail : width) + 'px';
      const hgt = renderer.artboard.offsetHeight;
      stage.style.height = Math.ceil(hgt * s) + 'px';
      stage.style.width = Math.ceil((reflow ? avail : width) * s) + 'px';
    }
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => fit()); ro.observe(run); }
    else window.addEventListener('resize', fit);

    /* ── State ───────────────────────────────── */
    const page = () => doc.pages[pageIndex];
    function pageQuestions(pid) {
      const p = Core.getPage(doc, pid);
      if (!p) return [];
      return Core.descendants(doc, 'page:' + p.id).map(id => doc.elements[id]).filter(el => el && isQuestionType(el.type));
    }
    function recompute() {
      state = Logic.computeState(doc, { answers, varState, visOverride, pageIndex });
      // property / text overrides from rules
      const next = {};
      const changed = [];
      const ids = new Set(Object.keys(state.props).concat(Object.keys(overrideSig)));
      ids.forEach(id => {
        const sig = JSON.stringify(state.props[id] || null);
        if (sig !== (overrideSig[id] || 'null')) changed.push(id);
        if (state.props[id]) {
          const el = Core.clone(doc.elements[id]);
          if (!el) return;
          Object.keys(state.props[id]).forEach(path => Core.setPath(el, path, state.props[id][path]));
          next[id] = el;
          overrideSig[id] = sig;
        } else delete overrideSig[id];
      });
      overrides = next;
      return changed;
    }

    let applyQueued = false;
    function scheduleApply(changedIds) {
      if (changedIds && changedIds.length) pendingRefresh.push.apply(pendingRefresh, changedIds);
      if (applyQueued) return;
      applyQueued = true;
      requestAnimationFrame(() => { applyQueued = false; const ids = pendingRefresh.splice(0); if (ids.length) renderer.refresh(ids.filter(id => renderer.node(id))); applyState(); });
    }
    const pendingRefresh = [];

    function applyState() {
      if (!state || finished) return;
      const nodes = renderer.nodes();
      nodes.forEach((node, id) => {
        const el = live.getEl(id);
        if (!el) return;
        const vis = state.isVisible(id);
        if (el.type === 'qerror') {
          const q = Core.questionOf(doc, id);
          node.classList.toggle('sv-off', !(vis && q && errors[q.id]));
          return;
        }
        node.classList.toggle('sv-off', !vis);
        const dis = state.isDisabled(id);
        node.classList.toggle('is-disabled', dis);
        if (isQuestionType(el.type)) {
          node.classList.toggle('is-required', state.isRequired(id));
          node.querySelectorAll('input, select, textarea, button.sv-rank-btn').forEach(i => { i.disabled = dis; });
          const err = errors[id];
          node.classList.toggle('is-invalid', !!err);
          node.querySelectorAll('.sv-control, .sv-native').forEach(i => { if (err) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); });
          showError(el, err);
        }
        if (el.type === 'qtitle') {
          const q = Core.questionOf(doc, id);
          node.classList.toggle('is-required', !!(q && state.isRequired(q.id)));
        }
        if (el.type === 'button') {
          const lab = node.querySelector('.sv-text');
          if (lab) lab.textContent = buttonLabel(el);
          const a = el.props.action || {};
          const hide = a.type === 'back' && (!history.length || doc.settings.allowBack === false) && el.props.autoHide !== false;
          if (hide) node.classList.add('sv-off');
          node.disabled = dis || busy;
        }
        if (el.type === 'progress') {
          const pct = progressPct();
          const fill = node.querySelector('.sv-progress-fill'); if (fill) fill.style.width = pct + '%';
          node.setAttribute('aria-valuenow', String(Math.round(pct)));
          const lab = node.querySelector('.sv-progress-label'); if (lab) lab.textContent = Math.round(pct) + '%';
        }
      });
      // texts that depend on answers / variables
      const textIds = Array.from(textDeps).filter(id => nodes.has(id));
      textIds.forEach(id => {
        const el = live.getEl(id); const n = nodes.get(id);
        const inner = n && n.querySelector('.sv-text');
        if (!inner) return;
        if (el.type === 'richtext') inner.innerHTML = Core.sanitizeHtml(live.text(el)); else if (el.type !== 'qtitle') inner.textContent = live.text(el);
        else { const sr = inner.querySelector('.sv-req-sr'); inner.textContent = live.text(el); if (sr) inner.appendChild(sr); }
      });
      Object.keys(state.text).forEach(id => {
        if (textDeps.has(id) || !nodes.has(id)) return;
        const inner = nodes.get(id).querySelector('.sv-text');
        if (inner) inner.textContent = state.text[id];
      });
      renderer.layout();
      debug();
    }

    function showError(q, err) {
      const errEl = Core.questionParts(doc, q.id, 'qerror')[0];
      const node = renderer.node(q.id);
      if (!node) return;
      let target = errEl ? renderer.node(errEl.id) : node.querySelector(':scope > .sv-fallback-error');
      if (!target && err) {
        target = document.createElement('div');
        target.className = 'sv-fallback-error';
        target.setAttribute('role', 'alert');
        target.id = renderer.errorIdOf(q.id);
        node.appendChild(target);
      }
      if (!target) return;
      const text = target.classList.contains('sv-fallback-error') ? target : target.querySelector('.sv-text');
      text.textContent = err || '';
      target.classList.toggle('is-shown', !!err);
      if (errEl) target.classList.toggle('sv-off', !(err && state.isVisible(q.id)));
    }

    /* ── Answers ─────────────────────────────── */
    function setAnswer(qid, value, opt) {
      const q = doc.elements[qid];
      const v = Logic.normalizeAnswer(doc, q, value);
      if (Logic.isEmptyValue(v)) delete answers[qid]; else answers[qid] = v;
      touched.add(qid);
      const changed = recompute();
      runOnce();
      if (errors[qid] !== undefined || attempted.has(page().id)) {
        const e = Logic.validateAnswer(doc, q, answers[qid], state, { patterns: true });
        if (e) errors[qid] = e; else delete errors[qid];
      }
      if (!(opt && opt.noSync)) syncQuestion(qid);
      scheduleApply(changed);
      if (opts.mode === 'preview') log('answer', (Core.dataKeyOf(doc, q)) + ' = ' + JSON.stringify(answers[qid] === undefined ? null : answers[qid]));
    }
    // Reflects an answer in the DOM (checked classes, inputs).
    function syncQuestion(qid) {
      const q = doc.elements[qid];
      const v = answers[qid];
      const kind = Logic.valueKind(q);
      if (kind === 'choice' || kind === 'multi') {
        const opts2 = Core.questionParts(doc, qid, 'option');
        let fillIdx = -1;
        if (q.props.fillUpTo && kind === 'choice' && v !== undefined) fillIdx = opts2.findIndex(o => String(o.props.value) === String(v));
        opts2.forEach((o, i) => {
          const n = renderer.node(o.id);
          if (!n) return;
          const on = kind === 'multi' ? Array.isArray(v) && v.some(x => String(x) === String(o.props.value)) : v !== undefined && String(v) === String(o.props.value);
          n.classList.toggle('is-checked', on || (fillIdx >= 0 && i <= fillIdx));
          const input = n.querySelector('.sv-native');
          if (input) input.checked = on;
        });
      } else if (kind === 'matrix') {
        Core.questionParts(doc, qid, 'matrixrow').forEach(r => {
          const n = renderer.node(r.id); if (!n) return;
          const rv = r.props.value !== undefined && r.props.value !== '' ? r.props.value : Core.slug(r.props.label);
          n.querySelectorAll('.sv-matrix-cell').forEach(cell => {
            const input = cell.querySelector('.sv-native');
            const on = !!(v && input && String(v[String(rv)]) === input.value);
            if (input) input.checked = on;
            cell.classList.toggle('is-checked', on);
          });
        });
      }
    }

    function bindOption(q, opt, input, node) {
      const kind = Logic.valueKind(q);
      const val = opt.props.value;
      const cur = answers[q.id];
      input.checked = kind === 'multi' ? Array.isArray(cur) && cur.some(x => String(x) === String(val)) : cur !== undefined && String(cur) === String(val);
      input.addEventListener('change', () => {
        if (kind === 'multi') {
          let list = Array.isArray(answers[q.id]) ? answers[q.id].slice() : [];
          if (input.checked) {
            if (opt.props.exclusive) list = [];
            else {
              const exclusive = Core.questionParts(doc, q.id, 'option').filter(o => o.props.exclusive).map(o => String(o.props.value));
              list = list.filter(x => !exclusive.includes(String(x)));
            }
            list.push(val);
          } else list = list.filter(x => String(x) !== String(val));
          setAnswer(q.id, list);
        } else setAnswer(q.id, val);
      });
      // Clicking a selected rating star again clears it.
      if (q.type === 'rating') node.addEventListener('click', e => {
        if (e.target === input) return;
        if (answers[q.id] !== undefined && String(answers[q.id]) === String(val) && !q.behavior.required) { e.preventDefault(); setAnswer(q.id, null); }
      });
      requestAnimationFrame(() => syncQuestion(q.id));
    }

    function bindField(q, field, input, wrap) {
      const k = field.props.kind;
      const cur = answers[q.id];
      if (k === 'range') {
        if (cur === undefined) { input.value = String((num(field.props.min, 0) + num(field.props.max, 10)) / 2); input.dataset.empty = '1'; }
        else input.value = String(cur);
        renderer.syncRange(wrap);
        input.addEventListener('input', () => { input.dataset.empty = ''; renderer.syncRange(wrap); setAnswer(q.id, Number(input.value), { noSync: true }); });
        input.setAttribute('aria-valuetext', cur === undefined ? 'Not answered' : String(cur));
        input.addEventListener('change', () => input.setAttribute('aria-valuetext', String(input.value)));
      } else {
        input.value = cur === undefined || cur === null ? '' : String(cur);
        const ev = k === 'select' || k === 'date' || k === 'time' ? 'change' : 'input';
        input.addEventListener(ev, () => {
          const raw = input.value;
          setAnswer(q.id, k === 'number' ? (raw === '' ? null : Number(raw)) : (raw === '' ? null : raw), { noSync: true });
        });
        input.addEventListener('blur', () => { if (touched.has(q.id)) { const e = Logic.validateAnswer(doc, q, answers[q.id], state, { patterns: true }); if (e) errors[q.id] = e; else delete errors[q.id]; scheduleApply(); } });
      }
      if (field.props.maxLength) input.maxLength = num(field.props.maxLength, 0);
      if (q.behavior && q.behavior.readOnly) input.readOnly = true;
    }

    function rankItems(q) { return Core.questionParts(doc, q.id, 'rankitem'); }
    function currentRank(q) {
      const items = rankItems(q);
      if (!rankOrder[q.id]) {
        const ans = answers[q.id];
        rankOrder[q.id] = Array.isArray(ans)
          ? ans.map(v => (items.find(i => String(i.props.value) === String(v)) || {}).id).filter(Boolean)
          : items.map(i => i.id);
        items.forEach(i => { if (!rankOrder[q.id].includes(i.id)) rankOrder[q.id].push(i.id); });
      }
      return rankOrder[q.id];
    }
    function applyRank(q, commit) {
      const order = currentRank(q);
      const firstNode = renderer.node(order[0]);
      const hostNode = firstNode && firstNode.parentNode;
      order.forEach((id, i) => { const n = renderer.node(id); if (!n) return; if (hostNode && n.parentNode === hostNode) hostNode.appendChild(n); const pos = n.querySelector('.sv-rank-pos'); if (pos) pos.textContent = String(i + 1); });
      if (commit) setAnswer(q.id, order.map(id => doc.elements[id].props.value !== undefined && doc.elements[id].props.value !== '' ? doc.elements[id].props.value : Core.slug(doc.elements[id].props.label)));
    }
    function bindRankItem(q, item, node, up, down) {
      const move = d => {
        const order = currentRank(q);
        const i = order.indexOf(item.id), j = i + d;
        if (i < 0 || j < 0 || j >= order.length) return;
        order.splice(i, 1); order.splice(j, 0, item.id);
        applyRank(q, true);
        (d < 0 ? up : down).focus();
        announce((item.props.label || 'Item') + ' moved to position ' + (j + 1));
      };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      node.addEventListener('keydown', e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(e.key === 'ArrowUp' ? -1 : 1); } });
      // Pointer drag to reorder
      const handle = node.querySelector('.sv-rank-handle');
      if (handle) handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        const hostNode = node.parentNode;
        node.classList.add('is-dragging');
        handle.setPointerCapture(e.pointerId);
        const onMove = ev => {
          const order = currentRank(q);
          const others = order.filter(id => id !== item.id).map(id => renderer.node(id)).filter(Boolean);
          let idx = others.findIndex(o => { const r = o.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
          if (idx === -1) idx = others.length;
          const ids = others.map(o => o.dataset.svid);
          ids.splice(idx, 0, item.id);
          rankOrder[q.id] = ids;
          applyRank(q, false);
        };
        const onUp = () => { node.classList.remove('is-dragging'); handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); applyRank(q, true); };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        void hostNode;
      });
      requestAnimationFrame(() => applyRank(q, false));
    }

    function bindMatrixCell(q, row, col, input, cell) {
      const rv = row.props.value !== undefined && row.props.value !== '' ? row.props.value : Core.slug(row.props.label);
      const cv = col.value !== undefined && col.value !== '' ? col.value : Core.slug(col.label);
      const cur = answers[q.id];
      input.checked = !!(cur && String(cur[String(rv)]) === String(cv));
      cell.classList.toggle('is-checked', input.checked);
      input.addEventListener('change', () => {
        const next = Object.assign({}, isObj(answers[q.id]) ? answers[q.id] : {});
        next[String(rv)] = cv;
        setAnswer(q.id, next);
      });
    }

    /* ── Buttons & navigation ───────────────── */
    function predictNextIndex() {
      const effects = Logic.runEvent(doc, { type: 'pageExit', page: page().id }, state);
      for (const e of effects) {
        if (e.type === 'goto') { const i = doc.pages.findIndex(p => p.id === e.target); if (i >= 0) return i; }
        if (e.type === 'complete' || e.type === 'submit') return -1;
      }
      return nextVisibleIndex(pageIndex);
    }
    function nextVisibleIndex(from) {
      for (let i = from + 1; i < doc.pages.length; i++) {
        const p = doc.pages[i];
        if (p.props && p.props.ending) continue;
        if (state.pageVisible[p.id] === false) continue;
        return i;
      }
      return -1;
    }
    function buttonLabel(el) {
      if (el.props.text) return state ? Logic.interpolate(el.props.text, state.env) : el.props.text;
      const a = el.props.action || {};
      if (a.type === 'auto') {
        if (!state) return doc.settings.nextLabel || 'Next';
        const n = predictNextIndex();
        return n === -1 || (doc.pages[n] && doc.pages[n].props && doc.pages[n].props.ending) ? (doc.settings.submitLabel || 'Submit') : (doc.settings.nextLabel || 'Next');
      }
      return renderer ? renderer.defaultButtonLabel(el) : 'Button';
    }
    function onButton(el) {
      if (busy || finished) return;
      if (state.isDisabled(el.id)) return;
      const effects = Logic.runEvent(doc, { type: 'click', element: el.id }, state);
      const a = el.props.action || {};
      const navTaken = applyEffects(effects, 'click');
      if (navTaken) return;
      switch (a.type) {
        case 'auto': case 'next': next(); break;
        case 'back': back(); break;
        case 'submit': next(true); break;
        case 'goto': { const i = doc.pages.findIndex(p => p.id === a.target); if (i >= 0 && validatePage()) go(i, true); break; }
        case 'url': openLink(a.target, a.where); break;
        default: break;
      }
    }

    // Applies event-rule effects. Returns true when it navigated.
    function applyEffects(effects, source) {
      let nav = false;
      for (const e of effects) {
        log('rule', (doc.rules.find(r => r.id === e.rule) || {}).name + ' → ' + (Logic.ACTIONS[e.type] ? Logic.ACTIONS[e.type].label : e.type));
        switch (e.type) {
          case 'setVar': varState[e.name] = e.result; break;
          case 'setAnswer': if (doc.elements[e.target]) { const q = doc.elements[e.target]; const v = Logic.normalizeAnswer(doc, q, e.value); if (Logic.isEmptyValue(v)) delete answers[e.target]; else answers[e.target] = v; } break;
          case 'show': visOverride[e.target] = true; break;
          case 'hide': visOverride[e.target] = false; break;
          case 'message': message = e.text; showBanner(e.text); break;
          case 'openUrl': openLink(e.text || e.value, e.where); break;
          case 'goto': if (!nav) { const i = doc.pages.findIndex(p => p.id === e.target); if (i >= 0) { nav = true; go(i, true); } } break;
          case 'next': if (!nav) { nav = true; next(); } break;
          case 'back': if (!nav) { nav = true; back(); } break;
          case 'submit': if (!nav) { nav = true; submit(null); } break;
          case 'complete': if (!nav) { nav = true; submit(e.text || null); } break;
          default: break;
        }
      }
      if (!nav) { const changed = recompute(); scheduleApply(changed); }
      return nav;
    }

    function validatePage() {
      const p = page();
      attempted.add(p.id);
      // ranking questions that weren't touched keep their shown order
      pageQuestions(p.id).forEach(q => { if (q.type === 'ranking' && answers[q.id] === undefined && state.isVisible(q.id)) { applyRank(q, false); answers[q.id] = Logic.normalizeAnswer(doc, q, currentRank(q).map(id => doc.elements[id].props.value)); } });
      recompute();
      let first = null;
      errors = {};
      pageQuestions(p.id).forEach(q => {
        if (!state.isVisible(q.id)) return;
        const e = Logic.validateAnswer(doc, q, answers[q.id], state, { patterns: true });
        if (e) { errors[q.id] = e; if (!first) first = q; }
      });
      applyState();
      if (first) {
        const n = renderer.node(first.id);
        const focusable = n && n.querySelector('input:not([disabled]), select, textarea, button');
        if (focusable) focusable.focus({ preventScroll: true });
        if (n && n.scrollIntoView) n.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const count = Object.keys(errors).length;
        announce(count === 1 ? 'One question needs your attention.' : count + ' questions need your attention.');
        log('validation', count + ' error(s) on ' + p.name);
        return false;
      }
      return true;
    }

    function next(forceSubmit) {
      if (busy || finished) return;
      if (!validatePage()) return;
      const effects = Logic.runEvent(doc, { type: 'pageExit', page: page().id }, state);
      if (applyEffects(effects, 'pageExit')) return;
      const n = forceSubmit ? -1 : nextVisibleIndex(pageIndex);
      progressSave();
      if (n === -1) submit(null);
      else go(n, true);
    }
    function back() {
      if (busy || finished || !history.length) return;
      const prev = history.pop();
      go(prev, false);
    }
    function go(i, push) {
      if (i === pageIndex && push) return;
      if (push) history.push(pageIndex);
      pageIndex = i;
      errors = {};
      const p = doc.pages[i];
      if (p.props && p.props.ending) { showPage(); submit(null, true); return; }
      showPage();
      const effects = Logic.runEvent(doc, { type: 'pageEnter', page: p.id }, state);
      if (effects.length) applyEffects(effects, 'pageEnter');
      announce(p.name + ', page ' + (visibleIndex() + 1) + ' of ' + visiblePageCount());
      if (opts.onPageChange) opts.onPageChange(p);
      scrollTop();
    }
    function showPage() {
      recompute();
      textDeps.clear();
      renderer.renderPage(page().id);
      Object.keys(answers).forEach(syncQuestion);
      applyState();
      fit();
    }
    function scrollTop() {
      const target = run.getBoundingClientRect();
      if (target.top < 0 && window.scrollBy) window.scrollBy({ top: target.top - 16, behavior: 'smooth' });
      const heading = renderer.artboard;
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
    function visiblePageCount() { return doc.pages.filter(p => !(p.props && p.props.ending) && (!state || state.pageVisible[p.id] !== false)).length || 1; }
    function visibleIndex() { return doc.pages.slice(0, pageIndex).filter(p => !(p.props && p.props.ending) && (!state || state.pageVisible[p.id] !== false)).length; }
    function progressPct() {
      if (finished) return 100;
      const total = visiblePageCount();
      return Math.max(0, Math.min(100, (visibleIndex() / total) * 100));
    }

    function payload(complete, outcome) {
      const out = {};
      Object.keys(answers).forEach(id => { if (keepHidden || state.isVisible(id)) out[id] = answers[id]; });
      const path = history.map(i => doc.pages[i].id).concat([page().id]);
      return { answers: out, path, complete: !!complete, startedAt, varState, outcome: outcome || message || null, score: state.score, vars: state.vars };
    }
    let progressTimer = null;
    function progressSave() {
      if (!opts.onProgress) return;
      clearTimeout(progressTimer);
      progressTimer = setTimeout(() => { Promise.resolve(opts.onProgress(payload(false))).catch(() => {}); }, 300);
    }

    async function submit(outcome, onEndingPage) {
      if (busy || finished) return;
      const effects = Logic.runEvent(doc, { type: 'submit' }, state);
      for (const e of effects) {
        if (e.type === 'setVar') varState[e.name] = e.result;
        if (e.type === 'complete' || e.type === 'message') outcome = e.text || outcome;
        if (e.type === 'openUrl') openLink(e.text || e.value, e.where);   // before any await, while the click still counts
      }
      recompute();
      busy = true;
      applyState();
      showBanner(opts.mode === 'preview' ? '' : 'Submitting…');
      clearTimeout(progressTimer);
      try {
        const result = opts.onSubmit ? await opts.onSubmit(payload(true, outcome)) : null;
        busy = false;
        finished = true;
        log('submit', 'Response submitted');
        if (onEndingPage) { showBanner(''); applyState(); renderer.nodes().forEach((n, id) => { const el = doc.elements[id]; if (el && el.type === 'button') n.classList.add('sv-off'); }); }
        else showComplete(outcome, result);
        debug();
      } catch (e) {
        busy = false;
        applyState();
        const problems = e && e.problems;
        if (problems && problems.length) {
          problems.forEach(p => { errors[p.question] = p.message; });
          applyState();
        }
        showBanner((e && e.message ? e.message : 'The response couldn\'t be submitted.') + ' Your answers are still here — try again.', true);
        pendingNav = null;         // stay, so the respondent can submit again
      }
      flushNav();
    }

    function showComplete(outcome) {
      showBanner('');
      renderer.artboard.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'sv-complete';
      box.innerHTML = '<div class="sv-complete-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><h2 class="sv-complete-title"></h2><p class="sv-complete-msg"></p>';
      box.querySelector('.sv-complete-title').textContent = Logic.interpolate(doc.settings.completionTitle || 'Thank you!', state.env);
      box.querySelector('.sv-complete-msg').textContent = outcome || Logic.interpolate(doc.settings.completionMessage || 'Your response has been recorded.', state.env);
      if (blockedLink) {
        const a = document.createElement('a');
        a.className = 'sv-complete-link'; a.href = blockedLink; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'Continue to ' + blockedLink.replace(/^mailto:/, '');
        box.appendChild(a);
      }
      renderer.artboard.appendChild(box);
      renderer.artboard.style.height = 'auto';
      fit();
      const t = box.querySelector('.sv-complete-title'); t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true });
      announce('Survey complete.');
    }

    // Opens a link from an "open link" block or a link button. Browsers only allow
    // new tabs right after a click or key press; when one is blocked, the link is
    // shown in the banner for the respondent to open.
    // where: 'new' (a new tab, the default) or 'same' (this tab — leaves the
    // survey; in the editor's preview it opens a new tab instead). The link is
    // always also shown in the message bar, so it can be clicked even if the
    // browser (or an embedded browser) blocks or swallows the new tab.
    function openLink(raw, where) {
      const link = Logic.linkOf(raw);   // also accepts "example.com"
      const u = link && link.indexOf('{{') === -1 ? Core.safeUrl(link, ['https', 'http', 'mailto']) : null;
      if (!u) { log('rule', 'Open link skipped — "' + String(raw || '') + '" isn\'t an http(s) or mailto link'); return; }
      if (where === 'same' && opts.mode !== 'preview') {
        log('rule', 'Open link in this tab ' + u);
        pendingNav = u;            // after any submission in progress has been saved
        setTimeout(flushNav, 0);
        return;
      }
      log('rule', 'Open link ' + u + (where === 'same' ? ' (in this tab on the real survey; a new tab in preview)' : ''));
      let w = null;
      try { w = window.open(u, '_blank'); } catch (err) { w = null; }
      if (w) { try { w.opener = null; } catch (err) { /* cross-origin */ } }
      else blockedLink = u;   // also offered on the completion screen if the survey ends now
      banner.textContent = '';
      banner.append(w ? 'Opened in a new tab: ' : 'Open this link: ');
      const a = document.createElement('a');
      a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = u.replace(/^mailto:/, '');
      banner.appendChild(a);
      banner.classList.add('is-shown'); banner.classList.remove('is-error');
    }
    // "When any answer changes" scripts: an open-link / message block runs when an answer
    // changes and it's reached (no condition, or its if is true) — once, not on every
    // keystroke; it runs again only after its condition has been false in between.
    let firedOnce = new Set();
    let blockedLink = null;
    let pendingNav = null;
    // Leaves the survey for a "this tab" link — never while a response is
    // being submitted, so the response is saved first.
    function flushNav() {
      if (!pendingNav || busy) return;
      const u = pendingNav;
      pendingNav = null;
      try { window.location.assign(u); } catch (err) { /* ignore */ }
    }
    function runOnce() {
      const now = new Set((state.once || []).map(o => o.key));
      firedOnce.forEach(k => { if (!now.has(k)) firedOnce.delete(k); });
      (state.once || []).forEach(o => {
        if (firedOnce.has(o.key)) return;
        firedOnce.add(o.key);
        if (o.type === 'openUrl') openLink(o.text, o.where);
        if (o.type === 'message') { message = o.text; showBanner(o.text); }
      });
    }
    function showBanner(text, isError) {
      banner.textContent = text || '';
      banner.classList.toggle('is-shown', !!text);
      banner.classList.toggle('is-error', !!isError);
    }
    function announce(text) { announcer.textContent = ''; setTimeout(() => { announcer.textContent = text; }, 30); }
    function log(kind, text) {
      if (opts.mode !== 'preview') return;
      eventsLog.push({ t: new Date().toLocaleTimeString(), kind, text });
      if (eventsLog.length > 200) eventsLog.shift();
    }
    function debug() {
      if (!opts.onDebug || !state) return;
      opts.onDebug({
        page: page(), pageIndex, path: history.map(i => doc.pages[i].name).concat([page().name]),
        answers: Object.keys(answers).map(id => ({ id, key: Core.dataKeyOf(doc, doc.elements[id]), label: Core.displayName(doc, doc.elements[id]), value: answers[id], visible: state.isVisible(id) })),
        vars: state.vars, score: state.score, fired: state.fired.map(id => (doc.rules.find(r => r.id === id) || {}).name), errors: Object.keys(errors).map(id => ({ label: Core.displayName(doc, doc.elements[id]), message: errors[id] })),
        log: eventsLog.slice(-60), finished
      });
    }

    function start() {
      answers = {}; varState = {}; visOverride = {}; touched = new Set(); errors = {}; attempted = new Set(); history = []; rankOrder = {}; tabs = {};
      finished = false; busy = false; message = null; eventsLog = []; startedAt = new Date().toISOString();
      recompute();
      blockedLink = null;
      firedOnce = new Set();   // nothing runs until the first answer
      pageIndex = doc.pages.findIndex(p => !(p.props && p.props.ending) && state.pageVisible[p.id] !== false);
      if (pageIndex < 0) pageIndex = 0;
      showBanner('');
      showPage();
      const effects = Logic.runEvent(doc, { type: 'pageEnter', page: page().id }, state);
      if (effects.length) applyEffects(effects, 'pageEnter');
      log('start', 'Survey started on ' + page().name);
      debug();
    }
    start();

    return {
      reset: start,
      goTo(pid) { const i = doc.pages.findIndex(p => p.id === pid); if (i >= 0) { finished = false; history = []; go(i, false); } },
      getAnswers: () => Core.clone(answers),
      element: () => run,
      fit,
      destroy() { if (ro) ro.disconnect(); else window.removeEventListener('resize', fit); clearTimeout(progressTimer); renderer.destroy(); run.remove(); }
    };
  }

  root.SurveyRuntime = { mount };
})(typeof window !== 'undefined' ? window : this);
