import { expect, test } from './fixtures.js'

async function openWorkspace(page) {
  await page.goto('/?lang=ko')
  await page.waitForFunction(() => workspaceReadyForCompile)
}

async function expectContained(locator, container) {
  const outer = await container.boundingBox()
  const inner = await locator.boundingBox()
  expect(inner).not.toBeNull()
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1)
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1)
}

for (const theme of ['light', 'dark']) {
  test(`collapsed sidebar is an aligned, keyboard-safe rail in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
    await openWorkspace(page)
    await page.locator('#file-search').fill('main.tex')
    const toggle = page.locator('#toggle-sidebar')
    for (const width of [1600, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.locator('#file-search')).toBeHidden()
      await expect(page.locator('#new-file')).toBeHidden()
      await expect(page.locator('#files')).toBeHidden()
      await expect.poll(async () => {
        const button = await toggle.boundingBox()
        const header = await page.locator('#editor-panel > .panel-header').boundingBox()
        return Math.abs(button.y + button.height / 2 - header.y - header.height / 2)
      }).toBeLessThanOrEqual(1)
      await page.keyboard.press('Tab')
      await toggle.focus()
      await expect(toggle).toHaveCSS('outline-style', 'solid')
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement.id)).not.toMatch(/file-search|new-file|new-folder/)
      await toggle.click()
      await expect(page.locator('#file-search')).toBeVisible()
      await expect(page.locator('#file-search')).toHaveValue('main.tex')
    }
  })
}

for (const width of [320, 390]) {
  test(`desktop collapse does not hide mobile files at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await openWorkspace(page)
    await page.locator('#toggle-sidebar').click()
    await page.setViewportSize({ width, height: 844 })
    await page.locator('[data-focus="files"]').click()
    await expect(page.locator('#files .file').first()).toBeVisible()
    await expect(page.locator('#new-file')).toBeVisible()
    await expect(page.locator('#toggle-sidebar')).toBeHidden()
    await page.locator('#file-search').fill('references')
    await expect(page.locator('#files .file:visible')).toHaveCount(1)
    await page.locator('#clear-file-search').click()
    await expect(page.locator('#files .file:visible')).toHaveCount(2)
    for (const selector of ['#new-file', '#new-folder', '#file-search', '#mobile-utilities > summary']) {
      const box = await page.locator(selector).boundingBox()
      expect(box.width, selector).toBeGreaterThanOrEqual(43.99)
      expect(box.height, selector).toBeGreaterThanOrEqual(43.99)
      await expectContained(page.locator(selector), page.locator('body'))
    }
    await page.setViewportSize({ width: 1600, height: 900 })
    await expect(page.locator('#file-search')).toBeHidden()
    await expect(page.locator('#toggle-sidebar')).toBeVisible()
  })
}

for (const surface of ['workspace', 'hub']) {
  test(`${surface} profile choices fit at 320px and keyboard focus remains visible`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await page.addInitScript(() => localStorage.setItem('paper-workspace-theme', 'dark'))
    await page.goto(surface === 'hub' ? '/hub.html?lang=ko' : '/?lang=ko')
    const trigger = page.locator(surface === 'hub' ? '#hub-collab-name' : '#collab-name')
    await trigger.click()
    const dialog = page.locator('.name-dialog')
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    for (const choice of await dialog.locator('.color-option').all()) {
      await expectContained(choice, dialog)
      const box = await choice.boundingBox()
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    const radio = dialog.locator('input[type="radio"]').last()
    await page.keyboard.press('Tab')
    await radio.focus()
    await expect(radio.locator('+ .color-swatch')).toHaveCSS('outline-style', 'solid')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()
  })
}

test('collapsed folders remove invisible child files from keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openWorkspace(page)
  const folder = page.locator('#files .folder-row').first()
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  const file = page.locator('#files .file').first()
  await expect(file).toBeHidden()
  expect(await file.evaluate(el => { el.focus(); return document.activeElement === el })).toBe(false)
  await folder.click()
  await expect(file).toBeVisible()
  await file.focus()
  await expect(file).toBeFocused()
})

