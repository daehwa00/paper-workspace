import {test,expect} from './fixtures.js'
for(const view of ['paper','review'])test(`sidebar ${view}: bounded layout work and repeat toggles`,async({page})=>{
  await page.setViewportSize({width:1600,height:1000})
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:false,assistantCollapsed:true})))
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.goto(view==='paper'?'/p/sidebar-motion':'/p/sidebar-motion/rebuttal?standalone=1')
  const button=view==='paper'?'#toggle-sidebar':'#toggle-review-sidebar'
  await expect(page.locator(button)).toBeVisible()
  if(view==='paper')await page.waitForFunction(()=>workspaceReadyForCompile)
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,350)))
  const metrics=await page.evaluate(async button=>{
    const main=document.querySelector('.project-frame-main');let changes=0
    const observer=new ResizeObserver(()=>changes++);observer.observe(main)
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));changes=0
    document.querySelector(button).click()
    await new Promise(resolve=>setTimeout(resolve,400))
    const closing=changes;changes=0
    document.querySelector(button).click()
    await new Promise(resolve=>setTimeout(resolve,400))
    observer.disconnect();return {closing,opening:changes}
  },button)
  console.log(view,JSON.stringify(metrics))
  if(!process.env.SIDEBAR_BASELINE){expect(metrics.closing).toBeLessThanOrEqual(4);expect(metrics.opening).toBeLessThanOrEqual(4)}
  await expect(page.locator(button)).toHaveAttribute('aria-expanded','true')
  await page.waitForFunction(()=>!document.documentElement.classList.contains('sidebar-motion-running'))
  const reversal=await page.evaluate(async({button,view})=>{
    const nav=document.querySelector('.project-workspace-nav')
    const before=nav.getBoundingClientRect().left
    if(view==='paper')setEditorSelection(2,10)
    const selection=view==='paper'?editorSelection():null
    document.querySelector(button).click()
    await new Promise((resolve,reject)=>{
      const deadline=performance.now()+2000
      const tick=()=>{const a=document.getAnimations().find(a=>a.id==='paper-sidebar-motion');if(a?.currentTime>35 && a.currentTime<170)return resolve();if(performance.now()>deadline)return reject(new Error('No intermediate live frame'));requestAnimationFrame(tick)};requestAnimationFrame(tick)
    })
    document.getAnimations().filter(animation=>animation.id==='paper-sidebar-motion').forEach(animation=>animation.pause())
    const middle=nav.getBoundingClientRect().left
    const liveTransform=getComputedStyle(document.querySelector('.project-frame-main')).transform
    document.querySelector(button).click()
    const reversed=nav.getBoundingClientRect().left
    await new Promise((resolve,reject)=>{
      const deadline=performance.now()+2500
      const tick=()=>{if(!document.documentElement.classList.contains('sidebar-motion-running'))return resolve();if(performance.now()>deadline)return reject(new Error('Queued transition did not finish'));requestAnimationFrame(tick)};requestAnimationFrame(tick)
    })
    return {before,middle,reversed,liveTransform,after:nav.getBoundingClientRect().left,selection,afterSelection:view==='paper'?editorSelection():null,remaining:document.getAnimations().filter(a=>a.id==='paper-sidebar-motion').length}
  },{button,view})
  expect(Math.abs(reversal.before-reversal.middle)).toBeGreaterThan(1)
  expect(Math.abs(reversal.middle-reversal.reversed)).toBeLessThan(1)
  expect(reversal.liveTransform).toBe('none')
  expect(Math.abs(reversal.before-reversal.after)).toBeLessThan(1)
  expect(reversal.afterSelection).toEqual(reversal.selection)
  expect(reversal.remaining).toBe(0)
  if(view==='review')await expect(page.locator('body')).not.toHaveClass(/sidebar-motion-active/)
  await expect(page.locator(button)).toHaveAttribute('aria-expanded','true')
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.locator(button).click()
  await expect(page.locator(button)).toHaveAttribute('aria-expanded','false')
  expect(await page.evaluate(()=>document.getAnimations().filter(a=>a.id==='paper-sidebar-motion').length)).toBe(0)
})

