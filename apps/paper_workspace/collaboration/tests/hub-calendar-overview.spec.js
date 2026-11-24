import {test,expect} from './fixtures.js'
test.use({timezoneId:'America/Los_Angeles'})
async function openHub(page,language='ko'){
  await page.clock.setFixedTime(new Date('2027-01-01T12:00:00+09:00'))
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'alpha',display_name:'Alpha paper'}]}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[],metadata:[]}}))
  await page.goto(`/hub.html?lang=${language}`)
  await expect(page.locator('#hub-calendar-month')).not.toBeEmpty()
  await page.locator('#hub-calendar-expand').click()
  await expect(page.locator('#hub-calendar-overview')).toBeVisible()
  await page.locator('#hub-calendar-overview').evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)))
}
const overview=page=>page.locator('#hub-calendar-overview')
const event=(page,id)=>page.locator(`#hub-overview-days [data-overview-event="${id}"]`)
async function settlePanel(page){
  await page.locator('#hub-overview-detail-panel').evaluate(node=>Promise.all([node,...node.querySelectorAll('*')].flatMap(element=>element.getAnimations()).map(animation=>animation.finished.catch(()=>{}))))
}


test('month cells show all conference names and submission stages at their KST dates',async({page})=>{
  await openHub(page)
  await expect(page.locator('#hub-overview-title')).toHaveText('2027 1월')
  await expect(page.locator('#hub-overview-days td')).toHaveCount(42)
  await expect(page.locator('.hub-overview-event')).toHaveCount(8)
  const cell=page.locator('#hub-overview-days td').filter({has:page.locator('[data-overview-date="2027-01-05"]')})
  await expect(cell).toContainText('ACLFull paper');await expect(cell).toContainText('IJCAIAbstract')
  for(const id of ['icml-abstract','sigir-abstract','icml-full','sigir-full','colt-full'])await expect(event(page,id)).toBeVisible()
  await expect(overview(page)).not.toContainText('A*')
  await expect(page.locator('#hub-overview-detail-panel')).toBeHidden()
})
test('conference details share the existing facts and occupy a separate side panel',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await openHub(page)
  await event(page,'icml-abstract').click();await settlePanel(page)
  const panel=page.locator('#hub-overview-detail-panel')
  await expect(panel).toContainText('ICML 2027');await expect(panel).toContainText('Riocentro')
  await expect(panel.locator('.hub-deadline-stage')).toHaveCount(2)
  await expect(panel.getByRole('link',{name:'공식 일정 ↗'})).toHaveAttribute('href','https://icml.cc/Conferences/2027/Dates')
  const month=await page.locator('.hub-overview-month').boundingBox(),detail=await panel.boundingBox()
  expect(detail.x).toBeGreaterThanOrEqual(month.x+month.width-.1)
  await expect(page.locator('#hub-deadline-popover')).toBeHidden()
  await page.locator('#hub-overview-detail-close').click();await expect(panel).toBeHidden()
  await expect(event(page,'icml-abstract')).toBeFocused()
  await event(page,'sigir-abstract').click();await expect(panel).toContainText('SIGIR 2027');await expect(panel).not.toContainText('ICML 2027')
})
test('month navigation, Today, empty dates and closing retain mini calendar context',async({page})=>{
  await openHub(page)
  await overview(page).getByRole('button',{name:'지난달',exact:true}).click()
  await expect(page.locator('#hub-overview-title')).toHaveText('2026 12월')
  await expect(event(page,'icaps-abstract')).toBeVisible();await expect(event(page,'naacl-commitment')).toContainText('Commitment')
  await page.locator('[data-overview-date="2026-12-10"]').click()
  await expect(page.locator('#hub-overview-detail-panel')).toBeHidden()
  await expect(page.locator('[data-overview-date="2026-12-10"]')).toHaveAttribute('aria-pressed','true')
  await page.keyboard.press('Escape');await expect(overview(page)).toBeHidden()
  await expect(page.locator('#hub-calendar-expand')).toBeFocused()
  await expect(page.locator('#hub-calendar-month')).toHaveText('2026 12월')
  await page.locator('#hub-calendar-expand').click();await page.locator('#hub-overview-today').click()
  await expect(page.locator('#hub-overview-title')).toHaveText('2027 1월')
  await expect(page.locator('#hub-overview-days [aria-current="date"]')).toHaveAttribute('datetime','2027-01-01')
  await page.locator('#hub-overview-close').click();await expect(overview(page)).toBeHidden()
})
test('keyboard selection and language/background updates preserve month, details and focus',async({page})=>{
  await openHub(page)
  await event(page,'icml-abstract').focus();await page.keyboard.press('Enter')
  await expect(event(page,'icml-abstract')).toBeFocused()
  await page.evaluate(()=>{const select=document.querySelector('#hub-language');select.value='en';select.dispatchEvent(new Event('change',{bubbles:true}))})
  await expect(page.locator('#hub-overview-title')).toHaveText('Jan 2027')
  await expect(page.locator('#hub-overview-detail-panel')).toContainText('Machine learning')
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(event(page,'icml-abstract')).toBeFocused()
  await page.keyboard.press('Escape');await expect(overview(page)).toBeHidden()
})
for(const theme of ['light','dark'])test(`overview fits full and narrow desktop screens in ${theme}`,async({page})=>{
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await openHub(page,'en')
  for(const width of [1440,1024,768]){
    await page.setViewportSize({width,height:800})
    const box=await overview(page).boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(15.9);expect(box.x+box.width).toBeLessThanOrEqual(width-15.9)
    expect(box.y).toBeGreaterThanOrEqual(23.9);expect(box.y+box.height).toBeLessThanOrEqual(776.1)
    expect(await overview(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true)
    await event(page,'icml-abstract').click();await expect(page.locator('#hub-overview-detail-panel')).toBeVisible()
    expect(await overview(page).evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true)
    await page.locator('#hub-overview-detail-close').click()
  }
  await page.setViewportSize({width:1440,height:900})
  await page.screenshot({path:test.info().outputPath(`calendar-overview-${theme}.png`)})
})


test('month changes and Today retain the selected conference and detail DOM',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await openHub(page)
  await event(page,'icml-abstract').click();await settlePanel(page)
  const panel=page.locator('#hub-overview-detail-panel')
  await panel.locator('article').evaluate(node=>node.dataset.retained='yes')
  for(const id of ['hub-overview-previous','hub-overview-next','hub-overview-next','hub-overview-today']){
    await page.locator('#'+id).click()
    await expect(panel).toBeVisible();await expect(panel).toContainText('ICML 2027')
    await expect(panel.locator('article')).toHaveAttribute('data-retained','yes')
    await expect(panel).toHaveClass(/is-open/)
  }
  await page.locator('#hub-overview-previous').click()
  await page.locator('#hub-overview-detail-close').click()
  await expect(panel).toBeHidden();await expect(page.locator('#hub-overview-today')).toBeFocused()
})

