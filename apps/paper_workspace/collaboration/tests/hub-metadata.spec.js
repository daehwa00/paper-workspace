import { test, expect, namedContext } from './fixtures.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

let service, directory, backend
const repository = resolve(import.meta.dirname, '../../../..')
test.beforeAll(async () => {
  const port = await new Promise(resolvePort => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolvePort(port)) }) })
  directory = mkdtempSync(join(tmpdir(), 'hub-metadata-'))
  backend = `http://127.0.0.1:${port}`
  service = spawn('python3', ['-m', 'apps.paper_workspace.backup.server'], {cwd: repository, env: {...process.env, BACKUP_HOST: '127.0.0.1', BACKUP_PORT: String(port), BACKUP_DB_PATH: join(directory, 'backup.sqlite3'), BACKUP_ASSET_DIR: join(directory, 'assets'), BACKUP_EXPORT_DIR: '', BACKUP_PROJECT_RUNTIME: '', BACKUP_ACTOR_MODE: 'proxy'}, stdio: 'pipe'})
  await expect.poll(async () => { try { return (await fetch(backend + '/health')).status } catch { return 0 } }).toBe(200)
})
test.afterAll(async () => { if (service && service.exitCode === null) { await new Promise(resolveExit => { service.once('exit', resolveExit); service.kill('SIGTERM') }) }; rmSync(directory, {recursive: true, force: true}) })

async function setup(page, id, role = 'editor') {
  await page.route('**/_auth/context.js', route => route.fulfill({contentType: 'text/javascript', body: `window.PaperAccess=${JSON.stringify({user: 'tester', projects: {[id]: role, [id + '-other']: role}})}`}))
  await page.route('**/projects/index.json', route => route.fulfill({json: {projects: [
    {slug: id, display_name: 'Editable paper', description: 'Original subtitle', updated_at: 'ICLR 2027', page_count: 12},
    {slug: id + '-other', display_name: 'Other paper', updated_at: 'NeurIPS 2027'}
  ]}}))
  await page.route('**/api/backups/**', async route => {
    const request = route.request(), url = new URL(request.url())
    const response = await route.fetch({url: backend + url.pathname.replace('/api/backups', ''), headers: {...request.headers(), 'X-Paper-Actor': 'tester', 'X-Paper-Role': role, 'X-Paper-Allowed-Projects': `${id},${id}-other`}})
    await route.fulfill({response})
  })
  await page.goto('/hub.html?lang=ko')
  await expect(page.locator('.project-card')).toHaveCount(2)
}
const row = (page, id) => page.locator(`.project-card:has(.project-open[href="/p/${id}"])`)
const editor = page => page.locator('.hub-metadata-dialog')
const venue = (page, id) => row(page, id).getByRole('button', {name: '목표 학회 수정'})
const subtitle = (page, id) => row(page, id).getByRole('button', {name: '부제목 수정'})
const inlineEditor = page => page.locator('.project-subtitle-inline')
const subtitleInput = page => inlineEditor(page).locator('input[name=value]')
async function changeSubtitle(page, id, text) { await subtitle(page, id).click(); await subtitleInput(page).fill(text); await subtitleInput(page).press('Enter') }

test('venue saves shared state, links to rules, and undo restores the catalog value', async ({ page, browser }, info) => {
  const id = 'venue-' + info.testId.slice(0, 10)
  await setup(page, id)
  await venue(page, id).click()
  await expect(page).toHaveURL(/hub\.html/)
  await editor(page).locator('input[name=value]').fill('ICML')
  await editor(page).locator('input[name=year]').fill('2028')
  await editor(page).locator('input[name=value]').press('Enter')
  await expect(venue(page, id)).toHaveText('ICML 2028')
  await expect(page.locator('.hub-metadata-toast a')).toHaveAttribute('href', `/p/${id}/rebuttal#overview`)
  const context = await namedContext(browser), other = await context.newPage()
  await setup(other, id)
  await expect(venue(other, id)).toHaveText('ICML 2028')
  await page.getByRole('button', {name: '실행 취소', exact: true}).click()
  await expect(venue(page, id)).toHaveText('ICLR 2027')
  await other.reload(); await expect(venue(other, id)).toHaveText('ICLR 2027')
  await context.close()
})

