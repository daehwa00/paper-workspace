import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, test, namedContext } from './fixtures.js'

const fresh = () => ({schema_version:1,revision:0,enabled:true,jobs:[],rounds:[]})
const emptyRound = (id='r1') => ({id,title:'ICLR 2027 rebuttal',reviewers:[],reviews:[],imports:[],documents:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}})
const seeded = () => {
  const state=fresh(),r=emptyRound();state.rounds=[r]
  r.reviewers=[{id:'reviewer1',name:'Reviewer A'}]
  r.reviews=[{id:'review1',reviewer_id:'reviewer1',fields:{summary:'Please clarify the baseline comparison and report uncertainty.'},translations:{summary:'기준선 비교를 설명하고 불확실성을 보고하세요.'},source_id:'source1'}]
  r.documents=[{id:'doc1',title:'Response to Reviewer A',kind:'reviewer',reviewer_id:'reviewer1',text_key:'response:doc1',seed_text:'We clarify the comparison and report confidence intervals.'},{id:'doc2',title:'Common response',kind:'common',reviewer_id:null,text_key:'response:doc2',seed_text:'Thank you for the thoughtful reviews.'}]
  r.concerns=[{id:'concern1',title:'Baseline comparison',reviewer_id:'reviewer1',source_spans:[{review_id:'review1',field:'summary',quote:'baseline comparison',start:19,end:38}],requires_response:true,strategy:'clarify',work_status:'todo',comments:[]}]
  return state
}
const responseVersionStores = new WeakMap()
async function api(context,state) {
  const calls=[];let conflict=false
  let versions=responseVersionStores.get(state)
  if(!versions){versions={nextId:1,documents:new Map()};responseVersionStores.set(state,versions)}
  await context.route('**/api/rebuttal/projects/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace(/^\/api\/rebuttal\/projects\/[^/]+/,'');const body=request.postDataJSON() || {};calls.push({path,body:structuredClone(body),method:request.method()})
    const versionPath=path.match(/^\/rounds\/([^/]+)\/documents\/([^/]+)\/versions$/)
    if(versionPath){
      const [,rid,did]=versionPath.map(decodeURIComponent)
      const document=state.rounds.find(round=>round.id===rid)?.documents.find(document=>document.id===did)
      if(!document){await route.fulfill({status:404,json:{error:'response not found'}});return}
      const project=new URL(request.url()).pathname.split('/')[4],key=JSON.stringify([project,rid,did])
      const history=versions.documents.get(key) || []
      if(request.method()==='GET'){await route.fulfill({json:{versions:history.map(entry=>entry.version),paper_unavailable:false}});return}
      if(request.method()==='POST'){
        const reason=body.reason===undefined?'auto':body.reason
        if(typeof body.content!=='string' || Buffer.byteLength(body.content)>2_000_000 || !['auto','pre-restore'].includes(reason)){
          await route.fulfill({status:400,json:{error:'invalid response version'}});return
        }
        const digest=createHash('sha256').update(body.content).digest('hex')
        if(history[0]?.digest!==digest){
          history.unshift({digest,version:{id:versions.nextId++,created_at:new Date().toISOString(),content:body.content,reason,actor:'Test Author',source:'response'}})
          history.splice(50);versions.documents.set(key,history)
        }
        await route.fulfill({json:{saved:true}});return
      }
      await route.fulfill({status:404,json:{error:'not found'}});return
    }
    let extra={}
    if(request.method()==='GET'){await route.fulfill({json:state});return}
    if(conflict){const change=conflict;conflict=false;if(typeof change==='function')change(state);state.revision++;await route.fulfill({status:409,json:{error:'revision conflict',revision:state.revision}});return}
    if(body.expected_revision!==state.revision){await route.fulfill({status:409,json:{error:'revision conflict'}});return}
    const r=state.rounds.find(item=>item.id===path.split('/')[2]) || state.rounds[0]
    if(path==='/rounds'){const r=emptyRound('r'+(state.rounds.length+1));r.title=body.title;state.rounds.push(r)}
    else if(request.method()==='PUT'){for(const item of body.round.mappings || [])if(item.reconfirm){item.stale=false;item.needs_reconfirmation=false;delete item.reconfirm}body.round.text_hashes=Object.fromEntries(Object.entries(body.texts || {}).map(([id,value])=>[id,createHash('sha256').update(value).digest('hex')]));state.rounds[state.rounds.indexOf(r)]=body.round}
    else if(path.endsWith('/documents'))r.documents.push({id:'doc'+(r.documents.length+1),title:body.title,kind:body.kind,reviewer_id:body.reviewer_id,text_key:`response:doc${r.documents.length+1}`,seed_text:''})
    else if(path.endsWith('/imports')){const staged={id:'import1',reviews:[{reviewer_id:'Reviewer B',fields:{review:body.text || 'Extracted review from source.'}}],pages:body.kind==='pdf'?[{page:1,text:'Extracted review from source.'}]:[]};r.imports.push(staged);extra={import:staged}}
    else if(path.endsWith('/reparse')){extra={import:r.imports.find(item=>item.id===path.split('/').at(-2))}}
    else if(path.endsWith('/commit')){const source=r.imports.find(item=>item.id===path.split('/').at(-2));if(source)source.status='committed';for(const [index,review] of body.reviews.entries()){const id='reviewer'+(r.reviewers.length+1);r.reviewers.push({id,name:review.reviewer_id});r.reviews.push({...review,id:'imported'+index,reviewer_id:id,translations:{},source_id:'import1'})}}
    else if(path.endsWith('/rules'))r.rules.push({...body.rules,id:'rule'+(r.rules.length+1)})
    else if(path.endsWith('/apply'))r.active_rules_id=path.split('/').at(-2)
    else if(path.endsWith('/analyses'))state.jobs.push({id:'job'+(state.jobs.length+1),task:body.task,status:'queued',stage:'waiting',round_id:r.id,text_hashes:Object.fromEntries(Object.entries(body.texts).map(([id,value])=>[id,createHash('sha256').update(value).digest('hex')]))})
    else if(path.endsWith('/cancel'))state.jobs.find(job=>job.id===path.split('/').at(-2)).status='cancelled'
    else if(path.endsWith('/exports'))extra={filename:'response.txt',mime:'text/plain',content:Object.values(body.texts).join('\n'),text:Object.values(body.texts).join('\n'),checks:[]}
    else if(path.endsWith('/submissions'))r.submissions.push({id:'submission1',created_at:new Date().toISOString(),target:body.target,texts:body.texts,output:{text:Object.values(body.texts).join('\n')}})
    else if(path==='/openreview/session')extra={mfa_required:true,challenge_id:'challenge1',methods:['totp']}
    else if(path==='/openreview/session/mfa')extra={connection_id:'connection1',connected:true}
    state.revision++;await route.fulfill({json:{...state,result:extra}})
  })
  return {calls,conflict(change=true){conflict=change}}
}
async function open(page,slug,screen='overview',lang='en') {
  await page.goto(`/p/${slug}/rebuttal?standalone=1&round=r1&lang=${lang}#${screen}`)
  await expect(page.locator('#screen-nav')).toBeVisible()
  await page.waitForFunction(()=>Boolean(window.PaperRebuttalSession))
  await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  if(screen==='reviews')await openReviewAdvanced(page)
}
async function openReviewAdvanced(page) {
  const advanced=page.locator('#review-advanced')
  if(!await advanced.evaluate(node=>node.open))await advanced.locator(':scope > summary').click()
  await expect(advanced).toHaveAttribute('open','')
}
async function navigateScreen(page,screen) {
  if(screen==='reviews'){await page.locator('#open-rebuttal').click();return}
  if(['overview','evidence','submission'].includes(screen)) {
    const advanced=page.locator('#screen-nav .sidebar-advanced')
    if(!await advanced.evaluate(node=>node.open))await advanced.locator(':scope > summary').click()
  }
  await page.locator(`#screen-nav [data-screen="${screen}"]`).click()
}
async function selectProperty(page,id,value) {
  // Responses now open from the reviewer rail; rounds retain their URL context.
  if(id==='document-select'){
    const document=await page.evaluate(id=>window.PaperRebuttal.getState().rounds.flatMap(round=>round.documents).find(doc=>doc.id===id),value)
    expect(document).toBeTruthy()
    await page.locator(document.kind==='reviewer'?`#reviewer-nav [data-action="open-review"][data-id="${document.reviewer_id}"]`:`#reviewer-nav [data-action="open-document"][data-id="${value}"]`).click()
    return
  }
  if(id==='round-select'){
    const url=new URL(page.url());url.searchParams.set('round',value)
    await page.goto(url.href)
    await page.waitForFunction(()=>Boolean(window.PaperRebuttalSession))
    await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
    return
  }
  const native=page.locator(`#${id}`)
  const label=await native.evaluate((el,value)=>[...el.options].find(option=>option.value===value)?.label,value)
  const trigger=native.locator('..').locator('.property-trigger')
  if(!await trigger.count())return native.selectOption(value)
  await trigger.click()
  const menu=page.locator(`#${await trigger.getAttribute('aria-controls')}`)
  await menu.locator('input[type="search"]').fill(label)
  await menu.getByRole('option',{name:label,exact:true}).click()
  await expect(native).toHaveValue(value)
}
async function edit(page,value) {
  const editor=page.locator('#response-editor .cm-content');await expect(editor).toBeVisible();await editor.click();await page.keyboard.press('Control+a');if(value)await page.keyboard.insertText(value);else await page.keyboard.press('Backspace')
}
async function responseEditorText(page) {
  return page.locator('#response-editor .cm-content').evaluate(editor=>[...editor.querySelectorAll('.cm-line')].map(line=>{
    const content=line.cloneNode(true)
    content.querySelectorAll('.cm-remoteCaret').forEach(caret=>caret.remove())
    return content.textContent
  }).join('\n'))
}
async function save(page) { await page.locator('#dialog-save').click();await expect(page.locator('#form-dialog')).not.toBeVisible() }

test('staged import, manual rules apply, mechanical counts, tasks and submission export',async({page,context})=>{
  const state=seeded(),mock=await api(context,state),slug=`rebuttal-flow-${Date.now()}`
  await open(page,slug)
  await page.locator('[data-action="import"]').click();await page.locator('[name="text"]').fill('New reviewer concern.');await page.locator('#dialog-save').click()
  await expect(page.locator('#dialog-title')).toHaveText('Review import preview')
  expect(state.rounds[0].reviews).toHaveLength(1)
  await page.locator('[name="review:0:review"]').fill('Edited extraction.');await save(page)
  expect(state.rounds[0].reviews[1].fields.review).toBe('Edited extraction.')
  await page.locator('[data-action="rules"]').click();await page.locator('[name="venue"]').fill('ICLR');await page.locator('[data-action="add-limit"]').click();await page.locator('[name="limit:0:max"]').fill('90');await save(page)
  expect(state.rounds[0].active_rules_id).toBeNull()
  await page.locator('details.rule-draft summary').click();await page.locator('[data-action="apply-rules"]').click()
  await expect(page.locator('#mechanical-checks')).toContainText('/ 90')
  await navigateScreen(page,'reviews');await edit(page,'A'.repeat(91))
  await navigateScreen(page,'submission');await expect(page.locator('#mechanical-checks')).toContainText('91 / 90');await expect(page.locator('#freeze-submission')).toBeDisabled()
  await navigateScreen(page,'reviews');await edit(page,'We added confidence intervals.')
  await navigateScreen(page,'evidence');await page.locator('[data-action="new-work"]').click();await page.locator('[name="title"]').fill('Run baseline experiment');await page.locator('[name="assignee"]').fill('J. Kim');await save(page)
  await expect(page.locator('.item-row')).toContainText('Run baseline experiment')
  await page.locator('[data-action="comment-work"]').click();await page.locator('[name="text"]').fill('Completed on held-out data.');await save(page)
  await expect(page.locator('.item-row')).toContainText('Completed on held-out data.')
  await navigateScreen(page,'submission');await page.locator('#freeze-submission').click();await save(page)
  await expect(page.locator('[data-action="view-submission"]')).toBeVisible()
  const download=page.waitForEvent('download');await page.locator('[data-action="export"]').click();expect((await download).suggestedFilename()).toBe('response.txt')
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(0)
})

test('response source and OpenReview preview preserve the draft',async({page,context})=>{
  const state=seeded();await api(context,state);await open(page,`rebuttal-preview-${Date.now()}`,'reviews')
  const source = '# Result\n\n**Improved** by $\\\\alpha$ and $$x^2$$.\n\n- First\n- Second\n\n<script>alert(1)</script>'
  await edit(page,source)
  await expect(page.locator('#response-count')).toHaveText(`${source.length} characters`)
  const countBox=await page.locator('#response-count').boundingBox(),footerBox=await page.locator('.editor-footer').boundingBox()
  expect(footerBox.x+footerBox.width-countBox.x-countBox.width).toBeLessThanOrEqual(20)
  await page.locator('[data-response-view="toggle"]').click()
  const preview=page.locator('#response-preview')
  await expect(preview.locator('h1')).toHaveText('Result')
  await expect(preview.locator('strong')).toHaveText('Improved')
  await expect(preview.locator('li')).toHaveCount(2)
  await expect(preview.locator('mjx-container svg')).toHaveCount(2)
  await expect(preview.locator('mjx-container svg path').first()).toBeAttached()
  await expect(preview.locator('script')).toHaveCount(0)
  await expect(page.locator('#response-editor')).toBeHidden()
  await page.locator('[data-response-view="toggle"]').click()
  await expect(page.locator('#response-editor .cm-content')).toContainText('**Improved**')
  await expect(page.locator('#response-editor .cm-content')).toContainText('\\\\alpha')
})

test('failed analysis shows a safe error category and failure stage',async({page,context})=>{
  const state=seeded()
  state.jobs.push({id:'failed-job',round_id:'r1',task:'analyze',status:'failed',stage:'failed',failed_stage:'translation_and_concerns_verify_quotes',error_code:'bridge_invalid_request',error:'Analysis request format is invalid.'})
  await api(context,state);await open(page,`job-diagnostics-${Date.now()}`,'overview')
  const job=page.locator('.job-row')
  await expect(job).toContainText('translation_and_concerns_verify_quotes')
  await expect(job).toContainText('bridge_invalid_request')
  await expect(job).toContainText('Analysis request format is invalid.')
})

test('connection check targets the selected reviewer and active response',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.reviewers.push({id:'reviewer2',name:'Reviewer B'})
  r.reviews.push({id:'review2',reviewer_id:'reviewer2',fields:{review:'Other reviewer concerns'},translations:{}})
  r.documents.push({id:'doc3',title:'Response to B',kind:'reviewer',reviewer_id:'reviewer2',text_key:'response:doc3',seed_text:'Other answer'})
  const mock=await api(context,state);await open(page,`reviewer-scope-${Date.now()}`,'reviews')
  await page.locator('#reviewer-nav [data-action="open-review"][data-id="reviewer2"]').click()
  await page.locator('[data-action="check-response"]').click()
  await expect.poll(()=>state.jobs.length).toBe(1)
  const call=mock.calls.find(call=>call.path.endsWith('/analyses'))
  expect(call.body.scope.review_ids).toEqual(['review2'])
  expect(call.body.task).toBe('connect')
  expect(call.body.scope.document_ids).toEqual(['doc3'])
})

for(const entry of ['advanced','translation-prompt']) test(`review translation targets only the selected reviewer via ${entry}`,async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.reviewers.push({id:'reviewer2',name:'Reviewer B'})
  r.reviews.push({id:'review2',reviewer_id:'reviewer2',fields:{review:'Other reviewer concerns'},translations:{}})
  r.documents.push({id:'doc3',title:'Response to B',kind:'reviewer',reviewer_id:'reviewer2',text_key:'response:doc3',seed_text:'Other answer'})
  const mock=await api(context,state);await open(page,`reviewer-translation-scope-${entry}-${Date.now()}`,'reviews')
  await page.locator('#reviewer-nav [data-action="open-review"][data-id="reviewer2"]').click()
  if(entry==='advanced'){await openReviewAdvanced(page);await page.locator('[data-action="analysis"][data-id="translate"]').click()}
  else{await page.locator('[data-review-language="ko"]').click();await page.locator('[data-action="translate-reviews"]').click()}
  await expect.poll(()=>mock.calls.filter(call=>call.path.endsWith('/analyses')).length).toBe(1)
  const call=mock.calls.find(call=>call.path.endsWith('/analyses'))
  expect(call.body.task).toBe('translate')
  expect(call.body.scope).toEqual({review_ids:['review2'],document_ids:[]})
})

test('review workspace omits the redundant heading and import button',async({page,context})=>{
  await api(context,seeded());await open(page,`review-heading-${Date.now()}`,'reviews')
  await expect(page.locator('.workspace-heading')).toBeHidden()
  await expect(page.locator('.review-context-bar [data-action="import"]')).toHaveCount(0)
  await expect(page.locator('.review-context-bar [data-action="check-response"]')).toBeVisible()
  for (const width of [1440, 390]) {
    await page.setViewportSize({width,height:900})
    const toggle=await page.locator('.review-context-bar .connection-option').boundingBox()
    const button=await page.locator('.review-context-bar [data-action="check-response"]').boundingBox()
    if(width===1440){expect(Math.abs((toggle.y+toggle.height/2)-(button.y+button.height/2))).toBeLessThan(2);expect(toggle.x+toggle.width).toBeLessThanOrEqual(button.x)}
    expect(button.x).toBeGreaterThanOrEqual(0);expect(button.x+button.width).toBeLessThanOrEqual(width)
  }
})

test('advanced tools stay in the response header and nonempty findings stay in the response pane',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.findings=[{id:'finding1',document_id:'doc1',type:'style',quote:'We clarify',reason:'Use direct language',suggestion:'We explain',status:'proposed',origin:'ai'}]
  await api(context,state);await open(page,`compact-tools-${Date.now()}`,'reviews')
  const menu=page.locator('.response-panel #review-advanced')
  await expect(menu).toHaveAttribute('open','')
  await expect(menu.locator('[data-action="new-concern"]')).toBeVisible()
  await expect(menu.locator('[data-action="analysis"][data-id="style"]')).toBeVisible()
  await page.keyboard.press('Escape');await expect(menu).not.toHaveAttribute('open','')
  await expect(menu.locator('summary')).toBeFocused()
  const findings=page.locator('.response-panel #response-findings')
  await expect(findings.locator('summary')).toContainText('1')
  await expect(findings.locator('.finding')).not.toBeVisible()
  await findings.locator('summary').click();await expect(findings.locator('.finding')).toContainText('Use direct language')
  await findings.locator('[data-action="apply-finding"]').click();await expect(page.locator('#form-dialog')).toBeVisible();await page.locator('#dialog-cancel').click()
  await expect(page.locator('main > .review-advanced, main > .check-findings')).toHaveCount(0)
  await page.locator('[data-action="check-response"]').click()
  await expect.poll(()=>state.jobs.length).toBe(1)
  await expect(findings).toHaveAttribute('open','')
})

test('empty findings do not add a panel and advanced menu closes outside',async({page,context})=>{
  await api(context,seeded());await open(page,`compact-empty-${Date.now()}`,'reviews')
  await expect(page.locator('#response-findings')).toHaveCount(0)
  await expect(page.locator('#review-advanced')).toHaveAttribute('open','')
  await page.locator('.source-panel .panel-header').click()
  await expect(page.locator('#review-advanced')).not.toHaveAttribute('open','')
  await openReviewAdvanced(page)
  await expect(page.locator('#review-advanced a[href="#overview"]')).toHaveText('Settings & activity')
})

test('select all displays the selection on the final active line',async({page,context})=>{
  await api(context,seeded());await open(page,`rebuttal-select-all-${Date.now()}`,'reviews')
  await edit(page,'First paragraph\n\nFinal paragraph')
  const editor=page.locator('#response-editor .cm-content')
  await editor.click();await page.keyboard.press('Control+End');await page.keyboard.press('Control+a')
  await expect(page.locator('#response-editor .cm-selectionBackground').last()).toBeVisible()
  const active=page.locator('#response-editor .cm-activeLine')
  await expect(active).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await expect.poll(()=>page.evaluate(()=>getSelection().toString())).toBe('First paragraph\n\nFinal paragraph')
})

