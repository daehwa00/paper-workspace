import { expect, test } from './fixtures.js'

test('LaTeX syntax follows the active theme tokens and restores after a theme round trip', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.PaperEditor?.createEditor)
  const result = await page.evaluate(async () => {
    const parent = document.createElement('div')
    parent.className = 'editor-view'
    parent.style.cssText = 'height:180px;width:600px'
    document.body.append(parent)
    const editor = PaperEditor.createEditor({ parent, value: '\\documentclass{article}\n% a source comment\n\\begin{document}\nA formula $x=42$.\n\\end{document}' })
    const measure = async mode => {
      document.documentElement.dataset.colorScheme = mode
      editor.view.requestMeasure()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const command = [...parent.querySelectorAll('.cm-line span')].find(node => node.textContent === '\\documentclass')
      const comment = [...parent.querySelectorAll('.cm-line span')].find(node => node.textContent.includes('% a source comment'))
      const token = name => {
        const probe = document.createElement('i')
        probe.style.color = `var(${name})`
        parent.append(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return color
      }
      return { command: getComputedStyle(command).color, comment: getComputedStyle(comment).color, keyword: token('--theme-syntax-keyword'), commentToken: token('--theme-syntax-comment'), source: editor.getValue() }
    }
    try { return { light: await measure('light'), dark: await measure('dark'), restored: await measure('light') } }
    finally { editor.destroy(); parent.remove() }
  })
  expect(result.dark.command).toBe(result.dark.keyword)
  expect(result.dark.comment).toBe(result.dark.commentToken)
  expect(result.restored).toEqual(result.light)
  expect(result.dark.source).toBe(result.light.source)
})

test('dark autocomplete uses readable application surfaces', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('paper-workspace-theme', 'dark'))
  await page.goto('/')
  await page.waitForFunction(() => window.PaperEditor?.createEditor)
  await page.evaluate(() => {
    const parent = document.createElement('div')
    parent.className = 'editor-view'
    parent.style.cssText = 'position:fixed;left:20px;top:120px;width:600px;height:200px;z-index:1000'
    document.body.append(parent)
    const editor = PaperEditor.createEditor({ parent, value: '\\sect' })
    editor.setSelection(5)
    editor.focus()
    window.themeCompletionProbe = { editor, parent }
  })
  try {
    await page.keyboard.press('Control+Space')
    const popup = page.locator('.cm-tooltip-autocomplete')
    await expect(popup).toBeVisible()
    const expected = await page.evaluate(() => {
      const token = (property, name) => {
        const probe = document.createElement('i')
        probe.style.setProperty(property, `var(${name})`)
        document.body.append(probe)
        const value = getComputedStyle(probe).getPropertyValue(property)
        probe.remove()
        return value
      }
      return { background: token('background-color', '--theme-surface-raised'), color: token('color', '--theme-text') }
    })
    await expect(popup).toHaveCSS('background-color', expected.background)
    await expect(popup).toHaveCSS('color', expected.color)
  } finally {
    await page.evaluate(() => { themeCompletionProbe.editor.destroy(); themeCompletionProbe.parent.remove() })
  }
})
