import { expect, test } from '@playwright/test'

function onePagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream'
  ]
  let body = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-workspace-language', 'ko'))
})

test('unsupported browser languages fall back to English', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-FR' })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('tab', { name: 'Revise' })).toBeVisible()
  await expect(page.locator('#workspace-language')).toHaveValue('en')
  await context.close()
})

test('an explicit language choice persists across reloads', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/?lang=ko')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect(page.getByRole('tab', { name: '수정' })).toBeVisible()
  await page.locator('#workspace-language').selectOption('en')
  await expect(page.getByRole('tab', { name: 'Revise' })).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('tab', { name: 'Revise' })).toBeVisible()
})

test('dynamic workspace status and empty states follow the selected language', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/?lang=en')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.waitForFunction(() => /compile error/.test(document.getElementById('render-state')?.textContent || ''))
  await expect(page.locator('#render-state')).toContainText('compile error')
  await page.getByRole('tab', { name: 'Tasks' }).click()
  await expect(page.locator('#task-board')).toHaveText('No tasks yet.')

  await page.locator('#workspace-language').selectOption('ko')
  await expect(page.getByRole('tab', { name: '작업' })).toBeVisible()
  await expect(page.locator('#task-board')).toHaveText('등록된 작업이 없습니다.')
})

test('comment prompt wraps without a horizontal drag track', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.getByRole('tab', { name: '댓글' }).click()
  const prompt = page.locator('#comment-body')
  await expect(prompt).toHaveCSS('overflow-x', 'hidden')
  const promptBox = await prompt.boundingBox()
  const buttonBox = await page.locator('#add-comment').boundingBox()
  expect(buttonBox.y - (promptBox.y + promptBox.height)).toBeGreaterThanOrEqual(8)
  await prompt.fill('긴댓글요청'.repeat(80))
  await expect.poll(() => prompt.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

test('backup actions use clear hierarchy and segmented history controls', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.getByRole('tab', { name: '자료' }).click()
  await expect(page.locator('#create-checkpoint')).toHaveCSS('background-color', 'rgb(36, 87, 214)')
  await page.locator('#backup-list').evaluate(element => {
    element.innerHTML = '<article class="backup-card"><div class="backup-card-meta"><strong>논문 백업</strong><span>방금 전 · 자동</span></div><div class="tool-row"><button class="backup-restore">비교</button><button class="backup-restore">복원</button></div></article>'
  })
  const actions = page.locator('.backup-card > .tool-row')
  await expect(actions).toHaveCSS('gap', '0px')
  await expect(actions).toHaveCSS('border-top-style', 'solid')
  await expect(actions.locator('.backup-restore').nth(1)).toHaveCSS('border-left-style', 'solid')
})

test('server manuscript paints before collaboration bootstrap finishes', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || ''), { timeout: 1500 }).toContain('\\documentclass')
  await expect(page.locator('#files .file')).toHaveCount(2)
})

test('an expired API session returns to login with the workspace path preserved', async ({ page }) => {
  let expire = false
  await page.route('**/_auth/login**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Login</title>' }))
  await page.route('**/api/backups/projects/default/assets', async route => {
    if (!expire) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"assets":[]}' })
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"authenticated":false}' })
  })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  expire = true

  await page.evaluate(() => fetch('/api/backups/projects/default/assets').catch(() => {}))

  await expect.poll(() => new URL(page.url()).pathname).toBe('/_auth/login')
  expect(new URL(page.url()).searchParams.get('rd')).toBe('/')
})

test('long mobile project trees scroll within the files panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '파일' }).click()
  const files = page.locator('#files')
  await files.evaluate(element => {
    for (let index = 0; index < 60; index += 1) {
      const item = document.createElement('button')
      item.className = 'file'
      item.textContent = `paper/drafts/regression-${index}.tex`
      element.append(item)
    }
  })
  await expect(files).toHaveCSS('overflow-y', 'auto')
  const dimensions = await files.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(dimensions.clientHeight).toBeGreaterThan(0)
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
  await files.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => files.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expect(page.locator('.side-heading')).toBeVisible()
  await expect(page.locator('.file-search')).toBeVisible()
})

test('local manuscript edits record the current collaborator as project activity', async ({ page }) => {
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.addInitScript(() => {
    localStorage.setItem('collab-name', 'KDH')
    localStorage.setItem('collab-name-user-set', '1')
  })
  let activity = null
  await page.route('**/api/backups/projects/*/activity', async route => {
    activity = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ activity: { ...activity, modified_at: new Date().toISOString() } }) })
  })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.locator('.cm-content').click()
  await page.keyboard.type('% activity')
  await expect.poll(() => activity, { timeout: 4000 }).toMatchObject({ actor: 'KDH', reason: 'edit' })
})

test('server source change notice can be dismissed without opening the preserved draft', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.evaluate(() => {
    document.getElementById('source-conflict').hidden = false
  })
  const close = page.getByRole('button', { name: '서버 원본 변경 안내 닫기' })
  await expect(close).toBeVisible()
  await close.click()
  await expect(page.locator('#source-conflict')).toBeHidden()
  await expect(page.locator('#active-file')).toHaveText('paper/main.tex')
})

test('malformed browser state cannot block the server manuscript', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('paper-workspace:default', JSON.stringify({
      files: null,
      uploads: {},
      comments: {},
      tasks: 'invalid',
      folders: null,
      collapsedFolders: {},
      current: 42
    }))
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || ''), { timeout: 1500 }).toContain('\\documentclass')
  await expect(page.locator('#files .file')).toHaveCount(2)
  await expect(page.locator('#project-title')).not.toHaveValue('Untitled Paper')
})

test('legacy localStorage manuscripts migrate transactionally into IndexedDB', async ({ page }) => {
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.addInitScript(() => {
    const source = '\\documentclass{article}\\begin{document}draft\\end{document}'
    const files = { 'paper/main.tex': source }
    for (let index = 0; index < 7; index += 1) files[`paper/drafts/browser-${index}.tex`] = `${source}% ${'x'.repeat(120_000)}${index}`
    localStorage.setItem('paper-workspace:default', JSON.stringify({
      fileTreeVersion: 1,
      files,
      folders: ['paper', 'paper/drafts'],
      current: 'paper/main.tex',
      projectVersion: 'older-version',
      serverMainSnapshot: source,
      serverSourceSnapshots: { 'paper/references.bib': '@article{large,' + 'x'.repeat(120_000) + '}' }
    }))
    const originalSetItem = Storage.prototype.setItem
    let rejectedProjectWrite = false
    Storage.prototype.setItem = function (key, value) {
      if (!rejectedProjectWrite && String(key) === 'paper-workspace:default') {
        rejectedProjectWrite = true
        window.__quotaFallbackTriggered = true
        throw new DOMException('Simulated quota exhaustion', 'QuotaExceededError')
      }
      return originalSetItem.call(this, key, value)
    }
  })
  await page.goto('/')
  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('paper-workspace:default') || '{}')
    return window.__quotaFallbackTriggered && stored.browserStateVersion === 2
  })
  const persisted = await page.evaluate(async () => {
    const local = JSON.parse(localStorage.getItem('paper-workspace:default'))
    const indexed = await new Promise((resolve, reject) => {
      const request = indexedDB.open('paper-workspace-state', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const get = request.result.transaction('states').objectStore('states').get('default')
        get.onerror = () => reject(get.error)
        get.onsuccess = () => resolve(get.result)
      }
    })
    return { local, indexed, localBytes: new Blob([JSON.stringify(local)]).size }
  })
  expect(persisted.local.files).toBeUndefined()
  expect(persisted.local.recovery.content).toContain('\\documentclass')
  expect(persisted.localBytes).toBeLessThan(200_000)
  expect(persisted.indexed.state.serverMainSnapshot).toMatch(/^fp1:/)
  expect(persisted.indexed.state.serverSourceSnapshots['paper/references.bib']).toMatch(/^fp1:/)
  expect(Object.keys(persisted.indexed.state.files).filter(path => path.startsWith('paper/drafts/')).length).toBeGreaterThanOrEqual(7)
  expect(persisted.indexed.state.files['paper/main.tex']).toContain('\\documentclass')
})

