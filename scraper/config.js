// ── Reddit scraper configuration ──────────────────────────────────────────────
// Everything comes from the server's environment (.env), validated the same
// way loadEmisConfig() in server.js validates the EMIS settings: a bad value
// is ignored with a warning (printed at startup), never a crash. Secrets
// (REDDIT_CLIENT_SECRET) are only ever used by the server process; they are
// never sent to the browser, never logged and never passed to the custom-code
// sandbox.

const DEFAULT_USER_AGENT = 'nodejs:metacode-reddit-scraper:1.0 (self-hosted research tool)';

const DEFAULTS = {
  enabled:               true,
  userAgent:             DEFAULT_USER_AGENT,
  redditBaseUrl:         'https://www.reddit.com',
  redditOAuthBaseUrl:    'https://oauth.reddit.com',
  respectRobotsTxt:      true,
  minDelayMs:            1000,     // floor between two requests to the same host (OAuth mode)
  publicMinDelayMs:      6000,     // floor without OAuth: Reddit allows ~10 unauthenticated requests/minute
  defaultDelayMs:        2000,
  requestTimeoutMs:      20000,
  maxConcurrentRequests: 2,        // per Reddit host, shared by every job
  maxItems:              5000,     // hard cap per job
  maxPages:              50,       // hard cap per job
  maxConcurrentJobs:     2,
  maxStoredJobs:         50,
  jobRetentionMinutes:   120,
  maxResponseBytes:      8 * 1024 * 1024,
  customCodeEnabled:     true,
  customTimeoutMs:       120000,
  customMemoryMb:        64,
  customPythonMemoryMb:  256,      // WebAssembly memory for Python (Pyodide) scrapers
  browserEnabled:        true,
  defaultEngine:         'redditapis',  // where the Scraper pages' jobs go unless the user picks another: redditapis | browser | server
  serverTransport:       'auto',   // python | epoxy | auto (Python if found, else epoxy-tls)
  allowPrivateNetwork:   false,
  // Durable jobs (scraper/jobs/job-store.js)
  persistJobs:           true,
  maxQueuedJobs:         20,       // waiting to start, server-wide (backpressure: more → 503 queue_full)
  maxDiskMb:             2048,     // the job folder's size limit
  pausedRetentionHours:  24,       // paused jobs left alone this long are cancelled
  maxJobWaits:           6,        // automatic retries of a job after temporary failures…
  maxJobWaitMinutes:     30,       // …and the longest it waits in total before pausing
  // Circuit breaker per network provider (scraper/network/circuit-breaker.js)
  circuitFailures:       5,
  circuitCooldownSeconds: 30,
  circuitMaxCooldownSeconds: 300
};

function bool(env, name, fallback, warnings) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  warnings.push(name + ' must be true or false; using ' + fallback + '.');
  return fallback;
}

function int(env, name, fallback, min, max, warnings) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warnings.push(name + ' must be a whole number from ' + min + ' to ' + max + '; using ' + fallback + '.');
  return fallback;
}

function baseUrl(env, name, fallback, warnings) {
  const raw = String(env[name] || '').trim();
  if (!raw) return fallback;
  let url = null;
  try { url = new URL(raw); } catch (e) { url = null; }
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    warnings.push(name + ' must be an http(s) origin such as ' + fallback + '; using the default.');
    return fallback;
  }
  return url.origin;
}

