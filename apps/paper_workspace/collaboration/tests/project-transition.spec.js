import { test, expect } from './fixtures.js'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

test('opening another paper from the embedded Rebuttal updates the browser URL', async ({page}) => {
  const first=`vision-${crypto.randomUUID()}`,second=`other-${crypto.randomUUID()}`
  await page.route('**/',route=>route.fulfill({path:resolve('../static/hub.html'),contentType:'text/html'}))
  await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:first,display_name:'First paper'},{slug:second,display_name:'Second paper'}]}}))
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.goto(`/p/${first}?lang=en`)
  await page.locator('#open-rebuttal').click()
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await page.frameLocator('.paper-review-frame').locator('a.project-frame-brand').click()
  await expect(page).toHaveURL(url=>url.pathname==='/')
  await page.locator('.project-card').filter({hasText:'Second paper'}).click()
  await expect(page).toHaveURL(url=>url.pathname===`/p/${second}`)
  await page.locator('#open-rebuttal').click()
  await expect(page).toHaveURL(url=>url.pathname===`/p/${second}/rebuttal`)
})

test('both project views stay mounted across navigation and preserve manuscript editing', async ({ page }) => {
  await page.route('**/api/rebuttal/projects/**/state', route => route.fulfill({ json: { revision: 0, enabled: true, rounds: [], jobs: [] } }))
  const slug = `project-roundtrip-${crypto.randomUUID()}`
  await page.goto(`/p/${slug}?lang=ko`)
  await expect(page.locator('#manuscript-link')).toHaveText('Paper')
  await expect(page.locator('#open-rebuttal')).toHaveText('Rebuttal')
  await page.waitForFunction(() => workspaceReadyForCompile)
  await page.waitForFunction(() => document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
  const frame = page.frameLocator('.paper-review-frame')
  const initial = await page.evaluate(() => ({ doc: window.PaperWorkspaceSharedSession.document.clientID, source: editorValue() }))
  await page.locator('#open-rebuttal').click()
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(frame.locator('#screen-nav button')).toHaveCount(3)
  await expect(frame.locator('#manuscript-link')).toHaveText('Paper')
  await expect(frame.locator('#open-rebuttal')).toHaveText('Rebuttal')
  expect(await page.evaluate(() => document.querySelector('.paper-review-frame').contentWindow.PaperRebuttalSession === window.PaperWorkspaceSharedSession)).toBe(true)
  await frame.locator('#manuscript-link').click()
  await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
  expect(await page.evaluate(() => ({ doc: window.PaperWorkspaceSharedSession.document.clientID, source: editorValue() }))).toEqual(initial)
  await page.locator('.cm-content').focus()
  await page.keyboard.type('% navigation-check')
  expect(await page.evaluate(() => editorValue())).not.toBe(initial.source)
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => editorValue())).toBe(initial.source)
  await page.goBack()
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await page.goBack()
  await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
})

test('workspace tabs attach to the content edge across views and screen sizes',async({page})=>{
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.setViewportSize({width:1440,height:900});await page.goto(`/p/bookmark-tabs-${crypto.randomUUID()}?lang=en`)
  await page.waitForFunction(()=>workspaceReadyForCompile)
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900})
    const tab=page.locator('.project-workspace-nav #manuscript-link')
    await expect(tab).toHaveAttribute('aria-current','page')
    await expect(tab).toHaveCSS('border-top-left-radius','8px')
    await expect(tab).toHaveCSS('border-bottom-left-radius','0px')
    const {tabBottom,navBottom}=await page.evaluate(()=>({tabBottom:document.querySelector('#manuscript-link').getBoundingClientRect().bottom,navBottom:document.querySelector('.project-workspace-nav').getBoundingClientRect().bottom}))
    expect(Math.abs(tabBottom-navBottom)).toBeLessThanOrEqual(1)
    await expect.poll(()=>page.evaluate(()=>{const nav=document.querySelector('.project-workspace-nav'),main=document.querySelector('.project-frame-main'),n=nav.getBoundingClientRect(),m=main.getBoundingClientRect(),line=getComputedStyle(nav,'::after');return Math.max(Math.abs(n.left+parseFloat(line.left)-m.left),Math.abs(n.right-parseFloat(line.right)-m.right))})).toBeLessThanOrEqual(1)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
  }
  await page.locator('#open-rebuttal').click()
  const review=page.frameLocator('.paper-review-frame')
  await expect(review.locator('#open-rebuttal')).toHaveAttribute('aria-current','page')
  await expect(review.locator('#open-rebuttal')).toHaveCSS('border-bottom-left-radius','0px')
})

