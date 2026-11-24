import {test,expect,namedContext} from './fixtures.js'
test.use({timezoneId:'America/Los_Angeles'})
async function openHub(page,now='2027-01-01T12:00:00+09:00'){
  await page.clock.setFixedTime(new Date(now))
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'alpha',display_name:'Alpha paper'}]}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[],metadata:[]}}))
  await page.goto('/hub.html?lang=ko');await expect(page.locator('#hub-calendar-month')).not.toBeEmpty()
}
const date=(page,key)=>page.locator(`[data-calendar-date="${key}"]`)
const overviewDate=(page,key)=>page.locator(`[data-overview-date="${key}"]`)

test('today and tomorrow get restrained extra emphasis while later deadlines stay quiet',async({page})=>{
  await openHub(page,'2027-01-11T12:00:00+09:00')
  const imminent=page.locator('.hub-upcoming-countdown').first()
  await expect(imminent).toHaveText('내일 마감');await expect(imminent).toHaveClass(/is-urgent/)
  await expect(imminent).toHaveCSS('font-size','10px');await expect(imminent).toHaveCSS('font-weight','650')
  await expect(page.locator('.hub-upcoming-countdown').nth(1)).not.toHaveClass(/is-urgent/)
  await page.clock.setFixedTime(new Date('2027-01-12T12:00:00+09:00'));await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(imminent).toHaveText('오늘 마감');await expect(imminent).toHaveClass(/is-urgent/)
  await page.clock.setFixedTime(new Date('2027-01-12T21:00:00+09:00'));await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(imminent).toHaveText('D-3');await expect(imminent).not.toHaveClass(/is-urgent/)
  await page.evaluate(()=>document.body.style.setProperty('--hub-sidebar-width','180px'))
  expect(await page.locator('.hub-topbar').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true)
})

test('mini calendar has one date Tab stop and keyboard navigation crosses months and years',async({page})=>{
  await openHub(page)
  await expect(page.locator('#hub-calendar-days button[tabindex="0"]')).toHaveCount(1)
  await date(page,'2027-01-01').focus();await page.keyboard.press('ArrowLeft')
  await expect(page.locator('#hub-calendar-month')).toHaveText('2026 12월');await expect(date(page,'2026-12-31')).toBeFocused()
  await page.keyboard.press('ArrowRight');await expect(date(page,'2027-01-01')).toBeFocused()
  await expect(page.locator('#hub-calendar-month')).toHaveText('2027 1월')
  await page.keyboard.press('ArrowDown');await expect(date(page,'2027-01-08')).toBeFocused()
  await page.keyboard.press('ArrowUp');await expect(date(page,'2027-01-01')).toBeFocused()
  for(let i=0;i<4;i++)await page.keyboard.press('ArrowRight')
  await expect(date(page,'2027-01-05')).toBeFocused();await page.keyboard.press('Enter')
  await expect(page.locator('#hub-deadline-popover')).toBeVisible();await expect(page.locator('#hub-deadline-details article')).toHaveCount(2)
  await page.keyboard.press('Escape');await expect(date(page,'2027-01-05')).toBeFocused()
  await page.evaluate(()=>dispatchEvent(new Event('focus')));await expect(date(page,'2027-01-05')).toBeFocused()
  await expect(page.locator('#hub-calendar-days button[tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter')
  await expect(page.locator('#hub-deadline-popover')).toBeHidden()
})

test('expanded calendar arrow navigation and Enter open details while keeping the panel across month rollover',async({page})=>{
  await openHub(page)
  await page.locator('#hub-calendar-expand').click()
  await expect(page.locator('#hub-overview-days .hub-overview-date[tabindex="0"]')).toHaveCount(1)
  await overviewDate(page,'2027-01-01').focus()
  for(let i=0;i<4;i++)await page.keyboard.press('ArrowRight')
  await expect(overviewDate(page,'2027-01-05')).toBeFocused();await page.keyboard.press('Enter')
  await expect(page.locator('#hub-overview-detail-panel')).toContainText('ACL 2027')
  await expect(overviewDate(page,'2027-01-05')).toBeFocused()
  await overviewDate(page,'2027-01-31').focus();await page.keyboard.press('ArrowRight')
  await expect(page.locator('#hub-overview-title')).toHaveText('2027 2월');await expect(overviewDate(page,'2027-02-01')).toBeFocused()
  await expect(page.locator('#hub-overview-detail-panel')).toContainText('ACL 2027')
  await page.keyboard.press('ArrowLeft');await expect(overviewDate(page,'2027-01-31')).toBeFocused()
  await page.keyboard.press('Escape');await expect(page.locator('#hub-calendar-expand')).toBeFocused()
})

for(const hasTouch of [false,true])test(`detail close buttons align with titles and retain hit targets (touch=${hasTouch})`,async({browser})=>{
  const context=await namedContext(browser,{viewport:{width:1440,height:900},hasTouch,timezoneId:'Asia/Seoul'})
  try{
    const page=await context.newPage();await openHub(page)
    await date(page,'2027-01-05').click()
    async function aligned(close,title){
      const button=await close.boundingBox(),heading=await title.boundingBox()
      expect(Math.abs(button.y+button.height/2-heading.y-heading.height/2)).toBeLessThan(1)
      expect(button.width).toBeGreaterThanOrEqual(hasTouch?44:28);expect(button.height).toBeGreaterThanOrEqual(hasTouch?44:28)
    }
    await aligned(page.locator('#hub-deadline-close'),page.locator('#hub-deadline-details .hub-deadline-name strong').first())
    await page.locator('#hub-calendar-expand').click();await page.locator('[data-overview-event="icml-abstract"]').click()
    await aligned(page.locator('#hub-overview-detail-close'),page.locator('#hub-overview-details .hub-deadline-name strong').first())
  }finally{await context.close()}
})
