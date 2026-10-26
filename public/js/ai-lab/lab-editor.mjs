/* ══════════════════════════════════════════════
   lab-editor.mjs — the code editor of Code Experiments

   CodeMirror 6 (ES modules served from node_modules by server.js
   /vendor/cm/, mapped by the import map in ai-lab.html): an editor for a
   coding rule and a side-by-side diff (merge view) of two versions.
   Exposed as window.LabEditor; 'lab-editor-ready' fires once it exists.
   lab-experiments.js falls back to a plain textarea when this module
   doesn't load. The editor only edits text: nothing here runs code.
   ══════════════════════════════════════════════ */

import { basicSetup, EditorView } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { MergeView } from '@codemirror/merge';
import { setDiagnostics, lintGutter } from '@codemirror/lint';

// Light theme on the app's own tokens (main.css)
const theme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: 'var(--bg-surface)', color: 'var(--tx-primary)', height: '100%' },
  '&.cm-focused': { outline: '2px solid var(--blue)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--f-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--blue)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-muted)', color: 'var(--tx-muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'rgba(37, 99, 235, .05)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--blue-lt)', color: 'var(--tx-second)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--blue-mid)', outline: 'none' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'rgba(37, 99, 235, .18)' },
  '.cm-tooltip': { border: '1px solid var(--border)', backgroundColor: 'var(--bg-surface)', borderRadius: 'var(--r-sm)', boxShadow: 'var(--sh-md)' },
  '.cm-diagnostic': { fontFamily: 'var(--f-body)', fontSize: '12.5px' },
  '.cm-panels': { backgroundColor: 'var(--bg-muted)', color: 'var(--tx-primary)' }
}, { dark: false });

const LANGS = ['javascript', 'typescript', 'python'];
const langOf = l => (LANGS.includes(l) ? l : 'javascript');
// Syntax, tab size (2; Python 4) and indent unit for a language
function languageExtensions(lang) {
  lang = langOf(lang);
  const size = lang === 'python' ? 4 : 2;
  return [
    lang === 'python' ? python() : javascript({ typescript: lang === 'typescript' }),
    EditorState.tabSize.of(size),
    indentUnit.of(' '.repeat(size))
  ];
}
const readOnlyExtensions = b => [EditorState.readOnly.of(!!b), EditorView.editable.of(!b)];
const label = text => EditorView.contentAttributes.of({ 'aria-label': text });

/**
 * An editor in `parent`.
 * @param {HTMLElement} parent
 * @param {{ doc?: string, language?: string, readOnly?: boolean, onChange?: (text: string) => void, label?: string }} [opts]
 */
function create(parent, opts) {
  opts = opts || {};
  const language = new Compartment();
  const readOnly = new Compartment();
  let quiet = false;   // setValue doesn't report a change: only the user's edits do
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: String(opts.doc || ''),
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),   // Escape, then Tab, moves the focus out of the editor
        lintGutter(),
        theme,
        label(opts.label || 'Code editor'),
        language.of(languageExtensions(opts.language)),
        readOnly.of(readOnlyExtensions(opts.readOnly)),
        EditorView.updateListener.of(u => { if (u.docChanged && !quiet && typeof opts.onChange === 'function') opts.onChange(u.state.doc.toString()); })
      ]
    })
  });
  function lineRange(n) {
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, Math.floor(Number(n) || 1)), doc.lines));
    return { from: line.from, to: line.to };
  }
  return {
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      quiet = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text === undefined || text === null ? '' : text) }, selection: { anchor: 0 } }); }
      finally { quiet = false; }
    },
    setLanguage(lang) { view.dispatch({ effects: language.reconfigure(languageExtensions(lang)) }); },
    setReadOnly(b) { view.dispatch({ effects: readOnly.reconfigure(readOnlyExtensions(b)) }); },
    focus() { view.focus(); },
    gotoLine(n) {
      const r = lineRange(n);
      view.dispatch({ selection: { anchor: r.from }, scrollIntoView: true });
      view.focus();
    },
    // Policy findings and review risks: gutter markers, underlines and messages on their lines
    setFindings(list) {
      const diagnostics = (Array.isArray(list) ? list : []).filter(f => f && Number(f.line) >= 1).map(f => {
        const r = lineRange(f.line);
        return { from: r.from, to: r.to, severity: f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info', message: String(f.message || '') };
      });
      view.dispatch(setDiagnostics(view.state, diagnostics));
    },
    destroy() { view.destroy(); }
  };
}

/**
 * A side-by-side, read-only diff of two texts in `parent` (a = before, b = after).
 * @param {HTMLElement} parent
 * @param {{ a: string, b: string, language?: string, labelA?: string, labelB?: string }} opts
 */
function merge(parent, opts) {
  const side = (doc, text) => ({
    doc: String(doc || ''),
    extensions: [basicSetup, theme, label(text), readOnlyExtensions(true), languageExtensions(opts.language)]
  });
  const mv = new MergeView({
    parent,
    a: side(opts.a, opts.labelA || 'Code before (A)'),
    b: side(opts.b, opts.labelB || 'Code after (B)'),
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 }
  });
  return { destroy() { mv.destroy(); } };
}

window.LabEditor = { create, merge };
window.dispatchEvent(new Event('lab-editor-ready'));
