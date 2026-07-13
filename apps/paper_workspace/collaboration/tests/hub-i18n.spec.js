import { expect, test } from '@playwright/test'

test('hub falls back to English and persists a language-picker choice', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-FR' })
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

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Localized Paper' })).toBeVisible()
  await expect(page.locator('.project-card-copy')).toContainText('An English description.')
  await expect(page.locator('.project-page-count')).toHaveText('13p')
  await expect(page.locator('.project-page-count')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('paper-workspace-language'))).toBe('en')

  await page.locator('#hub-language').selectOption('ko')
  await expect(page.getByRole('heading', { name: '다국어 논문' })).toBeVisible()
  await expect(page.locator('.project-card-copy')).toContainText('한국어 설명입니다.')
})

test('a supported browser locale is used when no explicit preference exists', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ko-KR' })
  const page = await context.newPage()
  await page.goto('/hub.html')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko')
  await expect(page.getByRole('heading', { name: '논문 작업공간' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('paper-workspace-language'))).toBe(null)
  await context.close()
})

test('project cards share a row height despite different title and description lengths', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [
      { slug: 'short', display_name: 'Short Paper', description: 'Short description.', page_count: 1 },
      { slug: 'long-title', display_name: 'A Much Longer Research Paper Title That Wraps Across Several Lines', description: 'Short description.', page_count: 12 },
      { slug: 'long-copy', display_name: 'Medium Paper', description: 'A longer project description that occupies both available lines in the compact gallery card.', page_count: 28 }
    ] })
  }))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-card')).toHaveCount(3)
  const boxes = await page.locator('.project-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect()))
  const metaBoxes = await page.locator('.project-meta').evaluateAll(items => items.map(item => item.getBoundingClientRect()))
  expect(new Set(boxes.map(box => Math.round(box.height))).size).toBe(1)
  expect(new Set(boxes.map(box => Math.round(box.bottom))).size).toBe(1)
  expect(new Set(metaBoxes.map(box => Math.round(box.bottom))).size).toBe(1)
})
