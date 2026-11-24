import { expect, test, namedContext } from './fixtures.js'

const variants = [
  {width:1600,theme:'light',language:'en'},
  {width:390,theme:'dark',language:'ko'},
  {width:320,theme:'light',language:'en'}
]
const metadata = () => ({schema_version:1,revision:0,enabled:true,jobs:[],rounds:[{
  id:'r1',title:'Synthetic review round',reviewers:[{id:'reviewer1',name:'Reviewer A'}],
  reviews:[{id:'review1',reviewer_id:'reviewer1',fields:{review:'Please clarify the comparison.'},translations:{}}],
  documents:[
    {id:'doc1',title:'Synthetic response',kind:'reviewer',reviewer_id:'reviewer1',text_key:'response:doc1',seed_text:'A synthetic response for shared shell verification.'},
    {id:'doc2',title:'Common response',kind:'common',reviewer_id:null,text_key:'response:doc2',seed_text:'Another synthetic response for navigation.'}
  ],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}
}]})

async function configure(context, {theme,language}, name) {
  const state = metadata()
  await context.addInitScript(({theme,language,name}) => {
    if (localStorage.getItem('paper-workspace-theme') === null) localStorage.setItem('paper-workspace-theme', theme)
    if (localStorage.getItem('paper-workspace-language') === null) localStorage.setItem('paper-workspace-language', language)
    if (name) { localStorage.setItem('collab-name',name);localStorage.setItem('collab-name-user-set','1') }
  }, {theme,language,name})
  await context.route('**/api/rebuttal/projects/**', route => route.fulfill({json:
    new URL(route.request().url()).pathname.endsWith('/versions') ? {versions:[],saved:true} : state
  }))
}

async function readyPaper(page) {
  await page.waitForFunction(() => typeof workspaceReadyForCompile !== 'undefined' && workspaceReadyForCompile && collabReady)
  await page.waitForFunction(() => document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
}
async function openPaper(page, slug, variant) {
  await page.setViewportSize({width:variant.width,height:1000})
  await page.goto(`/p/${slug}?lang=${variant.language}`)
  await readyPaper(page)
  return page.frameLocator('.paper-review-frame')
}
async function openResponse(page, slug, language = 'en') {
  await page.goto(`/p/${slug}/rebuttal?standalone=1&round=r1&lang=${language}#reviews`)
  await page.waitForFunction(() => window.PaperRebuttalSession)
  await page.evaluate(() => window.PaperRebuttalSession.whenReady)
  await expect(page.locator('#response-editor .cm-content')).toBeVisible()
}
async function showResponse(page, frame) {
  await page.locator('#open-rebuttal').click()
  await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
}
async function settle(page, surface) {
  await page.mouse.move(0,0)
  await surface.locator('body').evaluate(async () => {
    await document.fonts.ready
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  })
}
async function paint(locator, pseudo) {
  return locator.evaluate((node, pseudo) => {
    const style = getComputedStyle(node,pseudo)
    const keys = ['backgroundColor','color','borderWidth','borderColor','borderRadius','padding','fontFamily','fontSize','fontWeight','lineHeight','boxShadow','outlineColor','outlineWidth','cursor']
    return Object.fromEntries(keys.map(key => [key,style[key]]))
  }, pseudo)
}
async function openStatus(surface, width) {
  if (width < 768) {
    const utilities = surface.locator('#mobile-utilities')
    if (!await utilities.evaluate(node => node.open)) await utilities.locator(':scope > summary').click()
  }
  await surface.locator('#status-center-toggle').click()
  await expect(surface.locator('#status-center')).toBeVisible()
  await expect(surface.locator('#status-center-toggle')).toHaveAttribute('aria-expanded','true')
}

async function resizerPaint(locator, pseudo) {
  return locator.evaluate((node,pseudo) => {
    const style=getComputedStyle(node,pseudo)
    const keys=['backgroundColor','width','borderWidth','borderRadius','boxShadow','outlineWidth','cursor','opacity']
    if (parseFloat(style.borderWidth)) keys.push('borderColor')
    if (parseFloat(style.outlineWidth)) keys.push('outlineColor')
    return Object.fromEntries(keys.map(key=>[key,style[key]]))
  },pseudo)
}

async function resizePanel(page, surface, separatorSelector, panelSelector) {
  const separator = surface.locator(separatorSelector), panel = surface.locator(panelSelector)
  await expect(separator).toHaveClass(/workspace-resizer/)
  await settle(page, surface)
  const result = {normal:await resizerPaint(separator),normalHandle:await resizerPaint(separator,'::after')}
  await separator.hover()
  await surface.locator('body').evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  })
  result.hover = await resizerPaint(separator)
  result.hoverHandle = await resizerPaint(separator,'::after')
  const originalWidth = (await panel.boundingBox()).width, originalValue = Number(await separator.getAttribute('aria-valuenow'))
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await settle(page, surface)
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(originalValue)
  await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(originalWidth)
  result.focus = await resizerPaint(separator)
  result.focusHandle = await resizerPaint(separator,'::after')
  const beforeDrag = (await panel.boundingBox()).width, box = await separator.boundingBox()
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  await page.mouse.down()
  await page.mouse.move(box.x+box.width/2+45,box.y+box.height/2,{steps:6})
  await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(beforeDrag+30)
  result.drag = await resizerPaint(separator)
  result.dragHandle = await resizerPaint(separator,'::after')
  await page.mouse.up()
  const otherSettings = () => surface.locator('body').evaluate(() => {
    const layout=JSON.parse(localStorage.getItem('paper-workspace-layout') || '{}')
    return Object.fromEntries(['sidebarWidth','sidebarCollapsed','assistantWidth','assistantCollapsed','editorZoom','pdfZoom'].map(key=>[key,layout[key] ?? null]))
  })
  const retained = await otherSettings()
  for (const [key,limit] of [['Home','aria-valuemin'],['End','aria-valuemax']]) {
    await separator.focus()
    await page.keyboard.press(key)
    await expect(separator).toHaveAttribute('aria-valuenow',await separator.getAttribute(limit))
    expect(await otherSettings(),`${key} must retain settings outside the selected divider`).toEqual(retained)
  }
  result.value = await separator.getAttribute('aria-valuenow')
  return result
}