test('bounded local recovery remains usable when IndexedDB is unavailable', async ({ page }) => {
  const recovery = '\\documentclass{article}\\begin{document}offline recovery marker\\end{document}'
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.addInitScript(source => {
    localStorage.setItem('paper-workspace:default', JSON.stringify({
      browserStateVersion: 2,
      current: 'paper/main.tex',
      recovery: { path: 'paper/main.tex', content: source, savedAt: Date.now() }
    }))
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: { open: () => { throw new DOMException('IndexedDB disabled', 'InvalidStateError') } }
    })
  }, recovery)

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || '')).toContain('offline recovery marker')
  await expect(page.locator('#save-state')).not.toHaveText('저장 공간 부족')
})

test('workspace IndexedDB state store resolves only committed snapshots', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const store = window.PaperWorkspaceCore.workspaceStateStore('paper-workspace-state-e2e')
    await store.put('paper', { files: { 'paper/main.tex': 'committed' } }, 17)
    return store.get('paper')
  })
  expect(result).toEqual({ project: 'paper', state: { files: { 'paper/main.tex': 'committed' } }, savedAt: 17 })
})

test('manifest data assets stay out of durable manuscript state', async ({ page }) => {
  const slug = `manifest-assets-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const source = '\\documentclass{article}\n\\begin{document}asset boundary\\end{document}\n'
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.route(`**/p/${slug}/project/**`, async route => {
    const path = new URL(route.request().url()).pathname.split(`/p/${slug}/project/`)[1]
    if (path === 'project.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: slug,
          version: '1',
          entrypoint: 'main.tex',
          files: [
            { path: 'main.tex', managed: true },
            { path: 'references.bib', managed: true },
            { path: 'generated/report.json', type: 'asset', managed: true, size: 500_000 },
            { path: 'generated/claims.tex', type: 'asset', managed: true }
          ]
        })
      })
      return
    }
    if (path === 'main.tex') return route.fulfill({ contentType: 'text/plain', body: source })
    if (path === 'references.bib') return route.fulfill({ contentType: 'text/plain', body: '@article{asset-boundary,title={Boundary}}\n' })
    if (path === 'generated/claims.tex') return route.fulfill({ contentType: 'text/plain', body: '\\newcommand{\\AssetBoundary}{verified}\n' })
    if (path === 'generated/report.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ payload: 'x'.repeat(500_000) }) })
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })

  await page.goto(`/p/${slug}`)
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('asset boundary'))
  await expect.poll(() => page.evaluate(async project => {
    const request = indexedDB.open('paper-workspace-state', 1)
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = await new Promise((resolve, reject) => {
      const get = database.transaction('states').objectStore('states').get(project)
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
    })
    return Boolean(record?.state?.files?.['paper/generated/claims.tex'])
  }, slug)).toBe(true)

  const persisted = await page.evaluate(async project => {
    const local = JSON.parse(localStorage.getItem(`paper-workspace:${project}`) || '{}')
    const request = indexedDB.open('paper-workspace-state', 1)
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const indexed = await new Promise((resolve, reject) => {
      const get = database.transaction('states').objectStore('states').get(project)
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
    })
    return { local, indexed, localBytes: new Blob([JSON.stringify(local)]).size }
  }, slug)
  expect(persisted.local.files).toBeUndefined()
  expect(persisted.localBytes).toBeLessThan(200_000)
  expect(persisted.indexed.state.files['paper/generated/report.json']).toBeUndefined()
  expect(persisted.indexed.state.files['paper/generated/claims.tex']).toContain('AssetBoundary')
})

test('archived drafts use a thirty-item FIFO queue', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.waitForFunction(() => sharedMetadataReady)
  const result = await page.evaluate(async () => {
    state.current = 'paper/main.tex'
    collabSession.document.transact(() => {
      for (const path of [...collabSession.files.keys()]) {
        if (path.startsWith('paper/drafts/')) collabSession.files.delete(path)
      }
    }, actor.id)
    for (const path of Object.keys(state.files)) {
      if (path.startsWith('paper/drafts/')) delete state.files[path]
    }
    for (let index = 0; index < 35; index += 1) {
      state.files[`paper/drafts/fifo-${String(index).padStart(2, '0')}.tex`] = `draft ${index}`
    }
    publishSharedTree()
    const afterFirstPublish = draftQueuePaths()
    state.files['paper/drafts/fifo-35.tex'] = 'draft 35'
    publishSharedTree()
    const afterSecondPublish = draftQueuePaths()
    state.current = afterSecondPublish[0]
    state.files['paper/drafts/fifo-36.tex'] = 'draft 36'
    publishSharedTree()
    const afterProtectedPublish = draftQueuePaths()
    replaceSharedText(collabSession.textFor('paper/drafts/fifo-37.tex'), 'draft 37')
    for (let attempt = 0; attempt < 20 && draftQueuePaths().length > 30; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const afterSharedInsert = draftQueuePaths()
    const payload = await compilePayload()
    const result = {
      afterFirstPublish,
      afterSecondPublish,
      afterProtectedPublish,
      afterSharedInsert,
      sharedDraftCount: [...collabSession.files.keys()].filter(path => path.startsWith('paper/drafts/')).length,
      compiledDrafts: Object.keys(payload.files).filter(path => path.startsWith('drafts/')),
    }
    collabSession.document.transact(() => {
      for (const path of [...collabSession.files.keys()]) {
        if (path.startsWith('paper/drafts/')) collabSession.files.delete(path)
      }
    }, actor.id)
    for (const path of Object.keys(state.files)) {
      if (path.startsWith('paper/drafts/')) delete state.files[path]
    }
    return result
  })
  expect(result.afterFirstPublish).toHaveLength(30)
  expect(result.afterFirstPublish).not.toContain('paper/drafts/fifo-00.tex')
  expect(result.afterFirstPublish).toContain('paper/drafts/fifo-34.tex')
  expect(result.afterSecondPublish).toHaveLength(30)
  expect(result.afterSecondPublish).not.toContain('paper/drafts/fifo-05.tex')
  expect(result.afterSecondPublish).toContain('paper/drafts/fifo-35.tex')
  expect(result.afterProtectedPublish).toHaveLength(30)
  expect(result.afterProtectedPublish).toContain('paper/drafts/fifo-06.tex')
  expect(result.afterProtectedPublish).not.toContain('paper/drafts/fifo-07.tex')
  expect(result.afterProtectedPublish).toContain('paper/drafts/fifo-36.tex')
  expect(result.afterSharedInsert).toHaveLength(30)
  expect(result.afterSharedInsert).toContain('paper/drafts/fifo-37.tex')
  expect(result.sharedDraftCount).toBe(30)
  expect(result.compiledDrafts).toEqual([result.afterSharedInsert[0].slice('paper/'.length)])
})

test('a matching saved PDF opens without recompiling and keeps SyncTeX data', async ({ page }) => {
  const assets = new Map(), pdf = onePagePdf(), synctex = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
  let compileRequests = 0
  await page.route('**/vendor/pdfjs/*.mjs', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.route(/\/api\/backups\/projects\/[^/]+\/assets(?:\/.*)?$/, async route => {
    const request = route.request(), url = new URL(request.url()), marker = '/assets', offset = url.pathname.indexOf(marker)
    const path = decodeURIComponent(url.pathname.slice(offset + marker.length).replace(/^\//, ''))
    if (request.method() === 'GET' && !path) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assets: [...assets].map(([name, value]) => ({ path: name, size_bytes: value.length, modified_at: '2026-07-15T00:00:00.000Z' })) }) })
    if (request.method() === 'GET' && assets.has(path)) return route.fulfill({ status: 200, contentType: path.endsWith('.pdf') ? 'application/pdf' : 'application/gzip', body: assets.get(path) })
    if (request.method() === 'PUT') { assets.set(path, path.endsWith('.pdf') ? pdf : synctex); return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ asset: { path } }) }) }
    if (request.method() === 'DELETE') { assets.delete(path); return route.fulfill({ status: 204 }) }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"missing"}' })
  })
  await page.route('**/api/compile', route => {
    compileRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elapsed_ms: 12, cached: false, compile_id: '1234567890abcdef12345678', pdf_audit: { page_count: 1 }, pdf_base64: pdf.toString('base64'), synctex_base64: synctex.toString('base64') }) })
  })
  await page.goto('/')
  await expect.poll(() => compileRequests).toBe(1)
  await expect.poll(() => assets.size).toBe(2)
  await page.reload()
  await expect(page.locator('#render-state')).toContainText('저장된 PDF')
  await expect.poll(() => compileRequests).toBe(1)
  expect([...assets.keys()].some(path => path.endsWith('.synctex.gz'))).toBe(true)
})

