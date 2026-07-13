import { expect, test } from '@playwright/test'

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

test('quota fallback fingerprints server snapshots and retains only recent local drafts', async ({ page }) => {
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
      if (!rejectedProjectWrite && String(key).startsWith('paper-workspace:')) {
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
    return window.__quotaFallbackTriggered && stored.serverMainSnapshot?.startsWith('fp1:')
  })
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('paper-workspace:default')))
  expect(persisted.serverMainSnapshot).toMatch(/^fp1:/)
  expect(persisted.serverSourceSnapshots['paper/references.bib']).toMatch(/^fp1:/)
  expect(Object.keys(persisted.files).filter(path => path.startsWith('paper/drafts/')).length).toBeLessThanOrEqual(3)
  expect(persisted.files['paper/main.tex']).toContain('\\documentclass')
})

test('workspace core normalizes persisted state without DOM dependencies', async ({ page }) => {
  await page.goto('/')
  const normalized = await page.evaluate(() => {
    const core = window.PaperWorkspaceCore
    const state = core.normalizeState({
      files: { 'main.tex': 'legacy source' },
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
      extension: core.extensionOf('paper/FIGURE.PDF'),
      parent: core.parentPath('paper/sections/intro.tex')
    }
  })
  expect(normalized).toEqual({
    current: 'paper/main.tex',
    files: { 'paper/main.tex': 'legacy source' },
    folders: ['paper'],
    taskCount: 1,
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
  await expect(page.locator('#files .file')).toHaveCount(2)
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
})

test('PDF loading uses a minimal status indicator', async ({ page }) => {
  await page.route('**/api/compile', () => new Promise(() => {}))
  await page.goto('/')
  const spinner = page.locator('#paper-preview .pdf-spinner')
  await expect(spinner).toBeVisible()
  await expect(spinner).toHaveCSS('width', '22px')
  await expect(spinner).toHaveCSS('height', '22px')
  await expect(spinner).toHaveCSS('box-shadow', 'none')
  await expect(page.locator('#paper-preview .pdf-wait strong')).toHaveText('PDF 준비 중')
  await expect(page.locator('#paper-preview .pdf-wait-detail')).toHaveCSS('width', '1px')
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
  await expect(page.locator('.tree-action').first()).toHaveCSS('background-color', 'rgb(24, 34, 53)')
  await expect(page.locator('.assistant-header-actions .beta')).toHaveCSS('background-color', 'rgb(23, 43, 82)')
  await page.getByRole('tab', { name: '검사' }).click()
  await expect(page.locator('#run-submission-checks')).toHaveCSS('background-color', 'rgb(53, 107, 217)')
  await expect(page.locator('.diagnostic-item').first()).toHaveCSS('background-color', 'rgb(58, 32, 37)')
  await page.locator('#files .folder-row').first().click({ button: 'right' })
  await expect(page.locator('#tree-menu button').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await page.locator('#collab-name').click()
  await expect(page.locator('.name-dialog .quiet-dialog')).toHaveCSS('background-color', 'rgb(24, 34, 53)')
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
      mask: [page.locator('#save-state'), page.locator('#render-state'), page.locator('#collab-status'), page.locator('#collab-label'), page.locator('#collab-name'), page.locator('#app-toasts')]
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
