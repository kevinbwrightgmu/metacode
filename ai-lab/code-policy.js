// @ts-check
// ── Deterministic policy for coding rules (Stage 3) and the output contract (Stage 5) ──
// A coding rule is a function classify(record, variable) written by an AI or a
// user. Before it runs in the sandbox, JavaScript and TypeScript are parsed
// here (acorn, on the server — the code is never executed here) and checked
// against fixed rules: no code built from strings, no globals that reach the
// host, no network, no timers, no prototype tricks, no obvious infinite loops,
// and the classify/1 contract. Python is checked by the same rules inside the
// sandbox (ai-lab/sandbox/lab-prelude.py), before any user code runs.
//
// The policy is authoritative: an error finding always blocks a run, whatever
// the AI security review said. It is one layer, not the boundary — the
// sandbox (separate process, WebAssembly engine, no host services) is.
//
// After a run, validateOutputs() checks every raw output against the
// classify/1 contract; only a run with zero problems has its results stored.

const crypto = require('crypto');
const acorn = require('acorn');
const walk = require('acorn-walk');
const nodeModule = /** @type {{ stripTypeScriptTypes?: (code: string, o: { mode: 'strip' }) => string }} */ (require('module'));
const { invalid } = require('./errors');

/** @typedef {import('../types/lab-experiments').CodeLanguage} CodeLanguage */
/** @typedef {import('../types/lab-experiments').PolicyFinding} PolicyFinding */
/** @typedef {import('../types/lab-experiments').PolicyReport} PolicyReport */
/** @typedef {import('../types/lab-experiments').RawRecordOutput} RawRecordOutput */
/** @typedef {import('../types/lab-experiments').RecordResult} RecordResult */
/** @typedef {import('../types/lab-experiments').OutputValidation} OutputValidation */
/** @typedef {import('../types/lab-experiments').SandboxVariable} SandboxVariable */

/** The version of these rules, recorded on every report and run. */
const POLICY_VERSION = 'policy-1';
/** The guest contract: classify(record, variable) → code id | null | {code, confidence?, reason?}. */
const CONTRACT = 'classify/1';

/**
 * Python modules a coding rule may import (checked inside the sandbox by
 * lab-prelude.py, and again at runtime by its guarded importer). This module
 * is the source of truth; ai-lab/code-sandbox.js re-exports it.
 */
const PYTHON_ALLOWED_MODULES = Object.freeze(['re', 'math', 'statistics', 'string', 'collections', 'itertools', 'functools', 'operator', 'json',
  'unicodedata', 'datetime', 'typing', 'dataclasses', 'enum', 'heapq', 'bisect', 'decimal', 'fractions', 'difflib', 'textwrap', 'html',
  'copy', 'numbers', 'abc', 'random', '__future__']);

const LIMITS = Object.freeze({
  /** Source size (UTF-8 bytes) and lines. */
  codeBytes: 100 * 1024,
  codeLines: 3000,
  /** A result's reason. */
  reasonChars: 500,
  /** A recorded per-record error message. */
  errorChars: 2000,
  /** Problems kept in OutputValidation (all are counted). */
  problemsKept: 50,
  /** Findings kept in a PolicyReport. */
  findingsKept: 200,
  excerptChars: 160,
  /** A string literal longer than this is reported as possible obfuscation. */
  longStringChars: 2000
});

/* ── JavaScript / TypeScript ─────────────────────────────────────────────── */

