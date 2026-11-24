import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from './fixtures.js'
const artifacts=resolve(import.meta.dirname,'../../../../.omx/artifacts/linear-refresh')
mkdirSync(artifacts,{recursive:true})
async function open(page,theme,width){
 await page.setViewportSize({width,height:1000});await page.emulateMedia({reducedMotion:'reduce'})
 await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
 await page.route('**/vendor/pdfjs/*.mjs*',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-type':'text/javascript'}})})
 if(process.env.PAPER_VISUAL_PDF)await page.route('**/api/compile',route=>route.fulfill({json:{elapsed_ms:1,cached:false,compile_id:'visual-reference',pdf_base64:readFileSync(process.env.PAPER_VISUAL_PDF).toString('base64'),synctex_base64:''}}))
 await page.goto(`/p/linear-visual-${theme}-${width}-${Date.now()}?lang=en`);await page.waitForFunction(()=>workspaceReadyForCompile);await page.evaluate(()=>document.fonts.ready)
 if(process.env.PAPER_VISUAL_PDF&&width===1600)await expect(page.locator('.pdf-page canvas').first()).toBeVisible()
}
for(const theme of ['light','dark'])for(const width of [320,390,1024,1600])test(`Linear frame and long labels ${theme} ${width}`,async({page})=>{
 await open(page,theme,width)
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
 await page.screenshot({path:resolve(artifacts,`workspace-after-${theme}-${width}.png`),animations:'disabled'})
 for(const lang of ['en','ko']){
  await page.evaluate(lang=>{document.querySelector('#project-title').value=lang==='ko'?'불확실성을 고려한 장기 공동 연구 프로젝트의 매우 긴 논문 제목':'A very long collaborative research project title concerning reproducibility and uncertainty';document.querySelector('#active-file').textContent='paper/sections/a-very-long-research-section-name.tex'},lang)
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
  if(width<768){await page.locator('[data-focus=files]').click();await expect(page.locator('.sidebar')).toBeVisible();await page.locator('[data-focus=assistant]').click()}
  else if(width===1024)await page.locator('#toggle-assistant').click()
  for(const name of ['assist','comments','sources','checks','tasks']){await page.locator(`[data-tab=${name}]`).click();await expect(page.locator(`#${name}`)).toBeVisible();expect(await page.locator(`#${name}`).evaluate(e=>e.scrollWidth-e.clientWidth),`${lang}/${name}`).toBeLessThanOrEqual(1)}
  if(width===1024)await page.locator('#close-assistant').click()
  if(width<768)await page.locator('[data-focus=source]').click()
 }
})
test('shared controls expose hover, keyboard, disabled and loading states',async({page})=>{
 await open(page,'dark',1600)
 const button=page.locator('#ask'),normal=await button.evaluate(e=>getComputedStyle(e).backgroundColor)
 await button.hover();expect(await button.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe(normal)
 await button.focus();await expect(button).toBeFocused()
 const m=await page.evaluate(()=>{const e=document.querySelector('#ask'),s=getComputedStyle(e);return {height:e.getBoundingClientRect().height,font:s.fontFamily,fontSize:s.fontSize,lineHeight:s.lineHeight,outline:s.outlineWidth,sidebar:document.querySelector('.sidebar').getBoundingClientRect().width,header:document.querySelector('.topbar').getBoundingClientRect().height,dpr:devicePixelRatio,fonts:document.fonts.status}})
 expect(m.header).toBe(92);expect(m.outline).toBe('2px')
 for(const [name,selector]of Object.entries({tabs:'.assistant-tabs',header:'.topbar',sidebar:'.sidebar','primary-focus':'#ask'}))await page.locator(selector).screenshot({path:resolve(artifacts,`component-${name}-dark.png`)})
 // Render-state probes only; no fabricated request or success response.
 await button.evaluate(e=>{e.disabled=true;e.setAttribute('aria-busy','true')});await expect(button).toBeDisabled();await expect(button).toHaveCSS('opacity','0.5');await button.screenshot({path:resolve(artifacts,'component-primary-disabled-dark.png')});await button.evaluate(e=>{e.disabled=false;e.removeAttribute('aria-busy')})
 await page.locator('.file').filter({hasText:'references.bib'}).click({button:'right'});await expect(page.locator('#tree-menu')).toBeVisible();await page.locator('#tree-menu').screenshot({path:resolve(artifacts,'component-file-menu-dark.png')});await page.locator('#tree-menu [data-action=delete]').click();await expect(page.locator('#action-dialog-confirm')).toHaveClass(/danger/);await page.locator('#action-dialog').screenshot({path:resolve(artifacts,'component-danger-dialog-dark.png')});await page.keyboard.press('Escape');await expect(page.locator('.file').filter({hasText:'references.bib'})).toBeVisible()
 for(const [trigger,dialog,name]of [['#collab-name','#name-dialog','profile'],['.theme-trigger','.theme-dialog','appearance']]){await page.locator(trigger).click();await expect(page.locator(dialog)).toBeVisible();await page.locator(dialog).screenshot({path:resolve(artifacts,`component-${name}-dark.png`)});await page.keyboard.press('Escape')}
 writeFileSync(resolve(artifacts,'workspace-measurements.json'),JSON.stringify(m,null,2))
})
