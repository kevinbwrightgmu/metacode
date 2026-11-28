// The service worker lib/pwa.js builds: what it keeps for offline use, and when it's a new version.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPwa } = require('../lib/pwa');

function publicDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-pwa-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const configOf = body => JSON.parse(/^const PWA = (\{.*\});$/m.exec(body)[1]);

test('dotfiles (.DS_Store, macOS\'s ._ files on a USB stick, an editor\'s .swp) and names a URL would need to encode aren\'t kept: one 404 makes the whole install fail', () => {
  const dir = publicDir({
    'app.html': 'app', 'index.html': 'home', 'js/app.js': 'a', 'css/main.css': 'c', 'img/icons/icon-192.png': 'p',
    'js/.DS_Store': 'x', 'js/._app.js': 'x', 'js/.app.js.swp': 'x', 'js/#app.js#': 'x', 'js/my file.js': 'x', 'js/100%.js': 'x', 'js/.hidden/inner.js': 'x',
  });
  try {
    const pwa = createPwa({ publicDir: dir, env: {} });
    assert.deepEqual(pwa.precacheFiles(), ['app.html', 'css/main.css', 'img/icons/icon-192.png', 'index.html', 'js/app.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the in-app Reddit browser turned on or off is a new service worker version (Scramjet is loaded only when it\'s on)', () => {
  const dir = publicDir({ 'app.html': 'app', 'js/app.js': 'a' });
  try {
    let on = false;
    const pwa = createPwa({ publicDir: dir, env: {}, scramjet: () => on });
    const off = configOf(pwa.serviceWorker());
    assert.equal(off.scramjet, false);
    on = true;
    const with_ = configOf(pwa.serviceWorker());
    assert.equal(with_.scramjet, true);
    assert.notEqual(with_.version, off.version);
    assert.match(pwa.serviceWorker(), /if \(PWA\.scramjet\) \{ try \{ importScripts\('\/scramjet\/controller\.sw\.js'\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