async function openReviewWithNotes(page,width,{longContent=false}={}){
  const round={id:'r1',title:'Sidebar fixture',reviewers:[{id:'a',name:'Reviewer A'}],reviews:[{id:'review',reviewer_id:'a',fields:{review:'Please clarify the evidence.'},translations:{}}],documents:[{id:'answer',title:'Response',kind:'reviewer',reviewer_id:'a',text_key:'response:answer',seed_text:'An unchanged response with supporting evidence.'}],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}
  if(longContent){round.reviews[0].fields.review='Please clarify the evidence and explain the uncertainty in the comparison. '.repeat(400);round.documents[0].seed_text='We report the supporting evidence and the uncertainty in our comparison. '.repeat(300)}
  const state={schema_version:1,revision:0,enabled:true,jobs:[],rounds:[round]}
  await page.route('**/api/rebuttal/projects/**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/versions')?{versions:[]}:state}))
  await page.setViewportSize({width,height:900})
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:false})))
  await page.goto(`/p/sidebar-notes-${width}-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await expect(page.locator('#response-editor .cm-content')).toBeVisible()
  await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await page.locator('#response-memos-toggle').click()
  await expect(page.locator('#response-memos-panel')).toBeVisible()
  await expect(page.locator('#mapping-workspace')).not.toHaveClass(/memo-panel-animating/)
}
test('long review keeps original content opaque and unscaled without screen captures',async({page,browserName})=>{
  await openReviewWithNotes(page,1600,{longContent:true})
  const session=browserName==='chromium' ? await page.context().newCDPSession(page) : null
  await session?.send('Emulation.setCPUThrottlingRate',{rate:4})
  await page.evaluate(()=>{
    window.sidebarOriginalEditor=document.querySelector('#response-editor .cm-editor')
    window.sidebarOriginalReview=document.querySelector('.source-panel')
    document.startViewTransition=()=>{throw new Error('Sidebar must not capture or crossfade screens')}
  })
  for(const expanded of ['false','true']){
    await page.evaluate(()=>document.getElementById('toggle-review-sidebar').click())
    await page.waitForFunction(()=>document.getAnimations().some(animation=>animation.id==='paper-sidebar-motion'&&animation.currentTime>25&&animation.currentTime<150))
    await page.evaluate(()=>document.getAnimations().filter(animation=>animation.id==='paper-sidebar-motion').forEach(animation=>animation.pause()))
    for(const time of [0,35,110,190,219]){
      await page.evaluate(time=>document.getAnimations().filter(animation=>animation.id==='paper-sidebar-motion').forEach(animation=>animation.currentTime=time),time)
      const live=await page.evaluate(()=>{
        const review=document.querySelector('.source-panel'),response=document.querySelector('.response-panel')
        const nodes=[review,response,document.querySelector('#response-editor .cm-editor')]
        const contentLayoutAnimations=document.getAnimations().filter(animation=>!animation.effect?.target?.closest('.project-frame-sidebar') && animation.effect?.getKeyframes().some(frame=>Object.keys(frame).some(property=>/^(width|height|left|right|top|bottom|padding|margin|flex|gridTemplate)/.test(property))))
        const transform=new DOMMatrixReadOnly(getComputedStyle(review).transform)
        return {sameEditor:window.sidebarOriginalEditor===nodes[2],sameReview:window.sidebarOriginalReview===review,opaque:nodes.every(node=>getComputedStyle(node).opacity==='1'&&getComputedStyle(node).visibility==='visible'),scale:[transform.a,transform.d],layoutAnimations:contentLayoutAnimations.length,frameRight:document.querySelector('.sidebar-frame-surface').getBoundingClientRect().right,ancestorTransforms:[document.querySelector('.project-frame-main'),document.getElementById('mapping-workspace')].map(node=>getComputedStyle(node).transform)}
      })
      expect(live.sameEditor).toBe(true)
      expect(live.sameReview).toBe(true)
      expect(live.opaque).toBe(true)
      expect(live.scale).toEqual([1,1])
      expect(live.layoutAnimations).toBe(0)
      expect(Math.abs(live.frameRight-1592)).toBeLessThan(1)
      expect(live.ancestorTransforms).toEqual(['none','none'])
    }
    await page.evaluate(()=>document.getAnimations().filter(animation=>animation.id==='paper-sidebar-motion').forEach(animation=>animation.play()))
    await expect(page.locator('#toggle-review-sidebar')).toHaveAttribute('aria-expanded',expanded)
    await page.waitForFunction(()=>!document.documentElement.classList.contains('sidebar-motion-running'))
    await expect(page.locator('.sidebar-frame-surface')).toHaveCount(0)
  }
  await session?.send('Emulation.setCPUThrottlingRate',{rate:1})
})
for(const width of [1000,1600])test(`notes stay anchored through sidebar intermediate frames at ${width}px`,async({page})=>{
  await openReviewWithNotes(page,width)
  const result=await page.evaluate(async()=>{
    const nodes=['response-memos-panel','response-memos-resizer'].map(id=>document.getElementById(id))
    const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
    const before=nodes.map(rect),samples=[],edgeVisibility=[]
    const text=window.PaperRebuttalSession.mapFor('rebuttalResponses').get('response:answer').toString()
    document.getElementById('toggle-review-sidebar').click()
    const deadline=performance.now()+240
    do{await new Promise(requestAnimationFrame);samples.push(nodes.map(rect));edgeVisibility.push(getComputedStyle(document.getElementById('mapping-edges')).visibility)}while(performance.now()<deadline)
    return {before,samples,edgeVisibility,text,afterText:window.PaperRebuttalSession.mapFor('rebuttalResponses').get('response:answer').toString()}
  })
  expect(result.samples.length).toBeGreaterThan(2)
  for(const sample of result.samples)for(let i=0;i<2;i++)for(const key of ['x','y','width','height'])expect(Math.abs(sample[i][key]-result.before[i][key]),`notes ${key}`).toBeLessThan(1)
  expect(result.afterText).toBe(result.text)
  expect(result.edgeVisibility).toContain('hidden')
  await expect(page.locator('body')).not.toHaveClass(/sidebar-motion-active/)
  await expect(page.locator('#mapping-edges')).toHaveCSS('visibility','visible')
})

for(const view of ['paper','review'])test(`external layout changes cancel sidebar motion in ${view}`,async({page})=>{
  await page.setViewportSize({width:1600,height:900})
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:false,assistantCollapsed:true})))
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.goto(view==='paper'?'/p/sidebar-cancel':'/p/sidebar-cancel/rebuttal?standalone=1')
  if(view==='paper')await page.waitForFunction(()=>workspaceReadyForCompile)
  const button=view==='paper'?'#toggle-sidebar':'#toggle-review-sidebar'
  await expect(page.locator(button)).toBeVisible()
  if(view==='review')await page.waitForFunction(()=>!document.querySelector('#main>#loading'))
  if(view==='review'){
    await page.waitForFunction(()=>window.PaperRebuttalSession)
    await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  }
  for(const event of (view==='paper'?['resize','storage','reset','resizer','reduced-motion']:['resize','storage','reduced-motion'])){
    await page.waitForFunction(()=>!document.documentElement.classList.contains('sidebar-motion-running'))
    await page.evaluate(async ({button,event})=>{
      document.querySelector(button).click()
      await new Promise((resolve,reject)=>{const deadline=performance.now()+2000;function tick(){const animations=document.getAnimations().filter(a=>a.id==='paper-sidebar-motion');if(animations.some(a=>a.currentTime>35&&a.currentTime<170)){animations.forEach(a=>a.pause());resolve();return}if(performance.now()>deadline){reject(new Error('No intermediate frame for '+event));return}requestAnimationFrame(tick)}requestAnimationFrame(tick)})
    },{button,event})
    if(event==='resize')await page.setViewportSize({width:1500,height:900})
    if(event==='storage')await page.evaluate(()=>{const key='paper-workspace-layout',value=JSON.stringify({sidebarCollapsed:false,sidebarWidth:270});localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value,storageArea:localStorage}))})
    if(event==='reset')await page.evaluate(()=>resetLayout())
    if(event==='resizer')await page.locator('[data-resize="editor-preview"]').press('ArrowRight')
    if(event==='reduced-motion')await page.emulateMedia({reducedMotion:'reduce'})
    await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(a=>a.id==='paper-sidebar-motion').length),{message:event}).toBe(0)
    if(view==='review')await expect(page.locator('body')).not.toHaveClass(/sidebar-motion-active/)
  }
})

test('immediate repeated toggles cannot replay after a later reset',async({page})=>{
  await page.setViewportSize({width:1600,height:900})
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:false,assistantCollapsed:true})))
  await page.goto('/p/sidebar-early-cancel')
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await page.evaluate(()=>{
    document.getElementById('toggle-sidebar').click()
    document.getElementById('toggle-sidebar').click()
    resetLayout()
  })
  await page.waitForFunction(()=>!document.documentElement.classList.contains('sidebar-motion-running'))
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded','true')
  expect(await page.evaluate(()=>getComputedStyle(document.querySelector('.project-frame-main')).transform)).toBe('none')
  expect(await page.evaluate(()=>document.querySelectorAll('[style*="view-transition-name: sidebar-"]').length)).toBe(0)
})

test('browsers without element animations change layout without stale motion or lost clicks',async({page})=>{
  await page.setViewportSize({width:1600,height:900})
  await page.addInitScript(()=>{Element.prototype.animate=undefined;localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:false,assistantCollapsed:true}))})
  await page.goto('/p/sidebar-no-snapshot')
  await page.waitForFunction(()=>workspaceReadyForCompile)
  await page.locator('#toggle-sidebar').click()
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded','false')
  await page.locator('#toggle-sidebar').click()
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded','true')
  expect(await page.evaluate(()=>document.getAnimations().filter(a=>a.id==='paper-sidebar-motion').length)).toBe(0)
})

for(const view of ['paper','review'])test(`external saved layout wins over repeated local ${view} toggles`,async({page})=>{
  await page.setViewportSize({width:1600,height:900})
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:false,sidebarWidth:244,assistantCollapsed:true})))
  await page.route('**/api/rebuttal/projects/**/state',route=>route.fulfill({json:{revision:0,enabled:true,rounds:[],jobs:[]}}))
  await page.goto(view==='paper'?'/p/sidebar-external-wins':'/p/sidebar-external-wins/rebuttal?standalone=1')
  if(view==='paper')await page.waitForFunction(()=>workspaceReadyForCompile)
  else{await page.waitForFunction(()=>window.PaperRebuttalSession);await page.evaluate(()=>window.PaperRebuttalSession.whenReady)}
  const button=view==='paper'?'#toggle-sidebar':'#toggle-review-sidebar'
  await page.evaluate(button=>{
    for(let i=0;i<3;i++)document.querySelector(button).click()
    const key='paper-workspace-layout',value=JSON.stringify({sidebarCollapsed:true,sidebarWidth:288,assistantCollapsed:true})
    localStorage.setItem(key,value)
    window.dispatchEvent(new StorageEvent('storage',{key,newValue:value,storageArea:localStorage}))
  },button)
  await page.waitForFunction(()=>!document.documentElement.classList.contains('sidebar-motion-running'))
  await expect(page.locator(button)).toHaveAttribute('aria-expanded','false')
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('paper-workspace-layout')))).toEqual({sidebarCollapsed:true,sidebarWidth:288,assistantCollapsed:true})
})

test('failed review layout callback reports failure and restores connection visibility',async({page})=>{
  await openReviewWithNotes(page,1600)
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.evaluate(()=>{PaperUI.updateSidebarToggle=()=>{throw new Error('isolated layout callback failure')}})
  await page.locator('#toggle-review-sidebar').click()
  await expect(page.locator('#notice')).toContainText('Unable to change sidebar layout.')
  await expect(page.locator('body')).not.toHaveClass(/sidebar-motion-active/)
  await page.waitForFunction(()=>!document.documentElement.classList.contains('sidebar-motion-running'))
  await expect(page.locator('#mapping-edges')).toHaveCSS('visibility','visible')
  expect(errors).toEqual([])
})
