import { expect, test, namedContext } from './fixtures.js'

const copy = value => structuredClone(value)
function round(id = 'r1') {
  return { id, title: `Round ${id}`, reviewers: [{ id: `${id}-reviewer`, name: `Reviewer ${id}` }],
    reviews: [{ id: `${id}-review`, reviewer_id: `${id}-reviewer`, fields: { summary: 'Please clarify the comparison.' }, translations: {} }],
    documents: [{ id: `${id}-doc`, title: `Response ${id}`, kind: 'reviewer', reviewer_id: `${id}-reviewer`, text_key: `response:${id}-doc`, seed_text: 'We clarify the comparison in the revised manuscript.' }],
    imports: [], concerns: [], mappings: [], findings: [], evidence: [], work_items: [], rules: [], active_rules_id: null, analyses: [], submissions: [], glossary: {} }
}
const snapshot = (revision = 1, rounds = [round()]) => ({ schema_version: 1, revision, enabled: true, jobs: [], rounds })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function mock(context, initial = snapshot()) {
  let state = copy(initial), responder
  await context.route('**/api/rebuttal/projects/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace(/^\/api\/rebuttal\/projects\/[^/]+/, '')
    if (path === '/state') return responder ? responder(route) : route.fulfill({ json: copy(state) })
    if (path.endsWith('/versions')) return route.fulfill({ json: { versions: [] } })
    if (request.method() === 'PUT' && path.startsWith('/rounds/')) {
      const body = request.postDataJSON()
      expect(body.expected_revision).toBe(state.revision)
      state.rounds[state.rounds.findIndex(round => round.id === body.round.id)] = body.round
      state.revision++
      return route.fulfill({ json: copy(state) })
    }
    return route.fulfill({ json: copy(state) })
  })
  return { set(value) { state = copy(value) }, respond(value) { responder = value }, get: () => copy(state) }
}
async function open(page, slug, screen = 'reviews') {
  await page.goto(`/p/${slug}/rebuttal?standalone=1&round=r1&lang=en#${screen}`)
  await page.waitForFunction(() => window.PaperRebuttal?.getState().rounds.length && window.PaperRebuttalSession?.provider?.synced)
  if (screen === 'reviews') await expect(page.locator('#response-editor .cm-content')).toBeVisible()
}
async function roundOption(surface, id) {
  // The round picker is deliberately hidden by the product design. Exercise its
  // native change handler here; the presence test below uses the visible UI.
  await surface.locator('#round-select').selectOption(id, { force: true })
  await expect(surface.locator('#round-select')).toHaveValue(id)
}
async function embedded(page) {
  await page.goto('/p/example-paper/rebuttal?round=r1&lang=en')
  const frame = page.frameLocator('.paper-review-frame')
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
  return frame
}

test('refresh safely restores replaced disclosure focus and skips controls without a replacement', async ({ page, context }) => {
  await mock(context)
  await open(page, `focus-regression-${Date.now()}`)
  for (const selector of ['.sidebar-advanced > summary', '#review-advanced > summary']) {
    await page.locator(selector).focus()
    const result = await page.evaluate(async () => { try { await window.PaperRebuttal.refresh(); return 'ok' } catch (error) { return error.message } })
    expect(result).toBe('ok')
    await expect(page.locator(selector)).toBeFocused()
  }
  if(!await page.locator('.sidebar-advanced').evaluate(node=>node.open))await page.locator('.sidebar-advanced > summary').click()
  await page.locator('[data-screen="submission"]').click()
  await page.locator('#main details > summary').first().focus()
  expect(await page.evaluate(async () => { try { await window.PaperRebuttal.refresh(); return 'ok' } catch (error) { return error.message } })).toBe('ok')
  await expect(page.locator('#freeze-submission')).toBeVisible()
})

test('late refresh cannot undo a saved mutation or discard an open form', async ({ page, context }) => {
  const api = await mock(context)
  await open(page, `mutation-order-${Date.now()}`, 'evidence')
  const seen = deferred(), release = deferred(), stale = api.get()
  api.respond(async route => { seen.resolve(); await release.promise; await route.fulfill({ json: stale }) })
  await page.evaluate(() => { window.oldRefresh = window.PaperRebuttal.refresh() })
  await seen.promise
  await page.locator('[data-action="new-work"]').click()
  await page.locator('[name="title"]').fill('Saved experiment')
  await page.locator('#dialog-save').click()
  await expect(page.locator('#form-dialog')).not.toBeVisible()
  await expect(page.locator('#main')).toContainText('Saved experiment')
  await page.locator('[data-action="new-work"]').click()
  await page.locator('[name="title"]').fill('Unsaved next experiment')
  release.resolve(); await page.evaluate(() => window.oldRefresh)
  expect(await page.evaluate(() => window.PaperRebuttal.getState().revision)).toBe(2)
  await expect(page.locator('[name="title"]')).toHaveValue('Unsaved next experiment')
  await expect(page.locator('#main')).toContainText('Saved experiment')
})

