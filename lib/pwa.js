// The installable, offline MetaCode, server side:
//   GET /sw.js         the service worker (lib/pwa-sw.js). The list of files it keeps for offline use, and a
//                      version taken from their contents, go at the top: a changed file is a new version,
//                      which browsers install by themselves.
//   GET /analytics.js  Google Analytics only when the operator sets METACODE_ANALYTICS_ID; an empty script
//                      otherwise (the default: nothing is sent anywhere).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Kept for offline use: the pages that work without the server (the app, Survey Studio, the home page) and
// everything they load. Other files (the AI Coding Lab's, the editors loaded on demand) are cached as
// they're used.
const PRECACHE_PAGES = ['index.html', 'app.html', 'studio.html', 'manifest.webmanifest', 'img/metacode-mark.png'];
const PRECACHE_DIRS = ['css', 'js', 'vendor', 'img/icons'];
const NOT_PRECACHED = [/^js\/ai-lab\//, /^css\/ai-lab\.css$/, /^vendor\/(highlight|codemirror5)\//, /(^|\/)(LICENSE|VENDOR\.json)$|\.LICENSE$/];
const SW_TEMPLATE = path.join(__dirname, 'pwa-sw.js');

// (dotfiles — .DS_Store, the ._ files macOS leaves on a USB stick, an editor's .swp — aren't served, and a name
// that would need encoding in a URL — #app.js#, spaces — doesn't match its request: either would make the
// all-or-nothing install fail, so neither is kept)
const KEEPABLE = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
function walk(dir, base, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (!KEEPABLE.test(e.name)) continue;
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function createPwa(opts) {
  const publicDir = opts.publicDir;
  const env = opts.env || process.env;
  // (is the Scraper's in-app Reddit browser on? Its Scramjet routing is loaded into the service worker only
  // then; turning it on or off is a new service worker, so browsers that have one update)
  const scramjetOn = () => (typeof opts.scramjet === 'function' ? !!opts.scramjet() : true);
  let built = null;              // { signature, body }

  function precacheFiles() {
    const files = PRECACHE_PAGES.filter(f => fs.existsSync(path.join(publicDir, f)));
    for (const dir of PRECACHE_DIRS) walk(path.join(publicDir, dir), dir, files);
    return files.filter(f => !NOT_PRECACHED.some(re => re.test(f))).sort();
  }
  // The service worker, rebuilt only when a file changed (cheap stat()s on every request)
  function serviceWorker() {
    const files = precacheFiles();
    const stats = files.map(f => { const st = fs.statSync(path.join(publicDir, f)); return f + ':' + st.size + ':' + st.mtimeMs; });
    const template = fs.readFileSync(SW_TEMPLATE, 'utf8');
    const scramjet = scramjetOn();
    const signature = crypto.createHash('sha256').update(stats.join('\n') + template + scramjet).digest('hex');
    if (built && built.signature === signature) return built.body;
    const hash = crypto.createHash('sha256');
    for (const f of files) hash.update(f + '\0').update(fs.readFileSync(path.join(publicDir, f)));
    hash.update(template).update(String(scramjet));
    const config = { version: hash.digest('hex').slice(0, 16), precache: files.map(f => '/' + f), scramjet };
    const body = '// MetaCode ' + config.version + ' (built by lib/pwa.js from lib/pwa-sw.js)\nconst PWA = ' + JSON.stringify(config) + ';\n' + template;
    built = { signature, body, config };
    return body;
  }

  function mount(app) {
    app.get('/sw.js', (req, res) => {
      let body;
      try { body = serviceWorker(); } catch (err) {
        console.error('[pwa] Couldn\'t build the service worker: ' + (err && err.message));
        return res.status(500).type('text/plain').send('The service worker couldn\'t be built.');
      }
      res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/', 'X-Content-Type-Options': 'nosniff' });
      res.send(body);
    });
    app.get('/analytics.js', (req, res) => {
      const id = String(env.METACODE_ANALYTICS_ID || '').trim();
      res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (!/^(G|GT|UA|AW)-[A-Z0-9-]{4,24}$/.test(id)) return res.send('/* Analytics is off (METACODE_ANALYTICS_ID isn\'t set). */\n');
      res.send('(function () {\n  var id = ' + JSON.stringify(id) + ';\n' +
        '  var s = document.createElement(\'script\'); s.async = true; s.src = \'https://www.googletagmanager.com/gtag/js?id=\' + id;\n' +
        '  document.head.appendChild(s);\n  window.dataLayer = window.dataLayer || [];\n' +
        '  window.gtag = function () { window.dataLayer.push(arguments); };\n  window.gtag(\'js\', new Date());\n  window.gtag(\'config\', id);\n})();\n');
    });
  }

  return { mount, serviceWorker, precacheFiles, info: () => (built ? built.config : null) };
}

module.exports = { createPwa };
