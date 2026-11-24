import {test,expect} from './fixtures.js'

const key='response:language-doc', editor='#response-editor .cm-content', preview='#response-preview', korean='#response-korean'
function translatedDocument(){
 const segments=[]
 for(let i=1;i<=24;i++){
  const n=String(i).padStart(2,'0')
  segments.push({source:`## EN_SECTION_${n}\n\n`,text:`## KO_SECTION_${n}\n\n`})
  segments.push({source:`EN_BODY_${n} `+'This paragraph reports evidence with careful interpretation and controlled uncertainty. '.repeat(4+(i%3))+`The equation is $x_${n}=1$.`,text:`KO_BODY_${n} `+'이 문단은 실험 근거와 해석의 범위 및 불확실성을 함께 설명합니다. '.repeat(4+(i%2))+`수식은 $x_${n}=1$입니다.`})
  segments.push({source:'\n\n',text:'\n\n'})
 }
 return {source:segments.map(p=>p.source).join(''),text:segments.map(p=>p.text).join(''),segments}
}
async function open(page,context,{delayed=false,manual=false,mobile=false}={}){
 const data=translatedDocument(),meta={source:data.source,translation:data.text,segments:data.segments,glossary:{}}
 const doc={id:'language-doc',title:'Language response',reviewer_id:'a',kind:'reviewer',text_key:key,seed_text:data.source}
 if(!delayed)doc.korean_seed={text:data.text,...(!manual?{meta}: {})}
 const other={id:'other-doc',title:'Other response',reviewer_id:'b',kind:'reviewer',text_key:'response:other',seed_text:'Other English response.',korean_seed:{text:'다른 답변입니다.',meta:{source:'Other English response.',translation:'다른 답변입니다.',segments:[{source:'Other English response.',text:'다른 답변입니다.'}],glossary:{}}}}
 const round={id:'r1',title:'Language reading',reviewers:[{id:'a',name:'Reviewer A'},{id:'b',name:'Reviewer B'}],reviews:[{id:'ra',reviewer_id:'a',fields:{review:'Review evidence and interpretation.\n\n'.repeat(50)},translations:{}},{id:'rb',reviewer_id:'b',fields:{review:'Other review.'},translations:{}}],documents:[doc,other],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}
 const state={schema_version:1,revision:1,enabled:true,rounds:[round],jobs:[]};let done=false,calls=0
 const result={translations:[{review_id:doc.id,field:'response',text:data.text,segments:data.segments}]}
 const job=()=>({id:'translation',round_id:'r1',task:'translate_response',status:done?'completed':'running',...(done?{result}:{translation_progress:{translations:[{review_id:doc.id,field:'response',text:data.segments.slice(0,12).map(p=>p.text).join(''),segments:data.segments.slice(0,12)}],completed:4,total:24}})})
 await context.route('**/api/rebuttal/projects/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname
  if(path.endsWith('/versions'))return route.fulfill({json:request.method()==='GET'?{versions:[]}:{saved:true}})
  if(request.method()==='POST'&&path.endsWith('/analyses')){calls++;expect(delayed).toBe(true);return route.fulfill({json:{...state,result:{job:job()}}})}
  if(/\/analyses\/translation$/.test(path))return route.fulfill({json:{job:job()}})
  return route.fulfill({json:state})
 })
 await page.setViewportSize(mobile?{width:390,height:844}:{width:1600,height:1000})
 await page.emulateMedia({reducedMotion:'reduce'})
 await page.goto(`/p/language-${test.info().testId.slice(-12)}-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
 await expect(page.locator(editor)).toContainText('EN_SECTION_01')
 await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
 await page.evaluate(()=>document.fonts.ready)
 return {...data,meta,get calls(){return calls},finish(){done=true}}
}
async function box(page,selector,token){return page.locator(selector).evaluate((host,token)=>{
 const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);let node
 while(node=walker.nextNode()){
  if(node.parentElement.closest('mjx-container,.cm-remoteCaret'))continue
  const at=node.data.indexOf(token);if(at<0)continue
  const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+token.length)
  const rect=range.getBoundingClientRect();return {y:rect.y,height:rect.height}
 }
 return null
},token)}
async function at(page,selector,token,allowClamp=false){
 const target=await box(page,selector,token);expect(target).not.toBeNull()
 await page.locator(selector).evaluate((host,y)=>{host.scrollTop+=y-host.getBoundingClientRect().top-8},target.y)
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const current=await box(page,selector,token),bounds=await page.locator(selector).boundingBox()
 if(!allowClamp){expect(current.y-bounds.y).toBeGreaterThanOrEqual(-1);expect(current.y-bounds.y).toBeLessThan(35)}
 return current
}
async function startAtEnglish(page,mode='preview',token='EN_SECTION_16'){
 await page.locator('[data-response-view=toggle]').click();await expect(page.locator(preview)).toContainText(token)
 const point=await at(page,preview,token)
 if(mode==='plain'){await page.locator('[data-response-view=toggle]').click();await expect(page.locator(editor)).toBeVisible();await expect.poll(async()=>{const current=await box(page,editor,token);return current?Math.abs(current.y-point.y):1e9}).toBeLessThanOrEqual(25)}
 return box(page,mode==='preview'?preview:editor,token)
}
async function assertAt(page,selector,token,previous){
 await expect(page.locator(selector)).toContainText(token)
 await expect.poll(async()=>{const current=await box(page,selector,token);return current?Math.abs(current.y-previous.y):1e9}).toBeLessThanOrEqual(28)
}
async function unchanged(page,data){
 const actual=await page.evaluate(key=>{const session=window.PaperRebuttalSession,map=session.mapFor('rebuttalResponses');return {en:map.get(key).toString(),ko:map.get('ko:language-doc')?.toString(),meta:session.mapFor('rebuttalKoreanMeta').get('language-doc')}},key)
 expect(actual.en).toBe(data.source);expect(actual.ko).toBe(data.text);expect(actual.meta).toEqual(data.meta)
}
for(const mode of ['plain','preview'])test(`response language follows the same passage and repeated switches do not drift in ${mode}`,async({page,context})=>{
 const data=await open(page,context),point=await startAtEnglish(page,mode)
 const left=await page.locator('#review-content').evaluate(node=>{node.scrollTop=170;return node.scrollTop})
 for(let i=0;i<3;i++){
  await page.locator('[data-answer-language=ko]').click();await assertAt(page,mode==='preview'?preview:korean,'KO_SECTION_16',point)
  await page.locator('[data-answer-language=en]').click();await assertAt(page,mode==='preview'?preview:editor,'EN_SECTION_16',point)
 }
 await page.locator('[data-answer-language=ko]').click();await assertAt(page,mode==='preview'?preview:korean,'KO_SECTION_16',point)
 const next=await at(page,mode==='preview'?preview:korean,'KO_SECTION_19')
 await page.locator('[data-answer-language=en]').click();await assertAt(page,mode==='preview'?preview:editor,'EN_SECTION_19',next)
 expect(await page.locator('#review-content').evaluate(node=>node.scrollTop)).toBe(left)
 await expect(page.locator('[data-response-view=toggle]')).toHaveAttribute('aria-pressed',String(mode==='preview'))
 await unchanged(page,data);expect(data.calls).toBe(0)
})
test('near the document end the passage remains visible and a round trip preserves the clamped position',async({page,context})=>{
 await open(page,context);await startAtEnglish(page)
 await page.locator('[data-answer-language=ko]').click();await expect(page.locator(preview)).toContainText('KO_SECTION_24')
 const point=await at(page,preview,'KO_SECTION_22',true),scroll=await page.locator(preview).evaluate(node=>node.scrollTop)
 await page.locator('[data-answer-language=en]').click()
 await expect.poll(async()=>{const marker=await box(page,preview,'EN_SECTION_22'),bounds=await page.locator(preview).boundingBox();return marker?.y>=bounds.y&&marker.y+marker.height<=bounds.y+bounds.height}).toBe(true)
 await page.locator('[data-answer-language=ko]').click();await assertAt(page,preview,'KO_SECTION_22',point)
 await expect.poll(async()=>Math.abs(await page.locator(preview).evaluate(node=>node.scrollTop)-scroll)).toBeLessThanOrEqual(3)
})
for(const mode of ['plain','preview'])test(`mobile language switching keeps the passage and page position in ${mode}`,async({page,context})=>{
 const data=await open(page,context,{mobile:true}),point=await startAtEnglish(page,mode)
 const pageY=await page.evaluate(()=>scrollY)
 await page.locator('[data-answer-language=ko]').click();await assertAt(page,mode==='preview'?preview:korean,'KO_SECTION_16',point)
 expect(Math.abs(await page.evaluate(()=>scrollY)-pageY)).toBeLessThanOrEqual(1)
 await page.locator('[data-answer-language=en]').click();await assertAt(page,mode==='preview'?preview:editor,'EN_SECTION_16',point)
 await unchanged(page,data)
})
test('a delayed translation resumes at the requested passage when that block arrives',async({page,context})=>{
 const data=await open(page,context,{delayed:true}),point=await startAtEnglish(page)
 await page.locator('[data-answer-language=ko]').click();await expect(page.locator(preview)).toContainText('KO_SECTION_04')
 await expect(page.locator(preview)).not.toContainText('KO_SECTION_16')
 data.finish();await assertAt(page,preview,'KO_SECTION_16',point);expect(data.calls).toBe(1)
})
test('user scrolling while translation is pending cancels the late position restore',async({page,context})=>{
 const data=await open(page,context,{delayed:true});await startAtEnglish(page)
 await page.locator('[data-answer-language=ko]').click();await expect(page.locator(preview)).toContainText('KO_SECTION_04')
 await page.locator(preview).hover();await page.mouse.wheel(0,100)
 await page.locator(preview).evaluate(node=>{node.scrollTop=0})
 data.finish();await expect(page.locator(preview)).toContainText('KO_SECTION_24')
 await expect.poll(()=>page.locator(preview).evaluate(node=>node.scrollTop)).toBeLessThan(100)
})
test('rapid switches and changing response cancel stale language restores',async({page,context})=>{
 await open(page,context);const point=await startAtEnglish(page)
 await page.evaluate(()=>{document.querySelector('[data-answer-language=ko]').click();document.querySelector('[data-answer-language=en]').click()})
 await assertAt(page,preview,'EN_SECTION_16',point)
 await page.locator('[data-answer-language=ko]').click()
 await page.locator('[data-action=open-review][data-id=b]').click()
 await expect(page.locator(preview)).toHaveText('다른 답변입니다.')
 await expect.poll(()=>page.locator(preview).evaluate(node=>node.scrollTop)).toBe(0)
})
test('manual Korean without correspondence keeps reading progress and is not overwritten',async({page,context})=>{
 const data=await open(page,context,{manual:true});await startAtEnglish(page)
 await page.locator('[data-answer-language=ko]').click();await expect(page.locator(preview)).toContainText('KO_SECTION_24')
 await expect.poll(()=>page.locator(preview).evaluate(node=>node.scrollTop)).toBeGreaterThan(300)
 expect(await page.evaluate(key=>window.PaperRebuttalSession.mapFor('rebuttalResponses').get(key).toString(),'ko:language-doc')).toBe(data.text)
 expect(data.calls).toBe(0)
})