test('SyncTeX navigation recovers when the compiler cache expires', async ({ page }) => {
  const pdf = onePagePdf(), synctex = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
  const synctexRequests = []
  await page.route('**/vendor/pdfjs/*.mjs', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.route('**/api/compile', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      elapsed_ms: 12,
      cached: false,
      compile_id: '1234567890abcdef12345678',
      pdf_audit: { page_count: 1 },
      pdf_base64: pdf.toString('base64'),
      synctex_base64: synctex.toString('base64'),
    }),
  }))
  await page.route('**/api/synctex', async route => {
    const payload = route.request().postDataJSON()
    synctexRequests.push(payload)
    if (payload.compile_id) {
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'SyncTeX cache expired; render the PDF again.' }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ file: 'main.tex', line: 2, column: 0 }) })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => renderedSynctex.startsWith('id:'))).toBe(true)
  await page.evaluate(() => syncPdfToSource(1, 10, 10))

  expect(synctexRequests).toHaveLength(2)
  expect(synctexRequests[0].compile_id).toBe('1234567890abcdef12345678')
  expect(synctexRequests[1].synctex_base64).toBe(synctex.toString('base64'))
  await expect(page.locator('#suggestion')).not.toContainText('PDF 위치 연결 오류')

  await page.evaluate(() => syncPdfToSource(1, 10, 10))
  expect(synctexRequests).toHaveLength(3)
  expect(synctexRequests[2].compile_id).toBeUndefined()
  expect(synctexRequests[2].synctex_base64).toBe(synctex.toString('base64'))
})

test('SyncTeX navigation waits while the visible PDF is stale', async ({ page }) => {
  const pdf = onePagePdf(), synctex = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
  let synctexRequests = 0
  await page.route('**/vendor/pdfjs/*.mjs', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.route('**/api/compile', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ elapsed_ms: 10, cached: false, compile_id: '1234567890abcdef12345678', pdf_audit: { page_count: 1 }, pdf_base64: pdf.toString('base64'), synctex_base64: synctex.toString('base64') }),
  }))
  await page.route('**/api/synctex', route => {
    synctexRequests += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ file: 'main.tex', line: 1, column: 0 }) })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => Boolean(renderedSynctex))).toBe(true)
  await page.evaluate(() => {
    setPdfFreshness(true)
    return syncPdfToSource(1, 10, 10)
  })

  expect(synctexRequests).toBe(0)
  await expect(page.locator('#app-toasts')).toContainText('PDF 갱신 대기 중')
})

test('a superseded compile response cannot replace the latest PDF state', async ({ page }) => {
  const pdf = onePagePdf(), synctex = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
  let compileRequests = 0
  await page.route('**/vendor/pdfjs/*.mjs', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.route('**/api/compile', async route => {
    const requestNumber = ++compileRequests
    if (requestNumber === 1) await new Promise(resolve => setTimeout(resolve, 250))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elapsed_ms: requestNumber === 1 ? 111 : 222, cached: false, compile_id: requestNumber === 1 ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbb', pdf_audit: { page_count: 1 }, pdf_base64: pdf.toString('base64'), synctex_base64: synctex.toString('base64') }) }).catch(() => {})
  })
  await page.goto('/')
  await expect.poll(() => compileRequests).toBe(1)
  await page.evaluate(async () => {
    window.__compileRaceOriginal = editorValue()
    const value = `${editorValue()}\n% latest revision`
    setEditorValue(value)
    state.files[state.current] = value
    await runUpdate()
  })
  await expect.poll(() => compileRequests).toBe(2)
  await expect(page.locator('#render-state')).toContainText('0.2초')
  await expect(page.locator('#render-state')).not.toContainText('오류')
  await page.evaluate(() => {
    state.files['paper/main.tex'] = window.__compileRaceOriginal
    replaceSharedText(collabSession.textFor('paper/main.tex'), window.__compileRaceOriginal)
    setEditorValueWithoutActivity(window.__compileRaceOriginal)
    save()
  })
})

test('compile state is reused for edits while final builds stay clean', async ({ page }) => {
  const pdf = onePagePdf(), synctex = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
  const requests = []
  await page.route('**/vendor/pdfjs/*.mjs', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.route('**/api/compile', route => {
    const request = route.request(), index = requests.length
    requests.push({ payload: request.postDataJSON(), state: request.headers()['x-compile-state'] })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        elapsed_ms: index ? 8 : 24,
        cached: false,
        build_state_id: index === 0 ? '11111111111111111111111111111111' : '22222222222222222222222222222222',
        compile_id: '1234567890abcdef12345678',
        pdf_audit: { page_count: 1 },
        pdf_base64: pdf.toString('base64'),
        synctex_base64: synctex.toString('base64'),
      }),
    })
  })

  await page.goto('/')
  await expect.poll(() => requests.length).toBe(1)
  await page.evaluate(async () => {
    window.__compileStateOriginal = editorValue()
    const value = `${editorValue()}\n% incremental edit`
    setEditorValue(value)
    state.files[state.current] = value
    await runUpdate()
    await runUpdate({ fullBuild: true })
  })

  expect(requests).toHaveLength(3)
  expect(requests[0].payload.workspace_id).toBe('default')
  expect(requests[0].state).toBeUndefined()
  expect(requests[1].state).toBe('11111111111111111111111111111111')
  expect(requests[1].payload.build_mode).toBeUndefined()
  expect(requests[2].state).toBe('22222222222222222222222222222222')
  expect(requests[2].payload.build_mode).toBe('clean')
  await page.evaluate(() => {
    state.files['paper/main.tex'] = window.__compileStateOriginal
    replaceSharedText(collabSession.textFor('paper/main.tex'), window.__compileStateOriginal)
    setEditorValueWithoutActivity(window.__compileStateOriginal)
    save()
  })
})

test('workspace core normalizes persisted state without DOM dependencies', async ({ page }) => {
  await page.goto('/')
  const normalized = await page.evaluate(() => {
    const core = window.PaperWorkspaceCore
    const state = core.normalizeState({
      files: { 'main.tex': 'legacy source', '../escape.tex': 'unsafe', 'bad.tex': { nested: true } },
      assets: [],
      comments: {},
      tasks: [null, { id: 'task-1' }],
      folders: null,
      current: 'main.tex'
    })
    return {
      current: state.current,
      files: state.files,
      folders: state.folders,
      taskCount: state.tasks.length,
      hasUnsafeFile: Object.keys(state.files).some(path => path.includes('..') || typeof state.files[path] !== 'string'),
      extension: core.extensionOf('paper/FIGURE.PDF'),
      parent: core.parentPath('paper/sections/intro.tex')
    }
  })
  expect(normalized).toEqual({
    current: 'paper/main.tex',
    files: { 'paper/main.tex': 'legacy source' },
    folders: ['paper'],
    taskCount: 1,
    hasUnsafeFile: false,
    extension: 'pdf',
    parent: 'paper/sections'
  })
})

test('cached pre-mapFor collaboration bundle remains compatible', async ({ page }) => {
  await page.route('**/vendor/paper-collab.js*', async route => {
    const response = await route.fetch()
    const body = `${await response.text()}\n;(() => { const create = PaperCollab.createSession; PaperCollab.createSession = options => { const session = create(options); delete session.mapFor; return session } })();`
    await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || ''), { timeout: 1500 }).toContain('\\documentclass')
  await expect(page.locator('#files .file:not([data-file-path^="paper/drafts/"])')).toHaveCount(2)
  await page.evaluate(() => {
    collabSession.document.transact(() => {
      for (const path of [...collabSession.files.keys()]) if (path.startsWith('paper/drafts/')) collabSession.files.delete(path)
    }, actor.id)
    for (const path of Object.keys(state.files)) if (path.startsWith('paper/drafts/')) delete state.files[path]
  })
  await page.waitForTimeout(100)
})

test('content-derived cache keys are emitted for workspace assets', async ({ page }) => {
  await page.goto('/')
  const urls = await page.evaluate(() => ({
    scripts: [...document.scripts].map(script => script.src).filter(Boolean),
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.href)
  }))
  for (const url of [...urls.scripts, ...urls.styles]) expect(new URL(url).searchParams.get('v')).toMatch(/^[a-f0-9]{16}$/)
})

