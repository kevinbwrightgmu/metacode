// The OpenCode service's protocol layer — opencode/openai.mjs (OpenAI chat ⇄
// @opencode/ai), opencode/errors.mjs (ServiceError, fromAIError, redact) and
// opencode/http.mjs (createAI, capture/substitute middleware, chat shims) —
// against stand-ins for the four upstream protocols on 127.0.0.1: OpenAI-
// compatible chat, Anthropic Messages, OpenAI Responses and Gemini. Nothing
// here leaves this machine. The modules are ESM, so they're import()ed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const KEY = 'sk-test-protocol-layer-0123456789';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let O, E, H, LM, pkg, up, ai;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Stand-in upstream: records every request; `set(handler)` decides the answers
function startUpstream() {
  const state = { seen: [], handler: null, sockets: new Set() };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', c => { b += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(b || '{}'); } catch (e) { body = b; }
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      state.seen.push(entry);
      Promise.resolve((state.handler || ((q, r) => sse(r, hello())))(req, res, entry)).catch(e => {
        if (!res.headersSent) res.writeHead(599);
        res.end(String(e));
      });
    });
  });
  srv.on('connection', s => { state.sockets.add(s); s.on('close', () => state.sockets.delete(s)); });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    resolve({
      port, host: '127.0.0.1:' + port, base: 'http://127.0.0.1:' + port, state,
      set(handler) { state.handler = handler; state.seen.length = 0; },
      close: () => new Promise(r => { state.sockets.forEach(s => s.destroy()); srv.close(r); })
    });
  }));
}

async function sse(res, chunks, opts) {
  const { done = true, headers = {}, delayMs = 0 } = opts || {};
  res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream' }, headers));
  for (const c of chunks) {
    res.write('data: ' + (typeof c === 'string' ? c : JSON.stringify(c)) + '\n\n');
    if (delayMs) await sleep(delayMs);
  }
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}
const named = (res, events) => {          // Anthropic / Responses streams: `event:` + `data:`
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
  res.end();
};
const reply = (status, body, headers, type) => (req, res) => {
  res.writeHead(status, Object.assign({ 'content-type': type || 'application/json' }, headers));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const page = title => '<!DOCTYPE html><html><head><title>' + title + '</title></head><body><h1>' + title + '</h1></body></html>';
const chunk = (delta, finish_reason, extra) => Object.assign({ id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, model: 'up', choices: [{ index: 0, delta, ...(finish_reason !== undefined ? { finish_reason } : {}) }] }, extra);
const hello = () => [chunk({ role: 'assistant', content: 'Hel' }), chunk({ content: 'lo' }, 'stop'), { id: 'cmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }];
const anthropicHello = res => named(res, [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' }
]);
const responsesHello = res => named(res, [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }
]);
const geminiHello = res => sse(res, [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }], { done: false });

// Models the way the Zen and OpenAI-compatible providers make them
const chatModel = (compat, extra) => {
  const m = pkg.chat.model('m', Object.assign({ apiKey: KEY, baseURL: up.base + '/v1', provider: 'opencode' }, extra));
  return compat ? LM.update(m, { compatibility: compat }) : m;
};
const models = () => ({
  chat: chatModel(),
  anthropic: pkg.anthropic.model('claude-x', { apiKey: KEY, baseURL: up.base + '/anthropic/v1' }),
  responses: pkg.openai.model('gpt-x', { apiKey: KEY, baseURL: up.base + '/openai/v1' }),
  google: pkg.google.model('gemini-x', { apiKey: KEY, baseURL: up.base + '/google/v1beta' }),
  mistral: pkg.mistral.model('mistral-x', { apiKey: KEY, baseURL: up.base + '/v1' })
});
const replies = { chat: (q, r) => sse(r, hello()), mistral: (q, r) => sse(r, hello()), anthropic: (q, r) => anthropicHello(r), responses: (q, r) => responsesHello(r), google: (q, r) => geminiHello(r) };

const ZEN = { provider: 'opencode', providerName: 'OpenCode Zen', model: 'opencode/m' };
const userSays = text => ({ system: [], messages: [{ role: 'user', content: text }], tools: [], generation: {} });

async function collect(iterable) {
  const out = [];
  for await (const e of iterable) out.push(e);
  return out;
}

// What a call failed with, as a ServiceError
async function failure(client, model, input, run, ctx) {
  try {
    await O.toChatCompletion(client.llm.stream(Object.assign({ model }, input || userSays('x')), run), { model: 'opencode/m' });
  } catch (e) {
    return E.fromAIError(e, Object.assign({ secrets: [KEY], signal: run && run.signal }, ZEN, ctx));
  }
  return assert.fail('the call should have failed');
}

// Rebuilds a completion from chunks the way OpenAI's SDKs do
function accumulate(chunks) {
  let role, content = '', reasoning = '', finish, usage, roleChunks = 0;
  const calls = [];
  for (const c of chunks) {
    assert.equal(c.object, 'chat.completion.chunk');
    if (!c.choices.length) { usage = c.usage; continue; }
    const choice = c.choices[0];
    const d = choice.delta;
    if (d.role) { role = d.role; roleChunks++; }
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    for (const t of d.tool_calls || []) {
      if (!calls[t.index]) {
        assert.ok(t.id && t.function && t.function.name, 'a new tool call starts with its id and name');
        calls[t.index] = { id: t.id, type: 'function', function: { name: t.function.name, arguments: '' } };
      }
      if (t.function && t.function.arguments) calls[t.index].function.arguments += t.function.arguments;
    }
    if (choice.finish_reason) {
      assert.equal(finish, undefined, 'one finish_reason');
      finish = choice.finish_reason;
    }
  }
  assert.equal(roleChunks, 1, 'the role comes once, first');
  const message = { role, content: calls.length && !content ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;
  return { message, finish_reason: finish, usage };
}

const RICH = () => ({
  model: 'opencode/x',
  messages: [
    { role: 'system', content: 'You are MetaCode\'s assistant.' },
    { role: 'developer', content: [{ type: 'text', text: 'Answer briefly.' }] },
    { role: 'user', content: [{ type: 'text', text: 'What\'s in this image, and the weather?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG, detail: 'low' } }, { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '18C sunny' },
    { role: 'assistant', content: 'It is 18C.' },
    { role: 'user', content: 'Thanks. JSON please.' }
  ],
  tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather by city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
  tool_choice: 'auto', parallel_tool_calls: false,
  temperature: 0.2, top_p: 0.9, max_tokens: 300, stop: 'END', seed: 1, presence_penalty: 0.1, frequency_penalty: 0.2,
  reasoning_effort: 'low',
  response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object', properties: { answer: { type: 'string' } } }, strict: true } },
  user: 'u-42',                  // (not forwarded: not one of the fields MetaCode sends)
  stream: true,
  some_unknown_field: 'dropped'
});
const WEATHER_SCHEMA = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } } };

// What the upstream received for one mapped request
async function sent(protocol, body, opts) {
  up.set(replies[protocol]);
  const input = O.toLLMInput(O.validateChatBody(body), Object.assign({ protocol, model: { id: 'opencode/x' } }, opts));
  const done = await O.toChatCompletion(ai.llm.stream(Object.assign({ model: models()[protocol], cache: 'none' }, input)), { model: 'opencode/x' });
  assert.equal(done.choices[0].message.content, 'Hello');
  assert.equal(up.state.seen.length, 1);
  return up.state.seen[0];
}

test.before(async () => {
  O = await import('../opencode/openai.mjs');
  E = await import('../opencode/errors.mjs');
  H = await import('../opencode/http.mjs');
  LM = (await import('@opencode/ai')).LanguageModel;
  pkg = {
    chat: await import('@opencode/ai/providers/openai-compatible'),
    openai: await import('@opencode/ai/providers/openai'),
    anthropic: await import('@opencode/ai/providers/anthropic'),
    google: await import('@opencode/ai/providers/google'),
    mistral: await import('@opencode/ai/providers/mistral')
  };
  up = await startUpstream();
  ai = H.createAI();
});
test.after(async () => {
  if (ai) await ai.dispose();
  if (up) await up.close();
});

// ── Request body ──────────────────────────────────────────────────────────────

test('validateChatBody keeps what MetaCode forwards and drops the rest', () => {
  const body = O.validateChatBody(RICH());
  assert.equal(body.model, 'opencode/x');
  assert.equal(body.messages.length, 7);
  assert.equal(body.messages[1].role, 'developer', 'roles stay as sent (toLLMInput reads developer as system)');
  assert.equal(body.messages[2].content[1].image_url.detail, 'low', 'content parts stay as sent');
  assert.equal(body.messages[3].content, null);
  assert.equal(body.messages[4].tool_call_id, 'call_1');
  for (const k of ['max_tokens', 'temperature', 'top_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'response_format']) {
    assert.deepEqual(body[k], RICH()[k], k);
  }
  assert.equal(body.stream, true);
  assert.equal('some_unknown_field' in body, false);
  assert.equal('user' in body, false);
  const plain = O.validateChatBody({ messages: [{ role: 'user', content: 'hi', name: 'ann' }], n: 1, stream_options: { include_usage: true } });
  assert.equal(plain.stream, false, 'stream is always said');
  assert.equal('stream_options' in plain, false, 'stream_options only with stream');
  assert.equal(plain.messages[0].name, 'ann');
  assert.equal('model' in plain, false, 'no model = the default');
  assert.deepEqual(O.validateChatBody({ messages: [{ role: 'user', content: 'x' }], stream: true, stream_options: { include_usage: true } }).stream_options, { include_usage: true });
});

test('validateChatBody refuses a bad body with invalid_request', () => {
  const user = { role: 'user', content: 'x' };
  const cases = [
    [null, /JSON object/],
    [[], /JSON object/],
    [{ messages: [] }, /non-empty list/],
    [{ messages: [user], model: 7 }, /"model"/],
    [{ messages: [{ role: 'robot', content: 'x' }] }, /role must be/],
    [{ messages: [{ role: 'user' }] }, /content must be text/],
    [{ messages: [{ role: 'assistant', content: null }] }, /content must be text/],
    [{ messages: [{ role: 'tool', content: 'r' }] }, /tool_call_id is required/],
    [{ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }, /aren't supported/],
    [{ messages: [{ role: 'user', content: [{ type: 'text' }] }] }, /\.text must be text/],
    [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml,<svg/>' } }] }] }, /base64/],
    [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }] }] }, /http\(s\) URL/],
    [{ messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file-1' } }] }] }, /file ids/],
    [{ messages: [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'f' } }] }] }, /\.id is required/],
    [{ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', function: {} }] }] }, /function\.name/],
    [{ messages: [user], n: 2 }, /"n" must be 1/],
    [{ messages: [user], temperature: 3 }, /"temperature" must be a number from 0 to 2/],
    [{ messages: [user], top_p: -0.1 }, /"top_p"/],
    [{ messages: [user], max_tokens: 0 }, /"max_tokens" must be a whole number of at least 1/],
    [{ messages: [user], max_completion_tokens: 1.5 }, /max_completion_tokens/],
    [{ messages: [user], presence_penalty: 2.5 }, /presence_penalty/],
    [{ messages: [user], seed: 'x' }, /"seed"/],
    [{ messages: [user], stop: [1] }, /"stop"/],
    [{ messages: [user], tools: {} }, /"tools" must be a list/],
    [{ messages: [user], tools: [{ type: 'retrieval' }] }, /function tool/],
    [{ messages: [user], tools: [{ type: 'function', function: { name: 'f', parameters: 'x' } }] }, /JSON schema/],
    [{ messages: [user], tool_choice: 'sometimes' }, /"tool_choice"/],
    [{ messages: [user], parallel_tool_calls: 'no' }, /parallel_tool_calls/],
    [{ messages: [user], response_format: { type: 'xml' } }, /response_format/],
    [{ messages: [user], response_format: { type: 'json_schema' } }, /json_schema\.schema/],
    [{ messages: [user], reasoning_effort: 5 }, /reasoning_effort/],
    [{ messages: [user], stream: 'yes' }, /"stream" must be true or false/],
    [{ messages: [user], stream: true, stream_options: 'all' }, /stream_options/]
  ];
  for (const [body, message] of cases) {
    assert.throws(() => O.validateChatBody(body), e => {
      assert.ok(E.isServiceError(e), JSON.stringify(body));
      assert.equal(e.status, 400);
      assert.equal(e.type, 'invalid_request');
      assert.match(e.message, message);
      return true;
    }, JSON.stringify(body));
  }
});

