// A Codebook dimension's coding rule (public/js/coding-rule.js): validating
// what the AI Coding Lab sends, putting it on the dimension (history, dedupe,
// limits), removing it, and the display helpers. No browser, no server.
const test = require('node:test');
const assert = require('node:assert/strict');
const CR = require('../public/js/coding-rule.js');

const sid = s => 'cbs_' + String(s).padEnd(16, '0').slice(0, 16);
const HASH = 'a'.repeat(64);

function rule(over) {
  return Object.assign({
    schema: 'metacode.coding-rule/1',
    submissionId: sid('one'),
    status: 'experimental',
    dimensionId: 'sentiment',
    experiment: { id: 'exp_AbCdEfGhIjKlMnOp', name: 'Sentiment rule' },
    version: 3,
    codeHash: HASH,
    language: 'javascript',
    code: 'function classify(record, variable) {\n  return /great|love/i.test(record.text) ? "pos" : "neg";\n}\n',
    contract: { name: 'classify/1', input: { record: 'id, text, author, timestamp, meta' }, output: { code: 'one of the codes or null' } },
    prompts: { original: 'Write a keyword rule', final: 'Handle sarcasm' },
    rationale: 'Best held-out macro-F1.',
    evaluation: { runId: 'xrn_0123456789abcdef', finishedAt: '2026-10-24T10:00:00.000Z', split: 'test', records: 412, accuracy: 0.814, macroF1: 0.79, kappa: 0.61, referenceN: 120, coverage: 0.971, errorRate: 0, baselineAgreement: 0.88, recommendation: 'retain' },
    security: { policy: 'passed', review: 'approved', reviewedAt: '2026-10-24T09:59:00.000Z' },
    sandbox: { id: 'sbx_0123456789abcdef', name: 'Climate threads · Sentiment', version: 2, sha256: 'b'.repeat(64) },
    selectedAt: '2026-10-24T10:05:00.000Z',
    sentAt: '2026-10-24T10:06:00.000Z'
  }, over || {});
}
const codebook = () => [
  { id: 'sentiment', name: 'Sentiment', description: 'Valence', codes: [{ id: 'pos', label: 'Positive' }, { id: 'neg', label: 'Negative' }], extra: 'kept' },
  { id: 'stance', name: 'Stance', description: '', codes: [{ id: 'support', label: 'Support' }] }
];

test('a valid rule passes, with its dimension and a cleaned copy', () => {
  const cb = codebook();
  const v = CR.validateCodingRule(rule({ unexpected: 'dropped', experiment: { id: 'exp_AbCdEfGhIjKlMnOp', name: 'Sentiment rule', extra: 1 } }), cb);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
  assert.equal(v.dimension, cb[0]);
  assert.equal(v.missingDimension, false);
  assert.equal(v.rule.code, rule().code);
  assert.equal('unexpected' in v.rule, false, 'only known fields are kept');
  assert.deepEqual(v.rule.experiment, { id: 'exp_AbCdEfGhIjKlMnOp', name: 'Sentiment rule' });
  assert.equal(v.rule.evaluation.accuracy, 0.814);
  // Python and TypeScript are fine too; null metrics are fine
  assert.equal(CR.validateCodingRule(rule({ language: 'python' }), cb).ok, true);
  assert.equal(CR.validateCodingRule(rule({ language: 'typescript', evaluation: Object.assign({}, rule().evaluation, { accuracy: null, macroF1: null, kappa: null, referenceN: 0 }) }), cb).ok, true);
});

test('ids: dimension, submission, experiment and contract code ids must match their patterns', () => {
  const cb = codebook();
  const bad = [
    rule({ dimensionId: "x');alert(1);('" }),
    rule({ dimensionId: 'a'.repeat(65) }),
    rule({ dimensionId: 'has space' }),
    rule({ submissionId: 'cbs_short' }),
    rule({ submissionId: 'xyz_0123456789abcdef' }),
    rule({ submissionId: 'cbs_0123456789abcde"' }),
    rule({ experiment: { id: '../../etc', name: 'x' } }),
    rule({ contract: { name: 'classify/1', input: {}, output: { codes: ['pos', 'bad id"'] } } })
  ];
  for (const r of bad) {
    const v = CR.validateCodingRule(r, cb);
    assert.equal(v.ok, false, JSON.stringify(r.dimensionId || r.submissionId));
    assert.ok(v.problems.length >= 1);
  }
  assert.equal(CR.validateCodingRule(rule({ contract: { name: 'classify/1', input: {}, output: { codes: ['pos', { id: 'neg' }] } } }), cb).ok, true);
});

