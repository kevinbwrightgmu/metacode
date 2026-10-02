/* ══════════════════════════════════════════════
   scramjet-sw.js — service worker for the Scraper page's Reddit browser

   Registered by js/scraper-browser.js only when the in-app Reddit browser is
   opened. It loads Scramjet's controller service-worker runtime and routes
   ONLY requests under Scramjet's prefix (/scramjet/~/…) to it; every other
   MetaCode request falls through to the network untouched.

   Request flow for a proxied page:
     iframe → this SW → Scramjet controller (in the MetaCode tab) → rewrite
     → epoxy-transport (epoxy-tls, WASM) → wss://<MetaCode>/wisp/ → Reddit
   ══════════════════════════════════════════════ */
importScripts('/scramjet/controller.sw.js');

self.addEventListener('fetch', event => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
  }
});
