// ── OpenAI Chat Completions ⇄ @opencode/ai ────────────────────────────────────
// MetaCode talks to its OpenCode service in the OpenAI Chat Completions format
// (what server.js's fromOpenAIRequest forwards). The providers inside the
// service talk @opencode/ai, which speaks each upstream's own protocol. This
// module is the translation, with no I/O of its own:
//
//   validateChatBody(body)              the request body, checked → a clean copy (or ServiceError 400)
//   toLLMInput(body, {protocol, model}) → the @opencode/ai request input for one upstream protocol:
//                                         chat (OpenAI-compatible), anthropic (Messages), responses
//                                         (OpenAI Responses), google (Gemini), mistral
//   toChatCompletion(events, …)         @opencode/ai events → one chat.completion object
//   toChunks(events, …)                 @opencode/ai events → chat.completion.chunk objects, as they come
//   newCompletionId()                   chatcmpl-…
//
// Field by field it follows the mapping report (§1.2, all verified against
// 127.0.0.1 mocks): system/developer messages at the start become the system
// prompt, tool-call arguments are parsed (a string would be JSON-encoded
// twice), tool results get the name of the call they answer, images are data
// URLs (base64 only) or http(s) URLs with a media type, and fields
// @opencode/ai doesn't model (response_format, parallel_tool_calls on chat…)
// go through `http.body`, which it merges into the upstream JSON as is.

import crypto from 'node:crypto';
import { Media, Message, ToolCallPart, ToolResultPart } from '@opencode/ai';
import { ServiceError } from './errors.mjs';

/** Upstream protocols toLLMInput() knows. */
export const PROTOCOLS = Object.freeze(['chat', 'anthropic', 'responses', 'google', 'mistral']);

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const PART_TYPES = new Set(['text', 'image_url', 'file']);
const TOOL_CHOICES = new Set(['auto', 'none', 'required']);
const RESPONSE_FORMATS = new Set(['text', 'json_object', 'json_schema']);

const invalid = message => new ServiceError(400, 'invalid_request', message);

// ── Request body ──────────────────────────────────────────────────────────────

function number(out, body, field, rule) {
  const value = body[field];
  if (value === undefined || value === null) return;
  const ok = typeof value === 'number' && Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    (rule.min === undefined || value >= rule.min) &&
    (rule.max === undefined || value <= rule.max);
  if (!ok) {
    const kind = rule.integer ? 'a whole number' : 'a number';
    const range = rule.max !== undefined ? ' from ' + rule.min + ' to ' + rule.max : (rule.min !== undefined ? ' of at least ' + rule.min : '');
    throw invalid('"' + field + '" must be ' + kind + range + '.');
  }
  out[field] = value;
}

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const imageUrlOf = part => (typeof part.image_url === 'string' ? part.image_url : isObject(part.image_url) ? part.image_url.url : undefined);
const BASE64_DATA_URL = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]*)*;base64,[A-Za-z0-9+/=\s]*$/i;