test('code: missing, oversized (> 64 KB) or not text is refused', () => {
  const cb = codebook();
  assert.equal(CR.validateCodingRule(rule({ code: '' }), cb).ok, false);
  assert.equal(CR.validateCodingRule(rule({ code: '   \n' }), cb).ok, false);
  assert.equal(CR.validateCodingRule(rule({ code: 42 }), cb).ok, false);
  const big = CR.validateCodingRule(rule({ code: '// ' + 'x'.repeat(64 * 1024) }), cb);
  assert.equal(big.ok, false);
  assert.match(big.problems.join(' '), /too large/);
  // Measured in UTF-8 bytes: 22,000 three-byte characters are 66 KB
  assert.equal(CR.validateCodingRule(rule({ code: '//' + '€'.repeat(22000) }), cb).ok, false);
  assert.equal(CR.validateCodingRule(rule({ code: '//' + 'x'.repeat(60000) }), cb).ok, true);
});

test('types, numbers and enums are checked', () => {
  const cb = codebook();
  const ev = over => rule({ evaluation: Object.assign({}, rule().evaluation, over) });
  const cases = [
    rule({ schema: 'metacode.coding-rule/2' }),
    rule({ status: 'production' }),
    rule({ language: 'ruby' }),
    rule({ version: 0 }),
    rule({ version: 2.5 }),
    rule({ codeHash: 'not a hash!' }),
    rule({ security: { policy: 'passed', review: 'rejected', reviewedAt: null } }),
    rule({ security: { policy: 'failed', review: 'approved', reviewedAt: null } }),
    rule({ sentAt: 'yesterday' }),
    rule({ sandbox: { id: 'sbx_0123456789abcdef', name: 'x', version: 2, sha256: '<script>' } }),
    rule({ contract: { name: 'classify/2', input: {}, output: {} } }),
    rule({ rationale: { html: '<b>' } }),
    ev({ accuracy: NaN }),
    ev({ accuracy: Infinity }),
    ev({ accuracy: 81.4 }),
    ev({ coverage: '97%' }),
    ev({ kappa: -2 }),
    ev({ records: -1 }),
    ev({ split: 'train' }),
    ev({ recommendation: 'ship it' }),
    'not an object',
    null
  ];
  for (const r of cases) assert.equal(CR.validateCodingRule(r, cb).ok, false, JSON.stringify(r));
});

test('free text is capped, not refused', () => {
  const v = CR.validateCodingRule(rule({ rationale: 'r'.repeat(10000), prompts: { original: 'p'.repeat(9000), final: '' }, experiment: { id: 'exp_AbCdEfGhIjKlMnOp', name: 'n'.repeat(500) } }), codebook());
  assert.equal(v.ok, true);
  assert.equal(v.rule.rationale.length, 4000);
  assert.equal(v.rule.prompts.original.length, 4000);
  assert.equal(v.rule.experiment.name.length, 200);
});

test('a variable that is not in the codebook is reported as such', () => {
  const v = CR.validateCodingRule(rule({ dimensionId: 'topic' }), codebook());
  assert.equal(v.ok, false);
  assert.equal(v.missingDimension, true);
  assert.equal(v.dimension, null);
  assert.match(v.problems[0], /no variable with the id "topic"/);
  // With other problems as well, it isn't only a missing variable
  assert.equal(CR.validateCodingRule(rule({ dimensionId: 'topic', language: 'ruby' }), codebook()).missingDimension, false);
  assert.equal(CR.validateCodingRule(rule(), null).missingDimension, true);
});

