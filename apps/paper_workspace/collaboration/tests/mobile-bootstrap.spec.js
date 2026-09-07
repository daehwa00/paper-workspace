import { expect, test } from './fixtures.js'

// Keep the raster task pending for the real visibility observer. The fixture
// contains no production manuscript or PDF.
const delayedPdfModule = `
export const GlobalWorkerOptions = {};
export function getDocument() {
  const page = {
    getViewport: ({scale}) => ({width: 600 * scale, height: 800 * scale}),
    render: () => {
      let reject, timer;
      const promise = new Promise((resolve, fail) => {
        reject = fail;
        timer = setTimeout(resolve, 300);
      });
      return {promise, cancel() {
        clearTimeout(timer);
        window.__mobilePdfCancelled = (window.__mobilePdfCancelled || 0) + 1;
        const error = new Error('Rendering cancelled because the page left the viewport');
        error.name = 'RenderingCancelledException';
        reject(error);
      }};
    }
  };
  return {promise: Promise.resolve({numPages: 1, getPage: async () => page, destroy() {}})};
}`

for (const width of [390, 1600]) {
  test(`workspace bootstrap survives a saved PDF outside the viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('RenderingCancelledException')) errors.push(message.text()) })
    const fingerprint = 'a'.repeat(64)
    await page.route('**/project/project.json', async route => {
      const response = await route.fetch()
      const manifest = await response.json()
      delete manifest.preview_pdf
      delete manifest.preview_synctex
      await route.fulfill({ response, json: manifest })
    })
    await page.route('**/vendor/pdfjs/pdf.mjs', route => route.fulfill({ contentType: 'text/javascript', body: delayedPdfModule }))
    await page.route(/\/api\/backups\/projects\/[^/]+\/assets(?:\/.*)?$/, route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/assets')) return route.fulfill({ json: { assets: ['pdf', 'synctex.gz'].map(extension => ({ path: `__paper_workspace/preview-${fingerprint}.${extension}` })) } })
      return route.fulfill({ body: path.endsWith('.pdf') ? Buffer.from('%PDF-1.4 dummy fixture') : Buffer.from([0x1f, 0x8b, 8, 0]) })
    })
    await page.route('**/api/compile', route => route.fulfill({ status: 503, json: { error: 'Compilation intentionally unavailable in the isolated bootstrap fixture' } }))
    await page.goto(`/p/mobile-bootstrap-${width}-${Date.now()}`)
    await expect.poll(() => page.evaluate(() => sharedMetadataReady && projectBootstrapComplete && workspaceReadyForCompile)).toBe(true)
    await expect.poll(() => page.evaluate(() => editorValue().includes('\\documentclass'))).toBe(true)
    if (width === 390) {
      expect(await page.evaluate(() => window.__mobilePdfCancelled)).toBeGreaterThan(0)
      await page.locator('#focus-modes [data-focus="preview"]').click()
    }
    await expect(page.locator('.pdf-page canvas')).toBeVisible()
    await expect.poll(() => page.locator('.pdf-page canvas').evaluate(canvas => canvas.style.visibility)).toBe('visible')
    expect(errors).toEqual([])
  })
}