test('missing collaboration bundle falls back to local editing', async ({ page }) => {
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || ''), { timeout: 1500 }).toContain('\\documentclass')
  await expect(page.locator('#files .file')).toHaveCount(2)
  await expect(page.locator('#collab-label')).toHaveText('공동 편집 오류')
  await expect(page.locator('#health-collab')).toHaveText('없이 로컬 편집 중')
})

test('collaboration watchdog recovers a missed sync notification', async ({ page }) => {
  await page.addInitScript(() => { window.__paperCollaborationWatchdogMs = 50 })
  await page.route('**/vendor/paper-collab.js*', async route => {
    const response = await route.fetch()
    const body = `${await response.text()}\n;(() => { const create = PaperCollab.createSession; window.PaperCollab = { ...PaperCollab, createSession: options => create({ ...options, onStatus: status => options.onStatus(status === 'synced' ? 'connected' : status) }) } })();`
    await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || ''), { timeout: 1500 }).toContain('\\documentclass')
  await expect(page.locator('#health-collab')).toHaveText('동기화됨', { timeout: 1500 })
  await expect(page.locator('#health-collab').locator('..').locator('..')).toHaveAttribute('data-health', 'ok')
})

test('collaboration watchdog leaves pending state when synchronization never completes', async ({ page }) => {
  await page.addInitScript(() => { window.__paperCollaborationWatchdogMs = 50 })
  await page.route('**/vendor/paper-collab.js*', async route => {
    const response = await route.fetch()
    const body = `${await response.text()}\n;(() => { const create = PaperCollab.createSession; window.PaperCollab = { ...PaperCollab, createSession: options => { const session = create({ ...options, onStatus: status => options.onStatus(status === 'synced' ? 'connected' : status) }); return { ...session, provider: { synced: false, disconnect() {}, connect() {} } } } } })();`
    await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.goto('/')
  await expect(page.locator('#health-collab')).toHaveText('동기화 지연', { timeout: 1500 })
  await expect(page.locator('#health-collab').locator('..').locator('..')).toHaveAttribute('data-health', 'error')
  await expect(page.locator('#collab-label')).not.toHaveText('처리 중')
})

test('collaboration reconnect action retries the socket without reloading the workspace', async ({ page }) => {
  await page.addInitScript(() => { window.__paperCollaborationWatchdogMs = 50 })
  await page.route('**/vendor/paper-collab.js*', async route => {
    const response = await route.fetch()
    const body = `${await response.text()}\n;(() => { const create = PaperCollab.createSession; window.PaperCollab = { ...PaperCollab, createSession: options => { const session = create({ ...options, onStatus: status => options.onStatus(status === 'synced' ? 'connected' : status) }); let attempts = 0; return { ...session, provider: { get synced() { return attempts > 1 }, disconnect() {}, connect() { attempts += 1; if (attempts > 1) options.onStatus('synced') } } } } } })();`
    await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/javascript' } })
  })
  await page.goto('/')
  await expect(page.locator('#health-collab')).toHaveText('동기화 지연', { timeout: 1500 })
  await page.locator('#status-center-toggle').click()
  await page.locator('#health-collab-action').click()
  await expect(page.locator('#health-collab')).toHaveText('동기화됨', { timeout: 1500 })
  await expect(page).toHaveURL(/\/$/)
})

test('startup watchdog paints the manuscript when the app script fails', async ({ page }) => {
  await page.route('**/app.js*', route => route.abort())
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || ''), { timeout: 8000 }).toContain('\\documentclass')
  await expect(page.locator('#editor-panel')).toHaveClass(/legacy-editor/)
  await expect(page.locator('#project-title')).not.toHaveValue('Untitled Paper')
  await expect(page.locator('#save-state')).toContainText('서버 원고 복구됨')
})

test('initial compile failure replaces the waiting spinner with an actionable error', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => /오류/.test(document.getElementById('render-state')?.textContent || ''))
  await expect(page.locator('#paper-preview .pdf-wait')).toHaveCount(0)
  await expect(page.locator('#paper-preview')).toContainText('PDF를 만들지 못했습니다')
  await expect(page.locator('#render-state')).not.toContainText('이전 PDF')
  await expect(page.locator('#suggestion')).not.toContainText('PDF 컴파일 오류')
  await expect(page.locator('#app-toasts')).not.toContainText('PDF 컴파일 오류')
})

test('PDF loading and compiling use minimal status indicators', async ({ page }) => {
  await page.route('**/api/compile', () => new Promise(() => {}))
  await page.goto('/')
  const spinner = page.locator('#paper-preview .pdf-spinner')
  await expect(spinner).toBeVisible()
  await expect(spinner).toHaveCSS('width', '22px')
  await expect(spinner).toHaveCSS('height', '22px')
  await expect(spinner).toHaveCSS('box-shadow', 'none')
  await expect(page.locator('#paper-preview .pdf-wait strong')).toHaveText('PDF 준비 중')
  await expect(page.locator('#paper-preview .pdf-wait-detail')).toHaveCSS('width', '1px')
  const compileSpinner = page.locator('#render-state.compiling .render-state-spinner')
  await expect(compileSpinner).toBeVisible()
  await expect(compileSpinner).toHaveCSS('width', '12px')
  await expect(compileSpinner).toHaveCSS('height', '12px')
  await expect(page.locator('.render-state-label')).toHaveCSS('width', '1px')
  const download = page.locator('#download-pdf')
  await expect(download).toHaveAttribute('aria-label', '렌더링된 PDF 다운로드')
  await expect(download).toHaveText('')
  await expect(download).toHaveCSS('width', '36px')
  await expect(download).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(download).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('#refresh-pdf')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.preview-header .zoom-controls')).toHaveCSS('border-top-width', '0px')
  await expect(page.locator('.preview-header .zoom-controls')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('#pdf-zoom-in')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('PDF viewport restoration keeps the visible page and position after rerender', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))

  const restored = await page.evaluate(() => {
    const panel = document.querySelector('.preview-panel')
    const preview = document.getElementById('paper-preview')
    const buildPages = count => {
      const viewer = document.createElement('div')
      viewer.className = 'pdf-canvas-viewer'
      const pages = Array.from({ length: count }, (_, index) => {
        const wrapper = document.createElement('div')
        wrapper.className = 'pdf-page'
        wrapper.dataset.page = String(index + 1)
        wrapper.style.height = '900px'
        wrapper.style.minHeight = '900px'
        viewer.append(wrapper)
        return wrapper
      })
      preview.replaceChildren(viewer)
      return pages
    }

    const originalPages = buildPages(4)
    panel.scrollTop = originalPages[2].offsetTop + 240
    const before = window.PaperPdfViewport.capture(panel, originalPages)
    const replacementPages = buildPages(4)
    window.PaperPdfViewport.restore(panel, replacementPages, before)
    const after = window.PaperPdfViewport.capture(panel, replacementPages)
    return { before, after }
  })

  expect(restored.before.pageNumber).toBe(3)
  expect(restored.after.pageNumber).toBe(3)
  expect(Math.abs(restored.after.pageProgress - restored.before.pageProgress)).toBeLessThan(0.02)
})

test('dark project tree keeps resting rows flat', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-workspace-theme', 'dark'))
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const inactive = page.locator('#files .file').filter({ hasText: 'references.bib' })
  await expect(inactive).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(inactive).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await expect(inactive).toHaveCSS('box-shadow', 'none')
  await expect(page.locator('.tree-action').first()).not.toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('#files .file.active')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('dark mode keeps application controls off white surfaces', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-workspace-theme', 'dark'))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect(page.locator('.tree-action').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.tree-action').first()).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.assistant-header-actions .beta')).toHaveCSS('background-color', 'rgb(23, 43, 82)')
  await page.getByRole('tab', { name: '검사' }).click()
  await expect(page.locator('#run-submission-checks')).toHaveCSS('background-color', 'rgb(53, 107, 217)')
  await expect(page.locator('.diagnostic-item').first()).toHaveCSS('background-color', 'rgb(58, 32, 37)')
  await page.locator('#files .folder-row').first().click({ button: 'right' })
  await expect(page.locator('#tree-menu button').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await page.locator('#collab-name').click()
  await expect(page.locator('.name-dialog .quiet-dialog')).toHaveCSS('background-color', 'rgb(24, 34, 53)')
})

