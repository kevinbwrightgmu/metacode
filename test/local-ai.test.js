// The AI Model Store's server side (local-ai/): reading Ollama's library, recommendations that fit the device,
// and every /api/local-ai route against a stand-in Ollama that behaves like the real one (checked with Ollama
// 0.40): downloads stream progress per layer, a stopped download continues where it stopped, a missing model is
// an {"error"} line in a 200 stream, installed digests are the sha256 of the registry's manifest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { parseLibrary, parseTags, mainTags, categories, createCatalog, pickVariant, pullsMlx, sizeHere } = require('../local-ai/catalog');
const { recommend, ramNeeded, fit } = require('../local-ai/recommend');
const { createLocalAi } = require('../local-ai');
const { createOllama } = require('../local-ai/ollama');
const { createHardware, vmStatAvailable } = require('../local-ai/hardware');
const { createRuntimes, platformId } = require('../local-ai/runtimes');
const { normalize, keyOf, createInstalls } = require('../local-ai/installs');
const { standIns, manifestFor, listFor, MODEL_BYTES } = require('./helpers/ollama-standin');

const FIXTURES = path.join(__dirname, 'fixtures', 'ollama');
const LIBRARY_HTML = fs.readFileSync(path.join(FIXTURES, 'library.html'), 'utf8');
const TAGS_HTML = fs.readFileSync(path.join(FIXTURES, 'gemma3-tags.html'), 'utf8');
const GEMMA4_TAGS_HTML = fs.readFileSync(path.join(FIXTURES, 'gemma4-tags.html'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GB = 1e9;
const GEMMA4 = { name: 'gemma4', capabilities: ['vision', 'tools', 'thinking'], sizes: ['e2b', 'e4b', '12b', '26b', '31b'], pulls: 29600000, description: 'Gemma 4 models.' };
// gemma4's variants as Ollama's registry gave them (November 2026): what an Ollama on Apple Silicon that takes MLX
// downloads, and what every other does (llama.cpp)
const GEMMA4_VARIANTS = {
  'gemma4:latest': { apple: 9461576343, other: 6583656505 }, 'gemma4:e4b': { apple: 9461576343, other: 6583656505 },
  'gemma4:e2b': { apple: 7476595162, other: 4587156505 }, 'gemma4:12b': { apple: 7714091504, other: 8021618941 },
  'gemma4:26b': { apple: 16146867483, other: 18731025629 }, 'gemma4:31b': { apple: 19424434885, other: 20385458234 },
};

// ── Reading the library ─────────────────────────────────────────────────────

test('the library page: names, descriptions, capabilities, sizes, pulls and dates; cloud-only models left out', () => {
  const models = parseLibrary(LIBRARY_HTML);
  assert.deepEqual(models.map(m => m.name), ['gemma3', 'deepseek-r1', 'nomic-embed-text', 'qwen2.5-coder']);
  const g = models[0];
  assert.equal(g.description, 'The current, most capable model that runs on a single GPU.');
  assert.deepEqual(g.capabilities, ['vision']);
  assert.deepEqual(g.sizes, ['270m', '1b', '4b', '12b', '27b']);
  assert.equal(g.pulls, 42000000);
  assert.match(g.updated, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(models[1].capabilities, ['tools', 'thinking']);
  assert.deepEqual(categories(models[1]).sort(), ['general', 'reasoning', 'small']);
  assert.deepEqual(categories(models[2]), ['embedding']);
  assert.ok(categories(models[3]).includes('coding'));
  assert.ok(categories(g).includes('vision') && categories(g).includes('small'));
  assert.equal(parseLibrary('<html>nothing here</html>').length, 0);
});

test('a model\'s tags page: size, context window, inputs and digest per tag; the main tags first', () => {
  const tags = parseTags(TAGS_HTML, 'gemma3');
  assert.deepEqual(tags.find(t => t.tag === 'gemma3:270m'), { tag: 'gemma3:270m', digest: 'e7d36fb2c3b3', size: 292000000, context: 32768, inputs: ['text'] });
  assert.deepEqual(tags.find(t => t.tag === 'gemma3:4b').inputs, ['text', 'image']);
  const model = parseLibrary(LIBRARY_HTML)[0];
  assert.deepEqual(mainTags(model, tags).map(t => t.tag), ['gemma3:latest', 'gemma3:270m', 'gemma3:1b', 'gemma3:4b']);
});

test('tags with variants for several runners show a size range: ranged, and read as its upper bound until the registry gives each variant\'s size; a model\'s size tags (and :latest) are its main tags', () => {
  const tags = parseTags(GEMMA4_TAGS_HTML, 'gemma4');
  assert.deepEqual(tags.map(t => [t.tag, t.size, !!t.ranged]), [['gemma4:latest', 9.5e9, true], ['gemma4:e2b', 7.5e9, true], ['gemma4:e4b', 9.5e9, true], ['gemma4:12b', 8e9, true],
    ['gemma4:26b', 19e9, true], ['gemma4:31b', 20e9, true], ['gemma4:e2b-it-q4_K_M', 4.6e9, false], ['gemma4:e2b-mlx', 7.5e9, false]]);
  assert.deepEqual(tags.find(t => t.tag === 'gemma4:26b'), { tag: 'gemma4:26b', digest: 'ed3c4359df98', size: 19e9, context: 262144, inputs: ['text', 'image'], ranged: true });
  const main = mainTags(GEMMA4, tags);
  assert.deepEqual(main.map(t => t.tag), ['gemma4:latest', 'gemma4:e2b', 'gemma4:e4b', 'gemma4:12b', 'gemma4:26b', 'gemma4:31b']);
  // (a size tag is recommended, not one of the first quantizations on the page; without the variants' sizes, the
  // upper bound)
  const pick = gb => recommend([Object.assign({}, GEMMA4, { categories: categories(GEMMA4), tags: main })], linux(gb)).tiers.flatMap(t => t.models)[0];
  assert.equal(pick(16).tag, 'gemma4:e4b');
  assert.equal(pick(30).tag, 'gemma4:26b');
  assert.equal(pick(32).tag, 'gemma4:31b');
});

test('a tag with variants for several runners at the size of the one the Ollama here takes: llama.cpp off Apple Silicon and before Ollama 0.40, MLX on Apple Silicon; the upper bound where that isn\'t known', () => {
  const tags = parseTags(GEMMA4_TAGS_HTML, 'gemma4').map(t => Object.assign(t, GEMMA4_VARIANTS[t.tag] ? { variants: GEMMA4_VARIANTS[t.tag] } : {}));
  const model = Object.assign({}, GEMMA4, { categories: categories(GEMMA4), tags: mainTags(GEMMA4, tags) });
  const pick = (device, ollamaVersion) => (recommend([model], device, { ollamaVersion }).tiers.flatMap(t => t.models)[0] || { tag: null }).tag;
  assert.equal(pick(linux(8)), 'gemma4:e2b');                   // (4.59 GB: needs 5.28 of the 6 GB for models)
  assert.equal(pick(linux(16)), 'gemma4:12b');                  // (e4b is 6.58 GB here, not MLX's 9.46)
  assert.equal(pick(mac(8)), null);                             // (MLX's e2b is 7.48 GB)
  assert.equal(pick(mac(8), '0.35.1'), 'gemma4:e2b');           // (an Ollama before 0.40 takes llama.cpp there too)
  assert.equal(pick(mac(16)), 'gemma4:e4b');
  assert.equal(pick(mac(32)), 'gemma4:31b');
  assert.equal(pick(Object.assign(linux(8), { appleSilicon: null })), null);       // (not known: the upper bound, 7.5 GB)
  // each tag's download and fit, as Details gives them
  const e2b = tags.find(t => t.tag === 'gemma4:e2b');
  assert.deepEqual([sizeHere(e2b, false), sizeHere(e2b, true), sizeHere(e2b, null)], [4587156505, 7476595162, 7.5e9]);
  assert.equal(sizeHere(tags.find(t => t.tag === 'gemma4:e2b-it-q4_K_M'), true), 4.6e9);
  assert.equal(fit('gemma4:e2b', sizeHere(e2b, false), linux(8)).level, 'good');
  assert.equal(fit('gemma4:e2b', sizeHere(e2b, true), mac(8)).level, 'too-big');
});

test('a manifest list: the variant Ollama pulls, as Ollama picks it (MLX first on Apple Silicon, llama.cpp first elsewhere)', () => {
  const d = n => 'sha256:' + String(n).repeat(64);
  const list = { manifests: [
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: d(1), runner: 'llamacpp' },          // (not a plain manifest: passed over)
    { digest: d(2), runner: ' LlamaCpp ' },
    { mediaType: 'application/vnd.docker.distribution.manifest.v2+json', digest: d(3), runner: 'mlx' },
  ] };
  assert.equal(pickVariant(list, false).digest, d(2));
  assert.equal(pickVariant(list, true).digest, d(3));
  assert.equal(pickVariant({ manifests: [{ digest: d(4), runner: 'ggml' }, { digest: d(5), runner: 'other' }] }, true).digest, d(4));
  assert.equal(pickVariant({ manifests: [{ digest: d(5), runner: 'other' }] }, false), null);
  assert.equal(pickVariant({}, false), null);
});

test('the shipped snapshot: hundreds of local models with their tags, for a first start offline', () => {
  const snap = require('../local-ai/catalog-snapshot.json');
  assert.ok(snap.models.length >= 150, snap.models.length);
  assert.ok(Date.parse(snap.fetchedAt));
  assert.ok(snap.tags.gemma3 && snap.tags.gemma3.tags.some(t => t.tag === 'gemma3:270m' && t.size > 2e8));
  assert.ok(!snap.models.some(m => m.capabilities.includes('cloud')));
  // (a tag shown as a size range has each variant's size from the registry)
  const ranged = snap.tags.gemma4.tags.filter(t => t.ranged);
  assert.ok(ranged.length >= 5 && ranged.every(t => t.variants && t.variants.apple > 1e9 && t.variants.other > 1e9), JSON.stringify(ranged));
});

test('recommendations from the shipped snapshot, offline, take the variant the Ollama here takes: gemma4:e2b on an 8 GB PC, none on an 8 GB Mac with Apple Silicon; nemotron-3-nano:30b fits a 32 GB Mac', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-snapshot-'));
  try {
    const models = createCatalog({ dataDir: dir, fetch: () => Promise.reject(new TypeError('fetch failed')) }).list().models;
    const pick = (device, name) => (recommend(models, device, { perTier: 1000 }).tiers.flatMap(t => t.models).find(m => m.name === name) || { tag: null }).tag;
    assert.deepEqual([pick(linux(8), 'gemma4'), pick(linux(16), 'gemma4'), pick(mac(8), 'gemma4')], ['gemma4:e2b', 'gemma4:12b', null]);
    // (its MLX variant is 18.3 GB; llama.cpp's, 24.3 GB, doesn't fit a 32 GB PC)
    assert.deepEqual([pick(mac(32), 'nemotron-3-nano'), pick(linux(32), 'nemotron-3-nano')], ['nemotron-3-nano:30b', 'nemotron-3-nano:4b']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('model names: library names only, ":latest" when there is no tag, never a cloud tag; a tag keeps its case, and names that differ only in case are one model', () => {
  assert.equal(normalize('gemma3'), 'gemma3:latest');
  assert.equal(normalize('Gemma3:1B'), 'gemma3:1B');
  assert.equal(normalize('gemma4:e2b-it-q4_K_M'), 'gemma4:e2b-it-q4_K_M');        // (as ollama.com lists it)
  assert.equal(normalize('someone/model:q4'), 'someone/model:q4');
  for (const bad of ['', '../etc', 'a b', 'gpt-oss:120b-cloud', 'gpt-oss:120b-CLOUD', 'x;rm -rf', 'http://x/y', 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M']) assert.equal(normalize(bad), null, bad);
  // (the key of a download and of a model's settings)
  assert.equal(keyOf('Gemma3:1B'), 'gemma3:1b');
  assert.equal(keyOf('gemma3'), 'gemma3:latest');
  assert.equal(keyOf('hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M'), 'hf.co/bartowski/llama-3.2-1b-instruct-gguf:q4_k_m');
  assert.equal(keyOf('localhost:5000/someone/model'), 'localhost:5000/someone/model:latest');
});

// ── Recommendations ─────────────────────────────────────────────────────────

const hw = (totalGb, gpus) => ({ memory: { total: totalGb * GB, available: totalGb * GB * 0.7 }, gpus: gpus || [], os: { platform: 'linux' }, arch: 'x64', disk: { free: 100 * GB } });
// (as hardware.js describes a PC and a Mac with Apple Silicon)
const linux = gb => Object.assign(hw(gb), { appleSilicon: false });
// (its GPU's memory is what Metal may use: 2/3 of it up to 32 GiB, 3/4 above, as hardware.js says)
const metal = bytes => Math.floor(bytes * (bytes <= 32 * 2 ** 30 ? 2 / 3 : 3 / 4));
const mac = gb => Object.assign(hw(gb, [{ vendor: 'apple', name: 'Apple Silicon GPU (Metal)', memory: metal(gb * GB), shared: true, usable: true }]), { os: { platform: 'darwin' }, arch: 'arm64', appleSilicon: true });
const catalogModels = () => {
  const models = parseLibrary(LIBRARY_HTML).map(m => Object.assign(m, { categories: categories(m) }));
  const tags = parseTags(TAGS_HTML, 'gemma3');
  models[0].tags = mainTags(models[0], tags);
  return models;
};

test('recommendations never exceed what the device can hold; the best tag that fits; tiers by real size', () => {
  // the measured footprint: gemma3:270m (292 MB) used 326 MB on CPU — the estimate is at least that, not wildly more
  const need270 = ramNeeded(292e6, 268e6);
  assert.ok(need270 >= 326e6 && need270 < 500e6, need270);
  for (const total of [2, 4, 8, 16, 64]) {
    const r = recommend(catalogModels(), hw(total));
    const all = r.tiers.flatMap(t => t.models);
    assert.ok(all.every(m => m.need <= r.device.budget), total + ' GB: ' + JSON.stringify(all.map(m => [m.tag, m.need])));
  }
  // 2 GB: only the 270m fits (the budget keeps 1.5 GB for the system)
  const tiny = recommend(catalogModels(), hw(2));
  const g = tiny.tiers.flatMap(t => t.models).find(m => m.name === 'gemma3');
  assert.equal(g.tag, 'gemma3:270m');
  assert.equal(tiny.tiers.find(t => t.id === 'ultra').models.some(m => m.name === 'gemma3'), true);
  // 8 GB: the biggest gemma3 that fits is 4b; it's in "Low resource"… or "Balanced" by its real need
  const mid = recommend(catalogModels(), hw(8)).tiers.flatMap(t => t.models).find(m => m.name === 'gemma3');
  assert.equal(mid.tag, 'gemma3:4b');
  assert.equal(mid.estimated, false);
  // A GPU with enough memory: the card says so
  const gpu = recommend(catalogModels(), hw(16, [{ vendor: 'nvidia', name: 'RTX', memory: 12 * GB, usable: true }]));
  assert.equal(gpu.device.gpu.name, 'RTX');
  assert.equal(gpu.tiers.flatMap(t => t.models).find(m => m.name === 'gemma3').runsOn, 'gpu');
  // 1 GB: nothing fits, and nothing is recommended
  assert.equal(recommend(catalogModels(), hw(1)).tiers.flatMap(t => t.models).length, 0);
});

// ── This device on other systems (hardware.js, with what each system's tools print) ──

const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                3000.',
  'Pages active:                            400000.',
  'Pages inactive:                          300000.',
  'Pages speculative:                        20000.',
  'Pages throttled:                              0.',
  'Pages wired down:                        150000.',
  'Pages purgeable:                          10000.',
  '"Translation faults":                 123456789.',
].join('\n') + '\n';
// A Mac (or another system): what its commands print, by path
const system = (platform, arch, release, prints) => ({ platform, arch, release: () => release, run: async cmd => (prints && prints[cmd]) || null });

test('Apple Silicon: models run on its GPU (Metal), in the recommendations and in each tag\'s fit; one bigger than what Metal may use runs partly on the CPU (llama.cpp), an MLX variant on the GPU', () => {
  // (a Mac's memory is in GiB: 32 GiB is 34.4 GB)
  const mac = { memory: { total: 32 * 2 ** 30, available: 20 * GB }, gpus: [{ vendor: 'apple', name: 'Apple Silicon GPU (Metal)', memory: metal(32 * 2 ** 30), shared: true, usable: true }], os: { platform: 'darwin' }, arch: 'arm64' };
  const r = recommend(catalogModels(), mac);
  assert.deepEqual(r.device.gpu, { name: 'Apple Silicon GPU (Metal)', memory: metal(32 * 2 ** 30), shared: true });
  const all = r.tiers.flatMap(t => t.models);
  assert.ok(all.length > 0 && all.every(m => m.runsOn === 'gpu'), JSON.stringify(all.map(m => [m.tag, m.runsOn])));
  assert.equal(fit('gemma3:4b', 3.3e9, mac).runsOn, 'gpu');
  // an 8 GiB Mac: Metal may use 5.7 GB, and llama.cpp keeps 1 GiB of it free, so an 8B model (5.2 GB, and its cache)
  // is split between the GPU and the CPU; a 4B one fits. An MLX variant runs on the GPU.
  const small = { memory: { total: 8 * 2 ** 30, available: 3 * GB }, gpus: [{ vendor: 'apple', name: 'Apple Silicon GPU (Metal)', memory: metal(8 * 2 ** 30), shared: true, usable: true }], os: { platform: 'darwin' }, arch: 'arm64', appleSilicon: true };
  assert.deepEqual([fit('qwen3:8b', 5.2e9, small).runsOn, fit('gemma3:4b', 3.3e9, small).runsOn, fit('gemma4:e2b', 4.6e9, small, { mlx: true }).runsOn], ['mixed', 'gpu', 'gpu']);
  const eight = recommend(catalogModels(), Object.assign({}, small, { memory: { total: 8 * 2 ** 30, available: 6 * GB } })).tiers.flatMap(t => t.models);
  assert.ok(eight.some(m => m.runsOn === 'gpu') && eight.every(m => m.runsOn !== 'cpu'), JSON.stringify(eight.map(m => [m.tag, m.runsOn])));
  // (a GPU of its own: a model too big for it runs on the CPU, as before)
  assert.equal(fit('qwen3:8b', 5.2e9, Object.assign({}, small, { gpus: [{ vendor: 'nvidia', name: 'RTX', memory: 4 * GB, usable: true }] })).runsOn, 'cpu');
  // (a GPU that can't run models still doesn't count)
  const intel = Object.assign({}, mac, { gpus: [{ vendor: 'intel', name: 'Intel integrated GPU', memory: null, usable: false }] });
  assert.equal(recommend(catalogModels(), intel).device.gpu, null);
  assert.equal(fit('gemma3:4b', 3.3e9, intel).runsOn, 'cpu');
});

test('a Mac\'s available memory: its free, inactive, speculative and purgeable pages (vm_stat); unknown when vm_stat can\'t say, and then whatever is in the budget fits', async () => {
  const hw = await createHardware({ system: system('darwin', 'arm64', '24.1.0', { '/usr/bin/vm_stat': VM_STAT, '/usr/bin/sw_vers': '15.1\n' }) }).detect();
  const available = Math.min(os.totalmem(), (3000 + 300000 + 20000 + 10000) * 16384);
  assert.equal(hw.memory.available, available);
  assert.equal(vmStatAvailable(VM_STAT.replace(/page size of \d+/, 'page size of 4096'), 64 * GB), (3000 + 300000 + 20000 + 10000) * 4096);
  assert.equal(vmStatAvailable(VM_STAT.replace(/^Pages inactive.*$/m, ''), 64 * GB), null);
  assert.equal(vmStatAvailable('', 64 * GB), null);
  const mac = { memory: { total: 16 * GB, available: 5 * GB }, gpus: [], os: { platform: 'darwin' } };
  assert.equal(fit('x:8b', 7e9, mac).level, 'tight');
  const unknown = await createHardware({ system: system('darwin', 'arm64', '24.1.0', {}) }).detect();
  assert.equal(unknown.memory.available, null);
  assert.equal(fit('x:8b', 7e9, Object.assign({}, mac, { memory: { total: 16 * GB, available: null } })).level, 'good');
  assert.equal(fit('x:70b', 40e9, Object.assign({}, mac, { memory: { total: 16 * GB, available: null } })).level, 'too-big');
  assert.equal(recommend(catalogModels(), Object.assign({}, mac, { memory: { total: 16 * GB, available: null } })).device.availableMemory, null);
});

test('the macOS version: sw_vers\'s, or from the Darwin release when sw_vers can\'t say (Darwin 24 is macOS 15, Darwin 25 macOS 26)', async () => {
  const name = async (said, release) => (await createHardware({ system: system('darwin', 'arm64', release, { '/usr/bin/sw_vers': said }) }).detect()).os.name;
  assert.equal(await name('15.1\n', '24.1.0'), 'macOS 15.1');
  assert.equal(await name('26.0.1\n', '25.0.0'), 'macOS 26.0.1');
  assert.equal(await name(null, '24.1.0'), 'macOS 15');
  assert.equal(await name(null, '20.6.0'), 'macOS 11');
  assert.equal(await name(null, '25.1.0'), 'macOS 26');
  assert.equal(await name(null, '19.6.0'), 'macOS 10.15');
  assert.equal(await name('not a version', 'x'), 'macOS');
});

test('a Mac with Apple Silicon is recognised under Rosetta too (an Intel MetaCode next to an arm64 Ollama): its GPU and its row in the matrix', async () => {
  const rosetta = await createHardware({ system: system('darwin', 'x64', '24.1.0', { '/usr/sbin/sysctl': '1\n' }) }).detect();
  assert.deepEqual([rosetta.appleSilicon, rosetta.gpus.map(g => g.vendor), platformId(rosetta)], [true, ['apple'], 'macos-arm']);
  // (its GPU's memory: what Metal may keep resident, not all of it)
  assert.deepEqual([rosetta.gpus[0].memory, rosetta.gpus[0].shared], [metal(os.totalmem()), true]);
  const intel = await createHardware({ system: system('darwin', 'x64', '24.1.0', { '/usr/sbin/sysctl': '0\n' }) }).detect();
  assert.deepEqual([intel.appleSilicon, intel.gpus.length, platformId(intel)], [false, 0, 'macos-intel']);
  const unsure = await createHardware({ system: system('darwin', 'x64', '24.1.0', {}) }).detect();
  assert.deepEqual([unsure.appleSilicon, platformId(unsure)], [null, 'macos-intel']);
  const native = await createHardware({ system: system('darwin', 'arm64', '24.1.0', {}) }).detect();
  assert.deepEqual([native.appleSilicon, native.gpus.map(g => g.vendor), platformId(native)], [true, ['apple'], 'macos-arm']);
});

test('Termux on Android (Node calls the platform "android"): recognised, its row in the matrix, and how to get Ollama there', async () => {
  const hw = await createHardware({ system: system('android', 'arm64', '5.15.0-android', {}) }).detect();
  assert.equal(hw.os.name, 'Android (Termux)');
  assert.equal(platformId(hw), 'android');
  const rt = createRuntimes({ ollama: createOllama({ env: { OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1' } }) });
  const r = await rt.list(hw);
  assert.equal(r.platform.id, 'android');
  assert.equal(r.runtimes[0].status, 'not-running');
  assert.match(r.runtimes[0].detail, /isn't answering at http:\/\/127\.0\.0\.1:9\. In Termux, install it with "pkg install ollama", then start it with "ollama serve"/);
  // (where there's no Ollama at all, it still says so)
  const arm32 = await rt.list({ os: { platform: 'linux', name: 'Raspberry Pi OS' }, arch: 'arm' });
  assert.equal(arm32.runtimes[0].status, 'unsupported');
});

test('the free disk space without blocking: a models folder that hangs (a network mount gone away) is "unknown" after 2 s, one look at a time', async () => {
  let looks = 0, answer = () => new Promise(() => {});           // (stuck for good)
  // (no commands run: only the disk is timed, not an nvidia-smi that may take a while on a machine with the driver)
  const hang = createHardware({ env: { OLLAMA_MODELS_DIR: '/mnt/nas/ollama' }, system: { run: async () => null, diskTimeoutMs: 150, stat: async () => ({}), statfs: () => { looks++; return answer(); } } });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const t0 = Date.now();
  const first = await hang.detect(true);
  clearInterval(timer);
  assert.deepEqual([first.disk.path, first.disk.free], [null, null]);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, 'answered after ' + ms + ' ms');
  assert.ok(ticks >= 5, 'the server went on meanwhile (' + ticks + ' ticks)');
  // while that look hangs, no other starts
  assert.equal((await hang.detect(true)).disk.free, null);
  assert.equal(looks, 1);
  // a folder that answers: measured; while a later look hangs, that answer
  const disks = createHardware({ env: { OLLAMA_MODELS_DIR: '/mnt/nas/ollama' }, system: { run: async () => null, diskTimeoutMs: 150, stat: async () => ({}), statfs: () => { looks++; return answer(); } } });
  answer = async () => ({ bavail: 1000, bsize: 4096, blocks: 5000 });
  assert.deepEqual([(await disks.detect(true)).disk.path, (await disks.detect(true)).disk.free], ['/mnt/nas/ollama', 4096000]);
  let unstick;
  answer = () => new Promise(r => { unstick = r; });
  assert.equal((await disks.detect(true)).disk.free, null);
  const looked = looks;
  assert.equal((await disks.detect(true)).disk.free, 4096000);
  assert.equal(looks, looked);
  unstick({ bavail: 2000, bsize: 4096, blocks: 5000 });
  await sleep(10);
  answer = async () => ({ bavail: 3000, bsize: 4096, blocks: 5000 });
  assert.equal((await disks.detect(true)).disk.free, 3000 * 4096);
});

test('before Ollama\'s first download (no models folder yet): the disk it will put models on is measured, never MetaCode\'s data folder (a portable MetaCode\'s is on its USB stick)', async () => {
  const home = os.homedir();
  const looked = [];
  const only = dirs => ({
    run: async () => null,
    stat: async d => { looked.push(d); if (!dirs.includes(d)) throw Object.assign(new Error('ENOENT: ' + d), { code: 'ENOENT' }); return {}; },
    statfs: async d => ({ bavail: d === home ? 7 : 9, bsize: 1, blocks: 10 }),
  });
  // (a portable MetaCode's data folder, which exists, on a USB stick: never what's measured, given as the option or
  // in the environment)
  const usb = path.join(path.sep, 'media', 'usb', 'MetaCode', 'data', 'local-ai-data');
  const fresh = (await createHardware({ env: { LOCAL_AI_DATA_DIR: usb, METACODE_DATA_DIR: path.dirname(usb) }, dataDir: usb, system: only([usb, path.dirname(usb), home, path.dirname(home), '/']) }).detect(true)).disk;
  assert.deepEqual([fresh.path, fresh.free, fresh.ollamaDir], [home, 7, false]);
  assert.equal(looked[0], path.join(home, '.ollama', 'models'), 'Ollama\'s own folder first');
  // OLLAMA_MODELS_DIR on another disk, not made yet: that disk
  const other = (await createHardware({ env: { OLLAMA_MODELS_DIR: '/mnt/big/ollama/models' }, system: only(['/mnt/big', '/mnt', '/', home]) }).detect(true)).disk;
  assert.deepEqual([other.path, other.free, other.ollamaDir], ['/mnt/big', 9, false]);
  // once Ollama has made its folder: that one
  const made = (await createHardware({ env: {}, system: only([path.join(home, '.ollama', 'models'), path.join(home, '.ollama'), home, '/']) }).detect(true)).disk;
  assert.deepEqual([made.path, made.ollamaDir], [path.join(home, '.ollama', 'models'), true]);
});

// ── The routes, against stand-ins ───────────────────────────────────────────

let si, api, local, localEnv, tmp, changed, hostsFile;
const disk = { free: 100 * GB };
const machine = { appleSilicon: false };
test.before(async () => {
  si = await standIns();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-local-ai-'));
  changed = [];
  localEnv = { OLLAMA_BASE_URL: si.base + '/v1', LOCAL_AI_DATA_DIR: tmp, LOCAL_AI_ADMIN_TOKEN: 'admin-token-123456' };
  // (a Debian-style hosts file: the computer's own name at 127.0.1.1; a name mapped elsewhere, or commented out, isn't its own)
  hostsFile = path.join(tmp, 'hosts');
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n127.0.1.1 myhost.lan myhost # this computer\n::1 localhost ip6-localhost\n203.0.113.5 outside.example\n# 127.0.0.1 commented.example\n');
  local = createLocalAi({
    env: localEnv, hostsFile,
    libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', minLibraryModels: 1,
    // (a request from "this machine" unless the test says it came through a proxy)
    isLoopback: req => req.get('x-test-remote') !== '1',
    hardware: { detect: async () => ({ os: { platform: 'linux', name: 'Test Linux' }, arch: 'x64', appleSilicon: machine.appleSilicon, cpu: { model: 'Test CPU', threads: 4 }, memory: { total: 16 * GB, available: 12 * GB }, gpus: [], disk: { path: tmp, free: disk.free, total: 200 * GB } }) },
    onModelsChanged: (what, model) => changed.push([what, model]),
  });
  const app = express();
  app.use('/api/local-ai', local.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/local-ai';
  api = async (method, p, body, headers) => {
    const res = await fetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, json, text };
  };
  api.close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  api.port = server.address().port;
  api.events = () => {
    const events = [];
    const ac = new AbortController();
    fetch(base + '/installs/events', { signal: ac.signal }).then(async res => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = (/^event: (.+)$/m.exec(block) || [])[1];
          const data = (/^data: (.+)$/m.exec(block) || [])[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    }).catch(() => {});
    return { events, stop: () => ac.abort() };
  };
});
test.after(async () => {
  if (local) local.close();
  if (api) await api.close();
  if (si) await si.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
async function until(check, ms, what) {
  const deadline = Date.now() + (ms || 8000);
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) assert.fail('timed out waiting for ' + (what || 'a condition'));
    await sleep(25);
  }
}
const job = async model => (await api('GET', '/installs')).json.installs.find(j => j.model === model);
// A request with any Host header (a page can't choose it, and fetch doesn't let a test either)
const raw = (method, p, host, body, headers, port) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: port || api.port, path: '/api/local-ai' + p, method, headers: Object.assign({ host, 'content-type': 'application/json' }, headers) }, res => {
    let text = '';
    res.on('data', d => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
  });
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});

test('status, hardware and runtimes: Ollama found with its version; this machine may manage models; the compatibility matrix', async () => {
  const s = await api('GET', '/status');
  assert.equal(s.status, 200);
  assert.deepEqual([s.json.ollama.running, s.json.ollama.version, s.json.manage.allowed, s.json.manage.how], [true, '0.40.17', true, 'this-machine']);
  const remote = await api('GET', '/status', undefined, { 'x-test-remote': '1' });
  assert.equal(remote.json.manage.allowed, false);
  assert.match(remote.json.manage.reason, /admin token \(LOCAL_AI_ADMIN_TOKEN\)/);
  assert.equal((await api('GET', '/hardware')).json.cpu.threads, 4);
  const r = await api('GET', '/runtimes');
  assert.equal(r.json.runtimes[0].id, 'ollama');
  assert.equal(r.json.runtimes[0].status, 'running');
  assert.equal(r.json.platform.id, 'linux-x64');
  assert.ok(r.json.matrix.find(x => x.id === 'ios').ollama === 'no');
});

test('the catalog: read live from the library, then kept on disk; one model\'s tags each say how they fit this device', async () => {
  const c = await api('GET', '/catalog');
  assert.equal(c.json.source, 'live');
  assert.deepEqual(c.json.models.map(m => m.name), ['gemma3', 'deepseek-r1', 'nomic-embed-text', 'qwen2.5-coder']);
  assert.ok(fs.existsSync(path.join(tmp, 'catalog.json')));
  const g = await api('GET', '/catalog/model?name=gemma3&refresh=1');       // (every tag, from the tags page)
  assert.equal(g.status, 200);
  const t270 = g.json.tags.find(t => t.tag === 'gemma3:270m');
  assert.equal(t270.fit.level, 'good');
  assert.equal(g.json.tags.find(t => t.tag === 'gemma3:1b-it-qat').main, false);
  assert.equal((await api('GET', '/catalog/model?name=nope')).status, 404);
  const rec = await api('GET', '/recommendations');
  assert.ok(rec.json.tiers.flatMap(t => t.models).some(m => m.tag === 'gemma3:4b'));
});

test('the catalog offline: the copy kept on disk, or the shipped snapshot on a first start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-catalog-'));
  try {
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    const fresh = createCatalog({ dataDir: dir, fetch: offline });
    const r = await fresh.refresh(true);
    assert.equal(r.ok, false);
    assert.match(r.problem, /can't be reached/);
    assert.equal(fresh.list().source, 'snapshot');
    assert.ok(fresh.list().models.length >= 150);
    // with a copy on disk, that copy (and its date)
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ fetchedAt: '2026-11-01T00:00:00.000Z', models: parseLibrary(LIBRARY_HTML), tags: {} }));
    const cached = createCatalog({ dataDir: dir, fetch: offline });
    assert.deepEqual([cached.list().source, cached.list().fetchedAt, cached.list().models.length], ['cache', '2026-11-01T00:00:00.000Z', 4]);
    // a page that changed beyond reading: the copy stays
    const changedPage = createCatalog({ dataDir: dir, fetch: async () => new Response('<html>new design</html>', { status: 200 }) });
    assert.match((await changedPage.refresh(true)).problem, /couldn't be read/);
    assert.equal(changedPage.list().models.length, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install: progress, speed and time left as events; verified against the registry\'s digest; MetaCode told; the same model never twice at once', async () => {
  const ev = api.events();
  const r = await api('POST', '/installs', { model: 'gemma3:1b' });
  assert.equal(r.status, 202);
  assert.equal(r.json.job.model, 'gemma3:1b');
  const again = await api('POST', '/installs', { model: 'Gemma3:1b' });
  assert.equal(again.status, 200);
  assert.equal(again.json.already, true);
  await until(async () => { const j = await job('gemma3:1b'); return j && j.state === 'done'; }, 10000, 'the install');
  const j = await job('gemma3:1b');
  assert.equal(j.verified, true);
  assert.match(j.status, /verified/);
  assert.equal(si.st.pulls.filter(m => m === 'gemma3:1b').length, 1, 'one download');
  assert.deepEqual(changed.pop(), ['installed', 'gemma3:1b']);
  await sleep(50);
  ev.stop();
  const progress = ev.events.filter(e => e.type === 'job' && e.data.state === 'downloading' && e.data.percent !== null);
  assert.ok(progress.length >= 2, JSON.stringify(ev.events.map(e => e.data.state)));
  assert.ok(progress.some(e => e.data.percent > 0 && e.data.percent < 100));
  assert.ok(progress.every(e => e.data.total >= MODEL_BYTES));
  assert.ok(ev.events.some(e => e.data.state === 'done'));
  assert.equal(ev.events[0].type, 'snapshot');
  // Installed models: details, loaded or not, the space they use
  const m = await api('GET', '/models');
  assert.deepEqual(m.json.models.map(x => [x.name, x.loaded]), [['gemma3:1b', null]]);
  assert.equal(m.json.totalSize, manifestFor('gemma3:1b').size);
});

test('pause keeps what arrived and resume continues from there; cancel forgets the download', async () => {
  si.st.pullDelayMs = 60;
  await api('POST', '/installs', { model: 'qwen2.5-coder:0.5b' });
  await until(async () => { const j = await job('qwen2.5-coder:0.5b'); return j && j.completed >= MODEL_BYTES * 0.2; }, 8000, 'some progress');
  assert.equal((await api('POST', '/installs/pause', { model: 'qwen2.5-coder:0.5b' })).status, 200);
  await until(async () => (await job('qwen2.5-coder:0.5b')).state === 'paused', 5000, 'paused');
  const kept = si.st.partial.get('qwen2.5-coder:0.5b');
  assert.ok(kept > 0 && kept < MODEL_BYTES);
  si.st.pullDelayMs = 10;
  await api('POST', '/installs/resume', { model: 'qwen2.5-coder:0.5b' });
  await until(async () => (await job('qwen2.5-coder:0.5b')).state === 'done', 8000, 'done after resuming');
  const j = await job('qwen2.5-coder:0.5b');
  assert.equal(j.resumed, true, 'Ollama continued the earlier download');
  // cancel
  si.st.pullDelayMs = 80;
  await api('POST', '/installs', { model: 'deepseek-r1:1.5b' });
  await until(async () => { const x = await job('deepseek-r1:1.5b'); return x && x.state === 'downloading'; });
  await api('POST', '/installs/cancel', { model: 'deepseek-r1:1.5b' });
  await until(async () => !(await job('deepseek-r1:1.5b')), 5000, 'gone');
  si.st.pullDelayMs = 25;
});

test('problems: no such model, not enough disk, an interrupted download (resumable), a digest that doesn\'t match', async () => {
  // a name the library doesn't have
  await api('POST', '/installs', { model: 'missing-model:1b' });
  await until(async () => { const j = await job('missing-model:1b'); return j && j.state === 'failed'; });
  assert.equal((await job('missing-model:1b')).code, 'not_in_library');
  // not enough disk for the manifest's size
  disk.free = MODEL_BYTES / 2;
  await api('POST', '/installs', { model: 'gemma3:4b' });
  await until(async () => { const j = await job('gemma3:4b'); return j && j.state === 'failed'; });
  const d = await job('gemma3:4b');
  assert.equal(d.code, 'insufficient_disk');
  assert.match(d.error, /Not enough disk space: gemma3:4b needs/);
  assert.ok(!si.st.pulls.includes('gemma3:4b'), 'nothing downloaded');
  disk.free = 100 * GB;
  // the stream stops half-way: failed, and resuming continues
  si.st.breakAt = MODEL_BYTES / 2;
  await api('POST', '/installs', { model: 'gemma3:270m' });
  await until(async () => { const j = await job('gemma3:270m'); return j && j.state === 'failed'; });
  const broken = await job('gemma3:270m');
  assert.equal(broken.code, 'interrupted');
  assert.match(broken.error, /Resume to continue/);
  await api('POST', '/installs/resume', { model: 'gemma3:270m' });
  await until(async () => (await job('gemma3:270m')).state === 'done');
  assert.equal((await job('gemma3:270m')).verified, true);
  // installed, but not what the registry has
  si.st.wrongDigest = true;
  await api('POST', '/installs', { model: 'nomic-embed-text:latest' });
  await until(async () => { const j = await job('nomic-embed-text:latest'); return j && j.state === 'done'; });
  assert.equal((await job('nomic-embed-text:latest')).verified, false);
  si.st.wrongDigest = false;
  assert.equal((await api('POST', '/installs', { model: '../../etc/passwd' })).status, 400);
});

test('a download that makes no progress for OLLAMA_PULL_IDLE_SECONDS is stopped as interrupted, and resuming continues', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-local-ai-idle-'));
  const quick = createLocalAi({
    env: { OLLAMA_BASE_URL: si.base + '/v1', LOCAL_AI_DATA_DIR: dir, OLLAMA_PULL_IDLE_SECONDS: '1' },
    libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', minLibraryModels: 1, isLoopback: () => true,
    hardware: { detect: async () => ({ os: { platform: 'linux' }, arch: 'x64', cpu: { threads: 4 }, memory: { total: 16 * GB, available: 12 * GB }, gpus: [], disk: { path: dir, free: 100 * GB, total: 200 * GB } }) },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/local-ai', quick.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const call = async (method, p, body) => (await fetch('http://127.0.0.1:' + server.address().port + '/api/local-ai' + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  const state = async () => (await call('GET', '/installs')).installs.find(j => j.model === 'deepseek-r1:1.5b');
  const delay = si.st.pullDelayMs;
  try {
    si.st.pullDelayMs = 2500;                  // (Ollama goes quiet: nothing for 2.5 s between steps)
    await call('POST', '/installs', { model: 'deepseek-r1:1.5b' });
    await until(async () => { const j = await state(); return j && j.state === 'failed'; }, 8000, 'the stalled download to stop');
    const j = await state();
    assert.equal(j.code, 'interrupted');
    assert.match(j.error, /nothing arrived for 1 s.*Resume to continue/);
    si.st.pullDelayMs = delay;
    await call('POST', '/installs/resume', { model: 'deepseek-r1:1.5b' });
    await until(async () => (await state()).state === 'done', 8000, 'the resumed download');
  } finally {
    si.st.pullDelayMs = delay;
    quick.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installed models: load, unload with keep-alive from the model\'s settings, delete (not while downloading), update', async () => {
  const bad = await api('PUT', '/models/settings', { model: 'gemma3:1b', settings: { temperature: 7 } });
  assert.equal(bad.status, 400);
  const s = await api('PUT', '/models/settings', { model: 'gemma3:1b', settings: { temperature: 0.3, maxTokens: 512, keepAliveMinutes: 30 } });
  assert.deepEqual(s.json.settings, { temperature: 0.3, maxTokens: 512, keepAliveMinutes: 30 });
  assert.deepEqual(local.modelSettings('ollama/gemma3:1b'), { temperature: 0.3, maxTokens: 512, keepAliveMinutes: 30 });
  let m = await api('POST', '/models/load', { model: 'gemma3:1b' });
  assert.deepEqual(si.st.loads.pop(), ['gemma3:1b', '30m']);
  assert.ok(m.json.models.find(x => x.name === 'gemma3:1b').loaded);
  m = await api('POST', '/models/unload', { model: 'gemma3:1b' });
  assert.equal(m.json.models.find(x => x.name === 'gemma3:1b').loaded, null);
  // update = pull again
  const u = await api('POST', '/models/update', { model: 'gemma3:1b' });
  assert.equal(u.status, 202);
  assert.equal(u.json.job.update, true);
  await until(async () => (await job('gemma3:1b')).state === 'done');
  // delete: not while it downloads
  si.st.pullDelayMs = 80;
  await api('POST', '/installs', { model: 'deepseek-r1:7b' });
  await until(async () => { const x = await job('deepseek-r1:7b'); return x && x.state === 'downloading'; });
  assert.equal((await api('POST', '/models/delete', { model: 'deepseek-r1:7b' })).status, 409);
  await api('POST', '/installs/cancel', { model: 'deepseek-r1:7b' });
  si.st.pullDelayMs = 25;
  const del = await api('POST', '/models/delete', { model: 'gemma3:1b' });
  assert.equal(del.status, 200);
  assert.ok(!del.json.models.some(x => x.name === 'gemma3:1b'));
  assert.deepEqual(changed.pop(), ['deleted', 'gemma3:1b']);
  assert.equal(local.modelSettings('gemma3:1b'), null, 'its settings went with it');
  assert.equal((await api('POST', '/models/delete', { model: 'gemma3:1b' })).status, 404);
});

test('managing models from another device needs the admin token; browsing doesn\'t', async () => {
  const remote = { 'x-test-remote': '1' };
  for (const [method, p, body] of [['POST', '/installs', { model: 'gemma3:270m' }], ['POST', '/models/delete', { model: 'gemma3:270m' }], ['POST', '/models/load', { model: 'gemma3:270m' }], ['PUT', '/models/settings', { model: 'gemma3:270m', settings: {} }], ['POST', '/installs/cancel', { model: 'x:1' }], ['POST', '/runtimes/scan']]) {
    const r = await api(method, p, body, remote);
    assert.equal(r.status, 403, p);
    assert.equal(r.json.error.code, 'manage_locked');
  }
  assert.equal((await api('GET', '/catalog', undefined, remote)).status, 200);
  assert.equal((await api('GET', '/models', undefined, remote)).status, 200);
  const wrong = await api('POST', '/models/load', { model: 'gemma3:270m' }, Object.assign({ 'x-metacode-admin-token': 'nope' }, remote));
  assert.equal(wrong.status, 403);
  const right = await api('POST', '/models/load', { model: 'gemma3:270m' }, Object.assign({ 'x-metacode-admin-token': 'admin-token-123456' }, remote));
  assert.equal(right.status, 200);
  assert.equal((await api('GET', '/status', undefined, Object.assign({ 'x-metacode-admin-token': 'admin-token-123456' }, remote))).json.manage.how, 'token');
});

test('another website whose name is pointed at 127.0.0.1 (DNS rebinding) gets nothing, reads included; PUBLIC_URL\'s site may read; only this machine\'s own names may manage', async () => {
  const evil = ['evil.example:' + api.port, 'evil.example', '127.0.0.1.evil.example', 'localhost.evil.example:' + api.port];
  for (const host of evil) {
    for (const [method, p, body] of [['GET', '/status'], ['GET', '/hardware'], ['GET', '/models'], ['GET', '/catalog'], ['GET', '/installs'], ['POST', '/models/load', { model: 'gemma3:270m' }]]) {
      const r = await raw(method, p, host, body);
      assert.deepEqual([r.status, r.json.error.code], [403, 'foreign_host'], host + ' ' + p);
    }
  }
  const refusal = await raw('GET', '/hardware', 'evil.example');
  assert.match(refusal.json.error.message, /answers MetaCode's own pages only: open MetaCode at localhost, 127\.0\.0\.1 or this computer's host name, not "evil\.example"\. .*X-Forwarded-For.*PUBLIC_URL.*TRUST_PROXY/);
  // (the page it answers may be the other website's: this computer's name isn't in it, nor the home folder's)
  const realHostname = os.hostname;
  os.hostname = () => 'Johns-MacBook-Pro.local';
  try {
    const told = await raw('GET', '/hardware', 'evil.example');
    assert.equal(told.status, 403);
    assert.doesNotMatch(JSON.stringify(told.json), /johns/i);
  } finally { os.hostname = realHostname; }
  // (a page can add X-Forwarded-For and the like to its own requests: they count only from a proxy TRUST_PROXY names)
  for (const fwd of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }]) {
    for (const p of ['/hardware', '/models', '/status', '/installs']) {
      const r = await raw('GET', p, 'evil.example:' + api.port, undefined, fwd);
      assert.deepEqual([r.status, r.json.error.code], [403, 'foreign_host'], JSON.stringify(fwd) + ' ' + p);
    }
  }
  for (const host of ['localhost:' + api.port, '127.0.0.1:' + api.port, '127.1.2.3', '[::1]:' + api.port, 'metacode.localhost']) {
    assert.equal((await raw('GET', '/status', host)).json.manage.allowed, true, host);
  }
  // this computer's own names: what its hosts file maps to a loopback address (Debian and Raspberry Pi OS: its host
  // name, at 127.0.1.1), and 0.0.0.0. No other site can have a browser send them, so they read; managing needs
  // localhost (a proxy on this computer may send them too)
  for (const host of ['myhost', 'myhost:' + api.port, 'MYHOST.LAN', '0.0.0.0:' + api.port]) {
    const s = await raw('GET', '/status', host);
    assert.deepEqual([s.status, s.json.manage.allowed], [200, false], host);
    assert.equal((await raw('GET', '/hardware', host)).status, 200, host);
    const m = await raw('POST', '/models/load', host, { model: 'gemma3:270m' });
    assert.deepEqual([m.status, m.json.error.code], [403, 'manage_locked'], host);
  }
  // not those the hosts file doesn't give to a loopback address, or only in a comment, or a name that merely
  // contains one: and not what os.hostname() says, which a network can set (a Mac takes it from DHCP or reverse DNS)
  for (const host of ['outside.example', 'commented.example', 'myhost.evil.example', 'evil.myhost', 'xmyhost', 'myhost.lan.evil.example']) assert.equal((await raw('GET', '/hardware', host)).status, 403, host);
  if (process.platform !== 'win32') {
    os.hostname = () => 'rebind.attacker.example';
    try { assert.equal((await raw('GET', '/hardware', 'rebind.attacker.example')).status, 403, 'a name the network gave this computer'); } finally { os.hostname = realHostname; }
  }
  // a hosts file that changes is read again
  fs.appendFileSync(hostsFile, '127.0.0.2 later.lan\n');
  assert.equal((await raw('GET', '/hardware', 'later.lan')).status, 200);
  // an address as the name (http://192.168.1.20:3000 opened here): no other website's name is an address
  for (const host of ['192.168.1.20:' + api.port, '[fe80::1]:' + api.port, '203.0.113.9']) assert.equal((await raw('GET', '/hardware', host)).status, 200, host);
  // behind a proxy TRUST_PROXY names ("loopback"): what it forwards is a visitor's, under the site's name, so it
  // reads; it never manages unless with the admin token, also when the proxy sends no X-Forwarded-For and puts
  // 127.0.0.1 in the Host header (nginx with only proxy_pass)
  const behind = express();
  behind.set('trust proxy', 'loopback');
  behind.use('/api/local-ai', local.router);
  const proxied = http.createServer(behind);
  await new Promise(r => proxied.listen(0, '127.0.0.1', r));
  const at = proxied.address().port;
  try {
    assert.equal((await raw('GET', '/hardware', 'metacode.example', undefined, { 'x-forwarded-for': '203.0.113.9' }, at)).status, 200);
    const visitor = await raw('POST', '/models/load', 'metacode.example', { model: 'gemma3:270m' }, { 'x-forwarded-for': '203.0.113.9' }, at);
    assert.deepEqual([visitor.status, visitor.json.error.code], [403, 'manage_locked']);
    const bare = await raw('GET', '/status', '127.0.0.1:3000', undefined, {}, at);
    assert.deepEqual([bare.status, bare.json.manage.allowed, bare.json.manage.how], [200, false, null]);
    assert.deepEqual([(await raw('POST', '/models/load', '127.0.0.1:3000', { model: 'gemma3:270m' }, {}, at)).json.error.code], ['manage_locked']);
    const token = await raw('POST', '/models/load', '127.0.0.1:3000', { model: 'gemma3:270m' }, { 'x-metacode-admin-token': 'admin-token-123456' }, at);
    assert.equal(token.status, 200);
    assert.equal((await raw('GET', '/hardware', 'evil.example', undefined, {}, at)).status, 403, 'with nothing forwarded, the Host still counts');
  } finally { proxied.closeAllConnections(); await new Promise(r => proxied.close(r)); }
  // without a token set, the message says what managing behind a proxy needs
  const saved = localEnv.LOCAL_AI_ADMIN_TOKEN;
  delete localEnv.LOCAL_AI_ADMIN_TOKEN;
  try {
    const app2 = express(); app2.set('trust proxy', 'loopback'); app2.use('/api/local-ai', local.router);
    const s2 = http.createServer(app2);
    await new Promise(r => s2.listen(0, '127.0.0.1', r));
    try {
      const st = await raw('GET', '/status', 'localhost', undefined, {}, s2.address().port);
      assert.equal(st.json.manage.allowed, false);
      assert.match(st.json.manage.reason, /^Behind a reverse proxy \(TRUST_PROXY\), installing and removing models needs LOCAL_AI_ADMIN_TOKEN/);
    } finally { s2.closeAllConnections(); await new Promise(r => s2.close(r)); }
  } finally { localEnv.LOCAL_AI_ADMIN_TOKEN = saved; }
  // a reverse proxy on this machine that sends X-Forwarded-For (and keeps the site's Host), TRUST_PROXY unset: its
  // site (PUBLIC_URL) reads, never manages; a page's own X-Forwarded-For under another name reads nothing
  localEnv.PUBLIC_URL = 'https://metac0.de, https://www.metac0.de:8443';
  try {
    assert.equal((await raw('GET', '/hardware', 'metac0.de')).status, 200);
    const s = await raw('GET', '/status', 'www.metac0.de:8443');
    assert.deepEqual([s.status, s.json.manage.allowed], [200, false]);
    const m = await raw('POST', '/models/load', 'metac0.de', { model: 'gemma3:270m' });
    assert.deepEqual([m.status, m.json.error.code], [403, 'manage_locked']);
    assert.equal((await raw('GET', '/hardware', 'evil.example')).status, 403);
  } finally { delete localEnv.PUBLIC_URL; }
});

test('a browser on this computer that reaches MetaCode at one of its own network addresses (listening on every address) is this computer: another site\'s name there is refused too, the address itself reads', async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return;                                             // (no network address on this machine)
  const app = express(); app.use('/api/local-ai', local.router);
  // (on every IPv4 address, and on every address of a dual-stack machine, where Node writes this one as ::ffff:a.b.c.d)
  const listeners = [];
  for (const where of ['0.0.0.0', '::']) {
    const server = http.createServer(app);
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, where, resolve); }); listeners.push(server); } catch (e) { server.close(); }
  }
  const viaLan = (port, host, p, remote) => new Promise((resolve, reject) => {
    const req = http.request({ host: lan.address, port, localAddress: remote ? undefined : lan.address, path: '/api/local-ai' + p, headers: { host } }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    for (const server of listeners) {
      const port = server.address().port;
      for (const p of ['/status', '/hardware', '/models']) {
        const r = await viaLan(port, 'lan.evil.example:' + port, p);
        assert.deepEqual([r.status, r.json.error.code], [403, 'foreign_host'], server.address().address + ' ' + p);
      }
      for (const host of [lan.address + ':' + port, 'myhost']) assert.equal((await viaLan(port, host, '/hardware')).status, 200, host);
      // (managing from there: the admin token, as from any address that isn't loopback)
      const st = await viaLan(port, lan.address + ':' + port, '/status');
      assert.equal(st.json.manage.allowed, false);
    }
  } finally {
    for (const server of listeners) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  }
});

test('Ollama not running: the store still browses (catalog, recommendations), and says how to install Ollama', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-no-ollama-'));
  const off = createLocalAi({ env: { OLLAMA_BASE_URL: 'http://127.0.0.1:9/v1', LOCAL_AI_DATA_DIR: dir }, libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', isLoopback: () => true });
  const app = express(); app.use('/x', off.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const at = p => fetch('http://127.0.0.1:' + server.address().port + '/x' + p).then(async r => ({ status: r.status, json: await r.json() }));
  try {
    const s = await at('/status');
    assert.deepEqual([s.status, s.json.ollama.running], [200, false]);
    const rt = await at('/runtimes');
    assert.equal(rt.json.runtimes[0].status, 'not-running');
    assert.match(rt.json.runtimes[0].detail, /Install it from ollama\.com/);
    assert.equal((await at('/catalog')).status, 200);
    const m = await at('/models');
    assert.equal(m.status, 503);
    assert.match(m.json.error.message, /isn't answering/);
  } finally {
    off.close();
    await new Promise(r => { server.closeAllConnections(); server.close(r); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fixes from the review ───────────────────────────────────────────────────

test('the disk check counts only what a download still needs: a resume what didn\'t arrive, an update only the layers that changed', async () => {
  try {
    // an interrupted download: 4.5 of the 6 MB arrived, and Ollama keeps them (the disk measured here isn't
    // Ollama's models folder: what arrived in this run counts)
    si.st.breakAt = MODEL_BYTES * 0.75;
    await api('POST', '/installs', { model: 'deepseek-r1:8b' });
    await until(async () => { const j = await job('deepseek-r1:8b'); return j && j.state === 'failed'; }, 8000, 'the interrupted download');
    // room for the rest and the margin, not for all of it: resuming works
    disk.free = MODEL_BYTES * 0.25 + 800 + 512e6 + 1e6;
    await api('POST', '/installs/resume', { model: 'deepseek-r1:8b' });
    await until(async () => (await job('deepseek-r1:8b')).state === 'done', 8000, 'the resumed download');
    assert.equal((await job('deepseek-r1:8b')).verified, true);
    // an update when nothing changed in the library: nothing to download, however full the disk
    disk.free = 100e6;
    assert.equal((await api('POST', '/models/update', { model: 'deepseek-r1:8b' })).status, 202);
    await until(async () => { const j = await job('deepseek-r1:8b'); return j && j.update && j.state === 'done'; }, 8000, 'the update');
    // new weights in the library: those are needed (Ollama keeps the old ones until the new manifest is written)
    si.st.revisions.set('deepseek-r1:8b', 2);
    await api('POST', '/models/update', { model: 'deepseek-r1:8b' });
    await until(async () => { const j = await job('deepseek-r1:8b'); return j && j.update && j.state === 'failed'; }, 8000, 'the update without room');
    const j = await job('deepseek-r1:8b');
    assert.equal(j.code, 'insufficient_disk');
    assert.match(j.error, /^Not enough disk space: deepseek-r1:8b needs 6 MB more \(and 512 MB to spare\), and .* has 100 MB free\./);
  } finally {
    disk.free = 100 * GB;
    si.st.breakAt = null;
    si.st.revisions.clear();
    si.st.installed.delete('deepseek-r1:8b');
  }
});

test('the disk check asks Ollama about the layers 16 at a time (an MLX variant has a thousand and more)', async () => {
  let active = 0, most = 0, asked = 0;
  const blobs = Array.from({ length: 1200 }, (_, i) => ({ digest: 'sha256:' + String(i).padStart(64, '0'), size: 1e6 }));
  const ollama = { hasBlob: async d => { asked++; active++; most = Math.max(most, active); await sleep(1); active--; return Number(d.slice(-4)) % 2 === 0; } };
  const installs = createInstalls({ ollama, catalog: { manifest: async () => ({ ok: true, size: 1200e6, digest: 'f'.repeat(64), blobs }) },
    hardware: { detect: async () => ({ disk: { path: '/models', free: 1e9 } }) } });
  installs.start('gemma4:e2b-mlx');
  await until(() => installs.list()[0].state === 'failed', 8000, 'the disk check');
  const j = installs.list()[0];
  assert.equal(j.code, 'insufficient_disk');
  assert.match(j.error, /^Not enough disk space: gemma4:e2b-mlx needs 600 MB more \(and 512 MB to spare\), and \/models has 1\.0 GB free\./);
  assert.deepEqual([asked, most], [1200, 16]);
});

test('the disk check after MetaCode starts again or a Cancel: what Ollama keeps of a layer, read from its models folder; a part Ollama has removed counts whole', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ollama-models-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-restart-'));
  const room = { path: models, free: 100 * GB, total: 200 * GB, ollamaDir: true };
  // (MetaCode's downloads, made again as when MetaCode starts)
  const start = () => createInstalls({ ollama: createOllama({ env: { OLLAMA_BASE_URL: si.base + '/v1' } }), catalog: createCatalog({ dataDir: dir, registry: si.base + '/v2/library/' }),
    hardware: { detect: async () => ({ disk: Object.assign({}, room) }) } });
  const ended = async (installs, model) => {
    await until(() => { const j = installs.list().find(x => x.model === model); return j && ['done', 'failed'].includes(j.state); }, 8000, model);
    return installs.list().find(x => x.model === model);
  };
  const recordOf = model => path.join(models, 'blobs', manifestFor(model).layers[0].digest.replace(':', '-') + '-partial-0');
  // an interrupted download: 4.5 of the 6 MB arrived, and Ollama keeps them
  const interrupted = async (installs, model) => {
    room.free = 100 * GB;
    si.st.breakAt = MODEL_BYTES * 0.75;
    installs.start(model);
    assert.equal((await ended(installs, model)).code, 'interrupted');
    assert.equal(JSON.parse(fs.readFileSync(recordOf(model), 'utf8')).Completed, MODEL_BYTES * 0.75);
  };
  const rest = MODEL_BYTES * 0.25 + 800 + 512e6 + 1e6;          // (room for the rest and the margin, not for all of it)
  const names = ['qwen3:8b', 'mistral:7b', 'llama3.2:3b', 'phi4:14b'];
  si.st.modelsDir = models;
  let installs = start();
  try {
    // MetaCode starts again (it lists no download any more), and Install continues
    await interrupted(installs, 'qwen3:8b');
    installs.close();
    installs = start();
    assert.equal(installs.list().length, 0);
    room.free = rest;
    installs.start('qwen3:8b');
    let j = await ended(installs, 'qwen3:8b');
    assert.deepEqual([j.state, j.resumed, j.verified], ['done', true, true], j.error);
    assert.ok(!fs.existsSync(recordOf('qwen3:8b')));
    // cancelled while downloading, then Install again
    si.st.pullDelayMs = 60;
    room.free = 100 * GB;
    installs.start('mistral:7b');
    await until(() => installs.list().find(x => x.model === 'mistral:7b').completed >= MODEL_BYTES / 2, 8000, 'half of it');
    installs.cancel('mistral:7b');
    await until(() => !installs.list().some(x => x.model === 'mistral:7b') && fs.existsSync(recordOf('mistral:7b')), 5000, 'cancelled, and the part kept');
    si.st.pullDelayMs = 25;
    room.free = MODEL_BYTES - JSON.parse(fs.readFileSync(recordOf('mistral:7b'), 'utf8')).Completed + 800 + 512e6 + 0.5e6;
    installs.start('mistral:7b');
    j = await ended(installs, 'mistral:7b');
    assert.deepEqual([j.state, j.resumed], ['done', true], j.error);
    // a model of many tensor files keeps a layer's start in a .tmp file
    fs.writeFileSync(path.join(models, 'blobs', manifestFor('llama3.2:3b').layers[0].digest.replace(':', '-') + '.tmp'), Buffer.alloc(MODEL_BYTES * 0.75));
    room.free = rest;
    installs.start('llama3.2:3b');
    assert.equal((await ended(installs, 'llama3.2:3b')).state, 'done');
    // Ollama started again more than an hour later and removed the part: what arrived before is gone, in this run
    // (Resume) and after MetaCode starts again
    await interrupted(installs, 'phi4:14b');
    fs.rmSync(recordOf('phi4:14b'));
    si.st.partial.delete('phi4:14b');
    room.free = rest;
    installs.resume('phi4:14b');
    j = await ended(installs, 'phi4:14b');
    assert.equal(j.code, 'insufficient_disk');
    assert.match(j.error, /^Not enough disk space: phi4:14b needs 7 MB \(and 512 MB to spare\)/);
    installs.close();
    installs = start();
    installs.start('phi4:14b');
    assert.equal((await ended(installs, 'phi4:14b')).code, 'insufficient_disk');
  } finally {
    installs.close();
    si.st.modelsDir = null;
    si.st.breakAt = null;
    si.st.pullDelayMs = 25;
    for (const name of names) { si.st.installed.delete(name); si.st.partial.delete(name); }
    fs.rmSync(models, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the disk check doesn\'t hang on a models folder that stopped answering (a network mount gone away): after 2 s it goes on as if the folder can\'t be read, Cancel works meanwhile, one look at a time', { skip: process.platform === 'win32' && 'no FIFOs' }, async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ollama-hung-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-hung-'));
  fs.mkdirSync(path.join(models, 'blobs'));
  // (a read of a FIFO waits until something writes to it, as a read on a dead mount waits)
  const fifo = path.join(models, 'blobs', 'sha256-' + 'a'.repeat(64) + '-partial-0');
  require('child_process').execFileSync('mkfifo', [fifo]);
  // (the reads waiting on it get this and go on; without one waiting, nothing happens)
  const answer = () => { try { const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); fs.writeSync(fd, JSON.stringify({ N: 0, Offset: 0, Size: 1, Completed: 0 })); fs.closeSync(fd); } catch (e) { /* none waiting */ } };
  const installs = createInstalls({ ollama: createOllama({ env: { OLLAMA_BASE_URL: si.base + '/v1' } }), catalog: createCatalog({ dataDir: dir, registry: si.base + '/v2/library/' }),
    hardware: { detect: async () => ({ disk: { path: models, free: 100 * GB, total: 200 * GB, ollamaDir: true } }) }, keptWaitMs: 1500 });
  const jobOf = model => installs.list().find(x => x.model === model);
  try {
    // Cancel while it waits on the folder: cancelled at once, not after the wait
    installs.start('qwen3:8b');
    await until(() => (jobOf('qwen3:8b') || {}).state === 'checking', 5000, 'checking');
    await sleep(150);
    const t0 = Date.now();
    installs.cancel('qwen3:8b');
    await until(() => !jobOf('qwen3:8b'), 3000, 'cancelled');
    assert.ok(Date.now() - t0 < 1000, (Date.now() - t0) + ' ms');
    // (that look still waits on the folder: the next install doesn't start another, and isn't held up)
    const t1 = Date.now();
    installs.start('mistral:7b');
    await until(() => (jobOf('mistral:7b') || {}).state === 'downloading' || ['done', 'failed'].includes((jobOf('mistral:7b') || {}).state), 5000, 'mistral:7b past the check');
    assert.ok(Date.now() - t1 < 1000, (Date.now() - t1) + ' ms');
    await until(() => ['done', 'failed'].includes(jobOf('mistral:7b').state), 8000, 'mistral:7b');
    assert.deepEqual([jobOf('mistral:7b').state, jobOf('mistral:7b').verified], ['done', true], jobOf('mistral:7b').error);
    // the folder answers again: the look that waited on it reads the answer and ends, so the next install looks
    // again, and waits on the folder (its FIFO, here) for its 1.5 s at most. (A look that never ended would make
    // every later install go on at once, as for a folder that can't be read, and the disk check would never read
    // Ollama's folder again.)
    answer();
    await sleep(200);
    const t2 = Date.now();
    installs.start('llama3.2:3b');
    await until(() => (jobOf('llama3.2:3b') || {}).state === 'downloading' || ['done', 'failed'].includes((jobOf('llama3.2:3b') || {}).state), 5000, 'llama3.2:3b past the check');
    const ms = Date.now() - t2;
    assert.ok(ms >= 1400 && ms < 2500, 'past the check after ' + ms + ' ms');
    await until(() => ['done', 'failed'].includes(jobOf('llama3.2:3b').state), 8000, 'llama3.2:3b');
    assert.equal(jobOf('llama3.2:3b').state, 'done', jobOf('llama3.2:3b').error);
  } finally {
    installs.close();
    answer();
    for (const name of ['qwen3:8b', 'mistral:7b', 'llama3.2:3b']) { si.st.installed.delete(name); si.st.partial.delete(name); }
    fs.rmSync(models, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Ollama\'s sha256 check after a download isn\'t a stall: it gets time for what it hashes (about 20 MB a second)', async () => {
  const ollama = createOllama({ env: { OLLAMA_BASE_URL: si.base + '/v1' } });
  try {
    si.st.pullDelayMs = 5;
    si.st.verifyDelayMs = 600;                 // (quiet for 0.6 s: 6 MB to hash may take 1 s)
    const lines = [];
    await ollama.pull('verify-test:1b', l => lines.push(l.status), null, 200);
    assert.deepEqual(lines.slice(-3), ['verifying sha256 digest', 'writing manifest', 'success']);
    // a check that takes much longer is stopped, and says what took long
    si.st.verifyDelayMs = 1600;
    await assert.rejects(ollama.pull('verify-test:2b', () => {}, null, 200), e => e.code === 'interrupted' && /^Ollama's check of the download \(sha256\) took longer than 1 s\.$/.test(e.message));
    // a bigger download gets more: 30 MB of weights (and 800 bytes of template and config) take up to 2 s to hash
    for (const m of ['verify-test:4b', 'verify-test:5b']) si.st.sizes.set(m, 30e6);
    si.st.verifyDelayMs = 1500;
    await ollama.pull('verify-test:4b', () => {}, null, 200);
    si.st.verifyDelayMs = 2600;
    await assert.rejects(ollama.pull('verify-test:5b', () => {}, null, 200), e => e.code === 'interrupted' && /^Ollama's check of the download \(sha256\) took longer than 2 s\.$/.test(e.message));
    // and never less than the setting's quiet time: 6 MB with 1.5 s allowed
    si.st.verifyDelayMs = 1200;
    await ollama.pull('verify-test:6b', () => {}, null, 1500);
    // (while downloading, the quiet time is still the setting's)
    si.st.verifyDelayMs = 0;
    si.st.pullDelayMs = 400;
    await assert.rejects(ollama.pull('verify-test:3b', () => {}, null, 200), e => e.code === 'interrupted' && /stalled \(nothing arrived for 0 s\)/.test(e.message));
  } finally {
    si.st.verifyDelayMs = 0;
    si.st.pullDelayMs = 25;
    si.st.sizes.clear();
    for (const m of ['verify-test:1b', 'verify-test:2b', 'verify-test:3b', 'verify-test:4b', 'verify-test:5b', 'verify-test:6b']) si.st.installed.delete(m);
  }
});

test('pause and cancel while the model and the disk are being checked: the job stops there, and nothing is downloaded', async () => {
  const pulls = si.st.pulls.length;
  try {
    si.st.registryDelayMs = 1500;              // (the registry takes its time)
    assert.equal((await api('POST', '/installs', { model: 'qwen2.5-coder:1.5b' })).json.job.state, 'checking');
    assert.equal((await api('POST', '/installs/cancel', { model: 'qwen2.5-coder:1.5b' })).status, 200);
    await until(async () => !(await job('qwen2.5-coder:1.5b')), 1000, 'cancelled while checking');
    assert.equal((await api('POST', '/installs', { model: 'qwen2.5-coder:3b' })).json.job.state, 'checking');
    await api('POST', '/installs/pause', { model: 'qwen2.5-coder:3b' });
    await until(async () => (await job('qwen2.5-coder:3b')).state === 'paused', 1000, 'paused while checking');
    assert.equal(si.st.pulls.length, pulls, 'nothing downloaded');
    si.st.registryDelayMs = 0;
    await api('POST', '/installs/resume', { model: 'qwen2.5-coder:3b' });
    await until(async () => (await job('qwen2.5-coder:3b')).state === 'done', 8000, 'the resumed install');
    assert.deepEqual(si.st.pulls.slice(pulls), ['qwen2.5-coder:3b']);
  } finally {
    si.st.registryDelayMs = 0;
    si.st.installed.delete('qwen2.5-coder:3b');
  }
});

test('Ollama\'s registry: library models, models of other namespaces, and a registry URL with or without its trailing slash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-registry-'));
  try {
    for (const registry of [si.base + '/v2/library/', si.base + '/v2/library']) {
      const c = createCatalog({ dataDir: dir, fetch: (u, i) => fetch(u, i), registry });
      const lib = await c.manifest('gemma3:1b');
      assert.deepEqual([lib.ok, lib.digest, lib.size], [true, manifestFor('gemma3:1b').digest, MODEL_BYTES + 800], registry);
      assert.deepEqual(lib.blobs, manifestFor('gemma3:1b').layers.map(l => ({ digest: l.digest, size: l.size })));
      const other = await c.manifest('huihui_ai/deepseek-r1-abliterated:latest');
      assert.deepEqual([other.ok, other.digest], [true, manifestFor('huihui_ai/deepseek-r1-abliterated:latest').digest], registry);
      assert.deepEqual(await c.manifest('missing-model:1b'), { ok: false, missing: true });
    }
    assert.ok(si.st.registry.some(r => r.startsWith('/v2/huihui_ai/deepseek-r1-abliterated/manifests/latest ')));
    assert.ok(!si.st.registry.some(r => /librarygemma3|%2F/i.test(r)));
    // installed and verified, as Ollama pulls it
    await api('POST', '/installs', { model: 'someone/model:q4' });
    await until(async () => { const j = await job('someone/model:q4'); return j && j.state === 'done'; }, 8000, 'the install');
    assert.equal((await job('someone/model:q4')).verified, true);
  } finally {
    si.st.installed.delete('someone/model:q4');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tag with variants for several runners (a manifest list): the variant Ollama pulls here, its layers, sizes and digest; installs verified against it, MLX on Apple Silicon', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-variants-'));
  try {
    const c = createCatalog({ dataDir: dir, fetch: (u, i) => fetch(u, i), registry: si.base + '/v2/library/' });
    const [llama, mlx] = listFor('gemma4:26b').variants;
    const here = await c.manifest('gemma4:26b', { appleSilicon: false });
    assert.deepEqual([here.ok, here.digest, here.size], [true, llama.digest, MODEL_BYTES + 800]);
    assert.deepEqual(here.blobs.map(b => b.digest), llama.layers.map(l => l.digest));
    const mac = await c.manifest('gemma4:26b', { appleSilicon: true });
    assert.deepEqual([mac.digest, mac.size], [mlx.digest, MODEL_BYTES + 1e6 + 800]);
    // (asked for as Ollama asks; each variant is a blob of the model's repository)
    assert.ok(si.st.registry.some(r => r === '/v2/library/gemma4/manifests/26b application/vnd.ollama.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'));
    assert.ok(si.st.registry.some(r => r.startsWith('/v2/library/gemma4/blobs/sha256:' + mlx.digest + ' ')));
    // installs: llama.cpp on this computer, MLX on a Mac with Apple Silicon
    await api('POST', '/installs', { model: 'gemma4:26b' });
    await until(async () => { const j = await job('gemma4:26b'); return j && j.state === 'done'; }, 8000, 'the install');
    assert.deepEqual([(await job('gemma4:26b')).verified, si.st.installed.get('gemma4:26b').digest], [true, llama.digest]);
    machine.appleSilicon = true;
    si.st.runner = 'mlx';
    await api('POST', '/installs', { model: 'gemma4:e2b' });
    await until(async () => { const j = await job('gemma4:e2b'); return j && j.state === 'done'; }, 8000, 'the install on a Mac');
    const j = await job('gemma4:e2b');
    assert.deepEqual([j.verified, j.total], [true, MODEL_BYTES + 1e6 + 800]);
    assert.equal(si.st.installed.get('gemma4:e2b').digest, listFor('gemma4:e2b').variants[1].digest);
  } finally {
    machine.appleSilicon = false;
    si.st.runner = 'llamacpp';
    si.st.installed.delete('gemma4:26b');
    si.st.installed.delete('gemma4:e2b');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the variant is the one the Ollama that pulls takes: before 0.40 Ollama asks for the plain manifest and gets llama.cpp, on Apple Silicon too; any variant of the tag verifies, as an Ollama in a VM or on another computer takes its own', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ollama-version-'));
  try {
    // (MLX: Apple Silicon and Ollama 0.40 or later; an unknown version, or 0.0.0, a development build, counts as new)
    assert.deepEqual(['0.40.0', '0.40.17', '1.2.0', '0.0.0', null, '0.35.1', '0.39.9', '0.4.0'].map(v => pullsMlx(true, v)), [true, true, true, true, true, false, false, false]);
    assert.deepEqual([pullsMlx(false, '0.40.17'), pullsMlx(false, null), pullsMlx(null, '0.40.17'), pullsMlx(undefined, null), pullsMlx(null, '0.35.1')], [false, false, null, null, false]);
    // the registry asked as that Ollama asks it
    const c = createCatalog({ dataDir: dir, fetch: (u, i) => fetch(u, i), registry: si.base + '/v2/library/' });
    const [llama, mlx] = listFor('gemma4:26b').variants;
    const asked = si.st.registry.length;
    const old = await c.manifest('gemma4:26b', { appleSilicon: true, version: '0.35.1' });
    assert.deepEqual([old.digest, old.size, old.digests], [llama.digest, MODEL_BYTES + 800, [llama.digest]]);
    assert.deepEqual(si.st.registry.slice(asked), ['/v2/library/gemma4/manifests/26b application/vnd.docker.distribution.manifest.v2+json']);
    const now = await c.manifest('gemma4:26b', { appleSilicon: true, version: '0.40.17' });
    assert.deepEqual([now.digest, now.digests], [mlx.digest, [llama.digest, mlx.digest]]);
    // Ollama 0.35 on a Mac with Apple Silicon: llama.cpp's download is checked (room for it and the margin, not for
    // MLX's, 1 MB more), and its digest verifies
    machine.appleSilicon = true;
    si.st.version = '0.35.1';
    si.st.runner = 'llamacpp';
    disk.free = MODEL_BYTES + 800 + 512e6 + 0.5e6;
    await api('POST', '/installs', { model: 'gemma4:12b' });
    await until(async () => { const j = await job('gemma4:12b'); return j && ['done', 'failed'].includes(j.state); }, 8000, 'the install with Ollama 0.35');
    let j = await job('gemma4:12b');
    assert.deepEqual([j.state, j.verified, j.total], ['done', true, MODEL_BYTES + 800], j.error);
    // Ollama 0.40 in a Linux VM or container on that Mac takes llama.cpp too, where MLX was expected: still verified
    si.st.version = '0.40.17';
    disk.free = 100 * GB;
    await api('POST', '/installs', { model: 'gemma4:31b' });
    await until(async () => { const x = await job('gemma4:31b'); return x && ['done', 'failed'].includes(x.state); }, 8000, 'the install in a VM');
    j = await job('gemma4:31b');
    assert.deepEqual([j.state, j.verified, si.st.installed.get('gemma4:31b').digest], ['done', true, listFor('gemma4:31b').variants[0].digest]);
  } finally {
    machine.appleSilicon = false;
    si.st.version = '0.40.17';
    si.st.runner = 'llamacpp';
    disk.free = 100 * GB;
    si.st.installed.delete('gemma4:12b');
    si.st.installed.delete('gemma4:31b');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Details, the list and the recommendations give a tag shown as a size range at the download of the variant the Ollama here takes, and its fit from that', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ranges-'));
  // (a catalog that has gemma4; its tags page and its manifest lists are the stand-in's)
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), models: parseLibrary(LIBRARY_HTML).concat(Object.assign({ tagCount: 49, updated: null }, GEMMA4)), tags: {} }));
  const device = { appleSilicon: false };
  const store = createLocalAi({
    env: { OLLAMA_BASE_URL: si.base + '/v1', LOCAL_AI_DATA_DIR: dir }, libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', minLibraryModels: 1, isLoopback: () => true,
    hardware: { detect: async () => ({ os: { platform: 'linux' }, arch: 'x64', appleSilicon: device.appleSilicon, cpu: { threads: 4 }, memory: { total: 16 * GB, available: 12 * GB }, gpus: [], disk: { path: dir, free: 100 * GB, total: 200 * GB } }) },
  });
  const app = express();
  app.use('/api/local-ai', store.router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const get = async p => (await fetch('http://127.0.0.1:' + server.address().port + '/api/local-ai' + p)).json();
  const LLAMA = MODEL_BYTES + 800, MLX = MODEL_BYTES + 1e6 + 800;
  si.st.retagged = true;           // (tags the snapshot doesn't know: their variants come from the stand-in's registry)
  // → the size of gemma4:e2b in Details (with its fit's need), in the list, and of the recommended gemma4 tag
  const sizes = async () => {
    const e2b = (await get('/catalog/model?name=gemma4')).tags.find(t => t.tag === 'gemma4:e2b');
    assert.equal(e2b.fit.need, ramNeeded(e2b.size, 2e9));
    const listed = (await get('/catalog')).models.find(m => m.name === 'gemma4').tags.find(t => t.tag === 'gemma4:e2b');
    const recommended = (await get('/recommendations')).tiers.flatMap(t => t.models).find(m => m.name === 'gemma4');
    return [e2b.size, listed.size, recommended.size];
  };
  try {
    const details = await get('/catalog/model?name=gemma4');
    const e2b = details.tags.find(t => t.tag === 'gemma4:e2b');
    assert.deepEqual([e2b.ranged, e2b.variants], [true, { apple: MLX, other: LLAMA }]);
    const q4 = details.tags.find(t => t.tag === 'gemma4:e2b-it-q4_K_M');           // (one variant: the size shown)
    assert.deepEqual([q4.ranged, q4.variants, q4.size], [undefined, undefined, 4.6e9]);
    // a PC: llama.cpp; a Mac with Apple Silicon and Ollama 0.40: MLX; Ollama 0.35 on that Mac: llama.cpp
    assert.deepEqual(await sizes(), [LLAMA, LLAMA, LLAMA]);
    device.appleSilicon = true;
    assert.deepEqual(await sizes(), [MLX, MLX, MLX]);
    si.st.version = '0.35.1';
    assert.deepEqual(await sizes(), [LLAMA, LLAMA, LLAMA]);
    // not known whether this is Apple Silicon: the range's upper bound
    si.st.version = '0.40.17';
    device.appleSilicon = null;
    assert.deepEqual((await sizes()).slice(0, 2), [7.5e9, 7.5e9]);
  } finally {
    si.st.version = '0.40.17';
    si.st.retagged = false;
    store.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tags page whose variants the registry doesn\'t give in time: Details doesn\'t wait longer, and the range\'s upper bound stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ranges-slow-'));
  try {
    const c = createCatalog({ dataDir: dir, fetch: (u, i) => fetch(u, i), libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', variantMs: 300 });
    si.st.registryDelayMs = 2000;
    si.st.retagged = true;
    const t0 = Date.now();
    const t = await c.tagsOf('gemma4', true);
    assert.ok(Date.now() - t0 < 1500, (Date.now() - t0) + ' ms');
    const e2b = t.tags.find(x => x.tag === 'gemma4:e2b');
    assert.deepEqual([e2b.ranged, e2b.variants, sizeHere(e2b, false)], [true, undefined, 7.5e9]);
    // (and once the registry answers, each variant's size)
    si.st.registryDelayMs = 0;
    assert.deepEqual((await c.tagsOf('gemma4', true)).tags.find(x => x.tag === 'gemma4:e2b').variants, { apple: MODEL_BYTES + 1e6 + 800, other: MODEL_BYTES + 800 });
  } finally {
    si.st.registryDelayMs = 0;
    si.st.retagged = false;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('variant sizes once known are kept: the same tag at the same digest needs no new look (also when the registry is slow), the snapshot\'s count, a copy kept by an earlier MetaCode gets them; what the registry didn\'t give in time is asked again 10 minutes later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ranges-kept-'));
  let clock = Date.now();
  const mk = () => createCatalog({ dataDir: dir, fetch: (u, i) => fetch(u, i), libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', variantMs: 300, now: () => clock });
  const asked = () => si.st.registry.filter(r => /gemma4/.test(r)).length;
  const e2bOf = t => t.tags.find(x => x.tag === 'gemma4:e2b');
  const snapE2b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local-ai', 'catalog-snapshot.json'), 'utf8')).tags.gemma4.tags.find(x => x.tag === 'gemma4:e2b');
  const LLAMA = MODEL_BYTES + 800, MLX = MODEL_BYTES + 1e6 + 800;
  try {
    // the tags as ollama.com lists them today: the snapshot has their sizes for these digests, so the registry isn't asked
    si.st.registry.length = 0;
    let c = mk();
    const today = await c.tagsOf('gemma4', true);
    assert.equal(e2bOf(today).digest, snapE2b.digest);
    assert.deepEqual(e2bOf(today).variants, snapE2b.variants);
    assert.equal(asked(), 0);
    // a copy kept by an earlier MetaCode (no variants, the range's upper bound): the snapshot's, for the same digest
    const old = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
    for (const t of old.tags.gemma4.tags) { delete t.variants; delete t.ranged; }
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(old));
    c = mk();
    assert.deepEqual(c.list(false).models.find(m => m.name === 'gemma4').tags.find(x => x.tag === 'gemma4:e2b').size, snapE2b.variants.other);
    assert.deepEqual(e2bOf(await c.tagsOf('gemma4')).variants, snapE2b.variants);
    // tags published again (new digests), with the MLX variants' big manifests too slow: the llama.cpp sizes at once,
    // for a PC, and the page is read again 10 minutes later for the rest
    si.st.retagged = true;
    si.st.mlxDelayMs = 2000;
    const t0 = Date.now();
    const partial = await c.tagsOf('gemma4', true);
    assert.ok(Date.now() - t0 < 1500, (Date.now() - t0) + ' ms');
    assert.deepEqual([e2bOf(partial).variants, sizeHere(e2bOf(partial), false), sizeHere(e2bOf(partial), true)], [{ other: LLAMA }, LLAMA, 7.5e9]);
    si.st.mlxDelayMs = 0;
    clock += 5 * 60 * 1000;
    assert.deepEqual(e2bOf(await c.tagsOf('gemma4')).variants, { other: LLAMA }, 'not before 10 minutes');
    clock += 6 * 60 * 1000;
    assert.deepEqual(e2bOf(await c.tagsOf('gemma4')).variants, { apple: MLX, other: LLAMA });
    // a week later, read again while the registry is too slow: the same digests keep their sizes, nothing is asked
    clock += 8 * 24 * 3600 * 1000;
    si.st.registryDelayMs = 2000;
    si.st.registry.length = 0;
    const t1 = Date.now();
    const week = await c.tagsOf('gemma4');
    assert.ok(Date.now() - t1 < 1500, (Date.now() - t1) + ' ms');
    assert.deepEqual(e2bOf(week).variants, { apple: MLX, other: LLAMA });
    assert.equal(asked(), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).tags.gemma4.incomplete, undefined);
  } finally {
    Object.assign(si.st, { registryDelayMs: 0, mlxDelayMs: 0, retagged: false });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('variant sizes are matched by digest, whatever the tag\'s name (:30b and :30b-a3b are the same files): the registry is asked once for the tags at a digest, and a page still missing a size is read again after 10 minutes, then 20, 40…', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ranges-alias-'));
  let clock = Date.now(), pages = 0;
  const mk = () => createCatalog({ dataDir: dir, fetch: (u, i) => { if (/\/tags$/.test(String(u))) pages++; return fetch(u, i); }, libraryUrl: si.base + '/library', registry: si.base + '/v2/library/', variantMs: 300, now: () => clock });
  const byTag = (t, tag) => t.tags.find(x => x.tag === tag);
  const snapE2b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local-ai', 'catalog-snapshot.json'), 'utf8')).tags.gemma4.tags.find(x => x.tag === 'gemma4:e2b');
  const registryFor = tag => si.st.registry.filter(r => r.includes('/gemma4/manifests/' + tag + ' ')).length;
  const MIN = 60 * 1000;
  try {
    // an alias the snapshot doesn't list by name, at a digest it knows: its sizes, and no look at the registry
    si.st.alias = true;
    si.st.registry.length = 0;
    let c = mk();
    const t = await c.tagsOf('gemma4', true);
    assert.deepEqual([byTag(t, 'gemma4:e2b-alias').digest, byTag(t, 'gemma4:e2b-alias').variants], [snapE2b.digest, snapE2b.variants]);
    assert.equal(si.st.registry.filter(r => /gemma4\/manifests\/e2b-alias/.test(r)).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).tags.gemma4.incomplete, undefined);
    // tags published again (digests nothing knows): one look for the tags at a digest, the alias with the tag it's the alias of
    fs.rmSync(path.join(dir, 'catalog.json'), { force: true });
    si.st.retagged = true;
    si.st.mlxDelayMs = 5000;               // (the MLX variants' manifests don't come in time)
    si.st.registry.length = 0;
    c = mk();
    const first = await c.tagsOf('gemma4', true);
    assert.deepEqual(byTag(first, 'gemma4:e2b-alias').variants, byTag(first, 'gemma4:e2b').variants);
    // (one look = the tag's list, once for each of the two variants)
    assert.deepEqual([registryFor('e2b'), registryFor('e2b-alias')], [2, 0], 'asked once for e2b and its alias together');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).tags.gemma4.tries, 1);
    // read again after 10 minutes (not before), then after 20, then 40: not on every visit
    // (time steps from the first read: the page was read at T)
    pages = 0;
    const T = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).tags.gemma4.fetchedAt);
    const readsAt = async minutes => { clock = T + minutes * MIN; const n = pages; await c.tagsOf('gemma4'); return pages - n; };
    assert.equal(await readsAt(5), 0, 'not before 10 minutes');
    assert.equal(await readsAt(11), 1, 'after 10 (the second look)');
    const T2 = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).tags.gemma4.fetchedAt);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).tags.gemma4.tries, 2);
    clock = T2 + 11 * MIN;
    const n2 = pages; await c.tagsOf('gemma4'); assert.equal(pages - n2, 0, 'the second wait is 20 minutes');
    clock = T2 + 21 * MIN;
    const n3 = pages; await c.tagsOf('gemma4'); assert.equal(pages - n3, 1, 'after 20');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).tags.gemma4.tries, 3);
    // (never longer than a week: after many tries it is the usual week)
    const cat = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
    cat.tags.gemma4.tries = 30;
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(cat));
    c = mk();
    const T3 = Date.parse(cat.tags.gemma4.fetchedAt);
    clock = T3 + 6 * 24 * 60 * MIN;
    const n4 = pages; await c.tagsOf('gemma4'); assert.equal(pages - n4, 0, 'not within the week');
    clock = T3 + 7 * 24 * 60 * MIN + MIN;
    const n5 = pages; await c.tagsOf('gemma4'); assert.equal(pages - n5, 1, 'after the week');
  } finally {
    Object.assign(si.st, { alias: false, retagged: false, mlxDelayMs: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a copy kept with one size of a ranged tag takes the other from the snapshot at the same digest, when it is loaded; a plain tag, and one the snapshot doesn\'t know, stay as they are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-ranges-partial-'));
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local-ai', 'catalog-snapshot.json'), 'utf8'));
    const tags = JSON.parse(JSON.stringify(snap.tags));          // (a copy kept by an earlier MetaCode: every model's tags, as fresh)
    for (const t of Object.values(tags)) t.fetchedAt = new Date().toISOString();
    const g = tags.gemma4.tags, snap26 = snap.tags.gemma4.tags.find(x => x.tag === 'gemma4:26b'), snap12 = snap.tags.gemma4.tags.find(x => x.tag === 'gemma4:12b');
    // (saved with only the llama.cpp size: the MLX manifest didn't come in time, and the snapshot of that MetaCode didn't know the digest)
    g.find(x => x.tag === 'gemma4:26b').variants = { other: snap26.variants.other };
    delete g.find(x => x.tag === 'gemma4:12b').variants;
    g.push({ tag: 'gemma4:newer', digest: 'abcdef012345', size: 9e9, context: 1, inputs: ['text'], ranged: true, variants: { other: 8e9 } });
    g.push({ tag: 'gemma4:plain', digest: 'fedcba987654', size: 5e9, context: 1, inputs: ['text'] });
    fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), models: snap.models, tags }));
    const c = createCatalog({ dataDir: dir, registry: si.base + '/v2/library/' });
    const listed = (mlx) => c.list(mlx).models.find(m => m.name === 'gemma4').tags;
    assert.equal(listed(true).find(x => x.tag === 'gemma4:26b').size, snap26.variants.apple, 'the MLX size from the snapshot, for an Ollama that takes MLX');
    assert.equal(listed(false).find(x => x.tag === 'gemma4:26b').size, snap26.variants.other);
    assert.equal(listed(true).find(x => x.tag === 'gemma4:12b').size, snap12.variants.apple, 'a copy with no sizes at all, too');
    // not in the snapshot: its own size, and a plain tag isn't made a ranged one
    const kept = (await c.tagsOf('gemma4')).tags;
    assert.deepEqual(kept.find(x => x.tag === 'gemma4:newer').variants, { other: 8e9 });
    assert.deepEqual([kept.find(x => x.tag === 'gemma4:plain').ranged, kept.find(x => x.tag === 'gemma4:plain').variants], [undefined, undefined]);
    // (and across the whole catalog: a tag is ranged after loading exactly when the snapshot has it ranged)
    let plain = 0;
    for (const m of c.list(true).models) {
      for (const t of m.tags) {
        const was = ((snap.tags[m.name] || {}).tags || []).find(x => x.tag === t.tag);
        if (!was) continue;
        assert.equal(!!t.ranged, !!was.ranged, m.name + ':' + t.tag);
        if (!was.ranged) plain++;
      }
    }
    assert.ok(plain > 100, 'plain tags checked: ' + plain);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a tag in ollama.com\'s spelling (gemma4:e2b-it-q4_K_M): the download and the model go by it; names that differ only in case are one model', async () => {
  try {
    const r = await api('POST', '/installs', { model: 'gemma4:e2b-it-q4_K_M' });
    assert.equal(r.json.job.model, 'gemma4:e2b-it-q4_K_M');
    const again = await api('POST', '/installs', { model: 'GEMMA4:E2B-IT-Q4_K_M' });
    assert.deepEqual([again.status, again.json.already, again.json.job.model], [200, true, 'gemma4:e2b-it-q4_K_M']);
    await until(async () => { const j = await job('gemma4:e2b-it-q4_K_M'); return j && j.state === 'done'; }, 8000, 'the install');
    assert.equal((await job('gemma4:e2b-it-q4_K_M')).verified, true);
    assert.deepEqual([...si.st.installed.keys()].filter(n => /^gemma4:e2b-it/i.test(n)), ['gemma4:e2b-it-q4_K_M']);
    // pulled before in another case (by the command line): Ollama updates that one, and it's found
    const cli = 'gemma3:1b-it-q4_k_m';
    si.st.installed.set(cli, { digest: manifestFor(cli).digest, size: manifestFor(cli).size, blobs: [] });
    await api('POST', '/installs', { model: 'gemma3:1b-it-q4_K_M' });
    await until(async () => { const j = await job('gemma3:1b-it-q4_K_M'); return j && j.state === 'done'; }, 8000, 'the install over the other spelling');
    assert.equal((await job('gemma3:1b-it-q4_K_M')).verified, true);
    assert.ok(si.st.installed.has(cli) && !si.st.installed.has('gemma3:1b-it-q4_K_M'));
  } finally {
    si.st.installed.delete('gemma4:e2b-it-q4_K_M');
    si.st.installed.delete('gemma3:1b-it-q4_k_m');
  }
});

