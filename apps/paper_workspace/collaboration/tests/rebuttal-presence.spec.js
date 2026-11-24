import { expect, test, namedContext } from './fixtures.js'

const answer = 'Alpha beta gamma delta.\nSecond response line.'
const commonAnswer = 'A common response for every reviewer.'
const nextRoundAnswer = 'A response in the next review round.'
const makeRound = (id, documents) => ({
  id, title: id === 'r1' ? 'First review round' : 'Second review round',
  reviewers: [{id:'reviewer1',name:'Reviewer A'}],
  reviews: [{id:`${id}-review`,reviewer_id:'reviewer1',fields:{review:'Please clarify the comparison.'},translations:{}}],
  documents, imports:[], concerns:[], mappings:[], findings:[], evidence:[], work_items:[],
  rules:[], active_rules_id:null, analyses:[], submissions:[], glossary:{}
})
const metadata = () => ({
  schema_version:1,revision:0,enabled:true,jobs:[],rounds:[
    makeRound('r1', [
      {id:'doc1',title:'Response to Reviewer A',kind:'reviewer',reviewer_id:'reviewer1',text_key:'response:doc1',seed_text:answer},
      {id:'doc2',title:'Common response',kind:'common',reviewer_id:null,text_key:'response:doc2',seed_text:commonAnswer}
    ]),
    makeRound('r2', [{id:'doc3',title:'Second-round response',kind:'reviewer',reviewer_id:'reviewer1',text_key:'response:doc3',seed_text:nextRoundAnswer}])
  ]
})

// Only metadata/history are mocked. Response initialization, shared text and
// awareness travel through the development server's real Yjs WebSocket room.
async function person(browser, name, state, options = {}) {
  const context = await namedContext(browser, options)
  await context.addInitScript(name => {
    localStorage.setItem('collab-name', name)
    localStorage.setItem('collab-name-user-set', '1')
  }, name)
  await context.route('**/api/rebuttal/projects/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/versions')) {
      await route.fulfill({json:{versions:[],saved:true}})
      return
    }
    await route.fulfill({json:structuredClone(state)})
  })
  return {context, page:await context.newPage(), name}
}

async function closePeople(...people) {
  await Promise.all(people.map(({context}) => context.close()))
}

