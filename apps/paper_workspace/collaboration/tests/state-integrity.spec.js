import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.js'

const manuscript = '\\documentclass{article}\n\\title{State integrity}\n\\begin{document}\nCurrent manuscript\n\\end{document}\n'

async function openProject(page) {
  const slug = `integrity-${randomUUID()}`
  await page.route(`**/p/${slug}/project/**`, route => {
    const path = new URL(route.request().url()).pathname.split('/project/')[1]
    return route.fulfill(path === 'project.json' ? {
      contentType: 'application/json',
      body: JSON.stringify({ id: slug, version: '1', entrypoint: 'main.tex', files: [{ path: 'main.tex', managed: true }] })
    } : { contentType: 'text/plain', body: manuscript })
  })
  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(() => sharedMetadataReady && workspaceReadyForCompile && collabReady)
  return slug
}

test('imports reserve empty files, numbered copies, and folder paths', async ({ page }) => {
  await openProject(page)
  const result = await page.evaluate(async () => {
    state.files['paper/empty.tex'] = ''
    state.files['paper/empty (2).tex'] = ''
    state.folders.push('paper/empty (3).tex')
    publishSharedTree()
    await importLocalFiles([{ file: new File(['imported'], 'empty.tex', { type: 'text/plain' }) }])
    return {
      original: state.files['paper/empty.tex'],
      numbered: state.files['paper/empty (2).tex'],
      folderBecameFile: Object.hasOwn(state.files, 'paper/empty (3).tex'),
      imported: state.files['paper/empty (4).tex']
    }
  })
  expect(result).toEqual({ original: '', numbered: '', folderBecameFile: false, imported: 'imported' })
})

test('file creation, folder creation, and rename reject existing empty files', async ({ page }) => {
  await openProject(page)
  const result = await page.evaluate(async () => {
    state.files['paper/empty.tex'] = ''
    state.files['paper/folder-target.tex'] = ''
    state.files['paper/rename-target.tex'] = ''
    publishSharedTree()
    actionDialog = async () => 'empty.tex'
    await createFile('paper')
    actionDialog = async () => 'folder-target.tex'
    await createFolder('paper')
    return {
      original: state.files['paper/empty.tex'],
      folderCreated: state.folders.includes('paper/folder-target.tex'),
      renameCollision: renameHasCollision('file', 'paper/other.tex', 'paper/rename-target.tex')
    }
  })
  expect(result).toEqual({ original: '', folderCreated: false, renameCollision: true })
})

test('deleting an unrelated file keeps an empty active file selected', async ({ page }) => {
  await openProject(page)
  const result = await page.evaluate(async () => {
    state.files['paper/empty.tex'] = ''
    state.files['paper/remove.tex'] = 'remove me'
    state.current = 'paper/empty.tex'
    setEditor()
    actionDialog = async () => true
    await deleteTarget('file', 'paper/remove.tex')
    return { current: state.current, editor: editorValue(), removed: Object.hasOwn(state.files, 'paper/remove.tex') }
  })
  expect(result).toEqual({ current: 'paper/empty.tex', editor: '', removed: false })
})

test('backup restore publishes manuscript, comments, tasks, and folders together', async ({ page }) => {
  const snapshot = {
    title: 'Restored paper',
    files: { 'paper/main.tex': manuscript.replace('Current manuscript', 'Restored manuscript'), 'paper/sections/restored.tex': 'Restored section' },
    comments: [{ id: 'restored-comment', body: 'Restored comment', file: 'paper/main.tex', revision: 1, anchor: '\\documentclass', start: 0, end: 14 }],
    tasks: [{ id: 'restored-task', title: 'Restored task', done: false, file: 'paper/sections/restored.tex' }]
  }
  await page.route('**/api/backups/projects/*/snapshots**', route => {
    const request = route.request()
    const payload = request.method() === 'POST'
      ? { snapshot: { id: 'protected', created_at: new Date().toISOString() } }
      : new URL(request.url()).pathname.endsWith('/restore-test') ? { payload: snapshot } : { snapshots: [] }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) })
  })
  await openProject(page)
  await page.waitForFunction(() => backupInitialized && !backupBusy)
  const result = await page.evaluate(async () => {
    sharedTasks.set('current-task', { id: 'current-task', title: 'Current task', done: false })
    actionDialog = async () => true
    await restoreServerBackup('restore-test', document.createElement('button'))
    return {
      files: Object.fromEntries([...collabSession.files].map(([path, text]) => [path, text.toString()])),
      comments: [...sharedComments.values()],
      tasks: [...sharedTasks.values()],
      folders: [...sharedFolders.keys()],
      currentSource: editorValue()
    }
  })
  expect(result.files).toEqual(snapshot.files)
  expect(result.comments).toEqual(snapshot.comments)
  expect(result.tasks).toEqual(snapshot.tasks)
  expect(result.folders).toContain('paper/sections')
  expect(result.currentSource).toBe(snapshot.files['paper/main.tex'])
})

