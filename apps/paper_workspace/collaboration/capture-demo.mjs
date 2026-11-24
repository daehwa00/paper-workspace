import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.env.PAPER_DEMO_OUTPUT || join(here, '../../../docs/demo'))
const verification = process.env.PAPER_DEMO_VERIFY_DIR
const base = new URL(process.env.PAPER_DEMO_URL || 'http://127.0.0.1:19984').origin
const password = process.env.PAPER_DEMO_PASSWORD
const project = '/p/example-paper'
const original = 'A Reusable Paper Workspace'
const replacement = 'A Collaborative Paper Workspace'
const cursorBundle = join(here, 'node_modules/@cursor.js/core/dist/cursor.umd.cjs')
const roundTitle = 'Example Paper Review'
const reviewQuestion = 'Could you clarify the evaluation setup and state the runtime of the sorting step?'
const responseText = [
  '**Evaluation setup.** Thank you for the suggestion. We will add the input sizes and use the same synthetic inputs for both methods.',
  String.raw`The sorting step takes $O(n \log n)$ time, where $n$ is the number of examples.`
].join('\n\n')

if (base !== 'http://127.0.0.1:19984') {
  throw new Error('Run the demo against the isolated Compose stack at http://127.0.0.1:19984')
}

async function seedReview(context) {
  const endpoint = `${base}/api/rebuttal/projects/example-paper`
  const response = await context.request.get(`${endpoint}/state`, { maxRedirects: 0 })
  if (!response.ok()) throw new Error(`Rebuttal state returned HTTP ${response.status()}`)
  const state = await response.json()
  const [existing] = state.rounds
  if (state.rounds.length === 1 && existing.title === roundTitle
      && existing.reviews.length === 1 && existing.reviews[0].fields.Questions === reviewQuestion
      && existing.documents.length === 1 && existing.documents[0].seed_text === responseText) return
  if (state.enabled === false || state.revision !== 0 || state.rounds.length !== 0) {
    throw new Error('Start with an empty, enabled Rebuttal Studio in the isolated stack')
  }

  const seeded = await context.request.post(`${endpoint}/restore`, {
    maxRedirects: 0,
    data: {
      expected_revision: state.revision,
      snapshot: {
        schema_version: 1,
        rounds: [{
          id: 'example-round',
          title: roundTitle,
          reviewers: [{ id: 'reviewer-1', label: 'Reviewer 1' }],
          reviews: [{
            id: 'review-1',
            reviewer_id: 'reviewer-1',
            fields: {
              Summary: 'Example Paper describes a reproducible writing and evaluation workflow.',
              Questions: reviewQuestion
            },
            translations: {}
          }],
          documents: [{
            id: 'response-1', title: 'Response to Reviewer 1', kind: 'reviewer',
            reviewer_id: 'reviewer-1', text_key: 'response-1'
          }],
          imports: [], concerns: [], mappings: [], findings: [], evidence: [],
          work_items: [], rules: [], analyses: [], submissions: []
        }],
        texts: { 'response-1': responseText }
      }
    }
  })
  if (!seeded.ok()) throw new Error(`Synthetic review seed returned HTTP ${seeded.status()}: ${await seeded.text()}`)
}

async function initializeCursor(page, startPoint) {
  await page.addScriptTag({ path: cursorBundle })
  await page.evaluate(point => {
    const { Cursor, ThemePlugin } = window.Cursor
    window.demoCursor = new Cursor({ humanize: false, speed: 0.95, size: 1.16, startPoint: point })
    const colors = { primary: '#2457d6', outline: '#ffffff' }
    window.demoCursor.use(new ThemePlugin({
      default: ThemePlugin.cursors.default({ colors }),
      pointer: ThemePlugin.cursors.pointer({ colors }),
      text: ThemePlugin.cursors.text({ colors })
    }, { auto: true }))
  }, startPoint)
}

const frames = mkdtempSync(join(tmpdir(), 'paper-workspace-demo-'))
const animation = []
const samples = []
let cursorPosition

async function capture(page, centiseconds, sample) {
  const path = join(frames, `${animation.length}.png`)
  const screenshot = await page.screenshot({ path, caret: 'initial' })
  animation.push('-delay', String(centiseconds), path)
  if (sample) {
    samples.push(path)
    if (verification) writeFileSync(join(verification, `frame_${sample}.png`), screenshot)
  }
}

async function moveCursor(page, target, { x = 0.5, y = 0.5 } = {}) {
  const box = await target.boundingBox()
  if (!box) throw new Error('Demo cursor target is not visible')
  const destination = { x: box.x + box.width * x, y: box.y + box.height * y }
  const steps = Math.min(13, Math.max(7, Math.ceil(Math.hypot(
    destination.x - cursorPosition.x, destination.y - cursorPosition.y
  ) / 65)))
  for (let step = 1; step <= steps; step += 1) {
    const progress = (1 - Math.cos(Math.PI * step / steps)) / 2
    const point = {
      x: cursorPosition.x + (destination.x - cursorPosition.x) * progress,
      y: cursorPosition.y + (destination.y - cursorPosition.y) * progress
    }
    await page.evaluate(({ x, y }) => window.demoCursor.teleportTo(x, y), point)
    await capture(page, 4)
  }
  cursorPosition = destination
  return destination
}

async function clickAt(page, point) {
  await page.mouse.click(point.x, point.y)
}

function verifyBuild(result) {
  if (result.cached || !result.passes || !result.pdf_base64) {
    throw new Error('Expected a fresh LaTeX build after saving the edited title')
  }
  const pdfText = execFileSync('pdftotext', ['-', '-'], {
    input: Buffer.from(result.pdf_base64, 'base64'), encoding: 'utf8'
  })
  if (!pdfText.includes(replacement)) throw new Error('Rendered PDF is missing the updated title')
}

