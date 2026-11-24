import { commitKoreanTranslation, isManualKoreanDraft } from './rebuttal-response-language.js'

export async function waitForKoreanTranslation({job, request, path, onProgress, t, closed}) {
  if (!job?.id) throw new Error(t('Could not start translation.','번역 작업을 시작하지 못했습니다.'))
  const id = job.id, deadline = Date.now() + 10 * 60 * 1000
  let failures = 0
  while (!closed()) {
    onProgress(job.translation_progress)
    if (job.status === 'completed') return job
    if (['failed', 'cancelled'].includes(job.status)) break
    if (Date.now() > deadline) throw new Error(t('Translation did not finish. Try again to resume completed paragraphs.','번역이 완료되지 않았습니다. 다시 시도하면 완료한 문단을 재사용합니다.'))
    await new Promise(resolve => setTimeout(resolve, 750))
    if (closed()) return null
    try {
      const next = await request(`${path}/${id}`, undefined, 'GET', {signal: AbortSignal.timeout(10000)})
      if (!next.job) throw new Error(t('Translation job is unavailable.','번역 작업을 확인할 수 없습니다.'))
      job = next.job
      failures = 0
    } catch (error) {
      if (error.status && error.status < 500 && error.status !== 429) throw error
      if (++failures >= 3) throw new Error(t('Could not check translation progress. Try again to resume the saved paragraphs.','번역 진행 상태를 확인하지 못했습니다. 다시 시도하면 저장된 문단을 재사용합니다.'))
    }
  }
  if (closed()) return null
  throw new Error(job.error || t('Translation did not finish.','번역이 완료되지 않았습니다.'))
}

export function publishKoreanTranslation({text, metadata, id, expected, source, result, glossary, owner, origin}) {
  const provenance = owner.JSON.parse(JSON.stringify({source, translation: result.text, segments: result.segments || [], glossary}))
  const current = metadata.get(id)
  if (text.toString() === result.text && JSON.stringify(current) === JSON.stringify(provenance)) return true
  return commitKoreanTranslation({text, metadata, id, expected, provenance, origin})
}


