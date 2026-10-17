/* ══════════════════════════════════════════════
   lab-markdown.js — rendering model answers safely

   Model output is untrusted: everything is HTML-escaped first, then a small
   Markdown subset is turned into markup (headings, lists, emphasis, inline
   code, fenced code blocks, http(s) links only). Code blocks get a copy
   button and, when highlight.js loads from the CDN, syntax colours.
   LabDiff: a line diff for reviewing a proposed change against a file.
   ══════════════════════════════════════════════ */

const LabMarkdown = (() => {
  'use strict';
  const esc = Lab.esc;
  let hljsLoading = null;

  function loadHighlighter() {
    if (window.hljs) return Promise.resolve(window.hljs);
    if (!hljsLoading) {
      hljsLoading = new Promise(resolve => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github-dark.min.css';
        document.head.appendChild(css);
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js';
        s.onload = () => resolve(window.hljs || null);
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
    }
    return hljsLoading;
  }

  function inline(t) {
    return t
      .replace(/`([^`\n]+)`/g, (m, c) => '<code>' + c + '</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g, (m, label, url) => '<a href="' + url.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer nofollow">' + label + '</a>');
  }

  // → HTML. `text` is raw model output.
  function render(text) {
    const src = String(text || '');
    const out = [];
    const re = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
    let last = 0, m, n = 0;
    while ((m = re.exec(src))) {
      out.push(block(src.slice(last, m.index)));
      const lang = (m[1] || '').trim().split(/\s+/)[0].replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 20);
      out.push('<div class="lab-code" data-code-index="' + (n++) + '"><div class="lab-code-head"><span>' + esc(lang || 'code') + '</span><span>' +
        '<button type="button" data-copy>Copy</button><button type="button" data-diff>Compare with a file</button></span></div><pre><code class="' + (lang ? 'language-' + esc(lang.toLowerCase()) : '') + '">' + esc(m[2]) + '</code></pre></div>');
      last = re.lastIndex;
    }
    out.push(block(src.slice(last)));
    return '<div class="lab-md">' + out.join('') + '</div>';
  }

  function block(t) {
    if (!t.trim()) return '';
    const lines = esc(t).split('\n');
    const html = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { html.push('<p>' + inline(para.join('<br>')) + '</p>'); para = []; } };
    const flushList = () => { if (list) { html.push('<' + list.tag + '>' + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
    for (const line of lines) {
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); html.push('<h' + (h[1].length + 1) + '>' + inline(h[2]) + '</h' + (h[1].length + 1) + '>'); }
      else if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
    return html.join('');
  }

  // Code blocks of an answer: [{ lang, code }]
  function codeBlocks(text) {
    const out = [];
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(String(text || '')))) out.push({ lang: (m[1] || '').trim(), code: m[2] });
    return out;
  }

  // Wires copy / compare buttons and highlighting inside `root`. onDiff(code) opens the comparison.
  function enhance(root, onDiff) {
    root.querySelectorAll('.lab-code').forEach(box => {
      const code = box.querySelector('code');
      const copy = box.querySelector('[data-copy]');
      if (copy) copy.onclick = async () => {
        try { await navigator.clipboard.writeText(code.textContent); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }
        catch (e) { Lab.notify('Couldn\'t copy (the browser refused clipboard access).', 'error'); }
      };
      const diff = box.querySelector('[data-diff]');
      if (diff) { if (onDiff) diff.onclick = () => onDiff(code.textContent); else diff.remove(); }
    });
    loadHighlighter().then(h => { if (h) root.querySelectorAll('.lab-code pre code').forEach(el => { try { h.highlightElement(el); } catch (e) { /* unknown language */ } }); });
  }

  return { render, enhance, codeBlocks };
})();

const LabDiff = (() => {
  'use strict';
  // Line diff (LCS). → [{ op: ' ' | '+' | '-', text }]; large inputs fall back to a plain before/after.
  function diff(a, b) {
    const A = String(a).split('\n'), B = String(b).split('\n');
    if (A.length * B.length > 4000000) return A.map(t => ({ op: '-', text: t })).concat(B.map(t => ({ op: '+', text: t })));
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ op: ' ', text: A[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: A[i++] });
      else out.push({ op: '+', text: B[j++] });
    }
    while (i < n) out.push({ op: '-', text: A[i++] });
    while (j < m) out.push({ op: '+', text: B[j++] });
    return out;
  }
  function html(a, b) {
    const d = diff(a, b);
    const adds = d.filter(x => x.op === '+').length, dels = d.filter(x => x.op === '-').length;
    return '<p class="lab-muted">' + adds + ' line(s) added, ' + dels + ' removed. Review only: MetaCode doesn\'t write to your repository or run this code.</p>' +
      '<div class="lab-diff">' + d.map(x => '<div class="' + (x.op === '+' ? 'add' : x.op === '-' ? 'del' : 'ctx') + '">' + x.op + ' ' + Lab.esc(x.text) + '</div>').join('') + '</div>';
  }
  return { diff, html };
})();