async function editorValue(surface) {
  return surface.locator('#response-editor .cm-content').evaluate(node => {
    const content = node.cloneNode(true)
    content.querySelectorAll('.cm-remoteCaret').forEach(caret => caret.remove())
    return [...content.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')
  })
}

async function openReview(page, slug, round = 'r1') {
  await page.goto(`/p/${slug}/rebuttal?standalone=1&round=${round}&lang=en#reviews`)
  await page.waitForFunction(() => Boolean(window.PaperRebuttalSession))
  await page.evaluate(() => window.PaperRebuttalSession.whenReady)
  await expect(page.locator('#response-editor .cm-content')).toBeVisible()
  const initial = round === 'r1' ? answer : nextRoundAnswer
  await expect.poll(() => editorValue(page)).toBe(initial)
}

async function openPaper(page, slug) {
  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(() => typeof workspaceReadyForCompile !== 'undefined' && workspaceReadyForCompile && collabReady)
  await page.waitForFunction(() => document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
  await expect(page.locator('#editor-view .cm-content')).toBeVisible()
}

async function selectStart(page, content = page.locator('#response-editor .cm-content'), length = 6) {
  await content.click()
  await page.keyboard.press('Control+Home')
  for (let index = 0; index < length; index++) await page.keyboard.press('Shift+ArrowRight')
}

const caret = surface => surface.locator('#response-editor .cm-remoteCaret')
const selection = surface => surface.locator('#response-editor .cm-remoteSelection')
const rosterPerson = (surface, name) => surface.locator('#project-presence #project-presence-list .project-presence-person').filter({hasText:name})
async function openRoster(surface) {
  const menu = surface.locator('#project-presence')
  if (!await menu.evaluate(node => node.open)) await surface.locator('#project-presence-toggle').click()
  await expect(menu).toHaveAttribute('open', '')
  await expect(surface.locator('#project-presence-list')).toBeVisible()
}

async function peerSelection(page, name, key, range) {
  await expect.poll(() => page.evaluate(({name,key}) => {
    const session = window.PaperRebuttalSession || window.PaperWorkspaceSharedSession
    const peer = [...session.provider.awareness.getStates().values()].find(state => state.user?.name === name)
    const text = session.mapFor('rebuttalResponses').get(key)
    return text && session.resolveRange(peer?.rebuttal || {}, text)
  }, {name,key})).toEqual(range)
}

test('remote response selections show names without editing and track relative positions through peer edits', async ({browser}) => {
  const state = metadata(), slug = `response-cursors-${Date.now()}`
  const alice = await person(browser, 'Alice', state), bob = await person(browser, 'Bob', state)
  try {
    await Promise.all([openReview(alice.page, slug), openReview(bob.page, slug)])
    await selectStart(bob.page)
    await expect(caret(alice.page)).toHaveCount(1)
    await expect(caret(alice.page).locator('.cm-remoteCaret-label')).toHaveText('Bob')
    await expect(selection(alice.page)).toHaveText('Alpha ')
    expect(await bob.page.evaluate(() => window.PaperRebuttal.getTexts().doc1)).toBe(answer)
    expect(await bob.page.evaluate(() => window.PaperRebuttal.getSelection())).toEqual({start:0,end:6})

    await alice.page.locator('#response-editor .cm-content').click()
    await alice.page.keyboard.press('Control+Home')
    await alice.page.keyboard.insertText('New ')
    await expect.poll(() => editorValue(bob.page)).toBe(`New ${answer}`)
    await expect(selection(alice.page)).toHaveText('Alpha ')
    await expect.poll(() => alice.page.evaluate(() => {
      const session = window.PaperRebuttalSession
      const peer = [...session.provider.awareness.getStates().values()].find(state => state.user?.name === 'Bob')
      return session.resolveRange(peer?.rebuttal || {}, session.mapFor('rebuttalResponses').get('response:doc1'))
    })).toEqual([4,10])
  } finally { await closePeople(alice, bob) }
})

async function presenceGeometry(surface, viewportWidth) {
  const avatars = surface.locator('#project-presence-avatars .project-presence-avatar')
  const boxes = await Promise.all((await avatars.all()).map(avatar => avatar.boundingBox()))
  const toggle = await surface.locator('#project-presence-toggle').boundingBox()
  return {
    boxes,
    names:await avatars.evaluateAll(nodes => nodes.map(node => node.title)),
    fonts:await avatars.evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node)
      return {size:style.fontSize,family:style.fontFamily,weight:style.fontWeight,lineHeight:style.lineHeight}
    })),
    gap:boxes[1].x - boxes[0].x - boxes[0].width,
    right:viewportWidth - boxes.at(-1).x - boxes.at(-1).width,
    toggle
  }
}

function presenceGeometryDifference(first, second) {
  return Math.max(
    Math.abs(first.gap-second.gap), Math.abs(first.right-second.right),
    ...first.boxes.flatMap((box, index) => ['x','y','width','height'].map(key => Math.abs(box[key]-second.boxes[index][key])))
  )
}

