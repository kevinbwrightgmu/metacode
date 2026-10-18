// Builds the installers: node scripts/build.js [--linux] [--win] [--mac] [--dir]
// A platform can name its targets: --win=nsis (MSI needs Windows or Wine).
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
//
// Signing: signing settings that are set but empty count as not set (GitHub
// passes a secret that doesn't exist as ""; electron-builder would read "" as
// a certificate path). A Mac build without a certificate (CSC_LINK / CSC_NAME)
// is ad-hoc signed — Apple silicon Macs don't open unsigned apps at all — and
// macOS asks people to allow it once (docs/desktop/RELEASING.md).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'app-config.json');
const BUILDER_CONFIG = path.join(ROOT, 'electron-builder.yml');
const SIGNING_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

/** Removes signing settings that are set but empty @param {Record<string, string | undefined>} env */
function dropEmptySigningEnv(env) {
  for (const k of SIGNING_ENV) if (k in env && !String(env[k]).trim()) delete env[k];
}

/**
 * electron-builder's configuration: electron-builder.yml, and for a Mac build
 * without a certificate, ad-hoc signing (hardened runtime is for notarized
 * builds; with an ad-hoc signature it would reject Electron's own frameworks).
 * @param {Record<string, string | undefined>} env @param {boolean} forMac
 */
function builderConfig(env, forMac) {
  if (!forMac || env.CSC_LINK || env.CSC_NAME || env.CSC_IDENTITY_AUTO_DISCOVERY === 'true') return BUILDER_CONFIG;
  console.warn('⚠ No macOS signing certificate (CSC_LINK): the Mac app is ad-hoc signed. It opens after people allow it in System Settings › Privacy & Security.');
  return { extends: BUILDER_CONFIG, mac: { identity: '-', hardenedRuntime: false } };
}

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
  dropEmptySigningEnv(process.env);
  checkVendor();
  const original = fs.readFileSync(CONFIG, 'utf8');
  const cfg = pinnedConfig();
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  try {
    const builder = require('electron-builder');
    /** @type {Map<any, any>} */
    const targets = new Map();
    for (const [flag, platform] of [['--linux', builder.Platform.LINUX], ['--win', builder.Platform.WINDOWS], ['--mac', builder.Platform.MAC]]) {
      const a = args.find(x => x === flag || x.startsWith(flag + '='));
      if (!a) continue;
      const names = a.includes('=') ? a.split('=')[1].split(',').filter(Boolean) : null;
      const one = builder.createTargets([platform], args.includes('--dir') ? 'dir' : (names ? names[0] : null));
      if (names && names.length > 1) {
        const archMap = one.get(platform);
        for (const [arch, list] of archMap) archMap.set(arch, names.length ? names : list);
      }
      for (const [k, v] of one) targets.set(k, v);
    }
    const forMac = targets.size ? targets.has(builder.Platform.MAC) : process.platform === 'darwin';
    const opts = { projectDir: ROOT, config: builderConfig(process.env, forMac), publish: 'never' };
    if (targets.size) opts.targets = targets;
    const out = await builder.build(opts);
    console.log('\nBuilt:\n' + out.map(f => '  ' + path.relative(ROOT, f)).join('\n'));
  } finally {
    fs.writeFileSync(CONFIG, original);
  }
}

if (require.main === module) main().catch(e => { console.error(e && e.message ? e.message : e); process.exit(1); });

module.exports = { dropEmptySigningEnv, builderConfig };
