// @ts-check
// ── Formulas: tokens and syntax tree ──────────────────────────────────────────
// Excel's formula language: numbers, "text" ("" for a quote), TRUE/FALSE,
// errors (#N/A …), references (A1, $A$1, A1:B5, A:A, 1:1, Sheet1!A1,
// 'My sheet'!A1:B2), functions (SUM(...), STDEV.S(...)), array constants
// {1,2;3,4} and the operators, with Excel's precedence:
//
//   :   (range, inside a reference)
//   -   negation (so -2^2 is 4, as in Excel)
//   %   percent
//   ^   power (left to right)
//   * / then + - then & (join) then = <> < > <= >=
//
// The tokenizer keeps every token's text, so formulas can be rewritten
// precisely (references.js) without disturbing spacing or anything else.

import { colIndex, MAX_ROWS } from './address.js';
import { ERROR_CODES } from './values.js';

/**
 * @typedef {{ r: number, c: number, absR: boolean, absC: boolean }} RefPoint
 * @typedef {{ sheet: string | null, kind: 'cell' | 'range' | 'cols' | 'rows', a: RefPoint, b: RefPoint }} Ref
 * @typedef {{ t: string, s: string, v?: any, ref?: Ref }} Token
 */

const SHEET = "(?:'((?:[^']|'')+)'|([A-Za-z_\\u00C0-\\uFFFF][A-Za-z0-9_.\\u00C0-\\uFFFF]*))!";
const CELL = '(\\$?)([A-Za-z]{1,3})(\\$?)(\\d{1,7})';
const COL = '(\\$?)([A-Za-z]{1,3})';
const ROW = '(\\$?)(\\d{1,7})';
const RE_RANGE = new RegExp('^(?:' + SHEET + ')?' + CELL + '(?::' + CELL + ')?');
const RE_COLS = new RegExp('^(?:' + SHEET + ')?' + COL + ':' + COL + '(?![A-Za-z0-9_(])');
const RE_ROWS = new RegExp('^(?:' + SHEET + ')?' + ROW + ':' + ROW + '(?![0-9])');
const RE_NUMBER = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;
const RE_NAME = /^[A-Za-z_\\À-￿][A-Za-z0-9_.À-￿]*/;
const OPS = ['<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '^', '&', '%', ':'];

export class FormulaSyntaxError extends Error {}

/**
 * @param {RegExpExecArray} m @param {number} i index of the first group after the sheet groups
 * @returns {RefPoint | null}
 */
function cellPoint(m, i) {
  const c = colIndex(m[i + 1]);
  const r = Number(m[i + 3]) - 1;
  if (c < 0 || r < 0 || r >= MAX_ROWS) return null;
  return { r, c, absC: m[i] === '$', absR: m[i + 2] === '$' };
}

/**
 * Formula text (without the leading "=") → tokens. Whitespace is kept as
 * tokens of type "ws".
 * @param {string} src
 * @returns {Token[]}
 */
export function tokenize(src) {
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  const prevSignificant = () => { for (let k = out.length - 1; k >= 0; k--) if (out[k].t !== 'ws') return out[k]; return null; };
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i];
    if (/\s/.test(ch)) { const m = /^\s+/.exec(rest); out.push({ t: 'ws', s: /** @type {RegExpExecArray} */ (m)[0] }); i += /** @type {RegExpExecArray} */ (m)[0].length; continue; }
    if (ch === '"') {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError('A text in quotes isn\'t closed.');
        if (src[j] === '"') { if (src[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += src[j++];
      }
      out.push({ t: 'str', s: src.slice(i, j + 1), v });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const code = ERROR_CODES.find(c => rest.toUpperCase().startsWith(c));
      if (!code) throw new FormulaSyntaxError('Unknown error value "' + rest.slice(0, 8) + '".');
      out.push({ t: 'err', s: rest.slice(0, code.length), v: code });
      i += code.length;
      continue;
    }
    // A reference must not follow another value directly (e.g. the "E5" in "1E5" is part of a number)
    const prev = prevSignificant();
    const canStartOperand = !prev || ['op', 'lparen', 'comma', 'semi', 'lbrace'].includes(prev.t);
    if (canStartOperand || prev.t === 'ws') {
      let m;
      if ((m = RE_COLS.exec(rest))) {
        const c1 = colIndex(m[4]), c2 = colIndex(m[6]);
        if (c1 >= 0 && c2 >= 0) {
          const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] !== undefined ? m[2] : null;
          out.push({ t: 'ref', s: m[0], ref: { sheet, kind: 'cols', a: { r: 0, c: c1, absC: m[3] === '$', absR: false }, b: { r: MAX_ROWS - 1, c: c2, absC: m[5] === '$', absR: false } } });
          i += m[0].length;
          continue;
        }
      }
      if ((m = RE_ROWS.exec(rest))) {
        const r1 = Number(m[4]) - 1, r2 = Number(m[6]) - 1;
        const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] !== undefined ? m[2] : null;
        if (r1 >= 0 && r2 >= 0 && r1 < MAX_ROWS && r2 < MAX_ROWS && (sheet !== null || !RE_NUMBER.exec(rest) || /^\$?\d+:/.test(rest))) {
          out.push({ t: 'ref', s: m[0], ref: { sheet, kind: 'rows', a: { r: r1, c: 0, absR: m[3] === '$', absC: false }, b: { r: r2, c: 16383, absR: m[5] === '$', absC: false } } });
          i += m[0].length;
          continue;
        }
      }
      if ((m = RE_RANGE.exec(rest))) {
        const after = src[i + m[0].length];
        const isFunction = !m[1] && !m[2] && !m[7] && after === '(';
        const a = cellPoint(m, 3);
        if (!isFunction && a && !(after && /[A-Za-z0-9_.]/.test(after))) {
          const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] !== undefined ? m[2] : null;
          const b = m[7] !== undefined ? cellPoint(m, 7) : a;
          if (!b) throw new FormulaSyntaxError('"' + m[0] + '" is outside the sheet.');
          out.push({ t: 'ref', s: m[0], ref: { sheet, kind: m[7] !== undefined ? 'range' : 'cell', a, b } });
          i += m[0].length;
          continue;
        }
      }
    }
    let m;
    if ((m = RE_NUMBER.exec(rest))) { out.push({ t: 'num', s: m[0], v: Number(m[0]) }); i += m[0].length; continue; }
    if ((m = RE_NAME.exec(rest))) {
      const name = m[0];
      if (src[i + name.length] === '!' ) throw new FormulaSyntaxError('"' + name + '!" needs a cell or range after it.');
      if (/^(TRUE|FALSE)$/i.test(name) && src[i + name.length] !== '(') out.push({ t: 'bool', s: name, v: name.toUpperCase() === 'TRUE' });
      else out.push({ t: 'name', s: name, v: name.toUpperCase() });
      i += name.length;
      continue;
    }
    if (ch === '(') { out.push({ t: 'lparen', s: ch }); i++; continue; }
    if (ch === ')') { out.push({ t: 'rparen', s: ch }); i++; continue; }
    if (ch === ',') { out.push({ t: 'comma', s: ch }); i++; continue; }
    if (ch === ';') { out.push({ t: 'semi', s: ch }); i++; continue; }
    if (ch === '{') { out.push({ t: 'lbrace', s: ch }); i++; continue; }
    if (ch === '}') { out.push({ t: 'rbrace', s: ch }); i++; continue; }
    const op = OPS.find(o => rest.startsWith(o));
    if (op) { out.push({ t: 'op', s: op, v: op }); i += op.length; continue; }
    throw new FormulaSyntaxError('Unexpected "' + ch + '" in the formula.');
  }
  return out;
}

