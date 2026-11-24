import { Marked, Renderer } from 'marked'
import createDOMPurify from 'dompurify'
import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { SafeHandler } from 'mathjax-full/js/ui/safe/SafeHandler.js'
import { AssistiveMmlHandler } from 'mathjax-full/js/a11y/assistive-mml.js'

// OpenReview parses Markdown before asking MathJax to find equations in the DOM.
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const renderer = new Renderer()
renderer.html = ({ text }) => escapeHtml(text)
renderer.checkbox = ({ checked }) => checked ? '[x]' : '[ ]'
// External images are displayed as text on OpenReview. Do not fetch them.
renderer.image = ({ href, title, text }) => escapeHtml(`<img src="${href}" alt="${text}" title="${title}">`)
const markdown = new Marked({ renderer, gfm: true, breaks: false })
const purifier = createDOMPurify(window)
purifier.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer') }
  node.removeAttribute?.('style'); node.removeAttribute?.('action'); node.removeAttribute?.('formaction')
})
const allowedTags = 'h1 h2 h3 h4 h5 h6 p div span blockquote pre hr section article header footer figure figcaption details summary a b i em strong u s strike del ins sub sup small mark code kbd samp var abbr cite q br wbr ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col'.split(' ')
const adaptor = browserAdaptor()
AssistiveMmlHandler(SafeHandler(RegisterHTMLHandler(adaptor)))
const tex = new TeX({ packages: AllPackages.filter(name => !['colorv2', 'physics', 'setoptions'].includes(name)), inlineMath: [['$', '$'], ['\\(', '\\)']] })

function positionedMarkdown(source) {
  const offsets = [], normalized = []
  for (let index = 0; index < source.length; index++) {
    offsets.push(index)
    if (source[index] === '\r') { normalized.push('\n'); if (source[index + 1] === '\n') index++ }
    else normalized.push(source[index])
  }
  offsets.push(source.length)
  const text = normalized.join(''), ranges = new WeakMap(), positioned = new Renderer()
  for (const name of ['html', 'checkbox', 'image']) positioned[name] = renderer[name]
  const tokens = markdown.lexer(text)
  function locate(items, input, project) {
    let cursor = 0
    for (const token of items || []) {
      if (!token.raw) continue
      const at = input.indexOf(token.raw, cursor), stop = at + token.raw.length
      if (at < cursor) continue
      const tokenPosition = index => project(at + index)
      const range = {start: tokenPosition(0), end: tokenPosition(token.raw.length - 1) + 1}
      ranges.set(token, {...range, position: tokenPosition})
      if (token.type === 'blockquote') {
        const quote = quoteContents(token.raw)
        locate(token.tokens, quote.text, index => tokenPosition(quote.offsets[index]))
      } else {
        locate(token.items || token.tokens, token.raw, tokenPosition)
      }
      cursor = stop
    }
  }
  locate(tokens, text, index => index)
  const attributes = range => ` data-source-start="${offsets[range.start]}" data-source-end="${offsets[range.end]}"`
  for (const name of ['heading', 'paragraph', 'blockquote', 'list', 'listitem', 'code', 'hr', 'strong', 'em', 'del', 'codespan', 'link', 'table', 'html']) {
    const render = positioned[name]
    positioned[name] = function (token) {
      let html = render.call(this, token)
      const range = ranges.get(token)
      if (!range) return html
      if (name === 'html') return `<span${attributes(range)}>${html}</span>`
      if (name === 'table') {
        const lines = [...token.raw.matchAll(/[^\n]*(?:\n|$)/g)].filter(match => match[0])
        let row = 0
        html = html.replace(/<tr>/g, tag => {
          const line = lines[row === 0 ? 0 : row + 1]; row++
          return line ? `<tr${attributes({start: range.position(line.index), end: range.position(line.index + line[0].length - 1) + 1})}>` : tag
        })
      }
      return html.replace(/^<[a-z][a-z0-9]*/i, tag => tag + attributes(range))
    }
  }
  return new Marked({ renderer: positioned, gfm: true, breaks: false }).parser(tokens)
}

// Marked lexes the nested blocks after removing a level of quote markers.
function quoteContents(raw, depth = 1, skipFirst = false) {
  const offsets = [], parts = []
  for (const line of raw.matchAll(/[^\n]*(?:\n|$)/g)) {
    const start = line[0].match(/^ {0,3}>[ 	]?/)?.[0].length || 0
    parts.push(line[0].slice(start))
    for (let i = start; i < line[0].length; i++) offsets.push(line.index + i)
  }
  return {text: parts.join(''), offsets}
}

function visibleSource(raw, {depth = 0, skipFirst, entities}) {
  const stripped = depth ? quoteContents(raw, depth, skipFirst) : null
  const input = stripped?.text ?? raw, offsets = [], parts = []
  const project = index => stripped?.offsets[index] ?? index
  const decoder = entities ? document.createElement('textarea') : null
  let cursor = 0
  for (const token of input.matchAll(/\r\n?|&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g)) {
    const start = token.index, end = start + token[0].length
    parts.push(input.slice(cursor, start))
    for (let i = cursor; i < start; i++) offsets.push(project(i))
    let decoded = token[0]
    if (decoded[0] === '\r') decoded = '\n'
    else if (decoder) { decoder.innerHTML = decoded; decoded = decoder.value }
    parts.push(decoded)
    for (let i = 0; i < decoded.length; i++) offsets.push(project(decoded === token[0] ? start + i : start))
    cursor = end
  }
  parts.push(input.slice(cursor))
  for (let i = cursor; i < input.length; i++) offsets.push(project(i))
  return {text: parts.join(''), offsets: [...offsets, raw.length]}
}

