// "Closest model" ranking (model-match.js), used when EMIS rate-limits a model
// or can't run it, and the mapping of ids the catalog has respelled. The
// ranking is checked against the catalog of 2026-10-22 (a copy in
// test/fixtures, so a catalog update doesn't change these expectations);
// the current emis-models.json is checked for what must hold for any list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankSimilar, parse, canonicalId, renamedModel, sameModel } = require('../model-match');

const infoOf = file => new Map(Object.keys(file).map(id => [id, { id, name: file[id].name, reasoning: file[id].reasoning, attachment: file[id].attachment }]));
const file = require('./fixtures/emis-models-2026-10-22.json').provider.emis.models;
const ids = Object.keys(file);
const info = infoOf(file);
const closest = model => rankSimilar(model, ids, info)[0];

test('parse: family, line, version, size, thinking', () => {
  const p = parse('claude-opus-4.8', 'Claude Opus 4.8');
  assert.equal(p.family, 'claude');
  assert.deepEqual([...p.line], ['opus']);
  assert.equal(p.version, 4.8);
  assert.equal(p.thinking, false);
  assert.equal(p.tier, 'big');
  assert.equal(parse('claude-opus-4-8').version, 4.8, 'hyphen and dot spellings parse the same');
  const q = parse('qwen-3.5-397b-a17b');
  assert.equal(q.family, 'qwen');
  assert.equal(q.version, 3.5);
  assert.equal(q.size, 397, 'parameter count; active parameters (a17b) ignored');
  assert.equal(parse('meta-llama-3_3-70b-instruct').family, 'llama', 'vendor prefix skipped');
  assert.equal(parse('nvidia-nemotron-3-super-120b-a12b').family, 'nemotron');
  assert.equal(parse('codestral-latest').family, 'mistral', 'aliases');
  assert.equal(parse('qwen-3.7-max-thinking').thinking, true);
  assert.equal(parse('deepseek-v4-flash-0731-turbo').version, 4, 'dates are not versions');
  assert.deepEqual([...parse('gpt-5-6', 'GPT-5.6 Sol').line], ['sol'], 'the display name adds the line');
});

test('the closest model: same family and line, nearest version, thinking stays thinking', () => {
  assert.equal(closest('claude-opus-4.6'), 'claude-opus-4.7', 'nearest version; a tie (4.5 / 4.7) goes to the newer');
  assert.equal(closest('claude-sonnet-5.5'), 'claude-sonnet-5');
  assert.equal(closest('claude-fable-5'), 'claude-fable-5.1');
  assert.equal(closest('qwen-3.7-max-thinking'), 'qwen-3.8-max-thinking');
  assert.equal(closest('qwen-3.6-plus'), 'qwen-3.7-plus');
  assert.equal(closest('gemini-3.6-flash'), 'gemini-3.7-flash', 'a tie (3.5 / 3.7) goes to the newer');
  assert.equal(closest('kimi-k3'), 'kimi-k2.7-code', 'nearest version across a major version');
  assert.equal(rankSimilar('gpt-5-6', ['gpt-5.6-abc', 'gpt-5.6-sol'], new Map([['gpt-5-6', { name: 'GPT-5.6 Sol' }]]))[0], 'gpt-5.6-sol', 'same line (from the display name)');
  assert.equal(closest('gpt-oss-20b'), 'gpt-oss');
  assert.equal(closest('gpt-4o-mini'), 'gpt-4.1-mini', 'nearest version, same speed tier');
  assert.equal(closest('llama-3.1-70b-instruct'), 'meta-llama-3_3-70b-instruct', 'same size beats a nearer version of another size');
  assert.ok(/^deepseek-/.test(closest('deepseek-v4-pro')));
  assert.ok(/^mistral-/.test(rankSimilar('codestral-latest', ids.filter(id => !/^codestral/.test(id)), info)[0]), 'codestral counts as mistral');
});

test('rankSimilar: never returns the model itself; ties keep list order; works without info', () => {
  const r = rankSimilar('claude-opus-4.8', ids, info);
  assert.ok(!r.includes('claude-opus-4.8'));
  assert.equal(r.length, ids.length - 1);
  assert.equal(rankSimilar('x', ['b', 'a'], null).join(), 'b,a');
  assert.equal(rankSimilar('foo-pro-2-1', ['bar-pro-2-1', 'foo-mini-1', 'foo-pro-2-0'], null)[0], 'foo-pro-2-0');
});

// The ids the catalog of 2026-10-22 spells with dots
const RENAMED = { 'claude-opus-5-5': 'claude-opus-5.5', 'claude-sonnet-5-5': 'claude-sonnet-5.5', 'gpt-6-1-sol': 'gpt-6.1-sol', 'gpt-5-6': 'gpt-5.6-sol',
  'gpt-5-5': 'gpt-5.5', 'gemini-3-8-flash': 'gemini-3.8-flash', 'kimi-k2-6': 'kimi-k2.6', 'grok-4-7': 'grok-4.7', 'qwen-3-7-max': 'qwen-3.7-max',
  'glm-5-3': 'glm-5.3', 'glm-5-3-flash': 'glm-5.3-flash', 'claude-opus-4-6': 'claude-opus-4.6' };

test('a model saved under an old spelling of its id is found under the new one', () => {
  for (const [from, to] of Object.entries(RENAMED)) {
    assert.ok(!ids.includes(from) && ids.includes(to), from);
    assert.equal(renamedModel(from, ids), to, from);
    assert.equal(closest(from), to, from + ': also the closest model');
  }
  assert.equal(canonicalId('Claude-Opus-5-5'), 'claude-opus-5.5', 'case ignored; "-" between two digits reads as "."');
  assert.equal(renamedModel('gpt-oss-120b', ids), null, 'a model the list doesn\'t have isn\'t invented');
  assert.equal(renamedModel('claude-opus-4.8', ids), 'claude-opus-4-8', 'listed under both spellings: the other one');
  assert.equal(renamedModel('', ids), null);
  assert.equal(renamedModel('qwen-3.7-max', ['qwen-3.7-max-thinking', 'qwen-3.7-plus']), null, 'only the same model, never a similar one');
});

test('sameModel: two spellings of one model, not two similar models', () => {
  assert.ok(sameModel('claude-opus-4-8', 'claude-opus-4.8', info));
  assert.ok(sameModel('gpt-5-6', 'gpt-5.6-sol', null));
  assert.ok(sameModel('qwen3.6-27b', 'qwen-3.6-27b', new Map([['qwen3.6-27b', { name: 'Qwen 3.6 27B' }], ['qwen-3.6-27b', { name: 'Qwen 3.6 27B' }]])), 'same display name');
  assert.ok(!sameModel('claude-opus-4.8', 'claude-opus-4.7', info));
  assert.ok(!sameModel('a-1', 'b-1', null));
});

test('the current emis-models.json: every id is usable, and old spellings still find their model', () => {
  const live = require('../emis-models.json').provider.emis.models;
  const liveIds = Object.keys(live);
  assert.ok(liveIds.length > 0);
  for (const id of liveIds) {
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/, id);
    assert.equal(typeof live[id].name, 'string', id);
  }
  assert.equal(rankSimilar(liveIds[0], liveIds, infoOf(live)).length, liveIds.length - 1);
  for (const [from, to] of Object.entries(RENAMED)) if (!liveIds.includes(from) && liveIds.includes(to)) assert.equal(renamedModel(from, liveIds), to, from);
});
