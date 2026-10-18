// scripts/build.js: signing settings for the installers. GitHub passes a
// secret that doesn't exist as "", which must count as not set; a Mac build
// without a certificate is ad-hoc signed (Apple silicon won't open an
// unsigned app), merged into electron-builder.yml by electron-builder itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { dropEmptySigningEnv, builderConfig } = require('../scripts/build');

const YML = path.join(__dirname, '..', 'electron-builder.yml');

test('empty signing settings are removed; real ones and everything else are kept', () => {
  const env = { CSC_LINK: '', CSC_KEY_PASSWORD: '  ', APPLE_ID: '', APPLE_TEAM_ID: 'TEAM123', WIN_CSC_LINK: 'cert.pfx', DESKTOP_LEASE_PUBLIC_KEYS: '', PATH: '/bin' };
  dropEmptySigningEnv(env);
  assert.deepEqual(env, { APPLE_TEAM_ID: 'TEAM123', WIN_CSC_LINK: 'cert.pfx', DESKTOP_LEASE_PUBLIC_KEYS: '', PATH: '/bin' });
});

test('Mac builds without a certificate are ad-hoc signed; with one, or for other platforms, the configuration is unchanged', () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(builderConfig({}, true), { extends: YML, mac: { identity: '-', hardenedRuntime: false } });
    assert.deepEqual(builderConfig({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, true), { extends: YML, mac: { identity: '-', hardenedRuntime: false } });
    assert.equal(builderConfig({ CSC_LINK: 'base64cert' }, true), YML);
    assert.equal(builderConfig({ CSC_NAME: 'Developer ID Application: MetaCode' }, true), YML);
    assert.equal(builderConfig({ CSC_IDENTITY_AUTO_DISCOVERY: 'true' }, true), YML, 'a Mac with a certificate in its keychain finds it itself');
    assert.equal(builderConfig({}, false), YML);
  } finally { console.warn = quiet; }
});

test('electron-builder merges the ad-hoc override into electron-builder.yml (nothing else changes)', async () => {
  // what electron-builder's packager does with a config object that "extends" a file
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const quiet = console.warn;
  console.warn = () => {};
  let opts;
  try { opts = builderConfig({}, true); } finally { console.warn = quiet; }
  const projectDir = path.join(__dirname, '..');
  const configPath = opts.extends;
  const fromOptions = Object.assign({}, opts);
  delete fromOptions.extends;
  const merged = await getConfig(projectDir, configPath, fromOptions);
  const plain = await getConfig(projectDir, YML, null);
  assert.equal(merged.mac.identity, '-');
  assert.equal(merged.mac.hardenedRuntime, false);
  assert.equal(plain.mac.hardenedRuntime, true);
  assert.deepEqual(merged.mac.target, plain.mac.target, 'still .dmg and .zip for x64 and arm64');
  assert.equal(merged.mac.entitlements, plain.mac.entitlements);
  assert.deepEqual(merged.electronFuses, plain.electronFuses, 'the hardening fuses are kept');
  assert.equal(merged.appId, plain.appId);
  assert.deepEqual(merged.win, plain.win);
  assert.deepEqual(merged.linux, plain.linux);
});
