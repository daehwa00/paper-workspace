import {test,expect} from './fixtures.js'

for(const theme of ['light','dark'])for(const language of ['en','ko'])test(`selected tool labels stay complete through panel resizing ${theme} ${language}`,async({page})=>{
  await page.setViewportSize({width:1600,height:1000})
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await page.goto(`/p/visible-tools-${theme}-${language}-${Date.now()}?lang=${language}`)
  await page.waitForFunction(()=>workspaceReadyForCompile)
  const source=await page.evaluate(()=>editorValue())
  for(const width of [420,240,292]){
    await page.evaluate(width=>{layout.assistantWidth=width;layout.assistantCollapsed=false;applyLayout({persist:true})},width)
    for(const id of ['tasks','assist','checks','comments','sources']){
      // Real application handoffs (e.g. a compile diagnostic) select a tool
      // without focusing its tab. Its full label must still become visible.
      await page.evaluate(id=>activateAssistantTab(id),id)
      await expect.poll(()=>page.evaluate(()=>{
        const viewport=document.querySelector('.assistant-tabs').getBoundingClientRect()
        const selected=document.querySelector('.assistant-tabs [aria-selected=true]').getBoundingClientRect()
        return selected.left>=viewport.left-.5&&selected.right<=viewport.right+.5
      })).toBe(true)
      await expect(page.locator('#'+id)).toBeVisible()
    }
  }
  expect(await page.evaluate(()=>editorValue())).toBe(source)
})

test('file-menu separators follow visible action groups',async({page})=>{
  await page.goto('/?lang=en')
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await page.locator('#active-file-actions').click()
  const menu=page.locator('#tree-menu')
  await expect(menu.locator('button:visible')).toHaveCount(1)
  await expect(menu.locator('.menu-separator')).toBeHidden()
  await page.keyboard.press('Escape')
  await page.locator('.file').filter({hasText:'references.bib'}).click({button:'right'})
  await expect(menu.locator('[data-action=rename]')).toBeVisible()
  await expect(menu.locator('[data-action=delete]')).toBeVisible()
  await expect(menu.locator('.menu-separator')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('.folder-row[data-folder=paper]').click({button:'right'})
  await expect(menu.locator('.menu-separator')).toBeHidden()
})

for(const language of ['en','ko'])test(`backup activity has a continuous hierarchy and preserves author text ${language}`,async({page})=>{
  await page.setViewportSize({width:1600,height:1000})
  await page.route('**/api/backups/projects/*/snapshots',route=>route.fulfill({json:{snapshots:[
    {id:'one',title:'First checkpoint',created_at:'2026-10-26T10:00:00Z',actor:'자동',reason:'auto'},
    {id:'two',title:'A long manuscript checkpoint for final submission and coauthor review',created_at:'2026-10-25T10:00:00Z',actor:'Coauthor',reason:'checkpoint:submission-v1'}
  ]}}))
  await page.goto(`/p/backup-activity-${language}-${Date.now()}?lang=${language}`)
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await page.locator('#tab-sources').click()
  const rows=page.locator('.backup-card')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toHaveCSS('border-radius','0px')
  await expect(rows.first()).toHaveCSS('border-bottom-width','0px')
  await expect(rows.first().locator('.backup-card-meta')).toHaveCSS('display','contents')
  await expect(rows.first().locator('.backup-card-meta span')).toContainText(language==='en'?'Automatic · 자동':'자동 · 자동')
  for(const width of [240,292,420]){
    await page.evaluate(width=>{layout.assistantWidth=width;applyLayout()},width)
    await expect.poll(()=>rows.nth(1).locator('strong').evaluate(e=>e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight)).toBe(true)
  }
  await page.evaluate(()=>setBackupStatus('백업 완료 · 10/27/26, 4:31 PM'))
  await expect(page.locator('#backup-status')).toHaveText(language==='en'?'Backup complete · 10/27/26, 4:31 PM':'백업 완료 · 10/27/26, 4:31 PM')
  const compare=rows.first().getByRole('button',{name:language==='en'?'Compare':'비교',exact:true})
  await compare.focus();await expect(compare).toBeFocused()
  await expect(rows.first().getByRole('button',{name:language==='en'?'Restore':'복원',exact:true})).toBeEnabled()
})
