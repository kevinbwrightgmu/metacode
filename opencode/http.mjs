// ── HTTP for the service's providers ──────────────────────────────────────────
// Every provider in MetaCode's OpenCode service sends its requests through an
// @opencode/ai `AI` instance made here, so they all go out the same way:
//
//   createAI({middleware, proxy})   undici fetch (direct, the env proxy honouring NO_PROXY, or a
//                                   given proxy URL), no redirects followed, no trace headers
//                                   (traceparent/b3), MetaCode's User-Agent, and the middleware
//   dispatcherFor(proxy, env)       the same undici dispatcher, for requests made without @opencode/ai
//                                   (the catalog, the gateway's model list)
//   captureMiddleware()             read an upstream's status and headers on success (quota headers):
//                                   tag a request, take what came back
//   substituteMiddleware(marker, h) answer marked requests some other way (EMIS's Python worker)
//   chatShims(options)              make odd chat upstreams readable: plain JSON on a streamed call
//                                   → SSE; a web page on 200 → a 502 saying so; an unknown
//                                   finish_reason → stop; an image-only answer → "[image omitted]";
//                                   a stream cut off before [DONE] or a finish_reason → an error
//
// Middleware is @opencode/ai's RequestExecutor middleware: (request, next) →
// Effect of a response. It sees the raw response before @opencode/ai turns
// 4xx/5xx into errors, so a substituted 401 or 429 is classified like a real
// one. Nothing here retries: one call is one upstream request (MetaCode
// retries; the spec's §1).
//
// Answers the shims make up carry SHIM_HEADER (or, inside a stream, an error
// event of type SHIM_ERROR_TYPE) so errors.mjs can say what really happened.

import fs from 'node:fs';
import { Effect, Layer, Stream } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { AI } from '@opencode/ai/promise';
import { RequestExecutor } from '@opencode/ai/route/executor';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { ServiceError, SHIM_HEADER, SHIM_STATUS_HEADER, SHIM_HOST_HEADER, SHIM_ERROR_TYPE } from './errors.mjs';

/** The installed @opencode/ai version (from its package.json), e.g. '2.1.4'. */
export const OPENCODE_AI_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.resolve('@opencode/ai')), 'utf8')).version || 'unknown'; }
  catch (e) { return 'unknown'; }
})();

/** User-Agent of a custom OpenCode build (channel and name "metacode"): opencode/metacode/<version>/metacode */
export const USER_AGENT = 'opencode/metacode/' + OPENCODE_AI_VERSION + '/metacode';

/** Header that tags a request for captureMiddleware (never sent upstream). */
export const CAPTURE_HEADER = 'x-oc-trace';

// The undici agents' own limits are only a safety net: @opencode/ai enforces the
// real ones per request (header wait, chunk silence, whole exchange; ≤ 600 s).
const AGENT_OPTIONS = { headersTimeout: 610000, bodyTimeout: 610000 };

// undici calls EnvHttpProxyAgent experimental and says so on stderr the first
// time; the service's log doesn't need that line
function quietly(make) {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, options, ...rest) {
    const code = options && typeof options === 'object' ? options.code : rest[0];
    if (code === 'UNDICI-EHPA') return undefined;
    return emit.call(process, warning, options, ...rest);
  };
  try { return make(); } finally { process.emitWarning = emit; }
}

/**
 * The undici dispatcher for one provider's requests (also the catalog's and
 * the gateway's raw model-list requests, so everything goes out the same way).
 *
 * @param {undefined|null|string} proxy  undefined / '' / 'off' = direct; 'env' = HTTPS_PROXY / HTTP_PROXY with
 *   NO_PROXY from `env` (undici EnvHttpProxyAgent); else a proxy URL (undici ProxyAgent)
 * @param {object} [env]                 where 'env' reads the proxy variables (default process.env)
 * @returns {object} an undici Agent, EnvHttpProxyAgent or ProxyAgent; the caller closes it
 * @throws {ServiceError} 503 not_configured when `proxy` is neither 'env' nor an http(s) URL
 */
