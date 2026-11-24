// Which models this device can really run, and which to recommend, by tier.
//
// Memory a model needs ≈ its file × 1.12, plus its context's cache (about 300 MB per 8 billion parameters at the
// default 4,096-token context), plus a little for the runner. Measured with a real Ollama on CPU: gemma3:270m
// (a 292 MB file) took 326 MB loaded. Budget = total memory minus what the system, the browser and MetaCode
// need (at least 1.5 GB, or a quarter of it). A model over the budget is never recommended.
'use strict';
const { params, pullsMlx, sizeHere } = require('./catalog');

const GB = 1e9;
const TIERS = [
  { id: 'ultra', name: 'Ultra lightweight', max: 1 * GB, note: 'Runs on almost anything, even old laptops and a Raspberry Pi; quick but basic.' },
  { id: 'low', name: 'Low resource', max: 3 * GB, note: 'Good small models for 4–8 GB of memory.' },
  { id: 'balanced', name: 'Balanced', max: 8 * GB, note: 'Better answers; wants 8–16 GB of memory, or a GPU.' },
  { id: 'high', name: 'High performance', max: Infinity, note: 'The strongest models; for workstations with lots of memory or a big GPU.' },
];

function ramNeeded(size, paramCount) {
  const cache = paramCount ? (paramCount / 8e9) * 300e6 : size * 0.06;
  return Math.round(size * 1.12 + cache + 64e6);
}
// Where a model runs. A GPU of its own: there if the model fits, else on the CPU. One that shares the memory (Apple
// Silicon, its memory what Metal may use): an MLX variant runs on it; llama.cpp, Ollama's runner for the rest,
// puts the weights and the context's cache on it but keeps 1 GiB of it free (llama-server's --fit), and runs the
// layers that don't fit on the CPU: "mixed". (mlx: the variant here is MLX)
const FIT_MARGIN = 2 ** 30;
function runsOn(gpu, size, paramCount, need, mlx) {
  if (!gpu) return 'cpu';
  if (!gpu.shared) return gpu.memory >= need ? 'gpu' : 'cpu';
  if (mlx) return 'gpu';
  return gpu.memory >= size + (paramCount ? (paramCount / 8e9) * 300e6 : size * 0.06) + FIT_MARGIN ? 'gpu' : 'mixed';
}
// Q4_K_M, the library's usual default, is about 0.6 bytes per parameter
const estimatedSize = paramCount => Math.round(paramCount * 0.6 + 50e6);

function budgetOf(hw) {
  const total = hw.memory.total;
  const reserve = Math.max(1.5 * GB, total * 0.25);
  // (a GPU that shares the system's memory counts too: Ollama runs models on Apple Silicon's with Metal)
  const gpu = (hw.gpus || []).filter(g => g.usable && g.memory).sort((a, b) => b.memory - a.memory)[0] || null;
  // (available: null when it isn't known, as on a Mac whose vm_stat didn't answer)
  return { total, available: Number.isFinite(hw.memory.available) ? hw.memory.available : null, budget: Math.max(0, total - reserve), reserve, gpu };
}

// The tag of a model to offer here: the biggest that fits the budget (the best answers this device can give).
// (mlx: whether the Ollama here takes a tag's MLX variant, catalog.js's pullsMlx)
function pickTag(model, budget, mlx) {
  // (each tag at its download here: for a tag with variants for several runners, the one this Ollama takes)
  const here = (model.tags || []).map(t => Object.assign({}, t, { size: sizeHere(t, mlx) }));
  // (":latest" is one of the other tags under another name: the same file, so it isn't offered twice)
  const tags = here.filter(t => t.size && !(/:latest$/.test(t.tag) && here.some(o => o !== t && o.size === t.size)));
  const sized = tags.map(t => {
    const v = t.tag.split(':')[1];
    // (a tag with variants for several runners is its MLX one for an Ollama that takes MLX)
    return { tag: t.tag, size: t.size, context: t.context, inputs: t.inputs, estimated: false, need: ramNeeded(t.size, params(v)), mlx: mlx === true && !!(t.ranged || t.variants) };
  });
  const options = sized.length ? sized : (model.sizes || []).map(s => {
    const p = params(s);
    if (!p) return null;
    const size = estimatedSize(p);
    return { tag: model.name + ':' + s, size, context: null, inputs: null, estimated: true, need: ramNeeded(size, p) };
  }).filter(Boolean);
  // (the biggest that fits; between equal sizes, a size tag such as :4b rather than :latest, which is the same model)
  const fits = options.filter(o => o.need <= budget).sort((a, b) => (b.need - a.need) || (/:latest$/.test(a.tag) - /:latest$/.test(b.tag)));
  return { pick: fits[0] || null, smallest: options.sort((a, b) => a.need - b.need)[0] || null };
}

const experimental = m => /\b(preview|experimental|exp|beta)\b/i.test(m.name + ' ' + (m.description || '')) || (m.pulls !== null && m.pulls < 20000);

// → { device, tiers: [{ id, name, note, models: [...] }], tooBig }
// (opts.ollamaVersion: the version of the Ollama here, when known, for the variant it takes of a tag)
function recommend(catalogModels, hw, opts) {
  const b = budgetOf(hw);
  const limit = (opts && opts.perTier) || 12;
  const mlx = pullsMlx(hw.appleSilicon, opts && opts.ollamaVersion);
  const tiers = TIERS.map(t => Object.assign({ models: [] }, t)).concat([{ id: 'experimental', name: 'Experimental', note: 'New or rarely used models: interesting, but less tested.', models: [] }]);
  let tooBig = 0;
  for (const m of catalogModels) {
    // (embedding models can't chat, and no MetaCode feature uses them: they're under "All models")
    if ((m.capabilities || []).includes('embedding') || (m.categories && !m.categories.includes('general'))) continue;
    const { pick } = pickTag(m, b.budget, mlx);
    if (!pick) { tooBig++; continue; }
    const entry = {
      name: m.name, tag: pick.tag, size: pick.size, need: pick.need, estimated: pick.estimated, context: pick.context, inputs: pick.inputs,
      description: m.description, capabilities: m.capabilities, categories: m.categories || [], pulls: m.pulls,
      runsOn: runsOn(b.gpu, pick.size, params(pick.tag.split(':')[1]), pick.need, pick.mlx),
    };
    const tier = experimental(m) ? tiers[tiers.length - 1] : tiers.find(t => pick.need <= t.max);
    tier.models.push(entry);
  }
  tiers.forEach(t => { t.total = t.models.length; t.models = t.models.sort((x, y) => (y.pulls || 0) - (x.pulls || 0)).slice(0, limit); });
  return { device: { totalMemory: b.total, availableMemory: b.available, budget: b.budget, gpu: b.gpu ? { name: b.gpu.name, memory: b.gpu.memory, shared: !!b.gpu.shared } : null }, tiers, tooBig };
}

// For one model's card: how each of its tags fits this device ("tight": not in the memory free now; without
// knowing that, whatever is in the budget fits). (o.mlx: the tag's variant here is MLX)
function fit(tag, size, hw, o) {
  const b = budgetOf(hw);
  const p = params(String(tag).split(':')[1]);
  const need = ramNeeded(size, p);
  const level = need <= b.budget ? (b.available === null || need <= b.available ? 'good' : 'tight') : 'too-big';
  return { need, budget: b.budget, level, runsOn: runsOn(b.gpu, size, p, need, !!(o && o.mlx)) };
}

module.exports = { recommend, fit, ramNeeded, budgetOf, pickTag, TIERS };