test('workspace language label and chevron share a stable vertical center', async ({ page }) => {
  await page.goto('/p/example-paper')
  await page.locator('#workspace-language').selectOption('ko')

  const alignment = await page.locator('.language-control').evaluate(control => {
    const controlBox = control.getBoundingClientRect()
    const selectBox = control.querySelector('select').getBoundingClientRect()
    const chevron = getComputedStyle(control, '::after')
    return {
      centerDelta: Math.abs((controlBox.top + controlBox.height / 2) - (selectBox.top + selectBox.height / 2)),
      content: chevron.content,
      top: chevron.top,
      width: chevron.width,
      height: chevron.height,
      transform: chevron.transform
    }
  })

  expect(alignment.centerDelta).toBeLessThan(.5)
  expect(alignment.content).toBe('""')
  expect(alignment.top).toBe('18px')
  expect(alignment.width).toBe('5px')
  expect(alignment.height).toBe('5px')
  expect(alignment.transform).not.toBe('none')
})

test('wide workspace keeps source, PDF, and assistant visible', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.waitForFunction(() => /저장됨|동기화/.test(document.getElementById('save-state')?.textContent || ''))
  await expect(page.locator('#editor-panel')).toBeVisible()
  await expect(page.locator('.preview-panel')).toBeVisible()
  await expect(page.locator('#assistant-panel')).toBeVisible()
  await expect(page.locator('#focus-modes')).toBeHidden()
  await expect(page.locator('#new-folder')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('#new-folder')).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.language-control select')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.theme-trigger')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('#ask')).toHaveCSS('box-shadow', 'none')
  await expect(page.locator('#ask')).toHaveCSS('background-color', 'rgb(36, 87, 214)')
  await expect(page.locator('#save-state')).toHaveAttribute('data-health', 'ok')
  await expect(page.locator('#save-state')).toHaveCSS('width', '8px')
  const precisionControls = ['#status-center-toggle', '#collab-name', '#toggle-sidebar', '#new-folder', '#new-file', '#editor-zoom-out', '#editor-zoom-in', '#pdf-zoom-out', '#pdf-zoom-in', '#download-pdf', '#refresh-pdf', '#reset-layout', '#toggle-assistant']
  for (const selector of precisionControls) {
    const box = await page.locator(selector).boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(36)
    expect(box?.width).toBeGreaterThanOrEqual(36)
  }
  for (const box of await page.locator('.assistant-tabs .tab').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))) {
    expect(box.width).toBeGreaterThanOrEqual(40)
    expect(box.height).toBeGreaterThanOrEqual(40)
  }
  if (browserName === 'chromium') {
    await expect(page.locator('body')).toHaveScreenshot('workspace-wide.png', {
      animations: 'disabled',
      mask: [page.locator('#save-state'), page.locator('#render-state'), page.locator('#collab-status'), page.locator('#collab-label'), page.locator('#collab-name'), page.locator('#app-toasts')],
      maxDiffPixelRatio: 0.015
    })
  }
})

test('submission checks use a distinct primary action with summary spacing', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.getByRole('tab', { name: '검사' }).click()
  const action = page.locator('#run-submission-checks')
  const summary = page.locator('#submission-check-summary')
  await expect(action).toHaveCSS('display', 'inline-flex')
  await expect(action).toHaveCSS('background-color', 'rgb(36, 87, 214)')
  await expect(action).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(action).toHaveCSS('margin-bottom', '10px')
  const [actionBox, summaryBox] = await Promise.all([action.boundingBox(), summary.boundingBox()])
  expect(summaryBox.y - (actionBox.y + actionBox.height)).toBeGreaterThanOrEqual(9)
})

test('compact workspace switches focused surfaces with keyboard-accessible controls', async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 800 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect(page.locator('#focus-modes')).toBeVisible()
  await page.getByRole('button', { name: 'PDF', exact: true }).click()
  await expect(page.locator('.preview-panel')).toBeVisible()
  await expect(page.locator('#editor-panel')).toBeHidden()
  await expect(page.locator('#focus-modes button[data-focus="preview"]')).toHaveClass(/is-active/)
  await expect(page.locator('#focus-modes button[data-focus="source"]')).not.toHaveClass(/is-active/)
  await page.getByRole('button', { name: '도우미', exact: true }).click()
  await expect(page.locator('#assistant-panel')).toBeVisible()
})

test('assistant tabs support arrow-key navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const assist = page.getByRole('tab', { name: '수정' })
  await assist.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: '댓글' })).toBeFocused()
  await expect(page.getByRole('tab', { name: '댓글' })).toHaveAttribute('aria-selected', 'true')
})

test('CodeMirror provides a professional LaTeX editing surface', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect(page.locator('#editor-view .cm-editor')).toBeVisible()
  await expect(page.locator('#editor-view .cm-lineNumbers')).toBeVisible()
  const content = page.locator('#editor-view .cm-content')
  await content.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n% codemirror-e2e')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor').value)).toContain('% codemirror-e2e')
})

test('compile reads CodeMirror when the legacy textarea is stale', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#editor-view .cm-content')?.textContent.includes('documentclass'))
  await page.waitForFunction(() => /오류/.test(document.getElementById('render-state')?.textContent || ''))
  await page.locator('#editor').evaluate(element => { element.value = '' })
  const requestPromise = page.waitForRequest(request => request.url().endsWith('/api/compile'))
  await page.locator('#refresh-pdf').click()
  const payload = (await requestPromise).postDataJSON()
  expect(payload.files['main.tex']).toContain('\\documentclass')
})

test('LaTeX search uses a compact accessible toolbar above the manuscript', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const editor = page.locator('#editor-view .cm-editor')
  await editor.locator('.cm-content').click()
  await page.keyboard.press('Control+f')

  const panel = editor.locator('.paper-search-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('searchbox', { name: '찾기' })).toBeFocused()
  await expect(panel.getByRole('button', { name: '이전 결과' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '다음 결과' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '검색 닫기' })).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: '대소문자 구분' })).toBeVisible()

  const [editorBox, panelBox] = await Promise.all([editor.boundingBox(), panel.boundingBox()])
  expect(panelBox?.y).toBeGreaterThanOrEqual(editorBox?.y ?? 0)
  expect(panelBox?.y).toBeLessThan((editorBox?.y ?? 0) + 120)
  expect(panelBox?.width).toBeLessThanOrEqual(editorBox?.width ?? Infinity)

  await panel.getByRole('searchbox', { name: '찾기' }).fill('document')
  await page.keyboard.press('Enter')
  await expect(editor.locator('.cm-searchMatch')).not.toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(editor).toHaveClass(/cm-focused/)
})

test('a stalled compile becomes a timeout instead of permanent processing', async ({ page }) => {
  await page.addInitScript(() => { window.__paperCompileRequestTimeoutMs = 100 })
  await page.route('**/api/compile', () => new Promise(() => {}))
  await page.goto('/')
  await expect(page.locator('#render-state')).toContainText('컴파일 시간 초과', { timeout: 2000 })
  await expect(page.locator('#health-pdf').locator('..').locator('..')).toHaveAttribute('data-health', 'error')
  await expect(page.locator('#collab-label')).not.toHaveText('처리 중')
})

test('PDF source highlight matches the full height of a wrapped source line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.evaluate(() => {
    const wrapped = 'A deliberately long source line that wraps across several visual rows so the SyncTeX source marker must use the rendered logical line height rather than a fixed caret height. '.repeat(5)
    window.setEditorValue(wrapped)
    window.setEditorSelection(0, wrapped.length, { scroll: true })
  })
  await page.waitForTimeout(50)
  await page.evaluate(() => window.showSourceSyncHighlight(0))

  const activeLine = await page.locator('#editor-view .cm-activeLine').boundingBox()
  const marker = await page.locator('#sync-highlight').boundingBox()
  expect(activeLine?.height).toBeGreaterThan(40)
  expect(Math.abs((activeLine?.y || 0) - (marker?.y || 0))).toBeLessThan(1.5)
  expect(Math.abs((activeLine?.height || 0) - (marker?.height || 0))).toBeLessThan(1.5)
})

