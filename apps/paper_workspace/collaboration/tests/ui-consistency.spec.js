import {test,expect,namedContext} from './fixtures.js'
const state={schema_version:1,revision:0,enabled:true,jobs:[],rounds:[{id:'r1',title:'Review fixture',reviewers:[{id:'a',name:'Reviewer A'}],reviews:[{id:'v',reviewer_id:'a',fields:{summary:'Please clarify the comparison.'},translations:{}}],documents:[{id:'answer',title:'Response',kind:'reviewer',reviewer_id:'a',text_key:'response:answer',seed_text:'A draft response with supporting evidence.'}],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}]}
async function setup(context,theme){
  await context.addInitScript(theme=>{localStorage.setItem('paper-workspace-theme',theme);localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarWidth:244,sidebarCollapsed:false,assistantCollapsed:true}))},theme)
  await context.route('**/api/rebuttal/projects/**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/versions')?{versions:[]}:state}))
  await context.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'alpha',display_name:'A research manuscript',description:'Supporting experiments and analysis.'}]}}))
  await context.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[],metadata:[]}}))
}
async function paper(page){await page.goto('/p/ui-consistency?lang=ko');await page.waitForFunction(()=>workspaceReadyForCompile)}
async function review(page){await page.goto('/p/ui-consistency/rebuttal?standalone=1&round=r1&lang=ko#reviews');await page.locator('#response-editor .cm-content').waitFor();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)}
async function footer(page){return page.locator('.editor-footer').evaluate(node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return {height:r.height,font:s.fontSize,line:s.lineHeight,padding:s.padding,color:s.color,background:s.backgroundColor,border:s.borderTopColor,align:s.alignItems}})}

for(const theme of ['light','dark'])test(`shared headings and footers retain hierarchy and match across screens in ${theme}`,async({page,context})=>{
  await setup(context,theme)
  for(const width of [1440,1024,390,320]){
    await page.setViewportSize({width,height:900})
    await page.goto('/hub.html?lang=ko');await expect(page.locator('#hub-calendar-month')).not.toBeEmpty()
    await expect(page.locator('.hub-page-header h2')).toHaveCSS('font-size','13px')
    const hubHeading=await page.locator('.hub-page-header h2').boundingBox()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
    await paper(page)
    const writing=await footer(page),title=await page.locator('.project-frame-title').boundingBox()
    if(width>=768)expect(Math.abs(hubHeading.y+hubHeading.height/2-title.y-title.height/2)).toBeLessThanOrEqual(1)
    await expect(page.locator('.project-frame-title')).toHaveCSS('font-size','13px')
    await expect(page.locator('#word-count')).toContainText('단어')
    await review(page)
    expect(await footer(page)).toEqual(writing)
    expect(writing.height).toBe(32);expect(writing.font).toBe('12px');expect(writing.align).toBe('center')
    await expect(page.locator('#response-count')).toHaveText(/^\d+자$/)
    await expect(page.locator('.editor-footer')).not.toContainText('자동 저장')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
  }
})

for(const theme of ['light','dark'])test(`touch mode links and review controls retain 44px targets in ${theme}`,async({browser})=>{
  const context=await namedContext(browser,{viewport:{width:1024,height:900},hasTouch:true,reducedMotion:'reduce'})
  try{
    await setup(context,theme);const page=await context.newPage()
    for(const width of [1024,390,320]){
      await page.setViewportSize({width,height:900})
      for(const surface of ['paper','review']){
        if(surface==='paper')await paper(page);else await review(page)
        const nav=await page.locator('.project-workspace-nav').boundingBox()
        for(const link of await page.locator('.project-workspace-nav a').all()){
          const box=await link.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44)
          expect(box.y).toBeGreaterThanOrEqual(nav.y-.1);expect(box.y+box.height).toBeLessThanOrEqual(nav.y+nav.height+.1)
        }
      }
      for(const button of await page.locator('.review-language-switch button,.response-preview-toggle,#response-memos-toggle').all()){
        const box=await button.boundingBox();expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44)
      }
      await page.locator('#response-memos-toggle').click();await expect(page.locator('#response-memos-panel')).toBeVisible()
      const close=await page.locator('.response-memos-close').boundingBox();expect(close.width).toBeGreaterThanOrEqual(44);expect(close.height).toBeGreaterThanOrEqual(44)
      await page.locator('.response-memos-close').click();await expect(page.locator('#response-memos-panel')).toBeHidden()
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
    }
  }finally{await context.close()}
})

for(const theme of ['light','dark'])test(`quiet hover, active state and faint text contrast are consistent in ${theme}`,async({page,context})=>{
  await setup(context,theme);await page.setViewportSize({width:1440,height:900});await review(page)
  const colors=await page.evaluate(()=>{
    const probe=document.createElement('i');document.body.append(probe)
    const resolve=name=>{probe.style.color=`var(${name})`;return getComputedStyle(probe).color}
    const result={hover:resolve('--theme-hover'),selected:resolve('--theme-selected'),faint:resolve('--theme-text-faint'),background:resolve('--theme-bg')};probe.remove();return result
  })
  for(const selector of ['.review-language-switch button[aria-pressed="false"]','.response-preview-toggle','#response-memos-toggle']){
    const button=page.locator(selector).first();await button.hover();await expect(button).toHaveCSS('background-color',colors.hover)
  }
  await page.locator('.response-preview-toggle').click();await expect(page.locator('.response-preview-toggle')).toHaveCSS('background-color',colors.selected)
  await page.locator('.response-preview-toggle').click()
  await page.locator('#response-memos-toggle').click();await expect(page.locator('#response-memos-toggle')).toHaveCSS('background-color',colors.selected)
  await page.locator('.response-memos-close').click()
  await page.locator('.response-preview-toggle').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab')
  await expect(page.locator('.response-preview-toggle')).toHaveCSS('outline-style','solid')
  const luminance=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{const c=v/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0)
  const foreground=luminance(colors.faint),background=luminance(colors.background)
  expect((Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)).toBeGreaterThanOrEqual(4.5)
})
