/* ══════════════════════════════════════════════
   studio-tour.js — guided tours of Survey Studio (studio.html)

   'studio'         the survey list: templates, new/import, your surveys
   'studio-editor'  the editor: all five tabs (Design, Logic, Theme,
                    Preview, Responses), saving and publishing

   The list tour is offered on a first visit, the editor tour the first time
   a survey is opened; "Take the tour" in the top bar replays whichever fits
   the screen; studio.html?tour=1 starts the list tour (the coding app's tour
   links here).
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  const editorOpen = () => !!document.querySelector('.ss-modes');
  // Switches the editor to a tab for a step
  const tab = mode => () => {
    const b = document.querySelector('.ss-mode[data-mode="' + mode + '"]');
    if (b && !b.classList.contains('is-active') && b.getAttribute('aria-selected') !== 'true') b.click();
  };
  const backToList = () => { if (location.hash && location.hash !== '#') location.hash = ''; };

  async function practiceSurvey() {
    Tour.stop();
    try {
      const tpl = SurveyTemplates.list.find(t => t.id === 'feedback') || SurveyTemplates.list[0];
      const doc = tpl.build();
      doc.title = 'Practice survey (from the tour)';
      const r = await SurveyStore.api('', { method: 'POST', body: { doc } });
      location.hash = '#' + r.survey.id;
      const end = Date.now() + 8000;
      while (!editorOpen() && Date.now() < end) await new Promise(res => setTimeout(res, 80));
      Tour.start('studio-editor');
    } catch (e) { App.notify('The practice survey couldn\'t be made: ' + e.message, 'error'); }
  }

  Tour.define('studio', [
    { before: backToList,
      title: 'Welcome to Survey Studio',
      text: '<p>Survey Studio builds surveys you can send to anyone with a link: design every element on a canvas, add logic with Scratch-style blocks, preview on a phone, publish, and collect responses.</p>' +
            '<p>Your surveys are kept <b>in this browser</b> — other people using this MetaCode server have their own.</p>' },
    { before: backToList, target: '#ss-templates', placement: 'bottom',
      title: 'Start from a template',
      text: '<p>Customer feedback, a research study with consent, event registration, a scored quiz — each comes with questions, styling and logic you can change.</p>' },
    { before: backToList, target: ['#ss-new'], placement: 'bottom',
      title: 'Or start blank — or import',
      text: '<p><b>New survey</b> starts from an empty page. <b>Import</b> opens a <code>.survey.json</code> someone exported and shared with you.</p>' },
    { before: backToList, target: '#ss-list', placement: 'top',
      title: 'Your surveys',
      text: '<p>Each survey shows whether it\'s a draft or live, how many responses it has, and when it changed. Click a title to edit it; <b>⋯</b> has Responses, Duplicate, Export, Save as template and Delete.</p>' },
    { target: '.st-nav', placement: 'bottom',
      title: 'Back to the coding app',
      text: '<p>The top bar links to MetaCode\'s home page and the coding app. Survey answers can be sent there as posts to code (Responses → <b>Add text answers to project</b>).</p>' },
    { title: 'Next: the editor',
      text: '<p>The editor tour shows the canvas, the logic blocks, themes, the phone preview and publishing.</p>' +
            '<p>Open any survey to start it, or let the tour make a practice survey from the feedback template (you can delete it afterwards).</p>',
      buttons: [{ label: 'Open a practice survey', primary: true, onClick: practiceSurvey }], hideNext: true }
  ]);

  Tour.define('studio-editor', [
    { before: tab('design'), target: '.ss-modes', placement: 'bottom',
      title: 'Five tabs, one survey',
      text: '<p><b>Design</b> the pages, add <b>Logic</b>, set the <b>Theme</b>, try it in <b>Preview</b>, and read <b>Responses</b>. The tour visits each.</p>' },
    { before: tab('design'), target: '.ss-left', placement: 'right',
      title: 'Add elements',
      text: '<p>Questions (choice, rating, Likert, text, slider, matrix…), text, images, layout and buttons. Click one to add it to the page, or drag it where you want it. <b>Layers</b> lists everything on the page; <b>Library</b> holds your saved components and styles.</p>' },
    { before: tab('design'), target: ['.ss-canvas-host', '.ss-viewport'], placement: 'left',
      title: 'The canvas',
      text: '<p>Every part of a question — even a single answer choice — can be moved, resized, rotated and styled. Click to select, double-click to go inside a question or edit text, drag the handles to resize.</p>' },
    { before: tab('design'), target: '.ss-toolbar', placement: 'bottom',
      title: 'Tools',
      text: '<p>Select, pan, draw shapes, containers and text; align and distribute what\'s selected; zoom, grid and snapping.</p>' },
    { before: tab('design'), target: '.ss-right', placement: 'left',
      title: 'Properties',
      text: '<p>Everything about the selected element: size and position, colours and fonts, spacing, effects, hover states, animation — and for questions, <b>required</b>, the answer key and validation.</p>' },
    { before: tab('logic'), target: ['.bk-palette'], placement: 'right', wait: 4000,
      title: 'Logic, as blocks',
      text: '<p>Logic works like Scratch: drag blocks from here and snap them together. <b>Events</b> start a script; <b>Control</b> has if / else; <b>Looks</b> shows, hides and restyles; <b>Pages</b> skips and ends the survey; <b>Variables</b> keep scores.</p>' },
    { before: tab('logic'), target: ['.bk-pal-sec[data-cat="random"]', '.bk-palette'], placement: 'right',
      title: 'Random blocks',
      text: '<p>Randomly assign each participant to a condition (at random, or balanced to keep groups even), show one of several messages, shuffle answer choices. Each participant keeps their condition, and it\'s saved with their response.</p>' },
    { before: tab('logic'), target: ['.bk-ws'], placement: 'left',
      title: 'Scripts',
      text: '<p>Scripts live here. Click a block to try it; drag blocks back to the palette to delete them. The bar along the bottom checks the logic as you work and points at any problem.</p>' },
    { before: tab('theme'), target: ['.ss-theme', '.ss-views'], placement: 'left',
      title: 'Theme',
      text: '<p>Colours, fonts, corner radius and spacing for the whole survey, and the look of each element type. Changes apply everywhere unless an element overrides them.</p>' },
    { before: tab('preview'), target: ['.ss-preview-bar', '#ss-pv-host', '.ss-preview'], placement: 'bottom', wait: 4000,
      title: 'Preview on a phone, tablet or desktop',
      text: '<p>Take the survey exactly as respondents will — logic, validation and all. Switch devices, rotate, and restart to see other random conditions.</p>' },
    { before: tab('preview'), target: ['#ss-testpanel'], placement: 'left',
      title: 'Test panel',
      text: '<p>See the answers, variables and active scripts as you go, and jump to any page.</p>' },
    { before: tab('responses'), target: ['.ss-responses', '.ss-views'], placement: 'left', wait: 4000,
      title: 'Responses',
      text: '<p>Completion rate and timing, a chart for every question, and every response in a table — export CSV or JSON, or add the text answers to your coding project.</p>' },
    { before: tab('design'), target: ['#ss-save'], placement: 'bottom',
      title: 'Saved automatically',
      text: '<p>Changes save a moment after you make them, in this browser. Undo and redo cover every change (<kbd>Ctrl</kbd>+<kbd>Z</kbd>); the keyboard button lists all shortcuts.</p>' },
    { before: tab('design'), target: '#ss-publish', placement: 'bottom',
      title: 'Publish',
      text: '<p>Publishing creates a link to share. Keep editing afterwards and publish again for a new version — responses remember which version they answered. Only you can see the responses.</p>' },
    { target: ['#ss-tour', '#st-tour'], placement: 'bottom',
      title: 'That\'s Survey Studio',
      text: '<p>This button opens the hands-on tutorial and this tour again (on the survey list it\'s <b>Tutorial & tour</b> in the top bar). Happy surveying!</p>' }
  ]);

  function current() { return editorOpen() ? 'studio-editor' : 'studio'; }

  window.StudioTour = {
    init() {
      const btn = document.getElementById('st-tour');
      if (btn) btn.addEventListener('click', () => (window.StudioTutorial ? StudioTutorial.chooser() : Tour.start(current())));
      const q = new URLSearchParams(location.search);
      if (q.has('tutorial') && window.StudioTutorial) {
        history.replaceState(null, '', location.pathname + location.hash);
        setTimeout(() => StudioTutorial.start(), 400);
        return;
      }
      if (q.has('tour')) {
        history.replaceState(null, '', location.pathname + location.hash);
        setTimeout(() => Tour.start('studio'), 400);
        return;
      }
      // Offer the tour that fits what's on screen, once each
      const offer = () => setTimeout(() => {
        if (Tour.running) return;
        if (editorOpen()) Tour.offerOnce('studio-editor', { delay: 10, title: 'First time in the editor?', text: 'A short tour of the canvas, logic blocks, theme, preview and publishing.' });
        else if (document.getElementById('ss-list') && window.StudioTutorial) Tour.offerOnce('studio-tutorial', { delay: 10, title: 'New to Survey Studio?', text: 'Build your first survey in a 5-minute hands-on tutorial — or close this and explore on your own (Tutorial & tour in the top bar has it any time).', goLabel: 'Start the tutorial', onGo: () => StudioTutorial.start() });
      }, 900);
      window.addEventListener('hashchange', offer);
      offer();
    }
  };
})();
