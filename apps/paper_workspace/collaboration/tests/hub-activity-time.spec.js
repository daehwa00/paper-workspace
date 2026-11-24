import {test,expect} from './fixtures.js'

test.use({timezoneId:'America/Los_Angeles'})
const fixed='2026-11-12T12:00:00+09:00'
const examples=[
  ['now','2026-11-12T11:59:45+09:00','방금','Just now'],
  ['minutes','2026-11-12T11:37:00+09:00','23분 전','23 minutes ago'],
  ['hours','2026-11-12T09:00:00+09:00','3시간 전','3 hours ago'],
  ['yesterday','2026-11-11T18:52:00+09:00','어제','yesterday'],
  ['days','2026-11-10T22:40:00+09:00','2일 전','2 days ago'],
  ['week','2026-11-05T12:00:00+09:00','7일 전','7 days ago'],
  ['older','2026-10-28T16:07:00+09:00','10월 28일','Oct 28'],
  ['year','2025-10-28T16:07:00+09:00','2025.10.28','Oct 28, 2025'],
  ['future','2026-11-13T12:00:00+09:00','11월 13일','Nov 13']
]
const activity=(page,id)=>page.locator(`.project-card:has(a[href="/p/${id}"]) .project-activity-time`)
async function setup(page){
  await page.clock.install({time:new Date(fixed)})
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:examples.map(([slug])=>({slug,display_name:slug}))}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:examples.map(([project_id,modified_at])=>({project_id,modified_at,actor:'Dae'})),metadata:[]}}))
  await page.goto('/hub.html?lang=ko')
  await expect(page.locator('.project-activity-time')).toHaveCount(examples.length)
}

test('activity uses compact KST dates and retains exact timestamps through language changes',async({page})=>{
  await setup(page)
  for(const [id,date,korean] of examples){
    await expect(activity(page,id)).toHaveText(korean)
    await expect(activity(page,id)).toHaveAttribute('datetime',new Date(date).toISOString())
    await expect(activity(page,id)).toHaveAttribute('title',/KST$/)
    await expect(activity(page,id)).toHaveAttribute('aria-label',await activity(page,id).getAttribute('title'))
  }
  await expect(activity(page,'older')).toHaveAttribute('title',/2026년 10월 28일 16:07 KST/)
  await page.locator('#hub-language').selectOption('en')
  for(const [id,,,english] of examples)await expect(activity(page,id)).toHaveText(english)
})

test('relative times refresh without replacing an active subtitle draft',async({page})=>{
  await setup(page)
  await page.locator('.project-card:has(a[href="/p/now"]) .project-subtitle-edit').click()
  const draft=page.locator('.project-subtitle-inline input')
  await draft.fill('Keep this subtitle draft')
  await page.clock.fastForward(60000)
  await expect(activity(page,'now')).toHaveText('1분 전')
  await expect(draft).toHaveValue('Keep this subtitle draft')
  await expect(draft).toBeFocused()
  await draft.press('Escape')
})
