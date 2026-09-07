import { expect, test } from './fixtures.js'

test('mobile source controls stay inside the header with long filenames and save status', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?lang=ko')
  await page.waitForFunction(() => workspaceReadyForCompile)
  await page.evaluate(() => document.fonts.ready)
  for (const filename of ['paper/main.tex', 'paper/sections/a-very-long-section-name.tex']) {
    const measurements = await page.evaluate(filename => {
      document.getElementById('active-file').textContent = filename
      document.getElementById('save-state').textContent = '서버 원고 표시됨 · 공동 편집 병합 중'
      const header = document.querySelector('#editor-panel > .panel-header')
      const bounds = header.getBoundingClientRect()
      const controls = ['active-file', 'save-state', 'download-project-zip', 'editor-zoom-out', 'editor-zoom-value', 'editor-zoom-in']
      return {
        overflow: header.scrollWidth - header.clientWidth,
        controls: controls.map(id => {
          const box = document.getElementById(id).getBoundingClientRect()
          return { id, inside: box.left >= bounds.left && box.right <= bounds.right, width: box.width }
        })
      }
    }, filename)
    expect(measurements.overflow).toBeLessThanOrEqual(1)
    for (const control of measurements.controls) {
      expect(control.inside, control.id).toBe(true)
      expect(control.width, control.id).toBeGreaterThan(0)
    }
  }
})

test('dark zoom labels and inactive mobile tabs use the muted theme color', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('paper-workspace-theme', 'dark'))
  await page.goto('/?lang=ko')
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark')
  await expect(page.locator('#editor-zoom-value')).toHaveCSS('color', 'rgb(168, 181, 201)')
  await expect(page.locator('.focus-modes button:not(.is-active)').first()).toHaveCSS('color', 'rgb(168, 181, 201)')
})

test('the editor word count follows language changes without changing the manuscript', async ({ page }) => {
  await page.goto('/?lang=ko')
  await page.waitForFunction(() => workspaceReadyForCompile)
  const count = await page.evaluate(() => editorValue().trim().split(/\s+/).filter(Boolean).length)
  await expect(page.locator('#word-count')).toHaveText(`${count}단어`)
  await page.locator('#workspace-language').selectOption('en')
  await expect(page.locator('#word-count')).toHaveText(`${count} ${count === 1 ? 'word' : 'words'}`)
  await page.locator('#workspace-language').selectOption('ko')
  await expect(page.locator('#word-count')).toHaveText(`${count}단어`)
})
