/* ══════════════════════════════════════════════
   survey-templates.js — built-in starting points
   Each template is built with the same model functions the editor uses,
   so it is an ordinary, fully editable survey.
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const Core = root.SurveyCore;

  function place(doc, page, type, y, mut) {
    const t = Core.buildElement(type);
    const el = t.elements[t.rootId];
    Object.assign(el.frame, { x: 48, y, pos: 'free' });
    Object.values(t.elements).forEach(e => { doc.elements[e.id] = e; });
    el.parent = 'page:' + page.id;
    // keep the docked navigation row last
    page.children.splice(Math.max(0, page.children.length - 1), 0, t.rootId);
    if (mut) mut(el, t.elements);
    return el;
  }
  const part = (doc, q, type) => Core.questionParts(doc, q.id, type)[0];
  const title = (doc, q, text) => { part(doc, q, 'qtitle').props.text = text; };
  function setOptions(doc, q, labels) {
    const opts = Core.questionParts(doc, q.id, 'option');
    labels.forEach((l, i) => {
      const o = opts[i];
      if (!o) return;
      o.props.value = Core.slug(l);
      const lab = (o.children || []).map(id => doc.elements[id]).find(c => c && c.type === 'optlabel');
      if (lab) lab.props.text = l;
    });
    // drop extra options
    opts.slice(labels.length).forEach(o => {
      const parent = doc.elements[o.parent];
      parent.children = parent.children.filter(c => c !== o.id);
      Core.descendants(doc, o.id).concat([o.id]).forEach(id => delete doc.elements[id]);
    });
    // add missing ones by copying the last
    for (let i = opts.length; i < labels.length; i++) {
      const last = Core.questionParts(doc, q.id, 'option').slice(-1)[0];
      const copy = Core.copySubtree(doc.elements, last.id, last.parent);
      Object.values(copy.elements).forEach(e => { doc.elements[e.id] = e; });
      doc.elements[last.parent].children.push(copy.rootId);
      const ne = doc.elements[copy.rootId];
      ne.props.value = Core.slug(labels[i]);
      const lab = (ne.children || []).map(id => doc.elements[id]).find(c => c && c.type === 'optlabel');
      if (lab) lab.props.text = labels[i];
    }
  }
  function heading(doc, page, text, y, size) { return place(doc, page, 'heading', y, el => { el.props.text = text; if (size) el.style.fontSize = size; }); }
  function para(doc, page, text, y) { return place(doc, page, 'paragraph', y, el => { el.props.text = text; }); }
  function rule(doc, name, trigger, when, then) { doc.rules.push({ id: Core.uid('rule'), name, enabled: true, trigger, when: { op: 'all', items: when }, then, else: [] }); }
  const cond = (ref, cmp, value) => ({ id: Core.uid('c'), left: { kind: 'answer', ref }, cmp, right: { kind: 'value', value } });

  const TEMPLATES = [
    { id: 'blank', name: 'Blank survey', description: 'Start from an empty page.', build: () => Core.createSurvey({ title: 'Untitled survey' }) },
    {
      id: 'feedback', name: 'Customer feedback', description: 'Star rating, likelihood to recommend, and a follow-up when the rating is low.',
      build() {
        const doc = Core.createSurvey({ title: 'How did we do?', description: 'Two minutes of feedback helps us improve. Thank you!' });
        const p = doc.pages[0];
        const rating = place(doc, p, 'rating', 170, q => { title(doc, q, 'How would you rate your experience?'); q.behavior.required = true; q.behavior.dataKey = 'rating'; });
        place(doc, p, 'slider', 290, q => { title(doc, q, 'How likely are you to recommend us to a friend?'); q.behavior.dataKey = 'nps'; });
        const why = place(doc, p, 'longtext', 420, q => { title(doc, q, 'What could we do better?'); q.behavior.dataKey = 'improve'; });
        place(doc, p, 'multiple', 600, q => { title(doc, q, 'What did you like?'); setOptions(doc, q, ['Speed', 'Quality', 'Price', 'Support']); q.behavior.dataKey = 'liked'; });
        rule(doc, 'Ask for improvements on a low rating', { type: 'always' }, [cond(rating.id, 'lte', 3), cond(rating.id, 'notEmpty')], [{ type: 'show', target: why.id }, { type: 'require', target: why.id }]);
        doc.settings.completionMessage = 'Thanks for your feedback — we read every response.';
        return doc;
      }
    },
    {
      id: 'research', name: 'Research study', description: 'Consent page that ends the survey on “No”, demographics, and a Likert block.',
      build() {
        const doc = Core.createSurvey({ title: 'Social media use study', description: 'This study is run for research purposes. Participation is voluntary and your answers are anonymous.' });
        const p1 = doc.pages[0];
        place(doc, p1, 'instructions', 170, el => { el.props.text = 'You can stop at any time. The survey takes about 5 minutes. Contact the research team with any questions.'; });
        const consent = place(doc, p1, 'yesno', 260, q => { title(doc, q, 'Do you agree to take part in this study?'); q.behavior.required = true; q.behavior.dataKey = 'consent'; });
        const p2 = Core.addPage(doc, 'About you');
        heading(doc, p2, 'About you', 48, 24);
        place(doc, p2, 'number', 110, q => { title(doc, q, 'How old are you?'); q.behavior.required = true; q.behavior.dataKey = 'age'; q.behavior.validation = { min: 18, max: 110, rangeMessage: 'Participants must be 18 or older.' }; });
        place(doc, p2, 'single', 230, q => { title(doc, q, 'How many hours a day do you spend on social media?'); setOptions(doc, q, ['Less than 1', '1–3', '3–5', 'More than 5']); q.behavior.dataKey = 'hours'; });
        const p3 = Core.addPage(doc, 'Your views');
        heading(doc, p3, 'Your views', 48, 24);
        ['Social media helps me stay informed.', 'I trust the news I see on social media.', 'I would like to spend less time on social media.'].forEach((s, i) =>
          place(doc, p3, 'likert', 110 + i * 150, q => { title(doc, q, s); q.behavior.dataKey = 'view_' + (i + 1); }));
        rule(doc, 'End if no consent', { type: 'pageExit', page: p1.id }, [cond(consent.id, 'eq', 'no')], [{ type: 'complete', value: 'Thank you for your time. You chose not to take part, so the survey has ended.' }]);
        return doc;
      }
    },
    {
      id: 'registration', name: 'Event registration', description: 'Name, validated email, session choice and dietary needs.',
      build() {
        const doc = Core.createSurvey({ title: 'Register for the workshop', description: 'Saturday 10:00–16:00. Seats are limited.' });
        const p = doc.pages[0];
        place(doc, p, 'shorttext', 170, q => { title(doc, q, 'Full name'); q.behavior.required = true; q.behavior.dataKey = 'name'; part(doc, q, 'field').props.placeholder = 'Jane Doe'; });
        place(doc, p, 'shorttext', 280, q => { title(doc, q, 'Email'); q.behavior.required = true; q.behavior.dataKey = 'email'; q.behavior.validation = { format: 'email' }; part(doc, q, 'field').props.placeholder = 'you@example.com'; });
        place(doc, p, 'single', 390, q => { title(doc, q, 'Which session will you attend?'); setOptions(doc, q, ['Morning', 'Afternoon', 'Both']); q.behavior.required = true; q.behavior.dataKey = 'session'; });
        const diet = place(doc, p, 'multiple', 600, q => { title(doc, q, 'Dietary requirements'); setOptions(doc, q, ['None', 'Vegetarian', 'Vegan', 'Gluten-free']); q.behavior.dataKey = 'diet'; });
        const none = Core.questionParts(doc, diet.id, 'option')[0];
        none.props.exclusive = true;
        doc.settings.submitLabel = 'Register';
        doc.settings.completionTitle = 'You\'re registered!';
        doc.settings.completionMessage = 'See you on Saturday.';
        return doc;
      }
    },
    {
      id: 'quiz', name: 'Scored quiz', description: 'Questions with scores, a calculated variable and a result message.',
      build() {
        const doc = Core.createSurvey({ title: 'Quick quiz', description: 'Three questions. Your score is shown at the end.' });
        const p = doc.pages[0];
        const qs = [['Which planet is closest to the Sun?', ['Mercury', 'Venus', 'Mars'], 0], ['What is 7 × 8?', ['54', '56', '64'], 1], ['Which language runs in web browsers?', ['Python', 'JavaScript', 'C'], 1]];
        qs.forEach(([t, opts, correct], i) => place(doc, p, 'single', 170 + i * 200, q => {
          title(doc, q, t); setOptions(doc, q, opts); q.behavior.required = true; q.behavior.dataKey = 'q' + (i + 1);
          Core.questionParts(doc, q.id, 'option').forEach((o, k) => { o.props.score = k === correct ? 1 : 0; });
        }));
        doc.variables.push({ id: Core.uid('var'), name: 'percent', type: 'number', initial: 0, formula: 'round(score / 3 * 100)' });
        doc.settings.completionTitle = 'You scored {{score}} / 3';
        doc.settings.completionMessage = 'That\'s {{percent}}%. Thanks for playing!';
        return doc;
      }
    }
  ];

  root.SurveyTemplates = { list: TEMPLATES };
})(typeof window !== 'undefined' ? window : this);
