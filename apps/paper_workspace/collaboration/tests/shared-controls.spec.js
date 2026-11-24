import { expect, test } from './fixtures.js'

const cases = [
  {mode:'paper',width:1600,theme:'light',language:'en'},
  {mode:'embedded',width:390,theme:'dark',language:'ko'},
  {mode:'standalone',width:320,theme:'light',language:'ko'}
]
const fixtureState = () => ({schema_version:1,revision:0,enabled:true,jobs:[],rounds:[{
  id:'r1',title:'Synthetic review round',reviewers:[{id:'reviewer1',name:'Reviewer A'}],
  reviews:[{id:'review1',reviewer_id:'reviewer1',fields:{review:'Please clarify the comparison.'},translations:{}}],
  documents:[{id:'doc1',title:'Synthetic response',kind:'reviewer',reviewer_id:'reviewer1',text_key:'response:doc1',seed_text:'A synthetic response for shared settings verification.'}],
  imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}
}]})

async function configure(context, settings) {
  const state = fixtureState()
  await context.addInitScript(({theme,language}) => {
    if (localStorage.getItem('paper-workspace-theme') === null) localStorage.setItem('paper-workspace-theme', theme)
    if (localStorage.getItem('paper-workspace-language') === null) localStorage.setItem('paper-workspace-language', language)
  }, settings)
  // The actual shared sidebar, menus, dialogs and collaboration remain live.
  await context.route('**/api/rebuttal/projects/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'PUT' && /\/rounds\/[^/]+$/.test(path)) {
      const update = request.postDataJSON().round
      state.rounds[state.rounds.findIndex(round => round.id === update.id)] = update
      state.revision++
    }
    return route.fulfill({json:path.endsWith('/versions') ? {versions:[],saved:true} : state})
  })
  return state
}

