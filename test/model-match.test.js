// "Closest model" ranking (model-match.js), used when EMIS rate-limits a model:
// checked against the real emis-models.json list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankSimilar, parse } = require('../model-match');

const file = require('../emis-models.json').provider.emis.models;
const ids = Object.keys(file);
const info = new Map(ids.map(id => [id, { id, name: file[id].name, reasoning: file[id].reasoning, attachment: file[id].attachment }]));
const closest = model => rankSimilar(model, ids, info)[0];

test('parse: family, line, version, size, thinking', () => {
  const p = parse('claude-opus-4-8', 'Claude Opus 4.8');
  assert.equal(p.family, 'claude');
  assert.deepEqual([...p.line], ['opus']);
  assert.equal(p.version, 4.8);
  assert.equal(p.thinking, false);
  assert.equal(p.tier, 'big');
  const q = parse('qwen3.5-397b-a17b');
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
  assert.equal(closest('claude-opus-4-8'), 'claude-opus-4-7');
  assert.equal(closest('claude-sonnet-5-5'), 'claude-sonnet-5');
  assert.equal(closest('claude-fable-5-1'), 'claude-fable-5');
  assert.equal(closest('qwen-3.7-max-thinking'), 'qwen-3.8-max-thinking');
  assert.equal(closest('qwen-3.6-plus'), 'qwen-3.7-plus');
  assert.equal(closest('gemini-3-6-flash'), 'gemini-3-8-flash');
  assert.equal(closest('kimi-k3'), 'kimi-k2-6');
  assert.equal(closest('gpt-5-6'), 'gpt-5.6-sol', 'same version and line (from the display name)');
  assert.equal(closest('gpt-oss-20b'), 'gpt-oss');
  assert.equal(closest('gpt-4o'), 'gpt-4.1');
  assert.equal(closest('qwen3.6-27b'), 'qwen-3.8-27b', 'same size');
  assert.ok(/^deepseek-/.test(closest('deepseek-v4-pro')));
  assert.ok(/^mistral-/.test(closest('codestral-latest')));
});

test('rankSimilar: never returns the model itself; ties keep list order; works without info', () => {
  const r = rankSimilar('claude-opus-4-8', ids, info);
  assert.ok(!r.includes('claude-opus-4-8'));
  assert.equal(r.length, ids.length - 1);
  assert.equal(rankSimilar('x', ['b', 'a'], null).join(), 'b,a');
  assert.equal(rankSimilar('foo-pro-2-1', ['bar-pro-2-1', 'foo-mini-1', 'foo-pro-2-0'], null)[0], 'foo-pro-2-0');
});
