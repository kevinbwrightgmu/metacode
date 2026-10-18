// The window's logic that doesn't need a window: function help, MetaCode
// data ↔ sheets, the codebook format, the AI Coding prompts (the website's),
// scraper records, and keyboard shortcuts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = { sheets: { platform: 'linux' } };
globalThis.ReliabilityStats = createRequire(import.meta.url)('../../public/js/reliability-stats.js');
const E = await import('../src/shared/engine/index.js');
const { FUNCTION_HELP, callAt } = await import('../src/renderer/js/functions-help.js');
const M = await import('../src/renderer/js/metacode-data.js');
const { commandFor, COMMANDS, KEYMAP, currentRegion, looksLikeHeader } = await import('../src/renderer/js/commands.js');
const { Axis } = await import('../src/renderer/js/axis.js');

test('every function in the engine is described, and the help names only real functions', () => {
  const names = Object.keys(E.FUNCTIONS);
  assert.deepEqual(names.filter(n => !FUNCTION_HELP[n]), []);
  assert.deepEqual(Object.keys(FUNCTION_HELP).filter(n => !E.FUNCTIONS[n]), []);
  assert.deepEqual(callAt('=IF(A1>2, SUM(B1:B3', 18), { name: 'SUM', arg: 0 });
  assert.deepEqual(callAt('=IF(A1>2, "a,b", ', 16), { name: 'IF', arg: 2 });
  assert.equal(callAt('=A1+2', 5), null);
});

test('a MetaCode project becomes Posts and Codebook sheets, and the codebook comes back', () => {
  const rec = { id: 'pr_x', name: 'P', data: {
    codebook: [{ id: 'tone', name: 'Tone', codes: [{ id: 'pos', label: 'Positive', description: 'praise' }, { id: 'neg', label: 'Negative' }] }],
    posts: [{ id: 'p1', text: 'Nice', author: 'a', timestamp: '2026-01-01', engagement: { likes: 3, shares: 1 }, humanCodes: { tone: 'pos' }, coder2Codes: { tone: 'neg' }, aiCodes: { tone: { code: 'pos', confidence: 0.7, reasoning: 'r' } }, adjudicated: { tone: 'pos' } }] } };
  const wb = M.projectToWorkbook(rec);
  const posts = wb.sheetByName('Posts');
  const v = (s, r, c) => wb.valueAt(s, r, c);
  assert.deepEqual([v(posts, 0, 0), v(posts, 0, 1), v(posts, 1, 1), v(posts, 1, 4), v(posts, 1, 5)], ['id', 'text', 'Nice', 3, 1]);
  assert.deepEqual([v(posts, 0, 9), v(posts, 1, 9), v(posts, 1, 10), v(posts, 1, 11), v(posts, 1, 12), v(posts, 1, 14)], ['Tone · Coder 1', 'pos', 'neg', 'pos', 0.7, 'pos']);
  assert.deepEqual(M.codebookFromWorkbook(wb), [{ id: 'tone', name: 'Tone', description: '', codes: [{ id: 'pos', label: 'Positive', description: 'praise', aiNotes: undefined }, { id: 'neg', label: 'Negative', description: '', aiNotes: undefined }] }]);
  assert.equal(wb.meta.metacodeProject.id, 'pr_x');
  // and back into posts
  const back = M.postsFromSheet(wb, posts, { r1: 1, r2: 1 }, { text: 1, id: 0, author: 2, likes: 4 });
  assert.deepEqual([back[0].id, back[0].text, back[0].author, back[0].engagement], ['p1', 'Nice', 'a', { likes: 3 }]);
});