test('shared presence header keeps avatar size spacing and position across Paper and Rebuttal', async ({browser}) => {
  const state = metadata(), slug = `shared-presence-layout-${Date.now()}`
  const alice = await person(browser, 'Alice', state, {reducedMotion:'reduce'}), bob = await person(browser, 'Bob', state), cara = await person(browser, 'Cara', state)
  try {
    await openPaper(alice.page, slug)
    await Promise.all([openReview(bob.page, slug),openReview(cara.page, slug)])
    const frame = alice.page.frameLocator('.paper-review-frame')
    const headerAvatars = '#project-presence-avatars .project-presence-avatar'
    for (const theme of ['light','dark']) {
      await alice.page.locator('#workspace-theme').evaluate((node, value) => {
        node.value = value
        node.dispatchEvent(new Event('change', {bubbles:true}))
      }, theme)
      await expect(alice.page.locator('html')).toHaveAttribute('data-color-scheme', theme)
      await expect(frame.locator('html')).toHaveAttribute('data-color-scheme', theme)
      for (const width of [1600,390,320]) {
        await alice.page.setViewportSize({width,height:900})
        await expect(alice.page.locator(headerAvatars)).toHaveCount(2)
        const paper = await presenceGeometry(alice.page, width)
        expect(paper.names).toEqual(['Bob','Cara'])
        for (const box of paper.boxes) {
          expect(box.width).toBeCloseTo(28, 1)
          expect(box.height).toBeCloseTo(28, 1)
        }
        if (width < 700) {
          expect(paper.toggle.width).toBeGreaterThanOrEqual(44)
          expect(paper.toggle.height).toBeGreaterThanOrEqual(44)
        }
        await alice.page.locator('#open-rebuttal').click()
        await expect(frame.locator('#project-presence')).toBeVisible()
        await expect(frame.locator(headerAvatars)).toHaveCount(2)
        const rebuttal = await presenceGeometry(frame, width)
        await expect.poll(async () => presenceGeometryDifference(paper,await presenceGeometry(frame, width)), {
          message:JSON.stringify({theme,width,paper,rebuttal})
        }).toBeLessThanOrEqual(1)
        expect(rebuttal.names).toEqual(paper.names)
        expect(rebuttal.fonts).toEqual(paper.fonts)
        await openRoster(frame)
        await expect(rosterPerson(frame, 'Alice')).toHaveCount(0)
        await expect(frame.locator('#project-presence-list .project-presence-person')).toHaveCount(2)
        await alice.page.keyboard.press('Escape')
        await frame.locator('#manuscript-link').click()
        await expect(alice.page.locator('#editor-view .cm-content')).toBeVisible()
      }
    }
  } finally { await closePeople(alice, bob, cara) }
})

