/* ══════════════════════════════════════════════
   scraper-browser.js — in-app Reddit browser (Scramjet)

   Lets researchers browse Reddit inside MetaCode to find a subreddit, post
   or profile, then use the current page as the scraper's target. Pages are
   fetched and rewritten by Scramjet (MercuryWorkshop's interception proxy)
   in this browser tab; the network side is epoxy-transport (epoxy-tls in
   WASM) speaking end-to-end TLS through MetaCode's Wisp endpoint, which
   only connects to Reddit's hosts. Nothing here is needed for scraping
   itself — jobs run on the server.

   Loaded lazily: the service worker and Scramjet bundles are fetched only
   when the browser panel is first opened.
   ══════════════════════════════════════════════ */

const RedditBrowser = (() => {

  const PREFIX = '/scramjet/~/';
  const FILES = {
    sw:         '/scramjet-sw.js',
    scramjet:   '/scramjet/scramjet.js',
    controller: '/scramjet/controller.api.js',
    inject:     '/scramjet/controller.inject.js',
    wasm:       '/scramjet/scramjet.wasm',
    transport:  '/scramjet/epoxy-transport.js'
  };
  const REDDIT_HOST = /^(?:[a-z0-9-]+\.)*(reddit\.com|redd\.it)$/i;

  let extraHosts = [];      // hosts the server allows besides reddit.com (e.g. REDDIT_BASE_URL)
  let controller = null;
  let frame = null;
  let iframe = null;
  let initPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-sc-src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.dataset.scSrc = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Couldn\'t load ' + src + ' — is the in-app browser turned off (SCRAPER_BROWSER_ENABLED)?'));
      document.head.appendChild(s);
    });
  }

  // Registers the service worker and waits until it is active.
  async function registerServiceWorker() {
    const reg = await navigator.serviceWorker.register(FILES.sw, { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (reg.active) return reg.active;
    const pending = reg.installing || reg.waiting;
    await new Promise(resolve => {
      if (!pending || pending.state === 'activated') return resolve();
      pending.addEventListener('statechange', function onChange() {
        if (pending.state === 'activated') { pending.removeEventListener('statechange', onChange); resolve(); }
      });
    });
    return reg.active || pending;
  }

  function supportProblem() {
    if (!('serviceWorker' in navigator)) return 'This browser doesn\'t support service workers, which the Reddit browser needs.';
    if (!window.isSecureContext) return 'The Reddit browser needs MetaCode to be opened over https:// or at http://localhost.';
    return null;
  }

  async function init(iframeEl) {
    iframe = iframeEl;
    if (frame && controller) {
      frame = controller.createFrame(iframe);
      return;
    }
    if (!initPromise) {
      initPromise = (async () => {
        const problem = supportProblem();
        if (problem) throw new Error(problem);
        const sw = await registerServiceWorker();
        await loadScript(FILES.scramjet);
        await loadScript(FILES.controller);
        await loadScript(FILES.transport);

        const mod = window.EpoxyTransport;
        const Transport = mod && (mod.default || mod.EpoxyTransport || mod.EpoxyClient || mod);
        if (typeof Transport !== 'function') throw new Error('epoxy-transport didn\'t load correctly.');
        const wisp = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/';
        const transport = new Transport({ wisp });

        const api = window.$scramjetController;
        if (!api || !api.Controller) throw new Error('The Scramjet controller didn\'t load correctly.');
        api.config.prefix = PREFIX;
        api.config.scramjetPath = FILES.scramjet;
        api.config.injectPath = FILES.inject;
        api.config.wasmPath = FILES.wasm;
        controller = new api.Controller({ serviceworker: sw, transport });
        await controller.wait();
      })().catch(err => { initPromise = null; throw err; });
    }
    await initPromise;
    frame = controller.createFrame(iframe);
  }

  // The server's allowed hosts (GET /api/scraper/status → allowedHosts).
  // The Wisp proxy enforces the real allow-list; this only gives a clear
  // message instead of a failed page load.
  function configure(opts) {
    extraHosts = (opts && Array.isArray(opts.allowedHosts) ? opts.allowedHosts : [])
      .map(h => String(h).toLowerCase()).filter(h => !REDDIT_HOST.test(h));
  }

  // Accepts "r/foo", "reddit.com/…" or a full URL; only Reddit addresses.
  function normalizeUrl(input) {
    let text = String(input || '').trim();
    if (!text) return 'https://www.reddit.com/';
    if (/^\/?(r|u|user)\//i.test(text)) text = 'https://www.reddit.com/' + text.replace(/^\//, '');
    if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
    let url;
    try { url = new URL(text); } catch (e) { throw new Error('That isn\'t a valid address.'); }
    if (REDDIT_HOST.test(url.hostname)) {
      url.protocol = 'https:';
      return url.href;
    }
    if (extraHosts.includes(url.hostname.toLowerCase())) return url.href;
    throw new Error('The in-app browser only opens Reddit pages.');
  }

  function go(input) {
    if (!frame) throw new Error('The browser isn\'t ready yet.');
    const url = normalizeUrl(input);
    frame.go(url);
    return url;
  }

  // The real URL of the page shown in the frame (decoded from Scramjet's prefix).
  function currentUrl() {
    if (!iframe || !controller) return null;
    let href;
    try { href = iframe.contentWindow.location.href; } catch (e) { return null; }
    const u = new URL(href);
    const prefix = new URL(frame.prefix, location.href).pathname;
    if (!u.pathname.startsWith(prefix)) return null;
    const encoded = u.pathname.slice(prefix.length) + u.search + u.hash;
    let real;
    try { real = new URL(controller.config.codec.decode(encoded)); } catch (e) { return null; }
    // Scramjet adds its own bookkeeping parameters (e.g. "$io"); drop them.
    Array.from(real.searchParams.keys()).filter(k => k.startsWith('$')).forEach(k => real.searchParams.delete(k));
    return real.href;
  }

  // A page on a configured Reddit mirror (REDDIT_BASE_URL) → the same path on
  // reddit.com, so it can be used as a scrape target.
  function asRedditUrl(href) {
    let u;
    try { u = new URL(href); } catch (e) { return href; }
    if (REDDIT_HOST.test(u.hostname)) return u.href;
    if (extraHosts.includes(u.hostname.toLowerCase())) return 'https://www.reddit.com' + u.pathname + u.search;
    return href;
  }

  function back()    { if (frame) frame.back(); }
  function forward() { if (frame) frame.forward(); }
  function reload()  { if (frame) frame.reload(); }

  return { init, configure, go, currentUrl, asRedditUrl, back, forward, reload, normalizeUrl, supportProblem, isReady: () => !!frame };
})();
