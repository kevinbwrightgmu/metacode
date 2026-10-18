// Copies the website's shared scripts the app uses into src/renderer/vendor
// (the app is packaged from desktop/ alone). test/vendor.test.js fails when a
// copy is out of date: run `npm run sync` in desktop/.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = [['public/js/reliability-stats.js', 'src/renderer/vendor/reliability-stats.js']];

if (require.main === module) {
  for (const [from, to] of FILES) {
    fs.copyFileSync(path.join(ROOT, from), path.join(__dirname, '..', to));
    console.log('copied ' + from + ' → desktop/' + to);
  }
}
module.exports = { FILES, ROOT };