test('a model\'s settings don\'t depend on the case of its name: saved, shown in Installed Models, used for MetaCode\'s requests', async () => {
  const name = 'llama3.1:8b-instruct-q4_K_M';                // (pulled with the command line, as ollama.com spells it)
  si.st.installed.set(name, { digest: manifestFor(name).digest, size: manifestFor(name).size, blobs: [] });
  try {
    const put = await api('PUT', '/models/settings', { model: name, settings: { temperature: 0.5 } });
    assert.deepEqual([put.status, put.json.settings], [200, { temperature: 0.5 }]);
    assert.deepEqual((await api('GET', '/models')).json.models.find(m => m.name === name).settings, { temperature: 0.5 });
    assert.deepEqual(local.modelSettings('ollama/' + name), { temperature: 0.5 });
    assert.deepEqual(local.modelSettings('ollama/llama3.1:8b-instruct-q4_k_m'), { temperature: 0.5 });
    await api('PUT', '/models/settings', { model: 'LLAMA3.1:8B-INSTRUCT-Q4_K_M', settings: {} });
    assert.equal(local.modelSettings('ollama/' + name), null);
  } finally { si.st.installed.delete(name); }
});

test('a look at ollama.com that failed: for 5 minutes the saved catalog answers at once, with the problem; then (or when asked) the network again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-catalog-retry-'));
  try {
    let calls = 0, t = Date.parse('2027-01-01T00:00:00Z');     // (the snapshot's tags are more than a week old by then)
    const c = createCatalog({ dataDir: dir, now: () => t, fetch: () => { calls++; return Promise.reject(new TypeError('fetch failed')); } });
    const first = await c.refresh(false);
    assert.match(first.problem, /can't be reached \(offline\?\); the saved catalog is shown/);
    assert.equal(calls, 1);
    t += 60 * 1000;
    assert.deepEqual(await c.refresh(false), { ok: false, problem: first.problem });
    const tags = await c.tagsOf('gemma3');
    assert.deepEqual([tags.stale, tags.tags.length > 0], [true, true]);
    assert.equal(c.list().source, 'snapshot');
    assert.equal(calls, 1, 'nothing asked of the network meanwhile');
    t += 5 * 60 * 1000;
    await c.refresh(false);
    assert.equal(calls, 2);
    await c.refresh(true);                     // (the Refresh button)
    assert.equal(calls, 3);
    // (a model's tags page that couldn't be reached counts too)
    t += 10 * 60 * 1000;
    await c.tagsOf('gemma3');
    assert.equal(calls, 4);
    await c.refresh(false);
    assert.equal(calls, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a model from another registry (hf.co/…), as Ollama lists it: loaded, stopped, configured and deleted; a download still needs a name from Ollama\'s library', async () => {
  const hf = 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M';
  si.st.installed.set(hf, { digest: 'c'.repeat(64), size: 807694464, blobs: [] });
  try {
    let m = await api('POST', '/models/load', { model: hf });
    assert.equal(m.status, 200, m.text);
    assert.ok(m.json.models.find(x => x.name === hf).loaded);
    m = await api('POST', '/models/unload', { model: hf.toLowerCase() });             // (whatever the case)
    assert.equal(m.json.models.find(x => x.name === hf).loaded, null);
    const s = await api('PUT', '/models/settings', { model: hf, settings: { maxTokens: 256 } });
    assert.deepEqual([s.status, s.json.model, s.json.settings], [200, hf, { maxTokens: 256 }]);
    assert.deepEqual((await api('GET', '/models')).json.models.find(x => x.name === hf).settings, { maxTokens: 256 });
    assert.deepEqual(local.modelSettings('ollama/' + hf), { maxTokens: 256 });
    // (an update downloads it again from Ollama's library: the list says it can't, so Installed Models offers none)
    const listed = (await api('GET', '/models')).json.models;
    assert.deepEqual(listed.filter(x => x.updatable === false).map(x => x.name), [hf]);
    assert.ok(listed.length > 1 && listed.every(x => typeof x.updatable === 'boolean'));
    const u = await api('POST', '/models/update', { model: hf });
    assert.deepEqual([u.status, u.json.error.code], [400, 'invalid_model']);
    const d = await api('POST', '/models/delete', { model: hf });
    assert.equal(d.status, 200);
    assert.ok(!si.st.installed.has(hf) && !d.json.models.some(x => x.name === hf));
    assert.deepEqual(changed.pop(), ['deleted', hf]);
    assert.equal(local.modelSettings('ollama/' + hf), null, 'its settings went with it');
    // a cloud model Ollama lists runs on Ollama's servers: nothing to load (it can be deleted)
    si.st.installed.set('gpt-oss:120b-cloud', { digest: 'd'.repeat(64), size: 384, blobs: [], remote_host: 'https://ollama.com:443' });
    assert.equal((await api('GET', '/models')).json.models.find(x => x.name === 'gpt-oss:120b-cloud').updatable, false);
    const cloud = await api('POST', '/models/load', { model: 'gpt-oss:120b-cloud' });
    assert.deepEqual([cloud.status, cloud.json.error.code], [400, 'cloud_model']);
    assert.match(cloud.json.error.message, /^gpt-oss:120b-cloud runs on Ollama's servers, not on this computer/);
    assert.ok(!si.st.loads.some(([name]) => /cloud/.test(name)));
    assert.equal((await api('POST', '/models/delete', { model: 'gpt-oss:120b-cloud' })).status, 200);
    // a model Ollama doesn't have, and what isn't a name
    for (const [method, p] of [['POST', '/models/load'], ['POST', '/models/unload'], ['POST', '/models/delete'], ['PUT', '/models/settings']]) {
      const gone = await api(method, p, { model: hf, settings: {} });
      assert.deepEqual([gone.status, gone.json.error.code], [404, 'not_found'], p);
      assert.match(gone.json.error.message, /^Ollama has no model called "hf\.co\/bartowski\/Llama-3\.2-1B-Instruct-GGUF:Q4_K_M"\.$/);
      const bad = await api(method, p, { model: 'x;rm -rf /', settings: {} });
      assert.deepEqual([bad.status, bad.json.error.code], [400, 'invalid_model'], p);
    }
  } finally { si.st.installed.delete(hf); si.st.installed.delete('gpt-oss:120b-cloud'); }
});

test('Installed Models: names that share a digest are one model, counted once, and each says which other names use its files', async () => {
  const same = manifestFor('gemma3:4b');
  for (const name of ['gemma3:4b', 'gemma3:latest', 'gemma3:4b-it-q4_K_M']) si.st.installed.set(name, { digest: same.digest, size: same.size, blobs: [] });
  try {
    const m = (await api('GET', '/models')).json;
    const unique = new Map([...si.st.installed.values()].map(x => [x.digest, x.size]));
    assert.equal(m.totalSize, [...unique.values()].reduce((n, x) => n + x, 0));
    assert.ok(m.totalSize < m.models.reduce((n, x) => n + x.size, 0));
    assert.deepEqual(m.models.find(x => x.name === 'gemma3:4b').aliases, ['gemma3:4b-it-q4_K_M', 'gemma3:latest']);
    assert.deepEqual(m.models.find(x => x.name === 'gemma3:latest').aliases, ['gemma3:4b', 'gemma3:4b-it-q4_K_M']);
    assert.ok(m.models.filter(x => x.digest !== same.digest).every(x => x.aliases.length === 0));
  } finally { for (const name of ['gemma3:4b', 'gemma3:latest', 'gemma3:4b-it-q4_K_M']) si.st.installed.delete(name); }
});