test('workspace health center exposes collaboration, save, PDF, and backup state', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.locator('#status-center-toggle').click()
  await expect(page.locator('#status-center')).toBeVisible()
  await expect(page.locator('#health-collab')).not.toBeEmpty()
  await expect(page.locator('#health-save')).not.toBeEmpty()
  await expect(page.locator('#health-pdf')).not.toBeEmpty()
  await expect(page.locator('#health-backup')).not.toBeEmpty()
  await expect(page.locator('#collab-label')).toHaveText(/^(정상|처리 중|.+ 확인|.+ 오류)$/)
  await expect(page.locator('#status-center-toggle')).toHaveAttribute('aria-label', /작업공간 상태:/)
  await expect(page.locator('#health-backup-action')).toBeVisible()
  await expect(page.locator('#status-center-close')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#status-center-toggle')).toBeFocused()
  await expect(page.locator('#status-center')).toBeHidden()
  await page.evaluate(() => {
    document.querySelectorAll('.status-center-list>div').forEach(row => { row.dataset.health = 'ok' })
    window.refreshOverallStatus()
  })
  await expect(page.locator('#status-center-toggle')).toHaveAttribute('data-health', 'healthy')
  await expect(page.locator('#collab-label')).toBeHidden()
})

test('mobile workspace uses focused bottom navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.locator('#focus-modes')).toBeVisible()
  await page.getByRole('button', { name: '파일', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.getByRole('button', { name: 'PDF', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.locator('.preview-panel')).toBeVisible()
  await expect(page.locator('#editor-panel')).toBeHidden()
  await expect(page.locator('#focus-modes button[data-focus="preview"]')).toHaveCSS('background-color', 'rgb(36, 87, 214)')
  await expect(page.locator('#focus-modes button[data-focus="source"]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const sizes = await page.locator('#focus-modes button').evaluateAll(items => items.map(item => {
    const rect = item.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }))
  for (const size of sizes) {
    expect(size.width).toBeGreaterThanOrEqual(44)
    expect(size.height).toBeGreaterThanOrEqual(44)
  }
  const toolbar = page.locator('.preview-header')
  await expect(toolbar).toBeInViewport()
  await expect(page.locator('#download-pdf')).toHaveCSS('width', '44px')
  await page.getByRole('button', { name: '도우미', exact: true }).click()
  for (const box of await page.locator('.assistant-tabs .tab').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))) {
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
  const titleBox = await page.locator('#project-title').boundingBox()
  expect(titleBox?.height).toBeGreaterThanOrEqual(44)
})

test('responsive editor remeasures after shrinking from desktop to mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('.cm-content'))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.locator('.cm-content').evaluate(element => Math.round(element.getBoundingClientRect().left))).toBeLessThan(80)
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth)).toBe(390)
})

test('mobile top bar groups secondary utilities without hiding the collaborator', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const menu = page.locator('#mobile-utilities')
  await expect(menu.locator('summary')).toBeVisible()
  await expect(page.locator('#collab-name')).toBeVisible()
  await expect(page.locator('#workspace-language')).toBeHidden()
  await menu.locator('summary').click()
  await expect(page.locator('#workspace-language')).toBeVisible()
  await expect(page.locator('.mobile-utility-items .theme-trigger')).toBeVisible()
})

test('project tree starts archival drafts collapsed and filters by full path', async ({ page }) => {
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.addInitScript(() => localStorage.setItem('paper-workspace:default', JSON.stringify({
    fileTreeVersion: 1,
    files: {
      'paper/main.tex': '\\documentclass{article}\\begin{document}main\\end{document}',
      'paper/drafts/older-version.tex': 'archived draft'
    },
    folders: ['paper', 'paper/drafts'],
    collapsedFolders: [],
    current: 'paper/main.tex'
  })))
  await page.goto('/')
  const drafts = page.locator('.folder-row[data-folder="paper/drafts"]')
  await expect(drafts).toHaveAttribute('aria-expanded', 'false')
  await page.locator('#file-search').fill('older-version')
  await expect(drafts).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-file-path="paper/drafts/older-version.tex"]')).toBeVisible()
  await expect(page.locator('[data-file-path="paper/main.tex"]')).toBeHidden()
  await page.locator('#clear-file-search').click()
  await expect(drafts).toHaveAttribute('aria-expanded', 'false')
})

test('compile failure presents a normalized cause and direct source jump', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  let codexRequest = null
  await page.route('**/api/compile', route => route.fulfill({
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({ error: "LaTeX Warning: File `missing-figure.pdf' not found on input line 5.\n! Package pdftex.def Error\nl.5 \\includegraphics{missing-figure.pdf}" })
  }))
  await page.route('**/api/codex', route => {
    codexRequest = route.request().postDataJSON()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        replacement: `${codexRequest.selection}\n% AI-proposed compile fix`,
        summary: 'Kept the manuscript intact and proposed a minimal local correction.'
      })
    })
  })
  await page.goto('/')
  const error = page.locator('.pdf-error-state')
  await expect(error).toContainText('필요한 파일이 프로젝트에 없습니다: missing-figure.pdf')
  await expect(page.locator('#status-center-toggle')).toHaveAttribute('data-health', 'error')
  await expect(page.locator('#collab-status')).toHaveClass(/error/)
  await expect(page.locator('#collab-status')).toHaveCSS('background-color', 'rgb(240, 68, 56)')
  await expect(page.locator('#collab-label')).toHaveCSS('color', 'rgb(255, 138, 128)')
  await expect(page.locator('#pdf-error-action')).toHaveText('paper/main.tex:5로 이동')
  await page.locator('#pdf-error-action').click()
  await expect(page.locator('#active-file')).toHaveText('paper/main.tex')
  const sourceBeforeProposal = await page.locator('#editor').inputValue()
  await page.getByRole('tab', { name: '검사' }).click()
  const aiFix = page.locator('#fix-compile-error')
  await expect(aiFix).toBeVisible()
  await expect(aiFix).toContainText('AI로 고치기')
  await aiFix.click()
  await expect(page.getByRole('tab', { name: '수정' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.codex-thread-turn-user')).toContainText('paper/main.tex:5의 컴파일 오류를 AI로 고쳐줘.')
  await expect(page.locator('.suggestion.codex-result')).toBeVisible()
  expect(codexRequest.instruction).toContain('Package pdftex.def Error')
  expect(codexRequest.instruction).toContain('가장 작은 수정')
  expect(codexRequest.file).toBe('paper/main.tex')
  await expect(page.locator('#editor')).toHaveValue(sourceBeforeProposal)
  await page.locator('#apply-codex').click()
  await expect(page.locator('#editor')).toHaveValue(/AI-proposed compile fix/)
})

test('first compact desktop visit prioritizes source and PDF', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 })
  await page.addInitScript(() => localStorage.removeItem('paper-workspace-layout'))
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect(page.locator('#workspace')).toHaveClass(/assistant-collapsed/)
  await expect(page.locator('#editor-panel')).toBeVisible()
  await expect(page.locator('.preview-panel')).toBeVisible()
})

test('panel resizing follows the pointer without trailing layout motion', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const resizer = page.locator('#sidebar-resizer')
  const handle = await resizer.boundingBox()
  const before = await page.locator('.sidebar').boundingBox()
  expect(handle).not.toBeNull()
  expect(before).not.toBeNull()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 120)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 120)
  await expect(page.locator('body')).toHaveClass(/panel-resizing/)
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBeGreaterThan((before?.width || 0) + 30)
  expect(await page.locator('.workspace').evaluate(element => getComputedStyle(element).transitionDuration)).toMatch(/^0s/)
  await page.mouse.up()
  await expect(page.locator('body')).not.toHaveClass(/panel-resizing/)
})

test('reduced motion keeps feedback but removes spatial panel animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 980, height: 800 })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.getByRole('button', { name: 'PDF', exact: true }).click()
  await expect(page.locator('.preview-panel')).toBeVisible()
  await expect(page.locator('.preview-panel')).toHaveCSS('animation-name', 'none')
})

test('keyboard selection can open inline comment composer', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const content = page.locator('#editor-view .cm-content')
  await content.click()
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.up('Shift')
  await page.keyboard.press('Control+Alt+c')
  await expect(page.locator('#selection-comment-composer')).toBeVisible()
  await expect(page.locator('#selection-comment-prompt')).toBeFocused()
})

test('upward mouse selection shows actions when released above the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.waitForSelector('#editor-view .cm-line')
  const content = page.locator('#editor-view .cm-content')
  await content.click({ position: { x: 20, y: 10 } })
  await expect(page.locator('#selection-toolbar')).toBeHidden()
  const contentBox = await content.boundingBox()
  const startBox = await page.locator('#editor-view .cm-line').nth(10).boundingBox()
  await page.mouse.move(startBox.x + Math.min(startBox.width - 4, 180), startBox.y + startBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(contentBox.x + 20, contentBox.y - 8, { steps: 10 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length || 0)).toBeGreaterThan(0)
  await expect(page.locator('#selection-toolbar')).toBeVisible()
  await page.locator('#selection-comment').click()
  await expect(page.locator('#selection-comment-composer')).toBeVisible()
})