let browser
try {
  mkdirSync(output, { recursive: true })
  if (verification) mkdirSync(verification, { recursive: true })
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block', bypassCSP: true })
  // Keep the browser entirely on the capture stack, including subresources.
  await context.route('**/*', route => (
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  ))
  await context.addInitScript(() => {
    localStorage.setItem('collab-name', 'Demo Author')
    localStorage.setItem('collab-name-user-set', '1')
    localStorage.setItem('collab-color', '#2457d6')
    localStorage.setItem('paper-workspace-theme', 'light')
    localStorage.setItem('paper-workspace-language', 'en')
  })
  if (password) {
    const login = await context.request.post(`${base}/_auth/login?rd=${encodeURIComponent(project)}`, {
      form: { password }, maxRedirects: 0
    })
    if (!login.ok() && login.status() !== 303) throw new Error(`Demo login returned HTTP ${login.status()}`)
  }
  await seedReview(context)

  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  await page.goto(`${base}/hub.html?lang=en`)
  const example = page.locator('[data-project-slug="example-paper"]')
  await page.waitForFunction(() => document.querySelector('[data-project-slug="example-paper"] .project-thumbnail')?.naturalWidth > 0)
  await page.locator('#hub-calendar-days td').first().waitFor({ state: 'visible' })
  await page.evaluate(() => document.fonts.ready)
  cursorPosition = { x: 700, y: 185 }
  await initializeCursor(page, cursorPosition)
  await capture(page, 100, 1)
  const projectLink = await moveCursor(page, example.locator('.project-open h3'))
  await capture(page, 12)
  await Promise.all([page.waitForURL(`**${project}**`), clickAt(page, projectLink)])

  const title = page.locator('.cm-content .cm-line').filter({ hasText: `\\title{${original}}` })
  const canvas = page.locator('#paper-preview canvas').first()
  await title.waitFor()
  if (await page.locator('#toggle-assistant').getAttribute('aria-expanded') === 'true') {
    await page.locator('#toggle-assistant').click()
  }
  await canvas.waitFor({ timeout: 60_000 })
  await page.evaluate(() => document.fonts.ready)
  await initializeCursor(page, projectLink)
  await capture(page, 65, 2)
  const titlePoint = await moveCursor(page, title, { x: 0.24 })
  await clickAt(page, titlePoint)
  await page.keyboard.press('Home')
  for (const character of '\\title{') await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Shift+ArrowLeft')
  if (await page.evaluate(() => getSelection().toString()) !== original) {
    throw new Error('Could not select the original LaTeX title')
  }
  await capture(page, 25)
  for (const chunk of replacement.match(/.{1,2}/g)) {
    await page.keyboard.insertText(chunk)
    await capture(page, 7)
  }
  await capture(page, 30)

  const previousCanvas = await canvas.elementHandle()
  const compiled = page.waitForResponse(response => (
    new URL(response.url()).pathname === '/api/compile' && response.request().method() === 'POST'
      && response.request().postData()?.includes(replacement)
  ), { timeout: 60_000 })
  await page.keyboard.press('Control+s')
  await page.locator('#render-state.compiling').or(page.locator('#render-state[data-i18n="workspace.compile.current"]')).waitFor()
  await capture(page, 25)
  const result = await compiled
  if (!result.ok()) throw new Error(`LaTeX compile returned HTTP ${result.status()}`)
  const build = await result.json()
  verifyBuild(build)
  await page.waitForFunction(previous => {
    const current = document.querySelector('#paper-preview canvas')
    return current && current !== previous && current.width && getComputedStyle(current).visibility === 'visible'
  }, previousCanvas)
  await moveCursor(page, canvas, { x: 0.72, y: 0.195 })
  await capture(page, 95, 3)
  console.log(`Verified PDF compile (${build.build_mode}, ${build.passes} passes) and updated canvas`)

  const rebuttalTab = await moveCursor(page, page.locator('#open-rebuttal'))
  await capture(page, 10)
  await clickAt(page, rebuttalTab)
  const studio = page.frameLocator('iframe.paper-review-frame.is-active')
  const avatar = studio.locator('.reviewer-mate').first()
  await avatar.evaluate(image => image.decode())
  await studio.locator('#review-content').getByText('Could you clarify', { exact: false }).waitFor()
  await studio.locator('#notice').waitFor({ state: 'hidden' })
  const previewToggle = studio.locator('[data-response-view="toggle"]')
  await capture(page, 36)
  const toggle = await moveCursor(page, previewToggle)
  await clickAt(page, toggle)
  await studio.locator('#response-preview mjx-container').first().waitFor()
  await studio.locator('#response-preview strong').getByText('Evaluation setup.', { exact: true }).waitFor()
  await capture(page, 230, 4)

  const gif = join(output, 'edit-and-render-flow.gif')
  const stagedGif = join(frames, 'edit-and-render-flow.gif')
  const palette = join(frames, 'palette.png')
  execFileSync('convert', [...samples, '-resize', '1200x', '-append', '-colors', '128', '-unique-colors', palette])
  execFileSync('convert', [
    ...animation, '-resize', '1200x', '+dither', '-remap', palette, '-layers', 'Optimize', '-loop', '0', stagedGif
  ])
  copyFileSync(stagedGif, gif)
  console.log(`Captured ${animation.length / 3} frames at ${gif}`)
} finally {
  await browser?.close()
  rmSync(frames, { recursive: true, force: true })
}
