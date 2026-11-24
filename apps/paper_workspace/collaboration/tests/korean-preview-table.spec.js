import {test,expect} from './fixtures.js'

for(const alignment of ['block','row'])test(`Korean ${alignment} highlights preserve real table cells and both source texts`,async({page})=>{
  const intro='We compare the variants with matched training.'
  const english=`${intro}\n\n| Variant | Top-1 | Top-5 | Parameters |\n| --- | --- | --- | --- |\n| Baseline | 66.8 | 88.1 | 1500000 |\n| Ablation | 65.6 | 87.4 | 1300000 |\n\nThe **trained comparison** supports the result.`
  const korean='동일한 학습 조건에서 변형들을 비교했습니다.\n\n| 변형 | Top-1 | Top-5 | 파라미터 수 |\n| --- | --- | --- | --- |\n| 기준 모델 | 66.8 | 88.1 | 1500000 |\n| 제거 실험 | 65.6 | 87.4 | 1300000 |\n\n**재학습 비교**가 결과를 뒷받침합니다.'
  const quote=alignment==='block'?intro:'| Baseline | 66.8 | 88.1 | 1500000 |'
  const segments=alignment==='block'?[{source:english,text:korean}]:[{source:quote,text:'| 기준 모델 | 66.8 | 88.1 | 1500000 |'}]
  const round={id:'r1',title:'Table preview',reviewers:[{id:'a',name:'Reviewer A'}],reviews:[{id:'review',reviewer_id:'a',fields:{review:'Please compare.'},translations:{}}],documents:[{id:'answer',title:'Response',kind:'reviewer',reviewer_id:'a',text_key:'response:answer',seed_text:english,korean_seed:{text:korean,meta:{source:english,translation:korean,segments,glossary:{}}}}],imports:[],concerns:[{id:'c1',title:'Comparison',reviewer_id:'a',source_spans:[{review_id:'review',field:'review',quote:'Please compare.',start:0,end:15}],requires_response:true,strategy:'clarify',work_status:'todo',comments:[]}],mappings:[{id:'m1',concern_id:'c1',response_spans:[{document_id:'answer',quote,start:english.indexOf(quote),end:english.indexOf(quote)+quote.length}],coverage:'partial',decision:'proposed',reason:'Comparison'}],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}}
  const state={schema_version:1,revision:1,enabled:true,jobs:[],rounds:[round]}
  await page.route('**/api/rebuttal/projects/**',route=>route.fulfill({json:new URL(route.request().url()).pathname.endsWith('/versions')?{versions:[]}:state}))
  await page.setViewportSize({width:1600,height:1000})
  await page.goto(`/p/ko-table-${alignment}-${Date.now()}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await expect(page.locator('#response-editor .cm-content')).toContainText(intro)
  await page.locator('[data-response-view=toggle]').click()
  await expect(page.locator('#response-preview table')).toBeVisible()
  for(let pass=0;pass<2;pass++){
    await page.locator('[data-answer-language=ko]').click()
    const preview=page.locator('#response-preview')
    await expect(preview.locator('td .rebuttal-span')).not.toHaveCount(0)
    await expect(preview.locator('table > span, thead > span, tbody > span, tr > span')).toHaveCount(0)
    const rows=await preview.locator('tr').evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('th,td')].map(cell=>{const r=cell.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}})))
    expect(rows).toHaveLength(3)
    for(const row of rows){expect(row).toHaveLength(4);for(let i=0;i<4;i++){expect(Math.abs(row[i].x-rows[0][i].x)).toBeLessThan(1);expect(Math.abs(row[i].width-rows[0][i].width)).toBeLessThan(1);expect(Math.abs(row[i].y-row[0].y)).toBeLessThan(1)}}
    await expect(preview.locator('table')).toContainText('파라미터 수')
    await page.locator('[data-answer-language=en]').click()
    await expect(preview.locator('table')).toContainText('Parameters')
  }
  const texts=await page.evaluate(()=>{const map=PaperRebuttalSession.mapFor('rebuttalResponses');return {en:map.get('response:answer').toString(),ko:map.get('ko:answer').toString()}})
  expect(texts).toEqual({en:english,ko:korean})
})
