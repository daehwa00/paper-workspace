// Read-only public shell capture. Never substitutes Linear API responses.
import {chromium} from '../../apps/paper_workspace/collaboration/node_modules/playwright-core/index.mjs'
import {getPublicAsset,assets,cleanURL} from './linear_public_asset_transport.mjs'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const out=resolve(process.env.LINEAR_REFERENCE_OUTPUT||'.omx/artifacts/linear-live-reference/reproduced')
mkdirSync(out,{recursive:true})
const browser=await chromium.launch({args:['--disable-http2','--disable-quic']})
try {
  for(const scheme of ['light','dark']) {
    const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:scheme})
    const page=await context.newPage(),errors=[]
    try {
      page.on('pageerror',error => errors.push({pageError:error.message}))
      await page.route('https://static.linear.app/**',async route => {
        try {const asset=await getPublicAsset(route.request().url());await route.fulfill({status:200,contentType:asset.type,body:asset.body})}
        catch(e) {errors.push({url:cleanURL(route.request().url()),error:e.message.split('\n')[0]});await route.abort()}
      })
      page.on('requestfailed',request => {if(!request.url().startsWith('https://static.linear.app/'))errors.push({url:cleanURL(request.url()),error:request.failure()?.errorText})})
      await page.goto('https://linear.app/demo/my-issues/assigned',{waitUntil:'domcontentloaded',timeout:30000})
      await page.getByText('My issues',{exact:true}).first().waitFor({timeout:60000})
      await page.evaluate(() => document.fonts.ready)
      await page.getByText('Assigned',{exact:true}).first().waitFor()
      await page.mouse.move(1599,999)
      const data=await page.evaluate(() => {
        const box=e => {const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,text:e.textContent.slice(0,70),x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,padding:s.padding,gap:s.gap,radius:s.borderRadius,border:s.borderWidth,background:s.backgroundColor,color:s.color}}
        const chain=e => {const result=[];for(let i=0;e&&i<14;i++,e=e.parentElement)result.push(box(e));return result}
        const link=document.querySelector('a[href="/demo/my-issues/assigned"]')
        return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale},fonts:document.fonts.status,body:document.body.innerText.slice(0,3000),setupPending:document.body.innerText.includes('Setting up Linear Demo'),ancestors:chain(link),leaves:[...link.querySelectorAll('*')].filter(e=>[...e.childNodes].some(n=>n.nodeType===3&&n.nodeValue.trim())).map(box),headingAncestors:chain(document.querySelector('h2')),regions:[...document.querySelectorAll('main,aside,nav,[role=main],[role=navigation],h1,h2')].map(box)}
      })
      await page.screenshot({path:`${out}/public-demo-${scheme}-1600.png`,animations:'disabled'})
      writeFileSync(`${out}/public-demo-${scheme}-1600.json`,JSON.stringify({capturedAt:new Date().toISOString(),url:page.url(),scheme,...data,errors},null,2)+'\n')
      console.log(JSON.stringify({scheme,url:page.url(),setupPending:data.setupPending,errors:errors.length}))
    } catch(error) {
      await page.screenshot({path:`${out}/public-demo-${scheme}-failure.png`,animations:'disabled'}).catch(()=>{})
      writeFileSync(`${out}/public-demo-${scheme}-failure.json`,JSON.stringify({capturedAt:new Date().toISOString(),url:page.url(),error:error.message,errors},null,2)+'\n')
      throw error
    } finally {await context.close()}
  }
} finally {
  await browser.close()
  writeFileSync(`${out}/public-assets.json`,JSON.stringify(assets,null,2)+'\n')
}
