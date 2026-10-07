// ── Closest model ─────────────────────────────────────────────────────────────
// When EMIS rate-limits a model, MetaCode answers with the most similar model
// instead (server.js). "Similar" is judged from the model's id and display
// name (emis-models.json), in this order of importance:
//
//   1. the same family      claude / gpt / gemini / qwen / deepseek / llama …
//   2. the same line        opus vs sonnet, max vs plus, flash, coder, oss …
//   3. thinking or not      qwen-3.7-max-thinking → another "thinking" model
//   4. the nearest version  claude-opus-4-8 → 4-7 before 4-6; ties go to the newer
//   5. the nearest size     70b → 72b before 7b; and the same speed tier (flash, mini…)
//   6. the same capabilities (reasoning, images/files) from emis-models.json
//   7. how alike the names are, as a tie-breaker
//
// rankSimilar(model, candidates, info) → candidates, best first (pure; no I/O).

// Vendor prefixes that come before the family name (meta-llama, nvidia-nemotron…)
const VENDOR_PREFIX = new Set(['meta', 'nvidia', 'inclusionai', 'xiaomi', 'stepfun', 'poolside', 'dots', 'liquid', 'mistralai', 'google', 'anthropic', 'openai', 'microsoft', 'ibm', 'amazon', 'cohere', 'moonshot', 'moonshotai', 'zhipu', 'zai', 'alibaba', 'bytedance']);
// Different names for the same family
const FAMILY_ALIAS = { o: 'gpt', codestral: 'mistral', mixtral: 'mistral', ministral: 'mistral', chatgpt: 'gpt', o1: 'gpt', o3: 'gpt', o4: 'gpt', llama3: 'llama', moonshot: 'kimi', chatglm: 'glm', mimo: 'mimo' };
// Words that say little about which model it is
const FILLER = new Set(['instruct', 'chat', 'latest', 'preview', 'model', 'it', 'hf', 'v', 'a', 'beta', 'alpha', 'exp', 'experimental', 'release', 'online']);
const THINKING = new Set(['thinking', 'think', 'reasoning', 'reasoner', 'r1']);
const FAST = new Set(['flash', 'lightning', 'turbo', 'fast', 'mini', 'nano', 'lite', 'small', 'haiku', 'xs', 'tiny', 'instant', 'air']);
const BIG = new Set(['max', 'ultra', 'pro', 'opus', 'large', 'super', 'plus', 'heavy']);

// "Claude Opus 4.8" / "claude-opus-4-8" → tokens, numbers and sizes
function parse(id, name) {
  const raw = String(id || '').toLowerCase();
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

// info: Map id → { name, reasoning, attachment, … } (emis-models.json) or null
function rankSimilar(model, candidates, info) {
  const get = id => (info && typeof info.get === 'function' ? info.get(id) : null) || null;
  const tInfo = get(model);
  const t = parse(model, tInfo && tInfo.name);
  return candidates
    .filter(id => id !== model)
    .map((id, order) => {
      const cInfo = get(id);
      return { id, order, s: score(t, parse(id, cInfo && cInfo.name), tInfo, cInfo) };
    })
    .sort((a, b) => b.s - a.s || a.order - b.order)
    .map(x => x.id);
}

module.exports = { rankSimilar, parse, score };
