import {test,expect} from './fixtures.js'
import {selectControl} from './controls.js'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'

const root=resolve(import.meta.dirname,'../../../..')
const pages=JSON.parse(execFileSync('python3',[resolve(root,'scripts/paper_platform/render_auth_fixtures.py')],{maxBuffer:8*1024*1024}))

for(const theme of ['light','dark'])for(const surface of ['login','hub','workspace','review'])test(`Folio mark follows ${theme} theme on ${surface}`,async({page})=>{
  await page.setViewportSize({width:1600,height:900})
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  if(surface==='login') {
    await page.route('**/_auth/login**',route=>route.fulfill({contentType:'text/html',body:pages['shared-en-']}))
    await page.goto('/_auth/login?lang=en')
  } else if(surface==='hub')await page.goto('/hub.html?lang=en')
  else if(surface==='review')await page.goto('/p/example-paper/rebuttal?lang=en')
  else {await page.goto('/p/example-paper?lang=en');await page.waitForFunction(()=>workspaceReadyForCompile)}
  const mark=page.locator('.brand-symbol')
  const visible=mark.locator(`.brand-mark-${theme}`)
  const hidden=mark.locator(`.brand-mark-${theme==='light'?'dark':'light'}`)
  await expect(visible).toBeVisible()
  await expect(hidden).toBeHidden()
  await expect.poll(()=>visible.evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true)
  if(surface==='login') {
    expect(await visible.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
  } else {
    const source=new URL(await visible.getAttribute('src'),page.url())
    expect(source.pathname).toBe(`/assets/paper-folio-${theme}.svg`)
    expect(source.searchParams.get('v')).toMatch(/^[a-f0-9]{16}$/)
  }
  await page.setViewportSize({width:320,height:900})
  await expect(visible).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(320)
})

test('favicon and installed-app icons resolve in the local runtime',async({page,request})=>{
  for(const path of ['/hub.html?lang=en','/p/example-paper?lang=en','/p/example-paper/rebuttal?lang=en']) {
    await page.goto(path)
    const icons=await page.locator('link[rel=icon]').evaluateAll(links=>links.map(link=>link.href))
    expect(icons.some(href=>href.startsWith('data:image/png;base64,')&&!href.includes('__FAVICON_DATA__'))).toBe(true)
    const manifestLink=await page.locator('link[rel=manifest]').getAttribute('href')
    const response=await request.get(manifestLink)
    expect(response.ok()).toBe(true)
    const manifest=await response.json()
    for(const icon of manifest.icons)expect((await request.get(icon.src)).ok()).toBe(true)
  }
})

test('manual theme changes switch the actual workspace mark',async({page})=>{
  await page.setViewportSize({width:1600,height:900})
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-theme','light'))
  await page.goto('/p/example-paper?lang=en')
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await page.locator('.theme-trigger').click()
  await selectControl(page.locator('select[name=workspace-theme]'),'dark')
  await expect(page.locator('.brand-mark-dark')).toBeVisible()
  await expect(page.locator('.brand-mark-light')).toBeHidden()
  await selectControl(page.locator('select[name=workspace-theme]'),'light')
  await expect(page.locator('.brand-mark-light')).toBeVisible()
  await expect(page.locator('.brand-mark-dark')).toBeHidden()
})