test('toLLMInput applies the model\'s capabilities and limits', () => {
  const body = O.validateChatBody(RICH());
  const refuse = (model, re) => assert.throws(() => O.toLLMInput(body, { protocol: 'chat', model }), e => e.status === 400 && e.type === 'unsupported_feature' && re.test(e.message));
  refuse({ id: 'opencode/x', toolCall: false }, /"opencode\/x" doesn't support tool calling/);
  refuse({ id: 'opencode/x', attachment: false }, /doesn't accept images or files/);
  assert.throws(() => O.toLLMInput(body, { protocol: 'google', model: { id: 'opencode/g' } }), e => e.type === 'unsupported_feature' && /base64 data URLs/.test(e.message), 'Gemini takes no image links');
  assert.throws(() => O.toLLMInput(body, { protocol: 'smoke-signals' }), e => e.type === 'internal_error');

  const simple = O.validateChatBody({ messages: [{ role: 'user', content: 'x' }], max_tokens: 5000, temperature: 0.7, reasoning_effort: 'high' });
  let input = O.toLLMInput(simple, { protocol: 'chat', model: { maxOutput: 1000, temperature: false } });
  assert.equal(input.generation.maxTokens, 1000, 'capped at the model\'s output limit');
  assert.equal('temperature' in input.generation, false, 'no temperature for a model without it');
  assert.deepEqual(input.providerOptions, { reasoningEffort: 'high' });
  assert.deepEqual(input.http, {});
  input = O.toLLMInput(simple, { protocol: 'chat', model: { variants: ['low', 'high'] } });
  assert.equal(input.providerOptions, undefined, 'a model with variants gets reasoning_effort as its variant, from the caller');
  input = O.toLLMInput(O.validateChatBody({ messages: [{ role: 'user', content: 'x' }] }), { protocol: 'anthropic', model: { maxOutput: 8192 } });
  assert.equal(input.generation.maxTokens, 8192, 'anthropic: the model\'s limit instead of the 32000 default');
  input = O.toLLMInput(O.validateChatBody({ messages: [{ role: 'user', content: 'x' }], max_tokens: 300, temperature: 0.5 }),
    { protocol: 'anthropic', model: { maxOutput: 64000 }, settings: { thinking: { type: 'enabled', budgetTokens: 16000 } } });
  assert.equal(input.generation.maxTokens, 32000, 'room for the thinking budget');
  assert.equal('temperature' in input.generation, false, 'no temperature with thinking');
  input = O.toLLMInput(O.validateChatBody({ messages: [{ role: 'user', content: 'x' }], tools: RICH().tools, tool_choice: { type: 'function', function: { name: 'get_weather' } } }), { protocol: 'chat' });
  assert.deepEqual(JSON.parse(JSON.stringify(input.toolChoice)), { type: 'tool', name: 'get_weather' });
  input = O.toLLMInput(O.validateChatBody({ messages: [{ role: 'user', content: 'x' }], tool_choice: 'required' }), { protocol: 'chat' });
  assert.equal(input.toolChoice, undefined, 'no tool_choice without tools');
});

// ── Request mapping per protocol (the upstream's own request shapes) ──────────

test('chat protocol: the OpenAI-compatible request', async () => {
  const req = await sent('chat', RICH());
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer ' + KEY);
  assert.deepEqual(req.body, {
    model: 'm',
    messages: [
      { role: 'system', content: 'You are MetaCode\'s assistant.\nAnswer briefly.' },
      { role: 'user', content: [{ type: 'text', text: 'What\'s in this image, and the weather?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }, { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '18C sunny' },
      { role: 'assistant', content: 'It is 18C.' },
      { role: 'user', content: 'Thanks. JSON please.' }
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather by city', parameters: WEATHER_SCHEMA, strict: false } }],
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 300,
    temperature: 0.2, top_p: 0.9, frequency_penalty: 0.2, presence_penalty: 0.1, seed: 1, stop: ['END'],
    reasoning_effort: 'low',
    response_format: RICH().response_format,
    parallel_tool_calls: false
  });

  // a system message later in the conversation, and the gateway's max_tokens spelling
  up.set(replies.chat);
  const later = O.toLLMInput(O.validateChatBody({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'developer', content: 'Now in French.' }, { role: 'user', content: 'c' }], max_completion_tokens: 50 }), { protocol: 'chat' });
  await O.toChatCompletion(ai.llm.stream(Object.assign({ model: chatModel({ maxTokensField: 'max_tokens' }) }, later)), { model: 'x' });
  const b = up.state.seen[0].body;
  assert.equal(b.max_tokens, 50);
  assert.deepEqual(b.messages.map(m => m.role), ['user', 'assistant', 'user', 'user']);
  assert.match(b.messages[2].content, /<system-update>[\s\S]*Now in French\.[\s\S]*<\/system-update>/);

  // the raw messages through http.body (zero-loss pass-through for an OpenAI-compatible gateway)
  up.set(replies.chat);
  const raw = O.validateChatBody(RICH());
  const input = O.toLLMInput(raw, { protocol: 'chat' });
  input.http.body = Object.assign({}, input.http.body, { messages: raw.messages });
  await O.toChatCompletion(ai.llm.stream(Object.assign({ model: chatModel() }, input)), { model: 'x' });
  assert.deepEqual(up.state.seen[0].body.messages, raw.messages);
  assert.equal(up.state.seen[0].body.messages[1].role, 'developer');

  // the one Mistral-routed model: the same chat shape, with max_tokens
  const m = await sent('mistral', { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }], max_tokens: 50, response_format: { type: 'json_object' }, tools: RICH().tools, parallel_tool_calls: false });
  assert.equal(m.url, '/v1/chat/completions');
  assert.deepEqual(m.body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]);
  assert.equal(m.body.max_tokens, 50);
  assert.deepEqual(m.body.response_format, { type: 'json_object' });
  assert.equal(m.body.parallel_tool_calls, false);
});

test('anthropic protocol: the Messages request', async () => {
  const req = await sent('anthropic', RICH());
  assert.equal(req.url, '/anthropic/v1/messages?beta=true');
  assert.equal(req.headers['x-api-key'], KEY);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers.authorization, undefined);
  assert.deepEqual(req.body, {
    model: 'claude-x',
    system: [{ type: 'text', text: 'You are MetaCode\'s assistant.' }, { type: 'text', text: 'Answer briefly.' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What\'s in this image, and the weather?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '18C sunny' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It is 18C.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Thanks. JSON please.' }] }
    ],
    tools: [{ name: 'get_weather', description: 'Weather by city', input_schema: WEATHER_SCHEMA }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    stream: true,
    max_tokens: 300,
    temperature: 0.2, top_p: 0.9,
    stop_sequences: ['END'],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ANSWER_SCHEMA } }
  });
  // json_object has no Anthropic equivalent: an instruction instead
  const plain = await sent('anthropic', { messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } });
  assert.match(plain.body.system[plain.body.system.length - 1].text, /valid JSON object/);
  assert.equal(plain.body.max_tokens, 32000, 'without a model limit: @opencode/ai\'s default');
});

