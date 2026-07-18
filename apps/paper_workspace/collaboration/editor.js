import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery,
  highlightSelectionMatches, replaceAll, replaceNext, search, searchKeymap,
  selectMatches, setSearchQuery
} from '@codemirror/search'
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
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), dropCursor(),
        rectangularSelection(), crosshairCursor(), history(), bracketMatching(), closeBrackets(),
        highlightSelectionMatches(), search({ top: true, createPanel: view => new PaperSearchPanel(view) }),
        autocompletion(), latex(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