test('subtitle supports IME, plain text, Enter, reload and undo', async ({ page }, info) => {
  const id = 'subtitle-' + info.testId.slice(0, 10), text = '새 부제목 <강조> & 연구 결과'
  await setup(page, id); await subtitle(page, id).click()
  const input = subtitleInput(page)
  await input.fill(text)
  expect(await input.evaluate(node => !node.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true, cancelable: true})))).toBe(true)
  await expect(inlineEditor(page)).toBeVisible(); await expect(editor(page)).toHaveCount(0); await expect(input).toHaveValue(text)
  await input.press('Enter'); await expect(subtitle(page, id)).toHaveText(text)
  await expect(row(page, id).locator('.project-card-copy img')).toHaveCount(0)
  await page.getByRole('button', {name: '실행 취소', exact: true}).click()
  await expect(subtitle(page, id)).toHaveText('Original subtitle')
  await changeSubtitle(page, id, text); await expect(subtitle(page, id)).toHaveText(text)
  await page.reload(); await expect(subtitle(page, id)).toHaveText(text)
})

test('suggestions save immediately, unspecified and empty subtitle expose add controls, Escape cancels', async ({ page }, info) => {
  const id = 'options-' + info.testId.slice(0, 10)
  await setup(page, id); await venue(page, id).click()
  await editor(page).locator('input[name=value]').fill('Neu')
  await editor(page).getByRole('button', {name: 'NeurIPS 2027', exact: true}).click()
  await expect(venue(page, id)).toHaveText('NeurIPS 2027')
  await venue(page, id).click(); await editor(page).locator('input[name=value]').fill('')
  await editor(page).getByRole('button', {name: 'arXiv', exact: true}).click()
  await expect(venue(page, id)).toHaveText('arXiv')
  await venue(page, id).click(); await editor(page).getByRole('button', {name: '미정', exact: true}).click()
  await expect(venue(page, id)).toHaveText('학회 추가')
  await subtitle(page, id).click(); await subtitleInput(page).fill('Not saved'); await page.keyboard.press('Escape')
  await expect(subtitle(page, id)).toHaveText('Original subtitle'); await expect(subtitle(page, id)).toBeFocused()
  await subtitle(page, id).click(); await subtitleInput(page).fill('Saved on blur')
  await page.mouse.click(1, 1); await expect(inlineEditor(page)).toHaveCount(0)
  await expect(subtitle(page, id)).toHaveText('Saved on blur')
  await changeSubtitle(page, id, ''); await expect(subtitle(page, id)).toHaveText('부제목 추가')
})

test('an old save response cannot make undo overwrite a newer background update', async ({ page, browser }, info) => {
  const id = 'late-' + info.testId.slice(0, 10)
  await setup(page, id)
  let release, committed
  const gate = new Promise(resolve => { release = resolve }), saved = new Promise(resolve => { committed = resolve })
  let delayed = false
  await page.route(`**/projects/${id}/metadata`, async route => {
    if (route.request().method() !== 'PUT' || delayed) return route.fallback()
    delayed = true
    const response = await route.fetch({url: `${backend}/projects/${id}/metadata`, headers: {'Content-Type':'application/json','X-Paper-Actor':'tester','X-Paper-Role':'editor','X-Paper-Allowed-Projects':id}})
    committed(); await gate; await route.fulfill({response})
  })
  const context = await namedContext(browser)
  try {
    await changeSubtitle(page, id, 'First save'); await saved
    const other = await context.newPage(); await setup(other, id)
    await changeSubtitle(other, id, 'Newer save'); await expect(subtitle(other, id)).toHaveText('Newer save')
    await page.evaluate(() => dispatchEvent(new Event('focus')))
    await expect(subtitleInput(page)).toHaveValue('First save')
    release(); await expect(inlineEditor(page)).toHaveCount(0)
    await expect(subtitle(page, id)).toHaveText('Newer save')
    await page.getByRole('button', {name:'실행 취소',exact:true}).click()
    await expect(page.getByRole('status')).toContainText('다른 수정이 있어')
    await expect(subtitle(page, id)).toHaveText('Newer save')
  } finally { release(); await context.close() }
})

test('concurrent edits keep the draft, require review and prevent stale undo', async ({ page, browser }, info) => {
  const id = 'conflict-' + info.testId.slice(0, 10)
  await setup(page, id)
  const context = await namedContext(browser), other = await context.newPage(); await setup(other, id)
  await subtitle(other, id).click(); await subtitleInput(other).fill('Second author')
  await changeSubtitle(page, id, 'First author'); await expect(subtitle(page, id)).toHaveText('First author')
  await subtitleInput(other).press('Enter')
  await expect(inlineEditor(other).getByRole('alert')).toContainText('First author')
  await expect(subtitleInput(other)).toHaveValue('Second author')
  await subtitleInput(other).press('Enter'); await expect(subtitle(other, id)).toHaveText('Second author')
  await page.getByRole('button', {name: '실행 취소', exact: true}).click()
  await expect(page.getByRole('status')).toContainText('다른 수정이 있어')
  await expect(subtitle(page, id)).toHaveText('Second author')
  await context.close()
})