test('responses protocol: the OpenAI Responses request', async () => {
  const req = await sent('responses', RICH());
  assert.equal(req.url, '/openai/v1/responses');
  assert.equal(req.headers.authorization, 'Bearer ' + KEY);
  assert.deepEqual(req.body, {
    model: 'gpt-x',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What\'s in this image, and the weather?' }, { type: 'input_image', image_url: 'data:image/png;base64,' + PNG }, { type: 'input_image', image_url: 'https://example.com/cat.jpg' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '18C sunny' },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'It is 18C.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks. JSON please.' }] }
    ],
    instructions: 'You are MetaCode\'s assistant.\nAnswer briefly.',
    stream: true,
    max_output_tokens: 300,
    temperature: 0.2, top_p: 0.9, presence_penalty: 0.1, frequency_penalty: 0.2,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'low' },
    parallel_tool_calls: false,
    tools: [{ type: 'function', name: 'get_weather', description: 'Weather by city', parameters: WEATHER_SCHEMA, strict: false }],
    tool_choice: 'auto',
    text: { format: { type: 'json_schema', name: 'out', schema: ANSWER_SCHEMA, strict: true } }
  });
  const plain = await sent('responses', { messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } });
  assert.deepEqual(plain.body.text, { format: { type: 'json_object' } });
});