test('response preview follows OpenReview Markdown and math processing',async({page,context})=>{
  await api(context,seeded());await open(page,`rebuttal-preview-format-${Date.now()}`,'reviews')
  await edit(page,'| A | B |\n| --- | --- |\n| one | two |\n\n- [x] Done\n\n`$x$` and $\\\\ce{H2O}$\n\n<img src=x onerror=alert(1)>')
  await page.locator('[data-response-view="toggle"]').click()
  const preview=page.locator('#response-preview')
  await expect(preview.locator('table td')).toHaveCount(2)
  await expect(preview.locator('li')).toContainText('[x] Done')
  await expect(preview.locator('code')).toHaveText('$x$')
  await expect(preview.locator('mjx-container')).toHaveCount(1)
  await expect(preview.locator('mjx-assistive-mml math')).toContainText('H')
  await expect(preview.locator('img')).toHaveCount(0)
  await expect(preview).toContainText('<img src=x onerror=alert(1)>')
})

test('stored manual many-passage mappings remain selectable and AI checks stay explicit',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.concerns[0].source_spans.push({review_id:'review1',field:'summary',quote:'Please',start:0,end:6})
  const start=value.indexOf('confidence intervals')
  r.mappings=[{id:'manual-map',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:'We clarify'},{document_id:'doc1',start,end:start+20,quote:'confidence intervals'}],coverage:'addressed',reason:'Both explanation and uncertainty are addressed.',origin:'manual',decision:'confirmed',stale:false}]
  const mock=await api(context,state);await open(page,`rebuttal-map-${Date.now()}`,'reviews')
  await page.locator('#show-all-connections').uncheck()
  await expect(page.locator('#response-editor .cm-content')).toContainText('We clarify')
  await expect(page.locator('#response-editor .cm-lineNumbers')).toHaveCount(0)
  const source=page.locator('.review-text mark[data-id="concern1"]').first()
  await source.click()
  await expect(page.locator('.selected-concern-result')).toContainText('Both explanation and uncertainty are addressed.')
  await expect(page.locator('.rebuttal-span')).toHaveCount(2)
  expect(r.concerns[0].source_spans).toHaveLength(2)
  expect(r.mappings[0].origin).toBe('manual')
  await source.click();await page.mouse.move(0,0);await page.locator('#show-all-connections').focus();await expect(page.locator('.rebuttal-span')).toHaveCount(0)
  await page.locator('#show-all-connections').check();await expect(page.locator('.rebuttal-span')).toHaveCount(2)
  await page.locator('#show-all-connections').uncheck();await expect(page.locator('.rebuttal-span')).toHaveCount(0)
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(0)
  await page.locator('[data-action="check-response"]').click()
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(1)
  state.jobs[0].status='completed';state.revision++;await page.evaluate(()=>window.PaperRebuttal.refresh())
  await edit(page,'Edited after mapping.')
  await expect.poll(()=>state.rounds[0].mappings[0].stale).toBe(true)
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(1)
})

test('conflict preserves form and OpenReview MFA is an explicit staged flow',async({page,context})=>{
  const state=seeded(),mock=await api(context,state);await open(page,`rebuttal-conflict-${Date.now()}`)
  await page.locator('[data-action="new-document"]').click();await page.locator('[name="title"]').fill('My preserved response');mock.conflict();await page.locator('#dialog-save').click()
  await expect(page.locator('#dialog-error')).toContainText('Another collaborator');await expect(page.locator('[name="title"]')).toHaveValue('My preserved response')
  await save(page);expect(state.rounds[0].documents.at(-1).title).toBe('My preserved response')
  await navigateScreen(page,'overview');await page.locator('[data-action="openreview-session"]').click();await page.locator('[name="username"]').fill('synthetic@example.test');await page.locator('[name="password"]').fill('fake-password');await page.locator('#dialog-save').click()
  await expect(page.locator('#dialog-title')).toHaveText('OpenReview verification');await page.locator('[name="code"]').fill('123456');await save(page)
  await expect(page.locator('#notice')).toContainText('OpenReview connected')
  expect(mock.calls.find(call=>call.path==='/openreview/session').body.password).toBe('fake-password')
})

for (const kind of ['evidence','work']) test(`${kind} form merges a title edit with a collaborator's description and comment`,async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`form-merge-${kind}-${Date.now()}`
  const key=kind==='evidence'?'evidence':'work_items'
  state.rounds[0][key]=[{id:'item1',title:'Original title',description:'Original description',status:'todo',assignee:'',concern_id:null,url:'',comments:[]}]
  try {
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage()
    await open(a,slug,'evidence');await open(b,slug,'evidence')
    await a.locator(`[data-action="edit-${kind}"]`).click();await a.locator('[name="title"]').fill('Title from A')
    await b.locator(`[data-action="edit-${kind}"]`).click();await b.locator('[name="description"]').fill('Description from B');await save(b)
    await b.locator(`[data-action="comment-${kind}"]`).click();await b.locator('[name="text"]').fill('Comment from B');await save(b)
    await a.evaluate(()=>window.PaperRebuttal.refresh(false))
    await expect(a.locator('[name="description"]')).toHaveValue('Original description')
    await save(a)
    expect(state.rounds[0][key][0]).toMatchObject({title:'Title from A',description:'Description from B',comments:[{text:'Comment from B'}]})
  } finally {await first.close();await second.close()}
})

test('a conflicting field preserves input and blocks repeated saves after a 409 refresh',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.evidence=[{id:'item1',title:'Original title',description:'Original description',status:'todo',comments:[]}]
  const mock=await api(context,state)
  await open(page,`form-conflicting-field-${Date.now()}`,'evidence')
  await page.locator('[data-action="edit-evidence"]').click();await page.locator('[name="title"]').fill('Title from A')
  mock.conflict(next=>{next.rounds[0].evidence[0].title='Title from B';next.rounds[0].evidence[0].comments.push({id:'b-comment',text:'Keep B comment'})})
  await page.locator('#dialog-save').click();await expect(page.locator('#dialog-error')).toContainText('A field you edited')
  const writes=()=>mock.calls.filter(call=>call.method==='PUT').length
  const rejectedWrites=writes()
  for(let attempt=0;attempt<2;attempt++) {
    await page.locator('#dialog-save').click();await expect(page.locator('#dialog-error')).toContainText('A field you edited')
    await expect(page.locator('[name="title"]')).toHaveValue('Title from A')
    expect(state.rounds[0].evidence[0]).toMatchObject({title:'Title from B',comments:[{text:'Keep B comment'}]})
    expect(writes()).toBe(rejectedWrites)
  }
})

test('a nonoverlapping form edit automatically retries after a 409 refresh',async({page,context})=>{
  const state=seeded()
  state.rounds[0].evidence=[{id:'item1',title:'Original title',description:'Original description',status:'todo',comments:[]}]
  const mock=await api(context,state)
  await open(page,`form-conflict-retry-${Date.now()}`,'evidence')
  await page.locator('[data-action="edit-evidence"]').click();await page.locator('[name="title"]').fill('Title from A')
  mock.conflict(next=>{next.rounds[0].evidence[0].description='Description from B';next.rounds[0].evidence[0].comments.push({id:'b-comment',text:'Keep B comment'})})
  await save(page)
  expect(state.rounds[0].evidence[0]).toMatchObject({title:'Title from A',description:'Description from B',comments:[{text:'Keep B comment'}]})
  expect(mock.calls.filter(call=>call.method==='PUT')).toHaveLength(2)
})

test('retries remerge the original edit after successive remote changes',async({page,context})=>{
  const state=seeded()
  state.rounds[0].evidence=[{id:'item1',title:'Original title',description:'Original description',status:'todo',comments:[]}]
  const mock=await api(context,state)
  await open(page,`form-conflict-twice-${Date.now()}`,'evidence')
  await page.locator('[data-action="edit-evidence"]').click();await page.locator('[name="title"]').fill('Title from A')
  mock.conflict(next=>{
    next.rounds[0].evidence[0].description='Description from B'
    mock.conflict(next=>next.rounds[0].evidence[0].comments.push({id:'second-update',text:'Second remote change'}))
  })
  await save(page)
  expect(state.rounds[0].evidence[0]).toMatchObject({title:'Title from A',description:'Description from B',comments:[{text:'Second remote change'}]})
  expect(mock.calls.filter(call=>call.method==='PUT')).toHaveLength(3)
})

test('a revision-only round conflict retries without duplicating an appended comment',async({page,context})=>{
  const state=seeded()
  state.rounds[0].evidence=[{id:'item1',title:'Original title',description:'Original description',status:'todo',comments:[]}]
  const mock=await api(context,state)
  await open(page,`comment-conflict-retry-${Date.now()}`,'evidence')
  await page.locator('[data-action="comment-evidence"]').click();await page.locator('[name="text"]').fill('One comment only')
  mock.conflict();await save(page)
  const writes=mock.calls.filter(call=>call.method==='PUT')
  expect(writes).toHaveLength(2)
  expect(state.rounds[0].evidence[0].comments).toHaveLength(1)
  expect(state.rounds[0].evidence[0].comments[0].text).toBe('One comment only')
  expect(writes[0].body.round.evidence[0].comments[0].id).toBe(writes[1].body.round.evidence[0].comments[0].id)
})

test('persistent revision conflicts stop after three attempts and keep the draft',async({page,context})=>{
  const state=seeded()
  state.rounds[0].evidence=[{id:'item1',title:'Original title',description:'Original description',status:'todo',comments:[]}]
  const mock=await api(context,state)
  await open(page,`form-conflict-bounded-${Date.now()}`,'evidence')
  await page.locator('[data-action="edit-evidence"]').click();await page.locator('[name="title"]').fill('Unsaved title from A')
  const concurrent=next=>{next.rounds[0].evidence[0].description+=' B';mock.conflict(concurrent)}
  mock.conflict(concurrent)
  await page.locator('#dialog-save').click()
  await expect(page.locator('#dialog-error')).toContainText('Another collaborator')
  await expect(page.locator('[name="title"]')).toHaveValue('Unsaved title from A')
  expect(mock.calls.filter(call=>call.method==='PUT')).toHaveLength(3)
  expect(state.rounds[0].evidence[0].title).toBe('Original title')
  expect(state.rounds[0].evidence[0].description).toBe('Original description B B B')
})

test('translation, glossary and concern forms preserve concurrent edits and reject overlapping fields',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.reviews[0].fields.detail='Explain uncertainty';r.reviews[0].translations.detail='기존 설명';r.glossary={baseline:'기준선',variance:'분산'}
  await api(context,state);await open(page,`other-form-merge-${Date.now()}`,'reviews')
  await page.locator('[data-action="edit-review-translations"]').click()
  await page.locator('[name="translation:0"]').fill('A 번역')
  r.reviews[0].translations.detail='B 설명';state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh(false));await save(page)
  expect(state.rounds[0].reviews[0].translations).toMatchObject({summary:'A 번역',detail:'B 설명'})
  await navigateScreen(page,'overview');await page.locator('[data-action="glossary"]').click()
  await page.locator('[name="glossary"]').fill('baseline = A 기준선\nvariance = 분산')
  state.rounds[0].glossary.variance='B 분산';state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh(false));await save(page)
  expect(state.rounds[0].glossary).toEqual({baseline:'A 기준선',variance:'B 분산'})
  // Exercise the existing concern edit action, which currently has no visible
  // entrypoint in the simplified connection drawer.
  const editConcern=()=>page.evaluate(()=>{const button=document.createElement('button');button.dataset.action='edit-concern';button.dataset.id='concern1';document.body.append(button);button.click();button.remove()})
  await navigateScreen(page,'reviews');await editConcern()
  await page.locator('[name="title"]').fill('A concern title')
  state.rounds[0].concerns[0].comments.push({id:'b-comment',text:'B concern comment'});state.rounds[0].concerns[0].assignee='B';state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh(false));await save(page)
  expect(state.rounds[0].concerns[0]).toMatchObject({title:'A concern title',assignee:'B',comments:[{text:'B concern comment'}]})
  await editConcern();await page.locator('[name="title"]').fill('Second A title')
  state.rounds[0].concerns[0].title='B concern title';state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh(false));await page.locator('#dialog-save').click()
  await expect(page.locator('#dialog-error')).toContainText('A field you edited');await expect(page.locator('[name="title"]')).toHaveValue('Second A title')
  expect(state.rounds[0].concerns[0].title).toBe('B concern title')
})

test('response initialization failure keeps editing unavailable and offers a safe retry',async({page,context})=>{
  await api(context,seeded())
  let available=false
  await context.route('**/collab-runtime/**?response-init=1',async route=>{
    if(available)await route.continue()
    else await route.fulfill({status:503,json:{error:'Initialization temporarily unavailable'}})
  })
  await open(page,`response-init-retry-${Date.now()}`,'reviews')
  await expect(page.locator('[data-action="retry-response-texts"]')).toBeVisible()
  await expect(page.locator('#response-editor .cm-content')).toHaveCount(0)
  expect(await page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').size)).toBe(0)
  available=true
  await page.locator('[data-action="retry-response-texts"]').click()
  await expect(page.locator('#response-editor .cm-content')).toContainText('We clarify the comparison')
  await edit(page,'Draft after retry')
  expect(await page.evaluate(()=>window.PaperRebuttal.getTexts().doc1)).toBe('Draft after retry')
})

test('response initialization finishes on the currently selected document',async({page,context})=>{
  await api(context,seeded())
  let release
  const gate=new Promise(resolve=>{release=resolve})
  await context.route('**/collab-runtime/**?response-init=1',async route=>{await gate;await route.continue()})
  await open(page,`response-init-selection-${Date.now()}`,'reviews')
  await expect(page.locator('#response-editor')).toContainText('Preparing response editing')
  await selectProperty(page,'document-select','doc2')
  release()
  await expect(page.locator('#response-editor .cm-content')).toHaveText('Thank you for the thoughtful reviews.')
  await expect(page.locator('#reviewer-nav [data-action="open-document"][data-id="doc2"]')).toHaveAttribute('aria-current','page')
  await edit(page,'Edited the selected common response')
  expect(await page.evaluate(()=>window.PaperRebuttal.getTexts())).toEqual({doc1:'We clarify the comparison and report confidence intervals.',doc2:'Edited the selected common response'})
})

test('two independent browser contexts synchronize response texts and retain empty responses after reload',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`rebuttal-yjs-${Date.now()}`
  try{
    await api(first,state);await api(second,state);const a=await first.newPage(),b=await second.newPage();await open(a,slug,'reviews');await open(b,slug,'reviews')
    await b.locator('[data-response-view="toggle"]').click()
    await edit(a,'Shared **response** from first browser.');await expect(b.locator('#response-preview strong')).toHaveText('response')
    await b.locator('[data-response-view="toggle"]').click();await expect(b.locator('#response-editor .cm-content')).toContainText('Shared **response** from first browser.')
    await selectProperty(b,'document-select','doc2');await edit(b,'Common response edited independently.')
    await selectProperty(a,'document-select','doc2');await expect(a.locator('#response-editor .cm-content')).toContainText('Common response edited independently.')
    await selectProperty(a,'document-select','doc1');await edit(a,'')
    await b.reload();await b.evaluate(()=>window.PaperRebuttalSession.whenReady);await expect(b.locator('#reviewer-nav [data-action="open-document"][data-id="doc2"]')).toHaveAttribute('aria-current','page');await selectProperty(b,'document-select','doc1')
    await expect.poll(()=>responseEditorText(b)).toBe('')
    expect(await b.evaluate(()=>window.PaperRebuttal.getTexts())).toEqual({doc1:'',doc2:'Common response edited independently.'})
    expect(await b.evaluate(()=>window.PaperRebuttalSession.files.has('response:doc1'))).toBe(false)
    expect(await b.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').get('response:doc1').toString())).toBe('')
  }finally{await first.close();await second.close()}
})

test('parallel first response creation retains both browser edits',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`response-init-race-${Date.now()}`
  let arrivals=0,release
  const bothRequests=new Promise(resolve=>{release=resolve})
  try{
    for(const context of [first,second]){
      await api(context,state)
      await context.route('**/collab-runtime/**?response-init=1',async route=>{
        if(++arrivals===2)release()
        await bothRequests;await route.continue()
      })
    }
    const a=await first.newPage(),b=await second.newPage()
    await Promise.all([open(a,slug,'reviews'),open(b,slug,'reviews')])
    await Promise.all([expect(a.locator('#response-editor .cm-content')).toHaveText(state.rounds[0].documents[0].seed_text),expect(b.locator('#response-editor .cm-content')).toHaveText(state.rounds[0].documents[0].seed_text)])
    await Promise.all([a.locator('#response-editor .cm-content').press('Control+End'),b.locator('#response-editor .cm-content').press('Control+End')])
    await Promise.all([a.keyboard.insertText(' Alpha concurrent edit.'),b.keyboard.insertText(' Beta concurrent edit.')])
    for(const page of [a,b]){
      await expect(page.locator('#response-editor .cm-content')).toContainText('Alpha concurrent edit.')
      await expect(page.locator('#response-editor .cm-content')).toContainText('Beta concurrent edit.')
    }
    expect(await a.evaluate(()=>window.PaperRebuttal.getTexts())).toEqual(await b.evaluate(()=>window.PaperRebuttal.getTexts()))
  }finally{release();await first.close();await second.close()}
})

test('server response conflicts remain visible with preserved file locations',async({page,context})=>{
  const state=seeded();await api(context,state);await open(page,`response-source-status-${Date.now()}`,'reviews')
  await expect(page.locator('#response-editor .cm-content')).toBeVisible()
  await page.evaluate(()=>{
    const session=window.PaperRebuttalSession
    session.mapFor('rebuttalSourceStatus').set('response:doc1',{state:'conflict',path:'rebuttal/responses/response:doc1.md',conflictPaths:['rebuttal/conflicts/saved-web.md','rebuttal/conflicts/saved-server.md']})
  })
  await expect(page.locator('#response-source-status')).toContainText('both versions have been preserved')
  await expect(page.locator('#collab-label')).toHaveText('Conflicting edits preserved')
  await page.locator('#response-source-status summary').click()
  await expect(page.locator('#response-source-status')).toContainText('saved-web.md')
  await expect(page.locator('#response-source-status')).toContainText('saved-server.md')
  await page.evaluate(()=>window.PaperRebuttal.refresh())
  await expect(page.locator('#response-source-status')).toBeVisible()
  await page.locator('#status-center-toggle').click()
  await expect(page.locator('#status-center-details')).toContainText('rebuttal/responses/response:doc1.md')
  await page.locator('#status-center-close').click()
  await page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalSourceStatus').set('response:doc1',{state:'synced',path:'rebuttal/responses/response:doc1.md',recoveryPath:'rebuttal/.sync/history/saved-before-server.md'}))
  await expect(page.locator('#response-source-status')).toBeHidden()
  await page.locator('#status-center-toggle').click()
  await expect(page.locator('#status-center-details')).toContainText('saved-before-server.md')
})

test('rebuttal presence follows the active response and editor focus',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`rebuttal-presence-${Date.now()}`
  try{
    await second.addInitScript(()=>{localStorage.setItem('collab-name','Second Author');localStorage.setItem('collab-name-user-set','1')})
    await api(first,state);await api(second,state);const a=await first.newPage(),b=await second.newPage()
    await open(a,slug,'reviews');await open(b,slug,'reviews')
    const avatar=a.locator('#response-presence-avatars .project-presence-avatar')
    await expect(avatar).toHaveCount(1)
    await expect(avatar).toHaveAttribute('title','Second Author')
    await a.locator('#response-presence-toggle').click()
    const activity=a.locator('#response-presence-list .project-presence-activity')
    await expect(activity).toHaveText('Viewing')
    await b.locator('#response-editor .cm-content').click()
    await expect(activity).toHaveText('Editing')
    await b.evaluate(()=>window.PaperRebuttalSetVisible(false))
    await expect(avatar).toHaveCount(0)
    await b.evaluate(()=>window.PaperRebuttalSetVisible(true))
    await expect(avatar).toHaveCount(1)
    await navigateScreen(b,'submission')
    await expect(avatar).toHaveCount(0)
  }finally{await first.close();await second.close()}
})

