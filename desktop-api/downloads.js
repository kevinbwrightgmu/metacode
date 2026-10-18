// @ts-check
// ── Downloading MetaCode Sheets from the website ──────────────────────────────
// The installers are built by .github/workflows/desktop.yml and attached to a
// GitHub release tagged desktop-v<version>, which a person publishes after
// checking it (docs/desktop/RELEASING.md). This module finds the newest
// published release and gives the website stable links to its files:
//
//   GET /api/desktop/downloads        what can be downloaded: version, files, sizes
//   GET /download/desktop/:id         the file itself, e.g. /download/desktop/windows
//                                     (a redirect to the release's file on GitHub,
//                                     or the file, from DESKTOP_DOWNLOADS_DIR)
//
// Where the files come from (.env):
//   DESKTOP_RELEASES_REPO   owner/repo on GitHub (default kevinbwrightgmu/metacode,
//                           a public repository); "off" turns downloads off
//   DESKTOP_GITHUB_TOKEN    optional, only raises GitHub's rate limit for the
//                           release lookup (never sent anywhere else or shown)
//   DESKTOP_DOWNLOADS_DIR   optional: serve installers from this folder on the
//                           server instead (same file names as the builds)
//
// Drafts and pre-releases are never offered. The lookup is cached for 10
// minutes; if GitHub can't be reached the last good answer is kept, and a
// failed lookup is retried at most once a minute (never in a loop).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { request } = require('../accounts/http');

const DEFAULT_REPO = 'kevinbwrightgmu/metacode';
const TAG_PREFIX = 'desktop-v';
const FRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const STALE_MS = 24 * 3600 * 1000;

/**
 * The kinds of file a release carries, by name. `id` is the stable link
 * (/download/desktop/<id>); the first file found for an id wins.
 * @type {{ re: RegExp, os: 'windows' | 'mac' | 'linux' | 'any', kind: string, label: string, id: (arch: string) => string }[]}
 */
const KINDS = [
  { re: /\.exe$/i, os: 'windows', kind: 'exe', label: 'Installer (.exe)', id: a => (a === 'x64' ? 'windows' : 'windows-' + a) },
  { re: /\.msi$/i, os: 'windows', kind: 'msi', label: 'Installer for IT deployment (.msi)', id: a => (a === 'x64' ? 'windows-msi' : 'windows-msi-' + a) },
  { re: /\.dmg$/i, os: 'mac', kind: 'dmg', label: 'Disk image (.dmg)', id: a => 'mac-' + a },
  { re: /mac.*\.zip$/i, os: 'mac', kind: 'zip', label: 'App in a .zip', id: a => 'mac-' + a + '-zip' },
  { re: /\.AppImage$/i, os: 'linux', kind: 'appimage', label: 'AppImage (most distributions)', id: a => (a === 'x64' ? 'linux-appimage' : 'linux-appimage-' + a) },
  { re: /\.deb$/i, os: 'linux', kind: 'deb', label: 'Debian / Ubuntu package (.deb)', id: a => (a === 'x64' ? 'linux-deb' : 'linux-deb-' + a) },
  { re: /^SHA256SUMS(\.txt)?$/i, os: 'any', kind: 'checksums', label: 'SHA-256 checksums', id: () => 'checksums' }
];

/** @param {string} name */
function archOf(name) {
  if (/arm64|aarch64/i.test(name)) return 'arm64';
  if (/universal/i.test(name)) return 'universal';
  return 'x64';                                   // x64, x86_64, amd64, or not named
}

/**
 * What a file in a release is, or null for files the site doesn't offer
 * (block maps, update manifests, anything unexpected).
 * @param {string} name
 */
function classify(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}$/.test(name) || /\.blockmap$/i.test(name)) return null;
  const k = KINDS.find(x => x.re.test(name));
  if (!k) return null;
  const arch = k.kind === 'checksums' ? 'any' : archOf(name);
  return { id: k.id(arch), os: k.os, arch, kind: k.kind, label: k.label };
}

/** "1.2.3" from "desktop-v1.2.3" (null if it isn't a version) @param {string} tag */
function versionOf(tag) {
  const m = new RegExp('^' + TAG_PREFIX + '(\\d+\\.\\d+\\.\\d+)$').exec(String(tag || ''));
  return m ? m[1] : null;
}
/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** @param {Record<string, string | undefined>} env */
function downloadsConfig(env) {
  const repo = String(env.DESKTOP_RELEASES_REPO || '').trim();
  const off = /^(false|off|no|0|none)$/i.test(repo) || /^(false|off|no|0)$/i.test(String(env.DESKTOP_ENABLED || '').trim());
  const dir = String(env.DESKTOP_DOWNLOADS_DIR || '').trim();
  return {
    enabled: !off,
    source: dir ? 'local' : 'github',
    dir: dir ? path.resolve(dir) : null,
    repo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : DEFAULT_REPO,
    // the GitHub API (changed only by tests)
    api: (/^https?:\/\/[^\s]+$/i.test(String(env.DESKTOP_RELEASES_API || '').trim()) ? String(env.DESKTOP_RELEASES_API).trim() : 'https://api.github.com').replace(/\/+$/, ''),
    token: String(env.DESKTOP_GITHUB_TOKEN || '').trim() || null
  };
}