/** Globals a coding rule may not reference, with the reason given to the user. */
const GLOBAL_REASONS = /** @type {Record<string, string>} */ (Object.create(null));
/** @param {string[]} names @param {string} why */
const reason = (names, why) => names.forEach(n => { GLOBAL_REASONS[n] = why; });
reason(['eval', 'Function', 'AsyncFunction', 'GeneratorFunction'], 'coding rules can\'t create or run code built from strings.');
reason(['require', 'module', 'exports'], 'the sandbox has no modules: write everything in this file.');
reason(['process', 'globalThis', 'global', 'self', 'window', 'document', 'navigator'], 'coding rules can\'t reach the host environment or the global object.');
reason(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'], 'there is no network in the sandbox.');
reason(['Worker', 'SharedArrayBuffer', 'Atomics', 'WebAssembly'], 'coding rules can\'t start threads, share memory or load WebAssembly.');
reason(['Proxy', 'Reflect'], 'proxies and reflection aren\'t allowed (they are a common way to escape a sandbox).');
reason(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'], 'classify must be synchronous: there are no timers or queued callbacks.');
reason(['Deno', 'Bun'], 'host runtimes aren\'t available.');
const FORBIDDEN_GLOBALS = Object.freeze(Object.keys(GLOBAL_REASONS));

/** Properties whose access reaches constructors, prototypes or the call stack. */
const FORBIDDEN_PROPERTIES = Object.freeze(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__', 'caller', 'callee']);
/**
 * Also refused as a property name on any object (e.g. `this.eval`, `x.Function`):
 * these reach code generation however they are spelled.
 */
const FORBIDDEN_MEMBER_GLOBALS = ['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'globalThis', 'require', 'WebAssembly'];
const PROPERTY_SET = new Set(FORBIDDEN_PROPERTIES);
const MEMBER_GLOBAL_SET = new Set(FORBIDDEN_MEMBER_GLOBALS);

/**
 * Names that are also ordinary English words: a string mentioning them is only
 * reported as possible obfuscation when the string looks like code.
 */
const COMMON_WORDS = new Set(['process', 'module', 'exports', 'global', 'self', 'window', 'document', 'navigator', 'fetch', 'Worker',
  'prototype', 'caller', 'callee', 'Bun']);
const SUSPICIOUS_NAMES = FORBIDDEN_GLOBALS.concat(FORBIDDEN_PROPERTIES.filter(p => !GLOBAL_REASONS[p]));
const NAME_IN_STRING = new RegExp('(?<![A-Za-z0-9_$])(' + SUSPICIOUS_NAMES.map(n => n.replace(/\$/g, '\\$')).join('|') + '|__[A-Za-z0-9_$]+)(?![A-Za-z0-9_$])', 'g');
const LOOKS_LIKE_CODE = /[(){};=[\]]|=>|\breturn\s|[A-Za-z_$]\.[A-Za-z_$]/;
/** Calls that decode hidden text. */
const DECODERS = new Set(['atob', 'unescape', 'decodeURIComponent', 'decodeURI', 'escape']);

/** The sha256 (hex) of the exact code: what is stored, reviewed, run, selected and sent. @param {string} code */
const codeHash = code => crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');

/** @param {unknown} v */
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Checks JavaScript or TypeScript against the policy. Never runs the code.
 * Line numbers are 1-based; columns are 1-based too. TypeScript is reduced to
 * JavaScript by Node's type stripper, which keeps every position, so findings
 * point at the user's own lines.
 * @param {string} code
 * @param {CodeLanguage} language   'javascript' or 'typescript'
 * @param {{ now?: string }} [opts]
 * @returns {PolicyReport}
 */
function analyzeJavaScript(code, language, opts) {
  if (language !== 'javascript' && language !== 'typescript') throw invalid('Only JavaScript and TypeScript are checked here; Python is checked inside the sandbox.');
  const src = typeof code === 'string' ? code : String(code === undefined || code === null ? '' : code);
  const lines = src.split(/\r\n|\r|\n/);
  /** @type {PolicyFinding[]} */
  const findings = [];
  const seen = new Set();
  /**
   * @param {string} rule @param {'error' | 'warning'} severity @param {string} message
   * @param {{ line: number, column: number } | null} [loc]   acorn location (column 0-based)
   */
  const add = (rule, severity, message, loc) => {
    const line = loc ? loc.line : null;
    const column = loc ? loc.column + 1 : null;
    const key = rule + '|' + line + '|' + column + '|' + message;
    if (seen.has(key)) return;
    seen.add(key);
    const excerpt = line ? (lines[line - 1] || '').trim().slice(0, LIMITS.excerptChars) : '';
    findings.push({ rule, severity, message, line, column, excerpt });
  };
  const report = () => {
    findings.sort((a, b) => (a.line || 0) - (b.line || 0) || (a.column || 0) - (b.column || 0));
    const kept = findings.slice(0, LIMITS.findingsKept);
    return {
      ok: !findings.some(f => f.severity === 'error'),
      policyVersion: POLICY_VERSION,
      language,
      engine: /** @type {'acorn'} */ ('acorn'),
      codeHash: codeHash(src),
      findings: kept,
      checkedAt: (opts && opts.now) || new Date().toISOString()
    };
  };

  // Size first: too much code isn't parsed at all.
  const bytes = Buffer.byteLength(src, 'utf8');
  if (bytes > LIMITS.codeBytes) {
    add('size', 'error', 'The code is ' + Math.ceil(bytes / 1024) + ' KB; a coding rule can be at most ' + (LIMITS.codeBytes / 1024) + ' KB. Shorten it.');
    return report();
  }
  const lineCount = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  if (lineCount > LIMITS.codeLines) add('size', 'error', 'The code has ' + lineCount + ' lines; a coding rule can have at most ' + LIMITS.codeLines + '. Shorten it.');
  if (!src.trim()) { add('contract', 'error', 'The code is empty. Define a function classify(record, variable) that returns one of the variable\'s codes.'); return report(); }

  // TypeScript: strip the types (positions are kept), then check the JavaScript.
  let js = src;
  if (language === 'typescript') {
    if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
      add('typescript_unavailable', 'error', 'This server\'s Node.js can\'t read TypeScript (it needs Node 22.13 or newer). Use JavaScript instead.');
      return report();
    }
    try { js = nodeModule.stripTypeScriptTypes(src, { mode: 'strip' }); }
    catch (e) {
      const err = /** @type {Error & { code?: string }} */ (e);
      const where = tsErrorLocation(err);
      const unsupported = err.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
      add('syntax', 'error', (unsupported ? 'TypeScript feature not supported: ' + firstLine(err.message) + '. Types are stripped, not compiled: use plain types and objects instead of enums, namespaces or parameter properties.'
        : 'TypeScript syntax error: ' + firstLine(err.message) + '.'), where);
      return report();
    }
  }

  /** @type {any} */
  let ast;
  try {
    ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (e) {
    const err = /** @type {Error & { loc?: { line: number, column: number } }} */ (e);
    const msg = String(err.message || err).replace(/\s*\(\d+:\d+\)$/, '');
    if (/'import' and 'export'/.test(msg)) add('syntax', 'error', 'Imports and exports aren\'t available: the sandbox has no modules. Define a plain function classify(record, variable).', err.loc || null);
    else if (/import\.meta/.test(msg)) add('dynamic_import', 'error', 'import.meta isn\'t available: the sandbox has no modules.', err.loc || null);
    else add('syntax', 'error', 'Syntax error: ' + msg + '.', err.loc || null);
    return report();
  }

  checkContract(ast, add);

  /** @param {any} n */
  const at = n => (n && n.loc ? n.loc.start : null);
  /** @param {string} name @param {any} node */
  const globalRef = (name, node) => {
    if (GLOBAL_REASONS[name]) add('forbidden_global', 'error', '`' + name + '` isn\'t allowed: ' + GLOBAL_REASONS[name], at(node));
    else if (name.startsWith('__')) add('forbidden_global', 'error', '`' + name + '` isn\'t allowed: names starting with __ are reserved for the sandbox.', at(node));
  };
  /** The name a member/key refers to when it's written literally, else null. @param {any} key @param {boolean} computed */
  const staticName = (key, computed) => {
    if (!key) return null;
    if (!computed && key.type === 'Identifier') return key.name;
    if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
    if (key.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis.map((/** @type {any} */ q) => q.value.cooked).join('');
    return null;
  };
  /**
   * A property read (member access or destructuring), or an object literal key
   * (`literalKey`: only the listed properties matter there, e.g. { __proto__: … }).
   * @param {string | null} name @param {any} node @param {string} what @param {boolean} [literalKey]
   */
  const property = (name, node, what, literalKey) => {
    if (name === null) return;
    if (PROPERTY_SET.has(name)) add('forbidden_property', 'error', what + ' `' + name + '` isn\'t allowed: it reaches constructors, prototypes or the call stack, which is how code escapes a sandbox.', at(node));
    else if (literalKey) return;
    else if (MEMBER_GLOBAL_SET.has(name)) add('forbidden_property', 'error', what + ' `' + name + '` isn\'t allowed: ' + (GLOBAL_REASONS[name] || 'it reaches code generation.'), at(node));
    else if (name.startsWith('__')) add('forbidden_property', 'error', what + ' `' + name + '` isn\'t allowed: names starting with __ are internal to the engine or the sandbox.', at(node));
  };
  /** @param {string} s @param {any} node */
  const checkString = (s, node) => {
    if (s.length > LIMITS.longStringChars) { add('obfuscation', 'warning', 'A string of ' + s.length + ' characters: very long strings can hide code. Keep data short and readable.', at(node)); return; }
    NAME_IN_STRING.lastIndex = 0;
    let m;
    while ((m = NAME_IN_STRING.exec(s))) {
      const name = m[1];
      if (COMMON_WORDS.has(name) && !LOOKS_LIKE_CODE.test(s)) continue;
      add('obfuscation', 'warning', 'A string mentions `' + name + '`, a name the policy blocks: building names from strings is a common way to hide what code does.', at(node));
      break;
    }
  };

  const visitors = /** @type {any} */ ({
    /** @param {any} node */
    Identifier(node) { globalRef(node.name, node); },
    /** An identifier in a pattern: a declaration is fine, an assignment target is a reference. @param {any} node @param {any} _st @param {any[]} ancestors */
    VariablePattern(node, _st, ancestors) {
      for (let i = ancestors.length - 2; i >= 0; i--) {
        const t = ancestors[i].type;
        if (t === 'ObjectPattern' || t === 'ArrayPattern' || t === 'RestElement' || t === 'AssignmentPattern') continue;
        if (t === 'AssignmentExpression' || t === 'ForInStatement' || t === 'ForOfStatement') globalRef(node.name, node);
        return;
      }
    },
    /** @param {any} node */
    MemberExpression(node) {
      property(staticName(node.property, node.computed), node.property, 'The property');
      // Nondeterminism: Math.random, Date.now, performance.now
      const obj = node.object && node.object.type === 'Identifier' ? node.object.name : null;
      const prop = staticName(node.property, node.computed);
      if ((obj === 'Math' && prop === 'random') || (obj === 'Date' && prop === 'now') || (obj === 'performance' && prop === 'now')) {
        add('nondeterministic', 'warning', obj + '.' + prop + ' gives different results on every run, so runs can\'t be compared. Make the rule depend only on the record.', at(node));
      }
    },
    /** @param {any} node */
    Property(node) { property(staticName(node.key, node.computed), node.key, 'The key', true); },
    /** Destructuring reads properties too: const { constructor } = x. @param {any} node */
    ObjectPattern(node) {
      for (const p of node.properties) if (p.type === 'Property') property(staticName(p.key, p.computed), p.key, 'The property');
    },
    /** @param {any} node */
    ImportExpression(node) { add('dynamic_import', 'error', 'import() isn\'t available: the sandbox has no modules or network. Write everything in this file.', at(node)); },
    /** @param {any} node */
    MetaProperty(node) {
      if (node.meta && node.meta.name === 'import') add('dynamic_import', 'error', 'import.meta isn\'t available: the sandbox has no modules.', at(node));
    },
    /** @param {any} node */
    WithStatement(node) { add('with_statement', 'error', '`with` isn\'t allowed: it makes it impossible to tell which names the code uses.', at(node)); },
    /** @param {any} node */
    WhileStatement(node) { if (isTruthyConstant(node.test) && !exitsLoop(node.body)) add('infinite_loop', 'error', 'This `while` loop never ends: its condition is always true and nothing inside breaks out, returns or throws.', at(node)); },
    /** @param {any} node */
    DoWhileStatement(node) { if (isTruthyConstant(node.test) && !exitsLoop(node.body)) add('infinite_loop', 'error', 'This `do … while` loop never ends: its condition is always true and nothing inside breaks out, returns or throws.', at(node)); },
    /** @param {any} node */
    ForStatement(node) { if ((!node.test || isTruthyConstant(node.test)) && !exitsLoop(node.body)) add('infinite_loop', 'error', 'This `for` loop never ends: it has no condition (or an always-true one) and nothing inside breaks out, returns or throws.', at(node)); },
    /** @param {any} node */
    Literal(node) { if (typeof node.value === 'string') checkString(node.value, node); },
    /** @param {any} node */
    TemplateElement(node) { if (typeof node.value.cooked === 'string') checkString(node.value.cooked, node); },
    /** @param {any} node */
    CallExpression(node) {
      const c = node.callee;
      const name = c.type === 'Identifier' ? c.name : null;
      const member = c.type === 'MemberExpression' && c.object.type === 'Identifier' ? c.object.name + '.' + (staticName(c.property, c.computed) || '') : null;
      if ((name && DECODERS.has(name)) || member === 'String.fromCharCode' || member === 'String.fromCodePoint') {
        add('obfuscation', 'warning', (name || member) + '() decodes text at run time, a common way to hide code. Coding rules rarely need it.', at(node));
      }
      if (name === 'Date' && node.arguments.length === 0) add('nondeterministic', 'warning', 'Date() gives the current time, which changes on every run. Use the record\'s timestamp instead.', at(node));
    },
    /** @param {any} node */
    NewExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) add('nondeterministic', 'warning', 'new Date() without arguments is the current time, which changes on every run. Use the record\'s timestamp instead.', at(node));
    }
  });
  walk.ancestor(ast, visitors);
  return report();
}

/** @param {string} s */
const firstLine = s => String(s || '').split('\n')[0].trim().replace(/\.$/, '').slice(0, 300);

/**
 * Node's TypeScript errors start their stack with ":<line>", the source around it and a line of carets.
 * @param {Error} err
 * @returns {{ line: number, column: number } | null}
 */
function tsErrorLocation(err) {
  const s = String(err.stack || '');
  const head = /^[^\n]*:(\d+)\n/.exec(s);
  if (!head) return null;
  const caret = /^([ \t]*)\^+[ \t]*$/m.exec(s.slice(head[0].length).split('\n\n')[0]);
  return { line: Number(head[1]), column: caret ? caret[1].length : 0 };
}

/** while(true), while(1), for(;true;), while(!0) … @param {any} n */
function isTruthyConstant(n) {
  if (!n) return false;
  if (n.type === 'Literal') return n.regex ? true : !!n.value;
  if (n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal') return !n.argument.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.some((/** @type {any} */ q) => q.value.cooked);
  if (n.type === 'ArrayExpression' || n.type === 'ObjectExpression') return true;
  return false;
}

/** The child nodes of an ESTree node. @param {any} node */
function children(node) {
  /** @type {any[]} */
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') out.push(x); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Whether a loop body can leave the loop: a break that belongs to it (not to a
 * nested loop or switch), a labelled break to a label outside the body, a
 * return, a throw, or a yield (generator helpers). Nested functions don't count.
 * @param {any} body
 */
function exitsLoop(body) {
  const inner = new Set();
  /** @type {(n: any, nested: boolean) => boolean}  nested: inside a nested loop or switch */
  const visit = (n, nested) => {
    if (!n || typeof n.type !== 'string') return false;
    if (FUNCTIONS.has(n.type)) return false;
    switch (n.type) {
      case 'ReturnStatement': case 'ThrowStatement': case 'YieldExpression': return true;
      case 'BreakStatement': return n.label ? !inner.has(n.label.name) : !nested;
      case 'LabeledStatement': {
        inner.add(n.label.name);
        const r = visit(n.body, nested);
        inner.delete(n.label.name);
        return r;
      }
      default: {
        const deeper = nested || LOOPS.has(n.type) || n.type === 'SwitchStatement';
        for (const c of children(n)) if (visit(c, deeper)) return true;
        return false;
      }
    }
  };
  return visit(body, false);
}

/**
 * classify must be defined at the top level as a regular (synchronous) function.
 * @param {any} ast
 * @param {(rule: string, severity: 'error' | 'warning', message: string, loc?: { line: number, column: number } | null) => void} add
 */
function checkContract(ast, add) {
  /** @type {{ fn: any, at: any } | null} */
  let found = null;
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id && st.id.name === 'classify') found = { fn: st, at: st.loc.start };
    else if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === 'classify' && d.init && (d.init.type === 'FunctionExpression' || d.init.type === 'ArrowFunctionExpression')) found = { fn: d.init, at: d.loc.start };
      }
    }
  }
  if (!found) { add('contract', 'error', 'No top-level function classify(record, variable). Define it with `function classify(record, variable) { … }` (or `const classify = (record, variable) => …`) so the sandbox can call it.'); return; }
  if (found.fn.async) add('contract', 'error', 'classify must be a regular function, not async: it must return the code directly (the sandbox has no timers or network to wait for).', found.at);
  else if (found.fn.generator) add('contract', 'error', 'classify must be a regular function, not a generator: it must return one code per record.', found.at);
}

