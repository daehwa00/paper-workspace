import {test,expect} from './fixtures.js'

// All UI dates must stay in KST even when the browser is abroad.
test.use({timezoneId:'America/Los_Angeles'})
async function openHub(page,now='2026-11-12T12:00:00+09:00',language='ko'){
  await page.clock.setFixedTime(new Date(now))
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'alpha',display_name:'Alpha paper'}]}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[],metadata:[]}}))
  await page.goto(`/hub.html?lang=${language}`)
  await expect(page.locator('#hub-calendar-month')).not.toBeEmpty()
}
const day=(page,key)=>page.locator(`[data-calendar-date="${key}"]`)
const popover=page=>page.locator('#hub-deadline-popover')
async function expectMilestone(page,name,stage,key){
  const card=popover(page).locator('article').filter({hasText:`${name} 2027`})
  await expect(card.locator('.hub-deadline-name')).toHaveText(`${name} 2027`)
  await expect(card.locator('.hub-deadline-stage').filter({hasText:stage}).locator('time')).toHaveAttribute('datetime',`${key}T11:59:00.000Z`)
}


test('two nearest deadlines cross months and open their KST date and official source',async({page})=>{
  await openHub(page)
  const rows=page.locator('.hub-upcoming-deadline')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('ICAPSAbstract12.08 20:59D-26')
  await expect(rows.nth(1)).toContainText('ICAPSFull paper12.15 20:59D-33')
  await rows.first().click()
  await expect(page.locator('#hub-calendar-month')).toHaveText('2026 12월')
  await expect(popover(page)).toBeVisible()
  await expect(day(page,'2026-12-08')).toHaveAttribute('aria-expanded','true')
  await expectMilestone(page,'ICAPS','Abstract','2026-12-08')
  await expect(popover(page).getByRole('link',{name:'공식 일정 ↗'})).toHaveAttribute('href','https://icaps27.icaps-conference.org/calls/cfp/')
  await expect(popover(page).getByRole('link',{name:'공식 일정 ↗'})).toHaveAttribute('rel','noopener noreferrer')
})

test('January merges full and abstract deadlines without inventing abstract dates',async({page})=>{
  await openHub(page,'2027-01-01T12:00:00+09:00')
  await expect(page.locator('#hub-calendar-days .deadline-dot')).toHaveCount(8)
  await expect(day(page,'2027-01-05').locator('.deadline-dot.full')).toHaveCount(1)
  await expect(day(page,'2027-01-05').locator('.deadline-dot.abstract')).toHaveCount(1)
  await day(page,'2027-01-05').click()
  await expect(popover(page).locator('article')).toHaveCount(2)
  await expectMilestone(page,'ACL','Full paper','2027-01-05')
  await expectMilestone(page,'IJCAI','Abstract','2027-01-05')
  await expect(popover(page)).toContainText('ARR 논문 제출')
  await page.keyboard.press('Escape')
  await day(page,'2027-01-15').click()
  await expectMilestone(page,'ICML','Abstract','2027-01-15')
  await expectMilestone(page,'SIGIR','Abstract','2027-01-15')
  await page.keyboard.press('Escape')
  await day(page,'2027-01-30').click()
  await expectMilestone(page,'COLT','Full paper','2027-01-30')
})

test('commitment has a separate marker and explains reviewed ARR papers',async({page})=>{
  await openHub(page,'2026-12-01T12:00:00+09:00')
  await expect(day(page,'2026-12-24').locator('.deadline-dot.commitment')).toHaveCount(1)
  await day(page,'2026-12-24').click()
  await expectMilestone(page,'NAACL','Commitment','2026-12-24')
  await expect(popover(page)).toContainText('신규 논문 제출과 다릅니다')
})

