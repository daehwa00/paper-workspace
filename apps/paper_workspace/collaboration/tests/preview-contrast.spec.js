import { expect, test } from './fixtures.js'

// Preview text is application UI; its formulas/code must remain legible in both
// themes even though the rendered PDF keeps the document's original colors.
async function contrast(locator) {
  return locator.evaluate(element => {
    const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
    const luminance = color => rgb(color).map(value => {
      const channel = value / 255
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    let parent = element
    while (getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)' && parent.parentElement) parent = parent.parentElement
    const foreground = luminance(getComputedStyle(element).color)
    const background = luminance(getComputedStyle(parent).backgroundColor)
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
  })
}

for (const theme of ['light', 'dark']) test(`comment and Codex preview formulas retain readable contrast in ${theme}`, async ({ page }, testInfo) => {
  let requests = 0
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
  await page.route('**/api/codex', route => {
    requests++
    return route.fulfill({ json: { replacement: 'We estimate $x^2 + y^2$ using \\texttt{sample_size}.', summary: 'Clarify the estimate.' } })
  })
  await page.goto(`/p/preview-contrast-${theme}-${Date.now()}?lang=en`)
  await page.waitForFunction(() => workspaceReadyForCompile && sharedMetadataReady)
  const source = '\\documentclass{article}\n\\begin{document}\nWe estimate $x^2 + y^2$ using \\texttt{sample_size}.\n\\end{document}\n'
  await page.locator('.cm-content').fill(source)
  await page.evaluate(() => {
    const text = editorValue(), start = text.indexOf('We estimate'), end = text.indexOf('\n', start)
    setEditorSelection(start, end)
    addCommentForSelection(selectedEditorRange(), 'Check the equation and sample size.')
  })
  expect(requests).toBe(0)
  await page.locator('[data-tab=comments]').click()
  const anchor = page.locator('.comment-card .comment-anchor')
  await expect(anchor.locator('.latex-math')).toContainText('x2 + y2')
  await anchor.screenshot({ path: testInfo.outputPath('comment-preview.png') })
  for (const selector of ['.latex-math', 'code']) expect(await contrast(anchor.locator(selector)), `comment ${selector}`).toBeGreaterThanOrEqual(4.5)
  await page.locator('[data-tab=assist]').click()
  await page.locator('#instruction').fill('Clarify the estimate')
  await page.locator('#ask').click()
  const proposal = page.locator('.codex-result .codex-proposal')
  await expect(proposal.locator('.latex-math')).toBeVisible()
  await proposal.screenshot({ path: testInfo.outputPath('codex-preview.png') })
  expect(requests).toBe(1)
  for (const selector of ['.latex-math', 'code']) expect(await contrast(proposal.locator(selector)), `proposal ${selector}`).toBeGreaterThanOrEqual(4.5)
  await expect(page.locator('.cm-content')).toContainText('We estimate $x^2 + y^2$ using \\texttt{sample_size}.')
})

for (const theme of ['light', 'dark']) test(`inline selection inputs stay readable and cancel without an AI call in ${theme}`, async ({ page }, testInfo) => {
  let requests = 0
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
  await page.route('**/api/codex', route => { requests++; return route.abort() })
  await page.goto(`/p/inline-contrast-${theme}-${Date.now()}?lang=en`)
  await page.waitForFunction(() => workspaceReadyForCompile)
  const content = page.locator('.cm-content')
  await content.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.up('Shift')
  const codexAction = page.locator('#selection-codex')
  await expect(codexAction).toBeVisible()
  expect(await contrast(codexAction), 'selection primary label').toBeGreaterThanOrEqual(4.5)
  const original = await page.evaluate(() => editorValue())
  for (const composer of ['comment', 'codex']) {
    await page.locator(`#selection-${composer}`).click()
    const input = page.locator(`#selection-${composer}-prompt`)
    await expect(input).toBeFocused()
    await input.fill('선택한 문장을 명확하게 · Clarify the selected paragraph')
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => document.activeElement.id), 'hidden selection actions stay out of keyboard navigation').not.toMatch(/^selection-(comment|codex)$/)
    await input.focus()
    await page.locator('#selection-toolbar').screenshot({ path: testInfo.outputPath(`inline-${composer}.png`), animations: 'disabled' })
    expect(await contrast(input), `${composer} input`).toBeGreaterThanOrEqual(4.5)
    await page.keyboard.press('Escape')
    await expect(page.locator(`#selection-${composer}-composer`)).toBeHidden()
  }
  expect(requests).toBe(0)
  expect(await page.evaluate(() => editorValue())).toBe(original)
})

for (const theme of ['light', 'dark']) test(`mobile notifications leave the selection composer readable in ${theme}`, async ({ page }, testInfo) => {
  await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/p/selection-toast-${theme}-${width}-${Date.now()}?lang=ko`)
    await page.waitForFunction(() => workspaceReadyForCompile)
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Shift')
    await page.locator('#selection-comment').click()
    await expect(page.locator('#selection-comment-prompt')).toBeFocused()
    await page.locator('#selection-comment-prompt').fill('수식의 근거를 확인해 주세요 · Check the equation')
    await page.evaluate(() => notify('공유 자산 목록을 불러오지 못했습니다.', { title: '공유 자산 연결 지연' }))
    await expect(page.locator('.app-toast.visible').last()).toBeVisible()
    const toolbar = await page.locator('#selection-toolbar').boundingBox()
    for (const toast of await page.locator('.app-toast.visible').all()) {
      const box = await toast.boundingBox()
      expect(box.y + box.height, `${width}px notification sits above the composer`).toBeLessThanOrEqual(toolbar.y - 8)
    }
    for (const selector of ['#selection-comment-prompt', '#selection-comment-send', '#selection-comment-close']) {
      const control = await page.locator(selector).boundingBox()
      // Enter transitions can produce floating-point bounds just below 44.
      expect(control.width + .01).toBeGreaterThanOrEqual(44)
      expect(control.height + .01).toBeGreaterThanOrEqual(44)
    }
    await page.screenshot({ path: testInfo.outputPath(`mobile-selection-${width}.png`), animations: 'disabled' })
  }
})
