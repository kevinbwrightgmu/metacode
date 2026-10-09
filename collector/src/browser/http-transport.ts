// ── Connections to Reddit: Wisp (WebSocket) or MetaCode's HTTP relay ─────────
// Scramjet hands every request to a "transport" (the ProxyTransport interface
// from @mercuryworkshop/proxy-transports: init / ready / request / connect).
//
//  • Wisp (preferred): epoxy-tls in WebAssembly over the WebSocket at /wisp/.
//    TLS runs end to end between this browser and Reddit.
//  • HTTP relay (fallback): when that WebSocket can't open — typically a
//    reverse proxy that doesn't forward WebSocket upgrades — each request is
//    an ordinary POST to /api/scraper/fetch and MetaCode fetches the Reddit URL
//    (GET/HEAD, Reddit's hosts only). Works through any HTTP proxy; the
//    MetaCode server sees the traffic, and pages' own WebSockets aren't
//    available (Reddit pages don't need them to show posts and comments).

type RawHeaders = [string, string][];
interface TransferrableResponse { body: ReadableStream<Uint8Array> | ArrayBuffer | Blob | string; headers: RawHeaders; status: number; statusText: string }

export class HttpRelayTransport {
  ready = true;
  constructor(private endpoint = '/api/scraper/fetch') {}

  async init(): Promise<void> { /* nothing to set up */ }

  async request(remote: URL, method: string, _body: BodyInit | null, headers: RawHeaders, signal?: AbortSignal): Promise<TransferrableResponse> {
    const m = String(method || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') {
      // Pages sometimes post analytics or votes; the relay only reads pages.
      return { status: 405, statusText: 'Method Not Allowed', headers: [['content-type', 'text/plain']], body: 'Not available through the HTTP relay.' };
    }
    const res = await fetch(this.endpoint, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: remote.href, method: m, headers })
    });
    if (!res.ok || !res.body) {
      let message = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error && j.error.message) message = j.error.message; } catch { /* not JSON */ }
      throw new Error('MetaCode\'s HTTP relay: ' + message);
    }
    const reader = res.body.getReader();
    // The first line is the upstream status and headers as JSON; the rest is the body.
    let pending = new Uint8Array(0);
    let newline = -1;
    while (newline === -1) {
      const { value, done } = await reader.read();
      if (done) throw new Error('MetaCode\'s HTTP relay closed the connection early.');
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending);
      merged.set(value, pending.length);
      pending = merged;
      newline = pending.indexOf(10);
      if (newline === -1 && pending.length > 256 * 1024) throw new Error('MetaCode\'s HTTP relay sent an unreadable answer.');
    }
    const meta = JSON.parse(new TextDecoder().decode(pending.subarray(0, newline))) as { status: number; statusText: string; headers: RawHeaders };
    const rest = pending.subarray(newline + 1);
    const body = new ReadableStream<Uint8Array>({
      start(c) { if (rest.length) c.enqueue(rest); },
      async pull(c) {
        const { value, done } = await reader.read();
        if (done) c.close(); else c.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); }
    });
    return { status: meta.status, statusText: meta.statusText, headers: meta.headers, body: m === 'HEAD' ? '' : body };
  }

  connect(_url: URL, _protocols: string[], _headers: RawHeaders, _onopen: (p: string, e: string) => void, _onmessage: (d: unknown) => void,
    onclose: (code: number, reason: string) => void, onerror: (error: string) => void): [(data: unknown) => void, (code: number, reason: string) => void] {
    setTimeout(() => { onerror('WebSockets aren\'t available through MetaCode\'s HTTP relay.'); onclose(1006, 'unavailable'); }, 0);
    return [() => {}, () => {}];
  }
}

/**
 * Can a WebSocket to MetaCode's Wisp endpoint open? → null if yes, else why not.
 * (Opening and immediately closing is harmless: the endpoint just sees a client leave.)
 */
export function probeWebSocket(url: string, timeoutMs = 6000): Promise<string | null> {
  return new Promise(resolve => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (err) { resolve((err as Error).message || 'the WebSocket couldn\'t be created'); return; }
    let settled = false;
    const finish = (problem: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(problem);
    };
    const timer = setTimeout(() => finish('it didn\'t open within ' + Math.round(timeoutMs / 1000) + ' s'), timeoutMs);
    ws.onopen = () => finish(null);
    ws.onerror = () => finish('it was refused or closed before opening');
    ws.onclose = e => finish('it closed before opening (code ' + e.code + ')');
  });
}
