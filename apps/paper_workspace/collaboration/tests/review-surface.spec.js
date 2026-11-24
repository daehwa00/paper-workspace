import {test,expect} from './fixtures.js'
const metadata=()=>({schema_version:1,revision:0,enabled:true,jobs:[],rounds:[{
 id:'r1',title:'Synthetic review',reviewers:[{id:'reviewer1',name:'Reviewer A'}],
 reviews:[{id:'review1',reviewer_id:'reviewer1',fields:{summary:'Please clarify the baseline.'},translations:{}}],
 documents:[{id:'doc1',title:'Response to Reviewer A',kind:'reviewer',reviewer_id:'reviewer1',text_key:'response:doc1',seed_text:'A response draft retained through notifications.'}],
 imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}
}]})

for(const theme of ['light','dark'])for(const width of [1440,390])test(`review notices keep an opaque surface at ${width} in ${theme}`,async({page},info)=>{
 await page.setViewportSize({width,height:800})
 await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
 const state=metadata()
 await page.route('**/api/rebuttal/projects/**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/versions')?{versions:[],saved:true}:state}))
 await page.goto(`/p/review-surface-${crypto.randomUUID()}?lang=ko`)
 await page.waitForFunction(()=>workspaceReadyForCompile)
 const original=await page.evaluate(()=>({id:window.PaperWorkspaceSharedSession.document.clientID,source:editorValue()}))
 await page.locator('#open-rebuttal').click()
 const review=page.frameLocator('.paper-review-frame')
 await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
 await expect(review.locator('.review-workspace')).toBeVisible()
 await expect(page.locator('.shell')).toHaveCSS('opacity','0')
 await expect(page.locator('.paper-review-frame')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)')
 await expect(review.locator('html')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)')
 await expect(review.locator('.project-frame-header')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)')
 const originalResponse=await review.locator('#response-editor .cm-content').innerText()
 // Make any accidental Paper bleed unmistakable, including compositor gaps.
 await page.locator('.shell').evaluate(shell=>{
  const marker=document.createElement('div');marker.id='paper-underlay-probe';marker.style.cssText='position:fixed;inset:0;z-index:999999;background:rgb(255,0,255)';shell.append(marker)
 })
 await review.locator('#notice').evaluate(node=>{
  node.className='notice error';node.textContent='다른 공동 작업자가 라운드를 수정했습니다. 입력한 내용은 유지됩니다. 최신 상태를 확인한 후 다시 저장하세요. '.repeat(3);node.hidden=false
 })
 await expect(review.locator('#notice')).toBeVisible()
 await page.screenshot({path:info.outputPath('notice-visible.png')})
 await review.locator('html').evaluate(()=>scrollTo(0,document.documentElement.scrollHeight))
 await expect(page.locator('.shell')).toHaveCSS('opacity','0')
 await expect(review.locator('#response-editor .cm-content')).toHaveText(originalResponse)
 await page.screenshot({path:info.outputPath('notice-surface.png')})
 const screenshot=(await page.screenshot()).toString('base64')
 const magenta=await page.evaluate(async encoded=>{
  const image=new Image();image.src='data:image/png;base64,'+encoded;await image.decode()
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
  const context=canvas.getContext('2d');context.drawImage(image,0,0)
  const data=context.getImageData(0,0,image.width,image.height).data;let count=0
  for(let index=0;index<data.length;index+=4)if(data[index]>245&&data[index+1]<10&&data[index+2]>245)count++
  return count
 },screenshot)
 expect(magenta).toBe(0)
 await review.locator('#notice').evaluate(node=>node.hidden=true)
 await review.locator('html').evaluate(()=>scrollTo(0,0))
 await review.locator('#manuscript-link').click()
 await expect(page.locator('.paper-review-frame')).not.toHaveClass(/is-active/)
 await page.locator('#paper-underlay-probe').evaluate(node=>node.remove())
 await expect(page.locator('.shell')).toHaveCSS('opacity','1')
 expect(await page.evaluate(()=>({id:window.PaperWorkspaceSharedSession.document.clientID,source:editorValue()}))).toEqual(original)
})