test('apply: a new rule goes on its dimension; nothing else changes; the input is not modified', () => {
  const cb = codebook();
  const before = JSON.stringify(cb);
  const r = CR.applyCodingRule(cb, rule(), '2026-10-25T08:00:00.000Z');
  assert.equal(JSON.stringify(cb), before, 'input untouched');
  assert.equal(r.changed, true);
  assert.equal(r.replaced, null);
  assert.notEqual(r.codebook, cb);
  assert.equal(r.codebook[1], cb[1], 'other dimensions are the same objects');
  const d = r.codebook[0];
  assert.equal(d.extra, 'kept');
  assert.deepEqual(d.codes, cb[0].codes);
  assert.equal(d.codingRule.submissionId, sid('one'));
  assert.equal(d.codingRule.appliedAt, '2026-10-25T08:00:00.000Z');
  assert.equal(d.codingRule.code, rule().code);
  assert.deepEqual(d.codingRuleHistory, []);
});

test('apply twice is a no-op (same submission)', () => {
  const first = CR.applyCodingRule(codebook(), rule(), '2026-10-25T08:00:00.000Z');
  const again = CR.applyCodingRule(first.codebook, rule(), '2026-10-26T08:00:00.000Z');
  assert.equal(again.changed, false);
  assert.equal(again.replaced, null);
  assert.equal(again.codebook, first.codebook, 'the same array comes back');
  assert.equal(again.codebook[0].codingRule.appliedAt, '2026-10-25T08:00:00.000Z');
});

test('apply: replacing moves the current rule to the history; dedupe by submission id', () => {
  let cb = CR.applyCodingRule(codebook(), rule(), '2026-10-25T08:00:00.000Z').codebook;
  const r2 = CR.applyCodingRule(cb, rule({ submissionId: sid('two'), version: 4 }), '2026-10-25T09:00:00.000Z');
  assert.equal(r2.changed, true);
  assert.equal(r2.replaced.submissionId, sid('one'));
  cb = r2.codebook;
  assert.equal(cb[0].codingRule.version, 4);
  assert.equal(cb[0].codingRuleHistory.length, 1);
  assert.equal(cb[0].codingRuleHistory[0].submissionId, sid('one'));
  assert.equal(cb[0].codingRuleHistory[0].replacedAt, '2026-10-25T09:00:00.000Z');
  assert.equal(cb[0].codingRuleHistory[0].code, rule().code, 'recent history keeps its code');
  // Sending the first one again makes it current and takes it out of the history (no duplicates)
  const r3 = CR.applyCodingRule(cb, rule(), '2026-10-25T10:00:00.000Z');
  assert.equal(r3.changed, true);
  const d = r3.codebook[0];
  assert.equal(d.codingRule.submissionId, sid('one'));
  assert.deepEqual(d.codingRuleHistory.map(h => h.submissionId), [sid('two')]);
});

test('history: at most 20 entries, newest first; only the 5 newest keep code', () => {
  let cb = codebook();
  for (let i = 1; i <= 30; i++) cb = CR.applyCodingRule(cb, rule({ submissionId: sid('s' + i), version: i }), new Date(Date.UTC(2026, 9, 1, 0, i))).codebook;
  const d = cb[0];
  assert.equal(d.codingRule.version, 30);
  assert.equal(d.codingRuleHistory.length, CR.HISTORY_MAX);
  assert.equal(CR.HISTORY_MAX, 20);
  assert.deepEqual(d.codingRuleHistory.map(h => h.version), Array.from({ length: 20 }, (_, i) => 29 - i));
  d.codingRuleHistory.forEach((h, i) => {
    if (i < 5) { assert.equal(typeof h.code, 'string'); assert.ok(h.code.length > 0); assert.ok(h.prompts); }
    else { assert.equal(h.code, null, 'entry ' + i + ' has no code'); assert.equal('prompts' in h, false); assert.equal('contract' in h, false); assert.equal(h.codeHash, HASH, 'identity kept'); }
  });
  const size = Buffer.byteLength(JSON.stringify(cb));
  assert.ok(size < 64 * 1024, 'bounded size: ' + size);
});

