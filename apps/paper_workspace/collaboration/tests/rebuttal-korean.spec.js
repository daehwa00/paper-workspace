import { test, expect } from './fixtures.js'

test('Korean translation refreshes when English changes and persists', async ({page,context}) => {
  if(process.env.PAPER_REBUTTAL_JS)await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
  if(process.env.PAPER_REBUTTAL_CSS)await context.route('**/rebuttal.css*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_CSS,contentType:'text/css'}))
  if(process.env.PAPER_REBUTTAL_MODEL)await context.route('**/rebuttal-model.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_MODEL,contentType:'application/javascript'}))
  const round={id:'r1',title:'Review',reviewers:[{id:'a',name:'Reviewer A'},{id:'b',name:'Reviewer B'}],reviews:[{id:'ra',reviewer_id:'a',fields:{review:'Please clarify.'},translations:{}},{id:'rb',reviewer_id:'b',fields:{review:'Please compare.'},translations:{}}],documents:[{id:'da',text_key:'da',kind:'reviewer',reviewer_id:'a',title:'Response A',seed_text:'We added an experiment.'},{id:'db',text_key:'db',kind:'reviewer',reviewer_id:'b',title:'Response B',seed_text:'We added a baseline.'}],imports:[],concerns:[{id:'c1',title:'Clarify',reviewer_id:'a',source_spans:[{review_id:'ra',field:'review',quote:'Please clarify.',start:0,end:15}],requires_response:true,strategy:'clarify',work_status:'todo',comments:[]}],mappings:[{id:'m1',concern_id:'c1',response_spans:[{document_id:'da',quote:'We added an experiment.',start:0,end:23}],coverage:'partial',decision:'proposed',reason:'Clarification'}],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}
  round.mappings.push({...round.mappings[0],id:'m2'})
  let state={schema_version:1,revision:1,enabled:true,jobs:[],rounds:[round]}, exported=null, translations=0
  await context.route('**/api/rebuttal/projects/**',async route=>{
    const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON() || {}
    if(path.endsWith('/versions'))return route.fulfill({json:{versions:[]}})
    if(route.request().method()==='GET' && /\/analyses\/[^/]+$/.test(path))return route.fulfill({json:{job:state.jobs.find(job=>job.id===path.split('/').at(-1))}})
    if(route.request().method()==='POST' && path.endsWith('/exports')){exported=body;return route.fulfill({json:{...state,result:{filename:'response.txt',mime:'text/plain',content:body.texts.da}}})}
    if(route.request().method()==='POST' && path.endsWith('/analyses')){
      expect(body.task).toBe('translate_response')
      const doc=body.scope.document_ids[0],source=body.texts[doc],text=source.includes('More evidence.')?'실험과 추가 근거를 제시했습니다.':'실험을 추가했습니다.'
      const job={id:`job${++translations}`,round_id:'r1',task:'translate_response',status:'completed',result:{translations:[{review_id:doc,field:'response',text,segments:[{source,text}]}]}}
      state={...state,revision:state.revision+1,jobs:[job]};return route.fulfill({json:{...state,result:{job}}})
    }
    return route.fulfill({json:state})
  })
  await page.goto(`/p/ko-draft-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await expect(page.locator('#response-editor .cm-content')).toContainText('We added an experiment.')
  const englishLeft=await page.locator('#response-editor .cm-line').first().evaluate(el=>el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
  await expect(page.locator('.response-panel .editor-footer')).toBeVisible()
  await page.locator('[data-answer-language=ko]').click()
  const ko=page.locator('[data-ko-text]');await expect(ko).toHaveText('실험을 추가했습니다.',{timeout:15000})
  const toggle=page.locator('[data-response-view=toggle]');await expect(toggle).toBeVisible();await expect(toggle).toHaveText('OpenReview');await expect(toggle.locator('svg')).toHaveCount(0)
  await expect(ko.locator('.rebuttal-span[data-mapping-id="m1"]')).toContainText('실험을 추가했습니다.')
  await expect(ko.locator('.rebuttal-span[data-mapping-id="m2"]')).toContainText('실험을 추가했습니다.')
  await expect(page.locator('#mapping-edges g[data-mapping-id="m1"]')).toHaveCount(1)
  await page.locator('#review-content mark[data-id=c1]').click();await expect(page.locator('.mapping-quote[data-id=m2]')).toContainText('실험을 추가했습니다.');await page.locator('.mapping-quote[data-id=m2]').click();await expect(ko.locator('.rebuttal-span[data-mapping-id="m2"]')).toBeFocused();await expect(page.locator('[data-answer-language=ko]')).toHaveAttribute('aria-pressed','true')
  round.reviews[0].translations.review='명확히 설명해 주세요.';round.reviews[0].translation_alignments={review:{source:'Please clarify.',segments:[{source:'Please clarify.',text:'명확히 설명해 주세요.'}]}};state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh());await page.locator('[data-review-language=ko]').click()
  await expect(page.locator('#review-content mark[data-id=c1]')).toContainText('명확히 설명해 주세요.');await expect(ko.locator('.rebuttal-span[data-mapping-id="m1"]')).toBeVisible()
  // Several source passages can share one Korean paragraph; their tints must not stack.
  const assertConnectionTint=async host=>{
    await page.evaluate(()=>document.activeElement?.blur());await page.mouse.move(0,0)
    await expect(page.locator('#mapping-workspace')).not.toHaveClass(/connection-focus-active/)
    for(const scheme of ['light','dark']){
      await page.evaluate(value=>document.documentElement.dataset.colorScheme=value,scheme)
      const source=page.locator('#review-content mark[data-id=c1]')
      const expected=await source.evaluate(node=>getComputedStyle(node).backgroundColor)
      const marks=host.locator('.rebuttal-span');await expect(marks).toHaveCount(2)
      for(const mark of await marks.all()){
        expect(await mark.evaluate(node=>getComputedStyle(node).backgroundColor)).toBe(expected)
        expect(await mark.evaluate(node=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle=getComputedStyle(node).backgroundColor;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]})).toBe(255)
      }
      await source.hover();await expect(source).toHaveClass(/is-focused-connection/)
      for(const mark of await marks.all())await expect(mark).toHaveClass(/is-focused-connection/)
      await page.mouse.move(0,0)
    }
    await page.evaluate(()=>document.documentElement.dataset.colorScheme='light')
  }
  await assertConnectionTint(ko)
  await toggle.click();await assertConnectionTint(page.locator('#response-preview'));await toggle.click()
  await page.locator('[data-review-language=original]').click()
  await toggle.click();await expect(page.locator('#response-preview .rebuttal-span[data-mapping-id="m1"]')).toContainText('실험을 추가했습니다.');await expect(page.locator('#response-preview .rebuttal-span[data-mapping-id="m2"]')).toContainText('실험을 추가했습니다.');await toggle.click()
  await page.evaluate(()=>{const session=window.PaperRebuttalSession,text=session.mapFor('rebuttalResponses').get('ko:da');text.insert(text.length,' 수식 $x^2$');const map=session.mapFor('rebuttalKoreanMeta'),meta=map.get('da');map.set('da',{...meta,translation:text.toString()})})
  await toggle.click();await expect(page.locator('#response-preview')).toContainText('실험을 추가했습니다.');await expect(page.locator('#response-preview mjx-container svg')).toHaveCount(1);await expect(ko).toBeHidden()
  if(process.env.PAPER_KO_SCREENSHOT)await page.screenshot({path:process.env.PAPER_KO_SCREENSHOT})
  const koPosition=await toggle.boundingBox();await page.locator('[data-answer-language=en]').click();await expect(toggle).toHaveAttribute('aria-pressed','true');await expect(page.locator('#response-preview')).toContainText('We added an experiment.')
  const enPosition=await toggle.boundingBox();expect(Math.abs(koPosition.x-enPosition.x)).toBeLessThanOrEqual(1)
  await page.locator('[data-answer-language=ko]').click();await expect(page.locator('#response-preview mjx-container svg')).toHaveCount(1);await toggle.click();await expect(ko).toBeVisible()
  await page.evaluate(()=>{const session=window.PaperRebuttalSession,text=session.mapFor('rebuttalResponses').get('ko:da');text.delete(text.length-' 수식 $x^2$'.length,' 수식 $x^2$'.length);const map=session.mapFor('rebuttalKoreanMeta'),meta=map.get('da');map.set('da',{...meta,translation:text.toString()})})
  await expect(page.locator('.response-panel .editor-footer')).toBeHidden()
  const koreanLeft=await ko.evaluate(el=>el.getBoundingClientRect().left)
  expect(Math.abs(koreanLeft-englishLeft)).toBeLessThanOrEqual(1)
  await page.setViewportSize({width:390,height:844});await expect(toggle).toBeVisible();const mobileToggle=await toggle.boundingBox();expect(mobileToggle.x+mobileToggle.width).toBeLessThanOrEqual(391);await expect(page.locator('.response-panel .editor-footer')).toBeHidden();const mobileKoreanLeft=await ko.evaluate(el=>el.getBoundingClientRect().left);await page.locator('[data-answer-language=en]').click();const mobileEnglishLeft=await page.locator('#response-editor .cm-line').first().evaluate(el=>el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));expect(Math.abs(mobileKoreanLeft-mobileEnglishLeft)).toBeLessThanOrEqual(1);await expect(page.locator('.response-panel .editor-footer')).toBeVisible();await page.setViewportSize({width:1280,height:720});await page.locator('[data-answer-language=ko]').click()
  await expect(page.locator('[data-ko-links]')).toHaveCount(0)
  await expect(page.locator('#response-korean textarea')).toHaveCount(0)
  await page.locator('[data-answer-language=en]').click();await expect(page.locator('#response-editor .cm-content')).toContainText('We added an experiment.');await expect(page.locator('.response-panel .editor-footer')).toBeVisible()
  await page.locator('[data-action=open-review][data-id=b]').click();await page.locator('[data-action=open-review][data-id=a]').click()
  await page.locator('[data-answer-language=ko]').click();await expect(ko).toHaveText('실험을 추가했습니다.')
  await page.reload();await page.locator('[data-answer-language=ko]').click();await expect(ko).toHaveText('실험을 추가했습니다.')
  await page.locator('[data-answer-language=en]').click();const english=page.locator('#response-editor .cm-content');await english.click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' More evidence.')
  await page.locator('[data-answer-language=ko]').click();await expect(ko).toHaveText('실험과 추가 근거를 제시했습니다.',{timeout:15000});expect(translations).toBe(2)
  await page.locator('[data-answer-language=en]').click();await page.locator('[data-answer-language=ko]').click();await expect(ko).toHaveText('실험과 추가 근거를 제시했습니다.');expect(translations).toBe(2)
  await page.reload();await page.locator('[data-answer-language=ko]').click();await expect(ko).toHaveText('실험과 추가 근거를 제시했습니다.');expect(translations).toBe(2)
  if(!await page.locator('#screen-nav .sidebar-advanced').evaluate(node=>node.open))await page.locator('#screen-nav .sidebar-advanced > summary').click()
  await page.locator('[data-screen=submission]').click();await page.locator('[data-target=db]').uncheck();await page.locator('[name=export-language]').selectOption('ko',{force:true});const download=page.waitForEvent('download');await page.locator('[data-action=export]').click();await download;expect(exported.texts.da).toBe('실험과 추가 근거를 제시했습니다.')
  await page.locator('[data-action=open-review][data-id=a]').click();await page.locator('[data-answer-language=en]').click()
  await page.evaluate(()=>{const text=window.PaperRebuttalSession.mapFor('rebuttalResponses').get('ko:da');text.insert(text.length,' 직접 수정')})
  await page.locator('#response-editor .cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' Another change.')
  await page.locator('[data-answer-language=ko]').click()
  await expect(ko).toHaveText('실험과 추가 근거를 제시했습니다.',{timeout:15000})
  await expect(page.locator('#form-dialog')).not.toBeVisible()
  const completedRequests=translations
  await page.locator('[data-answer-language=en]').click();await page.locator('[data-answer-language=ko]').click()
  await page.waitForTimeout(1800)
  await expect(ko).toHaveText('실험과 추가 근거를 제시했습니다.');expect(translations).toBe(completedRequests)
})
