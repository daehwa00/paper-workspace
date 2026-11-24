import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures.js'

async function openWorkspace(page) {
  await page.goto('/?lang=en')
  await page.waitForFunction(() => workspaceReadyForCompile && sharedMetadataReady)
}

test('backup reserves its slot before refreshing rebuttal and releases it on failure', async ({ page }) => {
  await openWorkspace(page)
  const result = await page.evaluate(async () => {
    await backupIdlePromise
    actor.name = 'Backup tester'
    let rejectRefresh, calls = 0
    rebuttalBackup = () => ({
      refresh() {
        calls += 1
        return new Promise((_, reject) => { rejectRefresh = reject })
      }
    })
    const pending = createServerBackup('manual', { quiet: true })
    const concurrent = await createServerBackup('manual', { quiet: true })
    rejectRefresh(new Error('Network failure'))
    return { calls, concurrent, completed: await pending, busy: backupBusy, disabled: $('create-backup').disabled }
  })
  expect(result).toEqual({ calls: 1, concurrent: false, completed: false, busy: false, disabled: false })
})

test('restore aborts when a shared manuscript edit arrives during rebuttal restore', async ({ page }) => {
  await page.route('**/api/backups/projects/*/snapshots**', route => {
    const pathname = new URL(route.request().url()).pathname
    return route.fulfill({ json: pathname.endsWith('/guard-test')
      ? { payload: { files: { 'paper/main.tex': 'Restored manuscript' }, comments: [], tasks: [] } }
      : { snapshots: [] } })
  })
  await openWorkspace(page)
  await page.waitForFunction(() => collabSession.files.has('paper/main.tex'))
  const actual = await page.evaluate(async () => {
    await backupIdlePromise
    actor.name = 'Backup tester'
    actionDialog = async () => true
    rebuttalBackup = () => ({
      refresh: async () => {},
      snapshot: () => null,
      restore: async () => {
        const text = collabSession.files.get('paper/main.tex')
        collabSession.document.transact(() => text.insert(text.length, '\n% Peer edit'), 'peer')
      }
    })
    const button = document.createElement('button')
    await restoreServerBackup('guard-test', button)
    return { source: editorValue(), status: $('backup-status').textContent, disabled: button.disabled }
  })
  expect(actual.source).toContain('% Peer edit')
  expect(actual.source).not.toContain('Restored manuscript')
  expect(actual.status).toContain('복원 중 새 편집 내용이 감지되어')
  expect(actual.disabled).toBe(false)
})

test('watchdog discards a response that completes after workspace initialization', async ({ page }) => {
  const watchdogRequests = []
  await page.route('**/app.js?*', route => route.abort())
  await page.route('**/project/project.json', route => new Promise(resolve => watchdogRequests.push(() => resolve(route.fulfill({ json: { entrypoint: 'main.tex', files: [] } })))))
  await page.goto('/')
  await expect.poll(() => watchdogRequests.length, { timeout: 8000 }).toBe(1)
  await page.evaluate(() => {
    window.__paperMarkStartupReady()
    document.getElementById('editor').value = 'Active notes without a documentclass'
  })
  const manuscriptRequests = []
  await page.route('**/project/main.tex', route => {
    manuscriptRequests.push(route.request().url())
    return route.fulfill({ body: '\\documentclass{article}' })
  })
  await watchdogRequests[0]()
  await page.waitForLoadState('networkidle')
  expect(manuscriptRequests).toEqual([])
  await expect(page.locator('#editor')).toHaveValue('Active notes without a documentclass')
  await expect(page.locator('#editor-panel')).not.toHaveClass(/legacy-editor/)
})

test('a stale tab cannot replace a newer IndexedDB workspace record', async ({ page, context }) => {
  await openWorkspace(page)
  const second = await context.newPage()
  await openWorkspace(second)
  const name = `race-${randomUUID()}`
  await page.evaluate(async name => {
    window.stateRaceStore = PaperWorkspaceStorage.workspaceStateStore(name)
    await stateRaceStore.put('project', { text: 'initial' }, 100)
  }, name)
  const observed = await second.evaluate(async name => {
    window.stateRaceStore = PaperWorkspaceStorage.workspaceStateStore(name)
    return (await stateRaceStore.get('project')).savedAt
  }, name)
  const updated = await page.evaluate(() => stateRaceStore.put('project', { text: 'new tab' }, 200, 100))
  const rejected = await second.evaluate(observed => stateRaceStore.put('project', { text: 'stale tab' }, 300, observed), observed)
  expect(updated).toBe(true)
  expect(rejected).toBe(false)
  expect(await page.evaluate(() => stateRaceStore.get('project'))).toEqual({
    project: 'project', savedAt: 200, state: { text: 'new tab' }
  })
})