for (const {theme,language} of [{theme:'light',language:'en'},{theme:'dark',language:'ko'}]) test(`shared sidebar and resizers preserve keyboard drag and saved state in ${theme}`, async ({page,context}) => {
  const variant = {width:1600,theme,language}
  await configure(context, variant)
  const frame = await openPaper(page, `shared-shell-resize-${Date.now()}`, variant)
  const paperToggle = page.locator('#toggle-sidebar'), reviewToggle = frame.locator('#toggle-review-sidebar')
  await expect(paperToggle).toHaveClass(/sidebar-toggle/)
  await expect(reviewToggle).toHaveClass(/sidebar-toggle/)
  expect(await paperToggle.locator('svg').innerHTML()).toBe(await reviewToggle.locator('svg').innerHTML())
  expect(await paperToggle.getAttribute('aria-label')).toBe(await reviewToggle.getAttribute('aria-label'))
  await paperToggle.focus()
  await page.keyboard.press('Enter')
  await expect(paperToggle).toHaveAttribute('aria-expanded','false')
  await expect(reviewToggle).toHaveAttribute('aria-expanded','false')
  await expect(paperToggle).toHaveClass(/points-right/)
  await expect(reviewToggle).toHaveClass(/points-right/)
  await showResponse(page, frame)
  await reviewToggle.focus()
  await page.keyboard.press('Enter')
  await expect(reviewToggle).toHaveAttribute('aria-expanded','true')
  await expect(paperToggle).toHaveAttribute('aria-expanded','true')
  await page.keyboard.press('Space')
  await expect(paperToggle).toHaveAttribute('aria-expanded','false')
  await frame.locator('#manuscript-link').click()
  await page.reload()
  await readyPaper(page)
  await expect(paperToggle).toHaveAttribute('aria-expanded','false')
  await expect(reviewToggle).toHaveAttribute('aria-expanded','false')
  await paperToggle.click()
  const sidebar = page.locator('#sidebar-resizer'), originalSidebar = Number(await sidebar.getAttribute('aria-valuenow'))
  await sidebar.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => Number(await sidebar.getAttribute('aria-valuenow'))).toBeGreaterThan(originalSidebar)
  const paperResize = await resizePanel(page,page,'[data-resize="editor-preview"]','#editor-panel')
  await showResponse(page,frame)
  const reviewResize = await resizePanel(page,frame,'#review-panel-resizer','.source-panel')
  for (const state of ['normal','normalHandle','hover','hoverHandle','focus','focusHandle','drag','dragHandle']) {
    expect(reviewResize[state],`shared resizer ${state}`).toEqual(paperResize[state])
  }
  await frame.locator('#manuscript-link').click()
  await page.reload()
  await readyPaper(page)
  await expect(page.locator('[data-resize="editor-preview"]')).toHaveAttribute('aria-valuenow',paperResize.value)
  await showResponse(page,frame)
  await expect(frame.locator('#review-panel-resizer')).toHaveAttribute('aria-valuenow',reviewResize.value)
})