test('Codex prompt wraps horizontally and Enter submits while Shift Enter adds a line', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.route('**/api/codex', async route => {
    await new Promise(resolve => setTimeout(resolve, 500))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ replacement: 'Revised sentence.', summary: 'Revised for clarity.' })
    })
  })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.evaluate(() => window.setEditorSelection(0, 1, { scroll: true }))
  const prompt = page.locator('#instruction')
  await prompt.fill('첫 번째 요청')
  await prompt.press('Shift+Enter')
  await prompt.type('추가 조건')
  await expect(prompt).toHaveValue('첫 번째 요청\n추가 조건')
  await prompt.press('Enter')
  await expect(page.locator('.suggestion.codex-loading')).toBeVisible()
  await expect(page.locator('.suggestion.codex-loading')).toHaveCSS('border-left-style', 'none')
  await expect(page.locator('#codex-request-summary')).toBeVisible()
  await expect(page.locator('.codex-thread-turn-user')).toContainText('첫 번째 요청\n추가 조건')
  await page.locator('#codex-new-request').click()
  await expect(page.locator('#codex-request-form')).toBeVisible()
  await expect(page.locator('#codex-thread')).toBeHidden()
  await page.waitForTimeout(550)
  await expect(page.locator('.codex-result')).toHaveCount(0)
  const placeholderWrapping = await prompt.evaluate(element => {
    const style = getComputedStyle(element, '::placeholder')
    return {
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      wordBreak: style.wordBreak
    }
  })
  expect(placeholderWrapping).toEqual({
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word'
  })
  await prompt.fill('unbroken-'.repeat(80))
  await expect(prompt).toHaveCSS('overflow-x', 'hidden')
  await expect.poll(() => prompt.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

test('Codex result stays flat while controls retain clear boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.route('**/api/codex', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      replacement: '\\title{A clearer paper title}',
      summary: 'Clarified the title while preserving the original scope.'
    })
  }))
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.evaluate(() => window.setEditorSelection(0, 1, { scroll: true }))
  await page.locator('#instruction').fill('제목을 더 명확하게 다듬어줘')
  await page.locator('#instruction').press('Enter')
  const result = page.locator('.suggestion.codex-result')
  await expect(result).toBeVisible()
  await expect(result).toHaveCSS('border-left-width', '0px')
  await expect(result).toHaveCSS('border-radius', '0px')
  await expect(result).toHaveCSS('box-shadow', 'none')
  await expect(result).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.codex-change-details')).toHaveCSS('border-radius', '0px')
  await expect(page.locator('.codex-result .codex-summary')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.codex-followup')).toHaveCSS('border-left-width', '0px')
  await expect(page.locator('.codex-followup-row')).toHaveCSS('display', 'grid')
  const inputBox = await page.locator('#codex-followup-input').boundingBox()
  const buttonBox = await page.locator('#codex-followup-send').boundingBox()
  expect(buttonBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height + 7)
  await expect.poll(() => result.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

test('Codex conversation keeps prior turns and starts a clean conversation without reload', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const requests = []
  await page.route('**/api/codex', async route => {
    const payload = route.request().postDataJSON()
    requests.push(payload)
    const number = requests.length
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        replacement: `Revision ${number}`,
        summary: `Summary ${number}`
      })
    })
  })
  await page.goto('/?lang=en')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.evaluate(() => window.setEditorSelection(0, 1, { scroll: true }))
  await page.locator('#instruction').fill('Initial request')
  await page.locator('#instruction').press('Enter')
  await expect(page.locator('.codex-result')).toContainText('Revision 1')
  await page.locator('#codex-followup-input').fill('Follow-up request')
  await page.locator('#codex-followup-send').click()
  await expect(page.locator('.codex-result')).toContainText('Revision 2')
  await expect(page.locator('.codex-thread-turn')).toHaveCount(3)
  await expect(page.locator('#codex-thread')).toContainText('Initial request')
  await expect(page.locator('#codex-thread')).toContainText('Revision 1')
  await expect(page.locator('#codex-thread')).toContainText('Follow-up request')
  expect(requests[1].history).toHaveLength(2)
  await expect(page.locator('#codex-new-request')).toHaveText('New conversation')
  await page.locator('#codex-new-request').click()
  await expect(page.locator('#codex-request-form')).toBeVisible()
  await expect(page.locator('#codex-thread')).toBeHidden()
  await expect(page.locator('#suggestion')).toBeEmpty()
  await page.evaluate(() => window.setEditorSelection(0, 1, { scroll: true }))
  await page.locator('#instruction').fill('Fresh conversation')
  await page.locator('#instruction').press('Enter')
  await expect(page.locator('.codex-result')).toContainText('Revision 3')
  expect(requests[2].history).toHaveLength(0)
})

test('Yjs merges text and awareness between two browsers', async ({ browser }) => {
  const first = await browser.newPage()
  const second = await browser.newPage()
  await Promise.all([first.goto('/'), second.goto('/')])
  const room = `e2e-${Date.now()}`
  const create = (page, name) => page.evaluate(({ room, name }) => {
    window.e2eSession = PaperCollab.createSession({
      url: 'ws://127.0.0.1:18765', room,
      actor: { id: name, name, color: '#2457d6' }
    })
    return window.e2eSession.whenReady.then(() => true)
  }, { room, name })
  await Promise.all([create(first, 'first'), create(second, 'second')])
  await first.evaluate(() => window.e2eSession.textFor('paper/main.tex').insert(0, 'PAC'))
  await expect.poll(() => second.evaluate(() => window.e2eSession.textFor('paper/main.tex').toString())).toBe('PAC')
  await first.evaluate(() => {
    window.e2eSession.mapFor('comments').set('comment-1', { id: 'comment-1', body: 'shared comment' })
    window.e2eSession.mapFor('tasks').set('task-1', { id: 'task-1', title: 'shared task', status: 'todo' })
    window.e2eSession.mapFor('folders').set('paper/results', true)
    window.e2eSession.textFor('paper/results/table.tex').insert(0, 'shared table')
  })
  await expect.poll(() => second.evaluate(() => window.e2eSession.mapFor('comments').get('comment-1')?.body)).toBe('shared comment')
  await expect.poll(() => second.evaluate(() => window.e2eSession.mapFor('tasks').get('task-1')?.title)).toBe('shared task')
  await expect.poll(() => second.evaluate(() => window.e2eSession.mapFor('folders').has('paper/results'))).toBe(true)
  await expect.poll(() => second.evaluate(() => window.e2eSession.textFor('paper/results/table.tex').toString())).toBe('shared table')
  await Promise.all([
    first.evaluate(() => window.e2eSession.textFor('paper/main.tex').insert(0, 'A')),
    second.evaluate(() => window.e2eSession.textFor('paper/main.tex').insert(3, 'B'))
  ])
  await expect.poll(async () => {
    const values = await Promise.all([first, second].map(page => page.evaluate(() => window.e2eSession.textFor('paper/main.tex').toString())))
    return values[0] === values[1] && values[0].includes('A') && values[0].includes('B')
  }).toBe(true)
  await Promise.all([first.close(), second.close()])
})

