import { expect, test } from './fixtures.js'

async function openWorkspace(page) {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/?lang=en')
  await page.waitForFunction(() => workspaceReadyForCompile)
  await page.evaluate(() => setEditorSelection(0, 14))
}

test('a new conversation can send immediately while the old request is pending', async ({ page }) => {
  let releaseOld
  const oldResponse = new Promise(resolve => { releaseOld = resolve })
  const requests = []
  await page.route('**/api/codex', async route => {
    const payload = route.request().postDataJSON()
    requests.push(payload)
    if (payload.instruction === 'Old request') await oldResponse
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ replacement: payload.instruction, summary: 'Done' }) }).catch(() => {})
  })
  try {
    await openWorkspace(page)
    await page.locator('#instruction').fill('Old request')
    await page.locator('#instruction').press('Enter')
    await expect.poll(() => requests.length).toBe(1)
    await expect(page.locator('#ask')).toBeDisabled()
    await page.locator('#codex-new-request').click()
    await expect(page.locator('#ask')).toBeEnabled()
    await page.locator('#instruction').fill('New request')
    await page.locator('#instruction').press('Enter')
    await expect(page.locator('.codex-result')).toContainText('New request')
    expect(requests[1].history).toEqual([])
    releaseOld()
    await expect(page.locator('.codex-result')).not.toContainText('Old request')
  } finally { releaseOld() }
})

test('a superseded inline request cannot replace the newest proposal or conversation', async ({ page }) => {
  let releaseOld
  const oldResponse = new Promise(resolve => { releaseOld = resolve })
  const requests = []
  await page.route('**/api/codex', async route => {
    const payload = route.request().postDataJSON()
    requests.push(payload)
    if (payload.instruction === 'Old inline request') await oldResponse
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ replacement: payload.instruction, summary: 'Done' }) }).catch(() => {})
  })
  try {
    await openWorkspace(page)
    await page.evaluate(() => {
      const selection = selectedEditorRange()
      window.oldCodexRequest = requestCodexRevision(selection, 'Old inline request')
    })
    await expect.poll(() => requests.length).toBe(1)
    await page.evaluate(() => requestCodexRevision(selectedEditorRange(), 'New inline request'))
    await expect(page.locator('.codex-result')).toContainText('New inline request')
    releaseOld()
    await page.evaluate(() => window.oldCodexRequest)
    await expect(page.locator('.codex-result')).toContainText('New inline request')
    const conversation = await page.evaluate(() => codexConversation)
    expect(conversation).toHaveLength(2)
    expect(conversation[0].content).toBe('New inline request')
    expect(conversation[1].content).toContain('New inline request')
    await expect(page.locator('#ask')).toBeEnabled()
  } finally { releaseOld() }
})

for (const direction of ['source-to-pdf', 'pdf-to-source']) {
  test(`a ${direction} navigation error preserves the Codex proposal`, async ({ page }) => {
    await page.route('**/api/codex', route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ replacement: 'Keep this proposal', summary: 'Done' })
    }))
    await page.route('**/api/synctex*', route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Navigation unavailable' })
    }))
    await openWorkspace(page)
    await page.evaluate(() => requestCodexRevision(selectedEditorRange(), 'Revise selection'))
    await expect(page.locator('.codex-result')).toContainText('Keep this proposal')
    await page.evaluate(async direction => {
      renderedSynctex = 'id:1234567890abcdef12345678'
      setPdfFreshness(false)
      if (direction === 'source-to-pdf') await syncSourceToPdf()
      else await syncPdfToSource(1, 10, 10)
    }, direction)
    await expect(page.locator('.codex-result')).toContainText('Keep this proposal')
    await expect(page.locator('#apply-codex')).toBeEnabled()
    await expect(page.locator('#app-toasts')).toContainText('Navigation unavailable')
  })
}