test('Korean / English, dark / light and responsive controls stay within the viewport',async({page,context})=>{
  await api(context,seeded());await open(page,`rebuttal-layout-${Date.now()}`,'reviews','ko')
  await expect(page.locator('#review-view-title')).toHaveText('리뷰와 답변')
  for(const width of [320,390,1024,1600]){
    await page.setViewportSize({width,height:900})
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  }
  await page.locator('.theme-trigger').click();await selectProperty(page,'workspace-theme','dark');await page.keyboard.press('Escape');await expect(page.locator('html')).toHaveAttribute('data-color-scheme','dark')
  await page.locator('#workspace-language').selectOption('en');await expect(page.locator('#review-view-title')).toHaveText('Reviews & responses')
  await page.locator('.theme-trigger').click();await selectProperty(page,'workspace-theme','light');await page.keyboard.press('Escape');await expect(page.locator('html')).toHaveAttribute('data-color-scheme','light')
})

test('response editor cursor follows the dark and light themes',async({page,context})=>{
  await api(context,seeded());await open(page,`rebuttal-caret-${Date.now()}`,'reviews')
  await page.locator('#response-editor .cm-content').click()
  const cursor=page.locator('#response-editor .cm-cursor').first()
  await expect(cursor).toHaveCSS('border-left-color','rgb(0, 0, 0)')
  await page.locator('.theme-trigger').click();await selectProperty(page,'workspace-theme','dark');await page.keyboard.press('Escape')
  await page.locator('#response-editor .cm-content').click()
  await expect(cursor).toHaveCSS('border-left-color','rgb(255, 255, 255)')
  await page.locator('.theme-trigger').click();await selectProperty(page,'workspace-theme','light');await page.keyboard.press('Escape')
  await page.locator('#response-editor .cm-content').click()
  await expect(cursor).toHaveCSS('border-left-color','rgb(0, 0, 0)')
})

test('official rules research stays a reviewed draft and rewrite requires explicit application',async({page,context})=>{
  const state=seeded(),mock=await api(context,state);await open(page,`rebuttal-ai-${Date.now()}`)
  await page.locator('[data-action="analysis"][data-id="research_rules"]').click();await page.locator('[name="venue"]').fill('Example Conference');await page.locator('[name="urls"]').fill('https://example.test/official');await save(page)
  const request=mock.calls.find(call=>call.path.endsWith('/analyses'));expect(request.body.research.sources[0].url).toBe('https://example.test/official')
  Object.assign(state.jobs[0],{status:'completed',result:{rules_candidates:[{venue:'Example Conference',year:2027,track:'main',stage:'rebuttal',layout:'per_reviewer',allow_common:true,limits:[],policies:{},sources:[{url:'https://example.test/official',title:'Official author instructions',excerpt:'Responses are invited.',status:'verified'}]}]}});state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh());await page.locator('[data-action="review-rule-candidates"]').click();await expect(page.locator('#dialog-body')).toContainText('Official author instructions');await page.locator('[data-action="candidate-rules"]').click();await expect(page.locator('[name="venue"]')).toHaveValue('Example Conference');await save(page)
  expect(state.rounds[0].active_rules_id).toBeNull();expect(state.rounds[0].rules[0].sources[0].status).toBe('verified')
  const before=state.rounds[0].documents[0].seed_text
  state.jobs.push({id:'rewrite1',task:'rewrite',status:'completed',round_id:'r1',selection:{document_id:'doc1',start:0,end:10,quote:before.slice(0,10)},result:{replacement:'We explain',summary:'Clarify the wording.'}});state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh());await page.locator('[data-action="review-rewrite"]').click()
  expect(await page.evaluate(()=>window.PaperRebuttal.getTexts().doc1)).toBe(before)
  await save(page);expect(await page.evaluate(()=>window.PaperRebuttal.getTexts().doc1)).toBe('We explain'+before.slice(10))
  await navigateScreen(page,'submission');await expect(page.locator('[name="export-format"] option[value="json"]')).toHaveCount(0)
  await navigateScreen(page,'overview');await page.locator('[data-action="archive-export"]').click();await expect(page.locator('#dialog-body')).toContainText('internal analysis')
})

test('editing during first analysis marks late results stale and anchors cannot cross documents',async({page,context})=>{
  const state=seeded();await api(context,state);await open(page,`rebuttal-stale-${Date.now()}`,'reviews')
  await page.locator('[data-action="analysis"][data-id="style"]').click()
  const snapshot=state.jobs[0].text_hashes
  await edit(page,'We clarify the comparison with new measurements.')
  await expect.poll(()=>state.rounds[0].text_hashes?.doc1 || snapshot.doc1).not.toBe(snapshot.doc1)
  state.jobs[0].input_hash='original-input';state.jobs[0].status='completed';state.jobs[0].result={}
  state.rounds[0].findings.push({id:'late-finding',document_id:'doc1',type:'style',quote:'We clarify',reason:'Earlier snapshot',suggestion:'We explain',status:'proposed',stale:false,input_hash:'original-input'});state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh());await expect(page.locator('.finding')).toContainText('Outdated');await expect(page.locator('[data-action="apply-finding"]')).toBeDisabled()
  const foreign=await page.evaluate(()=>{const session=window.PaperRebuttalSession,a=session.namespacedTextFor('rebuttalResponses','response:doc1'),b=session.namespacedTextFor('rebuttalResponses','response:doc2'),range=session.encodeTextRange(a,0,3);return session.resolveRange(range,b)})
  expect(foreign).toBeNull()
})

test('mechanical counters and target assembly agree with server fixtures',async({page,context})=>{
  await api(context,seeded());await open(page,`rebuttal-count-${Date.now()}`)
  const cases=[]
  for(const text of ['# Heading\nText **bold** [link](https://example.test) 😀\n> quote\n$X + Y$\n## References\nA reference',' a\t b\r\n한글 😀 '])for(const unit of ['characters','words'])for(const basis of ['raw','rendered'])for(const include of [true,false])for(const character_mode of ['codepoints','utf16'])cases.push({text,limit:{unit,basis,character_mode,count_spaces:include,count_newlines:include,include_headings:include,include_quotes:include,include_math:include,include_references:include}})
  const expected=JSON.parse(execFileSync('python3',['-c','import json,sys\nfrom apps.paper_workspace.rebuttal.exports import count_text\nprint(json.dumps([count_text(c["text"],c["limit"]) for c in json.load(sys.stdin)]))'],{cwd:resolve(import.meta.dirname,'../../../..'),input:JSON.stringify(cases),encoding:'utf8'}))
  const actual=await page.evaluate(async cases=>{const model=await import('/rebuttal-model.js');return cases.map(c=>model.countText(c.text,c.limit))},cases)
  expect(actual).toEqual(expected)
  const fixtures=[]
  for(const scope of ['document','total','target'])for(const common_mode of ['include','append','prepend','exclude'])fixtures.push({scope,common_mode})
  const checks=await page.evaluate(async fixtures=>{const {checkLimits}=await import('/rebuttal-model.js');const round=window.PaperRebuttal.getState().rounds[0],texts=window.PaperRebuttal.getTexts();return fixtures.map(f=>{const r={...round,rules:[{id:'rules',limits:[{scope:f.scope,document_id:'doc1',unit:'characters',max:1000}]}],active_rules_id:'rules'};return checkLimits(r,texts,{document_ids:['doc1'],common_mode:f.common_mode})[0].count})},fixtures)
  const doc1=seeded().rounds[0].documents[0].seed_text,doc2=seeded().rounds[0].documents[1].seed_text
  expect(checks).toEqual(fixtures.map(f=>f.scope==='document'?doc1.length:f.scope==='total' || ['append','prepend'].includes(f.common_mode)?doc1.length+2+doc2.length:doc1.length))
})

test('viewer can read provisional responses but cannot export or freeze without shared text',async({page,context})=>{
  const slug=`rebuttal-viewer-${Date.now()}`,state=seeded(),mock=await api(context,state)
  await context.route('**/_auth/context.js',route=>route.fulfill({contentType:'text/javascript',body:`window.PaperAccess={projects:{${JSON.stringify(slug)}:'viewer'}};`}))
  await open(page,slug,'reviews')
  await expect(page.locator('#response-editor .cm-content')).toContainText('We clarify')
  await expect(page.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','false')
  await expect(page.locator('[data-action="check-response"]')).toBeDisabled()
  expect(await page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').size)).toBe(0)
  await navigateScreen(page,'reviews');await selectProperty(page,'document-select','doc2')
  await expect(page.locator('#response-editor .cm-content')).toContainText('Thank you')
  await navigateScreen(page,'submission')
  await expect(page.locator('#freeze-submission')).toBeDisabled()
  const downloads=[];page.on('download',download=>downloads.push(download))
  await page.locator('[data-action="export"]').click()
  await expect(page.locator('#notice')).toContainText('Response text is still loading')
  expect(mock.calls.filter(call=>call.method==='POST' && /\/(exports|submissions)$/.test(call.path))).toHaveLength(0)
  expect(downloads).toHaveLength(0)
  expect(await page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').size)).toBe(0)
  await navigateScreen(page,'reviews')
  await expect(page.locator('#response-editor .cm-content')).toContainText('Thank you')
  await expect(page.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','false')
})

test('edited mappings stay stale until an explicit check sends the current snapshot',async({page,context})=>{
  const state=seeded(),value=state.rounds[0].documents[0].seed_text
  state.rounds[0].mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:'We clarify'}],coverage:'addressed',reason:'The explanation is present.',missing:[],origin:'manual',decision:'confirmed',stale:false}]
  const mock=await api(context,state);await open(page,`rebuttal-reconfirm-${Date.now()}`,'reviews')
  await edit(page,value+' Additional measurements are attached.')
  await expect.poll(()=>state.rounds[0].mappings[0].stale).toBe(true)
  await expect.poll(()=>Boolean(state.rounds[0].text_hashes?.doc1)).toBe(true)
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(0)
  await page.locator('[data-action="check-response"]').click()
  const check=mock.calls.find(call=>call.path.endsWith('/analyses'))
  expect(check.body.task).toBe('connect')
  expect(check.body.texts.doc1).toBe(value+' Additional measurements are attached.')
  expect(state.rounds[0].mappings[0].stale).toBe(true)
  expect(state.rounds[0].mappings[0].decision).toBe('confirmed')
})


test('reviewer labels from the real server are shown instead of opaque identifiers',async({page,context})=>{
  const state=seeded();state.rounds[0].reviewers=[{id:'reviewer1',label:'Reviewer A'}]
  await api(context,state);await open(page,`rebuttal-label-${Date.now()}`,'reviews')
  await expect(page.locator('#reviewer-nav')).toContainText('Reviewer A')
})

test('reviewer list shows rating and confidence without inventing missing values',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.reviews[0].fields.Rating='7: Good paper';r.reviews[0].fields.Confidence='4: Confident'
  r.reviewers.push({id:'reviewer2',name:'Reviewer B'},{id:'reviewer3',name:'Reviewer C'})
  r.reviews.push({id:'review2',reviewer_id:'reviewer2',fields:{rating:'5',review:'No confidence'},translations:{}},{id:'review3',reviewer_id:'reviewer3',fields:{review:'No scores provided'},translations:{}})
  await api(context,state);await open(page,`reviewer-ratings-${Date.now()}`,'reviews')
  const score=id=>page.locator(`#reviewer-nav [data-id="${id}"] .reviewer-progress`)
  await expect(score('reviewer1')).toHaveText('7/4')
  await expect(score('reviewer1')).toHaveAttribute('aria-label','Rating: 7, Confidence: 4')
  await expect(score('reviewer2')).toHaveText('5/—')
  await expect(score('reviewer3')).toHaveText('—/—')
})

test('reviewer mates remain distinct and stable across collaborators, reordering and reload',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),r=state.rounds[0],slug=`reviewer-mates-${Date.now()}`
  for(let i=2;i<=5;i++){r.reviewers.push({id:`reviewer${i}`,name:`Reviewer ${i}`});r.reviews.push({id:`review${i}`,reviewer_id:`reviewer${i}`,fields:{review:'Synthetic review'},translations:{}})}
  try {
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage();await open(a,slug,'reviews');await open(b,slug,'reviews')
    const mates=page=>page.locator('#reviewer-nav [data-action="reviewer-mate-click"]').evaluateAll(nodes=>Object.fromEntries(nodes.map(node=>[node.dataset.id,node.querySelector('.reviewer-mate').getAttribute('src')])))
    await expect.poll(async()=>Object.keys(await mates(a)).length).toBe(5)
    const initial=await mates(a);expect(new Set(Object.values(initial)).size).toBe(5)
    await expect.poll(()=>mates(b)).toEqual(initial)
    r.reviewers.reverse();r.reviews.reverse();state.revision++
    await a.evaluate(()=>window.PaperRebuttal.refresh());await expect.poll(()=>mates(a)).toEqual(initial)
    await b.reload();await b.evaluate(()=>window.PaperRebuttalSession.whenReady);await expect.poll(()=>mates(b)).toEqual(initial)
    r.reviewers.push({id:'reviewer6',name:'Reviewer 6'});r.reviews.push({id:'review6',reviewer_id:'reviewer6',fields:{review:'New reviewer'},translations:{}});state.revision++
    await a.evaluate(()=>window.PaperRebuttal.refresh())
    const after=await mates(a);for(const id of Object.keys(initial))expect(after[id]).toBe(initial[id])
    await expect.poll(()=>mates(b)).toMatchObject(initial)
  } finally {await first.close();await second.close()}
})

test('reviewer character choices are shared and survive reload',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),r=state.rounds[0],slug=`mate-picker-${Date.now()}`
  for(let i=2;i<=10;i++){r.reviewers.push({id:`reviewer${i}`,name:`Reviewer ${i}`});r.reviews.push({id:`review${i}`,reviewer_id:`reviewer${i}`,fields:{review:'Synthetic review'},translations:{}})}
  try {
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage();await open(a,slug,'reviews');await open(b,slug,'reviews')
    const avatars=a.locator('#reviewer-nav [data-action="reviewer-mate-click"] .reviewer-mate')
    const urls=await avatars.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('src')))
    expect(new Set(urls).size).toBe(10)
    await expect.poll(()=>avatars.evaluateAll(nodes=>nodes.filter(node=>node.complete && node.naturalWidth>0).length)).toBe(10)
    const change=a.locator('[data-action="reviewer-mate-click"][data-id="reviewer1"]')
    const before=await change.locator('img').getAttribute('src')
    await change.locator('img').click()
    await expect(a.locator('#form-dialog input[name="mate"]')).toHaveCount(10)
    await a.locator('#form-dialog label').filter({hasText:'Mint'}).click()
    await a.mouse.click(2,2)
    await expect(a.locator('#form-dialog')).not.toBeVisible()
    await expect(change.locator('img')).toHaveAttribute('src',before)
    await change.locator('img').click()
    await a.locator('#form-dialog label').filter({hasText:'Mint'}).click()
    await a.locator('#dialog-save').click()
    await expect(change).toBeFocused()
    const selector='#reviewer-nav [data-action="reviewer-mate-click"][data-id="reviewer1"] .reviewer-mate'
    await expect(a.locator(selector)).toHaveAttribute('src','/assets/reviewer-mates/mint-v2.png')
    await expect(b.locator(selector)).toHaveAttribute('src','/assets/reviewer-mates/mint-v2.png')
    await b.reload();await b.evaluate(()=>window.PaperRebuttalSession.whenReady)
    await expect(b.locator(selector)).toHaveAttribute('src','/assets/reviewer-mates/mint-v2.png')
    await change.focus();await a.keyboard.press('Enter');await expect(a.locator('#form-dialog')).toBeVisible();await a.locator('#dialog-cancel').click()
  } finally {await first.close();await second.close()}
})

test('collapsed reviewer sidebar still opens reviews and lets the selected character be changed',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.reviewers.push({id:'reviewer2',name:'Reviewer B'});r.reviews.push({id:'review2',reviewer_id:'reviewer2',fields:{review:'Other review'},translations:{}})
  await api(context,state);await open(page,`collapsed-mates-${Date.now()}`,'reviews')
  await page.locator('#toggle-review-sidebar').click()
  const mate=page.locator('[data-action="reviewer-mate-click"][data-id="reviewer2"]')
  await expect(mate).toHaveAttribute('aria-label','Open review for Reviewer B')
  await mate.click()
  await expect(page.locator('#reviewer-nav [data-action="open-review"][data-id="reviewer2"]')).toHaveAttribute('aria-current','page')
  await expect(mate).toHaveAttribute('aria-label','Change character for Reviewer B')
  await mate.click();await expect(page.locator('#form-dialog')).toBeVisible()
})


test('pending imports remain stored without a visible pending section',async({page,context})=>{
  const state=seeded();state.rounds[0].imports=[{id:'pending-source',kind:'pdf',status:'staged',raw:{filename:'Printed OpenReview.pdf'},reviews:[]}]
  await api(context,state);await open(page,`rebuttal-pending-${Date.now()}`,'overview','ko')
  await expect(page.locator('.pending-imports')).toHaveCount(0)
  expect(state.rounds[0].imports[0].status).toBe('staged')
})

test('workspace switch keeps project and review context across a round trip',async({page,context})=>{
  const slug=`navigation-${Date.now()}`
  await api(context,seeded())
  await open(page,slug,'reviews','ko')
  await selectProperty(page,'document-select','doc2')
  await expect(page.locator('.project-workspace-nav [aria-current="page"]')).toHaveText('Rebuttal')
  await page.locator('#manuscript-link').click()
  await expect(page).toHaveURL(url=>url.pathname===`/p/${slug}` && url.searchParams.get('lang')==='ko')
  await expect(page.locator('.project-workspace-nav [aria-current="page"]')).toHaveAttribute('id','manuscript-link')
  await page.waitForFunction(()=>workspaceReadyForCompile)
  const writingTabs=await page.locator('.project-workspace-nav').boundingBox()
  const writingTitle=await page.locator('#project-title').inputValue()
  await page.locator('#open-rebuttal').click()
  const review=page.frameLocator('.paper-review-frame')
  await expect(review.locator('#response-editor')).toBeVisible()
  const reviewTabs=await review.locator('.project-workspace-nav').boundingBox()
  expect(reviewTabs.x).toBeCloseTo(writingTabs.x,0)
  expect(reviewTabs.y).toBeCloseTo(writingTabs.y,0)
  expect(reviewTabs.height).toBeCloseTo(writingTabs.height,0)
  await expect(review.locator('#workspace-project-title')).toHaveText(writingTitle)
  await expect(review.locator('#response-editor')).toContainText('Thank you for the thoughtful reviews.')
  await page.setViewportSize({width:390,height:844})
  const nav=review.locator('.project-workspace-nav')
  await expect(nav).toBeVisible()
  const box=await nav.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390)
})

