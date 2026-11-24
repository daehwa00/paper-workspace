import {test,expect} from './fixtures.js'
async function openReview(page){
  const round={id:'r1',title:'Advanced fixture',reviewers:[{id:'a',name:'Reviewer A'}],reviews:[{id:'review',reviewer_id:'a',fields:{review:'Please clarify.'},translations:{}}],documents:[{id:'answer',title:'Response',kind:'reviewer',reviewer_id:'a',text_key:'response:answer',seed_text:'An unchanged draft.'}],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}
  await page.route('**/api/rebuttal/projects/**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/versions')?{versions:[]}:{revision:0,enabled:true,jobs:[],rounds:[round]}}))
  await page.goto(`/p/advanced-motion-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await expect(page.locator('#response-editor .cm-content')).toContainText('An unchanged draft.')
}
const menu=page=>page.locator('#screen-nav .sidebar-advanced')
const summary=page=>menu(page).locator(':scope > summary')
async function finishMotion(page){
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.id==='rebuttal-sidebar-advanced-motion').map(animation=>animation.finished.catch(()=>{}))))
}
for(const theme of ['light','dark'])test(`Advanced opens and closes with live content and a rotating arrow in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1440,height:900})
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await openReview(page)
  await expect(menu(page)).not.toHaveAttribute('open','')
  const before=await page.locator('.project-frame-main').boundingBox()
  const motion=await summary(page).evaluate(node=>{
    node.click()
    const animation=document.getAnimations().find(animation=>animation.id==='rebuttal-sidebar-advanced-motion')
    return {duration:animation?.effect.getTiming().duration,frames:animation?.effect.getKeyframes(),opacity:getComputedStyle(node.parentElement).opacity}
  })
  expect(motion.duration).toBe(220);expect(motion.frames[0].height).not.toBe(motion.frames.at(-1).height);expect(motion.opacity).toBe('1')
  await finishMotion(page)
  await expect(summary(page)).toHaveAttribute('aria-expanded','true')
  await expect(menu(page).getByRole('button',{name:'Submission',exact:true})).toBeVisible()
  await expect(menu(page).locator('.sidebar-advanced-chevron')).toHaveCSS('transform','matrix(0, 1, -1, 0, 0, 0)')
  await summary(page).click();await expect(summary(page)).toHaveAttribute('aria-expanded','false')
  expect(await menu(page).locator('button').evaluateAll(nodes=>nodes.every(node=>node.inert))).toBe(true)
  await finishMotion(page);await expect(menu(page)).not.toHaveAttribute('open','')
  const after=await page.locator('.project-frame-main').boundingBox()
  expect(after.width).toBe(before.width)
  await expect(page.locator('#response-editor .cm-content')).toContainText('An unchanged draft.')
})
test('reverses an interrupted closing without a jump or stale completion',async({page})=>{
  await openReview(page);await summary(page).click();await finishMotion(page)
  const state=await summary(page).evaluate(node=>{
    node.click()
    const animation=document.getAnimations().find(animation=>animation.id==='rebuttal-sidebar-advanced-motion')
    animation.pause();animation.currentTime=90
    const before=node.parentElement.getBoundingClientRect().height
    node.click()
    return {before,after:node.parentElement.getBoundingClientRect().height}
  })
  expect(Math.abs(state.before-state.after)).toBeLessThan(1)
  await finishMotion(page)
  await expect(summary(page)).toHaveAttribute('aria-expanded','true');await expect(menu(page)).toHaveAttribute('open','')
  expect(await page.evaluate(()=>document.getAnimations().filter(animation=>animation.id==='rebuttal-sidebar-advanced-motion').length)).toBe(0)
})
test('refresh during opening retains the target state and cancels detached animations',async({page})=>{
  await openReview(page)
  await summary(page).evaluate(node=>{
    node.click()
    const animation=document.getAnimations().find(animation=>animation.id==='rebuttal-sidebar-advanced-motion');animation.pause();animation.currentTime=70
  })
  await page.evaluate(()=>window.PaperRebuttal.refresh())
  await expect(summary(page)).toHaveAttribute('aria-expanded','true');await expect(menu(page)).toHaveAttribute('open','')
  expect(await page.evaluate(()=>document.getAnimations().filter(animation=>animation.id==='rebuttal-sidebar-advanced-motion').length)).toBe(0)
})
test('native keyboard activation works and reduced motion skips the animation',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await openReview(page)
  await summary(page).focus();await page.keyboard.press('Enter')
  await expect(summary(page)).toHaveAttribute('aria-expanded','true')
  expect(await page.evaluate(()=>document.getAnimations().some(animation=>animation.id==='rebuttal-sidebar-advanced-motion'))).toBe(false)
  await page.keyboard.press('Space');await expect(summary(page)).toHaveAttribute('aria-expanded','false')
  await expect(menu(page)).not.toHaveAttribute('open','')
})
test('narrow layout keeps all Advanced navigation actions usable',async({page})=>{
  await page.setViewportSize({width:390,height:844});await openReview(page)
  await summary(page).click();await finishMotion(page)
  for(const button of await menu(page).locator('button').all()){
    await expect(button).toBeVisible()
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44)
  }
  await menu(page).getByRole('button',{name:'Submission',exact:true}).click()
  await expect(page.locator('#review-view-title')).toHaveText('Submission')
})
