import { expect, test } from '@playwright/test'

async function blockLocalStorage (page, mode) {
  await page.addInitScript(storageMode => {
    const unavailable = () => { throw new DOMException('localStorage is unavailable', storageMode === 'quota' ? 'QuotaExceededError' : 'SecurityError') }
    const native = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: storageMode === 'blocked' ? unavailable : native.getItem.bind(native),
        setItem: unavailable,
        removeItem: storageMode === 'blocked' ? unavailable : native.removeItem.bind(native)
      }
    })
  }, mode)
}

async function expectWorkspaceToInitialize (page) {
  await page.goto('/')
  await expect(page.locator('.cm-content')).toBeVisible({ timeout: 2000 })
  await expect.poll(() => page.evaluate(() => editorValue())).toContain('\\documentclass')
  await expect(page.locator('#project-title')).not.toHaveValue('Untitled Paper')
}

test('blocked localStorage does not prevent the hub or workspace from loading', async ({ page }) => {
  await blockLocalStorage(page, 'blocked')
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [{ slug: 'available', display_name: 'Available paper' }] })
  }))

  await page.goto('/hub.html?lang=en')
  await expect(page.locator('.project-card')).toContainText('Available paper')
  await expectWorkspaceToInitialize(page)
})

test('full localStorage quota does not prevent optional preference changes', async ({ page }) => {
  await blockLocalStorage(page, 'quota')
  await page.route('**/projects/index.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ projects: [{ slug: 'available', display_name: 'Available paper' }] })
  }))

  await page.goto('/hub.html?lang=en')
  await page.locator('#project-sort').selectOption('name')
  await page.locator('.theme-trigger').click()
  await page.locator('input[name="workspace-theme"][value="dark"]').check()
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark')
  await page.locator('.theme-dialog').press('Escape')
  await page.locator('.theme-trigger').click()
  await expect(page.locator('input[name="workspace-theme"][value="dark"]')).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark')
  await expectWorkspaceToInitialize(page)
})

test('available preference storage persists choices and observes changes from another tab', async ({ page }) => {
  await page.goto('/hub.html?lang=en')
  await page.locator('.theme-trigger').click()
  await page.locator('input[name="workspace-theme"][value="dark"]').check()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark')
  await page.evaluate(() => {
    localStorage.setItem('paper-workspace-theme', 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: 'paper-workspace-theme', newValue: 'light' }))
  })
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light')
})
