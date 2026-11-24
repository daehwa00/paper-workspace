import {expect, test} from '@playwright/test'

function samplePdf() {
  const stream = 'BT /F1 18 Tf 30 100 Td (PDF compatibility check) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`).toString('base64')
}

for (const olderMap of [false, true]) {
  test(`real PDF parses and renders with ${olderMap ? 'older browser Map APIs' : 'native browser APIs'}`, async ({page}) => {
    const missingMapMethods = 'delete Map.prototype.getOrInsert; delete Map.prototype.getOrInsertComputed;'
    if (olderMap) await page.addInitScript(missingMapMethods)
    await page.route('**/pdf-compatibility-probe.html', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>PDF compatibility probe</title><canvas></canvas>'}))
    // Use the actual vendored modules; the development server needs an explicit
    // module MIME type. Remove the APIs in the worker realm as well as the page.
    await page.route('**/vendor/pdfjs/*.mjs*', async route => {
      const response = await route.fetch()
      const worker = new URL(route.request().url()).pathname.endsWith('/pdf.worker.mjs')
      await route.fulfill({response, contentType: 'text/javascript', body: (olderMap && worker ? missingMapMethods + '\n' : '') + await response.text()})
    })
    await page.goto('/pdf-compatibility-probe.html')
    const result = await page.evaluate(async ({encoded, olderMap}) => {
      const originalMethod = Map.prototype.getOrInsertComputed
      const pdfjs = await import('/vendor/pdfjs/pdf.mjs?v=6.1.200-legacy')
      pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs?v=6.1.200-legacy'
      const data = Uint8Array.from(atob(encoded), value => value.charCodeAt(0))
      const loadingTask = pdfjs.getDocument({data, useSystemFonts: true})
      const document = await loadingTask.promise
      const page = await document.getPage(1)
      const text = await page.getTextContent()
      const viewport = page.getViewport({scale: 1})
      const canvas = globalThis.document.querySelector('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const context = canvas.getContext('2d')
      await page.render({canvasContext: context, viewport}).promise
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200) ink++
      const result = {pages: document.numPages, text: text.items.map(item => item.str).join(''), ink,
        nativePreserved: olderMap || Map.prototype.getOrInsertComputed === originalMethod}
      await loadingTask.destroy()
      return result
    }, {encoded: samplePdf(), olderMap})
    expect(result.pages).toBe(1)
    expect(result.text).toBe('PDF compatibility check')
    expect(result.ink).toBeGreaterThan(100)
    expect(result.nativePreserved).toBe(true)
  })
}