for (const variant of variants) test(`shared panel headers and live status popovers at ${variant.width}px ${variant.theme}`, async ({page,context}) => {
  await configure(context, variant)
  const frame = await openPaper(page, `shared-shell-status-${Date.now()}`, variant)
  const header = page.locator('#editor-panel > .panel-header')
  const paperHeader = await paint(header)
  if (variant.width >= 768) expect((await header.boundingBox()).height).toBe(48)
  else expect((await header.boundingBox()).height).toBeGreaterThanOrEqual(52)
  await openStatus(page,variant.width)
  await settle(page,page)
  const paperPanel = await paint(page.locator('#status-center')), paperClose = await paint(page.locator('#status-center-close'))
  const panelBox = await page.locator('#status-center').boundingBox()
  expect(panelBox.width).toBeLessThanOrEqual(320)
  expect(panelBox.x).toBeGreaterThanOrEqual(0)
  expect(panelBox.x+panelBox.width).toBeLessThanOrEqual(variant.width)
  await page.keyboard.press('Escape')
  await expect(page.locator('#status-center')).toBeHidden()
  await expect(page.locator(variant.width<768?'#mobile-utilities > summary':'#status-center-toggle')).toBeFocused()
  await openStatus(page,variant.width)
  await page.locator('#status-center-close').click()
  await openStatus(page,variant.width)
  await page.locator('#editor-view .cm-content').click()
  await expect(page.locator('#status-center')).toBeHidden()

  await showResponse(page,frame)
  await settle(page,frame)
  const reviewHeader = frame.locator('.source-panel > .panel-header')
  expect(await paint(reviewHeader)).toEqual(paperHeader)
  if (variant.width>=768) expect((await reviewHeader.boundingBox()).height).toBe(48)
  else expect((await reviewHeader.boundingBox()).height).toBeGreaterThanOrEqual(52)
  await openStatus(frame,variant.width)
  await expect(frame.locator('#form-dialog')).toBeHidden()
  await settle(page,frame)
  expect(await paint(frame.locator('#status-center'))).toEqual(paperPanel)
  expect(await paint(frame.locator('#status-center-close'))).toEqual(paperClose)
  const expectStatusInsideViewport = async () => expect.poll(async () => {
    const bounds=await frame.locator('#status-center').boundingBox()
    return Boolean(bounds && bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=variant.width && bounds.y+bounds.height<=1000)
  }, {message:'The open status panel must reposition inside the viewport after its content changes'}).toBe(true)
  for (const name of ['latest-a','latest-b']) {
    // The shared Y.Doc belongs to the parent realm. Match a server update there
    // instead of handing Yjs a plain object constructed in its iframe realm.
    await page.evaluate(name => window.PaperWorkspaceSharedSession.mapFor('rebuttalSourceStatus').set('response:doc1',{
      state:'conflict',path:`rebuttal/responses/${name}.md`,conflictPaths:[]
    }),name)
    await expect(frame.locator('#status-center-details')).toContainText(`${name}.md`)
    await expectStatusInsideViewport()
  }
  await expect(frame.locator('#status-center-details')).not.toContainText('latest-a.md')
  const shortHeight=(await frame.locator('#status-center').boundingBox()).height
  const longPath=`rebuttal/responses/${'synthetic-directory/'.repeat(20)}latest-b.md`
  await page.evaluate(path=>window.PaperWorkspaceSharedSession.mapFor('rebuttalSourceStatus').set('response:doc1',{
    state:'conflict',path,conflictPaths:Array.from({length:8},(_,index)=>`rebuttal/conflicts/${index}/${'synthetic-conflict/'.repeat(20)}preserved-${index}.md`)
  }),longPath)
  await expect(frame.locator('#status-center-details')).toContainText(longPath)
  await expect.poll(async ()=>(await frame.locator('#status-center').boundingBox()).height).toBeGreaterThan(shortHeight+50)
  await expectStatusInsideViewport()
  await page.evaluate(()=>window.PaperWorkspaceSharedSession.mapFor('rebuttalSourceStatus').set('response:doc1',{
    state:'conflict',path:'rebuttal/responses/latest-b.md',conflictPaths:[]
  }))
  await expect(frame.locator('#status-center-details')).not.toContainText('synthetic-directory')
  await frame.locator('#status-center-close').click()
  await openStatus(frame,variant.width)
  await expect(frame.locator('#status-center-details')).toContainText('latest-b.md')
  await page.keyboard.press('Escape')
  await expect(frame.locator('#status-center')).toBeHidden()
  await expect(frame.locator(variant.width<768?'#mobile-utilities > summary':'#status-center-toggle')).toBeFocused()
  await openStatus(frame,variant.width)
  await frame.locator('#response-editor .cm-content').click()
  await expect(frame.locator('#status-center')).toBeHidden()
})