test('apply refuses invalid payloads and unknown dimensions (throws, codebook untouched)', () => {
  const cb = codebook();
  assert.throws(() => CR.applyCodingRule(cb, rule({ dimensionId: 'nope' }), 0), e => e.missingDimension === true && /no variable/.test(e.message));
  assert.throws(() => CR.applyCodingRule(cb, rule({ code: 'x'.repeat(70000) }), 0), e => Array.isArray(e.problems));
  assert.throws(() => CR.applyCodingRule(cb, rule({ submissionId: 'cbs_<img>' }), 0));
  assert.equal('codingRule' in cb[0], false);
});

test('history entries from elsewhere that are not objects are dropped', () => {
  const cb = codebook();
  cb[0].codingRuleHistory = ['junk', null, 42, { submissionId: sid('old'), version: 1 }];
  const r = CR.applyCodingRule(cb, rule(), 0);
  assert.deepEqual(r.codebook[0].codingRuleHistory, [{ submissionId: sid('old'), version: 1 }]);
});

test('remove: takes the rule and its history off; other dimensions untouched; no-op when absent', () => {
  let cb = CR.applyCodingRule(codebook(), rule(), 0).codebook;
  cb = CR.applyCodingRule(cb, rule({ submissionId: sid('two'), version: 4 }), 0).codebook;
  const r = CR.removeCodingRule(cb, 'sentiment');
  assert.equal(r.changed, true);
  assert.equal(r.removed.version, 4);
  assert.equal('codingRule' in r.codebook[0], false);
  assert.equal('codingRuleHistory' in r.codebook[0], false);
  assert.equal(r.codebook[0].extra, 'kept');
  assert.equal(r.codebook[1], cb[1]);
  assert.equal(cb[0].codingRule.version, 4, 'input untouched');
  const again = CR.removeCodingRule(r.codebook, 'sentiment');
  assert.equal(again.changed, false);
  assert.equal(again.codebook, r.codebook);
  assert.equal(CR.removeCodingRule(cb, 'missing').changed, false);
});

test('display helpers: headline, metrics with n, links, change summary, history line', () => {
  const r = CR.validateCodingRule(rule(), codebook()).rule;
  assert.equal(CR.headline(r), 'Coding rule · v3 · JavaScript · experimental — not used by AI Coding');
  assert.equal(CR.headline({ version: 'x', language: 'cobol' }), 'Coding rule · v? · Unknown language · experimental — not used by AI Coding');
  const m = Object.fromEntries(CR.metricItems(r).map(x => [x.key, x]));
  assert.deepEqual([m.accuracy.label, m.accuracy.text, m.accuracy.n], ['Held-out accuracy', '81.4%', 120]);
  assert.deepEqual([m.macroF1.text, m.macroF1.n], ['0.79', 120]);
  assert.deepEqual([m.coverage.text, m.coverage.n], ['97.1%', 412]);
  assert.deepEqual([m.baselineAgreement.label, m.baselineAgreement.text], ['Agreement with AI coding', '88%']);
  assert.equal(m.errorRate.text, '0%');
  const none = Object.fromEntries(CR.metricItems({ evaluation: { split: 'all', accuracy: null, referenceN: 0 } }).map(x => [x.key, x]));
  assert.equal(none.accuracy.measured, false);
  assert.match(none.accuracy.text, /no reference labels/);
  assert.equal(none.accuracy.label, 'Accuracy (all records)');
  // A run over all records measures accuracy on its held-out ones: referenceSplit names them
  const all = rule();
  all.evaluation = Object.assign({}, all.evaluation, { split: 'all', referenceSplit: 'test' });
  const ra = CR.validateCodingRule(all, codebook()).rule;
  assert.deepEqual([ra.evaluation.split, ra.evaluation.referenceSplit], ['all', 'test']);
  assert.equal(Object.fromEntries(CR.metricItems(ra).map(x => [x.key, x])).accuracy.label, 'Held-out accuracy');
  assert.equal(r.evaluation.referenceSplit, 'test', 'rules sent before the field existed: the run\'s split');
  assert.ok(CR.validateCodingRule(Object.assign(rule(), { evaluation: Object.assign({}, rule().evaluation, { referenceSplit: 'train' }) }), codebook()).problems.some(p => /reference scores/.test(p)));
  assert.deepEqual(CR.metricItems(null).map(x => x.measured), [false, false, false, false, false, false]);

  assert.equal(CR.experimentUrl(r), '/ultra/ai-lab#experiment/exp_AbCdEfGhIjKlMnOp');
  assert.equal(CR.experimentUrl({ experiment: { id: 'javascript:alert(1)' } }), null);
  assert.equal(CR.improveUrl('sentiment'), '/ultra/ai-lab#experiments/new/sentiment');
  assert.equal(CR.improveUrl('bad"id'), null);
  assert.equal(CR.improveUrl('a'.repeat(65)), null);

  const dim = codebook()[0];
  assert.equal(CR.changeSummary(dim, r).kind, 'new');
  const applied = CR.applyCodingRule(codebook(), rule(), 0).codebook[0];
  assert.equal(CR.changeSummary(applied, r).kind, 'same');
  const repl = CR.changeSummary(applied, Object.assign({}, r, { submissionId: sid('two'), version: 4 }));
  assert.equal(repl.kind, 'replace');
  assert.match(repl.text, /^Replaces v3 /);
  assert.match(CR.historyLine(applied.codingRule), /^v3 · JavaScript · “Sentiment rule” · held-out accuracy 81\.4% \(n = 120\)/);
  assert.equal(CR.historyLine('junk'), '');

  assert.equal(CR.isSafeId('pos_1-a'), true);
  assert.equal(CR.isSafeId("a'b"), false);
  assert.equal(CR.isSubmissionId(sid('x')), true);
  assert.equal(CR.formatBytes(2048), '2 KB');
});