async function open(page, slug, settings) {
  await page.setViewportSize({width:settings.width,height:900})
  if (settings.mode === 'standalone') {
    await page.goto(`/p/${slug}/rebuttal?standalone=1&round=r1&lang=${settings.language}#reviews`)
    await page.waitForFunction(() => window.PaperRebuttalSession)
    await page.evaluate(() => window.PaperRebuttalSession.whenReady)
    await expect(page.locator('#response-editor .cm-content')).toBeVisible()
    return page
  }
  await page.goto(`/p/${slug}?lang=${settings.language}`)
  await page.waitForFunction(() => typeof workspaceReadyForCompile !== 'undefined' && workspaceReadyForCompile && collabReady)
  await page.waitForFunction(() => document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
  if (settings.mode === 'paper') return page
  await page.locator('#open-rebuttal').click()
  const frame = page.frameLocator('.paper-review-frame')
  await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
  return frame
}

async function utilities(surface, width) {
  if (width >= 768) return
  const menu = surface.locator('#mobile-utilities')
  if (!await menu.evaluate(node => node.open)) await menu.locator(':scope > summary').click()
  await expect(menu).toHaveAttribute('open', '')
}

async function appearance(surface, width) {
  await utilities(surface, width)
  await surface.locator('#review-appearance-trigger').click()
  await expect(surface.locator('.theme-dialog')).toBeVisible()
  if (width < 768) await expect(surface.locator('#mobile-utilities')).not.toHaveAttribute('open', '')
}

async function picker(surface) {
  const trigger = surface.locator('#workspace-theme').locator('..').locator('.property-trigger')
  await trigger.click()
  const popup = surface.locator(`#${await trigger.getAttribute('aria-controls')}`)
  await expect(popup).toBeVisible()
  return {trigger,popup}
}

async function chooseTheme(surface, width, value) {
  await appearance(surface, width)
  const {popup} = await picker(surface)
  const label = await surface.locator('#workspace-theme').evaluate((node, value) => [...node.options].find(option => option.value === value).label, value)
  await popup.getByRole('option', {name:label,exact:true}).click()
  await expect(popup).toBeHidden()
  await surface.locator('#review-appearance-done').click()
  await expect(surface.locator('.theme-dialog')).toBeHidden()
}

async function checkPreloadedSettings(page, settings, language, theme) {
  await expect(page.locator('html')).toHaveAttribute('lang', language)
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', theme)
  if (settings.mode !== 'standalone') {
    const frame = page.frameLocator('.paper-review-frame')
    await expect(frame.locator('html')).toHaveAttribute('lang', language)
    await expect(frame.locator('html')).toHaveAttribute('data-color-scheme', theme)
  }
}

for (const settings of cases) test(`shared settings journey: ${settings.mode} ${settings.width}px ${settings.language} ${settings.theme}`, async ({page,context}) => {
  await configure(context, settings)
  const surface = await open(page, `shared-controls-flow-${settings.mode}-${Date.now()}`, settings)
  const profile = surface.locator('#collab-name'), dialog = surface.locator('#name-dialog'), input = surface.locator('#name-input')
  const savedColor = await profile.evaluate(node => getComputedStyle(node).backgroundColor)
  await profile.click()
  await expect(input).toBeFocused()
  await input.fill('Unsaved name')
  await surface.locator('input[name="profile-color"][value="#dc2626"]').locator('..').click()
  await surface.locator('#cancel-name').click()
  await expect(dialog).toBeHidden()
  await expect(profile).toBeFocused()
  await expect(profile).toHaveText('TA')
  await expect(profile).toHaveCSS('background-color', savedColor)
  expect(await page.evaluate(() => localStorage.getItem('collab-name'))).toBe('Test Author')

  await profile.click()
  for (const invalid of ['   ','Me','\u200b']) {
    await input.fill(invalid)
    await surface.locator('#save-name').click()
    await expect(dialog).toBeVisible()
    expect(await input.evaluate(node => node.validity.valid)).toBe(false)
  }
  await input.fill('  Research   Mate  ')
  await surface.locator('input[name="profile-color"][value="#059669"]').locator('..').click()
  await surface.locator('#save-name').click()
  await expect(dialog).toBeHidden()
  await expect(profile).toBeFocused()
  await expect(profile).toHaveText('RM')
  await expect(profile).toHaveCSS('background-color', 'rgb(5, 150, 105)')
  expect(await page.evaluate(() => ({name:localStorage.getItem('collab-name'),color:localStorage.getItem('collab-color')}))).toEqual({name:'Research   Mate',color:'#059669'})
  await expect.poll(() => profile.evaluate(() => (window.PaperRebuttalSession || window.PaperWorkspaceSharedSession).provider.awareness.getLocalState().user?.name)).toBe('Research   Mate')
  if (settings.mode !== 'standalone') {
    await expect(page.locator('#collab-name')).toHaveText('RM')
    await expect(page.frameLocator('.paper-review-frame').locator('#collab-name')).toHaveText('RM')
  }

  await appearance(surface, settings.width)
  const {trigger,popup} = await picker(surface)
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  await expect(surface.locator('.theme-dialog')).toBeVisible()
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(surface.locator('.theme-dialog')).toBeHidden()
  await expect(surface.locator(settings.width < 768 ? '#mobile-utilities > summary' : '#review-appearance-trigger')).toBeFocused()

  const nextTheme = settings.theme === 'light' ? 'dark' : 'light'
  await chooseTheme(surface, settings.width, nextTheme)
  await checkPreloadedSettings(page, settings, settings.language, nextTheme)
  const nextLanguage = settings.language === 'en' ? 'ko' : 'en'
  await utilities(surface, settings.width)
  await surface.locator('#workspace-language').selectOption(nextLanguage)
  await checkPreloadedSettings(page, settings, nextLanguage, nextTheme)
  if (settings.width < 768) {
    const menu = surface.locator('#mobile-utilities'), summary = menu.locator(':scope > summary')
    await expect(menu).not.toHaveAttribute('open', '')
    await utilities(surface, settings.width)
    await surface.locator('#review-appearance-trigger').focus()
    await page.keyboard.press('Escape')
    await expect(menu).not.toHaveAttribute('open', '')
    await expect(summary).toBeFocused()
    await utilities(surface, settings.width)
    await surface.locator(settings.mode === 'paper' ? '#editor-view .cm-content' : '#response-editor .cm-content').click()
    await expect(menu).not.toHaveAttribute('open', '')
  }
})

async function style(surface, selector, dimensions = true) {
  return surface.locator(selector).evaluate((node, dimensions) => {
    const computed = getComputedStyle(node), bounds = node.getBoundingClientRect()
    const keys = ['fontFamily','fontSize','fontWeight','lineHeight','padding','gap','minWidth','minHeight','borderRadius','borderWidth','backgroundColor','color','boxSizing']
    return {
      ...Object.fromEntries(keys.map(key => [key,computed[key]])),
      // DOMRect subtraction can differ by ~0.00003px between an iframe and its
      // parent. Keep visible geometry differences while excluding float noise.
      ...(dimensions ? {width:Math.round(bounds.width*100)/100,height:Math.round(bounds.height*100)/100} : {})
    }
  }, dimensions)
}

async function settleControls(page, surface) {
  await page.mouse.move(0, 0)
  await surface.locator('body').evaluate(async () => {
    await document.fonts.ready
    await Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
  })
}

async function controlStyles(page, surface, width) {
  await settleControls(page, surface)
  const result = {profile:await style(surface, '#collab-name')}
  await utilities(surface, width)
  await settleControls(page, surface)
  result.appearanceButton = await style(surface, '#review-appearance-trigger')
  result.statusButton = await style(surface, '#status-center-toggle', false)
  if (width < 768) {
    result.utilitySummary = await style(surface, '#mobile-utilities > summary')
    result.utilityMenu = await style(surface, '.mobile-utility-items')
    await surface.locator('#mobile-utilities > summary').click()
  }
  await surface.locator('#collab-name').click()
  await expect(surface.locator('#name-dialog')).toBeVisible()
  await settleControls(page, surface)
  result.profileDialog = await style(surface, '#name-dialog')
  result.profileForm = await style(surface, '#name-dialog > form')
  result.profileHeading = await style(surface, '#name-title', false)
  result.profileInput = await style(surface, '#name-input')
  result.saveButton = await style(surface, '#save-name')
  result.cancelButton = await style(surface, '#cancel-name')
  await surface.locator('#cancel-name').click()
  await appearance(surface, width)
  await settleControls(page, surface)
  result.appearanceDialog = await style(surface, '.theme-dialog')
  result.appearanceForm = await style(surface, '.theme-dialog > form')
  result.appearanceHeading = await style(surface, '#appearance-title', false)
  result.doneButton = await style(surface, '#review-appearance-done')
  const {trigger,popup} = await picker(surface)
  await settleControls(page, surface)
  result.themePicker = await style(surface, '#workspace-theme + .property-trigger')
  result.pickerMenu = await style(surface, `#${await trigger.getAttribute('aria-controls')}`)
  result.pickerOption = await popup.getByRole('option').first().evaluate(node => {
    const style = getComputedStyle(node)
    return {padding:style.padding,minHeight:style.minHeight,fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight}
  })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  return result
}

for (const {width,theme,language} of cases) test(`shared controls match across all three views: ${width}px ${language} ${theme}`, async ({page,context}) => {
  await configure(context, {theme,language})
  const slug = `shared-controls-style-${width}-${Date.now()}`
  await open(page, slug, {mode:'paper',width,theme,language})
  const paper = await controlStyles(page, page, width)
  await page.locator('#open-rebuttal').click()
  const embedded = page.frameLocator('.paper-review-frame')
  await expect(embedded.locator('#response-editor .cm-content')).toBeVisible()
  expect(await controlStyles(page, embedded, width), 'embedded Rebuttal must render the same shared controls as Paper').toEqual(paper)
  const standalonePage = await context.newPage()
  const standalone = await open(standalonePage, slug, {mode:'standalone',width,theme,language})
  expect(await controlStyles(standalonePage, standalone, width), 'standalone Rebuttal must render the same shared controls as Paper').toEqual(paper)
})

async function actionMenuStyles(surface, menuSelector, itemSelector) {
  const {minWidth,minHeight,gap,...overlay} = await style(surface, menuSelector, false)
  overlay.boxShadow = await surface.locator(menuSelector).evaluate(node => getComputedStyle(node).boxShadow)
  return {overlay,item:await style(surface, itemSelector, false)}
}

test('shared action menus skip unavailable items and preserve dismissal through modal and view changes', async ({page,context}) => {
  const settings = {mode:'paper',width:1600,theme:'light',language:'en'}
  const state = await configure(context, settings)
  // An actual running analysis disables analysis actions; file-menu entries
  // hidden for a file target exercise the other unavailable-item case.
  state.jobs.push({id:'synthetic-running-job',round_id:'r1',task:'style',status:'running',stage:'running'})
  await open(page, `shared-action-menus-${Date.now()}`, settings)
  const file = page.locator('.file').filter({hasText:'references.bib'})
  await file.click({button:'right'})
  const tree = page.locator('#tree-menu')
  const first = tree.locator('[data-action="new-file"]')
  await expect(first).toBeFocused()
  await expect(tree.locator('[data-action="new-folder"]')).toBeHidden()
  await expect(tree.locator('[data-action="upload"]')).toBeHidden()
  await page.keyboard.press('ArrowDown')
  await expect(tree.locator('[data-action="rename"]')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(first).toBeFocused()
  await page.keyboard.press('End')
  await expect(tree.locator('[data-action="delete"]')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(first).toBeFocused()
  await settleControls(page, page)
  const paperMenu = await actionMenuStyles(page, '#tree-menu', '#tree-menu [data-action="new-file"]')
  await page.keyboard.press('Escape')
  await expect(tree).toBeHidden()
  await expect(file).toBeFocused()

  await page.locator('#open-rebuttal').click()
  const frame = page.frameLocator('.paper-review-frame')
  const advanced = frame.locator('#review-advanced'), summary = advanced.locator(':scope > summary')
  await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
  await summary.focus()
  await page.keyboard.press('ArrowDown')
  await expect(advanced).toHaveAttribute('open', '')
  const history = advanced.locator('[data-action="response-history"]'), last = advanced.locator('a[href="#evidence"]')
  await expect(advanced.locator('[data-action="analysis"]:disabled')).toHaveCount(5)
  await expect(history).toBeFocused()
  await page.keyboard.press('End')
  await expect(last).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(history).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(last).toBeFocused()
  await page.keyboard.press('Home')
  await expect(history).toBeFocused()
  await settleControls(page, frame)
  expect(await actionMenuStyles(frame, '.response-advanced-popover', '#review-advanced [data-action="response-history"]')).toEqual(paperMenu)
  await page.keyboard.press('Escape')
  await expect(advanced).not.toHaveAttribute('open', '')
  await expect(summary).toBeFocused()

  await summary.click()
  await advanced.locator('[data-action="new-concern"]').click()
  await expect(frame.locator('#form-dialog')).toBeVisible()
  await expect(advanced).not.toHaveAttribute('open', '')
  await frame.locator('#dialog-cancel').click()
  await expect(frame.locator('#form-dialog')).toBeHidden()
  await expect(summary).toBeFocused()
  await summary.click()
  await advanced.locator('[data-action="new-concern"]').click()
  await frame.locator('#dialog-body [name="title"]').fill('Synthetic concern created from the shared menu')
  await frame.locator('#dialog-save').click()
  await expect(frame.locator('#form-dialog')).toBeHidden()
  expect(state.rounds[0].concerns.map(concern => concern.title)).toContain('Synthetic concern created from the shared menu')
  await expect(advanced).not.toHaveAttribute('open', '')

  await summary.click()
  await advanced.locator('a[href="#overview"]').click()
  await expect(frame.locator('.workspace-heading')).toBeVisible()
  await frame.locator('#open-rebuttal').click()
  await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
  await expect(advanced).not.toHaveAttribute('open', '')
})
