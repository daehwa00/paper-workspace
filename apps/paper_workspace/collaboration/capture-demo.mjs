import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../../..')
const cursorBundle = resolve(here, 'node_modules/@cursor.js/core/dist/cursor.umd.cjs')
const output = resolve(process.env.PAPER_DEMO_OUTPUT || join(repository, 'docs/demo'))
const base = (process.env.PAPER_DEMO_URL || 'https://localhost').replace(/\/$/, '')
const project = process.env.PAPER_DEMO_PROJECT || 'example-paper'
const password = process.env.PAPER_DEMO_PASSWORD || process.env.PAPER_ACCESS_PASSWORD || ''
const projectUrl = `${base}/p/${encodeURIComponent(project)}`
const frames = mkdtempSync(join(tmpdir(), 'paper-workspace-demo-'))

mkdirSync(output, { recursive: true })

function profileScript(profile) {
  return ({ name, color }) => {
    localStorage.setItem('collab-name', name)
    localStorage.setItem('collab-name-user-set', '1')
    localStorage.setItem('collab-color', color)
    localStorage.setItem('paper-workspace-theme', 'light')
    localStorage.setItem('paper-workspace-language', 'en')
    localStorage.removeItem('paper-workspace-layout')
  }
}

async function authenticate(context) {
  if (!password) return
  const response = await context.request.post(`${base}/_auth/login?rd=${encodeURIComponent(`/p/${project}`)}`, {
    form: { password }
  })
  if (!response.ok()) throw new Error(`Demo authentication failed with HTTP ${response.status()}`)
}

async function openWorkspace(browser, profile) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true
  })
  await context.addInitScript(profileScript(profile), profile)
  await authenticate(context)
  const page = await context.newPage()
  await page.goto(`${projectUrl}?lang=en`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('#editor')?.value?.includes('\\documentclass'), null, { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector('#paper-preview canvas'), null, { timeout: 60_000 })
  return { context, page }
}

let frameIndex = 0

async function captureFrame(page, frameDelay = 100) {
  frameIndex += 1
  await page.screenshot({ path: join(frames, `${String(frameIndex).padStart(3, '0')}.png`) })
  if (frameDelay) await page.waitForTimeout(frameDelay)
}

async function hold(page, count, frameDelay = 100) {
  for (let index = 0; index < count; index += 1) await captureFrame(page, frameDelay)
}

async function initializeDemoCursor(page) {
  await page.addScriptTag({ path: cursorBundle })
  await page.evaluate(() => {
    window.demoCursor = new window.Cursor.Cursor({
      humanize: true,
      speed: 0.72,
      size: 1.08,
      startPoint: { x: window.innerWidth / 2, y: 72 }
    })
    const colors = { primary: '#2457d6', outline: '#ffffff' }
    window.demoCursor.use(new window.Cursor.ThemePlugin({
      default: window.Cursor.ThemePlugin.cursors.default({ colors }),
      pointer: window.Cursor.ThemePlugin.cursors.pointer({ colors }),
      text: window.Cursor.ThemePlugin.cursors.text({ colors })
    }, { auto: true }))
  })
}

async function recordCursorMove(page, target) {
  let finished = false
  const movement = page.evaluate(async destination => {
    const element = document.querySelector(destination.selector)
    if (!element) throw new Error(`Demo cursor target not found: ${destination.selector}`)
    const box = element.getBoundingClientRect()
    const x = box.left + box.width * (destination.xRatio ?? 0.5)
    const y = box.top + (destination.yOffset ?? box.height * 0.5)
    await window.demoCursor.move(x, y)
  }, target).then(() => { finished = true })
  for (let index = 0; index < 32; index += 1) {
    await captureFrame(page, 45)
    if (finished) break
  }
  await movement
}

async function selectPaperTitle(page) {
  const editor = page.locator('#editor-view .cm-content')
  await editor.click()
  await page.keyboard.press('Control+Home')
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Shift+ArrowLeft')
}

const browser = await chromium.launch({ headless: true })
try {
  const author = await openWorkspace(browser, { name: 'Demo Author', color: '#2457d6' })
  const { page } = author
  await page.locator('#toggle-assistant').click()
  await page.waitForTimeout(400)
  await initializeDemoCursor(page)

  await hold(page, 10, 100)

  await recordCursorMove(page, { selector: '.cm-line:nth-child(4)', xRatio: 0.62 })
  await selectPaperTitle(page)
  await hold(page, 5, 100)

  const replacement = 'A Collaborative Paper Workspace'
  for (const [index, character] of [...replacement].entries()) {
    await page.keyboard.type(character)
    if (index % 2 === 1 || character === ' ') await captureFrame(page, 65)
  }
  await hold(page, 4, 100)

  let compileFinished = false
  const compileResponse = page.waitForResponse(response => (
    response.url().includes('/api/compile') && response.request().method() === 'POST'
  ), { timeout: 60_000 }).then(response => {
    if (!response.ok()) throw new Error(`Demo compile failed with HTTP ${response.status()}`)
    compileFinished = true
    return response
  })
  await page.keyboard.press('Control+s')
  let framesAfterCompile = 0
  for (let index = 0; index < 36; index += 1) {
    await captureFrame(page, 125)
    if (compileFinished) framesAfterCompile += 1
    if (framesAfterCompile >= 10) break
  }
  await compileResponse
  await page.waitForFunction(() => document.querySelector('#paper-preview canvas'), null, { timeout: 60_000 })
  await recordCursorMove(page, { selector: '#paper-preview canvas', xRatio: 0.5, yOffset: 82 })
  await hold(page, 12, 100)

  const animationFrames = Array.from({ length: frameIndex }, (_, index) => (
    join(frames, `${String(index + 1).padStart(3, '0')}.png`)
  ))
  const gif = join(output, 'edit-and-render-flow.gif')
  const conversion = spawnSync('convert', [
    '-delay', '10', ...animationFrames,
    '-resize', '1200x', '-colors', '128', '-layers', 'Optimize', '-loop', '0', gif
  ], { encoding: 'utf8' })
  if (conversion.status !== 0) {
    throw new Error(`ImageMagick conversion failed: ${conversion.stderr || conversion.stdout}`)
  }

  console.log(`Captured real workspace demo at ${output}`)
  await selectPaperTitle(page)
  await page.keyboard.type('A Reusable Paper Workspace')
  const restoreResponse = page.waitForResponse(response => (
    response.url().includes('/api/compile') && response.request().method() === 'POST'
  ), { timeout: 60_000 })
  await page.keyboard.press('Control+s')
  await restoreResponse
  await author.context.close()
} finally {
  await browser.close()
  rmSync(frames, { recursive: true, force: true })
}
