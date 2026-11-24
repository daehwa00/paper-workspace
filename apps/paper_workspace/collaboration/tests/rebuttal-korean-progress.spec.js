import { test, expect } from './fixtures.js'

const englishA = 'We added an experiment.\n\nWe report the results.'
const englishB = 'We added a baseline.'

function translation(documentId, source, text) {
  return {review_id:documentId,field:'response',text,segments:[{source,text}],uncertain:[]}
}

async function translationFixture(context, onSubmit) {
  for (const [variable, asset, contentType] of [
    ['PAPER_REBUTTAL_JS','rebuttal.js','application/javascript'],
    ['PAPER_REBUTTAL_CSS','rebuttal.css','text/css'],
    ['PAPER_REBUTTAL_MODEL','rebuttal-model.js','application/javascript']
  ]) if(process.env[variable]) await context.route(`**/${asset}*`,route=>route.fulfill({path:process.env[variable],contentType}))
  const round={id:'r1',title:'Review',reviewers:[{id:'a',name:'Reviewer A'},{id:'b',name:'Reviewer B'}],reviews:[{id:'ra',reviewer_id:'a',fields:{review:'Please clarify.'},translations:{}},{id:'rb',reviewer_id:'b',fields:{review:'Please compare.'},translations:{}}],documents:[{id:'da',text_key:'da',kind:'reviewer',reviewer_id:'a',title:'Response A',seed_text:englishA},{id:'db',text_key:'db',kind:'reviewer',reviewer_id:'b',title:'Response B',seed_text:englishB}],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}
  const state={schema_version:1,revision:1,enabled:true,jobs:[],rounds:[round]}
  const requests=[],polls=new Map(),pollFailures=[]
  await context.route('**/api/rebuttal/projects/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname
    if(path.endsWith('/versions'))return route.fulfill({json:{versions:[]}})
    if(request.method()==='POST' && path.endsWith('/analyses')){
      const body=request.postDataJSON()
      expect(body.task).toBe('translate_response')
      expect(body.scope.document_ids).toHaveLength(1)
      const documentId=body.scope.document_ids[0]
      const job={id:`job${requests.length+1}`,round_id:'r1',document_id:documentId,task:'translate_response',status:'running',source:body.texts[documentId]}
      requests.push({body,job});state.jobs.push(job);state.revision++
      if(onSubmit)onSubmit(job,requests.length)
      return route.fulfill({json:{...state,result:{job}}})
    }
    if(request.method()==='GET' && /\/analyses\/[^/]+$/.test(path)){
      const id=path.split('/').at(-1)
      polls.set(id,(polls.get(id) || 0)+1)
      const failure=pollFailures.shift()
      if(failure==='abort')return route.abort('failed')
      if(failure)return route.fulfill({status:failure,json:{error:'Translation status is unavailable'}})
      return route.fulfill({json:{job:state.jobs.find(job=>job.id===id)}})
    }
    return route.fulfill({json:state})
  })
  return {
    requests,polls,
    failPolls(...failures) {pollFailures.push(...failures)},
    setGlossary(glossary) {round.glossary=structuredClone(glossary);state.revision++},
    progress(index,text,completed=1,total=2) {
      const job=requests[index].job
      job.translation_progress={translations:[translation(job.document_id,job.source,text)],completed,total}
    },
    complete(index,text) {
      const job=requests[index].job
      job.status='completed';job.result={translations:[translation(job.document_id,job.source,text)]};state.revision++
    },
    fail(index) {requests[index].job.status='failed';requests[index].job.error='Translation service unavailable';state.revision++}
  }
}