export function dispatcherFor(proxy, env) {
  if (proxy === 'env') {
    const e = env || process.env;
    const pick = (lower, upper) => (e[lower] !== undefined ? e[lower] : e[upper] !== undefined ? e[upper] : '');
    // '' (not undefined) so undici doesn't fall back to process.env when `env` is given
    return quietly(() => new EnvHttpProxyAgent(Object.assign({
      httpProxy: pick('http_proxy', 'HTTP_PROXY'),
      httpsProxy: pick('https_proxy', 'HTTPS_PROXY'),
      noProxy: pick('no_proxy', 'NO_PROXY')
    }, AGENT_OPTIONS)));
  }
  if (proxy && !/^(off|none|direct|false|0|no|disabled)$/i.test(String(proxy).trim())) {
    let url;
    try { url = new URL(proxy); } catch (e) { url = null; }
    if (!url || !/^https?:$/.test(url.protocol)) throw new ServiceError(503, 'not_configured', 'The proxy setting isn\'t an http(s) URL (for example http://proxy.example:3128).');
    return new ProxyAgent(Object.assign({ uri: url.href }, AGENT_OPTIONS));
  }
  return new Agent(AGENT_OPTIONS);
}

const jsonError = (code, message, status, headers) => new Response(JSON.stringify({ error: { message, type: SHIM_ERROR_TYPE, code } }), {
  status: 502,
  headers: Object.assign({ 'content-type': 'application/json', [SHIM_HEADER]: code, [SHIM_STATUS_HEADER]: String(status) }, headers)
});

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return ''; }
}

/**
 * Makes an @opencode/ai `AI` instance (from `@opencode/ai/promise`) for one
 * provider: `ai.llm.stream(input, {signal})`, `ai.llm.generate(…)`, `ai.dispose()`.
 *
 * Requests go through undici's fetch with `redirect: 'manual'` (a 3xx comes
 * back as a 502 marked as a redirect, so it's never mistaken for an empty
 * answer), Effect's trace propagation is off (no traceparent / b3 headers), and
 * a request without a User-Agent gets `userAgent`.
 *
 * @param {object} [opts]
 * @param {Function|Function[]} [opts.middleware]  RequestExecutor middleware `(request, next) => Effect<response>`;
 *   in a list the first is outermost: it sees the request first and the response last
 *   (e.g. `[capture.middleware, chatShims(), substitute]`)
 * @param {undefined|null|string} [opts.proxy]     undefined / '' / 'off' = direct; 'env' = HTTPS_PROXY / HTTP_PROXY
 *   with NO_PROXY (undici EnvHttpProxyAgent); else a proxy URL (undici ProxyAgent)
 * @param {object} [opts.env]                      where 'env' reads the proxy variables (default process.env)
 * @param {string} [opts.userAgent]                default USER_AGENT
 * @param {Function} [opts.fetch]                  a fetch to use instead of undici's (tests); gets `dispatcher` in init
 * @returns {object} the AI instance; its dispose() also closes the connections
 * @throws {ServiceError} 503 not_configured when `proxy` is neither 'env' nor an http(s) URL
 */
export function createAI(opts) {
  const { middleware, proxy, env, userAgent = USER_AGENT, fetch: fetchImpl = undiciFetch } = opts || {};
  const dispatcher = dispatcherFor(proxy, env);
  const send = async (input, init) => {
    const headers = Object.assign({}, init && init.headers);
    if (userAgent && !Object.keys(headers).some(k => k.toLowerCase() === 'user-agent')) headers['user-agent'] = userAgent;
    const res = await fetchImpl(input, Object.assign({}, init, { headers, dispatcher, redirect: 'manual' }));
    if (res.status >= 300 && res.status < 400) {
      let host = '';
      try { host = new URL(res.headers.get('location') || '', String(input && input.url || input)).host; } catch (e) { /* no usable Location */ }
      try { await res.body?.cancel(); } catch (e) { /* already closed */ }
      return jsonError('redirect', 'The provider answered with a redirect (HTTP ' + res.status + ') instead of an answer.', res.status,
        host ? { [SHIM_HOST_HEADER]: host } : {});
    }
    return res;
  };
  let layer = RequestExecutor.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, send)),
    Layer.provide(Layer.succeed(HttpClient.TracerPropagationEnabled, false))
  );
  for (const fn of [].concat(middleware || [])) layer = RequestExecutor.middleware(fn, layer);
  const ai = AI.make({ layer });
  const dispose = ai.dispose;
  ai.dispose = async () => {
    try { await dispose(); } finally { await dispatcher.close().catch(() => {}); }
  };
  return ai;
}