function checkPart(part, where) {
  if (!isObject(part) || typeof part.type !== 'string') throw invalid(where + ' must be a content part with a "type".');
  if (!PART_TYPES.has(part.type)) throw invalid(where + ': parts of type "' + String(part.type).slice(0, 40) + '" aren\'t supported (only text, image_url and file).');
  if (part.type === 'text' && typeof part.text !== 'string') throw invalid(where + '.text must be text.');
  if (part.type === 'image_url') {
    const url = imageUrlOf(part);
    if (typeof url !== 'string' || !url) throw invalid(where + '.image_url.url is required.');
    if (/^data:/i.test(url)) { if (!BASE64_DATA_URL.test(url)) throw invalid(where + ': the image\'s data URL must be base64 with a media type (data:image/png;base64,…).'); }
    else if (!/^https?:\/\//i.test(url)) throw invalid(where + ': the image must be an http(s) URL or a base64 data URL.');
  }
  if (part.type === 'file') {
    const data = isObject(part.file) ? part.file.file_data : undefined;
    if (typeof data !== 'string' || !BASE64_DATA_URL.test(data)) throw invalid(where + ': files must come as file.file_data, a base64 data URL (file ids aren\'t supported).');
  }
}

function checkToolCalls(calls, where) {
  if (!Array.isArray(calls)) throw invalid(where + ' must be a list.');
  calls.forEach((c, j) => {
    const at = where + '[' + j + ']';
    if (!isObject(c) || typeof c.id !== 'string' || !c.id) throw invalid(at + '.id is required.');
    if (c.type !== undefined && c.type !== 'function') throw invalid(at + '.type must be "function".');
    if (!isObject(c.function) || typeof c.function.name !== 'string' || !c.function.name) throw invalid(at + '.function.name is required.');
    const args = c.function.arguments;
    if (args !== undefined && args !== null && typeof args !== 'string' && !isObject(args)) throw invalid(at + '.function.arguments must be a JSON string.');
  });
}

/**
 * Checks an OpenAI Chat Completions body (what MetaCode's fromOpenAIRequest
 * forwards) and returns a clean copy with only the known fields. Unknown
 * fields are dropped. Messages keep their role (`developer` included; it's
 * read as `system` by toLLMInput) and their content parts as they came, so
 * an OpenAI-compatible provider can pass them on unchanged.
 *
 * Accepted: model (string), messages (role system|developer|user|assistant|tool;
 * content text | parts (text, image_url, file) | null with tool_calls; name;
 * tool_calls; tool_call_id), max_tokens, max_completion_tokens (whole ≥ 1),
 * temperature 0–2, top_p 0–1, presence_penalty / frequency_penalty −2–2,
 * seed (whole), stop (text or list of texts), tools (function tools),
 * tool_choice, parallel_tool_calls, response_format, reasoning_effort,
 * stream, stream_options, n (only 1).
 *
 * @param {*} body
 * @returns {object} the normalized body (`stream` is always a boolean)
 * @throws {ServiceError} 400 invalid_request, saying which field is wrong
 */
export function validateChatBody(body) {
  if (!isObject(body)) throw invalid('The request body must be a JSON object.');
  if (body.model !== undefined && body.model !== null && (typeof body.model !== 'string' || !body.model.trim())) throw invalid('"model" must be a model id.');
  if (!Array.isArray(body.messages) || !body.messages.length) throw invalid('"messages" must be a non-empty list.');

  const messages = body.messages.map((m, i) => {
    const where = 'messages[' + i + ']';
    if (!isObject(m)) throw invalid(where + ' must be an object.');
    if (!ROLES.has(m.role)) throw invalid(where + '.role must be system, developer, user, assistant or tool.');
    const out = { role: m.role };
    const hasToolCalls = m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    if (typeof m.content === 'string') out.content = m.content;
    else if (Array.isArray(m.content)) {
      m.content.forEach((part, j) => checkPart(part, where + '.content[' + j + ']'));
      out.content = m.content;
    } else if ((m.content === null || m.content === undefined) && hasToolCalls) out.content = null;
    else throw invalid(where + '.content must be text or a list of content parts.');
    if (typeof m.name === 'string') out.name = m.name;
    if (hasToolCalls) {
      checkToolCalls(m.tool_calls, where + '.tool_calls');
      out.tool_calls = m.tool_calls;
    }
    if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) throw invalid(where + '.tool_call_id is required for tool messages.');
      out.tool_call_id = m.tool_call_id;
    }
    return out;
  });

  const out = { messages };
  if (typeof body.model === 'string') out.model = body.model.trim();
  number(out, body, 'max_tokens', { integer: true, min: 1 });
  number(out, body, 'max_completion_tokens', { integer: true, min: 1 });
  number(out, body, 'temperature', { min: 0, max: 2 });
  number(out, body, 'top_p', { min: 0, max: 1 });
  number(out, body, 'presence_penalty', { min: -2, max: 2 });
  number(out, body, 'frequency_penalty', { min: -2, max: 2 });
  number(out, body, 'seed', { integer: true });
  if (body.n !== undefined && body.n !== null && body.n !== 1) throw invalid('"n" must be 1 (one answer per request).');

  if (body.stop !== undefined && body.stop !== null) {
    const ok = typeof body.stop === 'string' || (Array.isArray(body.stop) && body.stop.every(s => typeof s === 'string'));
    if (!ok) throw invalid('"stop" must be a string or a list of strings.');
    out.stop = body.stop;
  }

  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) throw invalid('"tools" must be a list.');
    body.tools.forEach((t, i) => {
      if (!isObject(t) || (t.type !== undefined && t.type !== 'function')) throw invalid('tools[' + i + '] must be a function tool ({type: "function", function: {…}}).');
      if (!isObject(t.function) || typeof t.function.name !== 'string' || !t.function.name) throw invalid('tools[' + i + '].function.name is required.');
      if (t.function.parameters !== undefined && t.function.parameters !== null && !isObject(t.function.parameters)) throw invalid('tools[' + i + '].function.parameters must be a JSON schema object.');
      if (t.function.description !== undefined && t.function.description !== null && typeof t.function.description !== 'string') throw invalid('tools[' + i + '].function.description must be text.');
    });
    out.tools = body.tools;
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    const tc = body.tool_choice;
    const ok = (typeof tc === 'string' && TOOL_CHOICES.has(tc)) ||
      (isObject(tc) && tc.type === 'function' && isObject(tc.function) && typeof tc.function.name === 'string' && tc.function.name);
    if (!ok) throw invalid('"tool_choice" must be "auto", "none", "required" or {type: "function", function: {name}}.');
    out.tool_choice = tc;
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
    if (typeof body.parallel_tool_calls !== 'boolean') throw invalid('"parallel_tool_calls" must be true or false.');
    out.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.response_format !== undefined && body.response_format !== null) {
    const rf = body.response_format;
    if (!isObject(rf) || !RESPONSE_FORMATS.has(rf.type)) throw invalid('"response_format" must be {type: "text"}, {type: "json_object"} or {type: "json_schema", json_schema: {…}}.');
    if (rf.type === 'json_schema' && (!isObject(rf.json_schema) || !isObject(rf.json_schema.schema))) throw invalid('"response_format.json_schema.schema" must be a JSON schema object.');
    out.response_format = rf;
  }
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    if (typeof body.reasoning_effort !== 'string' || !/^[a-z]{1,20}$/i.test(body.reasoning_effort)) throw invalid('"reasoning_effort" must be a word such as low, medium or high.');
    out.reasoning_effort = body.reasoning_effort;
  }
  out.stream = false;
  if (body.stream !== undefined && body.stream !== null) {
    if (typeof body.stream !== 'boolean') throw invalid('"stream" must be true or false.');
    out.stream = body.stream;
  }
  if (out.stream && body.stream_options !== undefined && body.stream_options !== null) {
    if (!isObject(body.stream_options)) throw invalid('"stream_options" must be an object.');
    out.stream_options = body.stream_options;
  }
  return out;
}