/* ── The rule's codes against the open variable's codes (review finding 4; finding 18's panel mark) ── */
// The payload as the Lab builds it (ai-lab/experiments.js codingRule): both contract sides list the code ids
const withCodes = (codes, over) => rule(Object.assign({
  contract: { name: 'classify/1', input: { record: 'id, text, author, timestamp, meta', variable: { id: 'sentiment', name: 'Sentiment', codes } }, output: { returns: 'a code id or null', codes } }
}, over || {}));

test('codes: a rule that can return a code the variable does not have is refused, the codes listed', () => {
  // Project B's "stance" has pro/anti; the rule was measured on project A's support/oppose/neutral
  const cb = [{ id: 'stance', name: 'Stance', codes: [{ id: 'pro', label: 'Pro' }, { id: 'anti', label: 'Anti' }] }];
  const v = CR.validateCodingRule(withCodes(['support', 'oppose', 'neutral'], { dimensionId: 'stance' }), cb);
  assert.equal(v.ok, false);
  assert.equal(v.codesMismatch, true);
  assert.equal(v.missingDimension, false);
  assert.equal(v.dimension, cb[0]);
  assert.deepEqual(v.codes, { rule: ['support', 'oppose', 'neutral'], dimension: ['pro', 'anti'], notInDimension: ['support', 'oppose', 'neutral'], notInRule: ['pro', 'anti'] });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /can return codes that the variable “Stance” \(stance\) in the open project doesn't have: support, oppose, neutral\./);
  assert.match(v.problems[0], /The rule's codes: support, oppose, neutral; the variable's codes: pro, anti\./);
  // Only one code missing (renamed in the project after the sandbox was made): still refused
  const one = CR.validateCodingRule(withCodes(['pos', 'neg', 'mixed']), codebook());
  assert.equal(one.ok, false);
  assert.deepEqual(one.codes.notInDimension, ['mixed']);
  // Saving refuses it too (the codebook may have changed while the dialog was open)
  assert.throws(() => CR.applyCodingRule(cb, withCodes(['support', 'oppose', 'neutral'], { dimensionId: 'stance' }), 0), e => e.codesMismatch === true && /support, oppose, neutral/.test(e.message));
  // With other problems as well, it isn't only a code mismatch
  assert.equal(CR.validateCodingRule(withCodes(['x'], { language: 'ruby' }), codebook()).codesMismatch, false);
});

