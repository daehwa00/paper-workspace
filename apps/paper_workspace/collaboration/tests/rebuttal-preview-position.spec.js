import { test, expect } from './fixtures.js'

const editorSelector = '#response-editor .cm-content'
const previewSelector = '#response-preview'
const toggleSelector = '[data-response-view="toggle"]'
const textKey = 'response:position-doc'

function mixedSource() {
  return Array.from({ length: 30 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    return `## Section${n}: numbered evidence\n\nEvidence${n} compares the baseline with **strong${n} evidence** and *careful${n} interpretation*. ${`The interval for experiment${n} remains stable under the reported assumptions. `.repeat(4)}\n\n- List${n} first observation\n- Item${n} second observation\n\n| Measure | Result |\n| --- | --- |\n| Table${n} | improved |\n| Trial${n} | unchanged |\n\n\`\`\`text\nCode${n} = verified_result\n\`\`\`\n\nMath${n} explains ${index % 5 === 0 ? '$x^2 + y^2$' : 'the measured uncertainty'} after the experiment.\n\n`
  }).join('')
}

async function openResponse(page, context, source, viewport = { width: 1600, height: 1000 }) {
  const round = {
    id: 'r1', title: 'Preview position regression', reviewers: [{ id: 'reviewer1', name: 'Reviewer A' }],
    reviews: [{ id: 'review1', reviewer_id: 'reviewer1', fields: { review: Array.from({ length: 100 }, (_, i) => `Review observation ${i + 1}: please clarify the evidence and uncertainty.`).join('\n\n') }, translations: {} }],
    documents: [{ id: 'position-doc', title: 'Position response', kind: 'reviewer', reviewer_id: 'reviewer1', text_key: textKey, seed_text: source }],
    imports: [], concerns: [], mappings: [], findings: [], evidence: [], work_items: [], rules: [], active_rules_id: null, analyses: [], submissions: [], glossary: {}
  }
  const state = { schema_version: 1, revision: 0, enabled: true, jobs: [], rounds: [round] }
  await context.route('**/api/rebuttal/projects/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/versions')) return route.fulfill({ json: request.method() === 'GET' ? { versions: [] } : { saved: true } })
    if (request.method() === 'PUT') {
      const body = request.postDataJSON()
      state.rounds[0] = body.round
      state.revision++
    } else if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Unexpected mutation in preview test' } })
    return route.fulfill({ json: state })
  })
  await page.setViewportSize(viewport)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/p/preview-position-${test.info().testId.slice(-12)}-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await expect(page.locator(editorSelector)).toBeVisible()
  await page.evaluate(() => window.PaperRebuttalSession.whenReady)
  await page.waitForFunction(key => window.PaperRebuttalSession?.mapFor('rebuttalResponses').get(key)?.toString().length > 0, textKey)
  await page.evaluate(() => document.fonts.ready)
  expect(await sharedText(page)).toBe(source)
}

async function sharedText(page) {
  return page.evaluate(key => window.PaperRebuttalSession.mapFor('rebuttalResponses').get(key).toString(), textKey)
}

// Measure rendered words, independently of the renderer's source-position map.
async function wordBox(page, selector, token, occurrence = 0, visibleOnly = false) {
  return page.locator(selector).evaluate((root, { token, occurrence, visibleOnly }) => {
    const bounds = (root.closest('.cm-scroller') || root).getBoundingClientRect(), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node, count = 0
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('mjx-container,.cm-remoteCaret')) continue
      for (let start = node.data.indexOf(token); start !== -1; start = node.data.indexOf(token, start + token.length)) {
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + token.length)
        const rect = range.getBoundingClientRect()
        if (visibleOnly && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) continue
        if (count++ === occurrence) return { x: rect.x, y: rect.y, height: rect.height, width: rect.width }
      }
    }
    return null
  }, { token, occurrence, visibleOnly })
}

async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function previewAt(page, token, occurrence = 0) {
  await page.locator(toggleSelector).click()
  await expect(page.locator(previewSelector)).toBeVisible()
  const box = await wordBox(page, previewSelector, token, occurrence)
  expect(box, `preview contains ${token}`).not.toBeNull()
  await page.locator(previewSelector).evaluate((host, y) => {
    host.scrollTop += y - host.getBoundingClientRect().top - 6
  }, box.y)
  await paint(page)
  const positioned = await wordBox(page, previewSelector, token, occurrence)
  const host = await page.locator(previewSelector).boundingBox()
  expect(positioned.y).toBeGreaterThanOrEqual(host.y)
  expect(positioned.y).toBeLessThan(host.y + 35)
  expect(await page.locator(previewSelector).evaluate(host => host.scrollTop)).toBeGreaterThan(300)
  return positioned
}

