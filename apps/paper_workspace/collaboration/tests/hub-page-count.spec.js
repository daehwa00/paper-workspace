import { expect, test } from './fixtures.js'

test('hub reads latest main page count using backup identity and refreshes on return',async({page})=>{
  let count=12
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'example',activity_id:'backup-alias',display_name:'Example',page_count:7}]}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[]}}))
  await page.route('**/api/backups/projects/backup-alias/assets/__paper_workspace/main-page-count.json',route=>route.fulfill({json:{page_count:count,entrypoint:'main.tex'}}))
  await page.goto('/hub.html')
  await expect(page.locator('.project-page-count')).toHaveText('12p')
  await page.waitForFunction(()=>!projectLoadPending)
  count=15
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.project-page-count')).toHaveText('15p')
})

test('missing or invalid build metadata retains catalog page count',async({page})=>{
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'missing',display_name:'Missing',page_count:7},{slug:'invalid',display_name:'Invalid',page_count:8}]}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[]}}))
  await page.route('**/assets/__paper_workspace/main-page-count.json',route=>route.request().url().includes('/missing/')?route.fulfill({status:404,json:{error:'not found'}}):route.fulfill({json:{page_count:-4}}))
  await page.goto('/hub.html')
  await page.waitForFunction(()=>projects.length===2&&!projectLoadPending)
  await expect(page.locator('[href="/p/missing"] .project-page-count')).toHaveText('7p')
  await expect(page.locator('[href="/p/invalid"] .project-page-count')).toHaveText('8p')
})
