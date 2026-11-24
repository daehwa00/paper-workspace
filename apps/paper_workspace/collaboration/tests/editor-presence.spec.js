import { expect, test } from './fixtures.js'

async function openEditor(page, value = 'alpha beta gamma') {
  await page.route('**/editor-presence-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="presence-editor" style="position:absolute;left:20px;top:50px;width:260px;height:190px"></div><script src="/vendor/paper-editor.js"></script></body></html>' }))
  await page.goto('/editor-presence-fixture')
  await page.waitForFunction(() => window.PaperEditor?.createEditor)
  await page.evaluate(value => {
    window.presenceChanges = []
    window.presenceSelections = []
    window.presenceEditor = PaperEditor.createEditor({
      parent: document.getElementById('presence-editor'), value, language: 'plain',
      onChange: text => presenceChanges.push(text), onSelection: (...range) => presenceSelections.push(range)
    })
  }, value)
}

test('remote ranges and reverse-selection carets coexist with mappings without changing local edits', async ({ page }) => {
  await openEditor(page)
  const initial = await page.evaluate(() => {
    presenceEditor.setSelection(2, 4)
    presenceEditor.setHighlights([{ start: 6, end: 10, id: 'mapping-a', color: 2 }])
    const before = { text: presenceEditor.getValue(), selection: presenceEditor.getSelection(), selectionEvents: presenceSelections.length }
    presenceEditor.setRemoteSelections([{ id: 'remote-a', name: 'Reviewer A', color: '#2476b8', anchor: 10, head: 6 }])
    return { before, after: { text: presenceEditor.getValue(), selection: presenceEditor.getSelection(), selectionEvents: presenceSelections.length }, changes: presenceChanges }
  })
  expect(initial.after).toEqual(initial.before)
  expect(initial.changes).toEqual([])
  await expect(page.locator('.cm-remoteSelection')).toHaveText('beta')
  await expect(page.locator('.rebuttal-span')).toHaveText('beta')
  await expect(page.locator('.cm-remoteCaret-label')).toHaveText('Reviewer A')
  expect(await page.evaluate(() => presenceEditor.view.posAtDOM(document.querySelector('.cm-remoteCaret'), 0))).toBe(6)

  await page.evaluate(() => presenceEditor.replaceRange('XX', 0, 0, false))
  await expect(page.locator('.cm-remoteSelection')).toHaveText('beta')
  await expect(page.locator('.rebuttal-span')).toHaveText('beta')
  expect(await page.evaluate(() => presenceEditor.view.posAtDOM(document.querySelector('.cm-remoteCaret'), 0))).toBe(8)
  await page.evaluate(() => {
    presenceEditor.setRemoteSelections([{ id: 'remote-a', name: 'Renamed', color: '#c54', anchor: 8, head: 12 }])
    presenceEditor.focus()
  })
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => presenceEditor.getValue())).toBe('alpha beta gamma')
  await expect(page.locator('.cm-remoteSelection')).toHaveText('beta')
  await page.evaluate(() => presenceEditor.setRemoteSelections([]))
  await expect(page.locator('.cm-remoteCaret')).toHaveCount(0)
  await expect(page.locator('.rebuttal-span')).toHaveText('beta')
})

test('remote input is bounded and names and colors are safe', async ({ page }) => {
  await openEditor(page, 'short')
  await page.evaluate(() => presenceEditor.setRemoteSelections([
    { id: 'unsafe', name: '<img src=x onerror=alert(1)>' + 'Long name '.repeat(30), color: 'red;position:fixed', anchor: -30, head: 400 },
    { id: 'short-color', name: 'Short hex', color: '#abc', anchor: 2.8, head: 2.2 },
    { id: 'invalid', name: 'Ignored', color: '#abcdef', anchor: NaN, head: 2 },
    { id: 'infinite', name: 'Ignored', color: '#abcdef', anchor: 2, head: Infinity },
    null
  ]))
  await expect(page.locator('.cm-remoteCaret')).toHaveCount(2)
  expect(await page.locator('.cm-remoteSelection').evaluate(span => {
    const copy = span.cloneNode(true)
    copy.querySelectorAll('.cm-remoteCaret').forEach(caret => caret.remove())
    return copy.textContent
  })).toBe('short')
  await expect(page.locator('.cm-remoteCaret img')).toHaveCount(0)
  const result = await page.evaluate(() => [...document.querySelectorAll('.cm-remoteCaret')].map(caret => ({
    id: caret.dataset.remoteId, position: presenceEditor.view.posAtDOM(caret, 0), color: caret.style.borderColor,
    text: caret.textContent, labelWidth: caret.firstElementChild.getBoundingClientRect().width
  })))
  expect(result.find(item => item.id === 'unsafe')).toMatchObject({ position: 5, color: 'rgb(82, 102, 184)' })
  expect(result.find(item => item.id === 'unsafe').text).toHaveLength(80)
  expect(result.find(item => item.id === 'short-color')).toMatchObject({ position: 2, color: 'rgb(170, 187, 204)' })
  expect(result.every(item => item.labelWidth <= 160)).toBe(true)
})

