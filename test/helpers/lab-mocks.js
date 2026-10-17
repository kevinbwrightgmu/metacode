// A stand-in for MetaCode's AI service (OpenAI-style /v1/chat/completions and
// /v1/models) for the AI Coding Lab tests. Answers depend on the system
// prompt, so a profile that asks for ES modules gets `export function add`
// and one that doesn't gets a plain function — enough to make evaluations,
// suggestions and comparisons measurable. Not a model: it proves MetaCode's
// own code paths, not any provider's behaviour.
const http = require('http');

const PLAIN = '```js\nfunction add(a, b) {\n  return a + b;\n}\n```';
const MODULE = '```js\nexport function add(a, b) {\n  return a + b;\n}\n```';

function answerFor(sys, user) {
  if (/You improve the written instructions/.test(sys)) {
    return JSON.stringify({ summary: 'The tasks expect exported functions.', changes: [{ field: 'conventions', value: 'Use ES module exports: write `export function` for public functions.', reason: 'Every failure is a missing export.' }] });
  }
  if (/You grade answers/.test(sys)) return '{"score": 0.9, "reasons": "Meets the criteria."}';
  if (/Summarise this coding conversation/.test(sys)) return 'The user wants an add function; decided on plain JavaScript.';
  if (/ES module/.test(sys)) return 'Here it is:\n' + MODULE;
  return 'Here it is:\n' + PLAIN + (/slow/.test(user) ? '\n' + 'More text. '.repeat(40) : '');
}

// state: { requests: [], streamDelayMs: 0, fail: false } — read and changed by the tests
function startEmis(state) {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'lab-model' }, { id: 'judge-model' }] })); }
      const j = JSON.parse(body || '{}');
      state.requests.push(j);
      if (state.fail) { res.statusCode = 503; res.setHeader('content-type', 'application/json'); return res.end('{"error":{"message":"down"}}'); }
      const sys = j.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const user = j.messages.filter(m => m.role === 'user').slice(-1)[0].content;
      const content = answerFor(sys, user);
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const parts = content.match(/[\s\S]{1,12}/g);
        for (const p of parts) {
          if (res.destroyed) return;
          res.write('data: ' + JSON.stringify({ model: j.model, choices: [{ index: 0, delta: { content: p } }] }) + '\n\n');
          if (state.streamDelayMs) await new Promise(r => setTimeout(r, state.streamDelayMs));
        }
        res.write('data: ' + JSON.stringify({ model: j.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 111, completion_tokens: 22 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: j.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}

module.exports = { startEmis, answerFor, PLAIN, MODULE };
