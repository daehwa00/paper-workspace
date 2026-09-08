import { expect, test, namedContext } from './fixtures.js'

test('hub falls back to English and persists a language-picker choice', async ({ browser }) => {
  const context = await namedContext(browser, { locale: 'fr-FR' })
  const page = await context.newPage()
  await page.goto('/hub.html')

  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Paper Workspace' })).toBeVisible()
  await expect(page.locator('#project-search')).toHaveAttribute('placeholder', 'Search papers')
  await expect(page.locator('#hub-language-code')).toHaveText('English')
  await expect(page.locator('#hub-language')).toHaveCSS('opacity', '0')

  await page.locator('#hub-language').selectOption('ko')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await expect(page.getByRole('heading', { name: '논문 작업공간' })).toBeVisible()
  await expect(page.locator('#hub-language-code')).toHaveText('한국어')
  await expect(page).toHaveURL(/lang=ko/)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('paper-workspace-language'))).toBe('ko')
  await context.close()
})

test('language query overrides storage and localized project metadata follows it', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-workspace-language', 'ko'))
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [{
      slug: 'localized-paper',
      display_name_en: 'Localized Paper',
      display_name_ko: '다국어 논문',
      description_en: 'An English description.',
      description_ko: '한국어 설명입니다.',
      page_count: 13
    }] })
  }))
  await page.route('**/api/backups/activity', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [{
      project_id: 'localized-paper',
      actor: 'KDH',
      modified_at: '2026-07-13T04:25:00.000Z'
    }] })
  }))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Localized Paper' })).toBeVisible()
  await expect(page.locator('.project-card-copy')).toContainText('An English description.')
  await expect(page.locator('.project-page-count')).toHaveText('13p')
  await expect(page.locator('.project-activity')).toContainText('Last edited by KDH')
  await expect(page.locator('.project-page-count')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('paper-workspace-language'))).toBe('en')

  await page.locator('#hub-language').selectOption('ko')
  await expect(page.getByRole('heading', { name: '다국어 논문' })).toBeVisible()
  await expect(page.locator('.project-card-copy')).toContainText('한국어 설명입니다.')
  await expect(page.locator('.project-activity')).toContainText('KDH 수정')
})

test('a catalog entry without a manual thumbnail uses its generated PDF preview', async ({ page }) => {
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [{
      slug: 'automatic-paper',
      display_name: 'Automatic Paper',
      description: 'Generated from the first PDF page.'
    }] })
  }))
  await page.route('**/projects/automatic-paper/thumbnail.png', route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  }))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-thumbnail')).toHaveAttribute('src', '/projects/automatic-paper/thumbnail.png')
  await expect(page.locator('.project-thumbnail')).toBeVisible()
})

test('recent activity uses server timestamps and shows the latest editor', async ({ page }) => {
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [
      { slug: 'first', activity_id: 'internal-first', display_name: 'Catalog First', description: 'First.' },
      { slug: 'second', display_name: 'Catalog Second', description: 'Second.' },
      { slug: 'third', display_name: 'Catalog Third', description: 'Third.' }
    ] })
  }))
  await page.route('**/api/backups/activity', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [
      { project_id: 'internal-first', actor: 'Dae', modified_at: '2026-07-11T01:00:00.000Z' },
      { project_id: 'second', actor: 'KDH', modified_at: '2026-07-13T01:00:00.000Z' },
      { project_id: 'third', actor: 'Me', modified_at: '2026-07-12T01:00:00.000Z' }
    ] })
  }))

  await page.goto('/hub.html?lang=ko')
  await expect(page.locator('.project-card h3')).toHaveText(['Catalog Second', 'Catalog Third', 'Catalog First'])
  await expect(page.locator('.project-activity').first()).toContainText('KDH 수정')
})

test('an available but empty activity response remains distinct from an activity lookup failure', async ({ page }) => {
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ projects: [{ slug: 'available', display_name: 'Available paper' }] })
  }))
  await page.route('**/api/backups/activity', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ projects: [] }) }))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('#project-list')).toHaveAttribute('data-activity-status', 'available')
  await expect(page.locator('.project-activity')).toHaveText('No edit history yet')
})