async function assertEditorAt(page, token, previousBox, sourceOffset) {
  await expect(page.locator(editorSelector)).toBeVisible()
  await test.info().attach(`editor-anchor-${token.replace(/\W+/g, '-')}`, { contentType: 'application/json', body: JSON.stringify({
    token, previousBox, sourceOffset, currentBox: await wordBox(page, editorSelector, token),
    runtime: await page.evaluate(() => ({ activeElement: document.activeElement?.outerHTML.slice(0, 250), selection: window.PaperRebuttal.getSelection(), previewSourceNodes: document.querySelectorAll('#response-preview [data-source-start]').length, editorScroll: document.querySelector('#response-editor .cm-scroller').scrollTop, previewScroll: document.querySelector('#response-preview').scrollTop }))
  }, null, 2) })
  await expect(page.locator(editorSelector)).toBeFocused()
  const lineHeight = await page.locator(editorSelector).evaluate(node => parseFloat(getComputedStyle(node).lineHeight))
  await expect.poll(async () => {
    const box = await wordBox(page, editorSelector, token, 0, true)
    return box ? Math.abs(box.y - previousBox.y) : Number.MAX_SAFE_INTEGER
  }, { message: `${token} keeps its screen height within one editor line` }).toBeLessThanOrEqual(lineHeight)
  const selection = await page.evaluate(() => window.PaperRebuttal.getSelection())
  const lineCapacity = await page.locator(editorSelector).evaluate(node => {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
    const style = getComputedStyle(node)
    context.font = `${style.fontSize} ${style.fontFamily}`
    return Math.ceil(node.getBoundingClientRect().width / context.measureText('0').width)
  })
  expect(selection.start).toBe(selection.end)
  expect(Math.abs(selection.start - sourceOffset), 'caret stays near the visible source words').toBeLessThanOrEqual(lineCapacity + token.length)
  return selection
}

test('preview exit restores the middle passage and permits immediate typing without changing other source text', async ({ page, context }) => {
  const source = mixedSource(), token = 'Evidence16'
  await openResponse(page, context, source)
  const position = await previewAt(page, token)
  await page.locator(toggleSelector).click()
  const selection = await assertEditorAt(page, token, position, source.indexOf(token))
  const inserted = 'POSITION_INSERT'
  await page.keyboard.insertText(inserted)
  await expect.poll(() => sharedText(page)).toBe(source.slice(0, selection.start) + inserted + source.slice(selection.end))
})

test('preview exit restores the visible word inside one very long paragraph instead of its block start', async ({ page, context }) => {
  const source = Array.from({ length: 2400 }, (_, index) => `word${String(index).padStart(4, '0')}`).join(' '), token = 'word1450'
  await openResponse(page, context, source)
  const position = await previewAt(page, token)
  await page.locator(toggleSelector).click()
  await assertEditorAt(page, token, position, source.indexOf(token))
  expect(await sharedText(page)).toBe(source)
})

test('preview exit locates list items table rows code and math-adjacent text in their original blocks', async ({ page, context }) => {
  const source = mixedSource()
  await openResponse(page, context, source)
  for (const token of ['Item16', 'Table16', 'Code16', 'Math16']) {
    const position = await previewAt(page, token)
    await page.locator(toggleSelector).click()
    await assertEditorAt(page, token, position, source.indexOf(token))
    expect(await sharedText(page)).toBe(source)
  }
})

test('preview exit selects the visible instance when identical passages occur in several sections', async ({ page, context }) => {
  const phrase = 'Repeated conclusion remains unchanged.', filler = mixedSource()
  const source = Array.from({ length: 4 }, (_, index) => `# Instance ${index + 1}\n\n${phrase}\n\n${filler}`).join('\n')
  await openResponse(page, context, source)
  const position = await previewAt(page, phrase, 2)
  const expectedOffset = source.indexOf(phrase, source.indexOf(phrase, source.indexOf(phrase) + 1) + 1)
  await page.locator(toggleSelector).click()
  const selection = await assertEditorAt(page, phrase, position, expectedOffset)
  expect(selection.start).toBeGreaterThan(source.indexOf('# Instance 3'))
  expect(selection.start).toBeLessThan(source.indexOf('# Instance 4'))
  expect(await sharedText(page)).toBe(source)
})

