/* ══════════════════════════════════════════════
   survey-fonts.js — the font library for survey themes

   A curated catalog of Google Fonts (plus the system fonts every device
   has), the loader that makes a chosen font actually render, and the
   searchable font picker used by the Theme page and the inspector.

   • Every catalog family is loaded from the Google Fonts CSS API with
     weights 400–700 (the API returns the weights a family has), so a font
     chosen here renders in the editor, the preview and the published
     survey alike. test/survey-fonts.test.js checks every name against the
     API's naming rules; the list was verified against the live API.
   • A font value is a CSS font-family stack: "'Lora', serif". Values that
     aren't in the catalog (older surveys, typed stacks) keep working —
     they're just not loaded from Google.
   • SurveyFonts.ensureDoc(doc) loads every catalog font a survey uses
     (theme tokens, element defaults, element styles).
   ══════════════════════════════════════════════ */
(function (root) {
  'use strict';

  // name|category|tags   category: sans, serif, mono, display, hand
  // tags: humanist, geometric, grotesque, rounded, condensed, slab, legible
  const RAW = [
    // ── Sans-serif ──
    'Inter|sans|grotesque legible', 'Roboto|sans|grotesque', 'Open Sans|sans|humanist legible', 'Lato|sans|humanist', 'Montserrat|sans|geometric',
    'Poppins|sans|geometric', 'Source Sans 3|sans|humanist legible', 'Noto Sans|sans|humanist legible', 'Raleway|sans|geometric', 'Nunito|sans|rounded',
    'Nunito Sans|sans|humanist', 'Work Sans|sans|grotesque', 'IBM Plex Sans|sans|grotesque', 'PT Sans|sans|humanist', 'Fira Sans|sans|humanist',
    'Ubuntu|sans|humanist', 'Rubik|sans|rounded', 'Karla|sans|grotesque', 'Mulish|sans|geometric', 'Manrope|sans|geometric',
    'DM Sans|sans|geometric', 'Plus Jakarta Sans|sans|geometric', 'Outfit|sans|geometric', 'Urbanist|sans|geometric', 'Lexend|sans|geometric legible',
    'Figtree|sans|geometric', 'Sora|sans|geometric', 'Space Grotesk|sans|grotesque', 'Josefin Sans|sans|geometric', 'Jost|sans|geometric',
    'Quicksand|sans|rounded geometric', 'Questrial|sans|geometric', 'Albert Sans|sans|geometric', 'Be Vietnam Pro|sans|grotesque', 'Epilogue|sans|grotesque',
    'Archivo|sans|grotesque', 'Barlow|sans|grotesque', 'Barlow Condensed|sans|condensed', 'Oswald|sans|condensed', 'Roboto Condensed|sans|condensed',
    'Fjalla One|sans|condensed', 'Saira|sans|geometric', 'Hanken Grotesk|sans|grotesque', 'Schibsted Grotesk|sans|grotesque', 'Onest|sans|grotesque',
    'Golos Text|sans|grotesque legible', 'Geologica|sans|geometric', 'Instrument Sans|sans|grotesque', 'Bricolage Grotesque|sans|grotesque', 'Familjen Grotesk|sans|grotesque',
    'Chivo|sans|grotesque', 'Archivo Narrow|sans|condensed', 'Antonio|sans|condensed', 'League Spartan|sans|geometric', 'Kumbh Sans|sans|geometric',
    'Red Hat Display|sans|geometric', 'Red Hat Text|sans|humanist legible', 'Gothic A1|sans|grotesque', 'Atkinson Hyperlegible|sans|legible', 'Lexend Deca|sans|geometric legible',
    'Readex Pro|sans|geometric legible', 'Tenor Sans|sans|humanist', 'Didact Gothic|sans|geometric', 'Varela Round|sans|rounded', 'Maven Pro|sans|geometric',
    'Signika|sans|humanist', 'Abel|sans|condensed', 'Dosis|sans|rounded condensed', 'Rajdhani|sans|condensed', 'Exo 2|sans|geometric',
    'Titillium Web|sans|geometric', 'Cabin|sans|humanist', 'Hind|sans|humanist', 'Mukta|sans|humanist', 'Oxygen|sans|humanist',
    'Assistant|sans|humanist', 'Catamaran|sans|humanist', 'Merriweather Sans|sans|humanist', 'Alegreya Sans|sans|humanist', 'Encode Sans|sans|grotesque',
    'Libre Franklin|sans|grotesque', 'Public Sans|sans|grotesque legible', 'Overpass|sans|grotesque', 'Asap|sans|humanist', 'Heebo|sans|grotesque',
    'Kanit|sans|geometric', 'Prompt|sans|geometric', 'Sarabun|sans|humanist', 'M PLUS Rounded 1c|sans|rounded', 'Noto Sans Display|sans|humanist',
    'Roboto Flex|sans|grotesque', 'Istok Web|sans|humanist', 'Teko|sans|condensed', 'Play|sans|geometric', 'Wix Madefor Text|sans|grotesque legible',
    // ── Serif ──
    'Merriweather|serif|legible', 'Playfair Display|serif|', 'Lora|serif|', 'PT Serif|serif|legible', 'Libre Baskerville|serif|',
    'EB Garamond|serif|', 'Cormorant Garamond|serif|', 'Crimson Text|serif|', 'Crimson Pro|serif|', 'Source Serif 4|serif|legible',
    'Noto Serif|serif|legible', 'Roboto Serif|serif|', 'Roboto Slab|serif|slab', 'Zilla Slab|serif|slab', 'Arvo|serif|slab',
    'Bitter|serif|slab legible', 'Domine|serif|', 'Spectral|serif|', 'Cardo|serif|', 'Old Standard TT|serif|',
    'Alegreya|serif|humanist', 'Vollkorn|serif|', 'Gelasio|serif|', 'Literata|serif|legible', 'Newsreader|serif|',
    'Fraunces|serif|', 'DM Serif Display|serif|', 'DM Serif Text|serif|', 'Bodoni Moda|serif|', 'Libre Caslon Text|serif|',
    'Libre Bodoni|serif|', 'Cormorant|serif|', 'Frank Ruhl Libre|serif|', 'Noticia Text|serif|', 'Josefin Slab|serif|slab',
    'Prata|serif|', 'Rokkitt|serif|slab', 'Martel|serif|', 'Tinos|serif|', 'IBM Plex Serif|serif|',
    'Young Serif|serif|', 'Instrument Serif|serif|', 'Brygada 1918|serif|', 'Petrona|serif|', 'Besley|serif|',
    'Sorts Mill Goudy|serif|', 'Cinzel|serif|', 'Marcellus|serif|', 'Gentium Book Plus|serif|legible', 'Lustria|serif|',
    'Rufina|serif|', 'Neuton|serif|', 'Halant|serif|', 'Amiri|serif|', 'Kreon|serif|slab',
    // ── Monospace ──
    'JetBrains Mono|mono|', 'Fira Code|mono|', 'Source Code Pro|mono|', 'IBM Plex Mono|mono|', 'Roboto Mono|mono|',
    'Space Mono|mono|', 'Inconsolata|mono|', 'Ubuntu Mono|mono|', 'PT Mono|mono|', 'Courier Prime|mono|',
    'Anonymous Pro|mono|', 'Overpass Mono|mono|', 'Red Hat Mono|mono|', 'DM Mono|mono|', 'Noto Sans Mono|mono|',
    'Cousine|mono|', 'Azeret Mono|mono|', 'Martian Mono|mono|', 'Victor Mono|mono|', 'Sometype Mono|mono|',
    'Share Tech Mono|mono|', 'Major Mono Display|mono|',
    // ── Display ──
    'Bebas Neue|display|condensed', 'Anton|display|condensed', 'Archivo Black|display|grotesque', 'Righteous|display|rounded', 'Lobster|display|',
    'Bungee|display|', 'Russo One|display|', 'Black Ops One|display|', 'Passion One|display|', 'Alfa Slab One|display|slab',
    'Abril Fatface|display|', 'Shrikhand|display|', 'Fredoka|display|rounded', 'Baloo 2|display|rounded', 'Chewy|display|',
    'Bangers|display|', 'Monoton|display|', 'Press Start 2P|display|', 'Audiowide|display|', 'Syne|display|geometric',
    'Unbounded|display|geometric', 'Krona One|display|geometric', 'Dela Gothic One|display|', 'Rubik Mono One|display|', 'Bowlby One|display|',
    'Titan One|display|rounded', 'Luckiest Guy|display|', 'Staatliches|display|condensed', 'Big Shoulders Display|display|condensed', 'Six Caps|display|condensed',
    'Poiret One|display|geometric', 'Comfortaa|display|rounded geometric', 'Lilita One|display|rounded', 'Paytone One|display|', 'Concert One|display|rounded',
    'Secular One|display|', 'Gloock|display|', 'Rozha One|display|', 'Cinzel Decorative|display|', 'Limelight|display|',
    'Yeseva One|display|', 'Ultra|display|slab', 'Orbitron|display|geometric', 'Michroma|display|geometric', 'Exo|display|geometric',
    'Bungee Shade|display|', 'Fascinate|display|', 'Rammetto One|display|', 'Climate Crisis|display|', 'Bagel Fat One|display|rounded',
    // ── Handwriting & script ──
    'Caveat|hand|', 'Dancing Script|hand|', 'Pacifico|hand|', 'Satisfy|hand|', 'Great Vibes|hand|',
    'Indie Flower|hand|', 'Shadows Into Light|hand|', 'Amatic SC|hand|condensed', 'Kalam|hand|', 'Patrick Hand|hand|',
    'Architects Daughter|hand|', 'Sacramento|hand|', 'Kaushan Script|hand|', 'Courgette|hand|', 'Cookie|hand|',
    'Parisienne|hand|', 'Homemade Apple|hand|', 'Gloria Hallelujah|hand|', 'Rock Salt|hand|', 'Nothing You Could Do|hand|',
    'Reenie Beanie|hand|', 'Covered By Your Grace|hand|', 'Gochi Hand|hand|', 'Handlee|hand|', 'Coming Soon|hand|',
    'Yellowtail|hand|', 'Allura|hand|', 'Alex Brush|hand|', 'Marck Script|hand|', 'Mr Dafoe|hand|',
    'La Belle Aurore|hand|', 'Zeyada|hand|', 'Permanent Marker|hand|', 'Delius|hand|rounded', 'Itim|hand|rounded'
  ];

  const CATEGORIES = [
    { id: 'all', label: 'All' },
    { id: 'sans', label: 'Sans-serif' },
    { id: 'serif', label: 'Serif' },
    { id: 'mono', label: 'Monospace' },
    { id: 'display', label: 'Display' },
    { id: 'humanist', label: 'Humanist', tag: true },
    { id: 'geometric', label: 'Modern & geometric', tag: true },
    { id: 'legible', label: 'Highly legible', tag: true },
    { id: 'hand', label: 'Handwriting' },
    { id: 'system', label: 'System' }
  ];
  const FALLBACK = { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'monospace', display: 'system-ui, sans-serif', hand: 'cursive' };

  const quote = name => "'" + name.replace(/'/g, '') + "'";
  const FONTS = RAW.map(line => {
    const [name, cat, tags] = line.split('|');
    return { name, category: cat, tags: (tags || '').split(' ').filter(Boolean), google: true, value: quote(name) + ', ' + FALLBACK[cat] };
  });
  // Fonts every device has (nothing to load)
  const SYSTEM = [
    { name: 'System UI', value: 'system-ui, sans-serif' },
    { name: 'Arial / Helvetica', value: 'Arial, Helvetica, sans-serif' },
    { name: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
    { name: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
    { name: 'Georgia', value: 'Georgia, serif' },
    { name: 'Times New Roman', value: "'Times New Roman', Times, serif" },
    { name: 'Courier New', value: "'Courier New', monospace" }
  ].map(f => Object.assign({ category: 'system', tags: [], google: false }, f));
  const ALL = FONTS.concat(SYSTEM);
  const BY_NAME = new Map(ALL.map(f => [f.name.toLowerCase(), f]));

  /** The first family named in a CSS font-family stack: "'Lora', serif" → "Lora". */
  function familyOf(value) {
    const s = String(value || '').trim();
    if (!s || /^var\(/.test(s)) return null;
    const first = s.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    return first || null;
  }
  /** The catalog entry for a font-family value, or null. */
  function find(value) {
    const fam = familyOf(value);
    if (!fam) return null;
    const exact = ALL.find(f => f.value === value);
    return exact || BY_NAME.get(fam.toLowerCase()) || null;
  }
  const cssUrl = (name, text) => 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name).replace(/%20/g, '+') +
    (text ? '&text=' + encodeURIComponent(text) : ':wght@400;500;600;700&display=swap');

  const loaded = new Set();
  function addLink(href, id) {
    if (typeof document === 'undefined' || loaded.has(id)) return;
    loaded.add(id);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.surveyFont = id;
    document.head.appendChild(link);
  }
  /** Loads a font (by CSS value or name) so text using it renders. Returns true if it's a web font. */
  function ensure(value) {
    const f = find(value) || BY_NAME.get(String(value || '').toLowerCase());
    if (!f || !f.google) return false;
    addLink(cssUrl(f.name), 'full:' + f.name);
    return true;
  }
  /** Loads just the glyphs of a font's name, for previews in the picker. */
  function ensurePreview(f) { if (f && f.google) addLink(cssUrl(f.name, f.name), 'name:' + f.name); }

  /** Every font-family value a survey uses. */
  function usedIn(doc) {
    const out = new Set();
    if (!doc || typeof doc !== 'object') return out;
    const tokens = (doc.theme && doc.theme.tokens) || {};
    ['fontBody', 'fontDisplay', 'fontMono'].forEach(k => { if (tokens[k]) out.add(tokens[k]); });
    const walk = st => {
      if (!st || typeof st !== 'object') return;
      if (typeof st.fontFamily === 'string') out.add(st.fontFamily);
      if (st.states && typeof st.states === 'object') Object.values(st.states).forEach(walk);
    };
    Object.values((doc.theme && doc.theme.types) || {}).forEach(walk);
    Object.values(doc.elements || {}).forEach(el => walk(el && el.style));
    (doc.styles || []).forEach(s => walk(s && s.style));
    return out;
  }
  function ensureDoc(doc) { let n = 0; usedIn(doc).forEach(v => { if (ensure(v)) n++; }); return n; }

  // Style words people search for → a category or tag ("serif" must not match "sans-serif").
  const STYLE_WORDS = { serif: ['cat', 'serif'], serifs: ['cat', 'serif'], 'sans-serif': ['cat', 'sans'], sans: ['cat', 'sans'], 'sans serif': ['cat', 'sans'],
    mono: ['cat', 'mono'], monospace: ['cat', 'mono'], monospaced: ['cat', 'mono'], code: ['cat', 'mono'], display: ['cat', 'display'],
    handwriting: ['cat', 'hand'], handwritten: ['cat', 'hand'], script: ['cat', 'hand'], cursive: ['cat', 'hand'], system: ['cat', 'system'],
    humanist: ['tag', 'humanist'], geometric: ['tag', 'geometric'], modern: ['tag', 'geometric'], grotesque: ['tag', 'grotesque'], grotesk: ['tag', 'grotesque'],
    rounded: ['tag', 'rounded'], condensed: ['tag', 'condensed'], narrow: ['tag', 'condensed'], slab: ['tag', 'slab'], legible: ['tag', 'legible'], accessible: ['tag', 'legible'], readable: ['tag', 'legible'] };

  /** Search by name, or by style words (serif, geometric, mono…); category filter; best name matches first. */
  function search(query, category) {
    let q = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const cat = category || 'all';
    const catDef = CATEGORIES.find(c => c.id === cat) || CATEGORIES[0];
    const styles = [];
    if (STYLE_WORDS[q]) { styles.push(STYLE_WORDS[q]); q = ''; }
    const words = q ? q.split(' ').filter(w => { if (STYLE_WORDS[w]) { styles.push(STYLE_WORDS[w]); return false; } return true; }) : [];
    const name = words.join(' ');
    return ALL.filter(f => {
      if (cat !== 'all' && (catDef.tag ? !f.tags.includes(cat) : f.category !== cat)) return false;
      if (!styles.every(([k, v]) => (k === 'cat' ? f.category === v : f.tags.includes(v)))) return false;
      return !name || f.name.toLowerCase().includes(name);
    }).sort((a, b) => {
      if (name) {
        const as = a.name.toLowerCase().startsWith(name), bs = b.name.toLowerCase().startsWith(name);
        if (as !== bs) return as ? -1 : 1;
      }
      return 0;
    });
  }

  /* ── The picker ─────────────────────────────── */
  // SurveyFonts.openPicker(anchor, { value, title, onPick(value), onPreview(value|null) })
  // A popover with a search field, category chips and a scrolling list where
  // each font's name is drawn in that font. Hover or arrow keys preview a
  // font (onPreview), Enter or a click applies it (onPick), Esc cancels.
  let open = null;
  function closePicker(cancelled) {
    if (!open) return;
    const o = open;
    open = null;
    if (cancelled && o.opts.onPreview) o.opts.onPreview(null);
    if (o.io) o.io.disconnect();
    document.removeEventListener('pointerdown', o.outside, true);
    o.el.remove();
    if (o.anchor && o.anchor.focus && document.body.contains(o.anchor)) o.anchor.focus({ preventScroll: true });
  }
  function openPicker(anchor, opts) {
    closePicker(true);
    opts = opts || {};
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // opts.extra: entries shown first, e.g. the theme's own fonts { name, value, note }
    const extra = (opts.extra || []).map(x => Object.assign({ category: 'theme', tags: [], google: false }, x));
    const cur = extra.find(x => x.value === opts.value) || find(opts.value);
    let cat = 'all', query = '', active = -1, results = [];
    const el = document.createElement('div');
    el.className = 'sf-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', opts.title || 'Choose a font');
    el.innerHTML = '<div class="sf-head"><div class="sf-title">' + esc(opts.title || 'Font') + '</div>' +
      '<div class="sf-current">Current: <b>' + esc(cur ? cur.name : (familyOf(opts.value) || 'Theme default')) + '</b></div></div>' +
      '<div class="sf-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
        '<input type="search" class="sf-input" placeholder="Search ' + ALL.length + ' fonts by name or style" aria-label="Search fonts" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-autocomplete="list">' +
        '<button type="button" class="sf-clear" aria-label="Clear search" hidden>✕</button></div>' +
      '<div class="sf-cats" role="radiogroup" aria-label="Font category">' + CATEGORIES.map(c => '<button type="button" class="sf-cat' + (c.id === 'all' ? ' is-on' : '') + '" data-cat="' + c.id + '" role="radio" aria-checked="' + (c.id === 'all') + '">' + esc(c.label) + '</button>').join('') + '</div>' +
      '<div class="sf-count" role="status" aria-live="polite"></div>' +
      '<ul class="sf-list" role="listbox" aria-label="Fonts"></ul>' +
      '<div class="sf-foot">Web fonts load from Google Fonts. Hover or use ↑ ↓ to preview, Enter to apply, Esc to cancel.</div>';
    document.body.appendChild(el);
    const input = el.querySelector('.sf-input'), list = el.querySelector('.sf-list'), clear = el.querySelector('.sf-clear'), count = el.querySelector('.sf-count');
    const listId = 'sf-list-' + Math.random().toString(36).slice(2, 8);
    list.id = listId;
    input.setAttribute('aria-controls', listId);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => entries.forEach(en => {
      if (!en.isIntersecting) return;
      const f = BY_NAME.get(en.target.dataset.name.toLowerCase());
      if (f) ensurePreview(f);
      io.unobserve(en.target);
    }), { root: list, rootMargin: '120px' }) : null;

    function draw() {
      const q = query.trim().toLowerCase();
      results = (cat === 'all' ? extra.filter(x => !q || x.name.toLowerCase().includes(q)) : []).concat(search(query, cat));
      count.textContent = results.length ? results.length + ' font' + (results.length === 1 ? '' : 's') : 'No fonts match' + (query ? ' “' + query + '”' : '');
      list.innerHTML = results.map((f, i) => '<li class="sf-item' + (cur && cur.name === f.name ? ' is-current' : '') + '" role="option" id="' + listId + '-' + i + '" data-i="' + i + '" data-name="' + esc(f.name) + '" aria-selected="false">' +
        '<span class="sf-name" style="font-family:' + esc(f.value) + '">' + esc(f.name) + '</span>' +
        '<span class="sf-meta">' + esc(f.note || (CATEGORIES.find(c => c.id === f.category) || {}).label || '') + (cur && cur.name === f.name ? ' · current' : '') + '</span></li>').join('');
      if (io) list.querySelectorAll('.sf-item').forEach(li => io.observe(li));
      else results.forEach(ensurePreview);
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }
    function setActive(i, scroll) {
      const items = list.querySelectorAll('.sf-item');
      if (!items.length) return;
      active = Math.max(0, Math.min(items.length - 1, i));
      items.forEach((li, j) => { li.classList.toggle('is-active', j === active); li.setAttribute('aria-selected', String(j === active)); });
      input.setAttribute('aria-activedescendant', listId + '-' + active);
      if (scroll) items[active].scrollIntoView({ block: 'nearest' });
      preview(results[active]);
    }
    function preview(f) { if (!f) return; ensure(f.value); if (opts.onPreview) opts.onPreview(f.value); }
    function pick(f) { if (!f) return; ensure(f.value); const o = opts; closePicker(false); if (o.onPick) o.onPick(f.value); }

    input.addEventListener('input', () => { query = input.value; clear.hidden = !query; draw(); });
    clear.addEventListener('click', () => { input.value = ''; query = ''; clear.hidden = true; draw(); input.focus(); });
    el.querySelector('.sf-cats').addEventListener('click', e => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      cat = b.dataset.cat;
      el.querySelectorAll('.sf-cat').forEach(x => { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-checked', String(on)); });
      draw();
    });
    list.addEventListener('mousemove', e => { const li = e.target.closest('.sf-item'); if (li && Number(li.dataset.i) !== active) setActive(Number(li.dataset.i), false); });
    list.addEventListener('click', e => { const li = e.target.closest('.sf-item'); if (li) pick(results[Number(li.dataset.i)]); });
    el.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1, true); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); if (active >= 0) pick(results[active]); else if (results.length === 1) pick(results[0]); }
    });
    const outside = e => { if (!el.contains(e.target) && e.target !== anchor && !(anchor && anchor.contains(e.target))) closePicker(true); };
    document.addEventListener('pointerdown', outside, true);
    open = { el, opts, anchor, outside, io };

    // Position next to the anchor, inside the viewport
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 20, bottom: 20, top: 20, right: 20 };
    const W = Math.min(380, window.innerWidth - 16), H = Math.min(520, window.innerHeight - 16);
    el.style.width = W + 'px';
    el.style.maxHeight = H + 'px';
    let left = Math.min(Math.max(8, r.left), window.innerWidth - W - 8);
    let top = r.bottom + 6;
    if (top + H > window.innerHeight - 8) top = Math.max(8, r.top - H - 6);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    draw();
    input.focus();
  }

  /** A short display name for a font value: the catalog name, the first family, or the extra entry's name. */
  function labelOf(value, extra) {
    const x = (extra || []).find(e => e.value === value);
    if (x) return x.name;
    const f = find(value);
    return f ? f.name : (familyOf(value) || '');
  }

  root.SurveyFonts = { CATEGORIES, FONTS: ALL, find, familyOf, labelOf, ensure, ensureDoc, usedIn, search, openPicker, closePicker, cssUrl };
})(typeof window !== 'undefined' ? window : globalThis);