test('a supported browser locale is used when no explicit preference exists', async ({ browser }) => {
  const context = await namedContext(browser, { locale: 'ko-KR' })
  const page = await context.newPage()
  await page.goto('/hub.html')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await expect(page.getByRole('heading', { name: '논문 작업공간' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('paper-workspace-language'))).toBe(null)
  await context.close()
})

test('project grid uses responsive left-aligned rows while card content stays aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [
      { slug: 'short', display_name: 'Short Paper', description: 'Short description.', page_count: 1 },
      { slug: 'long-title', display_name: 'A Much Longer Research Paper Title That Uses Every Available Title Line', description: 'Short description.', page_count: 12 },
      { slug: 'long-copy', display_name: 'Medium Paper', description: 'A longer project description that occupies both available lines in the compact gallery card.', page_count: 28 },
      { slug: 'fourth', display_name: 'Fourth Paper', description: 'Another short description.', page_count: 8 },
      { slug: 'fifth', display_name: 'Fifth Paper With a Deliberately Long Title for Alignment', description: 'The final project in an incomplete row.', page_count: 16 },
      { slug: 'sixth', display_name: 'Sixth Paper', description: 'A different description length keeps the card row honest.', page_count: 4 },
      { slug: 'seventh', display_name: 'Seventh Paper', description: 'The final, left-aligned card.', page_count: 16 }
    ] })
  }))
  await page.route('**/api/backups/activity', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ projects: [] })
  }))
  await page.route('**/projects/*/thumbnail.png', route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  }))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-card')).toHaveCount(7)

  const layout = async () => page.locator('.project-grid').evaluate(grid => {
    const box = grid.getBoundingClientRect()
    const cards = [...grid.querySelectorAll('.project-card')].map(card => {
      const cardBox = card.getBoundingClientRect()
      const metaBox = card.querySelector('.project-meta')?.getBoundingClientRect()
      const copyBox = card.querySelector('.project-card-copy p')?.getBoundingClientRect()
      return {
        left: cardBox.left,
        top: cardBox.top,
        right: cardBox.right,
        bottom: cardBox.bottom,
        height: cardBox.height,
        metaBottom: metaBox?.bottom,
        copyTop: copyBox?.top
      }
    })
    return { grid: { left: box.left, right: box.right, width: box.width }, cards }
  })
  const rows = result => Object.values(result.cards.reduce((grouped, card) => {
    const top = Math.round(card.top)
    grouped[top] = [...(grouped[top] || []), card]
    return grouped
  }, {}))
  const rowCounts = result => rows(result).map(row => row.length)
  const expectRows = async (viewport, counts) => {
    await page.setViewportSize(viewport)
    const result = await layout()
    expect(rowCounts(result)).toEqual(counts)
    expect(Math.abs(rows(result).at(-1)[0].left - result.grid.left)).toBeLessThan(2)
    return result
  }

  const desktop = await expectRows({ width: 1600, height: 900 }, [4, 3])
  const firstRow = desktop.cards.slice(0, 4)
  expect(desktop.grid.width).toBeLessThanOrEqual(1440)
  expect(new Set(firstRow.map(card => Math.round(card.height))).size).toBe(1)
  expect(new Set(firstRow.map(card => Math.round(card.bottom))).size).toBe(1)
  expect(new Set(firstRow.map(card => Math.round(card.metaBottom))).size).toBe(1)
  expect(new Set(firstRow.map(card => Math.round(card.copyTop))).size).toBe(1)
  expect(Math.round(await page.locator('.project-thumbnail-wrap').first().evaluate(item => item.getBoundingClientRect().width))).toBe(144)
  await expect(page.locator('.project-card h3').first()).toHaveCSS('font-size', '18px')
  await expect(page.locator('.project-activity').first()).toHaveCSS('font-size', '12px')
  await expect(page.locator('.hub-intro')).toHaveCSS('padding-top', '20px')

  await expectRows({ width: 1200, height: 900 }, [3, 3, 1])
  await expectRows({ width: 800, height: 900 }, [2, 2, 2, 1])
  await expectRows({ width: 390, height: 844 }, [1, 1, 1, 1, 1, 1, 1])
  expect(Math.round(await page.locator('.project-thumbnail-wrap').first().evaluate(item => item.getBoundingClientRect().width))).toBe(128)
  await expect(page.locator('.project-card h3').first()).toHaveCSS('min-height', '0px')
})

test('stacked search and sort controls keep the chevron inside the select', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto('/hub.html?lang=ko')
  const select = await page.locator('#project-sort').boundingBox()
  const chevron = await page.locator('.project-sort-label svg').boundingBox()
  const search = await page.locator('.search').boundingBox()
  expect(chevron.x + chevron.width).toBeLessThanOrEqual(select.x + select.width)
  expect(Math.abs(select.width - search.width)).toBeLessThanOrEqual(1)
})
