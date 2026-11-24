import {expect,test} from './fixtures.js'

test('writing tabs remain above the editor on desktop and mobile',async({page})=>{
  await page.goto('/?lang=ko')
  await expect(page.locator('#open-rebuttal')).toHaveText('Rebuttal')
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900})
    const tabs=await page.locator('.project-workspace-nav').boundingBox()
    const editor=await page.locator('#editor-panel').boundingBox()
    expect(tabs.x).toBeGreaterThanOrEqual(0)
    expect(tabs.x+tabs.width).toBeLessThanOrEqual(width)
    expect(tabs.y+tabs.height).toBeLessThanOrEqual(editor.y+1)
    await expect(page.locator('#open-rebuttal')).toBeVisible()
    if(width<768)for(const link of await page.locator('.project-workspace-nav a').all())expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44)
    await page.screenshot({path:`/tmp/paper-navigation-${width}.png`})
  }
})

test('hub keeps project links without workspace shortcut buttons',async({page})=>{
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'example',display_name:'Example'}]}}))
  await page.goto('/hub.html?lang=ko')
  await expect(page.locator('.project-open').first()).toHaveAttribute('href','/p/example')
  await expect(page.locator('.project-workspace-actions')).toHaveCount(0)
  await expect(page.locator('a[href="/p/example/rebuttal"]')).toHaveCount(0)
})

test('returning to writing restores the cursor in the selected file',async({page})=>{
  await page.route('**/api/rebuttal/projects/default/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.goto('/?lang=ko')
  await page.waitForFunction(()=>typeof workspaceReadyForCompile!=='undefined'&&workspaceReadyForCompile)
  const saved=await page.evaluate(()=>{const end=Math.min(24,editorValue().length);setEditorSelection(end,end);return {file:state.current,end}})
  await page.locator('#open-rebuttal').click()
  const iframe=page.locator('iframe.paper-review-frame'),review=page.frameLocator('iframe.paper-review-frame')
  await expect(iframe).toHaveClass(/is-active/)
  await expect(review.locator('#manuscript-link')).toHaveAttribute('href','/p/default?lang=ko')
  await expect(review.locator('html')).toHaveAttribute('lang','ko')
  await expect(review.locator('#manuscript-link')).toHaveText('Paper')
  await review.locator('#manuscript-link').click()
  await expect(iframe).not.toHaveClass(/is-active/)
  await page.waitForFunction(()=>typeof workspaceReadyForCompile!=='undefined'&&workspaceReadyForCompile)
  await expect(page.locator('html')).toHaveAttribute('lang','ko')
  expect(await page.evaluate(()=>({file:state.current,end:editorSelection().end}))).toEqual(saved)
  await page.locator('#open-rebuttal').click()
  await expect(iframe).toHaveClass(/is-active/)
  await expect(review.locator('#screen-nav button')).toHaveCount(3)
  await review.locator('#workspace-language').selectOption('en')
  await review.locator('#manuscript-link').click()
  await expect(page.locator('html')).toHaveAttribute('lang','en')
  await expect(page.locator('#open-rebuttal')).toHaveText('Rebuttal')
})


test.describe('touch tablet project navigation',()=>{
  test.use({hasTouch:true,viewport:{width:1024,height:900}})
  test('touch links stay inside their header row',async({page})=>{
    await page.goto('/?lang=en')
    expect(await page.evaluate(()=>matchMedia('(pointer:coarse)').matches)).toBe(true)
    const nav=await page.locator('.project-workspace-nav').boundingBox()
    for(const link of await page.locator('.project-workspace-nav a').all()){
      const box=await link.boundingBox()
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.y).toBeGreaterThanOrEqual(nav.y)
      expect(box.y+box.height).toBeLessThanOrEqual(nav.y+nav.height)
    }
    const editor=await page.locator('#editor-panel').boundingBox()
    expect(nav.y+nav.height).toBeLessThanOrEqual(editor.y+1)
  })
})



for(const theme of ['light','dark'])test(`desktop frame follows the file rail ${theme}`,async({page})=>{
  await page.setViewportSize({width:1600,height:1000})
  await page.addInitScript(theme=>{
    localStorage.setItem('paper-workspace-theme',theme)
    localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarWidth:260}))
  },theme)
  await page.goto('/?lang=en')
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await page.emulateMedia({reducedMotion:'reduce'})
  for(const collapsed of [false,true]){
    if(collapsed)await page.locator('#toggle-sidebar').click()
    const [nav,editor,rail]=await Promise.all(['.project-workspace-nav','#editor-panel','.sidebar'].map(selector=>page.locator(selector).boundingBox()))
    expect(nav.x).toBeGreaterThanOrEqual(editor.x)
    expect(rail.y).toBe(52)
    const surface=await page.locator('.topbar').evaluate(e=>({left:parseFloat(getComputedStyle(e,'::before').left),top:parseFloat(getComputedStyle(e,'::before').top)}))
    expect(surface.left).toBe(rail.width)
    expect(surface.top).toBe(8)
    const frame = await page.locator('.topbar').evaluate(e => {
      const title = e.querySelector('.project-frame-title').getBoundingClientRect()
      return {radius:getComputedStyle(e,'::before').borderTopLeftRadius,titleCenter:title.y+title.height/2}
    })
    expect(frame.radius).toBe('12px')
    expect(frame.titleCenter).toBe(30)
    if(!collapsed) {
      await expect(page.locator('.quick-nav-link').first()).toHaveCSS('height','28px')
      await expect(page.locator('.file.active')).toHaveCSS('height','28px')
    }
    await expect(page.locator('#open-rebuttal')).toBeVisible()
    const link=await page.locator('#open-rebuttal').boundingBox()
    expect(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('a')?.id,{x:link.x+link.width/2,y:link.y+link.height/2})).toBe('open-rebuttal')
    await page.screenshot({path:`/tmp/paper-frame-${theme}-${collapsed?'collapsed':'expanded'}.png`,animations:'disabled'})
  }
})
