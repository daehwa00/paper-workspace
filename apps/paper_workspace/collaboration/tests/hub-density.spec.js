import {selectControl} from './controls.js';
import {test,expect} from './fixtures.js';
test('hub sidebar follows the saved project workspace width',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarWidth:300})))
 await page.setViewportSize({width:1440,height:900})
 await page.goto('/hub.html?lang=ko')
 await expect(page.locator('.hub-topbar')).toHaveCSS('width','300px')
 await expect(page.getByRole('heading',{name:'Paper Workspace'})).toBeVisible()
 expect((await page.locator('.hub-main').boundingBox()).x).toBe(300)
})
test('paper shows a loading title while its manuscript is being fetched',async({page})=>{
 let release;const gate=new Promise(resolve=>{release=resolve})
 await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'alpha',display_name:'A specific paper'}]}}))
 await page.route('**/project/project.json',async route=>{await gate;await route.continue()})
 try{
  await page.goto('/hub.html?lang=en')
  await page.locator('.project-card').click()
  await expect(page.locator('#project-title')).toHaveValue('')
  await expect(page.locator('#project-title')).toHaveAttribute('placeholder','Loading paper…')
 }finally{release()}
})
for(const theme of ['light','dark'])test(`project library groups rows and retains real navigation ${theme}`,async({page})=>{
 await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme);
 await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[
  {slug:'beta',display_name:'Beta research paper',description:'A project description.',page_count:12},
  {slug:'alpha',display_name:'Alpha research paper',description:'Long 한국어·English description that preserves its full accessible content.',page_count:24}
 ]}}));
 await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[]}}));
 await page.setViewportSize({width:1600,height:1000});await page.goto('/hub.html?lang=en');await page.evaluate(()=>document.fonts.ready);
 const rows=page.locator('.project-card');await expect(rows).toHaveCount(2);
 await expect(page.locator('.hub-topbar')).toHaveCSS('width','244px');
 expect((await page.locator('.hub-intro').boundingBox()).height).toBe(44);
 await expect(page.locator('.hub-list-columns')).toHaveCount(0);
 await expect(page.locator('.hub-calendar')).toBeVisible();
 await expect(page.locator('.hub-topbar a[href^="/p/"]')).toHaveCount(0);
 await expect(page.locator('#hub-location-count')).toHaveText('2');
 await expect(page.locator('#hub-group-toggle')).toHaveCount(0);await expect(rows.first()).toBeVisible();
 await selectControl(page.locator('#project-sort'),'name');await expect(page.locator('.project-card h3')).toHaveText(['Alpha research paper','Beta research paper']);
 await expect(page.locator('#project-search')).toHaveCount(0);await expect(rows).toHaveCount(2);await expect(rows.first().locator('.project-open')).toHaveAttribute('href','/p/alpha');
 await expect(page.locator('#hub-location-count')).toHaveText('2');
 await expect(page.locator('.hub-calendar')).toBeVisible();
 for(const width of [320,390,1024,1600]){
  await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await expect(rows.first()).toBeVisible();await rows.first().locator('.project-open').focus();await expect(rows.first().locator('.project-open')).toBeFocused();
 }
});

test('different list and manuscript titles never flash during startup',async({page})=>{
 await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'alpha',display_name:'A specific paper'}]}}))
 let release;const gate=new Promise(resolve=>{release=resolve})
 await page.route('**/app.js*',async route=>{await gate;await route.continue()})
 try {
  await page.goto('/hub.html?lang=en')
  await page.locator('.project-card').click({noWaitAfter:true})
  await expect(page.locator('#project-title')).toHaveValue('')
  release()
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await expect(page.locator('#project-title')).toHaveValue('A Reusable Paper Workspace')
 } finally {release()}
})

test('direct paper link does not invent an untitled title while loading',async({page})=>{
 let release;const gate=new Promise(resolve=>{release=resolve})
 await page.route('**/app.js*',async route=>{await gate;await route.continue()})
 try {
  await page.goto('/p/direct-paper?lang=en',{waitUntil:'domcontentloaded',timeout:3000}).catch(()=>{})
  await expect(page.locator('#project-title')).toHaveValue('')
  await expect(page.locator('#project-title')).toHaveAttribute('placeholder','Loading paper…')
 } finally {release()}
})

test('project title remains editable after startup',async({page})=>{
 await page.goto('/p/title-edit-check?lang=en')
 await page.waitForFunction(()=>workspaceReadyForCompile)
 const title=page.locator('#project-title')
 await title.fill('An updated manuscript title')
 await title.press('Tab')
 await expect(title).toHaveValue('An updated manuscript title')
 await expect.poll(()=>page.evaluate(()=>editorValue())).toContain('\\title{An updated manuscript title}')
})

for(const theme of ['light','dark'])test(`compact metadata columns keep header and row edges aligned ${theme}`,async({page},info)=>{
 await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
 await page.clock.setFixedTime(new Date('2026-11-12T12:00:00+09:00'))
 await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[
  {slug:'one',display_name:'ALPHABET: A Laplace–Pole History Approximation Backbone with Exact Transitions',description:'A manuscript with a long subtitle for checking available title width.',updated_at:'AISTATS 2026',page_count:21},
  {slug:'two',display_name:'APPLE: Attention-Preserving Path to Latent Evidence',description:'Another manuscript.',updated_at:'arXiv',page_count:9}
 ]}}))
 await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[
  {project_id:'one',actor:'KDH',modified_at:'2026-10-28T07:07:00Z'},
  {project_id:'two',actor:'Me',modified_at:'2026-11-10T13:40:00Z'}
 ]}}))
 await page.goto('/hub.html?lang=ko')
 await expect(page.locator('.project-activity-time')).toHaveCount(2)
 for(const width of [2155,1644,1024,900,768,390]){
  await page.setViewportSize({width,height:900})
  const layout=await page.evaluate(()=>{
   const box=selector=>document.querySelector(selector).getBoundingClientRect()
   const activity=box('.project-activity'),meta=box('.project-meta'),actor=box('.project-actor'),date=box('.project-activity-time'),venue=box('.project-meta span'),pages=box('.project-page-count'),sort=box('.project-sort-label'),main=box('.hub-main')
   return {stacked:getComputedStyle(document.querySelector('.project-activity')).gridColumnStart==='2',mainWidth:main.width,activityWidth:activity.width,metaWidth:meta.width,actorGap:date.left-actor.right,pairGap:meta.left-activity.right,venuePageGap:pages.left-venue.right,activityLeft:activity.left,sortRight:sort.right,pagesRight:pages.right,overflow:document.documentElement.scrollWidth>innerWidth}
  })
  expect(layout.overflow).toBe(false)
  if(!layout.stacked){
   expect(layout.activityWidth).toBe(128)
   expect(layout.metaWidth).toBe(148)
   expect(layout.actorGap).toBe(8)
   expect(layout.pairGap).toBe(width<=1200?12:20)
   expect(layout.venuePageGap).toBeGreaterThanOrEqual(8)
   expect(layout.venuePageGap).toBeLessThanOrEqual(88)
   expect(layout.sortRight).toBeCloseTo(layout.pagesRight,0)
  }
  await expect(page.locator('.project-card').first()).toBeVisible()
 }
 await page.setViewportSize({width:1644,height:850})
 await page.locator('.hub-main').screenshot({path:info.outputPath('compact-metadata.png')})
 await page.locator('#hub-language').selectOption('en')
 await selectControl(page.locator('#project-sort'),'comments')
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})
