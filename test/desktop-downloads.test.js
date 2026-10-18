// Downloading MetaCode Sheets from the website (desktop-api/downloads.js):
// the newest *published* desktop-v* release on GitHub (a stand-in GitHub API
// here — nothing reaches github.com), or installers kept on the server
// (DESKTOP_DOWNLOADS_DIR); stable links per platform; the lookup cached and
// never retried in a loop; and the /download page on the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { createDownloads, classify, versionOf } = require('../desktop-api/downloads');
const { testEnv } = require('./helpers/harness');

const REPO = 'kevinbwrightgmu/metacode';
const TOKEN = 'ghp_test_token_0123456789abcdefghij';
const asset = (name, extra) => Object.assign({ name, state: 'uploaded', size: 100 * 1024 * 1024 + name.length, browser_download_url: 'https://github.com/' + REPO + '/releases/download/TAG/' + name }, extra || {});
const assetsFor = (v) => [
  asset('MetaCode-Sheets-' + v + '-win-x64.exe', { digest: 'sha256:' + 'a'.repeat(64) }),
  asset('MetaCode-Sheets-' + v + '-win-x64.exe.blockmap'),
  asset('MetaCode-Sheets-' + v + '-win-x64.msi'),
  asset('MetaCode-Sheets-' + v + '-mac-arm64.dmg'),
  asset('MetaCode-Sheets-' + v + '-mac-x64.dmg'),
  asset('MetaCode-Sheets-' + v + '-mac-arm64.zip'),
  asset('MetaCode-Sheets-' + v + '-mac-x64.zip'),
  asset('MetaCode-Sheets-' + v + '-linux-x86_64.AppImage'),
  asset('MetaCode-Sheets-' + v + '-linux-amd64.deb'),
  asset('latest.yml'),
  asset('SHA256SUMS.txt', { size: 900 }),
  asset('MetaCode-Sheets-' + v + '-win-arm64.exe', { state: 'starter' })      // still uploading: not offered
].map(a => Object.assign(a, { browser_download_url: a.browser_download_url.replace('TAG', 'desktop-v' + v) }));
const release = (tag, o) => Object.assign({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-01T12:00:00Z', html_url: 'https://github.com/' + REPO + '/releases/tag/' + tag, assets: [] }, o || {});

/** A stand-in for GET /repos/:owner/:repo/releases */
function mockGithub() {
  const m = { releases: [], status: 200, calls: [], etag: 'W/"v1"' };
  m.server = http.createServer((req, res) => {
    m.calls.push({ url: req.url, auth: req.headers.authorization || null, ifNoneMatch: req.headers['if-none-match'] || null, ua: req.headers['user-agent'] });
    if (req.url !== '/repos/' + REPO + '/releases?per_page=30') { res.statusCode = 404; return res.end('{"message":"Not Found"}'); }
    if (m.status !== 200) { res.statusCode = m.status; return res.end('{"message":"API rate limit exceeded"}'); }
    if (req.headers['if-none-match'] === m.etag) { res.statusCode = 304; return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('ETag', m.etag);
    res.end(JSON.stringify(m.releases));
  });
  m.start = () => new Promise(r => m.server.listen(0, '127.0.0.1', () => { m.url = 'http://127.0.0.1:' + m.server.address().port; r(m.url); }));
  m.close = () => new Promise(r => { m.server.closeAllConnections(); m.server.close(r); });
  return m;
}

/** The downloads routes on their own little site, with a clock the test moves */
async function site(env) {
  const clock = { t: Date.parse('2026-10-18T10:00:00Z') };
  const d = createDownloads({ env, now: () => clock.t });
  const app = express();
  app.use('/api/desktop', d.api);
  app.use('/download', d.files);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    clock, d, base,
    get: async (p) => { const r = await fetch(base + p, { redirect: 'manual' }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { json = null; } return { status: r.status, json, text, headers: r.headers }; },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })
  };
}

let gh;
test.before(async () => { gh = mockGithub(); await gh.start(); });
test.after(async () => { if (gh) await gh.close(); });
test.beforeEach(() => { gh.calls.length = 0; gh.status = 200; });

test('file names: installers are recognised by kind and architecture; the rest is ignored', () => {
  const ids = n => (classify(n) || { id: null }).id;
  assert.equal(ids('MetaCode-Sheets-1.0.0-win-x64.exe'), 'windows');
  assert.equal(ids('MetaCode-Sheets-1.0.0-win-x64.msi'), 'windows-msi');
  assert.equal(ids('MetaCode-Sheets-1.0.0-mac-arm64.dmg'), 'mac-arm64');
  assert.equal(ids('MetaCode-Sheets-1.0.0-mac-x64.dmg'), 'mac-x64');
  assert.equal(ids('MetaCode-Sheets-1.0.0-mac-arm64.zip'), 'mac-arm64-zip');
  assert.equal(ids('MetaCode-Sheets-1.0.0-linux-x86_64.AppImage'), 'linux-appimage');
  assert.equal(ids('MetaCode-Sheets-1.0.0-linux-amd64.deb'), 'linux-deb');
  assert.equal(ids('MetaCode-Sheets-1.0.0-linux-arm64.deb'), 'linux-deb-arm64');
  assert.equal(ids('SHA256SUMS.txt'), 'checksums');
  for (const other of ['MetaCode-Sheets-1.0.0-win-x64.exe.blockmap', 'latest.yml', 'latest-mac.yml', 'notes.md', '../evil.exe', '.hidden.exe', 'a/b.dmg']) assert.equal(classify(other), null, other);
  assert.equal(versionOf('desktop-v1.2.3'), '1.2.3');
  for (const t of ['v1.2.3', 'desktop-v1.2', 'desktop-v1.2.3-beta', 'desktop-v1.2.3 ']) assert.equal(versionOf(t), null, t);
});

test('GitHub: the newest published desktop release is offered; drafts, pre-releases, other tags and releases without installers are not', async () => {
  gh.releases = [
    release('desktop-v2.0.0', { draft: true, assets: assetsFor('2.0.0') }),
    release('desktop-v1.5.0', { prerelease: true, assets: assetsFor('1.5.0') }),
    release('v9.0.0', { assets: assetsFor('9.0.0') }),
    release('desktop-v1.3.0', { assets: [asset('notes.md')] }),
    release('desktop-v1.1.0', { published_at: '2026-09-01T00:00:00Z', assets: assetsFor('1.1.0') }),
    release('desktop-v1.2.0', { assets: assetsFor('1.2.0') })
  ];
  const s = await site({ DESKTOP_RELEASES_API: gh.url, DESKTOP_GITHUB_TOKEN: TOKEN });
  try {
    const r = await s.get('/api/desktop/downloads');
    assert.equal(r.status, 200);
    assert.equal(r.json.available, true);
    assert.equal(r.json.version, '1.2.0');
    assert.equal(r.json.tag, 'desktop-v1.2.0');
    assert.equal(r.json.publishedAt, '2026-10-01T12:00:00Z');
    assert.equal(r.json.notesUrl, 'https://github.com/' + REPO + '/releases/tag/desktop-v1.2.0');
    assert.deepEqual(r.json.files.map(f => f.id), ['windows', 'windows-msi', 'mac-arm64', 'mac-x64', 'mac-arm64-zip', 'mac-x64-zip', 'linux-appimage', 'linux-deb', 'checksums']);
    const win = r.json.files[0];
    assert.deepEqual(win, { id: 'windows', os: 'windows', arch: 'x64', kind: 'exe', label: 'Installer (.exe)', name: 'MetaCode-Sheets-1.2.0-win-x64.exe', size: 100 * 1024 * 1024 + 33, sha256: 'a'.repeat(64), url: '/download/desktop/windows' });
    assert.equal(r.json.files.find(f => f.id === 'mac-arm64').sha256, null, 'no digest from GitHub: none shown');
    assert.ok(!r.text.includes(TOKEN), 'the token never leaves the server');
    // the token went to GitHub only, with the API version header's companions
    assert.equal(gh.calls.length, 1);
    assert.equal(gh.calls[0].auth, 'Bearer ' + TOKEN);
    assert.equal(gh.calls[0].ua, 'MetaCode-website');
  } finally { await s.close(); }
});

test('GitHub: each stable link redirects to that file of the current release; nothing else is redirected to', async () => {
  gh.releases = [release('desktop-v1.2.0', { assets: assetsFor('1.2.0') })];
  const s = await site({ DESKTOP_RELEASES_API: gh.url });
  try {
    const want = { windows: '1.2.0-win-x64.exe', 'windows-msi': '1.2.0-win-x64.msi', 'mac-arm64': '1.2.0-mac-arm64.dmg', 'mac-x64': '1.2.0-mac-x64.dmg', 'linux-appimage': '1.2.0-linux-x86_64.AppImage', 'linux-deb': '1.2.0-linux-amd64.deb' };
    for (const [id, file] of Object.entries(want)) {
      const r = await s.get('/download/desktop/' + id);
      assert.equal(r.status, 302, id);
      assert.equal(r.headers.get('location'), 'https://github.com/' + REPO + '/releases/download/desktop-v1.2.0/MetaCode-Sheets-' + file, id);
      assert.equal(r.headers.get('cache-control'), 'no-store', 'the link follows the current version');
    }
    assert.equal((await s.get('/download/desktop/checksums')).headers.get('location'), 'https://github.com/' + REPO + '/releases/download/desktop-v1.2.0/SHA256SUMS.txt');
    // a platform this version doesn't have: back to the download page, which says so
    const missing = await s.get('/download/desktop/windows-arm64');
    assert.equal(missing.status, 302);
    assert.equal(missing.headers.get('location'), '/download?missing=windows-arm64');
    // anything that isn't a link id is refused outright (no open redirect, no paths)
    for (const bad of ['Windows', 'win%2F..', '..%2F..%2Fetc', 'https%3A%2F%2Fevil.example', 'x'.repeat(41)]) {
      const r = await s.get('/download/desktop/' + bad);
      assert.equal(r.status, 404, bad);
      assert.equal(r.headers.get('location'), null, bad);
    }
    assert.equal(gh.calls.length, 1, 'one lookup served all of these (cached)');
  } finally { await s.close(); }
});

test('GitHub: the lookup is cached, revalidated with an ETag, kept when GitHub fails, and retried at most once a minute', async () => {
  gh.releases = [release('desktop-v1.2.0', { assets: assetsFor('1.2.0') })];
  const s = await site({ DESKTOP_RELEASES_API: gh.url });
  try {
    assert.equal((await s.get('/api/desktop/downloads')).json.version, '1.2.0');
    s.clock.t += 9 * 60 * 1000;
    await s.get('/api/desktop/downloads');
    assert.equal(gh.calls.length, 1, 'fresh for 10 minutes');
    s.clock.t += 2 * 60 * 1000;
    assert.equal((await s.get('/api/desktop/downloads')).json.version, '1.2.0');
    assert.equal(gh.calls.length, 2);
    assert.equal(gh.calls[1].ifNoneMatch, 'W/"v1"', 'asked "has it changed?" (a 304 doesn\'t use up the rate limit)');
    // GitHub fails (rate limited): the last good answer is kept
    gh.status = 403;
    s.clock.t += 11 * 60 * 1000;
    const r = await s.get('/api/desktop/downloads');
    assert.equal(r.status, 200);
    assert.equal(r.json.version, '1.2.0');
    assert.equal(gh.calls.length, 3);
    for (let i = 0; i < 5; i++) await s.get('/download/desktop/windows');
    assert.equal(gh.calls.length, 3, 'no retry within a minute, however many requests come in');
    s.clock.t += 61 * 1000;
    await s.get('/api/desktop/downloads');
    assert.equal(gh.calls.length, 4, 'one retry after a minute');
    // a new release is published: picked up at the next lookup
    gh.status = 200;
    gh.etag = 'W/"v2"';
    gh.releases = [release('desktop-v1.3.0', { assets: assetsFor('1.3.0') })].concat(gh.releases);
    s.clock.t += 61 * 1000;
    assert.equal((await s.get('/api/desktop/downloads')).json.version, '1.3.0');
    assert.match((await s.get('/download/desktop/windows')).headers.get('location'), /desktop-v1\.3\.0\/MetaCode-Sheets-1\.3\.0-win-x64\.exe$/);
  } finally { gh.etag = 'W/"v1"'; await s.close(); }
});

test('GitHub unreachable with nothing cached: "can\'t load" (503), never a made-up list', async () => {
  gh.status = 500;
  const s = await site({ DESKTOP_RELEASES_API: gh.url });
  try {
    const r = await s.get('/api/desktop/downloads');
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { available: false, reason: 'unreachable', message: 'The list of downloads can\'t be loaded right now. Try again in a minute.' });
    const f = await s.get('/download/desktop/windows');
    assert.equal(f.status, 503);
    assert.equal(f.headers.get('location'), null);
  } finally { await s.close(); }
  // a repository that doesn't exist (or is private without access) is the same
  const s2 = await site({ DESKTOP_RELEASES_API: gh.url, DESKTOP_RELEASES_REPO: 'someone/private-repo' });
  try { assert.equal((await s2.get('/api/desktop/downloads')).json.reason, 'unreachable'); } finally { await s2.close(); }
});

