/* ══════════════════════════════════════════════
   pwa.js — the installable, offline MetaCode (page side)

   - Registers the service worker (/sw.js, built by lib/pwa.js), which keeps the app opening and working with
     no server and no internet. It also runs the Scraper's in-app Reddit browser.
   - Tells you when a new version is ready, and when this device is offline.
   - Asks the browser to keep this site's data (local projects, surveys) when the app is installed. Safari,
     for example, clears the data of sites left unused for 7 days otherwise.
   Without service workers (an http:// address other than localhost, an old browser), MetaCode works as
   before, online.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';

  const MetaPWA = window.MetaPWA = {
    supported: 'serviceWorker' in navigator && window.isSecureContext,
    version: null,
    ready: null,
    offline: () => navigator.onLine === false,
    installed: () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true,
  };

  // ── Offline banner ───────────────────────────────────────────────────────
  let banner = null;
  function showOffline(on) {
    document.documentElement.classList.toggle('is-offline', on);
    if (!on) { if (banner) banner.hidden = true; return; }
    if (!banner) {
      const style = document.createElement('style');
      style.textContent = '.offline-banner{position:fixed;left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));z-index:2500;' +
        'max-width:min(560px,calc(100vw - 32px));background:#0F172A;color:#E2E8F0;padding:10px 14px;border-radius:10px;font:13px/1.45 Inter,system-ui,sans-serif;' +
        'box-shadow:0 10px 15px rgba(0,0,0,.12)}.offline-banner strong{color:#fff}.offline-banner[hidden]{display:none}' +
        '@media (max-width:600px){.offline-banner-more{display:none}}';
      document.head.appendChild(style);
      banner = document.createElement('div');
      banner.className = 'offline-banner';
      banner.setAttribute('role', 'status');
      banner.innerHTML = '<strong>Offline.</strong> Your work is saved on this device. ' +
        '<span class="offline-banner-more">Anything that needs the internet (cloud AI, the Scraper, publishing surveys, shared projects) waits until you\'re back; AI models on this device keep working.</span>';
      document.body.appendChild(banner);
    }
    banner.hidden = false;
  }
  window.addEventListener('online', () => showOffline(false));
  window.addEventListener('offline', () => showOffline(true));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => showOffline(MetaPWA.offline()));
  else showOffline(MetaPWA.offline());

  // ── Keep local data (only once the app is installed: some browsers ask the user) ──
  function persistStorage() {
    if (!navigator.storage || !navigator.storage.persist || !MetaPWA.installed()) return;
    try { if (localStorage.getItem('metacode_storage_persist')) return; } catch (e) { return; }
    navigator.storage.persist().then(granted => {
      try { localStorage.setItem('metacode_storage_persist', granted ? 'granted' : 'denied'); } catch (e) { /* private mode */ }
    }, () => {});
  }

  // ── Service worker ───────────────────────────────────────────────────────
  if (!MetaPWA.supported) return;
  function notifyUpdate() {
    const msg = 'MetaCode was updated. Reload to use the new version.';
    // (App is a script-level const in app.js: a global name, not a property of window)
    if (typeof App !== 'undefined' && typeof App.notify === 'function') App.notify(msg, 'info');
  }
  // (a first visit is taken over by the service worker too: that isn't an update. A new version is one that
  // starts while this page already ran under another)
  const startedControlled = !!navigator.serviceWorker.controller;
  let firstVersion = null;
  navigator.serviceWorker.addEventListener('message', event => {
    const d = event.data || {};
    if (d.type === 'metacode-sw-version' && !firstVersion) firstVersion = d.version;
    if (d.type === 'metacode-sw-version' || d.type === 'metacode-sw-active') MetaPWA.version = d.version;
    if (d.type === 'metacode-sw-active' && startedControlled && firstVersion && d.version !== firstVersion) notifyUpdate();
  });
  MetaPWA.ready = new Promise(resolve => {
    const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(reg => {
        if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'metacode-sw-version' });
        else if (reg.active) reg.active.postMessage({ type: 'metacode-sw-version' });
        persistStorage();
        resolve(reg);
      }, err => {
        console.warn('[pwa] The service worker couldn\'t be registered: ' + (err && err.message));
        resolve(null);
      });
    if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
  });
})();
