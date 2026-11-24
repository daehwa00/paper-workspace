import { expect, test, namedContext } from './fixtures.js'

test('hub falls back to English and persists a language-picker choice', async ({ browser }) => {
  const context = await namedContext(browser, { locale: 'fr-FR' })
  const page = await context.newPage()
  await page.goto('/hub.html')

  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Paper Workspace' })).toBeVisible()
  await expect(page.locator('#project-search')).toHaveCount(0)
  await expect(page.locator('.hub-page-header h2')).toHaveText('All papers')
  await expect(page.locator('.hub-page-header [data-i18n="hub.projectsEyebrow"],.hub-location-divider')).toHaveCount(0)
  await expect(page.locator('#hub-language-code')).toHaveText('English')
  await expect(page.locator('#hub-language')).toHaveCSS('opacity', '0')

  await page.locator('#hub-language').selectOption('ko')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await expect(page.getByRole('heading', { name: 'Paper Workspace' })).toBeVisible()
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
  await expect(page.locator('.project-activity')).toContainText('KDH')
  await expect(page.locator('.project-page-count')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('paper-workspace-language'))).toBe('en')

  await page.locator('#hub-language').selectOption('ko')
  await expect(page.getByRole('heading', { name: '다국어 논문' })).toBeVisible()
  await expect(page.locator('.project-card-copy')).toContainText('한국어 설명입니다.')
  await expect(page.locator('.project-activity')).toContainText('KDH')
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
  await expect(page.locator('.project-activity').first()).toContainText('KDH')
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
  await expect(page.getByRole('heading', { name: 'Paper Workspace' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('paper-workspace-language'))).toBe(null)
  await context.close()
})

test('project list keeps long content within the compact application frame', async ({ page }) => {
  await page.route('**/projects/index.json', route => route.fulfill({ json: { projects: [
    { slug: 'short', display_name: 'Short Paper', description: 'Short description.', page_count: 1 },
    { slug: 'long', display_name: 'A Much Longer Research Paper Title That Uses Every Available Title Line', description: '한국어와 English를 함께 사용하는 매우 긴 논문 설명도 목록의 너비를 벗어나지 않아야 합니다.', page_count: 28 }
  ] } }))
  await page.route('**/api/backups/activity', route => route.fulfill({ json: { projects: [] } }))
  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-card')).toHaveCount(2)
  for (const width of [1600, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      cards: [...document.querySelectorAll('.project-card')].map(node => {
        const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }
      })
    }))
    expect(layout.overflow).toBe(false)
    expect(layout.cards[1].y).toBeGreaterThanOrEqual(layout.cards[0].y + layout.cards[0].height)
    expect(layout.cards[0].x).toBe(layout.cards[1].x)
    expect(layout.cards[0].width).toBe(layout.cards[1].width)
  }
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(page.locator('.hub-topbar')).toHaveCSS('width', '244px')
  await expect(page.locator('.hub-page-header')).toHaveCSS('height', '44px')
  await expect(page.locator('.project-card h3').first()).toHaveCSS('font-size', '13px')
})

test('mobile sort property trigger preserves its hit target without a search field', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/hub.html?lang=ko')
  const trigger = page.locator('#project-sort').locator('..').locator('.property-trigger')
  const box = await trigger.boundingBox()
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await expect(page.locator('.search')).toHaveCount(0)
  await trigger.click()
  await expect(page.locator('.property-menu:visible .property-option')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

test('activity and venue columns align across different label lengths',async({page})=>{
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[
    {slug:'one',display_name:'One',updated_at:'ICLR 2027',page_count:16},
    {slug:'two',display_name:'Two',updated_at:'arXiv',page_count:9}
  ]}}))
  await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[
    {project_id:'one',actor:'DH',modified_at:'2026-09-26T09:52:00Z'},
    {project_id:'two',actor:'KDH',modified_at:'2026-08-25T03:32:00Z'}
  ]}}))
  await page.goto('/hub.html?lang=ko')
  await expect(page.locator('.project-actor')).toHaveCount(2)
  await expect(page.locator('.project-activity').first()).not.toContainText('수정')
  for(const width of [1644,1024,390]){
    await page.setViewportSize({width,height:900})
    for(const selector of ['.project-actor','.project-activity-time','.project-meta','.project-page-count']){
      const boxes=await page.locator(selector).evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,width:n.getBoundingClientRect().width})))
      expect(boxes[0].x).toBeCloseTo(boxes[1].x,0)
      expect(boxes[0].width).toBeCloseTo(boxes[1].width,0)
    }
  }
})
