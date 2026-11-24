// Read the real rendered controls. Reference RGB sampling is kept separate in Python.
import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
const out=new URL('../../.omx/artifacts/linear-refresh/precision/',import.meta.url)
mkdirSync(out,{recursive:true})
const base=process.env.PAPER_E2E_URL||'http://127.0.0.1:18440'
const browser=await chromium.launch()
const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'})
await page.addInitScript(()=>{localStorage.setItem('paper-workspace-theme','dark');localStorage.setItem('collab-name','Test Author');localStorage.setItem('collab-name-user-set','1')})
await page.goto(`${base}/p/precision-metrics-${Date.now()}?lang=en`)
await page.waitForFunction(()=>workspaceReadyForCompile)
await page.evaluate(()=>document.fonts.ready)
const values={}
async function measure(key,selector,property,pseudo=null){
 values[key]=await page.locator(selector).first().evaluate((e,{property,pseudo})=>{const s=getComputedStyle(e,pseudo),r=e.getBoundingClientRect();return{value:s[property],x:r.x,y:r.y,width:r.width,height:r.height,radius:s.borderRadius,font:s.font,pseudo,cssWidth:s.width,cssHeight:s.height}},{property,pseudo})
}
for(const [key,selector,property]of[
 ['nav-background','.sidebar','backgroundColor'],['work-surface','.panel-header','backgroundColor'],
 ['nav-selected','.quick-nav-link[aria-current=page]','backgroundColor'],['nav-selected-text','.quick-nav-link[aria-current=page]','color'],
 ['nav-muted','.quick-nav-link:not([aria-current=page])','color'],
 ['tab-selected','.project-workspace-nav [aria-current=page]','backgroundColor'],['tab-selected-text','.project-workspace-nav [aria-current=page]','color'],
 ['tab-idle','.project-workspace-nav a:not([aria-current])','backgroundColor'],
 ['primary-fill','#ask','backgroundColor'],['primary-border','#ask','borderTopColor']])await measure(key,selector,property)
await page.locator('.project-workspace-nav [aria-current]').screenshot({path:new URL('tab-native.png',out).pathname})
await page.locator('#ask').screenshot({path:new URL('primary-native.png',out).pathname})
await page.locator('.file').filter({hasText:'references.bib'}).click({button:'right'})
await measure('overlay-fill','#tree-menu','backgroundColor');await measure('overlay-border','#tree-menu','borderTopColor')
await page.locator('#tree-menu').screenshot({path:new URL('menu-native.png',out).pathname})
await page.locator('#tree-menu [data-action=delete]').click()
await measure('dialog-title','#action-dialog-title','color')
await page.locator('#action-dialog').screenshot({path:new URL('delete-native.png',out).pathname})
await page.keyboard.press('Escape')
const spec=readFileSync(new URL('../../apps/paper_workspace/collaboration/tests/rebuttal.spec.js',import.meta.url),'utf8')
const seed=Function(spec.slice(spec.indexOf('const fresh'),spec.indexOf('async function api'))+';return seeded')()
await page.route('**/api/rebuttal/projects/**',r=>r.fulfill({json:seed()}))
await page.goto(`${base}/p/precision-metrics-review/rebuttal?round=r1&lang=en#overview`)
await page.locator('[data-action=rules]').click()
await measure('select-fill','[name=layout]','backgroundColor');await measure('select-border','[name=layout]','borderTopColor');await measure('select-text','[name=layout]','color')
await measure('secondary-text','#dialog-cancel','color')
await measure('switch-on','[name=allow_common]','backgroundColor')
await measure('switch-thumb','[name=allow_common]','backgroundColor','::before')
await measure('switch-caption','label.switch-label','color')
await page.locator('[name=allow_common]').screenshot({path:new URL('switch-on-native.png',out).pathname})
await page.locator('[name=allow_common]').uncheck()
await measure('switch-off','[name=allow_common]','backgroundColor')
await page.locator('[name=allow_common]').screenshot({path:new URL('switch-off-native.png',out).pathname})
await page.locator('[name=layout]').screenshot({path:new URL('select-native.png',out).pathname})
writeFileSync(new URL('rendered-metrics.json',out),JSON.stringify({viewport:{width:1600,height:1000,dpr:1,zoom:'100%',fontLoading:await page.evaluate(()=>document.fonts.status)},values},null,2))
await browser.close()
console.log(`${Object.keys(values).length} actual DOM style samples saved`)
