// ── Errors of MetaCode's OpenCode service ─────────────────────────────────────
// Every failure the service answers with is a ServiceError: an HTTP status, a
// machine-readable type (the table below) and a message for MetaCode's
// operator. MetaCode (server.js) takes type, status, message, scope and
// retry_after_seconds as they are, so the messages here are what people read.
//
//   invalid_request       400  bad body; the provider refused the request (400/422/other 4xx)
//   unsupported_feature   400  tools / images for a model that can't take them
//   authentication_error  401  the provider didn't accept the key (or the service token is wrong)
//   permission_error      403  the provider refused this key/model (JSON answer)
//   blocked               403  a web page answered 403 (proxy, firewall, wrong address)
//   model_not_found       404  the provider doesn't offer the model
//   request_too_large     413  the request is too big for the provider
//   rate_limited          429  scope 'model': only this model is throttled; 'provider': the provider asked to pause
//   quota_exceeded        429  scope 'provider': the provider's budget / free limit is used up; 'model': a spend
//                              limit for this model only (Zen's BudgetLimitError with "coverage": "models")
//   cancelled             499  the caller went away
//   internal_error        500  a bug in the service (details only in its log)
//   upstream_error        502  the provider had a server problem (5xx, 408)
//   malformed_response    502  an answer that can't be read (web page on 200, cut short, bad JSON)
//   network               502  the provider couldn't be reached (code: ECONNREFUSED, ENOTFOUND, …)
//   not_configured        503  the model's provider isn't set up
//   timeout               504  the provider didn't answer in time
//
// fromAIError() turns what @opencode/ai throws (an AIError with a typed
// `reason`, see the mapping report §3) into a ServiceError. Messages name the
// provider by its display name, quote the provider's own words (redacted,
// short, never HTML), say what to check, and never contain keys, tokens or
// full URLs (a host at most). redact() is the one place that cleans text.
//
// No @opencode/ai import here: this module is plain data and text, so every
// part of the service (and its tests) can use it cheaply.

/** The HTTP status that goes with each error type (§4.2 of the spec). */
export const TYPE_STATUS = Object.freeze({
  invalid_request: 400,
  unsupported_feature: 400,
  authentication_error: 401,
  permission_error: 403,
  blocked: 403,
  model_not_found: 404,
  request_too_large: 413,
  rate_limited: 429,
  quota_exceeded: 429,
  cancelled: 499,
  internal_error: 500,
  upstream_error: 502,
  malformed_response: 502,
  network: 502,
  not_configured: 503,
  timeout: 504
});

const MAX_MESSAGE = 400;       // whole message
const MAX_DETAIL = 200;        // the provider's own words, quoted inside it

// Header and error type the shims in http.mjs use to mark answers they made up
// (a web page or a redirect instead of the API, an empty or unreadable answer).
export const SHIM_HEADER = 'x-oc-shim';
export const SHIM_STATUS_HEADER = 'x-oc-upstream-status';
export const SHIM_HOST_HEADER = 'x-oc-upstream-host';
export const SHIM_ERROR_TYPE = 'metacode_shim';

/**
 * A failure the service answers with.
 *
 * @param {number|undefined} status  HTTP status; when falsy, the status of `type` in TYPE_STATUS (else 500)
 * @param {string} type              one of the TYPE_STATUS keys
 * @param {string} message           for MetaCode's operator (already redacted; cut to 400 characters)
 * @param {object} [extra]           optional fields:
 *   code (string), provider (id), model (full id), scope ('model'|'provider'),
 *   upstreamStatus (number), retryAfterSeconds (number), resetAt (ISO string),
 *   window ('day'|'week'|…), log (a line for the service's own log, never sent),
 *   cause (the original error, never sent)
 *
 * Fields: status, type, message, code, provider, model, scope, upstreamStatus,
 * retryAfterSeconds, resetAt, window, log, cause. `toBody()` gives the JSON
 * body, `toHeaders()` the extra response headers (Retry-After).
 */