test('preloaded views share collaboration and synchronize both drafts across browsers',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`preloaded-sync-${Date.now()}`
  try {
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage()
    await Promise.all([a.goto(`/p/${slug}?lang=en`),b.goto(`/p/${slug}?lang=en`)])
    await Promise.all([a.waitForFunction(()=>workspaceReadyForCompile),b.waitForFunction(()=>workspaceReadyForCompile)])
    await Promise.all([a.waitForFunction(()=>document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession),b.waitForFunction(()=>document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)])
    await Promise.all([a.evaluate(()=>window.PaperWorkspaceSharedSession.whenReady),b.evaluate(()=>window.PaperWorkspaceSharedSession.whenReady)])
    await a.locator('.cm-content').focus();await a.keyboard.type('Shared manuscript sentence. ')
    await expect.poll(()=>b.evaluate(()=>editorValue())).toContain('Shared manuscript sentence.')
    await Promise.all([a.locator('#open-rebuttal').click(),b.locator('#open-rebuttal').click()])
    const ar=a.frameLocator('.paper-review-frame'),br=b.frameLocator('.paper-review-frame')
    await expect(ar.locator('#response-editor .cm-content')).toBeVisible()
    await expect(ar.locator('#response-presence-avatars .project-presence-avatar')).toHaveCount(1)
    await ar.locator('#response-editor .cm-content').click();await a.keyboard.press('Control+a');await a.keyboard.insertText('Shared review response.')
    await expect(br.locator('#response-editor .cm-content')).toContainText('Shared review response.')
    await ar.locator('#manuscript-link').click();await expect(br.locator('#response-presence-avatars .project-presence-avatar')).toHaveCount(0);await a.locator('#open-rebuttal').click()
    await expect(br.locator('#response-presence-avatars .project-presence-avatar')).toHaveCount(1)
    await expect(ar.locator('#response-editor .cm-content')).toContainText('Shared review response.')
    await ar.locator('#manuscript-link').click()
    await a.reload();await a.waitForFunction(()=>typeof workspaceReadyForCompile !== 'undefined' && workspaceReadyForCompile)
    expect(await a.evaluate(()=>editorValue())).toContain('Shared manuscript sentence.')
    await a.locator('#open-rebuttal').click()
    await expect(a.frameLocator('.paper-review-frame').locator('#response-editor .cm-content')).toContainText('Shared review response.')
  } finally { await first.close();await second.close() }
})

test('refreshing a review keeps the selected reviewer, draft and editing position',async({page,context})=>{
  const state=seeded();await api(context,state);const slug=`review-refresh-${Date.now()}`
  await page.goto(`/p/${slug}/rebuttal?round=r1&lang=en#reviews`)
  const frame=page.frameLocator('.paper-review-frame')
  await expect(frame.locator('#response-editor .cm-content')).toContainText('We clarify')
  await frame.locator('#response-editor .cm-content').click();await page.keyboard.press('Control+a');await page.keyboard.insertText('A retained response draft.')
  await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight')
  await page.reload()
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(frame.locator('#response-editor .cm-content')).toContainText('A retained response draft.')
  await expect(frame.locator('#reviewer-nav [aria-current="page"]')).toContainText('Reviewer A')
  await expect.poll(()=>page.evaluate(()=>{const child=document.querySelector('.paper-review-frame').contentWindow;return child.PaperRebuttal?.getSelection()?.start})).toBe(2)
})


test('compact review controls retain touch targets and fit both locales',async({page,context})=>{
  await api(context,seeded())
  for(const lang of ['en','ko'])for(const width of [320,390]){
    await page.setViewportSize({width,height:844})
    await open(page,`touch-${lang}-${width}-${Date.now()}`,'reviews',lang)
    await page.evaluate(()=>document.fonts.ready)
    for(const selector of ['.project-workspace-nav a','.screen-nav button','.app-nav a','.round-controls .property-trigger','.response-panel .property-trigger','.analysis-toolbar button','.review-language-switch button','.concern-title']){
      for(const control of await page.locator(selector).all()){
        if(await control.isVisible())expect((await control.boundingBox()).height,selector).toBeGreaterThanOrEqual(44)
      }
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width)
    await page.screenshot({path:`/tmp/paper-rebuttal-touch-${lang}-${width}.png`,animations:'disabled'})
  }
})

test('keyboard skip link stays above the shared project header',async({page,context})=>{
  await api(context,seeded())
  for(const width of [390,1600]){
    await page.setViewportSize({width,height:900})
    await open(page,`skip-${width}-${Date.now()}`)
    const skip=page.locator('.skip-link')
    await skip.focus()
    const box=await skip.boundingBox()
    expect(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('a')?.classList.contains('skip-link'),{x:box.x+box.width/2,y:box.y+box.height/2})).toBe(true)
    await page.keyboard.press('Enter')
    await expect(page.locator('#main')).toBeFocused()
  }
})

for (const theme of ['light', 'dark']) for (const width of [320, 1600]) {
  test(`native rules picker preserves draft and keyboard contract ${theme} ${width}`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
    const state = seeded(), second = structuredClone(seeded().rounds[0])
    second.id = 'r2'; second.title = 'Second review round'
    second.documents = [{ id: 'second-document', title: 'Second round response', kind: 'reviewer', reviewer_id: 'reviewer1', text_key: 'response:second-document', seed_text: 'An independent second round response.' }]
    state.rounds.push(second)
    const mock = await api(context, state)
    await open(page, `native-picker-${theme}-${width}-${Date.now()}`)
    test.skip(!await page.evaluate(() => CSS.supports('appearance', 'base-select')), 'Engine uses the native platform select fallback without an inspectable CSS picker.')
    await page.evaluate(() => document.fonts.ready)
    await page.locator('[data-action="rules"]').click()
    const dialog = page.locator('#form-dialog'), layout = dialog.locator('[name="layout"]')
    await expect(layout).toHaveValue('per_reviewer')
    await layout.click()
    await expect.poll(() => layout.evaluate(el => el.matches(':open'))).toBe(true)
    const measurements = await layout.evaluate(el => {
      const picker = getComputedStyle(el, '::picker(select)'), root = getComputedStyle(document.documentElement)
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
      return { open: el.matches(':open'), background: picker.backgroundColor, borderColor: picker.borderColor, borderWidth: picker.borderWidth, borderRadius: picker.borderRadius, pickerWidth: picker.width, pickerHeight: picker.height, expectedBackground: root.getPropertyValue('--theme-overlay').trim(), expectedBorder: root.getPropertyValue('--theme-menu-border').trim(), control: rect(el), options: [...el.options].map(option => ({ value: option.value, ...rect(option) })) }
    })
    expect(measurements.borderWidth).toBe('1px')
    expect(measurements.borderRadius).toBe('8px')
    const expectedColors = await page.evaluate(({ background, border }) => {
      const probe = document.createElement('span'); probe.style.backgroundColor = background; probe.style.borderColor = border; document.body.append(probe)
      const s = getComputedStyle(probe), result = { background: s.backgroundColor, border: s.borderColor }; probe.remove(); return result
    }, { background: measurements.expectedBackground, border: measurements.expectedBorder })
    expect(measurements.background).toBe(expectedColors.background)
    expect(measurements.borderColor).toBe(expectedColors.border)
    for (const option of measurements.options) {
      expect(option.width).toBeGreaterThan(0)
      expect(option.x).toBeGreaterThanOrEqual(0)
      expect(option.x + option.width).toBeLessThanOrEqual(width)
    }
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const artifacts = resolve(import.meta.dirname, '../../../../.omx/artifacts/linear-refresh/precision')
    mkdirSync(artifacts, { recursive: true })
    const screenshot = resolve(artifacts, `picker-${theme}-${width}.png`)
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    writeFileSync(resolve(artifacts, `picker-${theme}-${width}.json`), JSON.stringify(measurements, null, 2))
    await testInfo.attach('open native picker', { path: screenshot, contentType: 'image/png' })
    // Escape dismisses only the picker and cancels the uncommitted navigation.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect.poll(() => layout.evaluate(el => el.matches(':open'))).toBe(false)
    await expect(dialog).toBeVisible()
    await expect(layout).toBeFocused()
    await expect(layout).toHaveValue('per_reviewer')
    await page.keyboard.press('Space')
    await expect.poll(() => layout.evaluate(el => el.matches(':open'))).toBe(true)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(layout).toHaveValue('unified')
    await expect.poll(() => layout.evaluate(el => el.matches(':open'))).toBe(false)
    await expect(layout).toBeFocused()
    await save(page)
    expect(state.rounds[0].rules.at(-1).layout).toBe('unified')
    expect(state.rounds[0].active_rules_id).toBeNull()
    expect(mock.calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0)
    // Dynamic property menus select the original document/round values and render the selected data.
    await navigateScreen(page,'reviews')
    await selectProperty(page,'document-select','doc2')
    await expect(page.locator('#response-editor .cm-content')).toContainText('Thank you for the thoughtful reviews.')
    await selectProperty(page,'round-select','r2')
    await expect.poll(() => new URL(page.url()).searchParams.get('round')).toBe('r2')
    await expect(page.locator('#response-editor .cm-content')).toContainText('An independent second round response.')
    await selectProperty(page,'round-select','r1')
    await expect.poll(() => new URL(page.url()).searchParams.get('round')).toBe('r1')
    await selectProperty(page,'document-select','doc1')
    await expect(page.locator('#response-editor .cm-content')).toContainText('We clarify the comparison')
    expect(state.rounds[0].active_rules_id).toBeNull()
  })
}

for (const theme of ['light', 'dark']) for (const width of [320, 390, 1024, 1600]) {
  test(`long reviewer and common response labels remain navigable ${theme} ${width}`, async ({ page, context }) => {
    await page.setViewportSize({width,height:1000})
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
    const state=seeded(),r=state.rounds[0]
    const reviewerTitle='매우 긴 연구 검토 설명 Long reviewer name '.repeat(6).trim()
    const documentTitle='매우 긴 공통 답변 설명 Long common response title '.repeat(6).trim()
    r.reviewers[0].name=reviewerTitle;r.documents[1].title=documentTitle
    await api(context,state);await open(page,`long-navigation-${theme}-${width}-${Date.now()}`,'reviews')
    await page.evaluate(()=>document.fonts.ready)
    if(width<768){
      const navigation=page.locator('#reviewer-nav')
      await expect(navigation).toHaveCSS('flex-direction','row')
      expect((await navigation.boundingBox()).height).toBeLessThanOrEqual(70)
      for(const character of await navigation.locator('.reviewer-mate-button').all())expect((await character.boundingBox()).height).toBeGreaterThanOrEqual(44)
    }
    for(const [action,id,title,text] of [['open-review','reviewer1',reviewerTitle,'We clarify'],['open-document','doc2',documentTitle,'Thank you for the thoughtful reviews.']]){
      const button=page.locator(`#reviewer-nav [data-action="${action}"][data-id="${id}"]`)
      await expect(button.locator('strong')).toHaveText(title)
      await button.focus();await page.keyboard.press('Enter')
      await expect(page.locator('#response-editor .cm-content')).toContainText(text)
      const bounds=await button.boundingBox()
      expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width)
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
    await page.emulateMedia({forcedColors:'active'})
    await selectProperty(page,'document-select','doc1')
    await expect(page.locator('#response-editor .cm-content')).toContainText('We clarify')
    expect(r.active_rules_id).toBeNull()
  })
}

// The primary workflow starts with writing; management tools are disclosed.
test('writing-first default, reviewer context and explicit complete response check',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.reviewers.push({id:'reviewer2',name:'Reviewer B'})
  r.reviews.push({id:'review2',reviewer_id:'reviewer2',fields:{summary:'Explain the second experiment.'},translations:{}})
  r.documents.push({id:'doc3',title:'Response to Reviewer B',kind:'reviewer',reviewer_id:'reviewer2',text_key:'response:doc3',seed_text:'The second experiment isolates the treatment.'})
  r.concerns.push({id:'concern2',title:'Second experiment',reviewer_id:'reviewer2',source_spans:[{review_id:'review2',field:'summary',quote:'Explain the second experiment.',start:0,end:30}],requires_response:true,work_status:'todo'})
  const mock=await api(context,state)
  await page.goto(`/p/rebuttal-primary-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en`)
  await expect(page.locator('#response-editor .cm-content')).toContainText('We clarify')
  await expect(page.locator('#review-advanced')).not.toHaveAttribute('open','')
  await expect(page.locator('[data-action="analysis"][data-id="map"]')).not.toBeVisible()
  await page.locator('#reviewer-nav [data-action="open-review"][data-id="reviewer2"]').click()
  await expect(page.locator('#review-content')).toContainText('second experiment')
  await expect(page.locator('#response-editor')).toContainText('isolates the treatment')
  await edit(page,'The second experiment now includes an additional control.')
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(0)
  await page.locator('[data-action="check-response"]').click()
  await expect.poll(()=>mock.calls.filter(call=>call.path.endsWith('/analyses')).length).toBe(1)
  const check=mock.calls.find(call=>call.path.endsWith('/analyses'))
  expect(check.body.task).toBe('connect')
  await expect(page.locator('#show-all-connections')).toBeChecked()
  expect(check.body.scope).toEqual({review_ids:['review2'],document_ids:['doc3']})
  expect(check.body.texts.doc3).toContain('additional control')
  await expect(page.locator('[data-action="check-response"]')).toBeDisabled()
  await expect(page.locator('#response-check-progress')).toBeVisible()
  await expect(page.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','false')
  await expect(page.locator('#notice')).toBeHidden()
  await expect(page.locator('#response-editor')).toHaveAttribute('inert','')
  await expect(page.locator('.response-panel')).toHaveClass(/is-checking/)
  await expect(page.locator('#response-editor')).toHaveCSS('filter','blur(1px)')
  await page.keyboard.type('unexpected')
  expect(await page.evaluate(()=>window.PaperRebuttal.getTexts().doc3)).toContain('additional control.')
  expect(await page.evaluate(()=>window.PaperRebuttal.getTexts().doc3)).not.toContain('unexpected')
  state.jobs[0].status='completed';state.jobs[0].result={};state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh())
  await expect(page.locator('[data-action="check-response"]')).toBeEnabled()
  await expect(page.locator('#response-check-progress')).toBeHidden()
  await expect(page.locator('#response-editor')).not.toHaveAttribute('inert','')
  await expect(page.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','true')
  await edit(page,'The second experiment includes two additional controls.')
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(1)
  await page.screenshot({path:'/tmp/rebuttal-writing-default.png',animations:'disabled'})
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({path:'/tmp/rebuttal-writing-mobile.png',animations:'disabled'})
})

test('selected review links are opt-in and preserve adequacy and author decisions',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],coverage:'partial',reason:'The baseline is explained; uncertainty is still missing.',missing:['Report uncertainty.'],origin:'ai',decision:'proposed',stale:false}]
  const slug=`rebuttal-links-${Date.now()}`
  await page.addInitScript(slug=>localStorage.setItem(`paper-rebuttal-show-connections:${slug}:r1`,'false'),slug)
  await api(context,state);await page.setViewportSize({width:1600,height:1000});await open(page,slug,'reviews')
  await expect(page.locator('.rebuttal-span')).toHaveCount(0)
  await expect(page.locator('#mapping-edges path')).toHaveCount(0)
  await page.locator('#show-all-connections').check()
  await expect(page.locator('.rebuttal-span')).toHaveCount(1)
  await page.locator('#show-all-connections').uncheck()
  await expect(page.locator('.rebuttal-span')).toHaveCount(0)
  const resizer=page.locator('#review-panel-resizer')
  const before=Number(await resizer.getAttribute('aria-valuenow'))
  await resizer.focus();await page.keyboard.press('ArrowRight')
  await expect(resizer).toHaveAttribute('aria-valuenow',String(before+5))
  await page.locator('.review-text mark[data-action="select-concern"]').first().click()
  await expect(page.locator('.selected-concern-result')).toBeVisible()
  await expect(page.locator('.rebuttal-span')).toHaveCount(1)
  await expect(page.locator('#mapping-edges path')).not.toHaveCount(0)
  await expect(page.locator('.mapping')).not.toContainText('Partial')
  await expect(page.locator('.mapping')).toContainText('Report uncertainty.')
  await page.screenshot({path:'/tmp/rebuttal-writing-selected.png',animations:'disabled'})
  expect(state.rounds[0].mappings[0].coverage).toBe('partial')
  expect(state.rounds[0].mappings[0].decision).toBe('proposed')
  await page.locator('.review-text mark[data-action="select-concern"]').first().click()
  await expect(page.locator('.selected-concern-result')).toHaveCount(0)
  await page.mouse.move(0,0);await page.locator('#show-all-connections').focus()
  await expect(page.locator('.rebuttal-span')).toHaveCount(0)
  expect(state.rounds[0].mappings[0].coverage).toBe('partial')
  expect(state.rounds[0].mappings[0].decision).toBe('proposed')
})

test('connection details keep a clear hierarchy on desktop and mobile',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],coverage:'related',reason:'The baseline is explained.',decision:'proposed'}]
  await api(context,state);await page.setViewportSize({width:1440,height:900});await open(page,`rebuttal-details-design-${Date.now()}`,'reviews')
  await page.locator('.review-text mark[data-id="concern1"]').first().click()
  const details=page.locator('.selected-concern-result')
  await expect(details.locator('.concern-title')).toHaveCSS('justify-content','flex-start')
  await expect(details.locator('.concern-title')).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await expect(details.locator('.concern-title-text')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await expect(details.locator('.mapping-meta')).toHaveCount(0)
  await expect(details.locator('.concern-properties')).toHaveCount(0)
  await expect(details).toContainText('Review original');await expect(details).toContainText('Why connected');await expect(details).toContainText('Response passage')
  await expect(details.locator('.concern-source-pair .concern-translation')).toBeVisible()
  await expect(details.locator('[data-action="confirm-mapping"]')).toHaveCount(0)
  await expect(details.locator('.connection-details-body')).toHaveCSS('overflow-y','auto')
  await expect.poll(()=>details.evaluate(el=>el.getBoundingClientRect().bottom-innerHeight)).toBeLessThanOrEqual(1)
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390)
})

test('connection details scroll in a fixed drawer without resizing the editor',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],coverage:'related',reason:'이 연결은 리뷰와 답변의 관련성을 설명합니다. '.repeat(45),decision:'proposed'}]
  await api(context,state);await page.setViewportSize({width:1440,height:900});await open(page,`rebuttal-long-detail-${Date.now()}`,'reviews')
  const workspace=page.locator('#mapping-workspace'), editor=page.locator('.response-panel')
  const beforeWorkspace=await workspace.boundingBox(), beforeEditor=await editor.boundingBox()
  await page.locator('.review-text mark[data-id="concern1"]').first().click()
  const details=page.locator('.selected-concern-result'), body=details.locator('.connection-details-body')
  await expect(details).toBeVisible()
  await expect.poll(async()=>{const drawer=await details.boundingBox(),panel=await page.locator('.source-panel').boundingBox();return Math.abs(drawer.height-panel.height/4)}).toBeLessThanOrEqual(1)
  expect(await workspace.boundingBox()).toEqual(beforeWorkspace)
  expect(await editor.boundingBox()).toEqual(beforeEditor)
  await expect.poll(()=>body.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeGreaterThan(100)
  await body.evaluate(el=>el.scrollTop=el.scrollHeight)
  await expect.poll(()=>body.evaluate(el=>el.scrollTop)).toBeGreaterThan(0)
  const toggle=details.getByRole('button',{name:'Collapse connection details'})
  await expect(details).toHaveCSS('transition-property','height')
  await toggle.click()
  await expect.poll(()=>details.evaluate(el=>el.getAnimations().some(animation=>animation.transitionProperty==='height'))).toBe(true)
  await expect(details.getByRole('button',{name:'Expand connection details'})).toHaveAttribute('aria-expanded','false')
  await expect(body).toBeHidden()
  expect(await workspace.boundingBox()).toEqual(beforeWorkspace)
  expect(await editor.boundingBox()).toEqual(beforeEditor)
  await page.mouse.move(0,0)
  await page.locator('.review-text mark[data-id="concern1"]').first().hover()
  await expect(body).toBeHidden()
  await details.getByRole('button',{name:'Expand connection details'}).click()
  await expect(body).toBeVisible()
  await expect(details.getByRole('button',{name:'Collapse connection details'})).toHaveAttribute('aria-expanded','true')
  await page.emulateMedia({reducedMotion:'reduce'})
  await expect(details).toHaveCSS('transition-property','none')
})

