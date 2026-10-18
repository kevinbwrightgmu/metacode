// Builds the installers: node scripts/build.js [--linux] [--win] [--mac] [--dir]
//
// Before packaging:
//   • checks that the vendored website scripts are current (npm run sync)
//   • pins the MetaCode server's lease public keys into app-config.json, from
//     DESKTOP_LEASE_PUBLIC_KEYS (comma-separated, SPKI DER base64 — the
//     "publicKey" that https://<server>/api/desktop/config shows). Release
//     builds should always set it: with pinned keys, an offline lease can only
//     come from that server. Without it the build still works, trusting the
//     key the server publishes over HTTPS (a warning is printed).
//   • METACODE_SHEETS_SERVER_URL (optional) builds for another server.
// app-config.json is put back as it was afterwards.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'app-config.json');

function checkVendor() {
  const { FILES, ROOT: REPO } = require('./sync-vendor');
  for (const [from, to] of FILES) {
    const a = fs.readFileSync(path.join(REPO, from)), b = fs.readFileSync(path.join(ROOT, to));
    if (!a.equals(b)) throw new Error('desktop/' + to + ' is out of date with ' + from + ' — run `npm run sync` in desktop/.');
  }
}

function pinnedConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const raw = String(process.env.DESKTOP_LEASE_PUBLIC_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of raw) {
    const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('DESKTOP_LEASE_PUBLIC_KEYS: not an Ed25519 public key: ' + k.slice(0, 20) + '…');
  }
  if (raw.length) cfg.leasePublicKeys = raw;
  else console.warn('⚠ DESKTOP_LEASE_PUBLIC_KEYS is not set: this build trusts the lease key the server publishes (fine for testing; pin keys for releases).');
  if (process.env.METACODE_SHEETS_SERVER_URL) {
    const u = new URL(process.env.METACODE_SHEETS_SERVER_URL);
    if (u.protocol !== 'https:') throw new Error('METACODE_SHEETS_SERVER_URL must be https://');
    cfg.serverUrl = u.origin;
  }
  cfg.allowServerOverride = false;
  return cfg;
}

async function main() {
  const args = process.argv.slice(2);
  checkVendor();
  const original = fs.readFileSync(CONFIG, 'utf8');
  const cfg = pinnedConfig();
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  try {
    const builder = require('electron-builder');
    const targets = [];
    if (args.includes('--linux')) targets.push(builder.Platform.LINUX);
    if (args.includes('--win')) targets.push(builder.Platform.WINDOWS);
    if (args.includes('--mac')) targets.push(builder.Platform.MAC);
    const opts = { projectDir: ROOT, config: path.join(ROOT, 'electron-builder.yml'), publish: 'never' };
    if (targets.length) opts.targets = builder.createTargets(targets, args.includes('--dir') ? 'dir' : null);
    const out = await builder.build(opts);
    console.log('\nBuilt:\n' + out.map(f => '  ' + path.relative(ROOT, f)).join('\n'));
  } finally {
    fs.writeFileSync(CONFIG, original);
  }
}

main().catch(e => { console.error(e && e.message ? e.message : e); process.exit(1); });
