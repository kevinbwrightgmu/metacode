/* ══════════════════════════════════════════════
   survey-core.js — Survey Studio data model

   Shared by the browser (editor, preview, published survey) and the Node
   server (validation, publishing). No DOM, no Node APIs.

   A survey is a structured document, never stored HTML:

     doc
     ├─ settings       canvas width, navigation labels, responsive mode…
     ├─ theme          tokens (colours, fonts) + per-type global styles
     ├─ pages[]        { id, name, children: [element ids], style }
     ├─ elements{}     flat map id → element (tree via parent/children)
     ├─ variables[]    named values, optionally calculated by a formula
     ├─ rules[]        visual logic (see survey-logic.js)
     └─ styles[]       saved named styles

   Every element has the same shape, whatever its type:
     { id, type, name, parent, children?, props, frame, style, behavior,
       a11y, anim, responsive, locked, hidden }
   so the editor can select and configure any of them — including the parts
   of a question (its title, each option, each option's indicator and label).

   New element types are added with registerType(); nothing else in the
   editor needs to change to support them.
   ══════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SurveyCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA = 1;
  const LIMITS = { elements: 5000, pages: 200, rules: 500, variables: 200, textLength: 20000, docBytes: 25 * 1024 * 1024 };

  /* ── Small utilities ───────────────────────── */
  function uid(prefix) {
    let s = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const rnd = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(10)) : null;
    for (let i = 0; i < 10; i++) s += chars[(rnd ? rnd[i] : Math.floor(Math.random() * 256)) % 36];
    return (prefix || 'e') + '_' + s;
  }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function num(x, d) { const n = Number(x); return Number.isFinite(n) ? n : d; }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function str(x, d) { return typeof x === 'string' ? x : (x === undefined || x === null ? (d || '') : String(x)); }
  function deepMerge(a, b) {
    const out = isObj(a) ? Object.assign({}, a) : {};
    if (!isObj(b)) return out;
    for (const k of Object.keys(b)) {
      if (b[k] === undefined) continue;
      out[k] = isObj(b[k]) && isObj(out[k]) ? deepMerge(out[k], b[k]) : b[k];
    }
    return out;
  }
  function getPath(obj, path) {
    const parts = String(path).split('.');
    let cur = obj;
    for (const p of parts) { if (cur === null || cur === undefined) return undefined; cur = cur[p]; }
    return cur;
  }
  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (value === undefined) delete cur[last]; else cur[last] = value;
  }
  function slug(s, fallback) {
    const v = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return v || fallback || 'value';
  }

  /* ── Theme tokens (MetaCode's palette and fonts) ───────────────────────── */
  const TOKENS = [
    { key: 'primary',      label: 'Primary',          kind: 'color', value: '#2563EB' },
    { key: 'primaryHover', label: 'Primary (hover)',  kind: 'color', value: '#1D4ED8' },
    { key: 'primaryLight', label: 'Primary tint',     kind: 'color', value: '#EFF6FF' },
    { key: 'primaryMid',   label: 'Primary soft',     kind: 'color', value: '#BFDBFE' },
    { key: 'accent',       label: 'Accent (violet)',  kind: 'color', value: '#7C3AED' },
    { key: 'accentLight',  label: 'Accent tint',      kind: 'color', value: '#F5F3FF' },
    { key: 'teal',         label: 'Teal',             kind: 'color', value: '#0D9488' },
    { key: 'tealLight',    label: 'Teal tint',        kind: 'color', value: '#F0FDFA' },
    { key: 'amber',        label: 'Amber',            kind: 'color', value: '#F59E0B' },
    { key: 'text',         label: 'Text',             kind: 'color', value: '#0F172A' },
    { key: 'text2',        label: 'Secondary text',   kind: 'color', value: '#475569' },
    { key: 'text3',        label: 'Muted text',       kind: 'color', value: '#94A3B8' },
    { key: 'onPrimary',    label: 'Text on primary',  kind: 'color', value: '#FFFFFF' },
    { key: 'border',       label: 'Border',           kind: 'color', value: '#E2E8F0' },
    { key: 'surface',      label: 'Surface',          kind: 'color', value: '#FFFFFF' },
    { key: 'surface2',     label: 'Muted surface',    kind: 'color', value: '#F8FAFF' },
    { key: 'background',   label: 'Page background',  kind: 'color', value: '#EEF2FF' },
    { key: 'error',        label: 'Error',            kind: 'color', value: '#EF4444' },
    { key: 'success',      label: 'Success',          kind: 'color', value: '#10B981' },
    { key: 'fontBody',     label: 'Body font',        kind: 'font',  value: "'Inter', system-ui, sans-serif" },
    { key: 'fontDisplay',  label: 'Display font',     kind: 'font',  value: "'Space Grotesk', system-ui, sans-serif" },
    { key: 'fontMono',     label: 'Monospace font',   kind: 'font',  value: "'JetBrains Mono', monospace" },
    { key: 'radius',       label: 'Corner radius',    kind: 'size',  value: 10 },
    { key: 'radiusLarge',  label: 'Large radius',     kind: 'size',  value: 16 }
  ];
  const TOKEN_KEYS = TOKENS.map(t => t.key);
  function tokenVar(key) { return 'var(--sv-' + key + ')'; }
  function defaultTokens() { const t = {}; TOKENS.forEach(x => { t[x.key] = x.value; }); return t; }

  const FONTS = [
    { label: 'Body (theme)', value: tokenVar('fontBody') },
    { label: 'Display (theme)', value: tokenVar('fontDisplay') },
    { label: 'Monospace (theme)', value: tokenVar('fontMono') },
    { label: 'Inter', value: "'Inter', system-ui, sans-serif" },
    { label: 'Space Grotesk', value: "'Space Grotesk', system-ui, sans-serif" },
    { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
    { label: 'System UI', value: 'system-ui, sans-serif' },
    { label: 'Arial / Helvetica', value: 'Arial, Helvetica, sans-serif' },
    { label: 'Georgia (serif)', value: 'Georgia, serif' },
    { label: 'Times', value: "'Times New Roman', Times, serif" },
    { label: 'Courier', value: "'Courier New', monospace" }
  ];

  /* ── Element type registry ─────────────────── */
  // def: {
  //   type, label, category, icon (SVG inner markup, 24×24 stroke icon),
  //   question: bool (collects an answer), container: bool (has children),
  //   part: bool (only meaningful inside a parent, e.g. an option),
  //   parents: [types] (for parts: where it may live), text: bool (props.text),
  //   style: built-in default style, layout: default layout (containers),
  //   build(opts) → element spec { type, props, frame, style, behavior, children: [spec] }
  // }
  const TYPES = {};
  const CATEGORIES = [
    { id: 'text', label: 'Text' },
    { id: 'question', label: 'Questions' },
    { id: 'media', label: 'Media' },
    { id: 'layout', label: 'Layout' },
    { id: 'interactive', label: 'Interactive' },
    { id: 'part', label: 'Parts' }
  ];
  function registerType(def) {
    if (!def || !def.type) throw new Error('registerType needs a type');
    TYPES[def.type] = Object.assign({ category: 'layout', label: def.type, icon: '', style: {}, question: false, container: false, part: false }, def);
    return TYPES[def.type];
  }
  function getType(type) { return TYPES[type] || null; }
  function typeLabel(type) { return TYPES[type] ? TYPES[type].label : String(type || 'Element'); }
  function isQuestionType(type) { return !!(TYPES[type] && TYPES[type].question); }
  function isContainerType(type) { return !!(TYPES[type] && TYPES[type].container); }
  function isTextType(type) { return !!(TYPES[type] && TYPES[type].text); }

  const ICONS = {
    heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
    paragraph: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="4" y1="16" x2="14" y2="16"/>',
    label: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    richtext: '<path d="M4 7V4h16v3"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    instructions: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r=".6"/>',
    caption: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="14" x2="12" y2="14"/>',
    single: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
    multiple: '<rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="8 12 11 15 16 9"/>',
    dropdown: '<rect x="3" y="6" width="18" height="12" rx="2"/><polyline points="13 11 15.5 13.5 18 11"/>',
    shorttext: '<rect x="3" y="7" width="18" height="10" rx="2"/><line x1="7" y1="12" x2="12" y2="12"/>',
    longtext: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/><line x1="7" y1="17" x2="12" y2="17"/>',
    number: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    slider: '<line x1="3" y1="12" x2="21" y2="12"/><circle cx="9" cy="12" r="3"/>',
    rating: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
    ranking: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    date: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    time: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    matrix: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
    yesno: '<path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="10" rx="2"/>',
    likert: '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><line x1="3" y1="18" x2="21" y2="18"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    video: '<rect x="2" y="5" width="15" height="14" rx="2"/><polygon points="22 7 17 11 22 15 22 7"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    embed: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    container: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    group: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M11 7h3a3 3 0 0 1 3 3v3"/>',
    divider: '<line x1="3" y1="12" x2="21" y2="12"/>',
    spacer: '<polyline points="8 4 12 1 16 4"/><polyline points="8 20 12 23 16 20"/><line x1="12" y1="1" x2="12" y2="23"/>',
    section: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>',
    tabs: '<path d="M3 21V7h7V3h11v18z"/><line x1="10" y1="7" x2="21" y2="7"/>',
    tabpanel: '<rect x="3" y="5" width="18" height="16" rx="2"/>',
    shape: '<circle cx="9" cy="9" r="6"/><rect x="11" y="11" width="10" height="10" rx="1"/>',
    button: '<rect x="2" y="7" width="20" height="10" rx="5"/><line x1="8" y1="12" x2="16" y2="12"/>',
    progress: '<rect x="2" y="9" width="20" height="6" rx="3"/><rect x="2" y="9" width="11" height="6" rx="3"/>',
    option: '<circle cx="7" cy="12" r="3"/><line x1="13" y1="12" x2="21" y2="12"/>',
    indicator: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
    optlabel: '<line x1="4" y1="12" x2="20" y2="12"/>',
    qtitle: '<path d="M4 6h16M4 12h10"/>',
    qdesc: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="14" x2="16" y2="14"/>',
    qerror: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.5" r=".6"/>',
    choices: '<circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><line x1="11" y1="7" x2="20" y2="7"/><line x1="11" y1="17" x2="20" y2="17"/>',
    field: '<rect x="3" y="7" width="18" height="10" rx="2"/>',
    rankitem: '<line x1="8" y1="8" x2="20" y2="8"/><line x1="8" y1="16" x2="20" y2="16"/><circle cx="4" cy="8" r="1"/><circle cx="4" cy="16" r="1"/>',
    matrixgrid: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/>',
    matrixrow: '<rect x="3" y="9" width="18" height="6" rx="1"/>',
    page: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'
  };

  /* ── Built-in default styles per type (use theme tokens) ───────────────── */
  const T = tokenVar;
  const textBase = { fontFamily: T('fontBody'), color: T('text') };
  const boxFocusRing = { shadows: [{ x: 0, y: 0, blur: 0, spread: 3, color: 'rgba(37,99,235,0.18)' }] };

  // Spec helpers used by the type builders.
  function spec(type, o) { return Object.assign({ type }, o || {}); }
  function textSpec(type, text, o) { return spec(type, Object.assign({ props: { text } }, o || {})); }
  function stack(dir, gap, extra) { return Object.assign({ mode: 'stack', dir, gap, align: dir === 'v' ? 'stretch' : 'center', justify: 'start', wrap: false }, extra || {}); }

  function indicatorFor(kind) {
    const icon = kind === 'star' || kind === 'heart';
    return spec('indicator', {
      props: { shape: kind },
      frame: { w: kind === 'toggle' ? 36 : (icon ? 30 : 20), h: icon ? 30 : 20 },
      style: icon ? { fill: T('border'), borderColor: 'transparent', borderWidth: 0, states: { checked: { fill: kind === 'heart' ? T('error') : T('amber'), borderColor: 'transparent' }, hover: { fill: kind === 'heart' ? T('error') : T('amber'), opacity: 0.85 } } }
        : (kind === 'checkbox' ? { radius: 5, states: { checked: { borderColor: T('primary'), fill: T('primary') } }, markColor: T('onPrimary') }
          : (kind === 'toggle' ? { radius: 99, fill: T('border'), borderWidth: 0, markColor: T('surface'), states: { checked: { fill: T('primary') } } } : undefined))
    });
  }
  function optionSpec(label, value, kind, o) {
    o = o || {};
    const children = [];
    if (kind !== 'none') children.push(indicatorFor(kind));
    if (label !== null && label !== undefined && !o.noLabel) children.push(textSpec('optlabel', label, { frame: { w: o.dir === 'v' ? 'auto' : 'fill', h: 'auto' } }));
    return spec('option', {
      props: { value: value !== undefined ? value : slug(label), score: o.score !== undefined ? o.score : 0, exclusive: false, layout: stack(o.dir || 'h', o.dir === 'v' ? 6 : 10, o.dir === 'v' ? { align: 'center' } : {}) },
      frame: { w: o.w || (o.hdir ? 'auto' : 'fill'), h: 'auto' },
      style: o.style,
      children
    });
  }
  function choicesSpec(options, dir, extra) {
    return spec('choices', { props: { layout: stack(dir, dir === 'v' ? 8 : 10, Object.assign(dir === 'h' ? { align: 'stretch', wrap: true } : {}, extra || {})) }, frame: { w: 'fill', h: 'auto' }, children: options });
  }
  function questionSpec(type, title, inner, o) {
    o = o || {};
    const children = [textSpec('qtitle', title, { frame: { w: 'fill', h: 'auto' } })];
    if (o.description) children.push(textSpec('qdesc', o.description, { frame: { w: 'fill', h: 'auto' } }));
    inner.forEach(c => children.push(c));
    children.push(textSpec('qerror', '', { frame: { w: 'fill', h: 'auto' } }));
    return spec(type, {
      props: Object.assign({ layout: stack('v', 10) }, o.props || {}),
      frame: { w: 664, h: 'auto' },
      behavior: Object.assign({ required: false }, o.behavior || {}),
      children
    });
  }
  function fieldSpec(kind, props) {
    return spec('field', {
      props: Object.assign({ kind, placeholder: '' }, props || {}),
      frame: { w: kind === 'number' || kind === 'date' || kind === 'time' ? 240 : 'fill', h: kind === 'textarea' ? 120 : (kind === 'range' ? 'auto' : 46) },
      style: kind === 'range' ? { fill: 'transparent', borderWidth: 0, padding: [4, 0, 4, 0] } : undefined
    });
  }

  const LIKERT = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

  // Text family
  const TEXT_TYPES = [
    ['heading', 'Heading', 'text', 'Heading', { fontFamily: T('fontDisplay'), fontSize: 28, fontWeight: 700, lineHeight: 1.2, color: T('text') }, 'h2', { w: 664 }],
    ['paragraph', 'Paragraph', 'text', 'Write something your respondents should read.', { fontFamily: T('fontBody'), fontSize: 15, lineHeight: 1.6, color: T('text2') }, 'p', { w: 664 }],
    ['label', 'Label', 'text', 'Label', { fontFamily: T('fontBody'), fontSize: 13, fontWeight: 600, color: T('text') }, 'div', { w: 'auto' }],
    ['richtext', 'Rich text', 'text', '<p>Rich text with <strong>bold</strong>, <em>italic</em> and <a href="https://example.com">links</a>.</p>', { fontFamily: T('fontBody'), fontSize: 15, lineHeight: 1.6, color: T('text2') }, 'div', { w: 664 }],
    ['instructions', 'Instructions', 'text', 'Please answer every question as honestly as you can. It takes about 3 minutes.', { fontFamily: T('fontBody'), fontSize: 14, lineHeight: 1.55, color: T('text2'), fill: T('primaryLight'), padding: [12, 16, 12, 16], radius: T('radius'), borderColor: T('primary'), borderWidth: 0, bL: 3 }, 'div', { w: 664 }],
    ['caption', 'Caption', 'text', 'Caption text', { fontFamily: T('fontBody'), fontSize: 12, color: T('text3') }, 'div', { w: 'auto' }]
  ];
  TEXT_TYPES.forEach(([type, label, cat, text, style, tag, frame]) => registerType({
    type, label, category: cat, icon: ICONS[type], text: true, rich: type === 'richtext', style,
    build: () => textSpec(type, text, { props: { text, tag }, frame: Object.assign({ h: 'auto' }, frame) })
  }));

  // Question parts
  registerType({ type: 'qtitle', label: 'Question title', category: 'part', part: true, text: true, icon: ICONS.qtitle,
    style: { fontFamily: T('fontDisplay'), fontSize: 17, fontWeight: 600, lineHeight: 1.35, color: T('text') } });
  registerType({ type: 'qdesc', label: 'Question description', category: 'part', part: true, text: true, icon: ICONS.qdesc,
    style: { fontFamily: T('fontBody'), fontSize: 13.5, lineHeight: 1.5, color: T('text2') } });
  registerType({ type: 'qerror', label: 'Validation message', category: 'part', part: true, text: true, icon: ICONS.qerror,
    style: { fontFamily: T('fontBody'), fontSize: 12.5, fontWeight: 500, color: T('error') } });
  registerType({ type: 'choices', label: 'Answer group', category: 'part', part: true, container: true, icon: ICONS.choices, style: {} });
  registerType({ type: 'option', label: 'Answer option', category: 'part', part: true, container: true, icon: ICONS.option, hoverHost: true,
    style: { fill: T('surface'), borderColor: T('border'), borderWidth: 1, radius: T('radius'), padding: [10, 14, 10, 14], cursor: 'pointer', transition: 150,
      states: { hover: { borderColor: T('primaryMid') }, checked: { borderColor: T('primary'), fill: T('primaryLight') }, focus: boxFocusRing, disabled: { opacity: 0.5 } } } });
  registerType({ type: 'indicator', label: 'Indicator', category: 'part', part: true, icon: ICONS.indicator,
    style: { fill: T('surface'), borderColor: T('text3'), borderWidth: 2, markColor: T('primary'), transition: 150,
      states: { checked: { borderColor: T('primary') }, hover: { borderColor: T('primary') } } } });
  registerType({ type: 'optlabel', label: 'Option label', category: 'part', part: true, text: true, icon: ICONS.optlabel,
    style: { fontFamily: T('fontBody'), fontSize: 14.5, lineHeight: 1.4, color: T('text') } });
  registerType({ type: 'field', label: 'Input', category: 'part', part: true, icon: ICONS.field,
    style: { fontFamily: T('fontBody'), fontSize: 14.5, color: T('text'), fill: T('surface'), borderColor: T('border'), borderWidth: 1, radius: T('radius'),
      padding: [10, 12, 10, 12], placeholderColor: T('text3'), trackColor: T('border'), thumbColor: T('primary'), transition: 150,
      states: { focus: Object.assign({ borderColor: T('primary') }, boxFocusRing), hover: { borderColor: T('primaryMid') }, disabled: { opacity: 0.55 } } } });
  registerType({ type: 'rankitem', label: 'Ranking item', category: 'part', part: true, icon: ICONS.rankitem, hoverHost: true,
    style: { fontFamily: T('fontBody'), fontSize: 14.5, color: T('text'), fill: T('surface'), borderColor: T('border'), borderWidth: 1, radius: T('radius'),
      padding: [10, 12, 10, 12], markColor: T('primary'), states: { hover: { borderColor: T('primaryMid') }, focus: boxFocusRing } } });
  registerType({ type: 'matrixgrid', label: 'Matrix grid', category: 'part', part: true, container: true, icon: ICONS.matrixgrid,
    style: { fontFamily: T('fontBody'), fontSize: 13, color: T('text2'), markColor: T('primary') } });
  registerType({ type: 'matrixrow', label: 'Matrix row', category: 'part', part: true, icon: ICONS.matrixrow, hoverHost: true,
    style: { fontFamily: T('fontBody'), fontSize: 14, color: T('text'), fill: T('surface'), borderColor: T('border'), borderWidth: 0, bB: 1, padding: [10, 8, 10, 8],
      markColor: T('primary'), states: { hover: { fill: T('surface2') } } } });

  const qStyle = {};
  function regQuestion(type, label, build, extra) {
    registerType(Object.assign({ type, label, category: 'question', question: true, container: true, icon: ICONS[type], style: qStyle, build }, extra || {}));
  }
  regQuestion('single', 'Single choice', () => questionSpec('single', 'Which option fits best?',
    [choicesSpec(['Option A', 'Option B', 'Option C'].map((l, i) => optionSpec(l, 'option_' + 'abc'[i], 'radio')), 'v')]), { valueKind: 'choice' });
  regQuestion('multiple', 'Multiple choice', () => questionSpec('multiple', 'Select all that apply',
    [choicesSpec(['Option A', 'Option B', 'Option C'].map((l, i) => optionSpec(l, 'option_' + 'abc'[i], 'checkbox')), 'v')], { props: { multi: true, minSelect: null, maxSelect: null } }), { valueKind: 'multi' });
  regQuestion('yesno', 'Yes / No', () => questionSpec('yesno', 'Do you agree?',
    [choicesSpec([optionSpec('Yes', 'yes', 'none', { w: 'fill', score: 1, style: { textAlign: 'center' } }), optionSpec('No', 'no', 'none', { w: 'fill', style: { textAlign: 'center' } })], 'h', { wrap: false })]), { valueKind: 'choice' });
  regQuestion('rating', 'Rating', () => questionSpec('rating', 'How would you rate it?',
    [choicesSpec([1, 2, 3, 4, 5].map(n => optionSpec(null, n, 'star', { noLabel: true, w: 'auto', hdir: true, score: n, style: { fill: 'transparent', borderWidth: 0, padding: [2, 2, 2, 2], states: { checked: { fill: 'transparent' }, hover: {} } } })), 'h', { gap: 4, wrap: false })],
    { props: { fillUpTo: true } }), { valueKind: 'choice' });
  regQuestion('likert', 'Likert scale', () => questionSpec('likert', 'How much do you agree with this statement?',
    [choicesSpec(LIKERT.map((l, i) => optionSpec(l, i + 1, 'radio', { dir: 'v', w: 'fill', score: i + 1, style: { textAlign: 'center', fontSize: 12.5, padding: [10, 6, 10, 6] } })), 'h', { wrap: false, gap: 8 })]), { valueKind: 'choice' });
  regQuestion('dropdown', 'Dropdown', () => questionSpec('dropdown', 'Choose one',
    [fieldSpec('select', { placeholder: 'Select…', options: [{ label: 'Option A', value: 'option_a', score: 0 }, { label: 'Option B', value: 'option_b', score: 0 }, { label: 'Option C', value: 'option_c', score: 0 }] })]), { valueKind: 'choice' });
  regQuestion('shorttext', 'Short text', () => questionSpec('shorttext', 'Your answer', [fieldSpec('text', { placeholder: 'Type your answer' })]), { valueKind: 'text' });
  regQuestion('longtext', 'Long text', () => questionSpec('longtext', 'Tell us more', [fieldSpec('textarea', { placeholder: 'Type your answer' })]), { valueKind: 'text' });
  regQuestion('number', 'Number', () => questionSpec('number', 'Enter a number', [fieldSpec('number', { placeholder: '0', min: null, max: null, step: 1 })]), { valueKind: 'number' });
  regQuestion('slider', 'Slider', () => questionSpec('slider', 'How likely are you to recommend us?',
    [fieldSpec('range', { min: 0, max: 10, step: 1, showValue: true, minLabel: 'Not likely', maxLabel: 'Very likely' })]), { valueKind: 'number' });
  regQuestion('date', 'Date', () => questionSpec('date', 'Pick a date', [fieldSpec('date', {})]), { valueKind: 'text' });
  regQuestion('time', 'Time', () => questionSpec('time', 'Pick a time', [fieldSpec('time', {})]), { valueKind: 'text' });
  regQuestion('ranking', 'Ranking', () => questionSpec('ranking', 'Rank these from most to least important',
    [spec('choices', { props: { layout: stack('v', 8) }, frame: { w: 'fill', h: 'auto' }, children: ['Price', 'Quality', 'Speed', 'Support'].map(l => spec('rankitem', { props: { label: l, value: slug(l) }, frame: { w: 'fill', h: 'auto' } })) })]), { valueKind: 'ranking' });
  regQuestion('matrix', 'Matrix / grid', () => questionSpec('matrix', 'Rate each aspect',
    [spec('matrixgrid', {
      props: { layout: stack('v', 0), rowLabelWidth: 200, columns: ['Poor', 'Fair', 'Good', 'Great'].map((l, i) => ({ label: l, value: i + 1, score: i + 1 })) },
      frame: { w: 'fill', h: 'auto' },
      children: ['Ease of use', 'Design', 'Value for money'].map(l => spec('matrixrow', { props: { label: l, value: slug(l) }, frame: { w: 'fill', h: 'auto' } }))
    })]), { valueKind: 'matrix' });

  // Media
  registerType({ type: 'image', label: 'Image', category: 'media', icon: ICONS.image, style: { radius: T('radius') },
    build: () => spec('image', { props: { src: '', alt: '', fit: 'cover' }, frame: { w: 320, h: 200 } }) });
  registerType({ type: 'video', label: 'Video', category: 'media', icon: ICONS.video, style: { radius: T('radius'), fill: '#0F172A' },
    build: () => spec('video', { props: { src: '', poster: '', controls: true, autoplay: false, loop: false, muted: false, title: 'Video' }, frame: { w: 480, h: 270 } }) });
  registerType({ type: 'audio', label: 'Audio', category: 'media', icon: ICONS.audio, style: {},
    build: () => spec('audio', { props: { src: '', controls: true, loop: false, title: 'Audio' }, frame: { w: 360, h: 54 } }) });
  registerType({ type: 'embed', label: 'Embedded content', category: 'media', icon: ICONS.embed, style: { radius: T('radius'), borderColor: T('border'), borderWidth: 1 },
    build: () => spec('embed', { props: { src: '', title: 'Embedded content', allow: '' }, frame: { w: 480, h: 300 } }) });

  // Layout
  registerType({ type: 'container', label: 'Container', category: 'layout', container: true, icon: ICONS.container,
    style: { fill: T('surface2'), borderColor: T('border'), borderWidth: 1, radius: T('radius'), padding: [16, 16, 16, 16] },
    build: () => spec('container', { props: { layout: { mode: 'free', dir: 'v', gap: 12, align: 'stretch', justify: 'start', wrap: false } }, frame: { w: 320, h: 200 }, children: [] }) });
  registerType({ type: 'group', label: 'Group', category: 'layout', container: true, icon: ICONS.group, style: {},
    build: () => spec('group', { props: { layout: { mode: 'free' } }, frame: { w: 200, h: 120 }, children: [] }) });
  registerType({ type: 'section', label: 'Section', category: 'layout', container: true, icon: ICONS.section,
    style: { fill: T('surface2'), borderColor: T('border'), borderWidth: 1, radius: T('radiusLarge'), padding: [20, 24, 20, 24] },
    build: () => spec('section', { props: { layout: stack('v', 16) }, frame: { w: 664, h: 'auto' }, children: [textSpec('heading', 'Section title', { props: { text: 'Section title', tag: 'h3' }, frame: { w: 'fill', h: 'auto' }, style: { fontSize: 20 } }), textSpec('paragraph', 'Add questions or content to this section.', { props: { text: 'Add questions or content to this section.', tag: 'p' }, frame: { w: 'fill', h: 'auto' } })] }) });
  registerType({ type: 'divider', label: 'Divider', category: 'layout', icon: ICONS.divider, style: { fill: T('border') },
    build: () => spec('divider', { props: {}, frame: { w: 664, h: 1 } }) });
  registerType({ type: 'spacer', label: 'Spacer', category: 'layout', icon: ICONS.spacer, style: {},
    build: () => spec('spacer', { props: {}, frame: { w: 664, h: 32 } }) });
  registerType({ type: 'tabs', label: 'Tabs', category: 'layout', container: true, icon: ICONS.tabs,
    style: { fill: T('surface'), borderColor: T('border'), borderWidth: 1, radius: T('radius'), color: T('text2'), markColor: T('primary'), fontFamily: T('fontBody'), fontSize: 13.5 },
    build: () => spec('tabs', { props: { active: 0, layout: { mode: 'stack', dir: 'v', gap: 0, align: 'stretch' } }, frame: { w: 664, h: 'auto' },
      children: ['Tab 1', 'Tab 2'].map((l, i) => spec('tabpanel', { props: { label: l, layout: stack('v', 12) }, frame: { w: 'fill', h: 'auto' },
        children: [textSpec('paragraph', 'Content of ' + l.toLowerCase() + '.', { props: { text: 'Content of ' + l.toLowerCase() + '.', tag: 'p' }, frame: { w: 'fill', h: 'auto' } })] })) }) });
  registerType({ type: 'tabpanel', label: 'Tab panel', category: 'part', part: true, container: true, icon: ICONS.tabpanel, style: { padding: [16, 16, 16, 16] } });
  registerType({ type: 'shape', label: 'Shape', category: 'layout', icon: ICONS.shape, style: { fill: T('primaryLight'), radius: T('radius') },
    build: () => spec('shape', { props: { shape: 'rect' }, frame: { w: 160, h: 120 } }) });

  // Interactive
  registerType({ type: 'button', label: 'Button', category: 'interactive', icon: ICONS.button, hoverHost: true, text: true,
    style: { fill: T('primary'), color: T('onPrimary'), fontFamily: T('fontBody'), fontSize: 14, fontWeight: 600, radius: T('radius'), padding: [10, 20, 10, 20], cursor: 'pointer', textAlign: 'center', transition: 150,
      states: { hover: { fill: T('primaryHover') }, focus: boxFocusRing, active: { scale: 0.98 }, disabled: { opacity: 0.5 } } },
    build: () => spec('button', { props: { text: 'Button', action: { type: 'none' } }, frame: { w: 'auto', h: 'auto' } }) });
  registerType({ type: 'progress', label: 'Progress bar', category: 'interactive', icon: ICONS.progress,
    style: { fill: T('border'), markColor: T('primary'), radius: 99, fontFamily: T('fontBody'), fontSize: 12, color: T('text2') },
    build: () => spec('progress', { props: { showLabel: false }, frame: { w: 664, h: 6 } }) });

  /* ── Element construction ──────────────────── */
  const FRAME_DEFAULT = { x: 0, y: 0, w: 300, h: 'auto', rot: 0, sx: 1, sy: 1, kx: 0, ky: 0, ox: 0.5, oy: 0.5, pos: 'flow' };

  function baseElement(type) {
    return {
      id: uid(type === 'option' ? 'opt' : (isQuestionType(type) ? 'q' : 'el')),
      type, name: '', parent: null,
      props: {}, frame: clone(FRAME_DEFAULT), style: {},
      behavior: {}, a11y: {}, anim: {}, responsive: {},
      locked: false, hidden: false
    };
  }

  // Turns a spec tree into elements. Returns { rootId, elements: {id: el} }.
  function instantiate(specTree, parentRef) {
    const elements = {};
    function walk(s, parent) {
      const el = baseElement(s.type);
      el.parent = parent;
      el.props = deepMerge({}, s.props || {});
      el.frame = Object.assign(clone(FRAME_DEFAULT), s.frame || {});
      el.style = deepMerge({}, s.style || {});
      el.behavior = deepMerge({}, s.behavior || {});
      if (s.name) el.name = s.name;
      if (isContainerType(s.type)) el.children = [];
      elements[el.id] = el;
      (s.children || []).forEach(c => { const cid = walk(c, el.id); el.children.push(cid); });
      return el.id;
    }
    const rootId = walk(specTree, parentRef || null);
    return { rootId, elements };
  }

  function buildElement(type, opts) {
    const def = TYPES[type];
    if (!def) throw new Error('Unknown element type: ' + type);
    const s = def.build ? def.build(opts || {}) : spec(type, { props: {}, frame: {} });
    return instantiate(s, opts && opts.parent);
  }

  // Deep copy of a subtree with fresh ids (duplicate / paste / components).
  // `elements` is the source map; returns { rootId, elements, idMap }.
  function copySubtree(elements, rootId, newParent) {
    const out = {};
    const idMap = {};
    function walk(id, parent) {
      const src = elements[id];
      if (!src) return null;
      const el = clone(src);
      el.id = uid(src.type === 'option' ? 'opt' : (isQuestionType(src.type) ? 'q' : 'el'));
      idMap[id] = el.id;
      el.parent = parent;
      if (Array.isArray(src.children)) el.children = src.children.map(c => walk(c, el.id)).filter(Boolean);
      if (el.behavior && el.behavior.dataKey) el.behavior.dataKey = undefined;
      out[el.id] = el;
      return el.id;
    }
    const newRoot = walk(rootId, newParent || null);
    return { rootId: newRoot, elements: out, idMap };
  }

  /* ── Survey document ───────────────────────── */
  function createPage(name) {
    return { id: uid('pg'), name: name || 'Page', children: [], minHeight: 640, style: {}, props: {} };
  }

  // A navigation row (Back + Next/Submit) docked under a page's content.
  function navSpec() {
    return spec('container', {
      name: 'Navigation',
      props: { layout: { mode: 'stack', dir: 'h', gap: 12, align: 'center', justify: 'between', wrap: false } },
      frame: { x: 48, y: 32, w: 664, h: 'auto', dock: 'bottom' },
      style: { fill: 'transparent', borderWidth: 0, padding: [0, 0, 0, 0] },
      children: [
        spec('button', { name: 'Back button', props: { text: '', action: { type: 'back' }, autoHide: true },
          frame: { w: 'auto', h: 'auto' }, style: { fill: T('surface'), color: T('text'), borderColor: T('border'), borderWidth: 1, states: { hover: { fill: T('surface2') } } } }),
        spec('button', { name: 'Next / Submit button', props: { text: '', action: { type: 'auto' } }, frame: { w: 'auto', h: 'auto' } })
      ]
    });
  }

  function addTreeToPage(doc, page, tree) {
    Object.assign(doc.elements, tree.elements);
    doc.elements[tree.rootId].parent = 'page:' + page.id;
    doc.elements[tree.rootId].frame.pos = 'free';
    page.children.push(tree.rootId);
    return tree.rootId;
  }

  function addPage(doc, name) {
    const page = createPage(name || 'Page ' + (doc.pages.length + 1));
    doc.pages.push(page);
    addTreeToPage(doc, page, instantiate(navSpec()));
    return page;
  }

  function createSurvey(opts) {
    opts = opts || {};
    const now = new Date().toISOString();
    const doc = {
      schema: SCHEMA,
      id: opts.id || uid('sv'),
      title: opts.title || 'Untitled survey',
      description: opts.description || '',
      settings: {
        width: 760, responsive: 'reflow', reflowBelow: 640,
        showProgress: true, allowBack: true,
        nextLabel: 'Next', backLabel: 'Back', submitLabel: 'Submit',
        completionTitle: 'Thank you!', completionMessage: 'Your response has been recorded.',
        keepHiddenAnswers: false, grid: 8
      },
      theme: { tokens: defaultTokens(), types: {}, page: {} },
      pages: [], elements: {}, variables: [], rules: [], styles: [],
      meta: { createdAt: now, updatedAt: now }
    };
    const page = addPage(doc, 'Page 1');
    if (!opts.empty) {
      const h = buildElement('heading');
      h.elements[h.rootId].props.text = doc.title;
      Object.assign(h.elements[h.rootId].frame, { x: 48, y: 48 });
      addTreeToPage(doc, page, h);
      const p = buildElement('paragraph');
      p.elements[p.rootId].props.text = opts.description || 'Thanks for taking part. This survey takes about two minutes.';
      Object.assign(p.elements[p.rootId].frame, { x: 48, y: 96 });
      addTreeToPage(doc, page, p);
      // Keep the navigation row last in the layer order (on top).
      page.children.push(page.children.shift());
    }
    return doc;
  }

  /* ── Tree helpers ──────────────────────────── */
  function pageIdOfRef(ref) { return typeof ref === 'string' && ref.indexOf('page:') === 0 ? ref.slice(5) : null; }
  function getPage(doc, pageId) { return doc.pages.find(p => p.id === pageId) || null; }
  function childIds(doc, ref) {
    const pid = pageIdOfRef(ref);
    if (pid) { const p = getPage(doc, pid); return p ? p.children : []; }
    const el = doc.elements[ref];
    return el && Array.isArray(el.children) ? el.children : [];
  }
  function pageOf(doc, id) {
    let el = doc.elements[id];
    let guard = 0;
    while (el && guard++ < 1000) {
      const pid = pageIdOfRef(el.parent);
      if (pid) return getPage(doc, pid);
      el = doc.elements[el.parent];
    }
    return null;
  }
  function ancestors(doc, id) {
    const out = [];
    let el = doc.elements[id];
    let guard = 0;
    while (el && el.parent && !pageIdOfRef(el.parent) && guard++ < 1000) {
      out.push(el.parent);
      el = doc.elements[el.parent];
    }
    return out;
  }
  function descendants(doc, id) {
    const out = [];
    const stackIds = [].concat(childIds(doc, id));
    while (stackIds.length) {
      const c = stackIds.shift();
      if (!doc.elements[c]) continue;
      out.push(c);
      const kids = doc.elements[c].children;
      if (Array.isArray(kids)) stackIds.push.apply(stackIds, kids);
    }
    return out;
  }
  function isAncestor(doc, maybeAncestor, id) { return ancestors(doc, id).indexOf(maybeAncestor) !== -1; }
  function questionOf(doc, id) {
    if (doc.elements[id] && isQuestionType(doc.elements[id].type)) return doc.elements[id];
    const a = ancestors(doc, id).find(x => doc.elements[x] && isQuestionType(doc.elements[x].type));
    return a ? doc.elements[a] : null;
  }
  // Elements of a question that belong to it (not to a nested question).
  function questionParts(doc, qid, type) {
    return descendants(doc, qid).filter(id => {
      const el = doc.elements[id];
      if (!el || el.type !== type) return false;
      const q = questionOf(doc, id);
      return q && q.id === qid;
    }).map(id => doc.elements[id]);
  }
  function layoutOf(doc, ref) {
    const pid = pageIdOfRef(ref);
    if (pid) return { mode: 'free' };
    const el = doc.elements[ref];
    const lay = el && el.props && el.props.layout;
    if (!lay) return { mode: 'free' };
    return lay;
  }
  // Questions in page/reading order.
  function questionsInOrder(doc) {
    const out = [];
    doc.pages.forEach(p => {
      const order = (ids) => ids.slice().sort((a, b) => {
        const A = doc.elements[a], B = doc.elements[b];
        if (!A || !B) return 0;
        const ay = num(A.frame.y, 0), by = num(B.frame.y, 0);
        return ay !== by ? ay - by : num(A.frame.x, 0) - num(B.frame.x, 0);
      });
      const walk = ids => order(ids).forEach(id => {
        const el = doc.elements[id];
        if (!el || el.hidden) return;
        if (isQuestionType(el.type)) out.push(el);
        if (Array.isArray(el.children)) walk(el.children);
      });
      walk(p.children);
    });
    return out;
  }
  function displayName(doc, el) {
    if (!el) return '';
    if (el.name) return el.name;
    if (isQuestionType(el.type)) {
      const t = questionParts(doc, el.id, 'qtitle')[0];
      const text = t ? plainText(t.props.text) : '';
      return text ? text.slice(0, 40) : typeLabel(el.type);
    }
    if (el.type === 'option') return 'Option: ' + optionLabel(doc, el);
    if (el.type === 'rankitem' || el.type === 'matrixrow' || el.type === 'tabpanel') return typeLabel(el.type) + ': ' + str(el.props.label).slice(0, 30);
    if (isTextType(el.type) && el.props.text) return plainText(el.props.text).slice(0, 40) || typeLabel(el.type);
    return typeLabel(el.type);
  }
  function optionLabel(doc, opt) {
    const lab = (opt.children || []).map(id => doc.elements[id]).find(c => c && c.type === 'optlabel');
    const text = lab ? plainText(lab.props.text) : '';
    return text || str(opt.props.label) || str(opt.props.value);
  }
  function plainText(s) {
    return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  }
  // Stable answer key per question (used in exports and expressions).
  function dataKeyOf(doc, q) {
    if (q.behavior && q.behavior.dataKey) return q.behavior.dataKey;
    const idx = questionsInOrder(doc).findIndex(x => x.id === q.id);
    return 'q' + (idx >= 0 ? idx + 1 : q.id);
  }

  /* ── Validation / repair ───────────────────── */
  // Never throws and never drops user content: malformed pieces are repaired
  // (missing fields filled in, dangling references removed, orphans
  // re-attached to the first page) and listed in `problems`.
  function normalizeDoc(input) {
    const problems = [];
    let doc = isObj(input) ? clone(input) : {};
    if (!isObj(input)) problems.push('The survey data was empty or unreadable; a new survey was created.');
    const fresh = createSurvey({ empty: true, id: typeof doc.id === 'string' ? doc.id : undefined });
    doc.schema = SCHEMA;
    if (typeof doc.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(doc.id)) doc.id = fresh.id;
    doc.title = str(doc.title, 'Untitled survey').slice(0, 300) || 'Untitled survey';
    doc.description = str(doc.description).slice(0, 5000);
    doc.settings = Object.assign({}, fresh.settings, isObj(doc.settings) ? doc.settings : {});
    doc.settings.width = clamp(num(doc.settings.width, 760), 240, 4000);
    if (!['scale', 'reflow', 'fixed'].includes(doc.settings.responsive)) doc.settings.responsive = 'scale';
    doc.theme = isObj(doc.theme) ? doc.theme : {};
    doc.theme.tokens = Object.assign(defaultTokens(), isObj(doc.theme.tokens) ? doc.theme.tokens : {});
    doc.theme.types = isObj(doc.theme.types) ? doc.theme.types : {};
    doc.theme.page = isObj(doc.theme.page) ? doc.theme.page : {};
    doc.elements = isObj(doc.elements) ? doc.elements : {};
    doc.variables = Array.isArray(doc.variables) ? doc.variables.filter(isObj) : [];
    doc.rules = Array.isArray(doc.rules) ? doc.rules.filter(isObj) : [];
    doc.styles = Array.isArray(doc.styles) ? doc.styles.filter(isObj) : [];
    doc.meta = isObj(doc.meta) ? doc.meta : { createdAt: new Date().toISOString() };

    // Elements
    const ids = Object.keys(doc.elements);
    if (ids.length > LIMITS.elements) problems.push('The survey has more than ' + LIMITS.elements + ' elements.');
    for (const id of ids) {
      let el = doc.elements[id];
      if (!isObj(el)) { delete doc.elements[id]; problems.push('Removed an unreadable element entry (' + id + ').'); continue; }
      el.id = id;
      if (!TYPES[el.type]) { problems.push('Element ' + id + ' has an unknown type "' + el.type + '"; it is shown as a container.'); el.props = Object.assign({}, el.props, { originalType: el.type }); el.type = Array.isArray(el.children) ? 'group' : 'shape'; }
      el.name = str(el.name).slice(0, 200);
      el.props = isObj(el.props) ? el.props : {};
      el.frame = Object.assign(clone(FRAME_DEFAULT), isObj(el.frame) ? el.frame : {});
      const f = el.frame;
      ['x', 'y', 'rot', 'kx', 'ky'].forEach(k => { f[k] = num(f[k], 0); });
      ['sx', 'sy'].forEach(k => { f[k] = num(f[k], 1); });
      ['ox', 'oy'].forEach(k => { f[k] = clamp(num(f[k], 0.5), -2, 3); });
      if (!(typeof f.w === 'number' && Number.isFinite(f.w)) && f.w !== 'auto' && f.w !== 'fill') f.w = num(f.w, 300);
      if (!(typeof f.h === 'number' && Number.isFinite(f.h)) && f.h !== 'auto' && f.h !== 'fill') f.h = num(f.h, 'auto');
      if (typeof f.w === 'number') f.w = clamp(f.w, 0, 20000);
      if (typeof f.h === 'number') f.h = clamp(f.h, 0, 20000);
      el.style = isObj(el.style) ? el.style : {};
      el.behavior = isObj(el.behavior) ? el.behavior : {};
      el.a11y = isObj(el.a11y) ? el.a11y : {};
      el.anim = isObj(el.anim) ? el.anim : {};
      el.responsive = isObj(el.responsive) ? el.responsive : {};
      el.locked = !!el.locked;
      el.hidden = !!el.hidden;
      if (isContainerType(el.type)) el.children = Array.isArray(el.children) ? el.children.filter(c => typeof c === 'string') : [];
      else if (el.children !== undefined) {
        if (Array.isArray(el.children) && el.children.length) { problems.push('Element ' + id + ' (' + el.type + ') had children; it was turned into a group.'); el.props.originalType = el.type; el.type = 'group'; }
        else delete el.children;
      }
      if (isTextType(el.type)) el.props.text = str(el.props.text).slice(0, LIMITS.textLength);
    }

    // Pages
    doc.pages = Array.isArray(doc.pages) ? doc.pages.filter(isObj) : [];
    const seenPages = new Set();
    doc.pages.forEach((p, i) => {
      if (typeof p.id !== 'string' || seenPages.has(p.id)) p.id = uid('pg');
      seenPages.add(p.id);
      p.name = str(p.name, 'Page ' + (i + 1)).slice(0, 200) || 'Page ' + (i + 1);
      p.children = Array.isArray(p.children) ? p.children.filter(c => typeof c === 'string') : [];
      p.minHeight = clamp(num(p.minHeight, 640), 100, 20000);
      p.style = isObj(p.style) ? p.style : {};
      p.props = isObj(p.props) ? p.props : {};
    });
    if (!doc.pages.length) { doc.pages.push(createPage('Page 1')); problems.push('The survey had no pages; one was added.'); }

    // Parent/children consistency: each element appears exactly once.
    const owner = {};
    const claim = (childId, ref) => {
      if (!doc.elements[childId]) return false;
      if (owner[childId]) { problems.push('Element ' + childId + ' was listed twice; the second copy of the reference was removed.'); return false; }
      owner[childId] = ref;
      return true;
    };
    doc.pages.forEach(p => { p.children = p.children.filter(c => claim(c, 'page:' + p.id)); });
    Object.values(doc.elements).forEach(el => { if (el.children) el.children = el.children.filter(c => c !== el.id && claim(c, el.id)); });
    // Cycles: an element that is its own ancestor is re-attached to page 1.
    Object.values(doc.elements).forEach(el => {
      let cur = owner[el.id];
      const seen = new Set([el.id]);
      while (cur && !pageIdOfRef(cur)) {
        if (seen.has(cur)) {
          problems.push('Element ' + el.id + ' was nested inside itself; it was moved to the first page.');
          const parentEl = doc.elements[owner[el.id]];
          if (parentEl && parentEl.children) parentEl.children = parentEl.children.filter(c => c !== el.id);
          owner[el.id] = 'page:' + doc.pages[0].id;
          doc.pages[0].children.push(el.id);
          break;
        }
        seen.add(cur);
        cur = owner[cur];
      }
    });
    Object.values(doc.elements).forEach(el => {
      if (!owner[el.id]) {
        problems.push('Element ' + el.id + ' (' + typeLabel(el.type) + ') wasn\'t on any page; it was placed on the first page.');
        owner[el.id] = 'page:' + doc.pages[0].id;
        doc.pages[0].children.push(el.id);
      }
      el.parent = owner[el.id];
      if (pageIdOfRef(el.parent)) el.frame.pos = 'free';
    });

    // Variables
    const varNames = new Set();
    doc.variables = doc.variables.slice(0, LIMITS.variables).map(v => {
      let name = str(v.name).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'var';
      while (varNames.has(name)) name += '_2';
      varNames.add(name);
      return { id: typeof v.id === 'string' ? v.id : uid('var'), name, type: ['number', 'text', 'boolean'].includes(v.type) ? v.type : 'number',
        initial: v.initial === undefined ? (v.type === 'text' ? '' : v.type === 'boolean' ? false : 0) : v.initial, formula: str(v.formula).slice(0, 2000) };
    });
    // Rules (shape only; references are checked by the editor's problem list)
    doc.rules = doc.rules.slice(0, LIMITS.rules).map((r, i) => ({
      id: typeof r.id === 'string' ? r.id : uid('rule'),
      name: str(r.name, 'Rule ' + (i + 1)).slice(0, 200),
      enabled: r.enabled !== false,
      trigger: isObj(r.trigger) && typeof r.trigger.type === 'string' ? r.trigger : { type: 'always' },
      when: isObj(r.when) ? normalizeGroup(r.when) : { op: 'all', items: [] },
      then: Array.isArray(r.then) ? r.then.filter(isObj) : [],
      else: Array.isArray(r.else) ? r.else.filter(isObj) : [],
      // block editor: where the script sits on the workspace; a loose reporter/boolean block
      ...(isObj(r.ui) ? { ui: { x: clamp(num(r.ui.x, 0), -5000, 50000), y: clamp(num(r.ui.y, 0), -5000, 50000) } } : {}),
      ...(isObj(r.loose) ? { loose: r.loose } : {})
    }));
    doc.styles = doc.styles.map(s => ({ id: typeof s.id === 'string' ? s.id : uid('sty'), name: str(s.name, 'Style').slice(0, 120), style: isObj(s.style) ? s.style : {} }));

    // Unique answer keys
    const keys = new Set();
    Object.values(doc.elements).forEach(el => {
      if (!isQuestionType(el.type)) return;
      let k = str(el.behavior.dataKey).replace(/[^A-Za-z0-9_]/g, '_');
      if (!k) return;
      if (keys.has(k)) { problems.push('Two questions used the answer key "' + k + '"; one was renamed.'); let n = 2; while (keys.has(k + '_' + n)) n++; k = k + '_' + n; }
      keys.add(k);
      el.behavior.dataKey = k;
    });
    return { doc, problems };
  }
  function normalizeGroup(g) {
    // null items are empty boolean slots in and/or/not blocks
    return { op: ['any', 'not'].includes(g.op) ? g.op : 'all', items: Array.isArray(g.items) ? g.items.filter(it => it === null || isObj(it)).map(it => (it && isObj(it.group) ? Object.assign({}, it, { group: normalizeGroup(it.group) }) : it)) : [] };
  }

  /* ── Styles ────────────────────────────────── */
  function builtinStyle(type) { return TYPES[type] ? TYPES[type].style || {} : {}; }
  // Style the element would have without its own overrides.
  function inheritedStyle(doc, el) {
    return deepMerge(builtinStyle(el.type), (doc.theme && doc.theme.types && doc.theme.types[el.type]) || {});
  }
  function resolveStyle(doc, el) { return deepMerge(inheritedStyle(doc, el), el.style || {}); }

  const STATE_NAMES = ['hover', 'focus', 'active', 'checked', 'disabled'];

  function px(v) { return typeof v === 'number' ? v + 'px' : String(v); }
  function box4(v) {
    if (Array.isArray(v)) return v.slice(0, 4).map(x => px(num(x, 0))).join(' ');
    if (typeof v === 'number') return v + 'px';
    return null;
  }
  function cleanValue(v) {
    // A single CSS value: no rule/declaration breakers, no script URLs.
    let s = String(v === undefined || v === null ? '' : v).replace(/[{};<>\\]/g, '').replace(/\/\*/g, '').slice(0, 2000);
    if (/expression\s*\(|javascript:|@import|behavior\s*:/i.test(s)) return '';
    return s.trim();
  }
  // Free-form declarations typed by the user ("Custom CSS").
  function cleanCss(text) {
    return String(text || '').split(/;|\n/).map(d => d.trim()).filter(Boolean).map(d => {
      const i = d.indexOf(':');
      if (i <= 0) return null;
      const prop = d.slice(0, i).trim().toLowerCase();
      if (!/^-?[a-z][a-z0-9-]*$/.test(prop) && !/^--[a-z0-9-]+$/.test(prop)) return null;
      const val = cleanValue(d.slice(i + 1));
      return val ? prop + ':' + val : null;
    }).filter(Boolean).join(';');
  }
  function safeUrl(u, kinds) {
    const s = String(u || '').trim();
    if (!s) return '';
    kinds = kinds || ['http', 'https'];
    if (/^https?:\/\//i.test(s)) return (kinds.includes('https') && /^https:/i.test(s)) || (kinds.includes('http')) ? s : '';
    if (kinds.includes('data-image') && /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s.replace(/\s/g, '');
    if (kinds.includes('relative') && /^\/[^/\\]/.test(s)) return s;
    if (kinds.includes('mailto') && /^mailto:[^\s"'<>]+$/i.test(s)) return s;
    return '';
  }
  const CLIP_SHAPES = {
    circle: 'circle(50% at 50% 50%)', ellipse: 'ellipse(50% 50% at 50% 50%)',
    triangle: 'polygon(50% 0%, 100% 100%, 0% 100%)', diamond: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
    pentagon: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)', hexagon: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
    star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
    arrow: 'polygon(0% 30%, 60% 30%, 60% 0%, 100% 50%, 60% 100%, 60% 70%, 0% 70%)',
    message: 'polygon(0% 0%, 100% 0%, 100% 75%, 75% 75%, 75% 100%, 50% 75%, 0% 75%)',
    parallelogram: 'polygon(25% 0%, 100% 0%, 75% 100%, 0% 100%)'
  };
  const MASKS = {
    'fade-bottom': 'linear-gradient(to bottom, #000 55%, transparent)', 'fade-top': 'linear-gradient(to top, #000 55%, transparent)',
    'fade-left': 'linear-gradient(to left, #000 55%, transparent)', 'fade-right': 'linear-gradient(to right, #000 55%, transparent)',
    radial: 'radial-gradient(circle at center, #000 45%, transparent 72%)'
  };

  // style object → list of CSS declarations (a "rule body").
  function styleDecls(s, opts) {
    opts = opts || {};
    const d = [];
    const add = (p, v) => { if (v === undefined || v === null || v === '') return; const c = cleanValue(v); if (c !== '') d.push(p + ':' + c); };
    if (s.fill !== undefined) { add('background', s.fill); add('--sv-fill-c', s.fill); }
    if (s.fillImage) {
      const u = safeUrl(s.fillImage, ['https', 'http', 'data-image', 'relative']);
      if (u) { d.push('background-image:url("' + u.replace(/"/g, '%22') + '")'); add('background-size', s.fillSize || 'cover'); add('background-position', s.fillPosition || 'center'); add('background-repeat', s.fillRepeat || 'no-repeat'); }
    }
    if (s.borderWidth !== undefined) { add('border-width', num(s.borderWidth, 0) + 'px'); add('border-style', s.borderStyle || 'solid'); }
    else if (s.borderStyle !== undefined) add('border-style', s.borderStyle);
    if (s.borderColor !== undefined) { add('border-color', s.borderColor); add('--sv-stroke-c', s.borderColor); }
    [['bT', 'top'], ['bR', 'right'], ['bB', 'bottom'], ['bL', 'left']].forEach(([k, side]) => {
      if (s[k] !== undefined) { add('border-' + side + '-width', num(s[k], 0) + 'px'); add('border-' + side + '-style', s.borderStyle || 'solid'); if (s.borderColor !== undefined) add('border-' + side + '-color', s.borderColor); }
    });
    if (s.radius !== undefined) add('border-radius', typeof s.radius === 'number' ? s.radius + 'px' : s.radius);
    [['rTL', 'top-left'], ['rTR', 'top-right'], ['rBR', 'bottom-right'], ['rBL', 'bottom-left']].forEach(([k, c]) => { if (s[k] !== undefined) add('border-' + c + '-radius', px(s[k])); });
    if (s.opacity !== undefined) add('opacity', clamp(num(s.opacity, 1), 0, 1));
    if (Array.isArray(s.shadows)) {
      const sh = s.shadows.filter(isObj).map(x => (x.inset ? 'inset ' : '') + num(x.x, 0) + 'px ' + num(x.y, 0) + 'px ' + num(x.blur, 0) + 'px ' + num(x.spread, 0) + 'px ' + cleanValue(x.color || 'rgba(0,0,0,.15)'));
      add('box-shadow', sh.length ? sh.join(', ') : 'none');
    }
    const filters = [];
    if (num(s.blur, 0)) filters.push('blur(' + num(s.blur, 0) + 'px)');
    [['brightness', '%'], ['contrast', '%'], ['saturate', '%'], ['grayscale', '%'], ['sepia', '%'], ['invert', '%']].forEach(([k, u]) => {
      if (s[k] !== undefined && s[k] !== null && s[k] !== '') filters.push(k + '(' + num(s[k], k === 'grayscale' || k === 'sepia' || k === 'invert' ? 0 : 100) + u + ')');
    });
    if (num(s.hue, 0)) filters.push('hue-rotate(' + num(s.hue, 0) + 'deg)');
    if (s.dropShadow) filters.push('drop-shadow(' + cleanValue(s.dropShadow) + ')');
    if (filters.length) add('filter', filters.join(' '));
    if (num(s.backdropBlur, 0)) add('backdrop-filter', 'blur(' + num(s.backdropBlur, 0) + 'px)');
    if (s.blend) add('mix-blend-mode', s.blend);
    if (s.color !== undefined) add('color', s.color);
    if (s.fontFamily !== undefined) add('font-family', s.fontFamily);
    if (s.fontSize !== undefined) add('font-size', px(s.fontSize));
    if (s.fontWeight !== undefined) add('font-weight', s.fontWeight);
    if (s.fontStyle !== undefined) add('font-style', s.fontStyle);
    if (s.lineHeight !== undefined) add('line-height', s.lineHeight);
    if (s.letterSpacing !== undefined) add('letter-spacing', px(s.letterSpacing));
    if (s.textAlign !== undefined) { add('text-align', s.textAlign); add('--sv-text-align', s.textAlign); }
    if (s.textTransform !== undefined) add('text-transform', s.textTransform);
    if (s.textDecoration !== undefined) add('text-decoration', s.textDecoration);
    if (s.textShadow) add('text-shadow', s.textShadow);
    if (s.whiteSpace) add('white-space', s.whiteSpace);
    if (s.vAlign) add('--sv-valign', { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[s.vAlign] || 'flex-start');
    const pad = box4(s.padding); if (pad) add('padding', pad);
    const mar = box4(s.margin); if (mar) add('margin', mar);
    if (s.overflow) add('overflow', s.overflow);
    if (s.cursor) add('cursor', s.cursor);
    if (s.markColor !== undefined) add('--sv-mark', s.markColor);
    if (s.placeholderColor !== undefined) add('--sv-placeholder', s.placeholderColor);
    if (s.trackColor !== undefined) add('--sv-track', s.trackColor);
    if (s.thumbColor !== undefined) { add('--sv-thumb', s.thumbColor); add('accent-color', s.thumbColor); }
    if (s.scale !== undefined) add('scale', num(s.scale, 1));
    if (s.transition !== undefined) add('transition', 'background ' + num(s.transition, 0) + 'ms, color ' + num(s.transition, 0) + 'ms, border-color ' + num(s.transition, 0) + 'ms, box-shadow ' + num(s.transition, 0) + 'ms, opacity ' + num(s.transition, 0) + 'ms, scale ' + num(s.transition, 0) + 'ms, filter ' + num(s.transition, 0) + 'ms');
    if (isObj(s.clip) && s.clip.shape && s.clip.shape !== 'none') {
      let cp = CLIP_SHAPES[s.clip.shape];
      if (s.clip.shape === 'inset') cp = 'inset(' + [s.clip.t, s.clip.r, s.clip.b, s.clip.l].map(v => num(v, 0) + '%').join(' ') + ' round ' + num(s.clip.round, 0) + 'px)';
      if (s.clip.shape === 'polygon' && typeof s.clip.points === 'string' && /^[\d.%\s,pxem-]+$/.test(s.clip.points)) cp = 'polygon(' + s.clip.points + ')';
      if (cp) { add('clip-path', cp); add('-webkit-clip-path', cp); }
    }
    if (s.mask && MASKS[s.mask]) { add('mask-image', MASKS[s.mask]); add('-webkit-mask-image', MASKS[s.mask]); }
    if (s.css && !opts.noCustom) { const c = cleanCss(s.css); if (c) d.push(c); }
    return d;
  }

  // Tokens → CSS custom properties.
  function tokenDecls(doc) {
    const t = Object.assign(defaultTokens(), (doc.theme && doc.theme.tokens) || {});
    return TOKENS.map(x => '--sv-' + x.key + ':' + cleanValue(x.kind === 'size' ? num(t[x.key], x.value) + 'px' : t[x.key])).join(';');
  }

  // Full CSS for one element: base rule + one rule per interaction state.
  // `scope` is a selector for the survey root, e.g. '.sv-root[data-sv="abc"]'.
  function elementCss(doc, el, scope) {
    const s = resolveStyle(doc, el);
    const sel = scope + ' [data-svid="' + el.id + '"]';
    let css = sel + '{' + styleDecls(s).join(';') + '}';
    const states = isObj(s.states) ? s.states : {};
    const host = scope + ' .sv-hover-host';
    STATE_NAMES.forEach(st => {
      const body = isObj(states[st]) ? styleDecls(states[st]) : [];
      if (!body.length) return;
      const own = '[data-svid="' + el.id + '"]';
      let sels;
      if (st === 'hover') sels = [sel + ':hover', host + ':hover ' + own, scope + ' .sv-force-hover' + own, scope + ' .sv-force-hover ' + own];
      else if (st === 'focus') sels = [sel + ':focus-within', host + ':focus-within ' + own, scope + ' .sv-force-focus' + own, scope + ' .sv-force-focus ' + own];
      else if (st === 'active') sels = [sel + ':active', host + ':active ' + own, scope + ' .sv-force-active' + own];
      else if (st === 'checked') sels = [scope + ' .is-checked' + own, scope + ' .is-checked ' + own];
      else sels = [scope + ' .is-disabled' + own, scope + ' .is-disabled ' + own];
      css += sels.join(',') + '{' + body.join(';') + '}';
    });
    return css;
  }

  /* ── Geometry ──────────────────────────────── */
  const RAD = Math.PI / 180;
  // Linear part of rotate(r) skew(kx,ky) scale(sx,sy) as [a, b, c, d]
  // (x' = a·x + c·y, y' = b·x + d·y) — the same order CSS applies.
  function frameLinear(f) {
    const r = num(f.rot, 0) * RAD, cos = Math.cos(r), sin = Math.sin(r);
    const tx = Math.tan(num(f.kx, 0) * RAD), ty = Math.tan(num(f.ky, 0) * RAD);
    const sx = num(f.sx, 1), sy = num(f.sy, 1);
    // skew matrix K = [1 tx; ty 1]; S = diag(sx, sy); R = [cos -sin; sin cos]
    const k = [1, ty, tx, 1];
    const ks = [k[0] * sx, k[1] * sx, k[2] * sy, k[3] * sy];
    return [cos * ks[0] - sin * ks[1], sin * ks[0] + cos * ks[1], cos * ks[2] - sin * ks[3], sin * ks[2] + cos * ks[3]];
  }
  function applyLinear(m, x, y) { return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y }; }
  function invertLinear(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-9) return [1, 0, 0, 1];
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  }
  // Maps a point in the element's own box (lx, ly) to its parent's space.
  function localToParent(f, w, h, lx, ly) {
    const m = frameLinear(f);
    const ox = num(f.ox, 0.5) * w, oy = num(f.oy, 0.5) * h;
    const p = applyLinear(m, lx - ox, ly - oy);
    return { x: num(f.x, 0) + ox + p.x, y: num(f.y, 0) + oy + p.y };
  }

  // 4-corner distortion → CSS matrix3d (homography of the box onto the quad).
  function distortMatrix(w, h, d) {
    if (!isObj(d) || !(w > 0) || !(h > 0)) return null;
    const c = k => (Array.isArray(d[k]) ? [num(d[k][0], 0), num(d[k][1], 0)] : [0, 0]);
    const [tl, tr, br, bl] = [c('tl'), c('tr'), c('br'), c('bl')];
    if (![tl, tr, br, bl].some(p => p[0] || p[1])) return null;
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const dst = [[tl[0], tl[1]], [w + tr[0], tr[1]], [w + br[0], h + br[1]], [bl[0], h + bl[1]]];
    // Solve for the 8 unknowns of H (h8 = 1).
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    const H = solve(A, B);
    if (!H) return null;
    // H = [h0 h1 h2; h3 h4 h5; h6 h7 1] → column-major 4×4
    const m = [H[0], H[3], 0, H[6], H[1], H[4], 0, H[7], 0, 0, 1, 0, H[2], H[5], 0, 1];
    if (m.some(v => !Number.isFinite(v))) return null;
    return 'matrix3d(' + m.map(v => +v.toFixed(8)).join(',') + ')';
  }
  function solve(A, B) {
    const n = B.length;
    const M = A.map((r, i) => r.concat([B[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }

  // CSS transform for a frame (transform-origin is always 0 0; the origin is
  // built in so percentages work for auto-sized elements).
  function transformCss(f, size) {
    const parts = [];
    const ox = num(f.ox, 0.5) * 100, oy = num(f.oy, 0.5) * 100;
    const rx = num(f.rx, 0), ry = num(f.ry, 0), persp = num(f.persp, 0);
    const lin = num(f.rot, 0) || num(f.kx, 0) || num(f.ky, 0) || num(f.sx, 1) !== 1 || num(f.sy, 1) !== 1 || rx || ry;
    if (lin) {
      parts.push('translate(' + ox + '%,' + oy + '%)');
      if (rx || ry) { if (persp) parts.push('perspective(' + persp + 'px)'); if (rx) parts.push('rotateX(' + rx + 'deg)'); if (ry) parts.push('rotateY(' + ry + 'deg)'); }
      if (num(f.rot, 0)) parts.push('rotate(' + num(f.rot, 0) + 'deg)');
      if (num(f.kx, 0) || num(f.ky, 0)) parts.push('skew(' + num(f.kx, 0) + 'deg,' + num(f.ky, 0) + 'deg)');
      if (num(f.sx, 1) !== 1 || num(f.sy, 1) !== 1) parts.push('scale(' + num(f.sx, 1) + ',' + num(f.sy, 1) + ')');
      parts.push('translate(' + (-ox) + '%,' + (-oy) + '%)');
    }
    if (f.distort && size) { const m = distortMatrix(size.w, size.h, f.distort); if (m) parts.push(m); }
    return parts.length ? parts.join(' ') : 'none';
  }

  /* ── Rich text sanitizer (string based, works in Node too) ───────────── */
  const ALLOWED_TAGS = { b: 1, strong: 1, i: 1, em: 1, u: 1, s: 1, br: 1, p: 1, ul: 1, ol: 1, li: 1, a: 1, span: 1, div: 1, sub: 1, sup: 1, h1: 1, h2: 1, h3: 1, h4: 1, blockquote: 1, code: 1, mark: 1 };
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function sanitizeHtml(html) {
    const src = String(html || '').slice(0, LIMITS.textLength);
    let out = '';
    const open = [];
    const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|<!--[\s\S]*?-->|([^<]+)|(<)/g;
    let m;
    let skipUntil = null;
    while ((m = re.exec(src))) {
      if (m[3] !== undefined || m[4] !== undefined) { if (!skipUntil) out += escapeHtml(decodeEntities(m[3] !== undefined ? m[3] : '<')); continue; }
      if (!m[1]) continue;
      const tag = m[1].toLowerCase();
      const closing = m[0][1] === '/';
      if (skipUntil) { if (closing && tag === skipUntil) skipUntil = null; continue; }
      if (!closing && (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'template' || tag === 'svg' || tag === 'math')) { if (!/\/\s*$/.test(m[2])) skipUntil = tag; continue; }
      if (!ALLOWED_TAGS[tag]) continue;
      if (closing) {
        const idx = open.lastIndexOf(tag);
        if (idx === -1) continue;
        while (open.length > idx) out += '</' + open.pop() + '>';
        continue;
      }
      let attrs = '';
      if (tag === 'a') {
        const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[2]);
        const url = href ? safeUrl(decodeEntities(href[2] || href[3] || href[4] || ''), ['https', 'http', 'mailto']) : '';
        if (url) attrs += ' href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer"';
      }
      const style = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[2]);
      if (style && (tag === 'span' || tag === 'p' || tag === 'div' || tag === 'mark')) {
        const allowed = cleanCss(decodeEntities(style[2] || style[3] || '')).split(';').filter(dcl => /^(color|background-color|font-weight|font-style|text-decoration|font-size|text-align)\s*:/.test(dcl)).join(';');
        if (allowed) attrs += ' style="' + escapeHtml(allowed) + '"';
      }
      if (tag === 'br') { out += '<br>'; continue; }
      out += '<' + tag + attrs + '>';
      open.push(tag);
    }
    while (open.length) out += '</' + open.pop() + '>';
    return out;
  }
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m0, e) => {
      const k = e.toLowerCase();
      if (k[0] === '#') { const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''; }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
    });
  }

  // Embeddable media: YouTube / Vimeo pages → their embed URLs.
  function videoEmbedUrl(src) {
    const s = String(src || '').trim();
    let m = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{6,20})/.exec(s);
    if (m) return 'https://www.youtube-nocookie.com/embed/' + m[1];
    m = /^https?:\/\/(?:www\.)?vimeo\.com\/(?:video\/)?(\d{4,15})/.exec(s);
    if (m) return 'https://player.vimeo.com/video/' + m[1];
    return null;
  }

  return {
    SCHEMA, LIMITS, TOKENS, TOKEN_KEYS, FONTS, CATEGORIES, TYPES, ICONS, STATE_NAMES, FRAME_DEFAULT, CLIP_SHAPES, MASKS,
    uid, clone, isObj, num, clamp, str, deepMerge, getPath, setPath, slug,
    registerType, getType, typeLabel, isQuestionType, isContainerType, isTextType,
    defaultTokens, tokenVar, createSurvey, createPage, addPage, navSpec, buildElement, instantiate, copySubtree, spec,
    pageIdOfRef, getPage, childIds, pageOf, ancestors, descendants, isAncestor, questionOf, questionParts, layoutOf,
    questionsInOrder, displayName, optionLabel, plainText, dataKeyOf,
    normalizeDoc, builtinStyle, inheritedStyle, resolveStyle, styleDecls, tokenDecls, elementCss, cleanCss, cleanValue, safeUrl,
    frameLinear, applyLinear, invertLinear, localToParent, distortMatrix, transformCss,
    sanitizeHtml, escapeHtml, decodeEntities, videoEmbedUrl
  };
});