test('connection details resize by drag and keyboard and remember their height',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],reason:'Related evidence',decision:'proposed'}]
  await api(context,state);await page.setViewportSize({width:1440,height:900});await open(page,`rebuttal-resize-${Date.now()}`,'reviews')
  await page.locator('.review-text mark[data-id="concern1"]').click()
  const details=page.locator('.selected-concern-result'),panel=page.locator('.source-panel'),handle=page.getByRole('separator',{name:'Resize connection details'}),button=details.locator('.connection-details-toggle'),arrow=details.locator('.connection-details-chevron')
  // The drawer initially transitions from its viewport fallback height to its
  // panel-relative height. Raw mouse coordinates must target the settled grip.
  await details.evaluate(async node=>{
    await Promise.all(node.getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))
  })
  await handle.hover()
  const labelBox=await button.boundingBox(), arrowBox=await arrow.boundingBox()
  expect(arrowBox.x+arrowBox.width).toBeGreaterThan(labelBox.x+labelBox.width-2)
  const panelBox=await panel.boundingBox(),handleBox=await handle.boundingBox()
  await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await page.mouse.down()
  await page.mouse.move(handleBox.x+handleBox.width/2,panelBox.y+panelBox.height/2,{steps:5});await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow','50')
  await expect.poll(async()=>{const box=await details.boundingBox();return Math.abs(box.height-panelBox.height/2)}).toBeLessThanOrEqual(2)
  await handle.focus();await page.keyboard.press('ArrowUp');await expect(handle).toHaveAttribute('aria-valuenow','55')
  await page.reload();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await page.locator('.review-text mark[data-id="concern1"]').click()
  await expect(handle).toHaveAttribute('aria-valuenow','55')
  await details.getByRole('button',{name:'Collapse connection details'}).click();await expect(handle).toBeHidden()
  await details.getByRole('button',{name:'Expand connection details'}).click();await expect(handle).toHaveAttribute('aria-valuenow','55')
})

test('collapsed connection details stay collapsed when hovering other links and after reload',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],text=r.reviews[0].fields.summary
  const quote='report uncertainty', start=text.indexOf(quote)
  r.concerns.push({id:'concern2',title:'Uncertainty',reviewer_id:'reviewer1',source_spans:[{review_id:'review1',field:'summary',quote,start,end:start+quote.length}]})
  await api(context,state);await page.setViewportSize({width:1440,height:900});await open(page,`rebuttal-collapse-${Date.now()}`,'reviews')
  const first=page.locator('.review-text mark[data-id="concern1"]'),second=page.locator('.review-text mark[data-id="concern2"]')
  await page.locator('#show-all-connections').check()
  await first.hover()
  const details=page.locator('.selected-concern-result')
  await details.getByRole('button',{name:'Collapse connection details'}).click()
  await second.hover()
  await expect(details).toHaveAttribute('data-concern-id','concern2')
  await expect(details.locator('.connection-details-body')).toBeHidden()
  await expect(details.getByRole('button',{name:'Expand connection details'})).toHaveAttribute('aria-expanded','false')
  const samples=await page.evaluate(async()=>{
    const heights=[]
    document.querySelector('.review-text mark[data-id="concern1"]').click()
    const start=performance.now()
    await new Promise(resolve=>{const frame=()=>{heights.push(document.querySelector('.selected-concern-result')?.getBoundingClientRect().height || 0);if(performance.now()-start<350)requestAnimationFrame(frame);else resolve()};requestAnimationFrame(frame)})
    return heights
  })
  expect(Math.max(...samples)).toBeLessThanOrEqual(44)
  await page.reload();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await page.locator('.review-text mark[data-id="concern1"]').hover()
  await expect(details.locator('.connection-details-body')).toBeHidden()
  await details.getByRole('button',{name:'Expand connection details'}).click()
  await expect(details.locator('.connection-details-body')).toBeVisible()
})

test('saved connections remain visible after reload and respect an explicit choice',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],coverage:'related',reason:'Related evidence',origin:'ai',decision:'proposed',stale:false}]
  await api(context,state);await page.setViewportSize({width:1600,height:1000});await open(page,`rebuttal-persist-links-${Date.now()}`,'reviews')
  const toggle=page.locator('#show-all-connections')
  await expect(toggle).toBeChecked();await expect(page.locator('.rebuttal-span[data-mapping-id="map1"]')).toBeVisible()
  await toggle.uncheck();await page.reload();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await expect(toggle).not.toBeChecked();await expect(page.locator('.rebuttal-span')).toHaveCount(0)
  await toggle.check();await page.reload();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await expect(toggle).toBeChecked();await expect(page.locator('.rebuttal-span[data-mapping-id="map1"]')).toBeVisible()
  expect(state.rounds[0].mappings).toHaveLength(1)
})

test('editing a long response keeps its scroll position after saving',async({page,context})=>{
  const state=seeded(),round=state.rounds[0]
  round.documents[0].seed_text=Array.from({length:100},(_,i)=>`Response paragraph ${i+1}: evidence and discussion.\n`).join('\n')
  const mock=await api(context,state);await page.setViewportSize({width:1600,height:900});await open(page,`rebuttal-scroll-save-${Date.now()}`,'reviews')
  await page.locator('#response-editor .cm-content').click();await page.keyboard.press('Control+End')
  const scroll=page.locator('#response-editor .cm-scroller');await expect.poll(()=>scroll.evaluate(el=>el.scrollTop)).toBeGreaterThan(1000)
  const before=await scroll.evaluate(el=>el.scrollTop);expect(before).toBeGreaterThan(1000)
  await page.keyboard.type('X')
  await expect.poll(()=>mock.calls.filter(call=>call.method==='PUT').length,{timeout:10000}).toBeGreaterThan(0)
  await expect.poll(()=>page.evaluate(()=>!document.querySelector('#response-editor .cm-content')?.matches(':focus')),{timeout:3000}).toBe(false)
  await page.locator('.review-text mark[data-id="concern1"]').click()
  await expect.poll(()=>scroll.evaluate(el=>el.scrollTop),{timeout:5000}).toBeGreaterThan(before-100)
})

test('highlighted response text remains editable when clicked',async({page,context})=>{
  const state=seeded(),round=state.rounds[0],response=round.documents[0].seed_text
  const quote='clarify the comparison',start=response.indexOf(quote)
  round.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',quote,start,end:start+quote.length}],coverage:'related',reason:'Related',origin:'ai',decision:'proposed',stale:false}]
  await api(context,state);await open(page,`rebuttal-edit-highlight-${Date.now()}`,'reviews')
  await page.locator('#show-all-connections').check()
  await page.locator('#response-editor .rebuttal-span[data-mapping-id="map1"]').click()
  await page.keyboard.type('XYZ')
  await expect(page.locator('#response-editor .cm-content')).toContainText('XYZ')
  await expect.poll(()=>page.evaluate(()=>window.PaperRebuttalSession.mapFor('rebuttalResponses').get('response:doc1')?.toString())).toContain('XYZ')
  await page.reload();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await expect(page.locator('#response-editor .cm-content')).toContainText('XYZ')
})

test('a valid new connection is not hidden by an overlapping stale connection',async({page,context})=>{
  const state=seeded(),round=state.rounds[0],review=round.reviews[0],response=round.documents[0].seed_text
  const original='3. Please clarify the theoretical assumptions.',translated='3. 이론의 가정을 설명해 주세요.'
  review.fields.summary=original;review.translations.summary=translated
  review.translation_alignments={summary:{source:original,segments:[{source:original,text:translated}]}}
  const source=quote=>({review_id:'review1',field:'summary',quote,start:original.indexOf(quote),end:original.indexOf(quote)+quote.length})
  round.concerns=[{id:'old',title:'Old manual',source_spans:[source(original)]},{id:'new',title:'Current',source_spans:[source('the theoretical assumptions.')]}]
  const quote='clarify the comparison',start=response.indexOf(quote)
  round.mappings=[{id:'old-map',concern_id:'old',stale:true,needs_reconfirmation:true,response_spans:[{document_id:'doc1',quote:'previous response',start:0,end:17}]},{id:'new-map',concern_id:'new',response_spans:[{document_id:'doc1',quote,start,end:start+quote.length}],decision:'proposed'}]
  await api(context,state);await page.setViewportSize({width:1600,height:1000});await open(page,`rebuttal-stale-overlap-${Date.now()}`,'reviews')
  await expect(page.locator('.review-text mark[data-id="new"]')).toBeVisible()
  await expect(page.locator('#response-editor .rebuttal-span[data-mapping-id="new-map"]')).toBeVisible()
  await expect(page.locator('#mapping-edges g[data-mapping-id="new-map"]')).toBeAttached()
  const color=await page.locator('.review-text mark[data-id="new"]').evaluate(el=>getComputedStyle(el).getPropertyValue('--connection-color').trim())
  await page.locator('[data-review-language="ko"]').click()
  await expect(page.locator('.review-text mark[data-id="new"]')).toBeVisible()
  expect(await page.locator('.review-text mark[data-id="new"]').evaluate(el=>getComputedStyle(el).getPropertyValue('--connection-color').trim())).toBe(color)
})

test('overlapping review connections keep the same color in Korean',async({page,context})=>{
  const state=seeded(),round=state.rounds[0],review=round.reviews[0]
  const original='3. The theory assumes fixed attention.',translated='3. 이론은 고정된 어텐션을 가정합니다.'
  review.fields.summary=original;review.translations.summary=translated
  review.translation_alignments={summary:{source:original,segments:[{source:original,text:translated}]}}
  const span=quote=>({review_id:'review1',field:'summary',quote,start:original.indexOf(quote),end:original.indexOf(quote)+quote.length})
  // The later-listed concern begins earlier in the source, as in Apple R1.
  round.concerns=[{id:'manual',title:'Manual',source_spans:[span(original.slice(3))]},{id:'ai',title:'AI',source_spans:[span(original)]}]
  await api(context,state);await open(page,`rebuttal-overlap-colors-${Date.now()}`,'reviews')
  const mark=page.locator('.review-text mark')
  await expect(mark).toHaveCount(1);await expect(mark).toHaveAttribute('data-id','ai')
  const color=await mark.evaluate(el=>getComputedStyle(el).getPropertyValue('--connection-color').trim())
  await page.locator('[data-review-language="ko"]').click()
  await expect(mark).toHaveCount(1);await expect(mark).toHaveAttribute('data-id','ai')
  expect(await mark.evaluate(el=>getComputedStyle(el).getPropertyValue('--connection-color').trim())).toBe(color)
  await page.locator('[data-review-language="original"]').click()
  await expect(mark).toHaveAttribute('data-id','ai')
})

