// @ts-check
// ── Other platforms in the scraper (YouTube, X) ───────────────────────────────
// Jobs with mode "platform" run here, inside the same job manager as Reddit
// jobs: durable records and checkpoints, pause/resume, progress, logs,
// exports, plan limits and "Add to project" work the same way. Records use the
// Reddit record shape where it fits (videos and posts are `post` records,
// comments and chat messages `comment` records) with a `platform` field.
//
// LinkedIn isn't offered: it has no API for reading other people's profiles
// or posts, and its terms forbid automated collection behind its login.

const { ScraperError } = require('../errors');
const { PlatformHttp } = require('./http');
const YT = require('./youtube');
const X = require('./x');
const { YOUTUBE_KEY_RE, X_TOKEN_RE } = require('./config');

const PLATFORMS = ['youtube', 'x'];

/**
 * @param {object} deps
 * @param {any} deps.config        the scraper config (config.platforms from platforms/config.js)
 * @param {any} deps.transport     the network manager
 * @param {any} deps.limiter       the shared rate limiter
 */
function createPlatforms(deps) {
  const pc = deps.config.platforms;
  const http = new PlatformHttp({ transport: deps.transport, limiter: deps.limiter, userAgent: deps.config.userAgent, timeoutMs: deps.config.requestTimeoutMs });
  const serverQuota = new YT.QuotaMeter(pc.youtube.dailyQuota);
  const runners = { youtube: YT.createYouTubeRunner({ http, config: pc.youtube, serverQuota }), x: X.createXRunner({ http, config: pc.x }) };

  /** The user's own key/token from a request body (never stored). @param {string} platform @param {any} body */
  function ownCredential(platform, body) {
    if (platform === 'youtube' && body.youtubeApiKey !== undefined && body.youtubeApiKey !== null && body.youtubeApiKey !== '') {
      const k = String(body.youtubeApiKey).trim();
      if (!YOUTUBE_KEY_RE.test(k)) throw new ScraperError('invalid_request', 'That doesn\'t look like a YouTube (Google) API key.', { status: 400 });
      return { youtubeKey: k };
    }
    if (platform === 'x' && body.xBearerToken !== undefined && body.xBearerToken !== null && body.xBearerToken !== '') {
      const t = String(body.xBearerToken).trim().replace(/^Bearer\s+/i, '');
      if (!X_TOKEN_RE.test(t)) throw new ScraperError('invalid_request', 'That doesn\'t look like an X API bearer token.', { status: 400 });
      return { xToken: t };
    }
    return null;
  }

  /**
   * A job spec from POST /jobs with mode "platform".
   * @param {any} body
   */
  function parseSpec(body) {
    const platform = String(body.platform || '');
    if (!PLATFORMS.includes(platform)) {
      if (platform === 'linkedin') throw new ScraperError('not_available', 'LinkedIn isn\'t available: it has no API for reading other people\'s profiles or posts, and its terms forbid automated collection behind its login.', { status: 400 });
      throw new ScraperError('invalid_request', 'platform must be "youtube" or "x".', { status: 400 });
    }
    const p = platform === 'youtube' ? pc.youtube : pc.x;
    if (!p.enabled) throw new ScraperError('not_available', (platform === 'youtube' ? 'YouTube' : 'X') + ' collection is turned off on this server.', { status: 403 });
    const cred = ownCredential(platform, body);
    if (!cred && !(platform === 'youtube' ? pc.youtube.apiKey : pc.x.bearerToken)) {
      throw new ScraperError('not_available', platform === 'youtube'
        ? 'Add a YouTube API key first (Scraper → YouTube → API key). This server has none set (YOUTUBE_API_KEY).'
        : 'Add an X API bearer token first (Scraper → X → bearer token). This server has none set (X_BEARER_TOKEN).', { status: 400 });
    }
    const target = platform === 'youtube' ? YT.normalizeYouTubeTarget(body.target) : X.normalizeXTarget(body.target);
    const po = platform === 'youtube' ? YT.normalizeYouTubeOptions(body.options, target) : X.normalizeXOptions(body.options, target);
    const capacity = Math.min(deps.config.maxItems, platform === 'youtube' ? YT.youtubeCapacity(target, /** @type {any} */ (po)) : /** @type {any} */ (po).maxPosts);
    const options = {
      maxItems: capacity, maxPages: deps.config.maxPages, delayMs: p.minDelayMs, timeoutMs: deps.config.requestTimeoutMs,
      concurrency: 1, retries: 2, [platform]: po
    };
    const spec = { mode: 'platform', engine: 'server', keySource: cred ? 'own' : 'server', target, options, capacity, label: target.label };
    if (cred) /** @type {any} */ (spec).httpFor = () => cred;
    return spec;
  }

  /** @param {any} job @param {any} ctx */
  function run(job, ctx) {
    const r = /** @type {Record<string, (job: any, ctx: any) => Promise<void>>} */ (runners)[job.target && job.target.platform];
    if (!r) throw new ScraperError('invalid_request', 'Unknown platform.', { status: 400 });
    return r(job, ctx);
  }

  /** Resume with the user's key again. @param {any} job @param {any} body */
  function resumeCredential(job, body) {
    if (job.mode !== 'platform' || job.keySource !== 'own') return null;
    return ownCredential(job.target.platform, body || {});
  }

  /** What the Scraper page needs to know (never the keys). */
  function status() {
    return {
      youtube: { enabled: pc.youtube.enabled, serverKey: !!pc.youtube.apiKey, quota: pc.youtube.apiKey ? { limit: serverQuota.limit, remaining: serverQuota.remaining() } : null, costs: YT.COST },
      x: { enabled: pc.x.enabled, serverToken: !!pc.x.bearerToken },
      linkedin: { enabled: false, reason: 'LinkedIn has no API for reading other people\'s profiles or posts, and its terms forbid automated collection behind its login.' }
    };
  }

  return { parseSpec, run, resumeCredential, status, http, serverQuota };
}

module.exports = { createPlatforms, PLATFORMS };