test('sidebar resize tracks the pointer immediately and preserves editor text', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openWorkspace(page)
  const source = await page.evaluate(() => editorValue())
  const resizer = page.locator('.sidebar-resizer')
  const box = await resizer.boundingBox()
  const before = await page.locator('.sidebar').boundingBox()
  await page.mouse.move(box.x + box.width / 2, 350)
  await page.mouse.down()
  await expect(page.locator('body')).toHaveClass(/panel-resizing/)
  await page.mouse.move(box.x + box.width / 2 + 60, 350)
  const after = await page.locator('.sidebar').boundingBox()
  expect(after.width - before.width).toBeCloseTo(60, 0)
  await expect(page.locator('.sidebar')).toHaveCSS('transition-duration', '0s')
  await page.mouse.up()
  expect(await page.evaluate(() => editorValue())).toBe(source)
})

test('reduced motion removes spatial transitions and loading rotations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1600, height: 900 })
  await openWorkspace(page)
  await page.locator('#toggle-sidebar').click()
  await expect(page.locator('.sidebar')).toHaveCSS('transition-duration', '0s')
  await page.locator('#status-center-toggle').click()
  await expect(page.locator('#status-center')).toHaveCSS('transition-duration', '0s')
  await expect(page.locator('.status-chevron')).toHaveCSS('transition-duration', '0s')
  await page.locator('#status-center-close').click()
  await page.locator('#collab-name').click()
  await expect(page.locator('#name-dialog')).toHaveCSS('animation-name', 'none')
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    document.querySelector('.project-zip').classList.add('loading')
    document.querySelector('.refresh-pdf').classList.add('loading')
  })
  for (const selector of ['.project-zip svg', '.refresh-pdf svg']) await expect(page.locator(selector)).toHaveCSS('animation-name', 'none')
})

test('hub reduced motion keeps card arrows, language chevrons, and the home mark still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/projects/index.json', route => route.fulfill({ json: { projects: [{ slug: 'motion-paper', display_name_en: 'Motion paper' }] } }))
  await page.goto('/hub.html')
  await page.locator('.project-card').hover()
  await expect(page.locator('.project-arrow')).toHaveCSS('transform', 'none')
  await page.locator('#hub-language').focus()
  await expect(page.locator('.language-chevron')).toHaveCSS('transform', 'none')
  await page.locator('.hub-home').hover()
  await expect(page.locator('.hub-home')).toHaveCSS('transform', 'none')
})

test('mobile hub keeps its title readable and settings targets separate', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 700 })
    for (const language of ['ko', 'en']) {
      await page.goto(`/hub.html?lang=${language}`)
      const lineCount = await page.locator('.hub-topbar .eyebrow').evaluate(el => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return new Set([...range.getClientRects()].map(box => box.top)).size
      })
      expect(lineCount).toBeLessThanOrEqual(2)
      await expectContained(page.locator('.hub-topbar h1'), page.locator('body'))
      for (const selector of ['.language-picker', '.theme-trigger', '#hub-collab-name']) {
        const box = await page.locator(selector).boundingBox()
        expect(box.width, selector).toBeGreaterThanOrEqual(43.99)
        expect(box.height, selector).toBeGreaterThanOrEqual(43.99)
        await expectContained(page.locator(selector), page.locator('body'))
      }
    }
  }
})

test('dark assistant separators and the preview header use dark surface borders', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => localStorage.setItem('paper-workspace-theme', 'dark'))
  await openWorkspace(page)
  const border = await page.evaluate(() => {
    const probe = document.createElement('i')
    probe.style.borderTopColor = 'var(--theme-border-soft)'
    document.body.append(probe)
    const color = getComputedStyle(probe).borderTopColor
    probe.remove()
    return color
  })
  await expect(page.locator('#model-settings')).toHaveCSS('border-top-color', border)
  await expect(page.locator('#model-settings')).toHaveCSS('border-bottom-color', border)
  await expect(page.locator('.preview-header')).not.toHaveCSS('box-shadow', /rgb\(234, 236, 240\)/)
})
