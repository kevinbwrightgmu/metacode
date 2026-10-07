/* ══════════════════════════════════════════════
   studio-tutorial.js — hands-on Survey Studio tutorial

   "Build your first survey": the tutorial makes a practice survey and walks
   through the whole workflow on it — name it, add and edit a question, make
   it required, add a follow-up, show the follow-up with logic, style it,
   try it on a phone, publish it and find the responses. Each step points at
   the control to use (tour.js spotlight, hands-on mode: the page stays
   usable), notices when it's done and moves on; any step can be skipped.
   On phones the side panels open by themselves when a step needs them.

   Started from "Learn Survey Studio" (the top bar's "Tutorial & tour", the
   editor's compass button), the first-visit card, the empty survey list or
   studio.html?tutorial=1. Progress is kept in localStorage, so a tutorial
   that was closed (or a page that was reloaded) can be resumed.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  const PROGRESS_KEY = 'metacode_tutorial_progress';
  const PRACTICE_TITLE = 'Untitled survey';
  const t = { surveyId: null, q1: null, q1Default: '', q2: null, base: null, rule: null, primary: null };

  const progress = {
    read() { try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'); } catch (e) { return null; } },
    write() { try { localStorage.setItem(PROGRESS_KEY, JSON.stringify({ surveyId: t.surveyId, q1: t.q1, q1Default: t.q1Default, q2: t.q2, rule: t.rule, primary: t.primary, step: Tour.running ? Tour.running.step : 0 })); } catch (e) { /* ignore */ } },
    clear() { try { localStorage.removeItem(PROGRESS_KEY); } catch (e) { /* ignore */ } }
  };

  /* ── Editor helpers ─────────────────────── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitUntil(fn, ms) {
    const end = Date.now() + (ms || 8000);
    while (Date.now() < end) { try { if (fn()) return true; } catch (e) { /* not yet */ } await sleep(60); }
    return false;
  }
  // (SurveyStudio is a top-level const in survey-studio.js, not a window property)
  const editor = () => (typeof SurveyStudio !== 'undefined' && SurveyStudio.current ? SurveyStudio.current() : null);
  const store = () => (editor() ? editor().store : null);
  const doc = () => (store() ? store().doc : null);
  const ready = () => !!(editor() && document.querySelector('.ss-modes') && doc() && doc().id === t.surveyId);
  const mode = () => { const b = document.querySelector('.ss-mode[aria-selected="true"]'); return b ? b.dataset.mode : null; };
  const questions = () => (doc() ? SurveyCore.questionsInOrder(doc()) : []);
  const app = () => document.querySelector('.ss-app');
  const isPhone = () => { const b = document.querySelector('.ss-drawer-left'); return !!b && getComputedStyle(b).display !== 'none'; };
  // Phones: open the side panel a step needs (and wait for it to slide in)
  async function drawer(side) {
    const a = app();
    if (!a) return;
    const want = side && isPhone() ? 'show-' + side : null;
    const had = a.classList.contains('show-left') ? 'show-left' : a.classList.contains('show-right') ? 'show-right' : null;
    if (had === want) return;
    a.classList.remove('show-left', 'show-right');
    if (want) a.classList.add(want);
    if (isPhone()) await sleep(360);
  }
  const plain = html => String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  const titlePart = id => (doc() && id && doc().elements[id] ? SurveyCore.questionParts(doc(), id, 'qtitle')[0] : null);

  // The practice survey: made once, reopened whenever a step needs the editor
  async function ensureEditor() {
    if (ready()) return true;
    if (!t.surveyId || !(await LocalDB.get('surveys', t.surveyId))) {
      const r = await SurveyStore.api('', { method: 'POST', body: { title: PRACTICE_TITLE } });
      t.surveyId = r.survey.id;
      Object.assign(t, { q1: null, q1Default: '', q2: null, rule: null, primary: null });
    }
    if (location.hash.replace(/^#/, '').split('/')[0] !== t.surveyId) location.hash = '#' + t.surveyId;
    return waitUntil(ready, 10000);
  }
  async function tab(m) {
    await ensureEditor();
    if (mode() !== m) { const b = document.querySelector('.ss-mode[data-mode="' + m + '"]'); if (b) b.click(); }
    await waitUntil(() => mode() === m, 3000);
  }
  function newQuestion(type) {
    const before = new Set(t.base || []);
    return questions().find(q => !before.has(q.id) && (!type || q.type === type)) || null;
  }
  function requiredRow() {
    return Array.from(document.querySelectorAll('.ss-right .ss-field')).find(r => { const l = r.querySelector('.ss-field-label'); return l && l.textContent.trim() === 'Required'; }) || null;
  }

  // "Add an example for me": the follow-up only shows after the first answer is picked
  function addExampleScript() {
    const d = doc();
    if (!d || !t.q1 || !t.q2 || !d.elements[t.q1] || !d.elements[t.q2]) { App.notify('Add both questions first (or go back a few steps).', 'warning'); return; }
    const first = SurveyCore.questionParts(d, t.q1, 'option')[0];
    const id = SurveyCore.uid('rule');
    t.rule = id;
    store().tx('Tutorial example', tx => {
      const rules = JSON.parse(JSON.stringify(tx.part('rules')));
      rules.push({ id, name: 'Show the follow-up', enabled: true, trigger: { type: 'always' }, when: { op: 'all', items: [] }, else: [], ui: { x: 40, y: 40 },
        then: [{ type: 'if', withElse: true,
          when: { op: 'all', items: [{ left: { kind: 'answer', ref: t.q1 }, cmp: 'eq', right: { kind: 'value', value: first ? first.props.value : '' } }] },
          then: [{ type: 'show', target: t.q2 }], else: [{ type: 'hide', target: t.q2 }] }] });
      tx.set('rules', rules);
    });
  }

  const step = s => Object.assign({ kicker: 'Tutorial' }, s, {
    before: async () => { if (s.before) await s.before(); progress.write(); }
  });

  Tour.define('studio-tutorial', [
    step({ title: 'Build your first survey',
      text: '<p>In about five minutes you\'ll go through the whole Survey Studio workflow on a practice survey:</p>' +
            '<ul><li>name it and add questions</li><li>make a question required</li><li>show a follow-up question with logic</li><li>change its colours</li><li>try it on a phone</li><li>publish it and find the responses</li></ul>' +
            '<p>Each step points at what to use and moves on by itself once you\'ve done it. You can skip any step, or close the tutorial and resume it later.</p>' }),

    step({ before: () => ensureEditor().then(() => tab('design')).then(() => drawer(null)), target: '#ss-title', placement: 'bottom', interactive: true,
      title: 'Name your survey',
      text: '<p>This is the editor, with your new practice survey open. Its name is shown at the top.</p><span class="tour-do">Click “Untitled survey”, type a name such as <b>Lunch survey</b>, and press Enter.</span>',
      until: () => doc() && doc().title.trim() && doc().title !== PRACTICE_TITLE, done: 'Named — it saves automatically. (The big heading on the page is separate text you can edit like any other.)' }),

    step({ before: async () => { await tab('design'); t.base = questions().map(q => q.id); await drawer('left'); }, target: ['.ss-pal-item[data-type="single"]', '.ss-left'], interactive: true,
      title: 'Add a question',
      text: '<p>The <b>Add</b> panel lists everything a survey can contain: questions, text, images and layout.</p><span class="tour-do">Click <b>Single choice</b> to add a multiple-choice question with one answer.</span>',
      until: () => { const q = newQuestion('single') || newQuestion(); if (q) { t.q1 = q.id; const p = titlePart(q.id); t.q1Default = p ? plain(p.props.text) : ''; } return !!q; },
      done: 'Added. Every part of it can be moved and styled.' }),

    step({ before: async () => { await tab('design'); await drawer(null); if (t.q1) store().select([t.q1]); }, interactive: true, placement: 'right',
      target: () => { const p = titlePart(t.q1); return p ? document.querySelector('.ss-viewport [data-svid="' + p.id + '"]') : null; },
      title: 'Write your question',
      text: '<p>Text on the canvas is edited where it is.</p><span class="tour-do">Double-click the question text, type your own question — e.g. <b>Where do you usually eat lunch?</b> — then click outside it.</span><p>Double-click an answer the same way to change it.</p>',
      until: () => { const p = titlePart(t.q1); return !!p && !!plain(p.props.text) && plain(p.props.text) !== t.q1Default; },
      done: 'Nice — that\'s your question.' }),

    step({ before: async () => {
        await tab('design');
        if (t.q1 && doc().elements[t.q1]) store().select([t.q1]);
        await drawer('right');
        await waitUntil(requiredRow, 2000);
        const head = Array.from(document.querySelectorAll('.ss-right .ss-sec-head')).find(h => /Behavior/.test(h.textContent));
        if (head && head.getAttribute('aria-expanded') === 'false') head.click();
      }, target: requiredRow, interactive: true, placement: 'left',
      title: 'Make it required',
      text: '<p>The <b>Properties</b> panel shows everything about what\'s selected — size, colours, fonts and, for questions, how they behave.</p><span class="tour-do">Turn on <b>Required</b>, so the survey can\'t be submitted without an answer.</span>',
      until: () => !!(t.q1 && doc().elements[t.q1] && doc().elements[t.q1].behavior && doc().elements[t.q1].behavior.required),
      done: 'Required questions get a red asterisk.' }),

    step({ before: async () => { await tab('design'); t.base = questions().map(q => q.id); if (store()) store().select([]); await drawer('left'); }, target: ['.ss-pal-item[data-type="longtext"]', '.ss-left'], interactive: true,
      title: 'Add a follow-up question',
      text: '<p>Next you\'ll add a question that only some people see.</p><span class="tour-do">Click <b>Long text</b> to add an open question (you can change its text later).</span>',
      until: () => { const q = newQuestion(); if (q) t.q2 = q.id; return !!q; },
      done: 'Added. Now let\'s make it appear only when it matters.' }),

    step({ before: async () => { await ensureEditor(); await drawer(null); }, target: '.ss-mode[data-mode="logic"]', placement: 'bottom', interactive: true,
      title: 'Open the Logic tab',
      text: '<p>The tabs along the top are the steps of making a survey: <b>Design</b>, <b>Logic</b>, <b>Theme</b>, <b>Preview</b> and <b>Responses</b>.</p><span class="tour-do">Click <b>Logic</b>.</span>',
      until: () => mode() === 'logic', done: 'This is where your survey gets smart.' }),

    step({ before: async () => { await tab('logic'); t.base = (doc().rules || []).map(r => r.id); }, target: ['.bk-palette'], placement: 'right', interactive: true, wait: 4000,
      title: 'Logic is made of blocks',
      text: '<p>Like Scratch, you snap blocks together: a yellow <b>hat</b> starts a script, and the blocks under it say what happens — show or hide questions, skip pages, keep scores.</p>' +
            '<span class="tour-do">Drag <b>when any answer changes</b> onto the workspace and snap blocks under it — or let the tutorial add an example.</span>',
      buttons: [{ label: 'Add an example for me', primary: true, onClick: addExampleScript }],
      until: () => { const r = (doc().rules || []).find(x => !(t.base || []).includes(x.id) && x.then && x.then.length); if (r) t.rule = r.id; return !!r; },
      done: 'There\'s your first script.' }),

    step({ before: () => tab('logic'), target: () => document.querySelector('.bk-script[data-rule="' + t.rule + '"]') || document.querySelector('.bk-ws .bk-script'), placement: 'right',
      title: 'How the script works',
      text: '<p>Read it from the top: <i>when any answer changes</i> → <i>if the answer to your question is the first choice, show the follow-up, otherwise hide it</i>.</p>' +
            '<p>Click the dropdowns to change any part. The bar along the bottom checks your logic and points out problems.</p>' }),

    step({ before: () => ensureEditor(), target: '.ss-mode[data-mode="theme"]', placement: 'bottom', interactive: true,
      title: 'Make it yours',
      text: '<span class="tour-do">Open the <b>Theme</b> tab.</span>',
      until: () => mode() === 'theme', done: 'Colours, fonts and shapes for the whole survey.' }),

    step({ before: async () => { await tab('theme'); t.primary = doc().theme.tokens.primary; }, interactive: true, placement: 'right',
      target: () => { const s = document.querySelector('[data-token="primary"]'); return s ? s.closest('.ss-token') || s : null; },
      title: 'Change the main colour',
      text: '<p>The theme applies to every element unless you change one on its own.</p><span class="tour-do">Click the <b>Primary</b> colour and pick another, or type one such as <b>#0EA5E9</b>.</span>',
      until: () => doc().theme.tokens.primary !== t.primary, done: 'Buttons and selected answers use it now.' }),

    step({ before: () => ensureEditor(), target: '.ss-mode[data-mode="preview"]', placement: 'bottom', interactive: true,
      title: 'Try it',
      text: '<span class="tour-do">Open <b>Preview</b> to take the survey yourself.</span>',
      until: () => mode() === 'preview', done: 'Preview runs the survey exactly as respondents get it.' }),

    step({ before: () => tab('preview'), target: '.ss-seg-btn[data-device="mobile"]', placement: 'bottom', interactive: true,
      title: 'See it on a phone',
      text: '<p>Most people answer surveys on their phone.</p><span class="tour-do">Click <b>Mobile</b>.</span>',
      until: () => { const b = document.querySelector('.ss-seg-btn[data-device="mobile"]'); return !!b && b.classList.contains('is-on'); }, done: 'That\'s how it looks on a phone.' }),

    step({ before: () => tab('preview'), target: ['#ss-pv-host .ss-device-screen', '#ss-pv-host'], interactive: true, placement: 'right',
      title: 'Answer it like a respondent',
      text: '<span class="tour-do">Answer the questions and press <b>Submit</b>.</span><p>Try submitting without answering your first question — it\'s required. Pick its first answer and the follow-up appears. Nothing you do in Preview is recorded.</p>',
      until: () => !!document.querySelector('#ss-pv-host .sv-complete'), done: 'Submitted. Restart test in the bar above tries again.' }),

    step({ before: () => ensureEditor(), target: '#ss-publish', placement: 'bottom', interactive: true,
      title: 'Publish it',
      text: '<p>Publishing makes a link anyone can open to answer.</p><span class="tour-do">Click <b>Publish</b>.</span>',
      until: () => !!document.querySelector('#ss-pub-go, #ss-pub-url'), done: 'MetaCode checked the survey for you.' }),

    step({ target: ['#ss-pub-go', '#ss-pub-url'], placement: 'bottom', interactive: true,
      before: async () => { if (!document.querySelector('#ss-pub-go, #ss-pub-url')) { await ensureEditor(); const b = document.getElementById('ss-publish'); if (b) b.click(); await waitUntil(() => document.querySelector('#ss-pub-go, #ss-pub-url'), 3000); } },
      title: 'Create the link',
      text: '<p>The checklist shows whether anything needs fixing first.</p><span class="tour-do">Click <b>Publish</b> in the dialog.</span>',
      until: () => !!document.getElementById('ss-pub-url'), done: 'It\'s live.' }),

    step({ target: () => { const u = document.getElementById('ss-pub-url'); return u ? u.closest('.ss-pub-link') || u : null; }, placement: 'top', interactive: true,
      title: 'Share the link',
      text: '<p>This is your survey\'s address — <b>Copy</b> it and send it to people. You can keep editing; publish again to update what they see (each response records its version).</p>' +
            '<p>Untick <b>Accepting responses</b> to pause it, or <b>Unpublish</b> to take it down.</p>' }),

    step({ before: async () => { if (document.getElementById('modal-backdrop').classList.contains('is-open')) App.closeModal(); await ensureEditor(); }, target: '.ss-mode[data-mode="responses"]', placement: 'bottom', interactive: true,
      title: 'Where answers arrive',
      text: '<span class="tour-do">Open <b>Responses</b>.</span>',
      until: () => mode() === 'responses', done: 'Responses show up here as people submit.' }),

    step({ before: () => tab('responses'), target: ['.ss-responses', '.ss-views'], placement: 'left',
      title: 'Read and export responses',
      text: '<p>You\'ll see the completion rate and typical time, a chart for every question and a table of every response. <b>Export CSV</b> or <b>JSON</b> for SPSS, R or Excel — or <b>Add text answers to project</b> to code them in the MetaCode app.</p>' }),

    step({ before: () => drawer(null),
      title: 'You\'ve built a survey 🎉',
      text: '<p>You named and built a survey, made a question required, added logic, styled it, tested it on a phone, published it and found the responses — the whole workflow.</p>' +
            '<p>The practice survey stays in your list; delete it there (⋯ → Delete) when you\'re done. For a look at everything else on the screen, take the quick tour.</p>',
      buttons: [{ label: 'Take the quick tour', onClick: () => { Tour.stop(); progress.clear(); try { localStorage.setItem('metacode_tour_studio-tutorial', 'done'); } catch (e) { /* ignore */ } Tour.start('studio-editor'); } }] })
  ], { onFinish: () => progress.clear() });

  // Learn Survey Studio: the tutorial (or resume it) and the quick tour
  function chooser() {
    const p = progress.read();
    const editorOpen = !!document.querySelector('.ss-modes');
    const resume = !!(p && p.surveyId && p.step > 0);          // progress is cleared when the tutorial is finished
    App.openModal('Learn Survey Studio',
      '<div class="ss-learn">' +
        '<button type="button" class="ss-learn-card is-main" data-learn="tutorial">' +
          '<span class="ss-learn-icon" aria-hidden="true">🎓</span><span><b>' + (resume ? 'Resume the tutorial' : 'Hands-on tutorial') + '</b>' +
          '<span>Build your first survey step by step — questions, logic, theme, phone preview and publishing. About 5 minutes.' + (resume ? ' You were at step ' + (p.step + 1) + '.' : '') + '</span></span></button>' +
        (resume ? '<button type="button" class="ss-learn-card" data-learn="restart"><span class="ss-learn-icon" aria-hidden="true">↺</span><span><b>Start the tutorial again</b><span>With a new practice survey.</span></span></button>' : '') +
        '<button type="button" class="ss-learn-card" data-learn="tour"><span class="ss-learn-icon" aria-hidden="true">🧭</span><span><b>Quick tour of the screen</b>' +
          '<span>What each part of ' + (editorOpen ? 'the editor' : 'this page') + ' is for. About 2 minutes.</span></span></button>' +
      '</div>',
      '<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>');
    document.querySelectorAll('[data-learn]').forEach(b => b.addEventListener('click', () => {
      App.closeModal();
      if (b.dataset.learn === 'tour') Tour.start(editorOpen ? 'studio-editor' : 'studio');
      else start(b.dataset.learn === 'restart');
    }));
    const first = document.querySelector('[data-learn]');
    if (first) setTimeout(() => first.focus(), 30);
  }

  function start(fresh) {
    const p = !fresh && progress.read();
    Object.assign(t, { surveyId: null, q1: null, q1Default: '', q2: null, base: null, rule: null, primary: null });
    if (p && p.surveyId) Object.assign(t, { surveyId: p.surveyId, q1: p.q1, q1Default: p.q1Default || '', q2: p.q2, rule: p.rule, primary: p.primary });
    Tour.reset('studio-tutorial');
    if (fresh) progress.clear();
    Tour.start('studio-tutorial', { at: p && p.surveyId ? Math.max(1, p.step || 0) : 0 });
  }

  window.StudioTutorial = { start, chooser, state: t };
})();