function loadScraperConfig(env) {
  env = env || process.env;
  const warnings = [];
  const c = { warnings };

  c.enabled            = bool(env, 'SCRAPER_ENABLED', DEFAULTS.enabled, warnings);
  c.redditBaseUrl      = baseUrl(env, 'REDDIT_BASE_URL', DEFAULTS.redditBaseUrl, warnings);
  c.redditOAuthBaseUrl = baseUrl(env, 'REDDIT_OAUTH_BASE_URL', DEFAULTS.redditOAuthBaseUrl, warnings);

  // Reddit asks for a unique, descriptive User-Agent ("<platform>:<app id>:<version> (by /u/<username>)").
  const ua = String(env.SCRAPER_USER_AGENT || '').trim();
  if (ua && !/^[\x20-\x7E]{8,256}$/.test(ua)) {
    warnings.push('SCRAPER_USER_AGENT must be 8–256 printable ASCII characters; using the default.');
  }
  c.userAgent = ua && /^[\x20-\x7E]{8,256}$/.test(ua) ? ua : DEFAULTS.userAgent;
  if (c.userAgent === DEFAULTS.userAgent) {
    warnings.push('SCRAPER_USER_AGENT is not set. Reddit asks every client to identify itself, e.g. ' +
      '"nodejs:metacode-scraper:1.0 (by /u/your_username)".');
  }

  // Optional Reddit API (OAuth "application-only") credentials. With them the
  // scraper uses Reddit's official Data API (oauth.reddit.com); without them it
  // reads Reddit's public .json pages, subject to robots.txt.
  const id     = String(env.REDDIT_CLIENT_ID || '').trim();
  const secret = String(env.REDDIT_CLIENT_SECRET || '').trim();
  c.oauth = null;
  if (id || secret) {
    if (!id || !secret) warnings.push('Set both REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to use the Reddit API; ignoring the one that is set.');
    else if (!/^[\x21-\x7E]{4,128}$/.test(id) || !/^[\x21-\x7E]{4,256}$/.test(secret)) warnings.push('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET contain characters that cannot be used; ignoring them.');
    else c.oauth = { clientId: id, clientSecret: secret };
  }

  // Optional third-party engine: redditapis.com (pay-per-call Reddit data API).
  c.redditApisBaseUrl = baseUrl(env, 'REDDITAPIS_BASE_URL', 'https://api.redditapis.com', warnings);
  // Accept the key as copied from a curl example ("Bearer …") too.
  const rapiKey = String(env.REDDITAPIS_KEY || env.REDDIT_APIS_KEY || '').trim().replace(/^bearer\s+/i, '').trim();
  c.redditApisKey = null;
  if (rapiKey) {
    if (/^[\x21-\x7E]{8,512}$/.test(rapiKey)) c.redditApisKey = rapiKey;
    else warnings.push('REDDITAPIS_KEY contains characters that cannot be used; ignoring it.');
  }

  c.respectRobotsTxt      = bool(env, 'SCRAPER_RESPECT_ROBOTS_TXT', DEFAULTS.respectRobotsTxt, warnings);
  c.minDelayMs            = int(env, 'SCRAPER_MIN_DELAY_MS', DEFAULTS.minDelayMs, 0, 60000, warnings);
  c.publicMinDelayMs      = int(env, 'SCRAPER_PUBLIC_MIN_DELAY_MS', DEFAULTS.publicMinDelayMs, 0, 120000, warnings);
  c.defaultDelayMs        = int(env, 'SCRAPER_DEFAULT_DELAY_MS', DEFAULTS.defaultDelayMs, 0, 120000, warnings);
  c.requestTimeoutMs      = int(env, 'SCRAPER_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 1000, 120000, warnings);
  c.maxConcurrentRequests = int(env, 'SCRAPER_MAX_CONCURRENT_REQUESTS', DEFAULTS.maxConcurrentRequests, 1, 8, warnings);
  c.maxItems              = int(env, 'SCRAPER_MAX_ITEMS', DEFAULTS.maxItems, 1, 100000, warnings);
  c.maxPages              = int(env, 'SCRAPER_MAX_PAGES', DEFAULTS.maxPages, 1, 1000, warnings);
  c.maxConcurrentJobs     = int(env, 'SCRAPER_MAX_CONCURRENT_JOBS', DEFAULTS.maxConcurrentJobs, 1, 16, warnings);
  c.maxStoredJobs         = int(env, 'SCRAPER_MAX_STORED_JOBS', DEFAULTS.maxStoredJobs, 1, 1000, warnings);
  c.jobRetentionMinutes   = int(env, 'SCRAPER_JOB_RETENTION_MINUTES', DEFAULTS.jobRetentionMinutes, 1, 7 * 24 * 60, warnings);
  c.maxResponseBytes      = int(env, 'SCRAPER_MAX_RESPONSE_BYTES', DEFAULTS.maxResponseBytes, 64 * 1024, 64 * 1024 * 1024, warnings);
  c.customCodeEnabled     = bool(env, 'SCRAPER_CUSTOM_CODE_ENABLED', DEFAULTS.customCodeEnabled, warnings);
  c.customTimeoutMs       = int(env, 'SCRAPER_CUSTOM_TIMEOUT_MS', DEFAULTS.customTimeoutMs, 1000, 15 * 60000, warnings);
  c.customMemoryMb        = int(env, 'SCRAPER_CUSTOM_MEMORY_MB', DEFAULTS.customMemoryMb, 8, 1024, warnings);
  c.customPythonMemoryMb  = int(env, 'SCRAPER_CUSTOM_PYTHON_MEMORY_MB', DEFAULTS.customPythonMemoryMb, 64, 2048, warnings);
  c.browserEnabled        = bool(env, 'SCRAPER_BROWSER_ENABLED', DEFAULTS.browserEnabled, warnings);
  const de = String(env.SCRAPER_DEFAULT_ENGINE || '').trim().toLowerCase();
  if (de && !['redditapis', 'browser', 'server'].includes(de)) warnings.push('SCRAPER_DEFAULT_ENGINE must be redditapis, browser or server; using redditapis.');
  c.defaultEngine = ['redditapis', 'browser', 'server'].includes(de) ? de : DEFAULTS.defaultEngine;
  const st = String(env.SCRAPER_SERVER_TRANSPORT || '').trim().toLowerCase();
  if (st && !['auto', 'python', 'epoxy'].includes(st)) warnings.push('SCRAPER_SERVER_TRANSPORT must be auto, python or epoxy; using auto.');
  c.serverTransport = ['auto', 'python', 'epoxy'].includes(st) ? st : DEFAULTS.serverTransport;
  c.allowPrivateNetwork   = bool(env, 'SCRAPER_ALLOW_PRIVATE_NETWORK', DEFAULTS.allowPrivateNetwork, warnings);
  if (c.allowPrivateNetwork) {
    warnings.push('SCRAPER_ALLOW_PRIVATE_NETWORK is on: the Wisp proxy may connect to private/loopback addresses. Use this only for testing against a local mock server.');
  }
  if (c.defaultDelayMs < c.minDelayMs) c.defaultDelayMs = c.minDelayMs;

  // Durable jobs: where they're kept, how many may wait, how much disk they may use
  c.persistJobs          = bool(env, 'SCRAPER_PERSIST_JOBS', DEFAULTS.persistJobs, warnings);
  c.dataDir              = require('path').resolve(String(env.SCRAPER_DATA_DIR || '').trim() || require('path').join(__dirname, '..', 'scraper-data'));
  c.maxQueuedJobs        = int(env, 'SCRAPER_MAX_QUEUED_JOBS', DEFAULTS.maxQueuedJobs, 1, 1000, warnings);
  c.maxDiskMb            = int(env, 'SCRAPER_MAX_DISK_MB', DEFAULTS.maxDiskMb, 16, 1024 * 1024, warnings);
  c.maxDiskBytes         = c.maxDiskMb * 1024 * 1024;
  c.pausedRetentionHours = int(env, 'SCRAPER_PAUSED_RETENTION_HOURS', DEFAULTS.pausedRetentionHours, 1, 24 * 90, warnings);
  c.maxJobWaits          = int(env, 'SCRAPER_MAX_JOB_WAITS', DEFAULTS.maxJobWaits, 0, 50, warnings);
  c.maxJobWaitMinutes    = int(env, 'SCRAPER_MAX_JOB_WAIT_MINUTES', DEFAULTS.maxJobWaitMinutes, 1, 24 * 60, warnings);
  c.jobWaitBaseMs        = int(env, 'SCRAPER_JOB_WAIT_BASE_MS', 30000, 10, 600000, warnings);
  // Network providers (scraper/network/providers.js) — set by the administrator only
  c.network = {
    SCRAPER_NETWORK_PROVIDERS: String(env.SCRAPER_NETWORK_PROVIDERS || ''),
    SCRAPER_NETWORK_FAILOVER: String(env.SCRAPER_NETWORK_FAILOVER || ''),
    SCRAPER_PROXY_URL: String(env.SCRAPER_PROXY_URL || ''),
    SCRAPER_VPN_GATEWAY_PROXY_URL: String(env.SCRAPER_VPN_GATEWAY_PROXY_URL || ''),
    SCRAPER_VPN_GATEWAY_HEALTH_URL: String(env.SCRAPER_VPN_GATEWAY_HEALTH_URL || '')
  };
  // Circuit breaker
  c.circuitFailures      = int(env, 'SCRAPER_CIRCUIT_FAILURES', DEFAULTS.circuitFailures, 1, 100, warnings);
  c.circuitCooldownMs    = int(env, 'SCRAPER_CIRCUIT_COOLDOWN_SECONDS', DEFAULTS.circuitCooldownSeconds, 1, 3600, warnings) * 1000;
  c.circuitMaxCooldownMs = Math.max(c.circuitCooldownMs, int(env, 'SCRAPER_CIRCUIT_MAX_COOLDOWN_SECONDS', DEFAULTS.circuitMaxCooldownSeconds, 1, 6 * 3600, warnings) * 1000);

  // Hosts the scraper's own requests (standard + custom code) may reach.
  c.apiHosts = Array.from(new Set([
    'www.reddit.com', 'old.reddit.com', 'reddit.com', 'oauth.reddit.com',
    new URL(c.redditBaseUrl).hostname, new URL(c.redditOAuthBaseUrl).hostname
  ]));

  // Hosts the Wisp proxy accepts streams to. It also serves the in-app
  // Reddit browser (Scramjet), which needs Reddit's static/media CDNs, so this
  // is the API hosts plus those CDNs — nothing else.
  c.wispHostPatterns = [
    /^(?:[a-z0-9-]+\.)*reddit\.com$/i,
    /^(?:[a-z0-9-]+\.)*redditstatic\.com$/i,
    /^(?:[a-z0-9-]+\.)*redditmedia\.com$/i,
    /^(?:[a-z0-9-]+\.)*redd\.it$/i
  ];
  [c.redditBaseUrl, c.redditOAuthBaseUrl, c.redditApisBaseUrl].forEach(u => {
    const host = new URL(u).hostname;
    if (!c.wispHostPatterns.some(re => re.test(host))) {
      c.wispHostPatterns.push(new RegExp('^' + host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
    }
  });
  const ports = new Set([443]);
  [c.redditBaseUrl, c.redditOAuthBaseUrl, c.redditApisBaseUrl].forEach(u => {
    const url = new URL(u);
    ports.add(url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80));
  });
  c.wispPorts = Array.from(ports);
  return c;
}

module.exports = { loadScraperConfig, DEFAULTS, DEFAULT_USER_AGENT };