test('nothing published yet: the page is told so, and links lead back to it', async () => {
  gh.releases = [release('desktop-v1.0.0', { draft: true, assets: assetsFor('1.0.0') })];
  const s = await site({ DESKTOP_RELEASES_API: gh.url });
  try {
    const r = await s.get('/api/desktop/downloads');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { available: false, reason: 'none_published', message: 'No version of MetaCode Sheets has been published yet.' });
    assert.equal((await s.get('/download/desktop/windows')).headers.get('location'), '/download?missing=windows');
  } finally { await s.close(); }
});

test('turned off (DESKTOP_RELEASES_REPO=off or DESKTOP_ENABLED=false): no lookup, no files', async () => {
  for (const env of [{ DESKTOP_RELEASES_REPO: 'off' }, { DESKTOP_ENABLED: 'false' }]) {
    const s = await site(Object.assign({ DESKTOP_RELEASES_API: gh.url }, env));
    try {
      const r = await s.get('/api/desktop/downloads');
      assert.equal(r.json.available, false);
      assert.equal(r.json.reason, 'off');
      assert.equal((await s.get('/download/desktop/windows')).status, 404);
      assert.equal(s.d.enabled(), false);
    } finally { await s.close(); }
  }
  assert.equal(gh.calls.length, 0);
});