export class ServiceError extends Error {
  constructor(status, type, message, extra) {
    super(clip(String(message === undefined || message === null ? '' : message), MAX_MESSAGE));
    this.name = 'ServiceError';
    this.type = type || 'internal_error';
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : (TYPE_STATUS[this.type] || 500);
    const x = extra || {};
    this.code = x.code;
    this.provider = x.provider;
    this.model = x.model;
    this.scope = x.scope;
    this.upstreamStatus = x.upstreamStatus;
    this.retryAfterSeconds = x.retryAfterSeconds;
    this.resetAt = x.resetAt;
    this.window = x.window;
    this.log = x.log;
    if (x.cause !== undefined) this.cause = x.cause;
  }

  /** → `{error: {message, type, code?, provider?, model?, scope?, upstream_status?, retry_after_seconds?, reset_at?, window?}}` (undefined fields left out) */
  toBody() {
    const error = { message: this.message, type: this.type };
    const add = (key, value) => { if (value !== undefined && value !== null && value !== '') error[key] = value; };
    add('code', this.code);
    add('provider', this.provider);
    add('model', this.model);
    add('scope', this.scope);
    add('upstream_status', this.upstreamStatus);
    add('retry_after_seconds', this.retryAfterSeconds);
    add('reset_at', this.resetAt);
    add('window', this.window);
    return { error };
  }

  /** → extra response headers: `{'Retry-After': '<seconds>'}` when retryAfterSeconds is set, else `{}` */
  toHeaders() {
    return Number.isFinite(this.retryAfterSeconds) ? { 'Retry-After': String(this.retryAfterSeconds) } : {};
  }
}

/** True for a ServiceError (also one made by another copy of this module). */
export function isServiceError(err) {
  return err instanceof ServiceError || (!!err && err.name === 'ServiceError' && typeof err.type === 'string' && typeof err.toBody === 'function');
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// "https://user:pw@api.example.com:8443/v1/x?key=…" → "api.example.com:8443"
function hostOf(url) {
  try { return new URL(url).host || ''; } catch (e) { return ''; }
}

/**
 * Cleans text that came from a provider (or an exception) before it's logged
 * or shown: removes the given secrets, `Bearer …`, `emis-…` and `sk-…` tokens,
 * replaces URLs with their host (or `[url]`), turns control characters into
 * spaces and squeezes whitespace.
 *
 * @param {*} text                    anything (non-strings are String()-ed; null/undefined → '')
 * @param {string[]} [secrets]        exact strings to remove (keys); empty and very short ones are skipped
 * @param {number} [max]              cut the result to this many characters (with '…'); default: no limit
 * @returns {string}
 */
export function redact(text, secrets, max) {
  let s = String(text === undefined || text === null ? '' : text);
  for (const secret of secrets || []) {
    if (typeof secret === 'string' && secret.length >= 4) s = s.split(secret).join('[redacted]');
  }
  s = s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:emis|sk)-[A-Za-z0-9._~+/=-]{4,}/gi, '[redacted key]')
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, url => hostOf(url) || '[url]')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return max ? clip(s, max) : s;
}

// The provider's own explanation, fit to be quoted: no generic "Provider request
// failed with HTTP n" (that's said better by the message itself), no HTML.
function providerDetail(reason, secrets) {
  let text = String(reason && reason.message || '');
  if (/^Provider request failed with HTTP \d+$/i.test(text)) return '';
  text = text.replace(/^Provider request failed with HTTP \d+:\s*/i, '');
  if (/^\s*</.test(text)) return '';
  text = text.replace(/<[^<>]{0,200}>/g, ' ');
  return redact(text, secrets, MAX_DETAIL);
}

const quoted = detail => (detail ? ' ("' + detail + '")' : '');

// "in 45 seconds" / "in 3 minutes" / "in about 2 hours" / "in about 3 days"
export function describeWait(seconds) {
  const plural = (n, unit) => n + ' ' + unit + (n === 1 ? '' : 's');
  if (seconds < 90) return 'in ' + plural(Math.max(1, Math.round(seconds)), 'second');
  if (seconds < 90 * 60) return 'in ' + plural(Math.round(seconds / 60), 'minute');
  if (seconds < 36 * 3600) return 'in about ' + plural(Math.round(seconds / 3600), 'hour');
  return 'in about ' + plural(Math.round(seconds / 86400), 'day');
}

