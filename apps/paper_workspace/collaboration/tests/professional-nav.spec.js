import { expect, test } from './fixtures.js'

function installProfessionalProject(page, slug) {
  const sources = {
    'thesis.tex': '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\bibliography{bibliography/works}\n\\end{document}\n',
    'sections/intro.tex': 'Introduction.\n',
    'bibliography/works.bib': '@article{professional, title={Professional navigation}}\n',
    'notes.md': '# Notes\n',
    'archive/raw.bin': 'binary placeholder'
  }
  const assets = [
    { path: 'figures/chart.png', type: 'asset', size: 120 },
    { path: 'appendix.pdf', type: 'asset', size: 120 }
  ]
  return page.route(`**/p/${slug}/project/**`, async route => {
    const path = new URL(route.request().url()).pathname.split(`/p/${slug}/project/`)[1]
    if (path === 'project.json') return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: slug,
        version: '1',
        entrypoint: 'thesis.tex',
        files: [...Object.keys(sources).map(path => ({ path, managed: true })), ...assets]
      })
    })
    if (sources[path] !== undefined) return route.fulfill({ contentType: 'text/plain', body: sources[path] })
    return route.fulfill({ status: 404, body: '' })
  })
}

test('professional navigation uses semantic SVG file icons and a labeled shortcut list', async ({ page }) => {
  const slug = `professional-nav-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await installProfessionalProject(page, slug)
  await page.goto(`/p/${slug}?lang=en`)

  await expect(page.locator('#quick-nav-section')).toBeVisible()
  await expect(page.locator('#quick-nav-heading')).toHaveText('Quick navigation')
  await expect(page.locator('#quick-nav [data-shortcut-path="paper/thesis.tex"]')).toHaveAttribute('aria-label', 'Main manuscript: paper/thesis.tex')
  await expect(page.locator('#quick-nav [data-shortcut-path="paper/sections"] .file-icon-folder')).toBeVisible()
  await expect(page.locator('#quick-nav [data-shortcut-path="paper/bibliography/works.bib"] .file-icon-library')).toBeVisible()

  for (const [path, icon] of [
    ['paper/thesis.tex', 'code'],
    ['paper/bibliography/works.bib', 'library'],
    ['paper/notes.md', 'text'],
    ['paper/figures/chart.png', 'image'],
    ['paper/appendix.pdf', 'pdf'],
    ['paper/archive/raw.bin', 'other']
  ]) {
    const graphic = page.locator(`#files [data-file-path="${path}"] .file-icon-svg.file-icon-${icon}`)
    await expect(graphic).toHaveAttribute('width', '16')
    await expect(graphic).toHaveAttribute('stroke-width', '1.75')
  }
  expect(await page.locator('#files .file-icon').evaluateAll(icons => icons.every(icon => icon.children.length === 1 && icon.firstElementChild?.matches('svg.file-icon-svg')))).toBe(true)
})

test('the header current-file locator retains the existing filtered-tree behavior', async ({ page }) => {
  const slug = `professional-locate-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  await page.route('**/vendor/paper-collab.js*', route => route.abort())
  await installProfessionalProject(page, slug)
  await page.goto(`/p/${slug}?lang=en`)
  await page.locator('[data-file-path="paper/sections/intro.tex"]').click()

  const locator = page.locator('#locate-current-file')
  await expect(locator).toBeVisible()
  await expect(locator.locator('xpath=ancestor::div[contains(@class, "side-heading")]')).toHaveCount(1)
  await expect(page.locator('#quick-nav #locate-current-file')).toHaveCount(0)
  await expect(locator).toHaveAttribute('title', 'Find current file: paper/sections/intro.tex')
  await page.locator('#workspace-language').selectOption('ko')
  await expect(page.locator('#quick-nav [data-shortcut-path="paper/thesis.tex"]')).toHaveAttribute('aria-label', '메인 원고: paper/thesis.tex')
  await expect(locator).toHaveAttribute('title', '현재 파일 찾기: paper/sections/intro.tex')
  await page.locator('#workspace-language').selectOption('en')
  await expect(page.locator('#quick-nav [data-shortcut-path="paper/thesis.tex"]')).toHaveAttribute('aria-label', 'Main manuscript: paper/thesis.tex')
  await expect(locator).toHaveAttribute('title', 'Find current file: paper/sections/intro.tex')

  await page.locator('.folder-row[data-folder="paper/sections"]').click()
  await page.locator('#file-search').fill('works')
  await locator.click()

  await expect(page.locator('#file-search')).toHaveValue('')
  await expect(page.locator('.folder-row[data-folder="paper/sections"]')).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => page.evaluate(() => document.activeElement?.dataset.filePath)).toBe('paper/sections/intro.tex')
})
