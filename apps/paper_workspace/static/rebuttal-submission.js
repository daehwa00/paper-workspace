import { countText, checkLimits, isBlockingLimit } from './rebuttal-model.js'

export function download(result) {
  const content=result.data_base64?Uint8Array.from(atob(result.data_base64),c=>c.charCodeAt(0)):result.content ?? result.text
  if(content===undefined)throw new Error(t('The server did not return an export file.','서버에서 내보낼 파일을 받지 못했습니다.'))
  const blob=new Blob([typeof content==='object' && !(content instanceof Uint8Array)?JSON.stringify(content,null,2):content],{type:result.mime || 'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=result.filename || 'rebuttal.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000)
}

export function createSubmission({
  $, t, esc, clone, round, documentFor, texts, sharedTexts, readOnly, badge, action, field,
  selectField, guard, showDialog, mutate, notice, koreanText, koreanMeta, koreanGlossary,
  koreanGlossaryMatches, flushResponseRevisions, getSession, isSessionReady, getLanguage,
  getTargetIds, getCommonMode, setCommonMode
}) {
  let lastExport = null
  function target() { return { document_ids: getTargetIds() || round()?.documents.map(doc=>doc.id) || [], common_mode:getCommonMode() } }
  function resolvedTarget(r=round(), selection=target()) {
    let ids=[...selection.document_ids]
    const common=r.documents.filter(doc=>doc.kind==='common').map(doc=>doc.id)
    if(['append','prepend','exclude'].includes(selection.common_mode))ids=ids.filter(id=>!common.includes(id))
    if(selection.common_mode==='append')ids.push(...common)
    if(selection.common_mode==='prepend')ids.unshift(...common)
    if(!ids.length)throw new Error(t('Select at least one document.','문서를 하나 이상 선택하세요.'))
    return {document_ids:ids,common_mode:'include'}
  }
  function liveTextsFor(r=round(), ids=r?.documents.map(doc=>doc.id) || []) {
    const values={}, session=getSession(), sessionReady=isSessionReady()
    for(const id of ids){
      const doc=r?.documents.find(doc=>doc.id===id),key=doc?.text_key || id,shared=sharedTexts.get(key)
      if(!sessionReady || !doc || !shared || shared!==session?.mapFor('rebuttalResponses').get(key) || shared.doc!==session.document || typeof shared.toDelta!=='function')throw new Error(t('Response text is still loading. Wait for collaboration to finish before exporting or freezing.','답변 본문을 불러오는 중입니다. 공동 편집 준비가 끝난 뒤 내보내거나 고정해 주세요.'))
      values[id]=shared.toString()
    }
    if(!sessionReady)throw new Error(t('Wait for collaboration to finish loading response texts.','공동 편집에서 답변 본문을 불러올 때까지 기다려 주세요.'))
    return values
  }
  function validationDocumentIds(r, resolved) {
    const rules=r.rules.find(rule=>rule.id===r.active_rules_id)
    return rules?.limits?.some(limit=>limit.scope==='total')?r.documents.map(doc=>doc.id):resolved.document_ids
  }
  function submissionSnapshot() {
    const r=round(),selection=clone(target()),resolved=resolvedTarget(r,selection)
    return {roundId:r.id,documents:r.documents.map(doc=>[doc.id,doc.text_key,doc.kind,doc.title]),selection,target:resolved,texts:liveTextsFor(r,validationDocumentIds(r,resolved)),activeRulesId:r.active_rules_id,rules:clone(r.rules.find(rule=>rule.id===r.active_rules_id) || null)}
  }
  function assertSubmissionUnchanged(snapshot) {
    let unchanged=false
    try{unchanged=JSON.stringify(submissionSnapshot())===JSON.stringify(snapshot)}catch{}
    if(!unchanged)throw new Error(t('The documents, response text or rules changed. Close this dialog and review the submission again.','문서 목록, 답변 본문 또는 규정이 변경되었습니다. 이 창을 닫고 제출 내용을 다시 확인해 주세요.'))
  }
  function updateMechanical() {
    if (!round()) return
    const doc = documentFor(), value = doc ? texts()[doc.id] || '' : ''
    if ($('response-count')) $('response-count').textContent = `${countText(value)}${t(' characters','자')}`
    const checks = checkLimits(round(),texts(),target()), host = $('mechanical-checks')
    if (host) host.innerHTML = checks.length?checks.map(check=>`<div class="mechanical-row ${check.passed===false?'over':''}"><span>${esc(check.document_id ? round().documents.find(doc=>doc.id===check.document_id)?.title || check.document_id : check.scope==='target'?t('Submission target','제출 대상'):t('All documents','전체 문서'))} · ${esc(check.unit==='words'?t('Words','단어'):check.unit==='pages'?t('Pages','페이지'):check.unit==='common'?t('Common response allowed','공통 답변 허용'):t('Characters','글자'))}</span><strong>${check.count===null?t('Render to check','렌더링 후 확인'):check.count.toLocaleString(getLanguage())} / ${Number(check.max).toLocaleString(getLanguage())} ${check.passed===false?'↑':''}${check.basis==='rendered' && check.count!==null?`<small>${t('Estimate · server validates','예상치 · 서버에서 검증')}</small>`:''}</strong></div>`).join(''):`<p class="small muted">${t('No active length limits. Add and apply venue rules to enable checks.','적용된 분량 제한이 없습니다. 학회 규정을 작성하고 적용하면 검사합니다.')}</p>`
    if ($('freeze-submission')) {let ready=true;try{liveTextsFor(round(),validationDocumentIds(round(),resolvedTarget()))}catch{ready=false}$('freeze-submission').disabled=readOnly || !ready || checks.some(isBlockingLimit)}
  }
  function renderSubmission() {
    const r = round(), active = r.rules.find(rule=>rule.id===r.active_rules_id), selected = new Set(target().document_ids)
    $('main').innerHTML = `<div class="grid"><section class="card"><div class="card-header"><h2>${t('Assemble submission','제출본 구성')}</h2>${active?badge(t('Rules applied','규정 적용됨'),'good'):badge(t('Rules not set','규정 미설정'),'warn')}</div><p class="muted small">${t('Select response documents and how the optional common response is included.','답변 문서와 선택적인 공통 답변의 포함 방식을 지정하세요.')}</p><div class="target-list">${r.documents.map(doc=>`<label><input type="checkbox" data-target="${esc(doc.id)}" ${selected.has(doc.id)?'checked':''}>${esc(doc.title)} ${doc.kind==='common'?badge(t('Common','공통')):''}</label>`).join('')}</div>${selectField('common-mode',t('Common response','공통 답변'),[['append',t('Append once','마지막에 한 번 포함')],['prepend',t('Prepend once','처음에 한 번 포함')],['exclude',t('Exclude','제외')]],getCommonMode(),true)}<div id="mechanical-checks"></div><div class="actions" style="margin-top:16px"><button type="button" id="freeze-submission" class="primary" ${readOnly?'disabled':''}>${t('Freeze submission snapshot','제출 스냅샷 고정')}</button>${action('rules',t('Manage rules','규정 관리'))}</div><p class="form-help">${t('A snapshot fixes the selected text and rules at this moment. It does not submit to a venue.','스냅샷은 현재 선택한 본문과 규정을 고정합니다. 학회에 제출하는 기능은 아닙니다.')}</p></section><section class="card"><div class="card-header"><h2>${t('Export response','답변 내보내기')}</h2></div>${selectField('export-language',t('Response language','답변 언어'),[['en','English'],['ko','한국어']],'en',true)}${selectField('export-format',t('Format','형식'),[['txt','Text'],['markdown','Markdown'],['pdf','PDF'],['source',t('Template source','템플릿 소스')]],'txt',true)}<details><summary>${t('Optional rendering template','선택적인 렌더링 템플릿')}</summary>${field('template-entrypoint',t('Entrypoint','시작 파일'),'response.tex')}${field('template-files',t('Template files (JSON path → source)','템플릿 파일 (JSON 경로 → 소스)'),'','textarea')}</details><div class="actions">${action('export',t('Generate & download','생성 후 다운로드'),'','primary')}</div><p class="form-help">${t('Exports contain response text only. Internal analysis, comments and credentials are excluded.','내보내기는 답변 본문만 포함합니다. 내부 분석, 댓글, 인증 정보는 제외됩니다.')}</p><pre id="export-preview" class="export-preview" ${lastExport?'':'hidden'}>${esc(lastExport?.text || lastExport?.content || '')}</pre></section><section class="card full"><div class="card-header"><h2>${t('Frozen submissions','고정된 제출본')}</h2></div>${r.submissions.length?r.submissions.slice().reverse().map(snapshot=>`<article class="submission-row"><div><strong>${esc(snapshot.title || snapshot.target?.title || t('Submission snapshot','제출 스냅샷'))}</strong><p class="small muted">${esc(snapshot.created_at || snapshot.frozen_at || '')} · ${esc(snapshot.actor || '')}</p></div>${action('view-submission',t('View snapshot','스냅샷 보기'),snapshot.id)}</article>`).join(''):`<p class="empty">${t('No submission snapshots yet.','아직 고정한 제출본이 없습니다.')}</p>`}</section></div>`
    $('main').querySelector('[name="common-mode"]').onchange=event=>{setCommonMode(event.target.value);updateMechanical()}
    $('freeze-submission').onclick=()=>guard(freezeSubmission)
    updateMechanical()
  }
  function exportTemplate() {
    const raw=$('main').querySelector('[name="template-files"]')?.value.trim();if(!raw)return undefined
    let files;try{files=JSON.parse(raw)}catch{throw new Error(t('Template files must be a JSON object of paths and source strings.','템플릿 파일을 경로와 소스 문자열의 JSON 객체로 입력하세요.'))}
    return {files,entrypoint:$('main').querySelector('[name="template-entrypoint"]').value}
  }
  async function exportResponses() {
    const snapshot=submissionSnapshot(),selectedLanguage=$('main').querySelector('[name="export-language"]').value,exportTexts={...snapshot.texts},manual=[]
    const koreanState=()=>snapshot.target.document_ids.map(id=>{const doc=round().documents.find(doc=>doc.id===id);return [id,koreanText(doc)?.toString(),koreanMeta()?.get(id),koreanGlossary(doc)]})
    if(selectedLanguage==='ko')for(const id of snapshot.target.document_ids){
      const doc=round().documents.find(doc=>doc.id===id),value=koreanText(doc)?.toString(),meta=koreanMeta()?.get(id)
      if(!value?.trim())throw new Error(t('A selected response has no Korean draft.','선택한 답변에 한국어 초안이 없습니다.'))
      if(typeof meta?.source==='string'){
        if(meta.source!==snapshot.texts[id] || !meta.glossary || !koreanGlossaryMatches(meta,doc))throw new Error(t('A Korean translation is outdated. Translate it again before exporting.','한국어 번역이 최신 영문 또는 용어집과 일치하지 않습니다. 다시 번역한 뒤 내보내세요.'))
      }else manual.push(doc.title)
      exportTexts[id]=value
    }
    const format=$('main').querySelector('[name="export-format"]').value
    if(selectedLanguage==='ko' && ['pdf','source'].includes(format))throw new Error(t('Korean export is available as text or Markdown.','한국어 내보내기는 텍스트 또는 Markdown을 선택해 주세요.'))
    const template=exportTemplate(),koreanSignature=selectedLanguage==='ko'?JSON.stringify(koreanState()):null
    const send=async()=>{
      await flushResponseRevisions()
      assertSubmissionUnchanged(snapshot)
      if(koreanSignature!==null && koreanSignature!==JSON.stringify(koreanState()))throw new Error(t('The Korean draft changed. Close this dialog and review it again.','한국어 초안이 변경되었습니다. 이 창을 닫고 다시 확인해 주세요.'))
      const result=await mutate(`/rounds/${snapshot.roundId}/exports`,{format,texts:exportTexts,target:snapshot.target,...(template?{template}:{})})
      lastExport=result.result || result;download(lastExport);renderSubmission();notice(t('Export generated and downloaded.','내보내기를 생성하고 다운로드했습니다.'))
    }
    if(manual.length)showDialog(t('Confirm manual Korean drafts','수동 한국어 초안 확인'),`<p>${t('These Korean drafts have no translation source record. Confirm that you reviewed them against the current English responses and glossary.','다음 한국어 초안에는 번역 원문 기록이 없습니다. 현재 영문 답변과 용어집을 기준으로 직접 검토했는지 확인하세요.')}</p><ul>${manual.map(title=>`<li>${esc(title)}</li>`).join('')}</ul>`,send,t('Export reviewed drafts','검토한 초안 내보내기'))
    else await send()
  }
  async function freezeSubmission() {
    const snapshot=submissionSnapshot(),checks=checkLimits(round(),snapshot.texts,snapshot.target);if(checks.some(isBlockingLimit))throw new Error(t('Fix the length limits before freezing.','분량 제한을 맞춘 뒤 고정하세요.'))
    showDialog(t('Freeze submission snapshot','제출 스냅샷 고정'),field('title',t('Snapshot title','스냅샷 이름'),`${round().title} · ${new Date().toLocaleString(getLanguage())}`)+`<p>${t('This captures the selected response documents and current rules. Editing continues in the live draft.','선택한 답변 문서와 현재 규정을 고정합니다. 초안은 계속 편집할 수 있습니다.')}</p>`,async data=>{await flushResponseRevisions();assertSubmissionUnchanged(snapshot);await mutate(`/rounds/${snapshot.roundId}/submissions`,{format:'txt',texts:snapshot.texts,target:{...snapshot.target,title:data.get('title')}});notice(t('Submission snapshot frozen.','제출 스냅샷을 고정했습니다.'))},t('Freeze snapshot','스냅샷 고정'))
  }
  function viewSubmission(id) {
    const snapshot=round().submissions.find(item=>item.id===id)
    showDialog(t('Frozen submission','고정된 제출본'),`<p class="muted small">${esc(snapshot.created_at || snapshot.frozen_at || '')}</p><pre class="export-preview">${esc(snapshot.output?.text || snapshot.text || snapshot.content || JSON.stringify(snapshot.documents || snapshot.texts || {},null,2))}</pre>`,async()=>download({content:snapshot.output?.text || snapshot.text || snapshot.content || JSON.stringify(snapshot.texts || {},null,2),filename:'rebuttal-snapshot.txt'}),t('Download','다운로드'))
  }

  return {liveTextsFor, updateMechanical, renderSubmission, exportResponses, viewSubmission}
}
