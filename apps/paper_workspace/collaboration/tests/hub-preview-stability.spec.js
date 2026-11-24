import {test,expect} from './fixtures.js'
import {selectControl} from './controls.js'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
const row=(page,slug)=>page.locator(`.project-list-entry[data-project-slug="${slug}"]`)

test('background activity and page count updates retain the decoded preview and unchanged row controls',async({page})=>{
 let requests=0,actor='DH',count=12,title='Paper one'
 await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'one',display_name:title,description:'A subtitle',updated_at:'ICLR 2027',page_count:1}]}}))
 await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[{project_id:'one',actor,modified_at:'2026-11-12T03:00:00Z'}],metadata:[]}}))
 await page.route('**/main-page-count.json',route=>route.fulfill({json:{page_count:count,entrypoint:'main.tex'}}))
 await page.route('**/thumbnail.png',route=>{requests++;return route.fulfill({body:png,contentType:'image/png',headers:{'Cache-Control':'no-store'}})})
 await page.goto('/hub.html?lang=ko')
 await expect(row(page,'one').locator('.project-page-count')).toHaveText('12p')
 await expect.poll(()=>row(page,'one').locator('img').evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true)
 await row(page,'one').evaluate(node=>{window.__originalRow=node;window.__originalImage=node.querySelector('img');window.__originalSubtitle=node.querySelector('.project-subtitle-edit');window.__previewLoads=0;window.__originalImage.addEventListener('load',()=>window.__previewLoads++)})
 actor='KDH';count=21
 await page.evaluate(()=>loadProjects())
 await expect(row(page,'one').locator('.project-actor')).toHaveText('KDH')
 await expect(row(page,'one').locator('.project-page-count')).toHaveText('21p')
 expect(await row(page,'one').evaluate(node=>node===window.__originalRow&&node.querySelector('img')===window.__originalImage&&node.querySelector('.project-subtitle-edit')===window.__originalSubtitle)).toBe(true)
 title='Updated paper title'
 await page.evaluate(()=>loadProjects())
 await expect(row(page,'one').locator('h3')).toHaveText(title)
 await expect(row(page,'one').locator('img')).toHaveAttribute('alt',`${title} 첫 페이지 미리보기`)
 expect(await row(page,'one').locator('img').evaluate(image=>image===window.__originalImage&&image.complete&&image.naturalWidth>0)).toBe(true)
 expect(await page.evaluate(()=>window.__previewLoads)).toBe(0)
 expect(requests).toBe(1)
})

test('sorting and language changes preserve preview nodes while a new thumbnail URL replaces only its own image',async({page})=>{
 let changed=false,requests=0
 await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[
  {slug:'one',display_name:'Zebra',display_name_ko:'한국 논문',thumbnail:changed?'/projects/one/thumbnail.webp':'/projects/one/thumbnail.png'},
  {slug:'two',display_name:'Alpha'}
 ]}}))
 await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[],metadata:[]}}))
 await page.route('**/thumbnail.*',route=>{requests++;return route.fulfill({body:png,contentType:'image/png',headers:{'Cache-Control':'no-store'}})})
 await page.goto('/hub.html?lang=en')
 await expect.poll(()=>page.locator('.project-thumbnail').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0))).toBe(true)
 await page.evaluate(()=>{window.__originalImages=Object.fromEntries([...document.querySelectorAll('.project-list-entry')].map(row=>[row.dataset.projectSlug,row.querySelector('img')]))})
 await selectControl(page.locator('#project-sort'),'name')
 await expect(page.locator('.project-card h3')).toHaveText(['Alpha','Zebra'])
 await page.locator('#hub-language').selectOption('ko')
 await expect(row(page,'one').locator('h3')).toHaveText('한국 논문')
 expect(await page.evaluate(()=>[...document.querySelectorAll('.project-list-entry')].every(row=>row.querySelector('img')===window.__originalImages[row.dataset.projectSlug]))).toBe(true)
 expect(requests).toBe(2)
 changed=true;await page.evaluate(()=>loadProjects())
 await expect(row(page,'one').locator('img')).toHaveAttribute('src','/projects/one/thumbnail.webp')
 await expect.poll(()=>row(page,'one').locator('img').evaluate(image=>image.complete&&image.naturalWidth>0)).toBe(true)
 expect(await row(page,'two').locator('img').evaluate(image=>image===window.__originalImages.two)).toBe(true)
 expect(requests).toBe(3)
})

test('a missing preview keeps its fallback across refreshes instead of retrying and flashing',async({page})=>{
 let requests=0
 await page.route('**/projects/index.json',route=>route.fulfill({json:{projects:[{slug:'missing',display_name:'Missing paper'}]}}))
 await page.route('**/api/backups/activity',route=>route.fulfill({json:{projects:[],metadata:[]}}))
 await page.route('**/thumbnail.png',route=>{requests++;return route.fulfill({status:404,body:'Missing',headers:{'Cache-Control':'no-store'}})})
 await page.goto('/hub.html?lang=en')
 await expect(row(page,'missing').locator('.project-icon')).toHaveText('M')
 await row(page,'missing').evaluate(node=>window.__fallback=node.querySelector('.project-icon'))
 for(let index=0;index<3;index++)await page.evaluate(()=>loadProjects())
 expect(await row(page,'missing').locator('.project-icon').evaluate(node=>node===window.__fallback)).toBe(true)
 expect(requests).toBe(1)
 await expect(row(page,'missing').locator('img')).toHaveCount(0)
})