// Words the AI services use when the model asked for doesn't exist
const MODEL_MISSING = /model[^.]{0,80}(not\s+found|does\s*n[o']?t\s+exist|unknown|is\s+not\s+available|no\s+such)|(unknown|invalid|no\s+such)\s+model/i;

const NETWORK_CODE = /^(E[A-Z0-9_]+|UND_ERR_[A-Z_]+|ERR_[A-Z_]+)$/;

function networkMessage(code, who, host) {
  const at = host ? ' (' + host + ')' : '';
  if (/^(ENOTFOUND|EAI_AGAIN)$/.test(code)) return 'Couldn\'t find ' + who + at + ': the address lookup failed. Check this server\'s internet connection and DNS.';
  if (code === 'ECONNREFUSED') return who + at + ' refused the connection. Check the provider\'s address (base URL) and proxy settings.';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'Couldn\'t make a secure connection to ' + who + at + ' (certificate problem). If this network inspects HTTPS, its certificate must be trusted (NODE_EXTRA_CA_CERTS).';
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)) return 'The connection to ' + who + ' dropped before it finished answering. Try again.';
  if (/TIMEOUT|ETIMEDOUT/.test(code)) return 'Couldn\'t connect to ' + who + at + ' in time. Check this server\'s internet connection and try again.';
  return 'Couldn\'t reach ' + who + at + (code ? ' (' + code + ')' : '') + '. Check this server\'s internet connection; if it only reaches the internet through a proxy, set HTTPS_PROXY in .env and reload.';
}

// What a shim in http.mjs marked, from its header (a made-up 502) or from the
// error event it put into a stream → { code, upstreamStatus, host } | null
function shimMark(reason) {
  const headers = reason.http && reason.http.headers || {};
  if (headers[SHIM_HEADER]) {
    return { code: headers[SHIM_HEADER], upstreamStatus: Number(headers[SHIM_STATUS_HEADER]) || undefined, host: headers[SHIM_HOST_HEADER] || '' };
  }
  if (typeof reason.body === 'string' && reason.body.includes(SHIM_ERROR_TYPE)) {
    try {
      const e = JSON.parse(reason.body).error;
      if (e && e.type === SHIM_ERROR_TYPE) return { code: e.code, upstreamStatus: reason.http && reason.http.status, host: '' };
    } catch (err) { /* not ours */ }
  }
  return null;
}

// A hint for this type: the string, or hint[type], or hint.default
function hintFor(hint, type) {
  if (!hint) return '';
  const text = typeof hint === 'string' ? hint : (hint[type] !== undefined ? hint[type] : hint.default);
  return text ? ' ' + String(text).trim() : '';
}

function retryAfterOf(reason) {
  const ms = reason.retryAfterMs !== undefined ? reason.retryAfterMs : (reason.rateLimit && reason.rateLimit.retryAfterMs);
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : undefined;
}

// OpenCode Zen's typed account limits (its 429 body's error.type), which are budgets, not throttles
const ZEN_LIMITS = /^(FreeUsageLimitError|BudgetLimitError|GoUsageLimitError|CreditLimitExceeded)$/i;

/**
 * Which of OpenCode Zen's limits an error body names: 'free' (FreeUsageLimitError, the free
 * models' limit), 'model' (BudgetLimitError whose "coverage" is "models": a spend limit for the
 * model asked for, as OpenCode reads it), 'account' (any other: a budget for the whole account),
 * or null (not one of Zen's limits).
 */
export function zenLimitOf(body) {
  if (typeof body !== 'string' || !/LimitError|CreditLimit/i.test(body)) return null;
  let e;
  try { e = JSON.parse(body).error; } catch (err) { return null; }
  if (!e || typeof e !== 'object') return null;
  const type = [e.type, e.code].map(v => String(v || '')).find(v => ZEN_LIMITS.test(v));
  if (!type) return null;
  if (/^FreeUsageLimitError$/i.test(type)) return 'free';
  if (/^BudgetLimitError$/i.test(type) && /"coverage"\s*:\s*"models"/.test(body)) return 'model';
  return 'account';
}

// The numeric status an error event inside a stream carries (`{"error":{"code":503}}`)
function eventStatus(body) {
  if (typeof body !== 'string' || !body.startsWith('{')) return undefined;
  try {
    const e = JSON.parse(body).error;
    const n = e && Number(e.code !== undefined ? e.code : e.status);
    return Number.isInteger(n) && n >= 400 && n <= 599 ? n : undefined;
  } catch (err) { return undefined; }
}