test('response revision outranks request order and refresh preserves editor selection', async ({ page, context }) => {
  const api = await mock(context)
  await open(page, `revision-order-${Date.now()}`)
  await page.locator('#response-editor .cm-content').click()
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowRight')
  const selection = await page.evaluate(() => window.PaperRebuttal.getSelection())
  const seen = deferred(), release = deferred(); let count = 0
  api.respond(async route => { if (++count === 1) { seen.resolve(); await release.promise; return route.fulfill({ json: snapshot(4) }) } return route.fulfill({ json: snapshot(3) }) })
  await page.evaluate(() => { window.oldRefresh = window.PaperRebuttal.refresh() })
  await seen.promise
  await page.evaluate(() => window.PaperRebuttal.refresh())
  expect(await page.evaluate(() => window.PaperRebuttal.getState().revision)).toBe(3)
  release.resolve(); await page.evaluate(() => window.oldRefresh)
  expect(await page.evaluate(() => window.PaperRebuttal.getState().revision)).toBe(4)
  expect(await page.evaluate(() => window.PaperRebuttal.getSelection())).toEqual(selection)
  await expect(page.locator('#response-editor .cm-content')).toBeFocused()
})

test('an older same-revision poll cannot restore outdated jobs or schedule a deferred rerender', async ({ page, context }) => {
  await page.clock.install()
  const api = await mock(context)
  await open(page, `poll-order-${Date.now()}`)
  const seen = deferred(), release = deferred(), finished = deferred(); let count = 0
  const stale = snapshot(2); stale.jobs = [{ id: 'job1', round_id: 'r1', task: 'style', status: 'running' }]
  const current = snapshot(2); current.jobs = [{ ...stale.jobs[0], status: 'completed' }]
  api.respond(async route => {
    if (++count === 1) { seen.resolve(); await release.promise; await route.fulfill({ json: stale }); finished.resolve(); return }
    return route.fulfill({ json: current })
  })
  await page.locator('#response-editor .cm-content').focus()
  await page.clock.runFor(5100); await seen.promise
  await page.evaluate(() => window.PaperRebuttal.refresh())
  await page.evaluate(() => { window.beforePollMain = document.querySelector('#mapping-workspace') })
  release.resolve(); await finished.promise
  await page.clock.runFor(100)
  await page.locator('.sidebar-advanced > summary').focus(); await page.clock.runFor(100)
  expect(await page.evaluate(() => window.PaperRebuttal.getState().jobs[0].status)).toBe('completed')
  expect(await page.evaluate(() => window.beforePollMain === document.querySelector('#mapping-workspace'))).toBe(true)
})

test('embedded round selection preserves the shared URL through Paper, history, and reload', async ({ page, context }) => {
  await mock(context, snapshot(1, [round(), round('r2')]))
  let frame = await embedded(page)
  await roundOption(frame, 'r2')
  await expect(page).toHaveURL(/\/rebuttal\?.*round=r2/)
  expect(new URL(page.url()).searchParams.has('embedded')).toBe(false)
  await frame.locator('#manuscript-link').click()
  await expect(page).toHaveURL(/\/p\/example-paper\?lang=en$/)
  await page.locator('#open-rebuttal').click()
  await expect(page).toHaveURL(/round=r2/)
  await expect(frame.locator('#round-select')).toHaveValue('r2')
  await page.goBack(); await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
  await page.goBack(); await expect(page).toHaveURL(/round=r2/)
  await expect(frame.locator('#round-select')).toHaveValue('r2')
  await page.goBack(); await expect(page).toHaveURL(/round=r1/)
  await expect(frame.locator('#round-select')).toHaveValue('r1')
  await page.goForward(); await expect(page).toHaveURL(/round=r2/)
  await expect(frame.locator('#round-select')).toHaveValue('r2')
  await page.reload(); frame = page.frameLocator('.paper-review-frame')
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(frame.locator('#round-select')).toHaveValue('r2')
})

