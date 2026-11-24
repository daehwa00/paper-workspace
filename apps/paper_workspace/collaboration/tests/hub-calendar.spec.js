import {test,expect,namedContext} from './fixtures.js'
import {selectControl} from './controls.js'

test.use({timezoneId:'Asia/Seoul'})
const today='2026-11-12'
async function openHub(page,{language='ko',projects='available'}={}){
  await page.clock.setFixedTime(new Date(`${today}T12:00:00+09:00`))
  await page.route('**/projects/index.json',route=>route.fulfill({status:projects==='error'?503:200,json:{projects:projects==='available'?[
    {slug:'alpha',display_name:'Alpha paper',description:'A research manuscript.'},
    {slug:'beta',display_name:'Beta paper',description:'Another research manuscript.'}
  ]:[]}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[],metadata:[]}}))
  await page.goto(`/hub.html?lang=${language}`)
  await expect(page.locator('#hub-calendar-month')).not.toBeEmpty()
}

test('calendar replaces duplicate project navigation and marks the local today',async({page})=>{
  await openHub(page)
  await expect(page.locator('.hub-calendar')).toBeVisible()
  await expect(page.locator('.hub-topbar a[href^="/p/"]')).toHaveCount(0)
  await expect(page.locator('.hub-nav,#hub-project-shortcuts')).toHaveCount(0)
  await expect(page.locator('.project-card')).toHaveCount(2)
  await expect(page.locator('#hub-calendar-month')).toHaveText('2026 11월')
  await expect(page.locator('#hub-calendar-weekdays th')).toHaveText(['일','월','화','수','목','금','토'])
  await expect(page.locator('#hub-calendar-days tr')).toHaveCount(6)
  await expect(page.locator('#hub-calendar-days time')).toHaveCount(42)
  await expect(page.locator('.hub-calendar [aria-current="date"]')).toHaveAttribute('datetime',today)
  await page.clock.setFixedTime(new Date('2026-11-13T00:01:00+09:00'))
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(page.locator('.hub-calendar [aria-current="date"]')).toHaveAttribute('datetime','2026-11-13')
})

test('January reference has the correct adjacent dates and keyboard month controls',async({page})=>{
  await openHub(page)
  const next=page.getByRole('button',{name:'다음달',exact:true})
  await next.click();await next.click()
  await expect(page.locator('#hub-calendar-month')).toHaveText('2027 1월')
  await expect(page.locator('#hub-calendar-days time').first()).toHaveAttribute('datetime','2026-12-27')
  await expect(page.locator('#hub-calendar-days time').last()).toHaveAttribute('datetime','2027-02-06')
  await expect(page.locator('#hub-calendar-days tr').first().locator('td').nth(5).locator('time')).toHaveText('1')
  await expect(page.locator('td:has(time[datetime="2026-12-27"])')).toHaveClass('is-outside')
  await page.getByRole('button',{name:'지난달',exact:true}).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#hub-calendar-month')).toHaveText('2026 12월')
  await next.focus();await page.keyboard.press('Space')
  await expect(page.locator('#hub-calendar-month')).toHaveText('2027 1월')
  const reset=page.getByRole('button',{name:'오늘로 이동',exact:true})
  await reset.focus();await page.keyboard.press('Enter')
  await expect(page.locator('#hub-calendar-month')).toHaveText('2026 11월')
  await expect(reset).toBeFocused()
  await expect(page.locator('.hub-calendar [aria-current="date"]')).toHaveAttribute('datetime',today)
})

test('month arithmetic handles leap years without skipping the first day',async({page})=>{
  await openHub(page)
  for(let index=0;index<15;index++)await page.locator('#hub-calendar-next').click()
  await expect(page.locator('#hub-calendar-month')).toHaveText('2028 2월')
  await expect(page.locator('time[datetime^="2028-02-"]')).toHaveCount(29)
  await expect(page.locator('time[datetime="2028-02-29"]')).toHaveText('29')
  await expect(page.locator('#hub-calendar-days time').first()).toHaveAttribute('datetime','2028-01-30')
  await expect(page.locator('#hub-calendar-days time').last()).toHaveAttribute('datetime','2028-03-11')
  await page.locator('#hub-calendar-next').click()
  await expect(page.locator('#hub-calendar-month')).toHaveText('2028 3월')
  await expect(page.locator('time[datetime^="2028-03-"]')).toHaveCount(31)
})

test('language changes, sorting and background refresh preserve the viewed month',async({page})=>{
  await openHub(page)
  await page.locator('#hub-calendar-next').click();await page.locator('#hub-calendar-next').click()
  await page.locator('#hub-language').selectOption('en')
  await expect(page.locator('#hub-calendar-month')).toHaveText('Jan 2027')
  await expect(page.locator('#hub-calendar-weekdays th')).toHaveText(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])
  await expect(page.getByRole('button',{name:'Go to today',exact:true})).toBeVisible()
  await selectControl(page.locator('#project-sort'),'name')
  await expect(page.locator('.project-card')).toHaveCount(2)
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(page.locator('#hub-calendar-month')).toHaveText('Jan 2027')
})

for(const projects of ['empty','error'])test(`calendar works with an ${projects} project catalog`,async({page})=>{
  await openHub(page,{projects})
  await expect(page.locator('.empty-card')).toBeVisible()
  await page.locator('#hub-calendar-next').click()
  await expect(page.locator('#hub-calendar-month')).toHaveText('2026 12월')
})

for(const theme of ['light','dark'])test(`calendar fits saved sidebar widths and mobile stays compact in ${theme}`,async({page})=>{
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await openHub(page,{language:'en'})
  for(const width of [180,244,320]){
    await page.setViewportSize({width:1440,height:700})
    await page.evaluate(width=>document.body.style.setProperty('--hub-sidebar-width',`${width}px`),width)
    const layout=await page.evaluate(()=>{
      const rail=document.querySelector('.hub-topbar').getBoundingClientRect()
      const calendar=document.querySelector('.hub-calendar').getBoundingClientRect()
      const heading=document.querySelector('#hub-calendar-month')
      return {inside:calendar.left>=rail.left&&calendar.right<=rail.right,headingFits:heading.scrollWidth<=heading.clientWidth,controls:[...document.querySelectorAll('.hub-calendar-controls button')].every(node=>{const r=node.getBoundingClientRect();return r.width>=28&&r.height>=28&&r.left>=rail.left&&r.right<=rail.right}),days:[...document.querySelectorAll('.hub-calendar time')].every(node=>{const r=node.getBoundingClientRect();return r.left>=rail.left&&r.right<=rail.right}),footerBelow:document.querySelector('.hub-toolbar').getBoundingClientRect().top>=calendar.bottom}
    })
    expect(layout).toEqual({inside:true,headingFits:true,controls:true,days:true,footerBelow:true})
  }
  for(const width of [320,390]){
    await page.setViewportSize({width,height:700})
    await expect(page.locator('.hub-calendar')).toBeHidden()
    await expect(page.locator('.project-card').first()).toBeVisible()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  }
})

test('touch sidebar calendar controls retain 44px hit targets',async({browser})=>{
  const context=await namedContext(browser,{viewport:{width:1024,height:800},hasTouch:true,timezoneId:'Asia/Seoul'})
  try{
    const page=await context.newPage();await openHub(page)
    for(const button of await page.locator('.hub-calendar-controls button').all()){
      const bounds=await button.boundingBox()
      expect(bounds.width).toBeGreaterThanOrEqual(44)
      expect(bounds.height).toBeGreaterThanOrEqual(44)
    }
  }finally{await context.close()}
})
