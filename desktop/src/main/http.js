// @ts-check
// ── Requests from the app's main process ──────────────────────────────────────
// Every request has a time limit and is tried once: callers decide whether a
// failure is worth another try (none retries more than once). Failures say
// what kind they are, so the app can tell "offline" from "the server said no".
'use strict';

class NetError extends Error {
  /** @param {'offline' | 'timeout' | 'aborted' | 'bad_response'} kind @param {string} message */
  constructor(kind, message) { super(message); this.kind = kind; }
}

/**
 * @param {{ fetch: (url: string, init?: any) => Promise<any>, userAgent?: string, timeoutMs?: number }} o
 */
function createHttp(o) {
  const defaultTimeout = o.timeoutMs || 20000;
  /**
   * @param {string} url
   * @param {{ method?: string, headers?: Record<string, string>, json?: any, body?: any, timeoutMs?: number, signal?: AbortSignal, raw?: boolean }} [opts]
   * @returns {Promise<{ status: number, ok: boolean, headers: any, json: any, text: string, response?: any }>}
   */
  async function request(url, opts = {}) {
    const ctl = new AbortController();
    const timeoutMs = opts.timeoutMs || defaultTimeout;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const onAbort = () => ctl.abort();
    if (opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener('abort', onAbort, { once: true }); }
    /** @type {Record<string, string>} */
    const headers = Object.assign({ Accept: 'application/json' }, o.userAgent ? { 'X-MetaCode-Client': o.userAgent } : {}, opts.headers || {});
    let body = opts.body;
    if (opts.json !== undefined) { body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    let res;
    try {
      res = await o.fetch(url, { method: opts.method || 'GET', headers, body, signal: ctl.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (timedOut) throw new NetError('timeout', 'The MetaCode server didn\'t answer within ' + Math.round(timeoutMs / 1000) + ' seconds.');
      if (opts.signal && opts.signal.aborted) throw new NetError('aborted', 'Stopped.');
      throw new NetError('offline', 'Couldn\'t reach the MetaCode server. Check your internet connection.');
    }
    if (opts.raw) { clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener('abort', onAbort); return { status: res.status, ok: res.ok, headers: res.headers, json: null, text: '', response: res }; }
    let text = '';
    try { text = await res.text(); }
    catch (e) {
      throw timedOut ? new NetError('timeout', 'The MetaCode server took too long to answer.') : new NetError('offline', 'The connection to the MetaCode server was interrupted.');
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
    return { status: res.status, ok: res.ok, headers: res.headers, json, text };
  }
  return { request };
}

/** The message in a server or Supabase error body @param {any} r @param {string} fallback */
function errorMessage(r, fallback) {
  const j = r && r.json;
  const m = j && ((j.error && typeof j.error === 'object' && j.error.message) || j.error_description || j.msg || j.message || (typeof j.error === 'string' && j.error));
  return typeof m === 'string' && m ? m.slice(0, 300) : fallback;
}

module.exports = { createHttp, NetError, errorMessage };