test('connection colors match both passages and reveal the reason on hover and focus',async({page,context})=>{
  const state=seeded(),round=state.rounds[0],review=round.reviews[0].fields.summary,response=round.documents[0].seed_text
  round.reviews[0].translations={summary:'기준선 비교와 불확실성을 설명해 주세요.'}
  round.reviews[0].translation_alignments={summary:{source:review,segments:[{source:'baseline comparison',text:'기준선 비교'}]}}
  const makeSpan=(quote,kind)=>{const text=kind==='review'?review:response,start=text.indexOf(quote);return kind==='review'?{review_id:'review1',field:'summary',quote,start,end:start+quote.length}:{document_id:'doc1',quote,start,end:start+quote.length}}
  round.concerns=[{id:'c1',title:'Baseline',reviewer_id:'reviewer1',source_spans:[makeSpan('baseline comparison','review')]},{id:'c2',title:'Uncertainty',reviewer_id:'reviewer1',source_spans:[makeSpan('report uncertainty','review')]},{id:'old',title:'Old proposal',reviewer_id:'reviewer1',superseded:true,source_spans:[makeSpan('Please clarify','review')]}]
  round.mappings=[{id:'m1',concern_id:'c1',response_spans:[makeSpan('clarify the comparison','response')],coverage:'related',reason:'Both discuss the baseline.',decision:'proposed'}, {id:'m2',concern_id:'c2',response_spans:[makeSpan('report confidence intervals','response')],coverage:'related',reason:'Both address uncertainty.',decision:'proposed'}, {id:'m3',concern_id:'c1',response_spans:[makeSpan('We','response')],coverage:'related',reason:'Another related passage.',decision:'proposed'},{id:'old-map',concern_id:'old',superseded:true,response_spans:[makeSpan('We clarify','response')],coverage:'related',reason:'Outdated proposal',decision:'proposed'}]
  await api(context,state);await page.setViewportSize({width:1600,height:1000});await open(page,`rebuttal-colored-links-${Date.now()}`,'reviews')
  await page.locator('#show-all-connections').check()
  await expect(page.locator('.rebuttal-span[data-mapping-id="old-map"]')).toHaveCount(0)
  await expect(page.locator('.review-text mark[data-id="old"]')).toHaveCount(0)
  for(const [concern,map] of [['c1','m1'],['c2','m2']]){
    const source=page.locator(`.review-text mark[data-id="${concern}"]`),target=page.locator(`.rebuttal-span[data-mapping-id="${map}"]`),edge=page.locator(`#mapping-edges g[data-mapping-id="${map}"]`)
    await expect(source).toBeVisible();await expect(target).toBeVisible();await expect(edge).toBeAttached()
    const color=el=>getComputedStyle(el).getPropertyValue('--connection-color').trim()
    expect(await source.evaluate(color)).toBe(await target.evaluate(color))
    expect(await edge.evaluate(color)).toBe(await target.evaluate(color))
  }
  expect(await page.locator('.review-text mark[data-id="c1"]').evaluate(el=>getComputedStyle(el).getPropertyValue('--connection-color'))).not.toBe(await page.locator('.review-text mark[data-id="c2"]').evaluate(el=>getComputedStyle(el).getPropertyValue('--connection-color')))
  const source1=page.locator('.review-text mark[data-id="c1"]'),source2=page.locator('.review-text mark[data-id="c2"]'),answer1=page.locator('.rebuttal-span[data-mapping-id="m1"]'),answer2=page.locator('.rebuttal-span[data-mapping-id="m2"]')
  await expect(source1).toHaveCSS('border-bottom-width','0px');await expect(answer1).toHaveCSS('border-bottom-width','0px')
  const original1=await source1.evaluate(el=>getComputedStyle(el).backgroundColor),original2=await source2.evaluate(el=>getComputedStyle(el).backgroundColor)
  await source1.hover();await expect(page.locator('#mapping-workspace')).toHaveClass(/connection-focus-active/)
  await expect(page.locator('.selected-concern-result .concern-title')).toHaveText('Baseline')
  await expect(source1).toHaveClass(/is-focused-connection/);await expect(answer1).toHaveClass(/is-focused-connection/)
  await page.mouse.move(1,1);await expect(page.locator('#mapping-workspace')).toHaveClass(/connection-focus-active/)
  await source2.hover();await expect(source2).toHaveClass(/is-focused-connection/)
  await source1.hover()
  await expect(page.locator('.rebuttal-span[data-mapping-id="m3"]')).toHaveClass(/is-focused-connection/)
  await expect(page.locator('#mapping-edges g[data-mapping-id="m1"] .mapping-edge-line')).toHaveCSS('opacity','0.65')
  expect(await source1.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(original1)
  expect(await source2.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(original2)
  await expect(page.locator('#mapping-edges g[data-mapping-id="m2"] .mapping-edge-line')).toHaveCSS('opacity','0.15')
  await answer1.hover();await expect(source1).toHaveClass(/is-focused-connection/);await expect(answer1).toHaveClass(/is-focused-connection/)
  await expect(page.locator('.rebuttal-span[data-mapping-id="m3"]')).not.toHaveClass(/is-focused-connection/)
  await answer2.hover();await expect(source2).toHaveClass(/is-focused-connection/);await expect(answer2).toHaveClass(/is-focused-connection/)
  await expect(page.locator('.selected-concern-result .concern-title')).toHaveText('Uncertainty')
  await source1.click();await source2.hover()
  await expect(page.locator('.selected-concern-result .concern-title')).toHaveText('Baseline')
  await expect(page.locator('.selected-concern-result .concern-translation')).toContainText('기준선 비교')
  await expect(page.locator('.selected-concern-result .concern-translation')).not.toContainText('불확실성을')
  await expect(page.locator('#mapping-edges g[data-mapping-id="m1"] .mapping-edge-line')).toHaveCSS('opacity','0.65')
  await source1.click();await expect(page.locator('.selected-concern-result')).toHaveCount(0);await expect(page.locator('#mapping-workspace')).not.toHaveClass(/connection-focus-active/);await source2.hover()
  await expect(page.locator('.selected-concern-result .concern-title')).toHaveText('Uncertainty')
  await answer1.click();await expect(page.locator('#response-editor .cm-content')).toBeFocused()
  await page.evaluate(()=>document.activeElement?.blur());await page.mouse.move(0,0);await expect(page.locator('#mapping-workspace')).not.toHaveClass(/connection-focus-active/)
  expect(await source2.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(original2)
  const hit=page.locator('#mapping-edges g[data-mapping-id="m2"] .mapping-edge-hit')
  await hit.hover({force:true});await expect(page.locator('#mapping-edge-tooltip')).toHaveText('Both address uncertainty.');await expect(page.locator('#mapping-edge-tooltip')).toBeVisible()
  await hit.focus();await expect(page.locator('#mapping-edge-tooltip')).toBeVisible();await expect(hit).toHaveAttribute('aria-describedby','mapping-edge-tooltip')
  await page.locator('[data-response-view="toggle"]').click()
  await expect(page.locator('#response-preview .rebuttal-span[data-mapping-id="m1"]')).toContainText('clarify the comparison')
  await expect(page.locator('#response-preview .rebuttal-span[data-mapping-id="m2"]')).toContainText('report confidence intervals')
  await expect(page.locator('#mapping-edges g[data-mapping-id="m2"]')).toBeAttached()
  await page.locator('[data-response-view="toggle"]').click()
  await page.locator('#response-editor .cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.type('Unrelated opening. ')
  await expect(page.locator('#response-editor .rebuttal-span[data-mapping-id="m1"]')).toContainText('clarify the comparison')
  await expect(page.locator('#response-editor .rebuttal-span[data-mapping-id="m2"]')).toContainText('report confidence intervals')
  await page.locator('[data-review-language="ko"]').click()
  const koreanMark=page.locator('.review-text mark[data-id="c1"]')
  await expect(koreanMark).toHaveText('기준선 비교')
  await expect(page.locator('.review-text mark[data-id="c2"]')).toHaveCount(0)
  await expect(page.locator('#response-editor .rebuttal-span[data-mapping-id="m1"]')).toBeVisible()
  await expect(page.locator('#mapping-edges g[data-mapping-id="m1"]')).toBeAttached()
  await koreanMark.click();await expect(page.locator('.selected-concern-result .concern-translation')).toContainText('기준선 비교')
})

test('connection lines follow review section collapse and expansion',async({page,context})=>{
  const state=seeded(),round=state.rounds[0],review=round.reviews[0],answer=round.documents[0].seed_text
  const strength='A helpful observation. '.repeat(8),summary='Please clarify the baseline comparison.'
  review.fields={strengths:strength,summary};review.translations={}
  const response={document_id:'doc1',quote:'We clarify',start:0,end:10}
  round.concerns=[{id:'strength',title:'Strength',reviewer_id:'reviewer1',source_spans:[{review_id:'review1',field:'strengths',quote:'A helpful observation.',start:0,end:22}]},{id:'summary',title:'Summary',reviewer_id:'reviewer1',source_spans:[{review_id:'review1',field:'summary',quote:'baseline comparison',start:19,end:38}]}]
  round.mappings=[{id:'strength-map',concern_id:'strength',response_spans:[response],coverage:'related',reason:'Strength reason',decision:'proposed'},{id:'summary-map',concern_id:'summary',response_spans:[response],coverage:'related',reason:'Summary reason',decision:'proposed'}]
  await api(context,state);await page.setViewportSize({width:1600,height:1000});await open(page,`rebuttal-moving-lines-${Date.now()}`,'reviews')
  await expect(page.locator('#mapping-edges g[data-mapping-id="summary-map"]')).toBeAttached()
  const sample=await page.evaluate(async()=>{
    const read=()=>{const moving=document.querySelector('#mapping-edges g[data-mapping-id="summary-map"] .mapping-edge-line'),fading=document.querySelector('#mapping-edges g[data-mapping-id="strength-map"]');return {y:moving?Number(moving.getAttribute('d').match(/^M[^,]+,([^ ]+)/)[1]):null,opacity:fading?Number(fading.style.opacity):0}}
    const before=read(),frames=[];document.querySelector('.review-field[data-review-field="strengths"] .review-field-toggle').click()
    await new Promise(resolve=>{const start=performance.now();function frame(){frames.push(read());if(performance.now()-start<400)requestAnimationFrame(frame);else resolve()}requestAnimationFrame(frame)})
    return {before,frames}
  })
  const ys=sample.frames.map(frame=>frame.y).filter(Number.isFinite)
  expect(new Set(ys.map(value=>Math.round(value))).size).toBeGreaterThan(4)
  expect(sample.before.y-ys.at(-1)).toBeGreaterThan(30)
  expect(sample.frames.some(frame=>frame.opacity>0.05&&frame.opacity<0.95)).toBe(true)
  await expect(page.locator('#mapping-edges g[data-mapping-id="strength-map"]')).toHaveCount(0)
  await expect(page.locator('.rebuttal-span[data-mapping-id="strength-map"]')).toHaveCount(0)
  await expect(page.locator('.rebuttal-span[data-mapping-id="summary-map"]')).toBeVisible()
  const end=await page.evaluate(()=>{const mark=document.querySelector('.review-text mark[data-id="summary"]').getBoundingClientRect(),host=document.querySelector('#mapping-workspace').getBoundingClientRect(),path=document.querySelector('#mapping-edges g[data-mapping-id="summary-map"] .mapping-edge-line');return {expected:mark.top-host.top+mark.height/2,actual:Number(path.getAttribute('d').match(/^M[^,]+,([^ ]+)/)[1])}})
  expect(Math.abs(end.expected-end.actual)).toBeLessThan(2)
  await page.locator('.review-field[data-review-field="strengths"] .review-field-toggle').click()
  await expect(page.locator('#mapping-edges g[data-mapping-id="strength-map"]')).toBeAttached()
  await expect(page.locator('.rebuttal-span[data-mapping-id="strength-map"]')).toBeVisible()
})

test('start a reviewer response, surface check failures and cancel explicitly',async({page,context})=>{
  const state=seeded();state.rounds[0].documents=[];state.rounds[0].concerns=[]
  const mock=await api(context,state)
  await page.goto(`/p/rebuttal-start-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en`)
  await expect(page.locator('[data-action="start-response"]')).toBeEnabled()
  await page.locator('[data-action="start-response"]').click()
  await expect(page.locator('#response-editor .cm-content')).toBeVisible()
  expect(state.rounds[0].documents[0].reviewer_id).toBe('reviewer1')
  await edit(page,'We added the requested comparison.')
  await page.locator('[data-action="check-response"]').click()
  await expect.poll(()=>state.jobs.length).toBe(1)
  expect(mock.calls.find(call=>call.path.endsWith('/analyses')).body.task).toBe('connect')
  expect(mock.calls.find(call=>call.path.endsWith('/analyses')).body.scope).toEqual({review_ids:['review1'],document_ids:['doc1']})
  Object.assign(state.jobs[0],{status:'failed',error:'Model temporarily unavailable'});state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh())
  await expect(page.locator('#response-check-progress')).toBeHidden()
  await expect(page.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','true')
  await expect(page.locator('#response-check-status')).toContainText('Model temporarily unavailable')
  await expect(page.locator('[data-action="check-response"]')).toBeEnabled()
  await page.locator('[data-action="check-response"]').click()
  await expect.poll(()=>state.jobs.length).toBe(2)
  await page.locator('#response-check-progress [data-action="cancel-job"]').click()
  await expect(page.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','true')
  expect(state.jobs[1].status).toBe('cancelled')
  await expect(page.locator('#response-check-status')).toBeEmpty()
  expect(await page.evaluate(()=>window.PaperRebuttal.getTexts().doc1)).toBe('We added the requested comparison.')
})

test('another collaborator sees check locking and retains shared updates',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`rebuttal-check-sync-${Date.now()}`
  try {
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage()
    await open(a,slug,'reviews');await open(b,slug,'reviews')
    await b.locator('#response-editor .cm-content').click()
    await a.locator('[data-action="check-response"]').click()
    await expect.poll(()=>state.jobs.length).toBe(1)
    await b.evaluate(()=>window.PaperRebuttal.refresh(false))
    await expect(b.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','false')
    await expect(b.locator('#response-check-progress')).toBeVisible()
    state.jobs[0].status='completed';state.revision++
    await b.evaluate(()=>window.PaperRebuttal.refresh(false))
    await expect(b.locator('#response-editor .cm-content')).toHaveAttribute('contenteditable','true')
    await edit(b,'Shared response after the check.')
    await expect(a.locator('#response-editor .cm-content')).toContainText('Shared response after the check.')
  } finally {await first.close();await second.close()}
})

test('background refresh failures stay quiet and retry',async({page,context})=>{
  const state=seeded(),mock=await api(context,state);await open(page,`rebuttal-quiet-refresh-${Date.now()}`,'reviews')
  let attempts=0,fail=true
  await page.route('**/api/rebuttal/projects/**/state',route=>{
    attempts++
    return fail ? route.fulfill({status:502,contentType:'text/html',body:'temporary error'}) : route.fulfill({json:state})
  })
  await expect.poll(()=>attempts,{timeout:8000}).toBeGreaterThan(0)
  await expect(page.locator('#notice')).toBeHidden()
  fail=false;state.revision++
  await expect.poll(()=>page.evaluate(()=>window.PaperRebuttal.getState().revision),{timeout:8000}).toBe(state.revision)
  await expect(page.locator('#notice')).toBeHidden()
  const versions=mock.calls.filter(call=>call.method==='POST' && call.path.endsWith('/versions'))
  expect(versions.length).toBeGreaterThan(0)
  for(const call of versions)expect(Object.keys(call.body).sort()).toEqual(['content','reason'])
  expect(state.revision).toBe(1)
})

test('review sections collapse independently and keep their state on language changes',async({page,context})=>{
  const state=seeded(),review=state.rounds[0].reviews[0]
  review.fields.strengths='A clear contribution.';review.translations.strengths='명확한 기여입니다.'
  await api(context,state);await open(page,`rebuttal-collapse-${Date.now()}`,'reviews')
  const summary=page.locator('.review-field').filter({has:page.getByRole('button',{name:'summary',exact:true})})
  const strengths=page.locator('.review-field').filter({has:page.getByRole('button',{name:'strengths',exact:true})})
  const layout=await summary.locator('.review-field-toggle').evaluate(button=>{const title=button.querySelector('span:not(.review-field-chevron)').getBoundingClientRect(),arrow=button.querySelector('.review-field-chevron'),icon=arrow.getBoundingClientRect(),bounds=button.getBoundingClientRect();return {left:title.left-bounds.left,gap:icon.left-title.right,size:parseFloat(getComputedStyle(arrow).fontSize)}})
  expect(layout.left).toBeLessThan(2);expect(layout.gap).toBeGreaterThanOrEqual(0);expect(layout.gap).toBeLessThanOrEqual(10);expect(layout.size).toBeGreaterThanOrEqual(18)
  await page.emulateMedia({reducedMotion:'reduce'})
  await summary.getByRole('button',{name:'summary'}).click()
  await expect(summary.getByRole('button',{name:'summary'})).toHaveAttribute('aria-expanded','false')
  await expect(summary.locator('.review-field-chevron')).toHaveCSS('transform','matrix(0, 1, -1, 0, 0, 0)')
  await expect(summary.locator('.review-field-body')).toHaveAttribute('inert','')
  await expect(strengths.getByRole('button',{name:'strengths'})).toHaveAttribute('aria-expanded','true')
  await page.locator('[data-review-language="ko"]').click()
  await expect(summary.getByRole('button',{name:'summary'})).toHaveAttribute('aria-expanded','false')
  await expect(strengths.locator('.review-text')).toContainText('명확한 기여입니다.')
  await page.reload();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await expect(summary.getByRole('button',{name:'summary'})).toHaveAttribute('aria-expanded','false')
  await expect(strengths.getByRole('button',{name:'strengths'})).toHaveAttribute('aria-expanded','true')
  await summary.getByRole('button',{name:'summary'}).press('Enter')
  await expect(summary.getByRole('button',{name:'summary'})).toHaveAttribute('aria-expanded','true')
  await expect(summary.locator('.review-field-chevron')).toHaveCSS('transform','none')
  await expect(summary.locator('.review-field-body')).not.toHaveAttribute('inert','')
  await page.reload();await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await expect(summary.getByRole('button',{name:'summary'})).toHaveAttribute('aria-expanded','true')
  await page.emulateMedia({reducedMotion:'reduce'})
  await expect(summary.locator('.review-field-body')).toHaveCSS('transition-duration','0s')
})

test('review sidebar shares compact account controls without overlap',async({page,context})=>{
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarWidth:244})))
  await api(context,seeded());await page.setViewportSize({width:1440,height:900});await open(page,`rebuttal-sidebar-settings-${Date.now()}`,'reviews','ko')
  const controls=['.language-control','#status-center-toggle','.theme-trigger','#collab-name']
  const boxes=await Promise.all(controls.map(selector=>page.locator('.sidebar-account').locator(selector).boundingBox()))
  for(let i=0;i<boxes.length;i++){
    expect(boxes[i].width).toBeGreaterThan(0)
    if(i)expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i-1].x+boxes[i-1].width-1)
  }
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390)
})

test('collapsed sidebar centers the workspace logo and reviewer characters',async({page,context})=>{
  const state=seeded();state.rounds[0].reviewers.push({id:'reviewer2',name:'Reviewer B'},{id:'reviewer3',name:'Reviewer C'})
  await api(context,state);await page.setViewportSize({width:1440,height:900});await open(page,`rebuttal-centered-rail-${Date.now()}`,'reviews')
  await page.locator('#toggle-review-sidebar').click()
  await expect(page.locator('body')).toHaveClass(/is-sidebar-collapsed/)
  await expect.poll(()=>page.evaluate(()=>{const sidebar=document.querySelector('.project-frame-sidebar').getBoundingClientRect(),center=sidebar.left+sidebar.width/2;const items=[document.querySelector('.project-frame-brand img.brand-mark-light'),...document.querySelectorAll('.reviewer-mate')];return Math.max(...items.map(item=>{const rect=item.getBoundingClientRect();return Math.abs(rect.left+rect.width/2-center)}))})).toBeLessThanOrEqual(1)
})

test('review sidebar animates geometry and respects reduced motion',async({page,context})=>{
  await api(context,seeded());await page.setViewportSize({width:1440,height:900});await open(page,`rebuttal-animated-rail-${Date.now()}`,'reviews')
  const sidebar=page.locator('.project-frame-sidebar'),main=page.locator('.project-frame-main')
  await expect(sidebar).toHaveCSS('transition-duration','0.26s, 0.26s')
  const before=(await sidebar.boundingBox()).width
  await page.locator('#toggle-review-sidebar').click()
  await expect.poll(async()=>(await sidebar.boundingBox()).width).toBeLessThan(before)
  await expect.poll(async()=>(await sidebar.boundingBox()).width).toBeCloseTo(44,0)
  expect((await main.boundingBox()).x).toBeCloseTo(44,0)
  await page.emulateMedia({reducedMotion:'reduce'})
  await expect(sidebar).toHaveCSS('transition-duration','0s')
  await page.locator('#toggle-review-sidebar').click()
  await expect.poll(async()=>(await sidebar.boundingBox()).width).toBeCloseTo(before,0)
})

test('review language switches every section together and pending imports stay in advanced tools',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  r.reviews[0].fields.weaknesses='Please explain the control experiment.'
  r.reviews[0].translations.weaknesses='대조 실험을 설명해 주세요.'
  r.imports=[{id:'pending1',kind:'pdf',status:'staged',raw:{filename:'Pending review.pdf'},reviews:[],pages:[]}]
  const mock=await api(context,state)
  await page.goto(`/p/rebuttal-language-${Date.now()}/rebuttal?standalone=1&round=r1&lang=ko`)
  await expect(page.locator('.source-panel>.panel-header #review-language [data-review-language="original"]')).toHaveAttribute('aria-pressed','true')
  await expect(page.locator('.pending-imports')).toHaveCount(0)
  await expect(page.locator('.pending-import-tools')).toBeHidden()
  await expect(page.locator('[data-action="edit-translation"]')).toHaveCount(0)
  await expect(page.locator('#review-content')).toContainText('baseline comparison')
  await expect(page.locator('#review-content')).toContainText('control experiment')
  await page.locator('#review-language [data-review-language="ko"]').click()
  await expect(page.locator('#review-content')).toContainText('기준선 비교')
  await expect(page.locator('#review-content')).toContainText('대조 실험')
  await expect(page.locator('#review-content')).not.toContainText('control experiment')
  expect(mock.calls.filter(call=>call.path.endsWith('/analyses'))).toHaveLength(0)
  await page.locator('#review-language [data-review-language="original"]').click()
  await expect(page.locator('#review-content')).toContainText('control experiment')
  await page.locator('#review-advanced>summary').click()
  await expect(page.locator('.pending-import-tools')).toContainText('Pending review.pdf')
  await page.locator('[data-action="edit-review-translations"]').click()
  await expect(page.locator('#dialog-body textarea')).toHaveCount(2)
  await page.locator('[name="translation:1"]').fill('대조 실험을 자세히 설명하세요.')
  await save(page)
  await page.locator('#review-language [data-review-language="ko"]').click()
  await expect(page.locator('#review-content')).toContainText('대조 실험을 자세히 설명하세요.')
  delete state.rounds[0].reviews[0].translations.weaknesses;state.revision++
  await page.evaluate(()=>window.PaperRebuttal.refresh())
  await expect(page.locator('#review-translation-status')).toContainText('원어로 표시')
  await page.locator('[data-action="translate-reviews"]').click()
  const request=mock.calls.find(call=>call.path.endsWith('/analyses'))
  expect(request.body.task).toBe('translate')
  expect(request.body.scope).toEqual({review_ids:['review1'],document_ids:[]})
})

for (const theme of ['light', 'dark']) for (const width of [320, 1600]) test(`boolean switches preserve native values and explicit apply ${theme} ${width}`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 1000 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(theme => localStorage.setItem('paper-workspace-theme', theme), theme)
  const state = seeded(), mock = await api(context, state)
  await open(page, `switch-${theme}-${width}-${Date.now()}`)
  await page.locator('[data-action=rules]').click()
  const common = page.getByRole('switch', { name: 'Allow a common response', exact: true })
  await expect(common).toBeChecked()
  await expect(common).toHaveCSS('background-color', 'rgb(94, 106, 211)')
  expect(await common.evaluate(e => e.getBoundingClientRect().width)).toBe(26)
  expect(await common.evaluate(e => e.getBoundingClientRect().height)).toBe(16)
  const thumb = await common.evaluate(e => {
    const s = getComputedStyle(e, '::before')
    return { color: s.backgroundColor, width: s.width, height: s.height, transform: s.transform }
  })
  expect(thumb).toEqual({ color: 'rgb(255, 254, 255)', width: '12px', height: '12px', transform: 'matrix(1, 0, 0, 1, 10, 0)' })
  await common.focus()
  await page.keyboard.press('Space')
  await expect(common).not.toBeChecked()
  await expect(common).toHaveCSS('background-color', 'rgb(113, 113, 116)')
  await save(page)
  expect(state.rounds[0].rules.at(-1).allow_common).toBe(false)
  expect(state.rounds[0].active_rules_id).toBeNull()
  await navigateScreen(page, 'reviews')
  const connections = page.getByRole('switch', { name: 'Show all connections', exact: true })
  await connections.check()
  await expect(connections).toBeChecked()
  await connections.uncheck()
  await expect(connections).not.toBeChecked()
  expect(mock.calls.filter(call => call.path.endsWith('/analyses'))).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
})

test('review controls retain keyboard focus after rendering their updated state',async({page,context})=>{
  await api(context,seeded());await open(page,`review-keyboard-${Date.now()}`,'reviews')
  const toggle=page.locator('#show-all-connections')
  await toggle.evaluate(node=>{window.testConnectionToggle=node})
  await expect(toggle).toHaveCSS('transition-duration','0.18s')
  const thumbTransform=()=>toggle.evaluate(node=>getComputedStyle(node,'::before').transform)
  expect(await thumbTransform()).toBe('matrix(1, 0, 0, 1, 0, -6)')
  await toggle.focus();await page.keyboard.press('Space')
  await expect(toggle).toBeFocused();await expect(toggle).toBeChecked()
  await expect.poll(thumbTransform).toBe('matrix(1, 0, 0, 1, 10, -6)')
  expect(await toggle.evaluate(node=>window.testConnectionToggle===node)).toBe(true)
  await page.emulateMedia({reducedMotion:'reduce'});await expect(toggle).toHaveCSS('transition-duration','0s')
  await page.emulateMedia({reducedMotion:'no-preference'})
  const concern=page.locator('.review-text mark[data-action="select-concern"]').first()
  await concern.focus();await page.keyboard.press('Enter')
  await expect(concern).toBeFocused()
  const submission=page.locator('#screen-nav [data-screen="submission"]')
  await page.locator('#screen-nav .sidebar-advanced > summary').click()
  await submission.focus();await page.keyboard.press('Enter')
  await expect(submission).toBeFocused()
})