/**
 * The newest published desktop release on GitHub with at least one installer.
 * @param {ReturnType<typeof downloadsConfig>} c @param {string | null} etag
 * @returns {Promise<{ notModified: true } | { notModified: false, etag: string | null, release: any }>}
 */
async function fetchGithub(c, etag) {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'MetaCode-website' };
  if (c.token) headers.Authorization = 'Bearer ' + c.token;
  if (etag) headers['If-None-Match'] = etag;
  const r = await request(c.api + '/repos/' + c.repo + '/releases?per_page=30', { headers, timeoutMs: 10000 });
  if (r.status === 304) return { notModified: true };
  const newEtag = (r.headers && r.headers.get('etag')) || null;
  if (r.status === 404) throw Object.assign(new Error('The releases repository ' + c.repo + ' wasn\'t found (is it private?).'), { status: 404 });
  if (!r.ok || !Array.isArray(r.json)) throw Object.assign(new Error('GitHub answered ' + r.status + ' to the release lookup.'), { status: r.status });
  const releases = r.json
    .filter(x => x && !x.draft && !x.prerelease && versionOf(x.tag_name))
    .sort((x, y) => compareVersions(/** @type {string} */ (versionOf(y.tag_name)), /** @type {string} */ (versionOf(x.tag_name))));
  for (const rel of releases) {
    /** @type {Map<string, any>} */
    const files = new Map();
    for (const a of Array.isArray(rel.assets) ? rel.assets : []) {
      if (!a || a.state !== 'uploaded' || typeof a.name !== 'string' || !/^https:\/\//i.test(String(a.browser_download_url || ''))) continue;
      const k = classify(a.name);
      if (!k || files.has(k.id)) continue;
      const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
      files.set(k.id, Object.assign(k, { name: a.name, size: Number(a.size) || null, sha256: digest ? digest[1].toLowerCase() : null, href: String(a.browser_download_url) }));
    }
    if ([...files.values()].some(f => f.kind !== 'checksums')) {
      return { notModified: false, etag: newEtag, release: {
        version: versionOf(rel.tag_name), tag: rel.tag_name, publishedAt: rel.published_at || null,
        notesUrl: /^https:\/\//i.test(String(rel.html_url || '')) ? rel.html_url : null, files
      } };
    }
  }
  return { notModified: false, etag: newEtag, release: null };
}

/** @type {Map<string, { key: string, sha256: string }>} */
const hashCache = new Map();
/** @param {string} file @param {fs.Stats} st @returns {Promise<string>} */
function sha256Of(file, st) {
  const key = st.size + ':' + st.mtimeMs;
  const hit = hashCache.get(file);
  if (hit && hit.key === key) return Promise.resolve(hit.sha256);
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => {
      const sha256 = h.digest('hex');
      hashCache.set(file, { key, sha256 });
      resolve(sha256);
    });
  });
}

/**
 * The newest version among installers in a folder on this server, named like
 * the builds (MetaCode-Sheets-1.2.3-win-x64.exe …).
 * @param {string} dir
 */
async function scanDir(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { throw new Error('The downloads folder (DESKTOP_DOWNLOADS_DIR) can\'t be read.'); }
  /** @type {Map<string, Map<string, any>>} */
  const byVersion = new Map();
  /** @type {any} */
  let checksums = null;
  for (const name of names) {
    const k = classify(name);
    if (!k) continue;
    const file = path.join(dir, name);
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const f = Object.assign(k, { name, size: st.size, sha256: null, file, mtime: st.mtime });
    if (k.kind === 'checksums') { checksums = f; continue; }
    const m = /(\d+\.\d+\.\d+)/.exec(name);
    if (!m) continue;
    if (!byVersion.has(m[1])) byVersion.set(m[1], new Map());
    const files = /** @type {Map<string, any>} */ (byVersion.get(m[1]));
    if (!files.has(k.id)) files.set(k.id, f);
  }
  const version = [...byVersion.keys()].sort(compareVersions).pop();
  if (!version) return null;
  const files = /** @type {Map<string, any>} */ (byVersion.get(version));
  if (checksums) files.set('checksums', checksums);
  for (const f of files.values()) f.sha256 = f.kind === 'checksums' ? null : await sha256Of(f.file, fs.statSync(f.file));
  const newest = Math.max(...[...files.values()].map(f => f.mtime.getTime()));
  return { version, tag: TAG_PREFIX + version, publishedAt: new Date(newest).toISOString(), notesUrl: null, files };
}