test('persisted page navigation keeps the editor and shared session alive', async ({ page }) => {
  await openWorkspace(page)
  const actual = await page.evaluate(() => {
    const session = window.PaperWorkspaceSharedSession
    const editor = richEditor
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    editor.replaceRange('\n% restored page', editor.getValue().length, editor.getValue().length)
    return {
      sameSession: session === window.PaperWorkspaceSharedSession,
      sameEditor: editor === richEditor,
      editorText: editor.getValue(),
      sharedText: collabSession.textFor(state.current).toString()
    }
  })
  expect(actual.sameSession).toBe(true)
  expect(actual.sameEditor).toBe(true)
  expect(actual.editorText).toContain('% restored page')
  expect(actual.sharedText).toContain('% restored page')
})

test('hub keeps valid projects when the catalog contains malformed entries', async ({ page }) => {
  await page.route('**/projects/index.json', route => route.fulfill({
    json: { projects: [null, 'invalid', { slug: 42 }, { slug: 'valid-paper', display_name: 'Valid Paper' }] }
  }))
  await page.goto('/hub.html?lang=en')
  await expect(page.getByRole('link', { name: 'Valid Paper' })).toBeVisible()
  await expect(page.locator('[data-project-slug]')).toHaveCount(1)
})

async function stubPdfModule(page) {
  await page.route('**/vendor/pdfjs/pdf.mjs?*', route => route.fulfill({
    contentType: 'text/javascript',
    body: `
      export const GlobalWorkerOptions = {};
      export function getDocument({data}) {
        const kind = data[0];
        const page = {
          getViewport({scale}) { return {width: 200 * scale, height: 320 * scale}; },
          render() { return {cancel() {}, promise: kind === 2 ? Promise.reject(new Error('Corrupt PDF')) : Promise.resolve()}; }
        };
        return {
          async destroy() { if (kind === 3) window.disposedPendingAsset = true; },
          promise: Promise.resolve({
            numPages: 1,
            getPage() {
              return kind === 3 ? new Promise(resolve => { window.releaseAssetPage = () => resolve(page); }) : Promise.resolve(page);
            }
          })
        };
      }
    `
  }))
}

test('failed compilation preview keeps the previous rendered page and download', async ({ page }) => {
  await stubPdfModule(page)
  await openWorkspace(page)
  await page.waitForFunction(() => !compileController)
  const result = await page.evaluate(async () => {
    await renderPdfPreviewLazy(Uint8Array.of(1), 'id:previous')
    const previous = document.querySelector('.pdf-page'), url = renderedPdfUrl
    const nativeFetch = window.fetch
    window.fetch = (path, options) => path === '/api/compile'
      ? Promise.resolve(Response.json({ pdf_base64: btoa(String.fromCharCode(2)), compile_id: 'failed' }))
      : nativeFetch(path, options)
    const compiled = await runUpdate()
    return {
      compiled, samePage: previous === document.querySelector('.pdf-page'),
      sameUrl: url === renderedPdfUrl, size: (await (await fetch(url)).blob()).size,
      sync: renderedSynctex, downloadEnabled: !$('download-pdf').disabled
    }
  })
  expect(result).toEqual({
    compiled: false, samePage: true, sameUrl: true, size: 1, sync: 'id:previous', downloadEnabled: true
  })
})