/**
 * Reads the upstream's status and headers of tagged requests (the quota headers
 * on a successful answer, which @opencode/ai's events don't carry). The tag
 * header is removed before the request goes on, so the upstream never sees it.
 * What was captured is kept until taken (at most the last 1000).
 *
 *   const capture = captureMiddleware();
 *   const ai = createAI({ middleware: capture.middleware });
 *   ai.llm.stream({ ...input, http: { headers: { ...capture.tag(attemptId) } } });
 *   // by the first event: capture.take(attemptId) → { status: 200, headers: { 'x-ratelimit-…': … } }
 *
 * @returns {{ middleware: Function, tag: (requestId: string) => object, take: (requestId: string) => ({status: number, headers: object}|undefined) }}
 *   headers are lower-case; take() forgets the entry
 */
export function captureMiddleware() {
  const seen = new Map();
  const middleware = (request, next) => {
    const tag = request.headers[CAPTURE_HEADER];
    if (!tag) return next(request);
    return Effect.map(next(HttpClientRequest.removeHeader(request, CAPTURE_HEADER)), response => {
      seen.set(tag, { status: response.status, headers: Object.assign({}, response.headers) });
      if (seen.size > 1000) seen.delete(seen.keys().next().value);
      return response;
    });
  };
  return {
    middleware,
    tag: requestId => ({ [CAPTURE_HEADER]: String(requestId) }),
    take: requestId => {
      const key = String(requestId);
      const value = seen.get(key);
      seen.delete(key);
      return value;
    }
  };
}

function bodyText(request) {
  const b = request.body;
  if (!b || b._tag === 'Empty') return undefined;
  if (b._tag === 'Uint8Array') return new TextDecoder().decode(b.body);
  if (b._tag === 'Raw') return typeof b.body === 'string' ? b.body : b.body instanceof Uint8Array ? new TextDecoder().decode(b.body) : undefined;
  return undefined;
}

/**
 * Answers requests that carry the header `marker` with `handler` instead of the
 * network (EMIS's Python worker). The marker is removed first; requests
 * without it go on unchanged.
 *
 * handler({method, url, headers, body, json, marker, signal}) → a web `Response`
 * (any status; its body may be a ReadableStream, which then arrives as it's
 * written) or `null` to send the request over the network after all.
 *   headers: the request's headers (lower-case, marker removed), e.g. authorization
 *   body: the JSON body as text; json: the same parsed (or undefined)
 *   marker: the marker header's value; signal: aborts when the call is cancelled
 * A handler that throws fails the call as a network failure (`Transport`, with
 * the error's `code` when it has one).
 *
 * @param {string} marker
 * @param {Function} handler
 * @returns {Function} RequestExecutor middleware
 */
export function substituteMiddleware(marker, handler) {
  const name = String(marker).toLowerCase();
  return (request, next) => {
    const value = request.headers[name];
    if (value === undefined) return next(request);
    const forwarded = HttpClientRequest.removeHeader(request, name);
    return Effect.flatMap(Effect.tryPromise({
      try: signal => {
        const body = bodyText(forwarded);
        let json;
        try { json = body === undefined ? undefined : JSON.parse(body); } catch (e) { json = undefined; }
        return Promise.resolve(handler({ method: forwarded.method, url: forwarded.url, headers: Object.assign({}, forwarded.headers), body, json, marker: value, signal }));
      },
      catch: e => (e instanceof Error ? e : new Error(String(e)))
    }), res => (res ? Effect.succeed(HttpClientResponse.fromWeb(forwarded, res)) : next(forwarded)));
  };
}