/**
 * Turns anything a call through @opencode/ai threw into a ServiceError.
 *
 * Classification: the status from `reason.http.status` when it's ≥ 400 — HTML
 * 403 → blocked, other 403 → permission_error, 401 → authentication_error, 404
 * or a 400/422 saying the model doesn't exist → model_not_found, 413 /
 * payload-too-large → request_too_large, other 4xx → invalid_request (context
 * overflow: code 'context_length_exceeded'; content policy: code
 * 'content_filter'), 429 → rate_limited scope 'model' (callers upgrade it to
 * the provider scope or to quota_exceeded when they know better), 408/5xx →
 * upstream_error with upstreamStatus. A `QuotaExceeded` reason (402,
 * insufficient_quota, Zen's FreeUsageLimitError / BudgetLimitError /
 * GoUsageLimitError) → quota_exceeded scope 'provider' with resetAt (scope
 * 'model' for a BudgetLimitError whose "coverage" is "models": zenLimitOf()).
 * Without an HTTP error status: `Transport` code 'Timeout' (or a `Timeout`
 * reason) → timeout; other `Transport` → network with `code`;
 * `InvalidProviderOutput` / `UnknownProvider` (and answers the shims marked) →
 * malformed_response; mid-stream `ProviderInternal` → upstream_error;
 * `RateLimit` → rate_limited; `Authentication` → authentication_error;
 * `InvalidRequest` → invalid_request; `UnsupportedOperation` →
 * unsupported_feature; `NoRoute` → model_not_found. An AbortError (or an
 * aborted `ctx.signal`) → cancelled 499 (a TimeoutError from
 * AbortSignal.timeout() → timeout 504); a ServiceError is returned as it is
 * (provider/model filled in); `ProviderConfiguration` → not_configured;
 * anything else → internal_error (generic message, details in `log`).
 * retryAfterSeconds = ceil(retryAfterMs / 1000) whenever the provider said.
 *
 * @param {*} err                         what was thrown
 * @param {object} [ctx]
 * @param {string} [ctx.provider]         provider id ('opencode', 'emis'); copied to the error
 * @param {string} [ctx.providerName]     display name used in messages ('OpenCode Zen'); default: the id
 * @param {string} [ctx.model]            full model id ('opencode/big-pickle'); copied and named in messages
 * @param {string|object} [ctx.hint]      a sentence appended to the message (which setting to check);
 *                                        or {<type>: sentence, default: sentence} per error type
 * @param {string[]} [ctx.secrets]        keys to redact from the provider's text
 * @param {AbortSignal} [ctx.signal]      the request's signal: aborted → cancelled
 * @returns {ServiceError}               never throws
 */
