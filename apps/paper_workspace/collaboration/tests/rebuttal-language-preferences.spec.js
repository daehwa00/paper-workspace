import {test,expect} from './fixtures.js'

async function mock(context,{stale=false}={}){
 const source='We explain the evidence.',translated=stale?'이전 한국어 답변입니다.':'근거를 설명합니다.'
 const round={id:'r1',title:'Language preference',reviewers:[{id:'a',name:'Reviewer A'}],reviews:[{id:'ra',reviewer_id:'a',fields:{review:'Please explain the evidence.'},translations:{review:'근거를 설명해 주세요.'}}],documents:[{id:'da',text_key:'da',kind:'reviewer',reviewer_id:'a',title:'Response',seed_text:source,korean_seed:{text:translated,meta:{source:stale?'Old source.':source,translation:translated,segments:[{source,text:translated}],glossary:{}}}}],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}
 const state={schema_version:1,revision:1,enabled:true,jobs:[],rounds:[round]};let calls=0
 await context.route('**/api/rebuttal/projects/**',async route=>{
  const path=new URL(route.request().url()).pathname
  if(path.endsWith('/versions'))return route.fulfill({json:route.request().method()==='GET'?{versions:[]}:{saved:true}})
  if(path.endsWith('/analyses')&&route.request().method()==='POST'){
   calls++;return route.fulfill({json:{...state,result:{job:{id:'translation',round_id:'r1',task:'translate_response',status:'completed',result:{translations:[{review_id:'da',field:'response',text:'새 한국어 답변입니다.',segments:[{source,text:'새 한국어 답변입니다.'}]}]}}}}})
  }
  return route.fulfill({json:state})
 })
 return {get calls(){return calls}}
}
const review=(root,language)=>root.locator(`[data-review-language="${language}"]`)
const answer=(root,language)=>root.locator(`[data-answer-language="${language}"]`)
async function selected(root,left,right){
 await expect(review(root,left)).toHaveAttribute('aria-pressed','true')
 await expect(answer(root,right)).toHaveAttribute('aria-pressed','true')
}
const project=()=>`prefs-${test.info().testId.slice(-10)}-${Date.now()}`
const standalone=slug=>`/p/${slug}/rebuttal?standalone=1&round=r1&lang=en#reviews`
async function ready(root){await expect(root.locator('#review-content')).toContainText('evidence')}

test('refresh restores both Korean choices and later remembers original and English',async({page,context})=>{
 const model=await mock(context),slug=project()
 await page.goto(standalone(slug));await ready(page)
 await review(page,'ko').click();await answer(page,'ko').click()
 await expect(page.locator('[data-ko-text]')).toHaveText('근거를 설명합니다.')
 await page.reload();await selected(page,'ko','ko')
 await expect(page.locator('#review-content')).toContainText('근거를 설명해 주세요.')
 await expect(page.locator('[data-ko-text]')).toHaveText('근거를 설명합니다.')
 await expect(page.locator('#notice')).toBeHidden()
 await review(page,'original').click();await answer(page,'en').click();await page.reload()
 await selected(page,'original','en');await expect(page.locator('#response-editor .cm-content')).toHaveText('We explain the evidence.')
 expect(model.calls).toBe(0)
})
test('review and response languages are independent and scoped to each paper',async({page,context})=>{
 await mock(context);const a=project(),b=a+'-b'
 await page.goto(standalone(a));await ready(page);await answer(page,'ko').click();await page.reload();await selected(page,'original','ko')
 await review(page,'ko').click();await answer(page,'en').click();await page.reload();await selected(page,'ko','en')
 await page.goto(standalone(b));await selected(page,'original','en');await answer(page,'ko').click()
 await page.goto(standalone(a));await selected(page,'ko','en')
})
test('embedded Rebuttal restores language choices after a full Paper page refresh',async({page,context})=>{
 const model=await mock(context),slug=project()
 await page.goto(`/p/${slug}/rebuttal?round=r1&lang=en#reviews`)
 const frame=page.frameLocator('.paper-review-frame')
 await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
 await ready(frame);await review(frame,'ko').click();await answer(frame,'ko').click()
 await expect(frame.locator('[data-ko-text]')).toHaveText('근거를 설명합니다.')
 await page.reload();await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
 await selected(frame,'ko','ko');await expect(frame.locator('[data-ko-text]')).toHaveText('근거를 설명합니다.')
 await expect(frame.locator('#notice')).toBeHidden();expect(model.calls).toBe(0)
})
test('restored Korean preference does not translate while Rebuttal is hidden behind Paper',async({page,context})=>{
 const model=await mock(context,{stale:true}),slug=project()
 await page.addInitScript(slug=>localStorage.setItem(`paper-rebuttal-answer-language:${slug}`,'ko'),slug)
 await page.goto(`/p/${slug}?lang=en`)
 const frame=page.frameLocator('.paper-review-frame')
 await expect(frame.locator('[data-ko-text]')).toHaveText('이전 한국어 답변입니다.')
 await expect(frame.locator('[data-ko-status]')).toContainText('English response changed')
 expect(model.calls).toBe(0)
 await page.locator('#open-rebuttal').click()
 await expect(frame.locator('[data-ko-text]')).toHaveText('새 한국어 답변입니다.')
 expect(model.calls).toBe(1)
})
test('invalid saved values fall back safely and blocked storage does not break switching',async({page,context})=>{
 await mock(context);const slug=project()
 await page.addInitScript(slug=>{localStorage.setItem(`paper-rebuttal-review-language:${slug}`,'unexpected');localStorage.setItem(`paper-rebuttal-answer-language:${slug}`,'unexpected')},slug)
 await page.goto(standalone(slug));await selected(page,'original','en')
 await page.evaluate(()=>{const storage=window.localStorage;Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:storage.getItem.bind(storage),setItem(){throw new DOMException('blocked','SecurityError')}}})})
 await review(page,'ko').click();await answer(page,'ko').click();await selected(page,'ko','ko')
 await expect(page.locator('[data-ko-text]')).toHaveText('근거를 설명합니다.')
 await expect(page.locator('#notice')).toBeHidden()
})
