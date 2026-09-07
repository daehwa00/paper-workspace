import { expect, test } from './fixtures.js'

test('closing the status panel before its first frame cannot reopen it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForFunction(() => sharedMetadataReady)
  const state = await page.evaluate(async () => {
    const toggle = document.getElementById('status-center-toggle')
    toggle.click()
    document.getElementById('status-center-close').click()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { expanded: toggle.getAttribute('aria-expanded'), open: document.getElementById('status-center').classList.contains('open') }
  })
  expect(state).toEqual({ expanded: 'false', open: false })
})

test('cancelled inline composition does not reappear on its queued animation frame', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => sharedMetadataReady)
  const state = await page.evaluate(async () => {
    setEditorSelection(0, 14)
    captureEditorSelection()
    prepareInlineComment()
    hideSelectionToolbar()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const toolbar = document.getElementById('selection-toolbar')
    return { hidden: toolbar.hidden, composing: toolbar.classList.contains('composing') }
  })
  expect(state).toEqual({ hidden: true, composing: false })
})

for (const surface of ['status', 'appearance']) {
  test(`opening mobile ${surface} dismisses the utility menu`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.waitForFunction(() => sharedMetadataReady)
    await page.locator('#mobile-utilities > summary').click()
    await page.locator(surface === 'status' ? '#status-center-toggle' : '.theme-trigger').click()
    await expect(page.locator('#mobile-utilities')).not.toHaveAttribute('open', '')
    await expect(page.locator(surface === 'status' ? '#status-center' : '.theme-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#mobile-utilities > summary')).toBeFocused()
  })
}
