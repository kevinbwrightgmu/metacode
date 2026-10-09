// ── Scramjet browser layer ────────────────────────────────────────────────────
// Loads Reddit in an <iframe> through MercuryWorkshop Scramjet (2.x alpha +
// scramjet-controller), served by the MetaCode server:
//
//   /scramjet-sw.js               service worker; routes only Scramjet's prefix
//   /scramjet/scramjet.js, .wasm   the rewriter
//   /scramjet/controller.*.js      the controller (tab), inject (page) and SW parts
//   /scramjet/epoxy-transport.js   epoxy-tls over MetaCode's Wisp endpoint (/wisp/),
//                                  which only connects to Reddit's hosts
//
// Request path for a proxied page:
//   iframe → service worker → controller (this tab) → rewrite → epoxy-tls → wss://<MetaCode>/wisp/ → Reddit
//
// The bridge to the bot is a Scramjet controller plugin (ManagedPlugin) — the
// extension point the controller provides for instrumenting pages. It taps:
//   • frame.hooks.init.post — called by Scramjet's inject script each time a
//     page initialises in the frame, with that page's window. The page is
//     served from this same origin, so the bot reads its DOM directly; no
//     cross-origin access and no page scripts are involved.
//   • frame.hooks.error.request — called when a proxied request fails; for a
//     page load it answers with a small error page instead of a broken frame.

import type { PageDriver, PageHandle, RobotsFetch } from '../bot/driver';
import { NavigationError } from '../bot/driver';
import { AbortError } from '../lib/timing';
import { samePage } from '../lib/urls';

// ── The parts of Scramjet's runtime API this file uses (see scramjet-controller/src) ──
interface ScramjetHook { readonly __hook?: never }
interface ControllerFrame {
  id: string;
  prefix: string;
  element: HTMLIFrameElement;
  hooks: { init: { post: ScramjetHook }; error: { request: ScramjetHook } };
  go(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
}
interface ScramjetController {
  prefix: string;
  config: { codec: { encode(s: string): string; decode(s: string): string } };
  wait(): Promise<void>;
  createFrame(element?: HTMLIFrameElement, options?: { plugins: unknown[] }): ControllerFrame;
}
interface ManagedPluginBase {
  frame: ControllerFrame;
  tap(hook: ScramjetHook, callback: (context: never, props: never) => void | Promise<void>): void;
  install(frame: ControllerFrame): void;
}
interface ScramjetControllerApi {
  VERSION?: string;
  config: { prefix: string; scramjetPath: string; injectPath: string; wasmPath: string };
  Controller: new (init: { serviceworker: ServiceWorker; transport: unknown }) => ScramjetController;
  ManagedPlugin: new (name: string, dependencies: string[]) => ManagedPluginBase;
}
interface EpoxyTransportLike {
  ready?: boolean;
  init(): Promise<void>;
  request(url: URL, method: string, body: BodyInit | null, headers: [string, string][], signal?: AbortSignal): Promise<{ status: number; statusText?: string; headers?: [string, string][]; body?: ReadableStream<Uint8Array> | null }>;
}
interface InitContext { window: Window; client: { url?: URL } | null; isTopLevel: boolean }
interface ErrorContext { rawrequest: { rawUrl: string; destination: string }; error: unknown }
interface ErrorProps { setResponse?: { body: string; headers: [string, string][]; status: number; statusText: string }; suppressError?: boolean }

declare global {
  interface Window { $scramjetController?: ScramjetControllerApi; EpoxyTransport?: unknown }
}

const FILES = {
  sw: '/scramjet-sw.js',
  scramjet: '/scramjet/scramjet.js',
  controller: '/scramjet/controller.api.js',
  inject: '/scramjet/controller.inject.js',
  wasm: '/scramjet/scramjet.wasm',
  transport: '/scramjet/epoxy-transport.js'
};
/** Scramjet's URL prefix in this app (each controller adds its own id below it). */
const PREFIX = '/scramjet/~/';
const MAX_ROBOTS_BYTES = 512 * 1024;

export type BrowserState = 'idle' | 'initializing' | 'ready' | 'loading' | 'error';

export interface BrowserStatus {
  state: BrowserState;
  /** The real address of the page shown. */
  url: string | null;
  title: string | null;
  message: string | null;
  /** Subresource requests (images, scripts…) that failed through the proxy since the last page load. */
  failedRequests: number;
}

/** Why Scramjet can't run in this browser, or null. */
export function supportProblem(): string | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'This browser doesn\'t support service workers, which Scramjet needs.';
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'Scramjet needs the collector to be opened over https:// or at http://localhost.';
  if (typeof WebAssembly === 'undefined') return 'This browser doesn\'t support WebAssembly, which Scramjet needs.';
  return null;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-collector-src="' + src + '"]')) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.collectorSrc = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Couldn\'t load ' + src + ' from the MetaCode server. Is MetaCode running (npm start), and is its Reddit browser enabled (SCRAPER_BROWSER_ENABLED)?'));
    document.head.appendChild(s);
  });
}

