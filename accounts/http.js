// Outbound requests to Supabase and Stripe. Honors HTTPS_PROXY / NO_PROXY like
// the rest of MetaCode's server-side requests, with a timeout on every call.
const undici = require('undici');

let proxyAgent = null, proxyKey = null;
function dispatcherFor(url) {
  const host = new URL(url).hostname;
  if (/^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(host)) return undefined;
  const key = [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy, process.env.NO_PROXY, process.env.no_proxy].join('|');
  if (!/\S/.test(key.replace(/\|/g, ''))) return undefined;
  if (proxyKey !== key) { proxyAgent = new undici.EnvHttpProxyAgent(); proxyKey = key; }
  return proxyAgent;
}

// → { status, ok, json, text, headers } — never throws for HTTP errors; throws { network: true } on failure to connect.
async function request(url, opts) {
  opts = opts || {};
  let res;
  try {
    res = await undici.fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      dispatcher: dispatcherFor(url),
      signal: AbortSignal.timeout(opts.timeoutMs || 10000)
    });
  } catch (err) {
    const e = new Error('Couldn\'t reach ' + new URL(url).host + (err && err.name === 'TimeoutError' ? ' (timed out)' : ''));
    e.network = true;
    throw e;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

module.exports = { request, dispatcherFor };
