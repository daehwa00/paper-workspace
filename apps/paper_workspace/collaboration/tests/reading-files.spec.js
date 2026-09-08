import { expect, test } from './fixtures.js'

function installReadingProject(page, slug) {
  const sources = {
    'thesis.tex': '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\bibliography{bibliography/works}\n\\end{document}\n',
    'sections/intro.tex': 'The introduction stays in its own file.\n',
    'bibliography/works.bib': '@article{reading, title={Reading files}}\n',
    'other/notes.tex': 'Unrelated notes.\n'
  }
  return page.route(`**/p/${slug}/project/**`, async route => {
    const path = new URL(route.request().url()).pathname.split(`/p/${slug}/project/`)[1]
    if (path === 'project.json') return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: slug,
        version: '1',
        entrypoint: 'thesis.tex',
        files: Object.keys(sources).map(path => ({ path, managed: true }))
      })
    })
    if (sources[path] !== undefined) return route.fulfill({ contentType: 'text/plain', body: sources[path] })
    return route.fulfill({ status: 404, body: '' })
  })
}

test('quick navigation uses the manifest entrypoint and actual project paths', async ({ page }) => {
  const slug = `reading-shortcuts-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await installReadingProject(page, slug)
  await page.goto(`/p/${slug}`)

  await expect(page.locator('[data-shortcut-path="paper/thesis.tex"]')).toBeVisible()
  await expect(page.locator('[data-shortcut-path="paper/sections"]')).toBeVisible()
  await expect(page.locator('[data-shortcut-path="paper/bibliography/works.bib"]')).toBeVisible()
  await expect(page.locator('[data-shortcut-path="paper/main.tex"]')).toHaveCount(0)

  await page.locator('[data-shortcut-path="paper/thesis.tex"]').click()
  await expect(page.locator('#active-file')).toContainText('paper/thesis.tex')
  await page.locator('[data-shortcut-path="paper/sections"]').click()
  await expect.poll(() => page.evaluate(() => document.activeElement?.dataset.folder)).toBe('paper/sections')
  await page.locator('[data-shortcut-path="paper/bibliography/works.bib"]').click()
  await expect(page.locator('#active-file')).toContainText('paper/bibliography/works.bib')
})

test('finding the current file clears search and expands only its ancestors', async ({ page }) => {
  const slug = `reading-locate-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await installReadingProject(page, slug)
  await page.goto(`/p/${slug}`)
  await expect(page.locator('[data-file-path="paper/sections/intro.tex"]')).toBeVisible()

  await page.locator('[data-file-path="paper/sections/intro.tex"]').click()
  await page.locator('.folder-row[data-folder="paper/sections"]').click()
  await page.locator('.folder-row[data-folder="paper/other"]').click()
  await expect(page.locator('.folder-row[data-folder="paper/sections"]')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.folder-row[data-folder="paper/other"]')).toHaveAttribute('aria-expanded', 'false')

  await page.locator('#file-search').fill('works')
  await page.locator('#locate-current-file').click()

  await expect(page.locator('#file-search')).toHaveValue('')
  await expect(page.locator('.folder-row[data-folder="paper/sections"]')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.folder-row[data-folder="paper/other"]')).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => page.evaluate(() => document.activeElement?.dataset.filePath)).toBe('paper/sections/intro.tex')
})

test('quick file opening keeps each editor document history isolated', async ({ page }) => {
  const slug = `reading-history-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await installReadingProject(page, slug)
  await page.goto(`/p/${slug}`)
  await expect(page.locator('[data-file-path="paper/sections/intro.tex"]')).toBeVisible()

  await page.locator('[data-file-path="paper/sections/intro.tex"]').click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Changed')
  await expect(page.locator('#editor')).toHaveValue(/Changed/)
  await page.locator('[data-shortcut-path="paper/bibliography/works.bib"]').click()
  await expect(page.locator('#active-file')).toContainText('paper/bibliography/works.bib')
  await page.locator('[data-file-path="paper/sections/intro.tex"]').click()
  await page.locator('.cm-content').click()
  await page.keyboard.press(`${modifier}+z`)
  await expect(page.locator('#editor')).not.toHaveValue(/Changed/)
})


test('quick navigation keeps keyboard focus on desktop and moves it into the mobile editor', async ({ page }) => {
  const slug = `reading-focus-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await installReadingProject(page, slug)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/p/${slug}?lang=en`)
  const bibliography = page.locator('[data-shortcut-path="paper/bibliography/works.bib"]')
  await expect(bibliography).toHaveAttribute('aria-label', 'References: paper/bibliography/works.bib')
  await bibliography.focus()
  await page.keyboard.press('Enter')
  await expect(bibliography).toBeFocused()
  await expect(bibliography).toHaveAttribute('aria-current', 'page')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-focus="files"]').click()
  const entrypoint = page.locator('[data-shortcut-path="paper/thesis.tex"]')
  await entrypoint.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#active-file')).toContainText('paper/thesis.tex')
  await expect(page.locator('.cm-content')).toBeFocused()
})
