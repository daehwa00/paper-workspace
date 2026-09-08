import { expect, test } from './fixtures.js'

function pagePdf(pageCount = 5) {
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

async function openWorkspaceWithPdf(page, { zoom = null, waitForVisiblePdf = true } = {}) {
  const pdf = pagePdf()
  if (zoom) {
    await page.addInitScript(layout => localStorage.setItem('paper-workspace-layout', JSON.stringify(layout)), zoom)
  } else {
    await page.addInitScript(() => localStorage.removeItem('paper-workspace-layout'))
  }
  await page.route('**/vendor/pdfjs/*.mjs', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.route('**/api/compile', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ elapsed_ms: 12, cached: false, compile_id: 'readingzoom1234567890123456', pdf_audit: { page_count: 5 }, pdf_base64: pdf.toString('base64'), synctex_base64: '' })
  }))
  await page.goto('/?lang=en')
  if (waitForVisiblePdf) await expect(page.locator('.pdf-page[data-page="1"] canvas')).toHaveCSS('visibility', 'visible')
}

async function pdfAnchor(page) {
  return page.evaluate(() => window.PaperPdfViewport.capture(
    document.querySelector('.preview-panel'),
    document.querySelectorAll('.pdf-page')
  ))
}

test('saved reading zoom remains intact until the explicit source and PDF fit actions', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openWorkspaceWithPdf(page, { zoom: { editorZoom: 0.7, pdfZoom: 0.6 } })

  await expect(page.locator('#editor-zoom-value')).toHaveText('70%')
  await expect(page.locator('#pdf-zoom-value')).toHaveText('60%')
  await expect(page.locator('#editor-zoom-value')).toHaveAttribute('aria-label', 'View source at 100%')
  await expect(page.locator('#pdf-zoom-value')).toHaveAttribute('aria-label', 'Fit PDF to width')
  await expect(page.locator('.pdf-canvas-viewer')).toHaveCSS('zoom', '0.6')

  await page.evaluate(() => window.setEditorSelection(4, 24, { scroll: true }))
  await page.locator('#editor-zoom-value').click()
  await expect(page.locator('#editor-zoom-value')).toHaveText('100%')
  expect(await page.evaluate(() => editorSelection())).toEqual({ start: 4, end: 24 })

  await page.locator('.pdf-page[data-page="4"]').evaluate(element => element.scrollIntoView({ block: 'center' }))
  await expect(page.locator('.pdf-page[data-page="4"] canvas')).toHaveCSS('visibility', 'visible')
  const beforeFit = await pdfAnchor(page)
  await page.locator('#pdf-zoom-value').click()
  await expect(page.locator('#pdf-zoom-value')).toHaveText('100%')
  const afterFit = await pdfAnchor(page)
  expect(afterFit.pageNumber).toBe(beforeFit.pageNumber)
  expect(Math.abs(afterFit.pageProgress - beforeFit.pageProgress)).toBeLessThan(0.025)

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('paper-workspace-layout')))
  expect(stored.editorZoom).toBe(1)
  expect(stored.pdfZoom).toBe(1)
})

test('incremental and modified-wheel zoom stay available after using reading presets', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openWorkspaceWithPdf(page, { zoom: { editorZoom: 0.7, pdfZoom: 0.6 } })

  await page.locator('#editor-zoom-in').click()
  await expect(page.locator('#editor-zoom-value')).toHaveText('80%')
  await page.locator('#pdf-zoom-in').click()
  await expect(page.locator('#pdf-zoom-value')).toHaveText('70%')
  await page.locator('#editor-panel').evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })))
  await expect(page.locator('#editor-zoom-value')).toHaveText('90%')
  await page.locator('.preview-panel').evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, metaKey: true, deltaY: -100 })))
  await expect(page.locator('#pdf-zoom-value')).toHaveText('80%')

  await page.locator('#editor-zoom-value').click()
  await page.locator('#pdf-zoom-value').click()
  await page.locator('#editor-zoom-out').click()
  await page.locator('#pdf-zoom-out').click()
  await expect(page.locator('#editor-zoom-value')).toHaveText('90%')
  await expect(page.locator('#pdf-zoom-value')).toHaveText('90%')
})

test('PDF fit follows panel width and keeps the current page anchor through resize', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openWorkspaceWithPdf(page, { zoom: { editorZoom: 1, pdfZoom: 0.6 } })

  await page.locator('.pdf-page[data-page="4"]').evaluate(element => element.scrollIntoView({ block: 'center' }))
  await expect(page.locator('.pdf-page[data-page="4"] canvas')).toHaveCSS('visibility', 'visible')
  await page.locator('#pdf-zoom-value').click()
  const beforeResize = await pdfAnchor(page)
  const originalWidth = await page.locator('.preview-panel').evaluate(element => element.clientWidth)
  await page.locator('[data-resize="editor-preview"]').focus()
  for (let index = 0; index < 8; index += 1) await page.keyboard.press('ArrowLeft')
  await expect.poll(() => page.locator('.preview-panel').evaluate(element => element.clientWidth)).toBeGreaterThan(originalWidth + 100)
  const afterResize = await pdfAnchor(page)
  expect(afterResize.pageNumber).toBe(beforeResize.pageNumber)
  expect(Math.abs(afterResize.pageProgress - beforeResize.pageProgress)).toBeLessThan(0.025)

  const fit = await page.evaluate(() => {
    const preview = document.getElementById('paper-preview')
    const page = document.querySelector('.pdf-page[data-page="4"]')
    return { previewWidth: preview.clientWidth, pageWidth: page.getBoundingClientRect().width }
  })
  expect(Math.abs(fit.previewWidth - 36 - fit.pageWidth)).toBeLessThanOrEqual(2)
})

for (const width of [320, 390]) {
  test(`reading presets remain keyboard-accessible and contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await openWorkspaceWithPdf(page, { zoom: { editorZoom: 0.7, pdfZoom: 0.6 }, waitForVisiblePdf: false })

    await page.locator('#editor-zoom-value').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#editor-zoom-value')).toHaveText('100%')
    await page.getByRole('button', { name: 'PDF', exact: true }).click()
    await expect(page.locator('.pdf-page[data-page="1"] canvas')).toHaveCSS('visibility', 'visible')
    await page.locator('#pdf-zoom-value').focus()
    await page.keyboard.press(' ')
    await expect(page.locator('#pdf-zoom-value')).toHaveText('100%')
    const header = page.locator('.preview-header')
    const contained = await page.locator('#pdf-zoom-out, #pdf-zoom-value, #pdf-zoom-in, #download-pdf, #refresh-pdf').evaluateAll((controls, selector) => {
      const bounds = document.querySelector(selector).getBoundingClientRect()
      return controls.map(control => {
        const box = control.getBoundingClientRect()
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1
      })
    }, '.preview-header')
    expect(contained).toEqual([true, true, true, true, true])
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth)).toBe(width)
  })
}