test('shared presence popup follows peers between Paper and Rebuttal and hides for a solo author', async ({browser}) => {
  const state = metadata(), slug = `shared-presence-follow-${Date.now()}`
  const alice = await person(browser, 'Alice', state), bob = await person(browser, 'Bob', state)
  try {
    await openPaper(alice.page, slug)
    const frame = alice.page.frameLocator('.paper-review-frame')
    await expect(alice.page.locator('#project-presence')).toBeHidden()
    await alice.page.locator('#open-rebuttal').click()
    await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
    await expect(frame.locator('#project-presence')).toBeHidden()
    await frame.locator('#manuscript-link').click()

    await openReview(bob.page, slug)
    await bob.page.locator('#reviewer-nav [data-action="open-document"][data-id="doc2"]').click()
    await selectStart(bob.page)
    await peerSelection(alice.page, 'Bob', 'response:doc2', [0,6])
    await openRoster(alice.page)
    await expect(rosterPerson(alice.page, 'Alice')).toHaveCount(0)
    await expect(rosterPerson(alice.page, 'Bob')).toContainText('Rebuttal')
    await rosterPerson(alice.page, 'Bob').click()
    await expect(alice.page.locator('.paper-review-frame')).toHaveClass(/is-active/)
    await expect.poll(() => editorValue(frame)).toBe(commonAnswer)
    await expect.poll(() => frame.locator('#response-editor').evaluate(() => window.PaperRebuttal.getSelection().end)).toBe(6)

    await openPaper(bob.page, slug)
    await selectStart(bob.page, bob.page.locator('#editor-view .cm-content'), 7)
    await expect.poll(() => alice.page.evaluate(() => {
      const session = window.PaperWorkspaceSharedSession
      const peer = [...session.provider.awareness.getStates().values()].find(state => state.user?.name === 'Bob')
      return peer?.workspace?.surface === 'paper' ? session.resolveCursor(peer.cursor) : null
    })).toEqual([0,7])
    await openRoster(frame)
    await expect(rosterPerson(frame, 'Bob')).toContainText('Paper')
    await rosterPerson(frame, 'Bob').click()
    await expect(alice.page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
    await expect(alice.page.locator('#editor-view .cm-content')).toBeVisible()
    await expect.poll(() => alice.page.evaluate(() => editorSelection().end)).toBe(7)

    await bob.page.close()
    await expect(alice.page.locator('#project-presence')).toBeHidden()
    await alice.page.locator('#open-rebuttal').click()
    await expect(frame.locator('#project-presence')).toBeHidden()
  } finally { await closePeople(alice, bob) }
})

test('project roster follows collaborators across responses and review rounds without leaking their cursors', async ({browser}) => {
  const state = metadata(), slug = `response-follow-${Date.now()}`
  const alice = await person(browser, 'Alice', state), bob = await person(browser, 'Bob', state)
  try {
    await Promise.all([openReview(alice.page, slug), openReview(bob.page, slug)])
    await selectStart(bob.page)
    await expect(caret(alice.page)).toHaveCount(1)
    await bob.page.locator('#reviewer-nav [data-action="open-document"][data-id="doc2"]').click()
    await selectStart(bob.page)
    await expect(caret(alice.page)).toHaveCount(0)
    await expect(alice.page.locator('#response-presence-avatars .project-presence-avatar')).toHaveCount(0)
    await peerSelection(alice.page, 'Bob', 'response:doc2', [0,6])
    await openRoster(alice.page)
    await expect(rosterPerson(alice.page, 'Bob')).toHaveCount(1)
    await rosterPerson(alice.page, 'Bob').click()
    await expect.poll(() => editorValue(alice.page)).toBe(commonAnswer)
    await expect(caret(alice.page).locator('.cm-remoteCaret-label')).toHaveText('Bob')
    await expect(selection(alice.page)).toHaveText(commonAnswer.slice(0,6))
    await expect.poll(() => alice.page.evaluate(() => window.PaperRebuttal.getSelection().end)).toBe(6)

    await openReview(bob.page, slug, 'r2')
    await selectStart(bob.page)
    await expect(caret(alice.page)).toHaveCount(0)
    await peerSelection(alice.page, 'Bob', 'response:doc3', [0,6])
    await openRoster(alice.page)
    await rosterPerson(alice.page, 'Bob').click()
    await expect.poll(() => editorValue(alice.page)).toBe(nextRoundAnswer)
    await expect(caret(alice.page).locator('.cm-remoteCaret-label')).toHaveText('Bob')
    await expect.poll(() => alice.page.evaluate(() => window.PaperRebuttal.getSelection().end)).toBe(6)
  } finally { await closePeople(alice, bob) }
})

test('Paper users appear once in the Rebuttal roster and retained iframe switches clear ghost cursors', async ({browser}) => {
  const state = metadata(), slug = `response-shell-${Date.now()}`
  const alice = await person(browser, 'Alice', state), bob = await person(browser, 'Bob', state)
  try {
    await openReview(alice.page, slug)
    await bob.page.goto(`/p/${slug}?lang=en`)
    await bob.page.waitForFunction(() => typeof workspaceReadyForCompile !== 'undefined' && workspaceReadyForCompile)
    await bob.page.waitForFunction(() => document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
    const frame = bob.page.frameLocator('.paper-review-frame')
    await expect(bob.page.locator('#project-presence')).toBeVisible()
    await expect(bob.page.locator('#project-presence-avatars .project-presence-avatar')).toHaveCount(1)
    await expect(bob.page.locator('#project-presence-avatars .project-presence-avatar')).toHaveAttribute('title',/Alice/)
    await expect(bob.page.locator('#project-presence-toggle')).not.toContainText(/online|명 접속|\+\d/)
    await openRoster(alice.page)
    await expect(rosterPerson(alice.page, 'Bob')).toHaveCount(1)
    await expect(rosterPerson(alice.page, 'Bob')).toContainText('Paper')
    await expect(caret(alice.page)).toHaveCount(0)
    expect(await bob.page.evaluate(() => window.PaperWorkspaceSharedSession === document.querySelector('.paper-review-frame').contentWindow.PaperRebuttalSession)).toBe(true)

    await bob.page.locator('#open-rebuttal').click()
    await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
    await selectStart(bob.page, frame.locator('#response-editor .cm-content'))
    await expect(caret(alice.page)).toHaveCount(1)
    await expect(rosterPerson(alice.page, 'Bob')).toHaveCount(1)
    await expect(rosterPerson(alice.page, 'Bob')).toContainText('Rebuttal')
    await frame.locator('#manuscript-link').click()
    await expect(bob.page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
    await expect(caret(alice.page)).toHaveCount(0)
    await expect(selection(alice.page)).toHaveCount(0)
    await expect(rosterPerson(alice.page, 'Bob')).toHaveCount(1)
    await expect(rosterPerson(alice.page, 'Bob')).toContainText('Paper')
  } finally { await closePeople(alice, bob) }
})

test('hidden users suppress cursors, other projects stay isolated, and disconnect removes presence', async ({browser}) => {
  const state = metadata(), slug = `response-isolation-${Date.now()}`
  const alice = await person(browser, 'Alice', state), bob = await person(browser, 'Bob', state), other = await person(browser, 'Other Project Author', state)
  try {
    await openReview(alice.page, slug)
    await expect(alice.page.locator('#project-presence')).toBeHidden()
    await expect(alice.page.locator('#project-presence-count')).toHaveCount(0)
    await Promise.all([openReview(bob.page, slug), openReview(other.page, `${slug}-other`)])
    await selectStart(bob.page)
    await expect(caret(alice.page)).toHaveCount(1)
    await openRoster(alice.page)
    await expect(rosterPerson(alice.page, 'Alice')).toHaveCount(0)
    await expect(alice.page.locator('#project-presence-avatars .project-presence-avatar')).toHaveCount(1)
    await expect(alice.page.locator('#project-presence-avatars .project-presence-avatar')).toHaveAttribute('title','Bob')
    await expect(rosterPerson(alice.page, 'Bob')).toHaveCount(1)
    await expect(rosterPerson(alice.page, 'Other Project Author')).toHaveCount(0)
    await bob.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {configurable:true,value:'hidden'})
      Object.defineProperty(document, 'hidden', {configurable:true,value:true})
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(caret(alice.page)).toHaveCount(0)
    await expect(selection(alice.page)).toHaveCount(0)
    await bob.page.evaluate(() => {
      delete document.visibilityState
      delete document.hidden
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await selectStart(bob.page)
    await expect(caret(alice.page)).toHaveCount(1)
    await bob.page.close()
    await expect(rosterPerson(alice.page, 'Bob')).toHaveCount(0)
    await expect(caret(alice.page)).toHaveCount(0)
    await expect(selection(alice.page)).toHaveCount(0)
    await expect(rosterPerson(alice.page, 'Other Project Author')).toHaveCount(0)
    await expect(alice.page.locator('#project-presence')).toBeHidden()
  } finally { await closePeople(alice, bob, other) }
})

test('presence roster fits mobile light and dark layouts and closes with Escape or an outside click', async ({browser}) => {
  const state = metadata(), slug = `response-roster-layout-${Date.now()}`
  const alice = await person(browser, 'Alice', state), bob = await person(browser, 'Research collaborator long name', state)
  try {
    await Promise.all([openReview(alice.page, slug), openReview(bob.page, slug)])
    for (const theme of ['light', 'dark']) {
      await alice.page.locator('#workspace-theme').evaluate((node, value) => {
        node.value = value
        node.dispatchEvent(new Event('change', {bubbles:true}))
      }, theme)
      await expect(alice.page.locator('html')).toHaveAttribute('data-color-scheme', theme)
      for (const width of [320,390]) {
        await alice.page.setViewportSize({width,height:900})
        const toggle = alice.page.locator('#project-presence-toggle'), menu = alice.page.locator('#project-presence')
        await toggle.focus()
        await alice.page.keyboard.press('Enter')
        await expect(menu).toHaveAttribute('open', '')
        await expect(rosterPerson(alice.page, bob.name)).toHaveCount(1)
        await expect(alice.page.locator('#project-presence-list')).toBeVisible()
        const bounds = await alice.page.locator('#project-presence-list').boundingBox()
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
        expect(bounds.y).toBeGreaterThanOrEqual(0)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(901)
        expect(await alice.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await alice.page.keyboard.press('Escape')
        await expect(menu).not.toHaveAttribute('open', '')
        await expect(toggle).toBeFocused()
        await toggle.click()
        await expect(menu).toHaveAttribute('open', '')
        await expect(alice.page.locator('#project-presence-list')).toBeVisible()
        await alice.page.locator('#response-editor .cm-content').click()
        await expect(menu).not.toHaveAttribute('open', '')
      }
    }
  } finally { await closePeople(alice, bob) }
})