test('google protocol: the Gemini request', async () => {
  const body = RICH();
  body.messages[2].content.pop();          // (no image links for Gemini)
  const req = await sent('google', body);
  assert.equal(req.url, '/google/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
  assert.equal(req.headers['x-goog-api-key'], KEY);
  const b = req.body;
  assert.deepEqual(b.systemInstruction, { parts: [{ text: 'You are MetaCode\'s assistant.' }, { text: 'Answer briefly.' }] });
  assert.deepEqual(b.contents[0], { role: 'user', parts: [{ text: 'What\'s in this image, and the weather?' }, { inlineData: { mimeType: 'image/png', data: PNG } }] });
  assert.deepEqual(b.contents[1].parts[0].functionCall, { id: 'call_1', name: 'get_weather', args: { city: 'Paris' } });
  assert.deepEqual(b.contents[2].parts[0].functionResponse, { id: 'call_1', name: 'get_weather', response: { name: 'get_weather', content: '18C sunny' } }, 'the tool result carries its call\'s name');
  assert.deepEqual(b.contents.slice(3), [{ role: 'model', parts: [{ text: 'It is 18C.' }] }, { role: 'user', parts: [{ text: 'Thanks. JSON please.' }] }]);
  assert.deepEqual(b.tools, [{ functionDeclarations: [{ name: 'get_weather', description: 'Weather by city', parametersJsonSchema: WEATHER_SCHEMA }] }]);
  assert.deepEqual(b.generationConfig, {
    maxOutputTokens: 300, temperature: 0.2, topP: 0.9, frequencyPenalty: 0.2, presencePenalty: 0.1, seed: 1, stopSequences: ['END'],
    thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
    responseMimeType: 'application/json', responseJsonSchema: ANSWER_SCHEMA
  });
});

// ── Answers: non-stream and stream ────────────────────────────────────────────

const ANSWERS = [
  {
    name: 'chat: text with cached and reasoning token counts', protocol: 'chat',
    upstream: (q, r) => sse(r, [chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' }), chunk({}, 'stop'),
      { id: 'cmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } }]),
    message: { role: 'assistant', content: 'Hello' }, finish: 'stop',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } }
  },
  {
    name: 'chat: reasoning, then text', protocol: 'chat',
    upstream: (q, r) => sse(r, [chunk({ role: 'assistant', reasoning_content: 'Think' }), chunk({ reasoning_content: 'ing...' }), chunk({ content: 'Answer' }), chunk({}, 'stop', { usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } })]),
    message: { role: 'assistant', content: 'Answer', reasoning_content: 'Thinking...' }, finish: 'stop',
    usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 }
  },
  {
    name: 'chat: two tool calls, arguments split across chunks', protocol: 'chat',
    upstream: (q, r) => sse(r, [
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }),
      chunk({}, 'tool_calls', { usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 } })]),
    message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }, { id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
    finish: 'tool_calls', usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 }
  },
  {
    name: 'chat: tool arguments that aren\'t JSON come back as they are', protocol: 'chat',
    upstream: (q, r) => sse(r, [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_d', type: 'function', function: { name: 'f', arguments: '{not json' } }] }), chunk({}, 'tool_calls')]),
    message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_d', type: 'function', function: { name: 'f', arguments: '{not json' } }] }, finish: 'tool_calls'
  },
  {
    name: 'chat: cut at the token limit', protocol: 'chat',
    upstream: (q, r) => sse(r, [chunk({ role: 'assistant', content: 'Trunc' }), chunk({}, 'length', { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })]),
    message: { role: 'assistant', content: 'Trunc' }, finish: 'length', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  },
  {
    name: 'chat: content filter', protocol: 'chat',
    upstream: (q, r) => sse(r, [chunk({ role: 'assistant', content: '' }), chunk({}, 'content_filter')]),
    message: { role: 'assistant', content: '' }, finish: 'content_filter'
  },
  {
    name: 'anthropic: thinking, text and a tool call', protocol: 'anthropic',
    upstream: (q, r) => named(r, [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Calling tool.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"Oslo"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' }]),
    message: { role: 'assistant', content: 'Calling tool.', reasoning_content: 'Let me think', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] },
    finish: 'tool_calls', usage: { prompt_tokens: 14, completion_tokens: 30, total_tokens: 44, prompt_tokens_details: { cached_tokens: 4 } }
  },
  {
    name: 'anthropic: max_tokens', protocol: 'anthropic',
    upstream: (q, r) => named(r, [
      { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cut' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }]),
    message: { role: 'assistant', content: 'cut' }, finish: 'length'
  },
  {
    name: 'responses: reasoning, text and a function call', protocol: 'responses',
    upstream: (q, r) => named(r, [
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Plan' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan' }] } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hi' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_r', name: 'get_weather', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"city":"Rome"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 2, arguments: '{"city":"Rome"}' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_r', name: 'get_weather', arguments: '{"city":"Rome"}', status: 'completed' } },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, output_tokens_details: { reasoning_tokens: 3 } } } }]),
    message: { role: 'assistant', content: 'Hi', reasoning_content: 'Plan', tool_calls: [{ id: 'call_r', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }] },
    finish: 'tool_calls', usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 3 } }
  },
  {
    name: 'responses: incomplete at max_output_tokens', protocol: 'responses',
    upstream: (q, r) => named(r, [
      { type: 'response.created', response: { id: 'resp_2', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_2', output_index: 0, content_index: 0, delta: 'cu' },
      { type: 'response.incomplete', response: { id: 'resp_2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }]),
    message: { role: 'assistant', content: 'cu' }, finish: 'length', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  },
  {
    name: 'google: text and a whole tool call', protocol: 'google',
    upstream: (q, r) => sse(r, [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }, { functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } }], { done: false }),
    message: { role: 'assistant', content: 'Hello', tool_calls: [{ id: /^tool_/, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    finish: 'tool_calls', usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
  }
];

test('answers become chat.completion objects and matching chunks', async t => {
  for (const c of ANSWERS) {
    await t.test(c.name, async () => {
      up.set(c.upstream);
      const events = await collect(ai.llm.stream(Object.assign({ model: models()[c.protocol] }, userSays('x'))));
      const done = await O.toChatCompletion(events, { id: 'chatcmpl-1', model: 'opencode/x', created: 1700000000 });
      assert.equal(done.id, 'chatcmpl-1');
      assert.equal(done.object, 'chat.completion');
      assert.equal(done.created, 1700000000);
      assert.equal(done.model, 'opencode/x');
      assert.equal(done.choices.length, 1);
      const message = done.choices[0].message;
      if (c.message.tool_calls && c.message.tool_calls[0].id instanceof RegExp) {
        assert.match(message.tool_calls[0].id, c.message.tool_calls[0].id);
        c.message.tool_calls[0].id = message.tool_calls[0].id;
      }
      assert.deepEqual(message, c.message);
      assert.equal(done.choices[0].finish_reason, c.finish);
      if (c.usage) assert.deepEqual(done.usage, c.usage);

      // the same events, streamed
      const chunks = await collect(O.toChunks(events, { id: 'chatcmpl-1', model: 'opencode/x', created: 1700000000, includeUsage: true }));
      for (const k of chunks) {
        assert.equal(k.id, 'chatcmpl-1');
        assert.equal(k.model, 'opencode/x');
        assert.equal(k.created, 1700000000);
      }
      assert.equal(chunks[0].choices[0].delta.role, 'assistant');
      const last = chunks[chunks.length - 1];
      assert.deepEqual(last.choices, [], 'the usage chunk comes last');
      const rebuilt = accumulate(chunks);
      assert.deepEqual(rebuilt.message, done.choices[0].message);
      assert.equal(rebuilt.finish_reason, done.choices[0].finish_reason);
      assert.deepEqual(rebuilt.usage, done.usage === undefined ? null : done.usage);
      const withoutUsage = await collect(O.toChunks(events, { model: 'opencode/x' }));
      assert.ok(withoutUsage.every(k => k.choices.length === 1), 'no usage chunk unless asked');
      assert.match(withoutUsage[0].id, /^chatcmpl-[0-9a-f]{24}$/);
    });
  }
});

test('the converters: authoritative end texts, ids, a live stream', async () => {
  const events = [
    { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', text: 'Hel' }, { type: 'text-end', id: 't', text: 'Hello!' },
    { type: 'reasoning-delta', id: 'r', text: 'hm' }, { type: 'reasoning-end', id: 'r', text: 'hmm' },
    { type: 'tool-input-start', id: 'c1', name: 'f' }, { type: 'tool-call', id: 'c1', name: 'f', input: { a: 1 } },
    { type: 'tool-call', id: 'srv', name: 'web', input: {}, providerExecuted: true },
    { type: 'finish', reason: { normalized: 'unknown' } }
  ];
  const done = await O.toChatCompletion(events, { model: 'm' });
  assert.match(done.id, /^chatcmpl-/);
  assert.deepEqual(done.choices[0].message, { role: 'assistant', content: 'Hello!', reasoning_content: 'hmm', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] });
  assert.equal(done.choices[0].finish_reason, 'stop', 'unknown → stop');
  assert.equal('usage' in done, false, 'no usage when the upstream gave none');
  const rebuilt = accumulate(await collect(O.toChunks(events, { model: 'm' })));
  assert.deepEqual(rebuilt.message, done.choices[0].message);
  const errorFinish = await O.toChatCompletion([{ type: 'finish', reason: { normalized: 'error' } }], { model: 'm' });
  assert.deepEqual(errorFinish.choices[0], { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null });
  const empty = await collect(O.toChunks([], { model: 'm' }));
  assert.equal(empty.length, 2, 'a role chunk and a finish, even without events');
  assert.equal(empty[1].choices[0].finish_reason, 'stop');
  assert.notEqual(O.newCompletionId(), O.newCompletionId());

  // a live stream: chunks come as the upstream sends them
  up.set((q, r) => sse(r, [chunk({ role: 'assistant', content: 'a' }), chunk({ content: 'b' }), chunk({ content: 'c' }, 'stop')], { delayMs: 120 }));
  const t0 = Date.now();
  const times = [];
  for await (const k of O.toChunks(ai.llm.stream(Object.assign({ model: chatModel() }, userSays('x'))), { model: 'm' })) {
    if (k.choices[0] && k.choices[0].delta.content) times.push(Date.now() - t0);
  }
  assert.equal(times.length, 3);
  assert.ok(times[2] - times[0] >= 150, 'incremental: ' + times.join(', '));
});

// ── Errors ────────────────────────────────────────────────────────────────────

const ERRORS = [
  ['400 bad parameter', reply(400, { error: { message: 'Unsupported parameter: \'foo\'', type: 'invalid_request_error', code: 'unsupported_parameter' } }), { status: 400, type: 'invalid_request', upstreamStatus: 400, message: /couldn't process the request: "Unsupported parameter: 'foo'"/ }],
  ['400 context too long', reply(400, { error: { message: 'This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.', code: 'context_length_exceeded' } }), { status: 400, type: 'invalid_request', code: 'context_length_exceeded', message: /too long for the model "opencode\/m"/ }],
  ['400 model doesn\'t exist', reply(400, { error: { message: 'The model `m` does not exist' } }), { status: 404, type: 'model_not_found', upstreamStatus: 400 }],
  ['401', reply(401, { error: { message: 'Incorrect API key provided: ' + KEY } }), { status: 401, type: 'authentication_error', message: /didn't accept the API key/ }],
  ['402', reply(402, { error: { message: 'Insufficient balance' } }), { status: 429, type: 'quota_exceeded', scope: 'provider' }],
  ['403 JSON', reply(403, { error: { message: 'This key may not use model m', type: 'permission_error' } }), { status: 403, type: 'permission_error', message: /refused this request \("This key may not use model m"\) for the model "opencode\/m"/ }],
  ['403 web page', reply(403, page('Attention Required! | Cloudflare'), {}, 'text/html'), { status: 403, type: 'blocked', code: 'web_page', message: /A web page answered \(HTTP 403\)/ }],
  ['404', reply(404, { error: { message: 'model_not_found', code: 'model_not_found' } }), { status: 404, type: 'model_not_found', message: /doesn't offer the model "opencode\/m"/ }],
  ['408', reply(408, { error: { message: 'Request timeout' } }), { status: 502, type: 'upstream_error', upstreamStatus: 408 }],
  ['413 nginx page', reply(413, '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body><center><h1>413 Request Entity Too Large</h1></center><hr><center>nginx</center></body></html>', {}, 'text/html'), { status: 413, type: 'request_too_large', message: /too large for OpenCode Zen/ }],
  ['422', reply(422, { detail: 'messages.0.content: field required' }), { status: 400, type: 'invalid_request', upstreamStatus: 422, message: /messages\.0\.content: field required/ }],
  ['429 Retry-After in seconds', reply(429, { error: { message: 'Rate limit reached for requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '7', 'x-ratelimit-remaining-requests': '0' }), { status: 429, type: 'rate_limited', scope: 'model', retryAfterSeconds: 7, message: /rate-limiting the model "opencode\/m" right now.*in 7 seconds/ }],
  ['429 retry-after-ms', reply(429, { error: { message: 'Too many requests' } }, { 'retry-after-ms': '1500' }), { status: 429, type: 'rate_limited', scope: 'model', retryAfterSeconds: 2 }],
  ['429 Retry-After as a date', () => reply(429, { error: { message: 'slow down' } }, { 'retry-after': new Date(Date.now() + 30000).toUTCString() }), { status: 429, type: 'rate_limited', scope: 'model', retryAfterSeconds: [28, 31] }],
  ['429 without Retry-After', reply(429, { error: { message: 'slow down' } }), { status: 429, type: 'rate_limited', scope: 'model', retryAfterSeconds: undefined, message: /Try again in a moment/ }],
  ['429 insufficient_quota', reply(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, { 'retry-after': '3600' }), { status: 429, type: 'quota_exceeded', scope: 'provider', retryAfterSeconds: 3600, message: /usage limit is used up \("You exceeded your current quota"\)\. It resets in 60 minutes\./ }],
  ['429 Zen FreeUsageLimitError', reply(429, { type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' } }, { 'retry-after': '3600' }), { status: 429, type: 'quota_exceeded', scope: 'provider', retryAfterSeconds: 3600, message: /^OpenCode Zen's usage limit is used up/ }],
  ['429 Zen BudgetLimitError', reply(429, { type: 'error', error: { type: 'BudgetLimitError', message: 'Monthly budget reached', metadata: { coverage: 'workspace' } } }), { status: 429, type: 'quota_exceeded', scope: 'provider', retryAfterSeconds: undefined, message: /usage limit is used up \("Monthly budget reached"\)\. Try again later\./ }],
  ['500', reply(500, { error: { message: 'Internal error', type: 'server_error' } }), { status: 502, type: 'upstream_error', upstreamStatus: 500, message: /server problem \(HTTP 500\) \("Internal error"\)/ }],
  ['502 web page', reply(502, page('502 Bad Gateway'), {}, 'text/html'), { status: 502, type: 'upstream_error', upstreamStatus: 502 }],
  ['503 Retry-After', reply(503, { error: { message: 'Service temporarily unavailable' } }, { 'retry-after': '20' }), { status: 502, type: 'upstream_error', upstreamStatus: 503, retryAfterSeconds: 20 }],
  ['504 text', reply(504, 'upstream request timeout', {}, 'text/plain'), { status: 502, type: 'upstream_error', upstreamStatus: 504, message: /upstream request timeout/ }],
  ['200 web page', reply(200, page('Welcome'), {}, 'text/html'), { status: 502, type: 'malformed_response', upstreamStatus: 200, message: /couldn't read \(the answer ended before it was complete\)/ }],
  ['200 SSE with a bad JSON line', (q, r) => sse(r, ['{not json']), { status: 502, type: 'malformed_response', message: /wasn't valid JSON/ }],
  ['error event in the middle of the stream', (q, r) => sse(r, [chunk({ role: 'assistant', content: 'par' }), { error: { message: 'Upstream overloaded', code: 503, type: 'server_error' } }]), { status: 502, type: 'upstream_error', upstreamStatus: 503, message: /\("Upstream overloaded"\)/ }],
  ['redirect', reply(302, '', { location: 'https://login.example.org/sso?next=1' }), { status: 502, type: 'malformed_response', code: 'redirect', upstreamStatus: 302, message: /redirect \(HTTP 302\) to login\.example\.org/ }]
];

function checkError(err, want, label) {
  assert.ok(E.isServiceError(err), label);
  for (const [k, v] of Object.entries(want)) {
    if (k === 'message') assert.match(err.message, v, label + ': ' + err.message);
    else if (Array.isArray(v)) assert.ok(err[k] >= v[0] && err[k] <= v[1], label + ': ' + k + ' = ' + err[k]);
    else assert.equal(err[k], v, label + ': ' + k);
  }
  assert.equal(err.provider, 'opencode', label);
  assert.equal(err.model, 'opencode/m', label);
  assert.ok(err.message.length <= 400, label);
  assert.ok(!err.message.includes(KEY) && !/<|Bearer\s+[^[]/.test(err.message), label + ': nothing secret or HTML: ' + err.message);
  assert.ok(!err.message.includes('http://') && !err.message.includes(up.base), label + ': no URLs');
  const body = err.toBody();
  assert.equal(body.error.type, err.type);
  assert.equal(body.error.message, err.message);
  if (err.retryAfterSeconds !== undefined) {
    assert.equal(body.error.retry_after_seconds, err.retryAfterSeconds);
    assert.deepEqual(err.toHeaders(), { 'Retry-After': String(err.retryAfterSeconds) });
  }
  if (err.upstreamStatus !== undefined) assert.equal(body.error.upstream_status, err.upstreamStatus);
}

test('errors: upstream failures become ServiceErrors (one upstream request each)', async t => {
  for (const [label, handler, want] of ERRORS) {
    await t.test(label, async () => {
      up.set(label.includes('as a date') ? handler() : handler);
      const err = await failure(ai, chatModel());
      checkError(err, want, label);
      assert.equal(up.state.seen.length, 1, 'never retried');
      if (want.type === 'quota_exceeded' && want.retryAfterSeconds) {
        assert.ok(Math.abs(Date.parse(err.resetAt) - (Date.now() + want.retryAfterSeconds * 1000)) < 5000, 'reset_at: ' + err.resetAt);
      }
    });
  }
  await t.test('the same on the Anthropic protocol', async () => {
    up.set(reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }, { 'retry-after': '12' }));
    checkError(await failure(ai, models().anthropic), { status: 429, type: 'rate_limited', scope: 'model', retryAfterSeconds: 12 }, 'anthropic 429');
    up.set((q, r) => named(r, [{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'c', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]));
    checkError(await failure(ai, models().anthropic), { status: 502, type: 'upstream_error' }, 'anthropic overloaded');
  });
  await t.test('hints and provider names', async () => {
    up.set(reply(401, { error: { message: 'bad key' } }));
    const err = await failure(ai, chatModel(), undefined, undefined, { provider: 'emis', providerName: 'AI gateway', model: 'emis/m', hint: { authentication_error: 'Check EMIS_API_KEY in .env, then click Reload .env.', default: 'unused' } });
    assert.equal(err.message, 'AI gateway didn\'t accept the API key ("bad key"). Check EMIS_API_KEY in .env, then click Reload .env.');
    assert.equal(err.provider, 'emis');
    up.set(reply(500, {}));
    const plain = await failure(ai, chatModel(), undefined, undefined, { hint: 'See the status page.' });
    assert.match(plain.message, /\. Try again in a moment\. See the status page\.$/);
  });
});

test('errors: connection failures, timeouts and cancelling', async t => {
  await t.test('connection refused', async () => {
    const tmp = http.createServer();
    await new Promise(r => tmp.listen(0, '127.0.0.1', r));
    const port = tmp.address().port;
    await new Promise(r => tmp.close(r));
    const model = pkg.chat.model('m', { apiKey: KEY, baseURL: 'http://127.0.0.1:' + port + '/v1', provider: 'opencode' });
    checkError(await failure(ai, model), { status: 502, type: 'network', code: 'ECONNREFUSED', message: /refused the connection/ }, 'refused');
  });
  await t.test('connection reset mid-stream', async () => {
    up.set((q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: 'Hel' })) + '\n\n');
      setTimeout(() => res.socket.destroy(), 50);
    });
    checkError(await failure(ai, chatModel()), { status: 502, type: 'network', code: 'UND_ERR_SOCKET', message: /dropped before it finished/ }, 'reset');
  });
  await t.test('no response headers in time', async () => {
    up.set(() => {});
    const t0 = Date.now();
    checkError(await failure(ai, chatModel(), Object.assign(userSays('x'), { http: { headerTimeout: 300 } })), { status: 504, type: 'timeout', code: 'Timeout', message: /^OpenCode Zen didn't start answering in time\. Try again; if this keeps happening, raise AI_TIMEOUT_MS in \.env\.$/ }, 'header timeout');
    assert.ok(Date.now() - t0 < 2000);
  });
  await t.test('the answer stalls', async () => {
    up.set((q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: 'Hel' })) + '\n\n'); });
    checkError(await failure(ai, chatModel(), Object.assign(userSays('x'), { http: { chunkTimeout: 300 } })), { status: 504, type: 'timeout', message: /stalled/ }, 'chunk timeout');
  });
  await t.test('the whole answer takes too long', async () => {
    up.set((q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => { if (res.destroyed) clearInterval(timer); else res.write('data: ' + JSON.stringify(chunk({ content: '.' })) + '\n\n'); }, 50);
      res.on('close', () => clearInterval(timer));
    });
    checkError(await failure(ai, chatModel(), Object.assign(userSays('x'), { http: { timeout: 500 } })), { status: 504, type: 'timeout', message: /took too long/ }, 'total timeout');
  });
  await t.test('cancelled while waiting', async () => {
    let closed = false;
    up.set((q, res) => { res.on('close', () => { closed = true; }); });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    checkError(await failure(ai, chatModel(), undefined, { signal: ac.signal }), { status: 499, type: 'cancelled' }, 'abort');
    await sleep(100);
    assert.equal(closed, true, 'the upstream request was closed');
  });
  await t.test('cancelled mid-stream', async () => {
    let closed = false;
    up.set((q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write('data: ' + JSON.stringify(chunk({ content: '.' })) + '\n\n'), 30);
      res.on('close', () => { closed = true; clearInterval(timer); });
    });
    const ac = new AbortController();
    let n = 0, caught;
    try {
      for await (const k of O.toChunks(ai.llm.stream(Object.assign({ model: chatModel() }, userSays('x')), { signal: ac.signal }), { model: 'm' })) {
        if (k.choices[0].delta.content && ++n === 3) ac.abort();
      }
    } catch (e) { caught = e; }
    checkError(E.fromAIError(caught, Object.assign({ signal: ac.signal }, ZEN)), { status: 499, type: 'cancelled' }, 'abort mid-stream');
    await sleep(100);
    assert.equal(closed, true);
  });
});

test('errors: ServiceError, other throws and redact', () => {
  const e = new E.ServiceError(undefined, 'quota_exceeded', 'Used up.', { scope: 'provider', retryAfterSeconds: 60, resetAt: '2026-10-26T12:00:00.000Z', window: 'week', provider: 'emis', log: 'not sent', cause: new Error('x') });
  assert.equal(e.status, 429);
  assert.ok(e instanceof Error);
  assert.deepEqual(e.toBody(), { error: { message: 'Used up.', type: 'quota_exceeded', provider: 'emis', scope: 'provider', retry_after_seconds: 60, reset_at: '2026-10-26T12:00:00.000Z', window: 'week' } });
  assert.deepEqual(new E.ServiceError(418, 'invalid_request', 'x').toBody(), { error: { message: 'x', type: 'invalid_request' } });
  assert.equal(new E.ServiceError(418, 'invalid_request', 'x').status, 418);
  assert.equal(new E.ServiceError(undefined, 'not_configured', 'x').status, 503);
  assert.equal(new E.ServiceError(undefined, 'something_else', 'x').status, 500);
  assert.equal(new E.ServiceError(400, 'invalid_request', 'y'.repeat(1000)).message.length, 400);
  assert.deepEqual(new E.ServiceError(400, 'invalid_request', 'x').toHeaders(), {});
  for (const [type, status] of Object.entries({ invalid_request: 400, unsupported_feature: 400, authentication_error: 401, permission_error: 403, blocked: 403, model_not_found: 404, not_configured: 503, request_too_large: 413, rate_limited: 429, quota_exceeded: 429, cancelled: 499, upstream_error: 502, malformed_response: 502, network: 502, timeout: 504, internal_error: 500 })) {
    assert.equal(E.TYPE_STATUS[type], status, type);
  }

  assert.equal(E.fromAIError(e, { provider: 'x' }), e, 'a ServiceError stays as it is');
  const bug = E.fromAIError(new TypeError('cannot read properties of undefined (reading \'' + KEY + '\')'), Object.assign({ secrets: [KEY] }, ZEN));
  assert.equal(bug.status, 500);
  assert.equal(bug.type, 'internal_error');
  assert.match(bug.message, /unexpected problem with OpenCode Zen\. The details are in the service's log\./);
  assert.ok(bug.log.includes('cannot read properties') && !bug.log.includes(KEY));
  const reset = E.fromAIError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), ZEN);
  assert.equal(reset.type, 'network');
  assert.equal(reset.code, 'ECONNRESET');
  const abort = E.fromAIError(new DOMException('This operation was aborted', 'AbortError'), ZEN);
  assert.equal(abort.status, 499);
  const custom = new AbortController();
  custom.abort(new Error('client went away'));
  assert.equal(E.fromAIError(custom.signal.reason, Object.assign({ signal: custom.signal }, ZEN)).type, 'cancelled', 'a custom abort reason');
  assert.equal(E.fromAIError(new DOMException('The operation timed out.', 'TimeoutError'), ZEN).status, 504);
  assert.equal(E.fromAIError({ _tag: 'ProviderConfiguration', provider: 'anthropic', message: 'Anthropic apiKey cannot be combined with authToken' }, ZEN).type, 'not_configured');
  assert.equal(E.fromAIError(undefined).type, 'internal_error', 'never throws');

  assert.equal(E.redact('key ' + KEY + ' and emis-abcdef123456 and Bearer abc.def', [KEY]), 'key [redacted] and [redacted key] and Bearer [redacted]');
  assert.equal(E.redact('sk-live-1234567890 here'), '[redacted key] here');
  assert.equal(E.redact('see https://user:pw@api.example.com:8443/v1/chat?key=s3cret now'), 'see api.example.com:8443 now');
  assert.equal(E.redact('bad http://[broken now'), 'bad [url] now');
  assert.equal(E.redact('line\none\u0000\ttwo   three'), 'line one two three');
  assert.equal(E.redact('task-12345 stays'), 'task-12345 stays', 'only whole-word key prefixes');
  assert.equal(E.redact('x'.repeat(50), [], 10), 'xxxxxxxxx…');
  assert.equal(E.redact(null), '');
});

// ── createAI ──────────────────────────────────────────────────────────────────

function startProxy() {
  const log = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => {        // plain HTTP forwarding (absolute URL)
    log.push({ kind: 'forward', target: req.url });
    const u = new URL(req.url);
    const fwd = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    fwd.on('error', () => res.destroy());
    req.pipe(fwd);
  });
  srv.on('connect', (req, socket, head) => {            // CONNECT tunnels
    log.push({ kind: 'connect', target: req.url, auth: req.headers['proxy-authorization'] });
    const [host, port] = req.url.split(':');
    const target = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    sockets.add(socket); sockets.add(target);
  });
  srv.on('connection', s => sockets.add(s));
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + srv.address().port, log,
    close: () => new Promise(r => { sockets.forEach(s => s.destroy()); srv.close(r); })
  })));
}

test('createAI: no trace headers, MetaCode\'s User-Agent, middleware order, proxy setting', async () => {
  up.set(replies.chat);
  await O.toChatCompletion(ai.llm.stream(Object.assign({ model: chatModel() }, userSays('x'))), { model: 'm' });
  const h = up.state.seen[0].headers;
  assert.equal(h.traceparent, undefined);
  assert.equal(h.b3, undefined);
  assert.equal(h['user-agent'], H.USER_AGENT);
  assert.match(H.USER_AGENT, /^opencode\/metacode\/\d+\.\d+\.\d+\/metacode$/);
  assert.equal(H.OPENCODE_AI_VERSION, require('../node_modules/@opencode/ai/package.json').version);

  const custom = H.createAI({ userAgent: 'MetaCode/1.0 (test)' });
  try {
    up.set(replies.chat);
    await O.toChatCompletion(custom.llm.stream(Object.assign({ model: chatModel() }, userSays('x'))), { model: 'm' });
    assert.equal(up.state.seen[0].headers['user-agent'], 'MetaCode/1.0 (test)');
    up.set(replies.chat);
    await O.toChatCompletion(custom.llm.stream(Object.assign({ model: chatModel() }, userSays('x'), { http: { headers: { 'User-Agent': 'per-request/2' } } })), { model: 'm' });
    assert.equal(up.state.seen[0].headers['user-agent'], 'per-request/2', 'a request\'s own User-Agent wins');
  } finally { await custom.dispose(); }

  // middleware order: the first in the list is outermost
  const order = [];
  const tracer = name => (request, next) => {
    order.push(name + ' request');
    return next(request).pipe(effect.Effect.tap(() => effect.Effect.sync(() => order.push(name + ' response'))));
  };
  const effect = await import('effect');
  const ordered = H.createAI({ middleware: [tracer('a'), tracer('b')] });
  try {
    up.set(replies.chat);
    await O.toChatCompletion(ordered.llm.stream(Object.assign({ model: chatModel() }, userSays('x'))), { model: 'm' });
    assert.deepEqual(order, ['a request', 'b request', 'b response', 'a response']);
  } finally { await ordered.dispose(); }
  assert.throws(() => H.createAI({ proxy: 'socks5://nope' }), err => err.type === 'not_configured' && /proxy setting/.test(err.message));
});

test('createAI: an explicit proxy URL, and the env proxy with NO_PROXY', async () => {
  const proxy = await startProxy();
  const viaProxy = async client => {
    up.set(replies.chat);
    const before = proxy.log.length;
    const done = await O.toChatCompletion(client.llm.stream(Object.assign({ model: chatModel() }, userSays('x'))), { model: 'm' });
    assert.equal(done.choices[0].message.content, 'Hello');
    assert.equal(up.state.seen.length, 1);
    return proxy.log.slice(before);
  };
  const saved = {};
  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) saved[k] = process.env[k];
  try {
    let client = H.createAI({ proxy: proxy.url });
    try {
      const used = await viaProxy(client);
      assert.equal(used.length, 1, 'through the proxy');
      assert.equal(used[0].kind, 'connect', 'undici tunnels through the proxy');
      assert.equal(used[0].target.replace(/^http:\/\//, '').replace(/\/.*$/, ''), up.host);
    } finally { await client.dispose(); }

    client = H.createAI({ proxy: 'env', env: { HTTP_PROXY: proxy.url, NO_PROXY: '' } });
    try { assert.equal((await viaProxy(client)).length, 1, 'HTTP_PROXY used'); } finally { await client.dispose(); }
    client = H.createAI({ proxy: 'env', env: { http_proxy: proxy.url, NO_PROXY: 'localhost,127.0.0.1' } });
    try { assert.equal((await viaProxy(client)).length, 0, 'NO_PROXY honoured'); } finally { await client.dispose(); }
    client = H.createAI({ proxy: 'env', env: {} });
    try { assert.equal((await viaProxy(client)).length, 0, 'no proxy set: direct'); } finally { await client.dispose(); }

    // by default from process.env; and no proxy at all unless asked
    process.env.HTTP_PROXY = process.env.http_proxy = proxy.url;
    process.env.NO_PROXY = process.env.no_proxy = 'example.invalid';
    client = H.createAI({ proxy: 'env' });
    try { assert.equal((await viaProxy(client)).length, 1, 'process.env HTTP_PROXY'); } finally { await client.dispose(); }
    client = H.createAI();
    try { assert.equal((await viaProxy(client)).length, 0, 'without proxy: direct'); } finally { await client.dispose(); }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await proxy.close();
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────

test('captureMiddleware: status and headers of a tagged request; the tag never goes upstream', async () => {
  const capture = H.captureMiddleware();
  const client = H.createAI({ middleware: capture.middleware });
  try {
    up.set((q, r) => sse(r, hello(), { headers: { 'x-ratelimit-remaining-prompts': '41', 'x-ratelimit-reset': '1893456000', 'x-ratelimit-window': 'week' } }));
    let atFirstEvent;
    for await (const e of client.llm.stream(Object.assign({ model: chatModel() }, userSays('x'), { http: { headers: capture.tag('attempt-1') } }))) {
      if (!atFirstEvent) atFirstEvent = { type: e.type, captured: capture.take('attempt-1') };
    }
    assert.equal(atFirstEvent.captured.status, 200, 'there by the first event');
    assert.equal(atFirstEvent.captured.headers['x-ratelimit-remaining-prompts'], '41');
    assert.equal(atFirstEvent.captured.headers['x-ratelimit-window'], 'week');
    assert.equal(up.state.seen[0].headers[H.CAPTURE_HEADER], undefined, 'the tag header is removed');
    assert.equal(capture.take('attempt-1'), undefined, 'take() forgets');
    assert.deepEqual(capture.tag('x'), { [H.CAPTURE_HEADER]: 'x' });

    up.set(reply(429, { error: { message: 'budget used up' } }, { 'x-ratelimit-remaining-prompts': '0', 'retry-after': '9' }));
    const err = await failure(client, chatModel(), Object.assign(userSays('x'), { http: { headers: capture.tag('attempt-2') } }));
    assert.equal(err.type, 'rate_limited');
    assert.deepEqual([capture.take('attempt-2').status, capture.take('attempt-2')], [429, undefined]);

    up.set(replies.chat);
    await O.toChatCompletion(client.llm.stream(Object.assign({ model: chatModel() }, userSays('x'))), { model: 'm' });
    assert.equal(up.state.seen.length, 1, 'untagged requests pass');
  } finally { await client.dispose(); }
});

test('substituteMiddleware: marked requests answered another way (buffered or streamed)', async t => {
  const MARK = 'x-oc-transport';
  const calls = [];
  let answer;
  const substitute = H.substituteMiddleware(MARK, async req => {
    calls.push(req);
    return answer(req);
  });
  const capture = H.captureMiddleware();
  const client = H.createAI({ middleware: [capture.middleware, H.chatShims(), substitute] });
  const marked = () => chatModel(null, { headers: { [MARK]: 'python' } });
  const sseText = parts => parts.map(p => 'data: ' + JSON.stringify(p) + '\n\n').join('') + 'data: [DONE]\n\n';
  try {
    await t.test('buffered answer', async () => {
      calls.length = 0;
      up.set(replies.chat);
      answer = () => new Response(sseText(hello()), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-ratelimit-remaining-prompts': '12' } });
      const done = await O.toChatCompletion(client.llm.stream(Object.assign({ model: marked() }, userSays('hi'), { http: { headers: capture.tag('s1') } })), { model: 'emis/m' });
      assert.equal(done.choices[0].message.content, 'Hello');
      assert.deepEqual(done.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      assert.equal(up.state.seen.length, 0, 'the network wasn\'t used');
      assert.equal(calls.length, 1);
      const c = calls[0];
      assert.equal(c.method, 'POST');
      assert.equal(c.url, up.base + '/v1/chat/completions');
      assert.equal(c.marker, 'python');
      assert.equal(c.headers.authorization, 'Bearer ' + KEY);
      assert.equal(c.headers[MARK], undefined, 'the marker is removed');
      assert.equal(c.headers[H.CAPTURE_HEADER], undefined);
      assert.equal(c.json.stream, true);
      assert.deepEqual(c.json.messages, [{ role: 'user', content: 'hi' }]);
      assert.equal(typeof c.body, 'string');
      assert.ok(c.signal instanceof AbortSignal);
      assert.equal(capture.take('s1').headers['x-ratelimit-remaining-prompts'], '12', 'capture sees substituted answers');
    });
    await t.test('a plain JSON answer from the substitute (the shims make it SSE)', async () => {
      answer = () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      const done = await O.toChatCompletion(client.llm.stream(Object.assign({ model: marked() }, userSays('hi'))), { model: 'emis/m' });
      assert.equal(done.choices[0].message.content, 'plain');
    });
    await t.test('null → the network after all, without the marker', async () => {
      up.set(replies.chat);
      answer = () => null;
      const done = await O.toChatCompletion(client.llm.stream(Object.assign({ model: marked() }, userSays('hi'))), { model: 'emis/m' });
      assert.equal(done.choices[0].message.content, 'Hello');
      assert.equal(up.state.seen.length, 1);
      assert.equal(up.state.seen[0].headers[MARK], undefined);
    });
    await t.test('a substituted 401 and a substitute that fails', async () => {
      answer = () => new Response('{"error":{"message":"Invalid key"}}', { status: 401, headers: { 'content-type': 'application/json' } });
      assert.equal((await failure(client, marked())).type, 'authentication_error');
      answer = () => { throw Object.assign(new Error('python worker: connection reset'), { code: 'ECONNRESET' }); };
      const err = await failure(client, marked());
      assert.equal(err.type, 'network');
      assert.equal(err.code, 'ECONNRESET');
    });
    await t.test('streamed answer arrives as it is written; cancelling reaches the substitute', async () => {
      const lines = [chunk({ role: 'assistant', content: 'a' }), chunk({ content: 'b' }), chunk({ content: 'c' }, 'stop')];
      answer = () => new Response(new ReadableStream({
        async start(ctl) {
          for (const l of lines) { await sleep(150); ctl.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(l) + '\n\n')); }
          ctl.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          ctl.close();
        }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const t0 = Date.now();
      const times = [];
      for await (const e of client.llm.stream(Object.assign({ model: marked() }, userSays('x')))) if (e.type === 'text-delta') times.push(Date.now() - t0);
      assert.equal(times.length, 3);
      assert.ok(times[0] < times[2] - 200, 'incremental: ' + times.join(', '));

      let aborted = false;
      answer = req => new Promise(() => { req.signal.addEventListener('abort', () => { aborted = true; }); });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      const err = await failure(client, marked(), undefined, { signal: ac.signal });
      assert.equal(err.type, 'cancelled');
      await sleep(50);
      assert.equal(aborted, true);
    });
  } finally { await client.dispose(); }
});

test('chatShims: odd chat upstreams become readable', async t => {
  const shimmed = H.createAI({ middleware: H.chatShims() });
  // like the OpenAI-compatible provider: max_tokens, and no finish_reason needed
  const lenient = () => chatModel({ maxTokensField: 'max_tokens', requireFinishReason: false });
  const answer = async (client, model, input) => O.toChatCompletion(client.llm.stream(Object.assign({ model: model || lenient() }, input || userSays('x'))), { model: 'emis/m' });
  try {
    await t.test('plain JSON on a streamed call → SSE (text, reasoning, usage, finish)', async () => {
      up.set(reply(200, { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Plain answer', reasoning_content: 'Because.' }, finish_reason: 'length' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }));
      const done = await answer(shimmed);
      assert.deepEqual(done.choices[0].message, { role: 'assistant', content: 'Plain answer', reasoning_content: 'Because.' });
      assert.equal(done.choices[0].finish_reason, 'length');
      assert.deepEqual(done.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
      // a non-streamed upstream call (stream: false in the body) works the same way
      up.set(reply(200, { choices: [{ index: 0, message: { role: 'assistant', content: 'not streamed' }, finish_reason: 'stop' }] }));
      const forced = await answer(shimmed, chatModel({ streamUsage: false }), Object.assign(userSays('x'), { http: { body: { stream: false } } }));
      assert.equal(forced.choices[0].message.content, 'not streamed');
      assert.equal(up.state.seen[0].body.stream, false);
      assert.equal('stream_options' in up.state.seen[0].body, false);
    });
    await t.test('plain JSON with tool calls', async () => {
      up.set(reply(200, { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }, { id: 'c2', type: 'function', function: { name: 'g', arguments: { b: 2 } } }] }, finish_reason: 'tool_calls' }] }));
      const done = await answer(shimmed, chatModel());
      assert.deepEqual(done.choices[0].message.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }, { id: 'c2', type: 'function', function: { name: 'g', arguments: '{"b":2}' } }]);
      assert.equal(done.choices[0].finish_reason, 'tool_calls');
    });
    await t.test('the other whole answers MetaCode read before: wrapped in {data}, Responses API, Anthropic, Ollama, plain text fields', async () => {
      const cases = [
        [{ data: { choices: [{ index: 0, message: { role: 'assistant', content: 'wrapped' }, finish_reason: 'stop' }] } }, 'wrapped', 'stop'],
        [{ id: 'resp_1', object: 'response', status: 'completed', output_text: 'output text' }, 'output text', 'stop'],
        [{ object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'Cut ' }, { type: 'output_text', text: 'short' }] }] }, 'Cut short', 'length'],
        [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'From Claude' }], stop_reason: 'max_tokens' }, 'From Claude', 'length'],
        [{ model: 'llama', message: { role: 'assistant', content: 'From Ollama' }, done: true }, 'From Ollama', 'stop'],
        [{ response: 'Plain response' }, 'Plain response', 'stop'],
        [{ data: { text: 'Wrapped text' } }, 'Wrapped text', 'stop']
      ];
      for (const [json, text, finish] of cases) {
        up.set(reply(200, json));
        const done = await answer(shimmed);
        assert.deepEqual([done.choices[0].message.content, done.choices[0].finish_reason], [text, finish], JSON.stringify(json));
      }
      up.set(reply(200, { output_text: 'counted', usage: { input_tokens: 4, output_tokens: 2 } }));
      assert.deepEqual((await answer(shimmed)).usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, 'Responses usage as chat usage');
      up.set(reply(200, { data: { error: 'not this' } }));
      checkError(await failure(shimmed, lenient()), { type: 'malformed_response', code: 'unreadable' }, 'nothing readable inside {data}');
      // streamed: the Responses API's events, Anthropic's events
      const named = events => (q, r) => { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.end(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('')); };
      up.set(named([
        { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [] } },
        { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
        { type: 'response.output_text.delta', delta: 'ok from ' },
        { type: 'response.output_text.delta', delta: 'responses sse' },
        { type: 'response.completed', response: { output_text: 'ok from responses sse', usage: { input_tokens: 3, output_tokens: 4 } } }
      ]));
      let done = await answer(shimmed);
      assert.deepEqual([done.choices[0].message.content, done.choices[0].finish_reason, done.usage.total_tokens], ['ok from responses sse', 'stop', 7]);
      up.set(named([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'only at the end' }] }] } }]));
      assert.equal((await answer(shimmed)).choices[0].message.content, 'only at the end', 'the final response when no deltas came');
      up.set(named([
        { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'From ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
        { type: 'message_stop' }
      ]));
      done = await answer(shimmed);
      assert.deepEqual([done.choices[0].message.content, done.choices[0].finish_reason], ['From Claude', 'length']);
    });
    await t.test('a JSON error on 200 is an error', async () => {
      up.set(reply(200, { error: { message: 'The engine is overloaded', type: 'server_error' } }));
      checkError(await failure(shimmed, lenient()), { type: 'upstream_error', message: /The engine is overloaded/ }, 'json error on 200');
    });
    await t.test('a web page on 200 → 502 "a web page answered"', async () => {
      up.set(reply(200, page('Welcome to the gateway'), {}, 'text/html; charset=utf-8'));
      const err = await failure(shimmed, lenient());
      checkError(err, { status: 502, type: 'malformed_response', code: 'web_page', upstreamStatus: 200, message: new RegExp('^A web page answered \\(HTTP 200\\) instead of OpenCode Zen\'s API at ' + up.host.replace(/\./g, '\\.')) }, 'html 200');
      up.set(reply(200, '\n  <!doctype html><p>hi</p>', {}, 'text/event-stream'));
      checkError(await failure(shimmed, lenient()), { status: 502, type: 'malformed_response', code: 'web_page' }, 'html behind an SSE content type');
      // without the shims, a lenient model would take a web page for an empty answer
      up.set(reply(200, page('Welcome'), {}, 'text/html'));
      assert.equal((await answer(ai)).choices[0].message.content, '');
    });
    await t.test('empty and unreadable answers', async () => {
      up.set(reply(200, '', {}, 'text/event-stream'));
      checkError(await failure(shimmed, lenient()), { type: 'malformed_response', code: 'empty_reply', message: /sent an empty answer/ }, 'empty');
      up.set((q, r) => sse(r, []));
      checkError(await failure(shimmed, lenient()), { type: 'malformed_response', code: 'empty_reply' }, '[DONE] only');
      up.set(reply(200, 'hello there, not an API', {}, 'text/plain'));
      checkError(await failure(shimmed, lenient()), { type: 'malformed_response', code: 'unreadable' }, 'plain text');
      up.set(reply(200, { object: 'list', data: [] }));
      checkError(await failure(shimmed, lenient()), { type: 'malformed_response', code: 'unreadable' }, 'other JSON');
    });
    await t.test('an unknown finish_reason → stop (or its usual meaning)', async () => {
      for (const [raw, want] of [['eos', 'stop'], ['end_turn', 'stop'], ['STOP', 'stop'], ['max_tokens', 'length'], ['something_new', 'stop']]) {
        up.set((q, r) => sse(r, [chunk({ role: 'assistant', content: 'ok' }), chunk({}, raw)]));
        const done = await answer(shimmed, chatModel());
        assert.equal(done.choices[0].finish_reason, want, raw);
        assert.equal(done.choices[0].message.content, 'ok');
      }
      up.set((q, r) => sse(r, [chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'eos')]));
      checkError(await failure(ai, chatModel()), { type: 'malformed_response' }, 'without the shims: an error');
    });
    await t.test('images instead of text → [image omitted]', async () => {
      up.set(reply(200, { choices: [{ index: 0, message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] }, finish_reason: 'stop' }] }));
      assert.equal((await answer(shimmed)).choices[0].message.content, '[image omitted]');
      up.set((q, r) => sse(r, [chunk({ role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] }), chunk({}, 'stop')]));
      assert.equal((await answer(shimmed)).choices[0].message.content, '[image omitted]');
      up.set((q, r) => sse(r, [chunk({ role: 'assistant', content: 'A cat.' }), chunk({ images: [{ type: 'image_url' }] }), chunk({}, 'stop')]));
      assert.equal((await answer(shimmed)).choices[0].message.content, 'A cat.', 'with text: only the text');
      up.set((q, r) => sse(r, [chunk({ role: 'assistant', content: [{ type: 'text', text: 'Parts ' }, { type: 'output_image', url: 'x' }] }), chunk({}, 'stop')]));
      assert.equal((await answer(shimmed)).choices[0].message.content, 'Parts [image omitted]', 'content parts become text');
    });
    await t.test('streams stay streams through the shims', async () => {
      up.set((q, r) => sse(r, [chunk({ role: 'assistant', content: 'a' }), chunk({ content: 'b' }), chunk({ content: 'c' }, 'eos')], { delayMs: 150 }));
      const t0 = Date.now();
      const times = [];
      for await (const e of shimmed.llm.stream(Object.assign({ model: chatModel() }, userSays('x')))) if (e.type === 'text-delta') times.push(Date.now() - t0);
      assert.equal(times.length, 3);
      assert.ok(times[0] < times[2] - 200, 'incremental: ' + times.join(', '));

      // cancelling still reaches the upstream
      let closed = false;
      up.set((q, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const timer = setInterval(() => res.write('data: ' + JSON.stringify(chunk({ content: '.' })) + '\n\n'), 30);
        res.on('close', () => { closed = true; clearInterval(timer); });
      });
      const ac = new AbortController();
      let n = 0;
      await assert.rejects(async () => {
        for await (const e of shimmed.llm.stream(Object.assign({ model: chatModel() }, userSays('x')), { signal: ac.signal })) if (e.type === 'text-delta' && ++n === 2) ac.abort();
      }, e => E.fromAIError(e, { signal: ac.signal }).type === 'cancelled');
      await sleep(100);
      assert.equal(closed, true, 'the upstream request was closed');
    });
    await t.test('other protocols and errors pass untouched', async () => {
      up.set((q, r) => anthropicHello(r));
      const done = await answer(shimmed, models().anthropic);
      assert.equal(done.choices[0].message.content, 'Hello');
      up.set(reply(401, { error: { message: 'nope' } }));
      assert.equal((await failure(shimmed, chatModel())).type, 'authentication_error');
    });
  } finally { await shimmed.dispose(); }
});
