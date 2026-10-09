// ── Fresh connections after a pause ───────────────────────────────────────────
// epoxy-tls keeps HTTP connections open for reuse. When the server closes one
// while it sits idle (Wisp sends CLOSE for its stream), epoxy-tls doesn't notice
// if about 2 s or more pass before the next request: that request goes out on
// the dead connection and never gets an answer, so the page "doesn't load
// within 30 s". Servers close idle connections after a few seconds, and the
// bot pauses at least that long between pages.
//
// So after a pause with nothing in flight, the next request goes through a new
// epoxy client (EpoxyTransport.init() replaces it, with new connections).
// Requests already running keep the old client, and within a page load
// connections are still reused.

export const IDLE_REFRESH_MS = 1000;

export interface Refreshable<A extends unknown[], R> {
  init(): Promise<void>;
  request(...args: A): Promise<R>;
}

export function freshAfterIdle<A extends unknown[], R, T extends Refreshable<A, R>>(transport: T, now: () => number = Date.now): T {
  const request = transport.request.bind(transport);
  let inFlight = 0;
  let lastActive = now();
  let refreshing: Promise<void> | null = null;
  transport.request = async (...args: A): Promise<R> => {
    if (!inFlight && !refreshing && now() - lastActive >= IDLE_REFRESH_MS) {
      refreshing = transport.init().finally(() => { refreshing = null; });
    }
    inFlight++;
    try {
      if (refreshing) await refreshing;
      lastActive = now();
      return await request(...args);
    } finally {
      inFlight--;
      lastActive = now();
    }
  };
  return transport;
}
