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
      description_ko: '한국어 설명입니다.'
    }] })
  }))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('heading', { name: 'Localized Paper' })).toBeVisible()
  await expect(page.locator('.project-card-copy')).toContainText('An English description.')
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
