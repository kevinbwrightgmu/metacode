// @ts-check
// ── app://sheets — the window's own files ─────────────────────────────────────
// The window loads only files packaged with the app, through this protocol:
//   app://sheets/renderer/…  src/renderer/… (the window: index.html, js, css)
//   app://sheets/shared/…    src/shared/… (the spreadsheet engine, file formats)
// Nothing else under src/ (the main process, the preload) is served, and
// paths can't leave those two folders. Every response carries the Content
// Security Policy below: scripts only from the app itself (no inline code, no
// eval), no network access at all from the window (connect-src 'none') — it
// reaches MetaCode only through the main process — and no frames, plugins or
// forms.
'use strict';
const path = require('path');
const fs = require('fs');

const SCHEME = 'app';
const HOST = 'sheets';
const ORIGIN = SCHEME + '://' + HOST;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "worker-src 'self'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const SERVED = ['renderer', 'shared'];

const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
});

/**
 * Which file a URL maps to (null: not one of the app's files)
 * @param {string} url @param {{ src: string }} roots  src: the folder holding renderer/ and shared/
 */
function fileFor(url, roots) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== SCHEME + ':' || u.host !== HOST) return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  if (p === '/' || p === '') p = '/renderer/index.html';
  const clean = path.posix.normalize(p);
  const top = clean.split('/')[1];
  if (!SERVED.includes(top)) return null;
  const base = path.resolve(roots.src, top);
  const file = path.resolve(roots.src, '.' + clean);
  if (!file.startsWith(base + path.sep)) return null;
  return file;
}

/** The scheme must be declared before the app is ready @param {any} protocol */
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);
}

/** @param {any} protocol @param {{ src: string }} roots */
function handleProtocol(protocol, roots) {
  protocol.handle(SCHEME, async (/** @type {Request} */ req) => {
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
    const file = fileFor(req.url, roots);
    if (!file) return new Response('Not found', { status: 404, headers });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { status: 200, headers: Object.assign({ 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }, headers) });
    } catch (e) {
      return new Response('Not found', { status: 404, headers });
    }
  });
}

module.exports = { registerScheme, handleProtocol, fileFor, CSP, ORIGIN, SCHEME, HOST };