test('panel opens with reversible live-content motion and only the active conference is filled',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await openHub(page)
  const motion=await page.evaluate(()=>{
    document.querySelector('[data-overview-event="icml-abstract"]').click()
    const panel=document.querySelector('#hub-overview-detail-panel')
    panel.getBoundingClientRect()
    return {durations:panel.getAnimations().map(animation=>animation.effect.getTiming().duration),opacity:getComputedStyle(panel.querySelector('.hub-overview-detail-content')).opacity}
  })
  expect(motion.durations).toContain(220);expect(motion.opacity).toBe('1')
  // Interrupt both directions without allowing an old completion to hide a reopened panel.
  await page.evaluate(async()=>{
    await new Promise(requestAnimationFrame)
    document.querySelector('#hub-overview-detail-close').click()
    await new Promise(requestAnimationFrame)
    document.querySelector('[data-overview-event="sigir-abstract"]').click()
  })
  await settlePanel(page)
  const panel=page.locator('#hub-overview-detail-panel')
  await expect(panel).toBeVisible();await expect(panel).toContainText('SIGIR 2027')
  await expect(panel).toHaveAttribute('aria-hidden','false')
  expect(await panel.evaluate(node=>node.inert)).toBe(false)
  const colors=await page.evaluate(()=>({
    idle:getComputedStyle(document.querySelector('[data-overview-event="icml-abstract"]')).backgroundColor,
    active:getComputedStyle(document.querySelector('[data-overview-event="sigir-abstract"]')).backgroundColor
  }))
  expect(colors.idle).toBe('rgba(0, 0, 0, 0)');expect(colors.active).not.toBe('rgba(0, 0, 0, 0)')
  await event(page,'icml-abstract').hover()
  expect(await event(page,'icml-abstract').evaluate(node=>getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
})

test('reduced motion skips the panel transition',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'})
  await openHub(page)
  await event(page,'icml-abstract').click()
  const panel=page.locator('#hub-overview-detail-panel')
  await expect(panel).toBeVisible()
  expect(await panel.evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s')
  await page.locator('#hub-overview-detail-close').click();await expect(panel).toBeHidden()
})