/* ── Output contract (Stage 5) ───────────────────────────────────────────── */

const OUTPUT_KEYS = new Set(['code', 'confidence', 'reason']);

/** @param {unknown} v */
const describe = v => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : typeof v === 'string' ? 'a string' : typeof v === 'number' ? 'a number' : typeof v === 'boolean' ? 'true/false' : typeof v);
/** A non-finite number carried across the JSON bridge as {$nonfinite:"NaN"|…}: returns the label, or null. @param {unknown} v */
const nonfiniteLabel = v => (isPlainObject(v) && typeof /** @type {any} */ (v).$nonfinite === 'string' && Object.keys(/** @type {object} */ (v)).length === 1 ? /** @type {any} */ (v).$nonfinite : null);
/** An oversized single result carried as {$oversized:<size>}: returns the size, or null. @param {unknown} v */
const oversizedSize = v => (isPlainObject(v) && typeof /** @type {any} */ (v).$oversized === 'number' && Object.keys(/** @type {object} */ (v)).length === 1 ? /** @type {any} */ (v).$oversized : null);
/** A short, quoted rendering of a value the code returned (never record text). @param {unknown} v */
const quote = v => { let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); } return (s === undefined ? String(v) : s).slice(0, 80); };

/**
 * Validates the raw outputs of a run against the classify/1 contract.
 * Records whose classify threw are not output problems: they become results
 * with code null and the error (they count in the error rate). The output is
 * valid only with zero problems; `problems` keeps the first 50.
 * @param {RawRecordOutput[]} rawOutputs
 * @param {{ id: string }[]} records     the records the run was given (order is kept in `results`)
 * @param {SandboxVariable} variable
 * @returns {{ validation: OutputValidation, results: RecordResult[] }}
 */
