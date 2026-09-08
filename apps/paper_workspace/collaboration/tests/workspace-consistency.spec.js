import { test, expect } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-workspace-language', 'ko'))
})

for (const main of ['', '\\documentclass{article}\n% unfinished manuscript']) {
  test(`valid text sources remain editable when the main source is ${main ? 'incomplete' : 'empty'}`, async ({ page }) => {
    const slug = `empty-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await page.route('**/vendor/paper-collab.js*', route => route.abort())
    await page.route(`**/p/${slug}/project/**`, route => {
      const name = new URL(route.request().url()).pathname.split('/project/')[1]
      if (name === 'project.json') return route.fulfill({ json: { id: slug, version: '1', entrypoint: 'main.tex', files: [{ path: 'main.tex', managed: true }, { path: 'empty.tex', managed: true }] } })
      return route.fulfill({ contentType: 'text/plain', body: name === 'main.tex' ? main : '' })
    })
    await page.goto(`/p/${slug}`)
    await page.waitForFunction(() => sharedMetadataReady)
    await expect(page.locator('#editor')).toHaveValue(main)
    await page.locator('[data-file-path="paper/empty.tex"]').click()
    await expect(page.locator('#editor')).toHaveValue('')
    await page.locator('.cm-content').click()
    await page.keyboard.type('new section')
    await expect(page.locator('#editor')).toHaveValue('new section')
  })
}

test('edits made during the pre-restore backup are never overwritten', async ({ page }) => {
  let backupStarted = false
  let releaseBackup
  const backupGate = new Promise(resolve => { releaseBackup = resolve })
  await page.route('**/api/backups/projects/*/snapshots**', async route => {
    if (route.request().method() === 'POST') {
      if (route.request().postDataJSON().reason === 'pre-restore') {
        backupStarted = true
        await backupGate
      }
      return route.fulfill({ status: 201, json: { id: 'protected' } })
    }
    if (new URL(route.request().url()).pathname.endsWith('/old')) {
      return route.fulfill({ json: { payload: { files: { 'paper/main.tex': 'old snapshot' }, comments: [], tasks: [] } } })
    }
    return route.fulfill({ json: { snapshots: [] } })
  })
  await page.goto(`/p/regression-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await page.waitForFunction(() => backupInitialized && !backupBusy)
  await page.evaluate(() => {
    actionDialog = async () => true
    window.pendingRestore = restoreServerBackup('old', document.createElement('button'))
  })
  await expect.poll(() => backupStarted).toBe(true)
  await page.locator('.cm-content').click()
  await page.keyboard.type('preserve this new edit')
  releaseBackup()
  await page.evaluate(() => window.pendingRestore)
  await expect(page.locator('#editor')).toHaveValue(/preserve this new edit/)
  await expect(page.locator('#app-toasts')).toContainText('새 편집 내용이 감지되어')
})

test('a follower tab invalidates its PDF when another tab applied an image revision', async ({ page }) => {
  await page.goto(`/p/regression-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await page.waitForFunction(() => sharedMetadataReady && workspaceReadyForCompile)
  const result = await page.evaluate(async () => {
    clearTimeout(serverSourceRefreshTimer)
    const before = workspaceContentRevision
    const previous = '1'.repeat(64), next = '2'.repeat(64)
    projectManifest = { ...projectManifest, runtime_revision: previous, runtime_file_revisions: { 'image.png': previous }, files: [...projectManifest.files, { path: 'image.png', type: 'asset' }] }
    sharedProject.set('serverRuntimeRevision', next)
    loadProjectManifest = async () => ({ ...projectManifest, runtime_revision: next, runtime_file_revisions: { 'image.png': next } })
    await refreshServerSources()
    return { before, after: workspaceContentRevision }
  })
  expect(result.after).toBeGreaterThan(result.before)
})

for (const sharedEdit of ['shared author edit', '']) {
test(`reload preserves managed shared ${sharedEdit ? 'edits' : 'empty sources'} until server-side runtime reconciliation`, async ({ page }) => {
  const slug = `reload-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let revision = '1'.repeat(64)
  let section = 'section baseline'
  let reconciliationRequested = false
  // Trigger reconciliation after reload; a polling callback can outlive the old document.
  await page.addInitScript(() => { window.__paperServerSourcePollMs = 60_000 })
  await page.route(`**/p/${slug}/project/**`, route => {
    const name = new URL(route.request().url()).pathname.split('/project/')[1]
    if (name === 'project.json') return route.fulfill({ json: { id: slug, version: '1', entrypoint: 'main.tex', runtime_revision: revision, runtime_file_revisions: { 'section.tex': revision }, files: [{ path: 'main.tex', managed: true }, { path: 'section.tex', managed: true }] } })
    return route.fulfill({ contentType: 'text/plain', body: name === 'main.tex' ? '\\documentclass{article}\n\\begin{document}main\\end{document}' : section })
  })
  await page.route('**/collab-runtime/**', route => {
    reconciliationRequested = true
    return route.fulfill({ status: 503, json: { error: 'test pauses server reconciliation' } })
  })
  await page.goto(`/p/${slug}`)
  await page.waitForFunction(() => sharedMetadataReady && collabReady)
  await page.evaluate(sharedEdit => {
    replaceSharedText(collabSession.textFor('paper/section.tex'), sharedEdit)
    state.serverSourceSnapshots['paper/section.tex'] = sourceFingerprint('section baseline')
    save()
  }, sharedEdit)
  section = 'new disk edit'
  revision = '2'.repeat(64)
  await page.reload()
  await page.waitForFunction(() => sharedMetadataReady && collabReady)
  const sourceBeforeReconciliation = await page.evaluate(async () => {
    const source = collabSession.files.get('paper/section.tex').toString()
    await refreshServerSources()
    return source
  })
  expect(reconciliationRequested).toBe(true)
  expect(sourceBeforeReconciliation).toBe(sharedEdit)
  await expect.poll(() => page.evaluate(() => state.files['paper/section.tex'])).toBe(sharedEdit)
})
}

test('the basic editor remains usable when its rich editor bundle is unavailable', async ({ page }) => {
  await page.route('**/vendor/paper-editor.js*', route => route.abort())
  await page.goto(`/p/regression-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await page.waitForFunction(() => sharedMetadataReady)
  await expect(page.locator('#editor')).toBeVisible()
  await expect(page.locator('#editor')).toHaveValue(/\\documentclass/)
  await page.locator('#editor').fill('basic editor draft')
  await page.evaluate(() => richEditor.replaceRange('saved', 0, 5))
  expect(await page.evaluate(() => state.files[state.current])).toBe('saved editor draft')
})

test('file creation controls remain clickable beside the sidebar resizer', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`/p/regression-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await page.waitForFunction(() => sharedMetadataReady)
  await page.locator('#new-file').click()
  await expect(page.locator('#action-dialog-input')).toBeVisible()
})