async function openResponse(page, name) {
  await page.goto(`/p/${name}-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await expect(page.locator('#response-editor .cm-content')).toContainText('We added an experiment.')
}

async function korean(page) {
  await page.locator('[data-answer-language=ko]').click()
  return page.locator('[data-ko-text]')
}

test('partial translation stays visible without replacing unchanged DOM or moving scroll', async ({page,context})=>{
  const fixture=await translationFixture(context)
  await openResponse(page,'ko-progress')
  const ko=await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(1)
  const partial=Array.from({length:60},(_,index)=>`실험 결과 ${index+1}을 설명합니다.`).join('\n\n')
  fixture.progress(0,partial)
  await expect(ko).toHaveText(partial)
  await expect(page.locator('[data-ko-status]')).toContainText(/Translating|번역 중/)
  await page.evaluate(()=>{
    const host=document.querySelector('#response-korean'),text=host.querySelector('[data-ko-text]')
    host.scrollTop=160
    window.koreanProgressSnapshot={host,text,child:text.firstChild,scrollTop:host.scrollTop}
  })
  const pollCount=fixture.polls.get('job1') || 0
  await expect.poll(()=>fixture.polls.get('job1') || 0).toBeGreaterThanOrEqual(pollCount+2)
  expect(await page.evaluate(()=>{
    const saved=window.koreanProgressSnapshot,host=document.querySelector('#response-korean'),text=host.querySelector('[data-ko-text]')
    return {host:saved.host===host,text:saved.text===text,child:saved.child===text.firstChild,scrollTop:host.scrollTop,expectedScroll:saved.scrollTop}
  })).toEqual({host:true,text:true,child:true,scrollTop:160,expectedScroll:160})
  fixture.complete(0,`${partial}\n\n추가 문단을 번역했습니다.`)
  await expect(ko).toHaveText(`${partial}\n\n추가 문단을 번역했습니다.`)
  await page.locator('[data-answer-language=en]').click()
  expect(await page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').get('da').toString())).toBe(englishA)
  expect(fixture.requests).toHaveLength(1)
})

test('English edits during translation automatically queue the latest source and preserve the original', async ({page,context})=>{
  const fixture=await translationFixture(context)
  await openResponse(page,'ko-followup')
  const ko=await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(1)
  fixture.progress(0,'실험을 추가했습니다.')
  await expect(ko).toHaveText('실험을 추가했습니다.')
  const latest=`${englishA}\n\nMore evidence.`
  await page.evaluate(value=>{
    const text=window.PaperRebuttalSession.mapFor('rebuttalResponses').get('da')
    text.insert(text.length,value)
  },'\n\nMore evidence.')
  fixture.complete(0,'이전 원문의 완료 번역입니다.')
  await expect.poll(()=>fixture.requests.length).toBe(2)
  expect(fixture.requests[1].body.texts.da).toBe(latest)
  expect(await page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').get('da').toString())).toBe(latest)
  await expect(ko).not.toContainText('이전 원문의 완료 번역입니다.')
  fixture.complete(1,'실험과 추가 근거를 제시했습니다.')
  await expect(ko).toHaveText('실험과 추가 근거를 제시했습니다.')
  expect(await page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').get('da').toString())).toBe(latest)
  await expect(page.locator('#dialog-title')).toBeHidden()
  expect(fixture.requests).toHaveLength(2)
})

test('failed translation does not automatically repeat and can be retried explicitly', async ({page,context})=>{
  const fixture=await translationFixture(context)
  await openResponse(page,'ko-failure')
  const ko=await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(1)
  fixture.fail(0)
  const retry=page.locator('[data-action=translate-response-ko]')
  await expect(retry).toBeVisible()
  await page.locator('[data-answer-language=en]').click();await korean(page)
  await page.locator('[data-answer-language=en]').click();await korean(page)
  await page.waitForTimeout(1800)
  expect(fixture.requests).toHaveLength(1)
  await retry.click()
  await expect.poll(()=>fixture.requests.length).toBe(2)
  fixture.complete(1,'다시 번역한 실험 결과입니다.')
  await expect(ko).toHaveText('다시 번역한 실험 결과입니다.')
})

test('a transient translation status network error resumes polling the same job', async ({page,context})=>{
  const fixture=await translationFixture(context)
  fixture.failPolls('abort')
  await openResponse(page,'ko-transient')
  const ko=await korean(page)
  await expect.poll(()=>fixture.polls.get('job1') || 0).toBe(1)
  fixture.complete(0,'일시적인 연결 오류 후 번역을 완료했습니다.')
  await expect(ko).toHaveText('일시적인 연결 오류 후 번역을 완료했습니다.')
  expect(fixture.polls.get('job1')).toBe(2)
  expect(fixture.requests).toHaveLength(1)
})

test('unavailable translation status stops after three consecutive failures without resubmitting', async ({page,context})=>{
  const fixture=await translationFixture(context)
  fixture.failPolls(503,503,503,503)
  await openResponse(page,'ko-unavailable')
  await korean(page)
  await expect.poll(()=>fixture.polls.get('job1') || 0).toBe(3)
  await expect(page.locator('[data-action=translate-response-ko]')).toBeVisible()
  await page.locator('[data-answer-language=en]').click();await korean(page)
  await page.waitForTimeout(1800)
  expect(fixture.polls.get('job1')).toBe(3)
  expect(fixture.requests).toHaveLength(1)
})

test('existing manual Korean is replaced without confirmation after the latest glossary result', async ({page,context})=>{
  const fixture=await translationFixture(context)
  await openResponse(page,'ko-auto-replace')
  const manual='직접 작성한 한국어 답변입니다.'
  await page.evaluate(async value=>{
    await window.PaperRebuttalSession.ensureNamespacedTexts('rebuttalResponses',[{key:'ko:da',initial:value}])
  },manual)
  const ko=await korean(page)
  await expect(ko).toHaveText(manual)
  await page.locator('[data-action=translate-response-ko]').click()
  await expect.poll(()=>fixture.requests.length).toBe(1)
  const glossary={experiment:'최신 실증 실험'}
  fixture.setGlossary(glossary)
  await page.evaluate(()=>window.PaperRebuttal.refresh())
  fixture.complete(0,'이전 용어집으로 생성한 번역입니다.')
  await expect.poll(()=>fixture.requests.length).toBe(2)
  await expect(ko).toHaveText(manual)
  const latest='최신 실증 실험을 추가하고 결과를 보고했습니다.'
  fixture.complete(1,latest)
  await expect(ko).toHaveText(latest)
  await expect.poll(()=>page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalKoreanMeta').get('da')?.glossary)).toEqual(glossary)
  await expect(page.locator('#form-dialog')).not.toBeVisible()
  expect(fixture.requests).toHaveLength(2)
})

test('glossary changes retranslate unchanged English and persist the new glossary metadata', async ({page,context})=>{
  const fixture=await translationFixture(context)
  await openResponse(page,'ko-glossary')
  const ko=await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(1)
  fixture.complete(0,'실험을 추가하고 결과를 보고했습니다.')
  await expect(ko).toHaveText('실험을 추가하고 결과를 보고했습니다.')
  await expect.poll(()=>page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalKoreanMeta').get('da')?.glossary)).toEqual({})
  await page.locator('[data-answer-language=en]').click()
  const glossary={experiment:'실증 실험',results:'측정 결과'}
  fixture.setGlossary(glossary)
  await page.evaluate(()=>window.PaperRebuttal.refresh())
  await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(2)
  expect(fixture.requests[1].body.texts.da).toBe(englishA)
  const translated='실증 실험을 추가하고 측정 결과를 보고했습니다.'
  fixture.complete(1,translated)
  await expect(ko).toHaveText(translated)
  await expect.poll(()=>page.evaluate(()=>{
    const session=window.PaperRebuttalSession,meta=session.mapFor('rebuttalKoreanMeta').get('da')
    return {text:session.mapFor('rebuttalResponses').get('ko:da')?.toString(),source:meta?.source,translation:meta?.translation,glossary:meta?.glossary}
  })).toEqual({text:translated,source:englishA,translation:translated,glossary})
  await expect(page.locator('#dialog-title')).toBeHidden()
  expect(fixture.requests).toHaveLength(2)
})

test('translation results stay with their response when switching reviewers', async ({page,context})=>{
  const fixture=await translationFixture(context)
  await openResponse(page,'ko-documents')
  await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(1)
  await page.locator('[data-action=open-review][data-id=b]').click()
  await expect.poll(()=>fixture.requests.length).toBe(2)
  expect(fixture.requests[1].body.scope.document_ids).toEqual(['db'])
  fixture.complete(0,'리뷰어 A의 실험 답변입니다.')
  await expect.poll(()=>page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').get('ko:da')?.toString())).toBe('리뷰어 A의 실험 답변입니다.')
  await expect(page.locator('[data-ko-text]')).not.toContainText('리뷰어 A의 실험 답변입니다.')
  fixture.complete(1,'리뷰어 B의 기준선 답변입니다.')
  await expect(page.locator('[data-ko-text]')).toHaveText('리뷰어 B의 기준선 답변입니다.')
  await page.locator('[data-action=open-review][data-id=a]').click()
  await expect(page.locator('[data-ko-text]')).toHaveText('리뷰어 A의 실험 답변입니다.')
  expect(fixture.requests).toHaveLength(2)
})

test('a translation already applied in another tab does not ask to replace Korean again', async ({page,context})=>{
  const completed='다른 탭에서 완료한 번역입니다.'
  const fixture=await translationFixture(context,(job,count)=>{
    if(count===2){job.status='completed';job.result={translations:[translation(job.document_id,job.source,completed)]}}
  })
  await openResponse(page,'ko-other-tab')
  await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(1)
  const other=await context.newPage()
  await other.goto(page.url())
  await expect(other.locator('#response-editor .cm-content')).toContainText('We added an experiment.')
  await korean(other)
  await expect(other.locator('[data-ko-text]')).toHaveText(completed)
  await expect(page.locator('[data-ko-text]')).toHaveText(completed)
  fixture.complete(0,completed)
  await expect(page.locator('[data-ko-status]')).not.toContainText(/Translating|번역 중/)
  await expect(page.locator('#dialog-title')).toBeHidden()
  await expect(other.locator('#dialog-title')).toBeHidden()
  expect(fixture.requests).toHaveLength(2)
})

test('delayed block retry keeps the translated prefix and completes the same job',async({page,context})=>{
  const fixture=await translationFixture(context)
  await openResponse(page,'ko-block-recovery')
  const ko=await korean(page)
  await expect.poll(()=>fixture.requests.length).toBe(1)
  fixture.progress(0,'실험을 추가했습니다.')
  fixture.requests[0].job.translation_progress.retrying=true
  await expect(page.locator('[data-ko-status]')).toContainText('Retrying delayed block… 1/2')
  await expect(ko).toHaveText('실험을 추가했습니다.')
  fixture.complete(0,'실험을 추가했습니다.\n\n결과를 보고합니다.')
  await expect(ko).toHaveText('실험을 추가했습니다.\n\n결과를 보고합니다.')
  expect(fixture.requests).toHaveLength(1)
  await expect(page.locator('[data-ko-status]')).not.toContainText('Retrying')
})