// ── Chat shims ────────────────────────────────────────────────────────────────

// finish_reason values @opencode/ai 2.1.4's chat parser knows; anything else
// fails the whole answer ("Provider finish_reason: eos"), so it's rewritten.
const KNOWN_FINISH = new Set(['stop', 'end', 'length', 'content_filter', 'function_call', 'tool_calls', 'error', 'network_error']);
const FINISH_ALIASES = { eos: 'stop', eos_token: 'stop', end_turn: 'stop', stop_sequence: 'stop', complete: 'stop', completed: 'stop', max_tokens: 'length', max_output_tokens: 'length', model_length: 'length', tool_use: 'tool_calls', tool_call: 'tool_calls' };
const fixFinish = reason => {
  const r = String(reason).toLowerCase();
  return KNOWN_FINISH.has(r) ? r : (FINISH_ALIASES[r] || 'stop');
};

const MEDIA_PART = /^(input_|output_)?(image|video|audio|file)(_url)?$/;
// Content as text: parts joined, media parts marked (MetaCode's textContent)
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (typeof p === 'string' ? p : !p ? '' : typeof p.text === 'string' ? p.text
    : MEDIA_PART.test(String(p.type || '')) ? '[' + String(p.type).replace(/^(input|output)_/, '').replace(/_url$/, '') + ' omitted]' : '')).join('');
}

const shimEvent = (code, message) => 'data: ' + JSON.stringify({ error: { message, type: SHIM_ERROR_TYPE, code } }) + '\n\n';
const MAX_BUFFERED = 50 * 1024 * 1024;
const SSE_START = /^(?:(?:data|event|id|retry)[ \t]*:|:)/;     // an SSE field or comment

// One chat completion (plain JSON) as the SSE stream @opencode/ai expects
function completionToSse(c, opts) {
  const choice = c.choices[0] || {};
  const msg = choice.message || choice.delta || (typeof choice.text === 'string' ? { content: choice.text } : {});
  let content = textContent(msg.content);
  if (!content && opts.images && Array.isArray(msg.images) && msg.images.length) content = opts.imageText;
  const delta = { role: 'assistant', content };
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : typeof msg.reasoning === 'string' ? msg.reasoning : '';
  if (reasoning) delta.reasoning_content = reasoning;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    delta.tool_calls = msg.tool_calls.map((t, index) => Object.assign({ index }, t, {
      type: 'function',
      function: Object.assign({}, t.function, { arguments: typeof (t.function || {}).arguments === 'string' ? t.function.arguments : JSON.stringify((t.function || {}).arguments || {}) })
    }));
  }
  const head = { id: c.id || 'chatcmpl-shim', object: 'chat.completion.chunk', created: c.created || Math.floor(Date.now() / 1000), model: c.model || '' };
  const finish = choice.finish_reason ? (opts.finishReason ? fixFinish(choice.finish_reason) : choice.finish_reason) : 'stop';
  return [
    Object.assign({}, head, { choices: [{ index: 0, delta }] }),
    Object.assign({}, head, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }, c.usage ? { usage: c.usage } : {})
  ].map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n';
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Usage as a chat completion reports it (the Responses API and Anthropic say input/output tokens)
function chatUsage(u) {
  if (!isObject(u)) return undefined;
  if (Number.isFinite(u.prompt_tokens) || Number.isFinite(u.completion_tokens)) return u;
  if (!Number.isFinite(u.input_tokens) && !Number.isFinite(u.output_tokens)) return undefined;
  const prompt = u.input_tokens || 0;
  const completion = u.output_tokens || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number.isFinite(u.total_tokens) ? u.total_tokens : prompt + completion };
}

