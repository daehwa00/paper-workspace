import { expect, test } from './fixtures.js'

function pagePdf(pageCount = 4) {
  const contentId = pageCount + 3
  const pages = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.join(' ')}] /Count ${pageCount} >>`,
    ...pages.map(() => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents ${contentId} 0 R >>`),
    '<< /Length 0 >>\nstream\n\nendstream'
  ]
  let body = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

async function openWorkspace(page, width, { theme = 'light', layout = null, pdf = false } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await page.addInitScript(({ theme, layout }) => {
    localStorage.setItem('paper-workspace-theme', theme)
    if (layout) localStorage.setItem('paper-workspace-layout', JSON.stringify(layout))
    else localStorage.removeItem('paper-workspace-layout')
  }, { theme, layout })
  if (pdf) {
    const binary = pagePdf()
    await page.route('**/vendor/pdfjs/*.mjs', async route => {
      const response = await route.fetch()
      await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
    })
    await page.route('**/api/compile', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ elapsed_ms: 12, cached: false, compile_id: 'professional-shell-pdf', pdf_audit: { page_count: 4 }, pdf_base64: binary.toString('base64'), synctex_base64: '' })
    }))
  }
  await page.goto('/?lang=en')
  await page.waitForFunction(() => workspaceReadyForCompile)
  if (pdf) await expect(page.locator('.pdf-page[data-page="1"] canvas')).toHaveCSS('visibility', 'visible')
}

async function expectContained(locator, container) {
  const [inner, outer] = await Promise.all([locator.boundingBox(), container.boundingBox()])
  expect(inner).not.toBeNull()
  expect(outer).not.toBeNull()
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 1)
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1)
}

for (const width of [1024, 1600, 2048]) {
  test(`professional top bar keeps the global assistant control visible at ${width}px`, async ({ page }) => {
    await openWorkspace(page, width)
    const topbar = page.locator('.topbar')
    const toggle = page.locator('#toggle-assistant')
    await expect(toggle).toBeVisible()
    await expect(toggle).toContainText('Assistant')
    await expectContained(toggle, topbar)
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth)).toBe(width)
    const box = await toggle.boundingBox()
    expect(box.width).toBeGreaterThanOrEqual(36)
    expect(box.height).toBeGreaterThanOrEqual(36)
    expect((await topbar.boundingBox()).height).toBe(56)
  })
}

test('project title keeps a neutral surface and exposes its border only while focused', async ({ page }) => {
  await openWorkspace(page, 1600)
  const title = page.locator('#project-title')
  const before = await title.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, border: style.borderTopColor }
  })
  await title.focus()
  await expect(title).toBeFocused()
  await expect(title).not.toHaveCSS('border-top-color', before.border)
  const after = await title.evaluate(element => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, border: style.borderTopColor }
  })
  expect(before.border).toMatch(/transparent|rgba\([^)]*,\s*0\)/)
  expect(after.border).not.toBe(before.border)
  expect(after.background).toBe(before.background)
})

test('global assistant collapse removes hidden controls while preserving reading state', async ({ page }) => {
  await openWorkspace(page, 1600, { layout: { editorZoom: 0.7, pdfZoom: 0.6, assistantCollapsed: false }, pdf: true })
  const toggle = page.locator('#toggle-assistant')
  await expect(page.locator('#assistant-panel')).toBeVisible()
  await expect(page.locator('[data-resize="preview-assistant"]')).toBeVisible()
  const before = await page.evaluate(() => {
    window.setEditorSelection(4, 24, { scroll: true })
    const panel = document.querySelector('.preview-panel')
    const pages = Array.from(document.querySelectorAll('.pdf-page'))
    panel.scrollTop = pages[2].offsetTop + 180
    return { selection: editorSelection(), anchor: window.PaperPdfViewport.capture(panel, pages), editorZoom: layout.editorZoom, pdfZoom: layout.pdfZoom }
  })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#workspace')).toHaveClass(/assistant-collapsed/)
  await expect(page.locator('#assistant-panel')).toBeHidden()
  await expect(page.locator('[data-resize="preview-assistant"]')).toBeHidden()
  expect(await page.locator('#assistant-panel').evaluate(panel => {
    for (const control of panel.querySelectorAll('button,input,textarea,[tabindex]')) {
      control.focus()
      if (document.activeElement === control) return true
    }
    return false
  })).toBe(false)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#assistant-panel')).toBeVisible()
  const after = await page.evaluate(() => ({
    selection: editorSelection(),
    anchor: window.PaperPdfViewport.capture(document.querySelector('.preview-panel')),
    editorZoom: layout.editorZoom,
    pdfZoom: layout.pdfZoom
  }))
  expect(after.selection).toEqual(before.selection)
  expect(after.editorZoom).toBe(before.editorZoom)
  expect(after.pdfZoom).toBe(before.pdfZoom)
  expect(after.anchor.pageNumber).toBe(before.anchor.pageNumber)
  expect(Math.abs(after.anchor.pageProgress - before.anchor.pageProgress)).toBeLessThan(0.03)
})