test('a fresh browser cannot replace an established shared manuscript with the static seed', async ({ browser }) => {
  test.slow()
  const slug = `fresh-client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const workspaceUrl = `/p/${slug}`
  const marker = `% shared manuscript survives ${slug}`
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  const routeProjectFiles = page => page.route(`**/p/${slug}/project/**`, async route => {
    const requestUrl = new URL(route.request().url())
    const projectPath = requestUrl.pathname.split(`/p/${slug}/project/`)[1]
    await route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:18080/project/${projectPath}` }) })
  })
  await Promise.all(pages.map(routeProjectFiles))

  await pages[0].goto(workspaceUrl)
  await pages[0].waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect.poll(() => pages[0].evaluate(() => collabReady)).toBe(true)
  await pages[0].evaluate(value => {
    const next = `${editorValue()}\n${value}`
    state.files[state.current] = next
    setEditorValue(next)
    save()
  }, marker)
  await expect.poll(() => pages[0].evaluate(value => collabSession.textFor('paper/main.tex').toString().includes(value), marker)).toBe(true)

  await pages[1].goto(workspaceUrl)
  await pages[1].waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect.poll(() => pages[1].evaluate(() => collabReady), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => pages[1].evaluate(value => collabSession.textFor('paper/main.tex').toString().includes(value), marker), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => pages[1].evaluate(value => editorValue().includes(value), marker)).toBe(true)
  await expect.poll(() => pages[0].evaluate(value => editorValue().includes(value), marker), { timeout: 15_000 }).toBe(true)
  const migrationDrafts = await pages[1].evaluate(() => [...collabSession.files.keys()].filter(path => path.startsWith('paper/drafts/')).length)
  expect(migrationDrafts).toBe(0)

  await Promise.all(contexts.map(context => context.close()))
})

test('staged server source changes reach an open workspace without reload and preserve web edits', async ({ page }) => {
  test.slow()
  const slug = `runtime-sync-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const revisions = { initial: '1'.repeat(64), next: '2'.repeat(64) }
  let runtimeRevision = revisions.initial
  let fileRevision = 'a'.repeat(64)
  let serverSource = '\\documentclass{article}\n\\title{Initial server source}\n\\begin{document}\nInitial server source\n\\end{document}\n'
  let synchronizationRequests = 0
  await page.addInitScript(() => { window.__paperServerSourcePollMs = 50 })
  await page.route(`**/p/${slug}/project/**`, async route => {
    const requestUrl = new URL(route.request().url())
    const projectPath = requestUrl.pathname.split(`/p/${slug}/project/`)[1]
    if (projectPath === 'project.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: slug,
          version: '1',
          entrypoint: 'main.tex',
          files: [{ path: 'main.tex', managed: true }],
          runtime_revision: runtimeRevision,
          runtime_file_revisions: { 'main.tex': fileRevision }
        })
      })
      return
    }
    if (projectPath === 'main.tex') {
      await route.fulfill({ contentType: 'text/plain', body: serverSource })
      return
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  await page.route('**/collab-runtime/**', async route => {
    synchronizationRequests += 1
    const signal = route.request().postDataJSON()
    const result = await page.evaluate(({ source, signal }) => {
      const files = collabSession.files
      const project = sharedProject
      if (project.get('serverRuntimeRevision') === signal.runtime_revision) return { deduplicated: true, preserved_paths: [] }
      if (project.get('serverRuntimeRevision') !== signal.previous_runtime_revision) return { conflict: true, current_revision: project.get('serverRuntimeRevision') }
      const current = files.get('paper/main.tex').toString()
      const draftPath = `paper/drafts/server-before-sync-e2e-main.tex`
      collabSession.document.transact(() => {
        const draft = collabSession.textFor(draftPath)
        if (draft.length) draft.delete(0, draft.length)
        draft.insert(0, current)
        const main = files.get('paper/main.tex')
        if (main.length) main.delete(0, main.length)
        main.insert(0, source)
        project.set('serverRuntimeRevision', signal.runtime_revision)
        project.set('serverManagedPaths', ['paper/main.tex'])
        project.set('serverSourceFingerprints', { 'paper/main.tex': sourceFingerprint(source) })
      }, 'server-runtime-sync')
      return { deduplicated: false, preserved_paths: [draftPath] }
    }, { source: serverSource, signal })
    await route.fulfill({
      status: result.conflict ? 409 : 200,
      contentType: 'application/json',
      body: JSON.stringify(result)
    })
  })

  await page.goto(`/p/${slug}`)
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('Initial server source'))
  await expect.poll(() => page.evaluate(() => collabReady)).toBe(true)
  await expect.poll(() => page.evaluate(() => sharedProject.get('serverRuntimeRevision'))).toBe(revisions.initial)
  const webMarker = `% connected-web-edit-${slug}`
  await page.evaluate(marker => {
    const next = `${editorValue()}\n${marker}`
    state.files[state.current] = next
    setEditorValue(next)
    save()
  }, webMarker)
  await expect.poll(() => page.evaluate(marker => collabSession.textFor('paper/main.tex').toString().includes(marker), webMarker)).toBe(true)

  serverSource = '\\documentclass{article}\n\\title{Server revision two}\n\\begin{document}\nServer revision two\n\\end{document}\n'
  runtimeRevision = revisions.next
  fileRevision = 'b'.repeat(64)

  await expect.poll(() => page.evaluate(() => editorValue()), { timeout: 10_000 }).toContain('Server revision two')
  await expect.poll(() => page.evaluate(() => projectManifest.runtime_revision)).toBe(revisions.next)
  const preserved = await page.evaluate(marker => {
    const drafts = [...collabSession.files.entries()].filter(([name]) => name.startsWith('paper/drafts/server-before-sync-'))
    return { count: drafts.length, containsMarker: drafts.some(([, text]) => text.toString().includes(marker)) }
  }, webMarker)
  expect(preserved).toEqual({ count: 1, containsMarker: true })
  expect(synchronizationRequests).toBe(1)
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1)
})

test('compile cancellation identity is isolated per tab and stable across reloads', async ({ browser }) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  await first.goto('/')
  await first.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const second = await context.newPage()
  await second.goto('/')
  await second.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))

  const firstIdentity = await first.evaluate(() => ({ actor: actor.id, compile: compileClientId }))
  const secondIdentity = await second.evaluate(() => ({ actor: actor.id, compile: compileClientId }))
  expect(firstIdentity.actor).toBe(secondIdentity.actor)
  expect(firstIdentity.compile).not.toBe(secondIdentity.compile)

  await first.reload()
  await first.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await expect.poll(() => first.evaluate(() => compileClientId)).toBe(firstIdentity.compile)
  await context.close()
})

test('pagehide synchronously preserves the last debounced editor input in bounded recovery state', async ({ page }) => {
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const marker = `% pagehide-${Date.now()}`
  await page.locator('.cm-content').click()
  await page.keyboard.type(marker)
  await expect.poll(() => page.evaluate(value => localStorage.getItem(projectStorageKey)?.includes(value) || false, marker)).toBe(false)
  const persisted = await page.evaluate(value => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
    const stored = JSON.parse(localStorage.getItem(projectStorageKey))
    return stored.recovery?.path === 'paper/main.tex' && stored.recovery.content.includes(value)
  }, marker)
  expect(persisted).toBe(true)
})

test('folder rename collision detection refuses to merge two file trees', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  const result = await page.evaluate(() => {
    state.files['paper/source/section.tex'] = 'source'
    state.files['paper/target/existing.tex'] = 'target'
    state.folders.push('paper/source', 'paper/target')
    return renameHasCollision('folder', 'paper/source', 'paper/target')
  })
  expect(result).toBe(true)
})

test('backup restore aborts instead of overwriting edits made while the snapshot loads', async ({ page }) => {
  let restoreFetchStarted = false
  let releaseRestoreResponse
  const restoreResponseGate = new Promise(resolve => { releaseRestoreResponse = resolve })
  await page.route('**/api/backups/projects/*/snapshots**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (request.method() === 'POST') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ snapshot: { id: 'protected', created_at: new Date().toISOString() } }) })
      return
    }
    if (pathname.endsWith('/restore-1')) {
      restoreFetchStarted = true
      await restoreResponseGate
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ payload: { title: 'Old', files: { 'paper/main.tex': '\\documentclass{article}\\begin{document}old snapshot\\end{document}' }, comments: [], tasks: [] } }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ snapshots: [] }) })
  })
  await page.goto('/')
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))
  await page.waitForFunction(() => backupInitialized && !backupBusy)
  await page.evaluate(() => {
    actionDialog = async () => true
    backupBusy = true
    backupIdlePromise = new Promise(resolve => setTimeout(() => {
      backupBusy = false
      resolve()
    }, 150))
    const button = document.createElement('button')
    window.restoreRegression = restoreServerBackup('restore-1', button)
  })
  await expect.poll(() => restoreFetchStarted).toBe(true)
  const marker = `% concurrent-${Date.now()}`
  await page.locator('.cm-content').click()
  await page.keyboard.type(marker)
  releaseRestoreResponse()
  await page.evaluate(() => window.restoreRegression)
  await expect(page.locator('#app-toasts')).toContainText('새 편집 내용이 감지되어')
  await expect.poll(() => page.evaluate(value => editorValue().includes(value), marker)).toBe(true)
  await expect.poll(() => page.evaluate(() => editorValue().includes('old snapshot'))).toBe(false)
})