/**
 * @param {{ env?: Record<string, string | undefined>, now?: () => number }} [deps]
 */
function createDownloads(deps) {
  deps = deps || {};
  const env = () => (deps && deps.env) || process.env;
  const now = (deps && deps.now) || Date.now;
  const cfg = () => downloadsConfig(env());

  /** @type {{ key: string, at: number, okAt: number, release: any, etag: string | null, error: string | null }} */
  let cache = { key: '', at: 0, okAt: 0, release: null, etag: null, error: null };
  /** @type {Promise<void> | null} */
  let inflight = null;

  /** @param {ReturnType<typeof downloadsConfig>} c */
  async function refresh(c) {
    const key = c.source + '|' + (c.dir || c.repo) + '|' + c.api;
    if (cache.key !== key) cache = { key, at: 0, okAt: 0, release: null, etag: null, error: null };
    try {
      if (c.source === 'local') {
        cache = Object.assign({}, cache, { at: now(), okAt: now(), release: await scanDir(/** @type {string} */ (c.dir)), error: null });
        return;
      }
      const r = await fetchGithub(c, cache.okAt ? cache.etag : null);
      if (r.notModified) cache = Object.assign({}, cache, { at: now(), okAt: now(), error: null });
      else cache = Object.assign({}, cache, { at: now(), okAt: now(), release: r.release, etag: r.etag, error: null });
    } catch (e) {
      const msg = e && /** @type {any} */ (e).message ? String(/** @type {any} */ (e).message).slice(0, 200) : 'The release lookup failed.';
      console.error('[desktop] downloads: ' + msg);
      cache = Object.assign({}, cache, { at: now(), error: msg });
    }
  }

  /**
   * The current release (or null if none is published).
   * @returns {Promise<{ ok: true, release: any } | { ok: false, off?: boolean, message: string }>}
   */
  async function current() {
    const c = cfg();
    if (!c.enabled) return { ok: false, off: true, message: 'Downloads of the desktop app are turned off on this server.' };
    const key = c.source + '|' + (c.dir || c.repo) + '|' + c.api;
    const age = now() - cache.at;
    const due = cache.key !== key || !cache.at || (cache.error ? age >= RETRY_MS : age >= (c.source === 'local' ? 15000 : FRESH_MS));
    if (due) {
      if (!inflight) inflight = refresh(c).finally(() => { inflight = null; });
      await inflight;
    }
    if (cache.okAt && now() - cache.okAt < STALE_MS) return { ok: true, release: cache.release };
    return { ok: false, message: 'The list of downloads can\'t be loaded right now. Try again in a minute.' };
  }

  /** Public view of a release (no server paths) @param {any} rel */
  function describe(rel) {
    const order = ['windows', 'mac', 'linux', 'any'];
    const files = [...rel.files.values()]
      .sort((a, b) => order.indexOf(a.os) - order.indexOf(b.os))
      .map(f => ({ id: f.id, os: f.os, arch: f.arch, kind: f.kind, label: f.label, name: f.name, size: f.size, sha256: f.sha256, url: '/download/desktop/' + f.id }));
    return { available: true, version: rel.version, tag: rel.tag, publishedAt: rel.publishedAt, notesUrl: rel.notesUrl, files };
  }

  const api = express.Router();
  api.get('/downloads', async (/** @type {any} */ req, /** @type {any} */ res) => {
    const r = await current();
    if (!r.ok) return res.status(r.off ? 200 : 503).json({ available: false, reason: r.off ? 'off' : 'unreachable', message: r.message });
    if (!r.release) return res.json({ available: false, reason: 'none_published', message: 'No version of MetaCode Sheets has been published yet.' });
    res.json(describe(r.release));
  });

  // The files themselves, at links that stay the same from one version to the next
  const files = express.Router();
  files.get('/desktop/:id', async (/** @type {any} */ req, /** @type {any} */ res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.id || '');
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return res.status(404).type('text/plain').send('There\'s no such download.');
    const r = await current();
    if (!r.ok) return res.status(r.off ? 404 : 503).type('text/plain').send(r.message);
    const f = r.release && r.release.files.get(id);
    if (!f) return res.redirect(302, '/download?missing=' + encodeURIComponent(id));
    if (f.href) return res.redirect(302, f.href);       // GitHub: a file of the published release
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(f.name, { root: path.dirname(f.file), dotfiles: 'deny', headers: { 'Content-Disposition': 'attachment; filename="' + f.name.replace(/"/g, '') + '"' } }, (/** @type {any} */ err) => {
      if (err && !res.headersSent) res.status(err.status === 404 ? 404 : 500).type('text/plain').send('That file can\'t be sent right now.');
    });
  });

  return { api, files, current, config: cfg, enabled: () => cfg().enabled };
}

module.exports = { createDownloads, downloadsConfig, classify, versionOf };