test('malformed backup review entries are rejected before applying a restore', async ({ page }) => {
  await openProject(page)
  const rejected = await page.evaluate(() => {
    const files = { 'paper/main.tex': 'replacement' }
    const invalid = [
      { files, comments: [null] },
      { files, comments: [{ file: 'paper/main.tex', body: 'Missing anchor' }] },
      { files, tasks: [null] },
      { files, tasks: [{ id: 'task', title: { invalid: true } }] }
    ]
    return invalid.map(snapshot => {
      try { validateBackupSnapshot(snapshot); return false } catch { return true }
    })
  })
  expect(rejected).toEqual([true, true, true, true])
})

test('runtime adoption schedules changed compile inputs without missing globals', async ({ page }) => {
  await openProject(page)
  const result = await page.evaluate(() => {
    const before = workspaceContentRevision
    let error = ''
    try {
      adoptServerManifest(projectManifest, {}, { changedPaths: ['paper/Figures/plot.pdf'], scheduleCompile: true })
    } catch (failure) { error = failure.message }
    return { error, scheduled: workspaceContentRevision > before }
  })
  expect(result).toEqual({ error: '', scheduled: true })
})

test('a peer runtime revision recompiles changed assets after adopting the manifest', async ({ page }) => {
  const slug = await openProject(page)
  await page.route(`**/p/${slug}/project/project.json`, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      id: slug, version: '1', entrypoint: 'main.tex',
      files: [{ path: 'main.tex', managed: true }, { path: 'Figures/plot.pdf', type: 'asset' }],
      runtime_revision: '2'.repeat(64), runtime_file_revisions: { 'Figures/plot.pdf': 'b'.repeat(64) }
    })
  }))
  const result = await page.evaluate(async () => {
    clearTimeout(serverSourceRefreshTimer)
    projectManifest.runtime_revision = '1'.repeat(64)
    sharedProject.set('serverRuntimeRevision', '2'.repeat(64))
    const before = workspaceContentRevision
    const refreshed = await refreshServerSources()
    return { refreshed, scheduled: workspaceContentRevision > before, revision: projectManifest.runtime_revision }
  })
  expect(result).toEqual({ refreshed: true, scheduled: true, revision: '2'.repeat(64) })
})

test('hub retains review counts after IndexedDB persistence', async ({ page }) => {
  const slug = await openProject(page)
  await page.evaluate(() => {
    sharedComments.set('comment', { id: 'comment', body: 'Review note', file: 'paper/main.tex', revision: 1, anchor: '\\documentclass', start: 0, end: 14 })
    sharedTasks.set('open', { id: 'open', title: 'Open task', done: false })
    sharedTasks.set('closed', { id: 'closed', title: 'Closed task', done: true })
    save()
  })
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ projects: [{ slug, display_name: 'Review counts' }] })
  }))
  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-card')).toContainText('1 comment')
  await expect(page.locator('.project-card')).toContainText('1 open task')
})

for (const failure of ['malformed', 'http', 'network']) {
test(`an optional ${failure} activity response keeps the project catalog and reports the unavailable activity state`, async ({ page }) => {
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ projects: [{ slug: 'available', display_name: 'Available paper' }] })
  }))
  await page.route('**/api/backups/activity', route => {
    if (failure === 'network') return route.abort('failed')
    if (failure === 'http') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) })
    return route.fulfill({ contentType: 'text/html', body: '<html>temporarily unavailable</html>' })
  })
  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-card')).toContainText('Available paper')
  await expect(page.locator('#project-list')).toHaveAttribute('data-activity-status', 'unavailable')
  await expect(page.locator('.project-activity')).toHaveText('Activity details are temporarily unavailable')
})
}

test('activity fallback labels browser-only activity when the activity service is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('collab-name', 'Local Author')
    localStorage.setItem('collab-name-user-set', '1')
    localStorage.setItem('paper-workspace:last-active:available', String(Date.now()))
  })
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ projects: [{ slug: 'available', display_name: 'Available paper' }] })
  }))
  await page.route('**/api/backups/activity', route => route.abort('failed'))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-activity')).toContainText('Local browser activity')
  await expect(page.locator('.project-activity')).toContainText('Local Author')
})

test('corrupt local metadata cannot suppress authoritative project activity', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-workspace:available', '{broken'))
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ projects: [{ slug: 'available', display_name: 'Available paper' }] })
  }))
  await page.route('**/api/backups/activity', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ projects: [{ project_id: 'available', actor: 'Reviewer', modified_at: '2026-09-01T00:00:00Z' }] })
  }))
  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-activity')).toContainText('Last edited by Reviewer')
})