// ── Request → @opencode/ai input ──────────────────────────────────────────────

const textOf = content =>
  (typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p && p.type === 'text').map(p => p.text).join('') : '');

// Media type of an http(s) image from its extension. Any image/* works: the
// upstreams take URLs without one, but @opencode/ai needs one to treat it as an image.
const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif' };

function dataUrlAsset(url, where) {
  try { return Media.fromDataUrl(url.replace(/\s+/g, '')); }
  catch (e) { throw invalid(where + ': the data URL couldn\'t be read (it must be base64 with a media type).'); }
}

function mediaPart(part, where, protocol, model) {
  if (part.type === 'image_url') {
    const url = imageUrlOf(part);
    if (/^data:/i.test(url)) return Message.media(dataUrlAsset(url, where));
    // Gemini takes images only inline (the service doesn't download links for it)
    if (protocol === 'google') throw new ServiceError(400, 'unsupported_feature', 'The model "' + modelName(model) + '" takes images only as base64 data URLs, not as links (' + where + ').');
    const ext = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(url).pathname) || [])[1];
    return Message.media(Media.url(url, { mediaType: IMAGE_EXT[String(ext).toLowerCase()] || 'image/*' }));
  }
  // file: a base64 data URL (validateChatBody checked)
  const file = part.file;
  return Message.media(dataUrlAsset(file.file_data, where), typeof file.filename === 'string' && file.filename ? { filename: file.filename } : undefined);
}

const hasMedia = m => Array.isArray(m.content) && m.content.some(p => p && p.type !== 'text');

function parseArguments(args) {
  if (isObject(args)) return args;
  if (typeof args !== 'string' || !args.trim()) return {};
  try { const v = JSON.parse(args); return v === null || typeof v !== 'object' ? { value: v } : v; } catch (e) { return {}; }
}

const modelName = model => (model && (model.id || model.model)) || 'this model';