test('pending imports are available only inside advanced tools',async({page,context})=>{
  const state=seeded();state.rounds[0].imports.push({id:'pending-discovery',kind:'text',status:'staged',raw:{filename:'review.txt'},reviews:[{reviewer_id:'Reviewer B',fields:{review:'A pending review.'}}]})
  const mock=await api(context,state)
  await page.goto(`/p/pending-discovery-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await expect(page.locator('#response-editor .cm-content')).toBeVisible()
  await expect(page.locator('#review-advanced')).not.toHaveAttribute('open','')
  await expect(page.locator('.pending-imports')).toHaveCount(0)
  await expect(page.locator('.pending-import-tools [data-action="resume-import"]')).toBeHidden()
  await page.locator('#review-advanced>summary').click()
  await expect(page.locator('.pending-import-tools [data-action="resume-import"]')).toBeVisible()
  expect(mock.calls.filter(call=>call.method!=='GET')).toHaveLength(0)
})

test('shared sidebar profile updates collaborator presence and survives reload',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`rebuttal-profile-${Date.now()}`
  try {
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage()
    await open(a,slug);await open(b,slug)
    await a.locator('#collab-name').click()
    await expect(a.locator('#name-dialog')).toBeVisible()
    await a.locator('#name-input').fill('Research Mate')
    await a.locator('input[name="profile-color"][value="#dc2626"]').check({force:true})
    await a.locator('#save-name').click()
    await expect(a.locator('#collab-name')).toHaveText('RM')
    await expect.poll(()=>b.evaluate(()=>Array.from(window.PaperRebuttalSession.provider.awareness.getStates().values()).some(s=>s.user?.name==='Research Mate'&&s.user?.color==='#dc2626'))).toBe(true)
    await a.reload();await expect(a.locator('#collab-name')).toHaveText('RM')
    await a.locator('#review-appearance-trigger').click();await expect(a.locator('.theme-dialog')).toBeVisible()
  } finally {await first.close();await second.close()}
})

test('Paper profile settings persist when opening Rebuttal',async({page,context})=>{
  const state=seeded(),slug=`shared-profile-${Date.now()}`
  await api(context,state)
  await page.goto(`/p/${slug}`)
  await page.locator('#collab-name').click()
  await page.locator('#name-input').fill('Paper Researcher')
  await page.locator('input[name="profile-color"][value="#059669"]').check({force:true})
  await page.locator('#save-name').click()
  await expect(page.locator('#collab-name')).toHaveText('PR')
  await open(page,slug)
  await expect(page.locator('#collab-name')).toHaveText('PR')
  await expect(page.locator('#collab-name')).toHaveCSS('background-color','rgb(5, 150, 105)')
})

test('reviewer avatar smoothly returns to the top when sidebar collapses',async({page,context})=>{
  await api(context,seeded());await open(page,`reviewer-sidebar-motion-${Date.now()}`,'reviews')
  const sidebar=page.locator('#reviewer-nav'),avatar=sidebar.locator('.reviewer-mate-button').first(),toggle=page.locator('#toggle-review-sidebar')
  const original=(await avatar.boundingBox()).y
  const samples=await page.evaluate(async()=>{const avatar=document.querySelector('.reviewer-mate-button');document.querySelector('#toggle-review-sidebar').click();const y=[];for(let i=0;i<25;i++){await new Promise(requestAnimationFrame);y.push(avatar.getBoundingClientRect().y)}return y})
  expect(original-samples.at(-1)).toBeGreaterThan(20)
  expect(samples.slice(1).every((value,index)=>value<=samples[index]+1)).toBe(true)
  await toggle.click()
  await expect.poll(async()=>Math.abs((await avatar.boundingBox()).y-original)).toBeLessThan(1)
})

test('collapsed reviewer avatars align with the sidebar center',async({page,context})=>{
  await api(context,seeded());await open(page,`reviewer-centered-${Date.now()}`,'reviews')
  await page.locator('#toggle-review-sidebar').click()
  await expect(page.locator('body')).toHaveClass(/is-sidebar-collapsed/)
  await expect.poll(async()=>{
    const sidebar=await page.locator('.project-frame-sidebar').boundingBox(),avatar=await page.locator('.reviewer-mate-button').first().boundingBox()
    return Math.abs((sidebar.x+sidebar.width/2)-(avatar.x+avatar.width/2))
  }).toBeLessThan(0.6)
})

test('preloaded Paper and Rebuttal immediately synchronize sidebar and appearance in both directions',async({page,context})=>{
  const state=seeded(),slug=`shared-preferences-${Date.now()}`
  await api(context,state)
  await page.addInitScript(()=>{localStorage.setItem('paper-workspace-theme','light');localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarWidth:260,sidebarCollapsed:false,editorZoom:1.2}))})
  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(()=>workspaceReadyForCompile)
  const frame=page.frameLocator('.paper-review-frame')
  await expect(frame.locator('#toggle-review-sidebar')).toBeAttached()
  await page.locator('#toggle-sidebar').click()
  await expect(frame.locator('#toggle-review-sidebar')).toHaveAttribute('aria-expanded','false')
  await page.locator('#toggle-sidebar').click()
  await expect(frame.locator('#toggle-review-sidebar')).toHaveAttribute('aria-expanded','true')
  await page.locator('.theme-trigger').click()
  await selectProperty(page,'workspace-theme','dark')
  await expect(frame.locator('html')).toHaveAttribute('data-color-scheme','dark')
  await page.locator('.theme-dialog button[value="close"]').click()
  await page.locator('#open-rebuttal').click()
  await frame.locator('#toggle-review-sidebar').click()
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded','false')
  await frame.locator('#toggle-review-sidebar').click()
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded','true')
  await frame.locator('#review-appearance-trigger').click()
  const select=frame.locator('#workspace-theme')
  await select.evaluate(el=>{el.value='light';el.dispatchEvent(new Event('change',{bubbles:true}))})
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme','light')
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('paper-workspace-layout')).editorZoom)).toBe(1.2)
})

for(const {theme,collapsed} of [{theme:'dark',collapsed:true},{theme:'light',collapsed:false}]) test(`direct review load shows a themed workspace shell: ${theme}, collapsed ${collapsed}`,async({page,context})=>{
  await api(context,seeded())
  await page.addInitScript(({theme,collapsed})=>{localStorage.setItem('paper-workspace-theme',theme);localStorage.setItem('paper-workspace-layout',JSON.stringify({sidebarCollapsed:collapsed,sidebarWidth:260}))},{theme,collapsed})
  await context.route('**/p/**/rebuttal?*',async route=>{
    if(new URL(route.request().url()).searchParams.has('embedded'))await new Promise(resolve=>setTimeout(resolve,1200))
    await route.continue()
  })
  await page.goto(`/p/review-startup-${Date.now()}/rebuttal?lang=ko`,{waitUntil:'domcontentloaded'})
  const startup=page.locator('#review-startup-shell')
  await expect(startup).toBeVisible()
  await expect(startup).toContainText('작업공간을 불러오는 중')
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme',theme)
  expect(await startup.locator('.startup-main').evaluate(el=>Math.round(el.getBoundingClientRect().left))).toBe(collapsed?44:260)
  await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
  await expect(startup).toBeHidden()
  await expect(page.frameLocator('.paper-review-frame').locator('#screen-nav')).toBeVisible()
})

test('early Rebuttal view receives the confirmed manuscript title without switching back',async({page,context})=>{
  await api(context,seeded())
  let release;const gate=new Promise(resolve=>{release=resolve})
  await context.route('**/project/project.json',async route=>{await gate;await route.continue()})
  try{
    await page.goto(`/p/early-review-title-${Date.now()}?lang=en`)
    await page.waitForFunction(()=>document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
    const frame=page.frameLocator('.paper-review-frame')
    await page.locator('#open-rebuttal').click()
    await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
    await expect(frame.locator('#workspace-project-title')).toHaveText(/early-review-title-/)
    release()
    await page.waitForFunction(()=>workspaceReadyForCompile)
    await expect(frame.locator('#workspace-project-title')).toHaveText('A Reusable Paper Workspace')
    await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
    await frame.locator('#manuscript-link').click()
    await expect(page.locator('#project-title')).toHaveValue('A Reusable Paper Workspace')
    await page.locator('#project-title').fill('Updated title')
    await page.locator('#project-title').press('Tab')
    await expect(frame.locator('#workspace-project-title')).toHaveText('Updated title')
  }finally{release()}
})

test('watchdog manuscript recovery synchronizes the visible Rebuttal title',async({page,context})=>{
  await api(context,seeded())
  let release,requests=0;const gate=new Promise(resolve=>{release=resolve})
  await context.route('**/project/project.json',async route=>{if(++requests===1)await gate;await route.continue()})
  try{
    await page.goto(`/p/recovery-review-title-${Date.now()}?lang=ko`)
    await page.waitForFunction(()=>document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
    const frame=page.frameLocator('.paper-review-frame')
    await page.locator('#open-rebuttal').click()
    await expect(page.locator('.paper-review-frame')).toHaveClass(/is-active/)
    await expect(frame.locator('#workspace-project-title')).toHaveText(/recovery-review-title-/)
    await expect(page.locator('#save-state')).toHaveText('서버 원고 복구됨 · 로컬 편집 모드',{timeout:12000})
    const recovered=await page.locator('#project-title').inputValue()
    expect(recovered).toBe('A Reusable Paper Workspace')
    await expect(frame.locator('#workspace-project-title')).toHaveText(recovered)
    await frame.locator('#manuscript-link').click()
    await expect(page.locator('#project-title')).toHaveValue(recovered)
  }finally{release()}
})

test('connection details distinguish a partial response from related context',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],coverage:'related',relationship:'partial',reason:'일부 요청에만 답변합니다.',decision:'proposed'}]
  await api(context,state);await open(page,`relation-label-${Date.now()}`,'reviews','ko')
  await page.locator('.review-text mark[data-id="concern1"]').first().click()
  await expect(page.locator('.selected-concern-result .mapping')).toContainText('부분 답변')
  await expect(page.locator('.selected-concern-result .mapping')).toContainText('일부 요청에만 답변합니다.')
})

test('outdated answer passages explain why they cannot be highlighted and offer a recheck',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],mock=await api(context,state)
  r.documents[0].seed_text='Q1. We use pole moments as the prediction interface.'
  r.mappings=[{id:'old-map',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:12,quote:'Old response'}],coverage:'related',reason:'이전 답변과 연결됩니다.',origin:'ai',decision:'proposed',stale:true}]
  await open(page,`stale-response-${Date.now()}`,'reviews','ko')
  await page.locator('.review-text mark[data-id="concern1"]').first().click()
  const details=page.locator('.selected-concern-result')
  await expect(details.locator('[data-connection-stale-notice]')).toBeVisible()
  await expect(details.locator('[data-stale-note]')).toContainText('현재 답변에는 없습니다')
  await expect(details.locator('[data-action="focus-span"]')).toBeDisabled()
  await expect(page.locator('.rebuttal-span')).toHaveCount(0)
  await details.getByRole('button',{name:'연결 다시 분석'}).click()
  const call=mock.calls.find(c=>c.path.endsWith('/analyses'))
  expect(call.body.task).toBe('connect')
  expect(call.body.scope).toEqual({review_ids:['review1'],document_ids:['doc1']})
  expect(call.body.texts.doc1).toBe('Q1. We use pole moments as the prediction interface.')
})

test('editing a selected linked answer marks a missing passage immediately',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],coverage:'related',reason:'관련 답변입니다.',origin:'ai',decision:'proposed'}]
  await api(context,state);await open(page,`edit-selected-link-${Date.now()}`,'reviews','ko')
  await page.locator('.review-text mark[data-id="concern1"]').first().click()
  await expect(page.locator('[data-connection-stale-notice]')).toBeHidden()
  await edit(page,'A completely revised answer.')
  await expect(page.locator('[data-connection-stale-notice]')).toBeVisible()
  await expect(page.locator('[data-action="focus-span"]')).toBeDisabled()
})

test('dark connection highlights stay visible and readable on both sides',async({page,context})=>{
  const state=seeded(),r=state.rounds[0],value=r.documents[0].seed_text
  r.mappings=[{id:'map1',concern_id:'concern1',response_spans:[{document_id:'doc1',start:0,end:10,quote:value.slice(0,10)}],coverage:'related',reason:'관련 답변입니다.',origin:'ai',decision:'proposed'}]
  await page.addInitScript(()=>localStorage.setItem('paper-workspace-theme','dark'))
  await api(context,state);await open(page,`dark-connection-${Date.now()}`,'reviews','ko')
  await page.locator('#show-all-connections').check()
  const source=page.locator('.review-text mark.is-active').first(),response=page.locator('#response-editor .rebuttal-span').first()
  await expect(source).toBeVisible();await expect(response).toBeVisible()
  const backgrounds=await Promise.all([source,response].map(x=>x.evaluate(el=>getComputedStyle(el).backgroundColor)))
  expect(backgrounds.every(x=>x.includes('0.38'))).toBe(true)
  await page.getByRole('button',{name:'OpenReview 미리보기'}).click()
  const preview=page.locator('#response-preview .rebuttal-span').first();await expect(preview).toBeVisible()
  expect(await preview.evaluate(el=>getComputedStyle(el).backgroundColor)).toContain('0.38')
})

test('response version history compares and restores only the selected answer', async ({page, context}) => {
  if(process.env.PAPER_REBUTTAL_JS)await context.route('**/rebuttal.js*', route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
  const state=seeded();await api(context,state)
  const history=[]
  await context.route('**/api/rebuttal/projects/**/versions', async route=>{
    if(route.request().method()==='POST'){
      const {content,reason}=route.request().postDataJSON();history.push({content,reason,created_at:new Date().toISOString(),source:'response'})
      await route.fulfill({json:{saved:true}})
    } else await route.fulfill({json:{versions:[...history,{content:'Earlier answer',created_at:'2026-01-01T00:00:00Z',source:'paper'}, {content:null,created_at:'2025-01-01T00:00:00Z',source:'paper'}]}})
  })
  await context.route('**/collab-runtime/**?response-restore=1', async route=>{
    const body=route.request().postDataJSON()
    await page.evaluate(({key,replacement})=>{
      const shared=window.PaperRebuttalSession.namespacedTextFor('rebuttalResponses',key,'')
      window.PaperRebuttalSession.document.transact(()=>{if(shared.length)shared.delete(0,shared.length);shared.insert(0,replacement)})
    },body)
    await route.fulfill({json:{restored:true}})
  })
  await open(page,`response-history-${Date.now()}`,'reviews')
  await page.locator('[data-action="response-history"]').click()
  await expect(page.locator('#dialog-title')).toHaveText('Response version history')
  await expect(page.locator('#dialog-body')).toContainText('Some older Paper backups do not contain this response.')
  await page.locator('#response-version-select').selectOption('1')
  await expect(page.locator('#response-version-old')).toHaveText('Earlier answer')
  await expect(page.locator('.response-version-compare')).toContainText('We clarify the comparison')
  await save(page)
  await expect(page.locator('#response-editor .cm-content')).toContainText('Earlier answer')
  expect(history.some(item=>item.reason==='pre-restore' && item.content.includes('We clarify'))).toBeTruthy()
  expect(await page.evaluate(()=>window.PaperRebuttal.getTexts().doc2)).toBe('Thank you for the thoughtful reviews.')
})

test('partial connection results show a scoped warning', async ({page,context}) => {
  if(process.env.PAPER_REBUTTAL_JS)await context.route('**/rebuttal.js*', route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
  const state=seeded()
  state.jobs=[{id:'partial1',round_id:'r1',task:'connect',status:'completed',created_at:'2026-10-27T12:00:00Z',scope:{document_ids:['doc1']},connection_warnings:[{omitted_links:1}]},{id:'old',round_id:'r1',task:'connect',status:'failed',created_at:'2026-10-27T11:00:00Z',scope:{document_ids:['doc1']},error:'old failure'}]
  await api(context,state);await open(page,`partial-warning-${Date.now()}`,'reviews')
  await expect(page.locator('#response-check-status')).toContainText('Some proposed links did not pass verification')
})


test('shared reviewer memos show author and time and follow selected passages', async ({browser}) => {
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`memos-${Date.now()}`
  try {
    if(process.env.PAPER_REBUTTAL_JS)for(const context of [first,second])await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage();await open(a,slug,'reviews');await open(b,slug,'reviews')
    await a.locator('#response-memos-toggle').click();await b.locator('#response-memos-toggle').click()
    await a.locator('#rebuttal-memo-input').fill('Check Figure 3');await a.locator('[data-memo-action="save"]').click()
    await expect(b.locator('.response-memo')).toContainText('Check Figure 3');await expect(b.locator('.response-memo-meta strong')).toHaveText('Test Author');await expect(b.locator('.response-memo-meta time')).toHaveAttribute('datetime',/\d{4}-\d{2}-\d{2}/)
    const editor=a.locator('#response-editor .cm-content');await editor.click();await a.keyboard.press('Control+Home');await a.keyboard.press('Shift+End')
    await a.locator('#response-memo-add').click();await a.locator('#rebuttal-memo-input').fill('Please confirm this answer.');await a.locator('[data-memo-action="save"]').click()
    await expect(b.locator('.response-memo')).toHaveCount(2);await expect(b.locator('.response-memo')).toContainText(['Please confirm this answer.','Check Figure 3'])
    if(process.env.PAPER_MEMO_LIST_SCREENSHOT)await b.screenshot({path:process.env.PAPER_MEMO_LIST_SCREENSHOT})
    await b.locator('#response-editor .cm-content').click();await b.keyboard.press('Control+Home');await b.keyboard.insertText('Prefix ');await expect(a.locator('.response-memo-quote')).toBeEnabled()
    await edit(b,'Completely replaced response.');await expect(a.locator('.response-memo-changed')).toHaveText('Original passage changed')
    await selectProperty(a,'document-select','doc2');await expect(a.locator('.response-memo')).toHaveCount(0)
    await selectProperty(a,'document-select','doc1');await expect(a.locator('.response-memo')).toHaveCount(2)
    await a.reload();await a.locator('#response-memos-toggle').click();await expect(a.locator('.response-memo')).toHaveCount(2)
  } finally {await first.close();await second.close()}
})

test('reviewer memo works before response and stays outside exported text', async ({page,context}) => {
  const state=seeded();state.rounds[0].documents=[];const mock=await api(context,state)
  await open(page,`memo-before-response-${Date.now()}`,'reviews');await page.locator('#response-memos-toggle').click()
  await page.locator('#rebuttal-memo-input').fill('Internal working memo');await page.locator('[data-memo-action="save"]').click()
  await page.locator('[data-action="start-response"]').click();await expect(page.locator('.response-memo')).toContainText('Internal working memo')
  await edit(page,'Response text only.');await navigateScreen(page,'submission');const download=page.waitForEvent('download');await page.locator('[data-action="export"]').click();await download
  expect(JSON.stringify(mock.calls.findLast(call=>call.path.endsWith('/exports')).body)).not.toContain('Internal working memo')
})

test('memo panel stays usable in narrow and dark layouts', async ({browser})=>{
  const context=await namedContext(browser,{viewport:{width:390,height:844}}),state=seeded()
  try {await api(context,state);const page=await context.newPage();await open(page,`memos-mobile-${Date.now()}`,'reviews');await page.evaluate(()=>{document.documentElement.dataset.colorScheme='dark'})
    await page.locator('#response-memos-toggle').click();await expect(page.locator('#rebuttal-memo-input')).toBeVisible()
    const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width+1)
    await page.locator('#rebuttal-memo-input').fill('모바일 메모');await page.locator('[data-memo-action="save"]').click();await expect(page.locator('.response-memo')).toContainText('모바일 메모')
  } finally {await context.close()}
})

test('concurrent memos retain both authors', async ({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`memo-concurrent-${Date.now()}`
  try {
    await second.addInitScript(()=>localStorage.setItem('collab-name','Second Author'))
    await api(first,state);await api(second,state)
    const a=await first.newPage(),b=await second.newPage();await open(a,slug,'reviews');await open(b,slug,'reviews')
    await a.locator('#response-memos-toggle').click();await b.locator('#response-memos-toggle').click()
    await a.locator('#rebuttal-memo-input').fill('First memo');await b.locator('#rebuttal-memo-input').fill('Second memo')
    await Promise.all([a.locator('[data-memo-action="save"]').click(),b.locator('[data-memo-action="save"]').click()])
    await expect(a.locator('.response-memo')).toHaveCount(2);await expect(b.locator('.response-memo')).toHaveCount(2)
    await expect(a.locator('.response-memo-list')).toContainText('Test Author');await expect(a.locator('.response-memo-list')).toContainText('Second Author')
  } finally {await first.close();await second.close()}
})

test('notes open to the right of the response and passage markers reopen the drawer',async({page,context})=>{
  if(process.env.PAPER_REBUTTAL_JS)await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
  await page.setViewportSize({width:1600,height:900});const state=seeded();await api(context,state);await open(page,`memo-drawer-${Date.now()}`,'reviews')
  await page.locator('#response-memos-toggle').click();const response=await page.locator('.response-panel').boundingBox(),panel=await page.locator('#response-memos-panel').boundingBox()
  expect(panel.x).toBeGreaterThanOrEqual(response.x+response.width-1);expect(panel.height).toBeGreaterThan(400)
  await page.locator('#response-editor .cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('Shift+End');await page.locator('#response-memo-add').click();await page.locator('#rebuttal-memo-input').fill('Check this claim');await page.locator('[data-memo-action="save"]').click()
  await expect(page.locator('.response-memo-marker')).toBeVisible();if(process.env.PAPER_MEMO_SCREENSHOT)await page.screenshot({path:process.env.PAPER_MEMO_SCREENSHOT})
  await page.locator('[data-memo-action="close"]').click();await expect(page.locator('#response-memos-panel')).toBeHidden()
  await page.locator('.response-memo-marker').click();await expect(page.locator('#response-memos-panel')).toBeVisible();await expect(page.locator('.response-memo')).toContainText('Check this claim')
  await page.locator('.response-memo-quote').click();await expect.poll(async()=>page.evaluate(()=>window.PaperRebuttal.getSelection()?.end-window.PaperRebuttal.getSelection()?.start)).toBeGreaterThan(0)
})

test('memo save works in the preloaded review iframe for selection and general notes',async({page,context})=>{
  const errors=[];page.on('pageerror', error=>errors.push(error.message))
  if(process.env.PAPER_REBUTTAL_JS)await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
  if(process.env.PAPER_MEMO_JS)await context.route('**/rebuttal-comments.js*',route=>route.fulfill({path:process.env.PAPER_MEMO_JS,contentType:'application/javascript'}))
  const slug=`embedded-memo-${Date.now()}`,state=seeded();await api(context,state)
  await page.goto(`/p/${slug}/rebuttal?round=r1&lang=en#reviews`)
  const frame=page.frameLocator('.paper-review-frame');await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
  await frame.locator('#response-memos-toggle').click()
  await frame.locator('#rebuttal-memo-input').fill('General memo');await frame.locator('[data-memo-action="save"]').click();await expect(frame.locator('.response-memo')).toContainText('General memo')
  await frame.locator('#response-editor .cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('Shift+End')
  await frame.locator('#response-memo-add').click();await frame.locator('#rebuttal-memo-input').fill('Selected memo');await frame.locator('[data-memo-action="save"]').click();await expect(frame.locator('.response-memo')).toHaveCount(2)
  await page.reload();await expect(frame.locator('#response-editor .cm-content')).toBeVisible();await frame.locator('#response-memos-toggle').click();await expect(frame.locator('.response-memo')).toHaveCount(2);expect(errors).toEqual([])
})

test('memo width can be resized and survives reload without changing the content',async({page,context})=>{
  if(process.env.PAPER_REBUTTAL_JS)await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
  if(process.env.PAPER_MEMO_JS)await context.route('**/rebuttal-comments.js*',route=>route.fulfill({path:process.env.PAPER_MEMO_JS,contentType:'application/javascript'}))
  if(process.env.PAPER_MEMO_CSS)await context.route('**/rebuttal.css*',route=>route.fulfill({path:process.env.PAPER_MEMO_CSS,contentType:'text/css'}))
  await page.setViewportSize({width:1600,height:900});await api(context,seeded());await open(page,`memo-resize-${Date.now()}`,'reviews')
  await page.locator('#response-memos-toggle').click();await expect(page.locator('#response-memos-resizer')).toBeVisible()
  await page.locator('#rebuttal-memo-input').fill('Keep this draft while resizing')
  await expect.poll(async()=>Math.round((await page.locator('#response-memos-panel').boundingBox()).width)).toBeGreaterThan(300)
  await expect(page.locator('#mapping-workspace')).not.toHaveClass(/memo-panel-animating/)
  const before=await page.locator('#response-memos-panel').boundingBox(),bar=await page.locator('#response-memos-resizer').boundingBox()
  await page.mouse.move(bar.x+bar.width/2,bar.y+100);await page.mouse.down();await page.mouse.move(bar.x-90,bar.y+100,{steps:8});await page.mouse.up()
  await expect.poll(async()=>Math.round((await page.locator('#response-memos-panel').boundingBox()).width)).toBeGreaterThan(before.width+60)
  await expect(page.locator('#rebuttal-memo-input')).toHaveValue('Keep this draft while resizing')
  const width=Math.round((await page.locator('#response-memos-panel').boundingBox()).width)
  expect(await page.locator('.response-memo-avatar').count()).toBe(0);await expect(page.locator('.response-memos-heading')).not.toContainText('Shared with collaborators')
  if(process.env.PAPER_MEMO_SCREENSHOT)await page.screenshot({path:process.env.PAPER_MEMO_SCREENSHOT})
  await page.reload();await expect(page.locator('#response-memos-toggle')).toBeEnabled();await page.locator('#response-memos-toggle').click();await expect(page.locator('#response-memos-panel')).toBeVisible();await expect.poll(async()=>Math.round((await page.locator('#response-memos-panel').boundingBox()).width)).toBe(width)
})

test('paper to rebuttal shares memos immediately between two collaborators',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`paper-memo-sync-${Date.now()}`
  try{
    if(process.env.PAPER_REBUTTAL_JS)for(const context of [first,second])await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
    if(process.env.PAPER_MEMO_JS)for(const context of [first,second])await context.route('**/rebuttal-comments.js*',route=>route.fulfill({path:process.env.PAPER_MEMO_JS,contentType:'application/javascript'}))
    if(process.env.PAPER_MEMO_CSS)for(const context of [first,second])await context.route('**/rebuttal.css*',route=>route.fulfill({path:process.env.PAPER_MEMO_CSS,contentType:'text/css'}))
    await second.addInitScript(()=>localStorage.setItem('collab-name','Second Author'))
    await api(first,state);await api(second,state);const a=await first.newPage(),b=await second.newPage()
    await Promise.all([a.goto(`/p/${slug}?lang=en`),b.goto(`/p/${slug}?lang=en`)])
    await Promise.all([a.waitForFunction(()=>workspaceReadyForCompile),b.waitForFunction(()=>workspaceReadyForCompile)])
    await Promise.all([a.locator('#open-rebuttal').click(),b.locator('#open-rebuttal').click()])
    const ar=a.frameLocator('.paper-review-frame'),br=b.frameLocator('.paper-review-frame')
    await expect(ar.locator('#response-editor .cm-content')).toBeVisible();await expect(br.locator('#response-editor .cm-content')).toBeVisible()
    await ar.locator('#response-memos-toggle').click();await br.locator('#response-memos-toggle').click()
    await ar.locator('#rebuttal-memo-input').fill('Shared from Paper');await ar.locator('[data-memo-action="save"]').click()
    await expect(br.locator('.response-memo')).toContainText('Shared from Paper');await expect(br.locator('.response-memo-meta strong')).toHaveText('Test Author')
    await br.locator('#rebuttal-memo-input').fill('Seen by collaborator');await br.locator('[data-memo-action="save"]').click()
    await expect(ar.locator('.response-memo-list')).toContainText('Seen by collaborator');await expect(ar.locator('.response-memo-list')).toContainText('Second Author')
  }finally{await first.close();await second.close()}
})

test('memo drawer respects reduced motion',async({page,context})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await api(context,seeded());await open(page,`memo-reduced-${Date.now()}`,'reviews')
  await page.locator('#response-memos-toggle').click();await expect(page.locator('#response-memos-panel')).toBeVisible()
  expect(await page.locator('#response-memos-panel').evaluate(e=>getComputedStyle(e).transitionDuration)).toBe('0s')
  await page.locator('[data-memo-action="close"]').click();await expect(page.locator('#response-memos-panel')).toBeHidden()
})