test('keyboard selection, Escape, close and outside click dismiss the detail card',async({page})=>{
  await openHub(page,'2026-12-01T12:00:00+09:00')
  const trigger=day(page,'2026-12-08')
  await trigger.focus();await page.keyboard.press('Enter')
  await expect(popover(page)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button',{name:'마감 상세 닫기'})).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(popover(page).getByRole('link').first()).toBeFocused()
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(popover(page).getByRole('link').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(popover(page)).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded','false')
  await page.keyboard.press('Space')
  await page.getByRole('button',{name:'마감 상세 닫기'}).click()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.locator('.hub-page-header h2').click()
  await expect(popover(page)).toBeHidden()
  await expect(trigger).toHaveAttribute('aria-expanded','false')
})

test('month changes close details and language/background refresh preserve view and focus',async({page})=>{
  await openHub(page,'2026-12-01T12:00:00+09:00')
  await day(page,'2026-12-24').click()
  await page.locator('#hub-language').selectOption('en')
  await expect(page.locator('#hub-calendar-month')).toHaveText('Dec 2026')
  await expect(popover(page)).toContainText('not a new paper submission')
  await expect(page.getByRole('button',{name:'Close deadline details'})).toBeVisible()
  await page.keyboard.press('Escape')
  const trigger=day(page,'2026-12-24');await trigger.focus()
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.locator('#hub-calendar-next').click()
  await expect(popover(page)).toBeHidden()
  await expect(page.locator('#hub-calendar-month')).toHaveText('Jan 2027')
})

test('KST today, D-day and inclusive final-minute cutoffs ignore the browser timezone',async({page})=>{
  await openHub(page,'2027-01-04T16:01:00Z')
  await expect(page.locator('[aria-current="date"]')).toHaveAttribute('datetime','2027-01-05')
  await expect(page.locator('.hub-upcoming-deadline').first()).toContainText('오늘 마감')
  await page.clock.setFixedTime(new Date('2027-01-05T20:59:45+09:00'))
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(page.locator('.hub-upcoming-deadline').first()).toContainText('ACL')
  await page.clock.setFixedTime(new Date('2027-01-05T21:00:00+09:00'))
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(page.locator('.hub-upcoming-deadline').first()).toContainText('IJCAI')
  await expect(page.locator('.hub-upcoming-deadline').first()).toContainText('01.12')
})

test('expired and uncertain dates are not plotted as upcoming confirmed deadlines',async({page})=>{
  await openHub(page,'2027-02-01T00:00:00+09:00')
  await expect(page.locator('.hub-upcoming-deadline')).toHaveCount(0)
  await expect(page.locator('#hub-upcoming-deadlines')).toContainText('예정된 확정 마감이 없습니다')
  await expect(page.locator('#hub-calendar-days .deadline-dot')).toHaveCount(0)
  await page.locator('#hub-calendar-next').click()
  await expect(page.locator('#hub-calendar-days .deadline-dot')).toHaveCount(0)
})

for(const theme of ['light','dark'])test(`detail card fits a short and narrow viewport in ${theme}`,async({page})=>{
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await page.setViewportSize({width:1024,height:480})
  await openHub(page,'2027-01-01T12:00:00+09:00','en')
  await page.evaluate(()=>document.body.style.setProperty('--hub-sidebar-width','180px'))
  const colors=await page.evaluate(()=>{
    const full=document.querySelector('#hub-calendar-days .deadline-dot.full')
    const hollow=document.querySelector('#hub-calendar-days .deadline-dot.abstract')
    const reference=document.createElement('span');reference.style.color='var(--theme-text-strong)';document.body.append(reference)
    const expected=getComputedStyle(reference).color;reference.remove()
    return {full:getComputedStyle(full).backgroundColor,hollow:getComputedStyle(hollow).borderTopColor,expected}
  })
  expect(colors.full).toBe(colors.expected)
  expect(colors.hollow).toBe(colors.expected)
  await day(page,'2027-01-05').click()
  const bounds=await popover(page).boundingBox()
  await expect(popover(page).locator('.hub-deadline-section-title')).toHaveCount(0)
  await expect(popover(page).locator('.hub-conference-milestones').first()).toHaveAttribute('aria-label',/KST/)
  expect(bounds.width).toBeCloseTo(368,1)
  expect(await popover(page).locator('.hub-deadline-name strong').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize))).toBe(15)
  expect(bounds.x).toBeGreaterThanOrEqual(12)
  expect(bounds.y).toBeGreaterThanOrEqual(12)
  expect(bounds.x+bounds.width).toBeLessThanOrEqual(1012)
  expect(bounds.y+bounds.height).toBeLessThanOrEqual(468)
  expect(await page.locator('.hub-topbar').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true)
  await page.screenshot({path:test.info().outputPath(`deadline-calendar-${theme}.png`)})
  await page.setViewportSize({width:390,height:700})
  await expect(popover(page)).toBeHidden()
  await expect(page.locator('.hub-calendar')).toBeHidden()
})