test('following another round updates its share URL while hidden preload and untrusted sources cannot change Paper', async ({ page, context, browser }) => {
  const state = snapshot(1, [round(), round('r2')]); await mock(context, state)
  const peerContext = await namedContext(browser)
  await peerContext.addInitScript(() => { localStorage.setItem('collab-id', 'other-round-author'); localStorage.setItem('collab-name', 'Other Round Author') })
  await mock(peerContext, state)
  const peer = await peerContext.newPage()
  try {
    await peer.goto('/p/example-paper/rebuttal?standalone=1&round=r2&lang=en')
    await expect(peer.locator('#response-editor .cm-content')).toBeVisible()
    await page.goto('/p/example-paper?lang=en')
    let frame = page.frameLocator('.paper-review-frame')
    await expect(frame.locator('#round-select')).toHaveValue('r1')
    const paperURL = page.url()
    await page.evaluate(() => window.PaperWorkspaceReviewLocation?.(window, `${location.origin}/p/example-paper/rebuttal?round=r2`, true))
    expect(page.url()).toBe(paperURL)
    await frame.locator('#round-select').selectOption('r2', { force: true })
    expect(page.url()).toBe(paperURL)
    await frame.locator('#round-select').selectOption('r1', { force: true })
    await page.locator('#open-rebuttal').click()
    await frame.locator('#project-presence-toggle').click()
    const person = frame.locator('.project-presence-person').filter({ hasText: 'Other Round Author' })
    await expect(person).toContainText('Round r2')
    await person.click()
    await expect(frame.locator('#round-select')).toHaveValue('r2')
    await expect(page).toHaveURL(/round=r2/)
    await page.goBack(); await expect(page).toHaveURL(/round=r1/)
    await expect(frame.locator('#round-select')).toHaveValue('r1')
    await page.goForward(); await expect(page).toHaveURL(/round=r2/)
    await expect(frame.locator('#round-select')).toHaveValue('r2')
    await page.reload(); frame = page.frameLocator('.paper-review-frame')
    await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
    await expect(frame.locator('#round-select')).toHaveValue('r2')
    await frame.locator('#manuscript-link').click()
    await page.locator('#open-rebuttal').click()
    await expect(page).toHaveURL(/round=r2/)
    await expect(frame.locator('#round-select')).toHaveValue('r2')
  } finally { await peerContext.close() }
})