export function fromAIError(err, ctx) {
  ctx = ctx || {};
  const secrets = ctx.secrets || [];
  const who = ctx.providerName || ctx.provider || 'The AI provider';
  const whose = /s$/.test(who) ? who + '\'' : who + '\'s';
  const model = ctx.model;
  const named = model ? ' "' + model + '"' : '';
  const base = { provider: ctx.provider, model };
  const make = (type, message, extra) => {
    const hinted = message + hintFor(ctx.hint, type);
    return new ServiceError(undefined, type, hinted, Object.assign({}, base, extra));
  };

  if (isServiceError(err)) {
    if (err.provider === undefined) err.provider = ctx.provider;
    if (err.model === undefined) err.model = model;
    return err;
  }
  const reasonName = ctx.signal && ctx.signal.aborted && ctx.signal.reason ? ctx.signal.reason.name : undefined;
  if ((err && err.name === 'TimeoutError') || reasonName === 'TimeoutError') {          // an AbortSignal.timeout() that fired
    return make('timeout', who + ' didn\'t answer in time. Try again; if this keeps happening, raise AI_TIMEOUT_MS in .env.', { code: 'Timeout', log: 'timeout (signal)' });
  }
  if ((err && err.name === 'AbortError') || (ctx.signal && ctx.signal.aborted)) {
    return make('cancelled', 'The request was cancelled before ' + who + ' finished answering.', { log: 'cancelled' });
  }
  if (err && err._tag === 'ProviderConfiguration') {
    return make('not_configured', who + ' isn\'t set up correctly: ' + redact(err.message, secrets, MAX_DETAIL) + '.', { log: 'provider configuration: ' + redact(err.message, secrets, 300) });
  }

  const reason = err && err._tag === 'AI.Error' && err.reason ? err.reason : null;
  if (!reason) {
    const code = err && typeof err.code === 'string' && NETWORK_CODE.test(err.code) ? err.code : '';
    if (code) return make('network', networkMessage(code, who, ''), { code, log: 'network ' + code + ': ' + redact(err.message, secrets, 300) });
    return make('internal_error', 'MetaCode\'s OpenCode service ran into an unexpected problem' + (ctx.provider ? ' with ' + who : '') + '. The details are in the service\'s log.',
      { log: redact(err && (err.stack || err.message) || String(err), secrets, 2000) });
  }

  const tag = reason._tag;
  const http = reason.http;
  const headers = http && http.headers || {};
  const status = http && http.status >= 400 ? http.status : undefined;
  const detail = providerDetail(reason, secrets);
  const retryAfterSeconds = retryAfterOf(reason);
  const host = hostOf(http && http.url || reason.url || '');
  const log = tag + (http ? ' HTTP ' + http.status : '') + (reason.code ? ' ' + reason.code : '') + (reason.classification ? ' ' + reason.classification : '') +
    ': ' + redact(reason.message, secrets, 300);
  const extra = more => Object.assign({ log }, retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}, more);
  const isHtml = /^\s*</.test(reason.body || '') || /html/i.test(String(headers['content-type'] || ''));

  // Answers a shim made up: a web page or a redirect instead of the API, nothing, or something unreadable
  const mark = shimMark(reason);
  if (mark) {
    const up = mark.upstreamStatus;
    const at = mark.host || host;
    let message;
    if (mark.code === 'web_page') message = 'A web page answered' + (up ? ' (HTTP ' + up + ')' : '') + ' instead of ' + whose + ' API' + (at ? ' at ' + at : '') + '. Check the provider\'s address (base URL): it must be the API address, not the website.';
    else if (mark.code === 'redirect') message = who + ' answered with a redirect' + (up ? ' (HTTP ' + up + ')' : '') + (at ? ' to ' + at : '') + ' instead of an answer. Check the provider\'s address (base URL).';
    else if (mark.code === 'empty_reply') message = who + ' sent an empty answer' + named.replace(/^ /, ' for ') + '. Try again in a moment.';
    else if (mark.code === 'incomplete') message = who + ' sent an answer MetaCode couldn\'t read' + named.replace(/^ /, ' for ') + ' (the answer ended before it was complete).';
    else message = who + ' sent an answer MetaCode couldn\'t read' + named.replace(/^ /, ' for ') + '.';
    return make('malformed_response', message, extra({ code: mark.code, upstreamStatus: up }));
  }

  const zen = status === 429 || !status ? zenLimitOf(reason.body) : null;
  if (tag === 'QuotaExceeded' || status === 402 || zen) {
    const resetAt = retryAfterSeconds !== undefined ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : undefined;
    return make('quota_exceeded', whose.replace(/^./, c => c.toUpperCase()) + ' usage limit is used up' + quoted(detail) + '.' +
      (retryAfterSeconds !== undefined ? ' It resets ' + describeWait(retryAfterSeconds) + '.' : ' Try again later.'),
    extra({ scope: zen === 'model' ? 'model' : 'provider', upstreamStatus: status, resetAt }));
  }

  if (status) {
    if (status === 401) {
      return make('authentication_error', who + ' didn\'t accept the API key' + quoted(detail) + '.', extra({ upstreamStatus: status }));
    }
    if (status === 403 && isHtml) {
      return make('blocked', 'A web page answered (HTTP 403) instead of ' + whose + ' API' + (host ? ' at ' + host : '') + '. A proxy or firewall on this network may be blocking it, or the provider\'s address (base URL) is the website instead of the API.',
        extra({ code: 'web_page', upstreamStatus: status }));
    }
    if (status === 403) {
      return make('permission_error', who + ' refused this request' + quoted(detail) + (model ? ' for the model' + named : '') + '. The key may not be allowed to use this model: pick another one.', extra({ upstreamStatus: status }));
    }
    if (status === 404 || ((status === 400 || status === 422) && MODEL_MISSING.test(detail))) {
      return make('model_not_found', who + ' doesn\'t offer the model' + (named || ' asked for') + quoted(detail) + '. Pick another model.', extra({ upstreamStatus: status }));
    }
    if (status === 413 || reason.classification === 'payload-too-large') {
      return make('request_too_large', 'The request was too large for ' + who + ' (HTTP ' + status + '). Try a shorter text or a smaller sample.', extra({ upstreamStatus: status }));
    }
    if (status === 429) {
      return make('rate_limited', who + ' is rate-limiting ' + (model ? 'the model' + named : 'requests') + ' right now' + quoted(detail) + '.' +
        (retryAfterSeconds !== undefined ? ' It can be used again ' + describeWait(retryAfterSeconds) + '.' : ' Try again in a moment.'),
      extra({ scope: 'model', upstreamStatus: status }));
    }
    if (status === 408 || status >= 500) {
      return make('upstream_error', who + ' had a server problem (HTTP ' + status + ')' + quoted(detail) + '. Try again in a moment.', extra({ upstreamStatus: status }));
    }
    return invalidRequest(status);
  }

  function invalidRequest(upstreamStatus) {
    if (reason.classification === 'context-overflow') {
      return make('invalid_request', 'The text is too long for the model' + (named || '') + ' at ' + who + quoted(detail) + '. Try a shorter text or a smaller sample.',
        extra({ code: 'context_length_exceeded', upstreamStatus }));
    }
    if (tag === 'ContentPolicy') {
      return make('invalid_request', who + ' refused the content' + quoted(detail) + '.', extra({ code: 'content_filter', upstreamStatus }));
    }
    return make('invalid_request', who + ' couldn\'t process the request' + (detail ? ': "' + detail + '"' : upstreamStatus ? ' (HTTP ' + upstreamStatus + ')' : '') + '.', extra({ upstreamStatus }));
  }

  // No HTTP error status: failed before an answer, or inside a streamed answer
  switch (tag) {
    case 'Timeout':
      return make('timeout', who + ' didn\'t answer in time. Try again; if this keeps happening, raise AI_TIMEOUT_MS in .env.', extra({ code: 'Timeout' }));
    case 'Transport': {
      const code = reason.code || '';
      if (code === 'Timeout') {
        const what = /headers/i.test(reason.message) ? who + ' didn\'t start answering in time.'
          : /complete/i.test(reason.message) ? whose.replace(/^./, c => c.toUpperCase()) + ' answer took too long.' : whose.replace(/^./, c => c.toUpperCase()) + ' answer stalled (no data for too long).';
        return make('timeout', what + ' Try again; if this keeps happening, raise AI_TIMEOUT_MS in .env.', extra({ code: 'Timeout' }));
      }
      return make('network', networkMessage(code, who, host), extra({ code: code || undefined }));
    }
    case 'InvalidProviderOutput':
    case 'UnknownProvider': {
      const why = reason.classification === 'incomplete-stream' ? 'the answer ended before it was complete'
        : /finish_reason/i.test(reason.message) ? 'it reported an error instead of finishing'
          : /stream event/i.test(reason.message) ? 'part of it wasn\'t valid JSON' : detail;
      return make('malformed_response', who + ' sent an answer MetaCode couldn\'t read' + (why ? ' (' + why + ')' : '') + '.', extra({ upstreamStatus: http && http.status }));
    }
    case 'ProviderInternal':
      return make('upstream_error', who + ' had a server problem' + quoted(detail) + '. Try again in a moment.', extra({ upstreamStatus: eventStatus(reason.body) }));
    case 'RateLimit':
      return make('rate_limited', who + ' is rate-limiting ' + (model ? 'the model' + named : 'requests') + ' right now' + quoted(detail) + '.' +
        (retryAfterSeconds !== undefined ? ' It can be used again ' + describeWait(retryAfterSeconds) + '.' : ' Try again in a moment.'), extra({ scope: 'model' }));
    case 'Authentication':
      return make('authentication_error', http ? who + ' didn\'t accept the API key' + quoted(detail) + '.' : who + ' needs an API key for this request, and none is set.', extra({}));
    case 'UnsupportedOperation':
      return make('unsupported_feature', who + ' can\'t do this' + quoted(detail) + '.', extra({}));
    case 'NoRoute':
      return make('model_not_found', 'MetaCode\'s OpenCode service has no way to reach the model' + (named || '') + ' at ' + who + '.', extra({}));
    default:
      return invalidRequest(undefined);
  }
}