test('codes: the variable may have codes the rule never returns (saved, with notInRule for a warning); same codes pass', () => {
  const cb = codebook();
  cb[0].codes.push({ id: 'unclear', label: 'Unclear' });
  const v = CR.validateCodingRule(withCodes(['pos', 'neg']), cb);
  assert.equal(v.ok, true, v.problems.join(' '));
  assert.equal(v.codesMismatch, false);
  assert.deepEqual(v.codes, { rule: ['pos', 'neg'], dimension: ['pos', 'neg', 'unclear'], notInDimension: [], notInRule: ['unclear'] });
  assert.equal(CR.applyCodingRule(cb, withCodes(['pos', 'neg']), 0).changed, true);
  const same = CR.validateCodingRule(withCodes(['neg', 'pos']), codebook());
  assert.equal(same.ok, true);
  assert.deepEqual([same.codes.notInDimension, same.codes.notInRule], [[], []]);
  // {id} objects, and only the input side listing them, work too
  assert.deepEqual(CR.validateCodingRule(rule({ contract: { name: 'classify/1', input: {}, output: { codes: [{ id: 'pos' }, { id: 'zzz' }] } } }), codebook()).codes.notInDimension, ['zzz']);
  assert.deepEqual(CR.validateCodingRule(rule({ contract: { name: 'classify/1', input: { variable: { codes: ['pos', 'zzz'] } }, output: {} } }), codebook()).codes.notInDimension, ['zzz']);
  // A rule that lists no codes can't be compared: no mismatch, codes null
  const none = CR.validateCodingRule(rule(), codebook());
  assert.equal(none.ok, true);
  assert.equal(none.codes, null);
});

test('codes: the same submission already on the variable stays a no-op even after its codes changed', () => {
  const cb = CR.applyCodingRule(codebook(), withCodes(['pos', 'neg']), '2026-10-25T08:00:00.000Z').codebook;
  const changed = cb.map(d => (d.id === 'sentiment' ? Object.assign({}, d, { codes: [{ id: 'pos', label: 'Positive' }] }) : d));
  const again = CR.applyCodingRule(changed, withCodes(['pos', 'neg']), '2026-10-26T08:00:00.000Z');
  assert.equal(again.changed, false);
  assert.equal(again.codebook, changed);
  // Another submission with those codes is refused
  assert.throws(() => CR.applyCodingRule(changed, withCodes(['pos', 'neg'], { submissionId: sid('two') }), 0), e => e.codesMismatch === true);
  // After the rule was removed, sending it again saves it again
  const removed = CR.removeCodingRule(cb, 'sentiment').codebook;
  const back = CR.applyCodingRule(removed, withCodes(['pos', 'neg']), '2026-10-27T08:00:00.000Z');
  assert.equal(back.changed, true);
  assert.equal(back.codebook[0].codingRule.submissionId, sid('one'));
  assert.equal(back.codebook[0].codingRule.appliedAt, '2026-10-27T08:00:00.000Z');
});

test('codeDrift: a stored rule against its variable\'s current codes (accepts anything)', () => {
  const cb = CR.applyCodingRule(codebook(), withCodes(['pos', 'neg']), 0).codebook;
  assert.deepEqual(CR.codeDrift(cb[0]), { rule: ['pos', 'neg'], dimension: ['pos', 'neg'], notInDimension: [], notInRule: [] });
  // A CSV import dropped "neg" and added "mixed"
  const dim = Object.assign({}, cb[0], { codes: [{ id: 'pos', label: 'Positive' }, { id: 'mixed', label: 'Mixed' }] });
  assert.deepEqual(CR.codeDrift(dim), { rule: ['pos', 'neg'], dimension: ['pos', 'mixed'], notInDimension: ['neg'], notInRule: ['mixed'] });
  assert.equal(CR.codeDrift(cb[1]), null, 'no rule');
  assert.equal(CR.codeDrift({ codingRule: { contract: 'junk' }, codes: 'junk' }), null, 'no codes listed');
  assert.equal(CR.codeDrift(null), null);
  assert.deepEqual(CR.ruleCodes({ contract: { output: { codes: ['a', { id: 'b' }, 42, null] } } }), ['a', 'b']);
  assert.equal(CR.ruleCodes('junk'), null);
});
