#!/usr/bin/env node
// Rebuilds local-ai/catalog-snapshot.json: Ollama's library (every model that runs locally) with each model's
// main tags (sizes, context windows, inputs), read from ollama.com one page at a time. A tag shown as a size range
// (variants for several runners) gets each variant's size from Ollama's registry: what a Mac with Apple Silicon
// downloads and what every other computer does. MetaCode ships this snapshot so the AI Model Store has a catalog
// on its first start offline; online, it reads the library itself (local-ai/catalog.js) and keeps its own copy.
//
//   node scripts/update-model-catalog.js            the library and every model's tags (~250 pages, a few minutes)
//   node scripts/update-model-catalog.js --no-tags  the library only
'use strict';
const fs = require('fs');
const os = require('os');
const { parseLibrary, parseTags, mainTags, internetFetch, createCatalog, LIBRARY_URL, SNAPSHOT } = require('../local-ai/catalog');

// (only the registry is asked of it: nothing is saved)
const registry = createCatalog({ dataDir: os.tmpdir() });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await internetFetch(url, { headers: { 'User-Agent': 'MetaCode-ModelStore (catalog snapshot)', Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 200) return res.text();
      if (res.status === 404) return null;
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}
// The size of each variant of a tag shown as a range (up to 3 tries): → { apple, other }, or null
async function variants(tag) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const v = await registry.variantSizes(tag, 30000);
    if (v) return v;
    if (attempt < 3) await sleep(2000 * attempt);
  }
  return null;
}

(async () => {
  const models = parseLibrary(await get(LIBRARY_URL));
  if (models.length < 50) throw new Error('Only ' + models.length + ' models read from ' + LIBRARY_URL + ': has the page changed?');
  const tags = {};
  let ranged = 0;
  const unsized = [];
  if (!process.argv.includes('--no-tags')) {
    let i = 0;
    for (const m of models) {
      i++;
      const html = await get(LIBRARY_URL + '/' + encodeURIComponent(m.name) + '/tags');
      const all = html ? parseTags(html, m.name) : [];
      if (all.length) {
        const main = mainTags(m, all);
        for (const t of main.filter(x => x.ranged)) {
          ranged++;
          const v = await variants(t.tag);
          if (v) t.variants = v; else unsized.push(t.tag);
        }
        tags[m.name] = { fetchedAt: new Date().toISOString(), tags: main };
      }
      if (i % 25 === 0) console.log(i + '/' + models.length + ' models');
      await sleep(250);                              // (gently: one page at a time)
    }
  }
  const snapshot = { note: 'Made by scripts/update-model-catalog.js from ' + LIBRARY_URL + '. Cloud-only models are left out.', fetchedAt: new Date().toISOString(), models, tags };
  fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot) + '\n');
  const withTags = Object.keys(tags).length;
  console.log('local-ai/catalog-snapshot.json: ' + models.length + ' models, ' + withTags + ' with their tags, ' + ranged + ' tags with variants for several runners, ' + Math.round(fs.statSync(SNAPSHOT).size / 1024) + ' KB');
  // (a range whose variants the registry didn't give: its upper bound stays, on the safe side)
  if (unsized.length) console.log('Without their variants\' sizes (the upper bound is kept): ' + unsized.join(', '));
})().catch(e => { console.error('update-model-catalog: ' + e.message); process.exit(1); });
