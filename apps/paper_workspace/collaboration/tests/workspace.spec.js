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

test('server manuscript paints before collaboration bootstrap finishes', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => document.getElementById('editor')?.value || ''), { timeout: 1500 }).toContain('\\documentclass')
  await expect(page.locator('#files .file')).toHaveCount(2)
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
