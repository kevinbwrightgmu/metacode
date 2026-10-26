// ── Refresh MetaCode's bundled OpenCode Zen catalog ───────────────────────────
// opencode/zen-models.json is the OpenCode Zen catalog the service starts with
// when it has no newer copy (see opencode/catalog.mjs): the "opencode" provider
// entry of a models.dev api.json, unchanged, plus where it came from.
//
//   node opencode/scripts/update-zen-models.mjs                    from https://models.opencode.ai/api.json
//                                                                   (or OPENCODE_MODELS_URL; HTTPS_PROXY is honoured)
//   node opencode/scripts/update-zen-models.mjs --from <file|url>  from a saved api.json or another address
//        --label "<text>"   what "_source" says (default: where it came from); the date is added
//        --out <file>       write somewhere else (default opencode/zen-models.json)
//
// The running service fetches a fresh copy every hour anyway; this only moves
// the copy a new install starts with.

import fs from 'node:fs';
import path from 'node:path';
import { BUNDLED_PATH, DEFAULT_MODELS_URL, fetchCatalog, normalize, zenEntry } from '../catalog.mjs';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(from|label|out)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error('Unknown argument "' + a + '". Use --from <file|url>, --label <text>, --out <file>.');
    out[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    if (out[m[1]] === undefined) throw new Error('--' + m[1] + ' needs a value.');
  }
  return out;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const base = String(process.env.OPENCODE_MODELS_URL || DEFAULT_MODELS_URL).trim().replace(/\/+$/, '');
  const from = opts.from || base + '/api.json';
  const isUrl = /^https?:\/\//i.test(from);
  let entry;
  if (isUrl) {
    entry = (await fetchCatalog(from, { env: process.env, timeoutMs: 60000 })).entry;
  } else {
    const json = JSON.parse(fs.readFileSync(path.resolve(from), 'utf8').replace(/^﻿/, ''));
    entry = zenEntry(json);
    if (!entry) throw new Error(from + ' has no OpenCode Zen ("opencode") provider entry.');
  }
  const models = normalize(entry).models;
  if (!models.length) throw new Error('The catalog lists no usable OpenCode Zen models; nothing was written.');

  const where = isUrl ? new URL(from).host + new URL(from).pathname : path.basename(from);
  const out = path.resolve(opts.out || BUNDLED_PATH);
  const text = JSON.stringify({ _source: (opts.label || where) + ' (' + new Date().toISOString().slice(0, 10) + ')', opencode: entry }, null, 1) + '\n';
  const tmp = out + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, out);
  const free = models.filter(m => m.free).length;
  console.log('Wrote ' + path.relative(process.cwd(), out) + ': ' + Object.keys(entry.models).length + ' OpenCode Zen models, ' + models.length +
    ' offered (' + free + ' free without a key).');
}

main().catch(e => {
  console.error('Couldn\'t update the OpenCode Zen catalog: ' + e.message);
  process.exit(1);
});