function mappedText(node, element, raw) {
  // Markdown code renders entities literally. Within quoted blocks, strip
  // continuation prefixes only when the regular source cannot match the node.
  const entities = !node.parentElement?.closest('pre, code')
  const regular = visibleSource(raw, {entities})
  if (regular.text.includes(node.data)) return regular
  let depth = 0
  for (let ancestor = element.closest('blockquote'); ancestor; ancestor = ancestor.parentElement?.closest('blockquote')) depth++
  if (depth) {
    const quoted = visibleSource(raw, {entities, depth, skipFirst: element.tagName !== 'BLOCKQUOTE'})
    if (quoted.text.includes(node.data) || node.data.includes('\n')) return quoted
  }
  if (entities && raw.includes(node.data)) return visibleSource(raw, {entities: false})
  return regular
}

const sourceElement = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-source-start]')
const previewText = node => !node.parentElement?.closest('mjx-container, [aria-hidden="true"]')

export function previewSourcePosition(host, source, {fullyVisible = false} = {}) {
  const bounds = host.getBoundingClientRect(), top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom)
  if (bottom <= top) return null
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {acceptNode: node => node.data.trim() && previewText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT})
  let node
  while ((node = walker.nextNode())) {
    const element = sourceElement(node)
    if (!element || !host.contains(element)) continue
    const range = document.createRange(); range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (rect.bottom <= top + 2 || rect.top >= bottom || !rect.width || fullyVisible && rect.top < top - 1) continue
      const x = Math.max(bounds.left + 2, rect.left + 2), y = Math.max(top + 3, Math.min(rect.bottom - 1, (rect.top + rect.bottom) / 2))
      const caret = document.caretPositionFromPoint?.(x, y), hit = !caret && document.caretRangeFromPoint?.(x, y)
      const offset = caret?.offsetNode === node ? caret.offset : hit?.startContainer === node ? hit.startOffset : 0
      const start = Number(element.dataset.sourceStart), end = Number(element.dataset.sourceEnd), raw = source.slice(start, end)
      const mapped = mappedText(node, element, raw)
      let snippet = node.data, localOffset = offset, at = mapped.text.indexOf(snippet)
      if (at < 0) {
        const lineStart = snippet.lastIndexOf('\n', offset - 1) + 1, lineEnd = snippet.indexOf('\n', offset)
        snippet = snippet.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
        localOffset -= lineStart
        at = snippet ? mapped.text.indexOf(snippet) : -1
      }
      if (at >= 0) {
        const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(node, offset)
        const expected = prefix.toString().length - localOffset
        for (let next = mapped.text.indexOf(snippet, at + 1); next >= 0; next = mapped.text.indexOf(snippet, next + 1)) {
          if (Math.abs(next - expected) < Math.abs(at - expected)) at = next
        }
      }
      return {position: Math.min(source.length, at < 0 ? start : start + mapped.offsets[at + localOffset]), offset: Math.max(0, rect.top - bounds.top)}
    }
  }
  const element = [...host.querySelectorAll('[data-source-start]')].find(node => { const rect = node.getBoundingClientRect(); return rect.bottom > top && rect.top < bottom })
  return element ? {position: Number(element.dataset.sourceStart), offset: Math.max(0, element.getBoundingClientRect().top - bounds.top)} : null
}

export function previewScrollToPosition(host, position, offset = 0, source = '') {
  const positioned = [...host.querySelectorAll('[data-source-start]')]
  if (!positioned.length) return false
  if (position === source.length && source.length) {
    host.scrollTop = host.scrollHeight
    return true
  }
  const candidates = positioned.filter(node => Number(node.dataset.sourceStart) <= position && position < Number(node.dataset.sourceEnd))
  const spanLength = node => Number(node.dataset.sourceEnd) - Number(node.dataset.sourceStart)
  const element = candidates.sort((a, b) => spanLength(a) - spanLength(b))[0]
    || positioned.find(node => Number(node.dataset.sourceStart) >= position)
    || positioned.at(-1)
  let rect = element.getBoundingClientRect()
  const start = Number(element.dataset.sourceStart), end = Number(element.dataset.sourceEnd), raw = source.slice(start, end)
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {acceptNode: node => previewText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT})
  let node, cursor = 0
  while ((node = walker.nextNode())) {
    if (!node.data) continue
    const mapped = mappedText(node, element, raw)
    const at = mapped.text.indexOf(node.data, cursor)
    if (at < 0) continue
    cursor = at + node.data.length
    if (start + mapped.offsets[at] <= position && position <= start + mapped.offsets[cursor]) {
      let local = 0
      while (local + 1 < node.data.length && start + mapped.offsets[at + local + 1] <= position) local++
      const range = document.createRange()
      range.setStart(node, local); range.setEnd(node, local + 1)
      const measured = range.getBoundingClientRect(); if (measured.height) rect = measured
      break
    }
  }
  host.scrollTop += rect.top - host.getBoundingClientRect().top - offset
  return true
}

export function renderResponsePreview(text, {sourcePositions = false} = {}) {
  const container = document.createElement('div')
  container.innerHTML = purifier.sanitize(sourcePositions ? positionedMarkdown(text) : markdown.parse(text), { ALLOWED_TAGS: allowedTags })
  // MathJax's browser adaptor measures computed font metrics. A detached
  // element has no computed font size in Chromium, producing NaN SVG bounds.
  // Attach an invisible, noninteractive measurement host only for rendering.
  container.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;width:800px;font-size:13px;line-height:1.8;'
  document.body.append(container)
  try {
    const math = mathjax.document(document, { InputJax: tex, OutputJax: new SVG({ fontCache: 'none', displayAlign: 'left' }), ignoreHtmlClass: 'disable-tex-rendering' })
    math.findMath({ elements: [container] }).render()
    return container.innerHTML
  } finally {
    container.remove()
  }
}