test('panel headers share a compact geometry and neutral dark surfaces', async ({ page }) => {
  await openWorkspace(page, 1600, { theme: 'dark', layout: { assistantCollapsed: false } })
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark')
  const headers = await page.locator('#editor-panel > .panel-header, .preview-panel > .panel-header, #assistant-panel > .panel-header').evaluateAll(items => items.map(item => {
    const rect = item.getBoundingClientRect()
    const style = getComputedStyle(item)
    return { top: rect.top, height: rect.height, background: style.backgroundColor, color: style.color }
  }))
  expect(headers).toHaveLength(3)
  expect(headers.every(header => Math.abs(header.height - 48) <= 1)).toBe(true)
  expect(Math.max(...headers.map(header => header.top)) - Math.min(...headers.map(header => header.top))).toBeLessThanOrEqual(1)
  for (const header of headers) {
    expect(header.background).not.toBe('rgb(255, 255, 255)')
    expect(header.color).not.toBe('rgb(29, 41, 57)')
  }
})

for (const width of [1200, 1280]) {
  test(`narrow desktop opens the assistant as an overlay at ${width}px`, async ({ page }) => {
    await openWorkspace(page, width, { layout: { sidebarWidth: 320, assistantCollapsed: true } })
    const toggle = page.locator('#toggle-assistant')
    await toggle.click()
    await expect(page.locator('#workspace')).toHaveClass(/assistant-overlay/)
    await expect(page.locator('#assistant-panel')).toBeVisible()
    await expect(page.locator('[data-resize="preview-assistant"]')).toBeHidden()
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth)).toBe(width)
    await page.locator('#close-assistant').click()
    await expect(page.locator('#assistant-panel')).toBeHidden()
    await expect(page.locator('#workspace')).not.toHaveClass(/assistant-overlay/)
  })
}

test('resizing an overlay workspace restores the full assistant grid when it fits', async ({ page }) => {
  await openWorkspace(page, 1200, { layout: { sidebarWidth: 320, assistantCollapsed: true } })
  await page.locator('#toggle-assistant').click()
  await expect(page.locator('#workspace')).toHaveClass(/assistant-overlay/)
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(page.locator('#workspace')).not.toHaveClass(/assistant-overlay/)
  await expect(page.locator('#assistant-panel')).toBeVisible()
  await expect(page.locator('[data-resize="preview-assistant"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth)).toBe(1600)
})

for (const width of [320, 390]) {
  test(`mobile assistant focus uses its internal close control at ${width}px`, async ({ page }) => {
    await openWorkspace(page, width, { layout: { assistantCollapsed: false } })
    await expect(page.locator('#toggle-assistant')).toBeHidden()
    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    await expect(page.locator('#assistant-panel')).toBeVisible()
    await expect(page.locator('#close-assistant')).toBeVisible()
    await page.locator('#close-assistant').click()
    await expect(page.locator('#assistant-panel')).toBeHidden()
    await expect(page.locator('#editor-panel')).toBeVisible()
    const source = page.locator('#focus-modes button[data-focus="source"]')
    await expect(source).toHaveClass(/is-active/)
    await expect(source).toBeFocused()
  })
}
