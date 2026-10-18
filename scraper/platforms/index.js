// @ts-check
// ── Other platforms in the scraper (YouTube, X, LinkedIn) ─────────────────────
// Jobs with mode "platform" run here, inside the same job manager as Reddit
// jobs: durable records and checkpoints, pause/resume, progress, logs,
// exports, plan limits and "Add to project" work the same way. Records use the
// Reddit record shape where it fits (videos and posts are `post` records,
// comments and chat messages `comment` records) with a `platform` field.
//
// LinkedIn is read through its official API (the Pages a member manages and
// their posts) or from a member's own data archive; see linkedin.js.

const { ScraperError } = require('../errors');
const { PlatformHttp } = require('./http');
const YT = require('./youtube');
const X = require('./x');
const LI = require('./linkedin');
const { YOUTUBE_KEY_RE, X_TOKEN_RE, LINKEDIN_TOKEN_RE } = require('./config');

const PLATFORMS = ['youtube', 'x', 'linkedin'];
const NAMES = /** @type {Record<string, string>} */ ({ youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn' });

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
  const runners = {
    youtube: YT.createYouTubeRunner({ http, config: pc.youtube, serverQuota }),
    x: X.createXRunner({ http, config: pc.x }),
    linkedin: LI.createLinkedInRunner({ http, config: pc.linkedin })
  };

  /** The user's own key/token from a request body (never stored). @param {string} platform @param {any} body */
  function ownCredential(platform, body) {
    const given = /** @param {unknown} v */ v => v !== undefined && v !== null && v !== '';
    if (platform === 'youtube' && given(body.youtubeApiKey)) {
      const k = String(body.youtubeApiKey).trim();
      if (!YOUTUBE_KEY_RE.test(k)) throw new ScraperError('invalid_request', 'That doesn\'t look like a YouTube (Google) API key.', { status: 400 });
      return { youtubeKey: k };
    }
    if (platform === 'x' && given(body.xBearerToken)) {
      const t = String(body.xBearerToken).trim().replace(/^Bearer\s+/i, '');
      if (!X_TOKEN_RE.test(t)) throw new ScraperError('invalid_request', 'That doesn\'t look like an X API bearer token.', { status: 400 });
      return { xToken: t };
    }
    if (platform === 'linkedin' && given(body.linkedinAccessToken)) {
      const t = String(body.linkedinAccessToken).trim().replace(/^Bearer\s+/i, '');
      if (!LINKEDIN_TOKEN_RE.test(t)) throw new ScraperError('invalid_request', 'That doesn\'t look like a LinkedIn access token.', { status: 400 });
      return { linkedinToken: t };
    }
    return null;
  }

  /** @param {string} platform */
  const serverCredential = platform => (platform === 'youtube' ? pc.youtube.apiKey : platform === 'x' ? pc.x.bearerToken : pc.linkedin.accessToken);

  /**
   * A job spec from POST /jobs with mode "platform".
   * @param {any} body
   */
  function parseSpec(body) {
    const platform = String(body.platform || '');
    if (!PLATFORMS.includes(platform)) throw new ScraperError('invalid_request', 'platform must be "youtube", "x" or "linkedin".', { status: 400 });
    const p = pc[platform];
    if (!p.enabled) throw new ScraperError('not_available', NAMES[platform] + ' collection is turned off on this server.', { status: 403 });

    // A LinkedIn data archive: parsed now, kept in memory for the job only
    if (platform === 'linkedin' && body.target && body.target.type === 'archive') {
      const a = LI.parseArchive(body.target, body.options);
      const capacity = Math.min(deps.config.maxItems, a.records.length);
      return {
        mode: 'platform', engine: 'server', keySource: 'upload', target: a.target, capacity, label: a.target.label,
        options: { maxItems: capacity, maxPages: deps.config.maxPages, delayMs: 0, timeoutMs: deps.config.requestTimeoutMs, concurrency: 1, retries: 0, linkedin: a.options },
        httpFor: () => ({ linkedinArchive: a.records })
      };
    }

    const cred = ownCredential(platform, body);
    if (!cred && !serverCredential(platform)) {
      throw new ScraperError('not_available', platform === 'youtube'
        ? 'Add a YouTube API key first (Scraper → YouTube → API key). This server has none set (YOUTUBE_API_KEY).'
        : platform === 'x' ? 'Add an X API bearer token first (Scraper → X → bearer token). This server has none set (X_BEARER_TOKEN).'
          : 'Add a LinkedIn access token first (Scraper → LinkedIn → access token). This server has none set (LINKEDIN_ACCESS_TOKEN).', { status: 400 });
    }
    /** @type {any} */
    let target, po, capacity;
    if (platform === 'youtube') {
      target = YT.normalizeYouTubeTarget(body.target);
      po = YT.normalizeYouTubeOptions(body.options, target);
      capacity = YT.youtubeCapacity(target, po);
    } else if (platform === 'x') {
      target = X.normalizeXTarget(body.target);
      po = X.normalizeXOptions(body.options, target);
      capacity = po.maxPosts;
    } else {
      target = LI.normalizeLinkedInTarget(body.target);
      po = LI.normalizeLinkedInOptions(body.options, target);
      capacity = LI.linkedinCapacity(target, po);
    }
    capacity = Math.min(deps.config.maxItems, capacity);
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
    if (job.mode !== 'platform') return null;
    if (job.keySource === 'upload') {
      if (job.http && job.http.linkedinArchive) return null;
      throw new ScraperError('invalid_request', 'The uploaded archive isn\'t kept on the server once its import stops. Start a new import from Scraper → LinkedIn.', { status: 400 });
    }
    if (job.keySource !== 'own') return null;
    return ownCredential(job.target.platform, body || {});
  }

  /** What the Scraper page needs to know (never the keys). */
  function status() {
    return {
      youtube: { enabled: pc.youtube.enabled, serverKey: !!pc.youtube.apiKey, quota: pc.youtube.apiKey ? { limit: serverQuota.limit, remaining: serverQuota.remaining() } : null, costs: YT.COST },
      x: { enabled: pc.x.enabled, serverToken: !!pc.x.bearerToken },
      linkedin: { enabled: pc.linkedin.enabled, serverToken: !!pc.linkedin.accessToken }
    };
  }

  return { parseSpec, run, resumeCredential, status, http, serverQuota };
}

module.exports = { createPlatforms, PLATFORMS, NAMES };