/**
 * Builds the @opencode/ai request input for one upstream protocol. The caller
 * adds the model object (`{model: languageModel, ...input}`) and its own
 * `http.headers` / timeouts, then calls `ai.llm.stream(…)`.
 *
 * Mapping (report §1.2): leading system/developer messages → `system`; later ones
 * → `Message.system` (the chat route sends them as a user "<system-update>");
 * user text and parts (images: base64 data URL or http(s) URL with a media type
 * from the extension, else image/* — google takes data URLs only; files: base64
 * data URL); assistant text and `tool_calls` (arguments parsed); tool messages
 * → tool results named after their call; `tools` (raw JSON schema) and
 * `tool_choice`; `max_completion_tokens`
 * / `max_tokens`, `temperature`, `top_p`, penalties, `seed`, `stop` →
 * `generation`; `reasoning_effort` → providerOptions (`reasoningEffort`; anthropic
 * `effort`; google `thinkingConfig`); `response_format` → chat/mistral:
 * `http.body.response_format`, responses: `http.body.text.format`, anthropic:
 * `providerOptions.output_config.format` (json_object: an instruction instead),
 * google: `http.body.generationConfig`; `parallel_tool_calls` → chat/mistral:
 * `http.body`, others: `toolChoice.disableParallelToolUse`. `messages[].name`
 * and `image_url.detail` are dropped (pass the raw messages in
 * `http.body.messages` for an exact copy on a chat upstream).
 *
 * Model rules (from the catalog entry): tools when `toolCall === false` and
 * images/files when `attachment === false` → unsupported_feature; `maxTokens`
 * capped at `maxOutput` (anthropic without a request: `maxOutput`); temperature
 * dropped when `temperature === false`. `reasoning_effort` is sent only for an
 * entry without `variants` (a provider with variants maps it to a variant and
 * passes that variant's settings instead). With anthropic thinking settings
 * (`settings.thinking` enabled/adaptive), temperature is dropped and maxTokens
 * kept ≥ 2 × the thinking budget.
 *
 * @param {object} body                 a validateChatBody() result
 * @param {object} opts
 * @param {string} opts.protocol        'chat' | 'anthropic' | 'responses' | 'google' | 'mistral'
 * @param {object} [opts.model]         catalog entry: {id?, model?, toolCall?, attachment?, temperature?, maxOutput?, variants?}
 * @param {object} [opts.settings]      the chosen variant's settings (as given to the model), e.g. {thinking: {type: 'enabled', budgetTokens}}
 * @returns {{system: object[], messages: object[], tools?: object[], toolChoice?: object, generation: object, providerOptions?: object, http: {body?: object}}}
 * @throws {ServiceError} 400 invalid_request (bad data URL) or 400 unsupported_feature (capabilities; an image
 *   link for google, which takes images only inline); 500 internal_error for an unknown protocol
 */
