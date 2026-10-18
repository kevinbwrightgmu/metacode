// The website's scripts the app carries (desktop/src/renderer/vendor) must be
// the same as the website's: `npm run sync` in desktop/ copies them again.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FILES, ROOT } = require('../scripts/sync-vendor');

test('vendored website scripts are up to date', () => {
  for (const [from, to] of FILES) {
    assert.ok(fs.readFileSync(path.join(ROOT, from)).equals(fs.readFileSync(path.join(__dirname, '..', to))), to + ' differs from ' + from + ' — run npm run sync');
  }
});
