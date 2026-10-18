// @ts-check
// ── A small XML reader and writer (for .xlsx) ─────────────────────────────────
// Streams elements to callbacks instead of building a tree, so a large sheet
// doesn't need the memory of a document object. Namespace prefixes are
// dropped (x:c → c). DOCTYPE declarations are refused: no DTDs, no entity
// definitions, so no "billion laughs" or external entities. Only the five XML
// entities and character references are understood.

export class XmlError extends Error {}

const ENTITIES = /** @type {Record<string, string>} */ ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });

/** @param {string} s */
export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

/**
 * @param {string} xml
 * @param {{ open?: (name: string, attrs: Record<string, string>, selfClosing: boolean) => void, close?: (name: string) => void, text?: (text: string) => void }} h
 */
export function saxParse(xml, h) {
  let i = 0;
  const n = xml.length;
  const local = (/** @type {string} */ q) => { const k = q.indexOf(':'); return k < 0 ? q : q.slice(k + 1); };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { if (h.text) { const t = xml.slice(i); if (t.trim()) h.text(decodeEntities(t)); } break; }
    if (lt > i && h.text) h.text(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e < 0) throw new XmlError('Unclosed comment'); i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); if (e < 0) throw new XmlError('Unclosed CDATA'); if (h.text) h.text(xml.slice(lt + 9, e)); i = e + 3; continue; }
    if (xml.startsWith('<!', lt)) throw new XmlError('Documents with a DOCTYPE aren\'t accepted.');
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); if (e < 0) throw new XmlError('Unclosed processing instruction'); i = e + 2; continue; }
    if (xml[lt + 1] === '/') {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) throw new XmlError('Unclosed end tag');
      if (h.close) h.close(local(xml.slice(lt + 2, e).trim()));
      i = e + 1;
      continue;
    }
    // A start tag: find its end, outside attribute quotes
    let j = lt + 1, q = '';
    for (; j < n; j++) {
      const ch = xml[j];
      if (q) { if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '>') break;
    }
    if (j >= n) throw new XmlError('Unclosed start tag');
    const self = xml[j - 1] === '/';
    const body = xml.slice(lt + 1, self ? j - 1 : j);
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new XmlError('A tag without a name');
    /** @type {Record<string, string>} */
    const attrs = {};
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    re.lastIndex = m[0].length;
    while ((a = re.exec(body))) attrs[local(a[1])] = decodeEntities(a[3] !== undefined ? a[3] : a[4]);
    const name = local(m[1]);
    if (h.open) h.open(name, attrs, self);
    if (self && h.close) h.close(name);
    i = j + 1;
  }
}

/**
 * A small tree, for the little files (workbook.xml, styles.xml, rels)
 * @typedef {{ name: string, attrs: Record<string, string>, children: XmlNode[], text: string }} XmlNode
 * @param {string} xml
 * @returns {XmlNode}
 */
export function parseTree(xml) {
  /** @type {XmlNode} */
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  saxParse(xml, {
    open(name, attrs) { const node = { name, attrs, children: [], text: '' }; stack[stack.length - 1].children.push(node); stack.push(node); },
    close() { if (stack.length > 1) stack.pop(); },
    text(t) { stack[stack.length - 1].text += t; }
  });
  return root;
}
/** First descendant (or self) with a name @param {XmlNode} node @param {string} name @returns {XmlNode | null} */
export function find(node, name) {
  if (node.name === name) return node;
  for (const c of node.children) { const f = find(c, name); if (f) return f; }
  return null;
}
/** Children with a name @param {XmlNode | null} node @param {string} name */
export const kids = (node, name) => (node ? node.children.filter(c => c.name === name) : []);
/** All text inside a node @param {XmlNode} node @returns {string} */
export const textOf = node => node.text + node.children.map(textOf).join('');

/** Text for XML: escaped, and characters XML can't hold removed @param {any} s */
export function esc(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, ch => (/** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }))[ch]);
}
