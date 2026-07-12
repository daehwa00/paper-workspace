import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../../..')
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
  await page.waitForFunction(() => /latest|cache|최신|캐시/i.test(document.querySelector('#render-state')?.textContent || ''), null, { timeout: 60_000 })
  return { context, page }
}

async function capture(page, path) {
  await page.waitForTimeout(350)
  await page.screenshot({ path, animations: 'disabled' })
}

async function selectAbstractSentence(page) {
  const editor = page.locator('#editor-view .cm-content')
  await editor.click()
  await page.keyboard.press('Control+Home')
  for (let index = 0; index < 8; index += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
}

const browser = await chromium.launch({ headless: true })
try {
  const author = await openWorkspace(browser, { name: 'Demo Author', color: '#2457d6' })
  const reviewer = await openWorkspace(browser, { name: 'Reviewer', color: '#dc2626' })

  await reviewer.page.locator('#editor-view .cm-content').click()
  await reviewer.page.keyboard.press('Control+Home')
  for (let index = 0; index < 12; index += 1) await reviewer.page.keyboard.press('ArrowDown')
  await author.page.waitForFunction(() => document.querySelectorAll('#collaborator-avatars .collaborator-avatar').length > 0, null, { timeout: 15_000 })

  const overview = join(output, 'workspace-overview.png')
  await capture(author.page, overview)
  await capture(author.page, join(frames, '01-overview.png'))

  await selectAbstractSentence(author.page)
  await author.page.keyboard.press('Control+Alt+c')
  await author.page.locator('#selection-comment-prompt').fill('Please link the experiment that supports this claim.')
  await author.page.locator('#selection-comment-prompt').press('Home')
  await capture(author.page, join(output, 'collaboration-review.png'))
  await capture(author.page, join(frames, '02-comment.png'))
  await author.page.keyboard.press('Escape')

  await selectAbstractSentence(author.page)
  await author.page.locator('#selection-codex').click()
  await author.page.locator('#selection-codex-prompt').fill('Keep the claim scope and make this sentence more concise.')
  await capture(author.page, join(frames, '03-codex.png'))
  await author.page.keyboard.press('Escape')

  await author.page.getByRole('tab', { name: /Checks|검사/ }).click()
  await author.page.locator('#run-submission-checks').click()
  await capture(author.page, join(frames, '04-checks.png'))

  await author.page.locator('#status-center-toggle').click()
  await capture(author.page, join(frames, '05-health.png'))

  const animationFrames = [
    join(frames, '01-overview.png'),
    join(frames, '02-comment.png'),
    join(frames, '03-codex.png'),
    join(frames, '04-checks.png'),
    join(frames, '05-health.png'),
    join(frames, '01-overview.png')
  ]
  const gif = join(output, 'edit-and-render-flow.gif')
  const conversion = spawnSync('convert', [
    '-delay', '140', ...animationFrames,
    '-resize', '1200x', '-colors', '128', '-layers', 'Optimize', '-loop', '0', gif
  ], { encoding: 'utf8' })
  if (conversion.status !== 0) {
    throw new Error(`ImageMagick conversion failed: ${conversion.stderr || conversion.stdout}`)
  }

  console.log(`Captured real workspace demo at ${output}`)
  await Promise.all([author.context.close(), reviewer.context.close()])
} finally {
  await browser.close()
  rmSync(frames, { recursive: true, force: true })
}
