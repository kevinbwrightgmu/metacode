/* MetaCode's service worker: the installable, offline MetaCode.

   lib/pwa.js serves this file at /sw.js and puts `const PWA = { version, precache }` above it: the files kept
   for offline use (the app, Survey Studio, the home page and everything they load) and a version taken from
   their contents. A new MetaCode is a new version, which the browser installs in the background.

   - Kept files are served from the cache: the app opens with no server and no internet.
   - Other files of this site are fetched, and kept as they're used (network first).
   - /api, /wisp, the Reddit browser's proxied pages, published surveys and this file itself are never
     cached: they always go to the server.
   - The Scraper's in-app Reddit browser (Scramjet) runs here too. Its controller routes its own requests
     (/scramjet/~/…), so one service worker owns the site's scope.
*/
'use strict';
const CACHE = 'metacode-' + PWA.version;
const RUNTIME = 'metacode-runtime';
const RUNTIME_MAX = 200;
const PRECACHED = new Set(PWA.precache);
const NETWORK_ONLY = /^\/(api|wisp|scramjet|s|status|download|desktop)(\/|$)|^\/(sw|analytics|scramjet-sw)\.js$/;

// Scramjet's controller, when the Scraper's in-app browser is on (PWA.scramjet; lib/pwa.js makes a new version
// when that changes); without it, the rest still works
if (PWA.scramjet) { try { importScripts('/scramjet/controller.sw.js'); } catch (e) { /* no in-app browser here */ } }
const scramjet = () => (typeof $scramjetController !== 'undefined' ? $scramjetController : null);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // (all or nothing: a version with a missing file isn't installed, and the old one stays)
    await cache.addAll(PWA.precache.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('metacode-') && k !== CACHE && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
    const pages = await self.clients.matchAll({ type: 'window' });
    pages.forEach(page => page.postMessage({ type: 'metacode-sw-active', version: PWA.version }));
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'metacode-sw-version' && event.source) {
    event.source.postMessage({ type: 'metacode-sw-version', version: PWA.version, precached: PWA.precache.length });
  }
});

self.addEventListener('fetch', event => {
  const sj = scramjet();
  if (sj && sj.shouldRoute(event)) { event.respondWith(sj.route(event)); return; }
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NETWORK_ONLY.test(url.pathname)) return;
  if (req.mode === 'navigate') event.waitUntil(stillMetaCode());
  const key = url.pathname === '/' ? '/index.html' : url.pathname;
  if (PRECACHED.has(key)) { event.respondWith(fromCache(key, req)); return; }
  event.respondWith(networkFirst(req, req.mode === 'navigate'));
});

// Another program answers at this address now (it has no /sw.js): the kept MetaCode mustn't stand in for it, so
// this service worker and its caches go. No answer at all keeps them: that's offline, or the server stopped.
// (at most once a minute, after the page was served)
let checkedAt = 0;
async function stillMetaCode() {
  if (Date.now() - checkedAt < 60000) return;
  checkedAt = Date.now();
  try {
    const r = await fetch('/sw.js', { method: 'HEAD', cache: 'no-store' });
    if (r.status !== 404) return;
    // (the caches first: a worker stopped once it's unregistered would leave them behind)
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('metacode-')).map(k => caches.delete(k)));
    await self.registration.unregister();
  } catch (e) { /* offline, or the server isn't running */ }
}

async function fromCache(key, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  try { return await fetch(req); } catch (e) { return offline(req); }
}

async function networkFirst(req, page) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(RUNTIME).then(async cache => {
        await cache.put(req, copy);
        const keys = await cache.keys();
        for (let i = 0; i < keys.length - RUNTIME_MAX; i++) await cache.delete(keys[i]);
      }).catch(() => {});
    }
    return res;
  } catch (e) {
    const hit = await caches.match(req, { cacheName: RUNTIME });
    return hit || (page ? offline(req) : Response.error());
  }
}

// A page this device hasn't kept, with no network
function offline() {
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Offline · MetaCode</title><style>body{font-family:Inter,system-ui,sans-serif;background:#EEF2FF;color:#0F172A;display:grid;place-items:center;min-height:100vh;margin:0}' +
    'main{max-width:420px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(15,23,42,.08)}h1{font-size:20px;margin:0 0 8px}' +
    'p{color:#475569;line-height:1.5}a{display:inline-block;margin-top:8px;background:#2563EB;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none}</style></head>' +
    '<body><main><h1>This page needs the MetaCode server</h1><p>You\'re offline, or the server can\'t be reached, and this page wasn\'t saved on this device. ' +
    'Your projects are still here: the app works without a connection.</p><a href="/app.html">Open MetaCode</a></main></body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