test('entering preview from a scrolled editor and repeated toggles preserve the passage source and review scroll', async ({ page, context }) => {
  const source = Array.from({ length: 100 }, (_, paragraph) => Array.from({ length: 36 }, (_, word) => `p${paragraph}word${word}`).join(' ')).join('\n\n')
  await openResponse(page, context, source)
  await page.locator('#review-content').evaluate(node => { node.scrollTop = 480 })
  const reviewTop = await page.locator('#review-content').evaluate(node => node.scrollTop)
  expect(reviewTop).toBeGreaterThan(300)
  await page.locator('#response-editor .cm-scroller').evaluate(node => { node.scrollTop = node.scrollHeight / 2 })
  await paint(page)
  const anchor = await page.locator(editorSelector).evaluate(root => {
    const bounds = root.closest('.cm-scroller').getBoundingClientRect(), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) for (const match of node.data.matchAll(/p\d+word\d+/g)) {
      const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length)
      const rect = range.getBoundingClientRect()
      if (rect.top >= bounds.top + 3 && rect.bottom < bounds.bottom) return { token: match[0], x: rect.x, y: rect.y, height: rect.height }
    }
    return null
  })
  expect(anchor).not.toBeNull()
  for (let iteration = 0; iteration < 3; iteration++) {
    await page.locator(toggleSelector).click()
    await expect(page.locator(previewSelector)).toBeVisible()
    await expect.poll(async () => {
      const box = await wordBox(page, previewSelector, anchor.token, 0, true)
      return box ? Math.abs(box.y - anchor.y) : Number.MAX_SAFE_INTEGER
    }).toBeLessThanOrEqual(25)
    await page.locator(toggleSelector).click()
    await assertEditorAt(page, anchor.token, anchor, source.indexOf(anchor.token))
    expect(await page.locator('#review-content').evaluate(node => node.scrollTop)).toBeCloseTo(reviewTop, 0)
    expect(await sharedText(page)).toBe(source)
  }
})

test('CRLF response keeps its original shared text and restores the normalized editor position and focus', async ({ page, context }) => {
  const normalized = mixedSource(), source = normalized.replace(/\n/g, '\r\n'), token = 'Evidence16'
  await openResponse(page, context, source)
  const position = await previewAt(page, token)
  await page.locator(toggleSelector).click()
  await assertEditorAt(page, token, position, normalized.indexOf(token))
  expect(await sharedText(page)).toBe(source)
})

test('mobile preview uses the response scroll container and restores the visible passage without moving the page', async ({ page, context }) => {
  const source = mixedSource(), token = 'Evidence16'
  await openResponse(page, context, source, { width: 390, height: 844 })
  const editorHeight = (await page.locator('#response-editor').boundingBox()).height
  await page.locator(toggleSelector).click()
  await expect(page.locator(previewSelector)).toBeVisible()
  const layout = await page.locator(previewSelector).evaluate(host => ({
    clientHeight: host.clientHeight, scrollHeight: host.scrollHeight,
    rect: { top: host.getBoundingClientRect().top, height: host.getBoundingClientRect().height },
    overflowY: getComputedStyle(host).overflowY, pageScroll: scrollY, pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight
  }))
  await test.info().attach('mobile-preview-scroll-layout', { contentType: 'application/json', body: JSON.stringify({ editorHeight, ...layout }, null, 2) })
  expect(layout.clientHeight, JSON.stringify({ editorHeight, ...layout })).toBeLessThan(layout.scrollHeight - 300)
  expect(Math.abs(layout.rect.height - editorHeight), 'preview and editor retain the same mobile scroll viewport').toBeLessThanOrEqual(25)
  const box = await wordBox(page, previewSelector, token)
  expect(box).not.toBeNull()
  await page.locator(previewSelector).evaluate((host, y) => { host.scrollTop += y - host.getBoundingClientRect().top - 6 }, box.y)
  await paint(page)
  const position = await wordBox(page, previewSelector, token)
  const before = await page.evaluate(() => ({ scrollY, toggle: document.querySelector('[data-response-view="toggle"]').getBoundingClientRect().toJSON() }))
  expect(position.y).toBeGreaterThanOrEqual(0)
  expect(position.y + position.height).toBeLessThanOrEqual(844)
  expect(before.toggle.top).toBeGreaterThanOrEqual(0)
  expect(before.toggle.bottom, 'the preview toggle remains reachable while reading its middle').toBeLessThanOrEqual(844)
  await page.locator(toggleSelector).click()
  await assertEditorAt(page, token, position, source.indexOf(token))
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(before.scrollY, 0)
  expect(await sharedText(page)).toBe(source)
})