test('response collaborators share header profiles and follow the selected response without duplicate ids', async ({browser}) => {
  const contexts = await Promise.all([namedContext(browser),namedContext(browser),namedContext(browser)])
  const [alice,bob,cara] = await Promise.all(contexts.map(context => context.newPage()))
  const variant = variants[0], slug = `shared-response-people-${Date.now()}`
  try {
    await Promise.all(contexts.map((context,index) => configure(context,variant,['Alice Author','Research Mate','Jamie Park'][index])))
    const frame = await openPaper(alice,slug,variant)
    await Promise.all([openResponse(bob,slug),openResponse(cara,slug)])
    await showResponse(alice,frame)
    const header = frame.locator('#project-presence-avatars .project-presence-avatar'), response = frame.locator('#response-presence-avatars .project-presence-avatar')
    await expect(header).toHaveCount(2)
    await expect(response).toHaveCount(2)
    await expect(frame.locator('#project-presence')).toHaveCount(1)
    await expect(frame.locator('#response-presence')).toHaveCount(1)
    for (const width of [1600,390,320]) {
      await alice.setViewportSize({width,height:1000})
      expect(await response.allTextContents()).toEqual(await header.allTextContents())
      for (const avatar of await response.all()) {
        const bounds = await avatar.boundingBox()
        expect(bounds.width).toBe(28)
        expect(bounds.height).toBe(28)
      }
      const boxes = await Promise.all((await response.all()).map(avatar => avatar.boundingBox()))
      expect(boxes[1].x-boxes[0].x-boxes[0].width).toBe(-4)
      if (width<768) expect((await frame.locator('#response-presence-toggle').boundingBox()).height).toBeGreaterThanOrEqual(44)
    }
    expect(await response.allTextContents()).toEqual(['JP','RM'])
    await bob.locator('#response-editor .cm-content').click()
    await bob.keyboard.press('Control+Home')
    for (let index=0;index<6;index++) await bob.keyboard.press('Shift+ArrowRight')
    await expect.poll(() => alice.evaluate(() => {
      const session=window.PaperWorkspaceSharedSession, peer=[...session.provider.awareness.getStates().values()].find(peer=>peer.user?.name==='Research Mate')
      return session.resolveRange(peer?.rebuttal || {},session.mapFor('rebuttalResponses').get('response:doc1'))
    })).toEqual([0,6])
    await alice.setViewportSize({width:390,height:1000})
    const responseToggle=frame.locator('#response-presence-toggle')
    await responseToggle.focus()
    await alice.keyboard.press('ArrowDown')
    const firstPerson=frame.locator('#response-presence-list .project-presence-person:not(:disabled)').first()
    await expect(firstPerson).toBeFocused()
    const selectedId=await firstPerson.getAttribute('data-client-id')
    await frame.locator('body').evaluate(()=>document.dispatchEvent(new Event('scroll')))
    await expect(frame.locator('#response-presence')).toHaveAttribute('open','')
    await expect(firstPerson).toBeFocused()
    await frame.locator('#response-presence').evaluate(()=>window.PaperRebuttal.refresh())
    await frame.locator('body').evaluate(()=>document.dispatchEvent(new Event('scroll')))
    await expect(frame.locator('#response-presence')).toHaveAttribute('open','')
    await expect(frame.locator(`#response-presence-list .project-presence-person[data-client-id="${selectedId}"]`)).toBeFocused()
    await alice.keyboard.press('Escape')
    await expect(frame.locator('#response-presence')).not.toHaveAttribute('open','')
    await expect(responseToggle).toBeFocused()
    await frame.locator('#response-presence-toggle').click()
    await frame.locator('#response-presence-list .project-presence-person').filter({hasText:'Research Mate'}).click()
    await expect.poll(() => frame.locator('#response-editor').evaluate(() => window.PaperRebuttal.getSelection().end)).toBe(6)
    await bob.locator('#reviewer-nav [data-action="open-document"][data-id="doc2"]').click()
    await expect(response).toHaveCount(1)
    await expect(header).toHaveCount(2)
    await frame.locator('#response-presence-toggle').click()
    await expect(frame.locator('#response-presence-list .project-presence-person').filter({hasText:'Research Mate'})).toHaveCount(0)
    await alice.keyboard.press('Escape')
    await frame.locator('#project-presence-toggle').click()
    await frame.locator('#project-presence-list .project-presence-person').filter({hasText:'Research Mate'}).click()
    await expect(frame.locator('.response-document-heading')).toContainText('Common response')
    await expect(response).toHaveCount(1)
    await expect(response).toHaveAttribute('title','Research Mate')
  } finally { await Promise.all(contexts.map(context => context.close())) }
})