function validateOutputs(rawOutputs, records, variable) {
  const codes = new Set((variable && Array.isArray(variable.codes) ? variable.codes : []).map(c => c.id));
  const expected = new Set(records.map(r => r.id));
  /** @type {{ id: string | null, problem: string }[]} */
  const problems = [];
  let problemCount = 0, invalidCount = 0, unexpected = 0;
  /** @param {string | null} id @param {string} problem */
  const problem = (id, problem) => { problemCount++; if (problems.length < LIMITS.problemsKept) problems.push({ id, problem }); };
  /** @type {Map<string, RecordResult>} */
  const byId = new Map();
  const list = Array.isArray(rawOutputs) ? rawOutputs : [];

  for (const raw of list) {
    if (!isPlainObject(raw) || typeof /** @type {any} */ (raw).id !== 'string') { unexpected++; problem(null, 'An output without a record id.'); continue; }
    const id = raw.id;
    if (!expected.has(id)) { unexpected++; problem(id.slice(0, 120), 'Unknown record id: the run wasn\'t given this record.'); continue; }
    if (byId.has(id)) { unexpected++; problem(id, 'Duplicate output: classify returned more than one result for this record.'); continue; }
    const ms = typeof raw.ms === 'number' && Number.isFinite(raw.ms) && raw.ms >= 0 ? raw.ms : null;
    if (typeof raw.error === 'string' && raw.error) {
      byId.set(id, { id, code: null, confidence: null, reason: '', error: raw.error.slice(0, LIMITS.errorChars), ms });
      continue;
    }
    const before = problemCount;
    const out = raw.out;
    /** @type {RecordResult} */
    const r = { id, code: null, confidence: null, reason: '', error: null, ms };
    const big = oversizedSize(out);
    const outNonfinite = nonfiniteLabel(out);
    if (big !== null) { problem(id, 'The result is too large (' + big + ' characters): a reason can be at most ' + LIMITS.reasonChars + ' characters.'); }
    else if (outNonfinite) { problem(id, 'classify returned a non-finite number (' + outNonfinite + '): it must return a code id, null, or {code, confidence, reason}.'); }
    else if (out === null || out === undefined) { /* no code */ }
    else if (typeof out === 'string') {
      if (codes.has(out)) r.code = out; else problem(id, 'Unknown code ' + quote(out) + ': it isn\'t one of the variable\'s codes.');
    } else if (isPlainObject(out)) {
      const o = /** @type {Record<string, unknown>} */ (out);
      const extra = Object.keys(o).filter(k => !OUTPUT_KEYS.has(k));
      if (extra.length) problem(id, 'Unexpected field' + (extra.length > 1 ? 's ' : ' ') + extra.slice(0, 5).map(k => quote(k)).join(', ') + ': only code, confidence and reason are allowed.');
      if (!Object.prototype.hasOwnProperty.call(o, 'code')) problem(id, 'Missing field "code": return {code: <code id or null>, …}.');
      else if (o.code === null) { /* no code */ }
      else if (typeof o.code !== 'string') problem(id, 'Wrong type: code is ' + describe(o.code) + '; it must be a code id string or null.');
      else if (!codes.has(o.code)) problem(id, 'Unknown code ' + quote(o.code) + ': it isn\'t one of the variable\'s codes.');
      else r.code = o.code;
      if (o.confidence !== undefined && o.confidence !== null) {
        const confNonfinite = nonfiniteLabel(o.confidence);
        if (confNonfinite) problem(id, 'Confidence ' + confNonfinite + ' is out of range: confidence must be a finite number between 0 and 1.');
        else if (typeof o.confidence !== 'number') problem(id, 'Wrong type: confidence is ' + describe(o.confidence) + '; it must be a number from 0 to 1.');
        else if (!Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) problem(id, 'Confidence ' + quote(o.confidence) + ' is out of range: confidence must be a finite number between 0 and 1.');
        else r.confidence = o.confidence;
      }
      if (o.reason !== undefined && o.reason !== null) {
        if (typeof o.reason !== 'string') problem(id, 'Wrong type: reason is ' + describe(o.reason) + '; it must be text.');
        else if (o.reason.length > LIMITS.reasonChars) problem(id, 'The reason is ' + o.reason.length + ' characters; it can be at most ' + LIMITS.reasonChars + '.');
        else r.reason = o.reason;
      }
    } else {
      problem(id, 'Wrong type: classify returned ' + describe(out) + '; it must return a code id, null, or {code, confidence, reason}.');
    }
    if (problemCount > before) { invalidCount++; r.code = null; }
    byId.set(id, r);
  }

  let missing = 0;
  for (const rec of records) {
    if (!byId.has(rec.id)) { missing++; problem(rec.id, 'Missing output: no result for this record.'); }
  }
  /** @type {RecordResult[]} */
  const results = [];
  for (const rec of records) { const r = byId.get(rec.id); if (r) results.push(r); }
  return {
    validation: { valid: problemCount === 0, checked: list.length, invalid: invalidCount, missing, unexpected, problems },
    results
  };
}

module.exports = {
  analyzeJavaScript, validateOutputs, codeHash,
  POLICY_VERSION, CONTRACT, PYTHON_ALLOWED_MODULES, LIMITS, FORBIDDEN_GLOBALS, FORBIDDEN_PROPERTIES
};
