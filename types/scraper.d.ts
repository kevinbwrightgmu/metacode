// Shared types for the scraper's network layer and durable jobs.
// Used through JSDoc (`@typedef {import('../../types/scraper').X} X`) by the
// `// @ts-check` modules; `npm run typecheck` checks them.

/** Where a job is in its life. See scraper/jobs/job-manager.js for the allowed transitions. */
export type JobStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** One HTTP request as the scraper's transports take it. */
export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | null;
  timeoutMs: number;
  signal?: AbortSignal | null;
}

/** A transport's answer (any HTTP status; transport failures throw a ScraperError). */
export interface TransportResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url?: string;
}

/** Anything that can carry a request: the existing Python / epoxy-tls transports, a proxy, a gateway. */
export interface Transport {
  kind: string;
  request(req: TransportRequest): Promise<TransportResponse>;
  status?(): Record<string, unknown>;
  choose?(): Promise<unknown>;
  close?(): void;
  info?: unknown;
}

export type ProviderKind = 'direct' | 'http-proxy' | 'vpn-gateway';

/** What a network provider can do — reported, never assumed. */
export interface ProviderCapabilities {
  /** HTTPS to the allow-listed hosts, with certificate verification. */
  https: boolean;
  /** Routes through an HTTP(S) CONNECT proxy. */
  httpProxy: boolean;
  /** SOCKS proxies (not supported by the HTTP client MetaCode uses). */
  socks: boolean;
  /** Has an active health check besides watching request outcomes. */
  healthCheck: boolean;
  /** Host names are resolved by the proxy / gateway rather than this server. */
  remoteDns: boolean;
  /** Requests leave from another IP address than this server's. */
  changesEgressIp: boolean;
}

export interface HealthResult {
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  /** A short, non-sensitive reason (never addresses or credentials). */
  detail: string | null;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  opens: number;
  openedAt: string | null;
  retryAt: string | null;
  lastFailureAt: string | null;
  lastFailure: RequestOutcome | null;
  lastSuccessAt: string | null;
  forcedOpen: string | null;
}

/** How one request ended, as counted by the metrics and the circuit breaker. */
export type RequestOutcome =
  | 'ok' | 'redirect' | 'http_401' | 'http_403' | 'http_404' | 'http_429' | 'http_4xx' | 'http_5xx'
  | 'timeout' | 'network' | 'tls' | 'proxy' | 'too_large' | 'blocked' | 'cancelled' | 'circuit_open' | 'invalid';

/** What ordinary users may see about a provider: no addresses, no credentials. */
export interface ProviderPublicStatus {
  id: string;
  kind: ProviderKind;
  label: string;
  active: boolean;
  available: boolean;
  state: 'ok' | 'degraded' | 'unavailable' | 'misconfigured';
  circuit: CircuitState;
  retryAt: string | null;
  capabilities: ProviderCapabilities;
}

export interface MetricsSnapshot {
  total: number;
  byOutcome: Partial<Record<RequestOutcome, number>>;
  active: number;
  timeouts: number;
  rateLimited: number;
  recent: { window: number; ok: number; failed: number; p50Ms: number | null; p95Ms: number | null };
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: RequestOutcome | null;
}

/** The standard scraper's resume point; advanced only after the page's records are on disk. */
export interface StandardCheckpoint {
  v: 1;
  phase: 'listing' | 'comments' | 'done';
  /** Index into the sweep's list of sorts (0 without a sweep). */
  sort: number;
  /** Reddit's `after` cursor for the next page of the current listing (null: start of the listing). */
  after: string | null;
  /** Pages already read from the current listing. */
  pages: number;
  /** Items Reddit has listed so far in the current listing (its `count` parameter). */
  seen: number;
  /** Comment threads already fetched (comments phase). */
  commentsDone: number;
}

export interface JobCheckpoint {
  /** When the checkpoint was committed. */
  at: string;
  /** Records on disk when it was committed. */
  items: number;
  state: StandardCheckpoint;
}

/** A job event kept on disk (events.ndjson): status changes, waits, checkpoints, errors. */
export interface JobEvent {
  ts: string;
  type: 'created' | 'status' | 'checkpoint' | 'wait' | 'resume' | 'pause_requested' | 'cancel_requested' | 'error' | 'recovered' | 'config';
  data?: Record<string, string | number | boolean | null>;
}