export function toLLMInput(body, opts) {
  const { protocol, model = {}, settings } = opts || {};
  if (!PROTOCOLS.includes(protocol)) throw new ServiceError(500, 'internal_error', 'Unknown upstream protocol "' + protocol + '".');
  const chatLike = protocol === 'chat' || protocol === 'mistral';

  if (model.toolCall === false && Array.isArray(body.tools) && body.tools.length) {
    throw new ServiceError(400, 'unsupported_feature', 'The model "' + modelName(model) + '" doesn\'t support tool calling. Pick a model that does.');
  }
  if (model.attachment === false && body.messages.some(hasMedia)) {
    throw new ServiceError(400, 'unsupported_feature', 'The model "' + modelName(model) + '" doesn\'t accept images or files. Pick a model that does, or send text only.');
  }

  const system = [];
  const messages = [];
  const toolNames = new Map();         // tool_call_id → function name (OpenAI tool messages carry none)
  let leading = true;
  body.messages.forEach((m, i) => {
    const where = 'messages[' + i + ']';
    const role = m.role === 'developer' ? 'system' : m.role;
    if (role === 'system' && leading) { system.push({ type: 'text', text: textOf(m.content) }); return; }
    leading = false;
    if (role === 'system') messages.push(Message.system(textOf(m.content)));
    else if (role === 'user') {
      const content = typeof m.content === 'string' ? m.content
        : m.content.map((p, j) => (p.type === 'text' ? { type: 'text', text: p.text } : mediaPart(p, where + '.content[' + j + ']', protocol, model)));
      messages.push({ role: 'user', content });
    } else if (role === 'assistant') {
      const parts = [];
      const text = textOf(m.content);
      if (text) parts.push({ type: 'text', text });
      for (const c of m.tool_calls || []) {
        toolNames.set(c.id, c.function.name);
        parts.push(ToolCallPart.make({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));
      }
      if (parts.length) messages.push({ role: 'assistant', content: parts });
    } else if (role === 'tool') {
      messages.push(Message.tool(ToolResultPart.make({ id: m.tool_call_id, name: toolNames.get(m.tool_call_id) || '', result: textOf(m.content), resultType: 'text' })));
    }
  });

  const tools = (body.tools || []).map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    inputSchema: t.function.parameters || { type: 'object', properties: {} }
  }));
  let toolChoice;
  const tc = body.tool_choice;
  if (typeof tc === 'string') toolChoice = { type: tc };
  else if (tc && tc.type === 'function') toolChoice = { type: 'tool', name: tc.function.name };
  if (body.parallel_tool_calls === false && !chatLike && tools.length) toolChoice = Object.assign({ type: 'auto' }, toolChoice, { disableParallelToolUse: true });

  // Generation settings
  const thinking = protocol === 'anthropic' && settings && settings.thinking && /^(enabled|adaptive)$/.test(settings.thinking.type) ? settings.thinking : null;
  const maxOutput = Number.isInteger(model.maxOutput) && model.maxOutput > 0 ? model.maxOutput : undefined;
  let maxTokens = body.max_completion_tokens !== undefined ? body.max_completion_tokens : body.max_tokens;
  if (maxTokens === undefined && protocol === 'anthropic') maxTokens = maxOutput;     // else @opencode/ai sends 32000
  if (maxTokens !== undefined && maxOutput) maxTokens = Math.min(maxTokens, maxOutput);
  if (thinking && Number.isInteger(thinking.budgetTokens) && maxTokens !== undefined && maxTokens < 2 * thinking.budgetTokens) {
    maxTokens = maxOutput ? Math.min(maxOutput, 2 * thinking.budgetTokens) : undefined;
  }
  const generation = {};
  const set = (key, value) => { if (value !== undefined && value !== null) generation[key] = value; };
  set('maxTokens', maxTokens);
  if (model.temperature !== false && !thinking) set('temperature', body.temperature);
  set('topP', body.top_p);
  set('frequencyPenalty', body.frequency_penalty);
  set('presencePenalty', body.presence_penalty);
  set('seed', body.seed);
  if (body.stop !== undefined) set('stop', [].concat(body.stop));

  const providerOptions = {};
  const httpBody = {};
  if (body.reasoning_effort && model.variants === undefined && !settings) {
    if (protocol === 'anthropic') providerOptions.effort = body.reasoning_effort;              // → output_config.effort
    else if (protocol === 'google') providerOptions.thinkingConfig = { includeThoughts: true, thinkingLevel: body.reasoning_effort };
    else providerOptions.reasoningEffort = body.reasoning_effort;                             // chat: reasoning_effort; responses: reasoning.effort
  }
  const rf = body.response_format;
  if (rf && rf.type !== 'text') {
    const js = rf.type === 'json_schema' ? rf.json_schema : null;
    if (chatLike) httpBody.response_format = rf;
    else if (protocol === 'responses') {
      httpBody.text = { format: js ? Object.assign({ type: 'json_schema', name: js.name || 'response', schema: js.schema }, js.strict !== undefined ? { strict: js.strict } : {}) : { type: 'json_object' } };
    } else if (protocol === 'google') {
      httpBody.generationConfig = Object.assign({ responseMimeType: 'application/json' }, js ? { responseJsonSchema: js.schema } : {});
    } else if (js) providerOptions.output_config = { format: { type: 'json_schema', schema: js.schema } };
    else system.push({ type: 'text', text: 'Respond with a single valid JSON object and nothing else.' });
  }
  if (chatLike && body.parallel_tool_calls !== undefined && tools.length) httpBody.parallel_tool_calls = body.parallel_tool_calls;   // 2.1.4's chat lowering drops it

  const input = { system, messages, tools, generation };
  if (toolChoice && tools.length) input.toolChoice = toolChoice;
  if (Object.keys(providerOptions).length) input.providerOptions = providerOptions;
  input.http = Object.keys(httpBody).length ? { body: httpBody } : {};
  return input;
}

// ── @opencode/ai events → OpenAI answers ─────────────────────────────────────