test('direct review links defer manuscript loading and preserve review route and navigation', async ({ page }) => {
  await page.route('**/api/rebuttal/projects/**/state', route => route.fulfill({ json: { revision: 0, enabled: true, rounds: [], jobs: [] } }))
  const projectRequests=[]
  page.on('request',request=>{if(new URL(request.url()).pathname.includes('/project/'))projectRequests.push(request.url())})
  const slug = `direct-review-${crypto.randomUUID()}`
  await page.goto(`/p/${slug}/rebuttal?round=r42&lang=ko#submission`)
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(page).toHaveURL(url=>url.pathname===`/p/${slug}/rebuttal` && url.searchParams.get('round')==='r42' && url.hash==='#submission')
  await expect(page.frameLocator('.paper-review-frame').locator('#workspace-project-title')).toHaveText('A Reusable Paper Workspace')
  expect(projectRequests.every(url=>/\/project\/(project\.json|main\.tex)(?:\?|$)/.test(url))).toBe(true)
  const review=page.frameLocator('.paper-review-frame')
  await expect(review.locator('#screen-nav [data-screen="submission"]')).toHaveAttribute('aria-current','page')
  expect(await page.evaluate(() => document.querySelector('.paper-review-frame').contentWindow.PaperRebuttalSession === window.PaperWorkspaceSharedSession)).toBe(true)
  await page.reload()
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(page).toHaveURL(url=>url.searchParams.get('round')==='r42' && url.hash==='#submission')
  await review.locator('#manuscript-link').click()
  await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
  await page.waitForFunction(() => typeof workspaceReadyForCompile !== 'undefined' && workspaceReadyForCompile)
  expect(projectRequests.length).toBeGreaterThan(0)
  await page.locator('#open-rebuttal').click()
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await page.goBack()
  await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
})

test('PDF canvases remain hidden until the review view is ready', async ({ page }) => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  await page.route('**/api/rebuttal/projects/**/state', async route => {
    await wait
    await route.fulfill({ json: { revision: 0, enabled: true, rounds: [], jobs: [] } })
  })
  await page.goto(`/p/pdf-flash-${crypto.randomUUID()}/rebuttal?lang=ko`, {waitUntil:'domcontentloaded'})
  await page.waitForSelector('.shell', {state:'attached'})
  await page.evaluate(() => { const canvas=document.createElement('canvas');canvas.id='test-visible-pdf';canvas.style.visibility='visible';document.querySelector('.shell').append(canvas) })
  await expect(page.locator('#test-visible-pdf')).toHaveCSS('visibility','visible')
  await expect(page.locator('.shell')).toHaveCSS('opacity','0')
  release()
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
})

test('source cache reuses only verified unchanged server revisions', async ({ page }) => {
  let requests=0, body='original source'
  const path=`/source-cache-${crypto.randomUUID()}.txt`
  await page.route(`**${path}`,route=>{requests++;return route.fulfill({contentType:'text/plain',body})})
  await page.goto(`/p/cache-check-${crypto.randomUUID()}?lang=en`)
  await page.waitForFunction(()=>typeof fetchProjectSource==='function')
  const digest=value=>createHash('sha256').update(value).digest('hex')
  const read=(revision)=>page.evaluate(({path,revision})=>fetchProjectSource('test',path,{required:true,revision}),{path,revision})
  expect(await read(digest(body))).toBe(body)
  expect(await read(digest(body))).toBe(body)
  expect(requests).toBe(1)
  body='updated source'
  expect(await read(digest(body))).toBe(body)
  expect(requests).toBe(2)
  await page.evaluate(async({path,revision})=>{const cache=await caches.open('paper-workspace-project-sources-v1');await cache.put(new URL(path,location.href).href,new Response('tampered',{headers:{'x-paper-source-revision':revision}}))},{path,revision:digest(body)})
  expect(await read(digest(body))).toBe(body)
  expect(requests).toBe(3)
  expect(await read('')).toBe(body)
  expect(await read('')).toBe(body)
  expect(requests).toBe(5)
  await page.evaluate(()=>{caches.open=()=>new Promise(()=>{})})
  expect(await read(digest(body))).toBe(body)
  expect(requests).toBe(6)
})

test('review metadata appears while shared document synchronization is pending',async({page})=>{
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.route('**/vendor/paper-collab.js*',async route=>{
    const response=await route.fetch(),script=await response.text()
    await route.fulfill({response,body:script+`;{const create=PaperCollab.createSession;PaperCollab={...PaperCollab,createSession:(...args)=>{const session=create(...args),ready=session.whenReady;session.whenReady=new Promise((resolve,reject)=>{window.__releaseReviewSync=()=>ready.then(resolve,reject)});return session}}}`})
  })
  await page.goto(`/p/review-wait-${crypto.randomUUID()}/rebuttal?lang=en`)
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(page.frameLocator('.paper-review-frame').getByText('Create your first round')).toBeVisible()
  expect(await page.evaluate(()=>typeof window.__releaseReviewSync)).toBe('function')
  await page.evaluate(()=>window.__releaseReviewSync())
})
