import { test, expect, namedContext } from './fixtures.js'

test('backup restore applies comments, tasks, and manuscript together', async ({ page }) => {
  const source = '\\documentclass{article}\n\\begin{document}restored\\end{document}'
  const task = { id: 'restored-task', title: 'Restored task', done: false }
  const comment = { id: 'restored-comment', text: 'Restored comment', revision: 1, file: 'paper/main.tex' }
  await page.route('**/api/backups/projects/*/snapshots**', route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: 'protected' } })
    if (new URL(route.request().url()).pathname.endsWith('/restore-1')) return route.fulfill({ json: { payload: { files: { 'paper/main.tex': source }, comments: [comment], tasks: [task] } } })
    return route.fulfill({ json: { snapshots: [] } })
  })
  await page.goto(`/p/restore-metadata-${Date.now()}`)
  await page.waitForFunction(() => sharedMetadataReady && backupInitialized && !backupBusy)
  await page.evaluate(async () => {
    sharedTasks.set('current-task', { id: 'current-task', title: 'Current task', done: false })
    sharedComments.set('current-comment', { id: 'current-comment', text: 'Current comment', revision: 2 })
    actionDialog = async () => true
    await restoreServerBackup('restore-1', document.createElement('button'))
  })
  const restored = await page.evaluate(() => ({ source: editorValue(), tasks: state.tasks, sharedTasks: [...sharedTasks.values()], comments: [...sharedComments.values()] }))
  expect(restored).toEqual({ source, tasks: [task], sharedTasks: [task], comments: [comment] })
})

for (const withRuntime of [false, true]) {
  test(`resolved metadata stays deleted when a stale browser joins an established ${withRuntime ? 'runtime' : 'legacy'} room`, async ({ browser, page }) => {
    const slug = `stale-metadata-${withRuntime}-${Date.now()}`
    await page.goto(`/p/${slug}`)
    await page.waitForFunction(() => sharedMetadataReady && collabReady)
    await page.evaluate(withRuntime => {
      if (withRuntime) {
        sharedProject.set('serverRuntimeRevision', '1'.repeat(64))
        sharedProject.delete('metadataInitialized')
      }
      sharedComments.clear()
      sharedTasks.clear()
    }, withRuntime)
    const context = await namedContext(browser)
    try {
      await context.addInitScript(slug => {
        localStorage.setItem(`paper-workspace:${slug}`, JSON.stringify({ fileTreeVersion: 1, files: { 'paper/main.tex': '\\documentclass{article}\n\\begin{document}stale browser\\end{document}' }, folders: ['paper'], current: 'paper/main.tex', comments: [{ id: 'resolved-elsewhere', text: 'Stale comment', revision: 1 }], tasks: [{ id: 'deleted-elsewhere', title: 'Stale task', done: false }] }))
      }, slug)
      const stale = await context.newPage()
      await stale.goto(`/p/${slug}`)
      await stale.waitForFunction(() => sharedMetadataReady && collabReady)
      expect(await stale.evaluate(() => ({ comments: sharedComments.size, tasks: sharedTasks.size, localComments: state.comments.length, localTasks: state.tasks.length }))).toEqual({ comments: 0, tasks: 0, localComments: 0, localTasks: 0 })
      expect(await page.evaluate(() => ({ comments: sharedComments.size, tasks: sharedTasks.size }))).toEqual({ comments: 0, tasks: 0 })
    } finally { await context.close() }
  })
}