for(const theme of ['light','dark'])test(`all dates align with markers above and countdowns share a column in ${theme}`,async({page})=>{
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await page.setViewportSize({width:1440,height:900})
  await openHub(page,'2027-01-12T12:00:00+09:00')
  await expect(page.locator('.hub-deadlines-heading h3')).toHaveText('Upcoming deadlines')
  await expect(page.locator('#hub-calendar-days button')).toHaveCount(42)
  for(const width of [180,244,320]){
    await page.evaluate(width=>document.body.style.setProperty('--hub-sidebar-width',`${width}px`),width)
    const layout=await page.evaluate(()=>{
      const rows=[...document.querySelectorAll('#hub-calendar-days tr')]
      const aligned=rows.every(row=>{
        const tops=[...row.querySelectorAll('time')].map(node=>node.getBoundingClientRect().top)
        return Math.max(...tops)-Math.min(...tops)<.6
      })
      const markersAbove=[...document.querySelectorAll('#hub-calendar-days .deadline-dot')].every(marker=>{
        const range=document.createRange();range.selectNodeContents(marker.closest('button').querySelector('time'))
        return marker.getBoundingClientRect().bottom+2<=range.getBoundingClientRect().top
      })
      const countdowns=[...document.querySelectorAll('.hub-upcoming-countdown')].map(node=>node.getBoundingClientRect())
      const noOverlap=[...document.querySelectorAll('.hub-upcoming-deadline')].every(node=>{
        const title=node.querySelector('.hub-upcoming-title').getBoundingClientRect()
        const time=node.querySelector('time').getBoundingClientRect()
        const countdown=node.querySelector('.hub-upcoming-countdown').getBoundingClientRect()
        return title.right<=countdown.left&&time.right<=countdown.left
      })
      return {aligned,markersAbove,countdownsAligned:countdowns.every(box=>Math.abs(box.left-countdowns[0].left)<.6&&Math.abs(box.right-countdowns[0].right)<.6),noOverlap}
    })
    expect(layout).toEqual({aligned:true,markersAbove:true,countdownsAligned:true,noOverlap:true})
  }
  await day(page,'2027-01-13').click()
  await expect(day(page,'2027-01-13')).toHaveClass(/is-selected/)
  await expect(popover(page)).toBeHidden()
  await expect(day(page,'2027-01-13')).toHaveAttribute('aria-expanded','false')
  await day(page,'2026-12-27').focus();await page.keyboard.press('Enter')
  await expect(popover(page)).toBeHidden()
  await expect(day(page,'2026-12-27')).toHaveClass(/is-selected/)
  await expect(page.locator('#hub-calendar-month')).toHaveText('2027 1월')
  await page.locator('#hub-language').selectOption('en')
  await expect(popover(page)).toBeHidden()
  await expect(page.locator('.hub-deadlines-heading h3')).toHaveText('Upcoming deadlines')
})

test('conference cards include verified locations, local event dates, focus and every known KST milestone',async({page})=>{
  await openHub(page,'2026-12-01T12:00:00+09:00')
  await day(page,'2026-12-08').click()
  const card=popover(page).locator('article')
  await expect(card).toContainText('Columbia, SC, USA')
  await expect(card).toContainText('자동 계획')
  await expect(card).toContainText('2027.06.27 – 07.02')
  await expectMilestone(page,'ICAPS','Abstract','2026-12-08')
  await expectMilestone(page,'ICAPS','Full paper','2026-12-15')
  await expect(card.getByRole('link',{name:'공식 웹사이트 ↗'})).toHaveAttribute('href','https://icaps27.icaps-conference.org/')
  await page.keyboard.press('Escape')
  await page.locator('#hub-calendar-next').click()
  await day(page,'2027-01-15').click()
  const icml=popover(page).locator('article').filter({hasText:'ICML 2027'})
  await expect(icml).toContainText('Riocentro · Rio de Janeiro, Brazil')
  await expect(icml).toContainText('머신러닝')
  await expect(icml).toContainText('2027.07.31 – 08.06')
  await expectMilestone(page,'ICML','Full paper','2027-01-23')
  await expectMilestone(page,'SIGIR','Full paper','2027-01-22')
  const sigir=popover(page).locator('article').filter({hasText:'SIGIR 2027'})
  await expect(sigir).toContainText('Signia by Hilton · San Jose, CA, USA')
  await page.locator('#hub-language').selectOption('en')
  await expect(icml).toContainText('Machine learning')
  await expect(icml).toContainText('Dates (local)')
  await expect(icml.getByRole('link',{name:'Website ↗'})).toHaveAttribute('href','https://icml.cc/Conferences/2027')
})