test('codebook text: parsed, problems explained, written back the same', () => {
  const text = '# Sentiment\npos = Positive — praise\nneg = Negative\n\n# Topic\nhealth = Health';
  const { codebook, problems } = M.parseCodebookText(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(codebook.map(d => [d.id, d.codes.map(c => c.id)]), [['sentiment', ['pos', 'neg']], ['topic', ['health']]]);
  assert.equal(codebook[0].codes[0].description, 'praise');
  assert.equal(M.codebookText(codebook), text);
  assert.match(M.parseCodebookText('pos = Positive').problems[0], /start with a dimension/);
  assert.match(M.parseCodebookText('# Empty').problems[0], /no codes/);
});

test('AI Coding prompts are the website\'s (public/js/ai-coding.js) and answers are checked against the codebook', () => {
  const web = fs.readFileSync(path.join(here, '..', '..', 'public', 'js', 'ai-coding.js'), 'utf8');
  const cb = [{ id: 'tone', name: 'Tone', codes: [{ id: 'pos', label: 'Positive' }, { id: 'neg', label: 'Negative' }] }];
  const sys = M.buildSystemPrompt(cb);
  for (const line of ['You are a content analyst coding social media posts for academic research.', '2. Assign one code per dimension using only the code IDs listed above.',
    '3. Your ENTIRE response must be a single raw JSON object — no explanation, no markdown, no code fences.', 'Do not add any text before or after the JSON object.', 'Additional guidance for applying this code: ']) {
    assert.ok(web.includes(line), 'website: ' + line);
  }
  assert.ok(sys.includes('{"codings":{"tone":{"code":"pos","confidence":0.9,"reasoning":"One sentence."}}}'));
  assert.ok(web.includes("var msg = 'Code this post:\\n\\n\"' + post.text + '\"';"));
  assert.equal(M.buildUserMessage({ text: 'Hi', author: 'x' }), 'Code this post:\n\n"Hi"\nAuthor: @x');
  const parsed = M.parseCodings('Sure! ```json\n{"codings":{"tone":{"code":"pos","confidence":1.4,"reasoning":"ok"}}}\n```');
  assert.deepEqual(M.validCodings(parsed, cb), { tone: { code: 'pos', confidence: 1, reasoning: 'ok' } });
  assert.equal(M.validCodings({ tone: { code: 'made-up' } }, cb).tone.code, null, 'codes outside the codebook are dropped');
  assert.throws(() => M.parseCodings('no json here'));
});

test('scraper records become a table: useful columns first, nested fields flattened, UTC times as dates', () => {
  const { rows, cols } = M.recordsToRows([
    { record_type: 'post', id: 'a1', title: 'Hello', created_utc: 1700000000, score: 5, extra: { flair: 'News' }, tags: ['x', 'y'] },
    { record_type: 'comment', id: 'c1', body: 'Hi', created_utc: 1700000100, parent_id: 'a1' }
  ]);
  assert.deepEqual(cols.slice(0, 4), ['record_type', 'id', 'title', 'body']);
  assert.ok(cols.includes('extra.flair') && cols.includes('tags'));
  const at = k => cols.indexOf(k);
  assert.equal(rows[1][at('tags')], 'x, y');
  assert.equal(rows[1][at('created_utc')], E.msToSerial(1700000000 * 1000));
  assert.equal(rows[2][at('title')], null);
});

test('keyboard shortcuts: one command per key; text fields keep their own keys', () => {
  const ev = (key, o = {}) => ({ key, ctrlKey: !!o.ctrl, metaKey: !!o.meta, shiftKey: !!o.shift, altKey: !!o.alt, target: { tagName: o.tag || 'DIV' } });
  assert.equal(commandFor(ev('s', { ctrl: true }), false), 'save');
  assert.equal(commandFor(ev('S', { ctrl: true, shift: true }), false), 'saveAs');
  assert.equal(commandFor(ev('z', { ctrl: true }), false), 'undo');
  assert.equal(commandFor(ev('Z', { ctrl: true, shift: true }), false), 'redo');
  assert.equal(commandFor(ev('b', { ctrl: true }), false), 'bold');
  assert.equal(commandFor(ev('b', { ctrl: true, tag: 'INPUT' }), false), null, 'Ctrl+B in a text field is the field\'s');
  assert.equal(commandFor(ev('s', { ctrl: true, tag: 'TEXTAREA' }), false), 'save', 'saving works from anywhere');
  assert.equal(commandFor(ev('s', { meta: true }), true), 'save', 'macOS uses ⌘');
  assert.equal(commandFor(ev('s', { ctrl: true }), true), null);
  assert.equal(commandFor(ev('h', { ctrl: true }), false), 'replace');
  assert.equal(commandFor(ev('h', { meta: true }), true), null, '⌘H hides the app on macOS');
  for (const k of KEYMAP) assert.ok(COMMANDS[k.cmd], 'command ' + k.cmd);
  const keys = KEYMAP.map(k => [k.key.toLowerCase(), !!k.mod, !!k.shift, !!k.alt, k.mac].join('|'));
  assert.equal(new Set(keys).size, keys.length, 'no key is bound twice');
});

test('current region and header detection (sort, filter, AI tools)', () => {
  const wb = E.newWorkbook('t');
  const s = wb.activeSheet;
  E.ops.setInputs(wb, s, [['A1', 'Name'], ['B1', 'Score'], ['A2', 'x'], ['B2', '3'], ['A3', 'y'], ['B3', '4'], ['D10', 'far']].map(([a, v]) => { const p = E.parseA1(a); return { r: p.r, c: p.c, input: v }; }));
  assert.deepEqual(currentRegion(s, 1, 1), { r1: 0, c1: 0, r2: 2, c2: 1 });
  assert.deepEqual(currentRegion(s, 9, 3), { r1: 9, c1: 3, r2: 9, c2: 3 });
  assert.equal(looksLikeHeader(wb, s, { r1: 0, c1: 0, r2: 2, c2: 1 }), true);
  assert.equal(looksLikeHeader(wb, s, { r1: 1, c1: 0, r2: 2, c2: 1 }), false);
});

test('row and column positions with custom sizes and hidden rows', () => {
  const sizes = new Map([[2, 40], [5, 10]]);
  const hidden = new Set([3]);
  const ax = new Axis(24, sizes, i => hidden.has(i), hidden, 1000000);
  assert.equal(ax.offset(0), 0);
  assert.equal(ax.offset(3), 24 + 24 + 40);
  assert.equal(ax.offset(4), 88, 'row 3 is hidden');
  assert.equal(ax.offset(6), 88 + 24 + 10);
  assert.equal(ax.total(), 1000000 * 24 + 16 - 24 - 14);
  assert.equal(ax.indexAt(0), 0);
  assert.equal(ax.indexAt(50), 2);
  assert.equal(ax.indexAt(88), 4, 'a hidden row is never the answer');
  assert.equal(ax.indexAt(ax.offset(500000) + 5), 500000);
  assert.equal(ax.indexAt(ax.offset(500000) - 1), 499999);
  assert.equal(ax.nextVisible(3, 1), 4);
  assert.equal(ax.nextVisible(3, -1), 2);
});