/** Tokens → formula text (the inverse of tokenize) @param {Token[]} tokens */
export const untokenize = tokens => tokens.map(t => t.s).join('');

/**
 * @typedef {{ type: 'num', v: number } | { type: 'str', v: string } | { type: 'bool', v: boolean } | { type: 'err', v: string }
 *   | { type: 'ref', ref: Ref } | { type: 'fn', name: string, args: Node[] } | { type: 'unary', op: string, arg: Node }
 *   | { type: 'binary', op: string, left: Node, right: Node } | { type: 'percent', arg: Node } | { type: 'array', rows: any[][] }
 *   | { type: 'name', name: string } | { type: 'empty' }} Node
 */

const BINARY = /** @type {Record<string, number>} */ ({ '=': 10, '<>': 10, '<': 10, '>': 10, '<=': 10, '>=': 10, '&': 20, '+': 30, '-': 30, '*': 40, '/': 40, '^': 50 });
const PREFIX_BP = 70;
const PERCENT_BP = 60;

/**
 * Formula text (with or without "=") → syntax tree.
 * @param {string} formula
 * @returns {Node}
 */
export function parse(formula) {
  const src = formula.startsWith('=') ? formula.slice(1) : formula;
  const tokens = tokenize(src).filter(t => t.t !== 'ws');
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (/** @type {string} */ t, /** @type {string} */ what) => {
    const tok = next();
    if (!tok || tok.t !== t) throw new FormulaSyntaxError('Expected ' + what + (tok ? ' before "' + tok.s + '"' : ' at the end') + '.');
    return tok;
  };

  /** @param {number} minBp @returns {Node} */
  function expr(minBp) {
    let left = prefix();
    for (;;) {
      const tok = peek();
      if (!tok) break;
      if (tok.t === 'op' && tok.v === '%') {
        if (PERCENT_BP < minBp) break;
        next();
        left = { type: 'percent', arg: left };
        continue;
      }
      if (tok.t !== 'op' || !(tok.v in BINARY)) break;
      const bp = BINARY[tok.v];
      if (bp < minBp) break;
      next();
      const right = expr(bp + 1);
      left = { type: 'binary', op: tok.v, left, right };
    }
    return left;
  }

  /** @returns {Node} */
  function prefix() {
    const tok = next();
    if (!tok) throw new FormulaSyntaxError('The formula ends too early.');
    switch (tok.t) {
      case 'num': return { type: 'num', v: tok.v };
      case 'str': return { type: 'str', v: tok.v };
      case 'bool': return { type: 'bool', v: tok.v };
      case 'err': return { type: 'err', v: tok.v };
      case 'ref': return { type: 'ref', ref: /** @type {Ref} */ (tok.ref) };
      case 'op':
        if (tok.v === '-' || tok.v === '+') return { type: 'unary', op: tok.v, arg: expr(PREFIX_BP) };
        throw new FormulaSyntaxError('"' + tok.s + '" can\'t start a value.');
      case 'lparen': {
        const inner = expr(0);
        expect('rparen', 'a closing ")"');
        return inner;
      }
      case 'lbrace': return arrayConstant();
      case 'name': {
        if (peek() && peek().t === 'lparen') {
          next();
          /** @type {Node[]} */
          const args = [];
          if (peek() && peek().t === 'rparen') { next(); return { type: 'fn', name: tok.v, args }; }
          for (;;) {
            const t = peek();
            if (t && (t.t === 'comma' || t.t === 'rparen')) args.push({ type: 'empty' });
            else args.push(expr(0));
            const sep = next();
            if (!sep) throw new FormulaSyntaxError('A ")" is missing after the arguments of ' + tok.v + '.');
            if (sep.t === 'rparen') break;
            if (sep.t !== 'comma') throw new FormulaSyntaxError('Expected "," or ")" in ' + tok.v + '(…), not "' + sep.s + '".');
          }
          return { type: 'fn', name: tok.v, args };
        }
        return { type: 'name', name: tok.v };
      }
      default:
        throw new FormulaSyntaxError('Unexpected "' + tok.s + '".');
    }
  }

  /** @returns {Node} */
  function arrayConstant() {
    /** @type {any[][]} */
    const rows = [[]];
    for (;;) {
      let tok = next();
      if (!tok) throw new FormulaSyntaxError('A "}" is missing.');
      let sign = 1;
      if (tok.t === 'op' && (tok.v === '-' || tok.v === '+')) { sign = tok.v === '-' ? -1 : 1; tok = next(); }
      if (!tok) throw new FormulaSyntaxError('A "}" is missing.');
      if (tok.t === 'num') rows[rows.length - 1].push(sign * tok.v);
      else if (tok.t === 'str' || tok.t === 'bool') rows[rows.length - 1].push(tok.v);
      else if (tok.t === 'err') rows[rows.length - 1].push({ error: tok.v });
      else throw new FormulaSyntaxError('Array constants hold numbers, text, TRUE/FALSE or errors only.');
      const sep = next();
      if (!sep) throw new FormulaSyntaxError('A "}" is missing.');
      if (sep.t === 'rbrace') break;
      if (sep.t === 'semi') rows.push([]);
      else if (sep.t !== 'comma') throw new FormulaSyntaxError('Expected "," ";" or "}" in an array constant.');
    }
    if (rows.some(r => r.length !== rows[0].length)) throw new FormulaSyntaxError('Every row of an array constant needs the same number of values.');
    return { type: 'array', rows };
  }

  const tree = expr(0);
  if (pos < tokens.length) throw new FormulaSyntaxError('Unexpected "' + tokens[pos].s + '" in the formula.');
  return tree;
}

/** Every reference in a syntax tree @param {Node} node @param {Ref[]} [out] @returns {Ref[]} */
export function refsOf(node, out) {
  out = out || [];
  switch (node.type) {
    case 'ref': out.push(node.ref); break;
    case 'fn': node.args.forEach(a => refsOf(a, out)); break;
    case 'unary': case 'percent': refsOf(node.arg, out); break;
    case 'binary': refsOf(node.left, out); refsOf(node.right, out); break;
    default: break;
  }
  return out;
}

/** Names of the functions a tree calls @param {Node} node @param {Set<string>} [out] */
export function functionsOf(node, out) {
  out = out || new Set();
  if (node.type === 'fn') { out.add(node.name); node.args.forEach(a => functionsOf(a, out)); }
  else if (node.type === 'unary' || node.type === 'percent') functionsOf(node.arg, out);
  else if (node.type === 'binary') { functionsOf(node.left, out); functionsOf(node.right, out); }
  return out;
}