test('simultaneous first standalone tabs and a later Paper share one saved identity and exclude their own tabs', async ({ context }) => {
  await mock(context)
  const pages = [await context.newPage(), await context.newPage()], slug = `identity-regression-${Date.now()}`
  await Promise.all(pages.map(page => open(page, slug)))
  const saved = await pages[0].evaluate(() => localStorage.getItem('collab-id'))
  expect(saved).toBeTruthy()
  for (const page of pages) {
    await expect.poll(() => page.evaluate(() => window.PaperRebuttal.session.provider.awareness.getLocalState().user.id)).toBe(saved)
    await expect(page.locator('#project-presence-root')).toBeHidden()
    await expect(page.locator('#review-collaborators')).toBeHidden()
  }
  const paper = await context.newPage()
  await paper.goto(`/p/${slug}?lang=en`)
  await paper.waitForFunction(() => window.PaperWorkspaceSharedSession?.provider?.synced)
  expect(await paper.evaluate(() => window.PaperWorkspaceSharedSession.provider.awareness.getLocalState().user.id)).toBe(saved)
  await expect(paper.locator('#project-presence-root')).toBeHidden()
  await paper.locator('#open-rebuttal').click()
  await expect(paper.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(paper.frameLocator('.paper-review-frame').locator('#project-presence-root')).toBeHidden()
})

test('rapid resize keys accumulate model widths while pointer drag starts from actual geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 })
  await page.addInitScript(() => localStorage.setItem('paper-workspace-layout', JSON.stringify({ editorWidth: 600, assistantWidth: 300, assistantCollapsed: false, sidebarWidth: 244, sidebarCollapsed: false, editorZoom: 0.8, pdfZoom: 0.6 })))
  await page.goto('/?lang=en')
  await expect(page.locator('#editor-zoom-value')).toHaveText('80%')
  const editor = page.locator('[data-resize="editor-preview"]'), stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('paper-workspace-layout')))
  const initial = await editor.evaluate(node => Number(node.getAttribute('aria-valuenow')))
  await editor.evaluate(node => { for (let i = 0; i < 6; i++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  expect((await stored()).editorWidth).toBe(initial - 6 * 24)
  const assistant = page.locator('[data-resize="preview-assistant"]')
  await assistant.evaluate(node => { for (let i = 0; i < 3; i++) node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
  expect((await stored()).assistantWidth).toBe(372)
  await assistant.press('Home'); expect((await stored()).assistantWidth).toBe(240)
  await assistant.press('End'); expect((await stored()).assistantWidth).toBe(Number(await assistant.getAttribute('aria-valuemax')))
  await editor.press('Home'); expect((await stored()).editorWidth).toBe(390)
  await editor.press('End'); expect((await stored()).editorWidth).toBe(Number(await editor.getAttribute('aria-valuemax')))
  const preferences = await stored()
  expect(preferences.editorZoom).toBe(0.8); expect(preferences.pdfZoom).toBe(0.6)
  expect(preferences.sidebarWidth).toBe(244); expect(preferences.assistantCollapsed).toBe(false)
  // Finish the preceding End transition before starting a fresh transition.
  await expect.poll(() => page.locator('#editor-panel').evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(Math.round(preferences.editorWidth))
  const transition = await editor.evaluate(node => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    const animation = document.querySelector('.workspace').getAnimations().find(animation => animation.transitionProperty === 'grid-template-columns')
    if (!animation) throw new Error('The resize transition did not start')
    animation.pause(); animation.currentTime = animation.effect.getTiming().duration / 2
    const actualWidth = document.querySelector('#editor-panel').getBoundingClientRect().width
    const modelWidth = JSON.parse(localStorage.getItem('paper-workspace-layout')).editorWidth
    node.addEventListener('pointerdown', () => { window.dragStartWidth = document.querySelector('#editor-panel').getBoundingClientRect().width }, { capture: true, once: true })
    return { actualWidth, modelWidth }
  })
  expect(transition.actualWidth).toBeGreaterThan(transition.modelWidth)
  expect(transition.actualWidth).toBeLessThan(preferences.editorWidth)
  const start = await editor.evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.x + 3, y: rect.y + 120 } })
  await page.mouse.move(start.x, start.y); await page.mouse.down()
  const actual = await page.evaluate(() => window.dragStartWidth)
  expect(actual).toBeCloseTo(transition.actualWidth, 1)
  await page.mouse.move(start.x + 48, start.y); await page.mouse.up()
  expect(Math.abs((await stored()).editorWidth - (actual + 48))).toBeLessThan(3)
})

for (const latest of ['paper', 'explicit-paper', 'review']) {
  test(`delayed response initialization respects the latest ${latest} navigation after rapid history changes`, async ({ page, context }) => {
    await mock(context, snapshot(1, [round(), round('r2')]))
    const requested = deferred(), release = deferred()
    await context.route('**/collab-runtime/*?response-init=1', async route => {
      requested.resolve()
      await release.promise
      await route.continue()
    })
    const slug = `navigation-init-${latest}-${Date.now()}`
    try {
      await page.goto(`/p/${slug}?lang=en`)
      const frame = page.frameLocator('.paper-review-frame')
      await expect(frame.locator('#round-select')).toBeAttached()
      await requested.promise
      await page.locator('#open-rebuttal').click()
      await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
      await roundOption(frame, 'r2')
      await page.goBack()
      await expect(page).toHaveURL(/round=r1/)
      await page.goBack()
      await expect(page).toHaveURL(new RegExp(`/p/${slug}\\?lang=en$`))
      await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
      if (latest !== 'paper') {
        // Forward starts another pending navigation while the response seed is
        // still unavailable; an explicit view change must also supersede it.
        await page.goForward()
        await expect(page).toHaveURL(/round=r1/)
        if (latest === 'explicit-paper') {
          await page.locator('#open-rebuttal').click()
          await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
          await frame.locator('#manuscript-link').click()
          await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
        }
      }
      const expectedURL = page.url()
      release.resolve()
      await expect(frame.locator('#response-editor .cm-content')).toBeAttached()
      // Initialization resolves queued text binders and popstate continuations
      // in microtasks. Sample the rendered state after they have all completed.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(page.url()).toBe(expectedURL)
      const review = latest === 'review'
      expect(await page.locator('.paper-review-frame').evaluate(node => node.classList.contains('is-active'))).toBe(review)
      expect(await page.locator('.shell').evaluate(node => node.inert)).toBe(review)
      await expect(frame.locator('#round-select')).toHaveValue('r1')
    } finally { release.resolve() }
  })
}
