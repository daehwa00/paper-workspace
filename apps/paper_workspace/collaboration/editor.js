import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery,
  highlightSelectionMatches, replaceAll, replaceNext, search, searchKeymap,
  selectMatches, setSearchQuery
} from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { bracketMatching, defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { latex } from 'codemirror-lang-latex'

// Keep CodeMirror's light palette and formatting. Theme variables change only
// colors, so switching appearance never rebuilds document or undo state.
const syntaxColors = {
  '#404740': 'meta', '#708': 'keyword', '#219': 'atom', '#164': 'literal',
  '#a11': 'string', '#e40': 'escape', '#00f': 'definition', '#30a': 'local',
  '#085': 'type', '#167': 'class', '#256': 'macro', '#00c': 'property',
  '#940': 'comment', '#f00': 'invalid'
}
const syntaxStyle = HighlightStyle.define(defaultHighlightStyle.specs.map(spec => (
  syntaxColors[spec.color]
    ? { ...spec, color: `var(--theme-syntax-${syntaxColors[spec.color]}, ${spec.color})` }
    : spec
)))

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

const documentChange = (previous, next) => {
  if (previous === next) return null
  let from = 0
  const sharedLength = Math.min(previous.length, next.length)
  while (from < sharedLength && previous.charCodeAt(from) === next.charCodeAt(from)) from += 1
  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > from && nextEnd > from && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)) {
    previousEnd -= 1
    nextEnd -= 1
  }
  return { from, to: previousEnd, insert: next.slice(from, nextEnd) }
}

const icon = path => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = path
  return svg
}

const controlButton = ({ name, label, iconPath, text, action }) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.name = name
  button.className = `paper-search-button${text ? ' paper-search-button-text' : ''}`
  button.setAttribute('aria-label', label)
  button.title = label
  if (iconPath) button.append(icon(iconPath))
  if (text) button.append(document.createTextNode(text))
  button.addEventListener('click', action)
  return button
}

const searchInput = ({ name, label, value, onInput }) => {
  const input = document.createElement('input')
  input.type = 'text'
  input.name = name
  input.className = 'paper-search-input'
  input.value = value
  input.placeholder = label
  input.setAttribute('aria-label', label)
  if (name === 'search') input.setAttribute('role', 'searchbox')
  input.addEventListener('input', onInput)
  return input
}

const searchOption = ({ name, label, shortLabel, checked, onChange }) => {
  const wrapper = document.createElement('label')
  wrapper.className = 'paper-search-option'
  wrapper.title = label
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.name = name
  input.checked = checked
  input.setAttribute('aria-label', label)
  input.addEventListener('change', onChange)
  const visible = document.createElement('span')
  visible.setAttribute('aria-hidden', 'true')
  visible.textContent = shortLabel
  wrapper.append(input, visible)
  return { wrapper, input }
}

class PaperSearchPanel {
  constructor(view) {
    this.view = view
    this.query = getSearchQuery(view.state)
    this.commit = this.commit.bind(this)
    const korean = document.documentElement.lang.toLowerCase().startsWith('ko')
    const copy = korean ? {
      find: '찾기', replace: '바꾸기', previous: '이전 결과', next: '다음 결과', all: '모두 선택',
      replaceOne: '바꾸기', replaceAll: '모두 바꾸기', case: '대소문자 구분', regexp: '정규식', word: '단어 단위', close: '검색 닫기'
    } : {
      find: 'Find', replace: 'Replace', previous: 'Previous result', next: 'Next result', all: 'Select all',
      replaceOne: 'Replace', replaceAll: 'Replace all', case: 'Match case', regexp: 'Regular expression', word: 'Whole word', close: 'Close search'
    }

    this.searchField = searchInput({ name: 'search', label: copy.find, value: this.query.search, onInput: this.commit })
    this.replaceField = searchInput({ name: 'replace', label: copy.replace, value: this.query.replace, onInput: this.commit })
    const caseOption = searchOption({ name: 'case', label: copy.case, shortLabel: 'Aa', checked: this.query.caseSensitive, onChange: this.commit })
    const regexpOption = searchOption({ name: 're', label: copy.regexp, shortLabel: '.*', checked: this.query.regexp, onChange: this.commit })
    const wordOption = searchOption({ name: 'word', label: copy.word, shortLabel: 'W', checked: this.query.wholeWord, onChange: this.commit })
    this.caseField = caseOption.input
    this.reField = regexpOption.input
    this.wordField = wordOption.input

    const findRow = document.createElement('div')
    findRow.className = 'paper-search-row paper-search-find-row'
    const findIcon = document.createElement('span')
    findIcon.className = 'paper-search-leading-icon'
    findIcon.append(icon('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'))
    const findField = document.createElement('span')
    findField.className = 'paper-search-field'
    findField.append(findIcon, this.searchField)
    findRow.append(
      findField,
      controlButton({ name: 'prev', label: copy.previous, iconPath: '<path d="m8 14 4-4 4 4"/>', action: () => findPrevious(view) }),
      controlButton({ name: 'next', label: copy.next, iconPath: '<path d="m8 10 4 4 4-4"/>', action: () => findNext(view) }),
      controlButton({ name: 'select', label: copy.all, text: copy.all, action: () => selectMatches(view) }),
      caseOption.wrapper, regexpOption.wrapper, wordOption.wrapper,
      controlButton({ name: 'close', label: copy.close, iconPath: '<path d="m7 7 10 10M17 7 7 17"/>', action: () => closeSearchPanel(view) })
    )

    const replaceRow = document.createElement('div')
    replaceRow.className = 'paper-search-row paper-search-replace-row'
    const replaceField = document.createElement('span')
    replaceField.className = 'paper-search-field paper-search-replace-field'
    replaceField.append(this.replaceField)
    replaceRow.append(
      replaceField,
      controlButton({ name: 'replace', label: copy.replaceOne, text: copy.replaceOne, action: () => replaceNext(view) }),
      controlButton({ name: 'replaceAll', label: copy.replaceAll, text: copy.replaceAll, action: () => replaceAll(view) })
    )

    this.dom = document.createElement('div')
    this.dom.className = 'paper-search-panel'
    this.dom.setAttribute('role', 'search')
    this.dom.addEventListener('keydown', event => this.keydown(event))
    this.dom.append(findRow, replaceRow)
  }

  commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked
    })
    if (!query.eq(this.query)) {
      this.query = query
      this.view.dispatch({ effects: setSearchQuery.of(query) })
    }
  }

  keydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(this.view)
      this.view.focus()
    } else if (event.key === 'Enter' && event.target === this.searchField) {
      event.preventDefault()
      ;(event.shiftKey ? findPrevious : findNext)(this.view)
    } else if (event.key === 'Enter' && event.target === this.replaceField) {
      event.preventDefault()
      replaceNext(this.view)
    }
  }

  update(update) {
    const query = getSearchQuery(update.state)
    if (query.eq(this.query)) return
    this.query = query
    this.searchField.value = query.search
    this.replaceField.value = query.replace
    this.caseField.checked = query.caseSensitive
    this.reField.checked = query.regexp
    this.wordField.checked = query.wholeWord
  }

  mount() { this.searchField.select() }
  get pos() { return 80 }
  get top() { return true }
}

export function createEditor({ parent, value = '', onChange, onSelection, onScroll }) {
  let suppress = false
  let currentPath = null
  const documents = new Map()
  const createState = doc => EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), dropCursor(),
      rectangularSelection(), crosshairCursor(), history(), bracketMatching(), closeBrackets(),
      highlightSelectionMatches(), search({ top: true, createPanel: view => new PaperSearchPanel(view) }),
      autocompletion(), latex(), syntaxHighlighting(syntaxStyle, { fallback: true }),
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
  const view = new EditorView({
    parent,
    state: createState(value)
  })
  view.scrollDOM.addEventListener('scroll', () => onScroll?.(), { passive: true })

  const replaceCurrentDocument = next => {
    const value = String(next ?? '')
    const changes = documentChange(view.state.doc.toString(), value)
    if (!changes) return
    suppress = true
    try {
      // Server and collaboration updates are not local edits. Keeping this
      // transaction out of history also lets CodeMirror map still-valid undo
      // entries through the change.
      view.dispatch({
        changes,
        annotations: Transaction.addToHistory.of(false)
      })
    } finally {
      suppress = false
    }
  }
  const setValue = next => {
    replaceCurrentDocument(next)
    if (currentPath !== null) documents.set(currentPath, view.state)
  }
  const setDocument = (path, next) => {
    const key = String(path ?? '')
    const value = String(next ?? '')
    if (currentPath === null) {
      currentPath = key
      replaceCurrentDocument(value)
      documents.set(key, view.state)
      return
    }
    if (key === currentPath) {
      setValue(value)
      return
    }

    documents.set(currentPath, view.state)
    let state = documents.get(key)
    if (!state) state = createState(value)
    else if (state.doc.toString() !== value) {
      // This file was updated while it was inactive. Apply the update to its
      // own state so selection and any undo entries with valid positions map.
      state = state.update({
        changes: documentChange(state.doc.toString(), value),
        annotations: Transaction.addToHistory.of(false)
      }).state
    }
    currentPath = key
    documents.set(key, state)
    view.setState(state)
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
    setDocument,
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
