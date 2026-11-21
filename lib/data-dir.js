// Where MetaCode keeps a server folder (survey-data/, scraper-data/ …) when its own setting
// (SURVEY_DATA_DIR, SCRAPER_DATA_DIR …) isn't set: under METACODE_DATA_DIR when that is set (relative to the
// MetaCode folder, or absolute), else next to server.js as always. Portable installs set
// METACODE_DATA_DIR=data, so everything they keep stays in their own data/ folder.
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');

function defaultDataDir(name, env) {
  const root = String((env || process.env).METACODE_DATA_DIR || '').trim();
  return root ? path.resolve(ROOT, root, name) : path.join(ROOT, name);
}

module.exports = { defaultDataDir, ROOT };