test('memo drawer animates opening and closing without losing its draft',async({page,context})=>{
  await page.setViewportSize({width:1600,height:900});await page.emulateMedia({reducedMotion:'no-preference'});await api(context,seeded());await open(page,`memo-motion-${Date.now()}`,'reviews')
  const panel=page.locator('#response-memos-panel'),workspace=page.locator('#mapping-workspace')
  await page.locator('#response-memos-toggle').click();await expect(workspace).toHaveClass(/memo-panel-animating/)
  await expect(panel).toBeVisible();await panel.locator('#rebuttal-memo-input').fill('keep while closed')
  await panel.locator('[data-memo-action="close"]').click();await expect(panel).toHaveAttribute('aria-hidden','true');await expect(panel).toBeHidden()
  await page.locator('#response-memos-toggle').click();await expect(panel.locator('#rebuttal-memo-input')).toHaveValue('keep while closed');await expect(panel).toBeVisible()
})

test('mobile memo drawer can be resized',async({browser})=>{
  const context=await namedContext(browser,{viewport:{width:390,height:844}}),state=seeded()
  try{await api(context,state);const page=await context.newPage();await open(page,`memo-mobile-resize-${Date.now()}`,'reviews')
    await page.locator('#response-memos-toggle').click();await expect(page.locator('#mapping-workspace')).not.toHaveClass(/memo-panel-animating/)
    const panel=page.locator('#response-memos-panel'),before=await panel.boundingBox(),bar=await page.locator('#response-memos-resizer').boundingBox()
    await page.mouse.move(bar.x+3,bar.y+80);await page.mouse.down();await page.mouse.move(bar.x+45,bar.y+80,{steps:5});await page.mouse.up()
    await expect.poll(async()=>Math.round((await panel.boundingBox()).width)).toBeLessThan(before.width-25)
  }finally{await context.close()}
})

test('memo panel keeps long context compact and the note readable',async({page,context})=>{
  if(process.env.PAPER_REBUTTAL_JS)await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
  if(process.env.PAPER_MEMO_JS)await context.route('**/rebuttal-comments.js*',route=>route.fulfill({path:process.env.PAPER_MEMO_JS,contentType:'application/javascript'}))
  if(process.env.PAPER_MEMO_CSS)await context.route('**/rebuttal.css*',route=>route.fulfill({path:process.env.PAPER_MEMO_CSS,contentType:'text/css'}))
  await page.setViewportSize({width:1600,height:900});const state=seeded();state.rounds[0].documents[0].seed_text='Finite model. '+('Long scientific context with several carefully qualified words. '.repeat(5));await api(context,state)
  await open(page,`memo-compact-${Date.now()}`,'reviews','ko');await page.locator('#response-memos-toggle').click()
  await page.locator('#response-editor .cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('Control+Shift+End');await page.locator('#response-memo-add').click()
  const body='비정상 데이터에서 실제 분류 성능이 유지되는지 확인해 주세요. 수치와 비교 기준도 함께 검토해야 합니다.'
  await page.locator('#rebuttal-memo-input').fill(body);await page.locator('[data-memo-action="save"]').click();await expect(page.locator('.response-memo-body')).toHaveText(body)
  const heights=await page.locator('.response-memo-quote').evaluate(e=>({visible:e.clientHeight,full:e.scrollHeight}));expect(heights.full).toBeGreaterThan(heights.visible)
  if(process.env.PAPER_MEMO_SCREENSHOT)await page.screenshot({path:process.env.PAPER_MEMO_SCREENSHOT})
  await page.locator('.response-memo-quote').click();await expect.poll(()=>page.evaluate(()=>window.PaperRebuttal.getSelection().end-window.PaperRebuttal.getSelection().start)).toBeGreaterThan(100)
})

test('editing and resolving memos synchronizes across Paper and Rebuttal',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`memo-edit-${Date.now()}`
  try{
    if(process.env.PAPER_REBUTTAL_JS)for(const context of [first,second])await context.route('**/rebuttal.js*',route=>route.fulfill({path:process.env.PAPER_REBUTTAL_JS,contentType:'application/javascript'}))
    if(process.env.PAPER_MEMO_JS)for(const context of [first,second])await context.route('**/rebuttal-comments.js*',route=>route.fulfill({path:process.env.PAPER_MEMO_JS,contentType:'application/javascript'}))
    if(process.env.PAPER_MEMO_CSS)for(const context of [first,second])await context.route('**/rebuttal.css*',route=>route.fulfill({path:process.env.PAPER_MEMO_CSS,contentType:'text/css'}))
    await api(first,state);await api(second,state);const a=await first.newPage(),b=await second.newPage()
    await Promise.all([a.goto(`/p/${slug}?lang=en`),b.goto(`/p/${slug}?lang=en`)]);await Promise.all([a.waitForFunction(()=>workspaceReadyForCompile),b.waitForFunction(()=>workspaceReadyForCompile)])
    await Promise.all([a.locator('#open-rebuttal').click(),b.locator('#open-rebuttal').click()]);const ar=a.frameLocator('.paper-review-frame'),br=b.frameLocator('.paper-review-frame')
    await expect(ar.locator('#response-memos-toggle')).toBeEnabled();await expect(br.locator('#response-memos-toggle')).toBeEnabled()
    await expect(ar.locator('#review-collaborators')).toBeVisible();const presence=await ar.locator('#review-collaborators').boundingBox(),memoButton=await ar.locator('#response-memos-toggle').boundingBox();expect(presence.x+presence.width).toBeLessThanOrEqual(memoButton.x)
    await ar.locator('#response-memos-toggle').click();await br.locator('#response-memos-toggle').click()
    await ar.locator('#rebuttal-memo-input').fill('Original note');await ar.locator('[data-memo-action="save"]').click();await expect(br.locator('.response-memo')).toContainText('Original note')
    await br.locator('[data-memo-action="edit"]').click();await br.locator('.response-memo-edit-input').fill('Edited by colleague');if(process.env.PAPER_EDIT_SCREENSHOT)await b.screenshot({path:process.env.PAPER_EDIT_SCREENSHOT});await br.locator('[data-memo-action="edit-save"]').click();await expect(ar.locator('.response-memo')).toContainText('Edited by colleague')
    await ar.locator('[data-memo-action="resolve"]').click();await expect(ar.locator('.response-memo')).toHaveCount(0);await expect(br.locator('.response-memo')).toHaveCount(0)
    await a.reload();await expect(ar.locator('#response-memos-toggle')).toBeEnabled();await ar.locator('#response-memos-toggle').click();await expect(ar.locator('.response-memo')).toHaveCount(0)
  }finally{await first.close();await second.close()}
})

test('concurrent offline memo edits remain visible as alternatives',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`memo-forks-${Date.now()}`
  try{
    await api(first,state);await api(second,state);const a=await first.newPage(),b=await second.newPage();await open(a,slug,'reviews');await open(b,slug,'reviews');await a.locator('#response-memos-toggle').click();await b.locator('#response-memos-toggle').click()
    await a.locator('#rebuttal-memo-input').fill('Original note');await a.locator('[data-memo-action="save"]').click();await expect(b.locator('.response-memo')).toContainText('Original note')
    await first.setOffline(true);await second.setOffline(true)
    await a.locator('[data-memo-action="edit"]').click();await b.locator('[data-memo-action="edit"]').click()
    await a.locator('.response-memo-edit-input').fill('First edit');await b.locator('.response-memo-edit-input').fill('Second edit')
    await Promise.all([a.locator('[data-memo-action="edit-save"]').click(),b.locator('[data-memo-action="edit-save"]').click()])
    await first.setOffline(false);await second.setOffline(false)
    await expect(a.locator('.response-memo-conflict')).toContainText('First edit');await expect(a.locator('.response-memo-conflict')).toContainText('Second edit')
    await expect(b.locator('.response-memo-conflict')).toContainText('First edit');await expect(b.locator('.response-memo-conflict')).toContainText('Second edit')
  }finally{await first.close();await second.close()}
})

test('collaborator presence appears before the notes button',async({page,context})=>{
  await api(context,seeded());await open(page,`memo-presence-order-${Date.now()}`,'reviews')
  expect(await page.locator('.response-header-right').evaluate(e=>[...e.children].map(x=>x.id))).toEqual(expect.arrayContaining(['review-collaborators','response-memos-toggle']))
  expect(await page.locator('.response-header-right').evaluate(e=>[...e.children].findIndex(x=>x.id==='review-collaborators') < [...e.children].findIndex(x=>x.id==='response-memos-toggle'))).toBe(true)
})

test('a newer memo edit does not overwrite another collaborator draft',async({browser})=>{
  const first=await namedContext(browser),second=await namedContext(browser),state=seeded(),slug=`memo-draft-conflict-${Date.now()}`
  try{await api(first,state);await api(second,state);const a=await first.newPage(),b=await second.newPage();await open(a,slug,'reviews');await open(b,slug,'reviews')
    await a.locator('#response-memos-toggle').click();await b.locator('#response-memos-toggle').click()
    await a.locator('#rebuttal-memo-input').fill('Original');await a.locator('[data-memo-action="save"]').click();await expect(b.locator('.response-memo')).toContainText('Original')
    await a.locator('[data-memo-action="edit"]').click();await a.locator('.response-memo-edit-input').fill('My unsaved draft')
    await b.locator('[data-memo-action="edit"]').click();await b.locator('.response-memo-edit-input').fill('Remote edit');await b.locator('[data-memo-action="edit-save"]').click()
    await expect(a.locator('.response-memo-edit-input')).toHaveValue('My unsaved draft');await a.locator('[data-memo-action="edit-save"]').click()
    await expect(a.locator('#notice')).toContainText('Your draft is preserved');await expect(a.locator('.response-memo-edit-input')).toHaveValue('My unsaved draft');await expect(b.locator('.response-memo-body')).toHaveText('Remote edit')
  }finally{await first.close();await second.close()}
})


test('OpenReview preview renders inline and displayed formulas at finite readable sizes',async({page,context})=>{
  if(process.env.PAPER_EDITOR_JS)await context.route('**/vendor/paper-editor.js*',route=>route.fulfill({path:process.env.PAPER_EDITOR_JS,contentType:'application/javascript'}))
  const state=seeded();await api(context,state);await open(page,`math-metrics-${Date.now()}`,'reviews')
  const source='Inline $|H(\\omega)|^2$ and text.\n\n$$\\frac{a}{1-be^{-i\\omega}}=H(\\omega)$$\n\nEnd.'
  await edit(page,source);await page.locator('[data-response-view="toggle"]').click()
  const svg=page.locator('#response-preview mjx-container > svg');await expect(svg).toHaveCount(2)
  const metrics=await svg.evaluateAll(nodes=>nodes.map(node=>({width:node.getAttribute('width'),height:node.getAttribute('height'),viewBox:node.getAttribute('viewBox'),rect:node.getBoundingClientRect().toJSON()})))
  for(const item of metrics){expect(item.width).not.toContain('NaN');expect(item.height).not.toContain('NaN');expect(item.viewBox).not.toContain('NaN');expect(item.rect.width).toBeGreaterThan(5);expect(item.rect.width).toBeLessThan(600);expect(item.rect.height).toBeGreaterThan(5);expect(item.rect.height).toBeLessThan(100)}
  await page.locator('[data-response-view="toggle"]').click();await expect(page.locator('#response-editor .cm-content')).toContainText('Inline')
})


test('Korean response connections include stable table rows in source and preview',async({page,context})=>{
  const state=seeded(),r=state.rounds[0]
  const row='| Phase-free scan (P) | [P] | [P-M] |'
  const english=`| Variant | Score | Params |\n| :--- | ---: | ---: |\n${row}`
  const korean='| 변형 | 점수 | 매개변수 |\n| :--- | ---: | ---: |\n| 위상 제거 (P) | [P] | [P-M] |'
  r.documents[0].seed_text=english
  r.mappings=[{id:'table-map',concern_id:'concern1',response_spans:[{document_id:'doc1',start:english.indexOf(row),end:english.indexOf(row)+row.length,quote:row}],coverage:'related',reason:'표의 결과',origin:'ai',decision:'proposed'}]
  await api(context,state);await open(page,`ko-table-links-${Date.now()}`,'reviews')
  await page.evaluate(async({english,korean})=>{const session=window.PaperRebuttalSession;await session.ensureNamespacedTexts('rebuttalResponses',[{key:'ko:doc1',initial:korean}]);session.mapFor('rebuttalKoreanMeta').set('doc1',{source:english,translation:korean,segments:[]})},{english,korean})
  await page.locator('[data-answer-language="ko"]').click()
  await expect(page.locator('#response-korean .rebuttal-span[data-mapping-id="table-map"]')).toContainText('위상 제거')
  await page.locator('[data-response-view="toggle"]').click()
  await expect(page.locator('#response-preview .rebuttal-span[data-mapping-id="table-map"]').first()).toBeVisible()
  await expect(page.locator('#response-preview tr').last()).toContainText('위상 제거')
  await page.evaluate(()=>{const text=window.PaperRebuttalSession.mapFor('rebuttalResponses').get('ko:doc1');text.insert(text.length,' 변경')})
  await expect(page.locator('#response-preview .rebuttal-span[data-mapping-id="table-map"]')).toHaveCount(0)
  await expect(page.locator('[data-ko-alignment-status]')).toContainText('could not be aligned')
  await expect(page.locator('[data-ko-alignment-status]')).toBeHidden()
  await expect(page.locator('#response-preview')).toContainText('위상 제거')
  await page.locator('[data-response-view="toggle"]').click()
  await expect(page.locator('[data-ko-alignment-status]')).toBeVisible()
  await expect(page.locator('[data-ko-text]')).toContainText('변경')
})
