// Unit tests for Survey Studio's shared model and logic engine
// (public/js/survey/survey-core.js and survey-logic.js). The same files run in
// the editor, on the respondent page and on the server, so these cover all three.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Core = require('../public/js/survey/survey-core.js');
const Logic = require('../public/js/survey/survey-logic.js');

// The templates file is browser code (attaches to window); load it with the core.
const root = { SurveyCore: Core };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'survey', 'survey-templates.js'), 'utf8'), { window: root });
const templates = root.SurveyTemplates.list;
const template = id => templates.find(t => t.id === id).build();

function addQuestion(doc, type, mut) {
  const t = Core.buildElement(type);
  Object.values(t.elements).forEach(e => { doc.elements[e.id] = e; });
  const q = doc.elements[t.rootId];
  q.parent = 'page:' + doc.pages[0].id;
  doc.pages[0].children.splice(doc.pages[0].children.length - 1, 0, q.id);
  if (mut) mut(q);
  return q;
}
const options = (doc, q) => Core.questionParts(doc, q.id, 'option');

test('createSurvey builds a valid one-page survey with a navigation row', () => {
  const doc = Core.createSurvey({ title: 'T' });
  assert.equal(doc.title, 'T');
  assert.equal(doc.pages.length, 1);
  const types = doc.pages[0].children.map(id => doc.elements[id].type);
  assert.deepEqual(types.slice().sort(), ['container', 'heading', 'paragraph']);
  const buttons = Object.values(doc.elements).filter(e => e.type === 'button');
  assert.equal(buttons.length, 2);
  assert.deepEqual(Core.normalizeDoc(doc).problems, []);
});

test('a single-choice question is made of individually addressable parts', () => {
  const doc = Core.createSurvey();
  const q = addQuestion(doc, 'single');
  const opts = options(doc, q);
  assert.ok(opts.length >= 2);
  for (const o of opts) {
    const kids = o.children.map(id => doc.elements[id].type);
    assert.deepEqual(kids, ['indicator', 'optlabel']);
    assert.equal(Core.questionOf(doc, o.id).id, q.id);
    // every part has its own frame, style, behaviour and a11y record
    for (const key of ['frame', 'style', 'behavior', 'a11y']) assert.equal(typeof o[key], 'object');
  }
  assert.ok(Core.questionParts(doc, q.id, 'qtitle').length === 1);
  assert.equal(new Set(opts.map(o => o.props.value)).size, opts.length, 'option values are unique');
});

test('normalizeDoc repairs damaged documents without losing content', () => {
  const { doc, problems } = Core.normalizeDoc({ title: 5, pages: 'x', elements: { a: { type: 'nope', props: { text: 'keep me' } } } });
  assert.equal(doc.pages.length, 1);
  assert.ok(doc.elements.a, 'unknown element is kept');
  assert.equal(doc.elements.a.props.text, 'keep me');
  assert.ok(doc.pages[0].children.includes('a'));
  assert.ok(problems.some(p => /unknown type/.test(p)));
  // a normalised survey normalises to itself
  const again = Core.normalizeDoc(Core.clone(doc));
  assert.deepEqual(again.problems, []);
  assert.deepEqual(again.doc, doc);
});