test('DESKTOP_DOWNLOADS_DIR: the newest version in the folder is served from this server, and only its installers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-dl-'));
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-secret-'));
  try {
    const put = (name, body) => fs.writeFileSync(path.join(dir, name), body);
    put('MetaCode-Sheets-1.0.0-win-x64.exe', 'old windows');
    put('MetaCode-Sheets-1.10.0-win-x64.exe', 'new windows installer');
    put('MetaCode-Sheets-1.10.0-linux-x86_64.AppImage', 'appimage bytes');
    put('MetaCode-Sheets-1.10.0-win-x64.exe.blockmap', 'x');
    put('MetaCode-Sheets-1.9.0-mac-arm64.dmg', 'older mac');
    put('.env', 'SECRET=1');
    put('notes.txt', 'not offered');
    fs.mkdirSync(path.join(dir, 'MetaCode-Sheets-1.10.0-linux-amd64.deb'));    // a folder, not a file
    fs.writeFileSync(path.join(secret, 'MetaCode-Sheets-9.9.9-win-x64.exe'), 'outside');
    const s = await site({ DESKTOP_DOWNLOADS_DIR: dir, DESKTOP_RELEASES_API: gh.url });
    try {
      const r = await s.get('/api/desktop/downloads');
      assert.equal(r.json.available, true);
      assert.equal(r.json.version, '1.10.0', 'numeric version order (1.10 > 1.9)');
      assert.deepEqual(r.json.files.map(f => f.id), ['windows', 'linux-appimage']);
      assert.equal(r.json.files[0].sha256, crypto.createHash('sha256').update('new windows installer').digest('hex'));
      assert.equal(r.json.files[0].size, 'new windows installer'.length);
      assert.ok(!r.text.includes(dir), 'no server paths in the answer');
      const f = await s.get('/download/desktop/windows');
      assert.equal(f.status, 200);
      assert.equal(f.text, 'new windows installer');
      assert.equal(f.headers.get('content-disposition'), 'attachment; filename="MetaCode-Sheets-1.10.0-win-x64.exe"');
      assert.equal((await s.get('/download/desktop/mac-arm64')).headers.get('location'), '/download?missing=mac-arm64', 'an older version\'s file isn\'t offered');
      for (const bad of ['..%2F' + path.basename(secret) + '%2FMetaCode-Sheets-9.9.9-win-x64.exe', '.env', 'notes.txt']) assert.equal((await s.get('/download/desktop/' + bad)).status, 404, bad);
      assert.equal(gh.calls.length, 0, 'GitHub isn\'t asked');
    } finally { await s.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(secret, { recursive: true, force: true }); }
});

