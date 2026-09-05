import { expect, test } from '@playwright/test'

test('a delayed fresh client preserves an established dummy manuscript', async ({ browser }) => {
  const room = `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const marker = `% dummy shared manuscript ${room}`
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const [established, fresh] = await Promise.all(contexts.map(context => context.newPage()))

  try {
    await Promise.all([established.goto('/'), fresh.goto('/')])
    await Promise.all([established, fresh].map(page => page.waitForFunction(() => window.PaperCollab?.createSession)))

    await established.evaluate(async ({ room, marker }) => {
      const session = window.PaperCollab.createSession({
        url: 'ws://127.0.0.1:18765', room,
        actor: { id: 'established', name: 'Established', color: '#2457d6' }
      })
      window.__bootstrapEstablished = session
      await session.whenReady
      session.textFor('paper/main.tex').insert(0, marker)
    }, { room, marker })

    const beforeSync = await fresh.evaluate(({ room }) => {
      const session = window.PaperCollab.createSession({
        url: 'ws://127.0.0.1:18765', room,
        actor: { id: 'fresh', name: 'Fresh', color: '#7c3aed' }
      })
      session.provider.disconnect()
      window.__bootstrapFresh = session
      const text = session.textFor('paper/main.tex', '\\documentclass{article}\n% static dummy seed')
      return { hasSharedEntry: session.files.has('paper/main.tex'), provisionalValue: text.toString() }
    }, { room })

    expect(beforeSync.hasSharedEntry).toBe(false)
    expect(beforeSync.provisionalValue).toContain('static dummy seed')
    await fresh.evaluate(() => window.__bootstrapFresh.provider.connect())
    await fresh.evaluate(() => window.__bootstrapFresh.whenReady)
    await expect.poll(() => fresh.evaluate(() => window.__bootstrapFresh.textFor('paper/main.tex').toString()), { timeout: 10_000 }).toBe(marker)
  } finally {
    await Promise.all([established, fresh].map(page => page.evaluate(() => {
      window.__bootstrapEstablished?.destroy()
      window.__bootstrapFresh?.destroy()
    }).catch(() => {})))
    await Promise.all(contexts.map(context => context.close()))
  }
})

for (const inputKind of ['body', 'title']) {
test(`${inputKind} input before initial synchronization survives as a draft without replacing shared source`, async ({ browser }) => {
  const slug = `connecting-draft-${Date.now()}`
  const first = await browser.newContext()
  const second = await browser.newContext()
  try {
    const established = await first.newPage()
    await established.goto(`/p/${slug}`)
    await established.waitForFunction(() => sharedMetadataReady && collabReady)
    await established.evaluate(() => richEditor.replaceRange('\n% established author', editorValue().length, editorValue().length, false))
    const fresh = await second.newPage()
    await fresh.route('**/vendor/paper-collab.js*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      await route.fulfill({ response, body: `${source}\n;{const original=window.PaperCollab;window.PaperCollab={...original,createSession(options){const session=original.createSession(options);session.provider.disconnect();window.resumeInitialSync=()=>session.provider.connect();return session}}}` })
    })
    await fresh.goto(`/p/${slug}`)
    await fresh.waitForFunction(() => editorValue().includes('\\documentclass'))
    const pendingMarker = inputKind === 'body' ? 'pending local edit' : 'Pending local title'
    if (inputKind === 'body') {
      await fresh.locator('.cm-content').click()
      await fresh.keyboard.press('Control+End')
      await fresh.keyboard.type('\n% pending local edit')
    } else {
      await fresh.locator('#project-title').fill(pendingMarker)
      await fresh.locator('#project-title').press('Tab')
    }
    await fresh.evaluate(() => window.resumeInitialSync())
    await fresh.waitForFunction(() => sharedMetadataReady && collabReady)
    const result = await fresh.evaluate(() => ({ source: collabSession.files.get('paper/main.tex').toString(), drafts: Object.entries(state.files).filter(([name]) => name.startsWith('paper/drafts/browser-connect-')).map(([, value]) => value) }))
    expect(result.source).toContain('established author')
    expect(result.source).not.toContain(pendingMarker)
    expect(result.drafts.some(source => source.includes(pendingMarker))).toBe(true)
  } finally { await Promise.all([first.close(), second.close()]) }
})
}
