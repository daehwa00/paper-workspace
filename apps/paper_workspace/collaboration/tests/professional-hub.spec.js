import { expect, test } from './fixtures.js'

for (const mode of ['light', 'dark']) {
  test(`professional hub shares workspace chrome and keeps stable cards in ${mode}`, async ({ page }) => {
    await page.addInitScript(mode => localStorage.setItem('paper-workspace-theme', mode), mode)
    await page.route('**/projects/index.json', route => route.fulfill({ json: { projects: [{ slug: 'paper-one', display_name_en: 'A professional research workspace', description_en: 'A manuscript ready for review.' }] } }))
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.goto('/hub.html?lang=en')
    await expect(page.locator('.project-card')).toBeVisible()
    await expect(page.locator('.hub-topbar')).toHaveCSS('height', '56px')
    await expect(page.locator('.hub-intro')).toHaveCSS('box-shadow', 'none')
    await expect(page.locator('.hub-topbar')).toHaveCSS('background-image', 'none')
    await expect(page.locator('.hub-main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('#project-search')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('.hub-intro')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const palette = await page.locator('body').evaluate(el => ({ surface: getComputedStyle(el).getPropertyValue('--theme-surface-subtle').trim(), text: getComputedStyle(el).getPropertyValue('--theme-text').trim() }))
    await page.locator('.project-card').hover()
    await expect(page.locator('.project-card')).toHaveCSS('transform', 'none')
    await expect(page.locator('.project-card')).toHaveCSS('box-shadow', 'none')
    for (const width of [800, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.body.scrollWidth)).toBe(width)
      await expect(page.locator('.hub-topbar')).toHaveCSS('height', '56px')
      const geometry = await page.locator('.hub-topbar').evaluate(header => {
        const title = header.querySelector('h1').getBoundingClientRect()
        const tools = header.querySelector('.hub-toolbar').getBoundingClientRect()
        return { titleRight: title.right, toolsLeft: tools.left, toolsRight: tools.right, width: innerWidth }
      })
      expect(geometry.titleRight).toBeLessThanOrEqual(geometry.toolsLeft)
      expect(geometry.toolsRight).toBeLessThanOrEqual(width)
    }
    await page.goto('/?lang=en')
    const workspacePalette = await page.locator('body').evaluate(el => ({ surface: getComputedStyle(el).getPropertyValue('--theme-surface-subtle').trim(), text: getComputedStyle(el).getPropertyValue('--theme-text').trim() }))
    expect(workspacePalette).toEqual(palette)
  })
}
