// ── What the bot needs from a browser ─────────────────────────────────────────
// The Scramjet layer (browser/scramjet-driver.ts) implements this; tests use
// a fake that serves fixture documents. The bot never touches Scramjet
// directly, so the browser engine can be swapped without changing it.

export interface PageHandle {
  /** The real address of the page shown (not Scramjet's proxied address). Live: follows client-side navigation. */
  readonly url: string;
  /** The page's document (same-origin through Scramjet). Live: the current document of the frame. */
  readonly document: Document;
}

export interface RobotsFetch { status: number; text: string }

export interface PageDriver {
  /** Opens `url` and resolves once its document exists. Throws NavigationError when it can't. */
  open(url: string, signal: AbortSignal): Promise<PageHandle>;
  /** Scrolls the page to its end, so lazy loaders fetch more content. */
  scrollToEnd(page: PageHandle): void;
  /** GET <origin>/robots.txt through the same network path as the pages. */
  fetchRobots(origin: string, signal: AbortSignal): Promise<RobotsFetch>;
}

/** A page that didn't load (timeout, proxy failure): worth retrying. */
export class NavigationError extends Error {
  readonly retryable = true;
  constructor(message: string) { super(message); this.name = 'NavigationError'; }
}
