import { test, expect } from './fixtures.js'

const colors = ['#2457d6', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777']

async function expectReadable(locator) {
  await expect.poll(() => locator.evaluate(element => {
    if (!element.isConnected) return 0
    const luminance = color => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
      return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0)
    }
    const style = getComputedStyle(element)
    const foreground = luminance(style.color), background = luminance(style.backgroundColor)
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  })).toBeGreaterThanOrEqual(4.5)
}

for (const theme of ['light', 'dark']) {
  test(`profile and collaborator initials and cursor labels retain contrast in ${theme}`, async ({ page, browser }) => {
    await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
    const project = `/p/contrast-${theme}-${Date.now()}`
    await page.goto(project)
    await page.waitForFunction(() => projectBootstrapComplete && collabReady)
    await expect(page.locator('#project-presence')).toBeHidden()
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
    // Use a real awareness peer so provider updates cannot erase a synthetic
    // entry inserted directly into the application's collaborators map.
    const peerContext = await browser.newContext()
    try {
      await peerContext.addInitScript(() => {
        localStorage.setItem('collab-name', 'Peer Author')
        localStorage.setItem('collab-name-user-set', '1')
      })
      const peer = await peerContext.newPage()
      await peer.goto(new URL(project, page.url()).href)
      await peer.waitForFunction(() => projectBootstrapComplete && collabReady)
      await peer.locator('#editor-view .cm-content').click()
      await peer.keyboard.press('Control+Home')
      const avatar = page.locator('#project-presence-avatars .project-presence-avatar').filter({ hasText: 'PA' })
      await expect(page.locator('#project-presence')).toBeVisible()
      await expect(page.locator('#project-presence-avatars .project-presence-avatar')).toHaveCount(1)
      const cursor = page.locator('.remote-cursor-label').filter({ hasText: 'Peer Author' })
      for (const color of colors) {
        await page.evaluate(color => {
          localStorage.setItem('collab-color', color)
          window.dispatchEvent(new StorageEvent('storage', { key: 'collab-color' }))
        }, color)
        await peer.evaluate(color => {
          localStorage.setItem('collab-color', color)
          window.dispatchEvent(new StorageEvent('storage', { key: 'collab-color' }))
        }, color)
        await expect(avatar).toHaveCSS('background-color', `rgb(${color.slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ')})`)
        await expectReadable(page.locator('#collab-name'))
        await expectReadable(avatar)
        await expectReadable(cursor)
        expect(await page.evaluate(() => localStorage.getItem('collab-color'))).toBe(color)
      }
    } finally {
      await peerContext.close()
    }
    await expect(page.locator('#project-presence')).toBeHidden()
  })

  test(`hub and rebuttal profile initials retain contrast in ${theme}`, async ({ page }) => {
    await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
    await page.route('**/_auth/verify', route => route.fulfill({ status: 200, json: {} }))
    await page.goto('/hub.html')
    await expect(page.locator('#hub-collab-name')).toBeVisible()
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
    for (const color of colors) {
      await page.evaluate(color => {
        localStorage.setItem('collab-color', color)
        window.dispatchEvent(new StorageEvent('storage', { key: 'collab-color' }))
      }, color)
      await expectReadable(page.locator('#hub-collab-name'))
    }
    await page.route('**/api/rebuttal/projects/**', route => route.fulfill({ json: { schema_version: 1, revision: 0, enabled: true, rounds: [], jobs: [] } }))
    for (const color of colors) {
      await page.evaluate(color => localStorage.setItem('collab-color', color), color)
      await page.goto(`/p/contrast-${theme}/rebuttal`)
      const iframe = page.locator('iframe.paper-review-frame')
      await expect(iframe).toHaveClass(/is-active/)
      const profile = page.frameLocator('iframe.paper-review-frame').getByRole('button', { name: 'Change display name', exact: true })
      await expect(profile).toHaveText('TA')
      await expect(profile).toHaveCSS('background-color', `rgb(${color.slice(1).match(/../g).map(value => parseInt(value, 16)).join(', ')})`)
      await expectReadable(profile)
    }
  })
}
