// ── Waiting, pausing, retrying ────────────────────────────────────────────────

export class AbortError extends Error {
  constructor(message = 'Stopped') { super(message); this.name = 'AbortError'; }
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal && signal.aborted) throw new AbortError();
}

/** Waits `ms`, or rejects with AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new AbortError());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); reject(new AbortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pause/resume for a running job: `await gate.wait(signal)` returns once the job isn't paused. */
export class PauseGate {
  private paused = false;
  private waiters: (() => void)[] = [];
  get isPaused(): boolean { return this.paused; }
  pause(): void { this.paused = true; }
  resume(): void {
    this.paused = false;
    const w = this.waiters;
    this.waiters = [];
    w.forEach(fn => fn());
  }
  wait(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new AbortError());
      const onAbort = () => { this.waiters = this.waiters.filter(w => w !== done); reject(new AbortError()); };
      const done = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      this.waiters.push(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export interface RetryOptions {
  /** Retries after the first try (0 = no retries). */
  retries: number;
  baseMs: number;
  maxMs: number;
  signal?: AbortSignal;
  isRetryable: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The wait before retry `attempt` (1-based): baseMs, 2×, 4×… capped at maxMs. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Runs `fn`, retrying recoverable failures with bounded exponential backoff. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const wait = opts.sleepFn || sleep;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(opts.signal);
    try {
      return await fn(attempt);
    } catch (err) {
      if (isAbort(err) || attempt >= opts.retries || !opts.isRetryable(err)) throw err;
      const ms = backoffDelay(attempt + 1, opts.baseMs, opts.maxMs);
      opts.onRetry?.(err, attempt + 1, ms);
      await wait(ms, opts.signal);
    }
  }
}
