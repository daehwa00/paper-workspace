import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { latex } from 'codemirror-lang-latex'

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#fff', color: '#1d2939' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', lineHeight: '1.65' },
  '.cm-content': { padding: '18px 0 28px', caretColor: '#2457d6' },
  '.cm-line': { padding: '0 24px 0 12px' },
  '.cm-gutters': { backgroundColor: '#fbfcfe', color: '#98a2b3', borderRight: '1px solid #eaecf0' },
  '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: '#eff4ff80' },
  '.cm-selectionBackground,.cm-content ::selection': { backgroundColor: '#b2ccff !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-searchMatch': { backgroundColor: '#fedf897d', outline: '1px solid #fdb022' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#fdb02270' }
})

export function createEditor({ parent, value = '', onChange, onSelection, onScroll }) {
  let suppress = false
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), dropCursor(),
        rectangularSelection(), crosshairCursor(), history(), bracketMatching(), closeBrackets(),
        highlightSelectionMatches(), autocompletion(), latex(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.docChanged && !suppress) onChange?.(update.state.doc.toString(), update)
          if (update.selectionSet) onSelection?.(update.state.selection.main.from, update.state.selection.main.to)
          if (update.viewportChanged) onScroll?.()
        }),
        theme
      ]
    })
  })
  view.scrollDOM.addEventListener('scroll', () => onScroll?.(), { passive: true })

  const setValue = next => {
    const value = String(next ?? '')
    if (value === view.state.doc.toString()) return
    suppress = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    suppress = false
  }
  const setSelection = (anchor, head = anchor, { scroll = false } = {}) => {
    const length = view.state.doc.length
    const from = Math.max(0, Math.min(Number(anchor) || 0, length))
    const to = Math.max(0, Math.min(Number(head) || 0, length))
    view.dispatch({ selection: { anchor: from, head: to }, effects: scroll ? EditorView.scrollIntoView(from, { y: 'center' }) : undefined })
  }
  return {
    view,
    dom: view.dom,
    contentDOM: view.contentDOM,
    scrollDOM: view.scrollDOM,
    getValue: () => view.state.doc.toString(),
    setValue,
    getSelection: () => ({ start: view.state.selection.main.from, end: view.state.selection.main.to }),
    setSelection,
    focus: () => view.focus(),
    replaceRange: (replacement, start, end, select = true) => {
      view.dispatch({ changes: { from: start, to: end, insert: replacement }, selection: select ? { anchor: start, head: start + replacement.length } : undefined })
    },
    coordsAt: position => view.coordsAtPos(Math.max(0, Math.min(position, view.state.doc.length))),
    lineAt: position => view.state.doc.lineAt(Math.max(0, Math.min(position, view.state.doc.length))),
    scrollTo: position => view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) }),
    setFontSize: size => view.dom.style.setProperty('--editor-font-size', size),
    focusWithin: () => view.hasFocus,
    destroy: () => view.destroy()
  }
}