export function createKoreanTranslation({
  $, t, documentFor, sharedTexts, sessionBindings, readOnly, localOrigin, clone, guard, notice,
  refresh, mutate, request, liveTexts, flushResponseRevisions, getSession, isSessionReady,
  getRoundId, getRounds, getAnswerLanguage, isPreview, isReviewVisible, renderKoreanConnections,
  koreanConnectionRanges, updateResponsePreview, scheduleEdges, restoreLanguagePosition
}) {
  const observedKoreanTexts = new WeakSet(), koreanTranslating = new Set(), koreanProgress = new Map(), koreanAttempts = new Map()
  const koreanSource = doc => sharedTexts.get(doc.text_key || doc.id)?.toString() || ''
  const koreanGlossary = doc => getRounds().find(r=>r.documents.some(item=>item.id===doc?.id))?.glossary || {}
  const koreanSnapshot = doc => JSON.stringify([koreanSource(doc),koreanGlossary(doc)])
  const koreanGlossaryMatches = (meta,doc=documentFor()) => Boolean(meta?.glossary) && JSON.stringify(meta.glossary)===JSON.stringify(koreanGlossary(doc))
  function koreanDisplayValue(doc) {
    const saved=koreanText(doc)?.toString() || '',pending=koreanProgress.get(doc.id)
    if(pending?.source===koreanSource(doc) && pending.preview && saved===pending.before){
      const partial=pending.progress?.translations?.find(item=>item.review_id===doc.id && item.field==='response')
      if(partial?.text)return partial.text
    }
    return saved
  }
  const koreanKey = doc => `ko:${doc.id}`
  const koreanMap = () => getSession()?.mapFor('rebuttalResponses')
  const koreanMeta = () => getSession()?.mapFor('rebuttalKoreanMeta')
  function koreanText(doc) { const text=doc && koreanMap()?.get(koreanKey(doc)); return text?.doc===getSession()?.document && typeof text?.toDelta==='function' ? text : null }
  function koreanOwner() { return window.parent !== window && window.parent.PaperWorkspaceSharedSession === getSession() ? window.parent : window }
  function restoreKoreanMetadata(doc) {
    const seed=doc.korean_seed
    if(!readOnly && seed?.meta && !koreanMeta()?.has(doc.id) && koreanText(doc)?.toString()===seed.text)koreanMeta().set(doc.id,koreanOwner().JSON.parse(JSON.stringify(seed.meta)))
  }
  async function ensureKorean(doc) {
    if(!doc || !isSessionReady() || sessionBindings.closed)throw new Error(t('Wait for collaboration to connect.','공동 편집 연결을 기다려 주세요.'))
    if(!koreanText(doc) && !readOnly)await getSession().ensureNamespacedTexts('rebuttalResponses',[{key:koreanKey(doc),initial:doc.korean_seed?.text || ''}])
    if (sessionBindings.closed) return null
    restoreKoreanMetadata(doc)
    return koreanText(doc)
  }
  function renderKoreanStatus(doc) {
    const host=$('response-korean');if(!host || !doc)return
    const value=koreanDisplayValue(doc),meta=koreanMeta()?.get(doc.id),original=koreanSource(doc),pending=koreanProgress.get(doc.id)
    const text=host.querySelector('[data-ko-text]'),status=host.querySelector('[data-ko-status]'),alignmentStatus=host.querySelector('[data-ko-alignment-status]'),button=host.querySelector('[data-action="translate-response-ko"]')
    if(text){renderKoreanConnections(text,value);text.dataset.sourceStart='0';text.dataset.sourceEnd=String(value.length);text.hidden=isPreview()}
    host.classList.toggle('is-preview',isPreview())
    if(isPreview() && getAnswerLanguage()==='ko')updateResponsePreview()
    const progress=pending?.progress
    if(status)status.textContent=koreanTranslating.has(doc.id)?progress?.retrying?t(`Retrying delayed block… ${progress.completed}/${progress.total}`,`응답이 지연된 구간 다시 시도 중… ${progress.completed}/${progress.total}`):progress?.total?t(`Translating… ${progress.completed}/${progress.total}`,`번역 중… ${progress.completed}/${progress.total}`):t('Translating…','번역 중…'):meta?.source && meta.source!==original?t('English response changed.','영문 답변이 변경되었습니다.'):!value?t('No Korean translation yet.','아직 한국어 번역이 없습니다.'):''
    if(alignmentStatus){const missing=value && !koreanTranslating.has(doc.id) ? koreanConnectionRanges({visibleOnly:false}).filter(item=>!item.aligned).length : 0;alignmentStatus.textContent=missing?t('Some connections could not be aligned with the Korean text.','일부 연결의 한국어 위치를 확인할 수 없습니다.'):''}
    const manual=isManualKoreanDraft(koreanText(doc)?.toString() || '',meta)
    if(status && manual && !koreanTranslating.has(doc.id))status.textContent=t('Manual Korean draft preserved.','수동으로 편집한 한국어 초안을 보존했습니다.')
    if(button){button.hidden=readOnly || koreanTranslating.has(doc.id) || Boolean(!manual && value && meta?.source===original && koreanGlossaryMatches(meta));button.textContent=manual?t('Replace draft and translate','초안을 교체하고 번역'):value?t('Translate again','다시 번역'):t('Translate','번역하기')}
    scheduleEdges()
    restoreLanguagePosition()
  }
  async function mountKorean() {
    const doc=documentFor(),host=$('response-korean');if(!host)return
    const enabled=getAnswerLanguage()==='ko' && Boolean(doc);host.hidden=!enabled || isPreview()
    $('response-editor').hidden=enabled || isPreview();$('response-preview').hidden=!isPreview()
    if(!enabled || !isSessionReady())return
    let shared;try{shared=await ensureKorean(doc)}catch(error){notice(error.message,true);return}
    if(sessionBindings.closed || getAnswerLanguage()!=='ko' || documentFor()?.id!==doc.id || !$('response-korean'))return
    if(shared && !observedKoreanTexts.has(shared)){observedKoreanTexts.add(shared);sessionBindings.observe(shared,()=>{if(documentFor()?.id===doc.id)renderKoreanStatus(doc)})}
    renderKoreanStatus(doc)
    const original=koreanSource(doc), meta=koreanMeta()?.get(doc.id)
    const value=shared?.toString() || ''
    const needsTranslation=!isManualKoreanDraft(value,meta) && (!value || meta?.source!==original || !koreanGlossaryMatches(meta))
    if(isReviewVisible() && shared && needsTranslation && !readOnly && original.trim() && !$('form-dialog').open && !koreanTranslating.has(doc.id) && koreanAttempts.get(doc.id)!==koreanSnapshot(doc))guard(translateResponseKorean)
  }
  function requestKoreanTranslation() {
    const doc=documentFor(), current=koreanText(doc)?.toString() || ''
    return translateResponseKorean({confirmedDraft:current})
  }
  async function translateResponseKorean({confirmedDraft}={}) {
    const doc=documentFor();if(!doc || readOnly || koreanTranslating.has(doc.id))return
    const current=koreanText(doc)?.toString() || ''
    if(isManualKoreanDraft(current,koreanMeta()?.get(doc.id)) && current!==confirmedDraft)return
    const en=koreanSource(doc),snapshot=koreanSnapshot(doc),targetRound=getRoundId(),glossary=clone(koreanGlossary(doc))
    koreanAttempts.set(doc.id,snapshot);koreanTranslating.add(doc.id);renderKoreanStatus(doc)
    let catchUp=false
    try {
      if(!en.trim())throw new Error(t('Write an English response first.','먼저 영문 답변을 작성하세요.'))
      const ko=await ensureKorean(doc)
      if(!ko || sessionBindings.closed)return
      const before=ko.toString(),targetId=doc.id,oldMeta=koreanMeta()?.get(doc.id)
      const manual=isManualKoreanDraft(before,oldMeta)
      if(manual && before!==confirmedDraft)return
      const pending={source:en,before,preview:!manual,progress:null}
      koreanProgress.set(doc.id,pending)
      await flushResponseRevisions()
      await refresh(false)
      if(sessionBindings.closed || getRoundId()!==targetRound || documentFor()?.id!==targetId || koreanSnapshot(doc)!==snapshot)return
      const path=`/rounds/${targetRound}/analyses`
      const submitted=await mutate(path,{task:'translate_response',texts:liveTexts(),scope:{document_ids:[doc.id]}},'POST',{render:false})
      const job=await waitForKoreanTranslation({job:submitted.result?.job,path,request,t,closed:()=>sessionBindings.closed,onProgress(progress){
        pending.progress=progress
        if(documentFor()?.id===targetId)renderKoreanStatus(doc)
      }})
      if(!job)return
      const result=job.result?.translations?.find(item=>item.review_id===targetId && item.field==='response')
      if(!result?.text)throw new Error(t('Translation result was empty.','번역 결과가 비어 있습니다.'))
      if(koreanSnapshot(doc)!==snapshot){catchUp=true;return}
      if(koreanText(doc)!==ko || !publishKoreanTranslation({
        text:ko,metadata:koreanMeta(),id:targetId,expected:before,source:en,result,glossary,owner:koreanOwner(),origin:localOrigin
      }))notice(t('Korean text changed. The current text was preserved.','한국어 내용이 변경되어 현재 내용을 보존했습니다.'))
    } finally {
      koreanTranslating.delete(doc.id);koreanProgress.delete(doc.id)
      if(!sessionBindings.closed){
        if(documentFor()?.id===doc.id)renderKoreanStatus(doc)
        if(catchUp || koreanSnapshot(doc)!==snapshot)scheduleKoreanRefresh(doc,{confirmedDraft})
      }
    }
  }
  const koreanRefreshTimers=new Map()
  function scheduleKoreanRefresh(doc,{confirmedDraft}={}) {
    if(sessionBindings.closed)return
    const previous=koreanRefreshTimers.get(doc.id)
    confirmedDraft ??= previous?.confirmedDraft
    clearTimeout(previous?.timer)
    const timer=setTimeout(()=>{
      koreanRefreshTimers.delete(doc.id)
      if(!isReviewVisible() || getAnswerLanguage()!=='ko' || documentFor()?.id!==doc.id)return
      if(confirmedDraft!==undefined && koreanText(doc)?.toString()===confirmedDraft &&
          !$('form-dialog').open && koreanAttempts.get(doc.id)!==koreanSnapshot(doc)){
        guard(()=>translateResponseKorean({confirmedDraft}))
      }else void mountKorean()
    },400)
    koreanRefreshTimers.set(doc.id,{timer,confirmedDraft})
  }

  sessionBindings.add(()=>{
    for(const {timer} of koreanRefreshTimers.values())clearTimeout(timer)
  })
  return {
    koreanSource, koreanGlossary, koreanGlossaryMatches, koreanDisplayValue, koreanKey, koreanMeta,
    koreanText, restoreKoreanMetadata, koreanProgress, koreanTranslating, renderKoreanStatus,
    mountKorean, requestKoreanTranslation, scheduleKoreanRefresh
  }
}