async function registerServiceWorker(): Promise<ServiceWorker> {
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register(FILES.sw, { scope: '/', updateViaCache: 'none' });
  } catch (err) {
    throw new Error('The Scramjet service worker couldn\'t be registered (' + (err as Error).message + '). Private windows and some privacy settings block service workers.');
  }
  await navigator.serviceWorker.ready;
  const worker = reg.active || reg.waiting || reg.installing;
  if (!worker) throw new Error('The Scramjet service worker didn\'t start.');
  if (worker.state !== 'activated') {
    await new Promise<void>(resolve => {
      const onChange = () => { if (worker.state === 'activated') { worker.removeEventListener('statechange', onChange); resolve(); } };
      worker.addEventListener('statechange', onChange);
      onChange();
    });
  }
  return reg.active || worker;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!));
}

/** The page shown in the frame when a page load fails in the proxy. Plain HTML, no scripts. */
function errorPage(url: string, message: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="collector-proxy-error" content="' + escapeHtml(message) + '">' +
    '<title>Couldn\'t load page</title><style>body{font:15px/1.5 system-ui,sans-serif;color:#1e293b;margin:40px auto;max-width:560px;padding:0 20px}code{word-break:break-all;color:#475569}</style></head>' +
    '<body><h1 style="font-size:20px">This page couldn\'t be loaded</h1><p>' + escapeHtml(message) + '</p><p><code>' + escapeHtml(url) + '</code></p>' +
    '<p>The MetaCode proxy only connects to Reddit. If this keeps happening, check that MetaCode is running and that this computer can reach reddit.com.</p></body></html>';
}

/** A failed proxied request → a readable reason (the transport's own text is kept short, in brackets). */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'unknown error');
  const detail = raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
  if (/InvalidCertificate|UnknownIssuer|certificate|CERT_/i.test(raw)) return 'a secure connection couldn\'t be made because the site\'s certificate wasn\'t trusted — a proxy, firewall or antivirus on this network may be intercepting HTTPS [' + detail + ']';
  if (/refused|ECONNREFUSED/i.test(raw)) return 'the connection was refused [' + detail + ']';
  if (/timed? ?out|timeout/i.test(raw)) return 'the connection timed out [' + detail + ']';
  if (/dns|lookup|resolve|ENOTFOUND/i.test(raw)) return 'the address couldn\'t be looked up — check this computer\'s internet connection [' + detail + ']';
  if (/closed|reset|EOF|ECONNRESET/i.test(raw)) return 'the connection closed before the page arrived [' + detail + ']';
  return detail;
}

interface PageEvent { seq: number; window: Window; url: string }

export class ScramjetBrowser {
  private api: ScramjetControllerApi | null = null;
  private controller: ScramjetController | null = null;
  private frame: ControllerFrame | null = null;
  private transport: EpoxyTransportLike | null = null;
  private initPromise: Promise<void> | null = null;
  private listeners = new Set<(s: BrowserStatus) => void>();
  private pageWaiters = new Set<(e: PageEvent | Error) => void>();
  private navSeq = 0;
  private page: PageEvent | null = null;
  private status: BrowserStatus = { state: 'idle', url: null, title: null, message: null, failedRequests: 0 };
  /** Called for every page shown; returning a reason blocks the page (e.g. a login page reached by clicking). */
  guard: ((url: URL) => string | null) | null = null;