test('initial document assignment and document history never restore old remote cursors', async ({ page }) => {
  await openEditor(page, 'alpha')
  const result = await page.evaluate(() => {
    const remote = [{ id: 'remote-a', name: 'A', color: '#123456', anchor: 1, head: 3 }]
    const count = () => presenceEditor.dom.querySelectorAll('.cm-remoteCaret').length
    presenceEditor.setRemoteSelections(remote)
    presenceEditor.setDocument('a', 'alpha')
    const initial = count()
    presenceEditor.setRemoteSelections(remote)
    presenceEditor.replaceRange(' local', 5, 5)
    presenceEditor.setValue('alpha local external')
    presenceEditor.setDocument('b', 'bravo')
    const switched = count()
    presenceEditor.setRemoteSelections(remote)
    presenceEditor.setDocument('a', 'alpha local external')
    const restoredA = count()
    presenceEditor.setDocument('b', 'bravo')
    const restoredB = count()
    presenceEditor.setDocument('a', 'alpha local external')
    presenceEditor.focus()
    return { initial, switched, restoredA, restoredB }
  })
  expect(result).toEqual({ initial: 0, switched: 0, restoredA: 0, restoredB: 0 })
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => presenceEditor.getValue())).toBe('alpha external')
  await expect(page.locator('.cm-remoteCaret')).toHaveCount(0)
})

test('cursor widgets follow wrapped text and scrolling while long labels fit the scroller', async ({ page }) => {
  const firstLine = 'wrapped words with spaces '.repeat(16)
  const value = firstLine + '\n' + Array.from({ length: 60 }, (_, index) => `line ${index} for scrolling`).join('\n')
  await openEditor(page, value)
  const assertAligned = async position => {
    await expect.poll(() => page.evaluate(position => {
      const caret = document.querySelector('.cm-remoteCaret')
      if (!caret) return false
      const expected = presenceEditor.coordsAt(position)
      const actual = caret.getBoundingClientRect()
      const label = caret.firstElementChild.getBoundingClientRect()
      const scroll = presenceEditor.scrollDOM.getBoundingClientRect()
      return expected && Math.abs(actual.left - expected.left) <= 3 && actual.top < expected.bottom && actual.bottom > expected.top && label.left >= scroll.left && label.right <= scroll.right && presenceEditor.scrollDOM.scrollWidth <= presenceEditor.scrollDOM.clientWidth + 1
    }, position)).toBe(true)
  }
  await page.evaluate(() => presenceEditor.setRemoteSelections([{ id: 'wrap', name: 'Long collaborator name '.repeat(20), color: '#3377bb', anchor: 45, head: 45 }]))
  await assertAligned(45)
  const target = firstLine.length + 1 + value.slice(firstLine.length + 1).indexOf('line 40 ')
  await page.evaluate(target => {
    presenceEditor.setRemoteSelections([{ id: 'scroll', name: 'Long collaborator name '.repeat(20), color: '#3377bb', anchor: target, head: target }])
    presenceEditor.scrollTo(target)
  }, target)
  await assertAligned(target)
  expect(await page.evaluate(() => presenceEditor.scrollDOM.scrollTop)).toBeGreaterThan(0)
  await page.evaluate(() => { document.getElementById('presence-editor').style.width = '140px' })
  await assertAligned(target)
})

test('first visible line labels fit vertically without adding content padding or editing text', async ({ page }) => {
  const value = Array.from({ length: 70 }, (_, index) => `row ${index} text`).join('\n')
  await openEditor(page, value)
  await page.addStyleTag({ content: '#presence-editor .cm-content { padding-top: 0; padding-bottom: 0; }' })
  const showCursor = position => page.evaluate(position => presenceEditor.setRemoteSelections([
    { id: 'first-visible', name: 'First visible line author '.repeat(8), color: '#3377bb', anchor: position, head: position }
  ]), position)
  const assertLabelBounds = async () => {
    await expect.poll(() => page.evaluate(() => {
      const caret = document.querySelector('.cm-remoteCaret')
      if (!caret) return false
      const label = caret.firstElementChild
      const rect = label.getBoundingClientRect()
      const bounds = presenceEditor.scrollDOM.getBoundingClientRect()
      return getComputedStyle(label).visibility === 'visible' && rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right && presenceEditor.scrollDOM.scrollWidth <= presenceEditor.scrollDOM.clientWidth + 1
    })).toBe(true)
  }
  await showCursor(0)
  await assertLabelBounds()
  expect(await page.evaluate(() => {
    const caret = document.querySelector('.cm-remoteCaret')
    return caret.firstElementChild.getBoundingClientRect().top >= caret.getBoundingClientRect().bottom - 1
  })).toBe(true)

  const target = value.indexOf('row 40 text')
  await showCursor(target)
  await page.evaluate(target => {
    presenceEditor.scrollTo(target)
  }, target)
  await expect(page.locator('.cm-remoteCaret')).toHaveCount(1)
  await page.evaluate(() => {
    const caret = document.querySelector('.cm-remoteCaret').getBoundingClientRect()
    const bounds = presenceEditor.scrollDOM.getBoundingClientRect()
    presenceEditor.scrollDOM.scrollTop += caret.top - bounds.top
  })
  await assertLabelBounds()
  await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector('.cm-remoteCaret').getBoundingClientRect().top - presenceEditor.scrollDOM.getBoundingClientRect().top))).toBeLessThan(2)
  await page.evaluate(() => { document.getElementById('presence-editor').style.width = '140px' })
  await assertLabelBounds()
  expect(await page.evaluate(() => ({ text: presenceEditor.getValue(), changes: presenceChanges, padding: getComputedStyle(presenceEditor.contentDOM).paddingTop }))).toEqual({ text: value, changes: [], padding: '0px' })
})
