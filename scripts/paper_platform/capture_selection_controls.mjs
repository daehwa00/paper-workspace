import { chromium } from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const output = resolve(process.env.PAPER_SELECTION_OUTPUT || '.omx/artifacts/linear-selection-controls')
const baseURL = process.env.PAPER_E2E_URL || 'http://127.0.0.1:18080'
mkdirSync(output, { recursive: true })
const results = []
const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 1024, 1600]) for (const lang of ['ko', 'en']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme })
    try {
      await context.addInitScript(theme => {
        localStorage.setItem('paper-workspace-theme', theme)
        localStorage.setItem('collab-name', 'Audit Author')
        localStorage.setItem('collab-name-user-set', '1')
      }, theme)
      const page = await context.newPage()
      await page.goto(`${baseURL}/p/selection-capture-${theme}-${width}-${lang}-${Date.now()}?lang=${lang}`)
      await page.waitForFunction(() => workspaceReadyForCompile)
      await page.evaluate(() => document.fonts.ready)
      await page.locator('.cm-content').focus()
      await page.keyboard.press('Control+Home')
      await page.keyboard.down('Shift')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.up('Shift')
      for (const kind of ['comment', 'codex']) {
        await page.locator(`#selection-${kind}`).click()
        // Composition sets its width/position/focus on the next animation frame.
        await page.waitForFunction(kind => document.querySelector('#selection-toolbar').classList.contains('composing') && document.activeElement.id === `selection-${kind}-prompt`, kind)
        await page.locator(`#selection-${kind}-prompt`).fill(lang === 'ko' ? '선택한 문장을 명확하게 다듬어 주세요 · 긴 문구 검사' : 'Please clarify the selected paragraph and preserve the mathematical notation')
        const metrics = await page.locator('#selection-toolbar').evaluate(element => {
          const box = node => {
            const r = node.getBoundingClientRect()
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
          }
          return {
            viewport: innerWidth, scroll: document.documentElement.scrollWidth, dpr: devicePixelRatio, fonts: document.fonts.status,
            toolbar: box(element),
            controls: [...element.querySelectorAll('input,button')].filter(node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).map(node => ({ id: node.id, ...box(node), color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor })),
            notifications: [...document.querySelectorAll('.app-toast.visible')].map(box)
          }
        })
        results.push({ theme, width, lang, kind, ...metrics })
        await page.locator('#selection-toolbar').screenshot({ path: resolve(output, `${theme}-${width}-${lang}-${kind}.png`), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await page.locator(`#selection-${kind}-composer`).waitFor({ state: 'hidden' })
      }
    } finally { await context.close() }
  }
} finally { await browser.close() }

const errors = results.filter(row => row.scroll > row.viewport || row.toolbar.left < -1 || row.toolbar.right > row.viewport + 1 || row.controls.some(control => control.left < row.toolbar.left - 1 || control.right > row.toolbar.right + 1 || row.width < 768 && (control.height < 43.99 || control.width < 43.99)) || row.width < 768 && row.notifications.some(toast => toast.bottom > row.toolbar.top - 8))
writeFileSync(resolve(output, 'measurements.json'), JSON.stringify(results, null, 2))
writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ cases: results.length, errors }, null, 2))
console.log(JSON.stringify({ cases: results.length, errors }, null, 2))
if (errors.length) process.exitCode = 1
