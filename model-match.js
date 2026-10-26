// ── Closest model ─────────────────────────────────────────────────────────────
// When the AI service rate-limits a model (or its provider is resting), MetaCode
// answers with the most similar model instead (server.js). "Similar" is judged
// from the model's id and display name (the AI service's model list), in this
// order of importance:
//
//   1. the same family      claude / gpt / gemini / qwen / deepseek / llama …
//   2. the same line        opus vs sonnet, max vs plus, flash, coder, oss …
//   3. thinking or not      qwen-3.7-max-thinking → another "thinking" model
//   4. the nearest version  claude-opus-4.8 → 4.7 before 4.6; ties go to the newer
//   5. the nearest size     70b → 72b before 7b; and the same speed tier (flash, mini…)
//   6. the same capabilities (reasoning, images/files) from the model list
//   7. how alike the names are, as a tie-breaker
//
// rankSimilar(model, candidates, info) → candidates, best first (pure; no I/O).
//
// Model ids are OpenCode refs, "provider/model" (emis/claude-opus-5.5,
// opencode/big-pickle); ids saved before providers existed are bare
// (claude-opus-5.5). Everything here judges the model part; the provider only
// decides whether two ids are one model (sameModel) and which ids a saved id
// may become (renamedModel). The same model on another provider is the best
// substitute of all: its provider has its own budget and its own outages.
//
// The catalogs also respell ids now and then: on 2026-10-22 claude-opus-5-5
// became claude-opus-5.5, gpt-6-1-sol gpt-6.1-sol… The same model can even be
// listed under both spellings. canonicalId() reads "-" or "_" between two
// digits as "." (and ignores case); renamedModel() finds a model saved under
// an old spelling (or without its provider) in the current list, and
// sameModel() tells two spellings of one model apart from a similar model.

// Vendor prefixes that come before the family name (meta-llama, nvidia-nemotron…)
const VENDOR_PREFIX = new Set(['meta', 'nvidia', 'inclusionai', 'xiaomi', 'stepfun', 'poolside', 'dots', 'liquid', 'mistralai', 'google', 'anthropic', 'openai', 'microsoft', 'ibm', 'amazon', 'cohere', 'moonshot', 'moonshotai', 'zhipu', 'zai', 'alibaba', 'bytedance']);
// Different names for the same family
const FAMILY_ALIAS = { o: 'gpt', codestral: 'mistral', mixtral: 'mistral', ministral: 'mistral', chatgpt: 'gpt', o1: 'gpt', o3: 'gpt', o4: 'gpt', llama3: 'llama', moonshot: 'kimi', chatglm: 'glm', mimo: 'mimo' };
// Words that say little about which model it is
const FILLER = new Set(['instruct', 'chat', 'latest', 'preview', 'model', 'it', 'hf', 'v', 'a', 'beta', 'alpha', 'exp', 'experimental', 'release', 'online']);
const THINKING = new Set(['thinking', 'think', 'reasoning', 'reasoner', 'r1']);
const FAST = new Set(['flash', 'lightning', 'turbo', 'fast', 'mini', 'nano', 'lite', 'small', 'haiku', 'xs', 'tiny', 'instant', 'air']);
const BIG = new Set(['max', 'ultra', 'pro', 'opus', 'large', 'super', 'plus', 'heavy']);

// "emis/claude-opus-5.5" → { provider: 'emis', model: 'claude-opus-5.5' }; a bare id has no provider
function splitModel(id) {
  const s = String(id || '');
  const i = s.indexOf('/');
  return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : { provider: null, model: s };
}

