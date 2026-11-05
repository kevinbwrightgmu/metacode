// @ts-check
// ── Keep-alive for long AI answers ────────────────────────────────────────────
// A reverse proxy in front of MetaCode closes a response that sends nothing for
// a while: Cloudflare after about 100 s, nginx after its proxy_read_timeout (60 s
// unless set). The browser then reports net::ERR_INCOMPLETE_CHUNKED_ENCODING.
// While an AI answer is still being worked on — a batch whose first posts take
// a minute, a model that thinks before its first word — a few bytes that every
// reader skips (a blank NDJSON line, an SSE comment) keep the response open.
//
// AI_KEEPALIVE_SECONDS (default 15, 1–60): the longest a streamed AI response
// stays silent.

/** @param {NodeJS.ProcessEnv} [env] @returns {number} milliseconds */
function keepAliveMs(env) {
  const n = parseFloat(String((env || process.env).AI_KEEPALIVE_SECONDS || ''));
  return Number.isFinite(n) && n >= 1 ? Math.min(60, n) * 1000 : 15000;
}

/**
 * Writes `text` to `res` whenever nothing else was written for `everyMs`, until
 * the response ends. Call touch() after each write of your own.
 * @param {import('http').ServerResponse} res
 * @param {string} text   bytes the reader skips: '\n' for NDJSON, ': keep-alive\n\n' for SSE
 * @param {number} [everyMs]
 * @returns {{ touch: () => void, stop: () => void }}
 */
function keepAlive(res, text, everyMs) {
  const ms = everyMs || keepAliveMs();
  const tick = Math.max(250, Math.floor(ms / 3));
  let last = Date.now();
  // (written at the first check where the next one would come too late: the silence stays under `ms`)
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return stop();
    if (Date.now() - last < ms - tick) return;
    last = Date.now();
    res.write(text);
  }, tick);
  timer.unref();
  function stop() { clearInterval(timer); }
  res.once('close', stop);
  return { touch() { last = Date.now(); }, stop };
}

module.exports = { keepAlive, keepAliveMs };