test('network failure keeps the input and retry succeeds without navigation', async ({ page }, info) => {
  const id = 'failure-' + info.testId.slice(0, 10)
  await setup(page, id)
  let fail = true
  await page.route(`**/projects/${id}/metadata`, route => route.request().method() === 'PUT' && fail ? route.abort('failed') : route.fallback())
  await changeSubtitle(page, id, 'Keep my draft')
  await expect(inlineEditor(page).getByRole('alert')).toContainText('입력한 내용은 유지')
  await expect(subtitleInput(page)).toHaveValue('Keep my draft')
  await expect(editor(page)).toHaveCount(0)
  fail = false; await subtitleInput(page).press('Enter')
  await expect(subtitle(page, id)).toHaveText('Keep my draft'); await expect(page).toHaveURL(/hub\.html/)
})

test('viewers see shared values without edit actions', async ({ page }, info) => {
  const id = 'viewer-' + info.testId.slice(0, 10)
  await setup(page, id, 'viewer')
  await expect(row(page, id)).toContainText('ICLR 2027')
  await expect(row(page, id).locator('[data-metadata-field]')).toHaveCount(0)
  await expect(row(page, id).getByRole('link')).toHaveAttribute('href', `/p/${id}`)
})

for (const theme of ['light', 'dark']) test(`metadata editor fits mobile and desktop with usable touch targets ${theme}`, async ({ page }, info) => {
  const id = 'layout-' + info.testId.slice(0, 10)
  await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
  await setup(page, id)
  await changeSubtitle(page, id, '긴 설명을 담은 부제목입니다. '.repeat(20).trim())
  await expect(subtitle(page, id)).toContainText('긴 설명을 담은')
  for (const width of [320, 390, 1024, 1600]) {
    await page.setViewportSize({width, height: 800}); await venue(page, id).click()
    const bounds = await editor(page).boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800)
    if (width < 768) for (const control of [venue(page, id), subtitle(page, id), editor(page).locator('input[name=value]'), editor(page).getByRole('button', {name: '저장', exact: true})]) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44)
    if (width < 768) expect((await subtitle(page, id).boundingBox()).height).toBeLessThanOrEqual(44)
    await page.setViewportSize({width, height: 400})
    await expect.poll(async () => { const bounds = await editor(page).boundingBox(); return bounds.y + bounds.height }).toBeLessThanOrEqual(400)
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})


test('subtitle uses a smaller text cursor and preserves a draft through background refresh', async ({ page }, info) => {
  const id = 'inline-' + info.testId.slice(0, 10)
  await setup(page, id)
  await subtitle(page, id).hover()
  await expect(subtitle(page, id)).toHaveCSS('cursor', 'text')
  await expect(subtitle(page, id)).toHaveCSS('font-size', '11px')
  await subtitle(page, id).click()
  await expect(subtitleInput(page)).toBeFocused()
  await expect(editor(page)).toHaveCount(0)
  await subtitleInput(page).fill('A draft kept during refresh')
  await page.evaluate(() => dispatchEvent(new Event('focus')))
  await expect(subtitleInput(page)).toHaveValue('A draft kept during refresh')
  await page.locator('.hub-page-header h2').click()
  await expect(subtitle(page, id)).toHaveText('A draft kept during refresh')
  await expect(page).toHaveURL(/hub\.html/)
})

test('inline subtitle stays within the row at desktop and mobile widths', async ({ page }, info) => {
  const id = 'inline-layout-' + info.testId.slice(0, 10)
  await setup(page, id)
  for (const width of [320, 1024, 1600]) {
    await page.setViewportSize({width, height:800})
    const before = await row(page, id).boundingBox()
    await subtitle(page, id).click()
    await expect(subtitleInput(page)).toBeFocused()
    const bounds = await subtitleInput(page).boundingBox()
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect((await row(page, id).boundingBox()).height).toBe(before.height)
    if (width < 768) expect(bounds.height).toBeGreaterThanOrEqual(44)
    await subtitleInput(page).press('Escape')
    await expect(subtitle(page, id)).toHaveText('Original subtitle')
  }
})

test('leaving an inline subtitle preserves the next control click', async ({ page }, info) => {
  const id = 'inline-switch-' + info.testId.slice(0, 10)
  await setup(page, id)
  await subtitle(page, id).click()
  await venue(page, id).click()
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await subtitle(page, id).click()
  await subtitleInput(page).fill('Saved while switching rows')
  await subtitle(page, id + '-other').click()
  await expect(subtitleInput(page)).toBeFocused()
  await expect(subtitleInput(page)).toHaveValue('')
  await expect(subtitle(page, id)).toHaveText('Saved while switching rows')
  await page.keyboard.press('Escape')
})