/** @opencode/ai's normalized finish reason → OpenAI's finish_reason */
export const FINISH = Object.freeze({ stop: 'stop', length: 'length', 'tool-calls': 'tool_calls', 'content-filter': 'content_filter', error: 'stop', unknown: 'stop' });
const finishReason = reason => FINISH[reason && reason.normalized] || 'stop';

/**
 * @opencode/ai Usage → OpenAI usage: {prompt_tokens, completion_tokens, total_tokens,
 * prompt_tokens_details?: {cached_tokens}, completion_tokens_details?: {reasoning_tokens}}, or undefined.
 */
export function toUsage(u) {
  if (!u) return undefined;
  const prompt = u.inputTokens || 0;
  const completion = u.outputTokens || 0;
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: u.totalTokens !== undefined ? u.totalTokens : prompt + completion };
  if (u.cacheReadInputTokens !== undefined || u.cacheWriteInputTokens !== undefined) out.prompt_tokens_details = { cached_tokens: u.cacheReadInputTokens || 0 };
  if (u.reasoningTokens !== undefined) out.completion_tokens_details = { reasoning_tokens: u.reasoningTokens };
  return out;
}

const argumentsOf = input => (typeof input === 'string' ? input : JSON.stringify(input === undefined ? {} : input));

/** A new completion id: 'chatcmpl-' + 24 hex characters. */
export function newCompletionId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

/**
 * Reads every event of one call and returns the OpenAI chat.completion.
 * Text per text id (a `text-end.text` replaces its deltas), reasoning as
 * `message.reasoning_content`, tool calls with their parsed input
 * re-stringified (a `tool-input-error` gives the call with its raw arguments),
 * `content: null` when there are calls and no text. Usage when the upstream
 * reported it. Errors thrown by the iterator are passed on (fromAIError them).
 *
 * @param {AsyncIterable<object>|Iterable<object>} events   from `ai.llm.stream(…)` (or a list)
 * @param {{id?: string, model: string, created?: number}} meta   model = the full id to report
 * @returns {Promise<object>} `{id, object: 'chat.completion', created, model, choices: [{index: 0, message, finish_reason, logprobs: null}], usage?}`
 */
export async function toChatCompletion(events, meta) {
  const { id = newCompletionId(), model, created = Math.floor(Date.now() / 1000) } = meta || {};
  const text = new Map();             // text id → text, in output order
  const reasoning = new Map();
  const calls = [];
  const seen = new Set();
  let finish, usage;
  for await (const e of events) {
    switch (e.type) {
      case 'text-delta': text.set(e.id, (text.get(e.id) || '') + e.text); break;
      case 'text-end': if (typeof e.text === 'string') text.set(e.id, e.text); break;
      case 'reasoning-delta': reasoning.set(e.id, (reasoning.get(e.id) || '') + e.text); break;
      case 'reasoning-end': if (typeof e.text === 'string') reasoning.set(e.id, e.text); break;
      case 'tool-call':
        if (e.providerExecuted || seen.has(e.id)) break;            // provider-run tools aren't the client's to run
        seen.add(e.id);
        calls.push({ id: e.id, type: 'function', function: { name: e.name, arguments: argumentsOf(e.input) } });
        break;
      case 'tool-input-error':                                     // the model's arguments weren't JSON: hand them back as they came
        if (seen.has(e.id)) break;
        seen.add(e.id);
        calls.push({ id: e.id, type: 'function', function: { name: e.name, arguments: typeof e.raw === 'string' ? e.raw : '' } });
        break;
      case 'step-finish': if (e.usage) usage = e.usage; break;
      case 'finish': finish = e.reason; if (e.usage) usage = e.usage; break;
    }
  }
  const content = [...text.values()].join('');
  const message = { role: 'assistant', content: calls.length && !content ? null : content };
  const thought = [...reasoning.values()].join('');
  if (thought) message.reasoning_content = thought;
  if (calls.length) message.tool_calls = calls;
  const out = { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finishReason(finish), logprobs: null }] };
  const u = toUsage(usage);
  if (u) out.usage = u;
  return out;
}

