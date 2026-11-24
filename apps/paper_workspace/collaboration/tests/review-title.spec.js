import {test,expect} from './fixtures.js'

const manuscript=title=>`\\documentclass{article}\n\\title{${title}}\n\\begin{document}Text.\\end{document}`
async function setup(page){
 await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
}
const heading=page=>page.frameLocator('.paper-review-frame').locator('#workspace-project-title')

test('a direct review and reload resolve the manuscript title without full paper loading',async({page})=>{
 await setup(page)
 const slug=`review-title-${crypto.randomUUID()}`,requests=[]
 let release;let gate=new Promise(resolve=>{release=resolve})
 page.on('request',request=>{if(new URL(request.url()).pathname.includes('/project/'))requests.push(new URL(request.url()).pathname)})
 await page.route('**/project/project.json',async route=>{await gate;await route.continue()})
 await page.route('**/project/main.tex',route=>route.fulfill({contentType:'text/plain',body:manuscript('Confirmed manuscript title')}))
 try{
  await page.goto(`/p/${slug}/rebuttal?lang=ko&round=r42#submission`)
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(heading(page)).toHaveText(slug)
  release()
  await expect(heading(page)).toHaveText('Confirmed manuscript title')
  expect(requests.every(path=>/\/project\/(?:project\.json|main\.tex)$/.test(path))).toBe(true)
  expect(await page.evaluate(()=>typeof projectLoadPromise)).toBe('undefined')
  gate=new Promise(resolve=>{release=resolve})
  await page.reload()
  await expect(heading(page)).toHaveText('Confirmed manuscript title')
  await expect(page).toHaveURL(url=>url.searchParams.get('round')==='r42'&&url.hash==='#submission')
  release()
  await expect(heading(page)).toHaveText('Confirmed manuscript title')
 }finally{release()}
})

test('a failed title lookup preserves the last title and keeps review usable',async({page})=>{
 await setup(page)
 const slug=`review-title-offline-${crypto.randomUUID()}`
 await page.addInitScript(slug=>sessionStorage.setItem(`paper-project-title:${slug}`,'Previously confirmed title'),slug)
 await page.route('**/project/project.json',route=>route.abort('failed'))
 await page.goto(`/p/${slug}/rebuttal?lang=en`)
 await expect(heading(page)).toHaveText('Previously confirmed title')
 await expect(page.frameLocator('.paper-review-frame').getByText('Create your first round')).toBeVisible()
 await expect(heading(page)).not.toContainText('Loading')
})

test('a late review title lookup cannot overwrite the manuscript editor title',async({page})=>{
 await setup(page)
 let release,requested;const gate=new Promise(resolve=>{release=resolve}),waiting=new Promise(resolve=>{requested=resolve})
 let count=0
 await page.route('**/project/main.tex',async route=>{
  if(++count===1){requested();await gate;await route.fulfill({contentType:'text/plain',body:manuscript('Older network title')})}
  else await route.continue()
 })
 try{
  await page.goto(`/p/review-title-race-${crypto.randomUUID()}/rebuttal?lang=en`)
  await waiting
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await page.frameLocator('.paper-review-frame').locator('#manuscript-link').click()
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await expect(page.locator('#project-title')).toHaveValue('A Reusable Paper Workspace')
  release()
  await page.locator('#open-rebuttal').click()
  await expect(heading(page)).toHaveText('A Reusable Paper Workspace')
  await expect(page.locator('#project-title')).toHaveValue('A Reusable Paper Workspace')
 }finally{release()}
})

test('shared manuscript titles take precedence over a delayed source lookup in review-only mode',async({page})=>{
 await setup(page)
 let release,requested;const gate=new Promise(resolve=>{release=resolve}),waiting=new Promise(resolve=>{requested=resolve})
 await page.route('**/project/main.tex',async route=>{requested();await gate;await route.fulfill({contentType:'text/plain',body:manuscript('Older server title')})})
 try{
  await page.goto(`/p/review-title-shared-${crypto.randomUUID()}/rebuttal?lang=en`)
  await waiting
  await page.evaluate(async()=>{await collabBootstrapReady;const text=collabSession.textFor('paper/main.tex');text.insert(0,'\\title{Latest shared title}')})
  await expect(heading(page)).toHaveText('Latest shared title')
  release()
  await expect.poll(()=>page.evaluate(()=>reviewProjectTitle)).toBe('Latest shared title')
  await expect(page.locator('#project-title')).toHaveValue('')
  expect(await page.evaluate(()=>typeof projectLoadPromise)).toBe('undefined')
 }finally{release()}
})
