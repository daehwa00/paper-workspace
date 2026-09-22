import { expect, test } from './fixtures.js'
const pdfModule = `export const GlobalWorkerOptions={};
export function getDocument(){return {promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})}),destroy(){}})}};`
for (const success of [true, false]) {
  test(`manifest preview auto-builds current source: ${success ? 'success replaces preview' : 'failure retains preview'}`, async ({ page }) => {
    let release, payload
    const ready = new Promise(resolve => { release = resolve })
    await page.route('**/project/project.json', async route => {
      const response = await route.fetch(), manifest = await response.json()
      manifest.preview_pdf = 'old-preview.pdf'
      await route.fulfill({ response, json: manifest })
    })
    await page.route('**/project/old-preview.pdf', route => route.fulfill({contentType:'application/pdf',body:Buffer.from('%PDF-1.4 old preview')}))
    await page.route('**/vendor/pdfjs/pdf.mjs', route => route.fulfill({contentType:'text/javascript',body:pdfModule}))
    await page.route('**/api/compile', async route => {
      payload = route.request().postDataJSON()
      await ready
      await route.fulfill(success
        ? {json:{pdf_base64:Buffer.from('%PDF-1.4 latest build').toString('base64'),synctex_base64:'',elapsed_ms:5}}
        : {status:422,json:{error:'Isolated compile failure'}})
    })
    await page.goto(`/p/preview-auto-${success}-${Date.now()}?lang=en`)
    await expect.poll(() => payload?.entrypoint).toBe('main.tex')
    expect(payload.files['main.tex']).toContain('\\documentclass')
    await expect(page.locator('.pdf-page canvas')).toBeVisible()
    expect(await page.evaluate(() => renderedPdfStale)).toBe(true)
    release()
    await expect.poll(() => page.evaluate(() => compileController === null)).toBe(true)
    const pdf = await page.evaluate(async () => (await fetch(renderedPdfUrl)).text())
    expect(pdf).toContain(success ? 'latest build' : 'old preview')
    expect(await page.evaluate(() => renderedPdfStale)).toBe(!success)
  })
}