test('a corrupt initial artifact does not prevent backups or compile setup', async ({ page }) => {
  await stubPdfModule(page)
  const slug = `bad-preview-${randomUUID()}`
  await page.route(`**/p/${slug}/project/**`, route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/project.json')) return route.fulfill({
      json: { id: slug, entrypoint: 'main.tex', preview_pdf: 'preview.pdf', files: [{ path: 'main.tex' }] }
    })
    if (path.endsWith('/preview.pdf')) return route.fulfill({ contentType: 'application/pdf', body: Buffer.from([2]) })
    return route.fulfill({ body: '\\documentclass{article}\n\\begin{document}source\\end{document}' })
  })
  await page.goto(`/p/${slug}`)
  await expect.poll(() => page.evaluate(() => ({
    editable: workspaceReadyForCompile,
    collaboration: sharedMetadataReady,
    backups: backupInitialized
  }))).toEqual({ editable: true, collaboration: true, backups: true })
})

test('an expired SyncTeX response is ignored after another PDF is displayed', async ({ page }) => {
  await stubPdfModule(page)
  await openWorkspace(page)
  await page.waitForFunction(() => !compileController)
  const result = await page.evaluate(async () => {
    await renderPdfPreviewLazy(Uint8Array.of(1), 'id:old', 'old-fallback')
    let respond, calls = 0
    const nativeFetch = window.fetch
    window.fetch = (path, options) => {
      if (path !== '/api/synctex') return nativeFetch(path, options)
      calls += 1
      return new Promise(resolve => { respond = resolve })
    }
    const inFlight = requestSynctex('/api/synctex', { page: 1 })
    await renderPdfPreviewLazy(Uint8Array.of(1), 'id:new', 'new-fallback')
    respond(Response.json({ error: 'SyncTeX cache expired' }, { status: 410 }))
    return { ignored: await inFlight === null, calls, reference: renderedSynctex, fallback: renderedSynctexFallback }
  })
  expect(result).toEqual({ ignored: true, calls: 1, reference: 'id:new', fallback: 'new-fallback' })
})

test('a pending asset page cannot install its PDF session after selection changes', async ({ page }) => {
  await stubPdfModule(page)
  await openWorkspace(page)
  await page.evaluate(async () => {
    state.assets['paper/slow.pdf'] = { type: 'application/pdf', size: 1, data: 'data:application/pdf;base64,Aw==' }
    state.assets['paper/other.bin'] = { type: 'application/octet-stream', size: 1, data: 'data:application/octet-stream;base64,AA==' }
    await showAssetPreview('paper/slow.pdf')
  })
  await page.waitForFunction(() => window.releaseAssetPage)
  await page.evaluate(async () => {
    await showAssetPreview('paper/other.bin')
    window.releaseAssetPage()
  })
  await page.waitForFunction(() => window.disposedPendingAsset)
  expect(await page.evaluate(() => ({ active: activeAsset, session: assetPdfSession })))
    .toEqual({ active: 'paper/other.bin', session: null })
  await expect(page.locator('#asset-pdf-viewer canvas')).toHaveCount(0)
})

test('deleting a path evicts CodeMirror undo history before recreating it', async ({ page }) => {
  await openWorkspace(page)
  await page.evaluate(() => {
    const editor = window.PaperEditor.createEditor({ parent: document.body, value: 'seed' })
    editor.setDocument('paper/tmp.tex', 'seed')
    editor.replaceRange(' local edit', 4, 4, false)
    editor.setDocument('paper/another.tex', 'another')
    editor.retainDocuments(['paper/another.tex'])
    editor.setDocument('paper/tmp.tex', 'new file')
    window.undoProbe = editor
    editor.focus()
  })
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => undoProbe.getValue())).toBe('new file')
})

test('project manifest load can retry after an initial failure', async ({ page }) => {
  const slug = `manifest-retry-${randomUUID()}`
  let requests = 0
  await page.route(`**/p/${slug}/project/project.json`, route => {
    requests += 1
    return requests === 1 ? route.fulfill({ status: 503 }) : route.fulfill({
      json: { id: slug, entrypoint: 'main.tex', files: [{ path: 'main.tex' }] }
    })
  })
  await page.route(`**/p/${slug}/project/main.tex`, route => route.fulfill({
    body: '\\documentclass{article}\n\\begin{document}Recovered source\\end{document}'
  }))
  await page.goto(`/p/${slug}`)
  await page.waitForFunction(() => !projectLoadPromise)
  await page.evaluate(() => ensureProjectLoaded())
  expect(requests).toBe(2)
  expect(await page.evaluate(() => editorValue())).toContain('Recovered source')
})