// "Claude Opus 4.8" / "claude-opus-4-8" → tokens, numbers and sizes (of the model part)
function parse(id, name) {
  const raw = splitModel(id).model.toLowerCase();
  const sizes = [];
  let s = raw.replace(/(^|[^a-z0-9.])a\d+(?:\.\d+)?b(?=$|[^a-z0-9])/g, '$1')             // active parameters (a17b): ignored
    .replace(/(\d+(?:\.\d+)?)b(?=$|[^a-z0-9])/g, (m, n) => { sizes.push(Number(n)); return ' '; })
    .replace(/(^|[^a-z0-9])(?:19|20)?\d{4}(?=$|[^a-z0-9.])/g, '$1');                     // dates such as 2506, 0731
  const tokens = s.split(/[^a-z0-9]+/).flatMap(t => t.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)).filter(Boolean);
  const words = tokens.filter(t => /^[a-z]/.test(t));
  const numbers = tokens.filter(t => /^\d+$/.test(t)).map(Number);
  // The display name can add a line word the id leaves out (gpt-5-6 = "GPT-5.6 Sol")
  const nameWords = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => /^[a-z]{2,}$/.test(t));
  let i = 0;
  while (i < words.length - 1 && VENDOR_PREFIX.has(words[i])) i++;
  const first = words[i] || raw;
  const family = FAMILY_ALIAS[first] || first;
  const rest = words.slice(i + 1).concat(nameWords).filter(w => w !== first && w !== family && !FILLER.has(w) && w.length > 1 && !VENDOR_PREFIX.has(w));
  const line = new Set(rest.filter(w => !THINKING.has(w)));
  const thinking = words.concat(nameWords).some(w => THINKING.has(w));
  const tier = rest.some(w => FAST.has(w)) ? 'fast' : rest.some(w => BIG.has(w)) ? 'big' : 'normal';
  const version = numbers.length ? numbers[0] + (numbers.length > 1 && numbers[1] < 100 ? numbers[1] / (numbers[1] >= 10 ? 100 : 10) : 0) : null;
  return { raw, family, line, thinking, tier, version, size: sizes.length ? sizes[0] : null, tokens: new Set(tokens) };
}

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// How close candidate c is to target t (higher is closer)
function score(t, c, tInfo, cInfo) {
  let s = 0;
  if (t.family === c.family) s += 100;
  const lineShared = [...t.line].filter(w => c.line.has(w)).length;
  const lineAll = new Set([...t.line, ...c.line]).size;
  if (lineAll) s += 40 * (lineShared / lineAll);
  s += t.thinking === c.thinking ? 15 : -15;
  if (t.tier === c.tier) s += 10;
  if (t.version !== null && c.version !== null) {
    const d = Math.abs(t.version - c.version);
    s += Math.max(-10, 30 - 20 * d) + (c.version > t.version ? 0.5 : 0);     // ties: the newer one
  }
  if (t.size && c.size) s += 15 * (1 - Math.min(1, Math.abs(Math.log(t.size / c.size)) / Math.log(8)));
  if (tInfo && cInfo) {
    if (tInfo.reasoning === cInfo.reasoning) s += 2;
    if (tInfo.attachment === cInfo.attachment) s += 2;
  }
  const shared = [...t.tokens].filter(x => c.tokens.has(x)).length;
  s += 8 * (shared / Math.max(1, new Set([...t.tokens, ...c.tokens]).size));
  s += 4 * (commonPrefix(t.raw, c.raw) / Math.max(t.raw.length, c.raw.length, 1));
  return s;
}

// info: Map id → { name, reasoning, attachment, … } (the model list) or null
function rankSimilar(model, candidates, info) {
  const get = id => (info && typeof info.get === 'function' ? info.get(id) : null) || null;
  const tInfo = get(model);
  const t = parse(model, tInfo && tInfo.name);
  const tProvider = splitModel(model).provider;
  return candidates
    .filter(id => id !== model)
    .map((id, order) => {
      const cInfo = get(id);
      let s = score(t, parse(id, cInfo && cInfo.name), tInfo, cInfo);
      // the very same model from another provider beats any similar one
      const c = splitModel(id);
      if (tProvider && c.provider && c.provider !== tProvider && sameModelPart(model, id)) s += 300;
      return { id, order, s };
    })
    .sort((a, b) => b.s - a.s || a.order - b.order)
    .map(x => x.id);
}

// Renames that changed more than the punctuation (model parts)
const RENAMED = { 'gpt-5-6': 'gpt-5.6-sol' };
const canonicalPart = model => String(model || '').toLowerCase().replace(/(\d)[-_](?=\d)/g, '$1.');
// The provider stays as it is; the model part is read as described above
function canonicalId(id) {
  const m = splitModel(id);
  return (m.provider ? m.provider.toLowerCase() + '/' : '') + canonicalPart(m.model);
}

// One model under two spellings of its model part (providers aside)
function sameModelPart(a, b) {
  const ma = splitModel(a).model, mb = splitModel(b).model;
  return canonicalPart(ma) === canonicalPart(mb) || RENAMED[ma] === mb || RENAMED[mb] === ma;
}

// The id `ids` lists for a model saved under another spelling, or null.
// A bare id (saved before providers) finds its model on any provider (the first
// in list order); an id with a provider only finds it on that provider.
function renamedModel(wanted, ids) {
  if (!wanted || !Array.isArray(ids)) return null;
  const w = splitModel(wanted);
  const pool = ids.filter(id => id !== wanted && (!w.provider || splitModel(id).provider === w.provider));
  const part = id => splitModel(id).model;
  const c = canonicalPart(w.model);
  const find = group => group.find(id => part(id) === w.model)
    || (RENAMED[w.model] && group.find(id => part(id) === RENAMED[w.model]))
    || group.find(id => canonicalPart(part(id)) === c) || null;
  if (w.provider) return find(pool);
  // a bare id: the first provider (in list order) that has the model under any spelling,
  // so an old id stays with the provider listed first even if a later one has its exact spelling
  for (const p of new Set(pool.map(id => splitModel(id).provider))) {
    const hit = find(pool.filter(id => splitModel(id).provider === p));
    if (hit) return hit;
  }
  return null;
}

// Two ids of one model: the same provider (or either id without one) and the same
// model but for punctuation, or the same display name
function sameModel(a, b, info) {
  const pa = splitModel(a).provider, pb = splitModel(b).provider;
  if (pa && pb && pa !== pb) return false;
  if (sameModelPart(a, b)) return true;
  const name = id => { const i = info && typeof info.get === 'function' ? info.get(id) : null; return i && i.name ? String(i.name).trim().toLowerCase() : null; };
  const na = name(a);
  return !!na && na === name(b);
}

module.exports = { rankSimilar, parse, score, splitModel, canonicalId, renamedModel, sameModel };