test('style inheritance: built-in → theme element default → element override', () => {
  const doc = Core.createSurvey();
  const q = addQuestion(doc, 'single');
  const opt = options(doc, q)[0];
  doc.theme.types.option = { borderRadius: 20, color: '#111111' };
  opt.style.color = '#7C3AED';
  const inherited = Core.inheritedStyle(doc, opt);
  assert.equal(inherited.borderRadius, 20);
  const resolved = Core.resolveStyle(doc, opt);
  assert.equal(resolved.color, '#7C3AED');
  assert.equal(resolved.borderRadius, 20);
  const css = Core.elementCss(doc, opt, 'scope');
  assert.match(css, /\[data-svid="[^"]+"\]/);
  assert.match(css, /#7C3AED/i);
});

test('transforms: frame matrix round-trips and corner distortion yields matrix3d', () => {
  const f = Object.assign({}, Core.FRAME_DEFAULT, { x: 10, y: 20, w: 100, h: 50, rot: 30, sx: 1.5, sy: 0.5 });
  const m = Core.frameLinear(f);
  const inv = Core.invertLinear(m);
  const p = Core.applyLinear(m, 7, 9);
  const back = Core.applyLinear(inv, p.x, p.y);
  assert.ok(Math.abs(back.x - 7) < 1e-9 && Math.abs(back.y - 9) < 1e-9);
  assert.match(Core.transformCss(f), /rotate|matrix/);
  const d = Object.assign({}, f, { rot: 0, sx: 1, sy: 1, distort: { tl: [0, 0], tr: [10, 0], br: [0, 5], bl: [0, 0] } });
  assert.match(Core.transformCss(d, { w: 100, h: 50 }), /matrix3d\(/);
});

test('sanitisation: HTML, CSS values, URLs and video embeds', () => {
  const html = Core.sanitizeHtml('<b>hi</b><script>alert(1)</script><a href="javascript:x" onclick="y">l</a><img src=x onerror=z>');
  assert.ok(!/script|onclick|onerror|javascript/i.test(html));
  assert.match(html, /<b>hi<\/b>/);
  assert.equal(Core.safeUrl('javascript:alert(1)'), '');
  assert.equal(Core.safeUrl('https://x.y/a.png'), 'https://x.y/a.png');
  assert.ok(!/javascript|[{}]/.test(Core.cleanCss('color:red; background:url(javascript:x); } body{x:y}')));
  assert.ok(!/[<>;{}]/.test(Core.cleanValue('red; }</style><script>')));
  assert.equal(Core.videoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(Core.videoEmbedUrl('https://evil.example/x'), null);
});

test('expression language: arithmetic, functions, and no access to JavaScript', () => {
  const doc = Core.createSurvey();
  const env = Logic.makeEnv(doc, { answers: {} });
  assert.equal(Logic.evaluate('1 + 2 * 3', env), 7);
  assert.equal(Logic.evaluate('round(10 / 3)', env), 3);
  assert.equal(Logic.evaluate('1 / 0', env), null);
  assert.equal(Logic.tryEvaluate('constructor.constructor("return process")()', env), null);
  assert.equal(Logic.tryEvaluate('__proto__', env), null);
  assert.ok(Logic.checkExpression('1 +').error || Logic.checkExpression('1 +') !== null);
  assert.throws(() => Logic.compile('a ='));
});

test('show/require logic: hidden follow-up appears and becomes required on a low rating', () => {
  const doc = template('feedback');
  const [rating, , why] = Core.questionsInOrder(doc);
  assert.equal(Logic.computeState(doc, { answers: {} }).isVisible(why.id), false);
  const low = Logic.computeState(doc, { answers: { [rating.id]: 2 } });
  assert.equal(low.isVisible(why.id), true);
  assert.equal(low.isRequired(why.id), true);
  const high = Logic.computeState(doc, { answers: { [rating.id]: 5 } });
  assert.equal(high.isVisible(why.id), false);
});

test('page-exit rule ends the survey (skip logic)', () => {
  const doc = template('research');
  const consent = Core.questionsInOrder(doc)[0];
  const state = Logic.computeState(doc, { answers: { [consent.id]: 'no' } });
  const effects = Logic.runEvent(doc, { type: 'pageExit', page: doc.pages[0].id }, state);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].type, 'complete');
  const yes = Logic.computeState(doc, { answers: { [consent.id]: 'yes' } });
  assert.deepEqual(Logic.runEvent(doc, { type: 'pageExit', page: doc.pages[0].id }, yes), []);
});

test('scores and calculated variables', () => {
  const doc = template('quiz');
  const answers = {};
  Core.questionsInOrder(doc).forEach((q, i) => { answers[q.id] = options(doc, q)[[0, 1, 1][i]].props.value; });
  const out = Logic.validateSubmission(doc, { answers, complete: true });
  assert.equal(out.score, 3);
  assert.equal(out.vars.percent, 100);
  assert.deepEqual(out.errors, []);
  const s = Logic.computeState(doc, { answers });
  assert.equal(Logic.interpolate('{{score}} / 3 — {{percent}}%', s.env), '3 / 3 — 100%');
});

test('validateSubmission drops unknown and hidden answers and enforces required/format/range', () => {
  const doc = template('feedback');
  const [rating, , why] = Core.questionsInOrder(doc);
  let out = Logic.validateSubmission(doc, { answers: { [rating.id]: 5, bogus: 1, [why.id]: 'hidden text' }, complete: true });
  assert.deepEqual(Object.keys(out.answers), [rating.id]);
  assert.equal(out.byKey.rating, 5);
  out = Logic.validateSubmission(doc, { answers: { [rating.id]: 2 }, complete: true });
  assert.deepEqual(out.errors.map(e => e.question), [why.id]);

  const reg = template('registration');
  const [name, email, session] = Core.questionsInOrder(reg);
  out = Logic.validateSubmission(reg, { answers: { [name.id]: 'A', [email.id]: 'not-an-email', [session.id]: 'morning' }, complete: true });
  assert.deepEqual(out.errors.map(e => e.question), [email.id]);
  out = Logic.validateSubmission(reg, { answers: { [name.id]: 'A', [email.id]: 'a@b.co', [session.id]: 'nonexistent' }, complete: true });
  assert.ok(out.errors.some(e => e.question === session.id), 'a value that is not an option is rejected or treated as missing');

  const research = template('research');
  const age = Core.questionsInOrder(research).find(q => q.type === 'number');
  const err = Logic.validateAnswer(research, age, 12, null);
  assert.match(err, /18 or older/);
});

test('ruleProblems reports broken references', () => {
  const doc = template('feedback');
  doc.rules.push({ id: 'r_bad', name: 'Broken', enabled: true, trigger: { type: 'always' },
    when: { op: 'all', items: [{ id: 'c1', left: { kind: 'answer', ref: 'q_missing' }, cmp: 'eq', right: { kind: 'value', value: 1 } }] },
    then: [{ type: 'show', target: 'el_missing' }], else: [] });
  const problems = Logic.ruleProblems(doc);
  assert.ok(problems.length >= 1);
  assert.ok(problems.every(p => p.rule === 'r_bad'));
});

test('every built-in template is a clean, normalised survey', () => {
  for (const t of templates) {
    const doc = t.build();
    assert.deepEqual(Core.normalizeDoc(doc).problems, [], t.id);
    assert.deepEqual(Logic.ruleProblems(doc), [], t.id);
  }
});

test('block scripts: nested if/else, not, empty slots, calc reporters and variables', () => {
  const doc = template('feedback');
  const [rating, nps, why] = Core.questionsInOrder(doc);
  doc.variables.push({ id: 'v1', name: 'total', type: 'number', initial: 0, formula: '' });
  doc.rules = [{
    id: 'r1', name: 'Script', enabled: true, trigger: { type: 'always' }, when: { op: 'all', items: [] }, else: [],
    then: [
      { type: 'setVar', name: 'total', from: { kind: 'calc', op: '+', a: { kind: 'answer', ref: rating.id }, b: { kind: 'answer', ref: nps.id } } },
      { type: 'changeVar', name: 'total', from: { kind: 'value', value: '1' } },
      { type: 'if', when: { op: 'all', items: [{ group: { op: 'not', items: [{ left: { kind: 'var', name: 'total' }, cmp: 'gt', right: { kind: 'value', value: 8 } }] } }] },
        then: [{ type: 'show', target: why.id }], else: [{ type: 'hide', target: why.id }] },
      { type: 'if', when: { op: 'all', items: [] }, then: [{ type: 'require', target: why.id }], else: [] }
    ]
  }];
  assert.deepEqual(Core.normalizeDoc(Core.clone(doc)).doc.rules[0].then, doc.rules[0].then);
  const low = Logic.computeState(doc, { answers: { [rating.id]: 2, [nps.id]: 3 } });
  assert.equal(low.vars.total, 6);
  assert.equal(low.isVisible(why.id), true, 'not (6 > 8) → show');
  assert.equal(low.isRequired(why.id), false, 'an empty if condition is false');
  const high = Logic.computeState(doc, { answers: { [rating.id]: 5, [nps.id]: 9 } });
  assert.equal(high.vars.total, 15);
  assert.equal(high.isVisible(why.id), false);
  // and/or with an empty slot: the empty side is false
  const and = { group: { op: 'all', items: [{ left: { kind: 'value', value: 1 }, cmp: 'eq', right: { kind: 'value', value: 1 } }, null] } };
  const or = { group: { op: 'any', items: [{ left: { kind: 'value', value: 1 }, cmp: 'eq', right: { kind: 'value', value: 1 } }, null] } };
  const env = Logic.makeEnv(doc, { answers: {} });
  assert.equal(Logic.evalCondition(doc, and, env), false);
  assert.equal(Logic.evalCondition(doc, or, env), true);
  assert.equal(Logic.evalCondition(doc, { expr: '2 > 1' }, env), true);
  assert.deepEqual(Logic.ruleProblems(doc).filter(p => p.level !== 'warning'), []);
  assert.ok(Logic.ruleProblems(doc).some(p => /empty condition/.test(p.message)));
});

test('block scripts on events run in order and loose blocks never run', () => {
  const doc = template('research');
  const consent = Core.questionsInOrder(doc)[0];
  doc.variables.push({ id: 'v1', name: 'n', type: 'number', initial: 0, formula: '' });
  doc.rules = [
    { id: 'e1', name: 'Exit', enabled: true, trigger: { type: 'pageExit', page: doc.pages[0].id }, when: { op: 'all', items: [] }, else: [],
      then: [
        { type: 'changeVar', name: 'n', from: { kind: 'value', value: 2 } },
        { type: 'if', when: { op: 'all', items: [{ left: { kind: 'var', name: 'n' }, cmp: 'eq', right: { kind: 'value', value: '2' } }] },
          then: [{ type: 'complete', value: 'n is {{n}}' }], else: [] }
      ] },
    { id: 'loose', name: 'Loose', enabled: true, trigger: { type: 'none' }, when: { op: 'all', items: [] }, then: [{ type: 'goto', target: 'nowhere' }], else: [], ui: { x: 10, y: 20 } }
  ];
  const normal = Core.normalizeDoc(Core.clone(doc)).doc;
  assert.deepEqual(normal.rules[1].ui, { x: 10, y: 20 });
  assert.equal(normal.rules[1].trigger.type, 'none');
  const state = Logic.computeState(doc, { answers: { [consent.id]: 'yes' } });
  const effects = Logic.runEvent(doc, { type: 'pageExit', page: doc.pages[0].id }, state);
  assert.deepEqual(effects.map(e => e.type), ['setVar', 'complete']);
  assert.equal(effects[0].result, 2);
  assert.equal(effects[1].text, 'n is 2');
  assert.deepEqual(Logic.ruleProblems(doc), [], 'loose blocks are not checked');
});
