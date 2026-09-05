import { expect, test } from '@playwright/test'

const editorValue = page => page.locator('#editor').inputValue()

async function focusEditor(page) {
  await page.locator('#editor-view .cm-content').click()
}

test('undo and redo histories remain with the file that created them', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`/p/regression-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await page.waitForFunction(() => document.getElementById('editor')?.value.includes('\\documentclass'))

  await page.locator('#new-file').focus()
  await page.keyboard.press('Enter')
  await page.locator('#action-dialog-input').fill('history-b.tex')
  await page.locator('#action-dialog-confirm').click()
  await expect(page.locator('#active-file')).toHaveText('paper/history-b.tex')
  const bOriginal = await editorValue(page)

  await page.locator('#files [data-file-path="paper/main.tex"]').click()
  await focusEditor(page)
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n% file-a-history')
  await expect.poll(() => editorValue(page)).toContain('% file-a-history')

  await page.locator('#files [data-file-path="paper/history-b.tex"]').click()
  await focusEditor(page)
  await page.keyboard.press('Control+z')
  await expect.poll(() => editorValue(page)).toBe(bOriginal)

  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n% file-b-history')
  await expect.poll(() => editorValue(page)).toContain('% file-b-history')
  await page.keyboard.press('Control+z')
  await expect.poll(() => editorValue(page)).toBe(bOriginal)

  await page.locator('#files [data-file-path="paper/main.tex"]').click()
  await focusEditor(page)
  await page.keyboard.press('Control+z')
  await expect.poll(() => editorValue(page)).not.toContain('% file-a-history')
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => editorValue(page)).toContain('% file-a-history')
})

test('same-file external changes map through local undo history', async ({ page }) => {
  await page.goto(`/p/regression-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await page.waitForFunction(() => window.PaperEditor?.createEditor)
  await page.evaluate(() => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const editor = window.PaperEditor.createEditor({ parent, value: 'seed' })
    editor.setDocument('paper/history.tex', 'seed')
    editor.setSelection(4)
    editor.focus()
    window.__editorHistoryTest = { editor, parent }
  })

  await page.keyboard.type(' local')
  await expect.poll(() => page.evaluate(() => window.__editorHistoryTest.editor.getValue())).toBe('seed local')
  await page.evaluate(() => window.__editorHistoryTest.editor.setValue('seed local remote'))
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => window.__editorHistoryTest.editor.getValue())).toBe('seed remote')
  await page.evaluate(() => {
    window.__editorHistoryTest.editor.destroy()
    window.__editorHistoryTest.parent.remove()
    delete window.__editorHistoryTest
  })
})
