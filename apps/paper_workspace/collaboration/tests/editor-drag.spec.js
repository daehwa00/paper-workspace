import { expect, test } from './fixtures.js'

async function pixelAt(page, point) {
  const png = await page.screenshot({ clip: { x: point.x, y: point.y, width: 3, height: 3 } })
  return page.evaluate(async encoded => {
    const image = new Image()
    image.src = `data:image/png;base64,${encoded}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 3
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    return [...context.getImageData(1, 1, 1, 1).data].slice(0, 3)
  }, png.toString('base64'))
}

for (const theme of ['light', 'dark']) {
  for (const direction of ['down', 'up']) {
    test(`multiline drag selection is visible and preserved ${direction} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 })
      await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
      await page.goto(`/p/drag-selection-${theme}-${direction}-${Date.now()}`)
      await page.waitForFunction(() => sharedMetadataReady && workspaceReadyForCompile)
      const lines = page.locator('#editor-view .cm-line')
      const first = await lines.nth(1).boundingBox(), last = await lines.nth(8).boundingBox()
      const top = { x: first.x + 40, y: first.y + first.height / 2 }
      const bottom = { x: last.x + 90, y: last.y + last.height / 2 }
      const [start, end] = direction === 'down' ? [top, bottom] : [bottom, top]
      const original = await page.locator('#editor').inputValue()
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 18 })
      await page.mouse.up()
      await expect.poll(() => page.evaluate(() => {
        const selection = editorSelection()
        return editorValue().slice(selection.start, selection.end).split('\n').length
      })).toBeGreaterThan(4)
      await expect(page.locator('#selection-toolbar')).toBeVisible()
      await expect.poll(() => page.locator('.cm-selectionBackground').count()).toBeGreaterThan(0)
      const sample = await page.locator('.cm-selectionBackground').evaluateAll(blocks => {
        const block = [...blocks].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
        const rect = block.getBoundingClientRect()
        return { x: Math.floor(rect.right - 8), y: Math.floor(rect.top + 3), color: getComputedStyle(block).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number) }
      })
      const actual = await pixelAt(page, sample)
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[channel] - sample.color[channel]), `visible selection RGB channel ${channel}`).toBeLessThanOrEqual(2)
      await expect(page.locator('#editor')).toHaveValue(original)
    })
  }
}