  // ── Status ──────────────────────────────────────────────────────────────
  subscribe(fn: (s: BrowserStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => { this.listeners.delete(fn); };
  }
  getStatus(): BrowserStatus { return this.status; }
  private setStatus(patch: Partial<BrowserStatus>): void {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach(fn => { try { fn(this.status); } catch { /* ignore */ } });
  }

  // ── Start-up ────────────────────────────────────────────────────────────
  /** Loads Scramjet and attaches it to `iframe`. Safe to call again (e.g. after the iframe is re-mounted). */
  async init(iframe: HTMLIFrameElement): Promise<void> {
    if (this.frame && this.frame.element === iframe) return;
    // Already attaching to this iframe (e.g. React running an effect twice): one frame only
    if (this.attaching && this.attaching.element === iframe) return this.attaching.promise;
    const promise = (async () => {
      if (!this.initPromise) {
        this.setStatus({ state: 'initializing', message: 'Starting Scramjet…' });
        this.initPromise = this.start().catch(err => {
          this.initPromise = null;
          this.setStatus({ state: 'error', message: errorText(err) });
          throw err;
        });
      }
      await this.initPromise;
      this.frame = this.controller!.createFrame(iframe, { plugins: [this.createBridge()] });
      this.setStatus({ state: 'ready', message: null });
    })();
    this.attaching = { element: iframe, promise };
    try { await promise; } finally { if (this.attaching && this.attaching.promise === promise) this.attaching = null; }
  }
  private attaching: { element: HTMLIFrameElement; promise: Promise<void> } | null = null;

  private async start(): Promise<void> {
    const problem = supportProblem();
    if (problem) throw new Error(problem);
    const sw = await registerServiceWorker();
    await loadScript(FILES.scramjet);
    await loadScript(FILES.controller);
    this.transport = await this.getTransport();
    const api = window.$scramjetController;
    if (!api || !api.Controller || !api.ManagedPlugin) throw new Error('The Scramjet controller didn\'t load correctly.');
    api.config.prefix = PREFIX;
    api.config.scramjetPath = FILES.scramjet;
    api.config.injectPath = FILES.inject;
    api.config.wasmPath = FILES.wasm;
    this.api = api;
    this.controller = new api.Controller({ serviceworker: sw, transport: this.transport });
    await this.controller.wait();
  }

  private async getTransport(): Promise<EpoxyTransportLike> {
    if (this.transport) return this.transport;
    await loadScript(FILES.transport);
    const mod = window.EpoxyTransport as Record<string, unknown> | undefined;
    const Transport = (mod && (mod.default || mod.EpoxyTransport || mod.EpoxyClient)) || mod;
    if (typeof Transport !== 'function') throw new Error('epoxy-transport didn\'t load correctly.');
    const wisp = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/wisp/';
    const t = new (Transport as new (o: { wisp: string }) => EpoxyTransportLike)({ wisp });
    if (!t.ready) await t.init();
    this.transport = t;
    return t;
  }

  // ── The bridge plugin ───────────────────────────────────────────────────
  private createBridge(): ManagedPluginBase {
    const api = this.api!;
    const browser = this;
    class CollectorBridge extends api.ManagedPlugin {
      constructor() { super('metacode-collector-bridge', []); }
      override install(frame: ControllerFrame): void {
        super.install(frame);
        this.tap(frame.hooks.init.post, ((ctx: InitContext) => { if (ctx.isTopLevel) browser.onPage(ctx); }) as never);
        this.tap(frame.hooks.error.request, ((ctx: ErrorContext, props: ErrorProps) => browser.onRequestError(ctx, props)) as never);
      }
    }
    return new CollectorBridge();
  }

  /** The real URL behind a proxied address (or null when it isn't one of this frame's). */
  realUrl(proxied: string): string | null {
    if (!this.frame || !this.controller) return null;
    try {
      const u = new URL(proxied, location.href);
      const prefix = new URL(this.frame.prefix, location.href).pathname;
      if (!u.pathname.startsWith(prefix)) return null;
      const real = new URL(this.controller.config.codec.decode(u.pathname.slice(prefix.length) + u.search + u.hash));
      for (const k of Array.from(real.searchParams.keys())) if (k.startsWith('$')) real.searchParams.delete(k);
      return real.href;
    } catch {
      return null;
    }
  }

  private onPage(ctx: InitContext): void {
    let url: string | null = null;
    try { url = ctx.client && ctx.client.url ? String(ctx.client.url.href) : null; } catch { url = null; }
    url = url || this.realUrl(String(ctx.window.location.href));
    if (!url || url === 'about:blank') return;
    const blocked = this.guard ? this.guard(new URL(url)) : null;
    if (blocked) {
      this.setStatus({ state: 'error', url, message: blocked });
      if (this.frame) this.frame.element.src = 'about:blank';
      return;
    }
    const event: PageEvent = { seq: this.navSeq, window: ctx.window, url };
    this.page = event;
    this.setStatus({ state: 'ready', url, title: null, message: null, failedRequests: 0 });
    const readTitle = () => { try { if (this.page === event) this.setStatus({ title: ctx.window.document.title || null }); } catch { /* page gone */ } };
    try { ctx.window.addEventListener('load', readTitle, { once: true }); } catch { /* ignore */ }
    setTimeout(readTitle, 1500);
    this.pageWaiters.forEach(w => w(event));
  }

  private onRequestError(ctx: ErrorContext, props: ErrorProps): void {
    const dest = ctx.rawrequest.destination;
    const url = this.realUrl(ctx.rawrequest.rawUrl) || ctx.rawrequest.rawUrl;
    // Only the page being opened counts as a failed page load; a failed embed inside it
    // (e.g. a video player from a host the proxy doesn't allow) is just a failed request.
    const topLevel = (dest === 'document' || dest === 'iframe') && this.status.state === 'loading' && !!this.status.url && samePage(url, this.status.url);
    if (dest === 'document' || dest === 'iframe') {
      const message = 'The proxy couldn\'t fetch the page: ' + errorText(ctx.error);
      props.setResponse = { body: errorPage(url, message), headers: [['content-type', 'text/html; charset=utf-8']], status: 502, statusText: 'Bad Gateway' };
      props.suppressError = true;
      if (topLevel) {
        this.setStatus({ state: 'error', url, message });
        this.pageWaiters.forEach(w => w(new NavigationError(message)));
        return;
      }
    }
    this.setStatus({ failedRequests: this.status.failedRequests + 1 });
  }

  // ── Navigation ──────────────────────────────────────────────────────────
  private requireFrame(): ControllerFrame {
    if (!this.frame) throw new Error('The browser isn\'t ready yet.');
    return this.frame;
  }
  /** Opens a URL (already checked against the collector's navigation rules). */
  go(url: string): void {
    const frame = this.requireFrame();
    this.navSeq++;
    this.setStatus({ state: 'loading', url, title: null, message: null, failedRequests: 0 });
    frame.go(url);
  }
  back(): void { this.requireFrame().back(); }
  forward(): void { this.requireFrame().forward(); }
  reload(): void { this.setStatus({ state: 'loading' }); this.requireFrame().reload(); }
  get isReady(): boolean { return !!this.frame; }

  /** The page currently shown, as a live handle (follows the frame if Reddit navigates or reloads it). */
  private handle(): PageHandle {
    const browser = this;
    return {
      get url() { return browser.page ? browser.page.url : ''; },
      get document() {
        if (!browser.page) throw new NavigationError('No page is loaded.');
        try { return browser.page.window.document; } catch { throw new NavigationError('The page is no longer available.'); }
      }
    };
  }

  // ── PageDriver for the bot ──────────────────────────────────────────────
  driver(timeoutMs: () => number): PageDriver {
    return {
      open: (url, signal) => this.open(url, signal, timeoutMs()),
      scrollToEnd: page => {
        const doc = page.document;
        const win = doc.defaultView;
        const el = doc.scrollingElement || doc.documentElement;
        if (win) win.scrollTo(0, el.scrollHeight);
        el.scrollTop = el.scrollHeight;
      },
      fetchRobots: (origin, signal) => this.fetchText(new URL('/robots.txt', origin), signal).catch(err => {
        if (signal.aborted) throw new AbortError();
        throw new Error(errorText(err));
      })
    };
  }

  private open(url: string, signal: AbortSignal, timeoutMs: number): Promise<PageHandle> {
    if (signal.aborted) return Promise.reject(new AbortError());
    return new Promise<PageHandle>((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pageWaiters.delete(onEvent);
        signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(this.handle());
      };
      // The first page of this navigation; Reddit may redirect (e.g. to the subreddit's canonical case).
      const onEvent = (e: PageEvent | Error) => {
        if (e instanceof Error) return finish(e);
        if (e.seq !== seq) return;
        const ready = () => finish(null);
        try {
          if (e.window.document.readyState === 'loading') e.window.document.addEventListener('DOMContentLoaded', ready, { once: true });
          else ready();
        } catch { finish(new NavigationError('The page closed while loading.')); }
      };
      const onAbort = () => finish(new AbortError());
      const timer = setTimeout(() => finish(new NavigationError('The page didn\'t load within ' + Math.round(timeoutMs / 1000) + ' s.')), timeoutMs);
      this.pageWaiters.add(onEvent);
      signal.addEventListener('abort', onAbort, { once: true });
      let seq: number;
      try {
        this.go(url);
        seq = this.navSeq;
      } catch (err) {
        finish(err as Error);
        return;
      }
      // Already there (same URL loaded and its init happened synchronously)
      if (this.page && this.page.seq === seq && samePage(this.page.url, url)) onEvent(this.page);
    });
  }

  /** A GET through the same Scramjet transport (epoxy-tls over Wisp) — used for robots.txt. */
  async fetchText(url: URL, signal?: AbortSignal): Promise<RobotsFetch> {
    const transport = await this.getTransport();
    const res = await transport.request(url, 'GET', null, [['accept', 'text/plain,*/*']], signal);
    let text = '';
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ROBOTS_BYTES) { reader.cancel().catch(() => {}); break; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
    return { status: res.status, text };
  }

  /** Scramjet's version string, when the controller reports it. */
  get version(): string | null { return this.api?.VERSION ?? null; }
}