// A whole JSON answer as a chat completion, or null. Besides the chat format
// itself, the shapes MetaCode's AI client read before the service existed: any
// of these inside {data: …}, the Responses API (output_text, output[].content[].text),
// Anthropic Messages (content[].text), Ollama ({message: {content}}) and a plain
// {response | text | content | output | answer | result | completion: "…"}.
function asCompletion(json) {
  if (!isObject(json)) return null;
  if (isObject(json.data) && !json.choices) json = json.data;
  if (Array.isArray(json.choices) && json.choices.length) return json;
  const wrap = (content, finish) => ({ id: json.id, model: json.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish || 'stop' }], usage: chatUsage(json.usage) });
  const cut = json.status === 'incomplete' && /max_output_tokens|max_tokens/.test(String(json.incomplete_details && json.incomplete_details.reason)) ? 'length' : null;
  if (typeof json.output_text === 'string') return wrap(json.output_text, cut);
  if (Array.isArray(json.output) && json.output.length) {
    const text = json.output.map(o => (o && Array.isArray(o.content) ? o.content.map(c => (c && typeof (c.text || c.output_text) === 'string' ? c.text || c.output_text : '')).join('')
      : o && typeof o.text === 'string' ? o.text : '')).join('');
    return wrap(text, cut);
  }
  if (Array.isArray(json.content) && json.content.some(c => c && typeof c.text === 'string')) return wrap(textContent(json.content), json.stop_reason === 'max_tokens' ? 'length' : null);
  if (isObject(json.message) && json.message.content !== undefined) return wrap(textContent(json.message.content));
  for (const k of ['response', 'text', 'content', 'output', 'answer', 'result', 'completion']) if (typeof json[k] === 'string') return wrap(json[k]);
  return null;
}

// A streamed event in another API's shape (MetaCode's AI client read these before) → a chat
// chunk, or null (an event chat parsers have no use for): the Responses API's text deltas and its
// final response, Anthropic Messages' text deltas and stop reason
function eventAsChunk(j, sawText) {
  const type = String(j.type || '');
  const piece = typeof j.delta === 'string' && /output_text|text\.delta|content/.test(type) && !/reason|summary/.test(type) ? j.delta
    : isObject(j.delta) && typeof j.delta.text === 'string' ? j.delta.text : null;
  if (piece !== null) return { choices: [{ index: 0, delta: { content: piece } }] };
  if (type === 'response.completed' && isObject(j.response)) {
    const done = asCompletion(j.response);
    const text = !sawText && done ? textContent(done.choices[0].message.content) : '';
    const usage = chatUsage(j.response.usage);
    return Object.assign({ choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: 'stop' }] }, usage ? { usage } : {});
  }
  if (type === 'message_delta' && isObject(j.delta) && j.delta.stop_reason) {
    return { choices: [{ index: 0, delta: {}, finish_reason: j.delta.stop_reason === 'max_tokens' ? 'length' : 'stop' }] };
  }
  return null;
}

// A whole JSON answer (to a streamed call) → SSE text
function jsonToSse(text, opts) {
  let json;
  try { json = JSON.parse(text); } catch (e) { json = undefined; }
  const completion = json && typeof json === 'object' && !json.error ? asCompletion(json) : null;
  if (completion) return completionToSse(completion, opts);
  if (json && typeof json === 'object' && json.error) {
    // an error on 200: as a stream error event, which @opencode/ai classifies like any other
    return 'data: ' + JSON.stringify({ error: typeof json.error === 'string' ? { message: json.error } : json.error }) + '\n\n';
  }
  if (/^\s*</.test(text)) return shimEvent('web_page', 'A web page answered instead of the API.');
  return shimEvent('unreadable', 'The provider answered with something that isn\'t a chat completion.');
}