test('an upcoming conference opens only its own card even when another shares the deadline',async({page})=>{
  await openHub(page,'2027-01-15T12:00:00+09:00')
  await page.locator('[data-deadline-id="icml-abstract"]').click()
  await expect(popover(page).locator('article')).toHaveCount(1)
  await expect(popover(page)).toContainText('ICML 2027')
  await page.keyboard.press('Escape')
  await page.locator('[data-deadline-id="sigir-abstract"]').click()
  await expect(popover(page).locator('article')).toHaveCount(1)
  await expect(popover(page)).toContainText('SIGIR 2027')
})


test('pointer opens details without focusing close and empty dates dismiss without a popup',async({page})=>{
  await openHub(page,'2027-01-12T12:00:00+09:00')
  await day(page,'2027-01-15').click()
  await expect(popover(page)).toBeVisible()
  await expect(page.locator('#hub-deadline-close')).not.toBeFocused()
  expect(await page.locator('#hub-deadline-close').evaluate(node=>node.matches(':focus-visible'))).toBe(false)
  await day(page,'2027-01-13').click()
  await expect(popover(page)).toBeHidden()
  await expect(day(page,'2027-01-13')).toHaveClass(/is-selected/)
  await expect(day(page,'2027-01-13')).toHaveAttribute('aria-expanded','false')
  await page.evaluate(()=>dispatchEvent(new Event('focus')))
  await expect(popover(page)).toBeHidden()
  await day(page,'2027-01-15').click()
  await expect(popover(page)).toBeVisible()
  await expect(page.locator('#hub-deadline-close')).not.toBeFocused()
})


test('details omit the duplicate date heading and ranking badges while highlighting the calendar date',async({page})=>{
  await openHub(page,'2026-12-01T12:00:00+09:00')
  await day(page,'2026-12-08').click()
  await expect(popover(page)).toBeVisible()
  await expect(day(page,'2026-12-08')).toHaveClass(/is-selected/)
  await expect(page.locator('#hub-deadline-title')).toHaveClass('sr-only')
  await expect(page.locator('#hub-deadline-title')).toHaveText('학회 상세 정보')
  await expect(popover(page).locator('.hub-deadline-rank')).toHaveCount(0)
  await expect(popover(page)).not.toContainText('A*')
  await expect(popover(page).locator('.hub-deadline-name')).toHaveText('ICAPS 2027')
})


test('detail cards stay to the right of the entire calendar across desktop widths',async({page})=>{
  await openHub(page,'2027-01-12T12:00:00+09:00')
  for(const viewport of [768,1024,1440]){
    await page.setViewportSize({width:viewport,height:800})
    for(const width of [180,244,320]){
      await page.evaluate(width=>document.body.style.setProperty('--hub-sidebar-width',`${width}px`),width)
      await day(page,'2027-01-15').click()
      const box=await popover(page).boundingBox()
      const sidebar=await page.locator('.hub-topbar').boundingBox()
      const calendar=await page.locator('.hub-calendar').boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(sidebar.x+sidebar.width+11.9)
      expect(box.x).toBeGreaterThanOrEqual(calendar.x+calendar.width)
      expect(box.x+box.width).toBeLessThanOrEqual(viewport-11.9)
      expect(box.y).toBeGreaterThanOrEqual(11.9)
      expect(box.y+box.height).toBeLessThanOrEqual(788.1)
      await page.keyboard.press('Escape')
    }
  }
})
