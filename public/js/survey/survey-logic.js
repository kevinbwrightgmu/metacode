/* ══════════════════════════════════════════════
   survey-logic.js — expressions, logic rules, answers

   Shared by the browser (runtime, preview, editor checks) and the server
   (validating submitted responses). Pure functions over the survey document.

   Expressions: a small, safe formula language (no eval):
     score > 50 && answer("q1") == "yes"
     round(avg(q3, q4), 1)        if(age >= 18, "adult", "minor")
   Identifiers resolve to variables, then to questions by answer key, then
   to built-ins (score, page).

   Rules (doc.rules):
     { id, name, enabled,
       trigger: { type: 'always' | 'pageExit' | 'pageEnter' | 'click' | 'submit', page?, element? },
       when:    { op: 'all' | 'any', items: [condition | { group: {op, items} }] },
       then:    [action], else: [action] }
     condition: { left: operand, cmp, right: operand }
     operand:   { kind: 'answer', ref } | { kind: 'var', name } | { kind: 'score' } | { kind: 'page' }
                | { kind: 'value', value } | { kind: 'expr', expr }
     action:    { type, target?, value?, path?, name?, expr? }

   'always' rules describe state and are re-evaluated on every change
   (show / hide / enable / disable / require / optional / set property /
   set text / calculate variable / hide or show a page). "Show X" means X
   stays hidden until the condition is true. Event rules run once when the
   event happens (leaving a page, clicking a button, submitting).
   ══════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./survey-core.js'));
  else root.SurveyLogic = factory(root.SurveyCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const { isObj, num, str, isQuestionType, questionParts, descendants, ancestors, pageIdOfRef, plainText } = Core;

  /* ── Expression language ───────────────────── */
  class ExprError extends Error {}
  const MAX_EXPR = 2000;

  function tokenize(src) {
    const s = String(src);
    if (s.length > MAX_EXPR) throw new ExprError('The formula is too long (' + MAX_EXPR + ' characters at most).');
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
        out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1, v = '';
        while (j < s.length && s[j] !== c) {
          if (s[j] === '\\' && j + 1 < s.length) { const n = s[j + 1]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; continue; }
          v += s[j++];
        }
        if (j >= s.length) throw new ExprError('A text value is missing its closing quote.');
        out.push({ t: 'str', v }); i = j + 1; continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(s.slice(i));
        const w = m[0];
        const low = w.toLowerCase();
        if (low === 'and') out.push({ t: 'op', v: '&&' });
        else if (low === 'or') out.push({ t: 'op', v: '||' });
        else if (low === 'not') out.push({ t: 'op', v: '!' });
        else if (low === 'true' || low === 'false') out.push({ t: 'bool', v: low === 'true' });
        else if (low === 'null') out.push({ t: 'null' });
        else out.push({ t: 'id', v: w.replace(/^\$/, '') });
        i += w.length; continue;
      }
      const two = s.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/%^<>!(),='.includes(c)) { out.push({ t: 'op', v: c === '=' ? '==' : c }); i++; continue; }
      throw new ExprError('Unexpected character "' + c + '" in the formula.');
    }
    return out;
  }

  const BIN = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '^': 7 };
  function parse(src) {
    const toks = tokenize(src);
    if (!toks.length) throw new ExprError('The formula is empty.');
    let p = 0, nodes = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const expectOp = v => { const t = next(); if (!t || t.t !== 'op' || t.v !== v) throw new ExprError('Expected "' + v + '" in the formula.'); };
    function primary(depth) {
      if (depth > 60 || ++nodes > 800) throw new ExprError('The formula is too complex.');
      const t = next();
      if (!t) throw new ExprError('The formula ends too early.');
      if (t.t === 'num') return { k: 'lit', v: t.v };
      if (t.t === 'str') return { k: 'lit', v: t.v };
      if (t.t === 'bool') return { k: 'lit', v: t.v };
      if (t.t === 'null') return { k: 'lit', v: null };
      if (t.t === 'op' && t.v === '(') { const e = expr(0, depth + 1); expectOp(')'); return e; }
      if (t.t === 'op' && (t.v === '-' || t.v === '!' || t.v === '+')) return { k: 'un', op: t.v, a: expr(8, depth + 1) };
      if (t.t === 'id') {
        if (peek() && peek().t === 'op' && peek().v === '(') {
          next();
          const name = t.v.toLowerCase();
          if (!FUNCS[name]) throw new ExprError('Unknown function "' + t.v + '()".');
          const args = [];
          if (!(peek() && peek().t === 'op' && peek().v === ')')) {
            for (;;) { args.push(expr(0, depth + 1)); if (peek() && peek().t === 'op' && peek().v === ',') { next(); continue; } break; }
          }
          expectOp(')');
          return { k: 'call', name, args };
        }
        return { k: 'id', name: t.v };
      }
      throw new ExprError('Unexpected "' + (t.v === undefined ? t.t : t.v) + '" in the formula.');
    }
    function expr(minPrec, depth) {
      let left = primary(depth);
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op' || BIN[t.v] === undefined || BIN[t.v] < minPrec) break;
        next();
        const prec = BIN[t.v];
        const right = expr(t.v === '^' ? prec : prec + 1, depth + 1);
        left = { k: 'bin', op: t.v, a: left, b: right };
      }
      return left;
    }
    const ast = expr(0, 0);
    if (p < toks.length) throw new ExprError('Unexpected "' + (toks[p].v !== undefined ? toks[p].v : toks[p].t) + '" in the formula.');
    return ast;
  }

  const astCache = new Map();
  function compile(src) {
    const key = String(src);
    if (astCache.has(key)) return astCache.get(key);
    const ast = parse(key);
    if (astCache.size > 2000) astCache.clear();
    astCache.set(key, ast);
    return ast;
  }

  function isEmptyValue(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    if (isObj(v)) return Object.keys(v).length === 0;
    if (typeof v === 'number') return !Number.isFinite(v);
    return false;
  }
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (Array.isArray(v)) return v.length;
    return v === null || v === undefined || v === '' ? 0 : NaN;
  }
  function numericLike(v) { return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))); }
  function looseEq(a, b) {
    if (Array.isArray(a)) return a.some(x => looseEq(x, b));
    if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
    if (numericLike(a) && numericLike(b)) return Number(a) === Number(b);
    if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
    if (isObj(a) || isObj(b)) return JSON.stringify(a) === JSON.stringify(b);
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
  function compare(a, b) {
    if (numericLike(a) && numericLike(b)) return Number(a) - Number(b);
    const A = String(a === null || a === undefined ? '' : a), B = String(b === null || b === undefined ? '' : b);
    return A < B ? -1 : A > B ? 1 : 0;
  }
  function flat(args) { const out = []; args.forEach(a => (Array.isArray(a) ? a.forEach(x => out.push(x)) : out.push(a))); return out; }
  function numsOf(args) { return flat(args).map(toNum).filter(Number.isFinite); }
  function contains(h, n) {
    if (Array.isArray(h)) return h.some(x => looseEq(x, n));
    if (isObj(h)) return Object.values(h).some(x => looseEq(x, n));
    return String(h === null || h === undefined ? '' : h).toLowerCase().indexOf(String(n === null || n === undefined ? '' : n).toLowerCase()) !== -1;
  }
  function textOf(v) { if (v === null || v === undefined) return ''; if (Array.isArray(v)) return v.join(', '); if (isObj(v)) return JSON.stringify(v); return String(v); }

  const FUNCS = {
    answer: (env, a) => env.answerByKey(a[0]),
    selected: (env, a) => contains(env.answerByKey(a[0]), a[1]),
    score: (env, a) => (a.length ? env.scoreOf(a[0]) : env.score()),
    count: (env, a) => { const v = a[0]; return Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : (isEmptyValue(v) ? 0 : 1); },
    len: (env, a) => (Array.isArray(a[0]) ? a[0].length : textOf(a[0]).length),
    sum: (env, a) => numsOf(a).reduce((s, x) => s + x, 0),
    avg: (env, a) => { const n = numsOf(a); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : 0; },
    min: (env, a) => { const n = numsOf(a); return n.length ? Math.min.apply(null, n) : 0; },
    max: (env, a) => { const n = numsOf(a); return n.length ? Math.max.apply(null, n) : 0; },
    round: (env, a) => { const d = Math.max(0, Math.min(10, toNum(a[1]) || 0)); const f = Math.pow(10, d); return Math.round(toNum(a[0]) * f) / f; },
    floor: (env, a) => Math.floor(toNum(a[0])),
    ceil: (env, a) => Math.ceil(toNum(a[0])),
    abs: (env, a) => Math.abs(toNum(a[0])),
    sqrt: (env, a) => Math.sqrt(toNum(a[0])),
    pow: (env, a) => Math.pow(toNum(a[0]), toNum(a[1])),
    if: (env, a) => (truthy(a[0]) ? a[1] : a[2]),
    contains: (env, a) => contains(a[0], a[1]),
    lower: (env, a) => textOf(a[0]).toLowerCase(),
    upper: (env, a) => textOf(a[0]).toUpperCase(),
    trim: (env, a) => textOf(a[0]).trim(),
    concat: (env, a) => a.map(textOf).join(''),
    text: (env, a) => textOf(a[0]),
    number: (env, a) => toNum(a[0]),
    isempty: (env, a) => isEmptyValue(a[0]),
    notempty: (env, a) => !isEmptyValue(a[0]),
    today: () => new Date().toISOString().slice(0, 10),
    daysbetween: (env, a) => { const x = Date.parse(a[0]), y = Date.parse(a[1]); return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86400000) : null; }
  };
  const FUNC_HELP = [
    ['answer("key")', 'Answer to the question with this answer key'], ['selected("key", value)', 'Whether the answer includes value'],
    ['score()', 'Total score so far (or score("key") for one question)'], ['count(x)', 'How many items were selected'],
    ['sum(…) avg(…) min(…) max(…)', 'Numbers or lists'], ['round(x, digits)', 'Rounding (also floor, ceil, abs, sqrt, pow)'],
    ['if(test, a, b)', 'a when test is true, otherwise b'], ['contains(text, part)', 'Text or list contains a value'],
    ['lower(x) upper(x) trim(x) concat(…) len(x)', 'Text helpers'], ['isEmpty(x) notEmpty(x)', 'Whether something was answered'],
    ['today() daysBetween(a, b)', 'Dates as YYYY-MM-DD']
  ];
  function truthy(v) { return Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : !!v && v !== '0' && v !== 'false'; }

  function evalAst(n, env, depth) {
    if (depth > 200) throw new ExprError('The formula is too deeply nested.');
    switch (n.k) {
      case 'lit': return n.v;
      case 'id': return env.lookup(n.name);
      case 'un': {
        const v = evalAst(n.a, env, depth + 1);
        if (n.op === '!') return !truthy(v);
        if (n.op === '-') return -toNum(v);
        return toNum(v);
      }
      case 'bin': {
        if (n.op === '&&') { const l = evalAst(n.a, env, depth + 1); return truthy(l) ? truthy(evalAst(n.b, env, depth + 1)) : false; }
        if (n.op === '||') { const l = evalAst(n.a, env, depth + 1); return truthy(l) ? true : truthy(evalAst(n.b, env, depth + 1)); }
        const a = evalAst(n.a, env, depth + 1), b = evalAst(n.b, env, depth + 1);
        switch (n.op) {
          case '+': return (typeof a === 'string' && !numericLike(a)) || (typeof b === 'string' && !numericLike(b)) ? textOf(a) + textOf(b) : toNum(a) + toNum(b);
          case '-': return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': { const d = toNum(b); return d === 0 ? null : toNum(a) / d; }
          case '%': { const d = toNum(b); return d === 0 ? null : toNum(a) % d; }
          case '^': return Math.pow(toNum(a), toNum(b));
          case '==': return looseEq(a, b);
          case '!=': return !looseEq(a, b);
          case '<': return compare(a, b) < 0;
          case '<=': return compare(a, b) <= 0;
          case '>': return compare(a, b) > 0;
          case '>=': return compare(a, b) >= 0;
        }
        return null;
      }
      case 'call': return FUNCS[n.name](env, n.args.map(x => evalAst(x, env, depth + 1)));
    }
    return null;
  }
  function evaluate(src, env) {
    const v = evalAst(compile(src), env, 0);
    return typeof v === 'number' && !Number.isFinite(v) ? null : v;
  }
  function tryEvaluate(src, env, fallback) {
    try { return evaluate(src, env); } catch (e) { return fallback === undefined ? null : fallback; }
  }
  function checkExpression(src) {
    try { compile(src); return null; } catch (e) { return e.message; }
  }
  // Names an expression refers to (for "unknown name" warnings).
  function identifiersOf(src) {
    const out = new Set();
    const walk = n => { if (!n) return; if (n.k === 'id') out.add(n.name); if (n.a) walk(n.a); if (n.b) walk(n.b); if (n.args) n.args.forEach(walk); };
    try { walk(compile(src)); } catch (e) { /* invalid */ }
    return Array.from(out);
  }

  /* ── Questions, options and values ──────────── */
  const VALUE_KIND = { single: 'choice', yesno: 'choice', rating: 'choice', likert: 'choice', dropdown: 'choice', multiple: 'multi',
    shorttext: 'text', longtext: 'text', date: 'date', time: 'time', number: 'number', slider: 'number', ranking: 'ranking', matrix: 'matrix' };
  function valueKind(q) {
    if (!q) return null;
    if (q.type === 'single' || q.type === 'yesno' || q.type === 'rating' || q.type === 'likert') return q.props.multi ? 'multi' : 'choice';
    return VALUE_KIND[q.type] || (Core.TYPES[q.type] && Core.TYPES[q.type].valueKind) || 'text';
  }
  // Answer choices of a question: [{ value, label, score, id, exclusive }]
  function choicesOf(doc, q) {
    if (q.type === 'dropdown') {
      const field = questionParts(doc, q.id, 'field')[0];
      const opts = field && Array.isArray(field.props.options) ? field.props.options : [];
      return opts.filter(isObj).map((o, i) => ({ id: q.id + ':' + i, value: o.value !== undefined && o.value !== '' ? o.value : Core.slug(o.label), label: str(o.label), score: num(o.score, 0) }));
    }
    if (q.type === 'ranking') return questionParts(doc, q.id, 'rankitem').map(el => ({ id: el.id, value: el.props.value !== undefined && el.props.value !== '' ? el.props.value : Core.slug(el.props.label), label: str(el.props.label), score: 0 }));
    return questionParts(doc, q.id, 'option').map(el => ({ id: el.id, value: el.props.value !== undefined && el.props.value !== '' ? el.props.value : Core.slug(Core.optionLabel(doc, el)),
      label: Core.optionLabel(doc, el), score: num(el.props.score, 0), exclusive: !!el.props.exclusive }));
  }
  function matrixOf(doc, q) {
    const grid = questionParts(doc, q.id, 'matrixgrid')[0];
    const cols = grid && Array.isArray(grid.props.columns) ? grid.props.columns.filter(isObj).map(c => ({ value: c.value !== undefined && c.value !== '' ? c.value : Core.slug(c.label), label: str(c.label), score: num(c.score, 0) })) : [];
    const rows = questionParts(doc, q.id, 'matrixrow').map(r => ({ id: r.id, value: r.props.value !== undefined && r.props.value !== '' ? r.props.value : Core.slug(r.props.label), label: str(r.props.label) }));
    return { rows, cols };
  }
  function sameValue(a, b) { return a === b || String(a) === String(b); }

  // Coerces a raw answer to the question's shape; invalid parts are dropped.
  function normalizeAnswer(doc, q, raw) {
    const kind = valueKind(q);
    if (raw === undefined || raw === null) return null;
    switch (kind) {
      case 'choice': {
        if (Array.isArray(raw) || isObj(raw)) return null;
        const c = choicesOf(doc, q).find(x => sameValue(x.value, raw));
        return c ? c.value : null;
      }
      case 'multi': {
        const list = Array.isArray(raw) ? raw : [raw];
        const choices = choicesOf(doc, q);
        const out = [];
        list.forEach(v => { const c = choices.find(x => sameValue(x.value, v)); if (c && !out.some(o => sameValue(o, c.value))) out.push(c.value); });
        return out;
      }
      case 'number': {
        if (typeof raw === 'string' && raw.trim() === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      case 'date': return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
      case 'time': return typeof raw === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(raw) ? raw : null;
      case 'ranking': {
        if (!Array.isArray(raw)) return null;
        const items = choicesOf(doc, q);
        const out = [];
        raw.forEach(v => { const c = items.find(x => sameValue(x.value, v)); if (c && !out.some(o => sameValue(o, c.value))) out.push(c.value); });
        return out.length === items.length ? out : null;
      }
      case 'matrix': {
        if (!isObj(raw)) return null;
        const { rows, cols } = matrixOf(doc, q);
        const out = {};
        rows.forEach(r => { const v = raw[String(r.value)]; const c = cols.find(x => sameValue(x.value, v)); if (c) out[String(r.value)] = c.value; });
        return out;
      }
      default: return typeof raw === 'string' ? raw.slice(0, 20000) : (typeof raw === 'number' ? String(raw) : null);
    }
  }

  function scoreOf(doc, q, value) {
    if (isEmptyValue(value)) return 0;
    const kind = valueKind(q);
    if (kind === 'choice') { const c = choicesOf(doc, q).find(x => sameValue(x.value, value)); return c ? c.score : 0; }
    if (kind === 'multi') { const ch = choicesOf(doc, q); return value.reduce((s, v) => { const c = ch.find(x => sameValue(x.value, v)); return s + (c ? c.score : 0); }, 0); }
    if (kind === 'matrix') { const { cols } = matrixOf(doc, q); return Object.values(value).reduce((s, v) => { const c = cols.find(x => sameValue(x.value, v)); return s + (c ? c.score : 0); }, 0); }
    if (kind === 'number' && q.props.scored) return toNum(value) || 0;
    return 0;
  }

  /* ── State evaluation ──────────────────────── */
  function allQuestions(doc) { return Object.values(doc.elements).filter(el => isQuestionType(el.type)); }
  function keyMap(doc) {
    const m = {};
    Core.questionsInOrder(doc).forEach(q => { m[Core.dataKeyOf(doc, q)] = q.id; });
    allQuestions(doc).forEach(q => { const k = Core.dataKeyOf(doc, q); if (!m[k]) m[k] = q.id; });
    return m;
  }

  function makeEnv(doc, ctx) {
    const keys = ctx.keys || keyMap(doc);
    const vars = ctx.vars || {};
    const answerOf = id => (ctx.isVisible && !ctx.isVisible(id) ? null : (ctx.answers[id] === undefined ? null : ctx.answers[id]));
    const answerByKey = k => { const id = keys[k] || (doc.elements[k] ? k : null); return id ? answerOf(id) : null; };
    const env = {
      answerOf, answerByKey,
      score: () => ctx.score || 0,
      scoreOf: k => { const id = keys[k] || k; const q = doc.elements[id]; return q ? scoreOf(doc, q, answerOf(id)) : 0; },
      lookup: name => {
        if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
        if (name === 'value' && ctx.value !== undefined) return ctx.value;
        if (Object.prototype.hasOwnProperty.call(keys, name)) return answerByKey(name);
        if (name === 'score') return ctx.score || 0;
        if (name === 'page') return (ctx.pageIndex || 0) + 1;
        if (name === 'pages') return doc.pages.length;
        return null;
      }
    };
    return env;
  }

  function operandValue(doc, op, env) {
    if (!isObj(op)) return null;
    switch (op.kind) {
      case 'answer': return env.answerOf(op.ref);
      case 'var': return env.lookup(op.name);
      case 'score': return env.score();
      case 'page': return env.lookup('page');
      case 'expr': return tryEvaluate(op.expr, env);
      case 'value': return op.value;
      case 'calc': return calcValue(op.op, operandValue(doc, op.a, env), operandValue(doc, op.b, env));
      default: return null;
    }
  }
  // Operator reporter blocks: ( a + b ), ( join a b ) …
  const CALC = {
    '+': (a, b) => toNum(a) + toNum(b), '-': (a, b) => toNum(a) - toNum(b), '*': (a, b) => toNum(a) * toNum(b),
    '/': (a, b) => toNum(a) / toNum(b), '%': (a, b) => { const m = toNum(a) % toNum(b); return m; },
    join: (a, b) => textOf(a) + textOf(b),
    round: a => Math.round(toNum(a)), min: (a, b) => Math.min(toNum(a), toNum(b)), max: (a, b) => Math.max(toNum(a), toNum(b))
  };
  function calcValue(op, a, b) {
    const f = CALC[op];
    if (!f) return null;
    const v = f(a, b);
    return typeof v === 'number' && !Number.isFinite(v) ? null : v;
  }
  const CMP = {
    eq: { label: 'is', fn: (a, b) => looseEq(a, b) },
    neq: { label: 'is not', fn: (a, b) => !looseEq(a, b) },
    gt: { label: '>', fn: (a, b) => !isEmptyValue(a) && compare(a, b) > 0 },
    gte: { label: '≥', fn: (a, b) => !isEmptyValue(a) && compare(a, b) >= 0 },
    lt: { label: '<', fn: (a, b) => !isEmptyValue(a) && compare(a, b) < 0 },
    lte: { label: '≤', fn: (a, b) => !isEmptyValue(a) && compare(a, b) <= 0 },
    contains: { label: 'contains', fn: (a, b) => contains(a, b) },
    notContains: { label: 'does not contain', fn: (a, b) => !contains(a, b) },
    empty: { label: 'is not answered', unary: true, fn: a => isEmptyValue(a) },
    notEmpty: { label: 'is answered', unary: true, fn: a => !isEmptyValue(a) }
  };
  function evalCondition(doc, c, env) {
    if (!isObj(c)) return false;   // an empty slot is false, as in Scratch
    if (isObj(c.group)) return evalGroup(doc, c.group, env);
    if (typeof c.expr === 'string') return truthy(tryEvaluate(c.expr, env, false));
    const cmp = CMP[c.cmp] || CMP.eq;
    const a = operandValue(doc, c.left, env);
    return cmp.unary ? cmp.fn(a) : cmp.fn(a, operandValue(doc, c.right, env));
  }
  function evalGroup(doc, g, env) {
    const items = isObj(g) && Array.isArray(g.items) ? g.items : [];
    if (g && g.op === 'not') return !evalCondition(doc, items[0], env);
    if (!items.length) return true;
    return g.op === 'any' ? items.some(c => evalCondition(doc, c, env)) : items.every(c => evalCondition(doc, c, env));
  }

  const ACTIONS = {
    show:      { label: 'Show', target: 'element', state: true },
    hide:      { label: 'Hide', target: 'element', state: true },
    enable:    { label: 'Enable', target: 'element', state: true },
    disable:   { label: 'Disable', target: 'element', state: true },
    require:   { label: 'Make required', target: 'question', state: true },
    optional:  { label: 'Make optional', target: 'question', state: true },
    setProp:   { label: 'Change property of', target: 'element', state: true, path: true, value: true },
    setText:   { label: 'Change text of', target: 'text', state: true, value: true },
    setVar:    { label: 'Set variable', variable: true, expr: true, state: true },
    showPage:  { label: 'Show page', target: 'page', state: true },
    hidePage:  { label: 'Skip page', target: 'page', state: true },
    setAnswer: { label: 'Set answer of', target: 'question', value: true },
    goto:      { label: 'Go to page', target: 'page', nav: true },
    next:      { label: 'Go to next page', nav: true },
    back:      { label: 'Go back', nav: true },
    submit:    { label: 'Submit the survey', nav: true },
    complete:  { label: 'End the survey with message', value: true, nav: true },
    message:   { label: 'Show a message', value: true },
    openUrl:   { label: 'Open a link', value: true },
    // Control and variable blocks (block editor)
    if:        { label: 'If', control: true },
    changeVar: { label: 'Change variable', variable: true, state: true }
  };
  const TRIGGERS = {
    always:    { label: 'While answering', hint: 'Re-checked after every answer' },
    pageExit:  { label: 'When leaving page', page: true },
    pageEnter: { label: 'When entering page', page: true },
    click:     { label: 'When button is clicked', element: true },
    submit:    { label: 'When the survey is submitted' },
    none:      { label: 'Not attached to an event', hidden: true }   // loose blocks lying on the workspace
  };
  // Property paths a rule may change (conditional styling, etc.).
  const SETTABLE = [
    ['style.fill', 'Fill'], ['style.color', 'Text colour'], ['style.borderColor', 'Border colour'], ['style.borderWidth', 'Border width'],
    ['style.opacity', 'Opacity'], ['style.fontSize', 'Font size'], ['style.fontWeight', 'Font weight'], ['style.radius', 'Corner radius'],
    ['frame.rot', 'Rotation'], ['frame.sx', 'Scale X'], ['frame.sy', 'Scale Y'], ['frame.x', 'X'], ['frame.y', 'Y'], ['frame.w', 'Width'], ['frame.h', 'Height'],
    ['props.placeholder', 'Placeholder'], ['props.text', 'Text'], ['props.src', 'Image / media source']
  ];

  function interpolate(text, env) {
    const s = String(text === undefined || text === null ? '' : text);
    if (s.indexOf('{{') === -1) return s;
    return s.replace(/\{\{\s*([^}]{1,500}?)\s*\}\}/g, (m, e) => {
      const v = tryEvaluate(e, env, '');
      if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
      return textOf(v);
    });
  }

  // Visits every action in a list, including those inside if blocks.
  function eachAction(list, fn) {
    (Array.isArray(list) ? list : []).forEach(a => {
      if (!isObj(a)) return;
      fn(a);
      if (a.type === 'if') { eachAction(a.then, fn); eachAction(a.else, fn); }
    });
  }
  // An if block's condition: its slot holds one boolean (empty = false).
  function ifCondition(doc, a, env) {
    const items = isObj(a.when) && Array.isArray(a.when.items) ? a.when.items : [];
    if (!items.length) return false;
    return evalGroup(doc, a.when, env);
  }
  // Value of set/change variable: a block in the value slot, or the older expr/value fields.
  function assignedValue(doc, a, env) {
    if (isObj(a.from)) return operandValue(doc, a.from, env);
    return a.expr !== undefined && a.expr !== '' ? tryEvaluate(a.expr, env, null) : a.value;
  }
  // Runs a list of statements against env; leaf actions go to fn. Returns
  // whether any branch ran (for the preview's "rules active now").
  function runList(doc, list, env, vars, fn) {
    (Array.isArray(list) ? list : []).forEach(a => {
      if (!isObj(a)) return;
      if (a.type === 'if') { runList(doc, ifCondition(doc, a, env) ? a.then : a.else, env, vars, fn); return; }
      if (a.type === 'setVar' && a.name) { vars[a.name] = assignedValue(doc, a, env); }
      if (a.type === 'changeVar' && a.name) { vars[a.name] = (toNum(vars[a.name]) || 0) + (toNum(assignedValue(doc, a, env)) || 0); }
      fn(a);
    });
  }

  // Elements whose default is the opposite of a state action on them.
  function defaultsFromRules(doc) {
    const startHidden = new Set(), startDisabled = new Set(), startOptional = new Set(), pagesHidden = new Set();
    doc.rules.forEach(r => {
      if (!r.enabled || (r.trigger && r.trigger.type !== 'always')) return;
      eachAction(r.then, a => {
        if (a.type === 'show') startHidden.add(a.target);
        if (a.type === 'enable') startDisabled.add(a.target);
        if (a.type === 'require') startOptional.add(a.target);
        if (a.type === 'showPage') pagesHidden.add(a.target);
      });
    });
    return { startHidden, startDisabled, startOptional, pagesHidden };
  }

  // Computes the survey's live state from the answers.
  //   ctx: { answers: {qid: value}, varState: {name: value} (from event rules),
  //          visOverride: {id: bool} (from event rules), pageIndex }
  function computeState(doc, ctx) {
    ctx = ctx || {};
    const answers = ctx.answers || {};
    const keys = keyMap(doc);
    const defs = defaultsFromRules(doc);
    let state = null;
    let prevSig = '';
    for (let pass = 0; pass < 4; pass++) {
      const visible = {}, disabled = {}, required = {}, props = {}, text = {}, pageVisible = {};
      Object.values(doc.elements).forEach(el => {
        visible[el.id] = !(el.behavior && el.behavior.initiallyHidden) && !defs.startHidden.has(el.id);
        if (ctx.visOverride && ctx.visOverride[el.id] !== undefined) visible[el.id] = !!ctx.visOverride[el.id];
        disabled[el.id] = !!(el.behavior && el.behavior.disabled) || defs.startDisabled.has(el.id);
        if (isQuestionType(el.type)) required[el.id] = !!(el.behavior && el.behavior.required) && !defs.startOptional.has(el.id);
      });
      doc.pages.forEach(p => { pageVisible[p.id] = !(p.props && p.props.initiallyHidden) && !defs.pagesHidden.has(p.id); });
      const prevVisible = state ? state.isVisible : null;
      const vars = {};
      doc.variables.forEach(v => { vars[v.name] = ctx.varState && Object.prototype.hasOwnProperty.call(ctx.varState, v.name) ? ctx.varState[v.name] : v.initial; });
      // Score counts visible answers (from the previous pass on later passes).
      const isVisPrev = prevVisible || (() => true);
      let score = 0;
      allQuestions(doc).forEach(q => { if (isVisPrev(q.id)) score += scoreOf(doc, q, answers[q.id]); });
      const envCtx = { answers, vars, score, keys, pageIndex: ctx.pageIndex || 0, isVisible: prevVisible };
      const env = makeEnv(doc, envCtx);
      doc.variables.forEach(v => { if (v.formula) vars[v.name] = tryEvaluate(v.formula, env, v.initial); });
      const fired = [], errors = [], once = [];
      doc.rules.forEach(r => {
        if (!r.enabled || (r.trigger && r.trigger.type !== 'always')) return;
        let ok = false;
        try { ok = evalGroup(doc, r.when, env); } catch (e) { errors.push({ rule: r.id, message: e.message }); }
        if (ok) fired.push(r.id);
        runList(doc, ok ? r.then : r.else || [], env, vars, a => {
          switch (a.type) {
            case 'show': visible[a.target] = true; break;
            case 'hide': visible[a.target] = false; break;
            case 'enable': disabled[a.target] = false; break;
            case 'disable': disabled[a.target] = true; break;
            case 'require': required[a.target] = true; break;
            case 'optional': required[a.target] = false; break;
            case 'showPage': pageVisible[a.target] = true; break;
            case 'hidePage': pageVisible[a.target] = false; break;
            case 'setProp': if (a.target && typeof a.path === 'string' && /^(style|frame|props)\.[A-Za-z0-9_.]+$/.test(a.path)) { (props[a.target] = props[a.target] || {})[a.path] = a.value; } break;
            case 'setText': if (a.target) text[a.target] = interpolate(a.value, env); break;
            // One-off actions: the runtime runs them when they become active after an answer
            case 'openUrl': case 'message': once.push({ key: r.id + '|' + a.type + '|' + String(a.value), type: a.type, value: a.value, where: a.where, text: interpolate(a.value, env) }); break;
            default: break;   // setVar / changeVar are applied by runList
          }
        });
      });
      const isVisible = id => {
        if (visible[id] === false) return false;
        const el = doc.elements[id];
        if (!el || el.hidden) return false;
        let cur = el;
        let guard = 0;
        while (cur && guard++ < 1000) {
          const pid = pageIdOfRef(cur.parent);
          if (pid) return pageVisible[pid] !== false;
          cur = doc.elements[cur.parent];
          if (cur && (visible[cur.id] === false || cur.hidden)) return false;
        }
        return true;
      };
      const isDisabled = id => {
        if (disabled[id]) return true;
        return ancestors(doc, id).some(a => disabled[a]);
      };
      state = { visible, disabled, required, props, text, pageVisible, vars, score, fired, errors, once, isVisible, isDisabled, keys };
      const sig = JSON.stringify([visible, pageVisible, score]);
      if (sig === prevSig) break;
      prevSig = sig;
    }
    // Final score with final visibility.
    let score = 0;
    allQuestions(doc).forEach(q => { if (state.isVisible(q.id)) score += scoreOf(doc, q, answers[q.id]); });
    state.score = score;
    state.isRequired = id => !!state.required[id] && state.isVisible(id) && !state.isDisabled(id);
    state.env = makeEnv(doc, { answers, vars: state.vars, score, keys, pageIndex: ctx.pageIndex || 0, isVisible: state.isVisible });
    return state;
  }

  // Runs the event rules for a trigger; returns the effects in order.
  //   trigger: { type: 'pageExit' | 'pageEnter' | 'click' | 'submit', page?, element? }
  function runEvent(doc, trigger, state) {
    const effects = [];
    doc.rules.forEach(r => {
      if (!r.enabled || !r.trigger || r.trigger.type !== trigger.type) return;
      if ((trigger.type === 'pageExit' || trigger.type === 'pageEnter') && r.trigger.page && r.trigger.page !== 'any' && r.trigger.page !== trigger.page) return;
      if (trigger.type === 'click' && r.trigger.element !== trigger.element) return;
      let ok = false;
      try { ok = evalGroup(doc, r.when, state.env); } catch (e) { ok = false; }
      // Variables set earlier in a script are visible to later blocks in it.
      const vars = Object.assign({}, state.vars);
      const env = Object.assign({}, state.env, { lookup: name => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : state.env.lookup(name)) });
      runList(doc, ok ? r.then : r.else || [], env, vars, a => {
        const e = Object.assign({ rule: r.id }, a);
        if (a.type === 'setVar' || a.type === 'changeVar') { e.type = 'setVar'; e.result = vars[a.name]; }
        if (a.type === 'message' || a.type === 'complete' || a.type === 'setText' || a.type === 'openUrl') e.text = interpolate(a.value, env);
        effects.push(e);
      });
    });
    return effects;
  }

  /* ── Validation ────────────────────────────── */
  const FORMATS = {
    email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.'],
    url: [/^https?:\/\/[^\s]+\.[^\s]+$/i, 'Enter a valid web address (https://…).'],
    phone: [/^\+?[0-9 ()./-]{6,20}$/, 'Enter a valid phone number.'],
    integer: [/^-?\d+$/, 'Enter a whole number.'],
    number: [/^-?\d+(\.\d+)?$/, 'Enter a number.']
  };
  // → error message, or null when valid. opts.patterns: also check regex
  // patterns (browser only — the server skips user-written regexes).
  function validateAnswer(doc, q, value, state, opts) {
    opts = opts || {};
    const v = q.behavior && isObj(q.behavior.validation) ? q.behavior.validation : {};
    const kind = valueKind(q);
    const required = state ? state.isRequired(q.id) : !!(q.behavior && q.behavior.required);
    const msg = (custom, fallback) => (custom && String(custom).trim() ? String(custom) : fallback);
    if (isEmptyValue(value)) return required ? msg(v.requiredMessage, 'This question is required.') : null;
    if (kind === 'matrix' && required) {
      const { rows } = matrixOf(doc, q);
      if (rows.some(r => value[String(r.value)] === undefined)) return msg(v.requiredMessage, 'Please answer every row.');
    }
    if (kind === 'text') {
      const s = String(value);
      if (v.minLength && s.length < num(v.minLength, 0)) return msg(v.lengthMessage, 'Please write at least ' + num(v.minLength, 0) + ' characters.');
      if (v.maxLength && s.length > num(v.maxLength, 0)) return msg(v.lengthMessage, 'Please write at most ' + num(v.maxLength, 0) + ' characters.');
      if (v.format && FORMATS[v.format] && !FORMATS[v.format][0].test(s.trim())) return msg(v.formatMessage, FORMATS[v.format][1]);
      if (v.pattern && opts.patterns) {
        let re = null;
        try { re = new RegExp(v.pattern); } catch (e) { re = null; }
        if (re && !re.test(s)) return msg(v.patternMessage, 'The answer doesn\'t have the expected format.');
      }
    }
    if (kind === 'number') {
      const n = toNum(value);
      const field = questionParts(doc, q.id, 'field')[0];
      const fp = field ? field.props : {};
      const min = v.min !== undefined && v.min !== null && v.min !== '' ? num(v.min, null) : (fp.min !== null && fp.min !== undefined && fp.min !== '' ? num(fp.min, null) : null);
      const max = v.max !== undefined && v.max !== null && v.max !== '' ? num(v.max, null) : (fp.max !== null && fp.max !== undefined && fp.max !== '' ? num(fp.max, null) : null);
      if (min !== null && n < min) return msg(v.rangeMessage, 'Enter a number of at least ' + min + '.');
      if (max !== null && n > max) return msg(v.rangeMessage, 'Enter a number of at most ' + max + '.');
      if (v.integer && !Number.isInteger(n)) return msg(v.rangeMessage, 'Enter a whole number.');
    }
    if (kind === 'multi') {
      const minS = num(v.minSelect !== undefined ? v.minSelect : q.props.minSelect, 0);
      const maxS = num(v.maxSelect !== undefined ? v.maxSelect : q.props.maxSelect, 0);
      if (minS && value.length < minS) return msg(v.selectMessage, 'Select at least ' + minS + '.');
      if (maxS && value.length > maxS) return msg(v.selectMessage, 'Select at most ' + maxS + '.');
    }
    if (v.rule && String(v.rule).trim()) {
      const env = state ? Object.assign({}, state.env, { lookup: name => (name === 'value' ? value : state.env.lookup(name)) }) : null;
      if (env) {
        const ok = tryEvaluate(v.rule, env, true);
        if (!truthy(ok)) return msg(v.ruleMessage, 'This answer isn\'t valid.');
      }
    }
    return null;
  }

  // Server-side check of a submitted response.
  //   payload: { answers: {questionId: value}, path: [pageIds visited], complete: bool }
  // → { answers (cleaned, by id), byKey, errors: [{question, message}], score, vars }
  function validateSubmission(doc, payload) {
    const raw = isObj(payload && payload.answers) ? payload.answers : {};
    const answers = {};
    allQuestions(doc).forEach(q => {
      if (!Object.prototype.hasOwnProperty.call(raw, q.id)) return;
      const v = normalizeAnswer(doc, q, raw[q.id]);
      if (!isEmptyValue(v)) answers[q.id] = v;
    });
    const state = computeState(doc, { answers, varState: isObj(payload.varState) ? payload.varState : {} });
    const errors = [];
    const visited = Array.isArray(payload.path) && payload.path.length ? new Set(payload.path.filter(p => typeof p === 'string')) : null;
    const keepHidden = !!(doc.settings && doc.settings.keepHiddenAnswers);
    Object.keys(answers).forEach(id => { if (!keepHidden && !state.isVisible(id)) delete answers[id]; });
    if (payload.complete) {
      allQuestions(doc).forEach(q => {
        const page = Core.pageOf(doc, q.id);
        if (visited && page && !visited.has(page.id)) return;
        if (!state.isVisible(q.id)) return;
        const err = validateAnswer(doc, q, answers[q.id], state, { patterns: false });
        if (err) errors.push({ question: q.id, message: err });
      });
    }
    const byKey = {};
    Object.keys(answers).forEach(id => { byKey[Core.dataKeyOf(doc, doc.elements[id])] = answers[id]; });
    return { answers, byKey, errors, score: state.score, vars: state.vars };
  }

  // A link an "open link" block can open: http(s) with a host, or mailto; "example.com" means https.
  function linkOf(raw) {
    let s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (s.indexOf('{{') !== -1) return s;   // filled in while answering
    if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)) s = 'https://' + s;
    if (/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(s) || /^https?:\/\/localhost(:\d+)?(\/|$)/i.test(s) || /^mailto:[^\s@]+@[^\s@]+$/i.test(s)) return s;
    return null;
  }

  /* ── Problems (editor + publish checks) ─────── */
  function ruleProblems(doc) {
    const out = [];
    const elementExists = id => !!doc.elements[id];
    const pageExists = id => doc.pages.some(p => p.id === id);
    const varExists = name => doc.variables.some(v => v.name === name);
    const keys = keyMap(doc);
    const known = name => varExists(name) || keys[name] || ['score', 'page', 'pages', 'value'].includes(name);
    const exprCheck = (rule, expr, where) => {
      if (expr === undefined || expr === null || String(expr).trim() === '') return;
      const err = checkExpression(expr);
      if (err) out.push({ rule: rule && rule.id, message: (rule ? rule.name + ': ' : '') + where + ' — ' + err });
      else identifiersOf(expr).forEach(n => { if (!known(n)) out.push({ rule: rule && rule.id, level: 'warning', message: (rule ? rule.name + ': ' : '') + where + ' uses "' + n + '", which isn\'t a variable or answer key.' }); });
    };
    const walkOperand = (rule, op) => {
      if (!isObj(op)) return;
      if (op.kind === 'answer' && !elementExists(op.ref)) out.push({ rule: rule.id, message: rule.name + ': a block refers to a question that no longer exists.' });
      if (op.kind === 'var' && !varExists(op.name)) out.push({ rule: rule.id, message: rule.name + ': a block refers to the missing variable "' + op.name + '".' });
      if (op.kind === 'expr') exprCheck(rule, op.expr, 'a formula');
      if (op.kind === 'calc') { walkOperand(rule, op.a); walkOperand(rule, op.b); }
    };
    const walkCond = (rule, g) => ((g && g.items) || []).forEach(c => {
      if (!isObj(c)) return;
      if (isObj(c.group)) return walkCond(rule, c.group);
      if (typeof c.expr === 'string') return exprCheck(rule, c.expr, 'a condition formula');
      walkOperand(rule, c.left);
      if (!(CMP[c.cmp] && CMP[c.cmp].unary)) walkOperand(rule, c.right);
    });
    doc.rules.forEach(r => {
      if (!r.enabled || (r.trigger && r.trigger.type === 'none')) return;
      walkCond(r, r.when || {});
      if (r.trigger && (r.trigger.type === 'pageExit' || r.trigger.type === 'pageEnter') && r.trigger.page && r.trigger.page !== 'any' && !pageExists(r.trigger.page)) out.push({ rule: r.id, message: r.name + ': its trigger page no longer exists.' });
      if (r.trigger && r.trigger.type === 'click' && !elementExists(r.trigger.element)) out.push({ rule: r.id, message: r.name + ': its button no longer exists.' });
      const acts = [];
      eachAction([].concat(r.then || [], r.else || []), a => acts.push(a));
      acts.forEach(a => {
        const def = ACTIONS[a.type];
        if (a.type === 'if') { walkCond(r, a.when || {}); if (!(a.when && a.when.items && a.when.items.some(isObj))) out.push({ rule: r.id, level: 'warning', message: r.name + ': an "if" block has an empty condition, so it never runs.' }); return; }
        if (a.type === 'setVar' || a.type === 'changeVar') walkOperand(r, a.from);
        if (!def) { out.push({ rule: r.id, message: r.name + ': unknown action "' + a.type + '".' }); return; }
        if (def.target === 'page' && !pageExists(a.target)) out.push({ rule: r.id, message: r.name + ': "' + def.label + '" has no page selected.' });
        else if (def.target && def.target !== 'page' && !elementExists(a.target)) out.push({ rule: r.id, message: r.name + ': "' + def.label + '" has no element selected.' });
        if (def.variable && !varExists(a.name)) out.push({ rule: r.id, message: r.name + ': "Set variable" refers to the missing variable "' + (a.name || '') + '".' });
        if (a.type === 'setVar' && !isObj(a.from)) exprCheck(r, a.expr, 'the variable formula');
        if (a.type === 'openUrl' && !linkOf(a.value)) out.push({ rule: r.id, message: r.name + ': "Open a link" needs a web address like https://example.com.' });
        if (def.nav && r.trigger && r.trigger.type === 'always') out.push({ rule: r.id, level: 'warning', message: r.name + ': navigation actions only run on events (leaving a page, clicking a button) — change the trigger.' });
      });
    });
    doc.variables.forEach(v => exprCheck(null, v.formula, 'Variable "' + v.name + '"'));
    return out;
  }

  return {
    ExprError, tokenize, parse, compile, evaluate, tryEvaluate, checkExpression, identifiersOf, FUNC_HELP,
    isEmptyValue, looseEq, truthy, textOf,
    valueKind, choicesOf, matrixOf, normalizeAnswer, scoreOf, keyMap, makeEnv,
    linkOf, CMP, CALC, ACTIONS, TRIGGERS, SETTABLE, evalGroup, evalCondition, interpolate, eachAction,
    computeState, runEvent, validateAnswer, validateSubmission, ruleProblems, FORMATS
  };
});