test('the real server: /download is the download page, its API answers, and the app is sent there for updates', async () => {
  gh.releases = [release('desktop-v1.2.0', { assets: assetsFor('1.2.0') })];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metacode-dlsrv-'));
  Object.assign(process.env, testEnv({
    SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', DESKTOP_WITHOUT_ACCOUNTS: 'true',
    ACCOUNT_DATA_DIR: path.join(tmp, 'accounts'), SURVEY_DATA_DIR: path.join(tmp, 'surveys'), PROJECT_DATA_DIR: path.join(tmp, 'projects'),
    EMIS_MODELS_FILE: path.join(tmp, 'none.json'), PUBLIC_URL: '', DESKTOP_RELEASES_API: gh.url
  }));
  delete process.env.DESKTOP_DOWNLOAD_URL;
  const mod = require('../server');
  const server = await mod.start(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const page = await fetch(base + '/download');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>Download MetaCode Sheets/);
    assert.match(html, /\/api\/desktop\/downloads/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'img', 'sheets-screenshot.png')), 'the page\'s screenshot is there');
    const api = await (await fetch(base + '/api/desktop/downloads')).json();
    assert.equal(api.version, '1.2.0');
    const file = await fetch(base + '/download/desktop/linux-deb', { redirect: 'manual' });
    assert.equal(file.status, 302);
    assert.match(file.headers.get('location'), /^https:\/\/github\.com\/.+\/MetaCode-Sheets-1\.2\.0-linux-amd64\.deb$/);
    const cfg = await (await fetch(base + '/api/desktop/config')).json();
    assert.equal(cfg.downloadUrl, base + '/download', 'an outdated app opens this page');
    process.env.DESKTOP_DOWNLOAD_URL = 'https://downloads.example.org/sheets';
    assert.equal((await (await fetch(base + '/api/desktop/config')).json()).downloadUrl, 'https://downloads.example.org/sheets', 'unless the administrator says otherwise');
    // the homepage and footer link to it
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /href="\/download"/);
  } finally {
    delete process.env.DESKTOP_DOWNLOAD_URL;
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