// The streamed answer of a chat upstream, fixed on the fly (never buffered,
// except when it turns out not to be SSE at all)
function chatStream(opts) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let mode = 'start';                 // start (nothing yet) | sse | json (buffering) | drop (already answered)
  let buffer = '';
  let sawData = false;                // a JSON data line came (not just [DONE])
  let ended = false;                  // [DONE], a finish_reason or an error came: the answer has an end
  let sawText = false;
  let imageMarked = false;

  const fixChunk = j => {
    for (const c of Array.isArray(j.choices) ? j.choices : []) {
      if (!c || typeof c !== 'object') continue;
      const d = c.delta && typeof c.delta === 'object' ? c.delta : null;
      if (d) {
        if (Array.isArray(d.content)) d.content = textContent(d.content);
        if (typeof d.content === 'string' && d.content) sawText = true;
        if (opts.images && !sawText && !imageMarked && Array.isArray(d.images) && d.images.length && !d.content) {
          d.content = opts.imageText;
          imageMarked = true;
        }
      }
      if (opts.finishReason && typeof c.finish_reason === 'string') c.finish_reason = fixFinish(c.finish_reason);
    }
    return j;
  };
  const fixLine = line => {
    const m = /^data:[ \t]?(.*?)(\r?)$/.exec(line);
    if (!m) return line;
    const payload = m[1].trim();
    if (payload === '[DONE]') { ended = true; return sawData ? line : shimEvent('empty_reply', 'The provider sent no answer.').trimEnd(); }
    if (!payload.startsWith('{')) return line;
    sawData = true;
    // (the Responses API's or Anthropic's events instead of chat chunks)
    const foreign = !/"choices"\s*:/.test(payload) && /"type"\s*:\s*"(?:response\.|content_block_|message_)/.test(payload);
    const needsFix = foreign || (opts.finishReason && /"finish_reason"\s*:\s*"/.test(payload)) || /"content"\s*:\s*\[/.test(payload) || (opts.images && /"images"\s*:/.test(payload));
    if (!needsFix) {
      if (!sawText && /"content"\s*:\s*"[^"]/.test(payload)) sawText = true;
      return line;
    }
    try {
      const j = JSON.parse(payload);
      if (foreign && isObject(j) && !j.error) {
        const c = eventAsChunk(j, sawText);
        if (!c) return ':';                                   // (a comment: the event carries nothing for a chat)
        if (c.choices[0].delta.content) sawText = true;
        return 'data: ' + JSON.stringify(c) + m[2];
      }
      return 'data: ' + JSON.stringify(fixChunk(j)) + m[2];
    } catch (e) { return line; }
  };
  // (checked on the fixed line, so the Responses API's and Anthropic's ends count too)
  const fixEnd = line => {
    const out = fixLine(line);
    if (/"finish_reason"\s*:\s*"[^"]/.test(out) || /^data:[ \t]?\{\s*"error"\s*:/.test(out)) ended = true;
    return out;
  };

  return new TransformStream({
    transform(chunk, ctl) {
      if (mode === 'drop') return;
      buffer += dec.decode(chunk, { stream: true });
      if (mode === 'start') {
        const s = buffer.replace(/^\uFEFF/, '').trimStart();
        if (!s) return;
        if (s[0] === '<') { mode = 'drop'; buffer = ''; ctl.enqueue(enc.encode(shimEvent('web_page', 'A web page answered instead of the API.'))); return; }
        if (s[0] === '{' || s[0] === '[') { mode = 'json'; buffer = s; }
        else if (SSE_START.test(s)) mode = 'sse';
        else if (s.length < 8 && /^[a-z]+$/i.test(s)) return;            // ("dat…": wait for the rest of the field name)
        else { mode = 'drop'; buffer = ''; ctl.enqueue(enc.encode(shimEvent('unreadable', 'The provider answered with something that isn\'t a chat completion.'))); return; }
      }
      if (mode === 'json') {
        if (buffer.length > MAX_BUFFERED) { mode = 'drop'; buffer = ''; ctl.enqueue(enc.encode(shimEvent('unreadable', 'The provider\'s answer was too large to read.'))); }
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (lines.length) ctl.enqueue(enc.encode(lines.map(fixEnd).join('\n') + '\n'));
    },
    flush(ctl) {
      buffer += dec.decode();
      if (mode === 'start') {
        const s = buffer.trim();
        ctl.enqueue(enc.encode(s ? shimEvent('unreadable', 'The provider answered with something that isn\'t a chat completion.') : shimEvent('empty_reply', 'The provider sent an empty answer.')));
      }
      else if (mode === 'json') ctl.enqueue(enc.encode(jsonToSse(buffer, opts)));
      else if (mode === 'sse') {
        if (buffer) ctl.enqueue(enc.encode(fixEnd(buffer) + '\n'));
        if (!sawData) ctl.enqueue(enc.encode('\n' + shimEvent('empty_reply', 'The provider sent no answer.')));
        // (the connection closed in the middle of the answer: not a finished answer, whatever came)
        else if (!ended) ctl.enqueue(enc.encode('\n' + shimEvent('incomplete', 'The provider\'s answer ended before it was complete.')));
      }
    }
  });
}

