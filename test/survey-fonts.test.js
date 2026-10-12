// The survey font library (public/js/survey/survey-fonts.js) and the Responses
// page's pure helpers (survey-responses.js). Every catalog family was checked
// against the live Google Fonts CSS API when the list was made; here we check
// the names are valid for that API, unique and categorized, and that search,
// lookups and "which fonts does this survey use" behave.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../public/js/survey/survey-fonts.js');
const F = globalThis.SurveyFonts;

test('the catalog: over 250 fonts, unique, valid Google Fonts names, every category represented', () => {
  assert.ok(F.FONTS.length > 250, 'fonts: ' + F.FONTS.length);
  const names = F.FONTS.map(f => f.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  F.FONTS.filter(f => f.google).forEach(f => {
    assert.match(f.name, /^[A-Za-z0-9 ]+$/, f.name);
    assert.match(F.cssUrl(f.name), /^https:\/\/fonts\.googleapis\.com\/css2\?family=[A-Za-z0-9+]+:wght@400;500;600;700&display=swap$/);
    assert.match(f.value, /^'[^']+', (system-ui, sans-serif|Georgia, serif|monospace|cursive)$/);
  });
  for (const c of ['sans', 'serif', 'mono', 'display', 'hand', 'system']) assert.ok(F.FONTS.filter(f => f.category === c).length >= 7, c);
  for (const t of ['humanist', 'geometric', 'legible']) assert.ok(F.FONTS.filter(f => f.tags.includes(t)).length >= 10, t);
});

test('search: by name, by style words ("serif" is not "sans-serif"), by category, best name matches first', () => {
  assert.ok(F.search('serif').every(f => f.category === 'serif'));
  assert.ok(F.search('sans-serif').every(f => f.category === 'sans'));
  assert.ok(F.search('geometric').every(f => f.tags.includes('geometric')));
  assert.deepEqual(F.search('lora').map(f => f.name), ['Lora']);
  assert.deepEqual(F.search('serif libre').map(f => f.name), ['Libre Baskerville', 'Libre Caslon Text', 'Libre Bodoni', 'Frank Ruhl Libre'], 'names starting with the query come first');
  assert.equal(F.search('mono', 'all')[0].category, 'mono');
  assert.equal(F.search('', 'humanist').every(f => f.tags.includes('humanist')), true);
  assert.equal(F.search('no such font').length, 0);
  assert.equal(F.search('Open')[0].name, 'Open Sans');
});

test('lookups and the fonts a survey uses (theme tokens, element defaults, element styles and states)', () => {
  assert.equal(F.familyOf("'Lora', Georgia, serif"), 'Lora');
  assert.equal(F.familyOf('var(--sv-fontBody)'), null);
  assert.equal(F.find("'Lora', Georgia, serif").name, 'Lora');
  assert.equal(F.find('Lora, serif').name, 'Lora', 'found by family name even when the stack differs');
  assert.equal(F.find("'Some Custom Font', serif"), null);
  assert.equal(F.labelOf('var(--sv-fontBody)', [{ name: 'Body (theme)', value: 'var(--sv-fontBody)' }]), 'Body (theme)');
  const doc = { theme: { tokens: { fontBody: "'Inter', system-ui, sans-serif", fontDisplay: "'Playfair Display', Georgia, serif" }, types: { button: { fontFamily: "'Poppins', system-ui, sans-serif" } } },
    elements: { a: { style: { fontFamily: "'Caveat', cursive", states: { hover: { fontFamily: "'Lobster', system-ui, sans-serif" } } } }, b: { style: {} } }, styles: [{ style: { fontFamily: 'Georgia, serif' } }] };
  assert.deepEqual(Array.from(F.usedIn(doc)).sort(), ["'Caveat', cursive", "'Inter', system-ui, sans-serif", "'Lobster', system-ui, sans-serif", "'Playfair Display', Georgia, serif", "'Poppins', system-ui, sans-serif", 'Georgia, serif']);
  assert.equal(F.ensureDoc(doc), 5, 'five of them are web fonts from the catalog (Georgia is a system font)');
});

test('Responses helpers: country flags, abandoned sessions, page visits and the answers at each step', () => {
  globalThis.App = { esc: s => String(s) };
  require('../public/js/survey/survey-responses.js');
  const R = globalThis.SurveyResponses;
  assert.equal(R.flagOf('US'), '🇺🇸');
  assert.equal(R.flagOf('DE'), '🇩🇪');
  assert.equal(R.flagOf('usa'), '');
  assert.equal(R.flagOf(null), '');
  assert.equal(R.countryName('JP'), 'Japan');
  const now = new Date().toISOString();
  assert.equal(R.statusOf({ status: 'complete' }), 'complete');
  assert.equal(R.statusOf({ status: 'in_progress', updatedAt: now, startedAt: now }), 'in_progress');
  assert.equal(R.statusOf({ status: 'in_progress', updatedAt: '2020-01-01T00:00:00Z', startedAt: '2020-01-01T00:00:00Z' }), 'abandoned');
  assert.equal(R.statusOf({ status: 'in_progress', updatedAt: now, startedAt: now, session: { events: [{ t: 1, type: 'abandon' }] } }), 'abandoned');
  const events = [{ t: 0, type: 'start', page: 'p1' }, { t: 1000, type: 'answer', q: 'q1', value: 'a' }, { t: 4000, type: 'page', page: 'p2', dir: 'next' },
    { t: 5000, type: 'answer', q: 'q2', len: 7 }, { t: 6000, type: 'answer', q: 'q1', cleared: true }, { t: 9000, type: 'submit' }];
  assert.deepEqual(R.pageVisits(events).map(v => [v.page, v.start, v.end]), [['p1', 0, 4000], ['p2', 4000, 9000]]);
  assert.deepEqual(R.stateAt(events, 1), { answers: { q1: { value: 'a' } }, page: 'p1' });
  assert.deepEqual(R.stateAt(events, 4), { answers: { q2: { len: 7 } }, page: 'p2' });
  assert.equal(R.fmtDur(65000), '1m 05s');
  assert.equal(R.fmtDur(-1), '—');
});
