import { expect, test } from './fixtures.js'

async function fixture(page, slug, entrypoint = 'main.tex') {
  const sources = { [entrypoint]: '\\documentclass{article}\n\\begin{document}\n\\input{sections/body}\n\\end{document}', 'sections/body.tex': 'Editable body text.\n' }
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await page.route(`**/p/${slug}/project/**`, route => {
    const name = new URL(route.request().url()).pathname.split('/project/')[1]
    if (name === 'project.json') return route.fulfill({ json: { id: slug, version: '1', entrypoint, files: Object.keys(sources).map(path => ({ path, managed: true })) } })
    return sources[name] === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'text/plain', body: sources[name] })
  })
}

test('pinning main keeps body edits in the full document and remembers the choice per project', async ({ page }) => {
  const slug = `pin-main-${Date.now()}`
  const requests = []
  await fixture(page, slug)
  await page.route('**/api/compile', route => { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 422, json: { error: 'isolated compile fixture' } }) })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(() => workspaceReadyForCompile)
  await page.locator('[data-file-path="paper/sections/body.tex"]').click()
  await expect.poll(() => requests.at(-1)?.entrypoint).toBe('sections/body.tex')
  await page.evaluate(() => setEditorSelection(2, 9))
  await page.locator('#pin-main-compile').click()
  await expect.poll(() => requests.at(-1)?.entrypoint).toBe('main.tex')
  expect(requests.at(-1).preview_mode).toBe('document')
  expect(await page.evaluate(() => editorSelection())).toEqual({ start: 2, end: 9 })
  await expect(page.locator('#active-file')).toHaveText('paper/sections/body.tex')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('New body edit')
  await expect.poll(() => requests.at(-1)?.files['sections/body.tex']).toContain('New body edit')
  expect(requests.at(-1).entrypoint).toBe('main.tex')
  await page.reload()
  await expect(page.locator('#pin-main-compile')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForFunction(() => workspaceReadyForCompile)
  await page.locator('#workspace-language').selectOption('ko')
  await expect(page.locator('#pin-main-compile')).toHaveAttribute('aria-label', '본문 고정 해제: main.tex')
  const other = `${slug}-other`
  await fixture(page, other)
  await page.goto(`/p/${other}`)
  await expect(page.locator('#pin-main-compile')).toHaveAttribute('aria-pressed', 'false')
})

test('unpinning resumes fragment previews and the pinned target follows the manifest', async ({ page }) => {
  const slug = `pin-thesis-${Date.now()}`
  await fixture(page, slug, 'thesis.tex')
  const requests = []
  await page.route('**/api/compile', route => { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 422, json: { error: 'isolated compile fixture' } }) })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(() => workspaceReadyForCompile)
  await page.locator('[data-file-path="paper/sections/body.tex"]').click()
  await page.locator('#pin-main-compile').click()
  await expect.poll(() => requests.at(-1)?.entrypoint).toBe('thesis.tex')
  expect(requests.at(-1).root_entrypoint).toBe('thesis.tex')
  expect(requests.at(-1).preview_mode).toBe('document')
  await page.locator('#pin-main-compile').click()
  await expect.poll(() => requests.at(-1)?.entrypoint).toBe('sections/body.tex')
  expect(requests.at(-1).preview_mode).toBe('fragment')
})

for (const width of [320, 390]) {
  test(`pin control remains keyboard-accessible and contained at ${width}px`, async ({ page }) => {
    await fixture(page, `pin-mobile-${width}`)
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/p/pin-mobile-${width}?lang=en`)
    await page.waitForFunction(() => workspaceReadyForCompile)
    await page.locator('[data-focus="preview"]').click()
    await page.locator('#pin-main-compile').focus()
    await page.keyboard.press(' ')
    await expect(page.locator('#pin-main-compile')).toHaveAttribute('aria-pressed', 'true')
    const geometry = await page.locator('.preview-header').evaluate(header => {
      const bounds = header.getBoundingClientRect()
      return [...header.querySelectorAll('button')].filter(el => el.getClientRects().length).map(el => {
        const box = el.getBoundingClientRect()
        return box.left >= bounds.left && box.right <= bounds.right && box.width >= 43.99
      })
    })
    expect(geometry.every(Boolean)).toBe(true)
    expect(await page.evaluate(() => document.body.scrollWidth)).toBe(width)
  })
}

test('pinning invalidates an in-flight fragment request without changing the editor', async ({ page }) => {
  const slug = `pin-race-${Date.now()}`
  await fixture(page, slug)
  let fragmentStarted = false, releaseFragment
  const held = new Promise(resolve => { releaseFragment = resolve })
  await page.route('**/api/compile', async route => {
    if (route.request().postDataJSON().entrypoint === 'sections/body.tex') {
      fragmentStarted = true
      await held
    }
    await route.fulfill({ status: 422, json: { error: 'isolated response' } })
  })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(() => workspaceReadyForCompile)
  await page.locator('[data-file-path="paper/sections/body.tex"]').click()
  await expect.poll(() => fragmentStarted).toBe(true)
  const before = await page.locator('#editor').inputValue()
  await page.locator('#pin-main-compile').click()
  await expect(page.locator('#render-state')).toContainText('main.tex')
  releaseFragment()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('#render-state')).toContainText('main.tex')
  await expect(page.locator('#editor')).toHaveValue(before)
  await expect(page.locator('#active-file')).toHaveText('paper/sections/body.tex')
})