const responseHeaders = (headers, extra) => {
  const out = Object.assign({}, headers);
  for (const k of ['content-length', 'content-encoding', 'transfer-encoding']) delete out[k];
  return Object.assign(out, extra);
};

/**
 * Middleware that makes OpenAI-compatible chat upstreams readable by
 * @opencode/ai (it expects a clean SSE stream to POST …/chat/completions):
 *   - json: a plain chat.completion JSON (the upstream ignored stream:true, or the
 *     call asked for stream:false) → the equivalent SSE (text, reasoning, tool
 *     calls, finish_reason, usage); so are the other whole-answer shapes MetaCode
 *     read before (wrapped in {data}, Responses API, Anthropic, Ollama, plain
 *     {text}…: asCompletion); a JSON error on 200 → a stream error event; a stream of
 *     the Responses API's or Anthropic's events → chat chunks (eventAsChunk)
 *   - html: a web page on a 2xx (any URL, by content type) → a 502 marked
 *     'web_page' whose JSON message says a web page answered; a chat answer
 *     that starts with "<" whatever its content type, an empty answer and one
 *     that isn't SSE or JSON → an error event marked web_page / empty_reply /
 *     unreadable (fromAIError: malformed_response with that code); a stream that
 *     stops without [DONE] or a finish_reason → one marked incomplete
 *   - finishReason: a finish_reason 2.1.4 doesn't know (eos, end_turn, …) →
 *     its usual meaning, else stop (instead of failing the answer)
 *   - images: `message.images` / `delta.images` with no text → content
 *     `imageText`; content given as a list of parts → text
 * Streams stay streams: lines are fixed as they arrive.
 *
 * @param {object} [options]  {json = true, html = true, finishReason = true, images = true, imageText = '[image omitted]'}
 * @returns {Function} RequestExecutor middleware
 */
export function chatShims(options) {
  const opts = Object.assign({ json: true, html: true, finishReason: true, images: true, imageText: '[image omitted]' }, options);
  return (request, next) => Effect.gen(function* () {
    const response = yield* next(request);
    if (response.status < 200 || response.status >= 300) return response;
    const type = String(response.headers['content-type'] || '').toLowerCase();
    if (opts.html && /text\/html|application\/xhtml/.test(type)) {
      yield* Effect.ignore(response.text);
      return HttpClientResponse.fromWeb(request, jsonError('web_page', 'A web page answered (HTTP ' + response.status + ') instead of the API.', response.status, { [SHIM_HOST_HEADER]: hostOf(request.url) }));
    }
    if (!/\/chat\/completions(?:[?#]|$)/.test(request.url) || request.method !== 'POST') return response;
    if (!opts.json && /json/.test(type)) return response;
    const body = Stream.toReadableStream(response.stream).pipeThrough(chatStream(opts));
    return HttpClientResponse.fromWeb(request, new Response(body, { status: response.status, headers: responseHeaders(response.headers, { 'content-type': 'text/event-stream' }) }));
  });
}