/**
 * Turns the events of one call into OpenAI chat.completion.chunk objects as
 * they arrive (the caller writes each as `data: <json>` and ends with
 * `data: [DONE]`). The first chunk carries `role: 'assistant'`; text →
 * `delta.content`, reasoning → `delta.reasoning_content`; tool calls get
 * indexes in the order they start (`tool-input-start` → id and name,
 * `tool-input-delta` → argument pieces; a whole `tool-call` without a start,
 * as Gemini sends, → one complete delta); the finish → `delta: {}` with
 * `finish_reason`; then, with includeUsage, `{choices: [], usage}`. Errors
 * thrown by the iterator are passed on.
 *
 * @param {AsyncIterable<object>|Iterable<object>} events
 * @param {{id?: string, model: string, created?: number, includeUsage?: boolean}} meta
 * @returns {AsyncGenerator<object>}
 */
export async function* toChunks(events, meta) {
  const { id = newCompletionId(), model, created = Math.floor(Date.now() / 1000), includeUsage = false } = meta || {};
  const head = { id, object: 'chat.completion.chunk', created, model };
  const chunk = (delta, finish_reason) => Object.assign({}, head, { choices: [{ index: 0, delta, finish_reason: finish_reason || null, logprobs: null }] });
  let roleSent = false;
  const withRole = delta => { if (roleSent) return delta; roleSent = true; return Object.assign({ role: 'assistant' }, delta); };
  const sentText = new Map();          // text / reasoning id → what was sent (for an authoritative *-end text)
  const toolIndex = new Map();         // tool call id → index
  const sentArgs = new Map();          // tool call id → arguments sent so far
  let usage, finished = false;

  const textPiece = (key, field, piece) => {
    if (!piece) return null;
    sentText.set(key, (sentText.get(key) || '') + piece);
    return chunk(withRole({ [field]: piece }));
  };
  // a *-end with the full text: send what the deltas didn't (nothing if they differ)
  const textEnd = (key, field, full) => {
    if (typeof full !== 'string') return null;
    const sent = sentText.get(key) || '';
    return full.startsWith(sent) ? textPiece(key, field, full.slice(sent.length)) : null;
  };
  const wholeCall = (e, args) => {
    const index = toolIndex.size;
    toolIndex.set(e.id, index);
    sentArgs.set(e.id, args);
    return chunk(withRole({ tool_calls: [{ index, id: e.id, type: 'function', function: { name: e.name, arguments: args } }] }));
  };

  for await (const e of events) {
    let out = null;
    switch (e.type) {
      case 'text-delta': out = textPiece('t:' + e.id, 'content', e.text); break;
      case 'text-end': out = textEnd('t:' + e.id, 'content', e.text); break;
      case 'reasoning-delta': out = textPiece('r:' + e.id, 'reasoning_content', e.text); break;
      case 'reasoning-end': out = textEnd('r:' + e.id, 'reasoning_content', e.text); break;
      case 'tool-input-start':
        if (e.providerExecuted || toolIndex.has(e.id)) break;
        out = wholeCall(e, '');
        break;
      case 'tool-input-delta':
        if (!toolIndex.has(e.id) || !e.text) break;
        sentArgs.set(e.id, sentArgs.get(e.id) + e.text);
        out = chunk({ tool_calls: [{ index: toolIndex.get(e.id), function: { arguments: e.text } }] });
        break;
      case 'tool-call':
        if (e.providerExecuted) break;
        if (!toolIndex.has(e.id)) out = wholeCall(e, argumentsOf(e.input));
        else if (!sentArgs.get(e.id)) {           // started, but the arguments only came with the call
          const args = argumentsOf(e.input);
          sentArgs.set(e.id, args);
          out = chunk({ tool_calls: [{ index: toolIndex.get(e.id), function: { arguments: args } }] });
        }
        break;
      case 'tool-input-error':
        if (!toolIndex.has(e.id)) out = wholeCall(e, typeof e.raw === 'string' ? e.raw : '');
        break;
      case 'step-finish': if (e.usage) usage = e.usage; break;
      case 'finish':
        if (e.usage) usage = e.usage;
        if (!roleSent) yield chunk(withRole({ content: '' }));
        finished = true;
        out = chunk({}, finishReason(e.reason));
        break;
    }
    if (out) yield out;
  }
  if (!finished) {                     // (every protocol ends with a finish event; just in case)
    if (!roleSent) yield chunk(withRole({ content: '' }));
    yield chunk({}, 'stop');
  }
  if (includeUsage) yield Object.assign({}, head, { choices: [], usage: toUsage(usage) || null });
}
