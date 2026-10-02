// ── Server-side HTTPS over Wisp (epoxy-tls) ───────────────────────────────────
// The scraper never opens sockets to Reddit itself. Every request goes:
//
//   scraper job → EpoxyWispTransport (epoxy-tls, WASM, in this process)
//     → WebSocket ws://127.0.0.1:<port>/wisp/ (MetaCode's own Wisp endpoint)
//     → wisp-js opens a TCP stream to an allow-listed Reddit host
//     → TLS between epoxy-tls and Reddit (end-to-end; the Wisp hop only sees ciphertext)
//
// so the Wisp endpoint's allow-list is the one place that decides where the
// scraper can connect, for the server and for the in-app browser alike.
// epoxy-tls verifies certificates against its bundled web PKI roots;
// certificate validation is never disabled.

const { ScraperError, classifyTransportError } = require('../errors');

// epoxy-tls turns request bodies into bytes with `new Request("", { body })`
// (see its convert_body_inner helper). In a browser "" resolves against the
// page URL; Node has no base URL and throws "Invalid URL", which epoxy reports
// as "Invalid request body" — so every POST (e.g. Reddit's OAuth token request)
// failed. Only that exact call shape (an empty URL, which can never succeed in
// Node) is given a placeholder base; every other Request is untouched.
function allowEmptyRequestUrl() {
  const Native = globalThis.Request;
  if (typeof Native !== 'function' || Native.__metacodeEmptyUrl) return;
  try { new Native(''); return; } catch (e) { /* Node: needs the shim */ }
  class EpoxyBodyRequest extends Native {
    constructor(input, init) { super(input === '' ? 'http://epoxy-body.invalid/' : input, init); }
  }
  EpoxyBodyRequest.__metacodeEmptyUrl = true;
  globalThis.Request = EpoxyBodyRequest;
}

let epoxyModulePromise = null;
function loadEpoxy() {
  allowEmptyRequestUrl();
  // epoxy-tls is an ES module (wasm-bindgen output with the WASM inlined).
  if (!epoxyModulePromise) {
    epoxyModulePromise = import('@mercuryworkshop/epoxy-tls').then(async mod => {
      await mod.default();
      return mod;
    }).catch(err => {
      epoxyModulePromise = null;
      throw err;
    });
  }
  return epoxyModulePromise;
}

function transportAvailable() {
  return typeof WebSocket === 'function' && typeof ReadableStream === 'function';
}

class EpoxyWispTransport {
  // getWispUrl: () => 'ws://127.0.0.1:<port>/wisp/' (known once the server listens)
  constructor(opts) {
    this.getWispUrl = opts.getWispUrl;
    this.userAgent = opts.userAgent;
    this.maxResponseBytes = opts.maxResponseBytes || 8 * 1024 * 1024;
    this.client = null;
    this.clientUrl = null;
    this.info = null;
  }

  async getClient() {
    if (!transportAvailable()) {
      throw new ScraperError('not_available', 'The scraper needs Node.js 22 or newer (WebSocket support for the Wisp transport).', { status: 503 });
    }
    const url = this.getWispUrl();
    if (!url) throw new ScraperError('proxy_error', 'The Wisp proxy endpoint isn\'t running yet.', { status: 503, retryable: true });
    if (this.client && this.clientUrl === url) return this.client;
    let mod;
    try {
      mod = await loadEpoxy();
    } catch (err) {
      throw new ScraperError('not_available', 'The epoxy-tls client couldn\'t be loaded. Run "npm install" and restart MetaCode.', { status: 503, detail: String(err && err.message) });
    }
    this.info = mod.info;
    const options = new mod.EpoxyClientOptions();
    options.user_agent = this.userAgent;
    options.wisp_v2 = true;
    options.udp_extension_required = false;
    options.redirect_limit = 0;            // redirects are followed (and re-checked) by the caller
    this.client = new mod.EpoxyClient(url, options);
    this.clientUrl = url;
    return this.client;
  }

  resetClient() {
    this.client = null;
    this.clientUrl = null;
  }

  // Server shutdown: stop using the client. (epoxy-tls keeps idle pooled
  // connections alive with its own timers — up to ~90 s — which is why the
  // test runner uses --test-force-exit; freeing the WASM client doesn't
  // cancel them and could race with in-flight requests.)
  close() {
    this.resetClient();
  }

  // → { status, statusText, headers: {lowercase name: value}, body: string, url }
  async request(req) {
    const timeoutMs = req.timeoutMs || 20000;
    const signal = req.signal || null;
    if (signal && signal.aborted) throw signal.reason || new ScraperError('cancelled', 'Cancelled.');

    const client = await this.getClient();
    let timer = null;
    let reader = null;
    let onAbort = null;

    const work = (async () => {
      const init = { method: req.method || 'GET', headers: Object.assign({}, req.headers || {}), redirect: 'manual' };
      if (req.body !== undefined && req.body !== null) init.body = req.body;
      const res = await client.fetch(req.url, init);
      const headers = {};
      res.headers.forEach((value, name) => { headers[String(name).toLowerCase()] = value; });
      let body = '';
      if (res.body && init.method !== 'HEAD') {
        reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          total += chunk.byteLength;
          if (total > this.maxResponseBytes) {
            reader.cancel().catch(() => {});
            throw new ScraperError('too_large', 'Reddit\'s response was larger than SCRAPER_MAX_RESPONSE_BYTES (' +
              Math.round(this.maxResponseBytes / 1024) + ' KB).', { status: 502 });
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
      }
      return { status: res.status, statusText: res.statusText || '', headers, body, url: req.url };
    })();

    const guard = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new ScraperError('timeout', 'Reddit didn\'t answer within ' + Math.round(timeoutMs / 1000) +
        ' seconds.', { status: 504, retryable: true })), timeoutMs);
      if (signal) {
        onAbort = () => reject(signal.reason || new ScraperError('cancelled', 'Cancelled.'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      return await Promise.race([work, guard]);
    } catch (err) {
      if (reader) reader.cancel().catch(() => {});
      work.catch(() => {});      // the losing branch may still settle later
      const classified = classifyTransportError(err);
      if (classified.type === 'proxy_error') this.resetClient();
      throw classified;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

module.exports = { EpoxyWispTransport, transportAvailable, loadEpoxy };
